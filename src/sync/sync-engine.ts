/**
 * SyncEngine — Three-way comparison and sync plan generation
 *
 * Core algorithm:
 *  Compare localSnapshot, remoteSnapshot, and baseSnapshot to
 *  determine what changed on each side and generate a SyncPlan.
 *
 * Decision matrix per file (present in each snapshot):
 *  - Local only, not in base → Upload (new local file)
 *  - Remote only, not in base → Download (new remote file)
 *  - Local only modified vs base → Upload
 *  - Remote only modified vs base → Download
 *  - Both modified → Conflict
 *  - Base exists, local gone → DeleteRemote (user deleted locally)
 *  - Base exists, remote gone → ConfirmLocalDelete (remote delete)
 *  - Local + remote both new, same content → establish baseline silently
 *  - Local + remote both new, different content → Conflict
 *
 * Safety rules:
 *  - File must exist in baseSnapshot AND be clearly missing in current scan
 *    to generate a delete action. 0-byte files, empty dirs, uninitialized state,
 *    and scan failures must NOT trigger deletes.
 *  - Single file failure doesn't terminate the sync run.
 *  - Change threshold: if >50% of files would change, pause for confirmation.
 *  - Operations ordered: create dirs → upload/download → delete.
 */

import {
  type LocalFileEntry,
  type RemoteFileEntry,
  type BaseFileEntry,
  type SyncPlan,
  type SyncPlanItem,
  SyncActionType,
  CHANGE_THRESHOLD_RATIO,
} from "./types";

/** Build a lookup map from path → entry */
function toMap<T extends { path: string }>(entries: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    map.set(entry.path, entry);
  }
  return map;
}

export function remoteContentMatchesBase(
  remote: RemoteFileEntry | undefined,
  base: BaseFileEntry,
): boolean {
  return Boolean(
    remote?.sha256Hash
      && remote.size === base.size
      && remote.sha256Hash.toLowerCase() === base.hash,
  );
}

export class SyncEngine {
  /**
   * Generate a sync plan by comparing local, remote, and base snapshots.
   */
  generatePlan(
    localEntries: LocalFileEntry[],
    remoteEntries: RemoteFileEntry[],
    baseEntries: BaseFileEntry[],
    skippedLarge: string[],
  ): SyncPlan {
    const localMap = toMap(localEntries);
    const remoteMap = toMap(remoteEntries);
    const baseMap = toMap(baseEntries);
    const skippedSet = new Set(skippedLarge);

    const plan: SyncPlanItem[] = [];

    // ── Step 0: Rename detection via content hash matching ──
    // Match files that disappeared locally with files that appeared
    // locally by SHA-256 hash, producing RenameRemote actions.
    const renames = this.detectRenames(
      localMap,
      remoteMap,
      baseMap,
      skippedSet,
    );
    const renamedOldPaths = new Set(renames.keys());
    const renamedNewPaths = new Set(
      [...renames.values()].map((r) => r.newPath),
    );

    for (const [oldPath, { newPath, localEntry, remoteEntry }] of renames) {
      plan.push({
        type: SyncActionType.RenameRemote,
        path: newPath,
        renameFrom: oldPath,
        local: localEntry,
        remote: remoteEntry,
      });
    }

    // Collect all paths that appear in any snapshot
    const allPaths = new Set<string>();
    for (const e of localEntries) allPaths.add(e.path);
    for (const e of remoteEntries) allPaths.add(e.path);
    for (const e of baseEntries) allPaths.add(e.path);

    for (const path of allPaths) {
      // Files exceeding the size limit are intentionally absent from localEntries.
      // They must NOT be classified as deleted — the skippedLarge loop below
      // will emit SkipLargeFile actions for them instead.
      if (skippedSet.has(path)) continue;
      // Skip paths already handled by rename detection
      if (renamedOldPaths.has(path) || renamedNewPaths.has(path)) continue;

      const local = localMap.get(path);
      const remote = remoteMap.get(path);
      const base = baseMap.get(path);

      const item = this.classify(path, local, remote, base);
      if (item) {
        plan.push(item);
      }
    }

    // Add skip items for large files
    for (const path of skippedLarge) {
      // Only add if file actually exists locally (not already handled)
      if (!plan.some((p) => p.path === path)) {
        plan.push({
          type: SyncActionType.SkipLargeFile,
          path,
          reason: `reason.fileExceedsSizeLimit`,
        });
      }
    }

    return {
      items: this.orderPlan(plan),
      lastTotalFiles: baseEntries.length,
      confirmed: false,
    };
  }

