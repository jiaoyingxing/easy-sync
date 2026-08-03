import {
  cloneCommunityPluginSyncPolicy,
  getRestoringPluginIds,
  isCommunityPluginDataSelected,
  isPluginSelected,
  normalizePluginIds,
  type CommunityPluginSyncPolicyV1,
  type PluginScopeSelection,
} from "./community-plugin-sync-policy";
import { parseCommunityPluginBundlePath } from "./community-plugin-bundle";
import {
  SyncActionType,
  type BaseFileEntry,
  type LocalFolderMoveHintV1,
  type LocalFileEntry,
  type RemoteFileEntry,
  type RemoteFolderEntry,
  type SyncScope,
  type SyncPlanItem,
  sameSyncScope,
} from "./types";
import type { FolderAnchorV2 } from "./state-envelope-v2";

export interface CommunityPluginLocalIgnores {
  files: string[];
  data: string[];
  /** Source-bound folder move hints consumed by this local-only decision. */
  folderMoveHintRemoteIds?: string[];
}

type CommunityPluginManagedPath =
  | { kind: "files"; pluginId: string }
  | { kind: "data"; pluginId: string }
  | { kind: "enablement" };

export function classifyCommunityPluginManagedPath(
  path: string,
  configDir: string,
  ownPluginId = "easy-sync",
): CommunityPluginManagedPath | null {
  const normalizedConfigDir = configDir.replace(/\/+$/, "");
  if (path === `${normalizedConfigDir}/community-plugins.json`) {
    return { kind: "enablement" };
  }
  const bundle = parseCommunityPluginBundlePath(path, normalizedConfigDir);
  if (bundle && bundle.pluginId !== ownPluginId) {
    return { kind: "files", pluginId: bundle.pluginId };
  }
  const prefix = `${normalizedConfigDir}/plugins/`;
  if (!path.startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split("/");
  if (
    parts.length === 2
    && parts[1] === "data.json"
    && parts[0] !== ownPluginId
    && /^[a-z0-9][a-z0-9_-]*$/i.test(parts[0])
  ) {
    return { kind: "data", pluginId: parts[0] };
  }
  return null;
}

export function isCommunityPluginPathSelectedByPolicy(
  path: string,
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  configDir: string,
  ownPluginId = "easy-sync",
): boolean {
  const classified = classifyCommunityPluginManagedPath(
    path,
    configDir,
    ownPluginId,
  );
  if (!classified) return true;
  if (classified.kind === "enablement") return policy.files.mode !== "none";
  return classified.kind === "data"
    ? isCommunityPluginDataSelected(policy, classified.pluginId)
    : isPluginSelected(policy.files, classified.pluginId);
}

/**
 * A plugin bundle excluded on this device owns a remote-only folder subtree.
 * It stays outside ordinary folder create/move/delete planning without turning
 * the device-local scope choice into a cloud deletion.
 */
export function isCommunityPluginFolderPreservedByPolicy(
  path: string,
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  configDir: string,
  ownPluginId = "easy-sync",
  restoringFilePluginIds: readonly string[] = [],
): boolean {
  const normalizedConfigDir = configDir.replace(/\/+$/, "");
  const prefix = `${normalizedConfigDir}/plugins/`;
  if (!path.startsWith(prefix)) return false;
  const pluginId = path.slice(prefix.length).split("/")[0];
  return pluginId !== ownPluginId
    && /^[a-z0-9][a-z0-9_-]*$/i.test(pluginId)
    && (
      !isPluginSelected(policy.files, pluginId)
      || restoringFilePluginIds.includes(pluginId)
    );
}

export function detectCommunityPluginLocalIgnores(input: {
  policy: Readonly<CommunityPluginSyncPolicyV1>;
  configDir: string;
  localEntries: readonly LocalFileEntry[];
  remoteEntries: readonly RemoteFileEntry[];
  baseEntries: readonly BaseFileEntry[];
  ownPluginId?: string;
  folderMoveEvidence?: Readonly<{
    scope: SyncScope;
    localFolderScanComplete: boolean;
    remoteFolderIndexComplete: boolean;
    hints: readonly LocalFolderMoveHintV1[];
    anchors: readonly FolderAnchorV2[];
    remoteFolders: readonly RemoteFolderEntry[];
    isFolderPathInScope: (path: string) => boolean;
  }>;
}): CommunityPluginLocalIgnores {
  const ownPluginId = input.ownPluginId ?? "easy-sync";
  const local = collectManagedPaths(
    input.localEntries,
    input.configDir,
    ownPluginId,
  );
  const remote = collectManagedPaths(
    input.remoteEntries,
    input.configDir,
    ownPluginId,
  );
  const base = collectManagedPaths(
    input.baseEntries,
    input.configDir,
    ownPluginId,
  );
  const sourceBoundFolderExits = collectSourceBoundPluginFolderExits(
    input.folderMoveEvidence,
    input.configDir,
    ownPluginId,
  );
  const files: string[] = [];
  const data: string[] = [];
  const restoringFiles = new Set(
    getRestoringPluginIds(input.policy.files),
  );
  const restoringData = new Set(
    getRestoringPluginIds(input.policy.data),
  );
  const candidateIds = new Set([
    ...remote.files.keys(),
    ...base.files.keys(),
    ...base.data.keys(),
    ...sourceBoundFolderExits.keys(),
  ]);

  for (const pluginId of candidateIds) {
    if (
      isPluginSelected(input.policy.files, pluginId)
      && !restoringFiles.has(pluginId)
      && (remote.files.get(pluginId)?.size ?? 0) > 0
      && (local.files.get(pluginId)?.size ?? 0) === 0
    ) {
      files.push(pluginId);
    }
    if (
      isCommunityPluginDataSelected(input.policy, pluginId)
      && !restoringData.has(pluginId)
      && base.data.has(pluginId)
      && remote.data.has(pluginId)
      && !local.data.has(pluginId)
    ) {
      data.push(pluginId);
    }
  }

  const folderMoveHintRemoteIds = normalizePluginIds(
    files.filter((pluginId) => sourceBoundFolderExits.has(pluginId)),
    ownPluginId,
  ).map((pluginId) => sourceBoundFolderExits.get(pluginId)!);
  return {
    files: normalizePluginIds(files, ownPluginId),
    data: normalizePluginIds(data, ownPluginId),
    ...(folderMoveHintRemoteIds.length > 0
      ? { folderMoveHintRemoteIds }
      : {}),
  };
}

/**
 * Plugin data still uses the legacy per-device selection until it receives
 * its own participation state. Plugin-file participation is intentionally not
 * inferred here; that belongs to the V2 community-plugin coordinator.
 */
export function detectCommunityPluginDataLocalIgnores(input: Readonly<{
  policy: Readonly<CommunityPluginSyncPolicyV1>;
  configDir: string;
  localEntries: readonly LocalFileEntry[];
  remoteEntries: readonly RemoteFileEntry[];
  baseEntries: readonly BaseFileEntry[];
  ownPluginId?: string;
}>): string[] {
  const ownPluginId = input.ownPluginId ?? "easy-sync";
  const local = collectManagedPaths(
    input.localEntries,
    input.configDir,
    ownPluginId,
  );
  const remote = collectManagedPaths(
    input.remoteEntries,
    input.configDir,
    ownPluginId,
  );
  const base = collectManagedPaths(
    input.baseEntries,
    input.configDir,
    ownPluginId,
  );
  const restoring = new Set(getRestoringPluginIds(input.policy.data));
  return normalizePluginIds(
    [...base.data.keys()].filter((pluginId) =>
      isCommunityPluginDataSelected(input.policy, pluginId)
      && !restoring.has(pluginId)
      && remote.data.has(pluginId)
      && !local.data.has(pluginId)
    ),
    ownPluginId,
  );
}

export function applyCommunityPluginLocalIgnores(
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  ignores: Readonly<CommunityPluginLocalIgnores>,
  ownPluginId = "easy-sync",
): CommunityPluginSyncPolicyV1 {
  const next = cloneCommunityPluginSyncPolicy(policy);
  next.files = withLocalIgnores(next.files, ignores.files, ownPluginId);
  next.data = withLocalIgnores(next.data, ignores.data, ownPluginId);
  return next;
}

/**
 * Community-plugin files cannot enter the generic delete pipeline. A missing
 * remote participant is restored from local; a partially missing local bundle
 * is repaired from remote. A wholly absent local bundle/data file is excluded
 * earlier by detectCommunityPluginLocalIgnores().
 */
export function protectCommunityPluginPlan(
  items: readonly SyncPlanItem[],
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  configDir: string,
  localEntries: readonly LocalFileEntry[] = [],
  ownPluginId = "easy-sync",
  restoreIdentityEvidence?: Readonly<{
    remoteEntries: readonly RemoteFileEntry[];
    anchoredRemoteIdByPath: ReadonlyMap<string, string>;
    restoringFilePluginIds?: readonly string[];
  }>,
): SyncPlanItem[] {
  const localCodeByPlugin = collectManagedPaths(
    localEntries,
    configDir,
    ownPluginId,
  );
  const restoringFiles = new Set(normalizePluginIds(
    restoreIdentityEvidence?.restoringFilePluginIds ?? [],
    ownPluginId,
  ));
  const restoringData = new Set(
    getRestoringPluginIds(policy.data),
  );
  const currentRemoteByPath = new Map(
    (restoreIdentityEvidence?.remoteEntries ?? []).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  return items.flatMap((item): SyncPlanItem[] => {
    const classified = classifyCommunityPluginManagedPath(
      item.path,
      configDir,
      ownPluginId,
    );
    if (!classified || classified.kind === "enablement") return [item];
    const selected = classified.kind === "data"
      ? isCommunityPluginDataSelected(policy, classified.pluginId)
      : isPluginSelected(policy.files, classified.pluginId);
    if (!selected) {
      return [];
    }
    const restoreWhollyAbsentLocal = classified.kind === "files"
      ? restoringFiles.has(classified.pluginId)
        && (localCodeByPlugin.files.get(classified.pluginId)?.size ?? 0) === 0
      : classified.kind === "data"
        ? restoringData.has(classified.pluginId)
          && !localCodeByPlugin.data.has(classified.pluginId)
        : false;
    if (
      item.type === SyncActionType.FolderDeferred
      && item.reason === "reason.identityMove.deferred"
      && restoreWhollyAbsentLocal
    ) {
      const remote = currentRemoteByPath.get(item.path);
      const anchoredRemoteId =
        restoreIdentityEvidence?.anchoredRemoteIdByPath.get(item.path);
      if (remote && anchoredRemoteId === remote.driveId) {
        return [{
          type: SyncActionType.Download,
          path: item.path,
          remote,
        }];
      }
    }
    if (
      item.type === SyncActionType.Conflict
      && item.local
      && !item.remote
    ) {
      return [{
        ...item,
        type: SyncActionType.Upload,
        remote: undefined,
        reason: undefined,
      }];
    }
    if (
      item.type === SyncActionType.Conflict
      && item.remote
      && !item.local
      && (
        restoreWhollyAbsentLocal
        || (
          classified.kind === "files"
          && (localCodeByPlugin.files.get(classified.pluginId)?.size ?? 0) > 0
        )
      )
    ) {
      return [{
        ...item,
        type: SyncActionType.Download,
        local: undefined,
        reason: undefined,
      }];
    }
    if (item.type === SyncActionType.ConfirmLocalDelete && item.local) {
      return [{
        ...item,
        type: SyncActionType.Upload,
        remote: undefined,
        reason: undefined,
      }];
    }
    if (item.type !== SyncActionType.DeleteRemote || !item.remote) {
      return [item];
    }
    if (restoreWhollyAbsentLocal) {
      return [{
        ...item,
        type: SyncActionType.Download,
        local: undefined,
        reason: undefined,
      }];
    }
    if (
      classified.kind === "files"
      && (localCodeByPlugin.files.get(classified.pluginId)?.size ?? 0) > 0
    ) {
      return [{
        ...item,
        type: SyncActionType.Download,
        local: undefined,
        reason: undefined,
      }];
    }
    return [];
  });
}

/**
 * Enablement is actionable only while the plugin has at least one current
 * bundle member on either side. A zero-member ID is dangling host metadata and
 * remains untouched in each side's raw list. Any partial bundle still
 * participates so the existing completeness preflight can fail closed.
 */
export function collectCommunityPluginIdsForEnablement(
  policy: Readonly<PluginScopeSelection>,
  candidates: readonly string[],
  bundleParticipantIds: readonly string[],
  ownPluginId = "easy-sync",
): string[] {
  const normalized = policy.mode === "selected"
    ? normalizePluginIds(policy.pluginIds, ownPluginId)
    : policy.mode === "all"
      ? normalizePluginIds(candidates, ownPluginId)
      : [];
  const bundleParticipants = new Set(
    normalizePluginIds(bundleParticipantIds, ownPluginId),
  );
  return normalized.filter((pluginId) =>
    bundleParticipants.has(pluginId)
    && isPluginSelected(policy, pluginId)
  );
}

function withLocalIgnores(
  selection: Readonly<PluginScopeSelection>,
  additions: readonly string[],
  ownPluginId: string,
): PluginScopeSelection {
  const ignoredPluginIds = normalizePluginIds([
    ...(selection.ignoredPluginIds ?? []),
    ...additions,
  ], ownPluginId);
  const ignoredPluginIdSet = new Set(ignoredPluginIds);
  const restoringPluginIds = normalizePluginIds(
    (selection.restoringPluginIds ?? []).filter(
      (pluginId) => !ignoredPluginIdSet.has(pluginId),
    ),
    ownPluginId,
  );
  return {
    mode: selection.mode,
    pluginIds: [...selection.pluginIds],
    ...(ignoredPluginIds.length > 0 ? { ignoredPluginIds } : {}),
    ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
  };
}

function collectManagedPaths(
  entries: readonly { path: string }[],
  configDir: string,
  ownPluginId: string,
): {
  files: Map<string, Set<string>>;
  data: Set<string>;
} {
  const files = new Map<string, Set<string>>();
  const data = new Set<string>();
  for (const entry of entries) {
    const classified = classifyCommunityPluginManagedPath(
      entry.path,
      configDir,
      ownPluginId,
    );
    if (!classified || classified.kind === "enablement") continue;
    if (classified.kind === "data") {
      data.add(classified.pluginId);
      continue;
    }
    const paths = files.get(classified.pluginId) ?? new Set<string>();
    paths.add(entry.path);
    files.set(classified.pluginId, paths);
  }
  return { files, data };
}

function collectSourceBoundPluginFolderExits(
  evidence: Readonly<{
    scope: SyncScope;
    localFolderScanComplete: boolean;
    remoteFolderIndexComplete: boolean;
    hints: readonly LocalFolderMoveHintV1[];
    anchors: readonly FolderAnchorV2[];
    remoteFolders: readonly RemoteFolderEntry[];
    isFolderPathInScope: (path: string) => boolean;
  }> | undefined,
  configDir: string,
  ownPluginId: string,
): Map<string, string> {
  const result = new Map<string, string>();
  if (
    !evidence
    || !evidence.localFolderScanComplete
    || !evidence.remoteFolderIndexComplete
  ) return result;

  const normalizedConfigDir = configDir.replace(/\/+$/, "");
  const prefix = `${normalizedConfigDir}/plugins/`;
  const anchorsByRemoteId = new Map(
    evidence.anchors.map((anchor) => [anchor.remoteId, anchor]),
  );
  const remoteFoldersById = new Map(
    evidence.remoteFolders.map((folder) => [folder.driveId, folder]),
  );
  for (const hint of evidence.hints) {
    if (!sameSyncScope(hint.scope, evidence.scope)) continue;
    const fromPath = hint.fromPath.normalize("NFC");
    const toPath = hint.toPath.normalize("NFC");
    if (
      !fromPath.startsWith(prefix)
      || fromPath.slice(prefix.length).includes("/")
      || !evidence.isFolderPathInScope(fromPath)
      || evidence.isFolderPathInScope(toPath)
    ) continue;
    const pluginId = fromPath.slice(prefix.length);
    if (
      pluginId === ownPluginId
      || !/^[a-z0-9][a-z0-9_-]*$/i.test(pluginId)
    ) continue;
    const anchor = anchorsByRemoteId.get(hint.remoteId);
    const remoteFolder = remoteFoldersById.get(hint.remoteId);
    if (
      !anchor
      || !remoteFolder
      || anchor.lastPath.normalize("NFC") !== fromPath
      || remoteFolder.path.normalize("NFC") !== fromPath
      || anchor.parentRemoteId !== remoteFolder.parentId
    ) continue;
    result.set(pluginId, hint.remoteId);
  }
  return result;
}
