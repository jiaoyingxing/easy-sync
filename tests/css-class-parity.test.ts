/**
 * CSS class parity gate.
 *
 * 背景（see docs/dev-logs/2026-08/20260824-0340 与 ...-0415）：
 * dfa4397c 的全仓清理审计按"src 字面量零命中"删掉了 .easy-sync-diff-added /
 * -removed 及 content 配色共 4 条 rules，但渲染代码用模板字符串动态拼接类名
 * （`easy-sync-diff-${line.type}`），字面量扫描必然零命中——造成误删，diff
 * 界面增删行底色丢失。
 *
 * 本 gate 机械保护：src 中经 DOM 构建调用（createDiv / createSpan / createEl /
 * addClass / removeClass / toggleClass / setClass / cls: / className: /        /
 * classList.xxx）产出的每一个 easy-* 类名——无论字面量还是模板拼接——都必须
 * 能在 styles.css 中找到定义。任何整规则删除或改名若仍被渲染代码引用，本测试
 * 变红。
 *
 * 范围与豁免：
 *  - 只扫描 src 域；只校验 easy- 前缀类（is-*、modal-*、setting-* 等是
 *    Obsidian 宿主类，不由插件样式负责）。
 *  - STRUCTURAL_HOOKS：git 溯源确认 styles.css 从未定义过这些类，它们只是
 *    结构/可测性钩子（创建即存在，无样式可丢），白名单豁免。若某个钩子未来
 *    补上真实样式，须移出白名单并补 spot-check。
 *  - PREFIX_DOMAINS：模板插值（`easy-sync-diff-${line.type}`）产生的是"前缀+
 *    取值域"的类集合，prefix 依赖按此表逐一断言实际类名存在；新出现的插值
 *    拼接必须登记，防止保护空转。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = "src";
const CSS_FILE = "styles.css";

/** 历史从未定义过样式的结构性钩子（git 溯源见 08024-0415 日志排查）。
 *  easy-sync-ribbon 例外：2026-08-26 拍板 ribbon 去色，三条
 *  `.easy-sync-ribbon[data-easy-sync-status=...]` 颜色规则整体删除
 *  （styles.css 不再定义该类），图标/tooltip 动态保留 → 该类现为无样式的
 *  结构性标记钩子，登记在此防止 parity gate 误红。 */
const STRUCTURAL_HOOKS = new Set([
  "easy-sync-ribbon",
  "easy-sync-auth-device-code-modal",
  "easy-sync-automatic-handling",
  "easy-sync-detail-format-difference",
  "easy-sync-settings-about",
  "easy-sync-path-layout",
  "easy-sync-path-layout-item",
  "easy-sync-adaptive-path",
  "easy-sync-history-result",
  "easy-sync-notice",
  "easy-sync-notice-action",
  "easy-sync-notice-result",
  "easy-sync-settings-range",
  "easy-sync-settings-automatic",
  "easy-sync-settings-display",
  "easy-sync-settings-maintenance",
]);

/**
 * Template interpolation prefixes -> the exact easy-* class names the rendered
 * values can produce. Listed explicitly so the gate checks real classes instead
 * of a loose prefix. `easy-sync-diff-equal` is a baseline-line class: having no
 * rule is the design (its empty placeholder rule was removed by 83fce971), so
 * it is intentionally absent here.
 */
const PREFIX_DOMAINS: Record<string, string[]> = {
  "easy-sync-diff-": ["easy-sync-diff-added", "easy-sync-diff-removed"],
  "easy-sync-action-chip": ["easy-sync-action-chip"], // is-{accent,warning} are host classes
};

function walkDir(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
}

/** All `.easy-*` class selectors defined anywhere in styles.css. */
function cssClasses(): Set<string> {
  const css = readFileSync(CSS_FILE, "utf8");
  const classes = new Set<string>();
  for (const m of css.matchAll(/\.(easy-[\w-]+)/g)) classes.add(m[1]);
  return classes;
}

