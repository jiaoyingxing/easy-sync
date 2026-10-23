// 鉴权与驱动器引导：CloudBootstrapV2 CAS、Vault 初始化、驱动器可用性
// 由 tests/onedrive-client.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { OneDriveClient } from "../src/onedrive/client";
import {
  type DriveItem,
  OneDriveDriveUnavailableError,
  OneDriveError,
  OneDriveErrorType,
  RemoteVaultScopeIdentityError,
} from "../src/onedrive/types";

describe("OneDriveClient CloudBootstrapV2 CAS", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates bootstrap-v2.json with create-only conflict behavior", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: { id: "bootstrap-id", eTag: "etag-1" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.createCloudBootstrapV2("testVault", "{}"))
      .resolves.toEqual({ id: "bootstrap-id", eTag: "etag-1" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining("bootstrap-v2.json:/content?@microsoft.graph.conflictBehavior=fail"),
      headers: expect.not.objectContaining({ "If-Match": expect.anything() }),
    }));
  });

  it("updates bootstrap by driveItem ID with If-Match", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: { id: "bootstrap-id", eTag: "etag-2" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.updateCloudBootstrapV2("bootstrap-id", "etag-1", "{}"))
      .resolves.toEqual({ id: "bootstrap-id", eTag: "etag-2" });
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining("/me/drive/items/bootstrap-id/content"),
      headers: expect.objectContaining({ "If-Match": "etag-1" }),
    }));
  });

  it("reads bootstrap content with its stable ID and eTag", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "bootstrap-id",
          name: "bootstrap-v2.json",
          eTag: "etag-1",
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/bootstrap-v2.json",
        }] },
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, text: '{"schemaVersion":2}' });
    const client = new OneDriveClient(async () => "token");

    await expect(client.readCloudBootstrapV2("testVault")).resolves.toEqual({
      id: "bootstrap-id", eTag: "etag-1", content: '{"schemaVersion":2}',
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a timed-out bootstrap downloadUrl with Graph /content", async () => {
    vi.useFakeTimers();
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [{
          id: "bootstrap-id",
          name: "bootstrap-v2.json",
          eTag: "etag-1",
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/bootstrap-v2.json",
        }] },
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({ status: 200, headers: {}, text: '{"schemaVersion":2}' });
    const client = new OneDriveClient(async () => "token");

    const result = client.readCloudBootstrapV2("testVault");
    let settled = false;
    void result.catch(() => {}).then(() => { settled = true; });
    // 与元数据类读取同预算（METADATA_READ_TIMEOUT_MS）：8 秒不再判死，
    // 弱网下给满 30 秒才按超时终局，仍不与 Graph /content 兜底重叠。
    await vi.advanceTimersByTimeAsync(8000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(22_000);

    await expect(result).rejects.toMatchObject<Partial<OneDriveError>>({
      type: OneDriveErrorType.NetworkError,
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });
});

