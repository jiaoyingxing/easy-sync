import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import type { WebDavTransport } from "../src/providers/webdav/webdav-probe";
import {
  WebDavClient,
  WebDavTargetExistsError,
} from "../src/providers/webdav/webdav-client";
import {
  WEBDAV_SHARED_PROTOCOL_V2_PATH,
  WEBDAV_SHARED_PROTOCOL_V3_PATH,
  WebDavSharedProtocolConflictError,
  WebDavSharedProtocolStore,
} from "../src/providers/webdav/webdav-protocol";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import {
  buildWebDavScopeFields,
  webDavScopeFieldsToSyncScope,
} from "../src/providers/webdav/webdav-scope";
import {
  createMigrationGenerationV2,
  serializeSharedSyncProtocolV2,
  type SharedSyncProtocolV2,
} from "../src/sync/sync-protocol-v2";

/**
 * 真实 WebDAV W2c 小文件 L2（坚果云画像）。
 *
 * 默认跳过；设置以下环境变量后运行：
 *   EASYSYNC_WEBDAV_LIVE=1
 *   EASYSYNC_WEBDAV_ENDPOINT=https://dav.jianguoyun.com/dav/<可写测试父文件夹>
 *   EASYSYNC_WEBDAV_USER=...
 *   EASYSYNC_WEBDAV_PASSWORD=...（应用密码）
 *
 * 测试会在父文件夹下创建唯一 `w2c-<suffix>` 子目录，所有写入都在该子目录
 * 内完成，结束时 child-first 清理并删除子目录；不碰父文件夹里的任何既有
 * 内容、不使用大文件、不构造 750 条列表。凭据只从环境变量读取，不进入仓库。
 */
const live = process.env.EASYSYNC_WEBDAV_LIVE === "1";
const baseEndpoint = process.env.EASYSYNC_WEBDAV_ENDPOINT ?? "";
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

const credentials = { username, password };
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const rootName = `w2c-${suffix}`;
const etagPath = `etag-${suffix}.md`;
const racePath = `race-${suffix}.md`;

