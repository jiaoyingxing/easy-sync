// 取消检查点、阶段可观测与运行记账
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import * as obsidian from "obsidian";
import {
  sha256Hex,
} from "../src/crypto";
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
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import { OneDriveClient, ResponseByteBudgetError } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType, type DriveItem } from "../src/onedrive/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { PendingIssue } from "../src/sync/types";
import { generateFileDecisionPlanV2 } from "../src/sync/file-decision-planner-v2";
import { StateManager } from "../src/sync/state-manager";
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

describe("Cancellation checkpoint semantics", () => {
  it("does not record an aborted in-flight transfer as a sync failure after user cancellation", async () => {
    let executor: SyncExecutor;
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const remote: RemoteFileEntry = {
      path: "cancelled.md",
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-1",
      cTag: "ctag-1",
    };
    const executorState = makeActiveV2State([remote], [], {
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
      reconcilePendingIssues,
    });
    executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockImplementation(async () => {
          executor.cancel();
          throw abortError;
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      executorState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.cancelled");
    expect(result.errors).toBe(0);
    expect(result.metrics?.fileTransfers.download).toMatchObject({
      started: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 1,
      skipped: 0,
      logicalBytes: 0,
      peakConcurrency: 1,
    });
    expect(reconcilePendingIssues).not.toHaveBeenCalled();
  });

  it("records a durable receipt but commits no shared state after cancellation", async () => {
    let executor: SyncExecutor;
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockImplementation(async () => {
      executor.cancel();
      return {
        id: "uploaded-id",
        name: "first.md",
        size: 3,
        eTag: "uploaded-etag",
        cTag: "uploaded-ctag",
      };
    });
    const localEntries = ["first.md", "second.md"].map((path): LocalFileEntry => ({
      path,
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    }));
    const mockState = makeActiveV2State([], [], {
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime,
      lastSyncTime: 0,
    });
    executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: localEntries,
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          localEntries.find((entry) => entry.path === path) ?? null),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.uploaded).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(mockState.recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(mockState.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(mockState.mutationLedger).toEqual([
      expect.objectContaining({ receipt: expect.objectContaining({ operationId: expect.any(String) }) }),
    ]);
    expect(mockState.baseSnapshot).toEqual([]);
    expect(mockState.remoteSnapshot).toEqual([]);
    expect(mockState.reconcilePendingIssues).not.toHaveBeenCalled();
    expect(setLastSyncTime).not.toHaveBeenCalled();
  });

  it("keeps a receipt when a local download succeeds but its checkpoint save fails", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const commitMutationCheckpoint = vi.fn().mockRejectedValue(new Error("checkpoint save failed"));
    const remote: RemoteFileEntry = {
      path: "downloaded.bin",
      driveId: "remote-download",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-download",
      cTag: "ctag-download",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([remote], [], {
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    state.recordMutationReceipt = recordMutationReceipt;
    state.commitMutationCheckpoint = commitMutationCheckpoint;
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile: vi.fn().mockResolvedValue(content) }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary, stat: vi.fn().mockResolvedValue({ size: 3, mtime: 2 }) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(writeBinary).toHaveBeenCalledWith(remote.path, content);
    expect(recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    expect(state.upsertBaseEntries).not.toHaveBeenCalled();
    expect(result.errors).toBe(1);
  });

  it("keeps the completed item checkpoint when cancellation happens after its completion callback", async () => {
    let executor: SyncExecutor;
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const local: LocalFileEntry = {
      path: "checkpoint.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State([], [], {
      reconcilePendingIssues,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime,
    });
    executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile: vi.fn().mockResolvedValue({
          id: "uploaded-id",
          name: local.path,
          size: local.size,
          eTag: "uploaded-etag",
          cTag: "uploaded-ctag",
          lastModifiedDateTime: "2026-07-10T00:00:00.000Z",
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {
      onFileComplete: () => executor.cancel(),
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.cancelled");
    expect(mockState.mutationLedger).toEqual([]);
    expect(mockState.baseSnapshot).toEqual([
      expect.objectContaining({ path: local.path, hash: local.hash }),
    ]);
    expect(mockState.remoteSnapshot).toEqual([
      expect.objectContaining({ path: local.path, driveId: "uploaded-id" }),
    ]);
    expect(reconcilePendingIssues).not.toHaveBeenCalled();
    expect(setLastSyncTime).not.toHaveBeenCalled();
  });

  it("defers upload hash drift without creating a manual issue", async () => {
    const original = new TextEncoder().encode("same").buffer;
    const changed = new TextEncoder().encode("changed").buffer;
    const originalHash = await sha256Hex(original);
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn();
    const local: LocalFileEntry = {
      path: "note.md",
      size: original.byteLength,
      mtime: 1,
      hash: originalHash,
      binary: false,
    };
    const mockState = makeActiveV2State([], [], {
      reconcilePendingIssues,
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(changed) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    expect(result.message).toBe("result.deferred");
    expect(reconcilePendingIssues).toHaveBeenCalledWith([], expect.any(Set));
    expect(mockState.setLastSyncTime).not.toHaveBeenCalled();
  });

  it("records download write failures as pending issues instead of dropping them", async () => {
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const remote: RemoteFileEntry = {
      path: "broken.bin",
      driveId: "broken-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 4,
      mtime: 1,
      eTag: "broken-etag",
      cTag: "broken-ctag",
      sha256Hash: await sha256Hex(
        new TextEncoder().encode("data").buffer,
      ),
    };
    const state = makeActiveV2State([remote], [], {
      reconcilePendingIssues,
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(new TextEncoder().encode("data").buffer),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockRejectedValue(new Error("missing")),
            writeBinary: vi.fn().mockRejectedValue(new Error("disk full")),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        inspectFile: vi.fn().mockResolvedValue({
          status: "missing",
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(1);
    expect(result.metrics?.fileTransfers.download).toMatchObject({
      started: 1,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      skipped: 0,
      logicalBytes: 0,
      peakConcurrency: 1,
    });
    expect(reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({ path: "broken.bin", actionType: SyncActionType.Download })],
      expect.any(Set),
    );
  });
});

describe("S1a — sync run phase observability", () => {
  it("emits one structured phase summary for a completed production run", async () => {
    const diagLog = vi.fn();
    const diag = {
      log: diagLog,
      warn: vi.fn(),
      error: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
    } as unknown as DiagnosticLogger;
    const beginRunMetrics = vi.fn();
    const finishRunMetrics = vi.fn().mockReturnValue({
      schemaVersion: 1,
      totals: {
        attempts: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        elapsedMs: 4,
        effectiveBytes: 0,
        retriedBytes: 0,
        peakConcurrency: 1,
      },
      endpoints: {
        delta: {
          attempts: 1,
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          elapsedMs: 4,
          effectiveBytes: 0,
          retriedBytes: 0,
          peakConcurrency: 1,
          statusCategories: { success: 1 },
        },
      },
    });
    const state = makeActiveV2State([], [], {
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingIssues: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
    });
    const setRemoteState = state.setRemoteState as ReturnType<typeof vi.fn>;
    const adapter = makeMockAdapter();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        beginRunMetrics,
        finishRunMetrics,
        getDelta: vi.fn().mockResolvedValue({
          value: [],
          "@odata.deltaLink": "delta-token-next",
        }),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      diag,
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(setRemoteState).toHaveBeenCalledTimes(1);
    expect(beginRunMetrics).toHaveBeenCalledTimes(1);
    expect(finishRunMetrics).toHaveBeenCalledTimes(1);
    expect(diagLog).toHaveBeenCalledWith(
      "onedrive",
      "sync network summary",
      expect.objectContaining({
        schemaVersion: 1,
        totals: expect.objectContaining({ attempts: 1, peakConcurrency: 1 }),
      }),
      { urgent: true },
    );
    expect(diagLog).toHaveBeenCalledWith(
      "execute",
      "sync file transfer summary",
      expect.objectContaining({
        schemaVersion: 3,
        platform: expect.stringMatching(/^(desktop|mobile)$/),
        upload: expect.objectContaining({
          stagesMs: expect.objectContaining({
            sourceRead: expect.any(Number),
            contentTransfer: expect.any(Number),
            contentHash: expect.any(Number),
          }),
        }),
        download: expect.objectContaining({
          stagesMs: expect.objectContaining({
            contentTransfer: expect.any(Number),
            contentHash: expect.any(Number),
            remoteVersionVerify: expect.any(Number),
            localVersionGuard: expect.any(Number),
            localCommit: expect.any(Number),
          }),
        }),
        mutationPersistence: expect.objectContaining({
          intentWrites: expect.any(Number),
          receiptWrites: expect.any(Number),
          checkpointOperations: expect.any(Number),
          checkpointCommits: expect.any(Number),
          checkpointFailures: expect.any(Number),
          stagesMs: expect.objectContaining({
            intentPersist: expect.any(Number),
            receiptPersist: expect.any(Number),
            checkpointV2Commit: expect.any(Number),
            checkpointLedgerClear: expect.any(Number),
            checkpointTotal: expect.any(Number),
          }),
        }),
      }),
      { urgent: true },
    );
    const summaryCall = diagLog.mock.calls.find(
      ([category, message]) => category === "lifecycle" && message === "sync run phase summary",
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[2]).toMatchObject({
      schemaVersion: 2,
      platform: expect.stringMatching(/^(desktop|mobile)$/),
      mode: "manual",
      status: "success",
      readOnlyPreview: false,
      counts: {
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      },
      phasesMs: {
        recovery: expect.any(Number),
        scan: expect.any(Number),
        remotePrepare: expect.any(Number),
        baseline: expect.any(Number),
        remoteChanges: expect.any(Number),
        planning: expect.any(Number),
        reviewWait: expect.any(Number),
        transfer: expect.any(Number),
        commit: expect.any(Number),
      },
      totalMs: expect.any(Number),
    });
    for (const value of Object.values(summaryCall?.[2].phasesMs ?? {})) {
      expect(value).toBeGreaterThanOrEqual(0);
    }

    diagLog.mockClear();
    const publishPreview = vi.fn().mockResolvedValue(true);
    const previewResult = await executor.run(
      "manual",
      { onFirstSyncPreview: publishPreview },
      false,
      undefined,
      { readOnlyPreview: true },
    );

    expect(previewResult.success).toBe(false);
    expect(publishPreview).toHaveBeenCalledTimes(1);
    const previewSummary = diagLog.mock.calls.find(
      ([category, message]) => category === "lifecycle" && message === "sync run phase summary",
    );
    expect(previewSummary?.[2]).toMatchObject({
      schemaVersion: 2,
      platform: expect.stringMatching(/^(desktop|mobile)$/),
      mode: "manual",
      status: "stopped",
      readOnlyPreview: true,
      phasesMs: {
        reviewWait: expect.any(Number),
        transfer: 0,
        commit: 0,
      },
    });
  });

  it("keeps a platform-neutral 500-file zero-change production run to one scan and one delta call", async () => {
      const entries: LocalFileEntry[] = Array.from({ length: 500 }, (_, index) => ({
        path: `note-${index.toString().padStart(3, "0")}.md`,
        size: 128,
        mtime: 1,
        hash: "aa".repeat(32),
        binary: false,
      }));
      const remoteEntries: RemoteFileEntry[] = entries.map((entry, index) => ({
        path: entry.path,
        driveId: `remote-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: entry.size,
        mtime: entry.mtime,
        eTag: `etag-${index}`,
        cTag: `ctag-${index}`,
        sha256Hash: entry.hash,
      }));
      const baseEntries: BaseFileEntry[] = entries.map((entry, index) => ({
        path: entry.path,
        size: entry.size,
        hash: entry.hash,
        eTag: `etag-${index}`,
      }));
      const scanAll = vi.fn().mockResolvedValue({
        entries,
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      });
      const getDelta = vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "delta-token-next",
      });
      const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
      const diagnosticsEnabled = { value: false };
      const diag = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        isEnabled: vi.fn(() => diagnosticsEnabled.value),
      } as unknown as DiagnosticLogger;
      const beginRunMetrics = vi.fn();
      const finishRunMetrics = vi.fn().mockReturnValue(null);
      const restoreVaultScope = vi.fn().mockReturnValue(true);
      const initVaultScope = vi.fn().mockResolvedValue({
        driveId: TEST_SYNC_SCOPE.driveId,
        vaultFolderId: TEST_SYNC_SCOPE.vaultFolderId,
        filesRootId: TEST_SYNC_SCOPE.filesRootId,
      });
      const state = makeActiveV2State(remoteEntries, baseEntries, {
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingIssues: vi.fn().mockResolvedValue(undefined),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime,
        incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
      });
      const setRemoteState = state.setRemoteState as ReturnType<typeof vi.fn>;
      const executor = new SyncExecutor(
        makeMockOneDrive({
          getDelta,
          beginRunMetrics,
          finishRunMetrics,
          restoreVaultScope,
          initVaultScope,
        }),
        {
          vault: {
            adapter: makeMockAdapter(),
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll,
          getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
        } as unknown as LocalScanner,
        state,
        "testVault",
        undefined,
        undefined,
        diag,
      );
      // 判定用「最快一轮」而不是中位数：机器忙（整仓并行跑）只会让某一轮**变慢**、
      // 不会让它变快，取最小值天然抗负载；中位数照旧打印，供发布时人工比对趋势。
      const ROUNDS_PER_MODE = 9;
      const withoutDiagnosticsMs: number[] = [];
      const withDiagnosticsMs: number[] = [];

      for (let round = 0; round < ROUNDS_PER_MODE; round++) {
        const startedAt = performance.now();
        const result = await executor.run("manual", {});
        withoutDiagnosticsMs.push(performance.now() - startedAt);
        expect(result.success).toBe(true);
      }
      diagnosticsEnabled.value = true;
      for (let round = 0; round < ROUNDS_PER_MODE; round++) {
        const startedAt = performance.now();
        const result = await executor.run("manual", {});
        withDiagnosticsMs.push(performance.now() - startedAt);
        expect(result.success).toBe(true);
      }

      const totalRuns = ROUNDS_PER_MODE * 2;
      expect(scanAll).toHaveBeenCalledTimes(totalRuns);
      expect(getDelta).toHaveBeenCalledTimes(totalRuns);
      expect(restoreVaultScope).toHaveBeenCalledTimes(totalRuns);
      expect(initVaultScope).not.toHaveBeenCalled();
      expect(setRemoteState).toHaveBeenCalledTimes(totalRuns);
      expect(setLastSyncTime).toHaveBeenCalledTimes(totalRuns);
      expect(beginRunMetrics).toHaveBeenCalledTimes(ROUNDS_PER_MODE);
      expect(finishRunMetrics).toHaveBeenCalledTimes(ROUNDS_PER_MODE);
      const medianIndex = Math.floor(ROUNDS_PER_MODE / 2);
      const fastestWithoutDiagnostics = Math.min(...withoutDiagnosticsMs);
      const fastestWithDiagnostics = Math.min(...withDiagnosticsMs);
      const medianWithoutDiagnostics = [...withoutDiagnosticsMs].sort((a, b) => a - b)[medianIndex];
      const medianWithDiagnostics = [...withDiagnosticsMs].sort((a, b) => a - b)[medianIndex];
      const allowedProbeOverheadMs = Math.max(fastestWithoutDiagnostics * 0.05, 10);
      // 反向变异证据（给诊断路径注入真实开销时本条必须变红）见本轮收口日志。
      expect(fastestWithDiagnostics - fastestWithoutDiagnostics).toBeLessThanOrEqual(allowedProbeOverheadMs);
      console.info("[a0p-production-entry]", JSON.stringify({
        schemaVersion: 1,
        mode: "platform-neutral",
        files: entries.length,
        roundsPerMode: ROUNDS_PER_MODE,
        diagnosticsOffFastestMs: Number(fastestWithoutDiagnostics.toFixed(3)),
        diagnosticsOnFastestMs: Number(fastestWithDiagnostics.toFixed(3)),
        diagnosticsOverheadFastestMs: Number((fastestWithDiagnostics - fastestWithoutDiagnostics).toFixed(3)),
        diagnosticsOffMedianMs: Number(medianWithoutDiagnostics.toFixed(3)),
        diagnosticsOnMedianMs: Number(medianWithDiagnostics.toFixed(3)),
        diagnosticsOverheadMs: Number((medianWithDiagnostics - medianWithoutDiagnostics).toFixed(3)),
        allowedProbeOverheadMs: Number(allowedProbeOverheadMs.toFixed(3)),
        operations: {
          fullScansPerRun: scanAll.mock.calls.length / totalRuns,
          deltaCallsPerRun: getDelta.mock.calls.length / totalRuns,
          remoteStateCommitsPerRun: setRemoteState.mock.calls.length / totalRuns,
          healthTimeCommitsPerRun: setLastSyncTime.mock.calls.length / totalRuns,
        },
      }));
  });
});

describe("size exclusion baseline — skip rows are incremental", () => {
  const makeSkippingScannerStub = () =>
    ({
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: vi.fn().mockResolvedValue(null),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      getMaxFileSize: vi.fn().mockReturnValue(200 * 1024 * 1024),
    }) as unknown as LocalScanner;

  it("shows a skip row once, then stays quiet while the file stays excluded", async () => {
    // 2026-09-16 拍板：稳定被排除文件不再每轮逐行重演——结算时基准成员
    // 不发行行；轮末把本轮结算全集整体覆写进基准（镜像语义）。
    const oversized: RemoteFileEntry = {
      path: "video.mp4",
      driveId: "item-video",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 300 * 1024 * 1024,
      mtime: 1,
      eTag: "etag-video",
      cTag: "ctag-video",
    };
    const mockState = makeActiveV2State([oversized], []);
    const skipRows: string[] = [];
    const executor = new SyncExecutor(
      makeMockOneDrive({}),
      makeSkippingScannerStub(),
      mockState,
      "testVault",
    );

    const first = await executor.run("manual", {
      onFileComplete: (path, actionType) => {
        if (
          actionType === SyncActionType.SkipLargeFile
          && path === "video.mp4"
        ) skipRows.push(path);
      },
    });

    expect(skipRows).toEqual(["video.mp4"]);
    expect(first.skippedLarge).toBe(1);
    expect(await mockState.getSizeExclusionBaseline()).toEqual(["video.mp4"]);

    const second = await executor.run("manual", {
      onFileComplete: (path, actionType) => {
        if (
          actionType === SyncActionType.SkipLargeFile
          && path === "video.mp4"
        ) skipRows.push(path);
      },
    });

    expect(skipRows).toEqual(["video.mp4"]);
    expect(second.skippedLarge).toBe(1);
    expect(await mockState.getSizeExclusionBaseline()).toEqual(["video.mp4"]);
  });

  it("falls back to full visibility when one round exceeds the baseline capacity", async () => {
    // 容量护栏：单轮 SkipLargeFile 项超过上限 → 该轮回退现役全量展示且
    // 不覆写基准（可见性不丢，基准不截断）。
    const many: RemoteFileEntry[] = Array.from({ length: 2001 }, (_, i) => ({
      path: `video-${i}.mp4`,
      driveId: `item-video-${i}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 300 * 1024 * 1024,
      mtime: 1,
      eTag: `etag-${i}`,
      cTag: `ctag-${i}`,
    }));
    const mockState = makeActiveV2State(many, []);
    const skipRows: string[] = [];
    const executor = new SyncExecutor(
      makeMockOneDrive({}),
      makeSkippingScannerStub(),
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {
      onFileComplete: (path, actionType) => {
        if (actionType === SyncActionType.SkipLargeFile) skipRows.push(path);
      },
    });

    expect(result.skippedLarge).toBe(2001);
    expect(skipRows).toHaveLength(2001);
    expect(await mockState.getSizeExclusionBaseline()).toEqual([]);
  });
});

describe("reviewed decisions rebuilt from current local facts (P3)", () => {
  const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
  const base: BaseFileEntry = {
    path: "note.md",
    size: 4,
    hash: "bb".repeat(32),
    eTag: "etag-base",
  };
  const local: LocalFileEntry = {
    path: "note.md",
    size: 5,
    mtime: 2,
    hash: "aa".repeat(32),
    binary: false,
  };
  const remote: RemoteFileEntry = {
    path: "note.md",
    driveId: "remote-note",
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: 6,
    mtime: 3,
    eTag: "etag-remote",
    cTag: "ctag-remote",
    sha256Hash: "cc".repeat(32),
  };
  const changedLocal: LocalFileEntry = {
    path: "note.md",
    size: 9,
    mtime: 9,
    hash: "dd".repeat(32),
    binary: false,
  };
  const conflictToken = {
    version: 1 as const,
    vaultName: "testVault",
    accountId: "account-id",
    scope,
    local: { exists: true, hash: local.hash, size: local.size },
    remote: { exists: true, driveId: remote.driveId, eTag: remote.eTag },
    ancestorHash: base.hash,
  };
  const conflictItem = {
    type: SyncActionType.Conflict,
    path: "note.md",
    local,
    remote,
    reason: "reason.bothSidesModified",
    decisionToken: conflictToken,
  } as unknown as SyncPlanItem;
  const deleteToken = {
    version: 1 as const,
    vaultName: "testVault",
    accountId: "account-id",
    scope,
    local: { exists: true, hash: local.hash, size: local.size },
    remote: { exists: false },
    ancestorHash: base.hash,
  };
  const remoteDeleteItem = {
    type: SyncActionType.ConfirmLocalDelete,
    path: "note.md",
    local,
    remote: undefined,
    reason: "reason.fileDeletedFromRemote",
    decisionToken: deleteToken,
  } as unknown as SyncPlanItem;

  function makeReviewScanner(inspection: unknown): LocalScanner {
    return {
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      shouldSyncPath: vi.fn().mockReturnValue(true),
      inspectFile: vi.fn().mockResolvedValue(inspection),
    } as unknown as LocalScanner;
  }

  it("rebuilds a conflict row as delete/modify when the local file is gone", async () => {
    const state = makeActiveV2State([remote], [base], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [conflictItem],
    });
    const uploadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      makeReviewScanner({ status: "missing" }),
      state,
      "testVault",
    );

    await executor.resolveConflictKeepLocal("note.md");

    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.addPendingConflict).toHaveBeenCalledTimes(1);
    expect(state.addPendingConflict.mock.calls[0][0]).toMatchObject({
      type: SyncActionType.Conflict,
      path: "note.md",
      local: undefined,
      remote: expect.objectContaining({ driveId: remote.driveId }),
      reason: "reason.localDeletedRemoteModified",
      decisionToken: expect.objectContaining({
        local: { exists: false },
        remote: { exists: true, driveId: remote.driveId, eTag: remote.eTag },
      }),
    });
  });

  it("rebuilds a conflict row with the current local version when it changed", async () => {
    const state = makeActiveV2State([remote], [base], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [conflictItem],
    });
    const uploadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      makeReviewScanner({ status: "present", entry: changedLocal }),
      state,
      "testVault",
    );

    await executor.resolveConflictKeepLocal("note.md");

    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.addPendingConflict).toHaveBeenCalledTimes(1);
    expect(state.addPendingConflict.mock.calls[0][0]).toMatchObject({
      type: SyncActionType.Conflict,
      path: "note.md",
      local: expect.objectContaining({ hash: changedLocal.hash }),
      remote: expect.objectContaining({ driveId: remote.driveId }),
      reason: "reason.bothSidesModified",
      decisionToken: expect.objectContaining({
        local: { exists: true, hash: changedLocal.hash, size: changedLocal.size },
      }),
    });
  });

  it("keeps the plain block on an uncertain local read without rebuilding", async () => {
    const state = makeActiveV2State([remote], [base], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [conflictItem],
    });
    const uploadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      makeReviewScanner({ status: "uncertain", reason: "stat" }),
      state,
      "testVault",
    );

    await executor.resolveConflictKeepLocal("note.md");

    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.addPendingConflict).not.toHaveBeenCalled();
    expect(state.pendingConflicts).toHaveLength(1);
  });

  it("retires a pending remote delete outright when the local file is gone", async () => {
    const state = makeActiveV2State([remote], [base], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      pendingRemoteDeletes: [remoteDeleteItem],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({}),
      makeReviewScanner({ status: "missing" }),
      state,
      "testVault",
    );

    await executor.confirmRemoteDelete("note.md");

    expect(state.removePendingDelete).toHaveBeenCalledWith("note.md");
    expect(state.addPendingConflict).not.toHaveBeenCalled();
  });

  it("turns a changed local file into a delete/modify conflict instead of deleting it", async () => {
    const state = makeActiveV2State([remote], [base], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      pendingRemoteDeletes: [remoteDeleteItem],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({}),
      makeReviewScanner({ status: "present", entry: changedLocal }),
      state,
      "testVault",
    );

    await executor.confirmRemoteDelete("note.md");

    expect(state.addPendingConflict).toHaveBeenCalledTimes(1);
    expect(state.addPendingConflict.mock.calls[0][0]).toMatchObject({
      type: SyncActionType.Conflict,
      path: "note.md",
      local: expect.objectContaining({ hash: changedLocal.hash }),
      remote: undefined,
      reason: "reason.remoteDeletedLocalModified",
    });
    expect(state.removePendingDelete).toHaveBeenCalledWith("note.md");
  });
});

/**
 * 片① 出站抑制（仅接收／单向同步）——真实执行器轮次证据。
 *
 * 计划层断言在 `tests/one-way-mode-plan.test.ts`；这里用现役状态夹具观测：
 * ①被拦掉的动作不写基线（无基线本机独有文件连续两轮无 Upload、无待确认删除、
 * 该路径基线保持为空），②方向=单向下用户主动动作（冲突行「保留本机」的上传链）
 * 与双向行为一致。
 */
