// 文件夹删除缺席核验与恢复观察
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import * as obsidian from "obsidian";
import {
  TFolder,
} from "obsidian";
import {
  SyncActionType,
} from "../src/sync/types";
import type {
  BaseFileEntry,
  LocalFileEntry,
  ManualMutationResolutionV1,
  MutationIntentV1,
  MutationLedgerEntryV1,
  MutationReceiptV1,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlan,
  SyncPlanItem,
  SyncScope,
} from "../src/sync/types";
import { SyncExecutor, assertConfirmDeleteWaveWithinCheckpointLimit } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import { OneDriveClient, ResponseByteBudgetError } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType, type DriveItem } from "../src/onedrive/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { PendingIssue } from "../src/sync/types";
import { generateFileDecisionPlanV2 } from "../src/sync/file-decision-planner-v2";
import { StateManager, MAX_MUTATION_CHECKPOINT_BATCH } from "../src/sync/state-manager";
import { I18n } from "../src/i18n";
import { SyncProgressStore } from "../src/sync/sync-progress";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import { EasySyncNoticeCenter } from "../src/ui/notice-center";
import {
  reduceFileStateEnvelopeV2,
} from "../src/sync/file-state-reducer-v2";
import {
  isFolderMutationIntent,
  reduceFolderStateEnvelopeV2,
} from "../src/sync/folder-state-reducer-v2";
import {
  attachBaseAncestorHashesV2,
  projectStatePathViewV2,
  removeBaseStateEnvelopeV2,
  replaceBaseStateEnvelopeV2,
  upsertBaseStateEnvelopeV2,
} from "../src/sync/file-state-controller-v2";
import type { SyncAnchorV2 } from "../src/sync/state-envelope-v2";
import { createFileStateShadowEnvelopeV2 } from "./helpers/file-state-shadow-v2";
import { projectRemoteIndexV2 } from "../src/sync/remote-index-v2";
import {
  makePublic113InterruptedUploadBatch,
  PUBLIC_113_NETWORK_RECOVERY_INCIDENT,
} from "./fixtures/network-recovery-incidents";
import { V2FilePlanTestHarness } from "./helpers/v2-file-plan-test-harness";
import type {
  CommunityPluginManifestObservationV1,
} from "../src/sync/community-plugin-bundle";

// ---- Shared test helpers ----

import {
  TEST_SYNC_SCOPE,
  EASY_SYNC_TMP_DIR,
  makeMockAdapter,
  makeDownloadLocalStore,
  makeMockOneDrive,
  remoteStateStub,
  makeActiveV2State,
  graphFolder,
  makeMemoryState,
  driveItem,
  emptyScanner,
  makeManualResolutionHarness,
  makeNoticeRecorder,
  BASE_UPSERT_GATES,
  makeStaleTreeCommitProbe,
} from "./helpers/sync-safety-harness";

