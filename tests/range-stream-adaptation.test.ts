import { describe, expect, it } from "vitest";
import {
  RANGE_STREAM_CONNECTION_COOLDOWN_MS,
  RANGE_STREAM_CONNECTION_FAILURE_STREAK,
  RANGE_STREAM_KNEE_GAIN_FRACTION,
  RANGE_STREAM_KNEE_RETRY_CLEAN_SAMPLES,
  RANGE_STREAM_KNEE_STRIKES,
  RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS,
  RANGE_STREAM_UPGRADE_GAIN_FRACTION,
  createRangeStreamAdaptation,
  type RangeStreamAdaptation,
} from "../src/onedrive/range-stream-adaptation";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import {
  DOWNLOAD_RANGE_MAX_STREAMS,
  DOWNLOAD_RANGE_START_STREAMS,
  DOWNLOAD_RANGE_STREAM_LADDER,
  availableRangeTierIndex,
  planRangeDownloadWindows,
} from "../src/onedrive/download-range-policy";

const MIB = 1024 * 1024;
/** Every default simulated file is far above the 32 MiB / 1 MiB per-stream
 *  floor, so the file-size cap never masks a ladder decision unless a test
 *  passes a smaller size on purpose. */
const FILE_BYTES = 64 * MIB;
/** The field's 20 MiB file: the 1 MiB per-stream floor lets it fund the 16
 *  rung but not 24, and a 24/32 request would both collapse to 20 windows. */
const FIELD_FILE_BYTES = 20 * MIB;
/** A file that can fund 24 but not 32. */
const MID_FILE_BYTES = 28 * MIB;
/** The smallest file that can fund the top rung. */
const TOP_FILE_BYTES = 32 * MIB;
/** Synthetic per-connection rate: 64 KiB/s, the same order as the field
 *  single-connection reading (52.8 KB/s) rounded for exact assertions. */
const PER_CONNECTION_BPS = 64 * 1024;

interface TestClock {
  now: number;
}

function makeAdaptation(
  clock: TestClock = { now: 0 },
  diag?: DiagnosticLogger,
): RangeStreamAdaptation {
  return createRangeStreamAdaptation({ now: () => clock.now, diag });
}

/** A synthetic link curve: aggregate = min(streams × per-connection, cap) ×
 *  drift. Both the cap (an aggregate-limited link) and the drift (the whole
 *  link slowing down between two files) are mutable, so a test can change the
 *  link between two samples — exactly the condition a single sample cannot
 *  distinguish from a saturated tier. */
interface FakeLink {
  rate(streams: number): number;
  setCap(bytesPerSecond: number): void;
  setDrift(factor: number): void;
}

function makeLink(capBytesPerSecond = Number.POSITIVE_INFINITY): FakeLink {
  let cap = capBytesPerSecond;
  let drift = 1;
  return {
    rate: (streams: number): number =>
      Math.min(streams * PER_CONNECTION_BPS, cap) * drift,
    setCap: (value: number): void => {
      cap = value;
    },
    setDrift: (factor: number): void => {
      drift = factor;
    },
  };
}

/** Plan one file at the controller's tier, feed the link model's throughput
 *  back as one clean sample, and return what the file observed. The actual
 *  stream count mirrors `planRangeDownloadWindows`: the per-stream 1 MiB floor
 *  caps a plan that is larger than the file, so a 20 MiB file plans 24 but
 *  runs 20 windows. The controller is told the same size, so it never commits
 *  a probe to a rung this file cannot fund. */
function observeFile(
  adaptation: RangeStreamAdaptation,
  link: FakeLink,
  fileBytes = FILE_BYTES,
): { streams: number; bytesPerSecond: number } {
  const planned = adaptation.planStreams(fileBytes);
  const streams = Math.min(planned, Math.floor(fileBytes / MIB));
  const bytesPerSecond = link.rate(streams);
  adaptation.recordCleanTransfer({
    streams,
    bytes: fileBytes,
    elapsedMs: (fileBytes * 1000) / bytesPerSecond,
  });
  return { streams, bytesPerSecond };
}

