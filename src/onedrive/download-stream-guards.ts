/** Shared streaming-download guards for every CDN body reader (fetch sites
 *  and the Node-https multi-range streams alike). Moved verbatim from
 *  client.ts on 2026-09-14 so the multi-range downloader can reuse the exact
 *  stall/slow semantics without a client.ts import cycle.
 *
 *  The zero-progress watchdog guards both the response-header wait and each
 *  body read: firing aborts the linked signal (releasing the underlying
 *  connection) and rejects the guarded promise with a retryable stall error;
 *  the total budget and user cancel keep working through the outer signal
 *  link. The slow-connection gate evaluates the achieved rate over
 *  non-overlapping windows at each body chunk; aborts the attempt (retryable
 *  via the stalled marker) while the reconnect budget lasts, then accepts
 *  the current connection for the rest of the download. */

import {
  compatClearTimeout,
  compatSetTimeout,
  TimeoutHandle,
} from "../obsidian-compat";
import { OneDriveError, OneDriveErrorType } from "./types";

/** Zero-progress watchdog for streaming downloads (60 s, user-decided
 *  2026-09-14). 2026-09-13 real failure: four stalled downloads burned their
 *  full 300–450 s budgets with zero bytes. The watchdog aborts an attempt
 *  when neither response headers nor body bytes arrive for this long, so the
 *  waterfall retries on a fresh connection while budget remains. Reopen at a
 *  larger window if real links show legitimate >60 s stalls being killed. */
export const DOWNLOAD_STALL_WATCHDOG_MS = 60_000;
/** Slow-connection gate (user-decided 2026-09-14; decision function replaced
 *  2026-09-15 by the evidence-driven design — 2026-09-15 research, docs/temp/
 *  20260915-2310). The 2026-09-15 iPhone evidence showed the absolute 512 KiB/s
 *  line self-destructs on genuinely slow links: every large file burned its
 *  full reconnect budget (3×15–30s plus metadata round trips) on connections
 *  that never improved, because ANY rate below the line aborted. The predicate
 *  is now relative: a window is slow only when it is both under the ceiling
 *  and dramatically below what this link recently proved (p75 × k), with a
 *  completion-imminence exemption so a nearly finished file is never
 *  abandoned. The window length, reconnect budget, accept semantics and error
 *  shape are unchanged from the 2026-09-14 design. Desktop ten-connection
 *  sample (84 KiB/s – 1.3 MiB/s) still hunts the tail: collapsed connections
 *  stay far below 0.45 × p75 and are abandoned; mid-rate ones are accepted
 *  earlier than before. Reopen at a different factor if real links show legit
 *  rates being killed (or stalls being kept). */
export const DOWNLOAD_SLOW_RATE_BYTES_PER_SECOND = 512 * 1024;
export const DOWNLOAD_SLOW_RATE_WINDOW_MS = 15_000;
export const DOWNLOAD_SLOW_ABORT_LIMIT = 3;
/** Relative-judgment factor: a window is slow when rate < factor × baseline.
 *  2026-09-15 reconnect outcomes (105→90→106, ratios ~0.86 must NOT abort)
 *  and genuine collapses (148→44→5, ratios ~0.3 must abort) sit an order of
 *  magnitude apart; 0.45 separates them with margin either way. */
export const DOWNLOAD_SLOW_RELATIVE_FACTOR = 0.45;
/** Reconnect cost estimate for the completion-imminence exemption: the next
 *  tier's metadata round trip observed at 2–20s on real slow links, taken at
 *  the conservative (high) end so the exemption prefers keeping connections. */
export const DOWNLOAD_SLOW_RECONNECT_COST_MS = 10_000;
/** Baseline ring size: the last completed window rates this link produced.
 *  p75 tolerates up to 2 of 8 outlier bursts; per-round lifetime keeps a
 *  stale baseline from outliving the network it described. */
export const DOWNLOAD_SLOW_BASELINE_SAMPLES = 8;

export interface SlowLinkEvidence {
  record(rateBytesPerSecond: number): void;
  /** p75 of the previously recorded window rates; null before the first
   *  sample (the judging window is excluded — self-comparison is degenerate). */
  baseline(): number | null;
}

export function createSlowLinkEvidence(): SlowLinkEvidence {
  const samples: number[] = [];
  return {
    record(rateBytesPerSecond: number): void {
      samples.push(rateBytesPerSecond);
      if (samples.length > DOWNLOAD_SLOW_BASELINE_SAMPLES) samples.shift();
    },
    baseline(): number | null {
      if (samples.length === 0) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1);
      return sorted[index];
    },
  };
}

export interface SlowConnectionGateOptions {
  /** Shared per-round link evidence; without it the gate falls back to the
   *  legacy absolute-threshold rule (first window of every round pays the
   *  cold-start tuition against the absolute line, later windows judge
   *  relatively). */
  evidence?: SlowLinkEvidence;
  /** Expected total transfer size; enables the completion-imminence
   *  exemption when known. Multi-stream windows pass their window size. */
  totalSize?: number;
}

export interface DownloadStallWatchdog {
  signal: AbortSignal;
  readonly slowGate?: SlowConnectionGate;
  guard<T>(pending: Promise<T>): Promise<T>;
  dispose(): void;
}

export interface SlowConnectionGate {
  beginAttempt(): void;
  evaluate(totalBytes: number): void;
}

