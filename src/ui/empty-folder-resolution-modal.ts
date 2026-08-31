import { ButtonComponent, Setting, type App } from "obsidian";
import type { I18nFn } from "./confirm-modal";
import { applyDestructiveButton } from "./destructive-button";
import { EasySyncModal } from "./easy-sync-modal";
import type {
  EmptyFolderResolutionSnapshotV1,
  FolderLocationResolutionSnapshotV1,
  FolderSubtreeReviewSnapshotV1,
} from "../sync/empty-folder-resolution";

export type EmptyFolderResolutionChoice =
  | { action: "restore" }
  | { action: "bind"; candidatePath: string }
  | { action: "delete" }
  | { action: "delete-subtree" }
  | { action: "keep-local-location" }
  | { action: "keep-remote-location" };

export class EmptyFolderResolutionModal extends EasySyncModal {
  private resolve:
    ((choice: EmptyFolderResolutionChoice | null) => void) | null = null;

  constructor(
    app: App,
    private readonly snapshot: Readonly<
      EmptyFolderResolutionSnapshotV1
      | FolderSubtreeReviewSnapshotV1
      | FolderLocationResolutionSnapshotV1
    >,
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
    if ("localPath" in this.snapshot) {
      this.renderLocationReview(contentEl);
      return;
    }
    if ("members" in this.snapshot) {
      this.renderSubtreeReview(contentEl);
      return;
    }
    this.setTitle(this.t("syncView.emptyFolder.title"));
    contentEl.createEl("p", {
      text: this.t("syncView.emptyFolder.description", {
        path: this.snapshot.path,
      }),
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName(this.t("syncView.emptyFolder.restoreTitle"))
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
      deleteSetting.addButton((button) => applyDestructiveButton(button)
        .setButtonText(this.t("syncView.emptyFolder.deleteConfirm"))
        .onClick(() => this.finish({ action: "delete" })));
    }

    const actions = contentEl.createDiv(
      "modal-button-container easy-sync-empty-folder-actions",
    );
    new ButtonComponent(actions)
      .setButtonText(this.t("confirm.cancel"))
      .onClick(() => this.finish(null));
  }

  private renderLocationReview(contentEl: HTMLElement): void {
    if (!("localPath" in this.snapshot)) return;
    const snapshot = this.snapshot;
    this.setTitle(this.t("syncView.folderLocation.title"));
    contentEl.createEl("p", {
      text: this.t("syncView.folderLocation.description", {
        path: snapshot.path,
      }),
      cls: "setting-item-description",
    });
    new Setting(contentEl)
      .setName(this.t("syncView.folderLocation.localTitle"))
      .setDesc(snapshot.localPath)
      .addButton((button) => button
        .setButtonText(this.t("syncView.folderLocation.keepLocal"))
        .onClick(() => this.finish({ action: "keep-local-location" })));
    new Setting(contentEl)
      .setName(this.t("syncView.folderLocation.remoteTitle"))
      .setDesc(snapshot.remotePath)
      .addButton((button) => button
        .setButtonText(this.t("syncView.folderLocation.keepRemote"))
        .onClick(() => this.finish({ action: "keep-remote-location" })));
    const actions = contentEl.createDiv(
      "modal-button-container easy-sync-empty-folder-actions",
    );
    new ButtonComponent(actions)
      .setButtonText(this.t("confirm.cancel"))
      .onClick(() => this.finish(null));
  }

  private renderSubtreeReview(contentEl: HTMLElement): void {
    if (!("members" in this.snapshot)) return;
    const snapshot = this.snapshot;
    this.setTitle(this.t("syncView.folderSubtree.title"));
    contentEl.createEl("p", {
      text: this.t("syncView.folderSubtree.description", {
        path: snapshot.path,
      }),
      cls: "setting-item-description",
    });
    const folders = snapshot.members.filter((member) => member.kind === "folder");
    const files = snapshot.members.filter((member) => member.kind === "file");
    contentEl.createEl("p", {
      text: this.t("syncView.folderSubtree.summary", {
        folders: folders.length,
        files: files.length,
      }),
      cls: "setting-item-description",
    });
    const details = contentEl.createEl("details");
    details.createEl("summary", { text: snapshot.path });
    const list = details.createEl("ul");
    for (const member of snapshot.members) {
      list.createEl("li", { text: member.path });
    }
    new Setting(contentEl)
      .setName(this.t("syncView.folderSubtree.restoreTitle"))
      .setDesc(this.t("syncView.folderSubtree.restoreDescription"))
      .addButton((button) => button
        .setButtonText(this.t("syncView.folderSubtree.restore"))
        .setCta()
        .onClick(() => this.finish({ action: "restore" })));
    const root = snapshot.members[0];
    const deleteSetting = new Setting(contentEl)
      .setName(root?.remoteCTag
        ? this.t("syncView.folderSubtree.deleteTitle")
        : this.t("syncView.folderSubtree.deleteUnavailableTitle"))
      .setDesc(root?.remoteCTag
        ? this.t("syncView.folderSubtree.deleteDescription")
        : this.t("syncView.folderSubtree.deleteUnavailableDescription"));
    if (root?.remoteCTag) {
      deleteSetting.addButton((button) => applyDestructiveButton(button)
        .setButtonText(this.t("syncView.folderSubtree.delete"))
        .onClick(() => this.finish({ action: "delete-subtree" })));
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
