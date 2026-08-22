import { sha256Hex } from "../crypto";
import type { DriveItem } from "../onedrive/types";
import {
  communityPluginManifestObservationMatchesRemote,
  parseCommunityPluginBundleManifest,
  parseCommunityPluginBundlePath,
  readCommunityPluginManifestObservations,
  type CommunityPluginManifestObservationV1,
} from "./community-plugin-bundle";
import { buildRemoteIndexV2 } from "./remote-index-v2";
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
  const membersByPluginId = new Map<
    string,
    RemoteCommunityPluginCatalogMemberV1[]
  >();
  for (const node of Object.values(projection.index.itemsById)) {
    if (node.kind !== "file") continue;
    const path = projection.pathById.get(node.id);
    if (!path) throw new Error(`Remote plugin catalog path is missing: ${node.id}`);
    const managed = parseCommunityPluginBundlePath(path, input.configDir);
    if (!managed || managed.pluginId === ownPluginId) continue;
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
  return sha256Hex(bytes.buffer as ArrayBuffer);
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
