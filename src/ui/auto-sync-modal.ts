import { Notice, Setting } from "obsidian";
import type EasySyncPlugin from "../main";
import { EasySyncModal } from "./easy-sync-modal";

export class AutoSyncModal extends EasySyncModal {
  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    contentEl.empty();
    contentEl.addClass("easy-sync-auto-sync");
    this.setTitle(t("settings.autoSync.title"));

    const describeSyncInterval = (minutes: number): string =>
      minutes === 0
        ? t("settings.syncInterval.disabledDesc")
        : t("settings.syncInterval.desc", { minutes });

    const describeAutoSyncChangeDelay = (seconds: number): string =>
      seconds === 0
        ? t("settings.autoSyncChangeDelay.disabledDesc")
        : t("settings.autoSyncChangeDelay.desc", { seconds });

    new Setting(contentEl)
      .setName(t("settings.syncInterval.name"))
      .setDesc(describeSyncInterval(this.plugin.syncInterval))
      .addSlider((slider) => {
        // Scheduled sync reads minutes directly: 0 = off (persisted as
        // syncInterval 0), 1–10 = minutes — same shape as the change-delay
        // slider, so the off state displays as 0 on both.
        slider
          .setLimits(0, 10, 1)
          .setValue(this.plugin.syncInterval)
          .onChange(async (value) => {
            const previous = this.plugin.syncInterval;
            this.plugin.syncInterval = value;
            try {
              await this.plugin.saveSyncSettings();
            } catch {
              this.plugin.syncInterval = previous;
              slider.setValue(previous);
              new Notice(t("notice.settingsSaveFailed"));
              return;
            }
            this.plugin.restartAutoSync();
            this.plugin.refreshSettingsTab();
            const desc = slider.sliderEl
              .closest(".setting-item")
              ?.querySelector(".setting-item-description");
            if (desc) {
              desc.textContent = describeSyncInterval(value);
            }
          });
      });

    new Setting(contentEl)
      .setName(t("settings.autoSyncChangeDelay.name"))
      .setDesc(describeAutoSyncChangeDelay(this.plugin.autoSyncChangeDelaySeconds))
      .addSlider((slider) => {
        slider
          .setLimits(0, 10, 1)
          .setValue(this.plugin.autoSyncChangeDelaySeconds)
          .onChange(async (value) => {
            const previous = this.plugin.autoSyncChangeDelaySeconds;
            const masterWasOn = this.plugin.isAutoSyncMasterEnabled();
            this.plugin.setAutoSyncChangeDelaySeconds(value);
            try {
              await this.plugin.saveSyncSettings();
            } catch {
              this.plugin.setAutoSyncChangeDelaySeconds(previous);
              slider.setValue(previous);
              new Notice(t("notice.settingsSaveFailed"));
              return;
            }
            // A delay turn can flip the master switch (last channel on/off);
            // re-arm or release the join/recovery/timer surfaces with it. A
            // plain adjustment keeps the pending dirty window — no restart.
            if (this.plugin.isAutoSyncMasterEnabled() !== masterWasOn) {
              this.plugin.restartAutoSync();
            }
            this.plugin.refreshSettingsTab();
            const desc = slider.sliderEl
              .closest(".setting-item")
              ?.querySelector(".setting-item-description");
            if (desc) {
              desc.textContent = describeAutoSyncChangeDelay(value);
            }
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
