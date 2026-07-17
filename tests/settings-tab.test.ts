import { describe, expect, it } from "vitest";
import { buildSettingsSyncButtonState } from "../src/ui/settings-tab";

describe("buildSettingsSyncButtonState", () => {
  it("uses a warning cancel button while a full sync is running", () => {
    expect(buildSettingsSyncButtonState({
      hasCompletedSync: true,
      isRunning: true,
      canCancel: true,
      planReviewActive: false,
    })).toMatchObject({
      labelKey: "syncView.cancelSync",
      warning: true,
      disabled: false,
      action: "cancel-sync",
    });
  });

  it("uses a disabled processing state for side actions", () => {
    expect(buildSettingsSyncButtonState({
      hasCompletedSync: true,
      isRunning: true,
      canCancel: false,
      planReviewActive: false,
    })).toMatchObject({
      labelKey: "syncView.conflict.processing",
      disabled: true,
      action: "processing",
    });
  });

  it("switches to confirm execute while a reviewed plan is waiting", () => {
    expect(buildSettingsSyncButtonState({
      hasCompletedSync: true,
      isRunning: false,
      canCancel: false,
      planReviewActive: true,
    })).toMatchObject({
      labelKey: "syncPlan.confirmExecute",
      cta: true,
      action: "confirm-plan",
    });
  });

  it("returns the normal sync CTA when idle after first sync", () => {
    expect(buildSettingsSyncButtonState({
      hasCompletedSync: true,
      isRunning: false,
      canCancel: false,
      planReviewActive: false,
    })).toMatchObject({
      labelKey: "settings.firstSync.sync",
      cta: true,
      action: "start-manual",
    });
  });

  it("returns the first-sync CTA before any baseline exists", () => {
    expect(buildSettingsSyncButtonState({
      hasCompletedSync: false,
      isRunning: false,
      canCancel: false,
      planReviewActive: false,
    })).toMatchObject({
      labelKey: "settings.firstSync.start",
      cta: true,
      action: "start-first",
    });
  });
});
