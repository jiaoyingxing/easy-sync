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

  it("pre-verifies the whole confirm batch once and skips per-item remote checks", async () => {
    const paths = Array.from({ length: 25 }, (_unused, index) => `d-${index}.md`);
    const harness = await makeDeleteConfirmHarness({ paths });

    await harness.executor.confirmRemoteDeletes(paths);

    expect(harness.getFileMetadataByPaths).toHaveBeenCalledTimes(1);
    expect(harness.getFileMetadataByPaths.mock.calls).toEqual([
      ["testVault", [...paths].sort()],
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

  it("handles a mixed file+folder batch with one shared batch read", async () => {
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

    expect(getFileMetadataByPaths).toHaveBeenCalledTimes(1);
    expect(batchPaths.size).toBe(paths.length);
    for (const path of paths) {
      expect(batchPaths.has(path)).toBe(true);
    }
    // Single shared read followed by no fallback per-item by-path checks.
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

