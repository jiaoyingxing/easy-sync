import { describe, expect, it } from "vitest";
import {
  inspectReceiptedRenameAnchorCollisionV2,
  inspectRenameTargetAnchorCollisionV2,
  projectFileStatePathViewV2,
  reduceFileStateEnvelopeV2,
} from "../src/sync/file-state-reducer-v2";
import type { RemoteNodeV2 } from "../src/sync/remote-index-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import type {
  BaseFileEntry,
  MutationAction,
  MutationCheckpointV1,
  MutationLedgerEntryV1,
  RemoteFileEntry,
} from "../src/sync/types";

const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

const notesFolder: RemoteNodeV2 = {
  id: "folder-notes",
  parentId: scope.filesRootId,
  name: "Notes",
  kind: "folder",
};
const archiveFolder: RemoteNodeV2 = {
  id: "folder-archive",
  parentId: scope.filesRootId,
  name: "Archive",
  kind: "folder",
};

function remote(
  path: string,
  driveId: string,
  parentId: string,
  hash: string,
  eTag: string,
  size = 10,
): RemoteFileEntry {
  return {
    path,
    driveId,
    parentId,
    size,
    mtime: 20,
    eTag,
    cTag: `c-${eTag}`,
    sha256Hash: hash,
  };
}

function base(path: string, hash: string, eTag: string, size = 10): BaseFileEntry {
  return { path, hash, size, eTag };
}

function envelope(
  remoteEntries: RemoteFileEntry[],
  baseEntries: BaseFileEntry[],
): SyncStateEnvelopeV2 {
  const itemsById: Record<string, RemoteNodeV2> = {
    [notesFolder.id]: notesFolder,
    [archiveFolder.id]: archiveFolder,
  };
  for (const entry of remoteEntries) {
    itemsById[entry.driveId] = {
      id: entry.driveId,
      parentId: entry.parentId!,
      name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
      kind: "file",
      eTag: entry.eTag,
      cTag: entry.cTag,
      size: entry.size,
      mtime: entry.mtime,
      contentHash: entry.sha256Hash,
    };
  }
  const byAnchorId = Object.fromEntries(baseEntries.map((entry) => {
    const matchingRemote = remoteEntries.find((candidate) => candidate.path === entry.path)!;
    const anchorId = `anchor:${matchingRemote.driveId}`;
    return [anchorId, {
      anchorId,
      remoteId: matchingRemote.driveId,
      lastPath: entry.path,
      contentHash: entry.hash,
      size: entry.size,
      remoteETag: entry.eTag,
      confirmedAt: 1,
      confirmedBy: "equal-read" as const,
    }];
  }));
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 3, commitSeq: 7, committedAt: 1 },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 4,
      deltaLink: "delta",
      complete: true,
      itemsById,
    },
    anchors: { schemaVersion: 2, byAnchorId },
  };
}

function ledger(
  action: MutationAction,
  path: string,
  checkpoint: MutationCheckpointV1,
  sourcePath?: string,
): MutationLedgerEntryV1 {
  const operationId = `op:${action}:${path}`;
  return {
    intent: {
      version: 1,
      operationId,
      planRevision: 2,
      scope,
      action,
      path,
      sourcePath,
      expectedLocal: { exists: false },
      expectedRemote: { exists: false },
      createdAt: 10,
    },
    receipt: {
      version: 1,
      operationId,
      completedAt: 30,
      checkpoint,
    },
  };
}

function checkpoint(
  input: Partial<MutationCheckpointV1>,
): MutationCheckpointV1 {
  return {
    baseUpserts: [],
    baseRemovals: [],
    remoteUpserts: [],
    remoteDeletes: [],
    pendingConflictRemovals: [],
    pendingDeleteRemovals: [],
    ...input,
  };
}

