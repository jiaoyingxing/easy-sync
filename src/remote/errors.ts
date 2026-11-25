/**
 * Provider-neutral remote error vocabulary.
 *
 * Zero imports: this module is the base every provider error type hangs off,
 * so it must stay usable from the cold-start path and from provider modules
 * without pulling anything else in.
 */

/** Provider-stable error detail; field names keep the historical Graph shape,
 *  the semantics are provider-neutral. */
export type RemoteProviderErrorDetail = {
  code: string;
  message: string;
  innerCode: string | null;
  requestId: string | null;
  date: string | null;
};

/** 12 values, byte-identical to the historical OneDriveErrorType values. */
export enum RemoteErrorType {
  Unauthorized = "Unauthorized",
  Forbidden = "Forbidden",
  NotFound = "NotFound",
  Conflict = "Conflict",
  RateLimited = "RateLimited",
  InsufficientStorage = "InsufficientStorage",
  ServerError = "ServerError",
  NetworkError = "NetworkError",
  AuthExpired = "AuthExpired",
  PreconditionFailed = "PreconditionFailed",
  RangeNotSatisfiable = "RangeNotSatisfiable",
  Unknown = "Unknown",
}

/** Neutral remote error base class; fields and constructor arguments mirror
 *  the historical OneDriveError one-for-one. */
export class RemoteError extends Error {
  public readonly type: RemoteErrorType;
  public readonly statusCode: number;
  public readonly retryAfterSeconds: number | null;
  /** Historical name kept: the neutral meaning is "provider-stable error code". */
  public readonly graphCode: string | null;
  public readonly graphError: RemoteProviderErrorDetail | null;
  public readonly requestTimeoutMs: number | null;

  constructor(
    type: RemoteErrorType,
    message: string,
    statusCode: number = 0,
    retryAfterSeconds: number | null = null,
    graphCode: string | null = null,
    graphError: RemoteProviderErrorDetail | null = null,
    requestTimeoutMs: number | null = null,
  ) {
    super(message);
    this.name = "RemoteError";
    this.type = type;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.graphCode = graphError?.code ?? graphCode;
    this.graphError = graphError;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  get graphMessage(): string | null {
    return this.graphError?.message ?? null;
  }

  get graphInnerCode(): string | null {
    return this.graphError?.innerCode ?? null;
  }

  get graphRequestId(): string | null {
    return this.graphError?.requestId ?? null;
  }

  /** Neutral read alias; getters do not change the own-property shape. */
  get providerCode(): string | null {
    return this.graphCode;
  }

  get providerError(): RemoteProviderErrorDetail | null {
    return this.graphError;
  }
}
