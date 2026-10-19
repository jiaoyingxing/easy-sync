// 执行期竞态、改名识别与身份重绑
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
} from "vitest";
import * as obsidian from "obsidian";
import {
  TFile,
  TFolder,
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

describe("Execute-time file race safety", () => {
  it("defers an upload whose local file disappeared after scan instead of failing the round", async () => {
    // 2026-10-02 field report (Android, F19): a default-named new note was
    // renamed between scan and execution, so reading the scanned path threw
    // the host's "File does not exist". That turned a harmless scan-window
    // race into a round failure plus an auto-sync pause. A read failure only
    // counts as "the source is gone" when a fresh inspection confirms the
    // path is missing; then the item is deferred like content drift.
    const scannedContent = new TextEncoder().encode("draft").buffer;
    const local: LocalFileEntry = {
      path: "07 处理/未命名.md",
      size: scannedContent.byteLength,
      mtime: 1,
      hash: await sha256Hex(scannedContent),
      binary: false,
    };
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn();
    const state = makeActiveV2State([], [], {
      reconcilePendingIssues,
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockRejectedValue(new Error("File does not exist")),
          }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    expect(result.message).toBe("result.deferred");
    expect(reconcilePendingIssues).toHaveBeenCalledWith([], expect.any(Set));
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });

  it("keeps the upload failure hard when the path is still present but unreadable", async () => {
    // Only a confirmed absence may be read as scan-window drift. A read
    // failure while the file still exists (lock, permission, IO) keeps the
    // honest failure, its pending intent record and the fail-closed round.
    const scannedContent = new TextEncoder().encode("locked").buffer;
    const local: LocalFileEntry = {
      path: "locked.md",
      size: scannedContent.byteLength,
      mtime: 1,
      hash: await sha256Hex(scannedContent),
      binary: false,
    };
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn();
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const state = makeActiveV2State([], [], {
      reconcilePendingIssues,
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockRejectedValue(new Error("EBUSY: file is locked")),
          }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "uncertain", reason: "read" }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      diag as never,
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.deferred).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.success).toBe(false);
    expect(result.message).toBe("result.syncFailed");
    // The fail-closed intent record stays: an unreadable path is not proof
    // that the source is gone, so the item must not be deferred.
    expect(state.mutationLedger).toHaveLength(1);
    expect(diag.warn.mock.calls.some(([, message]) =>
      String(message).includes("disappeared since scan"))).toBe(false);
  });

  it("absorbs an If-Match upload race when remote already has the same content", async () => {
    const local: LocalFileEntry = {
      path: "note.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const remoteBeforeRace: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 1,
      eTag: "etag-old",
      cTag: "",
    };
    const state = makeActiveV2State(
      [remoteBeforeRace],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
      { upsertPendingConflicts },
    );
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id",
          size: local.size,
          mtime: 2,
          eTag: "etag-remote",
          downloadUrl: "https://download.example/note.md",
          sha256Hash: local.hash,
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      diag as never,
    );

    const result = await executor.run("manual", {});

    expect(diag.error).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([
      { path: local.path, hash: local.hash, size: local.size, eTag: "etag-remote" },
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        sha256Hash: local.hash,
        eTag: "etag-remote",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      expect.any(ArrayBuffer),
      expect.anything(),
      "etag-old",
      "remote-id",
    );
  });

  it("surfaces an actionable reason when an upload fails 400 on a OneDrive-invalid file name", async () => {
    const content = new TextEncoder().encode("pdf payload");
    const state = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const failureReason = (executor as unknown as {
      failureReason(error: unknown, path?: string): string;
    }).failureReason.bind(executor);

    const invalidName =
      new OneDriveError(OneDriveErrorType.Unknown, "name contains unsupported characters", 400);
    expect(failureReason(invalidName, "03-Travel/澳大利亚/assets/🇦🇺澳大利亚十四日游.pdf?="))
      .toBe("syncView.failure.remoteInvalidNameChar");

    // The specific failure modes are distinguished for the user.
    expect(failureReason(invalidName, "note.md."))
      .toBe("syncView.failure.remoteInvalidNameTrailingDot");
    expect(failureReason(invalidName, "note.md "))
      .toBe("syncView.failure.remoteInvalidNameTrailingSpace");
    expect(failureReason(invalidName, "a\u0001b"))
      .toBe("syncView.failure.remoteInvalidNameControlChar");

    // The same 400 on a validly-named file keeps the generic reason.
    expect(failureReason(invalidName, "note.md"))
      .toBe("syncView.failure.remote");

    // Without a path we cannot classify, so it also stays generic.
    expect(failureReason(invalidName))
      .toBe("syncView.failure.remote");

    // A non-400 failure (e.g. a network error) is not mislabelled, even when
    // the file name is invalid — the branch is specifically about an HTTP 400
    // that proves the name cannot be stored.
    const networkErr = new OneDriveError(OneDriveErrorType.NetworkError, "offline");
    expect(failureReason(networkErr, "pdf?=name")).toBe("syncView.failure.network");
  });

  it("uses one version-bound readback when an If-Match upload race only exposes QuickXor", async () => {
    const content = new TextEncoder().encode("same bytes from another client");
    const hash = await sha256Hex(content.buffer);
    const local: LocalFileEntry = {
      path: "quickxor-only.md",
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      downloadUrl: "https://download.example/quickxor-only.md",
      quickXorHash: "remote-quickxor",
    });
    const downloadFile = vi.fn().mockResolvedValue(content.buffer);
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
        quickXorHash: "old-quickxor",
      }],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata,
        downloadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content.buffer),
          }),
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
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(0);
    expect(addPendingConflict).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      "https://download.example/quickxor-only.md",
      "remote-id",
      local.size,
    );
    expect(getFileMetadata).toHaveBeenCalledTimes(2);
    expect(state.baseSnapshot).toEqual([
      { path: local.path, hash, size: local.size, eTag: "etag-remote" },
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        eTag: "etag-remote",
        quickXorHash: "remote-quickxor",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps both versions when a QuickXor-only upload race reads back different content", async () => {
    const localContent = new TextEncoder().encode("local-race-version");
    const remoteContent = new TextEncoder().encode("other-race-version");
    const localHash = await sha256Hex(localContent.buffer);
    const remoteHash = await sha256Hex(remoteContent.buffer);
    const local: LocalFileEntry = {
      path: "quickxor-different.md",
      size: localContent.byteLength,
      mtime: 1,
      hash: localHash,
      quickXorHash: "same-quickxor",
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      downloadUrl: "https://download.example/quickxor-different.md",
      quickXorHash: "same-quickxor",
    });
    const downloadFile = vi.fn().mockResolvedValue(remoteContent.buffer);
    const commonHash = "00".repeat(32);
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
      }],
      [{
        path: local.path,
        hash: commonHash,
        size: local.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata,
        downloadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(localContent.buffer),
          }),
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
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      conflicts: 1,
      errors: 0,
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(downloadFile).toHaveBeenCalledOnce();
    // A byte mismatch is already conclusive. Only the initial fresh metadata
    // read is needed; a second version check is reserved for equality claims.
    expect(getFileMetadata).toHaveBeenCalledOnce();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: local.path,
      local: expect.objectContaining({ hash: localHash }),
      remote: expect.objectContaining({
        driveId: "remote-id",
        eTag: "etag-remote",
        quickXorHash: "same-quickxor",
      }),
      reason: "reason.bothSidesModified",
    }));
    expect(remoteHash).not.toBe(localHash);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        driveId: "remote-id",
        eTag: "etag-remote",
      }),
    ]);
    expect(state.baseSnapshot).toEqual([{
      path: local.path,
      hash: commonHash,
      size: local.size,
      eTag: "etag-old",
    }]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps the upload race pending when the QuickXor-only readback is unavailable", async () => {
    const content = new TextEncoder().encode("local version");
    const hash = await sha256Hex(content.buffer);
    const local: LocalFileEntry = {
      path: "quickxor-readback-failed.md",
      size: content.byteLength,
      mtime: 1,
      hash,
      quickXorHash: "same-quickxor",
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      downloadUrl: "https://download.example/quickxor-readback-failed.md",
      quickXorHash: "same-quickxor",
    });
    const downloadFile = vi.fn().mockRejectedValue(new Error("network unavailable"));
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
      }],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile: vi.fn().mockRejectedValue(
          new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
        ),
        getFileMetadata,
        downloadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content.buffer),
          }),
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
      state,
      "testVault",
      undefined,
      undefined,
      diag as never,
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(getFileMetadata).toHaveBeenCalledTimes(1);
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: local.path,
      local,
      remote: expect.objectContaining({
        driveId: "remote-id",
        eTag: "etag-remote",
        quickXorHash: "same-quickxor",
      }),
      reason: "reason.bothSidesModified",
    }));
    expect(diag.warn).toHaveBeenCalledWith(
      "execute",
      `upload race content read-back failed — ${local.path}`,
      expect.any(Error),
    );
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        hash: "00".repeat(32),
        eTag: "etag-old",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("does not re-upload when a same-content race commits remote identity before the base write fails", async () => {
    const local: LocalFileEntry = {
      path: "note.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const state = makeActiveV2State(
      [{
        path: local.path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: local.size,
        mtime: 1,
        eTag: "etag-old",
        cTag: "",
      }],
      [{
        path: local.path,
        hash: "00".repeat(32),
        size: local.size,
        eTag: "etag-old",
      }],
    );
    const commitBase = state.upsertBaseEntries.bind(state);
    let failBaseOnce = true;
    state.upsertBaseEntries = vi.fn(async (entries) => {
      if (failBaseOnce) {
        failBaseOnce = false;
        throw new Error("base commit interrupted");
      }
      return await commitBase(entries);
    });
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.PreconditionFailed,
        "etag changed",
        412,
      ),
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id",
          size: local.size,
          mtime: 2,
          eTag: "etag-remote",
          downloadUrl: "https://download.example/note.md",
          sha256Hash: local.hash,
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const interrupted = await executor.run("manual", {});

    expect(interrupted.errors).toBe(1);
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        eTag: "etag-remote",
        sha256Hash: local.hash,
      }),
    ]);
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        eTag: "etag-old",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);

    const recovered = await executor.run("manual", {});

    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(state.baseSnapshot).toEqual([{
      path: local.path,
      hash: local.hash,
      size: local.size,
      eTag: "etag-remote",
    }]);
  });

  it("queues a pending conflict when a local file changes again before download writes", async () => {
    const scannedContent = new TextEncoder().encode("scanned");
    const localNowContent = new TextEncoder().encode("local-now");
    const remoteContent = new TextEncoder().encode("remote-now");
    const scannedHash = await sha256Hex(scannedContent.buffer);
    const localNowHash = await sha256Hex(localNowContent.buffer);
    const remoteHash = await sha256Hex(remoteContent.buffer);
    const local: LocalFileEntry = {
      path: "note.md",
      size: scannedContent.byteLength,
      mtime: 1,
      hash: scannedHash,
      binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://download.example/note.md",
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "",
      sha256Hash: remoteHash,
    };
    const state = makeActiveV2State(
      [remote],
      [{
        path: local.path,
        hash: scannedHash,
        size: scannedContent.byteLength,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(remoteContent.buffer),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(localNowContent.buffer),
            stat: vi.fn().mockResolvedValue({ mtime: 9, size: localNowContent.byteLength }),
          }),
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
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1);
    expect(result.errors).toBe(0);
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: local.path,
      reason: "reason.bothSidesModified",
      local: expect.objectContaining({
        hash: localNowHash,
        size: localNowContent.byteLength,
        mtime: 9,
      }),
      remote: expect.objectContaining({
        eTag: "etag-remote",
        sha256Hash: remoteHash,
      }),
    }));
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: local.path,
        hash: scannedHash,
        eTag: "etag-old",
      }),
    ]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps a local edit that lands after the remote payload downloads but before commit", async () => {
    const scannedContent = new TextEncoder().encode("common-before-download");
    const localRaceContent = new TextEncoder().encode("local-edit-during-download");
    const remoteContent = new TextEncoder().encode("remote-version-to-download");
    const scannedHash = await sha256Hex(scannedContent.buffer);
    const localRaceHash = await sha256Hex(localRaceContent.buffer);
    const remoteHash = await sha256Hex(remoteContent.buffer);
    const path = "download-local-race.md";
    const scanned: LocalFileEntry = {
      path,
      size: scannedContent.byteLength,
      mtime: 1,
      hash: scannedHash,
      binary: false,
    };
    const localAfterDownload: LocalFileEntry = {
      path,
      size: localRaceContent.byteLength,
      mtime: 9,
      hash: localRaceHash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://download.example/download-local-race.md",
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: remoteHash,
    };
    const inspectFile = vi.fn()
      .mockResolvedValueOnce({ status: "present", entry: scanned })
      .mockResolvedValueOnce({ status: "present", entry: localAfterDownload });
    const downloadFile = vi.fn().mockResolvedValue(remoteContent.buffer);
    const writeBinary = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      [{
        path,
        hash: scannedHash,
        size: scanned.size,
        eTag: "etag-common",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [scanned],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile,
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      conflicts: 1,
      errors: 0,
    });
    expect(downloadFile).toHaveBeenCalledOnce();
    expect(inspectFile).toHaveBeenCalledTimes(2);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path,
      local: localAfterDownload,
      remote: expect.objectContaining({
        driveId: remote.driveId,
        eTag: remote.eTag,
        sha256Hash: remoteHash,
      }),
      reason: "reason.bothSidesModified",
    }));
    expect(state.baseSnapshot).toEqual([{
      path,
      hash: scannedHash,
      size: scanned.size,
      eTag: "etag-common",
    }]);
    expect(state.mutationLedger).toEqual([]);
  });

  it("reuses one bounded fallback download when a raced local file already equals remote", async () => {
    const scannedContent = new TextEncoder().encode("scanned");
    const currentContent = new TextEncoder().encode("same-now");
    const scannedHash = await sha256Hex(scannedContent.buffer);
    const currentHash = await sha256Hex(currentContent.buffer);
    const path = "same-after-race.md";
    const scanned: LocalFileEntry = {
      path,
      size: scannedContent.byteLength,
      mtime: 1,
      hash: scannedHash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      downloadUrl: "https://download.example/same-after-race.md",
      size: currentContent.byteLength,
      mtime: 2,
      eTag: "etag-remote",
      cTag: "",
    };
    const downloadFile = vi.fn().mockResolvedValue(currentContent.buffer);
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      [{
        path,
        hash: scannedHash,
        size: scanned.size,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [scanned],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: { ...scanned, hash: currentHash, size: currentContent.byteLength, mtime: 9 },
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(addPendingConflict).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([{
      path,
      hash: currentHash,
      size: currentContent.byteLength,
      eTag: remote.eTag,
    }]);
  });

  it("queues a pending conflict when remote changes before DeleteRemote executes", async () => {
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const deleteItem = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
    );
    const remoteBeforeRace: RemoteFileEntry = {
      path: "deleted.md",
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 10,
      mtime: 1,
      eTag: "etag-old",
      cTag: "",
    };
    const state = makeActiveV2State(
      [remoteBeforeRace],
      [{
        path: "deleted.md",
        hash: "aa".repeat(32),
        size: 10,
        eTag: "etag-old",
      }],
      { addPendingConflict },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        deleteItem,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id",
          size: 12,
          mtime: 7,
          eTag: "etag-new",
          downloadUrl: "https://download.example/deleted.md",
          sha256Hash: "bb".repeat(32),
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1);
    expect(result.deleted).toBe(0);
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      type: SyncActionType.Conflict,
      path: "deleted.md",
      remote: {
        path: "deleted.md",
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        downloadUrl: "https://download.example/deleted.md",
        size: 12,
        mtime: 7,
        eTag: "etag-new",
        cTag: "",
        sha256Hash: "bb".repeat(32),
      },
      reason: "reason.localDeletedRemoteModified",
      decisionToken: expect.objectContaining({
        version: 1,
        ancestorHash: "aa".repeat(32),
        remote: { exists: true, driveId: "remote-id", eTag: "etag-new" },
      }),
    }));
    expect(state.remoteSnapshot).toEqual([{
      path: "deleted.md",
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://download.example/deleted.md",
      size: 12,
      mtime: 7,
      eTag: "etag-new",
      cTag: "",
      sha256Hash: "bb".repeat(32),
    }]);
    expect(state.baseSnapshot).toEqual([{
      path: "deleted.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-old",
    }]);
    expect(state.mutationLedger).toEqual([]);
    expect(deleteItem).toHaveBeenCalledWith(
      "testVault",
      "deleted.md",
      "etag-old",
      "remote-id",
    );
  });
});

