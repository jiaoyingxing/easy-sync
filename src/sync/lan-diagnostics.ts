/**
 * In-memory LAN attempt diagnostics (S4, experimental).
 *
 * One bounded record plus four monotonic counters for the diagnostic report:
 * the latest attempt and how many attempts this session actually made. Nothing
 * here is persisted or attached to the sync history schema. Route is the
 * selected ICE candidate type only; addresses, ports and raw candidates are
 * deliberately never stored.
 */

export type LanRouteType =
  | "host"
  | "srflx"
  | "prflx"
  | "relay"
  | "unknown";

export type LanDiagnosticOutcome =
  | "hit"
  | "fallback"
  | "rejected"
  | "skipped";

export type LanDiagnosticReason =
  | "disabled"
  | "below-threshold"
  | "no-source"
  | "source-error"
  | "hash-mismatch"
  | "route-relay";

export interface LanDiagnosticSnapshot {
  readonly outcome: LanDiagnosticOutcome;
  readonly reason?: LanDiagnosticReason;
  /** Selected candidate type, never a candidate string or endpoint. */
  readonly route: LanRouteType;
  /** Bytes moved over the LAN attempt; 0 when the attempt never started. */
  readonly bytes: number;
  readonly elapsedMs: number;
  readonly at: number;
}

/** Session-local tallies, one per outcome. Never a history. */
export interface LanDiagnosticCounters {
  readonly hit: number;
  readonly fallback: number;
  readonly rejected: number;
  readonly skipped: number;
}

const EMPTY_COUNTERS: LanDiagnosticCounters = {
  hit: 0,
  fallback: 0,
  rejected: 0,
  skipped: 0,
};

export function normalizeLanRouteType(value: unknown): LanRouteType {
  return value === "host"
    || value === "srflx"
    || value === "prflx"
    || value === "relay"
    ? value
    : "unknown";
}

export class LanDiagnostics {
  private last: LanDiagnosticSnapshot | null = null;
  private counts: LanDiagnosticCounters = EMPTY_COUNTERS;

  record(snapshot: LanDiagnosticSnapshot): void {
    this.last = { ...snapshot };
    this.counts = {
      hit: this.counts.hit + (snapshot.outcome === "hit" ? 1 : 0),
      fallback: this.counts.fallback + (snapshot.outcome === "fallback" ? 1 : 0),
      rejected: this.counts.rejected + (snapshot.outcome === "rejected" ? 1 : 0),
      skipped: this.counts.skipped + (snapshot.outcome === "skipped" ? 1 : 0),
    };
  }

  getLast(): LanDiagnosticSnapshot | null {
    return this.last;
  }

  /** Session tallies for the diagnostic report; a copy, never the live object. */
  getCounters(): LanDiagnosticCounters {
    return { ...this.counts };
  }
}
