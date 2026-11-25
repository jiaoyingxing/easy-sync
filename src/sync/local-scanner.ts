/**
 * LocalScanner — Vault file enumeration and snapshot building
 *
 * Uses Obsidian Vault API for cross-platform file access.
 * Generates LocalFileEntry snapshots with path, size, mtime, full SHA-256,
 * and an optional OneDrive-compatible QuickXor fingerprint from the same read.
 */

import { EASY_SYNC_RECOVERY_SUFFIX } from "./local-replacement-writer";
import { TFolder, type Vault } from "obsidian";
import { quickXorHashBase64, sha256Hex } from "../crypto";
import {
  compatSetTimeout,
  DEFAULT_CONFIG_DIR,
  getConfigDir,
  getEasySyncPaths,
  getEasySyncLegacyPaths,
  isEasySyncSelfSyncFilePath,
  isRecord,
  normalizeVaultPathKey,
} from "../obsidian-compat";
import {
  type LocalFileEntry,
  type LocalFolderEntry,
  type ScanConfig,
  DEFAULT_SCAN_CONFIG,
} from "./types";
import {
  isPluginDataSelected,
  isPluginSelected,
  normalizePluginScopeSelection,
  type PluginScopeSelection,
} from "./community-plugin-sync-policy";
import type { DiagnosticLogger } from "./diagnostic-logger";
const SCAN_CACHE_FORMAT = 2;
const SCAN_CACHE_LEGACY_FORMAT = 1;
/** Per-path prior-observation chain cap.
 *
 *  Nothing in production reads `pathHistory` today (only the public accessor
 *  and its tests); the chain is speculative evidence kept for a future
 *  identity/conflict use. Four entries keep the recent chain available while
 *  cutting the cache's dominant byte share, which every mid-scan checkpoint
 *  rewrites whole. Raise it only together with a real consumer.
 *  (2026-11-23 user decision; supersedes the 16-entry size of 2026-10-23 D1A,
 *  not its global caps or no-prune rule.) */
const SCAN_CACHE_HISTORY_LIMIT = 4;
/** Aggregate bounds across every path's history. The per-path cap alone
 *  cannot bound deleted/renamed paths, whose histories are kept by design. */
const SCAN_CACHE_HISTORY_GLOBAL_ENTRY_LIMIT = 20_000;
const SCAN_CACHE_HISTORY_GLOBAL_BYTE_LIMIT = 8 * 1024 * 1024;
/** Drain to this fraction of each global cap so one append at the hard limit
 *  does not trigger the full cross-path prune again on the next append. */
const SCAN_CACHE_HISTORY_GLOBAL_LOW_WATER = 0.9;
const SCAN_SLEEP_EVERY = 50;
/** Report scan progress at most every N examined files; the loop still yields
 *  to the UI on the existing 50-file cadence. */
const SCAN_PROGRESS_EVERY = 100;
/** Persist the entries hashed so far after this many newly hashed files, so a
 *  host freeze mid-scan costs at most this many files' work instead of all of
 *  it. Only entries are upserted; pruning stays exclusive to a completed scan
 *  (`DECISIONS` 2026-11-23.03 keeps `cachePrune` there). */
const SCAN_CACHE_CHECKPOINT_EVERY = 200;
/** Time-based companion to the file count: a vault dominated by a few huge
 *  media files may hash for minutes without reaching the count. The interval
 *  doubles after each checkpoint, so a long scan does not rewrite a large
 *  cache every few seconds; worst-case rework stays bounded by the cap. */
const SCAN_CACHE_CHECKPOINT_MIN_INTERVAL_MS = 5_000;
const SCAN_CACHE_CHECKPOINT_MAX_INTERVAL_MS = 60_000;

interface ScanCacheEntry {
  mtime: number;
  size: number;
  hash: string;
  quickXorHash?: string;
  binary: boolean;
}

/** One prior per-path scan observation (the local change history seed). */
interface ScanCacheHistoryEntry extends ScanCacheEntry {
  observedAt: number;
}

type ScanCache = {
  format: number;
  entries: Record<string, ScanCacheEntry>;
  histories: Record<string, ScanCacheHistoryEntry[]>;
};

/** Deterministic approximation of one history entry's persisted footprint. */
function scanCacheHistoryEntryBytes(entry: ScanCacheHistoryEntry): number {
  return JSON.stringify(entry).length;
}

/** Per-scan cost facts for the diagnostic run summary. Observation only: no
 *  decision reads these back, and they are not part of the scan cache. */
export interface LocalScanMetrics {
  /** In-scope files recorded (cache hits + fresh hashes). */
  files: number;
  /** Sum of those files' recorded sizes. */
  bytes: number;
  /** Entries served from the mtime+size cache without a content read. */
  cacheHits: number;
  /** Total wall time spent in `readBinary` across the walk. */
  readMs: number;
  /** Total wall time spent hashing (SHA-256 + QuickXor). */
  hashMs: number;
}

interface LocalScanResult {
  entries: LocalFileEntry[];
  /** Read-only folder topology. It does not authorize folder mutations. */
  folders: LocalFolderEntry[];
  /** Folder completeness is separate so V1 file sync stays unchanged in F0. */
  folderScanComplete: boolean;
  folderScanFailures: string[];
  skippedLarge: string[];
  failedPaths: string[];
  skippedCount: number;
  complete: boolean;
  /** True when the round's cancel signal interrupted the walk. An aborted
   *  scan is *not* an incomplete scan: it stops before anything is published,
   *  so callers must end the round as cancelled instead of reporting a scan
   *  failure (`result.scanIncomplete`) or reading a partial entry list. */
  aborted?: boolean;
  /** Orphaned `${target}.easy-sync-recovery` copies encountered during the
   *  scan (target-side download-replacement backups whose journal intent is
   *  already gone). They are excluded from sync; the executor clears them in
   *  the same round after the ordinary journal recovery already ran. */
  recoveryCopies: string[];
  /** Diagnostic cost facts for this walk; absent on snapshots from callers
   *  that do not build a full scan. */
  metrics?: LocalScanMetrics;
}
export type LocalFileInspection =
  | { status: "missing" }
  | { status: "present"; entry?: LocalFileEntry }
  | { status: "uncertain"; reason: "excluded" | "stat" | "too-large" | "read" };
/** Content-free probe for last-instant gates (`inspectFileStat`). Same status
 *  vocabulary as `LocalFileInspection` minus content facts, so an unreadable
 *  stat can still fail closed instead of being mistaken for a changed file. */
export type LocalFileStatInspection =
  | { status: "missing" }
  | { status: "present"; size: number; mtime: number }
  | { status: "uncertain"; reason: "excluded" | "stat" | "too-large" };
const COMMUNITY_PLUGIN_CODE_FILES = new Set([
  "main.js",
  "manifest.json",
  "styles.css",
]);

function normalizeVaultRelativePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** Normalize the persisted device-local folder scope.
 *  Invalid/root/config paths are ignored; parent folders subsume descendants. */
export function normalizeExcludedFolders(
  values: readonly unknown[],
  configDir = DEFAULT_CONFIG_DIR,
): string[] {
  const normalizedConfigDir = normalizeVaultRelativePath(configDir).toLowerCase();
  const unique = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const path = normalizeVaultRelativePath(value);
    if (!path || path === ".") continue;
    const segments = path.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) continue;
    const key = path.toLowerCase();
    if (
      normalizedConfigDir
      && (key === normalizedConfigDir || key.startsWith(`${normalizedConfigDir}/`))
    ) continue;
    if (!unique.has(key)) unique.set(key, path);
  }

  const byParentFirst = [...unique.values()].sort((left, right) =>
    left.split("/").length - right.split("/").length
    || left.length - right.length
    || left.localeCompare(right),
  );
  const collapsed: string[] = [];
  for (const path of byParentFirst) {
    const key = path.toLowerCase();
    if (collapsed.some((parent) => {
      const parentKey = parent.toLowerCase();
      return key === parentKey || key.startsWith(`${parentKey}/`);
    })) continue;
    collapsed.push(path);
  }
  return collapsed.sort((left, right) => left.localeCompare(right));
}

export function isPathExcludedByFolders(
  path: string,
  excludedFolders: readonly string[] | undefined,
): boolean {
  if (!excludedFolders?.length) return false;
  const normalizedPath = normalizeVaultRelativePath(path).toLowerCase();
  return excludedFolders.some((folder) => {
    const normalizedFolder = normalizeVaultRelativePath(folder).toLowerCase();
    return normalizedPath === normalizedFolder
      || normalizedPath.startsWith(`${normalizedFolder}/`);
  });
}

/** Case-folded copy of a path set, for identity comparisons only.
 *
 *  Host file systems treat case variants (`EasySync` vs `easysync`) as the
 *  same directory, so every "is this EasySync's own path" rule folds case too;
 *  actual reads and writes keep using the original set. A folder whose name
 *  differs beyond case is handled by the explicit `ownPluginDir` override. */
