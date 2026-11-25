import { describe, expect, it } from "vitest";
import {
  RemoteError,
  RemoteErrorType,
  type RemoteProviderErrorDetail,
} from "../src/remote/errors";
import {
  OneDriveError,
  OneDriveErrorType,
  RemoteVaultScopeIdentityError,
} from "../src/onedrive/types";
import { ResponseByteBudgetError } from "../src/onedrive/client";
import { AuthError, AuthErrorType } from "../src/auth/types";
import {
  isAuthFailure,
  isDeltaStateInvalid,
  isDefinitiveRestoreAbsence,
  isNetworkClassFailure,
  isRemoteMutationConflict,
  isRetryableMutationRecoveryObservationError,
  remoteScopeLossReason,
  throttleRetryAfter,
} from "../src/sync/sync-executor";

type RoutingVector = {
  auth: boolean;
  net: boolean;
  throttle: number | null;
  retryMut: boolean;
  conflict: boolean;
  absent: boolean;
  delta: boolean;
  scope: string | null;
};

function route(error: unknown): RoutingVector {
  const throttle = throttleRetryAfter(error);
  return {
    auth: isAuthFailure(error),
    net: isNetworkClassFailure(error),
    throttle: throttle === null ? null : throttle.retryAfterSeconds,
    retryMut: isRetryableMutationRecoveryObservationError(error),
    conflict: isRemoteMutationConflict(error as RemoteError),
    absent: isDefinitiveRestoreAbsence(error),
    delta: isDeltaStateInvalid(error),
    scope: remoteScopeLossReason(error),
  };
}

type MatrixRow = {
  type: RemoteErrorType;
  status: number;
  graphCode: string | null;
  retryAfterSeconds?: number;
  expected: RoutingVector;
};

/** Expected values come from the B3 design matrix: each predicate keeps its
 *  own set; they must never collapse into a shared isTransient/isNotFound. */