describe("batch remote-delete absence verification", () => {
  async function makeDeleteConfirmHarness(input: {
    paths: readonly string[];
    batchAbsent?: (paths: readonly string[]) => Promise<Map<string, unknown>>;
    batchError?: Error;
    remotePresentPaths?: readonly string[];
  }) {
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
    const localEntries = input.paths.map((path, index) => ({
      path,
      hash: `local-hash-${index}`.padEnd(64, "0"),
      size: 10 + index,
      mtime: 1,
      binary: false,
    }));
    const pendingRemoteDeletes: SyncPlanItem[] = localEntries.map((local) => ({
      type: SyncActionType.ConfirmLocalDelete,
      path: local.path,
      local,
      decisionToken: {
        version: 1,
        vaultName: "testVault",
        accountId: scope.accountId,
        scope,
        local: { exists: true, hash: local.hash, size: local.size },
        remote: { exists: false },
        ancestorHash: null,
      },
    } as unknown as SyncPlanItem));
    const removedPaths: string[] = [];
    const adapter = makeMockAdapter({
      remove: vi.fn(async (path: string) => {
        removedPaths.push(path);
      }),
    });
    const state = {
      ...remoteStateStub(),
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      boundAccountId: scope.accountId,
      remoteScope: scope,
      pendingRemoteDeletes,
      planReviewRevision: 0,
      baseSnapshot: [],
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      getCommittedV2Envelope: vi.fn(() => null),
      peekCommittedV2Envelope: vi.fn(() => null),
      retireMutationCheckpointIfReflected: vi.fn().mockResolvedValue(false),
    } as unknown as StateManager;
    const getFileMetadata = vi.fn(async (_vault: string, path: string) =>
      input.remotePresentPaths?.includes(path)
        ? { eTag: "etag-new", cTag: "ctag-new", size: 1, driveId: "reappeared-id", parentId: scope.filesRootId, mtime: 2, sha256Hash: "aa".repeat(32) }
        : null);
    const getFileMetadataByPaths = input.batchError
      ? vi.fn(async () => { throw input.batchError; })
      : input.batchAbsent
        ? vi.fn(async (_vault: string, paths: readonly string[]) =>
            input.batchAbsent!(paths))
        : vi.fn(async (_vault: string, paths: readonly string[]) =>
            new Map(paths.map((path) => [path, null])));
    const onedrive = makeMockOneDrive({
      getFileMetadata,
      getFileMetadataByPaths,
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault: {
          configDir: ".obsidian",
          adapter,
          getFileByPath: vi.fn().mockReturnValue(null),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        inspectFile: vi.fn(async (path: string) => {
          const local = localEntries.find((entry) => entry.path === path);
          return local ? { status: "present" as const, entry: local } : { status: "missing" as const };
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    return {
      executor,
      getFileMetadata,
      getFileMetadataByPaths,
      removedPaths,
      state,
    };
  }

  it("pre-verifies each confirm-delete wave once and skips per-item remote checks", async () => {
    const paths = Array.from({ length: 25 }, (_unused, index) => `d-${index}.md`);
    const harness = await makeDeleteConfirmHarness({ paths });

    await harness.executor.confirmRemoteDeletes(paths);

    // Wave-scoped reads (desktop 16): the first wave proves only its own 16
    // paths so it can delete immediately; the 9 leftovers follow as a second
    // read. A single 25-path read was the old "front porch".
    expect(harness.getFileMetadataByPaths).toHaveBeenCalledTimes(2);
    expect(harness.getFileMetadataByPaths.mock.calls).toEqual([
      ["testVault", [...paths].sort().slice(0, 16)],
      ["testVault", [...paths].sort().slice(16)],
    ]);
    expect(harness.getFileMetadata).not.toHaveBeenCalled();
    expect(harness.removedPaths.sort()).toEqual([...paths].sort());
    expect(harness.executor.hasSideActionsInFlight).toBe(false);
  });

  it("falls back to per-item verification when the batch read fails", async () => {
    const paths = Array.from({ length: 4 }, (_unused, index) => `f-${index}.md`);
    const harness = await makeDeleteConfirmHarness({
      paths,
      batchError: new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.getFileMetadata).toHaveBeenCalledTimes(paths.length);
    expect(harness.removedPaths.sort()).toEqual([...paths].sort());
  });

  it("re-verifies a reappeared path individually and blocks only that item", async () => {
    const harness = await makeDeleteConfirmHarness({
      paths: ["a.md", "b.md"],
      remotePresentPaths: ["b.md"],
      batchAbsent: async (paths: readonly string[]) =>
        new Map(paths.map((path) => [path, path === "b.md" ? { id: "reappeared" } : null])),
    });

    await harness.executor.confirmRemoteDeletes(["a.md", "b.md"]);

    expect(harness.removedPaths).toEqual(["a.md"]);
    expect(harness.getFileMetadata.mock.calls).toEqual([["testVault", "b.md", "other"]]);
  });

  it("accepts the batch-verified absence window when a file reappears after the batch read", async () => {
    const harness = await makeDeleteConfirmHarness({
      paths: ["a.md", "b.md"],
      remotePresentPaths: ["b.md"],
    });

    await harness.executor.confirmRemoteDeletes(["a.md", "b.md"]);

    // The batch proved both absent; a reappearance inside the window is
    // adopted by the next ordinary round instead of a per-item re-check.
    expect(harness.removedPaths.sort()).toEqual(["a.md", "b.md"]);
    expect(harness.getFileMetadata).not.toHaveBeenCalled();
  });
});

describe("confirm delete waves", () => {
  // 波大小手机 8 / 桌面 16，测试跑桌面（Platform.isMobile=false）：8 项正好一波。
  const WAVE = 8;

  interface ConfirmDeleteWaveHarnessInput {
    filePaths?: readonly string[];
    folderPath?: string;
    /** 这一条的本机删除抛错（adapter.remove）。 */
    failErasePath?: string;
    /** 本条删除成功后执行（用于在波中取消）。 */
    afterErase?: (path: string) => void;
    /** 批量缺席读取被调用时执行（参数为该次读取覆盖的路径）。 */
    duringBatchRead?: (batch: readonly string[]) => void;
    /** 该次批量读取要不要挂住（用于证明"上一波已删除、下一波的读取还没回来"）。 */
    batchReadGate?: (batch: readonly string[]) => Promise<void> | void;
    /** 去掉本机读取／擦除的 1ms 占位（只给大数量用例提速，波内并发断言仍走默认）。 */
    fast?: boolean;
    diag?: DiagnosticLogger;
    /** 插件自身擦除的本机路径通知（宿主据此不把该事件当新本机变化）。 */
    onSelfLocalDelete?: (path: string) => void;
  }

  async function makeConfirmDeleteWaveHarness(
    input: ConfirmDeleteWaveHarnessInput,
  ) {
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
    const parentRemoteId = "committed-parent-id";
    const filePaths = [...(input.filePaths ?? [])];
    const folderPath = input.folderPath;
    const localEntries = filePaths.map((path, index) => ({
      path,
      hash: `wave-hash-${index}`.padEnd(64, "0"),
      size: 10 + index,
      mtime: 1,
      binary: false,
    }));
    // The stat-only pre-erase probe reads this map; a test can mutate one
    // member's facts mid-wave to simulate an edit between the reviewed SHA-256
    // guard and that member's turn in the serial erase segment.
    const localFacts = new Map(
      localEntries.map((entry) => [
        entry.path,
        { size: entry.size, mtime: entry.mtime },
      ]),
    );
    const folderChildCount = filePaths.filter(
      (path) => folderPath !== undefined && path.startsWith(`${folderPath}/`),
    ).length;
    const pendingRemoteDeletes: SyncPlanItem[] = [
      ...localEntries.map((local) => ({
        type: SyncActionType.ConfirmLocalDelete,
        path: local.path,
        local,
        decisionToken: {
          version: 1,
          vaultName: "testVault",
          accountId: scope.accountId,
          scope,
          local: { exists: true, hash: local.hash, size: local.size },
          remote: { exists: false },
          ancestorHash: null,
        },
      } as unknown as SyncPlanItem)),
      ...(folderPath === undefined
        ? []
        : [{
            type: SyncActionType.ConfirmLocalDelete,
            path: folderPath,
            folder: {
              remoteId: "remote-folder",
              parentRemoteId,
              parentPath: "",
              childCount: folderChildCount,
            },
          } as unknown as SyncPlanItem]),
    ];
    const events: string[] = [];
    const removedPaths: string[] = [];
    let eraseInFlight = 0;
    let erasePeak = 0;
    const adapter = makeMockAdapter({
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      remove: vi.fn(async (path: string) => {
        // Hold the erase open for one turn: the wave must still run exactly one
        // at a time (`trashFile` lock on Android).
        eraseInFlight++;
        erasePeak = Math.max(erasePeak, eraseInFlight);
        try {
          if (!input.fast) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          if (path === input.failErasePath) {
            throw new Error(`erase failed: ${path}`);
          }
          removedPaths.push(path);
          events.push(`remove:${path}`);
          input.afterErase?.(path);
        } finally {
          eraseInFlight--;
        }
      }),
    });
    const trashed: string[] = [];
    const trashFile = vi.fn(async (file: unknown) => {
      const path = (file as { path?: string }).path ?? "";
      trashed.push(path);
      events.push(`trash:${path}`);
    });
    const ledger: Array<{
      intent: MutationIntentV1;
      receipt: MutationReceiptV1 | null;
    }> = [];
    const ledgerSinkWrites: string[][] = [];
    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 1,
      commitSeq: 1,
      committedAt: 1,
      remoteEntries: [],
      remoteFolders: [],
      baseEntries: [],
    });
    envelope.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: folderPath === undefined
        ? {}
        : {
            "folder-anchor": {
              anchorId: "folder-anchor",
              remoteId: "remote-folder",
              lastPath: folderPath,
              parentRemoteId,
              confirmedGeneration: 1,
              confirmedAt: 1,
            },
          },
    };
    const state = {
      ...remoteStateStub(),
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      mutationLedger: ledger,
      boundAccountId: scope.accountId,
      remoteScope: scope,
      pendingRemoteDeletes,
      planReviewRevision: 0,
      baseSnapshot: [],
      pendingIssues: [],
      getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
      peekCommittedV2Envelope: vi.fn(() => envelope),
      remoteIdForPath: vi.fn((path: string) => `remote-id-${path}`),
      recordCloudDeletion: vi.fn().mockResolvedValue(undefined),
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      retireMutationCheckpointIfReflected: vi.fn().mockResolvedValue(false),
      beginMutationIntents: vi.fn(async (intents: MutationIntentV1[]) => {
        for (const intent of intents) ledger.push({ intent, receipt: null });
      }),
      abandonMutationIntent: vi.fn(async (operationId: string) => {
        const index = ledger.findIndex(
          (entry) => entry.intent.operationId === operationId,
        );
        if (index >= 0) ledger.splice(index, 1);
      }),
      recordMutationReceipts: vi.fn(async (receipts: MutationReceiptV1[]) => {
        for (const receipt of receipts) {
          const record = ledger.find(
            (entry) => entry.intent.operationId === receipt.operationId,
          );
          if (!record) {
            throw new Error(`Mutation intent missing: ${receipt.operationId}`);
          }
          record.receipt = receipt;
        }
      }),
      recordCloudDeletions: vi.fn(async (entries: Array<{ path: string }>) => {
        ledgerSinkWrites.push(entries.map((entry) => entry.path));
      }),
      commitMutationCheckpoints: vi.fn(async (operationIds: readonly string[]) => {
        events.push(`checkpoint:${operationIds.length}`);
        for (const operationId of operationIds) {
          const index = ledger.findIndex(
            (entry) => entry.intent.operationId === operationId,
          );
          if (index < 0 || ledger[index].receipt === null) {
            throw new Error(`Mutation receipt missing: ${operationId}`);
          }
          ledger.splice(index, 1);
        }
        return {
          operations: operationIds.length,
          ancestorPublishMs: 0,
          v2CommitMs: 0,
          ledgerClearMs: 0,
          totalMs: 0,
        };
      }),
    } as unknown as StateManager;
    const vault = {
      configDir: ".obsidian",
      adapter,
      getFileByPath: vi.fn().mockReturnValue(null),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
      getAbstractFileByPath: vi.fn((path: string) =>
        folderPath !== undefined
        && path === folderPath
        && !trashed.includes(path)
          ? new TFolder(path)
          : null),
    };
    const onedrive = makeMockOneDrive({
      getFileMetadataByPaths: vi.fn(
        async (_vaultName: string, batch: readonly string[]) => {
          input.duringBatchRead?.(batch);
          await input.batchReadGate?.(batch);
          return new Map(batch.map((path) => [path, null]));
        },
      ),
      getFileMetadata: vi.fn(async () => null),
      getDriveItemMetadataById: vi.fn(async () => null),
    });
    const notice = makeNoticeRecorder();
    let inspectInFlight = 0;
    let inspectPeak = 0;
    const executor = new SyncExecutor(
      onedrive,
      {
        vault,
        shouldSyncPath: vi.fn().mockReturnValue(true),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        inspectFile: vi.fn(async (path: string) => {
          // The only-copy re-check is the expensive read; hold it open for one
          // turn so the wave's bounded fan-out is observable.
          inspectInFlight++;
          inspectPeak = Math.max(inspectPeak, inspectInFlight);
          if (!input.fast) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          inspectInFlight--;
          const entry = localEntries.find((candidate) => candidate.path === path);
          return entry
            ? { status: "present" as const, entry }
            : { status: "missing" as const };
        }),
        inspectFileStat: vi.fn(async (path: string) => {
          const facts = localFacts.get(path);
          return facts
            ? { status: "present" as const, ...facts }
            : { status: "missing" as const };
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      input.diag,
      { trashFile } as unknown as import("obsidian").FileManager,
      undefined,
      undefined,
      notice.center,
      undefined,
      input.onSelfLocalDelete,
    );
    return {
      executor,
      adapter,
      state,
      ledger,
      ledgerSinkWrites,
      removedPaths,
      trashed,
      events,
      notices: notice.messages,
      localFacts,
      inspectPeak: () => inspectPeak,
      erasePeak: () => erasePeak,
    };
  }

  const wavePaths = (count = WAVE): string[] =>
    Array.from({ length: count }, (_unused, index) =>
      `wave-${String(index).padStart(2, "0")}.md`);

  it("settles eight confirmed file deletes as one wave: one intent, receipt, ledger and checkpoint write", async () => {
    const paths = wavePaths();
    const log = vi.fn();
    const diag = {
      log,
      warn: vi.fn(),
      error: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(false),
    } as unknown as DiagnosticLogger;
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: paths,
      diag,
    });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.removedPaths).toEqual(paths);
    expect(harness.state.beginMutationIntents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.state.beginMutationIntents).mock.calls[0][0])
      .toHaveLength(WAVE);
    expect(harness.state.recordMutationReceipts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.state.recordMutationReceipts).mock.calls[0][0])
      .toHaveLength(WAVE);
    expect(harness.state.recordCloudDeletions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.state.recordCloudDeletions).mock.calls[0][0])
      .toHaveLength(WAVE);
    expect(harness.state.commitMutationCheckpoints).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.state.commitMutationCheckpoints).mock.calls[0][0])
      .toHaveLength(WAVE);
    // The per-item writes are fully replaced inside a wave.
    expect(harness.state.beginMutationIntent).not.toHaveBeenCalled();
    expect(harness.state.recordMutationReceipt).not.toHaveBeenCalled();
    expect(harness.state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(harness.state.recordCloudDeletion).not.toHaveBeenCalled();
    // The wave's deletion clues ride the one sink write.
    expect(harness.ledgerSinkWrites).toEqual([[...paths].sort()]);
    expect(harness.executor.hasSideActionsInFlight).toBe(false);
    // Hard parameters: the read-only re-check fans out 4-wide on desktop while
    // the local erase segment stays strictly one-at-a-time.
    expect(harness.inspectPeak()).toBe(4);
    expect(harness.erasePeak()).toBe(1);
    expect(harness.events.filter((event) => event.startsWith("remove:")))
      .toEqual(paths.map((path) => `remove:${path}`));

    const settled = log.mock.calls.filter(
      (call) => call[1] === "confirm delete wave settled",
    );
    expect(settled).toHaveLength(1);
    const data = settled[0]?.[2] as {
      files: number;
      intentMs: number;
      localCheckMs: number;
      deleteMs: number;
      eraseMs: number;
      receiptMs: number;
      ledgerMs: number;
      checkpointMs: number;
      totalMs: number;
    };
    expect(data.files).toBe(WAVE);
    for (const ms of [
      data.intentMs,
      data.localCheckMs,
      data.deleteMs,
      data.eraseMs,
      data.receiptMs,
      data.ledgerMs,
      data.checkpointMs,
      data.totalMs,
    ]) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    // Observation only: the wave total can never be shorter than its serial
    // erase segment.
    expect(data.totalMs).toBeGreaterThanOrEqual(data.deleteMs);
  });

  it("splits a batch larger than one wave into serial waves of sixteen (desktop)", async () => {
    const paths = wavePaths(17);
    const harness = await makeConfirmDeleteWaveHarness({ filePaths: paths });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.removedPaths).toEqual(paths);
    expect(
      vi.mocked(harness.state.beginMutationIntents).mock.calls.map(
        (call) => call[0].length,
      ),
    ).toEqual([16, 1]);
    expect(
      vi.mocked(harness.state.recordMutationReceipts).mock.calls.map(
        (call) => call[0].length,
      ),
    ).toEqual([16, 1]);
    expect(harness.state.commitMutationCheckpoints).toHaveBeenCalledTimes(2);
    // Waves stay serial: the first wave's checkpoint lands before the second
    // wave's first erase.
    expect(harness.events).toEqual([
      ...paths.slice(0, 16).map((path) => `remove:${path}`),
      "checkpoint:16",
      `remove:${paths[16]}`,
      "checkpoint:1",
    ]);
  });

  it("keeps one failed erase to its own item: the other seven settle in the shared checkpoint", async () => {
    const paths = wavePaths();
    const failedPath = paths[2];
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: paths,
      failErasePath: failedPath,
      diag: {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        isEnabled: vi.fn().mockReturnValue(false),
      } as unknown as DiagnosticLogger,
    });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.removedPaths).toEqual(
      paths.filter((path) => path !== failedPath),
    );
    // The failed member never enters the shared checkpoint …
    expect(harness.state.recordMutationReceipts).toHaveBeenCalledTimes(1);
    const receipted = vi.mocked(harness.state.recordMutationReceipts)
      .mock.calls[0][0] as Array<{ operationId: string }>;
    expect(receipted).toHaveLength(WAVE - 1);
    expect(vi.mocked(harness.state.commitMutationCheckpoints).mock.calls[0][0])
      .toEqual(receipted.map((receipt) => receipt.operationId));
    // … and keeps the per-item exit: same-action recovery proved the erase not
    // applied (the local copy is still there), so its intent is abandoned and
    // the pending row stays for the user.
    expect(harness.ledger).toHaveLength(0);
    const failedIntent = vi.mocked(harness.state.beginMutationIntents)
      .mock.calls[0][0]
      .find((intent) => intent.path === failedPath);
    expect(failedIntent).toBeDefined();
    expect(harness.state.abandonMutationIntent).toHaveBeenCalledWith(
      failedIntent!.operationId,
    );
    // Same per-item exit: one failure notice for the one member that failed
    // (success notices stay off for a batch, as before this change).
    expect(harness.notices).toEqual(["notice.delete.failed"]);
    expect(harness.executor.hasSideActionsInFlight).toBe(false);
  });

  it("skips only the wave member whose local facts changed before its erase", async () => {
    const paths = wavePaths();
    const changedPath = paths[2];
    let changedFacts: Map<string, { size: number; mtime: number }> | null = null;
    let mutationApplied = false;
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: paths,
      afterErase: () => {
        // The reviewed SHA-256 guard already passed for the whole wave. Mutate
        // one later member's stat facts, then let the serial erase continue:
        // its turn must see the drift and skip only that member.
        if (mutationApplied || !changedFacts) return;
        mutationApplied = true;
        changedFacts.set(changedPath, { size: 999, mtime: 2 });
      },
    });
    changedFacts = harness.localFacts;

    await harness.executor.confirmRemoteDeletes(paths);

    expect(mutationApplied).toBe(true);
    expect(harness.removedPaths).toEqual(
      paths.filter((path) => path !== changedPath),
    );
    // Same per-item failure surface as a rejected guard: one notice, pending
    // row kept. The other seven members settle through the shared checkpoint.
    expect(harness.notices).toEqual(["notice.delete.failed"]);
    expect(harness.state.removePendingDelete).not.toHaveBeenCalled();
    const intents = vi.mocked(harness.state.beginMutationIntents)
      .mock.calls[0][0];
    expect(intents).toHaveLength(WAVE);
    const skippedIntent = intents.find((intent) => intent.path === changedPath);
    expect(skippedIntent).toBeDefined();
    expect(harness.state.abandonMutationIntent).toHaveBeenCalledWith(
      skippedIntent!.operationId,
    );
    expect(harness.state.recordMutationReceipts).toHaveBeenCalledTimes(1);
    const receipts = vi.mocked(harness.state.recordMutationReceipts)
      .mock.calls[0][0];
    expect(receipts).toHaveLength(WAVE - 1);
    expect(receipts.map((receipt) => receipt.operationId))
      .not.toContain(skippedIntent!.operationId);
    expect(vi.mocked(harness.state.commitMutationCheckpoints).mock.calls[0][0])
      .toEqual(receipts.map((receipt) => receipt.operationId));
    // Every intent is either receipted+checkpointed or abandoned: no
    // intent-only record is left for the next round.
    expect(harness.ledger).toHaveLength(0);
  });

  it("leaves at most one wave of intent-only records when the user cancels mid-wave", async () => {
    const paths = wavePaths();
    let erased = 0;
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: paths,
      afterErase: () => {
        erased++;
        if (erased === 2) harness.executor.cancel();
      },
    });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.removedPaths).toEqual(paths.slice(0, 2));
    expect(harness.state.beginMutationIntents).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.state.beginMutationIntents).mock.calls[0][0])
      .toHaveLength(WAVE);
    // The two erased members keep their receipt; the rest stay intent-only for
    // the next round's mutation recovery, and the shared checkpoint is skipped.
    expect(harness.state.recordMutationReceipts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.state.recordMutationReceipts).mock.calls[0][0])
      .toHaveLength(2);
    expect(harness.state.commitMutationCheckpoints).not.toHaveBeenCalled();
    const intentOnly = harness.ledger.filter(
      (record) => record.receipt === null,
    );
    expect(intentOnly).toHaveLength(WAVE - 2);
    expect(intentOnly.length).toBeLessThanOrEqual(WAVE);
    // The deletion clues still land: the local copies are already gone.
    expect(harness.ledgerSinkWrites).toEqual([[...paths.slice(0, 2)].sort()]);
  });

  it("runs folder rows only after every file row settled and the file wave checkpoint landed", async () => {
    const folder = "FolderX";
    const children = Array.from({ length: WAVE }, (_unused, index) =>
      `${folder}/n${index}.md`);
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: children,
      folderPath: folder,
    });

    await harness.executor.confirmRemoteDeletes([folder, ...children]);

    expect(harness.events).toEqual([
      ...children.map((path) => `remove:${path}`),
      `checkpoint:${WAVE}`,
      `trash:${folder}`,
    ]);
    expect(harness.trashed).toEqual([folder]);
    expect(harness.executor.hasSideActionsInFlight).toBe(false);
  });

  it("keeps the folder shell in the same batch when a round becomes visible before it runs", async () => {
    // 2026-10-28 真机反馈：文件与文件夹被拆成两轮。旧实现文件波先结批，
    // 文件夹缺席读取（网络）在空隙里做，此时任何插进来的轮次都会让
    // `enqueueSideAction` 以 `running` 拒绝文件夹行，下一轮计划再删壳。
    // 现在整批一条队列登记，文件夹段在已准入的任务里执行。
    const folder = "FolderX";
    const children = ["FolderX/a.md", "FolderX/b.md"];
    let executorRef: SyncExecutor | null = null;
    let queuedAtFirstRead = -1;
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: children,
      folderPath: folder,
      duringBatchRead: () => {
        if (queuedAtFirstRead < 0) {
          queuedAtFirstRead = executorRef?.queuedSideActionCount ?? -1;
        }
      },
      batchReadGate: (batch) => {
        // The folder's own absence read: simulate a round being dispatched in
        // the old file-wave/folder-shell gap.
        if (batch.length === 1 && batch[0] === folder) {
          (executorRef as unknown as { running: boolean }).running = true;
        }
      },
    });
    executorRef = harness.executor;

    await harness.executor.confirmRemoteDeletes([folder, ...children]);
    (harness.executor as unknown as { running: boolean }).running = false;

    expect(harness.trashed).toEqual([folder]);
    expect(harness.notices).toEqual([]);
    // Every confirmed row is registered before the first read, so the counter
    // covers the whole batch from the start (no 0/N restart for folders).
    expect(queuedAtFirstRead).toBe(children.length + 1);
  });

  it("reports every local erase as a plugin self-delete", async () => {
    const folder = "FolderX";
    const children = ["FolderX/a.md", "FolderX/b.md"];
    const onSelfLocalDelete = vi.fn();
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: children,
      folderPath: folder,
      onSelfLocalDelete,
    });

    await harness.executor.confirmRemoteDeletes([folder, ...children]);

    expect(onSelfLocalDelete.mock.calls.map((call) => call[0]))
      .toEqual([...children, folder]);
  });

  it("refuses an oversized, duplicate or folder wave before any write or erase", () => {
    // The wave slice caps itself at CONFIRM_DELETE_WAVE (8/16), so these edges
    // are unreachable through `confirmRemoteDeletes`; pin the fail-closed guard
    // itself, exactly like the cleanup-wave limit test.
    const members = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({ path: `w-${index}.md` }));
    expect(() => assertConfirmDeleteWaveWithinCheckpointLimit(
      members(MAX_MUTATION_CHECKPOINT_BATCH),
    )).not.toThrow();
    expect(() => assertConfirmDeleteWaveWithinCheckpointLimit(
      members(MAX_MUTATION_CHECKPOINT_BATCH + 1),
    )).toThrow(
      `Confirm delete wave must contain at most ${MAX_MUTATION_CHECKPOINT_BATCH} file deletes (got ${MAX_MUTATION_CHECKPOINT_BATCH + 1})`,
    );
    expect(() => assertConfirmDeleteWaveWithinCheckpointLimit([
      { path: "same.md" },
      { path: "same.md" },
    ])).toThrow("Confirm delete wave contains a duplicate path: same.md");
    expect(() => assertConfirmDeleteWaveWithinCheckpointLimit([
      { path: "FolderX", folder: { remoteId: "remote-folder" } },
    ])).toThrow("Confirm delete wave must contain file rows only");
  });

  it("settles a 2,001-row confirmed batch (2,000 files + 1 folder) in one call", async () => {
    // 真机现场（iOS 2026-10-27）：2,001 条待确认（2,000 文件 + 1 folder）点
    // 「全部删除」后每轮都只剩 2,000 条待确认、零意图、零异常。这条同时钉住：
    // ① 一条 folder 行不会让文件行作废（预检只吃文件切片，folder 走自己的逐条
    // 链）；② 整批在同一次调用里落定；③ 第一批删除不再等全批读取——旧实现是
    // 一次 2,001 条读取（101 个串行 $batch），首批要等它全部落地。
    const folder = "BulkX";
    const files = Array.from({ length: 2000 }, (_unused, index) =>
      `${folder}/f-${String(index).padStart(4, "0")}.md`);
    let inFlightAtBatchRead: boolean | null = null;
    let executorRef: SyncExecutor | null = null;
    const readBatches: string[][] = [];
    let readsAtFirstErase = -1;
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: files,
      folderPath: folder,
      fast: true,
      duringBatchRead: (batch) => {
        readBatches.push([...batch]);
        inFlightAtBatchRead ??= executorRef?.hasSideActionsInFlight ?? null;
      },
      afterErase: () => {
        if (readsAtFirstErase < 0) readsAtFirstErase = readBatches.length;
      },
    });
    executorRef = harness.executor;

    await harness.executor.confirmRemoteDeletes([folder, ...files]);

    expect(harness.removedPaths).toHaveLength(2000);
    expect(harness.trashed).toEqual([folder]);
    // 读取发生在入队之后（旧实现读在入队前 → 这里读到 false，且轮次能插进来）。
    expect(inFlightAtBatchRead).toBe(true);
    // 波内读取：第一刀只读一波，首批擦除只等 ≤2 次读取（本次 + 一次前瞻），
    // 125 个文件波各一次 + folder 行最后自己一次。
    expect(readBatches[0]).toHaveLength(16);
    expect(readsAtFirstErase).toBeGreaterThan(0);
    expect(readsAtFirstErase).toBeLessThanOrEqual(2);
    expect(readBatches).toHaveLength(126);
    expect(readBatches.at(-1)).toEqual([folder]);
    expect(harness.notices).toEqual([]);
    expect(harness.ledger).toHaveLength(0);
    expect(harness.executor.hasSideActionsInFlight).toBe(false);
    const waveSizes = vi.mocked(harness.state.beginMutationIntents)
      .mock.calls
      .map((call) => call[0].length);
    expect(waveSizes.reduce((sum, size) => sum + size, 0)).toBe(2000);
    expect(waveSizes.every((size) => size <= 16)).toBe(true);
  }, 120_000);

  it("deletes the first wave before the rest of the batch has been read", async () => {
    // 「前摇」验收：首批擦除只等自己那一波的读取，不等整批。旧实现一次读取
    // 覆盖全批（2,001 条 = 101 个串行 $batch），第一刀要等全部落地；这里把
    // 第二波起的读取全部挂住，第一波仍应删完。
    const files = Array.from({ length: 32 }, (_unused, index) =>
      `porch/f-${String(index).padStart(2, "0")}.md`);
    let readCount = 0;
    let releaseReads: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const harness = await makeConfirmDeleteWaveHarness({
      filePaths: files,
      fast: true,
      batchReadGate: () => {
        readCount++;
        return readCount > 1 ? blocked : undefined;
      },
    });

    let settled = false;
    const batch = harness.executor.confirmRemoteDeletes(files).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settled).toBe(false);
    expect(harness.removedPaths).toEqual(files.slice(0, 16));
    expect(readCount).toBe(2);

    releaseReads!();
    await batch;

    expect(harness.removedPaths).toEqual(files);
    expect(harness.notices).toEqual([]);
    expect(harness.ledger).toHaveLength(0);
  }, 120_000);

  it("waits out a running round instead of dropping the confirmed batch", async () => {
    // 旧实现：`enqueueSideAction` 见到 `running` 直接拒绝（只有一条瞬时提示），
    // 整批 2,000 条一行不删、pending 原样留下。现在先等轮次结束再入队。
    const paths = wavePaths(4);
    const harness = await makeConfirmDeleteWaveHarness({ filePaths: paths });
    const running = harness.executor as unknown as { running: boolean };
    running.running = true;

    let settled = false;
    const batch = harness.executor.confirmRemoteDeletes(paths).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    expect(harness.removedPaths).toEqual([]);

    running.running = false;
    await batch;

    expect(harness.removedPaths).toEqual(paths);
    expect(harness.notices).toEqual([]);
    expect(harness.ledger).toHaveLength(0);
  }, 120_000);
});

