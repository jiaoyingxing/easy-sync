import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractPreResetReportCore,
  parseDiagnosticResetFacts,
  PRE_RESET_REPORT_EMBED_CHAR_LIMIT,
  resetPhasePrefix,
  type DiagnosticResetFacts,
} from "../src/sync/diagnostic-report-evidence";

const SAMPLE_REPORT = [
  "# EasySync 诊断报告",
  "",
  "**生成时间**: 09/22 07:20",
  "",
  "## 当前同步概况",
  "",
  "**自动同步**: 已暂停",
  "",
  "## 技术状态证据",
  "",
  "**云端快照**: generation 0",
  "",
  "## 近期同步记录",
  "",
  "| 时间 | 模式 |",
  "|------|------|",
  "",
  "### 失败文件明细",
  "",
  "- `a.md` (1KB) — 上传（HTTP 400）",
  "",
  "## 连接速度（被动实测）",
  "",
  "**当前读数**: 上传 1KB/s",
  "",
  "## 当前待处理问题",
  "",
  "### 待处理冲突（1）",
  "",
  "- `b.md` — 冲突",
  "",
  "## V2／V3 协议组合核对",
  "",
  "*近期没有协议组合错配记录。*",
  "",
  "## 自动处理与恢复摘要",
  "",
  "**当前恢复账本**:",
  "```json",
  '{ "total": 1 }',
  "```",
  "",
  "## 近期异常日志",
  "",
  "```",
  "07:28:26 [onedrive] ⚠️ requestUrl HTTP error",
  "```",
].join("\n");

