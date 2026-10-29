/** Pure window plan for the Node-https multi-range download (C 载体,
 *  user-decided 2026-09-14). Splits one file into N contiguous inclusive
 *  byte windows so each stream can be validated (206 + Content-Range) and
 *  assembled independently. Desktop-only gating and CDN-downloadUrl gating
 *  live at the call site (the downloader itself is null without Node);
 *  this module stays a pure function for direct pinning.
 *
 *  Stream count (G3, 2026-10-27): the fixed 16-stream rule is gone. The same
 *  field measurement that chose 16 (52.8 KB/s on one connection, 103–108 KB/s
 *  on two) proved a per-connection bottleneck but could not tell where the
 *  curve would flatten, or when the CDN would start throttling a burst.
 *  `range-stream-adaptation.ts` now owns a round-scoped, bidirectionally
 *  movable tier; this module only translates a requested stream count into
 *  byte-exact windows. The default stays the adaptive start tier (8), so even
 *  a caller that forgets the controller gets a safe plan rather than the old
 *  hard 16.
 *
 *  Constants: the 16 MiB Range floor keeps per-request overhead and small-file
 *  churn out (single-stream is proven below that). The 1 MiB per-stream floor
 *  keeps every window a real per-request payoff; it also caps the stream count
 *  for files smaller than 32 MiB. */

export const DOWNLOAD_RANGE_MIN_BYTES = 16 * 1024 * 1024;

/** G3 adaptive ladder: 8 → 12 → 16 → 24 → 32. Both ends are real tiers, not
 *  probes: 8 is the conservative start (the field link still had headroom at
 *  two streams, but a round-local failure costs more than a slow first file)
 *  and 32 is the ceiling that the per-connection measurement says is worth
 *  trying. The 12/24 rungs keep an aggregate-limited link from overshooting
 *  to a tier that only adds request overhead and 429 risk. The first and last
 *  entries must stay equal to the two named constants below (pinned by
 *  `tests/download-range-policy.test.ts`). */
export const DOWNLOAD_RANGE_STREAM_LADDER = [8, 12, 16, 24, 32] as const;

/** Start tier for every sync round. 16 is deliberately not a cap anymore. */
export const DOWNLOAD_RANGE_START_STREAMS = 8;

/** Upper bound of the adaptive ladder. A real cap is still required: an
 *  unbounded ramp would multiply request overhead and throttling risk while
 *  the measured link is per-connection limited. 32 keeps the same 1 MiB
 *  per-stream floor satisfiable from 32 MiB files and gives the fast-link
 *  case enough room to show whether more connections still buy throughput. */
export const DOWNLOAD_RANGE_MAX_STREAMS = 32;

/** Hard floor per stream: a stream must own at least this much, so the stream
 *  count is capped by the file size as well as by the 32-stream constant. At
 *  the 16 MiB Range threshold the default 8-stream plan gives 2 MiB per
 *  window; a 32-stream plan needs a file of at least 32 MiB. Every stream
 *  keeps a real per-request payoff instead of paying a full round trip for a
 *  sliver of the file. */
const DOWNLOAD_RANGE_MIN_STREAM_BYTES = 1024 * 1024;

/**
 * Highest ladder rung a file can actually fund at the 1 MiB per-stream floor.
 *
 * This is stricter than the window planner: `planRangeDownloadWindows` clamps
 * a requested 24 down to 20 windows for a 20 MiB file, but the ladder has no
 * 20 rung. Probing 24 there would measure a 20-stream transfer against a
 * 16-stream baseline — not the 1.5× step the adaptation thresholds assume —
 * and would leave the round at a tier the file never reached. The controller
 * therefore only probes a rung the file can fill:
 *
 *      file 16–23 MiB → index 2 (16)     file 24–31 MiB → index 3 (24)
 *      file ≥ 32 MiB  → index 4 (32)
 *
 * Returns -1 when no ladder rung fits (invalid size, or below 8 MiB). The
 * controller is only asked for files above the 16 MiB Range threshold.
 */
export function availableRangeTierIndex(fileSize: number): number {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return -1;
  const fundableStreams = Math.floor(fileSize / DOWNLOAD_RANGE_MIN_STREAM_BYTES);
  for (let index = DOWNLOAD_RANGE_STREAM_LADDER.length - 1; index >= 0; index--) {
    if (DOWNLOAD_RANGE_STREAM_LADDER[index] <= fundableStreams) return index;
  }
  return -1;
}

/** Inclusive byte window: `bytes=start-end`. */
export interface RangeWindow {
  start: number;
  end: number;
}

/**
 * Split `fileSize` into `requestedStreams` contiguous windows.
 *
 * `requestedStreams` is the adaptive tier from `range-stream-adaptation.ts`;
 * it is clamped to 1…32 and to floor(fileSize / 1 MiB). An invalid value
 * (NaN, ±Infinity, non-integer) falls back to the start tier rather than
 * producing zero or fractional windows.
 */
export function planRangeDownloadWindows(
  fileSize: number,
  requestedStreams: number = DOWNLOAD_RANGE_START_STREAMS,
): RangeWindow[] | null {
  if (!Number.isSafeInteger(fileSize) || fileSize < DOWNLOAD_RANGE_MIN_BYTES) {
    return null;
  }
  const normalizedRequest = Number.isFinite(requestedStreams)
    ? Math.floor(requestedStreams)
    : DOWNLOAD_RANGE_START_STREAMS;
  // floor(size / 1 MiB) is the largest stream count that still gives every
  // stream its 1 MiB floor; the 32-stream constant caps the adaptive ladder.
  // At the 16 MiB threshold floor(16 MiB / 1 MiB) = 16, so the start tier (8)
  // and the middle rungs are all available while 24/32 need larger files.
  const streams = Math.min(
    DOWNLOAD_RANGE_MAX_STREAMS,
    Math.max(1, normalizedRequest),
    Math.floor(fileSize / DOWNLOAD_RANGE_MIN_STREAM_BYTES),
  );
  const windowBytes = Math.floor(fileSize / streams);
  const windows: RangeWindow[] = [];
  for (let index = 0; index < streams; index++) {
    const start = index * windowBytes;
    const end = index === streams - 1
      ? fileSize - 1
      : start + windowBytes - 1;
    windows.push({ start, end });
  }
  return windows;
}
