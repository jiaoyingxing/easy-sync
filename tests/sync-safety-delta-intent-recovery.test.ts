// 移动／改名意图与回执的 fail-closed
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。 本文件保留同名容器 describe，用例全名与拆分前一致。

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
  it("does not publish a remote-delete receipt while the exact item still exists", async () => {    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-delete-receipt-path-404-only",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
          action: "deleteRemote",
          path: "note.md",
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: "delete-target",
            eTag: "etag-delete-target",
            size: 3,
            sha256Hash: "aa".repeat(32),
          },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-delete-receipt-path-404-only",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [],
            baseRemovals: ["note.md"],
            remoteUpserts: [],
            remoteDeletes: ["note.md"],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue({
          id: "delete-target",
          name: "moved-before-checkpoint.md",
          size: 3,
          eTag: "etag-delete-target",
          file: { hashes: { sha256Hash: "aa".repeat(32) } },
          parentReference: { id: "another-folder" },
        }),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
      }),
      state,
      "testVault",
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(TEST_SYNC_SCOPE)).rejects.toThrow(
      "Mutation receipt no longer matches",
    );
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).not.toBeNull();
  });

  it("recovers an applied unreceipted upload without uploading the file again", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "note.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-response-lost",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-upload-recovered",
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

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(uploadFile).not.toHaveBeenCalled();
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

  it("recovers an applied unreceipted upload by stable content readback when Graph omits SHA-256", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "note.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-response-lost-no-graph-hash",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn();
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getFileMetadata = vi.fn().mockResolvedValue(remote);
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-upload-readback-recovered",
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

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      remote.downloadUrl,
      remote.driveId,
      remote.size,
    );
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(getFileMetadata.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: remote.path,
      driveId: remote.driveId,
      parentId: remote.parentId,
      size: remote.size,
      eTag: remote.eTag,
      cTag: remote.cTag,
      sha256Hash: hash,
    }));
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("restores a missing local file from a version-matched upload receipt before checkpointing", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "restored.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "uploaded-restored",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-restored",
      cTag: "ctag-restored",
      sha256Hash: hash,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-receipted-local-missing",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-upload-receipted-local-missing",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [{
              path: local.path,
              hash,
              size: local.size,
              eTag: remote.eTag,
            }],
            baseRemovals: [],
            remoteUpserts: [remote],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      }],
    });
    const files = new Map<string, ArrayBuffer>();
    const adapter = makeMockAdapter({
      stat: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        return bytes ? { type: "file", size: bytes.byteLength, mtime: 4, ctime: 4 } : null;
      }),
      readBinary: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      }),
      writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
        files.set(path, bytes);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const bytes = files.get(from);
        if (!bytes) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, bytes);
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path);
      }),
    });
    const scanAll = vi.fn(async () => ({
      entries: files.has(local.path) ? [local] : [],
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    }));
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getDelta = vi.fn().mockResolvedValue({
      value: [driveItem(local.path, hash, {
        id: remote.driveId,
        eTag: remote.eTag,
        cTag: remote.cTag,
      })],
      "@odata.deltaLink": "https://graph.example/delta-restored",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta,
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn(async () => files.has(local.path)
          ? { status: "present", entry: local }
          : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const observation = await executor.run(
      "manual",
      {},
      false,
      undefined,
      {
        recoveryOnly: true,
        mutationRecoveryObservationOnly: true,
      },
    );

    expect(observation.success).toBe(false);
    expect(observation.mutationRecovery).toMatchObject({
      state: "blocked",
      remaining: 1,
    });
    expect(files.has(local.path)).toBe(false);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(adapter.rename).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    scanAll.mockClear();
    downloadFile.mockClear();
    getDelta.mockClear();

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(files.get(local.path)).toEqual(content);
    expect(scanAll).toHaveBeenCalledTimes(2);
    expect(downloadFile).toHaveBeenCalledTimes(1);
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

  it("abandons a proven not-applied upload intent before generating a new plan", async () => {
    const content = new Uint8Array([7, 8, 9]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "not-applied.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-upload-never-applied",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: { exists: true, hash, size: local.size },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn().mockResolvedValue({
      id: "new-upload-id",
      eTag: "new-upload-etag",
      cTag: "new-upload-ctag",
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-not-applied",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(undefined),
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
    expect(result.uploaded).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: "new-upload-etag",
    });
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: local.path,
      driveId: "new-upload-id",
      eTag: "new-upload-etag",
      cTag: "new-upload-ctag",
      sha256Hash: hash,
    }));
  });

  it("abandons a proven not-applied moveLocal intent when both paths are absent on both sides", async () => {
    // User scenario (EasySync issue report 20260901): a moveLocalFile record
    // interrupted before confirmation leaves receipt:null. If the move never
    // happened — local source+target and remote source+target are all absent —
    // the intent is provably not-applied and must be auto-settled instead of
    // blocking mutation recovery forever with no executable resolution.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "subdir/moved.md";
    const targetPath = "moved.md";
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-never-applied",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    // Local and remote observations all report absence.
    const getFileMetadata = vi.fn().mockResolvedValue(undefined);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-never-applied",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDelta }),
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

    const result = await executor.run("manual", {});

    // The provably never-applied moveLocal intent is abandoned; mutation
    // recovery settles without any user action (a settled recovery is not
    // surfaced on the run result — only blocked recoveries are).
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.mutationLedger).toEqual([]);
    expect(getFileMetadata).toHaveBeenCalled();
  });

  it("settles a sha-unknown divergent moveLocal record as a plain move without downloading remote bytes", async () => {
    // Field report 2026-09-22 (iOS 1.4.13, F9 case 3): the local side already
    // followed the remote move, the remote identity sits at the target path,
    // but the moved content advanced and Graph provided no sha256Hash (common
    // on OneDrive personal). The recovery classifier must settle the record
    // with the same plain-move receipt contract the execution chain uses
    // (divergence left to the ordinary same-path decision) instead of
    // downloading over the local bytes (A1 stays hash-gated) — the old path
    // produced an unreceiptable checkpoint and blocked recovery forever.
    const localContent = new Uint8Array([3, 1, 4]).buffer;
    const localHash = await sha256Hex(localContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "plan-old.duowei";
    const targetPath = "plan.duowei";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "remote-etag",
      cTag: "remote-ctag",
      size: 4606,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-sha-unknown-divergent",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: {
            exists: true,
            hash: localHash,
            size: localContent.byteLength,
          },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: 4606,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const downloadFile = vi.fn(async () => {
      throw new Error("sha-unknown pure-move settlement must not download remote bytes");
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "remote-drive-id",
        name: "plan.duowei",
        size: 4606,
        eTag: "remote-etag",
        cTag: "remote-ctag",
        lastModifiedDateTime: "2026-09-18T22:49:00.000Z",
        parentReference: { id: activeScope.filesRootId },
        file: { hashes: {} },
      }],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-sha-unknown",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, downloadFile, getDelta }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [{
            path: targetPath,
            size: localContent.byteLength,
            mtime: 1,
            hash: localHash,
            binary: false,
          }],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (path: string) =>
          path === targetPath
            ? {
                status: "present",
                entry: {
                  path,
                  size: localContent.byteLength,
                  mtime: 1,
                  hash: localHash,
                },
              }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    // The record settles automatically (no blocked recovery surfaced) with
    // zero remote downloads: the divergence is recorded honestly in the base
    // snapshot and the ordinary planner converges the bytes next round.
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.mutationLedger).toEqual([]);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(
      state.baseSnapshot.find((entry) => entry.path === targetPath)?.hash,
    ).toBe(localHash);
  });

  it("fails the round and keeps the record when a host merge breaks recovery alignment", async () => {
    // 本线边界（复核轮 `20260923-203102` §六①）：对齐/收据恢复链（`alignLocalTargetBytes`）
    // 写后要求本机字节与远端**完全一致**。宿主把编辑器里未保存的行并进我们的写入时，
    // 落盘门按「合并算落地」记成功（`DECISIONS` 2026-09-23 第 9 点②），但这条链自己的
    // 回读复核不通过 ⇒ 这一轮判失败、记录保留（用户的字仍在文件里，未被回滚）。
    // 改前（门自己按字节复核）与改后（这条链回读失败）在这一角落结局相同，都不静默推进状态。
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const localContent = encoder.encode("local-version\n").buffer;
    const localHash = await sha256Hex(localContent);
    const advancedContent = encoder.encode("remote advanced\n").buffer;
    const advancedHash = await sha256Hex(advancedContent);
    const mergedText = "remote advanced\nunsaved\n";
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const sourcePath = "plan-old.duowei";
    const targetPath = "plan.duowei";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "remote-etag",
      cTag: "remote-ctag",
      size: advancedContent.byteLength,
      sha256Hash: advancedHash,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-align-merged",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: {
            exists: true,
            hash: localHash,
            size: localContent.byteLength,
          },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: 4606,
            // 计划时目标处的远端内容＝被移动的那份（hash 已知是进 A1 对齐的前提）。
            sha256Hash: localHash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const files = new Map<string, ArrayBuffer>([[targetPath, localContent]]);
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) => files.has(path)),
      stat: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        return bytes ? { size: bytes.byteLength, mtime: 2 } : null;
      }),
      readBinary: vi.fn(async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      }),
      writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
        files.set(path, bytes);
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const bytes = files.get(from);
        if (!bytes) throw new Error(`missing ${from}`);
        files.delete(from);
        files.set(to, bytes);
      }),
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const downloadFile = vi.fn(async () => advancedContent);
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "remote-drive-id",
        name: "plan.duowei",
        size: advancedContent.byteLength,
        eTag: "remote-etag",
        cTag: "remote-ctag",
        lastModifiedDateTime: "2026-09-23T20:00:00.000Z",
        parentReference: { id: activeScope.filesRootId },
        file: { hashes: { quickXorHash: "quick" } },
      }],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-align-merged",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, downloadFile, getDelta }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          getFileByPath: vi.fn((path: string) =>
            path === targetPath ? new TFile(targetPath) : null),
          // 宿主写入面：把我们的内容落盘后，又把编辑器里未保存的行合并进去。
          modify: vi.fn(async (file: TFile, data: string) => {
            files.set(file.path, encoder.encode(`${data}unsaved\n`).buffer);
          }),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [{
            path: targetPath,
            size: localContent.byteLength,
            mtime: 1,
            hash: localHash,
            binary: false,
          }],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        // 真机式的本机事实：从磁盘字节算，不写死。
        inspectFile: vi.fn(async (path: string) => {
          const bytes = files.get(path);
          if (!bytes) return { status: "missing" };
          return {
            status: "present",
            entry: {
              path,
              size: bytes.byteLength,
              mtime: 2,
              hash: await sha256Hex(bytes),
            },
          };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const failure = await executor.run("manual", {}).catch((caught: unknown) => caught);

    // 这一轮判失败，恢复报成 blocked（不是静默推进、也不是静默延后），记录保留，
    // 用户的未保存行仍在文件里（没有被回滚掉）。
    expect(failure).toMatchObject({
      success: false,
      errors: 1,
      message: "result.syncFailed",
      mutationRecovery: {
        state: "blocked",
        total: 1,
        settled: 0,
        remaining: 1,
        blockReason: "state-unavailable",
      },
    });
    expect(state.mutationLedger).toHaveLength(1);
    expect(decoder.decode(files.get(targetPath)!)).toBe(mergedText);
  });

  it("keeps a sha-unknown moveLocal blocked without downloading when the observed size contradicts the plan", async () => {
    // Adversarial (review 2026-09-22): a server-side inconsistency (same
    // eTag, different size than planned) must NOT fall through to the A1
    // alignment — downloading over the local file and producing an
    // unreceiptable checkpoint would crash the recovery batch the same way
    // the field report did. The record stays blocked (reviewable) instead.
    const localContent = new Uint8Array([3, 1, 4]).buffer;
    const localHash = await sha256Hex(localContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "plan-old.duowei";
    const targetPath = "plan.duowei";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "remote-etag",
      cTag: "remote-ctag",
      // Same eTag as planned but a contradictory size (planned: 3).
      size: 4606,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-sha-unknown-size-contradiction",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: {
            exists: true,
            hash: localHash,
            size: localContent.byteLength,
          },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: localContent.byteLength,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const downloadFile = vi.fn(async () => {
      throw new Error("contradictory sha-unknown move must not download");
    });
    const downloadFileToPath = vi.fn(async () => {
      throw new Error("contradictory sha-unknown move must not download");
    });
    const getDelta = vi.fn().mockResolvedValue({
      // Empty delta keeps the ordinary round quiet (nothing anchored on
      // either side to plan); the recovery classifier observes live facts
      // through getFileMetadata/inspectFile, not this snapshot.
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-contradictory",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, downloadFile, downloadFileToPath, getDelta }),
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
        inspectFile: vi.fn(async (path: string) =>
          path === targetPath
            ? {
                status: "present",
                entry: {
                  path,
                  size: localContent.byteLength,
                  mtime: 1,
                  hash: localHash,
                },
              }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    // Blocked and reviewable — with zero downloads and zero local overwrites.
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
    expect(state.mutationLedger).toHaveLength(1);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(downloadFileToPath).not.toHaveBeenCalled();
    expect(state.baseSnapshot.find((entry) => entry.path === targetPath)).toBeUndefined();
  });

  it("settles a sha-unknown renameRemote record whose moved eTag advanced (F17)", async () => {
    // Field report 2026-09-28 (Desktop 1.5.0, F17): the remote rename itself
    // succeeded, but its receipt could never be written — the shared
    // moveLocal shape bound the receipt eTag to the untouched pre-move
    // remote world, unreachable for an action that changes the eTag by
    // definition. The record stayed intent-only forever and the recovery
    // batch blocked every round. The renameRemote own shape settles on the
    // move anchors (identity + preserved size); the moved eTag/hash are
    // recorded as read back.
    const localContent = new Uint8Array([3, 1, 4]).buffer;
    const localHash = await sha256Hex(localContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "plan-old.duowei";
    const targetPath = "plan.duowei";
    const sourceRemote: RemoteFileEntry = {
      path: sourcePath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "etag-pre-move",
      cTag: "ctag-pre-move",
      size: 3,
    };
    const movedRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "etag-post-move",
      cTag: "ctag-post-move",
      size: 3,
    };
    const state = makeActiveV2State([sourceRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-rename-remote-sha-unknown",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: {
            exists: true,
            hash: localHash,
            size: 3,
          },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "etag-pre-move",
            size: 3,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_v: string, path: string) =>
        path === targetPath ? movedRemote : undefined,
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [{
            path: targetPath,
            size: 3,
            mtime: 1,
            hash: localHash,
            binary: false,
          }],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (path: string) =>
          path === targetPath
            ? {
                status: "present",
                entry: {
                  path,
                  size: 3,
                  mtime: 1,
                  hash: localHash,
                },
              }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.mutationRecovery).toBeUndefined();
    expect(state.mutationLedger).toEqual([]);
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-rename-remote-sha-unknown",
        checkpoint: expect.objectContaining({
          remoteUpserts: [expect.objectContaining({
            path: targetPath,
            driveId: "remote-drive-id",
            eTag: "etag-post-move",
          })],
        }),
      }),
    );
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: targetPath,
      driveId: "remote-drive-id",
      eTag: "etag-post-move",
      sha256Hash: undefined,
    }));
  });

  it("keeps a sha-unknown renameRemote blocked when the moved object size contradicts the plan (F17 adversarial)", async () => {
    // Adversarial (F17, mirroring the moveLocal size-contradiction guard):
    // a same-identity object at the target path whose size differs from the
    // planned world was replaced, not moved — the plain-move settlement must
    // not fire and the record stays blocked (reviewable).
    const localContent = new Uint8Array([3, 1, 4]).buffer;
    const localHash = await sha256Hex(localContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "plan-old.duowei";
    const targetPath = "plan.duowei";
    const sourceRemote: RemoteFileEntry = {
      path: sourcePath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "etag-pre-move",
      cTag: "ctag-pre-move",
      size: 3,
    };
    const movedRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "etag-post-move",
      cTag: "ctag-post-move",
      // Same identity as planned but a contradictory size (planned: 3).
      size: 4606,
    };
    const state = makeActiveV2State([sourceRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-rename-remote-sha-unknown-size-contradiction",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: {
            exists: true,
            hash: localHash,
            size: 3,
          },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "etag-pre-move",
            size: 3,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_v: string, path: string) =>
        path === targetPath ? movedRemote : undefined,
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [{
            path: targetPath,
            size: 3,
            mtime: 1,
            hash: localHash,
            binary: false,
          }],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (path: string) =>
          path === targetPath
            ? {
                status: "present",
                entry: {
                  path,
                  size: 3,
                  mtime: 1,
                  hash: localHash,
                },
              }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.baseSnapshot.find((entry) => entry.path === targetPath)).toBeUndefined();
  });

  it("records a renameRemote execution receipt honestly in the sha-unknown world (F17)", async () => {
    // Field report 2026-09-28 (Desktop 1.5.0, F17): the execution chain used
    // to stamp the moved remote object with the LOCAL file's hash. In the
    // sha-unknown world that fabrication made the receipt unwritable (the
    // shape gate requires an honest sha-less record) and the whole round
    // crashed into "shared state checkpoint stopped". The receipt must carry
    // the moved object's own world: the source object's hash as last
    // observed (absent here) and the post-move eTag.
    const localContent = new Uint8Array([3, 1, 4]).buffer;
    const localHash = await sha256Hex(localContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "plan-old.duowei";
    const targetPath = "plan.duowei";
    const sourceRemote: RemoteFileEntry = {
      path: sourcePath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "etag-pre-move",
      cTag: "ctag-pre-move",
      size: 3,
    };
    const movedRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "remote-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "etag-post-move",
      cTag: "ctag-post-move",
      size: 3,
    };
    const state = makeActiveV2State(
      [sourceRemote],
      [{ path: sourcePath, hash: localHash, size: 3, eTag: "etag-pre-move" }],
    );
    // Stateful live world: the rename flips what Graph reports (source gone,
    // target present), so the planner plans the rename and the execution
    // chain actually performs it (renameItem called once).
    let moved = false;
    const performMove = vi.fn().mockImplementation(async () => {
      moved = true;
      return {
        id: "remote-drive-id",
        name: "plan.duowei",
        size: 3,
        eTag: "etag-post-move",
        cTag: "ctag-post-move",
        parentReference: { id: activeScope.filesRootId },
        file: { hashes: {} },
      };
    });
    const moveItemById = performMove;
    const renameItem = performMove;
    const getFileMetadata = vi.fn().mockImplementation(
      async (_v: string, path: string) => {
        if (moved) return path === targetPath ? movedRemote : undefined;
        return path === sourcePath ? sourceRemote : undefined;
      },
    );
    const planLogs: unknown[] = [];
    const executor = new SyncExecutor(
      makeMockOneDrive({ renameItem, moveItemById, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [{
            path: targetPath,
            size: 3,
            mtime: 1,
            hash: localHash,
            binary: false,
          }],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (path: string) =>
          path === targetPath
            ? {
                status: "present",
                entry: {
                  path,
                  size: 3,
                  mtime: 1,
                  hash: localHash,
                },
              }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      {
        isEnabled: vi.fn((category: string) => category !== "onedrive"),
        log: vi.fn((...args: unknown[]) => planLogs.push(args)),
        warn: vi.fn((...args: unknown[]) => planLogs.push(args)),
        error: vi.fn(),
      } as unknown as DiagnosticLogger,
    );

    const result = await executor.run("manual", {});

    console.log("F17-EXE-DBG", JSON.stringify({
      success: result.success,
      filesMoved: result.filesMoved,
      message: result.message,
      renameCalls: renameItem.mock.calls.length,
      planLogs,
    }));

    expect(result.success).toBe(true);
    expect(moveItemById).toHaveBeenCalledOnce();
    expect(state.mutationLedger).toEqual([]);
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          remoteUpserts: [expect.objectContaining({
            path: targetPath,
            driveId: "remote-drive-id",
            eTag: "etag-post-move",
          })],
        }),
      }),
    );
    const receipt = state.recordMutationReceipt.mock.calls.at(-1)?.[0] as {
      checkpoint: { remoteUpserts: Array<{ sha256Hash?: string }> };
    };
    expect(receipt.checkpoint.remoteUpserts[0].sha256Hash).toBeUndefined();
    expect(state.remoteSnapshot).toContainEqual(expect.objectContaining({
      path: targetPath,
      driveId: "remote-drive-id",
      eTag: "etag-post-move",
      sha256Hash: undefined,
    }));
    expect(state.baseSnapshot).toContainEqual(expect.objectContaining({
      path: targetPath,
      hash: localHash,
    }));
  });

  it("does not auto-settle a moveLocal intent when the remote source still exists and the expected remote identity stays alive", async () => {
    // The remote source still holding the file alone does not block
    // settlement (A2 20260902: local source+target gone + remote
    // target absent + dead expected remote id is provably not-applied).
    // What still blocks is a live expected remote identity: the remote
    // object may have moved to a third path, so keep the record blocked.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const sourceRemote: RemoteFileEntry = {
      path: sourcePath,
      driveId: "source-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "source-etag",
      cTag: "source-ctag",
      size: content.byteLength,
      sha256Hash: hash,
    };
    const state = makeActiveV2State([sourceRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-source-remote-exists",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === sourcePath ? sourceRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue({
      id: "remote-drive-id",
      eTag: "remote-etag",
      cTag: "remote-ctag",
      size: content.byteLength,
      file: {},
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-source-exists",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDriveItemMetadataById, getDelta }),
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

    const result = await executor.run("manual", {});

    expect(getDriveItemMetadataById).toHaveBeenCalledWith("remote-drive-id");
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("does not auto-settle a moveLocal intent when the remote target still exists", async () => {
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "target-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "target-etag",
      cTag: "target-ctag",
      size: content.byteLength,
      sha256Hash: hash,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-target-remote-exists",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-target-exists",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDelta }),
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

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("abandons a proven not-applied moveLocal intent when both local paths are gone and only the remote source survives", async () => {
    // User scenario (EasySync feedback 20260902, Android 1.4.1, vault
    // 个人知识库-ZGY): a moveLocalFile record interrupted before confirmation
    // leaves receipt:null. Local source and target are both gone while the
    // remote source still exists (48.8KB) and the remote target is absent.
    // The expected remote target identity being gone (404) proves the remote
    // move never happened; the local double absence proves no local result
    // survives. Provably not-applied — abandoning only stops tracking and
    // keeps the remote source file, which then re-syncs as an ordinary file
    // (user-confirmed keep decision 2026-09-02; download-back behavior is a
    // real-device follow-up).
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const sourceRemote: RemoteFileEntry = {
      path: sourcePath,
      driveId: "source-drive-id",
      parentId: activeScope.filesRootId,
      eTag: "source-etag",
      cTag: "source-ctag",
      size: content.byteLength,
      sha256Hash: hash,
    };
    const state = makeActiveV2State([sourceRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-a2-remote-source-survives",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    // Remote source exists; the expected remote target id is dead (404).
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === sourcePath ? sourceRemote : undefined);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-a2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDelta }),
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

    const result = await executor.run("manual", {});

    // The provably never-applied moveLocal intent is abandoned; the remote
    // source file itself is untouched (kept, re-syncs as an ordinary file).
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.mutationLedger).toEqual([]);
    expect(getFileMetadata).toHaveBeenCalled();
  });

  it("does not auto-settle a moveLocal intent when the local source still exists", async () => {
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const sourceLocal: LocalFileEntry = {
      path: sourcePath,
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-source-local-exists",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "remote-drive-id",
            eTag: "remote-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockResolvedValue(undefined);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-source-local-exists",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDelta }),
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
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === sourcePath
            ? { status: "present", entry: sourceLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("does not auto-settle a moveLocal intent when the expected remote identity still lives elsewhere", async () => {
    // The remote object may have moved to a third path: both the source and
    // target paths are absent, but the expected remote identity still exists
    // by id. Path absence alone is not identity absence — the intent must
    // stay blocked for manual review (the recovery modal's missing/missing
    // view) instead of being auto-abandoned.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const remoteDriveId = "remote-drive-id-live-elsewhere";
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-identity-lives-elsewhere",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: remoteDriveId,
            eTag: "remote-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    // The expected remote identity is still alive at another path.
    const getFileMetadata = vi.fn().mockResolvedValue(undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue({
      id: remoteDriveId,
      eTag: "remote-etag",
      cTag: "remote-ctag",
      size: content.byteLength,
      file: {},
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-identity-elsewhere",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById,
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

    const result = await executor.run("manual", {});

    expect(getDriveItemMetadataById).toHaveBeenCalledWith(remoteDriveId);
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("does not auto-settle a moveLocal intent when the expected remote driveId is empty (finding ⑤, fail-closed)", async () => {
    // Persisted intents written by old/corrupt data can carry driveId: "".
    // The four-absence shape must NOT settle then: an empty id proves nothing
    // about identity absence, so the classifier falls through to the
    // conservative branch and keeps the record (review 2026-09-02 finding ⑤,
    // C4 vs C5 adjudication: C4 correct — the exists gate must not be read
    // as a driveId gate, and an empty id must not short-circuit the ID-404
    // proof into "not-applied").
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-movelocal-empty-drive-id",
          planRevision: 1,
          scope: activeScope,
          action: "moveLocal",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "",
            eTag: "remote-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockResolvedValue(undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-movelocal-empty-drive-id",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById,
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

    const result = await executor.run("manual", {});

    // Fail-closed: the intent is NOT abandoned (no "not-applied" claim is
    // provable with an empty id) and the ID-404 proof is never even attempted.
    expect(getDriveItemMetadataById).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  // --- renameRemote auto-close (mirrors moveLocal A2, 2026-09-06) ---
  // Gap: classifyUnreceiptedMutation renameRemote branch (sync-executor.ts:13871)
  // unconditionally returns null when target.driveId !== expectedRemote.driveId,
  // unlike the upload branch (13810–13816) which checks whether the expected ID
  // is dead (byId 404) before giving up.  When the remote source is gone, the
  // target exists with a drifted driveId, the expected id is 404, and the target
  // content matches the local file, the rename is provably complete — converge.

  it("abandons a proven not-applied renameRemote intent when the remote source is gone, target exists with drifted identity, and the expected remote identity is dead", async () => {
    // renameRemote mirror of moveLocal A2 "three-missing-one": the remote
    // source is absent (the rename moved the item away), the target exists
    // with a new driveId, and the old expected driveId is gone (404).  The
    // target content still matches local, proving the rename completed.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const expectedDriveId = "renameremote-expected-id";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-new-id",
      parentId: activeScope.filesRootId,
      eTag: "target-etag",
      cTag: "target-ctag",
      size: content.byteLength,
      sha256Hash: hash,
    };
    const targetLocal: LocalFileEntry = {
      path: targetPath,
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-id-dead-converge",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: expectedDriveId,
            eTag: "old-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    // Remote source missing; target exists with new driveId; old id dead.
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-converge",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDriveItemMetadataById, getDelta }),
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
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === targetPath
            ? { status: "present", entry: targetLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    // The provably completed renameRemote is auto-settled: the ledger is
    // cleared with a checkpoint that updates the base to the new driveId.
    expect(getDriveItemMetadataById).toHaveBeenCalledWith(expectedDriveId);
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.mutationLedger).toEqual([]);
  });

  it("does not auto-settle a renameRemote intent when the expected remote identity still lives (byId)", async () => {
    // The expected driveId still resolves to a live item — the rename may
    // have moved the object to a third path.  Keep the record blocked;
    // do not guess.  Mirror of moveLocal safety control L9019.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const expectedDriveId = "renameremote-still-alive-id";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-new-id",
      parentId: activeScope.filesRootId,
      eTag: "target-etag",
      cTag: "target-ctag",
      size: content.byteLength,
      sha256Hash: hash,
    };
    const targetLocal: LocalFileEntry = {
      path: targetPath,
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-id-alive",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: expectedDriveId,
            eTag: "old-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    // Expected ID is still alive — byId returns a live item.
    const getDriveItemMetadataById = vi.fn().mockResolvedValue({
      id: expectedDriveId,
      eTag: "still-alive-etag",
      cTag: "still-alive-ctag",
      size: content.byteLength,
      file: {},
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-id-alive",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDriveItemMetadataById, getDelta }),
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
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === targetPath
            ? { status: "present", entry: targetLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(getDriveItemMetadataById).toHaveBeenCalledWith(expectedDriveId);
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("does not auto-settle a renameRemote intent when the expected remote driveId is empty (fail-closed)", async () => {
    // Empty expected driveId proves nothing about identity absence; the
    // classifier must keep the record.  Mirror of moveLocal safety control
    // L9105 (finding ⑤, C4 correct).
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-new-id",
      parentId: activeScope.filesRootId,
      eTag: "target-etag",
      cTag: "target-ctag",
      size: content.byteLength,
      sha256Hash: hash,
    };
    const targetLocal: LocalFileEntry = {
      path: targetPath,
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-empty-driveid",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "",
            eTag: "old-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-empty-driveid",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDriveItemMetadataById, getDelta }),
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
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === targetPath
            ? { status: "present", entry: targetLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    // Fail-closed: empty driveId cannot prove identity absence; byId is never
    // attempted and the record stays blocked.
    expect(getDriveItemMetadataById).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("does not auto-settle a renameRemote intent when the remote source still exists", async () => {
    // The remote source path still holds a file — the rename may not have
    // been applied remotely.  Keep the record blocked.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const expectedDriveId = "renameremote-source-exists-id";
    const sourceRemote: RemoteFileEntry = {
      path: sourcePath,
      driveId: expectedDriveId,
      parentId: activeScope.filesRootId,
      eTag: "source-etag",
      cTag: "source-ctag",
      size: content.byteLength,
      sha256Hash: hash,
    };
    const state = makeActiveV2State([sourceRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-source-exists",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: expectedDriveId,
            eTag: "old-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    // Remote source still exists; target is absent.
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === sourcePath ? sourceRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-source-exists",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDriveItemMetadataById, getDelta }),
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

    const result = await executor.run("manual", {});

    // Remote source still holds the file — rename is unconfirmed.
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("does not auto-settle a renameRemote intent when the target content differs from the expected local", async () => {
    // The target driveId drifted and the old id is dead, but the remote
    // content no longer matches local — the rename may have been followed
    // by a remote content edit.  Keep the record blocked.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const otherContent = new Uint8Array([5, 6, 7]).buffer;
    const hash = await sha256Hex(content);
    const otherHash = await sha256Hex(otherContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const expectedDriveId = "renameremote-content-mismatch-id";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-new-id",
      parentId: activeScope.filesRootId,
      eTag: "target-etag",
      cTag: "target-ctag",
      size: otherContent.byteLength,
      sha256Hash: otherHash,
    };
    const targetLocal: LocalFileEntry = {
      path: targetPath,
      hash,  // local hash differs from remote
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-content-mismatch",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: expectedDriveId,
            eTag: "old-etag",
            size: content.byteLength,
            sha256Hash: hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-content-mismatch",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata, getDriveItemMetadataById, getDelta }),
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
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === targetPath
            ? { status: "present", entry: targetLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    // Identity drifted ok but content mismatch — cannot prove rename
    // outcome, keep blocked.
    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  // --- renameRemote whose local copy is gone after the move landed (F20) ---
  // Field report 2026-10-03 (Desktop 1.5.4): the cloud rename had landed and
  // the user then deleted the local file. Every round blocked the record
  // (facts-changed / outcome-unresolved), the auto-settlement scheduler stayed
  // idle, auto sync stayed paused, and the manual review modal offered no
  // keep-side button at all — leaving "reset" as the only exit.
  // The move anchors already prove the rename; the local presence the plain
  // branch requires was only corroboration, and the content proof is
  // intent.expectedLocal.hash, which the intent carried from creation.

  it("settles a renameRemote whose moved remote survived while the local copy was deleted (F20)", async () => {
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "未命名.base";
    const targetPath = "知识库/99归档/错题截图/未命名.base";
    // OneDrive personal reports no sha256Hash for this item — the world that
    // blocked F11/F17's remote-side receipt shapes.
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-moved-id",
      parentId: "remote-folder-id-3",
      downloadUrl: "https://graph.example/target",
      eTag: "target-etag",
      cTag: "target-ctag",
      size: content.byteLength,
    };
    const state = makeActiveV2State([targetRemote], [], {
      // Cross-directory move, like the field report: the source sat at the
      // vault root and the target two folders deep.
      remoteFolders: [
        {
          path: "知识库",
          driveId: "remote-folder-id-1",
          parentId: activeScope.filesRootId,
          name: "知识库",
        },
        {
          path: "知识库/99归档",
          driveId: "remote-folder-id-2",
          parentId: "remote-folder-id-1",
          name: "99归档",
        },
        {
          path: "知识库/99归档/错题截图",
          driveId: "remote-folder-id-3",
          parentId: "remote-folder-id-2",
          name: "错题截图",
        },
      ],
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-local-deleted",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "renameremote-old-id",
            eTag: "old-etag",
            size: content.byteLength,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-local-deleted",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById,
        downloadFile,
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
          folders: [
            { path: "知识库" },
            { path: "知识库/99归档" },
            { path: "知识库/99归档/错题截图" },
          ],
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

    const result = await executor.run("manual", {});

    expect(getDriveItemMetadataById).toHaveBeenCalledWith("renameremote-old-id");
    // The remote reports no sha, so the content proof must read the bytes.
    expect(downloadFile).toHaveBeenCalled();
    expect(state.mutationLedger).toEqual([]);
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-renameremote-local-deleted",
        checkpoint: expect.objectContaining({
          baseRemovals: [sourcePath],
          baseUpserts: [{
            path: targetPath,
            hash,
            size: content.byteLength,
            eTag: "target-etag",
          }],
          remoteDeletes: [sourcePath],
        }),
      }),
    );
  });

  it("keeps a renameRemote blocked when the local copy is gone but the moved remote content diverged (F20 adversarial)", async () => {
    // Identity drifted ok, the old id is dead, the local copy is gone — but
    // the bytes now at the target are not the ones the intent moved. The
    // rename may have been followed by a remote edit; stay blocked.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const otherContent = new Uint8Array([5, 6, 7]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-diverged-id",
      parentId: activeScope.filesRootId,
      downloadUrl: "https://graph.example/target",
      eTag: "target-etag",
      cTag: "target-ctag",
      size: otherContent.byteLength,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-local-deleted-diverged",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "renameremote-old-id",
            eTag: "old-etag",
            size: content.byteLength,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const downloadFile = vi.fn().mockResolvedValue(otherContent);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-diverged",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById,
        downloadFile,
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

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("keeps a renameRemote blocked when the local copy is gone from the target but still sits at the source path (F20 adversarial)", async () => {
    // "Deleted at the new path, present at the old path" is a move back, not a
    // deletion. Settling would rebind the base while the user's own copy is
    // still tracked; keep it blocked for a human.
    const content = new Uint8Array([3, 1, 4]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "a.md";
    const targetPath = "b.md";
    const sourceLocal: LocalFileEntry = {
      path: sourcePath,
      hash,
      size: content.byteLength,
      mtime: 1,
      binary: false,
    };
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-moved-back-id",
      parentId: activeScope.filesRootId,
      downloadUrl: "https://graph.example/target",
      eTag: "target-etag",
      cTag: "target-ctag",
      size: content.byteLength,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-moved-back",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "renameremote-old-id",
            eTag: "old-etag",
            size: content.byteLength,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-moved-back",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById,
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [sourceLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === sourcePath
            ? { status: "present", entry: sourceLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  // --- renameRemote whose local copy was edited after the move landed (2026-10-14) ---
  // Second shape of the F20 family (field report 2026-10-13): the cloud rename
  // landed and the local file was then edited or replaced, so the plain
  // branch's "local unchanged" precondition can never hold again — every round
  // blocked the record and the review modal offered no keep-side button. The
  // move anchors prove the rename; the baseline must describe what the remote
  // actually holds, so the bytes are read back and the local edit is left to
  // the next ordinary round.

  it("settles a renameRemote whose moved remote survived while the local file was edited", async () => {
    const movedContent = new Uint8Array([3, 1, 4]).buffer;
    const editedContent = new Uint8Array([2, 7, 1, 8, 5]).buffer;
    const movedHash = await sha256Hex(movedContent);
    const editedHash = await sha256Hex(editedContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "无标题 2.md";
    const targetPath = "弟弟推荐的短剧.md";
    const editedLocal: LocalFileEntry = {
      path: targetPath,
      hash: editedHash,
      size: editedContent.byteLength,
      mtime: 2,
      binary: false,
    };
    // OneDrive personal reports no sha256Hash for this item — the world that
    // blocked F11/F17's remote-side receipt shapes.
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-edited-id",
      parentId: activeScope.filesRootId,
      downloadUrl: "https://graph.example/target",
      eTag: "target-etag",
      cTag: "target-ctag",
      size: movedContent.byteLength,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-local-edited",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash: movedHash, size: movedContent.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "renameremote-old-id",
            eTag: "old-etag",
            size: movedContent.byteLength,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const getDriveItemMetadataById = vi.fn().mockResolvedValue(null);
    const downloadFile = vi.fn().mockResolvedValue(movedContent);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-local-edited",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById,
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [editedLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === targetPath
            ? { status: "present", entry: editedLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(getDriveItemMetadataById).toHaveBeenCalledWith("renameremote-old-id");
    // The remote reports no sha, so the baseline hash must come from the
    // readback — never from the local file the user has since edited.
    expect(downloadFile).toHaveBeenCalled();
    expect(state.mutationLedger).toEqual([]);
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-renameremote-local-edited",
        checkpoint: expect.objectContaining({
          baseRemovals: [sourcePath],
          baseUpserts: [{
            path: targetPath,
            hash: movedHash,
            size: movedContent.byteLength,
            eTag: "target-etag",
          }],
          remoteDeletes: [sourcePath],
        }),
      }),
    );
  });

  it("keeps an edited-copy renameRemote blocked when the readback cannot prove a stable version", async () => {
    // The moved object changed again while its bytes were being read back, so
    // the content version at the target cannot be stated honestly — stay
    // blocked rather than write a baseline that may be wrong.
    const movedContent = new Uint8Array([3, 1, 4]).buffer;
    const editedContent = new Uint8Array([2, 7, 1, 8, 5]).buffer;
    const movedHash = await sha256Hex(movedContent);
    const editedHash = await sha256Hex(editedContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "无标题 2.md";
    const targetPath = "弟弟推荐的短剧.md";
    const editedLocal: LocalFileEntry = {
      path: targetPath,
      hash: editedHash,
      size: editedContent.byteLength,
      mtime: 2,
      binary: false,
    };
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-unstable-id",
      parentId: activeScope.filesRootId,
      downloadUrl: "https://graph.example/target",
      eTag: "target-etag",
      cTag: "target-ctag",
      size: movedContent.byteLength,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-unstable-readback",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash: movedHash, size: movedContent.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "renameremote-old-id",
            eTag: "old-etag",
            size: movedContent.byteLength,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    let downloaded = false;
    const downloadFile = vi.fn().mockImplementation(async () => {
      downloaded = true;
      return movedContent;
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) => {
      if (path !== targetPath) return undefined;
      // Same object while it is inspected before the read, a new eTag after it.
      return downloaded ? { ...targetRemote, eTag: "target-etag-2" } : targetRemote;
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-unstable",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [editedLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) =>
          path === targetPath
            ? { status: "present", entry: editedLocal }
            : { status: "missing" }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("keeps an edited-copy renameRemote blocked while a local copy still sits at the source path", async () => {
    // "Edited at the new path, present at the old path" is a move back, not a
    // rename that landed — settling would rebind the base while the user's own
    // copy is still tracked.
    const movedContent = new Uint8Array([3, 1, 4]).buffer;
    const editedContent = new Uint8Array([2, 7, 1, 8, 5]).buffer;
    const movedHash = await sha256Hex(movedContent);
    const editedHash = await sha256Hex(editedContent);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const sourcePath = "无标题 2.md";
    const targetPath = "弟弟推荐的短剧.md";
    const sourceLocal: LocalFileEntry = {
      path: sourcePath,
      hash: movedHash,
      size: movedContent.byteLength,
      mtime: 1,
      binary: false,
    };
    const editedLocal: LocalFileEntry = {
      path: targetPath,
      hash: editedHash,
      size: editedContent.byteLength,
      mtime: 2,
      binary: false,
    };
    const targetRemote: RemoteFileEntry = {
      path: targetPath,
      driveId: "renameremote-moved-back-edited-id",
      parentId: activeScope.filesRootId,
      downloadUrl: "https://graph.example/target",
      eTag: "target-etag",
      cTag: "target-ctag",
      size: movedContent.byteLength,
    };
    const state = makeActiveV2State([targetRemote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-renameremote-moved-back-edited",
          planRevision: 1,
          scope: activeScope,
          action: "renameRemote",
          path: targetPath,
          sourcePath,
          expectedLocal: { exists: true, hash: movedHash, size: movedContent.byteLength },
          expectedRemote: {
            exists: true,
            driveId: "renameremote-old-id",
            eTag: "old-etag",
            size: movedContent.byteLength,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getFileMetadata = vi.fn().mockImplementation(async (_v: string, path: string) =>
      path === targetPath ? targetRemote : undefined);
    const downloadFile = vi.fn().mockResolvedValue(movedContent);
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-renameremote-moved-back-edited",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata,
        getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
        downloadFile,
        getDelta,
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [sourceLocal, editedLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          if (path === sourcePath) return { status: "present", entry: sourceLocal };
          if (path === targetPath) return { status: "present", entry: editedLocal };
          return { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(state.mutationLedger).toHaveLength(1);
    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
  });

  it("defers an upload when the file changes after scan without leaving a mutation intent", async () => {
    const scannedContent = new Uint8Array([1, 2, 3]).buffer;
    const currentContent = new Uint8Array([4, 5, 6, 7]).buffer;
    const local: LocalFileEntry = {
      path: "actively-edited.md",
      hash: await sha256Hex(scannedContent),
      size: scannedContent.byteLength,
      mtime: 1,
      binary: false,
    };
    const currentLocal: LocalFileEntry = {
      ...local,
      hash: await sha256Hex(currentContent),
      size: currentContent.byteLength,
      mtime: 2,
    };
    const state = makeActiveV2State([], []);
    const uploadFile = vi.fn();
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-upload-drift",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, getDelta }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(currentContent) }),
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
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: currentLocal }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
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
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });

});
