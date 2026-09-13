import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { normalizeVaultPathKey } from "../obsidian-compat";

export type VaultCloudClientService = "onedrive" | "icloud";

export interface VaultCloudClientDetection {
  /**
   * Whether the vault base path could be inspected at all. Mobile adapters
   * expose no vault base path, so the environment stays undecidable there.
   */
  assessable: boolean;
  detected: boolean;
  service: VaultCloudClientService | null;
  /** The matched signature in its normalized form, for diagnostics only. */
  signature: string | null;
}

interface CloudPathSignature {
  service: VaultCloudClientService;
  match: (normalizedPath: string, segments: readonly string[]) => boolean;
  describe: (normalizedPath: string) => string;
}

/**
 * Path signatures for vaults living inside a desktop cloud client's sync
 * folder. Every signature below is corroborated by at least two independent
 * real-world sources (Microsoft/Apple client behavior, ecosystem detection
 * implementations, or sampled user paths); see the cloud environment research
 * record for the evidence table. Matching is deliberately conservative:
 * a miss only skips a reminder, while a hit must be trustworthy.
 */
const CLOUD_PATH_SIGNATURES: readonly CloudPathSignature[] = [
  {
    service: "onedrive",
    // Windows sync roots: "OneDrive", "OneDrive - <Org>", and custom roots
    // that keep the client's default "OneDrive" folder name anywhere on disk.
    match: (_path, segments) =>
      segments.some((segment) =>
        segment === "onedrive" || segment.startsWith("onedrive - ")),
    describe: () => "OneDrive 目录段",
  },
  {
    service: "onedrive",
    // macOS File Provider mount (macOS 12.1+): "OneDrive-Personal" and
    // "OneDrive-<Org>" under ~/Library/CloudStorage.
    match: (path) =>
      path.includes("/library/cloudstorage/onedrive"),
    describe: (path) =>
      path.slice(path.indexOf("/library/cloudstorage/onedrive")),
  },
  {
    service: "icloud",
    // macOS: the official "iCloud Drive" location for vaults.
    match: (path) =>
      path.includes("/mobile documents/com~apple~clouddocs"),
    describe: (path) =>
      path.slice(path.indexOf("/mobile documents/com~apple~clouddocs")),
  },
  {
    service: "icloud",
    // macOS: the Obsidian iOS app's iCloud container mounted on the Mac.
    match: (path) =>
      path.includes("/mobile documents/icloud~md~obsidian"),
    describe: (path) =>
      path.slice(path.indexOf("/mobile documents/icloud~md~obsidian")),
  },
  {
    service: "icloud",
    // macOS: the CloudStorage variant that some systems expose.
    match: (path) =>
      path.includes("/library/cloudstorage/icloud drive"),
    describe: (path) =>
      path.slice(path.indexOf("/library/cloudstorage/icloud drive")),
  },
  {
    service: "icloud",
    // Windows: iCloud for Windows keeps drive content in "%USERPROFILE%\iCloudDrive".
    match: (_path, segments) =>
      segments.some((segment) => segment === "iclouddrive"),
    describe: () => "iCloudDrive 目录段",
  },
];

/**
 * Classify whether this vault sits inside a desktop cloud client's sync
 * folder. EasySync talks to OneDrive through the Graph API and does not need
 * the client, but a client syncing the same folder concurrently edits, locks
 * and rolls back the vault's files behind the plugin's back — the failure
 * shape behind repeated "state cannot be loaded safely" deadlocks and reset
 * failures on Windows. Pure string classification: no Node APIs, no network,
 * no filesystem access outside the path the platform already handed us.
 */
export function detectVaultCloudClientEnvironment(
  vault: Vault,
): VaultCloudClientDetection {
  if (!Platform.isDesktopApp) {
    return { assessable: false, detected: false, service: null, signature: null };
  }
  if (!(vault.adapter instanceof FileSystemAdapter)) {
    return { assessable: false, detected: false, service: null, signature: null };
  }
  let basePath: unknown;
  try {
    basePath = vault.adapter.getBasePath();
  } catch {
    return { assessable: false, detected: false, service: null, signature: null };
  }
  if (typeof basePath !== "string" || basePath === "") {
    return { assessable: false, detected: false, service: null, signature: null };
  }
  const normalizedPath = normalizeVaultPathKey(basePath);
  const segments = normalizedPath.split("/");
  for (const signature of CLOUD_PATH_SIGNATURES) {
    if (signature.match(normalizedPath, segments)) {
      return {
        assessable: true,
        detected: true,
        service: signature.service,
        signature: signature.describe(normalizedPath),
      };
    }
  }
  return { assessable: true, detected: false, service: null, signature: null };
}
