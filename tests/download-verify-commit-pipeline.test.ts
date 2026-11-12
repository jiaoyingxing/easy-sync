// 下载组级复核/提交 (2026-11-08)：下载不再逐文件写 intent/receipt/checkpoint。
//
// 目标行为（而非实现细节）：
// 1. 传输批仍按 `downloadPolicy.limit` 形成；准备好的 payload 先进入提交组，
//    组满 8（桌面）/ 4（手机）或字节上限才交给组车道；
// 2. 组 N 的 `$batch` 复核在组 N+1 的内容传输进行中完成——两组时间线交错，
//    而不是「下载一组 → 核对完 → 再下载下一组」（本地提交的时序不在此断言）；
// 3. 逐文件完成反馈仍在本地写入 + 回执 sink 落地后立刻发出，不等组检查点；
// 4. SC-15 顺序不变：整组 intent 先于本组第一次本地写，整组回执先于组检查点，
//    组检查点严格按组序提交、不交错；eTag 漂移仍按原路失败关闭；
// 5. 传输车道开始一项内容传输时占用现役「当前文件」槽与字节槽（已知大小
//    0/大小 + onFileProgress 字节回调），但计数仍按已结算走、不提前推高。
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
import { SyncProgressStore } from "../src/sync/sync-progress";

