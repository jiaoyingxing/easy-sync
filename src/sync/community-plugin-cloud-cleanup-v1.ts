import type { DriveItem } from "../onedrive/types";
import type { RemoteFileEntry } from "./types";

/**
 * LocalStorage marker recording a completed cloud cleanup for one plugin.
 * Used only for the one-shot resurrection notice (Q2); it never authorizes
 * deletion and is dropped once the plugin reappears or the check runs.
 */
export const COMMUNITY_PLUGIN_CLOUD_CLEANUP_MARKER_KEY =
  "easy-sync-community-plugin-cloud-cleanup-v1";

const CLEANUP_FILE_NAMES = new Set(["main.js", "manifest.json", "styles.css"]);

export interface CommunityPluginCloudCleanupObjectV1 {
  fileName: "main.js" | "manifest.json" | "styles.css";
  path: string;
  remoteId: string;
  eTag: string;
  size: number;
}

export interface CommunityPluginCloudCleanupPlanV1 {
  pluginId: string;
  objects: CommunityPluginCloudCleanupObjectV1[];
}

export interface CommunityPluginCloudCleanupTransportV1 {
  vaultName: string;
  getDriveItemMetadataById(id: string): Promise<DriveItem | null>;
  deleteItem(
    vaultName: string,
    path: string,
    eTag: string | undefined,
    driveId: string,
  ): Promise<unknown>;
}

export type CommunityPluginCloudCleanupResultV1 =
  | { status: "completed"; deleted: number }
  | {
      status: "blocked";
      deleted: number;
      reason: "remote-changed" | "delete-failed" | "read-back-failed";
      error?: string;
    }
  | { status: "failed"; deleted: number; error: string };

/**
 * A row is cleanable once this device holds no managed files for the plugin
 * (`local: false`) AND the cloud index still lists it (`remote: true`) AND
 * the device is not actively joining, restoring, participating, exiting or
 * blocked on it. This mirrors the "plugin only in the cloud" status row:
 * an uninstalled, not-participating plugin on this device still has its
 * cloud bundle listed, and only the user's explicit confirmation decides
 * whether to delete it. Active/blocked phases never offer the affordance,
 * even when the local directory is momentarily absent.
 */
export function isCommunityPluginCloudCleanupCandidateV1(input: Readonly<{
  phase?: string;
  local?: boolean;
  remote: boolean;
}>): boolean {
  if (input.local !== false || !input.remote) return false;
  switch (input.phase) {
    case "join-requested":
    case "restoring":
    case "participating":
    case "exit-requested":
    case "blocked":
      return false;
    default:
      return true;
  }
}

/**
 * Enumerate exactly the managed bundle members of one plugin from the remote
 * index. `data.json`, nested paths, other plugins and EasySync itself never
 * enter the plan (Q3/Q4: data 另立合同, 空壳不删).
 */
export function planCommunityPluginCloudCleanupV1(input: Readonly<{
  pluginId: string;
  configDir: string;
  remoteEntries: readonly RemoteFileEntry[];
  ownPluginId?: string;
}>): CommunityPluginCloudCleanupPlanV1 {
  const ownPluginId = input.ownPluginId ?? "easy-sync";
  if (!isSafePluginId(input.pluginId) || input.pluginId === ownPluginId) {
    return { pluginId: input.pluginId, objects: [] };
  }
  const prefix = `${input.configDir}/plugins/${input.pluginId}/`;
  const objects: CommunityPluginCloudCleanupObjectV1[] = [];
  for (const entry of input.remoteEntries) {
    if (!entry.path.startsWith(prefix) || !entry.driveId) continue;
    const fileName = entry.path.slice(prefix.length);
    if (!CLEANUP_FILE_NAMES.has(fileName)) continue;
    objects.push({
      fileName: fileName as CommunityPluginCloudCleanupObjectV1["fileName"],
      path: entry.path,
      remoteId: entry.driveId,
      eTag: entry.eTag ?? "",
      size: entry.size,
    });
  }
  return { pluginId: input.pluginId, objects };
}

/**
 * Delete each planned object with current-identity verification, If-Match and
 * read-back. Already-absent objects are skipped, so an interrupted run is
 * naturally re-entrant: re-planning from the current remote index continues
 * where the previous run stopped. Any mismatch stops the whole cleanup as
 * blocked — this transaction never touches ordinary sync paths.
 */
export async function executeCommunityPluginCloudCleanupV1(input: Readonly<{
  plan: CommunityPluginCloudCleanupPlanV1;
  transport: CommunityPluginCloudCleanupTransportV1;
}>): Promise<CommunityPluginCloudCleanupResultV1> {
  let deleted = 0;
  for (const object of input.plan.objects) {
    let current: DriveItem | null = null;
    try {
      current = await input.transport.getDriveItemMetadataById(object.remoteId);
    } catch (error) {
      return {
        status: "failed",
        deleted,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (current === null || current.id !== object.remoteId) continue;
    if ((current.eTag ?? "") !== object.eTag) {
      return { status: "blocked", deleted, reason: "remote-changed" };
    }
    try {
      await input.transport.deleteItem(
        input.transport.vaultName,
        object.path,
        object.eTag,
        object.remoteId,
      );
    } catch (error) {
      return {
        status: "blocked",
        deleted,
        reason: "delete-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    let verify: DriveItem | null = null;
    try {
      verify = await input.transport.getDriveItemMetadataById(object.remoteId);
    } catch {
      verify = null;
    }
    if (verify !== null) {
      return { status: "blocked", deleted, reason: "read-back-failed" };
    }
    deleted++;
  }
  return { status: "completed", deleted };
}

function isSafePluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value);
}
