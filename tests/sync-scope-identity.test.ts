import { describe, expect, it } from "vitest";
import { isSameDriveId, sameSyncScope, type SyncScope } from "../src/sync/types";

const scope = (overrides: Partial<SyncScope> = {}): SyncScope => ({
  accountId: "842e8d68b92fd8d7",
  driveId: "842E8D68B92FD8D7",
  vaultFolderId: "842E8D68B92FD8D7!s2e987e7d451c46a7a234b7f09ad109c0",
  filesRootId: "842E8D68B92FD8D7!sbe26d7449f0e4a9488997492185373ab",
  ...overrides,
});

describe("isSameDriveId — P0-A narrow drive-ID compatibility", () => {
  it("treats byte-equal drive IDs as the same", () => {
    expect(isSameDriveId("842E8D68B92FD8D7", "842E8D68B92FD8D7")).toBe(true);
    expect(isSameDriveId("842e8d68b92fd8d7", "842e8d68b92fd8d7")).toBe(true);
  });

  it("treats 16-hex Personal drive IDs as the same across case", () => {
    expect(isSameDriveId("842E8D68B92FD8D7", "842e8d68b92fd8d7")).toBe(true);
  });

  it("never blurs distinct drive IDs", () => {
    expect(isSameDriveId("842E8D68B92FD8D7", "842E8D68B92FD8D8")).toBe(false);
    expect(isSameDriveId("842e8d68b92fd8d7", "0000000000000000")).toBe(false);
  });

  it("stays strict for non-16-hex identifiers (sharepoint / folder-shaped)", () => {
    // Folder IDs contain a non-hex prefix and must never fold by case.
    expect(isSameDriveId("b!abcDEF", "b!abcdef")).toBe(false);
    expect(isSameDriveId("s2e987e7d451c46a7a234b7f09ad109c0", "S2E987E7D451C46A7A234B7F09AD109C0")).toBe(false);
    // 15 or 17 hex chars are not the Personal shape.
    expect(isSameDriveId("842E8D68B92FD8D", "842e8d68b92fd8d")).toBe(false);
    expect(isSameDriveId("842E8D68B92FD8D70", "842e8d68b92fd8d70")).toBe(false);
  });

  it("treats undefined/missing consistently", () => {
    expect(isSameDriveId(undefined, undefined)).toBe(true);
    expect(isSameDriveId("842E8D68B92FD8D7", undefined)).toBe(false);
    expect(isSameDriveId(undefined, "842E8D68B92FD8D7")).toBe(false);
  });
});

describe("sameSyncScope — drive ID case narrow compatibility while other fields stay strict", () => {
  it("accepts an identical scope", () => {
    expect(sameSyncScope(scope(), scope())).toBe(true);
  });

  it("accepts a Personal drive ID that differs only by case (the bootstrap-v2 invalid-current root cause)", () => {
    expect(sameSyncScope(
      scope(),
      scope({ driveId: "842e8d68b92fd8d7" }),
    )).toBe(true);
  });

  it("rejects a genuinely different drive ID", () => {
    expect(sameSyncScope(
      scope(),
      scope({ driveId: "842E8D68B92FD8D8" }),
    )).toBe(false);
  });

  it("rejects when a non-Personal-shaped drive ID differs by case", () => {
    expect(sameSyncScope(
      scope({ driveId: "b!AbCdEf123456" }),
      scope({ driveId: "b!abcdef123456" }),
    )).toBe(false);
  });

  it("keeps accountId / vaultFolderId / filesRootId strictly compared", () => {
    expect(sameSyncScope(scope(), scope({ accountId: "842e8d68b92fd8d8" }))).toBe(false);
    expect(sameSyncScope(
      scope(),
      scope({ vaultFolderId: "842E8D68B92FD8D7!s2e987e7d451c46a7a234b7f09ad109c1" }),
    )).toBe(false);
    expect(sameSyncScope(
      scope(),
      scope({ filesRootId: "842E8D68B92FD8D7!sbe26d7449f0e4a9488997492185373ac" }),
    )).toBe(false);
    // Even case differences in the folder-shaped fields stay strict.
    expect(sameSyncScope(
      scope(),
      scope({ vaultFolderId: "842e8d68b92fd8d7!s2e987e7d451c46a7a234b7f09ad109c0" }),
    )).toBe(false);
  });

  it("handles nulls", () => {
    expect(sameSyncScope(null, null)).toBe(true);
    expect(sameSyncScope(scope(), null)).toBe(false);
    expect(sameSyncScope(null, scope())).toBe(false);
  });
});
