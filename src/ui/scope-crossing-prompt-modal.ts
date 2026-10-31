/**
 * Two-positive-action prompt for an immediate out-of-scope move detection
 * (slice-2). The vault has no pre-move veto hook: the move already happened
 * when the plugin sees the rename event, so the user decides right away
 * whether to undo the move or confirm leaving sync. Dismissing the modal
 * (Escape / backdrop) performs nothing — the pending-row fallback keeps the
 * decision available on the next plan.
 */
import { type App } from "obsidian";
import {
  addEasySyncFooterButton,
  createEasySyncModalFooter,
  EasySyncModal,
} from "./easy-sync-modal";

type ScopeCrossingPromptChoice = "restore" | "confirm";

export class ScopeCrossingPromptModal extends EasySyncModal<ScopeCrossingPromptChoice | null> {
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
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // 纯确认框：正文即全部内容，正文放大走 styles.css 白名单。
    this.modalEl.addClass("easy-sync-prompt-modal");
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

    // Two positive actions, no cancel: dismissing (Escape / backdrop) is the
    // zero-side-effect exit, so neither button carries the cancel styling.
    const btnRow = createEasySyncModalFooter(contentEl);
    addEasySyncFooterButton(btnRow, {
      label: this.restoreLabel,
      variant: "cta",
      onClick: () => {
        this.settle("restore");
      },
    });
    addEasySyncFooterButton(btnRow, {
      label: this.confirmLabel,
      variant: "destructive",
      onClick: () => {
        this.settle("confirm");
      },
    });
  }

  onClose(): void {
    // Dismissing without a choice keeps the pending-row fallback.
    this.takePendingResolve()?.(null);
  }
}
