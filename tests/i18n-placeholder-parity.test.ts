/**
 * en / zh-cn placeholder parity gate.
 *
 * t() interpolates `{name}` tokens via split/join: a token the caller does
 * not supply stays in the rendered string verbatim, so a literal `{name}`
 * reaching the UI means either the locale templates drifted apart or a value
 * gained a token its call site never passes.
 *
 * This gate enforces, mechanically, for every locale key:
 *  1. the key exists in both locales;
 *  2. the placeholder token sets of en and zh-cn are identical;
 *  3. every braces group is a simple `{name}` token (t() can only replace
 *     `{name}` — anything else, e.g. `{ name }`, would leak literally);
 *  4. keys rendered with no substitution params (error.present.file.* and
 *     error.present.internal, see src/i18n/error-presentation.ts, which
 *     calls t(key) without params) carry no placeholder tokens at all.
 *
 * Scope: file-level en↔zh consistency only. It does not prove every token
 * is supplied by its call site (call-site coverage is a separate check).
 */
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";

const TOKEN_SOURCE = /\{([^{}\n]+)\}/g;

/** Extract the `{name}` token names from a template, sorted and de-duplicated. */
function tokens(value: string): string[] {
  const found = new Set<string>();
  TOKEN_SOURCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_SOURCE.exec(value)) !== null) {
    found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Report every brace group in a value that is not a valid `{name}` token
 * (t() can never replace it, so it would render literally).
 */
function invalidBraceGroups(value: string): string[] {
  const bad: string[] = [];
  TOKEN_SOURCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = TOKEN_SOURCE.exec(value)) !== null) {
    if (!/^\w+$/.test(m[1])) {
      const raw = m[0];
      if (!seen.has(raw)) {
        seen.add(raw);
        bad.push(raw);
      }
    }
  }
  // Stray unbalanced braces that never formed a group.
  const stripped = value.replace(TOKEN_SOURCE, "");
  const open = (stripped.match(/\{/g) ?? []).length;
  const close = (stripped.match(/\}/g) ?? []).length;
  if (open + close > 0) bad.push(`unbalanced braces (${open} open / ${close} close)`);
  return bad;
}

describe("i18n placeholder parity", () => {
  it("every locale key exists in both en and zh-cn", () => {
    const enKeys = new Set(Object.keys(en));
    const zhKeys = new Set(Object.keys(zhCN));
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k)).sort();
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
    expect({ missingInZh, missingInEn }).toEqual({ missingInZh: [], missingInEn: [] });
  });

  it("en and zh-cn placeholder token sets match for every key", () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(en)) {
      const enTok = tokens(en[key as keyof typeof en]);
      const zhTok = tokens(zhCN[key as keyof typeof zhCN]);
      if (enTok.join("|") !== zhTok.join("|")) {
        mismatches.push(`${key}: en=[${enTok.join(", ")}] zh-cn=[${zhTok.join(", ")}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("token extraction spot checks (guards the gate itself)", () => {
    // If the interpolation syntax ever changes, these lock what extraction
    // must see and keep the gate from passing vacuously.
    expect(tokens(en["status.conflicts"])).toEqual(["count"]);
    expect(tokens(zhCN["status.conflicts"])).toEqual(["count"]);
    expect(tokens(en["error.present.plugin.identityChangedInDirectory"])).toEqual(["pluginId"]);
    expect(tokens(zhCN["error.present.plugin.identityChangedInDirectory"])).toEqual(["pluginId"]);
    expect(tokens(zhCN["notice.sync.mixedPending"]).sort()).toEqual(["count", "remoteDeletes"]);
    expect(tokens(zhCN["syncView.recovery.detail.blockedPath"]).sort()).toEqual(["path", "reason", "remaining"]);
  });

  it("no value contains placeholder groups t() can never replace", () => {
    const bad: string[] = [];
    const locales: Array<[string, object]> = [
      ["en", en],
      ["zh-cn", zhCN],
    ];
    for (const [locale, table] of locales) {
      for (const [key, value] of Object.entries(table)) {
        for (const problem of invalidBraceGroups(value)) {
          bad.push(`${locale}.${key}: ${problem}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keys rendered without substitution params carry no tokens", () => {
    const noParamKeys = Object.keys(zhCN).filter(
      (k) => k.startsWith("error.present.file.") || k === "error.present.internal",
    );
    const offenders = noParamKeys.filter((k) => tokens(zhCN[k as keyof typeof zhCN]).length > 0);
    expect({ offenders }).toEqual({ offenders: [] });
  });
});