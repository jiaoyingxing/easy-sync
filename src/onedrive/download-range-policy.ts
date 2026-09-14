/** Pure window plan for the Node-https multi-range download (C 载体,
 *  user-decided 2026-09-14). Splits one file into N contiguous inclusive
 *  byte windows so each stream can be validated (206 + Content-Range) and
 *  assembled independently. Desktop-only gating and CDN-downloadUrl gating
 *  live at the call site (the downloader itself is null without Node);
 *  this module stays a pure function for direct pinning.
 *
 *  Constants: 16 MiB floor keeps per-request overhead and small-file churn
 *  out (single-stream is proven below that); 2 streams = the conservative
 *  first rung — the evening 2026-09-14 probe window could not calibrate a
 *  higher stream count (CDN data plane was stalling across the board), so
 *  the count stays a constant until a healthy-window matrix says otherwise. */

export const DOWNLOAD_RANGE_MIN_BYTES = 16 * 1024 * 1024;
export const DOWNLOAD_RANGE_STREAMS = 2;

/** Inclusive byte window: `bytes=start-end`. */
export interface RangeWindow {
  start: number;
  end: number;
}

export function planRangeDownloadWindows(fileSize: number): RangeWindow[] | null {
  if (!Number.isSafeInteger(fileSize) || fileSize < DOWNLOAD_RANGE_MIN_BYTES) {
    return null;
  }
  const streams = DOWNLOAD_RANGE_STREAMS;
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
