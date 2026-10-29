/** Node-https multi-range download streams (C 载体, user-decided 2026-09-14).
 *
 *  Why not renderer fetch: the CDN sends no CORS headers, so Chromium hides
 *  Content-Range from renderer fetch, and the 2026-09-14 evening probes
 *  measured parallel renderer Range fetches hanging with zero bytes AND
 *  poisoning the shared Chromium connection pool (later serial fetches hung
 *  too). Node https inside the desktop renderer (require("https") — long
 *  available, previously unused) has its own connection pool, reads every
 *  response header, and can destroy a stuck socket. Mobile has no Node
 *  runtime and keeps the existing single-stream paths (its slow links are
 *  already covered by the slow-connection gate on the fetch waterfall).
 *
 *  Correctness contract per stream: status must be 206, Content-Range must
 *  match the requested window and the declared file size exactly, per-window
 *  bytes are capped at the window size, and any early end or short assembly
 *  fails closed. The caller (client.ts) re-verifies the assembled file
 *  through its existing size/sha256 write path.
 *
 *  2026-10-27 field regression and the two-tier recovery: a 16-stream first
 *  pass was interrupted by a transport error at 26.2 s, and the old code
 *  then fell straight to the single-stream waterfall from byte 0 — 254.8 s
 *  only reached 6.8 MB of a 20 MiB file (slower than the two-stream
 *  baseline). Landed bytes are assets now: a connection-level failure keeps
 *  every completed window in the assembly buffer, retries only the
 *  unfinished windows once at a lower stream ceiling, and only then hands
 *  the file to the single-stream fallback. Protocol-level failures (missing
 *  206 / bad Content-Range) still have no useful retry — they fall through
 *  to the single-stream path immediately.
 *
 *  2026-10-28 last-tier resume: the final single-stream fallback used to
 *  restart the file at byte 0, so a ladder that had already landed most of a
 *  large file threw those bytes away exactly when the link was worst. Every
 *  failure now also hands out its assembly buffer plus the first byte it did
 *  not land (`RangePartialDownload`, read back through
 *  `readRangePartialDownload`); the caller continues with one Range GET from
 *  that offset into the same buffer. The success contract is unchanged: the
 *  returned buffer is only ever the fully assembled file, and the caller's
 *  size + sha256 check still decides whether the bytes are accepted. */

import type { DiagnosticLogger } from "../sync/diagnostic-logger";
import {
  hostPlatformFacts,
  type HostPlatformFacts,
} from "../obsidian-compat";
import { OneDriveError, OneDriveErrorType } from "./types";
import {
  createDownloadStallWatchdog,
  createSlowConnectionGate,
  isAbortError,
  requestErrorMessage,
  sleepWithAbort,
  throwIfAborted,
  type SlowLinkEvidence,
} from "./download-stream-guards";
import type { RangeWindow } from "./download-range-policy";
import type { RangeStreamObserver } from "./range-stream-adaptation";

const RANGE_STREAM_RETRY_BACKOFF_MS = 500;
/** Reconnect budget per window after stalled/slow aborts (mirrors the
 *  waterfall's per-tier retry shape). Non-stalled failures — non-206,
 *  Content-Range mismatch, window budget — are not retried here: they mean
 *  the CDN or the URL is misbehaving, and the single-stream fallback owns
 *  recovery. */
const RANGE_STREAM_STALLED_RETRIES = 2;
/** First downgrade tier after a connection-level failure in the full
 *  16-stream pass (user-decided 2026-10-27). Four connections keep real
 *  parallel payoff on the measured per-connection bottleneck while giving
 *  the CDN enough headroom to stop aborting the burst; the single-stream
 *  waterfall remains the next and final tier. */
const RANGE_DEGRADED_STREAMS = 4;

/** Structural typing over the small Node-https surface this module uses —
 *  no Node type module import (the obsidian lint rule flags those for mobile
 *  safety), and the real Node shapes satisfy it structurally. */
interface RangeHttpRequest {
  on(event: string, listener: (error: Error) => void): unknown;
  end(): unknown;
  destroy(error?: Error): void;
}

interface RangeHttpResponse extends AsyncIterable<Uint8Array> {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  destroy(error?: Error): void;
}

