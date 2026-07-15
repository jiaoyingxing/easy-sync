/**
 * AuthPendingModal — shown when the user clicks "检查登录状态" during an
 * in-progress OAuth flow. Gives them two options:
 *  1. "重新检查" — check if auth completed since last poll tick
 *  2. "重新打开授权" — re-open the browser for a fresh login attempt
 *
 * This is the fallback mechanism: if auto-polling doesn't detect completion,
 * or the user closed their browser, this gives them a clear recovery path
 * rather than a button that silently does nothing.
 */

import { Modal, type App } from "obsidian";

export type PendingModalResult =
  | { action: "recheck" }
  | { action: "reopen" }
  | { action: "dismiss" };

export class AuthPendingModal extends Modal {
  private resolve: ((value: PendingModalResult) => void) | null = null;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private recheckLabel: string,
    private reopenLabel: string,
  ) {
    super(app);
  }

  /** Open the modal and return the user's chosen action */
  awaitAction(): Promise<PendingModalResult> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(result: PendingModalResult): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(result);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    contentEl.createEl("p", {
      text: this.message,
      cls: "setting-item-description",
    });

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

    const recheckBtn = btnRow.createEl("button", {
      text: this.recheckLabel,
      cls: "mod-cta",
    });
    recheckBtn.addEventListener("click", () => {
      this.finish({ action: "recheck" });
    });

    const reopenBtn = btnRow.createEl("button", {
      text: this.reopenLabel,
    });
    reopenBtn.addEventListener("click", () => {
      this.finish({ action: "reopen" });
    });
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ action: "dismiss" });
  }
}
