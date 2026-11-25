import { describe, expect, it } from "vitest";
import {
  isWeakETag,
  parseWebDavMultiStatus,
  probeWebDavCapabilities,
  WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP,
  WebDavProtocolError,
} from "../src/providers/webdav/webdav-probe";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

/**
 * W1 验收：PROPFIND 与 207 解析。
 *
 * Depth 判定必须做差分：在探针自己的三层小树上分别验证 Depth 0＝1 条、
 * Depth 1＝集合＋直接子项、Depth infinity 含嵌套项；不能对用户根数条数。
 */
const fixture = installWebDavProbeFixture();
const vaultFixture = installWebDavProbeFixture({ rootPath: "/vault" });

describe("207 multistatus 解析", () => {
  it("解析命名空间前缀、相对／绝对 href、集合与弱 ETag", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/vault/a%20b/%E4%B8%AD%23x.md</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>中#x.md</D:displayname>
        <D:resourcetype/>
        <D:getetag>W/&quot;abc&quot;</D:getetag>
        <D:getcontentlength>12</D:getcontentlength>
        <D:getlastmodified>Tue, 18 Nov 2025 00:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>https://webdav.test/vault/dir/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getetag>&quot;dir&quot;</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const entries = parseWebDavMultiStatus(xml, WEBDAV_TEST_ENDPOINT);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      href: "/vault/a%20b/%E4%B8%AD%23x.md",
      path: "/vault/a b/中#x.md",
      status: 200,
      isCollection: false,
      eTag: 'W/"abc"',
      contentLength: 12,
      displayName: "中#x.md",
    });
    expect(isWeakETag(entries[0].eTag ?? "")).toBe(true);
    expect(entries[1]).toMatchObject({
      path: "/vault/dir",
      isCollection: true,
      contentLength: null,
    });
  });

  it("混合 propstat：存在 2xx propstat 时不能被 404 propstat 判成不存在", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/vault/mixed.md</d:href>
    <d:propstat>
      <d:prop><d:getetag>&quot;x&quot;</d:getetag></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:displayname>mixed.md</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
    const entries = parseWebDavMultiStatus(xml, WEBDAV_TEST_ENDPOINT);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "/vault/mixed.md", status: 200 });
  });

  it("根元素不是 multistatus（HTTP 200 风格）或 XML 截断时抛协议错误", () => {
    expect(() => parseWebDavMultiStatus(`<d:propfind xmlns:d="DAV:"/>`, WEBDAV_TEST_ENDPOINT)).toThrow(
      WebDavProtocolError,
    );
    expect(() => parseWebDavMultiStatus(`<d:multistatus xmlns:d="DAV:">`, WEBDAV_TEST_ENDPOINT)).toThrow(
      WebDavProtocolError,
    );
  });
});

describe("Depth 差分", () => {
  it("严格服务器：Depth 0/1/infinity 分别按探针小树判定，全部通过", async () => {
    const result = await fixture.runProbe();

    expect(result.protocolFacts).toMatchObject({
      rootReadable: true,
      depthZero: true,
      depthOne: true,
      depthInfinity: true,
      head: true,
      etagPresent: true,
      weakETag: false,
      moveOverwriteReject: true,
      moveDestinationEncoding: true,
      mkcolSingleLevel: true,
      pathEncodingRoundTrip: true,
    });
    expect(result.capabilities).toMatchObject({
      stableIdentity: false,
      conditionalCreate: true,
      conditionalUpdate: true,
      conditionalDelete: true,
      serverSideMove: true,
      deltaCursor: false,
      folderEntity: true,
      contentChecksum: false,
      contentVersionToken: false,
      versionHistory: false,
      recycleBin: false,
      rangeDownload: false,
      resumableUpload: false,
      maxSinglePutBytes: WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP,
    });
    expect(result.observations.filter((observation) => !observation.passed)).toEqual([]);

    const depths = new Set(
      fixture.fake.requests
        .filter((request) => request.method === "PROPFIND")
        .map((request) => request.depth?.toLowerCase()),
    );
    expect(depths.has("0")).toBe(true);
    expect(depths.has("1")).toBe(true);
    expect(depths.has("infinity")).toBe(true);
    const infinityOnUserRoot = fixture.fake.requests.filter(
      (request) =>
        request.method === "PROPFIND"
        && request.depth?.toLowerCase() === "infinity"
        && request.decodedPath === "/",
    );
    expect(infinityOnUserRoot).toEqual([]);
    expect(fixture.fake.listPaths().filter((path) => path.includes(".easy-sync-probe-"))).toEqual([]);
  });

  it("Depth infinity 不可用：只有 infinity 为 false，BFS Depth 1 仍通过", async () => {
    const result = await fixture.runProbe(["no-depth-infinity"]);
    expect(result.protocolFacts).toMatchObject({
      depthZero: true,
      depthOne: true,
      depthInfinity: false,
    });
    expect(result.observations.find((o) => o.step === "depth:infinity")?.observed).toMatch(/403/);
  });

  it("服务器静默忽略 Depth：Depth 1 与 infinity 都不得判为 true", async () => {
    const result = await fixture.runProbe(["ignore-depth"]);
    expect(result.protocolFacts.depthZero).toBe(true);
    expect(result.protocolFacts.depthOne).toBe(false);
    expect(result.protocolFacts.depthInfinity).toBe(false);
    expect(result.observations.find((o) => o.step === "depth:1")?.passed).toBe(false);
  });

  it("服务器把 PROPFIND 成功写成 200：根集合不可读，Depth 三项都不算通过", async () => {
    const result = await fixture.runProbe(["propfind-200"]);
    expect(result.protocolFacts.rootReadable).toBe(false);
    expect(result.protocolFacts.depthZero).toBe(false);
    expect(result.protocolFacts.depthOne).toBe(false);
    expect(result.protocolFacts.depthInfinity).toBe(false);
    expect(result.observations.find((o) => o.step === "propfind:root")?.observed).toMatch(/200/);
  });
});

describe("根集合路径", () => {
  it("rootPath=/vault 时只碰 /vault，不遍历用户根", async () => {
    vaultFixture.fake.seedFile("/vault/note.md", "user content");
    const result = await vaultFixture.runProbe();
    expect(result.protocolFacts).toMatchObject({
      rootReadable: true,
      depthZero: true,
      depthOne: true,
      depthInfinity: true,
    });
    expect(
      vaultFixture.fake.listPaths().filter((path) => path.includes(".easy-sync-probe-")),
    ).toEqual([]);
    expect(vaultFixture.fake.readText("/vault/note.md")).toBe("user content");
  });

  it("endpoint 自带 /vault 路径时，缺省 rootPath 取该路径", async () => {
    vaultFixture.fake.seedFile("/vault/note.md", "user content");
    const result = await probeWebDavCapabilities({
      endpoint: "https://webdav.test/vault",
      credentials: {
        username: WEBDAV_TEST_USERNAME,
        password: WEBDAV_TEST_PASSWORD,
      },
      transport: vaultFixture.transport,
      randomSuffix: () => "fixed",
    });
    expect(result.protocolFacts).toMatchObject({
      rootReadable: true,
      depthZero: true,
      depthOne: true,
      depthInfinity: true,
    });
    expect(
      vaultFixture.fake.listPaths().filter((path) => path.includes(".easy-sync-probe-")),
    ).toEqual([]);
    expect(vaultFixture.fake.readText("/vault/note.md")).toBe("user content");
  });
});