function pathKeySet(
  paths: ReturnType<typeof getEasySyncPaths>,
): ReturnType<typeof getEasySyncPaths> {
  return Object.fromEntries(
    Object.entries(paths).map(([key, value]) => [
      key,
      typeof value === "string" ? normalizeVaultPathKey(value) : value,
    ]),
  ) as ReturnType<typeof getEasySyncPaths>;
}

function isEasySyncInternalPathForPaths(
  path: string,
  paths: ReturnType<typeof getEasySyncPaths>,
): boolean {
  const pathKey = normalizeVaultPathKey(path);
  const keys = pathKeySet(paths);
  return pathKey.endsWith(EASY_SYNC_RECOVERY_SUFFIX)
    || pathKey === keys.dataFile
    || (
      pathKey.startsWith(`${keys.pluginDirPrefix}data.sync-conflict-`)
      && pathKey.endsWith(".json")
    )
    || pathKey === keys.remoteStateFile
    || pathKey === keys.stateV2File
    || pathKey === keys.stateV2NextFile
    || pathKey === keys.stateV2PreviousFile
    || pathKey === keys.stateV2RecoveryFile
    || pathKey === keys.stateV2ManifestFile
    || pathKey === keys.stateV2ManifestNextFile
    || pathKey === keys.stateV2AuthorityWitnessFile
    || pathKey === keys.stateV2AuthorityWitnessNextFile
    || pathKey === keys.stateV2IndexedDbRecoveryDir
    || pathKey.startsWith(`${keys.stateV2IndexedDbRecoveryDir}/`)
    || pathKey === keys.stateV2RetiredManifestFile
    || pathKey === keys.stateV2RollbackFile
    || pathKey === keys.stateV2MigrationHoldFile
    || pathKey === keys.stateV2MigrationHoldNextFile
    || pathKey === keys.stateV2ScopeTransitionFile
    || pathKey === keys.stateV2ScopeTransitionNextFile
    || (
      pathKey.startsWith(keys.stateV2CorruptSourcePrefix)
      && (pathKey.endsWith(".json") || pathKey.endsWith(".json.next"))
    )
    || pathKey === keys.stateV2CorruptRecoveryFile
    || pathKey === keys.stateV2CorruptRecoveryNextFile
    || pathKey === keys.stateV2CorruptPublicationFile
    || pathKey === keys.stateV2CorruptPublicationNextFile
    || (
      pathKey.startsWith(keys.stateV2ReactivationArchivePrefix)
      && (pathKey.endsWith(".json") || pathKey.endsWith(".json.next"))
    )
    || pathKey === keys.stateV1BackupFile
    || pathKey === keys.baseContentFile
    || pathKey === keys.deletionLedgerFile
    || pathKey === `${keys.deletionLedgerFile}.next`
    || pathKey === keys.ancestorManifestV2File
    || pathKey === keys.ancestorManifestV2NextFile
    || pathKey === keys.ancestorsV2Dir
    || pathKey.startsWith(`${keys.ancestorsV2Dir}/`)
    || pathKey === keys.scanCacheFile
    || pathKey === keys.logsDir
    || pathKey.startsWith(`${keys.logsDir}/`)
    || pathKey === keys.tmpDir
    || pathKey.startsWith(`${keys.tmpDir}/`);
}

export function isEasySyncInternalPath(
  path: string,
  configDir = DEFAULT_CONFIG_DIR,
  pluginId = "easy-sync",
): boolean {
  return isEasySyncInternalPathForPaths(
    path,
    getEasySyncPaths(configDir, pluginId),
  ) || isEasySyncInternalPathForPaths(
    path,
    getEasySyncLegacyPaths(configDir, pluginId),
  );
}

