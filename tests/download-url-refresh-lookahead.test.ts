// 下载地址刷新流水线 (2026-10-27) — 2,000 个新文件的现场故障：
// 传输阶段先把全部 2,000 个 downloadUrl 一次取完（20 个一组 ⇒ ~100 次串行
// `$batch` POST，实测 5.8 秒/次），期间零字节传输，两轮分别 297 秒 / 260 秒
// 被取消且 0 B 落盘。这里锁住替代行为的三条：
// 1. 同一次批量刷新调用仍在（一次调用、请求形状与 20-id 分块不变），但每一块
//    一解析出来就发布，第一批下载在该块之后立刻开始，后续块与内容传输重叠；
// 2. 刷新调用在发布第一块后整个失败时，已发布的那一块照常下载，只有没读到的
//    尾部退回现有的逐批刷新路径，整轮不退化；
// 3. 某一小批的地址刷新失败只让那一批失败，其余批次照常下载、照常提交。
import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "obsidian";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { DriveItem } from "../src/onedrive/types";
import type { RemoteFileEntry } from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeDownloadLocalStore,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

const CONTENT = new Uint8Array(18).fill(7).buffer;
/** Graph's own per-request cap; the lookahead must not change it. */
const REFRESH_CHUNK = 20;

type ChunkObserver = (resolved: ReadonlyMap<string, DriveItem>) => void;

