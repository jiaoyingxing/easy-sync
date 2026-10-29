import { SIGNIFICANT_THROUGHPUT_DROP_RATIO } from "./transfer-throughput-threshold";

export const ADAPTIVE_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY = 3;
export const MOBILE_DOWNLOAD_MAX_CONCURRENCY = 2;

const MIN_HEALTHY_BATCH_BYTES = 128 * 1024;
const MIN_HEALTHY_THROUGHPUT_BPS = 512 * 1024;
/** 恢复闸 (2026-10-27): how many consecutive healthy batches lift the limit by
 *  one after a degradation. Three keeps a single lucky batch from undoing the
 *  evidence that locked the round, and is the download analogue of the upload
 *  pool's `REGRESSION_WINDOWS`. */
const RECOVERY_HEALTHY_BATCHES = 3;

/** 小文件档 (2026-10-27): a 20 KiB note moves no rate anyone can judge, so the
 *  bandwidth gate above can never open for the small-file tier and every round
 *  stayed strictly serial — 2.79 s per 18-byte file on the desktop profile,
 *  where the content transfer itself was only 0.42 s
 *  (`docs/dev-logs/2026-10/20261027-0636`). A completed small transfer is
 *  still evidence that the link is alive, so it gets its own ramp: two
 *  consecutive completed batches reach two, four reach the platform ceiling.
 *  This never relaxes the kernel below — a failure still locks to serial, and
 *  every batch above the tier keeps the unchanged bandwidth gate. */
const SMALL_FILE_MAX_BYTES_PER_FILE = 200 * 1024;
/** A transfer window shorter than this did not measure a request round trip
 *  (tests/fakes, cached paths); it must not count as link evidence. */
const MIN_SMALL_FILE_TRANSFER_MS = 50;
/** A tiny file that needed more than this was stalled, not merely slow: the
 *  field baseline for an 18-byte file is ~410 ms. */
const MAX_SMALL_FILE_TRANSFER_MS = 3_000;
/** Below this many bytes the rate is a latency artefact; at or above it the
 *  batch must still show a live link. The floor is deliberately a quarter of
 *  the full bandwidth floor: `$batch` metadata still collapses under
 *  concurrency, so a genuinely slow link must not be oversubscribed. */
const SMALL_FILE_JUDGEABLE_BYTES = 16 * 1024;
const MIN_SMALL_FILE_THROUGHPUT_BPS = 64 * 1024;
/** Two completed batches lift 1 → 2; four lift 2 → the platform ceiling. */
const SMALL_FILE_RAMP_BATCHES = 2;
const SMALL_FILE_CEILING_BATCHES = 4;

interface DownloadBatchObservation {
  files: number;
  bytes: number;
  /** Batch wall clock: CDN metadata refresh, the transfers, hashing and the
   *  remote verification. Only the pre-lock ramp reads it (unchanged since
   *  2026-09-08); the recovery path must never use it. */
  elapsedMs: number;
  /** Sum of the batch's own content-transfer durations (`downloadFile` call
   *  time only). This is the honest single-file signal: on mobile the wall
   *  clock is dominated by metadata, hashing and verification, so a healthy
   *  serial link still measured below the throughput floor and the limit could
   *  never rise (docs/temp/20261026-1240 C2). */
  transferMs: number;
  failed: boolean;
  degradedPath: boolean;
}

/**
 * Conservative, per-run download concurrency controller.
 *
 * Pre-lock ramp (unchanged): every sync round starts at one, two healthy
 * batches reach two, four reach the platform ceiling (3 desktop / 2 mobile).
 * "Healthy" is bandwidth evidence, or — since {@link isSmallFileHealthyBatch}
 * — a completed transfer in the small-file tier that showed a real request
 * window; the 512 KiB/s gate alone could never open for 18-byte notes.
 *
 * Degradation and recovery (2026-10-27): a failed batch or a degraded round
 * still locks the download direction to serial — but no longer forever. The
 * upload direction has been AIMD since `20261026-2327`, while one CDN hiccup
 * pinned every later download of the round to one file at a time
 * (`docs/temp/20261026-1240` B/C), which is exactly the asymmetry the field
 * reports describe. After the lock, a batch that settled every file and shows
 * a healthy transfer-time rate (when it moved enough bytes to judge one) steps
 * the limit back up by one, every {@link RECOVERY_HEALTHY_BATCHES} consecutive
 * such batches, up to the same unchanged platform ceiling.
 *
 * `degradedPath` is deliberately not consulted while recovering: it is sticky
 * for the whole round, so any rule that re-read it could never fire.
 */
export class DownloadConcurrencyPolicy {
  private stableBatches = 0;
  private peakThroughputBps = 0;
  private lockedSerial = false;
  private concurrency = 1;
  /** Consecutive healthy batches since the last degradation. */
  private recoveryBatches = 0;
  /** Consecutive completed small-file batches without bandwidth evidence. */
  private smallFileBatches = 0;

  /** Platform ceiling: desktop adapts 1 → 2 → 3; mobile is capped at 2
   *  (A2 mobile read-only prefetch — memory bound 2 × ≤8 MiB in flight). */
  constructor(
    private readonly maxConcurrency = ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY,
  ) {}

  get limit(): number {
    return this.concurrency;
  }

  /** The round is running under the degraded rule (it was locked at least
   *  once). Recovery can lift the limit again, so read it as "degraded", not as
   *  "concurrency is one". */
  get isLockedSerial(): boolean {
    return this.lockedSerial;
  }

