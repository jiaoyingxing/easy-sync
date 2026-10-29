/** Round-scoped, bidirectionally movable stream-count adaptation for the
 *  desktop multi-range download (G3, 2026-10-27; knee rework 2026-10-28).
 *
 *  Why a controller instead of another constant: the 2026-10-27 field
 *  measurement (52.8 KB/s on one connection, 103–108 KB/s on two, ~26 s for a
 *  20 MiB file at 16 streams) showed a per-connection bottleneck, not a
 *  saturated pipe. A fixed 16 stream plan therefore cannot react when the
 *  curve flattens, when the aggregate caps out, or when the CDN starts
 *  answering 429. This controller keeps one tier for the whole sync round:
 *  every large file plans from the same state, so the second file starts
 *  where the first stopped instead of re-probing from 8.
 *
 *  Ladder: 8 → 12 → 16 → 24 → 32 (see `download-range-policy.ts`). Steps are
 *  measured on the link, never on the file: a clean multi-range transfer is
 *  one sample, and consecutive samples at different tiers are compared.
 *
 *  Thresholds are expressed as a fraction of the ideal linear gain, so the
 *  spec's "doubling" examples are exact while smaller ladder steps get a
 *  proportionally smaller absolute bar:
 *
 *      step ratio r = streamsNew / streamsBaseline
 *      upgrade when  bpsNew / bpsBaseline >= 1 + 0.30 × (r - 1)
 *      knee    when  bpsNew / bpsBaseline <  1 + 0.15 × (r - 1)
 *
 *  For a doubling step (r = 2) that is exactly 1.30× / 1.15×. A constant
 *  absolute 1.30× bar would be unreachable on the 1.33× rungs even on a
 *  perfectly linear link, so scaling by the step is what keeps the same rule
 *  meaningful across the ladder.
 *
 *  Why 0.30 / 0.15:
 *  - 0.30 is the smallest gain that still repays the extra connections:
 *    below it, adding 4–8 sockets buys <30% of the ideal linear gain, while
 *    every extra request adds overhead and throttling risk.
 *  - 0.15 is the knee line: if a step buys less than 15% of the ideal gain,
 *    the curve has probably flattened. The 0.15–0.30 band is a deliberate
 *    hold window: one noisy sample neither promotes nor demotes, which avoids
 *    flapping on a link whose per-file rate varies by ~10%.
 *
 *  Two strikes before a knee (2026-10-28). The field round of three 20 MiB
 *  files exposed a hole in the single-sample rule:
 *
 *      a: 8 streams  — 430 KB/s
 *      b: 12 streams — 360 KB/s   (0.83× → old rule: knee, back to 8, round frozen)
 *      c: 8 streams  — 368 KB/s   (0.855× of a: the link itself slowed down)
 *
 *  Normalized to the same-period 8-stream level, the 12-stream step was
 *  ~0.98× — still under the line, but the point is that *one* sample cannot
 *  tell "this tier is saturated" from "the link got slower between two
 *  files". The old rule read the second case as the first and spent the rest
 *  of the round at 8, losing upgrades that were still available.
 *
 *  So a below-the-line step is now a suspicion, not a verdict:
 *  - strike 1: keep the probed tier, keep the ramp armed (the round keeps
 *    probing upward — that is the "continue observing" part), log a warning;
 *  - strike 2 (the next evaluated step is also below the line): the knee is
 *    confirmed. Settle at the base rung of strike 1 — the last rung that is
 *    not part of the flat region — and freeze the round above it;
 *  - a step at or above the line clears the pending suspicion.
 *
 *  The comparison baseline is the freshest clean sample at the rung the probe
 *  stepped from (one map entry per observed stream count), not the previous
 *  sample overall. Two reasons: a step is A→B, so a sample from a third rung
 *  (a small file that the 1 MiB per-stream floor capped, or a tier a
 *  downgrade passed through) would mix two different steps; and after a knee
 *  the settled rung is re-measured by every held file, so the one re-probe is
 *  judged against a reading taken immediately before it — the only
 *  "same-period" pair this strictly sequential pipeline can produce without
 *  running two tiers at once.
 *
 *  Re-probe after a knee: a freeze is not the end of the round. After
 *  `RANGE_STREAM_KNEE_RETRY_CLEAN_SAMPLES` (3) clean transfers at the settled
 *  tier, the controller spends exactly one probe one rung up.
 *  - below the line again: the knee is confirmed, the round settles back and
 *    stops probing this knee entirely (no second retry this round);
 *  - at or above the line: the freeze ends and the normal ramp rules resume.
 *
 *  Size-aware probes (field round 2, 2026-10-28). Six 20 MiB files showed the
 *  ladder stuck at 16: with the 1 MiB per-stream floor a 20 MiB file can fund
 *  only the 8/12/16 rungs, and the ladder has no 20 rung. A probe to 24 would
 *  actually run 20 windows, so the 16→24 comparison would be a 1.25× step, not
 *  the 1.5× the thresholds assume; 24 and 32 would both run 20 streams and
 *  24→32 could never produce a step at all. The round would also claim a tier
 *  no file reached.
 *
 *  So a probe is only committed when the *target rung* fits the file:
 *
 *      ladder[target] <= floor(fileSize / 1 MiB)
 *
 *  When the next rung does not fit, the file keeps the current tier and spends
 *  no probe: there is no sample, no step and therefore no "flat" strike (the
 *  false knee evidence this rule exists to prevent). The owed probe and a
 *  knee re-probe are both kept for the next file that can fund them. A file of
 *  at least 32 MiB can fund every rung, so the top of the ladder stays
 *  reachable whenever the round actually contains such a file.
 *
 *  This is not a per-stream-floor change: `planRangeDownloadWindows` still
 *  clamps one window to 1 MiB. It only stops the controller from *probing*
 *  rungs a file cannot fill. A file that is smaller than the round's current
 *  tier (24 from an earlier file, 20 MiB now) still runs its clamped plan; it
 *  just does not move the tier up or lend that sample to a step judgement.
 *
 *  Failures are not throughput samples:
 *  - 429/509: downgrade one rung immediately and arm recovery after a
 *    cooldown (10 s, doubling per consecutive throttle up to 60 s; a longer
 *    Retry-After wins). The cooldown gates the *next upgrade probe* only; the
 *    current attempt keeps its normal single-stream fallback.
 *  - two consecutive connection-level failures: downgrade one rung and arm
 *    recovery after a 5 s cooldown. One failure alone holds the current tier;
 *    a clean transfer resets the streak.
 *  - after a rate-limit / connection downgrade, once the cooldown expires the
 *    controller probes exactly one rung up again. A successful probe adopts
 *    the tier and resumes the normal ramp; this is the required "down then
 *    up" direction, not a one-way brake.
 *  - a failure event clears a pending suspicion: the evidence context changed
 *    (the tier moved), so the old throughput comparison no longer applies. It
 *    does not lift a confirmed knee ceiling.
 *
 *  Known trade-off: the ladder's top rung has no rung above it, so a
 *  below-the-line step at 32 streams can only be a suspicion — the round holds
 *  32 until a 429 (unchanged path) or the round ends, instead of settling at
 *  24 on one sample. That is the price of not mistaking drift for a knee; the
 *  429 downgrade/cooldown remains the backstop for a genuinely overloaded
 *  link.
 *
 *  Lifecycle: one instance per `OneDriveClient` round, reset by
 *  `resetDownloadStrategy()` alongside the other round breakers. The state is
 *  intentionally not persisted to data.json: link conditions are round-local,
 *  and a stale 32-stream tier after a network switch would be worse than one
 *  cheap first file. This module is pure TypeScript (no Obsidian / Node
 *  imports) so the strategy is unit-testable with a fake clock and a synthetic
 *  link curve. */

