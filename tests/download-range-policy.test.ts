import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_RANGE_MAX_STREAMS,
  DOWNLOAD_RANGE_MIN_BYTES,
  DOWNLOAD_RANGE_START_STREAMS,
  DOWNLOAD_RANGE_STREAM_LADDER,
  availableRangeTierIndex,
  planRangeDownloadWindows,
} from "../src/onedrive/download-range-policy";
import type { RangeWindow } from "../src/onedrive/download-range-policy";

const MIB = 1024 * 1024;
const WINDOW_20MIB_DIV_8 = (2.5 * MIB) | 0; // 2.5 MiB = 20 MiB / 8, an exact division.
const WINDOW_20MIB_DIV_16 = (1.25 * MIB) | 0; // 1.25 MiB = 20 MiB / 16, the old fixed tier.

function sizes(windows: readonly RangeWindow[]): number[] {
  return windows.map((window) => window.end - window.start + 1);
}

describe("planRangeDownloadWindows (桌面大文件多流 Range 纯策略)", () => {
  it("keeps the Range threshold and its single-stream boundary", () => {
    expect(DOWNLOAD_RANGE_MIN_BYTES).toBe(16 * MIB);
  });

  it("pins the G3 adaptive ladder: start 8, cap 32, 16 is no longer a ceiling", () => {
    expect(DOWNLOAD_RANGE_START_STREAMS).toBe(8);
    expect(DOWNLOAD_RANGE_MAX_STREAMS).toBe(32);
    expect([...DOWNLOAD_RANGE_STREAM_LADDER]).toEqual([8, 12, 16, 24, 32]);
    expect(DOWNLOAD_RANGE_STREAM_LADDER[0]).toBe(DOWNLOAD_RANGE_START_STREAMS);
    expect(DOWNLOAD_RANGE_STREAM_LADDER[DOWNLOAD_RANGE_STREAM_LADDER.length - 1])
      .toBe(DOWNLOAD_RANGE_MAX_STREAMS);
    expect(DOWNLOAD_RANGE_MAX_STREAMS).toBeGreaterThan(16);
  });

  it("defaults to the adaptive start tier (8 streams)", () => {
    // Table: [label, fileSize, expected stream count, expected first-window bytes]
    const table: Array<[string, number, number, number]> = [
      // Threshold file: 8 windows of exactly 2 MiB (well above the floor).
      ["16 MiB", 16 * MIB, 8, 2 * MIB],
      // 20 MiB: 8 equal 2.5 MiB windows (the field file).
      ["20 MiB", 20 * MIB, 8, WINDOW_20MIB_DIV_8],
      // 200 MiB: the default start tier still applies.
      ["200 MiB", 200 * MIB, 8, 25 * MIB],
    ];
    for (const [label, size, expectedStreams, expectedFirstWindow] of table) {
      const windows = planRangeDownloadWindows(size)!;
      expect(windows, label).toHaveLength(expectedStreams);
      expect(sizes(windows)[0], label).toBe(expectedFirstWindow);
    }
  });

  it("plans explicit adaptive tiers and caps each by the 1 MiB per-stream floor", () => {
    // Table: [label, fileSize, requested, expected stream count, first-window bytes]
    const table: Array<[string, number, number, number, number]> = [
      // 96 MiB divides exactly at every ladder rung.
      ["96 MiB @ 8", 96 * MIB, 8, 8, 12 * MIB],
      ["96 MiB @ 12", 96 * MIB, 12, 12, 8 * MIB],
      ["96 MiB @ 16", 96 * MIB, 16, 16, 6 * MIB],
      ["96 MiB @ 24", 96 * MIB, 24, 24, 4 * MIB],
      ["96 MiB @ 32", 96 * MIB, 32, 32, 3 * MIB],
      // Files smaller than 32 MiB cannot give 32 streams their 1 MiB floor:
      // the file-size cap wins over the requested tier.
      ["20 MiB @ 32 → floor cap", 20 * MIB, 32, 20, MIB],
      ["16 MiB @ 24 → floor cap", 16 * MIB, 24, 16, MIB],
      // A 200 MiB file fits the full cap.
      ["200 MiB @ 32", 200 * MIB, 32, 32, 6.25 * MIB],
    ];
    for (const [label, size, requested, expectedStreams, expectedFirstWindow] of table) {
      const windows = planRangeDownloadWindows(size, requested)!;
      expect(windows, label).toHaveLength(expectedStreams);
      expect(sizes(windows)[0], label).toBe(expectedFirstWindow);
    }
  });

  it("splits the 16 MiB threshold file into 8 contiguous 2 MiB windows at the start tier", () => {
    const windows = planRangeDownloadWindows(16 * MIB)!;

    expect(windows).toHaveLength(8);
    expect(sizes(windows)).toEqual(Array.from({ length: 8 }, () => 2 * MIB));
    expect(windows[0]).toEqual({ start: 0, end: 2 * MIB - 1 });
    expect(windows[7]).toEqual({ start: 14 * MIB, end: 16 * MIB - 1 });
  });

  it("gives the 20 MiB field file 8 × 2.5 MiB by default and 16 × 1.25 MiB when asked for the old tier", () => {
    const startTier = planRangeDownloadWindows(20 * MIB)!;
    expect(startTier).toHaveLength(8);
    expect(sizes(startTier)).toEqual(Array.from({ length: 8 }, () => WINDOW_20MIB_DIV_8));
    expect(startTier[startTier.length - 1].end).toBe(20 * MIB - 1);

    const oldTier = planRangeDownloadWindows(20 * MIB, 16)!;
    expect(oldTier).toHaveLength(16);
    expect(sizes(oldTier)).toEqual(Array.from({ length: 16 }, () => WINDOW_20MIB_DIV_16));
    expect(oldTier[oldTier.length - 1].end).toBe(20 * MIB - 1);
  });

  it("never drops a stream below the 1 MiB floor and never exceeds the 32-stream cap", () => {
    for (const [size, requested] of [
      [DOWNLOAD_RANGE_MIN_BYTES, 32],
      [DOWNLOAD_RANGE_MIN_BYTES + 1, 32],
      [20 * MIB, 32],
      [200 * MIB, 32],
      // 2 GiB is the class hard cap (`MAX_REMOTE_FILE_BYTES`); the pure policy
      // only does arithmetic, so planning it stays cheap.
      [2 * 1024 * MIB, 32],
    ] as const) {
      const windows = planRangeDownloadWindows(size, requested)!;
      expect(windows.length, String(size)).toBeLessThanOrEqual(DOWNLOAD_RANGE_MAX_STREAMS);
      for (const windowBytes of sizes(windows)) {
        expect(windowBytes, String(size)).toBeGreaterThanOrEqual(MIB);
      }
    }
  });

  it("puts the remainder on the last window (equal split, remainder to the tail)", () => {
    const size = 20 * MIB + 1;

    const windows = planRangeDownloadWindows(size)!;

    // Windows 1..7 are exactly floor(size / 8); the tail window owns the
    // extra byte, so it is one byte LARGER, never smaller.
    expect(windows).toHaveLength(8);
    expect(sizes(windows).slice(0, 7)).toEqual(
      Array.from({ length: 7 }, () => WINDOW_20MIB_DIV_8),
    );
    expect(sizes(windows)[7]).toBe(WINDOW_20MIB_DIV_8 + 1);
  });

  it("always covers the file exactly and contiguously", () => {
    for (const size of [
      DOWNLOAD_RANGE_MIN_BYTES,
      DOWNLOAD_RANGE_MIN_BYTES + 1,
      DOWNLOAD_RANGE_MIN_BYTES * 3 + 7,
      20 * MIB + 1,
      200 * MIB,
      512 * MIB,
    ]) {
      for (const requested of [8, 32]) {
        const windows = planRangeDownloadWindows(size, requested)!;
        expect(windows[0].start).toBe(0);
        expect(windows[windows.length - 1].end).toBe(size - 1);
        for (let i = 1; i < windows.length; i++) {
          expect(windows[i].start).toBe(windows[i - 1].end + 1);
        }
        const covered = windows.reduce((sum, w) => sum + (w.end - w.start + 1), 0);
        expect(covered).toBe(size);
      }
    }
  });

  it("keeps files below the Range threshold on the single-stream path", () => {
    expect(planRangeDownloadWindows(Math.floor(15.9 * MIB))).toBeNull();
    expect(planRangeDownloadWindows(DOWNLOAD_RANGE_MIN_BYTES - 1, 32)).toBeNull();
    expect(planRangeDownloadWindows(0)).toBeNull();
    expect(planRangeDownloadWindows(-1)).toBeNull();
  });

  it("refuses non-integer sizes", () => {
    expect(planRangeDownloadWindows(DOWNLOAD_RANGE_MIN_BYTES + 0.5)).toBeNull();
  });

  it("normalizes an invalid requested count instead of breaking the plan", () => {
    expect(planRangeDownloadWindows(96 * MIB, Number.NaN)).toHaveLength(8);
    expect(planRangeDownloadWindows(96 * MIB, Number.POSITIVE_INFINITY)).toHaveLength(8);
    expect(planRangeDownloadWindows(96 * MIB, 0)).toHaveLength(1);
    expect(planRangeDownloadWindows(96 * MIB, -3)).toHaveLength(1);
    expect(planRangeDownloadWindows(96 * MIB, 32.9)).toHaveLength(32);
  });
});

