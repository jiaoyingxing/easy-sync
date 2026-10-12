import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Setting, ButtonComponent, ToggleComponent } from "./__mocks__/obsidian";
import {
  buildAccountSettingDefinitions,
  buildSettingDefinitions,
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
    notificationPopups: "all",
    mobileStatusBar: true,
    diagLogEnabled: false,
    syncDirection: "two-way",
    autoSyncPaused: false,
    isAutoSyncMasterEnabled: function (
      this: { syncInterval: number; autoSyncChangeDelaySeconds: number },
    ): boolean {
      return this.syncInterval > 0 || this.autoSyncChangeDelaySeconds > 0;
    },
    setAutoSyncMasterEnabled: vi.fn().mockResolvedValue(undefined),
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
      t("settings.syncCommunityPlugins.name"),
      t("settings.syncPluginData.name"),
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
      // 件③ 反转入口：定义树里常备一行（单向且计数 > 0 才 visible），本桩为
      // 双向模式，所以渲染时隐藏、行名仍在登记表里。
      t("settings.localOnlyIgnored.name"),
      t("settings.reset.name"),
    ]);
    // 全案只有两个分组标题（每页第一分组不加标题，2026-10-12 拍板）。
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

    // 规则按板块拆分（不合并）：排除板块＝排除语义句；内容板块＝跨设备事实句。
    expect(scopeItems[0].desc).toBe(t("settings.syncExclusion.intro"));
    const contentGroup = scopeItems[3] as {
      heading?: string;
      items?: Array<{ name?: string; desc?: string }>;
    };
    expect(contentGroup.heading).toBe(t("settings.syncContent.heading"));
    expect(contentGroup.items?.[0].desc).toBe(t("settings.syncScope.intro"));
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

  it("surfaces one description and at most one displayValue per root entry (S3 口径)", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const rowsOf = (plugin: EasySyncPlugin) =>
      buildSettingDefinitions(t, plugin) as unknown as Array<{
        desc?: string;
        displayValue?: string;
        status?: string;
      }>;

    // 同步范围：无排除＝留空（不下发 displayValue）；有排除＝「排除 {n} 项」。
    const bareRows = rowsOf(createMockPlugin());
    expect(bareRows[0].desc).toBe(t("settings.rootNav.scope.desc"));
    expect(bareRows[0].displayValue).toBeUndefined();
    const withExclusions = createMockPlugin();
    (withExclusions as unknown as { excludedFolders: string[] }).excludedFolders =
      ["Private/日记"];
    const rows = rowsOf(withExclusions);
    expect(rows[0].displayValue).toBe(
      t("settings.rootNav.value.excluded", { count: 1 }),
    );

    // 自动同步：派生态（mock 默认 interval=3 ⇒ 已开启）。
    expect(rows[1].desc).toBe(t("settings.rootNav.autoSync.desc"));
    expect(rows[1].displayValue).toBe(t("settings.rootNav.value.autoSyncOn"));
    const off = createMockPlugin();
    off.syncInterval = 0;
    off.autoSyncChangeDelaySeconds = 0;
    expect(rowsOf(off)[1].displayValue).toBe(t("settings.rootNav.value.autoSyncOff"));

    // 显示：档位词（复用现役选项词）；维护：留空。
    expect(rows[2].desc).toBe(t("settings.rootNav.display.desc"));
    expect(rows[2].displayValue).toBe(t("settings.notificationPopups.option.all"));
    expect(rows[4].desc).toBe(t("settings.rootNav.maintenance.desc"));
    expect(rows[4].displayValue).toBeUndefined();

    // 关于：无新版＝版本号（无角标）；有新版＝「有新版本」＋ warning 角标。
    expect(rows[3].desc).toBe(t("settings.rootNav.about.desc"));
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

describe("buildAccountSettingDefinitions", () => {
  it("always includes the account/login row", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);

    expect((group as { type?: string }).type).toBe("group");
    const items = (group as { items: Array<{ name?: string }> }).items;
    // 片⑥ 起账号组为三行：账号行、同步模式行、同步面板行。
    expect(items.length).toBe(3);
    expect(items[0].name).toBe(i18n.t("settings.account.name"));
    expect(items[1].name).toBe(i18n.t("settings.syncMode.name"));
    expect(items[2].name).toBe(i18n.t("settings.syncPanel.name"));
  });

  it("hides the sync-panel row until the user is signed in", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = (group as {
      items: Array<{ name?: string; visible?: () => boolean }>;
    }).items;
    const syncItem = items.find((i) => i.name === i18n.t("settings.syncPanel.name"));
    expect(syncItem).toBeDefined();
    // Logged out: the entry must not render (mirrors renderAccountSection).
    expect(syncItem?.visible?.()).toBe(false);
  });

  it("hides the sync-mode row until the user is signed in", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = (group as {
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

  it("renders the sync-mode row from one shared implementation in both paths", () => {
    const source = readFileSync("src/ui/settings-tab.ts", "utf8");
    // 定义一处＋命令式与声明式各调用一处（双路同改，不补声明式则 1.13+ 搜索不到）。
    expect(source.split("renderSyncModeRow(").length - 1).toBe(3);
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

  it("opens the sync panel from the signed-in entry row", async () => {
    const plugin = createMockPlugin();
    (plugin.auth as unknown as {
      authState: { isLoggedIn: boolean; displayName?: string };
    }).authState.isLoggedIn = true;
    const openSyncPanelFromSettings = (plugin as unknown as {
      openSyncPanelFromSettings: ReturnType<typeof vi.fn>;
    }).openSyncPanelFromSettings;
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = (group as {
      items: Array<{
        name?: string;
        visible?: () => boolean;
        render?: (s: never) => void;
      }>;
    }).items;
    const syncItem = items.find((i) => i.name === i18n.t("settings.syncPanel.name"));
    expect(syncItem?.visible?.()).toBe(true);

    const setting = new Setting({} as HTMLElement) as never;
    let clickHandler: (() => void | Promise<void>) | null = null;
    const btn = new ButtonComponent({} as HTMLElement) as unknown as {
      buttonEl: unknown;
      setButtonText: (t: string) => unknown;
      onClick: (cb: () => void | Promise<void>) => unknown;
    };
    btn.buttonEl = { classList: { add: () => undefined } };
    btn.setButtonText = (() => btn) as never;
    btn.onClick = ((cb: () => void | Promise<void>) => { clickHandler = cb; return btn; }) as never;
    vi.spyOn(setting as never, "addButton").mockImplementation(
      (cb: (b: unknown) => void) => { cb(btn); return setting; },
    );
    syncItem!.render!(setting);

    await clickHandler!();
    expect(openSyncPanelFromSettings).toHaveBeenCalledTimes(1);
  });

  it("renders the account row without throwing", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = (group as { items: Array<{ render?: (s: never) => void }> }).items;
    for (const item of items) {
      if (item.render) {
        const setting = new Setting({} as HTMLElement) as never;
        expect(() => item.render(setting)).not.toThrow();
      }
    }
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

describe("declarative completeness vs display()", () => {
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

  it("registers every legacy display() row name in the definition tree", () => {
    // 防双轨漂移（判据取行名、不取实现函数名）：<1.13 display() 渲染的每一行，
    // 其行名必须在定义树登记；有意移除项显式登记理由，反向不报。
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const plugin = createMockPlugin();
    const defs = [
      buildAccountSettingDefinitions(t, plugin),
      ...buildSettingDefinitions(t, plugin),
    ];
    const treeNames: string[] = [];
    const walk = (def: unknown): void => {
      const typed = def as { name?: string; items?: unknown[] };
      if (typed.name) treeNames.push(typed.name);
      (typed.items ?? []).forEach((item) => walk(item));
    };
    defs.forEach((def) => walk(def));

    const legacyRowNames = [
      t("settings.account.name"),
      t("settings.syncMode.name"),
      t("settings.syncPanel.name"),
      t("settings.syncScope.name"),
      t("settings.syncExclusion.name"),
      t("settings.automaticHandling.name"),
      t("settings.autoSync.name"),
      t("settings.notificationPopups.name"),
      t("settings.about.product.name"),
      t("settings.about.author.name"),
      t("settings.about.feedback.name"),
      t("settings.diagLog.name"),
      t("settings.diagReport.name"),
      t("settings.reset.name"),
    ];
    // 有意移除（不复现为行）：内容已迁入页面／分组（2026-10-11 拍板）。
    const intentionalRemovals = [
      t("settings.syncExclusion.name"), // 内容＝同步范围页顶部的两行＋chips
      t("settings.automaticHandling.name"), // 内容＝自动同步页「自动处理」分组的两个开关
    ];
    const missing = legacyRowNames.filter(
      (name) => !treeNames.includes(name) && !intentionalRemovals.includes(name),
    );
    expect(missing).toEqual([]);
    // 反向不报：定义树里的新面（规则／同步内容）不要求旧路径有对应行。
    expect(treeNames).toContain(t("settings.rules.name"));
  });

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
  function findReversalItem(defs: ReturnType<typeof buildSettingDefinitions>) {
    const i18n = new I18n("zh-cn");
    const page = defs.find((d) =>
      (d as { name?: string }).name === i18n.t("settings.group.maintenance")) as
      | {
        items?: Array<{
          name?: string;
          desc?: string;
          visible?: () => boolean;
          render?: (s: never) => void;
        }>;
      }
      | undefined;
    return page?.items?.find(
      (item) => item.name === i18n.t("settings.localOnlyIgnored.name"),
    );
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
