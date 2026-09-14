/**
 * Passive transfer-rate facts: connection speed measured from bytes that real
 * sync transfers already moved — no probe requests, no new traffic.
 *
 * Two layers:
 * - Per-round RAW accumulations (`TransferRateFactsV1`: bytes plus
 *   content-transfer ms per direction) are persisted in a small window and on
 *   history entries. They are the honest ledger: the diagnostic report's
 *   per-round table reads them, and they seed the live reading's smoothing
 *   prior after a reload.
 * - The displayed reading (`TransferRateSampler`) follows standard
 *   connection-speed display practice: sample real byte movement on a fixed
 *   cadence, smooth with an exponential moving average so every transfer
 *   visibly moves the figure, and let fresh measurements dominate stale ones.
 *   Any byte in a sample yields a reading — the user prefers a moving number
 *   over a hidden one — while a direction that burned transfer time without
 *   moving a byte reads as `zero` (attempted, nothing came through).
 */

export interface TransferRateFactsV1 {
  uploadBytes?: number;
  uploadMs?: number;
  downloadBytes?: number;
  downloadMs?: number;
  measuredAt: number;
}

export type TransferSignalLevel = "zero" | "low" | "medium" | "high";

type TransferRateDirection = "upload" | "download";

/** Below this the link sits under the upload timeout-budget floor band. */
const TRANSFER_RATE_LOW_KBPS = 64;
/** Above this a home broadband link to OneDrive is comfortably fast. */
const TRANSFER_RATE_MEDIUM_KBPS = 1024;
/** Any byte in a window yields a reading: the user prefers a moving number
 *  over a hidden one (用户拍板), so the floor is a single byte. */
const TRANSFER_RATE_MIN_BYTES = 1;
/** Transfer time spent without a single logical byte counts as unreachable. */
const TRANSFER_ZERO_MS = 5_000;

/** Time constant of the reading's exponential smoothing: with this much wall
 *  time between samples, a new sample roughly two-thirds replaces the figure.
 *  Short of it, samples blend; long after it, fresh measurements dominate. */
const TRANSFER_RATE_SMOOTHING_TAU_MS = 4_000;
/** Samples with less transfer time than this are noisy speed estimates and
 *  get proportionally less weight in the fold — relative to the wall window
 *  the sample sits in, capped here: a per-second tick of a sustained
 *  transfer covers its whole (short) window and keeps full weight, while a
 *  brief burst inside a long quiet gap does not. */
const TRANSFER_RATE_SAMPLE_CONFIDENCE_MS = 2_000;
/** A direction whose newest sample is within this window is actively
 *  transferring: while one exists, the reading quotes those directions
 *  alone — an idle direction's older (but still fresh) rate must not cap
 *  the live one, and once nothing moves the reading falls back to the most
 *  recently measured direction. Sync rounds alternate upload/download
 *  phases, so the previous phase's speed would otherwise be shown for
 *  minutes into the next one. */
const TRANSFER_RATE_ACTIVE_MS = 5_000;
/** A direction's smoothed rate only counts while it is within this window:
 *  past it the direction drops out of the reading entirely, and the reading
 *  itself disappears once nothing is fresh — a stale figure presented as
 *  the current speed would be wrong (用户拍板 2026-09-13: 宁愿不要显示，
 *  不能显示个错的; 同日用户指示窗口自 10 分钟收紧为 10 秒——没有真实
 *  传输就没有"当前速度"可显示). */
const TRANSFER_RATE_READING_FRESH_MS = 10_000;

export interface TransferDirectionMetricsInput {
  logicalBytes?: number;
  stagesMs?: { contentTransfer?: number };
}

export interface TransferRateMetricsInput {
  upload?: TransferDirectionMetricsInput;
  download?: TransferDirectionMetricsInput;
}

export function deriveTransferRateFacts(input: Readonly<{
  endedAt: number;
  fileTransfers?: TransferRateMetricsInput | null;
}>): TransferRateFactsV1 | null {
  const { endedAt, fileTransfers } = input;
  if (!fileTransfers) return null;
  const facts: TransferRateFactsV1 = { measuredAt: endedAt };
  let moved = false;
  for (const direction of ["upload", "download"] as const) {
    const metrics = fileTransfers[direction];
    const bytes = metrics?.logicalBytes ?? 0;
    const ms = metrics?.stagesMs?.contentTransfer ?? 0;
    if (bytes > 0 || ms > 0) {
      facts[`${direction}Bytes`] = bytes;
      facts[`${direction}Ms`] = ms;
      moved = true;
    }
  }
  return moved ? facts : null;
}

