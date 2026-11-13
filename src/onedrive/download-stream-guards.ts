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
 *  the current connection for the rest of the download. A judged-slow window
 *  is still kept when the file can finish inside the download's remaining
 *  budget (2026-11-10) — the gate abandons only connections that cannot
 *  deliver the file before the deadline. */

import {
  compatClearTimeout,
  compatSetTimeout,
  describeError,
  TimeoutHandle,
} from "../obsidian-compat";
import { OneDriveError, OneDriveErrorType, SyntheticRequestTimeoutError } from "./types";

/** Zero-progress watchdog for streaming downloads (60 s, user-decided
 *  2026-09-14). 2026-09-13 real failure: four stalled downloads burned their
 *  full 300–450 s budgets with zero bytes. The watchdog aborts an attempt
 *  when neither response headers nor body bytes arrive for this long, so the
 *  waterfall retries on a fresh connection while budget remains. Reopen at a
 *  larger window if real links show legitimate >60 s stalls being killed. */
const DOWNLOAD_STALL_WATCHDOG_MS = 60_000;
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
const DOWNLOAD_SLOW_RATE_BYTES_PER_SECOND = 512 * 1024;
export const DOWNLOAD_SLOW_RATE_WINDOW_MS = 15_000;
export const DOWNLOAD_SLOW_ABORT_LIMIT = 3;
/** Relative-judgment factor: a window is slow when rate < factor × baseline.
 *  2026-09-15 reconnect outcomes (105→90→106, ratios ~0.86 must NOT abort)
 *  and genuine collapses (148→44→5, ratios ~0.3 must abort) sit an order of
 *  magnitude apart; 0.45 separates them with margin either way. */
const DOWNLOAD_SLOW_RELATIVE_FACTOR = 0.45;
/** Reconnect cost estimate for the completion-imminence exemption: the next
 *  tier's metadata round trip observed at 2–20s on real slow links, taken at
 *  the conservative (high) end so the exemption prefers keeping connections. */
const DOWNLOAD_SLOW_RECONNECT_COST_MS = 10_000;
/** Baseline ring size: the last completed window rates this link produced.
 *  p75 tolerates up to 2 of 8 outlier bursts; per-round lifetime keeps a
 *  stale baseline from outliving the network it described. */
const DOWNLOAD_SLOW_BASELINE_SAMPLES = 8;

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

interface SlowConnectionGateOptions {
  /** Shared per-round link evidence; without it the gate falls back to the
   *  legacy absolute-threshold rule (every window is judged against the
   *  absolute line instead of the link's own baseline). */
  evidence?: SlowLinkEvidence;
  /** Expected total transfer size; enables the completion-imminence
   *  exemption when known. Multi-stream windows pass their window size. */
  totalSize?: number;
  /** Remaining time of the download's own waterfall deadline. A connection
   *  whose measured rate still finishes the file inside that window is never
   *  abandoned: a reconnect discards the received prefix, pays a fresh
   *  metadata round trip, and the fallback tiers are usually slower than the
   *  CDN (2026-11-10 iOS 3.6 MiB replay: 80 KiB/s steady, aborted at ~1.2 MiB
   *  by the cold absolute rule, then 15–21 KiB/s on /content until the
   *  deadline — the file could never finish). Omitted by callers with no
   *  per-file budget (multi-stream windows), which keep the old judgment. */
  budgetLeftMs?: () => number;
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
      // compared with itself. Cold start (no sample yet) is an absolute-only
      // judgment, which is exactly what the budget exemption may rescue.
      const baseline = options.evidence?.baseline() ?? null;
      options.evidence?.record(rateBytesPerSecond);
      // A collapse against the link's own evidence is a real signal (the
      // 2026-09-14/15 samples: 148→44→5 KiB/s must abort even mid-budget);
      // only an absolute-only judgment can be rescued by the budget exemption
      // below. Comparable windows were already accepted by `isSlow`.
      const relativeCollapse = baseline !== null
        && rateBytesPerSecond < DOWNLOAD_SLOW_RELATIVE_FACTOR * baseline;
      const isSlow = rateBytesPerSecond < DOWNLOAD_SLOW_RATE_BYTES_PER_SECOND
        && (baseline === null || relativeCollapse);
      if (!isSlow) return;
      if (
        !relativeCollapse
        && finishesWithinBudget(
          options.totalSize,
          totalBytes,
          rateBytesPerSecond,
          options.budgetLeftMs?.(),
        )
      ) return;
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
 *  (甲路, 20260915-2310) stops restarts from discarding bytes. */
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

/** Budget exemption (2026-11-10): the broader form of completion-imminence.
 *  Whatever the rate looks like against the absolute ceiling, a connection
 *  that can still deliver the whole file inside this download's remaining
 *  budget is the round's best bet — aborting it trades a certain (if slow)
 *  success for a restart that discards every landed byte and a fallback
 *  channel measured slower than the one being abandoned. It deliberately does
 *  NOT rescue a window that collapsed relative to the link's own evidence
 *  (`relativeCollapse` in the caller): a decaying connection is what the
 *  reconnect budget exists for. Disabled while size or budget is unknown. */
function finishesWithinBudget(
  totalSize: number | undefined,
  receivedBytes: number,
  rateBytesPerSecond: number,
  budgetLeftMs: number | undefined,
): boolean {
  if (!totalSize || totalSize <= 0 || rateBytesPerSecond <= 0) return false;
  if (budgetLeftMs === undefined || !Number.isFinite(budgetLeftMs)) return false;
  const remainingMs = ((totalSize - receivedBytes) / rateBytesPerSecond) * 1000;
  return remainingMs <= Math.max(0, budgetLeftMs);
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

/** 刀 2 错误路由类型化：请求超时分类器从 client.ts 迁入（2026-11-01，路由
 *  面改判别码后只认类型化超时），与 requestErrorMessage 同域——超时包装与
 *  标记位路由的规则负责点集中在这里，client 与多流下载器共用。 */
export function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof SyntheticRequestTimeoutError;
}

/** Wrap an uncancellable request timeout into a typed NetworkError, carrying
 *  the deadline milliseconds in `OneDriveError.requestTimeoutMs` so downstream
 *  routing reads the marker instead of matching message text. */
export function rethrowUncancellableRequestTimeout(error: unknown): void {
  if (isRequestTimeoutError(error)) {
    const requestTimeoutMs = error instanceof SyntheticRequestTimeoutError
      ? error.timeoutMs
      : null;
    throw new OneDriveError(
      OneDriveErrorType.NetworkError,
      requestErrorMessage(error),
      0,
      null,
      null,
      null,
      requestTimeoutMs,
    );
  }
}

export function isUncancellableRequestTimeout(error: unknown): boolean {
  return error instanceof SyntheticRequestTimeoutError
    || (error instanceof OneDriveError && error.requestTimeoutMs !== null);
}

/** Throw when the signal is aborted. Without a message the caller gets the
 *  default `abortError()`; passing a message selects the DOMException shape
 *  used by the IndexedDB staging paths so their error text is preserved. */
export function throwIfAborted(
  signal: AbortSignal | null | undefined,
  message?: string,
): void {
  if (!signal?.aborted) return;
  throw message === undefined ? abortError() : new DOMException(message, "AbortError");
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
  const message = describeError(rawError);
  return message.replace(/https?:\/\/\S+/g, "[redacted-url]");
}
