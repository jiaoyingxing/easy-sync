import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { SyncExecutor, type SyncResult } from "../src/sync/sync-executor";
import { normalizeRemotePathKey } from "../src/sync/canonical-plan-v2";
import { isOrdinaryFileRecoveryRecord } from "../src/sync/conservative-reset-recovery";
import { projectRemoteIndexV2 } from "../src/sync/remote-index-v2";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import type { LocalScanner } from "../src/sync/local-scanner";
import type {
  MutationCheckpointV1,
  MutationLedgerEntryV1,
  MutationReceiptV1,
  SyncScope,
} from "../src/sync/types";
import { V2StateRefusalError } from "../src/sync/v2-state-refusal";
import {
  driveItem,
  emptyScanner,
  graphFolder,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
  TEST_SYNC_SCOPE,
} from "./helpers/sync-safety-harness";

/**
 * Receipted download whose path spelling diverges from the committed index
 * (field report 2026-11-05, Android 1.6.6, vault `知识星球`).
 *
 * The field shape: the remote object is projected in the committed index at
 * `科研大神/Meta分析.md`, while the plan, the deferred retry and the durable
 * download receipt all use `科研大神/meta分析.md`. The reducer's base-upsert
 * lookup is byte-exact, so the receipt can never commit:
 *
 *   16:48:44 download 科研大神/meta分析.md FAILED:
 *            V2 base upsert has no remote file identity: 科研大神/meta分析.md
 *   16:48:56 side action failed:
 *            V2 remote move is missing its source deletion: 科研大神/Meta分析.md
 *
 * The cross-round recovery lane already rebuilds the committed identity tree
 * once and retries a refused base upsert. The same-round lane and the
 * side-action lane did not, so the round stopped and every conflict click
 * kept failing until another ordinary sync was started by hand.
 *
 * These tests pin the two lanes: one bounded read-only rebuild of the live
 * tree, then one retry — and a refusal that still holds after the rebuild
 * keeps the record blocked exactly as before.
 */

const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
const receiptPath = "科研大神/meta分析.md";
const indexPath = "科研大神/Meta分析.md";
const folderPath = "科研大神";
const fileId = "meta-analysis-file-id";
const folderId = "meta-analysis-folder-id";
const fileETag = "etag-download";
const fileHash = "b".repeat(64);
const fileSize = 3_072;
const operationId = "op-download-spelling";

function downloadCheckpoint(): MutationCheckpointV1 {
  return {
    baseUpserts: [{
      path: receiptPath,
      hash: fileHash,
      size: fileSize,
      eTag: fileETag,
    }],
    baseRemovals: [],
    remoteUpserts: [],
    remoteDeletes: [],
    pendingConflictRemovals: [],
    pendingDeleteRemovals: [],
  };
}

function downloadRecord(): MutationLedgerEntryV1 {
  const receipt: MutationReceiptV1 = {
    version: 1,
    operationId,
    completedAt: 2,
    checkpoint: downloadCheckpoint(),
  };
  return {
    intent: {
      version: 1,
      operationId,
      planRevision: 1,
      scope,
      action: "download",
      path: receiptPath,
      expectedLocal: { exists: true, hash: fileHash, size: fileSize },
      expectedRemote: {
        exists: true,
        driveId: fileId,
        eTag: fileETag,
        size: fileSize,
        sha256Hash: fileHash,
      },
      createdAt: 1,
    },
    receipt,
  };
}

function spellingState(options: { seededLedger?: boolean } = {}) {
  return makeActiveV2State(
    [{
      path: indexPath,
      driveId: fileId,
      parentId: folderId,
      size: fileSize,
      mtime: 5,
      eTag: fileETag,
      cTag: "ctag",
      sha256Hash: fileHash,
    }],
    [],
    {
      remoteFolders: [{
        path: folderPath,
        driveId: folderId,
        parentId: scope.filesRootId,
        name: folderPath,
      }],
      // The same-round lane recovers an already durable record; the
      // side-action lane writes its own intent through beginMutationIntent.
      mutationLedger: options.seededLedger === false ? [] : [downloadRecord()],
    },
  );
}

