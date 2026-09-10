import { normalizePluginIds } from "./community-plugin-sync-policy";

/**
 * Device-local adoption memory for the sidebar new-plugin decision flow
 * (slice 2). It is intentionally separate from participation phases: the
 * participation schema is a strict per-plugin whitelist (hasOnlyKeys) and
 * adding keys there would break old readers. This store holds exactly two
 * facts that are only meaningful on the device that decided them:
 *
 * - ignoredPluginIds: plugins this device has seen and declined ("跳过").
 *   They are never re-proposed while the memory says ignored; clearing the
 *   memory (manager row re-opened / joined) is the only removal path.
 * - pendingPluginIds: new-plugin rows kept until the user downloads or
 *   skips them, so the sidebar entry survives restarts ("跨重启保留").
 *
 * Both lists are canonical (normalized, sorted, unique). The store is not
 * synchronized to other devices.
 */
export interface CommunityPluginAdoptionMemoryV1 {
  schemaVersion: 1;
  kind: "community-plugin-adoption-memory";
  ignoredPluginIds: string[];
  pendingPluginIds: string[];
}

export type CommunityPluginAdoptionMemoryCommand =
  | { type: "ignore"; pluginId: string }
  | { type: "clear-ignore"; pluginId: string }
  | { type: "remove-pending"; pluginId: string }
  | { type: "reconcile-pending"; pluginIds: readonly string[] };

export function createEmptyCommunityPluginAdoptionMemory():
  CommunityPluginAdoptionMemoryV1 {
  return {
    schemaVersion: 1,
    kind: "community-plugin-adoption-memory",
    ignoredPluginIds: [],
    pendingPluginIds: [],
  };
}

export function readCommunityPluginAdoptionMemory(
  value: unknown,
  ownPluginId = "easy-sync",
): CommunityPluginAdoptionMemoryV1 {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "community-plugin-adoption-memory"
    || !Array.isArray(value.ignoredPluginIds)
    || !Array.isArray(value.pendingPluginIds)
    || !hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "ignoredPluginIds",
      "pendingPluginIds",
    ])) {
    throw new Error("Community-plugin adoption memory is invalid");
  }
  const ignoredPluginIds = normalizePluginIds(
    value.ignoredPluginIds,
    ownPluginId,
  );
  const pendingPluginIds = normalizePluginIds(
    value.pendingPluginIds,
    ownPluginId,
  );
  if (!sameStringList(value.ignoredPluginIds, ignoredPluginIds)
    || !sameStringList(value.pendingPluginIds, pendingPluginIds)) {
    throw new Error("Community-plugin adoption memory is not canonical");
  }
  return { schemaVersion: 1, kind: "community-plugin-adoption-memory", ignoredPluginIds, pendingPluginIds };
}

export function reduceCommunityPluginAdoptionMemory(
  current: Readonly<CommunityPluginAdoptionMemoryV1>,
  command: Readonly<CommunityPluginAdoptionMemoryCommand>,
  ownPluginId = "easy-sync",
): CommunityPluginAdoptionMemoryV1 {
  const committed = readCommunityPluginAdoptionMemory(current, ownPluginId);
  switch (command.type) {
    case "ignore": {
      const pluginId = requirePluginId(command.pluginId, ownPluginId);
      if (
        committed.ignoredPluginIds.includes(pluginId)
        && !committed.pendingPluginIds.includes(pluginId)
      ) {
        return committed;
      }
      return {
        schemaVersion: 1,
        kind: "community-plugin-adoption-memory",
        ignoredPluginIds: [...committed.ignoredPluginIds, pluginId].sort(
          compareText,
        ),
        pendingPluginIds: committed.pendingPluginIds.filter(
          (candidate) => candidate !== pluginId,
        ),
      };
    }
    case "clear-ignore": {
      const pluginId = requirePluginId(command.pluginId, ownPluginId);
      if (!committed.ignoredPluginIds.includes(pluginId)) return committed;
      return {
        ...committed,
        ignoredPluginIds: committed.ignoredPluginIds.filter(
          (candidate) => candidate !== pluginId,
        ),
      };
    }
    case "remove-pending": {
      const pluginId = requirePluginId(command.pluginId, ownPluginId);
      if (!committed.pendingPluginIds.includes(pluginId)) return committed;
      return {
        ...committed,
        pendingPluginIds: committed.pendingPluginIds.filter(
          (candidate) => candidate !== pluginId,
        ),
      };
    }
    case "reconcile-pending": {
      // Ignored plugins are never re-proposed: reconcile must not resurrect
      // a skipped row even when a stale caller still passes its id.
      const ignored = new Set(committed.ignoredPluginIds);
      const pluginIds = normalizePluginIds(command.pluginIds, ownPluginId)
        .filter((pluginId) => !ignored.has(pluginId));
      if (sameStringList(pluginIds, committed.pendingPluginIds)) {
        return committed;
      }
      return { ...committed, pendingPluginIds: pluginIds };
    }
  }
}

export function isCommunityPluginIgnored(
  memory: Readonly<CommunityPluginAdoptionMemoryV1>,
  pluginId: string,
): boolean {
  return memory.ignoredPluginIds.includes(pluginId);
}

function requirePluginId(value: string, ownPluginId: string): string {
  const normalized = normalizePluginIds([value], ownPluginId)[0];
  if (!normalized || normalized !== value) {
    throw new Error(`Community plugin ID is invalid: ${value}`);
  }
  return normalized;
}

function sameStringList(left: readonly unknown[], right: readonly string[]):
  boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
