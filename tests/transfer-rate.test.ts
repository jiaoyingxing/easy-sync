import { describe, expect, it } from "vitest";
import {
  deriveTransferRateFacts,
  formatTransferRate,
  transferDirectionKBps,
  TransferRateSampler,
  type TransferRateFactsV1,
  type TransferRateTickSnapshot,
} from "../src/sync/transfer-rate";

const MIB = 1024 * 1024;

describe("passive transfer-rate facts", () => {
  it("returns null when no transfer metrics exist", () => {
    expect(deriveTransferRateFacts({ endedAt: 1 })).toBeNull();
    expect(deriveTransferRateFacts({ endedAt: 1, fileTransfers: null })).toBeNull();
  });

  it("stores raw per-direction accumulations", () => {
    expect(deriveTransferRateFacts({
      endedAt: 100,
      fileTransfers: {
        upload: { logicalBytes: 2 * MIB, stagesMs: { contentTransfer: 4000 } },
        download: { logicalBytes: MIB, stagesMs: { contentTransfer: 8000 } },
      },
    })).toEqual({
      uploadBytes: 2 * MIB,
      uploadMs: 4000,
      downloadBytes: MIB,
      downloadMs: 8000,
      measuredAt: 100,
    });
  });

  it("returns null for rounds that moved nothing at all", () => {
    expect(deriveTransferRateFacts({
      endedAt: 1,
      fileTransfers: {
        upload: { logicalBytes: 0, stagesMs: { contentTransfer: 0 } },
      },
    })).toBeNull();
  });

  it("derives per-round direction rates for the report table", () => {
    expect(transferDirectionKBps(
      { uploadBytes: 2 * MIB, uploadMs: 4000, measuredAt: 1 },
      "upload",
    )).toBe(512);
    expect(transferDirectionKBps(
      { uploadBytes: 2048, uploadMs: 300, measuredAt: 1 },
      "upload",
    )).toBe(7);
    expect(transferDirectionKBps(
      { uploadMs: 6000, measuredAt: 1 },
      "upload",
    )).toBeNull();
  });

  it("formats compact human units", () => {
    expect(formatTransferRate(64)).toBe("64 KB/s");
    expect(formatTransferRate(512)).toBe("512 KB/s");
    expect(formatTransferRate(1024)).toBe("1.0 MB/s");
    expect(formatTransferRate(2560)).toBe("2.5 MB/s");
  });
});

