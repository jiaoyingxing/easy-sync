import {
  compatClearTimeout,
  compatSetTimeout,
  type TimeoutHandle,
} from "../obsidian-compat";

export const MUTATION_RECOVERY_BACKOFF_MS = [
  5_000,
  15_000,
  45_000,
  120_000,
] as const;
export const MUTATION_RECOVERY_MAX_AUTOMATIC_OBSERVATIONS =
  MUTATION_RECOVERY_BACKOFF_MS.length + 1;
const MUTATION_RECOVERY_BUSY_RETRY_MS = 5_000;
const MUTATION_RECOVERY_JITTER_MS = 1_000;

export type MutationRecoveryAttemptOutcome =
  | { state: "settled" }
  | { state: "retry"; retryAfterSeconds: number | null }
  | { state: "blocked" }
  | { state: "inactive" }
  | { state: "busy" };

export interface MutationRecoverySchedulerSnapshot {
  state: "idle" | "scheduled" | "running" | "exhausted";
  automaticObservations: number;
  nextObservationAt: number | null;
}

/**
 * Timer-only controller for active V2 mutation recovery.
 *
 * The persisted mutation ledger remains the sole recovery intent. This class
 * keeps only a bounded, process-local observation budget and decides when to
 * ask Main for another recovery-only run. It cannot inspect files, Graph
 * facts, plans, or execute mutations.
 */
export class MutationRecoveryScheduler {
  private timer: TimeoutHandle | null = null;
  private running = false;
  private automaticObservations = 0;
  private notBefore = 0;
  private exhausted = false;
  private version = 0;

  constructor(
    private readonly observe: () => Promise<MutationRecoveryAttemptOutcome>,
    private readonly onExhausted: () => void,
    private readonly random: () => number = Math.random,
    private readonly onStateChange?: (
      snapshot: MutationRecoverySchedulerSnapshot,
    ) => void,
  ) {}

  get pending(): boolean {
    return this.timer !== null || this.running;
  }

  get observationCount(): number {
    return this.automaticObservations;
  }

  get budgetExhausted(): boolean {
    return this.exhausted;
  }

  get snapshot(): MutationRecoverySchedulerSnapshot {
    return {
      state: this.exhausted
        ? "exhausted"
        : this.running
          ? "running"
          : this.timer !== null
            ? "scheduled"
            : "idle",
      automaticObservations: this.automaticObservations,
      nextObservationAt: this.timer !== null ? this.notBefore : null,
    };
  }

  /**
   * Request the first observation for persisted recovery intent. Repeated
   * startup, foreground, interval, or dirty triggers coalesce into one timer
   * and never move a Retry-After boundary earlier.
   */
  requestObservation(): boolean {
    if (this.exhausted || this.running || this.timer !== null) return false;
    this.schedule(Math.max(0, this.notBefore - Date.now()));
    return true;
  }

  /**
   * Record a retryable failure produced outside this scheduler (for example a
   * normal automatic round that persisted a new mutation intent).
   */
  continueAfterExternalFailure(retryAfterSeconds: number | null): boolean {
    if (this.exhausted) return false;
    this.automaticObservations = Math.max(1, this.automaticObservations);
    return this.scheduleRetry(retryAfterSeconds);
  }

  reset(): void {
    compatClearTimeout(this.timer);
    this.timer = null;
    this.running = false;
    this.automaticObservations = 0;
    this.notBefore = 0;
    this.exhausted = false;
    this.version++;
    this.emitStateChange();
  }

  cancel(): void {
    this.reset();
  }

  private schedule(delayMs: number): void {
    compatClearTimeout(this.timer);
    const normalizedDelay = Math.max(0, Math.round(delayMs));
    this.notBefore = Date.now() + normalizedDelay;
    this.timer = compatSetTimeout(() => {
      this.timer = null;
      void this.flush();
    }, normalizedDelay);
    this.emitStateChange();
  }

  private async flush(): Promise<void> {
    if (this.exhausted || this.running) return;
    const observedVersion = this.version;
    this.running = true;
    this.emitStateChange();
    let outcome: MutationRecoveryAttemptOutcome;
    try {
      outcome = await this.observe();
    } catch {
      outcome = { state: "blocked" };
    } finally {
      this.running = false;
    }
    if (this.version !== observedVersion) return;

    if (outcome.state === "settled" || outcome.state === "inactive") {
      this.reset();
      return;
    }
    if (outcome.state === "blocked") {
      this.cancel();
      return;
    }
    if (outcome.state === "busy") {
      this.schedule(Math.max(
        MUTATION_RECOVERY_BUSY_RETRY_MS,
        this.notBefore - Date.now(),
      ));
      return;
    }

    this.automaticObservations++;
    this.scheduleRetry(outcome.retryAfterSeconds);
  }

  private scheduleRetry(retryAfterSeconds: number | null): boolean {
    if (
      this.automaticObservations
      >= MUTATION_RECOVERY_MAX_AUTOMATIC_OBSERVATIONS
    ) {
      this.exhausted = true;
      compatClearTimeout(this.timer);
      this.timer = null;
      this.emitStateChange();
      this.onExhausted();
      return false;
    }
    const policyIndex = Math.max(0, this.automaticObservations - 1);
    const policyDelay =
      MUTATION_RECOVERY_BACKOFF_MS[
        Math.min(policyIndex, MUTATION_RECOVERY_BACKOFF_MS.length - 1)
      ];
    const retryAfterMs =
      retryAfterSeconds === null
      || !Number.isFinite(retryAfterSeconds)
      ? 0
      : Math.max(0, retryAfterSeconds * 1_000);
    const randomSample = this.random();
    const jitter = Math.floor(
      Math.max(
        0,
        Math.min(1, Number.isFinite(randomSample) ? randomSample : 0),
      ) * MUTATION_RECOVERY_JITTER_MS,
    );
    const delayMs = Math.max(policyDelay, retryAfterMs) + jitter;
    this.notBefore = Date.now() + delayMs;
    this.schedule(delayMs);
    return true;
  }

  private emitStateChange(): void {
    try {
      this.onStateChange?.(this.snapshot);
    } catch {
      // Presentation refresh must never change recovery scheduling.
    }
  }
}
