import { describe, expect, it, vi } from "vitest";
import { SyncExecutor, type SyncResult } from "../src/sync/sync-executor";
import { isOrdinaryFileRecoveryRecord } from "../src/sync/conservative-reset-recovery";
import {
  projectRemoteIndexV2,
} from "../src/sync/remote-index-v2";
import {
  reduceFileStateEnvelopeV2,
} from "../src/sync/file-state-reducer-v2";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import type { LocalScanner } from "../src/sync/local-scanner";
import type {
  MutationCheckpointV1,
  MutationLedgerEntryV1,
  MutationReceiptV1,
  SyncScope,
} from "../src/sync/types";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import {
  graphFolder,
  driveItem,
  emptyScanner,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
  TEST_SYNC_SCOPE,
} from "./helpers/sync-safety-harness";

/**
 * renameRemote destination-spelling alias rebase (2026-10-14 field case F27,
 * 2026-10-17 user decision Q1「乙」).
 *
 * The field shape: the file's anchor sits at the vault root (`x.md`), the user
 * moved the local file into a local folder spelled `Videos`, and the cloud
 * directory is spelled `videos`. The execution layer moved the cloud object
 * (root → `videos/`) and wrote a durable receipt under the local spelling
 * `Videos/x.md`, but the committed index projects the identity at its cloud
 * spelling `videos/x.md`. The reducer then refuses the record twice —
 * `V2 remote upsert parent does not match path: Videos` against the pre-move
 * tree, `V2 remote move is missing its source deletion: videos/x.md` against
 * the refreshed one — and the record freezes every file decision.
 *
 * The knife under test: read back BOTH spellings from the live service, prove
 * they are one object under the receipt's parent/version, then atomically
 * re-spell the destination paths (intent.path plus the receipt's base/upsert
 * path) to the committed index spelling and retry the commit — zero remote
 * writes, and any missing fact leaves the record blocked exactly as before.
 */

const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
const fileHash = "a".repeat(64);
const fileSize = 10;
const fileId = "file-field";
const folderId = "folder-videos";
const fileETag = "etag-moved";
const localPath = "Videos/x.md";
const indexPath = "videos/x.md";
const sourcePath = "x.md";

function fieldCheckpoint(input: {
  path?: string;
  sourcePath?: string;
  driveId?: string;
  eTag?: string;
} = {}): MutationCheckpointV1 {
  const path = input.path ?? localPath;
  const source = input.sourcePath ?? sourcePath;
  const eTag = input.eTag ?? fileETag;
  return {
    baseUpserts: [{ path, hash: fileHash, size: fileSize, eTag }],
    baseRemovals: [source],
    remoteUpserts: [{
      path,
      driveId: input.driveId ?? fileId,
      parentId: folderId,
      size: fileSize,
      mtime: 5,
      eTag,
      cTag: "ctag",
      sha256Hash: fileHash,
    }],
    remoteDeletes: [source],
    pendingConflictRemovals: [],
    pendingDeleteRemovals: [],
  };
}

function fieldRecord(input: {
  sourcePath?: string;
  path?: string;
  driveId?: string;
  receipt?: MutationReceiptV1 | null;
} = {}): MutationLedgerEntryV1 {
  const path = input.path ?? localPath;
  const source = input.sourcePath ?? sourcePath;
  const driveId = input.driveId ?? fileId;
  const operationId = "op-rename-field";
  const receipt: MutationReceiptV1 = {
    version: 1,
    operationId,
    completedAt: 2,
    checkpoint: fieldCheckpoint({ path, sourcePath: source, driveId }),
  };
  return {
    intent: {
      version: 1,
      operationId,
      planRevision: 1,
      scope,
      action: "renameRemote",
      path,
      sourcePath: source,
      expectedLocal: { exists: true, hash: fileHash, size: fileSize },
      expectedRemote: {
        exists: true,
        driveId,
        eTag: fileETag,
        size: fileSize,
        sha256Hash: fileHash,
      },
      createdAt: 1,
    },
    receipt: input.receipt === undefined ? receipt : input.receipt,
  };
}

