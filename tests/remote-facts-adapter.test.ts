import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import { toRemoteScanFactsV1 } from "../src/sync/remote-facts-adapter";

/** Mixed Graph fixture pinned against the pre-B2a builder output. */
function goldenFixture(): DriveItem[] {
  return [
    { id: "folder-a", name: "Alpha", folder: {}, parentReference: { id: "files-root" }, eTag: "etag-a-1", cTag: "ctag-a-1" },
    { id: "folder-b", name: "Beta", folder: {}, parentReference: { id: "files-root" }, eTag: "etag-b-1" },
    { id: "file-1", name: "note.md", file: { hashes: { sha256Hash: "ABCDEF0123456789" } }, size: 42, parentReference: { id: "folder-a" }, eTag: "etag-f1", cTag: "ctag-f1", lastModifiedDateTime: "2026-01-02T03:04:05.000Z" },
    { id: "file-2", name: "image.png", file: { hashes: { quickXorHash: "Y0BDGthABgAAAAAABQAAAAAAAAA=" } }, size: 7, parentReference: { id: "folder-a" } },
    { id: "dup", name: "old.md", file: {}, parentReference: { id: "files-root" }, eTag: "etag-old" },
    { id: "dup", name: "new.md", file: {}, parentReference: { id: "files-root" }, eTag: "etag-new" },
    { id: "gone", name: "deleted.md", file: {}, parentReference: { id: "files-root" }, deleted: { state: "deleted" } },
    { id: "bad-date", name: "bad.md", file: {}, parentReference: { id: "folder-b" }, eTag: "etag-bd", lastModifiedDateTime: "not-a-date" },
  ];
}

