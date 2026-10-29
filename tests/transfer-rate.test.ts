import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  deriveTransferRateFacts,
  formatTransferRate,
  transferDirectionKBps,
  TransferRateSampler,
  type TransferRateFactsV1,
  type TransferRateTickSnapshot,
} from "../src/sync/transfer-rate";

const MIB = 1024 * 1024;
const KIB = 1024;

describe("passive transfer-rate facts", () => {
  it("returns null when no transfer metrics exist", () => {
    expect(deriveTransferRateFacts({ endedAt: 1 })).toBeNull();
    expect(deriveTransferRateFacts({ endedAt: 1, fileTransfers: null })).toBeNull();
  });

  it("stores raw per-direction accumulations on the busy wall clock", () => {
    expect(deriveTransferRateFacts({
      endedAt: 100,
      fileTransfers: {
        // Eight concurrent 1 s PUTs are 1 s of busy time, not 8 s: the
        // denominator is what keeps the round's rate from being divided by
        // the pool depth.
        upload: { logicalBytes: 2 * MIB, busyMs: 4000 },
        download: { logicalBytes: MIB, busyMs: 8000 },
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
        upload: { logicalBytes: 0, busyMs: 0 },
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

  it("reads sub-1 KB/s honestly instead of clamping to 1 KB/s", () => {
    // 用户拍板 2026-09-13: 宁愿不要显示，不能显示个错的 — a measured 0.4 KB/s
    // must not present itself as "1 KB/s"; 0.5–1.49 stays honest rounding.
    expect(formatTransferRate(0)).toBe("<1 KB/s");
    expect(formatTransferRate(0.4)).toBe("<1 KB/s");
    expect(formatTransferRate(0.5)).toBe("1 KB/s");
    expect(formatTransferRate(1.4)).toBe("1 KB/s");
    expect(formatTransferRate(1.5)).toBe("2 KB/s");
  });
});

const snapshot = (
  uploadBytes: number,
  uploadMs: number,
  downloadBytes = 0,
  downloadMs = 0,
): TransferRateTickSnapshot => ({
  upload: { bytes: uploadBytes, ms: uploadMs },
  download: { bytes: downloadBytes, ms: downloadMs },
});

describe("transfer rate sampler (live reading)", () => {
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
    noisy.addRoundFacts({ uploadBytes: MIB, uploadMs: 1000, measuredAt: 11_000 });
    // 1 s burst inside a 10 s wall gap: confidence = 1 s / 2 s cap → half
    // the pull of a sample that transferred the whole capped window.
    expect(noisy.getReading(11_000)!.kbps).toBe(747);

    const confident = new TransferRateSampler();
    confident.addRoundFacts({ uploadBytes: 2 * MIB, uploadMs: 4000, measuredAt: 1000 });
    confident.addRoundFacts({ uploadBytes: 4 * MIB, uploadMs: 4000, measuredAt: 11_000 });
    // Same wall gap, full 4 s sample: confidence saturated → strong pull.
    expect(confident.getReading(11_000)!.kbps).toBe(982);
  });

  it("tracks a sustained transfer at the designed per-second cadence", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    sampler.sampleRunTick(snapshot(MIB, 1000), 1000);
    // Four further seconds at 64 KB/s, sampled once a second: each tick
    // covers its whole wall window, so confidence must not halve it and the
    // figure lands near the true rate after τ has passed (the halved
    // cadence this replaces left it at ~665 — twice the designed lag).
    for (let i = 2; i <= 5; i++) {
      sampler.sampleRunTick(
        snapshot(MIB + (i - 1) * 64 * 1024, 1000 + (i - 1) * 1000),
        i * 1000,
      );
    }
    expect(sampler.getReading(5000)!.kbps).toBe(417);
  });

  it("does not move the figure on a round too small to judge the link", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ uploadBytes: 4 * MIB, uploadMs: 4000, measuredAt: 1000 });
    expect(sampler.getReading(1000)!.kbps).toBe(1024);
    // 2 KB over 300 ms reads ~7 KB/s and carries 2 KB of payload: that is one
    // note's request cost, not the link. It must not move the bottom figure
    // (用户拍板 2026-10-27: 不准确就不显示；旧实现让每个小轮都拉动读数).
    sampler.addRoundFacts({ uploadBytes: 2048, uploadMs: 300, measuredAt: 2000 });
    expect(sampler.getReading(2000)).toEqual({ level: "high", kbps: 1024 });
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
    expect(sampler.getReading(2000)!.kbps).toBe(911);
  });

  it("levels the reading by the worse direction while both sample together", () => {
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

  it("quotes the actively transferring direction, not an idle slower one", () => {
    const sampler = new TransferRateSampler();
    // Upload measured 20 s ago at 64 KB/s — still inside the freshness
    // window, but nothing has uploaded since.
    sampler.addRoundFacts({
      uploadBytes: 64 * 16 * 1024,
      uploadMs: 16_000,
      measuredAt: 180_000,
    });
    // A download now streaming at 1 MiB/s must own the figure: the sync
    // rounds alternate upload/download phases, and letting the idle
    // direction's older rate cap the live one displayed the previous
    // phase's speed for minutes (the perception gap this fixes).
    sampler.beginRun();
    sampler.sampleRunTick(
      { upload: { bytes: 0, ms: 0 }, download: { bytes: MIB, ms: 1000 } },
      200_000,
    );
    expect(sampler.getReading(200_000)).toEqual({ level: "high", kbps: 1024 });
  });

  it("idle reading quotes the latest measured direction, not the worse one", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({
      uploadBytes: 64 * 16 * 1024,
      uploadMs: 16_000,
      measuredAt: 180_000,
    });
    sampler.addRoundFacts({
      downloadBytes: 4 * MIB,
      downloadMs: 4000,
      measuredAt: 300_000,
    });
    // Both directions fresh, neither transferring now: the last speed
    // actually observed is the download — quoting the worse direction
    // instead would yank the figure down the moment a transfer ends.
    expect(sampler.getReading(310_000)).toEqual({ level: "high", kbps: 1024 });
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
    // Past the freshness window there is no current speed to quote —
    // a stale figure presented as current would be wrong, so the reading
    // disappears (用户拍板: 宁愿不要显示，不能显示个错的; 同日指示窗口
    // 收紧为 10 秒).
    expect(sampler.getReading(1_300_001)).toBeNull();
  });

  it("hides the reading ten seconds after the last real transfer", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ uploadBytes: 2 * MIB, uploadMs: 4000, measuredAt: 1000 });
    // Exactly 10 s after the last fold the reading is still quotable…
    expect(sampler.getReading(11_000)).toEqual({ level: "medium", kbps: 512 });
    // …one tick past it there is nothing current left to show (用户指示
    // 2026-09-13: 消失窗口 10 分钟 → 10 秒).
    expect(sampler.getReading(11_001)).toBeNull();
  });

  it("lets a stale zero signal expire instead of painting red forever", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ uploadMs: 6000, measuredAt: 1_000 });
    expect(sampler.getReading(1_000)).toEqual({ level: "zero", kbps: null });
    expect(sampler.getReading(601_001)).toBeNull();
  });
});

