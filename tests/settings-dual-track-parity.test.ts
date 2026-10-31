/**
 * 设置面双轨对账门（2026-10-13 用户拍板＝「选项①机械对账门」，tests-only）。
 *
 * 背景：1.13+ 页面行（`src/ui/settings-page-rows.ts` 等）与 <1.13 弹框
 * （`src/ui/config-sync-modal.ts` 等）对同一个设置项各有一份实现。2026-10-12
 * 一天内三处漂移实害都由用户真机反馈才发现：行类没挂（chip 紧贴行名）、chip
 * 挂点排到 `setName` 之前（节点被重写冲掉）、计数插值参数名与模板占位符不一致
 * （真机直显「同步：{enabled}/30」）。既有钉子只钉单个函数的源码形状，钉不住
 * 「两侧同形」；宿主 1.14.4 起设置面走独立窗口、AI 侧无法目视，故补这道门。
 *
 * 本门只读源码、不改生产行为，只判三条可机械判定的规则：
 *   R1 i18n 插值参数名＝模板占位符（设置面全部 `t(key, {...})` 调用）；
 *   R2 双轨类钩子＝同一行的关键钩子类必须在两侧实现里都存在（表见下）；
 *   R3 nameEl 挂点顺序＝同一函数内挂到 `nameEl` 的节点必须排在最后一次
 *      `setName()` 之后（`setName` 会重写 nameEl 内容）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** 设置面双轨涉及的文件（页面侧＋弹框侧）。 */
const PAGE_ROW_FILES = [
  "src/ui/settings-page-rows.ts",
  "src/ui/settings-tab.ts",
];
const MODAL_FILES = [
  "src/ui/config-sync-modal.ts",
  "src/ui/sync-exclusion-modal.ts",
  "src/ui/auto-sync-modal.ts",
  "src/ui/automatic-handling-modal.ts",
];
const SETTINGS_FILES = [...PAGE_ROW_FILES, ...MODAL_FILES];

const read = (file: string) => readFileSync(file, "utf8");

// ── R1：i18n 插值参数名 ↔ 模板占位符 ──────────────────────────────
function placeholdersByKey(file: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const keyRe = /"([A-Za-z0-9._-]+)":\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of read(file).matchAll(keyRe)) {
    const found = new Set<string>();
    for (const p of m[2].matchAll(/\{([A-Za-z0-9_]+)\}/g)) found.add(p[1]);
    map.set(m[1], found);
  }
  return map;
}

/** 取出 `t("key", { ... })` 内联对象字面量的属性名；变量／展开实参返回 null。 */
function inlineParamNames(
  source: string,
  fromIndex: number,
): Set<string> | null {
  let i = fromIndex;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== ",") return null;
  i++;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== "{") return null;
  let depth = 0;
  let end = -1;
  for (let j = i; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end === -1) return null;
  const body = source.slice(i + 1, end);
  if (body.includes("...")) return null;
  const names = new Set<string>();
  for (const p of body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) names.add(p[1]);
  for (const p of body.matchAll(/(?:^|[,{}])\s*([A-Za-z_$][\w$]*)\s*(?=[,}]|$)/g)) {
    names.add(p[1]);
  }
  return names;
}

/** 调用实参里第一个顶层逗号（跳过嵌套括号、括号内逗号与字符串内容）。 */
function firstTopLevelComma(source: string, fromIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = fromIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
    } else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return -1;
      depth--;
    } else if (ch === "," && depth === 0) {
      return i;
    }
  }
  return -1;
}

