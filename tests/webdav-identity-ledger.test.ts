import { describe, expect, it } from "vitest";
import {
  WebDavClient,
  type WebDavClientCredentials,
} from "../src/providers/webdav/webdav-client";
import {
  bindIdentity,
  confirmRebuild,
  idForPath,
  IdentityLedgerConflictError,
  IdentityLedgerIdentityConflictError,
  IdentityLedgerRebuildNotAllowedError,
  IdentityLedgerTooLargeError,
  IdentityLedgerUnknownIdentityError,
  IdentityLedgerUnsafeWriteError,
  identityLedgerPolicy,
  loadIdentityLedger,
  markVerified,
  moveIdentity,
  parseIdentityLedger,
  pathForId,
  rebuildIdentityLedger,
  removeIdentity,
  saveIdentityLedger,
  serializeIdentityLedger,
  validateLedger,
  webDavIdentityLedgerPath,
  WEBDAV_IDENTITY_LEDGER_PATH,
  WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION,
  WEBDAV_IDENTITY_MAX_LEDGER_BYTES,
  WEBDAV_IDENTITY_MAX_PATH_LENGTH,
  type WebDavIdentityLedgerV1,
} from "../src/providers/webdav/webdav-identity-ledger";
import { webdavCapabilities } from "../src/providers/webdav/webdav-probe";
import type { WebDavTransport } from "../src/providers/webdav/webdav-probe";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials: WebDavClientCredentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};
const LEDGER_PATH = webDavIdentityLedgerPath("/vault");
const UPDATED_AT = "2026-11-19T00:00:00.000Z";
const ID_A = "00000000000000000000000000000001";
const ID_B = "00000000000000000000000000000002";
const ID_C = "00000000000000000000000000000003";

const NUTSTORE_PROFILE: readonly FakeWebDavProfile[] = [
  "ignore-if-none-match",
  "ignore-delete-if-match",
  "move-conflict-on-overwrite",
  "depth-infinity-as-one",
  "no-head-length",
  "mkcol-existing-201",
];

async function makeClient(
  profiles: readonly FakeWebDavProfile[] = NUTSTORE_PROFILE,
): Promise<WebDavClient> {
  fixture.fake.setProfiles(profiles);
  const client = new WebDavClient({
    endpoint,
    credentials,
    transport: fixture.transport,
  });
  await client.initialize();
  return client;
}

function ledgerOf(entries: Record<string, string>): WebDavIdentityLedgerV1 {
  return {
    schemaVersion: WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION,
    updatedAt: UPDATED_AT,
    entries,
  };
}

function validObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION,
    updatedAt: UPDATED_AT,
    entries: { [ID_A]: "Notes/a.md" },
    ...overrides,
  };
}

function validJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(validObject(overrides));
}

function requestsTo(method: string, path: string) {
  return fixture.fake.requests.filter(
    (request) => request.method === method && request.decodedPath === path,
  );
}

/** 模拟不返回 ETag 的服务器：PROPFIND 的 DAV 属性里没有 getetag。 */
function withoutETags(transport: WebDavTransport): WebDavTransport {
  return async (request) => {
    const response = await transport(request);
    if (request.method !== "PROPFIND") return response;
    const text = new TextDecoder("utf-8").decode(new Uint8Array(response.body));
    const stripped = text.replace(/<d:getetag>[\s\S]*?<\/d:getetag>/g, "");
    return {
      ...response,
      body: new TextEncoder().encode(stripped).buffer,
    };
  };
}

function credentialObject(): WebDavClientCredentials {
  return { ...credentials };
}

