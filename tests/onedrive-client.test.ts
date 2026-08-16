import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { OneDriveClient } from "../src/onedrive/client";
import {
  type DriveItem,
  OneDriveError,
  OneDriveErrorType,
  RemoteVaultScopeIdentityError,
  SharedSyncProtocolObservationError,
  SyntheticRequestTimeoutError,
} from "../src/onedrive/types";

const EASY_SYNC_TMP_DIR = getEasySyncPaths(".obsidian").tmpDir;

describe("OneDriveClient run metrics", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("separates token acquisition wait from the Graph request duration", async () => {
    vi.useFakeTimers();
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=2",
      },
    });
    const client = new OneDriveClient(() => new Promise((resolve) => {
      setTimeout(() => resolve("token"), 250);
    }));

    client.beginRunMetrics();
    const pending = client.getDelta(
      "testVault",
      "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=1",
    );
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    const summary = client.finishRunMetrics();

    expect(summary?.tokenAcquisition).toEqual({
      attempts: 1,
      elapsedMs: 250,
      maxElapsedMs: 250,
    });
    expect(summary?.endpoints.delta?.elapsedMs).toBe(0);
  });

  it("separates download URL refresh from post-download version verification", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const content = new Uint8Array([1, 2, 3]);
    (globalThis as { window?: unknown }).window = {
      fetch: vi.fn().mockResolvedValue(
        new Response(content, {
          status: 200,
          headers: { "Content-Length": String(content.byteLength) },
        }),
      ),
    };
    vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          "@microsoft.graph.downloadUrl": "https://download.example/note.md",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "file-id",
          name: "note.md",
          size: content.byteLength,
          eTag: "etag-1",
          cTag: "ctag-1",
          file: {
            hashes: {
              quickXorHash: "quickxor-1",
            },
          },
          parentReference: { id: "files-root-id" },
        },
      });
    const client = new OneDriveClient(async () => "token");
    client.restoreVaultScope(
      "testVault",
      {
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      },
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/testVault/files:/delta?token=known",
    );

    try {
      client.beginRunMetrics();
      await client.downloadFile(
        "testVault",
        "note.md",
        undefined,
        "file-id",
        content.byteLength,
      );
      const metadata = await client.getFileMetadata(
        "testVault",
        "note.md",
        "downloadVersionVerify",
      );
      const summary = client.finishRunMetrics();

      expect(metadata).toMatchObject({
        cTag: "ctag-1",
        quickXorHash: "quickxor-1",
      });
      expect(summary).toMatchObject({
        schemaVersion: 2,
        metadataReasons: {
          downloadUrlRefresh: { attempts: 1, succeeded: 1 },
          downloadVersionVerify: { attempts: 1, succeeded: 1 },
        },
      });
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });

  it("records an accepted file-metadata 404 as a successful absence check", async () => {
    vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status: 404,
      headers: {},
      json: { error: { code: "itemNotFound", message: "missing" } },
    });
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
    };
    const client = new OneDriveClient(async () => "token", diag as never);

    client.beginRunMetrics();
    await expect(client.getFileMetadata("testVault", "deleted.md")).resolves.toBeNull();
    const summary = client.finishRunMetrics();

    expect(summary?.totals).toMatchObject({
      attempts: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
    });
    expect(summary?.endpoints.metadata).toMatchObject({
      attempts: 1,
      succeeded: 1,
      failed: 0,
      statusCategories: { notFound: 1 },
    });
    expect(summary?.metadataReasons.other).toMatchObject({
      attempts: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(diag.warn).not.toHaveBeenCalled();
  });

  it("reads independent driveItem metadata through one checked Graph batch", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        responses: [
          {
            id: "1",
            status: 200,
            headers: {},
            body: {
              id: "file-a",
              name: "a.md",
              eTag: "etag-a",
              file: {},
              "@microsoft.graph.downloadUrl": "https://download.example/a",
            },
          },
          {
            id: "2",
            status: 404,
            headers: {},
            body: { error: { code: "itemNotFound", message: "missing" } },
          },
        ],
      },
    });
    const client = new OneDriveClient(async () => "token");

    const result = await client.getDriveItemMetadataByIds(
      ["file-a", "file-b", "file-a"],
      "downloadUrlRefresh",
    );

    expect(result.get("file-a")).toMatchObject({
      id: "file-a",
      eTag: "etag-a",
      "@microsoft.graph.downloadUrl": "https://download.example/a",
    });
    expect(result.get("file-b")).toBeNull();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const request = requestSpy.mock.calls[0][0];
    expect(request.url).toBe("https://graph.microsoft.com/v1.0/$batch");
    expect(JSON.parse(request.body as string)).toEqual({
      requests: [
        { id: "1", method: "GET", url: "/me/drive/items/file-a" },
        { id: "2", method: "GET", url: "/me/drive/items/file-b" },
      ],
    });
  });
});

describe("OneDriveClient.downloadFile", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      message: expect.stringContaining("4 > 3"),
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
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

    await vi.advanceTimersByTimeAsync(70_000);
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

describe("OneDriveClient.downloadBaseline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("downloads baseline through plugin-dir children downloadUrl before Graph /content", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    requestSpy
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [
            {
              id: "baseline-id",
              name: "baseline.json",
              file: {},
              "@microsoft.graph.downloadUrl": "https://download.example/baseline.json",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '{"vaultName":"test","lastSyncAt":1,"files":{}}',
      });

    const client = new OneDriveClient(async () => "token");
    const json = await client.downloadBaseline("testVault");

    expect(json).toBe('{"vaultName":"test","lastSyncAt":1,"files":{}}');
    expect(requestSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://download.example/baseline.json",
        method: "GET",
      }),
    );
  });

  it("rejects an oversized baseline from metadata before downloading its body", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        value: [{
          id: "baseline-id",
          name: "baseline.json",
          size: 64 * 1024 * 1024 + 1,
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/baseline.json",
        }],
      },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.downloadBaseline("testVault")).rejects.toMatchObject({
      name: "ResponseByteBudgetError",
      message: expect.stringContaining("Cloud baseline"),
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to direct /content when downloadUrl fetch fails", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    requestSpy
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [
            {
              id: "baseline-id",
              name: "baseline.json",
              file: {},
              "@microsoft.graph.downloadUrl": "https://download.example/baseline.json",
            },
          ],
        },
      })
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '{"vaultName":"test","lastSyncAt":2,"files":{}}',
      });

    const client = new OneDriveClient(async () => "token");
    const json = await client.downloadBaseline("testVault");

    expect(json).toBe('{"vaultName":"test","lastSyncAt":2,"files":{}}');
    expect(requestSpy).toHaveBeenCalledTimes(4);
  });

  it("does not overlap a timed-out baseline downloadUrl with Graph fallbacks", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{
            id: "baseline-id",
            name: "baseline.json",
            file: {},
            "@microsoft.graph.downloadUrl": "https://download.example/baseline.json",
          }],
        },
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({
        status: 200,
        headers: {},
        text: '{"vaultName":"test","lastSyncAt":3,"files":{}}',
      });
    const client = new OneDriveClient(async () => "token");

    const result = client.downloadBaseline("testVault");
    const rejection = expect(result).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    await vi.advanceTimersByTimeAsync(8000);

    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });
});

