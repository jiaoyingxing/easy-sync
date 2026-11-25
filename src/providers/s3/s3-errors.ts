/**
 * S3 HTTP／XML 错误 → 中性错误分类。
 *
 * 错误词汇复用 `RemoteErrorType` 的 12 类（B3 后挂中性基类），分类表与设计
 * §5.3 固定表逐行对应。两条容易踩的规则在这里集中处理：
 *
 * - `200` 不代表成功：COPY／Complete 可能在 200 响应体里返回 `<Error>`，
 *   必须解析内层 code；
 * - `DELETE` 对不存在的 key 也返回 204，所以 204 不能作为「删掉了预期对象」
 *   的证据——这一条由客户端用 HEAD 复核，不在此模块判断。
 *
 * 本模块只做分类，不发请求，也不重试。
 */
import { RemoteErrorType } from "../../remote/errors";
import { findChild, parseXml, XmlParseError } from "../xml";

/** 重试指令。`after-auth-refresh` 表示先刷新临时凭据再重试一次。 */
export type S3RetryDirective = "none" | "backoff" | "respect-retry-after" | "after-auth-refresh";

export interface S3ErrorClassification {
  readonly type: RemoteErrorType;
  /** S3 错误码；没有响应体时为空串。 */
  readonly code: string;
  readonly status: number;
  readonly retry: S3RetryDirective;
  readonly retryAfterMs?: number;
  /** 开发向消息；用户可见文案由上层按 `type`／`code` 生成。 */
  readonly message: string;
}

export interface S3ErrorResponseInput {
  readonly status: number;
  readonly bodyText?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly now?: Date;
}

interface CodeRule {
  readonly type: RemoteErrorType;
  readonly retry: S3RetryDirective;
}

const CODE_RULES: Readonly<Record<string, CodeRule>> = Object.freeze({
  PermanentRedirect: { type: RemoteErrorType.Unknown, retry: "none" },
  AuthorizationHeaderMalformed: { type: RemoteErrorType.Forbidden, retry: "none" },
  XAmzContentSHA256Mismatch: { type: RemoteErrorType.Unknown, retry: "none" },
  AccessDenied: { type: RemoteErrorType.Forbidden, retry: "none" },
  SignatureDoesNotMatch: { type: RemoteErrorType.Forbidden, retry: "none" },
  InvalidAccessKeyId: { type: RemoteErrorType.Forbidden, retry: "none" },
  RequestTimeTooSkewed: { type: RemoteErrorType.Forbidden, retry: "none" },
  ExpiredToken: { type: RemoteErrorType.AuthExpired, retry: "after-auth-refresh" },
  TokenRefreshRequired: { type: RemoteErrorType.AuthExpired, retry: "after-auth-refresh" },
  NoSuchKey: { type: RemoteErrorType.NotFound, retry: "none" },
  NoSuchBucket: { type: RemoteErrorType.Unknown, retry: "none" },
  NoSuchUpload: { type: RemoteErrorType.NotFound, retry: "none" },
  ConditionalRequestConflict: { type: RemoteErrorType.Conflict, retry: "backoff" },
  PreconditionFailed: { type: RemoteErrorType.PreconditionFailed, retry: "none" },
  InvalidRange: { type: RemoteErrorType.RangeNotSatisfiable, retry: "none" },
  SlowDown: { type: RemoteErrorType.RateLimited, retry: "respect-retry-after" },
  ServiceUnavailable: { type: RemoteErrorType.ServerError, retry: "backoff" },
  InternalError: { type: RemoteErrorType.ServerError, retry: "backoff" },
  InvalidArgument: { type: RemoteErrorType.Unknown, retry: "none" },
  InvalidPart: { type: RemoteErrorType.Unknown, retry: "none" },
  EntityTooLarge: { type: RemoteErrorType.Unknown, retry: "none" },
  KeyTooLongError: { type: RemoteErrorType.Unknown, retry: "none" },
});

/** 解析 S3 `<Error>` 响应体；非 Error 根或无法解析时返回 null。 */
export function parseS3ErrorBody(bodyText: string): { code: string; message: string } | null {
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("<")) return null;
  try {
    const root = parseXml(trimmed);
    if (root.localName !== "Error") return null;
    const code = findChild(root, "Code")?.text.trim() ?? "";
    const message = findChild(root, "Message")?.text.trim() ?? "";
    return { code, message };
  } catch (error) {
    if (error instanceof XmlParseError) return null;
    throw error;
  }
}

