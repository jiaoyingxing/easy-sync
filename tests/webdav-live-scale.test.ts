import { describe, expect, it } from "vitest";
import { WebDavClient } from "../src/providers/webdav/webdav-client";
import {
  createLiveWebDavTransport,
  liveBasePath,
  liveRaw,
  readLiveWebDavConfig,
  requestCountDelta,
  uniqueLiveFolder,
  waitForLiveRateLimit,
} from "./helpers/live-webdav";

/**
 * 真实 WebDAV 规模读数（1,000 文件 / 1 GB）。
 *
 * 默认跳过；设置凭据后运行：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 *   EASYSYNC_WEBDAV_SCALE_FILES=1000（可选，文件数）
 *   EASYSYNC_WEBDAV_SCALE_MIB=1（可选，每个文件 MiB）
 *   EASYSYNC_WEBDAV_SCALE_KEEP=1（可选，保留远端数据不清理）
 *
 * 本探针只测“远端容量与列表成本”，不跑本地扫描/计划/提交引擎：
 * - 播种 N 个 M MiB 文件（默认 1,000 × 1 MiB = 1 GB），逐文件 PUT；
 * - 用生产 `WebDavClient` 全量列表两次，报告分页数、响应条目、请求数与耗时；
 * - 报告限流等待次数、播种/清理耗时；结束时逐文件删除并尝试删空壳。
 *
 * 成本：坚果云免费版 600 请求/30 分钟。1,000 个文件 ≈ 1,000 PUT + 1,000
 * DELETE + 每次列表 2 PROPFIND，跨多个额度窗口；1 GB 写入还会占用临时
 * 配额。全过程可能 2–3 小时，默认超时 4 小时；失败时 `finally` 仍会尝试
 * 清理，清理失败会打印远端路径供网页端手动删除。
 *
 * 输出行：
 *   LIVE_SCALE_RESULT {...}   测量结果（清理前打印）
 *   LIVE_SCALE_SUMMARY {...}  含清理计数的最终摘要
 */
const config = readLiveWebDavConfig();
const fileCount = Math.max(
  1,
  Math.floor(Number(process.env.EASYSYNC_WEBDAV_SCALE_FILES ?? "1000") || 1000),
);
const fileMiB = Math.max(
  1,
  Number(process.env.EASYSYNC_WEBDAV_SCALE_MIB ?? "1") || 1,
);
const keepRemote = process.env.EASYSYNC_WEBDAV_SCALE_KEEP === "1";

