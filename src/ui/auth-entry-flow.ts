import type { App } from "obsidian";
import type { AuthModule } from "../auth/auth-module";
import type { I18n } from "../i18n";
import { AuthPendingModal } from "./auth-pending-modal";
import {
  NOTICE_PRIORITY,
  type EasySyncNoticeCenter,
} from "./notice-center";

export type AuthEntryLabelKey =
  | "settings.account.checking"
  | "settings.account.login";

export type AuthEntryDescriptionKey =
  | "settings.account.desc.connecting"
  | "settings.account.desc.pending"
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
    return {
      labelKey: "settings.account.checking",
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
 * Keep the first login call synchronous with the click handler. In particular,
 * do not await anything before AuthModule.login() opens the browser because
 * iOS WebView requires the popup to remain user initiated.
 */
export function handleAuthEntryAction(host: AuthEntryFlowHost): Promise<void> {
  const auth = host.auth;
  if (!auth || auth.isInitializing || auth.authState.isLoggedIn) {
    return Promise.resolve();
  }
  if (!auth.isPending) {
    return startLogin(host, auth);
  }
  if (auth.checkAuthStatus()) {
    return Promise.resolve();
  }
  return handlePendingAuth(host, auth);
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
    () => {
      void copyPendingAuthUrl(host, auth);
    },
    () => {
      reopenPromise = startLogin(host, auth);
    },
  ).awaitAction();

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
    const clipboard = globalThis.navigator?.clipboard;
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
  return auth.login().catch((error: unknown) => {
    host.noticeCenter.show({
      key: "auth-login-error",
      message: error instanceof Error ? error.message : t("general.unknown"),
      priority: NOTICE_PRIORITY.failure,
    });
  });
}
