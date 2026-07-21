import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";

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
        "@odata.deltaLink": "https://graph.example/delta-2",
      },
    });
    const client = new OneDriveClient(() => new Promise((resolve) => {
      setTimeout(() => resolve("token"), 250);
    }));

    client.beginRunMetrics();
    const pending = client.getDelta("testVault", "https://graph.example/delta-1");
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
          file: {},
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
      await client.getFileMetadata("testVault", "note.md", "downloadVersionVerify");
      const summary = client.finishRunMetrics();

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
        ".obsidian/plugins/easy-sync/tmp/downloads/recording.m4a.part",
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
        ".obsidian/plugins/easy-sync/tmp/downloads/recording.m4a.part",
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
        ".obsidian/plugins/easy-sync/tmp/downloads/recording.m4a.part",
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
  afterEach(() => {
    vi.restoreAllMocks();
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
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/vaults/testVault/files")) {
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
        json: {
          id: "vault-folder-id",
          name: "testVault",
          folder: {},
          parentReference: { driveId: "drive-id" },
        },
      };
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault", { createMissing: false })).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls.every(([options]) => options.method === "GET")).toBe(true);

    requestSpy.mockClear();
    await client.initVaultScope("testVault");

    expect(requestSpy.mock.calls.some(([options]) =>
      options.method === "PUT" && options.url.endsWith("/vaults/testVault/.easy-sync")
    )).toBe(true);
  });

  it("fetches only the existing files folder metadata needed for its stable identity", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 409,
        headers: {},
        json: { error: { code: "nameAlreadyExists", message: "exists" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "vault-folder-id",
          name: "testVault",
          folder: {},
          parentReference: { driveId: "drive-id" },
        },
      })
      .mockRejectedValueOnce({
        status: 409,
        headers: {},
        json: { error: { code: "nameAlreadyExists", message: "exists" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          id: "files-root-id",
          name: "files",
          folder: {},
          parentReference: { driveId: "drive-id", id: "vault-folder-id" },
        },
      })
      .mockRejectedValueOnce({
        status: 409,
        headers: {},
        json: { error: { code: "nameAlreadyExists", message: "exists" } },
      });
    const diag = {
      log: vi.fn(),
      warn: vi.fn(),
    };
    const client = new OneDriveClient(async () => "token", diag as never);

    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });

    expect(requestSpy).toHaveBeenCalledTimes(5);
    expect(requestSpy.mock.calls[3][0]).toEqual(expect.objectContaining({
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/testVault/files",
    }));
    expect(diag.warn).not.toHaveBeenCalled();
    expect(diag.log).toHaveBeenCalledWith(
      "onedrive",
      "folder already exists (409): /me/drive/special/approot:/vaults/testVault",
    );
  });

  it("keeps encoded URLs but creates folders with their real names", async () => {
    const vaultName = "中文测试仓库";
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "folder-id", name: "folder", folder: {} },
    });
    const client = new OneDriveClient(async () => "token");

    await client.initVaultScope(vaultName);

    const createCall = requestSpy.mock.calls.find(([options]) =>
      options.method === "PUT"
      && options.url.endsWith(`/vaults/${encodeURIComponent(vaultName)}`),
    );
    expect(createCall?.[0]).toEqual(expect.objectContaining({
      body: JSON.stringify({
        name: vaultName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    }));
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
      return { status: 200, headers: {}, json: { id: "folder", name: "folder", folder: {} } };
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

  it("initializes once per session and retries after a NotFound response", async () => {
    let callCount = 0;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async () => {
      callCount++;
      if (callCount === 5) {
        throw {
          status: 404,
          headers: {},
          json: { error: { code: "itemNotFound", message: "missing" } },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { id: `item-${callCount}`, name: "folder", folder: {} },
      };
    });
    const client = new OneDriveClient(async () => "token");

    await client.initVaultScope("testVault");
    await client.initVaultScope("testVault");
    await expect(client.vaultExists("testVault")).resolves.toBe(false);
    await client.initVaultScope("testVault");

    expect(requestSpy).toHaveBeenCalledTimes(9);
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
});

describe("OneDriveClient delta continuation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a persisted absolute delta link without prefixing Graph twice", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [], "@odata.deltaLink": "https://graph.example/delta-2" },
    });
    const client = new OneDriveClient(async () => "token");

    await client.getDelta("testVault", "https://graph.example/delta-1");

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://graph.example/delta-1",
      method: "GET",
    }));
  });
});
