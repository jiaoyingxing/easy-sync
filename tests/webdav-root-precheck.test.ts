/**
 * S3 根目录只读预检：三档结论（用户 2026-11-23 拍板 Q2A，不做「接管已有内容」）。
 *
 * 这一层只判**保存那一刻**该不该放行，不写任何远端状态。真正的安全闸仍在
 * 同步引导里（`ensureWebDavScopeMarker`＋`WebDavRuntimeNeedsConfirmationError`）。
 *
 * 用假传输（按 method／path 路由）验证四处：
 * 1. 自己以前用过（标记身份与库名都对上）→ 放行；
 * 2. 全新但非空 → 拒绝（提示换空文件夹）；
 * 3. 被别的库占用 → 拒绝（并说明是别的库）；
 * 4. 预检执行失败 → 返回 null（＝没结论，照常保存，不把加固变成门槛）。
 */
import { describe, expect, it } from "vitest";
import { precheckWebDavRoot } from "../src/cloud/webdav-root-precheck";
import type {
  WebDavHttpRequest,
  WebDavHttpResponse,
  WebDavTransport,
} from "../src/providers/webdav/webdav-probe";
import {
  buildWebDavScopeFields,
  buildWebDavScopeId,
  serializeWebDavScopeMarker,
} from "../src/providers/webdav/webdav-scope";

const COORDINATES = {
  url: "https://nas.example.com",
  username: "alice",
  rootPrefix: "EasySync",
};
const VAULT_NAME = "MyVault";

