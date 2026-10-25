import type { App } from "obsidian";

import { EasySyncModal } from "./easy-sync-modal";

type UpdateReminderChoice = "snooze" | "skipVersion";

/**
 * Snooze chooser for the sidebar update row (方案单 20260915-0025 §四 跳过层).
 * Short confirm modal: one intro line, a native select with the two snooze
 * semantics, and confirm / cancel. Cancel and close resolve null and leave
 * all state untouched — the row keeps showing until a real choice is made.
 */
export class UpdateReminderModal extends EasySyncModal<UpdateReminderChoice | null> {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private snoozeLabel: string,
    private skipVersionLabel: string,
    private confirmLabel: string,
    private cancelLabel: string,
  ) {
    super(app);
  }

  /** Open the modal and resolve "snooze" | "skipVersion", or null on cancel. */
  awaitSelection(): Promise<UpdateReminderChoice | null> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // 纯提示框：正文即全部内容，正文放大走 styles.css 白名单。
    this.modalEl.addClass("easy-sync-prompt-modal");
    this.setTitle(this.title);

    contentEl.createEl("p", {
      text: this.body,
      cls: "setting-item-description",
    });

    const select = contentEl.createEl("select", { cls: "dropdown" });
    select.createEl("option", { value: "snooze", text: this.snoozeLabel });
    select.createEl("option", {
      value: "skipVersion",
      text: this.skipVersionLabel,
    });
    select.value = "snooze";

    const btnRow = contentEl.createDiv("modal-button-container");
    const cancelBtn = btnRow.createEl("button", { text: this.cancelLabel });
    cancelBtn.addEventListener("click", () => {
      this.settle(null);
    });
    const confirmBtn = btnRow.createEl("button", {
      text: this.confirmLabel,
      cls: "mod-cta",
    });
    confirmBtn.addEventListener("click", () => {
      this.settle(select.value === "skipVersion" ? "skipVersion" : "snooze");
    });
  }

  onClose(): void {
    // Zero side effect: closing without confirm must not touch snooze state.
    this.takePendingResolve()?.(null);
  }
}
