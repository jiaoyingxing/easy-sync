import { isRecord } from "../obsidian-compat";
import {
  isSyncScope,
  sameSyncScope,
  type SyncScope,
} from "./types";

export type PluginEnablementAnchorsV1 = Record<string, boolean>;

export interface CommunityPluginEnablementMerge {
  status: "ready" | "decision-required";
  local: string[];
  remote: string[];
  anchors: PluginEnablementAnchorsV1;
  decisionPluginIds: string[];
}

export interface ObservedPluginEnablementDecision {
  pluginId: string;
  localEnabled: boolean;
  remoteEnabled: boolean;
  resolvedEnabled?: boolean;
}

export interface PreparedCommunityPluginEnablement {
  status: "ready" | "decision-required";
  local: string[];
  remote: string[];
  anchors: PluginEnablementAnchorsV1;
  pending: ObservedPluginEnablementDecision[];
  localChanged: boolean;
  remoteChanged: boolean;
}

export interface CommunityPluginEnablementObservation {
  exists: boolean;
  pluginIds: string[];
}

export interface CommunityPluginEnablementObservedVersionV2 {
  exists: boolean;
  contentHash?: string;
  remoteId?: string;
  eTag?: string;
}

export interface CommunityPluginEnablementSourceV2 {
  path: string;
  selectedPluginIds: string[];
  local: CommunityPluginEnablementObservedVersionV2;
  remote: CommunityPluginEnablementObservedVersionV2;
}

/**
 * Exact, version-bound parse cache for the structured enablement file.
 *
 * This is observation evidence only: it does not own merge decisions or
 * authorize a mutation. Callers may reuse each side's parsed IDs only while
 * that side's source version still matches exactly.
 */
export interface CommunityPluginEnablementCommittedObservationV1 {
  version: 1;
  source: CommunityPluginEnablementSourceV2;
  localPluginIds: string[];
  remotePluginIds: string[];
}

/**
 * Source-bound migration control data for the structured enablement file.
 *
 * The carrier has no Graph, Vault, planner, or mutation capability. It lives
 * inside the existing migration hold so public-1.1.3 choices cannot become a
 * second active pending state before the V2 manifest commits.
 */
export interface CommunityPluginEnablementMigrationCarrierV2 {
  version: 1;
  scope: SyncScope;
  source: CommunityPluginEnablementSourceV2;
  anchors: PluginEnablementAnchorsV1;
  pending: ObservedPluginEnablementDecision[];
  resolved: Array<
    ObservedPluginEnablementDecision & { resolvedEnabled: boolean }
  >;
}

/**
 * Merge only the selected plugin IDs. Unselected IDs are preserved exactly on
 * each side. A newly selected ID with different local/remote values is never
 * guessed: the caller must obtain an explicit decision first.
 */
export function mergeSelectedPluginEnablement(
  localEnabledIds: readonly string[],
  remoteEnabledIds: readonly string[],
  selectedPluginIds: readonly string[],
  anchors: Readonly<PluginEnablementAnchorsV1>,
): CommunityPluginEnablementMerge {
  const local = new Set(localEnabledIds);
  const remote = new Set(remoteEnabledIds);
  const selected = [...new Set(selectedPluginIds)].sort(compareText);
  const nextAnchors: PluginEnablementAnchorsV1 = { ...anchors };
  const decisions: string[] = [];

  for (const pluginId of selected) {
    const localEnabled = local.has(pluginId);
    const remoteEnabled = remote.has(pluginId);
    const baseEnabled = anchors[pluginId];

    if (baseEnabled === undefined && localEnabled !== remoteEnabled) {
      decisions.push(pluginId);
      continue;
    }

    const merged = baseEnabled === undefined || localEnabled === remoteEnabled
      ? localEnabled
      : localEnabled === baseEnabled
        ? remoteEnabled
        : remoteEnabled === baseEnabled
          ? localEnabled
          : localEnabled;
    setMembership(local, pluginId, merged);
    setMembership(remote, pluginId, merged);
    nextAnchors[pluginId] = merged;
  }

  return {
    status: decisions.length > 0 ? "decision-required" : "ready",
    local: [...local].sort(compareText),
    remote: [...remote].sort(compareText),
    anchors: nextAnchors,
    decisionPluginIds: decisions,
  };
}

