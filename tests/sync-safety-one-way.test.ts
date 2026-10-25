// 仅接收模式（出站抑制与本机独有副本）
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

describe("one-way outbound suppression (仅接收片①)", () => {
  const localOnlyPath = "local-only.md";
  const localOnlyText = "local only content";

  async function makeRoundsHarness() {
    const localOnlyBytes = new TextEncoder().encode(localOnlyText);
    const localOnlyEntry: LocalFileEntry = {
      path: localOnlyPath,
      hash: await sha256Hex(localOnlyBytes.buffer),
      size: localOnlyBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const uploadFile = vi.fn().mockResolvedValue({
      id: "uploaded-id",
      eTag: "etag-uploaded",
      size: localOnlyBytes.byteLength,
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
    });
    const upsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
    const upsertBaseEntries = vi.fn(
      async (entries: BaseFileEntry[]) => {
        void entries;
        return {};
      },
    );
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) => path === localOnlyPath),
      stat: vi.fn(async (path: string) =>
        path === localOnlyPath
          ? { size: localOnlyBytes.byteLength, mtime: 1 }
          : null),
      readBinary: vi.fn(async (path: string) => {
        if (path !== localOnlyPath) throw new Error(`missing ${path}`);
        return localOnlyBytes.slice(0).buffer;
      }),
    });
    const state = makeActiveV2State([], [], {
      upsertPendingDeletes,
      upsertBaseEntries,
    });
    const scanner = {
      vault: {
        adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [localOnlyEntry],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn(async (path: string) =>
        path === localOnlyPath
          ? { status: "present" as const, entry: localOnlyEntry }
          : { status: "missing" as const }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
    } as unknown as LocalScanner;
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      scanner,
      state,
      "testVault",
    );
    return { executor, state, uploadFile, upsertPendingDeletes, localOnlyEntry };
  }

  it("never reaches the cloud or the baseline for a local-only file in one-way mode (two consecutive rounds)", async () => {
    // Control: the same fixture does upload in two-way mode, so the harness is
    // proven able to show the difference.
    const control = await makeRoundsHarness();
    const controlRound = await control.executor.run("manual", {});
    expect(controlRound.uploaded).toBe(1);
    expect(control.uploadFile).toHaveBeenCalledTimes(1);
    expect(control.state.baseSnapshot.map((entry) => entry.path))
      .toEqual([localOnlyPath]);

    const oneWay = await makeRoundsHarness();
    oneWay.executor.setSyncDirection("one-way");

    const first = await oneWay.executor.run("manual", {});
    expect(first.uploaded).toBe(0);
    expect(first.deleted).toBe(0);
    expect(first.conflicts).toBe(0);
    expect(oneWay.uploadFile).not.toHaveBeenCalled();
    expect(oneWay.state.baseSnapshot).toEqual([]);
    expect(oneWay.state.mutationLedger).toEqual([]);

    const second = await oneWay.executor.run("manual", {});
    expect(second.uploaded).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.conflicts).toBe(0);
    expect(oneWay.uploadFile).not.toHaveBeenCalled();
    expect(oneWay.state.baseSnapshot).toEqual([]);
    expect(oneWay.upsertPendingDeletes).not.toHaveBeenCalled();
    expect(oneWay.state.pendingRemoteDeletes).toEqual([]);
  });

  const keepLocalPath = "note.md";

  async function makeKeepLocalHarness() {
    const localBytes = new TextEncoder().encode("local edited content");
    const remoteBytes = new TextEncoder().encode("remote edited content");
    const baseBytes = new TextEncoder().encode("base content");
    const local: LocalFileEntry = {
      path: keepLocalPath,
      hash: await sha256Hex(localBytes.buffer),
      size: localBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: keepLocalPath,
      driveId: "remote-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: remoteBytes.byteLength,
      mtime: 1,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: await sha256Hex(remoteBytes.buffer),
    };
    const base: BaseFileEntry = {
      path: keepLocalPath,
      hash: await sha256Hex(baseBytes.buffer),
      size: baseBytes.byteLength,
      eTag: "etag-base",
    };
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const conflictItem = {
      type: SyncActionType.Conflict,
      path: keepLocalPath,
      local,
      remote,
      reason: "reason.bothSidesModified",
      decisionToken: {
        version: 1 as const,
        vaultName: "testVault",
        accountId: "account-id",
        scope,
        local: { exists: true, hash: local.hash, size: local.size },
        remote: { exists: true, driveId: remote.driveId, eTag: remote.eTag },
        ancestorHash: base.hash,
      },
    } as unknown as SyncPlanItem;
    const uploadFile = vi.fn().mockResolvedValue({
      id: "uploaded-note",
      eTag: "etag-uploaded",
      size: localBytes.byteLength,
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
    });
    const state = makeActiveV2State([remote], [base], {
      pendingConflicts: [conflictItem],
    });
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) => path === keepLocalPath),
      stat: vi.fn(async (path: string) =>
        path === keepLocalPath
          ? { size: localBytes.byteLength, mtime: 1 }
          : null),
      readBinary: vi.fn(async () => localBytes.slice(0).buffer),
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: remote.driveId,
          parentId: remote.parentId,
          size: remote.size,
          mtime: remote.mtime,
          eTag: remote.eTag,
          cTag: remote.cTag,
          sha256Hash: remote.sha256Hash,
        }),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        shouldSyncPath: vi.fn().mockReturnValue(true),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present" as const,
          entry: local,
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    return { executor, state, uploadFile, local, remote };
  }

  it("keeps the user's keep-local upload side action identical in one-way mode", async () => {
    const twoWay = await makeKeepLocalHarness();
    await twoWay.executor.resolveConflictKeepLocal(keepLocalPath);
    expect(twoWay.uploadFile).toHaveBeenCalledTimes(1);

    const oneWay = await makeKeepLocalHarness();
    oneWay.executor.setSyncDirection("one-way");
    await oneWay.executor.resolveConflictKeepLocal(keepLocalPath);

    // Same call shape, same CAS arguments (per-call progress closures differ by
    // identity), same settled state as two-way.
    const comparableUploadArgs = (call: unknown[]): unknown[] => [
      call[0],
      call[1],
      (call[2] as ArrayBuffer).byteLength,
      call[4],
      call[5],
    ];
    expect(oneWay.uploadFile).toHaveBeenCalledTimes(1);
    expect(comparableUploadArgs(oneWay.uploadFile.mock.calls[0])).toEqual(
      comparableUploadArgs(twoWay.uploadFile.mock.calls[0]),
    );
    expect(oneWay.uploadFile).toHaveBeenCalledWith(
      "testVault",
      keepLocalPath,
      expect.any(ArrayBuffer),
      expect.anything(),
      twoWay.remote.eTag,
      twoWay.remote.driveId,
    );
    expect(oneWay.state.baseSnapshot).toEqual(twoWay.state.baseSnapshot);
    expect(oneWay.state.mutationLedger).toEqual(twoWay.state.mutationLedger);
  });

  it("executes the remote-deleted folder follow in one-way mode instead of registering a pending delete", async () => {
    const folderPaths = ["notes", "notes/sub", "notes/sub/inner"];

    function makeFolderFollowHarness(direction?: "one-way") {
      const upsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
      const liveFolders = new Set(folderPaths);
      const adapter = makeMockAdapter({
        stat: vi.fn(async (path: string) =>
          liveFolders.has(path) ? { type: "folder", size: 0, mtime: 1 } : null),
        list: vi.fn(async (path: string) => ({
          files: [],
          folders: [...liveFolders].filter((candidate) =>
            candidate.startsWith(`${path}/`)
            && !candidate.slice(path.length + 1).includes("/")),
        })),
        remove: vi.fn(async (path: string) => {
          liveFolders.delete(path);
        }),
      });
      // The remote still owns "notes"; both nested folders were deleted on
      // another device while this device still has them.
      const state = makeActiveV2State([], [], {
        upsertPendingDeletes,
        remoteFolders: [{
          path: "notes",
          driveId: "notes",
          parentId: TEST_SYNC_SCOPE.filesRootId,
          name: "notes",
          eTag: "etag-notes",
        }],
        folderAnchors: [
          {
            remoteId: "notes",
            lastPath: "notes",
            parentId: TEST_SYNC_SCOPE.filesRootId,
            eTag: "etag-notes",
          },
          {
            remoteId: "notes-sub",
            lastPath: "notes/sub",
            parentId: "notes",
            eTag: "etag-notes-sub",
          },
          {
            remoteId: "notes-sub-inner",
            lastPath: "notes/sub/inner",
            parentId: "notes-sub",
            eTag: "etag-notes-sub-inner",
          },
        ],
      });
      const scanner = {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          getAbstractFileByPath: vi.fn((path: string) =>
            liveFolders.has(path) ? new TFolder(path) : null),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: folderPaths.map((path) => ({ path })),
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" as const }),
        shouldSyncPath: vi.fn().mockReturnValue(true),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
      } as unknown as LocalScanner;
      const executor = new SyncExecutor(
        makeMockOneDrive({
          // The follow path re-reads the folder identity before deleting.
          getDriveItemMetadata: vi.fn().mockResolvedValue(null),
        }),
        scanner,
        state,
        "testVault",
        undefined,
        undefined,
        undefined,
        {
          trashFile: vi.fn(async (folder: TFolder) => {
            liveFolders.delete(folder.path);
          }),
        } as never,
      );
      if (direction) executor.setSyncDirection(direction);
      return { executor, state, upsertPendingDeletes, liveFolders };
    }

    // Two-way control: the plan's confirm marker keeps both folders as pending
    // deletes and nothing is removed from this device.
    const twoWay = makeFolderFollowHarness();
    await twoWay.executor.run("manual", {});
    expect(twoWay.liveFolders.has("notes/sub")).toBe(true);
    expect(twoWay.liveFolders.has("notes/sub/inner")).toBe(true);
    expect(twoWay.upsertPendingDeletes).toHaveBeenCalled();
    const registeredPaths = (
      (twoWay.upsertPendingDeletes.mock.calls.at(-1)?.[0] ?? []) as {
        path: string;
      }[]
    ).map((item) => item.path).sort();
    expect(registeredPaths).toEqual(["notes/sub", "notes/sub/inner"]);

    // One-way: the same remote deletion is followed immediately; no pending
    // delete row is registered.
    const oneWay = makeFolderFollowHarness("one-way");
    const oneWayRound = await oneWay.executor.run("manual", {});
    // Both folders are physically removed (deepest first) and nothing is
    // registered as a pending delete. `foldersDeleted` is only incremented by
    // the real delete branch, so it is the branch evidence here; the fixture's
    // state mock cannot consume folder mutation checkpoints, so the round keeps
    // a reducer-side error that is a harness limitation, not this behavior.
    expect(oneWayRound.foldersDeleted).toBe(2);
    expect(oneWay.liveFolders.has("notes/sub")).toBe(false);
    expect(oneWay.liveFolders.has("notes/sub/inner")).toBe(false);
    expect(oneWay.upsertPendingDeletes).not.toHaveBeenCalled();
  });

  it("keeps a cloud-deleted folder when local-only content still occupies it", async () => {
    const folderPaths = ["notes", "notes/sub", "notes/sub/inner"];
    const localOnly: LocalFileEntry = {
      path: "notes/sub/local-only.md",
      hash: "a".repeat(64),
      size: 12,
      mtime: 1,
      binary: false,
    };
    const liveFolders = new Set(folderPaths);
    const upsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAdapter({
      stat: vi.fn(async (path: string) =>
        liveFolders.has(path) ? { type: "folder", size: 0, mtime: 1 } : null),
      list: vi.fn(async (path: string) => ({
        files: path === "notes/sub" ? [localOnly.path] : [],
        folders: [...liveFolders].filter((candidate) =>
          candidate.startsWith(`${path}/`)
          && !candidate.slice(path.length + 1).includes("/")),
      })),
      remove: vi.fn(async (path: string) => {
        liveFolders.delete(path);
      }),
    });
    const state = makeActiveV2State([], [], {
      upsertPendingDeletes,
      reconcilePendingIssues,
      remoteFolders: [{
        path: "notes",
        driveId: "notes",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "notes",
        eTag: "etag-notes",
      }],
      folderAnchors: [
        {
          remoteId: "notes",
          lastPath: "notes",
          parentId: TEST_SYNC_SCOPE.filesRootId,
          eTag: "etag-notes",
        },
        {
          remoteId: "notes-sub",
          lastPath: "notes/sub",
          parentId: "notes",
          eTag: "etag-notes-sub",
        },
        {
          remoteId: "notes-sub-inner",
          lastPath: "notes/sub/inner",
          parentId: "notes-sub",
          eTag: "etag-notes-sub-inner",
        },
      ],
    });
    const scanner = {
      vault: {
        adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
        getAbstractFileByPath: vi.fn((path: string) =>
          liveFolders.has(path) ? new TFolder(path) : null),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [localOnly],
        folders: folderPaths.map((path) => ({ path })),
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: localOnly,
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
    } as unknown as LocalScanner;
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDriveItemMetadata: vi.fn().mockResolvedValue(null),
      }),
      scanner,
      state,
      "testVault",
      undefined,
      undefined,
      undefined,
      {
        trashFile: vi.fn(async (folder: TFolder) => {
          liveFolders.delete(folder.path);
        }),
      } as never,
    );
    executor.setSyncDirection("one-way");

    const round = await executor.run("manual", {});

    expect(round.foldersDeleted).toBe(1);
    expect(round.foldersRetained).toBe(1);
    expect(liveFolders.has("notes/sub")).toBe(true);
    expect(liveFolders.has("notes/sub/inner")).toBe(false);
    expect(upsertPendingDeletes).not.toHaveBeenCalled();
    const issues = (
      (reconcilePendingIssues.mock.calls.at(-1)?.[0] ?? []) as PendingIssue[]
    );
    expect(issues).toContainEqual(expect.objectContaining({
      path: "notes/sub",
      actionType: SyncActionType.FolderDeferred,
      issueCode: "one-way-folder-retained",
    }));
  });
});

