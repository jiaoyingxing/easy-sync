import { SIGNIFICANT_THROUGHPUT_DROP_RATIO } from "./transfer-throughput-threshold";

export const ADAPTIVE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const DESKTOP_UPLOAD_MAX_CONCURRENCY = 8;
export const MOBILE_UPLOAD_MAX_CONCURRENCY = 3;

const DESKTOP_INITIAL_CONCURRENCY = 2;
const MOBILE_INITIAL_CONCURRENCY = 1;
const MIN_CONCURRENCY = 1;

/** Successful files per AIMD window. Smaller than the desktop persistence
 *  batch (8) on purpose: one batch then spans two decision windows, so the
 *  pool can still step inside a batch instead of only between batches. */
const RAMP_WINDOW_FILES = 4;
/** Samples behind the "recent median" reference: the two previous windows. */
const REFERENCE_SAMPLES = 8;
/** Consecutive windows below half the reference before one step down. */
const REGRESSION_WINDOWS = 3;
/** Consecutive failed files before one step down (a single failed file stays
 *  on its own exit and must not touch the pool). */
const FAILURE_STREAK_LIMIT = 2;
/** Pause used when a 429/509 arrives without a usable Retry-After. */
const THROTTLE_FALLBACK_PAUSE_MS = 5_000;

const LARGE_UPLOAD_CONCURRENCY_DESKTOP = 2;
const LARGE_UPLOAD_CONCURRENCY_MOBILE = 1;

/**
 * Fixed cross-file parallelism for large (> ADAPTIVE_UPLOAD_MAX_BYTES)
 * uploads. OneDrive upload-session chunks are order-mandated within a
 * single session, but separate sessions (one per file) may run
 * concurrently. Desktop keeps two sessions in flight so one file's
 * per-chunk request overhead overlaps another file's transfer; mobile
 * stays serial because two concurrent large uploads would hold two full
 * file reads plus two chunk buffers in memory at once.
 */
export function largeUploadConcurrency(isMobile: boolean): number {
  return isMobile
    ? LARGE_UPLOAD_CONCURRENCY_MOBILE
    : LARGE_UPLOAD_CONCURRENCY_DESKTOP;
}

/** Why the pool's concurrency changed. `ramp-up` and `regression` are the
 *  AIMD steps; `throttle` is the 429/509 response (halve + global pause). */
type UploadConcurrencyChangeReason = "ramp-up" | "regression" | "throttle";

/** Which rule decided a step. Absent on `throttle`: the rate-limit header is
 *  the evidence, not a measured window. */
type UploadConcurrencyChangeCause =
  | "window-throughput"
  | "failure-streak";

export interface UploadConcurrencyChange {
  from: number;
  to: number;
  reason: UploadConcurrencyChangeReason;
  cause?: UploadConcurrencyChangeCause;
  /** Throughput of the window that decided the step, in bytes per ms. */
  windowThroughput?: number;
  /** Median of the reference samples the window was compared against. */
  referenceMedian?: number;
  /** Consecutive collapsing windows behind the step (1..REGRESSION_WINDOWS). */
  lowWindows?: number;
}

/** One settled successful file of the pool. */
export interface UploadFileSample {
  /** Bytes this PUT moved. */
  bytes: number;
  /** The file's own `contentTransfer` duration only — never a batch's wall
   *  clock, so local disk writes, receipts and checkpoints cannot masquerade
   *  as a slow network. */
  transferMs: number;
}

interface UploadThrottlePause {
  /** The step that answered the rate limit; `null` when the pool already sat
   *  at the floor (the pause still applies). */
  change: UploadConcurrencyChange | null;
  /** How long the whole upload direction stops issuing requests. */
  pauseMs: number;
}

/**
 * Per-round adaptive upload concurrency controller (AIMD, 2026-10-26).
 *
 * Replaces the previous "any failed wave or batch-throughput dip locks the
 * rest of the round to serial" policy. That policy compared a mixed-size
 * batch's wall clock (upload start → checkpoint return) against the run's
 * all-time peak, so one batch that happened to include local disk or
 * checkpoint time — or that simply ran at a larger concurrency, where
 * per-file throughput is naturally lower — locked the round for good. Field
 * evidence: a 2,100-file upload locked to serial twice in one run and took 82
 * minutes (`docs/dev-logs/2026-10/20261026-2110 …`).
 *
 * The only input is the per-file `contentTransfer` throughput
 * (`bytes / transferMs`), which is what a single PUT can attribute and what
 * stays stable when a deeper pool merely overlaps more round trips:
 *
 * - every `RAMP_WINDOW_FILES` successes whose mean throughput is at least the
 *   median of the last `REFERENCE_SAMPLES` samples steps up by one. Equality
 *   counts as healthy: a deeper pool that costs nothing is exactly what the
 *   overlap is for, and a step down has to be able to probe back up;
 * - three consecutive windows below `SIGNIFICANT_THROUGHPUT_DROP_RATIO` of
 *   that median step down by one (never below one, never a lock). A
 *   collapsing window does not move the reference, otherwise the baseline
 *   would follow the slowdown down and the streak could never reach three;
 * - a 429/509 pauses the whole upload direction for Retry-After and halves
 *   the limit; the pause is a gate, not a terminal state, and the pool can
 *   climb again afterwards;
 * - a single failed or timed-out file stays on its own exit and changes
 *   nothing here; two consecutive failures step down by one.
 */