describe("OneDriveClient CloudBootstrapV2 CAS", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates bootstrap-v2.json with create-only conflict behavior", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: { id: "bootstrap-id", eTag: "etag-1" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createCloudBootstrapV2("testVault", "{}"))
      .resolves.toEqual({ id: "bootstrap-id", eTag: "etag-1" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining("bootstrap-v2.json:/content?@microsoft.graph.conflictBehavior=fail"),
      headers: expect.not.objectContaining({ "If-Match": expect.anything() }),
    }));
  });

  it("updates bootstrap by driveItem ID with If-Match", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { id: "bootstrap-id", eTag: "etag-2" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.updateCloudBootstrapV2("bootstrap-id", "etag-1", "{}"))
      .resolves.toEqual({ id: "bootstrap-id", eTag: "etag-2" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining("/me/drive/items/bootstrap-id/content"),
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
    }));
  });

  it("reads bootstrap content with its stable ID and eTag", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "bootstrap-id",
          name: "bootstrap-v2.json",
          eTag: "etag-1",
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/bootstrap-v2.json",
        }] },
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, text: '{"schemaVersion":2}' });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readCloudBootstrapV2("testVault")).resolves.toEqual({
      id: "bootstrap-id", eTag: "etag-1", content: '{"schemaVersion":2}',
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a timed-out bootstrap downloadUrl with Graph /content", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "bootstrap-id",
          name: "bootstrap-v2.json",
          eTag: "etag-1",
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/bootstrap-v2.json",
        }] },
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({ status: 200, headers: {}, text: '{"schemaVersion":2}' });
    const client = new OneDriveClient(async () => "token");

    const result = client.readCloudBootstrapV2("testVault");
    const rejection = expect(result).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    await vi.advanceTimersByTimeAsync(8000);

    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });
});

