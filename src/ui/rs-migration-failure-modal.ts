/**
 * RsMigrationFailureModal — fail-closed exit of the Remotely Save adoption
 * (carrier plan §11.1 幕6): OneDrive refused the move/copy, nothing changed,
 * and the user gets three real exits — retry later (aborts this round, the
 * adoption choice survives), a plain fresh sync (closes the adoption
 * window), or the manual guide (opened on top; this modal stays).
 */
import { type App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";

export type RsMigrationFailureResult =
  | { action: "retry" }
  | { action: "fresh-sync" }
  | { action: "dismiss" };

export interface RsMigrationFailureViews {
  title: string;
  body: string;
  retryLabel: string;
  freshLabel: string;
  guideLabel: string;
  guideTitle: string;
  guideBody: string;
  guideOk: string;
}

export class RsMigrationGuideModal extends EasySyncModal {
  private resolve: (() => void) | null = null;

  constructor(
    app: App,
    private views: { title: string; body: string; okLabel: string },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.views.title);
    for (const line of this.views.body.split("\n")) {
      contentEl.createEl("p", {
        text: line,
        cls: "setting-item-description",
      });
    }
    const btnRow = contentEl.createDiv("modal-button-container");
    const closeButton = btnRow.createEl("button", {
      text: this.views.okLabel,
      cls: "mod-cta",
      type: "button",
    });
    closeButton.addEventListener("click", () => {
      this.close();
    });
  }

  onClose(): void {
    this.resolve?.();
    this.resolve = null;
  }

  /** Resolves when the guide has been read (or dismissed). */
  awaitRead(): Promise<void> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
}

export class RsMigrationFailureModal extends EasySyncModal {
  private resolve: ((value: RsMigrationFailureResult) => void) | null = null;
  private finished = false;

  constructor(
    app: App,
    private views: RsMigrationFailureViews,
  ) {
    super(app);
  }

  awaitAction(): Promise<RsMigrationFailureResult> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(result: RsMigrationFailureResult): void {
    if (this.finished) return;
    this.finished = true;
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(result);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.views.title);

    contentEl.createEl("p", {
      text: this.views.body,
      cls: "setting-item-description",
    });

    const btnRow = contentEl.createDiv("modal-button-container");
    const retryButton = btnRow.createEl("button", {
      text: this.views.retryLabel,
      cls: "mod-cta",
      type: "button",
    });
    retryButton.addEventListener("click", () => {
      this.finish({ action: "retry" });
    });

    const freshButton = btnRow.createEl("button", {
      text: this.views.freshLabel,
      type: "button",
    });
    freshButton.addEventListener("click", () => {
      this.finish({ action: "fresh-sync" });
    });

    const guideButton = btnRow.createEl("button", {
      text: this.views.guideLabel,
      cls: "mod-link",
      type: "button",
    });
    guideButton.addEventListener("click", () => {
      void new RsMigrationGuideModal(this.app, {
        title: this.views.guideTitle,
        body: this.views.guideBody,
        okLabel: this.views.guideOk,
      }).awaitRead();
    });
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ action: "dismiss" });
  }
}
