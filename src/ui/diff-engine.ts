/**
 * Simple Myers diff engine.
 *
 * No external dependencies. Computes a line-by-line diff between two texts
 * using Myers' O(ND) algorithm (1986). O(N+M) space, O((N+M)*D) time where
 * D is the edit distance — near-instant for similar files, degrades gracefully
 * for very different files.
 *
 * For very large files (>4000 total lines) or excessively different files
 * (edit distance > MAX_D), the diff is truncated to avoid excessive computation.
 */

/** Maximum total lines to diff (local + remote). Beyond this, show preview. */
const MAX_TOTAL_LINES = 4000;
/** Maximum edit distance before treating files as completely unrelated. */
const MAX_D = 1000;

/** A single line in a diff result */
export interface DiffLine {
  type: "equal" | "added" | "removed";
  text: string;
  lineNumber: {
    local?: number;
    remote?: number;
  };
}

/** Complete diff result with summary stats */
export interface DiffResult {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  truncated: boolean;
  /** First 100 lines of local file (only set when truncated) */
  localSample?: string[];
  /** First 100 lines of remote file (only set when truncated) */
  remoteSample?: string[];
  /** Total line count of local file (only set when truncated) */
  localTotalLines?: number;
  /** Total line count of remote file (only set when truncated) */
  remoteTotalLines?: number;
}

export interface DisplayDiffSampleLine {
  lineNumber: number;
  text: string;
}

export interface DisplayDiffHunk {
  kind: "hunk";
  lines: DiffLine[];
}

export interface DisplayDiffSummary {
  kind: "summary";
  reason: "change-budget" | "alignment-limit" | "display-budget";
  localStartLine: number;
  localEndLine: number;
  remoteStartLine: number;
  remoteEndLine: number;
  localSample: DisplayDiffSampleLine[];
  remoteSample: DisplayDiffSampleLine[];
  localOmittedLines: number;
  remoteOmittedLines: number;
}

export type DisplayDiffPart = DisplayDiffHunk | DisplayDiffSummary;

export interface DisplayDiffResult {
  parts: DisplayDiffPart[];
  addedCount: number;
  removedCount: number;
  /** True when every changed region was aligned and counted exactly. */
  complete: boolean;
  localTotalLines: number;
  remoteTotalLines: number;
}

/** Internal: a snake in Myers' edit graph — a horizontal/vertical step followed by a diagonal run. */
interface Snake {
  x: number;       // start x (after the horizontal/vertical step)
  y: number;       // start y
  u: number;       // end x (after diagonal extension)
  v: number;       // end y
  k: number;       // diagonal (x - y)
  prev: Snake | null;
}

/**
 * Myers diff core: find the shortest edit script and convert to DiffLine[].
 */
function myersDiff(a: string[], b: string[]): DiffLine[] {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  const offset = MAX; // map diagonal k to array index V[k + offset]

  // V[k] = furthest x reachable on diagonal k at the current edit distance D
  const V = new Int32Array(2 * MAX + 1);

  // Follow initial diagonal from (0,0) — this is the D=0 baseline
  let x = 0;
  let y = 0;
  while (x < N && y < M && a[x] === b[y]) { x++; y++; }

  const start: Snake = { x: 0, y: 0, u: x, v: y, k: 0, prev: null };
  V[offset] = x; // k=0

  if (x >= N && y >= M) {
    return buildDiff(a, b, start);
  }

  // Snakes reachable at the current D, keyed by diagonal k
  let snakes = new Map<number, Snake>();
  snakes.set(0, start);

  const Dcap = Math.min(MAX_D, MAX);

  for (let D = 1; D <= Dcap; D++) {
    const next = new Map<number, Snake>();

    for (let k = -D; k <= D; k += 2) {
      let x0: number;
      let prev: Snake;

      // Choose best predecessor: down from k+1 or right from k-1
      if (k === -D || (k !== D && V[k - 1 + offset] < V[k + 1 + offset])) {
        // Down: from diagonal k+1 (y increases, x unchanged)
        prev = snakes.get(k + 1)!;
        x0 = prev.u;
      } else {
        // Right: from diagonal k-1 (x increases)
        prev = snakes.get(k - 1)!;
        x0 = prev.u + 1;
      }

      let y0 = x0 - k;
      x = x0;
      y = y0;

      // Greedy diagonal extension
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }

      V[k + offset] = x;
      const snake: Snake = { x: x0, y: y0, u: x, v: y, k, prev };
      next.set(k, snake);

      if (x >= N && y >= M) {
        return buildDiff(a, b, snake);
      }
    }

    snakes = next;
  }

  // Exceeded Dcap — files too different
  throw new Error("MAX_D exceeded");
}