function directionBytes(
  facts: TransferRateFactsV1,
  direction: TransferRateDirection,
): number {
  return facts[`${direction}Bytes`] ?? 0;
}

function directionMs(
  facts: TransferRateFactsV1,
  direction: TransferRateDirection,
): number {
  return facts[`${direction}Ms`] ?? 0;
}

/** KB/s for one direction of a raw facts entry, or null while the entry is
 *  too small to mean anything (the report's per-round table uses this). */
export function transferDirectionKBps(
  facts: TransferRateFactsV1,
  direction: TransferRateDirection,
): number | null {
  const bytes = directionBytes(facts, direction);
  const ms = directionMs(facts, direction);
  if (bytes >= TRANSFER_RATE_MIN_BYTES && ms > 0) {
    return Math.round(bytes / 1024 / (ms / 1000));
  }
  return null;
}

export function formatTransferRate(kbps: number): string {
  if (kbps < TRANSFER_RATE_MEDIUM_KBPS) {
    return `${Math.max(1, Math.round(kbps))} KB/s`;
  }
  return `${(kbps / 1024).toFixed(1)} MB/s`;
}

/** ── Live reading sampler ─────────────────────────────────────────────
 *  Standard connection-speed display practice applied to a passive source:
 *  fixed-cadence samples of real byte movement folded into an exponential
 *  moving average, with fresh measurements dominating stale ones.
 *
 *  Samples come from two places:
 *  - `sampleRunTick`: fixed-cadence deltas of the run-in-flight's cumulative
 *    {bytes, ms}. The ms accumulator only grows while content actually
 *    transfers, so Δbytes/Δms is true throughput for that tick — planning,
 *    queueing and verification time between ticks fold into neither term.
 *  - `addRoundFacts`: the settled per-round aggregate, so every round with
 *    bytes moves the reading even when it was too small for a tick to catch.
 *
 *  Smoothing state is session-local; the persisted raw window only seeds
 *  the smoothing prior on load (display itself needs samples inside the
 *  10-second freshness window, so a reloaded device stays blank until real
 *  bytes move again). Only the raw ledger is persisted. */

export interface TransferRateTickSnapshot {
  upload: { bytes: number; ms: number };
  download: { bytes: number; ms: number };
}

export interface TransferRateReading {
  level: TransferSignalLevel;
  /** Worse-direction rate in KB/s; null on a zero reading. */
  kbps: number | null;
}

interface TransferRateSamplerDirectionState {
  smoothedKbps: number | null;
  lastFoldAt: number;
  zeroSignal: boolean;
  baselineBytes: number;
  baselineMs: number;
}

function createSamplerDirectionState(): TransferRateSamplerDirectionState {
  return {
    smoothedKbps: null,
    lastFoldAt: 0,
    zeroSignal: false,
    baselineBytes: 0,
    baselineMs: 0,
  };
}

export class TransferRateSampler {
  private directions: Record<
    TransferRateDirection,
    TransferRateSamplerDirectionState
  > = {
    upload: createSamplerDirectionState(),
    download: createSamplerDirectionState(),
  };

  /** Seed the smoothing prior from persisted raw round facts (stored newest
   *  first). Display requires samples inside the freshness window, so after
   *  a reload this shapes only how the first new samples blend — it cannot
   *  conjure a reading from stale data. Entries from the first released
   *  shape (derived KB/s, 2026-09-13 012242) are converted onto an
   *  equivalent nominal 10-second sample. */
  seedFromFacts(factsList: readonly TransferRateFactsV1[]): void {
    for (const raw of [...factsList].reverse()) {
      this.addRoundFacts(normalizeLegacyRateFacts(raw));
    }
  }

  /** A new run started: run ticks measure deltas from zero again. */
  beginRun(): void {
    for (const state of Object.values(this.directions)) {
      state.baselineBytes = 0;
      state.baselineMs = 0;
    }
  }

  sampleRunTick(snapshot: TransferRateTickSnapshot, at: number): void {
    for (const direction of ["upload", "download"] as const) {
      const state = this.directions[direction];
      const bytes = Math.max(0, snapshot[direction].bytes - state.baselineBytes);
      const ms = Math.max(0, snapshot[direction].ms - state.baselineMs);
      state.baselineBytes = snapshot[direction].bytes;
      state.baselineMs = snapshot[direction].ms;
      this.foldSample(direction, bytes, ms, at);
    }
  }

  addRoundFacts(facts: TransferRateFactsV1): void {
    const at = facts.measuredAt;
    for (const direction of ["upload", "download"] as const) {
      this.foldSample(
        direction,
        facts[`${direction}Bytes`] ?? 0,
        facts[`${direction}Ms`] ?? 0,
        at,
      );
    }
  }

