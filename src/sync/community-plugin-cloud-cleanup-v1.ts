import type { DriveItem } from "../onedrive/types";
import type { RemoteFileEntry } from "./types";

/**
 * LocalStorage marker recording a completed cloud cleanup for one plugin.
 * While the marker is present and this device holds no local plugin files,
 * the row stays hidden. The marker never authorizes deletion on its own;
 * a main-side sweep drops it once the plugin's complete bundle reappears in
 * the cloud, silently un-hiding the row (2026-09-09: 重现即展示, 无需专门提示).
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

export interface CommunityPluginCloudCleanupMarkerV1 {
  pluginId: string;
  cleanedAt: number;
}

/**
 * Normalize persisted markers: one marker per plugin, keeping the newest
 * cleanedAt, sorted by pluginId. Repeated cleanup runs on the same plugin
 * (e.g. a double click or a retried action) must never stack duplicate
 * markers, which would duplicate later reappearance sweeps.
 */
export function normalizeCommunityPluginCloudCleanupMarkersV1(
  markers: readonly CommunityPluginCloudCleanupMarkerV1[],
): CommunityPluginCloudCleanupMarkerV1[] {
  const latestByPluginId = new Map<string, number>();
  for (const marker of markers) {
    const previous = latestByPluginId.get(marker.pluginId);
    if (previous === undefined || marker.cleanedAt > previous) {
      latestByPluginId.set(marker.pluginId, marker.cleanedAt);
    }
  }
  return [...latestByPluginId.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([pluginId, cleanedAt]) => ({ pluginId, cleanedAt }));
}

export interface CommunityPluginCloudCleanupMarkerSweepV1 {
  remaining: CommunityPluginCloudCleanupMarkerV1[];
  /** Plugins whose marker is dropped because their complete bundle reappeared
   *  in the cloud. */
  resurrectedPluginIds: string[];
}

/**
 * Decide which cleanup markers survive one round of reappearance evidence.
 * A marker is dropped as soon as the plugin's bundle is complete again in
 * the cloud: the marker only ever justifies hiding a row while the plugin is
 * genuinely gone from this device's world (no local files, no complete cloud
 * bundle), and once the cloud re-acquires the bundle the row must come back
 * so the user can re-join or clean it again (2026-09-09 用户拍板, no
 * dedicated notice).
 *
 * Participation phases are deliberately not consulted here. The marker
 * (localStorage) and the participation store (device state) have different
 * lifecycles; a reset or migration can drop the phase while the marker
 * survives, and keying retirement on any phase enumeration then traps the
 * row into permanent invisibility with no user-side exit (2026-09-09 现场:
 * phase-less orphaned markers never swept). Failing open toward visibility
 * is safe — an un-hidden row is at worst one inert off toggle, while a
 * stuck-hidden row cannot be managed, re-joined or re-cleaned.
 */
export function planCommunityPluginCloudCleanupMarkerSweepV1(input: Readonly<{
  markers: readonly CommunityPluginCloudCleanupMarkerV1[];
  /** Plugin ids whose complete bundle is in the current cloud catalog. */
  reappearedPluginIds: readonly string[];
}>): CommunityPluginCloudCleanupMarkerSweepV1 {
  const reappeared = new Set(input.reappearedPluginIds);
  const remaining: CommunityPluginCloudCleanupMarkerV1[] = [];
  const resurrectedPluginIds: string[] = [];
  const resurrectedSeen = new Set<string>();
  for (const marker of normalizeCommunityPluginCloudCleanupMarkersV1(
    input.markers,
  )) {
    if (reappeared.has(marker.pluginId)) {
      if (!resurrectedSeen.has(marker.pluginId)) {
        resurrectedSeen.add(marker.pluginId);
        resurrectedPluginIds.push(marker.pluginId);
      }
      continue;
    }
    remaining.push(marker);
  }
  return { remaining, resurrectedPluginIds };
}

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
