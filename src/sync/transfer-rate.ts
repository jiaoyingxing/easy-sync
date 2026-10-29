/**
 * Passive transfer-rate facts: connection speed measured from bytes that real
 * sync transfers already moved — no probe requests, no new traffic.
 *
 * Two layers:
 * - Per-round RAW accumulations (`TransferRateFactsV1`: bytes plus
 *   content-transfer ms per direction) persist only embedded in sync-history
 *   entries — the honest ledger the diagnostic report's per-round table reads.
 *   (The separate persisted window was retired 2026-10-24: its only consumer,
 *   the reload seeding, could never pass the 10s freshness window.)
 * - The displayed reading (`TransferRateSampler`) follows standard
 *   connection-speed display practice: sample real byte movement on a fixed
 *   cadence, smooth with an exponential moving average so every transfer
 *   visibly moves the figure, and let fresh measurements dominate stale ones.
 *   A figure is only quotable once the sample carries enough payload to
 *   describe the link: small-file sync measures per-request cost (18 B over
 *   ~420 ms reads 0.04 KB/s for any link), so such samples never move the
 *   reading and it stays hidden (用户拍板 2026-10-27: 不准确就不显示). A
 *   direction that burned transfer time without moving a byte still reads as
 *   `zero` (attempted, nothing came through) — that is a fault fact, not a
 *   speed estimate.
 */

export interface TransferRateFactsV1 {
  uploadBytes?: number;
  uploadMs?: number;
  downloadBytes?: number;
  downloadMs?: number;
  measuredAt: number;
}

type TransferSignalLevel = "zero" | "low" | "medium" | "high";

type TransferRateDirection = "upload" | "download";

/** Below this the link sits under the upload timeout-budget floor band. */
const TRANSFER_RATE_LOW_KBPS = 64;
/** Above this a home broadband link to OneDrive is comfortably fast. */
const TRANSFER_RATE_MEDIUM_KBPS = 1024;
/** Report-table floor only: a raw per-round entry with no byte has no rate.
 *  (The live reading has its own payload gate below.) */
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

/** Payload a sample needs before its bytes/time describes the link rather
 *  than one request's fixed cost. Measured 2026-10-27 on the live small-file
 *  path: one note is 18 B over ~420 ms of content transfer, i.e. 0.04 KB/s
 *  for a link of any speed; the whole 2,001-note library is 36,018 B (35.2
 *  KiB), 7.3x below this gate, so such a library never produces a figure.
 *  At the lowest link the display calls usable (64 KB/s) 256 KiB still takes
 *  4.1 s — ten times the per-request cost — so an accepted sample is
 *  payload-dominated, and a 1 MiB attachment clears it in 0.26 s at 1 MB/s.
 *  This is also the smallest accumulation window that keeps the reading on
 *  screen between samples at 25.6 KB/s (see the floor below). */
const TRANSFER_RATE_MIN_SAMPLE_BYTES = 256 * 1024;
/** One contribution joins a sample only if it can fill that sample inside the
 *  reading's freshness window: 256 KiB / 10 s = 25.6 KB/s. Slower traffic is
 *  per-request latency (a note tick reads 0.14 KB/s) and would either paint
 *  that latency as the link or leave the chip blinking on and off between
 *  samples that take longer than the window to fill. Contributions at or
 *  above the floor accumulate; the byte gate above still decides when the
 *  figure may appear. */
const TRANSFER_RATE_MIN_SAMPLE_BYTES_PER_MS =
  TRANSFER_RATE_MIN_SAMPLE_BYTES / TRANSFER_RATE_READING_FRESH_MS;

interface TransferDirectionMetricsInput {
  logicalBytes?: number;
  /** Busy wall clock of the direction (only time with a byte-moving transfer
   *  in flight; whole-body transports book their call window, since their only
   *  byte report lands after the payload already moved). This is the
   *  denominator a combined reading needs: concurrent calls overlap, so it
   *  never divides the throughput by the pool depth. */
  busyMs?: number;
}

interface TransferRateMetricsInput {
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
    // Busy wall clock, not the sum of the calls' own durations: eight
    // concurrent 1 s PUTs are 1 s of busy time, not 8 s, so the round's rate
    // reads as the link, not as the link divided by the pool depth.
    const ms = metrics?.busyMs ?? 0;
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
    const rounded = Math.round(kbps);
    // A measured rate below 0.5 KB/s rounds to 0; clamping it up to "1 KB/s"
    // presents a number that was never measured (用户拍板 2026-09-13: 宁愿
    // 不要显示，不能显示个错的; 2026-09-17 mobile report: sub-1 readings
    // pinned at "1 KB/s"). Display the honest "<1" instead.
    return rounded < 1 ? "<1 KB/s" : `${rounded} KB/s`;
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
 *    {bytes, ms}. Both terms count only real byte movement — `ms` is the
 *    direction's busy wall clock (the time during which at least one
 *    byte-moving transfer was in flight, see the executor's `busyMs`), not the
 *    sum of the concurrent calls' durations. Eight concurrent streams on a
 *    saturated link therefore read as the link's throughput, not as the link
 *    divided by eight; planning, queueing, verification and idle gaps fold
 *    into neither term.
 *  - `addRoundFacts`: the settled per-round aggregate (same busy clock), so
 *    every round with bytes moves the reading even when it was too small for
 *    a tick to catch.
 *
 *  Both channels pass the same sample-quality gate before they can move the
 *  figure: a contribution below 25.6 KB/s is per-request cost and is dropped
 *  outright, and admitted contributions accumulate until they carry 256 KiB of
 *  payload before one sample is folded. The gate therefore runs before the
 *  EWMA: a note's latency can neither seed the figure nor blend into a later
 *  attachment's sample. While nothing passes the gate the reading stays
 *  hidden (用户拍板 2026-10-27: 不准确就不显示).
 *
 *  Smoothing state is session-local and starts from zero each session
 *  (display needs samples inside the 10-second freshness window, so a
 *  reloaded device stays blank until real bytes move again). */

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
  /** Wall time of the last quotable event — an accepted sample or a fresh zero
   *  signal. Freshness and the "actively transferring" check read it;
   *  sub-gate contributions deliberately do not refresh it, so a trickle of
   *  18 B notes cannot keep an earlier link figure alive. */
  lastReadingAt: number;
  /** Wall time of the last accepted sample: the EWMA's own wall clock. */
  lastFoldAt: number;
  zeroSignal: boolean;
  baselineBytes: number;
  baselineMs: number;
  /** Admitted payload of the sample being accumulated; folded only once it
   *  reaches `TRANSFER_RATE_MIN_SAMPLE_BYTES`. */
  pendingBytes: number;
  pendingMs: number;
}

