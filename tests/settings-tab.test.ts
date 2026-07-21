import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSettingsSyncButtonState } from "../src/ui/settings-tab";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";

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

  it("places automatic handling in its own row between more settings and auto-sync", () => {
    const source = readFileSync("src/ui/settings-tab.ts", "utf8");
    const moreSettingsStart = source.indexOf('.setName(t("settings.moreConfig.name"))');
    const handlingStart = source.indexOf('.setName(t("settings.automaticHandling.name"))');
    const autoSyncStart = source.indexOf('.setName(t("settings.autoSync.name"))');
    const scopeAction = source.indexOf(".addButton", handlingStart);
    const autoSyncToggle = source.indexOf(".addToggle", autoSyncStart);

    expect(moreSettingsStart).toBeGreaterThanOrEqual(0);
    expect(handlingStart).toBeGreaterThan(moreSettingsStart);
    expect(autoSyncStart).toBeGreaterThan(handlingStart);
    expect(autoSyncStart).toBeGreaterThanOrEqual(0);
    expect(scopeAction).toBeGreaterThan(handlingStart);
    expect(scopeAction).toBeLessThan(autoSyncStart);
    expect(autoSyncToggle).toBeGreaterThan(autoSyncStart);
    expect(source).toContain('setButtonText(t("settings.automaticHandling.button"))');
    expect(source).toContain('t("settings.automaticHandling.open")');
    expect(source).toContain('setAttribute(\n            "aria-label"');
    expect(source).not.toContain(".addExtraButton");
    expect(source).not.toContain('setName(t("settings.autoMerge.name"))');
  });

  it("renders both automatic handling choices as native toggles without triggering sync", () => {
    const source = readFileSync("src/ui/automatic-handling-modal.ts", "utf8");

    expect(source.match(/new Setting\(/g)).toHaveLength(2);
    expect(source).toContain("autoDeleteLocalFiles");
    expect(source).toContain("mergeNonOverlappingText");
    expect(source).toContain("updateAutomaticHandlingPolicy");
    expect(source).not.toContain("startManualSync");
    expect(source).not.toContain("confirmRemoteDelete");
  });

  it("keeps automatic handling copy directional and condition-accurate", () => {
    expect(zhCN["settings.automaticHandling.desc"]).toBe(
      "选择同步时可自动完成的操作。",
    );
    expect(zhCN["settings.automaticHandling.intro"]).toBe(
      "选项从下一次同步起生效，不会立即改动文件。",
    );
    expect(zhCN["settings.automaticHandling.autoDeleteLocalFiles.name"]).toBe(
      "将远端删除同步到本地",
    );
    expect(zhCN["settings.automaticHandling.autoDeleteLocalFiles.desc"]).toBe(
      "远端文件已删除且本地自上次同步后未修改时，删除本地对应文件。EasySync 不保留额外副本。",
    );
    expect(zhCN["settings.automaticHandling.mergeNonOverlappingText.name"]).toBe(
      "合并不重叠的文本修改",
    );
    expect(zhCN["settings.automaticHandling.mergeNonOverlappingText.desc"]).toBe(
      "本地和远端修改同一份已同步文本、且修改内容互不重叠时，将两边修改合并并同步到两端；无法安全合并时留待手动处理。",
    );
    expect(en["settings.automaticHandling.autoDeleteLocalFiles.name"]).toBe(
      "Apply remote deletions locally",
    );
    expect(en["settings.automaticHandling.autoDeleteLocalFiles.desc"]).toContain(
      "delete the corresponding local file",
    );
    expect(en["settings.automaticHandling.mergeNonOverlappingText.name"]).toBe(
      "Merge non-overlapping text changes",
    );
    expect(en["settings.automaticHandling.mergeNonOverlappingText.desc"]).toContain(
      "non-overlapping changes",
    );
    expect(en["settings.automaticHandling.mergeNonOverlappingText.desc"]).toContain(
      "leave them for manual handling",
    );
  });
});
