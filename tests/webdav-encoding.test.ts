import { describe, expect, it } from "vitest";
import {
  buildWebDavUrl,
  decodeWebDavHref,
  encodeWebDavPath,
  joinWebDavPath,
  parseWebDavMultiStatus,
  WEBDAV_PROPFIND_BODY,
  WebDavProbeConfigError,
  WebDavProtocolError,
} from "../src/providers/webdav/webdav-probe";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
} from "./helpers/webdav-probe-fixture";

/**
 * W1 验收：路径编码。
 *
 * 六类字符（空格、#、%、+、中文、emoji）必须同时覆盖 PUT 路径、
 * PROPFIND href 与 MOVE Destination；服务端回读的名字要与本地一致。
 */
const fixture = installWebDavProbeFixture();

describe("路径编码纯函数", () => {
  it("逐段编码空格、#、%、+、中文与 emoji，保留 / 分隔", () => {
    expect(encodeWebDavPath("/a b/c#d/e%f/g+h/中文/😀.md")).toBe(
      "/a%20b/c%23d/e%25f/g%2Bh/%E4%B8%AD%E6%96%87/%F0%9F%98%80.md",
    );
    expect(encodeWebDavPath("a b")).toBe("/a%20b");
    expect(joinWebDavPath("/root/", "/child")).toBe("/root/child");
    expect(buildWebDavUrl(WEBDAV_TEST_ENDPOINT, "/a b/#x")).toBe("https://webdav.test/a%20b/%23x");
  });

  it("拒绝 .. 路径段；href 只解码一次", () => {
    expect(() => encodeWebDavPath("/a/../b")).toThrow(WebDavProbeConfigError);
    expect(decodeWebDavHref("https://webdav.test/a%20b/%23x/%25", WEBDAV_TEST_ENDPOINT)).toBe("/a b/#x/%");
    expect(decodeWebDavHref("https://webdav.test/a%2525b", WEBDAV_TEST_ENDPOINT)).toBe("/a%25b");
  });

  it("拒绝 href 里解码后变成路径分隔符的段", () => {
    // The endpoint decoder already rejects this shape; a server href must not
    // be able to turn one entry into a phantom subtree either.
    expect(() => decodeWebDavHref("https://webdav.test/a%2Fb", WEBDAV_TEST_ENDPOINT))
      .toThrow(WebDavProtocolError);
    expect(() => decodeWebDavHref("https://webdav.test/a%5Cb", WEBDAV_TEST_ENDPOINT))
      .toThrow(WebDavProtocolError);
    expect(decodeWebDavHref("https://webdav.test/a%20b", WEBDAV_TEST_ENDPOINT))
      .toBe("/a b");
  });
});

describe("探针往返", () => {
  it("PUT、PROPFIND href 与 MOVE Destination 都按同一编码往返", async () => {
    const result = await fixture.runProbe();
    expect(result.protocolFacts.pathEncodingRoundTrip).toBe(true);
    expect(result.protocolFacts.moveDestinationEncoding).toBe(true);

    const putPaths = fixture.fake.requests
      .filter((request) => request.method === "PUT")
      .map((request) => request.rawPath);
    expect(putPaths.some((path) => path.includes("%20"))).toBe(true);
    expect(putPaths.some((path) => path.includes("%23"))).toBe(true);
    expect(putPaths.some((path) => path.includes("%25"))).toBe(true);
    expect(putPaths.some((path) => path.includes("%2B"))).toBe(true);
    expect(putPaths.some((path) => path.includes("%E4%B8%AD%E6%96%87"))).toBe(true);
    expect(putPaths.some((path) => path.includes("%F0%9F%98%80"))).toBe(true);

    const encodingMove = fixture.fake.requests.find(
      (request) => request.method === "MOVE" && (request.destination ?? "").includes("enc-move"),
    );
    const destination = encodingMove?.destination ?? "";
    expect(destination).toContain("%20");
    expect(destination).toContain("%23");
    expect(destination).toContain("%25");
    expect(destination).toContain("%2B");
    expect(destination).toContain("%E4%B8%AD%E6%96%87");
    expect(destination).toContain("%F0%9F%98%80");
  });
});

describe("fake 回读", () => {
  it("服务端按编码路径回读名字，href 含六类字符的百分号编码", async () => {
    const name = "空格 #%+ 中文 😀.md";
    const put = await fixture.raw("PUT", `/${name}`, { "If-None-Match": "*" }, "encoded body");
    expect(put.status).toBe(201);

    const listing = await fixture.raw("PROPFIND", "/", {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    }, WEBDAV_PROPFIND_BODY);
    const xml = await listing.text();
    expect(xml).toContain("%20");
    expect(xml).toContain("%23");
    expect(xml).toContain("%25");
    expect(xml).toContain("%2B");
    expect(xml).toContain("%E4%B8%AD%E6%96%87");
    expect(xml).toContain("%F0%9F%98%80");

    const entries = parseWebDavMultiStatus(xml, WEBDAV_TEST_ENDPOINT);
    expect(entries.some((entry) => entry.path === `/${name}`)).toBe(true);
    const get = await fixture.raw("GET", `/${name}`);
    expect(await get.text()).toBe("encoded body");
  });
});
