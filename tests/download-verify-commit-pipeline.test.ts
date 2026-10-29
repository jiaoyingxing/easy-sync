// 下载流水线 (2026-10-27)：核对与本地提交不得再挡住下一批下载。
//
// 目标行为（而非实现细节）：
// 1. 批次 N 的 `$batch` 复核在批次 N+1 的内容传输进行中完成——两批时间线交错，
//    而不是「下载一批 → 核对完 → 再下载下一批」；
// 2. 逐文件完成反馈仍在该文件所属批次核对通过后立刻发出，不等下一批的核对；
// 3. SC-15 顺序不变：每项 intent → receipt → checkpoint，且两批的检查点严格
//    按批序提交、不交错；
// 4. 核对失败仍按原路失败关闭（eTag 漂移 → 该项延后、不写本机），且在飞/后续
//    批次不受污染。
import { describe, it, expect, vi, afterEach } from "vitest";
import { Platform } from "obsidian";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { PendingIssue } from "../src/sync/state-manager";
import type {
  MutationIntentV1,
  MutationReceiptV1,
  RemoteFileEntry,
} from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeDownloadLocalStore,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

const CONTENT = new Uint8Array(18).fill(7).buffer;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A gated lane must never silently hang the test: every wait on the executor
 *  is bounded and names the ordering that did not happen. */
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
    path: `pipeline-${index}.txt`,
    driveId: `pipeline-id-${index}`,
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: CONTENT.byteLength,
    mtime: index,
    eTag: `pipeline-etag-${index}`,
    cTag: `pipeline-ctag-${index}`,
  }));
}

function metadataReader(entries: RemoteFileEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.driveId, entry]));
  return (ids: readonly string[], eTagFor?: (id: string) => string) =>
    new Map(ids.map((id) => {
      const remote = byId.get(id);
      if (!remote) throw new Error(`unexpected metadata id: ${id}`);
      return [id, {
        id,
        name: remote.path,
        size: remote.size,
        eTag: eTagFor ? eTagFor(id) : remote.eTag,
        cTag: remote.cTag,
        file: {},
        parentReference: { id: remote.parentId },
        "@microsoft.graph.downloadUrl": `https://download.example/${id}`,
      }];
    }));
}

interface PipelineFixture {
  entries: RemoteFileEntry[];
  state: ReturnType<typeof makeActiveV2State>;
  localStore: ReturnType<typeof makeDownloadLocalStore>;
  /** Shared event log: download / verify / completion / state-write marks. */
  log: string[];
  /** State writes only, one path-keyed line per write, in execution order. */
  stateLog: string[];
  executor: SyncExecutor;
}

function makeFixture(options: {
  entries: RemoteFileEntry[];
  downloadFile: ReturnType<typeof vi.fn>;
  getDriveItemMetadataByIds: ReturnType<typeof vi.fn>;
  /** Shared event log, so the test's own download/verify marks and the
   *  fixture's state-write marks land in one orderable sequence. */
  log?: string[];
}): PipelineFixture {
  const localStore = makeDownloadLocalStore();
  const state = makeActiveV2State(options.entries, []);
  const log: string[] = options.log ?? [];
  const stateLog: string[] = [];
  const pathByOperationId = new Map<string, string>();
  const beginIntent = state.beginMutationIntent.bind(state);
  state.beginMutationIntent = vi.fn(async (intent: MutationIntentV1) => {
    pathByOperationId.set(intent.operationId, intent.path);
    stateLog.push(`intent:${intent.path}`);
    log.push(`intent:${intent.path}`);
    await beginIntent(intent);
  });
  const recordReceipt = state.recordMutationReceipt.bind(state);
  state.recordMutationReceipt = vi.fn(async (receipt: MutationReceiptV1) => {
    const path = pathByOperationId.get(receipt.operationId) ?? "unknown";
    stateLog.push(`receipt:${path}`);
    log.push(`receipt:${path}`);
    await recordReceipt(receipt);
  });
  const commitCheckpoint = state.commitMutationCheckpoint.bind(state);
  state.commitMutationCheckpoint = vi.fn(async (operationId: string) => {
    const path = pathByOperationId.get(operationId) ?? "unknown";
    stateLog.push(`checkpoint:${path}`);
    log.push(`checkpoint:${path}`);
    return commitCheckpoint(operationId);
  });
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
  );
  return { entries: options.entries, state, localStore, log, stateLog, executor };
}