function fieldEnvelope(input: {
  indexPath?: string;
  nodeParentId?: string;
  nodeETag?: string;
  anchorPath?: string;
} = {}): SyncStateEnvelopeV2 {
  const index = input.indexPath ?? indexPath;
  const anchorPath = input.anchorPath ?? sourcePath;
  return {
    meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq: 4, committedAt: 1 },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 2,
      deltaLink: "delta",
      complete: true,
      itemsById: {
        [folderId]: {
          id: folderId,
          parentId: scope.filesRootId,
          name: "videos",
          kind: "folder",
        },
        [fileId]: {
          id: fileId,
          parentId: input.nodeParentId ?? folderId,
          name: "x.md",
          kind: "file",
          eTag: input.nodeETag ?? fileETag,
          cTag: "ctag",
          size: fileSize,
          mtime: 5,
          contentHash: fileHash,
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        [`shadow:${fileId}`]: {
          anchorId: `shadow:${fileId}`,
          remoteId: fileId,
          lastPath: anchorPath,
          contentHash: fileHash,
          size: fileSize,
          remoteETag: "etag-pre-move",
          confirmedAt: 1,
          confirmedBy: "equal-read",
        },
      },
    },
  };
}

function fieldReader(input: {
  paths: readonly string[];
  driveId?: string;
  parentId?: string;
  eTag?: string;
}): (vault: string, path: string) => Promise<unknown> {
  return async (_vault: string, path: string) => {
    if (!input.paths.includes(path)) return null;
    return {
      driveId: input.driveId ?? fileId,
      parentId: input.parentId ?? folderId,
      size: fileSize,
      mtime: 5,
      eTag: input.eTag ?? fileETag,
      cTag: "ctag",
      sha256Hash: fileHash,
    };
  };
}

function fieldState(input: {
  record?: MutationLedgerEntryV1;
  indexPath?: string;
  nodeParentId?: string;
  nodeETag?: string;
  anchorPath?: string;
} = {}) {
  const index = input.indexPath ?? indexPath;
  const anchorPath = input.anchorPath ?? sourcePath;
  return makeActiveV2State(
    [{
      path: index,
      driveId: fileId,
      parentId: input.nodeParentId ?? folderId,
      size: fileSize,
      mtime: 5,
      eTag: input.nodeETag ?? fileETag,
      cTag: "ctag",
      sha256Hash: fileHash,
    }],
    [{
      path: anchorPath,
      hash: fileHash,
      size: fileSize,
      eTag: "etag-pre-move",
    }],
    {
      remoteFolders: [{
        path: "videos",
        driveId: folderId,
        parentId: scope.filesRootId,
        name: "videos",
      }],
      staleFileAnchors: [{
        path: anchorPath,
        remoteId: fileId,
        eTag: "etag-pre-move",
      }],
      mutationLedger: [input.record ?? fieldRecord()],
    },
  );
}

function fieldExecutorFromFixture(
  state: ReturnType<typeof makeActiveV2State>,
  overrides: Record<string, unknown> = {},
) {
  const diag = {
    log: vi.fn(),
    warn: vi.fn(),
    isEnabled: vi.fn(() => true),
  } as unknown as DiagnosticLogger;
  const onedrive = makeMockOneDrive(overrides);
  const scanner = {
    ...emptyScanner(),
    vault: {
      adapter: makeMockAdapter(),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
    },
    inspectFile: vi.fn(async (path: string) => ({
      status: "present" as const,
      entry: {
        path,
        size: fileSize,
        mtime: 2,
        hash: fileHash,
        binary: false,
      },
    })),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
  } as unknown as LocalScanner;
  const executor = new SyncExecutor(
    onedrive,
    scanner,
    state,
    "testVault",
    undefined,
    undefined,
    diag,
  );
  (executor as unknown as { activeSyncScope: SyncScope })
    .activeSyncScope = scope;
  return { executor, onedrive, diag, scanner };
}

function fieldExecutor(
  state: ReturnType<typeof fieldState>,
  overrides: Record<string, unknown> = {},
) {
  return fieldExecutorFromFixture(state, {
    renameItem: vi.fn(),
    moveItemById: vi.fn(),
    deleteItem: vi.fn(),
    uploadFile: vi.fn(),
    // The single bounded refresh reads the live hierarchy: root folder plus
    // the cloud folder `videos` holding the moved file (no remote write).
    getDelta: vi.fn().mockResolvedValue({
      value: [
        graphFolder(scope.filesRootId, "files", "root-parent"),
        graphFolder(folderId, "videos", scope.filesRootId),
        driveItem(indexPath, fileHash, {
          id: fileId,
          eTag: fileETag,
          cTag: "ctag",
          size: fileSize,
          parentReference: { id: folderId },
        }),
      ],
      "@odata.deltaLink": "delta-after-refresh",
    }),
    getFileMetadata: vi.fn(fieldReader({
      paths: [localPath, indexPath],
    })),
    getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
    ...overrides,
  });
}

