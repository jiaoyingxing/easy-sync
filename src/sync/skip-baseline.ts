/**
 * Size-exclusion baseline: a per-device mirror of the paths that were
 * settled as SkipLargeFile in the most recent completed plan. It exists
 * only so the UI can show skip rows incrementally (2026-09-16 拍板, 方案单
 * §十二) — it is never a second rule owner: the threshold decision stays
 * solely in the scanner/planner, and the baseline is overwritten wholesale
 * with the round's settled set after every completed plan (mirror, not a
 * diff-merged memory).
 */

/** Single-round SkipLargeFile item count above which delta display is
 *  disabled for that round (falls back to full visibility, baseline left
 *  untouched — visibility is never silently truncated). */
export const MAX_SIZE_EXCLUSION_BASELINE_PATHS = 2000;

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
