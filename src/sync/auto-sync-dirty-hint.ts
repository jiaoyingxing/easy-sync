import {
  compatClearTimeout,
  compatSetTimeout,
  type TimeoutHandle,
} from "../obsidian-compat";

export const DEFAULT_AUTO_SYNC_CHANGE_DELAY_SECONDS = 7;
export const MIN_AUTO_SYNC_CHANGE_DELAY_SECONDS = 0;
export const MAX_AUTO_SYNC_CHANGE_DELAY_SECONDS = 10;
export const LOCAL_DIRTY_DEBOUNCE_MS =
  DEFAULT_AUTO_SYNC_CHANGE_DELAY_SECONDS * 1_000;

export function normalizeAutoSyncChangeDelaySeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AUTO_SYNC_CHANGE_DELAY_SECONDS;
  }
  return Math.min(
    MAX_AUTO_SYNC_CHANGE_DELAY_SECONDS,
    Math.max(MIN_AUTO_SYNC_CHANGE_DELAY_SECONDS, Math.round(value)),
  );
}

/**
 * In-memory hint only. It decides when to ask the normal auto-sync entry to
 * run; it never decides what changed or which sync actions are valid.
 */
export class AutoSyncDirtyHint {
  private timer: TimeoutHandle | null = null;
  private version = 0;
  private dirty = false;

  constructor(
    private readonly onReady: () => Promise<boolean>,
    private delayMs = LOCAL_DIRTY_DEBOUNCE_MS,
  ) {}

  get pending(): boolean {
    return this.dirty;
  }

  setDelayMs(delayMs: number): void {
    const normalizedDelayMs = Math.max(1, Math.round(delayMs));
    if (this.delayMs === normalizedDelayMs) return;
    this.delayMs = normalizedDelayMs;
    if (this.dirty && this.timer !== null) this.schedule();
  }

  /** Returns true only when this event starts a new debounce window. */
  mark(): boolean {
    const startedWindow = this.timer === null;
    this.dirty = true;
    this.version++;
    this.schedule();
    return startedWindow;
  }

  cancel(): void {
    compatClearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.version++;
  }

  private schedule(): void {
    compatClearTimeout(this.timer);
    this.timer = compatSetTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    const observedVersion = this.version;
    let consumed = false;
    try {
      consumed = await this.onReady();
    } catch {
      consumed = false;
    } finally {
      // A new event while the shared auto-sync entry was running owns its own
      // debounce timer. Never clear that newer hint with the older completion.
      if (this.version !== observedVersion) return;
      if (consumed) {
        this.dirty = false;
      } else {
        this.schedule();
      }
    }
  }
}