describe("WebDAV W1.6 身份账本格式与纯函数", () => {
  it("账本路径、schema 与大小上限固定", () => {
    expect(WEBDAV_IDENTITY_LEDGER_PATH).toBe(".easy-sync/identity.json");
    expect(LEDGER_PATH).toBe("/vault/.easy-sync/identity.json");
    expect(WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION).toBe(1);
    expect(WEBDAV_IDENTITY_MAX_PATH_LENGTH).toBe(1024);
    expect(WEBDAV_IDENTITY_MAX_LEDGER_BYTES).toBe(8 * 1024 * 1024);
  });

  it("规范序列化：字段顺序固定、entries 按 uuid 排序", () => {
    const ledger = ledgerOf({
      [ID_C]: "Notes/c.md",
      [ID_A]: "Notes/a.md",
      [ID_B]: "Notes/b.md",
    });

    const first = serializeIdentityLedger(ledger);
    const second = serializeIdentityLedger(ledger);

    expect(first).toBe(second);
    expect(first.indexOf(`"${ID_A}"`)).toBeLessThan(first.indexOf(`"${ID_B}"`));
    expect(first.indexOf(`"${ID_B}"`)).toBeLessThan(first.indexOf(`"${ID_C}"`));
    expect(first.startsWith(`{"schemaVersion":1,"updatedAt":"${UPDATED_AT}","entries":{`)).toBe(true);

    const parsed = parseIdentityLedger(first);
    expect(parsed.ok).toBe(true);
    expect(parsed.ledger?.entries).toEqual(ledger.entries);
  });

  it("validateLedger 拒绝版本不符、坏 uuid、非规范 path 与重复 path", () => {
    const cases: Array<[string, unknown]> = [
      ["schema-version", validObject({ schemaVersion: 2 })],
      ["bad-updated-at", validObject({ updatedAt: "not-a-date" })],
      ["entries", validObject({ entries: [] })],
      ["bad-uuid", validObject({ entries: { nothex: "Notes/a.md" } })],
      ["leading-slash", validObject({ entries: { [ID_A]: "/Notes/a.md" } })],
      ["trailing-slash", validObject({ entries: { [ID_A]: "Notes/a.md/" } })],
      ["duplicate-slash", validObject({ entries: { [ID_A]: "Notes//a.md" } })],
      ["dot-segment", validObject({ entries: { [ID_A]: "Notes/../a.md" } })],
      ["dot-only", validObject({ entries: { [ID_A]: "." } })],
      ["empty-path", validObject({ entries: { [ID_A]: "" } })],
      ["control-char", validObject({ entries: { [ID_A]: "Notes/a\u0000b.md" } })],
      ["too-long-path", validObject({ entries: { [ID_A]: "a".repeat(WEBDAV_IDENTITY_MAX_PATH_LENGTH + 1) } })],
      ["duplicate-path", validObject({ entries: { [ID_A]: "Notes/a.md", [ID_B]: "Notes/a.md" } })],
      ["extra-field", { ...validObject(), unexpected: true }],
    ];

    for (const [label, value] of cases) {
      const result = validateLedger(value);
      expect(result.ok, label).toBe(false);
      expect(result.issue, label).not.toBeNull();
    }

    const valid = validateLedger(validObject());
    expect(valid.ok).toBe(true);
    expect(valid.ledger?.entries[ID_A]).toBe("Notes/a.md");
  });

  it("bind/move/remove 只改账本、不推断远端删除", () => {
    const bound = bindIdentity(ledgerOf({}), "Notes/a.md", { id: ID_A });
    expect(bound.entries[ID_A]).toBe("Notes/a.md");
    expect(idForPath(bound, "Notes/a.md")).toBe(ID_A);
    expect(pathForId(bound, ID_A)).toBe("Notes/a.md");

    const idempotent = bindIdentity(bound, "Notes/a.md");
    expect(idempotent.entries).toEqual(bound.entries);

    const withSecond = bindIdentity(bound, "Notes/b.md", { id: ID_B });
    const moved = moveIdentity(withSecond, ID_A, "Archive/a.md");
    expect(moved.entries[ID_A]).toBe("Archive/a.md");
    expect(idForPath(moved, "Notes/a.md")).toBeNull();
    expect(idForPath(moved, "Archive/a.md")).toBe(ID_A);

    expect(() => moveIdentity(moved, ID_A, "Notes/b.md")).toThrow(
      IdentityLedgerIdentityConflictError,
    );
    expect(() => moveIdentity(moved, ID_C, "Notes/c.md")).toThrow(
      IdentityLedgerUnknownIdentityError,
    );

    const removed = removeIdentity(moved, ID_A);
    expect(pathForId(removed, ID_A)).toBeNull();
    expect(pathForId(removed, ID_B)).toBe("Notes/b.md");
    expect(Object.keys(removed.entries)).toHaveLength(1);
  });

  it("超过 8 MiB 时返回 too-large、状态 unverified 且不写入", async () => {
    const entries: Record<string, string> = {};
    const shared = "x".repeat(WEBDAV_IDENTITY_MAX_PATH_LENGTH - 8);
    for (let index = 0; index < 8_400; index += 1) {
      entries[index.toString(16).padStart(32, "0")] = `${shared}/${index.toString(36)}`;
    }
    const huge = ledgerOf(entries);

    let tooLarge: unknown = null;
    try {
      serializeIdentityLedger(huge);
    } catch (error) {
      tooLarge = error;
    }
    expect(tooLarge).toBeInstanceOf(IdentityLedgerTooLargeError);
    const error = tooLarge as IdentityLedgerTooLargeError;
    expect(error.state).toBe("unverified");
    expect(error.policy.autoDeleteAllowed).toBe(false);
    expect(error.policy.autoRenameAllowed).toBe(false);
    expect(error.policy.requiresUserConfirmation).toBe(true);
    expect(error.maxBytes).toBe(WEBDAV_IDENTITY_MAX_LEDGER_BYTES);

    const client = await makeClient();
    await expect(
      saveIdentityLedger(client, huge, { kind: "create" }),
    ).rejects.toBeInstanceOf(IdentityLedgerTooLargeError);
    expect(requestsTo("PUT", LEDGER_PATH)).toHaveLength(0);
  });

  it("策略函数只有 verified 允许自动删除与自动改名", () => {
    for (const state of [
      "missing",
      "corrupt",
      "unavailable",
      "read-only",
      "unverified",
    ] as const) {
      const policy = identityLedgerPolicy(state);
      expect(policy.autoDeleteAllowed, state).toBe(false);
      expect(policy.autoRenameAllowed, state).toBe(false);
      expect(policy.requiresUserConfirmation, state).toBe(true);
    }
    expect(identityLedgerPolicy("verified")).toEqual({
      state: "verified",
      autoDeleteAllowed: true,
      autoRenameAllowed: true,
      requiresUserConfirmation: false,
    });
  });
});

