/**
 * BaseContentCache — Lightweight baseline content storage for three-way merge.
 *
 * Stores the content of synced text files as the new baseline after each
 * successful upload/download. Used by the merge engine when both sides
 * modify the same file independently.
 *
 * Persisted to `base-content.json` in the plugin directory (outside
 * Obsidian's PluginData API, to keep data.json lean).
 */

import type { DataAdapter } from "obsidian";
import { isStringRecord } from "../obsidian-compat";

/** File extensions considered text for caching. Not exhaustive — covers vault content. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".css", ".js", ".ts", ".yaml", ".yml",
  ".html", ".xml", ".csv", ".jsx", ".tsx", ".mjs", ".cjs",
]);

/** Files larger than this are never cached (2 MB of raw text). */
const MAX_CACHE_SIZE = 2 * 1024 * 1024;

/** M15: total cache size limit — evict LRU when exceeded. */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** M15: maximum number of cached entries. */
const MAX_ENTRIES = 5000;

/** File name for the cache on disk. */
const CACHE_FILE = "base-content.json";

export function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export class BaseContentCache {
  /** path → trimmed content (no trailing newline guaranteed for consistent diff) */
  private store = new Map<string, string>();

  /** Whether the in-memory store has changed since last save. */
  private dirty = false;

  // ---- public API ----

  /** Cache the baseline content for a file. Skips binary and oversized files.
   *  Evicts LRU entries when total size or count exceeds limits. */
  cache(path: string, content: string | ArrayBuffer): void {
    if (typeof content !== "string") return; // binary — never cache
    if (!isTextFile(path)) return;
    if (content.length > MAX_CACHE_SIZE) return;

    // LRU: delete and re-insert to move to end (most-recently-used)
    this.store.delete(path);
    this.store.set(path, content);
    this.evictLRU();
    this.dirty = true;
  }

  /** Get the cached baseline content, or undefined if not cached.
   *  Access bumps the entry to MRU position. */
  get(path: string): string | undefined {
    const content = this.store.get(path);
    if (content !== undefined) {
      // LRU bump: delete + re-insert to move to end
      this.store.delete(path);
      this.store.set(path, content);
    }
    return content;
  }

  /** Evict least-recently-used entries until within limits. */
  private evictLRU(): void {
    // Count limit
    while (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    // Byte limit
    let total = 0;
    for (const content of this.store.values()) total += content.length;
    while (total > MAX_TOTAL_BYTES) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.store.get(oldest) ?? "";
      total -= removed.length;
      this.store.delete(oldest);
    }
  }

  /** Remove entries for paths no longer in the active set. */
  prune(activePaths: Set<string>): void {
    let removed = false;
    for (const path of this.store.keys()) {
      if (!activePaths.has(path)) {
        this.store.delete(path);
        removed = true;
      }
    }
    if (removed) this.dirty = true;
  }

  /** Load the cache from disk. Safe to call when the file doesn't exist yet. */
  async load(adapter: DataAdapter, pluginDir: string): Promise<void> {
    try {
      const raw = await adapter.read(`${pluginDir}/${CACHE_FILE}`);
      const parsed: unknown = JSON.parse(raw);
      this.store = isStringRecord(parsed)
        ? new Map(Object.entries(parsed))
        : new Map();
    } catch {
      // File doesn't exist or is corrupt — start with empty cache
      this.store = new Map();
    }
    this.dirty = false;
  }

  /** Persist the cache to disk. No-op if unchanged. */
  async save(adapter: DataAdapter, pluginDir: string): Promise<void> {
    if (!this.dirty) return;
    const obj: Record<string, string> = {};
    for (const [path, content] of this.store) {
      obj[path] = content;
    }
    await adapter.write(
      `${pluginDir}/${CACHE_FILE}`,
      JSON.stringify(obj),
    );
    this.dirty = false;
  }
}
