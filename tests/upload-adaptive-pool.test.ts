// 上传常驻工作池 + 自适应升降（执行器集成层）
// 钉住四件用户可观察的事：稳定链路下并发真的会从 2 爬到 8 并停住；一个慢文件
// 不会挡住别人的槽位（旧波次模型的 Promise.all 屏障消失）；429/509 期间任何新的
// 上传请求都不发出、并发减半、之后还能爬回；单件失败只落在它自己身上且不降并发；
// 取消落在池内仍只留一批 intent-only。

import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import type {
  LocalFileEntry,
  MutationLedgerEntryV1,
} from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { StateManager } from "../src/sync/state-manager";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import { UploadConcurrencyPolicy } from "../src/sync/upload-concurrency-policy";
import {
  OneDriveError,
  OneDriveErrorType,
} from "../src/onedrive/types";
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

interface DiagLine {
  level: "log" | "warn";
  msg: string;
  data: Record<string, unknown>;
}

function makeDiagRecorder(): {
  diag: DiagnosticLogger;
  lines: DiagLine[];
  concurrencySteps: () => Array<Record<string, unknown>>;
} {
  const lines: DiagLine[] = [];
  const record = (level: DiagLine["level"]) => (
    _category: string,
    msg: string,
    data?: unknown,
  ): void => {
    lines.push({
      level,
      msg,
      data: (data ?? {}) as Record<string, unknown>,
    });
  };
  const diag = {
    log: vi.fn(record("log")),
    warn: vi.fn(record("warn")),
    error: vi.fn(record("warn")),
    // The mock OneDrive has no per-endpoint run metrics; keep that collection
    // off while still recording every `execute` line this test reads.
    isEnabled: vi.fn((category: string) => category !== "onedrive"),
  } as unknown as DiagnosticLogger;
  return {
    diag,
    lines,
    concurrencySteps: () => lines
      .filter((line) => line.msg.startsWith("upload concurrency"))
      .map((line) => line.data),
  };
}

interface PoolScenario {
  executor: SyncExecutor;
  state: StateManager;
  uploadFile: ReturnType<typeof vi.fn>;
  lines: DiagLine[];
  concurrencySteps: () => Array<Record<string, unknown>>;
}

