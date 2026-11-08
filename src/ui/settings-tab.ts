/**
 * EasySync Settings Tab
 *
 * Declarative settings for Obsidian 1.13+（minAppVersion 1.13.4）：宿主从
 * `getSettingDefinitions()` 渲染整页，`display()` 不会被调用。布局按
 * 2026-10-11 拍板的根级导航结构：
 *   - 账号组（登录、同步模式、同步面板入口；无标题）
 *   - 五个入口页：同步范围 / 自动同步 / 显示 / 关于 / 维护
 */

import {
  ButtonComponent,
  Notice,
  PluginSettingTab,
  setIcon,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
} from "obsidian";
import type EasySyncPlugin from "../main";
import {
  hostPlatformFacts,
  type HostPlatformFacts,
} from "../obsidian-compat";
import {
  handleAuthEntryAction,
  resolveAuthEntryPresentation,
} from "./auth-entry-flow";
import { buildIntroTextWithInlineGear } from "./config-sync-modal";
import { ConfirmModal, type I18nFn } from "./confirm-modal";
import { SyncModeDisableModal } from "./sync-mode-disable-modal";
import { SyncModeGateModal } from "./sync-mode-gate-modal";
import { syncModeGateInputLiteral } from "../sync/sync-mode-transition";
import type { SyncDirection } from "../sync/sync-direction";
import {
  SETTINGS_TAB_ICON,
  decorateSettingsRootRowIcons,
} from "./settings-root-icons";
import {
  applyAutoSyncChangeDelayRow,
  applyAutoSyncOnStartupRow,
  applyAutomaticHandlingRow,
  applyCommunityPluginScopeRow,
  applyExcludedFoldersRow,
  applyLocalOnlyIgnoredRow,
  applyMaxFileSizeRow,
  applyMobileStatusBarRow,
  applyNotificationPopupsRow,
  applyScopeToggleRow,
  applySyncIntervalRow,
  type ScopeToggleRowConfig,
  type SettingsPageRowHost,
} from "./settings-page-rows";

const GITHUB_URL = "https://github.com/jiaoyingxing/easy-sync";
const XHS_URL = "https://xhslink.com/m/57v8xzlVMKp";

/**
 * Contact button for the About card: rebuilds the default text-only button
 * content as icon + label spans on one line. Label doubles as tooltip and
 * aria-label.
 */
function configureAboutContactButton(
  button: ButtonComponent,
  options: {
    label: string;
    icon: string;
    url: string;
    extraClassName?: string;
  },
): void {
  button.setClass("easy-sync-settings-about-contact-button");
  button.setTooltip(options.label);
  button.buttonEl.setAttribute("aria-label", options.label);
  button.onClick(() => {
    window.open(options.url, "_blank", "noopener,noreferrer");
  });
  button.buttonEl.empty();
  if (options.extraClassName) {
    button.buttonEl.addClass(options.extraClassName);
  }
  const iconEl = button.buttonEl.createSpan({
    cls: "easy-sync-settings-about-contact-button-icon",
  });
  setIcon(iconEl, options.icon);
  button.buttonEl.createSpan({
    cls: "easy-sync-settings-about-contact-button-label",
    text: options.label,
  });
}

/**
 * 「新版本」chip + update button on the About product row. Visibility follows
 * the shared update-prompt state (single source of truth, snooze-aware); the
 * action hands off to the host plugin page — the plugin never self-installs.
 */
function renderAboutUpdateAffordance(
  setting: Setting,
  t: I18nFn,
  plugin: EasySyncPlugin,
): void {
  const hasUpdate = !!plugin.getUpdatePromptState();
  // chip 与行名文字之间靠 nameEl 的 flex+gap 留距（与社区插件行同款容器）；
  // 该类随 chip 同生命周期挂摘，无新版时 nameEl 保持原生布局。
  setting.nameEl.toggleClass("easy-sync-settings-name-with-chip", hasUpdate);
  if (!hasUpdate) return;
  // update() 会重跑行渲染回调但不重建行节点：先清掉本行上一次的 chip，
  // 避免重复追加（Resojot 1.13.7 实测同型）。
  setting.nameEl
    .querySelectorAll(":scope > .easy-sync-plugin-selection-chip")
    .forEach((el) => el.remove());
  setting.nameEl
    .createSpan("easy-sync-plugin-selection-chip")
    .setText(t("updateCheck.chip"));
  setting.addButton((btn) => {
    btn.setButtonText(t("settings.about.updateNow")).onClick(() => {
      plugin.openUpdatePage();
    });
  });
}

