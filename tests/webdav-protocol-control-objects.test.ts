import { describe, expect, it } from "vitest";
import { RemoteErrorType } from "../src/remote/errors";
import { WebDavClient } from "../src/providers/webdav/webdav-client";
import {
  MAX_SHARED_PROTOCOL_BYTES,
  WEBDAV_SHARED_PROTOCOL_V2_PATH,
  WEBDAV_SHARED_PROTOCOL_V3_PATH,
  WebDavSharedProtocolConflictError,
  WebDavSharedProtocolEtagError,
  WebDavSharedProtocolListingIncompleteError,
  WebDavSharedProtocolSlotError,
  WebDavSharedProtocolTooLargeError,
} from "../src/providers/webdav/webdav-protocol";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import type {
  WebDavHttpRequest,
  WebDavHttpResponse,
  WebDavTransport,
} from "../src/providers/webdav/webdav-probe";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};
const FIXED_NOW = new Date("2026-11-19T20:00:00.000Z");

const V2_REMOTE = `/vault/${WEBDAV_SHARED_PROTOCOL_V2_PATH}`;
const V3_REMOTE = `/vault/${WEBDAV_SHARED_PROTOCOL_V3_PATH}`;

/** 坚果云 L2 画像：`If-None-Match` 被忽略、目标已存在时 MOVE 用 409、
 *  已存在集合的 MKCOL 仍回 201。 */
const NUTSTORE_PROFILES: readonly FakeWebDavProfile[] = [
  "ignore-if-none-match",
  "move-conflict-on-overwrite",
  "mkcol-existing-201",
];

async function createProvider(
  options: {
    readonly profiles?: readonly FakeWebDavProfile[];
    readonly wrapTransport?: (transport: WebDavTransport) => WebDavTransport;
  } = {},
): Promise<{ provider: WebDavProvider; client: WebDavClient }> {
  fixture.fake.setProfiles(options.profiles ?? ["strict"]);
  const transport = options.wrapTransport
    ? options.wrapTransport(fixture.transport)
    : fixture.transport;
  const client = new WebDavClient({ endpoint, credentials, transport });
  await client.initialize();
  return {
    provider: new WebDavProvider({ client, now: () => FIXED_NOW }),
    client,
  };
}

function headerOf(request: WebDavHttpRequest, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/** 替换 207 响应体并同步 Content-Length；测试只改 XML，不改状态与其余头。 */
function rewriteResponseBody(
  response: WebDavHttpResponse,
  transform: (body: string) => string,
): WebDavHttpResponse {
  const body = transform(new TextDecoder().decode(new Uint8Array(response.body)));
  const bytes = new TextEncoder().encode(body);
  const headers: Record<string, string> = { ...response.headers };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "content-length") headers[key] = String(bytes.byteLength);
  }
  return {
    status: response.status,
    headers,
    body: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  };
}

function responseBlocks(body: string): Array<RegExpMatchArray> {
  return [...body.matchAll(/<d:response>[\s\S]*?<\/d:response>/g)];
}

/** 在 `.easy-sync` 的 Depth 1 列表里重复 protocol-v2.json 的 response。 */
function duplicateV2Response(transport: WebDavTransport): WebDavTransport {
  return async (request) => {
    const response = await transport(request);
    if (
      request.method !== "PROPFIND"
      || headerOf(request, "depth") !== "1"
      || new URL(request.url).pathname !== "/vault/.easy-sync"
      || response.status !== 207
    ) {
      return response;
    }
    return rewriteResponseBody(response, (body) => {
      const target = responseBlocks(body).find((block) =>
        block[0].includes("protocol-v2.json")
      );
      return target ? body.replace(target[0], `${target[0]}${target[0]}`) : body;
    });
  };
}

/** 所有 PROPFIND 的 getetag 都消失：仅用于证明无 ETag 时 fail-closed。 */
function withoutETags(transport: WebDavTransport): WebDavTransport {
  return async (request) => {
    const response = await transport(request);
    if (request.method !== "PROPFIND") return response;
    return rewriteResponseBody(response, (body) =>
      body.replace(/<d:getetag>[\s\S]*?<\/d:getetag>/g, "")
    );
  };
}

/** 让 V2 的 GET 返回 500：槽位读取失败不得被解释成「不存在」。 */
function failProtocolV2Get(transport: WebDavTransport): WebDavTransport {
  return async (request) => {
    if (
      request.method === "GET"
      && new URL(request.url).pathname === V2_REMOTE
    ) {
      return { status: 500, headers: {}, body: new ArrayBuffer(0) };
    }
    return await transport(request);
  };
}

