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

import { describe, it, expect, vi } from "vitest";
import { Platform, type Plugin } from "obsidian";
import { fullHash } from "../src/sync/local-scanner";
import { SyncActionType } from "../src/sync/types";
import { planDigest } from "../src/sync/types";
import type { BaseFileEntry, SyncPlanItem, RemoteFileEntry, LocalFileEntry } from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import { SyncEngine } from "../src/sync/sync-engine";
import { StateManager } from "../src/sync/state-manager";
import type { I18n } from "../src/i18n";
import { SyncProgressStore } from "../src/sync/sync-progress";

// ---- Shared test helpers ----

function makeMockAdapter(overrides: Record<string, unknown> = {}) {
  return {
    read: vi.fn().mockResolvedValue(""),
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
    uploadBaseline: vi.fn().mockResolvedValue(undefined),
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
    uploadFile: vi.fn().mockResolvedValue({ eTag: "mock-etag" }),
    deleteItem: vi.fn().mockResolvedValue(undefined),
    initVaultDirectories: vi.fn().mockResolvedValue(undefined),
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
  };
}

// ---- P0.3: Full SHA-256 hash correctness ----

describe("P0.3 — fullHash (full SHA-256)", () => {
  it("same content produces same hash", async () => {
    const data = new TextEncoder().encode("hello world").buffer;
    const h1 = await fullHash(data);
    const h2 = await fullHash(data);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("different content produces different hash", async () => {
    const a = new TextEncoder().encode("hello world").buffer;
    const b = new TextEncoder().encode("hello worlD").buffer;
    expect(await fullHash(a)).not.toBe(await fullHash(b));
  });

  it("modification beyond 16KB is detected (old quickHash blind spot)", async () => {
    const size = 20 * 1024;
    const buf1 = new Uint8Array(size);
    const buf2 = new Uint8Array(size);
    for (let i = 0; i < 16 * 1024; i++) {
      buf1[i] = buf2[i] = i % 256;
    }
    buf2[size - 1] = 0xff;

    const h1 = await fullHash(buf1.buffer);
    const h2 = await fullHash(buf2.buffer);
    expect(h1).not.toBe(h2);
  });

  it("0-byte file hash matches known SHA-256 empty input", async () => {
    const empty = new ArrayBuffer(0);
    const h = await fullHash(empty);
    expect(h).toHaveLength(64);
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("same-size entirely different content produces different hash", async () => {
    const buf1 = new Uint8Array(1000).fill(0x41);
    const buf2 = new Uint8Array(1000).fill(0x42);
    expect(await fullHash(buf1.buffer)).not.toBe(await fullHash(buf2.buffer));
  });
});

// ---- P0.2: Scan health check blocks destructive actions ----
// Tests the REAL production path via SyncExecutor.run(), not a copied helper.

describe("P0.2 — scan health check blocks destructive actions (real executor)", () => {
  async function runWithPlan(
    planItems: SyncPlanItem[],
    failedPaths: string[],
  ) {
    const mockDeleteItem = vi.fn().mockResolvedValue(undefined);
    const mockUpsertPendingDeletes = vi.fn().mockResolvedValue(undefined);

    const mockOneDrive = makeMockOneDrive({
      deleteItem: mockDeleteItem,
    });

    const mockScanner = {
      vault: {
        adapter: makeMockAdapter(),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [] as LocalFileEntry[],
        skippedLarge: [],
        failedPaths,
        skippedCount: 0,
      }),
      scanFile: vi.fn().mockResolvedValue(null),
    } as unknown as LocalScanner;

    const mockEngine = {
      generatePlan: vi.fn().mockReturnValue({
        items: planItems,
        lastTotalFiles: 10,
        confirmed: false,
      }),
      shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
    } as unknown as SyncEngine;

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
      upsertPendingDeletes: mockUpsertPendingDeletes,
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

    const result = await executor.run("manual", {});

    return { result, mockDeleteItem, mockUpsertPendingDeletes };
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

  it("reports converted items as errors (RetryLater → errors++)", async () => {
    const { result } = await runWithPlan(
      [del("x.md"), del("y.md")],
      ["failed.txt"],
    );
    expect(result.errors).toBe(2);
    expect(result.deleted).toBe(0);
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
    expect(mockUpsertPendingDeletes).toHaveBeenCalledWith([item]);
  });

  it("does not affect non-destructive actions", async () => {
    const { result } = await runWithPlan(
      [
        { type: SyncActionType.Download, path: "b.md", remote: { path: "b.md", driveId: "id", size: 1, mtime: 1, eTag: "e", cTag: "c" } as RemoteFileEntry },
        { type: SyncActionType.SkipLargeFile, path: "big.mp4" },
      ],
      ["failed.txt"],
    );
    expect(result.errors).toBe(0);
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
      makeMockOneDrive({ downloadFile }),
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

// ---- P0.1: Download always executes (no localExists gate) ----

describe("P0.1 — Download always executes (no localExists gate)", () => {
  it("calls downloadFile and writeBinary even when local file exists", async () => {
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

    expect(mockDownloadFile).toHaveBeenCalledWith(
      "testVault",
      "test.md",
      "https://example.com/dl",
      "item123",
      16,
      undefined,
    );
    expect(mockWriteBinary).toHaveBeenCalledWith("test.md", expect.any(ArrayBuffer));
  });

  it("downloads remote version even when local file with same path exists", async () => {
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

    expect(mockDownloadFile).toHaveBeenCalled();
    expect(mockWriteBinary).toHaveBeenCalled();
  });
});

describe("Cloud baseline bootstrap safety", () => {
  it("fresh device with remote-only file downloads it instead of deleting remote", async () => {
    const deleteItem = vi.fn();
    const downloadFile = vi.fn().mockResolvedValue(new ArrayBuffer(12));
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
      uploadBaseline: vi.fn().mockResolvedValue(undefined),
      downloadFile,
      deleteItem,
      uploadFile: vi.fn(),
      initVaultDirectories: vi.fn().mockResolvedValue(undefined),
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
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
            },
            file: {},
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
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: {},
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

describe("Cloud baseline upload dedup", () => {
  function makeBaselineExecutor(dirty: boolean) {
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
      needsCloudBaselineUpload: dirty,
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

  it("skips baseline upload when the base snapshot is unchanged", async () => {
    const { executor, uploadBaseline, markCloudBaselineSynced } = makeBaselineExecutor(false);

    await executor.run("manual", {});

    expect(uploadBaseline).not.toHaveBeenCalled();
    expect(markCloudBaselineSynced).not.toHaveBeenCalled();
  });

  it("uploads and clears the dirty flag once when the base snapshot changed", async () => {
    const { executor, uploadBaseline, markCloudBaselineSynced } = makeBaselineExecutor(true);

    await executor.run("manual", {});

    expect(uploadBaseline).toHaveBeenCalledTimes(1);
    expect(markCloudBaselineSynced).toHaveBeenCalledTimes(1);
  });
});

describe("Persistent remote delta state", () => {
  async function makeMemoryState() {
    let persisted: Record<string, unknown> = {};
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
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files",
      },
      file: { hashes: { sha256Hash: hash } },
      ...overrides,
    };
  }

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
    }], "https://graph.example/delta-1");
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
            driveItem("main.js", "aa".repeat(32), {
              id: "main-id",
              parentReference: {
                path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/.obsidian/plugins/example-plugin",
              },
            }),
            driveItem("cache.json", "bb".repeat(32), {
              id: "cache-id",
              parentReference: {
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
    const hashB = "bb".repeat(32);
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
          id: "unknown-tombstone-id",
          file: undefined,
          deleted: { state: "deleted" },
        })],
        "@odata.deltaLink": "https://graph.example/delta-3",
      };
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        downloadFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
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

  it("clears an expired token cache before rebuilding from a fresh delta", async () => {
    const state = await makeMemoryState();
    await state.setRemoteState([
      {
        path: "stale.md",
        driveId: "stale-id",
        size: 1,
        mtime: 1,
        eTag: "stale-etag",
        cTag: "stale-ctag",
      },
    ], "https://graph.example/expired");
    const getDelta = vi.fn()
      .mockRejectedValueOnce(new OneDriveError(
        OneDriveErrorType.Unknown,
        "delta token expired",
        410,
      ))
      .mockResolvedValueOnce({
        value: [driveItem("fresh.md", "cc".repeat(32))],
        "@odata.deltaLink": "https://graph.example/fresh",
      });
    const fullScan = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        getDelta,
        fullScan,
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
      "https://graph.example/expired",
      undefined,
    ]);
    expect(fullScan).not.toHaveBeenCalled();
    expect(state.remoteSnapshot.map((entry) => entry.path)).toEqual(["fresh.md"]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/fresh");
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
            {
              id: "item-recording",
              name: "recording.m4a",
              size: 42534604,
              eTag: "etag-recording",
              cTag: "ctag-recording",
              lastModifiedDateTime: "2026-07-08T14:48:59.000Z",
              parentReference: {
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
    const remoteItems = paths.map((path, index) => ({
      id: `item-${index}`,
      name: path.split("/").pop()!,
      size: 16,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        path: `/drives/x/root:/Apps/EasySync/vaults/testVault/files/attachments`,
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
          value: [{
            id: "recording-id",
            name: "recording.m4a",
            size: 1024,
            eTag: "delta-etag-v2",
            cTag: "ctag",
            lastModifiedDateTime: "2026-07-10T12:00:00.000Z",
            parentReference: {
              path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/附件/录音",
            },
            file: { hashes: { sha256Hash: hash.toUpperCase() } },
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

  it("downloads at most ten candidates when remote metadata has no sha256", async () => {
    const content = new TextEncoder().encode("same attachment content").buffer;
    const hash = await fullHash(content);
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
    const remoteItems = paths.map((path, index) => ({
      id: `no-hash-${index}`,
      name: path.split("/").pop()!,
      size: content.byteLength,
      eTag: `etag-${index}`,
      cTag: `ctag-${index}`,
      parentReference: {
        path: "/drives/x/root:/Apps/EasySync/vaults/testVault/files/attachments",
      },
      file: {},
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
});

describe("Pending item batching", () => {
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
    expect(upsertPendingConflicts).toHaveBeenCalledWith(items);
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
      needsCloudBaselineUpload: false,
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
    expect(reconcilePendingIssues).toHaveBeenCalledWith([], expect.any(Set));
  });

  it("keeps completed file checkpoints but does not mark a cancelled round complete", async () => {
    let executor: SyncExecutor;
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const uploadBaseline = vi.fn().mockResolvedValue(undefined);
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
      needsCloudBaselineUpload: true,
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      setBaseSnapshot: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn(),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime,
      markCloudBaselineSynced: vi.fn().mockResolvedValue(undefined),
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
    } as unknown as StateManager;
    executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile, uploadBaseline }),
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

    // Both items enter executePlanItem before uploadFile's cancel() takes
    // effect (the hash check adds an async step). The gate is checked at
    // entry, so both proceed.
    expect(result.success).toBe(false);
    expect(result.uploaded).toBe(2);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(applyRemoteMutations).toHaveBeenCalledTimes(1);
    expect(setLastSyncTime).not.toHaveBeenCalled();
    expect(uploadBaseline).not.toHaveBeenCalled();
  });

  it("clears a reviewed plan only after the revalidated digest still matches", async () => {
    const clearPlanReview = vi.fn().mockResolvedValue(undefined);
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      needsCloudBaselineUpload: false,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      planReviewActive: true,
      planReviewDigest: planDigest([]),
      clearPlanReview,
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      markCloudBaselineSynced: vi.fn().mockResolvedValue(undefined),
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

    const result = await executor.run("manual", {}, true);

    expect(result.success).toBe(true);
    expect(clearPlanReview).toHaveBeenCalledTimes(1);
  });

  it("re-pauses a reviewed plan when the digest changed before execution", async () => {
    const clearPlanReview = vi.fn().mockResolvedValue(undefined);
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
      needsCloudBaselineUpload: false,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      planReviewActive: true,
      planReviewDigest: planDigest(reviewedPlan),
      clearPlanReview,
      upsertBaseEntries: vi.fn().mockResolvedValue(undefined),
      removeBaseEntries: vi.fn().mockResolvedValue(undefined),
      upsertPendingConflicts: vi.fn().mockResolvedValue(undefined),
      prunePendingConflicts: vi.fn().mockResolvedValue(undefined),
      upsertPendingDeletes: vi.fn().mockResolvedValue(undefined),
      prunePendingDeletes: vi.fn().mockResolvedValue(undefined),
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      markCloudBaselineSynced: vi.fn().mockResolvedValue(undefined),
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

    const result = await executor.run("manual", { onConfirmThreshold }, true);

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.pausedForReview");
    expect(onConfirmThreshold).toHaveBeenCalledTimes(1);
    expect(clearPlanReview).not.toHaveBeenCalled();
  });

  it("records upload hash drift as a pending issue instead of silently dropping it", async () => {
    const original = new TextEncoder().encode("same").buffer;
    const changed = new TextEncoder().encode("changed").buffer;
    const originalHash = await fullHash(original);
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
      needsCloudBaselineUpload: false,
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
      markCloudBaselineSynced: vi.fn().mockResolvedValue(undefined),
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
    expect(result.errors).toBe(1);
    expect(reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({ path: "note.md", actionType: SyncActionType.Upload })],
      expect.any(Set),
    );
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
        needsCloudBaselineUpload: false,
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
        markCloudBaselineSynced: vi.fn().mockResolvedValue(undefined),
        lastSyncTime: 0,
      } as unknown as StateManager,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(1);
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
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile: vi.fn().mockRejectedValue(
          new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
        ),
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
          items: [{ type: SyncActionType.Upload, path: local.path, local, baseEtag: "etag-old" }],
          lastTotalFiles: 1,
          confirmed: false,
        }),
        shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
      } as unknown as SyncEngine,
      {
        ...remoteStateStub(),
        baseSnapshot: [{ path: local.path, hash: "00".repeat(32), size: local.size, eTag: "etag-old" }],
        needsCloudBaselineUpload: false,
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
      expect.objectContaining({ path: local.path, sha256Hash: local.hash, eTag: "etag-remote" }),
    ], []);
  });

  it("queues a pending conflict when a local file changes again before download writes", async () => {
    const scannedContent = new TextEncoder().encode("scanned");
    const localNowContent = new TextEncoder().encode("local-now");
    const remoteContent = new TextEncoder().encode("remote-now");
    const scannedHash = await fullHash(scannedContent.buffer);
    const localNowHash = await fullHash(localNowContent.buffer);
    const remoteHash = await fullHash(remoteContent.buffer);
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
        needsCloudBaselineUpload: false,
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

  it("queues a pending conflict when remote changes before DeleteRemote executes", async () => {
    const addPendingConflict = vi.fn().mockResolvedValue(undefined);
    const applyRemoteMutations = vi.fn().mockResolvedValue(undefined);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        deleteItem: vi.fn().mockRejectedValue(
          new OneDriveError(OneDriveErrorType.PreconditionFailed, "etag changed", 412),
        ),
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
        needsCloudBaselineUpload: false,
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
    expect(addPendingConflict).toHaveBeenCalledWith({
      type: SyncActionType.Conflict,
      path: "deleted.md",
      remote: {
        path: "deleted.md",
        driveId: "remote-id",
        downloadUrl: "https://download.example/deleted.md",
        size: 12,
        mtime: 7,
        eTag: "etag-new",
        cTag: "",
        sha256Hash: "bb".repeat(32),
      },
      reason: "reason.localDeletedRemoteModified",
    });
    expect(applyRemoteMutations).toHaveBeenCalledWith([
      {
        path: "deleted.md",
        driveId: "remote-id",
        downloadUrl: "https://download.example/deleted.md",
        size: 12,
        mtime: 7,
        eTag: "etag-new",
        cTag: "",
        sha256Hash: "bb".repeat(32),
      },
    ], []);
  });
});

describe("Bounded small-file upload concurrency", () => {
  it("runs up to five small uploads while large and small uploads run in separate concurrent pools", async () => {
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
      return { eTag: `etag:${path}` };
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
    // Small (5) and large (2) pools overlap — peak must account for both.
    expect(peakUploads).toBeGreaterThanOrEqual(6);
    // large.bin starts in its own pool concurrently with small uploads.
    expect(events).toContain("start:large.bin");
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
    it(`protected config ${path} missing remotely stays a conflict instead of a delete prompt`, () => {
      const plan = engine.generatePlan(
        [localEntry(path, { hash: "same".repeat(16), size: 850 })],
        [],
        [baseEntry(path, { hash: "same".repeat(16), size: 850, eTag: "etag-app" })],
        [],
      );

      expect(plan.items).toContainEqual(expect.objectContaining({
        type: SyncActionType.Conflict,
        path,
        reason: "reason.fileDeletedFromRemote",
      }));
      expect(plan.items.some((item) =>
        item.type === SyncActionType.ConfirmLocalDelete && item.path === path,
      )).toBe(false);
    });

    it(`protected config ${path} missing locally stays a conflict instead of deleting remote immediately`, () => {
      const plan = engine.generatePlan(
        [],
        [remoteEntry(path, { size: 850, eTag: "etag-app" })],
        [baseEntry(path, { hash: "same".repeat(16), size: 850, eTag: "etag-app" })],
        [],
      );

      expect(plan.items).toContainEqual(expect.objectContaining({
        type: SyncActionType.Conflict,
        path,
        reason: "reason.fileDeletedLocally",
      }));
      expect(plan.items.some((item) =>
        item.type === SyncActionType.DeleteRemote && item.path === path,
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

  it("cross-directory rename is NOT matched (falls through to Upload + DeleteRemote)", () => {
    const plan = engine.generatePlan(
      [localEntry("sub/new.md", "abc123")],
      [remoteEntry("old.md")],
      [baseEntry("old.md", "abc123")],
      [],
    );

    const actions = plan.items.map((i) => ({ type: i.type, path: i.path }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.Upload, path: "sub/new.md" }));
    expect(actions).toContainEqual(expect.objectContaining({ type: SyncActionType.DeleteRemote, path: "old.md" }));
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

  it("copy (same hash on two new files) is NOT matched as rename", () => {
    const hash = "abc123";
    const plan = engine.generatePlan(
      [localEntry("copy1.md", hash), localEntry("copy2.md", hash)],
      [remoteEntry("old.md")],
      [baseEntry("old.md", hash)],
      [],
    );

    const uploads = plan.items.filter((i) => i.type === SyncActionType.Upload);
    expect(uploads).toHaveLength(2);
    expect(plan.items.some((i) => i.type === SyncActionType.DeleteRemote && i.path === "old.md")).toBe(true);
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
    onProgressUpdate?: () => void;
    progressStore?: SyncProgressStore;
  }): SyncExecutor {
    const progressStore = options.progressStore ?? new SyncProgressStore();
    const mockState = {
      ...remoteStateStub(),
      baseSnapshot: [],
      pendingConflicts: options.pendingConflicts ?? [],
      pendingRemoteDeletes: options.pendingRemoteDeletes ?? [],
      updateBaseEntry: vi.fn().mockResolvedValue(undefined),
      removeBaseEntry: vi.fn().mockResolvedValue(undefined),
      removePendingConflict: vi.fn().mockResolvedValue(undefined),
      removePendingDelete: vi.fn().mockResolvedValue(undefined),
      applyRemoteMutations: vi.fn().mockResolvedValue(undefined),
      cacheBaseContent: vi.fn(),
    } as unknown as StateManager;

    return new SyncExecutor(
      makeMockOneDrive({
        downloadFile: options.downloadFile,
        uploadFile: options.uploadFile,
      }),
      {
        vault: {
          adapter: makeMockAdapter(options.adapterOverrides),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
          getFileByPath: vi.fn().mockReturnValue(null),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
      } as unknown as LocalScanner,
      {} as SyncEngine,
      mockState,
      "testVault",
      undefined,
      progressStore,
      undefined,
      true,
      undefined,
      options.onProgressUpdate,
    );
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
    expect(snapshots.some((snapshot) =>
      snapshot.currentItemBytes === 4 && snapshot.currentItemTotalBytes === 10,
    )).toBe(true);
    await waitUntil(() => {
      expect(progressStore.state.phase).toBe("done");
    });
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
          return { eTag: "uploaded-etag" };
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
    expect(snapshots.some((snapshot) =>
      snapshot.currentItemBytes === 5 && snapshot.currentItemTotalBytes === local.size,
    )).toBe(true);
    await waitUntil(() => {
      expect(progressStore.state.phase).toBe("done");
    });
  });

  it("keepRemote accepts a remote-side deletion conflict by deleting the local file", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
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
    });

    await executor.resolveConflictKeepRemote(".obsidian/app.json");

    expect(remove).toHaveBeenCalledWith(".obsidian/app.json");
  });

  it("queues repeated item actions so later clicks do not fail behind the first transfer", async () => {
    let resolveFirstUpload: ((value: { eTag: string }) => void) | null = null;
    const startedPaths: string[] = [];
    const uploadFile = vi.fn().mockImplementation(
      (_vaultName: string, path: string) => {
        startedPaths.push(path);
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
    });

    const firstQueued = executor.resolveConflictKeepLocal("a.md");
    const secondQueued = executor.resolveConflictKeepLocal("b.md");
    let enqueued = false;
    void Promise.all([firstQueued, secondQueued]).then(() => {
      enqueued = true;
    });

    await waitUntil(() => {
      expect(enqueued).toBe(true);
      expect(executor.isSideActionQueued("a.md")).toBe(true);
      expect(executor.isSideActionQueued("b.md")).toBe(true);
      expect(startedPaths).toEqual(["a.md"]);
    });

    resolveFirstUpload?.({ eTag: "etag-a-new" });
    await waitUntil(() => {
      expect(startedPaths).toEqual(["a.md", "b.md"]);
      expect(executor.isSideActionQueued("a.md")).toBe(false);
      expect(executor.isSideActionQueued("b.md")).toBe(false);
    });
  });
});
