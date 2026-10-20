// 云端回收站恢复（`OneDriveClient.restoreDeletedDriveItemById`）：
// URL／方法／不带请求体；2xx 一律当成功（真机实测 200 带响应体，204 同样接受）；
// 失败按既有 `OneDriveError` 分类抛出，且不重试（恢复没有幂等保证）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";

const ITEM_ID = "deleted-note-id";
const RESTORE_URL =
  `https://graph.microsoft.com/v1.0/me/drive/items/${ITEM_ID}/restore`;

function graphResponse(overrides: Record<string, unknown>) {
  return {
    status: 200,
    headers: {},
    json: null,
    text: "",
    arrayBuffer: new ArrayBuffer(0),
    ...overrides,
  } as never;
}

async function spyRequestUrl() {
  const obsidian = await import("obsidian");
  return vi.spyOn(obsidian, "requestUrl");
}

describe("OneDriveClient.restoreDeletedDriveItemById", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the restore endpoint without a body and accepts the host's 204", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy.mockResolvedValue(graphResponse({ status: 204 }));
    const client = new OneDriveClient(async () => "token");

    await expect(client.restoreDeletedDriveItemById(ITEM_ID))
      .resolves.toBeUndefined();

    expect(requestSpy.mock.calls.map((call) => call[0])).toEqual([{
      url: RESTORE_URL,
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: undefined,
      contentType: undefined,
      throw: false,
    }]);
  });

  it("accepts the personal-account 200 answer with a body", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy.mockResolvedValue(graphResponse({
      status: 200,
      json: { id: ITEM_ID, name: "note.md" },
    }));
    const client = new OneDriveClient(async () => "token");

    await expect(client.restoreDeletedDriveItemById(ITEM_ID))
      .resolves.toBeUndefined();

    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 404 as the client's NotFound classification, without retrying", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy.mockResolvedValue(graphResponse({
      status: 404,
      json: { error: { code: "itemNotFound", message: "no such item" } },
    }));
    const client = new OneDriveClient(async () => "token");

    const failure = await client.restoreDeletedDriveItemById(ITEM_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OneDriveError);
    expect((failure as OneDriveError).type).toBe(OneDriveErrorType.NotFound);
    expect((failure as OneDriveError).statusCode).toBe(404);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 409 as a conflict, without retrying", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy.mockResolvedValue(graphResponse({
      status: 409,
      json: { error: { code: "nameAlreadyExists", message: "exists" } },
    }));
    const client = new OneDriveClient(async () => "token");

    const failure = await client.restoreDeletedDriveItemById(ITEM_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OneDriveError);
    expect((failure as OneDriveError).type).toBe(OneDriveErrorType.Conflict);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("does not loop on a server error: one call, then the failure stands", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy.mockResolvedValue(graphResponse({ status: 500 }));
    const client = new OneDriveClient(async () => "token");

    const failure = await client.restoreDeletedDriveItemById(ITEM_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OneDriveError);
    expect((failure as OneDriveError).type).toBe(OneDriveErrorType.ServerError);
    // 一次调用、不重发：结果不明的重发可能把"已经恢复成功"读成第二次的 404。
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});