import type { DiagnosticLogger } from "../sync/diagnostic-logger";
import {
  availableRangeTierIndex,
  DOWNLOAD_RANGE_STREAM_LADDER,
} from "./download-range-policy";

/** A step must buy at least this fraction of the ideal linear gain to promote. */
export const RANGE_STREAM_UPGRADE_GAIN_FRACTION = 0.30;
/** Below this fraction of the ideal gain the curve is flat (the knee). */
export const RANGE_STREAM_KNEE_GAIN_FRACTION = 0.15;
/** Consecutive below-the-line steps that turn a suspicion into a knee. One is
 *  not enough: a link that slowed down between two files looks exactly the
 *  same as a saturated tier in a single sample. */
export const RANGE_STREAM_KNEE_STRIKES = 2;
/** Clean transfers at the settled tier before the round spends its one knee
 *  re-probe. Long enough that the link has proved itself again at that tier,
 *  short enough that a round of large files still gets the chance. */
export const RANGE_STREAM_KNEE_RETRY_CLEAN_SAMPLES = 3;
/** Base cooldown after a 429/509 before the next upgrade probe. */
export const RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS = 10_000;
/** Ceiling for the exponential throttle cooldown / a long Retry-After. */
const RANGE_STREAM_RATE_LIMIT_MAX_COOLDOWN_MS = 60_000;
/** Consecutive connection-level failures that cost one rung. */
export const RANGE_STREAM_CONNECTION_FAILURE_STREAK = 2;
/** Cooldown before the recovery probe after a connection-failure downgrade. */
export const RANGE_STREAM_CONNECTION_COOLDOWN_MS = 5_000;

