/**
 * 设置页（1.13+ 声明式页面）行实现。
 *
 * 每个函数把一行设置装配到一个宿主 `Setting` 上，供 `settings-tab.ts` 的
 * 声明式页面调用；写入一律走与 <1.13 弹框同一批 plugin API，文案一律复用
 * 现役 i18n 键，所以两条路径的设置语义与用词一致。
 *
 * 已登记的双轨分歧（2026-10-12，S1）：<1.13 弹框保留各自的行实现（未重写），
 * 本模块是 1.13+ 的单一实现；两边以「行名 ↔ 定义树」对账钉防漏登记，弹框侧
 * 回接到本模块列为 S2 候选。
 *
 * 宿主边界：`update()` 会重跑行渲染回调但不重建行节点（Resojot 1.13.7 实测），
 * 因此每个 applier 先把本行自己拥有的槽位复位（控件槽 `controlEl` 与自绘
 * desc 槽）再重画，保证反复重跑不重复追加。
 */
import { Notice, Setting } from "obsidian";
import type { DropdownComponent, TextComponent } from "obsidian";
import type EasySyncPlugin from "../main";
import type { CommunityPluginInventoryItem } from "../sync/community-plugin-inventory";
import type { SyncPathSettings } from "../main";
import { SyncPathSettingsUpdateError } from "../sync/sync-path-settings-error";
import { isPluginSelected } from "../sync/community-plugin-sync-policy";
import { cloneCommunityPluginSyncPolicy } from "../sync/community-plugin-sync-policy";
import {
  updateAllCommunityPluginSelections,
  type CommunityPluginSelectionColumn,
} from "../sync/community-plugin-selection-update";
import {
  MAX_FILE_SIZE_PRESET_OPTIONS_MB,
  UNLIMITED_MAX_FILE_SIZE_MB,
} from "../sync/types";
import { ConfirmModal, type I18nFn } from "./confirm-modal";
import { ConfigSyncModal, isPluginRowHiddenByCloudCleanup } from "./config-sync-modal";
import {
  openSyncExclusionFolderPicker,
  parseMaxFileSizeInput,
  renderExcludedFolderChips,
  resolveMaxFileSizeSelection,
  updateExcludedFoldersFromUi,
} from "./sync-exclusion-modal";
import {
  ensureSliderValueEl,
  paintSliderDisplay,
} from "./auto-sync-modal";

/** 每个页面宿主自持一份的钩子（声明式页面用；弹框不经过本模块）。 */
export interface SettingsPageRowHost {
  readonly plugin: EasySyncPlugin;
  readonly t: I18nFn;
  /** 结构性变化后的宿主刷新（声明式＝`update()`）。 */
  refresh(): void;
  /** 已落盘的排除项变更（设置页在 `hide()` 统一触发计划重算）。 */
  noteExclusionChange(): void;
}

/** 幂等的自绘 desc 槽：按目标类名复用宿主节点，先清空再交给调用方重画。 */
function ensureDescSlot(setting: Setting, cls: string): HTMLElement {
  const existing = setting.descEl.querySelector<HTMLElement>(`:scope > .${cls}`);
  if (existing) {
    existing.empty();
    return existing;
  }
  return setting.descEl.createDiv({ cls });
}

/** 说明句的落点：`.setting-item-description` 文本元素（宿主形状随版本略有差异时回退到 descEl）。 */
function descTextEl(setting: Setting): HTMLElement {
  return setting.descEl.querySelector<HTMLElement>(
    ":scope > .setting-item-description",
  ) ?? setting.descEl;
}

/** 同步范围族写入失败的统一提示（与弹框 `showSyncPathSettingsError` 同口径）。 */
function noticeForSyncPathSettingsError(
  plugin: EasySyncPlugin,
  error: unknown,
): void {
  const key = error instanceof SyncPathSettingsUpdateError
    ? error.code === "busy"
      ? "notice.syncPathSettings.busy"
      : "notice.syncPathSettings.recovery"
    : "notice.syncPathSettings.failed";
  new Notice(plugin.i18n.t(key));
}

