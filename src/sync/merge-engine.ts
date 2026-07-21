/**
 * MergeEngine — Line-based three-way merge for text files.
 *
 * Uses the existing Myers diff engine to compute base→local and base→remote
 * diffs, then merges non-overlapping change regions. Overlapping changes
 * are marked with git-style conflict markers.
 */

import { computeDiff } from "../ui/diff-engine";
import type { DiffLine } from "../ui/diff-engine";
const MERGE_MAX_TOTAL_LINES = 20_000;

export interface MergeResult {
  merged: string;
  hasConflicts: boolean;
}

/** A contiguous change region anchored to base line numbers (1-indexed). */
interface Hunk {
  /** First base line affected (1-indexed). */
  baseStart: number;
  /** Last base line affected (inclusive, 1-indexed). baseEnd < baseStart means insert-only. */
  baseEnd: number;
  /** Replacement lines for this hunk (empty array = pure deletion). */
  lines: string[];
}

/**
 * Extract change hunks from a base→target diff.
 * Hunks are ordered by baseStart ascending and never overlap.
 */
function extractHunks(diff: readonly DiffLine[]): Hunk[] {
  const hunks: Hunk[] = [];
  let baseLine = 1;
  let i = 0;

  while (i < diff.length) {
    const line = diff[i];

    if (line.type === "equal") {
      baseLine++;
      i++;
      continue;
    }

    // Start of a change hunk — collect consecutive non-equal lines
    const baseStart = baseLine;
    let removedCount = 0;
    const added: string[] = [];

    while (i < diff.length && diff[i].type !== "equal") {
      if (diff[i].type === "removed") {
        removedCount++;
        baseLine++;
      } else {
        added.push(diff[i].text);
      }
      i++;
    }

    const baseEnd = removedCount > 0 ? baseStart + removedCount - 1 : baseStart - 1;
    hunks.push({ baseStart, baseEnd, lines: added });
  }

  return hunks;
}

/** Advance basePos past a processed hunk. Insert-only hunks (baseEnd < baseStart)
 *  consume no base lines — stay at baseStart. Replacement hunks skip past baseEnd. */
function advancePast(basePos: number, hunk: Hunk): number {
  return hunk.baseEnd >= hunk.baseStart ? hunk.baseEnd + 1 : hunk.baseStart;
}

/**
 * Line-based three-way merge.
 *
 * @param base   Common ancestor content
 * @param local  Local version
 * @param remote Remote version
 * @returns Merged result with hasConflicts flag
 */