describe("folder confirm-delete batch absence verification", () => {
  interface FolderDeleteConfirmInput {
    paths: readonly string[];
    batchAbsent?: (paths: readonly string[]) => Promise<Map<string, unknown>>;
    batchError?: Error;
    /** Folder paths whose per-item by-path remote check reports the folder still present. */
    remotePresentPaths?: readonly string[];
    /** Folder anchor remoteIds reported present by the by-ID metadata guard. */
    remotePresentByIds?: readonly string[];
  }

  async function makeFolderDeleteConfirmHarness(input: FolderDeleteConfirmInput) {
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
    const parentRemoteId = "committed-parent-id";

    // One pending folder delete per path. `folder.remoteId` truthy routes the
    // confirm through the deleteLocalFolder branch.
    const pendingRemoteDeletes: SyncPlanItem[] = input.paths.map((path, index) => ({
      type: SyncActionType.ConfirmLocalDelete,
      path,
      folder: {
        remoteId: `remote-${index}`,
        parentRemoteId,
        parentPath: "",
        childCount: 0,
      },
    } as unknown as SyncPlanItem));

    // Build a committed V2 envelope whose folder anchors resolve each pending
    // folder by remoteId AND lastPath, matching the deleteLocalFolder lookup.
    const baseEntries: BaseFileEntry[] = [];
    const remoteEntries: RemoteFileEntry[] = [];
    const remoteFolders: RemoteFolderEntry[] = [];
    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 1,
      commitSeq: 1,
      committedAt: 1,
      remoteEntries,
      remoteFolders,
      baseEntries,
    });
    const byAnchorId: Record<string, import("../src/sync/state-envelope-v2").FolderAnchorV2> = {};
    input.paths.forEach((path, index) => {
      const anchorId = `folder-anchor-${index}`;
      byAnchorId[anchorId] = {
        anchorId,
        remoteId: `remote-${index}`,
        lastPath: path,
        parentRemoteId,
        confirmedGeneration: 1,
        confirmedAt: 1,
      };
    });
    envelope.folderAnchors = {
      schemaVersion: 2,
      byAnchorId,
    };

    // `trashFile` flips the folder to absent so the read-back passes.
    const trashed = new Set<string>();
    const trashFile = vi.fn(async (folder: unknown) => {
      trashed.add((folder as { path?: string }).path ?? "");
    });
    const vault = {
      configDir: ".obsidian",
      adapter: makeMockAdapter({
        exists: vi.fn().mockResolvedValue(false),
        list: vi.fn(async () => ({ files: [], folders: [] })),
      }),
      getFileByPath: vi.fn().mockReturnValue(null),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
      getAbstractFileByPath: vi.fn((path: string) =>
        trashed.has(path) ? null : new TFolder(path)),
    };

    const state = {
      ...remoteStateStub(),
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      boundAccountId: scope.accountId,
      remoteScope: scope,
      pendingRemoteDeletes,
      planReviewRevision: 0,
      baseSnapshot: [],
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
      peekCommittedV2Envelope: vi.fn(() => envelope),
      retireMutationCheckpointIfReflected: vi.fn().mockResolvedValue(false),
    } as unknown as StateManager;

    // Per-item by-path remote check backing `inspectRemoteFolder`. Aliased as
    // `getDriveItemMetadata` (which `inspectRemoteFolder` actually calls) and
    // exposed as `getFileMetadata` for the batch-fallback assertions.
    const getFileMetadata = vi.fn(async (_vaultName: string, path: string) => {
      if (input.remotePresentPaths?.includes(path)) {
        return {
          eTag: "etag-reappeared",
          cTag: "ctag-reappeared",
          size: 1,
          driveId: "reappeared-id",
          parentId: scope.filesRootId,
          mtime: 2,
          sha256Hash: "aa".repeat(32),
        };
      }
      return null;
    });
    const getDriveItemMetadata = getFileMetadata;
    const getDriveItemMetadataById = vi.fn(async (driveItemId: string) => {
      if (input.remotePresentByIds?.includes(driveItemId)) {
        return {
          id: driveItemId,
          eTag: "etag-by-id",
          name: "still-present",
          parentReference: { id: parentRemoteId },
        } as DriveItem;
      }
      return null;
    });
    const getFileMetadataByPaths = input.batchError
      ? vi.fn(async () => { throw input.batchError; })
      : input.batchAbsent
        ? vi.fn(async (_vaultName: string, paths: readonly string[]) =>
            input.batchAbsent!(paths))
        : vi.fn(async (_vaultName: string, paths: readonly string[]) =>
            new Map(paths.map((path) => [path, null])));
    const onedrive = makeMockOneDrive({
      getFileMetadata,
      getDriveItemMetadata,
      getFileMetadataByPaths,
      getDriveItemMetadataById,
    });

    const executor = new SyncExecutor(
      onedrive,
      {
        vault,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        inspectFile: vi.fn(async () => ({ status: "missing" as const })),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      undefined,
      { trashFile } as unknown as import("obsidian").FileManager,
    );

    return {
      executor,
      getFileMetadata,
      getFileMetadataByPaths,
      getDriveItemMetadataById,
      trashFile,
      trashed,
      state,
      vault,
      scope,
    };
  }

  it("pre-verifies a whole folder batch once and skips per-item by-path remote checks", async () => {
    const paths = Array.from({ length: 25 }, (_unused, index) => `Folder-${index}`);
    const harness = await makeFolderDeleteConfirmHarness({ paths });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.getFileMetadataByPaths).toHaveBeenCalledTimes(1);
    expect(harness.getFileMetadataByPaths.mock.calls).toEqual([
      ["testVault", [...paths].sort()],
    ]);
    expect(harness.getFileMetadata).not.toHaveBeenCalled();
    expect(harness.trashFile).toHaveBeenCalledTimes(25);
    expect([...harness.trashed].sort()).toEqual([...paths].sort());
    expect(harness.executor.hasSideActionsInFlight).toBe(false);
  });

  it("falls back to per-item remote checks for folders when the batch read fails", async () => {
    const paths = Array.from({ length: 4 }, (_unused, index) => `Folder-${index}`);
    const harness = await makeFolderDeleteConfirmHarness({
      paths,
      batchError: new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.getFileMetadata).toHaveBeenCalledTimes(paths.length);
    expect(harness.getFileMetadata.mock.calls.map((call) => call[1]).sort())
      .toEqual([...paths].sort());
    expect(harness.trashFile).toHaveBeenCalledTimes(paths.length);
  });

  it("skips only the by-path check while still guarding by ID for a preverified folder", async () => {
    const paths = ["FolderA"];
    const harness = await makeFolderDeleteConfirmHarness({
      paths,
      remotePresentByIds: ["remote-0"],
    });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.getDriveItemMetadataById).toHaveBeenCalledWith("remote-0");
    expect(harness.getFileMetadata).not.toHaveBeenCalled();
    expect(harness.trashFile).not.toHaveBeenCalled();
  });

  it("blocks a preverified folder whose path reappeared in the batch", async () => {
    const paths = ["FolderA", "FolderB"];
    const harness = await makeFolderDeleteConfirmHarness({
      paths,
      remotePresentPaths: ["FolderB"],
      batchAbsent: async (batchPaths: readonly string[]) =>
        new Map(batchPaths.map((path) =>
          [path, path === "FolderB" ? { id: "reappeared" } : null])),
    });

    await harness.executor.confirmRemoteDeletes(paths);

    expect([...harness.trashed].sort()).toEqual(["FolderA"]);
    expect(harness.getFileMetadata.mock.calls).toEqual([["testVault", "FolderB"]]);
  });

  it("reads a mixed file+folder batch in wave-scoped reads, never one whole-batch read", async () => {
    const paths = ["note-a.md", "FolderA", "note-b.md", "Parent/Child"];
    // Two entries are files (pending.folder absent) and two are folders.
    const pendingByKind: Record<string, "file" | "folder"> = {
      "note-a.md": "file",
      "note-b.md": "file",
      "FolderA": "folder",
      "Parent/Child": "folder",
    };
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
    const parentRemoteId = "committed-parent-id";
    const pendingRemoteDeletes: SyncPlanItem[] = paths.map((path, index) => {
      const kind = pendingByKind[path];
      if (kind === "folder") {
        return {
          type: SyncActionType.ConfirmLocalDelete,
          path,
          folder: {
            remoteId: `remote-${index}`,
            parentRemoteId,
            parentPath: "",
            childCount: 0,
          },
        } as unknown as SyncPlanItem;
      }
      return {
        type: SyncActionType.ConfirmLocalDelete,
        path,
        local: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
      } as unknown as SyncPlanItem;
    });
    const batchPaths = new Set<string>();
    const getFileMetadataByPaths = vi.fn(async (_vaultName: string, batch: readonly string[]) => {
      for (const path of batch) batchPaths.add(path);
      return new Map(batch.map((path) => [path, null]));
    });
    const getFileMetadata = vi.fn(async () => null);
    const getDriveItemMetadataById = vi.fn(async () => null);
    const trashed = new Set<string>();
    const trashFile = vi.fn(async (folder: unknown) => {
      trashed.add((folder as { path?: string }).path ?? "");
    });
    const adapter = makeMockAdapter({
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      remove: vi.fn(async (path: string) => {
        trashed.add(path);
      }),
    });
    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 1,
      commitSeq: 1,
      committedAt: 1,
      remoteEntries: [],
      remoteFolders: [],
      baseEntries: [],
    });
    const byAnchorId: Record<string, import("../src/sync/state-envelope-v2").FolderAnchorV2> = {};
    paths.forEach((path, index) => {
      if (pendingByKind[path] !== "folder") return;
      const anchorId = `folder-anchor-${index}`;
      byAnchorId[anchorId] = {
        anchorId,
        remoteId: `remote-${index}`,
        lastPath: path,
        parentRemoteId,
        confirmedGeneration: 1,
        confirmedAt: 1,
      };
    });
    envelope.folderAnchors = { schemaVersion: 2, byAnchorId };
    const state = {
      ...remoteStateStub(),
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      boundAccountId: scope.accountId,
      remoteScope: scope,
      pendingRemoteDeletes,
      planReviewRevision: 0,
      baseSnapshot: [],
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
      peekCommittedV2Envelope: vi.fn(() => envelope),
      retireMutationCheckpointIfReflected: vi.fn().mockResolvedValue(false),
    } as unknown as StateManager;
    const vault = {
      configDir: ".obsidian",
      adapter,
      getFileByPath: vi.fn().mockReturnValue(null),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
      getAbstractFileByPath: vi.fn((path: string) =>
        trashed.has(path) ? null : new TFolder(path)),
    };
    const onedrive = makeMockOneDrive({
      getFileMetadata,
      getDriveItemMetadata: getFileMetadata,
      getFileMetadataByPaths,
      getDriveItemMetadataById,
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        inspectFile: vi.fn(async (path: string) => ({
          status: "present" as const,
          entry: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
        })),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      undefined,
      { trashFile } as unknown as import("obsidian").FileManager,
    );

    await executor.confirmRemoteDeletes(paths);

    // One read for the file wave and one bounded read for the folder rows:
    // no read ever covers the whole mixed batch, so a big file set cannot delay
    // the first deletion behind the folder preparation either.
    expect(getFileMetadataByPaths).toHaveBeenCalledTimes(2);
    expect(
      getFileMetadataByPaths.mock.calls.map((call) => [...call[1]].sort()),
    ).toEqual([
      ["note-a.md", "note-b.md"],
      ["FolderA", "Parent/Child"],
    ]);
    expect(batchPaths.size).toBe(paths.length);
    for (const path of paths) {
      expect(batchPaths.has(path)).toBe(true);
    }
    // Every row was proven absent by its own read; no per-item by-path checks.
    expect(getFileMetadata).not.toHaveBeenCalled();
  });

  it("performs the per-item by-path remote check for a single non-batch folder confirm", async () => {
    const paths = ["FolderA"];
    const harness = await makeFolderDeleteConfirmHarness({ paths });

    await harness.executor.confirmRemoteDelete("FolderA");

    expect(harness.getFileMetadata).toHaveBeenCalledTimes(1);
    expect(harness.getFileMetadata.mock.calls).toEqual([["testVault", "FolderA"]]);
    expect(harness.trashFile).toHaveBeenCalledTimes(1);
  });

  it("settles a mixed file+folder batch in one call — child files are removed before the folder shell", async () => {
    const folder = "FolderX";
    const children = ["FolderX/n1.md", "FolderX/n2.md"];
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
    const parentRemoteId = "committed-parent-id";
    const localEntry = (path: string, index: number) => ({
      path,
      hash: `local-hash-${index}`.padEnd(64, "0"),
      size: 10 + index,
      mtime: 1,
      binary: false,
    });
    const pendingRemoteDeletes: SyncPlanItem[] = [
      ...children.map((path, index) => {
        const local = localEntry(path, index);
        return {
          type: SyncActionType.ConfirmLocalDelete,
          path,
          local,
          decisionToken: {
            version: 1,
            vaultName: "testVault",
            accountId: scope.accountId,
            scope,
            local: { exists: true, hash: local.hash, size: local.size },
            remote: { exists: false },
            ancestorHash: null,
          },
        } as unknown as SyncPlanItem;
      }),
      {
        type: SyncActionType.ConfirmLocalDelete,
        path: folder,
        folder: {
          remoteId: "remote-folder",
          parentRemoteId,
          parentPath: "",
          childCount: children.length,
        },
      } as unknown as SyncPlanItem,
    ];
    // Local disk model: the folder contains the two children until the file
    // rows remove them; only then may the folder shell be trashed.
    const diskFiles = new Set(children);
    const events: string[] = [];
    const adapter = makeMockAdapter({
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn(async (dirPath: string) => {
        if (dirPath !== folder) return { files: [], folders: [] };
        const files = [...diskFiles]
          .filter((path) => path.startsWith(`${folder}/`))
          .map((path) => path.slice(folder.length + 1));
        return { files, folders: [] };
      }),
      remove: vi.fn(async (path: string) => {
        diskFiles.delete(path);
        events.push(`remove:${path}`);
      }),
    });
    const trashed = new Set<string>();
    const trashFile = vi.fn(async (folderFile: unknown) => {
      const path = (folderFile as { path?: string }).path ?? "";
      trashed.add(path);
      events.push(`trash:${path}`);
    });
    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 1,
      commitSeq: 1,
      committedAt: 1,
      remoteEntries: [],
      remoteFolders: [],
      baseEntries: [],
    });
    envelope.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: {
        "folder-anchor-x": {
          anchorId: "folder-anchor-x",
          remoteId: "remote-folder",
          lastPath: folder,
          parentRemoteId,
          confirmedGeneration: 1,
          confirmedAt: 1,
        },
      },
    };
    const state = {
      ...remoteStateStub(),
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      boundAccountId: scope.accountId,
      remoteScope: scope,
      pendingRemoteDeletes,
      planReviewRevision: 0,
      baseSnapshot: [],
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
      peekCommittedV2Envelope: vi.fn(() => envelope),
      retireMutationCheckpointIfReflected: vi.fn().mockResolvedValue(false),
    } as unknown as StateManager;
    const vault = {
      configDir: ".obsidian",
      adapter,
      getFileByPath: vi.fn().mockReturnValue(null),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
      getAbstractFileByPath: vi.fn((path: string) =>
        trashed.has(path) ? null : path === folder ? new TFolder(path) : null),
    };
    const onedrive = makeMockOneDrive({
      getFileMetadataByPaths: vi.fn(async (_vaultName: string, batch: readonly string[]) =>
        new Map(batch.map((path) => [path, null]))),
      getFileMetadata: vi.fn(async () => null),
      getDriveItemMetadataById: vi.fn(async () => null),
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        inspectFile: vi.fn(async (path: string) => {
          const entry = localEntry(path, children.indexOf(path));
          return { status: "present" as const, entry };
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      undefined,
      { trashFile } as unknown as import("obsidian").FileManager,
    );

    // Folder row first in the input: the batch sort must still execute file
    // rows before the folder row so the shell is empty by the time it runs.
    await executor.confirmRemoteDeletes([folder, ...children]);

    expect(diskFiles.size).toBe(0);
    expect([...trashed]).toEqual([folder]);
    expect(events).toEqual([
      "remove:FolderX/n1.md",
      "remove:FolderX/n2.md",
      "trash:FolderX",
    ]);
    expect(executor.hasSideActionsInFlight).toBe(false);
  });

  it("keeps a folder row pending with actionable guidance while members remain", async () => {
    const folder = "FolderX";
    const children = ["FolderX/n1.md", "FolderX/n2.md"];
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-test" };
    const parentRemoteId = "committed-parent-id";
    const folderRow: SyncPlanItem = {
      type: SyncActionType.ConfirmLocalDelete,
      path: folder,
      folder: {
        remoteId: "remote-folder",
        parentRemoteId,
        parentPath: "",
        childCount: children.length,
      },
    } as unknown as SyncPlanItem;
    const diskFiles = new Set(children);
    const adapter = makeMockAdapter({
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn(async (dirPath: string) => {
        if (dirPath !== folder) return { files: [], folders: [] };
        const files = [...diskFiles]
          .filter((path) => path.startsWith(`${folder}/`))
          .map((path) => path.slice(folder.length + 1));
        return { files, folders: [] };
      }),
    });
    const trashed = new Set<string>();
    const trashFile = vi.fn(async (folderFile: unknown) => {
      trashed.add((folderFile as { path?: string }).path ?? "");
    });
    const envelope = createFileStateShadowEnvelopeV2({
      scope,
      lifecycleEpoch: 1,
      commitSeq: 1,
      committedAt: 1,
      remoteEntries: [],
      remoteFolders: [],
      baseEntries: [],
    });
    envelope.folderAnchors = {
      schemaVersion: 2,
      byAnchorId: {
        "folder-anchor-x": {
          anchorId: "folder-anchor-x",
          remoteId: "remote-folder",
          lastPath: folder,
          parentRemoteId,
          confirmedGeneration: 1,
          confirmedAt: 1,
        },
      },
    };
    const state = {
      ...remoteStateStub(),
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      boundAccountId: scope.accountId,
      remoteScope: scope,
      pendingRemoteDeletes: [folderRow],
      planReviewRevision: 0,
      baseSnapshot: [],
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      getCommittedV2Envelope: vi.fn(() => structuredClone(envelope)),
      peekCommittedV2Envelope: vi.fn(() => envelope),
      retireMutationCheckpointIfReflected: vi.fn().mockResolvedValue(false),
    } as unknown as StateManager;
    const vault = {
      configDir: ".obsidian",
      adapter,
      getFileByPath: vi.fn().mockReturnValue(null),
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
      getAbstractFileByPath: vi.fn((path: string) =>
        trashed.has(path) || path !== folder ? null : new TFolder(path)),
    };
    const onedrive = makeMockOneDrive({
      getFileMetadata: vi.fn(async () => null),
      getDriveItemMetadataById: vi.fn(async () => null),
      getFileMetadataByPaths: vi.fn(async (_vaultName: string, batch: readonly string[]) =>
        new Map(batch.map((path) => [path, null]))),
    });
    const messages: string[] = [];
    const i18nStub = {
      t: (key: string, params?: Record<string, string | number>): string =>
        key === "notice.delete.failed"
          ? `failed[${params?.reason ?? ""}]`
          : key,
    } as unknown as ConstructorParameters<typeof SyncExecutor>[4];
    const noticeCenterStub = {
      show: vi.fn((entry: { message: string }) => {
        messages.push(entry.message);
      }),
    } as unknown as ConstructorParameters<typeof SyncExecutor>[10];
    const executor = new SyncExecutor(
      onedrive,
      {
        vault,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        inspectFile: vi.fn(async () => ({ status: "missing" as const })),
      } as unknown as LocalScanner,
      state,
      "testVault",
      i18nStub,
      undefined,
      undefined,
      { trashFile } as unknown as import("obsidian").FileManager,
      undefined,
      undefined,
      noticeCenterStub,
    );

    await executor.confirmRemoteDelete(folder);

    // Nothing was deleted, the row stays pending, and the notice explains
    // what to do instead of reporting an empty-check failure.
    expect(trashFile).not.toHaveBeenCalled();
    expect(diskFiles.size).toBe(2);
    expect(state.removePendingDelete).not.toHaveBeenCalledWith(folder);
    expect(messages.some((message) => message.includes("reason.delete.folderNotEmpty")))
      .toBe(true);
  });
});

