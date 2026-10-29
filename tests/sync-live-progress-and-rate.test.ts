// 运行中逐文件反馈与测速分母（执行器集成层）
//
// 钉住 2026-10-26 这一轮的三件用户可观察事实：
// 1. 计数按「已结算」走：8 个并发在飞时计数停在 0，每完成一个才 +1，
//    绝不按「已开始」成批跳（旧实现 1→8→16）；
// 2. 完成行逐条出现：第一个文件一结算就有行，不等整批共享检查点；
// 3. 测速分母是「忙碌墙钟」：8 并发跑在同一条固定总带宽链路上时，读数等于
//    单流跑同一链路的速度，而不是它的 1/8；空闲段不进入分母。
//
// 「处理中 N」徽标已按用户拍板（2026-10-27）整体退役：它唯一的消费者已删，
// 执行器的在飞快照也不再对外暴露（回归见 tests/sync-view.test.ts）。

import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import type { LocalFileEntry } from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import { UploadConcurrencyPolicy } from "../src/sync/upload-concurrency-policy";
import type { StateManager } from "../src/sync/state-manager";
import type { LocalScanner } from "../src/sync/local-scanner";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";
import {
  TransferRateSampler,
  deriveTransferRateFacts,
} from "../src/sync/transfer-rate";

const KIB = 1024;

/** Force the pool to its desktop ceiling from the first dispatch: the AIMD
 *  ramp is exercised by upload-adaptive-pool.test.ts, while these scenarios
 *  need a deterministic 8-deep pool. */
function pinUploadConcurrency(depth: number): () => void {
  const spy = vi.spyOn(UploadConcurrencyPolicy.prototype, "limit", "get")
    .mockReturnValue(depth);
  return () => spy.mockRestore();
}

interface ScenarioFile {
  path: string;
  size: number;
  content: ArrayBuffer;
}