export class EasySyncSettingTab extends PluginSettingTab {
  plugin: EasySyncPlugin;
  /** 1.13+ 根级导航行图标的补挂观察器（宿主重建根行后自动补）。 */
  private rootRowIconObserver: MutationObserver | null = null;

  constructor(
    plugin: EasySyncPlugin,
    /** Platform facts for mobile-only rows; tests inject a fake, production
     *  keeps the live `Platform`-backed default. */
    private readonly platformFacts: HostPlatformFacts = hostPlatformFacts,
  ) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    // Tab-level class must be applied at construction time: the host renders
    // declaratively and never calls display().
    this.containerEl.addClass("easy-sync-settings-tab");
    // 设置窗左栏本插件那一行的图标（宿主只在页签 icon 非空时建该元素；第三方
    // 插件整栏被宿主隐藏，由 styles.css 只放开我们自己那一行）。
    this.icon = SETTINGS_TAB_ICON;
    this.observeRootRowIcons();
  }

  refreshAuthState(): void {
    // 声明式页签的刷新一律走宿主 update()：重跑 getSettingDefinitions() 并
    // 重渲染每行回调（登录态、模式行、面板入口行都由可见谓词重估）。
    this.update();
  }

  /**
   * Declarative setting index consumed by the host settings renderer.
   *
   * The host renders the whole tab from these definitions and never calls
   * display(), so this list must cover the account/login/sync-action area as
   * well as the five entry pages. Rows render through `SettingDefinitionRender`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    // 1.13+ 根级＝纯导航（2026-10-11 拍板）：账号组（含模式行）＋「同步范围／
    // 自动同步」入口组＋「显示／关于／维护」入口组；无标题轻分组，页面语义由
    // 入口行与页内「规则」行承接，根级零内联设置。
    const [scopePage, autoSyncPage, displayPage, aboutPage, maintenancePage] =
      buildSettingDefinitions(
        t,
        this.plugin,
        () => this.refreshSyncState(),
        () => this.noteExclusionChange(),
        this.platformFacts,
      );
    return [
      buildAccountSettingDefinitions(t, this.plugin),
      { type: "group", items: [scopePage, autoSyncPage] },
      { type: "group", items: [displayPage, aboutPage, maintenancePage] },
    ];
  }

  /**
   * 排除项变更的计划重算时机：设置页没有「关闭」，改在设置窗关闭（`hide()`）
   * 时统一收口；只有改过且有在途审阅才重算。代价如实记：桌面设置窗可长期
   * 开着，重算窗口较长（2026-10-12 决策，方案单 §八）。
   */
  private exclusionEditSession: SyncExclusionEditSession | null = null;

  private noteExclusionChange(): void {
    this.exclusionEditSession ??= new SyncExclusionEditSession(
      this.plugin.state?.planReviewActive ?? false,
    );
    this.exclusionEditSession.markSavedChange();
  }

  private flushExclusionChanges(): void {
    const session = this.exclusionEditSession;
    this.exclusionEditSession = null;
    if (!session) return;
    void (async () => {
      try {
        await session.close(() => this.plugin.rebuildPlanReview());
      } catch (error) {
        this.plugin.diag.warn(
          "state",
          "failed to recalculate the sync plan after exclusions changed",
          error,
        );
      }
    })();
  }

  refreshSyncState(): void {
    // 与 refreshAuthState 同一刷新路径；件③ 反转入口的出现/退场与说明里的
    // 计数也靠宿主重渲染重估（单向模式下逐条或批量忽略后立刻生效）。
    this.update();
  }

  hide(): void {
    super.hide();
    this.flushExclusionChanges();
  }

  /**
   * 1.13+ 根级导航行的行首图标补挂。
   *
   * 宿主进子页再返回会重建根行、`update()` 不重建（1.14.4 实测），所以盯
   * `containerEl` 的 DOM 变化同步补挂；**不用 rAF 合帧**——设置窗在前台时主窗
   * `document.hidden === true`，rAF 实测不触发。装饰只遍历容器内的
   * `.setting-item`（根级 ≤8 行）且幂等，成本可忽略。
   */
  private observeRootRowIcons(): void {
    this.rootRowIconObserver = new MutationObserver(() => {
      this.decorateRootRowIcons();
    });
    this.rootRowIconObserver.observe(this.containerEl, {
      attributes: false,
      childList: true,
      characterData: false,
      subtree: true,
    });
    this.plugin.register(() => {
      this.rootRowIconObserver?.disconnect();
      this.rootRowIconObserver = null;
    });
  }

  private decorateRootRowIcons(): void {
    decorateSettingsRootRowIcons(
      this.containerEl,
      this.plugin.i18n.t.bind(this.plugin.i18n),
    );
  }
}

