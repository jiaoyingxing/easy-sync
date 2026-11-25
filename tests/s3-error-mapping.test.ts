import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OneDriveErrorType } from "../src/onedrive/types";
import {
  classifyS3Response,
  parseRetryAfterMs,
  s3ErrorFromResponse,
  type S3RetryDirective,
} from "../src/providers/s3/s3-errors";
import { S3Client } from "../src/providers/s3/s3-client";
import { FakeS3Server } from "./helpers/fake-s3";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * 错误映射合同：设计 §5.3 固定表每一行一个用例，断言中性分类与「是否重试」。
 * fake 侧再注入同样的状态／错误码，验证客户端真的按分类表行动（不是只有
 * 分类函数自测）。
 */
let fake: FakeS3Server;
let client: S3Client;
let endpoint = "";
const sleeps: number[] = [];

beforeAll(async () => {
  fake = new FakeS3Server();
  const started = await fake.start();
  endpoint = started.endpoint;
  expect(started.port).toBeGreaterThan(0);
  client = new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: fake.bucket,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    transport: createFetchS3Transport(),
    retry: {
      maxAttempts: 3,
      backoffBaseMs: 1,
      maxBackoffMs: 4,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  });
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
  sleeps.length = 0;
});

afterEach(() => {
  expect(fake.violations).toEqual([]);
});

