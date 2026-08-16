import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MUTATION_RECOVERY_BACKOFF_MS,
  MUTATION_RECOVERY_MAX_AUTOMATIC_OBSERVATIONS,
  MutationRecoveryScheduler,
} from "../src/sync/mutation-recovery-scheduler";

describe("MutationRecoveryScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces persisted-intent triggers and retries with bounded exponential delays", async () => {
    vi.useFakeTimers();
    const observe = vi.fn()
      .mockResolvedValueOnce({ state: "retry", retryAfterSeconds: null })
      .mockResolvedValueOnce({ state: "retry", retryAfterSeconds: null })
      .mockResolvedValueOnce({ state: "settled" });
    const exhausted = vi.fn();
    const scheduler = new MutationRecoveryScheduler(
      observe,
      exhausted,
      () => 0,
    );

    expect(scheduler.requestObservation()).toBe(true);
    expect(scheduler.requestObservation()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).toHaveBeenCalledOnce();
    expect(scheduler.observationCount).toBe(1);

    await vi.advanceTimersByTimeAsync(MUTATION_RECOVERY_BACKOFF_MS[0] - 1);
    expect(observe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(scheduler.observationCount).toBe(2);

    await vi.advanceTimersByTimeAsync(MUTATION_RECOVERY_BACKOFF_MS[1]);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(scheduler.pending).toBe(false);
    expect(scheduler.observationCount).toBe(0);
    expect(exhausted).not.toHaveBeenCalled();
  });

  it("never retries before Retry-After even when the local policy is shorter", async () => {
    vi.useFakeTimers();
    const observe = vi.fn()
      .mockResolvedValueOnce({ state: "retry", retryAfterSeconds: 30 })
      .mockResolvedValueOnce({ state: "settled" });
    const scheduler = new MutationRecoveryScheduler(
      observe,
      vi.fn(),
      () => 0,
    );

    scheduler.requestObservation();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(observe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("sleeps after the fast budget and permits one externally triggered probe", async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockResolvedValue({
      state: "retry",
      retryAfterSeconds: null,
    });
    const exhausted = vi.fn();
    const scheduler = new MutationRecoveryScheduler(
      observe,
      exhausted,
      () => 0,
    );

    scheduler.requestObservation();
    await vi.runAllTimersAsync();

    expect(observe).toHaveBeenCalledTimes(
      MUTATION_RECOVERY_MAX_AUTOMATIC_OBSERVATIONS,
    );
    expect(exhausted).toHaveBeenCalledOnce();
    expect(scheduler.budgetExhausted).toBe(true);
    expect(scheduler.pending).toBe(false);
    expect(scheduler.requestObservation()).toBe(false);
    expect(scheduler.requestObservationAfterExhaustion()).toBe(true);
    await vi.runAllTimersAsync();
    expect(observe).toHaveBeenCalledTimes(
      MUTATION_RECOVERY_MAX_AUTOMATIC_OBSERVATIONS + 1,
    );
    expect(exhausted).toHaveBeenCalledTimes(2);
    expect(scheduler.budgetExhausted).toBe(true);
    expect(scheduler.pending).toBe(false);
  });

  it("does not count a busy operation gate against the recovery budget", async () => {
    vi.useFakeTimers();
    const observe = vi.fn()
      .mockResolvedValueOnce({ state: "busy" })
      .mockResolvedValueOnce({ state: "settled" });
    const scheduler = new MutationRecoveryScheduler(
      observe,
      vi.fn(),
      () => 0,
    );

    scheduler.requestObservation();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.observationCount).toBe(0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(observe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(scheduler.observationCount).toBe(0);
  });

  it("cancels an in-flight observation without letting its late result re-arm", async () => {
    vi.useFakeTimers();
    let finish!: (value: {
      state: "retry";
      retryAfterSeconds: null;
    }) => void;
    const observe = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const scheduler = new MutationRecoveryScheduler(
      observe,
      vi.fn(),
      () => 0,
    );

    scheduler.requestObservation();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.cancel();
    finish({ state: "retry", retryAfterSeconds: null });
    await Promise.resolve();

    expect(scheduler.pending).toBe(false);
    expect(scheduler.observationCount).toBe(0);
    await vi.runAllTimersAsync();
    expect(observe).toHaveBeenCalledOnce();
  });

  it("continues from an external failed observation without requiring a dirty event", async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockResolvedValue({ state: "settled" });
    const scheduler = new MutationRecoveryScheduler(
      observe,
      vi.fn(),
      () => 0,
    );

    expect(scheduler.continueAfterExternalFailure(null)).toBe(true);
    await vi.advanceTimersByTimeAsync(MUTATION_RECOVERY_BACKOFF_MS[0] - 1);
    expect(observe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(observe).toHaveBeenCalledOnce();
  });

  it("publishes scheduled, running, exhausted, and reset snapshots without owning recovery facts", async () => {
    vi.useFakeTimers();
    const snapshots: string[] = [];
    const scheduler = new MutationRecoveryScheduler(
      vi.fn().mockResolvedValue({
        state: "retry",
        retryAfterSeconds: null,
      }),
      vi.fn(),
      () => 0,
      (snapshot) => {
        snapshots.push(snapshot.state);
      },
    );

    scheduler.requestObservation();
    expect(scheduler.snapshot.state).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toContain("running");
    expect(scheduler.snapshot.state).toBe("scheduled");

    await vi.runAllTimersAsync();
    expect(scheduler.snapshot.state).toBe("exhausted");
    scheduler.reset();
    expect(scheduler.snapshot).toEqual({
      state: "idle",
      automaticObservations: 0,
      nextObservationAt: null,
    });
  });
});
