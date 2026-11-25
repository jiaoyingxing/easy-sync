import { describe, expect, it } from "vitest";
import {
  WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP,
  WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE,
  webdavCapabilities,
  type WebDavTransport,
} from "../src/providers/webdav/webdav-probe";
import { WebDavClient } from "../src/providers/webdav/webdav-client";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};

describe("WebDAV B2 单次 PUT 上限与传输 deadline", () => {
  it("平台能力位：桌面 100 MiB、移动 32 MiB", () => {
    expect(webdavCapabilities().maxSinglePutBytes)
      .toBe(WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP);
    expect(webdavCapabilities("mobile").maxSinglePutBytes)
      .toBe(WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE);
  });

  it("client.probe 按平台返回能力位", async () => {
    fixture.fake.setProfiles(["strict"]);
    const client = new WebDavClient({
      endpoint,
      credentials,
      transport: fixture.transport,
      platform: "mobile",
    });

    const probe = await client.probe();

    expect(probe.capabilities.maxSinglePutBytes)
      .toBe(WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE);
  });

  it("大文件 PUT/GET 的 deadline 按字节放大，小文件保持 30 秒", async () => {
    fixture.fake.setProfiles(["strict"]);
    const requests: Array<{
      method: string;
      path: string;
      deadline: number;
      bytes: number;
    }> = [];
    const transport: WebDavTransport = async (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        deadline: request.deadlineMs,
        bytes: request.body?.byteLength ?? 0,
      });
      return await fixture.transport(request);
    };
    const client = new WebDavClient({
      endpoint,
      credentials,
      transport,
      capabilities: {
        ...webdavCapabilities(),
        conditionalCreate: true,
        conditionalUpdate: true,
      },
    });
    const fourMiB = new Uint8Array(4 * 1024 * 1024);

    await client.createFile("big.bin", fourMiB);
    const largePut = requests.find(
      (request) => request.method === "PUT" && request.path.endsWith("/big.bin"),
    );
    // 4 MiB / 256 KiB/s = 16s，再加 30s 余量。
    expect(largePut).toMatchObject({
      bytes: fourMiB.byteLength,
      deadline: 46_000,
    });

    requests.length = 0;
    await client.createFile("small.bin", new Uint8Array(1024));
    const smallPut = requests.find((request) => request.method === "PUT");
    expect(smallPut?.deadline).toBeGreaterThanOrEqual(30_000);
    expect(smallPut?.deadline).toBeLessThan(31_000);

    requests.length = 0;
    await client.readFile("big.bin");
    const largeGet = requests.find((request) => request.method === "GET");
    expect(largeGet?.deadline).toBe(46_000);
  });
});
