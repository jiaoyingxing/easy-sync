// 本机扫描健康与只读预览
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
//
// 原文件文件头（随 P0 用例一并留在本文件）：
// Behavior tests for EasySync core sync safety (P0.1 / P0.2 / P0.3).
// These tests are the minimum safety net for the three data-loss vectors
// identified in the high-tier model review. Each test maps to a specific P0 fix commit.
//   P0.1 (2776e59): Download always executes, even when local file exists
//   P0.2 (efcae57): Scan failures block destructive delete actions
//   P0.3 (72e19d6): Full SHA-256 catches modifications that quick hash missed

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

describe("automatic non-overlapping text merge", () => {
  it("keeps a text conflict manual without downloading content when the option is off", async () => {
    const path = "note.md";
    const local: LocalFileEntry = {
      path,
      size: 5,
      mtime: 2,
      hash: "aa".repeat(32),
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 6,
      mtime: 3,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: "cc".repeat(32),
    };
    const base: BaseFileEntry = {
      path,
      size: 4,
      hash: "bb".repeat(32),
      eTag: "etag-base",
    };
    const adapter = makeMockAdapter({
      readBinary: vi.fn().mockResolvedValue(new TextEncoder().encode("local").buffer),
    });
    const downloadFile = vi.fn().mockResolvedValue(new TextEncoder().encode("remote").buffer);
    const uploadFile = vi.fn().mockResolvedValue({ id: "merged-id", eTag: "etag-merged" });
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State([remote], [base], {
      getBaseContent: vi.fn().mockReturnValue("base"),
      upsertPendingConflicts,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile, uploadFile }),
      {
        vault: {
          adapter,
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
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
      undefined,
      undefined,
      undefined,
    );
    executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: false,
    });

    const result = await executor.run("manual", {});
    expect(result.conflicts).toBe(1);
    expect(result.message).toBe("result.conflictsPending");
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path,
        local,
        remote: expect.objectContaining(remote),
        reason: "reason.bothSidesModified",
        decisionToken: expect.objectContaining({
          version: 1,
          ancestorHash: base.hash,
        }),
      }),
    ]);
  });

  it("commits a verified clean merge through remote CAS, read-back, local replacement, and checkpoint", async () => {
    const path = "note.md";
    const baseText = "a\nb\nc\nd";
    const localText = "a\nlocal-b\nc\nd";
    let remoteText = "a\nb\nremote-c\nd";
    const baseBytes = new TextEncoder().encode(baseText).buffer;
    const localBytes = new TextEncoder().encode(localText).buffer;
    const baseHash = await sha256Hex(baseBytes);
    const localHash = await sha256Hex(localBytes);
    const files = new Map<string, ArrayBuffer>([[path, localBytes]]);
    const texts = new Map<string, string>();
    let interruptedLocalCommit = false;
    const adapter = makeMockAdapter({
      read: vi.fn(async (target: string) => {
        const value = texts.get(target);
        if (value === undefined) throw new Error(`missing ${target}`);
        return value;
      }),
      write: vi.fn(async (target: string, value: string) => {
        texts.set(target, value);
      }),
      readBinary: vi.fn(async (target: string) => {
        const value = files.get(target);
        if (!value) throw new Error(`missing ${target}`);
        return value.slice(0);
      }),
      writeBinary: vi.fn(async (target: string, value: ArrayBuffer) => {
        files.set(target, value.slice(0));
      }),
      exists: vi.fn(async (target: string) => files.has(target) || texts.has(target)),
      stat: vi.fn(async (target: string) => {
        const binary = files.get(target);
        if (binary) return { size: binary.byteLength, mtime: 1 };
        const text = texts.get(target);
        return text === undefined
          ? null
          : { size: new TextEncoder().encode(text).byteLength, mtime: 1 };
      }),
      rename: vi.fn(async (source: string, target: string) => {
        if (!interruptedLocalCommit && source.endsWith(".merge-ready") && target === path) {
          interruptedLocalCommit = true;
          throw new Error("simulated interruption after remote merge commit");
        }
        if (files.has(source)) {
          files.set(target, files.get(source)!);
          files.delete(source);
          return;
        }
        if (texts.has(source)) {
          texts.set(target, texts.get(source)!);
          texts.delete(source);
          return;
        }
        throw new Error(`missing ${source}`);
      }),
      remove: vi.fn(async (target: string) => {
        files.delete(target);
        texts.delete(target);
      }),
    });
    const inspectFile = vi.fn(async () => {
      const bytes = files.get(path);
      if (!bytes) return { status: "missing" as const };
      return {
        status: "present" as const,
        entry: {
          path,
          size: bytes.byteLength,
          mtime: 1,
          hash: await sha256Hex(bytes),
          binary: false,
        },
      };
    });
    let remoteETag = "etag-remote";
    const downloadFile = vi.fn(async () => new TextEncoder().encode(remoteText).buffer);
    const uploadFile = vi.fn(async (
      _vault: string,
      _path: string,
      content: ArrayBuffer,
      _progress?: unknown,
      eTag?: string,
      driveId?: string,
    ) => {
      expect(eTag).toBe("etag-remote");
      expect(driveId).toBe("remote-note");
      remoteText = new TextDecoder().decode(content);
      remoteETag = "etag-merged";
      return {
        id: "remote-note",
        name: "note.md",
        size: content.byteLength,
        eTag: remoteETag,
        parentReference: { id: "files-root-id" },
      };
    });
    const getFileMetadata = vi.fn(async () => {
      const bytes = new TextEncoder().encode(remoteText).buffer;
      return {
        driveId: "remote-note",
        parentId: "files-root-id",
        downloadUrl: "remote-url",
        size: bytes.byteLength,
        mtime: 1,
        eTag: remoteETag,
        sha256Hash: await sha256Hex(bytes),
      };
    });
    const local: LocalFileEntry = {
      path,
      size: localBytes.byteLength,
      mtime: 1,
      hash: localHash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-note",
      parentId: "files-root-id",
      downloadUrl: "remote-url",
      size: new TextEncoder().encode(remoteText).byteLength,
      mtime: 1,
      eTag: remoteETag,
      cTag: "ctag-remote",
      sha256Hash: await sha256Hex(
        new TextEncoder().encode(remoteText).buffer,
      ),
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      [{ path, hash: baseHash, size: baseBytes.byteLength, eTag: "etag-base" }],
      {
      getBaseEntry: vi.fn().mockReturnValue({
        path,
        hash: baseHash,
        size: baseBytes.byteLength,
        eTag: "etag-base",
      }),
      getBaseContent: vi.fn().mockReturnValue(baseText),
      upsertPendingConflicts,
      },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile, uploadFile, getFileMetadata }),
      {
        vault: {
          adapter,
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
        inspectFile,
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const onFileComplete = vi.fn();
    let changedPolicyDuringRun = false;
    const result = await executor.run("manual", {
      onFileComplete,
      onProgress: () => {
        if (changedPolicyDuringRun) return;
        changedPolicyDuringRun = true;
        executor.setAutomaticHandlingPolicy({
          autoDeleteLocalFiles: false,
          mergeNonOverlappingText: false,
        });
      },
    });
    expect(result.conflicts).toBe(0);
    expect(result.uploaded).toBe(1);
    expect(result.metrics?.automaticHandling.textMerge).toMatchObject({
      candidates: 1,
      completed: 1,
      keptManual: 0,
      failed: 0,
      cancelled: 0,
      manualReasons: {},
    });
    expect(result.metrics?.automaticHandling.mergeRecovery).toMatchObject({
      records: 0,
      remoteCommittedLocalRecovered: 0,
      remoteCommittedLocalPending: 0,
    });
    expect(changedPolicyDuringRun).toBe(true);
    expect(interruptedLocalCommit).toBe(true);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(onFileComplete).toHaveBeenCalledWith(
      path,
      SyncActionType.Upload,
      true,
      expect.any(String),
      files.get(path)!.byteLength,
    );
    expect(remoteText).toBe("a\nlocal-b\nremote-c\nd");
    expect(new TextDecoder().decode(files.get(path))).toBe(remoteText);
    // 决策行随计划落地（2026-10-18 第五刀）：计划步先写一次这条冲突行；本轮把它
    // 自动合并结清 ⇒ 结清的检查点携 pendingConflictRemovals 把它退休（状态侧的
    // commitMutationCheckpoint 按该字段过滤待办行）⇒ 轮末不再写、也不会留下行。
    expect(upsertPendingConflicts).toHaveBeenCalledTimes(1);
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({ path, type: SyncActionType.Conflict }),
    ]);
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseUpserts: [expect.objectContaining({ path, hash: await sha256Hex(files.get(path)!) })],
        remoteUpserts: [expect.objectContaining({ path, driveId: "remote-note", eTag: "etag-merged" })],
        pendingConflictRemovals: [path],
      }),
    }));
  });

  it.each([
    "reason.newFileBothSides",
    "reason.bothSidesModified",
  ])("always converges byte-identical %s conflicts", async (reason) => {
    const hash = "ab".repeat(32);
    const local: LocalFileEntry = {
      path: "same.md",
      size: 4,
      mtime: 2,
      hash,
      binary: false,
    };
    const remote: RemoteFileEntry = {
      path: local.path,
      driveId: "remote-same",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: local.size,
      mtime: 3,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: hash,
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [remote],
      reason === "reason.bothSidesModified"
        ? [{ path: local.path, hash: "cd".repeat(32), size: local.size, eTag: "etag-base" }]
        : [],
      { upsertPendingConflicts },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive(),
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
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});
    expect(result.conflicts).toBe(0);
    expect(state.upsertBaseEntries).toHaveBeenCalledWith([
      expect.objectContaining({ path: local.path, hash }),
    ]);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
  });
});

