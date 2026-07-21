import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoSyncDirtyHint,
  LOCAL_DIRTY_DEBOUNCE_MS,
} from "../src/sync/auto-sync-dirty-hint";

describe("AutoSyncDirtyHint", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces multiple events into one request", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn().mockResolvedValue(true);
    const hint = new AutoSyncDirtyHint(onReady);

    hint.mark();
    await vi.advanceTimersByTimeAsync(4_000);
    hint.mark();
    await vi.advanceTimersByTimeAsync(LOCAL_DIRTY_DEBOUNCE_MS - 1);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(onReady).toHaveBeenCalledOnce();
    expect(hint.pending).toBe(false);
  });

  it("retains a hint while the shared activity gate is busy", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const hint = new AutoSyncDirtyHint(onReady);

    hint.mark();
    await vi.advanceTimersByTimeAsync(LOCAL_DIRTY_DEBOUNCE_MS);
    expect(hint.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(LOCAL_DIRTY_DEBOUNCE_MS);

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(hint.pending).toBe(false);
  });

  it("retries instead of dropping a hint when the shared entry rejects", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn()
      .mockRejectedValueOnce(new Error("temporary setup failure"))
      .mockResolvedValueOnce(true);
    const hint = new AutoSyncDirtyHint(onReady);

    hint.mark();
    await vi.advanceTimersByTimeAsync(LOCAL_DIRTY_DEBOUNCE_MS * 2);

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(hint.pending).toBe(false);
  });

  it("retries instead of dropping a hint when the shared entry rejects", async () => {
    vi.useFakeTimers();
    const onReady = vi.fn()
      .mockRejectedValueOnce(new Error("temporary setup failure"))
      .mockResolvedValueOnce(true);
    const hint = new AutoSyncDirtyHint(onReady);

    hint.mark();
    await vi.advanceTimersByTimeAsync(LOCAL_DIRTY_DEBOUNCE_MS * 2);

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(hint.pending).toBe(false);
  });

  it("does not let an older run consume an event that arrived in flight", async () => {
    vi.useFakeTimers();
    let finishFirst!: (value: boolean) => void;
    const onReady = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(true);
    const hint = new AutoSyncDirtyHint(onReady);

    hint.mark();
    await vi.advanceTimersByTimeAsync(LOCAL_DIRTY_DEBOUNCE_MS);
    hint.mark();
    finishFirst(true);
    await Promise.resolve();
    expect(hint.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(LOCAL_DIRTY_DEBOUNCE_MS);

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(hint.pending).toBe(false);
  });
});
