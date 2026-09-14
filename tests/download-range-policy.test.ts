import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_RANGE_MIN_BYTES,
  DOWNLOAD_RANGE_STREAMS,
  planRangeDownloadWindows,
} from "../src/onedrive/download-range-policy";

describe("planRangeDownloadWindows (C 多流 Range 纯策略)", () => {
  it("splits the threshold-size file into two equal contiguous windows", () => {
    const windows = planRangeDownloadWindows(DOWNLOAD_RANGE_MIN_BYTES);

    expect(DOWNLOAD_RANGE_STREAMS).toBe(2);
    expect(windows).toEqual([
      { start: 0, end: DOWNLOAD_RANGE_MIN_BYTES / 2 - 1 },
      { start: DOWNLOAD_RANGE_MIN_BYTES / 2, end: DOWNLOAD_RANGE_MIN_BYTES - 1 },
    ]);
  });

  it("gives the remainder byte to the last window", () => {
    const size = DOWNLOAD_RANGE_MIN_BYTES + 1;
    const windowBytes = Math.floor(size / 2);

    const windows = planRangeDownloadWindows(size);

    expect(windows).toEqual([
      { start: 0, end: windowBytes - 1 },
      { start: windowBytes, end: size - 1 },
    ]);
  });

  it("always covers the file exactly and contiguously", () => {
    for (const size of [
      DOWNLOAD_RANGE_MIN_BYTES,
      DOWNLOAD_RANGE_MIN_BYTES + 1,
      DOWNLOAD_RANGE_MIN_BYTES * 3 + 7,
      512 * 1024 * 1024,
    ]) {
      const windows = planRangeDownloadWindows(size)!;
      expect(windows[0].start).toBe(0);
      expect(windows[windows.length - 1].end).toBe(size - 1);
      for (let i = 1; i < windows.length; i++) {
        expect(windows[i].start).toBe(windows[i - 1].end + 1);
      }
      const covered = windows.reduce((sum, w) => sum + (w.end - w.start + 1), 0);
      expect(covered).toBe(size);
    }
  });

  it("keeps small files on the single-stream path", () => {
    expect(planRangeDownloadWindows(DOWNLOAD_RANGE_MIN_BYTES - 1)).toBeNull();
    expect(planRangeDownloadWindows(0)).toBeNull();
    expect(planRangeDownloadWindows(-1)).toBeNull();
  });

  it("refuses non-integer sizes", () => {
    expect(planRangeDownloadWindows(DOWNLOAD_RANGE_MIN_BYTES + 0.5)).toBeNull();
  });
});
