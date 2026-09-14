/**
 * Auto-update facts for community plugins in one finished sync round.
 *
 * An "auto update" here is the ordinary sync path: an already-participating
 * plugin's bundle files (main.js / manifest.json / styles.css) were silently
 * downloaded over the local copies. Explicit accepts — a fresh join, a
 * restore, or a new install — carry their own prompt semantics and are
 * excluded by requiring the plugin to have participated before this round
 * (design doc 20260908-2131 §六.1 / §八.1).
 *
 * This module is pure and performs no I/O. Version presentation is left to
 * the caller: when `manifestDownloaded` is true the caller may read the
 * freshly written local manifest.json for the new version; when it is false
 * (e.g. a styles.css-only update) no fresh manifest arrived and the version
 * cannot be claimed to have changed.
 */

import { parseCommunityPluginBundlePath } from "./community-plugin-bundle";
import { isSuccessfulFileProgress, type FileProgress } from "./sync-progress";
import { SyncActionType } from "./types";

export interface CommunityPluginAutoUpdateCandidate {
  pluginId: string;
  /**
   * True when a manifest.json member of this plugin was downloaded in the
   * same round, so the local manifest.json was freshly written and carries
   * the new version. False when only other bundle members (main.js /
   * styles.css) were downloaded.
   */
  manifestDownloaded: boolean;
}

export interface CommunityPluginUpdateFactsInput {
  /**
   * Per-file completion records of one finished sync round, successful and
   * failed rows alike. A failed bundle-member download is an update that did
   * not happen; it must never be announced as a success.
   */
  files: readonly Pick<FileProgress, "path" | "actionType" | "status">[];
  /** Vault config dir passed through to parseCommunityPluginBundlePath. */
  configDir: string;
  /**
   * Plugin ids whose participation already existed before this round (this
   * device's existing plugins). A downloaded bundle whose id is absent here
   * was explicitly accepted this round — fresh join / restore / new install —
   * and is intentionally not an auto-update candidate. Absent = no plugin is
   * known to have participated before the round, so nothing is claimed as an
   * auto update (fail-safe: participation facts are the caller's duty).
   */
  participatingBeforePluginIds?: readonly string[];
  /** EasySync's own plugin id; its own downloaded bundle is never a candidate. */
  ownPluginId?: string;
}

/**
 * Build the auto-update candidates of one sync round from its completed-file
 * list and the participation facts that existed before the round.
 *
 * A candidate is a plugin whose plugin-directory bundle member (main.js /
 * manifest.json / styles.css) was successfully completed as a Download this
 * round and none of whose bundle-member downloads failed this round — a
 * partially failed bundle still runs old code for the failed members, so it
 * must not be announced as updated. Candidates are deduplicated by plugin id
 * and returned in first-appearance order of the Download entries. Path parsing
 * and normalization follow parseCommunityPluginBundlePath.
 */
export function buildCommunityPluginUpdateFacts(
  input: CommunityPluginUpdateFactsInput,
): CommunityPluginAutoUpdateCandidate[] {
  const participatedBefore = new Set(input.participatingBeforePluginIds ?? []);
  const manifestDownloadedById = new Map<string, boolean>();
  const failedBundleMemberIds = new Set<string>();
  for (const file of input.files) {
    const parsed = parseCommunityPluginBundlePath(file.path, input.configDir);
    if (!parsed) continue;
    if (parsed.pluginId === input.ownPluginId) continue;
    if (!participatedBefore.has(parsed.pluginId)) continue;
    if (file.actionType !== SyncActionType.Download) continue;
    if (!isSuccessfulFileProgress(file)) {
      failedBundleMemberIds.add(parsed.pluginId);
      continue;
    }
    if (parsed.fileName === "manifest.json") {
      manifestDownloadedById.set(parsed.pluginId, true);
    } else if (!manifestDownloadedById.has(parsed.pluginId)) {
      manifestDownloadedById.set(parsed.pluginId, false);
    }
  }
  const candidates: CommunityPluginAutoUpdateCandidate[] = [];
  for (const [pluginId, manifestDownloaded] of manifestDownloadedById) {
    if (failedBundleMemberIds.has(pluginId)) continue;
    candidates.push({ pluginId, manifestDownloaded });
  }
  return candidates;
}