describe("OneDriveClient shared V2 sync protocol", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates protocol-v2.json with create-only conflict behavior", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: { id: "protocol-id", eTag: "etag-1" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createSharedSyncProtocolV2("testVault", "{}"))
      .resolves.toEqual({ id: "protocol-id", eTag: "etag-1" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining(
        "protocol-v2.json:/content?@microsoft.graph.conflictBehavior=fail",
      ),
      headers: expect.not.objectContaining({
        "If-Match": expect.anything(),
      }),
    }));
  });

  it("reads the protocol with its stable ID and eTag", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "protocol-id",
          name: "protocol-v2.json",
          eTag: "etag-1",
          file: {},
          "@microsoft.graph.downloadUrl":
            "https://download.example/protocol-v2.json",
        }] },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '{"protocolVersion":2}',
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolV2("testVault"))
      .resolves.toEqual({
        id: "protocol-id",
        eTag: "etag-1",
        content: '{"protocolVersion":2}',
      });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized protocol from metadata before downloading its body", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [{
        id: "protocol-id",
        name: "protocol-v2.json",
        size: 1024 * 1024 + 1,
        eTag: "etag-1",
        file: {},
        "@microsoft.graph.downloadUrl":
          "https://download.example/protocol-v2.json",
      }] },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolV2("testVault"))
      .rejects.toMatchObject({
        name: "ResponseByteBudgetError",
        message: expect.stringContaining("SharedSyncProtocolV2"),
      });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a timed-out protocol downloadUrl with Graph content", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "protocol-id",
          name: "protocol-v2.json",
          eTag: "etag-1",
          file: {},
          "@microsoft.graph.downloadUrl":
            "https://download.example/protocol-v2.json",
        }] },
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({
        status: 200,
        headers: {},
        text: '{"protocolVersion":2}',
      });
    const client = new OneDriveClient(async () => "token");

    const result = client.readSharedSyncProtocolV2("testVault");
    const rejection = expect(result).rejects.toMatchObject<
      Partial<OneDriveError>
    >({ type: OneDriveErrorType.NetworkError });
    await vi.advanceTimersByTimeAsync(8000);

    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("creates protocol-v3.json with create-only conflict behavior", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: { id: "protocol-v3-id", eTag: "etag-v3" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createSharedSyncProtocolV3("testVault", "{}"))
      .resolves.toEqual({ id: "protocol-v3-id", eTag: "etag-v3" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining(
        "protocol-v3.json:/content?@microsoft.graph.conflictBehavior=fail",
      ),
      headers: expect.not.objectContaining({
        "If-Match": expect.anything(),
      }),
    }));
  });

  it("reads protocol-v3.json with its stable ID and eTag", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "protocol-v3-id",
          name: "protocol-v3.json",
          eTag: "etag-v3",
          file: {},
          "@microsoft.graph.downloadUrl":
            "https://download.example/protocol-v3.json",
        }] },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '{"protocolVersion":3}',
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolV3("testVault"))
      .resolves.toEqual({
        id: "protocol-v3-id",
        eTag: "etag-v3",
        content: '{"protocolVersion":3}',
      });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("reads one V2+V3 profile from one complete control-directory observation", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(async (options) => {
        const url = String(options.url);
        if (url.includes(".easy-sync:/children")) {
          return {
            status: 200,
            headers: {},
            json: {
              value: [
                {
                  id: "protocol-v2-id",
                  name: "protocol-v2.json",
                  size: 21,
                  eTag: "protocol-v2-etag",
                  file: {},
                  "@microsoft.graph.downloadUrl":
                    "https://download.example/protocol-v2.json",
                },
                {
                  id: "protocol-v3-id",
                  name: "protocol-v3.json",
                  size: 21,
                  eTag: "protocol-v3-etag",
                  file: {},
                  "@microsoft.graph.downloadUrl":
                    "https://download.example/protocol-v3.json",
                },
              ],
            },
          } as never;
        }
        if (url.endsWith("/protocol-v2.json")) {
          return {
            status: 200,
            headers: {},
            text: '{"protocolVersion":2}',
          } as never;
        }
        if (url.endsWith("/protocol-v3.json")) {
          return {
            status: 200,
            headers: {},
            text: '{"protocolVersion":3}',
          } as never;
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toEqual({
        v2: {
          id: "protocol-v2-id",
          eTag: "protocol-v2-etag",
          content: '{"protocolVersion":2}',
        },
        v3: {
          id: "protocol-v3-id",
          eTag: "protocol-v3-etag",
          content: '{"protocolVersion":3}',
        },
      });
    expect(requestSpy.mock.calls.filter(([options]) =>
      String(options.url).includes(".easy-sync:/children")
    )).toHaveLength(1);
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining(
        "select=id,name,size,eTag,file,@microsoft.graph.downloadUrl",
      ),
    }));
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it("finishes the control-directory pagination before selecting protocol slots", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/drive/items/control-id/children?$skiptoken=next";
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(async (options) => {
        const url = String(options.url);
        if (url.includes(".easy-sync:/children")) {
          return {
            status: 200,
            headers: {},
            json: {
              value: [{
                id: "protocol-v2-id",
                name: "protocol-v2.json",
                size: 2,
                eTag: "protocol-v2-etag",
                file: {},
                "@microsoft.graph.downloadUrl":
                  "https://download.example/protocol-v2.json",
              }],
              "@odata.nextLink": nextLink,
            },
          } as never;
        }
        if (url === nextLink) {
          return {
            status: 200,
            headers: {},
            json: {
              value: [{
                id: "protocol-v3-id",
                name: "protocol-v3.json",
                size: 2,
                eTag: "protocol-v3-etag",
                file: {},
                "@microsoft.graph.downloadUrl":
                  "https://download.example/protocol-v3.json",
              }],
            },
          } as never;
        }
        if (url.endsWith("protocol-v2.json")) {
          return { status: 200, headers: {}, text: "v2" } as never;
        }
        if (url.endsWith("protocol-v3.json")) {
          return { status: 200, headers: {}, text: "v3" } as never;
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toMatchObject({
        v2: { content: "v2" },
        v3: { content: "v3" },
      });
    expect(requestSpy.mock.calls.filter(([options]) =>
      String(options.url).includes(".easy-sync:/children")
    )).toHaveLength(1);
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      url: nextLink,
    }));
  });

  it.each([
    {
      name: "duplicate fixed-name objects",
      value: [
        {
          id: "protocol-v2-a",
          name: "protocol-v2.json",
          size: 2,
          eTag: "etag-a",
          file: {},
        },
        {
          id: "protocol-v2-b",
          name: "protocol-v2.json",
          size: 2,
          eTag: "etag-b",
          file: {},
        },
      ],
    },
    {
      name: "a folder occupying a protocol slot",
      value: [{
        id: "protocol-v2-folder",
        name: "protocol-v2.json",
        size: 0,
        eTag: "etag-folder",
        folder: {},
      }],
    },
    {
      name: "a fixed file without snapshot-bound content metadata",
      value: [{
        id: "protocol-v2-incomplete",
        name: "protocol-v2.json",
        size: 2,
        eTag: "etag-incomplete",
        file: {},
      }],
    },
  ])("rejects $name without reading any body", async ({ value }) => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .rejects.toThrow(/protocol-v2\.json/i);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "a missing value array", json: {} },
    { label: "a null value array", json: { value: null } },
    {
      label: "an invalid continuation",
      json: { value: [], "@odata.nextLink": "" },
    },
  ])("rejects $label as an incomplete control-directory observation", async ({ json }) => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json,
    } as never);
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .rejects.toThrow(/directory/i);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a body 404 bound to its observed protocol slot", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{
            id: "protocol-v2-id",
            name: "protocol-v2.json",
            size: 2,
            eTag: "protocol-v2-etag",
            file: {},
            "@microsoft.graph.downloadUrl":
              "https://download.example/protocol-v2.json",
          }],
        },
      } as never)
      .mockRejectedValueOnce({
        status: 404,
        headers: {},
        json: { error: { code: "itemNotFound", message: "stale URL" } },
      });
    const client = new OneDriveClient(async () => "token");

    const error = await client.readSharedSyncProtocolObjects("testVault")
      .then(() => null, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(SharedSyncProtocolObservationError);
    expect(error).toMatchObject({
      component: "v2",
      observationCause: expect.objectContaining({
        type: OneDriveErrorType.NotFound,
        statusCode: 404,
      }),
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("bounds a timed-out control-directory request across rounds and never reuses its late result", async () => {
    vi.useFakeTimers();
    let resolveLate: ((value: never) => void) | undefined;
    const lateRequest = new Promise<never>((resolve) => {
      resolveLate = resolve;
    });
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => lateRequest)
      .mockImplementation(() => {
        throw new Error("duplicate raw request dispatched while the first is pending");
      });
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    const first = client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    await vi.advanceTimersByTimeAsync(15_000);
    const { error } = await first;

    expect(error).toBeInstanceOf(SyntheticRequestTimeoutError);
    expect(error).toMatchObject({
      timeoutMs: 15_000,
    });
    expect(error).not.toHaveProperty("statusCode");
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const warningText = diag.warn.mock.calls.flat().join("\n");
    expect(warningText).toContain("local deadline");
    expect(warningText).toContain("HTTP status unavailable");
    expect(warningText).not.toContain("status=0");

    const second = await client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (secondError: unknown) => ({ error: secondError }),
      );
    expect(second.error).toBeInstanceOf(SyntheticRequestTimeoutError);
    expect(second.error).toMatchObject({
      source: "prior-request-in-flight",
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);

    resolveLate?.({
      status: 200,
      headers: {},
      json: {
        value: [{
          id: "stale-protocol-v2-id",
          name: "protocol-v2.json",
          size: 4,
          eTag: "stale-etag",
          file: {},
          "@microsoft.graph.downloadUrl":
            "https://download.example/stale-protocol-v2.json",
        }],
      },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(diag.log).toHaveBeenCalledWith(
      "onedrive",
      "shared protocol request settled after its local deadline",
      {
        component: "directory",
        source: "late-settlement",
        outcome: "fulfilled",
      },
    );

    requestSpy.mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [] },
    } as never);
    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toEqual({ v2: null, v3: null });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("clears a timed-out control-directory owner after a handled late rejection", async () => {
    vi.useFakeTimers();
    let rejectLate: ((reason: unknown) => void) | undefined;
    const lateRequest = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => lateRequest)
      .mockImplementation(() => {
        throw new Error("duplicate raw request dispatched while the first is pending");
      });
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    const first = client.readSharedSyncProtocolObjects("testVault").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(first).resolves.toBeInstanceOf(SyntheticRequestTimeoutError);
    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .rejects.toBeInstanceOf(SyntheticRequestTimeoutError);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    rejectLate?.(new Error("late transport rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(diag.log).toHaveBeenCalledWith(
      "onedrive",
      "shared protocol request settled after its local deadline",
      {
        component: "directory",
        source: "late-settlement",
        outcome: "rejected",
      },
    );

    requestSpy.mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [] },
    } as never);
    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toEqual({ v2: null, v3: null });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("bounds a timed-out protocol-body request by slot and requires a fresh body read", async () => {
    vi.useFakeTimers();
    let resolveLateBody: ((value: never) => void) | undefined;
    const lateBody = new Promise<never>((resolve) => {
      resolveLateBody = resolve;
    });
    let bodyDispatches = 0;
    const diag = { log: vi.fn(), warn: vi.fn() };
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(async (options) => {
        const url = String(options.url);
        if (url.includes(".easy-sync:/children")) {
          return {
            status: 200,
            headers: {},
            json: {
              value: [{
                id: "protocol-v2-id",
                name: "protocol-v2.json",
                size: 13,
                eTag: "protocol-v2-etag",
                file: {},
                "@microsoft.graph.downloadUrl":
                  "https://download.example/protocol-v2.json",
              }],
            },
          } as never;
        }
        if (url.endsWith("/protocol-v2.json")) {
          bodyDispatches++;
          if (bodyDispatches === 1) return lateBody;
          return {
            status: 200,
            headers: {},
            text: "fresh-current",
          } as never;
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    const client = new OneDriveClient(async () => "token", diag as never);

    const first = client.readSharedSyncProtocolObjects("testVault").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(8000);
    await expect(first).resolves.toMatchObject({
      component: "v2",
      observationCause: expect.any(SyntheticRequestTimeoutError),
    });

    const second = await client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    expect(second.error).toMatchObject({
      component: "v2",
      observationCause: expect.any(SyntheticRequestTimeoutError),
    });
    expect(bodyDispatches).toBe(1);

    resolveLateBody?.({
      status: 200,
      headers: {},
      text: "stale-late",
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(diag.log).toHaveBeenCalledWith(
      "onedrive",
      "shared protocol request settled after its local deadline",
      {
        component: "v2",
        source: "late-settlement",
        outcome: "fulfilled",
      },
    );

    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toEqual({
        v2: {
          id: "protocol-v2-id",
          eTag: "protocol-v2-etag",
          content: "fresh-current",
        },
        v3: null,
      });
    expect(bodyDispatches).toBe(2);
    expect(requestSpy).toHaveBeenCalledTimes(5);
  });

  it("keeps a native no-response failure distinct from a synthetic local deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValue(
      Object.assign(new Error("socket closed before response"), { status: 0 }),
    );
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    const observed = client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    await vi.runAllTimersAsync();
    const { error } = await observed;

    expect(error).toBeInstanceOf(OneDriveError);
    expect(error).not.toBeInstanceOf(SyntheticRequestTimeoutError);
    expect(error).toMatchObject({
      type: OneDriveErrorType.NetworkError,
      statusCode: 0,
    });
    expect(requestSpy).toHaveBeenCalledTimes(3);
    const warningText = diag.warn.mock.calls.flat().join("\n");
    expect(warningText).toContain("request transport failed");
    expect(warningText).toContain("HTTP status unavailable");
    expect(warningText).not.toContain("status=0");
  });
});

describe("OneDriveClient community-plugin lifecycle control", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates the lifecycle record with create-only conflict behavior", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: { id: "lifecycle-id", eTag: "etag-1" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createCommunityPluginLifecycleV1("testVault", "{}"))
      .resolves.toEqual({ id: "lifecycle-id", eTag: "etag-1" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining(
        "community-plugin-lifecycle-v1.json:/content?@microsoft.graph.conflictBehavior=fail",
      ),
      headers: expect.not.objectContaining({ "If-Match": expect.anything() }),
    }));
  });

  it("updates the lifecycle record by stable ID with If-Match", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { id: "lifecycle-id", eTag: "etag-2" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.updateCommunityPluginLifecycleV1(
      "lifecycle-id",
      "etag-1",
      "{}",
    )).resolves.toEqual({ id: "lifecycle-id", eTag: "etag-2" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining("/me/drive/items/lifecycle-id/content"),
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
    }));
  });

  it("reads the lifecycle record with its stable ID and eTag", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "lifecycle-id",
          name: "community-plugin-lifecycle-v1.json",
          eTag: "etag-1",
          file: {},
          "@microsoft.graph.downloadUrl":
            "https://download.example/community-plugin-lifecycle-v1.json",
        }] },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        text: '{"schemaVersion":1}',
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readCommunityPluginLifecycleV1("testVault"))
      .resolves.toEqual({
        id: "lifecycle-id",
        eTag: "etag-1",
        content: '{"schemaVersion":1}',
      });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized lifecycle record before downloading its body", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [{
        id: "lifecycle-id",
        name: "community-plugin-lifecycle-v1.json",
        size: 8 * 1024 * 1024 + 1,
        eTag: "etag-1",
        file: {},
        "@microsoft.graph.downloadUrl":
          "https://download.example/community-plugin-lifecycle-v1.json",
      }] },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readCommunityPluginLifecycleV1("testVault"))
      .rejects.toMatchObject({
        name: "ResponseByteBudgetError",
        message: expect.stringContaining("CommunityPluginLifecycleV1"),
      });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OneDriveClient community-plugin generation objects", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates canonical parent folders and writes the immutable object create-only", async () => {
    const hash = "a".repeat(64);
    const objectPath = `community-plugin-content-v1/plugins/63616c656e646172/generations/1/objects/${hash}.bin`;
    const folderNames = [
      "community-plugin-content-v1",
      "plugins",
      "63616c656e646172",
      "generations",
      "1",
      "objects",
    ];
    let folderIndex = 0;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(
      async (options) => {
        if (options.method === "GET") {
          return {
            status: 200,
            headers: {},
            json: { id: "control-root", name: ".easy-sync", folder: {} },
          } as never;
        }
        if (typeof options.body === "string") {
          const body = JSON.parse(options.body);
          if (body.folder) {
            const index = folderIndex++;
            return {
              status: 201,
              headers: {},
              json: {
                id: `folder-${index}`,
                name: folderNames[index],
                folder: {},
                parentReference: {
                  id: index === 0 ? "control-root" : `folder-${index - 1}`,
                },
              },
            } as never;
          }
        }
        return {
          status: 201,
          headers: {},
          json: {
            id: "object-id",
            name: `${hash}.bin`,
            size: 3,
            eTag: "object-etag",
            cTag: "object-ctag",
            parentReference: { id: "folder-5" },
          },
        } as never;
      },
    );
    const client = new OneDriveClient(async () => "token");

    await expect(client.createCommunityPluginGenerationObjectV1(
      "testVault",
      objectPath,
      new Uint8Array([1, 2, 3]).buffer,
    )).resolves.toMatchObject({ id: "object-id", eTag: "object-etag" });
    expect(folderIndex).toBe(folderNames.length);
    expect(requestSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining(
        `${hash}.bin:/content?@microsoft.graph.conflictBehavior=fail`,
      ),
      body: expect.any(ArrayBuffer),
    }));
  });

  it("reads immutable bytes only by the requested driveItem identity", async () => {
    const content = new Uint8Array([4, 5, 6]).buffer;
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "object-id",
          name: "hash.bin",
          size: content.byteLength,
          eTag: "object-etag",
          cTag: "object-ctag",
          file: {},
          parentReference: { id: "parent-id" },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        arrayBuffer: content,
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readCommunityPluginGenerationObjectV1ById(
      "object-id",
      content.byteLength,
    )).resolves.toEqual({
      id: "object-id",
      name: "hash.bin",
      parentId: "parent-id",
      size: content.byteLength,
      eTag: "object-etag",
      cTag: "object-ctag",
      content,
    });
    expect(requestSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: "GET",
      url: expect.stringContaining("/me/drive/items/object-id/content"),
    }));
  });

  it("rejects noncanonical or escaping object paths before Graph", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const client = new OneDriveClient(async () => "token");

    await expect(client.createCommunityPluginGenerationObjectV1(
      "testVault",
      "community-plugin-content-v1/../protocol-v3.json",
      new ArrayBuffer(0),
    )).rejects.toThrow("path is invalid");
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

describe("OneDriveClient.moveItemById", () => {
  afterEach(() => vi.restoreAllMocks());

  it("moves by driveItem ID and destination parent ID with If-Match", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { id: "file-id", name: "new.md", eTag: "etag-2" },
    });
    const client = new OneDriveClient(async () => "token");

    await client.moveItemById("file-id", "etag-1", "new.md", "folder-id");
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PATCH",
      url: expect.stringContaining("/me/drive/items/file-id"),
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
      body: JSON.stringify({ name: "new.md", parentReference: { id: "folder-id" } }),
    }));
  });
});

