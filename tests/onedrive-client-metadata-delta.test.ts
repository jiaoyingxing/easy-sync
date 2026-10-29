// 元数据与增量同步：run metrics、基线、V2 协议、远端仓库识别、delta continuation
// 由 tests/onedrive-client.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient, classifyRemotelySaveVaultChildren } from "../src/onedrive/client";
import {
  type DriveItem,
  OneDriveError,
  OneDriveErrorType,
  SharedSyncProtocolObservationError,
  SyntheticRequestTimeoutError,
} from "../src/onedrive/types";

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

describe("OneDriveClient.getDriveItemMetadataByIds chunk isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back per item only for the chunk whose $batch POST failed", async () => {
    const postCalls: number[] = [];
    const getCalls: string[] = [];
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      const url = String(request.url);
      if (url.endsWith("/$batch")) {
        const body = JSON.parse(String(request.body)) as {
          requests: Array<{ id: string; url: string }>;
        };
        postCalls.push(body.requests.length);
        if (body.requests.length === 20) {
          return {
            status: 400,
            headers: {},
            json: { error: { code: "invalidRequest", message: "batch rejected" } },
          } as never;
        }
        return {
          status: 200,
          headers: {},
          json: {
            responses: body.requests.map((entry) => {
              const id = decodeURIComponent(entry.url.split("/").pop()!);
              return {
                id: entry.id,
                status: 200,
                headers: {},
                body: { id, name: `${id}.md`, eTag: `etag-${id}`, file: {} },
              };
            }),
          },
        } as never;
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      getCalls.push(id);
      return {
        status: 200,
        headers: {},
        json: {
          id,
          name: `${id}.md`,
          eTag: `etag-${id}`,
          file: {},
          parentReference: { id: "files-root-id" },
        },
      } as never;
    });
    const client = new OneDriveClient(async () => "token");
    const ids = Array.from({ length: 25 }, (_, index) => `item-${index}`);

    const result = await client.getDriveItemMetadataByIds(ids, "downloadUrlRefresh");

    // Both chunks were attempted through the batch endpoint; only the failed
    // first chunk degraded to 20 individual reads (the pre-fix behavior threw
    // out of the whole call and the executor then re-read all 200 ids one by
    // one — 199 s of the 558 s measured on 2026-10-27).
    expect(postCalls).toEqual([20, 5]);
    expect(getCalls).toEqual(ids.slice(0, 20));
    expect(result.size).toBe(ids.length);
    expect(result.get("item-3")).toMatchObject({
      id: "item-3",
      eTag: "etag-item-3",
    });
    expect(result.get("item-24")).toMatchObject({ id: "item-24" });
    expect(requestSpy).toHaveBeenCalledTimes(22);
  });

  it("publishes each chunk before the next POST, and an isolated chunk still publishes its fallback reads", async () => {
    // The download URL refresh lookahead starts a chunk's downloads as soon as
    // the chunk resolves. Observer contract: publication is per chunk, in input
    // order, and a chunk whose POST failed publishes exactly its per-item
    // fallback entries (the caller's per-batch/per-file fallbacks then decide
    // that chunk only). The returned map stays the complete result.
    const publishedIds: string[][] = [];
    let batchPosts = 0;
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      const url = String(request.url);
      if (url.endsWith("/$batch")) {
        batchPosts++;
        const body = JSON.parse(String(request.body)) as {
          requests: Array<{ id: string; url: string }>;
        };
        if (batchPosts === 1) {
          return {
            status: 400,
            headers: {},
            json: { error: { code: "invalidRequest", message: "batch rejected" } },
          } as never;
        }
        return {
          status: 200,
          headers: {},
          json: {
            responses: body.requests.map((entry) => {
              const id = decodeURIComponent(entry.url.split("/").pop()!);
              return {
                id: entry.id,
                status: 200,
                headers: {},
                body: { id, name: `${id}.md`, eTag: `etag-${id}`, file: {} },
              };
            }),
          },
        } as never;
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return {
        status: 200,
        headers: {},
        json: { id, name: `${id}.md`, eTag: `etag-${id}`, file: {} },
      } as never;
    });
    const client = new OneDriveClient(async () => "token");
    const ids = Array.from({ length: 25 }, (_, index) => `item-${index}`);

    const result = await client.getDriveItemMetadataByIds(ids, "downloadUrlRefresh", {
      onChunkResolved: (chunk) => {
        publishedIds.push([...chunk.keys()]);
      },
    });

    expect(publishedIds).toEqual([ids.slice(0, 20), ids.slice(20)]);
    expect(batchPosts).toBe(2);
    expect(result.size).toBe(ids.length);
    expect(result.get("item-24")).toMatchObject({ id: "item-24" });
  });

  it("isolates a timed-out $batch POST instead of aborting the whole call", async () => {
    let perItemReads = 0;
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      if (String(request.url).endsWith("/$batch")) {
        // The field incident: the batch POST never produced an HTTP outcome
        // and the client refuses to retry a non-idempotent method.
        throw { status: 0, headers: {}, json: {} };
      }
      perItemReads++;
      return {
        status: 200,
        headers: {},
        json: { id: "item-a", name: "a.md", eTag: "etag-a", file: {} },
      } as never;
    });
    const client = new OneDriveClient(async () => "token");

    const result = await client.getDriveItemMetadataByIds(
      ["item-a"],
      "downloadUrlRefresh",
    );

    expect(perItemReads).toBe(1);
    expect(result.get("item-a")).toMatchObject({ id: "item-a", eTag: "etag-a" });
  });

  it("still aborts the whole call when the batch read is an auth failure", async () => {
    let perItemReads = 0;
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      if (String(request.url).endsWith("/$batch")) {
        return {
          status: 401,
          headers: {},
          json: { error: { code: "unauthenticated", message: "expired" } },
        } as never;
      }
      perItemReads++;
      return { status: 200, headers: {}, json: {} } as never;
    });
    const client = new OneDriveClient(async () => "token");

    await expect(
      client.getDriveItemMetadataByIds(["item-a"], "downloadUrlRefresh"),
    ).rejects.toBeInstanceOf(OneDriveError);
    expect(perItemReads).toBe(0);
  });

  it("rethrows a failed per-item fallback instead of reporting a missing item", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      const url = String(request.url);
      if (url.endsWith("/$batch")) {
        return {
          status: 400,
          headers: {},
          json: { error: { code: "invalidRequest", message: "batch rejected" } },
        } as never;
      }
      return {
        status: 400,
        headers: {},
        json: { error: { code: "generalException", message: "item read rejected" } },
      } as never;
    });
    const client = new OneDriveClient(async () => "token");

    await expect(
      client.getDriveItemMetadataByIds(["item-a"], "downloadVersionVerify"),
    ).rejects.toBeInstanceOf(OneDriveError);
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
      // Declared size over the hard cap is a standing condition, never deferred.
      kind: "declared",
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
    let settled = false;
    void result.catch(() => {}).then(() => { settled = true; });
    // 控制对象内容读取与元数据类读取同预算（METADATA_READ_TIMEOUT_MS）：
    // 8 秒不再判死，弱网下给满 30 秒才按超时终局。
    await vi.advanceTimersByTimeAsync(8000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(22_000);

    await expect(result).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
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
    let settled = false;
    void result.catch(() => {}).then(() => { settled = true; });
    // 与元数据类读取同预算（METADATA_READ_TIMEOUT_MS）：8 秒不再判死，
    // 弱网下给满 30 秒才按超时终局，仍不与 Graph content 兜底重叠。
    await vi.advanceTimersByTimeAsync(8000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(22_000);

    await expect(result).rejects.toMatchObject<
      Partial<OneDriveError>
    >({ type: OneDriveErrorType.NetworkError });
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

  it("reuses the V2 slot content within a session when the listed identity is unchanged", async () => {
    // W5 2026-10-24: protocol-v2.json is an immutable control file; every
    // round re-downloaded it because the binding-proven skip only covered
    // the V3 slot. A session cache keyed by (id, eTag) — the same Graph
    // versioning contract the V3 proof relies on — must skip the content
    // read on unchanged rounds and re-read once the eTag moves.
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
        throw new Error(`Unexpected request: ${url}`);
      });
    const client = new OneDriveClient(async () => "token");

    const first = await client.readSharedSyncProtocolObjects("testVault");
    expect(first.v2).toEqual({
      id: "protocol-v2-id",
      eTag: "protocol-v2-etag",
      content: '{"protocolVersion":2}',
    });
    const requestsAfterFirstRound = requestSpy.mock.calls.length;

    // Second round, same (id, eTag): only the directory listing; no content.
    const second = await client.readSharedSyncProtocolObjects("testVault");
    expect(second.v2).toEqual(first.v2);
    expect(requestSpy.mock.calls.length).toBe(requestsAfterFirstRound + 1);
    expect(
      requestSpy.mock.calls
        .slice(requestsAfterFirstRound)
        .some(([options]) => String(options.url).endsWith("/protocol-v2.json")),
    ).toBe(false);

    // The cache is per storage vault: the same listed identity under another
    // vault name must re-read instead of borrowing this vault's content.
    const crossVaultRequests = requestSpy.mock.calls.length;
    const otherVault = await client.readSharedSyncProtocolObjects("otherVault");
    expect(otherVault.v2).toEqual(first.v2);
    expect(
      requestSpy.mock.calls
        .slice(crossVaultRequests)
        .some(([options]) => String(options.url).endsWith("/protocol-v2.json")),
    ).toBe(true);

    // A moved eTag must fall back to a real content read.
    requestSpy.mockImplementation(async (options) => {
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
                eTag: "protocol-v2-etag-2",
                file: {},
                "@microsoft.graph.downloadUrl":
                  "https://download.example/protocol-v2.json",
              },
            ],
          },
        } as never;
      }
      if (url.endsWith("/protocol-v2.json")) {
        return {
          status: 200,
          headers: {},
          text: '{"protocolVersion":2,"rev":2}',
        } as never;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const third = await client.readSharedSyncProtocolObjects("testVault");
    expect(third.v2).toEqual({
      id: "protocol-v2-id",
      eTag: "protocol-v2-etag-2",
      content: '{"protocolVersion":2,"rev":2}',
    });
  });

  it("skips the V3 content read when the listed slot matches the expected binding identity", async () => {
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
        throw new Error(`Unexpected request: ${url}`);
      });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readSharedSyncProtocolObjects("testVault", {
      id: "protocol-v3-id",
      eTag: "protocol-v3-etag",
    })).resolves.toEqual({
      v2: {
        id: "protocol-v2-id",
        eTag: "protocol-v2-etag",
        content: '{"protocolVersion":2}',
      },
      // Binding-proven marker: the caller holding the binding substitutes the
      // canonical record bytes instead of downloading them again.
      v3: {
        id: "protocol-v3-id",
        eTag: "protocol-v3-etag",
        content: null,
      },
    });
    // Listing + V2 content only — the V3 content URL was never requested.
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls.filter(([options]) =>
      String(options.url).includes("protocol-v3.json"),
    )).toHaveLength(0);
  });

  it("keeps reading the V3 content when the listed slot drifted from the expected binding identity", async () => {
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

    await expect(client.readSharedSyncProtocolObjects("testVault", {
      id: "protocol-v3-id",
      eTag: "an-other-etag",
    })).resolves.toEqual({
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

  it("re-dispatches after a deadlined control-directory request and never reuses its late result", async () => {
    vi.useFakeTimers();
    let resolveLate: ((value: never) => void) | undefined;
    const lateRequest = new Promise<never>((resolve) => {
      resolveLate = resolve;
    });
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => lateRequest);
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    const first = client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    await vi.advanceTimersByTimeAsync(30_000);
    const { error } = await first;

    expect(error).toBeInstanceOf(SyntheticRequestTimeoutError);
    expect(error).toMatchObject({
      timeoutMs: 30_000,
    });
    expect(error).not.toHaveProperty("statusCode");
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const warningText = diag.warn.mock.calls.flat().join("\n");
    expect(warningText).toContain("local deadline");
    expect(warningText).toContain("HTTP status unavailable");
    expect(warningText).not.toContain("status=0");

    // Ownership is released at the deadline: the next round re-dispatches and
    // reads a fresh (empty) listing instead of being blocked.
    requestSpy.mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [] },
    } as never);
    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toEqual({ v2: null, v3: null });
    expect(requestSpy).toHaveBeenCalledTimes(2);

    // The stale late value still only logs; it never feeds the new observation.
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
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(diag.log).toHaveBeenCalledWith(
      "onedrive",
      "shared protocol request settled after its local deadline",
      {
        component: "directory",
        source: "late-settlement",
        outcome: "fulfilled",
      },
    );
  });

  it("re-dispatches after a deadlined control-directory request and still records its late rejection", async () => {
    vi.useFakeTimers();
    let rejectLate: ((reason: unknown) => void) | undefined;
    const lateRequest = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => lateRequest);
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    const first = client.readSharedSyncProtocolObjects("testVault").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBeInstanceOf(SyntheticRequestTimeoutError);

    requestSpy.mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [] },
    } as never);
    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toEqual({ v2: null, v3: null });
    expect(requestSpy).toHaveBeenCalledTimes(2);

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
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("re-dispatches the next round when a deadlined requestUrl never settles", async () => {
    vi.useFakeTimers();
    const neverSettling = new Promise<never>(() => {});
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementationOnce(() => neverSettling)
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
    await vi.advanceTimersByTimeAsync(30_000);
    const firstError = (await first).error;
    expect(firstError).toBeInstanceOf(SyntheticRequestTimeoutError);
    expect(firstError).toMatchObject({
      source: "deadline",
      timeoutMs: 30_000,
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // The hung request never settles, but ownership was already released at
    // the deadline — the next round re-dispatches and recovers without a
    // client restart.
    requestSpy.mockImplementationOnce(async () => ({
      status: 200,
      headers: {},
      json: { value: [] },
    }) as never);
    await expect(client.readSharedSyncProtocolObjects("testVault"))
      .resolves.toEqual({ v2: null, v3: null });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(diag.log).not.toHaveBeenCalledWith(
      "onedrive",
      "shared protocol request settled after its local deadline",
      expect.anything(),
    );
  });

  it("reports a deduplicated request as not dispatched, not as a timeout (C5-2)", async () => {
    vi.useFakeTimers();
    const hungRequest = new Promise<never>(() => {});
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(() => hungRequest);
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    void client.readSharedSyncProtocolObjects("testVault").catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const second = await client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );

    expect(second.error).toBeInstanceOf(SyntheticRequestTimeoutError);
    expect(second.error).toMatchObject({ source: "prior-request-in-flight" });
    // The dedup rejection must be observable in diagnostics as "not
    // dispatched" — not indistinguishable from a real deadline timeout.
    const logText = diag.log.mock.calls
      .map((call) => call.map((part) => JSON.stringify(part) ?? String(part)).join(" "))
      .join("\n");
    expect(logText).toContain("not dispatched");
    expect(logText).toContain("prior-request-in-flight");
    expect(requestSpy).toHaveBeenCalledTimes(1);
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
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toMatchObject({
      component: "v2",
      observationCause: expect.any(SyntheticRequestTimeoutError),
    });

    const second = await client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    expect(second.error).toBeNull();
    expect(bodyDispatches).toBe(2);

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

    // W5 2026-10-24: the third read hits the session cache — only content
    // from a deadline-clean successful read ever enters it, so a late
    // settlement ("stale-late") can never leak into a later observation
    // through the cache. The identity gate still re-reads on any eTag move.
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

  it("records the CDN failure stage, bare host and elapsed time on a slot content read transport failure", async () => {
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
        throw Object.assign(
          new Error("getaddrinfo ENOTFOUND download.example"),
          { status: 0 },
        );
      });
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    const observed = client.readSharedSyncProtocolObjects("testVault")
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    const { error } = await observed;

    expect(error).toBeInstanceOf(SharedSyncProtocolObservationError);
    expect((error as SharedSyncProtocolObservationError).observationCause)
      .toMatchObject({
        type: OneDriveErrorType.NetworkError,
        statusCode: 0,
      });
    // Directory listing plus one content request per slot; both slot reads
    // fail natively and no fallback is dispatched (observation-time binding).
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(diag.warn).toHaveBeenCalledWith(
      "onedrive",
      expect.stringContaining("request transport failed — HTTP status unavailable"),
      expect.objectContaining({
        stage: "dns",
        host: "download.example",
        component: "v2",
        elapsedMs: expect.any(Number),
      }),
    );
  });

  /** Run `body` with native fetch installed on the global window, restoring
   *  the previous value afterwards. */
  async function withNativeFetch<T>(
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    body: () => Promise<T>,
  ): Promise<T> {
    const globalScope = globalThis as { window?: unknown };
    const originalWindow = globalScope.window;
    globalScope.window = { fetch: fetchImpl };
    try {
      return await body();
    } finally {
      if (originalWindow === undefined) delete globalScope.window;
      else globalScope.window = originalWindow;
    }
  }

  function slotListing(): unknown {
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
    };
  }

  const slotProfile = {
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
  };

  it("reads slot content over native fetch and leaves requestUrl to the directory listing", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(async (options) => {
        const url = String(options.url);
        if (url.includes(".easy-sync:/children")) return slotListing() as never;
        throw new Error(`requestUrl must not carry slot content: ${url}`);
      });
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith("/protocol-v2.json")) {
        return new Response('{"protocolVersion":2}', { status: 200 });
      }
      if (url.endsWith("/protocol-v3.json")) {
        return new Response('{"protocolVersion":3}', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const client = new OneDriveClient(async () => "token");

    await withNativeFetch(fetchSpy, () =>
      expect(client.readSharedSyncProtocolObjects("testVault"))
        .resolves.toEqual(slotProfile));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to requestUrl when the native slot read fails, keeping the fetch error observable", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(async (options) => {
        const url = String(options.url);
        if (url.includes(".easy-sync:/children")) return slotListing() as never;
        if (url.endsWith("/protocol-v2.json")) {
          return { status: 200, headers: {}, text: '{"protocolVersion":2}' } as never;
        }
        if (url.endsWith("/protocol-v3.json")) {
          return { status: 200, headers: {}, text: '{"protocolVersion":3}' } as never;
        }
        throw new Error(`Unexpected requestUrl: ${url}`);
      });
    const fetchSpy = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    await withNativeFetch(fetchSpy, () =>
      expect(client.readSharedSyncProtocolObjects("testVault"))
        .resolves.toEqual(slotProfile));
    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(diag.warn).toHaveBeenCalledWith(
      "onedrive",
      expect.stringContaining(
        "shared protocol slot native fetch failed — falling back to requestUrl",
      ),
      { message: "Failed to fetch" },
    );
  });

  it("does not fall back to requestUrl when the native slot read returns an HTTP error", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(async (options) => {
        const url = String(options.url);
        if (url.includes(".easy-sync:/children")) return slotListing() as never;
        throw new Error(`requestUrl must not carry slot content: ${url}`);
      });
    const fetchSpy = vi.fn(async () => new Response("gone", { status: 404 }));
    const client = new OneDriveClient(async () => "token");

    const error = await withNativeFetch(fetchSpy, () =>
      client.readSharedSyncProtocolObjects("testVault").then(
        () => null,
        (cause: unknown) => cause,
      ));
    expect(error).toBeInstanceOf(SharedSyncProtocolObservationError);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to requestUrl when the native slot read exceeds the byte budget", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockImplementation(async (options) => {
        const url = String(options.url);
        if (url.includes(".easy-sync:/children")) return slotListing() as never;
        throw new Error(`requestUrl must not carry slot content: ${url}`);
      });
    const oversize = new Uint8Array(1024 * 1024 + 1);
    const fetchSpy = vi.fn(async () => new Response(oversize, { status: 200 }));
    const client = new OneDriveClient(async () => "token");

    const error = await withNativeFetch(fetchSpy, () =>
      client.readSharedSyncProtocolObjects("testVault").then(
        () => null,
        (cause: unknown) => cause,
      )) as SharedSyncProtocolObservationError | null;
    expect(error?.observationCause).toMatchObject({
      name: "ResponseByteBudgetError",
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("carries the redacted raw transport error into the status-0 warning", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      const url = String(options.url);
      if (url.includes(".easy-sync:/children")) return slotListing() as never;
      throw Object.assign(
        new Error(
          "net::ERR_NAME_NOT_RESOLVED https://download.example/protocol-v2.json?tempauth=secret",
        ),
        { status: 0 },
      );
    });
    const diag = { log: vi.fn(), warn: vi.fn() };
    const client = new OneDriveClient(async () => "token", diag as never);

    await client.readSharedSyncProtocolObjects("testVault").catch(() => undefined);

    const transportWarning = (diag.warn as unknown as {
      mock: { calls: Array<[string, string, unknown]> };
    }).mock.calls.find((call) =>
      call[0] === "onedrive"
      && call[1].includes("request transport failed — HTTP status unavailable")
    );
    expect(transportWarning?.[1]).toContain(
      "errorMessage=net::ERR_NAME_NOT_RESOLVED [redacted-url]",
    );
    expect(transportWarning?.[1]).not.toContain("tempauth=secret");
    expect(transportWarning?.[2]).toMatchObject({ stage: "dns", component: "v2" });
  });
});