describe("device-local sync scope projection", () => {
  it("passes only in-scope durable base entries to planning", async () => {
    const includedBase: BaseFileEntry = {
      path: "keep.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-keep",
    };
    const excludedBase: BaseFileEntry = {
      path: "Private.drop.md",
      hash: "bb".repeat(32),
      size: 11,
      eTag: "etag-drop",
    };
    const includedLocal: LocalFileEntry = {
      path: includedBase.path,
      size: includedBase.size,
      mtime: 1,
      hash: includedBase.hash,
      binary: false,
    };
    const excludedLocal: LocalFileEntry = {
      path: excludedBase.path,
      size: excludedBase.size,
      mtime: 1,
      hash: excludedBase.hash,
      binary: false,
    };
    const upsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
    const state = makeActiveV2State(
      [],
      [includedBase, excludedBase],
      { upsertPendingDeletes },
    );
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [includedLocal, excludedLocal],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        shouldSyncPath: vi.fn((path: string) => !path.startsWith("Private")),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    // 计划步落地与轮末 owner 各按路径 upsert 同一行（2026-10-18 第五刀的两个
    // 写点）⇒ 按路径去重后必须只有范围内那一条。
    const pendingDeletes = upsertPendingDeletes.mock.calls.flatMap(
      ([items]) => items as SyncPlanItem[],
    );
    expect([...new Set(pendingDeletes.map((item) => item.path))]).toEqual([
      includedBase.path,
    ]);
    expect(pendingDeletes.every(
      (item) => item.type === SyncActionType.ConfirmLocalDelete,
    )).toBe(true);
  });
});