describe("OneDriveClient.listFolderChildrenById", () => {
  afterEach(() => vi.restoreAllMocks());

  it("consumes every Graph page before reporting an empty-delete precondition", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/me/drive/items/folder-id/children?$skiptoken=next";
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{
            id: "child-1",
            name: "a.md",
            file: {},
            parentReference: { id: "folder-id" },
          }],
          "@odata.nextLink": nextLink,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{
            id: "child-2",
            name: "Nested",
            folder: {},
            parentReference: { id: "folder-id" },
          }],
        },
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.listFolderChildrenById("folder-id"))
      .resolves.toHaveLength(2);
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls[1][0]).toEqual(expect.objectContaining({
      method: "GET",
      url: nextLink,
    }));
  });

  it("rejects a child page that crosses the requested parent identity", async () => {
    vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        value: [{
          id: "child",
          name: "a.md",
          file: {},
          parentReference: { id: "other-folder" },
        }],
      },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.listFolderChildrenById("folder-id"))
      .rejects.toThrow("different parent identity");
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
        `bytes 0-${10 * 1024 * 1024 - 1}/${total}`,
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

describe("OneDriveClient.renameItem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Preflight P0 — remote rename uses driveItem identity and If-Match", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "drive-id", name: "new.md", eTag: "etag-new" },
    });
    const client = new OneDriveClient(async () => "token");

    await (client as any).renameItem(
      "testVault",
      "old.md",
      "new.md",
      "drive-id",
      "etag-old",
    );

    const options = requestSpy.mock.calls[0][0];
    expect(options.url).toBe(
      "https://graph.microsoft.com/v1.0/me/drive/items/drive-id",
    );
    expect(options.headers?.["If-Match"]).toBe("etag-old");
    expect(JSON.parse(String(options.body))).toEqual({ name: "new.md" });
  });
});

