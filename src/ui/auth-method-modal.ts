/**
 * AuthMethodModal — first-login method chooser.
 *
 * Shows the two sign-in methods (browser redirect / device code), each with
 * a one-line difference, ordered by platform (device code first on mobile).
 *
 * Selection must stay on the synchronous click chain: the option click
 * invokes its callback directly (browser login opens the popup there;
 * device login fires its request there) before the modal closes.
 */

import { Modal, Platform, setIcon, type App } from "obsidian";

export type AuthMethodResult =
  | { action: "browser" }
  | { action: "device" }
  | { action: "dismiss" };

export interface AuthMethodOptionView {
  title: string;
  description: string;
}

export class AuthMethodModal extends Modal {
  private resolve: ((value: AuthMethodResult) => void) | null = null;
  private finished = false;
  private busy = false;

  constructor(
    app: App,
    private lead: string,
    private browser: AuthMethodOptionView,
    private device: AuthMethodOptionView,
    /** Called synchronously in the browser option's click handler. */
    private onBrowserSelect: () => void | Promise<void>,
    /** Called in the device option's click handler; resolves when the
     *  devicecode request succeeded. On rejection the option re-enables. */
    private onDeviceSelect: () => Promise<unknown>,
  ) {
    super(app);
  }

  /** Open the modal and return the user's chosen method */
  awaitAction(): Promise<AuthMethodResult> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(result: AuthMethodResult): void {
    if (this.finished) return;
    this.finished = true;
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(result);
  }

  private async handleDeviceClick(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    button.disabled = true;
    try {
      await this.onDeviceSelect();
      this.finish({ action: "device" });
    } catch {
      if (this.finished) return;
      this.busy = false;
      button.disabled = false;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-sync-auth-method-modal");

    contentEl.createDiv({
      text: this.lead,
      cls: "easy-sync-auth-method-lead",
    });

    const browserEntry = {
      build: () => {
        const btn = this.buildOptionButton(this.browser);
        btn.addEventListener("click", () => {
          void this.onBrowserSelect();
          this.finish({ action: "browser" });
        });
        return btn;
      },
    };
    const deviceEntry = {
      build: () => {
        const btn = this.buildOptionButton(this.device);
        btn.addEventListener("click", () => {
          void this.handleDeviceClick(btn);
        });
        return btn;
      },
    };
    // D1: platform-based order, device code first on mobile, no "recommended".
    const ordered = orderMethodOptions(
      Platform.isMobile,
      [browserEntry, deviceEntry] as const,
    );
    for (const option of ordered) {
      contentEl.appendChild(option.build());
    }
  }

  private buildOptionButton(option: AuthMethodOptionView): HTMLButtonElement {
    const button = this.contentEl.createEl("button", {
      cls: "easy-sync-auth-method-option",
      type: "button",
    });
    const body = button.createDiv({ cls: "easy-sync-auth-method-body" });
    body.createEl("div", {
      text: option.title,
      cls: "easy-sync-auth-method-title",
    });
    body.createEl("div", {
      text: option.description,
      cls: "easy-sync-auth-method-desc",
    });
    const chevron = button.createSpan({
      cls: "easy-sync-auth-method-chevron",
    });
    setIcon(chevron, "chevron-right");
    return button;
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ action: "dismiss" });
  }
}

/** Platform-based option order: device code first on mobile, otherwise
 *  browser first (D1 — neither option is marked "recommended"). */
export function orderMethodOptions<T>(
  deviceFirst: boolean,
  options: readonly [T, T],
): [T, T] {
  return deviceFirst ? [options[1], options[0]] : [options[0], options[1]];
}
