import { describe, expect, it } from "vitest";
import { resolveRootPath } from "../src/cloud/cloud-connection-test";
import type { WebDavTransport } from "../src/providers/webdav/webdav-probe";
import { WebDavClient } from "../src/providers/webdav/webdav-client";

/**
 * 真实 WebDAV L2：服务器地址自带中文集合路径。
 *
 * 默认跳过；设置以下环境变量后运行：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/<可写父文件夹>（可含中文）
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 *
 * 回归目标：坐标里保存的百分号编码只能被还原一次，客户端随后只编码一次；
 * 否则中文父路径会变成双重编码，服务端返回 409。测试在父文件夹下创建唯一
 * `p0path-<suffix>` 子目录，只读写自己的文件，结束时清理。
 */
const live = process.env.EASYSYNC_WEBDAV_LIVE === "1";
const parentEndpoint = process.env.EASYSYNC_WEBDAV_ENDPOINT ?? "";
const username = process.env.EASYSYNC_WEBDAV_USER ?? "";
const password = process.env.EASYSYNC_WEBDAV_PASSWORD ?? "";

const transport: WebDavTransport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.deadlineMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body };
  } catch {
    return { status: 0, headers: {}, body: new ArrayBuffer(0) };
  } finally {
    clearTimeout(timer);
  }
};

describe.skipIf(!live)("live WebDAV path encoding (Chinese parent)", () => {
  it("resolves and encodes a Chinese parent path exactly once", async () => {
    expect(parentEndpoint.length).toBeGreaterThan(0);
    expect(username.length).toBeGreaterThan(0);
    expect(password.length).toBeGreaterThan(0);

    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rootName = `p0path-${suffix}`;
    const coordinates = {
      url: parentEndpoint.replace(/\/+$/u, ""),
      username,
      rootPrefix: rootName,
    };
    const rootPath = resolveRootPath(coordinates);
    if (parentEndpoint.includes("安卓手机测试仓库")) {
      expect(rootPath).toContain("安卓手机测试仓库");
    }
    expect(rootPath).not.toContain("%");

    const parent = new WebDavClient({
      endpoint: coordinates.url,
      credentials: { username, password },
      transport,
    });
    const client = new WebDavClient({
      endpoint: coordinates.url,
      rootPath,
      credentials: { username, password },
      transport,
    });
    const file = "中文 文件.md";
    const bytes = new TextEncoder().encode("中文路径只编码一次\n");
    try {
      const probe = await client.initialize();
      expect(probe.protocolFacts.rootReadable).toBe(true);
      await client.createFile(file, bytes);
      expect(new TextDecoder().decode((await client.readFile(file)).bytes))
        .toBe("中文路径只编码一次\n");
      await client.deleteFile(file, { confirmed: true });
      await client.deleteEmptyCollection(".easy-sync/tmp", { confirmed: true });
      await client.deleteEmptyCollection(".easy-sync", { confirmed: true });
    } finally {
      try {
        if (await client.stat(file)) {
          await client.deleteFile(file, { confirmed: true });
        }
      } catch {
        // 清理失败不覆盖主断言。
      }
      try {
        await parent.deleteEmptyCollection(rootName, { confirmed: true });
      } catch {
        // 残留会在测试输出中可见；不用清理失败覆盖主断言。
      }
    }
  }, 180_000);
});
