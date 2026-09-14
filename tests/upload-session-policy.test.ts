import { describe, expect, it } from "vitest";
import {
  UPLOAD_CHUNK_ALIGNMENT_BYTES,
  UPLOAD_CHUNK_NORMAL_BYTES,
  UPLOAD_CHUNK_SLOW_BYTES,
  UPLOAD_SESSION_THRESHOLD_BYTES,
  firstMissingUploadRange,
  shouldUseUploadSession,
  uploadRangeEndExclusive,
  uploadSessionChunkSize,
  uploadSessionChunkTimeoutMs,
} from "../src/onedrive/upload-session-policy";

describe("OneDrive upload-session policy", () => {
  it("uses resumable upload above 4 MiB", () => {
    expect(shouldUseUploadSession(UPLOAD_SESSION_THRESHOLD_BYTES)).toBe(false);
    expect(shouldUseUploadSession(UPLOAD_SESSION_THRESHOLD_BYTES + 1)).toBe(true);
  });

  it("probes an unknown link with aligned slow chunks, then adapts to the observed rate", () => {
    // An unknown rate is exactly the slow-link case: the first chunk must be
    // small enough to land (progress + rate learning) instead of betting the
    // whole file on the optimistic 128 KiB/s assumption.
    expect(uploadSessionChunkSize(null, false)).toBe(UPLOAD_CHUNK_SLOW_BYTES);
    expect(uploadSessionChunkSize(20 * 1024 * 1024 / 8, false)).toBe(UPLOAD_CHUNK_NORMAL_BYTES);
    expect(uploadSessionChunkSize(5 * 1024 * 1024 / 8, false)).toBe(UPLOAD_CHUNK_NORMAL_BYTES);
    expect(uploadSessionChunkSize(null, true)).toBe(UPLOAD_CHUNK_SLOW_BYTES);
    expect(UPLOAD_CHUNK_NORMAL_BYTES % UPLOAD_CHUNK_ALIGNMENT_BYTES).toBe(0);
    expect(UPLOAD_CHUNK_SLOW_BYTES % UPLOAD_CHUNK_ALIGNMENT_BYTES).toBe(0);
  });

  it("promotes healthy links to the large normal chunk that fits the timeout cap", () => {
    // 2026-09-14: the normal chunk absorbs the ~0.9 s per-request server
    // overhead measured in the 2026-09-13 logs (probe chunks read ~1.0 MiB/s
    // while 10 MiB chunks ran ~3 MiB/s on one link). The size is capped by
    // the 300 s timeout ceiling under the 128 KiB/s floor budget rate:
    // 30 MiB = 15 s overhead + 240 s transfer = 255 s, with 45 s margin.
    // 30 MiB is exactly 96 × 320 KiB alignments (official hard constraints:
    // 320 KiB multiple, < 60 MiB per request).
    const KiB = 1024;
    expect(UPLOAD_CHUNK_NORMAL_BYTES).toBe(30 * 1024 * 1024);
    expect(UPLOAD_CHUNK_NORMAL_BYTES % UPLOAD_CHUNK_ALIGNMENT_BYTES).toBe(0);
    expect(uploadSessionChunkSize(256 * KiB, false)).toBe(UPLOAD_CHUNK_NORMAL_BYTES);
    expect(uploadSessionChunkSize(1 * 1024 * 1024, false)).toBe(UPLOAD_CHUNK_NORMAL_BYTES);
    // The 300 s cap must never clip a promoted chunk's own budget at the
    // floor rate; otherwise healthy-but-slow links would time out mid-flight.
    expect(
      uploadSessionChunkTimeoutMs(UPLOAD_CHUNK_NORMAL_BYTES, 256 * KiB),
    ).toBe(255_000);
    expect(
      uploadSessionChunkTimeoutMs(UPLOAD_CHUNK_NORMAL_BYTES, 20 * 1024 * 1024),
    ).toBe(255_000);
  });

  it("keeps the slow gate below healthy probe readings and above true slow links", () => {
    // 2026-09-13 real-link evidence: on one link, 1.25 MiB probe chunks read
    // ~1.0 MiB/s while 10 MiB chunks the same minute ran ~2.5–3.1 MiB/s — the
    // per-request fixed cost (~0.9 s) biases small-chunk readings low. The
    // old 1 MiB/s gate sat inside that bias band and pinned healthy links
    // (probe readings 317 KiB/s–1 MiB/s) at 1.25 MiB chunks for 3–5× losses.
    // The gate must stay above real slow-patch probes but map healthy probes
    // to true rates that land a 10 MiB chunk inside its own transfer budget.
    const KiB = 1024;
    expect(uploadSessionChunkSize(92 * KiB, false)).toBe(UPLOAD_CHUNK_SLOW_BYTES);
    expect(uploadSessionChunkSize(96 * KiB, false)).toBe(UPLOAD_CHUNK_SLOW_BYTES);
    expect(uploadSessionChunkSize(256 * KiB - 1, false)).toBe(UPLOAD_CHUNK_SLOW_BYTES);
    expect(uploadSessionChunkSize(256 * KiB, false)).toBe(UPLOAD_CHUNK_NORMAL_BYTES);
    expect(uploadSessionChunkSize(317 * KiB, false)).toBe(UPLOAD_CHUNK_NORMAL_BYTES);
    expect(uploadSessionChunkSize(1044 * KiB, false)).toBe(UPLOAD_CHUNK_NORMAL_BYTES);
  });

  it("budgets an unmeasured first chunk at the floor rate, not the optimistic base", () => {
    // 2026-09-12 real failure: a 9.1 MiB single-chunk PUT budgeted at 128 KiB/s
    // timed out at 84.8 s on every attempt while the real link sat below
    // ~108 KiB/s. The floor-rate budget keeps a slow-but-alive chunk landing.
    expect(
      uploadSessionChunkTimeoutMs(UPLOAD_CHUNK_SLOW_BYTES, null),
    ).toBe(15_000 + UPLOAD_CHUNK_SLOW_BYTES / (64 * 1024) * 1000);
    // A measured link still uses the measured rate (halved, clamped to the
    // 64–128 KiB/s band): 5 MiB at 2 MiB/s → half rate clamps to 128 KiB/s.
    expect(
      uploadSessionChunkTimeoutMs(5 * 1024 * 1024, 2 * 1024 * 1024),
    ).toBe(55_000);
  });

  it.each([
    [10, 1], [50, 1], [250, 1], [500, 1],
    [10, 5], [50, 5], [250, 5], [500, 5],
    [10, 20], [50, 20], [250, 20], [500, 20],
  ])("budgets a %i MiB file at %i Mbps without a fixed 45s chunk ceiling", (fileMiB, mbps) => {
    const fileBytes = fileMiB * 1024 * 1024;
    const bytesPerSecond = mbps * 1024 * 1024 / 8;
    const chunkSize = uploadSessionChunkSize(bytesPerSecond, false);
    const timeoutMs = uploadSessionChunkTimeoutMs(chunkSize, bytesPerSecond);
    const expectedTransferMs = chunkSize / bytesPerSecond * 1000;
    const plannedChunks = Math.ceil(fileBytes / chunkSize);

    expect(timeoutMs).toBeGreaterThan(expectedTransferMs);
    expect(timeoutMs).toBeLessThanOrEqual(300_000);
    expect(plannedChunks).toBeGreaterThan(0);
    expect(plannedChunks * chunkSize).toBeGreaterThanOrEqual(fileBytes);
  });

  it("selects the earliest bounded missing range and caps the next fragment", () => {
    const total = 50 * 1024 * 1024;
    const range = firstMissingUploadRange(
      ["20971520-31457279", "10485760-20971519"],
      total,
    );

    expect(range).toEqual({ start: 10 * 1024 * 1024, endExclusive: 20 * 1024 * 1024 });
    expect(uploadRangeEndExclusive(range!, UPLOAD_CHUNK_SLOW_BYTES, total))
      .toBe(10 * 1024 * 1024 + UPLOAD_CHUNK_SLOW_BYTES);
  });

  it("rejects malformed or out-of-bounds session ranges", () => {
    expect(firstMissingUploadRange(["bad", "-", "999-"], 100)).toBeNull();
    expect(firstMissingUploadRange(undefined, 100)).toBeNull();
  });
});
