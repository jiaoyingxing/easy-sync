/**
 * Pure file decision planner.
 *
 * V2-10 extracted the proven three-way decision rules from the legacy
 * SyncEngine class. V2-14 removed that production facade and V2-16b removed
 * the production pre-manifest adapter; this module now serves only the
 * canonical V2 planner and the frozen public-1.1.3 test fixture.
 * It owns no adapter, Graph client, state store, mutation, or runtime cache.
 *
 * The snapshot-shaped input remains only for the frozen public-1.1.3 fixture.
 * The V2-11 canonical planner derives these facts from one committed envelope revision
 * and keeps the observable decisions under the same behavior contract.
 */

import {
  isEasySyncSelfSyncFilePath,
  normalizeVaultPathKey,
} from "../obsidian-compat";

import {
  type BaseFileEntry,
  type LocalFileEntry,
  type RemoteFileEntry,
  SyncActionType,
  type SyncPlan,
  type SyncPlanItem,
} from "./types";

export interface FileDecisionFactsV2 {
  localEntries: readonly LocalFileEntry[];
  remoteEntries: readonly RemoteFileEntry[];
  baseEntries: readonly BaseFileEntry[];
  skippedLarge: readonly string[];
}

/** Build a lookup map from path to the immutable input entry. */
function toMap<T extends { path: string }>(entries: readonly T[]): Map<string, T> {
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

const OBSIDIAN_MANAGED_CONFIG_FILES = new Set([
  "app.json",
  "appearance.json",
  "hotkeys.json",
  "core-plugins.json",
  "community-plugins.json",
]);

export function isObsidianManagedConfigPath(
  path: string,
  configDir = ".obsidian",
): boolean {
  // These files are live host-owned state. Their absence is not a durable
  // delete signal, so the present side restores the missing side.
  const normalizedDir = normalizeVaultPathKey(configDir)
    .replace(/^\/+|\/+$/g, "");
  const normalizedPath = normalizeVaultPathKey(path);
  if (!normalizedDir || !normalizedPath.startsWith(`${normalizedDir}/`)) return false;
  return OBSIDIAN_MANAGED_CONFIG_FILES.has(
    normalizedPath.slice(normalizedDir.length + 1),
  );
}

/**
 * EasySync self-sync never treats a missing remote bundle file as authority
 * to delete the running local plugin. The next canonical action restores the
 * cloud copy from the locally present bundle.
 */
export function protectEasySyncSelfSyncPlan(
  items: readonly SyncPlanItem[],
  configDir: string,
  pluginId = "easy-sync",
): SyncPlanItem[] {
  return items.map((item) => {
    if (
      item.local
      && !item.remote
      && isEasySyncSelfSyncFilePath(item.path, configDir, pluginId)
      && (
        item.type === SyncActionType.Conflict
        || item.type === SyncActionType.ConfirmLocalDelete
      )
    ) {
      return {
        type: SyncActionType.Upload,
        path: item.path,
        local: item.local,
      };
    }
    return item;
  });
}

/**
 * Generate the file portion of a sync plan from complete three-way facts.
 */
export function generateFileDecisionPlanV2(
  facts: FileDecisionFactsV2,
): SyncPlan {
  const {
    localEntries,
    remoteEntries,
    baseEntries,
    skippedLarge,
  } = facts;
  const localMap = toMap(localEntries);
  const remoteMap = toMap(remoteEntries);
  const baseMap = toMap(baseEntries);
  const skippedSet = new Set(skippedLarge);

  const plan: SyncPlanItem[] = [];

  // Match files that disappeared locally with files that appeared locally by
  // SHA-256 hash, producing identity-preserving same-directory remote renames.
  const renames = detectRenames(
    localMap,
    remoteMap,
    baseMap,
    skippedSet,
  );
  const renamedOldPaths = new Set(renames.keys());
  const renamedNewPaths = new Set(
    [...renames.values()].map((rename) => rename.newPath),
  );
  const unresolvedRelocationOldPaths = detectUnresolvedRelocations(
    localMap,
    remoteMap,
    baseMap,
    skippedSet,
    renamedOldPaths,
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

  const allPaths = new Set<string>();
  for (const entry of localEntries) allPaths.add(entry.path);
  for (const entry of remoteEntries) allPaths.add(entry.path);
  for (const entry of baseEntries) allPaths.add(entry.path);

  for (const path of allPaths) {
    // Oversized files are intentionally absent from localEntries. They must
    // never be mistaken for a local deletion.
    if (skippedSet.has(path)) continue;
    if (renamedOldPaths.has(path) || renamedNewPaths.has(path)) continue;

    const local = localMap.get(path);
    const remote = remoteMap.get(path);
    const base = baseMap.get(path);

    if (unresolvedRelocationOldPaths.has(path) && remote && base) {
      plan.push({
        type: SyncActionType.Conflict,
        path,
        remote,
        reason: "reason.renameIdentityAmbiguous",
      });
      continue;
    }

    const item = classifyFileDecision(path, local, remote, base);
    if (item) plan.push(item);
  }

  for (const path of skippedLarge) {
    plan.push({
      type: SyncActionType.SkipLargeFile,
      path,
      reason: "reason.fileExceedsSizeLimit",
    });
  }

  return {
    items: orderSyncPlanItemsV2(plan),
    lastTotalFiles: baseEntries.length,
    confirmed: false,
  };
}

function classifyFileDecision(
  path: string,
  local: LocalFileEntry | undefined,
  remote: RemoteFileEntry | undefined,
  base: BaseFileEntry | undefined,
): SyncPlanItem | null {
  if (!base) {
    if (local && remote) {
      return {
        type: SyncActionType.Conflict,
        path,
        local,
        remote,
        reason: "reason.newFileBothSides",
      };
    }
    if (local && !remote) {
      return { type: SyncActionType.Upload, path, local };
    }
    if (remote && !local) {
      return { type: SyncActionType.Download, path, remote };
    }
    return null;
  }

  const localChanged = local && (
    local.hash !== base.hash
    || local.size !== base.size
  );
  const remoteChanged = remote && (
    remote.sha256Hash
      ? !remoteContentMatchesBase(remote, base)
      : remote.eTag !== base.eTag
  );

  if (!local && remote) {
    if (isObsidianManagedConfigPath(path)) {
      return { type: SyncActionType.Download, path, remote };
    }
    if (remoteChanged) {
      return {
        type: SyncActionType.Conflict,
        path,
        remote,
        reason: "reason.localDeletedRemoteModified",
      };
    }
    return {
      type: SyncActionType.DeleteRemote,
      path,
      remote,
      reason: "reason.fileDeletedLocally",
    };
  }

  if (local && !remote) {
    if (isObsidianManagedConfigPath(path)) {
      return { type: SyncActionType.Upload, path, local };
    }
    if (localChanged) {
      return {
        type: SyncActionType.Conflict,
        path,
        local,
        reason: "reason.remoteDeletedLocalModified",
      };
    }
    return {
      type: SyncActionType.ConfirmLocalDelete,
      path,
      local,
      reason: "reason.fileDeletedFromRemote",
    };
  }

  if (!local && !remote) return null;

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
      return {
        type: SyncActionType.Upload,
        path,
        local,
        remote,
        baseEtag: base.eTag,
      };
    }
    if (!localChanged && remoteChanged) {
      return { type: SyncActionType.Download, path, local, remote };
    }
  }

  return null;
}