  private foldSample(
    direction: TransferRateDirection,
    bytes: number,
    ms: number,
    at: number,
  ): void {
    const state = this.directions[direction];
    if (ms <= 0) return;
    const wallDelta = state.lastFoldAt > 0
      ? Math.max(0, at - state.lastFoldAt)
      : 0;
    state.lastFoldAt = at;
    if (bytes > 0) state.zeroSignal = false;
    if (bytes === 0) {
      // Transfer time burned without a single logical byte reads as
      // unreachable once it is long enough to mean something.
      if (ms >= TRANSFER_ZERO_MS) state.zeroSignal = true;
      return;
    }
    const instantKbps = bytes / 1024 / (ms / 1000);
    // The first sample seeds the figure outright; afterwards each sample's
    // weight rises with the wall time since the last fold (fresh readings
    // dominate stale ones) and with how much of that wall window the sample
    // actually transferred, capped at the confidence span (short bursts are
    // noisy speed estimates; a sustained transfer's per-second ticks cover
    // their whole window and keep the designed τ cadence).
    const confidence = Math.min(
      1,
      ms / Math.min(Math.max(wallDelta, 1), TRANSFER_RATE_SAMPLE_CONFIDENCE_MS),
    );
    const alpha = state.smoothedKbps === null
      ? 1
      : (1 - Math.exp(-wallDelta / TRANSFER_RATE_SMOOTHING_TAU_MS)) * confidence;
    state.smoothedKbps = state.smoothedKbps === null
      ? instantKbps
      : state.smoothedKbps + alpha * (instantKbps - state.smoothedKbps);
  }

  /** KB/s for one direction of the live reading, or null while that
   *  direction has no fresh sample (the report's current-reading row uses
   *  the same gate: no fresh data reads as "—", never as a stale figure). */
  getDirectionKBps(
    direction: TransferRateDirection,
    now: number = Date.now(),
  ): number | null {
    const state = this.directions[direction];
    if (!this.isFresh(state, now)) return null;
    return state.smoothedKbps === null
      ? null
      : Math.round(state.smoothedKbps);
  }

  /** The reading quotes the directions that are moving bytes right now
   *  (sampled within the last few seconds), combined as the worse one when
   *  both transfer simultaneously — the bottleneck of a genuinely
   *  concurrent pair. With nothing actively sampling it quotes the most
   *  recently measured direction within the freshness window, and the
   *  reading disappears once nothing is fresh: a stale figure presented as
   *  the current speed would be wrong, and the user prefers it hidden
   *  (用户拍板 2026-09-13: 宁愿不要显示，不能显示个错的). A fresh zero
   *  signal (transfer attempted, no byte came through) is real current
   *  data and reads as zero. */
  getReading(now: number = Date.now()): TransferRateReading | null {
    const states = [this.directions.upload, this.directions.download];
    const fresh = states.filter((state) => this.isFresh(state, now));
    if (fresh.length === 0) return null;
    const active = fresh.filter(
      (state) => now - state.lastFoldAt <= TRANSFER_RATE_ACTIVE_MS,
    );
    const pool = active.length > 0
      ? active
      : [fresh.reduce((a, b) => (b.lastFoldAt > a.lastFoldAt ? b : a))];
    const rates = pool
      .map((state) => state.smoothedKbps)
      .filter((value): value is number => value !== null);
    if (rates.length > 0) {
      return this.readRate(Math.min(...rates));
    }
    return pool.some((state) => state.zeroSignal)
      ? { level: "zero", kbps: null }
      : null;
  }

  private readRate(kbps: number): TransferRateReading {
    const level = kbps < TRANSFER_RATE_LOW_KBPS
      ? "low"
      : kbps < TRANSFER_RATE_MEDIUM_KBPS
        ? "medium"
        : "high";
    return { level, kbps: Math.round(kbps) };
  }

  private isFresh(
    state: TransferRateSamplerDirectionState,
    now: number,
  ): boolean {
    return state.lastFoldAt > 0
      && now - state.lastFoldAt <= TRANSFER_RATE_READING_FRESH_MS;
  }
}

function normalizeLegacyRateFacts(
  facts: TransferRateFactsV1,
): TransferRateFactsV1 {
  const legacy = facts as TransferRateFactsV1 & {
    uploadKBps?: number;
    downloadKBps?: number;
  };
  const next = { ...facts };
  for (const direction of ["upload", "download"] as const) {
    const kbps = legacy[`${direction}KBps`];
    if (kbps !== undefined && next[`${direction}Bytes`] === undefined) {
      next[`${direction}Bytes`] = kbps * 1024 * 10;
      next[`${direction}Ms`] = 10_000;
    }
  }
  return next;
}
