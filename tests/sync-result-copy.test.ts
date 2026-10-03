import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

/**
 * 延后轮结果句（2026-10-02 用户拍板 A 案）：该计数混装十余类延后原因
 * （本机再变／本机文件消失／云端版本移动／文件夹身份待确认等）且含文件夹，
 * 旧句「文件在同步前再次变化」只对其中一类成立。新句只陈述结果与下一步，
 * 不陈述原因，与同族 `result.skipped` 的「项未同步」句式对齐。
 * 定稿文案落逐字断言，防止后续改写或退回成因断言。
 */
describe("deferred round result copy", () => {
  it("states the outcome without claiming a cause", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("result.deferred", { deferred: 2 })).toBe(
      "本轮有 2 项未同步，将在下一轮自动处理",
    );
    expect(en.t("result.deferred", { deferred: 2 })).toBe(
      "2 item(s) were not synced and will be handled in the next run.",
    );
  });

  it("keeps the neutral opening aligned with the skipped-round sentence", () => {
    const zh = new I18n("zh-cn");

    // 同一家族句式：都以「本轮有 N 项未同步」开头，后半句区分去向。
    expect(zh.t("result.deferred", { deferred: 1 }).startsWith("本轮有 1 项未同步")).toBe(true);
    expect(zh.t("result.skipped", { skipped: 1 }).startsWith("本轮有 1 项未同步")).toBe(true);
    // 「项」而非「文件」：该计数含文件夹。
    expect(zh.t("result.deferred", { deferred: 1 })).not.toContain("文件");
  });
});