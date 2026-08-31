/**
 * Shared drawer/backdrop for every EasySync Modal.
 *
 * Obsidian's host dims the `.modal-bg` via `--background-modifier-cover`,
 * which it deliberately relaxes on touch devices (0.15 light / 0.35 dark
 * vs. 0.4 on desktop) and applies no blur. On phones the vault stays fully
 * legible behind the dialog, so dialog content and background compete. This
 * base class tags each modal container so the stylesheet can give EasySync
 * dialogs a gentle blur (6px) on top of the host's own plain cover color —
 * no extra darkening, no saturate / brightness (see styles.css
 * "EasySync Modal backdrop"). Android WebViews without `backdrop-filter`
 * keep the host's plain cover, same as the pre-change look.
 *
 * Marker only: no behavior, no lifecycle, no classes on modalEl/contentEl.
 */
import { Modal, type App } from "obsidian";

export abstract class EasySyncModal extends Modal {
  constructor(app: App) {
    super(app);
    this.containerEl.addClass("easy-sync-modal-container");
  }
}

