import {
  cloneCommunityPluginSyncPolicy,
  isPluginSelected,
  normalizePluginIds,
  type CommunityPluginSyncPolicyV1,
  type PluginScopeSelection,
} from "./community-plugin-sync-policy";

export type CommunityPluginSelectionColumn = "files" | "data";

export interface CommunityPluginSelectionSettings {
  filesEnabled: boolean;
  dataEnabled: boolean;
  policy: CommunityPluginSyncPolicyV1;
}

export function updateAllCommunityPluginSelections(
  current: Readonly<CommunityPluginSelectionSettings>,
  column: CommunityPluginSelectionColumn,
  enabled: boolean,
  knownPluginIds: readonly string[] = [],
  ownPluginId = "easy-sync",
): CommunityPluginSelectionSettings {
  const next = cloneSelectionSettings(current);
  if (column === "files") {
    next.filesEnabled = enabled;
    next.dataEnabled = enabled && current.dataEnabled;
    const restoringPluginIds = normalizePluginIds([
      ...current.policy.files.pluginIds,
      ...(current.policy.files.restoringPluginIds ?? []),
      ...(current.policy.files.ignoredPluginIds ?? []),
      ...knownPluginIds,
    ], ownPluginId);
    next.policy.files = {
      mode: "all",
      pluginIds: [],
      ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
    };
    if (!enabled) next.dataEnabled = false;
    return next;
  }

  next.dataEnabled = enabled && current.filesEnabled;
  const restoringPluginIds = normalizePluginIds([
    ...current.policy.data.pluginIds,
    ...(current.policy.data.restoringPluginIds ?? []),
    ...(current.policy.data.ignoredPluginIds ?? []),
    ...knownPluginIds,
  ], ownPluginId);
  next.policy.data = {
    mode: "all",
    pluginIds: [],
    ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
  };
  return next;
}

export function updateCommunityPluginSelection(
  current: Readonly<CommunityPluginSelectionSettings>,
  column: CommunityPluginSelectionColumn,
  pluginId: string,
  enabled: boolean,
  knownPluginIds: readonly string[],
  ownPluginId = "easy-sync",
): CommunityPluginSelectionSettings {
  const knownIds = normalizePluginIds(knownPluginIds, ownPluginId);
  const normalizedPluginId = normalizePluginIds([pluginId], ownPluginId)[0];
  const next = cloneSelectionSettings(current);
  if (!normalizedPluginId || !knownIds.includes(normalizedPluginId)) {
    return next;
  }

  if (column === "files") {
    if (enabled) {
      next.policy.files = enableOne(
        current.policy.files,
        normalizedPluginId,
        current.filesEnabled,
        ownPluginId,
      );
      next.filesEnabled = true;
      return next;
    }
    if (!current.filesEnabled) return next;
    const files = disableOne(
      current.policy.files,
      normalizedPluginId,
      ownPluginId,
    );
    if (countSelected(files, knownIds) === 0) {
      next.filesEnabled = false;
      next.dataEnabled = false;
      next.policy.files = { mode: "all", pluginIds: [] };
      return next;
    }
    next.policy.files = files;
    return next;
  }

  if (
    !current.filesEnabled
    || !isPluginSelected(current.policy.files, normalizedPluginId)
  ) {
    return next;
  }
  if (enabled) {
    next.policy.data = enableOne(
      current.policy.data,
      normalizedPluginId,
      current.dataEnabled,
      ownPluginId,
    );
    next.dataEnabled = true;
    return next;
  }
  if (!current.dataEnabled) return next;
  const data = disableOne(
    current.policy.data,
    normalizedPluginId,
    ownPluginId,
  );
  const eligibleIds = knownIds.filter((id) =>
    isPluginSelected(current.policy.files, id)
  );
  if (countSelected(data, eligibleIds) === 0) {
    next.dataEnabled = false;
    next.policy.data = createAllSelectionPreservingDormantPreferences(
      current.policy.data,
      knownIds,
      eligibleIds,
      ownPluginId,
    );
    return next;
  }
  next.policy.data = data;
  return next;
}

export function enableCommunityPluginDataWithFiles(
  current: Readonly<CommunityPluginSelectionSettings>,
  pluginId: string,
  knownPluginIds: readonly string[],
  ownPluginId = "easy-sync",
): CommunityPluginSelectionSettings {
  const normalizedPluginId = normalizePluginIds([pluginId], ownPluginId)[0];
  const knownIds = normalizePluginIds(knownPluginIds, ownPluginId);
  const next = cloneSelectionSettings(current);
  if (!normalizedPluginId || !knownIds.includes(normalizedPluginId)) {
    return next;
  }
  next.policy.files = enableOne(
    current.policy.files,
    normalizedPluginId,
    current.filesEnabled,
    ownPluginId,
  );
  next.policy.data = enableOne(
    current.policy.data,
    normalizedPluginId,
    current.dataEnabled,
    ownPluginId,
    true,
  );
  next.filesEnabled = true;
  next.dataEnabled = true;
  return next;
}