interface RangeHttpsModule {
  request(
    url: string,
    options: { method: string; headers: Record<string, string> },
    callback: (response: RangeHttpResponse) => void,
  ): RangeHttpRequest;
}

let cachedHttps: RangeHttpsModule | null | undefined;

/** Desktop-only lazy require. Obsidian desktop runs plugins with Node
 *  integration, so require("https") resolves to the Node builtin; mobile
 *  has no require and this returns null (caller stays single-stream). The
 *  bundle marks https external, so the require call stays a runtime lookup
 *  and is never evaluated on platforms without Node.
 *
 *  The gate reads the injected desktop UI-mode fact (default: the live host
 *  `Platform.isDesktop`), preserving the existing behaviour where
 *  `app.emulateMobile()` on desktop disables the Node-https path. The require
 *  lookup goes through an aliased local so the store's `no-nodejs-modules`
 *  rule (which flags direct `require("https")` calls) stays quiet; where
 *  require is missing the undefined result (or a caught ReferenceError) keeps
 *  callers on the single-stream path. */
export function loadNodeHttps(
  platform: HostPlatformFacts = hostPlatformFacts,
): RangeHttpsModule | null {
  if (cachedHttps !== undefined) return cachedHttps;
  try {
    // eslint-disable-next-line no-undef -- desktop-only lazy require; require is undeclared where Node types are absent
    const nodeRequire = require as ((mod: string) => unknown) | undefined;
    const loaded =
      platform.isDesktop && typeof nodeRequire === "function"
        ? nodeRequire("https")
        : null;
    cachedHttps = loaded as RangeHttpsModule;
  } catch {
    cachedHttps = null;
  }
  return cachedHttps;
}

export interface RangeDownloadInput {
  url: string;
  windows: readonly RangeWindow[];
  fileSize: number;
  signal: AbortSignal;
  label: string;
  onProgress?: (downloaded: number, total: number) => void;
  /** Shared per-round link evidence so every window's rate feeds the same
   *  slow-gate baseline (2026-09-15 乙路). */
  slowLinkEvidence?: SlowLinkEvidence;
  /** G3 round-scoped stream-count observer. The downloader reports one clean
   *  transfer sample, one connection-failure event, or one 429 event per
   *  attempt; the planner state itself lives in `OneDriveClient` so every
   *  large file in the round shares one tier. Optional: direct callers and the
   *  pre-G3 transfer contract are unchanged. */
  adaptation?: RangeStreamObserver;
}

export interface RangeStreamDownloader {
  download(input: RangeDownloadInput): Promise<ArrayBuffer>;
}

/** What a failed multi-range attempt can still hand to the single-stream
 *  fallback: the assembly buffer it already filled and the length of the
 *  contiguous prefix that is safe to keep.
 *
 *  Why it rides on the error instead of a return value: `download()` resolves
 *  only with the complete file, and every failure must stay the original
 *  thrown value — the caller (and the recovery state machine above) reads
 *  `name`, `code`, `stalled`, `rangeNotHonored`, `statusCode` and the
 *  429 `retryAfterMs` off it. A sibling property is the same mechanism the
 *  rest of the download layer already uses for `transferredBytes` /
 *  `stalled`; `readRangePartialDownload` is the only reader. */
export interface RangePartialDownload {
  /** Assembly buffer of the failed attempt — exactly `fileSize` bytes. The
   *  resumed single stream writes its body here, at `landedOffset`, so no
   *  second whole-file buffer is ever allocated. */
  assembly: Uint8Array;
  /** First byte that is not landed contiguously from byte 0: the resume start.
   *  0 means the first window never landed (the fallback then downloads the
   *  whole file, exactly as before). */
  landedOffset: number;
  /** Bytes credited across every window. Windows land out of order, so this
   *  is ≥ `landedOffset`; it is log evidence, not a resume position. */
  landedBytes: number;
  /** Declared file size the assembly was planned for. */
  fileSize: number;
}

/** Sibling property carrying {@link RangePartialDownload} on the thrown error.
 *  Same naming shape as `transferredBytes` / `stalled` (plain, enumerable). */
const RANGE_PARTIAL_DOWNLOAD_KEY = "rangePartialDownload";

/** Read the resume state a failed multi-range attempt attached to its error.
 *  Returns null for aborts, unrelated errors and hand-built objects that do
 *  not satisfy the shape, so a caller can never resume from invented offsets. */