/**
 * 排除项编辑会话：记录「本次设置窗开着期间有没有已落盘的排除项变更」与变更
 * 发生时是否已有在途审阅，`close()` 时据此决定要不要重算同步计划。原来挂在
 * 弹框关闭时机上，设置页时代随 `hide()` 统一收口。
 */
export class SyncExclusionEditSession {
  private savedChange = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly hadPendingReview: boolean) {}

  markSavedChange(): void {
    this.savedChange = true;
  }

  close(recalculate: () => Promise<void>): Promise<void> {
    this.closePromise ??=
      this.savedChange && this.hadPendingReview
        ? recalculate()
        : Promise.resolve();
    return this.closePromise;
  }
}

/**
 * 片⑥ 同步模式行（声明式账号组唯一实现）。
 *
 * 只承担模式选择：下拉改变即走门槛/关闭弹框，确认后才经设置事务写入；
 * 取消或忙碌（返回 false）就把下拉拨回当前模式。逐字使用文案稿
 * `settings.syncMode.*`（含每个选项的说明句）。
 */
export function renderSyncModeRow(
  setting: Setting,
  t: I18nFn,
  plugin: EasySyncPlugin,
): void {
  const hintEl = setting.descEl.createDiv({
    cls: "easy-sync-sync-mode-hint",
  });
  const renderHint = (): void => {
    hintEl.setText(
      t(plugin.syncDirection === "one-way"
        ? "settings.syncMode.hint.oneway"
        : "settings.syncMode.hint.twoway"),
    );
  };
  setting
    .setName(t("settings.syncMode.name"))
    .addDropdown((dropdown) => {
      dropdown
        .addOption("two-way", t("settings.syncMode.option.twoway"))
        .addOption("one-way", t("settings.syncMode.option.oneway"))
        .setValue(plugin.syncDirection)
        .onChange(async (value) => {
          const previous = plugin.syncDirection;
          const next: SyncDirection =
            value === "one-way" ? "one-way" : "two-way";
          const applied = await applySyncModeSelection(plugin, t, next);
          // 取消／忙碌／写入失败：下拉拨回当前模式（不静默失败）。
          if (!applied) dropdown.setValue(previous);
          renderHint();
        });
    });
  renderHint();
}

/**
 * 片⑥ 模式选择：先弹对应告知弹框（开启＝手输门槛；关闭＝数量告知），
 * 确认后走 `plugin.updateSyncDirection` 的设置事务。返回 false＝未生效
 * （取消／忙碌／写入失败），调用方把下拉拨回。
 */
