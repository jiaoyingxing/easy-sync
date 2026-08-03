import type {
  DeviceCommunityPluginParticipationCommand,
  DeviceCommunityPluginParticipationEntryV1,
} from "./community-plugin-participation";
import type {
  RemoteCommunityPluginCatalogMemberV1,
  RemoteCommunityPluginCatalogV1,
} from "./community-plugin-remote-catalog";
import {
  sameSyncScope,
  type RemoteFileEntry,
  type SyncScope,
} from "./types";

export type CommunityPluginJoinBlockReason =
  | "catalog-unavailable"
  | "catalog-stale"
  | "scope-changed"
  | "remote-bundle-missing"
  | "remote-bundle-incomplete"
  | "remote-bundle-changed"
  | "local-bundle-incomplete"
  | "manifest-incompatible";

const RETRYABLE_COMMUNITY_PLUGIN_JOIN_BLOCK_REASONS = new Set<string>([
  "catalog-unavailable",
  "catalog-stale",
  "remote-bundle-missing",
  "remote-bundle-incomplete",
  "local-bundle-incomplete",
]);

/** Retry only facts that can recover without silently changing the user's
 *  bound plugin target. Unknown and permanent reasons fail closed. */
export function isCommunityPluginJoinBlockRetryable(
  reason: string | undefined,
): boolean {
  return reason !== undefined
    && RETRYABLE_COMMUNITY_PLUGIN_JOIN_BLOCK_REASONS.has(reason);
}

export interface CommunityPluginJoinAuthorization {
  pluginId: string;
  operationId: string;
  targetCatalogRevision: number;
  targetBundleDigest: string;
  scope: SyncScope;
  members: RemoteCommunityPluginCatalogMemberV1[];
}

export interface CommunityPluginJoinBlock {
  pluginId: string;
  operationId?: string;
  reason: CommunityPluginJoinBlockReason;
}

export type CommunityPluginLocalBundleFact =
  | "absent"
  | "partial"
  | "complete";

export function planCommunityPluginJoins(input: Readonly<{
  entries: readonly Readonly<DeviceCommunityPluginParticipationEntryV1>[];
  localBundleFacts: ReadonlyMap<string, CommunityPluginLocalBundleFact>;
  catalog: Readonly<RemoteCommunityPluginCatalogV1> | null;
  scope: Readonly<SyncScope> | null;
}>): {
  commands: DeviceCommunityPluginParticipationCommand[];
  authorizations: CommunityPluginJoinAuthorization[];
} {
  const commands: DeviceCommunityPluginParticipationCommand[] = [];
  const authorizations: CommunityPluginJoinAuthorization[] = [];
  for (const original of [...input.entries].sort((left, right) =>
    left.pluginId.localeCompare(right.pluginId))) {
    if (original.phase !== "join-requested" && original.phase !== "restoring") {
      continue;
    }
    const local = input.localBundleFacts.get(original.pluginId) ?? "absent";
    if (original.phase === "join-requested" && local === "complete") {
      commands.push({
        type: "confirm-participating",
        pluginId: original.pluginId,
      });
      continue;
    }
    if (original.phase === "join-requested" && local === "partial") {
      commands.push({
        type: "block",
        pluginId: original.pluginId,
        reason: "local-bundle-incomplete",
      });
      continue;
    }

    let current = original;
    const catalogEntry = input.catalog?.entries.find(
      (entry) => entry.pluginId === original.pluginId,
    );
    if (
      original.phase === "join-requested"
      && !original.targetBundleDigest
      && input.catalog
      && !input.catalog.stale
      && catalogEntry?.bundleState === "complete"
    ) {
      current = {
        ...original,
        targetCatalogRevision: input.catalog.revision,
        targetBundleDigest: catalogEntry.bundleDigest,
      };
      commands.push({
        type: "request-join",
        pluginId: original.pluginId,
        operationId: original.operationId,
        targetCatalogRevision: input.catalog.revision,
        targetBundleDigest: catalogEntry.bundleDigest,
      });
    }
    const prepared = createCommunityPluginJoinAuthorization({
      participation: current,
      catalog: input.catalog,
      scope: input.scope,
    });
    if (prepared.status === "blocked") {
      commands.push({
        type: "block",
        pluginId: original.pluginId,
        reason: prepared.reason,
      });
      continue;
    }
    if (original.phase === "join-requested") {
      commands.push({
        type: "begin-restore",
        pluginId: original.pluginId,
        operationId: original.operationId,
      });
    }
    authorizations.push(prepared.authorization);
  }
  return { commands, authorizations };
}