describe("recovery observation reviewed-cursor preservation", () => {
  const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };

  const makeSyncResult = (): SyncResult => ({
    success: false,
    uploaded: 0,
    downloaded: 0,
    foldersCreated: 0,
    foldersMoved: 0,
    foldersDeleted: 0,
    filesMoved: 0,
    deleted: 0,
    conflicts: 0,
    deferred: 0,
    skippedLarge: 0,
    skippedIgnored: 0,
    errors: 0,
    authExpired: false,
    message: "",
    runFacts: {
      termination: "normal",
      ordinaryPlanning: "not-entered",
      userFileChanges: "unknown",
    },
  });

  interface ObservationHarness {
    executor: SyncExecutor;
    state: StateManager;
    setRemoteState: ReturnType<typeof vi.fn>;
    getDelta: ReturnType<typeof vi.fn>;
  }

  // One committed file at "note.md", one receipted ledger record, envelope
  // complete at commitSeq 1 with cursor "delta-token". The delta mock returns
  // the same single item (or nothing) plus a NEW cursor — Graph rotates the
  // cursor on every call, so cursor-only differences are the no-change case.
  const makeObservationHarness = async (
    input: { changedETag?: string } = {},
  ): Promise<ObservationHarness> => {
    const path = "note.md";
    const localHash = "a".repeat(64);
    const committedEntry: RemoteFileEntry = {
      path,
      driveId: "note-id",
      parentId: scope.filesRootId,
      size: 5,
      mtime: 1,
      eTag: "etag-1",
      cTag: "ctag-1",
      sha256Hash: localHash,
    };
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "stuck-op",
      planRevision: 1,
      scope,
      action: "upload",
      path,
      expectedLocal: { exists: true, hash: localHash, size: 5 },
      expectedRemote: {
        exists: true,
        driveId: "note-id",
        eTag: "etag-1",
        size: 5,
        sha256Hash: localHash,
      },
      createdAt: 1,
    };
    const ledger: MutationLedgerEntryV1[] = [{
      intent,
      receipt: {
        version: 1,
        operationId: intent.operationId,
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    }];
    const state = makeActiveV2State([committedEntry], [], {
      mutationLedger: ledger,
    });
    const deltaItem = (eTag: string): DriveItem => ({
      id: "note-id",
      name: path,
      size: 5,
      eTag,
      cTag: "ctag-1",
      lastModifiedDateTime: new Date(1).toISOString(),
      parentReference: { id: scope.filesRootId, driveId: scope.driveId },
      file: { hashes: { sha256Hash: localHash } },
    });
    // Incremental (token) pages carry only changes; the token-less rebuild
    // feed carries the whole tree. Both rotate the cursor.
    const getDelta = vi.fn(async (_vault: string, token?: string) => ({
      value: token
        ? (input.changedETag ? [deltaItem(input.changedETag)] : [])
        : [deltaItem(input.changedETag ?? "etag-1")],
      "@odata.deltaLink": "delta-token-2",
    }));
    const onedrive = makeMockOneDrive({ getDelta });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault: {
          configDir: ".obsidian",
          adapter: makeMockAdapter(),
          getAbstractFileByPath: vi.fn().mockReturnValue(null),
          getFileByPath: vi.fn().mockReturnValue(null),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const setRemoteState = state.setRemoteState as unknown as ReturnType<
      typeof vi.fn
    >;
    return { executor, state, setRemoteState, getDelta };
  };

  const observe = async (
    harness: ObservationHarness,
    preserveSeq?: number,
    allowIncremental = true,
  ): Promise<void> => {
    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      observeCompleteRemoteStateForMutationRecovery(
        operationEpoch: number,
        result: SyncResult,
        syncScope: SyncScope,
        localEntries: LocalFileEntry[],
        allowIncremental: boolean,
        preserveReviewedSourceCommitSeq?: number,
      ): Promise<void>;
    }).observeCompleteRemoteStateForMutationRecovery(
      epoch,
      makeSyncResult(),
      scope,
      [],
      allowIncremental,
      preserveSeq,
    );
  };

  it("defers a projection-identical incremental observation while a reviewed plan is sealed at the current commit", async () => {
    // Graph rotates the cursor on every call: an unchanged tree still yields
    // a new deltaLink. Committing it would advance commitSeq and invalidate
    // the sealed plan identity every round (the 2026-09-12 confirm/re-pause
    // loop), so a fact-identical observation must defer the checkpoint.
    const harness = await makeObservationHarness();
    const before = harness.state.getCommittedV2Envelope();

    await observe(harness, before.meta.commitSeq);

    expect(harness.setRemoteState).not.toHaveBeenCalled();
    const after = harness.state.getCommittedV2Envelope();
    expect(after.meta.commitSeq).toBe(before.meta.commitSeq);
    expect(after.remoteIndex.deltaLink).toBe(before.remoteIndex.deltaLink);
  });

  it("still commits the incremental observation when no reviewed plan is sealed", async () => {
    const harness = await makeObservationHarness();

    await observe(harness, undefined);

    expect(harness.setRemoteState).toHaveBeenCalledTimes(1);
  });

  it("commits and lets the sealed plan invalidate when the observation sees a fact change", async () => {
    const harness = await makeObservationHarness({ changedETag: "etag-2" });
    const before = harness.state.getCommittedV2Envelope();

    await observe(harness, before.meta.commitSeq);

    expect(harness.setRemoteState).toHaveBeenCalledTimes(1);
  });

  it("defers a projection-identical full rebuild while a reviewed plan is sealed", async () => {
    const harness = await makeObservationHarness();
    const before = harness.state.getCommittedV2Envelope();

    await observe(harness, before.meta.commitSeq, false);

    expect(harness.setRemoteState).not.toHaveBeenCalled();
    const after = harness.state.getCommittedV2Envelope();
    expect(after.meta.commitSeq).toBe(before.meta.commitSeq);
  });

  it("commits a full rebuild that sees a fact change even while a reviewed plan is sealed", async () => {
    const harness = await makeObservationHarness({ changedETag: "etag-2" });
    const before = harness.state.getCommittedV2Envelope();

    await observe(harness, before.meta.commitSeq, false);

    expect(harness.setRemoteState).toHaveBeenCalledTimes(1);
  });
});

