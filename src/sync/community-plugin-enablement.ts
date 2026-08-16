import { isRecord } from "../obsidian-compat";
import {
  isSyncScope,
  type SyncScope,
} from "./types";

export type PluginEnablementAnchorsV1 = Record<string, boolean>;

export interface ObservedPluginEnablementDecision {
  pluginId: string;
  localEnabled: boolean;
  remoteEnabled: boolean;
  resolvedEnabled?: boolean;
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
 * Read-only compatibility shape for the public 1.2.7 migration hold.
 *
 * The carrier has no Graph, Vault, planner, decision, or mutation capability.
 * A newer build validates this shape only so it can remove the carrier while
 * preserving the rest of the source-bound migration hold.
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

export function sameCommunityPluginEnablementMigrationCarrierV2(
  left: Readonly<CommunityPluginEnablementMigrationCarrierV2> | undefined,
  right: Readonly<CommunityPluginEnablementMigrationCarrierV2> | undefined,
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
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
    // Historical anchors may include plugins outside the selected set. They
    // remain passive input and are retired with the carrier.
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
