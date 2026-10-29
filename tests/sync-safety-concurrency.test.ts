// 并发闸与预算
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

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

describe("Bounded small-file upload concurrency", () => {
  it("checkpoints each independent small-upload batch after every receipt is durable", async () => {
    const smallContent = new ArrayBuffer(8);
    const smallHash = await sha256Hex(smallContent);
    const largeContent = new Uint8Array(9 * 1024 * 1024).fill(1).buffer;
    const largeHash = await sha256Hex(largeContent);
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
      if (path === "large.bin") onProgress?.(largeContent.byteLength, largeContent.byteLength);
      events.push(`end:${path}`);
      activeUploads--;
      return {
        id: `id:${path}`,
        eTag: `etag:${path}`,
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      };
    });
    const smallEntries = Array.from({ length: 8 }, (_, index): LocalFileEntry => ({
      path: `small-${index}.md`,
      hash: smallHash,
      size: smallContent.byteLength,
      mtime: index,
      binary: false,
    }));
    const largeEntry: LocalFileEntry = {
      path: "large.bin",
      hash: largeHash,
      size: largeContent.byteLength,
      mtime: 99,
      binary: true,
    };
    const localEntries = [...smallEntries, largeEntry];
    const state = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn(async (path: string) =>
              path === largeEntry.path ? largeContent : smallContent),
          }),
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
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          localEntries.find((entry) => entry.path === path) ?? null),
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localEntries.find((candidate) => candidate.path === path);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
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
      logicalBytes: largeContent.byteLength + smallContent.byteLength * smallEntries.length,
      peakConcurrency: 3,
    });
    expect(result.metrics?.mutationPersistence).toMatchObject({
      intentWrites: 9,
      receiptWrites: 9,
      checkpointOperations: 9,
      // One shared checkpoint per persistence batch: the eight small uploads
      // are one batch (desktop 8) and the large upload keeps its own per-file
      // checkpoint. The old concurrency-derived wave paid five.
      checkpointCommits: 2,
      checkpointFailures: 0,
    });
    expect(
      result.metrics?.mutationPersistence.stagesMs.checkpointTotal,
    ).toBeGreaterThanOrEqual(0);
    expect(peakUploads).toBe(3);
    expect(events.indexOf("start:large.bin")).toBeGreaterThan(events.indexOf("end:small-7.md"));
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toHaveLength(localEntries.length);
    expect(state.baseSnapshot).toHaveLength(localEntries.length);
  });

  it("keeps every durable receipt when a shared upload checkpoint cannot commit", async () => {
    const content = new ArrayBuffer(8);
    const hash = await sha256Hex(content);
    const localEntries = ["first.md", "second.md"].map(
      (path, index): LocalFileEntry => ({
        path,
        hash,
        size: content.byteLength,
        mtime: index + 1,
        binary: false,
      }),
    );
    const uploadFile = vi.fn().mockImplementation(async (
      _vault: string,
      path: string,
    ) => ({
      id: `id:${path}`,
      eTag: `etag:${path}`,
      parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
    }));
    const state = makeActiveV2State([], []);
    const commitMutationCheckpoints = vi.fn().mockRejectedValue(
      new Error("shared checkpoint failed"),
    );
    state.commitMutationCheckpoints = commitMutationCheckpoints;
    const onFileComplete = vi.fn();
    const onFileReverted = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({ uploadFile }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockResolvedValue(content),
          }),
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
        scanFile: vi.fn().mockImplementation(async (path: string) =>
          localEntries.find((entry) => entry.path === path) ?? null),
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const entry = localEntries.find((candidate) => candidate.path === path);
          return entry ? { status: "present", entry } : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", { onFileComplete, onFileReverted });

    expect(result.success).toBe(false);
    expect(result.uploaded).toBe(2);
    expect(result.errors).toBe(1);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(commitMutationCheckpoints).toHaveBeenCalledTimes(2);
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(2);
    expect(state.mutationLedger.every((record) => record.receipt !== null)).toBe(true);
    expect(result.metrics?.mutationPersistence).toMatchObject({
      intentWrites: 2,
      receiptWrites: 2,
      checkpointOperations: 0,
      checkpointCommits: 0,
      checkpointFailures: 2,
    });
    // 2026-10-26: each member reports its own row as its PUT and receipt land,
    // so the user sees progress inside the batch. When the shared checkpoint
    // then fails, those rows are flipped to failed with the checkpoint's
    // reason — the success is corrected, not duplicated and not left standing.
    expect(onFileComplete).toHaveBeenCalledTimes(2);
    expect(onFileComplete.mock.calls.every((call) => call[2] === true)).toBe(true);
    expect(onFileReverted).toHaveBeenCalledTimes(2);
    expect(onFileReverted.mock.calls.map((call) => call[0]).sort()).toEqual([
      "first.md",
      "second.md",
    ]);
    expect(onFileReverted.mock.calls.every((call) => call[1] === "shared checkpoint failed"))
      .toBe(true);
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

    await Promise.all(["a.md", "b.md", "c.md"].map((path) =>
      state.addPendingConflict({ type: SyncActionType.Conflict, path })
    ));

    expect(peakSaves).toBe(1);
    expect(state.pendingConflicts.map((entry) => entry.path).sort()).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });
});

