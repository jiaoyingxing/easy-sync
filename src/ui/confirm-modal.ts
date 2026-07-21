/**
 * SyncPlanAlertModal — lightweight, non-blocking notification.
 *
 * Used after generating a sync plan that needs review (first sync or
 * threshold exceeded). Shows a message and a single button that opens
 * the sidebar. The plan is already persisted to state — dismissing the
 * alert does not discard it.
 */
export class SyncPlanAlertModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private buttonLabel: string,
    private onViewPlan: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    contentEl.createEl("p", {
      text: this.message,
      cls: "setting-item-description",
    });

    const btnRow = contentEl.createDiv("modal-button-container");
    const viewBtn = btnRow.createEl("button", {
      text: this.buttonLabel,
      cls: "mod-cta",
    });
    viewBtn.addEventListener("click", () => {
      this.onViewPlan();
      this.close();
    });
  }

  onClose(): void {
    // No-op: the plan preview persists in sidebar regardless.
  }
}

/**
 * ConfirmModal — minimum viable confirmation dialog for sync safety boundaries.
 *
 * Used for:
 *  - Settings reset confirmation
 *  - Batch remote-delete confirmation
 *  - (First sync / threshold alerts now use SyncPlanAlertModal)
 *
 * Design: deliberately minimal. A real plugin would improve the UI later,
 * but the safety boundary (user can cancel before destructive actions) must
 * exist from day one.
 */

import { Modal, type App } from "obsidian";

export interface ConfirmModalPlan {
  uploads: number;
  downloads: number;
  deletes: number;
  conflicts: number;
  skipped: number;
}

export type I18nFn = (key: string, params?: Record<string, string | number>) => string;

export class ConfirmModal extends Modal {
  private resolve: ((value: boolean) => void) | null = null;

  constructor(
    app: App,
    private title: string,
    private plan: ConfirmModalPlan | null,
    private confirmLabel: string,
    private cancelLabel: string,
    private t: I18nFn,
    private options?: {
      message?: string;
      warning?: string;
      danger?: boolean;
    },
  ) {
    super(app);
  }

  /** Open the modal and return a promise that resolves to true (confirmed) or false (cancelled). */
  awaitConfirm(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(value: boolean): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(value);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    if (this.options?.message) {
      contentEl.createEl("p", {
        text: this.options.message,
        cls: "setting-item-description",
      });
    }

    // Counts table
    if (this.plan) {
      const rows: [string, number][] = [
        [this.t("syncView.fileStatus.upload"), this.plan.uploads],
        [this.t("syncView.fileStatus.download"), this.plan.downloads],
        [this.t("syncView.fileStatus.delete"), this.plan.deletes],
        [this.t("syncView.fileStatus.conflict"), this.plan.conflicts],
        [this.t("syncView.fileStatus.skip"), this.plan.skipped],
      ];
      const visibleRows = rows.filter(([, count]) => count > 0);
      if (visibleRows.length > 0) {
        const table = contentEl.createEl("table");
        for (const [label, count] of visibleRows) {
          const tr = table.createEl("tr");
          tr.createEl("td", { text: label });
          tr.createEl("td", { text: String(count) });
        }
      }
      if (this.plan.deletes > 0) {
        contentEl.createDiv().setText(
          this.t("confirm.deleteWarning", { count: this.plan.deletes }),
        );
      }
    }
    if (this.options?.warning) {
      contentEl.createDiv().setText(this.options.warning);
    }

    // Buttons
    const btnRow = contentEl.createDiv("modal-button-container");
    const confirmBtn = btnRow.createEl("button", {
      text: this.confirmLabel,
      cls: this.options?.danger ? "mod-warning" : "mod-cta",
    });
    confirmBtn.addEventListener("click", () => {
      this.finish(true);
    });

    const cancelBtn = btnRow.createEl("button", { text: this.cancelLabel });
    cancelBtn.addEventListener("click", () => {
      this.finish(false);
    });
  }

  onClose(): void {
    // If modal was closed without clicking a button, treat as cancel
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(false);
  }
}
