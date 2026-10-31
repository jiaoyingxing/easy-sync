import { Setting, type App } from "obsidian";
import type { I18nFn } from "./confirm-modal";
import {
  addEasySyncFooterButton,
  createEasySyncModalFooter,
  EasySyncModal,
} from "./easy-sync-modal";
import { applyDestructiveButton } from "./destructive-button";
import type {
  EmptyFolderResolutionSnapshotV1,
  FolderLocationResolutionSnapshotV1,
  FolderSubtreeReviewSnapshotV1,
} from "../sync/empty-folder-resolution";

type EmptyFolderResolutionChoice =
  | { action: "restore" }
  | { action: "bind"; candidatePath: string }
  | { action: "delete" }
  | { action: "delete-subtree" }
  | { action: "keep-local-location" }
  | { action: "keep-remote-location" };

export class EmptyFolderResolutionModal extends EasySyncModal<EmptyFolderResolutionChoice | null> {
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
    return this.awaitResult();
  }

  /** One resolution modal at a time: same path rejected, another replaces. */
  override open(): void {
    const key = (this.snapshot as { path?: string }).path ?? null;
    if (!this.takeOverSingleInstance(key, { replace: true })) {
      this.settle(null);
      return;
    }
    super.open();
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("easy-sync-empty-folder-modal", "easy-sync-modal-wide");
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
        .onClick(() => this.settle({ action: "restore" })));

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
          .onClick(() => this.settle({
            action: "bind",
            candidatePath,
          })));
    }

    const deleteSetting = new Setting(contentEl)
      .setName(this.snapshot.remoteETag
        ? this.t("syncView.emptyFolder.delete")
        : this.t("syncView.emptyFolder.deleteUnavailable"))
      .setDesc(this.snapshot.remoteETag
        ? this.t("syncView.emptyFolder.deleteDescription")
        : this.t("syncView.emptyFolder.deleteUnavailableDescription"));
    if (this.snapshot.remoteETag) {
      deleteSetting.addButton((button) => applyDestructiveButton(button)
        .setButtonText(this.t("syncView.emptyFolder.deleteConfirm"))
        .onClick(() => this.settle({ action: "delete" })));
    }

    this.renderCancelFooter(contentEl);
  }

  /** The three review shapes share one cancel-only footer (divided: the
   *  interactive rows above it decide, the footer only exits). */
  private renderCancelFooter(contentEl: HTMLElement): void {
    const actions = createEasySyncModalFooter(contentEl, { divided: true });
    addEasySyncFooterButton(actions, {
      label: this.t("confirm.cancel"),
      onClick: () => this.settle(null),
    });
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
        .onClick(() => this.settle({ action: "keep-local-location" })));
    new Setting(contentEl)
      .setName(this.t("syncView.folderLocation.remoteTitle"))
      .setDesc(snapshot.remotePath)
      .addButton((button) => button
        .setButtonText(this.t("syncView.folderLocation.keepRemote"))
        .onClick(() => this.settle({ action: "keep-remote-location" })));
    this.renderCancelFooter(contentEl);
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
        .onClick(() => this.settle({ action: "restore" })));
    const root = snapshot.members[0];
    const deleteSetting = new Setting(contentEl)
      .setName(root?.remoteETag
        ? this.t("syncView.folderSubtree.deleteTitle")
        : this.t("syncView.folderSubtree.deleteUnavailableTitle"))
      .setDesc(root?.remoteETag
        ? this.t("syncView.folderSubtree.deleteDescription")
        : this.t("syncView.folderSubtree.deleteUnavailableDescription"));
    if (root?.remoteETag) {
      deleteSetting.addButton((button) => applyDestructiveButton(button)
        .setButtonText(this.t("syncView.folderSubtree.delete"))
        .onClick(() => this.settle({ action: "delete-subtree" })));
    }
    this.renderCancelFooter(contentEl);
  }

  override onClose(): void {
    this.releaseSingleInstance();
    this.takePendingResolve()?.(null);
  }
}
