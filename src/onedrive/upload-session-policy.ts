const MIB = 1024 * 1024;

// Microsoft recommends resumable upload sessions for files larger than 4 MiB;
// keep simple PUT /content for the small-file band and switch to a resumable
// session above this threshold.
export const UPLOAD_SESSION_THRESHOLD_BYTES = 4 * MIB;
export const UPLOAD_CHUNK_ALIGNMENT_BYTES = 320 * 1024;
export const UPLOAD_CHUNK_NORMAL_BYTES = 10 * MIB;
// OneDrive keeps only fully received, alignment-multiple chunks, so the slow
// chunk must stay a 320 KiB multiple. 4 alignments (1.25 MiB) is the smallest
// step that still fits the 15 s overhead budget at the 64 KiB/s floor rate —
// a real slow link (2026-09-12: ~95–108 KiB/s) completes it and lets the
// session advance, where a 5 MiB chunk always timed out and restarted at 0.
export const UPLOAD_CHUNK_SLOW_BYTES = 4 * UPLOAD_CHUNK_ALIGNMENT_BYTES;

const UPLOAD_SLOW_CONNECTION_BYTES_PER_SECOND = 1 * MIB;
const UPLOAD_TIMEOUT_BASE_BYTES_PER_SECOND = 128 * 1024;
const UPLOAD_TIMEOUT_MIN_BYTES_PER_SECOND = 64 * 1024;
const UPLOAD_TIMEOUT_OVERHEAD_MS = 15_000;
const UPLOAD_TIMEOUT_MIN_MS = 30_000;
const UPLOAD_TIMEOUT_MAX_MS = 300_000;

export interface UploadMissingRange {
  start: number;
  endExclusive: number;
}

export function shouldUseUploadSession(fileSize: number): boolean {
  return fileSize > UPLOAD_SESSION_THRESHOLD_BYTES;
}

export function uploadSessionChunkSize(
  observedBytesPerSecond: number | null,
  recovering: boolean,
): number {
  if (
    recovering
    || observedBytesPerSecond === null
    || !Number.isFinite(observedBytesPerSecond)
    || observedBytesPerSecond <= 0
    || observedBytesPerSecond < UPLOAD_SLOW_CONNECTION_BYTES_PER_SECOND
  ) {
    return UPLOAD_CHUNK_SLOW_BYTES;
  }
  return UPLOAD_CHUNK_NORMAL_BYTES;
}

export function uploadSessionChunkTimeoutMs(
  chunkBytes: number,
  observedBytesPerSecond: number | null,
): number {
  // An unmeasured link must budget for the floor rate, not the optimistic
  // base: the first chunk doubles as the link probe, and a chunk that can
  // never land inside its budget leaves the session stuck at byte 0 forever
  // (2026-09-12: a 9.1 MiB first chunk budgeted at 128 KiB/s timed out at
  // 84.8 s on every attempt while the real link sat below ~108 KiB/s).
  const observedBudgetRate = observedBytesPerSecond !== null
    && Number.isFinite(observedBytesPerSecond)
    && observedBytesPerSecond > 0
    ? observedBytesPerSecond / 2
    : UPLOAD_TIMEOUT_MIN_BYTES_PER_SECOND;
  const budgetRate = Math.max(
    UPLOAD_TIMEOUT_MIN_BYTES_PER_SECOND,
    Math.min(UPLOAD_TIMEOUT_BASE_BYTES_PER_SECOND, observedBudgetRate),
  );
  const transferMs = Math.ceil((Math.max(0, chunkBytes) / budgetRate) * 1000);
  return Math.min(
    UPLOAD_TIMEOUT_MAX_MS,
    Math.max(UPLOAD_TIMEOUT_MIN_MS, UPLOAD_TIMEOUT_OVERHEAD_MS + transferMs),
  );
}

export function firstMissingUploadRange(
  ranges: unknown,
  totalBytes: number,
): UploadMissingRange | null {
  if (!Array.isArray(ranges) || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return null;
  }
  const parsed: UploadMissingRange[] = [];
  for (const value of ranges) {
    if (typeof value !== "string") continue;
    const match = /^(\d+)-(\d*)$/.exec(value.trim());
    if (!match) continue;
    const start = Number(match[1]);
    const inclusiveEnd = match[2] ? Number(match[2]) : totalBytes - 1;
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(inclusiveEnd)
      || start < 0
      || start >= totalBytes
      || inclusiveEnd < start
    ) {
      continue;
    }
    parsed.push({
      start,
      endExclusive: Math.min(totalBytes, inclusiveEnd + 1),
    });
  }
  parsed.sort((left, right) => left.start - right.start);
  return parsed[0] ?? null;
}

export function uploadRangeEndExclusive(
  range: UploadMissingRange,
  chunkSize: number,
  totalBytes: number,
): number {
  return Math.min(range.endExclusive, range.start + chunkSize, totalBytes);
}
