import { describe, expect, it } from "vitest";
import type { DiagEntry } from "../src/sync/diagnostic-logger";
import {
  collectRecentRunSummaries,
  describeMissingRunSummaries,
  DIAG_RUN_SUMMARY_LIMIT,
  DIAG_RUN_SUMMARY_MISSING,
  formatDiagRunSummaryTable,
} from "../src/sync/diagnostic-run-summary";

const format = {
  time: (ts: number): string => `T${ts}`,
  size: (bytes: number): string => `${bytes}B`,
};

/** One complete round's four summary lines, oldest line first. */
function roundEntries(round: number, ts: number): DiagEntry[] {
  return [
    {
      ts,
      cat: "onedrive",
      lvl: "log",
      msg: "sync network summary",
      data: {
        schemaVersion: 2,
        totals: { attempts: 10 + round },
      },
    },
    {
      ts: ts + 1,
      cat: "execute",
      lvl: "log",
      msg: "sync file transfer summary",
      data: {
        schemaVersion: 3,
        upload: { logicalBytes: 1000 * round },
        download: { logicalBytes: 500 },
      },
    },
    {
      ts: ts + 2,
      cat: "execute",
      lvl: "log",
      msg: "sync automatic handling summary",
      data: { schemaVersion: 1, round },
    },
    {
      ts: ts + 3,
      cat: "lifecycle",
      lvl: "log",
      msg: "sync run phase summary",
      data: {
        schemaVersion: 2,
        mode: "auto",
        status: "success",
        totalMs: 4000 + round,
        phasesMs: {
          scan: 1000,
          transfer: 2000,
          planning: 500,
          commit: 100 + round,
        },
        counts: {
          conflicts: 8,
          conflictsOnly: 3,
          remoteDeletePending: 5,
        },
      },
    },
  ];
}

describe("diagnostic run summaries", () => {
  it("groups three rounds and renders them newest first", () => {
    const entries = [
      ...roundEntries(1, 100),
      ...roundEntries(2, 200),
      ...roundEntries(3, 300),
    ];
    const rounds = collectRecentRunSummaries(entries);
    expect(rounds).toHaveLength(3);
    expect(rounds.map((round) => round.phase?.ts)).toEqual([103, 203, 303]);

    const lines = formatDiagRunSummaryTable(rounds, format);
    expect(lines[0]).toBe(
      "| 时间 | 模式 | 状态 | 总耗时 | 主要阶段耗时 | 请求数 | 传输字节 |",
    );
    expect(lines).toHaveLength(2 + 3);
    // Newest round is the first data row.
    expect(lines[2]).toContain("| T303 |");
    expect(lines[2]).toContain("| 自动 |");
    expect(lines[2]).toContain("| 已完成 |");
    expect(lines[2]).toContain("| 4.0s |");
    expect(lines[2]).toContain("transfer 2.0s");
    expect(lines[2]).toContain("| 13 |");
    expect(lines[2]).toContain("| 3500B |");
    expect(lines[3]).toContain("| T203 |");
    expect(lines[4]).toContain("| T103 |");
  });

  it("marks a round whose transfer summary is missing", () => {
    const entries = roundEntries(1, 100).filter(
      (entry) => entry.msg !== "sync file transfer summary",
    );
    const rounds = collectRecentRunSummaries(entries);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].transfer).toBeUndefined();

    const row = formatDiagRunSummaryTable(rounds, format)[2];
    // 请求数 still comes from the network line; only the missing cell is marked.
    expect(row).toContain("| 11 |");
    expect(row.endsWith(`| ${DIAG_RUN_SUMMARY_MISSING} |`)).toBe(true);
  });

  it("keeps the newest five rounds only", () => {
    const entries = [1, 2, 3, 4, 5, 6, 7].flatMap((round) =>
      roundEntries(round, round * 100)
    );
    const rounds = collectRecentRunSummaries(entries);
    expect(rounds).toHaveLength(DIAG_RUN_SUMMARY_LIMIT);
    expect(rounds.map((round) => round.phase?.ts)).toEqual([
      303, 403, 503, 603, 703,
    ]);
    expect(formatDiagRunSummaryTable(rounds, format)).toHaveLength(
      2 + DIAG_RUN_SUMMARY_LIMIT,
    );
  });

  it("keeps an incomplete trailing round and marks every missing phase cell", () => {
    const complete = roundEntries(1, 100);
    const trailing: DiagEntry[] = [
      {
        ts: 200,
        cat: "onedrive",
        lvl: "log",
        msg: "sync network summary",
        data: { schemaVersion: 2, totals: { attempts: 99 } },
      },
    ];
    const rounds = collectRecentRunSummaries([...complete, ...trailing]);
    expect(rounds).toHaveLength(2);
    expect(rounds[1].phase).toBeUndefined();

    const row = formatDiagRunSummaryTable(rounds, format)[2];
    expect(row).toContain("| T200 |");
    expect(row).toBe(
      `| T200 | ${DIAG_RUN_SUMMARY_MISSING} | ${DIAG_RUN_SUMMARY_MISSING}`
        + ` | ${DIAG_RUN_SUMMARY_MISSING} | ${DIAG_RUN_SUMMARY_MISSING} | 99`
        + ` | ${DIAG_RUN_SUMMARY_MISSING} |`,
    );
  });

  it("explains missing rounds instead of leaving the section blank", () => {
    expect(describeMissingRunSummaries({
      roundCount: 0,
      diagnosticsEnabled: false,
      hasLogEntries: true,
    })).toContain("诊断日志未开启");
    expect(describeMissingRunSummaries({
      roundCount: 0,
      diagnosticsEnabled: true,
      hasLogEntries: false,
    })).toContain("诊断日志未开启");
    expect(describeMissingRunSummaries({
      roundCount: 0,
      diagnosticsEnabled: true,
      hasLogEntries: true,
    })).toContain("滚出日志窗口");
    expect(describeMissingRunSummaries({
      roundCount: 3,
      diagnosticsEnabled: true,
      hasLogEntries: true,
    })).toContain("滚出日志窗口");
    expect(describeMissingRunSummaries({
      roundCount: DIAG_RUN_SUMMARY_LIMIT,
      diagnosticsEnabled: true,
      hasLogEntries: true,
    })).toBeNull();
  });
});
