/**
 * 进程内 fake S3（L1 测试台）。
 *
 * 设计 §4.4 的替身纪律：fake 只替代外部世界（HTTP 状态、条件判定、分页、
 * 错误 XML），不替代被测规则（何时发 `If-Match`、失败后怎么分类与重试）。
 * 因此这里**真实判定**条件头，并且只在判定通过后提交字节：
 *
 * - `PUT`：`If-None-Match: *` 撞已有 ⇒ 412；`If-Match` 不匹配 ⇒ 412。
 *   失败时对象字节、mutation 计数都不变；
 * - `DELETE`：`If-Match` 不匹配 ⇒ 412；对不存在的 key 返回 204（与 S3 一致，
 *   所以客户端必须 HEAD 复核）；
 * - `COPY`：解析 `x-amz-copy-source`、源侧 `x-amz-copy-source-if-match`、
 *   `x-amz-metadata-directive`，目标侧 `If-None-Match: *` 真实判定；
 * - `200 + <Error>` 可注入（COPY／Complete 经典陷阱）；
 * - ListObjectsV2 分页、`encoding-type=url`、跨页／同页重复注入；
 * - multipart 会话、ListParts、`NoSuchUpload`、残留会话。
 *
 * 签名**只校验头形状，不重算签名**（重算会与实现共享同一处误读）；正确性由
 * AWS 官方向量单测和 L2 真实服务端证明。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

export type FakeS3Profile = "aws-like" | "minio-like" | "r2-like";

export interface FakeS3Options {
  readonly bucket?: string;
  readonly region?: string;
  readonly profile?: FakeS3Profile;
  /** 控制面判定：key 含 `/.easy-sync/` 或等于根标记文件。 */
  readonly controlPrefix?: string;
  readonly maxKeysCap?: number;
  /** 模拟不支持 create 碰撞的服务端：PUT 忽略 If-None-Match。 */
  readonly ignorePutIfNoneMatch?: boolean;
  /** 模拟不支持条件更新的服务端：PUT 忽略 If-Match。 */
  readonly ignorePutIfMatch?: boolean;
  /** 模拟「If-Match 判定通过、返回 200 但没落盘」的服务端：探针必须回读字节。 */
  readonly putIfMatchWithoutWrite?: boolean;
  /** 模拟「DELETE 返回 204 但对象仍在」的服务端：探针必须 HEAD 复核。 */
  readonly deleteWithoutEffect?: boolean;
  /** 模拟 HEAD／GET 不返回 ETag 的服务端：探针不得把条件删除报成支持。 */
  readonly headWithoutETag?: boolean;
  /** 模拟「COPY 目标条件返回 412，但仍覆盖目标」的服务端。 */
  readonly copyPreconditionOverwritesTarget?: boolean;
  /** 模拟对任何 COPY 都返回 412 的服务端：阳性对照必须失败。 */
  readonly copyAlwaysPreconditionFailed?: boolean;
}

export interface FakeS3ObjectSnapshot {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly eTag: string;
  readonly putCount: number;
  readonly copyCount: number;
  readonly deleteCount: number;
}

export interface FakeS3MutationStats {
  readonly put: number;
  readonly copy: number;
  readonly delete: number;
}

export interface FakeS3Request {
  readonly method: string;
  readonly key: string;
  readonly rawQuery: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly signedHeaders: readonly string[];
  readonly bodySha256: string | null;
}

export interface FakeS3Fault {
  readonly method?: string;
  readonly keyIncludes?: string;
  readonly queryIncludes?: string;
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly times?: number;
  /** Complete／COPY 专用：先提交对象，再返回故障（模拟「已成功但响应丢失」）。 */
  readonly afterCommit?: boolean;
}

interface FakeObject {
  body: Buffer;
  eTag: string;
  contentType: string;
  metadata: Record<string, string>;
  lastModified: string;
  putCount: number;
  copyCount: number;
  deleteCount: number;
}

interface FakeMultipartUpload {
  key: string;
  uploadId: string;
  contentType: string;
  metadata: Record<string, string>;
  parts: Map<number, { body: Buffer; eTag: string }>;
}

interface MutableFault extends FakeS3Fault {
  remaining: number;
}

interface FakeStats {
  userContent: { put: number; copy: number; delete: number };
  controlPlane: { put: number; copy: number; delete: number };
}

interface MutationLedgerEntry {
  putCount: number;
  copyCount: number;
  deleteCount: number;
  lastBodySha256: string | null;
}

const XML_HEADERS = { "content-type": "application/xml" } as const;
const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;