describe("OneDriveClient.deleteItem", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the reviewed driveItem identity with If-Match", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 204,
      headers: {},
      json: {},
    });
    const client = new OneDriveClient(async () => "token");

    await client.deleteItem("testVault", "old.md", "etag-old", "drive-id");

    const options = requestSpy.mock.calls[0][0];
    expect(options.url).toBe("https://graph.microsoft.com/v1.0/me/drive/items/drive-id");
    expect(options.headers?.["If-Match"]).toBe("etag-old");
  });
});

describe("OneDriveClient vault initialization", () => {
  const installVaultHierarchy = (options: {
    vaultName?: string;
    complete?: boolean;
    failAppRootOnce?: boolean;
    uncertainVaultsStatus?: 0 | 409;
    driveId?: string;
    createdDriveId?: string;
  } = {}) => {
    const vaultName = options.vaultName ?? "testVault";
    const driveId = options.driveId ?? "drive-id";
    const createdDriveId = options.createdDriveId ?? driveId;
    const children = new Map<string, DriveItem[]>([["app-root", []]]);
    const createdNames: string[] = [];
    let failAppRoot = options.failAppRootOnce ?? false;
    let vaultsCreateAttempts = 0;
    if (options.complete) {
      children.set("app-root", [{
        id: "vaults-root-id",
        name: "vaults",
        folder: {},
        parentReference: { id: "app-root", driveId },
      }]);
      children.set("vaults-root-id", [{
        id: "vault-folder-id",
        name: vaultName,
        folder: {},
        parentReference: { id: "vaults-root-id", driveId },
      }]);
      children.set("vault-folder-id", [
        {
          id: "files-root-id",
          name: "files",
          folder: {},
          parentReference: { id: "vault-folder-id", driveId },
        },
        {
          id: "plugin-root-id",
          name: ".easy-sync",
          folder: {},
          parentReference: { id: "vault-folder-id", driveId },
        },
      ]);
    }
    const fixedIds: Record<string, string> = {
      vaults: "vaults-root-id",
      [vaultName]: "vault-folder-id",
      files: "files-root-id",
      ".easy-sync": "plugin-root-id",
    };
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      const url = request.url;
      if (url.endsWith("/me/drive/special/approot")) {
        if (failAppRoot) {
          failAppRoot = false;
          throw {
            status: 404,
            headers: {},
            json: { error: { code: "itemNotFound", message: "missing" } },
          };
        }
        return {
          status: 200,
          headers: {},
          json: {
            id: "app-root",
            name: "EasySync",
            folder: {},
            // OneDrive Personal currently returns the legacy camel-case facet
            // even though the special endpoint itself is addressed as `approot`.
            specialFolder: { name: "appRoot" },
            parentReference: { driveId },
          },
        };
      }
      if (url.endsWith("/me/drive/special/approot:/vaults:/children")) {
        const vaults = children.get("app-root")?.find((item) => item.name === "vaults");
        if (!vaults) {
          throw {
            status: 404,
            headers: {},
            json: { error: { code: "itemNotFound", message: "missing" } },
          };
        }
        return { status: 200, headers: {}, json: { value: children.get(vaults.id) ?? [] } };
      }
      if (url.endsWith(`/vaults/${encodeURIComponent(vaultName)}/files`)) {
        return { status: 200, headers: {}, json: children.get("vault-folder-id")?.[0] };
      }
      if (url.endsWith(`/vaults/${encodeURIComponent(vaultName)}`)) {
        return { status: 200, headers: {}, json: children.get("vaults-root-id")?.[0] };
      }
      const childrenMatch = url.match(/\/me\/drive\/items\/([^/]+)\/children$/);
      if (childrenMatch) {
        const parentId = decodeURIComponent(childrenMatch[1]);
        if (request.method === "GET") {
          return { status: 200, headers: {}, json: { value: children.get(parentId) ?? [] } };
        }
        const body = JSON.parse(String(request.body)) as { name: string };
        const item: DriveItem = {
          id: fixedIds[body.name] ?? `folder-${createdNames.length + 1}`,
          name: body.name,
          folder: {},
          parentReference: { id: parentId, driveId: createdDriveId },
        };
        children.set(parentId, [...(children.get(parentId) ?? []), item]);
        children.set(item.id, []);
        createdNames.push(item.name);
        if (body.name === "vaults") {
          vaultsCreateAttempts++;
          if (options.uncertainVaultsStatus !== undefined) {
            throw {
              status: options.uncertainVaultsStatus,
              headers: {},
              json: { error: { code: "unknownOutcome", message: "read back" } },
            };
          }
        }
        return { status: 201, headers: {}, json: item };
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    });
    return {
      children,
      createdNames,
      requestSpy,
      getVaultsCreateAttempts: () => vaultsCreateAttempts,
    };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstraps an empty App Folder one parent at a time", async () => {
    const vaultName = "中文测试仓库";
    const { children, createdNames, requestSpy } = installVaultHierarchy({ vaultName });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope(vaultName)).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(createdNames).toEqual(["vaults", vaultName, "files", ".easy-sync"]);
    expect(requestSpy.mock.calls.some(([options]) => options.method === "PUT")).toBe(false);

    client.invalidateVaultScope(vaultName);
    requestSpy.mockClear();
    await expect(client.initVaultScope(vaultName)).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(requestSpy.mock.calls.some(([options]) => options.method === "POST")).toBe(false);

    children.set(
      "vault-folder-id",
      (children.get("vault-folder-id") ?? []).filter((item) => item.name !== ".easy-sync"),
    );
    client.invalidateVaultScope(vaultName);
    requestSpy.mockClear();
    await expect(client.initVaultScope(vaultName)).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(requestSpy.mock.calls.filter(([options]) => options.method === "POST"))
      .toHaveLength(1);
    expect(createdNames.at(-1)).toBe(".easy-sync");
  });

  it("accepts OneDrive Personal drive ID casing differences during bootstrap", async () => {
    const driveId = "68705950470d952b";
    const { createdNames } = installVaultHierarchy({
      driveId,
      createdDriveId: driveId.toUpperCase(),
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId,
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(createdNames).toEqual(["vaults", "testVault", "files", ".easy-sync"]);
  });

  it("keeps non-Personal drive IDs case-sensitive during bootstrap", async () => {
    installVaultHierarchy({
      driveId: "drive-id",
      createdDriveId: "DRIVE-ID",
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault"))
      .rejects.toThrow("Folder metadata is incomplete or mismatched: vaults");
  });

  it.each([
    409,
    0,
  ] as const)("adopts an exact folder after an uncertain create result (%i)", async (status) => {
    const { createdNames, getVaultsCreateAttempts } = installVaultHierarchy({
      uncertainVaultsStatus: status,
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(getVaultsCreateAttempts()).toBe(1);
    expect(createdNames).toEqual(["vaults", "testVault", "files", ".easy-sync"]);
  });

  it("restores an exact persisted scope without probing established folders", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const client = new OneDriveClient(async () => "token");
    const scope = {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };

    expect(client.restoreVaultScope(
      "testVault",
      scope,
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/testVault/files:/delta?token=known",
    )).toBe(true);
    await expect(client.initVaultScope("testVault")).resolves.toEqual(scope);

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("restores the legacy encoded storage route only when the cursor proves it", async () => {
    const vaultName = "中文测试仓库";
    const legacyName = encodeURIComponent(vaultName);
    const encodedLegacyName = encodeURIComponent(legacyName);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "uploaded-id", eTag: "etag-uploaded" },
    });
    const client = new OneDriveClient(async () => "token");

    expect(client.restoreVaultScope(
      vaultName,
      {
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      },
      `https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/${encodedLegacyName}/files:/delta?token=known`,
    )).toBe(true);
    await client.uploadFile(vaultName, "probe.md", new ArrayBuffer(1));

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0].url).toContain(
      `/vaults/${encodedLegacyName}/files/probe.md:/content`,
    );
  });

  it("restores a committed legacy route from Graph identities when no cursor is usable", async () => {
    const vaultName = "中文测试仓库";
    const legacyName = encodeURIComponent(vaultName);
    const encodedLegacyName = encodeURIComponent(legacyName);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/me/drive/items/vault-folder-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "vault-folder-id",
            name: legacyName,
            folder: {},
            parentReference: { driveId: "drive-id", id: "vaults-root-id" },
          },
        };
      }
      if (options.url.endsWith("/me/drive/items/files-root-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "files-root-id",
            name: "files",
            folder: {},
            parentReference: { driveId: "drive-id", id: "vault-folder-id" },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { id: "uploaded-id", eTag: "etag-uploaded" },
      };
    });
    const client = new OneDriveClient(async () => "token");
    const scope = {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };

    await expect(client.restoreVaultScopeByIdentity(vaultName, scope))
      .resolves.toEqual(scope);
    await client.uploadFile(vaultName, "probe.md", new ArrayBuffer(1));

    expect(requestSpy.mock.calls[2][0].url).toContain(
      `/vaults/${encodedLegacyName}/files/probe.md:/content`,
    );
  });

  it("classifies reachable committed metadata that no longer represents the files root", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/me/drive/items/vault-folder-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "vault-folder-id",
            name: "testVault",
            folder: {},
            parentReference: { driveId: "drive-id", id: "vaults-root-id" },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: {
          id: "files-root-id",
          name: "renamed-files-root",
          folder: {},
          parentReference: { driveId: "drive-id", id: "vault-folder-id" },
        },
      };
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.restoreVaultScopeByIdentity("testVault", {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    })).rejects.toMatchObject<RemoteVaultScopeIdentityError>({
      name: "RemoteVaultScopeIdentityError",
      reason: "files-root-invalid",
    });
  });

  it("refuses to restore a scope when the cursor belongs to another vault route", () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const client = new OneDriveClient(async () => "token");

    expect(client.restoreVaultScope(
      "testVault",
      {
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      },
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/other/files:/delta?token=wrong",
    )).toBe(false);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("resolves an existing vault scope with GET requests only in read-only mode", async () => {
    const { children, requestSpy } = installVaultHierarchy({ complete: true });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault", { createMissing: false })).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls.every(([options]) => options.method === "GET")).toBe(true);

    children.set(
      "vault-folder-id",
      (children.get("vault-folder-id") ?? []).filter((item) => item.name !== ".easy-sync"),
    );
    requestSpy.mockClear();
    await client.initVaultScope("testVault");

    const createCalls = requestSpy.mock.calls.filter(([options]) => options.method === "POST");
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(String(createCalls[0][0].body))).toMatchObject({ name: ".easy-sync" });
    expect(requestSpy.mock.calls.some(([options]) => options.method === "PUT")).toBe(false);
  });

  it("reuses a complete parent-identified hierarchy without mutation", async () => {
    const { requestSpy } = installVaultHierarchy({ complete: true });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });

    expect(requestSpy.mock.calls.every(([options]) => options.method === "GET")).toBe(true);
  });

  it("uses a legacy encoded vault when the canonical folder only has bootstrap files", async () => {
    const vaultName = "中文测试仓库";
    const canonical = encodeURIComponent(vaultName);
    const legacy = encodeURIComponent(canonical);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      const url = options.url;
      if (url.endsWith("/vaults:/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            { id: "canonical", name: vaultName, folder: {} },
            { id: "legacy", name: canonical, folder: {} },
          ] },
        };
      }
      if (url.includes(`/vaults/${canonical}/files/.obsidian/plugins:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "easy-sync", name: "easy-sync", folder: {} }] } };
      }
      if (url.includes(`/vaults/${canonical}/files/.obsidian:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "plugins", name: "plugins", folder: {} }] } };
      }
      if (url.includes(`/vaults/${canonical}/files:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "obsidian", name: ".obsidian", folder: {} }] } };
      }
      if (url.includes(`/vaults/${legacy}/files:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "notes", name: "Notes", folder: {} }] } };
      }
      if (url.endsWith("/me/drive/special/approot")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "app-root",
            name: "EasySync",
            folder: {},
            specialFolder: { name: "approot" },
            parentReference: { driveId: "drive-id" },
          },
        };
      }
      if (url.endsWith("/me/drive/items/app-root/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [{
            id: "vaults-root-id",
            name: "vaults",
            folder: {},
            parentReference: { id: "app-root", driveId: "drive-id" },
          }] },
        };
      }
      if (url.endsWith("/me/drive/items/vaults-root-id/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            {
              id: "canonical",
              name: vaultName,
              folder: {},
              parentReference: { id: "vaults-root-id", driveId: "drive-id" },
            },
            {
              id: "legacy",
              name: canonical,
              folder: {},
              parentReference: { id: "vaults-root-id", driveId: "drive-id" },
            },
          ] },
        };
      }
      if (url.endsWith("/me/drive/items/legacy/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            {
              id: "files-root-id",
              name: "files",
              folder: {},
              parentReference: { id: "legacy", driveId: "drive-id" },
            },
            {
              id: "plugin-root-id",
              name: ".easy-sync",
              folder: {},
              parentReference: { id: "legacy", driveId: "drive-id" },
            },
          ] },
        };
      }
      return { status: 200, headers: {}, json: { id: "uploaded", eTag: "etag" } };
    });
    const client = new OneDriveClient(async () => "token");

    await client.initVaultScope(vaultName);
    await client.uploadFile(vaultName, "probe.md", new ArrayBuffer(1));

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining(`/vaults/${legacy}/files/probe.md:/content`),
    }));
  });

  it("stops when canonical and legacy vault folders both contain sync content", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/vaults:/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            { id: "canonical", name: "中文测试仓库", folder: {} },
            { id: "legacy", name: encodeURIComponent("中文测试仓库"), folder: {} },
          ] },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { value: [{ id: "notes", name: "Notes", folder: {} }] },
      };
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("中文测试仓库")).rejects.toMatchObject({
      type: OneDriveErrorType.Conflict,
      statusCode: 409,
    });
    expect(requestSpy.mock.calls.some(([options]) => options.method === "PUT")).toBe(false);
  });

  it("does not cache a failed bootstrap and retries cleanly", async () => {
    const { requestSpy } = installVaultHierarchy({ failAppRootOnce: true });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).rejects.toMatchObject({
      type: OneDriveErrorType.NotFound,
    });
    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    const callsAfterSuccess = requestSpy.mock.calls.length;
    await client.initVaultScope("testVault");

    expect(requestSpy).toHaveBeenCalledTimes(callsAfterSuccess);
  });
});

