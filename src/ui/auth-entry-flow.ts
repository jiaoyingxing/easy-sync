import type { App } from "obsidian";
import type { AuthModule } from "../auth/auth-module";
import type { DeviceCodeAttemptView } from "../auth/types";
import type { I18n } from "../i18n";
import { AuthPendingModal } from "./auth-pending-modal";
import { AuthMethodModal } from "./auth-method-modal";
import { AuthDeviceCodeModal } from "./auth-device-code-modal";
import { AuthLoginNoticeModal } from "./auth-login-notice-modal";
import {
  NOTICE_PRIORITY,
  type EasySyncNoticeCenter,
} from "./notice-center";

export type AuthEntryLabelKey =
  | "settings.account.checking"
  | "settings.account.confirmAfterBrowser"
  | "settings.account.resumeDevice"
  | "settings.account.login";

export type AuthEntryDescriptionKey =
  | "settings.account.desc.connecting"
  | "settings.account.desc.pending"
  | "settings.account.desc.devicePending"
  | "settings.account.desc.notLoggedIn";

export interface AuthEntryPresentation {
  labelKey: AuthEntryLabelKey;
  descriptionKey: AuthEntryDescriptionKey;
  disabled: boolean;
  cta: boolean;
}

export interface AuthEntryFlowHost {
  app: App;
  auth: AuthModule | null;
  i18n: Pick<I18n, "t">;
  noticeCenter: Pick<EasySyncNoticeCenter, "show">;
}

export function resolveAuthEntryPresentation(input: {
  isInitializing: boolean;
  isPending: boolean;
  /** True when the pending attempt is a waiting device code whose
   *  verification cycle outlives the modal. */
  isDevicePending?: boolean;
}): AuthEntryPresentation {
  if (input.isInitializing) {
    return {
      labelKey: "settings.account.checking",
      descriptionKey: "settings.account.desc.connecting",
      disabled: true,
      cta: false,
    };
  }
  if (input.isPending) {
    if (input.isDevicePending) {
      return {
        labelKey: "settings.account.resumeDevice",
        descriptionKey: "settings.account.desc.devicePending",
        disabled: false,
        cta: true,
      };
    }
    return {
      labelKey: "settings.account.confirmAfterBrowser",
      descriptionKey: "settings.account.desc.pending",
      disabled: false,
      cta: true,
    };
  }
  return {
    labelKey: "settings.account.login",
    descriptionKey: "settings.account.desc.notLoggedIn",
    disabled: false,
    cta: true,
  };
}

/**
 * Shared logged-out account action used by settings and the sync sidebar.
 *
 * A fresh login opens the method chooser first; the selected option's click
 * synchronously starts its flow. In particular, do not await anything before
 * AuthModule.login() opens the browser because iOS WebView requires the
 * popup to remain user initiated.
 */
export function handleAuthEntryAction(host: AuthEntryFlowHost): Promise<void> {
  const auth = host.auth;
  if (!auth || auth.isInitializing || auth.authState.isLoggedIn) {
    return Promise.resolve();
  }
  if (!auth.isPending) {
    // Login-gate notice: every fresh login first shows the short agreement
    // (data destination, backup, no competing sync tools). Dismissing it
    // cancels the login flow entirely — the chooser is not opened.
    return showLoginNotice(host).then((noticed) => {
      if (!noticed) return;
      return chooseAuthMethod(host, auth);
    });
  }
  if (auth.deviceAttempt) {
    // A waiting device code outlives its modal: re-entering reopens the SAME
    // code and countdown instead of issuing a new one.
    openDeviceCodeModal(host, auth);
    return Promise.resolve();
  }
  if (auth.checkAuthStatus()) {
    return Promise.resolve();
  }
  return handlePendingAuth(host, auth);
}

/** Agreement gate before any fresh login. Each new login shows it again. */
async function showLoginNotice(host: AuthEntryFlowHost): Promise<boolean> {
  const t = host.i18n.t.bind(host.i18n);
  return new AuthLoginNoticeModal(
    host.app,
    t("auth.notice.title"),
    [
      t("auth.notice.line1"),
      t("auth.notice.line2"),
      t("auth.notice.line3"),
    ],
    t("auth.notice.continue"),
  ).awaitContinue();
}

/**
 * First-login method chooser. The device option waits for its devicecode
 * request inside the chooser (busy state) so a failed request keeps the
 * chooser open for a retry; the browser option opens the popup directly in
 * the option's click handler to preserve the iOS gesture chain.
 */
async function chooseAuthMethod(
  host: AuthEntryFlowHost,
  auth: AuthModule,
): Promise<void> {
  const t = host.i18n.t.bind(host.i18n);
  let browserPromise: Promise<void> | null = null;
  const result = await new AuthMethodModal(
    host.app,
    t("settings.account.method.lead"),
    {
      title: t("settings.account.method.browser.name"),
      description: t("settings.account.method.browser.desc"),
    },
    {
      title: t("settings.account.method.device.name"),
      description: t("settings.account.method.device.desc"),
    },
    () => {
      browserPromise = startLogin(host, auth);
    },
    () => beginDeviceCodeFlow(host, auth),
  ).awaitAction();

  if (result.action === "browser" && browserPromise) {
    await browserPromise;
    return;
  }
  if (result.action === "device") {
    openDeviceCodeModal(host, auth);
    return;
  }
  // Dismissed: make sure an in-flight devicecode request cannot commit a
  // dangling attempt after the chooser closes.
  auth.cancelPendingLogin();
}

