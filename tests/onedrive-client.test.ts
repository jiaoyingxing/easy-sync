import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";

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

      expect(result).toEqual({ size: content.byteLength, hash: expectedHash });
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
});

describe("OneDriveClient.uploadFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a single upload session with 320 KiB-aligned chunks above 50 MB", async () => {
    const total = 50 * 1024 * 1024 + 1;
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
});

describe("OneDriveClient vault initialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not re-fetch metadata when bootstrap folders already exist", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockRejectedValueOnce({
        status: 409,
        headers: {},
        json: { error: { code: "nameAlreadyExists", message: "exists" } },
      })
      .mockRejectedValueOnce({
        status: 409,
        headers: {},
        json: { error: { code: "nameAlreadyExists", message: "exists" } },
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

    await client.initVaultDirectories("testVault");

    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(diag.warn).not.toHaveBeenCalled();
    expect(diag.log).toHaveBeenCalledWith(
      "onedrive",
      "folder already exists (409): /me/drive/special/approot:/vaults/testVault",
    );
    expect(diag.log).not.toHaveBeenCalledWith(
      "onedrive",
      expect.stringContaining("re-fetching"),
    );
  });

  it("keeps encoded URLs but creates folders with their real names", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "folder-id", name: "folder", folder: {} },
    });
    const client = new OneDriveClient(async () => "token");

    await client.initVaultDirectories("安卓手机测试仓库");

    const createCall = requestSpy.mock.calls.find(([options]) =>
      options.method === "PUT"
      && options.url.endsWith("/vaults/%E5%AE%89%E5%8D%93%E6%89%8B%E6%9C%BA%E6%B5%8B%E8%AF%95%E4%BB%93%E5%BA%93"),
    );
    expect(createCall?.[0]).toEqual(expect.objectContaining({
      body: JSON.stringify({
        name: "安卓手机测试仓库",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    }));
  });

  it("uses a legacy encoded vault when the canonical folder only has bootstrap files", async () => {
    const canonical = "%E5%AE%89%E5%8D%93%E6%89%8B%E6%9C%BA%E6%B5%8B%E8%AF%95%E4%BB%93%E5%BA%93";
    const legacy = "%25E5%25AE%2589%25E5%258D%2593%25E6%2589%258B%25E6%259C%25BA%25E6%25B5%258B%25E8%25AF%2595%25E4%25BB%2593%25E5%25BA%2593";
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      const url = options.url;
      if (url.endsWith("/vaults:/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            { id: "canonical", name: "安卓手机测试仓库", folder: {} },
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

    await client.initVaultDirectories("安卓手机测试仓库");
    await client.uploadFile("安卓手机测试仓库", "probe.md", new ArrayBuffer(1));

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
            { id: "canonical", name: "安卓手机测试仓库", folder: {} },
            { id: "legacy", name: encodeURIComponent("安卓手机测试仓库"), folder: {} },
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

    await expect(client.initVaultDirectories("安卓手机测试仓库")).rejects.toMatchObject({
      type: OneDriveErrorType.Conflict,
      statusCode: 409,
    });
    expect(requestSpy.mock.calls.some(([options]) => options.method === "PUT")).toBe(false);
  });

  it("initializes once per session and retries after a NotFound response", async () => {
    let callCount = 0;
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async () => {
      callCount++;
      if (callCount === 4) {
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

    await client.initVaultDirectories("testVault");
    await client.initVaultDirectories("testVault");
    await expect(client.vaultExists("testVault")).resolves.toBe(false);
    await client.initVaultDirectories("testVault");

    expect(requestSpy).toHaveBeenCalledTimes(7);
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

  it("stops after two retries for a persistent server error", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status: 503,
      headers: {},
      json: { error: { code: "serviceUnavailable", message: "down" } },
    });
    const client = new OneDriveClient(async () => "token");

    const pending = client.getAppFolder();
    const rejection = expect(pending).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.ServerError,
      statusCode: 503,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it("treats a 404 after a timed-out DELETE retry as success", async () => {
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
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(requestSpy).toHaveBeenCalledTimes(2);
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
