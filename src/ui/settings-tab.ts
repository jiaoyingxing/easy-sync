/**
 * EasySync Settings Tab
 *
 * Settings page organized by groups (aligned with Obsidian's native SettingGroup style):
 *   - Account and sync-panel entry (no heading, always visible)
 *   - Scope (范围)
 *   - Automatic (自动)
 *   - Display (显示)
 *   - About (关于)
 *   - Maintenance (维护)
 */

import {
  ButtonComponent,
  Notice,
  Platform,
  PluginSettingTab,
  SettingGroup,
  setIcon,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
} from "obsidian";
import type EasySyncPlugin from "../main";
import {
  handleAuthEntryAction,
  resolveAuthEntryPresentation,
} from "./auth-entry-flow";
import { AutomaticHandlingModal } from "./automatic-handling-modal";
import { AutoSyncModal } from "./auto-sync-modal";
import { ConfigSyncModal } from "./config-sync-modal";
import { ConfirmModal, type I18nFn } from "./confirm-modal";
import { SyncModeDisableModal } from "./sync-mode-disable-modal";
import { SyncModeGateModal } from "./sync-mode-gate-modal";
import { syncModeGateInputLiteral } from "../sync/sync-mode-transition";
import type { SyncDirection } from "../sync/sync-direction";
import {
  renderExcludedFolderChips,
  SyncExclusionEditSession,
  SyncExclusionModal,
  updateExcludedFoldersFromUi,
} from "./sync-exclusion-modal";
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
  if (!plugin.getUpdatePromptState()) return;
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
  private accountSectionEl: HTMLElement | null = null;
  private rangeSectionEl: HTMLElement | null = null;
  private automaticSectionEl: HTMLElement | null = null;
  private displaySectionEl: HTMLElement | null = null;
  private aboutSectionEl: HTMLElement | null = null;
  private maintenanceSectionEl: HTMLElement | null = null;
  /** 维护页「高级」组宿主（2026-10-20 用户拍板：同步回收站＋重置一组，
   *  顶部诊断日志与报告单独成组、不加外侧标题）。 */
  private maintenanceAdvancedSectionEl: HTMLElement | null = null;
  /** 1.13+ 根级导航行图标的补挂观察器（宿主重建根行后自动补）。 */
  private rootRowIconObserver: MutationObserver | null = null;

  constructor(plugin: EasySyncPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    // Tab-level class must be applied at construction time: on Obsidian
    // 1.13.0+ the host renders declaratively and never calls display().
    this.containerEl.addClass("easy-sync-settings-tab");
    // 设置窗左栏本插件那一行的图标（宿主只在页签 icon 非空时建该元素；第三方
    // 插件整栏被宿主隐藏，由 styles.css 只放开我们自己那一行）。
    this.icon = SETTINGS_TAB_ICON;
    this.observeRootRowIcons();
  }

  /**
   * 当前宿主是否走声明式渲染（1.13+）。声明式时 `display()` 不会被调用、行由
   * `getSettingDefinitions()` 承接；几处刷新路径与装饰共用这一个判别。
   */
  private isDeclarativeRender(): boolean {
    const declarative = this as unknown as { settingItems?: unknown[] };
    if (
      declarative.settingItems === undefined
      || declarative.settingItems.length === 0
    ) {
      return false;
    }
    return true;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.accountSectionEl = containerEl.createDiv("easy-sync-settings-account");
    this.rangeSectionEl = containerEl.createDiv(
      "easy-sync-settings-group-host easy-sync-settings-range",
    );
    this.automaticSectionEl = containerEl.createDiv(
      "easy-sync-settings-group-host easy-sync-settings-automatic",
    );
    this.displaySectionEl = containerEl.createDiv(
      "easy-sync-settings-group-host easy-sync-settings-display",
    );
    this.aboutSectionEl = containerEl.createDiv("easy-sync-settings-group-host easy-sync-settings-about");
    this.maintenanceSectionEl = containerEl.createDiv(
      "easy-sync-settings-group-host easy-sync-settings-maintenance",
    );
    this.maintenanceAdvancedSectionEl = containerEl.createDiv(
      "easy-sync-settings-group-host easy-sync-settings-maintenance-advanced",
    );

    // ========================================================================
    // Account and sync action — one unheaded group
    // ========================================================================
    this.renderAccountSection(t);

    // ========================================================================
    // Scope group
    // ========================================================================
    this.renderRangeSection(t);

    // ========================================================================
    // Automatic group
    // ========================================================================
    this.renderAutomaticSection(t);

    // ========================================================================
    // Display group
    // ========================================================================
    this.renderDisplaySection(t);

    // ========================================================================
    // About group
    // ========================================================================
    this.renderAboutSection(t);

    // ========================================================================
    // Maintenance group
    // ========================================================================
    this.renderMaintenanceSection(t);
  }

  refreshAuthState(): void {
    // On Obsidian 1.13.0+ the tab is rendered declaratively from
    // getSettingDefinitions() and accountSectionEl is never populated, so the
    // refresh must go through update(). On older hosts fall back to the
    // imperative display() path.
    if (this.isDeclarativeRender()) {
      (this as unknown as { update?: () => void }).update?.();
      return;
    }
    if (!this.accountSectionEl?.isConnected) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.renderAccountSection(t);
  }

  /**
   * Declarative setting index for Obsidian 1.13.0+ settings search.
   *
   * On 1.13.0+ the host renders the whole tab from these definitions and
   * `display()` is not called (see the deprecated `display()` contract), so
   * this list must cover the account/login/sync-action area as well as the
   * grouped settings. Entries render through `SettingDefinitionRender`
   * reusing the same imperative paths as `display()`, so runtime state
   * handling stays unchanged; older hosts ignore this method entirely.
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
      );
    return [
      buildAccountSettingDefinitions(t, this.plugin),
      { type: "group", items: [scopePage, autoSyncPage] },
      { type: "group", items: [displayPage, aboutPage, maintenancePage] },
    ];
  }

  /**
   * 排除项变更的计划重算时机：弹框时代＝关闭弹框时（`SyncExclusionEditSession`），
   * 设置页没有「关闭」，改在设置窗关闭（`hide()`）时统一收口；只有改过且有在途
   * 审阅才重算。代价如实记：桌面设置窗可长期开着，重算窗口比弹框时代长
   * （2026-10-12 决策，方案单 §八）。
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
    // Same split as refreshAuthState: declarative render on 1.13.0+,
    // imperative display() fallback on older hosts.
    if (this.isDeclarativeRender()) {
      (this as unknown as { update?: () => void }).update?.();
      return;
    }
    if (
      !this.accountSectionEl?.isConnected
      && !this.rangeSectionEl?.isConnected
      && !this.automaticSectionEl?.isConnected
      && !this.displaySectionEl?.isConnected
      && !this.maintenanceSectionEl?.isConnected
      && !this.maintenanceAdvancedSectionEl?.isConnected
    ) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.renderAccountSection(t);
    this.renderRangeSection(t);
    this.renderAutomaticSection(t);
    this.renderDisplaySection(t);
    // 件③ 反转入口的出现/退场与说明里的计数都靠这一组重渲染（单向模式下
    // 逐条或批量忽略后立刻生效）。
    this.renderMaintenanceSection(t);
  }

  hide(): void {
    super.hide();
    this.accountSectionEl = null;
    this.rangeSectionEl = null;
    this.automaticSectionEl = null;
    this.displaySectionEl = null;
    this.aboutSectionEl = null;
    this.maintenanceSectionEl = null;
    this.maintenanceAdvancedSectionEl = null;
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

  /**
   * `<1.13` 的 `display()` 弹框形态没有根级导航行（行名与页名同名的行在那里是
   * 普通设置行），只在声明式渲染（1.13+）才装饰。
   */
  private decorateRootRowIcons(): void {
    if (!this.isDeclarativeRender()) return;
    decorateSettingsRootRowIcons(
      this.containerEl,
      this.plugin.i18n.t.bind(this.plugin.i18n),
    );
  }

  private renderAccountSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.accountSectionEl) return;
    this.accountSectionEl.empty();
    const accountGroup = new SettingGroup(this.accountSectionEl);
    this.renderAccount(accountGroup, t);

    if (!this.plugin.auth?.authState.isLoggedIn) return;

    // 片⑥ 同步模式行：账号行之下、「同步面板」行之上（U1）。只承担模式选择，
    // 不绕过门槛弹框、也不在这里执行同步。
    accountGroup.addSetting((setting) => {
      renderSyncModeRow(setting, t, this.plugin);
    });

    // Navigation only: progress, plan review and every run action (sync,
    // confirm, cancel) live in the sidebar, so the settings page must not
    // carry a second copy of the sidebar's primary button or its state
    // machine (2026-10-09 拍板，取代 2026-08-16 的设置页「立即同步」动作行).
    accountGroup.addSetting((setting) => {
      setting
        .setName(t("settings.syncPanel.name"))
        .addButton((btn) => {
          btn
            .setButtonText(t("settings.syncPanel.button"))
            .setCta()
            .onClick(() => {
              void this.plugin.openSyncPanelFromSettings();
            });
        });
    });
  }

  private renderRangeSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.rangeSectionEl) return;
    this.rangeSectionEl.empty();
    const rangeGroup = new SettingGroup(this.rangeSectionEl).setHeading(
      t("settings.group.scope"),
    );

    rangeGroup.addSetting((setting) => {
      setting
        .setName(t("settings.syncScope.name"))
        .setDesc(t("settings.syncScope.desc"))
        .addButton((btn) => {
          btn.setButtonText(t("settings.syncScope.button"))
            .onClick(() => {
              new ConfigSyncModal(this.plugin).open();
            });
        });
    });

    rangeGroup.addSetting((setting) => {
      setting
        .setName(t("settings.syncExclusion.name"))
        .setDesc(t("settings.syncExclusion.desc"))
        .addButton((button) => {
          button
            .setButtonText(t("settings.syncExclusion.button"))
            .onClick(() => {
              new SyncExclusionModal(this.plugin).open();
            });
        });

      if (this.plugin.excludedFolders.length > 0) {
        const chipsEl = setting.descEl.createDiv();
        renderExcludedFolderChips(chipsEl, this.plugin.excludedFolders, {
          removeLabel: (path) => t("settings.syncExclusion.removeFolder", { path }),
          onRemove: (path) => updateExcludedFoldersFromUi(
            this.plugin,
            this.plugin.excludedFolders.filter((current) => current !== path),
          ),
        });
      }
    });
  }

  private renderAutomaticSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.automaticSectionEl) return;
    this.automaticSectionEl.empty();
    const automaticGroup = new SettingGroup(this.automaticSectionEl).setHeading(
      t("settings.group.automatic"),
    );

    // 片⑦（U4）：单向模式下「自动处理」行整体隐藏——它的两个开关在该模式下都
    // 失效（删除跟随强制恒开、自动合并只发生在上传链内部）。只隐藏、不删除：
    // 行定义与弹框入口原样保留，双向即恢复。`refreshSyncState()` 会重渲染本组，
    // 所以切换模式后立即生效；声明式镜像同步同改（`buildSettingDefinitions`）。
    if (this.plugin.syncDirection !== "one-way") {
      automaticGroup.addSetting((setting) => {
        setting
          .setName(t("settings.automaticHandling.name"))
          .setDesc(t("settings.automaticHandling.desc"))
          .addButton((button) => {
            button
              .setButtonText(t("settings.automaticHandling.button"))
              .setTooltip(t("settings.automaticHandling.open"))
              .onClick(() => {
                new AutomaticHandlingModal(this.plugin).open();
              });
            button.buttonEl.setAttribute(
              "aria-label",
              t("settings.automaticHandling.open"),
            );
          });
      });
    }

    automaticGroup.addSetting((setting) => {
      setting
        .setName(t("settings.autoSync.name"))
        .setDesc(
          !this.plugin.isAutoSyncMasterEnabled()
            ? t("settings.autoSync.desc.disabled")
            : this.plugin.autoSyncPaused
              ? t("settings.autoSync.desc.paused")
              : t("settings.autoSync.desc.enabled"),
        )
        .addButton((button) => {
          button
            .setIcon("settings")
            .setTooltip(t("settings.autoSync.open"))
            .onClick(() => {
              new AutoSyncModal(this.plugin).open();
            });
          button.buttonEl.addClass("clickable-icon");
          button.buttonEl.setAttribute(
            "aria-label",
            t("settings.autoSync.open"),
          );
        })
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.isAutoSyncMasterEnabled())
            .onChange(async (value) => {
              await this.plugin.setAutoSyncMasterEnabled(value);
              this.renderAutomaticSection(t);
            });
        });
    });
  }

  private renderDisplaySection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.displaySectionEl) return;
    this.displaySectionEl.empty();
    const displayGroup = new SettingGroup(this.displaySectionEl).setHeading(
      t("settings.group.display"),
    );

    displayGroup.addSetting((setting) => {
      const hintEl = setting.descEl.createDiv({
        cls: "easy-sync-notification-popups-hint",
      });
      const renderHint = (): void => {
        hintEl.setText(t(`settings.notificationPopups.hint.${this.plugin.notificationPopups}`));
      };
      setting
        .setName(t("settings.notificationPopups.name"))
        .addDropdown((dropdown) => {
          dropdown
            .addOption("all", t("settings.notificationPopups.option.all"))
            .addOption(
              "important",
              t("settings.notificationPopups.option.important"),
            )
            .addOption("off", t("settings.notificationPopups.option.off"))
            .setValue(this.plugin.notificationPopups)
            .onChange(async (value) => {
              const previous = this.plugin.notificationPopups;
              this.plugin.notificationPopups =
                value === "important" || value === "off" ? value : "all";
              try {
                await this.plugin.saveSyncSettings();
              } catch {
                this.plugin.notificationPopups = previous;
                dropdown.setValue(previous);
                new Notice(t("notice.settingsSaveFailed"));
                return;
              }
              this.plugin.applyNotificationPopups();
              renderHint();
            });
        });
      renderHint();
    });
    // 移动端专属开关：桌面端本行不渲染（显示隔离，桌面状态栏体系不受影响）。
    if (Platform.isMobile) {
      displayGroup.addSetting((setting) => {
        applyMobileStatusBarRow(setting, {
          plugin: this.plugin,
          t,
          refresh: () => this.refreshSyncState(),
          noteExclusionChange: () => this.noteExclusionChange(),
        });
      });
    }
  }

  private renderAboutSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.aboutSectionEl) return;
    this.aboutSectionEl.empty();
    const aboutGroup = new SettingGroup(this.aboutSectionEl).setHeading(t("settings.group.about"));

    aboutGroup.addSetting((setting) => {
      setting
        .setName(t("settings.about.product.name"))
        .setDesc(t("settings.about.product.desc", { version: this.plugin.manifest.version }));
      renderAboutUpdateAffordance(setting, t, this.plugin);
    });

    aboutGroup.addSetting((setting) => {
      setting
        .setClass("easy-sync-settings-about-contact-setting")
        .setName(t("settings.about.author.name"))
        .setDesc(t("settings.about.author.desc"))
        .addButton((btn) => {
          configureAboutContactButton(btn, {
            label: t("settings.about.contact.github"),
            icon: "github",
            url: GITHUB_URL,
          });
        })
        .addButton((btn) => {
          configureAboutContactButton(btn, {
            label: t("settings.about.contact.xiaohongshu"),
            icon: "book-open",
            url: XHS_URL,
            extraClassName: "easy-sync-settings-about-contact-button--xiaohongshu",
          });
        });
    });

    aboutGroup.addSetting((setting) => {
      setting
        .setName(t("settings.about.feedback.name"))
        .setDesc(t("settings.about.feedback.desc"));
    });
  }

  private renderMaintenanceSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.maintenanceSectionEl) return;
    this.maintenanceSectionEl.empty();
    // 首组不加外侧标题（同各页口径，2026-10-12 拍板）：顶部只放诊断日志与报告。
    const diagGroup = new SettingGroup(this.maintenanceSectionEl);

    diagGroup.addSetting((setting) => {
      setting
        .setName(t("settings.diagLog.name"))
        .setDesc(t("settings.diagLog.desc"))
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.diagLogEnabled)
            .onChange(async (value) => {
              const previous = this.plugin.diagLogEnabled;
              this.plugin.diagLogEnabled = value;
              try {
                await this.plugin.saveSyncSettings();
              } catch {
                this.plugin.diagLogEnabled = previous;
                toggle.setValue(previous);
                new Notice(t("notice.settingsSaveFailed"));
                return;
              }
              this.plugin.applyDiagnosticSetting();
            });
        });
    });

    diagGroup.addSetting((setting) => {
      setting
        .setName(t("settings.diagReport.name"))
        .setDesc(t("settings.diagReport.desc"))
        .addButton((btn) => {
          btn.setButtonText(t("settings.diagReport.generate"))
            .onClick(() => {
              void this.plugin.generateDiagnosticReport();
            });
        });
    });

    if (!this.maintenanceAdvancedSectionEl) return;
    this.maintenanceAdvancedSectionEl.empty();
    // 「高级」组（2026-10-20 用户拍板）：同步回收站＋重置一组，回收站在上。
    const advancedGroup = new SettingGroup(this.maintenanceAdvancedSectionEl)
      .setHeading(t("settings.maintenanceAdvanced.heading"));

    advancedGroup.addSetting((setting) => {
      setting
        .setName(t("settings.recoveryBin.name"))
        .setDesc(t("settings.recoveryBin.desc"))
        .addButton((btn) => {
          btn.setButtonText(t("settings.recoveryBin.button")).onClick(() => {
            this.plugin.openRecoveryEntry();
          });
        });
    });

    // 件③ 反转入口：单向模式且确有被忽略的条目时出现（忽略记忆在双向不生效）。
    // 只隐藏、不删除——双向或计数归零后这一行自己退场；`refreshSyncState()`
    // 会重渲染本组，所以面板里逐条/批量忽略后立刻出现。
    if (
      this.plugin.syncDirection === "one-way"
      && this.plugin.getIgnoredLocalOnlyCount() > 0
    ) {
      advancedGroup.addSetting((setting) => {
        applyLocalOnlyIgnoredRow(setting, {
          plugin: this.plugin,
          t,
          refresh: () => this.refreshSyncState(),
          noteExclusionChange: () => {},
        });
      });
    }

    advancedGroup.addSetting((setting) => {
      setting
        .setName(t("settings.reset.name"))
        .setDesc(t("settings.reset.desc"))
        .addButton((btn) => {
          btn.buttonEl.classList.add("mod-warning");
          btn.setButtonText(t("settings.reset.button")).onClick(() => {
            void (async () => {
              const confirmed = await new ConfirmModal(
                this.plugin.app,
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
              await this.plugin.resetSyncState();
              this.refreshSyncState();
            })();
          });
        });
    });
  }

  /** Render the account login/logout row inside the unheaded top group. */
  private renderAccount(
    accountGroup: SettingGroup,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    const auth = this.plugin.auth;
    const authEntry = resolveAuthEntryPresentation({
      isInitializing: auth?.isInitializing ?? false,
      isPending: auth?.isPending ?? false,
      isDevicePending: (auth?.deviceAttempt ?? null) !== null,
    });
    accountGroup.addSetting((setting) => {
      setting
        .setName(t("settings.account.name"))
        .setDesc(
          auth?.isSessionPending
            ? t("settings.account.desc.connecting")
            : auth?.authState.isLoggedIn
              ? t("settings.account.desc.loggedIn", {
                name: auth.authState.displayName || t("general.unknown"),
              })
              : t(authEntry.descriptionKey),
        )
        .addButton((btn) => {
          if (auth?.authState.isLoggedIn) {
            btn.setButtonText(t("settings.account.logout")).onClick(() => {
              void (async () => {
                await this.plugin.logoutUser();
                this.refreshAuthState();
              })();
            });
          } else {
            btn.setButtonText(t(authEntry.labelKey));
            if (authEntry.cta) btn.setCta();
            if (authEntry.disabled) {
              btn.setDisabled(true);
            } else {
              btn.onClick(() => {
                void handleAuthEntryAction(this.plugin);
              });
            }
          }
        });
    });
  }
}