/** Issue the devicecode request; on failure surface the error and rethrow
 *  so the chooser can re-enable the option for another try. */
function beginDeviceCodeFlow(
  host: AuthEntryFlowHost,
  auth: AuthModule,
): Promise<DeviceCodeAttemptView> {
  const t = host.i18n.t.bind(host.i18n);
  return auth.beginDeviceCodeLogin().catch((error: unknown) => {
    if (isAuthOperationInvalidated(error)) throw error;
    host.noticeCenter.show({
      key: "auth-login-error",
      message: error instanceof Error ? error.message : t("general.unknown"),
      priority: NOTICE_PRIORITY.failure,
    });
    throw error;
  });
}

/** Open the waiting room for the current device-code attempt. The modal
 *  drives everything from here: polling already runs inside AuthModule. */
function openDeviceCodeModal(
  host: AuthEntryFlowHost,
  auth: AuthModule,
): void {
  new AuthDeviceCodeModal(host.app, {
    auth,
    noticeCenter: host.noticeCenter,
    t: host.i18n.t.bind(host.i18n),
  }).open();
}

function isAuthOperationInvalidated(error: unknown): boolean {
  return error instanceof Error
    && error.name === "AuthOperationInvalidatedError";
}

async function handlePendingAuth(
  host: AuthEntryFlowHost,
  auth: AuthModule,
): Promise<void> {
  const t = host.i18n.t.bind(host.i18n);
  let reopenPromise: Promise<void> | null = null;
  const result = await new AuthPendingModal(
    host.app,
    t("settings.account.pendingTitle"),
    t("settings.account.pendingMessage"),
    t("settings.account.recheck"),
    t("settings.account.copyAuthLink"),
    t("settings.account.reopenAuth"),
    t("settings.account.cancelLogin"),
    () => {
      void copyPendingAuthUrl(host, auth);
    },
    () => {
      reopenPromise = startLogin(host, auth);
    },
  ).awaitAction();

  if (result.action === "cancel") {
    // Abandon this attempt and let the user switch methods (e.g. from the
    // broken redirect flow to code login) without restarting Obsidian.
    auth.cancelPendingLogin();
    return chooseAuthMethod(host, auth);
  }
  if (result.action === "recheck") {
    const loggedIn = auth.checkAuthStatus();
    host.noticeCenter.show({
      key: loggedIn ? "settings-login-success" : "settings-login-pending",
      message: loggedIn
        ? t("settings.account.loginSuccess")
        : t("settings.account.desc.pending"),
      priority: loggedIn
        ? NOTICE_PRIORITY.action
        : NOTICE_PRIORITY.attention,
    });
    return;
  }
  if (result.action === "reopen" && reopenPromise) {
    await reopenPromise;
  }
}

async function copyPendingAuthUrl(
  host: AuthEntryFlowHost,
  auth: AuthModule,
): Promise<void> {
  const t = host.i18n.t.bind(host.i18n);
  const authUrl = auth.pendingAuthUrl;
  if (!authUrl) {
    showAuthLinkUnavailable(host, t("settings.account.authLinkUnavailable"));
    return;
  }

  try {
    const clipboard = navigator?.clipboard;
    if (!clipboard?.writeText) {
      throw new Error("Clipboard API is unavailable");
    }
    await clipboard.writeText(authUrl);
    host.noticeCenter.show({
      key: "settings-login-link-copied",
      message: t("settings.account.authLinkCopied"),
      priority: NOTICE_PRIORITY.action,
    });
  } catch {
    showAuthLinkUnavailable(host, t("settings.account.authLinkUnavailable"));
  }
}

function showAuthLinkUnavailable(
  host: AuthEntryFlowHost,
  message: string,
): void {
  host.noticeCenter.show({
    key: "settings-login-link-unavailable",
    message,
    priority: NOTICE_PRIORITY.failure,
  });
}

function startLogin(
  host: AuthEntryFlowHost,
  auth: AuthModule,
): Promise<void> {
  const t = host.i18n.t.bind(host.i18n);
  // login() opens the browser synchronously inside this call; when it did,
  // guide the user that returning to Obsidian completes the flow (D4).
  const loginPromise = auth.login();
  if (auth.isPending) {
    host.noticeCenter.show({
      key: "settings-login-browser-opened",
      message: t("settings.account.browserOpened"),
      priority: NOTICE_PRIORITY.action,
    });
  }
  return loginPromise.catch((error: unknown) => {
    host.noticeCenter.show({
      key: "auth-login-error",
      message: error instanceof Error ? error.message : t("general.unknown"),
      priority: NOTICE_PRIORITY.failure,
    });
  });
}
