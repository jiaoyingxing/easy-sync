// 按版本取内容（`OneDriveClient.downloadDriveItemVersionContent`）。
// 三条约束：①版本条目自带的预授权下载链接优先、且不带 Authorization；
// ②没有链接时走 `…/versions/{id}/content` 的 302 → 预授权 Location（跟随的
// 那次请求同样不带 Authorization）；③当前版本一律不走版本内容端点
// （实测 400），方法不得退回文件级 `/content`。

import { describe, expect, it, vi } from "vitest";
import { OneDriveClient } from "../src/onedrive/client";
import { OneDriveError } from "../src/onedrive/types";

const ITEM_ID = "main-js-id";
const VERSION_ID = "1.0";
const VERSION_CONTENT_URL =
  `https://graph.microsoft.com/v1.0/me/drive/items/${ITEM_ID}/versions/${VERSION_ID}/content`;
const DIRECT_URL = "https://public.dm.files.1drv.com/direct/version-1.0?tempauth=one-shot";
const FRESH_URL = "https://public.dm.files.1drv.com/fresh/version-1.0?tempauth=one-shot";

function utf8(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function decode(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

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

/** 隔离宿主通道：本仓测试环境没有 window，原生 fetch 分支必然退回 requestUrl。 */
async function spyRequestUrl() {
  const obsidian = await import("obsidian");
  return vi.spyOn(obsidian, "requestUrl");
}

describe("OneDriveClient.downloadDriveItemVersionContent", () => {
  it("downloads through the version entry's own pre-authorized link, without the bearer token", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy.mockResolvedValue(graphResponse({ arrayBuffer: utf8("older bytes") }));
    const client = new OneDriveClient(async () => "token");

    const content = await client.downloadDriveItemVersionContent({
      driveItemId: ITEM_ID,
      versionId: VERSION_ID,
      downloadUrl: DIRECT_URL,
      size: 11,
    });

    expect(decode(content)).toBe("older bytes");
    const requests = requestSpy.mock.calls.map((call) => call[0]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ url: DIRECT_URL, method: "GET" });
    expect(requests[0].headers).toBeUndefined();
    // 版本内容端点没被碰过（一次都不用）。
    expect(requests.some((request) =>
      request.url.includes("/versions/"))).toBe(false);
    requestSpy.mockRestore();
  });

  it("follows the version content endpoint's 302 to the pre-authorized location without the bearer token", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy
      .mockResolvedValueOnce(graphResponse({
        status: 302,
        headers: { location: DIRECT_URL },
      }))
      .mockResolvedValueOnce(graphResponse({ arrayBuffer: utf8("older bytes") }));
    const client = new OneDriveClient(async () => "token");

    const content = await client.downloadDriveItemVersionContent({
      driveItemId: ITEM_ID,
      versionId: VERSION_ID,
    });

    expect(decode(content)).toBe("older bytes");
    const requests = requestSpy.mock.calls.map((call) => call[0]);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(VERSION_CONTENT_URL);
    expect(requests[0].headers?.Authorization).toBe("Bearer token");
    expect(requests[1]).toEqual({ url: DIRECT_URL, method: "GET" });
    expect(requests[1].headers).toBeUndefined();
    // 当前版本的文件级 /content 端点一次都不许出现。
    const currentContentUrls = requests.filter((request) =>
      request.url.endsWith(`/items/${ITEM_ID}/content`));
    expect(currentContentUrls).toEqual([]);
    requestSpy.mockRestore();
  });

  it("falls back to the version content endpoint when the direct link is dead", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy
      .mockResolvedValueOnce(graphResponse({ status: 403 }))
      .mockResolvedValueOnce(graphResponse({
        status: 302,
        headers: { Location: FRESH_URL },
      }))
      .mockResolvedValueOnce(graphResponse({ arrayBuffer: utf8("older bytes") }));
    const client = new OneDriveClient(async () => "token");

    const content = await client.downloadDriveItemVersionContent({
      driveItemId: ITEM_ID,
      versionId: VERSION_ID,
      downloadUrl: DIRECT_URL,
    });

    expect(decode(content)).toBe("older bytes");
    expect(requestSpy.mock.calls.map((call) => call[0].url)).toEqual([
      DIRECT_URL,
      VERSION_CONTENT_URL,
      FRESH_URL,
    ]);
    requestSpy.mockRestore();
  });

  it("refuses the current version's 400 instead of reaching for the file /content route", async () => {
    const requestSpy = await spyRequestUrl();
    requestSpy.mockResolvedValue(graphResponse({
      status: 400,
      json: { error: { code: "invalidRequest", message: "version is current" } },
    }));
    const client = new OneDriveClient(async () => "token");

    await expect(client.downloadDriveItemVersionContent({
      driveItemId: ITEM_ID,
      versionId: "2.0",
    })).rejects.toBeInstanceOf(OneDriveError);

    const urls = requestSpy.mock.calls.map((call) => call[0].url);
    expect(urls.some((url) => url.endsWith("/versions/2.0/content"))).toBe(true);
    expect(urls.filter((url) =>
      url.endsWith(`/items/${ITEM_ID}/content`))).toEqual([]);
    requestSpy.mockRestore();
  });
});