const MATRIX: MatrixRow[] = [
  {
    type: RemoteErrorType.NetworkError,
    status: 0,
    graphCode: null,
    expected: {
      auth: false,
      net: true,
      throttle: null,
      retryMut: true,
      conflict: false,
      absent: false,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.RateLimited,
    status: 429,
    graphCode: null,
    retryAfterSeconds: 7,
    expected: {
      auth: false,
      net: false,
      throttle: 7,
      retryMut: true,
      conflict: false,
      absent: false,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.ServerError,
    status: 500,
    graphCode: null,
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: true,
      conflict: false,
      absent: false,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.PreconditionFailed,
    status: 412,
    graphCode: null,
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: true,
      absent: false,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.Conflict,
    status: 409,
    graphCode: null,
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: true,
      absent: false,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.NotFound,
    status: 404,
    graphCode: null,
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: true,
      absent: true,
      delta: true,
      scope: "graph-not-found",
    },
  },
  {
    type: RemoteErrorType.Forbidden,
    status: 403,
    graphCode: null,
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: false,
      absent: true,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.AuthExpired,
    status: 401,
    graphCode: null,
    expected: {
      auth: true,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: false,
      absent: false,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.Unknown,
    status: 408,
    graphCode: null,
    expected: {
      auth: false,
      net: true,
      throttle: null,
      retryMut: false,
      conflict: false,
      absent: false,
      delta: false,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.Unknown,
    status: 400,
    graphCode: "resyncRequired",
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: false,
      absent: false,
      delta: true,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.Unknown,
    status: 0,
    graphCode: "syncStateNotFound",
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: false,
      absent: false,
      delta: true,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.Unknown,
    status: 0,
    graphCode: "invalidSyncState",
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: false,
      absent: false,
      delta: true,
      scope: null,
    },
  },
  {
    type: RemoteErrorType.Unknown,
    status: 0,
    graphCode: null,
    expected: {
      auth: false,
      net: false,
      throttle: null,
      retryMut: false,
      conflict: false,
      absent: false,
      delta: false,
      scope: null,
    },
  },
];

function remoteErrorFor(row: MatrixRow, message = "boom"): RemoteError {
  return new RemoteError(
    row.type,
    message,
    row.status,
    row.retryAfterSeconds ?? null,
    row.graphCode,
  );
}

function oneDriveErrorFor(row: MatrixRow, message = "boom"): OneDriveError {
  return new OneDriveError(
    row.type,
    message,
    row.status,
    row.retryAfterSeconds ?? null,
    row.graphCode,
  );
}

describe("remote error routing (B3 neutral base)", () => {
  it("keeps the 12 remote error type values byte-identical", () => {
    expect(Object.values(RemoteErrorType)).toEqual([
      "Unauthorized",
      "Forbidden",
      "NotFound",
      "Conflict",
      "RateLimited",
      "InsufficientStorage",
      "ServerError",
      "NetworkError",
      "AuthExpired",
      "PreconditionFailed",
      "RangeNotSatisfiable",
      "Unknown",
    ]);
  });

  it("keeps the 7-parameter constructor semantics and provider-code precedence", () => {
    const detail: RemoteProviderErrorDetail = {
      code: "itemNotFound",
      message: "graph detail message",
      innerCode: "inner-code",
      requestId: "request-1",
      date: "2026-11-18T00:00:00Z",
    };
    const error = new RemoteError(
      RemoteErrorType.NotFound,
      "not found",
      404,
      3,
      "fallback-code",
      detail,
      5000,
    );
    expect(error.name).toBe("RemoteError");
    expect(error.type).toBe(RemoteErrorType.NotFound);
    expect(error.message).toBe("not found");
    expect(error.statusCode).toBe(404);
    expect(error.retryAfterSeconds).toBe(3);
    expect(error.graphCode).toBe("itemNotFound");
    expect(error.providerCode).toBe("itemNotFound");
    expect(error.graphError).toBe(detail);
    expect(error.providerError).toBe(detail);
    expect(error.graphMessage).toBe("graph detail message");
    expect(error.graphInnerCode).toBe("inner-code");
    expect(error.graphRequestId).toBe("request-1");
    expect(error.requestTimeoutMs).toBe(5000);

    const defaults = new RemoteError(RemoteErrorType.Unknown, "bare");
    expect(defaults.statusCode).toBe(0);
    expect(defaults.retryAfterSeconds).toBeNull();
    expect(defaults.graphCode).toBeNull();
    expect(defaults.graphError).toBeNull();
    expect(defaults.requestTimeoutMs).toBeNull();

    // `??` precedence: an empty provider code is kept, never replaced by the
    // explicit fallback argument.
    const emptyCode = new RemoteError(
      RemoteErrorType.Unknown,
      "empty code",
      0,
      null,
      "fallback-code",
      {
        code: "",
        message: "",
        innerCode: null,
        requestId: null,
        date: null,
      },
    );
    expect(emptyCode.graphCode).toBe("");
    expect(emptyCode.providerCode).toBe("");
  });

  it("keeps OneDriveError as a RemoteError with its historical name", () => {
    const error = new OneDriveError(RemoteErrorType.ServerError, "boom", 500);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toBeInstanceOf(OneDriveError);
    expect(error.name).toBe("OneDriveError");
    expect(OneDriveErrorType).toBe(RemoteErrorType);
    expect(new RemoteError(RemoteErrorType.ServerError, "boom", 500).name)
      .toBe("RemoteError");
  });

  it("keeps ResponseByteBudgetError a RemoteError with type Unknown", () => {
    const error = new ResponseByteBudgetError("label", 10, 11, "observed");
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toBeInstanceOf(OneDriveError);
    expect(error.type).toBe(RemoteErrorType.Unknown);
    expect(error.kind).toBe("observed");
    expect(error.name).toBe("ResponseByteBudgetError");
  });

  it("distinguishes a rate limit without a usable Retry-After from a non-rate-limit", () => {
    // `null` 表示"不是限流"；限流但没有可用的 Retry-After 头仍然是限流信号，
    // 上传池要据此降并发（用自己的回退值），所以两者不能混为一个 null。
    expect(throttleRetryAfter(new RemoteError(RemoteErrorType.RateLimited, "x", 429)))
      .toEqual({ retryAfterSeconds: null });
    expect(throttleRetryAfter(new RemoteError(RemoteErrorType.RateLimited, "x", 429, -1)))
      .toEqual({ retryAfterSeconds: null });
    expect(throttleRetryAfter(new RemoteError(RemoteErrorType.NetworkError, "x")))
      .toBeNull();
  });

  it("routes the full predicate matrix by type fields, not by message text", () => {
    for (const row of MATRIX) {
      for (const message of ["HTTP 500", "boom", ""]) {
        expect(route(remoteErrorFor(row, message)), `${row.type}/${row.status}/${row.graphCode} message=${JSON.stringify(message)}`)
          .toEqual(row.expected);
      }
    }
  });

  it("keeps AuthError separate from RemoteError", () => {
    const revoked = new AuthError(AuthErrorType.CredentialsRevoked, "x");
    const network = new AuthError(AuthErrorType.NetworkError, "x");
    expect(isAuthFailure(revoked)).toBe(true);
    expect(isAuthFailure(network)).toBe(false);
    expect(isNetworkClassFailure(network)).toBe(true);
    expect(revoked).not.toBeInstanceOf(RemoteError);
    expect(network).not.toBeInstanceOf(RemoteError);
  });

  it("keeps RemoteVaultScopeIdentityError as its own scope-loss reason", () => {
    const error = new RemoteVaultScopeIdentityError("drive-invalid");
    expect(remoteScopeLossReason(error)).toBe("drive-invalid");
    expect(isAuthFailure(error)).toBe(false);
    expect(error).not.toBeInstanceOf(RemoteError);
  });

  it("keeps OneDriveError and RemoteError identical for the same fields", () => {
    for (const row of MATRIX) {
      expect(route(oneDriveErrorFor(row)), `${row.type}/${row.status}/${row.graphCode}`)
        .toEqual(route(remoteErrorFor(row)));
    }
  });
});
