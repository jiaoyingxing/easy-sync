// 云端基线、下载完整性与失败隔离
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

describe("Cloud baseline bootstrap safety", () => {
  it("accepts a V1 cloud baseline only when exact content or its bound remote version matches", () => {
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {} as LocalScanner,
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
      path: "note.md", driveId: "id", size: 4, mtime: 1, eTag: "old", cTag: "c",
    };

    expect(seed(json, local, [remote])).toEqual([{
      path: "note.md", hash: "aa".repeat(32), size: 4, eTag: "old",
    }]);
    expect(seed(json, local, [{
      ...remote,
      eTag: "current",
      quickXorHash: "same-quickxor-is-not-exact-proof",
    }])).toEqual([]);
    expect(seed(json, local, [{
      ...remote,
      eTag: "current",
      sha256Hash: "bb".repeat(32),
    }])).toEqual([]);
    expect(seed(json, local, [{
      ...remote,
      eTag: "current",
      sha256Hash: "aa".repeat(32),
    }])).toEqual([{
      path: "note.md", hash: "aa".repeat(32), size: 4, eTag: "current",
    }]);
  });

  it("persists and consumes a V2 cTag-bound cloud bootstrap before canonical planning", async () => {
    const path = "note.md";
    const content = new TextEncoder().encode("same V2 bootstrap content").buffer;
    const hash = await sha256Hex(content);
    const downloadFile = vi.fn().mockResolvedValue(content);
    const downloadBaseline = vi.fn().mockResolvedValue(null);
    const syncScope = {
      accountId: "account-id",
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };
    const bootstrap = JSON.stringify({
      schemaVersion: 2,
      scope: syncScope,
      revision: 1,
      sourceCommitSeq: 1,
      generatedAt: 1,
      anchors: [{
        remoteId: "note-id",
        lastPath: path,
        contentHash: hash,
        size: content.byteLength,
        remoteETag: "etag-v2",
        remoteCTag: "ctag-v2",
      }],
    });
    const mockState = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({
        readCloudBootstrapV2: vi.fn().mockResolvedValue({
          id: "bootstrap-id",
          eTag: "bootstrap-etag",
          content: bootstrap,
        }),
        downloadBaseline,
        downloadFile,
        getDelta: vi.fn().mockResolvedValue({
          value: [{
            id: "note-id",
            name: path,
            size: content.byteLength,
            eTag: "etag-v2",
            cTag: "ctag-v2",
            parentReference: { id: syncScope.filesRootId },
            file: {
              hashes: {
                quickXorHash: "provider-quickxor",
              },
            },
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
            path,
            size: content.byteLength,
            mtime: 1,
            hash,
            quickXorHash: "provider-quickxor",
            binary: false,
          }],
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
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result).toMatchObject({ success: true, downloaded: 0, conflicts: 0 });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(downloadBaseline).not.toHaveBeenCalled();
    expect(mockState.baseSnapshot).toEqual([{
      path,
      hash,
      size: content.byteLength,
      eTag: "etag-v2",
    }]);
  });

  it("active V2 with a remote-only file downloads it without legacy baseline fallback", async () => {
    const deleteItem = vi.fn();
    const downloaded = new ArrayBuffer(12);
    const downloadedHash = await sha256Hex(downloaded);
    const downloadFile = vi.fn().mockResolvedValue(downloaded);
    const downloadBaseline = vi.fn().mockResolvedValue(JSON.stringify({
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
    }));
    const files = new Map<string, ArrayBuffer>();
    const writeBinary = vi.fn(async (target: string, content: ArrayBuffer) => {
      files.set(target, content.slice(0));
    });
    const adapter = makeMockAdapter({
      writeBinary,
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
        files.set(target, value);
        files.delete(source);
      }),
      remove: vi.fn().mockImplementation(async (target: string) => {
        files.delete(target);
      }),
    });

    const mockOneDrive = makeMockOneDrive({
      downloadBaseline,
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
        adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [] as LocalFileEntry[],
        folders: [],
        folderScanComplete: true,
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
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner;

    const mockState = makeActiveV2State([], []);

    const executor = new SyncExecutor(
      mockOneDrive,
      mockScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(1);
    expect(downloadBaseline).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
    expect(downloadFile).toHaveBeenCalledWith(
      "testVault",
      "note.md",
      undefined,
      "item-note",
      12,
      expect.anything(),
    );
    expect(writeBinary).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/note.md.part.ready`,
      expect.any(ArrayBuffer),
    );
    expect(adapter.rename).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/note.md.part.ready`,
      "note.md",
    );
    expect(await sha256Hex(files.get("note.md")!)).toBe(downloadedHash);
  });

  it.each([
    {
      name: "rewrites an Android temp file in place when its first creation is empty",
      emptyWrites: 1,
      expectedWrites: 2,
      succeeds: true,
      android: true,
      mobile: true,
      writeFails: false,
      corruptWrites: 0,
    },
    {
      name: "fails closed after three Android temp rewrites still verify empty",
      emptyWrites: 3,
      expectedWrites: 3,
      succeeds: false,
      android: true,
      mobile: true,
      writeFails: false,
      corruptWrites: 0,
    },
    {
      name: "does not retry an Android writeBinary exception",
      emptyWrites: 0,
      expectedWrites: 1,
      succeeds: false,
      android: true,
      mobile: true,
      writeFails: true,
      corruptWrites: 0,
    },
    {
      name: "does not retry a non-empty Android hash mismatch",
      emptyWrites: 0,
      expectedWrites: 1,
      succeeds: false,
      android: true,
      mobile: true,
      writeFails: false,
      corruptWrites: 1,
    },
    {
      name: "does not broaden the Android rewrite workaround to iOS",
      emptyWrites: 1,
      expectedWrites: 1,
      succeeds: false,
      android: false,
      mobile: true,
      writeFails: false,
      corruptWrites: 0,
    },
    {
      name: "does not broaden the Android rewrite workaround to desktop",
      emptyWrites: 1,
      expectedWrites: 1,
      succeeds: false,
      android: false,
      mobile: false,
      writeFails: false,
      corruptWrites: 0,
    },
  ])("$name", async ({
    android,
    mobile,
    emptyWrites,
    expectedWrites,
    succeeds,
    writeFails,
    corruptWrites,
  }) => {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    const previousAndroid = Platform.isAndroidApp;
    Platform.isMobile = mobile;
    Platform.isDesktop = !mobile;
    Platform.isAndroidApp = android;
    const path = "android-retry.md";
    const readyPath = `${EASY_SYNC_TMP_DIR}/downloads/android-retry.md.part.ready`;
    const downloaded = new TextEncoder().encode("android temp retry").buffer;
    const downloadedHash = await sha256Hex(downloaded);
    const files = new Map<string, ArrayBuffer>();
    let readyWrites = 0;
    const writeBinary = vi.fn(async (target: string, content: ArrayBuffer) => {
      readyWrites++;
      if (writeFails && readyWrites === 1) throw new Error("writeBinary failed");
      if (readyWrites <= emptyWrites) {
        files.set(target, new ArrayBuffer(0));
      } else if (readyWrites <= emptyWrites + corruptWrites) {
        const corrupted = new Uint8Array(content.slice(0));
        corrupted[0] ^= 0xff;
        files.set(target, corrupted.buffer);
      } else {
        files.set(target, content.slice(0));
      }
    });
    const rename = vi.fn(async (source: string, target: string) => {
      const content = files.get(source);
      if (!content) throw new Error(`missing ${source}`);
      files.set(target, content);
      files.delete(source);
    });
    const adapter = makeMockAdapter({
      writeBinary,
      rename,
      exists: vi.fn(async (target: string) => files.has(target)),
      stat: vi.fn(async (target: string) => {
        const content = files.get(target);
        return content ? { size: content.byteLength, mtime: 1 } : null;
      }),
      readBinary: vi.fn(async (target: string) => {
        const content = files.get(target);
        if (!content) throw new Error(`missing ${target}`);
        return content.slice(0);
      }),
      remove: vi.fn(async (target: string) => {
        files.delete(target);
      }),
    });
    const remote: RemoteFileEntry = {
      path,
      driveId: "android-retry-id",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: downloaded.byteLength,
      mtime: 1,
      eTag: "android-retry-etag",
      cTag: "android-retry-ctag",
      sha256Hash: downloadedHash,
    };
    const state = makeActiveV2State([remote], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile: vi.fn().mockResolvedValue(downloaded) }),
      {
        vault: {
          adapter,
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
        inspectFile: vi.fn(async (target: string) => {
          const content = files.get(target);
          return content
            ? {
              status: "present",
              entry: {
                path: target,
                hash: await sha256Hex(content),
                size: content.byteLength,
                mtime: 1,
                binary: false,
              },
            }
            : { status: "missing" };
        }),
        getMaxFileSize: vi.fn().mockReturnValue(100 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );

    try {
      const result = await executor.run("manual", {});

      expect(result).toMatchObject(succeeds
        ? { success: true, downloaded: 1, errors: 0 }
        : { success: false, downloaded: 0, errors: 1 });
      expect(writeBinary).toHaveBeenCalledTimes(expectedWrites);
      expect(writeBinary).toHaveBeenNthCalledWith(1, readyPath, downloaded);
      if (succeeds) {
        expect(writeBinary).toHaveBeenNthCalledWith(2, readyPath, downloaded);
        expect(rename).toHaveBeenCalledWith(readyPath, path);
        expect(await sha256Hex(files.get(path)!)).toBe(downloadedHash);
        expect(state.commitMutationCheckpoint).toHaveBeenCalledTimes(1);
        expect(state.baseSnapshot).toEqual([
          expect.objectContaining({ path, hash: downloadedHash, size: downloaded.byteLength }),
        ]);
      } else {
        expect(rename).not.toHaveBeenCalled();
        expect(files.has(path)).toBe(false);
        expect(files.has(readyPath)).toBe(false);
        expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();
        expect(state.baseSnapshot).toEqual([]);
        expect(state.abandonMutationIntent).toHaveBeenCalledTimes(1);
      }
      expect(state.mutationLedger).toEqual([]);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
      Platform.isAndroidApp = previousAndroid;
    }
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
    const mockState = makeActiveV2State([], []);
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
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    try {
      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(1);
      expect(downloadFileToPath).toHaveBeenCalledWith(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        expect.any(Object),
        undefined,
        "item-recording",
        size,
        hash,
        expect.anything(),
      );
      expect(downloadFile).not.toHaveBeenCalled();
      expect(rename).toHaveBeenCalledWith(
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
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
    const files = new Map<string, ArrayBuffer>();
    const writeBinary = vi.fn(async (target: string, value: ArrayBuffer) => {
      files.set(target, value.slice(0));
    });
    const adapter = makeMockAdapter({
      writeBinary,
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
        files.set(target, value);
        files.delete(source);
      }),
      remove: vi.fn().mockImplementation(async (target: string) => {
        files.delete(target);
      }),
    });
    const setLastSyncTime = vi.fn().mockResolvedValue(undefined);
    const reconcilePendingIssues = vi.fn().mockResolvedValue(undefined);
    const mockState = makeActiveV2State([], [], {
      reconcilePendingIssues,
      setLastSyncTime,
    });
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
          adapter,
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
        scanFile: vi.fn().mockImplementation(async (path: string) => {
          const value = files.get(path);
          return value
            ? {
              path,
              size: value.byteLength,
              mtime: 1,
              hash: await sha256Hex(value),
              binary: false,
            }
            : null;
        }),
        inspectFile: vi.fn().mockImplementation(async (path: string) => {
          const value = files.get(path);
          return value
            ? {
              status: "present",
              entry: {
                path,
                size: value.byteLength,
                mtime: 1,
                hash: await sha256Hex(value),
                binary: false,
              },
            }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
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
    expect(writeBinary).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/second.md.part.ready`,
      content,
    );
    expect(adapter.rename).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/second.md.part.ready`,
      "second.md",
    );
    expect(await sha256Hex(files.get("second.md")!)).toBe(contentHash);
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
    const state = makeActiveV2State([options.remote], []);
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
    const state = makeActiveV2State([options.remote], []);
    const downloadFileToPath = vi.fn().mockResolvedValue(options.downloaded);
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFileToPath }),
      {
        vault: {
          adapter,
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
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
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

  it("defers a truncated in-memory response instead of replacing the local file", async () => {
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

    // 2026-10-13（双轨候选，用户拍板立项）：正文尺寸与声明不符＝同一物理
    // 竞态的尺寸检测点，按瞬时延后处理（不写入、不落回执），不再是整轮失败。
    expect(result.result.errors).toBe(0);
    expect(result.result.deferred).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
    expect(result.state.recordMutationReceipt).not.toHaveBeenCalled();
    expect(result.state.reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: "note.bin",
        actionType: SyncActionType.Download,
        reason: "syncView.failure.remoteChangedDuringDownload",
        issueCode: "transfer-remote-moving",
      })],
      new Set(),
    );
  });

  it("defers a 200 requestUrl fallback error body instead of replacing the local file", async () => {
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
      expect(result.result.errors).toBe(0);
      expect(result.result.deferred).toBe(1);
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
    // 2026-09-28 改判：版本竞态延后为单项，不再记整轮失败。
    expect(result.result.errors).toBe(0);
    expect(result.result.deferred).toBe(1);
    expect(result.writeBinary).not.toHaveBeenCalled();
    expect(result.state.reconcilePendingIssues).toHaveBeenCalledWith(
      [expect.objectContaining({
        path: "note.bin",
        actionType: SyncActionType.Download,
        reason: "syncView.failure.remoteChangedDuringDownload",
        issueCode: "transfer-remote-moving",
      })],
      new Set(),
    );
  });

  it("defers a truncated streamed response and removes its temp file", async () => {
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

    // 尺寸类竞态并入延后通道；"不落半个文件"不变：临时件照删、不重命名。
    expect(result.result.errors).toBe(0);
    expect(result.result.deferred).toBe(1);
    expect(result.rename).not.toHaveBeenCalled();
    expect(result.remove).toHaveBeenCalledWith(
      `${EASY_SYNC_TMP_DIR}/downloads/large.bin.part`,
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
      `${EASY_SYNC_TMP_DIR}/downloads/large.bin.part`,
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
    const remoteEntry: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 10,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
      sha256Hash: baseEntry.hash,
    };
    const mockState = makeActiveV2State([remoteEntry], [baseEntry], {
      // Deliberately expose the removed legacy contract: a future accidental
      // reintroduction of the writer would make this production entry fail.
      needsCloudBaselineUpload: true,
      markCloudBaselineSynced,
    });
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
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
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

