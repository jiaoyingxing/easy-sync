import { sha256Hex } from "../crypto";
import type { DriveItem } from "../onedrive/types";
import {
  communityPluginManifestObservationMatchesRemote,
  parseCommunityPluginBundleManifest,
  parseCommunityPluginBundlePath,
  readCommunityPluginManifestObservations,
  type CommunityPluginManifestObservationV1,
} from "./community-plugin-bundle";
import {
  buildRemoteIndexV2,
  projectRemoteNodesV2,
  type RemoteIndexV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import {
  isSyncScope,
  sameSyncScope,
  type RemoteFileEntry,
  type SyncScope,
} from "./types";

export interface RemoteCommunityPluginCatalogMemberV1 {
  path: string;
  remoteId: string;
  parentId: string;
  size: number;
  mtime: number;
  eTag: string;
  cTag: string;
  sha256Hash: string | null;
  quickXorHash: string | null;
}

export interface RemoteCommunityPluginCatalogEntryV1 {
  pluginId: string;
  bundleState: "complete" | "partial";
  bundleDigest: string;
  members: RemoteCommunityPluginCatalogMemberV1[];
  manifestName?: string;
}

/**
 * Disposable, device-local evidence from one complete files-root enumeration.
 * It is neither device participation nor cloud lifecycle authority.
 */
export interface RemoteCommunityPluginCatalogV1 {
  version: 1;
  scope: SyncScope;
  complete: true;
  stale: boolean;
  revision: number;
  observedAt: number;
  sourceDigest: string;
  entries: RemoteCommunityPluginCatalogEntryV1[];
  lastRefreshFailedAt?: number;
}

export interface BuildRemoteCommunityPluginCatalogInput {
  scope: Readonly<SyncScope>;
  configDir: string;
  items: readonly Readonly<DriveItem>[];
  manifestObservations: readonly Readonly<
    CommunityPluginManifestObservationV1
  >[];
  observedAt: number;
  previous: Readonly<RemoteCommunityPluginCatalogV1> | null;
  ownPluginId?: string;
}

export interface BuildRemoteCommunityPluginCatalogFromIndexInput {
  scope: Readonly<SyncScope>;
  configDir: string;
  /**
   * The scope's committed V2 remote index. Its nodes are the round's already
   * fetched and validated remote facts, so building the catalog from them
   * costs zero extra network requests (per-round catalog freshness).
   */
  index: Readonly<RemoteIndexV2>;
  manifestObservations: readonly Readonly<
    CommunityPluginManifestObservationV1
  >[];
  observedAt: number;
  previous: Readonly<RemoteCommunityPluginCatalogV1> | null;
  ownPluginId?: string;
}

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function buildRemoteCommunityPluginCatalog(
  input: Readonly<BuildRemoteCommunityPluginCatalogInput>,
): Promise<RemoteCommunityPluginCatalogV1> {
  if (!isSyncScope(input.scope)) throw new Error("Remote plugin catalog scope is invalid");
  assertTimestamp(input.observedAt, "observedAt");
  const ownPluginId = input.ownPluginId ?? "easy-sync";
  const latest = new Map<string, Readonly<DriveItem>>();
  for (const item of input.items) {
    if (
      item.parentReference?.driveId
      && item.parentReference.driveId !== input.scope.driveId
    ) {
      throw new Error("Remote plugin catalog item belongs to another drive");
    }
    latest.set(item.id, item);
  }
  const projectedItems = [...latest.values()]
    .filter((item) => item.id !== input.scope.filesRootId)
    .map((item) => structuredClone(item));
  const projection = buildRemoteIndexV2(
    projectedItems,
    input.scope.filesRootId,
    null,
  );
  return buildRemoteCommunityPluginCatalogCore({
    scope: input.scope,
    configDir: input.configDir,
    nodes: Object.values(projection.index.itemsById),
    pathById: projection.pathById,
    manifestObservations: input.manifestObservations,
    observedAt: input.observedAt,
    previous: input.previous,
    ownPluginId,
  });
}

export async function buildRemoteCommunityPluginCatalogFromIndex(
  input: Readonly<BuildRemoteCommunityPluginCatalogFromIndexInput>,
): Promise<RemoteCommunityPluginCatalogV1> {
  if (!isSyncScope(input.scope)) throw new Error("Remote plugin catalog scope is invalid");
  if (
    input.index.complete !== true
    || input.index.filesRootId !== input.scope.filesRootId
  ) {
    throw new Error(
      "Remote plugin catalog committed index is not complete for the scope",
    );
  }
  assertTimestamp(input.observedAt, "observedAt");
  const nodes = Object.values(input.index.itemsById)
    .filter((node) => node.id !== input.index.filesRootId);
  const pathById = projectRemoteNodesV2(
    nodes,
    input.index.filesRootId,
  ).pathById;
  return buildRemoteCommunityPluginCatalogCore({
    scope: input.scope,
    configDir: input.configDir,
    nodes,
    pathById,
    manifestObservations: input.manifestObservations,
    observedAt: input.observedAt,
    previous: input.previous,
    ownPluginId: input.ownPluginId ?? "easy-sync",
  });
}

/**
 * Shared entry builder over one projected remote node set. `nodes` must
 * exclude the scope root folder; `pathById` must resolve every node path.
 * Both public builders (item-stream refresh and committed-index round update)
 * converge here so their facts and validation semantics stay identical.
 */
async function buildRemoteCommunityPluginCatalogCore(
  input: Readonly<{
    scope: Readonly<SyncScope>;
    configDir: string;
    nodes: readonly Readonly<RemoteNodeV2>[];
    pathById: ReadonlyMap<string, string>;
    manifestObservations: readonly Readonly<
      CommunityPluginManifestObservationV1
    >[];
    observedAt: number;
    previous: Readonly<RemoteCommunityPluginCatalogV1> | null;
    ownPluginId: string;
  }>,
): Promise<RemoteCommunityPluginCatalogV1> {
  const membersByPluginId = new Map<
    string,
    RemoteCommunityPluginCatalogMemberV1[]
  >();
  for (const node of input.nodes) {
    if (node.kind !== "file") continue;
    const path = input.pathById.get(node.id);
    if (!path) throw new Error(`Remote plugin catalog path is missing: ${node.id}`);
    const managed = parseCommunityPluginBundlePath(path, input.configDir);
    if (!managed || managed.pluginId === input.ownPluginId) continue;
    const size = node.size ?? 0;
    const mtime = node.mtime ?? 0;
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime)) {
      throw new Error(`Remote plugin catalog member facts are invalid: ${path}`);
    }
    if (!node.eTag && !node.cTag) {
      throw new Error(`Remote plugin catalog member has no version: ${path}`);
    }
    const member: RemoteCommunityPluginCatalogMemberV1 = {
      path,
      remoteId: node.id,
      parentId: node.parentId,
      size,
      mtime,
      eTag: node.eTag ?? "",
      cTag: node.cTag ?? "",
      sha256Hash: node.contentHash ?? null,
      quickXorHash: node.quickXorHash ?? null,
    };
    const current = membersByPluginId.get(managed.pluginId) ?? [];
    current.push(member);
    membersByPluginId.set(managed.pluginId, current);
  }
  const observations = await readCommunityPluginManifestObservations(
    input.manifestObservations,
  );
  const entries: RemoteCommunityPluginCatalogEntryV1[] = [];
  for (const pluginId of [...membersByPluginId.keys()].sort(compareText)) {
    const members = membersByPluginId.get(pluginId)!.sort(compareMember);
    const names = new Set(members.map((member) =>
      parseCommunityPluginBundlePath(member.path, input.configDir)?.fileName
    ));
    const manifestMember = members.find((member) =>
      parseCommunityPluginBundlePath(member.path, input.configDir)?.fileName
        === "manifest.json"
    );
    const manifestName = manifestMember
      ? matchingManifestName(
          observations,
          input.scope,
          pluginId,
          toRemoteFileEntry(manifestMember),
        )
      : null;
    entries.push({
      pluginId,
      bundleState:
        names.has("main.js") && names.has("manifest.json")
          ? "complete"
          : "partial",
      bundleDigest: await digest(members),
      members,
      ...(manifestName ? { manifestName } : {}),
    });
  }
  const sourceDigest = await digest(entries);
  const revision = input.previous
    && sameSyncScope(input.previous.scope, input.scope)
      ? input.previous.sourceDigest === sourceDigest
        ? input.previous.revision
        : input.previous.revision + 1
      : 1;
  return {
    version: 1,
    scope: { ...input.scope },
    complete: true,
    stale: false,
    revision,
    observedAt: input.observedAt,
    sourceDigest,
    entries,
  };
}