describe("WebDAV W1.6 身份账本读取与写入", () => {
  it("通过 staged-MOVE 创建，回读为 verified 并带强 ETag", async () => {
    const client = await makeClient();
    const ledger = ledgerOf({ [ID_A]: "Notes/a.md" });

    const saved = await saveIdentityLedger(client, ledger, { kind: "create" });
    expect(saved.strategy).toBe("staged-move");
    expect(saved.state).toBe("verified");
    expect(saved.canUpdate).toBe(true);
    expect(saved.eTag).not.toBeNull();
    expect(requestsTo("PUT", LEDGER_PATH)).toHaveLength(0);

    const moves = fixture.fake.requests.filter(
      (request) =>
        request.method === "MOVE"
        && request.destination !== null
        && new URL(request.destination).pathname === LEDGER_PATH,
    );
    expect(moves).toHaveLength(1);

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("verified");
    expect(loaded.policy.autoDeleteAllowed).toBe(true);
    expect(loaded.policy.autoRenameAllowed).toBe(true);
    expect(loaded.policy.requiresUserConfirmation).toBe(false);
    expect(loaded.eTag).not.toBeNull();
    expect(loaded.eTag).toBe(saved.eTag);
    expect(loaded.ledger).toEqual(saved.ledger);
  });

  it("If-Match 更新成功；陈旧 ETag 进入 conflict 且不覆盖远端", async () => {
    const client = await makeClient();
    const saved = await saveIdentityLedger(
      client,
      ledgerOf({ [ID_A]: "Notes/a.md" }),
      { kind: "create" },
    );
    expect(saved.eTag).not.toBeNull();

    const loaded = await loadIdentityLedger(client);
    const next = bindIdentity(loaded.ledger ?? ledgerOf({}), "Notes/b.md", {
      id: ID_B,
    });
    const updated = await saveIdentityLedger(client, next, {
      kind: "update",
      eTag: loaded.eTag ?? "",
    });
    expect(updated.eTag).not.toBeNull();

    const updatePuts = requestsTo("PUT", LEDGER_PATH).filter(
      (request) => request.ifMatch !== null,
    );
    expect(updatePuts).toHaveLength(1);
    expect(updatePuts[0].ifMatch).toBe(loaded.eTag);

    const reloaded = await loadIdentityLedger(client);
    expect(reloaded.ledger?.entries).toEqual({
      [ID_A]: "Notes/a.md",
      [ID_B]: "Notes/b.md",
    });

    const before = fixture.fake.readText(LEDGER_PATH);
    const stale = bindIdentity(reloaded.ledger ?? ledgerOf({}), "Notes/c.md", {
      id: ID_C,
    });
    let conflict: unknown = null;
    try {
      await saveIdentityLedger(client, stale, {
        kind: "update",
        eTag: loaded.eTag ?? "",
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(IdentityLedgerConflictError);
    const conflictError = conflict as IdentityLedgerConflictError;
    expect(conflictError.remote.state).toBe("verified");
    expect(conflictError.remote.ledger?.entries).toEqual(reloaded.ledger?.entries);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(before);
  });

  it("缺失账本读为 missing，策略全部关闭", async () => {
    const client = await makeClient();
    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("missing");
    expect(loaded.ledger).toBeNull();
    expect(loaded.eTag).toBeNull();
    expect(loaded.canUpdate).toBe(false);
    expect(loaded.policy.autoDeleteAllowed).toBe(false);
    expect(loaded.policy.autoRenameAllowed).toBe(false);
    expect(loaded.policy.requiresUserConfirmation).toBe(true);
  });

  it("损坏／版本不符／重复 path／空 path／超长 path 读为 corrupt，策略关闭", async () => {
    const client = await makeClient();
    const cases: Array<[string, string]> = [
      ["invalid-json", "{"],
      ["schema-version", validJson({ schemaVersion: 2 })],
      ["duplicate-path", validJson({ entries: { [ID_A]: "a.md", [ID_B]: "a.md" } })],
      ["empty-path", validJson({ entries: { [ID_A]: "" } })],
      ["too-long-path", validJson({ entries: { [ID_A]: "a".repeat(WEBDAV_IDENTITY_MAX_PATH_LENGTH + 1) } })],
      ["control-char", validJson({ entries: { [ID_A]: "a\u0000b.md" } })],
    ];

    for (const [label, body] of cases) {
      fixture.fake.seedFile(LEDGER_PATH, body);
      const loaded = await loadIdentityLedger(client);
      expect(loaded.state, label).toBe("corrupt");
      expect(loaded.ledger, label).toBeNull();
      expect(loaded.policy.autoDeleteAllowed, label).toBe(false);
      expect(loaded.policy.autoRenameAllowed, label).toBe(false);
      expect(loaded.policy.requiresUserConfirmation, label).toBe(true);
    }
  });

  it("弱 ETag 读为 read-only；弱 ETag 不能用于更新", async () => {
    const client = await makeClient(["weak-etag"]);
    fixture.fake.seedFile(LEDGER_PATH, validJson());

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("read-only");
    expect(loaded.weakETag).toBe(true);
    expect(loaded.eTag).toBeNull();
    expect(loaded.canUpdate).toBe(false);
    expect(loaded.policy.autoDeleteAllowed).toBe(false);

    await expect(
      saveIdentityLedger(client, ledgerOf({ [ID_A]: "a.md" }), {
        kind: "update",
        eTag: "",
      }),
    ).rejects.toBeInstanceOf(IdentityLedgerUnsafeWriteError);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(validJson());
  });

  it("无 ETag 读为 read-only；无 ETag 更新 fail-closed", async () => {
    fixture.fake.setProfiles(["strict"]);
    const client = new WebDavClient({
      endpoint,
      credentials: credentialObject(),
      transport: withoutETags(fixture.transport),
    });
    await client.initialize();
    fixture.fake.seedFile(LEDGER_PATH, validJson());

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("read-only");
    expect(loaded.weakETag).toBe(false);
    expect(loaded.eTag).toBeNull();
    expect(loaded.canUpdate).toBe(false);

    const putsBefore = requestsTo("PUT", LEDGER_PATH).length;
    await expect(
      saveIdentityLedger(client, ledgerOf({ [ID_A]: "a.md" }), {
        kind: "update",
        eTag: "",
      }),
    ).rejects.toBeInstanceOf(IdentityLedgerUnsafeWriteError);
    expect(requestsTo("PUT", LEDGER_PATH)).toHaveLength(putsBefore);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(validJson());
  });

  it("强 ETag 但服务器不认 If-Match 时仍为 read-only", async () => {
    const client = await makeClient(["no-if-match"]);
    fixture.fake.seedFile(LEDGER_PATH, validJson());

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("read-only");
    expect(loaded.eTag).not.toBeNull();
    expect(loaded.canUpdate).toBe(false);
    expect(loaded.policy.autoDeleteAllowed).toBe(false);

    await expect(
      saveIdentityLedger(client, ledgerOf({ [ID_A]: "a.md" }), {
        kind: "update",
        eTag: loaded.eTag ?? "",
      }),
    ).rejects.toBeInstanceOf(IdentityLedgerUnsafeWriteError);
  });

  it("网络／权限失败读为 unavailable", async () => {
    fixture.fake.setProfiles(["strict"]);
    const client = new WebDavClient({
      endpoint,
      credentials: credentialObject(),
      transport: async () => ({
        status: 403,
        headers: {},
        body: new ArrayBuffer(0),
      }),
      capabilities: { ...webdavCapabilities(), conditionalUpdate: true },
    });

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("unavailable");
    expect(loaded.ledger).toBeNull();
    expect(loaded.policy.autoDeleteAllowed).toBe(false);
    expect(loaded.policy.autoRenameAllowed).toBe(false);
    expect(loaded.policy.requiresUserConfirmation).toBe(true);
  });
});

describe("WebDAV W1.6 身份账本重建与确认", () => {
  it("重建为每个 path 分配唯一新 uuid，确认前 unverified、确认后 verified", async () => {
    const client = await makeClient();
    const rebuilt = await rebuildIdentityLedger(client, [
      "Notes/a.md",
      "Notes/b.md",
      "Notes/a.md",
    ]);

    expect(rebuilt.state).toBe("unverified");
    expect(rebuilt.policy.autoDeleteAllowed).toBe(false);
    expect(rebuilt.policy.autoRenameAllowed).toBe(false);
    expect(rebuilt.policy.requiresUserConfirmation).toBe(true);
    expect(Object.keys(rebuilt.ledger.entries)).toHaveLength(2);
    const ids = Object.keys(rebuilt.ledger.entries);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(2);
    expect(Object.values(rebuilt.ledger.entries).sort()).toEqual([
      "Notes/a.md",
      "Notes/b.md",
    ]);

    // 远端内容本身可条件更新（integrity=verified），但重建信任仍是 unverified；
    // W2 必须把「待确认」作为本地状态持久化，不能只靠下一次 load 判定。
    const remote = await loadIdentityLedger(client);
    expect(remote.state).toBe("verified");

    const confirmed = confirmRebuild(rebuilt);
    expect(confirmed.state).toBe("verified");
    expect(confirmed.policy.autoDeleteAllowed).toBe(true);
    expect(confirmed.policy.autoRenameAllowed).toBe(true);
    expect(confirmed.eTag).toBe(rebuilt.eTag);
    expect(confirmed.ledger).toEqual(rebuilt.ledger);

    const marked = markVerified(remote);
    expect(marked.state).toBe("verified");
    expect(marked.policy.autoDeleteAllowed).toBe(true);
  });

  it("健康 verified 账本无显式确认拒绝重建，确认后才重置 uuid", async () => {
    const client = await makeClient();
    await saveIdentityLedger(client, ledgerOf({ [ID_A]: "Notes/a.md" }), {
      kind: "create",
    });
    const beforeText = fixture.fake.readText(LEDGER_PATH);
    const beforeETag = fixture.fake.getResource(LEDGER_PATH)?.eTag;
    const putsBefore = requestsTo("PUT", LEDGER_PATH).length;
    const movesBefore = fixture.fake.requests.filter(
      (request) => request.method === "MOVE",
    ).length;

    let rejection: unknown = null;
    try {
      await rebuildIdentityLedger(client, ["Notes/a.md", "Notes/b.md"]);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(IdentityLedgerRebuildNotAllowedError);
    expect((rejection as IdentityLedgerRebuildNotAllowedError).state).toBe("verified");
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(beforeText);
    expect(fixture.fake.getResource(LEDGER_PATH)?.eTag).toBe(beforeETag);
    expect(requestsTo("PUT", LEDGER_PATH)).toHaveLength(putsBefore);
    expect(
      fixture.fake.requests.filter((request) => request.method === "MOVE"),
    ).toHaveLength(movesBefore);

    const rebuilt = await rebuildIdentityLedger(
      client,
      ["Notes/a.md", "Notes/b.md"],
      { confirmedReset: true },
    );
    expect(rebuilt.state).toBe("unverified");
    expect(rebuilt.policy.autoDeleteAllowed).toBe(false);
    expect(rebuilt.ledger.entries[ID_A]).toBeUndefined();
    const ids = Object.keys(rebuilt.ledger.entries);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(ID_A);
    expect(Object.values(rebuilt.ledger.entries).sort()).toEqual([
      "Notes/a.md",
      "Notes/b.md",
    ]);
  });

  it("损坏账本可条件替换重建，不删除远端文件", async () => {
    const client = await makeClient();
    fixture.fake.seedFile("Notes/a.md", "user-content");
    fixture.fake.seedFile(LEDGER_PATH, "{not-json");

    const rebuilt = await rebuildIdentityLedger(client, ["Notes/a.md"]);
    expect(rebuilt.state).toBe("unverified");
    expect(fixture.fake.readText(LEDGER_PATH)).not.toBe("{not-json");
    expect(fixture.fake.readText("Notes/a.md")).toBe("user-content");
    expect(fixture.fake.mutationCounts(LEDGER_PATH).delete).toBe(0);

    const loaded = await loadIdentityLedger(client);
    expect(loaded.state).toBe("verified");
    expect(Object.values(loaded.ledger?.entries ?? {})).toEqual(["Notes/a.md"]);
  });

  it("弱 ETag 的健康账本默认拒绝重建，显式确认后仍 fail-closed", async () => {
    const client = await makeClient(["weak-etag"]);
    fixture.fake.seedFile(LEDGER_PATH, validJson());

    await expect(
      rebuildIdentityLedger(client, ["Notes/a.md"]),
    ).rejects.toBeInstanceOf(IdentityLedgerRebuildNotAllowedError);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(validJson());

    await expect(
      rebuildIdentityLedger(client, ["Notes/a.md"], { confirmedReset: true }),
    ).rejects.toBeInstanceOf(IdentityLedgerUnsafeWriteError);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(validJson());
  });
});
