/**
 * S3 客户端：ListObjectsV2／HEAD／GET／PUT／COPY／DELETE／multipart。
 *
 * 设计约束（§5.2、§5.3）：
 * - 原语方法一方法一请求；重试策略只按固定表决定「能否重试、重试时保持什么
 *   条件头」，不内嵌 planner／ledger 逻辑；
 * - 条件写：create-only 用 `If-None-Match: *`，更新与删除用 `If-Match`；
 * - COPY 的目标侧必须带 `If-None-Match: *`；已知目标条件不被支持时**拒绝
 *   执行**，不退化为 HEAD＋COPY；
 * - DELETE 对不存在的 key 也返回 204，所以 `deleteObjectVerified` 用 HEAD
 *   复核，204 本身不算删除证据；
 * - multipart 的 ETag 形如 `md5-of-md5s-N`，永不当作内容哈希。
 *
 * 传输通过 `S3Transport` 注入；生产实现见 `s3-transport.ts`，测试注入 Node
 * `fetch`。本模块不直接 import 宿主 API。
 */
import { sha256Hex } from "../../crypto";
import { compatSetTimeout } from "../../obsidian-compat";
import { childText, decodeXmlBytes, findChildren, parseXml, type XmlElement } from "../xml";
import { OneDriveErrorType } from "../../onedrive/types";
import {
  canonicalQueryString,
  canonicalUri,
  encodeRfc3986,
  signS3Request,
  type AwsCredentials,
  type QueryPairs,
} from "./sigv4";
import {
  classifyS3Response,
  headerValue,
  S3Error,
  S3RequestTooLargeError,
  S3UnsupportedOperationError,
  s3ErrorFromResponse,
  s3ProtocolError,
} from "./s3-errors";
import type { S3HttpRequest, S3HttpResponse, S3Transport } from "./s3-transport";
import type { S3ListPage, S3ListedObject } from "./s3-enum-checkpoint";
import { S3_MAX_SINGLE_PUT_BYTES_DESKTOP } from "./s3-capabilities";

const DEFAULT_REQUEST_DEADLINE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 2_000;
const DEFAULT_COPY_OBJECT_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const MULTIPART_MAX_PARTS = 10_000;
const MULTIPART_PART_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const MULTIPART_PART_MIN_BYTES = 5 * 1024 * 1024;

export type S3AddressingStyle = "auto" | "path" | "virtual";
export type ResolvedAddressingStyle = "path" | "virtual";

export interface S3Address {
  readonly host: string;
  /** 未编码的路径，以 `/` 开头。 */
  readonly path: string;
  /** 实际请求 URL（路径与查询已编码）。 */
  readonly url: string;
  readonly style: ResolvedAddressingStyle;
}

export interface S3CopyObjectArgs {
  readonly sourceKey: string;
  readonly targetKey: string;
  /** 源对象 ETag；COPY 必须携带源侧条件（设计 §5.3、§10.1）。 */
  readonly sourceETag: string;
  readonly contentType?: string;
  readonly metadataDirective?: "COPY" | "REPLACE";
  /** 为 false 时客户端在发请求前拒绝 copy（不退化 HEAD＋COPY）。 */
  readonly conditionalCopyTarget: boolean;
  readonly sourceSize?: number;
}

export interface S3DeleteVerifiedResult {
  readonly deleted: boolean;
  readonly verifiedAbsent: boolean;
}

export interface S3RetryOptions {
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly maxBackoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface S3ClientConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: AwsCredentials;
  readonly transport: S3Transport;
  readonly addressingStyle?: S3AddressingStyle;
  readonly maxSinglePutBytes?: number;
  readonly maxSingleGetBytes?: number;
  readonly requestDeadlineMs?: number;
  readonly retry?: S3RetryOptions;
  readonly refreshCredentials?: () => Promise<AwsCredentials>;
  readonly now?: () => Date;
}