/** One clean multi-range transfer. `bytes` is the assembled payload; the
 *  caller passes the whole-file transfer window, not a per-window rate. */
export interface RangeStreamTransferSample {
  streams: number;
  bytes: number;
  elapsedMs: number;
}

interface RangeStreamRateLimitObservation {
  /** `Retry-After` in milliseconds, when the response carried one. */
  retryAfterMs?: number | null;
}

/** What `range-download.ts` needs from the controller. Kept as an interface so
 *  downloader tests can pass a fake observer without constructing the policy. */
export interface RangeStreamObserver {
  nowMs(): number;
  recordCleanTransfer(sample: RangeStreamTransferSample): void;
  recordConnectionFailure(): void;
  recordRateLimited(observation?: RangeStreamRateLimitObservation): void;
}

interface RangeStreamAdaptationOptions {
  /** Injectable wall clock (tests use a fake). */
  now?: () => number;
  diag?: DiagnosticLogger;
}

/** Why a probe was committed. `ramp` is the ordinary climb, `recovery` the
 *  owed probe after a failure downgrade (adopted without a throughput
 *  comparison), and `knee-retry` the single re-probe after a confirmed knee. */
type ProbeKind = "ramp" | "recovery" | "knee-retry";

interface PendingProbe {
  kind: ProbeKind;
  /** Ladder index the probe stepped from: the rung this sample is compared
   *  against. */
  fromIndex: number;
}

/** The tier a confirmed knee settled on, plus its one re-probe's bookkeeping. */
interface KneeFreeze {
  tierIndex: number;
  cleanSamples: number;
  retrySpent: boolean;
}

interface RangeStreamSample {
  streams: number;
  bytesPerSecond: number;
}

/** Adaptive stream-count state for one sync round. See the module comment for
 *  the ladder, thresholds, knee rule and lifecycle. */