async function applySyncModeSelection(
  plugin: EasySyncPlugin,
  t: I18nFn,
  next: SyncDirection,
): Promise<boolean> {
  if (next === plugin.syncDirection) return true;
  const operationEpoch = plugin.captureOperationEpoch();
  if (next === "one-way") {
    const counts = await plugin.getSyncModeGateCounts();
    const confirmed = await new SyncModeGateModal(
      plugin.app,
      t,
      counts,
      syncModeGateInputLiteral(plugin.i18n.language),
    ).awaitDecision();
    if (!confirmed) return false;
  } else {
    const confirmed = await new SyncModeDisableModal(
      plugin.app,
      t,
      plugin.getSyncModeDisableCounts(),
    ).awaitDecision();
    if (!confirmed) return false;
  }
  try {
    return await plugin.updateSyncDirection(next, operationEpoch);
  } catch {
    new Notice(t("notice.settingsSaveFailed"));
    return false;
  }
}

/**
 * Build the unheaded account/login group for the declarative setting index.
 * The account row is always visible; the sync-mode and sync-panel rows only
 * appear after sign-in.
 */
export function buildAccountSettingDefinitions(
  t: I18nFn,
  plugin: EasySyncPlugin,
): SettingDefinitionItem {
  const auth = plugin.auth;
  const authEntry = resolveAuthEntryPresentation({
    isInitializing: auth?.isInitializing ?? false,
    isPending: auth?.isPending ?? false,
    isDevicePending: (auth?.deviceAttempt ?? null) !== null,
  });
  return {
    type: "group",
    items: [
      {
        name: t("settings.account.name"),
        desc: auth?.isSessionPending
          ? t("settings.account.desc.connecting")
          : auth?.authState.isLoggedIn
            ? t("settings.account.desc.loggedIn", {
              name: auth.authState.displayName || t("general.unknown"),
            })
            : t(authEntry.descriptionKey),
        render: (setting) => {
          setting.addButton((btn) => {
            if (auth?.authState.isLoggedIn) {
              btn.setButtonText(t("settings.account.logout")).onClick(() => {
                void (async () => {
                  await plugin.logoutUser();
                })();
              });
            } else {
              btn.setButtonText(t(authEntry.labelKey));
              if (authEntry.cta) btn.setCta();
              if (authEntry.disabled) {
                btn.setDisabled(true);
              } else {
                btn.onClick(() => {
                  void handleAuthEntryAction(plugin);
                });
              }
            }
          });
        },
      },
      {
        name: t("settings.syncMode.name"),
        // 片⑥ 模式行：账号行之下、面板行之上（U1）。
        visible: () => plugin.auth?.authState.isLoggedIn === true,
        render: (setting) => {
          renderSyncModeRow(setting, t, plugin);
        },
      },
      {
        name: t("settings.syncPanel.name"),
        // The panel entry only exists after sign-in.
        visible: () => plugin.auth?.authState.isLoggedIn === true,
        render: (setting) => {
          setting.addButton((btn) => {
            btn
              .setButtonText(t("settings.syncPanel.button"))
              .setCta()
              .onClick(() => {
                void plugin.openSyncPanelFromSettings();
              });
          });
        },
      },
    ],
  };
}

/**
 * Build the five entry pages for the declarative setting index consumed by
 * the host settings renderer. Pure function; exported separately for direct
 * testing.
 */
