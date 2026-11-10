import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Setting, ButtonComponent, ToggleComponent } from "./__mocks__/obsidian";
import {
  buildLoginPage,
  buildRootSettingDefinitions,
  buildSettingDefinitions,
  getSettingsFooterLinks,
} from "../src/ui/settings-tab";
import { I18n } from "../src/i18n";
import type EasySyncPlugin from "../src/main";

// The reset definition opens a ConfirmModal before clearing state. Mock it so
// we can drive both the confirmed and the cancelled path.
const confirmResult = { value: true };
vi.mock("../src/ui/confirm-modal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/confirm-modal")>();
  return {
    ...actual,
    ConfirmModal: class {
      constructor(
        private _app: unknown,
        private _title: string,
        private _desc: unknown,
        private _confirm: string,
        private _cancel: string,
        private _t: unknown,
        private _opts?: { danger?: boolean },
      ) {}
      async awaitConfirm(): Promise<boolean> {
        return confirmResult.value;
      }
    },
  };
});

/**
 * Minimal EasySyncPlugin-shaped object: only the members
 * `buildSettingDefinitions()` touches are provided.
 */
function createMockPlugin(): EasySyncPlugin {
  const acknowledgedRules: string[] = [];
  return {
    app: {} as never,
    manifest: { version: "1.4.0" },
    syncMaxFileSizeMb: 500,
    syncInterval: 3,
    autoSyncChangeDelaySeconds: 5,
    autoSyncOnStartup: true,
    notificationPopups: "all",
    mobileStatusBar: true,
    diagLogEnabled: false,
    syncDirection: "two-way",
    autoSyncPaused: false,
    isAutoSyncMasterEnabled: function (
      this: {
        syncInterval: number;
        autoSyncChangeDelaySeconds: number;
        autoSyncOnStartup: boolean;
      },
    ): boolean {
      return this.syncInterval > 0
        || this.autoSyncChangeDelaySeconds > 0
        || this.autoSyncOnStartup;
    },
    setAutoSyncMasterEnabled: vi.fn().mockResolvedValue(undefined),
    setAutoSyncOnStartup: vi.fn(),
    excludedFolders: [],
    automaticHandlingPolicy: {
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: false,
    },
    updateAutomaticHandlingPolicy: vi.fn().mockResolvedValue(undefined),
    acknowledgedRules,
    isSettingRuleAcknowledged: (ruleId: string) =>
      acknowledgedRules.includes(ruleId),
    acknowledgeSettingRule: vi.fn(async (ruleId: string) => {
      if (!acknowledgedRules.includes(ruleId)) acknowledgedRules.push(ruleId);
    }),
    saveSyncSettings: vi.fn().mockResolvedValue(undefined),
    applyMaxFileSize: vi.fn(),
    applyNotificationPopups: vi.fn(),
    applyDiagnosticSetting: vi.fn(),
    restartAutoSync: vi.fn(),
    setAutoSyncChangeDelaySeconds: vi.fn(),
    resetSyncState: vi.fn().mockResolvedValue(undefined),
    generateDiagnosticReport: vi.fn().mockResolvedValue(undefined),
    hasCompletedSyncState: () => false,
    // 件③ 反转入口：默认双向模式＝没有可收回的忽略内容，行按 visible 隐藏。
    getIgnoredLocalOnlyCount: () => 0,
    clearLocalOnlyIgnores: vi.fn().mockResolvedValue(undefined),
    auth: {
      authState: { isLoggedIn: false, displayName: undefined },
      isInitializing: false,
      isPending: false,
      deviceAttempt: null,
    },
    openSyncPanelFromSettings: vi.fn().mockResolvedValue(undefined),
    openRecoveryEntry: vi.fn(),
    logoutUser: vi.fn().mockResolvedValue(undefined),
    getUpdatePromptState: vi.fn(() => null),
    openUpdatePage: vi.fn(),
  } as unknown as EasySyncPlugin;
}

