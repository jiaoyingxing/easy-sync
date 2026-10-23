/**
 * BaseContentCache — Lightweight baseline content storage for three-way merge.
 *
 * Holds the content of synced text files as the legacy baseline. Under V2
 * authority the runtime only loads this snapshot for the legacy read-only
 * path; new baselines live in AncestorStoreV2.
 *
 * Persisted to the registered base-content path (outside
 * Obsidian's PluginData API, to keep data.json lean).
 */

import type { DataAdapter } from "obsidian";
import { isStringRecord } from "../obsidian-compat";

/** File extensions considered text for caching. Not exhaustive — covers vault content. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".css", ".js", ".ts", ".yaml", ".yml",
  ".html", ".xml", ".csv", ".jsx", ".tsx", ".mjs", ".cjs",
]);

function stringRecordToMap(record: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    map.set(key, value);
  }
  return map;
}

export function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export class BaseContentCache {
  /** path → trimmed content (no trailing newline guaranteed for consistent diff) */
  private store = new Map<string, string>();

  // ---- public API ----

  /** Get the cached baseline content, or undefined if not cached. */
  get(path: string): string | undefined {
    return this.store.get(path);
  }

  /** Load the cache from disk. Safe to call when the file doesn't exist yet. */
  async load(
    adapter: DataAdapter,
    cachePath: string,
    legacyCachePath?: string,
  ): Promise<void> {
    try {
      let raw: string;
      try {
        raw = await adapter.read(cachePath);
      } catch {
        if (!legacyCachePath) throw new Error("base cache missing");
        raw = await adapter.read(legacyCachePath);
      }
      const parsed: unknown = JSON.parse(raw);
      const nextStore: Map<string, string> = isStringRecord(parsed)
        ? stringRecordToMap(parsed)
        : new Map<string, string>();
      this.store = nextStore;
    } catch {
      // File doesn't exist or is corrupt — start with empty cache
      this.store = new Map<string, string>();
    }
  }
}