export function buildSettingDefinitions(
  t: I18nFn,
  plugin: EasySyncPlugin,
  onStateChanged?: () => void,
  onExclusionChange?: () => void,
  platformFacts: HostPlatformFacts = hostPlatformFacts,
): SettingDefinitionPage[] {
  const host: SettingsPageRowHost = {
    plugin,
    t,
    refresh: () => onStateChanged?.(),
    noteExclusionChange: () => onExclusionChange?.(),
  };
  // 根级入口的说明句与行尾现值（2026-10-12 S3 口径）：每行一句说明，行尾最多
  // 一个现值；缺依据就整条留空（不下发 displayValue 字段，不用空串占位）。
  const rows: SettingDefinitionPage[] = [
    buildScopePage(t, plugin, host),
    buildAutoSyncPage(t, plugin, host),
    buildDisplayPage(t, plugin, host, platformFacts),
    buildAboutPage(t, plugin, onStateChanged),
    buildMaintenancePage(t, plugin, host),
  ];
  const excludedCount = plugin.excludedFolders.length;
  rows[0].desc = t("settings.rootNav.scope.desc");
  if (excludedCount > 0) {
    rows[0].displayValue = t("settings.rootNav.value.excluded", {
      count: excludedCount,
    });
  }
  rows[1].desc = t("settings.rootNav.autoSync.desc");
  rows[1].displayValue = plugin.isAutoSyncMasterEnabled()
    ? t("settings.rootNav.value.autoSyncOn")
    : t("settings.rootNav.value.autoSyncOff");
  rows[2].desc = t("settings.rootNav.display.desc");
  rows[2].displayValue = t(
    `settings.notificationPopups.option.${plugin.notificationPopups}`,
  );
  const updateState = plugin.getUpdatePromptState();
  rows[3].desc = t("settings.rootNav.about.desc");
  // 有新版：行尾改「有新版本」并亮警示角标；否则只显示当前版本号。
  rows[3].displayValue = updateState
    ? t("updateCheck.chip")
    : plugin.manifest.version;
  if (updateState) rows[3].status = "warning";
  rows[4].desc = t("settings.rootNav.maintenance.desc");
  return rows;
}

/** 设置页「规则」行：一条规则只解释它所在板块，可由「我知道了」收起（2026-10-12 拍板）。 */
type SettingsRuleId =
  | "scopeExclusion"
  | "scopeContent"
  | "autoSync"
  | "autoHandling";

const SETTING_RULE_CONTENT_KEYS: Record<SettingsRuleId, string> = {
  scopeExclusion: "settings.syncExclusion.intro",
  scopeContent: "settings.syncScope.intro",
  autoSync: "settings.autoSync.intro",
  autoHandling: "settings.automaticHandling.intro",
};

function buildSettingRuleRow(
  t: I18nFn,
  plugin: EasySyncPlugin,
  host: SettingsPageRowHost,
  ruleId: SettingsRuleId,
): SettingDefinition {
  const contentKey = SETTING_RULE_CONTENT_KEYS[ruleId];
  return {
    name: t("settings.rules.name"),
    desc: t(contentKey),
    searchable: false,
    // 已收起即整行隐藏（「我知道了」= 本设备记忆）；定义不删，清空记忆即恢复。
    visible: () => !plugin.isSettingRuleAcknowledged(ruleId),
    render: (setting) => {
      setting.controlEl.empty();
      // 说明句内的 ⚙ 指代字符在两载体统一渲染为官方齿轮图标（2026-10-24）；
      // 其余三条规则句无该字符，助手原样返回字符串。
      setting
        .setName(t("settings.rules.name"))
        .setDesc(buildIntroTextWithInlineGear(t(contentKey)));
      const acknowledged = plugin.isSettingRuleAcknowledged(ruleId);
      // 行级显隐走行内 style（`setCssProps`，官方动态样式口子）：宿主对 visible 谓词
      // 只收走行内容，行壳的分隔线会留下一条横线（2026-10-12 真机反馈）；
      // update() 重跑本回调即幂等重估。
      setting.settingEl.setCssProps({ display: acknowledged ? "none" : "" });
      // 组内行间分割线由后继行的 ::before 画出，宿主只对 DOM :first-child 豁免；
      // display:none 的行仍占住 first-child，收行壳压不住后继行的线（2026-10-12
      // 真机复测：上一刀 display:none 后横线仍在）。规则行恒为组内首行（置顶
      // 设计），收起时挂标记类，由 styles.css 的后继选择器同步关掉后继行的
      // 分割线；恢复（重置同步状态清空记忆）后本回调重估摘除标记，线随
      // 组内首行语义回归。
      setting.settingEl.toggleClass(
        "easy-sync-setting-rule-acknowledged",
        acknowledged,
      );
      setting.addButton((button) => {
        button.setButtonText(t("settings.rules.acknowledge")).onClick(() => {
          void (async () => {
            try {
              await plugin.acknowledgeSettingRule(ruleId);
            } catch {
              new Notice(t("notice.settingsSaveFailed"));
              return;
            }
            setting.settingEl.setCssProps({ display: "none" });
            setting.settingEl.toggleClass(
              "easy-sync-setting-rule-acknowledged",
              true,
            );
            host.refresh();
          })();
        });
      });
    },
  };
}

