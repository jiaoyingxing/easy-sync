import { describe, expect, it } from "vitest";
import { RemoteErrorType } from "../src/remote/errors";
import { webdavCapabilities } from "../src/providers/webdav/webdav-probe";
import {
  WebDavClient,
  WebDavPreconditionFailedError,
  WebDavReadbackMismatchError,
  WebDavRootNotWritableError,
  WebDavTargetExistsError,
  WebDavUnsafeCreateError,
  WebDavUnsafeDeleteError,
  WebDavUnsafeUpdateError,
} from "../src/providers/webdav/webdav-client";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials = { username: WEBDAV_TEST_USERNAME, password: WEBDAV_TEST_PASSWORD };

const NUTSTORE_PROFILE: readonly FakeWebDavProfile[] = [
  "ignore-if-none-match",
  "ignore-delete-if-match",
  "move-conflict-on-overwrite",
  "depth-infinity-as-one",
  "no-head-length",
  "mkcol-existing-201",
];

function makeClient(
  profiles: readonly FakeWebDavProfile[] = ["strict"],
  options: { capabilities?: ReturnType<typeof webdavCapabilities> } = {},
): WebDavClient {
  fixture.fake.setProfiles(profiles);
  return new WebDavClient({
    endpoint,
    credentials,
    transport: fixture.transport,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("strict server round-trip", () => {
  it("initializes, creates with If-None-Match, updates with If-Match and deletes with If-Match", async () => {
    const client = makeClient();
    const probe = await client.initialize();
    expect(probe.capabilities).toMatchObject({
      conditionalCreate: true,
      conditionalUpdate: true,
      conditionalDelete: true,
      serverSideMove: true,
    });

    const created = await client.createFile("note.md", bytesOf("v1"));
    expect(created.strategy).toBe("conditional-put");
    expect(created.stat.size).toBe(2);
    expect(created.stat.eTag).not.toBeNull();
    expect(textOf((await client.readFile("note.md")).bytes)).toBe("v1");

    const meta = await client.stat("note.md");
    expect(meta).toMatchObject({ kind: "file", relativePath: "note.md", weakETag: false });
    const updated = await client.updateFile("note.md", bytesOf("v2"), meta!.eTag!);
    expect(updated.strategy).toBe("conditional-update");
    expect(textOf((await client.readFile("note.md")).bytes)).toBe("v2");

    await expect(
      client.updateFile("note.md", bytesOf("v3"), '"stale-etag"'),
    ).rejects.toBeInstanceOf(WebDavPreconditionFailedError);

    await expect(
      client.deleteFile("note.md", { confirmed: false }),
    ).rejects.toBeInstanceOf(WebDavUnsafeDeleteError);
    await client.deleteFile("note.md", {
      confirmed: true,
      ifMatch: (await client.stat("note.md"))!.eTag,
    });
    expect(await client.stat("note.md")).toBeNull();
  });

  it("lists direct children and accepts an existing collection on MKCOL", async () => {
    const client = makeClient();
    await client.initialize();
    await client.ensureCollection("folder");
    await client.ensureCollection("folder");
    await client.createFile("folder/a.md", bytesOf("a"));
    const listing = await client.list("folder");
    expect(listing.complete).toBe(true);
    expect(listing.map((entry) => entry.relativePath)).toEqual(["folder/a.md"]);
    await expect(client.ensureCollection("missing/child")).rejects.toMatchObject({
      type: RemoteErrorType.Conflict,
    });
  });
});

describe("Nutstore profile (real-server facts, 2026-11-19)", () => {
  it("probe reports the degraded primitives without pretending", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    const probe = await client.initialize();
    expect(probe.capabilities).toMatchObject({
      conditionalCreate: false,
      conditionalUpdate: true,
      conditionalDelete: false,
      serverSideMove: true,
    });
    expect(probe.protocolFacts).toMatchObject({
      rootReadable: true,
      depthInfinity: false,
      head: false,
      etagPresent: true,
      moveOverwriteReject: true,
      pathEncodingRoundTrip: true,
    });
  });

  it("creates through a unique temp name + MOVE and leaves no temp residue", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    await client.initialize();
    const created = await client.createFile("中文 空格#%😀.md", bytesOf("v1"));
    expect(created.strategy).toBe("staged-move");
    expect(created.stat.size).toBe(2);
    expect(created.stat.eTag).not.toBeNull();
    expect(textOf((await client.readFile("中文 空格#%😀.md")).bytes)).toBe("v1");
    expect(await client.list(".easy-sync/tmp")).toHaveLength(0);
  });

  it("ensures the staged-MOVE temp collections once per session", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    await client.initialize();
    const start = fixture.fake.requests.length;
    await client.createFile("one.md", bytesOf("1"));
    await client.createFile("two.md", bytesOf("2"));
    await client.createFile("three.md", bytesOf("3"));
    const ensured = fixture.fake.requests
      .slice(start)
      .filter((entry) =>
        entry.method === "MKCOL"
        && (
          entry.decodedPath === "/vault/.easy-sync"
          || entry.decodedPath === "/vault/.easy-sync/tmp"
        ));
    // One ensure of each control collection, not two per staged create.
    expect(ensured.map((entry) => entry.decodedPath)).toEqual([
      "/vault/.easy-sync",
      "/vault/.easy-sync/tmp",
    ]);
  });

  it("recreates the staged-MOVE temp collections when they disappear", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    await client.initialize();
    await client.createFile("first.md", bytesOf("1"));
    await client.deleteEmptyCollection(".easy-sync/tmp", { confirmed: true });
    const start = fixture.fake.requests.length;
    const created = await client.createFile("second.md", bytesOf("2"));
    expect(created.strategy).toBe("staged-move");
    expect(textOf((await client.readFile("second.md")).bytes)).toBe("2");
    const ensured = fixture.fake.requests
      .slice(start)
      .filter((entry) =>
        entry.method === "MKCOL"
        && (
          entry.decodedPath === "/vault/.easy-sync"
          || entry.decodedPath === "/vault/.easy-sync/tmp"
        ));
    expect(ensured.map((entry) => entry.decodedPath)).toEqual([
      "/vault/.easy-sync",
      "/vault/.easy-sync/tmp",
    ]);
  });

  it("refuses to overwrite an existing target and keeps its bytes", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    await client.initialize();
    await client.createFile("note.md", bytesOf("first"));
    await expect(client.createFile("note.md", bytesOf("second"))).rejects.toBeInstanceOf(
      WebDavTargetExistsError,
    );
    expect(textOf((await client.readFile("note.md")).bytes)).toBe("first");
    expect(await client.list(".easy-sync/tmp")).toHaveLength(0);
  });

  it("updates with If-Match but refuses a stale conditional delete before the request", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    await client.initialize();
    await client.createFile("note.md", bytesOf("v1"));
    const first = await client.stat("note.md");
    await client.updateFile("note.md", bytesOf("v2"), first!.eTag!);
    await expect(
      client.updateFile("note.md", bytesOf("v3"), '"stale-etag"'),
    ).rejects.toBeInstanceOf(WebDavPreconditionFailedError);

    await expect(
      client.deleteFile("note.md", { confirmed: true, ifMatch: '"stale-etag"' }),
    ).rejects.toBeInstanceOf(WebDavPreconditionFailedError);
    expect(await client.stat("note.md")).not.toBeNull();

    const current = await client.stat("note.md");
    await client.deleteFile("note.md", { confirmed: true, ifMatch: current!.eTag });
    expect(await client.stat("note.md")).toBeNull();
  });

  it("rejects a root collection that cannot hold files", async () => {
    const client = makeClient([...NUTSTORE_PROFILE, "root-files-forbidden"]);
    await expect(client.initialize()).rejects.toBeInstanceOf(WebDavRootNotWritableError);
  });
});

