/**
 * ConfigSyncModal — Vault config sync toggle panel
 *
 * Opens as an Obsidian Modal, containing all 8 config sync toggles.
 * Avoids cluttering the main settings page with low-frequency options.
 *
 * All toggles use native Obsidian Setting components.  No text input —
 * safe on mobile (no soft keyboard interference).
 */

import { Modal, Notice, Setting } from "obsidian";
import {
  SyncPathSettingsUpdateError,
  type SyncPathSettings,
} from "../main";
import type EasySyncPlugin from "../main";

export class ConfigSyncModal extends Modal {
  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  onOpen() {
    const { contentEl } = this;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.modalEl.addClass("easy-sync-settings-modal");
    contentEl.empty();
    this.setTitle(t("settings.syncScope.title"));

    const toggles: Array<{
      key: string;
      get: () => boolean;
      patch: (value: boolean) => Partial<SyncPathSettings>;
    }> = [
      { key: "settings.syncPluginFiles",
        get: () => this.plugin.syncPluginFiles,
        patch: (value) => ({ syncPluginFiles: value }) },
      { key: "settings.syncEditor",
        get: () => this.plugin.syncEditorSettings,
        patch: (value) => ({ syncEditorSettings: value }) },
      { key: "settings.syncAppearance",
        get: () => this.plugin.syncAppearance,
        patch: (value) => ({ syncAppearance: value }) },
      { key: "settings.syncThemes",
        get: () => this.plugin.syncThemes,
        patch: (value) => ({ syncThemes: value }) },
      { key: "settings.syncHotkeys",
        get: () => this.plugin.syncHotkeys,
        patch: (value) => ({ syncHotkeys: value }) },
      { key: "settings.syncCorePlugins",
        get: () => this.plugin.syncCorePlugins,
        patch: (value) => ({ syncCorePlugins: value }) },
      { key: "settings.syncCommunityPlugins",
        get: () => this.plugin.syncCommunityPlugins,
        patch: (value) => ({ syncCommunityPlugins: value }) },
      { key: "settings.syncPluginData",
        get: () => this.plugin.syncPluginData,
        patch: (value) => ({ syncPluginData: value }) },
    ];

    for (const ct of toggles) {
      new Setting(contentEl)
        .setName(t(ct.key + ".name"))
        .setDesc(t(ct.key + ".desc"))
        .addToggle((toggle) => {
          toggle
            .setValue(ct.get())
            .onChange(async (value) => {
              const previous = ct.get();
              try {
                await this.plugin.updateSyncPathSettings(ct.patch(value));
              } catch (error) {
                toggle.setValue(previous);
                const key = error instanceof SyncPathSettingsUpdateError
                  ? error.code === "busy"
                    ? "notice.syncPathSettings.busy"
                    : "notice.syncPathSettings.recovery"
                  : "notice.syncPathSettings.failed";
                new Notice(t(key));
              }
            });
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
