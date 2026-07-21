import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import type { SyncProgressState } from "../src/sync/sync-progress";
import {
  RIBBON_STATUS_ICONS,
  resolveRibbonStatus,
  resolveRibbonStatusLabel,
} from "../src/ui/ribbon-status";

function progress(
  overrides: Partial<SyncProgressState> = {},
): SyncProgressState {
  return {
    phase: "idle",
    current: 0,
    total: 0,
    currentFile: "",
    currentItemBytes: 0,
    currentItemTotalBytes: 0,
    currentItemComplete: false,
    cancelRequested: false,
    completedFiles: [],
    startedAt: 1,
    ...overrides,
  };
}

describe("resolveRibbonStatus", () => {
  it("uses the highest-priority visible state", () => {
    expect(RIBBON_STATUS_ICONS.syncing).toBe("refresh-cw");
    expect(resolveRibbonStatus({
      loggedIn: false,
      cancelling: false,
      syncing: false,
      needsAttention: false,
      recentSuccess: false,
    })).toBe("loggedOut");

    expect(resolveRibbonStatus({
      loggedIn: true,
      cancelling: true,
      syncing: true,
      needsAttention: true,
      recentSuccess: true,
    })).toBe("cancelling");

    expect(resolveRibbonStatus({
      loggedIn: true,
      cancelling: false,
      syncing: true,
      needsAttention: true,
      recentSuccess: true,
    })).toBe("syncing");

    expect(resolveRibbonStatus({
      loggedIn: true,
      cancelling: false,
      syncing: false,
      needsAttention: true,
      recentSuccess: true,
    })).toBe("attention");

    expect(resolveRibbonStatus({
      loggedIn: true,
      cancelling: false,
      syncing: false,
      needsAttention: false,
      recentSuccess: true,
    })).toBe("success");

    expect(resolveRibbonStatus({
      loggedIn: true,
      cancelling: false,
      syncing: false,
      needsAttention: false,
      recentSuccess: false,
    })).toBe("ready");
  });

  it("keeps one syncing icon while the tooltip exposes the exact stage", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);

    expect(resolveRibbonStatusLabel("syncing", progress({ phase: "scanning" }), t))
      .toBe("扫描本地文件，打开同步状态");
    expect(resolveRibbonStatusLabel("syncing", progress({ phase: "preparing" }), t))
      .toBe("准备远端存储，打开同步状态");
    expect(RIBBON_STATUS_ICONS.syncing).toBe("refresh-cw");
  });
});