// ===========================================================================
// 同步范围页
// ===========================================================================

export interface ScopeToggleRowConfig {
  key: string;
  get: () => boolean;
  patch: (value: boolean) => Partial<SyncPathSettings>;
}

/** 范围开关行（核心插件／编辑器设置／外观设置／主题与代码片段／快捷键／书签）。 */
export function applyScopeToggleRow(
  setting: Setting,
  host: SettingsPageRowHost,
  config: ScopeToggleRowConfig,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  setting
    .setName(t(`${config.key}.name`))
    .setDesc(t(`${config.key}.desc`))
    .addToggle((toggle) => {
      toggle.setValue(config.get()).onChange(async (value) => {
        const previous = config.get();
        toggle.setDisabled(true);
        try {
          await plugin.updateSyncPathSettings(config.patch(value));
        } catch (error) {
          toggle.setValue(previous);
          noticeForSyncPathSettingsError(plugin, error);
        } finally {
          toggle.setDisabled(false);
        }
      });
    });
}

/** 社区插件范围缓存（跨行共享；进入范围页后台加载一次）。 */
const scopeInventoryCache = new WeakMap<
  EasySyncPlugin,
  CommunityPluginInventoryItem[]
>();

function isScopeParticipationEnabled(
  plugin: EasySyncPlugin,
  pluginId: string,
  column: CommunityPluginSelectionColumn,
): boolean {
  const filesEnabled = plugin.isCommunityPluginFilesParticipationEnabled(pluginId);
  if (column === "files") return filesEnabled;
  return plugin.syncPluginData
    && filesEnabled
    && isPluginSelected(plugin.communityPluginSyncPolicy.data, pluginId);
}

