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

  it("uses a folder identity that is moving to the destination path in the same plan", () => {
    expect(planIdentityRenamesV2(
      envelope(),
      [local("renamed/new.md")],
      {
        projectedFolderIdentities: [{
          path: "renamed",
          remoteId: "folder",
        }],
      },
    )).toContainEqual(expect.objectContaining({
      type: "move-remote",
      remoteId: "file",
      newName: "new.md",
      newParentId: "folder",
    }));
  });

  it("blocks a local rename when remote content changed", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.eTag = "e2";
    state.remoteIndex.itemsById.file!.contentHash = "b".repeat(64);
    expect(planIdentityRenamesV2(state, [local("new.md")])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPath: "new.md",
      reason: "remote-content-changed",
    }]);
  });

  it("blocks ambiguous same-content candidates and preserves remote identity", () => {
    expect(planIdentityRenamesV2(envelope(), [local("a.md"), local("b.md")])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPaths: ["a.md", "b.md"],
      reason: "local-identity-ambiguous",
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

  it("identifies a local file occupying the remote move target", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.parentId = "folder";
    state.remoteIndex.itemsById.file!.name = "new.md";

    expect(planIdentityRenamesV2(state, [
      local("old.md"),
      local("sub/new.md", "b".repeat(64)),
    ])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "sub/new.md",
      relatedPath: "old.md",
      reason: "local-destination-occupied",
    }]);
  });

  it("identifies a remote file occupying the local move target", () => {
    const state = envelope();
    state.remoteIndex.itemsById.copy = {
      id: "copy", parentId: "root", name: "new.md", kind: "file", eTag: "e2", size: 4, contentHash: "b".repeat(64),
    };

    expect(planIdentityRenamesV2(state, [local("new.md")])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "new.md",
      relatedPath: "old.md",
      reason: "remote-destination-occupied",
    }]);
  });

  it("prefers an exact remote SHA-256 over a changed content tag", () => {
    const state = envelope();
    const remote = state.remoteIndex.itemsById.file!;
    remote.parentId = "folder";
    remote.name = "new.md";
    remote.cTag = "ctag-content-2";
    state.anchors.byAnchorId.anchor!.remoteCTag = "ctag-content-1";

    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([
      expect.objectContaining({ type: "move-local" }),
    ]);
  });

  it("uses matching content tags when a moved remote file has no SHA-256", () => {
    const state = envelope();
    const remote = state.remoteIndex.itemsById.file!;
    remote.parentId = "folder";
    remote.name = "new.md";
    delete remote.contentHash;
    remote.cTag = "ctag-content-1";
    state.anchors.byAnchorId.anchor!.remoteCTag = "ctag-content-1";

    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([
      expect.objectContaining({
        type: "move-local",
        fromPath: "old.md",
        toPath: "sub/new.md",
      }),
    ]);
  });

  it("requests strict content verification for a legacy moved anchor", () => {
    const state = envelope();
    const remote = state.remoteIndex.itemsById.file!;
    remote.parentId = "folder";
    remote.name = "new.md";
    delete remote.contentHash;
    remote.cTag = "ctag-content-1";

    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([
      expect.objectContaining({
        type: "verify-move-local",
        fromPath: "old.md",
        toPath: "sub/new.md",
      }),
    ]);
  });

  it("follows a unilateral remote move with a changed content tag", () => {
    const state = envelope();
    const remote = state.remoteIndex.itemsById.file!;
    remote.parentId = "folder";
    remote.name = "new.md";
    delete remote.contentHash;
    remote.cTag = "ctag-content-2";
    state.anchors.byAnchorId.anchor!.remoteCTag = "ctag-content-1";

    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([
      expect.objectContaining({
        type: "move-local",
        fromPath: "old.md",
        toPath: "sub/new.md",
      }),
    ]);
  });

  it("follows a unilateral remote move+edit when the local side is unchanged", () => {
    const state = envelope();
    const remote = state.remoteIndex.itemsById.file!;
    remote.parentId = "folder";
    remote.name = "new.md";
    remote.eTag = "e2";
    remote.contentHash = "b".repeat(64);

    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([
      expect.objectContaining({
        type: "move-local",
        fromPath: "old.md",
        toPath: "sub/new.md",
        expectedLocalHash: hash,
      }),
    ]);
  });

  it("keeps the conflict when both sides diverged on a moved path", () => {
    const state = envelope();
    const remote = state.remoteIndex.itemsById.file!;
    remote.parentId = "folder";
    remote.name = "new.md";
    remote.eTag = "e2";
    remote.contentHash = "b".repeat(64);

    expect(planIdentityRenamesV2(state, [local("old.md", "c".repeat(64))])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPath: "sub/new.md",
      reason: "both-paths-diverged",
    }]);
  });

  it("keeps the conflict when only the local side changed on a moved path", () => {
    const state = envelope();
    const remote = state.remoteIndex.itemsById.file!;
    remote.parentId = "folder";
    remote.name = "new.md";

    expect(planIdentityRenamesV2(state, [local("old.md", "c".repeat(64))])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPath: "sub/new.md",
      reason: "both-paths-diverged",
    }]);
  });

  it("routes a same-path replacement into the dedicated identity reconciliation owner", () => {
    const state = envelope();
    delete state.remoteIndex.itemsById.file;
    state.remoteIndex.itemsById.rebuilt = {
      id: "rebuilt", parentId: "root", name: "old.md", kind: "file", eTag: "e2", size: 4, contentHash: hash,
    };
    expect(planIdentityRenamesV2(state, [local("old.md", "b".repeat(64))])).toEqual([{
      type: "reconcile-remote-identity",
      anchorId: "anchor",
      previousRemoteId: "file",
      remoteId: "rebuilt",
      path: "old.md",
      expectedRemoteETag: "e2",
    }]);
  });

  it("does not confuse an ordinary remote deletion with a file move", () => {
    const state = envelope();
    delete state.remoteIndex.itemsById.file;
    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([]);
  });

  it("marks a same-path replacement plus local relocation as unknown instead of a move", () => {
    const state = envelope();
    delete state.remoteIndex.itemsById.file;
    state.remoteIndex.itemsById.rebuilt = {
      id: "rebuilt", parentId: "root", name: "old.md", kind: "file", eTag: "e2", size: 4, contentHash: hash,
    };
    expect(planIdentityRenamesV2(state, [local("new.md")])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPath: "new.md",
      reason: "replacement-with-local-relocation",
    }]);
  });

  it("marks a copy occupying the anchor path while the old identity still exists", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.name = "moved.md";
    state.remoteIndex.itemsById.copy = {
      id: "copy", parentId: "root", name: "old.md", kind: "file", eTag: "e2", size: 4, contentHash: hash,
    };
    expect(planIdentityRenamesV2(state, [local("old.md")])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPath: "moved.md",
      reason: "same-path-identity-occupied",
    }]);
  });
});
