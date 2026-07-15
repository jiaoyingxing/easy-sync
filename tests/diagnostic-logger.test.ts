import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { DiagnosticLogger } from "../src/sync/diagnostic-logger";

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
    const result = await logger.snapshot(500);

    // All three entries present: 1 from disk, 2 from pending
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.some((e) => e.msg === "disk-entry")).toBe(true);
    expect(result.some((e) => e.msg === "download failed")).toBe(true);
    expect(result.some((e) => e.msg === "sync aborted")).toBe(true);
  });
});
