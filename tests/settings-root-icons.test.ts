/**
 * 设置页图标钉子（左栏插件行 ＋ 1.13+ 根级导航五行）。
 *
 * 本仓无 jsdom，装饰器的 DOM 行为不能在这里证明（真宿主读数与用户目测＝方案单
 * §九②③）；这里钉住可机械判定的部分：
 *   R1 图标映射与根级页一一对应（中英双语）——新增页面漏配图标即红；
 *   R2 图标值互不重复——两行同图标用户分不清；
 *   R3 装饰器形状：只装根级（排除 .setting-page）、幂等、纯装饰（aria-hidden）、
 *      无平台分支、不用 rAF；
 *   R4 两处挂点接线：构造期带左栏图标 ＋ 容器观察器在 containerEl 上；
 *   R5 styles.css 的两条规则都在。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SETTINGS_ROOT_ICON_BY_NAME_KEY,
  SETTINGS_ROOT_ROW_ICON_CLASS,
  SETTINGS_TAB_ICON,
} from "../src/ui/settings-root-icons";
import {
  EasySyncSettingTab,
  buildSettingDefinitions,
} from "../src/ui/settings-tab";
import { I18n } from "../src/i18n";
import type EasySyncPlugin from "../src/main";

/** 只提供 buildSettingDefinitions 与装饰接线在构造期会读到的成员。 */
function createMockPlugin(): EasySyncPlugin {
  return {
    app: {},
    register: vi.fn(),
    manifest: { version: "1.6.0" },
    excludedFolders: [],
    notificationPopups: "all",
    isAutoSyncMasterEnabled: () => true,
    getUpdatePromptState: () => null,
    getIgnoredLocalOnlyCount: () => 0,
    i18n: { t: (key: string) => key },
  } as unknown as EasySyncPlugin;
}

describe("settings root icons", () => {
  it.each(["zh-cn", "en"] as const)(
    "图标映射与根级页一一对应（%s；新增页面漏配即红）",
    (language) => {
      const t = new I18n(language).t.bind(new I18n(language));
      const pages = buildSettingDefinitions(t, createMockPlugin());
      const pageNames = pages.map((page) => page.name);
      // 装饰按「行名＝页名」匹配：页名必须兄弟唯一，否则映射无意义。
      expect(new Set(pageNames).size).toBe(pageNames.length);
      const iconNames = Object.keys(SETTINGS_ROOT_ICON_BY_NAME_KEY).map((key) =>
        t(key),
      );
      expect([...iconNames].sort()).toEqual([...pageNames].sort());
    },
  );

  it("图标值互不重复", () => {
    const values = Object.values(SETTINGS_ROOT_ICON_BY_NAME_KEY);
    expect(new Set(values).size).toBe(values.length);
    // 左栏插件行图标与五位根级行图标也只是同表内互异（跨载体可同）。
    expect(typeof SETTINGS_TAB_ICON).toBe("string");
    expect(SETTINGS_TAB_ICON.length).toBeGreaterThan(0);
  });

  it("装饰器只装根级行、幂等、纯装饰、无平台分支（源码形状）", () => {
    const source = readFileSync("src/ui/settings-root-icons.ts", "utf8");
    // 只装饰根级：子页里有一行与页同名（「自动同步」页的总开关行）。
    expect(source).toContain('.closest(".setting-page")');
    // 幂等判据＝行首已带自家标记类。
    expect(source).toContain("firstElementChild");
    expect(source).toContain("row.prepend(");
    // 纯装饰：不进 tab 序、不承载语义。
    expect(source).toContain('setAttribute("aria-hidden", "true")');
    // 无平台分支、不用 rAF（设置窗前台时主窗 rAF 不跑）。
    expect(source).not.toContain("Platform");
    expect(source).not.toContain("requestAnimationFrame");
    // 幂等判据与创建必须走同一个常量：类名字面量只允许作为常量值出现一次、且两处
    // 使用都经常量名——两处漂移会让每轮 DOM 变化再插一枚（观察器自激）。
    const literals = [...source.matchAll(/"([^"]*)"/g)]
      .map((match) => match[1])
      .filter((value) => value.includes("easy-sync-settings-root-icon"));
    expect(literals).toEqual([SETTINGS_ROOT_ROW_ICON_CLASS]);
    expect(source.split("SETTINGS_ROOT_ROW_ICON_CLASS").length - 1).toBe(3);
  });

  it("设置页签在构造期带左栏图标，补挂观察器挂在本页容器上", () => {
    const tab = new EasySyncSettingTab(createMockPlugin());
    expect(tab.icon).toBe(SETTINGS_TAB_ICON);
    const source = readFileSync("src/ui/settings-tab.ts", "utf8");
    expect(source).toContain("this.icon = SETTINGS_TAB_ICON;");
    expect(source).toContain("new MutationObserver(");
    expect(source).toContain(".observe(this.containerEl");
    expect(source).toContain("decorateSettingsRootRowIcons(");
    // <1.13 的 display() 弹框形态没有根级导航行：只在声明式渲染时装饰。
    expect(source).toContain("settingItems === undefined");
  });

  it("行图标间距对齐 Resojot 写法：基础 8px ＋ body.is-phone 前缀 4px（前缀承重）", () => {
    // 先剥注释：注释里也写着 body.is-phone，直接扫原文会假绿（本轮变异实测命中）。
    const css = readFileSync("styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = [
      ...css.matchAll(/[^{}]*\.easy-sync-settings-root-icon[^{}]*\{[^}]*\}/g),
    ].map((match) => match[0]);
    const selectors = blocks
      .map((block) => block.slice(0, block.indexOf("{")).trim())
      .sort();
    // 选择器面必须与此一致：不许出现能压过宿主 `.setting-item > *:first-child`
    // （(0,2,0)）的桌面级覆盖——那会让桌面比宿主与 Resojot 更紧（上一版三段选择器
    // 即此错）；也不许手机档退化成单类（会被宿主压掉、等于没写）。
    expect(selectors).toEqual(
      [
        ".easy-sync-settings-root-icon",
        ".easy-sync-settings-root-icon svg",
        "body.is-phone .easy-sync-settings-root-icon",
      ].sort(),
    );
    const baseRule = blocks.find((block) =>
      block.trim().startsWith(".easy-sync-settings-root-icon {"),
    );
    expect(baseRule).toContain("margin-inline-end: var(--size-4-2)");
    const phoneRule = blocks.find((block) => block.trim().startsWith("body.is-phone"));
    expect(phoneRule).toContain("margin-inline-end: var(--size-4-1)");
  });

  it("两处样式挂点都在：左栏只放开本插件那一行 ＋ 根级行首图标", () => {
    const css = readFileSync("styles.css", "utf8");
    expect(css).toContain(
      '.vertical-tab-nav-item[data-setting-id="easy-sync"] .vertical-tab-nav-item-icon',
    );
    expect(css).toContain(`.${SETTINGS_ROOT_ROW_ICON_CLASS}`);
    // 宿主隐藏规则用 display:none，放开规则不靠 !important 压它。
    const rule = css.slice(
      css.indexOf('.vertical-tab-nav-item[data-setting-id="easy-sync"]'),
    ).slice(0, 200);
    expect(rule).toContain("display: flex;");
    expect(rule).not.toContain("!important");
  });
});
