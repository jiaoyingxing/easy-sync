export const ADAPTIVE_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY = 3;
export const MOBILE_DOWNLOAD_MAX_CONCURRENCY = 2;

const MIN_HEALTHY_BATCH_BYTES = 128 * 1024;
const MIN_HEALTHY_THROUGHPUT_BPS = 512 * 1024;
const SIGNIFICANT_THROUGHPUT_DROP_RATIO = 0.5;

export interface DownloadBatchObservation {
  files: number;
  bytes: number;
  elapsedMs: number;
  failed: boolean;
  degradedPath: boolean;
}

/**
 * Conservative, per-run download concurrency controller.
 *
 * It deliberately has no persisted history: every sync round starts at one,
 * and any unhealthy signal locks the remainder of that round back to one.
 */
export class DownloadConcurrencyPolicy {
  private stableBatches = 0;
  private peakThroughputBps = 0;
  private lockedSerial = false;
  private concurrency = 1;

  /** Platform ceiling: desktop adapts 1 → 2 → 3; mobile is capped at 2
   *  (A2 mobile read-only prefetch — memory bound 2 × ≤8 MiB in flight). */
  constructor(
    private readonly maxConcurrency = ADAPTIVE_DOWNLOAD_MAX_CONCURRENCY,
  ) {}

  get limit(): number {
    return this.concurrency;
  }

  get isLockedSerial(): boolean {
    return this.lockedSerial;
  }

  observeBatch(observation: DownloadBatchObservation): void {
    if (this.lockedSerial) return;
    if (observation.failed || observation.degradedPath) {
      this.lockSerial();
      return;
    }

    const elapsedSeconds = Math.max(1, observation.elapsedMs) / 1000;
    const throughputBps = Math.max(0, observation.bytes) / elapsedSeconds;
    const hasBandwidthEvidence = observation.files > 0
      && observation.bytes >= MIN_HEALTHY_BATCH_BYTES
      && throughputBps >= MIN_HEALTHY_THROUGHPUT_BPS;
    if (!hasBandwidthEvidence) {
      this.stableBatches = 0;
      this.concurrency = 1;
      return;
    }

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

  private lockSerial(): void {
    this.lockedSerial = true;
    this.concurrency = 1;
  }
}