async function makePoolScenario(input: {
  fileCount: number;
  state?: StateManager;
  uploadFile?: ReturnType<typeof vi.fn>;
  /** Per-file byte sizes (source order). Zero-padded paths keep the plan's
   *  lexical order equal to this order, so a size ladder lines up with the
   *  pool's dispatch order. */
  sizes?: number[];
  /** Fires when the executor reads a file's content for an upload — the
   *  dispatch-decision probe: the read starts in the same drain as the pool's
   *  dispatch, before the hash's thread-pool hop. */
  onContentRead?: (path: string) => void;
}): Promise<PoolScenario> {
  const sizes = Array.from(
    { length: input.fileCount },
    (_, index) => input.sizes?.[index] ?? CONTENT.byteLength,
  );
  const contentBySize = new Map<number, ArrayBuffer>();
  const hashBySize = new Map<number, string>();
  for (const size of new Set(sizes)) {
    const content = new ArrayBuffer(size);
    contentBySize.set(size, content);
    hashBySize.set(size, await sha256Hex(content));
  }
  const localEntries: LocalFileEntry[] = sizes.map((size, index) => ({
    path: `pool-${String(index).padStart(2, "0")}.md`,
    hash: hashBySize.get(size)!,
    size,
    mtime: index + 1,
    binary: false,
  }));
  const uploadFile = input.uploadFile ?? vi.fn(async (_vault: string, path: string) => ({
    id: `id:${path}`,
    eTag: `etag:${path}`,
    cTag: `ctag:${path}`,
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
  }));
  const state = input.state ?? makeActiveV2State([], []);
  const { diag, lines, concurrencySteps } = makeDiagRecorder();
  const executor = new SyncExecutor(
    makeMockOneDrive({ uploadFile }),
    {
      vault: {
        adapter: makeMockAdapter({
          readBinary: vi.fn(async (path: string) => {
            input.onContentRead?.(path);
            const entry = localEntries.find((candidate) => candidate.path === path);
            return contentBySize.get(entry?.size ?? CONTENT.byteLength)!;
          }),
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
    diag,
  );
  return { executor, state, uploadFile, lines, concurrencySteps };
}

function okUpload(path: string) {
  return {
    id: `id:${path}`,
    eTag: `etag:${path}`,
    cTag: `ctag:${path}`,
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Largest number of intervals overlapping at one instant. */
function maxOverlap(
  intervals: ReadonlyArray<{ start: number; end: number }>,
): number {
  const events = intervals.flatMap((entry) => [
    { at: entry.start, delta: 1 },
    { at: entry.end, delta: -1 },
  ]);
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

describe("adaptive upload pool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("climbs from two to eight on rising per-file throughput, then holds the ceiling", async () => {
    // Controlled stub: every PUT takes the same 20 ms, and each AIMD window
    // carries twice the bytes of the one before (8 → 16 → 32 … bytes), so the
    // measured throughput of a window always beats the previous windows'
    // median and the pool must step up. A constant *rate* cannot be used here:
    // the policy compares a window against the previous window, so equal
    // samples are a coin flip by design (the deterministic flat-rate climb is
    // pinned in upload-concurrency-policy.test.ts).
    let active = 0;
    let peak = 0;
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
      return okUpload(path);
    });
    const sizes = Array.from(
      { length: 36 },
      (_, index) => 8 * 2 ** Math.floor(index / 4),
    );
    const scenario = await makePoolScenario({ fileCount: 36, sizes, uploadFile });

    const result = await scenario.executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(36);
    expect(result.errors).toBe(0);

    // Six AIMD windows of four successes: 2 → 3 → … → 8. Under load a window
    // whose measured throughput dipped is correctly held (no step line), so
    // the contract is "climbs monotonically to the ceiling and never
    // regresses", not "exactly one step per window".
    const steps = scenario.concurrencySteps();
    const ladder = steps.map((step) => step.to);
    expect(ladder.at(-1)).toBe(8);
    expect(ladder).toEqual([...ladder].sort((left, right) => left - right));
    expect(new Set(ladder).size).toBe(ladder.length);
    expect(steps.every((step) => step.reason === "ramp-up")).toBe(true);
    // The ceiling is real: eight PUTs ran at once and the run ended there.
    expect(peak).toBe(8);
    const batches = scenario.lines
      .filter((line) => line.msg === "upload batch settled")
      .map((line) => line.data.concurrency);
    expect(batches.at(-1)).toBe(8);
  });

  it("lets a freed slot take the next file instead of waiting for a slow one", async () => {
    const events: Array<{ kind: "start" | "end"; path: string }> = [];
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      events.push({ kind: "start", path });
      await sleep(path === "pool-00.md" ? 150 : 2);
      events.push({ kind: "end", path });
      return okUpload(path);
    });
    const scenario = await makePoolScenario({ fileCount: 3, uploadFile });

    await scenario.executor.run("manual", {});

    // Two slots, no ramp inside three files. The old wave model ran `pool-00`
    // and `pool-01` behind one Promise.all, so `pool-02` could not start before
    // both settled; the resident pool refills the slot `pool-01` frees.
    // Ordering comes from one event log, so a scheduler stall cannot flip the
    // comparison the way two wall-clock samples could.
    const indexOf = (kind: "start" | "end", path: string): number =>
      events.findIndex((event) => event.kind === kind && event.path === path);
    expect(indexOf("start", "pool-02.md")).toBeGreaterThanOrEqual(0);
    expect(indexOf("start", "pool-02.md"))
      .toBeLessThan(indexOf("end", "pool-00.md"));
    expect(indexOf("end", "pool-01.md"))
      .toBeLessThan(indexOf("end", "pool-00.md"));
  });

  it("pauses the whole direction for Retry-After on a 429, halves, then climbs", async () => {
    const dispatchAt = new Map<string, number>();
    let pauseRegisteredAt = 0;
    const originalNoteThrottle = UploadConcurrencyPolicy.prototype.noteThrottle;
    vi.spyOn(UploadConcurrencyPolicy.prototype, "noteThrottle")
      .mockImplementation(function (
        this: UploadConcurrencyPolicy,
        nowMs: number,
        retryAfterSeconds: number | null | undefined,
      ) {
        pauseRegisteredAt = nowMs;
        return originalNoteThrottle.call(this, nowMs, retryAfterSeconds);
      });
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      if (path === "pool-00.md") {
        await sleep(5);
        throw new OneDriveError(
          OneDriveErrorType.RateLimited,
          "HTTP 429",
          429,
          0.08,
        );
      }
      await sleep(2);
      return okUpload(path);
    });
    const scenario = await makePoolScenario({
      fileCount: 6,
      uploadFile,
      onContentRead: (path) => {
        if (!dispatchAt.has(path)) dispatchAt.set(path, Date.now());
      },
    });

    const result = await scenario.executor.run("manual", {});

    expect(result.errors).toBe(1);
    expect(result.uploaded).toBe(5);

    // The throttle halved the pool and paused the direction.
    const steps = scenario.concurrencySteps();
    expect(steps).toMatchObject([{ from: 2, to: 1, reason: "throttle" }]);
    expect(scenario.lines.some((line) =>
      line.level === "warn" && line.msg.includes("upload throttled")))
      .toBe(true);

    // No upload is *decided* inside the Retry-After window (80 ms). The
    // decision is the content read: it starts in the same drain as the pool's
    // dispatch, while the PUT entry lags behind the local hash and can drift
    // into the window under load. Requests already in flight when the 429
    // landed cannot be recalled — their decisions predate the registration
    // and stay legal.
    const pauseWindowEnd = pauseRegisteredAt + 80;
    const decidedInsidePause = [...dispatchAt.entries()].filter(
      ([, at]) => at >= pauseRegisteredAt && at < pauseWindowEnd,
    );
    expect(decidedInsidePause).toEqual([]);
    // The remaining files were still dispatched after the pause.
    expect(Math.max(...dispatchAt.values()))
      .toBeGreaterThanOrEqual(pauseWindowEnd);
  });

  it("does not lower concurrency for a single timed-out file", async () => {
    const intervals: Array<{ path: string; start: number; end: number }> = [];
    let failedAt = 0;
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      const start = Date.now();
      if (path === "pool-03.md") {
        failedAt = start;
        throw new OneDriveError(
          OneDriveErrorType.NetworkError,
          "Upload timed out",
        );
      }
      await sleep(50);
      intervals.push({ path, start, end: Date.now() });
      return okUpload(path);
    });
    const scenario = await makePoolScenario({ fileCount: 8, uploadFile });

    const result = await scenario.executor.run("manual", {});

    expect(result.errors).toBe(1);
    expect(result.uploaded).toBe(7);
    const failures = scenario.lines.filter((line) =>
      line.msg.startsWith("upload concurrency")
      && line.data.reason === "regression");
    expect(failures).toEqual([]);
    // The pool keeps its depth after the timeout: the files that start after
    // it still overlap. The old policy locked the rest of the round to serial
    // here, so this is the assertion that separates the two implementations.
    const afterFailure = intervals.filter((entry) => entry.start > failedAt);
    expect(maxOverlap(afterFailure)).toBeGreaterThanOrEqual(2);

    // The next round retries that file alone: everything else is committed in
    // the base and produces no new PUT.
    const second = await makePoolScenario({
      fileCount: 8,
      state: scenario.state,
      uploadFile: vi.fn(async (_vault: string, path: string) => {
        await sleep(2);
        return okUpload(path);
      }),
    });
    const retried = await second.executor.run("manual", {});

    expect(retried.success).toBe(true);
    expect(retried.uploaded).toBe(1);
    expect(second.uploadFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(second.uploadFile).mock.calls[0][1]).toBe("pool-03.md");
  });

  it("leaves at most one batch of intent-only uploads when the round cancels inside the pool", async () => {
    let executor: SyncExecutor | null = null;
    const finished: string[] = [];
    const uploadFile = vi.fn(async (_vault: string, path: string) => {
      await sleep(2);
      finished.push(path);
      if (finished.length === 3) executor?.cancel();
      return okUpload(path);
    });
    const first = await makePoolScenario({ fileCount: BATCH + 4, uploadFile });
    executor = first.executor;

    const cancelled = await first.executor.run("manual", {});

    expect(cancelled.success).toBe(false);
    expect(first.uploadFile.mock.calls.length).toBeLessThan(BATCH + 4);
    // One batch is in flight at most: its intents are durable, and the members
    // that never reached their PUT stay intent-only for the next round.
    const ledger: MutationLedgerEntryV1[] = first.state.mutationLedger;
    expect(ledger.length).toBe(BATCH);
    const receipted = ledger.filter((record) => record.receipt !== null);
    const intentOnly = ledger.filter((record) => record.receipt === null);
    expect(receipted.length).toBeGreaterThan(0);
    expect(intentOnly.length).toBeGreaterThan(0);

    // Next round: SC-15's third rule — the un-receipted members are settled by
    // observation, so a cancel inside the pool never leaves an intent-only
    // record behind for a third round. (The receipted members wait on the
    // pre-existing receipted-recovery lane, which is outside this slice.)
    const second = await makePoolScenario({
      fileCount: BATCH + 4,
      state: first.state,
      uploadFile: vi.fn(async (_vault: string, path: string) => {
        await sleep(1);
        return okUpload(path);
      }),
    });
    const recovered = await second.executor.run("manual", {});

    expect(recovered.success).toBe(true);
    const remaining = second.state.mutationLedger;
    expect(remaining).toHaveLength(receipted.length);
    expect(remaining.every((record) => record.receipt !== null)).toBe(true);
    // Every file that had not uploaded yet went out in this round.
    expect(second.uploadFile.mock.calls.length)
      .toBeGreaterThanOrEqual(intentOnly.length);
  });

  it("reports upload summary time on the busy wall clock, not per-call sums", async () => {
    // Eight concurrent 20 ms PUTs: their summed call wall clock (~160 ms) is
    // the old `networkMs` figure, while the direction's busy wall clock is
    // about one 20 ms span. The live reading already uses busyMs, so the
    // round summary must expose the same denominator.
    const limit = vi.spyOn(UploadConcurrencyPolicy.prototype, "limit", "get")
      .mockReturnValue(BATCH);
    try {
      const uploadFile = vi.fn(async (
        _vault: string,
        path: string,
        _content: ArrayBuffer,
        report?: (moved: number, total: number) => void,
      ) => {
        report?.(1, 1);
        await sleep(20);
        return okUpload(path);
      });
      const scenario = await makePoolScenario({ fileCount: BATCH, uploadFile });

      await scenario.executor.run("manual", {});

      const summary = scenario.lines.find((line) =>
        line.msg.startsWith("upload summary —"));
      expect(summary).toBeDefined();
      expect(summary!.msg).toContain("busyMs=");
      expect(summary!.msg).not.toContain("networkMs=");
      const busyMs = Number(/busyMs=(\d+)/.exec(summary!.msg)![1]);
      const elapsedMs = Number(/elapsedMs=(\d+)/.exec(summary!.msg)![1]);
      // A busy wall clock is always a subset of the phase's own wall clock;
      // the retired per-call sum could exceed it at concurrency > 1.
      expect(busyMs).toBeLessThanOrEqual(elapsedMs);
    } finally {
      limit.mockRestore();
    }
  });

  it("reports the shared checkpoint's phase breakdown on the batch row", async () => {
    // The checkpoint commit owns the decomposition; the batch row must carry
    // the same snapshot beside `checkpointMs` so one row answers where the
    // checkpoint's wall clock went. The values are whatever the commit
    // reported — the executor only references them.
    const breakdown = {
      queueMs: 1,
      buildMs: 2,
      canonicalMs: 3,
      recoveryMs: 4,
      idbMs: 5,
      ledgerMs: 6,
      pluginDataMs: 7,
      totalMs: 28,
      build: {
        prepareMs: 0,
        cloneMs: 0,
        reduceMs: 1,
        validateMs: 1,
        diffMs: 0,
      },
    };
    const checkpointCommit = vi.fn(async () => ({
      operations: BATCH,
      ancestorPublishMs: 0,
      v2CommitMs: 0,
      ledgerClearMs: 0,
      totalMs: 28,
      breakdown,
    }));
    const state = makeActiveV2State([], []);
    // The fake state renders its own checkpoint result, so the override has to
    // land after the fixture builds its methods.
    state.commitMutationCheckpoints = checkpointCommit;
    const scenario = await makePoolScenario({
      fileCount: BATCH,
      state,
      uploadFile: vi.fn(async (_vault: string, path: string) => okUpload(path)),
    });

    await scenario.executor.run("manual", {});

    expect(checkpointCommit).toHaveBeenCalledTimes(1);
    const rows = scenario.lines.filter(
      (line) => line.msg === "upload batch settled",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.checkpointBreakdown).toEqual(breakdown);
  });
});
