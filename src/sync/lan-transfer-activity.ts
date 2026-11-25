/**
 * LAN session state for the sidebar's existing transfer-rate chip
 * (experimental, S2a/S4 extension).
 *
 * The chip already answers "how fast is the current transfer" for cloud
 * rounds. An active LAN session answers the same question on the same carrier
 * — no new UI surface: which stage the session is in (pairing / connected /
 * transferring) and how fast it is moving bytes. Both facts come from the
 * session's own callbacks; nothing here probes, persists or creates a second
 * speed authority. A phase of `null` means "no LAN session", and the chip
 * falls back to the cloud reading it has always shown.
 */

export type LanTransferPhase = "pairing" | "connected" | "transferring";

/** The phase icon on the existing chip. Phase names are internal; the chip
 *  keeps its single existing tooltip, so no new copy is introduced. */
export function lanTransferPhaseIcon(phase: LanTransferPhase): string {
  if (phase === "pairing") return "house-wifi";
  if (phase === "transferring") return "wifi-sync";
  return "wifi";
}

export interface LanTransferIndicator {
  phase: LanTransferPhase;
  /** KB/s of the transfer in flight; null while no quotable sample exists. */
  kbps: number | null;
}

/** Minimum gap between two rate samples. Progress callbacks arrive per
 *  transport chunk (256 KiB), so without this floor a fast link would fold
 *  sub-millisecond samples and report noise. */
const LAN_RATE_SAMPLE_MIN_MS = 500;
/** Same smoothing cadence as the cloud reading: a new sample roughly
 *  two-thirds replaces the figure once this much wall time has passed. */
const LAN_RATE_SMOOTHING_TAU_MS = 4_000;
/** A reading older than this is no longer "current": the number disappears,
 *  the phase icon stays (the session itself is still open). */
const LAN_RATE_FRESH_MS = 10_000;

export class LanTransferActivity {
  private phase: LanTransferPhase | null = null;
  private smoothedKbps: number | null = null;
  private lastSampleAt = 0;
  private lastSampleBytes = 0;
  private lastReadingAt = 0;

  /** Session lifecycle. `null` clears everything (session gone). A fresh
   *  `pairing` starts a new session, so the previous speed does not leak into
   *  it; `connected` keeps the smoothed figure (the next file in the same
   *  session continues it). */
  setPhase(phase: LanTransferPhase | null): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.lastSampleAt = 0;
    this.lastSampleBytes = 0;
    if (phase === null || phase === "pairing") this.clearReading();
  }

  /** One byte-progress callback from either side of the session (sender:
   *  bytes put on the wire; receiver: bytes received). `total` lets the last
   *  callback of a file settle the phase back to "connected" — the session
   *  stays open, only this transfer finished.
   *
   *  Returns true when that call changed the phase (`connected` →
   *  `transferring` on the first byte, or back at payload end). The sidebar
   *  ticker is demand-driven now, so its owner arms it on this edge instead of
   *  polling; unchanged per-chunk calls return false. */
  reportProgress(downloaded: number, total: number, now = Date.now()): boolean {
    const priorPhase = this.phase;
    if (this.phase === null || !(downloaded > 0)) return false;
    // Re-baseline when a new transfer starts (`connected` → first byte), when
    // no sample exists yet, or when the byte count went backwards. The
    // "no sample" case matters now that the automatic manager reports
    // `transferring` before the first byte arrives: `setPhase` zeroes the
    // baseline, and folding `downloaded - 0` over `now - 0` would quote a
    // bogus 0 KB/s as if it were measured.
    if (
      this.phase !== "transferring"
      || this.lastSampleAt === 0
      || downloaded < this.lastSampleBytes
    ) {
      this.phase = "transferring";
      // A new file restarts at zero: re-baseline without folding a negative
      // delta. The smoothed figure deliberately survives across files.
      this.lastSampleAt = now;
      this.lastSampleBytes = downloaded;
      return this.phase !== priorPhase;
    }
    const deltaMs = now - this.lastSampleAt;
    if (deltaMs >= LAN_RATE_SAMPLE_MIN_MS) {
      const moved = downloaded - this.lastSampleBytes;
      this.lastSampleAt = now;
      this.lastSampleBytes = downloaded;
      if (moved > 0) {
        const instantKbps = moved / 1024 / (deltaMs / 1000);
        this.smoothedKbps = this.smoothedKbps === null
          ? instantKbps
          : this.smoothedKbps
            + (1 - Math.exp(-deltaMs / LAN_RATE_SMOOTHING_TAU_MS))
              * (instantKbps - this.smoothedKbps);
        this.lastReadingAt = now;
      }
    }
    if (total > 0 && downloaded >= total) {
      // Bytes are through; the session is waiting for the next request/ack.
      this.phase = "connected";
    }
    return this.phase !== priorPhase;
  }

  getIndicator(now = Date.now()): LanTransferIndicator | null {
    if (this.phase === null) return null;
    const fresh = this.lastReadingAt > 0
      && now - this.lastReadingAt <= LAN_RATE_FRESH_MS;
    return {
      phase: this.phase,
      kbps: this.phase === "transferring" && fresh && this.smoothedKbps !== null
        ? Math.round(this.smoothedKbps)
        : null,
    };
  }

  private clearReading(): void {
    this.smoothedKbps = null;
    this.lastReadingAt = 0;
  }
}
