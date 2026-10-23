// 传输：下载、上传与多段范围下载
// 由 tests/onedrive-client.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as obsidian from "obsidian";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { OneDriveClient } from "../src/onedrive/client";
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
  const SIXTEEN_MIB = 16 * MIB;

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

  it("routes large downloadUrl downloads through the range downloader", async () => {
    const rangeBuffer = new Uint8Array(SIXTEEN_MIB).fill(7).buffer;
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
        SIXTEEN_MIB,
      );

      expect(download).toHaveBeenCalledTimes(1);
      const input = download.mock.calls[0][0] as {
        windows: Array<{ start: number; end: number }>;
        fileSize: number;
        url: string;
      };
      expect(input.url).toBe("https://download.example/big.bin");
      expect(input.fileSize).toBe(SIXTEEN_MIB);
      expect(input.windows).toEqual([
        { start: 0, end: 8 * MIB - 1 },
        { start: 8 * MIB, end: SIXTEEN_MIB - 1 },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toBe(rangeBuffer);
    } finally {
      restore();
    }
  });

  it("falls back to the single-stream fetch when the range attempt fails", async () => {
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
        SIXTEEN_MIB,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(fallbackBody);
    } finally {
      restore();
    }
  });

  it("keeps the single-stream path when no Node downloader is available", async () => {
    const body = new Uint8Array([4, 5]).buffer;
    const fetchSpy = makeWindowFetchSpy(new Uint8Array(body));
    const restore = withWindowFetch(fetchSpy);
    try {
      const client = new OneDriveClient(async () => "token");
      (client as unknown as { rangeStreamDownloader: unknown })
        .rangeStreamDownloader = null;

      const result = await client.downloadFile(
        "testVault",
        "big.bin",
        "https://download.example/big.bin",
        undefined,
        SIXTEEN_MIB,
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
});