export class RangeStreamAdaptation implements RangeStreamObserver {
  private readonly clock: () => number;
  private readonly diag: DiagnosticLogger | undefined;
  /** Index into `DOWNLOAD_RANGE_STREAM_LADDER`; this is the tier the next
   *  large file will use (a probe commits here when it is planned). */
  private tierIndex = 0;
  /** Freshest clean sample per observed stream count. This is the baseline a
   *  step is judged against: same rung, latest reading. */
  private samplesByStreams = new Map<number, RangeStreamSample>();
  /** Most recent clean sample at any rung. Only a fallback baseline, for the
   *  case where the starting rung never produced a sample of its own. */
  private lastSample: RangeStreamSample | null = null;
  /** The probe the file being transferred right now is running; consumed by
   *  `recordCleanTransfer`. */
  private pendingProbe: PendingProbe | null = null;
  /** An upward move is owed once the cooldown permits. */
  private probePending = false;
  /** Why the owed probe exists; `recovery` probes are adopted on success
   *  without a throughput comparison (the tier was already proven before the
   *  failure). */
  private probeKind: Exclude<ProbeKind, "knee-retry"> | null = null;
  /** Highest rung this round may still probe. A confirmed knee lowers it. */
  private ceilingIndex = DOWNLOAD_RANGE_STREAM_LADDER.length - 1;
  /** Ladder index of the first below-the-line step waiting for its second
   *  strike; `null` when no suspicion is pending. */
  private suspicionBaseIndex: number | null = null;
  /** Consecutive below-the-line steps in the current run. */
  private belowLineStrikes = 0;
  /** Set once two consecutive below-the-line steps settle the round. */
  private freeze: KneeFreeze | null = null;
  private cooldownUntilMs = 0;
  private connectionFailureStreak = 0;
  /** Consecutive throttle events; doubles the base 429 cooldown. */
  private rateLimitStreak = 0;
  /** Last (tier, target, fundable rung) triple whose size-blocked probe was
   *  logged, so a round of same-sized files explains itself once instead of
   *  once per file. */
  private lastSizeBlockedProbeKey: string | null = null;

  constructor(options: RangeStreamAdaptationOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.diag = options.diag;
  }

  /** Clock used by the downloader to measure the transfer window, so tests
   *  can drive throughput deterministically. */
  nowMs(): number {
    return this.clock();
  }

  /** The tier the next file would use right now (without committing a probe). */
  get plannedStreams(): number {
    return DOWNLOAD_RANGE_STREAM_LADDER[this.tierIndex];
  }

  /** Reset for a new sync round. The instance is reused so callers holding a
   *  reference (the downloader input) keep seeing the same controller. */
  reset(): void {
    this.tierIndex = 0;
    this.samplesByStreams.clear();
    this.lastSample = null;
    this.pendingProbe = null;
    this.probePending = false;
    this.probeKind = null;
    this.ceilingIndex = DOWNLOAD_RANGE_STREAM_LADDER.length - 1;
    this.clearStrikes();
    this.freeze = null;
    this.cooldownUntilMs = 0;
    this.connectionFailureStreak = 0;
    this.rateLimitStreak = 0;
    this.lastSizeBlockedProbeKey = null;
  }

  /** Plan one file of `fileSizeBytes`. Commits an owed probe (and logs the
   *  transition) only when the target rung fits the file; during a cooldown,
   *  or when the file cannot fund the next rung, the current tier is returned
   *  unchanged. See "Size-aware probes" in the module comment. */
  planStreams(fileSizeBytes: number): number {
    // A planned file that never reported a sample (failure, single-stream
    // fallback) must not lend its rung to the next file's comparison.
    this.pendingProbe = null;
    const availableIndex = availableRangeTierIndex(fileSizeBytes);
    if (this.commitKneeRetry(availableIndex)) return this.plannedStreams;
    if (this.probePending && this.tierIndex >= this.ceilingIndex) {
      // A knee or the 32 cap means no rung is left; drop the debt instead of
      // re-checking it on every file.
      this.probePending = false;
      this.probeKind = null;
    }
    if (!this.probePending || this.nowMs() < this.cooldownUntilMs) {
      return this.plannedStreams;
    }
    const nextIndex = this.tierIndex + 1;
    if (nextIndex > availableIndex) {
      // 16→24 on a 20 MiB file is not a 24-stream step: the file can fund at
      // most 20 windows and the ladder has no 20 rung. Spending the probe
      // would measure a partial step and count a flat link as a knee. Keep
      // the tier and the owed probe; a file that can fund 24 spends it later.
      this.noteSizeBlockedProbe(fileSizeBytes, nextIndex, availableIndex);
      return this.plannedStreams;
    }
    const from = this.plannedStreams;
    const fromIndex = this.tierIndex;
    const kind = this.probeKind ?? "ramp";
    this.tierIndex += 1;
    this.probePending = false;
    this.probeKind = null;
    this.lastSizeBlockedProbeKey = null;
    this.pendingProbe = { kind, fromIndex };
    this.diag?.log(
      "onedrive",
      `multi-range adaptation — probe ${from}→${this.plannedStreams} streams (${kind})`,
    );
    return this.plannedStreams;
  }

