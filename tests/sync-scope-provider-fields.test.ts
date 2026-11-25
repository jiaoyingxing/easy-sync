import { describe, expect, it } from "vitest";
import { isSyncScope, sameSyncScope, type SyncScope } from "../src/sync/types";

/**
 * S0（设计 §2.1、§6）scope 加性可选字段合同：
 *
 * - 旧四元仍然必须通过；缺新字段是合法输入；
 * - 新字段缺失按默认值比较（providerKind = "onedrive"，其余 = ""），但
 *   比较绝不能把默认值写回对象（否则旧 envelope 字节与 IndexedDB 摘要会变）；
 * - endpoint／container／root／account 任一变化都是不同 scope；
 * - providerKind 只允许三个值。
 */
const legacy = (overrides: Partial<SyncScope> = {}): SyncScope => ({
  accountId: "842e8d68b92fd8d7",
  driveId: "842E8D68B92FD8D7",
  vaultFolderId: "842E8D68B92FD8D7!s2e987e7d451c46a7a234b7f09ad109c0",
  filesRootId: "842E8D68B92FD8D7!sbe26d7449f0e4a9488997492185373ab",
  ...overrides,
});

const explicitOneDriveDefaults = (): SyncScope => ({
  ...legacy(),
  providerKind: "onedrive",
  endpointId: "",
  containerId: "",
  rootPath: "",
  credentialBindingId: "",
});

const s3 = (overrides: Partial<SyncScope> = {}): SyncScope => ({
  accountId: "0123456789abcdef0123456789abcdef",
  driveId: "my-bucket",
  vaultFolderId: "Root/Docs",
  filesRootId: "Root/Docs",
  providerKind: "s3",
  endpointId: "https://s3.example.com|us-east-1",
  containerId: "my-bucket",
  rootPath: "Root/Docs",
  credentialBindingId: "0123456789abcdef0123456789abcdef",
  ...overrides,
});

const webdav = (overrides: Partial<SyncScope> = {}): SyncScope => ({
  accountId: "fedcba9876543210fedcba9876543210",
  driveId: "https://dav.example.com",
  // W2b2a：provider 根 ID 是 `/`；绝对根集合只在 rootPath。
  vaultFolderId: "/",
  filesRootId: "/",
  providerKind: "webdav",
  endpointId: "https://dav.example.com",
  containerId: "",
  rootPath: "/dav/notes",
  credentialBindingId: "fedcba9876543210fedcba9876543210",
  ...overrides,
});

describe("SyncScope provider fields — round-trip", () => {
  it("round-trips a full S3 scope through JSON", () => {
    const scope = s3();
    const parsed: unknown = JSON.parse(JSON.stringify(scope));
    expect(parsed).toEqual(scope);
    expect(isSyncScope(parsed)).toBe(true);
    expect(sameSyncScope(parsed as SyncScope, scope)).toBe(true);
  });

  it("round-trips a full WebDAV scope through JSON", () => {
    const scope = webdav();
    const parsed: unknown = JSON.parse(JSON.stringify(scope));
    expect(parsed).toEqual(scope);
    expect(isSyncScope(parsed)).toBe(true);
  });
});

describe("SyncScope provider fields — defaults without write-back", () => {
  it("treats a legacy four-field scope as providerKind onedrive with empty fields", () => {
    expect(sameSyncScope(legacy(), explicitOneDriveDefaults())).toBe(true);
    expect(sameSyncScope(explicitOneDriveDefaults(), legacy())).toBe(true);
  });

  it("never writes defaults back into the scope object", () => {
    const oldScope = legacy();
    const keysBefore = Object.keys(oldScope);
    const rawBefore = JSON.stringify(oldScope);

    expect(sameSyncScope(oldScope, explicitOneDriveDefaults())).toBe(true);
    expect(isSyncScope(oldScope)).toBe(true);

    expect(Object.keys(oldScope)).toEqual(keysBefore);
    expect(keysBefore).toEqual([
      "accountId",
      "driveId",
      "vaultFolderId",
      "filesRootId",
    ]);
    expect("providerKind" in oldScope).toBe(false);
    expect("endpointId" in oldScope).toBe(false);
    expect(JSON.stringify(oldScope)).toBe(rawBefore);
  });

  it("does not treat a new S3 scope as equal to the legacy OneDrive scope", () => {
    expect(sameSyncScope(legacy(), s3())).toBe(false);
    expect(sameSyncScope(legacy(), webdav())).toBe(false);
  });
});

