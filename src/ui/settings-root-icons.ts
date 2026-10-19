/**
 * 设置页图标（2026-10-17 用户点名，参照姊妹插件 Resojot 的既有轮次）。
 *
 * 两处落点：
 * - 设置窗左栏本插件那一行：走官方 `SettingTab.icon`（宿主只在页签 icon 非空时
 *   建 `.vertical-tab-nav-item-icon`）；宿主对第三方插件整栏隐藏该元素，由
 *   styles.css 只按 `data-setting-id` 放开我们自己那一行。
 * - 1.13+ 根级导航行行首：声明式 schema（`SettingDefinitionPage` 等）**没有**图标
 *   字段（d.ts 1.13.1 与 1.14.4 复核一致），只能在自家容器上按「行名＝页名」补挂。
 *
 * 装饰是纯呈现：不动定义树、不动行文案、不承载语义（`aria-hidden`）。宿主改版
 * 导致类名/属性变化时静默退化为纯文字，不影响任何功能。
 * 方案、宿主事实与验收口径＝docs/temp/20261017-162313 设置页图标方案单…
 */
import { setIcon } from "obsidian";
import type { I18nFn } from "./confirm-modal";

/** 设置窗左栏插件行的页签图标（lucide 裸 id，宿主自行加前缀）。 */
export const SETTINGS_TAB_ICON = "cloud";

/**
 * 根级导航行图标：页名 i18n 键 → lucide 裸 id。
 *
 * 键必须是 `getSettingDefinitions()` 各页 `name` 用的同一个 i18n 键（对账钉子＝
 * tests/settings-root-icons.test.ts）；装饰器按当前语言现算行名，所以改文案或切
 * 语言都不会漂移。值互不重复（两行同图标＝用户分不清），且全部经宿主注册表核对
 * （2026-10-17，1.14.4，注册表 1934 项）。
 */
export const SETTINGS_ROOT_ICON_BY_NAME_KEY = {
  "settings.syncScope.name": "folder-open",
  // 用户点名 `rotate-cw-clock`：宿主注册表无此图标（rotate／clock 家族已普查），
  // 按方案备选取 `timer`（语义＝自动／定时）。
  "settings.autoSync.name": "timer",
  "settings.group.display": "bell",
  "settings.group.about": "info",
  "settings.group.maintenance": "wrench",
} as const;

/**
 * 行首图标的标记类：既是幂等判据（行首已有它即跳过），也是 styles.css 的挂点。
 * 判据与创建必须用同一个常量——两者漂移会让每轮 DOM 变化都再插一枚（观察器自激）。
 */
export const SETTINGS_ROOT_ROW_ICON_CLASS = "easy-sync-settings-root-icon";

/** 行名：宿主 1.14 结构 `.setting-item > .setting-item-info > .setting-item-name`。 */
function settingsRowName(row: HTMLElement): string {
  const nameEl = row.querySelector<HTMLElement>(
    ":scope > .setting-item-info > .setting-item-name",
  );
  return nameEl?.textContent?.trim() ?? "";
}

/**
 * 给根级导航行补挂行首图标（幂等：行首已是自家图标类即跳过）。
 *
 * 只装饰根级——`.setting-page` 子树里可能有一行与页同名（「自动同步」页内的总
 * 开关行），不排除会把它也挂上。
 */
export function decorateSettingsRootRowIcons(
  container: HTMLElement,
  t: I18nFn,
): void {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>(".setting-item"),
  );
  if (rows.length === 0) return;
  const iconsByName = new Map<string, string>();
  for (const [key, icon] of Object.entries(SETTINGS_ROOT_ICON_BY_NAME_KEY)) {
    iconsByName.set(t(key), icon);
  }
  for (const row of rows) {
    if (row.closest(".setting-page")) continue;
    const icon = iconsByName.get(settingsRowName(row));
    if (!icon) continue;
    if (
      row.firstElementChild?.classList.contains(SETTINGS_ROOT_ROW_ICON_CLASS)
    ) {
      continue;
    }
    const iconEl = row.createSpan({ cls: SETTINGS_ROOT_ROW_ICON_CLASS });
    setIcon(iconEl, icon);
    iconEl.setAttribute("aria-hidden", "true");
    row.prepend(iconEl);
  }
}
