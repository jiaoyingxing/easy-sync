export type PluginSelectionMode = "none" | "all" | "selected";

export interface PluginScopeSelection {
  mode: PluginSelectionMode;
  pluginIds: string[];
  /** Device-local opt-outs. They are never synchronized to other devices. */
  ignoredPluginIds?: string[];
  /**
   * One-shot, device-local authorization to restore a bundle after an
   * explicit participation request. It is retired only after the current
   * remote bundle is present locally again.
   */
  restoringPluginIds?: string[];
}

export interface CommunityPluginSyncPolicyV1 {
  version: 1;
  files: PluginScopeSelection;
  data: PluginScopeSelection;
}

export interface CommunityPluginRestoreSet {
  files: readonly string[];
  data: readonly string[];
}

export const DEFAULT_COMMUNITY_PLUGIN_SYNC_POLICY: CommunityPluginSyncPolicyV1 = {
  version: 1,
  files: { mode: "all", pluginIds: [] },
  data: { mode: "all", pluginIds: [] },
};

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function normalizePluginIds(
  values: readonly unknown[],
  ownPluginId = "easy-sync",
): string[] {
  const ownId = ownPluginId.trim().toLowerCase();
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) =>
      PLUGIN_ID_PATTERN.test(value)
      && value.toLowerCase() !== ownId
    ))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizePluginScopeSelection(
  value: unknown,
  legacyEnabled = false,
  ownPluginId = "easy-sync",
): PluginScopeSelection {
  if (!value || typeof value !== "object") {
    return {
      mode: legacyEnabled ? "all" : "none",
      pluginIds: [],
    };
  }
  const candidate = value as Partial<PluginScopeSelection>;
  const mode: PluginSelectionMode = candidate.mode === "all" || candidate.mode === "selected"
    ? candidate.mode
    : "none";
  const pluginIds = mode === "selected"
    ? normalizePluginIds(
        Array.isArray(candidate.pluginIds) ? candidate.pluginIds : [],
        ownPluginId,
      )
    : [];
  const ignoredPluginIds = normalizePluginIds(
    Array.isArray(candidate.ignoredPluginIds)
      ? candidate.ignoredPluginIds
      : [],
    ownPluginId,
  );
  const ignoredPluginIdSet = new Set(ignoredPluginIds);
  const restoringPluginIds = normalizePluginIds(
    Array.isArray(candidate.restoringPluginIds)
      ? candidate.restoringPluginIds
      : [],
    ownPluginId,
  ).filter((pluginId) =>
    !ignoredPluginIdSet.has(pluginId)
    && mode !== "none"
    && (mode === "all" || pluginIds.includes(pluginId))
  );
  return {
    mode,
    pluginIds,
    ...(ignoredPluginIds.length > 0 ? { ignoredPluginIds } : {}),
    ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
  };
}

export function readCommunityPluginSyncPolicy(
  value: unknown,
  _legacyFilesEnabled = false,
  _legacyDataEnabled = false,
  ownPluginId = "easy-sync",
): CommunityPluginSyncPolicyV1 {
  const candidate = value && typeof value === "object"
    ? value as Partial<CommunityPluginSyncPolicyV1>
    : null;
  if (candidate?.version !== 1) {
    return cloneCommunityPluginSyncPolicy(
      DEFAULT_COMMUNITY_PLUGIN_SYNC_POLICY,
    );
  }
  return {
    version: 1,
    files: normalizePluginScopeSelection(
      candidate.files,
      true,
      ownPluginId,
    ),
    data: normalizePluginScopeSelection(
      candidate.data,
      true,
      ownPluginId,
    ),
  };
}

export function cloneCommunityPluginSyncPolicy(
  policy: Readonly<CommunityPluginSyncPolicyV1>,
): CommunityPluginSyncPolicyV1 {
  return {
    version: 1,
    files: {
      mode: policy.files.mode,
      pluginIds: [...policy.files.pluginIds],
      ...(policy.files.ignoredPluginIds?.length
        ? { ignoredPluginIds: [...policy.files.ignoredPluginIds] }
        : {}),
      ...(policy.files.restoringPluginIds?.length
        ? { restoringPluginIds: [...policy.files.restoringPluginIds] }
        : {}),
    },
    data: {
      mode: policy.data.mode,
      pluginIds: [...policy.data.pluginIds],
      ...(policy.data.ignoredPluginIds?.length
        ? { ignoredPluginIds: [...policy.data.ignoredPluginIds] }
        : {}),
      ...(policy.data.restoringPluginIds?.length
        ? { restoringPluginIds: [...policy.data.restoringPluginIds] }
        : {}),
    },
  };
}

