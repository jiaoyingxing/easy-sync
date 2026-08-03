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

    launcher.openUrl(AUTH_URL);

    expect(openWindow).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith(
      AUTH_URL,
      "_external",
    );
  });

  it("opens the completed mobile authorization URL directly without an about:blank bridge", () => {
    const openWindow = vi.fn(() => null);
    const launcher = createAuthBrowserLauncher({
      isDesktopApp: false,
      openWindow,
    });

    launcher.openUrl(AUTH_URL);

    expect(openWindow).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith(AUTH_URL, "_blank");
    expect("openAuthPopup" in launcher).toBe(false);
  });

  it("keeps the manual-copy recovery user-facing and actionable", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("settings.account.pendingTitle")).toBe("登录还没有完成");
    expect(zh.t("settings.account.pendingMessage")).toBe(
      "请在浏览器中完成 Microsoft 登录。没有看到登录页面？复制登录链接，然后粘贴到这台设备的浏览器中打开。",
    );
    expect(zh.t("settings.account.copyAuthLink")).toBe("复制登录链接");
    expect(zh.t("settings.account.authLinkCopied")).toBe(
      "登录链接已复制，请尽快在这台设备的浏览器中打开，不要分享。",
    );
    expect(zh.t("settings.account.authLinkUnavailable")).toBe(
      "无法复制登录链接，请重新打开登录页面。",
    );
    expect(zh.t("settings.account.pendingMessage")).not.toContain("系统默认浏览器");
    expect(zh.t("settings.account.pendingMessage")).not.toContain("网页浏览器");
    expect(zh.t("settings.account.pendingMessage")).not.toContain("obsidian://");
    expect(en.t("settings.account.pendingTitle")).toBe("Sign-in not complete");
    expect(en.t("settings.account.pendingMessage")).toBe(
      "Complete Microsoft sign-in in your browser. If the page did not open, copy the sign-in link and paste it into a browser on this device.",
    );
    expect(en.t("settings.account.copyAuthLink")).toBe("Copy sign-in link");
    expect(en.t("settings.account.authLinkCopied")).toBe(
      "Sign-in link copied. Open it in a browser on this device soon, and do not share it.",
    );
    expect(en.t("settings.account.authLinkUnavailable")).toBe(
      "Couldn’t copy the sign-in link. Reopen the sign-in page.",
    );
    expect(en.t("settings.account.pendingMessage")).not.toContain("default browser");
    expect(en.t("settings.account.pendingMessage")).not.toContain("Web viewer");
    expect(en.t("settings.account.pendingMessage")).not.toContain("obsidian://");
  });
});
