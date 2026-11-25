import { describe, expect, it } from "vitest";
import type { WebDavTransport } from "../src/providers/webdav/webdav-probe";
import {
  WebDavClient,
  WebDavPreconditionFailedError,
} from "../src/providers/webdav/webdav-client";

/**
 * 真实 WebDAV L2（坚果云画像）手工回归。
 *
 * 默认跳过；设置以下环境变量后运行：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/<空测试文件夹>
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 *
 * 该端点必须是可写子文件夹：坚果云的 `/dav/` 本身不能直接承载文件。
 * 测试只在自己的唯一文件名与 `.easy-sync/tmp` 下读写，结束时清理；凭据
 * 只从环境变量读取，不进入仓库。
 */
const live = process.env.EASYSYNC_WEBDAV_LIVE === "1";
const endpoint = process.env.EASYSYNC_WEBDAV_ENDPOINT ?? "";
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

describe.skipIf(!live)("live WebDAV L2 (Nutstore profile)", () => {
  it("round-trips through the safe client and reports the degraded primitives", async () => {
    expect(endpoint.length).toBeGreaterThan(0);
    expect(username.length).toBeGreaterThan(0);
    expect(password.length).toBeGreaterThan(0);

    const client = new WebDavClient({
      endpoint,
      credentials: { username, password },
      transport,
    });
    const probe = await client.initialize();
    console.log(
      `LIVE_WEBDAV_PROBE ${JSON.stringify(
        { capabilities: probe.capabilities, protocolFacts: probe.protocolFacts },
        null,
        2,
      )}`,
    );
    expect(probe.protocolFacts.rootReadable).toBe(true);
    expect(probe.protocolFacts.pathEncodingRoundTrip).toBe(true);
    expect(probe.capabilities.conditionalUpdate).toBe(true);
    // 坚果云画像：If-None-Match 与 DELETE 的 If-Match 被忽略。
    expect(probe.capabilities.conditionalCreate).toBe(false);
    expect(probe.capabilities.conditionalDelete).toBe(false);
    // 409 DuplicateName 的目标未变证据成立后，MOVE 才可作安全新建。
    expect(probe.capabilities.serverSideMove).toBe(true);

    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const file = `live-${suffix}.md`;
    const first = new TextEncoder().encode(`live ${suffix}`);
    const second = new TextEncoder().encode(`updated ${suffix}`);

    try {
      const created = await client.createFile(file, first);
      expect(created.strategy).toBe("staged-move");
      expect(created.stat.size).toBe(first.byteLength);
      expect(created.stat.eTag).not.toBeNull();
      expect(new TextDecoder().decode((await client.readFile(file)).bytes)).toBe(
        `live ${suffix}`,
      );

      const current = await client.stat(file);
      const updated = await client.updateFile(file, second, current!.eTag!);
      expect(updated.stat.size).toBe(second.byteLength);
      expect(new TextDecoder().decode((await client.readFile(file)).bytes)).toBe(
        `updated ${suffix}`,
      );

      await expect(
        client.updateFile(file, first, '"stale-etag"'),
      ).rejects.toBeInstanceOf(WebDavPreconditionFailedError);
      expect((await client.list("")).some((entry) => entry.relativePath === file)).toBe(true);

      const beforeDelete = await client.stat(file);
      await client.deleteFile(file, {
        confirmed: true,
        ifMatch: beforeDelete!.eTag!,
      });
      expect(await client.stat(file)).toBeNull();
    } finally {
      try {
        if (await client.stat(file)) {
          await client.deleteFile(file, { confirmed: true });
        }
      } catch {
        // 清理失败不覆盖主断言；残留路径会在测试输出中可见。
      }
      try {
        await client.deleteEmptyCollection(".easy-sync/tmp", { confirmed: true });
      } catch {
        // tmp 可能不存在或仍有残留；不覆盖主断言。
      }
      try {
        await client.deleteEmptyCollection(".easy-sync", { confirmed: true });
      } catch {
        // 坚果云顶层 sandbox 不能删；.easy-sync 是根下子文件夹，可删则删。
      }
    }
  }, 240_000);
});