  /** Explain a probe that the file's size made meaningless. The field round
   *  asked why 24 was never probed; the answer has to be visible in the log,
   *  not inferred from a missing line. One line per blocked rung is enough. */
  private noteSizeBlockedProbe(
    fileSizeBytes: number,
    nextIndex: number,
    availableIndex: number,
  ): void {
    const key = `${this.tierIndex}:${nextIndex}:${availableIndex}`;
    if (key === this.lastSizeBlockedProbeKey) return;
    this.lastSizeBlockedProbeKey = key;
    const fileMiB = Math.round(fileSizeBytes / (1024 * 1024));
    const fundedRung = availableIndex >= 0
      ? `the ${DOWNLOAD_RANGE_STREAM_LADDER[availableIndex]}-stream rung`
      : "no ladder rung";
    this.diag?.log(
      "onedrive",
      `multi-range adaptation — not probing ${this.plannedStreams}→${DOWNLOAD_RANGE_STREAM_LADDER[nextIndex]} streams: a ${fileMiB} MiB file funds at most ${fundedRung} at the 1 MiB per-stream floor; holding ${this.plannedStreams} streams`,
    );
  }

  recordCleanTransfer(sample: RangeStreamTransferSample): void {
    const normalized = normalizeSample(sample);
    if (!normalized) return;
    this.connectionFailureStreak = 0;
    this.rateLimitStreak = 0;
    const probe = this.pendingProbe;
    this.pendingProbe = null;
    // The baseline is read before the new sample joins the per-rung map, so a
    // same-rung repeat can never be compared with itself.
    const baseline = probe === null
      ? null
      : this.baselineFor(probe.fromIndex, normalized.streams);
    this.rememberSample(normalized);
    this.countSettledSample(normalized);

    // A recovery probe is not re-judged: the tier was already justified
    // before the failure, and the point of this sample is "the link serves
    // this tier again". Adopt it and resume the normal ramp from here.
    if (probe?.kind === "recovery") {
      this.armRampProbe();
      this.diag?.log(
        "onedrive",
        `multi-range adaptation — recovery probe confirmed at ${normalized.streams} streams`,
      );
      return;
    }

    if (
      probe === null
      || baseline === null
      || normalized.streams <= baseline.streams
    ) {
      // No step evidence: the round's first sample, the same tier again, a
      // file-size cap that collapsed the plan onto (or below) the starting
      // rung, or a sample that came down. Equal stream counts are not a flat
      // step and never add a strike; `planStreams` does not even commit a
      // probe whose target rung the file cannot fund, so this is a guard for
      // a mismatched sample rather than a normal path. Keep the ramp moving
      // only when a higher rung is still available.
      if (probe?.kind === "knee-retry") {
        // The retry file was too small to reach the probed rung (the 1 MiB
        // per-stream floor capped the plan onto the settled tier): no verdict
        // either way, so put the round back where it settled instead of
        // leaving it parked one rung above a confirmed knee.
        const freeze = this.freeze;
        if (freeze !== null) {
          this.tierIndex = freeze.tierIndex;
          this.ceilingIndex = freeze.tierIndex;
        }
      }
      this.armRampProbe();
      return;
    }

    const gain = normalized.bytesPerSecond / baseline.bytesPerSecond;
    const step = normalized.streams / baseline.streams;
    const upgradeBar = 1 + RANGE_STREAM_UPGRADE_GAIN_FRACTION * (step - 1);
    const kneeBar = 1 + RANGE_STREAM_KNEE_GAIN_FRACTION * (step - 1);

    if (probe.kind === "knee-retry" && gain < kneeBar) {
      this.confirmKneeAfterRetry(normalized, gain, kneeBar);
      return;
    }
    if (probe.kind === "knee-retry") {
      // The settled tier did clear the line this time: the freeze is over and
      // the ordinary ramp rules decide from here.
      this.freeze = null;
      this.ceilingIndex = DOWNLOAD_RANGE_STREAM_LADDER.length - 1;
    }

    if (gain < kneeBar) {
      this.recordBelowLineStep(probe, normalized, gain, kneeBar, step);
      return;
    }

    // A step that clears the line disproves the pending suspicion.
    this.clearStrikes();

    if (gain >= upgradeBar) {
      this.armRampProbe();
      return;
    }

    // Hold window: the step bought something, but not enough to justify
    // another move. Stay at the measured tier and stop probing above it for
    // the rest of the round — a repeated same-tier sample must not re-arm the
    // ramp (that would creep to 32 on a link whose marginal gain is unclear).
    this.ceilingIndex = Math.min(this.ceilingIndex, this.tierIndex);
    this.probePending = false;
    this.probeKind = null;
    this.diag?.log(
      "onedrive",
      `multi-range adaptation — holding ${normalized.streams} streams (${gain.toFixed(2)}× gain is inside the hold band below ${upgradeBar.toFixed(2)}×)`,
    );
  }