/**
 * Backtrack through the snake chain and build the DiffLine array.
 */
function buildDiff(a: string[], b: string[], end: Snake): DiffLine[] {
  // Collect snake chain by following prev pointers
  const chain: Snake[] = [];
  let s: Snake | null = end;
  while (s) { chain.push(s); s = s.prev; }
  chain.reverse();

  const lines: DiffLine[] = [];
  let localNum = 1;
  let remoteNum = 1;

  for (let i = 0; i < chain.length; i++) {
    const snake = chain[i];
    const prev = i > 0 ? chain[i - 1] : null;

    if (prev) {
      if (snake.k < prev.k) {
        // k decreased: went down → insert from b (added line)
        lines.push({
          type: "added",
          text: b[prev.v],
          lineNumber: { remote: remoteNum++ },
        });
      } else {
        // k increased: went right → delete from a (removed line)
        lines.push({
          type: "removed",
          text: a[prev.u],
          lineNumber: { local: localNum++ },
        });
      }
    }

    // Diagonal run: equal lines from (snake.x, snake.y) to (snake.u, snake.v)
    for (let j = snake.x; j < snake.u; j++) {
      lines.push({
        type: "equal",
        text: a[j],
        lineNumber: { local: localNum++, remote: remoteNum++ },
      });
    }
  }

  return lines;
}

/**
 * Compute a line-by-line diff between two texts.
 *
 * @param localText  Local file content (UTF-8 string)
 * @param remoteText Remote file content (UTF-8 string)
 * @returns DiffResult with line array and stats
 */
export function computeDiff(
  localText: string,
  remoteText: string,
  maxTotalLines = MAX_TOTAL_LINES,
): DiffResult {
  const localLines = localText.split("\n");
  const remoteLines = remoteText.split("\n");

  // Truncate check — return raw samples, no fake diff
  if (localLines.length + remoteLines.length > maxTotalLines) {
    return {
      lines: [],
      addedCount: remoteLines.length,
      removedCount: localLines.length,
      truncated: true,
      localSample: localLines.slice(0, 100),
      remoteSample: remoteLines.slice(0, 100),
      localTotalLines: localLines.length,
      remoteTotalLines: remoteLines.length,
    };
  }

  try {
    const lines = myersDiff(localLines, remoteLines);
    let addedCount = 0;
    let removedCount = 0;
    for (const line of lines) {
      if (line.type === "added") addedCount++;
      else if (line.type === "removed") removedCount++;
    }
    return { lines, addedCount, removedCount, truncated: false };
  } catch {
    // MAX_D exceeded: files too different for meaningful diff
    return {
      lines: [],
      addedCount: remoteLines.length,
      removedCount: localLines.length,
      truncated: true,
      localSample: localLines.slice(0, 100),
      remoteSample: remoteLines.slice(0, 100),
      localTotalLines: localLines.length,
      remoteTotalLines: remoteLines.length,
    };
  }
}

const DISPLAY_CONTEXT_LINES = 3;
const MAX_EXACT_DISPLAY_REGION_LINES = 4000;
const MAX_RENDERED_CHANGED_LINES_PER_REGION = 400;
const MAX_DISPLAY_PARTS = 200;
const MAX_ANCHOR_DEPTH = 6;
const SUMMARY_SAMPLE_LINES_PER_SIDE = 16;

interface Anchor {
  local: number;
  remote: number;
}

interface DisplayDiffState {
  parts: DisplayDiffPart[];
  addedCount: number;
  removedCount: number;
  complete: boolean;
  exhausted: boolean;
}

/**
 * Compute a bounded line diff for the conflict detail UI.
 *
 * Large texts are partitioned by stable unique-line anchors. Only the changed
 * regions are sent through the exact Myers core, so an unchanged 100k-line
 * body does not become 100k DiffLine objects or DOM rows. Regions that cannot
 * be aligned safely within the budget are explicitly summarized instead of
 * being presented as a fabricated whole-file delete/add.
 */
export function computeDisplayDiff(
  localText: string,
  remoteText: string,
): DisplayDiffResult {
  const localLines = localText.split("\n");
  const remoteLines = remoteText.split("\n");
  const state: DisplayDiffState = {
    parts: [],
    addedCount: 0,
    removedCount: 0,
    complete: true,
    exhausted: false,
  };

  collectDisplayDiff(
    localLines,
    remoteLines,
    0,
    localLines.length,
    0,
    remoteLines.length,
    0,
    state,
  );

  return {
    ...state,
    localTotalLines: localLines.length,
    remoteTotalLines: remoteLines.length,
  };
}