interface RequestPlan {
  readonly method: string;
  readonly key: string;
  readonly query?: QueryPairs;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ArrayBuffer;
  readonly expectedStatuses: readonly number[];
  readonly retryable: boolean;
  readonly checkEmbeddedError?: boolean;
  readonly operation: string;
}

/**
 * 寻址：默认 virtual-hosted；endpoint 是 IP／localhost 或 bucket 名含点时用
 * path-style。`path` 与 `query` 都保持 raw，编码由签名／URL 构造统一负责。
 */
export function resolveS3Address(
  endpoint: string,
  bucket: string,
  key: string,
  style: S3AddressingStyle = "auto",
  query: QueryPairs = [],
): S3Address {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw s3ProtocolError(`Invalid S3 endpoint "${endpoint}"`);
  }
  if (bucket.trim().length === 0) throw s3ProtocolError("S3 bucket is required");
  const resolvedStyle: ResolvedAddressingStyle = style === "auto"
    ? shouldUsePathStyle(url.hostname, bucket)
      ? "path"
      : "virtual"
    : style;
  const host = resolvedStyle === "virtual" ? `${bucket}.${url.host}` : url.host;
  const path = resolvedStyle === "virtual"
    ? `/${key}`
    : key.length === 0
      ? `/${bucket}`
      : `/${bucket}/${key}`;
  const queryString = canonicalQueryString(query);
  const encodedPath = canonicalUri(path);
  const requestUrl = `${url.protocol}//${host}${encodedPath}${queryString.length > 0 ? `?${queryString}` : ""}`;
  return { host, path, url: requestUrl, style: resolvedStyle };
}

