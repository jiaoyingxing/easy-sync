/**
 * WebDAV 响应 → 中性错误分类（W1 后续切片）。
 *
 * 分类表逐行对应设计 §13.2；本模块只做分类，不发请求、不重试、不决定
 * 用户可见文案。`RemoteErrorType` 沿用 B3 的 12 类词汇，额外状态码信息
 * 放在 `statusCode` 与 `graphCode`（中性含义：provider 稳定错误码）。
 *
 * 两个原则：
 * - 只有 2xx 是成功；207 只属于 PROPFIND，由调用方判断。
 * - 423 与 409 都按 Conflict 分类，但保留不同 code，便于上层提示「被锁」
 *   而不是「父集合缺失」。
 */
import { RemoteError, RemoteErrorType } from "../../remote/errors";

export type WebDavRetryDirective = "none" | "backoff" | "respect-retry-after";

export interface WebDavErrorClassification {
  readonly type: RemoteErrorType;
  /** 稳定错误码；不把响应体 HTML 当错误码。 */
  readonly code: string;
  readonly status: number;
  readonly retry: WebDavRetryDirective;
  readonly retryAfterSeconds: number | null;
  /** 开发向消息；用户可见文案由上层按 type／code 生成。 */
  readonly message: string;
}

export interface WebDavErrorResponseInput {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyText?: string;
  readonly now?: Date;
}

/** 2xx 成功；WebDAV 的 207 只在 PROPFIND 语境下由调用方接受。 */
export function isWebDavSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** MOVE 的成功码是 201／204（设计 §13.2）；200 不算。 */
export function isWebDavMoveSuccessStatus(status: number): boolean {
  return status === 201 || status === 204;
}

/** MKCOL 的「已存在」兼容形态：严格服务器 405，部分服务器回 201。 */
export function isWebDavCollectionExistsStatus(status: number): boolean {
  return status === 201 || status === 204 || status === 405;
}

/** 坚果云等 WebDAV 服务的临时封禁体：状态仍是 503，但语义是限流。 */
const BLOCKED_TEMPORARILY_BODY_PATTERN =
  /BlockedTemporarily|Too many requests are received recently/i;

/**
 * 503 限流体通常不带 `Retry-After`。坚果云免费版是 600 次/30 分钟，
 * 这里用 30 分钟作为保守冷却；有 `Retry-After` 时仍以响应头为准。
 */
const BLOCKED_TEMPORARILY_DEFAULT_RETRY_AFTER_SECONDS = 30 * 60;

function isBlockedTemporarilyResponse(
  status: number,
  bodyText: string | undefined,
): boolean {
  return status === 503
    && typeof bodyText === "string"
    && BLOCKED_TEMPORARILY_BODY_PATTERN.test(bodyText);
}

/** 分类一个 HTTP 状态；0 表示传输层失败／超时。 */
export function classifyWebDavResponse(
  input: WebDavErrorResponseInput,
): WebDavErrorClassification {
  const status = Number.isFinite(input.status) ? input.status : 0;
  const blockedTemporarily = isBlockedTemporarilyResponse(status, input.bodyText);
  const code = blockedTemporarily
    ? "webdav-blocked-temporarily"
    : webDavErrorCode(status);
  const parsedRetryAfter = parseWebDavRetryAfter(
    headerValue(input.headers, "retry-after"),
    input.now ?? new Date(),
  );
  const retryAfterSeconds = blockedTemporarily && parsedRetryAfter === null
    ? BLOCKED_TEMPORARILY_DEFAULT_RETRY_AFTER_SECONDS
    : parsedRetryAfter;
  const mapped = blockedTemporarily ? RemoteErrorType.RateLimited : statusType(status);
  const retry = mapped === RemoteErrorType.RateLimited
    ? "respect-retry-after"
    : status === 0 || status === 408 || status >= 500
      ? "backoff"
      : "none";
  return {
    type: mapped,
    code,
    status,
    retry,
    retryAfterSeconds,
    message: `WebDAV request failed with HTTP ${status}${code.length > 0 ? ` (${code})` : ""}`,
  };
}

/** 把分类结果折成中性 `RemoteError`，供引擎既有错误路由消费。 */
export function webDavRemoteError(input: WebDavErrorResponseInput): RemoteError {
  const classification = classifyWebDavResponse(input);
  return new RemoteError(
    classification.type,
    classification.message,
    classification.status,
    classification.retryAfterSeconds,
    classification.code,
  );
}

/** `Retry-After` 支持秒数与 HTTP 日期两种形态；无效值返回 null。 */
export function parseWebDavRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return null;
  const seconds = Math.ceil((date - now.getTime()) / 1000);
  return seconds > 0 ? seconds : 0;
}

function statusType(status: number): RemoteErrorType {
  switch (status) {
    case 401:
      return RemoteErrorType.AuthExpired;
    case 403:
      return RemoteErrorType.Forbidden;
    case 404:
      return RemoteErrorType.NotFound;
    case 405:
      // 方法不允许＝服务器能力缺陷，不做普通失败重试。
      return RemoteErrorType.Unknown;
    case 409:
      return RemoteErrorType.Conflict;
    case 412:
      return RemoteErrorType.PreconditionFailed;
    case 416:
      return RemoteErrorType.RangeNotSatisfiable;
    case 423:
      return RemoteErrorType.Conflict;
    case 429:
      return RemoteErrorType.RateLimited;
    case 507:
      return RemoteErrorType.InsufficientStorage;
    case 0:
    case 408:
      return RemoteErrorType.NetworkError;
    default:
      return status >= 500 ? RemoteErrorType.ServerError : RemoteErrorType.Unknown;
  }
}

function webDavErrorCode(status: number): string {
  switch (status) {
    case 401:
      return "authentication-required";
    case 405:
      return "method-not-allowed";
    case 423:
      return "locked";
    default:
      return status === 0 ? "network-error" : `http-${status}`;
  }
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}