export function threeWayMerge(
  base: string,
  local: string,
  remote: string,
): MergeResult {
  base = normalizeLineEndings(base);
  local = normalizeLineEndings(local);
  remote = normalizeLineEndings(remote);
  if (local === remote) return { merged: local, hasConflicts: false };
  if (local === base) return { merged: remote, hasConflicts: false };
  if (remote === base) return { merged: local, hasConflicts: false };

  const baseLines = base.split("\n");
  const localDiff = computeDiff(base, local, MERGE_MAX_TOTAL_LINES);
  const remoteDiff = computeDiff(base, remote, MERGE_MAX_TOTAL_LINES);

  // Degrade gracefully if either diff was truncated (shouldn't happen for cached files)
  if (localDiff.truncated || remoteDiff.truncated) {
    return { merged: local, hasConflicts: true };
  }

  const localHunks = extractHunks(localDiff.lines);
  const remoteHunks = extractHunks(remoteDiff.lines);

  // Any shared base region is a conflict. Detect this globally before the
  // line walker advances past the beginning of a wider hunk; otherwise a
  // later, partially-overlapping hunk can be stranded and misclassified as a
  // trailing insertion.
  if (localHunks.some((localHunk) =>
    remoteHunks.some((remoteHunk) => hunksOverlap(localHunk, remoteHunk)))) {
    return {
      merged: [
        "<<<<<<< Local",
        local,
        "=======",
        remote,
        ">>>>>>> Remote",
      ].join("\n"),
      hasConflicts: true,
    };
  }

  // Walk through base lines, applying hunks from each side
  const output: string[] = [];
  let hasConflicts = false;
  let basePos = 1;               // current 1-indexed base line
  let localIdx = 0;
  let remoteIdx = 0;

  while (basePos <= baseLines.length) {
    const lHunk = localIdx < localHunks.length ? localHunks[localIdx] : null;
    const rHunk = remoteIdx < remoteHunks.length ? remoteHunks[remoteIdx] : null;

    // Determine affected range for each side at current base position
    const localTouchesBase = lHunk !== null
      && basePos >= lHunk.baseStart
      && basePos <= Math.max(lHunk.baseStart, lHunk.baseEnd);
    const remoteTouchesBase = rHunk !== null
      && basePos >= rHunk.baseStart
      && basePos <= Math.max(rHunk.baseStart, rHunk.baseEnd);

    if (!localTouchesBase && !remoteTouchesBase) {
      // Neither side changed this line
      output.push(baseLines[basePos - 1]);
      basePos++;
    } else if (lHunk && localTouchesBase && !remoteTouchesBase) {
      // Only local changed — apply local hunk
      for (const line of lHunk.lines) {
        output.push(line);
      }
      basePos = advancePast(basePos, lHunk);
      localIdx++;
    } else if (rHunk && !localTouchesBase && remoteTouchesBase) {
      // Only remote changed — apply remote hunk
      for (const line of rHunk.lines) {
        output.push(line);
      }
      basePos = advancePast(basePos, rHunk);
      remoteIdx++;
    } else if (lHunk && rHunk) {
      // Both changed — conflict
      hasConflicts = true;
      output.push("<<<<<<< Local");
      for (const line of lHunk.lines) {
        output.push(line);
      }
      output.push("=======");
      for (const line of rHunk.lines) {
        output.push(line);
      }
      output.push(">>>>>>> Remote");

      // Advance past both hunks, using the larger range
      basePos = Math.max(
        advancePast(basePos, lHunk),
        advancePast(basePos, rHunk),
      );
      localIdx++;
      remoteIdx++;
    } else {
      output.push(baseLines[basePos - 1]);
      basePos++;
    }
  }

  // ---- Handle trailing insertions (hunks past the last base line) ----
  // These are pure-insert hunks where baseStart > baseLines.length
  while (localIdx < localHunks.length || remoteIdx < remoteHunks.length) {
    const lHunk = localIdx < localHunks.length ? localHunks[localIdx] : null;
    const rHunk = remoteIdx < remoteHunks.length ? remoteHunks[remoteIdx] : null;

    if (lHunk && rHunk) {
      // Both have trailing insertions at the same position
      hasConflicts = true;
      output.push("<<<<<<< Local");
      for (const line of lHunk.lines) output.push(line);
      output.push("=======");
      for (const line of rHunk.lines) output.push(line);
      output.push(">>>>>>> Remote");
      localIdx++;
      remoteIdx++;
    } else if (lHunk) {
      for (const line of lHunk.lines) output.push(line);
      localIdx++;
    } else if (rHunk) {
      for (const line of rHunk.lines) output.push(line);
      remoteIdx++;
    }
  }

  return { merged: output.join("\n"), hasConflicts };
}

function hunksOverlap(left: Hunk, right: Hunk): boolean {
  const leftInsert = left.baseEnd < left.baseStart;
  const rightInsert = right.baseEnd < right.baseStart;
  if (leftInsert && rightInsert) return left.baseStart === right.baseStart;
  if (leftInsert) return left.baseStart >= right.baseStart && left.baseStart <= right.baseEnd;
  if (rightInsert) return right.baseStart >= left.baseStart && right.baseStart <= left.baseEnd;
  return left.baseStart <= right.baseEnd && right.baseStart <= left.baseEnd;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}