/**
 * 隐藏 PROPFIND 的 getcontentlength，并让 V2 的 GET 返回 >1 MiB 字节：
 * 证明 1 MiB 上限不只依赖 stat.size。
 */
function hideLengthsAndServeOversizedBody(
  transport: WebDavTransport,
): WebDavTransport {
  return async (request) => {
    const response = await transport(request);
    if (request.method === "PROPFIND" && response.status === 207) {
      return rewriteResponseBody(response, (body) =>
        body.replace(
          /<d:getcontentlength>[\s\S]*?<\/d:getcontentlength>/g,
          "",
        )
      );
    }
    if (
      request.method === "GET"
      && new URL(request.url).pathname === V2_REMOTE
    ) {
      const bytes = new Uint8Array(MAX_SHARED_PROTOCOL_BYTES + 1);
      bytes.fill(0x20);
      return { status: 200, headers: {}, body: bytes.buffer };
    }
    return response;
  };
}

describe("W2b2b1 控制对象发现", () => {
  it(".easy-sync 缺失或为空时返回空观察", async () => {
    const { provider } = await createProvider();

    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).resolves.toEqual({ v2: null, v3: null });

    fixture.fake.seedCollection("/vault/.easy-sync");
    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).resolves.toEqual({ v2: null, v3: null });
  });

  it("槽位是 collection 时抛错", async () => {
    fixture.fake.seedCollection(V2_REMOTE);
    const { provider } = await createProvider();

    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolSlotError);
  });

  it("同名重复槽位时抛错", async () => {
    fixture.fake.seedFile(V2_REMOTE, '{"v":2}');
    const { provider } = await createProvider({
      wrapTransport: duplicateV2Response,
    });

    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolSlotError);
  });

  it("控制目录列表 complete=false 时抛错，不返回空观察", async () => {
    fixture.fake.seedCollection("/vault/.easy-sync");
    for (let index = 0; index < 750; index += 1) {
      fixture.fake.seedFile(
        `/vault/.easy-sync/filler-${String(index).padStart(4, "0")}.json`,
        "{}",
      );
    }
    const { provider } = await createProvider();

    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolListingIncompleteError);
  });

  it("槽位读取失败（非 404）不被伪装成空观察", async () => {
    fixture.fake.seedFile(V2_REMOTE, '{"v":2}');
    const { provider } = await createProvider({
      wrapTransport: failProtocolV2Get,
    });

    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).rejects.toMatchObject({ type: RemoteErrorType.ServerError });
  });
});

