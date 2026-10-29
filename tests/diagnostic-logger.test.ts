import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { DiagnosticLogger, MAX_PENDING } from "../src/sync/diagnostic-logger";

function makeAdapter() {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true),
    read: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1000 }), // 1KB per file → well under limits
    list: vi.fn().mockResolvedValue({
      files: Array.from(
        { length: 9 },
        (_, index) => `.obsidian/plugins/easy-sync/logs/2026-07-${String(index + 1).padStart(2, "0")}.jsonl`,
      ),
      folders: [],
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  } as unknown as DataAdapter;
}

describe("DiagnosticLogger disk flush", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates the daily log once, then appends without reading history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00+08:00"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const adapter = makeAdapter();
    const logger = new DiagnosticLogger();
    logger.setAdapter(adapter);
    logger.enableAll();

    logger.log("scan", "first");
    await logger.dispose();
    logger.log("scan", "second");
    await logger.dispose();

    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(adapter.append).toHaveBeenCalledTimes(1);
    expect(adapter.list).toHaveBeenCalledTimes(1);
    // Files older than 7 days are pruned (Jul 1-5 of 9 mock files, cutoff = Jul 6)
    expect(adapter.remove).toHaveBeenCalledTimes(5);
  });

  it("snapshot includes pending entries that have not been flushed to disk", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const adapter = makeAdapter();
    // Simulate: disk has yesterday's entries.  Today's entries are pending.
    adapter.read.mockResolvedValue(
      JSON.stringify({ ts: 1000, cat: "scan", lvl: "log", msg: "disk-entry" }) + "\n",
    );
    const logger = new DiagnosticLogger();
    logger.setAdapter(adapter);
    logger.enableAll();

    // Log entries that go into pending (timer not advanced)
    logger.warn("onedrive", "download failed");
    logger.error("execute", "sync aborted");

    // snapshot() should flush pending then merge disk + buffer
    const { entries: result } = await logger.snapshot(500);

    // All three entries present: 1 from disk, 2 from pending
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some((e) => e.msg === "disk-entry")).toBe(true);
    expect(result.some((e) => e.msg === "download failed")).toBe(true);
    expect(result.some((e) => e.msg === "sync aborted")).toBe(true);
  });
});

describe("DiagnosticLogger durability hardening", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("flushes warn/error lines immediately instead of waiting for the batch window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = makeAdapter();
    const logger = new DiagnosticLogger();
    logger.setAdapter(adapter);
    logger.enableAll();

    logger.warn("execute", "round failed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(String(adapter.write.mock.calls[0][1])).toContain("round failed");
  });

  it("flushes explicitly urgent summary lines immediately and keeps plain lines batched", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const adapter = makeAdapter();
    const logger = new DiagnosticLogger();
    logger.setAdapter(adapter);
    logger.enableAll();

    logger.log("execute", "sync run phase summary", { status: "failed" }, { urgent: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.write).toHaveBeenCalledTimes(1);

    logger.log("execute", "plain batched line");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(adapter.write).toHaveBeenCalledTimes(1);

    await logger.dispose();
    const written = [
      ...adapter.write.mock.calls.map((call) => String(call[1])),
      ...adapter.append.mock.calls.map((call) => String(call[1])),
    ].join("");
    expect(written).toContain("plain batched line");
  });

  it("drops the oldest pending entries beyond the cap and reports the drop", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = makeAdapter();
    const logger = new DiagnosticLogger();
    logger.setAdapter(adapter);
    logger.enableAll();

    logger.log("scan", "oldest-entry");
    for (let i = 0; i < MAX_PENDING + 2; i++) {
      logger.log("scan", `entry-${i}`);
    }
    await logger.dispose();

    const written = adapter.write.mock.calls.map((call) => String(call[1])).join("");
    expect(written).not.toContain("oldest-entry");
    expect(written).toContain("backlog overflow");
    expect(written).toContain("dropped 3");
    expect(written).toContain(`entry-${MAX_PENDING + 1}`);
  });

  it("warns once when the log file was changed outside this plugin", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = makeAdapter();
    const logger = new DiagnosticLogger();
    logger.setAdapter(adapter);
    logger.enableAll();

    logger.log("scan", "first");
    await logger.dispose();
    // The file shrank between flushes — only an external rewrite can do that.
    adapter.stat.mockResolvedValue({ size: 10 });
    logger.log("scan", "second");
    await logger.dispose();
    logger.log("scan", "third");
    await logger.dispose();

    const probeWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("changed outside this plugin"),
    );
    expect(probeWarnings).toHaveLength(1);
  });
});

