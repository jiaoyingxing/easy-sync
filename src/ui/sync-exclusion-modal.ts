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

export interface SyncExclusionFolderCandidate {
  path: string;
}

export function buildSyncExclusionFolderCandidates(
  localFolderPaths: readonly string[],
  remoteFolderPaths: readonly string[],
  excludedFolders: readonly string[],
  configDir: string,
): SyncExclusionFolderCandidate[] {
  const unique = new Map<string, SyncExclusionFolderCandidate>();
  for (const candidate of [...localFolderPaths, ...remoteFolderPaths]) {
    const [normalized] = normalizeExcludedFolders([candidate], configDir);
    if (
      !normalized
      || isPathExcludedByFolders(normalized, excludedFolders)
    ) continue;
    const key = normalized.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, { path: normalized });
  }
  return [...unique.values()].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

export class SyncExclusionEditSession {
  private savedChange = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly hadPendingReview: boolean) {}

  markSavedChange(): void {
    this.savedChange = true;
  }

  close(recalculate: () => Promise<void>): Promise<void> {
    this.closePromise ??=
      this.savedChange && this.hadPendingReview
        ? recalculate()
        : Promise.resolve();
    return this.closePromise;
  }
}

class SyncExclusionFolderPicker
  extends FuzzySuggestModal<SyncExclusionFolderCandidate> {
  constructor(
    private plugin: EasySyncPlugin,
    private remoteFolderPaths: readonly string[],
    private onChoose: (folder: SyncExclusionFolderCandidate) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder(plugin.i18n.t("settings.syncExclusion.pickerPlaceholder"));
  }

  getItems(): SyncExclusionFolderCandidate[] {
    const configDir = getConfigDir(this.plugin.app.vault);
    const localFolderPaths = this.plugin.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path);
    return buildSyncExclusionFolderCandidates(
      localFolderPaths,
      this.remoteFolderPaths,
      this.plugin.excludedFolders,
      configDir,
    );
  }

  getItemText(folder: SyncExclusionFolderCandidate): string {
    return folder.path;
  }

  onChooseItem(folder: SyncExclusionFolderCandidate): void {
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
  private initialized = false;
  private closed = false;
  private remoteFolderPaths: string[] = [];
  private editSession: SyncExclusionEditSession | null = null;
  private initialization: Promise<void> = Promise.resolve();
  private activeSave: Promise<boolean> = Promise.resolve(false);

  constructor(private plugin: EasySyncPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.closed = false;
    this.initialized = false;
    this.render();
    this.initialization = this.initialize();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    void this.finalizeClose();
  }

  private async initialize(): Promise<void> {
    try {
      const snapshot = await this.plugin.createSyncExclusionFolderSnapshot();
      this.remoteFolderPaths = snapshot.remoteFolderPaths;
      this.editSession = new SyncExclusionEditSession(
        snapshot.hadPendingReview,
      );
    } catch (error) {
      this.remoteFolderPaths = [];
      this.editSession = new SyncExclusionEditSession(
        this.plugin.state?.planReviewActive ?? false,
      );
      this.plugin.diag.warn(
        "state",
        "failed to prepare cloud folder exclusion candidates",
        error,
      );
    } finally {
      this.initialized = true;
      if (!this.closed) this.render();
    }
  }

  private async finalizeClose(): Promise<void> {
    try {
      await this.initialization;
      await this.activeSave;
      await this.editSession?.close(
        () => this.plugin.rebuildPlanReview(),
      );
    } catch (error) {
      this.plugin.diag.warn(
        "state",
        "failed to recalculate the sync plan after exclusions changed",
        error,
      );
    }
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
          .setDisabled(this.saving || !this.initialized)
          .onClick(() => {
            new SyncExclusionFolderPicker(
              this.plugin,
              this.remoteFolderPaths,
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
    if (this.saving || !this.initialized || this.closed || !this.editSession) {
      return false;
    }
    this.saving = true;
    const save = (async () => {
      const before = [...this.plugin.excludedFolders];
      const saved = await updateExcludedFoldersFromUi(this.plugin, paths);
      if (
        saved
        && (
          before.length !== this.plugin.excludedFolders.length
          || before.some(
            (path, index) => path !== this.plugin.excludedFolders[index],
          )
        )
      ) {
        this.editSession?.markSavedChange();
      }
      return saved;
    })();
    this.activeSave = save;
    try {
      return await save;
    } finally {
      this.saving = false;
      if (!this.closed) this.render();
    }
  }
}
