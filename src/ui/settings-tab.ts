/**
 * EasySync Settings Tab
 *
 * Settings page organized by groups (aligned with Obsidian's native SettingGroup style):
 *   - Account and sync action (no heading, always visible)
 *   - Scope (范围)
 *   - Automatic (自动)
 *   - Display (显示)
 *   - About (关于)
 *   - Maintenance (维护)
 */

import {
  PluginSettingTab,
  SettingGroup,
} from "obsidian";
import type EasySyncPlugin from "../main";
import { isAnySyncActivityRunning } from "../sync/sync-progress";
import {
  handleAuthEntryAction,
  resolveAuthEntryPresentation,
} from "./auth-entry-flow";
import { AutomaticHandlingModal } from "./automatic-handling-modal";
import { ConfigSyncModal } from "./config-sync-modal";
import { ConfirmModal } from "./confirm-modal";
import {
  renderExcludedFolderChips,
  SyncExclusionModal,
  updateExcludedFoldersFromUi,
} from "./sync-exclusion-modal";

const GITHUB_URL = "https://github.com/jiaoyingxing/easy-sync";
const XHS_URL = "https://xhslink.com/m/57v8xzlVMKp";

export interface SettingsSyncButtonStateInput {
  hasCompletedSync: boolean;
  isRunning: boolean;
  canCancel: boolean;
  planReviewActive: boolean;
}

export interface SettingsSyncButtonState {
  labelKey: string;
  cta: boolean;
  warning: boolean;
  disabled: boolean;
  action: "start-first" | "start-manual" | "confirm-plan" | "cancel-sync" | "processing";
}

export function buildSettingsSyncButtonState(
  input: SettingsSyncButtonStateInput,
): SettingsSyncButtonState {
  if (input.isRunning && input.canCancel) {
    return {
      labelKey: "syncView.cancelSync",
      cta: false,
      warning: true,
      disabled: false,
      action: "cancel-sync",
    };
  }
  if (input.isRunning) {
    return {
      labelKey: "syncView.conflict.processing",
      cta: false,
      warning: false,
      disabled: true,
      action: "processing",
    };
  }
  if (input.planReviewActive) {
    return {
      labelKey: "syncPlan.confirmExecute",
      cta: true,
      warning: false,
      disabled: false,
      action: "confirm-plan",
    };
  }
  if (input.hasCompletedSync) {
    return {
      labelKey: "settings.firstSync.sync",
      cta: true,
      warning: false,
      disabled: false,
      action: "start-manual",
    };
  }
  return {
    labelKey: "settings.firstSync.start",
    cta: true,
    warning: false,
    disabled: false,
    action: "start-first",
  };
}

export class EasySyncSettingTab extends PluginSettingTab {
  plugin: EasySyncPlugin;
  private accountSectionEl: HTMLElement | null = null;
  private rangeSectionEl: HTMLElement | null = null;
  private automaticSectionEl: HTMLElement | null = null;
  private displaySectionEl: HTMLElement | null = null;
  private aboutSectionEl: HTMLElement | null = null;
  private maintenanceSectionEl: HTMLElement | null = null;

  constructor(plugin: EasySyncPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("easy-sync-settings-tab");
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
    if (!this.accountSectionEl?.isConnected) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.renderAccountSection(t);
  }

  refreshSyncState(): void {
    if (
      !this.accountSectionEl?.isConnected
      && !this.rangeSectionEl?.isConnected
      && !this.automaticSectionEl?.isConnected
      && !this.displaySectionEl?.isConnected
    ) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.renderAccountSection(t);
    this.renderRangeSection(t);
    this.renderAutomaticSection(t);
    this.renderDisplaySection(t);
  }

  hide(): void {
    super.hide();
    this.accountSectionEl = null;
    this.rangeSectionEl = null;
    this.automaticSectionEl = null;
    this.displaySectionEl = null;
    this.aboutSectionEl = null;
    this.maintenanceSectionEl = null;
  }