describe("fail-closed policy", () => {
  it("refuses create and update when no safe primitive exists", async () => {
    const capabilities = webdavCapabilities();
    const client = makeClient(["strict"], { capabilities });
    await expect(client.createFile("note.md", bytesOf("v1"))).rejects.toBeInstanceOf(
      WebDavUnsafeCreateError,
    );
    await expect(
      client.updateFile("note.md", bytesOf("v2"), '"etag"'),
    ).rejects.toBeInstanceOf(WebDavUnsafeUpdateError);
  });

  it("turns a 2xx-without-write update into a readback mismatch", async () => {
    const capabilities = {
      ...webdavCapabilities(),
      conditionalCreate: true,
      conditionalUpdate: true,
      conditionalDelete: true,
      serverSideMove: true,
    };
    const client = makeClient(["put-2xx-without-write"], { capabilities });
    await client.createFile("note.md", bytesOf("v1"));
    const stat = await client.stat("note.md");
    await expect(
      client.updateFile("note.md", bytesOf("longer-body"), stat!.eTag!),
    ).rejects.toBeInstanceOf(WebDavReadbackMismatchError);
  });
});

describe("stale temporary cleanup", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("is a no-op when the control temporary directory does not exist", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    await client.initialize();

    const result = await client.cleanupStaleTemporaryFiles();

    expect(result).toMatchObject({
      directory: ".easy-sync/tmp",
      directoryPresent: false,
      scanned: 0,
      deleted: [],
      failures: [],
    });
  });

  it("removes only this client's stale temp files under .easy-sync/tmp", async () => {
    const client = makeClient(NUTSTORE_PROFILE);
    await client.initialize();
    const now = Date.now();
    const oldName = `/vault/.easy-sync/tmp/create-${(now - 2 * DAY_MS).toString(36)}-deadbeef`;
    const oldMtime = `/vault/.easy-sync/tmp/create-${now.toString(36)}-cafebabe`;
    const fresh = `/vault/.easy-sync/tmp/create-${now.toString(36)}-feedface`;
    const foreign = "/vault/.easy-sync/tmp/keep-me.txt";
    const outside = `/vault/create-${(now - 2 * DAY_MS).toString(36)}-deadbeef`;
    const collection = `/vault/.easy-sync/tmp/create-${(now - 2 * DAY_MS).toString(36)}-c0ffee`;

    fixture.fake.seedFile(oldName, "old-by-name");
    fixture.fake.seedFile(oldMtime, "old-by-mtime");
    fixture.fake.seedFile(fresh, "fresh");
    fixture.fake.seedFile(foreign, "not-ours");
    fixture.fake.seedFile(outside, "outside-tmp");
    fixture.fake.seedCollection(collection);
    fixture.fake.setLastModified(oldMtime, new Date(now - 2 * DAY_MS));
    fixture.fake.setLastModified(foreign, new Date(now - 2 * DAY_MS));
    fixture.fake.setLastModified(outside, new Date(now - 2 * DAY_MS));

    const result = await client.cleanupStaleTemporaryFiles();

    expect(result.directoryPresent).toBe(true);
    expect([...result.deleted].sort()).toEqual([oldMtime, oldName]
      .map((path) => path.replace(/^\/vault\//, ""))
      .sort());
    expect(result.failures).toEqual([]);
    expect(fixture.fake.getResource(oldName)).toBeNull();
    expect(fixture.fake.getResource(oldMtime)).toBeNull();
    expect(fixture.fake.getResource(fresh)).not.toBeNull();
    expect(fixture.fake.getResource(foreign)).not.toBeNull();
    expect(fixture.fake.getResource(outside)).not.toBeNull();
    expect(fixture.fake.getResource(collection)).not.toBeNull();
  });
});