  recordConnectionFailure(): void {
    this.rateLimitStreak = 0;
    this.probePending = false;
    this.probeKind = null;
    this.pendingProbe = null;
    this.lastSizeBlockedProbeKey = null;
    // The tier is about to move, so a pending throughput suspicion no longer
    // describes the same step. A confirmed knee ceiling is left alone.
    this.clearStrikes();
    this.connectionFailureStreak += 1;
    if (this.connectionFailureStreak < RANGE_STREAM_CONNECTION_FAILURE_STREAK) {
      this.diag?.warn(
        "onedrive",
        `multi-range adaptation — connection failure ${this.connectionFailureStreak}/${RANGE_STREAM_CONNECTION_FAILURE_STREAK}; holding ${this.plannedStreams} streams`,
      );
      return;
    }
    this.connectionFailureStreak = 0;
    const before = this.plannedStreams;
    this.downgradeOneRung();
    this.armRecoveryProbe(RANGE_STREAM_CONNECTION_COOLDOWN_MS);
    this.diag?.warn(
      "onedrive",
      `multi-range adaptation — ${RANGE_STREAM_CONNECTION_FAILURE_STREAK} consecutive connection failures at ${before} streams; downgrading to ${this.plannedStreams}, retry in ${Math.round(RANGE_STREAM_CONNECTION_COOLDOWN_MS / 1000)}s`,
    );
  }

  recordRateLimited(observation: RangeStreamRateLimitObservation = {}): void {
    this.connectionFailureStreak = 0;
    this.probePending = false;
    this.probeKind = null;
    this.pendingProbe = null;
    this.lastSizeBlockedProbeKey = null;
    // Same as a connection failure: the threshold evidence belongs to the old
    // tier, so the suspicion is dropped (the knee ceiling still applies).
    this.clearStrikes();
    this.rateLimitStreak += 1;
    const before = this.plannedStreams;
    this.downgradeOneRung();
    const multiplier = 2 ** Math.min(this.rateLimitStreak - 1, 3);
    const retryAfterMs = normalizeRetryAfter(observation.retryAfterMs);
    const cooldownMs = Math.min(
      RANGE_STREAM_RATE_LIMIT_MAX_COOLDOWN_MS,
      Math.max(
        RANGE_STREAM_RATE_LIMIT_COOLDOWN_MS * multiplier,
        retryAfterMs ?? 0,
      ),
    );
    this.armRecoveryProbe(cooldownMs);
    this.diag?.warn(
      "onedrive",
      `multi-range adaptation — rate limited at ${before} streams; downgrading to ${this.plannedStreams}, cooldown ${Math.round(cooldownMs / 1000)}s`,
      { rateLimitStreak: this.rateLimitStreak, retryAfterMs },
    );
  }