/**
 * 维护页的「规则」恢复出口＝「重置同步状态」本身（2026-10-12 用户裁决）：
 * 重置时一并清空「已读」记忆，规则随之全部重新显示——不新增行、不新增文案。
 */

/**
 * 同步范围页（2026-10-11 拍板）：同步排除两项置顶＋「同步内容」分组；
 * 规则按板块拆分（2026-10-12 拍板）——排除板块一条、内容板块一条。
 */
function buildScopePage(
  t: I18nFn,
  plugin: EasySyncPlugin,
  host: SettingsPageRowHost,
): SettingDefinitionPage {
  const scopeToggles: ScopeToggleRowConfig[] = [
    {
      key: "settings.syncCorePlugins",
      get: () => plugin.syncCorePlugins,
      patch: (value) => ({ syncCorePlugins: value }),
    },
    {
      key: "settings.syncEditor",
      get: () => plugin.syncEditorSettings,
      patch: (value) => ({ syncEditorSettings: value }),
    },
    {
      key: "settings.syncAppearance",
      get: () => plugin.syncAppearance,
      patch: (value) => ({ syncAppearance: value }),
    },
    {
      key: "settings.syncThemes",
      get: () => plugin.syncThemes,
      patch: (value) => ({ syncThemes: value }),
    },
    {
      key: "settings.syncHotkeys",
      get: () => plugin.syncHotkeys,
      patch: (value) => ({ syncHotkeys: value }),
    },
    {
      key: "settings.syncBookmarks",
      get: () => plugin.syncBookmarks,
      patch: (value) => ({ syncBookmarks: value }),
    },
  ];
  return {
    type: "page",
    name: t("settings.syncScope.name"),
    items: [
      buildSettingRuleRow(t, plugin, host, "scopeExclusion"),
      {
        name: t("settings.syncExclusion.folders.name"),
        render: (setting) => applyExcludedFoldersRow(setting, host),
      },
      {
        name: t("settings.maxFileSize.name"),
        render: (setting) => applyMaxFileSizeRow(setting, host),
      },
      {
        type: "group",
        heading: t("settings.syncContent.heading"),
        items: [
          buildSettingRuleRow(t, plugin, host, "scopeContent"),
          {
            name: t("settings.syncCorePlugins.name"),
            desc: t("settings.syncCorePlugins.desc"),
            render: (setting) => applyScopeToggleRow(setting, host, scopeToggles[0]),
          },
          {
            name: t("settings.syncCommunityPlugins.name"),
            desc: t("settings.syncCommunityPlugins.desc"),
            render: (setting) => applyCommunityPluginScopeRow(setting, host, "files"),
          },
          {
            name: t("settings.syncPluginData.name"),
            desc: t("settings.syncPluginData.desc"),
            render: (setting) => applyCommunityPluginScopeRow(setting, host, "data"),
          },
          ...scopeToggles.slice(1).map((config) => ({
            name: t(`${config.key}.name`),
            desc: t(`${config.key}.desc`),
            render: (setting: Setting) => applyScopeToggleRow(setting, host, config),
          })),
        ],
      },
    ],
  };
}