describe("OneDriveClient.detectRemotelySaveRepository", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockDetectionPages(
    vaultDirName: string,
    vaultDirChildren: DriveItem[] = [],
  ): void {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (input) => {
      const options = input as { url: string; method?: string };
      const url = options.url;
      if (url.includes("/me/drive/root/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [{ id: "apps-id", name: "应用", folder: {} }] },
        };
      }
      if (url.includes("/drive/items/apps-id/children")) {
        return {
          status: 200,
          headers: {},
          json: {
            value: [
              { id: "es-id", name: "EasySync", folder: {}, parentReference: { id: "apps-id" } },
              { id: "rs-id", name: "remotely-save", folder: {}, parentReference: { id: "apps-id" } },
            ],
          },
        };
      }
      if (url.includes("/drive/items/rs-id/children")) {
        return {
          status: 200,
          headers: {},
          json: {
            value: [
              {
                id: "vault-dir-id",
                name: vaultDirName,
                folder: {},
                parentReference: { driveId: "drive-1", id: "rs-id" },
              },
            ],
          },
        };
      }
      if (url.includes("/drive/items/vault-dir-id/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: vaultDirChildren },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });
  }

  it("finds a paired repository through a localized Apps container", async () => {
    mockDetectionPages("我的笔记");
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectRemotelySaveRepository("我的笔记"))
      .resolves.toEqual({
        driveId: "drive-1",
        appsContainerId: "apps-id",
        remotelySaveDirId: "rs-id",
        vaultDirId: "vault-dir-id",
      });
  });

  it("still finds a repository whose vault directory holds ordinary plaintext files", async () => {
    mockDetectionPages("我的笔记", [
      {
        id: "meta-id",
        name: "_remotely-save-metadata-on-remote.json",
        parentReference: { id: "vault-dir-id" },
      },
      { id: "note-id", name: "欢迎.md", parentReference: { id: "vault-dir-id" } },
      { id: "dir-id", name: "日记", folder: {}, parentReference: { id: "vault-dir-id" } },
    ]);
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectRemotelySaveRepository("我的笔记"))
      .resolves.toEqual({
        driveId: "drive-1",
        appsContainerId: "apps-id",
        remotelySaveDirId: "rs-id",
        vaultDirId: "vault-dir-id",
      });
  });

  it("treats an end-to-end encrypted remote as absent so the adoption offer stays hidden", async () => {
    mockDetectionPages("我的笔记", [
      {
        id: "meta-id",
        name: "_remotely-save-metadata-on-remote.bin",
        parentReference: { id: "vault-dir-id" },
      },
      {
        id: "cipher-1",
        name: "KuR2xWfZbQhPn9sTaVcLmD8gY0jE1oHrAiNpT3uXw5zB7dC4fG6hJ8kM0nP2qR4s",
        parentReference: { id: "vault-dir-id" },
      },
      {
        id: "cipher-2",
        name: "pZ3vN7xDk1sLq9WbHcT2yFgJ5mR0uE8oAi4SdXw6zBnC3fV7hJ9kL1mN3pQ5rTt",
        parentReference: { id: "vault-dir-id" },
      },
    ]);
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectRemotelySaveRepository("我的笔记")).resolves.toBeNull();
  });

  it("returns null when no known Apps container exists at the drive root", async () => {
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { value: [{ id: "docs-id", name: "文档", folder: {} }] },
    });
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectRemotelySaveRepository("我的笔记")).resolves.toBeNull();
  });

  it("returns null when the vault directory name does not exactly match", async () => {
    mockDetectionPages("我的笔记-old");
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectRemotelySaveRepository("我的笔记")).resolves.toBeNull();
  });

  it("gives up with null when the root listing exceeds the page budget", async () => {
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: {
        value: [{ id: "x-id", name: "n", folder: {} }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=200&$select=id,name,folder&$skiptoken=abc",
      },
    });
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectRemotelySaveRepository("我的笔记")).resolves.toBeNull();
  });
});

