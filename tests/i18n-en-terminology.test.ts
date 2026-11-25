import { describe, expect, it } from "vitest";
import en from "../src/i18n/en";

/** 2026-10-20 en 文案收口（用户授权 AI 定稿）：en 用户可见面统一用 "cloud"
 *  指云端（"remote" 从展示文案退役）；引号/撇号一律弯号。error.present.* 是
 *  稳定错误码层（en 直通契约，见 i18n 规范 §4.2），只豁免 remote→cloud 用词，
 *  不豁免直引号禁令（第二个用例仍检查全部 en 值）。 */
const VALUES = Object.entries(en as unknown as Record<string, string>);

describe("en copy contracts", () => {
  // Scan floor + live detectors (测试与检查规范 §2): a renamed/emptied locale
  // file would otherwise let every loop below pass by scanning nothing, and a
  // broken regex would do the same. These three assertions are the gate's
  // self-check, not copy rules.
  it("keeps the scan surface non-empty and the detectors live", () => {
    expect(VALUES.length).toBeGreaterThanOrEqual(1000);
    expect(VALUES.every(([, value]) => typeof value === "string")).toBe(true);
    // The corpus really contains the positive form the first rule looks for...
    expect(VALUES.filter(([, value]) => /\bcloud\b/i.test(value)).length)
      .toBeGreaterThan(0);
    // ...and the curly quotes the second rule accepts.
    expect(VALUES.filter(([, value]) => /[“”‘’]/.test(value)).length)
      .toBeGreaterThan(0);
    // The detectors themselves fire on planted bad samples.
    expect(/\bremote\b/i.test("remote copy")).toBe(true);
    expect(/['"]/.test("it's here")).toBe(true);
  });

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

  it("pins the drift notice naming both sides and the keep-side buttons", () => {
    expect(en["syncView.conflict.keepLocal"]).toBe("Keep local");
    expect(en["syncView.conflict.keepRemote"]).toBe("Keep cloud");
    // The drift notice must name WHICH plugin sits on each side: keeping a
    // side replaces one plugin with another, so the two identities are the
    // fact the user decides on (2026-11-23). Both placeholders are required.
    expect(en["syncView.pluginBundleReview.identityMismatchNotice"]).toContain(
      "({local})",
    );
    expect(en["syncView.pluginBundleReview.identityMismatchNotice"]).toContain(
      "({remote})",
    );
    expect(en["syncView.pluginBundleReview.identityWithName"]).toContain("{name}");
    expect(en["syncView.pluginBundleReview.identityWithName"]).toContain("{id}");
  });

  it("pins the one-way keep action name quoted by the reminders-off row", () => {
    expect(en["syncView.localOnly.keep"]).toBe("Keep on this device");
    expect(en["settings.localOnlyIgnored.desc"]).toContain(
      "you chose “Keep on this device” for {count} file(s)",
    );
  });
});
