/**
 * Configuration-skip helpers shared by planning, progress counting and the
 * sidebar.
 *
 * Size-exclusion baseline: a per-device mirror of the paths that were
 * settled as SkipLargeFile in the most recent completed plan. It exists
 * only so the UI can show skip rows incrementally (2026-09-16 拍板, 方案单
 * §十二) — it is never a second rule owner: the threshold decision stays
 * solely in the scanner/planner, and the baseline is overwritten wholesale
 * with the round's settled set after every completed plan (mirror, not a
 * diff-merged memory).
 */

import { SyncActionType } from "./types";

/** Single-round SkipLargeFile item count above which delta display is
 *  disabled for that round (falls back to full visibility, baseline left
 *  untouched — visibility is never silently truncated). */
export const MAX_SIZE_EXCLUSION_BASELINE_PATHS = 2000;

/** Per-round cap for the skip paths retained inside one history entry. The
 *  history fold still reports the true round total in its title and notes the
 *  omitted remainder, so a 500-file round cannot grow ten history entries by
 *  500 paths each (2026-10-25 拍板: history keeps the list every round, the
 *  live list stays incremental). */
export const MAX_HISTORY_SKIP_PATHS = 200;

/** Normalize the skip paths retained by one history entry: strings only,
 *  de-duplicated, capped at `MAX_HISTORY_SKIP_PATHS`. Corrupt or legacy values
 *  degrade to an empty list (that round simply shows no fold). */
export function normalizeHistorySkipPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    seen.add(entry);
    if (seen.size >= MAX_HISTORY_SKIP_PATHS) break;
  }
  return [...seen];
}

/** Normalize a persisted baseline value: only non-empty strings survive,
 *  duplicates collapse, anything else degrades to an empty baseline (which
 *  makes the next round re-announce the current set once — honest and
 *  self-healing). */
export function normalizeSizeExclusionBaseline(
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) seen.add(entry);
  }
  return [...seen];
}

/**
 * Plan items that only record "this path is excluded by configuration"
 * (size limit, ignored path). They settle without performing any work and
 * cannot fail, so they are a separate, non-counting class everywhere the
 * run reports progress: the top item counter, the progress bar and the
 * "completed" subtitle count real actions only, and the sidebar folds them
 * into one collapsed group (2026-10-25 拍板; sync rows no longer inflate
 * the denominators).
 *
 * `SkipOneDriveInvalidName` deliberately stays out of this class: that row
 * records a real user action (rename the file) and keeps its pending row.
 */
export function isConfigurationSkipAction(
  type: SyncActionType | undefined,
): boolean {
  return type === SyncActionType.SkipLargeFile
    || type === SyncActionType.SkipIgnoredPath;
}

/**
 * Progress denominator for one round: every plan item except the
 * configuration skips. Single owner so the executor's item counter and the
 * sidebar's "completed" numbers cannot drift apart.
 */
export function countProgressPlanItems(
  items: readonly { type: SyncActionType }[],
): number {
  return items.reduce(
    (count, item) => count + (isConfigurationSkipAction(item.type) ? 0 : 1),
    0,
  );
}
