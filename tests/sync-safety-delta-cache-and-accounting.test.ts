// 增量缓存、运行记账与可重试事实
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。 本文件保留同名容器 describe，用例全名与拆分前一致。

import {
  readFileSync,
} from "node:fs";
import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import * as obsidian from "obsidian";
import {
  Platform,
} from "obsidian";
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

describe("Persistent remote delta state", () => {
  it("marks healthy sync when the only skips are the user's own size exclusions", async () => {
    // 2026-09-19 field report (iOS, 1.4.12): a vault whose large-file setting
    // excluded 4 files completed every round, yet lastSyncTime stayed zero, so
    // the header kept reading "尚未同步". Settings-driven skips are expected
    // zero-action outcomes (2026-09-16 拍板) and must not block the healthy
    // sync mark.
    const state = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({}),
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
          skippedLarge: ["🔗Attachments/IMG_0632.mov"],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.skippedLarge).toBe(1);
    // W3 2026-10-24: healthy round-end mark is one combined commit.
    expect(state.setLastSyncTimeAndIncrementGeneration).toHaveBeenCalledTimes(1);
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(state.incrementRemoteGeneration).not.toHaveBeenCalled();
  });

  it("settles a proven not-applied download failure in the same sync round", async () => {
    const previousMobile = Platform.isMobile;
    const remote: RemoteFileEntry = {
      path: "offline-download.bin",
      driveId: "remote-offline-download",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 2,
      eTag: "etag-offline-download",
      cTag: "ctag-offline-download",
      sha256Hash: "aa".repeat(32),
    };
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State([remote], [], {
      reconcilePendingIssues,
    });
    const downloadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-offline-download",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
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
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        getMaxFileSize: vi.fn().mockReturnValue(100 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    let result;
    try {
      Platform.isMobile = true;
      result = await executor.run("manual", {});
    } finally {
      Platform.isMobile = previousMobile;
    }

    expect(downloadFile).toHaveBeenCalledOnce();
    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.partial");
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(remote);
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: remote.path,
        actionType: SyncActionType.Download,
        reason: "syncView.failure.network",
        remoteETag: remote.eTag,
      })],
      new Set(),
    );
  });

  it("checkpoints a verifiably applied upload in the same round after its response is lost", async () => {
    const content = new Uint8Array([9, 8, 7]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: "response-lost.md",
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-response-lost",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: "etag-response-lost",
      cTag: "ctag-response-lost",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "response lost"),
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-upload-response-lost",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(1);
    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: remote.sha256Hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("recovers an applied overwrite after its PUT response is lost when Graph omits SHA-256", async () => {
    const previousContent = new Uint8Array([1, 2, 3]).buffer;
    const content = new Uint8Array([9, 8, 7]).buffer;
    const previousHash = await sha256Hex(previousContent);
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: "response-lost-overwrite-no-sha.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remoteBeforeUpload: RemoteFileEntry = {
      path: local.path,
      driveId: "existing-response-lost-item",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: previousContent.byteLength,
      mtime: 1,
      eTag: "etag-before-overwrite",
      cTag: "ctag-before-overwrite",
    };
    const remoteAfterUpload: RemoteFileEntry = {
      ...remoteBeforeUpload,
      size: local.size,
      mtime: 3,
      eTag: "etag-after-overwrite",
      cTag: "ctag-after-overwrite",
      downloadUrl: "https://download.example/response-lost-overwrite-no-sha.md",
    };
    const state = makeActiveV2State(
      [remoteBeforeUpload],
      [{
        path: local.path,
        hash: previousHash,
        size: previousContent.byteLength,
        eTag: remoteBeforeUpload.eTag,
      }],
    );
    let expectedRemoteDuringPut: unknown;
    const uploadFile = vi.fn().mockImplementation(async () => {
      expectedRemoteDuringPut = (
        state.mutationLedger[0] as unknown as {
          intent: { expectedRemote: unknown };
        }
      ).intent.expectedRemote;
      throw new OneDriveError(OneDriveErrorType.NetworkError, "PUT response lost");
    });
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getFileMetadata = vi.fn().mockResolvedValue(remoteAfterUpload);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-overwrite-response-lost",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        downloadFile,
        getFileMetadata,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      expect.any(ArrayBuffer),
      expect.anything(),
      remoteBeforeUpload.eTag,
      remoteBeforeUpload.driveId,
    );
    expect(expectedRemoteDuringPut).toEqual({
      exists: true,
      driveId: remoteBeforeUpload.driveId,
      eTag: remoteBeforeUpload.eTag,
      size: remoteBeforeUpload.size,
      sha256Hash: undefined,
    });
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      remoteAfterUpload.downloadUrl,
      remoteAfterUpload.driveId,
      remoteAfterUpload.size,
    );
    expect(getFileMetadata.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 1,
    });
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([{
      path: local.path,
      hash,
      size: local.size,
      eTag: remoteAfterUpload.eTag,
    }]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: remoteAfterUpload.driveId,
        parentId: remoteAfterUpload.parentId,
        size: remoteAfterUpload.size,
        eTag: remoteAfterUpload.eTag,
        cTag: remoteAfterUpload.cTag,
      }),
    ]);
  });

  it("retains an upload intent when the response is lost and remote facts are ambiguous", async () => {
    const content = new Uint8Array([9, 8, 7]).buffer;
    const local: LocalFileEntry = {
      path: "ambiguous-response.md",
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const unrelatedRemote: RemoteFileEntry = {
      path: local.path,
      driveId: "ambiguous-remote-object",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 4,
      mtime: 2,
      eTag: "etag-ambiguous",
      cTag: "ctag-ambiguous",
      sha256Hash: "bb".repeat(32),
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "response lost"),
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-upload-ambiguous",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(unrelatedRemote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.syncFailed");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].intent.path).toBe(local.path);
    expect(state.mutationLedger[0].intent.scope).toEqual({
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    });
    expect(state.mutationLedger[0].receipt).toBeNull();
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
  });

  it("returns a retryable recovery fact when a lost upload response cannot be observed in the same round", async () => {
    const content = new Uint8Array([9, 8, 7]).buffer;
    const local: LocalFileEntry = {
      path: "response-lost-observation-offline.md",
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.NetworkError,
        "upload response lost",
      ),
    );
    const getFileMetadata = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.RateLimited,
        "recovery observation unavailable",
        429,
        19,
      ),
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata,
        getDelta: vi.fn().mockResolvedValue({
          value: [],
          "@odata.deltaLink": "https://graph.example/delta-upload-offline",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content),
          }),
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
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.mutationRecovery).toEqual({
      state: "network-unavailable",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: 19,
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(getFileMetadata).toHaveBeenCalledOnce();
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeNull();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });

  it("keeps syncing unrelated files while a retryable recovery stays protected", async () => {
    const stuckBytes = new TextEncoder().encode("stuck note").buffer;
    const stuckHash = await sha256Hex(stuckBytes);
    const unrelatedBytes = new TextEncoder().encode("new note").buffer;
    const unrelatedHash = await sha256Hex(unrelatedBytes);
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const stuckLocal: LocalFileEntry = {
      path: "stuck-upload.md",
      hash: stuckHash,
      size: stuckBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const unrelated: LocalFileEntry = {
      path: "other.md",
      hash: unrelatedHash,
      size: unrelatedBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1 as const,
          operationId: "op-stuck-upload",
          planRevision: 1,
          scope: activeScope,
          action: "upload" as const,
          path: stuckLocal.path,
          expectedLocal: {
            exists: true as const,
            hash: stuckHash,
            size: stuckBytes.byteLength,
          },
          expectedRemote: { exists: false as const },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn().mockImplementation(async (
      _vaultName: string,
      path: string,
    ) => {
      if (path === stuckLocal.path) {
        throw new OneDriveError(
          OneDriveErrorType.NetworkError,
          "upload response lost",
        );
      }
      return {
        id: "unrelated-id",
        eTag: "unrelated-etag",
        parentReference: { id: activeScope.filesRootId },
      };
    });
    const getFileMetadata = vi.fn().mockRejectedValue(new OneDriveError(
      OneDriveErrorType.RateLimited,
      "recovery observation unavailable",
      429,
      7,
    ));
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-protected-continue",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, getFileMetadata, getDelta }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockImplementation(async (path: string) =>
              path === unrelated.path ? unrelatedBytes : stuckBytes),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [stuckLocal, unrelated],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: stuckLocal,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    // The retryable recovery must not freeze the Vault: the unrelated file
    // still uploads while the unresolved record keeps owning its path.
    expect(result.success).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(1);
    expect(result.mutationRecovery).toMatchObject({
      state: "network-unavailable",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: 7,
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.mock.calls[0]?.[1]).toBe(unrelated.path);
    expect(state.mutationLedger.map(
      (record) => record.intent.operationId,
    )).toEqual(["op-stuck-upload"]);
    expect(state.mutationLedger[0].receipt).toBeNull();
  });

  it("defers plan items intersecting protected recovery instead of failing the run", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const protectedRecord: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-protected",
        planRevision: 1,
        scope: activeScope,
        action: "upload",
        path: "frozen/note.md",
        expectedLocal: {
          exists: true,
          hash: "aa".repeat(32),
          size: 3,
        },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: null,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [protectedRecord],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive(),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const warn = vi.fn();
    (executor as unknown as { diag: { warn: typeof warn } }).diag = { warn };
    const plan: SyncPlan = {
      items: [
        {
          type: SyncActionType.Upload,
          path: "frozen/note.md",
          local: {
            path: "frozen/note.md",
            hash: "aa".repeat(32),
            size: 3,
            mtime: 1,
            binary: false,
          },
        },
        {
          type: SyncActionType.RenameRemote,
          path: "elsewhere/note.md",
          renameFrom: "frozen/note.md",
          local: {
            path: "elsewhere/note.md",
            hash: "aa".repeat(32),
            size: 3,
            mtime: 1,
            binary: false,
          },
        },
        {
          type: SyncActionType.Upload,
          path: "other.md",
          local: {
            path: "other.md",
            hash: "bb".repeat(32),
            size: 3,
            mtime: 1,
            binary: false,
          },
        },
      ],
      lastTotalFiles: 0,
      confirmed: false,
      scope: activeScope,
    };
    const result: SyncResult = {
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
        ordinaryPlanning: "entered",
        userFileChanges: "unknown",
      },
    };

    (executor as unknown as {
      deferPlanItemsIntersectingRecovery(
        plan: SyncPlan,
        result: SyncResult,
        records: readonly Readonly<MutationLedgerEntryV1>[],
      ): void;
    }).deferPlanItemsIntersectingRecovery(plan, result, [protectedRecord]);

    expect(plan.items.map((item) => item.path)).toEqual(["other.md"]);
    expect(result.deferred).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "plan",
      "plan items deferred by protected mutation recovery",
      expect.objectContaining({
        deferred: 2,
        remainingPlanItems: 1,
        protectedRecords: 1,
      }),
    );
  });

  it("recovers an applied unreceipted download without downloading the file again", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "downloaded.md",
      hash,
      size: content.byteLength,
      mtime: 4,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-download",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-download",
      cTag: "ctag-download",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-download-receipt-lost",
          planRevision: 1,
          scope: activeScope,
          action: "download",
          path: local.path,
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: remote.driveId,
            eTag: remote.eTag,
            size: remote.size,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const downloadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-download-recovered",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: remote.sha256Hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("recovers an unreceipted download by stable readback when Graph omits SHA-256", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "downloaded-without-graph-hash.md",
      hash,
      size: content.byteLength,
      mtime: 4,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-download-no-hash",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-download-no-hash",
      cTag: "ctag-download-no-hash",
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-download-receipt-lost-no-graph-hash",
          planRevision: 1,
          scope: activeScope,
          action: "download",
          path: local.path,
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: remote.driveId,
            eTag: remote.eTag,
            size: remote.size,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockResolvedValue(remote);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
        file: { hashes: {} },
      })],
      "@odata.deltaLink": "https://graph.example/delta-download-readback",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
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
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(getFileMetadata).toHaveBeenCalledTimes(3);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("finishes a verified receipt checkpoint before generating a new plan", async () => {
    const hash = "aa".repeat(32);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const remote = {
      path: "note.md",
      driveId: "item-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "",
      sha256Hash: hash,
    };
    const base = { path: "note.md", hash, size: 3, eTag: "etag-note" };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-receipted",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: "note.md",
          expectedLocal: { exists: true, hash, size: 3 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-receipted",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [base],
            baseRemovals: [],
            remoteUpserts: [remote],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const local: LocalFileEntry = { path: "note.md", hash, size: 3, mtime: 1, binary: false };
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem("note.md", hash, {
        id: remote.driveId,
        eTag: remote.eTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([base]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      eTag: remote.eTag,
      sha256Hash: remote.sha256Hash,
    }));
  });

  it("rebinds an upload receipt after the remote folder identity is replaced", async () => {
    const hash = "ab".repeat(32);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const folder: RemoteFolderEntry = {
      path: "plugins",
      driveId: "plugins-folder-current",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      name: "plugins",
    };
    const remote: RemoteFileEntry = {
      path: "plugins/note.md",
      driveId: "item-note-current",
      parentId: folder.driveId,
      size: 3,
      mtime: 1,
      eTag: "etag-note-current",
      cTag: "ctag-note-current",
      sha256Hash: hash,
    };
    const staleReceiptRemote = { ...remote, parentId: "plugins-folder-old" };
    const base = {
      path: remote.path,
      hash,
      size: remote.size,
      eTag: remote.eTag,
    };
    const state = makeActiveV2State([remote], [], {
      remoteFolders: [folder],
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-replaced-parent",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: remote.path,
          expectedLocal: { exists: true, hash, size: remote.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-replaced-parent",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [base],
            baseRemovals: [],
            remoteUpserts: [staleReceiptRemote],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        graphFolder(folder.driveId, folder.name, folder.parentId),
        driveItem(remote.path, hash, {
          id: remote.driveId,
          eTag: remote.eTag,
          cTag: remote.cTag,
          parentReference: { id: folder.driveId },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const getFileMetadata = vi.fn().mockResolvedValue(remote);
    const local: LocalFileEntry = {
      path: remote.path,
      hash,
      size: remote.size,
      mtime: 1,
      binary: false,
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: folder.path }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: folder.driveId,
      eTag: remote.eTag,
    }));
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op-replaced-parent",
      checkpoint: expect.objectContaining({
        remoteUpserts: [expect.objectContaining({
          path: remote.path,
          parentId: folder.driveId,
        })],
      }),
    }));
  });

  it("recovers a deferred upload batch whose receipt parent drifted from the committed index", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const folder: RemoteFolderEntry = {
      path: "plugins",
      driveId: "plugins-folder-old",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      name: "plugins",
    };
    const local: LocalFileEntry = {
      path: "plugins/note.md",
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    // Field report 2026-09-28 (case B): the upload response binds the file to
    // the live parent identity while the committed index still holds the
    // pre-reorganization folder identity. The hierarchy changes AFTER the
    // run's initial scan, so the delta phase still reports the old folder and
    // the drift only surfaces at the batch commit. That commit used to crash
    // the whole round; the recovery the single-item path owns must settle it.
    const uploadFile = vi.fn().mockResolvedValue({
      id: "item-note-current",
      name: "note.md",
      size: 3,
      eTag: "etag-note-current",
      cTag: "ctag-note-current",
      parentReference: { id: "plugins-folder-current" },
    });
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [
          graphFolder(
            "plugins-folder-old",
            folder.name,
            TEST_SYNC_SCOPE.filesRootId,
          ),
        ],
        "@odata.deltaLink": "https://graph.example/delta-initial",
      })
      .mockResolvedValueOnce({
        value: [
          graphFolder(
            "plugins-folder-current",
            folder.name,
            TEST_SYNC_SCOPE.filesRootId,
          ),
          driveItem(local.path, hash, {
            id: "item-note-current",
            eTag: "etag-note-current",
            cTag: "ctag-note-current",
            parentReference: { id: "plugins-folder-current" },
          }),
        ],
        "@odata.deltaLink": "https://graph.example/delta-refreshed",
      });
    const getFileMetadata = vi.fn().mockResolvedValue({
      path: local.path,
      driveId: "item-note-current",
      parentId: "plugins-folder-current",
      size: 3,
      mtime: 1,
      eTag: "etag-note-current",
      cTag: "ctag-note-current",
      sha256Hash: hash,
    });
    const state = makeActiveV2State([], [], {
      remoteFolders: [folder],
      folderAnchors: [{
        remoteId: folder.driveId,
        lastPath: folder.path,
        parentId: folder.parentId,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, getDelta, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: folder.path }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(1);
    expect(state.mutationLedger).toEqual([]);
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: local.path,
      driveId: "item-note-current",
      parentId: "plugins-folder-current",
      eTag: "etag-note-current",
    }));
  });

  it("keeps the round alive when a deferred upload batch still fails after the hierarchy refresh", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const folder: RemoteFolderEntry = {
      path: "plugins",
      driveId: "plugins-folder-old",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      name: "plugins",
    };
    const local: LocalFileEntry = {
      path: "plugins/note.md",
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    // Receipt and live object agree on a parent identity the refreshed
    // committed tree still cannot project at the path: nothing provable to
    // rebind onto. The rebuild+rebase+retry recovery runs (second getDelta)
    // and the batch then fails closed — the round-end shared checkpoint
    // refuses to publish net-new unresolved records anyway, so the crash
    // shape is retained; the stranded receipt settles through the next
    // round's mutation recovery.
    const uploadFile = vi.fn().mockResolvedValue({
      id: "item-note-current",
      name: "note.md",
      size: 3,
      eTag: "etag-note-current",
      cTag: "ctag-note-current",
      parentReference: { id: "plugins-folder-orphan" },
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        graphFolder(
          "plugins-folder-old",
          folder.name,
          TEST_SYNC_SCOPE.filesRootId,
        ),
      ],
      "@odata.deltaLink": "https://graph.example/delta-initial",
    });
    const getFileMetadata = vi.fn().mockResolvedValue({
      path: local.path,
      driveId: "item-note-current",
      parentId: "plugins-folder-orphan",
      size: 3,
      mtime: 1,
      eTag: "etag-note-current",
      cTag: "ctag-note-current",
      sha256Hash: hash,
    });
    const state = makeActiveV2State([], [], {
      remoteFolders: [folder],
      folderAnchors: [{
        remoteId: folder.driveId,
        lastPath: folder.path,
        parentId: folder.parentId,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, getDelta, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: folder.path }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.syncFailed");
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      blockReason: "state-unavailable",
    });
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).not.toBeNull();
  });

  it("settles a receipted upload whose parent identity drifted from the index during recovery", async () => {
    const hash = "ab".repeat(32);
    const folder: RemoteFolderEntry = {
      path: "plugins",
      driveId: "plugins-folder-old",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      name: "plugins",
    };
    const remote: RemoteFileEntry = {
      path: "plugins/note.md",
      driveId: "item-note-current",
      parentId: "plugins-folder-current",
      size: 3,
      mtime: 1,
      eTag: "etag-note-current",
      cTag: "ctag-note-current",
      sha256Hash: hash,
    };
    const base = {
      path: remote.path,
      hash,
      size: remote.size,
      eTag: remote.eTag,
    };
    const state = makeActiveV2State([], [], {
      remoteFolders: [folder],
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-drifted-parent",
          planRevision: 1,
          scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
          action: "upload",
          path: remote.path,
          expectedLocal: { exists: true, hash, size: remote.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-drifted-parent",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [base],
            baseRemovals: [],
            remoteUpserts: [remote],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        graphFolder(
          "plugins-folder-current",
          folder.name,
          TEST_SYNC_SCOPE.filesRootId,
        ),
        driveItem(remote.path, hash, {
          id: remote.driveId,
          eTag: remote.eTag,
          cTag: remote.cTag,
          parentReference: { id: "plugins-folder-current" },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-refreshed",
    });
    const getFileMetadata = vi.fn().mockResolvedValue(remote);
    const local: LocalFileEntry = {
      path: remote.path,
      hash,
      size: remote.size,
      mtime: 1,
      binary: false,
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: folder.path }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(getDelta).toHaveBeenCalled();
    expect(state.commitMutationCheckpoint).toHaveBeenCalledWith(
      "op-drifted-parent",
    );
  });

  it("recovers a cancelled post-upload receipt without uploading the file twice", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = { path: "note.md", hash, size: 3, mtime: 1, binary: false };
    const state = makeActiveV2State([], []);
    let firstExecutor: SyncExecutor;
    const uploadFile = vi.fn().mockImplementation(async () => {
      firstExecutor.cancel();
      return {
        id: "uploaded-note",
        name: "note.md",
        size: 3,
        eTag: "etag-uploaded",
        cTag: "ctag-uploaded",
      };
    });
    const scanner = {
      vault: {
        adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
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
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;
    firstExecutor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      scanner,
      state,
      "testVault",
    );

    const cancelled = await firstExecutor.run("manual", {});

    expect(cancelled.message).toBe("result.cancelled");
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).not.toBeNull();
    expect(state.mutationLedger[0].receipt?.checkpoint.remoteUpserts).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: "uploaded-note",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        eTag: "etag-uploaded",
        sha256Hash: hash,
      }),
    ]);
    expect(state.baseSnapshot).toEqual([]);

    const recoveryGetDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-after",
    });
    const recoveryClient = makeMockOneDrive({
      uploadFile,
      getFileMetadata: vi.fn().mockResolvedValue({
        path: "note.md",
        driveId: "uploaded-note",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: 3,
        mtime: 2,
        eTag: "etag-uploaded",
        sha256Hash: hash,
      }),
      getDelta: recoveryGetDelta,
    });
    const recoveryWarn = vi.fn();
    const recoveryDiagnostics = {
      isEnabled: vi.fn((category: string) => category === "state"),
      log: vi.fn(),
      warn: recoveryWarn,
      error: vi.fn(),
    } as unknown as DiagnosticLogger;
    const recoveryExecutor = new SyncExecutor(
      recoveryClient,
      scanner,
      state,
      "testVault",
      undefined,
      undefined,
      recoveryDiagnostics,
    );

    await recoveryExecutor.run("manual", {});

    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(recoveryGetDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([{
      path: "note.md",
      hash,
      size: 3,
      eTag: "etag-uploaded",
    }]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "note.md", driveId: "uploaded-note", eTag: "etag-uploaded" }),
    ]);
    expect(recoveryWarn.mock.calls).toEqual([]);
  });

  it("purges EasySync internal files from a cached remote snapshot", async () => {
    const internalPath = ".obsidian/plugins/easy-sync/data.sync-conflict-20260709.json";
    const remoteFolders: RemoteFolderEntry[] = [
      { path: ".obsidian", driveId: "obsidian-folder", parentId: TEST_SYNC_SCOPE.filesRootId, name: ".obsidian" },
      { path: ".obsidian/plugins", driveId: "plugins-folder", parentId: "obsidian-folder", name: "plugins" },
      { path: ".obsidian/plugins/easy-sync", driveId: "easy-sync-folder", parentId: "plugins-folder", name: "easy-sync" },
    ];
    const state = makeActiveV2State([{
      path: internalPath,
      driveId: "internal-id",
      parentId: "easy-sync-folder",
      size: 10,
      mtime: 1,
      eTag: "internal-etag",
      cTag: "internal-ctag",
    }], [], { remoteFolders });
    const downloadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [],
          "@odata.deltaLink": "https://graph.example/delta-2",
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
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(false),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.remoteSnapshot).toEqual([]);
  });

  it("applies the local sync scope to remote plugin files", async () => {
    const mainHash = "aa".repeat(32);
    const localMain: LocalFileEntry = {
      path: ".obsidian/plugins/example-plugin/main.js",
      hash: mainHash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([], []);
    const downloadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        graphFolder("obsidian-folder", ".obsidian", "files-root-id"),
        graphFolder("plugins-folder", "plugins", "obsidian-folder"),
        graphFolder("example-plugin-folder", "example-plugin", "plugins-folder"),
        graphFolder("runtime-folder", "runtime", "example-plugin-folder"),
        driveItem("main.js", mainHash, {
          id: "main-id",
          parentReference: {
            id: "example-plugin-folder",
            path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/.obsidian/plugins/example-plugin",
          },
        }),
        driveItem("cache.json", "bb".repeat(32), {
          id: "cache-id",
          parentReference: {
            id: "runtime-folder",
            path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/.obsidian/plugins/example-plugin/runtime",
          },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-1",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        shouldSyncPath: vi.fn((path: string) => !path.includes("/runtime/")),
        shouldSyncFolderPath: vi.fn((path: string) => !path.endsWith("/runtime")),
        scanAll: vi.fn().mockResolvedValue({
          entries: [localMain],
          folders: [
            { path: ".obsidian" },
            { path: ".obsidian/plugins" },
            { path: ".obsidian/plugins/example-plugin" },
          ],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: localMain }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    });

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual([
      ".obsidian/plugins/example-plugin/main.js",
    ]);
  });

  it("rebuilds a remote cache when its delta link belongs to another vault directory", async () => {
    const state = makeActiveV2State([{
      path: "stale.md",
      driveId: "stale-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1,
      mtime: 1,
      eTag: "stale-etag",
      cTag: "stale-ctag",
    }], []);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/legacy-delta",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        isDeltaLinkForVault: vi.fn().mockReturnValue(false),
        getDelta,
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
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(getDelta).toHaveBeenCalledWith("testVault", undefined, expect.anything());
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/legacy-delta");
  });

  it("applies additions and tombstones across consecutive V2 delta rounds", async () => {
    const hashA = "aa".repeat(32);
    const downloaded = new Uint8Array([1, 2, 3]).buffer;
    const hashB = await sha256Hex(downloaded);
    const state = makeActiveV2State([], []);
    let scanRound = 0;
    let downloadWritten = false;
    const files = new Map<string, ArrayBuffer>();
    const adapter = makeMockAdapter({
      appendBinary: undefined,
      readBinary: vi.fn().mockImplementation(async (path: string) => {
        const content = files.get(path);
        if (!content) throw new Error(`missing: ${path}`);
        return content;
      }),
      writeBinary: vi.fn().mockImplementation(async (path: string, content: ArrayBuffer) => {
        files.set(path, content.slice(0));
        if (path === "b.md") downloadWritten = true;
      }),
      stat: vi.fn().mockImplementation(async (path: string) => {
        const content = files.get(path);
        return content ? { type: "file", size: content.byteLength, mtime: 1, ctime: 1 } : null;
      }),
      rename: vi.fn().mockImplementation(async (from: string, to: string) => {
        const content = files.get(from);
        if (!content) throw new Error(`missing: ${from}`);
        files.set(to, content);
        files.delete(from);
        if (to === "b.md") downloadWritten = true;
      }),
      remove: vi.fn().mockImplementation(async (path: string) => {
        files.delete(path);
      }),
    });
    const getDelta = vi.fn(async (_vaultName: string, deltaLink?: string) => {
      if (deltaLink === "delta-token") {
        return {
          value: [driveItem("a.md", hashA)],
          "@odata.deltaLink": "https://graph.example/delta-1",
        };
      }
      if (deltaLink.endsWith("delta-1")) {
        return {
          value: [driveItem("b.md", hashB)],
          "@odata.deltaLink": "https://graph.example/delta-2",
        };
      }
      return {
        value: [driveItem("b.md", hashB, {
          id: "item-b.md",
          file: undefined,
          deleted: { state: "deleted" },
        })],
        "@odata.deltaLink": "https://graph.example/delta-3",
      };
    });
    const downloadFile = vi.fn().mockResolvedValue(downloaded);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        downloadFile,
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockImplementation(async () => {
          scanRound++;
          return {
            entries: scanRound === 1
              ? [{ path: "a.md", size: 3, mtime: 1, hash: hashA, binary: false }]
              : scanRound === 2
                ? [{ path: "a.md", size: 3, mtime: 1, hash: hashA, binary: false }]
                : [
                    { path: "a.md", size: 3, mtime: 1, hash: hashA, binary: false },
                    { path: "b.md", size: 3, mtime: 1, hash: hashB, binary: false },
                  ],
            folders: [],
            folderScanComplete: true,
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          };
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) => (
          path === "a.md" || scanRound >= 3 || downloadWritten
            ? {
                status: "present",
                entry: {
                  path,
                  size: 3,
                  mtime: 1,
                  hash: path === "a.md" ? hashA : hashB,
                  binary: false,
                },
              }
            : { status: "missing" }
        )),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const first = await executor.run("manual", {});
    expect(first.success).toBe(true);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-1");

    const second = await executor.run("manual", {});
    expect(second.success).toBe(true);
    expect(second.downloaded).toBe(1);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot.map((entry) => entry.path).sort()).toEqual(["a.md", "b.md"]);
    expect(state.baseSnapshot).toContainEqual({
      path: "b.md",
      hash: hashB,
      size: 3,
      eTag: "etag-b.md",
    });
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");

    const third = await executor.run("manual", {});
    expect(third.conflicts).toBe(1);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-3");
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      "https://graph.example/delta-1",
      "https://graph.example/delta-2",
    ]);
  });

  it("coalesces duplicate drive ids by the last delta occurrence", async () => {
    const latestHash = "bb".repeat(32);
    const local: LocalFileEntry = {
      path: "latest.md",
      hash: latestHash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([{
      path: "old.md",
      driveId: "shared-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
    }], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({
          value: [
            driveItem("middle.md", "aa".repeat(32), { id: "shared-id" }),
            driveItem("latest.md", latestHash, { id: "shared-id" }),
          ],
          "@odata.deltaLink": "https://graph.example/delta-2",
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.remoteSnapshot).toHaveLength(1);
    expect(state.remoteSnapshot[0]).toEqual(expect.objectContaining({
      path: "latest.md",
      driveId: "shared-id",
    }));
  });

  it("Preflight P0 — file delta without parent identity does not invent a root path", async () => {
    const hash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "nested/note.md",
      driveId: "note-id",
      parentId: "nested-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "nested",
        driveId: "nested-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "nested",
      }],
    });
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({
          value: [driveItem("note.md", "cc".repeat(32), {
            id: "note-id",
            parentReference: undefined,
            eTag: "etag-new",
          })],
          "@odata.deltaLink": "https://graph.example/delta-2",
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
          folders: [{ path: "nested" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(state.remoteSnapshot).toEqual([cachedEntry]);
    expect(state.remoteDeltaLink).toBe("delta-token");
  });

  it("rebuilds a complete identity snapshot when a folder delta changes a V2 path", async () => {
    const currentHash = "cc".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-child",
      cTag: "ctag-child",
      sha256Hash: "aa".repeat(32),
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "old-folder",
        driveId: "folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "old-folder",
      }],
    });
    const local: LocalFileEntry = {
      path: "new-folder/child.md",
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "new-folder",
          folder: { childCount: 1 },
          parentReference: {
            id: "files-root-id",
          },
          eTag: "etag-folder-new",
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "new-folder",
          folder: { childCount: 1 },
          parentReference: {
            id: "files-root-id",
          },
          eTag: "etag-folder-new",
        }, {
          id: "child-id",
          name: "child.md",
          size: 3,
          file: { hashes: { sha256Hash: currentHash } },
          parentReference: {
            id: "folder-id",
          },
          eTag: "etag-child-new",
          cTag: "ctag-child-new",
        }],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "new-folder" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "new-folder/child.md",
        driveId: "child-id",
        eTag: "etag-child-new",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      undefined,
    ]);
  });

  it("A0-P — keeps one delta page for a proven unchanged parent folder notification", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/graph-live-contract-success-20260717.json", import.meta.url),
      "utf8",
    )) as { deltaPages: Array<{ value: DriveItem[] }> };
    const capturedFolderMutation = fixture.deltaPages
      .flatMap((page) => page.value)
      .find((item) => item.folder);
    expect(capturedFolderMutation).toBeDefined();
    const hash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "Fragments/note.md",
      driveId: "note-id",
      parentId: "fragments-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "Fragments",
        driveId: "fragments-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Fragments",
      }],
    });
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        ...capturedFolderMutation,
        id: "fragments-folder-id",
        name: "Fragments",
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        eTag: "etag-fragments-new",
      }],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Fragments" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith(
      "testVault",
      "delta-token",
    );
    expect(state.remoteSnapshot).toEqual([cachedEntry]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("updates a V2 root file from the known files root without rebuilding", async () => {
    const currentHash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "main.js",
      driveId: "main-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
      sha256Hash: "bb".repeat(32),
    };
    const state = makeActiveV2State([cachedEntry], []);
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const updatedItem = driveItem("main.js", currentHash, {
      id: cachedEntry.driveId,
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      eTag: "etag-new",
    });
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [updatedItem],
        "@odata.deltaLink": "https://graph.example/delta-2",
      })
      .mockResolvedValueOnce({
        value: [updatedItem],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: cachedEntry.path,
        driveId: cachedEntry.driveId,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        eTag: "etag-new",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("keeps one delta page for an unchanged folder with no directly cached files", async () => {
    const hash = "aa".repeat(32);
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "note-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([remote], [], {
      remoteFolders: [{
        path: "Empty",
        driveId: "empty-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Empty",
      }],
    });
    const local: LocalFileEntry = {
      path: remote.path,
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const folderNotification: DriveItem = {
      id: "empty-folder-id",
      name: "Empty",
      folder: { childCount: 0 },
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      eTag: "etag-empty-new",
    };
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [folderNotification],
        "@odata.deltaLink": "https://graph.example/delta-2",
      })
      .mockResolvedValueOnce({
        value: [folderNotification],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Empty" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("projects a new file inside a persisted folder without a full rebuild", async () => {
    const hash = "aa".repeat(32);
    const state = makeActiveV2State([], [], {
      remoteFolders: [{
        path: "Empty",
        driveId: "empty-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Empty",
      }],
    });
    const local: LocalFileEntry = {
      path: "Empty/new.md",
      hash,
      size: 3,
      mtime: 1,
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        {
          id: "empty-folder-id",
          name: "Empty",
          folder: { childCount: 1 },
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        },
        driveItem("new.md", hash, {
          id: "new-file-id",
          parentReference: { id: "empty-folder-id" },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Empty" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Empty/new.md",
        driveId: "new-file-id",
        parentId: "empty-folder-id",
      }),
    ]);
  });

  it("applies file changes from the same page as an unchanged parent folder notification", async () => {
    const currentHash = "aa".repeat(32);
    const cachedEntry: RemoteFileEntry = {
      path: "Fragments/note.md",
      driveId: "note-id",
      parentId: "fragments-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note-old",
      cTag: "ctag-note-old",
      sha256Hash: "bb".repeat(32),
    };
    const state = makeActiveV2State([cachedEntry], [], {
      remoteFolders: [{
        path: "Fragments",
        driveId: "fragments-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Fragments",
      }],
    });
    const local: LocalFileEntry = {
      path: cachedEntry.path,
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "fragments-folder-id",
        name: "Fragments",
        folder: { childCount: 1 },
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        eTag: "etag-fragments-new",
      }, driveItem("note.md", currentHash, {
        id: "note-id",
        parentReference: { id: "fragments-folder-id" },
        eTag: "etag-note-new",
      })],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Fragments" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Fragments/note.md",
        driveId: "note-id",
        eTag: "etag-note-new",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("rebuilds instead of ignoring deletion of the known files root", async () => {
    const state = makeActiveV2State([{
      path: "note.md",
      driveId: "note-id",
      parentId: "files-root-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: "aa".repeat(32),
    }], []);
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: TEST_SYNC_SCOPE.filesRootId,
          name: "files",
          deleted: { state: "deleted" },
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        ...emptyScanner(),
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

    expect(result.success).toBe(true);
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      undefined,
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
  });

  it("removes a cached empty remote folder incrementally when its delta reports deletion", async () => {
    const state = makeActiveV2State([], [], {
      remoteFolders: [{
        path: "old-folder",
        driveId: "folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "old-folder",
      }],
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "folder-id",
        deleted: { state: "deleted" },
      }],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        ...emptyScanner(),
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

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault", "delta-token");
    expect(state.remoteFolders).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("removes a cached remote folder subtree incrementally when the delta deletes only the top folder", async () => {
    const state = makeActiveV2State([{
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-child",
      cTag: "ctag-child",
      sha256Hash: "aa".repeat(32),
    }, {
      path: "old-folder/nested/deep.md",
      driveId: "deep-id",
      parentId: "nested-id",
      size: 3,
      mtime: 1,
      eTag: "etag-deep",
      cTag: "ctag-deep",
      sha256Hash: "bb".repeat(32),
    }], [], {
      remoteFolders: [
        {
          path: "old-folder",
          driveId: "folder-id",
          parentId: TEST_SYNC_SCOPE.filesRootId,
          name: "old-folder",
        },
        {
          path: "old-folder/nested",
          driveId: "nested-id",
          parentId: "folder-id",
          name: "nested",
        },
      ],
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "folder-id",
        deleted: { state: "deleted" },
      }],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        ...emptyScanner(),
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

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteFolders).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("removes nested cached folders incrementally when the delta reports each deletion", async () => {
    const state = makeActiveV2State([{
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-child",
      cTag: "ctag-child",
      sha256Hash: "aa".repeat(32),
    }, {
      path: "old-folder/nested/deep.md",
      driveId: "deep-id",
      parentId: "nested-id",
      size: 3,
      mtime: 1,
      eTag: "etag-deep",
      cTag: "ctag-deep",
      sha256Hash: "bb".repeat(32),
    }], [], {
      remoteFolders: [
        {
          path: "old-folder",
          driveId: "folder-id",
          parentId: TEST_SYNC_SCOPE.filesRootId,
          name: "old-folder",
        },
        {
          path: "old-folder/nested",
          driveId: "nested-id",
          parentId: "folder-id",
          name: "nested",
        },
      ],
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        { id: "child-id", deleted: { state: "deleted" } },
        { id: "nested-id", deleted: { state: "deleted" } },
        { id: "folder-id", deleted: { state: "deleted" } },
      ],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        ...emptyScanner(),
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

    expect(result.success).toBe(true);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteFolders).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("still rebuilds when a live descendant arrives in the same delta batch", async () => {
    const state = makeActiveV2State([{
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-child",
      cTag: "ctag-child",
      sha256Hash: "aa".repeat(32),
    }], [], {
      remoteFolders: [{
        path: "old-folder",
        driveId: "folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "old-folder",
      }],
    });
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [
          driveItem("old-folder/child.md", "cc".repeat(32), {
            id: "child-id",
            parentReference: { id: "folder-id" },
            eTag: "etag-child-new",
          }),
          { id: "folder-id", deleted: { state: "deleted" } },
        ],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        ...emptyScanner(),
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

    expect(result.success).toBe(true);
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      undefined,
    ]);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
  });

  it("still rebuilds when the same delta batch creates an item inside the deleted subtree", async () => {
    const state = makeActiveV2State([{
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-child",
      cTag: "ctag-child",
      sha256Hash: "aa".repeat(32),
    }], [], {
      remoteFolders: [{
        path: "old-folder",
        driveId: "folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "old-folder",
      }],
    });
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [
          { id: "folder-id", deleted: { state: "deleted" } },
          driveItem("old-folder/new.md", "dd".repeat(32), {
            id: "new-id",
            parentReference: { id: "folder-id" },
          }),
        ],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      {
        ...emptyScanner(),
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

    expect(result.success).toBe(true);
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "delta-token",
      undefined,
    ]);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
  });

  it("projects a complete Graph-shaped snapshot from the known files root only", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/graph-live-contract-success-20260717.json", import.meta.url),
      "utf8",
    )) as { deltaPages: Array<{ value: DriveItem[] }> };
    const capturedItems = fixture.deltaPages.flatMap((page) => page.value);
    const capturedFolder = capturedItems.find((item) => item.name === "Nested 中文" && item.folder);
    const capturedFile = capturedItems.find((item) => item.name === "child.md" && item.file && !item.deleted);
    expect(capturedFolder).toBeDefined();
    expect(capturedFile).toBeDefined();

    const contentHash = "aa".repeat(32);
    const state = makeActiveV2State([{
      path: "old-folder/child.md",
      driveId: "child-id",
      parentId: "folder-id",
      size: 5,
      mtime: 1,
      eTag: "etag-child-old",
      cTag: "ctag-child-old",
      sha256Hash: contentHash,
    }], [], {
      remoteFolders: [{
        path: "old-folder",
        driveId: "folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "old-folder",
      }],
    });
    const local: LocalFileEntry = {
      path: "Nested 中文/child.md",
      hash: contentHash,
      size: 5,
      mtime: 1,
      binary: false,
    };
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "Nested 中文",
          folder: { childCount: 1 },
          parentReference: { id: "files-root-id" },
          eTag: "etag-folder-new",
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [{
          id: "vault-root-id",
          name: "testVault",
          folder: { childCount: 2 },
          parentReference: { id: "app-root-id" },
        }, {
          id: "files-root-id",
          name: "files",
          folder: { childCount: 1 },
          parentReference: { id: "vault-root-id" },
        }, {
          id: "plugin-root-id",
          name: ".easy-sync",
          folder: { childCount: 1 },
          parentReference: { id: "vault-root-id" },
        }, {
          ...capturedFolder,
          id: "folder-id",
          name: "Nested 中文",
          deleted: undefined,
          parentReference: { id: "files-root-id" },
        }, {
          ...capturedFile,
          id: "child-id",
          name: "child.md",
          deleted: undefined,
          parentReference: { id: "folder-id" },
          lastModifiedDateTime: "2026-07-17T00:00:00.000Z",
          file: {
            ...capturedFile!.file,
            hashes: {
              ...capturedFile!.file?.hashes,
              sha256Hash: contentHash,
            },
          },
        }, {
          id: "internal-id",
          name: "baseline.json",
          size: 5,
          file: { hashes: { sha256Hash: "dd".repeat(32) } },
          parentReference: { id: "plugin-root-id" },
        } satisfies DriveItem],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        initVaultScope: vi.fn().mockResolvedValue({
          driveId: "drive-id",
          vaultFolderId: "vault-folder-id",
          filesRootId: "files-root-id",
        }),
        getDelta,
      }),
      {
        ...emptyScanner(),
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          folders: [{ path: "Nested 中文" }],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Nested 中文/child.md",
        driveId: "child-id",
      }),
    ]);
    expect(state.remoteSnapshot.every((entry) => !entry.path.startsWith("files/"))).toBe(true);
    expect(state.remoteSnapshot.every((entry) => !entry.path.startsWith(".easy-sync/"))).toBe(true);
    expect(state.remoteFolders).toEqual([
      expect.objectContaining({
        path: "Nested 中文",
        driveId: "folder-id",
        parentId: "files-root-id",
        name: "Nested 中文",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
  });

  it("keeps the last healthy cache and stops planning on a network delta failure", async () => {
    const cachedEntry: RemoteFileEntry = {
      path: "keep.md",
      driveId: "keep-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1,
      mtime: 1,
      eTag: "keep-etag",
      cTag: "keep-ctag",
    };
    const state = makeActiveV2State([cachedEntry], []);
    const getDelta = vi.fn().mockRejectedValue(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "offline",
    ));
    const fullScan = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta, fullScan }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(fullScan).not.toHaveBeenCalled();
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["keep.md"]);
    expect(state.remoteDeltaLink).toBe("delta-token");
  });

  it("applies successful uploads and remote deletes to the cached view", async () => {
    const removedRemote: RemoteFileEntry = {
      path: "remove.md",
      driveId: "remove-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-remove",
      cTag: "ctag-remove",
    };
    const removedBase: BaseFileEntry = {
      path: removedRemote.path,
      size: removedRemote.size,
      hash: "bb".repeat(32),
      eTag: removedRemote.eTag,
    };
    const state = makeActiveV2State([removedRemote], [removedBase]);
    const uploadLocal: LocalFileEntry = {
      path: "upload.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const adapter = makeMockAdapter();
    const uploadFile = vi.fn().mockResolvedValue({
      id: "upload-id",
      name: uploadLocal.path,
      size: uploadLocal.size,
      eTag: "etag-upload",
      cTag: "ctag-upload",
      lastModifiedDateTime: "2026-07-10T00:00:00.000Z",
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
    });
    const deleteItem = vi.fn().mockResolvedValue(undefined);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({ value: [], "@odata.deltaLink": "https://graph.example/delta-2" }),
        uploadFile,
        deleteItem,
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [uploadLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          path === uploadLocal.path ? uploadLocal : null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.uploaded).toBe(1);
    expect(result.deleted).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(deleteItem).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["upload.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("allows a conflict action on an unrelated path while one unresolved record is isolated", async () => {
    const harness = await makeManualResolutionHarness({
      path: "notes/blocked.md",
      withLedger: true,
      expectedLocalAtIntent: true,
      local: {
        "notes/blocked.md": "blocked local",
        "notes/other.md": "other local bytes",
      },
      remote: {
        "notes/blocked.md": "blocked remote bytes",
        "notes/other.md": "other remote bytes",
      },
      pendingConflictPaths: ["notes/other.md"],
    });

    await harness.executor.resolveConflictKeepLocal("notes/other.md");

    // The unrelated keep-local re-upload must proceed even though the
    // unresolved ordinary record would block a same-path action.
    expect(harness.uploadFile).toHaveBeenCalled();
    expect(harness.uploadFile.mock.calls.some(
      (call) => String(call[1]).endsWith("notes/other.md"),
    )).toBe(true);
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("still refuses an action overlapping an isolated unresolved recovery record", async () => {
    const harness = await makeManualResolutionHarness({
      path: "notes/other.md",
      withLedger: true,
      expectedLocalAtIntent: true,
      local: {
        "notes/other.md": "other local bytes",
      },
      remote: {
        "notes/other.md": "other remote bytes",
      },
      pendingConflictPaths: ["notes/other.md"],
    });

    await harness.executor.resolveConflictKeepLocal("notes/other.md");

    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("allows an unrelated action when the only unresolved record sits on a managed config path (2026-10-13 B1)", async () => {
    const harness = await makeManualResolutionHarness({
      path: ".obsidian/app.json",
      withLedger: true,
      expectedLocalAtIntent: true,
      local: {
        ".obsidian/app.json": "config bytes",
        "notes/other.md": "other local bytes",
      },
      remote: {
        ".obsidian/app.json": "config remote bytes",
        "notes/other.md": "other remote bytes",
      },
      pendingConflictPaths: ["notes/other.md"],
    });

    await harness.executor.resolveConflictKeepLocal("notes/other.md");

    // B1：受管配置路径上的未结算记录不再冻结整库——无关路径的动作照常执行，
    // 记录原样保留（隔离不删不猜、该路径族仍被保护）。
    expect(harness.uploadFile).toHaveBeenCalled();
    expect(harness.uploadFile.mock.calls.some(
      (call) => String(call[1]).endsWith("notes/other.md"),
    )).toBe(true);
    expect(harness.state.mutationLedger).toHaveLength(1);
  });
});
