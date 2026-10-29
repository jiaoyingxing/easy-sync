// 小文件下载档 (2026-10-27): 18 B–200 KiB 的文件没有带宽证据，旧策略因此
// 整轮串行（桌面实测 2.79 秒/文件）。这里锁住两条行为：
// 1. 连续完成的真实传输让上限 1 → 2 → 3，验证请求按批合并而不是逐文件；
// 2. 一旦某个小文件批次失败，方向立刻退回串行——提速不能越过失败闸。
import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "obsidian";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { RemoteFileEntry } from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeDownloadLocalStore,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

const CONTENT = new Uint8Array(18).fill(7).buffer;

function makeEntries(count: number): RemoteFileEntry[] {
  return Array.from({ length: count }, (_, index): RemoteFileEntry => ({
    path: `tiny-${index}.txt`,
    driveId: `tiny-id-${index}`,
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: CONTENT.byteLength,
    mtime: index,
    eTag: `tiny-etag-${index}`,
    cTag: `tiny-ctag-${index}`,
  }));
}

function makeMetadataClient(entries: RemoteFileEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.driveId, entry]));
  return vi.fn(async (ids: readonly string[]) =>
    new Map(ids.map((id) => {
      const remote = byId.get(id);
      if (!remote) throw new Error(`unexpected metadata id: ${id}`);
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
    })));
}

function makeExecutor(options: {
  entries: RemoteFileEntry[];
  downloadFile: ReturnType<typeof vi.fn>;
  getDriveItemMetadataByIds: ReturnType<typeof vi.fn>;
  diag?: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}) {
  const localStore = makeDownloadLocalStore();
  const state = makeActiveV2State(options.entries, []);
  const executor = new SyncExecutor(
    makeMockOneDrive({
      downloadFile: options.downloadFile,
      getDriveItemMetadataByIds: options.getDriveItemMetadataByIds,
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
    undefined,
    undefined,
    options.diag as never,
  );
  return { executor, localStore, state };
}

describe("small-file download concurrency (2026-10-27)", () => {
  const previousMobile = Platform.isMobile;

  afterEach(() => {
    Platform.isMobile = previousMobile;
  });

  it("ramps completed 18-byte transfers to three and batches the version checks", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(30);
    let active = 0;
    let peak = 0;
    const downloadFile = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return CONTENT.slice(0);
      } finally {
        active--;
      }
    });
    const getDriveItemMetadataByIds = makeMetadataClient(entries);
    const diag = { log: vi.fn(), warn: vi.fn() };
    const { executor, localStore, state } = makeExecutor({
      entries,
      downloadFile,
      getDriveItemMetadataByIds,
      diag,
    });

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(entries.length);
    expect(result.errors).toBe(0);
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.metrics?.fileTransfers.download.peakConcurrency).toBe(peak);

    // The whole round refreshes every missing URL once; version checks then
    // ride the adaptive batch (≤ the desktop ceiling of 3), so 30 files cost
    // far fewer than 30 post-download metadata requests.
    const refreshCalls = getDriveItemMetadataByIds.mock.calls
      .filter((call) => call[1] === "downloadUrlRefresh");
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0][0]).toHaveLength(entries.length);
    const refreshLog = diag.log.mock.calls.find(
      (call) => call[1] === "batch downloadUrl refresh",
    );
    expect(refreshLog?.[2]).toMatchObject({
      files: entries.length,
      filled: entries.length,
      batchRequests: 2,
    });
    const verifyCalls = getDriveItemMetadataByIds.mock.calls
      .filter((call) => call[1] === "downloadVersionVerify");
    expect(verifyCalls.length).toBeGreaterThan(0);
    expect(verifyCalls.length).toBeLessThan(entries.length);
    expect(verifyCalls.every((call) => call[0].length <= 3)).toBe(true);
    expect(verifyCalls.flatMap((call) => call[0]).sort()).toEqual(
      entries.map((entry) => entry.driveId).sort(),
    );

    expect(localStore.files.size).toBe(entries.length);
    expect(state.baseSnapshot).toHaveLength(entries.length);
    expect(state.mutationLedger).toEqual([]);
  });

  it("a failed small-file batch still drops the direction back to serial", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(10);
    const failingPath = entries[0].path;
    let active = 0;
    let peak = 0;
    const downloadFile = vi.fn(async (
      _vault: string,
      path: string,
    ) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (path === failingPath) throw new Error("download link dropped");
        return CONTENT.slice(0);
      } finally {
        active--;
      }
    });
    const getDriveItemMetadataByIds = makeMetadataClient(entries);
    const { executor } = makeExecutor({
      entries,
      downloadFile,
      getDriveItemMetadataByIds,
    });

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(1);
    expect(result.downloaded).toBe(entries.length - 1);
    const verifySizes = getDriveItemMetadataByIds.mock.calls
      .filter((call) => call[1] === "downloadVersionVerify")
      .map((call) => call[0].length);
    // The failed batch is observed before the next wave is planned, so the
    // immediate next version checks must be single-file batches again.
    expect(verifySizes[0]).toBe(1);
    expect(verifySizes[1]).toBe(1);
    expect(verifySizes[2]).toBe(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
