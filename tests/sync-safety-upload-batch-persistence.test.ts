// 上传波（每批一次意图／回执／检查点）
// 上传池原先按并发派生波大小、逐文件写意图与回执；现在一批（桌面 8／手机 4）
// 只付一次意图写、一次回执写与一次共享检查点。本文件钉住该持久化粒度、批内
// 单独失败的原出口，以及取消落在批内时留下的 intent-only 窗口能被下一轮结算。

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
/** Desktop persistence batch (`UPLOAD_CHECKPOINT_BATCH`); the test env runs
 *  the desktop build, where a full batch is eight files. */
const BATCH = 8;

interface UploadScenario {
  executor: SyncExecutor;
  state: StateManager;
  localEntries: LocalFileEntry[];
  uploadFile: ReturnType<typeof vi.fn>;
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
      path: `batch-${index}.md`,
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
  );
  return { executor, state, localEntries, uploadFile };
}

function intentForPath(
  intents: MutationIntentV1[],
  path: string,
): MutationIntentV1 {
  const intent = intents.find((candidate) => candidate.path === path);
  if (!intent) throw new Error(`upload intent missing for ${path}`);
  return intent;
}

describe("small-upload persistence batches", () => {
  it("pays one intent write, one receipt write and one checkpoint per eight-file batch", async () => {
    const { executor, state, uploadFile } = await makeUploadScenario({
      fileCount: BATCH,
    });

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(BATCH);
    expect(result.errors).toBe(0);

    const beginMutationIntents = vi.mocked(state.beginMutationIntents);
    const recordMutationReceipts = vi.mocked(state.recordMutationReceipts);
    const commitMutationCheckpoints = vi.mocked(state.commitMutationCheckpoints);

    // One whole-data write per phase, never one per file: this is what made a
    // 2,100-file upload pay 525–1,050 whole-envelope commits and ~4,700
    // `data.json` writes.
    expect(beginMutationIntents).toHaveBeenCalledTimes(1);
    expect(beginMutationIntents.mock.calls[0][0]).toHaveLength(BATCH);
    expect(recordMutationReceipts).toHaveBeenCalledTimes(1);
    expect(recordMutationReceipts.mock.calls[0][0]).toHaveLength(BATCH);
    expect(commitMutationCheckpoints).toHaveBeenCalledTimes(1);
    expect(commitMutationCheckpoints.mock.calls[0][0]).toHaveLength(BATCH);
    expect(state.commitMutationCheckpoint).not.toHaveBeenCalled();

    // SC-15 order: the whole batch's intents are durable before its first PUT,
    // every receipt is durable before the shared checkpoint publishes.
    expect(beginMutationIntents.mock.invocationCallOrder[0])
      .toBeLessThan(uploadFile.mock.invocationCallOrder[0]);
    expect(recordMutationReceipts.mock.invocationCallOrder[0])
      .toBeGreaterThan(uploadFile.mock.invocationCallOrder[BATCH - 1]);
    expect(commitMutationCheckpoints.mock.invocationCallOrder[0])
      .toBeGreaterThan(recordMutationReceipts.mock.invocationCallOrder[0]);

    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toHaveLength(BATCH);
    expect(state.baseSnapshot).toHaveLength(BATCH);
  });

  it("keeps a failed member on its own exit while the other seven settle in the batch", async () => {
    const failingPath = "batch-2.md";
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      if (path === failingPath) throw new Error("upload failed");
      return {
        id: `id:${path}`,
        eTag: `etag:${path}`,
        cTag: `ctag:${path}`,
        parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
      };
    });
    const { executor, state } = await makeUploadScenario({
      fileCount: BATCH,
      uploadFile,
    });
    const onFileComplete = vi.fn();

    const result = await executor.run("manual", { onFileComplete });

    expect(result.errors).toBe(1);
    expect(result.uploaded).toBe(BATCH - 1);
    const intents = vi.mocked(state.beginMutationIntents)
      .mock.calls[0][0] as MutationIntentV1[];
    expect(intents).toHaveLength(BATCH);
    const failedIntent = intentForPath(intents, failingPath);

    // The seven successes still share one receipt write and one checkpoint.
    const receipts = vi.mocked(state.recordMutationReceipts)
      .mock.calls[0][0] as MutationReceiptV1[];
    expect(receipts).toHaveLength(BATCH - 1);
    expect(receipts.some((receipt) =>
      receipt.operationId === failedIntent.operationId)).toBe(false);
    const checkpointed = vi.mocked(state.commitMutationCheckpoints)
      .mock.calls[0][0] as string[];
    expect(checkpointed).toHaveLength(BATCH - 1);
    expect(checkpointed).not.toContain(failedIntent.operationId);

    // The failed member keeps the ordinary per-file failure exit: its intent is
    // abandoned (never receipted) and it reports one failed completion.
    expect(state.abandonMutationIntent).toHaveBeenCalledWith(
      failedIntent.operationId,
    );
    expect(state.mutationLedger).toEqual([]);
    expect(onFileComplete).toHaveBeenCalledTimes(BATCH);
    const successes = onFileComplete.mock.calls.filter((call) => call[2] === true);
    const failures = onFileComplete.mock.calls.filter((call) => call[2] === false);
    expect(successes).toHaveLength(BATCH - 1);
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe(failingPath);
    expect(state.remoteSnapshot).toHaveLength(BATCH - 1);
  });

  it("leaves at most one batch of intent-only uploads when the round cancels inside it", async () => {
    let executor: SyncExecutor;
    const state = makeActiveV2State([], []);
    const batchIntents = vi.mocked(state.beginMutationIntents);
    state.beginMutationIntents = vi.fn(async (intents) => {
      await batchIntents(intents);
      // Cancellation after the batch's intent write but before its first PUT:
      // the durable window a crash in the same spot would leave behind.
      executor.cancel();
    });
    const firstRun = await makeUploadScenario({
      fileCount: BATCH + 2,
      state,
    });
    executor = firstRun.executor;

    const cancelled = await executor.run("manual", {});

    expect(cancelled.success).toBe(false);
    expect(cancelled.uploaded).toBe(0);
    expect(firstRun.uploadFile).not.toHaveBeenCalled();
    // Exactly one batch is in flight: the two files of the next batch never got
    // an intent, so the crash window stays bounded by the batch and does not
    // grow with the vault.
    expect(state.mutationLedger).toHaveLength(BATCH);
    expect(state.mutationLedger.every((record) => record.receipt === null))
      .toBe(true);
    expect(vi.mocked(state.recordMutationReceipts)).not.toHaveBeenCalled();
    expect(vi.mocked(state.commitMutationCheckpoints)).not.toHaveBeenCalled();
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.baseSnapshot).toEqual([]);

    // Next round: the same recovery path the ordinary crash case uses observes
    // every intent-only upload (absent remotely) and abandons it before
    // planning, so the files upload normally instead of staying blocked.
    state.beginMutationIntents = batchIntents;
    const secondRun = await makeUploadScenario({
      fileCount: BATCH + 2,
      state,
    });
    const recovered = await secondRun.executor.run("manual", {});

    expect(recovered.success).toBe(true);
    expect(recovered.uploaded).toBe(BATCH + 2);
    expect(secondRun.uploadFile).toHaveBeenCalledTimes(BATCH + 2);
    expect(state.mutationLedger).toEqual([]);
    expect(state.remoteSnapshot).toHaveLength(BATCH + 2);
    expect(state.baseSnapshot).toHaveLength(BATCH + 2);
  });
});
