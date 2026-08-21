import { afterEach, describe, expect, it, vi } from "vitest";
import { I18n } from "../src/i18n";
import {
  devicePhaseMessageKey,
  formatRemaining,
  groupCode,
  verificationPageUrl,
} from "../src/ui/auth-device-code-modal";

describe("verificationPageUrl", () => {
  it("falls back to the plain verification page when no pre-filled URI exists", () => {
    expect(verificationPageUrl({
      verificationUri: "https://microsoft.com/devicelogin",
      verificationUriComplete: null,
    })).toBe("https://microsoft.com/devicelogin");
  });

  it("prefers the provider's pre-filled URI when present", () => {
    expect(verificationPageUrl({
      verificationUri: "https://microsoft.com/devicelogin",
      verificationUriComplete: "https://microsoft.com/devicelogin?otc=ABC",
    })).toBe("https://microsoft.com/devicelogin?otc=ABC");
  });
});

describe("groupCode", () => {
  it("groups a 9-character code in threes", () => {
    expect(groupCode("ABCDEFGHI")).toBe("ABC DEF GHI");
  });

  it("keeps partial groups intact and trims stray spaces", () => {
    expect(groupCode("ABCDE")).toBe("ABC DE");
    expect(groupCode("")).toBe("");
  });
});

describe("formatRemaining", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the remaining time as m:ss (ceil)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00Z"));
    expect(formatRemaining(Date.now() + 892_000)).toBe("14:52");
  });

  it("clamps at 0:00 once the deadline passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00Z"));
    expect(formatRemaining(Date.now() - 1)).toBe("0:00");
    expect(formatRemaining(Date.now())).toBe("0:00");
  });
});

describe("devicePhaseMessageKey", () => {
  it("maps every terminal phase to its i18n key", () => {
    expect(devicePhaseMessageKey("declined")).toBe(
      "settings.account.device.declined",
    );
    expect(devicePhaseMessageKey("expired")).toBe(
      "settings.account.device.expired",
    );
    expect(devicePhaseMessageKey("mismatch")).toBe(
      "settings.account.device.mismatch",
    );
    expect(devicePhaseMessageKey("failed")).toBe(
      "settings.account.device.failed",
    );
  });
});

describe("device code i18n keys", () => {
  it("resolves the new method and device-flow keys in both locales", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("settings.account.method.browser.name")).toBe("跳转登录");
    expect(zh.t("settings.account.method.browser.desc")).toContain("自动登录");
    expect(zh.t("settings.account.method.device.name")).toBe("输入代码登录");
    expect(zh.t("settings.account.method.device.desc")).toContain("9 位码");
    expect(zh.t("settings.account.device.title")).toBe("输入代码登录");
    expect(zh.t("settings.account.device.openVerify")).toContain("浏览器");
    expect(zh.t("settings.account.device.copyCode")).toBe("复制代码");
    expect(zh.t("settings.account.device.waiting")).toContain("登录");
    expect(zh.t("settings.account.device.expiresIn", { time: "14:32" }))
      .toBe("14:32 后过期");
    expect(zh.t("settings.account.device.security")).toContain("不要发送给任何人");
    expect(zh.t("settings.account.device.regenerate")).toBe("重新生成代码");
    expect(zh.t("settings.account.device.cancel")).toBe("取消登录");
    expect(zh.t("settings.account.cancelLogin")).toBe("取消登录");
    expect(zh.t("settings.account.resumeDevice")).toBe("继续输入代码登录");
    expect(zh.t("settings.account.desc.devicePending")).toContain("有效期");
    expect(zh.t("settings.account.device.checkNow")).toBe("立即检查");
    expect(zh.t("settings.account.device.checking")).toContain("检查");
    expect(zh.t("settings.account.device.notYet")).toContain("浏览器");

    expect(en.t("settings.account.method.browser.name")).toBe("Browser redirect");
    expect(en.t("settings.account.method.device.name")).toBe("Enter a code");
    expect(en.t("settings.account.method.device.desc")).toContain("9-character");
    expect(en.t("settings.account.device.openVerify")).toContain("browser");
    expect(en.t("settings.account.device.expiresIn", { time: "14:32" }))
      .toBe("expires in 14:32");
    expect(en.t("settings.account.device.security")).toContain("never share");
    expect(en.t("settings.account.device.regenerate")).toBe("Generate a new code");
    expect(en.t("settings.account.cancelLogin")).toBe("Cancel sign-in");
    expect(en.t("settings.account.resumeDevice")).toBe("Continue code sign-in");
    expect(en.t("settings.account.desc.devicePending")).toContain("valid");
    expect(en.t("settings.account.device.checkNow")).toBe("Check now");
    expect(en.t("settings.account.device.notYet")).toContain("browser");

    // S4 redirect-path guidance keys
    expect(zh.t("settings.account.confirmAfterBrowser")).toBe(
      "完成浏览器登录后点这里确认",
    );
    expect(zh.t("settings.account.browserOpened")).toContain("回到 Obsidian");
    expect(en.t("settings.account.confirmAfterBrowser")).toBe(
      "After signing in, tap here to confirm",
    );
    expect(en.t("settings.account.browserOpened")).toContain("return to Obsidian");
  });
});
