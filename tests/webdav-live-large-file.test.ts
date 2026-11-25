import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP,
  WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE,
  webdavCapabilities,
  type WebDavTransport,
} from "../src/providers/webdav/webdav-probe";
import { WebDavClient } from "../src/providers/webdav/webdav-client";

/**
 * 真实坚果云大文件 L2（B2 验收门）。
 *
 * 默认跳过；设置以下环境变量后运行：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 *   EASYSYNC_WEBDAV_LIVE_LARGE_MIB=100（可选，默认 100）
 *
 * 用生产 `WebDavClient` 的 staged-MOVE 上传路径写 32 MiB 与 100 MiB 文件，
 * 再用 `readFile`（GET 整包）下载并核对 SHA-256；覆盖 30 秒默认 deadline
 * 之外的大文件读取。遇到 503 BlockedTemporarily 按 Retry-After（缺省 30
 * 分钟）等待后重试。凭据只从环境变量读取，不写入仓库或日志。
 */
const live = process.env.EASYSYNC_WEBDAV_LIVE === "1";
const endpoint = process.env.EASYSYNC_WEBDAV_ENDPOINT ?? "";
const username = process.env.EASYSYNC_WEBDAV_USER ?? "";
const password = process.env.EASYSYNC_WEBDAV_PASSWORD ?? "";
const largeMiB = Math.max(
  32,
  Number(process.env.EASYSYNC_WEBDAV_LIVE_LARGE_MIB ?? "100") || 100,
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

function retryAfterMs(headers: Record<string, string>): number {
  const raw = headers["retry-after"];
  if (!raw) return 30 * 60 * 1000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 30 * 60 * 1000;
}

async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  isRateLimited: (error: unknown) => boolean,
  retryAfter: (error: unknown) => number | null,
  attempts = 3,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isRateLimited(error)) throw error;
      const delay = retryAfter(error) ?? 30 * 60 * 1000;
      console.log(`LIVE_LARGE_RATE_LIMIT wait_ms=${delay} attempt=${attempt + 1}`);
      await sleep(delay);
    }
  }
}

async function rawDelete(path: string): Promise<number> {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  const response = await fetch(`${new URL(endpoint).origin}${path}`, {
    method: "DELETE",
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(60_000),
  });
  return response.status;
}

describe.skipIf(!live)("live WebDAV large files (Nutstore)", () => {
  it("round-trips 32 MiB and 100 MiB through the production client", async () => {
    expect(endpoint.length).toBeGreaterThan(0);
    expect(username.length).toBeGreaterThan(0);
    expect(password.length).toBeGreaterThan(0);
    const base = new URL(endpoint).pathname.replace(/\/+$/u, "");
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const folder = `${base}/b2large-${suffix}`;
    const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
    const mkcol = await fetch(`${new URL(endpoint).origin}${folder}`, {
      method: "MKCOL",
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(60_000),
    });
    expect([201, 405]).toContain(mkcol.status);
    const client = new WebDavClient({
      endpoint,
      rootPath: folder,
      credentials: { username, password },
      transport,
      platform: "desktop",
      capabilities: {
        ...webdavCapabilities("desktop"),
        serverSideMove: true,
      },
    });
    const summary: Record<string, unknown> = { folder, files: [] };
    const sizes = [32, largeMiB];
    try {
      for (const mib of sizes) {
        const bytes = new Uint8Array(mib * 1024 * 1024);
        bytes.fill(0x5a);
        const expectedHash = createHash("sha256").update(bytes).digest("hex");
        const name = `large-${mib}m.bin`;
        const startedUpload = Date.now();
        await withRateLimitRetry(
          () => client.createFile(name, bytes),
          (error) => (error as { type?: string } | null)?.type === "RateLimited",
          (error) => (error as { retryAfterSeconds?: number | null } | null)?.retryAfterSeconds
            ? ((error as { retryAfterSeconds: number }).retryAfterSeconds * 1000)
            : null,
        );
        const uploadMs = Date.now() - startedUpload;
        const startedDownload = Date.now();
        const read = await withRateLimitRetry(
          () => client.readFile(name),
          (error) => (error as { type?: string } | null)?.type === "RateLimited",
          (error) => (error as { retryAfterSeconds?: number | null } | null)?.retryAfterSeconds
            ? ((error as { retryAfterSeconds: number }).retryAfterSeconds * 1000)
            : null,
        );
        const downloadMs = Date.now() - startedDownload;
        const actualHash = createHash("sha256").update(read.bytes).digest("hex");
        expect(read.bytes.byteLength).toBe(bytes.byteLength);
        expect(actualHash).toBe(expectedHash);
        (summary.files as unknown[]).push({
          mib,
          uploadMs,
          downloadMs,
          bytes: read.bytes.byteLength,
          sha256Matched: true,
        });
        console.log(`LIVE_LARGE_FILE ${name} upload_ms=${uploadMs} download_ms=${downloadMs} sha256=ok`);
        const deleted = await rawDelete(`${folder}/${name}`);
        expect([204, 404]).toContain(deleted);
      }
      console.log(`LIVE_LARGE_RESULT ${JSON.stringify(summary)}`);
    } finally {
      const folderDelete = await rawDelete(folder);
      summary.folderDeleteStatus = folderDelete;
      console.log(`LIVE_LARGE_FOLDER_DELETE ${folderDelete}`);
      console.log(`LIVE_LARGE_SUMMARY ${JSON.stringify(summary)}`);
    }
  }, 3_600_000);
});
