import { Setting } from "obsidian";
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

    const describeAutoSyncChangeDelay = (seconds: number): string =>
      seconds === 0
        ? t("settings.autoSyncChangeDelay.disabledDesc")
        : t("settings.autoSyncChangeDelay.desc", { seconds });

    new Setting(contentEl)
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

    new Setting(contentEl)
      .setName(t("settings.autoSyncChangeDelay.name"))
      .setDesc(describeAutoSyncChangeDelay(this.plugin.autoSyncChangeDelaySeconds))
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
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