export function createCommunityPluginJoinAuthorization(input: Readonly<{
  participation: Readonly<DeviceCommunityPluginParticipationEntryV1>;
  catalog: Readonly<RemoteCommunityPluginCatalogV1> | null;
  scope: Readonly<SyncScope> | null;
}>):
  | { status: "ready"; authorization: CommunityPluginJoinAuthorization }
  | { status: "blocked"; reason: CommunityPluginJoinBlockReason } {
  const { participation, catalog, scope } = input;
  if (
    participation.phase !== "join-requested"
    && participation.phase !== "restoring"
  ) {
    return { status: "blocked", reason: "remote-bundle-changed" };
  }
  if (!scope || !catalog) {
    return { status: "blocked", reason: "catalog-unavailable" };
  }
  if (!sameSyncScope(catalog.scope, scope)) {
    return { status: "blocked", reason: "scope-changed" };
  }
  if (catalog.stale) return { status: "blocked", reason: "catalog-stale" };
  const entry = catalog.entries.find(
    (candidate) => candidate.pluginId === participation.pluginId,
  );
  if (!entry) {
    return { status: "blocked", reason: "remote-bundle-missing" };
  }
  if (entry.bundleState !== "complete") {
    return { status: "blocked", reason: "remote-bundle-incomplete" };
  }
  if (
    !participation.operationId
    || participation.targetCatalogRevision === undefined
    || !participation.targetBundleDigest
    || participation.targetBundleDigest !== entry.bundleDigest
  ) {
    return { status: "blocked", reason: "remote-bundle-changed" };
  }
  return {
    status: "ready",
    authorization: {
      pluginId: participation.pluginId,
      operationId: participation.operationId,
      targetCatalogRevision: participation.targetCatalogRevision,
      targetBundleDigest: participation.targetBundleDigest,
      scope: { ...scope },
      members: entry.members.map((member) => ({ ...member })),
    },
  };
}

export function validateCommunityPluginJoinAuthorization(
  authorization: Readonly<CommunityPluginJoinAuthorization>,
  remoteEntries: readonly Readonly<RemoteFileEntry>[],
  scope: Readonly<SyncScope>,
): { status: "valid" } | {
  status: "blocked";
  reason: CommunityPluginJoinBlockReason;
} {
  if (!sameSyncScope(authorization.scope, scope)) {
    return { status: "blocked", reason: "scope-changed" };
  }
  const expectedByPath = new Map(
    authorization.members.map((member) => [member.path, member]),
  );
  const firstPath = authorization.members[0]?.path ?? "";
  const root = firstPath.slice(0, firstPath.lastIndexOf("/"));
  const current = remoteEntries.filter((entry) => {
    if (!root || !entry.path.startsWith(`${root}/`)) return false;
    const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    return ["main.js", "manifest.json", "styles.css"].includes(fileName);
  });
  if (current.length !== expectedByPath.size) {
    return { status: "blocked", reason: "remote-bundle-changed" };
  }
  for (const remote of current) {
    const expected = expectedByPath.get(remote.path);
    if (!expected) {
      return { status: "blocked", reason: "remote-bundle-changed" };
    }
    if (
      remote.driveId !== expected.remoteId
      || remote.parentId !== expected.parentId
      || remote.size !== expected.size
      || remote.eTag !== expected.eTag
      || remote.cTag !== expected.cTag
      || (
        expected.sha256Hash !== null
        && remote.sha256Hash !== expected.sha256Hash
      )
      || (
        expected.quickXorHash !== null
        && remote.quickXorHash !== expected.quickXorHash
      )
    ) {
      return { status: "blocked", reason: "remote-bundle-changed" };
    }
  }
  return { status: "valid" };
}