function enableOne(
  current: Readonly<PluginScopeSelection>,
  pluginId: string,
  outerEnabled: boolean,
  ownPluginId: string,
  forceRestore = false,
): PluginScopeSelection {
  const shouldRestore = forceRestore
    || !outerEnabled
    || !isPluginSelected(current, pluginId);
  if (!outerEnabled || current.mode === "none") {
    return {
      mode: "selected",
      pluginIds: normalizePluginIds([pluginId], ownPluginId),
      ...(shouldRestore ? { restoringPluginIds: [pluginId] } : {}),
    };
  }
  if (current.mode === "all") {
    const ignoredPluginIds = normalizePluginIds(
      (current.ignoredPluginIds ?? []).filter((id) => id !== pluginId),
      ownPluginId,
    );
    const restoringPluginIds = normalizePluginIds([
      ...(current.restoringPluginIds ?? []),
      ...(shouldRestore ? [pluginId] : []),
    ], ownPluginId);
    return {
      mode: "all",
      pluginIds: [],
      ...(ignoredPluginIds.length > 0 ? { ignoredPluginIds } : {}),
      ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
    };
  }
  const pluginIds = normalizePluginIds(
    [...current.pluginIds, pluginId],
    ownPluginId,
  );
  const restoringPluginIds = normalizePluginIds([
    ...(current.restoringPluginIds ?? []),
    ...(shouldRestore ? [pluginId] : []),
  ], ownPluginId).filter((id) => pluginIds.includes(id));
  return {
    mode: "selected",
    pluginIds,
    ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
  };
}

function disableOne(
  current: Readonly<PluginScopeSelection>,
  pluginId: string,
  ownPluginId: string,
): PluginScopeSelection {
  if (current.mode === "all") {
    const restoringPluginIds = normalizePluginIds(
      (current.restoringPluginIds ?? []).filter((id) => id !== pluginId),
      ownPluginId,
    );
    return {
      mode: "all",
      pluginIds: [],
      ignoredPluginIds: normalizePluginIds(
        [...(current.ignoredPluginIds ?? []), pluginId],
        ownPluginId,
      ),
      ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
    };
  }
  if (current.mode === "selected") {
    const pluginIds = normalizePluginIds(
      current.pluginIds.filter((id) => id !== pluginId),
      ownPluginId,
    );
    const restoringPluginIds = normalizePluginIds(
      (current.restoringPluginIds ?? []).filter((id) =>
        id !== pluginId && pluginIds.includes(id)
      ),
      ownPluginId,
    );
    return {
      mode: "selected",
      pluginIds,
      ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
    };
  }
  return { mode: "none", pluginIds: [] };
}

function createAllSelectionPreservingDormantPreferences(
  current: Readonly<PluginScopeSelection>,
  knownIds: readonly string[],
  eligibleIds: readonly string[],
  ownPluginId: string,
): PluginScopeSelection {
  const eligibleIdSet = new Set(eligibleIds);
  const ignoredPluginIds = normalizePluginIds(
    knownIds.filter((id) =>
      !eligibleIdSet.has(id) && !isPluginSelected(current, id)
    ),
    ownPluginId,
  );
  const restoringPluginIds = normalizePluginIds(
    (current.restoringPluginIds ?? []).filter((pluginId) =>
      !ignoredPluginIds.includes(pluginId)
    ),
    ownPluginId,
  );
  return {
    mode: "all",
    pluginIds: [],
    ...(ignoredPluginIds.length > 0 ? { ignoredPluginIds } : {}),
    ...(restoringPluginIds.length > 0 ? { restoringPluginIds } : {}),
  };
}

function countSelected(
  selection: Readonly<PluginScopeSelection>,
  pluginIds: readonly string[],
): number {
  return pluginIds.filter((id) => isPluginSelected(selection, id)).length;
}

function cloneSelectionSettings(
  current: Readonly<CommunityPluginSelectionSettings>,
): CommunityPluginSelectionSettings {
  return {
    filesEnabled: current.filesEnabled,
    dataEnabled: current.filesEnabled && current.dataEnabled,
    policy: cloneCommunityPluginSyncPolicy(current.policy),
  };
}
