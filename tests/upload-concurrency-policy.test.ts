// 上传自适应并发（AIMD）
// 旧策略按「本轮峰值」比对整批墙钟，任一批掉到峰值一半、或任一批失败，就把整轮
// 锁成串行且不再恢复（2026-10-26 实测 2,100 个文件因此跑了 82 分钟）。新策略只用
// 单个文件的 contentTransfer 吞吐做窗口比较：健康即 +1，连续三个塌陷窗口才 -1，
// 429/509 暂停并按 Retry-After 等待后并发减半、之后还能爬回来。

import { describe, expect, it } from "vitest";
import {
  DESKTOP_UPLOAD_MAX_CONCURRENCY,
  MOBILE_UPLOAD_MAX_CONCURRENCY,
  largeUploadConcurrency,
  UploadConcurrencyPolicy,
  type UploadConcurrencyChange,
  type UploadFileSample,
} from "../src/sync/upload-concurrency-policy";

/** Mirrors `RAMP_WINDOW_FILES`: one AIMD window is four successful files. */
const WINDOW = 4;
/** A healthy file: 100 bytes in 10 ms ⇒ 10 bytes per ms. */
const HEALTHY: UploadFileSample = { bytes: 100, transferMs: 10 };
/** The field shape that locked the old policy: 45% of the healthy throughput
 *  (one wave of four files taking 6.98 s instead of 3.1 s). It is still a
 *  success — `failed=false`, no 429, no error. */
const SLOW: UploadFileSample = { bytes: 100, transferMs: 22.2 };

function feedWindow(
  policy: UploadConcurrencyPolicy,
  sample: UploadFileSample = HEALTHY,
): UploadConcurrencyChange[] {
  const changes: UploadConcurrencyChange[] = [];
  for (let index = 0; index < WINDOW; index++) {
    const change = policy.noteFile(sample);
    if (change) changes.push(change);
  }
  return changes;
}

function feedWindows(
  policy: UploadConcurrencyPolicy,
  windows: number,
  sample: UploadFileSample = HEALTHY,
): UploadConcurrencyChange[] {
  const changes: UploadConcurrencyChange[] = [];
  for (let index = 0; index < windows; index++) {
    changes.push(...feedWindow(policy, sample));
  }
  return changes;
}

