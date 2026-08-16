import { sha256Hex } from "../crypto";
import {
  isSyncScope,
  sameSyncScope,
  type RemoteFileEntry,
  type SyncScope,
} from "./types";

export type CommunityPluginBundleFileName =
  | "main.js"
  | "manifest.json"
  | "styles.css";

export interface CommunityPluginBundlePath {
  pluginId: string;
  fileName: CommunityPluginBundleFileName;
}

export interface CommunityPluginBundleManifest {
  id: string;
  /** User-facing name from manifest.json, or null when it is unavailable. */
  name: string | null;
  version: string;
  minAppVersion: string | null;
  isDesktopOnly: boolean;
}

export type CommunityPluginManifestIncompatibility =
  | "downgrade"
  | "desktop-only"
  | "minimum-app-version";

export interface CommunityPluginManifestObservationSourceV1 {
  path: string;
  remoteId: string;
  eTag: string;
  cTag: string;
  size: number;
  sha256Hash: string | null;
  quickXorHash: string | null;
  contentHash: string;
}

/**
 * Disposable, device-local evidence that a particular remote manifest version
 * was downloaded, hash-verified, and parsed. It is not sync policy or cloud
 * authority: any malformed or source-mismatched record is discarded.
 */
export interface CommunityPluginManifestObservationV1 {
  version: 1;
  scope: SyncScope;
  pluginId: string;
  source: CommunityPluginManifestObservationSourceV1;
  manifestText: string;
}

const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BUNDLE_FILES = new Set<CommunityPluginBundleFileName>([
  "main.js",
  "manifest.json",
  "styles.css",
]);