function errorBody(code: string, message = "fake error"): string {
  return `<Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

interface TableRow {
  readonly status: number;
  readonly code: string;
  readonly type: OneDriveErrorType;
  readonly retry: S3RetryDirective;
}

const TABLE: readonly TableRow[] = [
  { status: 301, code: "PermanentRedirect", type: OneDriveErrorType.Unknown, retry: "none" },
  { status: 400, code: "AuthorizationHeaderMalformed", type: OneDriveErrorType.Forbidden, retry: "none" },
  { status: 400, code: "XAmzContentSHA256Mismatch", type: OneDriveErrorType.Unknown, retry: "none" },
  { status: 403, code: "AccessDenied", type: OneDriveErrorType.Forbidden, retry: "none" },
  { status: 403, code: "SignatureDoesNotMatch", type: OneDriveErrorType.Forbidden, retry: "none" },
  { status: 403, code: "InvalidAccessKeyId", type: OneDriveErrorType.Forbidden, retry: "none" },
  { status: 403, code: "RequestTimeTooSkewed", type: OneDriveErrorType.Forbidden, retry: "none" },
  { status: 403, code: "ExpiredToken", type: OneDriveErrorType.AuthExpired, retry: "after-auth-refresh" },
  { status: 403, code: "TokenRefreshRequired", type: OneDriveErrorType.AuthExpired, retry: "after-auth-refresh" },
  { status: 404, code: "NoSuchKey", type: OneDriveErrorType.NotFound, retry: "none" },
  { status: 404, code: "NoSuchBucket", type: OneDriveErrorType.Unknown, retry: "none" },
  { status: 409, code: "ConditionalRequestConflict", type: OneDriveErrorType.Conflict, retry: "backoff" },
  { status: 412, code: "PreconditionFailed", type: OneDriveErrorType.PreconditionFailed, retry: "none" },
  { status: 416, code: "InvalidRange", type: OneDriveErrorType.RangeNotSatisfiable, retry: "none" },
  { status: 429, code: "SlowDown", type: OneDriveErrorType.RateLimited, retry: "respect-retry-after" },
  { status: 500, code: "InternalError", type: OneDriveErrorType.ServerError, retry: "backoff" },
  { status: 503, code: "SlowDown", type: OneDriveErrorType.RateLimited, retry: "respect-retry-after" },
  { status: 503, code: "ServiceUnavailable", type: OneDriveErrorType.ServerError, retry: "backoff" },
];

describe("固定表分类", () => {
  for (const row of TABLE) {
    it(`${row.status} ${row.code} → ${row.type} / ${row.retry}`, () => {
      const error = s3ErrorFromResponse({ status: row.status, bodyText: errorBody(row.code) });
      expect(error).not.toBeNull();
      expect(error?.type).toBe(row.type);
      expect(error?.retry).toBe(row.retry);
      expect(error?.code).toBe(row.code);
      expect(error?.retryable).toBe(row.retry !== "none");
    });
  }

  it("0 网络／超时 → NetworkError 且退避重试", () => {
    const error = s3ErrorFromResponse({ status: 0 });
    expect(error?.type).toBe(OneDriveErrorType.NetworkError);
    expect(error?.retry).toBe("backoff");
  });

  it("200 + 内层 <Error> 按内层 code 分类（不因 200 判成功）", () => {
    const accessDenied = s3ErrorFromResponse({ status: 200, bodyText: errorBody("AccessDenied") });
    expect(accessDenied?.type).toBe(OneDriveErrorType.Forbidden);
    expect(accessDenied?.status).toBe(200);

    const internal = s3ErrorFromResponse({ status: 200, bodyText: errorBody("InternalError") });
    expect(internal?.type).toBe(OneDriveErrorType.ServerError);
    expect(internal?.retry).toBe("backoff");
  });

  it("200 的非 Error XML 不误判为错误", () => {
    expect(s3ErrorFromResponse({ status: 200, bodyText: "<Ok><Code>x</Code></Ok>" })).toBeNull();
  });

  it("未知错误码按状态回退；507 映射 InsufficientStorage", () => {
    expect(classifyS3Response({ status: 418, bodyText: errorBody("Teapot") }).type).toBe(
      OneDriveErrorType.Unknown,
    );
    expect(classifyS3Response({ status: 507 }).type).toBe(OneDriveErrorType.InsufficientStorage);
  });

  it("Retry-After 支持秒数与 HTTP-date", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    const now = new Date("2026-11-17T00:00:00.000Z");
    const at = new Date(now.getTime() + 3000).toUTCString();
    expect(parseRetryAfterMs(at, now)).toBe(3000);
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
    const fromHeader = classifyS3Response({ status: 429, headers: { "Retry-After": "3" } }).retryAfterMs;
    expect(fromHeader).toBeGreaterThan(2000);
    expect(fromHeader).toBeLessThanOrEqual(3000);
  });
});

describe("客户端按分类表行动", () => {
  it("403 AccessDenied 只请求一次", async () => {
    fake.failNext({ method: "GET", keyIncludes: "probe.md", status: 403, code: "AccessDenied" });
    await expect(client.getObject("probe.md")).rejects.toMatchObject({
      type: OneDriveErrorType.Forbidden,
      retry: "none",
    });
    expect(fake.requests.filter((request) => request.key === "probe.md")).toHaveLength(1);
  });

  it("301 PermanentRedirect 不跟随、不重试", async () => {
    fake.failNext({
      method: "GET",
      keyIncludes: "probe.md",
      status: 301,
      code: "PermanentRedirect",
      headers: { location: "https://other.example/bucket/probe.md" },
    });
    await expect(client.getObject("probe.md")).rejects.toMatchObject({
      type: OneDriveErrorType.Unknown,
      code: "PermanentRedirect",
    });
    expect(fake.requests.filter((request) => request.key === "probe.md")).toHaveLength(1);
  });

  it("412 PreconditionFailed 不重试", async () => {
    fake.failNext({ method: "GET", keyIncludes: "probe.md", status: 412, code: "PreconditionFailed" });
    await expect(client.getObject("probe.md")).rejects.toMatchObject({
      type: OneDriveErrorType.PreconditionFailed,
      retry: "none",
    });
    expect(fake.requests.filter((request) => request.key === "probe.md")).toHaveLength(1);
  });

  it("503 SlowDown 尊重 Retry-After 后重试", async () => {
    fake.failNext({
      method: "GET",
      keyIncludes: "probe.md",
      status: 503,
      code: "SlowDown",
      headers: { "retry-after": "1" },
    });
    fake.seedObject("probe.md", "ok");
    const result = await client.getObject("probe.md");
    expect(new TextDecoder().decode(result.body)).toBe("ok");
    expect(sleeps).toContain(1000);
    expect(fake.requests.filter((request) => request.key === "probe.md")).toHaveLength(2);
  });

  it("500 InternalError 退避重试到上限后抛 ServerError", async () => {
    fake.failNext({
      method: "GET",
      keyIncludes: "probe.md",
      status: 500,
      code: "InternalError",
      times: 5,
    });
    await expect(client.getObject("probe.md")).rejects.toMatchObject({
      type: OneDriveErrorType.ServerError,
      retry: "backoff",
    });
    expect(fake.requests.filter((request) => request.key === "probe.md")).toHaveLength(3);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("409 ConditionalRequestConflict 有限退避后成功", async () => {
    fake.failNext({
      method: "GET",
      keyIncludes: "probe.md",
      status: 409,
      code: "ConditionalRequestConflict",
    });
    fake.seedObject("probe.md", "ok");
    const result = await client.getObject("probe.md");
    expect(new TextDecoder().decode(result.body)).toBe("ok");
    expect(fake.requests.filter((request) => request.key === "probe.md")).toHaveLength(2);
  });

  it("ExpiredToken 有刷新回调时刷新并重试一次", async () => {
    let refreshed = 0;
    const refreshingClient = new S3Client({
      endpoint,
      region: "us-east-1",
      bucket: fake.bucket,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      transport: createFetchS3Transport(),
      retry: { maxAttempts: 3, sleep: async () => undefined },
      refreshCredentials: async () => {
        refreshed += 1;
        return { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-2" };
      },
    });
    fake.failNext({ method: "GET", keyIncludes: "probe.md", status: 403, code: "ExpiredToken" });
    fake.seedObject("probe.md", "ok");
    const result = await refreshingClient.getObject("probe.md");
    expect(new TextDecoder().decode(result.body)).toBe("ok");
    expect(refreshed).toBe(1);
  });
});