describe("Download plan preserves the scanned local version", () => {
  it("keeps the local CAS expectation when only the remote version changed", () => {
    const path = "same-line-append.md";
    const base: BaseFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 280,
      eTag: "etag-v5",
    };
    const local: LocalFileEntry = {
      path,
      hash: base.hash,
      size: base.size,
      mtime: 1,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "item-same-line-append",
      size: 290,
      mtime: 2,
      eTag: "etag-v6",
      cTag: "ctag-v6",
    };

    const plan = generateFileDecisionPlanV2({
      localEntries: [local],
      remoteEntries: [remote],
      baseEntries: [base],
      skippedLarge: [],
    configDir: ".obsidian",
    });

    expect(plan.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Download,
        path,
        local,
        remote,
      }),
    ]);
  });
});

// ---- Large file boundary: base file growing beyond 50MB ----
// Tests that files which outgrow the size limit do NOT trigger
// false deletions, baseline corruption, or silent sync loss.

describe("Large file boundary — base file exceeds 50MB", () => {
  const engine = new V2FilePlanTestHarness();
  const protectedConfigPaths = [
    ".obsidian/app.json",
    ".obsidian/appearance.json",
    ".obsidian/hotkeys.json",
    ".obsidian/core-plugins.json",
    ".obsidian/community-plugins.json",
    ".OBSIDIAN/APP.JSON",
  ] as const;

  function baseEntry(path: string, overrides: Partial<BaseFileEntry> = {}): BaseFileEntry {
    return { path, hash: "bb".repeat(32), size: 10000, eTag: "old-etag", ...overrides };
  }

  function localEntry(path: string, overrides: Partial<LocalFileEntry> = {}): LocalFileEntry {
    return { path, size: 10000, mtime: 1, hash: "aa".repeat(32), binary: false, ...overrides };
  }

  function remoteEntry(path: string, overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry {
    return { path, driveId: `id-${path}`, size: 10000, mtime: 1, eTag: "old-etag", cTag: "ctag", ...overrides };
  }

  it("file in base+remote, grew >50MB → SkipLargeFile, NOT DeleteRemote", () => {
    // File was synced (in base + remote), but now too large to scan.
    // The engine must NOT generate DeleteRemote — the file still exists locally.
    const plan = engine.buildFilePlan(
      [],                          // localEntries — empty because file was skipped
      [remoteEntry("big.mp4")],    // remote still has it
      [baseEntry("big.mp4")],      // base still has it
      ["big.mp4"],                 // skippedLarge
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
    ]);
  });

  it("adds skipped-large items without rescanning the growing plan", () => {
    const skippedLarge = Array.from({ length: 100 }, (_, index) => `large-${index}.bin`);
    const some = vi.spyOn(Array.prototype, "some");

    try {
      const plan = engine.buildFilePlan([], [], [], skippedLarge);
      expect(plan.items).toHaveLength(skippedLarge.length);
      expect(some).not.toHaveBeenCalled();
    } finally {
      some.mockRestore();
    }
  });

  it("file in base only (not remote), grew >50MB → SkipLargeFile, NOT a delete", () => {
    // Local-only file outgrew limit. Should just be skipped, not trigger any delete.
    const plan = engine.buildFilePlan(
      [],
      [],
      [baseEntry("big.mp4")],
      ["big.mp4"],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
    ]);
  });

  it("file in base+remote, remote also modified, grew >50MB → SkipLargeFile, not Conflict or DeleteRemote", () => {
    // Worst case: both sides changed but we can't read local. Safest: skip, let user handle.
    const plan = engine.buildFilePlan(
      [],
      [remoteEntry("big.mp4", { eTag: "new-etag", size: 20000 })],
      [baseEntry("big.mp4")],
      ["big.mp4"],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
    ]);
  });

  it("normal file (<50MB) in base, genuinely deleted locally → still DeleteRemote (regression)", () => {
    // This is the normal case: file was small, user deleted it. Should still work.
    const plan = engine.buildFilePlan(
      [],
      [remoteEntry("deleted.md")],
      [baseEntry("deleted.md")],
      [],  // NOT in skippedLarge — genuinely deleted
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toEqual([
      { type: SyncActionType.DeleteRemote, path: "deleted.md" },
    ]);
  });

  for (const path of protectedConfigPaths) {
    it(`protected config ${path} missing remotely is recreated instead of becoming a delete decision`, () => {
      const plan = engine.buildFilePlan(
        [localEntry(path, { hash: "changed".repeat(9) + "c", size: 851 })],
        [],
        [baseEntry(path, { hash: "same".repeat(16), size: 850, eTag: "etag-app" })],
        [],
      );

      expect(plan.items).toContainEqual(expect.objectContaining({
        type: SyncActionType.Upload,
        path,
      }));
      expect(plan.items.some((item) =>
        (item.type === SyncActionType.ConfirmLocalDelete || item.type === SyncActionType.Conflict)
          && item.path === path,
      )).toBe(false);
    });

    it(`protected config ${path} missing locally is restored instead of becoming a delete decision`, () => {
      const plan = engine.buildFilePlan(
        [],
        [remoteEntry(path, { size: 851, eTag: "etag-new" })],
        [baseEntry(path, { hash: "same".repeat(16), size: 850, eTag: "etag-app" })],
        [],
      );

      expect(plan.items).toContainEqual(expect.objectContaining({
        type: SyncActionType.Download,
        path,
      }));
      expect(plan.items.some((item) =>
        (item.type === SyncActionType.DeleteRemote || item.type === SyncActionType.Conflict)
          && item.path === path,
      )).toBe(false);
    });
  }

  it("file in base, not scanned, not in skippedLarge, not in remote → no action (deleted both sides)", () => {
    // Edge case: file was in base but now missing from local, remote, AND skippedLarge.
    // Should be treated as deleted-on-both-sides → no action.
    const plan = engine.buildFilePlan(
      [],
      [],
      [baseEntry("gone.md")],
      [],
    );

    expect(plan.items).toHaveLength(0);
  });

  it("mixed: one normal delete + one oversized skip in same plan", () => {
    const plan = engine.buildFilePlan(
      [],
      [
        remoteEntry("deleted.md"),
        remoteEntry("big.mp4"),
      ],
      [
        baseEntry("deleted.md"),
        baseEntry("big.mp4"),
      ],
      ["big.mp4"],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toContainEqual({ type: SyncActionType.DeleteRemote, path: "deleted.md" });
    expect(actions).toContainEqual({ type: SyncActionType.SkipLargeFile, path: "big.mp4" });
    expect(actions).toHaveLength(2);
  });
});

