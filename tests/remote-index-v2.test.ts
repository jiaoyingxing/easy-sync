import { describe, expect, it } from "vitest";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import type { DriveItem } from "../src/onedrive/types";

function folder(id: string, name: string, parentId: string): DriveItem {
  return { id, name, folder: {}, parentReference: { id: parentId }, eTag: `etag-${id}` };
}

function file(id: string, name: string, parentId: string, eTag = `etag-${id}`): DriveItem {
  return { id, name, file: {}, parentReference: { id: parentId }, eTag };
}

describe("S06 — RemoteIndexV2 staging identity and hierarchy", () => {
  it("derives paths from driveItem ID and parentId without parentReference.path", () => {
    const projection = buildRemoteIndexV2([
      folder("folder", "Notes", "vault-root"),
      file("note", "a.md", "folder"),
    ], "vault-root", "delta-1");

    expect(projection.pathById.get("note")).toBe("Notes/a.md");
    expect(projection.index.itemsById.note.parentId).toBe("folder");
    expect(projection.index.filesRootId).toBe("vault-root");
  });

  it("uses the final occurrence of a repeated driveItem ID", () => {
    const projection = buildRemoteIndexV2([
      file("note", "old.md", "vault-root", "etag-old"),
      file("note", "new.md", "vault-root", "etag-new"),
    ], "vault-root", "delta-2");

    expect(projection.pathById.get("note")).toBe("new.md");
    expect(projection.index.itemsById.note.eTag).toBe("etag-new");
  });

  it("rejects missing parents and parent cycles", () => {
    expect(() => buildRemoteIndexV2([
      file("note", "a.md", "missing"),
    ], "vault-root", null)).toThrow("missing parent");
    expect(() => buildRemoteIndexV2([
      folder("a", "A", "b"),
      folder("b", "B", "a"),
    ], "vault-root", null)).toThrow("cycle");
  });

  it("rejects normalized duplicate paths with different identities", () => {
    expect(() => buildRemoteIndexV2([
      file("a", "Note.md", "vault-root"),
      file("b", "note.md", "vault-root"),
    ], "vault-root", null)).toThrow("duplicate path");
  });
});
