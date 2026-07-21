/**
 * LocalScanner — Vault file enumeration and snapshot building
 *
 * Uses Obsidian Vault API for cross-platform file access.
 * Generates LocalFileEntry snapshots with path, size, mtime, and
 * a lightweight content hash (first 16KB SHA-256, truncated to 16 hex chars).
 */

import type { Vault } from "obsidian";
import { sha256Hex } from "../crypto";
import {
  compatSetTimeout,
  DEFAULT_CONFIG_DIR,
  getConfigDir,
  getEasySyncPaths,
  isRecord,
} from "../obsidian-compat";
import {
  type LocalFileEntry,
  type ScanConfig,
  DEFAULT_SCAN_CONFIG,
} from "./types";
import type { DiagnosticLogger } from "./diagnostic-logger";
const SCAN_CACHE_FORMAT = 1;
const SCAN_SLEEP_EVERY = 50;

interface ScanCacheEntry { mtime: number; size: number; hash: string; binary: boolean; }
type ScanCache = { format: number; entries: Record<string, ScanCacheEntry>; };
export interface LocalScanResult {
  entries: LocalFileEntry[];
  skippedLarge: string[];
  failedPaths: string[];
  skippedCount: number;
  complete: boolean;
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

export function isEasySyncInternalPath(
  path: string,
  configDir = DEFAULT_CONFIG_DIR,
  pluginId = "easy-sync",
): boolean {
  const paths = getEasySyncPaths(configDir, pluginId);
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

  if (
    path.startsWith(paths.pluginRoot)
    && path !== paths.pluginDir
    && !path.startsWith(paths.pluginDirPrefix)
  ) {
    const parts = path.slice(paths.pluginRoot.length).split("/");
    if (parts.length !== 2) return true;
    const fileName = parts[1];
    if (fileName === "data.json") return !config.includePluginData;
    return !config.includePluginCode
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
  if (
    path === paths.logsDir
    || path.startsWith(`${paths.logsDir}/`)
    || path === paths.tmpDir
    || path.startsWith(`${paths.tmpDir}/`)
    || path === paths.ancestorsV2Dir
    || path.startsWith(`${paths.ancestorsV2Dir}/`)
  ) return true;

  if (
    path.startsWith(paths.pluginRoot)
    && path !== paths.pluginDir
    && !path.startsWith(paths.pluginDirPrefix)
  ) {
    const parts = path.slice(paths.pluginRoot.length).split("/");
    if (parts.length > 1) return true;
    return !config.includePluginCode && !config.includePluginData;
  }

  const prefix = `${path.replace(/\/+$/, "")}/`;
  const relatedInclude = config.includePaths.some(
    (include) => include.startsWith(prefix) || prefix.startsWith(include),
  );
  if (relatedInclude) return false;

  return config.excludePaths.some((exclude) => prefix.startsWith(exclude));
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
    config: ScanConfig = DEFAULT_SCAN_CONFIG,
    private pluginId = "easy-sync",
  ) {
    this.vault = vault;
    this.configDir = getConfigDir(vault);
    this.config = { ...DEFAULT_SCAN_CONFIG, ...config };
    this.config.excludePaths = config.excludePaths
      ?? [`${this.configDir}/`, ...DEFAULT_SCAN_CONFIG.excludePaths];
  }

  setDiag(diag: DiagnosticLogger): void {
    this.diag = diag;
  }

  setConfig(config: Partial<ScanConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getMaxFileSize(): number {
    return this.config.maxFileSize;
  }

  shouldSyncPath(path: string): boolean {
    return !isExcluded(path, this.config, this.configDir, this.pluginId);
  }

  // ---- Scan Cache ----

  private async loadScanCache(): Promise<void> {
    if (this.scanCacheLoaded) return;
    const { scanCacheFile } = getEasySyncPaths(this.configDir, this.pluginId);
    try {
      const json = await this.vault.adapter.read(scanCacheFile);
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

  private cacheSet(path: string, mtime: number, size: number, hash: string, binary: boolean): void {
    const current = this.scanCache.entries[path];
    if (
      current
      && current.mtime === mtime
      && current.size === size
      && current.hash === hash
      && current.binary === binary
    ) {
      return;
    }
    this.scanCache.entries[path] = { mtime, size, hash, binary };
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
    const scannedPaths = new Set<string>();
    const scannedDirs = new Set<string>();
    let allFiles: ReturnType<Vault["getFiles"]>;
    try {
      allFiles = this.vault.getFiles();
    } catch (error) {
      this.diag?.warn("scan", "vault file enumeration failed", error);
      return {
        entries,
        skippedLarge,
        failedPaths: ["/"],
        skippedCount: 0,
        complete: false,
      };
    }
    let fileCount = 0;

    for (const file of allFiles) {
      const path = file.path;
      scannedPaths.add(path);

      if (isExcluded(path, this.config, this.configDir, this.pluginId)) {
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
        entries.push({ path, size: stat.size, mtime: stat.mtime ?? 0, hash: cached.hash, binary: cached.binary });
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
      const binary = stat.size > 0 ? isBinary(content) : false;
      entries.push({ path, size: stat.size, mtime: stat.mtime ?? 0, hash, binary });
      this.cacheSet(path, stat.mtime ?? 0, stat.size, hash, binary);

      // P1: yield to UI thread every N files (per Obsidian performance docs)
      if (++fileCount % SCAN_SLEEP_EVERY === 0) await sleep(0);
    }

    // ── IncludePaths enumeration ──
    this.diag?.log("scan", `includePaths: [${this.config.includePaths.join(', ')}], excludePaths: [${this.config.excludePaths.join(', ')}]`);
    await this.scanIncludePaths(entries, skippedLarge, failedPaths, scannedPaths, scannedDirs);
    const pluginEntries = entries.filter((e) => e.path.startsWith(`${this.configDir}/`));
    this.diag?.log("scan", `scanAll done — ${entries.length} entries (${pluginEntries.length} plugin), ${skippedLarge.length} skipped-large, ${failedPaths.length} failed`);
    // ponytail: only log the count — full path listing is verbose and rarely useful

    // An incomplete scan cannot prove a cached path was deleted. Keep the
    // previous cache intact and publish nothing until a healthy scan succeeds.
    if (failedPaths.length === 0) {
      this.cachePrune(scannedPaths);
      await this.saveScanCache();
    }

    return {
      entries,
      skippedLarge,
      failedPaths,
      skippedCount: allFiles.length - entries.length - skippedLarge.length - failedPaths.length,
      complete: failedPaths.length === 0,
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
    scannedDirs: Set<string>,
  ): Promise<void> {
    for (const prefix of this.config.includePaths) {
      if (prefix.endsWith("/")) {
        await this.scanDir(prefix, entries, skippedLarge, failedPaths, scannedPaths, scannedDirs);
      } else {
        await this.scanSinglePath(prefix, entries, skippedLarge, failedPaths, scannedPaths);
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

    if (stat.size > this.config.maxFileSize) {
      skippedLarge.push(filePath);
      return;
    }

    const cached = this.cacheProbe(filePath, stat.mtime ?? 0, stat.size);
    if (cached) {
      entries.push({ path: filePath, size: stat.size, mtime: stat.mtime ?? 0, hash: cached.hash, binary: cached.binary });
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
    const binary = stat.size > 0 ? isBinary(content) : false;
    entries.push({ path: filePath, size: stat.size, mtime: stat.mtime ?? 0, hash, binary });
    this.cacheSet(filePath, stat.mtime ?? 0, stat.size, hash, binary);
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
    scannedDirs: Set<string>,
  ): Promise<void> {
    // Normalize: strip trailing slash(es) so path construction is clean
    const base = dirPath.replace(/\/+$/, "");
    if (scannedDirs.has(base) || isExcludedDirectory(base, this.config, this.configDir, this.pluginId)) return;
    scannedDirs.add(base);

    let listed: { files: string[]; folders: string[] };
    try {
      listed = await this.vault.adapter.list(base);
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

      if (isExcluded(path, this.config, this.configDir, this.pluginId)) {
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
        entries.push({ path, size: stat.size, mtime: stat.mtime ?? 0, hash: cached.hash, binary: cached.binary });
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
      const binary = stat.size > 0 ? isBinary(content) : false;
      entries.push({ path, size: stat.size, mtime: stat.mtime ?? 0, hash, binary });
      this.cacheSet(path, stat.mtime ?? 0, stat.size, hash, binary);
    }

    for (const sub of listed.folders) {
      const path = normalizeListedPath(base, sub);
      await this.scanDir(path, entries, skippedLarge, failedPaths, scannedPaths, scannedDirs);
    }
  }

  async scanFile(path: string): Promise<LocalFileEntry | null> {
    const inspection = await this.inspectFile(path);
    if (inspection.status !== "present" || !inspection.entry) return null;
    const { entry } = inspection;
    // Keep scan cache current so the next scanAll() doesn't redundantly re-read
    await this.loadScanCache();
    this.cacheSet(path, entry.mtime, entry.size, entry.hash, entry.binary);
    await this.saveScanCache();

    return entry;
  }

  /** Read the current local version for a write-time compare-and-swap check.
   *  Unlike scanFile(), missing and unreadable are never conflated. */
  async inspectFile(path: string): Promise<LocalFileInspection> {
    if (isExcluded(path, this.config, this.configDir, this.pluginId)) {
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
    const binary = stat.size > 0 ? isBinary(content) : false;
    return {
      status: "present",
      entry: { path, size: stat.size, mtime: stat.mtime ?? 0, hash, binary },
    };
  }
}

function normalizeListedPath(base: string, entry: string): string {
  const normalized = entry.replace(/\/+$/, "");
  return normalized.startsWith(`${base}/`) ? normalized : `${base}/${normalized}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => compatSetTimeout(() => resolve(), ms));
}