export async function readRemoteCommunityPluginCatalog(
  value: unknown,
): Promise<RemoteCommunityPluginCatalogV1 | null> {
  if (!isRecord(value)
    || value.version !== 1
    || !isSyncScope(value.scope)
    || value.complete !== true
    || typeof value.stale !== "boolean"
    || !isPositiveSafeInteger(value.revision)
    || !isTimestamp(value.observedAt)
    || typeof value.sourceDigest !== "string"
    || !SHA256_PATTERN.test(value.sourceDigest)
    || !Array.isArray(value.entries)
    || !isOptionalTimestamp(value.lastRefreshFailedAt)
    || !hasOnlyKeys(value, [
      "version",
      "scope",
      "complete",
      "stale",
      "revision",
      "observedAt",
      "sourceDigest",
      "entries",
      "lastRefreshFailedAt",
    ])
    || (value.stale !== (value.lastRefreshFailedAt !== undefined))) {
    return null;
  }
  const entries: RemoteCommunityPluginCatalogEntryV1[] = [];
  for (const rawEntry of value.entries) {
    const entry = await readEntry(rawEntry);
    if (!entry) return null;
    entries.push(entry);
  }
  entries.sort((left, right) => compareText(left.pluginId, right.pluginId));
  if (new Set(entries.map((entry) => entry.pluginId)).size !== entries.length) {
    return null;
  }
  if (await digest(entries) !== value.sourceDigest) return null;
  return {
    version: 1,
    scope: { ...value.scope },
    complete: true,
    stale: value.stale,
    revision: value.revision,
    observedAt: value.observedAt,
    sourceDigest: value.sourceDigest,
    entries,
    ...(value.lastRefreshFailedAt !== undefined
      ? { lastRefreshFailedAt: value.lastRefreshFailedAt }
      : {}),
  };
}