describe("visibility flush wiring guard", () => {
  it("flushes pending diagnostics when the app goes to background", () => {
    const source = readFileSync("src/main.ts", "utf8");
    expect(source).toContain('document.visibilityState === "hidden"');
    expect(source).toContain("void this.diag.forceFlush();");
  });
});

// ---- Segment choice / UTF-8 counting / write failures (2026-10-26 field bug) ----

const LOG_DIR = ".obsidian/plugins/easy-sync/logs";
const FIXED_DAY = "2026-07-13";

interface MemoryWrite {
  path: string;
  text: string;
  mode: "write" | "append";
}

/** In-memory vault adapter: files are real UTF-8 text, so `stat` reports the
 *  same byte growth the disk would. `failNextWrites` makes the next N write /
 *  append attempts reject before touching the file. */
function createMemoryAdapter() {
  const files = new Map<string, string>();
  const writes: MemoryWrite[] = [];
  let failuresLeft = 0;
  const consumeFailure = (): void => {
    if (failuresLeft <= 0) return;
    failuresLeft -= 1;
    throw new Error("disk unavailable");
  };
  const adapter = {
    mkdir: vi.fn(async () => undefined),
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => files.get(path) ?? ""),
    write: vi.fn(async (path: string, text: string) => {
      consumeFailure();
      files.set(path, text);
      writes.push({ path, text, mode: "write" });
    }),
    append: vi.fn(async (path: string, text: string) => {
      consumeFailure();
      files.set(path, (files.get(path) ?? "") + text);
      writes.push({ path, text, mode: "append" });
    }),
    stat: vi.fn(async (path: string) => {
      const text = files.get(path);
      return text === undefined ? null : { size: Buffer.byteLength(text, "utf8") };
    }),
    list: vi.fn(async (dir: string) => ({
      files: [...files.keys()].filter((path) => path.startsWith(`${dir}/`)),
      folders: [],
    })),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  return {
    adapter: adapter as unknown as DataAdapter,
    mocks: adapter,
    files,
    writes,
    failNextWrites: (count: number) => {
      failuresLeft = count;
    },
  };
}

function createMemoryLogger() {
  vi.useFakeTimers();
  // Local noon: `localDate()` reads local time, so the day is stable anywhere.
  vi.setSystemTime(new Date(2026, 6, 13, 12, 0, 0));
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const vault = createMemoryAdapter();
  const logger = new DiagnosticLogger();
  logger.setAdapter(vault.adapter, ".obsidian");
  logger.enableAll();
  return { vault, logger, warnSpy };
}

/** Flush twice: the second pass also awaits a flush queued from inside the
 *  first one (the rewrite probe emits its warning mid-flush). */
async function drain(logger: DiagnosticLogger): Promise<void> {
  await logger.forceFlush();
  await logger.forceFlush();
}

function messagesMatching(calls: unknown[][], needle: string): unknown[][] {
  return calls.filter((call) => String(call[0]).includes(needle));
}