function collectDisplayDiff(
  localLines: string[],
  remoteLines: string[],
  initialLocalStart: number,
  initialLocalEnd: number,
  initialRemoteStart: number,
  initialRemoteEnd: number,
  depth: number,
  state: DisplayDiffState,
): void {
  if (state.exhausted) return;
  if (initialLocalStart === initialLocalEnd && initialRemoteStart === initialRemoteEnd) return;

  if (state.parts.length >= MAX_DISPLAY_PARTS) {
    appendSummary(
      localLines,
      remoteLines,
      initialLocalStart,
      initialLocalEnd,
      initialRemoteStart,
      initialRemoteEnd,
      "display-budget",
      state,
    );
    state.complete = false;
    state.exhausted = true;
    return;
  }

  let localStart = initialLocalStart;
  let localEnd = initialLocalEnd;
  let remoteStart = initialRemoteStart;
  let remoteEnd = initialRemoteEnd;

  while (
    localStart < localEnd &&
    remoteStart < remoteEnd &&
    localLines[localStart] === remoteLines[remoteStart]
  ) {
    localStart++;
    remoteStart++;
  }
  while (
    localStart < localEnd &&
    remoteStart < remoteEnd &&
    localLines[localEnd - 1] === remoteLines[remoteEnd - 1]
  ) {
    localEnd--;
    remoteEnd--;
  }

  if (localStart === localEnd && remoteStart === remoteEnd) return;

  const localLength = localEnd - localStart;
  const remoteLength = remoteEnd - remoteStart;

  if (localLength === 0 || remoteLength === 0) {
    const changedLines = localLength + remoteLength;
    if (changedLines <= MAX_RENDERED_CHANGED_LINES_PER_REGION) {
      appendExactRegion(
        localLines,
        remoteLines,
        localStart,
        localEnd,
        remoteStart,
        remoteEnd,
        state,
      );
    } else {
      state.removedCount += localLength;
      state.addedCount += remoteLength;
      appendSummary(
        localLines,
        remoteLines,
        localStart,
        localEnd,
        remoteStart,
        remoteEnd,
        "change-budget",
        state,
      );
    }
    return;
  }

  if (localLength + remoteLength <= MAX_EXACT_DISPLAY_REGION_LINES) {
    if (appendExactRegion(
      localLines,
      remoteLines,
      localStart,
      localEnd,
      remoteStart,
      remoteEnd,
      state,
    )) return;
  }

  if (depth < MAX_ANCHOR_DEPTH) {
    const anchors = findPatienceAnchors(
      localLines,
      remoteLines,
      localStart,
      localEnd,
      remoteStart,
      remoteEnd,
    );
    if (anchors.length > 0) {
      let nextLocal = localStart;
      let nextRemote = remoteStart;
      for (const anchor of anchors) {
        if (nextLocal < anchor.local || nextRemote < anchor.remote) {
          collectDisplayDiff(
            localLines,
            remoteLines,
            nextLocal,
            anchor.local,
            nextRemote,
            anchor.remote,
            depth + 1,
            state,
          );
          if (state.exhausted) return;
        }
        nextLocal = anchor.local + 1;
        nextRemote = anchor.remote + 1;
      }
      if (nextLocal < localEnd || nextRemote < remoteEnd) {
        collectDisplayDiff(
          localLines,
          remoteLines,
          nextLocal,
          localEnd,
          nextRemote,
          remoteEnd,
          depth + 1,
          state,
        );
      }
      return;
    }
  }

  appendSummary(
    localLines,
    remoteLines,
    localStart,
    localEnd,
    remoteStart,
    remoteEnd,
    "alignment-limit",
    state,
  );
}

function appendExactRegion(
  localLines: string[],
  remoteLines: string[],
  localStart: number,
  localEnd: number,
  remoteStart: number,
  remoteEnd: number,
  state: DisplayDiffState,
): boolean {
  let contextBefore = 0;
  while (
    contextBefore < DISPLAY_CONTEXT_LINES &&
    localStart - contextBefore > 0 &&
    remoteStart - contextBefore > 0 &&
    localLines[localStart - contextBefore - 1] === remoteLines[remoteStart - contextBefore - 1]
  ) contextBefore++;

  let contextAfter = 0;
  while (
    contextAfter < DISPLAY_CONTEXT_LINES &&
    localEnd + contextAfter < localLines.length &&
    remoteEnd + contextAfter < remoteLines.length &&
    localLines[localEnd + contextAfter] === remoteLines[remoteEnd + contextAfter]
  ) contextAfter++;

  const expandedLocalStart = localStart - contextBefore;
  const expandedRemoteStart = remoteStart - contextBefore;
  const expandedLocalEnd = localEnd + contextAfter;
  const expandedRemoteEnd = remoteEnd + contextAfter;

  let lines: DiffLine[];
  try {
    lines = myersDiff(
      localLines.slice(expandedLocalStart, expandedLocalEnd),
      remoteLines.slice(expandedRemoteStart, expandedRemoteEnd),
    );
  } catch {
    return false;
  }

  for (const line of lines) {
    if (line.lineNumber.local != null) line.lineNumber.local += expandedLocalStart;
    if (line.lineNumber.remote != null) line.lineNumber.remote += expandedRemoteStart;
  }

  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "added") added++;
    else if (line.type === "removed") removed++;
  }

  state.addedCount += added;
  state.removedCount += removed;

  if (added + removed > MAX_RENDERED_CHANGED_LINES_PER_REGION) {
    appendSummary(
      localLines,
      remoteLines,
      localStart,
      localEnd,
      remoteStart,
      remoteEnd,
      "change-budget",
      state,
    );
    return true;
  }

  for (const hunk of compactDiffHunks(lines)) {
    state.parts.push({ kind: "hunk", lines: hunk });
  }
  return true;
}

