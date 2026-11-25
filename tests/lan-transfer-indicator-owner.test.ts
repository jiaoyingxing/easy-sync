/**
 * 侧栏局域网胶囊的归属（S5b 交叉场景）。
 *
 * 实验弹框与自动连接共用同一枚胶囊，但两条会话互不隶属。弹框关闭时
 * `resetWebRtc` 会报 `null`；若自动连接仍有活会话，胶囊不得被误清。这里直接
 * 驱动 `EasySyncPlugin` 的三个公开入口（弹框阶段 / 自动阶段 / 读数），把
 * 归属规则钉在行为上，而不是只检查源码形状。
 */
import { describe, expect, it } from "vitest";
import EasySyncPlugin from "../src/main";
import type { LanTransferIndicator } from "../src/sync/lan-transfer-activity";

function indicatorOf(plugin: EasySyncPlugin): LanTransferIndicator | null {
  return plugin.getLanTransferIndicator();
}

describe("LAN transfer chip ownership", () => {
  it("keeps the auto connection's session when the modal closes", () => {
    const plugin = new EasySyncPlugin();
    // The automatic manager connects first (it runs without any window open).
    plugin.setLanAutoTransferPhase("connected");
    expect(indicatorOf(plugin)).toEqual({ phase: "connected", kbps: null });

    // The user then opens the diagnostic modal: it takes over the chip.
    plugin.setLanTransferPhase("pairing");
    expect(indicatorOf(plugin)?.phase).toBe("pairing");
    plugin.setLanTransferPhase("connected");

    // Closing the modal reports `null`. The auto session is still alive, so
    // the chip must fall back to it instead of going dark.
    plugin.setLanTransferPhase(null);
    expect(indicatorOf(plugin)).toEqual({ phase: "connected", kbps: null });
  });

  it("falls back to the last auto phase, not a stale modal one", () => {
    const plugin = new EasySyncPlugin();
    plugin.setLanAutoTransferPhase("pairing");
    // The modal opens and reaches a later phase, then closes while the auto
    // handshake is still pairing: the chip must resume "pairing".
    plugin.setLanTransferPhase("transferring");
    plugin.setLanTransferPhase(null);
    expect(indicatorOf(plugin)?.phase).toBe("pairing");
  });

  it("clears the chip when no session remains", () => {
    const plugin = new EasySyncPlugin();
    plugin.setLanAutoTransferPhase("connected");
    plugin.setLanAutoTransferPhase(null);
    expect(indicatorOf(plugin)).toBeNull();

    plugin.setLanTransferPhase("pairing");
    expect(indicatorOf(plugin)?.phase).toBe("pairing");
    plugin.setLanTransferPhase(null);
    expect(indicatorOf(plugin)).toBeNull();
  });

  it("ignores the closing side's null while the other side owns the chip", () => {
    const plugin = new EasySyncPlugin();
    // Auto owns the chip; the modal closes a session that was never on screen.
    plugin.setLanAutoTransferPhase("connected");
    plugin.setLanTransferPhase(null);
    expect(indicatorOf(plugin)?.phase).toBe("connected");

    // Modal owns the chip; the auto session's channel closes beneath it.
    plugin.setLanTransferPhase("pairing");
    plugin.setLanAutoTransferPhase(null);
    expect(indicatorOf(plugin)?.phase).toBe("pairing");
  });

  it("routes byte progress only to the session that owns the chip", () => {
    const plugin = new EasySyncPlugin();
    plugin.setLanAutoTransferPhase("connected");
    plugin.setLanAutoTransferPhase("transferring");
    // A progress callback from a window that does not own the chip must not
    // move the figure the auto session owns.
    plugin.reportLanTransferProgress(512 * 1024, 4 * 1024 * 1024);
    expect(indicatorOf(plugin)).toEqual({ phase: "transferring", kbps: null });

    // The modal takes over; now the auto side's progress is the one ignored.
    plugin.setLanTransferPhase("pairing");
    plugin.setLanTransferPhase("connected");
    plugin.reportLanAutoTransferProgress(1024 * 1024, 8 * 1024 * 1024);
    expect(indicatorOf(plugin)).toEqual({ phase: "connected", kbps: null });

    // The owner's own progress opens the transfer phase (the first positive
    // callback only re-baselines; no number is invented).
    plugin.reportLanTransferProgress(1024 * 1024, 8 * 1024 * 1024);
    expect(indicatorOf(plugin)).toEqual({ phase: "transferring", kbps: null });
  });

  it("reports the same two-field shape the sidebar chip consumes", () => {
    const plugin = new EasySyncPlugin();
    plugin.setLanAutoTransferPhase("pairing");
    // `resolveTransferChip` reads exactly `phase` and `kbps`; the indicator
    // must not grow a third field that would need new UI.
    expect(Object.keys(indicatorOf(plugin) ?? {})).toEqual(["phase", "kbps"]);
  });
});
