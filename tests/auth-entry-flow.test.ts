import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAuthEntryAction,
  resolveAuthEntryPresentation,
  type AuthEntryFlowHost,
} from "../src/ui/auth-entry-flow";

const modalState = vi.hoisted(() => ({
  action: "dismiss" as "recheck" | "reopen" | "cancel" | "dismiss",
  copy: false,
}));

vi.mock("../src/ui/auth-pending-modal", () => ({
  AuthPendingModal: class {
    private readonly onCopy?: () => void | Promise<void>;
    private readonly onReopen?: () => void;

    constructor(
      _app: unknown,
      _title: string,
      _message: string,
      _recheckLabel: string,
      _copyLabel: string,
      _reopenLabel: string,
      _cancelLabel: string,
      onCopy?: () => void | Promise<void>,
      onReopen?: () => void,
    ) {
      this.onCopy = onCopy;
      this.onReopen = onReopen;
    }

    async awaitAction(): Promise<{ action: typeof modalState.action }> {
      if (modalState.copy) await this.onCopy?.();
      if (modalState.action === "reopen") this.onReopen?.();
      return { action: modalState.action };
    }
  },
}));

const noticeState = vi.hoisted(() => ({
  confirmed: true,
  captured: null as null | {
    title: string;
    lines: string[];
    continueLabel: string;
  },
}));

vi.mock("../src/ui/auth-login-notice-modal", () => ({
  AuthLoginNoticeModal: class {
    constructor(
      _app: unknown,
      title: string,
      lines: string[],
      continueLabel: string,
    ) {
      noticeState.captured = { title, lines, continueLabel };
    }

    async awaitContinue(): Promise<boolean> {
      return noticeState.confirmed;
    }

    open(): void {}
  },
}));

const methodModalState = vi.hoisted(() => ({
  action: "dismiss" as "browser" | "device" | "dismiss",
  deviceRejects: false,
  captured: null as null | {
    lead: string;
    browser: { title: string; description: string };
    device: { title: string; description: string };
    onBrowserSelect: () => void | Promise<void>;
    onDeviceSelect: () => Promise<unknown>;
  },
}));

vi.mock("../src/ui/auth-method-modal", () => ({
  AuthMethodModal: class {
    constructor(
      _app: unknown,
      lead: string,
      browser: { title: string; description: string },
      device: { title: string; description: string },
      onBrowserSelect: () => void | Promise<void>,
      onDeviceSelect: () => Promise<unknown>,
    ) {
      methodModalState.captured = {
        lead,
        browser,
        device,
        onBrowserSelect,
        onDeviceSelect,
      };
    }

    async awaitAction(): Promise<{ action: "browser" | "device" | "dismiss" }> {
      if (methodModalState.action === "browser") {
        // The real modal invokes the callback inside the option's click
        // handler — before any await — so login stays on the gesture chain.
        await methodModalState.captured?.onBrowserSelect();
        return { action: "browser" };
      }
      if (methodModalState.action === "device") {
        if (methodModalState.deviceRejects) {
          try {
            await methodModalState.captured?.onDeviceSelect();
          } catch {
            // The real modal stays open with the option re-enabled; the
            // entry-flow promise therefore never settles in this case.
            return new Promise(() => undefined);
          }
        } else {
          await methodModalState.captured?.onDeviceSelect();
          return { action: "device" };
        }
      }
      return { action: "dismiss" };
    }
  },
}));

const deviceModalState = vi.hoisted(() => ({
  opened: [] as Array<{ app: unknown; deps: Record<string, unknown> }>,
}));

vi.mock("../src/ui/auth-device-code-modal", () => ({
  AuthDeviceCodeModal: class {
    constructor(app: unknown, deps: Record<string, unknown>) {
      deviceModalState.opened.push({ app, deps });
    }

    open(): void {}
  },
}));

