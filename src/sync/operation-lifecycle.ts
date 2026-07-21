/**
 * One in-memory lifecycle shared by full syncs, side actions, and plugin
 * lifecycle operations. A captured epoch is a capability: once invalidated,
 * asynchronous work holding the old value may finish I/O but must not issue
 * another mutation or publish its result into sync state.
 */
export class OperationLifecycle {
  private epoch = 0;
  private invalidationReason = "initial";

  capture(): number {
    return this.epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }

  invalidate(reason: string): number {
    this.epoch++;
    this.invalidationReason = reason;
    return this.epoch;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  get lastInvalidationReason(): string {
    return this.invalidationReason;
  }
}
