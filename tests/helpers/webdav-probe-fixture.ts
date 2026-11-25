/**
 * 五个 W1 验收文件共用的 fake fixture。
 *
 * 每个测试文件在自己的模块顶层调用 `installWebDavProbeFixture()`，会注册
 * `beforeAll`／`afterAll`／`beforeEach` 并启动一个独立的进程内 fake WebDAV；
 * 测试之间靠 `fake.reset()` 隔离，不共享远端状态。
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import {
  buildWebDavBasicAuthorization,
  encodeWebDavPath,
  probeWebDavCapabilities,
  type WebDavProbeResult,
  type WebDavTransport,
} from "../../src/providers/webdav/webdav-probe";
import {
  createLoopbackWebDavTransport,
  FakeWebDavServer,
  type FakeWebDavProfile,
} from "./fake-webdav";

export const WEBDAV_TEST_ENDPOINT = "https://webdav.test";
export const WEBDAV_TEST_USERNAME = "probe";
export const WEBDAV_TEST_PASSWORD = "app-password";

export interface WebDavProbeFixture {
  readonly fake: FakeWebDavServer;
  readonly transport: WebDavTransport;
  readonly endpoint: string;
  readonly rootPath: string;
  readonly port: number;
  runProbe(profiles?: readonly FakeWebDavProfile[]): Promise<WebDavProbeResult>;
  raw(
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: string,
  ): Promise<Response>;
  sha256(text: string): string;
  authorization(): string;
}

export function installWebDavProbeFixture(
  options: { readonly rootPath?: string } = {},
): WebDavProbeFixture {
  const rootPath = options.rootPath ?? "/";
  let fake: FakeWebDavServer;
  let transport: WebDavTransport;
  let port = 0;

  beforeAll(async () => {
    fake = new FakeWebDavServer({
      username: WEBDAV_TEST_USERNAME,
      password: WEBDAV_TEST_PASSWORD,
      rootPath,
    });
    const started = await fake.start();
    port = started.port;
    // §4.5 preflight：随机端口必须真的分配。
    expect(port).toBeGreaterThan(0);
    transport = createLoopbackWebDavTransport({ port });
  });

  afterAll(async () => {
    await fake.stop();
  });

  beforeEach(() => {
    fake.reset();
    fake.setProfiles(["strict"]);
  });

  return {
    get fake(): FakeWebDavServer {
      return fake;
    },
    get transport(): WebDavTransport {
      return transport;
    },
    endpoint: WEBDAV_TEST_ENDPOINT,
    rootPath,
    get port(): number {
      return port;
    },
    runProbe(profiles: readonly FakeWebDavProfile[] = ["strict"]): Promise<WebDavProbeResult> {
      fake.setProfiles(profiles);
      return probeWebDavCapabilities({
        endpoint: WEBDAV_TEST_ENDPOINT,
        rootPath: rootPath === "/" ? undefined : rootPath,
        credentials: {
          username: WEBDAV_TEST_USERNAME,
          password: WEBDAV_TEST_PASSWORD,
        },
        transport,
        randomSuffix: () => "fixed",
      });
    },
    raw(
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: string,
    ): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}${encodeWebDavPath(path)}`, {
        method,
        headers: {
          Authorization: buildWebDavBasicAuthorization(WEBDAV_TEST_USERNAME, WEBDAV_TEST_PASSWORD),
          ...headers,
        },
        body,
      });
    },
    sha256(text: string): string {
      return createHash("sha256").update(text).digest("hex");
    },
    authorization(): string {
      return buildWebDavBasicAuthorization(WEBDAV_TEST_USERNAME, WEBDAV_TEST_PASSWORD);
    },
  };
}