describe("buildSettingDefinitions", () => {
  it("returns the five navigable pages with unique sibling names", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const defs = buildSettingDefinitions(t, plugin);

    const pages = defs as Array<{ type?: string; name?: string }>;
    expect(pages.map((page) => page.type)).toEqual([
      "page", "page", "page", "page", "page",
    ]);
    expect(pages.map((page) => page.name)).toEqual([
      t("settings.syncScope.name"),
      t("settings.autoSync.name"),
      t("settings.group.display"),
      t("settings.group.about"),
      t("settings.group.maintenance"),
    ]);
    // 页名兄弟唯一（官方硬要求；重复会破坏导航与搜索归属）。
    const names = pages.map((page) => page.name);
    expect(new Set(names).size).toBe(names.length);
    // 根级零内联设置：本函数只产出页面（入口组的装配在 getSettingDefinitions）。
    expect(defs.every((def) => (def as { type?: string }).type === "page")).toBe(true);
  });

  it("lays out each page's rows per the 2026-10-11 wireframe", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const defs = buildSettingDefinitions(t, plugin);
    const labels = (items: unknown[]): string[] =>
      items.flatMap((item) => {
        const typed = item as { name?: string; heading?: string; items?: unknown[] };
        const own = [typed.name ?? typed.heading].filter(
          (value): value is string => value !== undefined,
        );
        return [...own, ...(typed.items ? labels(typed.items) : [])];
      });
    const pageItems = (name: string): unknown[] =>
      ((defs.find((def) => (def as { name?: string }).name === name) as {
        items?: unknown[];
      })?.items) ?? [];

    expect(labels(pageItems(t("settings.syncScope.name")))).toEqual([
      t("settings.rules.name"),
      t("settings.syncExclusion.folders.name"),
      t("settings.maxFileSize.name"),
      t("settings.syncContent.heading"),
      t("settings.rules.name"),
      t("settings.syncCorePlugins.name"),
      t("settings.syncEditor.name"),
      t("settings.syncAppearance.name"),
      t("settings.syncThemes.name"),
      t("settings.syncHotkeys.name"),
      t("settings.syncBookmarks.name"),
    ]);
    expect(labels(pageItems(t("settings.autoSync.name")))).toEqual([
      t("settings.rules.name"),
      t("settings.autoSync.name"),
      t("settings.syncInterval.name"),
      t("settings.autoSyncChangeDelay.name"),
      t("settings.autoSyncOnStartup.name"),
      t("settings.automaticHandling.name"),
      t("settings.rules.name"),
      t("settings.automaticHandling.autoDeleteLocalFiles.name"),
      t("settings.automaticHandling.mergeNonOverlappingText.name"),
    ]);
    expect(labels(pageItems(t("settings.group.display")))).toEqual([
      t("settings.notificationPopups.name"),
      // 移动端专属开关：定义树常备一行，渲染时按 Platform.isMobile 隐藏（同
      // 维护页「件③ 反转入口」的登记表口径）。
      t("settings.mobileStatusBar.name"),
    ]);
    expect(labels(pageItems(t("settings.group.about")))).toEqual([
      t("settings.about.product.name"),
      t("settings.about.author.name"),
      t("settings.about.feedback.name"),
    ]);
    expect(labels(pageItems(t("settings.group.maintenance")))).toEqual([
      t("settings.diagLog.name"),
      t("settings.diagReport.name"),
      // 「高级」组（2026-10-20 用户拍板）：同步回收站在上、件③ 常备、重置收尾；
      // 顶部诊断为无标题组（首组无标题口径同 2026-10-12 拍板）。
      t("settings.maintenanceAdvanced.heading"),
      t("settings.recoveryBin.name"),
      // 件③ 反转入口：定义树里常备一行（单向且计数 > 0 才 visible），本桩为
      // 双向模式，所以渲染时隐藏、行名仍在登记表里。
      t("settings.localOnlyIgnored.name"),
      t("settings.reset.name"),
    ]);
    // 全案只有三个分组标题（每页第一分组不加标题，2026-10-12 拍板）。
    expect(labels(pageItems(t("settings.syncScope.name"))))
      .toContain(t("settings.syncContent.heading"));
    expect(labels(pageItems(t("settings.group.display"))))
      .not.toContain(t("settings.group.display"));
  });

  it("renders every definition without throwing", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);

    const renderable = (def: unknown): Array<{ render: (setting: never) => void }> => {
      const typed = def as { type?: string; items?: unknown[]; render?: (setting: never) => void };
      // 页面与分组都是容器：`items` 非空即继续下钻（页面是 1.13+ 的渲染单位）。
      if (Array.isArray(typed.items)) {
        return typed.items.flatMap((item) => renderable(item));
      }
      return typed.render ? [typed as { render: (setting: never) => void }] : [];
    };

    const items = defs.flatMap((def) => renderable(def));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      // Provide a mock Setting so addButton/addSlider/addDropdown/addToggle work.
      const setting = new Setting({} as HTMLElement) as never;
      expect(() => item.render(setting)).not.toThrow();
    }
  });

  it("does not mutate plugin state while building the definition list", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const snapshot = {
      syncMaxFileSizeMb: plugin.syncMaxFileSizeMb,
      syncInterval: plugin.syncInterval,
      notificationPopups: plugin.notificationPopups,
    };
    buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    expect(plugin.syncMaxFileSizeMb).toBe(snapshot.syncMaxFileSizeMb);
    expect(plugin.syncInterval).toBe(snapshot.syncInterval);
    expect(plugin.notificationPopups).toBe(snapshot.notificationPopups);
  });

  it("progressively discloses the notification pop-ups level hint", async () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const defs = buildSettingDefinitions(t, plugin);

    const displayPage = defs.find(
      (d) => (d as { name?: string }).name === t("settings.group.display"),
    ) as { items: Array<{ name?: string; render?: (setting: never) => void }> };
    const item = displayPage.items.find(
      (i) => i.name === t("settings.notificationPopups.name"),
    );
    expect(item).toBeDefined();

    // Track the hint element created inside the row's desc, and drive the
    // dropdown: the hint must follow the selected level.
    const hintTexts: string[] = [];
    const hintEl = {
      setText: (text: string) => { hintTexts.push(text); return hintEl; },
    };
    let dropdownOnChange: ((value: string) => void | Promise<void>) | null = null;
    const setting = {
      controlEl: { empty: () => undefined },
      descEl: { querySelector: () => null, createDiv: () => hintEl },
      setName: () => setting,
      addDropdown: (cb: (dropdown: unknown) => void) => {
        const dropdown = {
          addOption: () => dropdown,
          addOptions: () => dropdown,
          setValue: () => dropdown,
          setDisabled: () => dropdown,
          onChange: (cb2: (value: string) => void | Promise<void>) => {
            dropdownOnChange = cb2;
            return dropdown;
          },
        };
        cb(dropdown);
        return setting;
      },
    };

    expect(plugin.notificationPopups).toBe("all");
    item!.render!(setting as never);
    // Initial render shows the hint for the current level.
    expect(hintTexts).toEqual([t("settings.notificationPopups.hint.all")]);

    // Switch to "important only": hint updates in place without a re-render.
    await dropdownOnChange!("important");
    expect(plugin.notificationPopups).toBe("important");
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(plugin.applyNotificationPopups).toHaveBeenCalledTimes(1);
    expect(hintTexts).toEqual([
      t("settings.notificationPopups.hint.all"),
      t("settings.notificationPopups.hint.important"),
    ]);

    // Switch to "off".
    await dropdownOnChange!("off");
    expect(plugin.notificationPopups).toBe("off");
    expect(hintTexts).toEqual([
      t("settings.notificationPopups.hint.all"),
      t("settings.notificationPopups.hint.important"),
      t("settings.notificationPopups.hint.off"),
    ]);
  });

  it("splits the rules per section and lets 我知道了 hide an acknowledged rule", async () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const plugin = createMockPlugin();
    const defs = buildSettingDefinitions(t, plugin) as unknown as Array<{
      name?: string;
      items?: Array<Record<string, unknown>>;
    }>;
    const scopeItems = defs[0].items as Array<{
      name?: string;
      desc?: string;
      visible?: () => boolean;
      render?: (s: never) => void;
      heading?: string;
      items?: Array<{ name?: string; desc?: string }>;
    }>;

    // 规则按板块拆分（不合并）：排除板块＝排除语义句；内容板块＝同步内容开关句
    //（2026-11-10 拆页后社区插件板块的规则随行搬到「社区插件同步」页）。
    expect(scopeItems[0].desc).toBe(t("settings.syncExclusion.intro"));
    const contentGroup = scopeItems[3] as {
      heading?: string;
      items?: Array<{ name?: string; desc?: string }>;
    };
    expect(contentGroup.heading).toBe(t("settings.syncContent.heading"));
    expect(contentGroup.items?.[0].desc).toBe(t("settings.syncContent.intro"));
    const autoItems = defs[1].items as typeof scopeItems;
    expect(autoItems[0].desc).toBe(t("settings.autoSync.intro"));
    const handlingGroup = autoItems.find(
      (item) => item.heading === t("settings.automaticHandling.name"),
    ) as { items?: Array<{ name?: string; desc?: string }> };
    expect(handlingGroup.items?.[0].desc).toBe(
      t("settings.automaticHandling.intro"),
    );

    // 「我知道了」：点后该规则落盘，visible 谓词随即为假（整行隐藏）。
    const ruleRow = scopeItems[0];
    expect(ruleRow.visible?.()).toBe(true);
    let clickHandler: (() => void | Promise<void>) | null = null;
    const rowEl = {
      style: {} as Record<string, string>,
      classes: new Set<string>(),
      toggleClass(token: string, on?: boolean) {
        if (on ?? true) this.classes.add(token);
        else this.classes.delete(token);
      },
      setCssProps(props: Record<string, string>) {
        Object.assign(this.style, props);
      },
    };
    const setting = {
      controlEl: { empty: () => undefined },
      settingEl: rowEl,
      setName: () => setting,
      setDesc: () => setting,
      addButton: (cb: (b: unknown) => void) => {
        const btn = {
          setButtonText: () => btn,
          onClick: (handler: () => void | Promise<void>) => {
            clickHandler = handler;
            return btn;
          },
        };
        cb(btn);
        return setting;
      },
    };
    ruleRow.render!(setting as never);
    // 未收起：不得挂收起标记类（分割线随组内首行语义由宿主豁免）。
    expect(rowEl.classes.has("easy-sync-setting-rule-acknowledged")).toBe(false);
    await clickHandler!();
    expect(plugin.acknowledgeSettingRule).toHaveBeenCalledWith("scopeExclusion");
    await vi.waitFor(() => expect(ruleRow.visible?.()).toBe(false));
    // 行级显隐走行内样式（宿主隐藏会留下行壳的分隔线）。
    expect(rowEl.style.display).toBe("none");
    // 收起标记类：宿主的行间分割线画在后继行 ::before 上、只豁免 DOM
    // :first-child，display:none 仍占住 first-child——须由 styles.css 的
    // 后继选择器同步关掉后继行的分割线（styles.css 侧断言见下）。
    expect(rowEl.classes.has("easy-sync-setting-rule-acknowledged")).toBe(true);
    // 恢复路径（重置同步状态清空记忆）：update() 重跑渲染回调须摘除标记类，
    // 分割线随组内首行语义回归。
    plugin.acknowledgedRules.length = 0;
    ruleRow.render!(setting as never);
    expect(rowEl.style.display).toBe("");
    expect(rowEl.classes.has("easy-sync-setting-rule-acknowledged")).toBe(false);
  });

  // styles.css 契约：收起标记类的后继选择器必须存在，且压制的是后继行的
  // ::before（宿主分割线载体）；「content: none」与宿主对 :first-child 的
  // 豁免写法同款，选择器前缀 .setting-group 压过宿主分割线规则的 specificity。
  it("ships the acknowledged-rule follower divider suppression in styles.css", () => {
    const css = readFileSync("styles.css", "utf8");
    expect(css).toContain(
      ".setting-group .easy-sync-setting-rule-acknowledged + .setting-item::before",
    );
  });

  it("keeps root entry rows to name + at most one displayValue (2026-11-10 窄列表)", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const rowsOf = (plugin: EasySyncPlugin) =>
      buildSettingDefinitions(t, plugin) as unknown as Array<{
        desc?: string;
        displayValue?: string;
        status?: string;
      }>;

    // 窄列表：根级页面入口不再带说明句（行名自足，说明只在页内）。
    const bareRows = rowsOf(createMockPlugin());
    expect(bareRows.every((row) => row.desc === undefined)).toBe(true);
    // 同步范围：无排除＝留空（不下发 displayValue）；有排除＝「排除 {n} 项」。
    expect(bareRows[0].displayValue).toBeUndefined();
    const withExclusions = createMockPlugin();
    (withExclusions as unknown as { excludedFolders: string[] }).excludedFolders =
      ["Private/日记"];
    const rows = rowsOf(withExclusions);
    expect(rows[0].displayValue).toBe(
      t("settings.rootNav.value.excluded", { count: 1 }),
    );

    // 自动同步：派生态（mock 默认 interval=3 ⇒ 已开启）。
    expect(rows[1].displayValue).toBe(t("settings.rootNav.value.autoSyncOn"));
    const off = createMockPlugin();
    off.syncInterval = 0;
    off.autoSyncChangeDelaySeconds = 0;
    off.autoSyncOnStartup = false;
    expect(rowsOf(off)[1].displayValue).toBe(t("settings.rootNav.value.autoSyncOff"));

    // 显示：档位词（复用现役选项词）；维护：留空。
    expect(rows[2].displayValue).toBe(t("settings.notificationPopups.option.all"));
    expect(rows[4].displayValue).toBeUndefined();

    // 关于：无新版＝版本号（无角标）；有新版＝「有新版本」＋ warning 角标。
    expect(rows[3].displayValue).toBe("1.4.0");
    expect(rows[3].status).toBeUndefined();
    const withUpdate = createMockPlugin();
    (withUpdate as unknown as { getUpdatePromptState: () => unknown }).getUpdatePromptState =
      () => ({ latest: "1.5.5", current: "1.4.0" });
    const updateRows = rowsOf(withUpdate);
    expect(updateRows[3].displayValue).toBe(t("updateCheck.chip"));
    expect(updateRows[3].status).toBe("warning");
  });
});

