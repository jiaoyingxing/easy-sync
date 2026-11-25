import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildWebDavScopeFields,
  buildWebDavScopeId,
  buildWebDavScopeMarker,
  ensureWebDavScopeMarker,
  isWebDavControlPlanePath,
  readWebDavScopeMarker,
  serializeWebDavScopeMarker,
  webDavControlDirectoryPath,
  webDavScopeFallbackMarkerPath,
  webDavScopeMarkerPath,
  webDavScopeFieldsToSyncScope,
  type WebDavScopeListingEntry,
  type WebDavScopeRemoteIo,
  type WebDavScopeStatResult,
} from "../src/providers/webdav/webdav-scope";
import { isSyncScope, sameSyncScope, type SyncScope } from "../src/sync/types";

/**
 * S0 远端根占用（WebDAV）：标准 `.easy-sync/scope.json`；服务器不允许
 * MKCOL 时回退 `.easy-sync-scope.json`；不同库拒绝；同库换 scope 需显式接管；
 * 非空根集合无标记需显式确认，确认前零写入（连 MKCOL 都不发）。
 */
const CREATED_AT = new Date("2026-11-17T00:00:00.000Z");

function eTagOf(text: string): string {
  return `"${createHash("sha1").update(text).digest("hex")}"`;
}

async function localIdentity(overrides: {
  endpoint?: string;
  rootPath?: string;
  username?: string;
} = {}) {
  const fields = await buildWebDavScopeFields({
    endpoint: "https://dav.example.com/Notes",
    username: "alice",
    ...overrides,
  });
  const scopeId = await buildWebDavScopeId(fields);
  const marker = buildWebDavScopeMarker({
    vaultName: "MyVault",
    scopeId,
    createdAt: CREATED_AT,
  });
  return { fields, scopeId, marker };
}

class FakeWebDav implements WebDavScopeRemoteIo {
  readonly collections = new Set<string>(["/"]);
  readonly files = new Map<string, string>();
  readonly mkcolCalls: string[] = [];
  readonly putCalls: Array<{
    path: string;
    text: string;
    createOnly: boolean;
    ifMatch?: string | null;
  }> = [];
  mkcolStatus: number | null = null;
  listStatus: number | null = null;
  listComplete: boolean;
  omitETags: boolean;

  constructor(options: {
    collections?: readonly string[];
    files?: Readonly<Record<string, string>>;
    mkcolStatus?: number;
    listStatus?: number;
    listComplete?: boolean;
    omitETags?: boolean;
  } = {}) {
    for (const path of options.collections ?? []) this.collections.add(path);
    for (const [path, text] of Object.entries(options.files ?? {})) this.files.set(path, text);
    this.mkcolStatus = options.mkcolStatus ?? null;
    this.listStatus = options.listStatus ?? null;
    this.listComplete = options.listComplete ?? true;
    this.omitETags = options.omitETags ?? false;
  }

  async getText(path: string): Promise<{ status: number; text: string; eTag?: string | null }> {
    const text = this.files.get(path);
    if (text !== undefined) {
      return { status: 200, text, eTag: this.omitETags ? null : eTagOf(text) };
    }
    return { status: 404, text: "", eTag: null };
  }

  async stat(path: string): Promise<WebDavScopeStatResult> {
    if (this.collections.has(path)) return { status: 207, isCollection: true };
    if (this.files.has(path)) return { status: 207, isCollection: false };
    return { status: 404, isCollection: false };
  }

  async mkcol(path: string): Promise<number> {
    this.mkcolCalls.push(path);
    if (this.mkcolStatus !== null) return this.mkcolStatus;
    if (this.collections.has(path)) return 405;
    if (!this.collections.has(this.parent(path))) return 409;
    this.collections.add(path);
    return 201;
  }

  async putText(
    path: string,
    text: string,
    options: { readonly createOnly: boolean; readonly ifMatch?: string | null },
  ): Promise<number> {
    this.putCalls.push({
      path,
      text,
      createOnly: options.createOnly,
      ifMatch: options.ifMatch ?? null,
    });
    if (!this.collections.has(this.parent(path))) return 409;
    if (options.createOnly) {
      if (this.files.has(path)) return 412;
      this.files.set(path, text);
      return 201;
    }
    const current = this.files.get(path);
    if (current === undefined) return 404;
    if (!options.ifMatch || eTagOf(current) !== options.ifMatch) return 412;
    this.files.set(path, text);
    return 204;
  }