function spellingExecutor(
  state: ReturnType<typeof spellingState>,
  options: { livePath?: string; local?: "present" | "missing" } = {},
) {
  const livePath = options.livePath ?? receiptPath;
  const diag = {
    log: vi.fn(),
    warn: vi.fn(),
    isEnabled: vi.fn(() => true),
  } as unknown as DiagnosticLogger;
  const onedrive = makeMockOneDrive({
    renameItem: vi.fn(),
    moveItemById: vi.fn(),
    // The single bounded refresh reads the live hierarchy: the folder plus
    // the file under its live spelling. No remote write of any kind.
    getDelta: vi.fn().mockResolvedValue({
      value: [
        graphFolder(scope.filesRootId, "files", "root-parent"),
        graphFolder(folderId, folderPath, scope.filesRootId),
        driveItem(livePath, fileHash, {
          id: fileId,
          eTag: fileETag,
          cTag: "ctag",
          size: fileSize,
          parentReference: { id: folderId },
        }),
      ],
      "@odata.deltaLink": "delta-after-refresh",
    }),
    getFileMetadata: vi.fn().mockResolvedValue({
      driveId: fileId,
      parentId: folderId,
      size: fileSize,
      mtime: 5,
      eTag: fileETag,
      cTag: "ctag",
      sha256Hash: fileHash,
    }),
  });
  const scanner = {
    ...emptyScanner(),
    vault: {
      adapter: makeMockAdapter(),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
    },
    inspectFile: vi.fn(async (path: string) => options.local === "missing"
      ? { status: "missing" as const }
      : {
          status: "present" as const,
          entry: {
            path,
            size: fileSize,
            mtime: 2,
            hash: fileHash,
            binary: false,
          },
        }),
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
  return { executor, onedrive, diag };
}

function sameRoundRecovery(
  executor: SyncExecutor,
  error: unknown,
  result: SyncResult = {} as SyncResult,
  record: MutationLedgerEntryV1 = downloadRecord(),
): Promise<string> {
  return (executor as unknown as {
    recoverReceiptedMutationFailure(args: {
      error: unknown;
      activeIntent: MutationLedgerEntryV1["intent"];
      activeRecord: MutationLedgerEntryV1;
      operationEpoch: number;
      result: SyncResult;
      metrics: never;
    }): Promise<string>;
  }).recoverReceiptedMutationFailure({
    error,
    activeIntent: record.intent,
    activeRecord: record,
    // The default OperationLifecycle starts at epoch 0; the rebuild only
    // persists when the captured epoch is still current.
    operationEpoch: 0,
    result,
    metrics: {
      mutationPersistence: {
        receiptWrites: 0,
        checkpointFailures: 0,
        stagesMs: { receiptPersist: 0, checkpointTotal: 0 },
      },
    } as never,
  });
}

function sideMutation(
  executor: SyncExecutor,
  epoch = 0,
): Promise<boolean> {
  return (executor as unknown as {
    runDurableSideMutation(
      intent: MutationLedgerEntryV1["intent"],
      operationEpoch: number,
      mutate: () => Promise<MutationCheckpointV1>,
    ): Promise<boolean>;
  }).runDurableSideMutation(
    downloadRecord().intent,
    epoch,
    async () => downloadCheckpoint(),
  );
}

describe("receipted download path spelling divergence", () => {
  it("rebuilds the committed tree once and retries the same-round checkpoint", async () => {
    const state = spellingState();
    const { executor, onedrive } = spellingExecutor(state);

    const outcome = await sameRoundRecovery(
      executor,
      new V2StateRefusalError(
        "V2 base upsert has no remote file identity",
        receiptPath,
      ),
    );

    expect(outcome).toBe("applied");
    expect(state.mutationLedger).toEqual([]);
    expect(onedrive.getDelta).toHaveBeenCalledTimes(1);
    // The committed index now projects the identity at the live spelling and
    // the anchor follows it; nothing was written to the service.
    const committed = state.getCommittedV2Envelope()!;
    expect(projectRemoteIndexV2(committed.remoteIndex).get(fileId))
      .toBe(receiptPath);
    const anchors = Object.values(committed.anchors.byAnchorId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      remoteId: fileId,
      lastPath: receiptPath,
      contentHash: fileHash,
      size: fileSize,
      remoteETag: fileETag,
    });
    expect(onedrive.uploadFile).not.toHaveBeenCalled();
    expect(onedrive.deleteItem).not.toHaveBeenCalled();
    expect(onedrive.renameItem).not.toHaveBeenCalled();
    expect(onedrive.moveItemById).not.toHaveBeenCalled();
  });

  it("rebuilds once and retries a side-action checkpoint instead of failing the click", async () => {
    const state = spellingState({ seededLedger: false });
    const { executor, onedrive } = spellingExecutor(state);

    const committed = await sideMutation(executor);

    expect(committed).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(onedrive.getDelta).toHaveBeenCalledTimes(1);
    expect(projectRemoteIndexV2(
      state.getCommittedV2Envelope()!.remoteIndex,
    ).get(fileId)).toBe(receiptPath);
    expect(onedrive.uploadFile).not.toHaveBeenCalled();
    expect(onedrive.deleteItem).not.toHaveBeenCalled();
  });

  it("keeps the record blocked when the live tree still refuses and nothing can converge", async () => {
    const state = spellingState();
    // The live listing still projects the identity at the index spelling and
    // the local file is gone, so neither the rebuild nor the spelling
    // convergence can prove its facts: fail-closed.
    const { executor, onedrive } = spellingExecutor(state, {
      livePath: indexPath,
      local: "missing",
    });

    const outcome = await sameRoundRecovery(
      executor,
      new V2StateRefusalError(
        "V2 base upsert has no remote file identity",
        receiptPath,
      ),
    );

    expect(outcome).toBe("unresolved");
    expect(state.mutationLedger).toHaveLength(1);
    expect(onedrive.getDelta).toHaveBeenCalledTimes(1);
    expect(onedrive.uploadFile).not.toHaveBeenCalled();
    expect(onedrive.deleteItem).not.toHaveBeenCalled();
  });

  it("keeps the side-action record blocked when the live tree still refuses", async () => {
    const state = spellingState({ seededLedger: false });
    const { executor } = spellingExecutor(state, {
      livePath: indexPath,
      local: "missing",
    });

    await expect(sideMutation(executor)).rejects.toThrow(
      /V2 base upsert has no remote file identity/,
    );
    expect(state.mutationLedger).toHaveLength(1);
  });

  it("does not rebuild for unrelated failures", async () => {
    const state = spellingState();
    // The receipt cannot converge either (the local file is gone), so the
    // record keeps its ordinary unresolved exit instead of the repair lane.
    const { executor, onedrive } = spellingExecutor(state, { local: "missing" });

    const outcome = await sameRoundRecovery(
      executor,
      new Error("Reviewed download cancelled before local commit"),
    );

    expect(outcome).toBe("unresolved");
    expect(state.mutationLedger).toHaveLength(1);
    expect(onedrive.getDelta).not.toHaveBeenCalled();
  });
});