/** 社区插件／社区插件数据行：管理齿轮＋开关＋选项 chip（与弹框同口径）。 */
export function applyCommunityPluginScopeRow(
  setting: Setting,
  host: SettingsPageRowHost,
  column: CommunityPluginSelectionColumn,
): void {
  const { plugin, t } = host;
  let busy = false;
  let pending: boolean | null = null;
  setting.controlEl.empty();
  const getEnabled = (): boolean =>
    column === "files" ? plugin.syncCommunityPlugins : plugin.syncPluginData;

  let toggleRef: { setValue: (v: boolean) => unknown; setDisabled: (v: boolean) => unknown } | null = null;
  let manageRef: { setDisabled: (v: boolean) => unknown } | null = null;

  const setChipText = (text: string): void => {
    chipEl.setText(text);
    if (text === "") chipEl.addClass("is-hidden");
    else chipEl.removeClass("is-hidden");
  };

  const computeChipText = (): string => {
    const inventory = scopeInventoryCache.get(plugin);
    if (!inventory) {
      void plugin.getCommunityPluginInventory().then((items) => {
        scopeInventoryCache.set(plugin, items);
        renderChip();
      }).catch(() => {
        // 清单加载失败：保持 chip 隐藏（与弹框同口径，错误由管理面承接）。
      });
      return "";
    }
    const cleaned = plugin.getCommunityPluginCloudCleanupMarkers();
    const rows = (column === "files"
      ? inventory
      : inventory.filter((item) =>
        isScopeParticipationEnabled(plugin, item.id, "files")))
      .filter((item) => !isPluginRowHiddenByCloudCleanup(
        column,
        item.local,
        cleaned.some((marker) => marker.pluginId === item.id),
      ));
    if (rows.length === 0) return "";
    const enabledCount = rows.filter((item) =>
      isScopeParticipationEnabled(plugin, item.id, column)).length;
    return t("settings.communityPlugins.selectionSummary", {
      enabled: enabledCount,
      total: rows.length,
    });
  };

  const renderChip = (): void => {
    const enabled = pending ?? getEnabled();
    const active = enabled && !busy;
    if (!active) {
      setChipText("");
      return;
    }
    setChipText(computeChipText());
  };

  const refreshRow = (): void => {
    const enabled = pending ?? getEnabled();
    toggleRef?.setValue(enabled);
    toggleRef?.setDisabled(busy);
    manageRef?.setDisabled(busy);
    renderChip();
  };

  // 行类与弹框同源（styles.css 的 .setting-item-name flex+gap），没有它 chip
  // 会紧贴行名。chip 挂点必须在最后一次 setName 之后：setName 会重写 nameEl
  // 内容，先挂上去的 chip 节点会被冲掉（真机 1.13：同步 chip 消失）；
  // update() 重跑时同样由 setName 先清场再重建。
  setting.setClass("easy-sync-community-plugin-scope-setting");
  setting
    .setName(t(`${column === "files" ? "settings.syncCommunityPlugins" : "settings.syncPluginData"}.name`))
    .setDesc(t(`${column === "files" ? "settings.syncCommunityPlugins" : "settings.syncPluginData"}.desc`))
    .addButton((button) => {
      manageRef = button;
      button
        .setIcon("settings")
        .setTooltip(t(
          column === "files"
            ? "settings.communityPlugins.manage.files"
            : "settings.communityPlugins.manage.data",
        ))
        .onClick(() => {
          new ConfigSyncModal(
            plugin,
            column === "files" ? "community-plugin-files" : "community-plugin-data",
            () => renderChip(),
          ).open();
        });
      button.buttonEl.addClass("clickable-icon");
      button.buttonEl.setAttribute(
        "aria-label",
        t(
          column === "files"
            ? "settings.communityPlugins.manage.files"
            : "settings.communityPlugins.manage.data",
        ),
      );
    })
    .addToggle((toggle) => {
      toggleRef = toggle;
      toggle.setValue(getEnabled()).onChange((value) => {
        void (async () => {
          if (busy) return;
          // 宿主重绘触发的 onChange（值已一致）不是用户动作。
          if (value === getEnabled()) return;
          if (column === "data" && value && !plugin.syncCommunityPlugins) {
            refreshRow();
            new Notice(t("notice.communityPlugins.enableFilesFirst"));
            return;
          }
          const requiresExperimentalConfirmation = column === "data" && value;
          if (!requiresExperimentalConfirmation) pending = value;
          busy = true;
          refreshRow();
          try {
            if (column === "files") {
              await plugin.updateCommunityPluginFilesScope(value);
              return;
            }
            let inventory = scopeInventoryCache.get(plugin) ?? [];
            if (value && !scopeInventoryCache.has(plugin)) {
              inventory = await plugin.getCommunityPluginInventory();
              scopeInventoryCache.set(plugin, inventory);
            }
            const knownPluginIds = inventory
              .filter((item) =>
                isScopeParticipationEnabled(plugin, item.id, "files")
                && (
                  item.dataLocally
                  || item.dataRemotely
                  || item.dataHistoricallyPresent === true
                ))
              .map((item) => item.id);
            if (requiresExperimentalConfirmation) {
              const confirmed = await new ConfirmModal(
                plugin.app,
                t("settings.communityPlugins.data.experimentalConfirmTitle"),
                t("settings.communityPlugins.data.experimentalConfirm"),
                t("confirm.cancel"),
                t,
                {
                  steps: [
                    t(
                      "settings.communityPlugins.data.experimentalBulkStep.shared",
                      { count: knownPluginIds.length },
                    ),
                    t("settings.communityPlugins.data.experimentalBulkStep.replace"),
                    t("settings.communityPlugins.data.experimentalBulkStep.conflict"),
                  ],
                  warning: t("settings.communityPlugins.data.experimentalWarning"),
                  danger: true,
                },
              ).awaitConfirm();
              if (!confirmed) return;
              pending = value;
              refreshRow();
            }
            const next = updateAllCommunityPluginSelections(
              {
                filesEnabled: plugin.syncCommunityPlugins,
                dataEnabled: plugin.syncPluginData,
                policy: cloneCommunityPluginSyncPolicy(plugin.communityPluginSyncPolicy),
              },
              column,
              value,
              knownPluginIds,
            );
            await plugin.updateSyncPathSettings({
              syncCommunityPlugins: next.filesEnabled,
              syncPluginData: next.dataEnabled,
              communityPluginSyncPolicy: next.policy,
            });
          } catch (error) {
            noticeForSyncPathSettingsError(plugin, error);
          } finally {
            pending = null;
            busy = false;
            refreshRow();
          }
        })();
      });
    });

  const chipEl = setting.nameEl.createSpan("easy-sync-plugin-selection-chip");
  chipEl.addClass("is-hidden");
  renderChip();
}