// ---- Rename detection via content hash matching ----

describe("Rename detection — content hash matching", () => {
  const engine = new V2FilePlanTestHarness();

  function localEntry(path: string, hash: string, size = 100): LocalFileEntry {
    return { path, hash, size, mtime: Date.now(), binary: false };
  }

  function remoteEntry(path: string): RemoteFileEntry {
    return { path, driveId: `id-${path}`, size: 100, mtime: Date.now(), eTag: "etag-1", cTag: "ctag-1" };
  }

  function baseEntry(path: string, hash = "abc123", eTag = "etag-1"): BaseFileEntry {
    return { path, hash, size: 100, eTag };
  }

  it("same-directory rename produces RenameRemote, not Upload + DeleteRemote", () => {
    const plan = engine.buildFilePlan(
      [localEntry("new.md", "abc123")],
      [remoteEntry("old.md")],
      [baseEntry("old.md", "abc123")],
      [],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path, renameFrom: i.renameFrom }));
    expect(actions).toContainEqual({ type: SyncActionType.RenameRemote, path: "new.md", renameFrom: "old.md" });
    expect(actions).not.toContainEqual(expect.objectContaining({ type: SyncActionType.Upload, path: "new.md" }));
    expect(actions).not.toContainEqual(expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "old.md" }));
  });

  it("Preflight P0 — remote modification prevents local rename detection", () => {
    const plan = engine.buildFilePlan(
      [localEntry("new.md", "abc123")],
      [{ ...remoteEntry("old.md"), eTag: "etag-2" }],
      [baseEntry("old.md", "abc123", "etag-1")],
      [],
    );

    expect(plan.items).not.toContainEqual(
      expect.objectContaining({ type: SyncActionType.RenameRemote, path: "new.md", renameFrom: "old.md" }),
    );
    expect(plan.items).toContainEqual(
      expect.objectContaining({ type: SyncActionType.Conflict, path: "old.md" }),
    );
    expect(plan.items).toContainEqual(
      expect.objectContaining({ type: SyncActionType.Upload, path: "new.md" }),
    );
  });

  it("cross-directory rename preserves the old remote object when identity move is unavailable", () => {
    const plan = engine.buildFilePlan(
      [localEntry("sub/new.md", "abc123")],
      [remoteEntry("old.md")],
      [baseEntry("old.md", "abc123")],
      [],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.Upload, path: "sub/new.md" }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.Conflict, path: "old.md" }));
    expect(actions).not.toContainEqual(expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "old.md" }));
    expect(actions.filter((a) => a.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });

  it("empty file rename is NOT matched (0-byte skipped)", () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const plan = engine.buildFilePlan(
      [localEntry("new.md", emptyHash, 0)],
      [remoteEntry("old.md")],
      [{ path: "old.md", hash: emptyHash, size: 0, eTag: "etag-1" }],
      [],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.Upload, path: "new.md" }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "old.md" }));
    expect(actions.filter((a) => a.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });

  it("ambiguous same-hash copies preserve the old remote object", () => {
    const hash = "abc123";
    const plan = engine.buildFilePlan(
      [localEntry("copy1.md", hash), localEntry("copy2.md", hash)],
      [remoteEntry("old.md")],
      [baseEntry("old.md", hash)],
      [],
    );

    const uploads = plan.items.filter((i) => i.type === SyncActionType.Upload);
    expect(uploads).toHaveLength(2);
    expect(plan.items.some((i) => i.type === SyncActionType.Conflict && i.path === "old.md")).toBe(true);
    expect(plan.items.some((i) => i.type === SyncActionType.DeleteRemote && i.path === "old.md")).toBe(false);
    expect(plan.items.filter((i) => i.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });

  it("no false match when old file hash differs from new file", () => {
    const plan = engine.buildFilePlan(
      [localEntry("new.md", "different-hash")],
      [remoteEntry("old.md")],
      [baseEntry("old.md", "old-hash")],
      [],
    );

    expect(plan.items.some((i) => i.type === SyncActionType.Upload && i.path === "new.md")).toBe(true);
    expect(plan.items.some((i) => i.type === SyncActionType.DeleteRemote && i.path === "old.md")).toBe(true);
    expect(plan.items.filter((i) => i.type === SyncActionType.RenameRemote)).toHaveLength(0);
  });
});

