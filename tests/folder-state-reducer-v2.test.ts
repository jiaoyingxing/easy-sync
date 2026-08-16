import { describe, expect, it } from "vitest";
import type { DriveItem } from "../src/onedrive/types";
import { reduceFolderStateEnvelopeV2 } from "../src/sync/folder-state-reducer-v2";
import { buildRemoteIndexV2 } from "../src/sync/remote-index-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type {
  FolderMutationIntentV2,
  MutationLedgerEntryV1,
  RemoteFolderEntry,
} from "../src/sync/types";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};

function envelope(folders: DriveItem[] = []): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 1,
      commitSeq: 3,
      committedAt: 1,
    },
    scope,
    remoteIndex: buildRemoteIndexV2(folders, scope.filesRootId, "delta", 2).index,
    anchors: { schemaVersion: 2, byAnchorId: {} },
    folderAnchors: { schemaVersion: 2, byAnchorId: {} },
  };
}

function intent(
  action: FolderMutationIntentV2["action"],
  path: string,
  remote?: RemoteFolderEntry,
): FolderMutationIntentV2 {
  return {
    version: 2,
    operationId: `op-${action}-${path}`,
    planRevision: 1,
    scope,
    action,
    path,
    expectedLocal: { exists: action === "createRemoteFolder" },
    expectedRemote: remote
      ? {
          exists: true,
          driveId: remote.driveId,
          parentId: remote.parentId,
          eTag: remote.eTag,
        }
      : { exists: false },
    expectedParent: {
      driveId: remote?.parentId ?? scope.filesRootId,
      path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    },
    createdAt: 10,
  };
}

function receipt(
  folderIntent: FolderMutationIntentV2,
  folder: RemoteFolderEntry,
): MutationLedgerEntryV1 {
  return {
    intent: folderIntent,
    receipt: {
      version: 1,
      operationId: folderIntent.operationId,
      completedAt: 20,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
        folderUpserts: [folder],
      },
    },
  };
}