async function makeScenario(input: {
  files: ScenarioFile[];
  uploadFile: (args: {
    path: string;
    content: ArrayBuffer;
    report: ((moved: number, total: number) => void) | undefined;
  }) => Promise<{
    id: string;
    eTag: string;
    parentReference: { id: string };
  }>;
  state?: StateManager;
}): Promise<{ executor: SyncExecutor; state: StateManager }> {
  const entries: LocalFileEntry[] = [];
  for (const file of input.files) {
    entries.push({
      path: file.path,
      size: file.size,
      mtime: 1,
      hash: await sha256Hex(file.content),
      binary: false,
    });
  }
  const contentByPath = new Map(
    input.files.map((file) => [file.path, file.content]),
  );
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const state = input.state ?? makeActiveV2State([], []);
  const executor = new SyncExecutor(
    makeMockOneDrive({
      uploadFile: vi.fn(async (
        _vault: string,
        path: string,
        content: ArrayBuffer,
        report?: (moved: number, total: number) => void,
      ) => input.uploadFile({ path, content, report })),
    }),
    {
      vault: {
        adapter: makeMockAdapter({
          readBinary: vi.fn(async (path: string) =>
            contentByPath.get(path)!.slice(0)),
        }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries,
        folders: [],
        folderScanComplete: true,
        folderScanFailures: [],
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      scanFile: vi.fn(async (path: string) => entryByPath.get(path) ?? null),
      inspectFile: vi.fn(async (path: string) => {
        const entry = entryByPath.get(path);
        return entry
          ? { status: "present" as const, entry }
          : { status: "missing" as const };
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    state,
    "testVault",
  );
  return { executor, state };
}

function uploadResult(path: string) {
  return {
    id: `id:${path}`,
    eTag: `etag:${path}`,
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

describe("live per-file progress", () => {
  it("counts settled files one by one while eight uploads are in flight", async () => {
    const restoreConcurrency = pinUploadConcurrency(8);
    const files: ScenarioFile[] = Array.from({ length: 8 }, (_, index) => ({
      path: `live-${index}.md`,
      size: 8,
      content: new ArrayBuffer(8),
    }));
    const gates: Array<() => void> = [];
    const { executor } = await makeScenario({
      files,
      uploadFile: async ({ path, content, report }) => {
        report?.(content.byteLength, content.byteLength);
        await new Promise<void>((resolve) => gates.push(resolve));
        return uploadResult(path);
      },
    });

    const progressEvents: Array<{ current: number; rowsSeen: number }> = [];
    const rows: Array<{ path: string; othersPending: number }> = [];
    try {
      const runPromise = executor.run("manual", {
        onProgress: (current) => {
          progressEvents.push({ current, rowsSeen: rows.length });
        },
        onFileComplete: (path) => {
          // How many PUTs are still pending when this row is reported.
          rows.push({ path, othersPending: gates.length });
        },
      });

      await waitUntil(() => gates.length === 8, "the pool to dispatch eight PUTs");
      // Nothing has finished, so nothing is counted yet (the whole point:
      // "started" is not progress).
      expect(progressEvents.at(-1)?.current).toBe(0);
      expect(rows).toHaveLength(0);

      // Finish one file: its row appears at once and its count lands with it,
      // while the other seven are still uploading (the old implementation
      // emitted no row at all until the whole batch settled).
      gates.shift()!();
      await waitUntil(() => rows.length === 1, "the first completed row");
      await waitUntil(
        () => progressEvents.at(-1)?.current === 1,
        "the counter to advance to one",
      );
      // The row was reported while other files were still uploading (the item
      // itself is still inside its own settle).
      expect(rows[0].othersPending).toBeGreaterThan(1);

      for (const release of gates.splice(0, gates.length)) release();
      const result = await runPromise;

      expect(result.success).toBe(true);
      expect(result.uploaded).toBe(8);
      expect(rows).toHaveLength(8);
      expect(progressEvents.at(-1)?.current).toBe(8);
    } finally {
      restoreConcurrency();
    }

    // The counter never runs ahead of the files that actually finished: every
    // progress event carries at most one settled row's worth of count. The
    // start-based counter jumped to 8 before the first row even existed.
    for (const event of progressEvents) {
      expect(event.current).toBeLessThanOrEqual(event.rowsSeen);
    }
    // And it moves one at a time, never in batches.
    for (let index = 1; index < progressEvents.length; index++) {
      expect(progressEvents[index].current - progressEvents[index - 1].current)
        .toBeLessThanOrEqual(1);
    }
  });

  it("reports rows as they are produced, not only after the batch checkpoint", async () => {
    const restoreConcurrency = pinUploadConcurrency(8);
    const files: ScenarioFile[] = Array.from({ length: 8 }, (_, index) => ({
      path: `row-${index}.md`,
      size: 8,
      content: new ArrayBuffer(8),
    }));
    const gates: Array<() => void> = [];
    const { executor } = await makeScenario({
      files,
      uploadFile: async ({ path, content, report }) => {
        report?.(content.byteLength, content.byteLength);
        await new Promise<void>((resolve) => gates.push(resolve));
        return uploadResult(path);
      },
    });

    const rowTimes: Array<{ path: string; othersPending: number }> = [];
    try {
      const runPromise = executor.run("manual", {
        onFileComplete: (path) => {
          rowTimes.push({ path, othersPending: gates.length });
        },
      });
      await waitUntil(() => gates.length === 8, "the pool to dispatch eight PUTs");

      // Release the first file only. Its row must already be there, while
      // seven PUTs are still in flight and the batch checkpoint has not run.
      gates.shift()!();
      await waitUntil(() => rowTimes.length === 1, "the first row before batch end");
      expect(rowTimes[0].othersPending).toBeGreaterThan(0);

      for (const release of gates.splice(0, gates.length)) release();
      await runPromise;
      expect(rowTimes).toHaveLength(8);
    } finally {
      restoreConcurrency();
    }
  });
});

describe("transfer rate denominator", () => {
  /** One round on a fixed-aggregate link: `fileCount` files of `bytesEach`
   *  move their bytes over `holdMs` of wall clock, all at once. */
  async function runLinkRound(input: {
    fileCount: number;
    bytesEach: number;
    holdMs: number;
  }): Promise<{ kbps: number | null; ms: number; bytes: number }> {
    const restoreConcurrency = pinUploadConcurrency(input.fileCount);
    const files: ScenarioFile[] = Array.from(
      { length: input.fileCount },
      (_, index) => ({
        path: `link-${index}.bin`,
        size: input.bytesEach,
        content: new ArrayBuffer(input.bytesEach),
      }),
    );
    try {
      const { executor } = await makeScenario({
        files,
        uploadFile: async ({ path, content, report }) => {
          report?.(content.byteLength, content.byteLength);
          await sleep(input.holdMs);
          return uploadResult(path);
        },
      });
      const result = await executor.run("manual", {});
      expect(result.success).toBe(true);
      const facts = deriveTransferRateFacts({
        endedAt: Date.now(),
        fileTransfers: result.metrics?.fileTransfers,
      });
      expect(facts).not.toBeNull();
      return {
        kbps: facts
          ? Math.round((facts.uploadBytes ?? 0) / 1024 / ((facts.uploadMs ?? 0) / 1000))
          : null,
        ms: facts?.uploadMs ?? 0,
        bytes: facts?.uploadBytes ?? 0,
      };
    } finally {
      restoreConcurrency();
    }
  }

  it("reads the link's throughput for eight parallel streams, not the link divided by eight", async () => {
    // The link moves 1 MiB per second in total: one stream takes the whole
    // 1024 KiB in one second, eight parallel streams get 128 KiB each in the
    // same second. Both must read the same figure — the old denominator (the
    // sum of the eight calls' own 1 s durations = 8 s) read 128 KB/s, i.e. the
    // link divided by the concurrency.
    const single = await runLinkRound({
      fileCount: 1,
      bytesEach: 1024 * KIB,
      holdMs: 1000,
    });
    const parallel = await runLinkRound({
      fileCount: 8,
      bytesEach: 128 * KIB,
      holdMs: 1000,
    });

    expect(single.bytes).toBe(1024 * KIB);
    expect(parallel.bytes).toBe(1024 * KIB);
    // Eight calls each lasting a second are one second of busy time. A little
    // scheduling slack is fine; a sum-of-durations denominator would be ~8000.
    expect(parallel.ms).toBeGreaterThanOrEqual(900);
    expect(parallel.ms).toBeLessThan(2_000);
    // Same link, same reading — not 1/8 of it (128 KB/s is the failing value).
    expect(parallel.kbps).toBeGreaterThan(single.kbps! * 0.8);
    expect(parallel.kbps).toBeLessThan(single.kbps! * 1.2);
    expect(parallel.kbps).toBeGreaterThan(700);

    // And the same snapshot through the sampler (the displayed number) reads
    // the link, not 1/8 of it.
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    sampler.sampleRunTick(
      {
        upload: { bytes: parallel.bytes, ms: parallel.ms },
        download: { bytes: 0, ms: 0 },
      },
      10_000,
    );
    const reading = sampler.getReading(10_000);
    expect(reading?.level).toBe("medium");
    expect(reading?.kbps ?? 0).toBeGreaterThan(700);
  });

  it("books a whole-body upload's busy time from its pre-dispatch signal, not its post-settle report", async () => {
    // uploadFile 的真实形状：PUT 派发前发 (0, size)，整包字节在 PUT 期间移动，
    // (size, size) 在结算后才补发。开表若等 downloaded>0，整个几 MB 的负载只
    // 记到 0–1 ms 忙时，采样器折出「每毫秒几 MB」的样本——真机 2026-10-28
    // 开屏即读 2694.5 MB/s。忙时必须从派发前信号起算，覆盖整个请求窗口。
    const restoreConcurrency = pinUploadConcurrency(1);
    const bytesEach = 2800 * KIB;
    const files: ScenarioFile[] = [
      { path: "whole-body.bin", size: bytesEach, content: new ArrayBuffer(bytesEach) },
    ];
    try {
      const { executor } = await makeScenario({
        files,
        uploadFile: async ({ path, content, report }) => {
          report?.(0, content.byteLength);
          await sleep(800);
          report?.(content.byteLength, content.byteLength);
          return uploadResult(path);
        },
      });
      const result = await executor.run("manual", {});
      expect(result.success).toBe(true);
      const facts = deriveTransferRateFacts({
        endedAt: Date.now(),
        fileTransfers: result.metrics?.fileTransfers,
      });
      expect(facts).not.toBeNull();
      expect(facts?.uploadBytes).toBe(bytesEach);
      // 整个 PUT 窗口都是忙时，而不只是事后补发那一下。
      expect(facts?.uploadMs ?? 0).toBeGreaterThanOrEqual(700);
      const kbps = (facts?.uploadBytes ?? 0) / 1024 / ((facts?.uploadMs ?? 0) / 1000);
      // 这条链路上 ≈3.4 MB/s；中毒形状读出来是几千 MB/s。
      expect(kbps).toBeGreaterThan(2_500);
      expect(kbps).toBeLessThan(6_000);
    } finally {
      restoreConcurrency();
    }
  });

  it("does not let an idle gap dilute the reading", async () => {
    const restoreConcurrency = pinUploadConcurrency(2);
    const files: ScenarioFile[] = [
      { path: "idle-a.bin", size: 512 * KIB, content: new ArrayBuffer(512 * KIB) },
      { path: "idle-b.bin", size: 512 * KIB, content: new ArrayBuffer(512 * KIB) },
    ];
    try {
      let uploadsStarted = 0;
      const { executor } = await makeScenario({
        files,
        uploadFile: async ({ path, content, report }) => {
          uploadsStarted++;
          report?.(content.byteLength, content.byteLength);
          await sleep(500);
          return uploadResult(path);
        },
      });
      const firstTick = executor.run("manual", {});
      // Wait for both PUTs to be in flight, then let the round settle and
      // sample again after a long idle gap: the busy clock must not advance
      // while nothing transfers, so Δms = 0 and no sample is folded.
      await waitUntil(
        () => uploadsStarted === 2,
        "the two PUTs to start",
      );
      await firstTick;
      const settled = executor.getActiveTransferMetrics();
      expect(settled).not.toBeNull();
      const sampler = new TransferRateSampler();
      sampler.beginRun();
      sampler.sampleRunTick(settled!, Date.now());
      const beforeIdle = sampler.getReading();
      // 1 MiB over ~0.5 s ≈ 2 MB/s; the exact figure carries scheduling slack.
      expect(beforeIdle?.kbps ?? 0).toBeGreaterThan(1_800);
      expect(beforeIdle?.kbps ?? 0).toBeLessThan(2_200);

      await sleep(300);
      const afterIdle = executor.getActiveTransferMetrics();
      // Idle time is not busy time: the denominator is unchanged.
      expect(afterIdle?.upload.ms).toBe(settled?.upload.ms);
      sampler.sampleRunTick(afterIdle!, Date.now());
      expect(sampler.getReading()).toEqual(beforeIdle);
    } finally {
      restoreConcurrency();
    }
  });
});