describe("blocked folder records auto-settle from current facts (2026-09-13 拍板)", () => {
  const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };

  const makeFolderRecord = (
    path = "second-brain/books",
  ): MutationLedgerEntryV1 => ({
    intent: {
      version: 2,
      operationId: "stuck-folder-op",
      planRevision: 1,
      scope,
      action: "createRemoteFolder",
      path,
      expectedLocal: { exists: true },
      expectedRemote: {
        exists: true,
        driveId: "folder-created",
        parentId: scope.filesRootId,
        eTag: "etag-created",
      },
      expectedParent: { driveId: scope.filesRootId, path: "" },
      createdAt: 1,
    },
    receipt: {
      version: 1,
      operationId: "stuck-folder-op",
      completedAt: 2,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        folderUpserts: [{
          path,
          driveId: "folder-created",
          parentId: scope.filesRootId,
          name: "books",
          eTag: "etag-created",
        }],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    },
  });

  const makeRecoverHarness = (
    record: MutationLedgerEntryV1,
    diag?: DiagnosticLogger,
  ) => {
    const committedEntry: RemoteFileEntry = {
      path: "note.md",
      driveId: "note-id",
      parentId: scope.filesRootId,
      size: 5,
      mtime: 1,
      eTag: "etag-1",
      cTag: "ctag-1",
      sha256Hash: "a".repeat(64),
    };
    const state = makeActiveV2State([committedEntry], [], {
      mutationLedger: [record],
    });
    const settleAsObserved = vi.fn(async () => true);
    (state as unknown as {
      settleFolderMutationRecoveryAsObserved: unknown;
    }).settleFolderMutationRecoveryAsObserved = settleAsObserved;
    const onedrive = makeMockOneDrive({
      getDriveItemMetadata: vi.fn(async (_vault: string, candidate: string) => ({
        id: "folder-created",
        name: candidate.split("/").pop(),
        folder: {},
        eTag: "etag-now",
        cTag: "ctag-now",
        parentReference: { id: scope.filesRootId, driveId: scope.driveId },
      })),
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault: {
          configDir: ".obsidian",
          adapter: makeMockAdapter({
            stat: vi.fn(async () => null),
          }),
          getAbstractFileByPath: vi.fn().mockReturnValue(null),
          getFileByPath: vi.fn().mockReturnValue(null),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      diag,
    );
    const epoch = (executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    const recover = () =>
      (executor as unknown as {
        recoverMutationLedger(
          syncScope: SyncScope,
          metrics: undefined,
          operationEpoch: number,
          observationOnly: boolean,
        ): Promise<unknown>;
      }).recoverMutationLedger(scope, undefined, epoch, false);
    return { state, settleAsObserved, recover, executor };
  };

  it("auto-retires a drifted receipted folder record with an audit entry and no blocked state", async () => {
    const record = makeFolderRecord();
    const { settleAsObserved, recover } = makeRecoverHarness(record);

    await recover();

    expect(settleAsObserved).toHaveBeenCalledTimes(1);
    expect(settleAsObserved).toHaveBeenCalledWith({
      expectedRecord: record,
    });
  });

  it("keeps the fail-closed block for folder records on managed paths (no auto-settle)", async () => {
    const record = makeFolderRecord(".obsidian/appearance.json");
    const { settleAsObserved, recover } = makeRecoverHarness(record);

    await expect(recover()).rejects.toThrow();
    expect(settleAsObserved).not.toHaveBeenCalled();
  });

  it("says why the eligibility gate refuses a folder record (no silent dead-end)", async () => {
    const record = makeFolderRecord(".obsidian/appearance.json");
    const warn = vi.fn();
    const diag = {
      log: vi.fn(),
      warn,
      error: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
    } as unknown as DiagnosticLogger;
    const { settleAsObserved, recover } = makeRecoverHarness(record, diag);

    await expect(recover()).rejects.toThrow();
    expect(settleAsObserved).not.toHaveBeenCalled();
    const gateWarns = warn.mock.calls.filter((call) =>
      String(call[1]).includes("not eligible for auto-settlement"));
    expect(gateWarns).toHaveLength(1);
    expect(gateWarns[0]?.[1]).toEqual(
      expect.stringContaining("not eligible for auto-settlement"),
    );
    expect(gateWarns[0]?.[2]).toEqual(expect.objectContaining({
      operationId: "stuck-folder-op",
      reason: expect.stringContaining(".obsidian/appearance.json"),
      mutations: 0,
    }));
  });

  it("records local/remote evidence when a download intent stays blocked", async () => {
    const downloadRecord: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "stuck-download-op",
        planRevision: 1,
        scope,
        action: "download",
        path: "附件/录音/resojot-20260918012656-2.m4a",
        expectedLocal: { exists: false },
        expectedRemote: {
          exists: true,
          driveId: "remote-1",
          eTag: "etag-1",
          size: 5,
          sha256Hash: "a".repeat(64),
        },
        createdAt: 1,
      },
      receipt: null,
    };
    const log = vi.fn();
    const diag = {
      log,
      warn: vi.fn(),
      error: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
    } as unknown as DiagnosticLogger;
    const { executor } = makeRecoverHarness(downloadRecord, diag);
    (executor as unknown as {
      inspectLocalPath: unknown;
    }).inspectLocalPath = vi.fn(async () => ({
      status: "present",
      entry: { hash: "b".repeat(64), size: 9 },
    }));
    (executor as unknown as {
      inspectRemotePath: unknown;
    }).inspectRemotePath = vi.fn(async () => ({
      driveId: "remote-1",
      eTag: "etag-1",
    }));

    await (executor as unknown as {
      logBlockedDownloadEvidence(
        record: MutationLedgerEntryV1,
      ): Promise<void>;
    }).logBlockedDownloadEvidence(downloadRecord);

    expect(log).toHaveBeenCalledWith(
      "state",
      "blocked download evidence: local and remote facts",
      expect.objectContaining({
        operationId: "stuck-download-op",
        localStatus: "present",
        remoteMatchesExpectation: true,
        mutations: 0,
      }),
      { urgent: true },
    );
  });
});

