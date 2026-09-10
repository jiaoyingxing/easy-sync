import {
  communityPluginManifestObservationMatchesRemote,
  createCommunityPluginManifestObservation,
  type CommunityPluginManifestObservationV1,
} from "./community-plugin-bundle";
import type {
  RemoteCommunityPluginCatalogEntryV1,
  RemoteCommunityPluginCatalogMemberV1,
  RemoteCommunityPluginCatalogV1,
} from "./community-plugin-remote-catalog";
import {
  sameSyncScope,
  type RemoteFileEntry,
  type SyncScope,
} from "./types";

/**
 * Maximum manifest downloads per invocation. A freshly refreshed catalog can
 * surface many previously unseen bundles on a new device; each call only
 * reads a bounded slice and later trigger points keep making progress.
 */
export const COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT = 10;

export interface CommunityPluginDisplayFactsResult {
  /** Bundles whose manifest text was downloaded, parsed, and persisted. */
  probed: number;
  /** Complete bundles already covered by a source-matching stored observation. */
  skipped: number;
  /** Fetch/parse failures that silently fell back without persisting data. */
  failed: number;
}

export interface CommunityPluginDisplayFactsInput {
  /** Scope the catalog and every new observation must be bound to. */
  scope: Readonly<SyncScope>;
  /**
   * Obsidian config directory (e.g. ".obsidian") that anchors the plugin
   * paths carried by the catalog members.
   */
  configDir: string;
  /** Freshly persisted catalog whose entries are reconciled. */
  catalog: Readonly<RemoteCommunityPluginCatalogV1>;
  /**
   * The last persisted catalog for the same scope, when one exists. It ranks
   * entries that appeared since the last trigger ahead of older unobserved
   * leftovers inside the per-call probe budget.
   */
  previousCatalog: Readonly<RemoteCommunityPluginCatalogV1> | null;
  /** Currently persisted observations; kept and merged on every write. */
  storedObservations: readonly Readonly<CommunityPluginManifestObservationV1>[];
  /**
   * Downloads the manifest.json body for one catalog member and returns its
   * decoded text. A null return (or a throw) is treated as a failed probe.
   */
  fetchManifestText(
    pluginId: string,
    member: Readonly<RemoteCommunityPluginCatalogMemberV1>,
  ): Promise<string | null>;
  /**
   * Persists the complete next observation set (stored plus newly created
   * ones, sorted by plugin id). Called at most once, only when new
   * observations were created.
   */
  persist(
    observations: readonly Readonly<CommunityPluginManifestObservationV1>[],
  ): Promise<void>;
  /** Epoch milliseconds of the current call (caller clock). */
  now: number;
}

/**
 * Reconciliation anchor for observation-relative filtering. A candidate is a
 * complete catalog entry whose current manifest member has no stored
 * observation with the same scope, path, remote id, and version facts
 * (`communityPluginManifestObservationMatchesRemote`). The stored-observation
 * anchor is what keeps calls idempotent: entries probed on earlier triggers
 * are skipped without requests, an eTag change makes an entry a candidate
 * again, and entries that a per-call probe limit skipped (or whose probe
 * failed) stay candidates for later trigger points. A pure diff against
 * `previousCatalog` cannot play that role, because the freshly built catalog
 * (which already contains the leftovers) is persisted before the next trigger
 * runs; `previousCatalog` therefore only ranks newly appeared entries ahead
 * of older leftovers inside the budget.
 */
