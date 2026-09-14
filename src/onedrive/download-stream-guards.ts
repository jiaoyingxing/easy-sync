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
/** Slow-connection gate (user-decided 2026-09-14): streaming downloads that
 *  sustain less than this rate over the window are aborted so the waterfall
 *  retries on a fresh connection. The 512 KiB/s line is the measured split
 *  from the 2026-09-14 ten-connection sample (84 KiB/s – 1.3 MiB/s on one
 *  link, 7/10 below the line; earlier matrix samples ran to 3.2 MiB/s per
 *  connection); the window and reconnect cap are conservative candidates.
 *  After DOWNLOAD_SLOW_ABORT_LIMIT aborts the current connection is accepted
 *  — a genuinely slow link (2026-09-12: 95–108 KiB/s) must complete instead
 *  of looping. Reopen at a lower line if real links show legit rates being
 *  killed. */
export const DOWNLOAD_SLOW_RATE_BYTES_PER_SECOND = 512 * 1024;
export const DOWNLOAD_SLOW_RATE_WINDOW_MS = 15_000;
export const DOWNLOAD_SLOW_ABORT_LIMIT = 3;

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

export function createSlowConnectionGate(label: string): SlowConnectionGate {
  let windowStart: number | null = null;
  let windowBytes = 0;
  let aborts = 0;
  let accepted = false;
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
      if (rateBytesPerSecond >= DOWNLOAD_SLOW_RATE_BYTES_PER_SECOND) return;
      if (aborts >= DOWNLOAD_SLOW_ABORT_LIMIT) {
        accepted = true;
        return;
      }
      aborts++;
      throw Object.assign(
        new OneDriveError(
          OneDriveErrorType.NetworkError,
          `Download too slow — ${Math.round(rateBytesPerSecond / 1024)} KiB/s sustained ${Math.round(elapsedMs / 1000)}s (reconnect ${aborts}/${DOWNLOAD_SLOW_ABORT_LIMIT}): ${label}`,
        ),
        { stalled: true },
      );
    },
  };
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