describe("UploadConcurrencyPolicy (AIMD)", () => {
  it("climbs from two to the desktop ceiling on a stable link, then holds", () => {
    const policy = new UploadConcurrencyPolicy(false);

    expect(policy.limit).toBe(2);
    const changes = feedWindows(policy, 6);

    expect(policy.limit).toBe(DESKTOP_UPLOAD_MAX_CONCURRENCY);
    expect(changes.map((change) => change.to)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(changes.every((change) => change.reason === "ramp-up")).toBe(true);
    expect(changes.every((change) => change.cause === "window-throughput"))
      .toBe(true);

    // Converged: at the ceiling a healthy window has nowhere to step and the
    // pool stops looking for one.
    expect(feedWindows(policy, 4)).toEqual([]);
    expect(policy.limit).toBe(DESKTOP_UPLOAD_MAX_CONCURRENCY);
  });

  it("keeps mobile serial at first and stops at three", () => {
    const policy = new UploadConcurrencyPolicy(true);

    expect(policy.limit).toBe(1);
    expect(feedWindow(policy).map((change) => change.to)).toEqual([2]);
    expect(feedWindow(policy).map((change) => change.to)).toEqual([3]);
    expect(feedWindows(policy, 3)).toEqual([]);
    expect(policy.limit).toBe(MOBILE_UPLOAD_MAX_CONCURRENCY);
  });

  it("does not degrade on one slow (but successful) window, and climbs again", () => {
    const policy = new UploadConcurrencyPolicy(false);
    feedWindows(policy, 2);
    expect(policy.limit).toBe(4);

    // The reported incident: one window at 45% of the reference throughput.
    // The old policy locked the round to serial here and never looked again.
    expect(feedWindow(policy, SLOW)).toEqual([]);
    expect(policy.limit).toBe(4);

    // The link is healthy again; the slow window cost one probe, not the round.
    expect(feedWindows(policy, 2).map((change) => change.to)).toEqual([5, 6]);
  });

  it("steps down one level after three consecutive collapsing windows", () => {
    const policy = new UploadConcurrencyPolicy(false);
    feedWindows(policy, 4);
    expect(policy.limit).toBe(6);

    expect(feedWindow(policy, SLOW)).toEqual([]);
    expect(feedWindow(policy, SLOW)).toEqual([]);
    const third = feedWindow(policy, SLOW);

    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({
      from: 6,
      to: 5,
      reason: "regression",
      cause: "window-throughput",
      lowWindows: 3,
    });
    // Never the old "back to one, forever".
    expect(policy.limit).toBe(5);
  });

  it("re-measures after a step down instead of chaining decreases", () => {
    const policy = new UploadConcurrencyPolicy(false);
    feedWindows(policy, 4);
    feedWindows(policy, 3, SLOW);
    expect(policy.limit).toBe(5);

    // Settle window at the new depth: the samples that argued for the step
    // down describe a depth the pool just left, so they cannot argue again.
    expect(feedWindow(policy, SLOW)).toEqual([]);
    expect(policy.limit).toBe(5);

    expect(feedWindow(policy)).toMatchObject([
      { from: 5, to: 6, reason: "ramp-up" },
    ]);
  });

  it("ignores a single failed file and steps down on two consecutive ones", () => {
    const policy = new UploadConcurrencyPolicy(false);
    feedWindows(policy, 4);
    expect(policy.limit).toBe(6);

    expect(policy.noteFailure()).toBeNull();
    expect(policy.limit).toBe(6);

    // A success in between resets the streak.
    feedWindow(policy);
    expect(policy.limit).toBe(7);
    expect(policy.noteFailure()).toBeNull();
    expect(policy.noteFailure()).toMatchObject({
      from: 7,
      to: 6,
      reason: "regression",
      cause: "failure-streak",
    });
  });

  it("pauses the direction for Retry-After and halves, then climbs again", () => {
    const policy = new UploadConcurrencyPolicy(false);
    feedWindows(policy, 4);
    expect(policy.limit).toBe(6);

    const throttled = policy.noteThrottle(1_000, 2);

    expect(throttled.change).toMatchObject({
      from: 6,
      to: 3,
      reason: "throttle",
    });
    expect(throttled.pauseMs).toBe(2_000);
    expect(policy.pauseRemainingMs(1_000)).toBe(2_000);
    expect(policy.pauseRemainingMs(2_999)).toBe(1);
    expect(policy.pauseRemainingMs(3_000)).toBe(0);
    expect(policy.limit).toBe(3);

    // A second 429 inside the same pause window extends the pause but does not
    // halve again: one rate-limit episode, one step.
    const extended = policy.noteThrottle(1_500, 2);
    expect(extended.change).toBeNull();
    expect(extended.pauseMs).toBe(2_000);
    expect(policy.pauseRemainingMs(3_500)).toBe(0);
    expect(policy.limit).toBe(3);

    // After the pause the pool re-measures and climbs back to the ceiling.
    expect(feedWindow(policy)).toEqual([]);
    expect(feedWindows(policy, 5).map((change) => change.to))
      .toEqual([4, 5, 6, 7, 8]);
    expect(policy.limit).toBe(DESKTOP_UPLOAD_MAX_CONCURRENCY);
  });

  it("still pauses when the throttle arrives at the floor", () => {
    const policy = new UploadConcurrencyPolicy(true);

    const throttled = policy.noteThrottle(0, 1);

    expect(throttled.change).toBeNull();
    expect(throttled.pauseMs).toBe(1_000);
    expect(policy.pauseRemainingMs(0)).toBe(1_000);
    expect(policy.limit).toBe(1);
  });

  it("falls back to its own pause when Retry-After is missing", () => {
    const policy = new UploadConcurrencyPolicy(false);

    // 429/509 without a usable Retry-After header: the direction still pauses
    // instead of hammering the throttled endpoint.
    const throttled = policy.noteThrottle(0, null);

    expect(throttled.pauseMs).toBe(5_000);
    expect(policy.pauseRemainingMs(4_999)).toBe(1);
    expect(policy.pauseRemainingMs(5_000)).toBe(0);
  });

  it("ignores files that transferred no bytes", () => {
    const policy = new UploadConcurrencyPolicy(false);

    expect(policy.noteFile({ bytes: 0, transferMs: 0 })).toBeNull();
    expect(feedWindow(policy).map((change) => change.to)).toEqual([3]);
  });
});

describe("largeUploadConcurrency (B② cross-file parallelism)", () => {
  it("keeps two desktop sessions in flight", () => {
    expect(largeUploadConcurrency(false)).toBe(2);
  });

  it("keeps mobile serial", () => {
    expect(largeUploadConcurrency(true)).toBe(1);
  });
});
