import { describe, expect, it } from "vitest";
import { RemoteErrorType } from "../src/remote/errors";
import {
  classifyWebDavResponse,
  isWebDavCollectionExistsStatus,
  isWebDavMoveSuccessStatus,
  isWebDavSuccessStatus,
  parseWebDavRetryAfter,
  webDavRemoteError,
} from "../src/providers/webdav/webdav-errors";

describe("WebDAV status classification (design §13.2)", () => {
  const cases: ReadonlyArray<readonly [number, RemoteErrorType, string]> = [
    [401, RemoteErrorType.AuthExpired, "authentication-required"],
    [403, RemoteErrorType.Forbidden, "http-403"],
    [404, RemoteErrorType.NotFound, "http-404"],
    [405, RemoteErrorType.Unknown, "method-not-allowed"],
    [409, RemoteErrorType.Conflict, "http-409"],
    [412, RemoteErrorType.PreconditionFailed, "http-412"],
    [416, RemoteErrorType.RangeNotSatisfiable, "http-416"],
    [423, RemoteErrorType.Conflict, "locked"],
    [429, RemoteErrorType.RateLimited, "http-429"],
    [507, RemoteErrorType.InsufficientStorage, "http-507"],
    [0, RemoteErrorType.NetworkError, "network-error"],
    [500, RemoteErrorType.ServerError, "http-500"],
    [400, RemoteErrorType.Unknown, "http-400"],
  ];

  it.each(cases)("HTTP %i maps to %s with code %s", (status, type, code) => {
    const classification = classifyWebDavResponse({ status });
    expect(classification.type).toBe(type);
    expect(classification.code).toBe(code);
    expect(classification.status).toBe(status);
  });

  it("429 and 5xx carry the retry directive; 4xx does not", () => {
    expect(classifyWebDavResponse({ status: 429 }).retry).toBe("respect-retry-after");
    expect(classifyWebDavResponse({ status: 500 }).retry).toBe("backoff");
    expect(classifyWebDavResponse({ status: 0 }).retry).toBe("backoff");
    expect(classifyWebDavResponse({ status: 412 }).retry).toBe("none");
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = new Date("2026-11-19T00:00:00Z");
    expect(parseWebDavRetryAfter("12", now)).toBe(12);
    expect(parseWebDavRetryAfter("Thu, 19 Nov 2026 00:00:10 GMT", now)).toBe(10);
    expect(parseWebDavRetryAfter("not-a-date", now)).toBeNull();
    expect(parseWebDavRetryAfter(null, now)).toBeNull();
  });

  it("folds into RemoteError with status, code and retry-after", () => {
    const error = webDavRemoteError({
      status: 429,
      headers: { "retry-after": "7" },
      now: new Date("2026-11-19T00:00:00Z"),
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.type).toBe(RemoteErrorType.RateLimited);
    expect(error.statusCode).toBe(429);
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.graphCode).toBe("http-429");
    expect(error.providerCode).toBe("http-429");
  });

  it("503 BlockedTemporarily 归入限流，并给保守冷却", () => {
    const bodyText = `<?xml version="1.0" encoding="UTF-8"?>
      <d:error xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com">
        <s:exception>BlockedTemporarily</s:exception>
        <s:message>Too many requests are received recently</s:message>
      </d:error>`;
    const classification = classifyWebDavResponse({ status: 503, bodyText });
    expect(classification.type).toBe(RemoteErrorType.RateLimited);
    expect(classification.code).toBe("webdav-blocked-temporarily");
    expect(classification.retry).toBe("respect-retry-after");
    expect(classification.retryAfterSeconds).toBe(30 * 60);

    const withHeader = classifyWebDavResponse({
      status: 503,
      bodyText,
      headers: { "retry-after": "11" },
      now: new Date("2026-11-19T00:00:00Z"),
    });
    expect(withHeader.retryAfterSeconds).toBe(11);

    const error = webDavRemoteError({ status: 503, bodyText });
    expect(error.type).toBe(RemoteErrorType.RateLimited);
    expect(error.statusCode).toBe(503);
    expect(error.retryAfterSeconds).toBe(30 * 60);
    expect(error.graphCode).toBe("webdav-blocked-temporarily");
  });

  it("普通 503 不冒充限流", () => {
    const classification = classifyWebDavResponse({ status: 503, bodyText: "upstream unavailable" });
    expect(classification.type).toBe(RemoteErrorType.ServerError);
    expect(classification.code).toBe("http-503");
    expect(classification.retry).toBe("backoff");
    expect(classification.retryAfterSeconds).toBeNull();
  });

  it("success, move and collection-exists predicates stay narrow", () => {
    expect(isWebDavSuccessStatus(200)).toBe(true);
    expect(isWebDavSuccessStatus(207)).toBe(true);
    expect(isWebDavSuccessStatus(299)).toBe(true);
    expect(isWebDavSuccessStatus(300)).toBe(false);
    expect(isWebDavMoveSuccessStatus(201)).toBe(true);
    expect(isWebDavMoveSuccessStatus(204)).toBe(true);
    expect(isWebDavMoveSuccessStatus(200)).toBe(false);
    expect(isWebDavCollectionExistsStatus(201)).toBe(true);
    expect(isWebDavCollectionExistsStatus(405)).toBe(true);
    expect(isWebDavCollectionExistsStatus(409)).toBe(false);
  });
});