describe("replaced-identity upload state-only rebind", () => {
  interface ReplacedIdentityUploadInput {
    path?: string;
    localContent?: string;
    remoteContent?: string;
    withStaleReceipt?: boolean;
    withStaleManualResolution?: boolean;
    oldIdentityPresentAtPath?: string;
    pendingDeleteDriveId?: string | null;
    staleFileAnchors?: Array<{ path: string; remoteId: string; eTag?: string }>;
    extraBasePaths?: string[];
    dependentFolderAtRoot?: boolean;
  }

  async function makeReplacedIdentityUploadHarness(
    input: ReplacedIdentityUploadInput = {},
  ) {
    const path = input.path ?? "note.md";
    const localContent = input.localContent ?? "local";
    const remoteContent = input.remoteContent ?? localContent;
    const encoder = new TextEncoder();
    const localBytes = encoder.encode(localContent).buffer;
    const remoteBytes = encoder.encode(remoteContent).buffer;
    const localHash = await sha256Hex(localBytes);
    const remoteHash = await sha256Hex(remoteBytes);
    const oldRemoteId = "old-id";
    const newRemoteId = "new-id";
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };

    const localBytesByPath = new Map<string, ArrayBuffer>([[path, localBytes]]);
    const adapter = makeMockAdapter({
      exists: vi.fn(async (candidate: string) =>
        localBytesByPath.has(candidate)),
      stat: vi.fn(async (candidate: string) => {
        const bytes = localBytesByPath.get(candidate);
        return bytes
          ? { type: "file", size: bytes.byteLength, mtime: 1, ctime: 1 }
          : null;
      }),
      readBinary: vi.fn(async (candidate: string) => {
        const bytes = localBytesByPath.get(candidate);
        if (!bytes) throw new Error(`missing local: ${candidate}`);
        return bytes.slice(0);
      }),
    });

    const remoteFiles = new Map<string, {
      entry: RemoteFileEntry;
      bytes: ArrayBuffer;
    }>();
    remoteFiles.set(path, {
      entry: {
        path,
        driveId: newRemoteId,
        parentId: scope.filesRootId,
        size: remoteBytes.byteLength,
        mtime: 2,
        eTag: "etag-new",
        cTag: "ctag-new",
        sha256Hash: remoteHash,
      },
      bytes: remoteBytes,
    });
    if (input.oldIdentityPresentAtPath) {
      remoteFiles.set(input.oldIdentityPresentAtPath, {
        entry: {
          path: input.oldIdentityPresentAtPath,
          driveId: oldRemoteId,
          parentId: scope.filesRootId,
          size: remoteBytes.byteLength,
          mtime: 1,
          eTag: "etag-old",
          cTag: "ctag-old",
          sha256Hash: remoteHash,
        },
        bytes: remoteBytes,
      });
    }

    const committedRemoteEntries = [...remoteFiles.values()]
      .map((item) => item.entry);
    const committedBaseEntries: BaseFileEntry[] = [{
      path,
      hash: localHash,
      size: localBytes.byteLength,
      eTag: "etag-old",
    }];
    for (const extra of input.extraBasePaths ?? []) {
      committedBaseEntries.push({
        path: extra,
        hash: "f".repeat(64),
        size: 1,
        eTag: "etag-extra",
      });
    }
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "blocked-operation",
      planRevision: 1,
      scope,
      action: "upload",
      path,
      expectedLocal: {
        exists: true,
        hash: localHash,
        size: localBytes.byteLength,
      },
      expectedRemote: {
        exists: true,
        driveId: oldRemoteId,
        eTag: "etag-old",
        size: localBytes.byteLength,
        sha256Hash: localHash,
      },
      createdAt: 1,
    };
    const staleReceipt: MutationReceiptV1 = {
      version: 1,
      operationId: intent.operationId,
      completedAt: 2,
      checkpoint: {
        baseUpserts: [{
          path,
          hash: localHash,
          size: localBytes.byteLength,
          eTag: "etag-old",
        }],
        baseRemovals: [],
        remoteUpserts: [{
          path,
          driveId: oldRemoteId,
          parentId: scope.filesRootId,
          size: localBytes.byteLength,
          mtime: 1,
          eTag: "etag-old",
          cTag: "ctag-old",
          sha256Hash: localHash,
        }],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    };
    const staleManualResolution: ManualMutationResolutionV1 = {
      version: 1,
      choice: "keep-local",
      factsDigest: "stale-digest",
      selectedAt: 3,
      externalMutation: false,
      intent: { ...intent, operationId: "blocked-operation-manual" },
      receipt: null,
    };
    const ledger: MutationLedgerEntryV1[] = [{
      intent,
      receipt: input.withStaleReceipt ? staleReceipt : null,
      ...(input.withStaleManualResolution
        ? { manualResolution: staleManualResolution }
        : {}),
    }];
    if (input.dependentFolderAtRoot) {
      ledger.push({
        intent: {
          version: 2,
          operationId: "dependent-folder",
          planRevision: 1,
          scope,
          action: "deleteLocalFolder",
          path,
          folderId: "folder-dep",
          expectedLocal: { exists: false },
          expectedRemote: { exists: false },
          expectedParent: { driveId: scope.filesRootId, path: "" },
          createdAt: 1,
        },
        receipt: null,
      });
    }

    const pendingRemoteDeletes: SyncPlanItem[] = [];
    if (input.pendingDeleteDriveId !== null) {
      const tokenRemoteId = input.pendingDeleteDriveId ?? oldRemoteId;
      pendingRemoteDeletes.push({
        type: SyncActionType.DeleteRemote,
        path,
        decisionToken: {
          version: 1,
          vaultName: "testVault",
          accountId: scope.accountId,
          scope,
          local: { exists: false },
          remote: {
            exists: true,
            driveId: tokenRemoteId,
            eTag: "etag-any",
          },
          ancestorHash: null,
        },
      } as unknown as SyncPlanItem);
    }

    const state = makeActiveV2State(
      committedRemoteEntries,
      committedBaseEntries,
      {
        mutationLedger: ledger,
        pendingRemoteDeletes,
        staleFileAnchors: input.staleFileAnchors ?? [{
          path,
          remoteId: oldRemoteId,
          eTag: "etag-old",
        }],
      },
    );
    const getDriveItemMetadataById = vi.fn(async (driveId: string) => {
      const found = [...remoteFiles.values()].find(
        (current) => current.entry.driveId === driveId,
      );
      return found ? { id: driveId, eTag: found.entry.eTag } : null;
    });
    const downloadFile = vi.fn(async (_vault: string, candidate: string) => {
      const current = remoteFiles.get(candidate);
      if (!current) throw new Error(`missing remote: ${candidate}`);
      return current.bytes.slice(0);
    });
    const onedrive = makeMockOneDrive({
      getFileMetadata: vi.fn(async (_vault: string, candidate: string) => {
        const current = remoteFiles.get(candidate);
        return current ? {
          eTag: current.entry.eTag,
          cTag: current.entry.cTag,
          size: current.entry.size,
          sha256Hash: current.entry.sha256Hash,
          driveId: current.entry.driveId,
          parentId: current.entry.parentId,
          mtime: current.entry.mtime,
        } : null;
      }),
      getDriveItemMetadataById,
      downloadFile,
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault: {
          configDir: ".obsidian",
          adapter,
          getAbstractFileByPath: vi.fn((candidate: string) =>
            localBytesByPath.has(candidate) ? new TFile(candidate) : null),
          getFileByPath: vi.fn().mockReturnValue(null),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          rename: vi.fn(),
        },
        inspectFile: vi.fn(async (candidate: string) => {
          const bytes = localBytesByPath.get(candidate);
          return bytes
            ? {
                status: "present" as const,
                entry: {
                  path: candidate,
                  hash: await sha256Hex(bytes),
                  size: bytes.byteLength,
                  mtime: 1,
                  binary: false,
                },
              }
            : { status: "missing" as const };
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const recover = (observationOnly = false) => {
      const epoch = (executor as unknown as {
        lifecycle: { capture(): number };
      }).lifecycle.capture();
      return (executor as unknown as {
        recoverMutationLedger(
          scope: SyncScope,
          metrics: undefined,
          operationEpoch: number,
          observationOnly: boolean,
        ): Promise<unknown>;
      }).recoverMutationLedger(scope, undefined, epoch, observationOnly);
    };
    const anchorForPath = () => {
      const envelope = state.getCommittedV2Envelope();
      return Object.values(envelope.anchors.byAnchorId).find(
        (anchor) => anchor.lastPath === path,
      );
    };
    return {
      executor,
      getDriveItemMetadataById,
      onedrive,
      recover,
      state,
      anchorForPath,
      path,
      oldRemoteId,
      newRemoteId,
      localHash,
    };
  }

  it("settles an unreceipted upload after a same-path identity replacement", async () => {
    const harness = await makeReplacedIdentityUploadHarness();
    const priorAnchorId = harness.anchorForPath()!.anchorId;

    await harness.recover();

    expect(harness.state.settleReplacedIdentityUploadResolved)
      .toHaveBeenCalledTimes(1);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingRemoteDeletes).toEqual([]);
    const anchor = harness.anchorForPath()!;
    expect(anchor.anchorId).toBe(priorAnchorId);
    expect(anchor.remoteId).toBe(harness.newRemoteId);
    expect(anchor.remoteETag).toBe("etag-new");
    expect(anchor.contentHash).toBe(harness.localHash);
    expect(anchor.remoteIdentityLineage).toEqual([expect.objectContaining({
      fromRemoteId: harness.oldRemoteId,
      toRemoteId: harness.newRemoteId,
      path: harness.path,
      contentHash: harness.localHash,
      fromRemoteETag: "etag-old",
      toRemoteETag: "etag-new",
      confirmedBy: "equal-read",
    })]);
    expect(harness.onedrive.uploadFile).not.toHaveBeenCalled();
    expect(harness.onedrive.deleteItem).not.toHaveBeenCalled();
  });

  it("retires a stale receipt and manual resolution without replaying them", async () => {
    const harness = await makeReplacedIdentityUploadHarness({
      withStaleReceipt: true,
      withStaleManualResolution: true,
    });

    await harness.recover();

    expect(harness.state.settleReplacedIdentityUploadResolved)
      .toHaveBeenCalledTimes(1);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.anchorForPath()!.remoteId).toBe(harness.newRemoteId);
    expect(harness.onedrive.uploadFile).not.toHaveBeenCalled();
  });

  it("keeps the record blocked when the replacement content differs", async () => {
    const harness = await makeReplacedIdentityUploadHarness({
      remoteContent: "different",
    });

    await expect(harness.recover()).rejects.toThrow();
    expect(harness.state.settleReplacedIdentityUploadResolved)
      .not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect(harness.anchorForPath()!.remoteId).toBe(harness.oldRemoteId);
  });

  it("does not rebind while the old identity still exists anywhere", async () => {
    const harness = await makeReplacedIdentityUploadHarness({
      oldIdentityPresentAtPath: "elsewhere.md",
    });

    await expect(harness.recover()).rejects.toThrow();
    expect(harness.state.settleReplacedIdentityUploadResolved)
      .not.toHaveBeenCalled();
    expect(harness.anchorForPath()!.remoteId).toBe(harness.oldRemoteId);
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect(harness.onedrive.uploadFile).not.toHaveBeenCalled();
  });

  it("fails closed when the new identity is anchored at another path", async () => {
    const harness = await makeReplacedIdentityUploadHarness({
      extraBasePaths: ["other.md"],
      staleFileAnchors: [
        { path: "note.md", remoteId: "old-id", eTag: "etag-old" },
        { path: "other.md", remoteId: "new-id", eTag: "etag-extra" },
      ],
    });

    await expect(harness.recover()).rejects.toThrow();
    expect(harness.state.settleReplacedIdentityUploadResolved)
      .not.toHaveBeenCalled();
    expect(harness.anchorForPath()!.remoteId).toBe(harness.oldRemoteId);
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("declines the state-only settle when a pending delete references another identity", async () => {
    const harness = await makeReplacedIdentityUploadHarness({
      pendingDeleteDriveId: "third-id",
    });

    await harness.recover();

    expect(harness.state.settleReplacedIdentityUploadResolved)
      .not.toHaveBeenCalled();
    expect(harness.state.pendingRemoteDeletes).toHaveLength(1);
  });

  it("declines the rebind while another ledger record depends on the path", async () => {
    const harness = await makeReplacedIdentityUploadHarness({
      dependentFolderAtRoot: true,
    });

    await expect(harness.recover()).rejects.toThrow();
    expect(harness.state.settleReplacedIdentityUploadResolved)
      .not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect(harness.state.mutationLedger[0].intent.operationId)
      .toBe("dependent-folder");
  });

  it("converges after an interruption between envelope publication and ledger retirement", async () => {
    const harness = await makeReplacedIdentityUploadHarness();
    const settle = vi.mocked(harness.state.settleReplacedIdentityUploadResolved)
      .getMockImplementation()!;
    let first = true;
    vi.mocked(harness.state.settleReplacedIdentityUploadResolved)
      .mockImplementation(async (args: never) => {
        if (first) {
          first = false;
          await harness.state.upsertBaseEntries([args.entry]);
          return true;
        }
        return settle(args);
      });

    await harness.recover();
    expect(harness.anchorForPath()!.remoteId).toBe(harness.newRemoteId);
    expect(harness.state.mutationLedger).toHaveLength(1);

    await harness.recover();
    expect(harness.state.mutationLedger).toEqual([]);
    const lineage = harness.anchorForPath()!.remoteIdentityLineage ?? [];
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatchObject({
      fromRemoteId: harness.oldRemoteId,
      toRemoteId: harness.newRemoteId,
    });
  });

  it("settles the state-only rebind during reset observation-only rounds", async () => {
    const harness = await makeReplacedIdentityUploadHarness();

    await harness.recover(true);

    expect(harness.state.settleReplacedIdentityUploadResolved)
      .toHaveBeenCalledTimes(1);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.anchorForPath()!.remoteId).toBe(harness.newRemoteId);
  });
});

describe("A1 one-shot content alignment for followed remote moves", () => {
  const oldBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer;
  const newBytes = new Uint8Array(
    Array.from({ length: 20 }, (_, index) => index + 1),
  ).buffer;
  const remoteNewEntry = (): RemoteFileEntry => ({
    path: "new.md",
    driveId: "drv-a",
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: newBytes.byteLength,
    mtime: 2,
    eTag: "etag-new",
    cTag: "ctag-new",
    sha256Hash: newBytesHash,
  });
  let oldBytesHash: string;
  let newBytesHash: string;

  async function makeAlignmentTestContext(options: {
    initialFiles: Array<[string, ArrayBuffer]>;
    initialRemoteEntries: RemoteFileEntry[];
    initialBaseEntries: BaseFileEntry[];
  }) {
    const diagError = vi.fn();
    const files = new Map(options.initialFiles.map(
      ([path, value]) => [path, value.slice(0)] as const,
    ));
    const uploadFile = vi.fn();
    const downloadFile = vi.fn().mockResolvedValue(newBytes.slice(0));
    const adapter = makeMockAdapter({
      read: vi.fn().mockImplementation(async (target: string) => {
        const value = files.get(target);
        return value ? new TextDecoder().decode(value) : "";
      }),
      write: vi.fn().mockImplementation(async (target: string, content: string) => {
        files.set(target, new TextEncoder().encode(content).buffer);
      }),
      writeBinary: vi.fn(async (target: string, content: ArrayBuffer) => {
        files.set(target, content.slice(0));
      }),
      exists: vi.fn().mockImplementation(async (target: string) =>
        files.has(target)),
      stat: vi.fn().mockImplementation(async (target: string) => {
        const value = files.get(target);
        return value ? { size: value.byteLength, mtime: 1 } : null;
      }),
      readBinary: vi.fn().mockImplementation(async (target: string) =>
        files.get(target)?.slice(0) ?? new ArrayBuffer(0)),
      rename: vi.fn().mockImplementation(async (
        source: string,
        target: string,
      ) => {
        const value = files.get(source);
        if (!value) throw new Error(`missing ${source}`);
        files.set(target, value.slice(0));
        files.delete(source);
      }),
      remove: vi.fn().mockImplementation(async (target: string) => {
        files.delete(target);
      }),
    });
    const mockOneDrive = makeMockOneDrive({
      uploadFile,
      downloadFile,
      getFileMetadata: vi.fn().mockImplementation(
        async (_vault: string, path: string) =>
          path === "new.md" ? remoteNewEntry() : null,
      ),
      getDelta: vi.fn().mockResolvedValue({
        value: [{
          id: "drv-a",
          name: "new.md",
          size: newBytes.byteLength,
          eTag: "etag-new",
          cTag: "ctag-new",
          lastModifiedDateTime: "2026-08-24T00:00:00.000Z",
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
          file: { hashes: { sha256Hash: newBytesHash } },
        }],
        "@odata.deltaLink": "tok",
      }),
    });
    const mockScanner = {
      vault: {
        adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
        getAbstractFileByPath: vi.fn().mockImplementation((path: string) =>
          files.has(path)
            ? Object.assign(new TFile({ path: "/" } as unknown as TFolder, path), {
                path,
              })
            : null),
        rename: vi.fn().mockImplementation(async (source: TFile, target: string) => {
          const value = files.get(source.path);
          if (!value) throw new Error(`missing ${source.path}`);
          files.set(target, value.slice(0));
          files.delete(source.path);
        }),
      },
      scanAll: vi.fn().mockImplementation(async () => {
        const entries = [];
        for (const [path, value] of files.entries()) {
          entries.push({
            path,
            hash: await sha256Hex(value),
            size: value.byteLength,
            mtime: 1,
            binary: false,
          });
        }
        return {
          entries,
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        };
      }),
      scanFile: vi.fn().mockResolvedValue(null),
      inspectFile: vi.fn().mockImplementation(async (target: string) => {
        const value = files.get(target);
        return value
          ? {
              status: "present",
              entry: {
                path: target,
                hash: await sha256Hex(value),
                size: value.byteLength,
                mtime: 1,
                binary: false,
              },
            }
          : { status: "missing" };
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;
    const state = makeActiveV2State(
      options.initialRemoteEntries,
      options.initialBaseEntries,
    );
    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      state,
      "testVault",
      undefined,
      undefined,
      {
        log: vi.fn(),
        warn: vi.fn(),
        error: diagError,
        setAdapter: vi.fn(),
      } as unknown as DiagnosticLogger,
    );
    return { executor, state, files, downloadFile, uploadFile, diagError };
  }

  beforeAll(async () => {
    oldBytesHash = await sha256Hex(oldBytes);
    newBytesHash = await sha256Hex(newBytes);
  });

  it("moves the local file and aligns its bytes to the moved+edited remote in one round", async () => {
    const context = await makeAlignmentTestContext({
      initialFiles: [["a.md", oldBytes]],
      initialRemoteEntries: [{
        path: "a.md",
        driveId: "drv-a",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: oldBytes.byteLength,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
        sha256Hash: oldBytesHash,
      }],
      initialBaseEntries: [{
        path: "a.md",
        hash: oldBytesHash,
        size: oldBytes.byteLength,
        eTag: "etag-old",
      }],
    });

    const result = await context.executor.run("manual", {});

    expect(result).toMatchObject({ success: true, conflicts: 0 });
    expect(result.filesMoved).toBe(1);
    expect(context.downloadFile).toHaveBeenCalledOnce();
    expect(context.files.has("a.md")).toBe(false);
    expect(context.files.has("new.md")).toBe(true);
    expect(await sha256Hex(context.files.get("new.md")!)).toBe(newBytesHash);
    expect(context.state.mutationLedger).toHaveLength(0);
    expect(context.state.baseSnapshot).toEqual([{
      path: "new.md",
      hash: newBytesHash,
      size: newBytes.byteLength,
      eTag: "etag-new",
    }]);
  });

  it("settles a stuck followed-path recovery record by aligning its bytes", async () => {
    const context = await makeAlignmentTestContext({
      // The stuck device already followed the remote path but still holds the
      // old bytes, exactly the receiving-side shape left by the 1.3.8 A1
      // regression (local move executed, mutation receipt rejected).
      initialFiles: [["new.md", oldBytes]],
      initialRemoteEntries: [remoteNewEntry()],
      initialBaseEntries: [],
    });
    context.state.mutationLedger.push({
      intent: {
        version: 1,
        operationId: "op-stuck-move",
        planRevision: 0,
        scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
        action: "moveLocal" as const,
        path: "new.md",
        sourcePath: "a.md",
        expectedLocal: {
          exists: true as const,
          hash: oldBytesHash,
          size: oldBytes.byteLength,
        },
        expectedRemote: {
          exists: true as const,
          driveId: "drv-a",
          eTag: "etag-new",
          size: newBytes.byteLength,
          sha256Hash: newBytesHash,
        },
        createdAt: 1,
      },
      receipt: null,
    });

    const result = await context.executor.run("manual", {});

    // The recovery chain aligned and settled the stuck record in the same
    // round: ledger empty, local bytes newest, base bound, and the stale
    // pre-recovery scan was not allowed to upload old bytes over the remote.
    expect(context.state.mutationLedger).toHaveLength(0);
    expect(await sha256Hex(context.files.get("new.md")!)).toBe(newBytesHash);
    expect(context.state.baseSnapshot).toEqual([{
      path: "new.md",
      hash: newBytesHash,
      size: newBytes.byteLength,
      eTag: "etag-new",
    }]);
    expect(result.uploaded).toBe(0);
    expect(context.uploadFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
  });
});

describe("OneDrive-invalid-name unreceipted upload recovery", () => {
  async function makeInvalidNameUploadHarness(localPresent: boolean) {
    const path = "Learn English/New Concept 2/第25课：Do the English speak english?.md";
    const localContent = "local content";
    const encoder = new TextEncoder();
    const localBytes = encoder.encode(localContent).buffer;
    const localHash = await sha256Hex(localBytes);
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };

    const localBytesByPath = new Map<string, ArrayBuffer>();
    if (localPresent) localBytesByPath.set(path, localBytes);
    const adapter = makeMockAdapter({
      exists: vi.fn(async (candidate: string) =>
        localBytesByPath.has(candidate)),
      stat: vi.fn(async (candidate: string) => {
        const bytes = localBytesByPath.get(candidate);
        return bytes
          ? { type: "file", size: bytes.byteLength, mtime: 1, ctime: 1 }
          : null;
      }),
      readBinary: vi.fn(async (candidate: string) => {
        const bytes = localBytesByPath.get(candidate);
        if (!bytes) throw new Error(`missing local: ${candidate}`);
        return bytes.slice(0);
      }),
    });

    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "invalid-name-upload",
      planRevision: 1,
      scope,
      action: "upload",
      path,
      expectedLocal: {
        exists: true,
        hash: localHash,
        size: localBytes.byteLength,
      },
      // This name can never exist remotely: Graph rejects it with 400 even
      // when the URL is correctly encoded.
      expectedRemote: { exists: false },
      createdAt: 1,
    };
    const ledger: MutationLedgerEntryV1[] = [{
      intent,
      receipt: null,
    }];

    const state = makeActiveV2State([], [], { mutationLedger: ledger });
    // Real Graph behavior for an invalid name: every request returns 400 and
    // getFileMetadata only converts 404 into null, so every observation for
    // this path would throw and block recovery forever.
    const onedrive = makeMockOneDrive({
      getFileMetadata: vi.fn(async () => {
        throw new OneDriveError(
          OneDriveErrorType.Unknown,
          "nameContainsInvalidCharacters",
          400,
        );
      }),
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault: {
          configDir: ".obsidian",
          adapter,
          getAbstractFileByPath: vi.fn((candidate: string) =>
            localBytesByPath.has(candidate) ? new TFile(candidate) : null),
          getFileByPath: vi.fn().mockReturnValue(null),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          rename: vi.fn(),
        },
        inspectFile: vi.fn(async (candidate: string) => {
          const bytes = localBytesByPath.get(candidate);
          return bytes
            ? {
                status: "present" as const,
                entry: {
                  path: candidate,
                  hash: await sha256Hex(bytes),
                  size: bytes.byteLength,
                  mtime: 1,
                  binary: false,
                },
              }
            : { status: "missing" as const };
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const recover = (observationOnly = false) => {
      const epoch = (executor as unknown as {
        lifecycle: { capture(): number };
      }).lifecycle.capture();
      return (executor as unknown as {
        recoverMutationLedger(
          scope: SyncScope,
          metrics: undefined,
          operationEpoch: number,
          observationOnly: boolean,
        ): Promise<unknown>;
      }).recoverMutationLedger(scope, undefined, epoch, observationOnly);
    };
    return { executor, onedrive, recover, state, path };
  }

  it("settles an unreceipted upload targeting an OneDrive-invalid name with zero Graph requests", async () => {
    const harness = await makeInvalidNameUploadHarness(true);
    expect(harness.state.mutationLedger).toHaveLength(1);

    const summary = await harness.recover();

    // The intent can never have been applied, so it settles as not-applied
    // without any local or remote observation — the 400 that used to throw
    // out of classification and block every round is never issued.
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.onedrive.getFileMetadata).not.toHaveBeenCalled();
    expect(summary).toEqual(
      expect.objectContaining({ state: "settled", remaining: 0 }),
    );
  });

  it("settles the same intent even after the user deleted the local file", async () => {
    const harness = await makeInvalidNameUploadHarness(false);
    expect(harness.state.mutationLedger).toHaveLength(1);

    const summary = await harness.recover();

    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.onedrive.getFileMetadata).not.toHaveBeenCalled();
    expect(summary).toEqual(
      expect.objectContaining({ state: "settled", remaining: 0 }),
    );
  });

  it("settles the same intent in observation-only reset preflight rounds", async () => {
    const harness = await makeInvalidNameUploadHarness(true);

    const summary = await harness.recover(true);

    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.onedrive.getFileMetadata).not.toHaveBeenCalled();
    expect(summary).toEqual(
      expect.objectContaining({ state: "settled", remaining: 0 }),
    );
  });
});

