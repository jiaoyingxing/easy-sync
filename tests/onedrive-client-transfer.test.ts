// 传输：下载、上传与多段范围下载
// 由 tests/onedrive-client.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as obsidian from "obsidian";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { OneDriveClient, downloadBudget } from "../src/onedrive/client";
import { createRangeStreamDownloader } from "../src/onedrive/range-download";
import { sha256Hex } from "../src/crypto";
import { UPLOAD_CHUNK_SLOW_BYTES } from "../src/onedrive/upload-session-policy";
import {
  OneDriveError,
  OneDriveErrorType,
} from "../src/onedrive/types";

const EASY_SYNC_TMP_DIR = getEasySyncPaths(".obsidian").tmpDir;

describe("OneDriveClient.downloadFile", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not blacklist /content for the round on transport-level failures (2026-09-15 连坐切片)", async () => {
    vi.useFakeTimers();
    const __uh = (reason: unknown) => console.log("UNHANDLED:", String((reason as Error)?.message ?? reason));
    process.on("unhandledRejection", __uh);
    // 2026-09-15 iPhone evidence: a large file's stalled /content attempts
    // blacklisted the endpoint for the whole round, so small recordings later
    // in the round failed with "Content endpoint unavailable" without a
    // single attempt. Transport-level failures (statusCode 0 — the link
    // died) must not blacklist; the next file re-attempts every tier.
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation((request) => {
      const url = String(request.url);
      if (url.includes("?select=")) {
        return Promise.resolve({
          status: 200,
          headers: {},
          json: {
            "@microsoft.graph.downloadUrl": `https://cdn.example/${url.includes("id-a") ? "a" : "b"}.bin`,
          },
        });
      }
      // CDN and both /content tiers: dead link, no HTTP response at all.
      return Promise.reject(new Error("net::ERR_NETWORK_DEAD"));
    });
    const client = new OneDriveClient(async () => "token");

    const first = client.downloadFile("testVault", "a.bin", undefined, "id-a", 1024).then(
      () => ({ k: "resolved" as const }),
      (error: unknown) => ({ k: "rejected" as const, message: String((error as Error)?.message ?? error) }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const firstOutcome = await first;
    expect(firstOutcome.k).toBe("rejected");
    expect(firstOutcome.message).toMatch(/Network error/);

    // The second file re-attempts the full waterfall — no round blacklist.
    const second = client.downloadFile("testVault", "b.bin", undefined, "id-b", 1024).then(
      () => ({ k: "resolved" as const }),
      (error: unknown) => ({ k: "rejected" as const, message: String((error as Error)?.message ?? error) }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const secondOutcome = await second;
    expect(secondOutcome.k).toBe("rejected");
    expect(secondOutcome.message).toMatch(/Network error/);
    expect(secondOutcome.message).not.toMatch(/Content endpoint unavailable/);

    const contentCallsFor = (id: string) => requestSpy.mock.calls.filter(([r]) =>
      String(r.url).includes("/content") && String(r.url).includes(id)).length;
    // Both /content tiers attempted for each file (Obsidian requestUrl does
    // not retry this path — one attempt per tier per file).
    expect(contentCallsFor("id-a")).toBeGreaterThanOrEqual(2);
    expect(contentCallsFor("id-b")).toBeGreaterThanOrEqual(2);
    process.off("unhandledRejection", __uh);
  });

  it("still blacklists /content for the round on endpoint-level failures", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation((request) => {
      const url = String(request.url);
      if (url.includes("?select=")) {
        return Promise.resolve({
          status: 200,
          headers: {},
          json: {
            "@microsoft.graph.downloadUrl": `https://cdn.example/${url.includes("id-a") ? "a" : "b"}.bin`,
          },
        });
      }
      if (url.includes("/cdn.example/")) {
        // Dead link on the CDN tier (transport-level — never blacklists).
        return Promise.reject(new Error("net::ERR_NETWORK_DEAD"));
      }
      // /content tiers answer with a real HTTP status: endpoint broken.
      // Real Obsidian requestUrl THROWS on non-2xx with the status attached.
      return Promise.reject(Object.assign(new Error("HTTP 404 Not Found"), { status: 404 }));
    });
    const client = new OneDriveClient(async () => "token");

    const first = client.downloadFile("testVault", "a.bin", undefined, "id-a", 1024).then(
      () => ({ k: "resolved" as const }),
      (error: unknown) => ({ k: "rejected" as const, message: String((error as Error)?.message ?? error) }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const firstOutcome = await first;
    expect(firstOutcome.k).toBe("rejected");
    expect(firstOutcome.message).toMatch(/404/);

    // The endpoint is confirmed broken with HTTP evidence: the next file
    // fails fast at the round gate instead of re-requesting /content.
    const second = client.downloadFile("testVault", "b.bin", undefined, "id-b", 1024).then(
      () => ({ k: "resolved" as const }),
      (error: unknown) => ({ k: "rejected" as const, message: String((error as Error)?.message ?? error) }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const secondOutcome = await second;
    expect(secondOutcome.k).toBe("rejected");
    expect(secondOutcome.message).toMatch(/Content endpoint unavailable/);
    const contentCallsForSecondFile = requestSpy.mock.calls.filter(([r]) =>
      String(r.url).includes("/content") && String(r.url).includes("id-b")).length;
    expect(contentCallsForSecondFile).toBe(0);
  });

  it("resumes a stalled streamed download from the received prefix (甲路: bytes are assets)", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const expectedHashBuffer = await crypto.subtle.digest("SHA-256", content);
    const expectedHash = Array.from(new Uint8Array(expectedHashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    let file = new Uint8Array(0);
    let firstAttempt = true;
    let emittedFirstChunk = false;
    const fetchSpy = vi.fn((_url: string, init?: { headers?: Record<string, string> }) => {
      if (firstAttempt) {
        firstAttempt = false;
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            // Emit exactly one chunk, then fail: pull() runs ahead of the
            // writer, so file.length must not gate the emit.
            if (!emittedFirstChunk) {
              emittedFirstChunk = true;
              controller.enqueue(content.subarray(0, 3));
            } else {
              controller.error(new Error("stalled"));
            }
          },
        }), { status: 200, headers: { "Content-Length": "8" } }));
      }
      // The reconnect must ask for the remainder, not restart from zero.
      expect(init?.headers?.Range).toBe("bytes=3-");
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content.subarray(3));
          controller.close();
        },
      }), { status: 206, headers: { "Content-Range": "bytes 3-7/8", "Content-Length": "5" } }));
    });
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a" },
    });
    const adapter = {
      writeBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        file = new Uint8Array(data.slice(0));
      }),
      appendBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        const merged = new Uint8Array(file.length + data.byteLength);
        merged.set(file);
        merged.set(new Uint8Array(data), file.length);
        file = merged;
      }),
      readBinary: vi.fn(async () => file.slice().buffer),
      remove: vi.fn(async () => {
        file = new Uint8Array(0);
      }),
    };
    try {
      const client = new OneDriveClient(async () => "token");
      const result = await client.downloadFileToPath(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        adapter as never,
        "https://download.example/recording.m4a",
        "file-id",
        content.byteLength,
        expectedHash,
      );
      expect(result).toEqual({ size: content.byteLength, hash: expectedHash });
      expect(Array.from(file)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(adapter.appendBinary).toHaveBeenCalled();
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("discards the kept prefix when the waterfall gives up on the file", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    let file = new Uint8Array(0);
    let emittedFirstChunk = false;
    const fetchSpy = vi.fn(() => {
      if (emittedFirstChunk) {
        return Promise.reject(new Error("net::ERR_NETWORK_DEAD"));
      }
      emittedFirstChunk = true;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (file.length === 0) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          } else {
            controller.error(new Error("stalled"));
          }
        },
      }), { status: 200, headers: { "Content-Length": "8" } }));
    });
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a" },
    });
    const adapter = {
      writeBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        file = new Uint8Array(data.slice(0));
      }),
      appendBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        const merged = new Uint8Array(file.length + data.byteLength);
        merged.set(file);
        merged.set(new Uint8Array(data), file.length);
        file = merged;
      }),
      readBinary: vi.fn(async () => file.slice().buffer),
      remove: vi.fn(async () => {
        file = new Uint8Array(0);
      }),
    };
    try {
      const client = new OneDriveClient(async () => "token");
      const outcome = await client.downloadFileToPath(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        adapter as never,
        "https://download.example/recording.m4a",
        "file-id",
        8,
        undefined,
      ).then(
        () => ({ k: "resolved" as const }),
        (error: unknown) => ({ k: "rejected" as const, message: String((error as Error)?.message ?? error) }),
      );
      expect(outcome.k).toBe("rejected");
      // Terminal failure: the kept prefix is unreachable by any further
      // retry this round — it must be discarded, not leaked in tmp.
      expect(adapter.remove).toHaveBeenCalled();
      expect(file.length).toBe(0);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("downgrades to a fresh stream when the server ignores the Range request", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const expectedHashBuffer = await crypto.subtle.digest("SHA-256", content);
    const expectedHash = Array.from(new Uint8Array(expectedHashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    let file = new Uint8Array(0);
    let firstAttempt = true;
    let emittedFirstChunk = false;
    const fetchSpy = vi.fn(() => {
      if (firstAttempt) {
        firstAttempt = false;
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emittedFirstChunk) {
              emittedFirstChunk = true;
              controller.enqueue(content.subarray(0, 3));
            } else {
              controller.error(new Error("stalled"));
            }
          },
        }), { status: 200, headers: { "Content-Length": "8" } }));
      }
      // Server ignored the Range header: answer 200 with the full body.
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(content);
          controller.close();
        },
      }), { status: 200, headers: { "Content-Length": "8" } }));
    });
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a" },
    });
    const adapter = {
      writeBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        file = new Uint8Array(data.slice(0));
      }),
      appendBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        const merged = new Uint8Array(file.length + data.byteLength);
        merged.set(file);
        merged.set(new Uint8Array(data), file.length);
        file = merged;
      }),
      readBinary: vi.fn(async () => file.slice().buffer),
      remove: vi.fn(async () => {
        file = new Uint8Array(0);
      }),
    };
    try {
      const client = new OneDriveClient(async () => "token");
      const result = await client.downloadFileToPath(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        adapter as never,
        "https://download.example/recording.m4a",
        "file-id",
        content.byteLength,
        expectedHash,
      );
      // Fail closed: the ignored Range downgrades to a full fresh stream and
      // the file lands exactly once, with no duplicated prefix.
      expect(result).toEqual({ size: content.byteLength, hash: expectedHash });
      expect(Array.from(file)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("streams mobile downloads from 2 MiB so reconnects have bytes to resume (甲路 threshold)", () => {
    const executorSource = readFileSync("src/sync/sync-executor.ts", "utf8");
    expect(executorSource).toContain("MOBILE_STREAM_DOWNLOAD_MIN_BYTES = 2 * 1024 * 1024");
  });

  it("downloadUrl uses file-size budget instead of 8s cap", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    // CDN responds in 15s. Primary budget for 5MB = 20s, plus 30% failure reserve.
    // Old: Math.min(8s, 20s) = 8s timeout → downloadUrl killed before 15s response
    // New: total window = 26s → downloadUrl succeeds at 15s without using fallback.
    const content = new Uint8Array([1, 2, 3]).buffer;
    requestSpy.mockImplementationOnce(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          status: 200,
          headers: {},
          arrayBuffer: content,
        }), 15_000);
      });
    });

    const client = new OneDriveClient(async () => "token");
    const pending = client.downloadFile(
      "testVault",
      "video.mp4",
      "https://download.example/video.mp4",
      undefined,
      5 * 1024 * 1024,  // 5MB → budget = 20s (15s + 5×1s)
    );

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual(expect.any(ArrayBuffer));
    expect(requestSpy).toHaveBeenCalledTimes(1); // downloadUrl only, no /content fallback
  });

  it("stops an oversized CDN response without opening another download path", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.downloadFile(
      "testVault",
      "note.md",
      "https://download.example/note.md",
      "file-id",
      3,
    )).rejects.toMatchObject({
      name: "ResponseByteBudgetError",
      // Body larger than the declared size = the content race the download
      // layer defers (2026-10-13), not the declared-over-cap hard failure.
      kind: "observed",
      message: expect.stringContaining("4 > 3"),
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("reads a response declaring more than the file's own size as the content race, not a standing fact", async () => {
    // 2026-10-16（Q2）：同一物理竞态的第三个检测点——远端在本机读到元数据之后
    // 被改写，于是响应头声明的长度大于该文件自己的尺寸。它此前与「自身超硬上限」
    // 共用 kind="declared" ⇒ 被当恒久条件硬失败、自动同步暂停；改判后归瞬时延后。
    const originalWindow = (globalThis as { window?: unknown }).window;
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([1, 2, 3, 4]),
      { status: 200, headers: { "Content-Length": "4" } },
    ));
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const requestSpy = vi.spyOn(obsidian, "requestUrl");

    try {
      const client = new OneDriveClient(async () => "token");
      await expect(client.downloadFile(
        "testVault",
        "note.md",
        "https://download.example/note.md",
        "file-id",
        3,
      )).rejects.toMatchObject({
        name: "ResponseByteBudgetError",
        kind: "declared-over-expected",
        message: expect.stringContaining("4 > 3"),
      });
      expect(requestSpy).not.toHaveBeenCalled();
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("keeps a declared size over the hard cap a standing fact when the file size is unknown", async () => {
    // 反例护栏（同族精度钉）：元数据尺寸不可用时预算回落到硬上限，此时响应声明
    // 超上限仍是恒久条件——不得因为新增了竞态档就把这一格也并进延后。
    const originalWindow = (globalThis as { window?: unknown }).window;
    const overCap = 2 * 1024 * 1024 * 1024 + 1;
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([1, 2, 3, 4]),
      { status: 200, headers: { "Content-Length": String(overCap) } },
    ));
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const requestSpy = vi.spyOn(obsidian, "requestUrl");

    try {
      const client = new OneDriveClient(async () => "token");
      await expect(client.downloadFile(
        "testVault",
        "note.md",
        "https://download.example/note.md",
        "file-id",
      )).rejects.toMatchObject({
        name: "ResponseByteBudgetError",
        kind: "declared",
      });
      expect(requestSpy).not.toHaveBeenCalled();
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("removes a partial streamed file when the body exceeds its declared size", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const localPath = `${EASY_SYNC_TMP_DIR}/downloads/note.md.part`;
    const adapter = {
      writeBinary: vi.fn().mockResolvedValue(undefined),
      appendBinary: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const requestSpy = vi.spyOn(obsidian, "requestUrl");

    try {
      const client = new OneDriveClient(async () => "token");
      await expect(client.downloadFileToPath(
        "testVault",
        "note.md",
        localPath,
        adapter as never,
        "https://download.example/note.md",
        "file-id",
        3,
      )).rejects.toMatchObject({
        name: "ResponseByteBudgetError",
        message: expect.stringContaining("4 > 3"),
      });
      expect(adapter.writeBinary).toHaveBeenCalledTimes(1);
      expect(adapter.appendBinary).not.toHaveBeenCalled();
      expect(adapter.remove).toHaveBeenLastCalledWith(localPath);
      expect(requestSpy).not.toHaveBeenCalled();
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("records CDN fetch fallback as a retried download attempt", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: content,
    });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    const result = await client.downloadFile(
      "testVault",
      "note.md",
      "https://download.example/signed?secret=hidden",
      "file-id",
      content.byteLength,
    );
    expect(client.hasDegradedDownloadPathThisRound()).toBe(true);
    const summary = client.finishRunMetrics();

    expect(result).toEqual(content);
    expect(summary?.endpoints.downloadUrl).toMatchObject({
      attempts: 2,
      succeeded: 1,
      failed: 1,
      effectiveBytes: 3,
      retriedBytes: 3,
      statusCategories: {
        network: 1,
        success: 1,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("download.example");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("records Graph content fetch and requestUrl fallback as one endpoint", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: content,
    });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    const result = await client.downloadFile(
      "testVault",
      "note.md",
      undefined,
      undefined,
      content.byteLength,
    );
    const summary = client.finishRunMetrics();

    expect(result).toEqual(content);
    expect(summary?.endpoints.contentFallback).toMatchObject({
      attempts: 2,
      succeeded: 1,
      failed: 1,
      effectiveBytes: 3,
      retriedBytes: 3,
      statusCategories: {
        network: 1,
        success: 1,
      },
    });
  });

  it("retries a fresh metadata downloadUrl once after a transport failure", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
        },
      })
      .mockRejectedValueOnce(new Error("net::ERR_QUIC_PROTOCOL_ERROR"))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        arrayBuffer: content,
      });
    const client = new OneDriveClient(async () => "token");

    await expect(
      client.downloadFile("testVault", "recording.m4a", undefined, "file-id", 5 * 1024 * 1024),
    ).resolves.toBe(content);
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it("cancels a pending CDN retry without waiting for the backoff timer", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new ArrayBuffer(0), { status: 503 }),
    );
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
      },
    });
    const controller = new AbortController();
    const client = new OneDriveClient(async () => "token");
    client.setAbortSignal(controller.signal);
    let settled = false;

    try {
      const outcome = client.downloadFile(
        "testVault",
        "recording.m4a",
        undefined,
        "file-id",
        5 * 1024 * 1024,
      ).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { name: "AbortError" },
      });
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("kills a stalled CDN fetch at the 60s zero-progress watchdog and retries within budget", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    // 2026-09-13 real failure: a stalled attempt burned its full 300-450s
    // budget with zero bytes. The watchdog must abort the dead connection at
    // 60s so the waterfall retries on a fresh connection while budget
    // remains — a working second attempt must complete the download.
    const fetchSpy = vi.fn()
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }));
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
      },
    });
    try {
      const client = new OneDriveClient(async () => "token");
      const pending = client.downloadFile(
        "testVault",
        "recording.m4a",
        undefined,
        "file-id",
        5 * 1024 * 1024,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // The watchdog fires at 60s, far inside the ~135s total budget; the
      // retry backoff sleep lands just past the advanced window.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual(expect.any(ArrayBuffer));
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("kills a stalled CDN body read at the 60s zero-progress watchdog", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    // Body arrives, then the connection stalls mid-stream forever. The
    // watchdog aborts the dead read, the partial file is cleaned up, and the
    // retried attempt completes.
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            // Never closes: the connection stalls after the first chunk.
          },
        }),
        { status: 200 },
      )))
      .mockResolvedValueOnce(new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
            controller.close();
          },
        }),
        { status: 200 },
      ));
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const localPath = `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`;
    const adapter = {
      writeBinary: vi.fn().mockResolvedValue(undefined),
      appendBinary: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
      },
    });
    try {
      const client = new OneDriveClient(async () => "token");
      const pending = client.downloadFileToPath(
        "testVault",
        "recording.m4a",
        localPath,
        adapter as never,
        undefined,
        "file-id",
        5 * 1024 * 1024,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(adapter.remove).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({ size: 5 });
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("aborts a too-slow CDN download and retries on a fresh connection", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    // 2026-09-14 sampling: per-connection rates span 84 KiB/s – 3.2 MiB/s on
    // the same link (7/10 connections below 512 KiB/s). A slow connection
    // must be dropped at the user-set gate (512 KiB/s over 15 s) so the
    // waterfall retries on a fresh connection instead of crawling.
    const M = 1024 * 1024;
    const fileBytes = 8 * M;
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            // ~100 KiB/s: 1 KiB every 10 ms of fake time — below the gate.
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            controller.enqueue(new Uint8Array(1024));
          },
        }),
        { status: 200 },
      )))
      .mockResolvedValueOnce(new Response(new Uint8Array(fileBytes), { status: 200 }));
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
      },
    });
    try {
      const client = new OneDriveClient(async () => "token");
      const pending = client.downloadFile(
        "testVault",
        "recording.m4a",
        undefined,
        "file-id",
        fileBytes,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // The gate fires at ~15 s (far inside the 57 s budget); the retry
      // backoff sleep lands just past the advanced window.
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;
      expect(result.byteLength).toBe(fileBytes);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("accepts a comparable second connection instead of looping (2026-09-15 iPhone replay)", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    // 2026-09-15 rewrite: the slow gate judges windows relative to what the
    // link recently proved. A cold slow window still aborts (legacy absolute
    // rule), but the reconnect lands on a comparable connection, so the gate
    // accepts it instead of burning the remaining reconnect budget — the
    // uniform-slow-link loop that motivated the 2026-09-14 gate is gone.
    const M = 1024 * 1024;
    const fileBytes = 4 * M;
    // ~60 KiB/s: 4096 bytes every 67 ms — the completion-imminence exemption
    // must not fire (eta ~53s > reconnect cost ~25s at one window in).
    const trickle = (finite: boolean) => {
      let sent = 0;
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise<void>((resolve) => setTimeout(resolve, 67));
            if (finite && sent >= fileBytes / 4096) { controller.close(); return; }
            if (finite) sent++;
            controller.enqueue(new Uint8Array(4096));
          },
        }),
        { status: 200 },
      ));
    };
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => trickle(false))
      .mockImplementationOnce(() => trickle(true));
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        "@microsoft.graph.downloadUrl": "https://download.example/big.bin",
      },
    });
    try {
      const client = new OneDriveClient(async () => "token");
      // Pin the no-Node environment so the file stays on the single-stream
      // waterfall this test exercises.
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = null;
      const pending = client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        "file-id",
        fileBytes,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Cold first window aborts once (absolute rule), then the comparable
      // reconnect is accepted: exactly two connections, no further looping.
      await vi.advanceTimersByTimeAsync(16_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const result = await pending;
      expect(result.byteLength).toBe(fileBytes);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("still abandons collapsing connections and accepts the fourth", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    // Genuine link collapse (~308 → ~102 → ~31 KiB/s, each window far below
    // 0.45 × the recent baseline): the relative judgment keeps reconnecting,
    // the budget still caps at three aborts, and the fourth connection is
    // accepted and must complete.
    const M = 1024 * 1024;
    const fileBytes = 16 * M;
    const trickleForever = (ms: number) => () => Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise<void>((resolve) => setTimeout(resolve, ms));
          controller.enqueue(new Uint8Array(4096));
        },
      }),
      { status: 200 },
    ));
    const fastFinite = () => Promise.resolve(new Response(
      new Uint8Array(fileBytes),
      { status: 200 },
    ));
    const fetchSpy = vi.fn()
      .mockImplementationOnce(trickleForever(13))
      .mockImplementationOnce(trickleForever(40))
      .mockImplementationOnce(trickleForever(133))
      .mockImplementationOnce(fastFinite);
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        "@microsoft.graph.downloadUrl": "https://download.example/big.bin",
      },
    });
    try {
      const client = new OneDriveClient(async () => "token");
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = null;
      const pending = client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        "file-id",
        fileBytes,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Three slow-aborts (hint tier ×1, metadata tier ×1, path /content
      // tier ×1), then the item ID /content tier's connection is accepted
      // and delivers the file.
      await vi.advanceTimersByTimeAsync(66_000);
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.byteLength).toBe(fileBytes);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      vi.useRealTimers();
    }
  });

  it("cancels a pending streamed CDN retry without opening another transfer", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new ArrayBuffer(0), { status: 503 }),
    );
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
      },
    });
    const adapter = {
      writeBinary: vi.fn().mockResolvedValue(undefined),
      appendBinary: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AbortController();
    const client = new OneDriveClient(async () => "token");
    client.setAbortSignal(controller.signal);
    let settled = false;

    try {
      const outcome = client.downloadFileToPath(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        adapter as never,
        undefined,
        "file-id",
        5 * 1024 * 1024,
      ).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        status: "rejected",
        error: { name: "AbortError" },
      });
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("uses the 30% reserve for one late CDN retry", async () => {
    vi.useFakeTimers();
    const content = new Uint8Array([1, 2, 3]).buffer;
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
        },
      })
      .mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error("net::ERR_QUIC_PROTOCOL_ERROR")), 19_000);
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve({
          status: 200,
          headers: {},
          arrayBuffer: content,
        }), 5_000);
      }));
    const client = new OneDriveClient(async () => "token");
    const pending = client.downloadFile(
      "testVault",
      "recording.m4a",
      undefined,
      "file-id",
      5 * 1024 * 1024,
    );

    await vi.advanceTimersByTimeAsync(26_000);
    await expect(pending).resolves.toBe(content);
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it("does not overlap fallbacks after an uncancellable CDN timeout", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(
      () => new Promise(() => undefined),
    );
    const client = new OneDriveClient(async () => "token");
    const pending = client.downloadFile(
      "testVault",
      "recording.m4a",
      "https://download.example/recording.m4a",
      "file-id",
      5 * 1024 * 1024,
    );
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
      message: "Download timed out for: recording.m4a",
    });

    // 5 MiB download budget under the 12 s/MiB curve: 30 s base + 60 s
    // primary + 50% reserve = 135 s total before the uncancellable timeout.
    await vi.advanceTimersByTimeAsync(140_000);
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does not multiply retries across metadata and content fallbacks", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValue(
      new Error("offline"),
    );
    const client = new OneDriveClient(async () => "token");

    await expect(
      client.downloadFile("testVault", "note.md", undefined, "file-id", 1024),
    ).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    expect(requestSpy).toHaveBeenCalledTimes(5);
  });

  it("requests downloadUrl metadata with base fields before downloading by item id", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const content = new Uint8Array([1, 2, 3]).buffer;
    requestSpy
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "file-id",
          name: "recording.m4a",
          size: 3,
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/recording.m4a",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        arrayBuffer: content,
      });

    const client = new OneDriveClient(async () => "token");
    const data = await client.downloadFile("testVault", "附件/录音/recording.m4a", undefined, "file-id");

    expect(data).toBe(content);
    expect(requestSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "GET",
        url: "https://graph.microsoft.com/v1.0/me/drive/items/file-id?select=id,name,size,file,@microsoft.graph.downloadUrl",
      }),
    );
    expect(requestSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        url: "https://download.example/recording.m4a",
      }),
    );
  });

  it("keeps large downloadUrl files on the serial path", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: content,
    });
    const client = new OneDriveClient(async () => "token");

    const data = await client.downloadFile(
      "testVault",
      "archive.zip",
      "https://download.example/archive.zip",
      undefined,
      11 * 1024 * 1024,
    );

    expect(data).toBe(content);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      url: "https://download.example/archive.zip",
    }));
  });

  it("streams fetch downloads directly into appendBinary when writing to a temp file", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const content = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content.subarray(0, 3));
            controller.enqueue(content.subarray(3));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Length": String(content.byteLength) },
        },
      ),
    );
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const chunks: number[][] = [];
    const adapter = {
      writeBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        chunks.push(Array.from(new Uint8Array(data)));
      }),
      appendBinary: vi.fn(async (_path: string, data: ArrayBuffer) => {
        chunks.push(Array.from(new Uint8Array(data)));
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const expectedHashBuffer = await crypto.subtle.digest("SHA-256", content);
    const expectedHash = Array.from(new Uint8Array(expectedHashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    try {
      const client = new OneDriveClient(async () => "token");
      client.beginRunMetrics();
      const result = await client.downloadFileToPath(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        adapter as never,
        "https://download.example/recording.m4a",
        undefined,
        content.byteLength,
        expectedHash,
      );
      const summary = client.finishRunMetrics();

      expect(result).toEqual({ size: content.byteLength, hash: expectedHash });
      expect(summary?.endpoints.downloadUrl).toMatchObject({
        attempts: 1,
        succeeded: 1,
        failed: 0,
        effectiveBytes: content.byteLength,
        retriedBytes: 0,
        statusCategories: { success: 1 },
      });
      expect(chunks).toEqual([[1, 2, 3], [4, 5, 6]]);
      expect(adapter.writeBinary).toHaveBeenCalledTimes(1);
      expect(adapter.appendBinary).toHaveBeenCalledTimes(1);
      expect(requestSpy).not.toHaveBeenCalled();
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("records bytes received before a streamed download fails", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const partial = new Uint8Array([1, 2, 3]);
    let emittedPartial = false;
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!emittedPartial) {
                emittedPartial = true;
                controller.enqueue(partial);
                return;
              }
              controller.error(new Error("stream disconnected"));
            },
          }),
          {
            status: 200,
            headers: { "Content-Length": "6" },
          },
        ),
      )
      .mockResolvedValue(
        new Response(new ArrayBuffer(0), { status: 404 }),
      );
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    const adapter = {
      writeBinary: vi.fn().mockResolvedValue(undefined),
      appendBinary: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const client = new OneDriveClient(async () => "token");
      client.beginRunMetrics();
      await expect(client.downloadFileToPath(
        "testVault",
        "recording.m4a",
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
        adapter as never,
        "https://download.example/recording.m4a",
        undefined,
        6,
      )).rejects.toBeDefined();
      const summary = client.finishRunMetrics();

      expect(summary?.endpoints.downloadUrl).toMatchObject({
        attempts: 1,
        succeeded: 0,
        failed: 1,
        effectiveBytes: 0,
        failedBytes: partial.byteLength,
      });
      expect(summary?.totals.failedBytes).toBe(partial.byteLength);
      expect(adapter.remove).toHaveBeenCalledWith(
        `${EASY_SYNC_TMP_DIR}/downloads/recording.m4a.part`,
      );
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("treats content endpoint 401 as a file download failure", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    requestSpy
      .mockRejectedValueOnce(new Error("stale download url"))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "file-id",
          name: "recording.m4a",
          size: 3,
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/fresh.m4a",
        },
      })
      .mockRejectedValueOnce(new Error("blocked download host"))
      .mockRejectedValueOnce({
        status: 401,
        headers: {},
        json: { error: { code: "unauthenticated", message: "content denied" } },
      });

    const client = new OneDriveClient(async () => "token");

    await expect(
      client.downloadFile(
        "testVault",
        "附件/录音/recording.m4a",
        "https://download.example/stale.m4a",
        "file-id",
      ),
    ).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.Unauthorized,
      statusCode: 401,
    });
    expect(requestSpy).toHaveBeenCalledTimes(4);
  });

  it("keeps ordinary Graph 401 responses classified as auth expiry", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValueOnce({
      status: 401,
      headers: {},
      json: { error: { code: "InvalidAuthenticationToken", message: "expired" } },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.getDelta("testVault")).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.AuthExpired,
      statusCode: 401,
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OneDriveClient 下载预算阶梯与 CDN 熔断 (2026-10-27)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("小档 <64 KiB 主 15 秒、中档 64–256 KiB 主 25 秒、≥256 KiB 原公式不变", () => {
    // 18 字节：阶梯前按 1 MiB 报价（30s + 12s 主 / 21s 备用），阶梯后只换主预算，
    // 备用预算仍是阶梯前的完整 63 秒。
    expect(downloadBudget(18)).toEqual({
      budgetClass: "small",
      primaryMs: 15_000,
      reserveMs: 63_000,
      totalMs: 78_000,
      channelCapMs: 15_000,
    });
    expect(downloadBudget(64 * 1024 - 1).budgetClass).toBe("small");

    expect(downloadBudget(64 * 1024)).toEqual({
      budgetClass: "medium",
      primaryMs: 25_000,
      reserveMs: 63_000,
      totalMs: 88_000,
      channelCapMs: 25_000,
    });
    expect(downloadBudget(256 * 1024).budgetClass).toBe("medium");

    // ≥256 KiB 逐字段保持阶梯前的取值，且没有通道窗口（首个通道仍可用满整份预算）。
    expect(downloadBudget(256 * 1024 + 1)).toEqual({
      budgetClass: "regular",
      primaryMs: 42_000,
      reserveMs: 21_000,
      totalMs: 63_000,
      channelCapMs: null,
    });
    expect(downloadBudget(5 * 1024 * 1024)).toEqual({
      budgetClass: "regular",
      primaryMs: 90_000,
      reserveMs: 45_000,
      totalMs: 135_000,
      channelCapMs: null,
    });
  });

  it("预算日志与 deadline 同源：18 字节文件按 small 档打印同一组取值", async () => {
    const diag = { log: vi.fn(), warn: vi.fn() };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new Uint8Array(18).buffer,
    });
    const client = new OneDriveClient(async () => "token", diag as never);

    await client.downloadFile(
      "testVault",
      "note.md",
      "https://download.example/note.md",
      undefined,
      18,
    );

    const budgetLine = diag.log.mock.calls
      .map((call) => String(call[1]))
      .find((message) => message.includes("primaryMs="));
    expect(budgetLine).toContain("class=small");
    expect(budgetLine).toContain("primaryMs=15000");
    expect(budgetLine).toContain("reserveMs=63000");
    expect(budgetLine).toContain("budgetMs=78000");
    expect(budgetLine).toContain("channelCapMs=15000");
  });

  /** CDN responses are served through `window.fetch`; a function mock lets each
   *  file decide whether the CDN hangs (no HTTP response at all — the dead-link
   *  shape) or answers, and records when each attempt started. A hanging fetch
   *  still rejects on abort like the real one, so the waterfall's channel window
   *  behaves as it does in production. */
  function installCdnFetch(respond: (url: string) => Promise<Response> | null): {
    calls: { url: string; at: number }[];
    restore: () => void;
  } {
    const previous = (globalThis as { window?: unknown }).window;
    const calls: { url: string; at: number }[] = [];
    (globalThis as { window?: unknown }).window = {
      fetch: (input: RequestInfo | URL, init?: { signal?: AbortSignal }) => {
        const url = String(input);
        calls.push({ url, at: Date.now() });
        const answer = respond(url);
        if (answer) return answer;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    return {
      calls,
      restore: () => {
        if (previous === undefined) delete (globalThis as { window?: unknown }).window;
        else (globalThis as { window?: unknown }).window = previous;
      },
    };
  }

  /** Advance the fake clock in small steps until the download settles. Exact
   *  one-shot advances miss the timers that later waterfall tiers register while
   *  the previous tier's rejection is still unwinding. */
  async function settle<T>(pending: Promise<T>, maxSteps = 240): Promise<T> {
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    for (let step = 0; step < maxSteps && !settled; step++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    return pending;
  }

  const cdnCallsFor = (
    calls: { url: string; at: number }[],
    id: string,
  ) => calls.filter((call) => call.url.includes(`${id}.bin`));

  it("连续 3 次传输级失败后本轮跳过 CDN，第 4 个文件直接走内容端点", async () => {
    vi.useFakeTimers();
    const body = new Uint8Array(64).buffer;
    // /content 由同一个 fetch 通道回答；CDN 的 .bin 地址永远不给响应。
    const cdn = installCdnFetch((url) => url.includes("cdn.example")
      ? null
      : Promise.resolve(new Response(body, { status: 200 })));
    const contentCallsFor = (id: string) => cdn.calls.filter((call) =>
      call.url.includes("/content") && call.url.includes(`${id}.md`)).length;
    try {
      const client = new OneDriveClient(async () => "token");
      const download = (id: string) => client.downloadFile(
        "testVault",
        `${id}.md`,
        `https://cdn.example/${id}.bin`,
        undefined,
        64,
      );
      // 每个文件在 CDN 上等满小档主预算（15 秒）也拿不到一个响应，随后 /content 完成它。
      for (const id of ["id-a", "id-b", "id-c"]) {
        await expect(settle(download(id))).resolves.toEqual(expect.any(ArrayBuffer));
        expect(cdnCallsFor(cdn.calls, id)).toHaveLength(1);
        expect(contentCallsFor(id)).toBe(1);
      }

      // 熔断已开：第 4 个文件不再付 CDN 首包时间，但文件照样成功。
      await expect(settle(download("id-d"))).resolves.toEqual(expect.any(ArrayBuffer));
      expect(cdnCallsFor(cdn.calls, "id-d")).toHaveLength(0);
      expect(contentCallsFor("id-d")).toBe(1);
    } finally {
      cdn.restore();
    }
  });

  it("一次 CDN 成功即复位：两次失败 + 一次成功 + 两次失败后仍会再试 CDN", async () => {
    vi.useFakeTimers();
    const body = new Uint8Array(64).buffer;
    const cdn = installCdnFetch((url) => {
      if (url.includes("cdn.example")) {
        return url.includes("id-c.bin")
          ? Promise.resolve(new Response(body, { status: 200 }))
          : null;
      }
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    try {
      const client = new OneDriveClient(async () => "token");
      const download = (id: string) => client.downloadFile(
        "testVault",
        `${id}.md`,
        `https://cdn.example/${id}.bin`,
        undefined,
        64,
      );
      for (const id of ["id-a", "id-b", "id-c", "id-d", "id-e"]) {
        await expect(settle(download(id))).resolves.toEqual(expect.any(ArrayBuffer));
        expect(cdnCallsFor(cdn.calls, id)).toHaveLength(1);
      }

      // id-c 的 CDN 成功把连续失败计数清零；此后只有两次失败，不足以熔断。
      await expect(settle(download("id-f"))).resolves.toEqual(expect.any(ArrayBuffer));
      expect(cdnCallsFor(cdn.calls, "id-f")).toHaveLength(1);
    } finally {
      cdn.restore();
    }
  });

  it("内容端点 401 反向撤销熔断：被跳过 CDN 的文件撞上 401 后，下一个文件重新试 CDN", async () => {
    vi.useFakeTimers();
    const body = new Uint8Array(64).buffer;
    const cdn = installCdnFetch((url) => {
      if (url.includes("cdn.example")) return null;
      if (url.includes("id-c.md")) {
        // 熔断把文件推到 /content，而 /content 连授权都过不了：方向错了。
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    // /content 的 fetch 失败后会退到 requestUrl，那条路也给同样的答案。
    vi.spyOn(obsidian, "requestUrl").mockImplementation((request) => {
      const url = String(request.url);
      if (url.includes("id-c.md")) {
        return Promise.reject({
          status: 401,
          headers: {},
          json: { error: { code: "unauthenticated", message: "content denied" } },
        });
      }
      return Promise.resolve({ status: 200, headers: {}, arrayBuffer: body });
    });
    try {
      const client = new OneDriveClient(async () => "token");
      const download = (id: string) => client.downloadFile(
        "testVault",
        `${id}.md`,
        `https://cdn.example/${id}.bin`,
        undefined,
        64,
      ).then(() => "ok" as const, (error: unknown) => error as OneDriveError);

      for (const id of ["id-a", "id-b"]) {
        await expect(settle(download(id))).resolves.toBe("ok");
      }
      // 第三个文件把熔断推上去，随后 /content 以 401 拒绝它。
      await expect(settle(download("id-c"))).resolves.toMatchObject({
        type: OneDriveErrorType.Unauthorized,
        statusCode: 401,
      });

      // 401 撤销了熔断：下一个文件重新走 CDN 通道。
      await expect(settle(download("id-d"))).resolves.toBe("ok");
      expect(cdnCallsFor(cdn.calls, "id-d")).toHaveLength(1);
    } finally {
      cdn.restore();
    }
  });

  it("回退通道本轮已被证不可用时，小文件不再被 CDN 窗口提前收杆", async () => {
    vi.useFakeTimers();
    const body = new Uint8Array(64).buffer;
    const cdn = installCdnFetch((url) => {
      if (url.includes("slow.bin")) {
        // 慢但会成功：20 秒后才把 64 字节送到，超过小档 15 秒窗口。
        return new Promise((resolve) => {
          setTimeout(() => resolve(new Response(body, { status: 200 })), 20_000);
        });
      }
      // 其余一律 404：先把「/content 端点不可用」这条本轮事实立起来。
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.spyOn(obsidian, "requestUrl").mockImplementation((request) => {
      const url = String(request.url);
      if (url.includes("?select=")) {
        const id = /items\/([^?]+)\?select=/.exec(url)?.[1] ?? "missing";
        return Promise.resolve({
          status: 200,
          headers: {},
          json: {
            "@microsoft.graph.downloadUrl": id === "id-b"
              ? "https://cdn.example/slow.bin"
              : `https://cdn.example/${id}.bin`,
          },
        });
      }
      return Promise.reject({
        status: 404,
        headers: {},
        json: { error: { code: "itemNotFound", message: "content gone" } },
      });
    });
    try {
      const client = new OneDriveClient(async () => "token");
      // 文件 A：CDN 与两个 /content 端点全 404 ⇒ 本轮记下「内容端点不可用」。
      await expect(settle(client.downloadFile(
        "testVault",
        "id-a.md",
        undefined,
        "id-a",
        64,
      ))).rejects.toMatchObject({ statusCode: 404 });

      // 文件 B：CDN 要 20 秒。既然 /content 已被证不可用，这里必须给足预算，
      // 不能按 15 秒窗口收杆去撞一堵已知的墙。
      await expect(settle(client.downloadFile(
        "testVault",
        "id-b.md",
        undefined,
        "id-b",
        64,
      ))).resolves.toEqual(expect.any(ArrayBuffer));
      const slowCall = cdn.calls.find((call) => call.url.includes("slow.bin"));
      expect(slowCall).toBeDefined();
    } finally {
      cdn.restore();
    }
  });

  it("慢成功（小文件）：CDN 窗口到期不判失败，/content 仍拿到完整备用预算", async () => {
    vi.useFakeTimers();
    const body = new Uint8Array(40 * 1024).fill(7).buffer;
    const requests: { url: string; at: number }[] = [];
    vi.spyOn(obsidian, "requestUrl").mockImplementation((request) => {
      const url = String(request.url);
      requests.push({ url, at: Date.now() });
      if (url.includes("cdn.example")) {
        // 慢链路：窗口内一个字节都不给，但这不是「文件失败」。
        return new Promise(() => {});
      }
      // /content 在 61 秒后把整份内容送到。旧的总预算只有 63 秒，小档
      // 主预算（15s）若不把完整备用留给后续通道，这份下载就会被误杀。
      return new Promise((resolve) => {
        setTimeout(() => resolve({ status: 200, headers: {}, arrayBuffer: body }), 61_000);
      });
    });
    const client = new OneDriveClient(async () => "token");
    const startedAt = Date.now();
    const pending = client.downloadFile(
      "testVault",
      "note.md",
      "https://cdn.example/note.md",
      undefined,
      40 * 1024,
    );
    const settled = settle(pending);

    await expect(settled).resolves.toEqual(expect.any(ArrayBuffer));
    const contentRequest = requests.find((request) => request.url.includes("/content"));
    expect(contentRequest).toBeDefined();
    // 15 秒整就交棒：小档主预算生效，不是旧的 42 秒；整份下载也只在主预算 + 完整
    // 备用预算（78s）里完成，而不是被主预算单独掐死。
    const handoffMs = contentRequest!.at - startedAt;
    expect(handoffMs).toBeGreaterThanOrEqual(15_000);
    expect(handoffMs).toBeLessThan(17_000);
    expect(Date.now() - startedAt).toBeGreaterThan(60_000);
  });

  it("大文件不受通道窗口约束：5 MiB 在 CDN 上慢 100 秒也一次成功、不切通道", async () => {
    vi.useFakeTimers();
    const body = new Uint8Array(5 * 1024 * 1024).buffer;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation((request) => {
      const url = String(request.url);
      if (url.includes("cdn.example")) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ status: 200, headers: {}, arrayBuffer: body }), 100_000);
        });
      }
      throw new Error("no /content fallback expected for a regular-size file");
    });
    const client = new OneDriveClient(async () => "token");
    const pending = client.downloadFile(
      "testVault",
      "big.bin",
      "https://cdn.example/big.bin",
      undefined,
      5 * 1024 * 1024,
    );

    await expect(settle(pending)).resolves.toEqual(expect.any(ArrayBuffer));
    expect(requestSpy.mock.calls.filter(([call]) =>
      String(call.url).includes("/content"))).toHaveLength(0);
  });
});

describe("OneDriveClient.uploadFile", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records upload-session chunk fallback bytes without exposing the session URL", async () => {
    const uploadUrl = "https://upload.example/session?secret=hidden";
    vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { uploadUrl },
      })
      .mockResolvedValueOnce({
        status: 201,
        headers: {},
        json: { id: "uploaded", name: "large.bin" },
      });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    await expect(client.uploadFile(
      "testVault",
      "large.bin",
      new ArrayBuffer(10 * 1024 * 1024 + 1),
    )).resolves.toMatchObject({ id: "uploaded" });
    const summary = client.finishRunMetrics();

    expect(summary?.endpoints.uploadSessionCreate).toMatchObject({
      attempts: 1,
      succeeded: 1,
    });
    expect(summary?.endpoints.uploadSessionChunk).toMatchObject({
      attempts: 2,
      succeeded: 1,
      failed: 1,
      statusCategories: {
        network: 1,
        success: 1,
      },
    });
    const chunkMetrics = summary?.endpoints.uploadSessionChunk;
    expect(chunkMetrics?.effectiveBytes).toBeGreaterThan(0);
    expect(chunkMetrics?.retriedBytes).toBe(chunkMetrics?.effectiveBytes);
    expect(JSON.stringify(summary)).not.toContain("upload.example");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("aborts a timed-out chunk fetch, queries session state, then resumes", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const originalWindow = (globalThis as { window?: unknown }).window;
    let fetchSignal: AbortSignal | undefined;
    let putAttempts = 0;
    const fetchSpy = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ nextExpectedRanges: ["0-"] }),
        });
      }
      putAttempts++;
      if (putAttempts > 1) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ id: "uploaded", name: "large.bin" }),
        });
      }
      fetchSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { uploadUrl: "https://upload.example/session" },
    });
    const client = new OneDriveClient(async () => "token");

    try {
      const pending = client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(95_500);
      await expect(pending).resolves.toMatchObject({ id: "uploaded" });
      expect(fetchSignal?.aborted).toBe(true);
      expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(["PUT", "GET", "PUT"]);
      expect(requestSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("cancels an in-flight chunk fetch without starting fallback", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    let fetchStarted = false;
    const fetchSpy = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve({ ok: true, status: 204, json: async () => undefined });
      }
      fetchStarted = true;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { uploadUrl: "https://upload.example/session" },
    });
    const controller = new AbortController();
    const client = new OneDriveClient(async () => "token");
    client.setAbortSignal(controller.signal);

    try {
      const pending = client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      );
      await vi.waitFor(() => expect(fetchStarted).toBe(true));
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(["PUT", "DELETE"]);
    } finally {
      client.setAbortSignal(null);
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("queries session state before resuming after requestUrl status=0", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch unavailable")),
    };
    let firstChunk = true;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith(":/createUploadSession")) {
        return {
        status: 200,
        headers: {},
        json: { uploadUrl: "https://upload.example/session" },
        };
      }
      if (options.method === "GET") {
        return { status: 200, headers: {}, json: { nextExpectedRanges: ["0-"] } };
      }
      if (firstChunk) {
        firstChunk = false;
        throw Object.assign(new Error("transport result unknown"), { status: 0 });
      }
      const range = options.headers?.["Content-Range"] ?? "";
      const end = Number(range.match(/bytes \d+-(\d+)\//)?.[1] ?? -1);
      const total = Number(range.match(/\/(\d+)$/)?.[1] ?? -1);
      return end === total - 1
        ? { status: 201, headers: {}, json: { id: "uploaded", name: "large.bin" } }
        : { status: 202, headers: {}, json: { nextExpectedRanges: [`${end + 1}-`] } };
    });
    const client = new OneDriveClient(async () => "token");

    try {
      const pending = client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      );
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ id: "uploaded" });
      const sessionCalls = requestSpy.mock.calls
        .filter(([options]) => options.url === "https://upload.example/session")
        .map(([options]) => options.method);
      expect(sessionCalls.slice(0, 3)).toEqual(["PUT", "GET", "PUT"]);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("does not query or cancel while a timed-out requestUrl chunk may still be running", async () => {
    vi.useFakeTimers();
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch unavailable")),
    };
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { uploadUrl: "https://upload.example/session" },
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({ status: 204, headers: {}, json: {} });
    const client = new OneDriveClient(async () => "token");

    try {
      const pending = client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      );
      const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
        type: OneDriveErrorType.NetworkError,
      });
      await vi.advanceTimersByTimeAsync(95_000);

      await rejection;
      expect(requestSpy).toHaveBeenCalledTimes(2);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("uses session status after 416 and skips a range already received", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch unavailable")),
    };
    let firstChunk = true;
    const total = 10 * 1024 * 1024 + 1;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith(":/createUploadSession")) {
        return {
        status: 200,
        headers: {},
        json: { uploadUrl: "https://upload.example/session" },
        };
      }
      if (options.method === "GET") {
        return { status: 200, headers: {}, json: { nextExpectedRanges: [`${10 * 1024 * 1024}-`] } };
      }
      if (firstChunk) {
        firstChunk = false;
        throw {
          status: 416,
          headers: {},
          json: { error: { code: "invalidRange", message: "range already received" } },
        };
      }
      return {
        status: 201,
        headers: {},
        json: { id: "uploaded", name: "large.bin", size: total },
      };
    });
    const client = new OneDriveClient(async () => "token");

    try {
      client.beginRunMetrics();
      await expect(client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(total),
      )).resolves.toMatchObject({ id: "uploaded" });
      const summary = client.finishRunMetrics();

      const chunkRanges = requestSpy.mock.calls
        .filter(([options]) => options.method === "PUT" && options.url === "https://upload.example/session")
        .map(([options]) => options.headers?.["Content-Range"]);
      expect(chunkRanges).toEqual([
        `bytes 0-${UPLOAD_CHUNK_SLOW_BYTES - 1}/${total}`,
        `bytes ${10 * 1024 * 1024}-${total - 1}/${total}`,
      ]);
      expect(summary?.endpoints.uploadSessionChunk?.statusCategories).toMatchObject({
        rangeNotSatisfiable: 1,
      });
      expect(summary?.endpoints.uploadSessionStatus).toMatchObject({ succeeded: 1 });
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("stamps tier=uploadSession on a terminal chunk PUT failure", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch unavailable")),
    };
    const uploadUrl = "https://upload.example/session";
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith(":/createUploadSession")) {
        return {
          status: 200,
          headers: {},
          json: { uploadUrl },
        };
      }
      if (options.method === "PUT") {
        throw Object.assign(new Error("HTTP 404 Not Found"), { status: 404 });
      }
      return { status: 204, headers: {}, json: {} };
    });
    const client = new OneDriveClient(async () => "token");

    try {
      const failure = await client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OneDriveError);
      // The existing classification is unchanged; the tier is evidence only.
      expect(failure).toMatchObject({
        type: OneDriveErrorType.NotFound,
        statusCode: 404,
      });
      expect((failure as unknown as { tier?: string }).tier).toBe("uploadSession");
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("stamps tier=uploadSession when the native chunk fetch fails terminally", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(
        Object.assign(new Error("HTTP 403 Forbidden"), { status: 403 }),
      ),
    };
    const uploadUrl = "https://upload.example/session";
    vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { uploadUrl },
      })
      .mockResolvedValue({ status: 204, headers: {}, json: {} });
    const client = new OneDriveClient(async () => "token");

    try {
      const failure = await client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OneDriveError);
      expect(failure).toMatchObject({
        type: OneDriveErrorType.Forbidden,
        statusCode: 403,
      });
      expect((failure as unknown as { tier?: string }).tier).toBe("uploadSession");
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("honors upload-session Retry-After before querying status", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const originalWindow = (globalThis as { window?: unknown }).window;
    let firstPut = true;
    let statusReads = 0;
    const total = 10 * 1024 * 1024 + 1;
    const fetchSpy = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        statusReads++;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { forEach: vi.fn() },
          json: async () => ({ nextExpectedRanges: ["0-"] }),
        });
      }
      if (firstPut) {
        firstPut = false;
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { forEach: (callback: (value: string, key: string) => void) => callback("2", "retry-after") },
          json: async () => ({ error: { code: "activityLimitReached", message: "slow down" } }),
        });
      }
      const range = String((init?.headers as Record<string, string> | undefined)?.["Content-Range"] ?? "");
      const end = Number(range.match(/bytes \d+-(\d+)\//)?.[1] ?? -1);
      return Promise.resolve(end === total - 1
        ? {
          ok: true,
          status: 201,
          headers: { forEach: vi.fn() },
          json: async () => ({ id: "uploaded", name: "large.bin", size: total }),
        }
        : {
          ok: true,
          status: 202,
          headers: { forEach: vi.fn() },
          json: async () => ({ nextExpectedRanges: [`${end + 1}-`] }),
        });
    });
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { uploadUrl: "https://upload.example/session" },
    });
    const client = new OneDriveClient(async () => "token");

    try {
      const pending = client.uploadFile("testVault", "large.bin", new ArrayBuffer(total));
      await vi.advanceTimersByTimeAsync(1999);
      expect(statusReads).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toMatchObject({ id: "uploaded" });
      expect(statusReads).toBe(1);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("surfaces upload-session 507 and requests temporary-session cleanup", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch unavailable")),
    };
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith(":/createUploadSession")) {
        return {
          status: 200,
          headers: {},
          json: { uploadUrl: "https://upload.example/session" },
        };
      }
      if (options.method === "DELETE") {
        return { status: 204, headers: {}, json: {} };
      }
      throw {
        status: 507,
        headers: {},
        json: { error: { code: "quotaLimitReached", message: "storage full" } },
      };
    });
    const client = new OneDriveClient(async () => "token");

    try {
      await expect(client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      )).rejects.toMatchObject({
        type: OneDriveErrorType.InsufficientStorage,
        statusCode: 507,
      });
      expect(requestSpy.mock.calls
        .filter(([options]) => options.url === "https://upload.example/session")
        .map(([options]) => options.method)).toEqual(["PUT", "DELETE"]);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("stops when the upload session expires instead of creating a replacement session", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch unavailable")),
    };
    let createCalls = 0;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith(":/createUploadSession")) {
        createCalls++;
        return {
          status: 200,
          headers: {},
          json: { uploadUrl: "https://upload.example/session" },
        };
      }
      if (options.method === "PUT") {
        throw Object.assign(new Error("connection dropped"), { status: 0 });
      }
      throw { status: 404, headers: {}, json: { error: { code: "itemNotFound" } } };
    });
    const client = new OneDriveClient(async () => "token");

    try {
      const pending = client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(10 * 1024 * 1024 + 1),
      );
      const rejection = expect(pending).rejects.toMatchObject({
        type: OneDriveErrorType.NotFound,
        statusCode: 404,
      });
      await vi.runAllTimersAsync();

      await rejection;
      expect(createCalls).toBe(1);
      expect(requestSpy.mock.calls.some(([options]) => options.method === "GET")).toBe(true);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("does not replace a concurrent destination when final session commit conflicts", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch unavailable")),
    };
    const total = 10 * 1024 * 1024 + 1;
    let chunkCalls = 0;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith(":/createUploadSession")) {
        return {
          status: 200,
          headers: {},
          json: { uploadUrl: "https://upload.example/session" },
        };
      }
      if (options.method === "DELETE") {
        return { status: 204, headers: {}, json: {} };
      }
      chunkCalls++;
      if (chunkCalls === 1) {
        return {
          status: 202,
          headers: {},
          json: { nextExpectedRanges: [`${10 * 1024 * 1024}-`] },
        };
      }
      throw {
        status: 409,
        headers: {},
        json: { error: { code: "nameAlreadyExists", message: "destination changed" } },
      };
    });
    const client = new OneDriveClient(async () => "token");

    try {
      await expect(client.uploadFile(
        "testVault",
        "large.bin",
        new ArrayBuffer(total),
      )).rejects.toMatchObject({
        type: OneDriveErrorType.Conflict,
        statusCode: 409,
      });
      expect(requestSpy.mock.calls
        .filter(([options]) => options.url.endsWith(":/createUploadSession")))
        .toHaveLength(1);
      expect(requestSpy.mock.calls.at(-1)?.[0].method).toBe("DELETE");
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("uses a single upload session with 320 KiB-aligned chunks above 10 MiB", async () => {
    const total = 10 * 1024 * 1024 + 1;
    const content = new ArrayBuffer(total);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(
      async (options) => {
        if (options.url.endsWith(":/createUploadSession")) {
          return {
            status: 200,
            headers: {},
            json: { uploadUrl: "https://upload.example/session" },
          };
        }
        const range = options.headers?.["Content-Range"] ?? "";
        const end = Number(range.match(/bytes \d+-(\d+)\//)?.[1] ?? -1);
        if (end === total - 1) {
          return {
            status: 201,
            headers: {},
            json: {
              id: "large-id",
              name: "large.mp4",
              size: total,
              eTag: "large-etag",
            },
          };
        }
        return {
          status: 202,
          headers: {},
          json: { nextExpectedRanges: [`${end + 1}-`] },
        };
      },
    );
    const client = new OneDriveClient(async () => "token");
    const progress: Array<[number, number]> = [];

    const result = await client.uploadFile(
      "testVault",
      "large.mp4",
      content,
      (uploaded, size) => progress.push([uploaded, size]),
    );

    expect(result).toMatchObject({ id: "large-id", size: total });
    const sessionCalls = requestSpy.mock.calls.filter(
      ([options]) => options.url.endsWith(":/createUploadSession"),
    );
    const chunkCalls = requestSpy.mock.calls.filter(
      ([options]) => options.url === "https://upload.example/session",
    );
    expect(sessionCalls).toHaveLength(1);
    expect(chunkCalls.length).toBeGreaterThan(1);
    expect(progress).toHaveLength(chunkCalls.length + 1);
    expect(progress[0]).toEqual([0, total]);
    expect(progress.at(-1)).toEqual([total, total]);
    for (const [options] of chunkCalls) {
      expect(options.headers?.["Content-Range"]).toMatch(
        /^bytes \d+-\d+\/\d+$/,
      );
      expect(options.headers).not.toHaveProperty("Content-Length");
      expect(options.headers).not.toHaveProperty("Authorization");
    }
  });

  it("reports start and completion for a simple upload", async () => {
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "small-id", size: 1024, eTag: "small-etag" },
    });
    const progress: Array<[number, number]> = [];
    const client = new OneDriveClient(async () => "token");

    await client.uploadFile(
      "testVault",
      "small.md",
      new ArrayBuffer(1024),
      (uploaded, total) => progress.push([uploaded, total]),
    );

    expect(progress).toEqual([[0, 1024], [1024, 1024]]);
  });

  it("gives a large simple upload a size-scaled timeout beyond the flat 15s", async () => {
    vi.useFakeTimers();
    vi.spyOn(obsidian, "requestUrl").mockImplementation(() => new Promise((resolve) => {
      // Resolve only after a slow 20s transfer: the old flat 15s deadline
      // would have cut this off; the size-scaled budget must let it finish.
      setTimeout(() => resolve({
        status: 200,
        headers: {},
        json: { id: "big-id", size: 2_579_235, eTag: "big-etag" },
      }), 20_000);
    }));
    const client = new OneDriveClient(async () => "token");

    const pending = client.uploadFile(
      "testVault",
      "big.md",
      new ArrayBuffer(2_579_235),
    );
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toMatchObject({ id: "big-id" });
    vi.useRealTimers();
  });

  it("Preflight P0 — create-only simple upload uses conflictBehavior=fail", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 201,
      headers: {},
      json: { id: "small-id", size: 1, eTag: "small-etag" },
    });
    const client = new OneDriveClient(async () => "token");

    await client.uploadFile("testVault", "new.md", new ArrayBuffer(1));

    const uploadUrl = new URL(requestSpy.mock.calls[0][0].url);
    expect(uploadUrl.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("fail");
  });

  it("Preflight P0 — create-only upload session uses conflictBehavior=fail", async () => {
    const total = 10 * 1024 * 1024 + 1;
    const client = new OneDriveClient(async () => "token");
    const requestSpy = vi.spyOn(client as any, "request").mockResolvedValue({
      status: 200,
      headers: {},
      json: { uploadUrl: "https://upload.example/session" },
    });
    vi.spyOn(client as any, "uploadChunk").mockResolvedValue({
      status: 201,
      headers: {},
      json: { id: "large-id", name: "new.bin", size: total, eTag: "large-etag" },
    });

    await client.uploadFile("testVault", "new.bin", new ArrayBuffer(total));

    expect(requestSpy.mock.calls[0][2]).toEqual({
      item: { "@microsoft.graph.conflictBehavior": "fail" },
    });
  });

  it("updates a reviewed simple upload by driveItem ID and If-Match", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "drive-id", size: 1, eTag: "etag-new" },
    });
    const client = new OneDriveClient(async () => "token");

    await client.uploadFile(
      "testVault",
      "old-path.md",
      new ArrayBuffer(1),
      undefined,
      "etag-old",
      "drive-id",
    );

    const options = requestSpy.mock.calls[0][0];
    expect(options.url).toBe("https://graph.microsoft.com/v1.0/me/drive/items/drive-id/content");
    expect(options.headers?.["If-Match"]).toBe("etag-old");
    expect(new URL(options.url).searchParams.has("@microsoft.graph.conflictBehavior")).toBe(false);
  });

  it("updates a reviewed upload session by driveItem ID and If-Match", async () => {
    const total = 10 * 1024 * 1024 + 1;
    const client = new OneDriveClient(async () => "token");
    const requestSpy = vi.spyOn(client as any, "request").mockResolvedValue({
      status: 200,
      headers: {},
      json: { uploadUrl: "https://upload.example/session" },
    });
    vi.spyOn(client as any, "uploadChunk").mockResolvedValue({
      status: 201,
      headers: {},
      json: { id: "drive-id", size: total, eTag: "etag-new" },
    });

    await client.uploadFile(
      "testVault",
      "old-path.bin",
      new ArrayBuffer(total),
      undefined,
      "etag-old",
      "drive-id",
    );

    expect(requestSpy).toHaveBeenCalledWith(
      "POST",
      "/me/drive/items/drive-id/createUploadSession",
      { item: { "@microsoft.graph.conflictBehavior": "replace" } },
      undefined,
      { extraHeaders: { "If-Match": "etag-old" } },
    );
  });
});