describe("OneDriveClient vault initialization", () => {
  const installVaultHierarchy = (options: {
    vaultName?: string;
    complete?: boolean;
    failAppRootOnce?: boolean;
    uncertainVaultsStatus?: 0 | 409;
    driveId?: string;
    createdDriveId?: string;
  } = {}) => {
    const vaultName = options.vaultName ?? "testVault";
    const driveId = options.driveId ?? "drive-id";
    const createdDriveId = options.createdDriveId ?? driveId;
    const children = new Map<string, DriveItem[]>([["app-root", []]]);
    const createdNames: string[] = [];
    let failAppRoot = options.failAppRootOnce ?? false;
    let vaultsCreateAttempts = 0;
    if (options.complete) {
      children.set("app-root", [{
        id: "vaults-root-id",
        name: "vaults",
        folder: {},
        parentReference: { id: "app-root", driveId },
      }]);
      children.set("vaults-root-id", [{
        id: "vault-folder-id",
        name: vaultName,
        folder: {},
        parentReference: { id: "vaults-root-id", driveId },
      }]);
      children.set("vault-folder-id", [
        {
          id: "files-root-id",
          name: "files",
          folder: {},
          parentReference: { id: "vault-folder-id", driveId },
        },
        {
          id: "plugin-root-id",
          name: ".easy-sync",
          folder: {},
          parentReference: { id: "vault-folder-id", driveId },
        },
      ]);
    }
    const fixedIds: Record<string, string> = {
      vaults: "vaults-root-id",
      [vaultName]: "vault-folder-id",
      files: "files-root-id",
      ".easy-sync": "plugin-root-id",
    };
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (request) => {
      const url = request.url;
      if (url.endsWith("/me/drive/special/approot")) {
        if (failAppRoot) {
          failAppRoot = false;
          throw {
            status: 404,
            headers: {},
            json: { error: { code: "itemNotFound", message: "missing" } },
          };
        }
        return {
          status: 200,
          headers: {},
          json: {
            id: "app-root",
            name: "EasySync",
            folder: {},
            // OneDrive Personal currently returns the legacy camel-case facet
            // even though the special endpoint itself is addressed as `approot`.
            specialFolder: { name: "appRoot" },
            parentReference: { driveId },
          },
        };
      }
      if (url.endsWith("/me/drive/special/approot:/vaults:/children")) {
        const vaults = children.get("app-root")?.find((item) => item.name === "vaults");
        if (!vaults) {
          throw {
            status: 404,
            headers: {},
            json: { error: { code: "itemNotFound", message: "missing" } },
          };
        }
        return { status: 200, headers: {}, json: { value: children.get(vaults.id) ?? [] } };
      }
      if (url.endsWith(`/vaults/${encodeURIComponent(vaultName)}/files`)) {
        return { status: 200, headers: {}, json: children.get("vault-folder-id")?.[0] };
      }
      if (url.endsWith(`/vaults/${encodeURIComponent(vaultName)}`)) {
        return { status: 200, headers: {}, json: children.get("vaults-root-id")?.[0] };
      }
      const childrenMatch = url.match(/\/me\/drive\/items\/([^/]+)\/children$/);
      if (childrenMatch) {
        const parentId = decodeURIComponent(childrenMatch[1]);
        if (request.method === "GET") {
          return { status: 200, headers: {}, json: { value: children.get(parentId) ?? [] } };
        }
        const body = JSON.parse(String(request.body)) as { name: string };
        const item: DriveItem = {
          id: fixedIds[body.name] ?? `folder-${createdNames.length + 1}`,
          name: body.name,
          folder: {},
          parentReference: { id: parentId, driveId: createdDriveId },
        };
        children.set(parentId, [...(children.get(parentId) ?? []), item]);
        children.set(item.id, []);
        createdNames.push(item.name);
        if (body.name === "vaults") {
          vaultsCreateAttempts++;
          if (options.uncertainVaultsStatus !== undefined) {
            throw {
              status: options.uncertainVaultsStatus,
              headers: {},
              json: { error: { code: "unknownOutcome", message: "read back" } },
            };
          }
        }
        return { status: 201, headers: {}, json: item };
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    });
    return {
      children,
      createdNames,
      requestSpy,
      getVaultsCreateAttempts: () => vaultsCreateAttempts,
    };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstraps an empty App Folder one parent at a time", async () => {
    const vaultName = "中文测试仓库";
    const { children, createdNames, requestSpy } = installVaultHierarchy({ vaultName });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope(vaultName)).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(createdNames).toEqual(["vaults", vaultName, "files", ".easy-sync"]);
    expect(requestSpy.mock.calls.some(([options]) => options.method === "PUT")).toBe(false);

    client.invalidateVaultScope(vaultName);
    requestSpy.mockClear();
    await expect(client.initVaultScope(vaultName)).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(requestSpy.mock.calls.some(([options]) => options.method === "POST")).toBe(false);

    children.set(
      "vault-folder-id",
      (children.get("vault-folder-id") ?? []).filter((item) => item.name !== ".easy-sync"),
    );
    client.invalidateVaultScope(vaultName);
    requestSpy.mockClear();
    await expect(client.initVaultScope(vaultName)).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(requestSpy.mock.calls.filter(([options]) => options.method === "POST"))
      .toHaveLength(1);
    expect(createdNames.at(-1)).toBe(".easy-sync");
  });

  it("accepts OneDrive Personal drive ID casing differences during bootstrap", async () => {
    const driveId = "68705950470d952b";
    const { createdNames } = installVaultHierarchy({
      driveId,
      createdDriveId: driveId.toUpperCase(),
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId,
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(createdNames).toEqual(["vaults", "testVault", "files", ".easy-sync"]);
  });

  it("keeps non-Personal drive IDs case-sensitive during bootstrap", async () => {
    installVaultHierarchy({
      driveId: "drive-id",
      createdDriveId: "DRIVE-ID",
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault"))
      .rejects.toThrow("Folder metadata is incomplete or mismatched: vaults");
  });

  it.each([
    409,
    0,
  ] as const)("adopts an exact folder after an uncertain create result (%i)", async (status) => {
    const { createdNames, getVaultsCreateAttempts } = installVaultHierarchy({
      uncertainVaultsStatus: status,
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect(getVaultsCreateAttempts()).toBe(1);
    expect(createdNames).toEqual(["vaults", "testVault", "files", ".easy-sync"]);
  });

  it("restores an exact persisted scope without probing established folders", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const client = new OneDriveClient(async () => "token");
    const scope = {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };

    expect(client.restoreVaultScope(
      "testVault",
      scope,
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/testVault/files:/delta?token=known",
    )).toBe(true);
    await expect(client.initVaultScope("testVault")).resolves.toEqual(scope);

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("restores the legacy encoded storage route only when the cursor proves it", async () => {
    const vaultName = "中文测试仓库";
    const legacyName = encodeURIComponent(vaultName);
    const encodedLegacyName = encodeURIComponent(legacyName);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "uploaded-id", eTag: "etag-uploaded" },
    });
    const client = new OneDriveClient(async () => "token");

    expect(client.restoreVaultScope(
      vaultName,
      {
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      },
      `https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/${encodedLegacyName}/files:/delta?token=known`,
    )).toBe(true);
    await client.uploadFile(vaultName, "probe.md", new ArrayBuffer(1));

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0][0].url).toContain(
      `/vaults/${encodedLegacyName}/files/probe.md:/content`,
    );
  });

  it("restores a committed legacy route from Graph identities when no cursor is usable", async () => {
    const vaultName = "中文测试仓库";
    const legacyName = encodeURIComponent(vaultName);
    const encodedLegacyName = encodeURIComponent(legacyName);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/me/drive/items/vault-folder-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "vault-folder-id",
            name: legacyName,
            folder: {},
            parentReference: { driveId: "drive-id", id: "vaults-root-id" },
          },
        };
      }
      if (options.url.endsWith("/me/drive/items/files-root-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "files-root-id",
            name: "files",
            folder: {},
            parentReference: { driveId: "drive-id", id: "vault-folder-id" },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { id: "uploaded-id", eTag: "etag-uploaded" },
      };
    });
    const client = new OneDriveClient(async () => "token");
    const scope = {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };

    await expect(client.restoreVaultScopeByIdentity(vaultName, scope))
      .resolves.toEqual(scope);
    await client.uploadFile(vaultName, "probe.md", new ArrayBuffer(1));

    expect(requestSpy.mock.calls[2][0].url).toContain(
      `/vaults/${encodedLegacyName}/files/probe.md:/content`,
    );
  });

  it("accepts a committed Personal 16-hex drive id that differs only in case", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/me/drive/items/vault-folder-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "vault-folder-id",
            name: "testVault",
            folder: {},
            parentReference: { driveId: "842e8d68b92fd8d7", id: "vaults-root-id" },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: {
          id: "files-root-id",
          name: "files",
          folder: {},
          parentReference: { driveId: "842e8d68b92fd8d7", id: "vault-folder-id" },
        },
      };
    });
    const client = new OneDriveClient(async () => "token");
    const scope = {
      driveId: "842E8D68B92FD8D7",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };

    await expect(client.restoreVaultScopeByIdentity("testVault", scope))
      .resolves.toEqual(scope);
  });

  it("still rejects a committed scope whose Personal drive id differs beyond case", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/me/drive/items/vault-folder-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "vault-folder-id",
            name: "testVault",
            folder: {},
            parentReference: { driveId: "842e8d68b92fd8d8", id: "vaults-root-id" },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: {
          id: "files-root-id",
          name: "files",
          folder: {},
          parentReference: { driveId: "842e8d68b92fd8d8", id: "vault-folder-id" },
        },
      };
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.restoreVaultScopeByIdentity("testVault", {
      driveId: "842E8D68B92FD8D7",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    })).rejects.toMatchObject<RemoteVaultScopeIdentityError>({
      name: "RemoteVaultScopeIdentityError",
      reason: "drive-invalid",
    });
  });

  it("classifies reachable committed metadata that no longer represents the files root", async () => {
    vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/me/drive/items/vault-folder-id")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "vault-folder-id",
            name: "testVault",
            folder: {},
            parentReference: { driveId: "drive-id", id: "vaults-root-id" },
          },
        };
      }
      return {
        status: 200,
        headers: {},
        json: {
          id: "files-root-id",
          name: "renamed-files-root",
          folder: {},
          parentReference: { driveId: "drive-id", id: "vault-folder-id" },
        },
      };
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.restoreVaultScopeByIdentity("testVault", {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    })).rejects.toMatchObject<RemoteVaultScopeIdentityError>({
      name: "RemoteVaultScopeIdentityError",
      reason: "files-root-invalid",
    });
  });

  it("refuses to restore a scope when the cursor belongs to another vault route", () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl");
    const client = new OneDriveClient(async () => "token");

    expect(client.restoreVaultScope(
      "testVault",
      {
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      },
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/other/files:/delta?token=wrong",
    )).toBe(false);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("recognizes a cursor after the server re-serializes the vault route", () => {
    const client = new OneDriveClient(async () => "token");
    const scope = {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };
    // Field shape (2026-10-14): the client builds this route with the vault
    // name percent-escaped (`/vaults/AI%40Techseed/files:/delta`), while the
    // service hands the same route back with a literal "@" and re-escaped
    // query separators (`%2c`, `%40`).
    const serverSerialized =
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/AI@Techseed/files:/delta?$top=500&$select=id%2cname%2c%40microsoft.graph.downloadUrl&token=known";

    expect(client.isDeltaLinkForVault("AI@Techseed", serverSerialized)).toBe(true);
    // A different case is still the same OneDrive directory.
    expect(client.isDeltaLinkForVault(
      "AI@Techseed",
      serverSerialized.replace("/vaults/AI@Techseed/", "/vaults/ai@techseed/"),
    )).toBe(true);
    expect(client.restoreVaultScope("AI@Techseed", scope, serverSerialized)).toBe(true);
  });

  it("keeps the canonical vault spelling after restoring from a re-serialized cursor", async () => {
    const vaultName = "AI@Techseed";
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "uploaded-id", eTag: "etag-uploaded" },
    });
    const client = new OneDriveClient(async () => "token");

    expect(client.restoreVaultScope(
      vaultName,
      {
        driveId: "drive-id",
        vaultFolderId: "vault-folder-id",
        filesRootId: "files-root-id",
      },
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/AI@Techseed/files:/delta?token=known",
    )).toBe(true);
    await client.uploadFile(vaultName, "probe.md", new ArrayBuffer(1));

    expect(requestSpy.mock.calls[0][0].url).toContain(
      "/vaults/AI%40Techseed/files/probe.md:/content",
    );
  });

  it("still refuses a cursor for a different vault route and an undecodable one", () => {
    const client = new OneDriveClient(async () => "token");
    const scope = {
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };
    const foreignLink =
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/other/files:/delta?token=wrong";
    const undecodableLink =
      "https://graph.microsoft.com/v1.0/me/drive/special/approot:/vaults/test%zzVault/files:/delta?token=wrong";

    expect(client.isDeltaLinkForVault("testVault", foreignLink)).toBe(false);
    expect(client.isDeltaLinkForVault("testVault", undecodableLink)).toBe(false);
    expect(client.restoreVaultScope("testVault", scope, foreignLink)).toBe(false);
    expect(client.restoreVaultScope("testVault", scope, undecodableLink)).toBe(false);
  });

  it("resolves an existing vault scope with GET requests only in read-only mode", async () => {
    const { children, requestSpy } = installVaultHierarchy({ complete: true });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault", { createMissing: false })).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });

    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(requestSpy.mock.calls.every(([options]) => options.method === "GET")).toBe(true);

    children.set(
      "vault-folder-id",
      (children.get("vault-folder-id") ?? []).filter((item) => item.name !== ".easy-sync"),
    );
    requestSpy.mockClear();
    await client.initVaultScope("testVault");

    const createCalls = requestSpy.mock.calls.filter(([options]) => options.method === "POST");
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(String(createCalls[0][0].body))).toMatchObject({ name: ".easy-sync" });
    expect(requestSpy.mock.calls.some(([options]) => options.method === "PUT")).toBe(false);
  });

  it("reuses a complete parent-identified hierarchy without mutation", async () => {
    const { requestSpy } = installVaultHierarchy({ complete: true });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });

    expect(requestSpy.mock.calls.every(([options]) => options.method === "GET")).toBe(true);
  });

  it("uses a legacy encoded vault when the canonical folder only has bootstrap files", async () => {
    const vaultName = "中文测试仓库";
    const canonical = encodeURIComponent(vaultName);
    const legacy = encodeURIComponent(canonical);
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      const url = options.url;
      if (url.endsWith("/vaults:/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            { id: "canonical", name: vaultName, folder: {} },
            { id: "legacy", name: canonical, folder: {} },
          ] },
        };
      }
      if (url.includes(`/vaults/${canonical}/files/.obsidian/plugins:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "easy-sync", name: "easy-sync", folder: {} }] } };
      }
      if (url.includes(`/vaults/${canonical}/files/.obsidian:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "plugins", name: "plugins", folder: {} }] } };
      }
      if (url.includes(`/vaults/${canonical}/files:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "obsidian", name: ".obsidian", folder: {} }] } };
      }
      if (url.includes(`/vaults/${legacy}/files:/children`)) {
        return { status: 200, headers: {}, json: { value: [{ id: "notes", name: "Notes", folder: {} }] } };
      }
      if (url.endsWith("/me/drive/special/approot")) {
        return {
          status: 200,
          headers: {},
          json: {
            id: "app-root",
            name: "EasySync",
            folder: {},
            specialFolder: { name: "approot" },
            parentReference: { driveId: "drive-id" },
          },
        };
      }
      if (url.endsWith("/me/drive/items/app-root/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [{
            id: "vaults-root-id",
            name: "vaults",
            folder: {},
            parentReference: { id: "app-root", driveId: "drive-id" },
          }] },
        };
      }
      if (url.endsWith("/me/drive/items/vaults-root-id/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            {
              id: "canonical",
              name: vaultName,
              folder: {},
              parentReference: { id: "vaults-root-id", driveId: "drive-id" },
            },
            {
              id: "legacy",
              name: canonical,
              folder: {},
              parentReference: { id: "vaults-root-id", driveId: "drive-id" },
            },
          ] },
        };
      }
      if (url.endsWith("/me/drive/items/legacy/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            {
              id: "files-root-id",
              name: "files",
              folder: {},
              parentReference: { id: "legacy", driveId: "drive-id" },
            },
            {
              id: "plugin-root-id",
              name: ".easy-sync",
              folder: {},
              parentReference: { id: "legacy", driveId: "drive-id" },
            },
          ] },
        };
      }
      return { status: 200, headers: {}, json: { id: "uploaded", eTag: "etag" } };
    });
    const client = new OneDriveClient(async () => "token");

    await client.initVaultScope(vaultName);
    await client.uploadFile(vaultName, "probe.md", new ArrayBuffer(1));

    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: expect.stringContaining(`/vaults/${legacy}/files/probe.md:/content`),
    }));
  });

  it("stops when canonical and legacy vault folders both contain sync content", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockImplementation(async (options) => {
      if (options.url.endsWith("/vaults:/children")) {
        return {
          status: 200,
          headers: {},
          json: { value: [
            { id: "canonical", name: "中文测试仓库", folder: {} },
            { id: "legacy", name: encodeURIComponent("中文测试仓库"), folder: {} },
          ] },
        };
      }
      return {
        status: 200,
        headers: {},
        json: { value: [{ id: "notes", name: "Notes", folder: {} }] },
      };
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("中文测试仓库")).rejects.toMatchObject({
      type: OneDriveErrorType.Conflict,
      statusCode: 409,
    });
    expect(requestSpy.mock.calls.some(([options]) => options.method === "PUT")).toBe(false);
  });

  it("does not cache a failed bootstrap and retries cleanly", async () => {
    const { requestSpy } = installVaultHierarchy({ failAppRootOnce: true });
    const client = new OneDriveClient(async () => "token");

    await expect(client.initVaultScope("testVault")).rejects.toMatchObject({
      type: OneDriveErrorType.NotFound,
    });
    await expect(client.initVaultScope("testVault")).resolves.toEqual({
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    const callsAfterSuccess = requestSpy.mock.calls.length;
    await client.initVaultScope("testVault");

    expect(requestSpy).toHaveBeenCalledTimes(callsAfterSuccess);
  });
});

describe("OneDriveClient.ensureDriveAvailable", () => {
  afterEach(() => vi.restoreAllMocks());

  it("provisions through GET /me/drive before the first root listing", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      headers: {},
      json: { id: "drive-id" },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.ensureDriveAvailable()).resolves.toBeUndefined();
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      url: expect.stringContaining("/me/drive?$select=id"),
      throw: false,
    }));
  });

  it("classifies a 404 on /me/drive as no provisionable OneDrive", async () => {
    vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status: 404,
      headers: {},
      json: { error: { code: "itemNotFound", message: "not found" } },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.ensureDriveAvailable())
      .rejects.toBeInstanceOf(OneDriveDriveUnavailableError);
  });

  it("does not misreport auth or permission failures as no OneDrive", async () => {
    vi.spyOn(obsidian, "requestUrl").mockRejectedValue({
      status: 403,
      headers: {},
      json: { error: { code: "accessDenied", message: "denied" } },
    });
    const client = new OneDriveClient(async () => "token");

    await expect(client.ensureDriveAvailable()).rejects.toMatchObject({
      type: OneDriveErrorType.Forbidden,
    });
  });

  it("captures the Graph error body and cross-checks /me/drives on a 404", async () => {
    const requestSpy = vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 404,
        headers: {},
        json: {
          error: {
            code: "itemNotFound",
            message: "User's mysite not found.",
            innerError: {
              code: "itemNotFound",
              "request-id": "request-404",
              date: "2026-10-20T00:00:00Z",
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: {
          value: [{ id: "drive-1", driveType: "personal", name: "OneDrive" }],
        },
      } as never);
    const client = new OneDriveClient(async () => "token");

    const failure = await client.ensureDriveAvailable()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OneDriveDriveUnavailableError);
    expect((failure as OneDriveDriveUnavailableError).detail).toMatchObject({
      statusCode: 404,
      graphError: {
        code: "itemNotFound",
        message: "User's mysite not found.",
        innerCode: "itemNotFound",
        requestId: "request-404",
      },
      drivesProbe: "ok",
      drivesCount: 1,
      driveTypes: ["personal"],
    });
    expect(requestSpy.mock.calls.map(([options]) => options.url)).toEqual([
      expect.stringContaining("/me/drive?$select=id"),
      expect.stringContaining("/me/drives?$select=id,driveType,name"),
    ]);
    expect(requestSpy.mock.calls[0]?.[0]).toMatchObject({ throw: false });
  });

  it("records an empty /me/drives answer as no available drive", async () => {
    vi.spyOn(obsidian, "requestUrl")
      .mockResolvedValueOnce({
        status: 404,
        headers: {},
        json: { error: { code: "itemNotFound", message: "not found" } },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        json: { value: [] },
      } as never);
    const client = new OneDriveClient(async () => "token");

    const failure = await client.ensureDriveAvailable()
      .catch((error: unknown) => error);

    expect((failure as OneDriveDriveUnavailableError).detail).toMatchObject({
      drivesProbe: "empty",
      drivesCount: 0,
      driveTypes: [],
    });
  });
});