function runRecovery(
  executor: SyncExecutor,
  result: SyncResult = {} as SyncResult,
): Promise<unknown> {
  return (executor as unknown as {
    recoverMutationLedger(
      scope: SyncScope,
      metrics: undefined,
      operationEpoch: number,
      observationOnly: boolean,
      remoteObservationCommitSeq: undefined,
      result: SyncResult,
    ): Promise<unknown>;
  }).recoverMutationLedger(scope, undefined, 1, false, undefined, result);
}

describe("receipted renameRemote destination-spelling rebase", () => {
  it("admits the field shape through the shared gate but refuses both reducer assertions today", () => {
    const record = fieldRecord();
    // Obstacle ①: the admission clause only rejects records whose source
    // normalizes onto the destination. The field shape (root → Videos/x) is
    // an ordinary record and must stay one — no gate relaxation is needed.
    expect(isOrdinaryFileRecoveryRecord(record, scope)).toBe(true);

    // Pre-move committed tree: the folder projects as `videos`, so the
    // receipt's local-spelling parent fails the parent assertion first.
    const preMove = fieldEnvelope({ anchorPath: sourcePath });
    preMove.remoteIndex.itemsById = {
      ...preMove.remoteIndex.itemsById,
      [fileId]: { ...preMove.remoteIndex.itemsById[fileId]!, parentId: scope.filesRootId, name: "x.md" },
    };
    expect(() => reduceFileStateEnvelopeV2(preMove, record))
      .toThrow(/V2 remote upsert parent does not match path: Videos/);

    // Refreshed tree (the retry's world): the identity is already projected
    // at the cloud spelling, so the receipt now lacks the source deletion the
    // reducer demands for `videos/x.md`.
    expect(() => reduceFileStateEnvelopeV2(fieldEnvelope(), record))
      .toThrow(/V2 remote move is missing its source deletion: videos\/x\.md/);
  });

  it("settles the record by rebasing its destination spelling and retrying the commit — zero remote writes", async () => {
    const state = fieldState();
    const { executor, onedrive, diag } = fieldExecutor(state);
    const result = {} as SyncResult;

    const summary = await runRecovery(executor, result);

    expect(summary).toMatchObject({
      state: "settled",
      settled: 1,
      remaining: 0,
    });
    expect(state.mutationLedger).toEqual([]);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling)).toHaveBeenCalledTimes(1);
    const rebase = vi.mocked(state.rebaseReceiptedRenameSpelling).mock.calls[0][0];
    expect(rebase.path).toBe(indexPath);
    expect(rebase.receipt.checkpoint.baseUpserts.map((entry) => entry.path))
      .toEqual([indexPath]);
    expect(rebase.receipt.checkpoint.remoteUpserts.map((entry) => entry.path))
      .toEqual([indexPath]);
    // Source-side entries stay pinned to the intent spelling — re-spelling
    // them onto the destination would make it a self-rename and hit the
    // shared admission clause (never done).
    expect(rebase.receipt.checkpoint.baseRemovals).toEqual([sourcePath]);
    expect(rebase.receipt.checkpoint.remoteDeletes).toEqual([sourcePath]);

    // Audit line only — the settlement is invisible elsewhere.
    const audit = diag.log as unknown as ReturnType<typeof vi.fn>;
    expect(audit.mock.calls.some((call) =>
      call[0] === "state"
      && String(call[1]).includes(
        "rebased rename receipt spelling to the committed index path",
      )
      && String(call[1]).includes(`${localPath} -> ${indexPath}`))).toBe(true);

    // Committed end state: one anchor bound to the moved identity at the
    // index spelling, content and receipt version preserved.
    const committed = state.getCommittedV2Envelope()!;
    expect(projectRemoteIndexV2(committed.remoteIndex).get(fileId))
      .toBe(indexPath);
    const anchors = Object.values(committed.anchors.byAnchorId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      remoteId: fileId,
      lastPath: indexPath,
      contentHash: fileHash,
      size: fileSize,
      remoteETag: fileETag,
    });

    // The settlement is state-only: no remote mutation of any kind, and the
    // recovery pass never counts a move (filesMoved stays untouched).
    expect(onedrive.uploadFile).not.toHaveBeenCalled();
    expect(onedrive.deleteItem).not.toHaveBeenCalled();
    expect(onedrive.renameItem).not.toHaveBeenCalled();
    expect(onedrive.moveItemById).not.toHaveBeenCalled();
    expect(result.filesMoved).toBeUndefined();
    expect(onedrive.getDelta).toHaveBeenCalledTimes(1);
  });

  it("settles the same shape inside the same action from either reducer refusal", async () => {
    for (const message of [
      "V2 remote upsert parent does not match path: Videos",
      "V2 remote move is missing its source deletion: videos/x.md",
    ]) {
      const state = fieldState();
      const { executor, onedrive } = fieldExecutor(state);
      const metrics = {
        mutationPersistence: {
          receiptWrites: 0,
          checkpointFailures: 0,
          stagesMs: { receiptPersist: 0, checkpointTotal: 0 },
        },
      } as never;
      const result = {} as SyncResult;

      const outcome = await (executor as unknown as {
        recoverReceiptedMutationFailure(args: {
          error: Error;
          activeIntent: MutationLedgerEntryV1["intent"];
          activeRecord: MutationLedgerEntryV1;
          operationEpoch: number;
          result: SyncResult;
          metrics: never;
        }): Promise<string>;
      }).recoverReceiptedMutationFailure({
        error: new Error(message),
        activeIntent: fieldRecord().intent,
        activeRecord: fieldRecord(),
        operationEpoch: 1,
        result,
        metrics,
      });

      expect(outcome).toBe("applied");
      expect(state.mutationLedger).toEqual([]);
      expect(vi.mocked(state.rebaseReceiptedRenameSpelling))
        .toHaveBeenCalledTimes(1);
      expect(onedrive.renameItem).not.toHaveBeenCalled();
      expect(onedrive.moveItemById).not.toHaveBeenCalled();
      // The retry only replays the recorded checkpoint; the move was already
      // counted by the caller's settleAppliedMutationRecovery, untouched.
      expect(result.filesMoved).toBeUndefined();
    }
  });

  it("settles a whole field batch in one recovery pass — one refresh, one rebase per record", async () => {
    const count = 3;
    const files = Array.from({ length: count }, (_, index) => {
      const suffix = `x${index}.md`;
      return {
        fileId: `file-batch-${index}`,
        localPath: `Videos/${suffix}`,
        indexPath: `videos/${suffix}`,
        sourcePath: suffix,
      };
    });
    const records = files.map((file, index): MutationLedgerEntryV1 => ({
      intent: {
        version: 1,
        operationId: `op-rename-batch-${index}`,
        planRevision: 1,
        scope,
        action: "renameRemote",
        path: file.localPath,
        sourcePath: file.sourcePath,
        expectedLocal: { exists: true, hash: fileHash, size: fileSize },
        expectedRemote: {
          exists: true,
          driveId: file.fileId,
          eTag: fileETag,
          size: fileSize,
          sha256Hash: fileHash,
        },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: `op-rename-batch-${index}`,
        completedAt: 2,
        checkpoint: fieldCheckpoint({
          path: file.localPath,
          sourcePath: file.sourcePath,
          driveId: file.fileId,
        }),
      },
    }));
    const state = makeActiveV2State(
      files.map((file) => ({
        path: file.indexPath,
        driveId: file.fileId,
        parentId: folderId,
        size: fileSize,
        mtime: 5,
        eTag: fileETag,
        cTag: "ctag",
        sha256Hash: fileHash,
      })),
      files.map((file) => ({
        path: file.sourcePath,
        hash: fileHash,
        size: fileSize,
        eTag: "etag-pre-move",
      })),
      {
        remoteFolders: [{
          path: "videos",
          driveId: folderId,
          parentId: scope.filesRootId,
          name: "videos",
        }],
        staleFileAnchors: files.map((file) => ({
          path: file.sourcePath,
          remoteId: file.fileId,
          eTag: "etag-pre-move",
        })),
        mutationLedger: records,
      },
    );
    const { executor, onedrive } = fieldExecutorFromFixture(state, {
      renameItem: vi.fn(),
      moveItemById: vi.fn(),
      getDelta: vi.fn().mockResolvedValue({
        value: [
          graphFolder(scope.filesRootId, "files", "root-parent"),
          graphFolder(folderId, "videos", scope.filesRootId),
          ...files.map((file) => driveItem(file.indexPath, fileHash, {
            id: file.fileId,
            eTag: fileETag,
            cTag: "ctag",
            size: fileSize,
            parentReference: { id: folderId },
          })),
        ],
        "@odata.deltaLink": "delta-after-refresh",
      }),
      getFileMetadata: vi.fn(async (_vault: string, path: string) => {
        const file = files.find((candidate) =>
          candidate.localPath === path || candidate.indexPath === path);
        if (!file) return null;
        return {
          driveId: file.fileId,
          parentId: folderId,
          size: fileSize,
          mtime: 5,
          eTag: fileETag,
          cTag: "ctag",
          sha256Hash: fileHash,
        };
      }),
    });

    const summary = await runRecovery(executor);

    expect(summary).toMatchObject({ state: "settled", settled: count, remaining: 0 });
    expect(state.mutationLedger).toEqual([]);
    // One bounded hierarchy refresh for the whole pass; every record still
    // proves its own live facts before its spelling is rebased.
    expect(onedrive.getDelta).toHaveBeenCalledTimes(1);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling))
      .toHaveBeenCalledTimes(count);
    expect(onedrive.renameItem).not.toHaveBeenCalled();
    expect(onedrive.moveItemById).not.toHaveBeenCalled();
  });

  it("keeps the record blocked when the index path is not a spelling alias", async () => {
    const state = fieldState({ indexPath: "videos/y.md" });
    const { executor } = fieldExecutor(state, {
      getFileMetadata: vi.fn(fieldReader({
        paths: [localPath, "videos/y.md"],
      })),
    });

    await expect(runRecovery(executor))
      .rejects.toThrow(/missing its source deletion: videos\/y\.md/);
    expect(state.mutationLedger).toHaveLength(1);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling)).not.toHaveBeenCalled();
  });

  it("keeps the record blocked when the live destination identity differs", async () => {
    const state = fieldState();
    const { executor } = fieldExecutor(state, {
      getFileMetadata: vi.fn(fieldReader({
        paths: [localPath, indexPath],
        driveId: "file-other",
      })),
    });

    await expect(runRecovery(executor))
      .rejects.toThrow(/Mutation receipt no longer matches local\/remote facts/);
    expect(state.mutationLedger).toHaveLength(1);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling)).not.toHaveBeenCalled();
  });

  it("keeps the record blocked when the live parent identity differs", async () => {
    const state = fieldState();
    const { executor } = fieldExecutor(state, {
      getFileMetadata: vi.fn(fieldReader({
        paths: [localPath, indexPath],
        parentId: "folder-other",
      })),
    });

    await expect(runRecovery(executor))
      .rejects.toThrow(/missing its source deletion: videos\/x\.md/);
    expect(state.mutationLedger).toHaveLength(1);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling)).not.toHaveBeenCalled();
  });

  it("keeps the record blocked when the live version moved past the receipt", async () => {
    const state = fieldState({ nodeETag: "etag-newer" });
    const { executor } = fieldExecutor(state, {
      getDelta: vi.fn().mockResolvedValue({
        value: [
          graphFolder(scope.filesRootId, "files", "root-parent"),
          graphFolder(folderId, "videos", scope.filesRootId),
          driveItem(indexPath, fileHash, {
            id: fileId,
            eTag: "etag-newer",
            cTag: "ctag",
            size: fileSize,
            parentReference: { id: folderId },
          }),
        ],
        "@odata.deltaLink": "delta-after-refresh",
      }),
      getFileMetadata: vi.fn(fieldReader({
        paths: [localPath, indexPath],
        eTag: "etag-newer",
      })),
    });

    await expect(runRecovery(executor))
      .rejects.toThrow(/Mutation receipt no longer matches local\/remote facts/);
    expect(state.mutationLedger).toHaveLength(1);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling)).not.toHaveBeenCalled();
  });

  it("never touches a self-rename (no divergent source spelling to rebase)", async () => {
    const state = fieldState({
      record: fieldRecord({ sourcePath: "videos/x.md" }),
    });
    const { executor } = fieldExecutor(state);

    const rebased = await (executor as unknown as {
      rebaseReceiptedRenameSpelling(
        record: MutationLedgerEntryV1,
      ): Promise<boolean>;
    }).rebaseReceiptedRenameSpelling(fieldRecord({ sourcePath: "videos/x.md" }));

    expect(rebased).toBe(false);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling)).not.toHaveBeenCalled();
  });

  it("never touches a record without a receipt (intent-only family stays on its own lane)", async () => {
    const state = fieldState({ record: fieldRecord({ receipt: null }) });
    const { executor } = fieldExecutor(state);

    const rebased = await (executor as unknown as {
      rebaseReceiptedRenameSpelling(
        record: MutationLedgerEntryV1,
      ): Promise<boolean>;
    }).rebaseReceiptedRenameSpelling(fieldRecord({ receipt: null }));

    expect(rebased).toBe(false);
    expect(vi.mocked(state.rebaseReceiptedRenameSpelling)).not.toHaveBeenCalled();
  });
});