describe("Conservative desktop small-file download concurrency", () => {
  it("reports the downloaded version size instead of the overwritten local size", async () => {
    const path = "changed-remotely.md";
    const localBytes = new Uint8Array([1, 2, 3]).buffer;
    const remoteBytes = new Uint8Array([4, 5, 6, 7, 8]).buffer;
    const localHash = await sha256Hex(localBytes);
    const remoteHash = await sha256Hex(remoteBytes);
    const local: LocalFileEntry = {
      path,
      size: localBytes.byteLength,
      mtime: 1,
      hash: localHash,
      binary: true,
    };
    const remote: RemoteFileEntry = {
      path,
      driveId: "remote-changed",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: remoteBytes.byteLength,
      mtime: 2,
      eTag: "etag-new",
      cTag: "ctag-new",
      sha256Hash: remoteHash,
    };
    const base: BaseFileEntry = {
      path,
      size: localBytes.byteLength,
      hash: localHash,
      eTag: "etag-old",
    };
    const localStore = makeDownloadLocalStore();
    localStore.files.set(path, localBytes.slice(0));
    const state = makeActiveV2State([remote], [base]);
    const onFileComplete = vi.fn();
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile: vi.fn().mockResolvedValue(remoteBytes.slice(0)),
        hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
      }),
      {
        vault: {
          adapter: localStore.adapter,
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
        inspectFile: localStore.inspectFile,
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    const result = await executor.run("manual", { onFileComplete });

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.metrics?.fileTransfers.download.logicalBytes).toBe(remoteBytes.byteLength);
    expect(onFileComplete).toHaveBeenCalledWith(
      path,
      SyncActionType.Download,
      true,
      undefined,
      remoteBytes.byteLength,
    );
    expect(state.baseSnapshot).toContainEqual(expect.objectContaining({
      path,
      size: remoteBytes.byteLength,
      hash: remoteHash,
      eTag: remote.eTag,
    }));
    expect(await sha256Hex(localStore.files.get(path)!)).toBe(remoteHash);
  });

  it("overlaps only network prefetch while local writes stay serial", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = false;
    Platform.isMobileApp = false;
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
      const remoteEntries = Array.from({ length: 9 }, (_, index): RemoteFileEntry => ({
        path: `download-${index}.bin`,
        driveId: `remote-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `etag-${index}`,
        cTag: `ctag-${index}`,
        sha256Hash: hash,
      }));
      const localStore = makeDownloadLocalStore(writeBinary);
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
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
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      // The policy may conservatively remain at 2 when real test-clock
      // throughput drops. Deterministic 1 -> 2 -> 3 promotion is covered by
      // download-concurrency-policy.test.ts; this integration contract only
      // requires actual overlap, the hard cap, and serial local commits.
      expect(peakDownloads).toBeGreaterThanOrEqual(2);
      expect(peakDownloads).toBeLessThanOrEqual(3);
      expect(peakWrites).toBe(1);
      expect(result.metrics?.fileTransfers.download).toMatchObject({
        started: remoteEntries.length,
        succeeded: remoteEntries.length,
        failed: 0,
        peakConcurrency: peakDownloads,
      });
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
      expect(localStore.files.size).toBe(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });

  it("A2 — overlaps read-only download prefetch on mobile while local writes stay serial and capped at two", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = true;
    Platform.isMobileApp = true;
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
      const remoteEntries = Array.from({ length: 9 }, (_, index): RemoteFileEntry => ({
        path: `mobile-download-${index}.bin`,
        driveId: `mobile-remote-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `mobile-etag-${index}`,
        cTag: `mobile-ctag-${index}`,
        sha256Hash: hash,
      }));
      const localStore = makeDownloadLocalStore(writeBinary);
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
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
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      // A2 contract: mobile downloads overlap read-only content GETs up to
      // the mobile ceiling (2) — never beyond it — while every local write
      // stays strictly serial.
      expect(peakDownloads).toBeGreaterThanOrEqual(2);
      expect(peakDownloads).toBeLessThanOrEqual(2);
      expect(peakWrites).toBe(1);
      expect(result.metrics?.fileTransfers.download).toMatchObject({
        started: remoteEntries.length,
        succeeded: remoteEntries.length,
        failed: 0,
        peakConcurrency: peakDownloads,
      });
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
      expect(localStore.files.size).toBe(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });

  it("batches missing download URLs and hashless version checks without weakening verification", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = false;
    Platform.isMobileApp = false;
    try {
      const buffer = new Uint8Array(256 * 1024).fill(9).buffer;
      const hash = await sha256Hex(buffer);
      const remoteEntries = Array.from({ length: 6 }, (_, index): RemoteFileEntry => ({
        path: `metadata-batch-${index}.bin`,
        driveId: `metadata-id-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `metadata-etag-${index}`,
        cTag: `metadata-ctag-${index}`,
        ...(index < 2 ? { sha256Hash: hash } : {}),
      }));
      const remoteById = new Map(remoteEntries.map((entry) => [entry.driveId, entry]));
      const getDriveItemMetadataByIds = vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => {
          const remote = remoteById.get(id)!;
          return [id, {
            id,
            name: remote.path,
            size: remote.size,
            eTag: remote.eTag,
            cTag: remote.cTag,
            file: {},
            parentReference: { id: remote.parentId },
            "@microsoft.graph.downloadUrl": `https://download.example/${id}`,
          }];
        })),
      );
      const downloadFile = vi.fn().mockResolvedValue(buffer.slice(0));
      const localStore = makeDownloadLocalStore();
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          getDriveItemMetadataByIds,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
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
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      // Contract: regardless of how the adaptive policy splits batches under
      // load, every entry lacking a downloadUrl is refreshed through the batch
      // metadata endpoint, and every hashless download is version-verified
      // against the current remote ID/eTag. Assert coverage, not batch shape.
      const refreshedIds = getDriveItemMetadataByIds.mock.calls
        .filter((call) => call[1] === "downloadUrlRefresh")
        .flatMap((call) => call[0]);
      expect([...refreshedIds].sort()).toEqual(
        remoteEntries.map((entry) => entry.driveId).sort(),
      );
      const verifiedIds = getDriveItemMetadataByIds.mock.calls
        .filter((call) => call[1] === "downloadVersionVerify")
        .flatMap((call) => call[0]);
      expect([...verifiedIds].sort()).toEqual(
        remoteEntries.filter((entry) => !entry.sha256Hash)
          .map((entry) => entry.driveId).sort(),
      );
      expect(getDriveItemMetadataByIds.mock.calls.every((call) =>
        call[1] === "downloadUrlRefresh" || call[1] === "downloadVersionVerify",
      )).toBe(true);
      expect(downloadFile.mock.calls.every((call) =>
        typeof call[2] === "string" && call[2].startsWith("https://download.example/"),
      )).toBe(true);
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });

  it("returns to serial after the download path reports degradation", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = false;
    Platform.isMobileApp = false;
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
      const remoteEntries = Array.from({ length: 7 }, (_, index): RemoteFileEntry => ({
        path: `degraded-${index}.bin`,
        driveId: `degraded-id-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `degraded-etag-${index}`,
        cTag: "",
        sha256Hash: hash,
      }));
      const localStore = makeDownloadLocalStore();
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          hasDegradedDownloadPathThisRound: batchHealth,
        }),
        {
          vault: {
            adapter: localStore.adapter,
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
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      expect(peak).toBe(2);
      expect(batchHealth).toHaveBeenCalledTimes(6);
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
      expect(localStore.files.size).toBe(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });
});

describe("B② large upload cross-file concurrency", () => {
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // The pool classifier routes on the entry's size field only; the upload
  // path itself hashes whatever readBinary returns, so a small body with a
  // >8 MiB size field models a large file without paying an 8 MiB hash.
  async function makeLargeLocalEntry(path: string): Promise<LocalFileEntry> {
    const content = new Uint8Array(1024).fill(9).buffer;
    return {
      path,
      hash: await sha256Hex(content),
      size: 8 * 1024 * 1024 + 1,
      mtime: 2,
      binary: false,
    };
  }

  function makeLargeUploadExecutor(
    entries: LocalFileEntry[],
    contents: Map<string, ArrayBuffer>,
    uploadFile: ReturnType<typeof vi.fn>,
  ): { executor: SyncExecutor; state: StateManager } {
    const state = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(undefined),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn(async (path: string) => {
              const content = contents.get(path);
              if (content === undefined) throw new Error(`no content for ${path}`);
              return content;
            }),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries,
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (target: string) => {
          const entry = entries.find((candidate) => candidate.path === target);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    return { executor, state };
  }

  it("starts a second large upload before the first finishes (desktop)", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = false;
    Platform.isMobileApp = false;
    try {
      const content = new Uint8Array(1024).fill(9).buffer;
      const entryA = await makeLargeLocalEntry("large-a.bin");
      const entryB = await makeLargeLocalEntry("large-b.bin");
      const started: string[] = [];
      let activeUploads = 0;
      let peakConcurrentUploads = 0;
      const releases: Array<() => void> = [];
      const uploadFile = vi.fn(async (_vault: string, path: string) => {
        started.push(path);
        activeUploads++;
        peakConcurrentUploads = Math.max(peakConcurrentUploads, activeUploads);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeUploads--;
        return { id: `upload-${path}`, eTag: "new-upload-etag", cTag: "new-upload-ctag" };
      });
      const { executor } = makeLargeUploadExecutor(
        [entryA, entryB],
        new Map([["large-a.bin", content], ["large-b.bin", content]]),
        uploadFile,
      );

      const runPromise = executor.run("manual", {});
      await vi.waitFor(() => expect(started.length).toBe(2));
      expect(peakConcurrentUploads).toBe(2);
      releases.forEach((release) => release());
      const result = await runPromise;

      expect(result.uploaded).toBe(2);
      expect(result.errors).toBe(0);
      expect(result.metrics?.peakUploads).toBe(2);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });

  it("keeps the sibling upload and per-file checkpoints alive when one large upload fails (desktop)", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = false;
    Platform.isMobileApp = false;
    try {
      const content = new Uint8Array(1024).fill(9).buffer;
      const entryA = await makeLargeLocalEntry("large-fail-a.bin");
      const entryB = await makeLargeLocalEntry("large-fail-b.bin");
      const started: string[] = [];
      const releases: Array<() => void> = [];
      const uploadFile = vi.fn(async (_vault: string, path: string) => {
        started.push(path);
        await new Promise<void>((resolve) => releases.push(resolve));
        if (path === "large-fail-a.bin") {
          throw new OneDriveError(
            "upload session chunk failed",
            OneDriveErrorType.NetworkError,
          );
        }
        return { id: `upload-${path}`, eTag: "new-upload-etag", cTag: "new-upload-ctag" };
      });
      const { executor, state } = makeLargeUploadExecutor(
        [entryA, entryB],
        new Map([["large-fail-a.bin", content], ["large-fail-b.bin", content]]),
        uploadFile,
      );

      const runPromise = executor.run("manual", {});
      await vi.waitFor(() => expect(started.length).toBe(2));
      releases.forEach((release) => release());
      const result = await runPromise;

      expect(result.uploaded).toBe(1);
      expect(result.errors).toBe(1);
      expect(uploadFile).toHaveBeenCalledTimes(2);
      expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });

  it("keeps mobile large uploads strictly serial", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = true;
    Platform.isMobileApp = true;
    try {
      const content = new Uint8Array(1024).fill(9).buffer;
      const entryA = await makeLargeLocalEntry("large-m-a.bin");
      const entryB = await makeLargeLocalEntry("large-m-b.bin");
      const started: string[] = [];
      let releaseA!: () => void;
      const releasedA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const uploadFile = vi.fn(async (_vault: string, path: string) => {
        started.push(path);
        if (path === "large-m-a.bin") await releasedA;
        return { id: `upload-${path}`, eTag: "new-upload-etag", cTag: "new-upload-ctag" };
      });
      const { executor } = makeLargeUploadExecutor(
        [entryA, entryB],
        new Map([["large-m-a.bin", content], ["large-m-b.bin", content]]),
        uploadFile,
      );

      const runPromise = executor.run("manual", {});
      await vi.waitFor(() => expect(started.length).toBe(1));
      await sleep(50);
      expect(started).toEqual(["large-m-a.bin"]);
      releaseA();
      const result = await runPromise;

      expect(result.uploaded).toBe(2);
      expect(result.errors).toBe(0);
      expect(result.metrics?.peakUploads).toBe(1);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });
});