describe("download verify/commit pipeline (2026-10-27)", () => {
  const previousMobile = Platform.isMobile;
  afterEach(() => {
    Platform.isMobile = previousMobile;
  });

  it("checks batch N while batch N+1 transfers, and completes files without waiting for N+1", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(6);
    const log: string[] = [];
    const firstCheckStarted = deferred();
    const releaseFirstCheck = deferred();
    const secondTransferFinished = deferred();
    const firstBatchCompletion = deferred();
    let firstCheckEnded = false;
    let firstBatchPath: string | null = null;
    let verifyCalls = 0;
    let downloadCalls = 0;

    const metadata = metadataReader(entries);
    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
    ) => {
      if (reason !== "downloadVersionVerify") return metadata(ids);
      verifyCalls++;
      log.push(`verify-start:${verifyCalls}:${ids.length}`);
      if (verifyCalls === 1) {
        firstBatchPath = entries.find((entry) => entry.driveId === ids[0])!.path;
        firstCheckStarted.resolve();
        await releaseFirstCheck.promise;
        firstCheckEnded = true;
      } else if (verifyCalls === 2) {
        // The row for batch N must not wait for this check to finish: this
        // check waits for that row (bounded), so a commit stage queued behind
        // the next verification turns into a clear timeout failure.
        await within(
          firstBatchCompletion.promise,
          "first batch's per-file completion before the second batch's check returns",
        );
      }
      log.push(`verify-end:${verifyCalls}`);
      return metadata(ids);
    });

    const downloadFile = vi.fn(async (_vault: string, path: string) => {
      downloadCalls++;
      const call = downloadCalls;
      log.push(`download-start:${call}:${path}`);
      if (call === 2) {
        // Only finish this transfer once the first batch's check is actually
        // in flight; the release below then closes that check afterwards.
        await within(firstCheckStarted.promise, "first batch check starts");
        log.push(`download-2-overlaps-check-1`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push(`download-end:${call}:${path}`);
      if (call === 2) secondTransferFinished.resolve();
      return CONTENT.slice(0);
    });

    const fixture = makeFixture({ entries, downloadFile, getDriveItemMetadataByIds, log });
    const { executor, state, localStore } = fixture;
    const runPromise = executor.run("manual", {
      onFileComplete: (path, _actionType, success) => {
        log.push(`complete:${path}:${success}`);
        if (firstBatchPath !== null && path === firstBatchPath) {
          firstBatchCompletion.resolve();
        }
      },
    });

    await within(firstCheckStarted.promise, "first version check starts");
    await within(secondTransferFinished.promise, "second transfer while first check is in flight");
    expect(firstCheckEnded).toBe(false);
    releaseFirstCheck.resolve();
    await within(firstBatchCompletion.promise, "first batch's completion row");
    const result = await within(runPromise, "pipeline round finishes");

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.downloaded).toBe(entries.length);
    expect(localStore.files.size).toBe(entries.length);
    expect(state.baseSnapshot).toHaveLength(entries.length);
    expect(state.mutationLedger).toEqual([]);

    // Timeline: check #1 began before transfer #2 ended, and transfer #2 began
    // before check #1 ended — the two stages really interleave.
    const indexOf = (needle: string) => {
      const index = log.indexOf(needle);
      expect(index, `event missing: ${needle}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(indexOf("download-start:2:pipeline-1.txt"))
      .toBeGreaterThan(indexOf("verify-start:1:1"));
    expect(indexOf("download-end:2:pipeline-1.txt"))
      .toBeLessThan(indexOf("verify-end:1"));
    expect(log).toContain("download-2-overlaps-check-1");

    // Per-file completion: the first batch's row lands from its own commit,
    // while check #2 still waits for it (see the gate above).
    expect(log.some((line) => line.startsWith("complete:"))).toBe(true);

    // SC-15: intent → receipt → checkpoint per item, all items in plan order,
    // and the second batch's first write only after the first batch's
    // checkpoint. Two batches' checkpoints therefore cannot interleave.
    expect(fixture.stateLog).toHaveLength(entries.length * 3);
    fixture.stateLog.forEach((line, index) => {
      const expectedPhase = ["intent", "receipt", "checkpoint"][index % 3];
      const expectedPath = entries[Math.floor(index / 3)].path;
      expect(line).toBe(`${expectedPhase}:${expectedPath}`);
    });
    expect(indexOf("checkpoint:pipeline-0.txt")).toBeLessThan(
      indexOf("intent:pipeline-1.txt"),
    );
  });

  it("fails a drifted eTag closed without touching the overlapping next batch", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(6);
    const failedId = entries[1].driveId;
    const failedPath = entries[1].path;
    const thirdTransferStarted = deferred();
    const secondTransferFinished = deferred();
    const releaseFirstCheck = deferred();
    const firstCheckStarted = deferred();
    let verifyCalls = 0;
    let downloadCalls = 0;
    const pendingIssueSink: PendingIssue[] = [];

    const metadata = metadataReader(entries);
    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
    ) => {
      if (reason !== "downloadVersionVerify") return metadata(ids);
      verifyCalls++;
      if (verifyCalls === 1) {
        firstCheckStarted.resolve();
        await releaseFirstCheck.promise;
      } else if (verifyCalls === 2) {
        // The failing check is in flight while the following batch already
        // transfers: one batch's failure neither stops nor pollutes the next.
        await within(thirdTransferStarted.promise, "third transfer starts");
        expect(ids).toContain(failedId);
        return metadata(ids, () => "etag-moved-during-download");
      }
      return metadata(ids);
    });

    const downloadFile = vi.fn(async (_vault: string, path: string) => {
      downloadCalls++;
      const call = downloadCalls;
      if (call === 2) await within(firstCheckStarted.promise, "first check starts");
      if (call === 3) thirdTransferStarted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (call === 2) secondTransferFinished.resolve();
      return CONTENT.slice(0);
    });

    const fixture = makeFixture({ entries, downloadFile, getDriveItemMetadataByIds });
    const { executor, state, localStore } = fixture;
    const reconcileIssues = vi.fn(async (issues: PendingIssue[]) => {
      pendingIssueSink.push(...issues);
    });
    state.reconcilePendingIssues = reconcileIssues;

    const runPromise = executor.run("manual", {});
    await within(firstCheckStarted.promise, "first check starts");
    await within(secondTransferFinished.promise, "second transfer while the first check runs");
    releaseFirstCheck.resolve();
    const result = await within(runPromise, "pipeline round finishes");

    // The drifted item fails closed as the existing transient version race:
    // deferred, no local bytes, no mutation intent.
    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.downloaded).toBe(entries.length - 1);
    expect(localStore.files.has(failedPath)).toBe(false);
    for (const entry of entries) {
      if (entry.path === failedPath) continue;
      expect(localStore.files.has(entry.path)).toBe(true);
    }
    expect(fixture.stateLog).not.toContain(`intent:${failedPath}`);
    expect(fixture.stateLog).not.toContain(`receipt:${failedPath}`);
    expect(fixture.stateLog).not.toContain(`checkpoint:${failedPath}`);
    expect(state.baseSnapshot).toHaveLength(entries.length - 1);
    expect(state.mutationLedger).toEqual([]);
    expect(pendingIssueSink.find((issue) => issue.path === failedPath))
      .toMatchObject({
        issueCode: "transfer-remote-moving",
        actionType: "download",
      });

    // The batch that was already transferring during the failed check settled
    // normally, and every other batch still committed its own checkpoint.
    expect(fixture.stateLog.filter((line) => line.startsWith("checkpoint:")))
      .toHaveLength(entries.length - 1);
    expect(verifyCalls).toBeGreaterThanOrEqual(3);
  });
});