/** 不同步的文件夹行：添加按钮（候选按需拉取）＋可移除 chips。 */
export function applyExcludedFoldersRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  let loading = false;
  setting.controlEl.empty();

  const chipHost = ensureDescSlot(setting, "easy-sync-exclusion-chips-host");
  const renderChips = (): void => {
    if (plugin.excludedFolders.length === 0) {
      chipHost.setText(t("settings.syncExclusion.empty"));
      chipHost.removeClass("easy-sync-exclusion-chips");
      return;
    }
    renderExcludedFolderChips(chipHost, plugin.excludedFolders, {
      removeLabel: (path) => t("settings.syncExclusion.removeFolder", { path }),
      onRemove: async (path) => {
        const saved = await updateExcludedFoldersFromUi(
          plugin,
          plugin.excludedFolders.filter((current) => current !== path),
        );
        if (saved) {
          host.noteExclusionChange();
          renderChips();
          // 根级入口的「排除 {n} 项」现值随之重估（声明式＝update()）。
          host.refresh();
        }
        return saved;
      },
    });
  };

  setting
    .setName(t("settings.syncExclusion.folders.name"))
    .addButton((button) => {
      button.setButtonText(t("settings.syncExclusion.add")).onClick(() => {
        void (async () => {
          if (loading) return;
          loading = true;
          button.setDisabled(true);
          try {
            const snapshot = await plugin.createSyncExclusionFolderSnapshot();
            openSyncExclusionFolderPicker(
              plugin,
              snapshot.remoteFolderPaths,
              (folder) => {
                void (async () => {
                  const saved = await updateExcludedFoldersFromUi(
                    plugin,
                    [...plugin.excludedFolders, folder.path],
                  );
                  if (saved) {
                    host.noteExclusionChange();
                    renderChips();
                  }
                })();
              },
            );
          } catch (error) {
            plugin.diag.warn(
              "state",
              "failed to prepare cloud folder exclusion candidates",
              error,
            );
            // 失败回退沿用现役：以本机候选打开选择器。
            openSyncExclusionFolderPicker(plugin, [], (folder) => {
              void (async () => {
                const saved = await updateExcludedFoldersFromUi(
                  plugin,
                  [...plugin.excludedFolders, folder.path],
                );
                if (saved) {
                  host.noteExclusionChange();
                  renderChips();
                }
              })();
            });
          } finally {
            loading = false;
            button.setDisabled(false);
          }
        })();
      });
    });
  renderChips();
}