/** 分类一个 HTTP 响应（4xx／5xx 或 2xx 内嵌 Error）。 */
export function classifyS3Response(input: S3ErrorResponseInput): S3ErrorClassification {
  const parsed = input.bodyText ? parseS3ErrorBody(input.bodyText) : null;
  const code = parsed?.code ?? "";
  if (code.length > 0) {
    const rule = CODE_RULES[code];
    if (rule) {
      return {
        type: rule.type,
        code,
        status: input.status,
        retry: rule.retry,
        retryAfterMs: rule.retry === "respect-retry-after"
          ? parseRetryAfterMs(headerValue(input.headers, "retry-after"), input.now)
          : undefined,
        message: parsed?.message || `S3 error ${code} (HTTP ${input.status})`,
      };
    }
    return {
      type: statusFallbackType(input.status),
      code,
      status: input.status,
      retry: statusFallbackRetry(input.status),
      retryAfterMs: parseRetryAfterMs(headerValue(input.headers, "retry-after"), input.now),
      message: parsed?.message || `S3 error ${code} (HTTP ${input.status})`,
    };
  }
  return {
    type: statusFallbackType(input.status),
    code: "",
    status: input.status,
    retry: input.status >= 500 || input.status === 0 ? "backoff" : "none",
    retryAfterMs: parseRetryAfterMs(headerValue(input.headers, "retry-after"), input.now),
    message: `S3 request failed with HTTP ${input.status}`,
  };
}

function statusFallbackType(status: number): RemoteErrorType {
  if (status === 0) return RemoteErrorType.NetworkError;
  if (status === 401) return RemoteErrorType.Unauthorized;
  if (status === 403) return RemoteErrorType.Forbidden;
  if (status === 404) return RemoteErrorType.NotFound;
  if (status === 409) return RemoteErrorType.Conflict;
  if (status === 412) return RemoteErrorType.PreconditionFailed;
  if (status === 416) return RemoteErrorType.RangeNotSatisfiable;
  if (status === 429) return RemoteErrorType.RateLimited;
  if (status === 507) return RemoteErrorType.InsufficientStorage;
  if (status >= 500 && status <= 599) return RemoteErrorType.ServerError;
  return RemoteErrorType.Unknown;
}

function statusFallbackRetry(status: number): S3RetryDirective {
  if (status === 0) return "backoff";
  if (status === 409) return "backoff";
  if (status === 429) return "respect-retry-after";
  if (status >= 500 && status <= 599) return "backoff";
  return "none";
}

/** 解析 `Retry-After`：秒数或 HTTP-date；非法／过去值返回 undefined。 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/** 响应头不区分大小写。 */
export function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** 带分类字段的 S3 错误。`ambiguousPreviousAttempt` 用于条件写的重试安全提示。 */
export class S3Error extends Error {
  readonly type: RemoteErrorType;
  readonly code: string;
  readonly status: number;
  readonly retry: S3RetryDirective;
  readonly retryAfterMs: number | undefined;
  readonly ambiguousPreviousAttempt: boolean;

  constructor(classification: S3ErrorClassification, options: { ambiguousPreviousAttempt?: boolean } = {}) {
    super(classification.message);
    this.name = "S3Error";
    this.type = classification.type;
    this.code = classification.code;
    this.status = classification.status;
    this.retry = classification.retry;
    this.retryAfterMs = classification.retryAfterMs;
    this.ambiguousPreviousAttempt = options.ambiguousPreviousAttempt === true;
  }

  get retryable(): boolean {
    return this.retry !== "none";
  }

  withAmbiguousPreviousAttempt(): S3Error {
    if (this.ambiguousPreviousAttempt) return this;
    return new S3Error(
      {
        type: this.type,
        code: this.code,
        status: this.status,
        retry: this.retry,
        retryAfterMs: this.retryAfterMs,
        message: this.message,
      },
      { ambiguousPreviousAttempt: true },
    );
  }
}

/** 把响应变成错误；成功响应（且无内嵌 Error）返回 null。 */
export function s3ErrorFromResponse(input: S3ErrorResponseInput): S3Error | null {
  if (input.status >= 200 && input.status <= 299) {
    const parsed = input.bodyText ? parseS3ErrorBody(input.bodyText) : null;
    if (!parsed || parsed.code.length === 0) return null;
    return new S3Error(classifyS3Response(input));
  }
  return new S3Error(classifyS3Response(input));
}

/** 上层能力/配置问题，不是服务端响应。 */
export class S3UnsupportedOperationError extends Error {
  readonly capability: string;

  constructor(message: string, capability: string) {
    super(message);
    this.name = "S3UnsupportedOperationError";
    this.capability = capability;
  }
}

/** 单次请求大小超过客户端安全阈值。 */
export class S3RequestTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number, label: string) {
    super(`${label} is ${bytes} bytes, above the client limit of ${limit} bytes`);
    this.name = "S3RequestTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** 协议响应不合法（缺元素、截断、非预期根元素）。 */
export function s3ProtocolError(message: string): S3Error {
  return new S3Error({
    type: RemoteErrorType.Unknown,
    code: "ProtocolError",
    status: 0,
    retry: "none",
    message,
  });
}
