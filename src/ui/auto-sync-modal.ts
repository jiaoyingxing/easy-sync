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

    // Auto sync off is stored as interval 0, which is below the slider's own
    // range: leaving it enabled would let one drag re-enable auto sync without
    // the switch ever moving. Park the thumb at the minimum and disable it.
    const scheduledSyncOff = this.plugin.syncInterval === 0;

    new Setting(contentEl)
      .setName(t("settings.syncInterval.name"))
      .setDesc(describeSyncInterval(this.plugin.syncInterval))
      .addSlider((slider) => {
        slider
          .setLimits(3, 10, 1)
          .setValue(scheduledSyncOff ? 3 : this.plugin.syncInterval)
          .setDisabled(scheduledSyncOff)
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
            this.plugin.setAutoSyncChangeDelaySeconds(value);
            try {
              await this.plugin.saveSyncSettings();
            } catch {
              this.plugin.setAutoSyncChangeDelaySeconds(previous);
              slider.setValue(previous);
              new Notice(t("notice.settingsSaveFailed"));
              return;
            }
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
