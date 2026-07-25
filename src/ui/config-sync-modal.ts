/**
 * ConfigSyncModal — Vault config sync toggle panel
 *
 * Opens as an Obsidian Modal, containing all 8 config sync toggles
 * plus per-plugin sync granularity settings under "Community plugins".
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
import { getConfigDir, getEasySyncPaths } from "../obsidian-compat";
import type { PluginSyncMode } from "../sync/types";

const PLUGIN_SYNC_MODE_OPTIONS: Array<{
  value: PluginSyncMode;
  labelKey: string;
}> = [
  { value: "all", labelKey: "settings.pluginSyncMode.all" },
  { value: "whitelist", labelKey: "settings.pluginSyncMode.whitelist" },
  { value: "blacklist", labelKey: "settings.pluginSyncMode.blacklist" },
];

export class ConfigSyncModal extends Modal {
  private pluginListContainerEl: HTMLElement | null = null;
  private pluginListPromise: Promise<string[]> | null = null;
  /** Track which rows need toggling so onChange can distinguish the event target. */
  private pluginToggleSettings: Map<string, Setting> = new Map();

  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  async onOpen() {
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
                // Re-render plugin granularity when community plugins toggle changes
                if (ct.key === "settings.syncCommunityPlugins") {
                  void this.renderPluginGranularity();
                }
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

    // ── Plugin sync granularity (below community plugins toggle) ──
    this.pluginListContainerEl = contentEl.createDiv("easy-sync-plugin-list");
    void this.renderPluginGranularity();
  }

  /** Render the plugin sync mode dropdown and (when applicable) the plugin
   *  checkbox list. Only shown when community plugin sync is enabled. */
  private async renderPluginGranularity(): Promise<void> {
    const el = this.pluginListContainerEl;
    if (!el?.isConnected) return;
    el.empty();
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);

    if (!this.plugin.syncCommunityPlugins) return;

    // ── Mode selector ──
    let modeDropdown: import("obsidian").DropdownComponent | undefined;
    new Setting(el)
      .setName(t("settings.pluginSyncMode.name"))
      .setDesc(t("settings.pluginSyncMode.desc"))
      .addDropdown((dropdown) => {
        modeDropdown = dropdown;
        for (const opt of PLUGIN_SYNC_MODE_OPTIONS) {
          dropdown.addOption(opt.value, t(opt.labelKey));
        }
        dropdown.setValue(this.plugin.pluginSyncMode);
        dropdown.onChange(async (value) => {
          if (!isPluginSyncMode(value)) return;
          try {
            await this.plugin.updateSyncPathSettings({
              pluginSyncMode: value,
            });
            void this.renderPluginGranularity();
          } catch (error) {
            dropdown?.setValue(this.plugin.pluginSyncMode);
            const key = error instanceof SyncPathSettingsUpdateError
              ? error.code === "busy"
                ? "notice.syncPathSettings.busy"
                : "notice.syncPathSettings.recovery"
              : "notice.syncPathSettings.failed";
            new Notice(t(key));
          }
        });
      });

    if (this.plugin.pluginSyncMode === "all") return;

    // ── Plugin list (whitelist or blacklist mode) ──
    const plugins = await this.loadInstalledPlugins();

    // Heading + hint
    const listHeading = el.createEl("div", { cls: "setting-item" });
    const info = listHeading.createEl("div", { cls: "setting-item-info" });
    info.createEl("div", { cls: "setting-item-name", text: t("settings.pluginSyncMode.pluginList") });
    info.createEl("div", {
      cls: "setting-item-description",
      text: plugins.length > 0
        ? t("settings.pluginSyncMode.depHint")
        : t("settings.pluginSyncMode.noPlugins"),
    });

    this.pluginToggleSettings.clear();
    for (const pluginId of plugins) {
      const isChecked = this.plugin.pluginSyncList.includes(pluginId);
      const setting = new Setting(el)
        .setName(pluginId)
        .addToggle((toggle) => {
          toggle.setValue(isChecked);
          toggle.onChange(async (_value) => {
            const list = this.plugin.pluginSyncList.includes(pluginId)
              ? this.plugin.pluginSyncList.filter((id) => id !== pluginId)
              : [...this.plugin.pluginSyncList, pluginId];
            try {
              await this.plugin.updateSyncPathSettings({ pluginSyncList: list });
            } catch (error) {
              toggle.setValue(isChecked);
              const key = error instanceof SyncPathSettingsUpdateError
                ? error.code === "busy"
                  ? "notice.syncPathSettings.busy"
                  : "notice.syncPathSettings.recovery"
                : "notice.syncPathSettings.failed";
              new Notice(t(key));
            }
          });
        });
      this.pluginToggleSettings.set(pluginId, setting);
    }
  }

  /** Scan .obsidian/plugins/ and return sorted plugin IDs (excluding easy-sync itself). */
  private async loadInstalledPlugins(): Promise<string[]> {
    if (this.pluginListPromise) return this.pluginListPromise;
    this.pluginListPromise = this.scanPlugins();
    return this.pluginListPromise;
  }

  private async scanPlugins(): Promise<string[]> {
    const { pluginRoot } = getEasySyncPaths(
      getConfigDir(this.plugin.app.vault),
      this.plugin.manifest.id,
    );
    try {
      const listResult = await this.plugin.app.vault.adapter.list(pluginRoot);
      const plugins = listResult.folders
        .map((folder) => {
          const segments = folder.replace(/\\/g, "/").split("/");
          return segments[segments.length - 1];
        })
        .filter((id) => id && id !== this.plugin.manifest.id)
        .sort((a, b) => a.localeCompare(b));
      return plugins;
    } catch {
      return [];
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.pluginListContainerEl = null;
    this.pluginListPromise = null;
    this.pluginToggleSettings.clear();
  }
}

function isPluginSyncMode(value: unknown): value is PluginSyncMode {
  return value === "all" || value === "whitelist" || value === "blacklist";
}
