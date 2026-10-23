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
 *
 * This base also owns the promise settle protocol for "open and wait"
 * modals: `awaitResult()` registers the resolver and opens the modal,
 * `settle()` is the single settle point (take resolver, null it, close,
 * resolve once), and `onClose` uses `takePendingResolve()` to resolve the
 * cancel value only when no real choice was made.
 */
import { Modal, setIcon, type App } from "obsidian";

/** One selectable row for chooser modals (login methods, migration offer). */
interface EasySyncModalOptionView {
  title: string;
  description: string;
}

export abstract class EasySyncModal<TResult = void> extends Modal {
  private pendingResolve: ((value: TResult) => void) | null = null;

  constructor(app: App) {
    super(app);
    this.containerEl.addClass("easy-sync-modal-container");
  }

  /** Register the awaiting promise's resolver and open the modal. */
  protected awaitResult(): Promise<TResult> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.open();
    });
  }

  /**
   * Single settle point for "open and wait" modals: take the pending
   * resolver, null it, close, then resolve once. Nulling before `close()`
   * matters because the host may run `onClose()` synchronously from
   * `close()`; the cancel path then finds no resolver and cannot steal a
   * real choice ("close == cancel" only when nothing was chosen).
   */
  protected settle(result: TResult): void {
    const resolve = this.takePendingResolve();
    this.close();
    resolve?.(result);
  }

  /** Take and clear the pending resolver (cancel path, called from onClose). */
  protected takePendingResolve(): ((value: TResult) => void) | null {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    return resolve;
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

