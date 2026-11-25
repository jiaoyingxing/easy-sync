import { describe, expect, it } from "vitest";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import { toRemoteScanFactsV1 } from "../src/sync/remote-facts-adapter";
import type { DriveItem } from "../src/onedrive/types";

function folder(id: string, name: string, parentId: string): DriveItem {
  return { id, name, folder: {}, parentReference: { id: parentId }, eTag: `etag-${id}` };
}

function file(id: string, name: string, parentId: string, eTag = `etag-${id}`): DriveItem {
  return { id, name, file: {}, parentReference: { id: parentId }, eTag };
}

describe("S06 — RemoteIndexV2 staging identity and hierarchy", () => {
  it("derives paths from driveItem ID and parentId without parentReference.path", () => {
    const projection = buildRemoteIndexV2(toRemoteScanFactsV1([
      folder("folder", "Notes", "vault-root"),
      file("note", "a.md", "folder"),
    ]), "vault-root", "delta-1");

    expect(projection.pathById.get("note")).toBe("Notes/a.md");
    expect(projection.index.itemsById.note.parentId).toBe("folder");
    expect(projection.index.filesRootId).toBe("vault-root");
  });

  it("uses the final occurrence of a repeated driveItem ID", () => {
    const projection = buildRemoteIndexV2(toRemoteScanFactsV1([
      file("note", "old.md", "vault-root", "etag-old"),
      file("note", "new.md", "vault-root", "etag-new"),
    ]), "vault-root", "delta-2");

    expect(projection.pathById.get("note")).toBe("new.md");
    expect(projection.index.itemsById.note.eTag).toBe("etag-new");
  });

  it("rejects missing parents and parent cycles", () => {
    expect(() => buildRemoteIndexV2(toRemoteScanFactsV1([
      file("note", "a.md", "missing"),
    ]), "vault-root", null)).toThrow("missing parent");
    expect(() => buildRemoteIndexV2(toRemoteScanFactsV1([
      folder("a", "A", "b"),
      folder("b", "B", "a"),
    ]), "vault-root", null)).toThrow("cycle");
  });

  it("rejects normalized duplicate paths with different identities", () => {
    expect(() => buildRemoteIndexV2(toRemoteScanFactsV1([
      file("a", "Note.md", "vault-root"),
      file("b", "note.md", "vault-root"),
    ]), "vault-root", null)).toThrow("duplicate path");
  });
});

/** Mixed Graph fixture pinned before B2a changed the builder input. */
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

describe("B2a — neutral remote scan facts", () => {
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
    expect([...projection.pathById.entries()]).toEqual([
      ["folder-a", "Alpha"],
      ["folder-b", "Beta"],
      ["file-1", "Alpha/note.md"],
      ["file-2", "Alpha/image.png"],
      ["dup", "new.md"],
      ["bad-date", "Beta/bad.md"],
    ]);
  });

  it("keeps tombstone-last-wins and deleted-skip order identical to the pre-change builder", () => {
    const liveThenDeleted = buildRemoteIndexV2(toRemoteScanFactsV1([
      file("x", "x.md", "vault-root"),
      { ...file("x", "x.md", "vault-root"), deleted: { state: "deleted" } },
    ]), "vault-root", null);
    expect(liveThenDeleted.index.itemsById).toEqual({});

    const deletedThenLive = buildRemoteIndexV2(toRemoteScanFactsV1([
      { ...file("x", "x.md", "vault-root"), deleted: { state: "deleted" } },
      file("x", "x.md", "vault-root"),
    ]), "vault-root", null);
    expect(deletedThenLive.index.itemsById.x?.name).toBe("x.md");

    // A tombstone is skipped before identity validation: deleted items without
    // a parent or a file/folder facet must not raise.
    expect(() => buildRemoteIndexV2(toRemoteScanFactsV1([
      { id: "x", name: "x.md", deleted: {} },
    ]), "vault-root", null)).not.toThrow();
  });
});
