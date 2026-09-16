import {
  communityPluginManifestObservationMatchesRemote,
  parseCommunityPluginBundleManifest,
  readCommunityPluginManifestObservations,
  type CommunityPluginManifestObservationV1,
} from "./community-plugin-bundle";
import {
  type CommunityPluginAdoptionMemoryV1,
  isCommunityPluginIgnored,
} from "./community-plugin-adoption-memory";
import type { CommunityPluginLocalBundleFact } from "./community-plugin-join";
import type {
  DeviceCommunityPluginParticipationV1,
} from "./community-plugin-participation";
import type {
  RemoteCommunityPluginCatalogMemberV1,
  RemoteCommunityPluginCatalogV1,
} from "./community-plugin-remote-catalog";
import { sameSyncScope, type RemoteFileEntry, type SyncScope } from "./types";

/**
 * Pure discovery for the sidebar new-plugin decision flow (slice 2).
 *
 * A candidate is a cloud plugin that:
 *  - has a complete bundle in the current catalog,
 *  - is usable on this platform (mobile never proposes an `isDesktopOnly`
 *    bundle; a missing manifest observation leaves the platform fact
 *    unknown, and mobile also keeps those out until the bounded G6-1 probe
 *    resolves them),
 *  - has no meaningful participation intent on this device (absent,
 *    `never-participated` or `excluded` only — joining, restoring,
 *    participating, exiting and blocked devices are never re-proposed),
 *  - is not already installed with a complete local bundle (the row's
 *    premise is "not yet downloaded on this device"; an installed plugin
 *    with its sync toggle off rejoins via the manager toggle, not here —
 *    2026-09-09),
 *  - is not in this device's ignore memory.
 *
 * `excluded` rows are proposed again since 2026-09-09 (用户拍板): an excluded
 * plugin whose complete bundle sits in the cloud may have been re-uploaded by
 * another device ("另一台设备已把该插件同步到云端，本设备尚未收下"), and the
 * sidebar proposal is that device's entry point. That applies while the local
 * bundle is absent or partial (the cleaned-then-re-uploaded shape, or an
 * install the join can repair); a complete local bundle drops the row. Users
 * who really want an excluded plugin gone from proposals press「跳过」once
 * (ignore memory).
 *
 * A cloud-cleanup marker (2026-09-16 用户拍板) suppresses the proposal while
 * it stands: the marker means this device explicitly cleaned the bundle, and
 * the merged catalog can still remember the deleted bundle for a round or
 * two — proposing it then is pure noise. The marker is dropped by the fresh
 * delta refresh once the bundle genuinely reappears, which resumes proposals
 * and keeps the 重现即展示 semantics intact.
 *
 * The output replaces the stored pending set each round (reconcile): rows
 * whose bundle became partial/absent, whose device joined, or that the user
 * ignored disappear automatically; no separate tombstone is needed.
 */
export interface CommunityPluginAdoptionDiscoveryInput {
  scope: Readonly<SyncScope>;
  catalog: Readonly<RemoteCommunityPluginCatalogV1> | null;
  participation: Readonly<DeviceCommunityPluginParticipationV1> | null;
  memory: Readonly<CommunityPluginAdoptionMemoryV1>;
  manifestObservations: readonly Readonly<
    CommunityPluginManifestObservationV1
  >[];
  /**
   * Pre-resolved platform facts (from `resolveCommunityPluginPlatformFacts`)
   * for the same catalog and observation set. Callers that already resolved
   * the facts may pass them to avoid re-reading and re-hashing every stored
   * manifest text twice per round.
   */
  platformFacts?: ReadonlyMap<string, CommunityPluginPlatformFact>;
  /** The running platform. Mobile must never receive desktop-only bundles. */
  isMobile: boolean;
  ownPluginId?: string;
  /**
   * Local bundle facts (the `community-plugin-join` tri-state) for the
   * catalog's complete bundles. A complete local bundle fails the row's
   * "not yet downloaded" premise and drops the proposal; absent/partial
   * bundles still propose (the join restores or repairs them). A missing map
   * or an unlisted id keeps the proposal: without local evidence the
   * phase-only behavior stands.
   */
  localBundleFacts?: ReadonlyMap<string, CommunityPluginLocalBundleFact>;
  /**
   * Plugin ids carrying a cloud-cleanup marker on this device. While the
   * marker stands the discovery never proposes the plugin: the merged
   * catalog can still remember the just-deleted bundle for a round or two,
   * and the marker is dropped by the fresh refresh once the bundle genuinely
   * reappears (proposals resume then).
   */
  cleanupMarkerPluginIds?: readonly string[];
}

