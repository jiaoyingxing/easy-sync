import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAN_ACCELERATION_THRESHOLD_MB,
  LAN_ACCELERATION_THRESHOLD_OPTIONS_MB,
  lanAccelerationThresholdBytes,
  normalizeLanAccelerationThresholdMb,
} from "../src/sync/lan-acceleration";
import {
  LanDiagnostics,
  normalizeLanRouteType,
  type LanDiagnosticOutcome,
  type LanDiagnosticSnapshot,
} from "../src/sync/lan-diagnostics";

describe("LAN acceleration settings (S4)", () => {
  it("defaults to 8 MiB and accepts only the offered choices", () => {
    expect(DEFAULT_LAN_ACCELERATION_THRESHOLD_MB).toBe(8);
    expect(LAN_ACCELERATION_THRESHOLD_OPTIONS_MB).toContain(0);
    for (const option of LAN_ACCELERATION_THRESHOLD_OPTIONS_MB) {
      expect(normalizeLanAccelerationThresholdMb(option)).toBe(option);
    }
    expect(normalizeLanAccelerationThresholdMb(undefined))
      .toBe(DEFAULT_LAN_ACCELERATION_THRESHOLD_MB);
    expect(normalizeLanAccelerationThresholdMb(16))
      .toBe(DEFAULT_LAN_ACCELERATION_THRESHOLD_MB);
    expect(normalizeLanAccelerationThresholdMb("64"))
      .toBe(DEFAULT_LAN_ACCELERATION_THRESHOLD_MB);
  });

  it("maps 0 to a byte threshold of zero (all files)", () => {
    expect(lanAccelerationThresholdBytes(0)).toBe(0);
    expect(lanAccelerationThresholdBytes(8)).toBe(8 * 1024 * 1024);
  });
});

describe("LAN diagnostics recorder (S4)", () => {
  it("normalizes candidate types and never keeps raw candidates", () => {
    expect(normalizeLanRouteType("host")).toBe("host");
    expect(normalizeLanRouteType("srflx")).toBe("srflx");
    expect(normalizeLanRouteType("relay")).toBe("relay");
    expect(normalizeLanRouteType("192.168.1.10:5000")).toBe("unknown");
    expect(normalizeLanRouteType(undefined)).toBe("unknown");
  });

  it("keeps only the latest bounded snapshot", () => {
    const diagnostics = new LanDiagnostics();
    expect(diagnostics.getLast()).toBeNull();
    const firstOutcome: LanDiagnosticOutcome = "hit";
    const first: LanDiagnosticSnapshot = {
      outcome: firstOutcome,
      route: "host",
      bytes: 1024,
      elapsedMs: 12,
      at: 1,
    };
    diagnostics.record(first);
    diagnostics.record({
      outcome: "fallback",
      reason: "route-relay",
      route: "relay",
      bytes: 2048,
      elapsedMs: 34,
      at: 2,
    });

    expect(diagnostics.getLast()).toEqual({
      outcome: "fallback",
      reason: "route-relay",
      route: "relay",
      bytes: 2048,
      elapsedMs: 34,
      at: 2,
    });
  });

  it("accumulates one monotonic counter per outcome", () => {
    const diagnostics = new LanDiagnostics();
    expect(diagnostics.getCounters()).toEqual({
      hit: 0,
      fallback: 0,
      rejected: 0,
      skipped: 0,
    });
    const record = (
      outcome: LanDiagnosticOutcome,
      at: number,
      reason?: LanDiagnosticSnapshot["reason"],
    ): void => {
      diagnostics.record({
        outcome,
        reason,
        route: outcome === "hit" ? "host" : "unknown",
        bytes: outcome === "hit" ? 4096 : 0,
        elapsedMs: at,
        at,
      });
    };
    record("hit", 1);
    record("hit", 2);
    record("fallback", 3, "source-error");
    record("skipped", 4, "below-threshold");
    record("skipped", 5, "disabled");
    record("rejected", 6, "hash-mismatch");

    expect(diagnostics.getCounters()).toEqual({
      hit: 2,
      fallback: 1,
      rejected: 1,
      skipped: 2,
    });
    // The latest snapshot is still exactly the last record.
    expect(diagnostics.getLast()).toMatchObject({
      outcome: "rejected",
      reason: "hash-mismatch",
      at: 6,
    });
  });

  it("returns copies, so a caller cannot mutate the recorder", () => {
    const diagnostics = new LanDiagnostics();
    diagnostics.record({
      outcome: "hit",
      route: "host",
      bytes: 1,
      elapsedMs: 1,
      at: 1,
    });
    const counters = diagnostics.getCounters() as { hit: number };
    counters.hit = 99;
    expect(diagnostics.getCounters().hit).toBe(1);
  });
});
