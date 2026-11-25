/**
 * AWS Signature Version 4（S3 用）的纯函数实现。
 *
 * 约束（设计 §5.3）：
 * - 规范 URI 逐段编码、保留 `/`、不双重编码；
 * - 规范查询串按编码后的 key 排序，同名多值再按 value 排序；
 * - 规范头名字小写、值去首尾空白并把连续空白压成单空格、按名排序；
 * - 必须签 `host`、`x-amz-content-sha256`、`x-amz-date`；
 * - payload 默认使用真实 SHA-256（空体用标准空哈希常量）。
 *
 * 本模块无 IO；HMAC 走 WebCrypto，与 `src/crypto.ts` 的平台假设一致。签名
 * 正确性由 AWS 官方向量单测证明，fake 不重算签名。
 */
import { sha256Hex } from "../../crypto";

export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const AWS_SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";

/** 调用方凭据。`sessionToken` 只用于临时凭据，会作为 `x-amz-security-token` 签名。 */
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** 查询参数：raw key/value，编码与排序由本模块负责。 */
export type QueryPairs = ReadonlyArray<readonly [string, string]>;

/** 签名输入。`path` 是未编码的原始路径，必须以 `/` 开头。 */
export interface SignS3RequestInput {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query?: string | QueryPairs;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: ArrayBuffer;
  readonly region: string;
  readonly service?: string;
  readonly credentials: AwsCredentials;
  /** 固定签名时间（测试用）；缺省取 `now` 或当前时间。 */
  readonly amzDate?: string;
  readonly now?: Date;
}

export interface SignedS3Request {
  /** 可直接交给传输层的头（`authorization` 在最后）。 */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
  readonly amzDate: string;
  readonly payloadHash: string;
  readonly signedHeaders: readonly string[];
}

export interface CanonicalRequestInput {
  readonly method: string;
  readonly path: string;
  readonly query?: string | QueryPairs;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly signedHeaders: readonly string[];
  readonly payloadHash: string;
}

/** RFC 3986 非保留字符以外的字节一律大写百分号编码。 */
export function encodeRfc3986(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = "";
  for (const byte of bytes) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e
    ) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

/**
 * 规范 URI：按 `/` 切段逐段编码后重新拼接。空段（连续 `/`、尾 `/`）保留，
 * 不做 RFC 3986 点段归一化——S3 的 key 里 `.`／`..` 是合法字符。
 */
export function canonicalUri(path: string): string {
  const normalized = path.length === 0 ? "/" : path;
  return normalized.split("/").map(encodeRfc3986).join("/");
}

/** 规范查询串：raw 输入 → 编码 → 按 key、value 排序 → `k=v` 连接。 */
export function canonicalQueryString(query: string | QueryPairs | undefined): string {
  const pairs: QueryPairs = typeof query === "string" ? parseRawQuery(query) : (query ?? []);
  const encoded = pairs.map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const);
  encoded.sort((left, right) => {
    if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
    if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
    return 0;
  });
  return encoded.map(([key, value]) => `${key}=${value}`).join("&");
}

function parseRawQuery(raw: string): Array<[string, string]> {
  const trimmed = raw.startsWith("?") ? raw.slice(1) : raw;
  if (trimmed.length === 0) return [];
  return trimmed.split("&").map((part) => {
    const equals = part.indexOf("=");
    if (equals < 0) return [part, ""];
    return [part.slice(0, equals), part.slice(equals + 1)];
  });
}

/** 规范头值：去首尾空白，连续空白压成单空格。 */
function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function lowerCaseHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const values: string[] = typeof value === "string" ? [value] : [...value];
    const existing = result.get(key);
    if (existing) existing.push(...values);
    else result.set(key, [...values]);
  }
  return result;
}

function headerLookup(headers: Map<string, string[]>, name: string): string {
  const values = headers.get(name);
  if (!values || values.length === 0) {
    throw new Error(`Signed header "${name}" is missing from the request`);
  }
  return values.map(normalizeHeaderValue).join(",");
}

/** 构造规范请求。调用方给出的 `signedHeaders` 必须与头集合逐项一致。 */
export function buildCanonicalRequest(input: CanonicalRequestInput): string {
  const headers = lowerCaseHeaders(input.headers);
  const signedHeaders = [...input.signedHeaders].map((name) => name.toLowerCase());
  const sortedSignedHeaders = [...new Set(signedHeaders)].sort();
  const canonicalHeaders = sortedSignedHeaders
    .map((name) => `${name}:${headerLookup(headers, name)}\n`)
    .join("");
  return [
    input.method.toUpperCase(),
    canonicalUri(input.path),
    canonicalQueryString(input.query),
    canonicalHeaders,
    sortedSignedHeaders.join(";"),
    input.payloadHash,
  ].join("\n");
}

