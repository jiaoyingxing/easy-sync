import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

/**
 * 2026-10-22 全仓冗余 Review Q1：四句曾承诺过头的提示语改为与实际行为一致，
 * 逐字钉住防止回魂（中文由用户圈定，英文由维护侧定稿）。
 * - summary.blocked：账本非空时自动通道不开普通轮，原「不影响其他同步」不成立。
 * - circuitBreaker 两族：重试承诺不再绑定「自动同步运行时」的限定语；行内已有文件。
 * - hint.off：直连 Notice 不受档位过滤，只承诺关键提醒与部分操作结果仍显示。
 */
describe("user copy pins (redundancy review 2026-10-22)", () => {
  it("recovery blocked summary states the auto-sync pause", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    expect(zh.t("syncView.recovery.summary.blocked", { count: 3 })).toBe(
      "有 3 笔操作未确认完成，自动同步已暂停。",
    );
    expect(en.t("syncView.recovery.summary.blocked", { count: 3 })).toBe(
      "3 operation(s) are unconfirmed; automatic sync is paused.",
    );
  });

  it("breaker reasons stay short and do not repeat the file name", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    expect(zh.t("reason.circuitBreaker.network")).toBe(
      "已连续多次传输失败，网络不稳定，稍后将自动重试。",
    );
    expect(en.t("reason.circuitBreaker.network")).toBe(
      "Several transfers failed in a row on an unstable network; automatic retry follows shortly.",
    );
    expect(zh.t("reason.circuitBreaker.remoteMoving")).toBe(
      "云端文件持续变动中，暂无法操作。需等待文件稳定后，系统会自动重试。",
    );
    expect(en.t("reason.circuitBreaker.remoteMoving")).toBe(
      "The cloud file keeps changing and cannot be handled right now; once it settles, the system retries automatically.",
    );
  });

  it("notification-off hint only promises what still shows", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    expect(zh.t("settings.notificationPopups.hint.off")).toBe(
      "仅保留关键提醒和部分操作结果。",
    );
    expect(en.t("settings.notificationPopups.hint.off")).toBe(
      "Shows only critical reminders and some action results.",
    );
  });
});
