/**
 * 侧栏局域网胶囊（S5a/S5b）。
 *
 * 自动连接管理器是唯一上报来源：配对、连接、传输三阶段与字节进度都写进
 * 同一枚既有「连接速度」胶囊。这里直接驱动 `EasySyncPlugin` 的公开入口，
 * 把阶段、结束清空与需求驱动刷新钉在行为上，而不是只检查源码形状。
 */
import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import type { LanTransferIndicator } from "../src/sync/lan-transfer-activity";

const MIB = 1024 * 1024;

function indicatorOf(plugin: EasySyncPlugin): LanTransferIndicator | null {
  return plugin.getLanTransferIndicator();
}

describe("LAN transfer chip", () => {
  it("shows the automatic session's phases and clears when it ends", () => {
    const plugin = new EasySyncPlugin();
    expect(indicatorOf(plugin)).toBeNull();

    plugin.setLanAutoTransferPhase("pairing");
    expect(indicatorOf(plugin)).toEqual({ phase: "pairing", kbps: null });

    plugin.setLanAutoTransferPhase("connected");
    expect(indicatorOf(plugin)).toEqual({ phase: "connected", kbps: null });

    plugin.setLanAutoTransferPhase(null);
    expect(indicatorOf(plugin)).toBeNull();
  });

  it("arms the demand ticker on the first byte and settles back to connected", () => {
    const plugin = new EasySyncPlugin();
    const refresh = vi.fn();
    vi.spyOn(plugin, "syncView", "get").mockReturnValue({
      refreshTransferIndicator: refresh,
    } as never);
    plugin.setLanAutoTransferPhase("connected");
    refresh.mockClear();

    // First payload byte: the activity flips to `transferring` and the
    // demand ticker must be armed on that edge.
    plugin.reportLanAutoTransferProgress(1 * MIB, 4 * MIB);
    expect(indicatorOf(plugin)?.phase).toBe("transferring");
    expect(refresh).toHaveBeenCalledOnce();

    // More chunks in the same transfer need no extra view refresh.
    plugin.reportLanAutoTransferProgress(2 * MIB, 4 * MIB);
    expect(refresh).toHaveBeenCalledOnce();

    // Payload end returns the session to `connected`; the session stays open.
    plugin.reportLanAutoTransferProgress(4 * MIB, 4 * MIB);
    expect(indicatorOf(plugin)).toEqual({ phase: "connected", kbps: null });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reports the same two-field shape the sidebar chip consumes", () => {
    const plugin = new EasySyncPlugin();
    plugin.setLanAutoTransferPhase("pairing");
    // `resolveTransferChip` reads exactly `phase` and `kbps`; the indicator
    // must not grow a third field that would need new UI.
    expect(Object.keys(indicatorOf(plugin) ?? {})).toEqual(["phase", "kbps"]);
  });
});
