import { describe, expect, it } from "vitest";
import type { LocalFileEntry } from "../src/sync/types";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import { planIdentityRenamesV2 } from "../src/sync/identity-rename-v2";

const hash = "a".repeat(64);

function local(path: string, contentHash = hash): LocalFileEntry {
  return { path, hash: contentHash, size: 4, mtime: 1, binary: false };
}

function envelope(): SyncStateEnvelopeV2 {
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq: 1, committedAt: 1 },
    scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "root" },
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: "root",
      cursorRevision: 1,
      deltaLink: null,
      complete: true,
      itemsById: {
        folder: { id: "folder", parentId: "root", name: "sub", kind: "folder" },
        file: { id: "file", parentId: "root", name: "old.md", kind: "file", eTag: "e1", size: 4, contentHash: hash },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        anchor: {
          anchorId: "anchor", remoteId: "file", lastPath: "old.md",
          contentHash: hash, size: 4, remoteETag: "e1",
          confirmedAt: 1, confirmedBy: "equal-read",
        },
      },
    },
  };
}

describe("identity-safe V2 rename planning", () => {
  it("moves the same remote ID for a unique local rename", () => {
    expect(planIdentityRenamesV2(envelope(), [local("new.md")])).toEqual([{
      type: "move-remote",
      anchorId: "anchor",
      remoteId: "file",
      fromPath: "old.md",
      toPath: "new.md",
      expectedRemoteETag: "e1",
      newName: "new.md",
      newParentId: "root",
    }]);
  });

  it("uses the destination folder ID for cross-directory moves", () => {
    expect(planIdentityRenamesV2(envelope(), [local("sub/new.md")])).toContainEqual(
      expect.objectContaining({
        type: "move-remote", remoteId: "file", newName: "new.md", newParentId: "folder",
      }),
    );
  });

  it("blocks a local rename when remote content changed", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.eTag = "e2";
    state.remoteIndex.itemsById.file!.contentHash = "b".repeat(64);
    expect(planIdentityRenamesV2(state, [local("new.md")])).toEqual([{
      type: "conflict", anchorId: "anchor", path: "old.md", reason: "remote-content-changed",
    }]);
  });

  it("blocks ambiguous same-content candidates and preserves remote identity", () => {
    expect(planIdentityRenamesV2(envelope(), [local("a.md"), local("b.md")])).toEqual([{
      type: "conflict", anchorId: "anchor", path: "old.md", reason: "local-identity-ambiguous",
    }]);
  });

  it("recognizes a remote path change by the same remote ID", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.parentId = "folder";
    state.remoteIndex.itemsById.file!.name = "new.md";
    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([{
      type: "move-local",
      anchorId: "anchor",
      remoteId: "file",
      fromPath: "old.md",
      toPath: "sub/new.md",
      expectedLocalHash: hash,
      expectedLocalSize: 4,
    }]);
  });

  it("does not transfer an anchor to a same-name object with a new remote ID", () => {
    const state = envelope();
    delete state.remoteIndex.itemsById.file;
    state.remoteIndex.itemsById.rebuilt = {
      id: "rebuilt", parentId: "root", name: "old.md", kind: "file", eTag: "e1", size: 4, contentHash: hash,
    };
    expect(planIdentityRenamesV2(state, [local("new.md")])).toEqual([{
      type: "conflict", anchorId: "anchor", path: "old.md", reason: "remote-identity-missing",
    }]);
  });
});
