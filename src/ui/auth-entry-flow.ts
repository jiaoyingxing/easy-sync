import type { App } from "obsidian";
import type { AuthModule } from "../auth/auth-module";
import type { DeviceCodeAttemptView } from "../auth/types";
import type { I18n } from "../i18n";
import { AuthPendingModal } from "./auth-pending-modal";
import { AuthMethodModal } from "./auth-method-modal";
import { AuthDeviceCodeModal } from "./auth-device-code-modal";
import { CloudChoiceModal } from "./cloud-choice-modal";
import {
  NOTICE_PRIORITY,
  type EasySyncNoticeCenter,
} from "./notice-center";

type AuthEntryLabelKey =
  | "settings.account.checking"
  | "settings.account.confirmAfterBrowser"
  | "settings.account.resumeDevice"
  | "settings.account.login";

type AuthEntryDescriptionKey =
  | "settings.account.desc.connecting"
  | "settings.account.desc.pending"
  | "settings.account.desc.devicePending"
  | "settings.account.desc.notLoggedIn";

interface AuthEntryPresentation {
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
  /**
   * A8：开始登录 OneDrive 前确认「真的要切过去」。
   *
   * 只在另一个云端（WebDAV）正活动时由插件弹手输门槛；没有切换时直接返回
   * true，所以设置页/侧栏的普通登录不受影响。缺省（单测夹具）视为无需确认。
   */
  confirmOneDriveActivation?: () => Promise<boolean>;
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
 * 侧栏登录入口（F4/S5）：先问「用哪个同步方式」，再进各自的登录流程。
 *
 * 这一层**只挂在侧栏**：设置页的登录入口保持「两行直接摆着」（A10）。
 * 已有登录在等待（浏览器回跳待确认／设备码倒计时）时不插云端选择——
 * 那两种状态的按钮语义是「继续上一次登录」，重问一遍会把用户踢回起点。
 * 其余情况（干净的未登录）才先问云端。
 */
export interface SidebarAuthEntryHost extends AuthEntryFlowHost {
  /** 打开 WebDAV 配置弹窗（保存即测试；见 `openWebDavConfig`）。 */
  openWebDavConfig(): Promise<void>;
}

export async function handleSidebarAuthEntry(
  host: SidebarAuthEntryHost,
): Promise<void> {
  const auth = host.auth;
  // 等待中的登录沿用现役续接路径；未建好／已登录时该函数本身即空操作。
  if (!auth || auth.isInitializing || auth.authState.isLoggedIn || auth.isPending) {
    return handleAuthEntryAction(host);
  }
  const t = host.i18n.t.bind(host.i18n);
  const result = await new CloudChoiceModal(host.app, {
    title: t("cloudChoice.title"),
    onedrive: {
      name: t("cloudChoice.onedrive.name"),
      desc: t("cloudChoice.onedrive.desc"),
    },
    webdav: {
      name: t("cloudChoice.webdav.name"),
      desc: t("cloudChoice.webdav.desc"),
    },
  }).openAndWait();
  if (result.action === "onedrive") {
    // 第二步就是现役的两选项弹窗，一个字都不改。
    return handleAuthEntryAction(host);
  }
  if (result.action === "webdav") {
    await host.openWebDavConfig();
  }
}

/**
 * Shared logged-out account action used by settings and the sync sidebar.
 *
 * A fresh login opens the method chooser first; the selected option's click
 * synchronously starts its flow. In particular, do not await anything before
 * AuthModule.login() opens the browser because iOS WebView requires the
 * popup to remain user initiated.
 */
export async function handleAuthEntryAction(
  host: AuthEntryFlowHost,
): Promise<void> {
  const auth = host.auth;
  if (!auth || auth.isInitializing || auth.authState.isLoggedIn) {
    return;
  }
  if (!auth.isPending) {
    // A8：另一个云端正活动时，先手输确认「要切过去」再开始登录；取消＝
    // 什么都没发生（不发起浏览器弹窗、不申请设备码）。没有切换时插件那边
    // 直接返回 true，这一步对普通登录是透明的。
    if (host.confirmOneDriveActivation
      && !await host.confirmOneDriveActivation()) {
      return;
    }
    return chooseAuthMethod(host, auth);
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
    await (browserPromise as Promise<void>);
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
    t("settings.account.copyAuthLink"),
    t("settings.account.reopenAuth"),
    t("settings.account.cancelLogin"),
    () => {
      void copyPendingAuthUrl(host, auth);
    },
    () => {
      reopenPromise = startLogin(host, auth);
    },
    // Completion closes the modal on its own (device-flow parity): the tick
    // watches the auth state, so no manual recheck affordance exists.
    { auth, noticeCenter: host.noticeCenter, t },
  ).awaitAction();

  if (result.action === "cancel") {
    // Abandon this attempt and let the user switch methods (e.g. from the
    // broken redirect flow to code login) without restarting Obsidian.
    auth.cancelPendingLogin();
    return chooseAuthMethod(host, auth);
  }
  if (result.action === "reopen" && reopenPromise) {
    await (reopenPromise as Promise<void>);
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
