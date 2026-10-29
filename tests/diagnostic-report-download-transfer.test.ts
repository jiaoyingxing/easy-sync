// 「下载通道与分段」诊断区块（2026-10-28，S1 预留；同日随移动端分块层回退）。
//
// 证据生产者（移动端分块 / 流式 / 通道择优）已删除，区块与证据模块保留，
// 但当前没有任何生产数据。验收只钉两组口径：
//  - 无数据 → 区块在、单元格为 `—`、不抛错；
//  - 诊断开关关闭 → 一个字符都不追加（现役报告逐字不变）。
import { afterEach, describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import type { DiagEntry } from "../src/sync/diagnostic-logger";
import {
  collectDownloadTransferEvidence,
  DOWNLOAD_TRANSFER_DIAGNOSTIC_EVENT,
  formatDownloadTransferSection,
} from "../src/sync/diagnostic-download-evidence";
import { functionBody, readSourceFile } from "./helpers/source-scope";

afterEach(() => {
  vi.restoreAllMocks();
});

/** 一条结构化证据记录。字段形状是证据模块的通用 schema，不依赖已删除的
 *  分块/流式生产端；这里只用来证明「有数据时开关仍然说了算」。 */
function record(
  path: string,
  data: Record<string, unknown> = {},
  ts = 1,
): DiagEntry {
  return {
    ts,
    cat: "onedrive",
    lvl: "log",
    msg: `download transfer evidence "${path}"`,
    data: {
      event: DOWNLOAD_TRANSFER_DIAGNOSTIC_EVENT,
      path,
      ...data,
    },
  };
}

describe("download transfer report block", () => {
  it("A: no evidence still renders the block with dashes and no throw", () => {
    expect(collectDownloadTransferEvidence([])).toEqual([]);
    const text = formatDownloadTransferSection([]).join("\n");
    expect(text).toContain("## 下载通道与分段");
    expect(text).toContain("| 文件 | 通道 | 分段 | 回退 | 校验 |");
    expect(text).toContain("| — | — | — | — | — |");
  });

  it("keeps the generic evidence schema renderable when a producer returns", () => {
    const evidence = collectDownloadTransferEvidence([
      record("landed.bin", {
        channel: "whole-file",
        outcome: "complete",
        verification: "sha256",
      }),
    ]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      path: "landed.bin",
      channel: "whole-file",
      verification: "sha256",
      fallbackOccurred: false,
    });
    expect(formatDownloadTransferSection(evidence).join("\n")).toContain(
      "| `landed.bin` | whole-file | — | 无 | sha256 |",
    );
  });
});

/** 报告区块的开关口径：关闭时现役报告必须逐字不变。 */
describe("diagnostic report gating", () => {
  /** 私有渲染方法只在开关打开时追加行；用最小 ctx 直接驱动它。 */
  function renderSection(
    plugin: EasySyncPlugin,
    diagAll: readonly DiagEntry[],
  ): string[] {
    const lines: string[] = [];
    const target = plugin as unknown as {
      renderDiagnosticDownloadTransferSection: (
        ctx: unknown,
        prior: unknown,
      ) => void;
    };
    target.renderDiagnosticDownloadTransferSection(
      { lines },
      { diagAll },
    );
    return lines;
  }

  it("B: adds nothing when diagnostic logging is off, even with evidence", () => {
    const plugin = new EasySyncPlugin();
    plugin.diagLogEnabled = false;
    expect(renderSection(plugin, [
      record("landed.bin", { channel: "whole-file", outcome: "complete" }),
    ])).toEqual([]);
  });

  it("adds the block only when diagnostic logging is on, and stops again when off", () => {
    const plugin = new EasySyncPlugin();
    plugin.diagLogEnabled = true;
    const evidence = [
      record("landed.bin", { channel: "whole-file", outcome: "complete" }),
    ];
    const lines = renderSection(plugin, evidence);
    expect(lines.join("\n")).toContain("## 下载通道与分段");
    // 关闭时同一份数据一个字符都不追加。
    plugin.diagLogEnabled = false;
    expect(renderSection(plugin, evidence)).toEqual([]);
  });

  it("is wired into the report only through the gated section", () => {
    const source = readSourceFile("src/main.ts");
    const section = functionBody(
      source,
      "private renderDiagnosticDownloadTransferSection(",
    );
    expect(section).toContain("if (!this.diagLogEnabled) return;");

    const report = functionBody(
      source,
      "private async buildDiagnosticReportFile(",
    );
    // 区块排在「连接速度」之后、「当前待处理问题」之前。
    expect(report).toContain(
      "this.renderDiagnosticDownloadTransferSection(renderCtx, headerValues);",
    );
    expect(report.indexOf("renderDiagnosticConnectionSpeedSection")).toBeLessThan(
      report.indexOf("this.renderDiagnosticDownloadTransferSection("),
    );
    expect(report.indexOf("this.renderDiagnosticDownloadTransferSection(")).toBeLessThan(
      report.indexOf("renderDiagnosticPendingIssuesSection"),
    );
    // 全文件只有一处调用点（声明 + 调用 = 2 次出现）。
    expect(
      source.split("renderDiagnosticDownloadTransferSection").length - 1,
    ).toBe(2);
  });
});