function createSamplerDirectionState(): TransferRateSamplerDirectionState {
  return {
    smoothedKbps: null,
    lastReadingAt: 0,
    lastFoldAt: 0,
    zeroSignal: false,
    baselineBytes: 0,
    baselineMs: 0,
    pendingBytes: 0,
    pendingMs: 0,
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

  /** A new run started: run ticks measure deltas from zero again, and payload
   *  still accumulating towards a sample belongs to the finished run. */
  beginRun(): void {
    for (const state of Object.values(this.directions)) {
      state.baselineBytes = 0;
      state.baselineMs = 0;
      state.pendingBytes = 0;
      state.pendingMs = 0;
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
    if (bytes > 0) state.zeroSignal = false;
    if (bytes === 0) {
      // Transfer time burned without a single logical byte reads as
      // unreachable once it is long enough to mean something.
      if (ms >= TRANSFER_ZERO_MS) {
        state.zeroSignal = true;
        state.lastReadingAt = at;
      }
      return;
    }
    // A contribution this slow is per-request latency, not link throughput:
    // drop it outright so its time can never enter a later payload-sized
    // sample (one 18 B note over 420 ms reads 0.04 KB/s; eight concurrent
    // notes per second still read only 0.14 KB/s).
    if (bytes / ms < TRANSFER_RATE_MIN_SAMPLE_BYTES_PER_MS) return;
    state.pendingBytes += bytes;
    state.pendingMs += ms;
    if (state.pendingBytes < TRANSFER_RATE_MIN_SAMPLE_BYTES) return;
    const sampleBytes = state.pendingBytes;
    const sampleMs = state.pendingMs;
    state.pendingBytes = 0;
    state.pendingMs = 0;
    // The EWMA's wall clock is the span since the last folded sample: a long
    // accumulation (slow link) or a long gap makes the fresh sample dominate.
    const wallDelta = state.lastFoldAt > 0
      ? Math.max(0, at - state.lastFoldAt)
      : 0;
    state.lastFoldAt = at;
    state.lastReadingAt = at;
    const instantKbps = sampleBytes / 1024 / (sampleMs / 1000);
    // The first sample seeds the figure outright; afterwards each sample's
    // weight rises with the wall time since the last fold (fresh readings
    // dominate stale ones) and with how much of that wall window the sample
    // actually transferred, capped at the confidence span (short bursts are
    // noisy speed estimates; a sustained transfer's per-second ticks cover
    // their whole window and keep the designed τ cadence).
    const confidence = Math.min(
      1,
      sampleMs / Math.min(Math.max(wallDelta, 1), TRANSFER_RATE_SAMPLE_CONFIDENCE_MS),
    );
    const alpha = state.smoothedKbps === null
      ? 1
      : (1 - Math.exp(-wallDelta / TRANSFER_RATE_SMOOTHING_TAU_MS)) * confidence;
    state.smoothedKbps = state.smoothedKbps === null
      ? instantKbps
      : state.smoothedKbps + alpha * (instantKbps - state.smoothedKbps);
  }

  /** KB/s for one direction of the live reading, or null while that
   *  direction has no fresh, payload-sized sample (the report's
   *  current-reading row uses the same gate: no trustworthy data reads as
   *  "—", never as a stale or latency-bound figure). */
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
   *  (用户拍板 2026-09-13: 宁愿不要显示，不能显示个错的). Only samples that
   *  passed the payload gate move the figure, so a small-file sync keeps the
   *  whole reading hidden (用户拍板 2026-10-27: 不准确就不显示). A fresh
   *  zero signal (transfer attempted, no byte came through) is real current
   *  data and reads as zero. */
  getReading(now: number = Date.now()): TransferRateReading | null {
    const states = [this.directions.upload, this.directions.download];
    const fresh = states.filter((state) => this.isFresh(state, now));
    if (fresh.length === 0) return null;
    const active = fresh.filter(
      (state) => now - state.lastReadingAt <= TRANSFER_RATE_ACTIVE_MS,
    );
    const pool = active.length > 0
      ? active
      : [fresh.reduce((a, b) => (b.lastReadingAt > a.lastReadingAt ? b : a))];
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
    return state.lastReadingAt > 0
      && now - state.lastReadingAt <= TRANSFER_RATE_READING_FRESH_MS;
  }
}