describe("transfer rate sampler (live reading)", () => {
  const snapshot = (
    uploadBytes: number,
    uploadMs: number,
    downloadBytes = 0,
    downloadMs = 0,
  ): TransferRateTickSnapshot => ({
    upload: { bytes: uploadBytes, ms: uploadMs },
    download: { bytes: downloadBytes, ms: downloadMs },
  });

  it("seeds the reading outright from the first sample", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ uploadBytes: 2 * MIB, uploadMs: 4000, measuredAt: 1000 });
    // 2 MiB over 4 s = 512 KB/s.
    expect(sampler.getReading(1000)).toEqual({ level: "medium", kbps: 512 });
  });

  it("folds run ticks as an EWMA toward the newest throughput", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    sampler.sampleRunTick(snapshot(MIB, 1000), 1000);
    // 1 MiB / 1 s = 1024 KB/s seeds the figure.
    expect(sampler.getReading(1000)).toEqual({ level: "high", kbps: 1024 });
    // Δbytes = 0.25 MiB over Δms = 4 s → 64 KB/s; wall Δt = τ → α ≈ 0.632.
    sampler.sampleRunTick(snapshot(1.25 * MIB, 5000), 5000);
    expect(sampler.getReading(5000)).toEqual({ level: "medium", kbps: 417 });
  });

  it("weights short bursts less than confident samples", () => {
    const noisy = new TransferRateSampler();
    noisy.addRoundFacts({ uploadBytes: 2 * MIB, uploadMs: 4000, measuredAt: 1000 });
    noisy.addRoundFacts({ uploadBytes: MIB, uploadMs: 1000, measuredAt: 2000 });
    // 1 s burst at 1024 KB/s: α = 0.221 × 0.5 (confidence) → small pull.
    expect(noisy.getReading(2000)!.kbps).toBe(569);

    const confident = new TransferRateSampler();
    confident.addRoundFacts({ uploadBytes: 2 * MIB, uploadMs: 4000, measuredAt: 1000 });
    confident.addRoundFacts({ uploadBytes: 4 * MIB, uploadMs: 4000, measuredAt: 2000 });
    // Same wall gap, full 4 s sample: α = 0.221 → stronger pull toward 1024.
    expect(confident.getReading(2000)!.kbps).toBe(625);
  });

  it("moves the figure on every round with bytes — even tiny ones", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ uploadBytes: 4 * MIB, uploadMs: 4000, measuredAt: 1000 });
    expect(sampler.getReading(1000)!.kbps).toBe(1024);
    // A 2 KB note round reads ~7 KB/s on its own; the fold moves the figure
    // visibly instead of freezing it (the windowed cumulative average this
    // replaces would have left the number effectively unchanged).
    sampler.addRoundFacts({ uploadBytes: 2048, uploadMs: 300, measuredAt: 2000 });
    expect(sampler.getReading(2000)).toEqual({ level: "medium", kbps: 990 });
  });

  it("reads zero when a direction burns time without bytes, and recovers", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ uploadMs: 6000, measuredAt: 1000 });
    expect(sampler.getReading(1000)).toEqual({ level: "zero", kbps: null });
    sampler.addRoundFacts({ uploadBytes: MIB, uploadMs: 1000, measuredAt: 2000 });
    expect(sampler.getReading(2000)!.level).toBe("high");
  });

  it("resets tick baselines when a new run begins", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    sampler.sampleRunTick(snapshot(MIB, 1000), 1000);
    sampler.beginRun();
    // Cumulative counters restart from zero on the new run: the tick must
    // read Δ = 512 KiB / 1 s, not a clamped negative delta against the old
    // run's totals (which would fold nothing and freeze the figure).
    sampler.sampleRunTick(snapshot(512 * 1024, 1000), 2000);
    expect(sampler.getReading(2000)!.kbps).toBe(967);
  });

  it("reseeds from the persisted window, newest entry dominating", () => {
    const sampler = new TransferRateSampler();
    // Stored newest first, as the state window keeps them.
    sampler.seedFromFacts([
      { uploadBytes: MIB, uploadMs: 1000, measuredAt: 5000 },
      { uploadBytes: 2 * MIB, uploadMs: 4000, measuredAt: 4000 },
    ]);
    expect(sampler.getReading(5000)!.kbps).toBe(569);
  });

  it("converts legacy derived-KBps entries while seeding", () => {
    const sampler = new TransferRateSampler();
    sampler.seedFromFacts([
      { uploadKBps: 128, downloadKBps: 64, measuredAt: 100 } as TransferRateFactsV1,
    ]);
    expect(sampler.getDirectionKBps("upload", 100)).toBe(128);
    expect(sampler.getDirectionKBps("download", 100)).toBe(64);
    expect(sampler.getReading(100)!.level).toBe("medium");
  });

  it("levels the reading by the worse direction", () => {
    const round = (upload: number | undefined, download: number | undefined) => ({
      uploadBytes: upload === undefined ? undefined : upload * 16 * 1024,
      uploadMs: upload === undefined ? undefined : 16_000,
      downloadBytes: download === undefined ? undefined : download * 16 * 1024,
      downloadMs: download === undefined ? undefined : 16_000,
      measuredAt: 1,
    });
    const read = (upload: number | undefined, download: number | undefined) => {
      const sampler = new TransferRateSampler();
      sampler.addRoundFacts(round(upload, download));
      return sampler.getReading(1);
    };
    expect(read(2048, 512)!.level).toBe("medium");
    expect(read(undefined, 2048)!.level).toBe("high");
    expect(read(63, undefined)!.level).toBe("low");
    expect(read(1024, undefined)!.level).toBe("high");
  });

  it("excludes stale directions; hides once nothing is fresh", () => {
    const sampler = new TransferRateSampler();
    // A slow download measured long ago…
    sampler.addRoundFacts({
      downloadBytes: 64 * 16 * 1024,
      downloadMs: 16_000,
      measuredAt: 1_000,
    });
    // …must not pin the figure when upload moves bytes much later: the
    // stale direction drops out instead of freezing the display (the
    // frozen stale figure was the defect this redesign removes).
    sampler.addRoundFacts({ uploadBytes: 4 * MIB, uploadMs: 4000, measuredAt: 700_000 });
    expect(sampler.getReading(700_000)).toEqual({ level: "high", kbps: 1024 });
    // Ten minutes past the last sample there is no current speed to quote —
    // a stale figure presented as current would be wrong, so the reading
    // disappears (用户拍板: 宁愿不要显示，不能显示个错的).
    expect(sampler.getReading(1_300_001)).toBeNull();
  });

  it("lets a stale zero signal expire instead of painting red forever", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ uploadMs: 6000, measuredAt: 1_000 });
    expect(sampler.getReading(1_000)).toEqual({ level: "zero", kbps: null });
    expect(sampler.getReading(601_001)).toBeNull();
  });
});