  /**
   * Classify a single file into a SyncPlanItem based on three-way comparison.
   *
   * Returns null if no action is needed (file unchanged on both sides).
   */
  private classify(
    path: string,
    local: LocalFileEntry | undefined,
    remote: RemoteFileEntry | undefined,
    base: BaseFileEntry | undefined,
  ): SyncPlanItem | null {
    // ---- No base entry: new file scenario ----
    if (!base) {
      // Both sides have the file
      if (local && remote) {
        return {
          type: SyncActionType.Conflict,
          path,
          local,
          remote,
          reason: "reason.newFileBothSides",
        };
      }
      // Local only → upload
      if (local && !remote) {
        return { type: SyncActionType.Upload, path, local };
      }
      // Remote only → download
      if (remote && !local) {
        return { type: SyncActionType.Download, path, remote };
      }
      return null;
    }

    // ---- Base entry exists: compare against baseline ----
    const localChanged = local && (local.hash !== base.hash || local.size !== base.size);
    const remoteChanged = remote && (
      remote.sha256Hash
        ? !remoteContentMatchesBase(remote, base)
        : remote.eTag !== base.eTag
    );

    // Local deleted
    if (!local && remote) {
      // Remote also changed → conflict (one side deleted, other modified)
      if (remoteChanged) {
        return {
          type: SyncActionType.Conflict,
          path,
          remote,
          reason: "reason.localDeletedRemoteModified",
        };
      }
      // Remote unchanged → user deleted locally, sync the deletion
      return {
        type: SyncActionType.DeleteRemote,
        path,
        remote,
        reason: "reason.fileDeletedLocally",
      };
    }

    // Remote deleted
    if (local && !remote) {
      // Local also changed → conflict
      if (localChanged) {
        return {
          type: SyncActionType.Conflict,
          path,
          local,
          reason: "reason.remoteDeletedLocalModified",
        };
      }
      // Local unchanged → remote deletion affects local, ask user
      return {
        type: SyncActionType.ConfirmLocalDelete,
        path,
        local,
        reason: "reason.fileDeletedFromRemote",
      };
    }

    // Both missing (deleted on both sides) → no action needed
    if (!local && !remote) {
      return null;
    }

    // Both exist — check for changes
    if (local && remote) {
      if (localChanged && remoteChanged) {
        return {
          type: SyncActionType.Conflict,
          path,
          local,
          remote,
          reason: "reason.bothSidesModified",
        };
      }
      if (localChanged && !remoteChanged) {
        return { type: SyncActionType.Upload, path, local, baseEtag: base.eTag };
      }
      if (!localChanged && remoteChanged) {
        return { type: SyncActionType.Download, path, remote };
      }
      // Neither changed → no action
      return null;
    }

    return null;
  }