export async function ensureCommunityPluginDisplayFacts(
  input: Readonly<CommunityPluginDisplayFactsInput>,
): Promise<CommunityPluginDisplayFactsResult> {
  const scope = input.scope;
  if (!sameSyncScope(input.catalog.scope, scope)) {
    return { probed: 0, skipped: 0, failed: 0 };
  }

  const observationsByPlugin = new Map<
    string,
    CommunityPluginManifestObservationV1[]
  >();
  for (const observation of input.storedObservations) {
    const list = observationsByPlugin.get(observation.pluginId);
    if (list) list.push({ ...observation, scope: { ...observation.scope } });
    else {
      observationsByPlugin.set(observation.pluginId, [
        { ...observation, scope: { ...observation.scope } },
      ]);
    }
  }

  const previousIds = new Set<string>();
  if (
    input.previousCatalog
    && sameSyncScope(input.previousCatalog.scope, scope)
  ) {
    for (const entry of input.previousCatalog.entries) {
      previousIds.add(entry.pluginId);
    }
  }

  const considered: Array<{
    entry: RemoteCommunityPluginCatalogEntryV1;
    member: RemoteCommunityPluginCatalogMemberV1;
    freshlyAppeared: boolean;
  }> = [];
  for (const entry of input.catalog.entries) {
    if (entry.bundleState !== "complete") continue;
    const manifestMember = entry.members.find((candidate) =>
      candidate.path.slice(candidate.path.lastIndexOf("/") + 1)
        === "manifest.json"
    );
    // A manifest member without an eTag cannot anchor a durable observation:
    // the persisted source record requires a non-empty eTag to validate.
    if (!manifestMember || !manifestMember.eTag) continue;
    considered.push({
      entry,
      member: manifestMember,
      freshlyAppeared: !previousIds.has(entry.pluginId),
    });
  }
  considered.sort((left, right) => {
    if (left.freshlyAppeared !== right.freshlyAppeared) {
      return left.freshlyAppeared ? -1 : 1;
    }
    return comparePluginIds(left.entry.pluginId, right.entry.pluginId);
  });

  let probed = 0;
  let skipped = 0;
  let failed = 0;
  let attempts = 0;
  const added: CommunityPluginManifestObservationV1[] = [];
  for (const { entry, member } of considered) {
    if (
      (observationsByPlugin.get(entry.pluginId) ?? []).some((observation) =>
        communityPluginManifestObservationMatchesRemote(
          observation,
          scope,
          toRemoteFileEntry(member),
        ))
    ) {
      skipped++;
      continue;
    }
    if (attempts >= COMMUNITY_PLUGIN_DISPLAY_FACTS_PROBE_LIMIT) break;
    attempts++;
    let text: string | null;
    try {
      text = await input.fetchManifestText(entry.pluginId, member);
    } catch {
      text = null;
    }
    if (text === null) {
      failed++;
      continue;
    }
    try {
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength !== member.size) {
        // A stale or truncated download would produce an observation that the
        // strict persisted-source reader rejects as invalid; fail this probe
        // instead of persisting a record that cannot be read back.
        throw new Error(
          `Remote plugin manifest byte size does not match its catalog member: ${member.path}`,
        );
      }
      const observation = await createCommunityPluginManifestObservation(
        scope,
        entry.pluginId,
        toRemoteFileEntry(member),
        bytes.buffer,
      );
      added.push(observation);
      const list = observationsByPlugin.get(entry.pluginId);
      if (list) list.push(observation);
      else observationsByPlugin.set(entry.pluginId, [observation]);
      probed++;
    } catch {
      failed++;
    }
  }

  if (added.length > 0) {
    const merged = [...input.storedObservations, ...added].sort((left, right) =>
      comparePluginIds(left.pluginId, right.pluginId)
    );
    await input.persist(merged);
  }
  return { probed, skipped, failed };
}

/**
 * Merge a persisted observation store with one round's freshly observed set.
 *
 * Incoming entries replace stored entries of the same plugin id; stored
 * entries of other plugins (e.g. display-facts light reads for remote-only
 * bundles) are retained. An empty incoming set therefore never shrinks the
 * store. Consumers match source-bound (scope, remote id, eTag) before use, so
 * retained entries that no longer match are simply never selected again.
 */
export function mergeCommunityPluginManifestObservations(
  stored: readonly Readonly<CommunityPluginManifestObservationV1>[],
  incoming: readonly Readonly<CommunityPluginManifestObservationV1>[],
): CommunityPluginManifestObservationV1[] {
  const incomingIds = new Set(incoming.map((item) => item.pluginId));
  const merged = [
    ...stored.filter((item) => !incomingIds.has(item.pluginId)),
    ...incoming,
  ].sort((left, right) => comparePluginIds(left.pluginId, right.pluginId));
  return merged;
}

function comparePluginIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
