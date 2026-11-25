/**
 * 诊断报告的局域网记录段（S5b）。
 *
 * 三段口径：
 *  - 新区块常开：无数据也写明「未发生局域网尝试」，并且不发起任何网络请求；
 *  - 最近一次尝试 / 本次会话次数只来自纯内存的 `LanDiagnostics`；
 *  - LAN 日志进入报告时只带白名单字段，room secret、候选文本与地址/端口
 *    没有进入报告的路径。
 */
import { describe, expect, it } from "vitest";
import EasySyncPlugin from "../src/main";
import { LanDiagnostics } from "../src/sync/lan-diagnostics";
import type { DiagEntry } from "../src/sync/diagnostic-logger";
import {
  LAN_DIAGNOSTIC_LOG_LIMIT,
  formatLanDiagnosticsSection,
  formatLanLastAttempt,
  formatLanLogSection,
  isLanDiagnosticLogEntry,
  projectLanDiagnosticLogData,
} from "../src/sync/diagnostic-lan-evidence";
import { functionBody, readSourceFile } from "./helpers/source-scope";

const ROOM_SECRET = "11".repeat(32);
const CANDIDATE = "candidate:1 1 UDP 2122260223 192.168.1.10 50000 typ host";

function lanEntry(
  msg: string,
  data: unknown = undefined,
  ts = 1,
): DiagEntry {
  return { ts, cat: "execute", lvl: "log", msg, data };
}

describe("LAN report section", () => {
  it("says no attempt happened instead of inventing one", () => {
    const text = formatLanDiagnosticsSection({
      last: null,
      counters: { hit: 0, fallback: 0, rejected: 0, skipped: 0 },
    }).join("\n");
    expect(text).toContain("## 局域网加速（被动记录）");
    expect(text).toContain("**最近一次尝试**: 未发生局域网尝试");
    expect(text).toContain("**本次会话次数**: 命中 0 / 回退 0 / 拒绝 0 / 跳过 0");
    // The section says what it is not: no probe, no disk, no history.
    expect(text).toContain("不发起任何网络请求");
  });

  it("renders the latest hit and every session tally", () => {
    const text = formatLanDiagnosticsSection({
      last: {
        outcome: "hit",
        route: "host",
        bytes: 8_388_608,
        elapsedMs: 1_234,
        at: Date.UTC(2026, 10, 21, 2, 30),
      },
      counters: { hit: 3, fallback: 1, rejected: 0, skipped: 2 },
    }).join("\n");
    expect(text).toContain("最近一次命中");
    expect(text).toContain("路线 host，8388608 字节，耗时 1234 ms");
    expect(text).toContain("**本次会话次数**: 命中 3 / 回退 1 / 拒绝 0 / 跳过 2");
    // Route is a class word only; no address or port is ever rendered.
    expect(text).not.toContain("192.168");
    expect(text).not.toContain("candidate:");
  });

  it("renders fallback and skipped reasons from the existing vocabulary", () => {
    expect(formatLanLastAttempt({
      outcome: "fallback",
      reason: "route-relay",
      route: "relay",
      bytes: 4096,
      elapsedMs: 20,
      at: 1,
    })).toContain("走了中继路线，已回退");
    expect(formatLanLastAttempt({
      outcome: "skipped",
      reason: "below-threshold",
      route: "unknown",
      bytes: 0,
      elapsedMs: 0,
      at: 1,
    })).toContain("文件低于触发大小");
    expect(formatLanLastAttempt({
      outcome: "rejected",
      reason: "hash-mismatch",
      route: "srflx",
      bytes: 64,
      elapsedMs: 2,
      at: 1,
    })).toContain("校验不一致");
  });

  it("reads only the in-memory recorder and starts empty", () => {
    const diagnostics = new LanDiagnostics();
    diagnostics.record({
      outcome: "hit",
      route: "prflx",
      bytes: 1024,
      elapsedMs: 5,
      at: 10,
    });
    diagnostics.record({
      outcome: "fallback",
      reason: "source-error",
      route: "unknown",
      bytes: 0,
      elapsedMs: 3,
      at: 11,
    });
    const text = formatLanDiagnosticsSection({
      last: diagnostics.getLast(),
      counters: diagnostics.getCounters(),
    }).join("\n");
    expect(text).toContain("局域网传输失败");
    expect(text).toContain("命中 1 / 回退 1 / 拒绝 0 / 跳过 0");

    const fresh = new LanDiagnostics();
    const after = formatLanDiagnosticsSection({
      last: fresh.getLast(),
      counters: fresh.getCounters(),
    }).join("\n");
    expect(after).toContain("未发生局域网尝试");
    expect(after).toContain("命中 0 / 回退 0 / 拒绝 0 / 跳过 0");
  });
});