  async list(path: string): Promise<{
    status: number;
    entries: readonly WebDavScopeListingEntry[];
    complete: boolean;
  }> {
    if (this.listStatus !== null) {
      return { status: this.listStatus, entries: [], complete: this.listComplete };
    }
    if (!this.collections.has(path)) {
      return { status: 404, entries: [], complete: this.listComplete };
    }
    return { status: 207, entries: this.children(path), complete: this.listComplete };
  }

  private parent(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.slice(0, index);
  }

  private children(path: string): WebDavScopeListingEntry[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    const entries: WebDavScopeListingEntry[] = [
      { path, isCollection: true, size: 0 },
    ];
    for (const collection of this.collections) {
      if (collection === path || !collection.startsWith(prefix)) continue;
      const rest = collection.slice(prefix.length);
      if (rest.length > 0 && !rest.includes("/")) {
        entries.push({ path: collection, isCollection: true, size: 0 });
      }
    }
    for (const [file, text] of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest.length > 0 && !rest.includes("/")) {
        entries.push({ path: file, isCollection: false, size: text.length });
      }
    }
    return entries;
  }
}

describe("WebDAV scope fields", () => {
  it("derives origin, root path and a 32-hex credential binding", async () => {
    const fields = await buildWebDavScopeFields({
      endpoint: "https://Example.com:443/dav/files/User/",
      username: " alice ",
    });
    expect(fields.providerKind).toBe("webdav");
    expect(fields.endpointId).toBe("https://example.com");
    expect(fields.containerId).toBe("");
    expect(fields.rootPath).toBe("/dav/files/User");
    expect(fields.credentialBindingId).toMatch(/^[0-9a-f]{32}$/);

    const again = await buildWebDavScopeFields({
      endpoint: "https://example.com/dav/files/User",
      username: "alice",
    });
    expect(again).toEqual(fields);
  });

  it("binds the username but not the password (password is not an input)", async () => {
    const first = await buildWebDavScopeFields({
      endpoint: "https://dav.example.com",
      username: "alice",
    });
    const second = await buildWebDavScopeFields({
      endpoint: "https://dav.example.com",
      username: "bob",
    });
    expect(second.credentialBindingId).not.toBe(first.credentialBindingId);
    expect(JSON.stringify(first)).not.toContain("alice");
  });

  it("rejects non-HTTPS, embedded credentials, query/fragment and conflicting roots", async () => {
    await expect(buildWebDavScopeFields({
      endpoint: "http://dav.example.com",
      username: "alice",
    })).rejects.toThrow();
    await expect(buildWebDavScopeFields({
      endpoint: "https://user:pass@dav.example.com",
      username: "alice",
    })).rejects.toThrow();
    await expect(buildWebDavScopeFields({
      endpoint: "https://dav.example.com/?x=1",
      username: "alice",
    })).rejects.toThrow();
    await expect(buildWebDavScopeFields({
      endpoint: "https://dav.example.com/a%2Fb",
      username: "alice",
    })).rejects.toThrow();
    await expect(buildWebDavScopeFields({
      endpoint: "https://dav.example.com/Notes",
      rootPath: "/Other",
      username: "alice",
    })).rejects.toThrow();
    await expect(buildWebDavScopeFields({
      endpoint: "https://dav.example.com",
      username: "  ",
    })).rejects.toThrow();
    await expect(buildWebDavScopeFields({
      endpoint: "https://dav.example.com",
      rootPath: "/.easy-sync",
      username: "alice",
    })).rejects.toThrow();
  });

  it("maps fields to SyncScope with root `/` and the absolute rootPath preserved", async () => {
    const { fields } = await localIdentity();
    const scope = webDavScopeFieldsToSyncScope(fields);

    expect(scope.accountId).toBe(fields.credentialBindingId);
    expect(scope.driveId).toBe(fields.endpointId);
    // Provider 的根 ID 是 `/`；绝对根集合只进 rootPath。
    expect(scope.vaultFolderId).toBe("/");
    expect(scope.filesRootId).toBe("/");
    expect(scope.providerKind).toBe("webdav");
    expect(scope.endpointId).toBe(fields.endpointId);
    expect(scope.containerId).toBe("");
    expect(scope.rootPath).toBe("/Notes");
    expect(scope.rootPath).toBe(fields.rootPath);
    expect(scope.credentialBindingId).toBe(fields.credentialBindingId);
    expect(isSyncScope(scope)).toBe(true);
    expect(sameSyncScope(scope, JSON.parse(JSON.stringify(scope)) as SyncScope)).toBe(true);
  });
});