describe("buildLoginPage", () => {
  it("puts the existing account and sync-mode rows inside the login page", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const page = buildLoginPage(i18n.t.bind(i18n), plugin);

    expect((page as { type?: string }).type).toBe("page");
    expect((page as { name?: string }).name).toBe(i18n.t("settings.loginPage.name"));
    const items = (page as { items: Array<{ name?: string }> }).items;
    // 2026-11-10：账号行与同步模式行原样搬进「登录」页；同步面板行已升根级动作行。
    expect(items.length).toBe(2);
    expect(items[0].name).toBe(i18n.t("settings.account.name"));
    expect(items[1].name).toBe(i18n.t("settings.syncMode.name"));
    // 根级入口行尾透登录状态（窄列表每行最多一个现值）；未登录亮宿主警示角标。
    expect((page as { displayValue?: string }).displayValue).toBe(
      i18n.t("settings.loginPage.value.loggedOut"),
    );
    expect((page as { status?: string }).status).toBe("warning");
    (plugin.auth as unknown as {
      authState: { isLoggedIn: boolean; displayName?: string };
    }).authState.isLoggedIn = true;
    (plugin.auth as unknown as {
      authState: { displayName?: string };
    }).authState.displayName = "张三";
    const signedIn = buildLoginPage(i18n.t.bind(i18n), plugin);
    // 已登录直接写账号名（用户 2026-11-10 点名，不再写「已登录」）。
    expect((signedIn as { displayValue?: string }).displayValue).toBe("张三");
    // 已登录不亮标（角标与现值同判据）。
    expect((signedIn as { status?: string }).status).toBeUndefined();
    // 验证中：既不写未登录，也不亮警示标。
    (plugin.auth as unknown as { isInitializing: boolean }).isInitializing = true;
    (plugin.auth as unknown as {
      authState: { isLoggedIn: boolean };
    }).authState.isLoggedIn = false;
    const settling = buildLoginPage(i18n.t.bind(i18n), plugin);
    expect((settling as { displayValue?: string }).displayValue).toBeUndefined();
    expect((settling as { status?: string }).status).toBeUndefined();
  });

  it("hides the sync-mode row until the user is signed in", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const page = buildLoginPage(i18n.t.bind(i18n), plugin);
    const items = (page as {
      items: Array<{ name?: string; visible?: () => boolean }>;
    }).items;
    const modeItem = items.find((i) =>
      i.name === i18n.t("settings.syncMode.name"));
    expect(modeItem).toBeDefined();
    expect(modeItem?.visible?.()).toBe(false);
    (plugin.auth as unknown as {
      authState: { isLoggedIn: boolean; displayName?: string };
    }).authState.isLoggedIn = true;
    expect(modeItem?.visible?.()).toBe(true);
  });

  it("renders the sync-mode row from one single-track implementation", () => {
    const source = readFileSync("src/ui/settings-tab.ts", "utf8");
    // 定义一处＋声明式调用一处（<1.13 命令式轨道已随 minAppVersion 1.13.4 退场）。
    expect(source.split("renderSyncModeRow(").length - 1).toBe(2);
    const row = source.slice(
      source.indexOf("export function renderSyncModeRow("),
      source.indexOf("async function applySyncModeSelection("),
    );
    expect(row).toContain('t("settings.syncMode.name")');
    expect(row).toContain('t("settings.syncMode.option.twoway")');
    expect(row).toContain('t("settings.syncMode.option.oneway")');
    expect(row).toContain('"settings.syncMode.hint.twoway"');
    expect(row).toContain('"settings.syncMode.hint.oneway"');
    // 行只承担模式选择：变更即走门槛/关闭弹框，不在这里执行同步。
    expect(row).toContain("applySyncModeSelection(");
    expect(row).not.toContain("startManualSync");
    // 元素级禁止项：三条提醒只属开启弹框，不做成设置页常驻正文。
    expect(row).not.toContain("settings.syncMode.gate.point1");
    expect(row).not.toContain("settings.syncMode.gate.point2");
    expect(row).not.toContain("settings.syncMode.gate.point3");
    expect(row).not.toContain("settings.syncMode.gate.editedCount");
    // 确认后才经设置事务写入；取消／忙碌把下拉拨回（不静默失败）。
    expect(source).toContain("plugin.updateSyncDirection(");
    expect(source).toContain("if (!applied) dropdown.setValue(previous);");
  });

  it("hides the automatic handling group in one-way mode and keeps it reachable in two-way", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    // 片⑦ 随本重构迁移：隐藏谓词从根级「自动处理」行迁到「自动同步」页内分组
    // （2026-10-12；语义不变＝只隐藏、不删除、不改字）。
    const handlingGroup = (plugin: EasySyncPlugin) => {
      const defs = buildSettingDefinitions(t, plugin);
      const page = defs.find((d) =>
        (d as { name?: string }).name === t("settings.autoSync.name")) as {
        items: Array<{ heading?: string; visible?: () => boolean; items?: unknown[] }>;
      };
      return page.items.find((item) =>
        item.heading === t("settings.automaticHandling.name"));
    };

    // 双向：分组可达（visible 为真），规则行＋两条开关行在（只隐藏、不删除定义）。
    const twoWayGroup = handlingGroup(createMockPlugin());
    expect(twoWayGroup).toBeDefined();
    expect(twoWayGroup?.visible?.() ?? true).toBe(true);
    expect(twoWayGroup?.items).toHaveLength(3);

    // 单向：分组不可见；定义与渲染入口仍在（双向即恢复）。
    const oneWay = createMockPlugin();
    (oneWay as unknown as { syncDirection: string }).syncDirection = "one-way";
    const oneWayGroup = handlingGroup(oneWay);
    expect(oneWayGroup).toBeDefined();
    expect(oneWayGroup?.visible?.()).toBe(false);
    expect(oneWayGroup?.items).toHaveLength(3);

    // 旧根级行名不再作为行存在（内容已迁入页面）：防误判为漏登记。
    const rootNames = (buildSettingDefinitions(t, createMockPlugin()) as Array<{
      name?: string;
    }>).map((def) => def.name);
    expect(rootNames).not.toContain(t("settings.automaticHandling.name"));
  });

  it("opens the sync panel from the whole root row, not a button", () => {
    // 2026-11-10 用户反馈：未登录也必须能看到这条出口（不再有可见谓词）。
    const plugin = createMockPlugin();
    const openSyncPanelFromSettings = (plugin as unknown as {
      openSyncPanelFromSettings: ReturnType<typeof vi.fn>;
    }).openSyncPanelFromSettings;
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const root = buildRootSettingDefinitions(t, plugin) as unknown as Array<{
      items?: Array<{
        name?: string;
        visible?: () => boolean;
        render?: (s: never) => void;
      }>;
    }>;
    const actionRow = root[0].items?.find(
      (item) => item.name === t("settings.syncPanel.openRow"),
    );
    expect(actionRow).toBeDefined();
    expect(actionRow?.visible).toBeUndefined();

    const setting = new Setting({} as HTMLElement) as never;
    actionRow!.render!(setting);
    // 整行即按钮：行壳带 role/tabindex/光标类，行尾一枚箭头；不再产出按钮控件。
    const rowEl = (setting as unknown as { settingEl: HTMLElement }).settingEl;
    expect(rowEl.getAttribute("role")).toBe("button");
    expect(rowEl.getAttribute("tabindex")).toBe("0");
    expect(
      (rowEl as unknown as { classList: { contains: (c: string) => boolean } })
        .classList.contains("easy-sync-settings-row-button"),
    ).toBe(true);
    expect(
      (rowEl as unknown as { classList: { contains: (c: string) => boolean } })
        .classList.contains("mod-navigable"),
    ).toBe(true);

    (rowEl as unknown as { onclick: () => void }).onclick();
    expect(openSyncPanelFromSettings).toHaveBeenCalledTimes(1);

    // 键盘 Enter／空格与点击同效（整行＝按钮）。
    const click = vi.fn();
    (rowEl as unknown as { click: () => void }).click = click;
    const keydown = (rowEl as unknown as { onkeydown: (e: KeyboardEvent) => void })
      .onkeydown;
    keydown({ key: "Enter", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    keydown({ key: " ", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("renders the account row without throwing", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const page = buildLoginPage(i18n.t.bind(i18n), plugin);
    const items = (page as { items: Array<{ render?: (s: never) => void }> }).items;
    for (const item of items) {
      if (item.render) {
        const setting = new Setting({} as HTMLElement) as never;
        expect(() => item.render(setting)).not.toThrow();
      }
    }
  });
});

describe("root navigation (2026-11-10 窄列表)", () => {
  const t = new I18n("zh-cn").t.bind(new I18n("zh-cn"));

  const groupsOf = (plugin: EasySyncPlugin) =>
    buildRootSettingDefinitions(t, plugin) as unknown as Array<{
      type?: string;
      cls?: string;
      heading?: string;
      items?: Array<{
        name?: string;
        desc?: string;
        searchable?: boolean;
        items?: unknown[];
      }>;
    }>;

  it("is four heading-less compact navigation groups plus a footer group", () => {
    const groups = groupsOf(createMockPlugin());
    expect(groups).toHaveLength(5);
    expect(groups.every((group) => group.type === "group")).toBe(true);
    // 四组导航都不加外侧标题；前三组是窄条，支持组单独带自己的类；页脚组另一类。
    const navigationGroups = groups.slice(0, 4);
    expect(navigationGroups.every((group) => group.heading === undefined)).toBe(true);
    expect(navigationGroups.slice(0, 3).every((group) => group.cls === "mod-list")).toBe(true);
    expect(navigationGroups[3].cls).toBe(
      "mod-list easy-sync-settings-support-group",
    );
    expect(groups[4].cls).toBe("easy-sync-settings-footer-group");

    const rowNames = navigationGroups.flatMap((group) =>
      (group.items ?? []).map((item) => item.name),
    );
    expect(rowNames).toEqual([
      t("settings.loginPage.name"),
      t("settings.syncPanel.openRow"),
      t("settings.communityPluginsSyncPage.name"),
      t("settings.syncScope.name"),
      t("settings.autoSync.name"),
      t("settings.group.display"),
      t("settings.group.about"),
      t("settings.group.maintenance"),
      t("settings.supportPage.name"),
    ]);
    // 2026-11-10 用户点名：社区插件同步并入下面这组（组①只留登录／动作行）；
    // 组④＝根页最下面的「支持 EasySync」入口。
    expect(navigationGroups.map((group) => (group.items ?? []).map((item) => item.name))).toEqual([
      [t("settings.loginPage.name"), t("settings.syncPanel.openRow")],
      [
        t("settings.communityPluginsSyncPage.name"),
        t("settings.syncScope.name"),
        t("settings.autoSync.name"),
      ],
      [
        t("settings.group.display"),
        t("settings.group.about"),
        t("settings.group.maintenance"),
      ],
      [t("settings.supportPage.name")],
    ]);
    // 导航行都不带说明句（说明只在页内）。
    expect(
      navigationGroups.flatMap((group) => group.items ?? []).every(
        (item) => item.desc === undefined,
      ),
    ).toBe(true);
  });

  it("keeps the footer out of settings search and the navigation row set", () => {
    const groups = groupsOf(createMockPlugin());
    const footer = groups[4];
    expect(footer.items).toHaveLength(1);
    expect(footer.items?.[0].name).toBe(t("settings.footer.navLabel"));
    expect(footer.items?.[0].searchable).toBe(false);
    // 页脚不是导航行：不参与根级图标映射（settings-root-icons 测试同口径）。
    expect(
      groups.slice(0, 4).flatMap((group) => group.items ?? []),
    ).not.toContain(footer.items?.[0]);
  });

  it("builds the Support EasySync page as About-author row, plugin rows, and bottom note", () => {
    const groups = groupsOf(createMockPlugin());
    const supportPage = groups[3].items?.[0] as {
      type?: string;
      name?: string;
      items?: Array<{
        type?: string;
        cls?: string;
        heading?: string;
        items?: Array<{
          name?: string;
          desc?: string;
          searchable?: boolean;
          render?: (setting: never) => void;
        }>;
      }>;
    };
    expect(supportPage.type).toBe("page");
    expect(supportPage.name).toBe(t("settings.supportPage.name"));
    expect(supportPage.items).toHaveLength(3);

    const aboutGroup = supportPage.items?.[0];
    expect(aboutGroup?.type).toBe("group");
    // 与「关于」页同构：普通分组（无 mod-list），行内边距走宿主默认 20px。
    expect(aboutGroup?.cls).toBeUndefined();
    expect(aboutGroup?.items).toHaveLength(1);
    expect(aboutGroup?.items?.[0].name).toBe(
      t("settings.supportPage.about.name"),
    );
    expect(aboutGroup?.items?.[0].desc).toBe(
      t("settings.supportPage.about.desc"),
    );

    const picksGroup = supportPage.items?.[1];
    expect(picksGroup?.type).toBe("group");
    expect(picksGroup?.cls).toBe("mod-list easy-sync-settings-support-picks");
    expect(picksGroup?.heading).toBe(t("settings.supportPage.picksHeading"));
    expect(picksGroup?.items?.map((item) => item.name)).toEqual([
      t("settings.supportPage.resojot.name"),
      t("settings.supportPage.openplug.name"),
    ]);
    expect(picksGroup?.items?.[0].desc).toBe(
      t("settings.supportPage.resojot.desc"),
    );
    expect(picksGroup?.items?.[1].desc).toBe(
      t("settings.supportPage.openplug.desc"),
    );

    const noteGroup = supportPage.items?.[2];
    expect(noteGroup?.type).toBe("group");
    expect(noteGroup?.cls).toBe("easy-sync-settings-support-note-group");
    expect(noteGroup?.items).toHaveLength(1);
    expect(noteGroup?.items?.[0].name).toBe(
      t("settings.supportPage.note"),
    );
    expect(noteGroup?.items?.[0].searchable).toBe(false);

    // 顶部行、两条插件行与页底小字都能在声明式行里渲染。
    for (const item of [
      aboutGroup?.items?.[0],
      picksGroup?.items?.[0],
      picksGroup?.items?.[1],
      noteGroup?.items?.[0],
    ]) {
      const setting = new Setting({} as HTMLElement) as never;
      expect(() => item!.render!(setting)).not.toThrow();
    }
  });

  it("builds the four footer links with language-aware docs", () => {
    const zh = getSettingsFooterLinks(t, "zh-cn");
    expect(zh.map((link) => link.label)).toEqual([
      t("settings.footer.docs"),
      t("settings.footer.changelog"),
      t("settings.footer.feedback"),
      t("settings.footer.contact"),
    ]);
    expect(zh.map((link) => link.url)).toEqual([
      "https://github.com/jiaoyingxing/easy-sync/blob/main/README.md",
      "https://github.com/jiaoyingxing/easy-sync/releases",
      "https://github.com/jiaoyingxing/easy-sync/issues/new",
      "https://www.xiaohongshu.com/user/profile/605dfc23000000000101cfdb",
    ]);
    // 2026-11-10 用户确认中文口径：License 写「许可证」，不中英混排。
    expect(t("settings.footer.license")).toBe("以 MIT 许可证开源");

    const enI18n = new I18n("en");
    const en = getSettingsFooterLinks(enI18n.t.bind(enI18n), "en");
    expect(en.map((link) => link.label)).toEqual([
      "Docs", "Changelog", "Feedback", "Contact",
    ]);
    expect(en[0].url).toContain("README-en.md");
  });

  it("moves the community-plugin rows out of the scope page into their own page", () => {
    const groups = groupsOf(createMockPlugin());
    const communityPage = groups[1].items?.find(
      (item) => item.name === t("settings.communityPluginsSyncPage.name"),
    ) as { items?: Array<{ name?: string }> } | undefined;
    // 2026-11-10 规则也随板块拆：新页首行是社区插件板块自己的「规则」。
    expect(communityPage?.items?.map((item) => item.name)).toEqual([
      t("settings.rules.name"),
      t("settings.syncCommunityPlugins.name"),
      t("settings.syncPluginData.name"),
    ]);

    // 同步范围页不再有这两行（2026-11-10 用户点名拆出）。
    const scopePage = groups[1].items?.find(
      (item) => item.name === t("settings.syncScope.name"),
    );
    const namesInScope: string[] = [];
    const walk = (node: unknown): void => {
      const typed = node as { name?: string; items?: unknown[] };
      if (typed.name) namesInScope.push(typed.name);
      if (Array.isArray(typed.items)) typed.items.forEach(walk);
    };
    walk(scopePage);
    expect(namesInScope).not.toContain(t("settings.syncCommunityPlugins.name"));
    expect(namesInScope).not.toContain(t("settings.syncPluginData.name"));
  });
});

describe("declarative reset button", () => {
  function findResetItem(defs: ReturnType<typeof buildSettingDefinitions>) {
    const walk = (def: unknown): Array<{
      name?: string;
      render?: (s: never) => void;
    }> => {
      const typed = def as { type?: string; items?: unknown[]; render?: (s: never) => void };
      // 页面与分组都是容器：`items` 非空即继续下钻。
      if (Array.isArray(typed.items)) {
        return typed.items.flatMap((item) => walk(item));
      }
      return typed.render ? [typed as { name?: string; render?: (s: never) => void }] : [];
    };
    const i18n = new I18n("zh-cn");
    const items = defs.flatMap((def) => walk(def));
    return items.find((i) => i.name === i18n.t("settings.reset.name"));
  }

  it("applies the destructive mod-warning style to the reset button", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const resetItem = findResetItem(defs);
    expect(resetItem).toBeDefined();

    const setting = new Setting({} as HTMLElement) as never;
    const addClass = vi.fn();
    const btn = new ButtonComponent({} as HTMLElement) as unknown as {
      buttonEl: { classList: { add: (c: string) => void } };
      setButtonText: (t: string) => unknown;
      onClick: (cb: () => void | Promise<void>) => unknown;
    };
    (btn as unknown as { buttonEl: unknown }).buttonEl = { classList: { add: addClass } };
    let clickHandler: (() => void | Promise<void>) | null = null;
    btn.setButtonText = (() => btn) as never;
    btn.onClick = ((cb: () => void | Promise<void>) => { clickHandler = cb; return btn; }) as never;
    vi.spyOn(setting as never, "addButton").mockImplementation(
      (cb: (b: unknown) => void) => { cb(btn); return setting; },
    );
    resetItem!.render!(setting);

    expect(addClass).toHaveBeenCalledWith("mod-warning");
  });

  it("calls resetSyncState only after the confirm modal is accepted", async () => {
    const plugin = createMockPlugin();
    const resetSyncState = vi.fn().mockResolvedValue(undefined);
    (plugin as unknown as { resetSyncState: unknown }).resetSyncState = resetSyncState;
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const resetItem = findResetItem(defs);

    const setting = new Setting({} as HTMLElement) as never;
    const btn = new ButtonComponent({} as HTMLElement) as unknown as {
      buttonEl: { classList: { add: (c: string) => void } };
      setButtonText: (t: string) => unknown;
      onClick: (cb: () => void | Promise<void>) => unknown;
    };
    (btn as unknown as { buttonEl: unknown }).buttonEl = { classList: { add: () => undefined } };
    let clickHandler: (() => void | Promise<void>) | null = null;
    btn.setButtonText = (() => btn) as never;
    btn.onClick = ((cb: () => void | Promise<void>) => { clickHandler = cb; return btn; }) as never;
    vi.spyOn(setting as never, "addButton").mockImplementation(
      (cb: (b: unknown) => void) => { cb(btn); return setting; },
    );
    resetItem!.render!(setting);

    // Accepted confirm -> reset runs.
    confirmResult.value = true;
    await clickHandler!();
    expect(resetSyncState).toHaveBeenCalledTimes(1);

    // Cancelled confirm -> reset does not run.
    confirmResult.value = false;
    await clickHandler!();
    expect(resetSyncState).toHaveBeenCalledTimes(1);
  });
});

describe("declarative completeness", () => {
  function pageItems(
    defs: ReturnType<typeof buildSettingDefinitions>,
    pageName: string,
  ): Array<{
    name?: string;
    desc?: string;
    visible?: () => boolean;
    render?: (s: never) => void;
  }> {
    const page = defs.find((d) => (d as { name?: string }).name === pageName) as
      | { items?: Array<{ name?: string; desc?: string; visible?: () => boolean; render?: (s: never) => void }> }
      | undefined;
    return page?.items ?? [];
  }

  it("renders the auto sync master row with one toggle and no modal-entry button", () => {
    const i18n = new I18n("zh-cn");
    ToggleComponent.instances.length = 0;
    const plugin = createMockPlugin();
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const row = pageItems(defs, i18n.t("settings.autoSync.name"))
      .find((i) => i.name === i18n.t("settings.autoSync.name"));
    expect(row).toBeDefined();
    const setting = new Setting({} as HTMLElement) as never;
    const addButton = vi.spyOn(setting as never, "addButton");
    row!.render!(setting);
    // 1.13+ 不再以弹框承载自动同步：页内是开关＋两条滑条行，没有齿轮入口。
    expect(addButton).not.toHaveBeenCalled();
    expect(ToggleComponent.instances).toHaveLength(1);
  });

  it("derives the auto sync master toggle from the enabled channels", async () => {
    const i18n = new I18n("zh-cn");
    ToggleComponent.instances.length = 0;

    const onPlugin = createMockPlugin();
    onPlugin.syncInterval = 0;
    onPlugin.autoSyncChangeDelaySeconds = 5;
    // The master is on because the change trigger alone is enabled; the row's
    // toggle must read the derived state, not the scheduled interval.
    expect(onPlugin.isAutoSyncMasterEnabled()).toBe(true);

    const offPlugin = createMockPlugin();
    offPlugin.syncInterval = 0;
    offPlugin.autoSyncChangeDelaySeconds = 0;
    offPlugin.autoSyncOnStartup = false;
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), offPlugin);
    const autoSync = pageItems(defs, i18n.t("settings.autoSync.name"))
      .find((i) => i.name === i18n.t("settings.autoSync.name"));
    expect(offPlugin.isAutoSyncMasterEnabled()).toBe(false);

    // Flipping the master toggle routes through the plugin's master switch.
    const setting = new Setting({} as HTMLElement) as never;
    autoSync!.render!(setting);
    const toggle = ToggleComponent.instances.at(-1);
    expect(toggle?.value).toBe(false);
    await toggle?.triggerChange(true);
    expect(offPlugin.setAutoSyncMasterEnabled).toHaveBeenCalledWith(true);
  });

  it("includes the about page with product, author and feedback entries", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = pageItems(defs, i18n.t("settings.group.about"));
    expect(items.some((i) => i.name === i18n.t("settings.about.product.name"))).toBe(true);
    expect(items.some((i) => i.name === i18n.t("settings.about.author.name"))).toBe(true);
    expect(items.some((i) => i.name === i18n.t("settings.about.feedback.name"))).toBe(true);
    // Author row carries the name only; usage/contact guidance lives in the
    // feedback row below it.
    const author = items.find((i) => i.name === i18n.t("settings.about.author.name"));
    expect(author?.desc).not.toContain("使用中遇到问题");
    const feedback = items.find((i) => i.name === i18n.t("settings.about.feedback.name"));
    expect(feedback?.desc).toContain("使用中遇到问题");
  });

  it("shows the update chip and button on the product row only when an update is available", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = pageItems(defs, i18n.t("settings.group.about"));
    const product = items.find((i) => i.name === i18n.t("settings.about.product.name"));

    // No update -> the row stays plain: no chip span, no button.
    const plain = new Setting({} as HTMLElement) as never;
    const plainSpans: string[] = [];
    const plainNameEl = (plain as unknown as { nameEl: HTMLElement }).nameEl;
    (plainNameEl as unknown as { createSpan: (cls?: string) => unknown }).createSpan =
      (cls?: string) => {
        plainSpans.push(cls ?? "");
        return {} as unknown;
      };
    const plainAddButton = vi.spyOn(plain as never, "addButton").mockReturnValue(plain as never);
    product!.render!(plain);
    expect(plainSpans).toHaveLength(0);
    expect(plainAddButton).not.toHaveBeenCalled();

    // Update available -> 「新版本」 chip on the name; the button hands off to
    // the host plugin page via openUpdatePage().
    (plugin as unknown as { getUpdatePromptState: () => unknown }).getUpdatePromptState =
      () => ({ latest: "1.5.5", current: "1.5.4" });
    const withUpdate = new Setting({} as HTMLElement) as never;
    const chip: {
      classList: { contains: (t: string) => boolean };
      textContent?: string;
      setText: (v: string) => void;
    } = {
      classList: { contains: () => false },
      setText(v: string) {
        this.textContent = v;
      },
    };
    const withNameEl = (withUpdate as unknown as { nameEl: HTMLElement }).nameEl;
    (withNameEl as unknown as { createSpan: (cls?: string) => unknown }).createSpan =
      (cls?: string) => {
        chip.classList.contains = (token: string) => token === cls;
        return chip as unknown;
      };
    let clickHandler: (() => void) | null = null;
    let buttonText = "";
    vi.spyOn(withUpdate as never, "addButton").mockImplementation(
      (cb: (b: unknown) => void) => {
        const btn = {
          setButtonText: (label: string) => {
            buttonText = label;
            return btn;
          },
          onClick: (h: () => void) => {
            clickHandler = h;
          },
        };
        cb(btn);
        return withUpdate;
      },
    );
    product!.render!(withUpdate);
    expect(chip.classList.contains("easy-sync-plugin-selection-chip")).toBe(true);
    // 定稿文案（2026-10-02 用户拍板）：存在句，不与版本标签混淆。
    expect(chip.textContent).toBe("有新版本");
    expect(chip.textContent).toBe(i18n.t("updateCheck.chip"));
    expect(buttonText).toBe(i18n.t("settings.about.updateNow"));
    clickHandler!();
    expect(plugin.openUpdatePage).toHaveBeenCalledTimes(1);
  });
});