/** Heuristic binary detection: check for null bytes in the first 8KB */
function isBinary(content: ArrayBuffer): boolean {
  const bytes = new Uint8Array(content.slice(0, 8192));
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** File-name-level default exclusions that apply anywhere in the vault.
 *  Office owner/lock files (~$report.docx) exist only while the document is
 *  open and vanish on close, so syncing them produces upload/delete churn;
 *  .DS_Store / Thumbs.db / *.tmp are the same class of OS noise. Unlike
 *  excludePaths (full-path prefixes) these match the basename in every
 *  directory. Directories are intentionally not affected. */
const DEFAULT_EXCLUDED_FILE_BASENAMES = new Set([".ds_store", "thumbs.db"]);

function isDefaultExcludedFileName(fileName: string): boolean {
  const name = fileName.toLowerCase();
  if (name.startsWith("~$")) return true;
  if (name.endsWith(".tmp")) return true;
  return DEFAULT_EXCLUDED_FILE_BASENAMES.has(name);
}

/**
 * Per-config exclusion facts, built once and reused across every path in a
 * scan (and across `shouldSyncPath` calls between scans).
 *
 * `isExcluded` used to derive four path sets and re-normalize every excluded
 * folder for every file; on a large vault that is pure host CPU inside the
 * periodic background scan. These facts depend only on the config generation
 * and the vault's config dir, so one build per `setConfig` is equivalent.
 */
interface ScanExclusionIndex {
  paths: ReturnType<typeof getEasySyncPaths>;
  pluginId: string;
  /** Case-folded identity of EasySync's own plugin directory. */
  ownPluginDirKey: string;
  ownPluginDirPrefixKey: string;
  /** Installed plugin folder as passed to the self-sync predicate. */
  ownPluginDir: string;
  internalExact: Set<string>;
  internalPrefixes: string[];
  internalPrefixSuffixes: Array<{
    prefix: string;
    suffixes: readonly string[];
  }>;
  internalDirectoryExact: Set<string>;
  internalDirectoryPrefixes: string[];
  excludedFoldersLower: string[];
  pluginCodeSelection: PluginScopeSelection;
  pluginDataSelection: PluginScopeSelection;
}

function buildScanExclusionIndex(
  config: ScanConfig,
  configDir: string,
  pluginId: string,
  ownPluginDir = getEasySyncPaths(configDir, pluginId).pluginDir,
): ScanExclusionIndex {
  const paths = getEasySyncPaths(configDir, pluginId);
  const legacyPaths = getEasySyncLegacyPaths(configDir, pluginId);
  const internalExact = new Set<string>();
  const internalPrefixes: string[] = [];
  const internalPrefixSuffixes: ScanExclusionIndex["internalPrefixSuffixes"] = [];
  const internalDirectoryExact = new Set<string>();
  const internalDirectoryPrefixes: string[] = [];
  const key = normalizeVaultPathKey;

  for (const candidate of [paths, legacyPaths]) {
    for (const exact of [
      candidate.dataFile,
      candidate.remoteStateFile,
      candidate.stateV2File,
      candidate.stateV2NextFile,
      candidate.stateV2PreviousFile,
      candidate.stateV2RecoveryFile,
      candidate.stateV2ManifestFile,
      candidate.stateV2ManifestNextFile,
      candidate.stateV2AuthorityWitnessFile,
      candidate.stateV2AuthorityWitnessNextFile,
      candidate.stateV2IndexedDbRecoveryDir,
      candidate.stateV2RetiredManifestFile,
      candidate.stateV2RollbackFile,
      candidate.stateV2MigrationHoldFile,
      candidate.stateV2MigrationHoldNextFile,
      candidate.stateV2ScopeTransitionFile,
      candidate.stateV2ScopeTransitionNextFile,
      candidate.stateV2CorruptRecoveryFile,
      candidate.stateV2CorruptRecoveryNextFile,
      candidate.stateV2CorruptPublicationFile,
      candidate.stateV2CorruptPublicationNextFile,
      candidate.stateV1BackupFile,
      candidate.baseContentFile,
      candidate.deletionLedgerFile,
      `${candidate.deletionLedgerFile}.next`,
      candidate.ancestorManifestV2File,
      candidate.ancestorManifestV2NextFile,
      candidate.ancestorsV2Dir,
      candidate.scanCacheFile,
      candidate.logsDir,
      candidate.tmpDir,
    ]) {
      internalExact.add(key(exact));
    }
    internalPrefixes.push(
      key(`${candidate.stateV2IndexedDbRecoveryDir}/`),
      key(`${candidate.ancestorsV2Dir}/`),
      key(`${candidate.logsDir}/`),
      key(`${candidate.tmpDir}/`),
    );
    internalPrefixSuffixes.push(
      {
        prefix: key(`${candidate.pluginDirPrefix}data.sync-conflict-`),
        suffixes: [".json"],
      },
      {
        prefix: key(candidate.stateV2CorruptSourcePrefix),
        suffixes: [".json", ".json.next"],
      },
      {
        prefix: key(candidate.stateV2ReactivationArchivePrefix),
        suffixes: [".json", ".json.next"],
      },
    );
    internalDirectoryExact.add(key(candidate.logsDir));
    internalDirectoryExact.add(key(candidate.tmpDir));
    internalDirectoryExact.add(key(candidate.ancestorsV2Dir));
    internalDirectoryExact.add(key(candidate.stateV2IndexedDbRecoveryDir));
    internalDirectoryPrefixes.push(
      key(`${candidate.logsDir}/`),
      key(`${candidate.tmpDir}/`),
      key(`${candidate.ancestorsV2Dir}/`),
      key(`${candidate.stateV2IndexedDbRecoveryDir}/`),
    );
  }

  return {
    paths,
    pluginId,
    ownPluginDir,
    ownPluginDirKey: key(ownPluginDir),
    ownPluginDirPrefixKey: key(`${ownPluginDir.replace(/\/+$/, "")}/`),
    internalExact,
    internalPrefixes,
    internalPrefixSuffixes,
    internalDirectoryExact,
    internalDirectoryPrefixes,
    excludedFoldersLower: (config.excludedFolders ?? []).map(
      (folder) => normalizeVaultRelativePath(folder).toLowerCase(),
    ),
    pluginCodeSelection: normalizePluginScopeSelection(
      config.pluginCodeSelection,
      config.includePluginCode,
      pluginId,
    ),
    pluginDataSelection: normalizePluginScopeSelection(
      config.pluginDataSelection,
      config.includePluginData,
      pluginId,
    ),
  };
}

/** `pathKey` must already be case-folded by `normalizeVaultPathKey`; the
 *  index stores its internal paths in the same form. */
function isInternalPathWithIndex(
  pathKey: string,
  index: ScanExclusionIndex,
): boolean {
  if (pathKey.endsWith(EASY_SYNC_RECOVERY_SUFFIX)) return true;
  if (index.internalExact.has(pathKey)) return true;
  for (const prefix of index.internalPrefixes) {
    if (pathKey.startsWith(prefix)) return true;
  }
  for (const entry of index.internalPrefixSuffixes) {
    if (!pathKey.startsWith(entry.prefix)) continue;
    for (const suffix of entry.suffixes) {
      if (pathKey.endsWith(suffix)) return true;
    }
  }
  return false;
}

/** Same result as `isPathExcludedByFolders`, with the folder list normalized
 *  once by the index instead of once per path. */
function isPathExcludedByNormalizedFolders(
  path: string,
  excludedFoldersLower: readonly string[],
): boolean {
  if (excludedFoldersLower.length === 0) return false;
  const normalizedPath = normalizeVaultRelativePath(path).toLowerCase();
  for (const folder of excludedFoldersLower) {
    if (
      normalizedPath === folder
      || normalizedPath.startsWith(`${folder}/`)
    ) return true;
  }
  return false;
}

/** Decide exclusion for one path from the cached per-config index.
 *  includePaths override excludePaths — a path matching any includePath is
 *  never excluded, except for plugin data.json files which would cause
 *  self-referential sync writes. */
function isExcludedWithIndex(
  path: string,
  index: ScanExclusionIndex,
  config: ScanConfig,
): boolean {
  const paths = index.paths;
  const pathKey = normalizeVaultPathKey(path);
  if (isInternalPathWithIndex(pathKey, index)) return true;
  if (isPathExcludedByNormalizedFolders(path, index.excludedFoldersLower)) {
    return true;
  }

  if (
    pathKey === index.ownPluginDirKey
    || pathKey.startsWith(index.ownPluginDirPrefixKey)
  ) {
    return config.includeOwnPluginCode !== true
      || !isEasySyncSelfSyncFilePath(
        path,
        paths.configDir,
        index.pluginId,
        index.ownPluginDir,
      );
  }

  if (
    path.startsWith(paths.pluginRoot)
    && path !== paths.pluginDir
    && !path.startsWith(paths.pluginDirPrefix)
  ) {
    const parts = path.slice(paths.pluginRoot.length).split("/");
    if (parts.length !== 2) return true;
    const communityPluginId = parts[0];
    const fileName = parts[1];
    if (fileName === "data.json") {
      return !isPluginDataSelected(
        index.pluginCodeSelection,
        index.pluginDataSelection,
        communityPluginId,
      );
    }
    return !isPluginSelected(
      index.pluginCodeSelection,
      communityPluginId,
    )
      || !COMMUNITY_PLUGIN_CODE_FILES.has(fileName);
  }

  for (const prefix of config.includePaths) {
    if (path.startsWith(prefix)) {
      return false;
    }
  }
  for (const prefix of config.excludePaths) {
    if (path.startsWith(prefix)) return true;
  }
  if (isDefaultExcludedFileName(path.slice(path.lastIndexOf("/") + 1))) return true;
  return false;
}

function isExcludedDirectoryWithIndex(
  path: string,
  index: ScanExclusionIndex,
  config: ScanConfig,
): boolean {
  const paths = index.paths;
  const pathKey = normalizeVaultPathKey(path);
  if (index.internalDirectoryExact.has(pathKey)) return true;
  for (const prefix of index.internalDirectoryPrefixes) {
    if (pathKey.startsWith(prefix)) return true;
  }
  if (isPathExcludedByNormalizedFolders(path, index.excludedFoldersLower)) {
    return true;
  }

  if (pathKey === index.ownPluginDirKey) {
    return config.includeOwnPluginCode !== true;
  }
  if (pathKey.startsWith(index.ownPluginDirPrefixKey)) return true;

  if (
    path.startsWith(paths.pluginRoot)
    && path !== paths.pluginDir
    && !path.startsWith(paths.pluginDirPrefix)
  ) {
    const parts = path.slice(paths.pluginRoot.length).split("/");
    if (parts.length > 1) return true;
    const communityPluginId = parts[0];
    return !isPluginSelected(index.pluginCodeSelection, communityPluginId)
      && !isPluginDataSelected(
        index.pluginCodeSelection,
        index.pluginDataSelection,
        communityPluginId,
      );
  }

  const prefix = `${path.replace(/\/+$/, "")}/`;
  const relatedInclude = config.includePaths.some(
    (include) => include.startsWith(prefix) || prefix.startsWith(include),
  );
  if (relatedInclude) return false;

  return config.excludePaths.some((exclude) => prefix.startsWith(exclude));
}

/** Standalone wrapper mirroring the pre-index signature; snapshot helpers
 *  call it once, while the scan loop uses the cached index. */
function isExcludedDirectory(
  path: string,
  config: ScanConfig,
  configDir: string,
  pluginId: string,
): boolean {
  return isExcludedDirectoryWithIndex(
    path,
    buildScanExclusionIndex(config, configDir, pluginId),
    config,
  );
}

export interface FolderSyncScopeSnapshotV1 {
  version: 1;
  configDir: string;
  pluginId: string;
  excludePaths: string[];
  excludedFolders: string[];
  includePaths: string[];
  includeOwnPluginCode: boolean;
  includePluginCode: boolean;
  includePluginData: boolean;
  pluginCodeSelection: PluginScopeSelection;
  pluginDataSelection: PluginScopeSelection;
}

/**
 * Persistable, capability-free folder-range facts for one settings revision.
 * The snapshot is only used by the source-bound scope-expansion transaction;
 * normal scanning continues to read the live LocalScanner config.
 */
export function createFolderSyncScopeSnapshotV1(
  config: Partial<ScanConfig>,
  configDir = DEFAULT_CONFIG_DIR,
  pluginId = "easy-sync",
): FolderSyncScopeSnapshotV1 {
  const normalizedConfigDir = normalizeVaultRelativePath(configDir);
  const normalizedPluginId = pluginId.trim() || "easy-sync";
  const includePluginCode = config.includePluginCode === true;
  const includePluginData = config.includePluginData === true;
  return {
    version: 1,
    configDir: normalizedConfigDir,
    pluginId: normalizedPluginId,
    excludePaths: [...(
      config.excludePaths
      ?? [`${normalizedConfigDir}/`, ...DEFAULT_SCAN_CONFIG.excludePaths]
    )],
    excludedFolders: normalizeExcludedFolders(
      config.excludedFolders ?? [],
      normalizedConfigDir,
    ),
    includePaths: [...(config.includePaths ?? [])],
    includeOwnPluginCode: config.includeOwnPluginCode === true,
    includePluginCode,
    includePluginData,
    pluginCodeSelection: normalizePluginScopeSelection(
      config.pluginCodeSelection,
      includePluginCode,
      normalizedPluginId,
    ),
    pluginDataSelection: normalizePluginScopeSelection(
      config.pluginDataSelection,
      includePluginData,
      normalizedPluginId,
    ),
  };
}

export function readFolderSyncScopeSnapshotV1(
  value: unknown,
): FolderSyncScopeSnapshotV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.configDir !== "string"
    || !normalizeVaultRelativePath(value.configDir)
    || typeof value.pluginId !== "string"
    || !value.pluginId.trim()
    || !Array.isArray(value.excludePaths)
    || !value.excludePaths.every((path) => typeof path === "string")
    || !Array.isArray(value.excludedFolders)
    || !value.excludedFolders.every((path) => typeof path === "string")
    || !Array.isArray(value.includePaths)
    || !value.includePaths.every((path) => typeof path === "string")
    || typeof value.includeOwnPluginCode !== "boolean"
    || typeof value.includePluginCode !== "boolean"
    || typeof value.includePluginData !== "boolean"
    || !isRecord(value.pluginCodeSelection)
    || !isRecord(value.pluginDataSelection)
  ) return null;
  return createFolderSyncScopeSnapshotV1({
    excludePaths: value.excludePaths,
    excludedFolders: value.excludedFolders,
    includePaths: value.includePaths,
    includeOwnPluginCode: value.includeOwnPluginCode,
    includePluginCode: value.includePluginCode,
    includePluginData: value.includePluginData,
    pluginCodeSelection: normalizePluginScopeSelection(
      value.pluginCodeSelection,
      value.includePluginCode,
      value.pluginId,
    ),
    pluginDataSelection: normalizePluginScopeSelection(
      value.pluginDataSelection,
      value.includePluginData,
      value.pluginId,
    ),
  }, value.configDir, value.pluginId);
}