  /** Commit the single post-knee re-probe when it is due and the file can
   *  fund the next rung. A file that cannot (the field's 20 MiB file at a
   *  freeze of 16) leaves `retrySpent` alone, so a later large file keeps the
   *  one re-probe the round owes. Returns whether a probe was planned (the
   *  caller then returns the tier unchanged). */
  private commitKneeRetry(availableIndex: number): boolean {
    const freeze = this.freeze;
    if (freeze === null || freeze.retrySpent) return false;
    if (freeze.cleanSamples < RANGE_STREAM_KNEE_RETRY_CLEAN_SAMPLES) {
      return false;
    }
    // Only from the settled tier: a failure that moved the tier down leaves
    // the recovery path to the ordinary probe machinery.
    if (this.tierIndex !== freeze.tierIndex) return false;
    if (this.tierIndex + 1 >= DOWNLOAD_RANGE_STREAM_LADDER.length) return false;
    // A re-probe whose target rung the file cannot fill is not a re-probe.
    if (this.tierIndex + 1 > availableIndex) return false;
    if (this.nowMs() < this.cooldownUntilMs) return false;
    const from = this.plannedStreams;
    const fromIndex = this.tierIndex;
    this.tierIndex += 1;
    freeze.retrySpent = true;
    this.probePending = false;
    this.probeKind = null;
    this.lastSizeBlockedProbeKey = null;
    this.pendingProbe = { kind: "knee-retry", fromIndex };
    this.diag?.log(
      "onedrive",
      `multi-range adaptation — knee re-probe ${from}→${this.plannedStreams} streams after ${freeze.cleanSamples} clean samples at the settled tier`,
    );
    return true;
  }

  /** One below-the-line step: a suspicion the first time, a confirmed knee once
   *  `RANGE_STREAM_KNEE_STRIKES` steps in a row land below the line. */
  private recordBelowLineStep(
    probe: PendingProbe,
    sample: RangeStreamSample,
    gain: number,
    kneeBar: number,
    step: number,
  ): void {
    const from = DOWNLOAD_RANGE_STREAM_LADDER[probe.fromIndex];
    this.belowLineStrikes += 1;
    if (this.suspicionBaseIndex === null) {
      // The first strike of a run fixes the settle target: the rung the flat
      // region starts from, i.e. the last rung that was not part of it.
      this.suspicionBaseIndex = probe.fromIndex;
    }
    if (this.belowLineStrikes < RANGE_STREAM_KNEE_STRIKES) {
      this.diag?.warn(
        "onedrive",
        `multi-range adaptation — step ${from}→${sample.streams} streams bought ${gain.toFixed(2)}× (< ${kneeBar.toFixed(2)}× for ${step.toFixed(2)}× connections); one flat sample can be link drift, so this is a suspicion only (${this.belowLineStrikes}/${RANGE_STREAM_KNEE_STRIKES}) — keeping ${this.plannedStreams} streams and continuing to probe`,
      );
      // The suspicious step is unproven, not disproven: keep the probed tier
      // and let the next step supply the second strike.
      this.armRampProbe();
      return;
    }

    const settleIndex = this.suspicionBaseIndex;
    this.clearStrikes();
    const before = this.plannedStreams;
    this.tierIndex = settleIndex;
    this.ceilingIndex = settleIndex;
    this.freeze = { tierIndex: settleIndex, cleanSamples: 0, retrySpent: false };
    this.probePending = false;
    this.probeKind = null;
    this.diag?.warn(
      "onedrive",
      `multi-range adaptation — knee confirmed at ${sample.streams} streams (${gain.toFixed(2)}× < ${kneeBar.toFixed(2)}× for ${step.toFixed(2)}× connections) after ${RANGE_STREAM_KNEE_STRIKES} consecutive below-the-line steps, settling at ${before}→${this.plannedStreams} streams; one re-probe after ${RANGE_STREAM_KNEE_RETRY_CLEAN_SAMPLES} clean samples`,
    );
  }

