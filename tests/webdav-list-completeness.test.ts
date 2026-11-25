import { describe, expect, it } from "vitest";
import {
  WEBDAV_LIST_ENTRY_LIMIT,
  WebDavClient,
  WebDavUnsafeDeleteError,
} from "../src/providers/webdav/webdav-client";
import { installWebDavProbeFixture, WEBDAV_TEST_ENDPOINT, WEBDAV_TEST_PASSWORD, WEBDAV_TEST_USERNAME } from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials = { username: WEBDAV_TEST_USERNAME, password: WEBDAV_TEST_PASSWORD };

function makeClient(): WebDavClient {
  return new WebDavClient({
    endpoint,
    credentials,
    transport: fixture.transport,
  });
}

function seedFiles(prefix: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    fixture.fake.seedFile(
      `/vault/${prefix}-${String(index).padStart(4, "0")}.md`,
      `content-${index}`,
    );
  }
}

describe("WebDAV list completeness", () => {
  it("returns an array-compatible result with explicit completeness metadata", async () => {
    seedFiles("note", 10);
    const listing = await makeClient().list("");

    expect(Array.isArray(listing)).toBe(true);
    expect(listing).toHaveLength(10);
    expect(listing.map((entry) => entry.relativePath)).toContain("note-0000.md");
    expect(listing.complete).toBe(true);
    expect(listing.entryLimit).toBe(WEBDAV_LIST_ENTRY_LIMIT);
    expect(listing.responseEntryCount).toBe(11);
  });

  it("keeps the last complete response below the 750-response limit", async () => {
    seedFiles("under", 748);
    const listing = await makeClient().list("");
    expect(listing.responseEntryCount).toBe(749);
    expect(listing.complete).toBe(true);
  });

  it("treats 749 children plus the collection itself as possibly truncated", async () => {
    seedFiles("edge", 749);
    const listing = await makeClient().list("");
    expect(listing).toHaveLength(749);
    expect(listing.responseEntryCount).toBe(750);
    expect(listing.complete).toBe(false);
  });

  it("reports 750 and 751 children as possibly truncated", async () => {
    seedFiles("over", 750);
    const at750 = await makeClient().list("");
    expect(at750).toHaveLength(750);
    expect(at750.responseEntryCount).toBe(751);
    expect(at750.complete).toBe(false);

    seedFiles("over", 751);
    const at751 = await makeClient().list("");
    expect(at751).toHaveLength(751);
    expect(at751.responseEntryCount).toBe(752);
    expect(at751.complete).toBe(false);
  });

  it("refuses to infer that a possibly truncated collection is empty", async () => {
    seedFiles("full", 749);
    const client = makeClient();

    await expect(
      client.deleteEmptyCollection("", { confirmed: true }),
    ).rejects.toBeInstanceOf(WebDavUnsafeDeleteError);

    const deletes = fixture.fake.requests.filter(
      (request) => request.method === "DELETE" && request.decodedPath === "/vault",
    );
    expect(deletes).toHaveLength(0);
  });
});
