import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAuthEntryAction,
  resolveAuthEntryPresentation,
  type AuthEntryFlowHost,
} from "../src/ui/auth-entry-flow";

const modalState = vi.hoisted(() => ({
  action: "dismiss" as "recheck" | "reopen" | "dismiss",
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

function makeHost(input: {
  isInitializing?: boolean;
  isLoggedIn?: boolean;
  isPending?: boolean;
  pendingAuthUrl?: string | null;
  checkAuthStatus?: boolean;
  login?: ReturnType<typeof vi.fn>;
} = {}): {
  host: AuthEntryFlowHost;
  login: ReturnType<typeof vi.fn>;
  checkAuthStatus: ReturnType<typeof vi.fn>;
  showNotice: ReturnType<typeof vi.fn>;
} {
  const login = input.login ?? vi.fn().mockResolvedValue(undefined);
  const checkAuthStatus = vi.fn(() => input.checkAuthStatus ?? false);
  const showNotice = vi.fn();
  const auth = {
    isInitializing: input.isInitializing ?? false,
    isPending: input.isPending ?? false,
    pendingAuthUrl: input.pendingAuthUrl ?? null,
    authState: {
      isLoggedIn: input.isLoggedIn ?? false,
    },
    login,
    checkAuthStatus,
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
      labelKey: "settings.account.checking",
      descriptionKey: "settings.account.desc.pending",
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts a fresh login synchronously with the UI click chain", async () => {
    let actionReturned = false;
    const login = vi.fn(() => {
      expect(actionReturned).toBe(false);
      return Promise.resolve();
    });
    const { host } = makeHost({ login });

    const result = handleAuthEntryAction(host);
    actionReturned = true;
    await result;

    expect(login).toHaveBeenCalledOnce();
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
