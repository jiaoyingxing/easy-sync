/**
 * 片⑤ 忽略记忆：「留在本机，不再提醒」。
 *
 * Device-local memory of the local-only entries this device asked not to be
 * reminded about. It filters the sidebar row set and therefore the counts —
 * nothing else. It is deliberately NOT a sync decision: the file stays
 * local-only, is never auto-uploaded, and the 片② records keep being
 * maintained exactly as before, so this store can never become a second
 * "this path is not synced" source of truth (实施单 §三-11).
 *
 * Keys are the row's upload target path (a 片② copy path for edited entries,
 * the file itself for created entries) — the same key the sidebar row and the
 * side action use, so a renamed copy stays remembered by its record, not by
 * its file name.
 *
 * Shape follows community-plugin-adoption-memory (schemaVersion + kind +
 * canonical string array + imperative reduce + StateManager wrapper + corrupt
 * storage degrades instead of blocking the load). The existing store is not
 * generalized: it validates plugin ids strictly and would reject paths
 * (真问题 10).
 */

import { compareText } from "./compare-text";

export const LOCAL_ONLY_IGNORE_MEMORY_KIND = "local-only-ignore-memory";
export const LOCAL_ONLY_IGNORE_MEMORY_SCHEMA_VERSION = 1;

export interface LocalOnlyIgnoreMemoryV1 {
  schemaVersion: 1;
  kind: "local-only-ignore-memory";
  /** Canonical (trimmed, unique, sorted) upload-target paths. */
  ignoredPaths: string[];
}

export type LocalOnlyIgnoreMemoryCommand =
  | { type: "ignore"; path: string }
  | { type: "clear-ignore"; path: string };

export function createEmptyLocalOnlyIgnoreMemory(): LocalOnlyIgnoreMemoryV1 {
  return {
    schemaVersion: LOCAL_ONLY_IGNORE_MEMORY_SCHEMA_VERSION,
    kind: LOCAL_ONLY_IGNORE_MEMORY_KIND,
    ignoredPaths: [],
  };
}

/**
 * Read the memory from plugin data. Absent storage is the empty memory (fresh
 * installs); anything that is not this exact canonical container degrades to
 * `null` so the caller can fall back to "remind about everything again" — a
 * corrupt list must never block the state load and must never silently drop a
 * single entry (either the whole list is trusted or none of it is).
 */
export function readLocalOnlyIgnoreMemory(
  value: unknown,
): LocalOnlyIgnoreMemoryV1 | null {
  if (value === undefined) return createEmptyLocalOnlyIgnoreMemory();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<LocalOnlyIgnoreMemoryV1>;
  if (
    candidate.schemaVersion !== LOCAL_ONLY_IGNORE_MEMORY_SCHEMA_VERSION
    || candidate.kind !== LOCAL_ONLY_IGNORE_MEMORY_KIND
    || !Array.isArray(candidate.ignoredPaths)
    || Object.keys(candidate).length !== 3
  ) {
    return null;
  }
  const ignoredPaths = normalizeLocalOnlyIgnorePaths(candidate.ignoredPaths);
  // Canonical only: a non-canonical list is corrupt storage, not a list to fix
  // silently on read (the reducer is the only writer).
  if (!sameStringList(candidate.ignoredPaths, ignoredPaths)) return null;
  return {
    schemaVersion: LOCAL_ONLY_IGNORE_MEMORY_SCHEMA_VERSION,
    kind: LOCAL_ONLY_IGNORE_MEMORY_KIND,
    ignoredPaths,
  };
}

/** Imperative reduce: `ignore` adds one canonical path, `clear-ignore` removes. */
export function reduceLocalOnlyIgnoreMemory(
  current: Readonly<LocalOnlyIgnoreMemoryV1>,
  command: Readonly<LocalOnlyIgnoreMemoryCommand>,
): LocalOnlyIgnoreMemoryV1 {
  const base = readLocalOnlyIgnoreMemory(current)
    ?? createEmptyLocalOnlyIgnoreMemory();
  switch (command.type) {
    case "ignore":
      return {
        ...base,
        ignoredPaths: normalizeLocalOnlyIgnorePaths([
          ...base.ignoredPaths,
          command.path,
        ]),
      };
    case "clear-ignore":
      return {
        ...base,
        ignoredPaths: base.ignoredPaths.filter(
          (path) => path !== normalizeLocalOnlyIgnorePath(command.path),
        ),
      };
  }
}

/** 记忆是否逐字段相同（用于跳过无变化的持久化写入）。 */
export function sameLocalOnlyIgnoreMemory(
  left: Readonly<LocalOnlyIgnoreMemoryV1>,
  right: Readonly<LocalOnlyIgnoreMemoryV1>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** True when this upload target is currently ignored (row filtered out). */
export function isLocalOnlyPathIgnored(
  memory: Readonly<LocalOnlyIgnoreMemoryV1> | null,
  targetPath: string,
): boolean {
  if (!memory) return false;
  const normalized = normalizeLocalOnlyIgnorePath(targetPath);
  return normalized.length > 0 && memory.ignoredPaths.includes(normalized);
}

/** Canonical form: trimmed, no leading/trailing slash, unique, sorted. */
export function normalizeLocalOnlyIgnorePaths(
  values: readonly unknown[],
): string[] {
  const normalized = values
    .filter((value): value is string => typeof value === "string")
    .map(normalizeLocalOnlyIgnorePath)
    .filter((path) => path.length > 0);
  return [...new Set(normalized)].sort(compareText);
}

export function normalizeLocalOnlyIgnorePath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function sameStringList(
  left: readonly unknown[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
