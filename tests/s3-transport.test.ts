import { describe, expect, it } from "vitest";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
  createRequestUrlTransport,
  type S3Transport,
} from "../src/providers/s3/s3-transport";

/**
 * 生产传输适配器的合同：`requestUrl({throw:false})` 保留 4xx／5xx 响应体；
 * host 抛错与超时都归一化为 `status: 0`（NetworkError 路径），晚到的响应不能
 * 变成未处理拒绝。
 */
function response(overrides: Partial<RequestUrlResponse>): RequestUrlResponse {
  return {
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: null,
    text: "",
    ...overrides,
  };
}

function bodyBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("requestUrl 适配器", () => {
  it("保留 4xx 响应体并归一化 headers", async () => {
    const calls: RequestUrlParam[] = [];
    const transport = createRequestUrlTransport({
      requestUrlFn: async (params) => {
        calls.push(params);
        return response({
          status: 403,
          headers: { "x-amz-request-id": "req-1" },
          arrayBuffer: bodyBuffer("<Error><Code>AccessDenied</Code></Error>"),
        });
      },
    });
    const result = await transport({
      method: "GET",
      url: "https://example.com/bucket/key",
      headers: { authorization: "sig" },
      deadlineMs: 1_000,
    });
    expect(result.status).toBe(403);
    expect(new TextDecoder().decode(result.body)).toContain("AccessDenied");
    expect(result.headers["x-amz-request-id"]).toBe("req-1");
    expect(calls[0].throw).toBe(false);
    expect(calls[0].headers).toEqual({ authorization: "sig" });
  });

  it("host 抛错 → status 0", async () => {
    const transport = createRequestUrlTransport({
      requestUrlFn: async () => {
        throw new Error("host network failure");
      },
    });
    const result = await transport({
      method: "GET",
      url: "https://example.com/",
      headers: {},
      deadlineMs: 1_000,
    });
    expect(result.status).toBe(0);
    expect(result.body.byteLength).toBe(0);
  });

  it("非有限状态码 → status 0", async () => {
    const transport = createRequestUrlTransport({
      requestUrlFn: async () => response({ status: Number.NaN }),
    });
    const result = await transport({
      method: "GET",
      url: "https://example.com/",
      headers: {},
      deadlineMs: 1_000,
    });
    expect(result.status).toBe(0);
  });

  it("deadline 到点返回 status 0，晚到响应被忽略", async () => {
    const transport = createRequestUrlTransport({
      requestUrlFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return response({ status: 200, arrayBuffer: bodyBuffer("late") });
      },
    });
    const started = Date.now();
    const result = await transport({
      method: "GET",
      url: "https://example.com/",
      headers: {},
      deadlineMs: 5,
    });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(40);
    // 给晚到的 promise 一个结算窗口；到达这里仍无未处理拒绝即可。
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("可注入的 transport 类型不要求宿主 API", () => {
    const passthrough: S3Transport = async (request) => ({
      status: 200,
      headers: {},
      body: request.body ?? new ArrayBuffer(0),
    });
    expect(typeof passthrough).toBe("function");
  });
});