describe("W2b2b1 创建、读取与冲突", () => {
  it("V2/V3 创建：精确 id、字节一致、eTag 来自 PROPFIND、重复创建不写目标", async () => {
    const { provider, client } = await createProvider();
    const v2Content =
      '{"schemaVersion":1,"kind":"easy-sync-v2-protocol","note":"共享协议 ✓"}';
    const v3Content =
      '{"schemaVersion":1,"kind":"easy-sync-v3-protocol","generation":"gen-1"}';

    const v2 = await provider.createSharedSyncProtocolV2("vault", v2Content);
    expect(v2.id).toBe(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    expect(v2.eTag).not.toBe("");
    expect(fixture.fake.readText(V2_REMOTE)).toBe(v2Content);
    await expect(
      client.stat(WEBDAV_SHARED_PROTOCOL_V2_PATH),
    ).resolves.toMatchObject({ eTag: v2.eTag });
    await expect(
      provider.readSharedSyncProtocolV2ById(v2.id),
    ).resolves.toEqual({
      id: WEBDAV_SHARED_PROTOCOL_V2_PATH,
      eTag: v2.eTag,
      content: v2Content,
    });

    const v3 = await provider.createSharedSyncProtocolV3("vault", v3Content);
    expect(v3.id).toBe(WEBDAV_SHARED_PROTOCOL_V3_PATH);
    expect(fixture.fake.readText(V3_REMOTE)).toBe(v3Content);
    await expect(
      client.stat(WEBDAV_SHARED_PROTOCOL_V3_PATH),
    ).resolves.toMatchObject({ eTag: v3.eTag });
    await expect(
      provider.readSharedSyncProtocolV3ById(v3.id),
    ).resolves.toEqual({
      id: WEBDAV_SHARED_PROTOCOL_V3_PATH,
      eTag: v3.eTag,
      content: v3Content,
    });

    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).resolves.toEqual({
      v2: {
        id: WEBDAV_SHARED_PROTOCOL_V2_PATH,
        eTag: v2.eTag,
        content: v2Content,
      },
      v3: {
        id: WEBDAV_SHARED_PROTOCOL_V3_PATH,
        eTag: v3.eTag,
        content: v3Content,
      },
    });

    const v2Before = fixture.fake.getResource(V2_REMOTE)!;
    await expect(
      provider.createSharedSyncProtocolV2("vault", "collision"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolConflictError);
    const v2After = fixture.fake.getResource(V2_REMOTE)!;
    expect(v2After.sha256).toBe(v2Before.sha256);
    expect(v2After.putCount).toBe(v2Before.putCount);
    expect(fixture.fake.readText(V2_REMOTE)).toBe(v2Content);

    const v3Before = fixture.fake.getResource(V3_REMOTE)!;
    await expect(
      provider.createSharedSyncProtocolV3("vault", "collision"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolConflictError);
    const v3After = fixture.fake.getResource(V3_REMOTE)!;
    expect(v3After.sha256).toBe(v3Before.sha256);
    expect(v3After.putCount).toBe(v3Before.putCount);
    expect(fixture.fake.readText(V3_REMOTE)).toBe(v3Content);
  });

  it("坚果云画像：create 走 .easy-sync/tmp 临时名 MOVE，不直接 PUT 槽位", async () => {
    const { provider } = await createProvider({ profiles: NUTSTORE_PROFILES });
    const content =
      '{"schemaVersion":1,"kind":"easy-sync-v3-protocol","generation":"nutstore"}';

    const created = await provider.createSharedSyncProtocolV3(
      "vault",
      content,
    );

    const puts = fixture.fake.requests.filter(
      (request) => request.method === "PUT",
    );
    expect(puts.some((request) => request.decodedPath === V3_REMOTE)).toBe(false);
    expect(
      puts.some((request) =>
        /^\/vault\/\.easy-sync\/tmp\/create-[^/]+$/.test(request.decodedPath)
      ),
    ).toBe(true);
    const moves = fixture.fake.requests.filter(
      (request) => request.method === "MOVE",
    );
    expect(
      moves.some((request) =>
        request.destination !== null
        && new URL(request.destination).pathname === V3_REMOTE
      ),
    ).toBe(true);
    expect(fixture.fake.readText(V3_REMOTE)).toBe(content);
    expect(created.eTag).toBe(fixture.fake.getResource(V3_REMOTE)!.eTag);

    const before = fixture.fake.getResource(V3_REMOTE)!;
    await expect(
      provider.createSharedSyncProtocolV3("vault", "collision"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolConflictError);
    const after = fixture.fake.getResource(V3_REMOTE)!;
    expect(after.sha256).toBe(before.sha256);
    expect(after.putCount).toBe(before.putCount);
    expect(fixture.fake.readText(V3_REMOTE)).toBe(content);
  });

  it("readById 只接受精确槽位路径；缺失槽位返回 NotFound", async () => {
    const { provider } = await createProvider();
    const requestsBefore = fixture.fake.requests.length;

    await expect(
      provider.readSharedSyncProtocolV2ById("notes.md"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolSlotError);
    await expect(
      provider.readSharedSyncProtocolV2ById(WEBDAV_SHARED_PROTOCOL_V3_PATH),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolSlotError);
    await expect(
      provider.readSharedSyncProtocolV3ById(WEBDAV_SHARED_PROTOCOL_V2_PATH),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolSlotError);
    await expect(
      provider.overwriteSharedSyncProtocolV2(
        WEBDAV_SHARED_PROTOCOL_V3_PATH,
        '"not-v2"',
        "{}",
      ),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolSlotError);
    expect(fixture.fake.requests.length).toBe(requestsBefore);

    await expect(
      provider.readSharedSyncProtocolV2ById(WEBDAV_SHARED_PROTOCOL_V2_PATH),
    ).rejects.toMatchObject({ type: RemoteErrorType.NotFound });
  });

  it("V2 覆盖：陈旧 eTag 412 且字节不变，当前 eTag 更新并换 ETag", async () => {
    const { provider, client } = await createProvider();
    const created = await provider.createSharedSyncProtocolV2(
      "vault",
      '{"v":2,"state":"initial"}',
    );

    const movedOn = '{"v":2,"state":"moved-on"}';
    fixture.fake.seedFile(V2_REMOTE, movedOn);
    const staleSnapshot = fixture.fake.getResource(V2_REMOTE)!;
    const repaired = '{"v":2,"state":"repaired"}';

    await expect(
      provider.overwriteSharedSyncProtocolV2(
        WEBDAV_SHARED_PROTOCOL_V2_PATH,
        created.eTag,
        repaired,
      ),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolConflictError);
    const afterStale = fixture.fake.getResource(V2_REMOTE)!;
    expect(afterStale.sha256).toBe(staleSnapshot.sha256);
    expect(afterStale.putCount).toBe(staleSnapshot.putCount);
    expect(fixture.fake.readText(V2_REMOTE)).toBe(movedOn);

    const updated = await provider.overwriteSharedSyncProtocolV2(
      WEBDAV_SHARED_PROTOCOL_V2_PATH,
      staleSnapshot.eTag,
      repaired,
    );
    expect(updated.id).toBe(WEBDAV_SHARED_PROTOCOL_V2_PATH);
    expect(updated.eTag).not.toBe(staleSnapshot.eTag);
    expect(fixture.fake.readText(V2_REMOTE)).toBe(repaired);
    await expect(
      client.stat(WEBDAV_SHARED_PROTOCOL_V2_PATH),
    ).resolves.toMatchObject({ eTag: updated.eTag });
  });
});

describe("W2b2b1 ETag 与字节上限 fail-closed", () => {
  it("弱 ETag：创建 fail-closed", async () => {
    const { provider } = await createProvider({ profiles: ["weak-etag"] });

    await expect(
      provider.createSharedSyncProtocolV2("vault", "{}"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolEtagError);
  });

  it("弱 ETag：读取 fail-closed", async () => {
    const { provider } = await createProvider();
    fixture.fake.seedFile(V2_REMOTE, '{"v":2}');
    fixture.fake.setProfiles(["weak-etag"]);

    await expect(
      provider.readSharedSyncProtocolV2ById(WEBDAV_SHARED_PROTOCOL_V2_PATH),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolEtagError);
    await expect(
      provider.readSharedSyncProtocolObjects("vault"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolEtagError);
  });

  it("缺失 ETag：创建 fail-closed", async () => {
    const { provider } = await createProvider({ wrapTransport: withoutETags });

    await expect(
      provider.createSharedSyncProtocolV2("vault", "{}"),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolEtagError);
  });

  it("更新拒绝空或弱 If-Match，且不发写入请求", async () => {
    const { provider } = await createProvider();
    await provider.createSharedSyncProtocolV2("vault", "{}");
    const requestsBefore = fixture.fake.requests.length;

    await expect(
      provider.overwriteSharedSyncProtocolV2(
        WEBDAV_SHARED_PROTOCOL_V2_PATH,
        "",
        "{}",
      ),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolEtagError);
    await expect(
      provider.overwriteSharedSyncProtocolV2(
        WEBDAV_SHARED_PROTOCOL_V2_PATH,
        'W/"weak"',
        "{}",
      ),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolEtagError);
    expect(fixture.fake.requests.length).toBe(requestsBefore);
  });

  it("内容超过 1 MiB 在发请求前拒绝", async () => {
    const { provider } = await createProvider();
    const huge = "x".repeat(MAX_SHARED_PROTOCOL_BYTES + 1);

    const createRequestsBefore = fixture.fake.requests.length;
    await expect(
      provider.createSharedSyncProtocolV2("vault", huge),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolTooLargeError);
    expect(fixture.fake.requests.length).toBe(createRequestsBefore);

    const created = await provider.createSharedSyncProtocolV2(
      "vault",
      '{"v":2}',
    );
    const updateRequestsBefore = fixture.fake.requests.length;
    await expect(
      provider.overwriteSharedSyncProtocolV2(
        WEBDAV_SHARED_PROTOCOL_V2_PATH,
        created.eTag,
        huge,
      ),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolTooLargeError);
    expect(fixture.fake.requests.length).toBe(updateRequestsBefore);
  });

  it("声明长度缺失时仍按实际 GET 字节拒绝 >1 MiB", async () => {
    fixture.fake.seedFile(V2_REMOTE, '{"v":2}');
    const { provider } = await createProvider({
      wrapTransport: hideLengthsAndServeOversizedBody,
    });

    await expect(
      provider.readSharedSyncProtocolV2ById(WEBDAV_SHARED_PROTOCOL_V2_PATH),
    ).rejects.toBeInstanceOf(WebDavSharedProtocolTooLargeError);
  });
});