export class FakeS3Server {
  readonly bucket: string;
  readonly region: string;
  readonly profile: FakeS3Profile;
  readonly maxKeysCap: number;
  readonly violations: string[] = [];
  readonly requests: FakeS3Request[] = [];
  private readonly controlPrefix: string;
  private readonly ignorePutIfNoneMatch: boolean;
  private readonly ignorePutIfMatch: boolean;
  private readonly putIfMatchWithoutWrite: boolean;
  private readonly deleteWithoutEffect: boolean;
  private readonly headWithoutETag: boolean;
  private readonly copyPreconditionOverwritesTarget: boolean;
  private readonly copyAlwaysPreconditionFailed: boolean;
  private readonly objects = new Map<string, FakeObject>();
  private readonly uploads = new Map<string, FakeMultipartUpload>();
  private readonly tokens = new Map<string, number>();
  private readonly mutations = new Map<string, MutationLedgerEntry>();
  private readonly hiddenKeysFromList = new Set<string>();
  private readonly faults: MutableFault[] = [];
  private readonly stats: FakeStats = {
    userContent: { put: 0, copy: 0, delete: 0 },
    controlPlane: { put: 0, copy: 0, delete: 0 },
  };
  private server: Server | null = null;
  private sockets = new Set<import("node:net").Socket>();
  private port = 0;
  private crossPageDuplicate = false;
  private samePageDuplicate = false;
  private ignoreRange = false;

  constructor(options: FakeS3Options = {}) {
    this.bucket = options.bucket ?? "easysync-test";
    this.region = options.region ?? "us-east-1";
    this.profile = options.profile ?? "aws-like";
    this.controlPrefix = options.controlPrefix ?? ".easy-sync";
    this.maxKeysCap = options.maxKeysCap ?? 1000;
    this.ignorePutIfNoneMatch = options.ignorePutIfNoneMatch ?? false;
    this.ignorePutIfMatch = options.ignorePutIfMatch ?? false;
    this.putIfMatchWithoutWrite = options.putIfMatchWithoutWrite ?? false;
    this.deleteWithoutEffect = options.deleteWithoutEffect ?? false;
    this.headWithoutETag = options.headWithoutETag ?? false;
    this.copyPreconditionOverwritesTarget = options.copyPreconditionOverwritesTarget ?? false;
    this.copyAlwaysPreconditionFailed = options.copyAlwaysPreconditionFailed ?? false;
  }

