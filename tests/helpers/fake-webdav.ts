/**
 * 进程内 fake WebDAV（L1 测试台，W1）。
 *
 * 设计 §13.2 的替身纪律：fake 只替代外部世界（HTTP 状态、条件判定、Depth
 * 遍历、MOVE 覆盖语义、路径解码），不替代被测规则（探针何时发条件头、失败
 * 后怎么降级）。因此条件语义**真实判定**，失败时不提交字节：
 *
 * - `PUT`：`If-None-Match: *` 撞已有 ⇒ 412；`If-Match` 不匹配 ⇒ 412；
 * - `DELETE`：`If-Match` 不匹配 ⇒ 412；文件不存在 ⇒ 404；
 * - `MOVE`：`Destination` 必须是绝对 URL；目标已存在且 `Overwrite: F` ⇒
 *   412（`ignore-overwrite-f` profile 模拟服务器忽略该头）；
 * - `MKCOL`：已存在 ⇒ 405；父集合缺失 ⇒ 409；只建最后一级；
 * - `PROPFIND`：`Depth: 0|1|infinity`，207 multistatus；`propfind-200`
 *   profile 模拟把 207 写成 200 的服务器；
 * - `weak-etag` profile 返回 `W/"…"`；`no-if-match` profile 忽略 `If-Match`；
 * - `no-move` profile 所有 `MOVE` 返回 405；`no-depth-infinity` 返回 403。
 *
 * 认证：所有请求必须带与构造参数一致的 Basic 头，否则 401；这保证探针不会
 * 在「匿名也能过」的假服务端上假绿。每个对象维护 PUT／DELETE／MOVE 计数与
 * 最近一次字节 SHA-256，负向用例应断言「旧 SHA 不变＋写计数不变」。
 *
 * 记录只用于测试断言；不模拟锁、配额、Range、集合递归删除或服务器端版本。
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { WebDavHttpRequest, WebDavHttpResponse, WebDavTransport } from "../../src/providers/webdav/webdav-probe";

export type FakeWebDavProfile =
  | "strict"
  | "weak-etag"
  | "no-if-match"
  | "no-move"
  | "no-depth-infinity"
  | "ignore-overwrite-f"
  | "propfind-200"
  | "ignore-depth"
  | "if-header-only"
  | "412-overwrites-target"
  | "put-2xx-without-write"
  | "propfind-404-body"
  | "move-201-without-destination"
  /** 坚果云画像：If-None-Match: * 被忽略（已有文件会被覆盖）。 */
  | "ignore-if-none-match"
  /** 坚果云画像：DELETE 上的 If-Match 被忽略（陈旧条件仍删除）。 */
  | "ignore-delete-if-match"
  /** 坚果云画像：目标已存在时 MOVE 用 409 拒绝，而不是 RFC 的 412。 */
  | "move-conflict-on-overwrite"
  /** 坚果云画像：Depth: infinity 实际只返回一层。 */
  | "depth-infinity-as-one"
  /** 坚果云画像：HEAD 不回真实 Content-Length。 */
  | "no-head-length"
  /** 坚果云画像：已存在集合的 MKCOL 仍回 201。 */
  | "mkcol-existing-201"
  /** 坚果云画像：根集合本身不能直接承载文件（只能建子文件夹）。 */
  | "root-files-forbidden"
  /** 坚果云画像：集合 PROPFIND 不带 ETag（W3e 实测 `eTag=null`）。 */
  | "no-collection-etag"
  /** 坚果云画像：请求过多时 503 + BlockedTemporarily XML。 */
  | "blocked-temporarily"
  /** 坚果云画像：Depth 1 超过 750 条时用 `Link: …?mk=…; rel="next"` 分页。 */
  | "paginate-750"
  /** 分页画像的负向变体：next 指向别的 origin。 */
  | "paginate-cross-origin"
  /** 分页画像的负向变体：next 指向同一 origin 的别的集合。 */
  | "paginate-other-path"
  /** 分页画像的负向变体：next 永远指回第一页。 */
  | "paginate-cycle"
  /** 分页画像的负向变体：永远给 next，用来验证页数上限。 */
  | "paginate-endless";