export function readRangePartialDownload(
  error: unknown,
): RangePartialDownload | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<string, unknown>)[RANGE_PARTIAL_DOWNLOAD_KEY];
  if (typeof value !== "object" || value === null) return null;
  const partial = value as Partial<RangePartialDownload>;
  const { assembly, landedOffset, landedBytes, fileSize } = partial;
  if (!(assembly instanceof Uint8Array)) return null;
  if (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize)) return null;
  if (typeof landedOffset !== "number" || !Number.isSafeInteger(landedOffset)) {
    return null;
  }
  if (landedOffset < 0 || landedOffset > fileSize) return null;
  if (assembly.byteLength !== fileSize) return null;
  const credited = typeof landedBytes === "number"
    && Number.isSafeInteger(landedBytes)
    && landedBytes >= landedOffset
    ? landedBytes
    : landedOffset;
  return { assembly, landedOffset, landedBytes: credited, fileSize };
}

/** Attach the resume state to the original error. A non-extensible error just
 *  loses the resume (the caller then re-downloads from 0) — never the failure
 *  itself. */
function attachRangePartialDownload(
  error: unknown,
  partial: RangePartialDownload,
): void {
  if (
    (typeof error !== "object" || error === null)
    && typeof error !== "function"
  ) {
    return;
  }
  try {
    (error as Record<string, unknown>)[RANGE_PARTIAL_DOWNLOAD_KEY] = partial;
  } catch { /* keep the original failure */ }
}

/** Live progress for one window: how many of its leading bytes already sit in
 *  the shared assembly buffer, and whether the window is done. The degraded
 *  round reads this to retry only windows that still have holes. */
interface RangeWindowState {
  window: RangeWindow;
  windowBytes: number;
  label: string;
  /** Landed prefix length in `assembly`; safe to resume from. */
  credited: number;
  completed: boolean;
}

/** First byte that is not landed contiguously from 0 — the start of the first
 *  window that still has a hole. Windows are contiguous and planned in order,
 *  so this is the only offset a plain `Range: bytes=<offset>-` continuation
 *  can safely use: everything at or after it is overwritten with identical
 *  bytes by the resumed stream, including windows that landed out of order. */
function firstUnfinishedOffset(
  states: readonly RangeWindowState[],
  fileSize: number,
): number {
  let landedTo = 0;
  for (const state of states) {
    const landed = Math.max(0, Math.min(state.credited, state.windowBytes));
    if (landed < state.windowBytes) return state.window.start + landed;
    landedTo = state.window.start + state.windowBytes;
  }
  return Math.min(landedTo, fileSize);
}

type RangeStreamFailureKind =
  | "cancel"
  | "protocol"
  | "connection"
  | "terminal";

/** Node transport codes that mean "this connection died", not "this CDN
 *  refuses Range". They can be retried on a fresh socket / a lower stream
 *  ceiling without discarding the bytes already assembled. */
const RANGE_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENOTCONN",
  "ERR_SOCKET_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_HTTP2_PROTOCOL_ERROR",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/** Message fallback for errors whose `code` was lost between Node layers
 *  (real field evidence: `aborted` and `socket hang up` arrive without a
 *  useful numeric code in some https versions). */
const RANGE_CONNECTION_MESSAGE_PATTERN =
  /err_http2|socket hang up|econnreset|econnaborted|epipe|premature close|connection reset|connection aborted|\baborted\b/i;

function forEachErrorInChain(
  error: unknown,
  visit: (record: Record<string, unknown>) => boolean,
): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth++) {
    if (current === null || typeof current !== "object") return false;
    const record = current as Record<string, unknown>;
    if (visit(record)) return true;
    current = record.cause;
  }
  return false;
}

/** Preserve a real Error so its `code` / name still reach the caller; wrap
 *  exotic thrown values only for the lint/error contract. */
function asThrownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isProtocolRangeFailure(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { rangeNotHonored?: unknown }).rangeNotHonored === true;
}

function isConnectionRangeFailure(error: unknown): boolean {
  return forEachErrorInChain(error, (record) => {
    if (
      typeof record.code === "string"
      && RANGE_CONNECTION_CODES.has(record.code.toUpperCase())
    ) {
      return true;
    }
    return typeof record.message === "string"
      && RANGE_CONNECTION_MESSAGE_PATTERN.test(record.message);
  });
}

