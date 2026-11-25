import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebDavTransport } from "../src/providers/webdav/webdav-probe";
import {
  WebDavClient,
} from "../src/providers/webdav/webdav-client";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import {
  idForPath,
  loadIdentityLedger,
  saveIdentityLedger,
} from "../src/providers/webdav/webdav-identity-ledger";
import { RemoteErrorType } from "../src/remote/errors";

/**
 * 真实 WebDAV W3e 小文件 L2（坚果云画像）。
 *
 * 默认跳过；设置以下环境变量后运行：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/<可写测试父文件夹>
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 *
 * 只在一个唯一的 `w3e-<suffix>` 子目录内读写，结束时 child-first 清理并删除
 * 子目录；不碰父文件夹既有内容、不使用大文件、不构造 750 条列表。凭据只从
 * 环境变量读取，不进入仓库。
 */
const live = process.env.EASYSYNC_WEBDAV_LIVE === "1";
const baseEndpoint = process.env.EASYSYNC_WEBDAV_ENDPOINT ?? "";
const username = process.env.EASYSYNC_WEBDAV_USER ?? "";
const password = process.env.EASYSYNC_WEBDAV_PASSWORD ?? "";

const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const rootName = `w3e-${suffix}`;
const UUID = "0123456789abcdef0123456789abcdef";

const requestCount = { total: 0, byMethod: {} as Record<string, number> };