  /**
   * Detect local file renames by matching content hashes between files
   * that disappeared (in base but not local) and files that appeared
   * (in local but not base).
   *
   * Safety constraints (inspired by Syncthing's approach):
   *  - 0-byte files are skipped — all empty files have the same hash.
   *  - Hash collisions on either side (>1 file with same hash) skip.
   *  - Only same-directory renames are matched; cross-directory moves
   *    need the destination folder's driveItem ID for the PATCH API
   *    and safely fall through to Upload + DeleteRemote.
   */
  private detectRenames(
    localMap: Map<string, LocalFileEntry>,
    remoteMap: Map<string, RemoteFileEntry>,
    baseMap: Map<string, BaseFileEntry>,
    skippedSet: Set<string>,
  ): Map<string, { newPath: string; localEntry: LocalFileEntry; baseEntry: BaseFileEntry; remoteEntry: RemoteFileEntry }> {
    const renames = new Map<string, { newPath: string; localEntry: LocalFileEntry; baseEntry: BaseFileEntry; remoteEntry: RemoteFileEntry }>();

    // Build hash → paths for "disappeared" files:
    //   file in base + remote, but NOT in local → would be DeleteRemote.
    const disappearedByHash = new Map<string, Array<{ path: string; base: BaseFileEntry }>>();
    for (const [path, base] of baseMap) {
      if (localMap.has(path)) continue; // still exists
      if (!remoteMap.has(path)) continue; // also deleted remotely
      if (skippedSet.has(path)) continue;
      if (base.size === 0) continue; // empty file — skip
      const arr = disappearedByHash.get(base.hash) ?? [];
      arr.push({ path, base });
      disappearedByHash.set(base.hash, arr);
    }

    // Build hash → paths for "appeared" files:
    //   file in local, but NOT in base nor remote → would be Upload.
    const appearedByHash = new Map<string, Array<{ path: string; local: LocalFileEntry }>>();
    for (const [path, local] of localMap) {
      if (baseMap.has(path)) continue; // already tracked
      if (remoteMap.has(path)) continue; // exists remotely
      if (skippedSet.has(path)) continue;
      if (local.size === 0) continue; // empty file — skip
      const arr = appearedByHash.get(local.hash) ?? [];
      arr.push({ path, local });
      appearedByHash.set(local.hash, arr);
    }

    // Match 1:1 rename pairs (same hash, one disappeared, one appeared, same directory)
    for (const [hash, disappeared] of disappearedByHash) {
      const appeared = appearedByHash.get(hash);
      if (!appeared) continue;
      // Require exactly one match on each side (ambiguous otherwise)
      if (disappeared.length !== 1 || appeared.length !== 1) continue;

      const oldPath = disappeared[0].path;
      const newPath = appeared[0].path;

      // Same-directory check
      const oldDir = oldPath.includes("/")
        ? oldPath.substring(0, oldPath.lastIndexOf("/"))
        : "";
      const newDir = newPath.includes("/")
        ? newPath.substring(0, newPath.lastIndexOf("/"))
        : "";
      if (oldDir !== newDir) continue; // cross-directory → fall through to Upload+DeleteRemote

      const remote = remoteMap.get(oldPath)!;
      renames.set(oldPath, {
        newPath,
        localEntry: appeared[0].local,
        baseEntry: disappeared[0].base,
        remoteEntry: remote,
      });
    }

    return renames;
  }

  /**
   * Order plan items for safe execution:
   * 1. Uploads + Downloads (create/update files)
   * 2. Conflicts (flag, don't execute)
   * 3. Deletes (deleteRemote, confirmLocalDelete — safest last)
   */
  private orderPlan(items: SyncPlanItem[]): SyncPlanItem[] {
    const priority: Record<SyncActionType, number> = {
      [SyncActionType.Upload]: 0,
      [SyncActionType.Download]: 0,
      [SyncActionType.RenameRemote]: 0,
      [SyncActionType.SkipLargeFile]: 1,
      [SyncActionType.SkipIgnoredPath]: 1,
      [SyncActionType.RetryLater]: 2,
      [SyncActionType.Conflict]: 3,
      [SyncActionType.ConfirmLocalDelete]: 4,
      [SyncActionType.DeleteRemote]: 5,
      [SyncActionType.AuthExpired]: 6,
    };

    return [...items].sort(
      (a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99),
    );
  }

  /**
   * Check if the change ratio exceeds the threshold.
   * Returns true if the plan should be paused for user confirmation.
   */
  shouldPauseForConfirmation(plan: SyncPlan): boolean {
    if (plan.lastTotalFiles === 0) {
      // First sync — no threshold check
      return false;
    }

    const changeCount = plan.items.filter(
      (item) =>
        item.type !== SyncActionType.SkipLargeFile &&
        item.type !== SyncActionType.SkipIgnoredPath &&
        item.type !== SyncActionType.RetryLater &&
        item.type !== SyncActionType.RenameRemote &&
        item.type !== SyncActionType.Conflict &&
        item.type !== SyncActionType.ConfirmLocalDelete,
    ).length;

    const ratio = changeCount / plan.lastTotalFiles;
    return ratio > CHANGE_THRESHOLD_RATIO;
  }
}