function shouldUsePathStyle(hostname: string, bucket: string): boolean {
  if (bucket.includes(".")) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

export interface S3HeadResult {
  readonly exists: boolean;
  readonly eTag: string | null;
  readonly contentLength: number | null;
  readonly lastModified: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface S3GetOptions {
  readonly range?: { readonly offset: number; readonly length: number };
}

export interface S3GetResult {
  readonly status: number;
  readonly body: ArrayBuffer;
  readonly eTag: string | null;
  readonly contentLength: number | null;
  readonly contentRange: string | null;
  /** 只有 206 且 `Content-Range` 起点与请求 offset 相等才为 true。 */
  readonly rangeAccepted: boolean;
}

export interface S3MultipartPart {
  readonly partNumber: number;
  readonly eTag: string;
  readonly size?: number;
}

export class S3Client {
  private readonly config: S3ClientConfig;
  private readonly retry: Required<Pick<S3RetryOptions, "maxAttempts" | "backoffBaseMs" | "maxBackoffMs">> & {
    readonly sleep: (ms: number) => Promise<void>;
    readonly random: () => number;
  };
  private readonly deadlineMs: number;
  private readonly maxSinglePutBytes: number;
  private readonly maxSingleGetBytes: number;

  constructor(config: S3ClientConfig) {
    this.config = config;
    this.deadlineMs = config.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
    this.maxSinglePutBytes = config.maxSinglePutBytes ?? S3_MAX_SINGLE_PUT_BYTES_DESKTOP;
    this.maxSingleGetBytes = config.maxSingleGetBytes ?? 64 * 1024 * 1024;
    this.retry = {
      maxAttempts: Math.max(1, config.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      backoffBaseMs: config.retry?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      maxBackoffMs: config.retry?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      sleep: config.retry?.sleep ?? defaultSleep,
      random: config.retry?.random ?? Math.random,
    };
  }

  // ---------------------------------------------------------------------
  // ListObjectsV2
  // ---------------------------------------------------------------------

  async listObjectsV2(input: {
    readonly prefix?: string;
    readonly continuationToken?: string;
    readonly maxKeys?: number;
    readonly encodingType?: "url";
    readonly delimiter?: string;
  } = {}): Promise<S3ListPage> {
    const requestedMaxKeys = input.maxKeys ?? 1000;
    const maxKeys = Math.min(
      Math.max(1, Number.isFinite(requestedMaxKeys) ? Math.trunc(requestedMaxKeys) : 1000),
      1000,
    );
    const query: Array<[string, string]> = [["list-type", "2"], ["max-keys", String(maxKeys)]];
    if (input.prefix !== undefined) query.push(["prefix", input.prefix]);
    if (input.continuationToken !== undefined && input.continuationToken.length > 0) {
      query.push(["continuation-token", input.continuationToken]);
    }
    const encodingType = input.encodingType ?? "url";
    if (encodingType) query.push(["encoding-type", encodingType]);
    if (input.delimiter !== undefined) query.push(["delimiter", input.delimiter]);
    const response = await this.send({
      method: "GET",
      key: "",
      query,
      expectedStatuses: [200],
      retryable: true,
      operation: "ListObjectsV2",
    });
    const root = this.parseXmlResponse(response, "ListObjectsV2", "ListBucketResult");
    const isTruncated = (childText(root, "IsTruncated") ?? "false").trim().toLowerCase() === "true";
    const nextContinuationToken = childText(root, "NextContinuationToken")?.trim() || undefined;
    const objects: S3ListedObject[] = findChildren(root, "Contents").map((contents) => {
      const rawKey = childText(contents, "Key");
      if (rawKey === null) throw s3ProtocolError("ListObjectsV2 response contains Contents without a Key");
      const key = encodingType === "url" ? percentDecodeUtf8(rawKey) : rawKey;
      const sizeText = childText(contents, "Size");
      return {
        key,
        size: sizeText === null ? 0 : Number.parseInt(sizeText, 10) || 0,
        eTag: childText(contents, "ETag"),
        lastModified: childText(contents, "LastModified"),
      };
    });
    return { objects, isTruncated, nextContinuationToken };
  }

  // ---------------------------------------------------------------------
  // Object primitives
  // ---------------------------------------------------------------------

  async headObject(key: string): Promise<S3HeadResult> {
    const response = await this.send({
      method: "HEAD",
      key,
      expectedStatuses: [200, 404],
      retryable: true,
      operation: "HeadObject",
    });
    if (response.status === 404) {
      return { exists: false, eTag: null, contentLength: null, lastModified: null, metadata: {} };
    }
    const contentLengthText = headerValue(response.headers, "content-length");
    const contentLength = contentLengthText === undefined ? null : Number.parseInt(contentLengthText, 10);
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (name.toLowerCase().startsWith("x-amz-meta-")) {
        metadata[name.slice("x-amz-meta-".length)] = value;
      }
    }
    return {
      exists: true,
      eTag: headerValue(response.headers, "etag") ?? null,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      lastModified: headerValue(response.headers, "last-modified") ?? null,
      metadata,
    };
  }

  async getObject(key: string, options: S3GetOptions = {}): Promise<S3GetResult> {
    const headers: Record<string, string> = {};
    if (options.range) {
      const { offset, length } = options.range;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
        throw s3ProtocolError("S3 Range requires a non-negative offset and a positive length");
      }
      headers.range = `bytes=${offset}-${offset + length - 1}`;
    }
    const response = await this.send({
      method: "GET",
      key,
      headers,
      expectedStatuses: [200, 206],
      retryable: true,
      // 下载内容可能是任意字节；不能把对象正文当 S3 控制面 XML 解析。
      checkEmbeddedError: false,
      operation: "GetObject",
    });
    if (response.body.byteLength > this.maxSingleGetBytes) {
      throw new S3RequestTooLargeError(response.body.byteLength, this.maxSingleGetBytes, "S3 GET response");
    }
    const contentRange = headerValue(response.headers, "content-range") ?? null;
    const contentLengthText = headerValue(response.headers, "content-length");
    const contentLength = contentLengthText === undefined ? null : Number.parseInt(contentLengthText, 10);
    if (contentLength !== null && Number.isFinite(contentLength) && contentLength > this.maxSingleGetBytes) {
      throw new S3RequestTooLargeError(contentLength, this.maxSingleGetBytes, "S3 GET response");
    }
    let rangeAccepted = false;
    if (options.range && response.status === 206) {
      const parsed = parseContentRange(contentRange);
      rangeAccepted = parsed !== null && parsed.start === options.range.offset;
    }
    return {
      status: response.status,
      body: response.body,
      eTag: headerValue(response.headers, "etag") ?? null,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      contentRange,
      rangeAccepted,
    };
  }

  /**
   * Range 的安全复合操作：206 且起点可证相等才算命中；服务端忽略 Range
   * （200）或 416 时，自动退回整份 GET。原语 `getObject` 仍是一方法一请求，
   * 这里只表达「不得把未证明的 200 当成区间」这一条协议规则。
   */
  async getObjectRangeOrFull(
    key: string,
    range: { readonly offset: number; readonly length: number },
  ): Promise<S3GetResult & { readonly fallbackToFull: boolean }> {
    try {
      const ranged = await this.getObject(key, { range });
      if (ranged.rangeAccepted) return { ...ranged, fallbackToFull: false };
    } catch (error) {
      if (!(error instanceof S3Error && error.type === OneDriveErrorType.RangeNotSatisfiable)) {
        throw error;
      }
    }
    const full = await this.getObject(key);
    return { ...full, fallbackToFull: true };
  }

  async putObjectCreateOnly(
    key: string,
    body: ArrayBuffer,
    options: { readonly contentType?: string; readonly metadata?: Readonly<Record<string, string>> } = {},
  ): Promise<{ eTag: string | null; recovered?: boolean }> {
    this.assertSinglePutSize(body.byteLength);
    try {
      const response = await this.send({
        method: "PUT",
        key,
        headers: this.objectHeaders(options, { "if-none-match": "*" }),
        body,
        expectedStatuses: [200, 201],
        retryable: true,
        operation: "PutObject(create-only)",
      });
      return { eTag: headerValue(response.headers, "etag") ?? null };
    } catch (error) {
      // 重试前一次尝试是网络错误／5xx 时，412 可能表示「上次其实已经成功」。
      // 不用 412 直接判失败：HEAD＋内容哈希证明目标就是本次上传的字节。
      if (
        error instanceof S3Error &&
        (error.type === OneDriveErrorType.PreconditionFailed || error.type === OneDriveErrorType.Conflict) &&
        error.ambiguousPreviousAttempt
      ) {
        const provenETag = await this.proveObjectContent(key, body);
        if (provenETag !== null) return { eTag: provenETag, recovered: true };
      }
      throw error;
    }
  }

  async putObjectUpdate(
    key: string,
    body: ArrayBuffer,
    options: { readonly ifMatch: string; readonly contentType?: string; readonly metadata?: Readonly<Record<string, string>> },
  ): Promise<{ eTag: string | null }> {
    if (!options.ifMatch || options.ifMatch.trim().length === 0) {
      throw s3ProtocolError("S3 conditional update requires a non-empty If-Match ETag");
    }
    this.assertSinglePutSize(body.byteLength);
    const response = await this.send({
      method: "PUT",
      key,
      headers: this.objectHeaders(options, { "if-match": options.ifMatch }),
      body,
      expectedStatuses: [200, 201],
      retryable: true,
      operation: "PutObject(update)",
    });
    return { eTag: headerValue(response.headers, "etag") ?? null };
  }

  async copyObject(args: S3CopyObjectArgs): Promise<{ eTag: string | null }> {
    if (!args.conditionalCopyTarget) {
      throw new S3UnsupportedOperationError(
        "S3 COPY target condition (If-None-Match) is not supported; refusing to copy instead of degrading to HEAD+COPY",
        "conditionalCopyTarget",
      );
    }
    if (!args.sourceETag || args.sourceETag.trim().length === 0) {
      throw s3ProtocolError("S3 conditional copy requires a non-empty source ETag");
    }
    if (args.sourceSize !== undefined && args.sourceSize > DEFAULT_COPY_OBJECT_LIMIT_BYTES) {
      throw new S3UnsupportedOperationError(
        `S3 CopyObject only supports objects up to ${DEFAULT_COPY_OBJECT_LIMIT_BYTES} bytes`,
        "copyObjectSizeLimit",
      );
    }
    const headers: Record<string, string> = {
      "x-amz-copy-source": encodeCopySource(this.config.bucket, args.sourceKey),
      "x-amz-metadata-directive": args.metadataDirective ?? "COPY",
      "if-none-match": "*",
    };
    if (args.sourceETag) headers["x-amz-copy-source-if-match"] = args.sourceETag;
    if (args.metadataDirective === "REPLACE" && args.contentType) {      headers["content-type"] = args.contentType;
    }
    const response = await this.send({
      method: "PUT",
      key: args.targetKey,
      headers,
      expectedStatuses: [200],
      retryable: true,
      operation: "CopyObject",
    });
    const root = this.parseXmlResponse(response, "CopyObject", "CopyObjectResult");
    return { eTag: childText(root, "ETag") };
  }

  /**
   * 条件删除（原语）。204 对不存在的 key 也成立，因此本方法只证明「服务端
   * 接受了删除请求」；需要删除证据时用 `deleteObjectVerified`。
   */
  async deleteObject(key: string, options: { readonly ifMatch: string }): Promise<void> {
    if (!options.ifMatch || options.ifMatch.trim().length === 0) {
      throw new S3UnsupportedOperationError(
        "S3 conditional delete requires If-Match; refusing an unconditional delete",
        "conditionalDelete",
      );
    }
    await this.send({
      method: "DELETE",
      key,
      headers: { "if-match": options.ifMatch },
      expectedStatuses: [200, 204],
      retryable: true,
      operation: "DeleteObject",
    });
  }

  /** DELETE 后用 HEAD 复核 404；只有 404 才算「预期对象已不在」。 */
  async deleteObjectVerified(
    key: string,
    options: { readonly ifMatch?: string } = {},
  ): Promise<S3DeleteVerifiedResult> {
    const before = await this.headObject(key);
    if (!before.exists) return { deleted: false, verifiedAbsent: true };
    const ifMatch = options.ifMatch ?? before.eTag;
    if (!ifMatch) {
      throw s3ProtocolError("S3 conditional delete requires an ETag; HEAD returned none");
    }
    await this.deleteObject(key, { ifMatch });
    const after = await this.headObject(key);
    return { deleted: !after.exists, verifiedAbsent: !after.exists };
  }

  // ---------------------------------------------------------------------
  // Multipart
  // ---------------------------------------------------------------------

  async createMultipartUpload(
    key: string,
    options: { readonly contentType?: string; readonly metadata?: Readonly<Record<string, string>> } = {},
  ): Promise<{ uploadId: string }> {
    const response = await this.send({
      method: "POST",
      key,
      query: [["uploads", ""]],
      headers: this.objectHeaders(options),
      expectedStatuses: [200],
      retryable: true,
      operation: "CreateMultipartUpload",
    });
    const root = this.parseXmlResponse(response, "CreateMultipartUpload", "InitiateMultipartUploadResult");
    const uploadId = childText(root, "UploadId");
    if (!uploadId) throw s3ProtocolError("CreateMultipartUpload response is missing UploadId");
    return { uploadId };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer,
  ): Promise<{ eTag: string | null }> {
    assertPartNumber(partNumber);
    if (body.byteLength > MULTIPART_PART_MAX_BYTES) {
      throw new S3RequestTooLargeError(body.byteLength, MULTIPART_PART_MAX_BYTES, "S3 multipart part");
    }
    const response = await this.send({
      method: "PUT",
      key,
      query: [["partNumber", String(partNumber)], ["uploadId", uploadId]],
      body,
      expectedStatuses: [200],
      retryable: true,
      operation: "UploadPart",
    });
    return { eTag: headerValue(response.headers, "etag") ?? null };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly S3MultipartPart[],
  ): Promise<{ eTag: string | null; recovered: boolean }> {
    const normalized = normalizeParts(parts);
    const body = new TextEncoder().encode(completeMultipartXml(normalized)).buffer;
    try {
      const response = await this.send({
        method: "POST",
        key,
        query: [["uploadId", uploadId]],
        headers: { "content-type": "application/xml" },
        body,
        expectedStatuses: [200],
        retryable: true,
        operation: "CompleteMultipartUpload",
      });
      const root = this.parseXmlResponse(response, "CompleteMultipartUpload", "CompleteMultipartUploadResult");
      return { eTag: childText(root, "ETag"), recovered: false };
    } catch (error) {
      // Complete 已成功但响应丢失时，重试会得到 NoSuchUpload；HEAD 目标对象
      // 存在才把它当作「上一次其实成功了」，不盲目重传。
      if (
        error instanceof S3Error &&
        error.code === "NoSuchUpload" &&
        error.ambiguousPreviousAttempt
      ) {
        const head = await this.headObject(key);
        if (head.exists) return { eTag: head.eTag, recovered: true };
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.send({
      method: "DELETE",
      key,
      query: [["uploadId", uploadId]],
      expectedStatuses: [200, 204, 404],
      retryable: true,
      operation: "AbortMultipartUpload",
    });
  }

  async listParts(
    key: string,
    uploadId: string,
  ): Promise<{
    parts: ReadonlyArray<{ partNumber: number; eTag: string | null; size: number | null }>;
    isTruncated: boolean;
    nextPartNumberMarker?: string;
  }> {
    const response = await this.send({
      method: "GET",
      key,
      query: [["uploadId", uploadId]],
      expectedStatuses: [200],
      retryable: true,
      operation: "ListParts",
    });
    const root = this.parseXmlResponse(response, "ListParts", "ListPartsResult");
    return {
      parts: findChildren(root, "Part").map((part) => {
        const partNumber = Number.parseInt(childText(part, "PartNumber") ?? "", 10);
        const sizeText = childText(part, "Size");
        const size = sizeText === null ? null : Number.parseInt(sizeText, 10);
        return {
          partNumber: Number.isFinite(partNumber) ? partNumber : 0,
          eTag: childText(part, "ETag"),
          size: size !== null && Number.isFinite(size) ? size : null,
        };
      }),
      isTruncated: (childText(root, "IsTruncated") ?? "false").trim().toLowerCase() === "true",
      nextPartNumberMarker: childText(root, "NextPartNumberMarker")?.trim() || undefined,
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private objectHeaders(
    options: { readonly contentType?: string; readonly metadata?: Readonly<Record<string, string>> },
    extra: Readonly<Record<string, string>> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": options.contentType ?? "application/octet-stream",
      ...extra,
    };
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      headers[`x-amz-meta-${name.toLowerCase()}`] = value;
    }
    return headers;
  }

  private assertSinglePutSize(bytes: number): void {
    if (bytes > this.maxSinglePutBytes) {
      throw new S3RequestTooLargeError(bytes, this.maxSinglePutBytes, "S3 single PUT body");
    }
  }

  /**
   * 条件创建重试后遇到 412 时，用 HEAD（长度）＋ GET（SHA-256）证明目标就是
   * 本次要写的字节。超过单次 GET 上限时不做证明，调用方仍拿到原始 412。
   */
  private async proveObjectContent(key: string, body: ArrayBuffer): Promise<string | null> {
    if (body.byteLength > this.maxSingleGetBytes) return null;
    try {
      const head = await this.headObject(key);
      if (!head.exists || head.contentLength !== body.byteLength) return null;
      const fetched = await this.getObject(key);
      const [actual, expected] = await Promise.all([sha256Hex(fetched.body), sha256Hex(body)]);
      return actual === expected ? head.eTag : null;
    } catch {
      return null;
    }
  }

  private parseXmlResponse(
    response: S3HttpResponse,
    operation: string,
    expectedRoot: string,
  ): XmlElement {
    let root: XmlElement;
    try {
      root = parseXml(decodeXmlBytes(response.body));
    } catch (error) {
      if (error instanceof Error) {
        throw s3ProtocolError(`${operation} returned invalid XML: ${error.message}`);
      }
      throw error;
    }
    if (root.localName !== expectedRoot) {
      throw s3ProtocolError(`${operation} returned <${root.localName}>, expected <${expectedRoot}>`);
    }
    return root;
  }

  /**
   * 发送一次逻辑请求。重试只依据分类表的指令与 `retryable`，条件头在每次
   * 尝试中原样保留；任何一次尝试的歧义（网络错误／5xx）会标记到最终错误上。
   */
  private async send(plan: RequestPlan): Promise<S3HttpResponse> {
    const address = resolveS3Address(
      this.config.endpoint,
      this.config.bucket,
      plan.key,
      this.config.addressingStyle ?? "auto",
      plan.query,
    );
    let credentials = this.config.credentials;
    let request = await this.buildRequest(plan, address, credentials);
    let ambiguousPreviousAttempt = false;
    let authRefreshed = false;
    let lastError: S3Error | null = null;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      const response = await this.config.transport(request);
      const expected = plan.expectedStatuses.includes(response.status);
      if (expected && (response.status < 200 || response.status > 299)) {
        // 预期的负向状态只应是「对象不存在」或「Abort 的 NoSuchUpload」。
        // HEAD 的 404 没有响应体；若带错误体且不是 NoSuchUpload，不能当成功吞掉。
        const negativeText = response.body.byteLength === 0 ? "" : decodeText(response.body);
        const negative = negativeText.length === 0
          ? null
          : s3ErrorFromResponse({
            status: response.status,
            bodyText: negativeText,
            headers: response.headers,
            now: this.config.now?.(),
          });
        if (negative && negative.code.length > 0 && negative.code !== "NoSuchUpload") {
          throw negative;
        }
        return response;
      }
      const bodyText = response.body.byteLength === 0 ? "" : decodeText(response.body);
      // 2xx 的内嵌 <Error> 只在控制面响应上检查；下载对象的正文可能是任意
      // XML，不能被误判。4xx／5xx 的错误体则始终解析。
      const embedded = expected && plan.checkEmbeddedError !== false
        ? this.successBodyError(response.status, bodyText)
        : null;
      if (expected && !embedded) return response;
      const error = embedded ?? this.responseError(response, bodyText);
      lastError = error;

      if (error.retry === "after-auth-refresh" && !authRefreshed && this.config.refreshCredentials) {
        authRefreshed = true;
        try {
          credentials = await this.config.refreshCredentials();
          request = await this.buildRequest(plan, address, credentials);
          continue;
        } catch {
          break;
        }
      }
      if (attempt >= this.retry.maxAttempts || !plan.retryable || error.retry === "none") break;
      if (error.type === OneDriveErrorType.NetworkError || error.type === OneDriveErrorType.ServerError) {
        ambiguousPreviousAttempt = true;
      }
      const delay = error.retry === "respect-retry-after" && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : this.backoffDelay(attempt);
      if (delay > 0) await this.retry.sleep(delay);
    }

    if (lastError) {
      throw ambiguousPreviousAttempt ? lastError.withAmbiguousPreviousAttempt() : lastError;
    }
    throw s3ProtocolError(`${plan.operation} failed without a response`);
  }

  private async buildRequest(
    plan: RequestPlan,
    address: S3Address,
    credentials: AwsCredentials,
  ): Promise<S3HttpRequest> {
    const signed = await signS3Request({
      method: plan.method,
      host: address.host,
      path: address.path,
      query: plan.query,
      headers: plan.headers,
      body: plan.body,
      region: this.config.region,
      credentials,
      now: this.config.now?.(),
    });
    return {
      method: plan.method,
      url: address.url,
      headers: signed.headers,
      body: plan.body,
      deadlineMs: this.deadlineMs,
    };
  }

  private successBodyError(status: number, bodyText: string): S3Error | null {
    if (bodyText.trim().length === 0) return null;
    return s3ErrorFromResponse({ status, bodyText, now: this.config.now?.() });
  }

  private responseError(response: S3HttpResponse, bodyText: string): S3Error {
    return (
      s3ErrorFromResponse({
        status: response.status,
        bodyText,
        headers: response.headers,
        now: this.config.now?.(),
      }) ??
      new S3Error(
        classifyS3Response({
          status: response.status,
          bodyText,
          headers: response.headers,
          now: this.config.now?.(),
        }),
      )
    );
  }

  private backoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.retry.backoffBaseMs * 2 ** (attempt - 1),
      this.retry.maxBackoffMs,
    );
    return Math.max(0, Math.floor(exponential + this.retry.random() * this.retry.backoffBaseMs));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    compatSetTimeout(resolve, ms);
  });
}