describe("DiagnosticLogger segment stability", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps one segment for the day while stat errors and then reports a stale size", async () => {
    const { vault, logger } = createMemoryLogger();
    const dayPath = `${LOG_DIR}/${FIXED_DAY}.jsonl`;

    logger.log("execute", "round start");
    await drain(logger);

    // Mid-round the size read fails...
    vault.mocks.stat.mockRejectedValueOnce(new Error("stat unavailable"));
    logger.log("execute", "batch one");
    await drain(logger);

    // ...and then reports a size already past the 5 MiB per-file cap.
    vault.mocks.stat.mockResolvedValue({ size: 6 * 1024 * 1024 });
    logger.log("execute", "batch two");
    await drain(logger);
    logger.log("execute", "batch three");
    await drain(logger);

    expect(vault.writes.every((write) => write.path === dayPath)).toBe(true);
    expect([...vault.files.keys()]).toEqual([dayPath]);
    const content = vault.files.get(dayPath) ?? "";
    expect(content).toContain("round start");
    expect(content).toContain("batch one");
    expect(content).toContain("batch three");
  });

  it("rolls to the next segment only when its own byte count crosses the file cap", async () => {
    const { vault, logger } = createMemoryLogger();
    const dayPath = `${LOG_DIR}/${FIXED_DAY}.jsonl`;
    const rolledPath = `${LOG_DIR}/${FIXED_DAY}.1.jsonl`;

    // One batch bigger than the 5 MiB single-file cap.
    logger.log("execute", "x".repeat(5 * 1024 * 1024), undefined, { urgent: true });
    await drain(logger);
    logger.log("execute", "after the cap");
    await drain(logger);

    expect(vault.files.has(dayPath)).toBe(true);
    expect(vault.files.has(rolledPath)).toBe(true);
    expect(vault.files.get(dayPath) ?? "").not.toContain("after the cap");
    expect(vault.files.get(rolledPath) ?? "").toContain("after the cap");
    // Every later flush stays in the segment it rolled into.
    logger.log("execute", "same segment as the roll");
    await drain(logger);
    expect(vault.files.get(rolledPath) ?? "").toContain("same segment as the roll");
  });

  it("counts Chinese entries in UTF-8 bytes, so the rewrite probe stays silent", async () => {
    const { vault, logger, warnSpy } = createMemoryLogger();
    const dayPath = `${LOG_DIR}/${FIXED_DAY}.jsonl`;

    for (const message of [
      "上传第 1 个文件（约 2.1 秒）",
      "下载完成：中文文件名.md",
      "同步轮结束：0 个错误，耗时 12 秒",
    ]) {
      logger.log("execute", message);
      await drain(logger);
    }

    const content = vault.files.get(dayPath) ?? "";
    const writtenBytes = vault.writes
      .reduce((sum, write) => sum + Buffer.byteLength(write.text, "utf8"), 0);
    // Batches accumulated per entry add up to the file's UTF-8 size on disk.
    expect(writtenBytes).toBe(Buffer.byteLength(content, "utf8"));
    // UTF-16 code units are fewer: that gap was the old false alarm.
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(content.length);
    expect(messagesMatching(warnSpy.mock.calls, "changed outside this plugin")).toHaveLength(0);
  });

  it("still reports one warning when the file is rewritten outside the plugin", async () => {
    const { vault, logger, warnSpy } = createMemoryLogger();
    const dayPath = `${LOG_DIR}/${FIXED_DAY}.jsonl`;

    logger.log("scan", "first line");
    await drain(logger);
    // Another process truncates the file between flushes.
    vault.files.set(dayPath, "");
    logger.log("scan", "second line");
    await drain(logger);
    logger.log("scan", "third line");
    await drain(logger);

    expect(messagesMatching(warnSpy.mock.calls, "changed outside this plugin")).toHaveLength(1);
  });
});

describe("DiagnosticLogger write failures", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a failed append once so the batch still reaches disk", async () => {
    const { vault, logger, warnSpy } = createMemoryLogger();
    const dayPath = `${LOG_DIR}/${FIXED_DAY}.jsonl`;

    logger.log("scan", "first batch");
    await drain(logger);

    vault.failNextWrites(1);
    const attemptsBefore = vault.mocks.append.mock.calls.length;
    logger.log("scan", "second batch survives");
    await drain(logger);

    expect(vault.mocks.append.mock.calls.length).toBe(attemptsBefore + 2);
    expect(vault.files.get(dayPath) ?? "").toContain("second batch survives");
    expect(messagesMatching(warnSpy.mock.calls, "diagnostic log write failed")).toHaveLength(0);
  });

  it("does not throw when both attempts fail and leaves a readable trace", async () => {
    const { vault, logger, warnSpy } = createMemoryLogger();
    const dayPath = `${LOG_DIR}/${FIXED_DAY}.jsonl`;

    logger.log("scan", "first batch");
    await drain(logger);

    vault.failNextWrites(2);
    logger.log("scan", "batch that never lands");
    await expect(logger.dispose()).resolves.toBeUndefined();

    expect(vault.files.get(dayPath) ?? "").not.toContain("batch that never lands");
    const failureWarnings = messagesMatching(warnSpy.mock.calls, "diagnostic log write failed");
    expect(failureWarnings).toHaveLength(1);
    expect(logger.getRecent(10).some((entry) => entry.msg.includes("kept in memory only")))
      .toBe(true);

    // The next batch that lands carries the count, so the gap is readable.
    logger.log("scan", "after recovery");
    await drain(logger);
    const content = vault.files.get(dayPath) ?? "";
    expect(content).toContain("after recovery");
    expect(content).toContain("1 batch / 1 entry never reached disk");
  });
});

