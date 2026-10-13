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
    const result = await logger.snapshot(500);

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