function encode(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

function multistatus(
  entries: Array<{ path: string; isFolder: boolean; size: number }>,
): string {
  const rows = entries.map((entry) => `
  <d:response>
    <d:href>${entry.path}</d:href>
    <d:propstat><d:prop>
      <d:resourcetype>${entry.isFolder ? "<d:collection/>" : ""}</d:resourcetype>
      <d:getcontentlength>${entry.size}</d:getcontentlength>
      <d:getetag>"etag"</d:getetag>
      <d:getlastmodified>Mon, 23 Nov 2026 10:00:00 GMT</d:getlastmodified>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">${rows}
</d:multistatus>`;
}

interface FakeRemote {
  /** 根下的非控制面条目（空数组＝空目录）。 */
  readonly rootEntries?: ReadonlyArray<{ path: string; isFolder: boolean }>;
  /** 根下的标记内容；undefined＝没有标记。 */
  readonly marker?: string;
  /** 让所有请求直接失败（模拟网络／服务器不支持）。 */
  readonly failAll?: boolean;
}

const ROOT = "/EasySync";
const MARKER_PATH = `${ROOT}/.easy-sync/scope.json`;

/**
 * 按路径路由的假传输。
 *
 * 必须够真：`readFile` 是「PROPFIND Depth 0 拿 stat → GET 拿字节」两步，
 * 而且会校验字节长度与 stat 一致；只按 method 回一个粗粒度的响应会让
 * 标记读取永远失败（预检因此静默退化成「没结论」）。
 */
function transport(remote: FakeRemote): WebDavTransport {
  return async (request: WebDavHttpRequest): Promise<WebDavHttpResponse> => {
    if (remote.failAll) throw new Error("network down");
    const path = new URL(request.url).pathname;
    const isMarker = path === MARKER_PATH;
    const isRoot = path === ROOT || path === `${ROOT}/`;

    if (request.method === "GET") {
      if (isMarker && remote.marker !== undefined) {
        const body = encode(remote.marker);
        return { status: 200, headers: { etag: '"marker"' }, body };
      }
      if (isMarker) return { status: 404, headers: {}, body: new ArrayBuffer(0) };
      return { status: 404, headers: {}, body: new ArrayBuffer(0) };
    }
    if (request.method === "PROPFIND") {
      if (isMarker) {
        if (remote.marker === undefined) {
          return { status: 404, headers: {}, body: new ArrayBuffer(0) };
        }
        const body = encode(remote.marker);
        return {
          status: 207,
          headers: { "content-type": "application/xml" },
          body: encode(multistatus([
            { path: MARKER_PATH, isFolder: false, size: body.byteLength },
          ])),
        };
      }
      if (isRoot) {
        return {
          status: 207,
          headers: { "content-type": "application/xml" },
          body: encode(multistatus(
            (remote.rootEntries ?? []).map((entry) => ({ ...entry, size: 1 })),
          )),
        };
      }
      return { status: 404, headers: {}, body: new ArrayBuffer(0) };
    }
    return { status: 405, headers: {}, body: new ArrayBuffer(0) };
  };
}

/** 造一份「属于某个库、某个 scope」的远端标记。 */
async function markerFor(
  vaultName: string,
  coordinates: { url: string; username: string; rootPrefix: string },
): Promise<string> {
  const fields = await buildWebDavScopeFields({
    endpoint: new URL(coordinates.url).origin,
    rootPath: `/${coordinates.rootPrefix}`,
    username: coordinates.username,
  });
  const scopeId = await buildWebDavScopeId(fields);
  return serializeWebDavScopeMarker({
    schemaVersion: 1,
    providerKind: "webdav",
    vaultName,
    scopeId,
    createdAt: "2026-11-01T00:00:00.000Z",
  });
}

describe("S3 根目录只读预检", () => {
  it("空目录：放行", async () => {
    const verdict = await precheckWebDavRoot({
      coordinates: COORDINATES,
      password: "pw",
      vaultName: VAULT_NAME,
      transport: transport({ rootEntries: [] }),
    });
    expect(verdict).toEqual({ action: "allow", kind: "empty" });
  });

  it("自己以前用过（标记身份与库名都对上）：静默放行", async () => {
    const verdict = await precheckWebDavRoot({
      coordinates: COORDINATES,
      password: "pw",
      vaultName: VAULT_NAME,
      transport: transport({
        marker: await markerFor(VAULT_NAME, COORDINATES),
        rootEntries: [{ path: "/EasySync/note.md", isFolder: false }],
      }),
    });
    expect(verdict).toEqual({ action: "allow", kind: "own" });
  });

  it("全新目录但里面有文件：拒绝，且报出条目数", async () => {
    const verdict = await precheckWebDavRoot({
      coordinates: COORDINATES,
      password: "pw",
      vaultName: VAULT_NAME,
      transport: transport({
        rootEntries: [
          { path: "/EasySync/a.md", isFolder: false },
          { path: "/EasySync/b.md", isFolder: false },
        ],
      }),
    });
    expect(verdict).toEqual({
      action: "refuse",
      kind: "existing-content",
      entryCount: 2,
    });
  });

  it("扫描器自己的控制面目录不算内容（只有一个空 .easy-sync 时仍放行）", async () => {
    const verdict = await precheckWebDavRoot({
      coordinates: COORDINATES,
      password: "pw",
      vaultName: VAULT_NAME,
      transport: transport({
        rootEntries: [{ path: "/EasySync/.easy-sync", isFolder: true }],
      }),
    });
    expect(verdict).toEqual({ action: "allow", kind: "empty" });
  });

  it("被别的笔记库占用：拒绝，且指明是别的库", async () => {
    const verdict = await precheckWebDavRoot({
      coordinates: COORDINATES,
      password: "pw",
      vaultName: VAULT_NAME,
      transport: transport({
        marker: await markerFor("AnotherVault", COORDINATES),
        rootEntries: [{ path: "/EasySync/a.md", isFolder: false }],
      }),
    });
    expect(verdict).toEqual({ action: "refuse", kind: "other-vault" });
  });

  it("同一个库名但换了地址或账号（接管态）：按「已经有内容」拒绝", async () => {
    // 本轮的边界（用户拍板 Q2A）：不做「接管已有内容」的同意通路，所以这一档
    // 与「全新非空」同归为「请换一个空文件夹」，而不是静默接管别人的内容。
    const verdict = await precheckWebDavRoot({
      coordinates: COORDINATES,
      password: "pw",
      vaultName: VAULT_NAME,
      transport: transport({
        marker: await markerFor(VAULT_NAME, {
          ...COORDINATES,
          username: "someone-else",
        }),
      }),
    });
    expect(verdict).toEqual({
      action: "refuse",
      kind: "existing-content",
      entryCount: 0,
    });
  });

  it("预检执行失败：返回 null（照常保存，不把加固变成门槛）", async () => {
    const verdict = await precheckWebDavRoot({
      coordinates: COORDINATES,
      password: "pw",
      vaultName: VAULT_NAME,
      transport: transport({ failAll: true }),
    });
    expect(verdict).toBeNull();
  });
});