describe("connection-speed sample quality (bottom reading gate)", () => {
  // 用户拍板 2026-10-27：底部连接速度不准确就不显示。现役小文件场景（每个
  // 18 B、内容传输约 420 ms/文件）里 Δbytes/Δbusy 量的是每请求固定成本，不是
  // 链路；这一组把「什么时候可以显示」钉成可观察行为。
  const GATE = 256 * 1024;
  const noteBytes = 18;
  const noteMs = 420;
  const noteFiles = 2001;

  it("keeps the reading hidden for a 2,001-note library (18 B per file)", () => {
    // 2,001 × 18 B = 36,018 B：整套库的载荷只有 35.2 KiB，低于一个可判断链路
    // 的 256 KiB 门槛 7.3 倍，因此小文件库永远不产生底部读数。
    expect(noteFiles * noteBytes).toBe(36_018);
    expect(noteFiles * noteBytes).toBeLessThan(GATE);

    const sampler = new TransferRateSampler();
    sampler.beginRun();
    // Per-round facts of a note sync: 0.04 KB/s (one 420 ms request per file).
    sampler.addRoundFacts({
      uploadBytes: noteFiles * noteBytes,
      uploadMs: noteFiles * noteMs,
      measuredAt: 1000,
    });
    expect(sampler.getReading(1000)).toBeNull();

    // Per-second ticks of the same run: the desktop pool settles 8 notes per
    // second = 144 B over ~1 s of busy time (0.14 KB/s). Neither shape may
    // become a figure.
    let at = 2000;
    let bytes = 0;
    for (let second = 0; second < noteFiles / 8; second++) {
      at += 1000;
      bytes += 8 * noteBytes;
      sampler.sampleRunTick(snapshot(bytes, second * 1000 + 1000), at);
    }
    expect(bytes).toBeLessThan(GATE);
    expect(sampler.getReading(at)).toBeNull();
    expect(sampler.getDirectionKBps("upload", at)).toBeNull();
  });

  it("shows the reading once one accumulated sample reaches 256 KiB", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    // 64 KiB per second of payload = 64 KB/s: a real link, but each single
    // tick is below the byte gate, so the figure waits for the accumulated
    // sample (the slow-link case a per-tick byte gate would wrongly hide).
    for (let second = 1; second <= 3; second++) {
      sampler.sampleRunTick(snapshot(second * 64 * KIB, second * 1000), second * 1000);
      expect(sampler.getReading(second * 1000)).toBeNull();
    }
    sampler.sampleRunTick(snapshot(256 * KIB, 4000), 4000);
    expect(sampler.getReading(4000)).toEqual({ level: "medium", kbps: 64 });
  });

  it("quotes a slow but payload-dominated link after one full sample", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    // 40 KB/s sits in the low band and above the 25.6 KB/s admission floor
    // (256 KiB per 10 s freshness window): it shows, after 7 s of payload.
    for (let second = 1; second <= 6; second++) {
      sampler.sampleRunTick(snapshot(second * 40 * KIB, second * 1000), second * 1000);
      expect(sampler.getReading(second * 1000)).toBeNull();
    }
    sampler.sampleRunTick(snapshot(7 * 40 * KIB, 7000), 7000);
    expect(sampler.getReading(7000)).toEqual({ level: "low", kbps: 40 });
  });

  it("does not let a note phase drag a big file's reading down", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    // Twenty seconds of 8-concurrent 18 B notes: 2.9 KiB of payload over 20 s
    // of per-request time. Their busy time must never enter a 1 MiB/s sample.
    let bytes = 0;
    for (let second = 1; second <= 20; second++) {
      bytes += 8 * noteBytes;
      sampler.sampleRunTick(snapshot(bytes, second * 1000), second * 1000);
    }
    expect(sampler.getReading(20_000)).toBeNull();
    sampler.sampleRunTick(snapshot(bytes + MIB, 21_000), 21_000);
    expect(sampler.getReading(21_000)).toEqual({ level: "high", kbps: 1024 });
  });

  it("hides a slow link whose samples cannot fill inside the freshness window", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    // 10 KB/s: 256 KiB needs ~26 s to accumulate, longer than the 10 s the
    // reading may stay on screen — showing it would blink on and off. Below
    // the derived 25.6 KB/s floor every contribution is rejected.
    let at = 0;
    let bytes = 0;
    for (let second = 1; second <= 40; second++) {
      at = second * 1000;
      bytes += 10 * KIB;
      sampler.sampleRunTick(snapshot(bytes, at), at);
    }
    expect(sampler.getReading(at)).toBeNull();
  });

  it("hides again ten seconds after the last payload-sized sample", () => {
    const sampler = new TransferRateSampler();
    sampler.addRoundFacts({ downloadBytes: MIB, downloadMs: 1000, measuredAt: 1000 });
    expect(sampler.getReading(11_000)?.kbps).toBe(1024);
    expect(sampler.getReading(11_001)).toBeNull();
  });
});

