import { type App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";

export interface FileComparisonRow {
  label: string;
  local: string;
  remote: string;
  localHighlighted?: boolean;
  remoteHighlighted?: boolean;
  /** Short per-row state shown muted next to the label (e.g. 一致 / 不同). */
  status?: string;
}

export interface FileComparisonAction {
  label: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}

/** Keep file sizes consistent across every shared comparison surface. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shared visual host for current-local/current-cloud decisions.
 *
 * Subclasses retain their own evidence lifecycle and execution semantics; this
 * class owns only the single scroll surface, comparison table, and fixed action
 * footer used by both ordinary conflicts and unfinished-operation review.
 */
export abstract class FileComparisonModal extends EasySyncModal {
  protected comparisonBodyEl!: HTMLElement;

  constructor(app: App) {
    super(app);
  }

  async onOpen(): Promise<void> {
    await this.refreshComparison();
  }

  /** Rebuild only the modal's shared comparison surface in place. */
  protected async refreshComparison(): Promise<void> {
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
  ): HTMLTableElement {
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
      const labelCell = rowEl.createEl("td");
      labelCell.setText(row.label);
      if (row.status) {
        labelCell.createSpan("easy-sync-meta-status").setText(row.status);
      }
      const localCell = rowEl.createEl("td", "easy-sync-meta-col-local");
      localCell.setText(row.local);
      if (row.localHighlighted) localCell.addClass("easy-sync-meta-highlight");
      const remoteCell = rowEl.createEl("td", "easy-sync-meta-col-remote");
      remoteCell.setText(row.remote);
      if (row.remoteHighlighted) remoteCell.addClass("easy-sync-meta-highlight");
    }
    return table;
  }

  protected renderFileComparisonActions(
    actions: readonly FileComparisonAction[],
  ): HTMLDivElement {
    const btnRow = this.contentEl.createDiv("easy-sync-detail-actions");
    for (const action of actions) {
      const button = btnRow.createEl("button", { text: action.label });
      button.disabled = action.disabled === true;
      if (action.className) button.addClass(action.className);
      if (!action.disabled) button.addEventListener("click", action.onClick);
    }
    return btnRow;
  }
}