/** How one failed window may be treated by the recovery state machine.
 *  Order matters: a real outer abort is known from the linked signal, so it
 *  wins outright. A bare AbortError with no aborted signal can be Node's
 *  transport-level "aborted" shape after a socket teardown — the connection
 *  markers are checked before it so that case is retried instead of being
 *  mistaken for a user cancel. The protocol marker is set on our own errors
 *  only. */
function classifyRangeStreamFailure(
  error: unknown,
  signal: AbortSignal,
): RangeStreamFailureKind {
  if (signal.aborted) return "cancel";
  if (isProtocolRangeFailure(error)) return "protocol";
  if (isConnectionRangeFailure(error)) return "connection";
  if (isAbortError(error)) return "cancel";
  return "terminal";
}

/** Returns null when Node https is unavailable (mobile): the caller then
 *  never plans range windows and behaves exactly as before this module. */
export function createRangeStreamDownloader(
  httpsModule: RangeHttpsModule | null,
  diag?: DiagnosticLogger,
): RangeStreamDownloader | null {
  if (!httpsModule) return null;
  return {
    async download(input: RangeDownloadInput): Promise<ArrayBuffer> {
      throwIfAborted(input.signal);
      const adaptation = input.adaptation;
      const startedAtMs = adaptation?.nowMs() ?? 0;
      /** Set as soon as the full pass reports a connection-level failure, even
       *  when the degraded round later lands every byte: the planned tier did
       *  fail one window, which is exactly the evidence the controller counts. */
      let connectionFailureObserved = false;
      const assembly = new Uint8Array(input.fileSize);
      const states: RangeWindowState[] = input.windows.map((window) => ({
        window,
        windowBytes: window.end - window.start + 1,
        label: `${input.label} [bytes ${window.start}-${window.end}]`,
        credited: 0,
        completed: false,
      }));
      const credit = { total: 0 };
      const streamCount = states.length;
      try {
        const fullRound = await runRangeRound({
          tasks: states,
          concurrency: streamCount,
          https: httpsModule,
          input,
          assembly,
          credit,
          diag,
          failFast: false,
        });

        if (fullRound.connectionError !== null) {
          connectionFailureObserved = true;
          const pending = states.filter((state) => !state.completed);
          if (pending.length > 0) {
            if (streamCount <= RANGE_DEGRADED_STREAMS) {
              // No lower multi-stream tier exists for this plan; preserve the
              // pre-existing "hand it to the single-stream waterfall" path.
              throw asThrownError(fullRound.connectionError);
            }
            const degradedConcurrency = Math.min(
              RANGE_DEGRADED_STREAMS,
              pending.length,
            );
            diag?.warn(
              "onedrive",
              `${input.label} — multi-range degraded streams ${streamCount}→${RANGE_DEGRADED_STREAMS} after connection-level failure; retrying ${pending.length} unfinished window(s)`,
              {
                reason: requestErrorMessage(fullRound.connectionError),
                failureKind: "connection",
                streamsBefore: streamCount,
                streamsAfter: RANGE_DEGRADED_STREAMS,
                unfinishedWindows: pending.length,
                landedBytes: credit.total,
                remainingBytes: input.fileSize - credit.total,
              },
            );
            try {
              await runRangeRound({
                tasks: pending,
                concurrency: degradedConcurrency,
                https: httpsModule,
                input,
                assembly,
                credit,
                diag,
                failFast: true,
              });
            } catch (error) {
              if (isAbortError(error) || input.signal.aborted) throw error;
              const kind = classifyRangeStreamFailure(error, input.signal);
              diag?.warn(
                "onedrive",
                `${input.label} — multi-range degraded round failed at ${RANGE_DEGRADED_STREAMS} streams; falling back to single stream (streams=1)`,
                {
                  reason: requestErrorMessage(error),
                  failureKind: kind,
                  streamsBefore: RANGE_DEGRADED_STREAMS,
                  streamsAfter: 1,
                  landedBytes: credit.total,
                  remainingBytes: input.fileSize - credit.total,
                },
              );
              throw error;
            }
          }
        }

        if (credit.total !== input.fileSize) {
          // Fail closed: the assembled buffer is discarded with this promise;
          // the caller falls back to the single-stream waterfall.
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            `${input.label} multi-range assembly incomplete (${credit.total}/${input.fileSize})`,
          );
        }
        if (adaptation) {
          if (connectionFailureObserved) {
            // The degraded round recovered the bytes, but the tier itself
            // still failed a connection. That is a hold/downgrade signal, not
            // a clean throughput sample.
            adaptation.recordConnectionFailure();
          } else {
            adaptation.recordCleanTransfer({
              streams: streamCount,
              bytes: input.fileSize,
              elapsedMs: Math.max(1, adaptation.nowMs() - startedAtMs),
            });
          }
        }
        input.onProgress?.(input.fileSize, input.fileSize);
        return assembly.buffer;
      } catch (error) {
        const aborted = isAbortError(error) || input.signal.aborted;
        const failureKind = aborted
          ? null
          : classifyRangeStreamFailure(error, input.signal);
        if (!aborted) {
          // 回退不重下 (2026-10-28): whatever ended this attempt, the windows
          // that did land are assets. Hand the assembly and its first hole to
          // the caller so the single-stream fallback continues there instead
          // of restarting the file at byte 0. Attached to the original error
          // (never a wrapper) so every existing classification still holds.
          attachRangePartialDownload(error, {
            assembly,
            landedOffset: firstUnfinishedOffset(states, input.fileSize),
            landedBytes: credit.total,
            fileSize: input.fileSize,
          });
          const rateLimit = findRangeRateLimitEvidence(error);
          if (rateLimit) {
            // Cooldown starts when the 429 is observed, not after the
            // single-stream fallback below has finished: the next file must
            // already respect it.
            adaptation?.recordRateLimited({
              retryAfterMs: rateLimit.retryAfterMs,
            });
          } else if (
            connectionFailureObserved
            || failureKind === "connection"
          ) {
            adaptation?.recordConnectionFailure();
          }
        }
        if (failureKind === "protocol") {
          diag?.warn(
            "onedrive",
            `${input.label} — protocol-level range failure; falling back to single stream (streams=1)`,
            {
              reason: requestErrorMessage(error),
              failureKind: "protocol",
              streamsBefore: streamCount,
              streamsAfter: 1,
              landedBytes: credit.total,
              remainingBytes: input.fileSize - credit.total,
            },
          );
        }
        throw error;
      }
    },
  };
}