describe("LAN log lines in the report", () => {
  it("selects only LAN execute lines", () => {
    expect(isLanDiagnosticLogEntry(lanEntry("LAN serve complete"))).toBe(true);
    expect(isLanDiagnosticLogEntry(lanEntry("LAN content hit: a.md"))).toBe(true);
    expect(isLanDiagnosticLogEntry(lanEntry("download streaming to temp file"))).toBe(false);
    expect(isLanDiagnosticLogEntry({
      ...lanEntry("LAN serve complete"),
      cat: "onedrive",
    })).toBe(false);
  });

  it("projects data through a field whitelist", () => {
    expect(projectLanDiagnosticLogData({
      step: "served",
      result: "ok",
      route: "host",
      bytes: 4096,
      elapsedMs: 12,
      // Everything below is what a careless future logger might add.
      secret: ROOM_SECRET,
      candidate: CANDIDATE,
      endpoint: "192.168.1.10:50000",
    })).toEqual({
      step: "served",
      result: "ok",
      route: "host",
      bytes: 4096,
      elapsedMs: 12,
    });
    expect(projectLanDiagnosticLogData({ secret: ROOM_SECRET })).toBeUndefined();
    expect(projectLanDiagnosticLogData(undefined)).toBeUndefined();
    expect(projectLanDiagnosticLogData("LAN x")).toBeUndefined();
  });

  it("never renders a room secret, a candidate or an address", () => {
    const block = formatLanLogSection([
      lanEntry("LAN auto connect ready", {
        step: "acquirer-ready",
        result: "ok",
        route: "host",
        bytes: 1024,
        elapsedMs: 900,
        secret: ROOM_SECRET,
        candidates: [CANDIDATE],
      }),
    ]).join("\n");
    expect(block).toContain("### 局域网日志");
    expect(block).toContain("LAN auto connect ready");
    expect(block).toContain('"step":"acquirer-ready"');
    expect(block).toContain('"route":"host"');
    expect(block).not.toContain(ROOM_SECRET);
    expect(block).not.toContain("candidate:");
    expect(block).not.toContain("192.168.");
  });

  it("renders nothing at all when no LAN line matched", () => {
    expect(formatLanLogSection([])).toEqual([]);
  });

  it("keeps the family bounded by its own limit", () => {
    expect(LAN_DIAGNOSTIC_LOG_LIMIT).toBeGreaterThan(0);
    expect(LAN_DIAGNOSTIC_LOG_LIMIT).toBeLessThanOrEqual(200);
  });
});

describe("LAN report wiring", () => {
  it("sits right after the passive connection-speed section", () => {
    const report = functionBody(
      readSourceFile("src/main.ts"),
      "private async buildDiagnosticReportFile(",
    );
    const speed = report.indexOf("renderDiagnosticConnectionSpeedSection");
    const lan = report.indexOf("this.renderDiagnosticLanSection(");
    const download = report.indexOf("this.renderDiagnosticDownloadTransferSection(");
    expect(speed).toBeGreaterThan(-1);
    expect(lan).toBeGreaterThan(speed);
    expect(download).toBeGreaterThan(lan);
    // Exactly one call site (definition + call = 2 occurrences).
    const source = readSourceFile("src/main.ts");
    expect(source.split("renderDiagnosticLanSection").length - 1).toBe(2);
  });

  it("feeds the log filter with the LAN predicate and a bounded window", () => {
    const source = readSourceFile("src/main.ts");
    // The shared log window lives in the anomalies section, which owns
    // 「近期异常日志」; the report body only calls into it.
    const anomalies = functionBody(
      source,
      "private async renderDiagnosticAnomaliesSection(",
    );
    expect(anomalies).toContain("isLanDiagnosticLogEntry(e) && lanLogWindow.has(e)");
    expect(anomalies).toContain(".slice(-LAN_DIAGNOSTIC_LOG_LIMIT)");
    // The LAN block is a separate subsection, never mixed into "其他异常".
    expect(anomalies).toContain("formatLanLogSection(");
    expect(anomalies).toContain("const lanEntries = diagEntries.filter(isLanDiagnosticLogEntry)");
  });

  it("adds the section even when diagnostic logging is off", () => {
    // The LAN block is ordinary read-only evidence, not a logging-gated
    // section: it must appear in every report.
    const source = readSourceFile("src/main.ts");
    const body = functionBody(
      source,
      "private renderDiagnosticLanSection(",
    );
    expect(body).not.toContain("diagLogEnabled");
    const plugin = new EasySyncPlugin();
    plugin.diagLogEnabled = false;
    const lines: string[] = [];
    (plugin as unknown as {
      renderDiagnosticLanSection: (ctx: { lines: string[] }) => void;
    }).renderDiagnosticLanSection({ lines });
    expect(lines.join("\n")).toContain("## 局域网加速（被动记录）");
    expect(lines.join("\n")).toContain("未发生局域网尝试");
  });
});