const transport: WebDavTransport = async (request) => {
  requestCount.total += 1;
  requestCount.byMethod[request.method] =
    (requestCount.byMethod[request.method] ?? 0) + 1;
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

describe.skipIf(!live)("live WebDAV W3e (Nutstore profile)", () => {
  let parent: WebDavClient;
  let client: WebDavClient;
  let provider: WebDavProvider;

  beforeAll(async () => {
    expect(baseEndpoint.length).toBeGreaterThan(0);
    expect(username.length).toBeGreaterThan(0);
    expect(password.length).toBeGreaterThan(0);

    parent = new WebDavClient({
      endpoint: baseEndpoint,
      credentials: { username, password },
      transport,
    });
    await parent.ensureCollection(rootName);

    const rootEndpoint = `${baseEndpoint.replace(/\/+$/, "")}/${rootName}`;
    client = new WebDavClient({
      endpoint: rootEndpoint,
      credentials: { username, password },
      transport,
    });
    const probe = await client.initialize();
    console.log(
      `LIVE_W3E_PROBE ${JSON.stringify(
        { capabilities: probe.capabilities, protocolFacts: probe.protocolFacts },
        null,
        2,
      )}`,
    );
    provider = new WebDavProvider({ client });
  }, 240_000);

  afterAll(async () => {
    if (!client) return;
    await removeTree("");
    try {
      if (await parent.stat(rootName)) {
        await parent.deleteEmptyCollection(rootName, { confirmed: true });
      }
    } catch (error) {
      console.log(`LIVE_W3E_CLEANUP_ROOT ${String(error)}`);
    }
  }, 240_000);

  async function removeTree(relativePath: string): Promise<void> {
    let stat: Awaited<ReturnType<WebDavClient["stat"]>>;
    try {
      stat = await client.stat(relativePath);
    } catch {
      return;
    }
    if (!stat) return;
    if (stat.kind === "file") {
      await client.deleteFile(relativePath, {
        confirmed: true,
        ifMatch: stat.eTag,
      });
      return;
    }
    let children: Awaited<ReturnType<WebDavClient["list"]>>;
    try {
      children = await client.list(relativePath);
    } catch {
      return;
    }
    for (const child of children) {
      await removeTree(child.relativePath);
    }
    await client.deleteEmptyCollection(relativePath, { confirmed: true });
  }

  it("identity ledger reaches verified and rebinds after a real MOVE", async () => {
    const before = requestCount.total;
    const created = await saveIdentityLedger(
      client,
      {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        entries: { [UUID]: "a.md" },
      },
      { kind: "create" },
    );
    expect(created.state).toBe("verified");
    expect(created.eTag).not.toBeNull();
    expect(created.canUpdate).toBe(true);

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("verified");
    expect(loaded.ledger).not.toBeNull();
    expect(idForPath(loaded.ledger!, "a.md")).toBe(UUID);

    const body = new TextEncoder().encode(`w3e ${suffix}`);
    const file = await client.createFile("a.md", body);
    expect(file.strategy).toBe("staged-move");
    const eTag = file.stat.eTag!;

    await provider.renameItem("vault", "a.md", "b.md", "a.md", eTag);
    expect(await client.stat("a.md")).toBeNull();
    expect(await client.stat("b.md")).not.toBeNull();

    const afterMove = await loadIdentityLedger(client);
    expect(afterMove.state).toBe("verified");
    expect(idForPath(afterMove.ledger!, "b.md")).toBe(UUID);
    expect(idForPath(afterMove.ledger!, "a.md")).toBeNull();
    console.log(
      `LIVE_W3E_LEDGER ${JSON.stringify({
        state: loaded.state,
        eTag: created.eTag,
        strategy: created.strategy,
        requests: requestCount.total - before,
      })}`,
    );
    console.log(`LIVE_W3E_LEDGER_AFTER_MOVE ${afterMove.state}`);
  }, 240_000);

  it("file rename and delete settle with strong ETags", async () => {
    const body = new TextEncoder().encode(`delete ${suffix}`);
    const file = await client.createFile("c.md", body);
    const eTag = file.stat.eTag!;
    await provider.renameItem("vault", "c.md", "d.md", "c.md", eTag);
    const current = await client.stat("d.md");
    await provider.deleteItem("vault", "d.md", current!.eTag);
    expect(await client.stat("d.md")).toBeNull();
  }, 240_000);

  it("empty collection: no folder ETag; shell proof settles without DELETE", async () => {
    await provider.createFolderPath("vault", "docs");
    const body = new TextEncoder().encode(`docs ${suffix}`);
    await client.createFile("docs/a.md", body);
    const folderStat = await client.stat("docs");
    expect(folderStat?.kind).toBe("collection");
    const fileStat = await client.stat("docs/a.md");
    await provider.deleteItem("vault", "docs/a.md", fileStat!.eTag);
    expect(await client.stat("docs/a.md")).toBeNull();

    console.log(
      `LIVE_W3E_FOLDER ${JSON.stringify({
        eTag: folderStat?.eTag ?? null,
        weakETag: folderStat?.weakETag ?? null,
      })}`,
    );
    // 坚果云实测：集合 PROPFIND 无 ETag（eTag=null、weakETag=false）。集合
    // 删除不能依赖集合 ETag；provider 走「证明空壳」路径，成功返回且不发
    // DELETE，空集合保留，由引擎 tombstone 结算。这里用任意强 ETag 只证明
    // 调用形状（真实调用方会传已复核的 ETag 或空壳证明）。
    await provider.deleteItem("vault", "docs", '"live-probe"');
    expect(await client.stat("docs")).not.toBeNull();

    // 非空集合仍拒绝：不能把「有内容」当空壳。
    await client.createFile("docs/b.md", body);
    const child = await client.stat("docs/b.md");
    await expect(
      provider.deleteItem("vault", "docs", child!.eTag),
    ).rejects.toMatchObject({ type: RemoteErrorType.Conflict });
    expect(await client.stat("docs/b.md")).not.toBeNull();
  }, 240_000);

  it("reports the request budget for the whole W3e sample", async () => {
    console.log(
      `LIVE_W3E_REQUESTS ${JSON.stringify(requestCount)}`,
    );
    // 小样本预算：不碰大文件／750 条时，整套 W3e 应远低于 600 次/30 分钟限流。
    expect(requestCount.total).toBeLessThan(400);
    expect(requestCount.byMethod.PROPFIND ?? 0).toBeGreaterThan(0);
    expect(requestCount.byMethod.MOVE ?? 0).toBeGreaterThan(0);
    expect(requestCount.byMethod.DELETE ?? 0).toBeGreaterThan(0);
  }, 240_000);
});