/**
 * Spelling convergence (F36 residual branch, 2026-11-05).
 *
 * The rebuild-only repair above heals a stale committed index. When the live
 * service itself keeps the other spelling, a rebuild re-confirms it and the
 * receipt can never commit. The convergence lane then proves both spellings are
 * one live identity at the receipt's exact version, moves the one local file to
 * the committed index spelling and re-spells the receipt to it — no remote
 * write. Every unproven fact keeps the record blocked.
 */

const uploadOperationId = "op-upload-spelling";

function uploadCheckpoint(): MutationCheckpointV1 {
  return {
    baseUpserts: [{
      path: receiptPath,
      hash: fileHash,
      size: fileSize,
      eTag: fileETag,
    }],
    baseRemovals: [],
    remoteUpserts: [{
      path: receiptPath,
      driveId: fileId,
      parentId: folderId,
      size: fileSize,
      mtime: 5,
      eTag: fileETag,
      cTag: "ctag",
      sha256Hash: fileHash,
    }],
    remoteDeletes: [],
    pendingConflictRemovals: [],
    pendingDeleteRemovals: [],
  };
}

function uploadRecord(): MutationLedgerEntryV1 {
  return {
    intent: {
      version: 1,
      operationId: uploadOperationId,
      planRevision: 1,
      scope,
      action: "upload",
      path: receiptPath,
      expectedLocal: { exists: true, hash: fileHash, size: fileSize },
      expectedRemote: { exists: false },
      createdAt: 1,
    },
    receipt: {
      version: 1,
      operationId: uploadOperationId,
      completedAt: 2,
      checkpoint: uploadCheckpoint(),
    },
  };
}