  async start(): Promise<{ endpoint: string; port: number }> {
    if (this.server) throw new Error("Fake S3 server is already running");
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.port = address.port;
    return { endpoint: `http://127.0.0.1:${this.port}`, port: this.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  reset(): void {
    this.objects.clear();
    this.uploads.clear();
    this.tokens.clear();
    this.mutations.clear();
    this.hiddenKeysFromList.clear();
    this.faults.length = 0;
    this.requests.length = 0;
    this.violations.length = 0;
    this.stats.userContent = { put: 0, copy: 0, delete: 0 };
    this.stats.controlPlane = { put: 0, copy: 0, delete: 0 };
    this.crossPageDuplicate = false;
    this.samePageDuplicate = false;
    this.ignoreRange = false;
  }

  seedObject(
    key: string,
    body: string | Buffer,
    options: { contentType?: string; metadata?: Record<string, string> } = {},
  ): void {
    const buffer = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body, "utf8");
    this.objects.set(key, {
      body: buffer,
      eTag: quotedMd5(buffer),
      contentType: options.contentType ?? "application/octet-stream",
      metadata: { ...(options.metadata ?? {}) },
      lastModified: new Date().toISOString(),
      putCount: 0,
      copyCount: 0,
      deleteCount: 0,
    });
  }

  getBody(key: string): Buffer | null {
    const object = this.objects.get(key);
    return object ? Buffer.from(object.body) : null;
  }

  getObjectSnapshot(key: string): FakeS3ObjectSnapshot | null {
    const object = this.objects.get(key);
    if (!object) return null;
    const ledger = this.mutationCounts(key);
    return {
      key,
      size: object.body.byteLength,
      sha256: sha256Hex(object.body),
      eTag: object.eTag,
      putCount: ledger.put,
      copyCount: ledger.copy,
      deleteCount: ledger.delete,
    };
  }

  mutationCounts(key: string): { put: number; copy: number; delete: number } {
    const entry = this.mutations.get(key);
    if (!entry) return { put: 0, copy: 0, delete: 0 };
    return { put: entry.putCount, copy: entry.copyCount, delete: entry.deleteCount };
  }

  snapshotStats(): { userContent: FakeS3MutationStats; controlPlane: FakeS3MutationStats } {
    return {
      userContent: { ...this.stats.userContent },
      controlPlane: { ...this.stats.controlPlane },
    };
  }

  failNext(fault: FakeS3Fault): void {
    this.faults.push({ ...fault, remaining: fault.times ?? 1 });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  setCrossPageDuplicate(value: boolean): void {
    this.crossPageDuplicate = value;
  }

  setSamePageDuplicate(value: boolean): void {
    this.samePageDuplicate = value;
  }

  setIgnoreRange(value: boolean): void {
    this.ignoreRange = value;
  }

  /** 模拟最终一致的 LIST：指定 key 在列举结果里暂时不可见。 */
  hideKeyFromList(key: string): void {
    this.hiddenKeysFromList.add(key);
  }

  // -----------------------------------------------------------------------
  // HTTP handling
  // -----------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const rawUrl = request.url ?? "/";
    const question = rawUrl.indexOf("?");
    const rawPath = question < 0 ? rawUrl : rawUrl.slice(0, question);
    const rawQuery = question < 0 ? "" : rawUrl.slice(question + 1);
    const headers = normalizeRequestHeaders(request.headers);
    let key: string;
    try {
      key = this.extractKey(rawPath);
    } catch {
      this.recordViolation(`${method} ${rawPath}: invalid percent encoding`);
      this.sendError(response, 400, "InvalidURI", "Could not parse the URI");
      return;
    }
    const query = parseRawQuery(rawQuery);
    const body = await readRequestBody(request);
    const violationsBefore = this.violations.length;
    this.validateAuthorizationHeaders(method, key, headers, query);
    if (this.violations.length > violationsBefore) {
      this.finish(request, method, key, rawQuery, headers, 403, null);
      this.sendError(response, 403, "SignatureDoesNotMatch", this.violations.at(-1) ?? "bad signature headers");
      return;
    }
    const bodySha = body.byteLength > 0 ? sha256Hex(body) : null;
    const fault = this.takeFault(method, key, rawQuery, false);
    if (fault) {
      this.finish(request, method, key, rawQuery, headers, fault.status, bodySha);
      this.respondFault(response, fault);
      return;
    }

    let status = 200;
    if (method === "POST" && hasQuery(query, "uploads")) {
      status = this.createMultipartUpload(key, headers, response);
    } else if (method === "PUT" && hasQuery(query, "partNumber") && hasQuery(query, "uploadId")) {
      status = this.uploadPart(key, query, headers, body, response);
    } else if (method === "POST" && hasQuery(query, "uploadId")) {
      status = this.completeMultipartUpload(key, query, body, response, request, headers, rawQuery);
    } else if (method === "DELETE" && hasQuery(query, "uploadId")) {
      status = this.abortMultipartUpload(key, query, response);
    } else if (method === "GET" && hasQuery(query, "uploadId")) {
      status = this.listParts(key, query, response);
    } else if (method === "PUT" && headerValue(headers, "x-amz-copy-source") !== undefined) {
      status = this.copyObject(key, headers, response, rawQuery);
    } else if (method === "PUT") {
      status = this.putObject(key, headers, body, response, rawQuery);
    } else if (method === "GET" && hasQuery(query, "list-type")) {
      status = this.listObjectsV2(key, query, response);
    } else if (method === "GET") {
      status = this.getObject(key, headers, response, false);
    } else if (method === "HEAD") {
      status = this.getObject(key, headers, response, true);
    } else if (method === "DELETE") {
      status = this.deleteObject(key, headers, response);
    } else {
      status = 400;
      this.sendError(response, 400, "InvalidRequest", `Unsupported method ${method}`);
    }
    this.finish(request, method, key, rawQuery, headers, status, bodySha);
  }

  private extractKey(rawPath: string): string {
    const path = decodeURIComponent(rawPath);
    const bucketPrefix = `/${this.bucket}`;
    if (path !== bucketPrefix && !path.startsWith(`${bucketPrefix}/`)) {
      throw new Error(`Path does not start with bucket ${this.bucket}`);
    }
    const rest = path.slice(bucketPrefix.length);
    if (rest.length === 0 || rest === "/") return "";
    return rest.slice(1);
  }

  private validateAuthorizationHeaders(
    method: string,
    key: string,
    headers: Record<string, string>,
    query: Record<string, string>,
  ): void {
    const authorization = headerValue(headers, "authorization");
    const amzDate = headerValue(headers, "x-amz-date") ?? "";
    const contentSha = headerValue(headers, "x-amz-content-sha256") ?? "";
    if (!authorization) {
      this.recordViolation(`${method} ${key}: missing Authorization`);
      return;
    }
    if (!/^\d{8}T\d{6}Z$/.test(amzDate)) {
      this.recordViolation(`${method} ${key}: x-amz-date is not UTC YYYYMMDDTHHMMSSZ`);
    }
    if (!/^[0-9a-f]{64}$/.test(contentSha)) {
      this.recordViolation(`${method} ${key}: x-amz-content-sha256 is not a real SHA-256`);
    }
    const match = /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
    if (!match) {
      this.recordViolation(`${method} ${key}: malformed Authorization`);
      return;
    }
    const credential = match[1].split("/");
    if (credential.length !== 5 || credential[4] !== "aws4_request") {
      this.recordViolation(`${method} ${key}: malformed Credential scope`);
    } else {
      if (credential[2] !== this.region) {
        this.recordViolation(`${method} ${key}: Credential region ${credential[2]} != ${this.region}`);
      }
      if (credential[1] !== amzDate.slice(0, 8)) {
        this.recordViolation(`${method} ${key}: Credential date does not match x-amz-date`);
      }
    }
    const signed = new Set(match[2].split(";"));
    for (const required of ["host", "x-amz-content-sha256", "x-amz-date"]) {
      if (!signed.has(required)) {
        this.recordViolation(`${method} ${key}: SignedHeaders missing ${required}`);
      }
    }
    // 条件头与 Range／content-type 一旦发送就必须进入 SignedHeaders；否则
    // 一个「漏签 If-Match」的回归会在 fake 全绿时漏过。
    for (const conditional of [
      "if-match",
      "if-none-match",
      "x-amz-copy-source",
      "x-amz-copy-source-if-match",
      "range",
      "content-type",
    ]) {
      if (headerValue(headers, conditional) !== undefined && !signed.has(conditional)) {
        this.recordViolation(`${method} ${key}: ${conditional} sent but not in SignedHeaders`);
      }
    }
    if (this.profile === "minio-like") {
      const host = headerValue(headers, "host") ?? "";
      if (host !== `127.0.0.1:${this.port}`) {
        this.recordViolation(`${method} ${key}: expected path-style Host 127.0.0.1:${this.port}, got ${host}`);
      }
    }
    void query;
  }

  private takeFault(
    method: string,
    key: string,
    rawQuery: string,
    afterCommit: boolean,
  ): MutableFault | null {
    for (const fault of this.faults) {
      if (fault.remaining <= 0) continue;
      if ((fault.afterCommit === true) !== afterCommit) continue;
      if (fault.method !== undefined && fault.method.toUpperCase() !== method) continue;
      if (fault.keyIncludes !== undefined && !key.includes(fault.keyIncludes)) continue;
      if (fault.queryIncludes !== undefined && !rawQuery.includes(fault.queryIncludes)) continue;
      fault.remaining -= 1;
      return fault;
    }
    return null;
  }

  private respondFault(response: ServerResponse, fault: MutableFault): void {
    if (fault.status === 0) {
      response.socket?.destroy();
      return;
    }
    if (fault.body !== undefined) {
      response.writeHead(fault.status, { ...XML_HEADERS, ...(fault.headers ?? {}) });
      response.end(fault.body);
      return;
    }
    if (fault.status >= 400 || fault.code) {
      this.sendError(
        response,
        fault.status,
        fault.code ?? "InternalError",
        fault.message ?? "Injected fake S3 fault",
        fault.headers,
      );
      return;
    }
    response.writeHead(fault.status, { ...(fault.headers ?? {}) });
    response.end();
  }

  private putObject(
    key: string,
    headers: Record<string, string>,
    body: Buffer,
    response: ServerResponse,
    rawQuery: string,
  ): number {
    if (key.length === 0) {
      this.sendError(response, 400, "InvalidRequest", "PUT requires an object key");
      return 400;
    }
    const ifNoneMatch = headerValue(headers, "if-none-match");
    const ifMatch = headerValue(headers, "if-match");
    const existing = this.objects.get(key);
    if (!this.ignorePutIfNoneMatch && ifNoneMatch === "*" && existing) {
      this.sendError(response, 412, "PreconditionFailed", "At least one of the preconditions failed");
      return 412;
    }
    if (!this.ignorePutIfMatch && ifMatch !== undefined && (!existing || existing.eTag !== ifMatch.trim())) {
      this.sendError(response, 412, "PreconditionFailed", "At least one of the preconditions failed");
      return 412;
    }
    if (!this.ignorePutIfMatch && ifMatch !== undefined && this.putIfMatchWithoutWrite) {
      // 条件判定通过但字节没落盘：返回 200 也不足以证明条件更新成立。
      response.writeHead(200, { etag: existing?.eTag ?? "" });
      response.end();
      return 200;
    }
    const object: FakeObject = existing ?? {
      body: Buffer.alloc(0),
      eTag: "",
      contentType: "application/octet-stream",
      metadata: {},
      lastModified: new Date().toISOString(),
      putCount: 0,
      copyCount: 0,
      deleteCount: 0,
    };
    object.body = body;
    object.eTag = quotedMd5(body);
    object.contentType = headerValue(headers, "content-type") ?? "application/octet-stream";
    object.metadata = extractMetadata(headers);
    object.lastModified = new Date().toISOString();
    object.putCount += 1;
    this.objects.set(key, object);
    this.countMutation(key, "put", body);
    const afterCommitFault = this.takeFault("PUT", key, rawQuery, true);
    if (afterCommitFault) {
      this.respondFault(response, afterCommitFault);
      return afterCommitFault.status;
    }
    response.writeHead(200, { etag: object.eTag });
    response.end();
    return 200;
  }

  private copyObject(
    targetKey: string,
    headers: Record<string, string>,
    response: ServerResponse,
    rawQuery: string,
  ): number {
    const source = headerValue(headers, "x-amz-copy-source");
    if (!source) {
      this.sendError(response, 400, "InvalidRequest", "CopyObject requires x-amz-copy-source");
      return 400;
    }
    const sourceKey = decodeCopySource(source);
    if (sourceKey === null) {
      this.sendError(response, 400, "InvalidArgument", "Malformed x-amz-copy-source");
      return 400;
    }
    const sourceObject = this.objects.get(sourceKey);
    if (!sourceObject) {
      this.sendError(response, 404, "NoSuchKey", "The specified key does not exist.");
      return 404;
    }
    const sourceIfMatch = headerValue(headers, "x-amz-copy-source-if-match");
    if (sourceIfMatch !== undefined && sourceIfMatch.trim() !== sourceObject.eTag) {
      this.sendError(response, 412, "PreconditionFailed", "Source ETag does not match");
      return 412;
    }
    if (this.copyAlwaysPreconditionFailed) {
      // 负向用例会看到 412；阳性对照（复制到不存在目标）也必须失败，
      // 这样探针才不会把「一律 412」误判成目标条件成立。
      this.sendError(response, 412, "PreconditionFailed", "Injected: COPY is always rejected");
      return 412;
    }
    const existingTarget = this.objects.get(targetKey);
    const targetConditionIgnored = this.profile === "r2-like";
    let rejectAfterCommit = false;
    if (!targetConditionIgnored && headerValue(headers, "if-none-match") === "*" && existingTarget) {
      if (!this.copyPreconditionOverwritesTarget) {
        this.sendError(response, 412, "PreconditionFailed", "Target already exists");
        return 412;
      }
      // 模拟「先覆盖再报 412」的服务端：探针必须回读目标字节。
      rejectAfterCommit = true;
    }
    const directive = (headerValue(headers, "x-amz-metadata-directive") ?? "COPY").toUpperCase();
    const directiveCopy = directive === "COPY";
    const target: FakeObject = existingTarget ?? {
      body: Buffer.alloc(0),
      eTag: "",
      contentType: "application/octet-stream",
      metadata: {},
      lastModified: new Date().toISOString(),
      putCount: 0,
      copyCount: 0,
      deleteCount: 0,
    };
    target.body = Buffer.from(sourceObject.body);
    target.eTag = quotedMd5(target.body);
    target.contentType = directiveCopy
      ? sourceObject.contentType
      : headerValue(headers, "content-type") ?? sourceObject.contentType;
    target.metadata = directiveCopy ? { ...sourceObject.metadata } : extractMetadata(headers);
    target.lastModified = new Date().toISOString();
    target.copyCount += 1;
    this.objects.set(targetKey, target);
    this.countMutation(targetKey, "copy", target.body);
    const afterCommitFault = this.takeFault("PUT", targetKey, rawQuery, true);
    if (afterCommitFault) {
      this.respondFault(response, afterCommitFault);
      return afterCommitFault.status;
    }
    if (rejectAfterCommit) {
      this.sendError(response, 412, "PreconditionFailed", "Target already exists");
      return 412;
    }
    const xml = `<CopyObjectResult><ETag>${escapeXml(target.eTag)}</ETag><LastModified>${target.lastModified}</LastModified></CopyObjectResult>`;
    response.writeHead(200, XML_HEADERS);
    response.end(xml);
    return 200;
  }

  private getObject(
    key: string,
    headers: Record<string, string>,
    response: ServerResponse,
    headOnly: boolean,
  ): number {
    const object = this.objects.get(key);
    if (!object) {
      this.sendError(response, 404, "NoSuchKey", "The specified key does not exist.");
      return 404;
    }
    const baseHeaders: Record<string, string> = {
      ...(this.headWithoutETag ? {} : { etag: object.eTag }),
      "last-modified": object.lastModified,
      "content-type": object.contentType,
      "content-length": String(object.body.byteLength),
      ...metadataHeaders(object.metadata),
    };
    const rangeHeader = headerValue(headers, "range");
    if (!this.ignoreRange && rangeHeader !== undefined) {
      const range = parseRange(rangeHeader, object.body.byteLength);
      if (range === null) {
        this.sendError(response, 416, "InvalidRange", "The requested range is not satisfiable");
        return 416;
      }
      const body = object.body.subarray(range.start, range.end + 1);
      const status = 206;
      this.writeBody(response, status, body, {
        ...baseHeaders,
        "content-length": String(body.byteLength),
        "content-range": `bytes ${range.start}-${range.end}/${object.body.byteLength}`,
      }, headOnly);
      return status;
    }
    this.writeBody(response, 200, object.body, baseHeaders, headOnly);
    return 200;
  }

  private deleteObject(
    key: string,
    headers: Record<string, string>,
    response: ServerResponse,
  ): number {
    const object = this.objects.get(key);
    const ifMatch = headerValue(headers, "if-match");
    if (this.profile !== "r2-like" && ifMatch !== undefined && object && ifMatch.trim() !== object.eTag) {
      this.sendError(response, 412, "PreconditionFailed", "ETag does not match");
      return 412;
    }
    if (this.deleteWithoutEffect) {
      // 204 但对象仍在：探针必须 HEAD 复核，不能把 204 当删除证据。
      response.writeHead(204);
      response.end();
      return 204;
    }
    if (object) {
      object.deleteCount += 1;
      this.objects.delete(key);
      this.countMutation(key, "delete", null);
    }
    // S3 对不存在的 key 也返回 204——204 不是删除证据。
    response.writeHead(204);
    response.end();
    return 204;
  }

  private listObjectsV2(
    key: string,
    query: Record<string, string>,
    response: ServerResponse,
  ): number {
    if (key.length > 0) {
      this.sendError(response, 400, "InvalidRequest", "ListObjectsV2 must target the bucket root");
      return 400;
    }
    if (query["list-type"] !== "2") {
      this.sendError(response, 400, "InvalidArgument", "Only list-type=2 is supported");
      return 400;
    }
    const prefix = query.prefix ?? "";
    const maxKeys = Math.min(
      Math.max(1, Number.parseInt(query["max-keys"] ?? "1000", 10) || 1000),
      this.maxKeysCap,
    );
    const encoding = query["encoding-type"] === "url" ? "url" : "identity";
    const allKeys = [...this.objects.keys()]
      .filter((candidate) => candidate.startsWith(prefix))
      .filter((candidate) => !this.hiddenKeysFromList.has(candidate))
      .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    let startIndex = 0;
    const token = query["continuation-token"];
    if (token !== undefined && token.length > 0) {
      const index = this.tokens.get(token);
      if (index === undefined) {
        this.sendError(response, 400, "InvalidArgument", "The continuation token provided is incorrect");
        return 400;
      }
      startIndex = index;
    }
    const page: string[] = [];
    if (this.crossPageDuplicate && startIndex > 0) {
      page.push(allKeys[startIndex - 1]);
    }
    const slice = allKeys.slice(startIndex, startIndex + maxKeys);
    page.push(...slice);
    if (this.samePageDuplicate && page.length > 0) {
      page.push(page[0]);
    }
    const endIndex = startIndex + slice.length;
    const isTruncated = endIndex < allKeys.length;
    let nextToken: string | undefined;
    if (isTruncated) {
      nextToken = randomUUID();
      this.tokens.set(nextToken, endIndex);
    }
    const encode = (value: string): string => {
      if (encoding !== "url") return escapeXml(value);
      // MinIO 用 form-urlencoded 语义把空格写成 `+`；AWS 示例用 `%20`。
      return this.profile === "minio-like" ? formEncode(value) : percentEncode(value);
    };
    const contents = page
      .map((objectKey) => {
        const object = this.objects.get(objectKey);
        if (!object) return "";
        return [
          "<Contents>",
          `<Key>${encode(objectKey)}</Key>`,
          `<LastModified>${object.lastModified}</LastModified>`,
          `<ETag>${escapeXml(object.eTag)}</ETag>`,
          `<Size>${object.body.byteLength}</Size>`,
          "<StorageClass>STANDARD</StorageClass>",
          "</Contents>",
        ].join("");
      })
      .join("");
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<ListBucketResult>",
      `<Name>${escapeXml(this.bucket)}</Name>`,
      `<Prefix>${encode(prefix)}</Prefix>`,
      `<KeyCount>${page.length}</KeyCount>`,
      `<MaxKeys>${maxKeys}</MaxKeys>`,
      `<IsTruncated>${isTruncated ? "true" : "false"}</IsTruncated>`,
      nextToken ? `<NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>` : "",
      contents,
      "</ListBucketResult>",
    ].join("");
    response.writeHead(200, XML_HEADERS);
    response.end(xml);
    return 200;
  }