describe("busy wall clock (combined throughput, not per stream)", () => {
  it("reads two parallel 1 MiB calls settling in the same second as 2 MiB/s", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    // Two 1 MiB calls, each taking 1 s, overlapping exactly. Busy wall clock
    // = 1 s (not the 2 s sum of their own durations), so the combined
    // throughput is 2 MiB/s. The sum-of-durations denominator this replaces
    // read 1024 — one stream — and made a deeper pool look slower instead of
    // faster (「一」23④ candidate).
    sampler.sampleRunTick(snapshot(2 * MIB, 1000), 1000);
    expect(sampler.getReading(1000)).toEqual({ level: "high", kbps: 2048 });
  });

  it("tracks the current network within seconds during small-file sync", () => {
    const sampler = new TransferRateSampler();
    // The earlier reading (2 KB over 2 s = 1 KB/s) is far below the admission
    // floor, so it never seeds the figure; the number must come from the
    // current link's own payload-sized sample.
    sampler.addRoundFacts({ uploadBytes: 2048, uploadMs: 2000, measuredAt: 29_000 });
    expect(sampler.getReading(29_000)).toBeNull();
    // Fast link now: 8 KB calls completing in 100 ms, and the run's busy
    // clock advances by those 100 ms only (idle time between calls never
    // enters the denominator). One tick per second over 8 s.
    let at = 30_000;
    let bytes = 0;
    for (let i = 0; i < 8; i++) {
      at += 1000;
      bytes += 8 * 8192;
      sampler.sampleRunTick(snapshot(bytes, 100 * (i + 1)), at);
    }
    const reading = sampler.getReading(at);
    // Four ticks (256 KiB of payload) fill one quotable sample ≈ 4 s in; the
    // figure is the link's 640 KB/s, not one small request's cost.
    expect(reading?.level).toBe("medium");
    expect(reading?.kbps).toBe(640);
  });

  it("clears a fresh zero signal once real bytes come through", () => {
    const sampler = new TransferRateSampler();
    sampler.beginRun();
    sampler.sampleRunTick(
      { upload: { bytes: 0, ms: 6000 }, download: { bytes: 0, ms: 0 } },
      1000,
    );
    expect(sampler.getReading(1500)).toMatchObject({ level: "zero" });
    // A trickle of bytes clears the red signal at once, but it does not become
    // a speed reading: only a payload-sized sample may quote a rate.
    sampler.sampleRunTick(snapshot(4096, 6500), 2000);
    expect(sampler.getReading(2500)).toBeNull();
    sampler.sampleRunTick(snapshot(4096 + 512 * KIB, 7500), 3000);
    const reading = sampler.getReading(3000);
    expect(reading?.level).not.toBe("zero");
    expect(reading?.kbps).toBe(512);
  });

  it("keeps the busy clock wired from the executor transfer path into the plugin", () => {
    const executorSource = readFileSync("src/sync/sync-executor.ts", "utf8");
    // The executor owns the only busy clock: it opens on the first byte of a
    // transfer, closes when the last one settles, and books wall time (never
    // the sum of the calls) into the run's per-direction metrics.
    expect(executorSource).toContain("busyMs");
    expect(executorSource).toContain("private beginTransferBusy(");
    expect(executorSource).toContain("private endTransferBusy(");
    expect(executorSource).toContain("private busyWallClockMs(");
    // No per-call sample channel: while calls overlap, folding each one at its
    // own bytes/wall quotes a single stream instead of the combined rate.
    expect(executorSource).not.toContain("onTransferCallSample");
    expect(executorSource).not.toContain("TransferCallSample");
    const rateSource = readFileSync("src/sync/transfer-rate.ts", "utf8");
    expect(rateSource).not.toContain("addCallSample");
    const mainSource = readFileSync("src/main.ts", "utf8");
    expect(mainSource).not.toContain("addCallSample");
  });

  it("keeps the transfer-rate sampler session-local (no persisted window)", () => {
    // 2026-10-24 retirement: the persisted facts window and its reload
    // seeding had no reachable consumer (the 10s freshness window means a
    // seed can never conjure a post-reload reading). The per-round facts
    // survive only embedded in sync-history entries; the sampler's smoothed
    // state starts from zero each session.
    for (const sourcePath of [
      "src/main.ts",
      "src/sync/state-manager.ts",
      "src/sync/transfer-rate.ts",
    ]) {
      const source = readFileSync(sourcePath, "utf8");
      expect(source, sourcePath).not.toContain("easy-sync-transfer-rates-window");
      expect(source, sourcePath).not.toContain("pushTransferRateFacts");
      expect(source, sourcePath).not.toContain("seedFromFacts");
      expect(source, sourcePath).not.toContain("transferRateSamplerSeeded");
    }
  });
});
