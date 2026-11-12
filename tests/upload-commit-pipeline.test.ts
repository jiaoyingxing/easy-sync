// 上传双批流水线 (2026-11-08)：批 N 的回执+检查点与批 N+1 的 PUT 重叠。
//
// 目标行为（而非实现细节）：
// 1. 批 N+1 的意图在批 N 的回执/检查点之前落盘，随后批 N+1 的 PUT 与批 N 的
//    状态提交并行；状态车道严格按 `intents(N+1) → receipts(N) → checkpoint(N)`
//    执行；
// 2. 崩溃/取消窗口最多两批意图（桌面 32 / 手机 8），不随库大小增长；
// 3. 检查点失败时，已显示完成行的两批都被翻成失败，未回执的意图留给下一轮恢复。
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import type {
  LocalFileEntry,
  MutationIntentV1,
  MutationReceiptV1,
} from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { StateManager } from "../src/sync/state-manager";
import type { LocalScanner } from "../src/sync/local-scanner";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

const CONTENT = new ArrayBuffer(8);
const BATCH = 16;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

interface UploadScenario {
  executor: SyncExecutor;
  state: StateManager;
  localEntries: LocalFileEntry[];
  uploadFile: ReturnType<typeof vi.fn>;
  diagLog: ReturnType<typeof vi.fn>;
}