export function markRemoteCommunityPluginCatalogStale(
  catalog: Readonly<RemoteCommunityPluginCatalogV1>,
  failedAt: number,
): RemoteCommunityPluginCatalogV1 {
  assertTimestamp(failedAt, "lastRefreshFailedAt");
  return {
    ...structuredClone(catalog),
    stale: true,
    lastRefreshFailedAt: failedAt,
  };
}

/** Consecutive refresh failures required before a previously trusted catalog
 *  is downgraded to stale. A single transient failure stays re-observable and
 *  keeps the last trusted inventory usable instead of blocking the UI. */
export const COMMUNITY_PLUGIN_CATALOG_STALE_FAILURE_THRESHOLD = 2;

export function shouldMarkCommunityPluginCatalogStale(
  previous: Readonly<RemoteCommunityPluginCatalogV1> | null,
  consecutiveRefreshFailures: number,
): boolean {
  if (!previous) return true;
  if (previous.stale) return true;
  return consecutiveRefreshFailures >= COMMUNITY_PLUGIN_CATALOG_STALE_FAILURE_THRESHOLD;
}

export function remoteCommunityPluginCatalogEntries(
  catalog: Readonly<RemoteCommunityPluginCatalogV1>,
): RemoteFileEntry[] {
  return catalog.entries.flatMap((entry) =>
    entry.members.map(toRemoteFileEntry)
  ).sort((left, right) => compareText(left.path, right.path));
}

/** One plugin's managed members as sync evidence entries — the deletion
 *  authorization input for that plugin's cloud cleanup transaction. */
export function remoteCommunityPluginCatalogEntryEntries(
  entry: Readonly<RemoteCommunityPluginCatalogEntryV1>,
): RemoteFileEntry[] {
  return entry.members.map(toRemoteFileEntry).sort((left, right) =>
    compareText(left.path, right.path)
  );
}

/**
 * Merge a freshly built catalog over the previously trusted one so entries
 * never regress. The committed-index build only sees folders this device
 * anchors (joined plugins), while the delta-fresh catalog also sees
 * unanchored cloud bundles (plugins other devices uploaded but this device
 * has not joined). Overwriting the delta-fresh catalog with the narrower
 * index build every round makes rows flicker away and silently blinds
 * discovery; keeping the superset makes the round-end update monotonic:
 * index facts win per plugin (fresh eTags/versions), entries the index no
 * longer sees survive until the next real delta refresh, and entries only
 * the index knows (fresh join targets) enter immediately.
 */
export async function mergeRemoteCommunityPluginCatalogKeepingSuperset(
  previous: Readonly<RemoteCommunityPluginCatalogV1> | null,
  next: Readonly<RemoteCommunityPluginCatalogV1>,
): Promise<RemoteCommunityPluginCatalogV1> {
  if (!previous || !sameSyncScope(previous.scope, next.scope)) return next;
  const previousById = new Map(
    previous.entries.map((entry) => [entry.pluginId, entry]),
  );
  const nextById = new Map(
    next.entries.map((entry) => [entry.pluginId, entry]),
  );
  let changed = false;
  for (const [pluginId, entry] of previousById) {
    if (!nextById.has(pluginId)) {
      nextById.set(pluginId, entry);
      changed = true;
    }
  }
  if (!changed) return next;
  const entries = [...nextById.values()].sort((left, right) =>
    compareText(left.pluginId, right.pluginId)
  );
  const sourceDigest = await digest(entries);
  return {
    version: 1,
    scope: { ...next.scope },
    complete: true,
    stale: false,
    revision: Math.max(previous.revision, next.revision) + 1,
    observedAt: next.observedAt,
    sourceDigest,
    entries,
  };
}