  private renderAccountSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.accountSectionEl) return;
    this.accountSectionEl.empty();
    const accountGroup = new SettingGroup(this.accountSectionEl);
    this.renderAccount(accountGroup, t);

    if (!this.plugin.auth?.authState.isLoggedIn) return;

    const hasCompletedSync = this.plugin.hasCompletedSyncState();
    const fullSyncRunning = this.plugin.syncExecutor?.isRunning ?? false;
    const sideActionRunning = this.plugin.syncExecutor?.hasSideActionsInFlight ?? false;
    const isRunning = isAnySyncActivityRunning(
      this.plugin.progressStore.state,
      fullSyncRunning,
      sideActionRunning,
    );
    const buttonState = buildSettingsSyncButtonState({
      hasCompletedSync,
      isRunning,
      canCancel: fullSyncRunning,
      planReviewActive: this.plugin.state?.planReviewActive ?? false,
    });
    accountGroup.addSetting((setting) => {
      setting
        .setName(t("settings.firstSync.name"))
        .addButton((btn) => {
          if (buttonState.cta) {
            btn.setCta();
          }
          if (buttonState.warning) {
            btn.buttonEl.classList.add("mod-warning");
          }
          btn
            .setButtonText(t(buttonState.labelKey))
            .setDisabled(buttonState.disabled)
            .onClick(() => {
              switch (buttonState.action) {
                case "start-manual":
                  void this.plugin.startManualSync?.();
                  return;
                case "start-first":
                  void this.plugin.startFirstSync?.();
                  return;
                case "confirm-plan":
                  void this.plugin.executePlanReview?.();
                  return;
                case "cancel-sync":
                  void this.plugin.cancelSync?.();
                  return;
                case "processing":
                  return;
              }
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

    rangeGroup.addSetting((setting) => {
      setting
        .setName(t("settings.maxFileSize.name"))
        .setDesc(t("settings.maxFileSize.desc", { size: `${this.plugin.syncMaxFileSizeMb} MB` }))
        .addSlider((slider) => {
          slider
              .setLimits(200, 2000, 100)
              .setValue(this.plugin.syncMaxFileSizeMb)
              .onChange(async (value) => {
              this.plugin.syncMaxFileSizeMb = value;
              await this.plugin.saveSyncSettings();
              this.plugin.applyMaxFileSize();
              const desc = slider.sliderEl
                .closest(".setting-item")
                ?.querySelector(".setting-item-description");
              if (desc) {
                desc.textContent = t("settings.maxFileSize.desc", { size: `${value} MB` });
              }
            });
        });
    });
  }

  private renderAutomaticSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.automaticSectionEl) return;
    this.automaticSectionEl.empty();
    const describeAutoSyncChangeDelay = (seconds: number): string =>
      seconds === 0
        ? t("settings.autoSyncChangeDelay.disabledDesc")
        : t("settings.autoSyncChangeDelay.desc", { seconds });
    const automaticGroup = new SettingGroup(this.automaticSectionEl).setHeading(
      t("settings.group.automatic"),
    );

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

    automaticGroup.addSetting((setting) => {
      setting
        .setName(t("settings.autoSync.name"))
        .setDesc(
          this.plugin.syncInterval === 0
            ? t("settings.autoSync.desc.disabled")
            : this.plugin.autoSyncPaused
              ? t("settings.autoSync.desc.paused")
              : t("settings.autoSync.desc.enabled", { minutes: this.plugin.syncInterval }),
        )
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.syncInterval > 0)
            .onChange(async (value) => {
              this.plugin.syncInterval = value ? 3 : 0;
              this.plugin.autoSyncPaused = false;
              await this.plugin.saveSyncSettings();
              this.plugin.restartAutoSync();
              this.renderAutomaticSection(t);
            });
        });
    });

    if (this.plugin.syncInterval > 0) {
      automaticGroup.addSetting((setting) => {
        setting
          .setName(t("settings.syncInterval.name"))
          .setDesc(t("settings.syncInterval.desc", { minutes: this.plugin.syncInterval }))
          .addSlider((slider) => {
            slider
              .setLimits(3, 10, 1)
              .setValue(this.plugin.syncInterval)
              .onChange(async (value) => {
                this.plugin.syncInterval = value;
                await this.plugin.saveSyncSettings();
                this.plugin.restartAutoSync();
                const desc = slider.sliderEl
                  .closest(".setting-item")
                  ?.querySelector(".setting-item-description");
                if (desc) {
                  desc.textContent = t("settings.syncInterval.desc", { minutes: value });
                }
              });
          });
      });

      automaticGroup.addSetting((setting) => {
        setting
          .setName(t("settings.autoSyncChangeDelay.name"))
          .setDesc(describeAutoSyncChangeDelay(
            this.plugin.autoSyncChangeDelaySeconds,
          ))
          .addSlider((slider) => {
            slider
              .setLimits(0, 10, 1)
              .setValue(this.plugin.autoSyncChangeDelaySeconds)
              .onChange(async (value) => {
                this.plugin.setAutoSyncChangeDelaySeconds(value);
                await this.plugin.saveSyncSettings();
                const desc = slider.sliderEl
                  .closest(".setting-item")
                  ?.querySelector(".setting-item-description");
                if (desc) {
                  desc.textContent = describeAutoSyncChangeDelay(value);
                }
              });
          });
      });
    }
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
      setting
        .setName(t("settings.notificationPopups.name"))
        .setDesc(t("settings.notificationPopups.desc"))
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
              this.plugin.notificationPopups =
                value === "important" || value === "off" ? value : "all";
              await this.plugin.saveSyncSettings();
              this.plugin.applyNotificationPopups();
            });
        });
    });
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
    });

    aboutGroup.addSetting((setting) => {
      setting
        .setName(t("settings.about.author.name"))
        .setDesc(t("settings.about.author.desc"))
        .addButton((btn) => {
          btn.setButtonText(t("settings.about.contact.github"))
            .onClick(() => {
              window.open(GITHUB_URL, "_blank", "noopener,noreferrer");
            });
        })
        .addButton((btn) => {
          btn.setButtonText(t("settings.about.contact.xiaohongshu"))
            .onClick(() => {
              window.open(XHS_URL, "_blank", "noopener,noreferrer");
            });
        });
    });
  }

  private renderMaintenanceSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.maintenanceSectionEl) return;
    this.maintenanceSectionEl.empty();
    const maintGroup = new SettingGroup(this.maintenanceSectionEl).setHeading(
      t("settings.group.maintenance"),
    );

    maintGroup.addSetting((setting) => {
      setting
        .setName(t("settings.diagLog.name"))
        .setDesc(t("settings.diagLog.desc"))
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.diagLogEnabled)
            .onChange(async (value) => {
              this.plugin.diagLogEnabled = value;
              await this.plugin.saveSyncSettings();
              this.plugin.applyDiagnosticSetting();
            });
        });
    });

    maintGroup.addSetting((setting) => {
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

    maintGroup.addSetting((setting) => {
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
                null,
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
          auth?.authState.isLoggedIn
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
