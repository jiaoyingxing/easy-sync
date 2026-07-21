/**
 * EasySync Settings Tab
 *
 * Settings page organized by groups (aligned with Obsidian's native SettingGroup style):
 *   - Account (no heading, always visible)
 *   - Sync (同步)
 *   - Maintenance (维护)
 *   - About (关于)
 */

import { PluginSettingTab, Setting, SettingGroup } from "obsidian";
import type EasySyncPlugin from "../main";
import { NOTICE_PRIORITY } from "./notice-center";
import { isAnySyncActivityRunning } from "../sync/sync-progress";
import { AuthPendingModal } from "./auth-pending-modal";
import { AutomaticHandlingModal } from "./automatic-handling-modal";
import { ConfigSyncModal } from "./config-sync-modal";
import { ConfirmModal } from "./confirm-modal";

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
  private syncSectionEl: HTMLElement | null = null;
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
    this.syncSectionEl = containerEl.createDiv("easy-sync-settings-group-host easy-sync-settings-sync");
    this.aboutSectionEl = containerEl.createDiv("easy-sync-settings-group-host easy-sync-settings-about");
    this.maintenanceSectionEl = containerEl.createDiv(
      "easy-sync-settings-group-host easy-sync-settings-maintenance",
    );

    // ========================================================================
    // Account — no heading, always visible
    // ========================================================================
    this.renderAccountSection(t);

    // ========================================================================
    // Sync group
    // ========================================================================
    this.renderSyncSection(t);

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
    if (!this.accountSectionEl?.isConnected || !this.syncSectionEl?.isConnected) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.renderAccountSection(t);
    this.renderSyncSection(t);
  }

  refreshSyncState(): void {
    if (!this.syncSectionEl?.isConnected) return;
    this.renderSyncSection(this.plugin.i18n.t.bind(this.plugin.i18n));
  }

  hide(): void {
    super.hide();
    this.accountSectionEl = null;
    this.syncSectionEl = null;
    this.aboutSectionEl = null;
    this.maintenanceSectionEl = null;
  }

  private renderAccountSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.accountSectionEl) return;
    this.accountSectionEl.empty();
    this.renderAccount(this.accountSectionEl, t);
  }

  private renderSyncSection(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    if (!this.syncSectionEl) return;
    this.syncSectionEl.empty();
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
    const syncGroup = new SettingGroup(this.syncSectionEl).setHeading(t("settings.group.sync"));

    if (this.plugin.auth?.authState.isLoggedIn) {
      syncGroup.addSetting((setting) => {
        setting
          .setName(t("settings.firstSync.name"))
          .setDesc(t("settings.firstSync.desc"))
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

    syncGroup.addSetting((setting) => {
      setting
        .setName(t("settings.moreConfig.name"))
        .setDesc(t("settings.moreConfig.desc"))
        .addButton((btn) => {
          btn.setButtonText(t("settings.moreConfig.button"))
            .onClick(() => {
              new ConfigSyncModal(this.plugin).open();
            });
        });
    });

    syncGroup.addSetting((setting) => {
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

    syncGroup.addSetting((setting) => {
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
              this.refreshSyncState();
            });
        });
    });

    if (this.plugin.syncInterval > 0) {
      syncGroup.addSetting((setting) => {
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
    }

    syncGroup.addSetting((setting) => {
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

    aboutGroup.addSetting((setting) => {
      setting
        .setName(t("settings.about.usage.name"))
        .setDesc(t("settings.about.usage.desc"));
    });

    aboutGroup.addSetting((setting) => {
      setting
        .setName(t("settings.about.disclaimer.name"))
        .setDesc(t("settings.about.disclaimer.desc"));
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

  /** Render the account login/logout section (no group heading) */
  private renderAccount(
    containerEl: HTMLElement,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    new Setting(containerEl)
      .setName(t("settings.account.name"))
      .setDesc(
        this.plugin.auth?.isInitializing
          ? t("settings.account.desc.connecting")
          : this.plugin.auth?.authState.isLoggedIn
            ? t("settings.account.desc.loggedIn", { name: this.plugin.auth.authState.displayName || t("general.unknown") })
            : this.plugin.auth?.isPending
              ? t("settings.account.desc.pending")
              : t("settings.account.desc.notLoggedIn"),
      )
      .addButton((btn) => {
        if (this.plugin.auth?.isInitializing) {
          btn.setButtonText(t("settings.account.checking")).setDisabled(true);
        } else if (this.plugin.auth?.authState.isLoggedIn) {
          btn.setButtonText(t("settings.account.logout")).onClick(() => {
            void (async () => {
              await this.plugin.logoutUser();
              this.refreshAuthState();
            })();
          });
        } else if (this.plugin.auth?.isPending) {
          btn
            .setButtonText(t("settings.account.checking"))
            .setCta()
            .onClick(() => {
              void (async () => {
                if (this.plugin.auth?.checkAuthStatus()) {
                  this.refreshAuthState();
                  return;
                }
                const modal = new AuthPendingModal(
                  this.plugin.app,
                  t("settings.account.pendingTitle"),
                  t("settings.account.pendingMessage"),
                  t("settings.account.recheck"),
                  t("settings.account.reopenAuth"),
                );
                const result = await modal.awaitAction();
                if (result.action === "recheck") {
                  if (this.plugin.auth?.checkAuthStatus()) {
                    this.plugin.noticeCenter.show({
                      key: "settings-login-success",
                      message: t("settings.account.loginSuccess"),
                      priority: NOTICE_PRIORITY.action,
                    });
                  } else {
                    this.plugin.noticeCenter.show({
                      key: "settings-login-pending",
                      message: t("settings.account.desc.pending"),
                      priority: NOTICE_PRIORITY.attention,
                    });
                  }
                } else if (result.action === "reopen") {
                  try {
                    await this.plugin.auth?.login();
                  } catch (error) {
                    console.error("EasySync: login error:", error);
                  }
                }
                this.refreshAuthState();
              })();
            });
        } else {
          btn
            .setButtonText(t("settings.account.login"))
            .setCta()
            .onClick(() => {
              void (async () => {
                try {
                  await this.plugin.auth?.login();
                } catch (error) {
                  console.error("EasySync: login error:", error);
                }
                this.refreshAuthState();
              })();
            });
        }
      });
  }
}