function compactDiffHunks(lines: DiffLine[]): DiffLine[][] {
  const changedIndexes: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].type !== "equal") changedIndexes.push(index);
  }
  if (changedIndexes.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - DISPLAY_CONTEXT_LINES);
    const end = Math.min(lines.length, index + DISPLAY_CONTEXT_LINES + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }) => lines.slice(start, end));
}

function appendSummary(
  localLines: string[],
  remoteLines: string[],
  localStart: number,
  localEnd: number,
  remoteStart: number,
  remoteEnd: number,
  reason: DisplayDiffSummary["reason"],
  state: DisplayDiffState,
): void {
  if (reason === "alignment-limit") state.complete = false;
  state.parts.push({
    kind: "summary",
    reason,
    localStartLine: localStart + 1,
    localEndLine: localEnd,
    remoteStartLine: remoteStart + 1,
    remoteEndLine: remoteEnd,
    localSample: sampleLines(localLines, localStart, localEnd),
    remoteSample: sampleLines(remoteLines, remoteStart, remoteEnd),
    localOmittedLines: Math.max(0, localEnd - localStart - SUMMARY_SAMPLE_LINES_PER_SIDE),
    remoteOmittedLines: Math.max(0, remoteEnd - remoteStart - SUMMARY_SAMPLE_LINES_PER_SIDE),
  });
}

function sampleLines(lines: string[], start: number, end: number): DisplayDiffSampleLine[] {
  const length = end - start;
  if (length <= SUMMARY_SAMPLE_LINES_PER_SIDE) {
    return lines.slice(start, end).map((text, index) => ({
      lineNumber: start + index + 1,
      text,
    }));
  }

  const half = SUMMARY_SAMPLE_LINES_PER_SIDE / 2;
  return [
    ...lines.slice(start, start + half).map((text, index) => ({
      lineNumber: start + index + 1,
      text,
    })),
    ...lines.slice(end - half, end).map((text, index) => ({
      lineNumber: end - half + index + 1,
      text,
    })),
  ];
}

function findPatienceAnchors(
  localLines: string[],
  remoteLines: string[],
  localStart: number,
  localEnd: number,
  remoteStart: number,
  remoteEnd: number,
): Anchor[] {
  const localOccurrences = countOccurrences(localLines, localStart, localEnd);
  const remoteOccurrences = countOccurrences(remoteLines, remoteStart, remoteEnd);
  const pairs: Anchor[] = [];

  for (const [line, local] of localOccurrences) {
    const remote = remoteOccurrences.get(line);
    if (local.count === 1 && remote?.count === 1) {
      pairs.push({ local: local.index, remote: remote.index });
    }
  }
  pairs.sort((left, right) => left.local - right.local);
  if (pairs.length <= 1) return pairs;

  const tails: number[] = [];
  const previous = new Int32Array(pairs.length);
  previous.fill(-1);

  for (let index = 0; index < pairs.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]].remote < pairs[index].remote) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }

  const anchors: Anchor[] = [];
  let cursor = tails[tails.length - 1];
  while (cursor != null && cursor >= 0) {
    anchors.push(pairs[cursor]);
    cursor = previous[cursor];
  }
  anchors.reverse();
  return anchors;
}

function countOccurrences(
  lines: string[],
  start: number,
  end: number,
): Map<string, { count: number; index: number }> {
  const counts = new Map<string, { count: number; index: number }>();
  for (let index = start; index < end; index++) {
    const line = lines[index];
    const existing = counts.get(line);
    if (existing) existing.count++;
    else counts.set(line, { count: 1, index });
  }
  return counts;
}
