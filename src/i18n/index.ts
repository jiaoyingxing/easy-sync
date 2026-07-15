/**
 * EasySync i18n Module
 *
 * Auto-detects Obsidian language, loads the matching locale,
 * and provides a t() function for user-visible strings.
 *
 * Language Detection:
 *  - Reads Obsidian's configured language from app.vault.getConfig('language')
 *  - Falls back to navigator.language, then 'en'
 *  - Map: 'zh' | 'zh-cn' | 'zh-tw' | 'zh-hk' → zh-CN locale
 *
 * Usage:
 *   const i18n = new I18n(app);
 *   i18n.t("settings.account.name")  // "OneDrive 账号" or "OneDrive account"
 *
 * Architecture:
 *  - src/i18n/types.ts — LocaleStrings interface
 *  - src/i18n/en.ts — English fallback (authoritative)
 *  - src/i18n/zh-cn.ts — Simplified Chinese
 *  - src/i18n/index.ts — I18n class (this file)
 */

import type { LocaleStrings, LocaleMap } from "./types";
import en from "./en";
import zhCN from "./zh-cn";

/** All available locales */
const LOCALES: LocaleMap = {
  en,
  "zh-cn": zhCN,
};

/**
 * Map raw language tags to our supported locale keys.
 * Obsidian uses IETF BCP 47 tags (e.g. "zh", "zh-CN", "en").
 */
function resolveLocale(rawLang: string): keyof LocaleMap {
  const lower = rawLang.toLowerCase();
  // Chinese variants → zh-cn
  if (lower === "zh" || lower.startsWith("zh-")) {
    return "zh-cn";
  }
  // Check exact match
  if (LOCALES[lower]) return lower as keyof LocaleMap;
  // Fallback to English
  return "en";
}

export class I18n {
  private locale: LocaleStrings;

  constructor(language?: string) {
    const lang = language ?? "en";
    const key = resolveLocale(lang);
    this.locale = LOCALES[key] ?? en;
  }

  /**
   * Translate a key with optional parameter substitution.
   * Parameters in the template are `{paramName}`.
   *
   * @param key Dot-separated locale key
   * @param params Optional key-value pairs for substitution
   * @returns Translated string with params replaced
   */
  t(key: string, params?: Record<string, string | number>): string {
    const localeStr = this.locale as unknown as Record<string, string>;
    const enStr = en as unknown as Record<string, string>;
    let template: string = localeStr[key] ?? enStr[key] ?? key;

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        template = template.split(`{${k}}`).join(String(v));
      }
    }

    return template;
  }

  /** Get the current locale object (for advanced use) */
  getLocale(): LocaleStrings {
    return this.locale;
  }

  /** Static helper: read Obsidian's language setting */
  static detectLanguage(app?: {
    vault?: { getConfig?: (key: string) => string };
  }): string {
    // 1. Try Obsidian vault config
    const obsidianLang = app?.vault?.getConfig?.("language");
    if (obsidianLang) return obsidianLang;
    // 2. Try localStorage (Obsidian stores language here)
    try {
      const stored = globalThis.localStorage?.getItem("language");
      if (stored) return stored;
    } catch { /* sandboxed */ }
    // 3. Fall back to browser/Electron language
    if (typeof navigator !== "undefined" && navigator.language) {
      return navigator.language;
    }
    return "en";
  }
}