export function applyPluginEnablementDecisions(
  merge: Readonly<CommunityPluginEnablementMerge>,
  decisions: Readonly<Record<string, boolean>>,
): CommunityPluginEnablementMerge {
  const local = new Set(merge.local);
  const remote = new Set(merge.remote);
  const anchors = { ...merge.anchors };
  const unresolved: string[] = [];

  for (const pluginId of merge.decisionPluginIds) {
    const enabled = decisions[pluginId];
    if (typeof enabled !== "boolean") {
      unresolved.push(pluginId);
      continue;
    }
    setMembership(local, pluginId, enabled);
    setMembership(remote, pluginId, enabled);
    anchors[pluginId] = enabled;
  }

  return {
    status: unresolved.length > 0 ? "decision-required" : "ready",
    local: [...local].sort(compareText),
    remote: [...remote].sort(compareText),
    anchors,
    decisionPluginIds: unresolved,
  };
}

export function prepareCommunityPluginEnablement(
  localEnabledIds: readonly string[],
  remoteEnabledIds: readonly string[],
  selectedPluginIds: readonly string[],
  anchors: Readonly<PluginEnablementAnchorsV1>,
  priorPending: readonly ObservedPluginEnablementDecision[] = [],
): PreparedCommunityPluginEnablement {
  const merge = mergeSelectedPluginEnablement(
    localEnabledIds,
    remoteEnabledIds,
    selectedPluginIds,
    anchors,
  );
  const pendingById = new Map(
    priorPending.map((item) => [item.pluginId, item]),
  );
  const resolutions: Record<string, boolean> = {};
  for (const pluginId of merge.decisionPluginIds) {
    const prior = pendingById.get(pluginId);
    if (
      prior
      && prior.localEnabled === localEnabledIds.includes(pluginId)
      && prior.remoteEnabled === remoteEnabledIds.includes(pluginId)
      && typeof prior.resolvedEnabled === "boolean"
    ) {
      resolutions[pluginId] = prior.resolvedEnabled;
    }
  }
  const resolved = applyPluginEnablementDecisions(merge, resolutions);
  const pending = resolved.decisionPluginIds.map((pluginId) => {
    const localEnabled = localEnabledIds.includes(pluginId);
    const remoteEnabled = remoteEnabledIds.includes(pluginId);
    const prior = pendingById.get(pluginId);
    return {
      pluginId,
      localEnabled,
      remoteEnabled,
      ...(prior
        && prior.localEnabled === localEnabled
        && prior.remoteEnabled === remoteEnabled
        && typeof prior.resolvedEnabled === "boolean"
        ? { resolvedEnabled: prior.resolvedEnabled }
        : {}),
    };
  });
  return {
    status: resolved.status,
    local: resolved.local,
    remote: resolved.remote,
    anchors: resolved.anchors,
    pending,
    localChanged: !samePluginIdSet(localEnabledIds, resolved.local),
    remoteChanged: !samePluginIdSet(remoteEnabledIds, resolved.remote),
  };
}

/**
 * Prepare selected enablement while preserving the distinction between an
 * explicitly observed empty array and an absent file. When only one side
 * exists, that side is the sole explicit observation and seeds selected IDs
 * on the missing side. Absence by itself never means that a plugin was
 * deliberately disabled.
 */
export function prepareCommunityPluginEnablementFromObservations(
  localObservation: Readonly<CommunityPluginEnablementObservation>,
  remoteObservation: Readonly<CommunityPluginEnablementObservation>,
  selectedPluginIds: readonly string[],
  anchors: Readonly<PluginEnablementAnchorsV1>,
  priorPending: readonly ObservedPluginEnablementDecision[] = [],
): PreparedCommunityPluginEnablement {
  if (localObservation.exists && remoteObservation.exists) {
    return prepareCommunityPluginEnablement(
      localObservation.pluginIds,
      remoteObservation.pluginIds,
      selectedPluginIds,
      anchors,
      priorPending,
    );
  }

  if (!localObservation.exists && !remoteObservation.exists) {
    return {
      status: "ready",
      local: [...localObservation.pluginIds],
      remote: [...remoteObservation.pluginIds],
      anchors: { ...anchors },
      pending: [],
      localChanged: false,
      remoteChanged: false,
    };
  }

  const source = localObservation.exists
    ? localObservation.pluginIds
    : remoteObservation.pluginIds;
  const sourceEnabled = new Set(source);
  const selected = [...new Set(selectedPluginIds)].sort(compareText);
  const nextAnchors = { ...anchors };
  const target = selected.filter((pluginId) => sourceEnabled.has(pluginId));
  for (const pluginId of selected) {
    nextAnchors[pluginId] = sourceEnabled.has(pluginId);
  }

  if (localObservation.exists) {
    return {
      status: "ready",
      local: [...localObservation.pluginIds].sort(compareText),
      remote: target,
      anchors: nextAnchors,
      pending: [],
      localChanged: false,
      remoteChanged: target.length > 0,
    };
  }

  return {
    status: "ready",
    local: target,
    remote: [...remoteObservation.pluginIds].sort(compareText),
    anchors: nextAnchors,
    pending: [],
    localChanged: target.length > 0,
    remoteChanged: false,
  };
}