export function isFolderPathInSyncScopeSnapshot(
  snapshot: Readonly<FolderSyncScopeSnapshotV1>,
  path: string,
): boolean {
  const normalized = normalizeVaultRelativePath(path);
  if (!normalized) return false;
  return !isExcludedDirectory(normalized, {
    excludePaths: [...snapshot.excludePaths],
    excludedFolders: [...snapshot.excludedFolders],
    includePaths: [...snapshot.includePaths],
    maxFileSize: DEFAULT_SCAN_CONFIG.maxFileSize,
    includeOwnPluginCode: snapshot.includeOwnPluginCode,
    includePluginCode: snapshot.includePluginCode,
    includePluginData: snapshot.includePluginData,
    pluginCodeSelection: snapshot.pluginCodeSelection,
    pluginDataSelection: snapshot.pluginDataSelection,
  }, snapshot.configDir, snapshot.pluginId);
}

export class LocalScanner {
  /** Public accessor for SyncExecutor file I/O (readBinary, writeBinary, remove, mkdir) */
  readonly vault: Vault;
  /** Installed plugin folder (vault path), used only for identity rules. */
  readonly ownPluginDir: string;
  private readonly configDir: string;
  private config: ScanConfig;
  private diag?: DiagnosticLogger;
  /** Included single paths whose stat-null warning already fired this session
   *  (F14: a configured-but-absent bookmarks.json warned every scan cycle).
   *  First warning per path is kept; the entry re-arms when the file is
   *  observed again so a later absence warns fresh. */
  private statNullSinglePathWarned = new Set<string>();
  /** Derived exclusion facts for the current config object. `setConfig`
   *  replaces the config, so identity is the generation marker. */
  private exclusionIndex: ScanExclusionIndex | null = null;
  private exclusionIndexConfig: ScanConfig | null = null;
  private scanCache: ScanCache = {
    format: SCAN_CACHE_FORMAT,
    entries: {},
    histories: {},
  };
  private scanCacheLoaded = false;
  private scanCacheDirty = false;
  /** Files hashed since the last mid-scan cache checkpoint. Reset on every
   *  checkpoint and at scan start; a completed scan's tail save supersedes it. */
  private hashedSinceCheckpoint = 0;
  /** Wall clock of the last checkpoint and the interval currently in use. The
   *  interval doubles per checkpoint so a long scan does not rewrite a large
   *  cache every few seconds. */
  private lastCacheCheckpointAt = 0;
  private cacheCheckpointIntervalMs = SCAN_CACHE_CHECKPOINT_MIN_INTERVAL_MS;
  /** This walk's cost counters (observation only; reset at scan start). A
   *  concurrent settings scan can share them, which at worst skews a
   *  diagnostic number — no decision reads them. */
  private scanCacheHits = 0;
  private scanReadMs = 0;
  private scanHashMs = 0;
  /** Running totals for the global history caps (bytes are approximate). */
  private historyEntryCount = 0;
  private historyApproxBytes = 0;

  constructor(
    vault: Vault,
    config: Partial<ScanConfig> = {},
    readonly pluginId = "easy-sync",
    /** The installed plugin folder as the host reports it (`manifest.dir`).
     *  A manual install may live in a folder that is not named after the
     *  manifest id (`EasySync` vs `easy-sync`); identity rules must follow the
     *  real folder or the plugin's own `data.json` would look like an ordinary
     *  community-plugin file and self-trigger a sync plan loop. */
    ownPluginDir?: string,
  ) {
    this.vault = vault;
    this.configDir = getConfigDir(vault);
    this.ownPluginDir = ownPluginDir?.trim()
      ? normalizeVaultRelativePath(ownPluginDir)
      : getEasySyncPaths(this.configDir, this.pluginId).pluginDir;
    this.config = {
      ...DEFAULT_SCAN_CONFIG,
      ...config,
      includePaths: [...(config.includePaths ?? DEFAULT_SCAN_CONFIG.includePaths)],
      excludedFolders: normalizeExcludedFolders(
        config.excludedFolders ?? DEFAULT_SCAN_CONFIG.excludedFolders ?? [],
        this.configDir,
      ),
    };
    this.config.excludePaths = [
      ...(config.excludePaths
        ?? [`${this.configDir}/`, ...DEFAULT_SCAN_CONFIG.excludePaths]),
    ];
  }

  setDiag(diag: DiagnosticLogger): void {
    this.diag = diag;
  }