interface RefreshCallOptions {
  onChunkResolved?: ChunkObserver;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A gated lane must never silently hang the test: every wait is bounded and
 *  names the ordering that did not happen. */
async function within<T>(
  promise: Promise<T>,
  label: string,
  ms = 3_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeEntries(count: number): RemoteFileEntry[] {
  return Array.from({ length: count }, (_, index): RemoteFileEntry => ({
    path: `lookahead-${index}.txt`,
    driveId: `lookahead-id-${index}`,
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: CONTENT.byteLength,
    mtime: index,
    eTag: `lookahead-etag-${index}`,
    cTag: `lookahead-ctag-${index}`,
  }));
}

function metadataFor(
  entries: readonly RemoteFileEntry[],
  ids: readonly string[],
): Map<string, DriveItem> {
  const byId = new Map(entries.map((entry) => [entry.driveId, entry]));
  return new Map(ids.map((id) => {
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
  }));
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

/** Index of the first event line with this prefix (gate-friendly: the exact
 *  path of the plan's first item is asserted separately). */
function logIndexOf(log: readonly string[], prefix: string): number {
  const index = log.findIndex((line) => line.startsWith(prefix));
  expect(index, `event missing: ${prefix}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("download URL refresh lookahead (2026-10-27)", () => {
  const previousMobile = Platform.isMobile;
  afterEach(() => {
    Platform.isMobile = previousMobile;
  });

  it("downloads the first URL chunk while the next chunk is still being read", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(45);
    const log: string[] = [];
    const firstDownloadStarted = deferred();
    const secondChunkPublished = deferred();
    const refreshCalls: string[][] = [];
    let refreshChunk = 0;
    let verifyCalls = 0;
    let downloadCalls = 0;

    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
      options?: RefreshCallOptions,
    ) => {
      if (reason !== "downloadUrlRefresh") {
        if (reason === "downloadVersionVerify") verifyCalls++;
        return metadataFor(entries, ids);
      }
      refreshCalls.push([...ids]);
      const resolved = new Map<string, DriveItem>();
      for (let offset = 0; offset < ids.length; offset += REFRESH_CHUNK) {
        const chunkIds = ids.slice(offset, offset + REFRESH_CHUNK);
        const chunk = metadataFor(entries, chunkIds);
        for (const [id, item] of chunk) resolved.set(id, item);
        options?.onChunkResolved?.(chunk);
        refreshChunk++;
        log.push(`chunk:${refreshChunk}`);
        if (refreshChunk === 1) {
          // The read must not get ahead of the pipeline: chunk 2 is published
          // only after the first content transfer has actually started.
          await within(firstDownloadStarted.promise, "first download starts");
        }
        if (refreshChunk === 2) secondChunkPublished.resolve();
      }
      return resolved;
    });

    const downloadFile = vi.fn(async (
      _vault: string,
      path: string,
      downloadUrl?: string,
      _driveId?: string,
      size = 0,
    ) => {
      const call = ++downloadCalls;
      log.push(`download-start:${call}:${path}`);
      if (typeof downloadUrl !== "string" || !downloadUrl.startsWith("https://")) {
        throw new Error(`download without a refreshed URL: ${path}`);
      }
      if (call === 1) {
        firstDownloadStarted.resolve();
        await within(
          secondChunkPublished.promise,
          "second URL chunk published while the first transfer is in flight",
        );
        log.push("download-1-overlaps-chunk-2");
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      return CONTENT.slice(0);
    });

    const diag = { log: vi.fn(), warn: vi.fn() };
    const { executor, localStore, state } = makeExecutor({
      entries,
      downloadFile,
      getDriveItemMetadataByIds,
      diag,
    });

    const result = await within(executor.run("manual", {}), "lookahead round finishes", 10_000);

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.downloaded).toBe(entries.length);
    expect(localStore.files.size).toBe(entries.length);
    expect(state.baseSnapshot).toHaveLength(entries.length);
    expect(state.mutationLedger).toEqual([]);

    // One batched refresh call, same request shape as before (every missing id
    // in plan order, one `$batch` per 20) — the pipeline is not a re-chunking
    // of it.
    expect(refreshCalls).toHaveLength(1);
    expect([...refreshCalls[0]].sort())
      .toEqual(entries.map((entry) => entry.driveId).sort());

    // Timeline: chunk 1 published → first transfer started (while chunks 2-3
    // were still unread) → chunk 2 published during that transfer. The first
    // content byte no longer waits for the whole URL read.
    expect(logIndexOf(log, "chunk:1")).toBeLessThan(
      logIndexOf(log, "download-start:1:"),
    );
    expect(logIndexOf(log, "download-start:1:")).toBeLessThan(
      logIndexOf(log, "chunk:2"),
    );
    expect(log).toContain("download-1-overlaps-chunk-2");
    expect(log[logIndexOf(log, "download-start:1:")])
      .toBe("download-start:1:lookahead-0.txt");
    // Every file was downloaded from the batched URL, never through the
    // per-file metadata waterfall.
    expect(downloadFile).toHaveBeenCalledTimes(entries.length);
    expect(verifyCalls).toBeGreaterThan(0);

    const lookupLog = diag.log.mock.calls.find(
      (call) => call[1] === "batch downloadUrl refresh",
    );
    expect(lookupLog?.[2]).toMatchObject({
      files: entries.length,
      filled: entries.length,
      batchRequests: Math.ceil(entries.length / REFRESH_CHUNK),
      publishedChunks: 3,
    });
    expect(diag.warn.mock.calls.filter((call) =>
      String(call[1]).includes("lookahead stopped")
    )).toHaveLength(0);
  });

  it("keeps the published URLs when the refresh call dies afterwards, and only the unread tail falls back", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(45);
    const refreshCalls: string[][] = [];

    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
      options?: RefreshCallOptions,
    ) => {
      if (reason !== "downloadUrlRefresh") return metadataFor(entries, ids);
      refreshCalls.push([...ids]);
      if (ids.length > REFRESH_CHUNK) {
        // Field evidence shape: the read's first chunk resolves, then the
        // whole call dies (auth expiry / abort / link drop).
        const chunk = metadataFor(entries, ids.slice(0, REFRESH_CHUNK));
        options?.onChunkResolved?.(chunk);
        throw new Error("refresh aborted");
      }
      return metadataFor(entries, ids);
    });

    const downloadFile = vi.fn(async (
      _vault: string,
      path: string,
      downloadUrl?: string,
    ) => {
      if (typeof downloadUrl !== "string" || !downloadUrl.startsWith("https://")) {
        throw new Error(`download without a refreshed URL: ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      return CONTENT.slice(0);
    });

    const diag = { log: vi.fn(), warn: vi.fn() };
    const { executor, localStore, state } = makeExecutor({
      entries,
      downloadFile,
      getDriveItemMetadataByIds,
      diag,
    });

    const result = await within(executor.run("manual", {}), "degraded refresh round finishes", 10_000);

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.downloaded).toBe(entries.length);
    expect(localStore.files.size).toBe(entries.length);
    expect(state.baseSnapshot).toHaveLength(entries.length);
    expect(state.mutationLedger).toEqual([]);

    // The first chunk's URLs survived the failure: the published 20 ids are
    // never re-read, and the fallback only covers the tail after them.
    expect([...refreshCalls[0]].sort())
      .toEqual(entries.map((entry) => entry.driveId).sort());
    const publishedIds = refreshCalls[0].slice(0, REFRESH_CHUNK);
    const fallbackCalls = refreshCalls.slice(1);
    expect(fallbackCalls.length).toBeGreaterThan(0);
    for (const ids of fallbackCalls) {
      expect(ids.length).toBeLessThanOrEqual(3);
      for (const id of ids) expect(publishedIds).not.toContain(id);
    }
    expect(diag.warn.mock.calls.some((call) =>
      String(call[1]).includes("lookahead stopped")
    )).toBe(true);
  });

  it("fails only the batch whose URL refresh failed, and keeps downloading the rest", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(45);
    /** Chosen from the first call's *unpublished* tail, so the failing batch is
     *  a fallback re-read and not already covered by the published chunk. */
    let failingId: string | null = null;
    let failedBatchIds: string[] = [];
    const failedBatchOrder: string[][] = [];

    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
      options?: RefreshCallOptions,
    ) => {
      if (reason !== "downloadUrlRefresh") return metadataFor(entries, ids);
      if (ids.length > REFRESH_CHUNK) {
        // Publish the first chunk, then die: the rest goes per batch.
        const chunk = metadataFor(entries, ids.slice(0, REFRESH_CHUNK));
        options?.onChunkResolved?.(chunk);
        const tail = ids.slice(REFRESH_CHUNK);
        failingId = tail[Math.floor(tail.length / 2)];
        throw new Error("refresh aborted");
      }
      if (failingId !== null && ids.includes(failingId)) {
        failedBatchIds = [...ids];
        failedBatchOrder.push([...ids]);
        throw new Error("batch metadata endpoint down");
      }
      return metadataFor(entries, ids);
    });

    const downloadFile = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return CONTENT.slice(0);
    });

    const { executor, localStore, state } = makeExecutor({
      entries,
      downloadFile,
      getDriveItemMetadataByIds,
    });

    const result = await within(executor.run("manual", {}), "isolated batch failure round finishes", 10_000);

    expect(failingId).not.toBeNull();
    expect(failedBatchOrder).toHaveLength(1);
    expect(failedBatchIds.length).toBeGreaterThanOrEqual(1);
    expect(failedBatchIds.length).toBeLessThanOrEqual(3);
    const failedPaths = new Set(
      entries.filter((entry) => failedBatchIds.includes(entry.driveId))
        .map((entry) => entry.path),
    );
    expect(failedPaths.size).toBe(failedBatchIds.length);

    // Exactly the batch that lost its refresh failed; every other file —
    // including the batches after it — downloaded and committed normally.
    expect(result.errors).toBe(failedPaths.size);
    expect(result.deferred).toBe(0);
    expect(result.downloaded).toBe(entries.length - failedPaths.size);
    expect(localStore.files.size).toBe(entries.length - failedPaths.size);
    for (const path of failedPaths) expect(localStore.files.has(path)).toBe(false);
    expect(localStore.files.has(entries[entries.length - 1].path)).toBe(true);
    expect(state.baseSnapshot).toHaveLength(entries.length - failedPaths.size);
    expect(state.mutationLedger).toEqual([]);
  });
});
