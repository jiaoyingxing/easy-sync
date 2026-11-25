import { describe, expect, it } from "vitest";
import { WebDavRootNotWritableError } from "../src/providers/webdav/webdav-client";
import {
  identityLedgerPolicy,
  serializeIdentityLedger,
  type WebDavIdentityLedgerV1,
} from "../src/providers/webdav/webdav-identity-ledger";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import {
  buildWebDavScopeFields,
  buildWebDavScopeId,
  buildWebDavScopeMarker,
  serializeWebDavScopeMarker,
  type WebDavScopeFields,
} from "../src/providers/webdav/webdav-scope";
import {
  bootstrapWebDavSync,
  WebDavSyncBootstrapRefusedError,
  type WebDavSyncBootstrapOptions,
} from "../src/providers/webdav/webdav-sync-bootstrap";
import type { FakeWebDavProfile } from "./helpers/fake-webdav";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const driveId = new URL(endpoint).origin;
const credentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};
const VAULT_NAME = "Bootstrap Vault";
const FIXED_NOW = new Date("2026-11-19T12:00:00.000Z");
const MARKER_PATH = "/vault/.easy-sync/scope.json";
const LEDGER_PATH = "/vault/.easy-sync/identity.json";

/** 坚果云 L2 画像：条件创建／条件删除缺失、MOVE 用 409 拒绝覆盖。 */
const NUTSTORE_PROFILES: readonly FakeWebDavProfile[] = [
  "ignore-if-none-match",
  "ignore-delete-if-match",
  "move-conflict-on-overwrite",
  "depth-infinity-as-one",
  "no-head-length",
  "mkcol-existing-201",
];

