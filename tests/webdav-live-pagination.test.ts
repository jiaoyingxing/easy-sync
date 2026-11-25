import { describe, expect, it } from "vitest";
import type { WebDavTransport } from "../src/providers/webdav/webdav-probe";
import { WebDavClient } from "../src/providers/webdav/webdav-client";

/**
 * 真实坚果云分页 L2（B1 验收门）。
 *
 * 默认跳过；设置以下环境变量后运行：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 *   EASYSYNC_WEBDAV_LIVE_PAGE_COUNT=1001（可选，默认 1001）
 *
 * 坚果云免费额度约 600 请求/30 分钟，且单次 PROPFIND 最多 750 条。本用例
 * 会在唯一子文件夹里播种 1,001 个 1 字节文件（每个 PUT 一次请求），用生产
 * `WebDavClient` 验证 `Link: rel="next"` 分页完整；结束后再逐文件删除。
 * 遇到 503 BlockedTemporarily 时按 Retry-After（缺省 30 分钟）等待后重试。
 * 全过程可能跨越多个额度窗口（约 1–2 小时），因此默认不跑。
 *
 * 凭据只从环境变量读取，不写入仓库或日志；测试只操作自己的唯一子文件夹。
 */
const live = process.env.EASYSYNC_WEBDAV_LIVE === "1";
const endpoint = process.env.EASYSYNC_WEBDAV_ENDPOINT ?? "";
const username = process.env.EASYSYNC_WEBDAV_USER ?? "";
const password = process.env.EASYSYNC_WEBDAV_PASSWORD ?? "";
const pageCount = Math.max(
  751,
  Number(process.env.EASYSYNC_WEBDAV_LIVE_PAGE_COUNT ?? "1001") || 1001,
);

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(headers: Record<string, string>, fallbackMs = 30 * 60 * 1000): number {
  const raw = headers["retry-after"];
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

async function raw(
  method: string,
  path: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const response = await fetch(`${new URL(endpoint).origin}${path}`, {
    method,
    headers,
    body,
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: (await response.text()).slice(0, 300),
  };
}

describe.skipIf(!live)("live WebDAV pagination (Nutstore)", () => {
  it("lists 1,001 entries through Link rel=next and cleans up", async () => {
    expect(endpoint.length).toBeGreaterThan(0);
    expect(username.length).toBeGreaterThan(0);
    expect(password.length).toBeGreaterThan(0);
    const authorization = `Basic ${Buffer.from(
      `${username}:${password}`,
      "utf8",
    ).toString("base64")}`;
    const base = new URL(endpoint).pathname.replace(/\/+$/u, "");
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const folder = `${base}/b1page-${suffix}`;
    const requestHeaders = { Authorization: authorization };
    const names = Array.from(
      { length: pageCount },
      (_, index) => `page-${String(index).padStart(4, "0")}.md`,
    );
    let folderCreated = false;
    const summary: Record<string, unknown> = {
      folder,
      pageCount,
      seeded: 0,
      listed: 0,
      complete: false,
      pages: 0,
      responseEntryCount: 0,
      requestCounts: {},
      cleanupDeleted: 0,
    };

    const waitForRateLimit = async (
      response: { status: number; headers: Record<string, string>; body: string },
      attempt: number,
    ): Promise<boolean> => {
      if (response.status !== 503 && response.status !== 429 && response.status !== 509) {
        return false;
      }
      const blocked = response.status === 429
        || response.status === 509
        || /BlockedTemporarily|Too many requests/i.test(response.body);
      if (!blocked) return false;
      if (attempt >= 6) {
        throw new Error(`WebDAV live seeding still rate-limited after ${attempt} waits`);
      }
      const delay = retryAfterMs(response.headers);
      console.log(`LIVE_PAGINATION_RATE_LIMIT wait_ms=${delay} attempt=${attempt + 1}`);
      await sleep(delay);
      return true;
    };

    try {
      const mkcol = await raw("MKCOL", folder, undefined, requestHeaders);
      expect([201, 405]).toContain(mkcol.status);
      folderCreated = true;
      console.log(`LIVE_PAGINATION_FOLDER ${folder}`);

      for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        for (let attempt = 0; ; attempt += 1) {
          const response = await raw(
            "PUT",
            `${folder}/${name}`,
            "x",
            { ...requestHeaders, "Content-Type": "text/markdown; charset=utf-8" },
          );
          if (await waitForRateLimit(response, attempt)) continue;
          expect([201, 204, 200]).toContain(response.status);
          break;
        }
        summary.seeded = index + 1;
        if ((index + 1) % 100 === 0) {
          console.log(`LIVE_PAGINATION_SEEDED ${index + 1}/${names.length}`);
        }
      }

      const client = new WebDavClient({
        endpoint,
        rootPath: folder,
        credentials: { username, password },
        transport,
      });
      await client.initialize();
      const listing = await client.list("");
      summary.listed = listing.length;
      summary.complete = listing.complete;
      summary.pages = listing.pageCount;
      summary.responseEntryCount = listing.responseEntryCount;
      summary.requestCounts = client.requestCountsByMethod;

      expect(listing.complete).toBe(true);
      expect(listing.pageCount).toBeGreaterThan(1);
      expect(new Set(listing.map((entry) => entry.relativePath)).size)
        .toBe(pageCount);
      const listed = new Set(listing.map((entry) => entry.relativePath));
      expect(names.every((name) => listed.has(name))).toBe(true);
      console.log(`LIVE_PAGINATION_RESULT ${JSON.stringify(summary)}`);
    } finally {
      if (folderCreated) {
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          for (let attempt = 0; ; attempt += 1) {
            const response = await raw(
              "DELETE",
              `${folder}/${name}`,
              undefined,
              requestHeaders,
            );
            if (await waitForRateLimit(response, attempt)) continue;
            if (response.status === 204 || response.status === 404) break;
            throw new Error(`WebDAV live cleanup failed for ${name}: HTTP ${response.status}`);
          }
          summary.cleanupDeleted = index + 1;
          if ((index + 1) % 100 === 0) {
            console.log(`LIVE_PAGINATION_CLEANED ${index + 1}/${names.length}`);
          }
        }
        const removed = await raw("DELETE", folder, undefined, requestHeaders);
        if (removed.status === 403) {
          // 坚果云画像：空集合的 DELETE 也可能被拒绝（W3e 已记录集合无
          // 条件删除能力）。文件已逐个删净，保留空壳不算数据残留。
          console.log(`LIVE_PAGINATION_FOLDER_RETAINED ${folder}`);
        } else {
          expect([204, 404]).toContain(removed.status);
        }
      }
      console.log(`LIVE_PAGINATION_SUMMARY ${JSON.stringify(summary)}`);
    }
  }, 10_800_000);
});