/** Line markers for DOM-construction calls whose arguments carry class names. */
const DOM_CALL =
  /(?:createDiv|createSpan|createEl|addClass|removeClass|toggleClass|setClass)\s*\(|className\s*[:=]|classList\.(?:add|remove|toggle)\s*\(/;

interface Usage {
  kind: "literal" | "prefix";
  where: string[];
}

/**
 * Scan src for every easy-* class token emitted through a DOM-construction call.
 * Template interpolation (`easy-sync-diff-${line.type}`) marks the token as a
 * "prefix" dependency: css must define at least one class starting with it.
 */
function sourceUsages(): Map<string, Usage> {
  const usages = new Map<string, Usage>();
  const record = (token: string, kind: "literal" | "prefix", where: string) => {
    const prev = usages.get(token);
    if (prev) {
      if (!prev.where.includes(where)) prev.where.push(where);
      return;
    }
    usages.set(token, { kind, where: [where] });
  };
  const files: string[] = [];
  walkDir(SRC_DIR, files);
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!DOM_CALL.test(lines[i])) continue;
      // Class arguments may span lines (createDiv(\n  "easy-sync-x")): join the
      // next two lines so multi-line calls are still seen.
      const block = lines.slice(i, i + 3).join(" ");
      for (const m of block.matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)) {
        const content = m[1] ?? m[2] ?? m[3];
        // Only backtick templates actually interpolate `${...}`.
        const interpolations = new Set<number>();
        if (m[1] !== undefined) {
          for (const im of content.matchAll(/\$\{/g)) interpolations.add(im.index);
        }
        for (const tm of content.matchAll(/(?<!-)easy-[\w-]*/g)) {
          const token = tm[0];
          if (token.length === 0) continue;
          record(
            token,
            interpolations.has(tm.index + token.length) ? "prefix" : "literal",
            `${file}:${i + 1}`,
          );
        }
      }
    }
  }
  return usages;
}

describe("CSS class parity", () => {
  const css = cssClasses();
  const usages = sourceUsages();

  it("every easy-* DOM class literal emitted by src has a styles.css definition", () => {
    const missing: string[] = [];
    for (const [token, usage] of usages) {
      if (usage.kind !== "literal") continue;
      if (STRUCTURAL_HOOKS.has(token)) continue;
      if (!css.has(token)) missing.push(`${token}  <- ${usage.where.join(", ")}`);
    }
    expect({ missing }).toEqual({ missing: [] });
  });

  it("every dynamic easy-* template interpolation produces an existing styles.css definition", () => {
    const missing: string[] = [];
    for (const [token, usage] of usages) {
      if (usage.kind !== "prefix") continue;
      const produced = PREFIX_DOMAINS[token];
      if (!produced) {
        missing.push(
          `${token}  <- ${usage.where.join(", ")} （未登记插值域：请在 PREFIX_DOMAINS 登记实际产出的类名）`,
        );
        continue;
      }
      for (const cls of produced) {
        if (!css.has(cls)) missing.push(`${cls}  <- ${usage.where.join(", ")}`);
      }
    }
    expect({ missing }).toEqual({ missing: [] });
  });

  it("structural hook whitelist matches exactly the hooks actually used by src", () => {
    const usedHooks = [...usages.keys()].filter((t) => STRUCTURAL_HOOKS.has(t)).sort();
    // 白名单必须与实际使用的钩子逐一对应：新增钩子必须登记，钩子退役必须
    // 从白名单移除，防止名单与 src 静默漂移。
    expect(usedHooks).toEqual([...STRUCTURAL_HOOKS].sort());
  });

  it("spot checks lock the gate itself (guards against a vacuous pass)", () => {
    // 上次事故的类必须存在（本测试就是为了防止它们被再次误删）。
    expect(css.has("easy-sync-diff-added")).toBe(true);
    expect(css.has("easy-sync-diff-removed")).toBe(true);
    expect(css.has("easy-sync-diff-view")).toBe(true);
    expect(css.has("easy-sync-action-chip")).toBe(true);
    // 模板拼接的 diff 行类必须被检测为 prefix 依赖（easy-sync-diff- 前缀）。
    const prefixDeps = [...usages.keys()].filter(
      (t) => t.startsWith("easy-sync-diff-") && usages.get(t)?.kind === "prefix",
    );
    expect(prefixDeps).toContain("easy-sync-diff-");
    // icon 探针类（sync-view 测量窗口）必须有定义。
    expect(css.has("easy-sync-plan-measure-probe")).toBe(true);
  });
});