export function parseCommunityPluginEnablementJson(
  text: string,
): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Community plugin enablement JSON is unreadable");
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Community plugin enablement JSON must be an array of plugin IDs");
  }
  const normalized = value.map((item) => item.trim());
  if (normalized.some((pluginId) => !isSafePluginId(pluginId))) {
    throw new Error("Community plugin enablement JSON contains an invalid plugin ID");
  }
  return [...new Set(normalized)].sort(compareText);
}

export function serializeCommunityPluginEnablementJson(
  pluginIds: readonly string[],
): ArrayBuffer {
  return new TextEncoder().encode(
    `${JSON.stringify([...new Set(pluginIds)].sort(compareText), null, 2)}\n`,
  ).buffer;
}

export function sameCommunityPluginEnablementSourceV2(
  left: Readonly<CommunityPluginEnablementSourceV2>,
  right: Readonly<CommunityPluginEnablementSourceV2>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function readCommunityPluginEnablementCommittedObservationV1(
  value: unknown,
): CommunityPluginEnablementCommittedObservationV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const source = readCommunityPluginEnablementSourceV2(value.source);
  if (
    !source
    || !Array.isArray(value.localPluginIds)
    || !isCanonicalPluginIdList(value.localPluginIds)
    || !Array.isArray(value.remotePluginIds)
    || !isCanonicalPluginIdList(value.remotePluginIds)
  ) return null;
  return {
    version: 1,
    source,
    localPluginIds: [...value.localPluginIds],
    remotePluginIds: [...value.remotePluginIds],
  };
}