describe("V2 folder-create reducer", () => {
  it("adds a remotely created folder identity and same-generation anchor", () => {
    const current = envelope();
    const folder: RemoteFolderEntry = {
      path: "Empty",
      driveId: "folder-empty",
      parentId: scope.filesRootId,
      name: "Empty",
      eTag: "etag-empty",
    };
    const record = receipt(intent("createRemoteFolder", folder.path), folder);

    const next = reduceFolderStateEnvelopeV2(current, record);

    expect(next.meta).toMatchObject({ commitSeq: 4, committedAt: 20 });
    expect(next.remoteIndex.itemsById[folder.driveId]).toMatchObject({
      id: folder.driveId,
      parentId: scope.filesRootId,
      name: "Empty",
      kind: "folder",
      eTag: "etag-empty",
    });
    expect(next.folderAnchors!.byAnchorId[`folder:${folder.driveId}`]).toMatchObject({
      remoteId: folder.driveId,
      lastPath: folder.path,
      parentRemoteId: scope.filesRootId,
      confirmedGeneration: 4,
      confirmedAt: 20,
    });
  });

  it("anchors a locally created folder to the existing remote identity", () => {
    const remoteItem: DriveItem = {
      id: "folder-cloud",
      name: "Cloud",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-cloud",
    };
    const current = envelope([remoteItem]);
    const folder: RemoteFolderEntry = {
      path: "Cloud",
      driveId: remoteItem.id,
      parentId: scope.filesRootId,
      name: remoteItem.name,
      eTag: remoteItem.eTag,
    };
    const record = receipt(intent("createLocalFolder", folder.path, folder), folder);

    const next = reduceFolderStateEnvelopeV2(current, record);

    expect(next.meta.commitSeq).toBe(4);
    expect(next.folderAnchors!.byAnchorId[`folder:${folder.driveId}`]).toMatchObject({
      remoteId: folder.driveId,
      lastPath: "Cloud",
    });
  });

  it("replays a committed receipt without publishing another generation", () => {
    const folder: RemoteFolderEntry = {
      path: "Empty",
      driveId: "folder-empty",
      parentId: scope.filesRootId,
      name: "Empty",
      eTag: "etag-empty",
    };
    const record = receipt(intent("createRemoteFolder", folder.path), folder);
    const once = reduceFolderStateEnvelopeV2(envelope(), record);

    expect(reduceFolderStateEnvelopeV2(once, record)).toBe(once);
  });

  it("rejects a receipt that would replace a different path identity", () => {
    const occupied: DriveItem = {
      id: "folder-existing",
      name: "Empty",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-existing",
    };
    const folder: RemoteFolderEntry = {
      path: "Empty",
      driveId: "folder-other",
      parentId: scope.filesRootId,
      name: "Empty",
      eTag: "etag-other",
    };
    const record = receipt(intent("createRemoteFolder", folder.path), folder);

    expect(() => reduceFolderStateEnvelopeV2(envelope([occupied]), record))
      .toThrow("replace another identity");
  });

  it("rejects folder receipts that smuggle file-state mutations", () => {
    const folder: RemoteFolderEntry = {
      path: "New",
      driveId: "folder-new",
      parentId: scope.filesRootId,
      name: "New",
      eTag: "etag-new",
    };
    const record = receipt(intent("createRemoteFolder", folder.path), folder);
    record.receipt!.checkpoint.remoteDeletes.push("Notes/a.md");

    expect(() => reduceFolderStateEnvelopeV2(envelope(), record))
      .toThrow("contains file state");
  });

  it("moves one folder identity and reprojects its entire anchored subtree once", () => {
    const current = envelope([
      {
        id: "folder",
        name: "Notes",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder",
      },
      {
        id: "child",
        name: "Child",
        folder: {},
        parentReference: { id: "folder" },
        eTag: "etag-child",
      },
      {
        id: "file",
        name: "a.md",
        file: { hashes: { sha256Hash: "a".repeat(64) } },
        size: 10,
        parentReference: { id: "child" },
        eTag: "etag-file",
        cTag: "ctag-file",
      },
    ]);
    current.folderAnchors!.byAnchorId = {
      "folder:folder": {
        anchorId: "folder:folder",
        remoteId: "folder",
        lastPath: "Notes",
        parentRemoteId: scope.filesRootId,
        remoteETag: "etag-folder",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
      "folder:child": {
        anchorId: "folder:child",
        remoteId: "child",
        lastPath: "Notes/Child",
        parentRemoteId: "folder",
        remoteETag: "etag-child",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
    };
    current.anchors.byAnchorId = {
      "file:file": {
        anchorId: "file:file",
        remoteId: "file",
        lastPath: "Notes/Child/a.md",
        contentHash: "a".repeat(64),
        size: 10,
        remoteETag: "etag-file",
        confirmedAt: 1,
        confirmedBy: "equal-read",
      },
    };
    const moved: RemoteFolderEntry = {
      path: "Archive",
      driveId: "folder",
      parentId: scope.filesRootId,
      name: "Archive",
      eTag: "etag-folder-2",
    };
    const moveIntent: FolderMutationIntentV2 = {
      ...intent("moveRemoteFolder", moved.path, {
        ...moved,
        path: "Notes",
        eTag: "etag-folder",
      }),
      sourcePath: "Notes",
      folderId: "folder",
      expectedLocal: { exists: true },
      expectedRemote: {
        exists: true,
        driveId: "folder",
        parentId: scope.filesRootId,
        eTag: "etag-folder",
      },
    };
    const record = receipt(moveIntent, moved);

    const next = reduceFolderStateEnvelopeV2(current, record);

    expect(next.folderAnchors!.byAnchorId["folder:folder"].lastPath).toBe("Archive");
    expect(next.folderAnchors!.byAnchorId["folder:child"].lastPath).toBe("Archive/Child");
    expect(next.anchors.byAnchorId["file:file"]).toMatchObject({
      lastPath: "Archive/Child/a.md",
      confirmedBy: "folder-move-cas",
    });
    expect(reduceFolderStateEnvelopeV2(next, record)).toBe(next);
  });

  it("rebases reviewed two-sided moves from the last committed path", () => {
    const current = envelope([
      {
        id: "folder",
        name: "Cloud",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-cloud",
      },
      {
        id: "file",
        name: "a.md",
        file: { hashes: { sha256Hash: "a".repeat(64) } },
        size: 10,
        parentReference: { id: "folder" },
        eTag: "etag-file",
        cTag: "ctag-file",
      },
    ]);
    current.folderAnchors!.byAnchorId = {
      "folder:folder": {
        anchorId: "folder:folder",
        remoteId: "folder",
        lastPath: "Notes",
        parentRemoteId: scope.filesRootId,
        remoteETag: "etag-notes",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
    };
    current.anchors.byAnchorId = {
      "file:file": {
        anchorId: "file:file",
        remoteId: "file",
        lastPath: "Notes/a.md",
        contentHash: "a".repeat(64),
        size: 10,
        remoteETag: "etag-file",
        confirmedAt: 1,
        confirmedBy: "equal-read",
      },
    };
    const moved: RemoteFolderEntry = {
      path: "Archive",
      driveId: "folder",
      parentId: scope.filesRootId,
      name: "Archive",
      eTag: "etag-archive",
    };
    const moveIntent: FolderMutationIntentV2 = {
      ...intent("moveRemoteFolder", moved.path, {
        ...moved,
        path: "Cloud",
        name: "Cloud",
        eTag: "etag-cloud",
      }),
      sourcePath: "Cloud",
      folderId: "folder",
      expectedLocal: { exists: true },
      reviewedLocationMove: {
        version: 1,
        sourceCommitSeq: 3,
        sourceLifecycleEpoch: 1,
        sourceAnchorPath: "Notes",
      },
    };
    const record = receipt(moveIntent, moved);

    const next = reduceFolderStateEnvelopeV2(current, record);

    expect(next.folderAnchors!.byAnchorId["folder:folder"]).toMatchObject({
      lastPath: "Archive",
      remoteETag: "etag-archive",
    });
    expect(next.anchors.byAnchorId["file:file"]).toMatchObject({
      lastPath: "Archive/a.md",
      confirmedBy: "folder-move-cas",
    });
    expect(reduceFolderStateEnvelopeV2(next, record)).toBe(next);

    const changed = structuredClone(current);
    changed.meta.commitSeq = 4;
    expect(() => reduceFolderStateEnvelopeV2(changed, record))
      .toThrow("Reviewed folder location source changed");
  });

  it("retires only an empty folder identity and replays safely", () => {
    const current = envelope([{
      id: "empty",
      name: "Empty",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-empty",
    }]);
    current.folderAnchors!.byAnchorId = {
      "folder:empty": {
        anchorId: "folder:empty",
        remoteId: "empty",
        lastPath: "Empty",
        parentRemoteId: scope.filesRootId,
        remoteETag: "etag-empty",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
    };
    const deleteIntent: FolderMutationIntentV2 = {
      ...intent("deleteRemoteFolder", "Empty", {
        path: "Empty",
        driveId: "empty",
        parentId: scope.filesRootId,
        name: "Empty",
        eTag: "etag-empty",
      }),
      folderId: "empty",
      expectedLocal: { exists: false },
    };
    const record: MutationLedgerEntryV1 = {
      intent: deleteIntent,
      receipt: {
        version: 1,
        operationId: deleteIntent.operationId,
        completedAt: 20,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
          folderDeletes: [{ path: "Empty", driveId: "empty" }],
        },
      },
    };

    const next = reduceFolderStateEnvelopeV2(current, record);

    expect(next.remoteIndex.itemsById.empty).toBeUndefined();
    expect(next.folderAnchors!.byAnchorId["folder:empty"]).toBeUndefined();
    expect(reduceFolderStateEnvelopeV2(next, record)).toBe(next);
  });

  it("atomically retires descendants whose remote identities are already absent", () => {
    const current = envelope();
    current.folderAnchors!.byAnchorId = {
      "folder:notes": {
        anchorId: "folder:notes",
        remoteId: "notes",
        lastPath: "Notes",
        parentRemoteId: scope.filesRootId,
        remoteETag: "etag-notes",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
      "folder:child": {
        anchorId: "folder:child",
        remoteId: "child",
        lastPath: "Notes/Child",
        parentRemoteId: "notes",
        remoteETag: "etag-child",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
    };
    current.anchors.byAnchorId = {
      "file:file": {
        anchorId: "file:file",
        remoteId: "file",
        lastPath: "Notes/Child/a.md",
        contentHash: "a".repeat(64),
        size: 10,
        remoteETag: "etag-file",
        confirmedAt: 1,
        confirmedBy: "equal-read",
      },
    };
    const deleteIntent: FolderMutationIntentV2 = {
      ...intent("deleteLocalFolder", "Notes"),
      folderId: "notes",
      expectedLocal: { exists: false },
      expectedRemote: { exists: false },
    };
    const record: MutationLedgerEntryV1 = {
      intent: deleteIntent,
      receipt: {
        version: 1,
        operationId: deleteIntent.operationId,
        completedAt: 20,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
          folderDeletes: [{ path: "Notes", driveId: "notes" }],
        },
      },
    };

    const next = reduceFolderStateEnvelopeV2(current, record);

    expect(next.meta).toMatchObject({ commitSeq: 4, committedAt: 20 });
    expect(next.anchors.byAnchorId).toEqual({});
    expect(next.folderAnchors!.byAnchorId).toEqual({});
    expect(reduceFolderStateEnvelopeV2(next, record)).toBe(next);
  });

  it("rejects descendant retirement while any anchored remote identity remains", () => {
    const current = envelope([
      {
        id: "notes",
        name: "Notes",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-notes",
      },
      {
        id: "file",
        name: "a.md",
        file: { hashes: { sha256Hash: "a".repeat(64) } },
        size: 10,
        parentReference: { id: "notes" },
        eTag: "etag-file",
        cTag: "ctag-file",
      },
    ]);
    current.folderAnchors!.byAnchorId = {
      "folder:notes": {
        anchorId: "folder:notes",
        remoteId: "notes",
        lastPath: "Notes",
        parentRemoteId: scope.filesRootId,
        remoteETag: "etag-notes",
        confirmedGeneration: 3,
        confirmedAt: 1,
      },
    };
    current.anchors.byAnchorId = {
      "file:file": {
        anchorId: "file:file",
        remoteId: "file",
        lastPath: "Notes/a.md",
        contentHash: "a".repeat(64),
        size: 10,
        remoteETag: "etag-file",
        confirmedAt: 1,
        confirmedBy: "equal-read",
      },
    };
    const deleteIntent: FolderMutationIntentV2 = {
      ...intent("deleteLocalFolder", "Notes"),
      folderId: "notes",
      expectedLocal: { exists: false },
      expectedRemote: { exists: false },
    };
    const record: MutationLedgerEntryV1 = {
      intent: deleteIntent,
      receipt: {
        version: 1,
        operationId: deleteIntent.operationId,
        completedAt: 20,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
          folderDeletes: [{ path: "Notes", driveId: "notes" }],
        },
      },
    };

    expect(() => reduceFolderStateEnvelopeV2(current, record))
      .toThrow("still has committed descendants");
  });
});
