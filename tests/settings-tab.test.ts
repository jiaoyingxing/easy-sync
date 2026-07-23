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

  it("places sync exclusion and automatic handling between sync scope and auto-sync", () => {
    const source = readFileSync("src/ui/settings-tab.ts", "utf8");
    const syncScopeStart = source.indexOf('.setName(t("settings.syncScope.name"))');
    const exclusionStart = source.indexOf('.setName(t("settings.syncExclusion.name"))');
    const handlingStart = source.indexOf('.setName(t("settings.automaticHandling.name"))');
    const autoSyncStart = source.indexOf('.setName(t("settings.autoSync.name"))');
    const scopeAction = source.indexOf(".addButton", handlingStart);
    const autoSyncToggle = source.indexOf(".addToggle", autoSyncStart);

    expect(syncScopeStart).toBeGreaterThanOrEqual(0);
    expect(exclusionStart).toBeGreaterThan(syncScopeStart);
    expect(handlingStart).toBeGreaterThan(exclusionStart);
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

  it("uses a native folder picker and native settings for device-local exclusions", () => {
    const source = readFileSync("src/ui/sync-exclusion-modal.ts", "utf8");
    const settingsSource = readFileSync("src/ui/settings-tab.ts", "utf8");

    expect(source).toContain("extends FuzzySuggestModal<TFolder>");
    expect(source).toContain("getAllLoadedFiles");
    expect(source).toContain("instanceof TFolder");
    expect(source).toContain("updateExcludedFolders");
    expect(source).toContain("new Setting(");
    expect(source).toMatch(
      /text: t\("settings\.syncExclusion\.intro"\),\s*cls: "setting-item-description"/,
    );
    expect(source).not.toContain("TextComponent");
    expect(source).not.toContain("textarea");
    expect(source).not.toContain("startManualSync");
    expect(source).toContain("new ExtraButtonComponent(chipEl)");
    expect(source).toContain('.setIcon("x")');
    expect(settingsSource).toContain("renderExcludedFolderChips");
    expect(settingsSource).toContain("setting.descEl.createDiv()");
    expect(settingsSource).toContain("updateExcludedFoldersFromUi");
  });

  it("keeps long settings modals within the viewport with one scroll surface", () => {
    const configSource = readFileSync("src/ui/config-sync-modal.ts", "utf8");
    const exclusionSource = readFileSync("src/ui/sync-exclusion-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");
    const modalBlock = styles.match(/\.easy-sync-settings-modal\s*\{([^}]*)\}/)?.[1] ?? "";
    const contentBlock = styles.match(
      /\.easy-sync-settings-modal \.modal-content\s*\{([^}]*)\}/,
    )?.[1] ?? "";

    expect(configSource).toContain('modalEl.addClass("easy-sync-settings-modal")');
    expect(exclusionSource).toContain('modalEl.addClass("easy-sync-settings-modal")');
    expect(modalBlock).toContain("max-height: 80vh");
    expect(modalBlock).toContain("overflow: hidden");
    expect(contentBlock).toContain("overflow-y: auto");
    expect(contentBlock).toContain("min-height: 0");
  });

  it("routes existing config toggles through the same sync-path transaction", () => {
    const source = readFileSync("src/ui/config-sync-modal.ts", "utf8");

    expect(source).toContain("updateSyncPathSettings");
    expect(source).not.toContain("saveSyncSettings");
    expect(source).not.toContain("applyPluginFilesSetting");
  });

  it("keeps sync exclusion copy device-local and non-destructive in both locales", () => {
    expect(zhCN["settings.syncScope.name"]).toBe("同步范围");
    expect(zhCN["settings.syncScope.desc"]).toBe(
      "选择要与仓库文件一起同步的 Obsidian 配置、主题和插件文件。",
    );
    expect(en["settings.syncScope.name"]).toBe("Sync scope");
    expect(zhCN["settings.syncExclusion.name"]).toBe("同步排除");
    expect(zhCN["settings.syncExclusion.desc"]).toBe(
      "选择此设备不参与同步的文件夹。",
    );
    expect(zhCN["settings.syncExclusion.intro"]).toBe(
      "只影响此设备。所选文件夹及其内容不会上传或下载，现有文件不会因此被删除。",
    );
    expect(zhCN["settings.syncExclusion.folders.name"]).toBe("不同步的文件夹");
    expect(en["settings.syncExclusion.desc"]).toContain("this device");
    expect(en["settings.syncExclusion.intro"]).toContain("will not be deleted");
  });

  it("keeps about guidance actionable, safety-specific, and equivalent across locales", () => {
    expect(zhCN["settings.about.author.desc"]).toBe(
      "焦应行（Jiao Yingxing）。使用中遇到问题，可在 GitHub 提交 Issue，或通过小红书私信联系作者。",
    );
    expect(zhCN["settings.about.usage.name"]).toBe("使用建议");
    expect(zhCN["settings.about.usage.desc"]).toBe(
      "请勿让 OneDrive 客户端、iCloud、Dropbox、Syncthing 等其他同步工具同时管理同一个本地仓库。首次同步或文件较多时可能需要更长时间，可在侧栏查看进度。",
    );
    expect(zhCN["settings.about.disclaimer.name"]).toBe("数据安全");
    expect(zhCN["settings.about.disclaimer.desc"]).toBe(
      "同步过程中，EasySync 可能上传、下载或删除本地及 OneDrive 中的文件。重要内容请保留独立备份；同步不能替代备份。",
    );

    expect(en["settings.about.author.desc"]).toBe(
      "Jiao Yingxing. If you run into a problem, open an issue on GitHub or contact the author on Xiaohongshu.",
    );
    expect(en["settings.about.usage.name"]).toBe("Usage tips");
    expect(en["settings.about.usage.desc"]).toContain("another sync tool");
    expect(en["settings.about.usage.desc"]).toContain("progress is available in the sidebar");
    expect(en["settings.about.disclaimer.name"]).toBe("Data safety");
    expect(en["settings.about.disclaimer.desc"]).toContain("upload, download, or delete");
    expect(en["settings.about.disclaimer.desc"]).toContain("sync is not a backup");
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