interface RenameDecision {
  newPath: string;
  localEntry: LocalFileEntry;
  remoteEntry: RemoteFileEntry;
}

function detectRenames(
  localMap: ReadonlyMap<string, LocalFileEntry>,
  remoteMap: ReadonlyMap<string, RemoteFileEntry>,
  baseMap: ReadonlyMap<string, BaseFileEntry>,
  skippedSet: ReadonlySet<string>,
): Map<string, RenameDecision> {
  const renames = new Map<string, RenameDecision>();
  const disappearedByHash = new Map<
    string,
    Array<{ path: string; base: BaseFileEntry }>
  >();

  for (const [path, base] of baseMap) {
    if (localMap.has(path)) continue;
    if (!remoteMap.has(path)) continue;
    if (skippedSet.has(path)) continue;
    if (base.size === 0) continue;
    const entries = disappearedByHash.get(base.hash) ?? [];
    entries.push({ path, base });
    disappearedByHash.set(base.hash, entries);
  }

  const appearedByHash = new Map<
    string,
    Array<{ path: string; local: LocalFileEntry }>
  >();
  for (const [path, local] of localMap) {
    if (baseMap.has(path)) continue;
    if (remoteMap.has(path)) continue;
    if (skippedSet.has(path)) continue;
    if (local.size === 0) continue;
    const entries = appearedByHash.get(local.hash) ?? [];
    entries.push({ path, local });
    appearedByHash.set(local.hash, entries);
  }

  for (const [hash, disappeared] of disappearedByHash) {
    const appeared = appearedByHash.get(hash);
    if (!appeared) continue;
    if (disappeared.length !== 1 || appeared.length !== 1) continue;

    const oldPath = disappeared[0].path;
    const newPath = appeared[0].path;
    if (parentPath(oldPath) !== parentPath(newPath)) continue;

    const remote = remoteMap.get(oldPath)!;
    if (!remoteVersionMatchesBase(remote, disappeared[0].base)) continue;
    renames.set(oldPath, {
      newPath,
      localEntry: appeared[0].local,
      remoteEntry: remote,
    });
  }

  return renames;
}