describe("declarative local-only reversal row (件③)", () => {
  interface ReversalItemRecord {
    name?: string;
    desc?: string;
    visible?: () => boolean;
    render?: (s: never) => void;
    items?: unknown[];
  }
  function findReversalItem(
    defs: ReturnType<typeof buildSettingDefinitions>,
  ): ReversalItemRecord | undefined {
    const i18n = new I18n("zh-cn");
    const page = defs.find((d) =>
      (d as { name?: string }).name === i18n.t("settings.group.maintenance")) as
      | { items?: ReversalItemRecord[] }
      | undefined;
    // 2026-10-20 起件③ 收进「高级」组，不再位于页顶层：递归下钻分组找行。
    const stack = [...(page?.items ?? [])];
    while (stack.length > 0) {
      const item = stack.shift();
      if (item?.name === i18n.t("settings.localOnlyIgnored.name")) return item;
      if (item && Array.isArray(item.items)) stack.unshift(...item.items);
    }
    return undefined;
  }

  it("stays hidden in two-way mode and appears with the live count in one-way mode", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);

    // 双向：定义在（1.13+ 搜索可见），但行不该出现——忽略记忆在双向不生效。
    const twoWay = createMockPlugin();
    const twoWayItem = findReversalItem(buildSettingDefinitions(t, twoWay));
    expect(twoWayItem).toBeDefined();
    expect(twoWayItem?.visible?.()).toBe(false);

    // 单向但没有被忽略的条目：保持零动作干净态。
    const empty = createMockPlugin();
    (empty as unknown as { syncDirection: string }).syncDirection = "one-way";
    const emptyItem = findReversalItem(buildSettingDefinitions(t, empty));
    expect(emptyItem?.visible?.()).toBe(false);

    // 单向且有被忽略的条目：出现，说明带计数。
    const oneWay = createMockPlugin();
    (oneWay as unknown as { syncDirection: string }).syncDirection = "one-way";
    (oneWay as unknown as { getIgnoredLocalOnlyCount: () => number })
      .getIgnoredLocalOnlyCount = () => 6;
    const item = findReversalItem(buildSettingDefinitions(t, oneWay));
    expect(item?.visible?.()).toBe(true);
    expect(item?.desc).toBe(
      t("settings.localOnlyIgnored.desc", { count: 6 }),
    );
  });

  it("wires the button to clearing the ignore memory and refreshing the host", async () => {
    const plugin = createMockPlugin();
    (plugin as unknown as { syncDirection: string }).syncDirection = "one-way";
    (plugin as unknown as { getIgnoredLocalOnlyCount: () => number })
      .getIgnoredLocalOnlyCount = () => 3;
    const clearLocalOnlyIgnores = plugin.clearLocalOnlyIgnores as unknown as
      ReturnType<typeof vi.fn>;
    const i18n = new I18n("zh-cn");
    const refresh = vi.fn();
    const item = findReversalItem(
      buildSettingDefinitions(i18n.t.bind(i18n), plugin, refresh),
    );
    expect(item?.render).toBeDefined();

    const setting = new Setting({} as HTMLElement) as never;
    let clickHandler: (() => void | Promise<void>) | null = null;
    let buttonText = "";
    vi.spyOn(setting as never, "addButton").mockImplementation(
      (cb: (b: unknown) => void) => {
        const btn = {
          setButtonText: (label: string) => {
            buttonText = label;
            return btn;
          },
          onClick: (handler: () => void | Promise<void>) => {
            clickHandler = handler;
            return btn;
          },
        };
        cb(btn);
        return setting;
      },
    );
    item!.render!(setting);

    expect(buttonText).toBe(i18n.t("settings.localOnlyIgnored.button"));
    await clickHandler!();
    // 点击＝清空忽略记忆（不并入重置）＋宿主重画（行随计数退场）。
    expect(clearLocalOnlyIgnores).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
