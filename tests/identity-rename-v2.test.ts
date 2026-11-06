import { describe, expect, it } from "vitest";
import type { LocalFileEntry, LocalFolderMoveHintV1 } from "../src/sync/types";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import { planIdentityRenamesV2 } from "../src/sync/identity-rename-v2";

const hash = "a".repeat(64);

function local(path: string, contentHash = hash): LocalFileEntry {
  return { path, hash: contentHash, size: 4, mtime: 1, binary: false };
}

function moveHint(
  fromPath: string,
  toPath: string,
  overrides: Partial<LocalFolderMoveHintV1> = {},
): LocalFolderMoveHintV1 {
  return {
    version: 1,
    scope: envelope().scope,
    remoteId: "file",
    fromPath,
    toPath,
    observedAt: 2,
    ...overrides,
  };
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

/** Envelope whose single folder identity is spelled `folderName`, with the
 *  anchor file living at the root (`old.md`) so a local match inside that
 *  folder is a relocation into a possibly alias-spelled parent. */
function aliasFolderEnvelope(folderName: string): SyncStateEnvelopeV2 {
  const state = envelope();
  state.remoteIndex.itemsById.folder = {
    id: "folder",
    parentId: "root",
    name: folderName,
    kind: "folder",
  };
  return state;
}

describe("identity-safe V2 rename planning", () => {
  it("moves the same remote ID for a unique local rename", () => {    expect(planIdentityRenamesV2(envelope(), [local("new.md")])).toEqual([{
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

  it("moves the local file when only the cloud name spelling changed", () => {
    // The cloud renamed `Meta分析.md` -> `meta分析.md`; the local file kept the
    // anchored spelling. The destination folded key holds that same local
    // entry, which is a spelling alias of the moved identity, not an occupant.
    const state = envelope();
    state.remoteIndex.itemsById.file!.name = "meta分析.md";
    state.anchors.byAnchorId.anchor!.lastPath = "Meta分析.md";

    expect(planIdentityRenamesV2(state, [local("Meta分析.md")])).toEqual([{
      type: "move-local",
      anchorId: "anchor",
      remoteId: "file",
      fromPath: "Meta分析.md",
      toPath: "meta分析.md",
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

  it("marks a same-path replacement plus a hinted relocation as unknown", () => {
    const state = envelope();
    delete state.remoteIndex.itemsById.file;
    state.remoteIndex.itemsById.rebuilt = {
      id: "rebuilt", parentId: "root", name: "old.md", kind: "file",
      eTag: "e2", size: 4, contentHash: "c".repeat(64),
    };
    expect(planIdentityRenamesV2(
      state,
      [local("sub/new.md", "b".repeat(64))],
      { localFileMoveHints: [moveHint("old.md", "sub/new.md")] },
    )).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPath: "sub/new.md",
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

  it("defers a relocated local file whose destination parent is only a spelling alias", () => {
    const state = aliasFolderEnvelope("videos");
    expect(planIdentityRenamesV2(state, [local("Videos/old.md")])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "Videos/old.md",
      relatedPath: "old.md",
      reason: "destination-parent-spelling-diverged",
    }]);
  });

  it("defers the mirrored spelling direction the same way", () => {
    const state = aliasFolderEnvelope("Videos");
    expect(planIdentityRenamesV2(state, [local("videos/old.md")])).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "videos/old.md",
      relatedPath: "old.md",
      reason: "destination-parent-spelling-diverged",
    }]);
  });

  it("still mirrors a relocation into a same-spelling destination folder", () => {
    const state = aliasFolderEnvelope("videos");
    expect(planIdentityRenamesV2(state, [local("videos/old.md")])).toEqual([{
      type: "move-remote",
      anchorId: "anchor",
      remoteId: "file",
      fromPath: "old.md",
      toPath: "videos/old.md",
      expectedRemoteETag: "e1",
      newName: "old.md",
      newParentId: "folder",
    }]);
  });

  it("recognizes an in-scope rename + edit + move through the host move hint", () => {
    const edited = "b".repeat(64);
    expect(planIdentityRenamesV2(
      envelope(),
      [local("sub/new.md", edited)],
      { localFileMoveHints: [moveHint("old.md", "sub/new.md")] },
    )).toEqual([{
      type: "move-remote",
      anchorId: "anchor",
      remoteId: "file",
      fromPath: "old.md",
      toPath: "sub/new.md",
      expectedRemoteETag: "e1",
      newName: "new.md",
      newParentId: "folder",
    }]);
  });

  it("prefers the host move hint over a content-identical candidate elsewhere", () => {
    const edited = "b".repeat(64);
    expect(planIdentityRenamesV2(
      envelope(),
      [local("copy.md"), local("sub/new.md", edited)],
      { localFileMoveHints: [moveHint("old.md", "sub/new.md")] },
    )).toEqual([expect.objectContaining({
      type: "move-remote",
      toPath: "sub/new.md",
    })]);
  });

  it("blocks identity pairing when the hinted destination disappeared", () => {
    expect(planIdentityRenamesV2(
      envelope(),
      [local("copy.md"), local("sub/other.md", "c".repeat(64))],
      { localFileMoveHints: [moveHint("old.md", "sub/missing.md")] },
    )).toEqual([]);
  });

  it("keeps the conflict when the hinted destination belongs to another anchor", () => {
    const state = envelope();
    state.remoteIndex.itemsById.other = {
      id: "other", parentId: "folder", name: "new.md", kind: "file",
      eTag: "e2", size: 4, contentHash: "c".repeat(64),
    };
    state.anchors.byAnchorId.other = {
      anchorId: "other", remoteId: "other", lastPath: "sub/new.md",
      contentHash: "c".repeat(64), size: 4, remoteETag: "e2",
      confirmedAt: 1, confirmedBy: "equal-read",
    };
    expect(planIdentityRenamesV2(
      state,
      [local("sub/new.md", "b".repeat(64))],
      { localFileMoveHints: [moveHint("old.md", "sub/new.md")] },
    )).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "sub/new.md",
      relatedPath: "old.md",
      reason: "local-destination-occupied",
    }]);
  });

  it("keeps the conflict when the hinted relocation meets a remote edit", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.eTag = "e2";
    state.remoteIndex.itemsById.file!.contentHash = "b".repeat(64);
    expect(planIdentityRenamesV2(
      state,
      [local("sub/new.md", "c".repeat(64))],
      { localFileMoveHints: [moveHint("old.md", "sub/new.md")] },
    )).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "old.md",
      relatedPath: "sub/new.md",
      reason: "remote-content-changed",
    }]);
  });

  it("keeps the conflict when the remote also moved before the hinted relocation", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.parentId = "folder";
    state.remoteIndex.itemsById.file!.name = "moved.md";
    expect(planIdentityRenamesV2(
      state,
      [local("sub/new.md", "b".repeat(64))],
      { localFileMoveHints: [moveHint("old.md", "sub/new.md")] },
    )).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "sub/new.md",
      reason: "both-paths-diverged",
    }]);
  });

  it("ignores a move hint from another sync scope", () => {
    expect(planIdentityRenamesV2(
      envelope(),
      [local("sub/new.md", "b".repeat(64))],
      {
        localFileMoveHints: [moveHint("old.md", "sub/new.md", {
          scope: { ...envelope().scope, driveId: "other-drive" },
        })],
      },
    )).toEqual([]);
  });

  it("ignores a move hint into the vault trash", () => {
    expect(planIdentityRenamesV2(
      envelope(),
      [local("sub/new.md", "b".repeat(64))],
      { localFileMoveHints: [moveHint("old.md", ".trash/new.md")] },
    )).toEqual([]);
  });

  it("ignores a move hint whose source no longer matches the anchor", () => {
    expect(planIdentityRenamesV2(
      envelope(),
      [local("sub/new.md", "b".repeat(64))],
      { localFileMoveHints: [moveHint("elsewhere.md", "sub/new.md")] },
    )).toEqual([]);
  });

  it("treats two identities claiming one hinted destination as ambiguous", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file2 = {
      id: "file2", parentId: "root", name: "old2.md", kind: "file",
      eTag: "e2", size: 4, contentHash: "d".repeat(64),
    };
    state.anchors.byAnchorId.anchor2 = {
      anchorId: "anchor2", remoteId: "file2", lastPath: "old2.md",
      contentHash: "d".repeat(64), size: 4, remoteETag: "e2",
      confirmedAt: 1, confirmedBy: "equal-read",
    };
    const actions = planIdentityRenamesV2(
      state,
      [local("sub/shared.md", "b".repeat(64))],
      {
        localFileMoveHints: [
          moveHint("old.md", "sub/shared.md"),
          moveHint("old2.md", "sub/shared.md", { remoteId: "file2" }),
        ],
      },
    );
    expect(actions).toHaveLength(2);
    expect(actions).toContainEqual({
      type: "conflict",
      anchorId: "anchor",
      path: "sub/shared.md",
      relatedPaths: ["old2.md"],
      reason: "local-identity-ambiguous",
    });
    expect(actions).toContainEqual({
      type: "conflict",
      anchorId: "anchor2",
      path: "sub/shared.md",
      relatedPaths: ["old.md"],
      reason: "local-identity-ambiguous",
    });
  });

  it("withholds a hinted move whose destination folder is only projected", () => {
    expect(planIdentityRenamesV2(
      envelope(),
      [local("renamed/new.md", "b".repeat(64))],
      {
        projectedFolderIdentities: [{ path: "renamed", remoteId: "folder" }],
        localFileMoveHints: [moveHint("old.md", "renamed/new.md")],
      },
    )).toEqual([{
      type: "conflict",
      anchorId: "anchor",
      path: "renamed/new.md",
      relatedPath: "old.md",
      reason: "destination-parent-missing",
    }]);
  });

  it("treats a hinted destination already equal to the remote path as converged", () => {
    const state = envelope();
    state.remoteIndex.itemsById.file!.parentId = "folder";
    state.remoteIndex.itemsById.file!.name = "new.md";
    expect(planIdentityRenamesV2(
      state,
      [local("sub/new.md", "b".repeat(64))],
      { localFileMoveHints: [moveHint("old.md", "sub/new.md")] },
    )).toEqual([]);
  });
});