describe("SyncScope provider fields — any identity field change is a new scope", () => {
  it("rejects endpoint changes", () => {
    expect(sameSyncScope(s3(), s3({ endpointId: "https://s3.example.com|eu-west-1" })))
      .toBe(false);
    expect(sameSyncScope(
      webdav(),
      webdav({ endpointId: "https://dav2.example.com", driveId: "https://dav2.example.com" }),
    )).toBe(false);
  });

  it("rejects bucket/container changes", () => {
    expect(sameSyncScope(
      s3(),
      s3({ containerId: "other-bucket", driveId: "other-bucket" }),
    )).toBe(false);
  });

  it("rejects root path changes", () => {
    expect(sameSyncScope(
      s3(),
      s3({ rootPath: "Root/Other", vaultFolderId: "Root/Other", filesRootId: "Root/Other" }),
    )).toBe(false);
    expect(sameSyncScope(
      webdav(),
      webdav({ rootPath: "/dav/other" }),
    )).toBe(false);
  });

  it("rejects account/credential binding changes even when the four legacy fields match", () => {
    expect(sameSyncScope(
      s3(),
      s3({ accountId: "ffffffffffffffffffffffffffffffff", credentialBindingId: "ffffffffffffffffffffffffffffffff" }),
    )).toBe(false);
  });

  it("rejects providerKind changes even when the four legacy fields match", () => {
    expect(sameSyncScope(
      legacy(),
      { ...legacy(), providerKind: "s3" },
    )).toBe(false);
    expect(sameSyncScope(
      s3(),
      s3({ providerKind: "webdav" }),
    )).toBe(false);
  });

  it("rejects a missing provider field versus an explicit non-default value", () => {
    expect(sameSyncScope(legacy(), { ...legacy(), providerKind: "webdav" })).toBe(false);
    expect(sameSyncScope(legacy(), { ...legacy(), endpointId: "https://x" })).toBe(false);
  });
});

describe("SyncScope provider fields — legacy four-field compatibility", () => {
  it("keeps the old four fields strictly compared", () => {
    expect(sameSyncScope(legacy(), legacy({ accountId: "842e8d68b92fd8d8" }))).toBe(false);
    expect(sameSyncScope(legacy(), legacy({ vaultFolderId: "other" }))).toBe(false);
    expect(sameSyncScope(legacy(), legacy({ filesRootId: "other" }))).toBe(false);
  });

  it("keeps the OneDrive 16-hex drive id compatibility and S3/WebDAV drive ids strict", () => {
    expect(sameSyncScope(
      legacy(),
      legacy({ driveId: "842e8d68b92fd8d7" }),
    )).toBe(true);
    // 16-hex Personal compatibility is an existing OneDrive rule; other
    // drive-id shapes (bucket/origin) stay byte-strict.
    expect(sameSyncScope(
      s3(),
      s3({ driveId: "My-Bucket", containerId: "My-Bucket" }),
    )).toBe(false);
    expect(sameSyncScope(
      webdav(),
      webdav({ driveId: "https://DAV.example.com", endpointId: "https://DAV.example.com" }),
    )).toBe(false);
  });

  it("handles nulls exactly as before", () => {
    expect(sameSyncScope(null, null)).toBe(true);
    expect(sameSyncScope(legacy(), null)).toBe(false);
    expect(sameSyncScope(null, legacy())).toBe(false);
    expect(sameSyncScope(s3(), null)).toBe(false);
  });
});

describe("isSyncScope — new optional fields", () => {
  it("accepts a legacy scope without any new field", () => {
    expect(isSyncScope(legacy())).toBe(true);
  });

  it("accepts explicit defaults and all three provider kinds", () => {
    expect(isSyncScope(explicitOneDriveDefaults())).toBe(true);
    expect(isSyncScope(s3())).toBe(true);
    expect(isSyncScope(webdav())).toBe(true);
  });

  it("rejects an invalid providerKind", () => {
    expect(isSyncScope({ ...legacy(), providerKind: "dropbox" })).toBe(false);
    expect(isSyncScope({ ...legacy(), providerKind: "" })).toBe(false);
    expect(isSyncScope({ ...legacy(), providerKind: 1 })).toBe(false);
  });

  it("rejects non-string optional values", () => {
    expect(isSyncScope({ ...legacy(), endpointId: 1 })).toBe(false);
    expect(isSyncScope({ ...legacy(), containerId: null })).toBe(false);
    expect(isSyncScope({ ...legacy(), rootPath: {} })).toBe(false);
    expect(isSyncScope({ ...legacy(), credentialBindingId: true })).toBe(false);
  });

  it("still requires all four legacy fields to be non-empty strings", () => {
    expect(isSyncScope({ ...legacy(), accountId: "" })).toBe(false);
    expect(isSyncScope({ ...legacy(), driveId: "" })).toBe(false);
    expect(isSyncScope({ ...legacy(), vaultFolderId: "" })).toBe(false);
    expect(isSyncScope({ ...legacy(), filesRootId: "" })).toBe(false);
    expect(isSyncScope({ providerKind: "s3" })).toBe(false);
    expect(isSyncScope(null)).toBe(false);
  });
});
