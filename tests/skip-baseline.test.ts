import { describe, expect, it } from "vitest";
import {
  countProgressPlanItems,
  isConfigurationSkipAction,
  MAX_HISTORY_SKIP_PATHS,
  MAX_SIZE_EXCLUSION_BASELINE_PATHS,
  normalizeHistorySkipPaths,
  normalizeSizeExclusionBaseline,
} from "../src/sync/skip-baseline";
import { SyncActionType } from "../src/sync/types";

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

describe("history skip paths", () => {
  it("normalizes retained per-round paths and tolerates dirty data", () => {
    // 2026-10-25 拍板：历史每条记录保留当轮跳过路径，让每轮都能展开同一个折叠组。
    expect(normalizeHistorySkipPaths(["a.mp4", "b.m4a"])).toEqual([
      "a.mp4",
      "b.m4a",
    ]);
    expect(normalizeHistorySkipPaths(["a.mp4", "a.mp4"])).toEqual(["a.mp4"]);
    expect(normalizeHistorySkipPaths(undefined)).toEqual([]);
    expect(normalizeHistorySkipPaths("a.mp4")).toEqual([]);
    expect(normalizeHistorySkipPaths([1, "", null, "a.mp4"])).toEqual(["a.mp4"]);
  });

  it("caps one entry's list without changing the round's reported count", () => {
    // 存储上限只截断路径明细；折叠组标题仍报本轮真实总数，差额走「另有 N 个」。
    const many = Array.from(
      { length: MAX_HISTORY_SKIP_PATHS + 50 },
      (_, i) => `video-${i}.mp4`,
    );
    expect(normalizeHistorySkipPaths(many)).toHaveLength(MAX_HISTORY_SKIP_PATHS);
    expect(MAX_HISTORY_SKIP_PATHS).toBeLessThan(MAX_SIZE_EXCLUSION_BASELINE_PATHS);
  });
});

describe("configuration skips stay out of the progress numbers", () => {
  it("classifies size/ignored-path skips as zero-action, but not the rename skip", () => {
    // 2026-10-25 拍板：按设置跳过（超大小／忽略路径）是预期零动作，不进计数；
    // 非法文件名要用户改名，是真实行动——照常计数、照常进「需要处理」。
    expect(isConfigurationSkipAction(SyncActionType.SkipLargeFile)).toBe(true);
    expect(isConfigurationSkipAction(SyncActionType.SkipIgnoredPath)).toBe(true);
    expect(
      isConfigurationSkipAction(SyncActionType.SkipOneDriveInvalidName),
    ).toBe(false);
    expect(isConfigurationSkipAction(SyncActionType.Upload)).toBe(false);
    expect(isConfigurationSkipAction(undefined)).toBe(false);
  });

  it("counts a round's progress denominator by real actions only", () => {
    expect(countProgressPlanItems([
      { type: SyncActionType.Upload },
      { type: SyncActionType.SkipLargeFile },
      { type: SyncActionType.Download },
      { type: SyncActionType.SkipIgnoredPath },
      { type: SyncActionType.SkipOneDriveInvalidName },
    ])).toBe(3);
    expect(countProgressPlanItems([])).toBe(0);
    // 纯跳过轮＝没有可信总数：侧栏不显示计数与进度条。
    expect(countProgressPlanItems([
      { type: SyncActionType.SkipLargeFile },
      { type: SyncActionType.SkipLargeFile },
    ])).toBe(0);
  });
});
