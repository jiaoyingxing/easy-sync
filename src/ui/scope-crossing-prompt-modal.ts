/**
 * Two-positive-action prompt for an immediate out-of-scope move detection
 * (slice-2). The vault has no pre-move veto hook: the move already happened
 * when the plugin sees the rename event, so the user decides right away
 * whether to undo the move or confirm leaving sync. Dismissing the modal
 * (Escape / backdrop) performs nothing — the pending-row fallback keeps the
 * decision available on the next plan.
 */
import { type App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";

export type ScopeCrossingPromptChoice = "restore" | "confirm";

export class ScopeCrossingPromptModal extends EasySyncModal {
  private resolve: ((choice: ScopeCrossingPromptChoice | null) => void) | null =
    null;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private batchLine: string | null,
    private restoreLabel: string,
    private confirmLabel: string,
  ) {
    super(app);
  }

  awaitChoice(): Promise<ScopeCrossingPromptChoice | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(choice: ScopeCrossingPromptChoice | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(choice);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    contentEl.createEl("p", {
      text: this.message,
      cls: "setting-item-description",
    });
    if (this.batchLine) {
      contentEl.createEl("p", {
        text: this.batchLine,
        cls: "setting-item-description",
      });
    }

    const btnRow = contentEl.createDiv("modal-button-container");
    const restoreBtn = btnRow.createEl("button", {
      text: this.restoreLabel,
      cls: "mod-cta",
    });
    restoreBtn.addEventListener("click", () => {
      this.finish("restore");
    });

    const confirmBtn = btnRow.createEl("button", {
      text: this.confirmLabel,
      cls: "mod-warning",
    });
    confirmBtn.addEventListener("click", () => {
      this.finish("confirm");
    });
  }

  onClose(): void {
    // Dismissing without a choice keeps the pending-row fallback.
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(null);
  }
}