const CONTENT = new Uint8Array(18).fill(7).buffer;
const GROUP = 8;
const VERIFY_GROUP = 8;

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
  ms = 5_000,
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
        eTag: (eTagFor ? eTagFor(id) : undefined) ?? remote.eTag,
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
  /** State writes only, one line per group phase. */
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
  /** Real progress store, for assertions on the current-file/byte slots. */
  progressStore?: SyncProgressStore;
}): PipelineFixture {
  const localStore = makeDownloadLocalStore();
  const state = makeActiveV2State(options.entries, []);
  const log: string[] = options.log ?? [];
  const stateLog: string[] = [];
  const pathByOperationId = new Map<string, string>();
  const beginIntents = state.beginMutationIntents.bind(state);
  state.beginMutationIntents = vi.fn(async (intents: MutationIntentV1[]) => {
    for (const intent of intents) {
      pathByOperationId.set(intent.operationId, intent.path);
      log.push(`intent:${intent.path}`);
    }
    stateLog.push(`intents:${intents.length}`);
    await beginIntents(intents);
  });
  const recordReceipts = state.recordMutationReceipts.bind(state);
  state.recordMutationReceipts = vi.fn(async (receipts: MutationReceiptV1[]) => {
    for (const receipt of receipts) {
      log.push(`receipt:${pathByOperationId.get(receipt.operationId) ?? "unknown"}`);
    }
    stateLog.push(`receipts:${receipts.length}`);
    await recordReceipts(receipts);
  });
  const commitCheckpoints = state.commitMutationCheckpoints.bind(state);
  state.commitMutationCheckpoints = vi.fn(async (operationIds: readonly string[]) => {
    for (const operationId of operationIds) {
      log.push(`checkpoint:${pathByOperationId.get(operationId) ?? "unknown"}`);
    }
    stateLog.push(`checkpoints:${operationIds.length}`);
    return commitCheckpoints(operationIds);
  });
  const commitCheckpoint = state.commitMutationCheckpoint.bind(state);
  state.commitMutationCheckpoint = vi.fn(async (operationId: string) => {
    log.push(`checkpoint:${pathByOperationId.get(operationId) ?? "unknown"}`);
    stateLog.push("checkpoints:1");
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
    undefined,
    options.progressStore,
  );
  return { entries: options.entries, state, localStore, log, stateLog, executor };
}

describe("download group verify/commit pipeline (2026-11-08)", () => {
  const previousMobile = Platform.isMobile;
  const previousMobileApp = Platform.isMobileApp;
  afterEach(() => {
    Platform.isMobile = previousMobile;
    Platform.isMobileApp = previousMobileApp;
  });

  it("verifies and commits each group while the next group transfers", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(VERIFY_GROUP * 2);
    const log: string[] = [];
    const firstCheckStarted = deferred();
    const releaseFirstCheck = deferred();
    let verifyCalls = 0;
    let verifyEnded = false;
    let downloadCalls = 0;
    let overlapProven = false;
    const metadata = metadataReader(entries);
    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
    ) => {
      if (reason !== "downloadVersionVerify") return metadata(ids);
      verifyCalls++;
      log.push(`verify-start:${verifyCalls}:${ids.length}`);
      if (verifyCalls === 1) {
        firstCheckStarted.resolve();
        await releaseFirstCheck.promise;
        verifyEnded = true;
      }
      log.push(`verify-end:${verifyCalls}`);
      return metadata(ids);
    });
    const downloadFile = vi.fn(async (_vault: string, path: string) => {
      downloadCalls++;
      const call = downloadCalls;
      log.push(`download-start:${call}:${path}`);
      if (call === VERIFY_GROUP + 1) {
        // The first verify group's check is still blocked, so this transfer
        // proves group N+1's content moves beside group N's verify/commit
        // lane.
        await within(firstCheckStarted.promise, "first group check starts");
        expect(verifyEnded).toBe(false);
        overlapProven = true;
        log.push(`download-${call}-overlaps-check-1`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      log.push(`download-end:${call}:${path}`);
      return CONTENT.slice(0);
    });

    const fixture = makeFixture({ entries, downloadFile, getDriveItemMetadataByIds, log });
    const { executor, state, localStore } = fixture;
    const runPromise = executor.run("manual", {
      onFileComplete: (path, _actionType, success) => {
        log.push(`complete:${path}:${success}`);
      },
    });

    await within(firstCheckStarted.promise, "first group check starts");
    await within(
      (async () => {
        while (!overlapProven) await new Promise((resolve) => setTimeout(resolve, 2));
      })(),
      "the next group transfers while the first group's check blocks",
    );
    releaseFirstCheck.resolve();
    const result = await within(runPromise, "group pipeline round finishes");

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.downloaded).toBe(entries.length);
    expect(localStore.files.size).toBe(entries.length);
    expect(state.baseSnapshot).toHaveLength(entries.length);
    expect(state.mutationLedger).toEqual([]);

    // Verify groups and persistence groups both stay at the approved 8/4:
    // two groups of eight, each one `$batch` and one
    // intent/receipt/checkpoint write.
    const verifySizes = getDriveItemMetadataByIds.mock.calls
      .filter((call) => call[1] === "downloadVersionVerify")
      .map((call) => call[0].length);
    expect(verifySizes).toEqual([VERIFY_GROUP, VERIFY_GROUP]);
    expect(fixture.stateLog.filter((line) => line.startsWith("intents:")))
      .toEqual([`intents:${GROUP}`, `intents:${GROUP}`]);
    expect(fixture.stateLog.filter((line) => line.startsWith("receipts:")))
      .toEqual([`receipts:${GROUP}`, `receipts:${GROUP}`]);
    expect(fixture.stateLog.filter((line) => line.startsWith("checkpoints:")))
      .toEqual([`checkpoints:${GROUP}`, `checkpoints:${GROUP}`]);

    // SC-15 across groups: group N's checkpoint precedes group N+1's intents,
    // so checkpoints cannot interleave; a per-file row lands after its own
    // group's check and before the next group's check.
    const firstIntentOfSecondGroup = fixture.stateLog.indexOf(
      `intents:${GROUP}`,
      1,
    );
    const firstCheckpoint = fixture.stateLog.indexOf(`checkpoints:${GROUP}`);
    expect(firstCheckpoint).toBeLessThan(firstIntentOfSecondGroup);
    const firstComplete = log.findIndex((line) => line.startsWith("complete:"));
    expect(firstComplete).toBeGreaterThanOrEqual(0);
    // The verify lane is ordered and the commit lane starts only after its own
    // group verified. Verify 2 may overlap commit 1 (separate lanes), so it
    // only has to follow verify 1; the first row follows its own check.
    const firstVerifyEnd = log.indexOf("verify-end:1");
    expect(log.findIndex((line) => line.startsWith("verify-start:2:")))
      .toBeGreaterThan(firstVerifyEnd);
    expect(firstComplete).toBeGreaterThan(firstVerifyEnd);

    // Every intent for a group precedes that group's first local write.
    // Transfers are read-only; the group's intents are written after its
    // payloads are prepared and before the first local write / row. The old
    // per-file path had the same relative order (transfer → intent → write).
    const firstIntent = log.findIndex((line) => line.startsWith("intent:"));
    const firstDownload = log.findIndex((line) => line.startsWith("download-start:"));
    const firstWriteRow = log.findIndex((line) => line.startsWith("complete:"));
    expect(firstDownload).toBeGreaterThanOrEqual(0);
    expect(firstIntent).toBeGreaterThan(firstDownload);
    expect(firstWriteRow).toBeGreaterThan(firstIntent);
  });

  it("fails a drifted eTag closed without touching the neighbouring group", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(10);
    const failedId = entries[1].driveId;
    const failedPath = entries[1].path;
    const pendingIssueSink: PendingIssue[] = [];
    const metadata = metadataReader(entries);
    let verifyCalls = 0;
    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
    ) => {
      if (reason !== "downloadVersionVerify") return metadata(ids);
      verifyCalls++;
      if (verifyCalls === 1) {
        expect(ids).toContain(failedId);
        return metadata(
          ids,
          (id) => id === failedId ? "etag-moved-during-download" : undefined,
        );
      }
      return metadata(ids);
    });
    const downloadFile = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return CONTENT.slice(0);
    });

    const fixture = makeFixture({ entries, downloadFile, getDriveItemMetadataByIds });
    const { executor, state, localStore } = fixture;
    const reconcileIssues = vi.fn(async (issues: PendingIssue[]) => {
      pendingIssueSink.push(...issues);
    });
    state.reconcilePendingIssues = reconcileIssues;

    const result = await executor.run("manual", {});

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
    // 逐路径写入标记只落在 log 里（stateLog 只有组级计数）：查错对象会让三条
    // not.toContain 恒真，失败成员被漏进 intent/receipt/checkpoint 也不会红。
    expect(fixture.log).not.toContain(`intent:${failedPath}`);
    expect(fixture.log).not.toContain(`receipt:${failedPath}`);
    expect(fixture.log).not.toContain(`checkpoint:${failedPath}`);
    expect(state.baseSnapshot).toHaveLength(entries.length - 1);
    expect(state.mutationLedger).toEqual([]);
    expect(pendingIssueSink.find((issue) => issue.path === failedPath))
      .toMatchObject({
        issueCode: "transfer-remote-moving",
        actionType: "download",
      });

    // Group 1 = 8 files, one of which failed verification; group 2 = 2 files.
    // The failed member is excluded from the intent/receipt/checkpoint writes
    // but the group's other members still commit.
    expect(fixture.stateLog.filter((line) => line.startsWith("intents:")))
      .toEqual(["intents:7", "intents:2"]);
    expect(fixture.stateLog.filter((line) => line.startsWith("checkpoints:")))
      .toEqual(["checkpoints:7", "checkpoints:2"]);
  });

  it("flips every shown row when the shared checkpoint fails", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(GROUP);
    const downloadFile = vi.fn(async () => CONTENT.slice(0));
    const fixture = makeFixture({
      entries,
      downloadFile,
      getDriveItemMetadataByIds: vi.fn(async (ids: readonly string[]) =>
        metadataReader(entries)(ids)),
    });
    const { executor, state } = fixture;
    const completed: string[] = [];
    const reverted: Array<{ path: string; reason: string }> = [];
    state.commitMutationCheckpoints = vi.fn(async () => {
      throw new Error("checkpoint save failed");
    });

    const result = await executor.run("manual", {
      onFileComplete: (path, _actionType, success) => {
        if (success) completed.push(path);
      },
      onFileReverted: (path, reason) => {
        reverted.push({ path, reason });
      },
    });

    expect(completed).toHaveLength(GROUP);
    expect(reverted).toHaveLength(GROUP);
    expect(reverted.map((row) => row.path).sort()).toEqual(
      entries.map((entry) => entry.path).sort(),
    );
    expect(reverted.every((row) => row.reason.includes("checkpoint"))).toBe(true);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(state.baseSnapshot).toEqual([]);
    // Receipts were durable before the failed checkpoint: the ledger keeps
    // them for the next round's recovery instead of losing the evidence.
    expect(state.mutationLedger).toHaveLength(GROUP);
    expect(state.mutationLedger.every((record) => record.receipt !== null)).toBe(true);
  });

  it("keeps the mobile verify group at the documented 4 so transfer batches do not degrade to width 1", async () => {
    // The 2026-11-08 commit shipped the verify-group flush threshold as a flat
    // 8 while the transfer-batch cap targeted the 8/4 persistence batch — on
    // mobile the two disagreed (cap 4, flush 8), so a group's files 5–8
    // transferred one at a time. The documented design (20261108-060140) is
    // verify group = persistence group = 8 desktop / 4 mobile.
    Platform.isMobileApp = true;
    const entries = makeEntries(GROUP * 3 / 2); // 12 files = 3 mobile groups
    const downloadFile = vi.fn(async () => CONTENT.slice(0));
    const getDriveItemMetadataByIds = vi.fn(async (
      ids: readonly string[],
      reason?: string,
    ) => metadataReader(entries)(ids));
    const fixture = makeFixture({ entries, downloadFile, getDriveItemMetadataByIds });
    const { executor, state, localStore } = fixture;

    const result = await executor.run("manual", {});

    expect(result.errors).toBe(0);
    expect(result.downloaded).toBe(entries.length);
    expect(localStore.files.size).toBe(entries.length);
    expect(state.mutationLedger).toEqual([]);

    // One `$batch` per 4-file group on mobile, and one intent/receipt/
    // checkpoint write per group — not [8, 4] with a half-size trailing group.
    const verifySizes = getDriveItemMetadataByIds.mock.calls
      .filter((call) => call[1] === "downloadVersionVerify")
      .map((call) => call[0].length);
    expect(verifySizes).toEqual([4, 4, 4]);
    expect(fixture.stateLog.filter((line) => line.startsWith("intents:")))
      .toEqual(["intents:4", "intents:4", "intents:4"]);
    expect(fixture.stateLog.filter((line) => line.startsWith("checkpoints:")))
      .toEqual(["checkpoints:4", "checkpoints:4", "checkpoints:4"]);
  });

  it("reports the transferring file into the current-file slot without advancing the settled count", async () => {
    // Before the 2026-11-11 fix the transfer lane reported nothing: between
    // run start and the first commit slice the sidebar showed a frozen 0/x
    // with no file name and no bytes (the whole transfer phase was invisible).
    // The bundle-prefetch precedent occupies the slot without pushing the
    // count; the transfer lane now does the same and wires byte callbacks.
    Platform.isMobileApp = false;
    const entries = makeEntries(GROUP);
    const firstTransferStarted = deferred();
    const releaseFirstTransfer = deferred();
    let downloadCalls = 0;
    const downloadFile = vi.fn(async (
      _vault: string,
      _path: string,
      _url: string,
      _driveId: string,
      _size: number,
      report?: (downloaded: number, total: number) => void,
    ) => {
      downloadCalls++;
      if (downloadCalls === 1) {
        firstTransferStarted.resolve();
        await within(releaseFirstTransfer.promise, "first transfer released");
      }
      report?.(0, CONTENT.byteLength);
      report?.(CONTENT.byteLength, CONTENT.byteLength);
      return CONTENT.slice(0);
    });
    const progressStore = new SyncProgressStore();
    const fixture = makeFixture({
      entries,
      downloadFile,
      getDriveItemMetadataByIds: vi.fn(async (ids: readonly string[]) =>
        metadataReader(entries)(ids)),
      progressStore,
    });
    const { executor } = fixture;
    const byteCalls: Array<[number, number]> = [];
    const runPromise = executor.run("manual", {
      onFileProgress: (downloaded, total) => {
        byteCalls.push([downloaded, total]);
      },
    });

    await within(firstTransferStarted.promise, "first transfer starts");
    // While the first transfer is still in flight: the slot names the
    // transferring file with its known size, and the settled count has not
    // moved (desktop policy starts at width 1, so exactly one file started).
    expect(progressStore.state.current).toBe(0);
    expect(progressStore.state.total).toBe(GROUP);
    expect(progressStore.state.currentFile).toBe(entries[0].path);
    expect(progressStore.state.currentItemTotalBytes).toBe(CONTENT.byteLength);

    releaseFirstTransfer.resolve();
    const result = await within(runPromise, "round finishes");

    expect(result.downloaded).toBe(entries.length);
    // The byte callbacks reached the UI callback, endpoints included.
    expect(byteCalls).toContainEqual([0, CONTENT.byteLength]);
    expect(byteCalls).toContainEqual([CONTENT.byteLength, CONTENT.byteLength]);
    // The slot calls carried the settled position (0 at transfer time), not a
    // pushed-up count; settlement later walks the count per file.
    expect(result.downloaded).toBe(GROUP);
    expect(progressStore.state.current).toBe(GROUP);
  });

  it("leaves at most one group of intent-only downloads when the round cancels inside it", async () => {
    Platform.isMobile = false;
    const entries = makeEntries(GROUP + 4);
    const fixture = makeFixture({
      entries,
      downloadFile: vi.fn(async () => CONTENT.slice(0)),
      getDriveItemMetadataByIds: vi.fn(async (ids: readonly string[]) =>
        metadataReader(entries)(ids)),
    });
    const { executor, state, localStore } = fixture;
    const beginIntents = state.beginMutationIntents.bind(state);
    state.beginMutationIntents = vi.fn(async (intents: MutationIntentV1[]) => {
      await beginIntents(intents);
      // Cancellation after the group's intent write but before its first
      // local write: the durable window a crash in the same spot leaves.
      executor.cancel();
    });

    const result = await executor.run("manual", {});

    expect(result.success).toBe(false);
    expect(result.downloaded).toBe(0);
    expect(localStore.files.size).toBe(0);
    expect(state.mutationLedger).toHaveLength(GROUP);
    expect(state.mutationLedger.every((record) => record.receipt === null)).toBe(true);
    expect(state.baseSnapshot).toEqual([]);
  });
});
