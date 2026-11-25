import { describe, expect, it } from "vitest";
import {
  assertWebDavProbeSecurity,
  buildWebDavBasicAuthorization,
  createRequestUrlWebDavTransport,
  probeWebDavCapabilities,
  WebDavProbeConfigError,
  type WebDavTransport,
} from "../src/providers/webdav/webdav-probe";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

/**
 * W1 验收：安全边界、组合 quirk 与生产传输适配器。
 *
 * 安全对象里的 scheme／authentication 是客户端强制合同；`anonymousRejected`
 * 才是对服务端的实际观测（未带 Authorization 的 PROPFIND 是否被拒绝）。
 */
const fixture = installWebDavProbeFixture();

describe("安全边界", () => {
  it("拒绝明文 http://，并且不发出任何请求", async () => {
    let calls = 0;
    const spy: WebDavTransport = async () => {
      calls += 1;
      return { status: 200, headers: {}, body: new ArrayBuffer(0) };
    };
    await expect(
      probeWebDavCapabilities({
        endpoint: "http://webdav.test",
        credentials: { username: WEBDAV_TEST_USERNAME, password: WEBDAV_TEST_PASSWORD },
        transport: spy,
      }),
    ).rejects.toBeInstanceOf(WebDavProbeConfigError);
    expect(calls).toBe(0);
  });

  it("拒绝把凭据放进 URL、拒绝空用户名／空密码（匿名）", () => {
    expect(() =>
      assertWebDavProbeSecurity("https://user:pass@webdav.test", {
        username: WEBDAV_TEST_USERNAME,
        password: WEBDAV_TEST_PASSWORD,
      }),
    ).toThrow(/embedded/);
    expect(() =>
      assertWebDavProbeSecurity(WEBDAV_TEST_ENDPOINT, { username: "", password: WEBDAV_TEST_PASSWORD }),
    ).toThrow(/anonymous/);
    expect(() =>
      assertWebDavProbeSecurity(WEBDAV_TEST_ENDPOINT, { username: WEBDAV_TEST_USERNAME, password: "" }),
    ).toThrow(/anonymous/);
    expect(() =>
      assertWebDavProbeSecurity("https://webdav.test?token=1", {
        username: WEBDAV_TEST_USERNAME,
        password: WEBDAV_TEST_PASSWORD,
      }),
    ).toThrow(/query or fragment/);
  });

  it("Basic 头按 UTF-8 编码；探针内容请求都带 Basic，匿名请求被服务端拒绝", async () => {
    const header = buildWebDavBasicAuthorization("用户", "päss");
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.slice("Basic ".length), "base64").toString("utf8")).toBe("用户:päss");

    const result = await fixture.runProbe();
    expect(result.security).toMatchObject({
      clientScheme: "https",
      clientAuthentication: "basic",
      anonymousRejected: true,
    });
    const authenticated = fixture.fake.requests.filter((request) => request.authScheme !== null);
    expect(authenticated.length).toBeGreaterThan(0);
    expect(authenticated.every((request) => request.authScheme === "Basic")).toBe(true);
    expect(fixture.fake.requests.some((request) => request.authScheme === null)).toBe(true);

    const anonymous = await fetch(`http://127.0.0.1:${fixture.port}/note.md`);
    expect(anonymous.status).toBe(401);
  });
});

describe("组合 quirk", () => {
  it("弱 ETag＋无 MOVE＋无 infinity：三项降级同时成立，BFS 与 PUT 编码仍可用", async () => {
    const result = await fixture.runProbe(["weak-etag", "no-move", "no-depth-infinity"]);
    expect(result.capabilities.conditionalUpdate).toBe(false);
    expect(result.capabilities.conditionalDelete).toBe(false);
    expect(result.capabilities.conditionalCreate).toBe(true);
    expect(result.capabilities.serverSideMove).toBe(false);
    expect(result.protocolFacts.depthOne).toBe(true);
    expect(result.protocolFacts.depthInfinity).toBe(false);
    expect(result.protocolFacts.pathEncodingRoundTrip).toBe(true);
    expect(result.protocolFacts.moveDestinationEncoding).toBe(false);
  });

  it("忽略 If-Match 且忽略 Overwrite: F：条件写与 MOVE 覆盖保护同时降级", async () => {
    const result = await fixture.runProbe(["no-if-match", "ignore-overwrite-f"]);
    expect(result.capabilities.conditionalUpdate).toBe(false);
    expect(result.capabilities.conditionalDelete).toBe(false);
    expect(result.protocolFacts.moveOverwriteReject).toBe(false);
    expect(result.capabilities.serverSideMove).toBe(false);
  });
});

describe("生产传输适配器", () => {
  it("保留 throw:false、响应头与 ArrayBuffer，异常折成 status 0", async () => {
    let captured: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      throw?: boolean;
      body?: unknown;
    } = {};
    const transport = createRequestUrlWebDavTransport({
      requestUrlFn: async (params) => {
        captured = params;
        return {
          status: 206,
          headers: { etag: '"x"' },
          arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
          json: null,
        };
      },
    });
    const response = await transport({
      method: "GET",
      url: "https://webdav.test/x",
      headers: { A: "b" },
      deadlineMs: 1_000,
    });
    expect(captured).toMatchObject({
      url: "https://webdav.test/x",
      method: "GET",
      throw: false,
    });
    expect(captured.headers).toMatchObject({ A: "b" });
    expect(response.status).toBe(206);
    expect(response.headers.etag).toBe('"x"');
    expect([...new Uint8Array(response.body)]).toEqual([1, 2, 3]);

    const failing = createRequestUrlWebDavTransport({
      requestUrlFn: async () => {
        throw new Error("boom");
      },
    });
    const failed = await failing({
      method: "GET",
      url: "https://webdav.test/x",
      headers: {},
      deadlineMs: 1_000,
    });
    expect(failed.status).toBe(0);
    expect(failed.body.byteLength).toBe(0);
  });

  it("非有限 status 折成 0；deadline 到期返回 status 0", async () => {
    const nonFinite = createRequestUrlWebDavTransport({
      requestUrlFn: async () => ({
        status: Number.NaN,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      }),
    });
    expect(
      (await nonFinite({
        method: "GET",
        url: "https://webdav.test/x",
        headers: {},
        deadlineMs: 1_000,
      })).status,
    ).toBe(0);

    const stalled = createRequestUrlWebDavTransport({
      requestUrlFn: () => new Promise(() => undefined),
    });
    const timedOut = await stalled({
      method: "GET",
      url: "https://webdav.test/x",
      headers: {},
      deadlineMs: 10,
    });
    expect(timedOut.status).toBe(0);
  });
});