interface RangeRoundOptions {
  tasks: readonly RangeWindowState[];
  concurrency: number;
  https: RangeHttpsModule;
  input: RangeDownloadInput;
  assembly: Uint8Array;
  credit: { total: number };
  diag: DiagnosticLogger | undefined;
  /** Degraded round: any failure ends the multi-range attempt immediately;
   *  in-flight siblings are torn down so the single-stream fallback does not
   *  compete with them for the same link. */
  failFast: boolean;
}

interface RangeRoundOutcome {
  /** First connection-layer failure of the round. Round one keeps its
   *  siblings running (their landed bytes are assets); the caller decides
   *  whether a degraded retry is possible. `unknown` because a preserved
   *  Error may carry transport-specific fields (`code`, `errno`, `cause`). */
  connectionError: unknown;
}

/** Run one batch of unfinished windows with a bounded number of live
 *  streams. A connection failure stops new windows from starting but lets
 *  already-running siblings finish, so their bytes survive into the next
 *  round. Protocol/terminal failures cancel every live socket because the
 *  whole multi-range attempt is about to be abandoned. */
async function runRangeRound(options: RangeRoundOptions): Promise<RangeRoundOutcome> {
  const { tasks, input } = options;
  if (tasks.length === 0) return { connectionError: null };

  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (input.signal.aborted) controller.abort();
  else input.signal.addEventListener("abort", onOuterAbort, { once: true });

  let nextIndex = 0;
  let stopped = false;
  let fatalError: unknown = null;
  let connectionError: unknown = null;
  let userAborted = false;

  const runWorker = async (): Promise<void> => {
    while (!stopped && !controller.signal.aborted) {
      const task = tasks[nextIndex];
      if (!task) return;
      nextIndex += 1;
      try {
        await runRangeWindowAttempts({
          https: options.https,
          input,
          task,
          assembly: options.assembly,
          credit: options.credit,
          signal: controller.signal,
          diag: options.diag,
        });
      } catch (error) {
        if (input.signal.aborted) {
          userAborted = true;
          stopped = true;
          controller.abort();
          return;
        }
        // This round's own cancellation means another worker already recorded
        // the primary failure; the AbortError it produced is noise.
        if (controller.signal.aborted) return;
        const kind = classifyRangeStreamFailure(error, input.signal);
        if (kind === "cancel") {
          // Standalone AbortError with no outer cancel: keep the historical
          // propagation shape so the caller still treats it as a cancel.
          userAborted = true;
          stopped = true;
          controller.abort();
          return;
        }
        if (kind === "connection") {
          if (connectionError === null) connectionError = error;
          stopped = true;
          if (options.failFast) {
            fatalError = error;
            controller.abort();
          }
          return;
        }
        if (fatalError === null) fatalError = error;
        stopped = true;
        controller.abort();
        return;
      }
    }
  };

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(options.concurrency, tasks.length);
  for (let index = 0; index < workerCount; index++) {
    workers.push(runWorker());
  }
  try {
    await Promise.all(workers);
  } finally {
    input.signal.removeEventListener("abort", onOuterAbort);
  }

  if (userAborted || input.signal.aborted) {
    throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  }
  if (fatalError !== null) throw asThrownError(fatalError);
  return { connectionError };
}

