import { describe, expect, it } from "vitest";
import en from "../src/i18n/en";

/** 2026-10-20 en 文案收口（用户授权 AI 定稿）：en 用户可见面统一用 "cloud"
 *  指云端（"remote" 从展示文案退役）；引号/撇号一律弯号。error.present.* 是
 *  稳定错误码层（en 直通契约，见 i18n 规范 §4.2），不属本轮展示文案，豁免。 */
const VALUES = Object.entries(en as unknown as Record<string, string>);

describe("en copy contracts", () => {
  it("keeps cloud as the only cloud-side word outside the stable-code layer", () => {
    for (const [key, value] of VALUES) {
      if (key.startsWith("error.present.")) continue;
      const display = value.replace(/\{[^}]*\}/g, "");
      expect(display, `en.${key}`).not.toMatch(/\bremote\b/i);
    }
  });

  it("never uses straight quotes or apostrophes in en values", () => {
    for (const [key, value] of VALUES) {
      expect(value, `en.${key}`).not.toMatch(/['"]/);
    }
  });

  it("pins the conflict buttons the identity-mismatch notice quotes", () => {
    expect(en["syncView.conflict.keepLocal"]).toBe("Keep local");
    expect(en["syncView.conflict.keepRemote"]).toBe("Keep cloud");
    expect(en["syncView.pluginBundleReview.identityMismatchNotice"]).toContain(
      "“Keep local”",
    );
    expect(en["syncView.pluginBundleReview.identityMismatchNotice"]).toContain(
      "“Keep cloud”",
    );
  });

  it("pins the one-way keep action name quoted by the reminders-off row", () => {
    expect(en["syncView.localOnly.keep"]).toBe(
      "Keep on this device, no more reminders",
    );
    expect(en["settings.localOnlyIgnored.desc"]).toContain(
      "you chose “Keep on this device, no more reminders” for {count} file(s)",
    );
  });
});
