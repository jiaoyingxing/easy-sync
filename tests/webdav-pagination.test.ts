import { describe, expect, it } from "vitest";
import {
  WEBDAV_LIST_ENTRY_LIMIT,
  WEBDAV_LIST_MAX_PAGES,
  WebDavClient,
  WebDavPaginationError,
  type WebDavPaginationFailure,
} from "../src/providers/webdav/webdav-client";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
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

const PAGINATED: readonly FakeWebDavProfile[] = ["strict", "paginate-750"];

function makeClient(): WebDavClient {
  return new WebDavClient({ endpoint, credentials, transport: fixture.transport });
}

function seedFiles(prefix: string, count: number, parent = "/vault"): void {
  for (let index = 0; index < count; index += 1) {
    fixture.fake.seedFile(
      `${parent}/${prefix}-${String(index).padStart(4, "0")}.md`,
      `content-${index}`,
    );
  }
}

describe("WebDAV 分页（Link rel=next）", () => {
  it("跟随 next 取回 1,001 项，两页合计且不重复", async () => {
    fixture.fake.setProfiles(PAGINATED);
    seedFiles("note", 1001);
    const client = makeClient();

    const listing = await client.list("");

    expect(listing).toHaveLength(1001);
    expect(new Set(listing.map((entry) => entry.relativePath)).size).toBe(1001);
    expect(listing.complete).toBe(true);
    expect(listing.pageCount).toBe(2);
    expect(listing.responseEntryCount).toBe(1003);
    expect(listing.entryLimit).toBe(WEBDAV_LIST_ENTRY_LIMIT);

    const propfinds = fixture.fake.requests.filter((request) => request.method === "PROPFIND");
    expect(propfinds).toHaveLength(2);
    expect(propfinds[1].rawUrl).toContain("mk=749");
    expect(client.requestCount).toBe(2);
    expect(client.requestCountsByMethod.PROPFIND).toBe(2);
  });

  it("750 个子项恰好跨两页，每页的集合自身不算用户内容", async () => {
    fixture.fake.setProfiles(PAGINATED);
    seedFiles("edge", 750);

    const listing = await makeClient().list("");

    expect(listing).toHaveLength(750);
    expect(listing.complete).toBe(true);
    expect(listing.pageCount).toBe(2);
    expect(listing.some((entry) => entry.relativePath === "")).toBe(false);
  });

  it("一旦见过分页，恰好 750 个响应条目的单页目录不再被误判为截断", async () => {
    fixture.fake.setProfiles(PAGINATED);
    seedFiles("big", 751, "/vault/big");
    seedFiles("edge", 749, "/vault/edge");
    const client = makeClient();

    const big = await client.list("big");
    expect(big.complete).toBe(true);
    expect(big.pageCount).toBe(2);

    const edge = await client.list("edge");
    expect(edge.responseEntryCount).toBe(750);
    expect(edge.pageCount).toBe(1);
    expect(edge.complete).toBe(true);
  });

  it("拒绝跨 origin 的 next 链接", async () => {
    fixture.fake.setProfiles(["strict", "paginate-cross-origin"]);
    seedFiles("cross", 751);

    await expect(makeClient().list("")).rejects.toMatchObject({
      name: "WebDavPaginationError",
      reason: "next-link-outside-collection",
    });
    expect(fixture.fake.requests.filter((request) => request.method === "PROPFIND")).toHaveLength(1);
  });

  it("拒绝指向同 origin 其他集合的 next 链接", async () => {
    fixture.fake.setProfiles(["strict", "paginate-other-path"]);
    seedFiles("other", 751);

    await expect(makeClient().list("")).rejects.toBeInstanceOf(WebDavPaginationError);
  });

  it("检测分页循环并在重复页之前停止", async () => {
    fixture.fake.setProfiles(["strict", "paginate-cycle"]);
    seedFiles("cycle", 751);

    await expect(makeClient().list("")).rejects.toMatchObject({
      name: "WebDavPaginationError",
      reason: "pagination-cycle",
    });
    expect(fixture.fake.requests.filter((request) => request.method === "PROPFIND")).toHaveLength(2);
  });

  it("页数超过上限时失败关闭，不无限跟随 next", async () => {
    fixture.fake.setProfiles(["strict", "paginate-endless"]);
    fixture.fake.seedFile("/vault/one.md", "x");
    const failure: WebDavPaginationFailure = "pagination-page-limit";

    await expect(makeClient().list("")).rejects.toMatchObject({
      name: "WebDavPaginationError",
      reason: failure,
    });
    expect(fixture.fake.requests.filter((request) => request.method === "PROPFIND"))
      .toHaveLength(WEBDAV_LIST_MAX_PAGES);
  });

  it("同一路径跨页出现且事实冲突时失败关闭", async () => {
    fixture.fake.setProfiles(PAGINATED);
    seedFiles("dup", 1001);
    const baseTransport = fixture.transport;
    const conflictingTransport = async (
      request: Parameters<typeof baseTransport>[0],
    ): ReturnType<typeof baseTransport> => {
      const response = await baseTransport(request);
      if (!request.url.includes("mk=") || response.status !== 207) return response;
      const xml = new TextDecoder().decode(response.body);
      const duplicate = [
        "<d:response>",
        "<d:href>/vault/dup-0000.md</d:href>",
        "<d:propstat><d:prop>",
        "<d:resourcetype/>",
        '<d:getetag>"conflict"</d:getetag>',
        "<d:getcontentlength>9999</d:getcontentlength>",
        "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>",
        "</d:response>",
      ].join("");
      const patched = xml.replace("</d:multistatus>", `${duplicate}</d:multistatus>`);
      return {
        ...response,
        body: new TextEncoder().encode(patched).buffer as ArrayBuffer,
      };
    };
    const client = new WebDavClient({
      endpoint,
      credentials,
      transport: conflictingTransport,
    });

    await expect(client.list("")).rejects.toMatchObject({
      name: "WebDavPaginationError",
      reason: "conflicting-duplicate-entry",
    });
  });

  it("同一路径跨页重复（事实相同）也失败关闭", async () => {
    fixture.fake.setProfiles(PAGINATED);
    seedFiles("same", 1001);
    const baseTransport = fixture.transport;
    let firstPage = "";
    const repeatingTransport = async (
      request: Parameters<typeof baseTransport>[0],
    ): ReturnType<typeof baseTransport> => {
      const response = await baseTransport(request);
      if (request.method !== "PROPFIND" || response.status !== 207) return response;
      const xml = new TextDecoder().decode(response.body);
      if (!request.url.includes("mk=")) {
        firstPage = xml;
        return response;
      }
      const block = /<d:response><d:href>\/vault\/same-0000\.md<\/d:href>[\s\S]*?<\/d:response>/.exec(firstPage);
      if (block === null) return response;
      const patched = xml.replace("</d:multistatus>", `${block[0]}</d:multistatus>`);
      return {
        ...response,
        body: new TextEncoder().encode(patched).buffer as ArrayBuffer,
      };
    };
    const client = new WebDavClient({
      endpoint,
      credentials,
      transport: repeatingTransport,
    });

    await expect(client.list("")).rejects.toMatchObject({
      name: "WebDavPaginationError",
      reason: "duplicate-entry-across-pages",
    });
  });

  it("provider 在分页下扫描到完整 1,001 项，而不是按截断推断删除", async () => {
    fixture.fake.setProfiles(PAGINATED);
    seedFiles("scan", 1001);
    const client = makeClient();
    await client.initialize();
    const provider = new WebDavProvider({ client });

    const items = await provider.fullScan("vault");

    expect(items).toHaveLength(1001);
    expect(new Set(items.map((item) => item.id)).size).toBe(1001);
  });
});