function makeHost(input: {
  isInitializing?: boolean;
  isLoggedIn?: boolean;
  isPending?: boolean;
  pendingAuthUrl?: string | null;
  deviceAttempt?: Record<string, unknown> | null;
  checkAuthStatus?: boolean;
  login?: ReturnType<typeof vi.fn>;
  beginDeviceCodeLogin?: ReturnType<typeof vi.fn>;
  cancelPendingLogin?: ReturnType<typeof vi.fn>;
} = {}): {
  host: AuthEntryFlowHost;
  login: ReturnType<typeof vi.fn>;
  checkAuthStatus: ReturnType<typeof vi.fn>;
  showNotice: ReturnType<typeof vi.fn>;
  pendingFlag: { value: boolean };
} {
  const pendingFlag = { value: input.isPending ?? false };
  const login = input.login ?? vi.fn().mockImplementation(() => {
    // Mirror AuthModule.login(): the browser opens synchronously, so the
    // attempt becomes pending before the promise settles.
    pendingFlag.value = true;
    return Promise.resolve();
  });
  const checkAuthStatus = vi.fn(() => input.checkAuthStatus ?? false);
  const showNotice = vi.fn();
  const auth = {
    isInitializing: input.isInitializing ?? false,
    get isPending() {
      return pendingFlag.value;
    },
    pendingAuthUrl: input.pendingAuthUrl ?? null,
    deviceAttempt: input.deviceAttempt ?? null,
    authState: {
      isLoggedIn: input.isLoggedIn ?? false,
    },
    login,
    checkAuthStatus,
    beginDeviceCodeLogin: input.beginDeviceCodeLogin
      ?? vi.fn().mockResolvedValue({}),
    cancelPendingLogin: input.cancelPendingLogin ?? vi.fn(),
  };
  return {
    host: {
      app: {} as AuthEntryFlowHost["app"],
      auth: auth as unknown as AuthEntryFlowHost["auth"],
      i18n: {
        t: (key: string) => key,
      },
      noticeCenter: {
        show: showNotice,
      },
    },
    login,
    checkAuthStatus,
    showNotice,
    pendingFlag,
  };
}

describe("resolveAuthEntryPresentation", () => {
  it("uses the same native action semantics for initializing, pending, and idle login", () => {
    expect(resolveAuthEntryPresentation({
      isInitializing: true,
      isPending: false,
    })).toEqual({
      labelKey: "settings.account.checking",
      descriptionKey: "settings.account.desc.connecting",
      disabled: true,
      cta: false,
    });
    expect(resolveAuthEntryPresentation({
      isInitializing: false,
      isPending: true,
    })).toEqual({
      labelKey: "settings.account.confirmAfterBrowser",
      descriptionKey: "settings.account.desc.pending",
      disabled: false,
      cta: true,
    });
    expect(resolveAuthEntryPresentation({
      isInitializing: false,
      isPending: true,
      isDevicePending: true,
    })).toEqual({
      labelKey: "settings.account.resumeDevice",
      descriptionKey: "settings.account.desc.devicePending",
      disabled: false,
      cta: true,
    });
    expect(resolveAuthEntryPresentation({
      isInitializing: false,
      isPending: false,
    })).toEqual({
      labelKey: "settings.account.login",
      descriptionKey: "settings.account.desc.notLoggedIn",
      disabled: false,
      cta: true,
    });
  });
});