  setConfig(config: Partial<ScanConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      ...(config.includePaths ? { includePaths: [...config.includePaths] } : {}),
      ...(config.excludePaths ? { excludePaths: [...config.excludePaths] } : {}),
      ...(config.excludedFolders
        ? {
            excludedFolders: normalizeExcludedFolders(
              config.excludedFolders,
              this.configDir,
            ),
          }
        : {}),
    };
  }

  getMaxFileSize(): number {
    return this.config.maxFileSize;
  }

  shouldSyncPath(path: string): boolean {
    return !this.isExcludedPath(path);
  }

  shouldSyncFolderPath(path: string): boolean {
    const normalized = normalizeVaultRelativePath(path);
    return Boolean(normalized) && !this.isExcludedDirectoryPath(normalized);
  }

  /** Exclusion facts are a pure function of the current config object; build
   *  them once per config generation instead of once per scanned path. */
  private getExclusionIndex(): ScanExclusionIndex {
    if (
      this.exclusionIndex === null
      || this.exclusionIndexConfig !== this.config
    ) {
      this.exclusionIndex = buildScanExclusionIndex(
        this.config,
        this.configDir,
        this.pluginId,
        this.ownPluginDir,
      );
      this.exclusionIndexConfig = this.config;
    }
    return this.exclusionIndex;
  }

  private isExcludedPath(path: string): boolean {
    return isExcludedWithIndex(path, this.getExclusionIndex(), this.config);
  }

  private isExcludedDirectoryPath(path: string): boolean {
    return isExcludedDirectoryWithIndex(
      path,
      this.getExclusionIndex(),
      this.config,
    );
  }

  // ---- Scan Cache ----

  private async loadScanCache(): Promise<void> {
    if (this.scanCacheLoaded) return;
    const { scanCacheFile } = getEasySyncPaths(this.configDir, this.pluginId);
    const legacyScanCacheFile = getEasySyncLegacyPaths(
      this.configDir,
      this.pluginId,
    ).scanCacheFile;
    try {
      let json: string;
      try {
        json = await this.vault.adapter.read(scanCacheFile);
      } catch {
        // Public 1.1.3 cache is valid migration input until the state loader
        // has had a chance to copy it into the new runtime tree.
        json = await this.vault.adapter.read(legacyScanCacheFile);
      }
      const parsed: unknown = JSON.parse(json);
      if (
        isRecord(parsed)
        && (
          parsed.format === SCAN_CACHE_FORMAT
          || parsed.format === SCAN_CACHE_LEGACY_FORMAT
        )
        && isRecord(parsed.entries)
      ) {
        this.scanCache = {
          format: SCAN_CACHE_FORMAT,
          entries: Object.fromEntries(
            Object.entries(parsed.entries).filter((entry): entry is [string, ScanCacheEntry] => {
              const value = entry[1];
              return isRecord(value)
                && typeof value.mtime === "number"
                && typeof value.size === "number"
                && typeof value.hash === "string"
                && (value.quickXorHash === undefined || typeof value.quickXorHash === "string")
                && typeof value.binary === "boolean";
            }),
          ),
          histories: parsed.format === SCAN_CACHE_LEGACY_FORMAT
            ? {}
            : this.parseScanCacheHistories(parsed),
        };
      }
    } catch {
      this.scanCache = {
        format: SCAN_CACHE_FORMAT,
        entries: {},
        histories: {},
      };
    }
    this.scanCacheLoaded = true;
    this.scanCacheDirty = false;
    // An already-oversized cache shrinks on load; the dirty flag makes the
    // next successful scan persist the bounded shape.
    this.recountHistoryTotals();
    this.pruneScanCacheHistoriesGlobally();
  }

  private async saveScanCache(): Promise<void> {
    if (!this.scanCacheDirty) return;
    const { scanCacheFile } = getEasySyncPaths(this.configDir, this.pluginId);
    try {
      await this.vault.adapter.write(scanCacheFile, JSON.stringify(this.scanCache));
      this.scanCacheDirty = false;
    } catch {
      // Best-effort — losing the cache is a perf regression, not data loss
    }
  }

  async clearScanCache(): Promise<void> {
    this.scanCache = {
      format: SCAN_CACHE_FORMAT,
      entries: {},
      histories: {},
    };
    this.historyEntryCount = 0;
    this.historyApproxBytes = 0;
    this.scanCacheLoaded = true;
    this.scanCacheDirty = false;
    const { scanCacheFile } = getEasySyncPaths(this.configDir, this.pluginId);
    try { await this.vault.adapter.remove(scanCacheFile); } catch { /* ok */ }
  }

  /**
   * Prior per-path scan observations (newest last). This is the local change
   * history seed: self-computed hash/size/mtime snapshots across sync rounds.
   * History entries survive entry pruning so deleted files keep their last
   * known facts. The chain is bounded per path and append-only across rounds.
   */
  pathHistory(path: string): readonly ScanCacheHistoryEntry[] {
    return this.scanCache.histories[path] ?? [];
  }

  private parseScanCacheHistories(
    parsed: Record<string, unknown>,
  ): Record<string, ScanCacheHistoryEntry[]> {
    const raw = parsed.histories;
    if (!isRecord(raw)) return {};
    const out: Record<string, ScanCacheHistoryEntry[]> = {};
    for (const [path, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const valid: ScanCacheHistoryEntry[] = [];
      for (const value of list) {
        if (
          isRecord(value)
          && typeof value.mtime === "number"
          && typeof value.size === "number"
          && typeof value.hash === "string"
          && (value.quickXorHash === undefined
            || typeof value.quickXorHash === "string")
          && typeof value.binary === "boolean"
          && typeof value.observedAt === "number"
        ) {
          valid.push({
            mtime: value.mtime,
            size: value.size,
            hash: value.hash,
            quickXorHash: value.quickXorHash,
            binary: value.binary,
            observedAt: value.observedAt,
          });
        }
      }
      if (valid.length > 0) {
        out[path] = valid.slice(-SCAN_CACHE_HISTORY_LIMIT);
      }
    }
    return out;
  }

  /** Rebuild the running global history totals from the current cache. */
  private recountHistoryTotals(): void {
    let entryCount = 0;
    let approxBytes = 0;
    for (const history of Object.values(this.scanCache.histories)) {
      for (const entry of history) {
        entryCount += 1;
        approxBytes += scanCacheHistoryEntryBytes(entry);
      }
    }
    this.historyEntryCount = entryCount;
    this.historyApproxBytes = approxBytes;
  }

  /**
   * Bound the aggregate history across all paths.
   *
   * Deleted paths keep their histories (entry-level `cachePrune` must not
   * erase the last known facts), so the number of retained paths has no
   * natural ceiling. Once either global cap is crossed, entries are evicted
   * oldest-first by `observedAt` down to a low-water mark of both caps so the
   * following appends stay O(1) until the headroom is used up.
   */
  private pruneScanCacheHistoriesGlobally(): void {
    if (
      this.historyEntryCount <= SCAN_CACHE_HISTORY_GLOBAL_ENTRY_LIMIT
      && this.historyApproxBytes <= SCAN_CACHE_HISTORY_GLOBAL_BYTE_LIMIT
    ) {
      return;
    }

    const entryTarget = Math.floor(
      SCAN_CACHE_HISTORY_GLOBAL_ENTRY_LIMIT
        * SCAN_CACHE_HISTORY_GLOBAL_LOW_WATER,
    );
    const byteTarget = Math.floor(
      SCAN_CACHE_HISTORY_GLOBAL_BYTE_LIMIT
        * SCAN_CACHE_HISTORY_GLOBAL_LOW_WATER,
    );

    const ordered: Array<{
      path: string;
      index: number;
      entry: ScanCacheHistoryEntry;
    }> = [];
    for (const [path, history] of Object.entries(this.scanCache.histories)) {
      for (let index = 0; index < history.length; index += 1) {
        ordered.push({ path, index, entry: history[index] });
      }
    }
    // Stable sort: equal timestamps evict earlier per-path positions first.
    ordered.sort((left, right) => left.entry.observedAt - right.entry.observedAt);

    let remainingEntries = this.historyEntryCount;
    let remainingBytes = this.historyApproxBytes;
    let evicted = 0;
    for (const candidate of ordered) {
      if (
        remainingEntries <= entryTarget
        && remainingBytes <= byteTarget
      ) {
        break;
      }
      remainingEntries -= 1;
      remainingBytes -= scanCacheHistoryEntryBytes(candidate.entry);
      evicted += 1;
    }
    if (evicted === 0) return;

    const evictedIndexes = new Map<string, Set<number>>();
    for (const victim of ordered.slice(0, evicted)) {
      let indexes = evictedIndexes.get(victim.path);
      if (!indexes) {
        indexes = new Set<number>();
        evictedIndexes.set(victim.path, indexes);
      }
      indexes.add(victim.index);
    }

    const nextHistories: Record<string, ScanCacheHistoryEntry[]> = {};
    for (const [path, history] of Object.entries(this.scanCache.histories)) {
      const indexes = evictedIndexes.get(path);
      if (!indexes) {
        nextHistories[path] = history;
        continue;
      }
      const kept = history.filter((_entry, index) => !indexes.has(index));
      if (kept.length > 0) nextHistories[path] = kept;
    }

    this.scanCache.histories = nextHistories;
    this.historyEntryCount = remainingEntries;
    this.historyApproxBytes = Math.max(0, remainingBytes);
    this.scanCacheDirty = true;
  }

  private cacheProbe(path: string, mtime: number, size: number): ScanCacheEntry | null {
    const entry = this.scanCache.entries[path];
    if (entry && entry.mtime === mtime && entry.size === size) return entry;
    return null;
  }

  private cacheSet(
    path: string,
    mtime: number,
    size: number,
    hash: string,
    quickXorHash: string | undefined,
    binary: boolean,
  ): void {
    const current = this.scanCache.entries[path];
    if (
      current
      && current.mtime === mtime
      && current.size === size
      && current.hash === hash
      && current.quickXorHash === quickXorHash
      && current.binary === binary
    ) {
      return;
    }
    if (current) {
      const history = this.scanCache.histories[path] ?? [];
      const appended = { ...current, observedAt: Date.now() };
      history.push(appended);
      this.historyEntryCount += 1;
      this.historyApproxBytes += scanCacheHistoryEntryBytes(appended);
      if (history.length > SCAN_CACHE_HISTORY_LIMIT) {
        const dropped = history.splice(
          0,
          history.length - SCAN_CACHE_HISTORY_LIMIT,
        );
        for (const entry of dropped) {
          this.historyEntryCount -= 1;
          this.historyApproxBytes -= scanCacheHistoryEntryBytes(entry);
        }
      }
      this.scanCache.histories[path] = history;
      this.pruneScanCacheHistoriesGlobally();
    }
    this.scanCache.entries[path] = { mtime, size, hash, quickXorHash, binary };
    this.scanCacheDirty = true;
    this.hashedSinceCheckpoint += 1;
  }

  /** Persist the hashes paid for so far when a whole-cache write is due.
   *
   *  Two triggers share one rule — bound the work a host freeze can throw
   *  away without rewriting a large cache on every file: SCAN_CACHE_CHECKPOINT_EVERY
   *  new hashes (many-small-file vaults), or the current interval since the
   *  last checkpoint (a few huge media files can hash for minutes without
   *  reaching the count). The interval doubles per checkpoint up to the cap,
   *  so a long scan writes a handful of times, not every few seconds.
   *
   *  Upserts only: `cachePrune` stays exclusive to a completed scan, because
   *  deleted-path inference is the one thing a partial walk cannot support
   *  (DECISIONS 2026-11-23.03). Best-effort — a failed write keeps
   *  the dirty flag set, so the next trigger or the tail save retries. */
  private async maybeCheckpointScanCache(): Promise<void> {
    if (this.hashedSinceCheckpoint === 0) return;
    const now = Date.now();
    const dueByCount = this.hashedSinceCheckpoint >= SCAN_CACHE_CHECKPOINT_EVERY;
    const dueByTime = now - this.lastCacheCheckpointAt >= this.cacheCheckpointIntervalMs;
    if (!dueByCount && !dueByTime) return;
    await this.saveScanCache();
    this.hashedSinceCheckpoint = 0;
    this.lastCacheCheckpointAt = now;
    this.cacheCheckpointIntervalMs = Math.min(
      this.cacheCheckpointIntervalMs * 2,
      SCAN_CACHE_CHECKPOINT_MAX_INTERVAL_MS,
    );
  }

  private cachePrune(activePaths: Set<string>): void {
    let removed = false;
    const next: Record<string, ScanCacheEntry> = {};
    for (const path of activePaths) {
      if (this.scanCache.entries[path]) next[path] = this.scanCache.entries[path];
    }
    for (const path of Object.keys(this.scanCache.entries)) {
      if (!activePaths.has(path)) {
        removed = true;
        break;
      }
    }
    if (!removed) return;
    this.scanCache.entries = next;
    this.scanCacheDirty = true;
  }

  /**
   * Scan all non-excluded files in the vault and return LocalFileEntry snapshots.
   *
   * `onProgress` reports files examined out of the vault file list. Include
   * paths (config-dir subtrees) are not part of that denominator; scans that
   * rely on them still finish with the same result, just without a total.
   *
   * `signal` makes the walk interruptible. A first sync over a large vault
   * reads every file whole, and on a phone that can outlive the host's
   * tolerance for a backgrounded WebView — before this the only way out was
   * killing the app, and the round could not be cancelled at all. An aborted
   * scan stops at the next file boundary and returns `aborted: true` with the
   * partial page never published: the hashes already paid for are upserted
   * (so the next attempt resumes instead of re-reading them), but no
   * `cachePrune` runs, so nothing here can make a file look deleted.
   */
  async scanAll(
    onProgress?: (current: number, total?: number) => void,
    signal?: AbortSignal,
  ): Promise<LocalScanResult> {
    await this.loadScanCache();
    this.hashedSinceCheckpoint = 0;
    this.lastCacheCheckpointAt = Date.now();
    this.cacheCheckpointIntervalMs = SCAN_CACHE_CHECKPOINT_MIN_INTERVAL_MS;
    this.scanCacheHits = 0;
    this.scanReadMs = 0;
    this.scanHashMs = 0;
    const entries: LocalFileEntry[] = [];
    const skippedLarge: string[] = [];
    const failedPaths: string[] = [];
    const folderScanFailures: string[] = [];
    const folderPaths = new Set<string>();
    const scannedPaths = new Set<string>();
    const observedFilePaths = new Set<string>();
    const scannedDirs = new Set<string>();
    let allFiles: ReturnType<Vault["getFiles"]>;
    try {
      allFiles = this.vault.getFiles();
    } catch (error) {
      this.diag?.warn("scan", "vault file enumeration failed", error);
      return {
        entries,
        folders: [],
        folderScanComplete: false,
        folderScanFailures: ["/"],
        skippedLarge,
        failedPaths: ["/"],
        skippedCount: 0,
        complete: false,
        recoveryCopies: [],
        metrics: this.scanMetricsSnapshot(entries),
      };
    }
    let skippedCount = 0;
    const recoveryCopies: string[] = [];

    this.collectLoadedFolderPaths(folderPaths, folderScanFailures);

    // IncludePaths add files outside `vault.getFiles()`; when they are
    // configured, the vault list is not a complete denominator, so report a
    // count only instead of freezing at total/total before the tail scan.
    const progressTotal = this.config.includePaths.length === 0
      ? allFiles.length
      : undefined;

    skippedCount = await this.scanVaultFiles({
      allFiles,
      entries,
      skippedLarge,
      failedPaths,
      scannedPaths,
      observedFilePaths,
      recoveryCopies,
      skippedCount,
      progressTotal,
      onProgress,
      signal,
    });
    if (signal?.aborted) return this.abortedScanResult(entries);

    // ── IncludePaths enumeration ──
    this.diag?.log("scan", `includePaths: [${this.config.includePaths.join(', ')}], excludePaths: [${this.config.excludePaths.join(', ')}]`);
    await this.scanIncludePaths(
      entries,
      skippedLarge,
      failedPaths,
      scannedPaths,
      observedFilePaths,
      scannedDirs,
      folderPaths,
      recoveryCopies,
      signal,
    );
    if (signal?.aborted) return this.abortedScanResult(entries);
    for (const path of observedFilePaths) {
      if (this.shouldSyncPath(path)) addParentFolderPaths(path, folderPaths);
    }
    const folderSnapshot = buildFolderSnapshot(folderPaths, observedFilePaths, this);
    if (folderSnapshot.conflicts.length > 0) {
      folderScanFailures.push(...folderSnapshot.conflicts);
      this.diag?.warn(
        "scan",
        `local folder topology rejected — ${folderSnapshot.conflicts.length} normalized path conflict(s)`,
        folderSnapshot.conflicts,
      );
    }
    const pluginEntries = entries.filter((e) => e.path.startsWith(`${this.configDir}/`));
    this.diag?.log(
      "scan",
      `scanAll done — ${entries.length} files (${pluginEntries.length} plugin), ${folderSnapshot.entries.length} folders, ${skippedLarge.length} skipped-large, ${failedPaths.length} file failure(s), ${folderScanFailures.length} folder failure(s)`,
    );
    // ponytail: only log the count — full path listing is verbose and rarely useful

    // An incomplete scan cannot prove a cached path was deleted, so pruning
    // waits for a clean walk. The entries it did hash are still content-true
    // facts and are upserted: one unreadable file no longer discards every
    // hash the round paid for, and the next scan's mtime+size probe
    // re-validates them before reuse.
    if (failedPaths.length === 0) this.cachePrune(scannedPaths);
    await this.saveScanCache();

    return {
      entries,
      folders: folderSnapshot.entries,
      folderScanComplete: failedPaths.length === 0 && folderScanFailures.length === 0,
      folderScanFailures,
      skippedLarge,
      failedPaths,
      skippedCount,
      complete: failedPaths.length === 0,
      recoveryCopies,
      metrics: this.scanMetricsSnapshot(entries),
    };
  }

  /** Cost facts for this walk; diagnostic only, never a cache or decision
   *  input. */
  private scanMetricsSnapshot(entries: LocalFileEntry[]): LocalScanMetrics {
    let bytes = 0;
    for (const entry of entries) bytes += entry.size;
    return {
      files: entries.length,
      bytes,
      cacheHits: this.scanCacheHits,
      readMs: this.scanReadMs,
      hashMs: this.scanHashMs,
    };
  }

  /** Terminal shape for a walk the round's cancel signal interrupted.
   *
   *  `complete: false` is deliberate even without a single failed path: a
   *  partial entry list must never be mistaken for the vault's truth, so every
   *  existing caller that gates on `complete` stops exactly as it does for a
   *  incomplete scan — no plan, no mutation. The hashes already paid for are
   *  persisted (upsert only, never `cachePrune`) so a cancelled first sync
   *  resumes instead of re-reading every file from scratch. Callers separate
   *  "cancelled" from "scan failed" by reading `aborted`. */
  private async abortedScanResult(entries: LocalFileEntry[]): Promise<LocalScanResult> {
    await this.saveScanCache();
    this.diag?.log(
      "scan",
      `scanAll aborted by the round cancel — ${entries.length} file(s) had been examined; ${this.hashedSinceCheckpoint} hash(es) kept for the next attempt, nothing pruned`,
    );
    return {
      entries,
      folders: [],
      folderScanComplete: false,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: false,
      aborted: true,
      recoveryCopies: [],
      metrics: this.scanMetricsSnapshot(entries),
    };
  }

  /** Scan every file enumerated by the vault index for one scan round.
   *  Exclusion, cache probe, size ceiling, content read, hashing and the
   *  cache write keep the exact order and continue semantics of the inline
   *  loop this method replaces. */
  private async scanVaultFiles(args: {
    allFiles: ReturnType<Vault["getFiles"]>;
    entries: LocalFileEntry[];
    skippedLarge: string[];
    failedPaths: string[];
    scannedPaths: Set<string>;
    observedFilePaths: Set<string>;
    recoveryCopies: string[];
    skippedCount: number;
    progressTotal?: number;
    onProgress?: (current: number, total?: number) => void;
    signal?: AbortSignal;
  }): Promise<number> {
    const { allFiles, entries, skippedLarge, failedPaths, scannedPaths, observedFilePaths, recoveryCopies, progressTotal, onProgress, signal } = args;
    let { skippedCount } = args;
    let examinedCount = 0;
    for (const file of allFiles) {
      // Cancel is checked once per file, before any work: the cache probe and
      // the content read already yield to the host on their own, so the
      // cancellation window is bounded by one file's read, not the whole walk.
      if (signal?.aborted) return skippedCount;
      examinedCount += 1;
      // Yield on the examined-file cadence, not only after hashing. A warm
      // scan is all cache hits, and without this the whole walk ran as one
      // synchronous block on the host's main thread (74 ms for 317 files,
      // seconds for a large vault, every scheduled round).
      if (examinedCount % SCAN_SLEEP_EVERY === 0) await yieldToHost();
      if (
        examinedCount % SCAN_PROGRESS_EVERY === 0
        || examinedCount === allFiles.length
      ) {
        onProgress?.(examinedCount, progressTotal);
      }
      const path = file.path;
      scannedPaths.add(path);
      observedFilePaths.add(path);

      if (this.isExcludedPath(path)) {
        if (path.endsWith(EASY_SYNC_RECOVERY_SUFFIX)) recoveryCopies.push(path);
        if (!isPathExcludedByNormalizedFolders(
          path,
          this.getExclusionIndex().excludedFoldersLower,
        )) {
          skippedCount++;
        }
        continue;
      }

      let stat: { size: number; mtime?: number } | null | undefined = file.stat;
      if (!stat) {
        try {
          stat = await this.vault.adapter.stat(path);
        } catch (error) {
          this.diag?.warn("scan", `stat failed for "${path}"`, error);
        }
      }
      if (!stat) {
        failedPaths.push(path);
        continue;
      }

      if (stat.size > this.config.maxFileSize) {
        skippedLarge.push(path);
        continue;
      }

      // A zero stat size is not probe-trusted: a persisted cache entry may
      // pin size 0 for non-empty bytes (fresh-file quirk), so read fresh.
      const cached = stat.size === 0
        ? null
        : this.cacheProbe(path, stat.mtime ?? 0, stat.size);
      if (cached) {
        this.scanCacheHits += 1;
        entries.push({
          path,
          size: stat.size,
          mtime: stat.mtime ?? 0,
          hash: cached.hash,
          ...(cached.quickXorHash ? { quickXorHash: cached.quickXorHash } : {}),
          binary: cached.binary,
        });
        continue;
      }

      let content: ArrayBuffer;
      const readStartedAt = Date.now();
      try {
        content = await this.vault.adapter.readBinary(path);
      } catch {
        // Track failed paths — scan is incomplete, destructive actions
        // (DeleteRemote, ConfirmLocalDelete) must be blocked this round.
        failedPaths.push(path);
        continue;
      } finally {
        this.scanReadMs += Date.now() - readStartedAt;
      }

      const hashStartedAt = Date.now();
      const hash = await sha256Hex(content);
      const quickXorHash = quickXorHashBase64(content);
      this.scanHashMs += Date.now() - hashStartedAt;
      const size = resolveScannedFileSize(stat.size, content.byteLength);
      if (size > this.config.maxFileSize) {
        skippedLarge.push(path);
        continue;
      }
      const binary = size > 0 ? isBinary(content) : false;
      entries.push({ path, size, mtime: stat.mtime ?? 0, hash, quickXorHash, binary });
      this.cacheSet(path, stat.mtime ?? 0, size, hash, quickXorHash, binary);
      await this.maybeCheckpointScanCache();
    }
    return skippedCount;
  }

  /** Enumerate paths listed in config.includePaths that are NOT
   *  covered by vault.getFiles() (for example config-dir subtrees).
   *
   *  Directory paths (ending with /) are scanned recursively;
   *  single file paths are scanned directly. */
  private async scanIncludePaths(
    entries: LocalFileEntry[],
    skippedLarge: string[],
    failedPaths: string[],
    scannedPaths: Set<string>,
    observedFilePaths: Set<string>,
    scannedDirs: Set<string>,
    folderPaths: Set<string>,
    recoveryCopies: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const prefix of this.config.includePaths) {
      if (signal?.aborted) return;
      if (prefix.endsWith("/")) {
        await this.scanDir(
          prefix,
          entries,
          skippedLarge,
          failedPaths,
          scannedPaths,
          observedFilePaths,
          scannedDirs,
          folderPaths,
          true,
          recoveryCopies,
          signal,
        );
      } else {
        await this.scanSinglePath(
          prefix,
          entries,
          skippedLarge,
          failedPaths,
          scannedPaths,
          observedFilePaths,
        );
      }
    }
  }

  /** Scan a single file path (not a directory). Used for includePaths that
   *  point to individual config files inside the vault config dir. */
  private async scanSinglePath(
    filePath: string,
    entries: LocalFileEntry[],
    skippedLarge: string[],
    failedPaths: string[],
    scannedPaths: Set<string>,
    observedFilePaths: Set<string>,
  ): Promise<void> {
    if (scannedPaths.has(filePath)) return;
    scannedPaths.add(filePath);

    if (this.isExcludedPath(filePath)) return;

    let stat;
    try {
      stat = await this.vault.adapter.stat(filePath);
    } catch (error) {
      this.diag?.warn("scan", `stat failed for "${filePath}"`, error);
      failedPaths.push(filePath);
      return;
    }
    if (!stat) {
      // An include path can legitimately point at a config file that does not
      // exist locally (bookmarks.json with bookmark sync enabled). Keep the
      // first warning, suppress the per-cycle repeats, and re-arm once the
      // file is observed again (below).
      if (!this.statNullSinglePathWarned.has(filePath)) {
        this.statNullSinglePathWarned.add(filePath);
        this.diag?.warn(
          "scan",
          `stat returned null for "${filePath}", skipping`,
        );
      }
      return;
    }
    observedFilePaths.add(filePath);
    this.statNullSinglePathWarned.delete(filePath);

    if (stat.size > this.config.maxFileSize) {
      skippedLarge.push(filePath);
      return;
    }

    // A zero stat size is not probe-trusted (fresh-file quirk): read fresh.
    const cached = stat.size === 0
      ? null
      : this.cacheProbe(filePath, stat.mtime ?? 0, stat.size);
    if (cached) {
      this.scanCacheHits += 1;
      entries.push({
        path: filePath,
        size: stat.size,
        mtime: stat.mtime ?? 0,
        hash: cached.hash,
        ...(cached.quickXorHash ? { quickXorHash: cached.quickXorHash } : {}),
        binary: cached.binary,
      });
      return;
    }

    let content: ArrayBuffer;
    const readStartedAt = Date.now();
    try {
      content = await this.vault.adapter.readBinary(filePath);
    } catch {
      failedPaths.push(filePath);
      return;
    } finally {
      this.scanReadMs += Date.now() - readStartedAt;
    }

    const hashStartedAt = Date.now();
    const hash = await sha256Hex(content);
    const quickXorHash = quickXorHashBase64(content);
    this.scanHashMs += Date.now() - hashStartedAt;
    const size = resolveScannedFileSize(stat.size, content.byteLength);
    if (size > this.config.maxFileSize) {
      skippedLarge.push(filePath);
      return;
    }
    const binary = size > 0 ? isBinary(content) : false;
    entries.push({
      path: filePath,
      size,
      mtime: stat.mtime ?? 0,
      hash,
      quickXorHash,
      binary,
    });
    this.cacheSet(filePath, stat.mtime ?? 0, size, hash, quickXorHash, binary);
    await this.maybeCheckpointScanCache();
  }

  /** Recursively list and scan files under `dirPath` via vault.adapter.
   *
   *  The caller may pass a trailing slash (from includePaths) —
   *  it is stripped so `${base}/${name}` never produces double slashes,
   *  which would break OneDrive API URLs after encodeUrlPath splits on `/`. */
  private async scanDir(
    dirPath: string,
    entries: LocalFileEntry[],
    skippedLarge: string[],
    failedPaths: string[],
    scannedPaths: Set<string>,
    observedFilePaths: Set<string>,
    scannedDirs: Set<string>,
    folderPaths: Set<string>,
    allowMissingRoot = false,
    recoveryCopies?: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    // Normalize: strip trailing slash(es) so path construction is clean
    const base = dirPath.replace(/\/+$/, "");
    if (scannedDirs.has(base) || this.isExcludedDirectoryPath(base)) return;
    scannedDirs.add(base);

    // Explicitly included config directories such as themes/ and snippets/
    // are optional and may not exist yet. A confirmed absence is a complete,
    // empty local subtree; an uncertain existence check must still fail closed.
    if (allowMissingRoot) {
      let exists: boolean;
      try {
        exists = await this.vault.adapter.exists(base);
      } catch (error) {
        this.diag?.warn("scan", `scanDir("${base}") — existence check failed`, error);
        failedPaths.push(base);
        return;
      }
      if (!exists) {
        this.diag?.log("scan", `scanDir("${base}") → directory absent, treating as empty`);
        return;
      }
    }

    let listed: { files: string[]; folders: string[] };
    try {
      listed = await this.vault.adapter.list(base);
      folderPaths.add(base);
      this.diag?.log("scan", `scanDir("${base}") → ${listed.files.length} files, ${listed.folders.length} folders: [${listed.files.join(', ')}]`);
    } catch (err) {
      this.diag?.warn("scan", `scanDir("${base}") — list failed`, err);
      failedPaths.push(base);
      return;
    }

    await this.scanListedFiles({
      base,
      listed,
      entries,
      skippedLarge,
      failedPaths,
      scannedPaths,
      observedFilePaths,
      recoveryCopies,
      signal,
    });

    for (const sub of listed.folders) {
      const path = normalizeListedPath(base, sub);
      await this.scanDir(
        path,
        entries,
        skippedLarge,
        failedPaths,
        scannedPaths,
        observedFilePaths,
        scannedDirs,
        folderPaths,
        false,
        recoveryCopies,
        signal,
      );
    }
  }

  /** Scan the files listed for one directory `base`.
   *
   *  Exclusion, stat, size ceiling, content read, hashing and the cache
   *  write keep the exact order and continue semantics of the inline loop
   *  this method replaces; every entry, skip and failure is appended to
   *  the caller-owned collections passed by reference. */
  private async scanListedFiles(args: {
    base: string;
    listed: { files: string[]; folders: string[] };
    entries: LocalFileEntry[];
    skippedLarge: string[];
    failedPaths: string[];
    scannedPaths: Set<string>;
    observedFilePaths: Set<string>;
    recoveryCopies: string[] | undefined;
    signal?: AbortSignal;
  }): Promise<void> {
    const { base, listed, entries, skippedLarge, failedPaths, scannedPaths, observedFilePaths, recoveryCopies, signal } = args;
    for (const file of listed.files) {
      if (signal?.aborted) return;
      const path = normalizeListedPath(base, file);
      if (scannedPaths.has(path)) continue;
      scannedPaths.add(path);
      observedFilePaths.add(path);

      if (this.isExcludedPath(path)) {
        if (path.endsWith(EASY_SYNC_RECOVERY_SUFFIX)) recoveryCopies?.push(path);
        if (path.endsWith("/data.json")) {
          this.diag?.log("scan", `isExcluded("${path}") → true (/data.json, self-referential protection)`);
        }
        continue;
      }

      let stat;
      try {
        stat = await this.vault.adapter.stat(path);
      } catch (error) {
        this.diag?.warn("scan", `stat failed for "${path}"`, error);
        failedPaths.push(path);
        continue;
      }
      if (!stat) {
        this.diag?.warn("scan", `stat returned null for "${path}", marking scan incomplete`);
        failedPaths.push(path);
        continue;
      }

      if (stat.size > this.config.maxFileSize) {
        skippedLarge.push(path);
        continue;
      }

      // A zero stat size is not probe-trusted (fresh-file quirk): read fresh.
      const cached = stat.size === 0
        ? null
        : this.cacheProbe(path, stat.mtime ?? 0, stat.size);
      if (cached) {
        this.scanCacheHits += 1;
        entries.push({
          path,
          size: stat.size,
          mtime: stat.mtime ?? 0,
          hash: cached.hash,
          ...(cached.quickXorHash ? { quickXorHash: cached.quickXorHash } : {}),
          binary: cached.binary,
        });
        continue;
      }

      let content: ArrayBuffer;
      const readStartedAt = Date.now();
      try {
        content = await this.vault.adapter.readBinary(path);
      } catch {
        failedPaths.push(path);
        continue;
      } finally {
        this.scanReadMs += Date.now() - readStartedAt;
      }

      const hashStartedAt = Date.now();
      const hash = await sha256Hex(content);
      const quickXorHash = quickXorHashBase64(content);
      this.scanHashMs += Date.now() - hashStartedAt;
      const size = resolveScannedFileSize(stat.size, content.byteLength);
      if (size > this.config.maxFileSize) {
        skippedLarge.push(path);
        continue;
      }
      const binary = size > 0 ? isBinary(content) : false;
      entries.push({ path, size, mtime: stat.mtime ?? 0, hash, quickXorHash, binary });
      this.cacheSet(path, stat.mtime ?? 0, size, hash, quickXorHash, binary);
      await this.maybeCheckpointScanCache();
    }
  }

  private collectLoadedFolderPaths(
    folderPaths: Set<string>,
    folderScanFailures: string[],
  ): void {
    const observedVault = this.vault as Vault & {
      getAllLoadedFiles?: Vault["getAllLoadedFiles"];
    };
    if (typeof observedVault.getAllLoadedFiles !== "function") {
      folderScanFailures.push("/");
      this.diag?.warn("scan", "vault folder enumeration is unavailable");
      return;
    }
    let loaded: ReturnType<Vault["getAllLoadedFiles"]>;
    try {
      loaded = observedVault.getAllLoadedFiles.call(observedVault);
    } catch (error) {
      folderScanFailures.push("/");
      this.diag?.warn("scan", "vault folder enumeration failed", error);
      return;
    }
    for (const entry of loaded) {
      if (!(entry instanceof TFolder)) continue;
      const path = normalizeVaultRelativePath(entry.path);
      if (this.shouldSyncFolderPath(path)) folderPaths.add(path);
    }
  }

  /** Read the current local version for a write-time compare-and-swap check.
   *  Missing and unreadable are never conflated. */
  async inspectFile(
    path: string,
    options: Readonly<{ allowExcludedForRecovery?: boolean }> = {},
  ): Promise<LocalFileInspection> {
    if (
      !options.allowExcludedForRecovery
      && this.isExcludedPath(path)
    ) {
      return { status: "uncertain", reason: "excluded" };
    }

    let stat;
    try {
      stat = await this.vault.adapter.stat(path);
    } catch {
      return { status: "uncertain", reason: "stat" };
    }
    if (!stat) return { status: "missing" };
    if (stat.size > this.config.maxFileSize) {
      return { status: "uncertain", reason: "too-large" };
    }

    let content: ArrayBuffer;
    try {
      content = await this.vault.adapter.readBinary(path);
    } catch {
      return { status: "uncertain", reason: "read" };
    }

    const hash = await sha256Hex(content);
    const quickXorHash = quickXorHashBase64(content);
    const size = resolveScannedFileSize(stat.size, content.byteLength);
    if (size > this.config.maxFileSize) {
      return { status: "uncertain", reason: "too-large" };
    }
    const binary = size > 0 ? isBinary(content) : false;
    return {
      status: "present",
      entry: {
        path,
        size,
        mtime: stat.mtime ?? 0,
        hash,
        quickXorHash,
        binary,
      },
    };
  }

  /** Read-only, content-free version probe. It applies the same exclusion and
   *  size gates as `inspectFile` and reads the same `adapter.stat` facts, but
   *  never reads or hashes the bytes. The confirm-delete wave uses it directly
   *  before each local erase (2026-10-26) so the window between the reviewed
   *  SHA-256 guard and one irreversible erase is a single stat, not the whole
   *  wave. It is a supplementary mtime+size gate, not a content proof. */
  async inspectFileStat(path: string): Promise<LocalFileStatInspection> {
    if (this.isExcludedPath(path)) {
      return { status: "uncertain", reason: "excluded" };
    }
    let stat;
    try {
      stat = await this.vault.adapter.stat(path);
    } catch {
      return { status: "uncertain", reason: "stat" };
    }
    if (!stat) return { status: "missing" };
    if (stat.size > this.config.maxFileSize) {
      return { status: "uncertain", reason: "too-large" };
    }
    return { status: "present", size: stat.size, mtime: stat.mtime ?? 0 };
  }
}

