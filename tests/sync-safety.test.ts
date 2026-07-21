/**
 * Behavior tests for EasySync core sync safety (P0.1 / P0.2 / P0.3).
 *
 * These tests are the minimum safety net for the three data-loss vectors
 * identified in the high-tier model review. Each test maps to a specific
 * P0 fix commit.
 *
 * P0.1 (2776e59): Download always executes, even when local file exists
 * P0.2 (efcae57): Scan failures block destructive delete actions
 * P0.3 (72e19d6): Full SHA-256 catches modifications that quick hash missed
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import * as obsidian from "obsidian";
import { Platform, type Plugin } from "obsidian";
import { sha256Hex } from "../src/crypto";
import { SyncActionType } from "../src/sync/types";
import { planDigest } from "../src/sync/types";
import type {
  BaseFileEntry,
  LocalFileEntry,
  RemoteFileEntry,
  SyncPlan,
  SyncPlanItem,
  SyncScope,
} from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType, type DriveItem } from "../src/onedrive/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import { SyncEngine } from "../src/sync/sync-engine";
import { StateManager } from "../src/sync/state-manager";
import type { I18n } from "../src/i18n";
import { SyncProgressStore } from "../src/sync/sync-progress";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import { EasySyncNoticeCenter } from "../src/ui/notice-center";

// ---- Shared test helpers ----

const TEST_SYNC_SCOPE = {
  accountId: "",
  driveId: "drive-id",
  vaultFolderId: "vault-folder-id",
  filesRootId: "files-root-id",
};

function makeMockAdapter(overrides: Record<string, unknown> = {}) {
  return {
    read: vi.fn().mockResolvedValue(""),
    write: vi.fn().mockResolvedValue(undefined),
    readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    appendBinary: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    stat: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeMockOneDrive(overrides: Record<string, unknown> = {}) {
  return {
    downloadBaseline: vi.fn().mockResolvedValue(null),
    downloadFile: vi.fn().mockImplementation(
      (_v: string, _p: string, _u?: string, _d?: string, s = 0, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(0, s);
        const buf = new ArrayBuffer(0);
        onProgress?.(buf.byteLength, s || buf.byteLength);
        return Promise.resolve(buf);
      },
    ),
    downloadFileToPath: vi.fn().mockImplementation(
      async (_v: string, _remotePath: string, _localPath: string, _adapter: unknown, _u?: string, _d?: string, s = 0, _sha?: string, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(0, s);
        onProgress?.(s, s);
        return { size: s, hash: "aa".repeat(32) };
      },
    ),
    uploadFile: vi.fn().mockResolvedValue({ id: "mock-upload-id", eTag: "mock-etag" }),
    deleteItem: vi.fn().mockResolvedValue(undefined),
    initVaultScope: vi.fn().mockResolvedValue({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    }),
    restoreVaultScope: vi.fn().mockReturnValue(false),
    invalidateVaultScope: vi.fn(),
    isDeltaLinkForVault: vi.fn().mockReturnValue(true),
    resetDownloadStrategy: vi.fn(),
    setAbortSignal: vi.fn(),
    getFileMetadata: vi.fn().mockResolvedValue(null),
    getDelta: vi.fn().mockResolvedValue({ value: [], "@odata.deltaLink": "tok" }),
    fullScan: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as OneDriveClient;
}

function remoteStateStub() {
  return {
    hasRemoteState: false,
    remoteSnapshot: [] as RemoteFileEntry[],
    remoteFolders: [],
    remoteDeltaLink: null,
    remoteGeneration: 0,
    incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
    setRemoteState: vi.fn().mockResolvedValue(undefined),
    clearRemoteState: vi.fn().mockResolvedValue(undefined),
    applyRemoteMutations: vi.fn().mockResolvedValue(undefined),
    prunePendingIssues: vi.fn().mockResolvedValue(undefined),
    reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
    pendingIssues: [],
    cacheBaseContent: vi.fn(),
    getBaseContent: vi.fn().mockReturnValue(undefined),
    mutationLedger: [],
    hasMutationLedgerCorruption: false,
    beginMutationIntent: vi.fn().mockResolvedValue(undefined),
    recordMutationReceipt: vi.fn().mockResolvedValue(undefined),
    abandonMutationIntent: vi.fn().mockResolvedValue(undefined),
    commitMutationCheckpoint: vi.fn().mockResolvedValue(undefined),
  };
}

function graphFolder(id: string, name: string, parentId: string): DriveItem {
  return {
    id,
    name,
    folder: { childCount: 1 },
    parentReference: { id: parentId },
  };
}

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
      size: 6,
      mtime: 3,
      eTag: "etag-remote",
      cTag: "ctag-remote",
    };
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      baseEtag: "etag-base",
      reason: "reason.bothSidesModified",
    };
    const adapter = makeMockAdapter({
      readBinary: vi.fn().mockResolvedValue(new TextEncoder().encode("local").buffer),
    });
    const downloadFile = vi.fn().mockResolvedValue(new TextEncoder().encode("remote").buffer);
    const uploadFile = vi.fn().mockResolvedValue({ id: "merged-id", eTag: "etag-merged" });
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = {
      ...remoteStateStub(),
      baseSnapshot: [],
      getBaseContent: vi.fn().mockReturnValue("base"),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [conflict], lastTotalFiles: 1, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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
    expect(downloadFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(upsertPendingConflicts).toHaveBeenCalledWith([
      expect.objectContaining({
        ...conflict,
        decisionToken: expect.objectContaining({ version: 1 }),
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
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const state = {
      ...remoteStateStub(),
      boundAccountId: "",
      remoteScope: null,
      planReviewRevision: 0,
      baseSnapshot: [{ path, hash: baseHash, size: baseBytes.byteLength, eTag: "etag-base" }],
      getBaseEntry: vi.fn().mockReturnValue({
        path,
        hash: baseHash,
        size: baseBytes.byteLength,
        eTag: "etag-base",
      }),
      getBaseContent: vi.fn().mockReturnValue(baseText),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile,
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{
            type: SyncActionType.Conflict,
            path,
            local,
            remote,
            baseEtag: "etag-base",
            reason: "reason.bothSidesModified",
          }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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
      local.size,
    );
    expect(remoteText).toBe("a\nlocal-b\nremote-c\nd");
    expect(new TextDecoder().decode(files.get(path))).toBe(remoteText);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
    expect(state.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseUpserts: [expect.objectContaining({ path, hash: await sha256Hex(files.get(path)!) })],
        remoteUpserts: [expect.objectContaining({ path, driveId: "remote-note", eTag: "etag-merged" })],
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
      size: local.size,
      mtime: 3,
      eTag: "etag-remote",
      cTag: "ctag-remote",
      sha256Hash: hash,
    };
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path: local.path,
      local,
      remote,
      reason,
    };
    const upsertBaseEntries = vi.fn().mockResolvedValue(undefined);
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [conflict], lastTotalFiles: 1, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: reason === "reason.bothSidesModified"
          ? [{ path: local.path, hash: "cd".repeat(32), size: local.size, eTag: "etag-base" }]
          : [],
        upsertBaseEntries,
        upsertPendingConflicts,
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        lastSyncTime: 0,
      } as unknown as StateManager,
      "testVault",
    );
    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(upsertBaseEntries).toHaveBeenCalledWith([
      expect.objectContaining({ path: local.path, hash }),
    ]);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
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
  async function runWithPlan(
    planItems: SyncPlanItem[],
    failedPaths: string[],
    complete = failedPaths.length === 0,
    options: {
      autoDeleteLocalFiles?: boolean;
      inspectFile?: ReturnType<typeof vi.fn>;
      getFileMetadata?: ReturnType<typeof vi.fn>;
      adapterOverrides?: Record<string, unknown>;
      recordMutationReceipt?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const mockDeleteItem = vi.fn().mockResolvedValue(undefined);
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
    const mockGeneratePlan = vi.fn().mockReturnValue({
      items: planItems,
      lastTotalFiles: 10,
      confirmed: false,
    });

    const mockOneDrive = makeMockOneDrive({
      deleteItem: mockDeleteItem,
      downloadFile: mockDownloadFile,
      initVaultScope: mockInitVaultScope,
      getFileMetadata: options.getFileMetadata ?? vi.fn().mockResolvedValue(null),
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
        entries: [] as LocalFileEntry[],
        skippedLarge: [],
        failedPaths,
        skippedCount: 0,
        complete,
      }),
      scanFile: vi.fn().mockResolvedValue(null),
      ...(options.inspectFile ? { inspectFile: options.inspectFile } : {}),
    } as unknown as LocalScanner;

    const mockEngine = {
      generatePlan: mockGeneratePlan,
      shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
    } as unknown as SyncEngine;

    const mutationState = remoteStateStub();
    if (options.recordMutationReceipt) {
      mutationState.recordMutationReceipt = options.recordMutationReceipt;
    }
    const mockState = {
      ...mutationState,
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: mockPrunePendingConflicts,
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: mockUpsertPendingDeletes,
      prunePendingDeletes: mockPrunePendingDeletes,
      setLastSyncTime: mockSetLastSyncTime,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
    } as unknown as StateManager;

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockEngine,
      mockState,
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
      mockGeneratePlan,
      mockAdapter,
      mutationState,
    };
  }

  function del(path: string): SyncPlanItem {
    return {
      type: SyncActionType.DeleteRemote,
      path,
      remote: {
        path, driveId: `id-${path}`, size: 10, mtime: 1, eTag: "etag", cTag: "ctag",
      } as RemoteFileEntry,
    };
  }

  function confirmDel(path: string): SyncPlanItem {
    return {
      type: SyncActionType.ConfirmLocalDelete,
      path,
      local: { path, size: 10, mtime: 1, hash: "aa".repeat(32), binary: false },
    };
  }

  it("blocks DeleteRemote — deleteItem is never called when scan unhealthy", async () => {
    const { mockDeleteItem } = await runWithPlan(
      [del("a.md"), del("b.md")],
      ["failed.txt"],
    );
    expect(mockDeleteItem).not.toHaveBeenCalled();
  });

  it("blocks ConfirmLocalDelete — pending delete batch stays empty when scan unhealthy", async () => {
    const { mockUpsertPendingDeletes } = await runWithPlan(
      [confirmDel("c.md")],
      ["failed.txt"],
    );
    expect(mockUpsertPendingDeletes).not.toHaveBeenCalled();
  });

  it("reports scan failures without generating or executing a plan", async () => {
    const { result, mockGeneratePlan, mockInitVaultDirectories } = await runWithPlan(
      [del("x.md"), del("y.md")],
      ["failed.txt"],
    );
    expect(result.errors).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.message).toBe("result.scanIncomplete");
    expect(mockGeneratePlan).not.toHaveBeenCalled();
    expect(mockInitVaultDirectories).not.toHaveBeenCalled();
  });

  it("allows DeleteRemote when scan is healthy (no failed paths)", async () => {
    const { mockDeleteItem } = await runWithPlan(
      [del("safe.md")],
      [],
    );
    expect(mockDeleteItem).toHaveBeenCalled();
  });

  it("allows ConfirmLocalDelete when scan is healthy", async () => {
    const item = confirmDel("safe.md");
    const { mockUpsertPendingDeletes } = await runWithPlan(
      [item],
      [],
    );
    expect(mockUpsertPendingDeletes).toHaveBeenCalledWith([
      expect.objectContaining({
        ...item,
        decisionToken: expect.objectContaining({ version: 1 }),
      }),
    ]);
  });

  it("counts a merge candidate kept manual when no trusted ancestor is available", async () => {
    const path = "manual-merge.md";
    const { result, mockDownloadFile } = await runWithPlan([{
      type: SyncActionType.Conflict,
      path,
      local: {
        path,
        size: 5,
        mtime: 1,
        hash: "aa".repeat(32),
        binary: false,
      },
      remote: {
        path,
        driveId: "remote-manual-merge",
        size: 6,
        mtime: 2,
        eTag: "etag-manual-merge",
        cTag: "ctag-manual-merge",
      },
      reason: "reason.bothSidesModified",
    }], []);

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
    const item = confirmDel("auto-delete.md");
    const remove = vi.fn().mockResolvedValue(undefined);
    const inspectFile = vi.fn().mockResolvedValue({ status: "present", entry: item.local });
    const {
      result,
      mockAdapter,
      mutationState,
      mockUpsertPendingDeletes,
      mockPrunePendingDeletes,
    } = await runWithPlan([item], [], true, {
      autoDeleteLocalFiles: true,
      inspectFile,
      adapterOverrides: { remove },
    });

    expect(result.deleted).toBe(1);
    expect(result.metrics?.automaticHandling.deleteLocal).toEqual({
      candidates: 1,
      completed: 1,
      failed: 0,
    });
    expect(mockAdapter.remove).toHaveBeenCalledWith(item.path);
    expect(mockPrunePendingDeletes).toHaveBeenCalledWith([item.path]);
    expect(mockUpsertPendingDeletes).not.toHaveBeenCalled();
    expect(mutationState.beginMutationIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: "deleteLocal",
      path: item.path,
      expectedLocal: { exists: true, hash: item.local!.hash, size: item.local!.size },
      expectedRemote: { exists: false },
    }));
    expect(mutationState.recordMutationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: expect.objectContaining({
        baseRemovals: [item.path],
        pendingDeleteRemovals: [item.path],
      }),
    }));
    expect(mutationState.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the local version changed before an automatic delete", async () => {
    const item = confirmDel("changed.md");
    const remove = vi.fn().mockResolvedValue(undefined);
    const { result, mutationState } = await runWithPlan([item], [], true, {
      autoDeleteLocalFiles: true,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: { ...item.local, hash: "bb".repeat(32) },
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
  });

  it("fails closed when the remote file reappeared before an automatic delete", async () => {
    const item = confirmDel("restored-remotely.md");
    const remove = vi.fn().mockResolvedValue(undefined);
    const inspectFile = vi.fn();
    const { result, mutationState } = await runWithPlan([item], [], true, {
      autoDeleteLocalFiles: true,
      inspectFile,
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "remote-restored",
        size: item.local!.size,
        mtime: 2,
        eTag: "etag-restored",
      }),
      adapterOverrides: { remove },
    });

    expect(result.errors).toBe(1);
    expect(inspectFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
  });

  it("never automatically deletes an Obsidian-managed live config file", async () => {
    const item = confirmDel(".obsidian/app.json");
    const remove = vi.fn().mockResolvedValue(undefined);
    const inspectFile = vi.fn();
    const getFileMetadata = vi.fn();
    const { result, mutationState, mockUpsertPendingDeletes } = await runWithPlan([item], [], true, {
      autoDeleteLocalFiles: true,
      inspectFile,
      getFileMetadata,
      adapterOverrides: { remove },
    });

    expect(result.errors).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(mockUpsertPendingDeletes).toHaveBeenCalledWith([
      expect.objectContaining({ path: item.path }),
    ]);
    expect(getFileMetadata).not.toHaveBeenCalled();
    expect(inspectFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
  });

  it("does not publish a checkpoint when receipt persistence fails after deletion", async () => {
    const item = confirmDel("receipt-failure.md");
    const remove = vi.fn().mockResolvedValue(undefined);
    const recordMutationReceipt = vi.fn().mockRejectedValue(new Error("receipt unavailable"));
    const { result, mutationState } = await runWithPlan([item], [], true, {
      autoDeleteLocalFiles: true,
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: item.local }),
      adapterOverrides: { remove },
      recordMutationReceipt,
    });

    expect(remove).toHaveBeenCalledWith(item.path);
    expect(result.errors).toBe(1);
    expect(mutationState.commitMutationCheckpoint).not.toHaveBeenCalled();
  });

  it("blocks downloads and state cleanup as well as destructive actions", async () => {
    const {
      result,
      mockDownloadFile,
      mockPrunePendingConflicts,
      mockPrunePendingDeletes,
      mockSetLastSyncTime,
    } = await runWithPlan(
      [
        { type: SyncActionType.Download, path: "b.md", remote: { path: "b.md", driveId: "id", size: 1, mtime: 1, eTag: "e", cTag: "c" } as RemoteFileEntry },
        { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
      ],
      ["failed.txt"],
    );
    expect(result.errors).toBe(1);
    expect(result.downloaded).toBe(0);
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockPrunePendingConflicts).not.toHaveBeenCalled();
    expect(mockPrunePendingDeletes).not.toHaveBeenCalled();
    expect(mockSetLastSyncTime).not.toHaveBeenCalled();
  });

  it("stops when the scanner reports incomplete without path detail", async () => {
    const { result, mockGeneratePlan, mockInitVaultDirectories } = await runWithPlan(
      [del("unknown.md")],
      [],
      false,
    );

    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.scanIncomplete");
    expect(mockGeneratePlan).not.toHaveBeenCalled();
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
    const state = {
      ...remoteStateStub(),
      boundAccountId: "account-test",
      baseSnapshot: [],
      lastSyncTime: 0,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      setRemoteState: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
    } as unknown as StateManager;
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Upload, path: local.path, local }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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
    expect(initVaultScope).toHaveBeenCalledWith("testVault", { createMissing: false });
    expect(onFirstSyncPreview).toHaveBeenCalledOnce();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(state.setLastSyncTime).not.toHaveBeenCalled();
  });
});

describe("M17 circuit breaker retry semantics", () => {
  function makeBreakerExecutor(mode: "manual" | "auto") {
    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      pendingIssues: [{
        path: "stuck.m4a",
        actionType: SyncActionType.Download,
        reason: "syncView.failure.contentUnavailable",
        updatedAt: 1,
        fileSize: 3,
        remoteETag: "etag-stuck",
        consecutiveFailures: 3,
      }],
      lastSyncTime: 0,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "item-stuck",
          size: 3,
          mtime: 1,
          eTag: "etag-stuck",
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{
            type: SyncActionType.Download,
            path: "stuck.m4a",
            remote: {
              path: "stuck.m4a",
              driveId: "item-stuck",
              size: 3,
              mtime: 1,
              eTag: "etag-stuck",
              cTag: "ctag-stuck",
            },
          }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    return { executor, downloadFile, mode };
  }

  it("manual sync bypasses the stale breaker and retries the file", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor("manual");

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("auto sync still keeps the breaker guardrail", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor("auto");

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(0);
    expect(result.errors).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
  });
});

// ---- Pre-implementation safety evidence: download compare-and-swap ----
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

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter({ writeBinary: mockWriteBinary }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [],
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: mockScanFile,
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: await mockScanFile(),
      }),
    } as unknown as LocalScanner;

    const mockEngine = {
      generatePlan: vi.fn().mockReturnValue({
        items: [
          {
            type: SyncActionType.Download,
            path: "test.md",
            remote: {
              path: "test.md",
              driveId: "item123",
              downloadUrl: "https://example.com/dl",
              size: 16,
              mtime: Date.now(),
              eTag: "etag1",
              cTag: "ctag1",
            } as RemoteFileEntry,
          },
        ],
        lastTotalFiles: 1,
        confirmed: false,
      }),
      shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
    } as unknown as SyncEngine;

    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockEngine,
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

  it("does not trust an inconsistent remote-only plan when the current path exists", async () => {
    const mockDownloadFile = vi.fn().mockResolvedValue(new ArrayBuffer(32));
    const mockWriteBinary = vi.fn().mockResolvedValue(undefined);

    const mockOneDrive = makeMockOneDrive({
      downloadFile: mockDownloadFile,
      uploadFile: vi.fn(),
      deleteItem: vi.fn(),
    });

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter({ writeBinary: mockWriteBinary }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [
          { path: "existing.md", size: 100, mtime: 1, hash: "oldhash", binary: false },
        ],
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
    } as unknown as LocalScanner;

    const mockEngine = {
      generatePlan: vi.fn().mockReturnValue({
        items: [
          {
            type: SyncActionType.Download,
            path: "existing.md",
            remote: {
              path: "existing.md",
              driveId: "item456",
              downloadUrl: "https://example.com/dl2",
              size: 32,
              mtime: Date.now() + 10000,
              eTag: "etag2",
              cTag: "ctag2",
            } as RemoteFileEntry,
          },
        ],
        lastTotalFiles: 1,
        confirmed: false,
      }),
      shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
    } as unknown as SyncEngine;

    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
    } as unknown as StateManager;

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockEngine,
      mockState,
      "testVault",
    );

    await executor.run("manual", {});

    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockWriteBinary).not.toHaveBeenCalled();
    expect(mockState.addPendingConflict).toHaveBeenCalledTimes(1);
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
    const state = {
      ...remoteStateStub(),
      baseSnapshot: [],
      addPendingConflict: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true,
        }),
        inspectFile,
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{
            type: SyncActionType.Download,
            path,
            remote: {
              path, driveId: "remote-id", size: downloaded.byteLength, mtime: 1,
              eTag: "etag", cTag: "ctag", sha256Hash: await sha256Hex(downloaded),
            } as RemoteFileEntry,
          }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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

describe("Cloud baseline bootstrap safety", () => {
  it("treats V1 cloud baseline as a hint unless local hash and remote SHA both match", () => {
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {} as LocalScanner,
      new SyncEngine(),
      {} as StateManager,
      "testVault",
    );
    const seed = (executor as unknown as {
      seedBaseEntriesFromCloudBaseline(
        json: string,
        local: LocalFileEntry[],
        remote: RemoteFileEntry[],
      ): BaseFileEntry[];
    }).seedBaseEntriesFromCloudBaseline.bind(executor);
    const json = JSON.stringify({
      vaultName: "testVault",
      lastSyncAt: 1,
      files: { "note.md": { hash: "aa".repeat(32), size: 4, eTag: "old", mtime: 0 } },
    });
    const local: LocalFileEntry[] = [{
      path: "note.md", hash: "aa".repeat(32), size: 4, mtime: 1, binary: false,
    }];
    const remote: RemoteFileEntry = {
      path: "note.md", driveId: "id", size: 4, mtime: 1, eTag: "current", cTag: "c",
    };

    expect(seed(json, local, [remote])).toEqual([]);
    expect(seed(json, local, [{ ...remote, sha256Hash: "bb".repeat(32) }])).toEqual([]);
    expect(seed(json, local, [{ ...remote, sha256Hash: "aa".repeat(32) }])).toEqual([{
      path: "note.md", hash: "aa".repeat(32), size: 4, eTag: "current",
    }]);
  });

  it("fresh device with remote-only file downloads it instead of deleting remote", async () => {
    const deleteItem = vi.fn();
    const downloaded = new ArrayBuffer(12);
    const downloadedHash = await sha256Hex(downloaded);
    const downloadFile = vi.fn().mockResolvedValue(downloaded);
    const writeBinary = vi.fn().mockResolvedValue(undefined);

    const mockOneDrive = makeMockOneDrive({
      downloadBaseline: vi.fn().mockResolvedValue(JSON.stringify({
        vaultName: "testVault",
        lastSyncAt: 123,
        files: {
          "note.md": {
            hash: "aa".repeat(32),
            size: 12,
            eTag: "etag-remote",
            mtime: 0,
          },
        },
      })),
      downloadFile,
      deleteItem,
      uploadFile: vi.fn(),
      initVaultScope: vi.fn().mockResolvedValue({
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      }),
      getDelta: vi.fn().mockResolvedValue({
        value: [
          {
            id: "item-note",
            name: "note.md",
            size: 12,
            eTag: "etag-remote",
            cTag: "ctag-remote",
            lastModifiedDateTime: "2026-07-08T00:00:00.000Z",
            parentReference: {
              id: "files-root-id",
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: downloadedHash } },
          },
        ],
        "@odata.deltaLink": "tok",
      }),
    });

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter({ writeBinary }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [] as LocalFileEntry[],
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
      }),
      scanFile: vi.fn().mockResolvedValue({
        path: "note.md",
        hash: "bb".repeat(32),
        size: 12,
        mtime: 1,
        binary: false,
      }),
    } as unknown as LocalScanner;

    const baseEntries: BaseFileEntry[] = [];
    let lastSyncTime = 0;
    const mockState = {
      ...remoteStateStub(),
      get baseSnapshot() {
        return baseEntries;
      },
      async updateBaseEntry(entry: BaseFileEntry) {
        const index = baseEntries.findIndex((e) => e.path === entry.path);
        if (index >= 0) {
          baseEntries[index] = entry;
        } else {
          baseEntries.push(entry);
        }
      },
      async upsertBaseEntries(entries: BaseFileEntry[]) {
        for (const entry of entries) {
          const index = baseEntries.findIndex((e) => e.path === entry.path);
          if (index >= 0) {
            baseEntries[index] = entry;
          } else {
            baseEntries.push(entry);
          }
        }
      },
      async setBaseSnapshot(entries: BaseFileEntry[]) {
        baseEntries.splice(0, baseEntries.length, ...entries);
      },
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      async setLastSyncTime(time: number) {
        lastSyncTime = time;
      },
      get lastSyncTime() {
        return lastSyncTime;
      },
      pendingConflicts: [],
      pendingRemoteDeletes: [],
    } as unknown as StateManager;

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(1);
    expect(deleteItem).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      "note.md",
      undefined,
      "item-note",
      12,
      undefined,
    );
    expect(writeBinary).toHaveBeenCalledWith("note.md", expect.any(ArrayBuffer));
  });

  it("streams large mobile downloads through a temp file before rename", async () => {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const hash = "aa".repeat(32);
    const size = 9 * 1024 * 1024;
    const downloadFile = vi.fn();
    const downloadFileToPath = vi.fn().mockResolvedValue({ size, hash });
    const rename = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAdapter({
      appendBinary: vi.fn().mockResolvedValue(undefined),
      rename,
      stat: vi.fn(async (path: string) => path === "recording.m4a" ? { size, mtime: 1 } : null),
    });
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        downloadFileToPath,
        getDelta: vi.fn().mockResolvedValue({
          value: [{
            id: "item-recording",
            name: "recording.m4a",
            size,
          eTag: "etag-recording",
          cTag: "ctag-recording",
          parentReference: {
            id: "files-root-id",
            path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: hash } },
          }],
          "@odata.deltaLink": "tok",
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );

    try {
      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(1);
      expect(downloadFileToPath).toHaveBeenCalledWith(
        "testVault",
        "recording.m4a",
        ".obsidian/plugins/easy-sync/tmp/downloads/recording.m4a.part",
        expect.any(Object),
        undefined,
        "item-recording",
        size,
        hash,
        undefined,
      );
      expect(downloadFile).not.toHaveBeenCalled();
      expect(rename).toHaveBeenCalledWith(
        ".obsidian/plugins/easy-sync/tmp/downloads/recording.m4a.part",
        "recording.m4a",
      );
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
    }
  });
});

describe("File download failure isolation", () => {
  it("continues later downloads when one content endpoint rejects the file", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const contentHash = await sha256Hex(content);
    const downloadFile = vi.fn()
      .mockRejectedValueOnce(new OneDriveError(
        OneDriveErrorType.Unauthorized,
        "content endpoint rejected file",
        401,
      ))
      .mockResolvedValueOnce(content);
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const mockState = {
      ...remoteStateStub(),
      reconcilePendingIssues,
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    const remoteItems = ["first.md", "second.md"].map((name, index) => ({
      id: `item-${index}`,
      name,
      size: 3,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        id: "files-root-id",
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: { hashes: { sha256Hash: contentHash } },
    }));

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({ value: remoteItems, "@odata.deltaLink": "tok" }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) => ({
          path,
          size: 3,
          mtime: 1,
          hash: "aa".repeat(32),
          binary: false,
        })),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
      {
        t: (key: string, params?: Record<string, string | number>) =>
          key === "result.partial" ? `partial:${params?.errors}` : key,
      } as I18n,
    );

    const result = await executor.run("manual", {});

    expect(result.authExpired).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.message).toBe("partial:1");
    expect(result.downloaded).toBe(1);
    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(writeBinary).toHaveBeenCalledWith("second.md", content);
    expect(setLastSyncTime).not.toHaveBeenCalled();
    expect(reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: "first.md",
        actionType: SyncActionType.Download,
        reason: "syncView.failure.contentUnavailable",
      })],
      new Set(["second.md"]),
    );
  });
});

describe("Download integrity gate", () => {
  async function runIntegrityCase(options: {
    remote: RemoteFileEntry;
    content: ArrayBuffer;
    getFileMetadata?: ReturnType<typeof vi.fn>;
    downloadFile?: OneDriveClient["downloadFile"];
  }) {
    const writeBinary = vi.fn().mockResolvedValue(undefined);
    const state = {
      ...remoteStateStub(),
      baseSnapshot: [],
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: options.downloadFile ?? vi.fn().mockResolvedValue(options.content),
        getFileMetadata: options.getFileMetadata,
      }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary, stat: vi.fn().mockResolvedValue({ size: options.content.byteLength, mtime: 2 }) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Download, path: options.remote.path, remote: options.remote }],
          lastTotalFiles: 0,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );
    const result = await executor.run("manual", {});
    return { result, state, writeBinary };
  }

  async function runStreamIntegrityCase(options: {
    remote: RemoteFileEntry;
    downloaded: { size: number; hash: string };
    tempContent: ArrayBuffer;
  }) {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    Platform.isMobile = true;
    Platform.isDesktop = false;
    const remove = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const adapter = makeMockAdapter({
      remove,
      rename,
      stat: vi.fn(async (path: string) => path.endsWith(".part")
        ? { size: options.tempContent.byteLength, mtime: 2 }
        : null),
      readBinary: vi.fn().mockResolvedValue(options.tempContent),
    });
    const state = {
      ...remoteStateStub(),
      baseSnapshot: [],
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
    const downloadFileToPath = vi.fn().mockResolvedValue(options.downloaded);
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFileToPath }),
      {
        vault: {
          adapter,
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Download, path: options.remote.path, remote: options.remote }],
          lastTotalFiles: 0,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    try {
      const result = await executor.run("manual", {});
      return { result, state, remove, rename, downloadFileToPath };
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
    }
  }

  it("rejects a truncated in-memory response before replacing the local file", async () => {
    const result = await runIntegrityCase({
      remote: {
        path: "note.bin",
        driveId: "note-id",
        size: 4,
        mtime: 1,
        eTag: "etag-note",
        cTag: "ctag-note",
      },
      content: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(result.result.errors).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
    expect(result.state.recordMutationReceipt).not.toHaveBeenCalled();
  });

  it("rejects a 200 requestUrl fallback error body before replacing the local file", async () => {
    const errorBody = new TextEncoder().encode('{"error":"quota exceeded"}').buffer;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: errorBody,
    });
    const client = new OneDriveClient(async () => "token");

    try {
      const result = await runIntegrityCase({
        remote: {
          path: "note.bin",
          driveId: "note-id",
          downloadUrl: "https://download.example/note.bin",
          size: 1_024,
          mtime: 1,
          eTag: "etag-note",
          cTag: "ctag-note",
        },
        content: errorBody,
        downloadFile: client.downloadFile.bind(client),
      });

      expect(requestSpy).toHaveBeenCalled();
      expect(result.result.errors).toBe(1);
      expect(result.writeBinary).not.toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
    }
  });

  it("rejects same-size bytes whose SHA-256 differs from Graph metadata", async () => {
    const result = await runIntegrityCase({
      remote: {
        path: "note.bin",
        driveId: "note-id",
        size: 3,
        mtime: 1,
        eTag: "etag-note",
        cTag: "ctag-note",
        sha256Hash: "aa".repeat(32),
      },
      content: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(result.result.errors).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
  });

  it("rechecks remote ID/eTag after a hashless download before writing", async () => {
    const getFileMetadata = vi.fn().mockResolvedValue({
      path: "note.bin",
      driveId: "note-id",
      size: 3,
      mtime: 2,
      eTag: "etag-changed",
    });
    const result = await runIntegrityCase({
      remote: {
        path: "note.bin",
        driveId: "note-id",
        size: 3,
        mtime: 1,
        eTag: "etag-note",
        cTag: "ctag-note",
      },
      content: new Uint8Array([1, 2, 3]).buffer,
      getFileMetadata,
    });

    expect(getFileMetadata).toHaveBeenCalledWith(
      "testVault",
      "note.bin",
      "downloadVersionVerify",
    );
    expect(result.result.errors).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
  });

  it("rejects a truncated streamed response and removes its temp file", async () => {
    const size = 9 * 1024 * 1024;
    const result = await runStreamIntegrityCase({
      remote: {
        path: "large.bin",
        driveId: "large-id",
        size,
        mtime: 1,
        eTag: "etag-large",
        cTag: "ctag-large",
        sha256Hash: "aa".repeat(32),
      },
      downloaded: { size: size - 1, hash: "aa".repeat(32) },
      tempContent: new ArrayBuffer(0),
    });

    expect(result.result.errors).toBe(1);
    expect(result.rename).not.toHaveBeenCalled();
    expect(result.remove).toHaveBeenCalledWith(
      ".obsidian/plugins/easy-sync/tmp/downloads/large.bin.part",
    );
    expect(result.state.recordMutationReceipt).not.toHaveBeenCalled();
  });

  it("rejects a same-size streamed temp file corrupted after download", async () => {
    const expectedBytes = new Uint8Array(9 * 1024 * 1024);
    const expectedHash = await sha256Hex(expectedBytes.buffer);
    const corruptedBytes = expectedBytes.slice();
    corruptedBytes[corruptedBytes.length - 1] = 1;
    const result = await runStreamIntegrityCase({
      remote: {
        path: "large.bin",
        driveId: "large-id",
        size: expectedBytes.byteLength,
        mtime: 1,
        eTag: "etag-large",
        cTag: "ctag-large",
        sha256Hash: expectedHash,
      },
      downloaded: { size: expectedBytes.byteLength, hash: expectedHash },
      tempContent: corruptedBytes.buffer,
    });

    expect(result.result.errors).toBe(1);
    expect(result.rename).not.toHaveBeenCalled();
    expect(result.remove).toHaveBeenCalledWith(
      ".obsidian/plugins/easy-sync/tmp/downloads/large.bin.part",
    );
  });
});

describe("Cloud baseline read-only compatibility", () => {
  function makeBaselineExecutor() {
    const uploadBaseline = vi.fn().mockResolvedValue(undefined);
    const markCloudBaselineSynced = vi.fn().mockResolvedValue(undefined);
    const baseEntry: BaseFileEntry = {
      path: "note.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-note",
    };
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [baseEntry],
      // Deliberately expose the removed legacy contract: a future accidental
      // reintroduction of the writer would make this production entry fail.
      needsCloudBaselineUpload: true,
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      markCloudBaselineSynced,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 1,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadBaseline,
        getDelta: vi.fn().mockResolvedValue({
          value: [{
            id: "item-note",
            name: "note.md",
            size: 10,
            eTag: "etag-note",
            cTag: "ctag-note",
            parentReference: {
              id: "files-root-id",
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: { hashes: { sha256Hash: baseEntry.hash } },
          }],
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
          entries: [{
            path: "note.md",
            size: 10,
            mtime: 1,
            hash: baseEntry.hash,
            binary: false,
          }],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );
    return { executor, uploadBaseline, markCloudBaselineSynced };
  }

  it("never uploads the legacy baseline from a healthy production sync", async () => {
    const { executor, uploadBaseline, markCloudBaselineSynced } = makeBaselineExecutor();

    await executor.run("manual", {});

    expect(uploadBaseline).not.toHaveBeenCalled();
    expect(markCloudBaselineSynced).not.toHaveBeenCalled();
  });
});

describe("Persistent remote delta state", () => {
  async function makeMemoryState(initialData: Record<string, unknown> = {}) {
    let persisted: Record<string, unknown> = structuredClone(initialData);
    let remoteStateJson: string | null = null;
    let saveQueue: Promise<void> = Promise.resolve();
    const plugin = {
      loadData: vi.fn(async () => persisted),
      saveData: vi.fn(async (next: Record<string, unknown>) => {
        persisted = structuredClone(next);
      }),
      updatePluginData: vi.fn(async (mutator: (data: Record<string, unknown>) => void) => {
        const task = saveQueue.then(async () => {
          const d = (await plugin.loadData()) ?? {};
          mutator(d);
          await plugin.saveData(d);
        });
        saveQueue = task.catch(() => undefined);
        return task;
      }),
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
      app: {
        vault: {
          adapter: {
            read: vi.fn(async () => {
              if (remoteStateJson === null) throw new Error("missing");
              return remoteStateJson;
            }),
            write: vi.fn(async (_path: string, json: string) => {
              remoteStateJson = json;
            }),
          },
        },
      },
    };
    const state = new StateManager(plugin);
    await state.load();
    return state;
  }

  it("binds pending decision tokens through the indexed base lookup", async () => {
    const state = await makeMemoryState();
    await state.bindAccount("account-id");
    await state.setBaseSnapshot([{
      path: "conflict.md",
      hash: "bb".repeat(32),
      size: 10,
      eTag: "base-etag",
    }]);
    await state.setRemoteState([], null, { ...TEST_SYNC_SCOPE, accountId: "account-id" });
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
      } as unknown as LocalScanner,
      new SyncEngine(),
      state,
      "testVault",
    );
    const plan: SyncPlan = {
      items: [{
        type: SyncActionType.Conflict,
        path: "conflict.md",
        local: {
          path: "conflict.md",
          size: 10,
          mtime: 1,
          hash: "cc".repeat(32),
          binary: false,
        },
        remote: {
          path: "conflict.md",
          driveId: "remote-id",
          size: 10,
          mtime: 1,
          eTag: "remote-etag",
          cTag: "remote-ctag",
        },
      }],
      lastTotalFiles: 1,
      confirmed: false,
    };
    const baseSnapshotMaterialization = vi.spyOn(state, "baseSnapshot", "get")
      .mockImplementation(() => {
        throw new Error("decision-token binding must not materialize the whole base snapshot");
      });

    try {
      (executor as unknown as {
        bindPendingDecisionTokens(plan: SyncPlan): void;
      }).bindPendingDecisionTokens(plan);
    } finally {
      baseSnapshotMaterialization.mockRestore();
    }

    expect(plan.items[0].decisionToken?.ancestorHash).toBe("bb".repeat(32));
  });

  function driveItem(
    path: string,
    hash: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `item-${path}`,
      name: path.split("/").pop()!,
      size: 3,
      eTag: `etag-${path}`,
      cTag: `ctag-${path}`,
      parentReference: {
        id: "files-root-id",
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: { hashes: { sha256Hash: hash } },
      ...overrides,
    };
  }

  function emptyScanner(): LocalScanner {
    return {
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
      scanFile: vi.fn().mockResolvedValue(null),
    } as unknown as LocalScanner;
  }

  function emptyPlanEngine() {
    const generatePlan = vi.fn().mockReturnValue({
      items: [],
      lastTotalFiles: 0,
      confirmed: false,
    });
    return {
      generatePlan,
      engine: {
        generatePlan,
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
    };
  }

  it("blocks planning when an unresolved mutation intent contradicts current remote identity", async () => {
    const expectedHash = "aa".repeat(32);
    const currentHash = "bb".repeat(32);
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-unresolved",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
          action: "upload",
          path: "note.md",
          expectedLocal: { exists: true, hash: expectedHash, size: 3 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
    });
    const local: LocalFileEntry = {
      path: "note.md",
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const uploadFile = vi.fn().mockResolvedValue({ id: "new-id", eTag: "new-etag" });
    const generatePlan = vi.fn().mockReturnValue({
      items: [{ type: SyncActionType.Upload, path: local.path, local }],
      lastTotalFiles: 0,
      confirmed: false,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          path: "note.md",
          driveId: "unexpected-id",
          size: 3,
          mtime: 1,
          eTag: "unexpected-etag",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      } as unknown as LocalScanner,
      {
        generatePlan,
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(generatePlan).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("recovers an applied unreceipted upload without uploading the file again", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
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
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-upload-response-lost",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
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
    const { engine, generatePlan } = emptyPlanEngine();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta: vi.fn().mockResolvedValue({
          value: [driveItem(local.path, hash, {
            id: remote.driveId,
            eTag: remote.eTag,
            cTag: remote.cTag,
          })],
          "@odata.deltaLink": "https://graph.example/delta-upload-recovered",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      } as unknown as LocalScanner,
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
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
    const local: LocalFileEntry = {
      path: "not-applied.md",
      hash,
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-upload-never-applied",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
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
    const { engine, generatePlan } = emptyPlanEngine();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(undefined),
        getDelta: vi.fn().mockResolvedValue({
          value: [],
          "@odata.deltaLink": "https://graph.example/delta-not-applied",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      } as unknown as LocalScanner,
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);
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
    const state = await makeMemoryState();
    const uploadFile = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(currentContent) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: currentLocal }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Upload, path: local.path, local }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    expect(result.message).toBe("result.deferred");
    expect(state.mutationLedger).toEqual([]);
    expect(state.lastSyncTime).toBe(0);
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
    const state = await makeMemoryState();
    const downloadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
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
          entries: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "missing" }),
        getMaxFileSize: vi.fn().mockReturnValue(100 * 1024 * 1024),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Download, path: remote.path, remote }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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
    expect(state.mutationLedger).toEqual([]);
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
    const state = await makeMemoryState();
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "response lost"),
    );
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Upload, path: local.path, local }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(uploadFile).toHaveBeenCalledOnce();
    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(1);
    expect(result.success).toBe(true);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
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
    const state = await makeMemoryState();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile: vi.fn().mockRejectedValue(
          new OneDriveError(OneDriveErrorType.NetworkError, "response lost"),
        ),
        getFileMetadata: vi.fn().mockResolvedValue(unrelatedRemote),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Upload, path: local.path, local }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.message).toBe("result.syncFailed");
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].intent.path).toBe(local.path);
    expect(state.mutationLedger[0].receipt).toBeNull();
    expect(state.baseSnapshot).toEqual([]);
  });

  it("recovers an applied unreceipted download without downloading the file again", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const hash = await sha256Hex(content);
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
      size: local.size,
      mtime: 3,
      eTag: "etag-download",
      cTag: "ctag-download",
      sha256Hash: hash,
    };
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-download-receipt-lost",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
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
    const { engine, generatePlan } = emptyPlanEngine();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta: vi.fn().mockResolvedValue({
          value: [driveItem(local.path, hash, {
            id: remote.driveId,
            eTag: remote.eTag,
            cTag: remote.cTag,
          })],
          "@odata.deltaLink": "https://graph.example/delta-download-recovered",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(content) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      } as unknown as LocalScanner,
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toContainEqual({
      path: local.path,
      hash,
      size: local.size,
      eTag: remote.eTag,
    });
  });

  it("finishes a verified receipt checkpoint before generating a new plan", async () => {
    const hash = "aa".repeat(32);
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
    const state = await makeMemoryState({
      "easy-sync-mutation-ledger": [{
        intent: {
          version: 1,
          operationId: "op-receipted",
          planRevision: 1,
          scope: TEST_SYNC_SCOPE,
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
    const { engine, generatePlan } = emptyPlanEngine();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getFileMetadata: vi.fn().mockResolvedValue(remote),
        getDelta: vi.fn().mockResolvedValue({
          value: [driveItem("note.md", hash, { id: "item-note", eTag: "etag-note" })],
          "@odata.deltaLink": "https://graph.example/delta-next",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
        inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
      } as unknown as LocalScanner,
      engine,
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(state.baseSnapshot).toEqual([base]);
  });

  it("recovers a cancelled post-upload receipt without uploading the file twice", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const hash = await sha256Hex(content);
    const local: LocalFileEntry = { path: "note.md", hash, size: 3, mtime: 1, binary: false };
    const state = await makeMemoryState();
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
      scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
      inspectFile: vi.fn().mockResolvedValue({ status: "present", entry: local }),
    } as unknown as LocalScanner;
    const firstEngine = {
      generatePlan: vi.fn().mockReturnValue({
        items: [{ type: SyncActionType.Upload, path: local.path, local }],
        lastTotalFiles: 0,
        confirmed: false,
      }),
      shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
    } as unknown as SyncEngine;
    firstExecutor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      scanner,
      firstEngine,
      state,
      "testVault",
    );

    const cancelled = await firstExecutor.run("manual", {});

    expect(cancelled.message).toBe("result.cancelled");
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).not.toBeNull();
    expect(state.baseSnapshot).toEqual([]);

    const recoveryClient = makeMockOneDrive({
      uploadFile,
      getFileMetadata: vi.fn().mockResolvedValue({
        path: "note.md",
        driveId: "uploaded-note",
        size: 3,
        mtime: 2,
        eTag: "etag-uploaded",
        sha256Hash: hash,
      }),
      getDelta: vi.fn().mockResolvedValue({ value: [], "@odata.deltaLink": "https://graph.example/delta-after" }),
    });
    const { engine } = emptyPlanEngine();
    const recoveryExecutor = new SyncExecutor(recoveryClient, scanner, engine, state, "testVault");

    await recoveryExecutor.run("manual", {});

    expect(uploadFile).toHaveBeenCalledTimes(1);
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
  });

  it("purges EasySync internal files from a cached remote snapshot", async () => {
    const internalPath = ".obsidian/plugins/easy-sync/data.sync-conflict-20260709.json";
    const state = await makeMemoryState();
    await state.setRemoteState([{
      path: internalPath,
      driveId: "internal-id",
      size: 10,
      mtime: 1,
      eTag: "internal-etag",
      cTag: "internal-ctag",
    }], "https://graph.example/delta-1", TEST_SYNC_SCOPE);
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
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(state.remoteSnapshot).toEqual([]);
  });

  it("applies the local sync scope to remote plugin files", async () => {
    const state = await makeMemoryState();
    const generatePlan = vi.fn().mockReturnValue({
      items: [],
      lastTotalFiles: 0,
      confirmed: false,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({
          value: [
            graphFolder("obsidian-folder", ".obsidian", "files-root-id"),
            graphFolder("plugins-folder", "plugins", "obsidian-folder"),
            graphFolder("example-plugin-folder", "example-plugin", "plugins-folder"),
            graphFolder("runtime-folder", "runtime", "example-plugin-folder"),
            driveItem("main.js", "aa".repeat(32), {
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
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        shouldSyncPath: vi.fn((path: string) => !path.includes("/runtime/")),
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan,
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(generatePlan.mock.calls[0][1].map((entry: RemoteFileEntry) => entry.path)).toEqual([
      ".obsidian/plugins/example-plugin/main.js",
    ]);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual([
      ".obsidian/plugins/example-plugin/main.js",
    ]);
  });

  it("rebuilds a remote cache when its delta link belongs to another vault directory", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState([{
      path: "stale.md",
      driveId: "stale-id",
      size: 1,
      mtime: 1,
      eTag: "stale-etag",
      cTag: "stale-ctag",
    }], "https://graph.example/canonical-delta");
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
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/legacy-delta");
  });

  it("builds a full cache, applies additions, and removes tombstones", async () => {
    const hashA = "aa".repeat(32);
    const downloaded = new Uint8Array([1, 2, 3]).buffer;
    const hashB = await sha256Hex(downloaded);
    const state = await makeMemoryState();
    let scanRound = 0;
    const getDelta = vi.fn(async (_vaultName: string, deltaLink?: string) => {
      if (!deltaLink) {
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
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        downloadFile: vi.fn().mockResolvedValue(downloaded),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
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
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
          };
        }),
        scanFile: vi.fn().mockImplementation(async (path: string) => ({
          path,
          size: 3,
          mtime: 1,
          hash: path === "a.md" ? hashA : hashB,
          binary: false,
        })),
      } as unknown as LocalScanner,
      new SyncEngine(),
      state,
      "testVault",
    );

    await executor.run("manual", {});
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-1");

    await executor.run("manual", {});
    expect(state.remoteSnapshot.map((entry) => entry.path).sort()).toEqual(["a.md", "b.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");

    const third = await executor.run("manual", {});
    expect(third.conflicts).toBe(1);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["a.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-3");
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      undefined,
      "https://graph.example/delta-1",
      "https://graph.example/delta-2",
    ]);
  });

  it("coalesces duplicate drive ids by the last delta occurrence", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState([{
      path: "old.md",
      driveId: "shared-id",
      parentId: "files-root-id",
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
    }], "https://graph.example/delta-1", TEST_SYNC_SCOPE);
    const { engine } = emptyPlanEngine();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({
          value: [
            driveItem("middle.md", "aa".repeat(32), { id: "shared-id" }),
            driveItem("latest.md", "bb".repeat(32), { id: "shared-id" }),
          ],
          "@odata.deltaLink": "https://graph.example/delta-2",
        }),
      }),
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(state.remoteSnapshot).toHaveLength(1);
    expect(state.remoteSnapshot[0]).toEqual(expect.objectContaining({
      path: "latest.md",
      driveId: "shared-id",
    }));
  });

  it("Preflight P0 — file delta without parent path does not invent a root path", async () => {
    const state = await makeMemoryState();
    const cachedEntry: RemoteFileEntry = {
      path: "nested/note.md",
      driveId: "note-id",
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
    };
    await state.setRemoteState([cachedEntry], "https://graph.example/delta-1", TEST_SYNC_SCOPE);
    const { engine, generatePlan } = emptyPlanEngine();
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
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(generatePlan).not.toHaveBeenCalled();
    expect(state.remoteSnapshot).toEqual([cachedEntry]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-1");
  });

  it("rebuilds a complete identity snapshot when a folder delta cannot update V1 paths", async () => {
    const state = await makeMemoryState();
    const cachedEntry: RemoteFileEntry = {
      path: "old-folder/child.md",
      driveId: "child-id",
      size: 3,
      mtime: 1,
      eTag: "etag-child",
      cTag: "ctag-child",
    };
    await state.setRemoteState([cachedEntry], "https://graph.example/delta-1", TEST_SYNC_SCOPE);
    const { engine, generatePlan } = emptyPlanEngine();
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
          file: { hashes: { sha256Hash: "cc".repeat(32) } },
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
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "new-folder/child.md",
        driveId: "child-id",
        eTag: "etag-child-new",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "https://graph.example/delta-1",
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
    const state = await makeMemoryState();
    const cachedEntry: RemoteFileEntry = {
      path: "Fragments/note.md",
      driveId: "note-id",
      parentId: "fragments-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
    };
    await state.setRemoteState(
      [cachedEntry],
      "https://graph.example/delta-1",
      TEST_SYNC_SCOPE,
    );
    const { engine, generatePlan } = emptyPlanEngine();
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
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith(
      "testVault",
      "https://graph.example/delta-1",
    );
    expect(state.remoteSnapshot).toEqual([cachedEntry]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("repairs a legacy root-file parent from the known files root without rebuilding", async () => {
    const state = await makeMemoryState();
    const cachedEntry: RemoteFileEntry = {
      path: "main.js",
      driveId: "main-id",
      size: 3,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
    };
    await state.setRemoteState(
      [cachedEntry],
      "https://graph.example/delta-1",
      TEST_SYNC_SCOPE,
    );
    const { engine } = emptyPlanEngine();
    const updatedItem = driveItem("main.js", "aa".repeat(32), {
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
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "https://graph.example/delta-1",
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
    const state = await makeMemoryState();
    await (state as any).setRemoteState(
      [{
        path: "note.md",
        driveId: "note-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: 3,
        mtime: 1,
        eTag: "etag-note",
        cTag: "ctag-note",
      }],
      "https://graph.example/delta-1",
      TEST_SYNC_SCOPE,
      [{
        path: "Empty",
        driveId: "empty-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Empty",
      }],
    );
    const { engine, generatePlan } = emptyPlanEngine();
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
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(generatePlan).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });

  it("projects a new file inside a persisted folder without a full rebuild", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState(
      [],
      "https://graph.example/delta-1",
      TEST_SYNC_SCOPE,
      [{
        path: "Empty",
        driveId: "empty-folder-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "Empty",
      }],
    );
    const { engine } = emptyPlanEngine();
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        {
          id: "empty-folder-id",
          name: "Empty",
          folder: { childCount: 1 },
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        },
        driveItem("new.md", "aa".repeat(32), {
          id: "new-file-id",
          parentReference: { id: "empty-folder-id" },
        }),
      ],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    await executor.run("manual", {});

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
    const state = await makeMemoryState();
    const cachedEntry: RemoteFileEntry = {
      path: "Fragments/note.md",
      driveId: "note-id",
      parentId: "fragments-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note-old",
      cTag: "ctag-note-old",
    };
    await state.setRemoteState(
      [cachedEntry],
      "https://graph.example/delta-1",
      TEST_SYNC_SCOPE,
    );
    const { engine } = emptyPlanEngine();
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "fragments-folder-id",
        name: "Fragments",
        folder: { childCount: 1 },
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        eTag: "etag-fragments-new",
      }, driveItem("note.md", "aa".repeat(32), {
        id: "note-id",
        parentReference: { id: "fragments-folder-id" },
        eTag: "etag-note-new",
      })],
      "@odata.deltaLink": "https://graph.example/delta-2",
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    await executor.run("manual", {});

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

  it("rebuilds when a previously known parent folder is renamed", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState([{
      path: "Fragments/note.md",
      driveId: "note-id",
      parentId: "fragments-folder-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
    }], "https://graph.example/delta-1", TEST_SYNC_SCOPE);
    const { engine } = emptyPlanEngine();
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: "fragments-folder-id",
          name: "Renamed",
          folder: { childCount: 1 },
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
          eTag: "etag-folder-new",
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [{
          id: "fragments-folder-id",
          name: "Renamed",
          folder: { childCount: 1 },
          parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
        }, driveItem("note.md", "aa".repeat(32), {
          id: "note-id",
          parentReference: { id: "fragments-folder-id" },
        })],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const executor = new SyncExecutor(
      makeMockOneDrive({ getDelta }),
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "https://graph.example/delta-1",
      undefined,
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "Renamed/note.md" }),
    ]);
  });

  it("rebuilds instead of ignoring deletion of the known files root", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState([{
      path: "note.md",
      driveId: "note-id",
      parentId: "files-root-id",
      size: 3,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
    }], "https://graph.example/delta-1", TEST_SYNC_SCOPE);
    const { engine } = emptyPlanEngine();
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
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "https://graph.example/delta-1",
      undefined,
    ]);
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

    const state = await makeMemoryState();
    await state.setRemoteState([{
      path: "old-folder/child.md",
      driveId: "child-id",
      size: 5,
      mtime: 1,
      eTag: "etag-child-old",
      cTag: "ctag-child-old",
    }], "https://graph.example/delta-1", TEST_SYNC_SCOPE);
    const { engine, generatePlan } = emptyPlanEngine();
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
      emptyScanner(),
      engine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(generatePlan).toHaveBeenCalledTimes(1);
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

  it("rebuilds and overwrites a legacy cache polluted by the files root prefix", async () => {
    const state = await makeMemoryState();
    const pollutedRemote: RemoteFileEntry = {
      path: "files/note.md",
      driveId: "note-id",
      size: 4,
      mtime: 1,
      eTag: "etag-old",
      cTag: "ctag-old",
    };
    await state.setRemoteState([pollutedRemote], "https://graph.example/delta-polluted");
    await state.updateBaseEntry({
      path: "note.md",
      hash: "aa".repeat(32),
      size: 4,
      eTag: "etag-old",
    });
    const local: LocalFileEntry = {
      path: "note.md",
      hash: "aa".repeat(32),
      size: 4,
      mtime: 1,
      binary: false,
    };
    const reviewedPlan: SyncPlanItem[] = [{
      type: SyncActionType.Download,
      path: pollutedRemote.path,
      remote: pollutedRemote,
    }];
    await state.setPlanReviewBundle(reviewedPlan, {
      uploads: 0,
      downloads: 1,
      deletes: 0,
      conflicts: 0,
      skipped: 0,
    }, TEST_SYNC_SCOPE);
    const reviewedAuthorization = state.planReviewAuthorization ?? undefined;
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "note-id",
        name: "note.md",
        size: 4,
        file: { hashes: { sha256Hash: "aa".repeat(32) } },
        parentReference: { id: "files-root-id" },
        eTag: "etag-current",
        cTag: "ctag-current",
      }],
      "@odata.deltaLink": "https://graph.example/delta-clean",
    });
    const uploadFile = vi.fn();
    const downloadFile = vi.fn();
    const downloadFileToPath = vi.fn();
    const deleteItem = vi.fn();
    const oneDrive = makeMockOneDrive({
      getDelta,
      uploadFile,
      downloadFile,
      downloadFileToPath,
      deleteItem,
    });
    const executor = new SyncExecutor(
      oneDrive,
      {
        ...emptyScanner(),
        scanAll: vi.fn().mockResolvedValue({
          entries: [local],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
      } as unknown as LocalScanner,
      new SyncEngine(),
      state,
      "testVault",
    );
    const onConfirmThreshold = vi.fn().mockImplementation(async (plan) => {
      await state.setPlanReviewBundle(plan.items, {
        uploads: plan.items.filter((item) => item.type === SyncActionType.Upload).length,
        downloads: plan.items.filter((item) => item.type === SyncActionType.Download).length,
        deletes: plan.items.filter((item) => item.type === SyncActionType.ConfirmLocalDelete).length,
        conflicts: plan.items.filter((item) => item.type === SyncActionType.Conflict).length,
        skipped: 0,
      }, plan.scope ?? TEST_SYNC_SCOPE);
      return true;
    });

    const result = await executor.run("manual", { onConfirmThreshold }, true, reviewedAuthorization);

    expect(result.success).toBe(false);
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "note.md",
        driveId: "note-id",
        eTag: "etag-current",
      }),
    ]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-clean");
    expect(onConfirmThreshold).toHaveBeenCalledTimes(1);
    expect(state.planReviewActive).toBe(true);
    expect(state.planReviewItems).toEqual([]);
    expect(state.planReviewDigest).toBe(planDigest([]));
    expect(uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(downloadFileToPath).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("refreshes a legacy tokenless conflict after hierarchy recovery", async () => {
    const state = await makeMemoryState();
    const path = "note.md";
    const local: LocalFileEntry = {
      path,
      size: 59,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    await state.setRemoteState([], "https://graph.example/delta-1");
    await state.updateBaseEntry({
      path,
      size: local.size,
      hash: "bb".repeat(32),
      eTag: "etag-app-old",
    });
    await state.addPendingConflict({
      type: SyncActionType.Conflict,
      path,
      local,
      reason: "reason.fileDeletedFromRemote",
    });
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "unrelated-folder",
          folder: { childCount: 0 },
          parentReference: { id: "files-root-id" },
        }],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [{
          id: "folder-id",
          name: "unrelated-folder",
          folder: { childCount: 0 },
          parentReference: { id: "files-root-id" },
        }],
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
      } as unknown as LocalScanner,
      new SyncEngine(),
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.message).not.toContain("Remote hierarchy incomplete");
    expect(state.pendingConflicts).toContainEqual(expect.objectContaining({
      path,
      decisionToken: expect.objectContaining({
        version: 1,
        local: { exists: true, hash: local.hash, size: local.size },
        remote: { exists: false },
        ancestorHash: "bb".repeat(32),
      }),
    }));
  });

  it("clears an expired token cache before rebuilding from a fresh delta", async () => {
    const state = await makeMemoryState();
    const persistedScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
    const refreshedScope: Omit<SyncScope, "accountId"> = {
      driveId: "refreshed-drive-id",
      vaultFolderId: "refreshed-vault-folder-id",
      filesRootId: "refreshed-files-root-id",
    };
    await state.bindAccount(persistedScope.accountId);
    await state.setRemoteState([
      {
        path: "stale.md",
        driveId: "stale-id",
        size: 1,
        mtime: 1,
        eTag: "stale-etag",
        cTag: "stale-ctag",
      },
    ], "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/testVault/files:/delta?token=expired", persistedScope);
    const getDelta = vi.fn()
      .mockRejectedValueOnce(new OneDriveError(
        OneDriveErrorType.Unknown,
        "delta token expired",
        410,
      ))
      .mockResolvedValueOnce({
        value: [driveItem("fresh.md", "cc".repeat(32), {
          parentReference: { id: refreshedScope.filesRootId },
        })],
        "@odata.deltaLink": "https://graph.example/fresh",
      });
    const fullScan = vi.fn();
    const restoreVaultScope = vi.fn().mockReturnValue(true);
    const invalidateVaultScope = vi.fn();
    const initVaultScope = vi.fn().mockResolvedValue(refreshedScope);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        fullScan,
        restoreVaultScope,
        invalidateVaultScope,
        initVaultScope,
        downloadFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue({
          path: "fresh.md",
          size: 3,
          mtime: 1,
          hash: "cc".repeat(32),
          binary: false,
        }),
      } as unknown as LocalScanner,
      new SyncEngine(),
      state,
      "testVault",
    );

    await executor.run("manual", {});

    expect(getDelta.mock.calls.map((call) => call[1])).toEqual([
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/testVault/files:/delta?token=expired",
      undefined,
    ]);
    expect(restoreVaultScope).toHaveBeenCalledTimes(1);
    expect(invalidateVaultScope).toHaveBeenCalledWith("testVault");
    expect(initVaultScope).toHaveBeenCalledTimes(1);
    expect(fullScan).not.toHaveBeenCalled();
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["fresh.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/fresh");
    expect(state.remoteScope).toEqual({
      accountId: persistedScope.accountId,
      ...refreshedScope,
    });
  });

  it("keeps the last healthy cache and stops planning on a network delta failure", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState([
      {
        path: "keep.md",
        driveId: "keep-id",
        size: 1,
        mtime: 1,
        eTag: "keep-etag",
        cTag: "keep-ctag",
      },
    ], "https://graph.example/delta-healthy");
    const getDelta = vi.fn().mockRejectedValue(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "offline",
    ));
    const fullScan = vi.fn();
    const generatePlan = vi.fn();
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
      {
        generatePlan,
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(generatePlan).not.toHaveBeenCalled();
    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(fullScan).not.toHaveBeenCalled();
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["keep.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-healthy");
  });

  it("applies successful uploads and remote deletes to the cached view", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState([
      {
        path: "remove.md",
        driveId: "remove-id",
        size: 3,
        mtime: 1,
        eTag: "etag-remove",
        cTag: "ctag-remove",
      },
    ], "https://graph.example/delta-1");
    const uploadItem: SyncPlanItem = {
      type: SyncActionType.Upload,
      path: "upload.md",
      local: {
        path: "upload.md",
        size: 3,
        mtime: 1,
        hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
        binary: false,
      },
    };
    const deleteItem: SyncPlanItem = {
      type: SyncActionType.DeleteRemote,
      path: "remove.md",
      remote: state.remoteSnapshot[0],
    };
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta: vi.fn().mockResolvedValue({ value: [], "@odata.deltaLink": "https://graph.example/delta-2" }),
        uploadFile: vi.fn().mockResolvedValue({
          id: "upload-id",
          name: "upload.md",
          size: 3,
          eTag: "etag-upload",
          cTag: "ctag-upload",
          lastModifiedDateTime: "2026-07-10T00:00:00.000Z",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [uploadItem.local], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [uploadItem, deleteItem],
          lastTotalFiles: 2,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      state,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.uploaded).toBe(1);
    expect(result.deleted).toBe(1);
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["upload.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
  });
});

describe("Remote sha256 dedup", () => {
  it("does not redownload an unchanged pending conflict", async () => {
    const path = ".obsidian/plugins/quickadd/main.js";
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
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path,
      local,
      remote,
      reason: "reason.newFileBothSides",
    };
    const downloadFile = vi.fn();
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [conflict],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;

    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [conflict], lastTotalFiles: 0, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(1);
  });

  it("resolves identical new binary files without downloading remote content", async () => {
    const path = "附件/录音/recording.m4a";
    const hash = "14731cbf60b9c1b219e31ab5a1b71bda45a0a4c3f137c0e0fa7f4ca1ad54a069";
    const baseEntries: BaseFileEntry[] = [];
    let lastSyncTime = 0;
    const downloadFile = vi.fn();

    const mockState = {
      ...remoteStateStub(),
      get baseSnapshot() {
        return baseEntries;
      },
      async updateBaseEntry(entry: BaseFileEntry) {
        const index = baseEntries.findIndex((e) => e.path === entry.path);
        if (index >= 0) {
          baseEntries[index] = entry;
        } else {
          baseEntries.push(entry);
        }
      },
      async upsertBaseEntries(entries: BaseFileEntry[]) {
        for (const entry of entries) {
          const index = baseEntries.findIndex((e) => e.path === entry.path);
          if (index >= 0) {
            baseEntries[index] = entry;
          } else {
            baseEntries.push(entry);
          }
        }
      },
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      async setLastSyncTime(time: number) {
        lastSyncTime = time;
      },
      get lastSyncTime() {
        return lastSyncTime;
      },
      pendingConflicts: [],
      pendingRemoteDeletes: [],
    } as unknown as StateManager;

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [
            graphFolder("attachments-zh-folder", "附件", "files-root-id"),
            graphFolder("recordings-folder", "录音", "attachments-zh-folder"),
            {
              id: "item-recording",
              name: "recording.m4a",
              size: 42534604,
              eTag: "etag-recording",
              cTag: "ctag-recording",
              lastModifiedDateTime: "2026-07-08T14:48:59.000Z",
              parentReference: {
                id: "recordings-folder",
                path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/附件/录音",
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
          entries: [
            { path, size: 42534604, mtime: 1, hash, binary: true },
          ],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(baseEntries).toEqual([
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
    const paths = Array.from({ length: 20 }, (_, index) => `attachments/file-${index}.bin`);
    const baseEntries: BaseFileEntry[] = [];
    const downloadFile = vi.fn();
    const upsertBaseEntries = vi.fn(async (entries: BaseFileEntry[]) => {
      baseEntries.push(...entries);
    });
    const mockState = {
      ...remoteStateStub(),
      get baseSnapshot() {
        return baseEntries;
      },
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries,
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    const remoteItems: DriveItem[] = [
      graphFolder("attachments-folder", "attachments", "files-root-id"),
      ...paths.map((path, index) => ({
      id: `item-${index}`,
      name: path.split("/").pop()!,
      size: 16,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        id: "attachments-folder",
        path: `/drives/x/root:/Apps/EasySync/vaults/testVault/files/attachments`,
      },
      file: { hashes: { sha256Hash: hash.toUpperCase() } },
      })),
    ];

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
          entries: paths.map((path) => ({ path, size: 16, mtime: 1, hash, binary: true })),
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(upsertBaseEntries).toHaveBeenCalledTimes(1);
    expect(baseEntries).toHaveLength(20);
  });

  it("absorbs an eTag-only remote change without downloading identical content", async () => {
    const path = "附件/录音/recording.m4a";
    const hash = "cd".repeat(32);
    const baseEntries: BaseFileEntry[] = [{
      path,
      hash,
      size: 1024,
      eTag: "upload-etag-v1",
    }];
    const downloadFile = vi.fn();
    const upsertBaseEntries = vi.fn(async (entries: BaseFileEntry[]) => {
      for (const entry of entries) {
        const index = baseEntries.findIndex((current) => current.path === entry.path);
        baseEntries[index] = entry;
      }
    });
    const mockState = {
      ...remoteStateStub(),
      get baseSnapshot() {
        return baseEntries;
      },
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries,
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 1,
    } as unknown as StateManager;

    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [
            graphFolder("attachments-zh-folder", "附件", "files-root-id"),
            graphFolder("recordings-folder", "录音", "attachments-zh-folder"),
            {
              id: "recording-id",
              name: "recording.m4a",
              size: 1024,
              eTag: "delta-etag-v2",
              cTag: "ctag",
              lastModifiedDateTime: "2026-07-10T12:00:00.000Z",
              parentReference: {
                id: "recordings-folder",
                path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/附件/录音",
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
          entries: [{ path, size: 1024, mtime: 1, hash, binary: true }],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(upsertBaseEntries).toHaveBeenCalledWith([{
      path,
      hash,
      size: 1024,
      eTag: "delta-etag-v2",
    }]);
  });

  it("downloads every candidate during bootstrap when remote metadata has no sha256", async () => {
    const content = new TextEncoder().encode("same attachment content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from({ length: 20 }, (_, index) => `attachments/no-hash-${index}.bin`);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const upsertBaseEntries = vi.fn().mockResolvedValue(undefined);
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries,
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      upsertPendingConflicts,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    const remoteItems: DriveItem[] = [
      graphFolder("attachments-folder", "attachments", "files-root-id"),
      ...paths.map((path, index) => ({
      id: `no-hash-${index}`,
      name: path.split("/").pop()!,
      size: content.byteLength,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        id: "attachments-folder",
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/attachments",
      },
      file: {},
      })),
    ];

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
          entries: paths.map((path) => ({
            path,
            size: content.byteLength,
            mtime: 1,
            hash,
            binary: true,
          })),
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(20);
    expect(upsertBaseEntries).toHaveBeenCalledTimes(1);
    expect(upsertBaseEntries.mock.calls[0][0]).toHaveLength(20);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(0);
  });

  it("caps download-based hash dedup at ten candidates for an established vault", async () => {
    const content = new TextEncoder().encode("same attachment content").buffer;
    const hash = await sha256Hex(content);
    const paths = Array.from({ length: 11 }, (_, index) => `attachments/established-${index}.bin`);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const upsertBaseEntries = vi.fn().mockResolvedValue(undefined);
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [{
        path: paths[0],
        hash: "00".repeat(32),
        size: content.byteLength,
        eTag: "etag-old",
      }],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries,
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      upsertPendingConflicts,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 1,
    } as unknown as StateManager;
    const remoteItems: DriveItem[] = [
      graphFolder("attachments-folder", "attachments", "files-root-id"),
      ...paths.map((path, index) => ({
        id: `established-${index}`,
        name: path.split("/").pop()!,
        size: content.byteLength,
        eTag: `etag-${index}`,
        cTag: `ctag-${index}`,
        parentReference: {
          id: "attachments-folder",
          path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/attachments",
        },
        file: {},
      })),
    ];

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
          entries: paths.map((path) => ({
            path,
            size: content.byteLength,
            mtime: 1,
            hash,
            binary: true,
          })),
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      new SyncEngine(),
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(downloadFile).toHaveBeenCalledTimes(10);
    expect(upsertBaseEntries).toHaveBeenCalledTimes(1);
    expect(upsertBaseEntries.mock.calls[0][0]).toHaveLength(10);
    expect(upsertPendingConflicts).toHaveBeenCalledTimes(1);
    expect(upsertPendingConflicts.mock.calls[0][0]).toHaveLength(1);
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
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path: local.path,
      local,
      reason: "reason.fileDeletedFromRemote",
    };
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [{
        path: local.path,
        size: local.size,
        hash: local.hash,
        eTag: "etag-old",
      }],
      boundAccountId: "account-test",
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
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
          entries: [local],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(local),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [conflict],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(true),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", { onConfirmThreshold });

    expect(result.message).toBe("result.pausedForReview");
    expect(onConfirmThreshold).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        path: local.path,
        decisionToken: expect.objectContaining({
          version: 1,
          vaultName: "testVault",
          accountId: "account-test",
          ancestorHash: local.hash,
        }),
      })],
    }));
  });

  it("persists a large conflict plan through one batch call", async () => {
    const items = Array.from({ length: 1000 }, (_, index): SyncPlanItem => ({
      type: SyncActionType.Conflict,
      path: `conflict-${index}.md`,
    }));
    const addPendingConflict = vi.fn();
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict,
      upsertPendingConflicts,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      addPendingDelete: vi.fn(),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    const mockEngine = {
      generatePlan: vi.fn().mockReturnValue({ items, lastTotalFiles: 1000, confirmed: false }),
      shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
    } as unknown as SyncEngine;

    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      mockEngine,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(1000);
    expect(upsertPendingConflicts).toHaveBeenCalledTimes(1);
    const persisted = upsertPendingConflicts.mock.calls[0][0] as SyncPlanItem[];
    expect(persisted.map((item) => item.path)).toEqual(items.map((item) => item.path));
    expect(persisted.every((item) => item.decisionToken?.version === 1)).toBe(true);
    expect(addPendingConflict).not.toHaveBeenCalled();
  });
});

describe("Cancellation checkpoint semantics", () => {
  it("does not record an aborted in-flight transfer as a sync failure after user cancellation", async () => {
    let executor: SyncExecutor;
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const executorState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
      reconcilePendingIssues,
    } as unknown as StateManager;
    const planItem: SyncPlanItem = {
      type: SyncActionType.Download,
      path: "cancelled.md",
      remote: {
        path: "cancelled.md",
        driveId: "remote-id",
        size: 3,
        mtime: 1,
        eTag: "etag-1",
        cTag: "ctag-1",
      },
    };
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
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [planItem], lastTotalFiles: 1, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
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
    const items = ["first.md", "second.md"].map((path): SyncPlanItem => ({
      type: SyncActionType.Upload,
      path,
      local: {
        path,
        size: 8,
        mtime: 1,
        hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
        binary: false,
      },
    }));
    const mockState = {
      ...remoteStateStub(),
      applyRemoteMutations,
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: items.map((item) => item.local), skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items, lastTotalFiles: 2, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.uploaded).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(mockState.recordMutationReceipt).toHaveBeenCalledTimes(1);
    expect(mockState.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(applyRemoteMutations).not.toHaveBeenCalled();
    expect(mockState.upsertBaseEntries).not.toHaveBeenCalled();
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
      size: 3,
      mtime: 1,
      eTag: "etag-download",
      cTag: "ctag-download",
      sha256Hash: hash,
    };
    const state = {
      ...remoteStateStub(),
      baseSnapshot: [],
      recordMutationReceipt,
      commitMutationCheckpoint,
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile: vi.fn().mockResolvedValue(content) }),
      {
        vault: {
          adapter: makeMockAdapter({ writeBinary, stat: vi.fn().mockResolvedValue({ size: 3, mtime: 2 }) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0, complete: true }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Download, path: remote.path, remote }],
          lastTotalFiles: 0,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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

  it("publishes no checkpoints when cancellation happens immediately before state commit", async () => {
    let executor: SyncExecutor;
    const upsertBaseEntries = vi.fn().mockResolvedValue(undefined);
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const item: SyncPlanItem = {
      type: SyncActionType.Upload,
      path: "checkpoint.md",
      local: {
        path: "checkpoint.md",
        size: 8,
        mtime: 1,
        hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
        binary: false,
      },
    };
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      upsertBaseEntries,
      applyRemoteMutations,
      reconcilePendingIssues,
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingIssues: vi.fn().mockResolvedValue(undefined),
    } as unknown as StateManager;
    executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile: vi.fn().mockResolvedValue({
          id: "uploaded-id",
          eTag: "uploaded-etag",
          cTag: "uploaded-ctag",
        }),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [item.local], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [item], lastTotalFiles: 1, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {
      onFileComplete: () => executor.cancel(),
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.cancelled");
    expect(upsertBaseEntries).not.toHaveBeenCalled();
    expect(applyRemoteMutations).not.toHaveBeenCalled();
    expect(reconcilePendingIssues).not.toHaveBeenCalled();
  });

  it("clears a reviewed plan only after the revalidated digest still matches", async () => {
    const authorization = { revision: 1, scope: TEST_SYNC_SCOPE };
    const clearPlanReview = vi.fn().mockResolvedValue(true);
    const mockState = {
      ...remoteStateStub(),
      boundAccountId: "",
      baseSnapshot: [],
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      planReviewActive: true,
      planReviewDigest: planDigest([]),
      planReviewRevision: authorization.revision,
      planReviewScope: authorization.scope,
      clearPlanReview,
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [], lastTotalFiles: 0, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {}, true, authorization);

    expect(result.success).toBe(true);
    expect(clearPlanReview).toHaveBeenCalledWith(authorization);
  });

  it.each([
    ["revision", 8, TEST_SYNC_SCOPE, 7, TEST_SYNC_SCOPE],
    ["scope", 7, { ...TEST_SYNC_SCOPE, driveId: "drive-old" }, 7, { ...TEST_SYNC_SCOPE, driveId: "drive-old" }],
  ])("re-pauses a reviewed plan when its %s authorization is stale", async (
    _label,
    persistedRevision,
    persistedScope,
    requestedRevision,
    requestedScope,
  ) => {
    const clearPlanReview = vi.fn().mockResolvedValue(true);
    const mockState = {
      ...remoteStateStub(),
      boundAccountId: "",
      baseSnapshot: [],
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      planReviewActive: true,
      planReviewDigest: planDigest([]),
      planReviewRevision: persistedRevision,
      planReviewScope: persistedScope,
      clearPlanReview,
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
    const uploadFile = vi.fn();
    const downloadFile = vi.fn();
    const deleteItem = vi.fn();
    const onConfirmThreshold = vi.fn().mockResolvedValue(false);
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, downloadFile, deleteItem }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [], lastTotalFiles: 0, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    const result = await (executor.run as unknown as (
      mode: string,
      callbacks: SyncCallbacks,
      skipConfirmation: boolean,
      authorization: { revision: number; scope: typeof TEST_SYNC_SCOPE },
    ) => Promise<SyncResult>)(
      "manual",
      { onConfirmThreshold },
      true,
      { revision: requestedRevision, scope: requestedScope },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.pausedForReview");
    expect(onConfirmThreshold).toHaveBeenCalledTimes(1);
    expect(onConfirmThreshold).toHaveBeenCalledWith(expect.objectContaining({
      scope: TEST_SYNC_SCOPE,
    }));
    expect(clearPlanReview).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("re-pauses a reviewed plan when the digest changed before execution", async () => {
    const authorization = { revision: 1, scope: TEST_SYNC_SCOPE };
    const clearPlanReview = vi.fn().mockResolvedValue(true);
    const currentPlan: SyncPlanItem[] = [{
      type: SyncActionType.Upload,
      path: "note.md",
      local: {
        path: "note.md",
        size: 4,
        mtime: 1,
        hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
        binary: false,
      },
    }];
    const reviewedPlan: SyncPlanItem[] = [{
      type: SyncActionType.Download,
      path: "other.md",
      remote: {
        path: "other.md",
        driveId: "other-id",
        size: 1,
        mtime: 1,
        eTag: "other-etag",
        cTag: "other-ctag",
      },
    }];
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      planReviewActive: true,
      planReviewDigest: planDigest(reviewedPlan),
      planReviewRevision: authorization.revision,
      planReviewScope: authorization.scope,
      clearPlanReview,
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
    const onConfirmThreshold = vi.fn().mockResolvedValue(false);
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: currentPlan.map((item) => item.local), skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: currentPlan, lastTotalFiles: 1, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", { onConfirmThreshold }, true, authorization);

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.pausedForReview");
    expect(onConfirmThreshold).toHaveBeenCalledTimes(1);
    expect(clearPlanReview).not.toHaveBeenCalled();
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
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues,
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      lastSyncTime: 0,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({ readBinary: vi.fn().mockResolvedValue(changed) }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [{ type: SyncActionType.Upload, path: local.path, local }], lastTotalFiles: 1, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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
      size: 4,
      mtime: 1,
      eTag: "broken-etag",
      cTag: "broken-ctag",
    };
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
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({ items: [{ type: SyncActionType.Download, path: remote.path, remote }], lastTotalFiles: 1, confirmed: false }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: [],
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
        removeBaseEntries: vi.fn().mockResolvedValue(undefined),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        reconcilePendingIssues,
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        lastSyncTime: 0,
      } as unknown as StateManager,
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

describe("Execute-time same-content convergence", () => {
  it("absorbs an If-Match upload race when remote already has the same content", async () => {
    const local: LocalFileEntry = {
      path: "note.md",
      size: 8,
      mtime: 1,
      hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      binary: false,
    };
    const upsertPendingConflicts = vi.fn().mockResolvedValue(undefined);
    const upsertBaseEntries = vi.fn().mockResolvedValue(undefined);
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
    const uploadFile = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
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
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{
            type: SyncActionType.Upload,
            path: local.path,
            local,
            remote: {
              path: local.path,
              driveId: "remote-id",
              size: local.size,
              mtime: 1,
              eTag: "etag-old",
              cTag: "",
            },
            baseEtag: "etag-old",
          }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: [{ path: local.path, hash: "00".repeat(32), size: local.size, eTag: "etag-old" }],
        upsertBaseEntries,
        applyRemoteMutations,
        updateBaseEntry: vi.fn().mockResolvedValue(undefined),
        setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
        removeBaseEntry: vi.fn(),
        upsertPendingConflicts,
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        lastSyncTime: 0,
      } as unknown as StateManager,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(result.errors).toBe(0);
    expect(upsertPendingConflicts).not.toHaveBeenCalled();
    expect(upsertBaseEntries).toHaveBeenCalledWith([
      { path: local.path, hash: local.hash, size: local.size, eTag: "etag-remote" },
    ]);
    expect(applyRemoteMutations).toHaveBeenCalledWith([
      expect.objectContaining({
        path: local.path,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        sha256Hash: local.hash,
        eTag: "etag-remote",
      }),
    ], []);
    expect(uploadFile).toHaveBeenCalledWith(
      "testVault",
      local.path,
      expect.any(ArrayBuffer),
      undefined,
      "etag-old",
      "remote-id",
    );
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
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
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
        scanAll: vi.fn().mockResolvedValue({ entries: [local], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{
            type: SyncActionType.Download,
            path: local.path,
            local,
            remote: {
              path: local.path,
              driveId: "remote-id",
              downloadUrl: "https://download.example/note.md",
              size: remoteContent.byteLength,
              mtime: 2,
              eTag: "etag-remote",
              cTag: "",
              sha256Hash: remoteHash,
            },
          }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: [{ path: local.path, hash: scannedHash, size: scannedContent.byteLength, eTag: "etag-old" }],
        addPendingConflict,
        upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
        updateBaseEntry: vi.fn().mockResolvedValue(undefined),
        removeBaseEntry: vi.fn(),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        applyRemoteMutations,
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        lastSyncTime: 0,
      } as unknown as StateManager,
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
    expect(applyRemoteMutations).not.toHaveBeenCalled();
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
    const upsertBaseEntries = vi.fn().mockResolvedValue(undefined);
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
        scanAll: vi.fn().mockResolvedValue({ entries: [scanned], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        inspectFile: vi.fn().mockResolvedValue({
          status: "present",
          entry: { ...scanned, hash: currentHash, size: currentContent.byteLength, mtime: 9 },
        }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{ type: SyncActionType.Download, path, local: scanned, remote }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: [{ path, hash: scannedHash, size: scanned.size, eTag: "etag-old" }],
        addPendingConflict,
        upsertBaseEntries,
        removeBaseEntries: vi.fn().mockResolvedValue(undefined),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        lastSyncTime: 0,
      } as unknown as StateManager,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.conflicts).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(addPendingConflict).not.toHaveBeenCalled();
    expect(upsertBaseEntries).toHaveBeenCalledWith([{
      path,
      hash: currentHash,
      size: currentContent.byteLength,
      eTag: remote.eTag,
    }]);
  });

  it("queues a pending conflict when remote changes before DeleteRemote executes", async () => {
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
    const deleteItem = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
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
        scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [{
            type: SyncActionType.DeleteRemote,
            path: "deleted.md",
            remote: {
              path: "deleted.md",
              driveId: "remote-id",
              size: 10,
              mtime: 1,
              eTag: "etag-old",
              cTag: "",
            },
          }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: [{ path: "deleted.md", hash: "aa".repeat(32), size: 10, eTag: "etag-old" }],
        addPendingConflict,
        upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
        updateBaseEntry: vi.fn().mockResolvedValue(undefined),
        removeBaseEntry: vi.fn(),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        applyRemoteMutations,
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        lastSyncTime: 0,
      } as unknown as StateManager,
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
    expect(applyRemoteMutations).toHaveBeenCalledWith([
      {
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
    ], []);
    expect(deleteItem).toHaveBeenCalledWith(
      "testVault",
      "deleted.md",
      "etag-old",
      "remote-id",
    );
  });
});

describe("Bounded small-file upload concurrency", () => {
  it("serializes file mutations until every intent has a durable receipt checkpoint", async () => {
    let activeUploads = 0;
    let peakUploads = 0;
    const events: string[] = [];
    const progressStore = new SyncProgressStore();
    const uploadFile = vi.fn().mockImplementation(async (
      _vault: string,
      path: string,
      _content: ArrayBuffer,
      onProgress?: (uploadedBytes: number, totalBytes: number) => void,
    ) => {
      activeUploads++;
      peakUploads = Math.max(peakUploads, activeUploads);
      events.push(`start:${path}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (path === "large.bin") onProgress?.(32 * 1024 * 1024, 51 * 1024 * 1024);
      events.push(`end:${path}`);
      activeUploads--;
      return { id: `id:${path}`, eTag: `etag:${path}` };
    });
    const smallItems = Array.from({ length: 8 }, (_, index): SyncPlanItem => ({
      type: SyncActionType.Upload,
      path: `small-${index}.md`,
      local: {
        path: `small-${index}.md`,
        hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
        size: 8,
        mtime: index,
      },
    }));
    const largeItem: SyncPlanItem = {
      type: SyncActionType.Upload,
      path: "large.bin",
      local: {
        path: "large.bin",
        hash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
        size: 51 * 1024 * 1024,
        mtime: 99,
      },
    };
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: { adapter: makeMockAdapter() },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [...smallItems, largeItem],
          lastTotalFiles: 9,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
      undefined,
      progressStore,
    );

    const result = await executor.run("manual", {});

    expect(result.uploaded).toBe(9);
    expect(result.metrics?.fileTransfers.upload).toMatchObject({
      started: 9,
      succeeded: 9,
      failed: 0,
      cancelled: 0,
      skipped: 0,
      logicalBytes: 51 * 1024 * 1024 + 64,
      peakConcurrency: 1,
    });
    expect(peakUploads).toBe(1);
    expect(events.indexOf("start:large.bin")).toBeGreaterThan(events.indexOf("end:small-7.md"));
  });

  it("serializes concurrent state saves", async () => {
    let activeSaves = 0;
    let peakSaves = 0;
    let saveQueue: Promise<void> = Promise.resolve();
    const plugin = {
      loadData: vi.fn().mockResolvedValue({}),
      saveData: vi.fn().mockImplementation(async () => {
        activeSaves++;
        peakSaves = Math.max(peakSaves, activeSaves);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeSaves--;
      }),
      updatePluginData: vi.fn(async (mutator: (data: Record<string, unknown>) => void) => {
        const task = saveQueue.then(async () => {
          const d = (await plugin.loadData()) ?? {};
          mutator(d);
          await plugin.saveData(d);
        });
        saveQueue = task.catch(() => undefined);
        return task;
      }),
      app: {
        vault: {
          adapter: {
            read: vi.fn().mockRejectedValue(new Error("missing")),
          },
        },
      },
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
    };
    const state = new StateManager(plugin);
    await state.load();

    await Promise.all([
      state.updateBaseEntry({ path: "a.md", hash: "a", size: 1, eTag: "1" }),
      state.updateBaseEntry({ path: "b.md", hash: "b", size: 1, eTag: "2" }),
      state.updateBaseEntry({ path: "c.md", hash: "c", size: 1, eTag: "3" }),
    ]);

    expect(peakSaves).toBe(1);
    expect(state.baseSnapshot.map((entry) => entry.path).sort()).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });
});

describe("Conservative desktop small-file download concurrency", () => {
  it("overlaps only network prefetch while local writes stay serial", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      const bytes = new Uint8Array(256 * 1024);
      bytes.fill(7);
      const buffer = bytes.buffer;
      const hash = await sha256Hex(buffer);
      let activeDownloads = 0;
      let peakDownloads = 0;
      let activeWrites = 0;
      let peakWrites = 0;
      const downloadFile = vi.fn().mockImplementation(async () => {
        activeDownloads++;
        peakDownloads = Math.max(peakDownloads, activeDownloads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeDownloads--;
        return buffer.slice(0);
      });
      const writeBinary = vi.fn().mockImplementation(async () => {
        activeWrites++;
        peakWrites = Math.max(peakWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeWrites--;
      });
      const items = Array.from({ length: 9 }, (_, index): SyncPlanItem => ({
        type: SyncActionType.Download,
        path: `download-${index}.bin`,
        remote: {
          path: `download-${index}.bin`,
          driveId: `remote-${index}`,
          size: buffer.byteLength,
          mtime: index,
          eTag: `etag-${index}`,
          cTag: `ctag-${index}`,
          sha256Hash: hash,
        },
      }));
      const state = {
        ...remoteStateStub(),
        baseSnapshot: [],
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
        removeBaseEntries: vi.fn().mockResolvedValue(undefined),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        lastSyncTime: 0,
      } as unknown as StateManager;
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: makeMockAdapter({ writeBinary }),
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
          scanFile: vi.fn().mockResolvedValue(null),
        } as unknown as LocalScanner,
        {
          generatePlan: vi.fn().mockReturnValue({ items, lastTotalFiles: items.length, confirmed: false }),
          shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
        } as unknown as SyncEngine,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(items.length);
      expect(result.errors).toBe(0);
      // The policy may conservatively remain at 2 when real test-clock
      // throughput drops. Deterministic 1 -> 2 -> 3 promotion is covered by
      // download-concurrency-policy.test.ts; this integration contract only
      // requires actual overlap, the hard cap, and serial local commits.
      expect(peakDownloads).toBeGreaterThanOrEqual(2);
      expect(peakDownloads).toBeLessThanOrEqual(3);
      expect(peakWrites).toBe(1);
      expect(result.metrics?.fileTransfers.download).toMatchObject({
        started: items.length,
        succeeded: items.length,
        failed: 0,
        peakConcurrency: peakDownloads,
      });
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("returns to serial after the download path reports degradation", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      const buffer = new Uint8Array(1024 * 1024).fill(3).buffer;
      const hash = await sha256Hex(buffer);
      let active = 0;
      let peak = 0;
      const batchHealth = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValue(true);
      const downloadFile = vi.fn().mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active--;
        return buffer.slice(0);
      });
      const items = Array.from({ length: 7 }, (_, index): SyncPlanItem => ({
        type: SyncActionType.Download,
        path: `degraded-${index}.bin`,
        remote: {
          path: `degraded-${index}.bin`,
          driveId: `degraded-id-${index}`,
          size: buffer.byteLength,
          mtime: index,
          eTag: `degraded-etag-${index}`,
          cTag: "",
          sha256Hash: hash,
        },
      }));
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          hasDegradedDownloadPathThisRound: batchHealth,
        }),
        {
          vault: { adapter: makeMockAdapter() },
          scanAll: vi.fn().mockResolvedValue({ entries: [], skippedLarge: [], failedPaths: [], skippedCount: 0 }),
          scanFile: vi.fn().mockResolvedValue(null),
        } as unknown as LocalScanner,
        {
          generatePlan: vi.fn().mockReturnValue({ items, lastTotalFiles: items.length, confirmed: false }),
          shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
        } as unknown as SyncEngine,
        {
          ...remoteStateStub(),
          baseSnapshot: [],
          pendingConflicts: [],
          pendingRemoteDeletes: [],
          upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
          removeBaseEntries: vi.fn().mockResolvedValue(undefined),
          upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
          prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
          upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
          prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
          reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
          setLastSyncTime: vi.fn().mockResolvedValue(undefined),
          lastSyncTime: 0,
        } as unknown as StateManager,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(items.length);
      expect(result.errors).toBe(0);
      expect(peak).toBe(2);
      expect(batchHealth).toHaveBeenCalledTimes(6);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });
});

describe("Pending conflict cleanup", () => {
  it("clears stale pending conflicts when the current healthy plan has none", async () => {
    const pendingConflicts = [
      {
        type: SyncActionType.Conflict,
        path: "stale.md",
        reason: "reason.bothSidesModified",
      },
    ];

    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      addPendingConflict: vi.fn(),
      async prunePendingConflicts(activePaths: Iterable<string>) {
        const active = new Set(activePaths);
        pendingConflicts.splice(
          0,
          pendingConflicts.length,
          ...pendingConflicts.filter((item) => active.has(item.path)),
        );
      },
      addPendingDelete: vi.fn(),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      pendingConflicts,
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;

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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      mockState,
      "testVault",
    );

    await executor.run("manual", {});

    expect(pendingConflicts).toHaveLength(0);
  });

  it("keeps pending conflicts when the current scan is unhealthy", async () => {
    const pendingConflicts = [
      {
        type: SyncActionType.Conflict,
        path: "keep.md",
        reason: "reason.bothSidesModified",
      },
    ];
    const prunePendingConflicts = vi.fn().mockResolvedValue(undefined);

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
          skippedLarge: [],
          failedPaths: ["keep.md"],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: [],
        updateBaseEntry: vi.fn().mockResolvedValue(undefined),
        setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
        removeBaseEntry: vi.fn(),
        addPendingConflict: vi.fn(),
        prunePendingConflicts,
        addPendingDelete: vi.fn(),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        pendingConflicts,
        pendingRemoteDeletes: [],
        lastSyncTime: 0,
      } as unknown as StateManager,
      "testVault",
    );

    await executor.run("manual", {});

    expect(prunePendingConflicts).not.toHaveBeenCalled();
    expect(pendingConflicts).toHaveLength(1);
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

    const plan = new SyncEngine().generatePlan([local], [remote], [base], []);

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
  const engine = new SyncEngine();
  const protectedConfigPaths = [
    ".obsidian/app.json",
    ".obsidian/appearance.json",
    ".obsidian/hotkeys.json",
    ".obsidian/core-plugins.json",
    ".obsidian/community-plugins.json",
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
    const plan = engine.generatePlan(
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
      const plan = engine.generatePlan([], [], [], skippedLarge);
      expect(plan.items).toHaveLength(skippedLarge.length);
      expect(some).not.toHaveBeenCalled();
    } finally {
      some.mockRestore();
    }
  });

  it("file in base only (not remote), grew >50MB → SkipLargeFile, NOT a delete", () => {
    // Local-only file outgrew limit. Should just be skipped, not trigger any delete.
    const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
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
      const plan = engine.generatePlan(
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
      const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
      [],
      [],
      [baseEntry("gone.md")],
      [],
    );

    expect(plan.items).toHaveLength(0);
  });

  it("mixed: one normal delete + one oversized skip in same plan", () => {
    const plan = engine.generatePlan(
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
  const engine = new SyncEngine();

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
    const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
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
    const plan = engine.generatePlan(
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
    pendingConflicts?: SyncPlanItem[];
    pendingRemoteDeletes?: SyncPlanItem[];
    adapterOverrides?: Record<string, unknown>;
    scanFile?: ReturnType<typeof vi.fn>;
    inspectFile?: ReturnType<typeof vi.fn>;
    stateOverrides?: Record<string, unknown>;
    fileManager?: Record<string, unknown>;
    vaultFile?: unknown;
    getFileMetadata?: ReturnType<typeof vi.fn>;
    initVaultScope?: ReturnType<typeof vi.fn>;
    preserveMissingDecisionTokens?: boolean;
    onProgressUpdate?: () => void;
    progressStore?: SyncProgressStore;
    diag?: DiagnosticLogger;
    noticeCenter?: EasySyncNoticeCenter;
    shouldSyncPath?: ReturnType<typeof vi.fn>;
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

    return new SyncExecutor(
      makeMockOneDrive({
        downloadFile: options.downloadFile,
        uploadFile: options.uploadFile,
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
          adapter: makeMockAdapter(options.adapterOverrides),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          getFileByPath: vi.fn().mockReturnValue(options.vaultFile ?? null),
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
      {} as SyncEngine,
      mockState,
      "testVault",
      undefined,
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
    const executor = makeProgressAwareExecutor({
      progressStore,
      pendingConflicts: [{
        type: SyncActionType.Conflict,
        path: remote.path,
        remote,
        local: {
          path: remote.path,
          hash: "aa".repeat(32),
          size: 10,
          mtime: 1,
          binary: true,
        },
      }],
      adapterOverrides: {
        stat: vi.fn().mockResolvedValue({ size: 10, mtime: 1 }),
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
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
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
    const reviewedLocal: LocalFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 1,
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
      adapterOverrides: { writeBinary },
      downloadFile,
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => {
      expect(executor.isSideActionQueued(path)).toBe(false);
    });

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(writeBinary).not.toHaveBeenCalled();
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
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: false,
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
      adapterOverrides: { writeBinary },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(writeBinary).not.toHaveBeenCalled();
    expect(addPendingConflict).toHaveBeenCalledWith(expect.objectContaining({
      remote: expect.objectContaining({ eTag: "etag-new" }),
    }));
  });

  it("does not write keepRemote content when downloaded bytes fail the reviewed hash", async () => {
    const path = "hash-mismatch.bin";
    const local: LocalFileEntry = {
      path, hash: "aa".repeat(32), size: 1, mtime: 1, binary: true,
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
      adapterOverrides: { writeBinary },
    });

    await executor.resolveConflictKeepRemote(path);
    await waitUntil(() => expect(executor.isSideActionQueued(path)).toBe(false));

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(writeBinary).not.toHaveBeenCalled();
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

describe("S1a — sync run phase observability", () => {
  it("emits one structured phase summary for a completed production run", async () => {
    const diagLog = vi.fn();
    const diag = {
      log: diagLog,
      warn: vi.fn(),
      error: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
    } as unknown as DiagnosticLogger;
    const setRemoteState = vi.fn().mockResolvedValue(undefined);
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
    const state = {
      ...remoteStateStub(),
      legacyAutoSyncAllowed: true,
      boundAccountId: "",
      baseSnapshot: [],
      hasRemoteState: true,
      remoteSnapshot: [],
      remoteDeltaLink: "delta-token",
      remoteScope: TEST_SYNC_SCOPE,
      remoteGeneration: 0,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      planReviewActive: false,
      planReviewRevision: 0,
      lastSyncTime: 0,
      setRemoteState,
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingIssues: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
    } as unknown as StateManager;
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
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
      } as unknown as LocalScanner,
      {
        generatePlan: vi.fn().mockReturnValue({
          items: [],
          lastTotalFiles: 0,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
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
    );
    expect(diagLog).toHaveBeenCalledWith(
      "execute",
      "sync file transfer summary",
      expect.objectContaining({
        schemaVersion: 2,
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
      }),
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
        path: `notes/note-${index.toString().padStart(3, "0")}.md`,
        size: 128,
        mtime: 1,
        hash: "aa".repeat(32),
        binary: false,
      }));
      const scanAll = vi.fn().mockResolvedValue({
        entries,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      });
      const getDelta = vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "delta-token-next",
      });
      const setRemoteState = vi.fn().mockResolvedValue(undefined);
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
      const state = {
        ...remoteStateStub(),
        legacyAutoSyncAllowed: true,
        boundAccountId: "account-id",
        baseSnapshot: [],
        hasRemoteState: true,
        remoteSnapshot: [],
        remoteDeltaLink: "delta-token",
        remoteScope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
        remoteGeneration: 0,
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        planReviewActive: false,
        planReviewRevision: 0,
        lastSyncTime: 0,
        setRemoteState,
        upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
        removeBaseEntries: vi.fn().mockResolvedValue(undefined),
        prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
        prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
        prunePendingIssues: vi.fn().mockResolvedValue(undefined),
        upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
        upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
        reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime,
        incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
      } as unknown as StateManager;
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
        {
          generatePlan: vi.fn().mockReturnValue({
            items: [],
            lastTotalFiles: entries.length,
            confirmed: false,
          }),
          shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
        } as unknown as SyncEngine,
        state,
        "testVault",
        undefined,
        undefined,
        diag,
      );
      const withoutDiagnosticsMs: number[] = [];
      const withDiagnosticsMs: number[] = [];

      for (let round = 0; round < 5; round++) {
        const startedAt = performance.now();
        const result = await executor.run("manual", {});
        withoutDiagnosticsMs.push(performance.now() - startedAt);
        expect(result.success).toBe(true);
      }
      diagnosticsEnabled.value = true;
      for (let round = 0; round < 5; round++) {
        const startedAt = performance.now();
        const result = await executor.run("manual", {});
        withDiagnosticsMs.push(performance.now() - startedAt);
        expect(result.success).toBe(true);
      }

      expect(scanAll).toHaveBeenCalledTimes(10);
      expect(getDelta).toHaveBeenCalledTimes(10);
      expect(restoreVaultScope).toHaveBeenCalledTimes(10);
      expect(initVaultScope).not.toHaveBeenCalled();
      expect(setRemoteState).toHaveBeenCalledTimes(10);
      expect(setLastSyncTime).toHaveBeenCalledTimes(10);
      expect(beginRunMetrics).toHaveBeenCalledTimes(5);
      expect(finishRunMetrics).toHaveBeenCalledTimes(5);
      const medianWithoutDiagnostics = [...withoutDiagnosticsMs].sort((a, b) => a - b)[2];
      const medianWithDiagnostics = [...withDiagnosticsMs].sort((a, b) => a - b)[2];
      const allowedProbeOverheadMs = Math.max(medianWithoutDiagnostics * 0.05, 10);
      expect(medianWithDiagnostics - medianWithoutDiagnostics).toBeLessThanOrEqual(allowedProbeOverheadMs);
      console.info("[a0p-production-entry]", JSON.stringify({
        schemaVersion: 1,
        mode: "platform-neutral",
        files: entries.length,
        roundsPerMode: 5,
        diagnosticsOffMedianMs: Number(medianWithoutDiagnostics.toFixed(3)),
        diagnosticsOnMedianMs: Number(medianWithDiagnostics.toFixed(3)),
        diagnosticsOverheadMs: Number((medianWithDiagnostics - medianWithoutDiagnostics).toFixed(3)),
        allowedProbeOverheadMs: Number(allowedProbeOverheadMs.toFixed(3)),
        operations: {
          fullScansPerRun: scanAll.mock.calls.length / 10,
          deltaCallsPerRun: getDelta.mock.calls.length / 10,
          remoteStateCommitsPerRun: setRemoteState.mock.calls.length / 10,
          healthTimeCommitsPerRun: setLastSyncTime.mock.calls.length / 10,
        },
      }));
  });
});
