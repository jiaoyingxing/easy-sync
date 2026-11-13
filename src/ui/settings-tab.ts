/**
 * EasySync Settings Tab
 *
 * Declarative settings for Obsidian 1.13+（minAppVersion 1.13.4）：宿主从
 * `getSettingDefinitions()` 渲染整页，`display()` 不会被调用。根级按
 * 2026-11-10 拍板改成 Resojot 式窄列表（无外侧标题）：
 *   - 登录（页：OneDrive 账号 / 同步模式）
 *   - 打开同步面板（整行即按钮）
 *   - 社区插件同步（页：社区插件 / 社区插件数据）
 *   - 同步范围 / 自动同步 / 显示 / 关于 / 维护
 */

import {
  ButtonComponent,
  Notice,
  PluginSettingTab,
  SettingGroup,
  apiVersion,
  requireApiVersion,
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
const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;
const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues/new`;
const GITHUB_README_URL = `${GITHUB_URL}/blob/main/README.md`;
const GITHUB_README_EN_URL = `${GITHUB_URL}/blob/main/README-en.md`;
/** 支持页「我的其他插件」落点：宿主内置插件详情深链（应用内打开，不跳出 Obsidian）。 */
const RESOJOT_PLUGIN_URL = "obsidian://show-plugin?id=resojot";
const OPENPLUG_PLUGIN_URL = "obsidian://show-plugin?id=openplug";
/** 作者小红书主页：固定用户 ID 链接（xhslink 短链会被平台作废，2026-11-10 起改用此链接）。 */
const XHS_URL =
  "https://www.xiaohongshu.com/user/profile/605dfc23000000000101cfdb";
/** 旧宿主升级指引的唯一外链落点（官方下载页）。 */
const OBSIDIAN_DOWNLOAD_URL = "https://obsidian.md/download";

/** 设置页页脚语言：只用于文档链接分流（文案仍走 t()）。 */
type SettingsFooterLanguage = "en" | "zh-cn";

interface SettingsFooterLink {
  label: string;
  url: string;
}

/**
 * Contact button (About author row + support page top row, both via
 * renderContactButtonsRow): rebuilds the default text-only button content as
 * icon + label spans on one line. Label doubles as tooltip and aria-label.
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
 * 「关于」页作者行与「支持 EasySync」页顶部行共用的联系按钮行（2026-11-10
 * 用户拍板「全面照抄复用」）：GitHub＋小红书两枚图标文字按钮，两处同图标、
 * 同文案、同落点。载体钩子沿用 about-contact 类名，styles.css 一套规则两处生效。
 */
function renderContactButtonsRow(setting: Setting, t: I18nFn): void {
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
}

/** 页脚「使用文档」按当前界面语言分流到中文／英文 README。 */
function settingsDocsUrl(language: SettingsFooterLanguage): string {
  return language === "zh-cn" ? GITHUB_README_URL : GITHUB_README_EN_URL;
}

/**
 * 根页页脚四个快捷入口（2026-11-10 用户拍板）：使用文档／更新记录／问题反馈／
 * 联系作者。纯数据函数，便于测试直接对账文案与落点；外链一律交系统浏览器。
 */
export function getSettingsFooterLinks(
  t: I18nFn,
  language: SettingsFooterLanguage,
): SettingsFooterLink[] {
  return [
    { label: t("settings.footer.docs"), url: settingsDocsUrl(language) },
    { label: t("settings.footer.changelog"), url: GITHUB_RELEASES_URL },
    { label: t("settings.footer.feedback"), url: GITHUB_ISSUES_URL },
    { label: t("settings.footer.contact"), url: XHS_URL },
  ];
}

/**
 * 自绘页脚内容：一行链接（细竖线分隔）＋版权行＋许可行。容器是声明式行的
 * `settingEl`；行壳的宿主边框／内边距／底色由 styles.css 归零。
 */
function renderSettingsFooter(
  container: HTMLElement,
  t: I18nFn,
  language: SettingsFooterLanguage,
): void {
  container.empty();
  const nav = container.createEl("nav", {
    cls: "easy-sync-settings-footer-links",
    attr: { "aria-label": t("settings.footer.navLabel") },
  });
  for (const [index, link] of getSettingsFooterLinks(t, language).entries()) {
    if (index > 0) {
      nav.createSpan({
        cls: "easy-sync-settings-footer-divider",
        attr: { "aria-hidden": "true" },
      });
    }
    const anchor = nav.createEl("a", {
      cls: "easy-sync-settings-footer-link",
      text: link.label,
      href: link.url,
      attr: { target: "_blank", rel: "noopener noreferrer" },
    });
    // 与关于页作者按钮同一外链口径：不接管宿主导航，交系统浏览器打开。
    anchor.onclick = (event: MouseEvent) => {
      event.preventDefault();
      window.open(link.url, "_blank", "noopener,noreferrer");
    };
  }
  container.createEl("p", {
    cls: "easy-sync-settings-footer-copyright",
    text: t("settings.footer.copyright"),
  });
  container.createEl("p", {
    cls: "easy-sync-settings-footer-license",
    text: t("settings.footer.license"),
  });
}

interface SupportPickOptions {
  nameKey: string;
  descKey: string;
  icon: string;
  url: string;
  first: boolean;
}

/**
 * 「我的其他插件」单行：保留现有图标＋插件名／短简介＋chevron；整行是外链，
 * 交互与根级导航行同型（role=link＋tabindex），焦点走宿主
 * `.setting-item:focus-visible`，不自绘悬停／焦点底纹。
 */
function buildSupportPick(
  t: I18nFn,
  options: SupportPickOptions,
): SettingDefinition {
  const name = t(options.nameKey);
  const desc = t(options.descKey);
  return {
    name,
    desc,
    render: (setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClass(
        "easy-sync-settings-support-pick",
        "mod-navigable",
      );
      if (options.first) {
        setting.settingEl.addClass("easy-sync-settings-support-pick-first");
      }
      setting.settingEl.setAttribute("role", "link");
      setting.settingEl.setAttribute("tabindex", "0");
      setting.settingEl.setAttribute("aria-label", `${name}：${desc}`);
      const iconEl = setting.settingEl.createSpan({
        cls: "easy-sync-settings-support-pick-icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(iconEl, options.icon);
      const infoEl = setting.settingEl.createSpan({
        cls: "easy-sync-settings-support-pick-info",
      });
      infoEl.createSpan({
        cls: "easy-sync-settings-support-pick-name",
        text: name,
      });
      infoEl.createSpan({
        cls: "easy-sync-settings-support-pick-desc",
        text: desc,
      });
      const chevron = setting.settingEl.createSpan({
        cls: "easy-sync-settings-support-pick-chevron",
        attr: { "aria-hidden": "true" },
      });
      setIcon(chevron, "chevron-right");
      // obsidian:// 深链交宿主协议处理，与「去更新」同一写法；真实点击已核
      // 两行分别落到 Resojot／OpenPlug 的插件详情页。
      setting.settingEl.onclick = () => {
        window.open(options.url);
      };
      setting.settingEl.onkeydown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setting.settingEl.click();
      };
    },
  };
}

/**
 * 支持 EasySync 页（2026-11-10 用户拍板）：
 * - 顶部按「关于—作者」行结构：标题＋详情＋两个原生按钮；
 * - 下面「我的其他插件」保留现有图标＋chevron 两行；
 * - 页面底部一行小字「提需求、报问题、推荐给朋友，都是支持。」，
 *   复用根页页脚许可的样式（同构）。
 */
function buildSupportPage(t: I18nFn): SettingDefinitionPage {
  return {
    type: "page",
    name: t("settings.supportPage.name"),
    items: [
      {
        // 与「关于」页同构：普通分组（不带 mod-list），行内边距走宿主默认的
        // 20px；mod-list 是根级窄列表的紧凑行（8px），放在这里会让标题、
        // 说明和按钮挤成一团。
        type: "group",
        items: [
          {
            name: t("settings.supportPage.about.name"),
            desc: t("settings.supportPage.about.desc"),
            render: (setting) => {
              renderContactButtonsRow(setting, t);
            },
          },
        ],
      },
      {
        type: "group",
        cls: "mod-list easy-sync-settings-support-picks",
        heading: t("settings.supportPage.picksHeading"),
        items: [
          buildSupportPick(t, {
            nameKey: "settings.supportPage.resojot.name",
            descKey: "settings.supportPage.resojot.desc",
            icon: "mic",
            url: RESOJOT_PLUGIN_URL,
            first: true,
          }),
          buildSupportPick(t, {
            nameKey: "settings.supportPage.openplug.name",
            descKey: "settings.supportPage.openplug.desc",
            icon: "plug",
            url: OPENPLUG_PLUGIN_URL,
            first: false,
          }),
        ],
      },
      {
        type: "group",
        cls: "easy-sync-settings-support-note-group",
        items: [
          {
            name: t("settings.supportPage.note"),
            searchable: false,
            render: (setting) => {
              setting.settingEl.empty();
              setting.settingEl.addClass("easy-sync-settings-support-note-row");
              setting.settingEl.createEl("p", {
                cls: "easy-sync-settings-footer-license",
                text: t("settings.supportPage.note"),
              });
            },
          },
        ],
      },
    ],
  };
}

/** 根页「支持 EasySync」入口组：设置目录里的最后一组，紧接第三组；页脚仍贴底。 */
function buildSettingsSupportGroup(t: I18nFn): SettingDefinitionItem {
  return {
    type: "group",
    cls: "mod-list easy-sync-settings-support-group",
    items: [buildSupportPage(t)],
  };
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
   * display(), so this list must cover the root navigation (login page, the
   * panel action row, the community-plugin page) as well as the five entry
   * pages. Rows render through `SettingDefinitionRender`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    // I18n.language 的静态类型是 string（LocaleMap 为 Record），运行时已收窄到
    // en／zh-cn；这里显式落到页脚文档链接需要的两值类型。
    const language: SettingsFooterLanguage =
      this.plugin.i18n.language === "zh-cn" ? "zh-cn" : "en";
    return buildRootSettingDefinitions(
      this.plugin.i18n.t.bind(this.plugin.i18n),
      this.plugin,
      () => this.refreshSyncState(),
      () => this.noteExclusionChange(),
      this.platformFacts,
      language,
    );
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
 * <1.13 旧宿主的设置页：设置页已单轨化（DECISIONS 2026-11-07），旧宿主没有
 * getSettingDefinitions() 可渲染；这里只给一条升级指引，不恢复任何旧设置功能。
 * 单独成类而不是把 display() 塞回主类：声明式页一旦同时实现 display()，官方
 * eslint 规则（settings-tab/no-deprecated-display）会把它判成可删的死代码。
 */
class EasySyncLegacyHostSettingTab extends EasySyncSettingTab {
  override display(): void {
    this.containerEl.empty();
    // 用原生分组卡片承载，和 1.12 自带设置页（.setting-group > .setting-items > .setting-item）
    // 完全同构；SettingGroup 自 1.11.0 可用，旧宿主范围内安全。
    const group = new SettingGroup(this.containerEl);
    group.addSetting((setting) => {
      setting
        .setName(this.plugin.i18n.t("settings.hostRequirement.title"))
        .setDesc(
          this.plugin.i18n.t("settings.hostRequirement.desc", {
            current: apiVersion,
            required: this.plugin.manifest.minAppVersion,
          }),
        )
        .addButton((button) => {
          button
            .setButtonText(this.plugin.i18n.t("settings.hostRequirement.download"))
            .setCta()
            .onClick(() => {
              window.open(
                OBSIDIAN_DOWNLOAD_URL,
                "_blank",
                "noopener,noreferrer",
              );
            });
        });
    });
  }

  // 旧宿主没有 1.13 的 SettingTab.update()：主类的后台刷新改为空操作，
  // 避免设置窗未打开时也因缺失方法抛错。
  override refreshAuthState(): void {}

  override refreshSyncState(): void {}
}

/** 按宿主能力选择设置页实例：1.13+ 声明式单轨，<1.13 只给升级指引。 */
export function createEasySyncSettingTab(
  plugin: EasySyncPlugin,
  platformFacts: HostPlatformFacts = hostPlatformFacts,
): EasySyncSettingTab {
  return requireApiVersion("1.13.0")
    ? new EasySyncSettingTab(plugin, platformFacts)
    : new EasySyncLegacyHostSettingTab(plugin, platformFacts);
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
 * 根级「登录」页（2026-11-10 窄列表改版）：账号行与同步模式行原样搬进子页，
 * 根级只留一条入口行；行尾透登录状态（每行最多一个现值）。
 */
export function buildLoginPage(
  t: I18nFn,
  plugin: EasySyncPlugin,
): SettingDefinitionPage {
  const auth = plugin.auth;
  const authEntry = resolveAuthEntryPresentation({
    isInitializing: auth?.isInitializing ?? false,
    isPending: auth?.isPending ?? false,
    isDevicePending: (auth?.deviceAttempt ?? null) !== null,
  });
  // 验证中／初始化中不下发现值：此时既不能写「未登录」，也不该写「已登录」。
  const settling = (auth?.isInitializing ?? false) || (auth?.isPending ?? false);
  // 根级行尾：已登录直接写账号名（用户 2026-11-10 点名，不再写「已登录」）；
  // 未登录写「未登录」；验证中／初始化中留空。
  const displayValue = settling
    ? undefined
    : auth?.authState.isLoggedIn
      ? auth.authState.displayName || t("general.unknown")
      : t("settings.loginPage.value.loggedOut");
  // 未登录（已稳定）亮宿主警示角标：声明式 `status` 字段的挂点渲染 alert-triangle，
  // 与「未登录」现值同判据（2026-11-10 用户点名）。
  const warning = !settling && auth?.authState.isLoggedIn !== true;
  return {
    type: "page",
    name: t("settings.loginPage.name"),
    ...(displayValue ? { displayValue } : {}),
    ...(warning ? { status: "warning" as const } : {}),
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
        // 片⑥ 模式行：账号行之下，同一份行实现。
        visible: () => plugin.auth?.authState.isLoggedIn === true,
        render: (setting) => {
          renderSyncModeRow(setting, t, plugin);
        },
      },
    ],
  };
}

/**
 * 根级「打开同步面板」动作行（2026-11-10 用户点名）：不再是右侧按钮，整行就是
 * 按钮——点击／Enter／空格与旧按钮同效（`openSyncPanelFromSettings()`）；行尾
 * 箭头沿用宿主可导航行的视觉。**不随登录态隐藏**（2026-11-10 用户反馈：未登录也
 * 要能看到这条出口）。
 */
export function buildSyncPanelActionRow(
  t: I18nFn,
  plugin: EasySyncPlugin,
): SettingDefinition {
  return {
    name: t("settings.syncPanel.openRow"),
    render: (setting) => {
      // update() 重跑回调不重建行节点：先复位动作区再挂箭头，避免重复追加。
      setting.controlEl.empty();
      const chevron = setting.controlEl.createSpan({
        cls: "setting-item-chevron easy-sync-settings-row-chevron",
      });
      setIcon(chevron, "chevron-right");
      setting.settingEl.addClass(
        "easy-sync-settings-row-button",
        "mod-navigable",
      );
      setting.settingEl.setAttribute("role", "button");
      setting.settingEl.setAttribute("tabindex", "0");
      setting.settingEl.setAttribute(
        "aria-label",
        t("settings.syncPanel.openRow"),
      );
      // onclick／onkeydown 赋值幂等：update() 重跑回调不会叠加监听。
      setting.settingEl.onclick = () => {
        void plugin.openSyncPanelFromSettings();
      };
      setting.settingEl.onkeydown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setting.settingEl.click();
      };
    },
  };
}

/**
 * 根级「社区插件同步」页（2026-11-10 用户点名）：把原同步范围页「同步内容」里的
 * 社区插件／社区插件数据两行整体搬来，行实现与说明句不变。
 */
export function buildCommunityPluginSyncPage(
  t: I18nFn,
  plugin: EasySyncPlugin,
  refresh: () => void,
): SettingDefinitionPage {
  const host: SettingsPageRowHost = {
    plugin,
    t,
    refresh,
    noteExclusionChange: () => undefined,
  };
  return {
    type: "page",
    name: t("settings.communityPluginsSyncPage.name"),
    items: [
      // 2026-11-10 拆页同步拆规则：原同步范围页「内容板块」那条（⚙ 逐插件参与）
      // 随社区插件两行搬来这里，单独一条、独立「我知道了」记忆。
      buildSettingRuleRow(t, plugin, host, "communityPlugins"),
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
    ],
  };
}

/**
 * 根页页脚（2026-11-10 用户拍板）：三组导航之后的一行快捷入口＋版权/许可。
 * 不是导航组：无外侧标题、无卡片底色、不进设置搜索；只放根页，子页不放。
 */
function buildSettingsFooterGroup(
  t: I18nFn,
  language: SettingsFooterLanguage,
): SettingDefinitionItem {
  return {
    type: "group",
    cls: "easy-sync-settings-footer-group",
    items: [
      {
        // 行名只给宿主与无障碍用；渲染时清空行壳、自绘页脚。
        name: t("settings.footer.navLabel"),
        searchable: false,
        render: (setting) => {
          setting.settingEl.empty();
          setting.settingEl.addClass("easy-sync-settings-footer-row");
          renderSettingsFooter(setting.settingEl, t, language);
        },
      },
    ],
  };
}

/**
 * 根级装配（2026-11-10 用户拍板，照 Resojot 窄列表）：
 *   组①登录页／打开同步面板动作行；
 *   组②社区插件同步页／同步范围／自动同步（2026-11-10 用户点名：社区插件同步
 *       并入下面这组，不再单列第三组）；组③显示／关于／维护；
 *   组④支持 EasySync 页（2026-11-10 用户拍板：单独一组，贴页脚上方）；
 *   组⑤根页页脚（2026-11-10 用户拍板：四入口＋版权/许可）。
 * 前三组走宿主 `mod-list` 紧凑列表、都不加外侧标题；根级每行只留行名与行尾
 * 现值，不再写行说明（说明只在页内）。支持组也是 `mod-list`，页脚组单独一类。
 */
export function buildRootSettingDefinitions(
  t: I18nFn,
  plugin: EasySyncPlugin,
  onStateChanged?: () => void,
  onExclusionChange?: () => void,
  platformFacts: HostPlatformFacts = hostPlatformFacts,
  language: SettingsFooterLanguage = "zh-cn",
): SettingDefinitionItem[] {
  const [scopePage, autoSyncPage, displayPage, aboutPage, maintenancePage] =
    buildSettingDefinitions(
      t,
      plugin,
      onStateChanged,
      onExclusionChange,
      platformFacts,
    );
  return [
    {
      type: "group",
      cls: "mod-list",
      items: [
        buildLoginPage(t, plugin),
        buildSyncPanelActionRow(t, plugin),
      ],
    },
    {
      type: "group",
      cls: "mod-list",
      items: [
        buildCommunityPluginSyncPage(t, plugin, () => onStateChanged?.()),
        scopePage,
        autoSyncPage,
      ],
    },
    {
      type: "group",
      cls: "mod-list",
      items: [displayPage, aboutPage, maintenancePage],
    },
    buildSettingsSupportGroup(t),
    buildSettingsFooterGroup(t, language),
  ];
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
  // 根级入口只保留行名与行尾现值（2026-11-10 窄列表）：行名自足，不再写行说明；
  // 行尾最多一个现值，缺依据就整条留空（不下发 displayValue 字段，不用空串占位）。
  const rows: SettingDefinitionPage[] = [
    buildScopePage(t, plugin, host),
    buildAutoSyncPage(t, plugin, host),
    buildDisplayPage(t, plugin, host, platformFacts),
    buildAboutPage(t, plugin, onStateChanged),
    buildMaintenancePage(t, plugin, host),
  ];
  const excludedCount = plugin.excludedFolders.length;
  if (excludedCount > 0) {
    rows[0].displayValue = t("settings.rootNav.value.excluded", {
      count: excludedCount,
    });
  }
  rows[1].displayValue = plugin.isAutoSyncMasterEnabled()
    ? t("settings.rootNav.value.autoSyncOn")
    : t("settings.rootNav.value.autoSyncOff");
  rows[2].displayValue = t(
    `settings.notificationPopups.option.${plugin.notificationPopups}`,
  );
  const updateState = plugin.getUpdatePromptState();
  // 有新版：行尾改「有新版本」并亮警示角标；否则只显示当前版本号。
  rows[3].displayValue = updateState
    ? t("updateCheck.chip")
    : plugin.manifest.version;
  if (updateState) rows[3].status = "warning";
  return rows;
}

/** 设置页「规则」行：一条规则只解释它所在板块，可由「我知道了」收起（2026-10-12 拍板）。 */
type SettingsRuleId =
  | "scopeExclusion"
  | "syncContent"
  | "communityPlugins"
  | "autoSync"
  | "autoHandling";

const SETTING_RULE_CONTENT_KEYS: Record<SettingsRuleId, string> = {
  scopeExclusion: "settings.syncExclusion.intro",
  syncContent: "settings.syncContent.intro",
  communityPlugins: "settings.syncScope.intro",
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
          buildSettingRuleRow(t, plugin, host, "syncContent"),
          {
            name: t("settings.syncCorePlugins.name"),
            desc: t("settings.syncCorePlugins.desc"),
            render: (setting) => applyScopeToggleRow(setting, host, scopeToggles[0]),
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
          renderContactButtonsRow(setting, t);
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
