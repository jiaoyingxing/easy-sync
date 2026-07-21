import { describe, expect, it, vi } from "vitest";
import { I18n } from "../src/i18n";
import { createAuthBrowserLauncher } from "../src/auth/auth-browser";

const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test";

describe("auth browser launcher", () => {
  it("opens desktop authorization in the system browser without pre-opening a Web Viewer tab", () => {
    const openWindow = vi.fn(() => null);
    const launcher = createAuthBrowserLauncher({
      isDesktopApp: true,
      openWindow,
    });

    expect(launcher.openAuthPopup()).toBeNull();
    expect(openWindow).not.toHaveBeenCalled();

    launcher.openUrl(AUTH_URL);

    expect(openWindow).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith(
      AUTH_URL,
      "_external",
      "noopener,noreferrer",
    );
  });

  it("keeps the synchronous mobile popup path", () => {
    const popup = {
      location: { href: "about:blank" },
      close: vi.fn(),
    };
    const openWindow = vi.fn(() => popup);
    const launcher = createAuthBrowserLauncher({
      isDesktopApp: false,
      openWindow,
    });

    const handle = launcher.openAuthPopup();

    expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
    expect(handle?.navigate(AUTH_URL)).toBe(true);
    expect(popup.location.href).toBe(AUTH_URL);

    handle?.close();
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("uses the existing direct mobile fallback when popup pre-opening is unavailable", () => {
    const openWindow = vi.fn(() => null);
    const launcher = createAuthBrowserLauncher({
      isDesktopApp: false,
      openWindow,
    });

    expect(launcher.openAuthPopup()).toBeNull();
    launcher.openUrl(AUTH_URL);

    expect(openWindow).toHaveBeenNthCalledWith(1, "about:blank", "_blank");
    expect(openWindow).toHaveBeenNthCalledWith(2, AUTH_URL, "_blank");
  });

  it("keeps the recovery copy user-facing and actionable", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("settings.account.pendingTitle")).toBe("登录还没有完成");
    expect(zh.t("settings.account.pendingMessage")).toContain("重新打开登录页面");
    expect(zh.t("settings.account.pendingMessage")).not.toContain("obsidian://");
    expect(en.t("settings.account.pendingTitle")).toBe("Sign-in not complete");
    expect(en.t("settings.account.pendingMessage")).toContain("Reopen sign-in page");
  });
});