export function sameCommunityPluginEnablementCommittedObservationV1(
  left: Readonly<CommunityPluginEnablementCommittedObservationV1> | undefined,
  right: Readonly<CommunityPluginEnablementCommittedObservationV1> | undefined,
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameCommunityPluginEnablementMigrationCarrierV2(
  left: Readonly<CommunityPluginEnablementMigrationCarrierV2> | undefined,
  right: Readonly<CommunityPluginEnablementMigrationCarrierV2> | undefined,
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function resolveCommunityPluginEnablementMigrationDecisionV2(
  carrier: Readonly<CommunityPluginEnablementMigrationCarrierV2>,
  expected: Readonly<ObservedPluginEnablementDecision>,
  enabled: boolean,
): CommunityPluginEnablementMigrationCarrierV2 | null {
  const pending = carrier.pending.find((item) =>
    item.pluginId === expected.pluginId
    && item.localEnabled === expected.localEnabled
    && item.remoteEnabled === expected.remoteEnabled
  );
  if (!pending) return null;
  return {
    ...structuredClone(carrier),
    pending: carrier.pending
      .filter((item) => item.pluginId !== pending.pluginId)
      .map((item) => ({ ...item })),
    resolved: [
      ...carrier.resolved.map((item) => ({ ...item })),
      { ...pending, resolvedEnabled: enabled },
    ].sort((left, right) => compareText(left.pluginId, right.pluginId)),
  };
}

export function projectCommunityPluginEnablementCarrierStateV2(
  carrier: Readonly<CommunityPluginEnablementMigrationCarrierV2>,
): {
  anchors: PluginEnablementAnchorsV1;
  pending: ObservedPluginEnablementDecision[];
} {
  const anchors = { ...carrier.anchors };
  for (const item of carrier.resolved) {
    anchors[item.pluginId] = item.resolvedEnabled;
  }
  return {
    anchors,
    pending: carrier.pending.map((item) => ({ ...item })),
  };
}

export function validateCommunityPluginEnablementMigrationCarrierV2(
  value: unknown,
): asserts value is CommunityPluginEnablementMigrationCarrierV2 {
  const source =
    isRecord(value) && isRecord(value.source) ? value.source : null;
  const selectedPluginIds = source?.selectedPluginIds;
  const anchors =
    isRecord(value) && isRecord(value.anchors) ? value.anchors : null;
  const pending =
    isRecord(value) && Array.isArray(value.pending) ? value.pending : null;
  const resolved =
    isRecord(value) && Array.isArray(value.resolved) ? value.resolved : null;
  if (
    !isRecord(value)
    || value.version !== 1
    || !isSyncScope(value.scope)
    || !source
    || typeof source.path !== "string"
    || source.path.length === 0
    || !Array.isArray(selectedPluginIds)
    || !isCanonicalPluginIdList(selectedPluginIds)
    || !isObservedVersion(source.local, false)
    || !isObservedVersion(source.remote, true)
    // A zero-bundle plugin is intentionally absent from selectedPluginIds,
    // but its last anchor remains passive history so a later bundle
    // reappearance can resume the existing merge contract. Only pending and
    // resolved decisions below are restricted to the actionable selection.
    || !anchors
    || !Object.entries(anchors).every(([pluginId, enabled]) =>
      isSafePluginId(pluginId)
      && typeof enabled === "boolean"
    )
    || !pending
    || !pending.every((item) =>
      isRecord(item)
      && typeof item.pluginId === "string"
      && isSafePluginId(item.pluginId)
      && selectedPluginIds.includes(item.pluginId)
      && typeof item.localEnabled === "boolean"
      && typeof item.remoteEnabled === "boolean"
      && item.localEnabled !== item.remoteEnabled
      && item.resolvedEnabled === undefined
      && anchors[item.pluginId] === undefined
    )
    || new Set(pending.map((item) =>
      isRecord(item) ? item.pluginId : undefined
    )).size !== pending.length
    || !resolved
    || !resolved.every((item) =>
      isRecord(item)
      && typeof item.pluginId === "string"
      && isSafePluginId(item.pluginId)
      && selectedPluginIds.includes(item.pluginId)
      && typeof item.localEnabled === "boolean"
      && typeof item.remoteEnabled === "boolean"
      && item.localEnabled !== item.remoteEnabled
      && typeof item.resolvedEnabled === "boolean"
      && anchors[item.pluginId] === undefined
      && !pending.some((pendingItem) =>
        isRecord(pendingItem) && pendingItem.pluginId === item.pluginId
      )
    )
    || new Set(resolved.map((item) =>
      isRecord(item) ? item.pluginId : undefined
    )).size !== resolved.length
  ) {
    throw new Error(
      "Community plugin enablement migration carrier is invalid",
    );
  }
}

export function sameCommunityPluginEnablementCarrierScopeV2(
  carrier: Readonly<CommunityPluginEnablementMigrationCarrierV2>,
  scope: Readonly<SyncScope>,
): boolean {
  return sameSyncScope(carrier.scope, scope);
}

function setMembership(target: Set<string>, pluginId: string, enabled: boolean): void {
  if (enabled) target.add(pluginId);
  else target.delete(pluginId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function samePluginIdSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = [...new Set(left)].sort(compareText);
  const normalizedRight = [...new Set(right)].sort(compareText);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function isSafePluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value);
}

function isCanonicalPluginIdList(value: readonly unknown[]): value is string[] {
  if (!value.every((item): item is string =>
    typeof item === "string" && isSafePluginId(item)
  )) return false;
  return new Set(value).size === value.length
    && value.every((item, index) =>
      index === 0 || compareText(value[index - 1]!, item) < 0
    );
}

function isObservedVersion(value: unknown, remote: boolean): boolean {
  if (!isRecord(value) || typeof value.exists !== "boolean") return false;
  if (!value.exists) {
    return value.contentHash === undefined
      && value.remoteId === undefined
      && value.eTag === undefined;
  }
  if (
    typeof value.contentHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.contentHash)
  ) return false;
  return remote
    ? (
    typeof value.remoteId === "string"
    && value.remoteId.length > 0
    && typeof value.eTag === "string"
    && value.eTag.length > 0
    )
    : value.remoteId === undefined && value.eTag === undefined;
}

function readCommunityPluginEnablementSourceV2(
  value: unknown,
): CommunityPluginEnablementSourceV2 | null {
  if (
    !isRecord(value)
    || typeof value.path !== "string"
    || value.path.length === 0
    || !Array.isArray(value.selectedPluginIds)
    || !isCanonicalPluginIdList(value.selectedPluginIds)
    || !isObservedVersion(value.local, false)
    || !isObservedVersion(value.remote, true)
  ) return null;
  return {
    path: value.path,
    selectedPluginIds: [...value.selectedPluginIds],
    local: {
      ...(value.local as CommunityPluginEnablementObservedVersionV2),
    },
    remote: {
      ...(value.remote as CommunityPluginEnablementObservedVersionV2),
    },
  };
}
