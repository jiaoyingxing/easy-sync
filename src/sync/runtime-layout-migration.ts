import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";
import type { EasySyncPathSet } from "../obsidian-compat";

/**
 * The runtime layout migration is deliberately local-only.  It moves only
 * EasySync's known sidecars; it never changes Vault files or cloud state.
 */
export const EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD = 3 as const;
export const EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY =
  "easy-sync-runtime-layout-v2";

export interface EasySyncLayoutMigrationStorage {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

interface EasySyncLayoutMigrationResult {
  migrated: string[];
  legacyFiles: string[];
  conflicts: string[];
}

export class EasySyncRuntimeLayoutMigrationConflict extends Error {
  readonly sourcePath: string;
  readonly targetPath: string;

  constructor(sourcePath: string, targetPath: string) {
    super(`EasySync runtime layout migration conflict: ${sourcePath} ↔ ${targetPath}`);
    this.name = "EasySyncRuntimeLayoutMigrationConflict";
    this.sourcePath = sourcePath;
    this.targetPath = targetPath;
  }
}

/**
 * Narrow an unknown failure to a runtime-layout conflict. Only a genuine
 * authoritative-sidecar disagreement is a conflict: every other error must
 * keep propagating, so a caller never reports a layout problem for what is
 * actually an I/O or adapter failure.
 */
export function toLayoutMigrationConflict(
  error: unknown,
): EasySyncRuntimeLayoutMigrationConflict | null {
  return error instanceof EasySyncRuntimeLayoutMigrationConflict ? error : null;
}

interface LayoutMigrationMarker {
  version: 1;
  stableSyncs: number;
  completed?: boolean;
}

/** Separator-only normalization (backslashes, duplicate and trailing slashes);
 *  it deliberately does not touch Unicode form or case. */
function normalizeLayoutPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function relativeToPlugin(path: string, pluginDir: string): string | null {
  const prefix = `${normalizeLayoutPath(pluginDir)}/`;
  const normalized = normalizeLayoutPath(path);
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
}

function join(pluginDir: string, relative: string): string {
  return `${normalizeLayoutPath(pluginDir)}/${relative}`;
}

/** A path-valued key of the registry (excludes the version/counter fields). */
type EasySyncSidecarKey = {
  [K in keyof EasySyncPathSet]: EasySyncPathSet[K] extends string ? K : never;
}[keyof EasySyncPathSet];

/**
 * Sidecar keys the layout migration moves one-to-one, keyed by the shared path
 * registry so a key can never be spelled twice. Exported together with the two
 * prefix groups: the completeness gate (tests/easy-sync-storage-layout.test.ts)
 * proves every registered sidecar is either listed here or spells the same path
 * in both layouts, so a newly added sidecar cannot be forgotten silently.
 */
/** Direct sidecars the migration probes for explicitly (a superset probe of the
 *  tree walk below, which is only entered when the legacy plugin existed). */
export const EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS = [
  "remoteStateFile",
  "stateV2File",
  "stateV2NextFile",
  "stateV2PreviousFile",
  "stateV2RecoveryFile",
  "stateV2ManifestFile",
  "stateV2ManifestNextFile",
  "stateV2AuthorityWitnessFile",
  "stateV2AuthorityWitnessNextFile",
  "stateV2RetiredManifestFile",
  "stateV2RollbackFile",
  "stateV2MigrationHoldFile",
  "stateV2MigrationHoldNextFile",
  "stateV2ScopeTransitionFile",
  "stateV2ScopeTransitionNextFile",
  "stateV2CorruptRecoveryFile",
  "stateV2CorruptRecoveryNextFile",
  "stateV2CorruptPublicationFile",
  "stateV2CorruptPublicationNextFile",
  "stateV1BackupFile",
  "baseContentFile",
  "ancestorManifestV2File",
  "ancestorManifestV2NextFile",
  "scanCacheFile",
  "remoteEnumCheckpointFile",
] as const satisfies ReadonlyArray<EasySyncSidecarKey>;

/** Prefix entries that moved from the plugin root into the state tree. */
export const EASY_SYNC_LAYOUT_ROOT_PREFIX_MIGRATION_KEYS = [
  "stateV2CorruptSourcePrefix",
  "stateV2ReactivationArchivePrefix",
] as const satisfies ReadonlyArray<EasySyncSidecarKey>;

/** Directory prefixes that kept their shape but moved under another parent. */
export const EASY_SYNC_LAYOUT_NESTED_PREFIX_MIGRATION_KEYS = [
  "stateV2IndexedDbRecoveryDir",
  "ancestorsV2Dir",
  "tmpDir",
] as const satisfies ReadonlyArray<EasySyncSidecarKey>;

/**
 * Sidecars that are rebuilt from other state (or kept only as evidence). Once
 * the current tree has advanced past them a byte mismatch between the two
 * copies is expected, so the migration skips them instead of blocking the whole
 * layout change on a stale cache. Everything else is an authoritative sidecar
 * and does block.
 */
export const EASY_SYNC_LAYOUT_DISCARDABLE_SIDECAR_KEYS = [
  "scanCacheFile",
  "remoteEnumCheckpointFile",
  "stateV1BackupFile",
  "stateV2CorruptRecoveryFile",
  "stateV2CorruptRecoveryNextFile",
  "stateV2CorruptPublicationFile",
  "stateV2CorruptPublicationNextFile",
] as const satisfies ReadonlyArray<EasySyncSidecarKey>;

/**
 * Cheapest probe for "a legacy install existed here": a handful of primary
 * sidecars rather than the whole table. The enumeration checkpoint is in the
 * list because a downgraded run can leave it as the *only* legacy artefact —
 * and an undiscovered legacy file is never copied away, which would keep the
 * old tree (and its directory shells) alive forever.
 */
export const EASY_SYNC_LAYOUT_PROBE_SENTINEL_KEYS = [
  "remoteStateFile",
  "stateV2File",
  "stateV2ManifestFile",
  "stateV1BackupFile",
  "baseContentFile",
  "ancestorManifestV2File",
  "scanCacheFile",
  "remoteEnumCheckpointFile",
] as const satisfies ReadonlyArray<EasySyncSidecarKey>;

function mapLegacyRelativePath(
  relative: string,
  legacy: EasySyncPathSet,
  current: EasySyncPathSet,
): string | null {
  const normalized = normalizeLayoutPath(relative);
  const legacyRoot = legacy.pluginDir;
  const currentRoot = current.pluginDir;
  const directPairs: Array<[string, string]> =
    EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS.map((key) => [
      legacy[key],
      current[key],
    ]);
  for (const [source, target] of directPairs) {
    if (normalized === relativeToPlugin(source, legacyRoot)) {
      return relativeToPlugin(target, currentRoot);
    }
  }

  // The caller hands in a path relative to the legacy plugin directory, so the
  // key-derived prefixes must be reduced the same way as the direct pairs.
  const legacyRelative = (key: EasySyncSidecarKey): string =>
    relativeToPlugin(legacy[key], legacyRoot) ?? legacy[key];
  const currentRelative = (target: string) => target.slice(`${currentRoot}/`.length);
  const rootPrefixPairs: Array<[string, string]> =
    EASY_SYNC_LAYOUT_ROOT_PREFIX_MIGRATION_KEYS.map((key) => [
      legacyRelative(key),
      currentRelative(current[key]),
    ]);
  for (const [sourcePrefix, targetPrefix] of rootPrefixPairs) {
    if (normalized.startsWith(sourcePrefix)) {
      // Both sides are plugin-relative here: the target prefix is the new
      // spelling of the same relative shape (the old code stripped the plugin
      // directory a second time, which turned the target into a fragment).
      return targetPrefix + normalized.slice(sourcePrefix.length);
    }
  }
  const nestedPrefixPairs: Array<[string, string]> =
    EASY_SYNC_LAYOUT_NESTED_PREFIX_MIGRATION_KEYS.map((key) => [
      `${legacyRelative(key)}/`,
      `${currentRelative(current[key])}/`,
    ]);
  for (const [sourcePrefix, targetPrefix] of nestedPrefixPairs) {
    if (normalized.startsWith(sourcePrefix)) {
      return targetPrefix + normalized.slice(sourcePrefix.length);
    }
  }
  return null;
}

async function collectFiles(
  adapter: DataAdapter,
  directory: string,
  output: string[],
): Promise<void> {
  try {
    const listed = await adapter.list(directory);
    if (!listed || !Array.isArray(listed.files) || !Array.isArray(listed.folders)) {
      return;
    }
    output.push(...listed.files.map(normalizeLayoutPath));
    for (const folder of listed.folders) {
      await collectFiles(adapter, normalizeLayoutPath(folder), output);
    }
  } catch {
    return;
  }
}

async function pruneEmptyDirectoryTree(
  adapter: DataAdapter,
  directory: string,
): Promise<boolean> {
  const root = normalizeLayoutPath(directory);
  let listed: { files: string[]; folders: string[] };
  try {
    listed = await adapter.list(root);
    if (!Array.isArray(listed.files) || !Array.isArray(listed.folders)) {
      return false;
    }
  } catch {
    return false;
  }

  let removedAny = false;
  for (const folder of listed.folders.map(normalizeLayoutPath)) {
    if (!folder.startsWith(`${root}/`)) continue;
    removedAny = await pruneEmptyDirectoryTree(adapter, folder) || removedAny;
  }

  try {
    listed = await adapter.list(root);
    if (!Array.isArray(listed.files) || !Array.isArray(listed.folders)) {
      return removedAny;
    }
    if (listed.files.length > 0 || listed.folders.length > 0) {
      return removedAny;
    }
    await adapter.rmdir(root, false);
    return true;
  } catch {
    return removedAny;
  }
}

async function pruneEmptyLegacyRuntimeDirectories(
  adapter: DataAdapter,
  legacy: EasySyncPathSet,
): Promise<boolean> {
  let removedAny = false;
  for (const directory of [
    legacy.ancestorsV2Dir,
    legacy.stateV2IndexedDbRecoveryDir,
    legacy.tmpDir,
  ]) {
    try {
      if (await adapter.exists(directory)) {
        removedAny = await pruneEmptyDirectoryTree(adapter, directory) || removedAny;
      }
    } catch {
      // Empty directory cleanup is best effort and must never affect sync.
    }
  }
  return removedAny;
}

async function readBytes(adapter: DataAdapter, path: string): Promise<ArrayBuffer> {
  const candidate = adapter as unknown as {
    readBinary?: (path: string) => Promise<ArrayBuffer>;
  };
  if (typeof candidate.readBinary === "function") {
    return candidate.readBinary(path);
  }
  return new TextEncoder().encode(await adapter.read(path)).buffer;
}

async function writeBytes(
  adapter: DataAdapter,
  path: string,
  bytes: ArrayBuffer,
): Promise<void> {
  const candidate = adapter as unknown as {
    writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
  };
  if (typeof candidate.writeBinary === "function") {
    await candidate.writeBinary(path, bytes);
    return;
  }
  await adapter.write(path, new TextDecoder().decode(bytes));
}

async function ensureDirectories(
  adapter: DataAdapter,
  directories: readonly string[],
  existingRoot: string,
): Promise<boolean> {
  const candidate = adapter as unknown as { mkdir?: (path: string) => Promise<void> };
  if (typeof candidate.mkdir !== "function") return false;
  const normalizedRoot = normalizeLayoutPath(existingRoot);
  const ordered = [...new Set(directories.map(normalizeLayoutPath))]
    .sort((left, right) => left.split("/").length - right.split("/").length);
  for (const directory of ordered) {
    if (!directory.startsWith(`${normalizedRoot}/`)) continue;
    const segments = directory.slice(normalizedRoot.length + 1).split("/");
    let current = normalizedRoot;
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!await adapter.exists(current)) await candidate.mkdir(current);
    }
  }
  return true;
}