export interface CommunityPluginPlatformFact {
  /** Trusted manifest display name, null until the light read succeeded. */
  name: string | null;
  /** `isDesktopOnly` from the observed manifest; null when unobserved. */
  isDesktopOnly: boolean | null;
}

/**
 * Resolves one trusted platform fact per complete catalog entry from
 * source-bound manifest observations (mirrors the inventory's remote facts
 * rules; an observation that no longer matches the current member is not
 * evidence). Returns null when a plugin has no manifest observation.
 */
export async function resolveCommunityPluginPlatformFacts(
  scope: Readonly<SyncScope>,
  catalog: Readonly<RemoteCommunityPluginCatalogV1>,
  observations: readonly Readonly<CommunityPluginManifestObservationV1>[],
  ownPluginId: string,
): Promise<Map<string, CommunityPluginPlatformFact>> {
  const facts = new Map<string, CommunityPluginPlatformFact>();
  if (!sameSyncScope(catalog.scope, scope)) return facts;
  const validated = await readCommunityPluginManifestObservations(
    observations,
  );
  for (const entry of catalog.entries) {
    if (entry.bundleState !== "complete" || entry.pluginId === ownPluginId) {
      continue;
    }
    const manifestMember = entry.members.find((member) =>
      member.path.slice(member.path.lastIndexOf("/") + 1) === "manifest.json"
    );
    if (!manifestMember) continue;
    const observation = validated.find((candidate) =>
      candidate.pluginId === entry.pluginId
      && communityPluginManifestObservationMatchesRemote(
        candidate,
        scope,
        toRemoteFileEntry(manifestMember),
      )
    );
    if (!observation) {
      facts.set(entry.pluginId, { name: null, isDesktopOnly: null });
      continue;
    }
    const parsed = parseCommunityPluginBundleManifest(
      observation.manifestText,
      entry.pluginId,
    );
    facts.set(entry.pluginId, {
      name: parsed.name,
      isDesktopOnly: parsed.isDesktopOnly,
    });
  }
  return facts;
}

export async function deriveCommunityPluginAdoptionCandidates(
  input: Readonly<CommunityPluginAdoptionDiscoveryInput>,
): Promise<string[]> {
  const ownPluginId = input.ownPluginId ?? "easy-sync";
  const catalog = input.catalog;
  if (!catalog || !sameSyncScope(catalog.scope, input.scope)) return [];
  const participation = input.participation;
  const cleanupMarkers = new Set(input.cleanupMarkerPluginIds ?? []);
  const proposable = (pluginId: string): boolean => {
    const phase = participation?.pluginsById[pluginId]?.phase;
    return phase === undefined
      || phase === "never-participated"
      || phase === "excluded";
  };
  const facts = input.platformFacts
    ?? await resolveCommunityPluginPlatformFacts(
      input.scope,
      catalog,
      input.manifestObservations,
      ownPluginId,
    );
  const candidates: string[] = [];
  for (const entry of catalog.entries) {
    const pluginId = entry.pluginId;
    if (
      entry.bundleState !== "complete"
      || pluginId === ownPluginId
      || !proposable(pluginId)
      || cleanupMarkers.has(pluginId)
      || input.localBundleFacts?.get(pluginId) === "complete"
      || isCommunityPluginIgnored(input.memory, pluginId)
    ) {
      continue;
    }
    const fact = facts.get(pluginId) ?? { name: null, isDesktopOnly: null };
    if (input.isMobile && fact.isDesktopOnly !== false) continue;
    candidates.push(pluginId);
  }
  return candidates.sort((left, right) => left.localeCompare(right));
}

function toRemoteFileEntry(
  member: Readonly<RemoteCommunityPluginCatalogMemberV1>,
): RemoteFileEntry {
  return {
    path: member.path,
    driveId: member.remoteId,
    parentId: member.parentId,
    size: member.size,
    mtime: member.mtime,
    eTag: member.eTag,
    cTag: member.cTag,
    ...(member.sha256Hash ? { sha256Hash: member.sha256Hash } : {}),
    ...(member.quickXorHash ? { quickXorHash: member.quickXorHash } : {}),
  };
}