/** 大型文件排除行（预设下拉＋自定义输入；超限文件不参与同步）。 */
export function applyMaxFileSizeRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  let textRef: TextComponent | null = null;
  let dropdownRef: DropdownComponent | null = null;
  let descEl: HTMLElement | null = null;
  const descText = (): string =>
    plugin.syncMaxFileSizeMb === UNLIMITED_MAX_FILE_SIZE_MB
      ? t("settings.maxFileSize.descUnlimited")
      : t("settings.maxFileSize.desc", { size: `${plugin.syncMaxFileSizeMb} MB` });

  const syncDropdown = (): void => {
    const selection = resolveMaxFileSizeSelection(plugin.syncMaxFileSizeMb);
    dropdownRef?.setValue(
      selection.kind === "preset" ? String(selection.value) : selection.kind,
    );
  };
  const refreshDesc = (): void => {
    if (descEl) descEl.setText(descText());
  };
  const syncCustomText = (): void => {
    if (!textRef) return;
    const selection = resolveMaxFileSizeSelection(plugin.syncMaxFileSizeMb);
    textRef.inputEl.hidden = selection.kind !== "custom";
    textRef.setValue(
      selection.kind === "custom" ? String(plugin.syncMaxFileSizeMb) : "",
    );
    syncDropdown();
    refreshDesc();
  };
  const persist = async (value: number): Promise<void> => {
    const previous = plugin.syncMaxFileSizeMb;
    plugin.syncMaxFileSizeMb = value;
    try {
      await plugin.saveSyncSettings();
    } catch {
      plugin.syncMaxFileSizeMb = previous;
      plugin.applyMaxFileSize();
      syncDropdown();
      new Notice(t("notice.settingsSaveFailed"));
      return;
    }
    plugin.applyMaxFileSize();
    refreshDesc();
  };

  setting
    .setName(t("settings.maxFileSize.name"))
    .setDesc(descText())
    .addText((text) => {
      textRef = text;
      const selection = resolveMaxFileSizeSelection(plugin.syncMaxFileSizeMb);
      text.setValue(selection.kind === "custom" ? String(plugin.syncMaxFileSizeMb) : "");
      text.setPlaceholder(t("settings.maxFileSize.customPlaceholder"));
      text.inputEl.inputMode = "numeric";
      text.inputEl.hidden = selection.kind !== "custom";
      text.inputEl.setAttribute(
        "aria-label",
        t("settings.maxFileSize.customPlaceholder"),
      );
      text.inputEl.addEventListener("blur", () => {
        if (parseMaxFileSizeInput(text.getValue()) === null) {
          new Notice(t("settings.maxFileSize.invalidValue"));
          text.setValue(
            plugin.syncMaxFileSizeMb > 0 ? String(plugin.syncMaxFileSizeMb) : "",
          );
        }
        syncCustomText();
      });
      text.onChange((raw) => {
        const parsed = parseMaxFileSizeInput(raw);
        if (parsed !== null) void persist(parsed);
      });
    })
    .addDropdown((dropdown) => {
      dropdownRef = dropdown;
      for (const preset of MAX_FILE_SIZE_PRESET_OPTIONS_MB) {
        dropdown.addOption(
          String(preset),
          t("settings.maxFileSize.optionMb", { size: preset }),
        );
      }
      dropdown.addOption("unlimited", t("settings.maxFileSize.optionUnlimited"));
      dropdown.addOption("custom", t("settings.maxFileSize.optionCustom"));
      syncDropdown();
      dropdown.onChange((value) => {
        if (value === "custom") {
          if (textRef) {
            textRef.inputEl.hidden = false;
            textRef.inputEl.focus();
          }
          return;
        }
        if (textRef) textRef.inputEl.hidden = true;
        const next = value === "unlimited"
          ? UNLIMITED_MAX_FILE_SIZE_MB
          : Number.parseInt(value, 10);
        if (!Number.isFinite(next)) return;
        void persist(next);
      });
    });
  descEl = descTextEl(setting);
  refreshDesc();
}

// ===========================================================================
// 自动同步页
// ===========================================================================

/** 定时同步滑条（0＝关闭该项；值句与弹框同口径）。 */
export function applySyncIntervalRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  let lastValue = plugin.syncInterval;
  let descEl: HTMLElement | null = null;
  const describe = (minutes: number): string =>
    minutes === 0
      ? t("settings.syncInterval.disabledDesc")
      : t("settings.syncInterval.desc", { minutes });
  const renderDesc = (): void => descEl?.setText(describe(lastValue));

  setting
    .setName(t("settings.syncInterval.name"))
    .setDesc(describe(lastValue))
    .addSlider((slider) => {
      slider
        .setLimits(0, 10, 1)
        .setValue(plugin.syncInterval)
        .onChange(async (value) => {
          paintSliderDisplay(slider, value);
          lastValue = value;
          renderDesc();
          const previous = plugin.syncInterval;
          plugin.syncInterval = value;
          try {
            await plugin.saveSyncSettings();
          } catch {
            plugin.syncInterval = previous;
            lastValue = previous;
            slider.setValue(previous);
            renderDesc();
            new Notice(t("notice.settingsSaveFailed"));
            return;
          }
          plugin.restartAutoSync();
          host.refresh();
        });
      ensureSliderValueEl(slider);
      paintSliderDisplay(slider);
      slider.sliderEl.addEventListener("input", () => paintSliderDisplay(slider));
    });
  descEl = descTextEl(setting);
  renderDesc();
}

