// 账本重建与观察提交
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。 本文件保留同名容器 describe，用例全名与拆分前一致。

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
import type { MutationRecoveryRunSummary } from "../src/sync/types";
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

  it("rebuilds a capsule-shaped state without leaking either path of the retained remote identity", async () => {
    const baseHash = "aa".repeat(32);
    const localHash = "bb".repeat(32);
    const unrelatedBytes = new TextEncoder().encode("new note").buffer;
    const unrelatedHash = await sha256Hex(unrelatedBytes);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const originalFolder: RemoteFolderEntry = {
      path: "Notes",
      driveId: "folder-notes",
      parentId: activeScope.filesRootId,
      name: "Notes",
    };
    const originalRemote: RemoteFileEntry = {
      path: "Notes/note.md",
      driveId: "protected-id",
      parentId: originalFolder.driveId,
      size: 3,
      mtime: 1,
      eTag: "protected-etag",
      cTag: "protected-ctag",
      sha256Hash: baseHash,
    };
    const base: BaseFileEntry = {
      path: originalRemote.path,
      hash: baseHash,
      size: originalRemote.size,
      eTag: originalRemote.eTag,
    };
    const state = makeActiveV2State([], [base], {
      remoteFolders: [],
      remoteDeltaLink: null,
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-moved-unresolved",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: originalRemote.path,
          expectedLocal: {
            exists: true,
            hash: baseHash,
            size: originalRemote.size,
          },
          expectedRemote: {
            exists: true,
            driveId: originalRemote.driveId,
            eTag: originalRemote.eTag,
            size: originalRemote.size,
            sha256Hash: baseHash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    vi.mocked(state.getCommittedV2Envelope).mockImplementation(() => {
      const movedEnvelope = createFileStateShadowEnvelopeV2({
        scope: activeScope,
        lifecycleEpoch: 2,
        commitSeq: 2,
        committedAt: 2,
        remoteEntries: state.remoteSnapshot,
        remoteFolders: state.remoteFolders,
        baseEntries: [],
      });
      movedEnvelope.anchors.byAnchorId = {
        "file:protected-id": {
          anchorId: "file:protected-id",
          remoteId: originalRemote.driveId,
          lastPath: originalRemote.path,
          contentHash: base.hash,
          size: base.size,
          remoteETag: base.eTag,
          confirmedAt: 1,
          confirmedBy: "equal-read",
        },
      };
      movedEnvelope.folderAnchors = {
        schemaVersion: 2,
        byAnchorId: {},
      };
      return movedEnvelope;
    });
    const local: LocalFileEntry = {
      path: originalRemote.path,
      hash: localHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const unrelated: LocalFileEntry = {
      path: "other.md",
      hash: unrelatedHash,
      size: unrelatedBytes.byteLength,
      mtime: 2,
      binary: false,
    };
    const uploadFile = vi.fn().mockResolvedValue({
      id: "other-id",
      eTag: "other-etag",
      parentReference: { id: activeScope.filesRootId },
    });
    const downloadFile = vi.fn().mockResolvedValue(
      new Uint8Array([4, 5, 6]).buffer,
    );
    const movedFolder: RemoteFolderEntry = {
      path: "Archive",
      driveId: "folder-archive",
      parentId: activeScope.filesRootId,
      name: "Archive",
    };
    const movedPath = `${movedFolder.path}/note.md`;
    const replacementRemote: RemoteFileEntry = {
      path: originalRemote.path,
      driveId: "replacement-at-old-path",
      parentId: originalFolder.driveId,
      size: 3,
      mtime: 1,
      eTag: "replacement-etag",
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [{
            id: originalFolder.driveId,
            name: originalFolder.name,
            folder: { childCount: 1 },
            parentReference: { id: originalFolder.parentId },
          }, {
            id: movedFolder.driveId,
            name: movedFolder.name,
            folder: { childCount: 1 },
            parentReference: { id: movedFolder.parentId },
          }, {
            id: originalRemote.driveId,
            name: "note.md",
            size: originalRemote.size,
            eTag: "moved-etag",
            cTag: "moved-ctag",
            file: {},
            parentReference: { id: movedFolder.driveId },
            fileSystemInfo: {
              lastModifiedDateTime: "2026-08-16T00:00:00.000Z",
            },
          }, {
            id: replacementRemote.driveId,
            name: "note.md",
            size: replacementRemote.size,
            eTag: replacementRemote.eTag,
            file: {},
            parentReference: { id: replacementRemote.parentId },
            fileSystemInfo: {
              lastModifiedDateTime: "2026-08-16T00:00:00.000Z",
            },
          }],
          "@odata.deltaLink": "delta-after-move",
        }),
        getFileMetadata: vi.fn().mockResolvedValue(replacementRemote),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockImplementation(async (path: string) =>
              path === unrelated.path
                ? unrelatedBytes
                : new Uint8Array([1, 2, 3]).buffer),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local, unrelated],
          folders: [{ path: originalFolder.path }],
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
      {
        t: (key: string, params?: Record<string, string | number>) =>
          key === "result.syncFailed"
            ? `failed:${params?.message}`
            : key,
      } as I18n,
    );

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({ success: true });
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(uploadFile.mock.calls[0]?.[1]).toBe(unrelated.path);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(result.foldersCreated).toBe(0);
    expect(result.foldersMoved).toBe(0);
    expect(result.foldersDeleted).toBe(0);
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.remoteSnapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: originalRemote.path,
        driveId: replacementRemote.driveId,
      }),
      expect.objectContaining({
        path: movedPath,
        driveId: originalRemote.driveId,
      }),
    ]));
    expect(state.baseSnapshot).not.toContainEqual(
      expect.objectContaining({
        path: originalRemote.path,
        eTag: replacementRemote.eTag,
      }),
    );
    expect(state.baseSnapshot).not.toContainEqual(
      expect.objectContaining({ path: movedPath }),
    );
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
      blockedOperationId: "op-moved-unresolved",
      isolated: true,
    });

    const boundary = executor as unknown as {
      isPathProtectedByIsolatedRecovery(
        path: string,
        records: readonly Readonly<MutationLedgerEntryV1>[],
      ): boolean;
      isFolderProtectedByIsolatedRecovery(
        path: string,
        records: readonly Readonly<MutationLedgerEntryV1>[],
      ): boolean;
    };
    const retainedRecords = state.mutationLedger as MutationLedgerEntryV1[];
    vi.mocked(state.getCommittedV2Envelope).mockClear();
    for (let index = 0; index < 200; index++) {
      expect(boundary.isPathProtectedByIsolatedRecovery(
        index % 2 === 0 ? originalRemote.path : movedPath,
        retainedRecords,
      )).toBe(true);
    }
    expect(boundary.isPathProtectedByIsolatedRecovery(
      originalFolder.path,
      retainedRecords,
    )).toBe(true);
    expect(boundary.isPathProtectedByIsolatedRecovery(
      `${originalRemote.path}/replacement-child.md`,
      retainedRecords,
    )).toBe(true);
    expect(boundary.isFolderProtectedByIsolatedRecovery(
      `${originalRemote.path}/replacement-folder`,
      retainedRecords,
    )).toBe(true);
    expect(boundary.isPathProtectedByIsolatedRecovery(
      `${originalFolder.path}/sibling.md`,
      retainedRecords,
    )).toBe(false);
    expect(state.getCommittedV2Envelope).toHaveBeenCalledOnce();
  });

  it("settles an active V2 ledger in recovery-only mode without entering planning or healthy commit", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "recovery-only.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-recovery-only-not-applied",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: {
            exists: true,
            hash: local.hash,
            size: local.size,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const scanAll = vi.fn().mockResolvedValue({
      entries: [local],
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const uploadFile = vi.fn();
    const initVaultScope = vi.fn().mockResolvedValue({
      driveId: activeScope.driveId,
      vaultFolderId: activeScope.vaultFolderId,
      filesRootId: activeScope.filesRootId,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        initVaultScope,
        uploadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: local,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const executePlan = vi.spyOn(
      executor as unknown as { executePlan: (...args: unknown[]) => Promise<void> },
      "executePlan",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(true);
    expect(result.mutationRecovery).toEqual({
      state: "settled",
      total: 1,
      settled: 1,
      remaining: 0,
      retryAfterSeconds: null,
    });
    expect(state.mutationLedger).toEqual([]);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(initVaultScope).toHaveBeenCalledWith(
      "testVault",
      { createMissing: false },
    );
    expect(executePlan).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(state.incrementRemoteGeneration).not.toHaveBeenCalled();
  });

  it.each([
    { name: "different-path intent-only records", receipted: false },
    { name: "byte-identical reflected records", receipted: true },
  ])("admits reset observation before touching duplicate operation IDs in $name", async ({ receipted }) => {
    const content = new Uint8Array([41, 42, 43]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const operationId = receipted
      ? "op-duplicate-reflected"
      : "op-duplicate-not-applied";
    const makeRecord = (path: string): MutationLedgerEntryV1 => ({
      intent: {
        version: 1,
        operationId,
        planRevision: 1,
        scope: activeScope,
        action: receipted ? "deleteLocal" : "upload",
        path,
        expectedLocal: {
          exists: true,
          hash,
          size: content.byteLength,
        },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: receipted ? {
        version: 1,
        operationId,
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [path],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [path],
        },
      } : null,
    });
    const first = makeRecord("duplicate-a.md");
    const records = receipted
      ? [first, structuredClone(first)]
      : [first, makeRecord("duplicate-b.md")];
    const originalLedger = structuredClone(records);
    const state = makeActiveV2State([], [], {
      mutationLedger: records,
      pendingConflicts: [{ path: "must-stay-conflict.md" }],
      pendingRemoteDeletes: [{ path: records[0].intent.path }],
    });
    if (receipted) {
      vi.mocked(state.retireMutationCheckpointIfReflected)
        .mockResolvedValue(true);
    }
    const uploadFile = vi.fn();
    const deleteItem = vi.fn();
    const downloadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, deleteItem, downloadFile }),
      Object.assign(emptyScanner(), {
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
      }),
      state,
      "testVault",
    );

    const result = await executor.run(
      "manual",
      {},
      false,
      undefined,
      {
        recoveryOnly: true,
        mutationRecoveryObservationOnly: true,
      },
    );

    expect(result.success).toBe(false);
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      blockReason: "evidence-corrupt",
      settled: 0,
    });
    expect(state.mutationLedger).toEqual(originalLedger);
    expect(state.pendingConflicts).toEqual([{ path: "must-stay-conflict.md" }]);
    expect(state.pendingRemoteDeletes).toEqual([{ path: records[0].intent.path }]);
    expect(state.abandonMutationIntent).not.toHaveBeenCalled();
    expect(state.recordMutationReceipt).not.toHaveBeenCalled();
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(state.retireMutationCheckpointIfReflected).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it.each([
    { name: "reset observation", observationOnly: true },
    { name: "ordinary cold recovery", observationOnly: false },
  ])("rejects a parser-readable ordinary receipt whose content is not bound to its intent before $name cleanup", async ({ observationOnly }) => {
    const content = new Uint8Array([44, 45, 46]).buffer;
    const receiptHash = await sha256Hex(content);
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const path = "semantic-mismatch.md";
    const operationId = "op-semantic-mismatch";
    const remote: RemoteFileEntry = {
      path,
      driveId: "semantic-remote",
      parentId: activeScope.filesRootId,
      size: content.byteLength,
      mtime: 2,
      eTag: "semantic-etag",
      cTag: "semantic-ctag",
      sha256Hash: receiptHash,
    };
    const record: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId,
        planRevision: 1,
        scope: activeScope,
        action: "upload",
        path,
        expectedLocal: {
          exists: true,
          hash: "f".repeat(64),
          size: content.byteLength,
        },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId,
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{
            path,
            hash: receiptHash,
            size: content.byteLength,
            eTag: remote.eTag,
          }],
          baseRemovals: [],
          remoteUpserts: [remote],
          remoteDeletes: [],
          pendingConflictRemovals: [path],
          pendingDeleteRemovals: [],
        },
      },
    };
    const state = makeActiveV2State([remote], [], {
      mutationLedger: [record],
      pendingConflicts: [{ path }],
    });
    vi.mocked(state.retireMutationCheckpointIfReflected)
      .mockResolvedValue(true);
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      emptyScanner(),
      state,
      "testVault",
    );

    const result = await executor.run(
      "manual",
      {},
      false,
      undefined,
      {
        recoveryOnly: true,
        mutationRecoveryObservationOnly: observationOnly,
      },
    );

    expect(result.success).toBe(false);
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      blockReason: "evidence-corrupt",
      settled: 0,
      remaining: 1,
    });
    expect(state.mutationLedger).toEqual([record]);
    expect(state.pendingConflicts).toEqual([{ path }]);
    expect(state.retireMutationCheckpointIfReflected).not.toHaveBeenCalled();
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
  });

  it("does not reuse a post-checkpoint commit sequence as the remote rebuild lineage", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const contents = [
      new Uint8Array([51, 52, 53]).buffer,
      new Uint8Array([61, 62, 63]).buffer,
    ];
    const hashes = await Promise.all(contents.map((bytes) => sha256Hex(bytes)));
    const locals: LocalFileEntry[] = hashes.map((hash, index) => ({
      path: `lineage-${index}.md`,
      hash,
      size: contents[index].byteLength,
      mtime: index + 1,
      binary: false,
    }));
    const remotes: RemoteFileEntry[] = locals.map((local, index) => ({
      path: local.path,
      driveId: `lineage-remote-${index}`,
      parentId: activeScope.filesRootId,
      size: local.size,
      mtime: index + 10,
      eTag: `lineage-etag-${index}`,
      cTag: `lineage-ctag-${index}`,
      sha256Hash: local.hash,
    }));
    const records: MutationLedgerEntryV1[] = locals.map((local, index) => ({
      intent: {
        version: 1,
        operationId: `op-lineage-${index}`,
        planRevision: 1,
        scope: activeScope,
        action: "download",
        path: local.path,
        expectedLocal: { exists: false },
        expectedRemote: {
          exists: true,
          driveId: remotes[index].driveId,
          eTag: remotes[index].eTag,
          size: remotes[index].size,
          sha256Hash: remotes[index].sha256Hash,
        },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: `op-lineage-${index}`,
        completedAt: index + 2,
        checkpoint: {
          baseUpserts: [{
            path: local.path,
            hash: local.hash,
            size: local.size,
            eTag: remotes[index].eTag,
          }],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    }));
    const firstOperationId = records[0].intent.operationId;
    const secondOperationId = records[1].intent.operationId;
    const state = makeActiveV2State(remotes, [], { mutationLedger: records });
    const retire = vi.mocked(state.retireMutationCheckpointIfReflected);
    retire.mockImplementation(async (operationId) => operationId === secondOperationId);
    const adapter = makeMockAdapter({
      readBinary: vi.fn(async (path: string) => {
        const index = locals.findIndex((entry) => entry.path === path);
        if (index < 0) throw new Error(`missing ${path}`);
        return contents[index];
      }),
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({
          value: remotes.map((remote, index) => driveItem(remote.path, remote.sha256Hash, {
            id: remote.driveId,
            eTag: remote.eTag,
            cTag: remote.cTag,
            size: remote.size,
            mtime: remote.mtime,
          })),
          "@odata.deltaLink": "lineage-delta",
        }),
        getFileMetadata: vi.fn(async (_vault: string, path: string) =>
          remotes.find((entry) => entry.path === path) ?? null),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: locals,
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (path: string) => ({
          status: "present",
          entry: locals.find((entry) => entry.path === path)!,
        })),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run(
      "manual",
      {},
      false,
      undefined,
      {
        recoveryOnly: true,
        mutationRecoveryObservationOnly: true,
      },
    );

    expect(result.success).toBe(true);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire.mock.calls[0][0]).toBe(firstOperationId);
    expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toEqual([]);
  });

  it("carries the rebuild lineage only across consecutive reflected-retirement CAS revisions", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const hash = "a".repeat(64);
    const records: MutationLedgerEntryV1[] = [0, 1].map((index) => {
      const path = `reflected-lineage-${index}.md`;
      const operationId = `op-reflected-lineage-${index}`;
      return {
        intent: {
          version: 1,
          operationId,
          planRevision: 1,
          scope: activeScope,
          action: "deleteLocal",
          path,
          expectedLocal: { exists: true, hash, size: 3 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId,
          completedAt: index + 2,
          checkpoint: {
            baseUpserts: [],
            baseRemovals: [path],
            remoteUpserts: [],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [path],
          },
        },
      };
    });
    const state = makeActiveV2State([], [], { mutationLedger: records });
    let reflectedEnvelope = state.getCommittedV2Envelope()!;
    const rebuildCommitSeq = reflectedEnvelope.meta.commitSeq;
    state.getCommittedV2Envelope = vi.fn(() => structuredClone(reflectedEnvelope));
    const retire = vi.mocked(state.retireMutationCheckpointIfReflected);
    retire.mockImplementation(async (operationId, expectedCommitSeq) => {
      if (reflectedEnvelope.meta.commitSeq !== expectedCommitSeq) return false;
      const index = state.mutationLedger.findIndex(
        (record) => record.intent.operationId === operationId,
      );
      if (index < 0) return false;
      state.mutationLedger.splice(index, 1);
      reflectedEnvelope = {
        ...reflectedEnvelope,
        meta: {
          ...reflectedEnvelope.meta,
          commitSeq: reflectedEnvelope.meta.commitSeq + 1,
        },
      };
      return true;
    });
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      emptyScanner(),
      state,
      "testVault",
    );

    const summary = await (executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: undefined,
        observationOnly: boolean,
        remoteObservationCommitSeq: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      activeScope,
      undefined,
      undefined,
      true,
      rebuildCommitSeq,
    );

    expect(summary).toMatchObject({ state: "settled", settled: 2, remaining: 0 });
    expect(retire.mock.calls.map((call) => call[1]))
      .toEqual([rebuildCommitSeq, rebuildCommitSeq + 1]);
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(state.mutationLedger).toEqual([]);
  });

  it("observes mutation recovery through the committed delta cursor instead of rebuilding the complete feed", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: "observe-incremental.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-observe-incremental",
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
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "incremental-tok",
    });
    const uploadFile = vi.fn().mockResolvedValue({
      id: "observe-uploaded-id",
      eTag: "observe-uploaded-etag",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(null),
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

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(getDelta).toHaveBeenCalledTimes(2);
    // The recovery observation consumed the committed delta cursor (1st call)
    // and the ordinary remote scan followed from the fresh cursor (2nd call).
    // It must not request the token-less complete feed first.
    expect(getDelta.mock.calls[0][1]).toBe("delta-token");
    expect(getDelta.mock.calls[1][1]).toBe("incremental-tok");
  });

  it("falls back to the token-less complete feed when the committed envelope cannot serve an incremental recovery observation", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: "observe-fallback.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-observe-fallback",
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
      // Cursor/incremental prerequisites are not all present: the committed
      // folder index is incomplete, so the recovery observation must rebuild.
      hasCompleteRemoteFolderIndex: false,
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "fallback-tok",
    });
    const uploadFile = vi.fn().mockResolvedValue({
      id: "fallback-uploaded-id",
      eTag: "fallback-uploaded-etag",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(null),
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

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    // The first delta request must be the token-less complete feed.
    expect(getDelta.mock.calls[0][1]).toBeUndefined();
  });

  it("falls back to the complete feed when the incremental recovery observation cannot prove the hierarchy", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = {
      path: "observe-orphan.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-observe-orphan",
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
    // A live change whose parent identity is unknown cannot be applied onto
    // the committed snapshot (IncrementalRemoteHierarchyError), so the
    // recovery observation must fall back to the token-less complete feed
    // (which filters the orphan out as a non-descendant).
    const orphanItem = {
      id: "orphan-item-id",
      name: "orphan.md",
      size: 1,
      eTag: "etag-orphan",
      parentReference: { id: "unknown-parent-id" },
      file: {},
    } as DriveItem;
    const getDelta = vi.fn().mockImplementation(
      async (_vaultName: string, deltaToken?: string) => {
        if (deltaToken) {
          return { value: [orphanItem], "@odata.deltaLink": "bad-tok" };
        }
        return { value: [], "@odata.deltaLink": "full-tok" };
      },
    );
    const uploadFile = vi.fn().mockResolvedValue({
      id: "orphan-uploaded-id",
      eTag: "orphan-uploaded-etag",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(null),
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

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(getDelta.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The incremental attempt consumed the committed cursor first…
    expect(getDelta.mock.calls[0][1]).toBe("delta-token");
    // …and the fallback returned to the token-less complete feed.
    expect(getDelta.mock.calls[1][1]).toBeUndefined();
  });

  it("keeps the reset preflight recovery observation on the token-less complete feed", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const hash = "a".repeat(64);
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-observe-preflight",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: "observe-preflight.md",
          expectedLocal: { exists: true, hash, size: 3 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "preflight-tok",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        // Remote observation is rate-limited: the mutation recovery blocks
        // retryably, which is enough to prove the observation request shape.
        getFileMetadata: vi.fn().mockRejectedValue(new OneDriveError(
          OneDriveErrorType.RateLimited,
          "recovery observation rate limited",
          429,
          12,
        )),
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

    const result = await executor.run(
      "manual",
      {},
      false,
      undefined,
      {
        recoveryOnly: true,
        mutationRecoveryObservationOnly: true,
      },
    );

    expect(result.success).toBe(false);
    expect(getDelta).toHaveBeenCalledTimes(1);
    // The reset preflight must observe the remote independently of the
    // committed snapshot and cursor: token-less complete feed first.
    expect(getDelta.mock.calls[0][1]).toBeUndefined();
  });

  it("retires reflected receipts through the incremental recovery observation commitSeq", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const hash = "a".repeat(64);
    const records: MutationLedgerEntryV1[] = [{
      intent: {
        version: 1,
        operationId: "op-reflected-run",
        planRevision: 1,
        scope: activeScope,
        action: "deleteRemote",
        path: "reflected-run.md",
        expectedLocal: { exists: false },
        expectedRemote: {
          exists: true,
          driveId: "remote-id",
          eTag: "remote-etag",
        },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "op-reflected-run",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: ["reflected-run.md"],
          remoteUpserts: [],
          remoteDeletes: ["reflected-run.md"],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    }];
    const state = makeActiveV2State([], [], { mutationLedger: records });
    const retire = vi.mocked(state.retireMutationCheckpointIfReflected);
    retire.mockImplementation(async (operationId) => {
      if (operationId !== "op-reflected-run") return false;
      const index = state.mutationLedger.findIndex(
        (record) => record.intent.operationId === operationId,
      );
      if (index < 0) return false;
      state.mutationLedger.splice(index, 1);
      return true;
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "reflected-tok",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        getFileMetadata: vi.fn().mockResolvedValue(null),
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

    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(retire).toHaveBeenCalledTimes(1);
    // The retirement gate must see the observation commitSeq produced by the
    // incremental projection (the committed envelope's next commitSeq).
    expect(retire.mock.calls[0][1]).toBe(2);
    expect(getDelta.mock.calls[0][1]).toBe("delta-token");
  });

  it("rejects recovery-only mode before scan and Graph when public precommit is still authoritative", async () => {
    const scanAll = vi.fn();
    const initVaultScope = vi.fn();
    const state = {
      ...remoteStateStub(),
      legacyAutoSyncAllowed: true,
      isV2StateActive: false,
      hasV2StateLoadRecoveryBlock: false,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({ initVaultScope }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.v2RecoveryBlocked");
    expect(scanAll).not.toHaveBeenCalled();
    expect(initVaultScope).not.toHaveBeenCalled();
  });

  it("classifies an exhausted recovery read Retry-After without entering planning or mutation", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "retry-after.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-retry-after",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: {
            exists: true,
            hash: local.hash,
            size: local.size,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const uploadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockRejectedValue(new OneDriveError(
          OneDriveErrorType.RateLimited,
          "recovery observation rate limited",
          429,
          12,
        )),
        uploadFile,
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
    const executePlan = vi.spyOn(
      executor as unknown as { executePlan: (...args: unknown[]) => Promise<void> },
      "executePlan",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(false);
    expect(result.mutationRecovery).toEqual({
      state: "network-unavailable",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: 12,
    });
    expect(state.mutationLedger).toHaveLength(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(executePlan).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(state.incrementRemoteGeneration).not.toHaveBeenCalled();
  });

  it("does not classify a cancelled recovery observation as a retryable network failure", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const local: LocalFileEntry = {
      path: "cancelled-recovery.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-cancelled-recovery",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: local.path,
          expectedLocal: {
            exists: true,
            hash: local.hash,
            size: local.size,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    let executor!: SyncExecutor;
    const getFileMetadata = vi.fn().mockImplementation(async () => {
      executor.cancel();
      throw new OneDriveError(
        OneDriveErrorType.NetworkError,
        "aborted recovery observation",
      );
    });
    executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
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
    const executePlan = vi.spyOn(
      executor as unknown as {
        executePlan: (...args: unknown[]) => Promise<void>;
      },
      "executePlan",
    );

    const result = await executor.run(
      "auto",
      {},
      false,
      undefined,
      { recoveryOnly: true },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.cancelled");
    expect(result.errors).toBe(0);
    expect(result.mutationRecovery).toBeUndefined();
    expect(state.mutationLedger).toHaveLength(1);
    expect(executePlan).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
    expect(state.incrementRemoteGeneration).not.toHaveBeenCalled();
  });

  it("settles a public 1.1.3 batch and isolates its one remaining ordinary file", async () => {
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const { ledger, localEntries } =
      makePublic113InterruptedUploadBatch(activeScope);
    const first = localEntries[0];
    const applied = new Set(localEntries.slice(1, 12).map((entry) => entry.path));
    const state = makeActiveV2State([], [], { mutationLedger: ledger });
    const localByPath = new Map(
      localEntries.map((entry) => [entry.path, entry]),
    );
    const uploadFile = vi.fn().mockResolvedValue({
      id: "must-not-upload",
      eTag: "must-not-upload",
    });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vaultName: string, path: string) => {
        const local = localByPath.get(path);
        if (!local) return null;
        if (path === first.path) {
          return {
            path,
            driveId: "unrelated-remote-id",
            parentId: TEST_SYNC_SCOPE.filesRootId,
            size: local.size,
            mtime: 1,
            eTag: "unrelated-etag",
            sha256Hash: "ff".repeat(32),
          };
        }
        if (!applied.has(path)) return null;
        return {
          path,
          driveId: `applied-${path}`,
          parentId: TEST_SYNC_SCOPE.filesRootId,
          size: local.size,
          mtime: 2,
          eTag: `etag-${path}`,
          sha256Hash: local.hash,
        };
      },
    );
    const scanAll = vi.fn().mockResolvedValue({
      entries: localEntries,
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const recoveryWarn = vi.fn();
    const diagnostics = {
      isEnabled: vi.fn((category: string) => category !== "onedrive"),
      log: vi.fn(),
      warn: recoveryWarn,
      error: vi.fn(),
    } as unknown as DiagnosticLogger;
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(
              new Uint8Array([1, 2, 3]).buffer,
            ),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localByPath.get(path);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
      {
        t: (key: string, params?: Record<string, string | number>) =>
          key === "result.syncFailed"
            ? `failed:${params?.message}`
            : key,
      } as I18n,
      undefined,
      diagnostics,
    );

    const result = await executor.run("manual", {});

    expect(PUBLIC_113_NETWORK_RECOVERY_INCIDENT).toEqual({
      singleIntentCount: 1,
      batchIntentCount: 23,
      requestFailure: {
        type: "NetworkError",
        statusCode: 0,
        graphCode: null,
      },
    });
    expect(result.success).toBe(true);
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      total: 23,
      settled: 22,
      remaining: 1,
      blockReason: "facts-changed",
      blockedOperationId: "sanitized-network-op-1",
      isolated: true,
    });
    expect(scanAll).toHaveBeenCalledOnce();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(state.mutationLedger.map(
      (record) => record.intent.operationId,
    )).toEqual(["sanitized-network-op-1"]);
    expect(state.recordMutationReceipt).toHaveBeenCalledTimes(11);
    expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(11);
    // Eleven known-not-applied recovery records are retired first. The same
    // paths are then reconsidered by the ordinary planner; their live remote
    // preflight makes those new intents no-ops and retires them as well.
    expect(state.abandonMutationIntent).toHaveBeenCalledTimes(22);
    expect(recoveryWarn).toHaveBeenCalledWith(
      "execute",
      "mutation recovery batch summary",
      expect.objectContaining({
        schemaVersion: 2,
        total: 23,
        settled: 22,
        remaining: 1,
        applied: 11,
        notApplied: 11,
        blocked: 1,
        firstBlockedOperationId: "sanitized-network-op-1",
        externalMutations: 0,
        blockedRecords: [expect.objectContaining({
          operationId: "sanitized-network-op-1",
          path: expect.any(String),
          action: expect.any(String),
          receipted: expect.any(Boolean),
        })],
      }),
    );
  });

  it("keeps a status-0 observation pending without hiding later provable ledger outcomes", async () => {
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const { ledger, localEntries } =
      makePublic113InterruptedUploadBatch(activeScope, 3);
    const localByPath = new Map(
      localEntries.map((entry) => [entry.path, entry]),
    );
    const state = makeActiveV2State([], [], { mutationLedger: ledger });
    const getFileMetadata = vi.fn().mockImplementation(
      async (_vaultName: string, path: string) => {
        if (path === localEntries[0].path) {
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            "offline during recovery observation",
            PUBLIC_113_NETWORK_RECOVERY_INCIDENT.requestFailure.statusCode,
            null,
            PUBLIC_113_NETWORK_RECOVERY_INCIDENT.requestFailure.graphCode,
          );
        }
        if (path === localEntries[2].path) return null;
        const local = localByPath.get(path)!;
        return {
          path,
          driveId: `applied-${path}`,
          parentId: TEST_SYNC_SCOPE.filesRootId,
          size: local.size,
          mtime: 2,
          eTag: `etag-${path}`,
          sha256Hash: local.hash,
        };
      },
    );
    const recoveryWarn = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localByPath.get(path);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      {
        isEnabled: vi.fn().mockReturnValue(false),
        log: vi.fn(),
        warn: recoveryWarn,
        error: vi.fn(),
      } as unknown as DiagnosticLogger,
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(activeScope)).rejects.toThrow(
      "offline during recovery observation",
    );

    expect(state.mutationLedger.map(
      (record) => record.intent.operationId,
    )).toEqual(["sanitized-network-op-1"]);
    expect(state.recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    expect(state.abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(recoveryWarn).toHaveBeenCalledWith(
      "execute",
      "mutation recovery batch summary",
      expect.objectContaining({
        total: 3,
        settled: 2,
        remaining: 1,
        blocked: 1,
        blockedByReason: { "observation-unavailable": 1 },
        externalMutations: 0,
      }),
    );
  });

  it("does not settle a later ledger record whose path depends on an unresolved operation", async () => {
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const { ledger, localEntries } =
      makePublic113InterruptedUploadBatch(activeScope, 2);
    const first = localEntries[0];
    ledger[1] = {
      intent: {
        ...ledger[1].intent,
        path: first.path,
        expectedLocal: {
          exists: true,
          hash: first.hash,
          size: first.size,
        },
      },
      receipt: null,
    };
    const state = makeActiveV2State([], [], { mutationLedger: ledger });
    const unrelatedRemote = {
      path: first.path,
      driveId: "unrelated-remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: first.size,
      mtime: 1,
      eTag: "unrelated-etag",
      sha256Hash: "ff".repeat(32),
    };
    const getFileMetadata = vi.fn()
      .mockResolvedValueOnce(unrelatedRemote)
      .mockResolvedValueOnce(unrelatedRemote)
      .mockResolvedValue(null);
    const recoveryWarn = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ getFileMetadata }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: first,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      {
        isEnabled: vi.fn().mockReturnValue(false),
        log: vi.fn(),
        warn: recoveryWarn,
        error: vi.fn(),
      } as unknown as DiagnosticLogger,
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(activeScope)).rejects.toThrow(
      "Mutation outcome requires manual review: sanitized-network-op-1",
    );

    expect(getFileMetadata).toHaveBeenCalledTimes(2);
    expect(state.mutationLedger).toHaveLength(2);
    expect(state.recordMutationReceipt).not.toHaveBeenCalled();
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(state.abandonMutationIntent).not.toHaveBeenCalled();
    // 2026-10-17 显式改写（F29 家族主刀甲·判据②）：本用例原先断言
    // `blocked: 2` / `blockedByReason` 含 `dependent-on-unresolved`。那正是
    // 本刀要纠正的失真——第二条记录只是**等**第一条（`mutationRecoveryIntentsOverlap`
    // 判定同路径依赖，判据本身未动），它既没有自己的受阻原因，也不决定整轮
    // 处置。现在它记帐为 `deferred`，`blocked` 只剩根，`blockedOperationId`
    // 因此严格等于类型注释所述的「first non-retryable root record」。
    // 记录本身仍留在账本、仍被保护、仍拦后面的记录（检测路径未改）。
    expect(recoveryWarn).toHaveBeenCalledWith(
      "execute",
      "mutation recovery batch summary",
      expect.objectContaining({
        total: 2,
        settled: 0,
        remaining: 2,
        blocked: 1,
        deferred: 1,
        blockedByReason: {
          "outcome-unresolved": 1,
        },
        blockedOperationId: "sanitized-network-op-1",
        firstBlockedOperationId: "sanitized-network-op-1",
        externalMutations: 0,
      }),
    );
  });

  it("does not treat a delete response as applied when only the old path is 404", async () => {
    const remote: RemoteFileEntry = {
      path: "moved-before-recovery.md",
      driveId: "delete-target",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-delete-target",
      cTag: "ctag-delete-target",
      sha256Hash: "aa".repeat(32),
    };
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-delete-path-404-only",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
          action: "deleteRemote",
          path: "note.md",
          expectedLocal: { exists: false },
          expectedRemote: {
            exists: true,
            driveId: remote.driveId,
            eTag: remote.eTag,
            size: remote.size,
            sha256Hash: remote.sha256Hash,
          },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue({
          id: remote.driveId,
          name: "moved-before-recovery.md",
          size: remote.size,
          eTag: remote.eTag,
          cTag: remote.cTag,
          file: { hashes: { sha256Hash: remote.sha256Hash } },
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
      "Mutation outcome requires manual review",
    );
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeNull();
  });

  it("does not consume a public remote-delete recovery before V2 cutover", async () => {
    const state = await makeMemoryState({
      "easy-sync-base-snapshot": {
        "note.md": {
          path: "note.md",
          hash: "aa".repeat(32),
          size: 3,
          eTag: "etag-delete-target",
        },
      },
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-delete-exact-404",
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
        receipt: null,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
      }),
      state,
      "testVault",
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<void>;
    }).recoverMutationLedger(TEST_SYNC_SCOPE))
      .rejects.toThrow("active V2 authority");
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeNull();
    expect(state.baseSnapshot).toEqual([{
      path: "note.md",
      hash: "aa".repeat(32),
      size: 3,
      eTag: "etag-delete-target",
    }]);
  });

  it("retires a receipted upload moved elsewhere through move-aware reflection", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const moved: RemoteFileEntry = {
      path: "moved/moved-note.md",
      driveId: "uploaded-note",
      parentId: "moved-folder",
      size: content.byteLength,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
      sha256Hash: hash,
    };
    const record: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-upload-moved-reflected",
        planRevision: 1,
        scope: activeScope,
        action: "upload",
        path: "note.md",
        expectedLocal: { exists: true, hash, size: content.byteLength },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "op-upload-moved-reflected",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{
            path: "note.md",
            hash,
            size: content.byteLength,
            eTag: "etag-uploaded",
          }],
          baseRemovals: [],
          remoteUpserts: [{
            path: "note.md",
            driveId: "uploaded-note",
            parentId: activeScope.filesRootId,
            size: content.byteLength,
            mtime: 3,
            eTag: "etag-uploaded",
            cTag: "ctag-uploaded",
            sha256Hash: hash,
          }],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    };
    const state = makeActiveV2State(
      [moved],
      [{
        path: "moved/moved-note.md",
        hash,
        size: content.byteLength,
        eTag: "etag-uploaded",
      }],
      {
        remoteFolders: [{
          path: "moved",
          driveId: "moved-folder",
          parentId: activeScope.filesRootId,
          name: "moved",
        }],
        mutationLedger: [record],
      },
    );
    let reflectedEnvelope = state.getCommittedV2Envelope()!;
    const rebuildCommitSeq = reflectedEnvelope.meta.commitSeq;
    state.getCommittedV2Envelope = vi.fn(() => structuredClone(reflectedEnvelope));
    const retire = vi.mocked(state.retireMutationCheckpointIfReflected);
    retire.mockImplementation(async (operationId, expectedCommitSeq) => {
      if (reflectedEnvelope.meta.commitSeq !== expectedCommitSeq) return false;
      const index = state.mutationLedger.findIndex(
        (entry) => entry.intent.operationId === operationId,
      );
      if (index < 0) return false;
      state.mutationLedger.splice(index, 1);
      reflectedEnvelope = {
        ...reflectedEnvelope,
        meta: {
          ...reflectedEnvelope.meta,
          commitSeq: reflectedEnvelope.meta.commitSeq + 1,
        },
      };
      return true;
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue({
          id: "uploaded-note",
          name: "moved-note.md",
          size: content.byteLength,
          eTag: "etag-uploaded",
          file: { hashes: { sha256Hash: hash } },
          parentReference: { id: "moved-folder" },
        }),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
      }),
      state,
      "testVault",
    );

    const summary = await (executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: undefined,
        observationOnly: boolean,
        remoteObservationCommitSeq: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      activeScope,
      undefined,
      undefined,
      true,
      rebuildCommitSeq,
    );

    expect(summary).toMatchObject({ state: "settled", settled: 1, remaining: 0 });
    expect(retire).toHaveBeenCalledWith(
      "op-upload-moved-reflected",
      rebuildCommitSeq,
    );
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(state.mutationLedger).toEqual([]);
  });

  it("keeps a moved receipted upload blocked when the moved object changed", async () => {
    const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const moved: RemoteFileEntry = {
      path: "moved/moved-note.md",
      driveId: "uploaded-note",
      parentId: "moved-folder",
      size: content.byteLength,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
      sha256Hash: hash,
    };
    const record: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-upload-moved-changed",
        planRevision: 1,
        scope: activeScope,
        action: "upload",
        path: "note.md",
        expectedLocal: { exists: true, hash, size: content.byteLength },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: {
        version: 1,
        operationId: "op-upload-moved-changed",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [{
            path: "note.md",
            hash,
            size: content.byteLength,
            eTag: "etag-uploaded",
          }],
          baseRemovals: [],
          remoteUpserts: [{
            path: "note.md",
            driveId: "uploaded-note",
            parentId: activeScope.filesRootId,
            size: content.byteLength,
            mtime: 3,
            eTag: "etag-uploaded",
            cTag: "ctag-uploaded",
            sha256Hash: hash,
          }],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    };
    const state = makeActiveV2State(
      [moved],
      [{
        path: "moved/moved-note.md",
        hash,
        size: content.byteLength,
        eTag: "etag-uploaded",
      }],
      {
        remoteFolders: [{
          path: "moved",
          driveId: "moved-folder",
          parentId: activeScope.filesRootId,
          name: "moved",
        }],
        mutationLedger: [record],
      },
    );
    const retire = vi.mocked(state.retireMutationCheckpointIfReflected);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(null),
        getDriveItemMetadataById: vi.fn().mockResolvedValue({
          id: "uploaded-note",
          name: "moved-note.md",
          size: content.byteLength + 1,
          eTag: "etag-changed",
          file: { hashes: { sha256Hash: hash } },
          parentReference: { id: "moved-folder" },
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
    }).recoverMutationLedger(activeScope)).rejects.toThrow(
      "Mutation receipt no longer matches",
    );
    expect(retire).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
  });

  it.each([
    {
      caseName: "local file still present at the original path",
      metadata: {
        id: "uploaded-note",
        name: "moved-note.md",
        size: 3,
        eTag: "etag-uploaded",
        file: { hashes: { sha256Hash: "aa".repeat(32) } },
        parentReference: { id: "moved-folder" },
      },
      localStatus: "present" as const,
      remoteNodeOverrides: {},
      retireExpectation: "not-called" as const,
    },
    {
      caseName: "moved object is no longer in the observed index",
      metadata: {
        id: "uploaded-note",
        name: "moved-note.md",
        size: 3,
        eTag: "etag-uploaded",
        file: { hashes: { sha256Hash: "aa".repeat(32) } },
        parentReference: { id: "moved-folder" },
      },
      localStatus: "missing" as const,
      remoteNodeOverrides: { dropFromIndex: true },
      retireExpectation: "not-called" as const,
    },
    {
      caseName: "reflection retirement refused by state",
      metadata: {
        id: "uploaded-note",
        name: "moved-note.md",
        size: 3,
        eTag: "etag-uploaded",
        file: { hashes: { sha256Hash: "aa".repeat(32) } },
        parentReference: { id: "moved-folder" },
      },
      localStatus: "missing" as const,
      remoteNodeOverrides: {},
      retireExpectation: "called" as const,
    },
  ])(
    "keeps a moved receipted upload blocked: $caseName",
    async ({ caseName, metadata, localStatus, remoteNodeOverrides, retireExpectation }) => {
      const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
      const content = new Uint8Array([1, 2, 3]).buffer;
      const hash = await sha256Hex(content);
      const moved: RemoteFileEntry = {
        path: "moved/moved-note.md",
        driveId: "uploaded-note",
        parentId: "moved-folder",
        size: content.byteLength,
        mtime: 3,
        eTag: "etag-uploaded",
        cTag: "ctag-uploaded",
        sha256Hash: hash,
      };
      const record: MutationLedgerEntryV1 = {
        intent: {
          version: 1,
          operationId: `op-upload-moved-${caseName}`,
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: "note.md",
          expectedLocal: { exists: true, hash, size: content.byteLength },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: `op-upload-moved-${caseName}`,
          completedAt: 2,
          checkpoint: {
            baseUpserts: [{
              path: "note.md",
              hash,
              size: content.byteLength,
              eTag: "etag-uploaded",
            }],
            baseRemovals: [],
            remoteUpserts: [{
              path: "note.md",
              driveId: "uploaded-note",
              parentId: activeScope.filesRootId,
              size: content.byteLength,
              mtime: 3,
              eTag: "etag-uploaded",
              cTag: "ctag-uploaded",
              sha256Hash: hash,
            }],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [],
          },
        },
      };
      const state = makeActiveV2State(
        remoteNodeOverrides.dropFromIndex ? [] : [moved],
        remoteNodeOverrides.dropFromIndex
          ? []
          : [{
              path: "moved/moved-note.md",
              hash,
              size: content.byteLength,
              eTag: "etag-uploaded",
            }],
        {
          remoteFolders: remoteNodeOverrides.dropFromIndex
            ? []
            : [{
                path: "moved",
                driveId: "moved-folder",
                parentId: activeScope.filesRootId,
                name: "moved",
              }],
          mutationLedger: [record],
        },
      );
      const retire = vi.mocked(state.retireMutationCheckpointIfReflected);
      retire.mockResolvedValue(false);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          getFileMetadata: vi.fn().mockResolvedValue(null),
          getDriveItemMetadataById: vi.fn().mockResolvedValue(metadata),
        }),
        Object.assign(emptyScanner(), {
          inspectFile: vi.fn().mockResolvedValue(
            localStatus === "present"
              ? {
                  status: "present",
                  entry: {
                    path: "note.md",
                    hash,
                    size: content.byteLength,
                    mtime: 1,
                    binary: false,
                  },
                }
              : { status: "missing" },
          ),
        }),
        state,
        "testVault",
      );

      if (retireExpectation === "called") {
        const rebuildCommitSeq = state.getCommittedV2Envelope()!.meta.commitSeq;
        await expect((executor as unknown as {
          recoverMutationLedger(
            scope: SyncScope,
            metrics: undefined,
            operationEpoch: undefined,
            observationOnly: boolean,
            remoteObservationCommitSeq: number,
          ): Promise<unknown>;
        }).recoverMutationLedger(
          activeScope,
          undefined,
          undefined,
          true,
          rebuildCommitSeq,
        )).rejects.toThrow("Mutation receipt no longer matches");
      } else {
        await expect((executor as unknown as {
          recoverMutationLedger(scope: SyncScope): Promise<void>;
        }).recoverMutationLedger(activeScope)).rejects.toThrow(
          "Mutation receipt no longer matches",
        );
      }
      if (retireExpectation === "called") {
        expect(retire).toHaveBeenCalled();
      } else {
        expect(retire).not.toHaveBeenCalled();
      }
      expect(state.mutationLedger).toHaveLength(1);
    },
  );

  it("settles a receipted upload after the local file moved on, keeping the receipt's version as the base", async () => {
    const uploadedContent = new Uint8Array([1, 2, 3]).buffer;
    const uploadedHash = await sha256Hex(uploadedContent);
    const currentContent = new Uint8Array([4, 5, 6, 7]).buffer;
    const currentHash = await sha256Hex(currentContent);
    const activeScope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "uploaded-note",
      parentId: activeScope.filesRootId,
      size: uploadedContent.byteLength,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
      sha256Hash: uploadedHash,
    };
    // A client data file rewritten right after the upload landed: the local
    // content is no longer the uploaded version.
    const local: LocalFileEntry = {
      path: remote.path,
      hash: currentHash,
      size: currentContent.byteLength,
      mtime: 9,
      binary: false,
    };
    const state = makeActiveV2State([remote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-hot-upload",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: remote.path,
          expectedLocal: {
            exists: true,
            hash: uploadedHash,
            size: uploadedContent.byteLength,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-hot-upload",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [{
              path: remote.path,
              hash: uploadedHash,
              size: uploadedContent.byteLength,
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
    vi.mocked(state.retireMutationCheckpointIfReflected).mockResolvedValue(false);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(remote),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      }),
      state,
      "testVault",
    );

    await expect((executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<MutationRecoveryRunSummary>;
    }).recoverMutationLedger(activeScope)).resolves.toMatchObject({
      state: "settled",
      settled: 1,
      remaining: 0,
    });

    expect(state.mutationLedger).toEqual([]);
    expect(state.commitMutationCheckpoint).toHaveBeenCalledWith("op-hot-upload");
    // The settled base is the version the upload actually wrote — never the
    // newer local bytes: pairing the base with the current local content would
    // corrupt every later three-way comparison.
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: remote.path,
        hash: uploadedHash,
        size: uploadedContent.byteLength,
        eTag: remote.eTag,
      }),
    ]);
  });

  it("settles the same rewritten receipted upload during the reset preflight (observation-only)", async () => {
    const uploadedContent = new Uint8Array([1, 2, 3]).buffer;
    const uploadedHash = await sha256Hex(uploadedContent);
    const activeScope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "uploaded-note",
      parentId: activeScope.filesRootId,
      size: uploadedContent.byteLength,
      mtime: 3,
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
      sha256Hash: uploadedHash,
    };
    const local: LocalFileEntry = {
      path: remote.path,
      hash: "cd".repeat(32),
      size: 4,
      mtime: 9,
      binary: false,
    };
    const state = makeActiveV2State([remote], [], {
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "op-hot-upload-preflight",
          planRevision: 1,
          scope: activeScope,
          action: "upload",
          path: remote.path,
          expectedLocal: {
            exists: true,
            hash: uploadedHash,
            size: uploadedContent.byteLength,
          },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: {
          version: 1,
          operationId: "op-hot-upload-preflight",
          completedAt: 2,
          checkpoint: {
            baseUpserts: [{
              path: remote.path,
              hash: uploadedHash,
              size: uploadedContent.byteLength,
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
    vi.mocked(state.retireMutationCheckpointIfReflected).mockResolvedValue(false);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(remote),
      }),
      Object.assign(emptyScanner(), {
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      }),
      state,
      "testVault",
    );

    // The reset preflight runs the same verification with observationOnly=true;
    // this shape must settle there too, otherwise a reset keeps offering the
    // forced-reset path for a record that is provably settled
    // (2026-10-13 review finding).
    await expect((executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: undefined,
        observationOnly: boolean,
      ): Promise<MutationRecoveryRunSummary>;
    }).recoverMutationLedger(
      activeScope,
      undefined,
      undefined,
      true,
    )).resolves.toMatchObject({
      state: "settled",
      settled: 1,
      remaining: 0,
    });

    expect(state.mutationLedger).toEqual([]);
    expect(state.commitMutationCheckpoint).toHaveBeenCalledWith(
      "op-hot-upload-preflight",
    );
  });

  it.each(BASE_UPSERT_GATES.map((message) => ({ message })))(
    "gives a stale committed tree one rebuild before keeping the record blocked ($message)",
    async () => {
      // The recovery verified the receipt against live facts while the
      // committed index lagged; one full rebuild of that index is the
      // read-only repair the commit path may take (2026-10-13, residual §3).
      const probe = await makeStaleTreeCommitProbe(
        (attempt) => attempt === 1 ? "reject" : "succeed",
      );
      await expect((probe.executor as unknown as {
        recoverMutationLedger(scope: SyncScope): Promise<MutationRecoveryRunSummary>;
      }).recoverMutationLedger(
        probe.activeScope,
        undefined,
        1,
        false,
        undefined,
        {} as never,
      )).resolves.toMatchObject({
        state: "settled",
        settled: 1,
        remaining: 0,
      });
      expect(probe.rebuild).toHaveBeenCalledTimes(1);
      expect(probe.attempts()).toBe(2);
      expect(probe.state.mutationLedger).toEqual([]);
    },
  );

  it("keeps the record blocked when the rebuilt tree rejects the checkpoint again", async () => {
    const probe = await makeStaleTreeCommitProbe(() => "reject");
    await expect((probe.executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<MutationRecoveryRunSummary>;
    }).recoverMutationLedger(
      probe.activeScope,
      undefined,
      1,
      false,
      undefined,
      {} as never,
    )).rejects.toThrow("V2 base upsert");
    expect(probe.rebuild).toHaveBeenCalledTimes(1);
    expect(probe.attempts()).toBe(2);
    expect(probe.state.mutationLedger).toHaveLength(1);
  });

  it("does not rebuild the tree for a rejection outside the three base-upsert gates", async () => {
    const probe = await makeStaleTreeCommitProbe(() => "reject");
    (probe.state.commitMutationCheckpoint as unknown as {
      mockImplementation(fn: (operationId: string) => Promise<unknown>): void;
    }).mockImplementation(async () => {
      throw new Error("unexpected commit failure");
    });
    await expect((probe.executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<MutationRecoveryRunSummary>;
    }).recoverMutationLedger(
      probe.activeScope,
      undefined,
      1,
      false,
      undefined,
      {} as never,
    )).rejects.toThrow("unexpected commit failure");
    expect(probe.rebuild).not.toHaveBeenCalled();
    expect(probe.state.mutationLedger).toHaveLength(1);
  });

  it.each([
    { caseName: "remote eTag no longer matches the receipt", divergent: { eTag: "etag-rewritten" } },
    { caseName: "remote size no longer matches the receipt", divergent: { size: 99 } },
  ])(
    "keeps a receipted upload blocked when the remote version moved on ($caseName)",
    async ({ divergent }) => {
      const uploadedContent = new Uint8Array([1, 2, 3]).buffer;
      const uploadedHash = await sha256Hex(uploadedContent);
      const currentHash = "cd".repeat(32);
      const activeScope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
      const remote: RemoteFileEntry = {
        path: "note.md",
        driveId: "uploaded-note",
        parentId: activeScope.filesRootId,
        size: uploadedContent.byteLength,
        mtime: 3,
        eTag: "etag-uploaded",
        cTag: "ctag-uploaded",
        sha256Hash: uploadedHash,
      };
      const local: LocalFileEntry = {
        path: remote.path,
        hash: currentHash,
        size: 4,
        mtime: 9,
        binary: false,
      };
      const state = makeActiveV2State([remote], [], {
        mutationLedger: [{
          intent: {
            version: 1,
            operationId: "op-hot-upload-divergent",
            planRevision: 1,
            scope: activeScope,
            action: "upload",
            path: remote.path,
            expectedLocal: {
              exists: true,
              hash: uploadedHash,
              size: uploadedContent.byteLength,
            },
            expectedRemote: { exists: false },
            createdAt: 1,
          },
          receipt: {
            version: 1,
            operationId: "op-hot-upload-divergent",
            completedAt: 2,
            checkpoint: {
              baseUpserts: [{
                path: remote.path,
                hash: uploadedHash,
                size: uploadedContent.byteLength,
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
      const executor = new SyncExecutor(
        makeMockOneDrive({
          getFileMetadata: vi.fn().mockResolvedValue({ ...remote, ...divergent }),
        }),
        Object.assign(emptyScanner(), {
          inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
        }),
        state,
        "testVault",
      );

      await expect((executor as unknown as {
        recoverMutationLedger(scope: SyncScope): Promise<void>;
      }).recoverMutationLedger(activeScope)).rejects.toThrow(
        "Mutation receipt no longer matches",
      );
      expect(state.mutationLedger).toHaveLength(1);
      expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    },
  );

  // ---- 2026-10-16 F29: a receipt that cannot be absorbed must not take the
  // whole round down with it ------------------------------------------------
  //
  // The recovery loop in `recoverMutationLedgerRecords` has no per-record
  // guard, so any bare error thrown while settling one record ends the round
  // for every record queued behind it. A reducer assertion that means "the
  // committed common state cannot mechanically absorb this already-receipted
  // record" is therefore classified and reported as one record-level blocked
  // outcome instead (SC-20 zero-write degradation target; field case
  // 2026-10-16 Android 1.5.9: whole-vault stall, auto-sync paused, reset only).

  const setCommitRefusalMessage = (
    probe: Awaited<ReturnType<typeof makeStaleTreeCommitProbe>>,
    message: string,
  ) => {
    (probe.state.commitMutationCheckpoint as unknown as {
      mockImplementation(fn: (operationId: string) => Promise<unknown>): void;
    }).mockImplementation(async () => {
      throw new Error(message);
    });
  };

  const recoverWithRepair = (
    probe: Awaited<ReturnType<typeof makeStaleTreeCommitProbe>>,
  ) => (probe.executor as unknown as {
    recoverMutationLedger(scope: SyncScope): Promise<MutationRecoveryRunSummary>;
  }).recoverMutationLedger(
    probe.activeScope,
    undefined,
    1,
    false,
    undefined,
    {} as never,
  );

  /** The recovery reports any blocked record as this typed error; the round
   *  level reads `.summary` off it (sync-executor.ts:17611-17616). */
  const blockedSummary = async (
    probe: Awaited<ReturnType<typeof makeStaleTreeCommitProbe>>,
  ): Promise<MutationRecoveryRunSummary> => {
    try {
      await recoverWithRepair(probe);
    } catch (error) {
      const summary = (error as { summary?: MutationRecoveryRunSummary }).summary;
      if (summary) return summary;
      throw error;
    }
    throw new Error("expected the recovery to report a blocked record");
  };

  const STATE_ABSORPTION_REFUSALS = [
    // Reproduces the F29 field message exactly, through the real commit path.
    "V2 folder move file projection changed: Notes/Child",
    // A same-family refusal the planner-side gate does not cover yet.
    "V2 folder move descendant projection changed: Notes/Child",
    // A file-layer refusal of the same kind.
    "V2 remote move is missing its source deletion: Notes/Child/a.md",
  ];

  it.each(STATE_ABSORPTION_REFUSALS.map((message) => ({ message })))(
    "reports one record-level blocked outcome when the committed state cannot absorb a receipted record ($message)",
    async ({ message }) => {
      const probe = await makeStaleTreeCommitProbe(() => "reject");
      setCommitRefusalMessage(probe, message);

      await expect(blockedSummary(probe)).resolves.toMatchObject({
        state: "blocked",
        blockReason: "facts-changed",
        blockedOperationId: "op-stale-tree",
        retryAfterSeconds: null,
      });
      // Not a stale-tree problem: the record never gets a rebuild attempt.
      // (`attempts()` counts only real commits and is replaced by the stub
      // here, so `rebuild` is the meaningful witness.)
      expect(probe.rebuild).not.toHaveBeenCalled();
      // The record keeps blocking exactly as before — nothing is settled,
      // nothing is written, and the ledger still owns the record.
      expect(probe.state.mutationLedger).toHaveLength(1);
    },
  );

  it("keeps the loud round-level failure for a message outside the classified set", async () => {
    const probe = await makeStaleTreeCommitProbe(() => "reject");
    setCommitRefusalMessage(probe, "V2 some future assertion nobody classified yet: x.md");

    await expect(recoverWithRepair(probe)).rejects.toThrow(
      "V2 some future assertion nobody classified yet",
    );
    expect(probe.rebuild).not.toHaveBeenCalled();
    expect(probe.state.mutationLedger).toHaveLength(1);
  });

  it("keeps the loud round-level failure for an environment fault", async () => {
    const probe = await makeStaleTreeCommitProbe(() => "reject");
    setCommitRefusalMessage(probe, "unexpected commit failure");

    await expect(recoverWithRepair(probe)).rejects.toThrow("unexpected commit failure");
    expect(probe.rebuild).not.toHaveBeenCalled();
    expect(probe.state.mutationLedger).toHaveLength(1);
  });

  // One guard the loop-level fix relies on but this harness cannot measure
  // end-to-end: with a second, independent ledger record queued behind a
  // refused one, the loop must still reach the second record. Driving that
  // needs two records on *different* paths with independent receipts — the
  // probe's existing settlement seams (dependency-on-unresolved, blocked-record
  // footprint overlap, replaced-identity rebind) all key off the record's own
  // path, so a same-path clone never reaches the commit. The guard itself is
  // verified by construction and by the single-record cases above: it catches
  // only `MutationRecoveryBlockedError`, records it through the same `blocked`
  // entry the pre-existing `outcome-unresolved` path uses, and returns without
  // rethrowing, so nothing else about the round changes. Registered as an open
  // verification debt rather than asserted here.
  it("keeps the refused record itself blocked and untouched", async () => {
    const probe = await makeStaleTreeCommitProbe(() => "reject");
    setCommitRefusalMessage(probe, "V2 folder move file projection changed: Notes/Child");

    await expect(blockedSummary(probe)).resolves.toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
      blockedOperationId: "op-stale-tree",
    });
    // The record keeps its receipt and its ledger entry: one blocked record,
    // zero writes, no silent settlement.
    expect(probe.state.mutationLedger).toHaveLength(1);
    expect(probe.state.mutationLedger[0].receipt).toBeDefined();
  });

  // ---- 2026-10-16 second cut: a folder record whose receipt is verified but
  // whose committed state can never absorb it settles as-observed ------------
  //
  // `tryAutoSettleFolderMutationRecovery` existed since 2026-09-13, but for a
  // receipted folder record it was only reachable on the `!receiptMatches`
  // branch. F29 (Android 1.5.9) takes the other branch — the receipt *does*
  // match both sides — so the record kept blocking the whole vault with no
  // in-app exit. The zero-write settlement now owns that branch too, with every
  // gate it had before: folder intent only, scope match, complete remote
  // observation, exact-record CAS, managed paths refused.

  const makeFolderMoveProbe = async () => {
    const probe = await makeStaleTreeCommitProbe(() => "succeed");
    const scope = probe.activeScope;
    // The cloud moved Videos/F to Archive/F itself, and a committed descendant
    // meanwhile lives at Other/y.md — so the receipt's mechanical translation
    // (`Archive/F/y.md`) can never equal the node's real location. This is the
    // F29 shape: an honest receipt the committed state cannot project.
    const remoteUpserts = [{
      path: "Archive/F",
      driveId: "folder-f",
      parentId: "archive",
      name: "F",
      eTag: "etag-f",
    }];
    const folderIntent = {
      version: 2 as const,
      operationId: "op-folder-move",
      planRevision: 1,
      scope,
      action: "moveRemoteFolder" as const,
      path: "Archive/F",
      sourcePath: "Videos/F",
      folderId: "folder-f",
      expectedLocal: { exists: true },
      expectedRemote: {
        exists: true,
        driveId: "folder-f",
        parentId: "videos",
        eTag: "etag-f",
      },
      expectedParent: { driveId: "videos", path: "Videos", eTag: "etag-videos" },
      createdAt: 1,
    };
    const record = {
      intent: folderIntent,
      receipt: {
        version: 1 as const,
        operationId: "op-folder-move",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          folderUpserts: remoteUpserts,
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
        },
      },
    };
    (probe.state as unknown as { mutationLedger: unknown[] }).mutationLedger = [record];
    (probe.state.commitMutationCheckpoint as unknown as {
      mockImplementation(fn: (operationId: string) => Promise<unknown>): void;
    }).mockImplementation(async () => {
      throw new Error("V2 folder move file projection changed: F/y.md");
    });
    // A committed descendant file anchor under the move's source path: the
    // reducer requires it to project to the mechanical translation.
    (probe.state as unknown as {
      getCommittedV2Envelope: () => unknown;
    }).getCommittedV2Envelope = () => {
      return {
        meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq: 3, committedAt: 1 },
        scope,
        remoteIndex: {
          schemaVersion: 2,
          filesRootId: scope.filesRootId,
          cursorRevision: 1,
          deltaLink: "delta-token",
          complete: true,
          itemsById: {
            videos: { id: "videos", parentId: scope.filesRootId, name: "Videos", kind: "folder", eTag: "etag-videos" },
            archive: { id: "archive", parentId: scope.filesRootId, name: "Archive", kind: "folder", eTag: "etag-archive" },
            "folder-f": { id: "folder-f", parentId: "archive", name: "F", kind: "folder", eTag: "etag-f" },
            other: { id: "other", parentId: scope.filesRootId, name: "Other", kind: "folder", eTag: "etag-other" },
            y: { id: "y", parentId: "other", name: "y.md", kind: "file", eTag: "etag-y", size: 4, contentHash: "cd".repeat(32) },
          },
        },
        anchors: {
          schemaVersion: 2,
          byAnchorId: {
            "file:y": {
              anchorId: "file:y",
              remoteId: "y",
              lastPath: "Videos/F/y.md",
              contentHash: "cd".repeat(32),
              size: 4,
              remoteETag: "etag-y",
              confirmedAt: 1,
              confirmedBy: "equal-read",
            },
          },
        },
        folderAnchors: {
          schemaVersion: 2,
          byAnchorId: {
            "folder:folder-f": {
              anchorId: "folder:folder-f",
              remoteId: "folder-f",
              lastPath: "Videos/F",
              parentRemoteId: "videos",
              remoteETag: "etag-f",
              confirmedGeneration: 1,
              confirmedAt: 1,
            },
          },
        },
      };
    };
    // `inspectLocalFolder` / `inspectRemoteFolder` are the receipt's two-sided
    // checks; satisfy both so the receipt counts as verified.
    const executorSeams = probe.executor as unknown as {
      inspectLocalFolder: unknown;
      inspectRemoteFolder: unknown;
      tryAutoSettleFolderMutationRecovery: unknown;
    };
    executorSeams.inspectLocalFolder = vi.fn(async (path: string) => (
      path === "Archive/F" ? { status: "present" } : { status: "missing" }
    ));
    executorSeams.inspectRemoteFolder = vi.fn(async (path: string) => (
      path === "Archive/F"
        ? {
            status: "folder",
            entry: {
              path,
              driveId: "folder-f",
              parentId: "archive",
              eTag: "etag-f",
            },
          }
        : { status: "missing" }
    ));
    const settleAsObserved = vi.fn(async () => true);
    executorSeams.tryAutoSettleFolderMutationRecovery = settleAsObserved;
    return { probe, settleAsObserved };
  };

  it("settles a verified folder receipt as-observed when the committed state cannot project it", async () => {
    const { probe, settleAsObserved } = await makeFolderMoveProbe();

    // No throw and, crucially, no blocked record left behind: the round ends
    // settled, which is what lets ordinary planning run again.
    await expect(recoverWithRepair(probe)).resolves.toMatchObject({
      state: "settled",
      settled: 1,
    });
    expect(settleAsObserved).toHaveBeenCalledTimes(1);
    // Not a stale-tree problem: the record never gets a rebuild attempt.
    expect(probe.rebuild).not.toHaveBeenCalled();
  });

  it("keeps the receipted record blocked and fails loudly when the settlement gate refuses", async () => {
    const { probe, settleAsObserved } = await makeFolderMoveProbe();
    // The settlement's own gates (scope, complete observation, exact-record
    // CAS, managed paths) are unchanged: a refusal keeps the record blocked
    // and the original failure propagates.
    settleAsObserved.mockResolvedValue(false);

    await expect(blockedSummary(probe)).resolves.toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
    });
    expect(probe.state.mutationLedger).toHaveLength(1);
  });

  it("keeps the record blocked when the settlement itself is unavailable (fail-closed)", async () => {
    const { probe } = await makeFolderMoveProbe();
    // This probe wires a slim StateManager stub with no
    // `settleFolderMutationRecoveryAsObserved`, so the real settlement refuses.
    // That is the point of this case: an unavailable or refusing settlement must
    // keep the record blocked and let the original failure propagate — never a
    // silent zero-write settlement.
    const seams = probe.executor as unknown as {
      tryAutoSettleFolderMutationRecovery: unknown;
    };
    delete seams.tryAutoSettleFolderMutationRecovery;
    const warnings: string[] = [];
    (probe.executor as unknown as { diag: unknown }).diag = {
      log: () => undefined,
      warn: (scope: string, message: string, payload?: unknown) => {
        warnings.push(`${scope}: ${message} ${JSON.stringify(payload ?? {})}`);
      },
      error: () => undefined,
      isEnabled: () => true,
    };

    await expect(blockedSummary(probe)).resolves.toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
      blockedOperationId: "op-folder-move",
    });
    expect(probe.state.mutationLedger).toHaveLength(1);
    // The refusal was traced, not silent (2026-09-20 死路现场的教训).
    expect(warnings.join("\n")).toContain("auto-settlement unavailable");
  });

});
