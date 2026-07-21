import { Modal, Setting } from "obsidian";
import type EasySyncPlugin from "../main";

export class AutomaticHandlingModal extends Modal {
  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    contentEl.empty();
    contentEl.addClass("easy-sync-automatic-handling");
    this.setTitle(t("settings.automaticHandling.title"));

    contentEl.createEl("p", {
      text: t("settings.automaticHandling.intro"),
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName(t("settings.automaticHandling.autoDeleteLocalFiles.name"))
      .setDesc(t("settings.automaticHandling.autoDeleteLocalFiles.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.automaticHandlingPolicy.autoDeleteLocalFiles)
          .onChange(async (value) => {
            await this.plugin.updateAutomaticHandlingPolicy({
              ...this.plugin.automaticHandlingPolicy,
              autoDeleteLocalFiles: value,
            });
          });
      });

    new Setting(contentEl)
      .setName(t("settings.automaticHandling.mergeNonOverlappingText.name"))
      .setDesc(t("settings.automaticHandling.mergeNonOverlappingText.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.automaticHandlingPolicy.mergeNonOverlappingText)
          .onChange(async (value) => {
            await this.plugin.updateAutomaticHandlingPolicy({
              ...this.plugin.automaticHandlingPolicy,
              mergeNonOverlappingText: value,
            });
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