// ---- P0.3: Full SHA-256 hash correctness ----

describe("P0.3 — sha256Hex (full SHA-256)", () => {
  it("same content produces same hash", async () => {
    const data = new TextEncoder().encode("hello world").buffer;
    const h1 = await sha256Hex(data);
    const h2 = await sha256Hex(data);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("different content produces different hash", async () => {
    const a = new TextEncoder().encode("hello world").buffer;
    const b = new TextEncoder().encode("hello worlD").buffer;
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it("modification beyond 16KB is detected (old quickHash blind spot)", async () => {
    const size = 20 * 1024;
    const buf1 = new Uint8Array(size);
    const buf2 = new Uint8Array(size);
    for (let i = 0; i < 16 * 1024; i++) {
      buf1[i] = buf2[i] = i % 256;
    }
    buf2[size - 1] = 0xff;

    const h1 = await sha256Hex(buf1.buffer);
    const h2 = await sha256Hex(buf2.buffer);
    expect(h1).not.toBe(h2);
  });

  it("0-byte file hash matches known SHA-256 empty input", async () => {
    const empty = new ArrayBuffer(0);
    const h = await sha256Hex(empty);
    expect(h).toHaveLength(64);
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("same-size entirely different content produces different hash", async () => {
    const buf1 = new Uint8Array(1000).fill(0x41);
    const buf2 = new Uint8Array(1000).fill(0x42);
    expect(await sha256Hex(buf1.buffer)).not.toBe(await sha256Hex(buf2.buffer));
  });
});

// ---- P0.2: Incomplete local scan stops the whole round ----
// Tests the REAL production path via SyncExecutor.run(), not a copied helper.

describe("P0.2 — incomplete local scan causes zero mutation (real executor)", () => {
  async function runWithV2Facts(
    facts: {
      localEntries?: LocalFileEntry[];
      remoteEntries?: RemoteFileEntry[];
      baseEntries?: BaseFileEntry[];
      failedPaths?: string[];
      complete?: boolean;
      stableFillerCount?: number;
    },
    options: {
      autoDeleteLocalFiles?: boolean;
      inspectFile?: ReturnType<typeof vi.fn>;
      getFileMetadata?: ReturnType<typeof vi.fn>;
      deleteItem?: ReturnType<typeof vi.fn>;
      adapterOverrides?: Record<string, unknown>;
      recordMutationReceipt?: ReturnType<typeof vi.fn>;
      recordCloudDeletion?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const fillerBaseEntries = Array.from(
      { length: facts.stableFillerCount ?? 0 },
      (_, index): BaseFileEntry => ({
        path: `stable-${index}.md`,
        hash: `${index.toString(16).padStart(2, "0")}`.repeat(32),
        size: 10,
        eTag: `etag-stable-${index}`,
      }),
    );
    const fillerLocalEntries = fillerBaseEntries.map(
      (entry): LocalFileEntry => ({
        path: entry.path,
        hash: entry.hash,
        size: entry.size,
        mtime: 1,
        binary: false,
      }),
    );
    const fillerRemoteEntries = fillerBaseEntries.map(
      (entry, index): RemoteFileEntry => ({
        path: entry.path,
        driveId: `remote-stable-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: entry.size,
        mtime: 1,
        eTag: entry.eTag,
        cTag: `ctag-stable-${index}`,
        sha256Hash: entry.hash,
      }),
    );
    const localEntries = [
      ...(facts.localEntries ?? []),
      ...fillerLocalEntries,
    ];
    const remoteEntries = [
      ...(facts.remoteEntries ?? []),
      ...fillerRemoteEntries,
    ];
    const baseEntries = [
      ...(facts.baseEntries ?? []),
      ...fillerBaseEntries,
    ];
    const failedPaths = facts.failedPaths ?? [];
    const complete = facts.complete ?? failedPaths.length === 0;
    const mockDeleteItem = options.deleteItem ?? vi.fn().mockResolvedValue(undefined);
    const mockDownloadFile = vi.fn().mockResolvedValue(new ArrayBuffer(1));
    const mockInitVaultScope = vi.fn().mockResolvedValue({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    const mockUpsertPendingDeletes = vi.fn().mockResolvedValue(undefined);
    const mockPrunePendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockPrunePendingDeletes = vi.fn().mockResolvedValue(undefined);
    const mockSetLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const mockGetDelta = vi.fn().mockResolvedValue({
      value: remoteEntries.map((entry) => ({
        id: entry.driveId,
        name: entry.path,
        size: entry.size,
        eTag: entry.eTag,
        cTag: entry.cTag,
        parentReference: {
          id: entry.parentId ?? TEST_SYNC_SCOPE.filesRootId,
        },
        lastModifiedDateTime: new Date(entry.mtime).toISOString(),
        file: {
          hashes: {
            ...(entry.sha256Hash
              ? { sha256Hash: entry.sha256Hash }
              : {}),
            ...(entry.quickXorHash
              ? { quickXorHash: entry.quickXorHash }
              : {}),
          },
        },
      })),
      "@odata.deltaLink": "tok",
    });

    const mockOneDrive = makeMockOneDrive({
      deleteItem: mockDeleteItem,
      downloadFile: mockDownloadFile,
      initVaultScope: mockInitVaultScope,
      getFileMetadata: options.getFileMetadata ?? vi.fn().mockResolvedValue(null),
      getDelta: mockGetDelta,
    });

    const mockAdapter = makeMockAdapter(options.adapterOverrides);
    const mockScanner = {
      vault: {
        adapter: mockAdapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
        getFileByPath: vi.fn().mockReturnValue(null),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: localEntries,
        folders: [],
        folderScanComplete: true,
        folderScanFailures: [],
        skippedLarge: [],
        failedPaths,
        skippedCount: 0,
        complete,
      }),
      scanFile: vi.fn().mockResolvedValue(null),
      inspectFile: options.inspectFile ?? vi.fn(async (path: string) => {
        const entry = localEntries.find((candidate) => candidate.path === path);
        return entry
          ? { status: "present" as const, entry }
          : { status: "missing" as const };
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const mutationState = makeActiveV2State(remoteEntries, baseEntries, {
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: mockPrunePendingConflicts,
      upsertPendingDeletes: mockUpsertPendingDeletes,
      prunePendingDeletes: mockPrunePendingDeletes,
      setLastSyncTime: mockSetLastSyncTime,
      ...(options.recordCloudDeletion
        ? { recordCloudDeletion: options.recordCloudDeletion }
        : {}),
    });
    if (options.recordMutationReceipt) {
      mutationState.recordMutationReceipt = options.recordMutationReceipt;
    }

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mutationState,
      "testVault",
    );
    executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: options.autoDeleteLocalFiles ?? false,
      mergeNonOverlappingText: true,
    });

    const result = await executor.run("manual", {});

    return {
      result,
      mockDeleteItem,
      mockDownloadFile,
      mockInitVaultDirectories: mockInitVaultScope,
      mockUpsertPendingDeletes,
      mockPrunePendingConflicts,
      mockPrunePendingDeletes,
      mockSetLastSyncTime,
      mockGetDelta,
      mockAdapter,
      mutationState,
    };
  }

  function base(path: string): BaseFileEntry {
    return {
      path,
      hash: "aa".repeat(32),
      size: 10,
      eTag: `etag-${path}`,
    };
  }

  function local(entry: BaseFileEntry): LocalFileEntry {
    return {
      path: entry.path,
      size: entry.size,
      mtime: 1,
      hash: entry.hash,
      binary: false,
    };
  }

  function remote(entry: BaseFileEntry): RemoteFileEntry {
    return {
      path: entry.path,
      driveId: `id-${entry.path}`,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: entry.size,
      mtime: 1,
      eTag: entry.eTag,
      cTag: `ctag-${entry.path}`,
      sha256Hash: entry.hash,
    };
  }

  it("blocks DeleteRemote — deleteItem is never called when scan unhealthy", async () => {
    const a = base("a.md");
    const b = base("b.md");
    const { mockDeleteItem } = await runWithV2Facts({
      baseEntries: [a, b],
      remoteEntries: [remote(a), remote(b)],
      failedPaths: ["failed.txt"],
    });
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  it("overlaps remote file deletes through the cleanup pool instead of serial round trips", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      let activeDeletes = 0;
      let peakDeletes = 0;
      const deleteItem = vi.fn().mockImplementation(async () => {
        activeDeletes++;
        peakDeletes = Math.max(peakDeletes, activeDeletes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeDeletes--;
      });
      const entries = Array.from({ length: 9 }, (_, index) => base(`del-${index}.md`));
      const { result, mockDeleteItem } = await runWithV2Facts({
        baseEntries: entries,
        remoteEntries: entries.map((entry) => remote(entry)),
      }, {
        deleteItem,
      });

      expect(result.deleted).toBe(entries.length);
      expect(result.errors).toBe(0);
      expect(mockDeleteItem).toHaveBeenCalledTimes(entries.length);
      // Serial execution keeps at most one delete in flight; the cleanup
      // pool must overlap the independent round trips so bulk local-delete
      // rounds do not cost one remote RTT per file.
      expect(peakDeletes).toBeGreaterThanOrEqual(2);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("blocks ConfirmLocalDelete — pending delete batch stays empty when scan unhealthy", async () => {
    const deletedRemotely = base("c.md");
    const { mockUpsertPendingDeletes } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [local(deletedRemotely)],
      failedPaths: ["failed.txt"],
    });
    expect(mockUpsertPendingDeletes).not.toHaveBeenCalled();
  });

  it("reports scan failures without generating or executing a plan", async () => {
    const x = base("x.md");
    const y = base("y.md");
    const {
      result,
      mockGetDelta,
      mockInitVaultDirectories,
      mutationState,
    } = await runWithV2Facts({
      baseEntries: [x, y],
      remoteEntries: [remote(x), remote(y)],
      failedPaths: ["failed.txt"],
    });
    expect(result.errors).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.message).toBe("result.scanIncomplete");
    expect(mockGetDelta).not.toHaveBeenCalled();
    expect(mockInitVaultDirectories).not.toHaveBeenCalled();
    expect(mutationState.getCommittedV2Envelope).not.toHaveBeenCalled();
  });

  it("allows DeleteRemote when scan is healthy (no failed paths)", async () => {
    const deletedLocally = base("safe.md");
    const { mockDeleteItem } = await runWithV2Facts({
      baseEntries: [deletedLocally],
      remoteEntries: [remote(deletedLocally)],
      stableFillerCount: 9,
    });
    expect(mockDeleteItem).toHaveBeenCalled();
  });

  it("records a successful cloud file delete in the device-local deletion ledger", async () => {
    const deletedLocally = base("safe.md");
    const recordCloudDeletion = vi.fn().mockResolvedValue(undefined);
    const { mockDeleteItem } = await runWithV2Facts({
      baseEntries: [deletedLocally],
      remoteEntries: [remote(deletedLocally)],
    }, { recordCloudDeletion });

    expect(mockDeleteItem).toHaveBeenCalledTimes(1);
    expect(recordCloudDeletion).toHaveBeenCalledWith({
      remoteId: `id-${deletedLocally.path}`,
      path: deletedLocally.path,
      deletedAt: expect.any(Number),
      kind: "file",
    });
  });

  it("records nothing when the Graph delete itself fails", async () => {
    const deletedLocally = base("safe.md");
    const recordCloudDeletion = vi.fn().mockResolvedValue(undefined);
    const deleteItem = vi.fn().mockRejectedValue(new Error("graph 500"));
    // 回读证明对象仍在云端 ⇒ 这次删除没有发生，不得留下任何恢复线索。
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: `id-${deletedLocally.path}`,
      size: deletedLocally.size,
      mtime: 1,
      eTag: deletedLocally.eTag,
      downloadUrl: `https://download.example/${deletedLocally.path}`,
      sha256Hash: deletedLocally.hash,
    });
    const { result, mockDeleteItem } = await runWithV2Facts({
      baseEntries: [deletedLocally],
      remoteEntries: [remote(deletedLocally)],
    }, { recordCloudDeletion, deleteItem, getFileMetadata });

    expect(mockDeleteItem).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(0);
    expect(recordCloudDeletion).not.toHaveBeenCalled();
  });

  it("keeps a delete successful when the ledger write fails", async () => {
    const deletedLocally = base("safe.md");
    const recordCloudDeletion = vi
      .fn()
      .mockRejectedValue(new Error("plugin data write failed"));
    // 回读仍能看见对象（本轮删除已由 Graph 确认落地）：记账失败若上抛，这一轮
    // 会把已经发生的删除当失败处理。
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: `id-${deletedLocally.path}`,
      size: deletedLocally.size,
      mtime: 1,
      eTag: deletedLocally.eTag,
      downloadUrl: `https://download.example/${deletedLocally.path}`,
      sha256Hash: deletedLocally.hash,
    });
    const { result } = await runWithV2Facts({
      baseEntries: [deletedLocally],
      remoteEntries: [remote(deletedLocally)],
    }, { recordCloudDeletion, getFileMetadata });

    // 记账失败只留诊断：删除照常落地、本轮不因此多一个错误。
    expect(recordCloudDeletion).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("allows ConfirmLocalDelete when scan is healthy", async () => {
    const deletedRemotely = base("safe.md");
    const localEntry = local(deletedRemotely);
    const { mockUpsertPendingDeletes } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    });
    expect(mockUpsertPendingDeletes).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.ConfirmLocalDelete,
        path: deletedRemotely.path,
        local: localEntry,
        reason: "reason.fileDeletedFromRemote",
        decisionToken: expect.objectContaining({ version: 1 }),
      }),
    ]);
  });

  it("counts a merge candidate kept manual when no trusted ancestor is available", async () => {
    const path = "manual-merge.md";
    const common: BaseFileEntry = {
      path,
      size: 4,
      hash: "bb".repeat(32),
      eTag: "etag-base",
    };
    const localEntry: LocalFileEntry = {
      path,
      size: 5,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const remoteEntry: RemoteFileEntry = {
      path,
      driveId: "remote-manual-merge",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 6,
      mtime: 2,
      eTag: "etag-manual-merge",
      cTag: "ctag-manual-merge",
      sha256Hash: "cc".repeat(32),
    };
    const { result, mockDownloadFile } = await runWithV2Facts({
      baseEntries: [common],
      localEntries: [localEntry],
      remoteEntries: [remoteEntry],
    });

    expect(result.conflicts).toBe(1);
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(result.metrics?.automaticHandling.textMerge).toMatchObject({
      candidates: 1,
      completed: 0,
      keptManual: 1,
      failed: 0,
      manualReasons: { "ancestor-unavailable": 1 },
    });
  });

  it("executes an authorized local delete through the cleanup mutation checkpoint", async () => {
    const deletedRemotely = base("auto-delete.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const inspectFile = vi.fn().mockResolvedValue({
      status: "present",
      entry: localEntry,
    });
    const recordCloudDeletion = vi.fn().mockResolvedValue(undefined);
    const {
      result,
      mockAdapter,
      mutationState,
      mockUpsertPendingDeletes,
      mockPrunePendingDeletes,
    } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile,
      adapterOverrides: { remove },
      recordCloudDeletion,
    });

    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
    // 跟随删除侧（文件版本找回刀一之三）：这个现场取不到远端 id（committed 锚点
    // 里没有身份）——不记、不抛，删除照常落地。
    expect(recordCloudDeletion).not.toHaveBeenCalled();
    expect(result.metrics?.automaticHandling.deleteLocal).toEqual({
      candidates: 1,
      completed: 1,
      failed: 0,
    });
    expect(mockAdapter.remove).toHaveBeenCalledWith(deletedRemotely.path);
    expect(mockPrunePendingDeletes).toHaveBeenCalledWith([deletedRemotely.path]);
    expect(mockUpsertPendingDeletes).not.toHaveBeenCalled();
    expect(mutationState.beginMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: "deleteLocal",
      path: deletedRemotely.path,
      expectedLocal: {
        exists: true,
        hash: localEntry.hash,
        size: localEntry.size,
      },
      expectedRemote: { exists: false },
    }));
    expect(mutationState.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseRemovals: [deletedRemotely.path],
        pendingDeleteRemovals: [deletedRemotely.path],
      }),
    }));
    expect(mutationState.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the local version changed before an automatic delete", async () => {
    const deletedRemotely = base("changed.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const { result, mutationState } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...localEntry, hash: "bb".repeat(32) },
      }),
      adapterOverrides: { remove },
    });

    expect(result.errors).toBe(1);
    expect(result.metrics?.automaticHandling.deleteLocal).toEqual({
      candidates: 1,
      completed: 0,
      failed: 1,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(mutationState.recordMutationReceipt).not.toHaveBeenCalled();
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(mutationState.abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(mutationState.mutationLedger).toEqual([]);
    expect(mutationState.reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: deletedRemotely.path,
        actionType: SyncActionType.DeleteLocal,
        reason: "syncView.failure.localChangedBeforeDelete",
      })],
      new Set(),
    );
  });

  it("fails closed when the remote file reappeared before an automatic delete", async () => {
    const deletedRemotely = base("restored-remotely.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const inspectFile = vi.fn();
    const { result, mutationState } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile,
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "remote-restored",
        size: localEntry.size,
        mtime: 2,
        eTag: "etag-restored",
      }),
      adapterOverrides: { remove },
    });

    expect(result.errors).toBe(1);
    expect(inspectFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(mutationState.abandonMutationIntent).toHaveBeenCalledTimes(1);
    expect(mutationState.mutationLedger).toEqual([]);
  });

  it("does not publish a checkpoint when receipt persistence fails after deletion", async () => {
    const deletedRemotely = base("receipt-failure.md");
    const localEntry = local(deletedRemotely);
    const remove = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockRejectedValue(new Error("receipt unavailable"));
    const { result, mutationState } = await runWithV2Facts({
      baseEntries: [deletedRemotely],
      localEntries: [localEntry],
    }, {
      autoDeleteLocalFiles: true,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: localEntry,
      }),
      adapterOverrides: { remove },
      recordMutationReceipt,
    });

    expect(remove).toHaveBeenCalledWith(deletedRemotely.path);
    expect(result.errors).toBe(1);
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
  });

  it("blocks downloads and state cleanup as well as destructive actions", async () => {
    const remoteOnly: RemoteFileEntry = {
      path: "b.md",
      driveId: "id-b",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 1,
      mtime: 1,
      eTag: "etag-b",
      cTag: "ctag-b",
      sha256Hash: "bb".repeat(32),
    };
    const {
      result,
      mockDownloadFile,
      mockPrunePendingConflicts,
      mockPrunePendingDeletes,
      mockSetLastSyncTime,
    } = await runWithV2Facts({
      remoteEntries: [remoteOnly],
      failedPaths: ["failed.txt"],
    });
    expect(result.errors).toBe(1);
    expect(result.downloaded).toBe(0);
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockPrunePendingConflicts).not.toHaveBeenCalled();
    expect(mockPrunePendingDeletes).not.toHaveBeenCalled();
    expect(mockSetLastSyncTime).not.toHaveBeenCalled();
  });

  it("stops when the scanner reports incomplete without path detail", async () => {
    const unknown = base("unknown.md");
    const {
      result,
      mockGetDelta,
      mockInitVaultDirectories,
    } = await runWithV2Facts({
      baseEntries: [unknown],
      remoteEntries: [remote(unknown)],
      complete: false,
    });

    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.scanIncomplete");
    expect(mockGetDelta).not.toHaveBeenCalled();
    expect(mockInitVaultDirectories).not.toHaveBeenCalled();
  });
});

