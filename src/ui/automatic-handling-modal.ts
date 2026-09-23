import { Notice, Setting } from "obsidian";
import type EasySyncPlugin from "../main";
import { EasySyncModal } from "./easy-sync-modal";

export class AutomaticHandlingModal extends EasySyncModal {
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
      cls: "setting-item-description easy-sync-modal-intro",
    });

    new Setting(contentEl)
      .setName(t("settings.automaticHandling.autoDeleteLocalFiles.name"))
      .setDesc(t("settings.automaticHandling.autoDeleteLocalFiles.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.automaticHandlingPolicy.autoDeleteLocalFiles)
          .onChange(async (value) => {
            try {
              await this.plugin.updateAutomaticHandlingPolicy({
                ...this.plugin.automaticHandlingPolicy,
                autoDeleteLocalFiles: value,
              });
            } catch {
              // The policy write already rolled the value back in memory, so
              // read it instead of a captured copy: the control then shows
              // exactly what was persisted.
              toggle.setValue(
                this.plugin.automaticHandlingPolicy.autoDeleteLocalFiles,
              );
              new Notice(t("notice.settingsSaveFailed"));
            }
          });
      });

    new Setting(contentEl)
      .setName(t("settings.automaticHandling.mergeNonOverlappingText.name"))
      .setDesc(t("settings.automaticHandling.mergeNonOverlappingText.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.automaticHandlingPolicy.mergeNonOverlappingText)
          .onChange(async (value) => {
            try {
              await this.plugin.updateAutomaticHandlingPolicy({
                ...this.plugin.automaticHandlingPolicy,
                mergeNonOverlappingText: value,
              });
            } catch {
              toggle.setValue(
                this.plugin.automaticHandlingPolicy.mergeNonOverlappingText,
              );
              new Notice(t("notice.settingsSaveFailed"));
            }
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