/**
 * Preserve the old remote object when content evidence suggests a move/copy,
 * but destination identity is not a unique safe same-directory rename.
 */
function detectUnresolvedRelocations(
  localMap: ReadonlyMap<string, LocalFileEntry>,
  remoteMap: ReadonlyMap<string, RemoteFileEntry>,
  baseMap: ReadonlyMap<string, BaseFileEntry>,
  skippedSet: ReadonlySet<string>,
  resolvedOldPaths: ReadonlySet<string>,
): Set<string> {
  const protectedPaths = new Set<string>();
  for (const [oldPath, base] of baseMap) {
    if (
      resolvedOldPaths.has(oldPath)
      || localMap.has(oldPath)
      || skippedSet.has(oldPath)
      || base.size === 0
    ) continue;
    const remote = remoteMap.get(oldPath);
    if (!remote || !remoteVersionMatchesBase(remote, base)) continue;
    const candidates = [...localMap.values()].filter((local) =>
      !baseMap.has(local.path)
      && !remoteMap.has(local.path)
      && !skippedSet.has(local.path)
      && local.hash === base.hash
      && local.size === base.size,
    );
    if (candidates.length > 0) protectedPaths.add(oldPath);
  }
  return protectedPaths;
}

function parentPath(path: string): string {
  return path.includes("/")
    ? path.substring(0, path.lastIndexOf("/"))
    : "";
}

export function orderSyncPlanItemsV2(
  items: readonly SyncPlanItem[],
): SyncPlanItem[] {
  const priority: Record<SyncActionType, number> = {
    [SyncActionType.RecreateRemoteScope]: 0,
    [SyncActionType.CreateLocalFolder]: 0,
    [SyncActionType.CreateRemoteFolder]: 0,
    [SyncActionType.MoveLocalFolder]: 0,
    [SyncActionType.MoveRemoteFolder]: 0,
    [SyncActionType.MoveLocalFile]: 0,
    [SyncActionType.Upload]: 0,
    [SyncActionType.Download]: 0,
    [SyncActionType.RenameRemote]: 0,
    [SyncActionType.SkipLargeFile]: 1,
    [SyncActionType.SkipIgnoredPath]: 1,
    [SyncActionType.RetryLater]: 2,
    [SyncActionType.FolderDeferred]: 2,
    [SyncActionType.Conflict]: 3,
    [SyncActionType.ConfirmLocalDelete]: 4,
    [SyncActionType.DeleteLocal]: 5,
    [SyncActionType.DeleteRemote]: 5,
    [SyncActionType.DeleteLocalFolder]: 5,
    [SyncActionType.DeleteRemoteFolder]: 5,
    [SyncActionType.AuthExpired]: 6,
  };

  return [...items].sort(
    (left, right) =>
      (priority[left.type] ?? 99) - (priority[right.type] ?? 99),
  );
}

function remoteVersionMatchesBase(
  remote: RemoteFileEntry,
  base: BaseFileEntry,
): boolean {
  return remote.sha256Hash
    ? remoteContentMatchesBase(remote, base)
    : remote.eTag === base.eTag;
}
