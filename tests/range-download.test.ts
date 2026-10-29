import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRangeStreamDownloader,
  loadNodeHttps,
  readRangePartialDownload,
} from "../src/onedrive/range-download";
import type { RangeDownloadInput } from "../src/onedrive/range-download";
import {
  planRangeDownloadWindows,
  type RangeWindow,
} from "../src/onedrive/download-range-policy";
import type {
  RangeStreamObserver,
  RangeStreamTransferSample,
} from "../src/onedrive/range-stream-adaptation";
import { sha256Hex } from "../src/crypto";

/** Minimal Node-https fake: responses are served in request order, each with
 *  a controllable status, Content-Range header, chunk list, optional per-chunk
 *  timer delays, an optional hang after the chunks (stall), and a destroy()
 *  that rejects any pending body read (what a real socket teardown does).
 *  Retries continue from the credited offset with a sub-range request, so a
 *  retry spec must serve the REMAINING bytes with the sub-window's
 *  Content-Range. */

interface FakeResponseSpec {
  statusCode?: number;
  contentRange?: string | null;
  chunks: Uint8Array[];
  /** ms to wait (fake timer) before yielding each chunk. */
  delays?: number[];
  /** Keep the body open after the chunks: the next read never settles. */
  hangNext?: boolean;
}

