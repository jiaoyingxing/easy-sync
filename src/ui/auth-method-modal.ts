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

import type { App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";
import {
  hostPlatformFacts,
  type HostPlatformFacts,
} from "../obsidian-compat";

type AuthMethodResult =
  | { action: "browser" }
  | { action: "device" }
  | { action: "dismiss" };

interface AuthMethodOptionView {
  title: string;
  description: string;
}

export class AuthMethodModal extends EasySyncModal<AuthMethodResult> {
  private busy = false;
  private decided = false;

  constructor(
    app: App,
    private browser: AuthMethodOptionView,
    private device: AuthMethodOptionView,
    /** Called synchronously in the browser option's click handler. */
    private onBrowserSelect: () => void | Promise<void>,
    /** Called in the device option's click handler; resolves when the
     *  devicecode request succeeded. On rejection the option re-enables. */
    private onDeviceSelect: () => Promise<unknown>,
    /** Platform facts for option order; tests may inject a fake. */
    private readonly platformFacts: HostPlatformFacts = hostPlatformFacts,
  ) {
    super(app);
  }

  /** Open the modal and return the user's chosen method */
  awaitAction(): Promise<AuthMethodResult> {
    return this.awaitResult();
  }

  private async handleDeviceClick(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    button.disabled = true;
    try {
      await this.onDeviceSelect();
      this.decided = true;
      this.settle({ action: "device" });
    } catch {
      // The modal may have been closed while the request was in flight; only
      // re-arm the option when it is still open and undecided.
      if (this.decided) return;
      this.busy = false;
      button.disabled = false;
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-sync-auth-method-modal");

    const browserEntry = {
      build: () => {
        const btn = this.buildOptionButton(this.browser);
        btn.addEventListener("click", () => {
          void this.onBrowserSelect();
          this.decided = true;
          this.settle({ action: "browser" });
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
      this.platformFacts.isMobileApp,
      [browserEntry, deviceEntry] as const,
    );
    for (const option of ordered) {
      contentEl.appendChild(option.build());
    }
  }

  // Option-row construction is inherited from EasySyncModal (shared with the
  // Remotely Save migration offer; extraction 2026-10-01).

  override onClose(): void {
    this.takePendingResolve()?.({ action: "dismiss" });
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
