import {
  ExtraButtonComponent,
  FuzzySuggestModal,
  Modal,
  Notice,
  Setting,
  TFolder,
} from "obsidian";
import type EasySyncPlugin from "../main";
import { SyncPathSettingsUpdateError } from "../main";
import { getConfigDir } from "../obsidian-compat";
import {
  isPathExcludedByFolders,
  normalizeExcludedFolders,
} from "../sync/local-scanner";

class SyncExclusionFolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(
    private plugin: EasySyncPlugin,
    private onChoose: (folder: TFolder) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder(plugin.i18n.t("settings.syncExclusion.pickerPlaceholder"));
  }

  getItems(): TFolder[] {
    const configDir = getConfigDir(this.plugin.app.vault);
    return this.plugin.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) =>
        normalizeExcludedFolders([folder.path], configDir).length === 1
        && !isPathExcludedByFolders(folder.path, this.plugin.excludedFolders),
      )
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

interface ExclusionChipOptions {
  disabled?: boolean;
  removeLabel: (path: string) => string;
  onRemove: (path: string) => Promise<boolean>;
}

export function renderExcludedFolderChips(
  containerEl: HTMLElement,
  paths: readonly string[],
  options: ExclusionChipOptions,
): void {
  containerEl.empty();
  containerEl.addClass("easy-sync-exclusion-chips");
  containerEl.setAttribute("role", "list");

  for (const path of paths) {
    const chipEl = containerEl.createDiv({
      cls: "easy-sync-exclusion-chip",
      attr: { role: "listitem" },
    });
    chipEl.createSpan({
      cls: "easy-sync-exclusion-chip-label",
      text: path,
    });

    let removing = false;
    const removeLabel = options.removeLabel(path);
    const removeButton = new ExtraButtonComponent(chipEl)
      .setIcon("x")
      .setTooltip(removeLabel)
      .setDisabled(options.disabled ?? false)
      .onClick(async () => {
        if (removing) return;
        removing = true;
        removeButton.setDisabled(true);
        const removed = await options.onRemove(path);
        if (!removed && removeButton.extraSettingsEl.isConnected) {
          removing = false;
          removeButton.setDisabled(options.disabled ?? false);
        }
      });
    removeButton.extraSettingsEl.addClass("easy-sync-exclusion-chip-remove");
    removeButton.extraSettingsEl.setAttribute("aria-label", removeLabel);
  }
}

export async function updateExcludedFoldersFromUi(
  plugin: EasySyncPlugin,
  paths: readonly string[],
): Promise<boolean> {
  try {
    await plugin.updateExcludedFolders(paths);
    return true;
  } catch (error) {
    const key = error instanceof SyncPathSettingsUpdateError
      ? error.code === "busy"
        ? "notice.syncPathSettings.busy"
        : "notice.syncPathSettings.recovery"
      : "notice.syncPathSettings.failed";
    new Notice(plugin.i18n.t(key));
    return false;
  }
}

export class SyncExclusionModal extends Modal {
  private saving = false;

  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.modalEl.addClass("easy-sync-settings-modal");
    this.contentEl.empty();
    this.setTitle(t("settings.syncExclusion.title"));
    this.contentEl.createEl("p", {
      text: t("settings.syncExclusion.intro"),
      cls: "setting-item-description",
    });

    const folderSetting = new Setting(this.contentEl)
      .setName(t("settings.syncExclusion.folders.name"))
      .addButton((button) => {
        button
          .setButtonText(t("settings.syncExclusion.add"))
          .setDisabled(this.saving)
          .onClick(() => {
            new SyncExclusionFolderPicker(
              this.plugin,
              (folder) => {
                void this.addFolder(folder.path);
              },
            ).open();
          });
      });

    if (this.plugin.excludedFolders.length === 0) {
      folderSetting.setDesc(t("settings.syncExclusion.empty"));
      return;
    }

    const chipsEl = folderSetting.descEl.createDiv();
    renderExcludedFolderChips(chipsEl, this.plugin.excludedFolders, {
      disabled: this.saving,
      removeLabel: (path) => t("settings.syncExclusion.removeFolder", { path }),
      onRemove: (path) => this.removeFolder(path),
    });
  }

  private async addFolder(path: string): Promise<void> {
    await this.updateFolders([...this.plugin.excludedFolders, path]);
  }

  private async removeFolder(path: string): Promise<boolean> {
    return await this.updateFolders(
      this.plugin.excludedFolders.filter((current) => current !== path),
    );
  }

  private async updateFolders(paths: string[]): Promise<boolean> {
    if (this.saving) return false;
    this.saving = true;
    try {
      return await updateExcludedFoldersFromUi(this.plugin, paths);
    } finally {
      this.saving = false;
      this.render();
    }
  }
}