/**
 * 片② 单向模式的"本机改动留副本＋原路径还原"——真实执行器轮次证据。
 *
 * 计划层改写断言在 `tests/one-way-mode-plan.test.ts`；这里观测：副本先成功
 * 落盘、原路径才被云端版本覆盖；副本失败本轮不还原且下一轮重试；重放不产生
 * 第二份副本；撞名换名落位；记录写入；代表场景执行期零云端写入。
 */

describe("one-way local-only copy (仅接收片②)", () => {
  const notePath = "note.md";
  const baseText = "base text";
  const localText = "a\nlocal-b\nc\nd";
  const remoteText = "a\nb\nremote-c\nd";
  const copyLabel = "副本";
  const localMtime = 1_760_000_000_000;

  /** The documented template, spelled out here so the test is the spec. */
  function copyNameFor(path: string, mtime: number, attempt = 0): string {
    const date = new Date(mtime);
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
      + `-${pad(date.getDate())} ${pad(date.getHours())}`
      + `${pad(date.getMinutes())}`;
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash + 1);
    const baseName = path.slice(slash + 1);
    const dot = baseName.lastIndexOf(".");
    const stem = dot <= 0 ? baseName : baseName.slice(0, dot);
    const extension = dot <= 0 ? "" : baseName.slice(dot);
    const suffix = attempt === 0 ? "" : ` ${attempt + 1}`;
    return `${directory}${stem}（${copyLabel} ${stamp}${suffix}）${extension}`;
  }

  function bytesOf(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer;
  }

  interface CopyRecords {
    version: 1;
    path: string;
    copyPath: string;
    kind: string;
    recordedAt: number;
  }

  async function makeCopyHarness(options: {
    localText?: string;
    remoteText?: string;
    baseText?: string;
    localMtime?: number;
    /** The original path does not exist on this device (a local deletion). */
    localMissing?: boolean;
    /** The cloud no longer has the tracked file (a remote deletion). */
    remoteMissing?: boolean;
    copyWriteFails?: { current: boolean };
    seedCopyWith?: string;
    seedRecord?: boolean;
    extraRemoteFiles?: Record<string, string>;
    extraLocalFiles?: Array<{ path: string; text: string; mtime: number }>;
    remoteGoneLocallyEdited?: boolean;
  } = {}) {
    const seenLocalText = options.localText ?? localText;
    const seenRemoteText = options.remoteText ?? remoteText;
    const seenBaseText = options.baseText ?? baseText;
    const mtime = options.localMtime ?? localMtime;
    const localBytes = bytesOf(seenLocalText);
    const remoteBytes = bytesOf(seenRemoteText);
    const baseBytes = bytesOf(seenBaseText);
    const local: LocalFileEntry = {
      path: notePath,
      hash: await sha256Hex(localBytes),
      size: localBytes.byteLength,
      mtime,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: notePath,
      driveId: "remote-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: remoteBytes.byteLength,
      mtime: 1,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: await sha256Hex(remoteBytes),
    };
    const base: BaseFileEntry = {
      path: notePath,
      hash: await sha256Hex(baseBytes),
      size: baseBytes.byteLength,
      eTag: "etag-base",
    };
    const copyPath = copyNameFor(notePath, mtime);

    const contentByPath = new Map<string, string>([
      [notePath, seenRemoteText],
      ...Object.entries(options.extraRemoteFiles ?? {}),
    ]);
    const files = new Map<string, ArrayBuffer>();
    if (!options.localMissing) files.set(notePath, localBytes.slice(0));
    if (options.seedCopyWith !== undefined) {
      files.set(copyPath, bytesOf(options.seedCopyWith));
    }
    const writeLog: Array<{ op: string; path: string; to?: string }> = [];
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) => files.has(path)),
      stat: vi.fn(async (path: string) => {
        const content = files.get(path);
        return content ? { size: content.byteLength, mtime } : null;
      }),
      read: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (!content) throw new Error(`missing ${path}`);
        return new TextDecoder().decode(content);
      }),
      write: vi.fn(async (path: string, text: string) => {
        files.set(path, bytesOf(text));
      }),
      readBinary: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (!content) throw new Error(`missing ${path}`);
        return content.slice(0);
      }),
      writeBinary: vi.fn(async (path: string, content: ArrayBuffer) => {
        const copyTempPath = `${getEasySyncPaths(".obsidian").tmpDir}`
          + `/downloads/${copyPath}.part`;
        if (
          options.copyWriteFails?.current
          && (path === copyPath || path === copyTempPath)
        ) {
          throw new Error("disk full");
        }
        files.set(path, content.slice(0));
        writeLog.push({ op: "writeBinary", path });
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const content = files.get(from);
        if (!content) throw new Error(`missing ${from}`);
        files.set(to, content);
        files.delete(from);
        writeLog.push({ op: "rename", path: from, to });
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path);
        writeLog.push({ op: "remove", path });
      }),
      list: vi.fn(async () => ({ files: [], folders: [] })),
    });

    const scanEntries: LocalFileEntry[] = options.localMissing ? [] : [local];
    for (const extra of options.extraLocalFiles ?? []) {
      const extraBytes = bytesOf(extra.text);
      files.set(extra.path, extraBytes.slice(0));
      scanEntries.push({
        path: extra.path,
        hash: await sha256Hex(extraBytes),
        size: extraBytes.byteLength,
        mtime: extra.mtime,
        binary: false,
      });
    }
    // Extra remote files are remote-only (no baseline): they stay downloads.
    const extraRemoteEntries: RemoteFileEntry[] = [];
    for (const [path, text] of Object.entries(options.extraRemoteFiles ?? {})) {
      const extraBytes = bytesOf(text);
      extraRemoteEntries.push({
        path,
        driveId: `remote-${path}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: extraBytes.byteLength,
        mtime: 1,
        eTag: `etag-${path}`,
        cTag: `ctag-${path}`,
        sha256Hash: await sha256Hex(extraBytes),
      });
    }
    const extraBase: BaseFileEntry[] = [];
    if (options.remoteGoneLocallyEdited) {
      // Remote deleted this one; this device edited it after the last sync.
      const goneBytes = bytesOf("gone-local-edit");
      files.set("remote-gone.md", goneBytes.slice(0));
      scanEntries.push({
        path: "remote-gone.md",
        hash: await sha256Hex(goneBytes),
        size: goneBytes.byteLength,
        mtime: 5,
        binary: false,
      });
      extraBase.push({
        path: "remote-gone.md",
        hash: await sha256Hex(bytesOf("gone-base")),
        size: bytesOf("gone-base").byteLength,
        eTag: "etag-base-remote-gone",
      });
    }

    const copyEntries: CopyRecords[] = options.seedRecord
      ? [{
          version: 1,
          path: notePath,
          copyPath,
          kind: "edited",
          recordedAt: 1,
        }]
      : [];
    const upsertLocalOnlyCopies = vi.fn(
      async (entries: CopyRecords[]) => {
        for (const entry of entries) {
          const index = copyEntries.findIndex((candidate) =>
            candidate.path === entry.path
            && candidate.copyPath === entry.copyPath);
          if (index >= 0) copyEntries[index] = { ...entry };
          else copyEntries.push({ ...entry });
        }
      },
    );

    const upsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      options.remoteMissing ? [...extraRemoteEntries] : [remote, ...extraRemoteEntries],
      [base, ...extraBase],
      {
        upsertPendingDeletes,
        localOnlyCopyEntries: copyEntries,
        upsertLocalOnlyCopies,
        getBaseContent: vi.fn((path: string) =>
          path === notePath ? seenBaseText : undefined),
      },
    );
    // Remote state is mutable: an upload updates its text/eTag so the read-back
    // verification and the next round see what really happened.
    const remoteStateByPath = new Map<string, {
      driveId: string;
      parentId: string;
      text: string;
      eTag: string;
      cTag: string;
    }>([
      [notePath, {
        driveId: remote.driveId,
        parentId: remote.parentId ?? TEST_SYNC_SCOPE.filesRootId,
        text: seenRemoteText,
        eTag: remote.eTag,
        cTag: remote.cTag ?? `ctag-${notePath}`,
      }],
      ...extraRemoteEntries.map((entry): [string, {
        driveId: string;
        parentId: string;
        text: string;
        eTag: string;
        cTag: string;
      }] => [entry.path, {
        driveId: entry.driveId,
        parentId: entry.parentId ?? TEST_SYNC_SCOPE.filesRootId,
        text: contentByPath.get(entry.path) ?? "",
        eTag: entry.eTag,
        cTag: entry.cTag ?? `ctag-${entry.path}`,
      }]),
    ]);
    // 云端已删（remoteMissing）时远端真值里没有这个文件：删除前复核与上传回读
    // 都必须看到 null，否则执行器会把陈旧元数据当成"远端又出现"而 fail-closed。
    if (options.remoteMissing) remoteStateByPath.delete(notePath);
    const uploadFile = vi.fn(async (
      _vault: string,
      path: string,
      content: ArrayBuffer,
    ) => {
      const text = new TextDecoder().decode(content);
      const current = remoteStateByPath.get(path);
      if (current) {
        current.text = text;
        current.eTag = "etag-uploaded";
      }
      return {
        id: current?.driveId ?? "uploaded-item",
        eTag: "etag-uploaded",
        size: content.byteLength,
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      };
    });
    const deleteItem = vi.fn(async (_vault: string, path: string) => {
      remoteStateByPath.delete(path);
    });
    const downloadFile = vi.fn(async (
      _vault: string,
      path: string,
    ) => {
      const current = remoteStateByPath.get(path);
      if (!current) throw new Error(`no remote ${path}`);
      return bytesOf(current.text);
    });
    const onedrive = makeMockOneDrive({
      uploadFile,
      deleteItem,
      downloadFile,
      getFileMetadata: vi.fn(async (_vault: string, path: string) => {
        const current = remoteStateByPath.get(path);
        if (!current) return null;
        const bytes = bytesOf(current.text);
        return {
          driveId: current.driveId,
          parentId: current.parentId,
          size: bytes.byteLength,
          mtime: 1,
          eTag: current.eTag,
          cTag: current.cTag,
          sha256Hash: await sha256Hex(bytes),
        };
      }),
    });
    const scanner = {
      vault: {
        adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
        // 本机删除走 deleteLocalPath：先问 vault 要 TFile，取不到才落到
        // adapter.remove（本夹具没有真实 TFile，故恒为 null）。
        getFileByPath: vi.fn().mockReturnValue(null),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: scanEntries,
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (!content) return { status: "missing" as const };
        return {
          status: "present" as const,
          entry: {
            path,
            size: content.byteLength,
            mtime,
            hash: await sha256Hex(content),
            binary: false,
          },
        };
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
    } as unknown as LocalScanner;
    const executor = new SyncExecutor(
      onedrive,
      scanner,
      state,
      "testVault",
      new I18n("zh-cn"),
    );
    return {
      executor,
      state,
      files,
      copyPath,
      copyEntries,
      upsertLocalOnlyCopies,
      uploadFile,
      deleteItem,
      downloadFile,
      writeLog,
      upsertPendingDeletes,
      local,
      remote,
      localText: seenLocalText,
      remoteText: seenRemoteText,
    };
  }

  function textAt(
    files: Map<string, ArrayBuffer>,
    path: string,
  ): string | undefined {
    const content = files.get(path);
    return content === undefined
      ? undefined
      : new TextDecoder().decode(content);
  }

  it("keeps the local edit as a copy, then hands the path to the cloud version", async () => {
    const harness = await makeCopyHarness({
      // Remote did not change: the two-way plan for this input is an upload.
      remoteText: baseText,
    });
    harness.executor.setSyncDirection("one-way");

    const round = await harness.executor.run("manual", {}, true);

    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(round.uploaded).toBe(0);
    expect(textAt(harness.files, harness.copyPath)).toBe(harness.localText);
    expect(textAt(harness.files, notePath)).toBe(baseText);
    // The copy landed before the original path was replaced.
    const copyWrite = harness.writeLog.findIndex((entry) =>
      entry.path === harness.copyPath || entry.to === harness.copyPath);
    const restore = harness.writeLog.findIndex((entry) =>
      entry.path === notePath || entry.to === notePath);
    expect(copyWrite).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(copyWrite);
    // Record written; baseline advanced to the cloud version.
    expect(harness.copyEntries).toEqual([
      expect.objectContaining({
        path: notePath,
        copyPath: harness.copyPath,
        kind: "edited",
      }),
    ]);
    expect(harness.state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: notePath,
        hash: harness.remote.sha256Hash,
      }),
    ]);
    // The copy itself carries no baseline (it is a local-only file).
    expect(
      harness.state.baseSnapshot.some((entry) =>
        entry.path === harness.copyPath),
    ).toBe(false);
  });

  it("does not restore when the copy write fails, and completes it next round", async () => {
    const copyWriteFails = { current: true };
    const harness = await makeCopyHarness({
      remoteText: "remote takeover",
      copyWriteFails,
    });
    harness.executor.setSyncDirection("one-way");

    const failed = await harness.executor.run("manual", {}, true);

    // Nothing was overwritten, no copy landed, no record claims one exists,
    // and the baseline still holds the ancestor version.
    expect(textAt(harness.files, notePath)).toBe(harness.localText);
    expect(harness.files.has(harness.copyPath)).toBe(false);
    expect(harness.copyEntries).toEqual([]);
    expect(
      harness.state.baseSnapshot.find((entry) => entry.path === notePath)?.hash,
    ).toBe(await sha256Hex(bytesOf("base text")));
    expect(failed.errors).toBe(0);
    expect(failed.deferred).toBe(1);

    // Next round, with the write healthy, the same state completes the step.
    copyWriteFails.current = false;
    await harness.executor.run("manual", {}, true);
    expect(textAt(harness.files, harness.copyPath)).toBe(harness.localText);
    expect(textAt(harness.files, notePath)).toBe(harness.remoteText);
    expect(harness.copyEntries).toHaveLength(1);
  });

  it("reuses an already-kept copy instead of writing a second one on replay", async () => {
    const harness = await makeCopyHarness({
      remoteText: baseText,
      // A previous round crashed after the copy landed, record already written.
      seedCopyWith: localText,
      seedRecord: true,
    });
    harness.executor.setSyncDirection("one-way");

    await harness.executor.run("manual", {}, true);

    const copyWrites = harness.writeLog.filter((entry) =>
      entry.path === harness.copyPath || entry.to === harness.copyPath);
    expect(copyWrites).toEqual([]);
    expect(harness.copyEntries).toHaveLength(1);
    expect(textAt(harness.files, harness.copyPath)).toBe(harness.localText);
    expect(textAt(harness.files, notePath)).toBe(baseText);
  });

  it("adopts an orphan copy left by a crash even without its record", async () => {
    const harness = await makeCopyHarness({
      remoteText: baseText,
      seedCopyWith: localText,
    });
    harness.executor.setSyncDirection("one-way");

    await harness.executor.run("manual", {}, true);

    const copyWrites = harness.writeLog.filter((entry) =>
      entry.path === harness.copyPath || entry.to === harness.copyPath);
    expect(copyWrites).toEqual([]);
    // The missing record is rebuilt for the copy already on disk.
    expect(harness.copyEntries).toEqual([
      expect.objectContaining({ path: notePath, copyPath: harness.copyPath }),
    ]);
    expect(textAt(harness.files, notePath)).toBe(baseText);
  });

  it("moves the copy to the next free name when the base name is taken", async () => {
    const harness = await makeCopyHarness({
      remoteText: baseText,
    });
    const occupied = harness.copyPath;
    harness.files.set(occupied, bytesOf("someone else's file"));
    harness.executor.setSyncDirection("one-way");

    await harness.executor.run("manual", {}, true);

    expect(textAt(harness.files, occupied)).toBe("someone else's file");
    const renamed = copyNameFor(notePath, localMtime, 1);
    expect(textAt(harness.files, renamed)).toBe(harness.localText);
    expect(harness.copyEntries).toEqual([
      expect.objectContaining({ copyPath: renamed }),
    ]);
    expect(textAt(harness.files, notePath)).toBe(baseText);
  });

  it("writes nothing to the cloud for the representative one-way scenarios", async () => {
    const scenario = () => ({
      // A real three-way ancestor, so the two-way control really merges and
      // uploads while one-way must not.
      baseText: "a\nb\nc\nd",
      localText: "a\nlocal-b\nc\nd",
      remoteText: "a\nb\nremote-c\nd",
      remoteGoneLocallyEdited: true,
      extraRemoteFiles: { "remote-only.md": "cloud only" },
      extraLocalFiles: [{
        path: "local-only.md",
        text: "local only",
        mtime: 7,
      }],
    });

    // Two-way control: the same input really does write to the cloud (the
    // non-overlapping both-sides edit is merged and uploaded, and the local-only
    // file is uploaded), so the one-way zero-write assertion below is not vacuous.
    const control = await makeCopyHarness(scenario());
    const controlRound = await control.executor.run("manual", {}, true);
    expect(control.uploadFile).toHaveBeenCalled();
    expect(controlRound.metrics?.automaticHandling.textMerge.completed)
      .toBe(1);

    const harness = await makeCopyHarness(scenario());
    harness.executor.setSyncDirection("one-way");

    const round = await harness.executor.run("manual", {}, true);

    // 本机改 / 两端都改 / 远端删＋本机改 / 本机新建 / 远端独有 一轮下来没有任何
    // 云端写入：uploadFile 与 deleteItem 都是 0；自动文本合并（唯一会绕过计划层
    // 上传的链）没有被执行。
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(round.uploaded).toBe(0);
    expect(round.deleted).toBe(0);
    expect(round.metrics?.automaticHandling.textMerge).toMatchObject({
      candidates: 0,
      completed: 0,
    });
    // 本机改（两端都改）留副本，云端版本接管原路径。
    expect(textAt(harness.files, harness.copyPath)).toBe("a\nlocal-b\nc\nd");
    expect(textAt(harness.files, notePath)).toBe("a\nb\nremote-c\nd");
    // 远端删＋本机改仍是人工冲突行，不自动处理。
    expect(round.conflicts).toBe(1);
    expect(harness.copyEntries.map((entry) => entry.path))
      .not.toContain("remote-gone.md");
    expect(harness.files.has("remote-gone.md")).toBe(true);
    // 本机新建原地保留；远端独有照常下载。
    expect(harness.files.has("local-only.md")).toBe(true);
    // 本机改（留副本）走的是下载；远端独有文件也照常下载。
    expect(
      harness.downloadFile.mock.calls.map((call) => call[1]).sort(),
    ).toEqual(["note.md", "remote-only.md"]);
  });
  it("pulls a locally deleted file back in one round and stays quiet after that", async () => {
    const harness = await makeCopyHarness({
      remoteText: "remote takeover",
      localMissing: true,
    });
    harness.executor.setSyncDirection("one-way");

    const first = await harness.executor.run("manual", {}, true);

    // 本机删除不算数：云端版本被拉回，没有任何云端写入、也没有副本/记录。
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(first.downloaded).toBe(1);
    expect(harness.downloadFile).toHaveBeenCalledTimes(1);
    expect(textAt(harness.files, notePath)).toBe(harness.remoteText);
    expect(harness.copyEntries).toEqual([]);

    // 第二轮不循环：本机已经等于云端，计划里没有动作。
    const second = await harness.executor.run("manual", {}, true);
    expect(second.downloaded).toBe(0);
    expect(second.uploaded).toBe(0);
    expect(second.deleted).toBe(0);
    expect(harness.downloadFile).toHaveBeenCalledTimes(1);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.copyEntries).toEqual([]);
  });

  it("retires a remote-only conflict row instead of deleting the cloud file in one-way mode", async () => {
    const remoteBytes = bytesOf("remote content");
    const ancestorBytes = bytesOf("ancestor");
    const remote: RemoteFileEntry = {
      path: notePath,
      driveId: "remote-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: remoteBytes.byteLength,
      mtime: 1,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: await sha256Hex(remoteBytes),
    };
    const base: BaseFileEntry = {
      path: notePath,
      hash: await sha256Hex(ancestorBytes),
      size: ancestorBytes.byteLength,
      eTag: "etag-base",
    };
    const scope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    // 本机删除留下的行：带 remote 事实、没有 local 事实。它的「保留本机」
    // 在现役实现里就是删除云端文件。
    const remoteOnlyRow = {
      type: SyncActionType.Conflict,
      path: notePath,
      remote,
      reason: "reason.localDeletedRemoteModified",
      decisionToken: {
        version: 1 as const,
        vaultName: "testVault",
        accountId: "account-id",
        scope,
        local: { exists: false },
        remote: { exists: true, driveId: remote.driveId, eTag: remote.eTag },
        ancestorHash: base.hash,
      },
    } as unknown as SyncPlanItem;

    function makeRowHarness(direction?: "one-way") {
      const removePendingConflict = vi.fn().mockResolvedValue(undefined);
      const deleteItem = vi.fn().mockResolvedValue(undefined);
      const state = makeActiveV2State([remote], [base], {
        pendingConflicts: [remoteOnlyRow],
        removePendingConflict,
      });
      const executor = new SyncExecutor(
        makeMockOneDrive({
          deleteItem,
          getFileMetadata: vi.fn(async () => ({
            driveId: remote.driveId,
            parentId: remote.parentId,
            size: remote.size,
            mtime: remote.mtime,
            eTag: remote.eTag,
            cTag: remote.cTag,
            sha256Hash: remote.sha256Hash,
          })),
        }),
        {
          vault: {
            adapter: makeMockAdapter(),
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          shouldSyncPath: vi.fn().mockReturnValue(true),
          inspectFile: vi.fn().mockResolvedValue({ status: "missing" as const }),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );
      if (direction) executor.setSyncDirection(direction);
      return { executor, deleteItem, removePendingConflict };
    }

    // Two-way control: the same row's 「保留本机」 still deletes the cloud copy.
    const twoWay = makeRowHarness();
    await twoWay.executor.resolveConflictKeepLocal(notePath);
    expect(twoWay.deleteItem).toHaveBeenCalledTimes(1);

    const oneWay = makeRowHarness("one-way");
    await oneWay.executor.resolveConflictKeepLocal(notePath);
    expect(oneWay.deleteItem).not.toHaveBeenCalled();
    expect(oneWay.removePendingConflict).toHaveBeenCalledWith(notePath);
  });
  it("keeps local-only shapes untouched for two one-way rounds", async () => {
    const localOnlyPaths = [
      "new-note.md",
      "note（副本 2026-10-11 2345）.md",
      "renamed-new-path.md",
    ];
    const harness = await makeCopyHarness({
      // The tracked file itself is unchanged: the only plan material here is the
      // three local-only shapes (a new file, a 片② copy, and the new path left
      // behind by a local rename).
      remoteText: baseText,
      extraLocalFiles: localOnlyPaths.map((path, index) => ({
        path,
        text: `local only ${index}`,
        mtime: 10 + index,
      })),
    });
    harness.executor.setSyncDirection("one-way");

    const first = await harness.executor.run("manual", {}, true);

    // 片③：本机新建内容原地保留——不出上传、不进待确认删除、不写基线。
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.upsertPendingDeletes).not.toHaveBeenCalled();
    expect(first.uploaded).toBe(0);
    expect(first.deleted).toBe(0);
    expect(first.conflicts).toBe(0);
    for (const path of localOnlyPaths) {
      expect(harness.files.has(path)).toBe(true);
      expect(harness.state.baseSnapshot.some((entry) => entry.path === path))
        .toBe(false);
    }

    // 连续两轮同样（不循环）：既没有上传、也没有待确认删除、基线仍为空。
    const second = await harness.executor.run("manual", {}, true);
    expect(second.uploaded).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.conflicts).toBe(0);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.upsertPendingDeletes).not.toHaveBeenCalled();
    for (const path of localOnlyPaths) {
      expect(harness.files.has(path)).toBe(true);
      expect(harness.state.baseSnapshot.some((entry) => entry.path === path))
        .toBe(false);
    }
    // 本机新建内容不产生副本、也不产生条目（条目归片④）；记录里只会有
    // note.md 那份 片② 副本。
    for (const path of localOnlyPaths) {
      expect(harness.copyEntries.some((entry) => entry.path === path)).toBe(false);
    }
  });

/**
 * 片④ 单向模式「上传到云端」动作——真实执行器证据。
 *
 * 行与计数在 `tests/sync-view.test.ts`／`tests/status-bar.test.ts` 断言；这里观测
 * 动作本身：路径式上传（不带 eTag／driveItemId）、成功后条目退场＋成功 Notice、
 * 云端同名（409）走现役失败出口且不退场、双向模式不执行。
 */
describe("one-way local-only upload action (片④)", () => {
  const copyTarget = "note（副本 2026-10-11 2345）.md";
  const targetText = "local only content";

  async function makeUploadHarness(options: {
    direction?: "one-way" | "two-way";
    uploadFails?: unknown;
    withRecords?: boolean;
    /** 上传目标（默认平铺副本；嵌套路径用于验证父目录链）。 */
    targetPath?: string;
    createFolderFails?: unknown;
    /** 指定哪些父目录"已存在"（client 把 409 映射成 null）。 */
    existingParents?: readonly string[];
    shouldSyncFolderPath?: (path: string) => boolean;
  } = {}) {
    const uploadTarget = options.targetPath ?? copyTarget;
    const targetBytes = new TextEncoder().encode(targetText);
    const targetEntry: LocalFileEntry = {
      path: uploadTarget,
      hash: await sha256Hex(targetBytes.buffer),
      size: targetBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const records = options.withRecords === false
      ? { copies: [], created: [] }
      : {
          copies: [{
            version: 1 as const,
            path: "note.md",
            copyPath: uploadTarget,
            kind: "edited" as const,
            recordedAt: 1,
          }],
          created: [],
        };
    const retireLocalOnlyEntries = vi.fn(async () => {
      records.copies = [];
      records.created = [];
    });
    const callOrder: string[] = [];
    const folderParentIdByPath = new Map<string, string>();
    const createFolderPath = vi.fn(async (
      _vault: string,
      folderPath: string,
    ) => {
      callOrder.push(`folder:${folderPath}`);
      if (options.createFolderFails) throw options.createFolderFails;
      if (options.existingParents?.includes(folderPath)) return null;
      const parentPath = folderPath.includes("/")
        ? folderPath.slice(0, folderPath.lastIndexOf("/"))
        : "";
      const parentId = parentPath === ""
        ? TEST_SYNC_SCOPE.filesRootId
        : folderParentIdByPath.get(parentPath) ?? TEST_SYNC_SCOPE.filesRootId;
      const id = `remote-folder-${folderPath}`;
      folderParentIdByPath.set(folderPath, id);
      return {
        id,
        name: folderPath.split("/").pop(),
        folder: {},
        parentReference: { id: parentId },
        eTag: `etag-${id}`,
      };
    });
    const uploadFile = vi.fn(async (
      _vault: string,
      path: string,
      content: ArrayBuffer,
      _progress?: unknown,
    ) => {
      callOrder.push(`upload:${path}`);
      if (options.uploadFails) throw options.uploadFails;
      const parentPath = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
      return {
        id: `remote-${path}`,
        eTag: "etag-uploaded",
        size: content.byteLength,
        parentReference: {
          id: parentPath === ""
            ? TEST_SYNC_SCOPE.filesRootId
            : `remote-folder-${parentPath}`,
        },
      };
    });
    const initVaultScope = vi.fn().mockResolvedValue({
      driveId: TEST_SYNC_SCOPE.driveId,
      vaultFolderId: TEST_SYNC_SCOPE.vaultFolderId,
      filesRootId: TEST_SYNC_SCOPE.filesRootId,
    });
    const state = makeActiveV2State([], [], {
      localOnlyCopyEntries: records.copies,
      localOnlyCreatedEntries: records.created,
      retireLocalOnlyEntries,
    });
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) => path === uploadTarget),
      stat: vi.fn(async (path: string) =>
        path === uploadTarget
          ? { size: targetBytes.byteLength, mtime: 1 }
          : null),
      readBinary: vi.fn(async (path: string) => {
        if (path !== uploadTarget) throw new Error(`missing ${path}`);
        return targetBytes.slice(0).buffer;
      }),
    });
    const noticeCenter = { show: vi.fn() };
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        initVaultScope,
        createFolderPath,
        // 目录身份回读（create 后按 id 精确读一次）。
        getDriveItemMetadataById: vi.fn(async (id: string) => {
          const path = [...folderParentIdByPath.entries()]
            .find(([, folderId]) => folderId === id)?.[0];
          if (path === undefined) return null;
          const parentPath = path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : "";
          return {
            id,
            name: path.split("/").pop(),
            folder: {},
            parentReference: {
              id: parentPath === ""
                ? TEST_SYNC_SCOPE.filesRootId
                : folderParentIdByPath.get(parentPath)
                  ?? TEST_SYNC_SCOPE.filesRootId,
            },
            eTag: `etag-${id}`,
          };
        }),
        // 现有目录的按路径查身份（inspectRemoteFolder / 409 放行；DriveItem 形状）。
        getDriveItemMetadata: vi.fn(async (_vault: string, path: string) => {
          if (!options.existingParents?.includes(path)) return null;
          const id = `remote-folder-${path}`;
          const parentPath = path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : "";
          return {
            id,
            name: path.split("/").pop(),
            folder: {},
            parentReference: {
              id: parentPath === ""
                ? TEST_SYNC_SCOPE.filesRootId
                : `remote-folder-${parentPath}`,
            },
            eTag: `etag-${id}`,
            cTag: `ctag-${id}`,
          };
        }),
      }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        shouldSyncPath: vi.fn().mockReturnValue(true),
        shouldSyncFolderPath: vi.fn(options.shouldSyncFolderPath ?? (() => true)),
        inspectFile: vi.fn(async (path: string) =>
          path === uploadTarget
            ? { status: "present" as const, entry: targetEntry }
            : { status: "missing" as const }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      new I18n("zh-cn"),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      noticeCenter as never,
    );
    executor.setSyncDirection(options.direction ?? "one-way");
    return {
      executor,
      state,
      uploadFile,
      createFolderPath,
      onedriveMetadata: () => (
        executor as unknown as {
          onedrive: { getDriveItemMetadata: ReturnType<typeof vi.fn> };
        }
      ).onedrive.getDriveItemMetadata,
      callOrder,
      initVaultScope,
      retireLocalOnlyEntries,
      noticeCenter,
      records,
    };
  }

  it("uploads the copy path-based without a version lock and retires the entry", async () => {
    const harness = await makeUploadHarness();

    await harness.executor.uploadLocalOnlyEntry(copyTarget);

    // 路径式：不传 eTag／driveItemId（云端同名由 conflictBehavior=fail 挡）。
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    const call = harness.uploadFile.mock.calls[0];
    expect(call[0]).toBe("testVault");
    expect(call[1]).toBe(copyTarget);
    expect((call[2] as ArrayBuffer).byteLength).toBe(
      new TextEncoder().encode(targetText).byteLength,
    );
    expect(call[4]).toBeUndefined();
    expect(call[5]).toBeUndefined();
    // 成功＝该文件进入正常同步（基线与远端索引随检查点提交），条目退场。
    expect(harness.state.baseSnapshot).toEqual([
      expect.objectContaining({ path: copyTarget, eTag: "etag-uploaded" }),
    ]);
    expect(harness.retireLocalOnlyEntries).toHaveBeenCalledWith({
      paths: [copyTarget],
      copyPaths: [copyTarget],
    });
    expect(harness.records.copies).toEqual([]);
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    expect(noticeKeys.some((key) => key.includes("notice.localOnly.uploaded")))
      .toBe(true);
  });

  it("keeps the entry when the cloud already has that name (409 failure exit)", async () => {
    const harness = await makeUploadHarness({
      uploadFails: new OneDriveError(
        OneDriveErrorType.Unknown,
        "name already exists",
        409,
      ),
    });

    await harness.executor.uploadLocalOnlyEntry(copyTarget);

    // 失败走现役 side-action 出口；不覆盖、不退场（下一轮计划按"无基线同名"
    // 处置这个真冲突）。
    expect(harness.retireLocalOnlyEntries).not.toHaveBeenCalled();
    expect(harness.records.copies).toHaveLength(1);
    expect(harness.state.baseSnapshot).toEqual([]);
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    expect(noticeKeys.some((key) => key.includes("notice.delete.failed")))
      .toBe(true);
    expect(noticeKeys.some((key) => key.includes("notice.localOnly.uploaded")))
      .toBe(false);
  });

  it("batch uploads each unique path through the same chain and stays quiet per item (件②)", async () => {
    const harness = await makeUploadHarness();

    await harness.executor.uploadLocalOnlyEntries([copyTarget, copyTarget]);

    // 去重后每条路径走一次现役上行链（同一份校验、同一份持久窗口、同一条退场）。
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.retireLocalOnlyEntries).toHaveBeenCalledWith({
      paths: [copyTarget],
      copyPaths: [copyTarget],
    });
    // 批量成功不逐条弹提示（照批量删除先例）：失败出口仍然在。
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    expect(noticeKeys.some((key) => key.includes("notice.localOnly.uploaded")))
      .toBe(false);
  });

  it("conflict batch dedupes and sorts paths, and keeps per-item success notices quiet", async () => {
    const harness = await makeUploadHarness();
    const keepLocal = vi.spyOn(
      harness.executor,
      "resolveConflictKeepLocal",
    ).mockResolvedValue(undefined);
    const keepRemote = vi.spyOn(
      harness.executor,
      "resolveConflictKeepRemote",
    ).mockResolvedValue(undefined);

    await harness.executor.resolveConflictsKeepLocal(["b.md", "a.md", "a.md"]);
    await harness.executor.resolveConflictsKeepRemote(["d.md", "c.md", "c.md"]);

    expect(keepLocal.mock.calls.map(([path]) => path)).toEqual(["a.md", "b.md"]);
    expect(keepRemote.mock.calls.map(([path]) => path)).toEqual(["c.md", "d.md"]);
    // 批量只关逐条成功提示；失败出口仍在逐条链里。
    expect(keepLocal.mock.calls.every(([, quiet]) => quiet === false)).toBe(true);
    expect(keepRemote.mock.calls.every(([, quiet]) => quiet === false)).toBe(true);
  });

  it("batch upload keeps a failed item and reports through the per-item exit (件②)", async () => {
    const harness = await makeUploadHarness({
      uploadFails: new OneDriveError(
        OneDriveErrorType.Unknown,
        "name already exists",
        409,
      ),
    });

    await harness.executor.uploadLocalOnlyEntries([copyTarget]);

    expect(harness.retireLocalOnlyEntries).not.toHaveBeenCalled();
    expect(harness.records.copies).toHaveLength(1);
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    // 失败照逐条出口报错（批量不另设状态），成功提示仍然不出现。
    expect(noticeKeys.some((key) => key.includes("notice.delete.failed")))
      .toBe(true);
    expect(noticeKeys.some((key) => key.includes("notice.localOnly.uploaded")))
      .toBe(false);
  });

  it("batch upload is a no-op outside one-way mode (件②)", async () => {
    const harness = await makeUploadHarness({ direction: "two-way" });

    await harness.executor.uploadLocalOnlyEntries([copyTarget]);

    expect(harness.uploadFile).not.toHaveBeenCalled();
  });

  it("keeps the round's record upkeep identical while a path is ignored", async () => {
    const roundWithIgnore = async (ignored: readonly string[]) => {
      const harness = await makeCopyHarness({ remoteText: baseText });
      Object.assign(harness.state as never as Record<string, unknown>, {
        localOnlyIgnoreMemory: {
          schemaVersion: 1,
          kind: "local-only-ignore-memory",
          ignoredPaths: [...ignored],
        },
      });
      harness.executor.setSyncDirection("one-way");
      await harness.executor.run("manual", {}, true);
      return {
        copies: [...harness.state.localOnlyCopyEntries],
        note: textAt(harness.files, notePath),
        copy: textAt(harness.files, harness.copyPath),
        base: harness.state.baseSnapshot.map((entry) => entry.path),
      };
    };

    const plain = await roundWithIgnore([]);
    const ignored = await roundWithIgnore([copyNameFor(notePath, localMtime)]);

    // 忽略只影响提醒：副本照留、原路径照还原、记录照写、基线照更新。
    // 记录时间戳取 Date.now()，比较时只看路径/类别等事实。
    const stripTimes = (run: typeof plain) => ({
      ...run,
      copies: run.copies.map((entry) => ({
        version: entry.version,
        path: entry.path,
        copyPath: entry.copyPath,
        kind: entry.kind,
      })),
    });
    expect(stripTimes(ignored)).toEqual(stripTimes(plain));
    expect(ignored.copies).toHaveLength(1);
    expect(ignored.copy).toBe(localText);
    expect(ignored.note).toBe(baseText);
  });

  it("follows a remote deletion in one-way mode without any pending delete row", async () => {
    // 双向对照：同一个夹具在默认策略（不跟随）下会登记一条待确认删除。
    const twoWay = await makeCopyHarness({
      // 本机内容与基线一致（未被改过）＝"远端删除、本机照做"的待确认形态；
      // 本机改动过的形态是冲突行，不属于本用例。
      localText: baseText,
      remoteText: baseText,
      remoteMissing: true,
    });
    const twoWayRound = await twoWay.executor.run("manual", {}, true);
    expect(twoWay.upsertPendingDeletes).toHaveBeenCalled();
    expect(textAt(twoWay.files, notePath)).toBe(baseText);
    expect(twoWayRound.metrics?.automaticHandling.deleteLocal).toMatchObject({
      candidates: 0,
      completed: 0,
      failed: 0,
    });

    // 单向：删除直接跟随（本机文件被删），且不出现待确认删除；执行计数按
    // 生效策略记到 completed（片⑥ 收口）。
    const oneWay = await makeCopyHarness({
      localText: baseText,
      remoteText: baseText,
      remoteMissing: true,
    });
    oneWay.executor.setSyncDirection("one-way");
    const round = await oneWay.executor.run("manual", {}, true);
    expect(oneWay.upsertPendingDeletes).not.toHaveBeenCalled();
    expect(textAt(oneWay.files, notePath)).toBeUndefined();
    expect(round.deleted).toBe(1);
    expect(round.metrics?.automaticHandling.deleteLocal).toMatchObject({
      candidates: 1,
      completed: 1,
      failed: 0,
    });
    // 第四个读点（pendingDeleteRemovals）同样按生效策略：结算回执里必须带着
    // 这条路径的待确认删除清账，否则下次同步会重新冒出同一行。
    expect(oneWay.state.recordMutationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          pendingDeleteRemovals: [notePath],
        }),
      }),
    );
  });

  it("does nothing in two-way mode", async () => {
    const harness = await makeUploadHarness({ direction: "two-way" });

    await harness.executor.uploadLocalOnlyEntry(copyTarget);

    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.initVaultScope).not.toHaveBeenCalled();
    expect(harness.retireLocalOnlyEntries).not.toHaveBeenCalled();
  });

  it("creates the missing remote parent chain shallow to deep, then uploads", async () => {
    const nestedTarget = "notes/sub/note（副本 2026-10-11 2345）.md";
    const harness = await makeUploadHarness({ targetPath: nestedTarget });

    await harness.executor.uploadLocalOnlyEntry(nestedTarget);

    // 浅→深逐级建目录，再上传文件本身。
    expect(harness.createFolderPath.mock.calls.map((call) => call[1]))
      .toEqual(["notes", "notes/sub"]);
    expect(harness.callOrder).toEqual([
      "folder:notes",
      "folder:notes/sub",
      `upload:${nestedTarget}`,
    ]);
    expect(harness.records.copies).toEqual([]);
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    expect(noticeKeys.some((key) => key.includes("notice.localOnly.uploaded")))
      .toBe(true);
  });

  it("accepts an already existing parent chain and still uploads", async () => {
    const nestedTarget = "notes/sub/note（副本 2026-10-11 2345）.md";
    const harness = await makeUploadHarness({
      targetPath: nestedTarget,
      // 目录已在云端：按现有身份放行（不重复创建、不报失败）。
      existingParents: ["notes", "notes/sub"],
    });

    await harness.executor.uploadLocalOnlyEntry(nestedTarget);

    expect(harness.createFolderPath).not.toHaveBeenCalled();
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.records.copies).toEqual([]);
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    expect(noticeKeys.some((key) => key.includes("notice.localOnly.uploaded")))
      .toBe(true);
    expect(noticeKeys.some((key) => key.includes("notice.delete.failed")))
      .toBe(false);
  });

  it("adopts a folder that appeared between the check and the create (409)", async () => {
    const nestedTarget = "notes/sub/note（副本 2026-10-11 2345）.md";
    const harness = await makeUploadHarness({
      targetPath: nestedTarget,
      existingParents: ["notes", "notes/sub"],
    });
    // 竞态模型：第一次按路径查身份说"还没有"，create 也返回 409（null），
    // 之后再查就能拿到现有身份。
    const metadata = harness.onedriveMetadata();
    let firstLookup = true;
    metadata.mockImplementation(async (_vault: string, path: string) => {
      if (!path.startsWith("notes")) return null;
      if (firstLookup && path === "notes") {
        firstLookup = false;
        return null;
      }
      return {
        id: `remote-folder-${path}`,
        name: path.split("/").pop(),
        folder: {},
        parentReference: {
          id: path.includes("/")
            ? `remote-folder-${path.slice(0, path.lastIndexOf("/"))}`
            : TEST_SYNC_SCOPE.filesRootId,
        },
        eTag: `etag-remote-folder-${path}`,
        cTag: `ctag-remote-folder-${path}`,
      };
    });
    harness.createFolderPath.mockResolvedValue(null);

    await harness.executor.uploadLocalOnlyEntry(nestedTarget);

    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.records.copies).toEqual([]);
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    expect(noticeKeys.some((key) => key.includes("notice.localOnly.uploaded")))
      .toBe(true);
  });

  it("keeps the entry when the parent chain cannot be created", async () => {
    const nestedTarget = "notes/sub/note（副本 2026-10-11 2345）.md";
    const harness = await makeUploadHarness({
      targetPath: nestedTarget,
      createFolderFails: new OneDriveError(
        OneDriveErrorType.NetworkError,
        "offline",
        0,
      ),
    });

    await harness.executor.uploadLocalOnlyEntry(nestedTarget);

    // 建目录失败＝现役失败出口；不上传、不退场、不写基线。
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.retireLocalOnlyEntries).not.toHaveBeenCalled();
    expect(harness.records.copies).toHaveLength(1);
    expect(harness.state.baseSnapshot).toEqual([]);
    const noticeKeys = harness.noticeCenter.show.mock.calls
      .map((entry) => (entry[0] as { key: string }).key);
    expect(noticeKeys.some((key) => key.includes("notice.delete.failed")))
      .toBe(true);
  });

  it("does not create folders or upload again when the settled entry is replayed", async () => {
    const nestedTarget = "notes/sub/note（副本 2026-10-11 2345）.md";
    const harness = await makeUploadHarness({ targetPath: nestedTarget });

    await harness.executor.uploadLocalOnlyEntry(nestedTarget);
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    const foldersAfterFirst = harness.createFolderPath.mock.calls.length;
    expect(foldersAfterFirst).toBe(2);

    // 重放同一次动作：文件已有基线 ⇒ 不再是本机独有 ⇒ 既不建目录也不上传。
    await harness.executor.uploadLocalOnlyEntry(nestedTarget);

    expect(harness.createFolderPath).toHaveBeenCalledTimes(foldersAfterFirst);
    expect(harness.uploadFile).toHaveBeenCalledTimes(1);
    const notices = harness.noticeCenter.show.mock.calls
      .map((entry) => entry[0] as { key: string; message?: string });
    // 退场提示走现役失败出口，理由句是"这条待处理项已经过期"。
    expect(notices.some((entry) => entry.key.includes("notice.delete.failed")))
      .toBe(true);
    expect(notices.some((entry) =>
      entry.key.includes("notice.delete.failed")
      && (entry.message ?? "").includes("这条待处理项已经过期"))).toBe(true);
  });

  it("refuses to create parents outside the sync scope or inside the excluded blocks", async () => {
    const nestedTarget = "notes/sub/note（副本 2026-10-11 2345）.md";
    const outOfScope = await makeUploadHarness({
      targetPath: nestedTarget,
      shouldSyncFolderPath: (path) => path !== "notes/sub",
    });
    await outOfScope.executor.uploadLocalOnlyEntry(nestedTarget);
    expect(outOfScope.createFolderPath).not.toHaveBeenCalled();
    expect(outOfScope.uploadFile).not.toHaveBeenCalled();
    expect(outOfScope.records.copies).toHaveLength(1);

    // 排除三块（社区插件路径）：一道保险，不建目录、不上传。
    const excludedTarget = ".obsidian/plugins/calendar/main.js";
    const excluded = await makeUploadHarness({ targetPath: excludedTarget });
    await excluded.executor.uploadLocalOnlyEntry(excludedTarget);
    expect(excluded.createFolderPath).not.toHaveBeenCalled();
    expect(excluded.uploadFile).not.toHaveBeenCalled();
  });
});
});