describe("OneDriveClient request retry policy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a network error and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("summarizes endpoint attempts and retry outcomes without exposing URLs", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 503,
        headers: {},
        json: { error: { code: "serviceUnavailable", message: "down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    const pending = client.getAppFolder();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    const summary = client.finishRunMetrics();

    expect(summary).toMatchObject({
      schemaVersion: 2,
      totals: {
        attempts: 2,
        succeeded: 1,
        failed: 1,
        cancelled: 0,
        peakConcurrency: 1,
      },
      endpoints: {
        metadata: {
          attempts: 2,
          succeeded: 1,
          failed: 1,
          cancelled: 0,
          effectiveBytes: 0,
          retriedBytes: 0,
          peakConcurrency: 1,
          statusCategories: {
            serverError: 1,
            success: 1,
          },
        },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("graph.microsoft.com");
    expect(JSON.stringify(summary)).not.toContain("app-root");
  });

  it("separates logical upload bytes from bytes sent by retry attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 503,
        headers: {},
        json: { error: { code: "serviceUnavailable", message: "down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "uploaded", name: "note.md", size: 4 },
      });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    const pending = client.uploadFile("testVault", "note.md", new ArrayBuffer(4));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ id: "uploaded" });
    const summary = client.finishRunMetrics();

    expect(summary?.endpoints.simpleUpload).toMatchObject({
      attempts: 2,
      succeeded: 1,
      failed: 1,
      effectiveBytes: 4,
      retriedBytes: 4,
      statusCategories: {
        serverError: 1,
        success: 1,
      },
    });
    expect(summary?.totals).toMatchObject({
      effectiveBytes: 4,
      retriedBytes: 4,
    });
  });

  it("honors Retry-After before retrying a rate-limited request", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 429,
        headers: { "retry-after": "2" },
        json: { error: { code: "tooManyRequests", message: "slow down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "app-root", name: "EasySync", folder: {} },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    await vi.advanceTimersByTimeAsync(1999);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ id: "app-root" });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending Retry-After wait without issuing another request", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 429,
        headers: { "retry-after": "60" },
        json: { error: { code: "tooManyRequests", message: "slow down" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { id: "late-retry", name: "EasySync", folder: {} },
      });
    const controller = new AbortController();
    const client = new OneDriveClient(async () => "token");
    client.setAbortSignal(controller.signal);
    let settled = false;

    const outcome = client.getAppFolder().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { name: "AbortError" },
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 504])("stops after two retries for persistent HTTP %i", async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status,
      headers: {},
      json: { error: { code: "serviceUnavailable", message: "down" } },
    });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.ServerError,
      statusCode: status,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it("classifies 507 as insufficient OneDrive storage without retrying", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status: 507,
      headers: {},
      json: { error: { code: "quotaLimitReached", message: "storage full" } },
    });
    const client = new OneDriveClient(async () => "token");

    client.beginRunMetrics();
    await expect(client.getAppFolder()).rejects.toMatchObject({
      type: "InsufficientStorage",
      statusCode: 507,
    });
    const summary = client.finishRunMetrics();

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(summary?.endpoints.metadata?.statusCategories).toMatchObject({
      insufficientStorage: 1,
    });
  });

  it("does not overlap a timed-out uncancellable DELETE with a retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValueOnce({
        status: 404,
        headers: {},
        json: { error: { code: "itemNotFound", message: "already deleted" } },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.deleteItem("testVault", "deleted.md");
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does not immediately resend a simple upload after status=0", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce(Object.assign(new Error("transport result unknown"), { status: 0 }))
      .mockResolvedValueOnce({
        status: 201,
        headers: {},
        json: { id: "duplicate-risk", size: 4, eTag: "etag-new" },
      });
    const client = new OneDriveClient(async () => "token");

    const pending = client.uploadFile("testVault", "note.md", new ArrayBuffer(4));
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      method: "POST",
      run: (client: OneDriveClient) =>
        client.createFolderByParentId("parent-id", "created"),
    },
    {
      method: "PATCH",
      run: (client: OneDriveClient) =>
        client.renameItem("testVault", "old.md", "new.md", "file-id", "etag-1"),
    },
    {
      method: "DELETE",
      run: (client: OneDriveClient) =>
        client.deleteItem("testVault", "deleted.md", "etag-1", "file-id"),
    },
  ])("does not immediately resend a $method mutation after status=0", async ({ method, run }) => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce(Object.assign(new Error("transport result unknown"), { status: 0 }))
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "duplicate-risk",
          name: "new.md",
          parentReference: { id: "parent-id" },
          folder: {},
        },
      });
    const client = new OneDriveClient(async () => "token");

    await expect(run(client)).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({ method }));
  });
});

