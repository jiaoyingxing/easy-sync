import { describe, expect, it } from "vitest";
import { RIBBON_STATUS_ICONS, resolveRibbonStatus } from "../src/ui/ribbon-status";

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
});