/** 自动同步页（2026-10-11 拍板）：总开关＋两条滑条＋「自动处理」分组（片⑦ 条件隐藏随迁）。 */
function buildAutoSyncPage(
  t: I18nFn,
  plugin: EasySyncPlugin,
  host: SettingsPageRowHost,
): SettingDefinitionPage {
  const autoSyncDesc = (): string =>
    !plugin.isAutoSyncMasterEnabled()
      ? t("settings.autoSync.desc.disabled")
      : plugin.autoSyncPaused
        ? t("settings.autoSync.desc.paused")
        : t("settings.autoSync.desc.enabled");
  return {
    type: "page",
    name: t("settings.autoSync.name"),
    items: [
      buildSettingRuleRow(t, plugin, host, "autoSync"),
      {
        name: t("settings.autoSync.name"),
        desc: autoSyncDesc(),
        render: (setting) => {
          setting.controlEl.empty();
          setting
            .setName(t("settings.autoSync.name"))
            .setDesc(autoSyncDesc())
            .addToggle((toggle) => {
              toggle.setValue(plugin.isAutoSyncMasterEnabled())
                .onChange(async (value) => {
                  await plugin.setAutoSyncMasterEnabled(value);
                  host.refresh();
                });
            });
        },
      },
      {
        name: t("settings.syncInterval.name"),
        render: (setting) => applySyncIntervalRow(setting, host),
      },
      {
        name: t("settings.autoSyncChangeDelay.name"),
        render: (setting) => applyAutoSyncChangeDelayRow(setting, host),
      },
      {
        name: t("settings.autoSyncOnStartup.name"),
        render: (setting) => applyAutoSyncOnStartupRow(setting, host),
      },
      {
        type: "group",
        heading: t("settings.automaticHandling.name"),
        // 片⑦（U4）：单向模式下整组隐藏（只隐藏、不删除；双向照常）。片⑦ 原本挂在
        // 根级「自动处理」行上，本重构把它迁到页内分组（2026-10-12 迁移）。
        visible: () => plugin.syncDirection !== "one-way",
        items: [
          buildSettingRuleRow(t, plugin, host, "autoHandling"),
          {
            name: t("settings.automaticHandling.autoDeleteLocalFiles.name"),
            desc: t("settings.automaticHandling.autoDeleteLocalFiles.desc"),
            render: (setting) =>
              applyAutomaticHandlingRow(setting, host, "autoDeleteLocalFiles"),
          },
          {
            name: t("settings.automaticHandling.mergeNonOverlappingText.name"),
            desc: t("settings.automaticHandling.mergeNonOverlappingText.desc"),
            render: (setting) =>
              applyAutomaticHandlingRow(setting, host, "mergeNonOverlappingText"),
          },
        ],
      },
    ],
  };
}

/** 显示页（2026-10-11 拍板为入口页；后续新设置进本页）。 */
function buildDisplayPage(
  t: I18nFn,
  plugin: EasySyncPlugin,
  host: SettingsPageRowHost,
  platformFacts: HostPlatformFacts,
): SettingDefinitionPage {
  return {
    type: "page",
    name: t("settings.group.display"),
    items: [
      {
        name: t("settings.notificationPopups.name"),
        render: (setting) => applyNotificationPopupsRow(setting, host),
      },
      {
        name: t("settings.mobileStatusBar.name"),
        // 移动端专属开关：定义树常备（定义测试对账），渲染时按平台隐藏。
        visible: () => platformFacts.isMobileApp,
        render: (setting) => applyMobileStatusBarRow(setting, host),
      },
    ],
  };
}

/** 关于页（原「关于」组逐行平移）。 */
function buildAboutPage(
  t: I18nFn,
  plugin: EasySyncPlugin,
  onStateChanged?: () => void,
): SettingDefinitionPage {
  return {
    type: "page",
    name: t("settings.group.about"),
    items: [
      {
        name: t("settings.about.product.name"),
        desc: t("settings.about.product.desc", { version: plugin.manifest.version }),
        render: (setting) => {
          setting.controlEl.empty();
          renderAboutUpdateAffordance(setting, t, plugin);
        },
      },
      {
        name: t("settings.about.author.name"),
        desc: t("settings.about.author.desc"),
        render: (setting) => {
          setting.controlEl.empty();
          setting.setClass("easy-sync-settings-about-contact-setting");
          setting.addButton((btn) => {
            configureAboutContactButton(btn, {
              label: t("settings.about.contact.github"),
              icon: "github",
              url: GITHUB_URL,
            });
          });
          setting.addButton((btn) => {
            configureAboutContactButton(btn, {
              label: t("settings.about.contact.xiaohongshu"),
              icon: "book-open",
              url: XHS_URL,
              extraClassName: "easy-sync-settings-about-contact-button--xiaohongshu",
            });
          });
        },
      },
      {
        name: t("settings.about.feedback.name"),
        desc: t("settings.about.feedback.desc"),
      },
    ],
  };
}