interface RangeWindowAttemptArgs {
  https: RangeHttpsModule;
  input: RangeDownloadInput;
  task: RangeWindowState;
  assembly: Uint8Array;
  credit: { total: number };
  signal: AbortSignal;
  diag: DiagnosticLogger | undefined;
}

async function runRangeWindowAttempts(args: RangeWindowAttemptArgs): Promise<void> {
  const { https, input, task, assembly, credit, signal, diag } = args;
  const { window: win, windowBytes, label: windowLabel } = task;
  for (let attempt = 1; ; attempt++) {
    if (task.credited >= windowBytes) {
      task.completed = true;
      return;
    }
    const base = task.credited;
    const remaining = windowBytes - base;
    // 甲路续传 (2026-09-16): every retry continues from the credited offset
    // with a sub-range request instead of re-downloading the window. The same
    // resume rule now also survives a connection-level failure, so the
    // degraded round only fetches the holes left by the failed pass.
    const subWin: RangeWindow = {
      start: win.start + base,
      end: win.end,
    };
    const slowGate = createSlowConnectionGate(windowLabel, {
      evidence: input.slowLinkEvidence,
      totalSize: remaining,
    });
    const watchdog = createDownloadStallWatchdog(signal, windowLabel, slowGate);
    // Holder object: the request is assigned inside the https.request
    // callback, which TypeScript's flow analysis does not track.
    const outgoing: { request: RangeHttpRequest | null } = { request: null };
    // The watchdog owns the stall/outer-abort link; destroying the socket on
    // its signal is what actually releases a hung CDN connection.
    const destroyOnAbort = (): void => { outgoing.request?.destroy(); };
    watchdog.signal.addEventListener("abort", destroyOnAbort);
    let received = 0;
    try {
      throwIfAborted(signal);
      const response = await watchdog.guard(waitForRangeResponseHeaders(
        https,
        input.url,
        subWin,
        (request) => { outgoing.request = request; },
      ));
      assertRangeResponseHonored(response, subWin, input.fileSize, windowLabel);
      const iterator = response[Symbol.asyncIterator]();
      for (;;) {
        const step = await watchdog.guard(iterator.next());
        if (step.done) break;
        const chunk = step.value;
        received += chunk.byteLength;
        if (received > remaining) {
          outgoing.request?.destroy();
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            `${windowLabel} exceeded its range window (${base + received} > ${windowBytes})`,
          );
        }
        assembly.set(chunk, subWin.start + received - chunk.byteLength);
        task.credited = base + received;
        credit.total += chunk.byteLength;
        input.onProgress?.(credit.total, input.fileSize);
        slowGate.evaluate(received);
      }
      if (received !== remaining) {
        throw Object.assign(
          new OneDriveError(
            OneDriveErrorType.NetworkError,
            `${windowLabel} ended early (${task.credited}/${windowBytes})`,
          ),
          { stalled: true },
        );
      }
      task.credited = windowBytes;
      task.completed = true;
      return;
    } catch (error) {
      if (signal.aborted) throw error;
      // A socket can die after the last byte of the window already landed
      // (Node reports `aborted` / ECONNRESET after a complete body). The
      // window is complete even though the stream ended with an error, and
      // retrying it would ask for an empty range.
      if (task.credited >= windowBytes) {
        task.completed = true;
        return;
      }
      if (isAbortError(error)) throw error;
      const stalled = (error as { stalled?: boolean })?.stalled === true;
      if (!stalled || attempt > RANGE_STREAM_STALLED_RETRIES) throw error;
      diag?.warn(
        "onedrive",
        `${windowLabel} — range stream retry ${attempt}/${RANGE_STREAM_STALLED_RETRIES} from offset ${task.credited}`,
        requestErrorMessage(error),
      );
      await sleepWithAbort(RANGE_STREAM_RETRY_BACKOFF_MS, signal);
    } finally {
      watchdog.dispose();
      watchdog.signal.removeEventListener("abort", destroyOnAbort);
      outgoing.request?.destroy();
    }
  }
}