/**
 * 片⑥ 同步模式行（命令式与声明式共用同一份实现）。
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
 * Build the unheaded account/login group plus the sync-panel entry for the
 * declarative setting index. On Obsidian 1.13.0+ the host renders the whole
 * tab from getSettingDefinitions() and never calls display(), so this group
 * must mirror renderAccountSection(): the account row is always visible and
 * the panel-entry row only appears after sign-in.
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
        // 片⑥ 模式行：与命令式同组同位（账号行之下、面板行之上），同一份行实现。
        visible: () => plugin.auth?.authState.isLoggedIn === true,
        render: (setting) => {
          renderSyncModeRow(setting, t, plugin);
        },
      },
      {
        name: t("settings.syncPanel.name"),
        // The panel entry only exists after sign-in, mirroring
        // renderAccountSection's early return for logged-out users.
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
 * Build the declarative setting index consumed by Obsidian 1.13.0+ settings
 * search. Pure function: rendering entries through `SettingDefinitionRender`
 * reuses the same imperative paths as `display()`, so plugin state and the
 * runtime UI stay unchanged. Exported separately for direct testing.
 */
export function buildSettingDefinitions(
  t: I18nFn,
  plugin: EasySyncPlugin,
  onStateChanged?: () => void,
  onExclusionChange?: () => void,
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
    buildDisplayPage(t, plugin, host),
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
      setting.setName(t("settings.rules.name")).setDesc(t(contentKey));
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
        visible: () => Platform.isMobile,
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
              // Mirror renderMaintenanceSection: destructive style plus a
              // two-step confirm before any state is cleared.
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
