/**
 * AuthDeviceCodeModal — waiting room for a device code login attempt.
 *
 * Shows the big 9-character code, opens the pre-filled verification page
 * (same-device path: zero typing), offers manual copy for another device,
 * counts down to expiry, and auto-completes when the poll succeeds — the
 * user never has to press anything after returning from the browser.
 *
 * The verification cycle (one device code until success / expiry / decline)
 * outlives the modal: closing the modal only hides it, the attempt keeps
 * polling, and re-entering from the account button reopens this same code.
 * Only the "取消登录" button abandons the attempt. Terminal phases
 * (declined / expired / mismatch / failed) keep the modal open with a
 * "generate a new code" recovery.
 */

import { Modal, type App } from "obsidian";
import {
  compatClearInterval,
  compatSetInterval,
  IntervalHandle,
} from "../obsidian-compat";
import type { AuthModule } from "../auth/auth-module";
import type { DeviceCodeAttemptView } from "../auth/types";
import {
  NOTICE_PRIORITY,
  type EasySyncNoticeCenter,
} from "./notice-center";

export interface AuthDeviceCodeModalDeps {
  auth: AuthModule;
  noticeCenter: Pick<EasySyncNoticeCenter, "show">;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export class AuthDeviceCodeModal extends Modal {
  private renderTimer: IntervalHandle | null = null;
  private countdownEl: HTMLElement | null = null;
  private renderedCode = "";
  private renderedPhase = "";
  private busy = false;
  private closed = false;

  constructor(
    app: App,
    private deps: AuthDeviceCodeModalDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
    this.renderTimer = compatSetInterval(() => {
      this.onTick();
    }, 1000);
  }

  onClose(): void {
    compatClearInterval(this.renderTimer);
    this.renderTimer = null;
    // Closing only hides the view — the attempt keeps polling for its whole
    // verification cycle. The explicit cancel button abandons it.
    this.closed = true;
  }

  private onTick(): void {
    if (this.busy) return;
    const attempt = this.deps.auth.deviceAttempt;
    if (!attempt) {
      // Attempt ended: login completed (success), or it was cancelled
      // outside the modal. Close and, on success, confirm to the user.
      const loggedIn = this.deps.auth.authState.isLoggedIn;
      this.close();
      if (loggedIn) {
        this.deps.noticeCenter.show({
          key: "settings-login-success",
          message: this.deps.t("settings.account.loginSuccess"),
          priority: NOTICE_PRIORITY.action,
        });
      }
      return;
    }
    if (
      attempt.userCode !== this.renderedCode
      || attempt.phase !== this.renderedPhase
    ) {
      this.render();
      return;
    }
    this.updateCountdown(attempt);
  }

  private render(): void {
    const attempt = this.deps.auth.deviceAttempt;
    if (!attempt) return;
    const t = this.deps.t;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-sync-auth-device-code-modal");
    this.setTitle(t("settings.account.device.title"));
    this.countdownEl = null;

    const codeBlock = contentEl.createDiv({ cls: "easy-sync-device-code" });
    codeBlock.setText(groupCode(attempt.userCode));
    codeBlock.addEventListener("click", () => {
      void this.copyCode();
    });
    contentEl.createDiv({
      text: t("settings.account.device.codeHint"),
      cls: "easy-sync-device-code-hint",
    });

    const btnRow = contentEl.createDiv({
      cls: "modal-button-container easy-sync-device-actions",
    });
    if (attempt.phase === "waiting") {
      const openBtn = btnRow.createEl("button", {
        text: t("settings.account.device.openVerify"),
        cls: "mod-cta",
        type: "button",
      });
      openBtn.addEventListener("click", () => {
        // Same-device path: copy the code (with notice — the user pastes it
        // on the verification page, since Microsoft does not pre-fill) and
        // open the page. Both must stay inside the click so iOS keeps the
        // browser popup user-initiated.
        void this.copyCode();
        this.deps.auth.openUrl(verificationPageUrl(attempt));
      });
      const copyBtn = btnRow.createEl("button", {
        text: t("settings.account.device.copyCode"),
        type: "button",
      });
      copyBtn.addEventListener("click", () => {
        void this.copyCode();
      });
      const checkBtn = btnRow.createEl("button", {
        text: t("settings.account.device.checkNow"),
        type: "button",
      });
      checkBtn.addEventListener("click", () => {
        void this.manualCheck(checkBtn);
      });
    } else {
      const regenerateBtn = btnRow.createEl("button", {
        text: t("settings.account.device.regenerate"),
        cls: "mod-cta",
        type: "button",
      });
      regenerateBtn.addEventListener("click", () => {
        void this.regenerate();
      });
    }
    const cancelBtn = btnRow.createEl("button", {
      text: t("settings.account.device.cancel"),
      type: "button",
    });
    cancelBtn.addEventListener("click", () => {
      // The only path that abandons the attempt; closing the modal alone
      // keeps the code alive for the whole verification cycle.
      this.deps.auth.cancelPendingLogin();
      this.close();
    });

    const status = contentEl.createDiv({ cls: "easy-sync-device-status" });
    if (attempt.phase === "waiting") {
      status.createSpan({ text: t("settings.account.device.waiting") });
      status.createSpan({ text: " · " });
      this.countdownEl = status.createSpan({
        text: t("settings.account.device.expiresIn", {
          time: formatRemaining(attempt.expiresAt),
        }),
      });
    } else {
      status.setText(this.deps.t(devicePhaseMessageKey(attempt.phase)));
    }

    contentEl.createDiv({
      text: t("settings.account.device.security"),
      cls: "easy-sync-device-security",
    });

    this.renderedCode = attempt.userCode;
    this.renderedPhase = attempt.phase;
  }

  private updateCountdown(attempt: DeviceCodeAttemptView): void {
    if (!this.countdownEl) return;
    this.countdownEl.setText(
      this.deps.t("settings.account.device.expiresIn", {
        time: formatRemaining(attempt.expiresAt),
      }),
    );
  }

  /** Manual "check now": run one immediate poll and always answer the user —
   *  the modal completes or advances to a terminal phase, or the user is told
   *  the provider still reports the login as unfinished. */
  private async manualCheck(button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    const t = this.deps.t;
    const originalLabel = button.getText();
    this.busy = true;
    button.disabled = true;
    button.setText(t("settings.account.device.checking"));
    try {
      await this.deps.auth.checkDeviceCodeNow();
    } finally {
      this.busy = false;
    }
    if (this.closed) return;
    const attempt = this.deps.auth.deviceAttempt;
    if (!attempt) {
      // Attempt ended — the shared tick path closes the modal and, on
      // success, confirms it to the user.
      this.onTick();
      return;
    }
    if (attempt.phase === "waiting") {
      button.disabled = false;
      button.setText(originalLabel);
      this.deps.noticeCenter.show({
        key: "settings-device-check-pending",
        message: t("settings.account.device.notYet"),
        priority: NOTICE_PRIORITY.attention,
      });
      this.updateCountdown(attempt);
      return;
    }
    this.render();
  }

  private async copyCode(): Promise<void> {
    const attempt = this.deps.auth.deviceAttempt;
    if (!attempt) return;
    const t = this.deps.t;
    try {
      const clipboard = navigator?.clipboard;
      if (!clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }
      await clipboard.writeText(attempt.userCode);
      this.deps.noticeCenter.show({
        key: "settings-device-code-copied",
        message: t("settings.account.device.codeCopied"),
        priority: NOTICE_PRIORITY.action,
      });
    } catch {
      this.deps.noticeCenter.show({
        key: "settings-device-code-copy-unavailable",
        message: t("settings.account.device.copyUnavailable"),
        priority: NOTICE_PRIORITY.failure,
      });
    }
  }

  private async regenerate(): Promise<void> {
    if (this.busy) return;
    const t = this.deps.t;
    this.busy = true;
    this.renderBusy();
    try {
      await this.deps.auth.beginDeviceCodeLogin();
      this.busy = false;
      this.render();
    } catch (error) {
      this.busy = false;
      if (this.closed) return;
      this.deps.noticeCenter.show({
        key: "auth-login-error",
        message: error instanceof Error ? error.message : t("general.unknown"),
        priority: NOTICE_PRIORITY.failure,
      });
      this.close();
    }
  }

  private renderBusy(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-sync-auth-device-code-modal");
    contentEl.createDiv({
      text: this.deps.t("settings.account.device.busy"),
      cls: "easy-sync-device-status",
    });
  }
}

/** Verification page to open: the provider's pre-filled URL when present
 *  (Microsoft currently does not return one — official docs: "not included
 *  or supported at this time"), otherwise the plain page where the user
 *  pastes the copied code. */
export function verificationPageUrl(attempt: {
  verificationUri: string;
  verificationUriComplete: string | null;
}): string {
  return attempt.verificationUriComplete || attempt.verificationUri;
}

/** Group the 9-character code as "ABC DEF GHI" for readability. */
export function groupCode(userCode: string): string {
  return userCode.replace(/(.{3})/g, "$1 ").trim();
}

/** m:ss countdown from the attempt deadline, clamped at 0:00. */
export function formatRemaining(expiresAt: number): string {
  const totalSeconds = Math.max(
    0,
    Math.ceil((expiresAt - Date.now()) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** i18n key for a terminal device-code phase. */
export function devicePhaseMessageKey(
  phase: Exclude<DeviceCodeAttemptView["phase"], "waiting">,
): string {
  switch (phase) {
    case "declined":
      return "settings.account.device.declined";
    case "expired":
      return "settings.account.device.expired";
    case "mismatch":
      return "settings.account.device.mismatch";
    case "failed":
      return "settings.account.device.failed";
  }
}