function bootstrapOptions(
  overrides: Partial<WebDavSyncBootstrapOptions> = {},
): WebDavSyncBootstrapOptions {
  return {
    endpoint,
    credentials,
    transport: fixture.transport,
    vaultName: VAULT_NAME,
    localStatePresent: false,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

async function currentScope(): Promise<{
  fields: WebDavScopeFields;
  scopeId: string;
}> {
  const fields = await buildWebDavScopeFields({
    endpoint,
    rootPath: "/vault",
    username: credentials.username,
  });
  return { fields, scopeId: await buildWebDavScopeId(fields) };
}

function seedMarker(scopeId: string): string {
  const text = serializeWebDavScopeMarker(
    buildWebDavScopeMarker({
      vaultName: VAULT_NAME,
      scopeId,
      createdAt: FIXED_NOW,
    }),
  );
  fixture.fake.seedFile(MARKER_PATH, text);
  return text;
}

function seedLedger(entries: Record<string, string>): string {
  const text = serializeIdentityLedger({
    schemaVersion: 1,
    updatedAt: FIXED_NOW.toISOString(),
    entries,
  });
  fixture.fake.seedFile(LEDGER_PATH, text);
  return text;
}

function destinationPath(request: {
  readonly destination: string | null;
}): string | null {
  const destination = request.destination;
  if (destination === null) return null;
  try {
    return decodeURIComponent(new URL(destination).pathname);
  } catch {
    return null;
  }
}

/** 对远端 path 的写入请求（PUT／MOVE 目标／DELETE）。 */
function writesTo(path: string): ReturnType<typeof filterRequests> {
  return filterRequests(
    (request) =>
      (request.method === "PUT" || request.method === "MOVE" || request.method === "DELETE")
      && (request.decodedPath === path || destinationPath(request) === path),
  );
}

function filterRequests(
  predicate: (request: (typeof fixture.fake.requests)[number]) => boolean,
): (typeof fixture.fake.requests)[number][] {
  return fixture.fake.requests.filter(predicate);
}

function ledgerPaths(ledger: WebDavIdentityLedgerV1 | null): string[] {
  if (ledger === null) return [];
  return Object.values(ledger.entries).sort();
}

function isProbePath(path: string): boolean {
  return path.startsWith("/vault/.easy-sync-probe-")
    || path.startsWith("/vault/.easysync-root-probe-");
}

describe("WebDAV W2b1 启动引导", () => {
  it("空根＋新 scope（坚果云画像）：标记走 staged-MOVE，账本重建 unverified", async () => {
    fixture.fake.setProfiles(NUTSTORE_PROFILES);

    const result = await bootstrapWebDavSync(bootstrapOptions());

    expect(result.scopeMarker.action).toBe("initialize");
    expect(result.scopeMarker.mayWrite).toBe(true);
    expect(result.scopeMarker.markerWritten).toBe(true);
    expect(result.scopeMarker.markerPath).toBe(MARKER_PATH);

    // 坚果云忽略 If-None-Match：标记创建不能直接 PUT 目标，必须临时名→MOVE。
    expect(
      filterRequests(
        (request) => request.method === "PUT" && request.decodedPath === MARKER_PATH,
      ),
    ).toHaveLength(0);
    const markerMoves = filterRequests(
      (request) =>
        request.method === "MOVE" && destinationPath(request) === MARKER_PATH,
    );
    expect(markerMoves).toHaveLength(1);
    expect(markerMoves[0]?.overwrite).toBe("F");

    expect(result.ledger.state).toBe("unverified");
    expect(ledgerPaths(result.ledger.ledger)).toEqual([]);
    expect(result.identityPolicy).toEqual(identityLedgerPolicy("unverified"));
    expect(result.identityPolicy.autoDeleteAllowed).toBe(false);
    expect(result.identityPolicy.autoRenameAllowed).toBe(false);
    expect(result.identityPolicy.requiresUserConfirmation).toBe(true);
    expect(JSON.parse(fixture.fake.readText(LEDGER_PATH) ?? "{}")).toMatchObject({
      schemaVersion: 1,
      entries: {},
    });

    expect(result.scopeFields).toEqual((await currentScope()).fields);
    expect(result.scope).toMatchObject({
      providerKind: "webdav",
      accountId: result.scopeFields.credentialBindingId,
      driveId,
      vaultFolderId: "/",
      filesRootId: "/",
      endpointId: driveId,
      containerId: "",
      rootPath: "/vault",
      credentialBindingId: result.scopeFields.credentialBindingId,
    });
    expect(result.provider).toBeInstanceOf(WebDavProvider);
    expect(result.provider.capabilities).toBe(result.capabilities);
    expect(result.capabilities).toBe(result.client.capabilities);
    expect(result.protocolFacts).toBe(result.client.protocol);
    expect(result.capabilities.conditionalCreate).toBe(false);
    expect(result.capabilities.conditionalDelete).toBe(false);
    expect(result.capabilities.serverSideMove).toBe(true);
    expect(result.capabilities.stableIdentity).toBe(false);
    expect((await result.provider.initVaultScope(VAULT_NAME)).driveId).toBe(driveId);
  });

  it("已有同 scope 标记＋健康账本（默认 trust）：不重建，但暴露为 unverified", async () => {
    const { scopeId } = await currentScope();
    const markerText = seedMarker(scopeId);
    const ledgerText = seedLedger({ ["a".repeat(32)]: "notes.md" });
    fixture.fake.seedFile("/vault/notes.md", "hello");
    const ledgerETag = fixture.fake.getResource(LEDGER_PATH)?.eTag ?? "";
    fixture.fake.requests.length = 0;

    const result = await bootstrapWebDavSync(
      bootstrapOptions({ localStatePresent: true }),
    );

    expect(result.scopeMarker.action).toBe("accept");
    expect(result.scopeMarker.markerWritten).toBe(false);
    // 远端账本本身仍是 verified 事实，但本地尚未确认，暴露状态必须降为 unverified。
    expect(result.ledger.state).toBe("unverified");
    expect(result.ledger.ledger).not.toBeNull();
    expect(result.identityPolicy).toEqual(identityLedgerPolicy("unverified"));
    expect(result.identityPolicy.autoDeleteAllowed).toBe(false);
    expect(result.identityPolicy.autoRenameAllowed).toBe(false);
    expect(result.identityPolicy.requiresUserConfirmation).toBe(true);

    expect(fixture.fake.readText(MARKER_PATH)).toBe(markerText);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(ledgerText);
    expect(fixture.fake.getResource(LEDGER_PATH)?.eTag).toBe(ledgerETag);
    expect(writesTo(MARKER_PATH)).toHaveLength(0);
    expect(writesTo(LEDGER_PATH)).toHaveLength(0);
    expect(fixture.fake.readText("/vault/notes.md")).toBe("hello");
  });

  it("同一健康账本＋ledgerTrust=trusted：policy 按 verified", async () => {
    const { scopeId } = await currentScope();
    seedMarker(scopeId);
    const ledgerText = seedLedger({ ["a".repeat(32)]: "notes.md" });
    fixture.fake.seedFile("/vault/notes.md", "hello");
    const ledgerETag = fixture.fake.getResource(LEDGER_PATH)?.eTag ?? "";
    fixture.fake.requests.length = 0;

    const result = await bootstrapWebDavSync(
      bootstrapOptions({ localStatePresent: true, ledgerTrust: "trusted" }),
    );

    expect(result.ledger.state).toBe("verified");
    expect(result.identityPolicy).toEqual(identityLedgerPolicy("verified"));
    expect(result.identityPolicy.autoDeleteAllowed).toBe(true);
    expect(result.identityPolicy.autoRenameAllowed).toBe(true);
    expect(result.identityPolicy.requiresUserConfirmation).toBe(false);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(ledgerText);
    expect(fixture.fake.getResource(LEDGER_PATH)?.eTag).toBe(ledgerETag);
    expect(writesTo(LEDGER_PATH)).toHaveLength(0);
  });

  it("重建后的第二次 bootstrap（默认 trust）仍不打开自动删除／改名", async () => {
    const first = await bootstrapWebDavSync(bootstrapOptions());
    expect(first.ledger.state).toBe("unverified");
    const ledgerText = fixture.fake.readText(LEDGER_PATH) ?? "";
    const ledgerETag = fixture.fake.getResource(LEDGER_PATH)?.eTag ?? "";
    fixture.fake.requests.length = 0;

    const second = await bootstrapWebDavSync(
      bootstrapOptions({ localStatePresent: true }),
    );

    expect(second.scopeMarker.action).toBe("accept");
    expect(second.ledger.state).toBe("unverified");
    expect(second.identityPolicy.autoDeleteAllowed).toBe(false);
    expect(second.identityPolicy.autoRenameAllowed).toBe(false);
    expect(second.identityPolicy.requiresUserConfirmation).toBe(true);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(ledgerText);
    expect(fixture.fake.getResource(LEDGER_PATH)?.eTag).toBe(ledgerETag);
    expect(writesTo(LEDGER_PATH)).toHaveLength(0);
  });

  it("根已有内容但未确认：拒绝且不写标记／账本", async () => {
    fixture.fake.seedFile("/vault/notes.md", "hello");

    let caught: unknown;
    try {
      await bootstrapWebDavSync(bootstrapOptions());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WebDavSyncBootstrapRefusedError);
    const refused = caught as WebDavSyncBootstrapRefusedError;
    expect(refused.marker?.action).toBe("existing-content-confirm");
    expect(refused.marker?.mayWrite).toBe(false);
    expect(refused.marker?.existingEntryCount).toBe(1);
    expect(writesTo(MARKER_PATH)).toHaveLength(0);
    expect(writesTo(LEDGER_PATH)).toHaveLength(0);
    expect(fixture.fake.readText(MARKER_PATH)).toBeNull();
    expect(fixture.fake.readText(LEDGER_PATH)).toBeNull();
  });

  it("不同 scope 需接管：未确认拒绝，确认后 If-Match 替换", async () => {
    const oldScopeId = "b".repeat(32);
    const oldMarkerText = seedMarker(oldScopeId);
    const oldETag = fixture.fake.getResource(MARKER_PATH)?.eTag ?? "";

    let caught: unknown;
    try {
      await bootstrapWebDavSync(
        bootstrapOptions({ localStatePresent: true }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebDavSyncBootstrapRefusedError);
    expect((caught as WebDavSyncBootstrapRefusedError).marker?.action).toBe(
      "takeover-required",
    );
    expect((caught as WebDavSyncBootstrapRefusedError).marker?.mayWrite).toBe(false);
    expect(fixture.fake.readText(MARKER_PATH)).toBe(oldMarkerText);

    const result = await bootstrapWebDavSync(
      bootstrapOptions({ localStatePresent: true, confirmTakeover: true }),
    );

    expect(result.scopeMarker.action).toBe("takeover");
    expect(result.scopeMarker.markerWritten).toBe(true);
    const replace = filterRequests(
      (request) =>
        request.method === "PUT"
        && request.decodedPath === MARKER_PATH
        && request.ifMatch === oldETag,
    );
    expect(replace).toHaveLength(1);
    const stored = JSON.parse(fixture.fake.readText(MARKER_PATH) ?? "{}") as {
      scopeId?: string;
    };
    expect(stored.scopeId).toBe(await buildWebDavScopeId(result.scopeFields));
  });

  it.each(["missing", "corrupt"] as const)(
    "远端有文件且账本 %s：全量扫描重建 unverified，不删远端文件",
    async (state) => {
      const { scopeId } = await currentScope();
      seedMarker(scopeId);
      fixture.fake.seedFile("/vault/root.md", "root");
      fixture.fake.seedFile("/vault/dir/a.md", "a");
      fixture.fake.seedFile("/vault/dir/sub/b.md", "b");
      if (state === "corrupt") {
        fixture.fake.seedFile(LEDGER_PATH, "{not json");
      }
      fixture.fake.requests.length = 0;

      const result = await bootstrapWebDavSync(
        bootstrapOptions({ localStatePresent: true }),
      );

      expect(result.scopeMarker.action).toBe("accept");
      expect(result.ledger.state).toBe("unverified");
      expect(result.identityPolicy).toEqual(identityLedgerPolicy("unverified"));
      expect(result.identityPolicy.autoDeleteAllowed).toBe(false);
      expect(result.identityPolicy.autoRenameAllowed).toBe(false);
      expect(ledgerPaths(result.ledger.ledger)).toEqual([
        "dir",
        "dir/a.md",
        "dir/sub",
        "dir/sub/b.md",
        "root.md",
      ]);
      const stored = JSON.parse(fixture.fake.readText(LEDGER_PATH) ?? "{}") as {
        entries?: Record<string, string>;
      };
      expect(Object.values(stored.entries ?? {}).sort()).toEqual([
        "dir",
        "dir/a.md",
        "dir/sub",
        "dir/sub/b.md",
        "root.md",
      ]);
      expect(
        filterRequests(
          (request) =>
            request.method === "DELETE" && !isProbePath(request.decodedPath),
        ),
      ).toHaveLength(0);
      expect(fixture.fake.readText("/vault/root.md")).toBe("root");
      expect(fixture.fake.readText("/vault/dir/a.md")).toBe("a");
      expect(fixture.fake.readText("/vault/dir/sub/b.md")).toBe("b");
    },
  );

  it("账本 read-only（弱 ETag）：即使 trusted 也不重建、policy false，provider 仍返回", async () => {
    const { scopeId } = await currentScope();
    seedMarker(scopeId);
    const ledgerText = seedLedger({ ["c".repeat(32)]: "notes.md" });
    fixture.fake.seedFile("/vault/notes.md", "hello");
    fixture.fake.setProfiles(["weak-etag"]);
    fixture.fake.requests.length = 0;

    const result = await bootstrapWebDavSync(
      bootstrapOptions({ localStatePresent: true, ledgerTrust: "trusted" }),
    );

    expect(result.ledger.state).toBe("read-only");
    expect(result.identityPolicy.autoDeleteAllowed).toBe(false);
    expect(result.identityPolicy.autoRenameAllowed).toBe(false);
    expect(result.identityPolicy.requiresUserConfirmation).toBe(true);
    expect(result.provider).toBeInstanceOf(WebDavProvider);
    expect(fixture.fake.readText(LEDGER_PATH)).toBe(ledgerText);
    expect(writesTo(LEDGER_PATH)).toHaveLength(0);
    expect(writesTo(MARKER_PATH)).toHaveLength(0);
  });

  it("根不可写：initialize 拒绝，且无标记／账本写入", async () => {
    fixture.fake.setProfiles(["root-files-forbidden"]);

    await expect(bootstrapWebDavSync(bootstrapOptions())).rejects.toBeInstanceOf(
      WebDavRootNotWritableError,
    );

    expect(writesTo(MARKER_PATH)).toHaveLength(0);
    expect(writesTo(LEDGER_PATH)).toHaveLength(0);
    expect(fixture.fake.readText(MARKER_PATH)).toBeNull();
    expect(fixture.fake.readText(LEDGER_PATH)).toBeNull();
  });

  it("损坏账本且无强 ETag：拒绝重建，不产生可同步结果", async () => {
    const { scopeId } = await currentScope();
    seedMarker(scopeId);
    fixture.fake.seedFile(LEDGER_PATH, "{broken");
    fixture.fake.seedFile("/vault/notes.md", "hello");
    fixture.fake.setProfiles(["weak-etag"]);
    fixture.fake.requests.length = 0;

    let caught: unknown;
    try {
      await bootstrapWebDavSync(bootstrapOptions({ localStatePresent: true }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WebDavSyncBootstrapRefusedError);
    const refused = caught as WebDavSyncBootstrapRefusedError;
    expect(refused.reason).toContain("identity ledger");
    expect(refused.marker?.action).toBe("accept");
    expect(fixture.fake.readText(LEDGER_PATH)).toBe("{broken");
    expect(writesTo(LEDGER_PATH)).toHaveLength(0);
    expect(writesTo(MARKER_PATH)).toHaveLength(0);
  });
});
