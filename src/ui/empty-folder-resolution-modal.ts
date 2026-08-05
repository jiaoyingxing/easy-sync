import { ButtonComponent, Modal, Setting, type App } from "obsidian";
import type { I18nFn } from "./confirm-modal";
import type {
  EmptyFolderResolutionSnapshotV1,
} from "../sync/empty-folder-resolution";

export type EmptyFolderResolutionChoice =
  | { action: "restore" }
  | { action: "bind"; candidatePath: string }
  | { action: "delete" };

export class EmptyFolderResolutionModal extends Modal {
  private resolve:
    ((choice: EmptyFolderResolutionChoice | null) => void) | null = null;

  constructor(
    app: App,
    private readonly snapshot: Readonly<EmptyFolderResolutionSnapshotV1>,
    private readonly t: I18nFn,
  ) {
    super(app);
  }

  awaitChoice(): Promise<EmptyFolderResolutionChoice | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(choice: EmptyFolderResolutionChoice | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(choice);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("easy-sync-empty-folder-modal");
    this.setTitle(this.t("syncView.emptyFolder.title"));
    contentEl.createEl("p", {
      text: this.t("syncView.emptyFolder.description", {
        path: this.snapshot.path,
      }),
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName(this.t("syncView.emptyFolder.restore"))
      .setDesc(this.t("syncView.emptyFolder.restoreDescription"))
      .addButton((button) => button
        .setButtonText(this.t("syncView.emptyFolder.restore"))
        .setCta()
        .onClick(() => this.finish({ action: "restore" })));

    contentEl.createEl("h3", {
      text: this.t("syncView.emptyFolder.bindTitle"),
    });
    contentEl.createEl("p", {
      text: this.t("syncView.emptyFolder.bindDescription"),
      cls: "setting-item-description",
    });
    for (const candidatePath of this.snapshot.candidatePaths) {
      new Setting(contentEl)
        .setName(candidatePath)
        .addButton((button) => button
          .setButtonText(this.t("syncView.emptyFolder.bind"))
          .onClick(() => this.finish({
            action: "bind",
            candidatePath,
          })));
    }

    const deleteSetting = new Setting(contentEl)
      .setName(this.snapshot.remoteCTag
        ? this.t("syncView.emptyFolder.delete")
        : this.t("syncView.emptyFolder.deleteUnavailable"))
      .setDesc(this.snapshot.remoteCTag
        ? this.t("syncView.emptyFolder.deleteDescription")
        : this.t("syncView.emptyFolder.deleteUnavailableDescription"));
    if (this.snapshot.remoteCTag) {
      deleteSetting.addButton((button) => button
        .setButtonText(this.t("syncView.emptyFolder.delete"))
        .setWarning()
        .onClick(() => this.finish({ action: "delete" })));
    }

    const actions = contentEl.createDiv(
      "modal-button-container easy-sync-empty-folder-actions",
    );
    new ButtonComponent(actions)
      .setButtonText(this.t("confirm.cancel"))
      .onClick(() => this.finish(null));
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(null);
  }
}