describe("D7 read-only preview contract", () => {
  it("uses GET-only scope preparation and cannot execute even if preview confirms", async () => {
    const local: LocalFileEntry = {
      path: "preview-only.md",
      size: 7,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const uploadFile = vi.fn().mockResolvedValue({ id: "uploaded", eTag: "etag-new" });
    const initVaultScope = vi.fn().mockResolvedValue({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    const adapter = makeMockAdapter();
    const state = makeActiveV2State([], []);
    const onFirstSyncPreview = vi.fn().mockResolvedValue(true);
    const executor = new SyncExecutor(
      makeMockOneDrive({ initVaultScope, uploadFile }),
      {
        vault: {
          adapter,
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
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run(
      "first",
      { onFirstSyncPreview },
      false,
      undefined,
      { readOnlyPreview: true },
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(result.runFacts?.planReviewPaused).toBe(true);
    expect(initVaultScope).toHaveBeenCalledWith("testVault", { createMissing: false });
    expect(onFirstSyncPreview).toHaveBeenCalledOnce();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });
});

describe("Preflight P0 — Download never overwrites a path that changed after scan", () => {
  it("does not overwrite a remote-only path created after the scan", async () => {
    const buf16 = new ArrayBuffer(16);
    const mockDownloadFile = vi.fn().mockImplementation(
      (_v: string, _p: string, _u?: string, _d?: string, s = 0, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(0, s);
        onProgress?.(buf16.byteLength, s || buf16.byteLength);
        return Promise.resolve(buf16);
      },
    );
    const mockWriteBinary = vi.fn().mockResolvedValue(undefined);
    const mockScanFile = vi.fn().mockResolvedValue({
      path: "test.md",
      hash: "abcd1234".repeat(8),
      size: 16,
    });

    const mockOneDrive = makeMockOneDrive({
      downloadFile: mockDownloadFile,
      uploadFile: vi.fn(),
      deleteItem: vi.fn(),
    });
    const remote: RemoteFileEntry = {
      path: "test.md",
      driveId: "item123",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://example.com/dl",
      size: buf16.byteLength,
      mtime: Date.now(),
      eTag: "etag1",
      cTag: "ctag1",
      sha256Hash: await sha256Hex(buf16),
    };

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter({ writeBinary: mockWriteBinary }),
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
      scanFile: mockScanFile,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: await mockScanFile(),
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const mockState = makeActiveV2State([remote], [], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
    });
    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockState,
      "testVault",
      undefined,
      undefined,
    );

    await executor.run("manual", {
    });

    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockWriteBinary).not.toHaveBeenCalled();
    expect(mockState.addPendingConflict).toHaveBeenCalledTimes(1);
  });

  it("routes a same-path new file on both sides to conflict without downloading", async () => {
    const mockDownloadFile = vi.fn().mockResolvedValue(new ArrayBuffer(32));
    const mockWriteBinary = vi.fn().mockResolvedValue(undefined);

    const mockOneDrive = makeMockOneDrive({
      downloadFile: mockDownloadFile,
      uploadFile: vi.fn(),
      deleteItem: vi.fn(),
    });
    const remote: RemoteFileEntry = {
      path: "existing.md",
      driveId: "item456",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      downloadUrl: "https://example.com/dl2",
      size: 32,
      mtime: Date.now() + 10000,
      eTag: "etag2",
      cTag: "ctag2",
      sha256Hash: "22".repeat(32),
    };

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter({ writeBinary: mockWriteBinary }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [
          {
            path: "existing.md",
            size: 100,
            mtime: 1,
            hash: "11".repeat(32),
            binary: false,
          },
        ],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: vi.fn().mockResolvedValue({
        path: "existing.md",
        hash: "newhash".repeat(8),
        size: 32,
      }),
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: {
          path: "existing.md",
          hash: "newhash".repeat(8),
          size: 32,
          mtime: 2,
          binary: false,
        },
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State([remote], [], {
      upsertPendingConflicts,
    });

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockState,
      "testVault",
    );

    await executor.run("manual", {});

    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockWriteBinary).not.toHaveBeenCalled();
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: remote.path,
        reason: "reason.newFileBothSides",
      }),
    ]);
  });

  it("stops after the network download when a remote-only path appears before the write", async () => {
    const path = "created-during-download.md";
    const downloaded = new Uint8Array([7, 7, 7]).buffer;
    const created: LocalFileEntry = {
      path,
      hash: await sha256Hex(new Uint8Array([9, 9, 9]).buffer),
      size: 3,
      mtime: 2,
      binary: false,
    };
    const inspectFile = vi.fn()
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "present", entry: created });
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const downloadFile = vi.fn().mockResolvedValue(downloaded);
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: downloaded.byteLength,
      mtime: 1,
      eTag: "etag",
      cTag: "ctag",
      sha256Hash: await sha256Hex(downloaded),
    };
    const state = makeActiveV2State([remote], [], {
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary }),
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
        inspectFile,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(writeBinary).not.toHaveBeenCalled();
    expect(state.addPendingConflict).toHaveBeenCalledTimes(1);
    expect(result.conflicts).toBe(1);
  });
});

