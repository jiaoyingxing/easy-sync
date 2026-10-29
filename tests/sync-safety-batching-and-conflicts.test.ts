// 批量、去重与冲突结算
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import * as obsidian from "obsidian";
import {
  TFile,
} from "obsidian";
import {
  sha256Hex,
} from "../src/crypto";
import {
  getEasySyncPaths,
} from "../src/obsidian-compat";
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

describe("Remote sha256 dedup", () => {
  function makePendingConflictStore(initial: SyncPlanItem[]) {
    const pendingConflicts = initial.map((item) => ({ ...item }));
    const upsertPendingConflicts = vi.fn(async (items: SyncPlanItem[]) => {
      for (const item of items) {
        const index = pendingConflicts.findIndex((current) => current.path === item.path);
        if (index >= 0) pendingConflicts[index] = item;
        else pendingConflicts.push(item);
      }
    });
    const prunePendingConflicts = vi.fn(async (paths: Iterable<string>) => {
      const active = new Set(paths);
      pendingConflicts.splice(
        0,
        pendingConflicts.length,
        ...pendingConflicts.filter((item) => active.has(item.path)),
      );
    });
    return {
      pendingConflicts,
      upsertPendingConflicts,
      prunePendingConflicts,
    };
  }

  it("retries an unchanged pending conflict that has never completed byte comparison", async () => {
    const path = "quickadd-main.js";
    const content = new TextEncoder().encode("same plugin code").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "item-quickadd",
      size: content.byteLength,
      mtime: 2,
      eTag: "etag-quickadd",
      cTag: "ctag-quickadd",
    };
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      reason: "reason.newFileBothSides",
    };
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([conflict]);
    const state = makeActiveV2State([remote], [], pendingStore);

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
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(state.baseSnapshot).toEqual([{
      path,
      hash,
      size: content.byteLength,
      eTag: remote.eTag,
    }]);
    expect(pendingStore.pendingConflicts).toEqual([]);
    expect(result.conflicts).toBe(0);
  });

  it("does not redownload an unchanged pending conflict with a version-bound different receipt", async () => {
    const path = "quickadd-main.js";
    const local: LocalFileEntry = {
      path,
      size: 16,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "item-quickadd",
      size: 16,
      mtime: 2,
      eTag: "etag-quickadd",
      cTag: "ctag-quickadd",
    };
    const conflict = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      reason: "reason.newFileBothSides",
      contentComparison: {
        version: 1,
        result: "different",
        localHash: local.hash,
        localSize: local.size,
        remoteDriveId: remote.driveId,
        remoteETag: remote.eTag,
        remoteSize: remote.size,
        remoteHash: "bb".repeat(32),
      },
    } as SyncPlanItem;
    const downloadFile = vi.fn();
    const establishedLocal: LocalFileEntry = {
      path: "established.md",
      hash: "cc".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    const establishedRemote: RemoteFileEntry = {
      path: establishedLocal.path,
      driveId: "established-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: establishedLocal.size,
      mtime: 1,
      eTag: "etag-established",
      cTag: "",
      sha256Hash: establishedLocal.hash,
    };
    const pendingStore = makePendingConflictStore([conflict]);
    const state = makeActiveV2State(
      [remote, establishedRemote],
      [{
        path: establishedLocal.path,
        hash: establishedLocal.hash,
        size: establishedLocal.size,
        eTag: establishedRemote.eTag,
      }],
      pendingStore,
    );

    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local, establishedLocal],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          candidatePath === path ? local : establishedLocal),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});

    expect(downloadFile).not.toHaveBeenCalled();
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        path,
        contentComparison: conflict.contentComparison,
      }),
    ]);
    expect(result.conflicts).toBe(1);
  });

  it("persists a byte-difference receipt so the next round does not download the same versions again", async () => {
    const path = "real-conflict.bin";
    const localContent = new TextEncoder().encode("local-content").buffer;
    const remoteContent = new TextEncoder().encode("remote-conten").buffer;
    expect(localContent.byteLength).toBe(remoteContent.byteLength);
    const local: LocalFileEntry = {
      path,
      size: localContent.byteLength,
      mtime: 1,
      hash: await sha256Hex(localContent),
      binary: true,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "real-conflict-id",
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-real-conflict",
      cTag: "ctag-real-conflict",
    };
    const base: BaseFileEntry = {
      path,
      hash: "cc".repeat(32),
      size: local.size,
      eTag: "etag-before-conflict",
    };
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      reason: "reason.bothSidesModified",
    };
    const pendingStore = makePendingConflictStore([]);
    const downloadFile = vi.fn().mockResolvedValue(remoteContent);
    const state = makeActiveV2State([remote], [base], pendingStore);
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
          entries: [local],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const first = await executor.run("manual", {});
    const second = await executor.run("manual", {});

    expect(first.conflicts).toBe(1);
    expect(second.conflicts).toBe(1);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(pendingStore.pendingConflicts).toEqual([
      expect.objectContaining({
        path,
        contentComparison: expect.objectContaining({
          version: 1,
          result: "different",
          localHash: local.hash,
          remoteDriveId: remote.driveId,
          remoteETag: remote.eTag,
          remoteHash: await sha256Hex(remoteContent),
        }),
      }),
    ]);
  });

  it("refreshes verification download URLs through one batch when the conflict candidate needs a byte comparison", async () => {
    // Knife-1/2 executor wiring (2026-09-08): the canonical planner hands the
    // budgeted verification download set to an injected batch refresh before
    // downloading, so a same-size hashless conflict probe downloads through
    // the refreshed URL instead of paying a per-file waterfall metadata round
    // trip. This test pins that the main executor finalize call site really
    // passes the hook through — planner-level behavior is covered separately
    // in canonical-plan-v2.test.ts.
    const path = "wired-conflict.bin";
    const localContent = new TextEncoder().encode("local-wired!").buffer;
    const remoteContent = new TextEncoder().encode("remote-wired").buffer;
    expect(localContent.byteLength).toBe(remoteContent.byteLength);
    const local: LocalFileEntry = {
      path,
      size: localContent.byteLength,
      mtime: 1,
      hash: await sha256Hex(localContent),
      binary: true,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "wired-conflict-id",
      size: remoteContent.byteLength,
      mtime: 2,
      eTag: "etag-wired-conflict",
      cTag: "ctag-wired-conflict",
    };
    const base: BaseFileEntry = {
      path,
      hash: "cc".repeat(32),
      size: local.size,
      eTag: "etag-before-wired",
    };
    const pendingStore = makePendingConflictStore([]);
    const downloadFile = vi.fn().mockResolvedValue(remoteContent);
    const refreshedUrl = "https://download.example/refreshed-wired";
    const refreshedReasons: string[] = [];
    const refreshedIds: string[][] = [];
    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
    ) => {
      refreshedIds.push([...ids]);
      if (reason) refreshedReasons.push(reason);
      return new Map(ids.map((id) => [id, id === remote.driveId
        ? {
            id,
            eTag: remote.eTag,
            file: {},
            parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
            "@microsoft.graph.downloadUrl": refreshedUrl,
          }
        : null]));
    });
    const state = makeActiveV2State([remote], [base], pendingStore);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDriveItemMetadataByIds,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
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
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    // The verification download still happened exactly once and produced the
    // same conflict + byte-difference receipt as the unbatched path…
    expect(result.conflicts).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    // …but the download carried the batched URL (single metadata refresh for
    // the probe, no per-file waterfall), and the refresh was attributed to
    // the content-verification bucket.
    expect(refreshedIds).toEqual([[remote.driveId]]);
    expect(refreshedReasons).toEqual(["contentVerificationRefresh"]);
    const wiredCall = downloadFile.mock.calls[0];
    expect(wiredCall[2]).toBe(refreshedUrl);
    expect(pendingStore.pendingConflicts).toEqual([
      expect.objectContaining({
        path,
        contentComparison: expect.objectContaining({
          result: "different",
          remoteDriveId: remote.driveId,
          remoteHash: await sha256Hex(remoteContent),
        }),
      }),
    ]);
  });

  it("resolves identical new binary files without downloading remote content", async () => {
    const path = "recording.m4a";
    const hash = "14731cbf60b9c1b219e31ab5a1b71bda45a0a4c3f137c0e0fa7f4ca1ad54a069";
    const local: LocalFileEntry = {
      path,
      size: 42534604,
      mtime: 1,
      hash,
      binary: true,
    };
    const downloadFile = vi.fn();
    const state = makeActiveV2State([], []);

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [
            {
              id: "item-recording",
              name: "recording.m4a",
              size: 42534604,
              eTag: "etag-recording",
              cTag: "ctag-recording",
              lastModifiedDateTime: "2026-07-08T14:48:59.000Z",
              parentReference: {
                id: TEST_SYNC_SCOPE.filesRootId,
                path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
              },
              file: {
                mimeType: "audio/mp4",
                hashes: {
                  sha256Hash: hash.toUpperCase(),
                },
              },
            },
          ],
          "@odata.deltaLink": "tok",
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
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([
      {
        path,
        hash,
        size: 42534604,
        eTag: "etag-recording",
      },
    ]);
  });

  it("resolves every metadata-hash match even when there are more than ten", async () => {
    const hash = "ab".repeat(32);
    const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.bin`);
    const localEntries: LocalFileEntry[] = paths.map((path) => ({
      path,
      size: 16,
      mtime: 1,
      hash,
      binary: true,
    }));
    const downloadFile = vi.fn();
    const state = makeActiveV2State([], []);
    const remoteItems: DriveItem[] = paths.map((path, index) => ({
      id: `item-${index}`,
      name: path,
      size: 16,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        id: TEST_SYNC_SCOPE.filesRootId,
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: { hashes: { sha256Hash: hash.toUpperCase() } },
    }));

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({ value: remoteItems, "@odata.deltaLink": "tok" }),
      }),
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toHaveLength(20);
    expect(state.baseSnapshot.every((entry) => entry.hash === hash)).toBe(true);
  });

  it("absorbs an eTag-only remote change without downloading identical content", async () => {
    const path = "recording.m4a";
    const hash = "cd".repeat(32);
    const local: LocalFileEntry = {
      path,
      size: 1024,
      mtime: 1,
      hash,
      binary: true,
    };
    const base: BaseFileEntry = {
      path,
      hash,
      size: 1024,
      eTag: "upload-etag-v1",
    };
    const remoteBeforeDelta: RemoteFileEntry = {
      path,
      driveId: "recording-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1024,
      mtime: 1,
      eTag: base.eTag,
      cTag: "ctag-v1",
      sha256Hash: hash,
    };
    const downloadFile = vi.fn();
    const state = makeActiveV2State([remoteBeforeDelta], [base]);

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [
            {
              id: "recording-id",
              name: "recording.m4a",
              size: 1024,
              eTag: "delta-etag-v2",
              cTag: "ctag",
              lastModifiedDateTime: "2026-07-10T12:00:00.000Z",
              parentReference: {
                id: TEST_SYNC_SCOPE.filesRootId,
                path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
              },
              file: { hashes: { sha256Hash: hash.toUpperCase() } },
            },
          ],
          "@odata.deltaLink": "tok",
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
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([{
      path,
      hash,
      size: 1024,
      eTag: "delta-etag-v2",
    }]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path,
        driveId: remoteBeforeDelta.driveId,
        eTag: "delta-etag-v2",
        sha256Hash: hash,
      }),
    ]);
  });

  it("reconciles one eTag-only change while an unrelated path remains a conflict", async () => {
    const equalHash = "21".repeat(32);
    const baseConflictHash = "43".repeat(32);
    const localConflictHash = "65".repeat(32);
    const remoteConflictHash = "87".repeat(32);
    const equalLocal: LocalFileEntry = {
      path: "equal-after-etag.bin",
      size: 10,
      mtime: 1,
      hash: equalHash,
      binary: true,
    };
    const conflictLocal: LocalFileEntry = {
      path: "independent-conflict.bin",
      size: 12,
      mtime: 2,
      hash: localConflictHash,
      binary: true,
    };
    const equalRemote: RemoteFileEntry = {
      path: equalLocal.path,
      driveId: "equal-after-etag-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: equalLocal.size,
      mtime: 1,
      eTag: "equal-etag-v1",
      cTag: "equal-ctag-v1",
      sha256Hash: equalHash,
    };
    const conflictRemote: RemoteFileEntry = {
      path: conflictLocal.path,
      driveId: "independent-conflict-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: conflictLocal.size,
      mtime: 1,
      eTag: "conflict-etag-v1",
      cTag: "conflict-ctag-v1",
      sha256Hash: baseConflictHash,
    };
    const equalBase: BaseFileEntry = {
      path: equalRemote.path,
      hash: equalHash,
      size: equalRemote.size,
      eTag: equalRemote.eTag,
    };
    const conflictBase: BaseFileEntry = {
      path: conflictRemote.path,
      hash: baseConflictHash,
      size: conflictRemote.size,
      eTag: conflictRemote.eTag,
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [equalRemote, conflictRemote],
      [equalBase, conflictBase],
      { upsertPendingConflicts },
    );
    const downloadFile = vi.fn();
    const oneDrive = makeMockOneDrive({
      downloadFile,
      getDelta: vi.fn().mockResolvedValue({
        value: [
          {
            id: equalRemote.driveId,
            name: equalRemote.path,
            size: equalRemote.size,
            eTag: "equal-etag-v2",
            cTag: "equal-ctag-v2",
            lastModifiedDateTime: "2026-07-10T12:00:00.000Z",
            parentReference: {
              id: TEST_SYNC_SCOPE.filesRootId,
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: equalHash.toUpperCase() } },
          },
          {
            id: conflictRemote.driveId,
            name: conflictRemote.path,
            size: conflictRemote.size,
            eTag: "conflict-etag-v2",
            cTag: "conflict-ctag-v2",
            lastModifiedDateTime: "2026-07-10T12:00:01.000Z",
            parentReference: {
              id: TEST_SYNC_SCOPE.filesRootId,
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: {
              hashes: { sha256Hash: remoteConflictHash.toUpperCase() },
            },
          },
        ],
        "@odata.deltaLink": "tok",
      }),
    });
    const localEntries = [equalLocal, conflictLocal];
    const executor = new SyncExecutor(
      oneDrive,
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(oneDrive.uploadFile).not.toHaveBeenCalled();
    expect(oneDrive.deleteItem).not.toHaveBeenCalled();
    expect(state.baseSnapshot).toEqual([
      {
        ...equalBase,
        eTag: "equal-etag-v2",
      },
      conflictBase,
    ]);
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: conflictLocal.path,
      }),
    ]);
  });

  it("downloads every candidate during bootstrap when remote metadata has no sha256", async () => {
    const content = new TextEncoder().encode("same attachment content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from({ length: 20 }, (_, index) => `no-hash-${index}.bin`);
    const localEntries: LocalFileEntry[] = paths.map((path) => ({
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: true,
    }));
    const remoteEntries: RemoteFileEntry[] = paths.map((path, index) => ({
      path,
      driveId: `no-hash-${index}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 2,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
    }));
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State(remoteEntries, [], {
      ...pendingStore,
      lastSyncTime: 0,
    });

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = paths.indexOf(path);
            return Promise.resolve(index >= 0 ? {
              driveId: `no-hash-${index}`,
              size: content.byteLength,
              mtime: 1,
              eTag: `etag-${index}`,
            } : null);
          },
        ),
      }),
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(20);
    expect(state.baseSnapshot).toHaveLength(20);
    expect(pendingStore.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(0);
  });

  it("retains a proven QuickXor mismatch during bootstrap without downloading it", async () => {
    const path = "quickxor-mismatch.bin";
    const item: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local: {
        path,
        size: 8,
        mtime: 1,
        hash: "aa".repeat(32),
        quickXorHash: "local-quickxor",
        binary: true,
      },
      remote: {
        path,
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: 8,
        mtime: 2,
        eTag: "etag-remote",
        cTag: "ctag-remote",
        quickXorHash: "remote-quickxor",
      },
      reason: "reason.newFileBothSides",
    };
    const downloadFile = vi.fn();
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State([item.remote!], [], {
      ...pendingStore,
      lastSyncTime: 0,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [item.local!],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(item.local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).not.toHaveBeenCalled();
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({ path }),
    ]);
    expect(pendingStore.upsertPendingConflicts.mock.calls[0]![0]![0]).not.toHaveProperty(
      "contentComparison",
    );
    expect(result.conflicts).toBe(1);
  });

  it("finishes byte comparison for every unseeded path while rebuilding an empty base", async () => {
    const content = new TextEncoder().encode("same reset content").buffer;
    const hash = await sha256Hex(content);
    const seededPath = "seeded.md";
    const unseededPaths = Array.from(
      { length: 11 },
      (_, index) => `reset-no-hash-${index}.bin`,
    );
    const allPaths = [seededPath, ...unseededPaths];
    const localEntries: LocalFileEntry[] = allPaths.map((path) => ({
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: path !== seededPath,
    }));
    const remoteEntries: RemoteFileEntry[] = [
      {
        path: seededPath,
        driveId: "seeded-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: content.byteLength,
        mtime: 1,
        eTag: "etag-seeded",
        cTag: "ctag-seeded",
        sha256Hash: hash,
      },
      ...unseededPaths.map((path, index) => ({
        path,
        driveId: `reset-no-hash-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: content.byteLength,
        mtime: 1,
        eTag: `etag-reset-${index}`,
        cTag: `ctag-reset-${index}`,
      })),
    ];
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State(remoteEntries, [], {
      ...pendingStore,
      lastSyncTime: 0,
    });

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = unseededPaths.indexOf(path);
            return Promise.resolve(index >= 0 ? {
              driveId: `reset-no-hash-${index}`,
              size: content.byteLength,
              mtime: 1,
              eTag: `etag-reset-${index}`,
            } : null);
          },
        ),
      }),
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(unseededPaths.length);
    expect(state.baseSnapshot).toHaveLength(allPaths.length);
    expect(pendingStore.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(0);
  });

  it("continues an interrupted reset reconstruction after some equal bases were already persisted", async () => {
    const content = new TextEncoder().encode("same legacy pending content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from(
      { length: 11 },
      (_, index) => `legacy-pending-${index}.bin`,
    );
    const conflicts: SyncPlanItem[] = paths.map((path, index) => ({
      type: SyncActionType.Conflict,
      path,
      local: {
        path,
        size: content.byteLength,
        mtime: 1,
        hash,
        binary: true,
      },
      remote: {
        path,
        driveId: `legacy-pending-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: content.byteLength,
        mtime: 2,
        eTag: `etag-legacy-pending-${index}`,
        cTag: `ctag-legacy-pending-${index}`,
      },
      reason: "reason.newFileBothSides",
    }));
    const reconciledLocal: LocalFileEntry = {
      path: "already-reconciled.md",
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const reconciledRemote: RemoteFileEntry = {
      path: reconciledLocal.path,
      driveId: "already-reconciled-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 1,
      eTag: "etag-already-reconciled",
      cTag: "",
      sha256Hash: hash,
    };
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore(conflicts);
    const state = makeActiveV2State(
      [reconciledRemote, ...conflicts.map((item) => item.remote!)],
      [{
        path: reconciledLocal.path,
        hash,
        size: content.byteLength,
        eTag: reconciledRemote.eTag,
      }],
      {
        ...pendingStore,
        // A partial reconstruction has already committed some equal bases,
        // but the first fully healthy round has not completed yet.
        lastSyncTime: 0,
      },
    );

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = paths.indexOf(path);
            return Promise.resolve(index >= 0 ? conflicts[index].remote : null);
          },
        ),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [reconciledLocal, ...conflicts.map((item) => item.local!)],
          folders: [],
          folderScanComplete: true,
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          candidatePath === reconciledLocal.path
            ? reconciledLocal
            : conflicts.find((item) => item.path === candidatePath)?.local ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(paths.length);
    expect(state.baseSnapshot).toHaveLength(paths.length + 1);
    expect(pendingStore.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(pendingStore.pendingConflicts).toEqual([]);
    expect(result.conflicts).toBe(0);
  });

  it("keeps a conflict when the remote version changes during hash dedup download", async () => {
    const path = "raced.bin";
    const content = new TextEncoder().encode("same before remote race").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: true,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "raced-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 2,
      eTag: "etag-before",
      cTag: "ctag-before",
    };
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State([remote], [], {
      ...pendingStore,
      lastSyncTime: 0,
    });

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(content),
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: remote.driveId,
          size: remote.size,
          mtime: 3,
          eTag: "etag-after",
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
        scanFile: vi.fn().mockResolvedValue(local),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(state.baseSnapshot).toEqual([]);
    // 计划步落地 ＋ 轮末 owner：同一行按路径 upsert 两次（2026-10-18 第五刀），
    // 两次都是整批写，逐文件写仍不存在。
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledTimes(2);
    expect(pendingStore.upsertPendingConflicts.mock.calls.map(
      ([items]) => (items as SyncPlanItem[]).map((item) => item.path),
    )).toEqual([[path], [path]]);
    expect(pendingStore.pendingConflicts).toEqual([
      expect.objectContaining({ path }),
    ]);
    expect(result.conflicts).toBe(1);
  });

  it("caps download-based hash dedup at ten candidates for an established vault", async () => {
    const content = new TextEncoder().encode("same attachment content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from({ length: 11 }, (_, index) => `established-${index}.bin`);
    const localEntries: LocalFileEntry[] = paths.map((path) => ({
      path,
      size: content.byteLength,
      mtime: 1,
      hash,
      binary: true,
    }));
    const remoteEntries: RemoteFileEntry[] = paths.map((path, index) => ({
      path,
      driveId: `established-${index}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: content.byteLength,
      mtime: 1,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
    }));
    const downloadFile = vi.fn().mockResolvedValue(content);
    const pendingStore = makePendingConflictStore([]);
    const state = makeActiveV2State(
      remoteEntries,
      [{
        path: paths[0],
        hash: "00".repeat(32),
        size: content.byteLength,
        eTag: "etag-old",
      }],
      {
        ...pendingStore,
        lastSyncTime: 1,
      },
    );

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockImplementation(
          (_vaultName: string, path: string) => {
            const index = paths.indexOf(path);
            return Promise.resolve(index >= 0 ? {
              driveId: `established-${index}`,
              size: content.byteLength,
              mtime: 1,
              eTag: `etag-${index}`,
            } : null);
          },
        ),
      }),
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockImplementation(async (candidatePath: string) =>
          localEntries.find((entry) => entry.path === candidatePath) ?? null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(10);
    expect(state.baseSnapshot).toHaveLength(10);
    // 计划步落地 ＋ 轮末 owner（同一行，按路径幂等）。
    expect(pendingStore.upsertPendingConflicts).toHaveBeenCalledTimes(2);
    expect(pendingStore.pendingConflicts).toHaveLength(1);
    expect(result.conflicts).toBe(1);
  });
});

describe("Pending item batching", () => {
  it("adds decision tokens before a pending plan is paused for review", async () => {
    const local: LocalFileEntry = {
      path: "reviewed.md",
      size: 8,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const base: BaseFileEntry = {
      path: local.path,
      size: local.size,
      hash: "bb".repeat(32),
      eTag: "etag-old",
    };
    const newLocal: LocalFileEntry = {
      path: "new-upload.md",
      size: 8,
      mtime: 1,
      hash: "cc".repeat(32),
      binary: false,
    };
    const mockState = makeActiveV2State([], [base], {
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      setLastSyncTimeAndIncrementGeneration: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const onConfirmThreshold = vi.fn().mockResolvedValue(false);
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local, newLocal],
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

    const result = await executor.run("manual", { onConfirmThreshold });

    expect(result.message).toBe("result.pausedForReview");
    // Structured flag (finding ⑥): the pause is recorded on runFacts, not
    // inferred from the localised message by the caller.
    expect(result.runFacts?.planReviewPaused).toBe(true);
    expect(onConfirmThreshold).toHaveBeenCalledWith(expect.objectContaining({
      items: expect.arrayContaining([expect.objectContaining({
        path: local.path,
        decisionToken: expect.objectContaining({
          version: 1,
          vaultName: "testVault",
          accountId: "account-id",
          ancestorHash: base.hash,
        }),
      })]),
    }));
  });

  it("proceeds without pausing when an automatic sync hits the threshold gate (direction 3, finding ⑨)", async () => {
    // User decision 2026-09-02 direction 3: the threshold review only
    // applies to manual/first sync. Automatic sync executes the large plan
    // and records the structured thresholdSkippedInAuto flag so the caller
    // can show a one-line summary notice instead of the durable review flow.
    const local: LocalFileEntry = {
      path: "reviewed.md",
      size: 8,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const base: BaseFileEntry = {
      path: local.path,
      size: local.size,
      hash: "bb".repeat(32),
      eTag: "etag-old",
    };
    const newLocal: LocalFileEntry = {
      path: "new-upload.md",
      size: 8,
      mtime: 1,
      hash: "cc".repeat(32),
      binary: false,
    };
    const mockState = makeActiveV2State([], [base], {
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      setLastSyncTimeAndIncrementGeneration: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    });
    const onConfirmThreshold = vi.fn().mockResolvedValue(false);
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local, newLocal],
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

    const result = await executor.run("auto", { onConfirmThreshold });

    // No pause, no threshold callback, no localised pause message: the plan
    // proceeds to execution and the run records the flag. In this fixture the
    // plan items land as pending conflicts (conflictsPending) — that is the
    // ordinary post-gate execution outcome, not a threshold pause.
    expect(onConfirmThreshold).not.toHaveBeenCalled();
    expect(result.message).not.toBe("result.pausedForReview");
    expect(result.runFacts?.planReviewPaused).not.toBe(true);
    expect(result.runFacts?.thresholdSkippedInAuto).toBe(true);
    expect(result.success).toBe(true);
  });

  it("persists a large conflict plan through one batch call", async () => {
    const localEntries = Array.from({ length: 1000 }, (_, index): LocalFileEntry => ({
      path: `conflict-${index}.md`,
      size: 1,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    }));
    const remoteEntries = localEntries.map((local, index): RemoteFileEntry => ({
      path: local.path,
      driveId: `remote-${index}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 2,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      sha256Hash: "bb".repeat(32),
    }));
    const addPendingConflict = vi.fn();
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State(remoteEntries, [], {
      addPendingConflict,
      upsertPendingConflicts,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      setLastSyncTimeAndIncrementGeneration: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
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

    expect(result.conflicts).toBe(1000);
    // 两个写点各一次整批写（计划步落地 ＋ 轮末 owner）：两次都是整批、行集合一致
    // ——逐文件写仍不存在，本用例保护的正是这一点。
    expect(upsertPendingConflicts).toHaveBeenCalledTimes(2);
    const expectedPaths = localEntries
      .map((item) => item.path)
      .sort((left, right) => left.localeCompare(right));
    for (const [items] of upsertPendingConflicts.mock.calls) {
      const persisted = items as SyncPlanItem[];
      expect(persisted.map((item) => item.path)).toEqual(expectedPaths);
      expect(persisted.every((item) => item.decisionToken?.version === 1)).toBe(true);
    }
    expect(addPendingConflict).not.toHaveBeenCalled();
  });
});

describe("Pending conflict cleanup", () => {
  it("clears stale pending conflicts when the current healthy plan has none", async () => {
    const pendingConflicts: SyncPlanItem[] = [
      {
        type: SyncActionType.Conflict,
        path: "stale.md",
        reason: "reason.bothSidesModified",
      },
    ];
    const prunePendingConflicts = vi.fn(async (activePaths: Iterable<string>) => {
      const active = new Set(activePaths);
      pendingConflicts.splice(
        0,
        pendingConflicts.length,
        ...pendingConflicts.filter((item) => active.has(item.path)),
      );
    });
    const state = makeActiveV2State([], [], {
      pendingConflicts,
      async prunePendingConflicts(activePaths: Iterable<string>) {
        await prunePendingConflicts(activePaths);
      },
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
          folderScanFailures: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(0);
    expect(prunePendingConflicts).toHaveBeenCalledWith([]);
    expect(pendingConflicts).toHaveLength(0);
  });

  it("keeps pending conflicts when the current scan is unhealthy", async () => {
    const pendingConflicts: SyncPlanItem[] = [
      {
        type: SyncActionType.Conflict,
        path: "keep.md",
        reason: "reason.bothSidesModified",
      },
    ];
    const prunePendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State([], [], {
      pendingConflicts,
      prunePendingConflicts,
    });
    const getDelta = vi.fn();

    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
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
          failedPaths: ["keep.md"],
          skippedCount: 0,
          complete: false,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.message).toBe("result.scanIncomplete");
    expect(getDelta).not.toHaveBeenCalled();
    expect(prunePendingConflicts).not.toHaveBeenCalled();
    expect(pendingConflicts).toHaveLength(1);
  });
});

describe("Conflict resolution actions report standalone transfer progress", () => {
  async function waitUntil(assertion: () => void, attempts = 20): Promise<void> {
    let lastError: unknown;
    for (let index = 0; index < attempts; index++) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    throw lastError;
  }

  function makeProgressAwareExecutor(options: {
    downloadFile?: ReturnType<typeof vi.fn>;
    uploadFile?: ReturnType<typeof vi.fn>;
    deleteItem?: ReturnType<typeof vi.fn>;
    pendingConflicts?: SyncPlanItem[];
    pendingRemoteDeletes?: SyncPlanItem[];
    adapterOverrides?: Record<string, unknown>;
    scanFile?: ReturnType<typeof vi.fn>;
    inspectFile?: ReturnType<typeof vi.fn>;
    stateOverrides?: Record<string, unknown>;
    fileManager?: Record<string, unknown>;
    vaultFile?: unknown;
    getFileMetadata?: ReturnType<typeof vi.fn>;
    getDriveItemMetadataById?: ReturnType<typeof vi.fn>;
    initVaultScope?: ReturnType<typeof vi.fn>;
    preserveMissingDecisionTokens?: boolean;
    onProgressUpdate?: () => void;
    progressStore?: SyncProgressStore;
    diag?: DiagnosticLogger;
    noticeCenter?: EasySyncNoticeCenter;
    shouldSyncPath?: ReturnType<typeof vi.fn>;
    i18n?: I18n;
    /** 给了就模拟真实宿主：它认得被替换的文件，并且自己有写入面。
     *  值模拟打开着的编辑器把这段未保存文本合并回磁盘（宿主在我们写入之后又追加）。 */
    hostEditorMerge?: string;
    /** 写入面「静默失败」：接口正常返回但磁盘没变（`DECISIONS` 2026-09-23 第 9 点④的现场）。 */
    hostWriteSilent?: boolean;
    /** 宿主写入面的内容变换：模拟「写坏」（只落一部分）等现场。 */
    hostWriteTransform?: (data: string) => string;
    /** 宿主写入面的调用记录，用于断言有界重试的次数与内容。 */
    hostWriteLog?: string[];
  }): SyncExecutor {
    const progressStore = options.progressStore ?? new SyncProgressStore();
    const addToken = (item: SyncPlanItem): SyncPlanItem => {
      const completeItem = item.remote && !item.remote.parentId
        ? {
            ...item,
            remote: {
              ...item.remote,
              parentId: item.path.includes("/")
                ? "reviewed-parent-id"
                : TEST_SYNC_SCOPE.filesRootId,
            },
          }
        : item;
      return options.preserveMissingDecisionTokens
      ? completeItem
      : {
          ...completeItem,
          decisionToken: completeItem.decisionToken ?? {
            version: 1,
            vaultName: "testVault",
            accountId: "account-test",
            scope: { ...TEST_SYNC_SCOPE, accountId: "account-test" },
            local: completeItem.local
              ? { exists: true, hash: completeItem.local.hash, size: completeItem.local.size }
              : { exists: false },
            remote: completeItem.remote
              ? { exists: true, driveId: completeItem.remote.driveId, eTag: completeItem.remote.eTag }
              : { exists: false },
            ancestorHash: null,
          },
        };
    };
    const pendingConflicts = (options.pendingConflicts ?? []).map(addToken);
    const pendingRemoteDeletes = (options.pendingRemoteDeletes ?? []).map(addToken);
    const reviewedRemoteByPath = new Map(
      [...pendingConflicts, ...pendingRemoteDeletes]
        .flatMap((item) => item.remote ? [[item.remote.path, item.remote] as const] : []),
    );
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      boundAccountId: "account-test",
      pendingConflicts,
      pendingRemoteDeletes,
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn().mockResolvedValue(undefined),
      removePendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      applyRemoteMutations: vi.fn().mockResolvedValue(undefined),
      cacheBaseContent: vi.fn(),
      ...options.stateOverrides,
    } as unknown as StateManager;

    const adapter = makeMockAdapter(options.adapterOverrides);
    const hostWriteSurface = options.hostEditorMerge !== undefined
      || options.hostWriteSilent === true
      || options.hostWriteTransform !== undefined;
    return new SyncExecutor(
      makeMockOneDrive({
        downloadFile: options.downloadFile,
        uploadFile: options.uploadFile,
        ...(options.deleteItem ? { deleteItem: options.deleteItem } : {}),
        ...(options.getDriveItemMetadataById
          ? { getDriveItemMetadataById: options.getDriveItemMetadataById }
          : {}),
        ...(options.initVaultScope ? { initVaultScope: options.initVaultScope } : {}),
        getFileMetadata: options.getFileMetadata ?? vi.fn().mockImplementation(async (_vault: string, path: string) => {
          const reviewedRemote = reviewedRemoteByPath.get(path);
          return reviewedRemote ? {
              driveId: reviewedRemote.driveId,
              size: reviewedRemote.size,
              mtime: reviewedRemote.mtime,
              eTag: reviewedRemote.eTag,
              downloadUrl: reviewedRemote.downloadUrl,
              sha256Hash: reviewedRemote.sha256Hash,
            }
            : null;
        }),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          getFileByPath: vi.fn().mockReturnValue(options.vaultFile ?? null),
          ...(hostWriteSurface
            ? {
                modify: vi.fn(async (file: TFile, data: string) => {
                  options.hostWriteLog?.push(data);
                  if (options.hostWriteSilent) return;
                  const written = options.hostWriteTransform
                    ? options.hostWriteTransform(data)
                    : `${data}${options.hostEditorMerge ?? ""}`;
                  await adapter.writeBinary(
                    file.path,
                    new TextEncoder().encode(written).buffer,
                  );
                }),
              }
            : {}),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: options.scanFile ?? vi.fn().mockResolvedValue(null),
        shouldSyncPath: options.shouldSyncPath ?? vi.fn().mockReturnValue(true),
        ...(options.inspectFile ? { inspectFile: options.inspectFile } : {}),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
      options.i18n,
      progressStore,
      options.diag,
      options.fileManager as never,
      options.onProgressUpdate,
      undefined,
      options.noticeCenter,
    );
  }

  function makeNoticeRecorder(): {
    center: EasySyncNoticeCenter;
    messages: string[];
  } {
    const messages: string[] = [];
    const center = new EasySyncNoticeCenter((message) => {
      messages.push(String(message));
      return {
        setMessage(next) {
          messages.push(String(next));
        },
        hide: vi.fn(),
      };
    });
    return { center, messages };
  }

  /** 内存盘：`files` 里的键就是磁盘上真实存在的文件，写入/改名都按真语义落地。 */
  function makeKeepRemoteFileStore(
    initial: Record<string, ArrayBuffer>,
    options: { failWriteBinary?: (target: string) => boolean } = {},
  ) {
    const files = new Map(Object.entries(initial));
    return {
      files,
      adapterOverrides: {
        exists: vi.fn(async (target: string) => files.has(target)),
        stat: vi.fn(async (target: string) => {
          const bytes = files.get(target);
          return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
        }),
        readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
        writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => {
          if (options.failWriteBinary?.(target)) throw new Error("disk full");
          files.set(target, bytes.slice(0));
        }),
        remove: vi.fn(async (target: string) => { files.delete(target); }),
        rename: vi.fn(async (from: string, to: string) => {
          const bytes = files.get(from);
          if (!bytes) throw new Error(`missing ${from}`);
          files.set(to, bytes);
          files.delete(from);
        }),
      },
      inspectFile: vi.fn(async (target: string) => {
        const bytes = files.get(target);
        if (!bytes) return { status: "missing" as const };
        return {
          status: "present" as const,
          entry: {
            path: target,
            size: bytes.byteLength,
            mtime: 2,
            hash: await sha256Hex(bytes),
            binary: false,
          },
        };
      }),
    };
  }

  /** 留档夹契约（独立于实现重算）：`<pluginDir>/archive/<yyyy-MM-dd HHmm>/<库内相对路径>`。 */
  function expectedArchiveFilePath(path: string, archivedAt: number): string {
    const pluginDir = getEasySyncPaths(".obsidian").pluginDir;
    const date = new Date(archivedAt);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}${pad(date.getMinutes())}`;
    return `${pluginDir}/archive/${stamp}/${path}`;
  }

  it("keepRemote feeds byte progress into the shared progress store", async () => {
    const progressStore = new SyncProgressStore();
    const snapshots: Array<{
      phase: string;
      currentFile: string;
      currentActionType?: SyncActionType;
      currentItemBytes: number;
      currentItemTotalBytes: number;
    }> = [];
    const remote = {
      path: "attachments/audio.m4a",
      driveId: "drive-1",
      downloadUrl: "https://example.invalid/download",
      size: 10,
      mtime: 1,
      eTag: "etag-1",
      cTag: "ctag-1",
    } as RemoteFileEntry;
    const localBytes = new Uint8Array(10).fill(3).buffer;
    const executor = makeProgressAwareExecutor({
      progressStore,
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path: remote.path,
        remote,
        local: {
          path: remote.path,
          hash: await sha256Hex(localBytes),
          size: localBytes.byteLength,
          mtime: 1,
          binary: true,
        },
      }],
      adapterOverrides: {
        stat: vi.fn().mockResolvedValue({ size: 10, mtime: 1 }),
        // 留档要读「审阅时的本机版本」：本机文件在磁盘上是真实存在的。
        readBinary: vi.fn().mockResolvedValue(localBytes),
      },
      downloadFile: vi.fn().mockImplementation(
        async (_vaultName: string, _path: string, _downloadUrl?: string, _driveId?: string, fileSize = 0, onProgress?: (downloaded: number, total: number) => void) => {
          onProgress?.(4, fileSize);
          onProgress?.(fileSize, fileSize);
          return new Uint8Array(fileSize).fill(7).buffer;
        },
      ),
      onProgressUpdate: () => {
        snapshots.push({
          phase: progressStore.state.phase,
          currentFile: progressStore.state.currentFile,
          currentActionType: progressStore.state.currentActionType,
          currentItemBytes: progressStore.state.currentItemBytes,
          currentItemTotalBytes: progressStore.state.currentItemTotalBytes,
        });
      },
    });

    await executor.resolveConflictKeepRemote(remote.path);

    expect(snapshots.some((snapshot) =>
      snapshot.phase === "executing"
      && snapshot.currentFile === remote.path
      && snapshot.currentActionType === SyncActionType.Download,
    )).toBe(true);
    await waitUntil(() => {
      expect(snapshots.some((snapshot) =>
        snapshot.currentItemBytes === 4 && snapshot.currentItemTotalBytes === 10,
      )).toBe(true);
      expect(progressStore.state.phase).toBe("done");
    });
  });

  it("reconciles an exact-content conflict without uploading or downloading again", async () => {
    const path = "same.md";
    const content = new TextEncoder().encode("same").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path,
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      size: content.byteLength,
      mtime: 1,
      eTag: "etag-same",
      cTag: "",
    };
    const reconcileIdenticalConflict = vi.fn().mockResolvedValue(undefined);
    const downloadFile = vi.fn();
    const uploadFile = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      stateOverrides: { reconcileIdenticalConflict },
      downloadFile,
      uploadFile,
    });

    await executor.reconcileIdenticalConflict(path, {
      localHash: hash,
      localSize: content.byteLength,
      remoteHash: hash,
      remoteSize: content.byteLength,
      remoteETag: remote.eTag,
    });

    expect(reconcileIdenticalConflict).toHaveBeenCalledWith({
      path,
      hash,
      size: content.byteLength,
      eTag: remote.eTag,
    });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("keeps the conflict when the remote eTag changes after exact-content review", async () => {
    const path = "same-raced.md";
    const content = new TextEncoder().encode("same").buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path, hash, size: content.byteLength, mtime: 1, binary: false,
    };
    const remote: RemoteFileEntry = {
      path, driveId: "remote-id", size: content.byteLength,
      mtime: 1, eTag: "etag-reviewed", cTag: "",
    };
    const reconcileIdenticalConflict = vi.fn().mockResolvedValue(undefined);
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      getFileMetadata: vi.fn().mockResolvedValue({
        ...remote,
        eTag: "etag-new",
      }),
      stateOverrides: { reconcileIdenticalConflict, addPendingConflict },
    });

    await executor.reconcileIdenticalConflict(path, {
      localHash: hash,
      localSize: content.byteLength,
      remoteHash: hash,
      remoteSize: content.byteLength,
      remoteETag: remote.eTag,
    });

    expect(reconcileIdenticalConflict).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      path,
      remote: expect.objectContaining({ eTag: "etag-new" }),
    }));
  });

  it("keepLocal feeds upload progress into the shared progress store", async () => {
    const progressStore = new SyncProgressStore();
    const snapshots: Array<{
      phase: string;
      currentFile: string;
      currentActionType?: SyncActionType;
      currentItemBytes: number;
      currentItemTotalBytes: number;
    }> = [];
    const local = {
      path: "attachments/audio.m4a",
      hash: "bb".repeat(32),
      size: 12,
      mtime: 1,
      binary: true,
    } as LocalFileEntry;
    const executor = makeProgressAwareExecutor({
      progressStore,
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path: local.path,
        local,
        remote: {
          path: local.path,
          driveId: "drive-1",
          size: 12,
          mtime: 1,
          eTag: "etag-1",
          cTag: "ctag-1",
        },
      }],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array(local.size).fill(9).buffer),
      },
      uploadFile: vi.fn().mockImplementation(
        async (_vaultName: string, _path: string, content: ArrayBuffer, onProgress?: (uploaded: number, total: number) => void) => {
          onProgress?.(5, content.byteLength);
          onProgress?.(content.byteLength, content.byteLength);
          return { id: "uploaded-id", eTag: "uploaded-etag" };
        },
      ),
      onProgressUpdate: () => {
        snapshots.push({
          phase: progressStore.state.phase,
          currentFile: progressStore.state.currentFile,
          currentActionType: progressStore.state.currentActionType,
          currentItemBytes: progressStore.state.currentItemBytes,
          currentItemTotalBytes: progressStore.state.currentItemTotalBytes,
        });
      },
    });

    await executor.resolveConflictKeepLocal(local.path);

    expect(snapshots.some((snapshot) =>
      snapshot.phase === "executing"
      && snapshot.currentFile === local.path
      && snapshot.currentActionType === SyncActionType.Upload,
    )).toBe(true);
    await waitUntil(() => {
      expect(snapshots.some((snapshot) =>
        snapshot.currentItemBytes === 5 && snapshot.currentItemTotalBytes === local.size,
      )).toBe(true);
      expect(progressStore.state.phase).toBe("done");
    });
  });

  it("abandons a proven not-applied keepRemote intent in the same side action", async () => {
    const path = "network-failed.md";
    const localBytes = new Uint8Array([1]).buffer;
    const local: LocalFileEntry = {
      path, hash: await sha256Hex(localBytes), size: localBytes.byteLength, mtime: 1, binary: false,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path, driveId: "remote-id", size: 1, mtime: 1,
          eTag: "etag-reviewed", cTag: "",
        },
      }],
      stateOverrides: { abandonMutationIntent },
      // 留档要读「审阅时的本机版本」：本机文件在磁盘上是真实存在的。
      adapterOverrides: { readBinary: vi.fn().mockResolvedValue(localBytes) },
      downloadFile: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
      ),
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.downloadFailed:${path}`);
    notice.center.dispose();
  });

  it("reconciles a completed side mutation before reporting a checkpoint failure", async () => {
    const path = "receipt-recovered.md";
    const content = new Uint8Array([7]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path, hash, size: content.byteLength, mtime: 1, binary: false,
    };
    const reviewedRemote = {
      path, driveId: "remote-id", size: 1, mtime: 1,
      eTag: "etag-reviewed", cTag: "", sha256Hash: "bb".repeat(32),
    } as RemoteFileEntry;
    const uploadedRemote = {
      driveId: "remote-id",
      size: content.byteLength,
      mtime: 2,
      eTag: "etag-uploaded",
      sha256Hash: hash,
    };
    const recordMutationReceipt = vi.fn()
      .mockRejectedValueOnce(new Error("checkpoint response lost"))
      .mockResolvedValueOnce(undefined);
    const commitMutationCheckpoint = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: reviewedRemote,
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      adapterOverrides: { readBinary: vi.fn().mockResolvedValue(content) },
      getFileMetadata: vi.fn()
        .mockResolvedValueOnce(reviewedRemote)
        .mockResolvedValue(uploadedRemote),
      uploadFile: vi.fn().mockResolvedValue({
        id: uploadedRemote.driveId,
        eTag: uploadedRemote.eTag,
        size: uploadedRemote.size,
      }),
      stateOverrides: { recordMutationReceipt, commitMutationCheckpoint },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(recordMutationReceipt).toHaveBeenCalledTimes(2);
    expect(recordMutationReceipt.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      checkpoint: expect.objectContaining({
        pendingConflictRemovals: [path],
      }),
    }));
    expect(commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.keptLocal:${path}`);
    notice.center.dispose();
  });

  it("reports side-action auth expiry as auth expiry and settles a not-applied intent", async () => {
    const path = "auth-expired.md";
    const content = new Uint8Array([1]).buffer;
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path, driveId: "remote-id", size: 1, mtime: 1,
          eTag: "etag-reviewed", cTag: "",
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      adapterOverrides: { readBinary: vi.fn().mockResolvedValue(content) },
      uploadFile: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.AuthExpired, "token expired", 401),
      ),
      stateOverrides: { abandonMutationIntent },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(notice.center.activeKey).toBe(`side-action:result.authExpired:${path}`);
    notice.center.dispose();
  });

  it.each([
    {
      name: "remote preparation",
      initVaultScope: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
      ),
      stateOverrides: {},
      expectedKey: "notice.sideActionRemotePrepareFailed",
    },
    {
      name: "scope validation",
      initVaultScope: vi.fn().mockResolvedValue({
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      }),
      stateOverrides: {
        remoteScope: {
          accountId: "account-test",
          driveId: "different-drive",
          vaultFolderId: "vault-folder-id",
          filesRootId: "files-root-id",
        },
      },
      expectedKey: "notice.sideActionScopeChanged",
    },
    {
      name: "mutation recovery",
      initVaultScope: vi.fn().mockResolvedValue({
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      }),
      stateOverrides: { hasMutationLedgerCorruption: true },
      expectedKey: "notice.sideActionMutationRecoveryFailed",
    },
  ])("labels $name failures by their actual preparation phase", async ({
    initVaultScope,
    stateOverrides,
    expectedKey,
  }) => {
    const path = "phase.md";
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
      }],
      uploadFile: vi.fn(),
      initVaultScope,
      stateOverrides,
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(notice.center.activeKey).toBe(`side-action:${expectedKey}:${path}`);
    notice.center.dispose();
  });

  it("expires a protected one-sided legacy conflict instead of deleting a managed config file", async () => {
    const remove = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path: ".obsidian/app.json",
        local: {
          path: ".obsidian/app.json",
          hash: "aa".repeat(32),
          size: 850,
          mtime: 1,
          binary: false,
        },
        reason: "reason.fileDeletedFromRemote",
      }],
      adapterOverrides: {
        remove,
      },
      stateOverrides: { removePendingConflict },
      initVaultScope,
    });

    await executor.resolveConflictKeepRemote(".obsidian/app.json");

    await waitUntil(() => {
      expect(executor.isSideActionQueued(".obsidian/app.json")).toBe(false);
    });

    expect(remove).not.toHaveBeenCalled();
    expect(initVaultScope).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(".obsidian/app.json");
  });

  it("expires a one-sided EasySync build conflict instead of deleting the running plugin", async () => {
    const path = ".obsidian/plugins/easy-sync/main.js";
    const remove = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: {
          path,
          hash: "aa".repeat(32),
          size: 1_700_000,
          mtime: 1,
          binary: false,
        },
        reason: "reason.fileDeletedFromRemote",
      }],
      adapterOverrides: { remove },
      stateOverrides: { removePendingConflict },
      initVaultScope,
      shouldSyncPath: vi.fn().mockReturnValue(true),
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(remove).not.toHaveBeenCalled();
    expect(initVaultScope).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(path);
  });

  it("expires any conflict whose path left the current sync scope", async () => {
    const path = ".obsidian/plugins/example-plugin/main.js";
    const downloadFile = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: {
          path,
          hash: "aa".repeat(32),
          size: 1,
          mtime: 1,
          binary: false,
        },
        remote: {
          path,
          driveId: "remote-plugin-main",
          size: 1,
          mtime: 1,
          eTag: "etag-reviewed",
          cTag: "ctag-reviewed",
        },
      }],
      downloadFile,
      stateOverrides: { removePendingConflict },
      initVaultScope,
      shouldSyncPath: vi.fn().mockReturnValue(false),
    });

    await executor.resolveConflictKeepRemote(path);

    expect(initVaultScope).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(path);
  });

  it("expires a pending config decision when its sync toggle is now off", async () => {
    const path = ".obsidian/app.json";
    const uploadFile = vi.fn();
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const initVaultScope = vi.fn();
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
        remote: { path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      shouldSyncPath: vi.fn().mockReturnValue(false),
      stateOverrides: { removePendingConflict },
      initVaultScope,
      uploadFile,
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepLocal(path);

    expect(initVaultScope).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(removePendingConflict).toHaveBeenCalledWith(path);
    expect(notice.center.activeKey).toBe(`side-action:notice.configSyncDisabled:${path}`);
    notice.center.dispose();
  });

  it("keepLocal uploads the current managed config snapshot after it changed since review", async () => {
    const path = ".obsidian/app.json";
    const reviewedContent = new TextEncoder().encode('{"theme":"old"}').buffer;
    const currentContent = new TextEncoder().encode('{"theme":"current"}').buffer;
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedContent),
      size: reviewedContent.byteLength,
      mtime: 1,
      binary: false,
    };
    const currentHash = await sha256Hex(currentContent);
    const uploadFile = vi.fn().mockResolvedValue({ id: "remote-id", eTag: "etag-new" });
    const beginMutationIntent = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "remote-id", size: reviewedContent.byteLength,
          mtime: 1, eTag: "etag-old", cTag: "",
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...reviewedLocal, hash: currentHash, size: currentContent.byteLength, mtime: 2 },
      }),
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(currentContent),
        stat: vi.fn().mockResolvedValue({ size: currentContent.byteLength, mtime: 2 }),
      },
      uploadFile,
      stateOverrides: { beginMutationIntent, recordMutationReceipt },
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      path,
      currentContent,
      expect.any(Function),
      "etag-old",
      "remote-id",
    );
    expect(beginMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      expectedLocal: { exists: true, hash: currentHash, size: currentContent.byteLength },
    }));
    expect(recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseUpserts: [expect.objectContaining({ path, hash: currentHash, size: currentContent.byteLength })],
      }),
    }));
  });

  it("keepRemote replaces a managed config using a fresh local CAS instead of the reviewed hash", async () => {
    const path = ".obsidian/app.json";
    const reviewedBytes = new TextEncoder().encode('{"theme":"old"}').buffer;
    const currentBytes = new TextEncoder().encode('{"theme":"current"}').buffer;
    const remoteBytes = new TextEncoder().encode('{"theme":"remote"}').buffer;
    const files = new Map<string, ArrayBuffer>([[path, currentBytes]]);
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedBytes),
      size: reviewedBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const currentLocal: LocalFileEntry = {
      ...reviewedLocal,
      hash: await sha256Hex(currentBytes),
      size: currentBytes.byteLength,
      mtime: 2,
    };
    const adapterOverrides = {
      stat: vi.fn(async (target: string) => {
        const bytes = files.get(target);
        return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
      }),
      readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
      writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => { files.set(target, bytes); }),
      remove: vi.fn(async (target: string) => { files.delete(target); }),
      rename: vi.fn(async (from: string, to: string) => {
        const bytes = files.get(from);
        if (!bytes) throw new Error(`missing ${from}`);
        files.set(to, bytes);
        files.delete(from);
      }),
    };
    const beginMutationIntent = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "remote-id", size: remoteBytes.byteLength,
          mtime: 1, eTag: "etag-old", cTag: "",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: currentLocal }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      adapterOverrides,
      stateOverrides: { beginMutationIntent },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(new Uint8Array(files.get(path)!)).toEqual(new Uint8Array(remoteBytes));
    expect(beginMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      expectedLocal: { exists: true, hash: currentLocal.hash, size: currentLocal.size },
    }));
  });

  it("keepRemote abandons its managed-config intent when the file changes in the final CAS window", async () => {
    const path = ".obsidian/app.json";
    const reviewedBytes = new TextEncoder().encode('{"theme":"old"}').buffer;
    const capturedBytes = new TextEncoder().encode('{"theme":"captured"}').buffer;
    const racedBytes = new TextEncoder().encode('{"theme":"raced"}').buffer;
    const remoteBytes = new TextEncoder().encode('{"theme":"remote"}').buffer;
    const files = new Map<string, ArrayBuffer>([[path, racedBytes]]);
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedBytes),
      size: reviewedBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const capturedLocal: LocalFileEntry = {
      ...reviewedLocal,
      hash: await sha256Hex(capturedBytes),
      size: capturedBytes.byteLength,
      mtime: 2,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "remote-id", size: remoteBytes.byteLength,
          mtime: 1, eTag: "etag-old", cTag: "",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: capturedLocal }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      adapterOverrides: {
        stat: vi.fn(async (target: string) => {
          const bytes = files.get(target);
          return bytes ? { size: bytes.byteLength, mtime: 3 } : null;
        }),
        readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
        writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => { files.set(target, bytes); }),
        remove: vi.fn(async (target: string) => { files.delete(target); }),
      },
      stateOverrides: { abandonMutationIntent },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(new Uint8Array(files.get(path)!)).toEqual(new Uint8Array(racedBytes));
    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
  });

  it("keepRemote counts the host's merge of unsaved text as landed and keeps the cloud version as the base", async () => {
    const path = "note.md";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    // 本机版本故意与云端版本长度不同：基线若被误记成「扫描到的本机尺寸」，
    // 断言要能分辨出来（两者等长时 size 断言形同虚设）。
    const localBytes = encoder.encode("local v1\n").buffer;
    const remoteBytes = encoder.encode("cloud\n").buffer;
    const files = new Map<string, ArrayBuffer>([[path, localBytes]]);
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const remote = {
      path,
      driveId: "remote-id",
      size: remoteBytes.byteLength,
      mtime: 2,
      eTag: "etag-cloud",
      cTag: "ctag-cloud",
      sha256Hash: await sha256Hex(remoteBytes),
    } as RemoteFileEntry;
    const hostWriteLog: string[] = [];
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const zh = new I18n("zh-cn");
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      vaultFile: new TFile(path),
      hostEditorMerge: "unsaved\n",
      hostWriteLog,
      adapterOverrides: {
        stat: vi.fn(async (target: string) => {
          const bytes = files.get(target);
          return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
        }),
        readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
        writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => { files.set(target, bytes); }),
        remove: vi.fn(async (target: string) => { files.delete(target); }),
        // 留档是「写暂存 → 改名落入留档夹」：内存盘要按真语义改名。
        rename: vi.fn(async (from: string, to: string) => {
          const bytes = files.get(from);
          if (!bytes) throw new Error(`missing ${from}`);
          files.set(to, bytes);
          files.delete(from);
        }),
      },
      stateOverrides: { recordMutationReceipt },
      noticeCenter: notice.center,
      i18n: zh,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    // 磁盘上是云端版本后面接宿主合并回来的未保存行：写入本身已落地，这一轮记成功。
    expect(decoder.decode(files.get(path)!)).toBe("cloud\nunsaved\n");
    expect(hostWriteLog).toEqual(["cloud\n"]);
    const checkpoint = recordMutationReceipt.mock.calls[0]?.[0]?.checkpoint as
      | { baseUpserts: BaseFileEntry[]; pendingConflictRemovals: string[] }
      | undefined;
    expect(checkpoint?.pendingConflictRemovals).toEqual([path]);
    // 基线记云端版本本身，不是磁盘上的合并结果：合并结果属于「本机改动」，
    // 留给下一轮按普通本机改动上传（`DECISIONS` 2026-09-23 第 9 点②）。
    expect(checkpoint?.baseUpserts).toEqual([{
      path,
      hash: await sha256Hex(remoteBytes),
      size: remoteBytes.byteLength,
      eTag: "etag-cloud",
    }]);
    // 这一轮记成功：没有任何冲突失败提示（合并结果不是失败，只是留给下一轮上传）。
    expect(notice.messages.some((line) => line.includes(zh.t("notice.conflict.failed", { reason: "" })))).toBe(false);
    notice.center.dispose();
  });

  it("keepRemote reports a write that never landed honestly instead of blaming a local change", async () => {
    const path = "note.md";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const localBytes = encoder.encode("local\n").buffer;
    const remoteBytes = encoder.encode("cloud\n").buffer;
    const files = new Map<string, ArrayBuffer>([[path, localBytes]]);
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const hostWriteLog: string[] = [];
    const notice = makeNoticeRecorder();
    const zh = new I18n("zh-cn");
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path,
          driveId: "remote-id",
          size: remoteBytes.byteLength,
          mtime: 2,
          eTag: "etag-cloud",
          cTag: "ctag-cloud",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      vaultFile: new TFile(path),
      hostWriteSilent: true,
      hostWriteLog,
      adapterOverrides: {
        stat: vi.fn(async (target: string) => {
          const bytes = files.get(target);
          return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
        }),
        readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
        writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => { files.set(target, bytes); }),
        remove: vi.fn(async (target: string) => { files.delete(target); }),
        // 留档是「写暂存 → 改名落入留档夹」：内存盘要按真语义改名。
        rename: vi.fn(async (from: string, to: string) => {
          const bytes = files.get(from);
          if (!bytes) throw new Error(`missing ${from}`);
          files.set(to, bytes);
          files.delete(from);
        }),
      },
      stateOverrides: { abandonMutationIntent, recordMutationReceipt },
      noticeCenter: notice.center,
      i18n: zh,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    // 同轮有界重试一次；本机文件自始至终没被改动，冲突也未销账。
    expect(hostWriteLog).toEqual(["cloud\n", "cloud\n"]);
    expect(decoder.decode(files.get(path)!)).toBe("local\n");
    expect(recordMutationReceipt).not.toHaveBeenCalled();
    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
    // 用户看到的原因是「未能写入本机文件，本次未作更改」，而不是「确认后本机文件又发生了变化」，
    // 也不是内部英文串（事件中心按 key 只留最新一条，后两条都曾把它覆盖掉）。
    // 这里逐字钉住定稿文案（`notice.localWriteNotLanded`），防止措辞静默漂移。
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.failed:${path}`);
    expect(notice.messages.some((line) => line.includes("未能写入本机文件，本次未作更改。请查看最新版本后重新选择。"))).toBe(true);
    expect(notice.messages.some((line) => line.includes(zh.t("notice.localChangedSinceReview")))).toBe(false);
    expect(notice.messages.some((line) => line.includes("Local replacement did not land"))).toBe(false);
    expect(notice.messages).toHaveLength(1);
    notice.center.dispose();
  });

  it("keepRemote says the local content is unconfirmed when the rollback itself failed", async () => {
    const path = "note.md";
    const encoder = new TextEncoder();
    const localBytes = encoder.encode("local v1\n").buffer;
    const remoteBytes = encoder.encode("cloud\n").buffer;
    const files = new Map<string, ArrayBuffer>([[path, localBytes]]);
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const zh = new I18n("zh-cn");
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path,
          driveId: "remote-id",
          size: remoteBytes.byteLength,
          mtime: 2,
          eTag: "etag-cloud",
          cTag: "ctag-cloud",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      vaultFile: new TFile(path),
      // 宿主只写进去两个字节＝我们自己写坏了；回放旧内容那一次写入再失败，
      // 本机就停在被写坏的状态上（`DECISIONS` 2026-09-23 第 9 点③的坏结局）。
      hostWriteTransform: (data) => data.slice(0, 2),
      adapterOverrides: {
        stat: vi.fn(async (target: string) => {
          const bytes = files.get(target);
          return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
        }),
        readBinary: vi.fn(async (target: string) => files.get(target) ?? new ArrayBuffer(0)),
        writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => {
          // 只让「回放旧内容」那一次失败：宿主写坏的那一下要正常落盘。
          if (target === path && new TextDecoder().decode(bytes) === "local v1\n") {
            throw new Error("rollback failed on purpose");
          }
          files.set(target, bytes);
        }),
        remove: vi.fn(async (target: string) => { files.delete(target); }),
        // 留档是「写暂存 → 改名落入留档夹」：内存盘要按真语义改名。
        rename: vi.fn(async (from: string, to: string) => {
          const bytes = files.get(from);
          if (!bytes) throw new Error(`missing ${from}`);
          files.set(to, bytes);
          files.delete(from);
        }),
      },
      stateOverrides: { abandonMutationIntent, recordMutationReceipt },
      noticeCenter: notice.center,
      i18n: zh,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(recordMutationReceipt).not.toHaveBeenCalled();
    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
    // 回放失败时不能说「本次未作更改」——那一句只在旧内容确实原样留在磁盘上时成立；
    // 逐字钉住定稿文案（`notice.localWriteStateUncertain`），防止与另一句混用。
    expect(notice.messages.some((line) => line.includes("未能写入本机文件，本机文件当前内容无法确认。请查看最新版本后重新选择。"))).toBe(true);
    expect(notice.messages.some((line) => line.includes("本次未作更改"))).toBe(false);
    expect(notice.messages).toHaveLength(1);
    notice.center.dispose();
  });

  it("keepRemote names the local change when the file moves in the final CAS window", async () => {
    const path = "note.md";
    const encoder = new TextEncoder();
    const reviewedBytes = encoder.encode("reviewed\n").buffer;
    const racedBytes = encoder.encode("raced\n").buffer;
    const remoteBytes = encoder.encode("cloud\n").buffer;
    // 审阅之后、写入之前的窗口里本机被别人改掉：扫描事实仍是审阅版本，磁盘已经变了。
    // 留档第一次读到的还是审阅版本；覆盖前的 CAS 复读时才见到改动后的字节。
    const files = new Map<string, ArrayBuffer>([[path, racedBytes]]);
    let localReads = 0;
    const readBinary = vi.fn(async (target: string) => {
      if (target !== path) return files.get(target) ?? new ArrayBuffer(0);
      localReads += 1;
      return localReads === 1 ? reviewedBytes.slice(0) : racedBytes.slice(0);
    });
    const reviewed: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedBytes),
      size: reviewedBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const abandonMutationIntent = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const zh = new I18n("zh-cn");
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewed,
        remote: {
          path,
          driveId: "remote-id",
          size: remoteBytes.byteLength,
          mtime: 2,
          eTag: "etag-cloud",
          cTag: "ctag-cloud",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: reviewed }),
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      adapterOverrides: {
        stat: vi.fn(async (target: string) => {
          const bytes = files.get(target);
          return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
        }),
        readBinary,
        writeBinary: vi.fn(async (target: string, bytes: ArrayBuffer) => { files.set(target, bytes); }),
        remove: vi.fn(async (target: string) => { files.delete(target); }),
        rename: vi.fn(async (from: string, to: string) => {
          const bytes = files.get(from);
          if (!bytes) throw new Error(`missing ${from}`);
          files.set(to, bytes);
          files.delete(from);
        }),
      },
      stateOverrides: { abandonMutationIntent, recordMutationReceipt },
      noticeCenter: notice.center,
      i18n: zh,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(new TextDecoder().decode(files.get(path)!)).toBe("raced\n");
    expect(recordMutationReceipt).not.toHaveBeenCalled();
    expect(abandonMutationIntent).toHaveBeenCalledTimes(1);
    // 这一档确实是本机改动，但用户要看本地化说明，不是内部英文串。
    expect(notice.messages).toHaveLength(1);
    expect(notice.messages[0]).toContain(zh.t("notice.localChangedSinceReview"));
    expect(notice.messages[0]).not.toContain("Local file changed before replacement");
    notice.center.dispose();
  });

  it("keepRemote keeps the local version in the plugin archive folder before the cloud version overwrites it", async () => {
    const path = "notes/note.md";
    const localBytes = new TextEncoder().encode("local version\n").buffer;
    const remoteBytes = new TextEncoder().encode("cloud version\n").buffer;
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime: 1_700_000_000_000,
      binary: false,
    };
    const store = makeKeepRemoteFileStore({ [path]: localBytes });
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path,
          driveId: "remote-id",
          size: remoteBytes.byteLength,
          mtime: 2,
          eTag: "etag-cloud",
          cTag: "ctag-cloud",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: store.inspectFile,
      downloadFile: vi.fn().mockResolvedValue(remoteBytes),
      adapterOverrides: store.adapterOverrides,
      stateOverrides: { recordMutationReceipt },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    // 覆盖照常发生：留档是复制，不是把这次覆盖换掉。
    expect(recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(store.files.get(path)!)).toEqual(new Uint8Array(remoteBytes));
    // 留档逐字节等于「审阅时的本机版本」，落在插件目录的留档夹里。
    const archivePath = expectedArchiveFilePath(path, local.mtime);
    expect(store.files.has(archivePath)).toBe(true);
    expect(new Uint8Array(store.files.get(archivePath)!)).toEqual(new Uint8Array(localBytes));
    // 暂存文件不残留（留档是改名的，不是复制两份）。
    expect([...store.files.keys()].filter((key) => key.endsWith(".part"))).toEqual([]);
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.keptRemote:${path}`);
    notice.center.dispose();
  });

  it("does not overwrite anything when the local version cannot be archived", async () => {
    const path = "note.md";
    const localBytes = new TextEncoder().encode("local version\n").buffer;
    const remoteBytes = new TextEncoder().encode("cloud version\n").buffer;
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const store = makeKeepRemoteFileStore(
      { [path]: localBytes },
      { failWriteBinary: (target) => target.includes("/local-archive/") },
    );
    const downloadFile = vi.fn().mockResolvedValue(remoteBytes);
    const beginMutationIntent = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: {
          path,
          driveId: "remote-id",
          size: remoteBytes.byteLength,
          mtime: 2,
          eTag: "etag-cloud",
          cTag: "ctag-cloud",
          sha256Hash: await sha256Hex(remoteBytes),
        },
      }],
      inspectFile: store.inspectFile,
      downloadFile,
      adapterOverrides: store.adapterOverrides,
      stateOverrides: { beginMutationIntent, recordMutationReceipt, removePendingConflict },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    // 本机文件仍是审阅那版字节，且没有第二处落盘（留档没成，暂存也不能留）。
    expect(new Uint8Array(store.files.get(path)!)).toEqual(new Uint8Array(localBytes));
    expect([...store.files.keys()]).toEqual([path]);
    // 覆盖链一步都没开始：没有远端传输、没有账本记录、冲突行原地保留。
    expect(downloadFile).not.toHaveBeenCalled();
    expect(beginMutationIntent).not.toHaveBeenCalled();
    expect(recordMutationReceipt).not.toHaveBeenCalled();
    expect(removePendingConflict).not.toHaveBeenCalled();
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.failed:${path}`);
    notice.center.dispose();
  });

  it("keepRemote archives the local-only version and records the followed cloud deletion before deleting it", async () => {
    const path = "notes/note.md";
    const localBytes = new TextEncoder().encode("local only\n").buffer;
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime: 1_700_000_000_000,
      binary: false,
    };
    const store = makeKeepRemoteFileStore({ [path]: localBytes });
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const commitMutationCheckpoint = vi.fn().mockResolvedValue(undefined);
    const recordCloudDeletion = vi.fn().mockResolvedValue(undefined);
    const remoteIdForPath = vi.fn().mockReturnValue("anchor-note-id");
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local }],
      inspectFile: store.inspectFile,
      adapterOverrides: store.adapterOverrides,
      stateOverrides: {
        recordMutationReceipt,
        commitMutationCheckpoint,
        recordCloudDeletion,
        remoteIdForPath,
      },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    // 本机这份已经被删，但它不是全世界唯一一份了：删除之前先留了档。
    expect(store.files.has(path)).toBe(false);
    const archivePath = expectedArchiveFilePath(path, local.mtime);
    expect(store.files.has(archivePath)).toBe(true);
    expect(new Uint8Array(store.files.get(archivePath)!))
      .toEqual(new Uint8Array(localBytes));
    // 跟随云端删除：删除成功之后、checkpoint 提交（归约删锚点）之前补记一条，
    // 身份取自己提交的锚点。
    expect(remoteIdForPath).toHaveBeenCalledWith(path);
    expect(recordCloudDeletion).toHaveBeenCalledWith({
      remoteId: "anchor-note-id",
      path,
      deletedAt: expect.any(Number),
      kind: "file",
    });
    expect(store.adapterOverrides.remove).toHaveBeenCalledWith(path);
    expect(store.adapterOverrides.remove.mock.invocationCallOrder[0])
      .toBeLessThan(recordCloudDeletion.mock.invocationCallOrder[0]);
    expect(recordCloudDeletion.mock.invocationCallOrder[0])
      .toBeLessThan(commitMutationCheckpoint.mock.invocationCallOrder[0]);
    // 归约照常提交：删锚点、删远端镜像、摘掉冲突行。
    expect(recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseRemovals: [path],
        remoteDeletes: [path],
        pendingConflictRemovals: [path],
      }),
    }));
    expect(commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.keptRemote:${path}`);
    notice.center.dispose();
  });

  it("keeps the local-only version in place when it cannot be archived before the followed cloud deletion", async () => {
    const path = "note.md";
    const localBytes = new TextEncoder().encode("local only\n").buffer;
    const local: LocalFileEntry = {
      path,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime: 1_700_000_000_000,
      binary: false,
    };
    const store = makeKeepRemoteFileStore(
      { [path]: localBytes },
      { failWriteBinary: (target) => target.includes("/local-archive/") },
    );
    const beginMutationIntent = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockResolvedValue(undefined);
    const commitMutationCheckpoint = vi.fn().mockResolvedValue(undefined);
    const recordCloudDeletion = vi.fn().mockResolvedValue(undefined);
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const notice = makeNoticeRecorder();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local }],
      inspectFile: store.inspectFile,
      adapterOverrides: store.adapterOverrides,
      stateOverrides: {
        beginMutationIntent,
        recordMutationReceipt,
        commitMutationCheckpoint,
        recordCloudDeletion,
        removePendingConflict,
        remoteIdForPath: vi.fn().mockReturnValue("anchor-note-id"),
      },
      noticeCenter: notice.center,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    // 留档没落定就不删：本机文件原样还在，也没有第二处落盘（暂存不能留）。
    expect(new Uint8Array(store.files.get(path)!)).toEqual(new Uint8Array(localBytes));
    expect([...store.files.keys()]).toEqual([path]);
    expect(store.adapterOverrides.remove).not.toHaveBeenCalled();
    // 删除链一步都没开始：没有账本记录、没有回执、没有 checkpoint、冲突行原地保留。
    expect(recordCloudDeletion).not.toHaveBeenCalled();
    expect(beginMutationIntent).not.toHaveBeenCalled();
    expect(recordMutationReceipt).not.toHaveBeenCalled();
    expect(commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(removePendingConflict).not.toHaveBeenCalled();
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.failed:${path}`);
    notice.center.dispose();
  });

  it("Preflight P0 — keepLocal rejects a decision after local content changes", async () => {
    const path = "note.md";
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    let remoteMutated = false;
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path,
          driveId: "note-id",
          size: 1,
          mtime: 1,
          eTag: "etag-reviewed",
          cTag: "ctag-reviewed",
        },
      }],
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...reviewedLocal, hash: "bb".repeat(32), mtime: 2 },
      }),
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([2]).buffer),
      },
      uploadFile: vi.fn().mockImplementation(async () => {
        remoteMutated = true;
        return { id: "uploaded-id", eTag: "etag-uploaded" };
      }),
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(remoteMutated).toBe(false);
  });

  it("Preflight P0 — keepLocal uses the reviewed remote eTag as a CAS token", async () => {
    const path = "note.md";
    const reviewedETag = "etag-reviewed";
    let remoteMutated = false;
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: {
          path,
          hash: "aa".repeat(32),
          size: 1,
          mtime: 1,
          binary: false,
        },
        remote: {
          path,
          driveId: "note-id",
          size: 1,
          mtime: 1,
          eTag: reviewedETag,
          cTag: "ctag-reviewed",
        },
      }],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile: vi.fn().mockImplementation(
        async (_vaultName: string, _path: string, _content: ArrayBuffer, _onProgress?: unknown, eTag?: string) => {
          if (eTag === reviewedETag) {
            throw new OneDriveError(
              OneDriveErrorType.PreconditionFailed,
              "remote changed after review",
              412,
            );
          }
          remoteMutated = true;
          return { id: "overwritten-id", eTag: "etag-overwritten" };
        },
      ),
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(remoteMutated).toBe(false);
  });

  it("Preflight P0 — confirmRemoteDelete rejects a decision after local content changes", async () => {
    const path = "note.md";
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    const remove = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingRemoteDeletes: [{
        type: SyncActionType.ConfirmLocalDelete,
        path,
        local: reviewedLocal,
      }],
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...reviewedLocal, hash: "bb".repeat(32), mtime: 2 },
      }),
      adapterOverrides: { remove },
    });

    await executor.confirmRemoteDelete(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(remove).not.toHaveBeenCalled();
  });

  it("keepRemote stops after download when the reviewed local version changes", async () => {
    const path = "note.md";
    const reviewedBytes = new Uint8Array([1]).buffer;
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: await sha256Hex(reviewedBytes),
      size: reviewedBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([8]).buffer);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: reviewedLocal,
        remote: {
          path, driveId: "note-id", size: 1, mtime: 1,
          eTag: "etag-reviewed", cTag: "ctag-reviewed",
        },
      }],
      inspectFile: vi.fn()
        .mockResolvedValueOnce({ status: "present", entry: reviewedLocal })
        .mockResolvedValueOnce({
          status: "present",
          entry: { ...reviewedLocal, hash: "bb".repeat(32), mtime: 2 },
        }),
      adapterOverrides: {
        writeBinary,
        // 留档要读「审阅时的本机版本」：本机文件在磁盘上是真实存在的。
        readBinary: vi.fn().mockResolvedValue(reviewedBytes),
      },
      downloadFile,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(downloadFile).toHaveBeenCalledTimes(1);
    // 冲突路径一个字节都没写（留档写的是插件目录下的暂存，不碰库内文件）。
    expect(writeBinary).not.toHaveBeenCalledWith(path, expect.anything());
  });

  it("does not permanently delete when moving the local file to trash fails", async () => {
    const path = "note.md";
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
      mtime: 1,
      binary: false,
    };
    const remove = vi.fn().mockResolvedValue(undefined);
    const removePendingDelete = vi.fn().mockResolvedValue(undefined);
    const trashFile = vi.fn().mockRejectedValue(new Error("trash unavailable"));
    const executor = makeProgressAwareExecutor({
      pendingRemoteDeletes: [{
        type: SyncActionType.ConfirmLocalDelete,
        path,
        local: reviewedLocal,
      }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: reviewedLocal }),
      adapterOverrides: { remove },
      stateOverrides: { removePendingDelete },
      vaultFile: { path },
      fileManager: { trashFile },
    });

    await executor.confirmRemoteDelete(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(trashFile).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalledWith(path);
    expect(removePendingDelete).not.toHaveBeenCalled();
  });

  it("rejects a legacy pending conflict that has no decision token", async () => {
    const path = "legacy.md";
    const uploadFile = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local: { path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
        remote: { path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      preserveMissingDecisionTokens: true,
      uploadFile,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("refreshes the pending conflict when the remote version changed before keepRemote", async () => {
    const path = "remote-changed.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const downloadFile = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: { path, driveId: "old-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "new-id", size: 2, mtime: 2, eTag: "etag-new",
      }),
      stateOverrides: { addPendingConflict },
      downloadFile,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(downloadFile).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      path,
      remote: expect.objectContaining({ driveId: "new-id", eTag: "etag-new" }),
      decisionToken: expect.objectContaining({
        remote: { exists: true, driveId: "new-id", eTag: "etag-new" },
      }),
    }));
  });

  it("refreshes the pending conflict when keepLocal loses the final If-Match race", async () => {
    const path = "upload-raced.md";
    const local: LocalFileEntry = {
      path, hash: await sha256Hex(new Uint8Array([1]).buffer), size: 1, mtime: 1, binary: false,
    };
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const getFileMetadata = vi.fn()
      .mockResolvedValueOnce({ driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old" })
      .mockResolvedValueOnce({ driveId: "remote-id", size: 2, mtime: 2, eTag: "etag-new" });
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: { path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "" },
      }],
      getFileMetadata,
      stateOverrides: { addPendingConflict },
      adapterOverrides: { readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer) },
      uploadFile: vi.fn().mockRejectedValue(
        new OneDriveError(OneDriveErrorType.PreconditionFailed, "raced", 412),
      ),
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      remote: expect.objectContaining({ eTag: "etag-new" }),
      decisionToken: expect.objectContaining({
        remote: { exists: true, driveId: "remote-id", eTag: "etag-new" },
      }),
    }));
  });

  it("does not write keepRemote content when the remote version changes during download", async () => {
    const path = "remote-raced.md";
    const localBytes = new Uint8Array([1]).buffer;
    const local: LocalFileEntry = {
      path, hash: await sha256Hex(localBytes), size: localBytes.byteLength, mtime: 1, binary: false,
    };
    const reviewedRemote = {
      path, driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old", cTag: "",
    } as RemoteFileEntry;
    const writeBinary = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const getFileMetadata = vi.fn()
      .mockResolvedValueOnce({ driveId: "remote-id", size: 1, mtime: 1, eTag: "etag-old" })
      .mockResolvedValueOnce({ driveId: "remote-id", size: 2, mtime: 2, eTag: "etag-new" });
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote: reviewedRemote }],
      getFileMetadata,
      stateOverrides: { addPendingConflict },
      downloadFile: vi.fn().mockResolvedValue(new Uint8Array([7]).buffer),
      // 留档要读「审阅时的本机版本」：本机文件在磁盘上是真实存在的。
      adapterOverrides: { writeBinary, readBinary: vi.fn().mockResolvedValue(localBytes) },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    // 冲突路径一个字节都没写（留档写的是插件目录下的暂存，不碰库内文件）。
    expect(writeBinary).not.toHaveBeenCalledWith(path, expect.anything());
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      remote: expect.objectContaining({ eTag: "etag-new" }),
    }));
  });

  it("does not write keepRemote content when downloaded bytes fail the reviewed hash", async () => {
    const path = "hash-mismatch.bin";
    const localBytes = new Uint8Array([1]).buffer;
    const local: LocalFileEntry = {
      path, hash: await sha256Hex(localBytes), size: localBytes.byteLength, mtime: 1, binary: true,
    };
    const expectedContent = new Uint8Array([1]).buffer;
    const reviewedRemote = {
      path,
      driveId: "remote-id",
      size: 1,
      mtime: 1,
      eTag: "etag-reviewed",
      cTag: "",
      sha256Hash: await sha256Hex(expectedContent),
    } as RemoteFileEntry;
    const writeBinary = vi.fn();
    const recordMutationReceipt = vi.fn();
    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([2]).buffer);
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{ type: SyncActionType.Conflict, path, local, remote: reviewedRemote }],
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      stateOverrides: { recordMutationReceipt },
      downloadFile,
      // 留档要读「审阅时的本机版本」：本机文件在磁盘上是真实存在的。
      adapterOverrides: { writeBinary, readBinary: vi.fn().mockResolvedValue(localBytes) },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(downloadFile).toHaveBeenCalledTimes(1);
    // 冲突路径一个字节都没写（留档写的是插件目录下的暂存，不碰库内文件）。
    expect(writeBinary).not.toHaveBeenCalledWith(path, expect.anything());
    expect(recordMutationReceipt).not.toHaveBeenCalled();
  });

  it("keeps the local file when a remote deletion decision is stale because the path reappeared", async () => {
    const path = "reappeared.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const remove = vi.fn();
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const removePendingDelete = vi.fn().mockResolvedValue(undefined);
    const executor = makeProgressAwareExecutor({
      pendingRemoteDeletes: [{ type: SyncActionType.ConfirmLocalDelete, path, local }],
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "new-id", size: 1, mtime: 2, eTag: "etag-new",
      }),
      adapterOverrides: { remove },
      stateOverrides: { addPendingConflict, removePendingDelete },
    });

    await executor.confirmRemoteDelete(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(remove).not.toHaveBeenCalledWith(path);
    expect(addPendingConflict).toHaveBeenCalledTimes(1);
    expect(removePendingDelete).toHaveBeenCalledWith(path);
  });

  // P0-G safety subset: a missing path is not proof that the reviewed object
  // is gone (SC-08), and exact SHA-256 equality needs no destructive action.
  describe("side-action drift safety subset", () => {
    it("retires a remote-only conflict when both sides are absent by path and by ID", async () => {
      const path = "gone.md";
      const deleteItem = vi.fn();
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingConflict = vi.fn().mockResolvedValue(undefined);
      const executor = makeProgressAwareExecutor({
        pendingConflicts: [{
          type: SyncActionType.Conflict,
          path,
          remote: { path, driveId: "item-gone", size: 1, mtime: 1, eTag: "etag-gone", cTag: "" },
        }],
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
        deleteItem,
        stateOverrides: { addPendingConflict, removePendingConflict },
      });

      await executor.resolveConflictKeepLocal(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(deleteItem).not.toHaveBeenCalled();
      expect(addPendingConflict).not.toHaveBeenCalled();
      expect(removePendingConflict).toHaveBeenCalledWith(path);
    });

    it("keeps the conflict rebuild when the local file survives a true remote deletion", async () => {
      const path = "kept.md";
      const local: LocalFileEntry = {
        path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
      };
      const uploadFile = vi.fn();
      const remove = vi.fn();
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingConflict = vi.fn().mockResolvedValue(undefined);
      const executor = makeProgressAwareExecutor({
        pendingConflicts: [{
          type: SyncActionType.Conflict,
          path,
          local,
          remote: { path, driveId: "item-kept", size: 1, mtime: 1, eTag: "etag-kept", cTag: "" },
        }],
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
        uploadFile,
        adapterOverrides: { remove },
        stateOverrides: { addPendingConflict, removePendingConflict },
      });

      await executor.resolveConflictKeepLocal(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(uploadFile).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalledWith(path);
      expect(removePendingConflict).not.toHaveBeenCalled();
      expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
        path,
        remote: undefined,
        reason: "reason.remoteDeletedLocalModified",
      }));
    });

    it("retires a conflict whose reviewed object still exists by ID after its path disappeared", async () => {
      const path = "moved.md";
      const deleteItem = vi.fn();
      const uploadFile = vi.fn();
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingConflict = vi.fn().mockResolvedValue(undefined);
      const getDriveItemMetadataById = vi.fn().mockResolvedValue(
        driveItem(path, "aa".repeat(32)),
      );
      const executor = makeProgressAwareExecutor({
        pendingConflicts: [{
          type: SyncActionType.Conflict,
          path,
          remote: { path, driveId: "item-moved", size: 1, mtime: 1, eTag: "etag-moved", cTag: "" },
        }],
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById,
        deleteItem,
        uploadFile,
        stateOverrides: { addPendingConflict, removePendingConflict },
      });

      await executor.resolveConflictKeepLocal(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(getDriveItemMetadataById).toHaveBeenCalledWith("item-moved");
      expect(deleteItem).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(addPendingConflict).not.toHaveBeenCalled();
      expect(removePendingConflict).toHaveBeenCalledWith(path);
    });

    it("retires a pending remote delete when the anchor object is still alive by ID", async () => {
      const path = "moved-delete.md";
      const local: LocalFileEntry = {
        path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
      };
      const remove = vi.fn();
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingDelete = vi.fn().mockResolvedValue(undefined);
      const getDriveItemMetadataById = vi.fn().mockResolvedValue(
        driveItem(path, local.hash),
      );
      const executor = makeProgressAwareExecutor({
        pendingRemoteDeletes: [{ type: SyncActionType.ConfirmLocalDelete, path, local }],
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById,
        adapterOverrides: { remove },
        stateOverrides: {
          addPendingConflict,
          removePendingDelete,
          remoteIdForPath: vi.fn().mockReturnValue("anchor-id"),
        },
      });

      await executor.confirmRemoteDelete(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(getDriveItemMetadataById).toHaveBeenCalledWith("anchor-id");
      expect(remove).not.toHaveBeenCalledWith(path);
      expect(addPendingConflict).not.toHaveBeenCalled();
      expect(removePendingDelete).toHaveBeenCalledWith(path);
    });

    it("rebuilds a deleted row whose path reappeared without a by-ID check", async () => {
      const path = "reappeared-new-object.md";
      const local: LocalFileEntry = {
        path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
      };
      const remove = vi.fn();
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingDelete = vi.fn().mockResolvedValue(undefined);
      const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
      const executor = makeProgressAwareExecutor({
        pendingRemoteDeletes: [{ type: SyncActionType.ConfirmLocalDelete, path, local }],
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "new-id", size: 1, mtime: 2, eTag: "etag-new",
        }),
        getDriveItemMetadataById,
        adapterOverrides: { remove },
        stateOverrides: {
          addPendingConflict,
          removePendingDelete,
          remoteIdForPath: vi.fn().mockReturnValue("anchor-id"),
        },
      });

      await executor.confirmRemoteDelete(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(getDriveItemMetadataById).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalledWith(path);
      expect(addPendingConflict).toHaveBeenCalledTimes(1);
      expect(removePendingDelete).toHaveBeenCalledWith(path);
    });

    it("fails closed when the reviewed object identity cannot be read", async () => {
      const path = "identity-read-failed.md";
      const deleteItem = vi.fn();
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingConflict = vi.fn().mockResolvedValue(undefined);
      const executor = makeProgressAwareExecutor({
        pendingConflicts: [{
          type: SyncActionType.Conflict,
          path,
          remote: { path, driveId: "item-unreadable", size: 1, mtime: 1, eTag: "etag", cTag: "" },
        }],
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockRejectedValue(
          new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
        ),
        deleteItem,
        stateOverrides: { addPendingConflict, removePendingConflict },
      });

      await executor.resolveConflictKeepLocal(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(deleteItem).not.toHaveBeenCalled();
      expect(addPendingConflict).not.toHaveBeenCalled();
      expect(removePendingConflict).not.toHaveBeenCalled();
    });

    for (const direction of ["local", "remote"] as const) {
      it(`retires the conflict when current remote bytes equal the local file (keep ${direction})`, async () => {
        const path = `identical-${direction}.md`;
        const bytes = new Uint8Array([1, 2, 3]).buffer;
        const hash = await sha256Hex(bytes);
        const local: LocalFileEntry = {
          path, hash, size: bytes.byteLength, mtime: 1, binary: false,
        };
        const addPendingConflict = vi.fn().mockResolvedValue(undefined);
        const removePendingConflict = vi.fn().mockResolvedValue(undefined);
        const uploadFile = vi.fn();
        const downloadFile = vi.fn();
        const writeBinary = vi.fn();
        const executor = makeProgressAwareExecutor({
          pendingConflicts: [{
            type: SyncActionType.Conflict,
            path,
            local,
            remote: {
              path, driveId: "remote-id", size: bytes.byteLength, mtime: 1,
              eTag: "etag-reviewed", cTag: "",
            },
          }],
          inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
          getFileMetadata: vi.fn().mockResolvedValue({
            driveId: "remote-id",
            size: bytes.byteLength,
            mtime: 2,
            eTag: "etag-new",
            sha256Hash: hash,
          }),
          adapterOverrides: {
            readBinary: vi.fn().mockResolvedValue(bytes),
            writeBinary,
          },
          uploadFile,
          downloadFile,
          stateOverrides: { addPendingConflict, removePendingConflict },
        });

        if (direction === "local") {
          await executor.resolveConflictKeepLocal(path);
        } else {
          await executor.resolveConflictKeepRemote(path);
        }
        await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

        expect(uploadFile).not.toHaveBeenCalled();
        expect(downloadFile).not.toHaveBeenCalled();
        expect(writeBinary).not.toHaveBeenCalledWith(path, expect.anything());
        expect(addPendingConflict).not.toHaveBeenCalled();
        expect(removePendingConflict).toHaveBeenCalledWith(path);
      });
    }

    it("keeps the conflict when only the size matches and no SHA-256 is available", async () => {
      const path = "size-only.md";
      const local: LocalFileEntry = {
        path, hash: "aa".repeat(32), size: 3, mtime: 1, binary: false,
      };
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingConflict = vi.fn().mockResolvedValue(undefined);
      const downloadFile = vi.fn();
      const executor = makeProgressAwareExecutor({
        pendingConflicts: [{
          type: SyncActionType.Conflict,
          path,
          local,
          remote: { path, driveId: "remote-id", size: 3, mtime: 1, eTag: "etag-reviewed", cTag: "" },
        }],
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id", size: 3, mtime: 2, eTag: "etag-new",
        }),
        adapterOverrides: { readBinary: vi.fn().mockResolvedValue(new Uint8Array(3).buffer) },
        downloadFile,
        stateOverrides: { addPendingConflict, removePendingConflict },
      });

      await executor.resolveConflictKeepRemote(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(downloadFile).not.toHaveBeenCalled();
      expect(removePendingConflict).not.toHaveBeenCalled();
      expect(addPendingConflict).toHaveBeenCalledTimes(1);
    });

    it("keeps the conflict when reviewed and current remote bytes match but the local file differs", async () => {
      const path = "remote-identical-local-different.md";
      const remoteHash = "bb".repeat(32);
      const local: LocalFileEntry = {
        path, hash: "aa".repeat(32), size: 3, mtime: 1, binary: false,
      };
      const addPendingConflict = vi.fn().mockResolvedValue(undefined);
      const removePendingConflict = vi.fn().mockResolvedValue(undefined);
      const downloadFile = vi.fn();
      const writeBinary = vi.fn();
      const executor = makeProgressAwareExecutor({
        pendingConflicts: [{
          type: SyncActionType.Conflict,
          path,
          local,
          remote: {
            path, driveId: "remote-id", size: 3, mtime: 1,
            eTag: "etag-reviewed", cTag: "", sha256Hash: remoteHash,
          },
        }],
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "remote-id", size: 3, mtime: 2, eTag: "etag-new", sha256Hash: remoteHash,
        }),
        adapterOverrides: {
          readBinary: vi.fn().mockResolvedValue(new Uint8Array(3).buffer),
          writeBinary,
        },
        downloadFile,
        stateOverrides: { addPendingConflict, removePendingConflict },
      });

      await executor.resolveConflictKeepRemote(path);
      await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

      expect(downloadFile).not.toHaveBeenCalled();
      expect(writeBinary).not.toHaveBeenCalledWith(path, expect.anything());
      expect(removePendingConflict).not.toHaveBeenCalled();
      expect(addPendingConflict).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a decision when its ancestor or account binding changed", async () => {
    const path = "ancestor.md";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
    };
    const uploadFile = vi.fn();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path,
        local,
        remote: { path, driveId: "id", size: 1, mtime: 1, eTag: "etag", cTag: "" },
        decisionToken: {
          version: 1,
          vaultName: "testVault",
          accountId: "old-account",
          scope: { ...TEST_SYNC_SCOPE, accountId: "old-account" },
          local: { exists: true, hash: local.hash, size: local.size },
          remote: { exists: true, driveId: "id", eTag: "etag" },
          ancestorHash: "old-ancestor",
        },
      }],
      stateOverrides: {
        boundAccountId: "account-test",
        baseSnapshot: [{ path, hash: "new-ancestor", size: 1, eTag: "etag" }],
      },
      uploadFile,
    });

    await executor.resolveConflictKeepLocal(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("queues repeated item actions so later clicks do not fail behind the first transfer", async () => {
    let resolveFirstUpload: ((value: { id: string; eTag: string }) => void) | null = null;
    const startedPaths: string[] = [];
    const progressStore = new SyncProgressStore();
    const uploadFile = vi.fn().mockImplementation(
      (_vaultName: string, path: string) => {
        startedPaths.push(path);
        if (path === "a.md") {
          return new Promise<{ id: string; eTag: string }>((resolve) => {
            resolveFirstUpload = resolve;
          });
        }
        return Promise.resolve({ id: `id-${path}`, eTag: `etag-${path}` });
      },
    );

    const executor = makeProgressAwareExecutor({
      pendingConflicts: [
        {
          type: SyncActionType.Conflict,
          path: "a.md",
          local: { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "a.md", driveId: "id-a", size: 1, mtime: 1, eTag: "etag-a", cTag: "ctag-a" },
        },
        {
          type: SyncActionType.Conflict,
          path: "b.md",
          local: { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "b.md", driveId: "id-b", size: 1, mtime: 1, eTag: "etag-b", cTag: "ctag-b" },
        },
      ],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile,
      progressStore,
    });

    const firstQueued = executor.resolveConflictKeepLocal("a.md");
    const secondQueued = executor.resolveConflictKeepLocal("b.md");
    let settled = false;
    void Promise.all([firstQueued, secondQueued]).then(() => {
      settled = true;
    });

    await waitUntil(() => {
      expect(executor.isSideActionQueued("a.md")).toBe(true);
      expect(executor.isSideActionQueued("b.md")).toBe(true);
      expect(startedPaths).toEqual(["a.md"]);
    });
    expect(settled).toBe(false);
    expect(progressStore.state).toMatchObject({
      phase: "executing",
      current: 1,
      total: 2,
      currentFile: "a.md",
      completedFiles: [],
    });

    resolveFirstUpload?.({ id: "id-a", eTag: "etag-a-new" });
    await waitUntil(() => {
      expect(startedPaths).toEqual(["a.md", "b.md"]);
      expect(progressStore.state.current).toBe(2);
      expect(progressStore.state.total).toBe(2);
      expect(progressStore.state.completedFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "a.md", status: "upload" }),
      ]));
    });
    await waitUntil(() => {
      expect(executor.isSideActionQueued("a.md")).toBe(false);
      expect(executor.isSideActionQueued("b.md")).toBe(false);
      expect(settled).toBe(true);
    });
    expect(progressStore.state.phase).toBe("done");
    expect(progressStore.state.completedFiles).toEqual([
      expect.objectContaining({ path: "a.md", status: "upload" }),
      expect.objectContaining({ path: "b.md", status: "upload" }),
    ]);
  });

  it("queues one remote-delete confirmation batch through the existing side-action progress", async () => {
    const progressStore = new SyncProgressStore();
    const notice = makeNoticeRecorder();
    const localByPath = new Map<string, LocalFileEntry>([
      ["a.md", { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false }],
      ["b.md", { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false }],
    ]);
    let releaseFirstDelete: (() => void) | null = null;
    const remove = vi.fn().mockImplementation((path: string) => {
      if (path !== "a.md") return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirstDelete = resolve;
      });
    });
    const executor = makeProgressAwareExecutor({
      progressStore,
      noticeCenter: notice.center,
      pendingRemoteDeletes: [...localByPath.values()].map((local) => ({
        type: SyncActionType.ConfirmLocalDelete,
        path: local.path,
        local,
      })),
      inspectFile: vi.fn().mockImplementation(async (path: string) => ({
        status: "present",
        entry: localByPath.get(path),
      })),
      adapterOverrides: { remove },
    });

    const completion = executor.confirmRemoteDeletes(["a.md", "b.md"]);
    await waitUntil(() => {
      expect(executor.isSideActionQueued("a.md")).toBe(true);
      expect(executor.isSideActionQueued("b.md")).toBe(true);
      expect(progressStore.state).toMatchObject({
        phase: "executing",
        current: 1,
        total: 2,
        currentFile: "a.md",
      });
    });

    releaseFirstDelete?.();
    await completion;

    expect(remove.mock.calls.map(([path]) => path)).toEqual(["a.md", "b.md"]);
    expect(progressStore.state).toMatchObject({ phase: "done", current: 2, total: 2 });
    expect(progressStore.state.completedFiles).toEqual([
      expect.objectContaining({ path: "a.md", status: "delete" }),
      expect.objectContaining({ path: "b.md", status: "delete" }),
    ]);
    expect(notice.messages).not.toContain("notice.delete.confirmed");
  });

  it("flips the wave's shown delete rows when its shared checkpoint cannot commit", async () => {
    const progressStore = new SyncProgressStore();
    const notice = makeNoticeRecorder();
    const localByPath = new Map<string, LocalFileEntry>([
      ["a.md", { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false }],
      ["b.md", { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false }],
    ]);
    const executor = makeProgressAwareExecutor({
      progressStore,
      noticeCenter: notice.center,
      pendingRemoteDeletes: [...localByPath.values()].map((local) => ({
        type: SyncActionType.ConfirmLocalDelete,
        path: local.path,
        local,
      })),
      inspectFile: vi.fn().mockImplementation(async (path: string) => ({
        status: "present",
        entry: localByPath.get(path),
      })),
      adapterOverrides: { remove: vi.fn().mockResolvedValue(undefined) },
      stateOverrides: {
        commitMutationCheckpoints: vi.fn().mockRejectedValue(
          new Error("shared checkpoint failed"),
        ),
      },
    });

    await executor.confirmRemoteDeletes(["a.md", "b.md"]);

    // 2026-10-26: the wave reports each erase as soon as it lands, and its one
    // shared checkpoint follows. When that checkpoint fails the shown rows must
    // flip to failed with the reason — two rows, not four (no duplicate), and
    // no leftover success.
    expect(progressStore.state.completedFiles).toHaveLength(2);
    expect(progressStore.state.completedFiles).toEqual([
      expect.objectContaining({
        path: "a.md",
        status: "error",
        reason: "shared checkpoint failed",
      }),
      expect.objectContaining({
        path: "b.md",
        status: "error",
        reason: "shared checkpoint failed",
      }),
    ]);
  });

  it("keeps one side-action result batch across sequential conflict clicks", async () => {
    const progressStore = new SyncProgressStore();
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [
        {
          type: SyncActionType.Conflict,
          path: "a.md",
          local: { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "a.md", driveId: "id-a", size: 1, mtime: 1, eTag: "etag-a", cTag: "ctag-a" },
        },
        {
          type: SyncActionType.Conflict,
          path: "b.md",
          local: { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "b.md", driveId: "id-b", size: 1, mtime: 1, eTag: "etag-b", cTag: "ctag-b" },
        },
      ],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile: vi.fn().mockImplementation(async (_vaultName: string, path: string) => ({
        id: `id-${path}`,
        eTag: `etag-${path}`,
      })),
      progressStore,
    });

    await executor.resolveConflictKeepLocal("a.md");
    expect(progressStore.state).toMatchObject({ phase: "done", current: 1, total: 1 });
    expect(progressStore.state.completedFiles.map((file) => file.path)).toEqual(["a.md"]);

    await executor.resolveConflictKeepLocal("b.md");
    expect(progressStore.state).toMatchObject({ phase: "done", current: 2, total: 2 });
    expect(progressStore.state.completedFiles.map((file) => file.path)).toEqual(["a.md", "b.md"]);
  });

  it("invalidates an in-flight side action and drops later queued actions", async () => {
    let resolveFirstUpload: ((value: { eTag: string }) => void) | null = null;
    const updateBaseEntry = vi.fn().mockResolvedValue(undefined);
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
    const removePendingConflict = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockImplementation(
      (_vaultName: string, path: string) => {
        if (path === "a.md") {
          return new Promise<{ eTag: string }>((resolve) => {
            resolveFirstUpload = resolve;
          });
        }
        return Promise.resolve({ eTag: `etag-${path}` });
      },
    );
    const executor = makeProgressAwareExecutor({
      pendingConflicts: [
        {
          type: SyncActionType.Conflict,
          path: "a.md",
          local: { path: "a.md", hash: "aa".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "a.md", driveId: "id-a", size: 1, mtime: 1, eTag: "etag-a", cTag: "ctag-a" },
        },
        {
          type: SyncActionType.Conflict,
          path: "b.md",
          local: { path: "b.md", hash: "bb".repeat(32), size: 1, mtime: 1, binary: false },
          remote: { path: "b.md", driveId: "id-b", size: 1, mtime: 1, eTag: "etag-b", cTag: "ctag-b" },
        },
      ],
      adapterOverrides: {
        readBinary: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer),
      },
      uploadFile,
      stateOverrides: {
        updateBaseEntry,
        applyRemoteMutations,
        removePendingConflict,
      },
    });

    const firstAction = executor.resolveConflictKeepLocal("a.md");
    const secondAction = executor.resolveConflictKeepLocal("b.md");
    await waitUntil(() => {
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(executor.isSideActionQueued("b.md")).toBe(true);
    });

    executor.invalidateLifecycle("unload");
    resolveFirstUpload?.({ eTag: "etag-a-new" });

    await waitUntil(() => {
      expect(executor.hasSideActionsInFlight).toBe(false);
    });
    await Promise.all([firstAction, secondAction]);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(updateBaseEntry).not.toHaveBeenCalled();
    expect(applyRemoteMutations).not.toHaveBeenCalled();
    expect(removePendingConflict).not.toHaveBeenCalled();
  });
});

