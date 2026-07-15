/**
 * LocalScanner — Vault file enumeration and snapshot building
 *
 * Uses Obsidian Vault API for cross-platform file access.
 * Generates LocalFileEntry snapshots with path, size, mtime, and
 * a lightweight content hash (first 16KB SHA-256, truncated to 16 hex chars).
 */

import type { Vault } from "obsidian";
import {
  type LocalFileEntry,
  type ScanConfig,
  DEFAULT_SCAN_CONFIG,
} from "./types";
import type { DiagnosticLogger } from "./diagnostic-logger";

const PLUGIN_ROOT = ".obsidian/plugins/";
const EASY_SYNC_ROOT = ".obsidian/plugins/easy-sync/";
const EASY_SYNC_DIR = EASY_SYNC_ROOT.slice(0, -1);
const EASY_SYNC_DATA = `${EASY_SYNC_ROOT}data.json`;
const EASY_SYNC_REMOTE_STATE = `${EASY_SYNC_ROOT}remote-state.json`;
const EASY_SYNC_LOGS = `${EASY_SYNC_ROOT}logs`;
const EASY_SYNC_TMP = `${EASY_SYNC_ROOT}tmp`;
const SCAN_CACHE_FILE = `${EASY_SYNC_ROOT}scan-cache.json`;
const SCAN_CACHE_FORMAT = 1;
const SCAN_SLEEP_EVERY = 50;

interface ScanCacheEntry { mtime: number; size: number; hash: string; binary: boolean; }
type ScanCache = { format: number; entries: Record<string, ScanCacheEntry>; };
const COMMUNITY_PLUGIN_CODE_FILES = new Set([
  "main.js",
  "manifest.json",
  "styles.css",
]);

export function isEasySyncInternalPath(path: string): boolean {
  return path === EASY_SYNC_DATA
    || (
      path.startsWith(`${EASY_SYNC_ROOT}data.sync-conflict-`)
      && path.endsWith(".json")
    )
    || path === EASY_SYNC_REMOTE_STATE
    || path === SCAN_CACHE_FILE
    || path === EASY_SYNC_LOGS
    || path.startsWith(`${EASY_SYNC_LOGS}/`)
    || path === EASY_SYNC_TMP
    || path.startsWith(`${EASY_SYNC_TMP}/`);
}