/** 凭据范围：`YYYYMMDD/<region>/<service>/aws4_request`。 */
export function credentialScope(amzDate: string, region: string, service: string): string {
  const date = amzDate.slice(0, 8);
  if (!/^\d{8}$/.test(date)) {
    throw new Error(`Invalid x-amz-date "${amzDate}"`);
  }
  return `${date}/${region}/${service}/aws4_request`;
}

/** 待签串；内部对规范请求做 SHA-256。 */
export async function buildStringToSign(input: {
  readonly canonicalRequest: string;
  readonly amzDate: string;
  readonly region: string;
  readonly service?: string;
}): Promise<string> {
  const service = input.service ?? "s3";
  const canonicalHash = await sha256Hex(new TextEncoder().encode(input.canonicalRequest).buffer);
  return [
    AWS_SIGV4_ALGORITHM,
    input.amzDate,
    credentialScope(input.amzDate, input.region, service),
    canonicalHash,
  ].join("\n");
}

/** 签名密钥链：kDate → kRegion → kService → kSigning → signature。 */
export async function calculateSignature(input: {
  readonly stringToSign: string;
  readonly secretAccessKey: string;
  readonly amzDate: string;
  readonly region: string;
  readonly service?: string;
}): Promise<string> {
  const service = input.service ?? "s3";
  const date = input.amzDate.slice(0, 8);
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${input.secretAccessKey}`), date);
  const kRegion = await hmacSha256(kDate, input.region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = await hmacSha256(kSigning, input.stringToSign);
  return bytesToHex(signature);
}

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** `Date` → YYYYMMDDTHHMMSSZ（始终 UTC）。 */
export function formatAmzDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Cannot format an invalid date as x-amz-date");
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * 高层签名：补齐 `host`／`x-amz-date`／`x-amz-content-sha256`，返回可直接发送
 * 的头。除 `authorization`、`content-length`、`user-agent`、`expect` 之外的
 * 调用方头都会进入 SignedHeaders。
 */
export async function signS3Request(input: SignS3RequestInput): Promise<SignedS3Request> {
  if (!input.host || input.host.trim().length === 0) {
    throw new Error("S3 signing requires a host");
  }
  if (!input.region || input.region.trim().length === 0) {
    throw new Error("S3 signing requires a region");
  }
  if (!input.credentials.accessKeyId) {
    throw new Error("S3 signing requires an access key id");
  }
  const service = input.service ?? "s3";
  const amzDate = input.amzDate ?? formatAmzDate(input.now ?? new Date());
  const payloadHash = input.body
    ? await sha256Hex(input.body)
    : EMPTY_PAYLOAD_SHA256;
  const merged = new Map<string, string>();
  const provided = lowerCaseHeaders(input.headers ?? {});
  for (const [name, values] of provided) {
    merged.set(name, values.map(normalizeHeaderValue).join(","));
  }
  merged.set("host", input.host);
  merged.set("x-amz-date", amzDate);
  merged.set("x-amz-content-sha256", payloadHash);
  if (input.credentials.sessionToken) {
    merged.set("x-amz-security-token", input.credentials.sessionToken);
  }
  const excluded = new Set(["authorization", "content-length", "user-agent", "expect"]);
  const signedHeaders = [...merged.keys()].filter((name) => !excluded.has(name)).sort();
  const headersForSigning: Record<string, string> = {};
  for (const [name, value] of merged) headersForSigning[name] = value;
  const canonicalRequest = buildCanonicalRequest({
    method: input.method,
    path: input.path,
    query: input.query,
    headers: headersForSigning,
    signedHeaders,
    payloadHash,
  });
  const stringToSign = await buildStringToSign({ canonicalRequest, amzDate, region: input.region, service });
  const signature = await calculateSignature({
    stringToSign,
    secretAccessKey: input.credentials.secretAccessKey,
    amzDate,
    region: input.region,
    service,
  });
  const authorization = `${AWS_SIGV4_ALGORITHM} Credential=${input.credentials.accessKeyId}/${credentialScope(
    amzDate,
    input.region,
    service,
  )}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
  const headers: Record<string, string> = { ...headersForSigning, authorization };
  return { headers, canonicalRequest, stringToSign, signature, amzDate, payloadHash, signedHeaders };
}