function convergentExecutor(
  state: ReturnType<typeof spellingState>,
  options: {
    livePath?: string;
    liveETag?: string;
    local?: { path: string; hash: string; size: number } | null;
    caseInsensitiveLocal?: boolean;
  } = {},
) {
  const livePath = options.livePath ?? indexPath;
  const liveETag = options.liveETag ?? fileETag;
  let liveLocal = options.local === undefined
    ? { path: receiptPath, hash: fileHash, size: fileSize }
    : options.local;
  const sameLocal = (left: string, right: string): boolean =>
    options.caseInsensitiveLocal
      ? normalizeRemotePathKey(left) === normalizeRemotePathKey(right)
      : left === right;
  const onedrive = makeMockOneDrive({
    // No remote write of any kind belongs to this lane.
    uploadFile: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    moveItemById: vi.fn(),
    // One bounded refresh reads the live hierarchy. It keeps the index
    // spelling, so the rebuild alone cannot repair the receipt.
    getDelta: vi.fn().mockResolvedValue({
      value: [
        graphFolder(scope.filesRootId, "files", "root-parent"),
        graphFolder(folderId, folderPath, scope.filesRootId),
        driveItem(livePath, fileHash, {
          id: fileId,
          eTag: liveETag,
          cTag: "ctag",
          size: fileSize,
          parentReference: { id: folderId },
        }),
      ],
      "@odata.deltaLink": "delta-after-refresh",
    }),
    // Graph path addressing is case-insensitive: every spelling resolves to
    // the same live identity.
    getFileMetadata: vi.fn().mockResolvedValue({
      driveId: fileId,
      parentId: folderId,
      size: fileSize,
      mtime: 5,
      eTag: liveETag,
      cTag: "ctag",
      sha256Hash: fileHash,
    }),
  });
  const vault = {
    adapter: makeMockAdapter(),
    getFiles: vi.fn().mockReturnValue([]),
    getName: vi.fn().mockReturnValue("testVault"),
    getAbstractFileByPath: vi.fn((path: string) => {
      if (!liveLocal || !sameLocal(path, liveLocal.path)) return null;
      return new TFile(liveLocal.path);
    }),
    rename: vi.fn(async (file: { path: string }, target: string) => {
      if (!liveLocal || file.path !== liveLocal.path) {
        throw new Error("Local file identity changed before move");
      }
      liveLocal = { ...liveLocal, path: target };
    }),
  };
  const scanner = {
    ...emptyScanner(),
    vault,
    inspectFile: vi.fn(async (path: string) => {
      if (!liveLocal || !sameLocal(path, liveLocal.path)) {
        return { status: "missing" as const };
      }
      return { status: "present" as const, entry: { ...liveLocal } };
    }),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
  } as unknown as LocalScanner;
  const diag = {
    log: vi.fn(),
    warn: vi.fn(),
    isEnabled: vi.fn(() => true),
  } as unknown as DiagnosticLogger;
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
  return {
    executor,
    onedrive,
    vault,
    diag,
    liveLocalName: () => liveLocal?.path,
  };
}