/** 修改后触发同步滑条（0＝关闭该项；值句与弹框同口径）。 */
export function applyAutoSyncChangeDelayRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  let lastValue = plugin.autoSyncChangeDelaySeconds;
  let descEl: HTMLElement | null = null;
  const describe = (seconds: number): string =>
    seconds === 0
      ? t("settings.autoSyncChangeDelay.disabledDesc")
      : t("settings.autoSyncChangeDelay.desc", { seconds });
  const renderDesc = (): void => descEl?.setText(describe(lastValue));

  setting
    .setName(t("settings.autoSyncChangeDelay.name"))
    .setDesc(describe(lastValue))
    .addSlider((slider) => {
      slider
        .setLimits(0, 10, 1)
        .setValue(plugin.autoSyncChangeDelaySeconds)
        .onChange(async (value) => {
          paintSliderDisplay(slider, value);
          lastValue = value;
          renderDesc();
          const previous = plugin.autoSyncChangeDelaySeconds;
          const masterWasOn = plugin.isAutoSyncMasterEnabled();
          plugin.setAutoSyncChangeDelaySeconds(value);
          try {
            await plugin.saveSyncSettings();
          } catch {
            plugin.setAutoSyncChangeDelaySeconds(previous);
            lastValue = previous;
            slider.setValue(previous);
            renderDesc();
            new Notice(t("notice.settingsSaveFailed"));
            return;
          }
          // 延迟通道翻转总开关（最后一条通道开/关）时重挂自动同步面；
          // 普通微调保留在途脏窗口，不重挂。
          if (plugin.isAutoSyncMasterEnabled() !== masterWasOn) {
            plugin.restartAutoSync();
          }
          host.refresh();
        });
      ensureSliderValueEl(slider);
      paintSliderDisplay(slider);
      slider.sliderEl.addEventListener("input", () => paintSliderDisplay(slider));
    });
  descEl = descTextEl(setting);
  renderDesc();
}

/** 启动后立即同步开关（默认开启；翻总开关时与两条滑条同规重挂自动同步面）。 */
export function applyAutoSyncOnStartupRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  setting
    .setName(t("settings.autoSyncOnStartup.name"))
    .setDesc(t("settings.autoSyncOnStartup.desc"))
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.autoSyncOnStartup)
        .onChange(async (value) => {
          const previous = plugin.autoSyncOnStartup;
          const masterWasOn = plugin.isAutoSyncMasterEnabled();
          plugin.setAutoSyncOnStartup(value);
          try {
            await plugin.saveSyncSettings();
          } catch {
            plugin.setAutoSyncOnStartup(previous);
            toggle.setValue(previous);
            new Notice(t("notice.settingsSaveFailed"));
            return;
          }
          // 本通道可以独自决定总开关（它是唯一开着、或最后关掉的通道时）：
          // 翻转总开关时与两条滑条同规重挂自动同步面，普通微调不动。
          if (plugin.isAutoSyncMasterEnabled() !== masterWasOn) {
            plugin.restartAutoSync();
          }
          host.refresh();
        });
    });
}