describe("settings dual-track parity gate", () => {
  it("R1: passes exactly the placeholders each template requires", () => {
    const zh = placeholdersByKey("src/i18n/zh-cn.ts");
    const en = placeholdersByKey("src/i18n/en.ts");
    const expected = new Map<string, Set<string>>();
    for (const key of new Set([...zh.keys(), ...en.keys()])) {
      expected.set(
        key,
        new Set([...(zh.get(key) ?? []), ...(en.get(key) ?? [])]),
      );
    }

    const problems: string[] = [];
    let checked = 0;
    for (const file of SETTINGS_FILES) {
      const source = read(file);
      for (const m of source.matchAll(/\bt\(\s*"([A-Za-z0-9._-]+)"/g)) {
        const key = m[1];
        const tpl = expected.get(key);
        if (!tpl) {
          problems.push(`${file}: ${key} 不在任何 locale 中`);
          continue;
        }
        const names = inlineParamNames(source, m.index + m[0].length);
        if (names === null) continue; // 变量／展开实参：由类型与其它门承接
        checked++;
        const missing = [...tpl].filter((p) => !names.has(p));
        const unused = [...names].filter((p) => !tpl.has(p));
        if (missing.length || unused.length) {
          problems.push(
            `${file}: ${key} 模板需要 {${[...tpl].join("},{")}}`
              + `，实参${missing.length ? ` 缺 {${missing.join("},{")}}` : ""}`
              + `${unused.length ? ` 多 {${unused.join("},{")}}` : ""}`,
          );
        }
      }
    }

    // 包装入口：`confirmExperimentalPluginData("<key>", { ... })` 的键与
    // 插值形参不在同一条 `t(...)` 上，按调用表达式单独对账。包装器内部的
    // `t(messageKey, params)` 是变量实参，由上面的 `names === null` 分支跳过；
    // 这里只收字面键，包装器定义本身（`messageKey`）没有字面键，也不会入账。
    let wrapperChecked = 0;
    for (const file of SETTINGS_FILES) {
      const source = read(file);
      // 2026-10-31: the wrapper takes `{ messageKey, params }` or `{ steps }`.
      // Steps are plain `t("key", { ... })` calls checked by the main pass;
      // here only the object-form messageKey branch needs its own pass.
      for (const m of source.matchAll(/confirmExperimentalPluginData\(\s*\{/g)) {
        const argStart = (m.index ?? 0) + m[0].length - 1;
        let depth = 0;
        let objEnd = -1;
        for (let i = argStart; i < source.length; i++) {
          if (source[i] === "{") depth++;
          else if (source[i] === "}") {
            depth--;
            if (depth === 0) {
              objEnd = i;
              break;
            }
          }
        }
        if (objEnd === -1) continue;
        const body = source.slice(argStart + 1, objEnd);
        const keyAt = body.indexOf("messageKey:");
        if (keyAt === -1) continue; // steps-only call: covered by the main pass
        const keyStart = keyAt + "messageKey:".length;
        const paramsAt = body.indexOf("params:", keyStart);
        const keyExpr = paramsAt === -1 ? body.slice(keyStart) : body.slice(keyStart, paramsAt);
        const keys = [
          ...keyExpr.matchAll(/"([A-Za-z0-9._-]+)"/g),
        ].map((k) => k[1]);
        if (keys.length === 0) continue;
        let names: Set<string> | null = null;
        if (paramsAt !== -1) {
          const paramsStart = body.indexOf("{", paramsAt);
          if (paramsStart !== -1) {
            let paramDepth = 0;
            let paramEnd = -1;
            for (let i = paramsStart; i < body.length; i++) {
              if (body[i] === "{") paramDepth++;
              else if (body[i] === "}") {
                paramDepth--;
                if (paramDepth === 0) {
                  paramEnd = i;
                  break;
                }
              }
            }
            if (paramEnd !== -1) {
              names = new Set([
                ...body.slice(paramsStart + 1, paramEnd)
                  .matchAll(/([A-Za-z_$][\w$]*)\s*:/g),
              ].map((p) => p[1]));
            }
          }
        }
        wrapperChecked += keys.length;
        for (const key of keys) {
          const tpl = expected.get(key);
          if (!tpl) {
            problems.push(`${file}: ${key} 不在任何 locale 中（包装入口）`);
            continue;
          }
          if (names === null) continue;
          const missing = [...tpl].filter((p) => !names.has(p));
          const unused = [...names].filter((p) => !tpl.has(p));
          if (missing.length || unused.length) {
            problems.push(
              `${file}: ${key} 模板需要 {${[...tpl].join("},{")}}`
                + `，实参${missing.length ? ` 缺 {${missing.join("},{")}}` : ""}`
                + `${unused.length ? ` 多 {${unused.join("},{")}}` : ""}（包装入口）`,
            );
          }
        }
      }
    }

    // 门自检：解析必须真的走到调用点，不能因为正则失效而空转（当前 ≈ 24 处）
    expect(checked).toBeGreaterThanOrEqual(15);
    // 包装入口自检：当前 2 处调用表达式（含 3 个字面键）
    expect(wrapperChecked).toBeGreaterThanOrEqual(2);
    expect(problems).toEqual([]);
  });

  it("R2: dual-track rows carry the same hook classes on both sides", () => {
    // 同一行的关键钩子必须在两侧实现里都存在。chip 内件不在表内：它们由共享
    // `renderExcludedFolderChips`／同款构造器渲染，属单实现，不构成双轨。
    const hooks: Array<{ hook: string; files: string[] }> = [
      {
        hook: "easy-sync-community-plugin-scope-setting",
        files: ["src/ui/settings-page-rows.ts", "src/ui/config-sync-modal.ts"],
      },
      {
        hook: "easy-sync-plugin-selection-chip",
        files: ["src/ui/settings-page-rows.ts", "src/ui/config-sync-modal.ts"],
      },
      // 2026-10-30：「实验性」chip 已停止渲染（样式与 i18n key 保留），
      // 不再作为双轨钩子。
      {
        hook: "easy-sync-exclusion-chips",
        files: [
          "src/ui/settings-page-rows.ts",
          "src/ui/sync-exclusion-modal.ts",
        ],
      },
      {
        hook: "easy-sync-notification-popups-hint",
        files: ["src/ui/settings-tab.ts", "src/ui/settings-page-rows.ts"],
      },
    ];

    const problems: string[] = [];
    for (const { hook, files } of hooks) {
      for (const file of files) {
        const quoted = [`"${hook}"`, `'${hook}'`];
        if (!quoted.some((q) => read(file).includes(q))) {
          problems.push(`${file}: 缺少双轨钩子类 ${hook}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("R3: nameEl hooks are mounted after the last setName() in the same block", () => {
    const problems: string[] = [];
    let blocksWithBoth = 0;
    for (const file of SETTINGS_FILES) {
      for (const block of functionBlocks(read(file))) {
        const setNames = indexesOf(block, ".setName(");
        const nameElNodes = [...block.matchAll(/nameEl\s*\.\s*create/g)].map(
          (m) => m.index ?? 0,
        );
        if (setNames.length === 0 || nameElNodes.length === 0) continue;
        blocksWithBoth++;
        const lastSetName = Math.max(...setNames);
        const firstNode = Math.min(...nameElNodes);
        if (firstNode < lastSetName) {
          problems.push(
            `${file}: nameEl 节点挂在最后一次 setName 之前（会被重写冲掉）`,
          );
        }
      }
    }
    // 门自检：当前设置面确实存在「同一函数内既有 setName 又有 nameEl 挂点」
    expect(blocksWithBoth).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

function indexesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/**
 * 抽出函数／方法体（含类方法、模块级函数；箭头函数体归入其外层函数）。只用于
 * 把 `setName` 与 `nameEl` 的先后关系限定在同一个函数内，不追求完整语法树。
 */
function functionBlocks(source: string): string[] {
  const blocks: string[] = [];
  const headRe =
    /(?:^|\n)[ \t]*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+|(?:private|public|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of source.matchAll(headRe)) {
    const nameStart = m.index + m[0].length - 1 - m[1].length - 1;
    const before = source.slice(Math.max(0, nameStart - 1), nameStart);
    if (before === ".") continue; // 方法调用而非声明
    const open = source.indexOf("{", m.index + m[0].length);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let j = open; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue;
    blocks.push(source.slice(open, end + 1));
  }
  return blocks;
}
