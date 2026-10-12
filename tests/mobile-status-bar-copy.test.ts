/**
 * 移动端常驻状态图标开关的用户可见文案。
 *
 * 逐字钉住设置页「显示」页新增开关行的名称与说明句。说明句按 2026-10-12
 * 用户定稿（去掉了桌面端边界句：该行仅在移动端渲染，桌面端看不到本行，
 * 无需在文案里自我解释——显示隔离见方案单 20261012-225046 §三）。
 */
import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

describe("mobile status bar toggle copy", () => {
  const zh = new I18n("zh-cn");
  const en = new I18n("en");

  it("pins the display-page toggle name and description verbatim", () => {
    expect(zh.t("settings.mobileStatusBar.name")).toBe("移动端状态图标");
    expect(zh.t("settings.mobileStatusBar.desc")).toBe(
      "在手机、平板右下角常驻显示同步状态图标，随同步状态变化；点按可立即同步或查看同步详情。",
    );
    expect(en.t("settings.mobileStatusBar.name")).toBe("Mobile status icon");
    expect(en.t("settings.mobileStatusBar.desc")).toBe(
      "Show a persistent sync status icon in the bottom corner on phones and tablets; it changes with the sync state. Tap to start a sync or view sync details.",
    );
  });
});