function parentDirectory(path: string): string {
  const normalized = normalizeLayoutPath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

async function ensureCurrentLayoutDirectories(
  adapter: DataAdapter,
  current: EasySyncPathSet,
): Promise<void> {
  await ensureDirectories(adapter, [
    parentDirectory(current.remoteStateFile),
    parentDirectory(current.stateV2File),
    parentDirectory(current.ancestorManifestV2File),
    parentDirectory(current.scanCacheFile),
  ], current.pluginDir);
}

async function ensureParentDirectories(
  adapter: DataAdapter,
  path: string,
  pluginDir: string,
): Promise<boolean> {
  return ensureDirectories(adapter, [parentDirectory(path)], pluginDir);
}

async function sameBytes(adapter: DataAdapter, left: string, right: string): Promise<boolean> {
  const [leftBytes, rightBytes] = await Promise.all([
    readBytes(adapter, left),
    readBytes(adapter, right),
  ]);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return await sha256Hex(leftBytes) === await sha256Hex(rightBytes);
}

async function discoverLegacyFiles(
  adapter: DataAdapter,
  legacy: EasySyncPathSet,
): Promise<string[]> {
  const directCandidates = EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS
    .map((key) => legacy[key]);
  const files: string[] = [];
  const sentinels = EASY_SYNC_LAYOUT_PROBE_SENTINEL_KEYS
    .map((key) => legacy[key]);
  let legacyFileExists = false;
  for (const path of sentinels) {
    try {
      if (await adapter.exists(path)) {
        legacyFileExists = true;
        break;
      }
    } catch {
      // A transient existence failure is handled by the normal state loader.
    }
  }
  const directories = [
    legacy.stateV2IndexedDbRecoveryDir,
    legacy.ancestorsV2Dir,
    legacy.tmpDir,
  ];
  let legacyDirectoryExists = false;
  for (const directory of directories) {
    try {
      if (await adapter.exists(directory)) {
        legacyDirectoryExists = true;
        break;
      }
    } catch {
      // Keep probing the other known locations.
    }
  }
  if (legacyFileExists || legacyDirectoryExists) {
    for (const path of directCandidates) {
      try {
        if (await adapter.exists(path)) files.push(path);
      } catch {
        // Keep the source path available to the state fallback when probing fails.
      }
    }
    await collectFiles(adapter, legacy.pluginDir, files);
  }
  return [...new Set(files)].filter((path) => {
    const relative = relativeToPlugin(path, legacy.pluginDir);
    return relative !== null && mapLegacyRelativePath(relative, legacy, legacy) !== null;
  });
}

export async function ensureEasySyncRuntimeLayoutMigration(
  adapter: DataAdapter,
  current: EasySyncPathSet,
  legacy: EasySyncPathSet,
  storage?: EasySyncLayoutMigrationStorage,
): Promise<EasySyncLayoutMigrationResult> {
  // Directory provisioning belongs to the current layout contract rather than
  // the one-shot legacy copy. A fresh install has no source sidecars, and a
  // previously completed marker must still be able to repair missing folders.
  await ensureCurrentLayoutDirectories(adapter, current);
  const storedMarker = readStoredMarker(storage);
  // Once the first copy was fully verified, the current tree is the only
  // writer. Legacy files are retained solely for the short cleanup grace
  // period and must never be compared with, or copied back over, newer state.
  // Only a clean legacy tree ends that phase: while the marker is absent or
  // still incomplete, each run has to keep looking for newly appeared sidecars,
  // because an interrupted migration or a downgraded run writes the old layout
  // again and would otherwise strand them there for good. A `completed` marker
  // recorded an empty discovery, so this early return skips no such re-look.
  if (storedMarker?.completed === true) {
    return { migrated: [], legacyFiles: [], conflicts: [] };
  }
  const gracePeriod = storedMarker !== null;
  const sourceFiles = await discoverLegacyFiles(adapter, legacy);
  const migrated: string[] = [];
  const conflicts: string[] = [];
  for (const sourcePath of sourceFiles) {
    const relative = relativeToPlugin(sourcePath, legacy.pluginDir);
    if (!relative) continue;
    const targetRelative = mapLegacyRelativePath(relative, legacy, current);
    if (!targetRelative) continue;
    const targetPath = join(current.pluginDir, targetRelative);
    if (normalizeLayoutPath(sourcePath) === normalizeLayoutPath(targetPath)) continue;
    if (await adapter.exists(targetPath)) {
      // During the grace period the current tree already owns this sidecar and
      // the legacy copy is stale by contract, so comparing them would report a
      // conflict for every sidecar the current layout has advanced past.
      if (gracePeriod) continue;
      if (!await sameBytes(adapter, sourcePath, targetPath)) {
        conflicts.push(sourcePath);
        if (!isDiscardableLegacySidecar(relative, legacy)) {
          throw new EasySyncRuntimeLayoutMigrationConflict(sourcePath, targetPath);
        }
      }
      continue;
    }
    if (!await ensureParentDirectories(adapter, targetPath, current.pluginDir)) continue;
    const bytes = await readBytes(adapter, sourcePath);
    await writeBytes(adapter, targetPath, bytes);
    if (!await sameBytes(adapter, sourcePath, targetPath)) {
      conflicts.push(sourcePath);
      if (!isDiscardableLegacySidecar(relative, legacy)) {
        throw new EasySyncRuntimeLayoutMigrationConflict(sourcePath, targetPath);
      }
      continue;
    }
    migrated.push(sourcePath);
  }
  // A run during the grace period must carry the cleanup count forward: the
  // count is advanced once per healthy round and resetting it here (on every
  // load) would keep the legacy tree from ever reaching the retirement
  // threshold.
  writeMarker(storage, {
    version: 1,
    stableSyncs: gracePeriod ? (storedMarker?.stableSyncs ?? 0) : 0,
    completed: sourceFiles.length === 0,
  });
  return { migrated, legacyFiles: sourceFiles, conflicts };
}

/**
 * Whether a byte mismatch on this sidecar may be skipped instead of blocking.
 * The key list is the single source of truth (see
 * `EASY_SYNC_LAYOUT_DISCARDABLE_SIDECAR_KEYS`).
 */
function isDiscardableLegacySidecar(
  relative: string,
  legacy: EasySyncPathSet,
): boolean {
  const normalized = normalizeLayoutPath(relative);
  const discardable = EASY_SYNC_LAYOUT_DISCARDABLE_SIDECAR_KEYS
    .map((key) => legacy[key]);
  return discardable.some(
    (path) => relativeToPlugin(path, legacy.pluginDir) === normalized,
  );
}

function readStoredMarker(
  storage: EasySyncLayoutMigrationStorage | undefined,
): LayoutMigrationMarker | null {
  if (!storage) return null;
  try {
    const raw = storage.loadLocalStorage(EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY);
    if (raw && typeof raw === "object") {
      const marker = raw as Partial<LayoutMigrationMarker>;
      if (marker.version === 1 && Number.isSafeInteger(marker.stableSyncs)) {
        return {
          version: 1,
          stableSyncs: Math.max(0, marker.stableSyncs!),
          completed: marker.completed === true,
        };
      }
    }
  } catch {
    // Storage is optional; migration remains usable without cleanup tracking.
  }
  return null;
}

function readMarker(storage: EasySyncLayoutMigrationStorage | undefined): LayoutMigrationMarker {
  return readStoredMarker(storage) ?? { version: 1, stableSyncs: 0, completed: false };
}

function writeMarker(storage: EasySyncLayoutMigrationStorage | undefined, marker: LayoutMigrationMarker): void {
  try {
    storage?.saveLocalStorage(EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY, marker);
  } catch {
    // Cleanup is best effort and must never make a healthy sync fail.
  }
}

export async function noteHealthySyncAndCleanupEasySyncRuntimeLayout(
  adapter: DataAdapter,
  legacy: EasySyncPathSet,
  storage: EasySyncLayoutMigrationStorage | undefined,
): Promise<{ cleaned: boolean; stableSyncs: number; remaining: string[] }> {
  const storedMarker = readStoredMarker(storage);
  if (storedMarker?.completed) {
    const cleaned = await pruneEmptyLegacyRuntimeDirectories(adapter, legacy);
    return { cleaned, stableSyncs: 0, remaining: [] };
  }
  const sourceFiles = await discoverLegacyFiles(adapter, legacy);
  if (sourceFiles.length === 0) {
    const cleaned = await pruneEmptyLegacyRuntimeDirectories(adapter, legacy);
    writeMarker(storage, {
      version: 1,
      stableSyncs: EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD,
      completed: true,
    });
    return { cleaned, stableSyncs: 0, remaining: [] };
  }
  const marker = storedMarker ?? readMarker(storage);
  const nextStableSyncs = Math.min(
    EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD,
    marker.stableSyncs + 1,
  );
  if (!storage || nextStableSyncs < EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD) {
    writeMarker(storage, {
      version: 1,
      stableSyncs: nextStableSyncs,
      completed: false,
    });
    return { cleaned: false, stableSyncs: nextStableSyncs, remaining: sourceFiles };
  }

  try {
    for (const sourcePath of sourceFiles) await adapter.remove(sourcePath);
    const directoriesRemoved = await pruneEmptyLegacyRuntimeDirectories(adapter, legacy);
    const remaining = await discoverLegacyFiles(adapter, legacy);
    if (remaining.length > 0) {
      writeMarker(storage, {
        version: 1,
        stableSyncs: nextStableSyncs,
        completed: false,
      });
      return { cleaned: false, stableSyncs: nextStableSyncs, remaining };
    }
    writeMarker(storage, {
      version: 1,
      stableSyncs: nextStableSyncs,
      completed: true,
    });
    return {
      cleaned: sourceFiles.length > 0 || directoriesRemoved,
      stableSyncs: nextStableSyncs,
      remaining: [],
    };
  } catch {
    writeMarker(storage, {
      version: 1,
      stableSyncs: nextStableSyncs,
      completed: false,
    });
    return { cleaned: false, stableSyncs: nextStableSyncs, remaining: sourceFiles };
  }
}

/** Reset is an explicit local destructive action, so it clears both the
 * current and still-retained legacy sidecars without touching unknown files. */
export async function clearEasySyncLegacyRuntimeLayout(
  adapter: DataAdapter,
  legacy: EasySyncPathSet,
): Promise<void> {
  const files = await discoverLegacyFiles(adapter, legacy);
  for (const path of files) {
    try { await adapter.remove(path); } catch { /* best effort during reset */ }
  }
  await pruneEmptyLegacyRuntimeDirectories(adapter, legacy);
}
