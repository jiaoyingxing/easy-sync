import type { App } from "obsidian";

import {
  addEasySyncFooterButton,
  createEasySyncModalFooter,
  EasySyncModal,
  keepModalFocusOnBody,
} from "./easy-sync-modal";

/**
 * Manual/first-sync warning that the vault sits inside a desktop cloud
 * client's sync directory.
 *
 * The caller owns detection, the session guard and the "today" memory; this
 * modal only presents the already-decided warning. One action only — snooze
 * the reminder for the rest of the local day. Closing via the host's X (or
 * Esc) dismisses this instance without writing the snooze.
 */
export class VaultCloudClientWarningModal extends EasySyncModal<void> {
  constructor(
    app: App,
    private readonly titleText: string,
    private readonly bodyText: string,
    private readonly snoozeLabel: string,
    private readonly onSnooze: () => void,
  ) {
    super(app);
  }

  /** Open the modal and resolve when the user dismisses it (button or X/Esc). */
  awaitDismiss(): Promise<void> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.titleText);
    contentEl.createEl("p", { text: this.bodyText });

    const btnRow = createEasySyncModalFooter(contentEl);
    addEasySyncFooterButton(btnRow, {
      label: this.snoozeLabel,
      variant: "cta",
      onClick: () => {
        this.onSnooze();
        this.settle();
      },
    });
    keepModalFocusOnBody(this);
  }

  onClose(): void {
    // Host X / Esc dismisses this showing without writing the "today" memory.
    this.takePendingResolve()?.();
  }
}
