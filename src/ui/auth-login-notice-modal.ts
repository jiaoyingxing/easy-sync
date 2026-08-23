import { Modal, type App } from "obsidian";

/**
 * AuthLoginNoticeModal — login-gate notice shown before the method chooser on
 * every fresh login.
 *
 * Shows the agreed three short lines (numbered, large text) with a single
 * "Continue" button. Dismissing the modal (Esc / X) cancels the login flow;
 * nothing is started until the user confirms.
 */
export class AuthLoginNoticeModal extends Modal {
  private resolve: ((value: boolean) => void) | null = null;

  constructor(
    app: App,
    private title: string,
    private lines: readonly string[],
    private continueLabel: string,
  ) {
    super(app);
  }

  /** Open and resolve true on Continue, false on dismiss/close. */
  awaitContinue(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    const body = contentEl.createDiv("easy-sync-login-notice");
    for (const line of this.lines) {
      body.createEl("p", {
        text: line,
        cls: "easy-sync-login-notice-line",
      });
    }

    const btnRow = contentEl.createDiv("modal-button-container");
    const continueBtn = btnRow.createEl("button", {
      text: this.continueLabel,
      cls: "mod-cta",
    });
    continueBtn.addEventListener("click", () => {
      this.finish(true);
    });
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(false);
  }

  private finish(value: boolean): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(value);
  }
}