describe("handleAuthEntryAction", () => {
  beforeEach(() => {
    modalState.action = "dismiss";
    modalState.copy = false;
    noticeState.confirmed = true;
    noticeState.captured = null;
    methodModalState.action = "dismiss";
    methodModalState.deviceRejects = false;
    methodModalState.captured = null;
    deviceModalState.opened.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the agreed login notice before the method chooser on every fresh login", async () => {
    const { host, login } = makeHost();

    await handleAuthEntryAction(host);

    expect(noticeState.captured).not.toBeNull();
    expect(noticeState.captured?.title).toBe("auth.notice.title");
    expect(noticeState.captured?.lines).toEqual([
      "auth.notice.line1",
      "auth.notice.line2",
      "auth.notice.line3",
    ]);
    expect(noticeState.captured?.continueLabel).toBe("auth.notice.continue");
    expect(methodModalState.captured).not.toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it("cancels the whole login flow when the login notice is dismissed", async () => {
    noticeState.confirmed = false;
    const { host, login, showNotice } = makeHost();

    await handleAuthEntryAction(host);

    expect(noticeState.captured).not.toBeNull();
    expect(methodModalState.captured).toBeNull();
    expect(login).not.toHaveBeenCalled();
    expect(showNotice).not.toHaveBeenCalled();
  });

  it("presents the method chooser before any fresh login", async () => {
    const { host, login } = makeHost();

    await handleAuthEntryAction(host);

    expect(methodModalState.captured).not.toBeNull();
    expect(methodModalState.captured?.lead).toBe(
      "settings.account.method.lead",
    );
    expect(methodModalState.captured?.browser.title).toBe(
      "settings.account.method.browser.name",
    );
    expect(methodModalState.captured?.browser.description).toBe(
      "settings.account.method.browser.desc",
    );
    expect(methodModalState.captured?.device.title).toBe(
      "settings.account.method.device.name",
    );
    expect(login).not.toHaveBeenCalled();
  });

  it("starts the browser login synchronously and guides the user back (D4)", async () => {
    methodModalState.action = "browser";
    const { host, login, showNotice, pendingFlag } = makeHost();

    // The login gate resolves first; the browser then opens synchronously
    // inside the option click chain, so the attempt is pending before the
    // action promise settles.
    await handleAuthEntryAction(host);
    expect(pendingFlag.value).toBe(true);

    expect(login).toHaveBeenCalledOnce();
    expect(deviceModalState.opened).toHaveLength(0);
    expect(showNotice).toHaveBeenCalledWith({
      key: "settings-login-browser-opened",
      message: "settings.account.browserOpened",
      priority: 30,
    });
  });

  it("issues the devicecode request and opens the waiting modal on success", async () => {
    methodModalState.action = "device";
    const beginDeviceCodeLogin = vi.fn().mockResolvedValue({
      userCode: "ABCDEFGHI",
    });
    const cancelPendingLogin = vi.fn();
    const { host, login, showNotice } = makeHost({
      beginDeviceCodeLogin,
      cancelPendingLogin,
    });

    await handleAuthEntryAction(host);

    expect(beginDeviceCodeLogin).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
    expect(deviceModalState.opened).toHaveLength(1);
    expect(deviceModalState.opened[0].deps.auth).toBe(host.auth);
    expect(showNotice).not.toHaveBeenCalled();
    expect(cancelPendingLogin).not.toHaveBeenCalled();
  });

  it("surfaces a devicecode request failure and keeps the chooser open", async () => {
    methodModalState.action = "device";
    methodModalState.deviceRejects = true;
    const beginDeviceCodeLogin = vi.fn().mockRejectedValue(
      new Error("offline"),
    );
    const cancelPendingLogin = vi.fn();
    const { host, showNotice } = makeHost({
      beginDeviceCodeLogin,
      cancelPendingLogin,
    });

    // The chooser stays open on failure, so the entry-flow promise never
    // settles; flush the login-gate + chooser microtask chain first.
    const pending = handleAuthEntryAction(host);
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }

    expect(beginDeviceCodeLogin).toHaveBeenCalledOnce();
    expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({
      key: "auth-login-error",
      message: "offline",
      priority: 50,
    }));
    expect(deviceModalState.opened).toHaveLength(0);
    expect(cancelPendingLogin).not.toHaveBeenCalled();

    // Keep the never-settling promise from surfacing an unhandled state.
    void pending;
  });

  it("cancels a dismissed chooser so an in-flight devicecode request cannot commit", async () => {
    const cancelPendingLogin = vi.fn();
    const { host } = makeHost({ cancelPendingLogin });

    await handleAuthEntryAction(host);

    expect(cancelPendingLogin).toHaveBeenCalledOnce();
  });

  it("rechecks a pending login through the shared modal without opening another browser", async () => {
    modalState.action = "recheck";
    const { host, login, checkAuthStatus, showNotice } = makeHost({
      isPending: true,
      checkAuthStatus: false,
    });

    await handleAuthEntryAction(host);

    expect(checkAuthStatus).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
    expect(noticeState.captured).toBeNull();
    expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({
      key: "settings-login-pending",
      message: "settings.account.desc.pending",
    }));
  });

  it("reopens a pending login through the same synchronous login entry", async () => {
    modalState.action = "reopen";
    let actionReturned = false;
    const login = vi.fn(() => {
      expect(actionReturned).toBe(false);
      return Promise.resolve();
    });
    const { host } = makeHost({
      isPending: true,
      checkAuthStatus: false,
      login,
    });

    const result = handleAuthEntryAction(host);
    actionReturned = true;
    await result;

    expect(login).toHaveBeenCalledOnce();
  });

  it("cancels a pending login and reopens the method chooser so the user can switch methods", async () => {
    modalState.action = "cancel";
    const cancelPendingLogin = vi.fn();
    const { host, login } = makeHost({
      isPending: true,
      cancelPendingLogin,
    });

    await handleAuthEntryAction(host);

    // First call abandons the pending attempt; the reopened chooser then
    // resolves to "dismiss", whose guard calls cancel again (idempotent).
    expect(cancelPendingLogin).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
    expect(methodModalState.captured).not.toBeNull();
  });

  it("reopens the same device-code attempt instead of issuing a new code", async () => {
    const beginDeviceCodeLogin = vi.fn();
    const { host } = makeHost({
      isPending: true,
      deviceAttempt: { userCode: "ABCDEFGHI", phase: "waiting" },
      beginDeviceCodeLogin,
    });

    await handleAuthEntryAction(host);

    // Re-entry reopens the waiting modal bound to the SAME attempt — no new
    // devicecode request, no browser pending modal, no method chooser, and
    // no login notice (this is a continuation, not a fresh login).
    expect(deviceModalState.opened).toHaveLength(1);
    expect(beginDeviceCodeLogin).not.toHaveBeenCalled();
    expect(methodModalState.captured).toBeNull();
    expect(noticeState.captured).toBeNull();
  });

  it("copies the exact current pending URL without starting another login", async () => {
    const authUrl = "https://login.microsoftonline.com/authorize?state=current-state";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    modalState.copy = true;
    const { host, login, showNotice } = makeHost({
      isPending: true,
      pendingAuthUrl: authUrl,
    });

    await handleAuthEntryAction(host);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(authUrl);
    expect(login).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith({
      key: "settings-login-link-copied",
      message: "settings.account.authLinkCopied",
      priority: 30,
    });
  });

  it("keeps the pending login intact and reports clipboard failure", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    modalState.copy = true;
    const { host, login, showNotice } = makeHost({
      isPending: true,
      pendingAuthUrl: "https://login.microsoftonline.com/authorize?state=current-state",
    });

    await handleAuthEntryAction(host);

    expect(login).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith({
      key: "settings-login-link-unavailable",
      message: "settings.account.authLinkUnavailable",
      priority: 50,
    });
  });

  it("does not copy an expired pending URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    modalState.copy = true;
    const { host, login, showNotice } = makeHost({
      isPending: true,
      pendingAuthUrl: null,
    });

    await handleAuthEntryAction(host);

    expect(writeText).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith({
      key: "settings-login-link-unavailable",
      message: "settings.account.authLinkUnavailable",
      priority: 50,
    });
  });
});
