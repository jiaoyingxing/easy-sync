/**
 * ConfigSyncModal — Vault config sync toggle panel
 *
 * Opens as an Obsidian Modal, containing all 8 config sync toggles.
 * Avoids cluttering the main settings page with low-frequency options.
 *
 * All toggles use native Obsidian Setting components.  No text input —
 * safe on mobile (no soft keyboard interference).
 */

import { Modal, Setting } from "obsidian";
import type EasySyncPlugin from "../main";

export class ConfigSyncModal extends Modal {
  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  onOpen() {
    const { contentEl } = this;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    contentEl.empty();
    this.setTitle(t("settings.moreConfig.title"));

    const toggles: Array<{
      key: string;
      get: () => boolean;
      set: (v: boolean) => void;
    }> = [
      { key: "settings.syncPluginFiles",
        get: () => this.plugin.syncPluginFiles,
        set: (v) => { this.plugin.syncPluginFiles = v; } },
      { key: "settings.syncEditor",
        get: () => this.plugin.syncEditorSettings,
        set: (v) => { this.plugin.syncEditorSettings = v; } },
      { key: "settings.syncAppearance",
        get: () => this.plugin.syncAppearance,
        set: (v) => { this.plugin.syncAppearance = v; } },
      { key: "settings.syncThemes",
        get: () => this.plugin.syncThemes,
        set: (v) => { this.plugin.syncThemes = v; } },
      { key: "settings.syncHotkeys",
        get: () => this.plugin.syncHotkeys,
        set: (v) => { this.plugin.syncHotkeys = v; } },
      { key: "settings.syncCorePlugins",
        get: () => this.plugin.syncCorePlugins,
        set: (v) => { this.plugin.syncCorePlugins = v; } },
      { key: "settings.syncCommunityPlugins",
        get: () => this.plugin.syncCommunityPlugins,
        set: (v) => { this.plugin.syncCommunityPlugins = v; } },
      { key: "settings.syncPluginData",
        get: () => this.plugin.syncPluginData,
        set: (v) => { this.plugin.syncPluginData = v; } },
    ];

    for (const ct of toggles) {
      new Setting(contentEl)
        .setName(t(ct.key + ".name"))
        .setDesc(t(ct.key + ".desc"))
        .addToggle((toggle) => {
          toggle
            .setValue(ct.get())
            .onChange(async (value) => {
              ct.set(value);
              await this.plugin.saveSyncSettings();
              this.plugin.applyPluginFilesSetting();
            });
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
