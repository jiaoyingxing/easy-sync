import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRangeStreamDownloader,
  loadNodeHttps,
} from "../src/onedrive/range-download";
import type { RangeDownloadInput } from "../src/onedrive/range-download";
import type { RangeWindow } from "../src/onedrive/download-range-policy";

/** Minimal Node-https fake: responses are served in request order, each with
 *  a controllable status, Content-Range header, chunk list, optional per-chunk
 *  timer delays, an optional hang after the chunks (stall), and a destroy()
 *  that rejects any pending body read (what a real socket teardown does).
 *  Retries always restart their whole window, so a retry spec must deliver
 *  the full window bytes again. */

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
      // window A attempts 1-3: delivers 1 of 4 bytes then ends
      { chunks: [new Uint8Array([1])], contentRange: "bytes 0-3/8" },
      // window B completes on its single attempt
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
      { chunks: [new Uint8Array([1])], contentRange: "bytes 0-3/8" },
      { chunks: [new Uint8Array([1])], contentRange: "bytes 0-3/8" },
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

  it("retries a stalled stream on a fresh connection and completes", async () => {
    const { https, requestCount } = makeFakeHttps([
      // window A attempt 1: one chunk then the connection hangs
      { chunks: [new Uint8Array([1, 2])], contentRange: "bytes 0-3/8", hangNext: true },
      // window B attempt 1: completes normally
      { chunks: [new Uint8Array([5, 6, 7, 8])], contentRange: "bytes 4-7/8" },
      // window A attempt 2: retries the WHOLE window and completes
      { chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])], contentRange: "bytes 0-3/8" },
    ]);
    const downloader = createRangeStreamDownloader(https as never)!;

    const pending = downloader.download(makeInput());
    await vi.advanceTimersByTimeAsync(61_000);
    const buffer = await pending;

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(requestCount()).toBe(3);
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
      // window A attempt 2: healthy, full window
      { chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])], contentRange: "bytes 0-3/8" },
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