function normalizeListedPath(base: string, entry: string): string {
  const normalized = entry.replace(/\/+$/, "");
  return normalized.startsWith(`${base}/`) ? normalized : `${base}/${normalized}`;
}

/**
 * Entry size must describe the same bytes the hash was taken from. Android
 * can report stat.size 0 for a file written moments ago while readBinary
 * already returns the full bytes; trusting stat there produces an entry of
 * {size 0, hash of full content}, which the upload receipt gate later
 * rejects — the plugin's own successful receipt becomes unrecordable and
 * the mutation ledger blocks (2026-09-13 mobile incident, diagnostic report
 * 142823). A genuinely empty file reads back empty, so only the non-empty
 * divergence is corrected; any stat/content disagreement with stat.size > 0
 * stays guarded by the transfer-time hash check.
 */
function resolveScannedFileSize(statSize: number, contentByteLength: number): number {
  return statSize === 0 && contentByteLength > 0 ? contentByteLength : statSize;
}

function addParentFolderPaths(filePath: string, target: Set<string>): void {
  const parts = normalizeVaultRelativePath(filePath).split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    target.add(current);
  }
}

function buildFolderSnapshot(
  candidates: ReadonlySet<string>,
  observedFiles: ReadonlySet<string>,
  scanner: Pick<LocalScanner, "shouldSyncFolderPath" | "shouldSyncPath">,
): { entries: LocalFolderEntry[]; conflicts: string[] } {
  const byNormalizedPath = new Map<string, string>();
  const conflicts = new Set<string>();
  const candidatesWithParents = new Set(candidates);
  for (const candidate of candidates) {
    addParentFolderPaths(`${candidate}/__folder_snapshot__`, candidatesWithParents);
  }
  for (const candidate of candidatesWithParents) {
    const path = normalizeVaultRelativePath(candidate);
    if (!path || !scanner.shouldSyncFolderPath(path)) continue;
    const key = normalizeTopologyPath(path);
    const previous = byNormalizedPath.get(key);
    if (previous && previous !== path) {
      conflicts.add(previous);
      conflicts.add(path);
      continue;
    }
    byNormalizedPath.set(key, path);
  }
  for (const candidate of observedFiles) {
    const path = normalizeVaultRelativePath(candidate);
    if (!path || !scanner.shouldSyncPath(path)) continue;
    if (byNormalizedPath.has(normalizeTopologyPath(path))) {
      conflicts.add(path);
      conflicts.add(byNormalizedPath.get(normalizeTopologyPath(path))!);
    }
  }
  return {
    entries: [...byNormalizedPath.values()]
      .sort(comparePath)
      .map((path) => ({ path })),
    conflicts: [...conflicts].sort(comparePath),
  };
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeTopologyPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => compatSetTimeout(() => resolve(), ms));
}

/** Yield one full macrotask without the browser's nested-timer clamp.
 *
 *  `setTimeout(0)` is clamped to ~4 ms once timers are nested a few levels;
 *  a warm scan yielding every 50 examined files would turn that into seconds
 *  of wall clock on a 100k-file vault. A MessageChannel task is a normal
 *  macrotask (the host stays repaintable) without the timer clamp. Hosts
 *  without MessageChannel fall back to the previous zero-delay timer.
 */
function yieldToHost(): Promise<void> {
  if (typeof MessageChannel === "undefined") return sleep(0);
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