describe("OneDriveClient multi-range download (C Node h1 载体)", () => {
  const MIB = 1024 * 1024;
  /** 2026-10-27 桌面实测文件：单流 52.8 KB/s、双流 103–108 KB/s。 */
  const TWENTY_MIB = 20 * MIB;
  const STREAM_BYTES_20MIB = TWENTY_MIB / 8;

  function makeWindowFetchSpy(body: Uint8Array): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "Content-Length": String(body.byteLength) },
      }),
    );
  }

  function withWindowFetch(fetchSpy: ReturnType<typeof vi.fn>): () => void {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { fetch: fetchSpy };
    return () => {
      (globalThis as { window?: unknown }).window = originalWindow;
    };
  }

  it("routes large desktop downloadUrl downloads through the 8-stream start tier", async () => {
    const rangeBuffer = new Uint8Array(TWENTY_MIB).fill(7).buffer;
    const download = vi.fn().mockResolvedValue(rangeBuffer);
    const fetchSpy = makeWindowFetchSpy(new Uint8Array([1]));
    const restore = withWindowFetch(fetchSpy);
    try {
      const client = new OneDriveClient(async () => "token");
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = { download };

      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        TWENTY_MIB,
      );

      expect(download).toHaveBeenCalledTimes(1);
      const input = download.mock.calls[0][0] as {
        windows: Array<{ start: number; end: number }>;
        fileSize: number;
        url: string;
      };
      expect(input.url).toBe("https://download.example/big.bin");
      expect(input.fileSize).toBe(TWENTY_MIB);
      // 20 MiB → the adaptive start tier (G3): 8 windows of 2.5 MiB, still
      // above the 1 MiB per-stream floor.
      expect(input.windows).toHaveLength(8);
      expect(input.windows[0]).toEqual({
        start: 0,
        end: STREAM_BYTES_20MIB - 1,
      });
      expect(input.windows[7]).toEqual({
        start: 7 * STREAM_BYTES_20MIB,
        end: TWENTY_MIB - 1,
      });
      for (const window of input.windows) {
        expect(window.end - window.start + 1).toBeGreaterThanOrEqual(MIB);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toBe(rangeBuffer);
    } finally {
      restore();
    }
  });

  it("shares one adaptive tier across large files in a round and resets with the round", async () => {
    const adaptations: unknown[] = [];
    const download = vi.fn(async (input: {
      windows: unknown[];
      adaptation?: {
        recordCleanTransfer: (sample: {
          streams: number;
          bytes: number;
          elapsedMs: number;
        }) => void;
      };
    }) => {
      adaptations.push(input.adaptation);
      input.adaptation?.recordCleanTransfer({
        streams: input.windows.length,
        bytes: TWENTY_MIB,
        elapsedMs: 1_000,
      });
      return new ArrayBuffer(8);
    });
    const fetchSpy = makeWindowFetchSpy(new Uint8Array([1]));
    const restore = withWindowFetch(fetchSpy);
    try {
      const client = new OneDriveClient(async () => "token");
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = { download };
      const downloadOnce = (): Promise<ArrayBuffer> => client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        TWENTY_MIB,
      );

      await downloadOnce();
      await downloadOnce();
      const streamCounts = download.mock.calls.map(
        ([input]) => (input as { windows: unknown[] }).windows.length,
      );
      // The first file starts at 8, the second one inherits the tier the first
      // measured and probes the next rung (12) instead of starting at 8 again.
      expect(streamCounts).toEqual([8, 12]);
      expect(adaptations[0]).toBe(adaptations[1]);

      // A new round restores the conservative start tier.
      client.resetDownloadStrategy();
      await downloadOnce();
      expect(
        (download.mock.calls[2][0] as { windows: unknown[] }).windows,
      ).toHaveLength(8);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("falls back to the single-stream fetch when a 20 MiB range attempt fails", async () => {
    const fallbackBody = new Uint8Array([1, 2, 3]).buffer;
    const fetchSpy = makeWindowFetchSpy(new Uint8Array(fallbackBody));
    const restore = withWindowFetch(fetchSpy);
    try {
      const client = new OneDriveClient(async () => "token");
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = {
        download: vi.fn().mockRejectedValue(new Error("range boom")),
      };

      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        TWENTY_MIB,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(fallbackBody);
    } finally {
      restore();
    }
  });

  it("keeps the mobile-shaped single-stream path when no Node downloader exists", async () => {
    const body = new Uint8Array([4, 5]).buffer;
    const fetchSpy = makeWindowFetchSpy(new Uint8Array(body));
    const restore = withWindowFetch(fetchSpy);
    try {
      const client = new OneDriveClient(async () => "token");
      // The exact object `resolveRangeStreamDownloader()` produces off desktop
      // (no Node https): no window plan is ever requested.
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = null;

      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        TWENTY_MIB,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(body);
    } finally {
      restore();
    }
  });

  it("keeps small files on the single-stream path even with a downloader", async () => {
    const body = new Uint8Array([9]).buffer;
    const fetchSpy = makeWindowFetchSpy(new Uint8Array(body));
    const restore = withWindowFetch(fetchSpy);
    try {
      const download = vi.fn();
      const client = new OneDriveClient(async () => "token");
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = { download };

      await client.downloadFile(
        "testVault",
        "small.bin",
        "https://download.example/small.bin",
        undefined,
        1024,
      );

      expect(download).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  // ---- 回退不重下 (2026-10-28): after both multi-stream tiers fail, the
  // single-stream fallback continues at the first hole instead of byte 0 ------

  /** 16 MiB is the smallest file that arms the Range path and, split into 16
   *  streams, gives exactly 1 MiB windows (clean byte arithmetic). */
  const RANGE_FILE_BYTES = 16 * MIB;
  const RANGE_WINDOW_BYTES = RANGE_FILE_BYTES / 16;
  let sharedRangeSource: Uint8Array | null = null;

  /** Deterministic body, built once: a shifted window changes the sha256, so
   *  an assembly that resumes at the wrong offset cannot pass the check. */
  function rangeSource(): Uint8Array {
    if (sharedRangeSource === null) {
      const source = new Uint8Array(RANGE_FILE_BYTES);
      for (let index = 0; index < RANGE_FILE_BYTES; index++) {
        source[index] = (index * 31 + 7) & 0xff;
      }
      sharedRangeSource = source;
    }
    return sharedRangeSource;
  }

  interface LadderServerOptions {
    /** Windows below this index land completely. */
    intactWindows: number;
    /** Window that lands exactly half of itself on its first attempt and
     *  nothing afterwards — the "about 60% landed" shape. */
    halfLandedWindow: number | null;
  }

  interface LadderRequest {
    start: number;
    end: number;
    windowIndex: number;
    attempt: number;
  }

  /** Fake Node-https CDN for the 16→4→single ladder: serves the requested
   *  sub-range like the real 206 stream, except for the configured holes,
   *  which reject with the field transport-error shape (`aborted` /
   *  ECONNRESET) before or after their first body chunk. */
  function makeLadderServer(source: Uint8Array, options: LadderServerOptions) {
    const attempts = new Map<number, number>();
    const requests: LadderRequest[] = [];
    const https = {
      request: vi.fn(
        (
          _url: string,
          requestOptions: { headers: { Range: string } },
          callback: (response: unknown) => void,
        ) => {
          const match = /^bytes=(\d+)-(\d+)$/.exec(requestOptions.headers.Range)!;
          const start = Number(match[1]);
          const end = Number(match[2]);
          const windowIndex = Math.floor(start / RANGE_WINDOW_BYTES);
          const attempt = (attempts.get(windowIndex) ?? 0) + 1;
          attempts.set(windowIndex, attempt);
          requests.push({ start, end, windowIndex, attempt });
          const body = source.subarray(start, end + 1);
          const isPartialLanding = windowIndex === options.halfLandedWindow
            && attempt === 1;
          const isHole = windowIndex >= options.intactWindows
            && !isPartialLanding;
          const served = isPartialLanding
            ? body.subarray(0, Math.ceil(body.byteLength / 2))
            : body;
          const transportError = Object.assign(new Error("aborted"), {
            code: "ECONNRESET",
          });
          const node = {
            statusCode: 206,
            headers: {
              "content-range": `bytes ${start}-${end}/${source.byteLength}`,
            },
            destroy: vi.fn(),
            [Symbol.asyncIterator]: () => {
              let index = 0;
              return {
                next: (): Promise<IteratorResult<Uint8Array>> => {
                  if (isHole) return Promise.reject(transportError);
                  if (index === 0) {
                    index = 1;
                    return Promise.resolve({ value: served, done: false });
                  }
                  // The partial window dies right after its half window, so
                  // the first hole stays exactly half a window wide.
                  if (windowIndex >= options.intactWindows) {
                    return Promise.reject(transportError);
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

  interface ResumeFetchCall {
    range: string | null;
    status: number;
    served: number;
  }

  /** window.fetch double for the single-stream tier:
   *  - `honor`: 206 tail with its Content-Range (a CDN that exposes it);
   *  - `honor-hidden`: 206 tail without Content-Range (the renderer CORS case
   *    range-download.ts documents — the header is not exposed);
   *  - `honor-wrong-start`: 206 whose Content-Range starts at byte 0;
   *  - `ignore`: 200 with the whole file (the Range was dropped). */
  function makeResumeFetch(
    source: Uint8Array,
    mode: "honor" | "honor-hidden" | "honor-wrong-start" | "ignore",
  ) {
    const calls: ResumeFetchCall[] = [];
    const fetchSpy = vi.fn(
      (_url: unknown, init?: { headers?: Record<string, string> }) => {
        const range = init?.headers?.Range ?? null;
        if (range === null || mode === "ignore") {
          calls.push({ range, status: 200, served: source.byteLength });
          return Promise.resolve(new Response(source, {
            status: 200,
            headers: { "Content-Length": String(source.byteLength) },
          }));
        }
        const start = Number(/^bytes=(\d+)-$/.exec(range)![1]);
        calls.push({ range, status: 206, served: source.byteLength - start });
        return Promise.resolve(new Response(source.subarray(start), {
          status: 206,
          headers: {
            ...(mode === "honor-hidden"
              ? {}
              : {
                "Content-Range": mode === "honor-wrong-start"
                  ? `bytes 0-${source.byteLength - 1}/${source.byteLength}`
                  : `bytes ${start}-${source.byteLength - 1}/${source.byteLength}`,
              }),
            "Content-Length": String(source.byteLength - start),
          },
        }));
      },
    );
    return { fetchSpy, calls };
  }

  function makeDiagSpy() {
    const logs: string[] = [];
    const warnings: string[] = [];
    const diag = {
      log: (_category: string, message: string): void => { logs.push(message); },
      warn: (_category: string, message: string): void => { warnings.push(message); },
    };
    return { diag: diag as never, logs, warnings };
  }

  /** Client wired to the fake Node-https CDN with the tier pinned: these
   *  cases prove the fallback ladder's resume behavior, not the adaptive
   *  policy (range-stream-adaptation.test.ts owns that one). */
  function makeRangeClient(
    https: unknown,
    diag: unknown,
    streams: number,
  ): OneDriveClient {
    const client = new OneDriveClient(async () => "token", diag as never);
    (client as unknown as { rangeStreamDownloader: unknown })
      .rangeStreamDownloader = createRangeStreamDownloader(https as never, diag as never);
    (client as unknown as { rangeStreamAdaptation: unknown })
      .rangeStreamAdaptation = {
      plannedStreams: streams,
      planStreams: () => streams,
      nowMs: () => 0,
      recordCleanTransfer: () => {},
      recordConnectionFailure: () => {},
      recordRateLimited: () => {},
    };
    return client;
  }

  it("A: resumes the fallback at the first unlanded byte when 16 and 4 streams both fail (2026-10-28)", async () => {
    const source = rangeSource();
    const server = makeLadderServer(source, {
      intactWindows: 9,
      halfLandedWindow: 9,
    });
    const resumed = makeResumeFetch(source, "honor");
    const { diag, logs, warnings } = makeDiagSpy();
    const restore = withWindowFetch(resumed.fetchSpy);
    try {
      const client = makeRangeClient(server.https, diag, 16);
      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        RANGE_FILE_BYTES,
      );

      // Both tiers ran and both failed: 16 streams on the full pass, at most
      // four on the degraded retry.
      expect(server.requests.filter((request) => request.attempt === 1))
        .toHaveLength(16);
      const degraded = server.requests.filter((request) => request.attempt === 2);
      expect(degraded.length).toBeGreaterThan(0);
      expect(degraded.length).toBeLessThanOrEqual(4);

      // 9.5 of 16 windows landed: the single stream asks for the remaining
      // 6.5 MiB only, starting exactly at the first hole.
      const landedBytes = 9 * RANGE_WINDOW_BYTES + RANGE_WINDOW_BYTES / 2;
      expect(resumed.fetchSpy).toHaveBeenCalledTimes(1);
      expect(resumed.calls[0]).toEqual({
        range: `bytes=${landedBytes}-`,
        status: 206,
        served: RANGE_FILE_BYTES - landedBytes,
      });
      expect(resumed.calls[0].served).toBeLessThan(RANGE_FILE_BYTES);
      expect(warnings.some((message) => message.includes(
        `multi-range download failed, falling back to single stream (resume at byte ${landedBytes}, remaining ${RANGE_FILE_BYTES - landedBytes}/${RANGE_FILE_BYTES})`,
      ))).toBe(true);

      // One buffer end to end — the tail landed in the ladder's assembly — and
      // the unchanged size + sha256 check still passes.
      expect(result.byteLength).toBe(RANGE_FILE_BYTES);
      expect(await sha256Hex(result)).toBe(await sha256Hex(source.buffer));
      expect(logs.some((message) => message.includes(
        `single-stream resume landed ${RANGE_FILE_BYTES - landedBytes} byte(s) from byte ${landedBytes} (206, Content-Range bytes ${landedBytes}-${RANGE_FILE_BYTES - 1}/${RANGE_FILE_BYTES})`,
      ))).toBe(true);
    } finally {
      restore();
    }
  });

  it("A2: stitches a 206 whose Content-Range is hidden by CORS, using the length as evidence", async () => {
    // range-download.ts documents that the CDN does not expose Content-Range
    // to renderer fetch (the reason the Node carrier exists at all). A resume
    // that insisted on reading the header would never stitch in the real
    // host, so a 206 plus a body of exactly the remaining length is accepted —
    // the same contract the on-disk resume path uses; size + sha256 still
    // decide at the end.
    const source = rangeSource();
    const server = makeLadderServer(source, {
      intactWindows: 9,
      halfLandedWindow: 9,
    });
    const resumed = makeResumeFetch(source, "honor-hidden");
    const { diag, logs } = makeDiagSpy();
    const restore = withWindowFetch(resumed.fetchSpy);
    try {
      const client = makeRangeClient(server.https, diag, 16);
      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        RANGE_FILE_BYTES,
      );

      const landedBytes = 9 * RANGE_WINDOW_BYTES + RANGE_WINDOW_BYTES / 2;
      expect(resumed.fetchSpy).toHaveBeenCalledTimes(1);
      expect(resumed.calls[0]).toEqual({
        range: `bytes=${landedBytes}-`,
        status: 206,
        served: RANGE_FILE_BYTES - landedBytes,
      });
      expect(logs.some((message) => message.includes(
        `(206, Content-Range not exposed)`,
      ))).toBe(true);
      expect(result.byteLength).toBe(RANGE_FILE_BYTES);
      expect(await sha256Hex(result)).toBe(await sha256Hex(source.buffer));
    } finally {
      restore();
    }
  });

  it("B: re-downloads from byte 0 when the CDN ignores the resume Range (200)", async () => {
    const source = rangeSource();
    const server = makeLadderServer(source, {
      intactWindows: 9,
      halfLandedWindow: 9,
    });
    const resumed = makeResumeFetch(source, "ignore");
    const { diag, warnings } = makeDiagSpy();
    const restore = withWindowFetch(resumed.fetchSpy);
    try {
      const client = makeRangeClient(server.https, diag, 16);
      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        RANGE_FILE_BYTES,
      );

      const landedBytes = 9 * RANGE_WINDOW_BYTES + RANGE_WINDOW_BYTES / 2;
      // The resume was attempted, its 200 was discarded instead of being
      // stitched, and the file came back through the plain whole-file GET.
      expect(resumed.calls.map((call) => [call.range, call.status])).toEqual([
        [`bytes=${landedBytes}-`, 200],
        [null, 200],
      ]);
      expect(warnings.some((message) =>
        message.includes("single-stream resume not honored (status 200")
        && message.includes("re-downloading from byte 0"))).toBe(true);
      expect(result.byteLength).toBe(RANGE_FILE_BYTES);
      expect(await sha256Hex(result)).toBe(await sha256Hex(source.buffer));
    } finally {
      restore();
    }
  });

  it("B2: re-downloads from byte 0 when the resume 206 starts at the wrong offset", async () => {
    const source = rangeSource();
    const server = makeLadderServer(source, {
      intactWindows: 9,
      halfLandedWindow: 9,
    });
    const resumed = makeResumeFetch(source, "honor-wrong-start");
    const { diag, warnings } = makeDiagSpy();
    const restore = withWindowFetch(resumed.fetchSpy);
    try {
      const client = makeRangeClient(server.https, diag, 16);
      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        RANGE_FILE_BYTES,
      );

      const landedBytes = 9 * RANGE_WINDOW_BYTES + RANGE_WINDOW_BYTES / 2;
      // A readable start that is not our offset cannot be stitched: the body
      // is discarded and the plain whole-file GET runs instead.
      expect(resumed.calls.map((call) => [call.range, call.status])).toEqual([
        [`bytes=${landedBytes}-`, 206],
        [null, 200],
      ]);
      expect(warnings.some((message) =>
        message.includes("single-stream resume not honored (status 206")
        && message.includes(`Content-Range bytes 0-${RANGE_FILE_BYTES - 1}/${RANGE_FILE_BYTES}`)
        && message.includes("re-downloading from byte 0"))).toBe(true);
      expect(result.byteLength).toBe(RANGE_FILE_BYTES);
      expect(await sha256Hex(result)).toBe(await sha256Hex(source.buffer));
    } finally {
      restore();
    }
  });

  it("C: keeps the whole-file single stream when nothing landed (no regression)", async () => {
    const source = rangeSource();
    const server = makeLadderServer(source, {
      intactWindows: 0,
      halfLandedWindow: null,
    });
    const resumed = makeResumeFetch(source, "honor");
    const restore = withWindowFetch(resumed.fetchSpy);
    try {
      const client = makeRangeClient(server.https, undefined, 16);
      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        RANGE_FILE_BYTES,
      );

      // Every window died before its first byte: there is no prefix to keep,
      // so the fallback is exactly the pre-2026-10-28 request (no Range).
      expect(resumed.fetchSpy).toHaveBeenCalledTimes(1);
      expect(resumed.calls[0]).toEqual({
        range: null,
        status: 200,
        served: RANGE_FILE_BYTES,
      });
      expect(result.byteLength).toBe(RANGE_FILE_BYTES);
      expect(await sha256Hex(result)).toBe(await sha256Hex(source.buffer));
    } finally {
      restore();
    }
  });
});