  private createMultipartUpload(
    key: string,
    headers: Record<string, string>,
    response: ServerResponse,
  ): number {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, {
      key,
      uploadId,
      contentType: headerValue(headers, "content-type") ?? "application/octet-stream",
      metadata: extractMetadata(headers),
      parts: new Map(),
    });
    const xml = `<InitiateMultipartUploadResult><Bucket>${escapeXml(this.bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`;
    response.writeHead(200, XML_HEADERS);
    response.end(xml);
    return 200;
  }

  private uploadPart(
    key: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: Buffer,
    response: ServerResponse,
  ): number {
    const uploadId = query.uploadId ?? "";
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) {
      this.sendError(response, 404, "NoSuchUpload", "The specified upload does not exist.");
      return 404;
    }
    const partNumber = Number.parseInt(query.partNumber ?? "", 10);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      this.sendError(response, 400, "InvalidArgument", "Part number must be between 1 and 10000");
      return 400;
    }
    const eTag = quotedMd5(body);
    upload.parts.set(partNumber, { body, eTag });
    response.writeHead(200, { etag: eTag });
    response.end();
    void headers;
    return 200;
  }

  private completeMultipartUpload(
    key: string,
    query: Record<string, string>,
    body: Buffer,
    response: ServerResponse,
    request: IncomingMessage,
    headers: Record<string, string>,
    rawQuery: string,
  ): number {
    const uploadId = query.uploadId ?? "";
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) {
      this.sendError(response, 404, "NoSuchUpload", "The specified upload does not exist.");
      return 404;
    }
    const requestedParts = parseCompleteParts(body.toString("utf8"));
    if (requestedParts.length === 0) {
      this.sendError(response, 400, "MalformedXML", "CompleteMultipartUpload requires at least one part");
      return 400;
    }
    const chunks: Buffer[] = [];
    for (let index = 0; index < requestedParts.length; index += 1) {
      const requested = requestedParts[index];
      const stored = upload.parts.get(requested.partNumber);
      if (!stored || stored.eTag !== requested.eTag) {
        this.sendError(response, 400, "InvalidPart", "One or more of the specified parts could not be found");
        return 400;
      }
      if (index < requestedParts.length - 1 && stored.body.byteLength < MULTIPART_MIN_PART_BYTES) {
        this.sendError(
          response,
          400,
          "EntityTooSmall",
          `Your proposed upload is smaller than the minimum allowed object size (${MULTIPART_MIN_PART_BYTES} bytes for non-final parts)`,
        );
        return 400;
      }
      chunks.push(stored.body);
    }
    const combined = Buffer.concat(chunks);
    const partMd5s = Buffer.concat(
      requestedParts.map((part) => Buffer.from(md5Hex(upload.parts.get(part.partNumber)!.body), "hex")),
    );
    const eTag = `"${md5Hex(partMd5s)}-${requestedParts.length}"`;
    const existing = this.objects.get(key);
    const target: FakeObject = existing ?? {
      body: Buffer.alloc(0),
      eTag: "",
      contentType: upload.contentType,
      metadata: {},
      lastModified: new Date().toISOString(),
      putCount: 0,
      copyCount: 0,
      deleteCount: 0,
    };
    target.body = combined;
    target.eTag = eTag;
    target.contentType = upload.contentType;
    target.metadata = { ...upload.metadata };
    target.lastModified = new Date().toISOString();
    target.putCount += 1;
    this.objects.set(key, target);
    this.countMutation(key, "put", combined);
    this.uploads.delete(uploadId);
    const afterCommitFault = this.takeFault("POST", key, rawQuery, true);
    if (afterCommitFault) {
      this.respondFault(response, afterCommitFault);
      return afterCommitFault.status;
    }
    const xml = `<CompleteMultipartUploadResult><Location>http://127.0.0.1/${escapeXml(this.bucket)}/${escapeXml(key)}</Location><Bucket>${escapeXml(this.bucket)}</Bucket><Key>${escapeXml(key)}</Key><ETag>${escapeXml(eTag)}</ETag></CompleteMultipartUploadResult>`;
    response.writeHead(200, XML_HEADERS);
    response.end(xml);
    void request;
    void headers;
    return 200;
  }

  private abortMultipartUpload(
    key: string,
    query: Record<string, string>,
    response: ServerResponse,
  ): number {
    const uploadId = query.uploadId ?? "";
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) {
      this.sendError(response, 404, "NoSuchUpload", "The specified upload does not exist.");
      return 404;
    }
    this.uploads.delete(uploadId);
    response.writeHead(204);
    response.end();
    return 204;
  }

  private listParts(
    key: string,
    query: Record<string, string>,
    response: ServerResponse,
  ): number {
    const uploadId = query.uploadId ?? "";
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) {
      this.sendError(response, 404, "NoSuchUpload", "The specified upload does not exist.");
      return 404;
    }
    const parts = [...upload.parts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([partNumber, part]) =>
        `<Part><PartNumber>${partNumber}</PartNumber><LastModified>${new Date().toISOString()}</LastModified><ETag>${escapeXml(part.eTag)}</ETag><Size>${part.body.byteLength}</Size></Part>`,
      )
      .join("");
    const xml = `<ListPartsResult><Bucket>${escapeXml(this.bucket)}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId><PartNumberMarker>0</PartNumberMarker><NextPartNumberMarker>0</NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`;
    response.writeHead(200, XML_HEADERS);
    response.end(xml);
    return 200;
  }

  private writeBody(
    response: ServerResponse,
    status: number,
    body: Buffer,
    headers: Record<string, string>,
    headOnly: boolean,
  ): void {
    response.writeHead(status, headers);
    response.end(headOnly ? undefined : body);
  }

  private sendError(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): void {
    const xml = `<Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message><RequestId>fake-s3</RequestId></Error>`;
    response.writeHead(status, { ...XML_HEADERS, ...extraHeaders });
    response.end(xml);
  }

  private finish(
    request: IncomingMessage,
    method: string,
    key: string,
    rawQuery: string,
    headers: Record<string, string>,
    status: number,
    bodySha: string | null,
  ): void {
    const authorization = headerValue(headers, "authorization") ?? "";
    const match = /SignedHeaders=([^,]+)/.exec(authorization);
    this.requests.push({
      method,
      key,
      rawQuery,
      headers: { ...headers },
      status,
      signedHeaders: match ? match[1].split(";") : [],
      bodySha256: bodySha,
    });
    void request;
  }

  private countMutation(key: string, kind: "put" | "copy" | "delete", body: Buffer | null): void {
    const ledger = this.isControlKey(key) ? this.stats.controlPlane : this.stats.userContent;
    ledger[kind] += 1;
    const entry = this.mutations.get(key) ?? {
      putCount: 0,
      copyCount: 0,
      deleteCount: 0,
      lastBodySha256: null,
    };
    if (kind === "put") entry.putCount += 1;
    else if (kind === "copy") entry.copyCount += 1;
    else entry.deleteCount += 1;
    if (body) entry.lastBodySha256 = sha256Hex(body);
    this.mutations.set(key, entry);
  }

  private isControlKey(key: string): boolean {
    return (
      key === `${this.controlPrefix}/scope.json` ||
      key.startsWith(`${this.controlPrefix}/`) ||
      key.includes(`/${this.controlPrefix}/`) ||
      key.endsWith("/.easy-sync-scope.json") ||
      key === ".easy-sync-scope.json"
    );
  }

  private recordViolation(message: string): void {
    this.violations.push(message);
  }
}

function normalizeRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return result;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function parseRawQuery(rawQuery: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (rawQuery.length === 0) return result;
  for (const part of rawQuery.split("&")) {
    const equals = part.indexOf("=");
    const rawKey = equals < 0 ? part : part.slice(0, equals);
    const rawValue = equals < 0 ? "" : part.slice(equals + 1);
    try {
      result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch {
      result[rawKey] = rawValue;
    }
  }
  return result;
}

function hasQuery(query: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(query, name);
}

function extractMetadata(headers: Readonly<Record<string, string>>): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase().startsWith("x-amz-meta-")) {
      metadata[name.slice("x-amz-meta-".length).toLowerCase()] = value;
    }
  }
  return metadata;
}

function metadataHeaders(metadata: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata)) headers[`x-amz-meta-${name}`] = value;
  return headers;
}

function decodeCopySource(source: string): string | null {
  const trimmed = source.startsWith("/") ? source.slice(1) : source;
  const segments = trimmed.split("/");
  if (segments.length < 2) return null;
  try {
    decodeURIComponent(segments[0]);
    return segments.slice(1).map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
}

function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = match[2].length === 0 ? size - 1 : Number.parseInt(match[2], 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function parseCompleteParts(xml: string): Array<{ partNumber: number; eTag: string }> {
  const parts: Array<{ partNumber: number; eTag: string }> = [];
  const partPattern = /<Part>([\s\S]*?)<\/Part>/g;
  let match: RegExpExecArray | null;
  while ((match = partPattern.exec(xml)) !== null) {
    const block = match[1];
    const number = /<PartNumber>(\d+)<\/PartNumber>/.exec(block);
    const eTag = /<ETag>([\s\S]*?)<\/ETag>/.exec(block);
    if (!number || !eTag) continue;
    parts.push({ partNumber: Number.parseInt(number[1], 10), eTag: unescapeXml(eTag[1]).trim() });
  }
  return parts;
}

function md5Hex(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

function quotedMd5(buffer: Buffer): string {
  return `"${md5Hex(buffer)}"`;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formEncode(value: string): string {
  return percentEncode(value).replace(/%20/g, "+");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