/** 自动处理开关行（policy 键直接落盘，失败回滚）。 */
export function applyAutomaticHandlingRow(
  setting: Setting,
  host: SettingsPageRowHost,
  policyKey: "autoDeleteLocalFiles" | "mergeNonOverlappingText",
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  setting
    .setName(t(`settings.automaticHandling.${policyKey}.name`))
    .setDesc(t(`settings.automaticHandling.${policyKey}.desc`))
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.automaticHandlingPolicy[policyKey])
        .onChange(async (value) => {
          try {
            await plugin.updateAutomaticHandlingPolicy({
              ...plugin.automaticHandlingPolicy,
              [policyKey]: value,
            });
          } catch {
            // 写入失败时策略已在内存回滚，直接读现值把控件拨回。
            toggle.setValue(plugin.automaticHandlingPolicy[policyKey]);
            new Notice(t("notice.settingsSaveFailed"));
          }
        });
    });
}

// ===========================================================================
// 显示页
// ===========================================================================

/** 通知弹窗档位行（下拉＋档位说明句）。 */
export function applyNotificationPopupsRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  const hintEl = ensureDescSlot(setting, "easy-sync-notification-popups-hint");
  const renderHint = (): void => {
    hintEl.setText(t(`settings.notificationPopups.hint.${plugin.notificationPopups}`));
  };
  setting
    .setName(t("settings.notificationPopups.name"))
    .addDropdown((dropdown) => {
      dropdown
        .addOption("all", t("settings.notificationPopups.option.all"))
        .addOption("important", t("settings.notificationPopups.option.important"))
        .addOption("off", t("settings.notificationPopups.option.off"))
        .setValue(plugin.notificationPopups)
        .onChange(async (value) => {
          const previous = plugin.notificationPopups;
          plugin.notificationPopups =
            value === "important" || value === "off" ? value : "all";
          try {
            await plugin.saveSyncSettings();
          } catch {
            plugin.notificationPopups = previous;
            dropdown.setValue(previous);
            new Notice(t("notice.settingsSaveFailed"));
            return;
          }
          plugin.applyNotificationPopups();
          renderHint();
          // 根级「显示」入口的现值随档位重估。
          host.refresh();
        });
    });
    renderHint();
}

/** 移动端常驻状态图标开关行（仅移动端渲染与生效；桌面端不进强显路径）。 */
export function applyMobileStatusBarRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  setting
    .setName(t("settings.mobileStatusBar.name"))
    .setDesc(t("settings.mobileStatusBar.desc"))
    .addToggle((toggle) => {
      toggle
        .setValue(plugin.mobileStatusBar)
        .onChange(async (value) => {
          const previous = plugin.mobileStatusBar;
          plugin.mobileStatusBar = value;
          try {
            await plugin.saveSyncSettings();
          } catch {
            // 写入失败时内存已回滚，直接读现值把控件拨回。
            plugin.mobileStatusBar = previous;
            toggle.setValue(previous);
            new Notice(t("notice.settingsSaveFailed"));
            return;
          }
          plugin.applyMobileStatusBar();
        });
    });
}

// ===========================================================================
// 维护页
// ===========================================================================

/**
 * 件③ 反转入口：「不再提醒的本机文件」行（名＋说明＋一个按钮）。按钮只清空忽略
 * 记忆（忽略记忆本来就只影响提醒）；不并入「重置同步状态」——重置仍是最后
 * 兜底，不吸收常规动作。行本身的显示条件由页面声明侧判定（单向且计数 > 0）。
 */
export function applyLocalOnlyIgnoredRow(
  setting: Setting,
  host: SettingsPageRowHost,
): void {
  const { plugin, t } = host;
  setting.controlEl.empty();
  setting
    .setName(t("settings.localOnlyIgnored.name"))
    .setDesc(t("settings.localOnlyIgnored.desc", {
      count: plugin.getIgnoredLocalOnlyCount(),
    }))
    .addButton((button) => {
      button.setButtonText(t("settings.localOnlyIgnored.button")).onClick(() => {
        void (async () => {
          await plugin.clearLocalOnlyIgnores();
          // 清空后这一行按条件自己退场（说明里的计数也随宿主重画重估）。
          host.refresh();
        })();
      });
    });
}
