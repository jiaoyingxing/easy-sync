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

export interface EasySyncLayoutMigrationResult {
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

interface LayoutMigrationMarker {
  version: 1;
  stableSyncs: number;
  completed?: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function relativeToPlugin(path: string, pluginDir: string): string | null {
  const prefix = `${normalizePath(pluginDir)}/`;
  const normalized = normalizePath(path);
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
}

function join(pluginDir: string, relative: string): string {
  return `${normalizePath(pluginDir)}/${relative}`;
}

function mapLegacyRelativePath(
  relative: string,
  legacy: EasySyncPathSet,
  current: EasySyncPathSet,
): string | null {
  const normalized = normalizePath(relative);
  const legacyRoot = legacy.pluginDir;
  const currentRoot = current.pluginDir;
  const directPairs: Array<[string, string]> = [
    [legacy.remoteStateFile, current.remoteStateFile],
    [legacy.stateV2File, current.stateV2File],
    [legacy.stateV2NextFile, current.stateV2NextFile],
    [legacy.stateV2PreviousFile, current.stateV2PreviousFile],
    [legacy.stateV2RecoveryFile, current.stateV2RecoveryFile],
    [legacy.stateV2ManifestFile, current.stateV2ManifestFile],
    [legacy.stateV2ManifestNextFile, current.stateV2ManifestNextFile],
    [legacy.stateV2AuthorityWitnessFile, current.stateV2AuthorityWitnessFile],
    [legacy.stateV2AuthorityWitnessNextFile, current.stateV2AuthorityWitnessNextFile],
    [legacy.stateV2RetiredManifestFile, current.stateV2RetiredManifestFile],
    [legacy.stateV2RollbackFile, current.stateV2RollbackFile],
    [legacy.stateV2MigrationHoldFile, current.stateV2MigrationHoldFile],
    [legacy.stateV2MigrationHoldNextFile, current.stateV2MigrationHoldNextFile],
    [legacy.stateV2ScopeTransitionFile, current.stateV2ScopeTransitionFile],
    [legacy.stateV2ScopeTransitionNextFile, current.stateV2ScopeTransitionNextFile],
    [legacy.stateV2CorruptRecoveryFile, current.stateV2CorruptRecoveryFile],
    [legacy.stateV2CorruptRecoveryNextFile, current.stateV2CorruptRecoveryNextFile],
    [legacy.stateV2CorruptPublicationFile, current.stateV2CorruptPublicationFile],
    [legacy.stateV2CorruptPublicationNextFile, current.stateV2CorruptPublicationNextFile],
    [legacy.stateV1BackupFile, current.stateV1BackupFile],
    [legacy.baseContentFile, current.baseContentFile],
    [legacy.ancestorManifestV2File, current.ancestorManifestV2File],
    [legacy.ancestorManifestV2NextFile, current.ancestorManifestV2NextFile],
    [legacy.scanCacheFile, current.scanCacheFile],
  ];
  for (const [source, target] of directPairs) {
    if (normalized === relativeToPlugin(source, legacyRoot)) {
      return relativeToPlugin(target, currentRoot);
    }
  }

  const currentRelative = (target: string) => target.slice(`${currentRoot}/`.length);
  const rootPrefixPairs: Array<[string, string]> = [
    ["state-v2.corrupt-source-", "state/v2/state-v2.corrupt-source-"],
    ["state-v2.reactivation-archive-", "state/v2/state-v2.reactivation-archive-"],
  ];
  for (const [sourcePrefix, targetPrefix] of rootPrefixPairs) {
    if (normalized.startsWith(sourcePrefix)) {
      return currentRelative(targetPrefix + normalized.slice(sourcePrefix.length));
    }
  }
  const nestedPrefixPairs: Array<[string, string]> = [
    ["state-v2-indexeddb-recovery/", "state/v2/indexeddb-recovery/"],
    ["ancestors-v2/", "objects/ancestors-v2/"],
    ["tmp/", "runtime/"],
  ];
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
    output.push(...listed.files.map(normalizePath));
    for (const folder of listed.folders) {
      await collectFiles(adapter, normalizePath(folder), output);
    }
  } catch {
    return;
  }
}

async function pruneEmptyDirectoryTree(
  adapter: DataAdapter,
  directory: string,
): Promise<boolean> {
  const root = normalizePath(directory);
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
  for (const folder of listed.folders.map(normalizePath)) {
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
  const normalizedRoot = normalizePath(existingRoot);
  const ordered = [...new Set(directories.map(normalizePath))]
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
  const normalized = normalizePath(path);
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
  const directCandidates = [
    legacy.remoteStateFile,
    legacy.stateV2File,
    legacy.stateV2NextFile,
    legacy.stateV2PreviousFile,
    legacy.stateV2RecoveryFile,
    legacy.stateV2ManifestFile,
    legacy.stateV2ManifestNextFile,
    legacy.stateV2AuthorityWitnessFile,
    legacy.stateV2AuthorityWitnessNextFile,
    legacy.stateV2RetiredManifestFile,
    legacy.stateV2RollbackFile,
    legacy.stateV2MigrationHoldFile,
    legacy.stateV2MigrationHoldNextFile,
    legacy.stateV2ScopeTransitionFile,
    legacy.stateV2ScopeTransitionNextFile,
    legacy.stateV2CorruptRecoveryFile,
    legacy.stateV2CorruptRecoveryNextFile,
    legacy.stateV2CorruptPublicationFile,
    legacy.stateV2CorruptPublicationNextFile,
    legacy.stateV1BackupFile,
    legacy.baseContentFile,
    legacy.ancestorManifestV2File,
    legacy.ancestorManifestV2NextFile,
    legacy.scanCacheFile,
  ];
  const files: string[] = [];
  const sentinels = [
    legacy.remoteStateFile,
    legacy.stateV2File,
    legacy.stateV2ManifestFile,
    legacy.stateV1BackupFile,
    legacy.baseContentFile,
    legacy.ancestorManifestV2File,
    legacy.scanCacheFile,
  ];
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
  // Once the first copy was fully verified, the current tree is the only
  // writer. Legacy files are retained solely for the short cleanup grace
  // period and must never be compared with, or copied back over, newer state.
  if (readStoredMarker(storage)) {
    return { migrated: [], legacyFiles: [], conflicts: [] };
  }
  const sourceFiles = await discoverLegacyFiles(adapter, legacy);
  const migrated: string[] = [];
  const conflicts: string[] = [];
  for (const sourcePath of sourceFiles) {
    const relative = relativeToPlugin(sourcePath, legacy.pluginDir);
    if (!relative) continue;
    const targetRelative = mapLegacyRelativePath(relative, legacy, current);
    if (!targetRelative) continue;
    const targetPath = join(current.pluginDir, targetRelative);
    if (normalizePath(sourcePath) === normalizePath(targetPath)) continue;
    if (await adapter.exists(targetPath)) {
      if (!await sameBytes(adapter, sourcePath, targetPath)) {
        conflicts.push(sourcePath);
        throw new EasySyncRuntimeLayoutMigrationConflict(sourcePath, targetPath);
      }
      continue;
    }
    if (!await ensureParentDirectories(adapter, targetPath, current.pluginDir)) continue;
    const bytes = await readBytes(adapter, sourcePath);
    await writeBytes(adapter, targetPath, bytes);
    if (!await sameBytes(adapter, sourcePath, targetPath)) {
      conflicts.push(sourcePath);
      throw new EasySyncRuntimeLayoutMigrationConflict(sourcePath, targetPath);
    }
    migrated.push(sourcePath);
  }
  writeMarker(storage, {
    version: 1,
    stableSyncs: 0,
    completed: sourceFiles.length === 0,
  });
  return { migrated, legacyFiles: sourceFiles, conflicts };
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