describe("pure V2 file-state reducer", () => {
  const oldRemote = remote("Notes/a.md", "file-a", notesFolder.id, hashA, "etag-a");
  const oldBase = base(oldRemote.path, hashA, oldRemote.eTag);

  const cases: Array<{
    name: string;
    initialRemote: RemoteFileEntry[];
    initialBase: BaseFileEntry[];
    entry: MutationLedgerEntryV1;
    expectedRemote: RemoteFileEntry[];
    expectedBase: BaseFileEntry[];
  }> = [
    {
      name: "upload",
      initialRemote: [],
      initialBase: [],
      entry: ledger("upload", "Notes/new.md", checkpoint({
        remoteUpserts: [remote("Notes/new.md", "file-new", notesFolder.id, hashA, "etag-new")],
        baseUpserts: [base("Notes/new.md", hashA, "etag-new")],
      })),
      expectedRemote: [remote("Notes/new.md", "file-new", notesFolder.id, hashA, "etag-new")],
      expectedBase: [base("Notes/new.md", hashA, "etag-new")],
    },
    {
      name: "download",
      initialRemote: [oldRemote],
      initialBase: [],
      entry: ledger("download", oldRemote.path, checkpoint({
        baseUpserts: [oldBase],
      })),
      expectedRemote: [oldRemote],
      expectedBase: [oldBase],
    },
    {
      name: "delete remote",
      initialRemote: [oldRemote],
      initialBase: [oldBase],
      entry: ledger("deleteRemote", oldRemote.path, checkpoint({
        remoteDeletes: [oldRemote.path],
        baseRemovals: [oldRemote.path],
      })),
      expectedRemote: [],
      expectedBase: [],
    },
    {
      name: "delete local",
      initialRemote: [oldRemote],
      initialBase: [oldBase],
      entry: ledger("deleteLocal", oldRemote.path, checkpoint({
        baseRemovals: [oldRemote.path],
      })),
      expectedRemote: [oldRemote],
      expectedBase: [],
    },
    {
      name: "rename remote",
      initialRemote: [oldRemote],
      initialBase: [oldBase],
      entry: ledger("renameRemote", "Archive/a.md", checkpoint({
        remoteDeletes: [oldRemote.path],
        remoteUpserts: [
          remote("Archive/a.md", oldRemote.driveId, archiveFolder.id, hashA, "etag-renamed"),
        ],
        baseRemovals: [oldRemote.path],
        baseUpserts: [base("Archive/a.md", hashA, "etag-renamed")],
      }), oldRemote.path),
      expectedRemote: [
        remote("Archive/a.md", oldRemote.driveId, archiveFolder.id, hashA, "etag-renamed"),
      ],
      expectedBase: [base("Archive/a.md", hashA, "etag-renamed")],
    },
    {
      name: "merge",
      initialRemote: [oldRemote],
      initialBase: [oldBase],
      entry: ledger("merge", oldRemote.path, checkpoint({
        remoteUpserts: [
          remote(oldRemote.path, oldRemote.driveId, notesFolder.id, hashC, "etag-merged", 12),
        ],
        baseUpserts: [base(oldRemote.path, hashC, "etag-merged", 12)],
      })),
      expectedRemote: [
        remote(oldRemote.path, oldRemote.driveId, notesFolder.id, hashC, "etag-merged", 12),
      ],
      expectedBase: [base(oldRemote.path, hashC, "etag-merged", 12)],
    },
  ];

  it.each(cases)(
    "projects the expected base and remote file state after $name",
    ({ initialRemote, initialBase, entry, expectedRemote, expectedBase }) => {
      const initial = envelope(initialRemote, initialBase);
      const next = reduceFileStateEnvelopeV2(initial, entry);
      const projected = projectFileStatePathViewV2(next);

      expect(projected).toEqual({
        baseEntries: [...expectedBase].sort(comparePath),
        remoteEntries: [...expectedRemote].sort(comparePath),
      });
      expect(next.meta).toMatchObject({
        lifecycleEpoch: initial.meta.lifecycleEpoch,
        commitSeq: initial.meta.commitSeq + 1,
        committedAt: entry.receipt!.completedAt,
      });
      expect(initial).toEqual(envelope(initialRemote, initialBase));
    },
  );

  it("preserves the anchor identity across a remote rename", () => {
    const initial = envelope([oldRemote], [oldBase]);
    const entry = cases.find((candidate) => candidate.name === "rename remote")!.entry;
    const next = reduceFileStateEnvelopeV2(initial, entry);

    expect(Object.keys(next.anchors.byAnchorId)).toEqual([`anchor:${oldRemote.driveId}`]);
    expect(next.anchors.byAnchorId[`anchor:${oldRemote.driveId}`]).toMatchObject({
      remoteId: oldRemote.driveId,
      lastPath: "Archive/a.md",
      confirmedBy: "rename-cas",
    });
  });

  it("identifies the exact receipted rename target-anchor collision and accepts its cleanup upload", () => {
    const initial = envelope([oldRemote], [oldBase]);
    initial.anchors.byAnchorId["anchor:stale-target"] = {
      anchorId: "anchor:stale-target",
      remoteId: "stale-target",
      lastPath: "Archive/a.md",
      contentHash: hashB,
      size: 20,
      remoteETag: "etag-stale-target",
      confirmedAt: 1,
      confirmedBy: "equal-read",
    };
    const movedRemote = remote(
      "Archive/a.md",
      oldRemote.driveId,
      archiveFolder.id,
      hashA,
      "etag-renamed",
    );
    const blocked = ledger("renameRemote", movedRemote.path, checkpoint({
      remoteDeletes: [oldRemote.path],
      remoteUpserts: [movedRemote],
      baseRemovals: [oldRemote.path],
      baseUpserts: [base(movedRemote.path, hashA, movedRemote.eTag)],
    }), oldRemote.path);
    blocked.intent.expectedLocal = { exists: true, hash: hashA, size: 10 };
    blocked.intent.expectedRemote = {
      exists: true,
      driveId: oldRemote.driveId,
      eTag: oldRemote.eTag,
      size: oldRemote.size,
      sha256Hash: hashA,
    };

    expect(inspectRenameTargetAnchorCollisionV2(initial, {
      sourcePath: oldRemote.path,
      path: movedRemote.path,
      movedRemoteId: oldRemote.driveId,
      scope,
    })).toMatchObject({
      movedRemoteId: oldRemote.driveId,
      targetAnchor: { anchorId: "anchor:stale-target" },
    });

    expect(() => reduceFileStateEnvelopeV2(initial, blocked))
      .toThrow("V2 base upsert would replace another anchor");
    const collision = inspectReceiptedRenameAnchorCollisionV2(initial, blocked);
    expect(collision).toMatchObject({
      movedRemoteId: oldRemote.driveId,
      sourceAnchor: { anchorId: `anchor:${oldRemote.driveId}`, lastPath: oldRemote.path },
      targetAnchor: { anchorId: "anchor:stale-target", lastPath: movedRemote.path },
    });

    const uploaded = remote(
      movedRemote.path,
      "replacement-upload",
      archiveFolder.id,
      hashA,
      "etag-uploaded",
    );
    const replacement = ledger("upload", movedRemote.path, checkpoint({
      remoteDeletes: [oldRemote.path],
      remoteUpserts: [uploaded],
      baseRemovals: [oldRemote.path],
      baseUpserts: [base(movedRemote.path, hashA, uploaded.eTag)],
    }), oldRemote.path);
    replacement.intent.expectedLocal = { exists: true, hash: hashA, size: 10 };

    const recovered = reduceFileStateEnvelopeV2(initial, replacement);
    expect(projectFileStatePathViewV2(recovered)).toEqual({
      baseEntries: [base(movedRemote.path, hashA, uploaded.eTag)],
      remoteEntries: [uploaded],
    });
    expect(Object.values(recovered.anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        remoteId: uploaded.driveId,
        lastPath: uploaded.path,
        contentHash: hashA,
      }),
    ]);
  });

  it("commits a recovered local move against the already-moved remote identity", () => {
    const initial = envelope([oldRemote], [oldBase]);
    initial.remoteIndex.itemsById[oldRemote.driveId] = {
      ...initial.remoteIndex.itemsById[oldRemote.driveId],
      parentId: archiveFolder.id,
      name: "a.md",
      eTag: "etag-moved",
    };
    const movedRemote = remote(
      "Archive/a.md",
      oldRemote.driveId,
      archiveFolder.id,
      hashA,
      "etag-moved",
    );
    const entry = ledger("moveLocal", movedRemote.path, checkpoint({
      remoteDeletes: [oldRemote.path],
      remoteUpserts: [movedRemote],
      baseRemovals: [oldRemote.path],
      baseUpserts: [base(movedRemote.path, hashA, movedRemote.eTag)],
    }), oldRemote.path);

    const next = reduceFileStateEnvelopeV2(initial, entry);

    expect(projectFileStatePathViewV2(next)).toEqual({
      baseEntries: [base(movedRemote.path, hashA, movedRemote.eTag)],
      remoteEntries: [movedRemote],
    });
    expect(Object.values(next.anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        anchorId: `anchor:${oldRemote.driveId}`,
        remoteId: oldRemote.driveId,
        lastPath: movedRemote.path,
        remoteCTag: movedRemote.cTag,
        confirmedBy: "rename-cas",
      }),
    ]);
  });

  it("records lineage when a receipted file decision binds a same-path replacement ID", () => {
    const initial = envelope([oldRemote], [oldBase]);
    delete initial.remoteIndex.itemsById[oldRemote.driveId];
    const rebuilt = remote(
      oldRemote.path,
      "file-rebuilt",
      oldRemote.parentId!,
      oldBase.hash,
      "etag-rebuilt",
    );
    initial.remoteIndex.itemsById[rebuilt.driveId] = {
      id: rebuilt.driveId,
      parentId: rebuilt.parentId!,
      name: rebuilt.path.slice(rebuilt.path.lastIndexOf("/") + 1),
      kind: "file",
      eTag: rebuilt.eTag,
      cTag: rebuilt.cTag,
      size: rebuilt.size,
      mtime: rebuilt.mtime,
      contentHash: rebuilt.sha256Hash,
    };
    const next = reduceFileStateEnvelopeV2(
      initial,
      ledger("download", oldBase.path, checkpoint({
        baseUpserts: [{
          ...oldBase,
          eTag: rebuilt.eTag,
        }],
      })),
    );

    expect(Object.values(next.anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        anchorId: `anchor:${oldRemote.driveId}`,
        remoteId: rebuilt.driveId,
        remoteIdentityLineage: [{
          fromRemoteId: oldRemote.driveId,
          toRemoteId: rebuilt.driveId,
          path: oldBase.path,
          contentHash: oldBase.hash,
          size: oldBase.size,
          fromRemoteETag: oldRemote.eTag,
          toRemoteETag: rebuilt.eTag,
          confirmedAt: expect.any(Number),
          confirmedBy: "download-cas",
        }],
      }),
    ]);
  });

  it("returns the committed envelope unchanged when the same receipt is replayed", () => {
    for (const { initialRemote, initialBase, entry } of cases) {
      const first = reduceFileStateEnvelopeV2(
        envelope(initialRemote, initialBase),
        entry,
      );
      const replay = reduceFileStateEnvelopeV2(first, entry);
      expect(replay).toBe(first);
      expect(replay.meta.commitSeq).toBe(8);
    }
  });

  it("retires an anchor after its remote identity was already tombstoned", () => {
    const initial = envelope([oldRemote], [oldBase]);
    delete initial.remoteIndex.itemsById[oldRemote.driveId];
    const entry = ledger("deleteLocal", oldRemote.path, checkpoint({
      baseRemovals: [oldRemote.path],
    }));

    const next = reduceFileStateEnvelopeV2(initial, entry);

    expect(projectFileStatePathViewV2(next)).toEqual({
      baseEntries: [],
      remoteEntries: [],
    });
  });

  it("does not advance an incomplete, cancelled, failed, or unknown mutation without a receipt", () => {
    const initial = envelope([], []);
    const pending = ledger("upload", "Notes/new.md", checkpoint({}));
    pending.receipt = null;

    expect(() => reduceFileStateEnvelopeV2(initial, pending))
      .toThrow("requires a completed receipt");
    expect(initial.meta.commitSeq).toBe(7);
  });

  it("fails closed on scope drift, mismatched receipts, and missing remote identity", () => {
    const initial = envelope([], []);
    const mismatchedScope = ledger("upload", "Notes/new.md", checkpoint({}));
    mismatchedScope.intent.scope = { ...scope, driveId: "other" };
    expect(() => reduceFileStateEnvelopeV2(initial, mismatchedScope)).toThrow("scope");

    const mismatchedReceipt = ledger("upload", "Notes/new.md", checkpoint({}));
    mismatchedReceipt.receipt!.operationId = "other";
    expect(() => reduceFileStateEnvelopeV2(initial, mismatchedReceipt)).toThrow("does not match");

    const noRemoteIdentity = ledger("download", "Notes/new.md", checkpoint({
      baseUpserts: [base("Notes/new.md", hashB, "etag-new")],
    }));
    expect(() => reduceFileStateEnvelopeV2(initial, noRemoteIdentity))
      .toThrow("no remote file identity");
  });

  it("fails closed on incomplete parent identity and unreceipted identity moves", () => {
    const initial = envelope([oldRemote], [oldBase]);
    const missingParent = ledger("upload", oldRemote.path, checkpoint({
      remoteUpserts: [{ ...oldRemote, parentId: undefined }],
      baseUpserts: [oldBase],
    }));
    expect(() => reduceFileStateEnvelopeV2(initial, missingParent))
      .toThrow("missing a parent id");

    const missingSourceDelete = ledger("renameRemote", "Archive/a.md", checkpoint({
      remoteUpserts: [
        remote("Archive/a.md", oldRemote.driveId, archiveFolder.id, hashA, "etag-renamed"),
      ],
      baseRemovals: [oldRemote.path],
      baseUpserts: [base("Archive/a.md", hashA, "etag-renamed")],
    }), oldRemote.path);
    expect(() => reduceFileStateEnvelopeV2(initial, missingSourceDelete))
      .toThrow("invalid remote deletes");
  });

  it("rejects action-incomplete receipts before publishing V2 state", () => {
    const initial = envelope([oldRemote], [oldBase]);
    const malformedDelete = ledger("deleteRemote", oldRemote.path, checkpoint({
      baseRemovals: [oldRemote.path],
    }));
    expect(() => reduceFileStateEnvelopeV2(initial, malformedDelete))
      .toThrow("invalid remote deletes");

    const malformedDownload = ledger("download", oldRemote.path, checkpoint({
      baseUpserts: [oldBase],
      remoteDeletes: [oldRemote.path],
    }));
    expect(() => reduceFileStateEnvelopeV2(initial, malformedDownload))
      .toThrow("invalid remote deletes");

    const malformedMove = ledger("moveLocal", "Archive/a.md", checkpoint({
      remoteUpserts: [
        remote("Archive/a.md", oldRemote.driveId, archiveFolder.id, hashA, "etag-moved"),
      ],
      baseRemovals: [oldRemote.path],
      baseUpserts: [base("Archive/a.md", hashA, "etag-moved")],
    }), oldRemote.path);
    expect(() => reduceFileStateEnvelopeV2(initial, malformedMove))
      .toThrow("invalid remote deletes");
  });
});

function comparePath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