describe("availableRangeTierIndex (尺寸感知的可用档)", () => {
  it("maps a file to the highest ladder rung the 1 MiB floor can fund", () => {
    const table: Array<[string, number, number]> = [
      ["8 MiB", 8 * MIB, 0],
      ["16 MiB", 16 * MIB, 2],
      // The field file: the ladder has no 20 rung, so 16 is the last one.
      ["20 MiB", 20 * MIB, 2],
      ["23 MiB", 23 * MIB, 2],
      ["24 MiB", 24 * MIB, 3],
      ["28 MiB", 28 * MIB, 3],
      ["31 MiB", 31 * MIB, 3],
      ["32 MiB", 32 * MIB, 4],
      ["40 MiB", 40 * MIB, 4],
      ["200 MiB", 200 * MIB, 4],
    ];
    for (const [label, size, expected] of table) {
      expect(availableRangeTierIndex(size), label).toBe(expected);
      expect(
        DOWNLOAD_RANGE_STREAM_LADDER[availableRangeTierIndex(size)],
        label,
      ).toBeLessThanOrEqual(Math.floor(size / MIB));
    }
  });

  it("keeps the window planner's 20 MiB clamp separate from the probed rung", () => {
    // Requesting 24/32 still yields the 20 windows the file can pay for; the
    // controller uses the helper so it never treats those as a 24/32 step.
    expect(planRangeDownloadWindows(20 * MIB, 24)).toHaveLength(20);
    expect(planRangeDownloadWindows(20 * MIB, 32)).toHaveLength(20);
    expect(availableRangeTierIndex(20 * MIB)).toBe(2);
    expect(DOWNLOAD_RANGE_STREAM_LADDER[2]).toBe(16);
  });

  it("returns -1 for invalid sizes and sizes below the first rung", () => {
    expect(availableRangeTierIndex(0)).toBe(-1);
    expect(availableRangeTierIndex(-1)).toBe(-1);
    expect(availableRangeTierIndex(7 * MIB)).toBe(-1);
    expect(availableRangeTierIndex(Number.NaN)).toBe(-1);
    expect(availableRangeTierIndex(20 * MIB + 0.5)).toBe(-1);
  });
});