describe("OneDriveClient delta continuation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a persisted absolute delta link without prefixing Graph twice", async () => {
    const initialLink = "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=1";
    const nextLink = "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=2";
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [], "@odata.deltaLink": nextLink },
    });
    const client = new OneDriveClient(async () => "token");

    await client.getDelta("testVault", initialLink);

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: initialLink,
      method: "GET",
    }));
  });

  it("rejects an untrusted persisted delta link before acquiring or sending a bearer token", async () => {
    const getToken = vi.fn().mockResolvedValue("token");
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const client = new OneDriveClient(getToken);

    await expect(
      client.getDelta("testVault", "https://attacker.example/v1.0/me/drive/root/delta?token=secret"),
    ).rejects.toThrow("Blocked untrusted Microsoft Graph request");
    expect(getToken).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("rejects a same-origin continuation outside EasySync's Graph drive routes", async () => {
    const getToken = vi.fn().mockResolvedValue("token");
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const client = new OneDriveClient(getToken);

    await expect(
      client.getDelta("testVault", "https://graph.microsoft.com/v1.0/me/messages?token=secret"),
    ).rejects.toThrow("Blocked untrusted Microsoft Graph request");
    expect(getToken).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("rejects an untrusted returned continuation instead of persisting it", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        value: [],
        "@odata.deltaLink": "https://attacker.example/v1.0/me/drive/root/delta?token=secret",
      },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.getDelta("testVault")).rejects.toThrow(
      "Blocked untrusted Microsoft Graph request",
    );
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("never writes continuation secrets into diagnostics", async () => {
    vi.spyOn(obsidian, "requestUrl").mockRejectedValueOnce({
      status: 403,
      headers: {},
      json: { error: { code: "accessDenied", message: "denied" } },
    });
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);
    const deltaLink =
      "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=top-secret#fragment";

    await expect(client.getDelta("testVault", deltaLink)).rejects.toMatchObject({
      type: OneDriveErrorType.Forbidden,
    });
    const diagnostics = JSON.stringify([
      ...diag.log.mock.calls,
      ...diag.warn.mock.calls,
    ]);
    expect(diagnostics).not.toContain("top-secret");
    expect(diagnostics).not.toContain("fragment");
    expect(diagnostics).toContain("graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta");
  });

  it("starts a recovery delta from the exact folder identity and keeps pagination", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{ id: "a", name: "a.md", file: {} }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=page-2",
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{ id: "b", name: "b.md", file: {} }],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=stable",
        },
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.getDeltaByFolderId("root/id")).resolves.toEqual({
      value: [
        expect.objectContaining({ id: "a" }),
        expect.objectContaining({ id: "b" }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=stable",
    });

    expect(requestSpy.mock.calls.map(([request]) => request.url)).toEqual([
      expect.stringContaining("/me/drive/items/root%2Fid/delta"),
      "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=page-2",
    ]);
  });
});

describe("OneDriveClient folder identity mutations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a child folder through the Graph parent children endpoint", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: {
        id: "folder-id",
        name: "New Folder",
        folder: {},
        parentReference: { id: "parent/id" },
        eTag: "folder-etag",
      },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createFolderByParentId("parent/id", "New Folder"))
      .resolves.toMatchObject({
        id: "folder-id",
        parentReference: { id: "parent/id" },
      });

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      url: expect.stringContaining("/me/drive/items/parent%2Fid/children"),
      body: JSON.stringify({
        name: "New Folder",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    }));
  });

  it("rejects a create response that does not preserve the requested parent identity", async () => {
    vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: {
        id: "folder-id",
        name: "New Folder",
        folder: {},
        parentReference: { id: "different-parent" },
      },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createFolderByParentId("parent-id", "New Folder"))
      .rejects.toThrow("metadata is incomplete or mismatched");
  });
});
