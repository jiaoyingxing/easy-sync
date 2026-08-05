import { ButtonComponent, Modal, Setting, type App } from "obsidian";
import type {
  ManualMutationResolutionChoiceV1,
  ManualMutationResolutionSnapshotV1,
} from "../sync/types";
import type { I18nFn } from "./confirm-modal";

function fileFactText(
  exists: boolean,
  size: number | undefined,
  t: I18nFn,
): string {
  return exists
    ? t("syncView.mutationResolution.present", { size: size ?? 0 })
    : t("syncView.mutationResolution.missing");
}

export class MutationRecoveryResolutionModal extends Modal {
  private resolve:
    ((choice: ManualMutationResolutionChoiceV1 | null) => void) | null = null;

  constructor(
    app: App,
    private readonly snapshot: Readonly<ManualMutationResolutionSnapshotV1>,
    private readonly t: I18nFn,
  ) {
    super(app);
  }

  awaitChoice(): Promise<ManualMutationResolutionChoiceV1 | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(choice: ManualMutationResolutionChoiceV1 | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(choice);
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("easy-sync-mutation-resolution-modal");
    this.setTitle(this.t("syncView.mutationResolution.title"));
    contentEl.createEl("p", {
      text: this.t("syncView.mutationResolution.description", {
        path: this.snapshot.path,
      }),
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName(this.t("syncView.mutationResolution.previousAction"))
      .setDesc(this.t(`syncView.mutationResolution.action.${this.snapshot.previousAction}`));

    const facts = contentEl.createDiv("easy-sync-mutation-resolution-facts");
    const local = facts.createDiv("easy-sync-mutation-resolution-side");
    local.createEl("h3", { text: this.t("syncView.mutationResolution.localTitle") });
    for (const fact of this.snapshot.local) {
      new Setting(local)
        .setName(fact.path)
        .setDesc(fileFactText(fact.exists, fact.size, this.t));
    }
    const remote = facts.createDiv("easy-sync-mutation-resolution-side");
    remote.createEl("h3", { text: this.t("syncView.mutationResolution.remoteTitle") });
    for (const fact of this.snapshot.remote) {
      new Setting(remote)
        .setName(fact.path)
        .setDesc(fileFactText(fact.exists, fact.size, this.t));
    }

    const details = contentEl.createEl("details", {
      cls: "easy-sync-mutation-resolution-details",
    });
    details.createEl("summary", {
      text: this.t("syncView.mutationResolution.technicalDetails"),
    });
    const detailList = details.createEl("ul");
    detailList.createEl("li", {
      text: this.t("syncView.mutationResolution.operationId", {
        value: this.snapshot.sourceOperationId,
      }),
    });
    for (const fact of this.snapshot.local.filter((item) => item.exists)) {
      detailList.createEl("li", {
        text: `${fact.path} · SHA-256 ${fact.hash}`,
      });
    }
    for (const fact of this.snapshot.remote.filter((item) => item.exists)) {
      detailList.createEl("li", {
        text: `${fact.path} · ID ${fact.driveId} · eTag ${fact.eTag} · SHA-256 ${fact.hash}`,
      });
    }

    if (this.snapshot.identical) {
      contentEl.createEl("p", {
        text: this.t("syncView.mutationResolution.identical"),
        cls: "setting-item-description easy-sync-mutation-resolution-identical",
      });
    }

    const actions = contentEl.createDiv(
      "modal-button-container easy-sync-mutation-resolution-actions",
    );
    const localButton = new ButtonComponent(actions)
      .setButtonText(this.t("syncView.mutationResolution.keepLocal"))
      .setDisabled(!this.snapshot.keepLocal.available);
    if (this.snapshot.keepLocal.available) {
      localButton.onClick(() => this.finish("keep-local"));
    }
    const remoteButton = new ButtonComponent(actions)
      .setButtonText(this.t("syncView.mutationResolution.keepRemote"))
      .setDisabled(!this.snapshot.keepRemote.available);
    if (this.snapshot.keepRemote.available) {
      remoteButton.onClick(() => this.finish("keep-remote"));
    }
    new ButtonComponent(actions)
      .setButtonText(this.t("confirm.cancel"))
      .onClick(() => this.finish(null));

    if (!this.snapshot.keepLocal.available || !this.snapshot.keepRemote.available) {
      contentEl.createEl("p", {
        text: this.t("syncView.mutationResolution.unavailable"),
        cls: "setting-item-description",
      });
    }
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(null);
  }
}