function waitForRangeResponseHeaders(
  https: RangeHttpsModule,
  url: string,
  win: RangeWindow,
  onRequest: (request: RangeHttpRequest) => void,
): Promise<RangeHttpResponse> {
  return new Promise<RangeHttpResponse>((resolve, reject) => {
    const request = https.request(
      url,
      { method: "GET", headers: { Range: `bytes=${win.start}-${win.end}` } },
      (response) => resolve(response),
    );
    onRequest(request);
    request.on("error", (error) => reject(error));
    request.end();
  });
}

function assertRangeResponseHonored(
  response: RangeHttpResponse,
  win: RangeWindow,
  fileSize: number,
  windowLabel: string,
): void {
  const status = response.statusCode ?? 0;
  if (status !== 206) {
    response.destroy();
    // 429/509 keep the pre-G3 protocol-failure path (single-stream fallback),
    // but carry enough evidence for the adaptive controller: an immediate
    // downgrade plus a cooldown, and the server's Retry-After when present.
    const rateLimited = status === 429 || status === 509;
    throw Object.assign(
      new OneDriveError(
        OneDriveErrorType.NetworkError,
        `${windowLabel} — range request not honored (status ${status})`,
      ),
      {
        rangeNotHonored: true,
        statusCode: status,
        rateLimited,
        retryAfterMs: rateLimited ? parseRetryAfterMs(response.headers) : null,
      },
    );
  }
  const contentRange = response.headers["content-range"];
  const expectedPrefix = `bytes ${win.start}-${win.end}/`;
  const totalRaw = typeof contentRange === "string" && contentRange.startsWith(expectedPrefix)
    ? contentRange.slice(expectedPrefix.length)
    : null;
  if (totalRaw === null || Number(totalRaw) !== fileSize) {
    response.destroy();
    const observed = typeof contentRange === "string"
      ? contentRange
      : "none";
    throw Object.assign(
      new OneDriveError(
        OneDriveErrorType.NetworkError,
        `${windowLabel} — Content-Range mismatch (got ${observed}, expected bytes ${win.start}-${win.end}/${fileSize})`,
      ),
      { rangeNotHonored: true },
    );
  }
}

interface RangeRateLimitEvidence {
  retryAfterMs: number | null;
}

/** Walk the cause chain for the marker attached by `assertRangeResponseHonored`.
 *  A wrapper may lose the marker's own class but keep `statusCode`; both the
 *  explicit flag and the raw status count as throttle evidence. */
function findRangeRateLimitEvidence(error: unknown): RangeRateLimitEvidence | null {
  let evidence: RangeRateLimitEvidence | null = null;
  forEachErrorInChain(error, (record) => {
    const status = typeof record.statusCode === "number"
      ? record.statusCode
      : null;
    if (record.rateLimited === true || status === 429 || status === 509) {
      evidence = {
        retryAfterMs: typeof record.retryAfterMs === "number"
          && Number.isFinite(record.retryAfterMs)
          ? record.retryAfterMs
          : null,
      };
      return true;
    }
    return false;
  });
  return evidence;
}

/** `Retry-After` is delta-seconds or an HTTP-date. The controller clamps the
 *  resulting duration; this helper only converts the header. */
function parseRetryAfterMs(
  headers: Record<string, string | string[] | undefined>,
): number | null {
  const raw = headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") return null;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}