describe("WebDAV control-plane paths", () => {
  it("builds the standard and fallback marker paths", () => {
    expect(webDavControlDirectoryPath("/Notes")).toBe("/Notes/.easy-sync");
    expect(webDavScopeMarkerPath("/Notes")).toBe("/Notes/.easy-sync/scope.json");
    expect(webDavScopeFallbackMarkerPath("/Notes")).toBe("/Notes/.easy-sync-scope.json");
    expect(webDavScopeMarkerPath("/")).toBe("/.easy-sync/scope.json");
  });

  it("excludes the control namespace and the fallback marker from user content", () => {
    expect(isWebDavControlPlanePath("/Notes", "/Notes/.easy-sync")).toBe(true);
    expect(isWebDavControlPlanePath("/Notes", "/Notes/.easy-sync/scope.json")).toBe(true);
    expect(isWebDavControlPlanePath("/Notes", "/Notes/.easy-sync-scope.json")).toBe(true);
    expect(isWebDavControlPlanePath("/Notes", "/Notes/.easy-sync-not")).toBe(false);
    expect(isWebDavControlPlanePath("/Notes", "/Notes/a.md")).toBe(false);
    expect(isWebDavControlPlanePath("/", "/.easy-sync")).toBe(true);
    expect(isWebDavControlPlanePath("/", "/.easy-sync/scope.json")).toBe(true);
    expect(isWebDavControlPlanePath("/", "/.easy-sync-scope.json")).toBe(true);
    expect(isWebDavControlPlanePath("/", "/notes/a.md")).toBe(false);
  });
});

describe("WebDAV scope marker initialization", () => {
  it("creates `.easy-sync/scope.json` after MKCOL succeeds", async () => {
    const { marker } = await localIdentity({ endpoint: "https://dav.example.com", rootPath: "/" });
    const fake = new FakeWebDav();

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/",
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("initialize");
    expect(result.mayWrite).toBe(true);
    expect(result.markerWritten).toBe(true);
    expect(result.markerStyle).toBe("directory");
    expect(result.markerPath).toBe("/.easy-sync/scope.json");
    expect(fake.mkcolCalls).toEqual(["/.easy-sync"]);
    expect(fake.putCalls).toHaveLength(1);
    expect(fake.putCalls[0]).toMatchObject({
      path: "/.easy-sync/scope.json",
      createOnly: true,
    });
    expect(await readWebDavScopeMarker(fake, "/")).toEqual({
      path: "/.easy-sync/scope.json",
      style: "directory",
      marker,
      eTag: eTagOf(serializeWebDavScopeMarker(marker)),
    });
    expect(fake.files.get("/.easy-sync/scope.json")).not.toContain("alice");
  });

  it("falls back to `.easy-sync-scope.json` when MKCOL is not allowed", async () => {
    const { marker } = await localIdentity();
    const fake = new FakeWebDav({ collections: ["/Notes"], mkcolStatus: 403 });

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("initialize");
    expect(result.markerStyle).toBe("fallback");
    expect(result.markerPath).toBe("/Notes/.easy-sync-scope.json");
    expect(fake.mkcolCalls).toEqual(["/Notes/.easy-sync"]);
    expect(fake.putCalls).toHaveLength(1);
    expect(fake.putCalls[0].path).toBe("/Notes/.easy-sync-scope.json");
    expect(fake.putCalls[0].createOnly).toBe(true);
  });

  it("uses the standard path when `.easy-sync` already exists (MKCOL 405 + PROPFIND)", async () => {
    const { marker } = await localIdentity();
    const fake = new FakeWebDav({
      collections: ["/Notes", "/Notes/.easy-sync"],
    });

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("initialize");
    expect(result.markerStyle).toBe("directory");
    expect(result.existingEntryCount).toBe(0);
    expect(fake.putCalls[0].path).toBe("/Notes/.easy-sync/scope.json");
  });

  it("accepts an existing fallback marker without writing", async () => {
    const { marker } = await localIdentity();
    const fake = new FakeWebDav({
      files: {
        "/Notes/.easy-sync-scope.json": serializeWebDavScopeMarker(marker),
      },
    });

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: true,
    });

    expect(result.action).toBe("accept");
    expect(result.markerStyle).toBe("fallback");
    expect(result.mayWrite).toBe(true);
    expect(result.markerWritten).toBe(false);
    expect(fake.mkcolCalls).toHaveLength(0);
    expect(fake.putCalls).toHaveLength(0);
  });

  it("refuses a marker from another vault with a different scope", async () => {
    const { scopeId: otherScopeId } = await localIdentity({
      endpoint: "https://other.example.com",
    });
    const otherMarker = buildWebDavScopeMarker({
      vaultName: "OtherVault",
      scopeId: otherScopeId,
      createdAt: CREATED_AT,
    });
    const fake = new FakeWebDav({
      files: {
        "/Notes/.easy-sync/scope.json": serializeWebDavScopeMarker(otherMarker),
      },
    });
    const { marker } = await localIdentity();

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: true,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(fake.mkcolCalls).toHaveLength(0);
    expect(fake.putCalls).toHaveLength(0);
  });

  it("refuses the same scope id under a different vault name", async () => {
    const { marker } = await localIdentity();
    const sameScopeOtherVault = buildWebDavScopeMarker({
      vaultName: "OtherVault",
      scopeId: marker.scopeId,
      createdAt: CREATED_AT,
    });
    const fake = new FakeWebDav({
      files: {
        "/Notes/.easy-sync/scope.json": serializeWebDavScopeMarker(sameScopeOtherVault),
      },
    });

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: true,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(result.markerWritten).toBe(false);
    expect(fake.mkcolCalls).toHaveLength(0);
    expect(fake.putCalls).toHaveLength(0);
  });
});

