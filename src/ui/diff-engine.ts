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
export function computeDiff(localText: string, remoteText: string): DiffResult {
  const localLines = localText.split("\n");
  const remoteLines = remoteText.split("\n");

  // Truncate check — return raw samples, no fake diff
  if (localLines.length + remoteLines.length > MAX_TOTAL_LINES) {
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