export interface FakeWebDavOptions {
  /** 远端根集合；默认 `/`。父集合会自动补建。 */
  readonly rootPath?: string;
  readonly username?: string;
  readonly password?: string;
  readonly profiles?: readonly FakeWebDavProfile[];
}

export interface FakeWebDavResourceSnapshot {
  readonly path: string;
  readonly kind: "file" | "collection";
  readonly size: number;
  readonly sha256: string;
  readonly eTag: string;
  readonly putCount: number;
  readonly deleteCount: number;
  readonly moveCount: number;
}

export interface FakeWebDavRequest {
  readonly method: string;
  readonly rawUrl: string;
  readonly rawPath: string;
  readonly decodedPath: string;
  readonly depth: string | null;
  readonly destination: string | null;
  readonly overwrite: string | null;
  readonly ifMatch: string | null;
  readonly ifNoneMatch: string | null;
  readonly ifHeader: string | null;
  readonly authScheme: "Basic" | "Other" | null;
  status: number;
}

interface FakeWebDavResource {
  kind: "file" | "collection";
  body: Buffer;
  version: number;
  lastModified: Date;
}

interface MutationLedger {
  put: number;
  delete: number;
  move: number;
}

const XML_HEADERS = { "Content-Type": "application/xml; charset=utf-8" } as const;
const BLOCKED_TEMPORARILY_XML = `<?xml version="1.0" encoding="UTF-8"?><d:error xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com"><s:exception>BlockedTemporarily</s:exception><s:message>Too many requests are received recently</s:message></d:error>`;
const DEFAULT_USERNAME = "probe";
const DEFAULT_PASSWORD = "app-password";

export class FakeWebDavServer {
  readonly rootPath: string;
  readonly requests: FakeWebDavRequest[] = [];

  private readonly username: string;
  private readonly password: string;
  private readonly initialProfiles: readonly FakeWebDavProfile[];
  private readonly resources = new Map<string, FakeWebDavResource>();
  private readonly ledger = new Map<string, MutationLedger>();
  /** Test-only forced MOVE failures keyed by decoded source path. */
  private readonly moveFailures = new Map<string, number>();
  private readonly sockets = new Set<Socket>();
  private profiles = new Set<FakeWebDavProfile>();
  private server: Server | null = null;

  constructor(options: FakeWebDavOptions = {}) {
    this.rootPath = normalizePath(options.rootPath ?? "/");
    this.username = options.username ?? DEFAULT_USERNAME;
    this.password = options.password ?? DEFAULT_PASSWORD;
    this.initialProfiles = options.profiles ?? ["strict"];
    this.reset();
  }