  /** The one post-knee re-probe also came in below the line: the knee is
   *  confirmed for the rest of the round and no further probe is attempted. */
  private confirmKneeAfterRetry(
    sample: RangeStreamSample,
    gain: number,
    kneeBar: number,
  ): void {
    const freeze = this.freeze;
    if (freeze === null) return;
    const before = this.plannedStreams;
    this.tierIndex = freeze.tierIndex;
    this.ceilingIndex = freeze.tierIndex;
    this.probePending = false;
    this.probeKind = null;
    this.diag?.warn(
      "onedrive",
      `multi-range adaptation — knee re-probe at ${sample.streams} streams also bought ${gain.toFixed(2)}× (< ${kneeBar.toFixed(2)}×); settling back at ${before}→${this.plannedStreams} streams and stopping probe attempts for the round`,
    );
  }

  /** The freshest sample at the rung a probe stepped from. Falls back to the
   *  most recent lower reading when that exact rung never produced a sample
   *  (a file small enough for the per-stream floor to cap it). */
  private baselineFor(
    fromIndex: number,
    probeStreams: number,
  ): RangeStreamSample | null {
    const rung = DOWNLOAD_RANGE_STREAM_LADDER[fromIndex];
    const exact = rung === undefined
      ? undefined
      : this.samplesByStreams.get(rung);
    if (exact !== undefined && exact.streams < probeStreams) return exact;
    return this.lastSample !== null && this.lastSample.streams < probeStreams
      ? this.lastSample
      : null;
  }

  private rememberSample(sample: RangeStreamSample): void {
    this.samplesByStreams.set(sample.streams, sample);
    this.lastSample = sample;
  }

  /** Progress the post-knee re-probe clock: only transfers that actually ran
   *  at the settled tier count. */
  private countSettledSample(sample: RangeStreamSample): void {
    const freeze = this.freeze;
    if (freeze === null) return;
    const settledStreams = DOWNLOAD_RANGE_STREAM_LADDER[freeze.tierIndex];
    if (sample.streams !== settledStreams) return;
    freeze.cleanSamples += 1;
  }

  /** One rung down, floored at the ladder's first rung. A knee ceiling is left
   *  untouched: if the knee was lower than the new tier, it still applies. */
  private downgradeOneRung(): void {
    this.tierIndex = Math.max(0, this.tierIndex - 1);
  }

  /** Drop the below-the-line run: a step that cleared the line, a failure that
   *  moved the tier, or the entanglement of a new round. */
  private clearStrikes(): void {
    this.suspicionBaseIndex = null;
    this.belowLineStrikes = 0;
  }

  /** A normal ramp probe is allowed up to the round-local ceiling. */
  private armRampProbe(): void {
    this.probePending = this.tierIndex < this.ceilingIndex;
    this.probeKind = this.probePending ? "ramp" : null;
  }

  /** A failure downgrade owes exactly one upward probe after the cooldown. */
  private armRecoveryProbe(cooldownMs: number): void {
    this.probePending = this.tierIndex < this.ceilingIndex;
    this.probeKind = this.probePending ? "recovery" : null;
    const until = this.nowMs() + Math.max(0, cooldownMs);
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, until);
  }
}

/** Validate and convert one transfer sample. A zero/invalid window is ignored:
 *  it did not measure a rate. */
function normalizeSample(sample: RangeStreamTransferSample): RangeStreamSample | null {
  if (!Number.isSafeInteger(sample.streams) || sample.streams <= 0) return null;
  if (!Number.isFinite(sample.bytes) || sample.bytes <= 0) return null;
  if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs <= 0) return null;
  const bytesPerSecond = (sample.bytes * 1000) / sample.elapsedMs;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return { streams: sample.streams, bytesPerSecond };
}

function normalizeRetryAfter(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.min(value, RANGE_STREAM_RATE_LIMIT_MAX_COOLDOWN_MS);
}

export function createRangeStreamAdaptation(
  options: RangeStreamAdaptationOptions = {},
): RangeStreamAdaptation {
  return new RangeStreamAdaptation(options);
}