/** Five files at a linear link move 8 → 12 → 16 → 24 → 32. */
function climbToCap(
  adaptation: RangeStreamAdaptation,
  link: FakeLink,
): void {
  for (let index = 0; index < DOWNLOAD_RANGE_STREAM_LADDER.length; index++) {
    observeFile(adaptation, link);
  }
  expect(adaptation.plannedStreams).toBe(DOWNLOAD_RANGE_MAX_STREAMS);
}

/** Capture the controller's own diagnostic wording: the real-machine check
 *  reads these lines, and for the baseline choice below the log line is the
 *  only externally visible difference. */
function makeDiag(): { diag: DiagnosticLogger; logs: string[]; warnings: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  const diag = {
    log: (_category: string, message: string): void => {
      logs.push(message);
    },
    warn: (_category: string, message: string): void => {
      warnings.push(message);
    },
  } as unknown as DiagnosticLogger;
  return { diag, logs, warnings };
}

describe("RangeStreamAdaptation (G3 桌面多流档位双向自适应)", () => {
  it("pins the ladder, the cap and the spec's doubling thresholds", () => {
    expect([...DOWNLOAD_RANGE_STREAM_LADDER]).toEqual([8, 12, 16, 24, 32]);
    expect(DOWNLOAD_RANGE_START_STREAMS).toBe(8);
    expect(DOWNLOAD_RANGE_MAX_STREAMS).toBe(32);
    expect(DOWNLOAD_RANGE_MAX_STREAMS).toBeGreaterThan(16);
    // The spec's examples are exact translations for a doubling step:
    // upgrade ≥ 1.30×, knee < 1.15×.
    expect(1 + RANGE_STREAM_UPGRADE_GAIN_FRACTION * (2 - 1)).toBeCloseTo(1.3);
    expect(1 + RANGE_STREAM_KNEE_GAIN_FRACTION * (2 - 1)).toBeCloseTo(1.15);
    expect(RANGE_STREAM_CONNECTION_FAILURE_STREAK).toBe(2);
    // One flat sample is only a suspicion; a knee needs the second strike.
    expect(RANGE_STREAM_KNEE_STRIKES).toBe(2);
    expect(RANGE_STREAM_KNEE_RETRY_CLEAN_SAMPLES).toBe(3);
  });

  it("starts at 8 and does not move without measured throughput", () => {
    const adaptation = makeAdaptation();

    expect(adaptation.planStreams(FILE_BYTES)).toBe(8);
    expect(adaptation.planStreams(FILE_BYTES)).toBe(8);
    expect(adaptation.plannedStreams).toBe(8);
  });

  it("fast per-connection link climbs to 32 and holds ≥85% of the fixed-32 throughput", () => {
    const adaptation = makeAdaptation();
    const link = makeLink();

    const observed = Array.from(
      { length: 8 },
      () => observeFile(adaptation, link),
    );

    expect(observed.map((entry) => entry.streams)).toEqual([
      8, 12, 16, 24, 32, 32, 32, 32,
    ]);
    const fixedOptimal32 = link.rate(32);
    for (const entry of observed.slice(4)) {
      expect(entry.streams).toBe(32);
      expect(entry.bytesPerSecond / fixedOptimal32).toBeGreaterThanOrEqual(0.85);
    }
    expect(adaptation.plannedStreams).toBe(32);
  });

  it("amortizes the 5-file ramp above 85% of the fixed-32 baseline over a long round", () => {
    const adaptation = makeAdaptation();
    const link = makeLink();
    const fixed32BytesPerMs = link.rate(32) / 1000;

    let adaptiveMs = 0;
    for (let index = 0; index < 100; index++) {
      const streams = adaptation.planStreams(FILE_BYTES);
      const bytesPerSecond = link.rate(streams);
      adaptiveMs += (FILE_BYTES * 1000) / bytesPerSecond;
      adaptation.recordCleanTransfer({
        streams,
        bytes: FILE_BYTES,
        elapsedMs: (FILE_BYTES * 1000) / bytesPerSecond,
      });
    }

    const adaptiveBytesPerMs = (FILE_BYTES * 100) / adaptiveMs;
    expect(adaptiveBytesPerMs / fixed32BytesPerMs).toBeGreaterThanOrEqual(0.85);
  });

  // ---- Size-aware rungs: only probe what the file can actually fill -------
  it("A: a 20 MiB file at tier 16 does not probe 24 (24 would run 20 streams)", () => {
    const clock: TestClock = { now: 0 };
    const { diag, logs, warnings } = makeDiag();
    const adaptation = makeAdaptation(clock, diag);
    const link = makeLink();

    // Three 20 MiB files climb 8 → 12 → 16; every step is a real rung.
    const climb = Array.from(
      { length: 3 },
      () => observeFile(adaptation, link, FIELD_FILE_BYTES),
    );
    expect(climb.map((entry) => entry.streams)).toEqual([8, 12, 16]);
    expect(adaptation.plannedStreams).toBe(16);

    // The old controller planned 24 here and ran 20 windows, so the 16→24
    // comparison used a 1.25× step that the file never delivered. The 24 rung
    // is not fundable, so the round holds 16 and spends no probe.
    expect(adaptation.planStreams(FIELD_FILE_BYTES)).toBe(16);
    expect(logs.some((message) => message.includes("probe 16→24"))).toBe(false);
    expect(logs.some((message) =>
      message.includes("not probing 16→24")
      && message.includes("20 MiB")
      && message.includes("16-stream rung"))).toBe(true);
    expect(warnings).toHaveLength(0);

    // The structural reason, pinned: a requested 24 yields 20 windows, so a
    // 24-stream step could never be measured on this file.
    expect(planRangeDownloadWindows(FIELD_FILE_BYTES, 24)).toHaveLength(20);
    expect(availableRangeTierIndex(FIELD_FILE_BYTES)).toBe(2);
  });

  it("B: 40 MiB files fund the whole ladder, so the round probes 24 and 32", () => {
    const adaptation = makeAdaptation();
    const link = makeLink();

    const observed = Array.from(
      { length: 5 },
      () => observeFile(adaptation, link, 40 * MIB),
    );

    expect(observed.map((entry) => entry.streams)).toEqual([8, 12, 16, 24, 32]);
    expect(adaptation.plannedStreams).toBe(DOWNLOAD_RANGE_MAX_STREAMS);
    expect(availableRangeTierIndex(40 * MIB)).toBe(4);
  });

  it("B: 24 MiB unlocks 24 and 32 MiB is the exact size that unlocks 32", () => {
    const adaptation = makeAdaptation();
    const link = makeLink();

    // 24 MiB is the smallest file that can fill the 24-stream rung.
    const climb = Array.from(
      { length: 4 },
      () => observeFile(adaptation, link, 24 * MIB),
    );
    expect(climb.map((entry) => entry.streams)).toEqual([8, 12, 16, 24]);

    // 28 MiB can fund 24 (already there) but not the 32 rung: no probe.
    const mid = observeFile(adaptation, link, MID_FILE_BYTES);
    expect(mid.streams).toBe(24);
    expect(adaptation.plannedStreams).toBe(24);
    expect(adaptation.planStreams(MID_FILE_BYTES)).toBe(24);

    // 32 MiB is exactly enough; the conserved probe is spent here.
    expect(adaptation.planStreams(TOP_FILE_BYTES)).toBe(32);
    expect(availableRangeTierIndex(24 * MIB)).toBe(3);
    expect(availableRangeTierIndex(MID_FILE_BYTES)).toBe(3);
    expect(availableRangeTierIndex(TOP_FILE_BYTES)).toBe(4);
  });

  it("C: equal effective stream counts are not probed and add no strike", () => {
    const clock: TestClock = { now: 0 };
    const { diag, logs, warnings } = makeDiag();
    const adaptation = makeAdaptation(clock, diag);
    // Aggregate cap at 24 connections: the 24-stream step still promotes, and
    // 32 streams move the same bytes as 24.
    const link = makeLink(24 * PER_CONNECTION_BPS);

    const climb = Array.from(
      { length: 4 },
      () => observeFile(adaptation, link, 40 * MIB),
    );
    expect(climb.map((entry) => entry.streams)).toEqual([8, 12, 16, 24]);
    expect(adaptation.plannedStreams).toBe(24);

    // At 20 MiB, tier 24 and tier 32 both run 20 windows. Probing 32 would
    // move the tier on a sample that is not a step; the size-aware controller
    // holds 24 and records no flat strike.
    const capped = observeFile(adaptation, link, FIELD_FILE_BYTES);
    expect(capped.streams).toBe(20);
    expect(adaptation.plannedStreams).toBe(24);
    expect(warnings).toHaveLength(0);
    expect(logs.some((message) => message.includes("probe 24→32"))).toBe(false);

    // The next file that can fund 32 spends the conserved probe.
    const next = observeFile(adaptation, link, 40 * MIB);
    expect(next.streams).toBe(32);
  });

  // ---- Acceptance A: link drift must not be read as a knee ----------------
  it("A: one below-the-line step on a drifting link is a suspicion, not a knee (field shape)", () => {
    const adaptation = makeAdaptation();
    // The field link: aggregate saturation at about 8 connections' worth of
    // throughput, plus a link that slowed down between the two files.
    const link = makeLink(8 * PER_CONNECTION_BPS);

    const first = observeFile(adaptation, link);
    expect(first.streams).toBe(8);

    // 430 KB/s → 360 KB/s in the field; 0.837 here. At both rungs the
    // aggregate is capped, so this is 0.837× of the 8-stream reading.
    link.setDrift(0.837);
    const second = observeFile(adaptation, link);
    expect(second.streams).toBe(12);
    expect(second.bytesPerSecond / first.bytesPerSecond).toBeCloseTo(0.837, 3);
    // Below the 1.075× line for this 1.5× step — the old rule called this a
    // knee and froze the round at 8 after one sample.
    expect(second.bytesPerSecond / first.bytesPerSecond).toBeLessThan(
      1 + RANGE_STREAM_KNEE_GAIN_FRACTION * (12 / 8 - 1),
    );

    // The tier holds and the round keeps probing: a drift dip is not a knee.
    expect(adaptation.plannedStreams).toBe(12);
    expect(adaptation.planStreams(FILE_BYTES)).toBe(16);
  });

  it("A: a step that only dipped for one file does not cost the round its climb", () => {
    const adaptation = makeAdaptation();
    const link = makeLink();

    const a = observeFile(adaptation, link);
    expect(a.streams).toBe(8);

    // One slow file: 12 streams read 384 KB/s against a 512 KB/s baseline.
    link.setDrift(0.5);
    const b = observeFile(adaptation, link);
    expect(b.streams).toBe(12);
    expect(b.bytesPerSecond / a.bytesPerSecond).toBeLessThan(
      1 + RANGE_STREAM_KNEE_GAIN_FRACTION * (12 / 8 - 1),
    );
    expect(adaptation.plannedStreams).toBe(12); // held, not demoted

    // The next file is back at full speed: the step clears the line and the
    // suspicion is dropped, so the round keeps the tier it paid for.
    link.setDrift(1);
    const c = observeFile(adaptation, link);
    expect(c.streams).toBe(16);
    expect(c.bytesPerSecond / b.bytesPerSecond).toBeGreaterThan(
      1 + RANGE_STREAM_UPGRADE_GAIN_FRACTION * (16 / 12 - 1),
    );
    expect(adaptation.plannedStreams).toBe(16);
    expect(adaptation.planStreams(FILE_BYTES)).toBe(24); // the ramp was never capped
  });

  // ---- Acceptance B: a real knee needs two strikes, then one re-probe -----
  it("B: two consecutive below-the-line steps settle at the last proven rung", () => {
    const adaptation = makeAdaptation();
    // Aggregate capped at the throughput of 8 connections: 12, 16 and 24 all
    // move the same bytes.
    const link = makeLink(8 * PER_CONNECTION_BPS);

    const observed = Array.from(
      { length: 3 },
      () => observeFile(adaptation, link),
    );

    // 8 (baseline) → 12: flat, strike one, the round keeps the tier and probes
    // again → 16: flat again, strike two.
    expect(observed.map((entry) => entry.streams)).toEqual([8, 12, 16]);
    // Settled at the base rung of the first strike (8): that is the last rung
    // the link actually proved.
    expect(adaptation.plannedStreams).toBe(8);
  });

  it("B: after a knee the round spends exactly one re-probe, 3 clean samples later", () => {
    const adaptation = makeAdaptation();
    const link = makeLink(8 * PER_CONNECTION_BPS);

    const seen = Array.from({ length: 12 }, () => observeFile(adaptation, link).streams);

    // file 1-3: climb and confirm the knee at 8.
    // file 4-6: three clean samples at the settled tier, no probe.
    // file 7:   the one re-probe, judged against the freshest 8-stream sample.
    // file 8+:  below the line again — no further probe for the round.
    expect(seen).toEqual([8, 12, 16, 8, 8, 8, 12, 8, 8, 8, 8, 8]);
    expect(adaptation.plannedStreams).toBe(8);
    // Even far past the re-probe budget the round stays where it settled.
    const tail = Array.from({ length: 10 }, () => observeFile(adaptation, link).streams);
    expect(tail.every((streams) => streams === 8)).toBe(true);
  });

  it("B: a re-probe that clears the line lifts the knee and the ramp resumes", () => {
    const adaptation = makeAdaptation();
    const link = makeLink(8 * PER_CONNECTION_BPS);

    Array.from({ length: 3 }, () => observeFile(adaptation, link));
    expect(adaptation.plannedStreams).toBe(8);

    // The link improves while the round is settled: the same three clean
    // samples now precede a re-probe that actually pays.
    link.setCap(Number.POSITIVE_INFINITY);
    Array.from({ length: 3 }, () => observeFile(adaptation, link));
    const retry = observeFile(adaptation, link);
    expect(retry.streams).toBe(12);
    expect(adaptation.plannedStreams).toBe(12);

    // The freeze is over: the ordinary ramp is armed again.
    const resumed = Array.from(
      { length: 5 },
      () => observeFile(adaptation, link).streams,
    );
    expect(resumed.slice(0, 3)).toEqual([16, 24, 32]);
    expect(adaptation.plannedStreams).toBe(32);
  });

  it("B: a file too small to fund the re-probe does not spend it; a larger file does", () => {
    const adaptation = makeAdaptation();
    // Linear up to 16 connections, then flat: the strikes land at 16→24 and
    // 24→32, so the round settles at 16.
    const link = makeLink(16 * PER_CONNECTION_BPS);
    Array.from({ length: 5 }, () => observeFile(adaptation, link));
    expect(adaptation.plannedStreams).toBe(16);

    Array.from({ length: RANGE_STREAM_KNEE_RETRY_CLEAN_SAMPLES },
      () => observeFile(adaptation, link));

    // A 16 MiB file cannot fund the 24-stream re-probe. It must not be left
    // parked a rung above the knee, and it must not burn the one re-probe the
    // round owes either: the retry stays available for a file that can.
    const capped = observeFile(adaptation, link, 16 * MIB);
    expect(capped.streams).toBe(16);
    expect(adaptation.plannedStreams).toBe(16);

    // The next 64 MiB file spends the conserved re-probe at 24; the link is
    // still flat there, so the knee is confirmed for the rest of the round.
    const retry = observeFile(adaptation, link, FILE_BYTES);
    expect(retry.streams).toBe(24);
    expect(adaptation.plannedStreams).toBe(16);
    const tail = Array.from({ length: 4 }, () => observeFile(adaptation, link).streams);
    expect(tail.every((streams) => streams === 16)).toBe(true);
  });

  it("a gain inside the hold band stops probing without promoting or demoting", () => {
    const adaptation = makeAdaptation();
    // 8 → 12 buys 1.125×: above the knee line (1.075×) but below the upgrade
    // line (1.15×) for a 1.5× step. The tier must stay at 12 and must not
    // creep upward on later same-tier samples.
    const link = makeLink(9 * PER_CONNECTION_BPS);

    const observed = Array.from(
      { length: 8 },
      () => observeFile(adaptation, link),
    );

    expect(observed.map((entry) => entry.streams)).toEqual([
      8, 12, 12, 12, 12, 12, 12, 12,
    ]);
    expect(adaptation.plannedStreams).toBe(12);
  });

  // ---- Baseline: the freshest sample at the rung the probe stepped from ---
  it("judges a step against its own rung's freshest sample, not a third-rung reading", () => {
    const clock: TestClock = { now: 0 };
    const { diag, warnings } = makeDiag();
    const adaptation = makeAdaptation(clock, diag);
    const link = makeLink();

    // A linear link climbs to 24 (a 64 MiB file gives a real 24-stream
    // reading: the baseline this step must use).
    const climb = Array.from({ length: 4 }, () => observeFile(adaptation, link));
    expect(climb.map((entry) => entry.streams)).toEqual([8, 12, 16, 24]);

    // 429 at 24: one rung down, then the cooldown and the recovery probe.
    adaptation.recordRateLimited();
    expect(adaptation.plannedStreams).toBe(16);
    clock.now += RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS;

    // The recovery file is 64 MiB so it can actually fund 24: the recovery
    // probe is adopted and the freshest 24-stream reading is this one.
    const recovery = observeFile(adaptation, link);
    expect(recovery.streams).toBe(24);
    expect(adaptation.plannedStreams).toBe(24);

    // A 20 MiB file at the 24 tier runs its clamped 20 windows and probes
    // nothing (32 is not fundable), but it becomes the freshest *sample*.
    const capped = observeFile(adaptation, link, FIELD_FILE_BYTES);
    expect(capped.streams).toBe(20);
    expect(adaptation.plannedStreams).toBe(24);

    // The next file plans 32, and the link is now aggregate-capped at 24
    // connections' worth of throughput. Judged against the stale 20-stream
    // reading this would look like a 1.20× promotion-sized step; judged
    // against the 24-stream rung it is 1.00× — flat, which is what the link
    // actually did.
    link.setCap(24 * PER_CONNECTION_BPS);
    const next = observeFile(adaptation, link, FILE_BYTES);
    expect(next.streams).toBe(32);
    expect(next.bytesPerSecond).toBe(24 * PER_CONNECTION_BPS);
    expect(warnings.some((message) =>
      message.includes("step 24→32 streams bought 1.00×")
      && message.includes("suspicion only"))).toBe(true);
  });

  // ---- Acceptance C: 429 path unchanged, also while a knee is frozen ------
  it("429 downgrades one tier immediately, holds during cooldown, then probes back up", () => {
    const clock: TestClock = { now: 0 };
    const adaptation = makeAdaptation(clock);
    climbToCap(adaptation, makeLink());

    adaptation.recordRateLimited();
    expect(adaptation.plannedStreams).toBe(24);
    expect(adaptation.planStreams(FILE_BYTES)).toBe(24);

    clock.now += RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS - 1;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(24);
    clock.now += 1;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);

    adaptation.recordCleanTransfer({
      streams: 32,
      bytes: FILE_BYTES,
      elapsedMs: 1_000,
    });
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);
  });

  it("C: 429 still downgrades immediately and recovers to the settled tier while frozen", () => {
    const clock: TestClock = { now: 0 };
    const adaptation = makeAdaptation(clock);
    const link = makeLink(12 * PER_CONNECTION_BPS);

    // Cap at the throughput of 12 connections: 12 → 16 and 16 → 24 are both
    // flat, so the round settles at 12 after two strikes.
    expect(Array.from({ length: 4 }, () => observeFile(adaptation, link).streams))
      .toEqual([8, 12, 16, 24]);
    expect(adaptation.plannedStreams).toBe(12);

    adaptation.recordRateLimited();
    expect(adaptation.plannedStreams).toBe(8);
    expect(adaptation.planStreams(FILE_BYTES)).toBe(8);

    clock.now += RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS - 1;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(8);
    clock.now += 1;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(12);

    adaptation.recordCleanTransfer({
      streams: 12,
      bytes: FILE_BYTES,
      elapsedMs: (FILE_BYTES * 1000) / link.rate(12),
    });
    // The knee ceiling still applies after the throttle recovery.
    expect(adaptation.plannedStreams).toBe(12);
    expect(adaptation.planStreams(FILE_BYTES)).toBe(12);
  });

  it("honors a Retry-After longer than the base 429 cooldown", () => {
    const clock: TestClock = { now: 0 };
    const adaptation = makeAdaptation(clock);
    climbToCap(adaptation, makeLink());

    adaptation.recordRateLimited({ retryAfterMs: 30_000 });
    expect(adaptation.planStreams(FILE_BYTES)).toBe(24);
    clock.now += 29_999;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(24);
    clock.now += 1;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);
  });

  it("doubles the base cooldown for consecutive 429s", () => {
    const clock: TestClock = { now: 0 };
    const adaptation = makeAdaptation(clock);
    climbToCap(adaptation, makeLink());

    adaptation.recordRateLimited();
    clock.now += RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);

    adaptation.recordRateLimited();
    expect(adaptation.plannedStreams).toBe(24);
    clock.now += RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS * 2 - 1;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(24);
    clock.now += 1;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);
  });

  // ---- Acceptance D: a downgrade can still climb back ---------------------
  it("D: two consecutive connection failures drop one tier; the cooldown then probes back up", () => {
    const clock: TestClock = { now: 0 };
    const adaptation = makeAdaptation(clock);
    climbToCap(adaptation, makeLink());

    adaptation.recordConnectionFailure();
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32); // one failure alone holds

    adaptation.recordConnectionFailure();
    expect(adaptation.plannedStreams).toBe(24);
    expect(adaptation.planStreams(FILE_BYTES)).toBe(24);

    clock.now += RANGE_STREAM_CONNECTION_COOLDOWN_MS;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);
    adaptation.recordCleanTransfer({
      streams: 32,
      bytes: FILE_BYTES,
      elapsedMs: 1_000,
    });
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);
  });

  it("a clean transfer resets the connection-failure streak", () => {
    const adaptation = makeAdaptation();
    const link = makeLink();
    climbToCap(adaptation, link);

    adaptation.recordConnectionFailure();
    observeFile(adaptation, link); // successful file clears the streak
    adaptation.recordConnectionFailure();
    expect(adaptation.planStreams(FILE_BYTES)).toBe(32);

    adaptation.recordConnectionFailure();
    expect(adaptation.plannedStreams).toBe(24);
  });

  it("can still climb back after a failure at the 8-stream floor", () => {
    const clock: TestClock = { now: 0 };
    const adaptation = makeAdaptation(clock);

    expect(adaptation.planStreams(FILE_BYTES)).toBe(8);
    adaptation.recordConnectionFailure();
    adaptation.recordConnectionFailure();
    expect(adaptation.plannedStreams).toBe(8);

    clock.now += RANGE_STREAM_CONNECTION_COOLDOWN_MS;
    expect(adaptation.planStreams(FILE_BYTES)).toBe(12); // recovery probe from the floor
    adaptation.recordCleanTransfer({
      streams: 12,
      bytes: FILE_BYTES,
      elapsedMs: 1_000,
    });
    // The recovery probe is adopted and the normal ramp resumes.
    expect(adaptation.planStreams(FILE_BYTES)).toBe(16);
  });
});