  async start(): Promise<{ endpoint: string; port: number }> {
    if (this.server !== null) throw new Error("FakeWebDavServer is already running");
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(`fake webdav internal error: ${String(error)}`);
      });
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    this.server = server;
    return { endpoint: `http://127.0.0.1:${address.port}`, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  reset(): void {
    this.resources.clear();
    this.ledger.clear();
    this.moveFailures.clear();
    this.requests.length = 0;
    this.profiles = new Set(this.initialProfiles);
    this.ensureParentCollections(this.rootPath);
    this.resources.set(this.rootPath, newResource("collection"));
  }

  setProfiles(profiles: readonly FakeWebDavProfile[]): void {
    this.profiles = new Set(profiles);
  }

  /** Test-only: every MOVE from `path` answers `status` until cleared. */
  failMoveFor(path: string, status = 409): void {
    this.moveFailures.set(normalizePath(path), status);
  }

  clearMoveFailures(): void {
    this.moveFailures.clear();
  }

  seedFile(path: string, content: string | Buffer): FakeWebDavResourceSnapshot {
    const normalized = normalizePath(path);
    this.ensureParentCollections(normalized);
    const body = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8");
    this.resources.set(normalized, newResource("file", body));
    return this.snapshot(normalized);
  }

  seedCollection(path: string): FakeWebDavResourceSnapshot {
    const normalized = normalizePath(path);
    this.ensureParentCollections(normalized);
    this.resources.set(normalized, newResource("collection"));
    return this.snapshot(normalized);
  }

  /** 测试用：改 lastModified 但不改内容与版本，ETag 保持不变。 */
  setLastModified(path: string, date: Date): FakeWebDavResourceSnapshot {
    const normalized = normalizePath(path);
    const resource = this.resources.get(normalized);
    if (!resource) throw new Error(`FakeWebDavServer has no resource at ${normalized}`);
    resource.lastModified = new Date(date);
    return this.snapshot(normalized);
  }

  getResource(path: string): FakeWebDavResourceSnapshot | null {
    const normalized = normalizePath(path);
    return this.resources.has(normalized) ? this.snapshot(normalized) : null;
  }

  readText(path: string): string | null {
    const resource = this.resources.get(normalizePath(path));
    return resource && resource.kind === "file" ? resource.body.toString("utf8") : null;
  }

  listPaths(): string[] {
    return [...this.resources.keys()].sort();
  }

  mutationCounts(path: string): { put: number; delete: number; move: number } {
    const entry = this.ledger.get(normalizePath(path));
    return entry
      ? { put: entry.put, delete: entry.delete, move: entry.move }
      : { put: 0, delete: 0, move: 0 };
  }

  private snapshot(path: string): FakeWebDavResourceSnapshot {
    const resource = this.resources.get(path);
    if (!resource) throw new Error(`FakeWebDavServer has no resource at ${path}`);
    const counts = this.mutationCounts(path);
    return {
      path,
      kind: resource.kind,
      size: resource.body.length,
      sha256: createHash("sha256").update(resource.body).digest("hex"),
      eTag: this.eTagOf(resource),
      putCount: counts.put,
      deleteCount: counts.delete,
      moveCount: counts.move,
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    let rawPath = "";
    let decodedPath = "/";
    try {
      const parsed = new URL(request.url ?? "/", "http://fake.local");
      rawPath = parsed.pathname;
      decodedPath = decodePathname(parsed.pathname);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("bad path");
      return;
    }
    const record: FakeWebDavRequest = {
      method,
      rawUrl: request.url ?? "",
      rawPath,
      decodedPath,
      depth: header(request, "depth"),
      destination: header(request, "destination"),
      overwrite: header(request, "overwrite"),
      ifMatch: header(request, "if-match"),
      ifNoneMatch: header(request, "if-none-match"),
      ifHeader: header(request, "if"),
      authScheme: authScheme(request),
      status: 0,
    };
    this.requests.push(record);

    if (!this.isAuthorized(request)) {
      this.respond(response, record, 401, { "WWW-Authenticate": 'Basic realm="fake-webdav"' });
      return;
    }

    if (this.profiles.has("blocked-temporarily")) {
      this.respond(response, record, 503, XML_HEADERS, BLOCKED_TEMPORARILY_XML);
      return;
    }

    switch (method) {
      case "PROPFIND":
        await this.handlePropfind(request, response, record);
        return;
      case "GET":
      case "HEAD":
        this.handleGetHead(response, record, method === "HEAD");
        return;
      case "PUT":
        await this.handlePut(request, response, record);
        return;
      case "DELETE":
        this.handleDelete(response, record);
        return;
      case "MKCOL":
        this.handleMkcol(response, record);
        return;
      case "MOVE":
        this.handleMove(response, record);
        return;
      default:
        this.respond(response, record, 405, { Allow: "PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE" });
    }
  }

  private async handlePropfind(
    _request: IncomingMessage,
    response: ServerResponse,
    record: FakeWebDavRequest,
  ): Promise<void> {
    const depth = (record.depth ?? "infinity").toLowerCase();
    if (depth !== "0" && depth !== "1" && depth !== "infinity") {
      this.respond(response, record, 400);
      return;
    }
    if (depth === "infinity" && this.profiles.has("no-depth-infinity")) {
      this.respond(response, record, 403, XML_HEADERS, this.errorXml("propfind-finite-depth"));
      return;
    }
    // 模拟静默忽略 Depth 的服务器：无论请求什么 Depth 都只返回自身。
    let effectiveDepth = this.profiles.has("ignore-depth") ? "0" : depth;
    // 坚果云：Depth: infinity 只返回直接子项，行为等同 Depth: 1。
    if (depth === "infinity" && this.profiles.has("depth-infinity-as-one")) {
      effectiveDepth = "1";
    }
    const start = this.resources.get(record.decodedPath);
    if (!start) {
      if (this.profiles.has("propfind-404-body")) {
        // 合法但少见：顶层 207，内部 response 的状态是 404。探针不能只看
        // href 就认为资源存在。
        const xml = [
          `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">`,
          `<d:response><d:href>${escapeXml(encodeHref(record.decodedPath))}</d:href>`,
          `<d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>`,
        ].join("");
        this.respond(response, record, 207, XML_HEADERS, xml);
        return;
      }
      this.respond(response, record, 404);
      return;
    }
    let matched: Array<[string, FakeWebDavResource]>;
    if (effectiveDepth === "0") {
      matched = [[record.decodedPath, start]];
    } else if (effectiveDepth === "1") {
      matched = [[record.decodedPath, start], ...this.childrenOf(record.decodedPath)];
    } else {
      const prefix = record.decodedPath === "/" ? "/" : `${record.decodedPath}/`;
      matched = [...this.resources.entries()].filter(
        ([path]) => path === record.decodedPath || path.startsWith(prefix),
      );
    }
    matched.sort(([left], [right]) => left.localeCompare(right));
    let page = matched;
    const headers: Record<string, string> = { ...XML_HEADERS, DAV: "1,2" };
    if (effectiveDepth === "1" && this.hasPaginationProfile()) {
      const paginated = this.paginateDepthOne(record, matched);
      page = paginated.entries;
      if (paginated.next !== null) headers.Link = `<${paginated.next}>; rel="next"`;
    }
    const status = this.profiles.has("propfind-200") ? 200 : 207;
    this.respond(response, record, status, headers, this.buildMultiStatus(page));
  }

  private hasPaginationProfile(): boolean {
    return this.profiles.has("paginate-750")
      || this.profiles.has("paginate-cross-origin")
      || this.profiles.has("paginate-other-path")
      || this.profiles.has("paginate-cycle")
      || this.profiles.has("paginate-endless");
  }

  /**
   * 模拟坚果云 Depth 1 分页：每页最多 750 个响应条目（含集合自身），
   * 还有后续条目时用 `Link: …?mk=<下一个子项下标>; rel="next"`。
   * 负向 profile 故意给出跨源／跨集合／指回首页的 next。
   */
  private paginateDepthOne(
    record: FakeWebDavRequest,
    matched: Array<[string, FakeWebDavResource]>,
  ): { entries: Array<[string, FakeWebDavResource]>; next: string | null } {
    const pageSize = 750;
    const self = matched.filter(([path]) => path === record.decodedPath);
    const children = matched.filter(([path]) => path !== record.decodedPath);
    const href = encodeHref(record.decodedPath);
    const truncated = children.length > pageSize - self.length;
    let offset = 0;
    try {
      const parsed = new URL(record.rawUrl, "http://fake.local");
      const marker = parsed.searchParams.get("mk");
      if (marker !== null && /^\d+$/.test(marker)) offset = Number(marker);
    } catch {
      offset = 0;
    }
    const pageChildren = children.slice(offset, offset + Math.max(0, pageSize - self.length));
    const entries = [...self, ...pageChildren];
    if (this.profiles.has("paginate-endless")) {
      // 每页都有 next，且 URL 持续变化（不触发循环检测），用于验证页数上限。
      return { entries, next: `${href}?mk=${offset + 1}` };
    }
    if (!truncated) return { entries, next: null };
    if (this.profiles.has("paginate-cycle")) {
      // 第一页正常给出第二页；第二页再指回第一页，触发客户端循环检测。
      return { entries, next: offset === 0 ? `${href}?mk=749` : href };
    }
    if (this.profiles.has("paginate-cross-origin")) {
      return { entries, next: `https://evil.example${href}?mk=749` };
    }
    if (this.profiles.has("paginate-other-path")) {
      return { entries, next: `/elsewhere?mk=749` };
    }
    const nextOffset = offset + pageChildren.length;
    return {
      entries,
      next: nextOffset < children.length ? `${href}?mk=${nextOffset}` : null,
    };
  }

  private handleGetHead(response: ServerResponse, record: FakeWebDavRequest, headOnly: boolean): void {
    const resource = this.resources.get(record.decodedPath);
    if (!resource) {
      this.respond(response, record, 404);
      return;
    }
    if (resource.kind === "collection") {
      this.respond(response, record, 405);
      return;
    }
    const headers = {
      ETag: this.eTagOf(resource),
      "Content-Type": "application/octet-stream",
      "Last-Modified": resource.lastModified.toUTCString(),
      // 坚果云 HEAD 不返回真实长度；客户端必须以 PROPFIND 为准。
      "Content-Length": String(
        headOnly && this.profiles.has("no-head-length") ? 0 : resource.body.length,
      ),
    };
    if (headOnly) {
      record.status = 200;
      response.writeHead(200, headers);
      response.end();
      return;
    }
    this.respond(response, record, 200, headers, resource.body);
  }

  private async handlePut(
    request: IncomingMessage,
    response: ServerResponse,
    record: FakeWebDavRequest,
  ): Promise<void> {
    const existing = this.resources.get(record.decodedPath);
    if (existing?.kind === "collection") {
      this.respond(response, record, 405);
      return;
    }
    const failure = this.preconditionFailure(record, existing);
    if (failure !== null) {
      this.respond(response, record, failure);
      return;
    }
    const body = await readBody(request);
    if (existing) {
      if (this.profiles.has("put-2xx-without-write")) {
        // 模拟「返回 2xx 但没落盘」的服务器：探针必须回读字节，不能只看状态码。
        this.respond(response, record, 204, { ETag: this.eTagOf(existing) });
        return;
      }
      existing.body = body;
      existing.version += 1;
      existing.lastModified = new Date();
      this.touch(record.decodedPath, "put");
      this.respond(response, record, 204, { ETag: this.eTagOf(existing) });
      return;
    }
    const parent = this.resources.get(parentPath(record.decodedPath));
    if (!parent || parent.kind !== "collection") {
      this.respond(response, record, 409);
      return;
    }
    // 坚果云：根集合自身只能建子文件夹，不能直接放文件。
    if (
      this.profiles.has("root-files-forbidden")
      && parentPath(record.decodedPath) === this.rootPath
    ) {
      this.respond(response, record, 404);
      return;
    }
    const resource = newResource("file", body);
    this.resources.set(record.decodedPath, resource);
    this.touch(record.decodedPath, "put");
    this.respond(response, record, 201, { ETag: this.eTagOf(resource) });
  }

  private handleDelete(response: ServerResponse, record: FakeWebDavRequest): void {
    const existing = this.resources.get(record.decodedPath);
    if (!existing) {
      this.respond(response, record, 404);
      return;
    }
    const failure = this.preconditionFailure(record, existing);
    if (failure !== null) {
      this.respond(response, record, failure);
      return;
    }
    if (existing.kind === "collection" && this.childrenOf(record.decodedPath).length > 0) {
      this.respond(response, record, 409);
      return;
    }
    this.resources.delete(record.decodedPath);
    this.touch(record.decodedPath, "delete");
    this.respond(response, record, 204);
  }

  private handleMkcol(response: ServerResponse, record: FakeWebDavRequest): void {
    if (this.resources.has(record.decodedPath)) {
      this.respond(
        response,
        record,
        this.profiles.has("mkcol-existing-201") ? 201 : 405,
      );
      return;
    }
    const parent = this.resources.get(parentPath(record.decodedPath));
    if (!parent || parent.kind !== "collection") {
      this.respond(response, record, 409);
      return;
    }
    this.resources.set(record.decodedPath, newResource("collection"));
    this.touch(record.decodedPath, "put");
    this.respond(response, record, 201);
  }

  private handleMove(response: ServerResponse, record: FakeWebDavRequest): void {
    if (this.profiles.has("no-move")) {
      this.respond(response, record, 405);
      return;
    }
    const forcedFailure = this.moveFailures.get(record.decodedPath);
    if (forcedFailure !== undefined) {
      this.respond(response, record, forcedFailure);
      return;
    }
    const source = this.resources.get(record.decodedPath);
    if (!source) {
      this.respond(response, record, 404);
      return;
    }
    if (record.destination === null) {
      this.respond(response, record, 400);
      return;
    }
    let destinationUrl: URL;
    try {
      destinationUrl = new URL(record.destination);
    } catch {
      this.respond(response, record, 400);
      return;
    }
    if (destinationUrl.protocol !== "http:" && destinationUrl.protocol !== "https:") {
      this.respond(response, record, 400);
      return;
    }
    const destinationPath = decodePathname(destinationUrl.pathname);
    if (destinationPath === record.decodedPath) {
      this.respond(response, record, 403);
      return;
    }
    const parent = this.resources.get(parentPath(destinationPath));
    if (!parent || parent.kind !== "collection") {
      this.respond(response, record, 409);
      return;
    }
    const destination = this.resources.get(destinationPath);
    const overwrite = (record.overwrite ?? "T").toUpperCase();
    if (destination) {
      if (overwrite === "F" && !this.profiles.has("ignore-overwrite-f")) {
        if (this.profiles.has("412-overwrites-target") && source.kind === "file" && destination.kind === "file") {
          // 模拟「先覆盖再报 412」的服务器：探针必须回读目标字节才能相信 412。
          destination.body = source.body;
          destination.version += 1;
          destination.lastModified = new Date();
          this.touch(destinationPath, "put");
        }
        // 坚果云用 409 DuplicateName 拒绝覆盖；语义仍是「目标未变」。
        this.respond(
          response,
          record,
          this.profiles.has("move-conflict-on-overwrite") ? 409 : 412,
        );
        return;
      }
      if (destination.kind === "collection") {
        this.respond(response, record, 409);
        return;
      }
    }

    if (this.profiles.has("move-201-without-destination")) {
      // 模拟「报 201 但没把目标落盘」的服务器：探针必须 PROPFIND 目标并
      // 检查 per-response 状态，不能只看 MOVE 的 2xx。
      this.resources.delete(record.decodedPath);
      this.touch(record.decodedPath, "move");
      this.respond(response, record, 201);
      return;
    }

    if (source.kind === "collection") {
      const prefix = `${record.decodedPath}/`;
      const descendants = [...this.resources.entries()].filter(
        ([path]) => path === record.decodedPath || path.startsWith(prefix),
      );
      for (const [path, resource] of descendants) {
        const movedPath = `${destinationPath}${path.slice(record.decodedPath.length)}`;
        this.resources.delete(path);
        this.resources.set(movedPath, resource);
        this.touch(path, "move");
      }
    } else {
      this.resources.delete(record.decodedPath);
      this.resources.set(destinationPath, source);
      this.touch(record.decodedPath, "move");
    }
    const moved = this.resources.get(destinationPath);
    this.respond(
      response,
      record,
      destination === undefined ? 201 : 204,
      moved ? { ETag: this.eTagOf(moved) } : {},
    );
  }

  private preconditionFailure(
    record: FakeWebDavRequest,
    existing: FakeWebDavResource | undefined,
  ): number | null {
    // `no-if-match` 表示服务器不认 ETag 条件头（If-Match 与 RFC 4918 If
    // 都不生效）；`if-header-only` 表示只认 RFC 4918 If，不认 If-Match。
    const ignoreIfMatch = this.profiles.has("no-if-match")
      || (record.method === "DELETE" && this.profiles.has("ignore-delete-if-match"));
    if (!ignoreIfMatch) {
      if (!this.profiles.has("if-header-only") && record.ifMatch !== null) {
        if (record.ifMatch.trim() === "*") {
          if (!existing) return 412;
        } else if (!existing || !this.strongETagMatches(record.ifMatch, existing)) {
          return 412;
        }
      }
      if (record.ifHeader !== null) {
        const ifResult = this.evaluateIfHeader(record.ifHeader, existing);
        if (ifResult === false) return 412;
      }
    }
    if (record.ifNoneMatch !== null && !this.profiles.has("ignore-if-none-match")) {
      if (record.ifNoneMatch.trim() === "*") {
        if (existing) return 412;
      } else if (existing && this.weakETagMatches(record.ifNoneMatch, existing)) {
        return 412;
      }
    }
    return null;
  }

  /** 只理解 `If: (["etag"])`；不匹配、资源不存在或语法不认识时按失败处理。 */
  private evaluateIfHeader(
    value: string,
    existing: FakeWebDavResource | undefined,
  ): boolean | null {
    const match = /\(\s*\[\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/.exec(value);
    if (!match) return null;
    if (!existing) return false;
    if (this.profiles.has("weak-etag")) return false;
    return match[1] === this.eTagOf(existing);
  }

  private strongETagMatches(headerValue: string, resource: FakeWebDavResource): boolean {
    if (this.profiles.has("weak-etag")) return false;
    const target = this.eTagOf(resource);
    return headerValue
      .split(",")
      .map((token) => token.trim())
      .some((token) => token === target);
  }

  private weakETagMatches(headerValue: string, resource: FakeWebDavResource): boolean {
    const target = this.eTagOf(resource).replace(/^W\//i, "");
    return headerValue
      .split(",")
      .map((token) => token.trim().replace(/^W\//i, ""))
      .some((token) => token === target);
  }

  private buildMultiStatus(entries: Array<[string, FakeWebDavResource]>): string {
    const responses = entries.map(([path, resource]) => {
      const displayName = path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1);
      const collection = resource.kind === "collection" ? "<d:collection/>" : "";
      const length = resource.kind === "file"
        ? `<d:getcontentlength>${resource.body.length}</d:getcontentlength>`
        : "";
      const etag = resource.kind === "collection"
        && this.profiles.has("no-collection-etag")
        ? ""
        : `<d:getetag>${escapeXml(this.eTagOf(resource))}</d:getetag>`;
      return [
        `<d:response>`,
        `<d:href>${escapeXml(encodeHref(path))}</d:href>`,
        `<d:propstat><d:prop>`,
        `<d:displayname>${escapeXml(displayName)}</d:displayname>`,
        `<d:resourcetype>${collection}</d:resourcetype>`,
        etag,
        length,
        `<d:getlastmodified>${resource.lastModified.toUTCString()}</d:getlastmodified>`,
        `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`,
        `</d:response>`,
      ].join("");
    }).join("");
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses}</d:multistatus>`;
  }

  private errorXml(element: string): string {
    return `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:${element}/></d:error>`;
  }

  private eTagOf(resource: FakeWebDavResource): string {
    const digest = createHash("sha1")
      .update(resource.body)
      .update(String(resource.version))
      .digest("hex");
    const strong = `"${digest}"`;
    return this.profiles.has("weak-etag") ? `W/${strong}` : strong;
  }

  private childrenOf(path: string): Array<[string, FakeWebDavResource]> {
    return [...this.resources.entries()].filter(
      ([candidate]) => candidate !== path && parentPath(candidate) === path,
    );
  }

  private ensureParentCollections(path: string): void {
    if (!this.resources.has("/")) {
      this.resources.set("/", newResource("collection"));
    }
    let current = "/";
    for (const segment of path.split("/").filter((part) => part.length > 0)) {
      current = current === "/" ? `/${segment}` : `${current}/${segment}`;
      if (!this.resources.has(current)) {
        this.resources.set(current, newResource("collection"));
      }
    }
  }

  private touch(path: string, kind: keyof MutationLedger): void {
    const entry = this.ledger.get(path) ?? { put: 0, delete: 0, move: 0 };
    entry[kind] += 1;
    this.ledger.set(path, entry);
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64")}`;
    return header(request, "authorization") === expected;
  }

  private respond(
    response: ServerResponse,
    record: FakeWebDavRequest,
    status: number,
    headers: Record<string, string> = {},
    body?: Buffer | string,
  ): void {
    record.status = status;
    const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const responseHeaders: Record<string, string> = { ...headers };
    if (payload !== undefined) responseHeaders["Content-Length"] = String(payload.length);
    response.writeHead(status, responseHeaders);
    response.end(payload);
  }
}

/**
 * 测试专用传输：把 `https://webdav.test` 形状的请求改写到本机 fake 的
 * `http://127.0.0.1:<port>`，但保留路径与查询的原始编码。这样生产探针仍然
 * 只接受 HTTPS，测试却在明文 loopback 上跑，不需要在 src 里开 `http://`
 * 的测试后门。
 */
export function createLoopbackWebDavTransport(options: {
  readonly port: number;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly defaultDeadlineMs?: number;
}): WebDavTransport {
  const baseUrl = options.baseUrl ?? "https://webdav.test";
  const expectedOrigin = new URL(baseUrl).origin;
  const rewriteOrigin = `http://127.0.0.1:${options.port}`;
  const fetchFn = options.fetchFn ?? fetch;
  const defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000;
  return async (request: WebDavHttpRequest): Promise<WebDavHttpResponse> => {
    const url = new URL(request.url);
    if (url.origin !== expectedOrigin) {
      throw new Error(`unexpected WebDAV probe origin ${url.origin}; expected ${expectedOrigin}`);
    }
    const target = `${rewriteOrigin}${url.pathname}${url.search}`;
    const deadline = Number.isFinite(request.deadlineMs) && request.deadlineMs > 0
      ? request.deadlineMs
      : defaultDeadlineMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      const response = await fetchFn(target, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        redirect: "manual",
        signal: controller.signal,
      });
      const body = await response.arrayBuffer();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return { status: response.status, headers, body };
    } catch {
      return { status: 0, headers: {}, body: new ArrayBuffer(0) };
    } finally {
      clearTimeout(timer);
    }
  };
}

function newResource(kind: "file" | "collection", body: Buffer = Buffer.alloc(0)): FakeWebDavResource {
  return { kind, body, version: 0, lastModified: new Date() };
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value ?? null;
}

function authScheme(request: IncomingMessage): "Basic" | "Other" | null {
  const value = header(request, "authorization");
  if (value === null) return null;
  return /^Basic\s+/i.test(value) ? "Basic" : "Other";
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizePath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`fake WebDAV path "${path}" contains a dot segment`);
    }
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function decodePathname(pathname: string): string {
  const decoded = pathname.split("/").map((segment) => decodeURIComponent(segment));
  return normalizePath(decoded.join("/"));
}

function parentPath(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function encodeHref(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