export class UploadConcurrencyPolicy {
  private readonly maxConcurrency: number;
  private concurrency: number;
  /** Throughput samples of the window still filling up. */
  private window: number[] = [];
  /** The "recent median" reference: samples of the windows before this one. */
  private reference: number[] = [];
  private lowWindows = 0;
  private failedFiles = 0;
  /** The round's first window has no reference yet and takes the optimistic
   *  step; after that every step needs measured evidence. */
  private optimisticRamp: boolean;
  private pausedUntilMs = 0;

  constructor(private readonly mobile: boolean) {
    this.maxConcurrency = mobile
      ? MOBILE_UPLOAD_MAX_CONCURRENCY
      : DESKTOP_UPLOAD_MAX_CONCURRENCY;
    this.concurrency = mobile
      ? MOBILE_INITIAL_CONCURRENCY
      : DESKTOP_INITIAL_CONCURRENCY;
    this.optimisticRamp = true;
  }

  get limit(): number {
    return this.concurrency;
  }

  get maxLimit(): number {
    return this.maxConcurrency;
  }

  /** Consume one successful file. Returns the step it decided, if any. */
  noteFile(sample: UploadFileSample): UploadConcurrencyChange | null {
    // Every settled success ends a failure streak, including the ones that
    // never entered the PUT (zero bytes or zero transfer time).
    this.failedFiles = 0;
    if (sample.bytes <= 0 || sample.transferMs <= 0) return null;
    this.window.push(sample.bytes / sample.transferMs);
    if (this.window.length < RAMP_WINDOW_FILES) return null;
    return this.closeWindow();
  }

  /** Consume one failed file. Only a second consecutive failure steps down. */
  noteFailure(): UploadConcurrencyChange | null {
    this.failedFiles++;
    if (this.failedFiles < FAILURE_STREAK_LIMIT) return null;
    this.failedFiles = 0;
    return this.applyTarget(this.concurrency - 1, {
      reason: "regression",
      cause: "failure-streak",
      lowWindows: this.lowWindows,
    });
  }

  /** Consume a 429/509. Pauses the whole upload direction for Retry-After and
   *  halves the limit. Repeated throttles inside one pause window extend the
   *  pause but do not halve again (one rate-limit episode, one step). */
  noteThrottle(
    nowMs: number,
    retryAfterSeconds: number | null | undefined,
  ): UploadThrottlePause {
    const pauseMs = retryAfterSeconds === null
      || retryAfterSeconds === undefined
      || !Number.isFinite(retryAfterSeconds)
      || retryAfterSeconds < 0
      ? THROTTLE_FALLBACK_PAUSE_MS
      : Math.round(retryAfterSeconds * 1_000);
    const alreadyPaused = nowMs < this.pausedUntilMs;
    this.pausedUntilMs = Math.max(this.pausedUntilMs, nowMs + pauseMs);
    this.failedFiles = 0;
    this.window = [];
    this.lowWindows = 0;
    if (alreadyPaused) return { change: null, pauseMs };
    return {
      change: this.applyTarget(
        Math.ceil(this.concurrency / 2),
        { reason: "throttle" },
      ),
      pauseMs,
    };
  }

  /** How long the upload direction must not start a request. */
  pauseRemainingMs(nowMs: number): number {
    return Math.max(0, this.pausedUntilMs - nowMs);
  }

  private closeWindow(): UploadConcurrencyChange | null {
    const samples = this.window.splice(0, this.window.length);
    const throughput = samples.reduce((sum, sample) => sum + sample, 0)
      / samples.length;
    const reference = this.reference;
    const referenceMedian = medianOf(reference);
    const collapse = reference.length > 0
      && throughput < referenceMedian * SIGNIFICANT_THROUGHPUT_DROP_RATIO;
    if (!collapse) {
      this.reference = [...reference, ...samples].slice(-REFERENCE_SAMPLES);
    }

    if (reference.length === 0) {
      const change = this.optimisticRamp
        ? this.applyTarget(this.concurrency + 1, {
            reason: "ramp-up",
            cause: "window-throughput",
            windowThroughput: throughput,
          })
        : null;
      this.optimisticRamp = false;
      return change;
    }
    if (collapse) {
      this.lowWindows++;
      if (this.lowWindows < REGRESSION_WINDOWS) return null;
      const lowWindows = this.lowWindows;
      this.lowWindows = 0;
      return this.applyTarget(this.concurrency - 1, {
        reason: "regression",
        cause: "window-throughput",
        windowThroughput: throughput,
        referenceMedian,
        lowWindows,
      });
    }
    this.lowWindows = 0;
    if (throughput >= referenceMedian) {
      return this.applyTarget(this.concurrency + 1, {
        reason: "ramp-up",
        cause: "window-throughput",
        windowThroughput: throughput,
        referenceMedian,
      });
    }
    return null;
  }

  private applyTarget(
    target: number,
    detail: Omit<UploadConcurrencyChange, "from" | "to">,
  ): UploadConcurrencyChange | null {
    const from = this.concurrency;
    const to = Math.min(
      this.maxConcurrency,
      Math.max(MIN_CONCURRENCY, Math.round(target)),
    );
    if (to === from) return null;
    this.concurrency = to;
    if (to < from) {
      // A step down re-measures from the new level: the samples that argued
      // for it describe a depth we just left, so comparing the next window
      // against them would chain the decrease. The next window is a settle
      // window, then the pool probes upward again.
      this.reference = [];
      this.lowWindows = 0;
      this.optimisticRamp = false;
    }
    return { from, to, ...detail };
  }
}

function medianOf(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
