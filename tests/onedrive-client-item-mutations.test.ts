// 条目变更：移动、复制、改名、删除与文件夹身份变更
// 由 tests/onedrive-client.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import {
  OneDriveErrorType,
} from "../src/onedrive/types";

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

describe("OneDriveClient.copyItemById", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits for the copied item to appear in the destination", async () => {
    let childrenCalls = 0;
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (input) => {
      const options = input as { url: string; method?: string };
      if (options.method === "POST" && options.url.includes("/copy")) {
        return { status: 202, headers: { location: "https://contoso.sharepoint.com/_api/v2.0/monitor/1" }, json: null };
      }
      if (options.method === "GET" && options.url.includes("/drive/items/dest-id/children")) {
        childrenCalls++;
        return childrenCalls === 1
          ? { status: 200, headers: {}, json: { value: [] } }
          : {
              status: 200,
              headers: {},
              json: {
                value: [
                  { id: "copied-id", name: "new.md", parentReference: { id: "dest-id" } },
                ],
              },
            };
      }
      throw new Error(`unexpected request: ${options.method} ${options.url}`);
    });
    const client = new OneDriveClient(async () => "token");
    const item = await client.copyItemById("src-id", "dest-id", "new.md", {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(item.id).toBe("copied-id");
    expect(childrenCalls).toBe(2);
  });

  it("fails closed when the copy never lands in the destination", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (input) => {
      const options = input as { url: string; method?: string };
      if (options.method === "POST" && options.url.includes("/copy")) {
        return { status: 202, headers: {}, json: null };
      }
      if (options.method === "GET" && options.url.includes("/drive/items/dest-id/children")) {
        return { status: 200, headers: {}, json: { value: [] } };
      }
      throw new Error(`unexpected request: ${options.method} ${options.url}`);
    });
    const client = new OneDriveClient(async () => "token");
    await expect(client.copyItemById("src-id", "dest-id", "new.md", {
      timeoutMs: 40,
      pollIntervalMs: 5,
    })).rejects.toMatchObject({ type: OneDriveErrorType.ServerError });
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

  it("creates a vault folder by path with the same path shape uploadFile uses", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: {
        id: "folder-id",
        name: "sub",
        folder: {},
        parentReference: { id: "parent-id" },
        eTag: "folder-etag",
      },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createFolderPath("My Vault", "notes/sub"))
      .resolves.toMatchObject({ id: "folder-id" });

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining(
        "/me/drive/special/approot:/vaults/My%20Vault/files/notes/sub",
      ),
      body: JSON.stringify({
        name: "sub",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    }));
  });

  it("treats an existing vault folder (409) as already present", async () => {
    // Host error path shape (verified against the app bundle): status and
    // headers only — the response body is discarded by the host.
    vi.spyOn(obsidian, "requestUrl").mockRejectedValueOnce({
      status: 409,
      headers: {},
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createFolderPath("My Vault", "notes/sub"))
      .resolves.toBeNull();
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

  it("records the request method when a folder create hits a 409 conflict", async () => {
    const diag = { log: vi.fn(), warn: vi.fn() };
    // Host error path shape (verified against the app bundle): status and
    // headers only — the response body is discarded by the host.
    vi.spyOn(obsidian, "requestUrl").mockRejectedValueOnce({
      status: 409,
      headers: {},
    });
    const client = new OneDriveClient(async () => "token", diag as never);

    await expect(client.createFolderByParentId("parent-id", "Jack Knowledge"))
      .rejects.toMatchObject({
        type: OneDriveErrorType.Conflict,
        statusCode: 409,
      });

    expect(diag.log).toHaveBeenCalledWith(
      "onedrive",
      expect.stringContaining("requestUrl 409 — method=POST, "),
    );
  });

  it("records the method and the host body-visibility contract on an HTTP error without a body", async () => {
    const diag = { log: vi.fn(), warn: vi.fn() };
    vi.spyOn(obsidian, "requestUrl").mockRejectedValueOnce({
      status: 400,
      headers: {},
    });
    const client = new OneDriveClient(async () => "token", diag as never);

    await expect(client.createFolderByParentId("parent-id", "New Folder"))
      .rejects.toMatchObject({
        type: OneDriveErrorType.Unknown,
        statusCode: 400,
      });

    expect(diag.warn).toHaveBeenCalledWith(
      "onedrive",
      expect.stringContaining(
        "requestUrl HTTP error — method=POST, status=400, graphCode=none, graphMsg=none, graphInnerCode=none, graphRequestId=none, responseBody=absent or not JSON",
      ),
      undefined,
    );
  });
});
