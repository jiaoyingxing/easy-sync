import { describe, expect, it } from "vitest";
import {
  MAX_SIZE_EXCLUSION_BASELINE_PATHS,
  normalizeSizeExclusionBaseline,
} from "../src/sync/skip-baseline";

describe("size exclusion baseline", () => {
  it("normalizes persisted path lists and tolerates dirty data", () => {
    expect(normalizeSizeExclusionBaseline(["a.mp4", "b.m4a"])).toEqual([
      "a.mp4",
      "b.m4a",
    ]);
    // Dedupe repeated paths (mirror writes are whole-set, but persisted data
    // may come from older shapes).
    expect(
      normalizeSizeExclusionBaseline(["a.mp4", "a.mp4", "b.m4a"]),
    ).toEqual(["a.mp4", "b.m4a"]);
    expect(normalizeSizeExclusionBaseline(undefined)).toEqual([]);
    expect(normalizeSizeExclusionBaseline(null)).toEqual([]);
    expect(normalizeSizeExclusionBaseline("video.mp4")).toEqual([]);
    expect(normalizeSizeExclusionBaseline([1, "", "a.mp4", null])).toEqual([
      "a.mp4",
    ]);
  });

  it("keeps the capacity guard well above ordinary exclusion sets", () => {
    // 2026-09-16 取证：实测库 107 个被排除文件；容量护栏只拦极端库，
    // 触发后回退现役全量展示（可见性不丢），不做静默截断。
    expect(MAX_SIZE_EXCLUSION_BASELINE_PATHS).toBe(2000);
  });
});