/** 维护页（2026-10-20 用户拍板）：顶部诊断为无标题组，…「高级」组＝同步回收站（上）＋件③ 反转入口（按条件）＋重置。 */
function buildMaintenancePage(
  t: I18nFn,
  plugin: EasySyncPlugin,
  host: SettingsPageRowHost,
): SettingDefinitionPage {
  return {
    type: "page",
    name: t("settings.group.maintenance"),
    items: [
      { type: "group", items: [
        {
          name: t("settings.diagLog.name"),
          desc: t("settings.diagLog.desc"),
          render: (setting) => {
            setting.controlEl.empty();
            setting.addToggle((toggle) => {
              toggle.setValue(plugin.diagLogEnabled)
                .onChange(async (value) => {
                  const previous = plugin.diagLogEnabled;
                  plugin.diagLogEnabled = value;
                  try {
                    await plugin.saveSyncSettings();
                  } catch {
                    plugin.diagLogEnabled = previous;
                    toggle.setValue(previous);
                    new Notice(t("notice.settingsSaveFailed"));
                    return;
                  }
                  plugin.applyDiagnosticSetting();
                });
            });
          },
        },
        {
          name: t("settings.diagReport.name"),
          desc: t("settings.diagReport.desc"),
          render: (setting) => {
            setting.controlEl.empty();
            setting.addButton((btn) => {
              btn.setButtonText(t("settings.diagReport.generate"))
                .onClick(() => { void plugin.generateDiagnosticReport(); });
            });
          },
        },
      ] },
      { heading: t("settings.maintenanceAdvanced.heading"), type: "group", items: [
        {
          name: t("settings.recoveryBin.name"),
          desc: t("settings.recoveryBin.desc"),
          render: (setting) => {
            setting.controlEl.empty();
            setting.addButton((btn) => {
              btn.setButtonText(t("settings.recoveryBin.button")).onClick(() => {
                plugin.openRecoveryEntry();
              });
            });
          },
        },
        {
          name: t("settings.localOnlyIgnored.name"),
          desc: t("settings.localOnlyIgnored.desc", {
            count: plugin.getIgnoredLocalOnlyCount(),
          }),
          // 件③：单向模式且确有被忽略的条目时才出现（忽略记忆在双向模式不生效，
          // 没有可收回的内容时保持零动作干净态）。
          visible: () =>
            plugin.syncDirection === "one-way"
            && plugin.getIgnoredLocalOnlyCount() > 0,
          render: (setting) => applyLocalOnlyIgnoredRow(setting, host),
        },
        {
          name: t("settings.reset.name"),
          desc: t("settings.reset.desc"),
          render: (setting) => {
            setting.controlEl.empty();
            setting.addButton((btn) => {
              // Destructive style plus a two-step confirm before any state is
              // cleared.
              btn.buttonEl.classList.add("mod-warning");
              btn.setButtonText(t("settings.reset.button")).onClick(() => {
                void (async () => {
                  const confirmed = await new ConfirmModal(
                    plugin.app,
                    t("settings.reset.confirmTitle"),
                    t("settings.reset.confirm"),
                    t("confirm.cancel"),
                    t,
                    {
                      message: t("settings.reset.confirmMessage"),
                      warning: t("settings.reset.confirmWarning"),
                      danger: true,
                    },
                  ).awaitConfirm();
                  if (!confirmed) return;
                  await plugin.resetSyncState();
                  host.refresh();
                })();
              });
            });
          },
        },
      ] },
    ],
  };
}