describe("RemoteScanFactV1 adapter", () => {
  it("maps every DriveItem field into the neutral fact without changing values", () => {
    const facts = toRemoteScanFactsV1([{
      id: "file-1",
      name: "note.md",
      size: 42,
      file: { hashes: { sha256Hash: "ABCDEF0123456789", quickXorHash: "QX-HASH" } },
      parentReference: { id: "folder-a", driveId: "drive-1" },
      lastModifiedDateTime: "2026-01-02T03:04:05.000Z",
      eTag: "etag-f1",
      cTag: "ctag-f1",
      "@microsoft.graph.downloadUrl": "https://download.example/file",
    }]);

    expect(facts).toEqual([{
      id: "file-1",
      parentId: "folder-a",
      name: "note.md",
      kind: "file",
      deleted: false,
      eTag: "etag-f1",
      cTag: "ctag-f1",
      size: 42,
      mtime: 1767323045000,
      contentHash: "abcdef0123456789",
      quickXorHash: "QX-HASH",
      downloadUrl: "https://download.example/file",
      parentDriveId: "drive-1",
    }]);
  });

  it("prefers folder over file when both facets are present", () => {
    const [fact] = toRemoteScanFactsV1([{
      id: "both",
      name: "both",
      folder: {},
      file: {},
      parentReference: { id: "root" },
    }]);
    expect(fact.kind).toBe("folder");
  });

  it("keeps a missing file/folder facet as kind=undefined so the builder rejects it", () => {
    const [fact] = toRemoteScanFactsV1([{
      id: "x",
      name: "x.md",
      parentReference: { id: "root" },
    }]);

    expect(fact.kind).toBeUndefined();
    expect(() => buildRemoteIndexV2([fact], "root", null))
      .toThrow("Remote identity incomplete: x");
  });

  it("preserves invalid lastModifiedDateTime as NaN instead of sanitizing it", () => {
    const [fact] = toRemoteScanFactsV1([{
      id: "bad",
      name: "bad.md",
      file: {},
      parentReference: { id: "root" },
      lastModifiedDateTime: "not-a-date",
    }]);

    expect(Number.isNaN(fact.mtime)).toBe(true);
    const projection = buildRemoteIndexV2([fact], "root", null);
    expect(projection.index.itemsById.bad?.mtime).toBeNaN();
    expect(JSON.stringify(projection.index)).toContain("\"mtime\":null");
  });

  it("lowercases sha256Hash and leaves quickXorHash byte-identical", () => {
    const facts = toRemoteScanFactsV1([
      {
        id: "sha",
        name: "sha.md",
        file: { hashes: { sha256Hash: "ABCDEF0123456789" } },
        parentReference: { id: "root" },
      },
      {
        id: "quick",
        name: "quick.md",
        file: { hashes: { quickXorHash: "Y0BDGthABgAAAAAABQAAAAAAAAA=" } },
        parentReference: { id: "root" },
      },
    ]);

    expect(facts[0].contentHash).toBe("abcdef0123456789");
    expect(facts[0].quickXorHash).toBeUndefined();
    expect(facts[1].contentHash).toBeUndefined();
    expect(facts[1].quickXorHash).toBe("Y0BDGthABgAAAAAABQAAAAAAAAA=");

    const projection = buildRemoteIndexV2(facts, "root", null);
    expect(projection.index.itemsById.sha?.contentHash).toBe("abcdef0123456789");
    expect(projection.index.itemsById.quick?.quickXorHash)
      .toBe("Y0BDGthABgAAAAAABQAAAAAAAAA=");
    expect(projection.index.itemsById.quick?.contentHash).toBeUndefined();
  });

  it("carries downloadUrl only on the transient fact and never into RemoteNodeV2", () => {
    const [fact] = toRemoteScanFactsV1([{
      id: "file-1",
      name: "note.md",
      file: {},
      parentReference: { id: "root" },
      "@microsoft.graph.downloadUrl": "https://download.example/file",
    }]);

    expect(fact.downloadUrl).toBe("https://download.example/file");
    const projection = buildRemoteIndexV2([fact], "root", null);
    const node = projection.index.itemsById["file-1"]!;
    expect(Object.keys(node)).toEqual([
      "id",
      "parentId",
      "name",
      "kind",
      "eTag",
      "cTag",
      "size",
      "mtime",
      "contentHash",
      "quickXorHash",
    ]);
    expect("downloadUrl" in node).toBe(false);
    expect(JSON.stringify(projection.index)).not.toContain("downloadUrl");
  });

  it("carries parentDriveId but leaves it out of RemoteNodeV2", () => {
    const [fact] = toRemoteScanFactsV1([{
      id: "file-1",
      name: "note.md",
      file: {},
      parentReference: { id: "root", driveId: "drive-1" },
    }]);

    expect(fact.parentDriveId).toBe("drive-1");
    const projection = buildRemoteIndexV2([fact], "root", null);
    const node = projection.index.itemsById["file-1"]!;
    expect("parentDriveId" in node).toBe(false);
    expect(JSON.stringify(projection.index)).not.toContain("parentDriveId");
  });

  it("keeps every missing optional field undefined instead of normalizing defaults", () => {
    const [fact] = toRemoteScanFactsV1([{
      id: "x",
      name: "x.md",
      file: {},
      parentReference: { id: "root" },
    }]);

    expect(fact.eTag).toBeUndefined();
    expect(fact.cTag).toBeUndefined();
    expect(fact.size).toBeUndefined();
    expect(fact.mtime).toBeUndefined();
    expect(fact.contentHash).toBeUndefined();
    expect(fact.quickXorHash).toBeUndefined();

    const projection = buildRemoteIndexV2([fact], "root", null);
    expect(JSON.stringify(projection.index.itemsById.x)).toBe(
      "{\"id\":\"x\",\"parentId\":\"root\",\"name\":\"x.md\",\"kind\":\"file\"}",
    );
  });

  it("keeps JSON.stringify(projection.index) byte-identical to the pre-change golden", () => {
    const projection = buildRemoteIndexV2(
      toRemoteScanFactsV1(goldenFixture()),
      "files-root",
      "delta-golden-1",
      3,
    );

    expect(JSON.stringify(projection.index)).toBe(
      "{\"schemaVersion\":2,\"filesRootId\":\"files-root\",\"cursorRevision\":3,\"deltaLink\":\"delta-golden-1\",\"complete\":true,\"itemsById\":{\"folder-a\":{\"id\":\"folder-a\",\"parentId\":\"files-root\",\"name\":\"Alpha\",\"kind\":\"folder\",\"eTag\":\"etag-a-1\",\"cTag\":\"ctag-a-1\"},\"folder-b\":{\"id\":\"folder-b\",\"parentId\":\"files-root\",\"name\":\"Beta\",\"kind\":\"folder\",\"eTag\":\"etag-b-1\"},\"file-1\":{\"id\":\"file-1\",\"parentId\":\"folder-a\",\"name\":\"note.md\",\"kind\":\"file\",\"eTag\":\"etag-f1\",\"cTag\":\"ctag-f1\",\"size\":42,\"mtime\":1767323045000,\"contentHash\":\"abcdef0123456789\"},\"file-2\":{\"id\":\"file-2\",\"parentId\":\"folder-a\",\"name\":\"image.png\",\"kind\":\"file\",\"size\":7,\"quickXorHash\":\"Y0BDGthABgAAAAAABQAAAAAAAAA=\"},\"dup\":{\"id\":\"dup\",\"parentId\":\"files-root\",\"name\":\"new.md\",\"kind\":\"file\",\"eTag\":\"etag-new\"},\"bad-date\":{\"id\":\"bad-date\",\"parentId\":\"folder-b\",\"name\":\"bad.md\",\"kind\":\"file\",\"eTag\":\"etag-bd\",\"mtime\":null}}}",
    );
  });

  it("keeps tombstone-last-wins and deleted-skip order identical to the pre-change builder", () => {
    const liveThenDeleted = buildRemoteIndexV2(toRemoteScanFactsV1([
      { id: "x", name: "x.md", file: {}, parentReference: { id: "root" } },
      { id: "x", name: "x.md", file: {}, parentReference: { id: "root" }, deleted: { state: "deleted" } },
    ]), "root", null);
    expect(liveThenDeleted.index.itemsById).toEqual({});

    const deletedThenLive = buildRemoteIndexV2(toRemoteScanFactsV1([
      { id: "x", name: "x.md", file: {}, parentReference: { id: "root" }, deleted: { state: "deleted" } },
      { id: "x", name: "x.md", file: {}, parentReference: { id: "root" } },
    ]), "root", null);
    expect(deletedThenLive.index.itemsById.x?.name).toBe("x.md");

    // The deleted skip runs before identity validation: a tombstone without a
    // parent or a file/folder facet must not raise.
    expect(() => buildRemoteIndexV2(toRemoteScanFactsV1([
      { id: "x", name: "x.md", deleted: {} },
    ]), "root", null)).not.toThrow();
  });
});