describe("OneDriveClient.detectExistingEasySyncRepositories", () => {
  afterEach(() => vi.restoreAllMocks());

  function httpError(status: number, label: string): Error {
    return Object.assign(new Error(`HTTP ${status} ${label}`), { status });
  }

  function storageNameOf(name: string): string {
    try {
      const decoded = decodeURIComponent(name);
      if (decoded !== name && encodeURIComponent(decoded) === name) return name;
    } catch {
      // Not percent-encoded.
    }
    return encodeURIComponent(name);
  }

  function mockVaults(
    vaults: Array<{ name: string; slots: string[] | null }>,
    options: { sameNameProbeFailure?: boolean } = {},
  ): { requests: string[] } {
    const requests: string[] = [];
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (input) => {
      const requestOptions = input as { url: string; method?: string };
      const url = requestOptions.url;
      requests.push(url);
      if (url.includes("/me/drive/special/approot:/vaults:/children")) {
        return {
          status: 200,
          headers: {},
          json: {
            value: vaults.map((vault) => ({
              id: `dir-${vault.name}`,
              name: vault.name,
              folder: {},
            })),
          },
        };
      }
      const match = /vaults\/([^/]+)\/\.easy-sync:\/children/.exec(url);
      if (match) {
        const storage = match[1];
        const target = vaults.find(
          (vault) => storageNameOf(vault.name) === storage,
        );
        // 云端缺席与非活仓目录都是 404，与同名快通道探针看到的形态一致。
        if (!target || target.slots === null) {
          if (options.sameNameProbeFailure && !target) {
            throw httpError(500, "Server Error");
          }
          throw httpError(404, "Not Found");
        }
        return {
          status: 200,
          headers: {},
          json: {
            value: target.slots.map((slot) => ({
              id: `${target.name}-${slot}`,
              name: slot,
            })),
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    return { requests };
  }

  function controlProbes(requests: string[]): string[] {
    return requests.filter((url) => url.includes("/.easy-sync:/children"));
  }

  it("reports absence when the vaults directory does not exist", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async () => {
      throw httpError(404, "Not Found");
    });
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectExistingEasySyncRepositories("任意库"))
      .resolves.toEqual({ kind: "none" });
  });

  it("keeps only directories that carry a protocol slot, across probe batches", async () => {
    mockVaults([
      { name: "活跃库", slots: ["protocol-v3.json"] },
      { name: "死链库", slots: ["protocol-v2.json"] },
      { name: "无控制目录", slots: null },
      { name: "只有普通文件", slots: ["some-file.json"] },
      { name: "第二批活跃库", slots: ["protocol-v3.json"] },
    ]);
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectExistingEasySyncRepositories("本机库"))
      .resolves.toEqual({
        kind: "others",
        repositories: ["活跃库", "死链库", "第二批活跃库"],
      });
  });

  it("decodes legacy percent-encoded directory names and probes them verbatim", async () => {
    const legacyName = encodeURIComponent("我的笔记");
    mockVaults([{ name: legacyName, slots: ["protocol-v3.json"] }]);
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectExistingEasySyncRepositories("别的库"))
      .resolves.toEqual({ kind: "others", repositories: ["我的笔记"] });
  });

  it("short-circuits the probe batches when the cloud already holds this vault's name", async () => {
    // 同名快通道（2026-10-10 R3）：命中时只保留一次控制目录直探，不再逐仓探测
    // ——这段就是「改前后 7.1 秒 → 约 1 秒」的机制本身。
    const transport = mockVaults([
      { name: "活跃库", slots: ["protocol-v3.json"] },
      { name: "别家库", slots: ["protocol-v3.json"] },
      { name: "第三家", slots: ["protocol-v3.json"] },
      { name: "第四家", slots: ["protocol-v3.json"] },
      { name: "第五家", slots: ["protocol-v3.json"] },
    ]);
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectExistingEasySyncRepositories("活跃库"))
      .resolves.toEqual({ kind: "same-name" });
    expect(controlProbes(transport.requests)).toHaveLength(1);
  });

  it("treats a failed same-name probe as a miss and enumerates as before", async () => {
    // 快通道只做加速：探针失败（非 404）不得变成整次检测失败，也不得漏掉弹框。
    const transport = mockVaults(
      [{ name: "别家库", slots: ["protocol-v3.json"] }],
      { sameNameProbeFailure: true },
    );
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectExistingEasySyncRepositories("本机库"))
      .resolves.toEqual({ kind: "others", repositories: ["别家库"] });
    expect(controlProbes(transport.requests).length).toBeGreaterThanOrEqual(2);
  });

  it("propagates listing failures instead of reporting an empty cloud", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async () => {
      throw httpError(400, "Bad Request");
    });
    const client = new OneDriveClient(async () => "token");
    await expect(client.detectExistingEasySyncRepositories("任意库"))
      .rejects.toBeTruthy();
  });
});

