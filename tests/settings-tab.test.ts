import { describe, expect, it, vi } from "vitest";
import { ConfigSyncModal, isPluginRowHiddenByCloudCleanup } from "../src/ui/config-sync-modal";
import { SyncPlanAlertModal } from "../src/ui/confirm-modal";
import { ButtonComponent, Setting, createMockElement } from "./__mocks__/obsidian";
import { EasySyncSettingTab } from "../src/ui/settings-tab";
import { I18n } from "../src/i18n";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";
import type EasySyncPlugin from "../src/main";
import { functionBody, readSourceFile } from "./helpers/source-scope";

describe("settings tab", () => {
  it("opens the sync panel from the imperative account row", async () => {
    const openSyncPanelFromSettings = vi.fn().mockResolvedValue(undefined);
    const tab = new EasySyncSettingTab({
      app: {},
      register: vi.fn(),
      auth: {
        authState: { isLoggedIn: true, displayName: "tester" },
        isInitializing: false,
        isPending: false,
        deviceAttempt: null,
      },
      openSyncPanelFromSettings,
    } as unknown as EasySyncPlugin);
    (tab as unknown as { accountSectionEl: unknown }).accountSectionEl =
      createMockElement();

    let clickHandler: (() => void | Promise<void>) | null = null;
    const onClickSpy = vi
      .spyOn(ButtonComponent.prototype, "onClick")
      .mockImplementation(function (
        this: ButtonComponent,
        callback: () => void | Promise<void>,
      ) {
        clickHandler = callback;
        return this;
      });
    try {
      (tab as unknown as {
        renderAccountSection(t: (key: string) => string): void;
      }).renderAccountSection((key) => key);
      await clickHandler?.();
    } finally {
      onClickSpy.mockRestore();
    }

    expect(openSyncPanelFromSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the settings page a navigation entry, not a second sync workbench", () => {
    const source = readSourceFile("src/ui/settings-tab.ts");
    const accountSection = source.slice(
      source.indexOf("  private renderAccountSection("),
      source.indexOf("  private renderRangeSection("),
    );
    const declarativeAccount = source.slice(
      source.indexOf("export function buildAccountSettingDefinitions("),
      source.indexOf("export function buildSettingDefinitions("),
    );

    for (const block of [accountSection, declarativeAccount]) {
      expect(block).toContain('t("settings.syncPanel.name")');
      expect(block).toContain('.setButtonText(t("settings.syncPanel.button"))');
      expect(block).toContain("openSyncPanelFromSettings()");
      // 同步、计划确认与取消都归侧栏工作台；设置页不得再长出第二份动作
      // （2026-10-09 拍板，取代 2026-08-16 的设置页「立即同步」动作行）。
      expect(block).not.toContain("startManualSync");
      expect(block).not.toContain("startFirstSync");
      expect(block).not.toContain("executePlanReview");
      expect(block).not.toContain("cancelSync");
    }
    expect(source).not.toContain("buildSettingsSyncButtonState");
    expect(zhCN["settings.syncPanel.name"]).toBe("同步面板");
    expect(zhCN["settings.syncPanel.button"]).toBe("打开");
    expect(en["settings.syncPanel.name"]).toBe("Sync panel");
    expect(en["settings.syncPanel.button"]).toBe("Open");
  });

  it("keeps notification pop-ups progressive disclosure on both render paths", () => {
    const source = readSourceFile("src/ui/settings-tab.ts");
    const displaySectionStart = source.indexOf("  private renderDisplaySection(");
    const aboutSectionStart = source.indexOf("  private renderAboutSection(");
    const displaySection = source.slice(displaySectionStart, aboutSectionStart);

    // Imperative path: the hint element lives in the row desc and follows the
    // selected level without a full re-render.
    expect(displaySection).toContain(
      'const hintEl = setting.descEl.createDiv({',
    );
    expect(displaySection).toContain('cls: "easy-sync-notification-popups-hint"');
    expect(displaySection).toContain(
      't(`settings.notificationPopups.hint.${this.plugin.notificationPopups}`)',
    );
    expect(displaySection).toContain("renderHint();");

    // Declarative path mirrors the same hint wiring for Obsidian 1.13+；1.13+ 起
    // 通知行实现住在设置页行模块（2026-10-12 重构）。
    const declarative = readSourceFile("src/ui/settings-page-rows.ts");
    expect(declarative).toContain('"easy-sync-notification-popups-hint"');
    expect(declarative).toContain(
      't(`settings.notificationPopups.hint.${plugin.notificationPopups}`)',
    );
  });

  it("keeps tooltip and aria-label on the automatic-handling entry of the legacy path (C10-2)", () => {
    const source = readSourceFile("src/ui/settings-tab.ts");
    const sectionStart = source.indexOf("  private renderAutomaticSection(");
    const sectionEnd = source.indexOf("  private renderDisplaySection(");
    const section = source.slice(sectionStart, sectionEnd);

    // <1.13 旧路径的弹框入口按钮保留 tooltip + aria-label（C10-2 不丢）。
    expect(section).toContain('setTooltip(t("settings.automaticHandling.open"))');
    expect(section).toContain('"aria-label"');
    expect(section).toContain('t("settings.automaticHandling.open"),');

    // 1.13+ 声明式路径不再有弹框入口（页内直接是两条开关）：parity＝不存在，
    // 因此本轮不再要求声明式侧镜像 tooltip/aria-label（2026-10-12 重构）。
    const declarativeStart = source.indexOf("export function buildSettingDefinitions(");
    const declarative = source.slice(declarativeStart);
    expect(declarative).not.toContain("settings.automaticHandling.open");
    expect(declarative).toContain('applyAutomaticHandlingRow(setting, host, "autoDeleteLocalFiles")');
  });

  it("keeps account actions unheaded and separates range from automatic settings", () => {
    const source = readSourceFile("src/ui/settings-tab.ts");
    const autoSyncModalSource = readSourceFile("src/ui/auto-sync-modal.ts");
    const displayStart = source.indexOf("  display(): void {");
    const refreshStart = source.indexOf("  refreshAuthState(): void {", displayStart);
    const displaySource = source.slice(displayStart, refreshStart);
    const accountSection = functionBody(source, "private renderAccountSection(");
    const rangeSection = functionBody(source, "private renderRangeSection(");
    const automaticSection = functionBody(source, "private renderAutomaticSection(");

    expect(displaySource.indexOf("this.renderAccountSection(t)")).toBeLessThan(
      displaySource.indexOf("this.renderRangeSection(t)"),
    );
    expect(displaySource.indexOf("this.renderRangeSection(t)")).toBeLessThan(
      displaySource.indexOf("this.renderAutomaticSection(t)"),
    );
    expect(accountSection).toContain("new SettingGroup(this.accountSectionEl)");
    expect(accountSection).not.toContain(".setHeading(");
    expect(accountSection).toContain('.setName(t("settings.syncPanel.name"))');
    expect(accountSection).not.toContain('t("settings.syncPanel.desc")');
    expect(rangeSection).toContain(".setHeading(");
    expect(rangeSection).toContain('t("settings.group.scope")');
    expect(rangeSection).toContain('.setName(t("settings.syncScope.name"))');
    expect(rangeSection).toContain('.setName(t("settings.syncExclusion.name"))');
    expect(rangeSection).not.toContain('t("settings.maxFileSize.name")');
    expect(rangeSection).not.toContain(".setLimits(");
    expect(rangeSection).not.toContain('t("settings.syncPanel.name")');
    expect(rangeSection).not.toContain('t("settings.automaticHandling.name")');
    expect(rangeSection).not.toContain('t("settings.autoSync.name")');
    expect(rangeSection).not.toContain('t("settings.syncInterval.name")');

    expect(automaticSection).toContain('t("settings.group.automatic")');
    expect(automaticSection).toContain('setName(t("settings.automaticHandling.name"))');
    expect(automaticSection).toContain('setName(t("settings.autoSync.name"))');
    // Auto sync is a single row: toggle + configure (gear) button, sliders live in the modal.
    expect(automaticSection).toContain('.setIcon("settings")');
    expect(automaticSection).toContain('t("settings.autoSync.open")');
    expect(automaticSection).not.toContain('setName(t("settings.syncInterval.name"))');
    expect(automaticSection).not.toContain(
      'setName(t("settings.autoSyncChangeDelay.name"))',
    );
    expect(automaticSection).not.toContain(".setLimits(");
    expect(automaticSection).not.toContain("setAutoSyncChangeDelaySeconds");
    expect(automaticSection).not.toContain("describeAutoSyncChangeDelay");
    // The settings-page toggle reads the derived master state (either channel
    // enabled) and routes through the plugin's master switch.
    expect(automaticSection).toContain("isAutoSyncMasterEnabled()");
    expect(automaticSection).toContain("setAutoSyncMasterEnabled(value)");
    expect(autoSyncModalSource).toContain('setName(t("settings.syncInterval.name"))');
    expect(autoSyncModalSource).toContain(
      'setName(t("settings.autoSyncChangeDelay.name"))',
    );
    // Both sliders run 0–10 with the leftmost stop = off: scheduled sync
    // stores 0 or 1–10 minutes, the change-delay slider 0–10 seconds.
    // 收窄到弹框的 onOpen：这两个滑杆与重启都只在那里接线，文件级断言会被
    // 同文件别处的同名调用蒙过（同规则见《测试与检查规范》§3）。
    const autoSyncOnOpen = functionBody(autoSyncModalSource, "onOpen(): void");
    expect(autoSyncOnOpen).toContain(".setLimits(0, 10, 1)");
    expect(autoSyncModalSource).not.toContain("SYNC_INTERVAL_OFF_SLIDER_VALUE");
    expect(autoSyncModalSource).toContain(
      "this.plugin.setAutoSyncChangeDelaySeconds(value)",
    );
    expect(autoSyncOnOpen).toContain("restartAutoSync");
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
      "检测到本机变化后等待 {seconds} 秒；期间有新变化会重新计时。",
    );
    expect(zhCN["settings.autoSyncChangeDelay.disabledDesc"]).toBe(
      "已关闭；本机变化不会自动触发同步。",
    );
    expect(zhCN["settings.autoSyncOnStartup.name"]).toBe("启动后立即同步");
    expect(zhCN["settings.autoSyncOnStartup.desc"]).toBe(
      "打开 Obsidian 后立即触发一次同步。",
    );
    expect(en["settings.syncInterval.name"]).toBe("Scheduled sync");
    // "min" keeps the 1-minute stop grammatical in English ("every 1 min").
    expect(en["settings.syncInterval.desc"]).toBe(
      "Syncs once every {minutes} min.",
    );
    expect(en["settings.autoSyncChangeDelay.name"]).toBe("Sync after changes");
    expect(en["settings.autoSyncChangeDelay.disabledDesc"]).toBe(
      "Off. Local changes will not trigger sync automatically.",
    );
  });

  it("applies the tab container class at construction time for both render paths", () => {
    // Obsidian 1.13.0+ renders the tab declaratively and never calls
    // display(), so the class CSS scopes by must exist before any rendering.
    const tab = new EasySyncSettingTab({
      app: {},
      register: vi.fn(),
    } as unknown as EasySyncPlugin);
    expect(tab.containerEl.classList.contains("easy-sync-settings-tab")).toBe(
      true,
    );
  });

  it("keeps desktop settings action buttons on one shared minimum width", () => {
    // The min-width equals the natural width of a four-CJK-char label at
    // native button metrics, so two-char buttons align with wider ones. The
    // element selector covers both render paths (1.13+ declarative render
    // emits bare <button> without the .button class); the desktop guard and
    // the clickable-icon exclusion are part of the contract.
    const styles = readSourceFile("styles.css");
    const rule = styles.match(
      /body:not\(\.is-mobile\) \.easy-sync-settings-tab \.setting-item-control button:not\(\.clickable-icon\)\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(rule).toContain("min-width: calc(4em + var(--size-4-3) * 2)");
    // 1.13+ sub-pages are reparented into a host-owned `.setting-page`
    // container that drops the tab class, so the rule above misses them.
    // The active EasySync nav item scopes the same width to those pages.
    const subpageRule = styles.match(
      /body:not\(\.is-mobile\) \.vertical-tabs-container:has\(\.vertical-tab-nav-item\.is-active\[data-setting-id="easy-sync"\]\) \.setting-page \.setting-item-control button:not\(\.clickable-icon\)\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(subpageRule).toContain("min-width: calc(4em + var(--size-4-3) * 2)");
  });

  it("uses a native folder picker and native settings for device-local exclusions", () => {
    const source = readSourceFile("src/ui/sync-exclusion-modal.ts");
    const settingsSource = readSourceFile("src/ui/settings-tab.ts");
    // 收窄：这两条句子在各自目标文件里都出现多次（定义处／导入处／别的方法），
    // 文件级断言删掉真正那一处也照样绿。
    const pickerItems = functionBody(source, "getItems(): SyncExclusionFolderCandidate[]");
    const nativeSettings = functionBody(source, "private render(): void");
    const rangeSection = functionBody(settingsSource, "private renderRangeSection(");

    expect(source).toContain(
      "extends FuzzySuggestModal<SyncExclusionFolderCandidate>",
    );
    expect(source).toContain("getAllLoadedFiles");
    expect(source).toContain("instanceof TFolder");
    expect(pickerItems).toContain("buildSyncExclusionFolderCandidates");
    expect(source).toContain("createSyncExclusionFolderSnapshot");
    expect(source).toContain("rebuildPlanReview");
    expect(source).toContain("updateExcludedFolders");
    expect(nativeSettings).toContain("new Setting(");
    expect(source).toMatch(
      /text: t\("settings\.syncExclusion\.intro"\),\s*cls: "setting-item-description easy-sync-modal-intro"/,
    );
    // 大型文件排除的自定义值输入（2026-09-16 用户拍板引入，Resojot renderModelField
    // 同型常驻双控件）是本弹框唯一允许的文本控件，防止自由文本输入蔓延。
    expect(source.match(/\.addText\(/g)?.length).toBe(1);
    expect(source).not.toContain("textarea");
    expect(source).not.toContain("startManualSync");
    expect(source).toContain("new ExtraButtonComponent(chipEl)");
    expect(source).toContain('.setIcon("x")');
    expect(rangeSection).toContain("renderExcludedFolderChips");
    expect(rangeSection).toContain("setting.descEl.createDiv()");
    expect(rangeSection).toContain("updateExcludedFoldersFromUi");
  });
  it("mirrors the official hotkey chip geometry without depending on internal host classes", () => {
    const source = readSourceFile("src/ui/sync-exclusion-modal.ts");
    const styles = readSourceFile("styles.css");
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
    const configSource = readSourceFile("src/ui/config-sync-modal.ts");
    const exclusionSource = readSourceFile("src/ui/sync-exclusion-modal.ts");
    const styles = readSourceFile("styles.css");
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
    const source = readSourceFile("src/ui/config-sync-modal.ts");

    expect(source).toContain("updateSyncPathSettings");
    expect(source).not.toContain("saveSyncSettings");
    expect(source).not.toContain("applyPluginFilesSetting");
  });

  it("renders community plugin scope as native outer switches with always-available management", () => {
    const source = readSourceFile("src/ui/config-sync-modal.ts");
    const styles = readSourceFile("styles.css");
    // 收窄：下面这些句子在同一文件里多处出现（导入、接口成员、别的方法），
    // 各自绑到真正负责它的那个函数体上。
    const renderScope = functionBody(source, "private renderScope(): void");
    const scopeSetting = functionBody(
      source,
      "private renderCommunityPluginScopeSetting(",
    );
    const manager = functionBody(
      source,
      "private renderCommunityPluginManager(column: PluginColumn): void",
    );

    expect(renderScope).toContain("renderCommunityPluginScopeSetting(");
    expect(source).toContain("updateAllCommunityPluginSelections(");
    expect(scopeSetting).toContain("selectionChipEl");
    expect(source).toContain(
      'setting.settingEl.addClass("easy-sync-community-plugin-scope-setting")',
    );
    expect(source).toMatch(
      /setting\.nameEl\.createSpan\(\s*"easy-sync-plugin-selection-chip"/,
    );
    expect(scopeSetting).toContain("appendExperimentalPluginDataChip(");
    expect(manager).toContain("this.titleEl");
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

  it("mounts the settings-page community scope rows with the modal chip layout", () => {
    // 1.13+ 页面行与弹框同口径（settings-page-rows 模块头 S1 双轨）：
    // ① 行类触发 nameEl 的 flex+gap（styles.css），缺了 chip 会紧贴行名；
    // ② chip 挂点必须在最后一次 setName 之后——setName 会重写 nameEl 内容，
    //    先挂上去的 chip 会被冲掉（真机 1.13：同步 chip 消失、实验性 chip
    //    因创建在后而幸存）。
    const source = readSourceFile("src/ui/settings-page-rows.ts");
    const fnStart = source.indexOf("export function applyCommunityPluginScopeRow(");
    const fnEnd = source.indexOf("/** 不同步的文件夹行", fnStart);
    const fn = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(fn).toContain(
      'setting.setClass("easy-sync-community-plugin-scope-setting")',
    );
    const setNameIdx = fn.indexOf(".setName(");
    const experimentalIdx = fn.indexOf(
      '"easy-sync-plugin-selection-chip is-experimental"',
    );
    const chipIdx = fn.indexOf(
      'setting.nameEl.createSpan("easy-sync-plugin-selection-chip")',
    );
    expect(setNameIdx).toBeGreaterThan(-1);
    expect(experimentalIdx).toBeGreaterThan(setNameIdx);
    expect(chipIdx).toBeGreaterThan(experimentalIdx);
    // ③ 计数 chip 的插值参数名与模板占位符对齐（模板＝{enabled}/{total}；
    //    曾误传 selected，真机 1.14 直显「同步：{enabled}/30」）。
    expect(fn).toContain("enabled: enabledCount");
    expect(fn).not.toContain("selected:");
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
    const source = readSourceFile("src/ui/config-sync-modal.ts");

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
    const source = readSourceFile("src/ui/config-sync-modal.ts");
    const styles = readSourceFile("styles.css");

    expect(source.match(/extends EasySyncModal/g)).toHaveLength(1);
    expect(source).not.toContain("extends Modal");
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
    expect(source).toContain("runSettingsMutationWhenSyncIdle(");
    expect(source).toContain("pendingMutationCancels");
    expect(source).toContain("communityPlugins.queuedStatus");
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
    const source = readSourceFile("src/ui/config-sync-modal.ts");
    // 收窄：这两个字段名在同一文件里各有 5–7 处，且分属两个读取函数
    // （逐行描述 / 整段指引）——两处都钉住，文件级断言才不会漏掉其中一处。
    const itemBody = functionBody(source, "private describeInventoryItem(");
    const guidanceBody = functionBody(
      source,
      "private describeInventoryGuidance(",
    );
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

    expect(itemBody).toContain("item.participationPhase");
    expect(source).toContain(
      '"settings.communityPlugins.status.joinRequested"',
    );    expect(source).toContain(
      '"settings.communityPlugins.status.restoreBlocked"',
    );
    expect(zhCN["settings.communityPlugins.status.joinRequested"])
      .toBe("将在下次同步时生效");
    expect(zhCN["settings.communityPlugins.status.restoreBlocked"])
      .toBe("恢复受阻");
    expect(en["settings.communityPlugins.status.joinRequested"])
      .toBe("Takes effect after the next sync");
    expect(en["settings.communityPlugins.status.restoreBlocked"])
      .toBe("Restore blocked");
    expect(zhCN["settings.communityPlugins.status.restoreIncompatible"])
      .toBe("与当前设备或 Obsidian 版本不兼容");
    expect(en["settings.communityPlugins.status.restoreIncompatible"])
      .toBe("Not compatible with this device or Obsidian version");
    expect(zhCN["settings.communityPlugins.status.restoreTargetChanged"])
      .toBe("云端插件已变化");
    expect(en["settings.communityPlugins.status.restoreTargetChanged"])
      .toBe("Cloud plugin changed");
    expect(zhCN["settings.communityPlugins.status.restoreScopeChanged"])
      .toBe("同步位置已变化");
    expect(en["settings.communityPlugins.status.restoreScopeChanged"])
      .toBe("Sync location changed");
    expect(zhCN["settings.communityPlugins.status.localBundleIncomplete"])
      .toBe("插件文件不完整");
    expect(en["settings.communityPlugins.status.localBundleIncomplete"])
      .toBe("Plugin files are incomplete");
    expect(zhCN["settings.communityPlugins.status.remoteCatalogStale"])
      .toBe("云端状态待重新确认");
    expect(en["settings.communityPlugins.status.remoteCatalogStale"])
      .toBe("Cloud status needs to be checked again");
    expect(itemBody).toContain("item.participationBlockedReason");
    expect(guidanceBody).toContain("item.participationBlockedReason");
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
      .toBe("下次同步会自动比较本机与云端文件，再让你选择保留哪一份。");
    expect(zhCN["settings.communityPlugins.guidance.reinstall"])
      .toBe("本机读不到插件清单时，请重新安装该插件。");
    expect(zhCN["settings.communityPlugins.guidance.reconfirm"])
      .toBe("云端插件或同步位置变化后，下次同步会重新核对。");
    expect(zhCN["settings.communityPlugins.guidance.retry"])
      .toBe("恢复受阻时，稍后重新同步即可重试。");
  });

  it("keeps rows of cloud-cleaned plugins out of the files list", () => {
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    const createDiv = vi.fn(() => ({}));
    const createEl = vi.fn(() => ({}));
    Object.assign(modal as object, {
      plugin: { i18n: { t: (key: string) => key } },
      inventory: [{
        id: "calendar",
        name: "Calendar",
        local: false,
        remote: true,
        dataLocally: false,
        dataRemotely: false,
        desktopOnly: false,
        manifestIssue: false,
      }],
      cleanedPluginIds: new Set(["calendar"]),
      getManagerColumn: () => "files",
      listScrollEl: {
        scrollTop: 0,
        empty: vi.fn(),
        createEl,
        createDiv,
      },
      searchQuery: "",
      remoteInventoryAvailable: true,
      inventoryLoading: false,
      inventoryLoadFailed: false,
    });

    (modal as unknown as { renderPluginListArea(): void })
      .renderPluginListArea();

    expect(createDiv).not.toHaveBeenCalled();
    expect(createEl).toHaveBeenCalledWith(
      "p",
      expect.objectContaining({
        cls: "setting-item-description easy-sync-plugin-list-message",
      }),
    );
  });

  it("seeds the cleaned-plugin set from persisted markers when the modal opens", () => {
    const source = readSourceFile("src/ui/config-sync-modal.ts");
    expect(source.indexOf("getCommunityPluginCloudCleanupMarkers()"))
      .toBeGreaterThan(-1);
    expect(source.indexOf("getCommunityPluginCloudCleanupMarkers()"))
      .toBeLessThan(source.indexOf("renderPluginListArea"));
  });

  it("keeps cleaned rows hidden on both lists only while the device holds no local files", () => {
    expect(isPluginRowHiddenByCloudCleanup("files", false, true)).toBe(true);
    // Reinstalled locally: the row must come back for management/re-join.
    expect(isPluginRowHiddenByCloudCleanup("files", true, true)).toBe(false);
    expect(isPluginRowHiddenByCloudCleanup("files", undefined, true)).toBe(false);
    // Cloud-cleanup thorough removal hides the data list row identically so
    // the two plugin lists stay consistent after a cleanup.
    expect(isPluginRowHiddenByCloudCleanup("data", false, true)).toBe(true);
    expect(isPluginRowHiddenByCloudCleanup("data", true, true)).toBe(false);
    expect(isPluginRowHiddenByCloudCleanup("files", false, false)).toBe(false);
  });

  it("refreshes the range-independent remote catalog only when the plugin manager opens", () => {
    const source = readSourceFile("src/ui/config-sync-modal.ts");
    // 收窄：刷新调用只该出现在那个"只跑一次"的刷新函数体里；先后关系是
    // 位置事实（定义顺序），按整文件判读。
    const refreshOnce = functionBody(source, "private refreshRemoteCatalogOnce(): void");

    expect(refreshOnce).toContain("refreshCommunityPluginRemoteCatalog");
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
        flushPendingCommunityPluginJoinSync: vi.fn(),
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
    const source = readSourceFile("src/ui/config-sync-modal.ts");
    const styles = readSourceFile("styles.css");

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
    const configSource = readSourceFile("src/ui/config-sync-modal.ts");
    // The self-sync switch is retired: EasySync's own bundle is always in
    // scope, so no toggle may re-introduce a user-controlled opt-in.
    expect(configSource).not.toContain('"settings.syncPluginFiles"');
    // The scope guidance must stay above every switch it explains.
    expect(configSource.indexOf('t("settings.syncScope.intro")')).toBeLessThan(
      configSource.indexOf('key: "settings.syncCorePlugins"'),
    );
    expect(configSource.indexOf('key: "settings.syncCorePlugins"')).toBeLessThan(
      configSource.indexOf('"settings.syncCommunityPlugins"'),
    );
    expect(configSource.indexOf('"settings.syncCommunityPlugins"')).toBeLessThan(
      configSource.indexOf('"settings.syncPluginData"'),
    );
    expect(configSource.indexOf('"settings.syncPluginData"')).toBeLessThan(
      configSource.indexOf('key: "settings.syncEditor"'),
    );
    expect(configSource.indexOf('key: "settings.syncHotkeys"')).toBeLessThan(
      configSource.indexOf('key: "settings.syncBookmarks"'),
    );
    expect(zhCN["settings.syncCommunityPlugins.name"]).toBe("社区插件");
    expect(zhCN["settings.syncPluginData.name"]).toBe("社区插件数据");
    expect(zhCN["settings.syncCommunityPlugins.desc"]).toBe(
      "同步社区插件安装时下载的文件（main.js、manifest.json、styles.css）；不同步启用状态。",
    );
    expect(en["settings.syncCommunityPlugins.desc"]).toBe(
      "Sync the files downloaded when installing a community plugin (main.js, manifest.json, styles.css); enabled state is not synced.",
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
      "插件仅云端有",
    );
    expect(zhCN["settings.communityPlugins.status.dataMissing"]).toBe(
      "未发现 data.json",
    );
    expect(zhCN["settings.communityPlugins.status.desktopOnly"]).toBe(
      "仅桌面可用",
    );
    expect(zhCN["settings.communityPlugins.status.manifestIssue"]).toBe(
      "本机插件文件缺失或损坏，请重新安装",
    );
    expect(en["settings.communityPlugins.status.localOnly"]).toBe(
      "Plugin files only on this device",
    );
    expect(en["settings.communityPlugins.status.remoteOnly"]).toBe(
      "Plugin files only in the cloud",
    );
    expect(en["settings.communityPlugins.status.dataMissing"]).toBe(
      "No data.json found",
    );
    expect(en["settings.communityPlugins.status.desktopOnly"]).toBe(
      "Only works on desktop",
    );
    expect(en["settings.communityPlugins.status.manifestIssue"]).toBe(
      "Local plugin files are missing or damaged — reinstall the plugin",
    );
  });

  it("omits the status line for historical rows with no bundle on either side", () => {
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: { i18n: { t: (key: string) => key } },
    });
    const status = (modal as unknown as {
      describeInventoryItem(
        item: Record<string, unknown>,
        column: "files",
      ): string | null;
    }).describeInventoryItem({
      id: "calendar",
      name: "Calendar",
      local: false,
      remote: false,
      dataLocally: false,
      dataRemotely: false,
      desktopOnly: false,
      manifestIssue: false,
      participationPhase: undefined,
    }, "files");
    expect(status).toBeNull();
  });

  it("keeps sync exclusion copy device-local and non-destructive in both locales", () => {
    expect(zhCN["settings.syncScope.name"]).toBe("同步范围");
    expect(zhCN["settings.syncScope.desc"]).toBe(
      "选择要同步的 Obsidian 配置、主题和插件文件。",
    );
    // 规则句（用户 2026-10-12 定稿）：两设备语义＋⚙ 引导；同一句也作同步视图
    // 「范围管理」弹框（scope 视图）的 intro，弹框 intro 下方同样有带 ⚙ 的行。
    expect(zhCN["settings.syncScope.intro"]).toBe(
      "设置仅对本设备生效，当其他设备也开启后，才会相互同步。点击下方 ⚙，可单独控制每个插件是否参与同步。",
    );
    expect(en["settings.syncScope.intro"]).toBe(
      "These settings apply to this device only; sync starts only once your other devices enable them too. Click the gear below to control whether each plugin takes part in sync.",
    );
    // 自动同步弹框顶部指引（用户 2026-09-23 定稿）：0 值语义 + 被打断后的恢复动作。
    expect(zhCN["settings.autoSync.intro"]).toBe(
      "拖到最左侧（归零）即关闭；自动同步若被特殊状态打断，须手动同步一次才继续。",
    );
    expect(en["settings.autoSync.intro"]).toBe(
      "Dragging a slider fully to the left (zero) turns it off. If auto sync is interrupted by a special state, it resumes only after one manual sync.",
    );
    // 整包冲突行（用户 2026-09-23 定稿）：标题只用品牌名，原因句问「保留哪一份」。
    expect(zhCN["syncView.selfBundleReview.title"]).toBe("EasySync");
    expect(zhCN["syncView.selfBundleReview.conflictSummary"]).toBe(
      "本插件与云端版本冲突，保留哪一份？",
    );
    expect(en["syncView.selfBundleReview.title"]).toBe("EasySync");
    expect(en["syncView.selfBundleReview.conflictSummary"]).toBe(
      "This plugin’s local copy and its cloud version conflict. Which do you want to keep?",
    );
    // 弹框顶部说明在手机上会被宿主的内容列向 flex 挤成 0 高（行数最多的同步范围
    // 弹框首当其冲）：四个弹框都用同一类保住自己的盒子，样式里有对应规则。
    for (const modalSource of [
      "src/ui/config-sync-modal.ts",
      "src/ui/sync-exclusion-modal.ts",
      "src/ui/automatic-handling-modal.ts",
      "src/ui/auto-sync-modal.ts",
    ]) {
      expect(readSourceFile(modalSource)).toContain(
        "setting-item-description easy-sync-modal-intro",
      );
    }
    expect(readSourceFile("styles.css")).toMatch(
      /\.easy-sync-modal-intro\s*\{[^}]*flex:\s*0 0 auto/s,
    );
    expect(en["settings.syncScope.name"]).toBe("Sync scope");
    expect(zhCN["settings.syncExclusion.name"]).toBe("同步排除");
    expect(zhCN["settings.syncExclusion.desc"]).toBe(
      "选择此设备不参与同步的文件夹，也可排除超过指定大小的文件。",
    );
    expect(zhCN["settings.syncExclusion.intro"]).toBe(
      "只影响此设备。所选文件夹及其内容不会上传或下载，现有文件不会因此被删除。",
    );
    expect(zhCN["settings.syncExclusion.folders.name"]).toBe("不同步的文件夹");
    expect(en["settings.syncExclusion.desc"]).toBe(
      "Choose folders this device will not sync. You can also exclude files above a size limit.",
    );
    expect(en["settings.syncExclusion.intro"]).toContain("will not be deleted");
  });

  it("keeps the plan alert single-purpose after the login notice is removed", () => {
    const mainSource = readSourceFile("src/main.ts");
    const entrySource = readSourceFile("src/ui/auth-entry-flow.ts");
    const alertSource = readSourceFile("src/ui/confirm-modal.ts");

    // The login-gate notice ("登录前须知") and the method-chooser lead line
    // were removed entirely in 2026-08-28 (full content archived in the dev
    // log `20260828-003740`); the first plan alert stays single-purpose
    // (plan generated → review in the sidebar). The quiet-period guidance
    // appended 2026-09-15 (issue #18 round) is part of that single purpose.
    expect(entrySource).not.toContain("AuthLoginNoticeModal");
    expect(entrySource).not.toContain("auth.notice");
    expect(entrySource).not.toContain("method.lead");
    expect(mainSource).not.toContain("syncPlan.firstUseUsage");
    expect(mainSource).not.toContain("syncPlan.firstUseSafety");
    expect(zhCN["syncPlan.readyMessage"]).toBe(
      "同步计划已生成，请在侧边栏查看详情并确认执行。确认前请尽量避免改动文件；期间如有改动，计划会重新生成，需要重新确认。",
    );
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

  it("hides the automatic handling row in one-way mode on the imperative path", () => {
    const names: string[] = [];
    const setNameSpy = vi.spyOn(Setting.prototype, "setName")
      .mockImplementation(function (this: Setting, name: string) {
        names.push(name);
        return this;
      });
    try {
      const renderNames = (direction: "two-way" | "one-way") => {
        names.length = 0;
        const tab = new EasySyncSettingTab({
          app: {},
          register: vi.fn(),
          syncDirection: direction,
          i18n: { t: (key: string) => key },
          autoSyncPaused: false,
          isAutoSyncMasterEnabled: () => true,
          setAutoSyncMasterEnabled: vi.fn().mockResolvedValue(undefined),
        } as unknown as EasySyncPlugin);
        (tab as unknown as { automaticSectionEl: unknown })
          .automaticSectionEl = createMockElement();
        (tab as unknown as {
          renderAutomaticSection(t: (key: string) => string): void;
        }).renderAutomaticSection((key) => key);
        return [...names];
      };

      // 双向：两行都在（「自动处理」行只隐藏、不删除）。
      const twoWay = renderNames("two-way");
      expect(twoWay).toContain("settings.automaticHandling.name");
      expect(twoWay).toContain("settings.autoSync.name");

      // 单向：入口行不渲染；「自动同步」行照常。
      const oneWay = renderNames("one-way");
      expect(oneWay).not.toContain("settings.automaticHandling.name");
      expect(oneWay).toContain("settings.autoSync.name");
    } finally {
      setNameSpy.mockRestore();
    }
  });

  it("renders both automatic handling choices as native toggles without triggering sync", () => {
    const source = readSourceFile("src/ui/automatic-handling-modal.ts");
    // 收窄：两个开关与它们的提交都接在 onOpen 里；文件级断言会被同文件别处
    // （类型声明、别的分支）的同名字段蒙过。
    const onOpen = functionBody(source, "onOpen(): void");

    expect(source.match(/new Setting\(/g)).toHaveLength(2);
    expect(onOpen).toContain("autoDeleteLocalFiles");
    expect(onOpen).toContain("mergeNonOverlappingText");
    expect(onOpen).toContain("updateAutomaticHandlingPolicy");
    expect(source).not.toContain("startManualSync");
    expect(source).not.toContain("confirmRemoteDelete");
  });

  it("keeps the sync mode hints and the local-only row copy directional", () => {
    // 模式行两条说明句（2026-10-12 末轮定稿）：单向＝云端的修改与删除会同步到
    // 本机、本机不再主动上传（"不再主动向云端上传"是用户点名的核心点）；
    // 双向句不变。
    expect(zhCN["settings.syncMode.hint.oneway"]).toBe(
      "云端的修改与删除会同步到本机；本机不再主动向云端上传笔记与附件。",
    );
    expect(en["settings.syncMode.hint.oneway"]).toBe(
      "Cloud changes and deletions are synced down to this device; this device no longer uploads notes or attachments to the cloud automatically.",
    );
    expect(zhCN["settings.syncMode.hint.twoway"]).toBe(
      "本机和云端的改动会互相同步。",
    );
    expect(en["settings.syncMode.hint.twoway"]).toBe(
      "Changes here and in the cloud sync to each other.",
    );
    // 副本文件名标签（copyLabel＝设备中立）与新建 chip 不变；改动 chip 随末轮
    // 改「本机修改」，与开启弹框的"本机修改／本机新建"成对。
    expect(zhCN["syncView.localOnly.copyLabel"]).toBe("副本");
    expect(en["syncView.localOnly.copyLabel"]).toBe("Copy");
    expect(zhCN["syncView.localOnly.chip.edited"]).toBe("本机修改");
    expect(zhCN["syncView.localOnly.chip.created"]).toBe("本机新建");
    // 逐条行说明句（2026-10-12 末轮定稿）：只有改动类有一句"这份副本里是什么"；
    // 新建类不写说明句（键已退场，渲染侧按类条件挂载）。
    expect(zhCN["syncView.localOnly.reason.edited"]).toBe(
      "本机修改已存入此副本。",
    );
  });

  it("keeps automatic handling copy directional and condition-accurate", () => {
    expect(zhCN["settings.automaticHandling.desc"]).toBe(
      "选择同步时可自动完成的操作。",
    );
    expect(zhCN["settings.automaticHandling.intro"]).toBe(
      "选项从下一次同步起生效，不会立即改动文件。",
    );
    expect(zhCN["settings.automaticHandling.autoDeleteLocalFiles.name"]).toBe(
      "将云端删除同步到本机",
    );
    expect(zhCN["settings.automaticHandling.autoDeleteLocalFiles.desc"]).toBe(
      "云端文件已删除且本机自上次同步后未修改时，删除本机对应文件。EasySync 不保留额外副本。",
    );
    expect(zhCN["settings.automaticHandling.mergeNonOverlappingText.name"]).toBe(
      "合并不重叠的文本修改",
    );
    expect(zhCN["settings.automaticHandling.mergeNonOverlappingText.desc"]).toBe(
      "本机和云端修改同一份已同步文本、且修改内容互不重叠时，将两边修改合并并同步到两端；无法安全合并时留待手动处理。",
    );
    expect(en["settings.automaticHandling.autoDeleteLocalFiles.name"]).toBe(
      "Apply cloud deletions locally",
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

describe("settings save call sites", () => {
  it("wraps every settings-tab save with rollback and a failure notice (C10-5 同形)", () => {
    // C10-5 同形缺口(账本 §七):saveSyncSettings 调用失败时必须回滚内存与控件并
    // 提示，而不是 unhandled rejection 且其后的 apply*/渲染被跳过。
    // 2026-10-12 重构后拆两处承接：命令式路径与模式行留在 settings-tab.ts，
    // 1.13+ 页面行（通知／滑条×2／启动后立即同步／自动处理×2／大文件排除／
    // 移动端状态图标）在 settings-page-rows.ts。
    const tabSource = readSourceFile("src/ui/settings-tab.ts");
    const rowsSource = readSourceFile("src/ui/settings-page-rows.ts");
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    expect(count(tabSource, "notice.settingsSaveFailed")).toBe(5);
    expect(count(rowsSource, "notice.settingsSaveFailed")).toBe(7);
    // 回滚语义：控件拨回上一值；自动处理开关按内存现值拨回（同义）。
    expect(count(tabSource, ".setValue(previous)")).toBe(4);
    expect(count(rowsSource, ".setValue(previous)")).toBe(6);
    expect(rowsSource).toContain(
      "toggle.setValue(plugin.automaticHandlingPolicy[policyKey]);",
    );
  });

  it("restores the acknowledged rules through reset, not through a new row (2026-10-12 用户裁决)", () => {
    // 恢复出口＝「重置同步状态」本身：重置时清空「已读」记忆，规则随之全部重现；
    // 不新增行、不新增文案（源码守卫；行为随重置链由真机/回归覆盖）。
    const mainSource = readSourceFile("src/main.ts");
    const tabSource = readSourceFile("src/ui/settings-tab.ts");
    expect(mainSource).toContain("this.acknowledgedRules = [];");
    expect(mainSource).not.toContain("restoreAcknowledgedSettingRules");
    expect(tabSource).not.toContain("buildSettingRulesRestoreRow");
  });

  it("wraps the exclusion modal max-size persistence with rollback and a failure notice", () => {
    const source = readSourceFile("src/ui/sync-exclusion-modal.ts");
    const start = source.indexOf("private async persistMaxFileSizeMb(");
    const next = source.indexOf("private async", start + 10);
    const fn = source.slice(start, next === -1 ? undefined : next);
    expect(fn).toContain("notice.settingsSaveFailed");
    expect(fn).toContain("this.syncMaxFileSizeDropdownSelection()");
    expect(fn).toContain("this.plugin.applyMaxFileSize()");
  });
});

describe("imperative maintenance group · local-only reversal row (件③)", () => {
  function renderRowNames(
    plugin: EasySyncPlugin,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): Array<{ name: string; desc?: string }> {
    const tab = new EasySyncSettingTab(plugin);
    const host = tab as unknown as Record<string, unknown>;
    host.maintenanceSectionEl = createMockElement();
    // 2026-10-20 起维护页拆两组：顶部诊断＋「高级」组，两组宿主都要给。
    host.maintenanceAdvancedSectionEl = createMockElement();
    const rows: Array<{ name: string; desc?: string }> = [];
    let current: { name: string; desc?: string } | null = null;
    const nameSpy = vi.spyOn(Setting.prototype, "setName").mockImplementation(
      function (this: Setting, name: string) {
        current = { name };
        rows.push(current);
        return this;
      },
    );
    const descSpy = vi.spyOn(Setting.prototype, "setDesc").mockImplementation(
      function (this: Setting, desc: string) {
        if (current) current.desc = desc;
        return this;
      },
    );
    try {
      (tab as unknown as {
        renderMaintenanceSection(t: unknown): void;
      }).renderMaintenanceSection(t);
    } finally {
      nameSpy.mockRestore();
      descSpy.mockRestore();
    }
    return rows;
  }

  function makeMaintenancePlugin(options: {
    direction: string;
    ignoredCount: number;
  }): EasySyncPlugin {
    return {
      app: {},
      register: vi.fn(),
      syncDirection: options.direction,
      getIgnoredLocalOnlyCount: () => options.ignoredCount,
      clearLocalOnlyIgnores: vi.fn().mockResolvedValue(undefined),
      diagLogEnabled: false,
      generateDiagnosticReport: vi.fn().mockResolvedValue(undefined),
      resetSyncState: vi.fn().mockResolvedValue(undefined),
      openRecoveryEntry: vi.fn(),
    } as unknown as EasySyncPlugin;
  }

  const t = new I18n("zh-cn").t.bind(new I18n("zh-cn"));

  it("keeps the row out of the group unless one-way mode still has ignored entries", () => {
    const namesIn = (plugin: EasySyncPlugin) =>
      renderRowNames(plugin, t).map((row) => row.name);

    // 双向：不出现（忽略记忆在双向不生效）。
    expect(namesIn(makeMaintenancePlugin({ direction: "two-way", ignoredCount: 4 })))
      .not.toContain(t("settings.localOnlyIgnored.name"));
    // 单向但没有可收回的内容：保持零动作干净态。
    expect(namesIn(makeMaintenancePlugin({ direction: "one-way", ignoredCount: 0 })))
      .not.toContain(t("settings.localOnlyIgnored.name"));
    // 单向且有被忽略的条目：出现在「同步回收站」与「重置」之间（「高级」组
    // 内，2026-10-20 用户拍板分组），说明带计数。
    const rows = renderRowNames(
      makeMaintenancePlugin({ direction: "one-way", ignoredCount: 4 }),
      t,
    );
    expect(rows.map((row) => row.name)).toEqual([
      t("settings.diagLog.name"),
      t("settings.diagReport.name"),
      // 「高级」组首行＝同步回收站（同组在重置之上）。
      t("settings.recoveryBin.name"),
      t("settings.localOnlyIgnored.name"),
      t("settings.reset.name"),
    ]);
    expect(rows[3].desc).toBe(t("settings.localOnlyIgnored.desc", { count: 4 }));
  });
});