async function makeUploadScenario(input: {
  fileCount: number;
  state?: StateManager;
  uploadFile?: ReturnType<typeof vi.fn>;
}): Promise<UploadScenario> {
  const hash = await sha256Hex(CONTENT);
  const localEntries: LocalFileEntry[] = Array.from(
    { length: input.fileCount },
    (_, index) => ({
      path: `pipeline-up-${index}.md`,
      hash,
      size: CONTENT.byteLength,
      mtime: index + 1,
      binary: false,
    }),
  );
  const uploadFile = input.uploadFile ?? vi.fn(async (
    _vault: string,
    path: string,
  ) => ({
    id: `id:${path}`,
    eTag: `etag:${path}`,
    cTag: `ctag:${path}`,
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
  }));
  const state = input.state ?? makeActiveV2State([], []);
  const diagLog = vi.fn();
  const executor = new SyncExecutor(
    makeMockOneDrive({ uploadFile }),
    {
      vault: {
        adapter: makeMockAdapter({
          readBinary: vi.fn().mockResolvedValue(CONTENT),
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
      scanFile: vi.fn(async (path: string) =>
        localEntries.find((entry) => entry.path === path) ?? null),
      inspectFile: vi.fn(async (path: string) => {
        const entry = localEntries.find((candidate) => candidate.path === path);
        return entry
          ? { status: "present" as const, entry }
          : { status: "missing" as const };
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    state,
    "testVault",
    undefined,
    undefined,
    { log: diagLog, warn: vi.fn(), error: vi.fn() } as never,
  );
  return { executor, state, localEntries, uploadFile, diagLog };
}

describe("small-upload two-batch pipeline (2026-11-08)", () => {
  it("starts batch N+1's PUTs while batch N's checkpoint is still running", async () => {
    const log: string[] = [];
    const checkpointStarted = deferred();
    const releaseCheckpoint = deferred();
    let checkpointCalls = 0;
    const originalCommit = vi.fn();
    const state = makeActiveV2State([], []);
    const originalCheckpoints = state.commitMutationCheckpoints.bind(state);
    state.commitMutationCheckpoints = vi.fn(async (operationIds: readonly string[]) => {
      checkpointCalls++;
      log.push(`checkpoint-start:${checkpointCalls}:${operationIds.length}`);
      if (checkpointCalls === 1) {
        checkpointStarted.resolve();
        await releaseCheckpoint.promise;
      }
      const result = await originalCheckpoints(operationIds);
      log.push(`checkpoint-end:${checkpointCalls}`);
      return result;
    });
    const beginIntents = state.beginMutationIntents.bind(state);
    let intentCalls = 0;
    state.beginMutationIntents = vi.fn(async (intents: MutationIntentV1[]) => {
      intentCalls++;
      log.push(`intents-start:${intentCalls}:${intents.length}`);
      await beginIntents(intents);
      log.push(`intents-end:${intentCalls}`);
    });
    let uploadCalls = 0;
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      uploadCalls++;
      log.push(`upload-start:${uploadCalls}:${path}`);
      if (uploadCalls === BATCH + 1) {
        expect(checkpointCalls).toBe(1);
        log.push("upload-17-overlaps-checkpoint-1");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      originalCommit();
      return {
        id: `id:${path}`,
        eTag: `etag:${path}`,
        cTag: `ctag:${path}`,
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      };
    });
    const { executor, diagLog } = await makeUploadScenario({
      fileCount: BATCH * 2,
      state,
      uploadFile,
    });

    const runPromise = executor.run("manual", {});
    await within(checkpointStarted.promise, "first checkpoint starts");
    await within(
      (async () => {
        while (!log.includes("upload-17-overlaps-checkpoint-1")) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })(),
      "second batch PUTs while the first checkpoint blocks",
    );
    releaseCheckpoint.resolve();
    const result = await within(runPromise, "pipeline round finishes");

    expect(result.errors).toBe(0);
    expect(result.uploaded).toBe(BATCH * 2);
    expect(state.baseSnapshot).toHaveLength(BATCH * 2);
    expect(state.mutationLedger).toEqual([]);

    // The state lane order is intents(2) → checkpoint(1); batch 2's PUTs began
    // before checkpoint 1 resolved (the overlap marker above). indexOf returns
    // -1 for a missing marker and -1 is still "less than" any positive index,
    // so the marker's existence must be asserted before the order.
    const secondIntentsEnd = log.indexOf("intents-end:2");
    expect(secondIntentsEnd).toBeGreaterThanOrEqual(0);
    expect(secondIntentsEnd).toBeLessThan(
      log.findIndex((line) => line.startsWith("checkpoint-start:1:")),
    );
    expect(checkpointCalls).toBe(2);
    const settled = diagLog.mock.calls
      .filter((call) => call[1] === "upload batch settled")
      .map((call) => call[2] as { batch?: number; overlapped?: boolean });
    expect(settled).toHaveLength(2);
    expect(settled.find((row) => row.batch === 0)?.overlapped).toBe(false);
    expect(settled.find((row) => row.batch === 1)?.overlapped).toBe(true);
  });

  it("flips both batches' rows when the first checkpoint fails after the second batch's PUTs", async () => {
    const allUploadsDone = deferred();
    let uploadCalls = 0;
    let checkpointCalls = 0;
    const state = makeActiveV2State([], []);
    state.commitMutationCheckpoints = vi.fn(async () => {
      checkpointCalls++;
      if (checkpointCalls === 1) await allUploadsDone.promise;
      throw new Error("checkpoint save failed");
    });
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      uploadCalls++;
      if (uploadCalls === BATCH * 2) allUploadsDone.resolve();
      return {
        id: `id:${path}`,
        eTag: `etag:${path}`,
        cTag: `ctag:${path}`,
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      };
    });
    const { executor } = await makeUploadScenario({
      fileCount: BATCH * 2,
      state,
      uploadFile,
    });
    const completed: string[] = [];
    const reverted: Array<{ path: string; reason: string }> = [];

    const result = await executor.run("manual", {
      onFileComplete: (path, _actionType, success) => {
        if (success) completed.push(path);
      },
      onFileReverted: (path, reason) => {
        reverted.push({ path, reason });
      },
    });

    expect(completed).toHaveLength(BATCH * 2);
    expect(reverted).toHaveLength(BATCH * 2);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(state.baseSnapshot).toEqual([]);
    // Batch 1's receipts are durable (written before its failed checkpoint);
    // batch 2 stopped at its intents because the pipeline failed. Both are
    // left for the next round's recovery, never replayed blindly.
    expect(state.mutationLedger).toHaveLength(BATCH * 2);
    expect(state.mutationLedger.filter((record) => record.receipt !== null))
      .toHaveLength(BATCH);
    expect(state.mutationLedger.filter((record) => record.receipt === null))
      .toHaveLength(BATCH);
  });

  it("keeps the intent-only window at two batches when the round cancels", async () => {
    const state = makeActiveV2State([], []);
    const beginIntents = state.beginMutationIntents.bind(state);
    let intentCalls = 0;
    let executor: SyncExecutor | null = null;
    state.beginMutationIntents = vi.fn(async (intents: MutationIntentV1[]) => {
      intentCalls++;
      await beginIntents(intents);
      if (intentCalls === 2) executor?.cancel();
    });
    const scenario = await makeUploadScenario({
      fileCount: BATCH * 3,
      state,
    });
    executor = scenario.executor;

    const result = await scenario.executor.run("manual", {});

    expect(result.success).toBe(false);
    // At most two batches of intents can be durable before cancellation; the
    // third batch never got an intent.
    const intentOnly = state.mutationLedger.filter((record) => record.receipt === null);
    expect(intentOnly.length).toBeLessThanOrEqual(BATCH * 2);
    expect(state.mutationLedger.length).toBeLessThanOrEqual(BATCH * 2);
    expect(state.baseSnapshot).toEqual([]);
    expect(scenario.uploadFile.mock.calls.length).toBeLessThan(BATCH * 3);
  });
});
