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
 *  through its existing size/sha256 write path, and falls back to the proven
 *  single-stream waterfall on any multi-range failure except user cancel. */

import type { DiagnosticLogger } from "../sync/diagnostic-logger";
import { OneDriveError, OneDriveErrorType } from "./types";
import {
  createDownloadStallWatchdog,
  createSlowConnectionGate,
  isAbortError,
  requestErrorMessage,
  sleepWithAbort,
  throwIfAborted,
} from "./download-stream-guards";
import type { RangeWindow } from "./download-range-policy";

const RANGE_STREAM_RETRY_BACKOFF_MS = 500;
/** Reconnect budget per window after stalled/slow aborts (mirrors the
 *  waterfall's per-tier retry shape). Non-stalled failures — non-206,
 *  Content-Range mismatch, window budget — are not retried here: they mean
 *  the CDN or the URL is misbehaving, and the single-stream fallback owns
 *  recovery. */
const RANGE_STREAM_STALLED_RETRIES = 2;

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

export interface RangeHttpsModule {
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
 *  and is never evaluated on platforms without Node. */
export function loadNodeHttps(): RangeHttpsModule | null {
  if (cachedHttps !== undefined) return cachedHttps;
  try {
    // Desktop-only by the typeof guard: require does not exist on mobile, and
    // the bundle marks https external so this stays a runtime lookup. The
    // obsidian lint rule (no-nodejs-modules) explicitly endorses a guarded
    // require for desktop; its warning is carried on the line below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, no-undef -- desktop-only lazy require; require is not defined on mobile
    const loaded = typeof require === "function" ? require("https") : null;
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
}

export interface RangeStreamDownloader {
  download(input: RangeDownloadInput): Promise<ArrayBuffer>;
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
      const assembly = new Uint8Array(input.fileSize);
      const credit = { total: 0 };
      // Slot per window, refreshed on every attempt. The first non-cancel
      // stream failure tears down the sibling sockets: otherwise a dying
      // range connection keeps pulling its window while the single-stream
      // fallback competes with it for the same link (and 429 windows would
      // briefly hold an extra connection against the throttling guidance).
      const destroySockets: Array<() => void> = [];
      const cancelSiblings = (): void => {
        for (const destroy of destroySockets) destroy();
      };
      try {
        await Promise.all(input.windows.map((win, index) => runRangeWindowStream(
          httpsModule,
          input,
          win,
          index,
          destroySockets,
          assembly,
          credit,
          diag,
        )));
      } catch (error) {
        cancelSiblings();
        throw error;
      }
      if (credit.total !== input.fileSize) {
        // Fail closed: the assembled buffer is discarded with this promise;
        // the caller falls back to the single-stream waterfall.
        throw new OneDriveError(
          OneDriveErrorType.NetworkError,
          `${input.label} multi-range assembly incomplete (${credit.total}/${input.fileSize})`,
        );
      }
      input.onProgress?.(input.fileSize, input.fileSize);
      return assembly.buffer;
    },
  };
}

async function runRangeWindowStream(
  https: RangeHttpsModule,
  input: RangeDownloadInput,
  win: RangeWindow,
  slotIndex: number,
  destroySockets: Array<() => void>,
  assembly: Uint8Array,
  credit: { total: number },
  diag?: DiagnosticLogger,
): Promise<void> {
  const windowLabel = `${input.label} [bytes ${win.start}-${win.end}]`;
  const windowBytes = win.end - win.start + 1;
  let credited = 0;
  const creditTo = (target: number): void => {
    credit.total += target - credited;
    credited = target;
  };
  for (let attempt = 1; ; attempt++) {
    const slowGate = createSlowConnectionGate(windowLabel);
    const watchdog = createDownloadStallWatchdog(input.signal, windowLabel, slowGate);
    // Holder object: the request is assigned inside the https.request
    // callback, which TypeScript's flow analysis does not track.
    const outgoing: { request: RangeHttpRequest | null } = { request: null };
    // Register this attempt's socket under the window's slot so a sibling
    // failure (or the final rejection) can tear it down.
    destroySockets[slotIndex] = (): void => { outgoing.request?.destroy(); };
    // The watchdog owns the stall/outer-abort link; destroying the socket on
    // its signal is what actually releases a hung CDN connection.
    const destroyOnAbort = (): void => { outgoing.request?.destroy(); };
    watchdog.signal.addEventListener("abort", destroyOnAbort);
    let received = 0;
    try {
      throwIfAborted(input.signal);
      const response = await watchdog.guard(waitForRangeResponseHeaders(
        https,
        input.url,
        win,
        (request) => { outgoing.request = request; },
      ));
      assertRangeResponseHonored(response, win, input.fileSize, windowLabel);
      const iterator = response[Symbol.asyncIterator]();
      for (;;) {
        const step = await watchdog.guard(iterator.next());
        if (step.done) break;
        const chunk = step.value;
        received += chunk.byteLength;
        if (received > windowBytes) {
          outgoing.request?.destroy();
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            `${windowLabel} exceeded its range window (${received} > ${windowBytes})`,
          );
        }
        assembly.set(chunk, win.start + received - chunk.byteLength);
        creditTo(received);
        input.onProgress?.(credit.total, input.fileSize);
        slowGate.evaluate(received);
      }
      if (received !== windowBytes) {
        throw Object.assign(
          new OneDriveError(
            OneDriveErrorType.NetworkError,
            `${windowLabel} ended early (${received}/${windowBytes})`,
          ),
          { stalled: true },
        );
      }
      creditTo(windowBytes);
      return;
    } catch (error) {
      if (isAbortError(error) || input.signal.aborted) throw error;
      const stalled = (error as { stalled?: boolean })?.stalled === true;
      if (!stalled || attempt > RANGE_STREAM_STALLED_RETRIES) throw error;
      creditTo(0);
      diag?.warn(
        "onedrive",
        `${windowLabel} — range stream retry ${attempt}/${RANGE_STREAM_STALLED_RETRIES}`,
        requestErrorMessage(error),
      );
      await sleepWithAbort(RANGE_STREAM_RETRY_BACKOFF_MS, input.signal);
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
    throw Object.assign(
      new OneDriveError(
        OneDriveErrorType.NetworkError,
        `${windowLabel} — range request not honored (status ${status})`,
      ),
      { rangeNotHonored: true },
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