export function createSlowConnectionGate(
  label: string,
  options: SlowConnectionGateOptions = {},
): SlowConnectionGate {
  let windowStart: number | null = null;
  let windowBytes = 0;
  let aborts = 0;
  let accepted = false;
  let priorAbortRateBytesPerSecond: number | null = null;
  return {
    beginAttempt(): void {
      windowStart = null;
      windowBytes = 0;
    },
    evaluate(totalBytes: number): void {
      if (accepted) return;
      const now = Date.now();
      if (windowStart === null) {
        windowStart = now;
        windowBytes = totalBytes;
        return;
      }
      const elapsedMs = now - windowStart;
      if (elapsedMs < DOWNLOAD_SLOW_RATE_WINDOW_MS) return;
      const rateBytesPerSecond = (totalBytes - windowBytes) / (elapsedMs / 1000);
      windowStart = now;
      windowBytes = totalBytes;
      // Judge against prior evidence only: the judging window must not be
      // compared with itself. Cold start (no sample yet) keeps the legacy
      // absolute rule byte-for-byte.
      const baseline = options.evidence?.baseline() ?? null;
      options.evidence?.record(rateBytesPerSecond);
      const isSlow = rateBytesPerSecond < DOWNLOAD_SLOW_RATE_BYTES_PER_SECOND
        && (baseline === null
          || rateBytesPerSecond < DOWNLOAD_SLOW_RELATIVE_FACTOR * baseline);
      if (!isSlow) return;
      if (isCompletionImminent(options.totalSize, totalBytes, rateBytesPerSecond)) return;
      if (aborts >= DOWNLOAD_SLOW_ABORT_LIMIT) {
        accepted = true;
        return;
      }
      aborts++;
      const priorRateBytesPerSecond = priorAbortRateBytesPerSecond;
      priorAbortRateBytesPerSecond = rateBytesPerSecond;
      throw Object.assign(
        new OneDriveError(
          OneDriveErrorType.NetworkError,
          `Download too slow — ${Math.round(rateBytesPerSecond / 1024)} KiB/s sustained ${Math.round(elapsedMs / 1000)}s (reconnect ${aborts}/${DOWNLOAD_SLOW_ABORT_LIMIT}): ${label}`,
        ),
        {
          stalled: true,
          // Phase-1 telemetry (2026-09-15 乙路): before/after pairing across
          // consecutive aborts, consumed by downloadErrorData diagnostics.
          slowGateRateKiBps: Math.round(rateBytesPerSecond / 1024),
          ...(priorRateBytesPerSecond !== null
            ? { slowGatePriorRateKiBps: Math.round(priorRateBytesPerSecond / 1024) }
            : {}),
        },
      );
    },
  };
}

/** Completion-imminence exemption: never abandon a connection whose remaining
 *  transfer finishes sooner than a reconnect would cost (metadata round trip
 *  plus re-downloading the bytes a restart discards, assuming the next
 *  connection is no faster than the current one — conservative). Disabled
 *  while the size is unknown. Revisit the dropped-bytes term if range resume
 *  (甲路, docs/temp/20260915-2310) stops restarts from discarding bytes. */
function isCompletionImminent(
  totalSize: number | undefined,
  receivedBytes: number,
  rateBytesPerSecond: number,
): boolean {
  if (!totalSize || totalSize <= 0 || rateBytesPerSecond <= 0) return false;
  const remainingMs = ((totalSize - receivedBytes) / rateBytesPerSecond) * 1000;
  const reconnectCostMs = DOWNLOAD_SLOW_RECONNECT_COST_MS
    + (receivedBytes / rateBytesPerSecond) * 1000;
  return remainingMs <= reconnectCostMs;
}

export function createDownloadStallWatchdog(
  outerSignal: AbortSignal | null | undefined,
  label: string,
  slowGate?: SlowConnectionGate,
): DownloadStallWatchdog {
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  slowGate?.beginAttempt();
  let timer: TimeoutHandle | null = null;
  let rejectCurrent: ((error: Error) => void) | null = null;
  return {
    signal: controller.signal,
    slowGate,
    guard<T>(pending: Promise<T>): Promise<T> {
      if (timer !== null) compatClearTimeout(timer);
      const gate = new Promise<never>((_, reject) => { rejectCurrent = reject; });
      timer = compatSetTimeout(() => {
        timer = null;
        // Reject the gate BEFORE aborting: abort settles the guarded promise
        // with an AbortError synchronously, and the race must observe the
        // stall error first or the failure looks like a user cancel.
        rejectCurrent?.(Object.assign(
          new OneDriveError(
            OneDriveErrorType.NetworkError,
            `Download stalled — no progress for ${DOWNLOAD_STALL_WATCHDOG_MS} ms: ${label}`,
          ),
          { stalled: true },
        ));
        controller.abort();
      }, DOWNLOAD_STALL_WATCHDOG_MS);
      return Promise.race([pending, gate]).finally(() => {
        if (timer !== null) {
          compatClearTimeout(timer);
          timer = null;
        }
      });
    },
    dispose(): void {
      if (timer !== null) {
        compatClearTimeout(timer);
        timer = null;
      }
      rejectCurrent = null;
      outerSignal?.removeEventListener("abort", onOuterAbort);
    },
  };
}

export function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw abortError();
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => compatSetTimeout(() => resolve(), ms));
}

export function sleepWithAbort(ms: number, signal: AbortSignal | null): Promise<void> {
  if (!signal) return sleep(ms);
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = compatSetTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      compatClearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function requestErrorMessage(rawError: unknown): string {
  const message = rawError instanceof Error ? rawError.message : String(rawError);
  return message.replace(/https?:\/\/\S+/g, "[redacted-url]");
}