describe("WebDAV scope marker takeover", () => {
  it("requires explicit confirmation for the same vault with a different scope", async () => {
    const { scopeId: otherScopeId } = await localIdentity({
      endpoint: "https://other.example.com",
    });
    const otherMarker = buildWebDavScopeMarker({
      vaultName: "MyVault",
      scopeId: otherScopeId,
      createdAt: CREATED_AT,
    });
    const fake = new FakeWebDav({
      collections: ["/Notes", "/Notes/.easy-sync"],
      files: {
        "/Notes/.easy-sync/scope.json": serializeWebDavScopeMarker(otherMarker),
      },
    });
    const { marker } = await localIdentity();

    const pending = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });
    expect(pending.action).toBe("takeover-required");
    expect(pending.mayWrite).toBe(false);
    expect(pending.reason).toContain("local state is missing");
    expect(fake.putCalls).toHaveLength(0);

    const takenOver = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
      confirmTakeover: true,
    });
    expect(takenOver.action).toBe("takeover");
    expect(takenOver.mayWrite).toBe(true);
    expect(takenOver.markerWritten).toBe(true);
    expect(fake.putCalls).toHaveLength(1);
    expect(fake.putCalls[0]).toMatchObject({
      path: "/Notes/.easy-sync/scope.json",
      createOnly: false,
      ifMatch: eTagOf(serializeWebDavScopeMarker(otherMarker)),
    });
    expect((await readWebDavScopeMarker(fake, "/Notes"))?.marker).toEqual(marker);
  });

  it("refuses takeover when the existing marker has no ETag (fail-closed)", async () => {
    const { scopeId: otherScopeId } = await localIdentity({
      endpoint: "https://other.example.com",
    });
    const otherMarker = buildWebDavScopeMarker({
      vaultName: "MyVault",
      scopeId: otherScopeId,
      createdAt: CREATED_AT,
    });
    const fake = new FakeWebDav({
      collections: ["/Notes", "/Notes/.easy-sync"],
      files: {
        "/Notes/.easy-sync/scope.json": serializeWebDavScopeMarker(otherMarker),
      },
      omitETags: true,
    });
    const { marker } = await localIdentity();

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
      confirmTakeover: true,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(result.markerWritten).toBe(false);
    expect(result.reason).toContain("ETag");
    expect(fake.putCalls).toHaveLength(0);
    expect(fake.files.get("/Notes/.easy-sync/scope.json")).toBe(
      serializeWebDavScopeMarker(otherMarker),
    );
  });

  it("reports a stale replace precondition instead of overwriting", async () => {
    const { scopeId: otherScopeId } = await localIdentity({
      endpoint: "https://other.example.com",
    });
    const otherMarker = buildWebDavScopeMarker({
      vaultName: "MyVault",
      scopeId: otherScopeId,
      createdAt: CREATED_AT,
    });
    const fake = new FakeWebDav({
      collections: ["/Notes", "/Notes/.easy-sync"],
      files: {
        "/Notes/.easy-sync/scope.json": serializeWebDavScopeMarker(otherMarker),
      },
    });
    const { marker } = await localIdentity();
    const originalGetText = fake.getText.bind(fake);
    let firstRead = true;
    fake.getText = async (path: string) => {
      const read = await originalGetText(path);
      if (firstRead) {
        firstRead = false;
        // 模拟另一个写入者在读取之后、替换之前改了标记。
        fake.files.set("/Notes/.easy-sync/scope.json", "changed-by-someone-else");
      }
      return read;
    };

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
      confirmTakeover: true,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(result.reason).toContain("412");
    expect(fake.files.get("/Notes/.easy-sync/scope.json")).toBe("changed-by-someone-else");
  });
});

