import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSlowConnectionGate,
  createSlowLinkEvidence,
  DOWNLOAD_SLOW_ABORT_LIMIT,
  DOWNLOAD_SLOW_RATE_WINDOW_MS,
} from "../src/onedrive/download-stream-guards";

/** Bytes a window must receive to average `kib` KiB/s over the gate window. */
const windowBytesFor = (kib: number): number => kib * 1024 * (DOWNLOAD_SLOW_RATE_WINDOW_MS / 1000);

const advanceWindow = (): void => {
  vi.setSystemTime(vi.getMockedSystemTime()!.getTime() + DOWNLOAD_SLOW_RATE_WINDOW_MS + 1);
};

interface SlowGateTelemetry {
  slowGateRateKiBps?: number;
  slowGatePriorRateKiBps?: number;
}

const catchSlowError = (run: () => void): (Error & SlowGateTelemetry) | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error as Error & SlowGateTelemetry;
  }
};

describe("slow connection gate — evidence-driven decision function (2026-09-15 乙路)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a cold first slow window with the legacy absolute rule and carries telemetry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createSlowConnectionGate("file", {
      evidence: createSlowLinkEvidence(),
      totalSize: 1024 ** 3,
    });
    gate.evaluate(0);
    advanceWindow();
    const error = catchSlowError(() => gate.evaluate(windowBytesFor(100)));
    expect(error?.message).toContain("Download too slow");
    expect(error?.message).toContain("(reconnect 1/3)");
    expect(error?.slowGateRateKiBps).toBe(100);
    expect(error?.slowGatePriorRateKiBps).toBeUndefined();
  });

  it("accepts a comparable follow-up window instead of abandoning (2026-09-15 iPhone replay)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createSlowConnectionGate("file", {
      evidence: createSlowLinkEvidence(),
      totalSize: 1024 ** 3,
    });
    gate.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gate.evaluate(windowBytesFor(105)))).not.toBeNull();
    // New attempt on the reconnect: 90 KiB/s against a 105 KiB/s baseline is a
    // comparable connection (ratio 0.86 ≫ k=0.45) — tonight's link burned two
    // more reconnects on exactly this shape.
    gate.beginAttempt();
    gate.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gate.evaluate(windowBytesFor(90)))).toBeNull();
  });

  it("still abandons a collapsed follow-up window and pairs the before/after rates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createSlowConnectionGate("file", {
      evidence: createSlowLinkEvidence(),
      totalSize: 1024 ** 3,
    });
    gate.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gate.evaluate(windowBytesFor(130)))).not.toBeNull();
    gate.beginAttempt();
    gate.evaluate(0);
    advanceWindow();
    const error = catchSlowError(() => gate.evaluate(windowBytesFor(26)));
    expect(error?.message).toContain("(reconnect 2/3)");
    expect(error?.slowGateRateKiBps).toBe(26);
    expect(error?.slowGatePriorRateKiBps).toBe(130);
  });

  it("keeps an almost-done file on its connection (completion-imminence exemption)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createSlowConnectionGate("file", {
      evidence: createSlowLinkEvidence(),
      totalSize: 4_300_000,
    });
    gate.evaluate(0);
    advanceWindow();
    // 3.5MB of 4.3MB received at ~228 KiB/s: eta ≈ 3.4s ≪ reconnect cost
    // (~25s incl. re-downloading the received prefix) — never abandon.
    expect(catchSlowError(() => gate.evaluate(3_500_000))).toBeNull();
  });

  it("does not exempt an early transfer (reconnect still cheaper than eta)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createSlowConnectionGate("file", {
      evidence: createSlowLinkEvidence(),
      totalSize: 1024 ** 3,
    });
    gate.evaluate(0);
    advanceWindow();
    const error = catchSlowError(() => gate.evaluate(windowBytesFor(100)));
    expect(error).not.toBeNull();
  });

  it("caps reconnects at the abort limit and then accepts the connection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createSlowConnectionGate("file", {
      evidence: createSlowLinkEvidence(),
      totalSize: 1024 ** 3,
    });
    gate.evaluate(0);
    let bytes = 0;
    const rates = [500, 50, 5, 5, 5];
    const errors: (Error & SlowGateTelemetry) | null[] = [];
    for (const kib of rates) {
      advanceWindow();
      bytes += windowBytesFor(kib);
      errors.push(catchSlowError(() => gate.evaluate(bytes)));
    }
    expect(errors[0]?.message).toContain("(reconnect 1/3)");
    expect(errors[1]?.message).toContain("(reconnect 2/3)");
    expect(errors[2]?.message).toContain(`(reconnect ${DOWNLOAD_SLOW_ABORT_LIMIT}/3)`);
    expect(errors[3]).toBeNull();
    expect(errors[4]).toBeNull();
  });

  it("shares round evidence across files: the next file skips the cold tuition", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const evidence = createSlowLinkEvidence();
    const gateA = createSlowConnectionGate("a", { evidence, totalSize: 1024 ** 3 });
    gateA.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gateA.evaluate(windowBytesFor(500)))).not.toBeNull();

    // 300 KiB/s against a 500 KiB/s baseline is comparable — no tuition.
    const gateB = createSlowConnectionGate("b", { evidence, totalSize: 1024 ** 3 });
    gateB.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gateB.evaluate(windowBytesFor(300)))).toBeNull();

    // A genuinely collapsed connection still aborts against the same baseline.
    const gateC = createSlowConnectionGate("c", { evidence, totalSize: 1024 ** 3 });
    gateC.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gateC.evaluate(windowBytesFor(100)))).not.toBeNull();
  });

  it("never judges ceiling-rate windows and lets them raise the baseline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const evidence = createSlowLinkEvidence();
    const fast = createSlowConnectionGate("fast", { evidence, totalSize: 1024 ** 3 });
    fast.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => fast.evaluate(windowBytesFor(520)))).toBeNull();

    const mid = createSlowConnectionGate("mid", { evidence, totalSize: 1024 ** 3 });
    mid.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => mid.evaluate(windowBytesFor(300)))).toBeNull();

    const tail = createSlowConnectionGate("tail", { evidence, totalSize: 1024 ** 3 });
    tail.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => tail.evaluate(windowBytesFor(150)))).not.toBeNull();
  });

  it("resists single-window baseline bursts via the p75 sample", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const evidence = createSlowLinkEvidence();
    for (let i = 0; i < 8; i++) evidence.record(500 * 1024);
    evidence.record(4000 * 1024);
    const gate = createSlowConnectionGate("file", { evidence, totalSize: 1024 ** 3 });
    gate.evaluate(0);
    advanceWindow();
    // p75 of [500K×7, 4M] still lands on 500K — one burst sample must not
    // turn every mid-rate connection into an abort.
    expect(catchSlowError(() => gate.evaluate(windowBytesFor(300)))).toBeNull();
  });

  it("keeps the legacy absolute rule for gates without shared evidence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createSlowConnectionGate("legacy");
    gate.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gate.evaluate(windowBytesFor(100)))).not.toBeNull();
    gate.beginAttempt();
    gate.evaluate(0);
    advanceWindow();
    expect(catchSlowError(() => gate.evaluate(windowBytesFor(100)))).not.toBeNull();
  });
});