describe("extractPreResetReportCore", () => {
  it("提取核心节并携带子节，排除非核心节", () => {
    const core = extractPreResetReportCore(SAMPLE_REPORT, 16_000);
    // 核心节全部在场（含 ### 子节随所属 ## 节一起携带）
    expect(core).toContain("## 当前同步概况");
    expect(core).toContain("## 技术状态证据");
    expect(core).toContain("## 近期同步记录");
    expect(core).toContain("### 失败文件明细");
    expect(core).toContain("- `a.md` (1KB) — 上传（HTTP 400）");
    expect(core).toContain("## 当前待处理问题");
    expect(core).toContain("- `b.md` — 冲突");
    expect(core).toContain("## 自动处理与恢复摘要");
    expect(core).toContain('{ "total": 1 }');
    // 非核心节不进入摘录
    expect(core).not.toContain("## 连接速度（被动实测）");
    expect(core).not.toContain("## V2／V3 协议组合核对");
    expect(core).not.toContain("## 近期异常日志");
    // 节顺序保持原报告顺序
    expect(core.indexOf("## 当前同步概况")).toBeLessThan(
      core.indexOf("## 技术状态证据"),
    );
    expect(core.indexOf("## 当前待处理问题")).toBeLessThan(
      core.indexOf("## 自动处理与恢复摘要"),
    );
  });

  it("超过上限时在整行边界截断并带提示", () => {
    const core = extractPreResetReportCore(SAMPLE_REPORT, 200);
    expect(core).toContain("（超过嵌入上限，已截断）");
    const bodyBeforeNotice = core.split("\n\n*（超过嵌入上限，已截断）*")[0];
    for (const line of bodyBeforeNotice.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
    // 远端内容（恢复账本 JSON）必须已被截掉
    expect(core).not.toContain('{ "total": 1 }');
  });

  it("无匹配节时返回空串", () => {
    expect(extractPreResetReportCore("# 随手记\n\n正文一段", 16_000)).toBe("");
    expect(extractPreResetReportCore("", 16_000)).toBe("");
  });

  it("嵌入上限为实测出处的固定值（8 份真实报告核心节最大 4751 字符）", () => {
    expect(PRE_RESET_REPORT_EMBED_CHAR_LIMIT).toBe(16_000);
  });
});

describe("resetPhasePrefix", () => {
  const facts: DiagnosticResetFacts = {
    resetAt: 1_000,
    variant: "forced",
    preResetReportFile: "EasySync 诊断报告 2026-09-22 072000.md",
    pluginVersion: "1.4.14",
  };

  it("重置时刻之前标重置前，之后（含当时）标重置后", () => {
    expect(resetPhasePrefix(999, facts)).toBe("【重置前】");
    expect(resetPhasePrefix(1_000, facts)).toBe("【重置后】");
    expect(resetPhasePrefix(1_001, facts)).toBe("【重置后】");
  });

  it("无重置标记时返回空串（报告保持既有形状）", () => {
    expect(resetPhasePrefix(999, null)).toBe("");
  });
});

describe("parseDiagnosticResetFacts", () => {
  it("接受完整合法标记", () => {
    const facts = parseDiagnosticResetFacts({
      resetAt: 1_000,
      variant: "isolated",
      preResetReportFile: "EasySync 诊断报告 2026-09-22 072000.md",
      pluginVersion: "1.4.14",
    });
    expect(facts).not.toBeNull();
    expect(facts?.preResetReportFile).toBe(
      "EasySync 诊断报告 2026-09-22 072000.md",
    );
  });

  it("接受无预重置报告文件名的标记（生成失败场景）", () => {
    const facts = parseDiagnosticResetFacts({
      resetAt: 1_000,
      variant: "normal",
      pluginVersion: "1.4.14",
    });
    expect(facts).not.toBeNull();
    expect(facts?.preResetReportFile).toBeUndefined();
  });

  it("拒绝畸形标记", () => {
    expect(parseDiagnosticResetFacts(null)).toBeNull();
    expect(parseDiagnosticResetFacts("x")).toBeNull();
    expect(parseDiagnosticResetFacts({ variant: "normal" })).toBeNull();
    expect(
      parseDiagnosticResetFacts({
        resetAt: Number.NaN,
        variant: "normal",
        pluginVersion: "1.4.14",
      }),
    ).toBeNull();
    expect(
      parseDiagnosticResetFacts({
        resetAt: 1_000,
        variant: "hard",
        pluginVersion: "1.4.14",
      }),
    ).toBeNull();
    expect(
      parseDiagnosticResetFacts({
        resetAt: 1_000,
        variant: "normal",
        pluginVersion: "",
      }),
    ).toBeNull();
  });
});

describe("重置血统源码守卫", () => {
  const source = readFileSync("src/main.ts", "utf8");

  it("重置流程捕获快照文件名并在设置保存前落标记", () => {
    const capture = source.indexOf(
      "const preResetReportFile = await this.generateDiagnosticReport(true);",
    );
    expect(capture).toBeGreaterThan(-1);
    const marker = source.indexOf("this.lastResetFacts = {", capture);
    expect(marker).toBeGreaterThan(capture);
    const save = source.indexOf("await this.saveSyncSettings();", marker);
    expect(save).toBeGreaterThan(marker);
    const notice = source.indexOf('"reset-complete"', marker);
    expect(notice).toBeGreaterThan(save);
  });

  it("隔离处置升级为强制时，变体标签随实际执行的强制重置置位", () => {
    // 升级分支（保守重置拒绝 → 用户确认强制）执行 forceReset()，标记的
    // variant 由 forceReset 标志推导——该标志必须在实际调用前置位，
    // 否则重置历史会把强制重置误记为「隔离保留重置」。
    expect(source).toContain(
      "forceReset = true;\n            await this.state?.forceReset();",
    );
  });

  it("报告装配携带重置历史节、日志归因与摘录附录，且快照生成不嵌历史", () => {
    expect(source).toContain("## 重置历史");
    expect(source).toContain("## 重置前档案摘录（${resetFacts.preResetReportFile}）");
    expect(source).toContain("resetPhasePrefix(e.ts, resetFacts)");
    expect(source).toContain("resetSnapshot ? null : this.lastResetFacts");
    expect(source).toContain(
      "extractPreResetReportCore(\n            await this.app.vault.cachedRead(preResetFile),",
    );
    expect(source).toContain("PRE_RESET_REPORT_EMBED_CHAR_LIMIT");
  });

  it("设置域持久化重置标记键", () => {
    expect(source).toContain('const KEY_LAST_RESET_FACTS = "last-reset-facts";');
    expect(source).toContain("data[KEY_LAST_RESET_FACTS] = this.lastResetFacts;");
    expect(source).toContain(
      "this.lastResetFacts = parseDiagnosticResetFacts(data[KEY_LAST_RESET_FACTS]);",
    );
  });
});
