/**
 * Sidebar chip LAN phases (experimental): the same carrier as the cloud
 * connection-speed reading, driven by the LAN session's own callbacks.
 *
 * The chip must never invent a number: only real byte progress admitted by
 * the sample cadence moves the figure, and the figure drops out of the value
 * slot (icon stays) once it is no longer current.
 */
import { describe, expect, it } from "vitest";
import {
  LanTransferActivity,
  lanTransferPhaseIcon,
  type LanTransferPhase,
} from "../src/sync/lan-transfer-activity";

const KIB = 1024;

function transferringActivity(): LanTransferActivity {
  const activity = new LanTransferActivity();
  activity.setPhase("pairing");
  activity.setPhase("connected");
  return activity;
}

describe("LAN transfer activity (sidebar chip)", () => {
  it("maps each phase to an existing host icon", () => {
    expect(lanTransferPhaseIcon("pairing")).toBe("house-wifi");
    expect(lanTransferPhaseIcon("connected")).toBe("wifi");
    expect(lanTransferPhaseIcon("transferring")).toBe("wifi-sync");
  });

  it("has no indicator before a session and after it ends", () => {
    const activity = new LanTransferActivity();
    expect(activity.getIndicator()).toBeNull();
    activity.setPhase("pairing");
    expect(activity.getIndicator()).toEqual({ phase: "pairing", kbps: null });
    activity.setPhase(null);
    expect(activity.getIndicator()).toBeNull();
  });

  it("keeps the icon-only shape until real bytes move", () => {
    const activity = new LanTransferActivity();
    activity.setPhase("connected");
    expect(activity.getIndicator()).toEqual({ phase: "connected", kbps: null });
    // A progress signal without bytes (0 of total) must not flip the phase.
    activity.reportProgress(0, 4096, 1_000);
    expect(activity.getIndicator(1_000)?.phase).toBe("connected");
  });

  it("measures the rate from real progress callbacks", () => {
    const activity = transferringActivity();
    activity.reportProgress(0, 4 * 1024 * KIB, 1_000);
    // First positive callback only opens the transfer and sets the baseline.
    activity.reportProgress(512 * KIB, 4 * 1024 * KIB, 1_000);
    expect(activity.getIndicator(1_000)).toEqual({
      phase: "transferring",
      kbps: null,
    });
    // 512 KiB in 1 s after the baseline = 512 KB/s.
    activity.reportProgress(1024 * KIB, 4 * 1024 * KIB, 2_000);
    const reading = activity.getIndicator(2_000);
    expect(reading?.phase).toBe("transferring");
    expect(reading?.kbps).toBe(512);
  });

  it("does not fold sub-cadence samples as a rate", () => {
    const activity = transferringActivity();
    activity.reportProgress(1024, 8 * KIB, 1_000);
    // Bytes arrive, but only 100 ms later: too short to describe the link.
    activity.reportProgress(2 * 1024, 8 * KIB, 1_100);
    expect(activity.getIndicator(1_100)?.kbps).toBeNull();
  });

  it("settles back to the connected phase when a file completes", () => {
    const activity = transferringActivity();
    activity.reportProgress(256 * KIB, 512 * KIB, 1_000);
    activity.reportProgress(512 * KIB, 512 * KIB, 1_600);
    expect(activity.getIndicator(1_600)?.phase).toBe("connected");
    // The value slot is empty again: bytes are through, nothing to quote.
    expect(activity.getIndicator(1_600)?.kbps).toBeNull();
  });

  it("drops a stale rate but keeps the session icon", () => {
    const activity = transferringActivity();
    activity.reportProgress(256 * KIB, 8 * 1024 * KIB, 1_000);
    activity.reportProgress(768 * KIB, 8 * 1024 * KIB, 2_000);
    const fresh = activity.getIndicator(2_000);
    expect(fresh?.kbps).not.toBeNull();
    // Nothing moved for longer than the freshness window: no current speed.
    const stale = activity.getIndicator(20_000);
    expect(stale).toEqual({ phase: "transferring", kbps: null });
  });

  it("re-baselines on a new file without folding a negative delta", () => {
    const activity = transferringActivity();
    activity.reportProgress(512 * KIB, 4 * 1024 * KIB, 1_000);
    activity.reportProgress(1024 * KIB, 4 * 1024 * KIB, 2_000);
    const before = activity.getIndicator(2_000);
    expect(before?.kbps).not.toBeNull();
    // Second file starts at zero; its first bytes must not read as negative
    // movement or as a bogus spike.
    activity.reportProgress(0, 2 * 1024 * KIB, 2_100);
    activity.reportProgress(128 * KIB, 2 * 1024 * KIB, 2_200);
    expect(activity.getIndicator(2_200)?.phase).toBe("transferring");
  });

  it("measures the first sample when the phase was already set by a caller", () => {
    // S5b: the automatic manager reports "transferring" before the first byte;
    // that must not zero the baseline. With wall-clock timestamps a zeroed
    // baseline folds the first payload over ~50 years and quotes ~0 KB/s.
    const activity = new LanTransferActivity();
    const t0 = 1_700_000_000_000;
    activity.setPhase("connected");
    activity.setPhase("transferring");
    activity.reportProgress(512 * KIB, 4 * KIB * KIB, t0 + 1_000);
    activity.reportProgress(1024 * KIB, 4 * KIB * KIB, t0 + 2_000);
    expect(activity.getIndicator(t0 + 2_000)).toEqual({
      phase: "transferring",
      kbps: 512,
    });
  });

  it("does not leak a previous session's speed into a new session", () => {
    const activity = new LanTransferActivity();
    activity.setPhase("pairing");
    activity.setPhase("connected");
    activity.reportProgress(256 * KIB, 4 * 1024 * KIB, 1_000);
    activity.reportProgress(768 * KIB, 4 * 1024 * KIB, 2_000);
    expect(activity.getIndicator(2_000)?.kbps).not.toBeNull();
    activity.setPhase(null);
    activity.setPhase("pairing");
    activity.setPhase("connected");
    activity.reportProgress(256 * KIB, 4 * 1024 * KIB, 3_000);
    expect(activity.getIndicator(3_000)?.kbps).toBeNull();
  });

  it("accepts every phase the modal can report", () => {
    const phases: LanTransferPhase[] = ["pairing", "connected", "transferring"];
    for (const phase of phases) {
      const activity = new LanTransferActivity();
      activity.setPhase(phase);
      expect(activity.getIndicator()?.phase).toBe(phase);
    }
  });
});

describe("LAN transfer activity phase edges", () => {
  it("reports only the edge that arms or stops the demand ticker", () => {
    const activity = transferringActivity();
    // No bytes: no transition, so no view refresh.
    expect(activity.reportProgress(0, 1_000, 1_000)).toBe(false);
    // First byte flips connected -> transferring.
    expect(activity.reportProgress(100, 1_000, 1_100)).toBe(true);
    // More chunks inside the same transfer need no edge.
    expect(activity.reportProgress(200, 1_000, 1_300)).toBe(false);
    // Payload end flips back to connected.
    expect(activity.reportProgress(1_000, 1_000, 1_600)).toBe(true);
    // The next file's first byte flips connected -> transferring again.
    expect(activity.reportProgress(100, 1_000, 1_700)).toBe(true);
    expect(activity.reportProgress(200, 1_000, 1_900)).toBe(false);
  });
});