describe("receipted mutation spelling convergence", () => {
  it("moves the local file and the receipt to the committed index spelling", async () => {
    const state = spellingState();
    const { executor, onedrive, vault, liveLocalName } = convergentExecutor(state);

    const outcome = await sameRoundRecovery(
      executor,
      new V2StateRefusalError(
        "V2 base upsert has no remote file identity",
        receiptPath,
      ),
    );

    expect(outcome).toBe("applied");
    expect(state.mutationLedger).toEqual([]);
    expect(liveLocalName()).toBe(indexPath);
    expect(vault.rename).toHaveBeenCalledTimes(1);
    expect(onedrive.getDelta).toHaveBeenCalledTimes(1);
    // Read-mostly: the identity never moves on the service.
    expect(onedrive.uploadFile).not.toHaveBeenCalled();
    expect(onedrive.deleteItem).not.toHaveBeenCalled();
    expect(onedrive.renameItem).not.toHaveBeenCalled();
    expect(onedrive.moveItemById).not.toHaveBeenCalled();
    const committed = state.getCommittedV2Envelope()!;
    expect(projectRemoteIndexV2(committed.remoteIndex).get(fileId)).toBe(indexPath);
    const anchors = Object.values(committed.anchors.byAnchorId);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      remoteId: fileId,
      lastPath: indexPath,
      contentHash: fileHash,
      size: fileSize,
      remoteETag: fileETag,
    });
    const rebase = vi.mocked(state.rebaseReceiptedRenameSpelling).mock.calls[0][0];
    expect(rebase.path).toBe(indexPath);
    expect(rebase.receipt.checkpoint.baseUpserts[0].path).toBe(indexPath);
    expect(isOrdinaryFileRecoveryRecord({
      ...downloadRecord(),
      intent: { ...downloadRecord().intent, path: indexPath },
      receipt: rebase.receipt,
    }, scope)).toBe(true);
  });

  it("converges a receipted upload driven from the side bar", async () => {
    const state = spellingState({ seededLedger: false });
    const { executor, vault, liveLocalName } = convergentExecutor(state);
    const record = uploadRecord();

    const committed = await (executor as unknown as {
      runDurableSideMutation(
        intent: MutationLedgerEntryV1["intent"],
        operationEpoch: number,
        mutate: () => Promise<MutationCheckpointV1>,
      ): Promise<boolean>;
    }).runDurableSideMutation(
      record.intent,
      0,
      async () => uploadCheckpoint(),
    );

    expect(committed).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(liveLocalName()).toBe(indexPath);
    expect(vault.rename).toHaveBeenCalledTimes(1);
    const rebase = vi.mocked(state.rebaseReceiptedRenameSpelling).mock.calls[0][0];
    expect(rebase.receipt.checkpoint.remoteUpserts[0].path).toBe(indexPath);
    expect(isOrdinaryFileRecoveryRecord({
      ...record,
      intent: { ...record.intent, path: indexPath },
      receipt: rebase.receipt,
    }, scope)).toBe(true);
  });

  it("converges through the cross-round recovery commit", async () => {
    const state = spellingState();
    const { executor, vault, liveLocalName } = convergentExecutor(state);

    const metrics = await (executor as unknown as {
      commitRecoveryCheckpointsWithRepair(args: {
        operationIds: readonly string[];
        operationEpoch: number | undefined;
        result: SyncResult | undefined;
      }): Promise<unknown>;
    }).commitRecoveryCheckpointsWithRepair({
      operationIds: [operationId],
      operationEpoch: 0,
      result: {} as SyncResult,
    });

    expect(metrics).toBeDefined();
    expect(state.mutationLedger).toEqual([]);
    expect(liveLocalName()).toBe(indexPath);
    expect(vault.rename).toHaveBeenCalledTimes(1);
  });

  it("keeps the record blocked when the live version moved past the receipt", async () => {
    const state = spellingState();
    const { executor, vault, liveLocalName } = convergentExecutor(state, {
      liveETag: "etag-newer",
    });

    const outcome = await sameRoundRecovery(
      executor,
      new V2StateRefusalError(
        "V2 base upsert has no remote file identity",
        receiptPath,
      ),
    );

    expect(outcome).toBe("unresolved");
    expect(state.mutationLedger).toHaveLength(1);
    expect(vault.rename).not.toHaveBeenCalled();
    expect(liveLocalName()).toBe(receiptPath);
    expect(state.rebaseReceiptedRenameSpelling).not.toHaveBeenCalled();
  });

  it("keeps the record blocked when the local file is under a third spelling", async () => {
    const state = spellingState();
    const { executor, vault } = convergentExecutor(state, {
      local: {
        path: "科研大神/meta 分析.md",
        hash: fileHash,
        size: fileSize,
      },
    });

    const outcome = await sameRoundRecovery(
      executor,
      new V2StateRefusalError(
        "V2 base upsert has no remote file identity",
        receiptPath,
      ),
    );

    expect(outcome).toBe("unresolved");
    expect(state.mutationLedger).toHaveLength(1);
    expect(vault.rename).not.toHaveBeenCalled();
    expect(state.rebaseReceiptedRenameSpelling).not.toHaveBeenCalled();
  });

  it("treats a case-insensitive host as already converged", async () => {
    const state = spellingState();
    // The host reports the real name (`Meta分析.md`) for either spelling.
    const { executor, vault, liveLocalName } = convergentExecutor(state, {
      caseInsensitiveLocal: true,
      local: { path: indexPath, hash: fileHash, size: fileSize },
    });

    const outcome = await sameRoundRecovery(
      executor,
      new V2StateRefusalError(
        "V2 base upsert has no remote file identity",
        receiptPath,
      ),
    );

    expect(outcome).toBe("applied");
    expect(state.mutationLedger).toEqual([]);
    expect(vault.rename).not.toHaveBeenCalled();
    expect(liveLocalName()).toBe(indexPath);
  });

  it("does not converge a record whose local bytes changed after the receipt", async () => {
    const state = spellingState();
    const { executor, vault } = convergentExecutor(state, {
      local: { path: receiptPath, hash: "c".repeat(64), size: fileSize },
    });

    const outcome = await sameRoundRecovery(
      executor,
      new V2StateRefusalError(
        "V2 base upsert has no remote file identity",
        receiptPath,
      ),
    );

    expect(outcome).toBe("unresolved");
    expect(state.mutationLedger).toHaveLength(1);
    expect(vault.rename).not.toHaveBeenCalled();
    expect(state.rebaseReceiptedRenameSpelling).not.toHaveBeenCalled();
  });
});