describe.skipIf(config === null)("live WebDAV scale (1,000 files / 1 GB)", () => {
  it("seeds, lists twice, and cleans up with request accounting", async () => {
    const live = config!;
    const basePath = liveBasePath(live.endpoint);
    const folder = uniqueLiveFolder(`${basePath}/scale`);
    const names = Array.from(
      { length: fileCount },
      (_, index) => `scale-${String(index).padStart(4, "0")}.bin`,
    );
    const payload = Buffer.alloc(fileMiB * 1024 * 1024, 0x61);
    const summary: Record<string, unknown> = {
      folder,
      fileCount,
      fileMiB,
      totalBytes: fileCount * payload.byteLength,
      seeded: 0,
      listed: 0,
      complete: false,
      pages: 0,
      responseEntryCount: 0,
      seedMs: 0,
      listMs: 0,
      steadyListMs: 0,
      rateLimitWaits: 0,
      initializeRequests: 0,
      listRequests: {},
      steadyListRequests: {},
      cleanupDeleted: 0,
      keepRemote,
    };
    let folderCreated = false;

    const putWithRetry = async (name: string): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        const response = await liveRaw(
          live,
          "PUT",
          `${folder}/${name}`,
          payload,
          { "Content-Type": "application/octet-stream" },
          120_000,
        );
        if (await waitForLiveRateLimit(response, attempt, "LIVE_SCALE")) {
          summary.rateLimitWaits = Number(summary.rateLimitWaits) + 1;
          continue;
        }
        expect([200, 201, 204]).toContain(response.status);
        return;
      }
    };

    try {
      const mkcol = await liveRaw(live, "MKCOL", folder);
      expect([201, 405]).toContain(mkcol.status);
      folderCreated = true;
      console.log(`LIVE_SCALE_FOLDER ${folder}`);

      const seedStarted = Date.now();
      for (let index = 0; index < names.length; index += 1) {
        await putWithRetry(names[index]);
        summary.seeded = index + 1;
        if ((index + 1) % 100 === 0) {
          console.log(`LIVE_SCALE_SEEDED ${index + 1}/${names.length}`);
        }
      }
      summary.seedMs = Date.now() - seedStarted;

      const client = new WebDavClient({
        endpoint: live.endpoint,
        rootPath: folder,
        credentials: { username: live.username, password: live.password },
        transport: createLiveWebDavTransport(),
      });
      await client.initialize();
      summary.initializeRequests = client.requestCount;

      const listStarted = Date.now();
      const firstCounts = { ...client.requestCountsByMethod };
      const listing = await client.list("");
      summary.listMs = Date.now() - listStarted;
      summary.listRequests = requestCountDelta(firstCounts, client.requestCountsByMethod);
      summary.listed = listing.length;
      summary.complete = listing.complete;
      summary.pages = listing.pageCount;
      summary.responseEntryCount = listing.responseEntryCount;

      const steadyStarted = Date.now();
      const secondCounts = { ...client.requestCountsByMethod };
      const steady = await client.list("");
      summary.steadyListMs = Date.now() - steadyStarted;
      summary.steadyListRequests = requestCountDelta(
        secondCounts,
        client.requestCountsByMethod,
      );

      expect(listing.complete).toBe(true);
      expect(steady.complete).toBe(true);
      expect(new Set(listing.map((entry) => entry.relativePath)).size).toBe(fileCount);
      const listed = new Set(listing.map((entry) => entry.relativePath));
      expect(names.every((name) => listed.has(name))).toBe(true);
      if (fileCount > 750) {
        // 坚果云单次 PROPFIND 最多 750 条；超过就必须分页。
        expect(listing.pageCount).toBeGreaterThan(1);
      }
      console.log(`LIVE_SCALE_RESULT ${JSON.stringify(summary)}`);
    } finally {
      if (keepRemote) {
        console.log(`LIVE_SCALE_RETAINED ${folder}`);
      } else if (folderCreated) {
        const cleanupStarted = Date.now();
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          for (let attempt = 0; ; attempt += 1) {
            const response = await liveRaw(live, "DELETE", `${folder}/${name}`);
            if (await waitForLiveRateLimit(response, attempt, "LIVE_SCALE_CLEANUP")) {
              summary.rateLimitWaits = Number(summary.rateLimitWaits) + 1;
              continue;
            }
            if (response.status === 204 || response.status === 404) break;
            throw new Error(`WebDAV scale cleanup failed for ${name}: HTTP ${response.status}`);
          }
          summary.cleanupDeleted = index + 1;
          if ((index + 1) % 100 === 0) {
            console.log(`LIVE_SCALE_CLEANED ${index + 1}/${names.length}`);
          }
        }
        const removed = await liveRaw(live, "DELETE", folder);
        if (removed.status === 403) {
          // 坚果云画像：空集合的 DELETE 也可能被拒绝；文件已逐个删净，
          // 空壳不算数据残留，留给网页端删除。
          console.log(`LIVE_SCALE_FOLDER_RETAINED ${folder}`);
        } else {
          expect([204, 404]).toContain(removed.status);
        }
        summary.cleanupMs = Date.now() - cleanupStarted;
      }
      console.log(`LIVE_SCALE_SUMMARY ${JSON.stringify(summary)}`);
    }
  }, 4 * 60 * 60 * 1000);
});
