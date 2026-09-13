import { beforeEach, describe, expect, it } from "vitest";
import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import {
  detectVaultCloudClientEnvironment,
} from "../src/sync/cloud-client-environment";

function vaultAtBasePath(basePath: string): Vault {
  return {
    adapter: new FileSystemAdapter(basePath),
  } as unknown as Vault;
}

function mobileVault(): Vault {
  return { adapter: {} } as unknown as Vault;
}

describe("detectVaultCloudClientEnvironment", () => {
  beforeEach(() => {
    Object.assign(Platform, { isDesktopApp: true, isMobileApp: false });
  });

  it.each([
    [
      "onedrive",
      // The field case that produced the 2026-09-11 deadlock report:
      // Documents redirected into a custom OneDrive root on Windows.
      "D:\\折纸大师\\OneDrive\\文档\\收藏",
    ],
    ["onedrive", "C:\\Users\\User\\OneDrive\\Vault"],
    ["onedrive", "C:\\Users\\User\\OneDrive - Contoso\\Vault"],
    ["onedrive", "F:\\OneDrive\\Obsidian\\笔记库"],
    ["onedrive", "/Users/user/Library/CloudStorage/OneDrive-Personal/Vault"],
    [
      "onedrive",
      "/Users/user/Library/CloudStorage/OneDrive-共享的库-Onedrive/Vault",
    ],
    [
      "icloud",
      "/Users/user/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/Vault",
    ],
    [
      "icloud",
      "/Users/user/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault",
    ],
    ["icloud", "/Users/user/Library/CloudStorage/iCloud Drive/Vault"],
    ["icloud", "C:\\Users\\User\\iCloudDrive\\Vault"],
  ])("detects a %s sync folder for %s", (service, basePath) => {
    const detection = detectVaultCloudClientEnvironment(vaultAtBasePath(basePath));
    expect(detection.assessable).toBe(true);
    expect(detection.detected).toBe(true);
    expect(detection.service).toBe(service);
    expect(detection.signature).toBeTruthy();
  });

  it.each([
    "D:\\jiaor\\Documents\\焦应行的笔记本",
    "E:\\Studio",
    "C:\\Vaults\\Notes",
    "/Users/user/Documents/Obsidian/Vault",
    "/Users/user/Code/my-vault",
  ])("stays silent for a plain local vault at %s", (basePath) => {
    const detection = detectVaultCloudClientEnvironment(vaultAtBasePath(basePath));
    expect(detection).toEqual({
      assessable: true,
      detected: false,
      service: null,
      signature: null,
    });
  });

  it("does not mistake lookalike folder names for the client sync root", () => {
    const detection = detectVaultCloudClientEnvironment(
      vaultAtBasePath("D:\\Archives\\OneDriveBackups\\Vault"),
    );
    expect(detection.detected).toBe(false);
  });

  it("is undecidable on mobile", () => {
    Object.assign(Platform, { isDesktopApp: false, isMobileApp: true });
    const detection = detectVaultCloudClientEnvironment(mobileVault());
    expect(detection).toEqual({
      assessable: false,
      detected: false,
      service: null,
      signature: null,
    });
  });

  it("is undecidable when the adapter exposes no base path", () => {
    const detection = detectVaultCloudClientEnvironment(
      vaultAtBasePath(undefined as unknown as string),
    );
    expect(detection).toEqual({
      assessable: false,
      detected: false,
      service: null,
      signature: null,
    });
  });
});
