import type { DataAdapter, PluginManifest } from "obsidian";
import {
  communityPluginManifestObservationMatchesRemote,
  parseCommunityPluginBundleManifest,
  parseCommunityPluginBundlePath,
  readCommunityPluginManifestObservation,
  type CommunityPluginManifestObservationV1,
} from "./community-plugin-bundle";
import type {
  RemoteFileEntry,
  SyncScope,
} from "./types";
import type { DeviceCommunityPluginPhase } from "./community-plugin-participation";

export interface CommunityPluginInventoryItem {
  id: string;
  name: string | null;
  version: string | null;
  local: boolean;
  remote: boolean;
  dataLocally: boolean;
  dataRemotely: boolean;
  desktopOnly: boolean;
  manifestIssue: boolean;
  /** Current device intent. Absent only before the one-time V2 migration. */
  participationPhase?: DeviceCommunityPluginPhase;
  /** Exact persisted reason when the participation phase is blocked. */
  participationBlockedReason?: string;
  /** Last complete remote catalog is retained, but its latest refresh failed. */
  remoteCatalogStale?: boolean;
  /** Historical local common-state evidence; not a claim that either current
   *  side still has data.json. */
  dataHistoricallyPresent?: boolean;
}

export interface CommunityPluginRemoteManifestEvidence {
  scope: Readonly<SyncScope>;
  observations: readonly Readonly<CommunityPluginManifestObservationV1>[];
}

export async function buildCommunityPluginInventory(
  adapter: DataAdapter,
  configDir: string,
  ownPluginId = "easy-sync",
  retainedPluginIds: readonly string[] = [],
  remoteFiles: readonly RemoteFileEntry[] = [],
  locallyIgnoredPluginIds: readonly string[] = [],
  mobileDesktopOnlyPluginIds: readonly string[] = [],
  historicalDataPluginIds: readonly string[] = [],
  remoteManifestEvidence: Readonly<CommunityPluginRemoteManifestEvidence>
    | null = null,
  historicallyRemotePluginIds: readonly string[] = [],
): Promise<CommunityPluginInventoryItem[]> {
  const pluginRoot = `${configDir}/plugins`;
  const localIds = await listLocalPluginIds(adapter, pluginRoot, ownPluginId);
  const remoteIds = collectRemotePluginIds(
    remoteFiles,
    `${pluginRoot}/`,
    ownPluginId,
  );
  const remoteDataIds = collectRemoteDataIds(
    remoteFiles,
    `${pluginRoot}/`,
    ownPluginId,
  );
  const retainedIds = retainedPluginIds.filter((id) =>
    isSafePluginId(id) && id !== ownPluginId
  );
  const locallyIgnoredIds = new Set(locallyIgnoredPluginIds.filter((id) =>
    isSafePluginId(id) && id !== ownPluginId
  ));
  const mobileDesktopOnlyIds = new Set(
    mobileDesktopOnlyPluginIds.filter((id) =>
      isSafePluginId(id) && id !== ownPluginId
    ),
  );
  const historicalDataIds = new Set(
    historicalDataPluginIds.filter((id) =>
      isSafePluginId(id) && id !== ownPluginId
    ),
  );
  const historicallyRemoteIds = new Set(
    historicallyRemotePluginIds.filter((id) =>
      isSafePluginId(id) && id !== ownPluginId
    ),
  );
  const remoteManifestNames = await collectRemoteManifestNames(
    remoteFiles,
    configDir,
    ownPluginId,
    remoteManifestEvidence,
  );
  const allIds = [...new Set([...localIds, ...remoteIds, ...retainedIds])]
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(allIds.map(async (id) => {
    const localDirectory = localIds.has(id);
    const manifest = localDirectory
      ? await readPluginManifest(adapter, `${pluginRoot}/${id}/manifest.json`)
      : null;
    const local = localDirectory
      && !(
        (locallyIgnoredIds.has(id) || mobileDesktopOnlyIds.has(id))
        && manifest === null
      );
    return {
      id,
      name: manifest?.manifest.name.trim()
        ?? remoteManifestNames.get(id)
        ?? null,
      version: manifest?.manifest.version?.trim() || null,
      local,
      remote: remoteIds.has(id)
        || (locallyIgnoredIds.has(id) && historicallyRemoteIds.has(id)),
      dataLocally: local
        && await adapter.exists(`${pluginRoot}/${id}/data.json`),
      dataRemotely: remoteDataIds.has(id),
      desktopOnly: manifest?.manifest.isDesktopOnly === true
        || mobileDesktopOnlyIds.has(id),
      manifestIssue: local && manifest === null,
      ...(historicalDataIds.has(id)
        ? { dataHistoricallyPresent: true }
        : {}),
    };
  }));
}

