export const ADAPTIVE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const DESKTOP_INITIAL_CONCURRENCY = 2;
const DESKTOP_MAX_CONCURRENCY = 4;
const MOBILE_INITIAL_CONCURRENCY = 1;
const MOBILE_MAX_CONCURRENCY = 2;
const SIGNIFICANT_THROUGHPUT_DROP_RATIO = 0.5;

export interface UploadBatchObservation {
  files: number;
  elapsedMs: number;
  failed: boolean;
}

/**
 * Conservative, per-run small-upload concurrency controller.
 *
 * Every run starts from a bounded platform default. Healthy full waves may
 * increase concurrency, while any item failure or pronounced files-per-second
 * regression locks the rest of the round to serial dispatch.
 */
export class UploadConcurrencyPolicy {
  private stableBatches = 0;
  private peakFilesPerSecond = 0;
  private lockedSerial = false;
  private concurrency: number;

  constructor(private readonly mobile: boolean) {
    this.concurrency = mobile
      ? MOBILE_INITIAL_CONCURRENCY
      : DESKTOP_INITIAL_CONCURRENCY;
  }

  get limit(): number {
    return this.concurrency;
  }

  get isLockedSerial(): boolean {
    return this.lockedSerial;
  }

  observeBatch(observation: UploadBatchObservation): void {
    if (this.lockedSerial) return;
    if (observation.failed) {
      this.lockSerial();
      return;
    }
    if (observation.files < this.concurrency || observation.files === 0) return;

    const elapsedSeconds = Math.max(1, observation.elapsedMs) / 1000;
    const filesPerSecond = observation.files / elapsedSeconds;
    if (
      this.stableBatches >= 2
      && this.peakFilesPerSecond > 0
      && filesPerSecond
        < this.peakFilesPerSecond * SIGNIFICANT_THROUGHPUT_DROP_RATIO
    ) {
      this.lockSerial();
      return;
    }

    this.peakFilesPerSecond = Math.max(
      this.peakFilesPerSecond,
      filesPerSecond,
    );
    this.stableBatches++;
    if (this.mobile) {
      if (this.stableBatches >= 2) this.concurrency = MOBILE_MAX_CONCURRENCY;
      return;
    }
    if (this.stableBatches >= 4) {
      this.concurrency = DESKTOP_MAX_CONCURRENCY;
    } else if (this.stableBatches >= 2) {
      this.concurrency = 3;
    }
  }

  private lockSerial(): void {
    this.lockedSerial = true;
    this.concurrency = 1;
  }
}