  observeBatch(observation: DownloadBatchObservation): void {
    // A batch that lost a file is evidence about the link, not about the depth:
    // it always returns the direction to the floor.
    if (observation.failed) {
      this.lockSerial();
      return;
    }
    if (this.lockedSerial) {
      this.observeRecoveryBatch(observation);
      return;
    }
    if (observation.degradedPath) {
      this.lockSerial();
      return;
    }

    const elapsedSeconds = Math.max(1, observation.elapsedMs) / 1000;
    const throughputBps = Math.max(0, observation.bytes) / elapsedSeconds;
    const hasBandwidthEvidence = observation.files > 0
      && observation.bytes >= MIN_HEALTHY_BATCH_BYTES
      && throughputBps >= MIN_HEALTHY_THROUGHPUT_BPS;
    if (!hasBandwidthEvidence) {
      if (isSmallFileHealthyBatch(observation)) {
        this.observeSmallFileBatch();
        return;
      }
      this.smallFileBatches = 0;
      this.stableBatches = 0;
      this.concurrency = 1;
      return;
    }
    this.smallFileBatches = 0;

    if (
      this.stableBatches >= 2
      && this.peakThroughputBps > 0
      && throughputBps < this.peakThroughputBps * SIGNIFICANT_THROUGHPUT_DROP_RATIO
    ) {
      this.lockSerial();
      return;
    }

    this.peakThroughputBps = Math.max(this.peakThroughputBps, throughputBps);
    this.stableBatches++;
    if (this.stableBatches >= 4) {
      this.concurrency = this.maxConcurrency;
    } else if (this.stableBatches >= 2) {
      this.concurrency = Math.min(2, this.maxConcurrency);
    }
  }

  /** Recovery after a degradation: one step up per
   *  {@link RECOVERY_HEALTHY_BATCHES} consecutive healthy batches, measured on
   *  the batch's own transfer time. Slow-but-complete batches reset the streak
   *  without a further step down — the floor is the safe state, and this round
   *  deliberately adds no new step-down rule. */
  private observeRecoveryBatch(observation: DownloadBatchObservation): void {
    if (!isRecoverableBatch(observation)) {
      this.recoveryBatches = 0;
      return;
    }
    this.recoveryBatches++;
    if (this.recoveryBatches < RECOVERY_HEALTHY_BATCHES) return;
    this.recoveryBatches = 0;
    if (this.concurrency >= this.maxConcurrency) return;
    this.concurrency = Math.min(this.maxConcurrency, this.concurrency + 1);
  }

  /** A completed small-file batch is link evidence even when it moved too few
   *  bytes to measure a rate. Only the platform ceiling bounds this ramp; the
   *  failure and degradation rules above still run first. The limit never
   *  drops here: a mixed round may already sit at the ceiling from the
   *  bandwidth ladder, and small batches must not undo that evidence. */
  private observeSmallFileBatch(): void {
    this.smallFileBatches++;
    if (this.smallFileBatches >= SMALL_FILE_CEILING_BATCHES) {
      this.concurrency = Math.max(this.concurrency, this.maxConcurrency);
    } else if (this.smallFileBatches >= SMALL_FILE_RAMP_BATCHES) {
      this.concurrency = Math.max(this.concurrency, Math.min(2, this.maxConcurrency));
    }
  }

  private lockSerial(): void {
    this.lockedSerial = true;
    this.concurrency = 1;
    this.recoveryBatches = 0;
    this.smallFileBatches = 0;
  }
}

/** A batch may argue for recovery when every one of its files settled and it
 *  actually moved bytes over a measurable transfer window. The absolute floor
 *  ({@link MIN_HEALTHY_BATCH_BYTES} / {@link MIN_HEALTHY_THROUGHPUT_BPS}) is the
 *  pre-ladder one and is only applied when the batch moved enough bytes to make
 *  a rate meaningful: a batch of 18-byte notes moves no rate anyone can judge,
 *  but a link that carried all of them is not a dead link. */
function isRecoverableBatch(observation: DownloadBatchObservation): boolean {
  if (observation.files <= 0 || observation.bytes <= 0) return false;
  if (!(observation.transferMs > 0)) return false;
  if (observation.bytes < MIN_HEALTHY_BATCH_BYTES) return true;
  const throughputBps = observation.bytes / (observation.transferMs / 1000);
  return throughputBps >= MIN_HEALTHY_THROUGHPUT_BPS;
}

/** The small-file tier's own health judgment: every file settled (the caller
 *  already handled failure/degradation), the transfer window is a real request
 *  round trip, the batch stayed inside the small-file tier, and — only when the
 *  bytes are numerous enough for a rate to mean anything — the link still
 *  carries them at the reduced floor. */
function isSmallFileHealthyBatch(observation: DownloadBatchObservation): boolean {
  if (observation.files <= 0 || observation.bytes <= 0) return false;
  if (!(observation.transferMs >= MIN_SMALL_FILE_TRANSFER_MS)) return false;
  if (observation.transferMs > MAX_SMALL_FILE_TRANSFER_MS) return false;
  if (observation.bytes / observation.files > SMALL_FILE_MAX_BYTES_PER_FILE) {
    return false;
  }
  if (observation.bytes < SMALL_FILE_JUDGEABLE_BYTES) return true;
  const throughputBps = observation.bytes / (observation.transferMs / 1000);
  return throughputBps >= MIN_SMALL_FILE_THROUGHPUT_BPS;
}