export function parseCommunityPluginBundlePath(
  path: string,
  configDir: string,
): CommunityPluginBundlePath | null {
  const prefix = `${configDir.replace(/\/+$/, "")}/plugins/`;
  if (!path.startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split("/");
  if (parts.length !== 2) return null;
  const [pluginId, fileName] = parts;
  if (
    !SAFE_PLUGIN_ID.test(pluginId)
    || !BUNDLE_FILES.has(fileName as CommunityPluginBundleFileName)
  ) return null;
  return {
    pluginId,
    fileName: fileName as CommunityPluginBundleFileName,
  };
}

export function parseCommunityPluginBundleManifest(
  text: string,
  directoryId: string,
): CommunityPluginBundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Selected plugin manifest is unreadable: ${directoryId}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Selected plugin manifest is unreadable: ${directoryId}`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (
    typeof manifest.id !== "string"
    || !SAFE_PLUGIN_ID.test(manifest.id)
  ) {
    throw new Error(`Selected plugin manifest identity is invalid: ${directoryId}`);
  }
  if (
    typeof manifest.version !== "string"
    || manifest.version.trim().length === 0
  ) {
    throw new Error(`Selected plugin manifest version is missing or invalid: ${directoryId}`);
  }
  if (
    manifest.minAppVersion !== undefined
    && typeof manifest.minAppVersion !== "string"
  ) {
    throw new Error(`Selected plugin minimum app version is invalid: ${directoryId}`);
  }
  return {
    id: manifest.id,
    name: typeof manifest.name === "string"
      ? manifest.name.trim() || null
      : null,
    version: manifest.version.trim(),
    minAppVersion: typeof manifest.minAppVersion === "string"
      ? manifest.minAppVersion.trim() || null
      : null,
    isDesktopOnly: manifest.isDesktopOnly === true,
  };
}

/**
 * A physical plugin directory may be an official distribution alias for the
 * logical manifest id. The alias is safe only while every observed copy under
 * that directory describes the same logical plugin.
 */
export function assertCommunityPluginManifestIdentityStable(
  directoryId: string,
  manifests: readonly Readonly<CommunityPluginBundleManifest>[],
): void {
  const manifestIds = [...new Set(manifests.map((manifest) => manifest.id))];
  if (manifestIds.length > 1) {
    throw new Error(
      `Selected plugin manifest identity changed within directory: ${directoryId}`,
    );
  }
}

/**
 * Two selected physical directories must never control the same logical
 * plugin id. Callers can block only the affected bundles without guessing
 * which directory is authoritative.
 */
export function findCommunityPluginManifestIdentityCollisions(
  identities: readonly Readonly<{
    directoryId: string;
    manifestId: string;
  }>[],
): Set<string> {
  const directoriesByManifestId = new Map<string, Set<string>>();
  for (const identity of identities) {
    const directories = directoriesByManifestId.get(identity.manifestId)
      ?? new Set<string>();
    directories.add(identity.directoryId);
    directoriesByManifestId.set(identity.manifestId, directories);
  }
  const collisions = new Set<string>();
  for (const directories of directoriesByManifestId.values()) {
    if (directories.size < 2) continue;
    for (const directoryId of directories) collisions.add(directoryId);
  }
  return collisions;
}

function optionalHash(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

export function communityPluginManifestRemoteSourceKey(
  scope: Readonly<SyncScope>,
  remote: Readonly<RemoteFileEntry>,
): string {
  return [
    scope.accountId,
    scope.driveId,
    scope.vaultFolderId,
    scope.filesRootId,
    remote.path,
    remote.driveId,
    remote.eTag,
    remote.cTag,
    remote.size,
    remote.sha256Hash ?? "",
    remote.quickXorHash ?? "",
  ].join("\u0000");
}

export function communityPluginManifestObservationMatchesRemote(
  observation: Readonly<CommunityPluginManifestObservationV1>,
  scope: Readonly<SyncScope>,
  remote: Readonly<RemoteFileEntry>,
): boolean {
  return sameSyncScope(observation.scope, scope)
    && communityPluginManifestRemoteSourceKey(observation.scope, {
      path: observation.source.path,
      driveId: observation.source.remoteId,
      eTag: observation.source.eTag,
      cTag: observation.source.cTag,
      size: observation.source.size,
      mtime: remote.mtime,
      sha256Hash: observation.source.sha256Hash ?? undefined,
      quickXorHash: observation.source.quickXorHash ?? undefined,
    }) === communityPluginManifestRemoteSourceKey(scope, remote);
}

export async function createCommunityPluginManifestObservation(
  scope: Readonly<SyncScope>,
  pluginId: string,
  remote: Readonly<RemoteFileEntry>,
  content: ArrayBuffer,
): Promise<CommunityPluginManifestObservationV1> {
  const manifestText = new TextDecoder().decode(content);
  parseCommunityPluginBundleManifest(manifestText, pluginId);
  const canonicalBytes = new TextEncoder().encode(manifestText);
  const contentHash = await sha256Hex(content);
  if (
    canonicalBytes.byteLength !== content.byteLength
    || await sha256Hex(canonicalBytes.buffer) !== contentHash
  ) {
    throw new Error(`Selected plugin manifest is not canonical UTF-8: ${pluginId}`);
  }
  return {
    version: 1,
    scope: { ...scope },
    pluginId,
    source: {
      path: remote.path,
      remoteId: remote.driveId,
      eTag: remote.eTag,
      cTag: remote.cTag,
      size: remote.size,
      sha256Hash: remote.sha256Hash ?? null,
      quickXorHash: remote.quickXorHash ?? null,
      contentHash,
    },
    manifestText,
  };
}

export async function readCommunityPluginManifestObservation(
  value: unknown,
): Promise<CommunityPluginManifestObservationV1 | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sourceValue = record.source;
  if (
    record.version !== 1
    || !isSyncScope(record.scope)
    || typeof record.pluginId !== "string"
    || !SAFE_PLUGIN_ID.test(record.pluginId)
    || typeof record.manifestText !== "string"
    || !sourceValue
    || typeof sourceValue !== "object"
    || Array.isArray(sourceValue)
  ) {
    return null;
  }
  const source = sourceValue as Record<string, unknown>;
  const sha256Hash = optionalHash(source.sha256Hash);
  const quickXorHash = optionalHash(source.quickXorHash);
  if (
    typeof source.path !== "string"
    || !source.path.endsWith(`/plugins/${record.pluginId}/manifest.json`)
    || typeof source.remoteId !== "string"
    || source.remoteId.length === 0
    || typeof source.eTag !== "string"
    || source.eTag.length === 0
    || typeof source.cTag !== "string"
    || !Number.isSafeInteger(source.size)
    || Number(source.size) < 0
    || sha256Hash === undefined
    || quickXorHash === undefined
    || (sha256Hash !== null && !SHA256_HEX.test(sha256Hash.toLowerCase()))
    || typeof source.contentHash !== "string"
    || !SHA256_HEX.test(source.contentHash)
  ) {
    return null;
  }
  try {
    parseCommunityPluginBundleManifest(record.manifestText, record.pluginId);
    const content = new TextEncoder().encode(record.manifestText);
    if (content.byteLength !== Number(source.size)) return null;
    const contentHash = await sha256Hex(content.buffer);
    if (contentHash !== source.contentHash) return null;
    if (sha256Hash && sha256Hash.toLowerCase() !== contentHash) return null;
  } catch {
    return null;
  }
  return {
    version: 1,
    scope: { ...record.scope },
    pluginId: record.pluginId,
    source: {
      path: source.path,
      remoteId: source.remoteId,
      eTag: source.eTag,
      cTag: source.cTag,
      size: Number(source.size),
      sha256Hash,
      quickXorHash,
      contentHash: source.contentHash,
    },
    manifestText: record.manifestText,
  };
}

export async function readCommunityPluginManifestObservations(
  value: unknown,
): Promise<CommunityPluginManifestObservationV1[]> {
  if (!Array.isArray(value)) return [];
  const observations = await Promise.all(
    value.map((item) => readCommunityPluginManifestObservation(item)),
  );
  return observations.filter(
    (item): item is CommunityPluginManifestObservationV1 => item !== null,
  );
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return a === b ? 0 : a === undefined ? -1 : 1;
    }
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Compare semantic plugin versions. Returns null when either version is invalid. */
export function compareCommunityPluginVersions(
  left: string,
  right: string,
): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function assessCommunityPluginManifestCompatibility(
  manifest: CommunityPluginBundleManifest,
  options: {
    localVersion: string | null;
    isMobile: boolean;
    apiVersionSupported: boolean;
  },
): CommunityPluginManifestIncompatibility | null {
  if (options.localVersion) {
    const comparison = compareCommunityPluginVersions(
      manifest.version,
      options.localVersion,
    );
    if (comparison !== null && comparison < 0) return "downgrade";
  }
  if (options.isMobile && manifest.isDesktopOnly) return "desktop-only";
  if (manifest.minAppVersion && !options.apiVersionSupported) {
    return "minimum-app-version";
  }
  return null;
}