describe.skipIf(!live)("live WebDAV W2c (Nutstore profile)", () => {
  let parent: WebDavClient;
  let client: WebDavClient;
  let provider: WebDavProvider;
  let store: WebDavSharedProtocolStore;
  let rootEndpoint: string;
  let v2Content: string;
  let v3Content: string;

  beforeAll(async () => {
    expect(baseEndpoint.length).toBeGreaterThan(0);
    expect(username.length).toBeGreaterThan(0);
    expect(password.length).toBeGreaterThan(0);

    parent = new WebDavClient({
      endpoint: baseEndpoint,
      credentials,
      transport,
    });
    await parent.ensureCollection(rootName);

    rootEndpoint = `${baseEndpoint.replace(/\/+$/, "")}/${rootName}`;
    client = new WebDavClient({
      endpoint: rootEndpoint,
      credentials,
      transport,
    });
    const probe = await client.initialize();
    console.log(
      `LIVE_W2C_PROBE ${JSON.stringify(
        { capabilities: probe.capabilities, protocolFacts: probe.protocolFacts },
        null,
        2,
      )}`,
    );

    provider = new WebDavProvider({ client });
    store = new WebDavSharedProtocolStore(client);

    const fields = await buildWebDavScopeFields({
      endpoint: rootEndpoint,
      username,
    });
    const now = Date.now();
    const protocol: SharedSyncProtocolV2 = {
      schemaVersion: 1,
      kind: "easy-sync-v2-protocol",
      protocolVersion: 2,
      migrationGeneration: createMigrationGenerationV2(),
      scope: webDavScopeFieldsToSyncScope(fields),
      confirmedAllDevicesUpdatedAt: now,
      createdAt: now,
    };
    v2Content = serializeSharedSyncProtocolV2(protocol);
    v3Content = JSON.stringify({
      schemaVersion: 1,
      kind: "easy-sync-generation-protocol",
      protocolVersion: 3,
      migrationGeneration: protocol.migrationGeneration,
      predecessor: {
        protocolVersion: 2,
        contentSha256: await sha256Hex(
          new TextEncoder().encode(v2Content).buffer,
        ),
      },
      createdAt: now,
    });
  }, 240_000);

  afterAll(async () => {
    if (!client) return;
    await removeTree("");
    try {
      const remaining = await parent.stat(rootName);
      if (remaining) {
        await parent.deleteEmptyCollection(rootName, { confirmed: true });
      }
    } catch (error) {
      console.log(`LIVE_W2C_CLEANUP_ROOT ${String(error)}`);
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

  it("reports the Nutstore degradation profile on a writable root", async () => {
    const probe = await client.probe();
    expect(probe.protocolFacts.rootReadable).toBe(true);
    expect(probe.protocolFacts.pathEncodingRoundTrip).toBe(true);
    expect(probe.security.clientScheme).toBe("https");
    expect(probe.security.clientAuthentication).toBe("basic");
    expect(probe.security.anonymousRejected).toBe(true);
    expect(probe.capabilities.conditionalUpdate).toBe(true);
    // 坚果云画像：If-None-Match 与 DELETE 的 If-Match 被忽略。
    expect(probe.capabilities.conditionalCreate).toBe(false);
    expect(probe.capabilities.conditionalDelete).toBe(false);
    expect(probe.capabilities.serverSideMove).toBe(true);
    expect(probe.protocolFacts.moveOverwriteReject).toBe(true);
  }, 240_000);

  it("creates and reads the fixed V2/V3 control objects with stable strong ETags", async () => {
    expect(await store.readObjects()).toEqual({ v2: null, v3: null });

    const createdV2 = await store.create("v2", v2Content);
    expect(createdV2.id).toBe(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    expect(createdV2.eTag.length).toBeGreaterThan(0);
    expect(createdV2.eTag.startsWith("W/")).toBe(false);

    const createdV3 = await store.create("v3", v3Content);
    expect(createdV3.id).toBe(WEBDAV_SHARED_PROTOCOL_V3_PATH);
    expect(createdV3.eTag.startsWith("W/")).toBe(false);

    const observed = await store.readObjects();
    expect(observed.v2?.content).toBe(v2Content);
    expect(observed.v3?.content).toBe(v3Content);
    expect(observed.v2?.eTag).toBe(createdV2.eTag);
    expect(observed.v3?.eTag).toBe(createdV3.eTag);

    const viaProvider = await provider.readSharedSyncProtocolObjects("vault");
    expect(viaProvider.v2?.content).toBe(v2Content);
    expect(viaProvider.v3?.content).toBe(v3Content);

    // ETag 稳定性：连续 PROPFIND 与读取都必须返回同一强 ETag。
    const statA = await client.stat(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    const statB = await client.stat(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    const statC = await client.stat(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    expect(statA?.eTag).toBe(statB?.eTag);
    expect(statB?.eTag).toBe(statC?.eTag);
    expect(statA?.eTag?.startsWith("W/")).toBe(false);

    const readA = await store.readById(
      WEBDAV_SHARED_PROTOCOL_V2_PATH,
      "v2",
    );
    const readB = await store.readById(
      WEBDAV_SHARED_PROTOCOL_V2_PATH,
      "v2",
    );
    expect(readA.eTag).toBe(readB.eTag);

    // 安全新建不得覆盖既有槽位。
    await expect(store.create("v2", v2Content)).rejects.toBeInstanceOf(
      WebDavSharedProtocolConflictError,
    );

    // V2 repair：陈旧 ETag 412，当前 ETag 可条件覆盖（内容不变）。
    await expect(
      store.overwriteV2(
        WEBDAV_SHARED_PROTOCOL_V2_PATH,
        '"stale-etag"',
        v2Content,
      ),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolConflictError);
    const repaired = await store.overwriteV2(
      WEBDAV_SHARED_PROTOCOL_V2_PATH,
      readA.eTag,
      v2Content,
    );
    expect(repaired.id).toBe(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    expect((await store.readObjects()).v2?.content).toBe(v2Content);
  }, 240_000);

  it("uses staged-MOVE for creates and settles concurrent creates on one winner", async () => {
    const body = new TextEncoder().encode(`etag ${suffix}`);
    const created = await client.createFile(etagPath, body);
    expect(created.strategy).toBe("staged-move");
    expect(created.stat.size).toBe(body.byteLength);
    expect(created.stat.eTag).not.toBeNull();
    expect(created.stat.eTag?.startsWith("W/")).toBe(false);

    expect((await client.readFile(etagPath)).bytes).toEqual(body);

    const first = await client.stat(etagPath);
    const second = await client.stat(etagPath);
    expect(first?.eTag).toBe(second?.eTag);

    const bytesA = new TextEncoder().encode(`race-a ${suffix}`);
    const bytesB = new TextEncoder().encode(`race-b ${suffix}`);
    const results = await Promise.allSettled([
      client.createFile(racePath, bytesA),
      client.createFile(racePath, bytesB),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result) => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status === "rejected" ? rejected[0].reason : null)
      .toBeInstanceOf(WebDavTargetExistsError);

    const winner = fulfilled[0].status === "fulfilled"
      ? fulfilled[0].value
      : null;
    expect(winner).not.toBeNull();
    const finalBytes = (await client.readFile(racePath)).bytes;
    expect(
      Buffer.from(finalBytes).equals(Buffer.from(bytesA))
      || Buffer.from(finalBytes).equals(Buffer.from(bytesB)),
    ).toBe(true);
    expect(winner?.stat.size).toBe(finalBytes.byteLength);

    const cleanup = await client.cleanupStaleTemporaryFiles({
      olderThanMs: 1,
    });
    console.log(`LIVE_W2C_TMP_CLEANUP ${JSON.stringify(cleanup)}`);
    expect(cleanup.failures).toEqual([]);
    expect(cleanup.listingComplete).toBe(true);
  }, 240_000);

  it("keeps the control directory visible but out of provider scans", async () => {
    const rootEntries = await client.list("");
    const rootPaths = rootEntries.map((entry) => entry.relativePath);
    expect(rootPaths).toContain(".easy-sync");
    expect(rootPaths).toContain(etagPath);
    expect(rootPaths).toContain(racePath);

    const controlEntries = await client.list(".easy-sync");
    const controlPaths = controlEntries.map((entry) => entry.relativePath);
    expect(controlPaths).toContain(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    expect(controlPaths).toContain(WEBDAV_SHARED_PROTOCOL_V3_PATH);

    const scan = await provider.fullScan("vault");
    const scanPaths = scan.map((item) => item.id);
    expect(scanPaths).toContain(etagPath);
    expect(scanPaths).toContain(racePath);
    expect(scanPaths.some((path) => path.startsWith(".easy-sync"))).toBe(false);
    expect(scanPaths.some((path) => path.startsWith(".easy-sync-probe-"))).toBe(
      false,
    );
    expect(scanPaths.some((path) => path.startsWith(".easysync-root-probe-"))).toBe(
      false,
    );
  }, 240_000);
});
