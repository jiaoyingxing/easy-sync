import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ConfigSyncModal } from "../src/ui/config-sync-modal";
import { SyncPlanAlertModal } from "../src/ui/confirm-modal";
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

  it("keeps account actions unheaded and separates range from automatic settings", () => {
    const source = readFileSync("src/ui/settings-tab.ts", "utf8");
    const displayStart = source.indexOf("  display(): void {");
    const refreshStart = source.indexOf("  refreshAuthState(): void {", displayStart);
    const displaySource = source.slice(displayStart, refreshStart);
    const accountSectionStart = source.indexOf("  private renderAccountSection(");
    const rangeSectionStart = source.indexOf("  private renderRangeSection(");
    const automaticSectionStart = source.indexOf("  private renderAutomaticSection(");
    const aboutSectionStart = source.indexOf("  private renderAboutSection(");
    const accountSection = source.slice(accountSectionStart, rangeSectionStart);
    const rangeSection = source.slice(rangeSectionStart, automaticSectionStart);
    const automaticSection = source.slice(automaticSectionStart, aboutSectionStart);
    const enabledTriggerSettings = automaticSection.slice(
      automaticSection.indexOf("if (this.plugin.syncInterval > 0)"),
    );

    expect(displaySource.indexOf("this.renderAccountSection(t)")).toBeLessThan(
      displaySource.indexOf("this.renderRangeSection(t)"),
    );
    expect(displaySource.indexOf("this.renderRangeSection(t)")).toBeLessThan(
      displaySource.indexOf("this.renderAutomaticSection(t)"),
    );
    expect(accountSection).toContain("new SettingGroup(this.accountSectionEl)");
    expect(accountSection).not.toContain(".setHeading(");
    expect(accountSection).toContain('.setName(t("settings.firstSync.name"))');
    expect(accountSection).not.toContain('t("settings.firstSync.desc")');
    expect(rangeSection).toContain(".setHeading(");
    expect(rangeSection).toContain('t("settings.group.scope")');
    expect(rangeSection).toContain('.setName(t("settings.syncScope.name"))');
    expect(rangeSection).toContain('.setName(t("settings.syncExclusion.name"))');
    expect(rangeSection).toContain('.setName(t("settings.maxFileSize.name"))');
    expect(rangeSection).not.toContain('t("settings.firstSync.name")');
    expect(rangeSection).not.toContain('t("settings.automaticHandling.name")');
    expect(rangeSection).not.toContain('t("settings.autoSync.name")');
    expect(rangeSection).not.toContain('t("settings.syncInterval.name")');

    expect(automaticSection).toContain('t("settings.group.automatic")');
    expect(automaticSection).toContain('setName(t("settings.automaticHandling.name"))');
    expect(automaticSection).toContain('setName(t("settings.autoSync.name"))');
    expect(automaticSection).toContain('setName(t("settings.syncInterval.name"))');
    expect(automaticSection).toContain(
      'setName(t("settings.autoSyncChangeDelay.name"))',
    );
    expect(automaticSection).toContain(".setLimits(0, 10, 1)");
    expect(automaticSection).toContain(
      "this.plugin.setAutoSyncChangeDelaySeconds(value)",
    );
    expect(enabledTriggerSettings).toContain(
      'setName(t("settings.syncInterval.name"))',
    );
    expect(enabledTriggerSettings).toContain(
      'setName(t("settings.autoSyncChangeDelay.name"))',
    );
    expect(automaticSection).not.toContain('t("settings.maxFileSize.name")');
    expect(automaticSection).toContain(
      'setButtonText(t("settings.automaticHandling.button"))',
    );
    expect(automaticSection).toContain('t("settings.automaticHandling.open")');
    expect(automaticSection).toContain('setAttribute(\n            "aria-label"');
    expect(automaticSection).not.toContain(".addExtraButton");
    expect(automaticSection).not.toContain('setName(t("settings.autoMerge.name"))');
    expect(zhCN["settings.group.scope"]).toBe("范围");
    expect(en["settings.group.scope"]).toBe("Scope");
    expect(zhCN["settings.group.automatic"]).toBe("自动");
    expect(en["settings.group.automatic"]).toBe("Automatic");
    expect(zhCN["settings.syncInterval.name"]).toBe("定时同步");
    expect(zhCN["settings.syncInterval.desc"]).toBe(
      "每 {minutes} 分钟同步一次。",
    );
    expect(zhCN["settings.autoSyncChangeDelay.name"]).toBe("修改后触发同步");
    expect(zhCN["settings.autoSyncChangeDelay.desc"]).toBe(
      "检测到本地变化后等待 {seconds} 秒；期间有新变化会重新计时。",
    );
    expect(zhCN["settings.autoSyncChangeDelay.disabledDesc"]).toBe(
      "已关闭；本地变化不会自动触发同步。",
    );
    expect(en["settings.syncInterval.name"]).toBe("Scheduled sync");
    expect(en["settings.autoSyncChangeDelay.name"]).toBe("Sync after changes");
    expect(en["settings.autoSyncChangeDelay.disabledDesc"]).toBe(
      "Off. Local changes will not trigger sync automatically.",
    );
  });

  it("uses a native folder picker and native settings for device-local exclusions", () => {
    const source = readFileSync("src/ui/sync-exclusion-modal.ts", "utf8");
    const settingsSource = readFileSync("src/ui/settings-tab.ts", "utf8");

    expect(source).toContain(
      "extends FuzzySuggestModal<SyncExclusionFolderCandidate>",
    );
    expect(source).toContain("getAllLoadedFiles");
    expect(source).toContain("instanceof TFolder");
    expect(source).toContain("buildSyncExclusionFolderCandidates");
    expect(source).toContain("createSyncExclusionFolderSnapshot");
    expect(source).toContain("rebuildPlanReview");
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

  it("mirrors the official hotkey chip geometry without depending on internal host classes", () => {
    const source = readFileSync("src/ui/sync-exclusion-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");
    const chipBlock = styles.match(
      /\.easy-sync-exclusion-chip\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    const removeBlock = styles.match(
      /\.easy-sync-exclusion-chip-remove\.extra-setting-button\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    const removeIconBlock = styles.match(
      /\.easy-sync-exclusion-chip-remove \.svg-icon\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    const labelBlock = styles.match(
      /\.easy-sync-exclusion-chip-label\s*\{([^}]*)\}/,
    )?.[1] ?? "";

    expect(chipBlock).toContain("display: flex");
    expect(chipBlock).toContain(
      "font-family: -apple-system, BlinkMacSystemFont, var(--font-monospace)",
    );
    expect(chipBlock).toContain("font-size: var(--font-ui-small)");
    expect(chipBlock).toContain("gap: var(--size-4-1)");
    expect(chipBlock).toContain("padding: 2px 4px 2px 8px");
    expect(chipBlock).toContain("color: var(--text-normal)");
    expect(removeBlock).toContain("width: 16px");
    expect(removeBlock).toContain("height: 16px");
    expect(removeBlock).toContain("padding: 0");
    expect(removeBlock).toContain("border-radius: 50%");
    expect(removeIconBlock).toContain("width: 16px");
    expect(removeIconBlock).toContain("height: 16px");
    expect(removeIconBlock).toContain("stroke-width: 2px");
    expect(removeIconBlock).toContain("opacity: 0.6");
    expect(labelBlock).toContain("overflow-wrap: anywhere");
    expect(source).not.toMatch(/setting-command-hotkeys|setting-hotkey-icon/);
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

  it("renders community plugin scope as native outer switches with always-available management", () => {
    const source = readFileSync("src/ui/config-sync-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");

    expect(source).toContain("renderCommunityPluginScopeSetting(");
    expect(source).toContain("updateAllCommunityPluginSelections(");
    expect(source).toContain("selectionChipEl");
    expect(source).toContain(
      'setting.settingEl.addClass("easy-sync-community-plugin-scope-setting")',
    );
    expect(source).toMatch(
      /setting\.nameEl\.createSpan\(\s*"easy-sync-plugin-selection-chip"/,
    );
    expect(source).toContain("appendExperimentalPluginDataChip(");
    expect(source).toContain("this.titleEl");
    expect(source).toContain("settings.communityPlugins.experimental");
    expect(source).toContain("busyCommunityPluginScopeRows");
    expect(source).toContain("pendingCommunityPluginScopeValues");
    expect(source).toContain("const scopeDisabled = !this.getCommunityPluginScopeEnabled(column)");
    expect(source).toContain(".setDisabled(busy || scopeDisabled)");
    expect(source).toContain(
      "!scopeEnabled",
    );
    expect(source).toContain("enabled && !busy");
    expect(source).not.toContain("enabledCount === items.length");
    expect(source).toContain('chipEl.removeClass("is-hidden")');
    expect(source).not.toContain(
      'controls.manageButton.buttonEl.toggleClass("is-hidden", !enabled)',
    );
    expect(source).toContain('.setIcon("settings")');
    expect(source).toContain("setTooltip(t(");
    expect(source).toContain('"aria-label"');
    expect(source).toContain("settings.communityPlugins.selectionSummary");
    expect(styles).toContain(
      ".easy-sync-community-plugin-scope-setting .setting-item-name",
    );
    expect(styles).toContain(".easy-sync-plugin-selection-chip");
    expect(styles).toMatch(
      /\.easy-sync-plugin-selection-chip\.is-experimental\s*\{[^}]*color:\s*var\(--text-error\)/s,
    );
    expect(styles).toMatch(
      /\.easy-sync-plugin-selection-chip\.is-hidden\s*\{[^}]*display:\s*none/s,
    );
    const selectionChipStyle = styles.match(
      /\.easy-sync-plugin-selection-chip\s*\{(?<body>[^}]*)\}/,
    )?.groups?.body ?? "";
    expect(selectionChipStyle).toContain("max-width: 100%");
    expect(selectionChipStyle).not.toContain("margin-inline-start");
    expect(source).toContain(
      '"notice.communityPlugins.enableFilesFirst"',
    );
    expect(styles).not.toContain("easy-sync-plugin-manage-button");
    expect(zhCN["notice.communityPlugins.enableFilesFirst"]).toBe(
      "请先开启“社区插件”。",
    );
    expect(en["notice.communityPlugins.enableFilesFirst"]).toBe(
      "Turn on Community plugins first.",
    );
  });

  it("uses historical data evidence when the outer plugin-data switch rejoins scope", async () => {
    const confirmExperimentalPluginData = vi.fn().mockResolvedValue(true);
    const applyOuterDataSwitch = async (historicalData: boolean) => {
      const updateSyncPathSettings = vi.fn().mockResolvedValue(undefined);
      const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
      Object.assign(modal as object, {
        plugin: {
          app: {},
          i18n: { t: (key: string) => key },
          syncCommunityPlugins: true,
          syncPluginData: false,
          communityPluginSyncPolicy: {
            version: 1,
            files: { mode: "all", pluginIds: [] },
            data: { mode: "all", pluginIds: [] },
          },
          isCommunityPluginFilesParticipationEnabled: vi.fn()
            .mockReturnValue(true),
          getCommunityPluginInventory: vi.fn().mockResolvedValue([{
            id: "calendar",
            name: "Calendar",
            version: null,
            local: false,
            remote: false,
            dataLocally: false,
            dataRemotely: false,
            desktopOnly: false,
            manifestIssue: false,
            ...(historicalData ? { dataHistoricallyPresent: true } : {}),
          }]),
          updateSyncPathSettings,
        },
        scopeInventory: [],
        scopeInventoryLoaded: false,
        pendingCommunityPluginScopeValues: new Map(),
        busyCommunityPluginScopeRows: new Set(),
        confirmExperimentalPluginData,
        refreshCommunityPluginScopeControls: vi.fn(),
      });

      await (modal as unknown as {
        updateCommunityPluginScopeSetting(
          column: "files" | "data",
          value: boolean,
        ): Promise<void>;
      }).updateCommunityPluginScopeSetting("data", true);

      expect(updateSyncPathSettings).toHaveBeenCalledOnce();
      return updateSyncPathSettings.mock.calls[0]?.[0];
    };

    await expect(applyOuterDataSwitch(true)).resolves.toEqual({
      syncCommunityPlugins: true,
      syncPluginData: true,
      communityPluginSyncPolicy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: ["calendar"],
        },
      },
    });
    await expect(applyOuterDataSwitch(false)).resolves.toEqual({
      syncCommunityPlugins: true,
      syncPluginData: true,
      communityPluginSyncPolicy: {
        version: 1,
        files: { mode: "all", pluginIds: [] },
        data: { mode: "all", pluginIds: [] },
      },
    });
    expect(confirmExperimentalPluginData).toHaveBeenCalledTimes(2);
  });

  it("keeps the outer plugin-data scope disabled when experimental confirmation is cancelled", async () => {
    const confirmExperimentalPluginData = vi.fn().mockResolvedValue(false);
    const updateSyncPathSettings = vi.fn().mockResolvedValue(undefined);
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    const pendingCommunityPluginScopeValues = new Map();
    const busyCommunityPluginScopeRows = new Set();
    Object.assign(modal as object, {
      plugin: {
        app: {},
        i18n: { t: (key: string) => key },
        syncCommunityPlugins: true,
        syncPluginData: false,
        communityPluginSyncPolicy: {
          version: 1,
          files: { mode: "all", pluginIds: [] },
          data: { mode: "all", pluginIds: [] },
        },
        isCommunityPluginFilesParticipationEnabled: vi.fn()
          .mockReturnValue(true),
        getCommunityPluginInventory: vi.fn().mockResolvedValue([{
          id: "calendar",
          name: "Calendar",
          version: null,
          local: true,
          remote: false,
          dataLocally: true,
          dataRemotely: false,
          desktopOnly: false,
          manifestIssue: false,
        }]),
        updateSyncPathSettings,
      },
      scopeInventory: [],
      scopeInventoryLoaded: false,
      pendingCommunityPluginScopeValues,
      busyCommunityPluginScopeRows,
      confirmExperimentalPluginData,
      refreshCommunityPluginScopeControls: vi.fn(),
    });

    await (modal as unknown as {
      updateCommunityPluginScopeSetting(
        column: "files" | "data",
        value: boolean,
      ): Promise<void>;
    }).updateCommunityPluginScopeSetting("data", true);

    expect(confirmExperimentalPluginData).toHaveBeenCalledOnce();
    expect(updateSyncPathSettings).not.toHaveBeenCalled();
    expect(pendingCommunityPluginScopeValues.size).toBe(0);
    expect(busyCommunityPluginScopeRows.size).toBe(0);
  });

  it("routes every plugin-data row enable through the experimental confirmation gate", () => {
    const source = readFileSync("src/ui/config-sync-modal.ts", "utf8");

    expect(source).toContain('if (column === "data" && enabled)');
    expect(source).toContain(
      "void this.confirmPluginDataSelection(item, restricted);",
    );
    expect(source).not.toContain("confirmRestrictedDataSelection");
    expect(source).toContain("settings.communityPlugins.data.experimentalItemMessage");
    expect(source).toContain("settings.communityPlugins.data.experimentalItemWithFilesMessage");
    expect(source).toContain("danger: true");
  });

  it("ignores a host repaint callback when the outer scope already matches committed state", async () => {
    const updateSyncPathSettings = vi.fn().mockResolvedValue(undefined);
    const refreshCommunityPluginScopeControls = vi.fn();
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: {
        syncCommunityPlugins: true,
        syncPluginData: false,
        communityPluginSyncPolicy: {
          version: 1,
          files: {
            mode: "selected",
            pluginIds: ["knomo", "realtime-transcription"],
          },
          data: { mode: "none", pluginIds: [] },
        },
        getCommunityPluginInventory: vi.fn(),
        updateSyncPathSettings,
      },
      scopeInventory: [],
      scopeInventoryLoaded: true,
      pendingCommunityPluginScopeValues: new Map(),
      busyCommunityPluginScopeRows: new Set(),
      refreshCommunityPluginScopeControls,
    });

    await (modal as unknown as {
      updateCommunityPluginScopeSetting(
        column: "files" | "data",
        value: boolean,
      ): Promise<void>;
    }).updateCommunityPluginScopeSetting("files", true);

    expect(updateSyncPathSettings).not.toHaveBeenCalled();
    expect(refreshCommunityPluginScopeControls).not.toHaveBeenCalled();
  });

  it("uses flat, immediate-save community plugin child modals", () => {
    const source = readFileSync("src/ui/config-sync-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");

    expect(source.match(/extends Modal/g)).toHaveLength(1);
    expect(source).toContain('"community-plugin-files"');
    expect(source).toContain('"community-plugin-data"');
    expect(source).toContain("openCommunityPluginManagerModal");
    expect(source).toContain("new ConfigSyncModal(");
    expect(source).not.toContain(".addDropdown");
    expect(source).not.toContain("requestLeave");
    expect(source).not.toContain("hasUnsavedPolicy");
    expect(source).not.toContain("saveCommunityPluginPolicy");
    expect(source).toContain("settingsUpdateQueue");
    expect(source).toContain("this.settingsUpdateQueue.whenIdle()");
    expect(source).toContain("pendingPluginValues");
    expect(source).toContain("updateCommunityPluginFilesSelection(");
    expect(source).toContain("updateAllCommunityPluginSelections(");
    expect(source).toContain("enableCommunityPluginDataWithFiles(");
    expect(source).toContain("new ConfirmModal(");
    expect(source).not.toContain("getCommunityPluginEnablementDecisionSnapshot");
    expect(source).not.toContain("resolveCommunityPluginEnablementDecisions");
    expect(source).toContain("inventoryLoadFailed");
    expect(source).toContain('t("notice.communityPlugins.loadFailed")');
    expect(source).toContain("isPluginEffectivelyEnabled(");
    expect(source).toContain("toggle.toggleEl.setAttribute(");
    expect(source).not.toContain(
      '"notice.communityPlugins.saved"',
    );
    expect(source).not.toContain("easy-sync-plugin-manager-summary");
    expect(source).not.toContain("easy-sync-plugin-manager-bulk-actions");
    expect(source).toContain(
      "this.remoteInventoryAvailable && item.remote && !item.local",
    );
    expect(styles).toMatch(
      /\.easy-sync-plugin-list-scroll\s*\{[^}]*overflow-y: auto/s,
    );
    expect(styles.match(/\.easy-sync-plugin-list-scroll\s*\{([^}]*)\}/s)?.[1] ?? "")
      .not.toMatch(/border|border-radius/);
    expect(styles).not.toContain(".easy-sync-plugin-manager-footer");
    expect(styles).not.toContain(".easy-sync-plugin-discard-guard");
    expect(source).not.toContain("CommunityPluginLegacyMigration");
    expect(source).not.toContain("communityPlugins.migration");
  });

  it("renders actionable participation phases from the unified files read model", () => {
    const source = readFileSync("src/ui/config-sync-modal.ts", "utf8");
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: { i18n: { t: (key: string) => key } },
      remoteInventoryAvailable: true,
    });
    const describe = (
      reason: string,
      desktopOnly = false,
      overrides: Record<string, unknown> = {},
    ) =>
      (modal as unknown as {
        describeInventoryItem(
          item: Record<string, unknown>,
          column: "files",
        ): string | null;
      }).describeInventoryItem({
        id: "calendar",
        name: "Calendar",
        local: false,
        remote: true,
        dataLocally: false,
        dataRemotely: false,
        desktopOnly,
        manifestIssue: false,
        participationPhase: "blocked",
        participationBlockedReason: reason,
        ...overrides,
      }, "files");

    expect(source).toContain("item.participationPhase");
    expect(source).toContain(
      '"settings.communityPlugins.status.joinRequested"',
    );
    expect(source).toContain(
      '"settings.communityPlugins.status.restoreBlocked"',
    );
    expect(zhCN["settings.communityPlugins.status.joinRequested"])
      .toBe("等待加入同步");
    expect(zhCN["settings.communityPlugins.status.restoreBlocked"])
      .toBe("恢复受阻");
    expect(en["settings.communityPlugins.status.joinRequested"])
      .toBe("Waiting to join sync");
    expect(en["settings.communityPlugins.status.restoreBlocked"])
      .toBe("Restore blocked");
    expect(zhCN["settings.communityPlugins.status.restoreIncompatible"])
      .toBe("与当前设备或 Obsidian 版本不兼容");
    expect(en["settings.communityPlugins.status.restoreIncompatible"])
      .toBe("Not compatible with this device or Obsidian version");
    expect(zhCN["settings.communityPlugins.status.restoreTargetChanged"])
      .toBe("远端插件已变化");
    expect(en["settings.communityPlugins.status.restoreTargetChanged"])
      .toBe("Remote plugin changed");
    expect(zhCN["settings.communityPlugins.status.restoreScopeChanged"])
      .toBe("同步位置已变化");
    expect(en["settings.communityPlugins.status.restoreScopeChanged"])
      .toBe("Sync location changed");
    expect(zhCN["settings.communityPlugins.status.localBundleIncomplete"])
      .toBe("插件文件不完整");
    expect(en["settings.communityPlugins.status.localBundleIncomplete"])
      .toBe("Plugin files are incomplete");
    expect(zhCN["settings.communityPlugins.status.remoteCatalogStale"])
      .toBe("远端状态待重新确认");
    expect(en["settings.communityPlugins.status.remoteCatalogStale"])
      .toBe("Remote status needs to be checked again");
    expect(zhCN["notice.communityPlugins.remoteCatalogFailed"])
      .toBe("无法确认远端插件列表，请稍后重新打开。");
    expect(en["notice.communityPlugins.remoteCatalogFailed"])
      .toBe("Could not verify the remote plugin list. Reopen this page to try again.");
    expect(source).toContain("item.participationBlockedReason");
    expect(describe("manifest-incompatible", true)).toBe(
      "settings.communityPlugins.status.restoreIncompatible",
    );
    expect(describe("remote-bundle-changed")).toBe(
      "settings.communityPlugins.status.restoreTargetChanged",
    );
    expect(describe("scope-changed")).toBe(
      "settings.communityPlugins.status.restoreScopeChanged",
    );
    expect(describe("local-bundle-incomplete", false, {
      local: true,
      remote: false,
      manifestIssue: true,
    })).toBe("settings.communityPlugins.status.localBundleIncomplete");

    const describeGuidance = (modal as unknown as {
      describeInventoryGuidance(
        items: Array<Record<string, unknown>>,
        column: "files" | "data",
      ): string[];
    }).describeInventoryGuidance.bind(modal);
    const guidanceItems = [
      {
        participationPhase: "blocked",
        participationBlockedReason: "local-bundle-incomplete",
        manifestIssue: true,
      },
      {
        participationPhase: "blocked",
        participationBlockedReason: "remote-bundle-changed",
        manifestIssue: false,
      },
      {
        participationPhase: "blocked",
        participationBlockedReason: "temporary-failure",
        manifestIssue: false,
      },
    ];
    expect(describeGuidance(guidanceItems, "files")).toEqual([
      "settings.communityPlugins.guidance.reviewIncomplete",
      "settings.communityPlugins.guidance.reconfirm",
      "settings.communityPlugins.guidance.retry",
    ]);
    expect(describeGuidance(guidanceItems, "data")).toEqual([]);
    expect(describeGuidance([{
      participationPhase: "blocked",
      participationBlockedReason: "manifest-incompatible",
      manifestIssue: true,
    }], "files")).toEqual([]);
    expect(source.indexOf("describeInventoryGuidance(visibleItems, column)"))
      .toBeLessThan(source.indexOf("this.renderPluginRow(item, column)"));
    expect(source).toContain("easy-sync-plugin-list-guidance");
    expect(zhCN["settings.communityPlugins.guidance.reviewIncomplete"])
      .toBe("插件文件不完整时，将在下次同步中核对本机和云端内容。");
    expect(zhCN["settings.communityPlugins.guidance.reinstall"])
      .toBe("本机插件清单无法读取时，请重新安装对应插件。");
    expect(zhCN["settings.communityPlugins.guidance.reconfirm"])
      .toBe("远端插件或同步位置变化时，将在下次同步时重新核对。");
    expect(zhCN["settings.communityPlugins.guidance.retry"])
      .toBe("恢复受阻时，请稍后重新同步。");
  });

  it("refreshes the range-independent remote catalog only when the plugin manager opens", () => {
    const source = readFileSync("src/ui/config-sync-modal.ts", "utf8");

    expect(source).toContain("refreshCommunityPluginRemoteCatalog");
    expect(source.indexOf("refreshCommunityPluginRemoteCatalog"))
      .toBeGreaterThan(source.indexOf("openCommunityPluginManager("));
  });

  it("subscribes an open scope modal to community inventory revisions and unsubscribes on close", () => {
    let onRevision: ((revision: number) => void) | undefined;
    const unsubscribe = vi.fn();
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    const handleRevision = vi.fn();
    Object.assign(modal as object, {
      plugin: {
        i18n: { t: (key: string) => key },
        onCommunityPluginInventoryRevision: vi.fn(
          (listener: (revision: number) => void) => {
            onRevision = listener;
            return unsubscribe;
          },
        ),
      },
      initialView: "scope",
      destroyed: true,
      loadGeneration: 0,
      modalEl: { addClass: vi.fn() },
      contentEl: { empty: vi.fn() },
      settingsUpdateQueue: { whenIdle: vi.fn() },
      renderScope: vi.fn(),
      handleCommunityPluginInventoryRevision: handleRevision,
    });

    modal.onOpen();
    expect(onRevision).toBeTypeOf("function");
    onRevision?.(4);
    expect(handleRevision).toHaveBeenCalledWith(4);

    modal.onClose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("freshly reloads and rerenders an open community plugin manager after a revision", async () => {
    const nextInventory = [{
      id: "calendar",
      name: "Calendar",
      version: null,
      local: false,
      remote: true,
      dataLocally: false,
      dataRemotely: false,
      desktopOnly: false,
      manifestIssue: false,
    }];
    const renderPluginListArea = vi.fn();
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: {
        getCommunityPluginInventory: vi.fn().mockResolvedValue(nextInventory),
        hasTrustedCommunityPluginRemoteInventory: vi.fn().mockResolvedValue(true),
        getCommunityPluginEnablementDecisionSnapshot: vi.fn().mockResolvedValue({
          revision: "",
          decisions: [],
        }),
      },
      view: "community-plugin-files",
      inventory: [],
      pendingDecisions: [],
      remoteInventoryAvailable: false,
      inventoryLoading: false,
      inventoryLoadFailed: false,
      destroyed: false,
      loadGeneration: 5,
      renderPluginListArea,
    });

    await (modal as unknown as {
      reloadCommunityPluginManager(
        column: "files" | "data",
        generation: number,
      ): Promise<void>;
    }).reloadCommunityPluginManager("files", 5);

    expect((modal as unknown as { inventory: unknown[] }).inventory)
      .toEqual(nextInventory);
    expect((modal as unknown as { remoteInventoryAvailable: boolean })
      .remoteInventoryAvailable).toBe(true);
    expect(renderPluginListArea).toHaveBeenCalled();
  });

  it("keeps a populated plugin list mounted while a background revision reload is pending", async () => {
    let releaseInventory!: (inventory: unknown[]) => void;
    const inventoryPromise = new Promise<unknown[]>((resolve) => {
      releaseInventory = resolve;
    });
    const renderPluginListArea = vi.fn();
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: {
        getCommunityPluginInventory: vi.fn(() => inventoryPromise),
        hasTrustedCommunityPluginRemoteInventory: vi.fn().mockResolvedValue(true),
        getCommunityPluginEnablementDecisionSnapshot: vi.fn().mockResolvedValue({
          revision: "",
          decisions: [],
        }),
      },
      view: "community-plugin-files",
      inventory: [{ id: "calendar" }],
      pendingDecisions: [],
      remoteInventoryAvailable: true,
      inventoryLoading: false,
      inventoryLoadFailed: false,
      destroyed: false,
      loadGeneration: 6,
      renderPluginListArea,
      focusPendingDecisionIfRequested: vi.fn(),
    });

    const reload = (modal as unknown as {
      reloadCommunityPluginManager(
        column: "files" | "data",
        generation: number,
      ): Promise<void>;
    }).reloadCommunityPluginManager("files", 6);

    await Promise.resolve();
    expect(renderPluginListArea).not.toHaveBeenCalled();

    releaseInventory([{ id: "calendar" }, { id: "dataview" }]);
    await reload;
    expect(renderPluginListArea).toHaveBeenCalledOnce();
  });

  it("does not clear a populated plugin list when a queued row update settles during background loading", async () => {
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const listScrollEl = {
      scrollTop: 480,
      empty: vi.fn(() => {
        listScrollEl.scrollTop = 0;
      }),
      createEl: vi.fn(),
    };
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: { i18n: { t: (key: string) => key } },
      view: "community-plugin-files",
      inventory: [{ id: "calendar" }],
      inventoryLoading: true,
      listScrollEl,
      destroyed: false,
      busyPluginRows: new Set<string>(),
      pendingPluginValues: new Map<string, boolean>(),
      settingsUpdateQueue: {
        enqueue: vi.fn(async (task: () => Promise<void>) => await task()),
      },
      showSyncPathSettingsError: vi.fn(),
    });

    (modal as unknown as {
      queueSelectionUpdate(
        rowKey: string,
        pendingValue: boolean,
        commit: () => Promise<void>,
      ): void;
    }).queueSelectionUpdate("files:calendar", true, () => commit);

    expect(listScrollEl.empty).not.toHaveBeenCalled();
    expect(listScrollEl.scrollTop).toBe(480);

    releaseCommit();
    await vi.waitFor(() => {
      expect((modal as unknown as { busyPluginRows: Set<string> })
        .busyPluginRows.size).toBe(0);
    });
    expect(listScrollEl.empty).not.toHaveBeenCalled();
    expect(listScrollEl.scrollTop).toBe(480);
  });

  it("coalesces a burst of inventory revisions into one in-flight load and one follow-up", async () => {
    let releaseFirst!: (inventory: unknown[]) => void;
    const firstInventory = new Promise<unknown[]>((resolve) => {
      releaseFirst = resolve;
    });
    const getCommunityPluginInventory = vi.fn()
      .mockImplementationOnce(() => firstInventory)
      .mockResolvedValue([]);
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: {
        getCommunityPluginInventory,
        hasTrustedCommunityPluginRemoteInventory: vi.fn().mockResolvedValue(true),
        getCommunityPluginEnablementDecisionSnapshot: vi.fn().mockResolvedValue({
          revision: "",
          decisions: [],
        }),
      },
      view: "community-plugin-files",
      inventory: [],
      pendingDecisions: [],
      remoteInventoryAvailable: false,
      inventoryLoading: false,
      inventoryLoadFailed: false,
      inventoryRevisionRefreshRunning: false,
      inventoryRevisionRefreshPending: false,
      destroyed: false,
      loadGeneration: 0,
      renderPluginListArea: vi.fn(),
      focusPendingDecisionIfRequested: vi.fn(),
    });
    const handleRevision = (modal as unknown as {
      handleCommunityPluginInventoryRevision: (revision: number) => void;
    }).handleCommunityPluginInventoryRevision.bind(modal);

    handleRevision(1);
    handleRevision(2);
    handleRevision(3);
    expect(getCommunityPluginInventory).toHaveBeenCalledOnce();

    releaseFirst([]);
    await vi.waitFor(() => {
      expect(getCommunityPluginInventory).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect((modal as unknown as {
        inventoryRevisionRefreshRunning: boolean;
      }).inventoryRevisionRefreshRunning).toBe(false);
    });
    expect(getCommunityPluginInventory).toHaveBeenCalledTimes(2);
  });

  it("falls back to the distinguishable plugin id when no trusted display name exists", () => {
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: {
        i18n: { t: (key: string) => key },
      },
    });

    const resolveDisplayName = (modal as unknown as {
      getCommunityPluginDisplayName(
        item: { id: string; name: string | null },
      ): string;
    }).getCommunityPluginDisplayName.bind(modal);

    expect(resolveDisplayName({ id: "calendar", name: "Calendar" }))
      .toBe("Calendar");
    expect(resolveDisplayName({ id: "calendar", name: null }))
      .toBe("calendar");
  });

  it("keeps the community plugin manager header compact and native", () => {
    const source = readFileSync("src/ui/config-sync-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");

    expect(source).toContain("new SearchComponent(this.contentEl)");
    expect(source).toContain(
      '.setPlaceholder(t("settings.communityPlugins.search"))',
    );
    expect(source).not.toContain(".addSearch((search) =>");
    expect(source).not.toContain("easy-sync-plugin-manager-intro");
    expect(source).not.toContain("settings.communityPlugins.files.intro");
    expect(source).not.toContain("settings.communityPlugins.data.intro");
    expect(source).not.toContain("remoteInventoryNoteEl");
    expect(source).not.toContain(
      '"settings.communityPlugins.remoteUnavailable"',
    );
    expect(source).not.toContain("easy-sync-plugin-search-row");
    expect(source).not.toContain("easy-sync-plugin-search-setting");
    expect(source).not.toContain('"easy-sync-plugin-meta"');
    expect(source).not.toContain("is-restricted");
    expect(source).not.toContain(
      '"settings.communityPlugins.status.dataFound"',
    );
    expect(source).not.toContain(
      '"settings.communityPlugins.status.pluginNotSelected"',
    );
    expect(styles).toContain(".easy-sync-plugin-search");
    expect(styles).toContain("margin-inline: var(--size-4-2)");
    expect(styles).toMatch(
      /body:not\(\.is-mobile\) \.easy-sync-plugin-search\s*\{[^}]*margin-block-start:\s*var\(--size-4-2\)/s,
    );
    expect(styles).not.toContain(".easy-sync-plugin-manager-intro");
    expect(styles).not.toContain(".easy-sync-plugin-search-setting");
    expect(styles).not.toContain(".easy-sync-plugin-remote-note");
    expect(styles).not.toContain(".easy-sync-plugin-meta");
    expect(styles).not.toContain(".easy-sync-plugin-row.is-restricted");
    const pluginNameStyle = styles.match(
      /\.easy-sync-plugin-name\s*\{(?<body>[^}]*)\}/,
    )?.groups?.body ?? "";
    expect(pluginNameStyle).toContain("font-weight: var(--font-normal)");
    expect(pluginNameStyle).not.toContain("font-weight: var(--font-semibold)");
  });

  it("uses the approved community plugin terms and concise descriptions", () => {
    expect(zhCN["settings.syncBookmarks.name"]).toBe("书签");
    expect(zhCN["settings.syncBookmarks.desc"]).toBe(
      "同步 Obsidian 书签列表（bookmarks.json）。",
    );
    const configSource = readFileSync("src/ui/config-sync-modal.ts", "utf8");
    expect(configSource.indexOf('key: "settings.syncHotkeys"')).toBeLessThan(
      configSource.indexOf('key: "settings.syncBookmarks"'),
    );
    expect(configSource.indexOf('key: "settings.syncBookmarks"')).toBeLessThan(
      configSource.indexOf('key: "settings.syncCorePlugins"'),
    );
    expect(zhCN["settings.syncCommunityPlugins.name"]).toBe("社区插件");
    expect(zhCN["settings.syncPluginData.name"]).toBe("社区插件数据");
    expect(zhCN["settings.syncCommunityPlugins.desc"]).toBe(
      "同步社区插件文件；启用状态保留在各设备。",
    );
    expect(zhCN["settings.syncPluginData.desc"]).toBe(
      "同步所选插件的设置数据。此功能尚未充分测试，可能替换其他设备上的插件设置；请先备份。",
    );
    expect(zhCN["settings.communityPlugins.experimental"]).toBe("实验性");
    expect(en["settings.communityPlugins.experimental"]).toBe("Experimental");
    expect(zhCN["settings.communityPlugins.data.experimentalConfirmTitle"]).toBe(
      "开启社区插件数据同步？",
    );
    expect(zhCN["settings.communityPlugins.data.experimentalConfirm"]).toBe(
      "了解风险并开启",
    );
    expect(zhCN["settings.communityPlugins.data.experimentalWarning"]).toBe(
      "请先备份各设备上的插件设置。",
    );
    expect(zhCN["settings.communityPlugins.manage.files"]).toBe(
      "管理社区插件",
    );
    expect(zhCN["settings.communityPlugins.manage.data"]).toBe(
      "管理社区插件数据",
    );
    expect(zhCN["settings.communityPlugins.selectionSummary"]).toBe(
      "同步：{enabled}/{total}",
    );
    expect(en["settings.communityPlugins.manage.files"]).toBe(
      "Manage community plugins",
    );
    expect(en["settings.communityPlugins.manage.data"]).toBe(
      "Manage community plugin data",
    );
    expect(en["settings.communityPlugins.selectionSummary"]).toBe(
      "Syncing: {enabled}/{total}",
    );
    expect(en["settings.communityPlugins.data.experimentalConfirm"]).toBe(
      "I understand the risk — turn it on",
    );
    expect(zhCN["settings.communityPlugins.status.localOnly"]).toBe(
      "插件仅本机有",
    );
    expect(zhCN["settings.communityPlugins.status.remoteOnly"]).toBe(
      "插件仅远端有",
    );
    expect(zhCN["settings.communityPlugins.status.unavailable"]).toBe(
      "未找到插件本体",
    );
    expect(zhCN["settings.communityPlugins.status.dataMissing"]).toBe(
      "未发现 data.json",
    );
    expect(zhCN["settings.communityPlugins.status.desktopOnly"]).toBe(
      "仅桌面可用",
    );
    expect(zhCN["settings.communityPlugins.status.manifestIssue"]).toBe(
      "插件文件不完整",
    );
    expect(en["settings.communityPlugins.status.localOnly"]).toBe(
      "Plugin files only on this device",
    );
    expect(en["settings.communityPlugins.status.remoteOnly"]).toBe(
      "Plugin files only in the cloud",
    );
    expect(en["settings.communityPlugins.status.unavailable"]).toBe(
      "Plugin files not found",
    );
    expect(en["settings.communityPlugins.status.dataMissing"]).toBe(
      "No data.json found",
    );
    expect(en["settings.communityPlugins.status.desktopOnly"]).toBe(
      "Only works on desktop",
    );
    expect(en["settings.communityPlugins.status.manifestIssue"]).toBe(
      "Plugin files are incomplete",
    );
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

  it("moves first-use guidance into the first plan alert and keeps About lightweight", () => {
    const settingsSource = readFileSync("src/ui/settings-tab.ts", "utf8");
    const mainSource = readFileSync("src/main.ts", "utf8");
    const alertSource = readFileSync("src/ui/confirm-modal.ts", "utf8");

    expect(zhCN["settings.about.author.desc"]).toBe(
      "焦应行（Jiao Yingxing）。使用中遇到问题，可在 GitHub 提交 Issue，或通过小红书私信联系作者。",
    );
    expect(zhCN["syncPlan.firstUseUsage"]).toBe(
      "请勿让 OneDrive 客户端、iCloud、Dropbox、Syncthing 等其他同步工具同时管理同一个本地仓库。首次同步或文件较多时可能需要更长时间，可在侧栏查看进度。",
    );
    expect(zhCN["syncPlan.firstUseSafety"]).toBe(
      "同步过程中，EasySync 可能上传、下载或删除本地及 OneDrive 中的文件。重要内容请保留独立备份；同步不能替代备份。",
    );

    expect(en["settings.about.author.desc"]).toBe(
      "Jiao Yingxing. If you run into a problem, open an issue on GitHub or contact the author on Xiaohongshu.",
    );
    expect(en["syncPlan.firstUseUsage"]).toContain("another sync tool");
    expect(en["syncPlan.firstUseUsage"]).toContain("progress is available in the sidebar");
    expect(en["syncPlan.firstUseSafety"]).toContain("upload, download, or delete");
    expect(en["syncPlan.firstUseSafety"]).toContain("sync is not a backup");

    expect(settingsSource).not.toContain("settings.about.usage");
    expect(settingsSource).not.toContain("settings.about.disclaimer");
    expect(mainSource).toContain('t("syncPlan.firstUseUsage")');
    expect(mainSource).toContain('t("syncPlan.firstUseSafety")');
    expect(alertSource).toContain("for (const message of this.messages)");
  });

  it("renders every first-use message in the existing plan alert", () => {
    const paragraphs: string[] = [];
    const onViewPlan = vi.fn();
    const close = vi.fn();
    let click: (() => void) | undefined;
    const modal = Object.create(SyncPlanAlertModal.prototype) as SyncPlanAlertModal;
    Object.assign(modal as object, {
      title: "同步计划就绪",
      messages: ["计划说明", "使用建议", "数据安全"],
      buttonLabel: "查看计划",
      onViewPlan,
      close,
      setTitle: vi.fn(),
      contentEl: {
        empty: vi.fn(),
        createEl: (_tag: string, options: { text: string }) => {
          paragraphs.push(options.text);
          return {};
        },
        createDiv: () => ({
          createEl: () => ({
            addEventListener: (_event: string, handler: () => void) => {
              click = handler;
            },
          }),
        }),
      },
    });

    modal.onOpen();
    expect(paragraphs).toEqual(["计划说明", "使用建议", "数据安全"]);
    click?.();
    expect(onViewPlan).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
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