/** Full SHA-256 hash of the entire file, returned as 64-char hex string */
export async function fullHash(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
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
function isExcluded(path: string, config: ScanConfig): boolean {
  if (isEasySyncInternalPath(path)) return true;

  if (
    path.startsWith(PLUGIN_ROOT)
    && path !== EASY_SYNC_DIR
    && !path.startsWith(EASY_SYNC_ROOT)
  ) {
    const parts = path.slice(PLUGIN_ROOT.length).split("/");
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

function isExcludedDirectory(path: string, config: ScanConfig): boolean {
  if (
    path === EASY_SYNC_LOGS
    || path.startsWith(`${EASY_SYNC_LOGS}/`)
    || path === EASY_SYNC_TMP
    || path.startsWith(`${EASY_SYNC_TMP}/`)
  ) return true;

  if (
    path.startsWith(PLUGIN_ROOT)
    && path !== EASY_SYNC_DIR
    && !path.startsWith(EASY_SYNC_ROOT)
  ) {
    const parts = path.slice(PLUGIN_ROOT.length).split("/");
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
  private diag?: DiagnosticLogger;
  private scanCache: ScanCache = { format: SCAN_CACHE_FORMAT, entries: {} };
  private scanCacheLoaded = false;
  private scanCacheDirty = false;

  constructor(
    vault: Vault,
    private config: ScanConfig = DEFAULT_SCAN_CONFIG,
  ) {
    this.vault = vault;
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
    return !isExcluded(path, this.config);
  }

  // ---- Scan Cache ----

  private async loadScanCache(): Promise<void> {
    if (this.scanCacheLoaded) return;
    try {
      const json = await this.vault.adapter.read(SCAN_CACHE_FILE);
      const parsed = JSON.parse(json);
      if (parsed && parsed.format === SCAN_CACHE_FORMAT && parsed.entries) {
        this.scanCache = parsed;
      }
    } catch {
      this.scanCache = { format: SCAN_CACHE_FORMAT, entries: {} };
    }
    this.scanCacheLoaded = true;
    this.scanCacheDirty = false;
  }

  private async saveScanCache(): Promise<void> {
    if (!this.scanCacheDirty) return;
    try {
      await this.vault.adapter.write(SCAN_CACHE_FILE, JSON.stringify(this.scanCache));
      this.scanCacheDirty = false;
    } catch {
      // Best-effort — losing the cache is a perf regression, not data loss
    }
  }

  async clearScanCache(): Promise<void> {
    this.scanCache = { format: SCAN_CACHE_FORMAT, entries: {} };
    this.scanCacheLoaded = true;
    this.scanCacheDirty = false;
    try { await this.vault.adapter.remove(SCAN_CACHE_FILE); } catch { /* ok */ }
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
  async scanAll(): Promise<{
    entries: LocalFileEntry[];
    skippedLarge: string[];
    failedPaths: string[];
    skippedCount: number;
  }> {
    await this.loadScanCache();
    const entries: LocalFileEntry[] = [];
    const skippedLarge: string[] = [];
    const failedPaths: string[] = [];
    const scannedPaths = new Set<string>();
    const scannedDirs = new Set<string>();
    const allFiles = this.vault.getFiles();
    let fileCount = 0;

    for (const file of allFiles) {
      const path = file.path;
      scannedPaths.add(path);

      if (isExcluded(path, this.config)) {
        continue;
      }

      const stat = file.stat ?? await this.vault.adapter.stat(path);
      if (!stat) continue;

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

      const hash = await fullHash(content);
      const binary = stat.size > 0 ? isBinary(content) : false;
      entries.push({ path, size: stat.size, mtime: stat.mtime ?? 0, hash, binary });
      this.cacheSet(path, stat.mtime ?? 0, stat.size, hash, binary);

      // P1: yield to UI thread every N files (per Obsidian performance docs)
      if (++fileCount % SCAN_SLEEP_EVERY === 0) await sleep(0);
    }

    // ── IncludePaths enumeration ──
    this.diag?.log("scan", `includePaths: [${this.config.includePaths.join(', ')}], excludePaths: [${this.config.excludePaths.join(', ')}]`);
    await this.scanIncludePaths(entries, skippedLarge, failedPaths, scannedPaths, scannedDirs);
    const pluginEntries = entries.filter(e => e.path.startsWith('.obsidian/'));
    this.diag?.log("scan", `scanAll done — ${entries.length} entries (${pluginEntries.length} plugin), ${skippedLarge.length} skipped-large, ${failedPaths.length} failed`);
    // ponytail: only log the count — full path listing is verbose and rarely useful

    // Prune stale cache entries for deleted/renamed files, then persist
    this.cachePrune(scannedPaths);
    await this.saveScanCache();

    return {
      entries,
      skippedLarge,
      failedPaths,
      skippedCount: allFiles.length - entries.length - skippedLarge.length - failedPaths.length,
    };
  }

  /** Enumerate paths listed in config.includePaths that are NOT
   *  covered by vault.getFiles() (i.e. .obsidian/ sub-trees).
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

  /** Scan a single file path (not a directory). Used for includePaths like
   *  ".obsidian/app.json" that point to individual config files. */
  private async scanSinglePath(
    filePath: string,
    entries: LocalFileEntry[],
    skippedLarge: string[],
    failedPaths: string[],
    scannedPaths: Set<string>,
  ): Promise<void> {
    if (scannedPaths.has(filePath)) return;
    scannedPaths.add(filePath);

    if (isExcluded(filePath, this.config)) return;

    const stat = await this.vault.adapter.stat(filePath);
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

    const hash = await fullHash(content);
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
    if (scannedDirs.has(base) || isExcludedDirectory(base, this.config)) return;
    scannedDirs.add(base);

    let listed: { files: string[]; folders: string[] };
    try {
      listed = await this.vault.adapter.list(base);
      this.diag?.log("scan", `scanDir("${base}") → ${listed.files.length} files, ${listed.folders.length} folders: [${listed.files.join(', ')}]`);
    } catch (err) {
      this.diag?.warn("scan", `scanDir("${base}") — list failed`, err);
      return;
    }

    for (const file of listed.files) {
      const path = normalizeListedPath(base, file);
      if (scannedPaths.has(path)) continue;
      scannedPaths.add(path);

      if (isExcluded(path, this.config)) {
        if (path.endsWith("/data.json")) {
          this.diag?.log("scan", `isExcluded("${path}") → true (/data.json, self-referential protection)`);
        }
        continue;
      }

      const stat = await this.vault.adapter.stat(path);
      if (!stat) {
        this.diag?.warn("scan", `stat returned null for "${path}", skipping`);
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

      const hash = await fullHash(content);
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
    if (isExcluded(path, this.config)) return null;

    const stat = await this.vault.adapter.stat(path);
    if (!stat || stat.size > this.config.maxFileSize) return null;

    let content: ArrayBuffer;
    try {
      content = await this.vault.adapter.readBinary(path);
    } catch {
      return null;
    }

    const hash = await fullHash(content);
    const binary = stat.size > 0 ? isBinary(content) : false;
    // Keep scan cache current so the next scanAll() doesn't redundantly re-read
    await this.loadScanCache();
    this.cacheSet(path, stat.mtime ?? 0, stat.size, hash, binary);
    await this.saveScanCache();

    return { path, size: stat.size, mtime: stat.mtime ?? 0, hash, binary };
  }
}

function normalizeListedPath(base: string, entry: string): string {
  const normalized = entry.replace(/\/+$/, "");
  return normalized.startsWith(`${base}/`) ? normalized : `${base}/${normalized}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
