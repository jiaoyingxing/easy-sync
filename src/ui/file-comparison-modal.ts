import { Modal, type App } from "obsidian";

export interface FileComparisonRow {
  label: string;
  local: string;
  remote: string;
  localHighlighted?: boolean;
  remoteHighlighted?: boolean;
}

export interface FileComparisonAction {
  label: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Shared visual host for current-local/current-cloud decisions.
 *
 * Subclasses retain their own evidence lifecycle and execution semantics; this
 * class owns only the single scroll surface, comparison table, and fixed action
 * footer used by both ordinary conflicts and unfinished-operation review.
 */
export abstract class FileComparisonModal extends Modal {
  protected comparisonBodyEl!: HTMLElement;

  constructor(app: App) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("easy-sync-conflict-detail");
    this.comparisonBodyEl = this.contentEl.createDiv("easy-sync-conflict-body");
    await this.renderComparison();
  }

  protected abstract renderComparison(): void | Promise<void>;

  protected renderComparisonTable(
    localTitle: string,
    remoteTitle: string,
    rows: readonly FileComparisonRow[],
  ): void {
    const table = this.comparisonBodyEl.createEl("table", "easy-sync-metadata-table");
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th");
    headerRow.createEl("th", {
      text: localTitle,
      cls: "easy-sync-meta-col-local",
    });
    headerRow.createEl("th", {
      text: remoteTitle,
      cls: "easy-sync-meta-col-remote",
    });

    const tbody = table.createEl("tbody");
    for (const row of rows) {
      const rowEl = tbody.createEl("tr");
      rowEl.createEl("td", { text: row.label });
      const localCell = rowEl.createEl("td", "easy-sync-meta-col-local");
      localCell.setText(row.local);
      if (row.localHighlighted) localCell.addClass("easy-sync-meta-highlight");
      const remoteCell = rowEl.createEl("td", "easy-sync-meta-col-remote");
      remoteCell.setText(row.remote);
      if (row.remoteHighlighted) remoteCell.addClass("easy-sync-meta-highlight");
    }
  }

  protected renderFileComparisonActions(
    actions: readonly FileComparisonAction[],
  ): void {
    const btnRow = this.contentEl.createDiv("easy-sync-detail-actions");
    for (const action of actions) {
      const button = btnRow.createEl("button", { text: action.label });
      button.disabled = action.disabled === true;
      if (action.className) button.addClass(action.className);
      if (!action.disabled) button.addEventListener("click", action.onClick);
    }
  }
}