describe("WebDAV non-empty root without a marker", () => {
  it("requires confirmation and performs zero writes before it (no MKCOL, no PUT)", async () => {
    const { marker } = await localIdentity();
    const fake = new FakeWebDav({
      collections: ["/Notes"],
      files: { "/Notes/a.md": "hello" },
    });

    const pending = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });

    expect(pending.action).toBe("existing-content-confirm");
    expect(pending.mayWrite).toBe(false);
    expect(pending.markerWritten).toBe(false);
    expect(pending.existingEntryCount).toBe(1);
    expect(fake.mkcolCalls).toHaveLength(0);
    expect(fake.putCalls).toHaveLength(0);

    const confirmed = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
      confirmExistingContent: true,
    });
    expect(confirmed.action).toBe("initialize");
    expect(confirmed.mayWrite).toBe(true);
    expect(confirmed.existingEntryCount).toBe(1);
    expect(fake.putCalls).toHaveLength(1);
  });

  it("does not count control-plane objects as existing content", async () => {
    const { marker } = await localIdentity();
    const fake = new FakeWebDav({
      collections: ["/Notes", "/Notes/.easy-sync"],
      files: { "/Notes/.easy-sync/probe/one": "x" },
    });

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("initialize");
    expect(result.existingEntryCount).toBe(0);
  });

  it("fails closed when the root listing is not a 207 multistatus", async () => {
    const { marker } = await localIdentity();
    const fake = new FakeWebDav({
      collections: ["/Notes"],
      listStatus: 200,
    });

    const result = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });

    expect(result.action).toBe("refuse");
    expect(result.mayWrite).toBe(false);
    expect(fake.mkcolCalls).toHaveLength(0);
    expect(fake.putCalls).toHaveLength(0);
  });

  it("requires confirmation when the root listing may be truncated", async () => {
    const { marker } = await localIdentity();
    const fake = new FakeWebDav({
      collections: ["/Notes"],
      listComplete: false,
    });

    const pending = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
    });

    expect(pending.action).toBe("existing-content-confirm");
    expect(pending.mayWrite).toBe(false);
    expect(pending.markerWritten).toBe(false);
    expect(pending.existingEntriesComplete).toBe(false);
    expect(pending.reason).toContain("truncated");
    expect(fake.mkcolCalls).toHaveLength(0);
    expect(fake.putCalls).toHaveLength(0);

    const confirmed = await ensureWebDavScopeMarker({
      io: fake,
      rootPath: "/Notes",
      marker,
      localStatePresent: false,
      confirmExistingContent: true,
    });
    expect(confirmed.action).toBe("initialize");
    expect(confirmed.existingEntriesComplete).toBe(false);
    expect(fake.putCalls).toHaveLength(1);
  });
});
