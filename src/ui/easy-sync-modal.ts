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
 * Marker only on the container itself; the shared option-row builder for
 * chooser modals (login methods, migration offer) also lives here.
 */
import { Modal, setIcon, type App } from "obsidian";

/** One selectable row for chooser modals (login methods, migration offer). */
export interface EasySyncModalOptionView {
  title: string;
  description: string;
}

export abstract class EasySyncModal extends Modal {
  constructor(app: App) {
    super(app);
    this.containerEl.addClass("easy-sync-modal-container");
  }

  /** Shared option-row button for chooser modals. Visual classes are the
   *  auth-method modal's house pattern (extracted 2026-10-01 so the Remotely
   *  Save migration offer reuses them without a second copy). */
  protected buildOptionButton(
    option: EasySyncModalOptionView,
  ): HTMLButtonElement {
    const button = this.contentEl.createEl("button", {
      cls: "easy-sync-auth-method-option",
      type: "button",
    });
    const body = button.createDiv({ cls: "easy-sync-auth-method-body" });
    body.createDiv({
      text: option.title,
      cls: "easy-sync-auth-method-title",
    });
    body.createDiv({
      text: option.description,
      cls: "easy-sync-auth-method-desc",
    });
    const chevron = button.createSpan({
      cls: "easy-sync-auth-method-chevron",
    });
    setIcon(chevron, "chevron-right");
    return button;
  }
}

