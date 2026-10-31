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
  addEasySyncFooterButton,
  createEasySyncModalFooter,
  EasySyncModal,
} from "./easy-sync-modal";
import {
  NOTICE_PRIORITY,
  type EasySyncNoticeCenter,
} from "./notice-center";

type PendingModalResult =
  | { action: "reopen" }
  | { action: "cancel" }
  | { action: "dismiss" };

interface AuthPendingModalDeps {
  auth: AuthModule;
  noticeCenter: Pick<EasySyncNoticeCenter, "show">;
  t: (key: string) => string;
}

export class AuthPendingModal extends EasySyncModal<PendingModalResult> {
  private authTick: IntervalHandle | null = null;
  private closed = false;
  private failureShown = false;
  private messageEl: HTMLElement | null = null;

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
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // 纯提示框：正文即全部内容，正文放大走 styles.css 白名单。
    this.modalEl.addClass("easy-sync-prompt-modal");
    this.setTitle(this.title);

    this.messageEl = contentEl.createEl("p", {
      text: this.message,
      cls: "setting-item-description",
    });

    // No CTA in a waiting room (success auto-closes): the cancel exit leads
    // the DOM so phones keep it at the bottom via the host's column-reverse.
    const btnRow = createEasySyncModalFooter(contentEl);
    addEasySyncFooterButton(btnRow, {
      label: this.cancelLabel,
      onClick: () => {
        this.settle({ action: "cancel" });
      },
    });
    addEasySyncFooterButton(btnRow, {
      label: this.copyLabel,
      onClick: () => {
        this.onCopy?.();
      },
    });
    addEasySyncFooterButton(btnRow, {
      label: this.reopenLabel,
      onClick: () => {
        this.onReopen?.();
        this.settle({ action: "reopen" });
      },
    });

    if (this.deps) {
      this.authTick = compatSetInterval(() => this.onAuthTick(), 1000);
    }
  }

  /** Success closes the modal on its own — nothing for the user to press.
   *  A failed attempt (device-flow parity) surfaces once: failure notice
   *  plus the waiting text rewritten in place; the modal stays open so the
   *  existing "重新打开登录页面" button is the retry and "取消登录" the exit. */
  private onAuthTick(): void {
    if (this.closed || !this.deps) return;
    if (this.deps.auth.browserAttemptFailed) {
      this.showFailure();
      return;
    }
    if (!this.deps.auth.authState.isLoggedIn) return;
    this.closed = true;
    this.deps.noticeCenter.show({
      key: "settings-login-success",
      message: this.deps.t("settings.account.loginSuccess"),
      priority: NOTICE_PRIORITY.action,
    });
    this.settle({ action: "dismiss" });
  }

  private showFailure(): void {
    if (this.failureShown || !this.deps) return;
    this.failureShown = true;
    this.deps.noticeCenter.show({
      key: "auth-pending-failed",
      message: this.deps.t("settings.account.pendingFailed"),
      priority: NOTICE_PRIORITY.failure,
    });
    this.messageEl?.setText(this.deps.t("settings.account.pendingFailed"));
  }

  override onClose(): void {
    if (this.authTick !== null) {
      compatClearInterval(this.authTick);
      this.authTick = null;
    }
    this.closed = true;
    this.takePendingResolve()?.({ action: "dismiss" });
  }
}
