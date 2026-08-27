/**
 * LocalScanner — Vault file enumeration and snapshot building
 *
 * Uses Obsidian Vault API for cross-platform file access.
 * Generates LocalFileEntry snapshots with path, size, mtime, full SHA-256,
 * and an optional OneDrive-compatible QuickXor fingerprint from the same read.
 */

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
const SCAN_CACHE_FORMAT = 1;
const SCAN_SLEEP_EVERY = 50;

interface ScanCacheEntry {
  mtime: number;
  size: number;
  hash: string;
  quickXorHash?: string;
  binary: boolean;
}
type ScanCache = { format: number; entries: Record<string, ScanCacheEntry>; };
export interface LocalScanResult {
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
  /** Orphaned `${target}.easy-sync-recovery` copies encountered during the
   *  scan (target-side download-replacement backups whose journal intent is
   *  already gone). They are excluded from sync; the executor clears them in
   *  the same round after the ordinary journal recovery already ran. */
  recoveryCopies: string[];
}
export type LocalFileInspection =
  | { status: "missing" }
  | { status: "present"; entry?: LocalFileEntry }
  | { status: "uncertain"; reason: "excluded" | "stat" | "too-large" | "read" };
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

function isEasySyncInternalPathForPaths(
  path: string,
  paths: ReturnType<typeof getEasySyncPaths>,
): boolean {
  return path.endsWith(".easy-sync-recovery")
    || path === paths.dataFile
    || (
      path.startsWith(`${paths.pluginDirPrefix}data.sync-conflict-`)
      && path.endsWith(".json")
    )
    || path === paths.remoteStateFile
    || path === paths.stateV2File
    || path === paths.stateV2NextFile
    || path === paths.stateV2PreviousFile
    || path === paths.stateV2RecoveryFile
    || path === paths.stateV2ManifestFile
    || path === paths.stateV2ManifestNextFile
    || path === paths.stateV2AuthorityWitnessFile
    || path === paths.stateV2AuthorityWitnessNextFile
    || path === paths.stateV2IndexedDbRecoveryDir
    || path.startsWith(`${paths.stateV2IndexedDbRecoveryDir}/`)
    || path === paths.stateV2RetiredManifestFile
    || path === paths.stateV2RollbackFile
    || path === paths.stateV2MigrationHoldFile
    || path === paths.stateV2MigrationHoldNextFile
    || path === paths.stateV2ScopeTransitionFile
    || path === paths.stateV2ScopeTransitionNextFile
    || (
      path.startsWith(paths.stateV2CorruptSourcePrefix)
      && (path.endsWith(".json") || path.endsWith(".json.next"))
    )
    || path === paths.stateV2CorruptRecoveryFile
    || path === paths.stateV2CorruptRecoveryNextFile
    || path === paths.stateV2CorruptPublicationFile
    || path === paths.stateV2CorruptPublicationNextFile
    || (
      path.startsWith(paths.stateV2ReactivationArchivePrefix)
      && (path.endsWith(".json") || path.endsWith(".json.next"))
    )
    || path === paths.stateV1BackupFile
    || path === paths.baseContentFile
    || path === paths.ancestorManifestV2File
    || path === paths.ancestorManifestV2NextFile
    || path === paths.ancestorsV2Dir
    || path.startsWith(`${paths.ancestorsV2Dir}/`)
    || path === paths.scanCacheFile
    || path === paths.logsDir
    || path.startsWith(`${paths.logsDir}/`)
    || path === paths.tmpDir
    || path.startsWith(`${paths.tmpDir}/`);
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

/** Check if a path should be excluded based on config.
 *  includePaths override excludePaths — a path matching any includePath is never excluded,
 *  except for plugin data.json files which would cause self-referential sync writes. */
function isExcluded(path: string, config: ScanConfig, configDir: string, pluginId: string): boolean {
  const paths = getEasySyncPaths(configDir, pluginId);
  if (isEasySyncInternalPath(path, configDir, pluginId)) return true;
  if (isPathExcludedByFolders(path, config.excludedFolders)) return true;

  if (path === paths.pluginDir || path.startsWith(paths.pluginDirPrefix)) {
    return config.includeOwnPluginCode !== true
      || !isEasySyncSelfSyncFilePath(path, configDir, pluginId);
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
    const pluginCodeSelection = normalizePluginScopeSelection(
      config.pluginCodeSelection,
      config.includePluginCode,
      pluginId,
    );
    const pluginDataSelection = normalizePluginScopeSelection(
      config.pluginDataSelection,
      config.includePluginData,
      pluginId,
    );
    if (fileName === "data.json") {
      return !isPluginDataSelected(
        pluginCodeSelection,
        pluginDataSelection,
        communityPluginId,
      );
    }
    return !isPluginSelected(
      pluginCodeSelection,
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
  return false;
}

function isExcludedDirectory(path: string, config: ScanConfig, configDir: string, pluginId: string): boolean {
  const paths = getEasySyncPaths(configDir, pluginId);
  const legacyPaths = getEasySyncLegacyPaths(configDir, pluginId);
  const isInternalDirectory = (candidate: ReturnType<typeof getEasySyncPaths>): boolean =>
    path === candidate.logsDir
    || path.startsWith(`${candidate.logsDir}/`)
    || path === candidate.tmpDir
    || path.startsWith(`${candidate.tmpDir}/`)
    || path === candidate.ancestorsV2Dir
    || path.startsWith(`${candidate.ancestorsV2Dir}/`)
    || path === candidate.stateV2IndexedDbRecoveryDir
    || path.startsWith(`${candidate.stateV2IndexedDbRecoveryDir}/`);
  if (isInternalDirectory(paths) || isInternalDirectory(legacyPaths)) return true;
  if (isPathExcludedByFolders(path, config.excludedFolders)) return true;

  if (path === paths.pluginDir) {
    return config.includeOwnPluginCode !== true;
  }
  if (path.startsWith(paths.pluginDirPrefix)) return true;

  if (
    path.startsWith(paths.pluginRoot)
    && path !== paths.pluginDir
    && !path.startsWith(paths.pluginDirPrefix)
  ) {
    const parts = path.slice(paths.pluginRoot.length).split("/");
    if (parts.length > 1) return true;
    const communityPluginId = parts[0];
    const pluginCodeSelection = normalizePluginScopeSelection(
      config.pluginCodeSelection,
      config.includePluginCode,
      pluginId,
    );
    const pluginDataSelection = normalizePluginScopeSelection(
      config.pluginDataSelection,
      config.includePluginData,
      pluginId,
    );
    return !isPluginSelected(pluginCodeSelection, communityPluginId)
      && !isPluginDataSelected(
        pluginCodeSelection,
        pluginDataSelection,
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
  private readonly configDir: string;
  private config: ScanConfig;
  private diag?: DiagnosticLogger;
  private scanCache: ScanCache = { format: SCAN_CACHE_FORMAT, entries: {} };
  private scanCacheLoaded = false;
  private scanCacheDirty = false;

  constructor(
    vault: Vault,
    config: Partial<ScanConfig> = {},
    private pluginId = "easy-sync",
  ) {
    this.vault = vault;
    this.configDir = getConfigDir(vault);
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
    return !isExcluded(path, this.config, this.configDir, this.pluginId);
  }

  shouldSyncFolderPath(path: string): boolean {
    const normalized = normalizeVaultRelativePath(path);
    return Boolean(normalized)
      && !isExcludedDirectory(normalized, this.config, this.configDir, this.pluginId);
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
        && parsed.format === SCAN_CACHE_FORMAT
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
        };
      }
    } catch {
      this.scanCache = { format: SCAN_CACHE_FORMAT, entries: {} };
    }
    this.scanCacheLoaded = true;
    this.scanCacheDirty = false;
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
    this.scanCache = { format: SCAN_CACHE_FORMAT, entries: {} };
    this.scanCacheLoaded = true;
    this.scanCacheDirty = false;
    const { scanCacheFile } = getEasySyncPaths(this.configDir, this.pluginId);
    try { await this.vault.adapter.remove(scanCacheFile); } catch { /* ok */ }
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
    this.scanCache.entries[path] = { mtime, size, hash, quickXorHash, binary };
    this.scanCacheDirty = true;
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
   */
  async scanAll(): Promise<LocalScanResult> {
    await this.loadScanCache();
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
      };
    }
    let fileCount = 0;
    let skippedCount = 0;
    const recoveryCopies: string[] = [];

    this.collectLoadedFolderPaths(folderPaths, folderScanFailures);

    for (const file of allFiles) {
      const path = file.path;
      scannedPaths.add(path);
      observedFilePaths.add(path);

      if (isExcluded(path, this.config, this.configDir, this.pluginId)) {
        if (path.endsWith(".easy-sync-recovery")) recoveryCopies.push(path);
        if (!isPathExcludedByFolders(path, this.config.excludedFolders)) {
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

      // P0: reuse cached hash when mtime and size are unchanged
      const cached = this.cacheProbe(path, stat.mtime ?? 0, stat.size);
      if (cached) {
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
      try {
        content = await this.vault.adapter.readBinary(path);
      } catch {
        // Track failed paths — scan is incomplete, destructive actions
        // (DeleteRemote, ConfirmLocalDelete) must be blocked this round.
        failedPaths.push(path);
        continue;
      }

      const hash = await sha256Hex(content);
      const quickXorHash = quickXorHashBase64(content);
      const binary = stat.size > 0 ? isBinary(content) : false;
      entries.push({ path, size: stat.size, mtime: stat.mtime ?? 0, hash, quickXorHash, binary });
      this.cacheSet(path, stat.mtime ?? 0, stat.size, hash, quickXorHash, binary);

      // P1: yield to UI thread every N files (per Obsidian performance docs)
      if (++fileCount % SCAN_SLEEP_EVERY === 0) await sleep(0);
    }

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
    );
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

    // An incomplete scan cannot prove a cached path was deleted. Keep the
    // previous cache intact and publish nothing until a healthy scan succeeds.
    if (failedPaths.length === 0) {
      this.cachePrune(scannedPaths);
      await this.saveScanCache();
    }

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
    };
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
  ): Promise<void> {
    for (const prefix of this.config.includePaths) {
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

    if (isExcluded(filePath, this.config, this.configDir, this.pluginId)) return;

    let stat;
    try {
      stat = await this.vault.adapter.stat(filePath);
    } catch (error) {
      this.diag?.warn("scan", `stat failed for "${filePath}"`, error);
      failedPaths.push(filePath);
      return;
    }
    if (!stat) {
      this.diag?.warn("scan", `stat returned null for "${filePath}", skipping`);
      return;
    }
    observedFilePaths.add(filePath);

    if (stat.size > this.config.maxFileSize) {
      skippedLarge.push(filePath);
      return;
    }

    const cached = this.cacheProbe(filePath, stat.mtime ?? 0, stat.size);
    if (cached) {
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
    try {
      content = await this.vault.adapter.readBinary(filePath);
    } catch {
      failedPaths.push(filePath);
      return;
    }

    const hash = await sha256Hex(content);
    const quickXorHash = quickXorHashBase64(content);
    const binary = stat.size > 0 ? isBinary(content) : false;
    entries.push({
      path: filePath,
      size: stat.size,
      mtime: stat.mtime ?? 0,
      hash,
      quickXorHash,
      binary,
    });
    this.cacheSet(filePath, stat.mtime ?? 0, stat.size, hash, quickXorHash, binary);
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
  ): Promise<void> {
    // Normalize: strip trailing slash(es) so path construction is clean
    const base = dirPath.replace(/\/+$/, "");
    if (scannedDirs.has(base) || isExcludedDirectory(base, this.config, this.configDir, this.pluginId)) return;
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

    for (const file of listed.files) {
      const path = normalizeListedPath(base, file);
      if (scannedPaths.has(path)) continue;
      scannedPaths.add(path);
      observedFilePaths.add(path);

      if (isExcluded(path, this.config, this.configDir, this.pluginId)) {
        if (path.endsWith(".easy-sync-recovery")) recoveryCopies?.push(path);
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

      const cached = this.cacheProbe(path, stat.mtime ?? 0, stat.size);
      if (cached) {
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
      try {
        content = await this.vault.adapter.readBinary(path);
      } catch {
        failedPaths.push(path);
        continue;
      }

      const hash = await sha256Hex(content);
      const quickXorHash = quickXorHashBase64(content);
      const binary = stat.size > 0 ? isBinary(content) : false;
      entries.push({ path, size: stat.size, mtime: stat.mtime ?? 0, hash, quickXorHash, binary });
      this.cacheSet(path, stat.mtime ?? 0, stat.size, hash, quickXorHash, binary);
    }

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
      );
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

  async scanFile(path: string): Promise<LocalFileEntry | null> {
    const inspection = await this.inspectFile(path);
    if (inspection.status !== "present" || !inspection.entry) return null;
    const { entry } = inspection;
    // Keep scan cache current so the next scanAll() doesn't redundantly re-read
    await this.loadScanCache();
    this.cacheSet(
      path,
      entry.mtime,
      entry.size,
      entry.hash,
      entry.quickXorHash,
      entry.binary,
    );
    await this.saveScanCache();

    return entry;
  }

  /** Read the current local version for a write-time compare-and-swap check.
   *  Unlike scanFile(), missing and unreadable are never conflated. */
  async inspectFile(
    path: string,
    options: Readonly<{ allowExcludedForRecovery?: boolean }> = {},
  ): Promise<LocalFileInspection> {
    if (
      !options.allowExcludedForRecovery
      && isExcluded(path, this.config, this.configDir, this.pluginId)
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
    const binary = stat.size > 0 ? isBinary(content) : false;
    return {
      status: "present",
      entry: {
        path,
        size: stat.size,
        mtime: stat.mtime ?? 0,
        hash,
        quickXorHash,
        binary,
      },
    };
  }
}

function normalizeListedPath(base: string, entry: string): string {
  const normalized = entry.replace(/\/+$/, "");
  return normalized.startsWith(`${base}/`) ? normalized : `${base}/${normalized}`;
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
  return path.normalize("NFC").toLocaleLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => compatSetTimeout(() => resolve(), ms));
}