async function readEntry(
  value: unknown,
): Promise<RemoteCommunityPluginCatalogEntryV1 | null> {
  if (!isRecord(value)
    || typeof value.pluginId !== "string"
    || !SAFE_PLUGIN_ID.test(value.pluginId)
    || (value.bundleState !== "complete" && value.bundleState !== "partial")
    || typeof value.bundleDigest !== "string"
    || !SHA256_PATTERN.test(value.bundleDigest)
    || !Array.isArray(value.members)
    || (value.manifestName !== undefined
      && (typeof value.manifestName !== "string" || !value.manifestName.trim()))
    || !hasOnlyKeys(value, [
      "pluginId",
      "bundleState",
      "bundleDigest",
      "members",
      "manifestName",
    ])) {
    return null;
  }
  const members: RemoteCommunityPluginCatalogMemberV1[] = [];
  for (const rawMember of value.members) {
    const member = readMember(rawMember, value.pluginId);
    if (!member) return null;
    members.push(member);
  }
  members.sort(compareMember);
  const names = new Set(members.map((member) => member.path.slice(
    member.path.lastIndexOf("/") + 1,
  )));
  const bundleState = names.has("main.js") && names.has("manifest.json")
    ? "complete"
    : "partial";
  if (bundleState !== value.bundleState || await digest(members) !== value.bundleDigest) {
    return null;
  }
  return {
    pluginId: value.pluginId,
    bundleState,
    bundleDigest: value.bundleDigest,
    members,
    ...(value.manifestName !== undefined
      ? { manifestName: value.manifestName.trim() }
      : {}),
  };
}

function readMember(
  value: unknown,
  pluginId: string,
): RemoteCommunityPluginCatalogMemberV1 | null {
  const prefix = `/plugins/${pluginId}/`;
  if (!isRecord(value)
    || typeof value.path !== "string"
    || !value.path.includes(prefix)
    || !["main.js", "manifest.json", "styles.css"].includes(
      value.path.slice(value.path.lastIndexOf("/") + 1),
    )
    || !isNonEmptyString(value.remoteId)
    || !isNonEmptyString(value.parentId)
    || typeof value.size !== "number"
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || typeof value.mtime !== "number"
    || !Number.isFinite(value.mtime)
    || typeof value.eTag !== "string"
    || typeof value.cTag !== "string"
    || (!value.eTag && !value.cTag)
    || !isOptionalHash(value.sha256Hash, true)
    || !isOptionalHash(value.quickXorHash, false)
    || !hasOnlyKeys(value, [
      "path",
      "remoteId",
      "parentId",
      "size",
      "mtime",
      "eTag",
      "cTag",
      "sha256Hash",
      "quickXorHash",
    ])) {
    return null;
  }
  return {
    path: value.path,
    remoteId: value.remoteId,
    parentId: value.parentId,
    size: value.size,
    mtime: value.mtime,
    eTag: value.eTag,
    cTag: value.cTag,
    sha256Hash: value.sha256Hash,
    quickXorHash: value.quickXorHash,
  };
}

function matchingManifestName(
  observations: readonly CommunityPluginManifestObservationV1[],
  scope: Readonly<SyncScope>,
  pluginId: string,
  remote: Readonly<RemoteFileEntry>,
): string | null {
  const observation = observations.find((candidate) =>
    candidate.pluginId === pluginId
    && communityPluginManifestObservationMatchesRemote(
      candidate,
      scope,
      remote,
    )
  );
  if (!observation) return null;
  return parseCommunityPluginBundleManifest(
    observation.manifestText,
    pluginId,
  ).name;
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

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return sha256Hex(bytes.buffer);
}

function compareMember(
  left: Readonly<RemoteCommunityPluginCatalogMemberV1>,
  right: Readonly<RemoteCommunityPluginCatalogMemberV1>,
): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalHash(value: unknown, sha256: boolean): value is string | null {
  if (value === null) return true;
  return typeof value === "string"
    && value.length > 0
    && (!sha256 || SHA256_PATTERN.test(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOptionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || isTimestamp(value);
}

function assertTimestamp(value: unknown, field: string): asserts value is number {
  if (!isTimestamp(value)) throw new Error(`Remote plugin catalog ${field} is invalid`);
}