describe("classifyRemotelySaveVaultChildren", () => {
  const file = (name: string): DriveItem => ({ id: name, name });
  const folder = (name: string): DriveItem => ({ id: name, name, folder: {} });

  it("keeps a directory with ordinary extensions plain", () => {
    expect(classifyRemotelySaveVaultChildren([
      file("_remotely-save-metadata-on-remote.json"),
      file("欢迎.md"),
      folder("日记"),
    ])).toBe("plain");
  });

  it("marks extensionless cipher tokens as encrypted", () => {
    expect(classifyRemotelySaveVaultChildren([
      file("_remotely-save-metadata-on-remote.bin"),
      file("KuR2xWfZbQhPn9sTaVcLmD8gY0jE1oHrAiNpT3uXw5zB7dC4fG6hJ8kM0nP2qR4s"),
      file("pZ3vN7xDk1sLq9WbHcT2yFgJ5mR0uE8oAi4SdXw6zBnC3fV7hJ9kL1mN3pQ5rTt"),
    ])).toBe("encrypted");
  });

  it("ignores Remotely Save metadata files when classifying", () => {
    expect(classifyRemotelySaveVaultChildren([
      file("_remotely-save-metadata-on-remote.json"),
      file("_remotely-save-metadata-on-remote.bin"),
    ])).toBe("plain");
  });

  it("keeps a file-less listing plain because it cannot be classified", () => {
    expect(classifyRemotelySaveVaultChildren([folder("日记")])).toBe("plain");
    expect(classifyRemotelySaveVaultChildren([])).toBe("plain");
  });

  it("stays plain when any file still carries a meaningful extension", () => {
    expect(classifyRemotelySaveVaultChildren([
      file("KuR2xWfZbQhPn9sTaVcLmD8gY0jE1oHrAiNp"),
      file("唯一笔记.md"),
    ])).toBe("plain");
  });

  it("stays plain when no file matches the cipher name shape", () => {
    expect(classifyRemotelySaveVaultChildren([
      file("LICENSE"),
      file("Makefile"),
    ])).toBe("plain");
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

  it("requests a larger first page on the self-built delta feed and leaves server continuations untouched", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=page-2";
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{ id: "a", name: "a.md", file: {} }],
          "@odata.nextLink": nextLink,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=stable",
        },
      });
    const client = new OneDriveClient(async () => "token");

    await client.getDelta("testVault");

    const deltaSelect = "id,name,size,file,folder,parentReference,lastModifiedDateTime,createdDateTime,lastModifiedBy,createdBy,eTag,cTag,@microsoft.graph.downloadUrl,deleted,specialFolder";
    expect(requestSpy.mock.calls.map(([request]) => request.url)).toEqual([
      `https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/testVault/files:/delta?$top=500&$select=${deltaSelect}`,
      nextLink,
    ]);
  });

  it("never rewrites a persisted server delta link with the page-size hint", async () => {
    const initialLink = "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=1";
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { value: [], "@odata.deltaLink": initialLink },
    });
    const client = new OneDriveClient(async () => "token");

    await client.getDelta("testVault", initialLink);

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      url: initialLink,
      method: "GET",
    }));
  });

  it("requests a larger first page on the folder-identity recovery delta", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/drives/drive-id/items/root-id/delta?token=stable",
      },
    });
    const client = new OneDriveClient(async () => "token");

    await client.getDeltaByFolderId("root/id");

    const deltaSelect = "id,name,size,file,folder,parentReference,lastModifiedDateTime,createdDateTime,lastModifiedBy,createdBy,eTag,cTag,@microsoft.graph.downloadUrl,deleted,specialFolder";
    expect(requestSpy.mock.calls.map(([request]) => request.url)).toEqual([
      `https://graph.microsoft.com/v1.0/me/drive/items/root%2Fid/delta?$top=500&$select=${deltaSelect}`,
    ]);
  });
});
