/**
 * AuthPendingModal — waiting room for a browser redirect login attempt.
 *
 * Three options: "复制登录链接" copies the current attempt without closing
 * the modal, "重新打开登录页面" starts a fresh attempt (the old one is
 * invalidated), "取消登录" abandons it and returns to method choice.
 *
 * Completion needs no click: a 1s tick watches the auth state (same pattern
 * as AuthDeviceCodeModal) and auto-closes with a success notice once the
 * redirect lands. Closing or dismissing the modal never cancels the attempt
 * — only the "取消登录" button does.
 */

import { type App } from "obsidian";
import {
  compatClearInterval,
  compatSetInterval,
  IntervalHandle,
} from "../obsidian-compat";
import type { AuthModule } from "../auth/auth-module";
import {
  NOTICE_PRIORITY,
  type EasySyncNoticeCenter,
} from "./notice-center";
import { EasySyncModal } from "./easy-sync-modal";

export type PendingModalResult =
  | { action: "reopen" }
  | { action: "cancel" }
  | { action: "dismiss" };

export interface AuthPendingModalDeps {
  auth: AuthModule;
  noticeCenter: Pick<EasySyncNoticeCenter, "show">;
  t: (key: string) => string;
}

export class AuthPendingModal extends EasySyncModal {
  private resolve: ((value: PendingModalResult) => void) | null = null;
  private authTick: IntervalHandle | null = null;
  private closed = false;

  constructor(
    app: App,
    private title: string,
    private message: string,
    private copyLabel: string,
    private reopenLabel: string,
    private cancelLabel: string,
    private onCopy?: () => void,
    private onReopen?: () => void,
    private deps?: AuthPendingModalDeps,
  ) {
    super(app);
  }

  /** Open the modal and return the user's chosen action */
  awaitAction(): Promise<PendingModalResult> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private finish(result: PendingModalResult): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(result);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    contentEl.createEl("p", {
      text: this.message,
      cls: "setting-item-description",
    });

    const btnRow = contentEl.createDiv({
      cls: "modal-button-container easy-sync-auth-pending-actions",
    });

    const copyBtn = btnRow.createEl("button", {
      text: this.copyLabel,
    });
    copyBtn.addEventListener("click", () => {
      this.onCopy?.();
    });

    const reopenBtn = btnRow.createEl("button", {
      text: this.reopenLabel,
    });
    reopenBtn.addEventListener("click", () => {
      this.onReopen?.();
      this.finish({ action: "reopen" });
    });

    const cancelBtn = btnRow.createEl("button", {
      text: this.cancelLabel,
    });
    cancelBtn.addEventListener("click", () => {
      this.finish({ action: "cancel" });
    });

    if (this.deps) {
      this.authTick = compatSetInterval(() => this.onAuthTick(), 1000);
    }
  }

  /** Success closes the modal on its own — nothing for the user to press. */
  private onAuthTick(): void {
    if (this.closed || !this.deps) return;
    if (!this.deps.auth.authState.isLoggedIn) return;
    this.closed = true;
    this.deps.noticeCenter.show({
      key: "settings-login-success",
      message: this.deps.t("settings.account.loginSuccess"),
      priority: NOTICE_PRIORITY.action,
    });
    this.finish({ action: "dismiss" });
  }

  onClose(): void {
    if (this.authTick !== null) {
      compatClearInterval(this.authTick);
      this.authTick = null;
    }
    this.closed = true;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.({ action: "dismiss" });
  }
}