function decodeText(body: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(body);
}

function percentDecodeUtf8(value: string): string {
  try {
    // S3 兼容产品（实测 MinIO）用 form-urlencoded 语义把空格编码成 `+`；
    // AWS 文档的示例常用 `%20`。两者都还原成空格；字面量 `+` 应为 `%2B`。
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    throw s3ProtocolError("ListObjectsV2 returned a key with invalid percent encoding");
  }
}

function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());
  if (!match) return null;
  return {
    start: Number.parseInt(match[1], 10),
    end: Number.parseInt(match[2], 10),
    total: match[3] === "*" ? null : Number.parseInt(match[3], 10),
  };
}

/** `x-amz-copy-source`：`/bucket/key`，逐段 URI 编码并保留 `/`。 */
export function encodeCopySource(bucket: string, key: string): string {
  return `/${encodeRfc3986(bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`;
}

function assertPartNumber(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MULTIPART_MAX_PARTS) {
    throw s3ProtocolError(
      `S3 multipart part number must be an integer in 1..${MULTIPART_MAX_PARTS}, got ${partNumber}`,
    );
  }
}

/** 宽松校验：只在调用方提供了 size 时检查「非最后一块至少 5 MiB」。 */
export function validateMultipartPartSizes(parts: readonly S3MultipartPart[]): void {
  for (let index = 0; index < parts.length - 1; index += 1) {
    const size = parts[index].size;
    if (size !== undefined && size < MULTIPART_PART_MIN_BYTES) {
      throw s3ProtocolError(
        `S3 multipart part ${parts[index].partNumber} is ${size} bytes; non-final parts must be at least ${MULTIPART_PART_MIN_BYTES} bytes`,
      );
    }
  }
}

function normalizeParts(parts: readonly S3MultipartPart[]): S3MultipartPart[] {
  if (parts.length === 0) throw s3ProtocolError("CompleteMultipartUpload requires at least one part");
  const seen = new Set<number>();
  const normalized = [...parts].sort((left, right) => left.partNumber - right.partNumber);
  for (const part of normalized) {
    assertPartNumber(part.partNumber);
    if (seen.has(part.partNumber)) {
      throw s3ProtocolError(`Duplicate S3 multipart part number ${part.partNumber}`);
    }
    seen.add(part.partNumber);
    if (!part.eTag || part.eTag.trim().length === 0) {
      throw s3ProtocolError(`S3 multipart part ${part.partNumber} is missing its ETag`);
    }
  }
  validateMultipartPartSizes(normalized);
  return normalized;
}

function completeMultipartXml(parts: readonly S3MultipartPart[]): string {
  const body = parts
    .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXmlText(part.eTag)}</ETag></Part>`)
    .join("");
  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** multipart ETag 形如 `md5-of-md5s-N`；只用于条件比较，永不当作内容哈希。 */
export function isMultipartETag(eTag: string): boolean {
  return /^"[0-9a-f]{32}-\d+"$/i.test(eTag);
}
