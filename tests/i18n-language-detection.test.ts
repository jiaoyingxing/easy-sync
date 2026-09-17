/**
 * detectLanguage 链路钉测（2026-09-17 商店告警可消项实施②）。
 *
 * 官方 obsidianmd/prefer-get-language 规则点名 getLanguage() 为用户语言
 * 的正源；本轮把探测链从 vault config → localStorage → navigator 改为
 * 官方 API 优先（无该 API 的构筑物回退 vault config → navigator），
 * localStorage 裸引用随之移除（全仓最后一处，商店 BEHAVIOR「Local
 * Storage」建议的疑似触发点）。本文件钉住：
 *   1. 官方 API 有值时最高优先（旧代码无此路径，实施前红）；
 *   2. 官方 API 缺席（旧版宿主／mock 置空）时回退 vault config；
 *   3. 两级都无值时回退 navigator.language，再退 "en"。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLanguage } from "obsidian";
import { I18n } from "../src/i18n/index";

describe("I18n.detectLanguage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    getLanguage.mockReset();
  });

  it("prefers the official getLanguage() API", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    getLanguage.mockReturnValue("zh");
    expect(I18n.detectLanguage()).toBe("zh");
  });

  it("falls back to the vault config when the official API is unavailable", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    getLanguage.mockReturnValue("");
    expect(
      I18n.detectLanguage({ vault: { getConfig: () => "fr" } }),
    ).toBe("fr");
  });

  it("falls back to navigator.language then en", () => {
    getLanguage.mockReturnValue("");
    vi.stubGlobal("navigator", { language: "pt-BR" });
    expect(I18n.detectLanguage()).toBe("pt-BR");
    vi.stubGlobal("navigator", undefined);
    expect(I18n.detectLanguage()).toBe("en");
  });
});