describe("DiagnosticLogger snapshot across segments", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("merges the recent segments and orders the result by time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 13, 12, 0, 0));
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const vault = createMemoryAdapter();
    const line = (ts: number, msg: string): string =>
      `${JSON.stringify({ ts, cat: "execute", lvl: "log", msg })}\n`;
    vault.files.set(`${LOG_DIR}/${FIXED_DAY}.jsonl`, line(3000, "base file"));
    vault.files.set(
      `${LOG_DIR}/${FIXED_DAY}.1.jsonl`,
      line(1000, "older segment") + line(2000, "rolled after cap"),
    );

    const logger = new DiagnosticLogger();
    logger.setAdapter(vault.adapter, ".obsidian");
    logger.enableAll();

    const { entries: merged } = await logger.snapshot(500);
    expect(merged.map((entry) => entry.msg)).toEqual([
      "older segment",
      "rolled after cap",
      "base file",
    ]);
  });

  // A1 (2026-10-26): the report window stays exactly as it was; round
  // summaries are bypassed from the unsliced merge so more than the newest
  // round survives.
  function makeRoundSummaryLogger() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 13, 12, 0, 0));
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const vault = createMemoryAdapter();
    const logger = new DiagnosticLogger();
    logger.setAdapter(vault.adapter, ".obsidian");
    logger.enableAll();
    return { vault, logger };
  }

  function logRound(logger: DiagnosticLogger, round: number): void {
    logger.log("onedrive", "sync network summary", {
      schemaVersion: 2,
      totals: { attempts: round },
    });
    logger.log("execute", "sync file transfer summary", {
      schemaVersion: 3,
      upload: { logicalBytes: round * 10 },
      download: { logicalBytes: round },
    });
    logger.log("execute", "sync automatic handling summary", {
      schemaVersion: 1,
      round,
    });
    logger.log("lifecycle", "sync run phase summary", {
      schemaVersion: 2,
      mode: "auto",
      status: "success",
      totalMs: round * 1000,
      phasesMs: { scan: round * 100, transfer: round * 200 },
    });
  }

  it("keeps the 500-entry tail exactly as before", async () => {
    const { logger } = makeRoundSummaryLogger();
    const fillers: string[] = [];
    for (let index = 0; index < 600; index++) {
      const message = `filler-${index}`;
      fillers.push(message);
      logger.log("scan", message);
      vi.advanceTimersByTime(1);
    }

    const snapshot = await logger.snapshot(500);
    // Same count and same positions as the pre-A1 tail slice.
    expect(snapshot.entries).toHaveLength(500);
    expect(snapshot.entries.map((entry) => entry.msg))
      .toEqual(fillers.slice(100));
  });

  it("finds a round summary that the 500-entry window pushed out", async () => {
    const { logger } = makeRoundSummaryLogger();
    logRound(logger, 1);
    vi.advanceTimersByTime(1);
    for (let index = 0; index < 600; index++) {
      logger.log("scan", `filler-${index}`);
      vi.advanceTimersByTime(1);
    }

    const snapshot = await logger.snapshot(500);
    expect(snapshot.entries.some(
      (entry) => entry.msg === "sync run phase summary",
    )).toBe(false);
    expect(snapshot.runSummaries).toHaveLength(1);
    expect(snapshot.runSummaries[0].phase?.data).toMatchObject({ totalMs: 1000 });
    expect(snapshot.runSummaries[0].network?.data).toMatchObject({
      totals: { attempts: 1 },
    });
    expect(snapshot.runSummaries[0].transfer?.data).toMatchObject({
      upload: { logicalBytes: 10 },
    });
    expect(snapshot.runSummaries[0].automatic?.data).toMatchObject({ round: 1 });
  });
});
