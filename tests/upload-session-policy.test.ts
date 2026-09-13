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
    expect(uploadSessionChunkSize(5 * 1024 * 1024 / 8, false)).toBe(UPLOAD_CHUNK_SLOW_BYTES);
    expect(uploadSessionChunkSize(null, true)).toBe(UPLOAD_CHUNK_SLOW_BYTES);
    expect(UPLOAD_CHUNK_NORMAL_BYTES % UPLOAD_CHUNK_ALIGNMENT_BYTES).toBe(0);
    expect(UPLOAD_CHUNK_SLOW_BYTES % UPLOAD_CHUNK_ALIGNMENT_BYTES).toBe(0);
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