async function collectRemoteManifestNames(
  remoteFiles: readonly RemoteFileEntry[],
  configDir: string,
  ownPluginId: string,
  evidence: Readonly<CommunityPluginRemoteManifestEvidence> | null,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!evidence) return names;

  const remoteManifests = new Map<string, RemoteFileEntry>();
  const ambiguousRemoteIds = new Set<string>();
  for (const remote of remoteFiles) {
    const bundlePath = parseCommunityPluginBundlePath(remote.path, configDir);
    if (
      !bundlePath
      || bundlePath.fileName !== "manifest.json"
      || bundlePath.pluginId === ownPluginId
    ) continue;
    if (remoteManifests.has(bundlePath.pluginId)) {
      ambiguousRemoteIds.add(bundlePath.pluginId);
      remoteManifests.delete(bundlePath.pluginId);
      continue;
    }
    if (!ambiguousRemoteIds.has(bundlePath.pluginId)) {
      remoteManifests.set(bundlePath.pluginId, remote);
    }
  }

  const validated = await Promise.all(
    evidence.observations.map((observation) =>
      readCommunityPluginManifestObservation(observation)
    ),
  );
  const ambiguousNames = new Set<string>();
  for (const observation of validated) {
    if (!observation || observation.pluginId === ownPluginId) continue;
    const remote = remoteManifests.get(observation.pluginId);
    if (
      !remote
      || !communityPluginManifestObservationMatchesRemote(
        observation,
        evidence.scope,
        remote,
      )
    ) continue;
    const name = parseCommunityPluginBundleManifest(
      observation.manifestText,
      observation.pluginId,
    ).name;
    if (!name || ambiguousNames.has(observation.pluginId)) continue;
    const existing = names.get(observation.pluginId);
    if (existing !== undefined && existing !== name) {
      names.delete(observation.pluginId);
      ambiguousNames.add(observation.pluginId);
      continue;
    }
    names.set(observation.pluginId, name);
  }
  return names;
}

function collectRemoteDataIds(
  files: readonly RemoteFileEntry[],
  pluginRootPrefix: string,
  ownPluginId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const file of files) {
    if (!file.path.startsWith(pluginRootPrefix)) continue;
    const relative = file.path.slice(pluginRootPrefix.length);
    const parts = relative.split("/");
    if (
      parts.length === 2
      && parts[1] === "data.json"
      && isSafePluginId(parts[0])
      && parts[0] !== ownPluginId
    ) {
      ids.add(parts[0]);
    }
  }
  return ids;
}

async function listLocalPluginIds(
  adapter: DataAdapter,
  pluginRoot: string,
  ownPluginId: string,
): Promise<Set<string>> {
  if (!await adapter.exists(pluginRoot)) return new Set();
  const listed = await adapter.list(pluginRoot);
  const candidates = listed.folders
    .map((path) => path.replace(/\/+$/, "").split("/").pop() ?? "")
    .filter((id) => isSafePluginId(id) && id !== ownPluginId);
  const ids = new Set<string>();
  for (const id of candidates) {
    const root = `${pluginRoot}/${id}`;
    for (const fileName of [
      "main.js",
      "manifest.json",
      "styles.css",
      "data.json",
    ]) {
      if (await adapter.exists(`${root}/${fileName}`)) {
        ids.add(id);
        break;
      }
    }
  }
  return ids;
}

function collectRemotePluginIds(
  files: readonly RemoteFileEntry[],
  pluginRootPrefix: string,
  ownPluginId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const file of files) {
    if (!file.path.startsWith(pluginRootPrefix)) continue;
    const relative = file.path.slice(pluginRootPrefix.length);
    const parts = relative.split("/");
    if (
      parts.length === 2
      && ["main.js", "manifest.json", "styles.css", "data.json"]
        .includes(parts[1])
      && isSafePluginId(parts[0])
      && parts[0] !== ownPluginId
    ) ids.add(parts[0]);
  }
  return ids;
}

async function readPluginManifest(
  adapter: DataAdapter,
  path: string,
): Promise<{ manifest: PluginManifest } | null> {
  try {
    const parsed: unknown = JSON.parse(await adapter.read(path));
    if (!parsed || typeof parsed !== "object") return null;
    const manifest = parsed as Partial<PluginManifest>;
    if (
      typeof manifest.id !== "string"
      || !isSafePluginId(manifest.id)
      || typeof manifest.name !== "string"
      || manifest.name.trim().length === 0
      || typeof manifest.version !== "string"
    ) return null;
    return { manifest: manifest as PluginManifest };
  } catch {
    return null;
  }
}

function isSafePluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value);
}