function abortLike(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function buildFakeResponse(spec: FakeResponseSpec) {
  const state = {
    destroyed: false,
    rejectPending: null as ((error: Error) => void) | null,
  };
  let index = 0;
  const node = {
    statusCode: spec.statusCode ?? 206,
    headers: {
      "content-range": spec.contentRange === undefined
        ? null
        : spec.contentRange,
    },
    destroy: vi.fn(() => {
      state.destroyed = true;
      state.rejectPending?.(abortLike());
    }),
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (state.destroyed) return Promise.reject(abortLike());
        if (index < spec.chunks.length) {
          const chunk = spec.chunks[index];
          const delay = spec.delays?.[index] ?? 0;
          index++;
          if (delay > 0) {
            return new Promise<IteratorResult<Uint8Array>>((resolve) => {
              setTimeout(() => resolve({ value: chunk, done: false }), delay);
            });
          }
          return Promise.resolve({ value: chunk, done: false });
        }
        if (spec.hangNext) {
          return new Promise<IteratorResult<Uint8Array>>((_, reject) => {
            state.rejectPending = reject;
          });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };
  return { node };
}

function makeFakeHttps(specs: FakeResponseSpec[]) {
  let served = 0;
  const destroyFns: Array<ReturnType<typeof vi.fn>> = [];
  const https = {
    request: vi.fn(
      (_url: string, _options: unknown, callback: (response: unknown) => void) => {
        const spec = specs[Math.min(served, specs.length - 1)];
        served++;
        const { node } = buildFakeResponse(spec);
        destroyFns.push(node.destroy);
        const request = {
          on: vi.fn(),
          end: vi.fn(),
          destroy: node.destroy,
        };
        queueMicrotask(() => callback(node));
        return request;
      },
    ),
  };
  return { https, requestCount: () => served, destroyFns };
}

function makeInput(
  overrides: Partial<RangeDownloadInput> = {},
): RangeDownloadInput {
  return {
    url: "https://cdn.example/file",
    windows: [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ] satisfies RangeWindow[],
    fileSize: 8,
    signal: new AbortController().signal,
    label: 'Remote file "probe.bin"',
    ...overrides,
  };
}

describe("range stream downloader (C Node h1 载体)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null without a Node https module", () => {
    expect(createRangeStreamDownloader(null)).toBeNull();
  });

  it("assembles windows into one buffer regardless of completion order", async () => {
    const { https } = makeFakeHttps([
      // window A: first half in two chunks
      { chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])], contentRange: "bytes 0-3/8" },
      // window B: second half in two chunks
      { chunks: [new Uint8Array([5, 6]), new Uint8Array([7, 8])], contentRange: "bytes 4-7/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;
    const progress: Array<[number, number]> = [];

    const buffer = await downloader.download(makeInput({
      onProgress: (downloaded, total) => progress.push([downloaded, total]),
    }));

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(buffer.byteLength).toBe(8);
    expect(progress[progress.length - 1]).toEqual([8, 8]);
  });

  it("assembles a planned start-tier (8-window) 20 MiB file into the exact source bytes", async () => {
    const fileSize = 20 * 1024 * 1024;
    const source = new Uint8Array(fileSize);
    // Deterministic, non-uniform content: a shifted window changes the hash.
    for (let index = 0; index < fileSize; index++) {
      source[index] = (index * 31 + 7) & 0xff;
    }
    const windows = planRangeDownloadWindows(fileSize)!;
    expect(windows).toHaveLength(8);
    const https = {
      request: vi.fn(
        (
          _url: string,
          options: { headers: { Range: string } },
          callback: (response: unknown) => void,
        ) => {
          const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)!;
          const start = Number(match[1]);
          const end = Number(match[2]);
          const body = source.subarray(start, end + 1);
          let sent = false;
          const node = {
            statusCode: 206,
            headers: { "content-range": `bytes ${start}-${end}/${fileSize}` },
            destroy: vi.fn(),
            [Symbol.asyncIterator]: () => ({
              next: () => {
                if (sent) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                sent = true;
                return Promise.resolve({ value: body, done: false });
              },
              return: () => Promise.resolve({ value: undefined, done: true }),
            }),
          };
          const request = { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
          queueMicrotask(() => callback(node));
          return request;
        },
      ),
    };
    const downloader = createRangeStreamDownloader(https as never)!;

    const buffer = await downloader.download(makeInput({ windows, fileSize }));

    // Size and content hash are the caller's verification inputs, so they must
    // survive the stream-count change untouched.
    expect(buffer.byteLength).toBe(fileSize);
    expect(await sha256Hex(buffer)).toBe(await sha256Hex(source.buffer));
    const assembled = new Uint8Array(buffer);
    for (const window of windows) {
      expect(assembled[window.start]).toBe(source[window.start]);
      expect(assembled[window.end]).toBe(source[window.end]);
    }
    expect(https.request).toHaveBeenCalledTimes(8);
  });

  it("rejects immediately when the CDN does not honor the range (status 200)", async () => {
    const { https, requestCount, destroyFns } = makeFakeHttps([
      { statusCode: 200, chunks: [], contentRange: null },
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    await expect(downloader.download(makeInput())).rejects.toThrow(
      /range request not honored \(status 200\)/,
    );
    // window B still ran to completion; neither window retried
    expect(requestCount()).toBe(2);
  });

  it("cancels the sibling stream when one window fails permanently", async () => {
    const { https, destroyFns } = makeFakeHttps([
      // window A: hard failure (200) — no retry, whole attempt falls back
      { statusCode: 200, chunks: [], contentRange: null },
      // window B: healthy headers but the body hangs after one chunk —
      // without sibling cancellation its socket would stay open until the
      // 60 s watchdog, competing with the fallback single-stream download
      { chunks: [new Uint8Array([5])], contentRange: "bytes 4-7/8", hangNext: true },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    await expect(downloader.download(makeInput())).rejects.toThrow(
      /range request not honored/,
    );
    // window B's socket was destroyed by the sibling cancellation, not left
    // hanging for the watchdog
    expect(destroyFns[1]).toHaveBeenCalled();
  });

  it("rejects when Content-Range does not match the requested window", async () => {
    const { https, requestCount } = makeFakeHttps([
      { chunks: [], contentRange: "bytes 1-3/8" },
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    await expect(downloader.download(makeInput())).rejects.toThrow(
      /Content-Range mismatch/,
    );
    expect(requestCount()).toBe(2);
  });

  it("rejects when Content-Range declares a different file size", async () => {
    const { https } = makeFakeHttps([
      { chunks: [], contentRange: "bytes 0-3/9" },
      { chunks: [], contentRange: "bytes 4-7/9" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    await expect(downloader.download(makeInput())).rejects.toThrow(
      /Content-Range mismatch/,
    );
  });

  it("fails closed after repeated early-ending streams", async () => {
    const { https, requestCount } = makeFakeHttps([
      // window A attempts 1-3: each delivers 1 byte from its sub-range
      // (offsets 0/1/2) then ends early
      { chunks: [new Uint8Array([1])], contentRange: "bytes 0-3/8" },
      // window B completes on its single attempt
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
      { chunks: [new Uint8Array([2])], contentRange: "bytes 1-3/8" },
      { chunks: [new Uint8Array([3])], contentRange: "bytes 2-3/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    const pending = downloader.download(makeInput());
    // Attach the rejection handler before advancing: the window exhausts its
    // reconnect budget during the timer advance, and Node flags a rejection
    // with no handler as unhandled if we attach only afterwards.
    const assertion = expect(pending).rejects.toThrow(/ended early/);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    // A retried to its cap (3) plus B's single attempt
    expect(requestCount()).toBe(4);
  });

  it("retries a stalled stream from the credited offset with a sub-range", async () => {
    const { https, requestCount } = makeFakeHttps([
      // window A attempt 1: one chunk then the connection hangs
      { chunks: [new Uint8Array([1, 2])], contentRange: "bytes 0-3/8", hangNext: true },
      // window B attempt 1: completes normally
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
      // window A attempt 2: continues from the credited offset (bytes 2-3),
      // delivering only the remaining bytes
      { chunks: [new Uint8Array([3, 4])], contentRange: "bytes 2-3/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    const pending = downloader.download(makeInput());
    await vi.advanceTimersByTimeAsync(61_000);
    const buffer = await pending;

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(requestCount()).toBe(3);
    // The retry request carries the sub-range, not the whole window again.
    const retryOptions = https.request.mock.calls[2][1] as {
      headers: { Range: string };
    };
    expect(retryOptions.headers.Range).toBe("bytes=2-3");
  });

  it("reconnects when the sustained rate is below the slow-connection line", async () => {
    const { https, requestCount } = makeFakeHttps([
      // window A attempt 1: trickles 2 bytes across a 15s+ window — the gate
      // aborts on the second chunk's evaluation
      {
        chunks: [new Uint8Array([1]), new Uint8Array([2])],
        contentRange: "bytes 0-3/8",
        delays: [0, 16_000],
      },
      // window B completes
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
      // window A attempt 2: healthy sub-range continuing from the credited
      // offset (bytes 2-3)
      { chunks: [new Uint8Array([3]), new Uint8Array([4])], contentRange: "bytes 2-3/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    const pending = downloader.download(makeInput());
    await vi.advanceTimersByTimeAsync(17_000);
    const buffer = await pending;

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(requestCount()).toBe(3);
  });

  it("propagates user cancellation without a fallback retry", async () => {
    const controller = new AbortController();
    const { https, requestCount } = makeFakeHttps([
      { chunks: [new Uint8Array([1, 2])], contentRange: "bytes 0-3/8", hangNext: true },
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    const pending = downloader.download(makeInput({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // window A used exactly one request: user cancel never reconnects
    expect(requestCount()).toBe(2);
  });

  it("lazily loads the Node https module (desktop) or null (no require)", () => {
    // In the vitest node environment require exists, so the module resolves.
    const loaded = loadNodeHttps();
    if (typeof require === "function") {
      expect(loaded).not.toBeNull();
    } else {
      expect(loaded).toBeNull();
    }
  });
});

describe("range stream recovery after a failed multi-stream pass (2026-10-27 G1)", () => {
  const WINDOW_BYTES = 64 * 1024;
  const WINDOW_COUNT = 16;

  interface RangeServerRequest {
    start: number;
    end: number;
    attempt: number;
    windowIndex: number;
  }

  type RangeServerFault =
    | "connection"
    | "http2"
    | "connection-after-body"
    /** Socket dies before the first body byte: the window keeps whatever a
     *  previous attempt had already landed (zero on its first attempt). */
    | "connection-before-body"
    | "protocol"
    | null;

  function patternedSource(fileSize: number): Uint8Array {
    const source = new Uint8Array(fileSize);
    for (let index = 0; index < fileSize; index++) {
      source[index] = (index * 31 + 7) & 0xff;
    }
    return source;
  }

  function windowsFor(fileSize: number): RangeWindow[] {
    return Array.from({ length: WINDOW_COUNT }, (_, index) => ({
      start: index * WINDOW_BYTES,
      end: index === WINDOW_COUNT - 1
        ? fileSize - 1
        : (index + 1) * WINDOW_BYTES - 1,
    }));
  }

  /** Per-window fake CDN: normal responses serve the requested sub-range in
   *  one chunk; a connection fault serves half of it and then rejects with a
   *  transport error (the 2026-10-27 `aborted` shape); a protocol fault
   *  answers 200 so the 206 check trips. Request/byte accounting is kept so
   *  the tests can assert which windows were re-fetched. */
  function makeRangeServer(
    source: Uint8Array,
    fault: (request: RangeServerRequest) => RangeServerFault = () => null,
  ) {
    const attempts = new Array<number>(WINDOW_COUNT).fill(0);
    const requests: RangeServerRequest[] = [];
    const requestedBytes: Array<{ attempt: number; bytes: number }> = [];
    let refetchActive = 0;
    let maxRefetchActive = 0;

    const https = {
      request: vi.fn(
        (
          _url: string,
          options: { headers: { Range: string } },
          callback: (response: unknown) => void,
        ) => {
          const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)!;
          const start = Number(match[1]);
          const end = Number(match[2]);
          const windowIndex = Math.floor(start / WINDOW_BYTES);
          attempts[windowIndex] += 1;
          const attempt = attempts[windowIndex];
          const record: RangeServerRequest = { start, end, attempt, windowIndex };
          requests.push(record);
          requestedBytes.push({ attempt, bytes: end - start + 1 });

          if (attempt > 1) {
            refetchActive += 1;
            maxRefetchActive = Math.max(maxRefetchActive, refetchActive);
          }
          let settled = false;
          const settle = (): void => {
            if (settled) return;
            settled = true;
            if (attempt > 1) refetchActive -= 1;
          };

          const mode = fault(record);
          const rejectBeforeBody = mode === "connection-before-body";
          const connectionFault = mode === "connection"
            || mode === "http2"
            || mode === "connection-after-body"
            || rejectBeforeBody;
          const body = source.subarray(start, end + 1);
          const firstChunk = mode === "connection" || mode === "http2"
            ? body.subarray(0, Math.ceil(body.byteLength / 2))
            : body;
          const transportError = mode === "http2"
            ? Object.assign(new Error("ERR_HTTP2_PROTOCOL_ERROR"), {
              code: "ERR_HTTP2_PROTOCOL_ERROR",
            })
            : Object.assign(new Error("aborted"), { code: "ECONNRESET" });
          const node = {
            statusCode: mode === "protocol" ? 200 : 206,
            headers: {
              "content-range": mode === "protocol"
                ? null
                : `bytes ${start}-${end}/${source.byteLength}`,
            },
            destroy: vi.fn(() => { settle(); }),
            [Symbol.asyncIterator]: () => {
              let index = 0;
              return {
                next: (): Promise<IteratorResult<Uint8Array>> => {
                  if (rejectBeforeBody) {
                    settle();
                    return Promise.reject(transportError);
                  }
                  if (connectionFault && index === 1) {
                    settle();
                    return Promise.reject(transportError);
                  }
                  if (index === 0) {
                    index += 1;
                    return Promise.resolve({ value: firstChunk, done: false });
                  }
                  settle();
                  return Promise.resolve({ value: undefined, done: true });
                },
                return: (): Promise<IteratorResult<Uint8Array>> => {
                  settle();
                  return Promise.resolve({ value: undefined, done: true });
                },
              };
            },
          };
          const request = { on: vi.fn(), end: vi.fn(), destroy: node.destroy };
          queueMicrotask(() => callback(node));
          return request;
        },
      ),
    };

    return {
      https,
      requests,
      maxRefetchActive: () => maxRefetchActive,
      requestCount: () => requests.length,
      refetchBytes: () => requestedBytes
        .filter((entry) => entry.attempt > 1)
        .reduce((sum, entry) => sum + entry.bytes, 0),
    };
  }

  function makeDiagSpy() {
    const warnings: string[] = [];
    return {
      diag: {
        warn: (_category: string, message: string) => { warnings.push(message); },
      } as never,
      warnings,
    };
  }

  function downloadInput(source: Uint8Array, signal = new AbortController().signal) {
    return {
      url: "https://cdn.example/file",
      windows: windowsFor(source.byteLength),
      fileSize: source.byteLength,
      signal,
      label: 'Remote file "big.bin"',
    };
  }

  it("A: re-fetches only the failed window and keeps every completed one", async () => {
    const failedWindow = 7;
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const server = makeRangeServer(source, ({ windowIndex, attempt }) =>
      windowIndex === failedWindow && attempt === 1 ? "connection" : null);
    const downloader = createRangeStreamDownloader(server.https as never, makeDiagSpy().diag)!;

    const buffer = await downloader.download(downloadInput(source));

    expect(await sha256Hex(buffer)).toBe(await sha256Hex(source.buffer));
    for (let windowIndex = 0; windowIndex < WINDOW_COUNT; windowIndex++) {
      const attempts = server.requests.filter(
        (request) => request.windowIndex === windowIndex,
      );
      // The completed windows were never part of the degraded retry; only the
      // window that died mid-transfer was fetched a second time.
      expect(attempts).toHaveLength(windowIndex === failedWindow ? 2 : 1);
    }
    expect(server.refetchBytes()).toBe(WINDOW_BYTES / 2);
  });

  it("B: degrades 16→4 after a whole-round transport failure and re-fetches less than the file", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    // Both field-evidence markers are exercised: `aborted`/ECONNRESET on the
    // even windows and `ERR_HTTP2_PROTOCOL_ERROR` on the odd ones.
    const server = makeRangeServer(source, ({ attempt, windowIndex }) =>
      attempt === 1 ? (windowIndex % 2 === 0 ? "connection" : "http2") : null);
    const { diag, warnings } = makeDiagSpy();
    const downloader = createRangeStreamDownloader(server.https as never, diag)!;

    const buffer = await downloader.download(downloadInput(source));

    expect(await sha256Hex(buffer)).toBe(await sha256Hex(source.buffer));
    // The old behavior discarded the entire assembly and re-downloaded the
    // whole file on the single-stream fallback; the degraded pass asks only
    // for the unlanded halves (fileSize / 2), and never runs more than four
    // streams at once.
    expect(server.refetchBytes()).toBe(source.byteLength / 2);
    expect(server.refetchBytes()).toBeLessThan(source.byteLength);
    expect(server.maxRefetchActive()).toBe(4);
    for (let windowIndex = 0; windowIndex < WINDOW_COUNT; windowIndex++) {
      expect(server.requests.filter(
        (request) => request.windowIndex === windowIndex,
      )).toHaveLength(2);
    }
    expect(warnings.some((message) =>
      message.includes("multi-range degraded streams 16→4")
      && message.includes("connection-level failure"))).toBe(true);
  });

  it("C: hands a protocol-level failure to the single-stream fallback without a retry round", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const server = makeRangeServer(source, ({ windowIndex, attempt }) =>
      windowIndex === 3 && attempt === 1 ? "protocol" : null);
    const { diag, warnings } = makeDiagSpy();
    const downloader = createRangeStreamDownloader(server.https as never, diag)!;

    await expect(downloader.download(downloadInput(source))).rejects.toThrow(
      /range request not honored \(status 200\)/,
    );

    // All 16 first-pass streams had already started; none of them was
    // restarted, because a non-206 answer cannot be repaired by lowering the
    // stream count.
    expect(server.requestCount()).toBe(WINDOW_COUNT);
    expect(server.requests.every((request) => request.attempt === 1)).toBe(true);
    expect(warnings.some((message) =>
      message.includes("protocol-level range failure")
      && message.includes("streams=1"))).toBe(true);
  });

  it("D: stops after one degraded retry and fails closed with the transport error", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const server = makeRangeServer(source, () => "connection");
    const { diag, warnings } = makeDiagSpy();
    const downloader = createRangeStreamDownloader(server.https as never, diag)!;

    await expect(downloader.download(downloadInput(source))).rejects.toMatchObject({
      message: "aborted",
      code: "ECONNRESET",
    });

    // 16 first-pass streams + the 4-stream degraded pass; no third round.
    expect(server.requestCount()).toBe(WINDOW_COUNT + 4);
    expect(server.requests.every((request) => request.attempt <= 2)).toBe(true);
    expect(warnings.some((message) =>
      message.includes("degraded round failed at 4 streams")
      && message.includes("streams=1"))).toBe(true);
  });

  it("E: treats a socket error after the last byte as a completed window, not an empty retry", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const lastByteErrorWindow = 9;
    const server = makeRangeServer(source, ({ windowIndex, attempt }) =>
      windowIndex === lastByteErrorWindow && attempt === 1
        ? "connection-after-body"
        : null);
    const downloader = createRangeStreamDownloader(server.https as never, makeDiagSpy().diag)!;

    const buffer = await downloader.download(downloadInput(source));

    expect(await sha256Hex(buffer)).toBe(await sha256Hex(source.buffer));
    expect(server.requests.filter(
      (request) => request.windowIndex === lastByteErrorWindow,
    )).toHaveLength(1);
    expect(server.refetchBytes()).toBe(0);
  });

  it("F: hands the landed prefix and its first hole to the single-stream fallback (2026-10-28)", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const halfLandedWindow = 9;
    const server = makeRangeServer(source, ({ windowIndex, attempt }) => {
      if (windowIndex < halfLandedWindow) return null;
      if (windowIndex === halfLandedWindow) {
        // Full pass: half a window lands before the socket dies. The degraded
        // 4-stream retry then dies before its first byte, so the hole stays
        // exactly half a window wide.
        return attempt === 1 ? "connection" : "connection-before-body";
      }
      return "connection-before-body";
    });
    const downloader = createRangeStreamDownloader(server.https as never, makeDiagSpy().diag)!;

    const failure = await downloader.download(downloadInput(source)).then(
      () => null,
      (error: unknown) => error,
    );

    // The original transport error keeps its identity (no wrapper): every
    // existing classification still sees the same object.
    expect(failure).toMatchObject({ message: "aborted", code: "ECONNRESET" });
    const partial = readRangePartialDownload(failure)!;
    expect(partial).not.toBeNull();
    expect(partial.fileSize).toBe(source.byteLength);
    // 9.5 of 16 windows ≈ 59.4% of the file; the remaining 40.6% is all the
    // single-stream fallback still has to ask for.
    expect(partial.landedOffset).toBe(
      halfLandedWindow * WINDOW_BYTES + Math.ceil(WINDOW_BYTES / 2),
    );
    expect(partial.landedBytes).toBe(partial.landedOffset);
    expect(partial.landedOffset).toBeGreaterThan(source.byteLength * 0.59);
    expect(partial.landedOffset).toBeLessThan(source.byteLength * 0.6);
    // The handed buffer already holds the real bytes of that prefix: the
    // fallback continues in this same assembly, it does not start over.
    const landedPrefix = partial.assembly.subarray(0, partial.landedOffset);
    expect(await sha256Hex(landedPrefix.slice().buffer))
      .toBe(await sha256Hex(source.slice(0, partial.landedOffset).buffer));
    // Aborts and unrelated errors never carry a resume position.
    expect(readRangePartialDownload(new Error("aborted"))).toBeNull();
    expect(readRangePartialDownload(null)).toBeNull();
  });
});

describe("range stream adaptive observations (G3)", () => {
  const WINDOW_BYTES = 64 * 1024;
  const WINDOW_COUNT = 8;

  function patternedSource(byteLength: number): Uint8Array {
    const source = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index++) {
      source[index] = (index * 31 + 7) & 0xff;
    }
    return source;
  }

  function windowsFor(fileSize: number): RangeWindow[] {
    return Array.from({ length: WINDOW_COUNT }, (_, index) => ({
      start: index * WINDOW_BYTES,
      end: index === WINDOW_COUNT - 1
        ? fileSize - 1
        : (index + 1) * WINDOW_BYTES - 1,
    }));
  }

  type AdaptiveServerMode = "clean" | "rateLimited" | "connectionRecovered";

  /** Minimal adaptive-CD N fake: normal responses serve the requested
   *  sub-range; `rateLimited` answers 429 + Retry-After: 17 on the first
   *  request; `connectionRecovered` serves half a window then rejects with
   *  ECONNRESET on each window's first attempt, and serves the retried
   *  sub-range normally. */
  function makeAdaptiveServer(source: Uint8Array, mode: AdaptiveServerMode) {
    const attempts = new Map<number, number>();
    const requests: Array<{
      start: number;
      end: number;
      attempt: number;
      windowIndex: number;
    }> = [];
    const https = {
      request: vi.fn(
        (
          _url: string,
          options: { headers: { Range: string } },
          callback: (response: unknown) => void,
        ) => {
          const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)!;
          const start = Number(match[1]);
          const end = Number(match[2]);
          const windowIndex = Math.floor(start / WINDOW_BYTES);
          const attempt = (attempts.get(windowIndex) ?? 0) + 1;
          attempts.set(windowIndex, attempt);
          requests.push({ start, end, attempt, windowIndex });

          const rateLimited = mode === "rateLimited" && requests.length === 1;
          const connectionFault = mode === "connectionRecovered" && attempt === 1;
          const body = source.subarray(start, end + 1);
          const firstChunk = connectionFault
            ? body.subarray(0, Math.ceil(body.byteLength / 2))
            : body;
          const node = {
            statusCode: rateLimited ? 429 : 206,
            headers: rateLimited
              ? { "content-range": null, "retry-after": "17" }
              : { "content-range": `bytes ${start}-${end}/${source.byteLength}` },
            destroy: vi.fn(),
            [Symbol.asyncIterator]: () => {
              let index = 0;
              return {
                next: (): Promise<IteratorResult<Uint8Array>> => {
                  if (rateLimited) {
                    return Promise.resolve({ value: undefined, done: true });
                  }
                  if (connectionFault && index === 1) {
                    return Promise.reject(
                      Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
                    );
                  }
                  if (index === 0) {
                    index += 1;
                    return Promise.resolve({ value: firstChunk, done: false });
                  }
                  return Promise.resolve({ value: undefined, done: true });
                },
                return: (): Promise<IteratorResult<Uint8Array>> =>
                  Promise.resolve({ value: undefined, done: true }),
              };
            },
          };
          const request = { on: vi.fn(), end: vi.fn(), destroy: node.destroy };
          queueMicrotask(() => callback(node));
          return request;
        },
      ),
    };
    return { https, requests };
  }

  interface ObserverEvent {
    kind: "clean" | "connection" | "rateLimited";
    sample?: RangeStreamTransferSample;
    retryAfterMs?: number | null;
  }

  function makeObserver() {
    const events: ObserverEvent[] = [];
    const clock = { now: 0 };
    const observer: RangeStreamObserver = {
      nowMs: () => clock.now,
      recordCleanTransfer: (sample) => {
        events.push({ kind: "clean", sample });
      },
      recordConnectionFailure: () => {
        events.push({ kind: "connection" });
      },
      recordRateLimited: (observation) => {
        events.push({
          kind: "rateLimited",
          retryAfterMs: observation?.retryAfterMs ?? null,
        });
      },
    };
    return { observer, events };
  }

  function makeInput(
    source: Uint8Array,
    observer?: RangeStreamObserver,
  ): RangeDownloadInput {
    return {
      url: "https://cdn.example/file",
      windows: windowsFor(source.byteLength),
      fileSize: source.byteLength,
      signal: new AbortController().signal,
      label: 'Remote file "adaptive.bin"',
      adaptation: observer,
    };
  }

  it("records exactly one clean transfer sample for a successful multi-range download", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const server = makeAdaptiveServer(source, "clean");
    const { observer, events } = makeObserver();
    const downloader = createRangeStreamDownloader(server.https as never)!;

    const buffer = await downloader.download(makeInput(source, observer));

    expect(await sha256Hex(buffer)).toBe(await sha256Hex(source.buffer));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "clean",
      sample: {
        streams: WINDOW_COUNT,
        bytes: source.byteLength,
        elapsedMs: 1,
      },
    });
    expect(server.requests).toHaveLength(WINDOW_COUNT);
  });

  it("reports a 429 with its Retry-After immediately and keeps the protocol fallback", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const server = makeAdaptiveServer(source, "rateLimited");
    const { observer, events } = makeObserver();
    const downloader = createRangeStreamDownloader(server.https as never)!;

    await expect(downloader.download(makeInput(source, observer))).rejects.toThrow(
      /range request not honored \(status 429\)/,
    );

    expect(events).toEqual([{ kind: "rateLimited", retryAfterMs: 17_000 }]);
  });

  it("reports a connection failure even when the degraded round recovers every byte", async () => {
    const source = patternedSource(WINDOW_BYTES * WINDOW_COUNT);
    const server = makeAdaptiveServer(source, "connectionRecovered");
    const { observer, events } = makeObserver();
    const downloader = createRangeStreamDownloader(server.https as never)!;

    const buffer = await downloader.download(makeInput(source, observer));

    expect(await sha256Hex(buffer)).toBe(await sha256Hex(source.buffer));
    expect(events).toEqual([{ kind: "connection" }]);
    expect(server.requests.filter((request) => request.attempt === 1))
      .toHaveLength(WINDOW_COUNT);
    expect(server.requests.filter((request) => request.attempt === 2))
      .toHaveLength(WINDOW_COUNT);
  });
});