export function isPluginSelected(
  selection: Readonly<PluginScopeSelection>,
  pluginId: string,
): boolean {
  return !getIgnoredPluginIds(selection).includes(pluginId)
    && (selection.mode === "all"
    || (
      selection.mode === "selected"
      && selection.pluginIds.includes(pluginId)
    ));
}

export function isCommunityPluginDataSelected(
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  pluginId: string,
): boolean {
  return isPluginDataSelected(policy.files, policy.data, pluginId);
}

export function isPluginDataSelected(
  files: Readonly<PluginScopeSelection>,
  data: Readonly<PluginScopeSelection>,
  pluginId: string,
): boolean {
  return isPluginSelected(files, pluginId)
    && isPluginSelected(data, pluginId);
}

export function createEffectiveCommunityPluginSyncPolicy(
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  filesEnabled: boolean,
  dataEnabled: boolean,
): CommunityPluginSyncPolicyV1 {
  const effective = cloneCommunityPluginSyncPolicy(policy);
  if (!filesEnabled) {
    effective.files = { mode: "none", pluginIds: [] };
  }
  if (!filesEnabled || !dataEnabled) {
    effective.data = { mode: "none", pluginIds: [] };
  }
  return effective;
}

export function normalizeCommunityPluginSyncSettings(
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  filesEnabled: boolean,
  dataEnabled: boolean,
  ownPluginId = "easy-sync",
): {
  filesEnabled: boolean;
  dataEnabled: boolean;
  policy: CommunityPluginSyncPolicyV1;
} {
  const normalized = cloneCommunityPluginSyncPolicy(policy);
  if (filesEnabled && normalized.files.mode === "none") {
    normalized.files = normalizePluginScopeSelection(
      { ...normalized.files, mode: "all" },
      true,
      ownPluginId,
    );
  }
  if (filesEnabled && dataEnabled && normalized.data.mode === "none") {
    normalized.data = normalizePluginScopeSelection(
      { ...normalized.data, mode: "all" },
      true,
      ownPluginId,
    );
  }
  return {
    filesEnabled,
    dataEnabled: filesEnabled && dataEnabled,
    policy: normalized,
  };
}

export function getIgnoredPluginIds(
  selection: Readonly<PluginScopeSelection>,
): readonly string[] {
  return selection.ignoredPluginIds ?? [];
}

export function getRestoringPluginIds(
  selection: Readonly<PluginScopeSelection>,
): readonly string[] {
  return selection.restoringPluginIds ?? [];
}

export function clearCompletedCommunityPluginRestores(
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  completed: Readonly<CommunityPluginRestoreSet>,
  ownPluginId = "easy-sync",
): CommunityPluginSyncPolicyV1 {
  const next = cloneCommunityPluginSyncPolicy(policy);
  next.files = withoutCompletedRestores(
    next.files,
    completed.files,
    ownPluginId,
  );
  next.data = withoutCompletedRestores(
    next.data,
    completed.data,
    ownPluginId,
  );
  return next;
}

export function sameCommunityPluginSyncPolicy(
  left: Readonly<CommunityPluginSyncPolicyV1>,
  right: Readonly<CommunityPluginSyncPolicyV1>,
): boolean {
  return sameSelection(left.files, right.files)
    && sameSelection(left.data, right.data);
}

function sameSelection(
  left: Readonly<PluginScopeSelection>,
  right: Readonly<PluginScopeSelection>,
): boolean {
  const leftIgnored = getIgnoredPluginIds(left);
  const rightIgnored = getIgnoredPluginIds(right);
  const leftRestoring = getRestoringPluginIds(left);
  const rightRestoring = getRestoringPluginIds(right);
  return left.mode === right.mode
    && left.pluginIds.length === right.pluginIds.length
    && left.pluginIds.every((pluginId, index) => pluginId === right.pluginIds[index])
    && leftIgnored.length === rightIgnored.length
    && leftIgnored.every((pluginId, index) => pluginId === rightIgnored[index])
    && leftRestoring.length === rightRestoring.length
    && leftRestoring.every(
      (pluginId, index) => pluginId === rightRestoring[index],
    );
}

function withoutCompletedRestores(
  selection: Readonly<PluginScopeSelection>,
  completed: readonly string[],
  ownPluginId: string,
): PluginScopeSelection {
  const completedIds = new Set(normalizePluginIds(completed, ownPluginId));
  const restoringPluginIds = normalizePluginIds(
    (selection.restoringPluginIds ?? []).filter(
      (pluginId) => !completedIds.has(pluginId),
    ),
    ownPluginId,
  );
  return {
    mode: selection.mode,
    pluginIds: [...selection.pluginIds],
    ...(selection.ignoredPluginIds?.length
      ? { ignoredPluginIds: [...selection.ignoredPluginIds] }
      : {}),
    ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
  };
}
