/**
 * Per-round diagnostic summaries, addressed by their fixed message names.
 *
 * One sync round emits up to four summary lines at round end, in this order:
 * network request totals → file transfer totals → automatic handling → phase
 * durations. They all already reach the diagnostic JSONL, but the report used
 * to tail-slice the merged entries to the newest 500 and then keep only the
 * latest of each kind — so every older round disappeared from the report even
 * though the log still held it.
 *
 * This module owns the fixed names and the single extraction path:
 *   - `DiagnosticLogger.snapshot` bypasses the report window with
 *     `collectRecentRunSummaries` (no extra disk read: the segments are parsed
 *     in full before the window is applied);
 *   - the report renders the 5-round table and the latest-round JSON from the
 *     same rounds.
 *
 * Summaries live only in the diagnostic log (and in the report built from it).
 * Nothing here is persisted into `data.json`.
 */

import { isRecord } from "../obsidian-compat";
import type { DiagEntry } from "./diagnostic-logger";

/** How many rounds the report keeps. Also the bypass size in `snapshot`. */
export const DIAG_RUN_SUMMARY_LIMIT = 5;

/** Rendered in a table cell when that round has no such summary line. */
export const DIAG_RUN_SUMMARY_MISSING = "missing";

/** Fixed message names. The event names themselves must never change: the
 *  report and the field tooling both address rounds by them. */
const DIAG_RUN_SUMMARY_MESSAGES = {
  phase: "sync run phase summary",
  network: "sync network summary",
  transfer: "sync file transfer summary",
  automatic: "sync automatic handling summary",
} as const;

export type DiagRunSummarySegment = keyof typeof DIAG_RUN_SUMMARY_MESSAGES;

/** One round's summary lines. A segment is absent when that line never reached
 *  the readable log window (written before this build, diagnostics off, write
 *  failure, or rolled out of the newest three segments). */
export interface DiagRunSummary {
  phase?: DiagEntry;
  network?: DiagEntry;
  transfer?: DiagEntry;
  automatic?: DiagEntry;
}

const SEGMENT_CATEGORY: Record<DiagRunSummarySegment, DiagEntry["cat"]> = {
  phase: "lifecycle",
  network: "onedrive",
  transfer: "execute",
  automatic: "execute",
};

/** Which summary kind this entry is, or `undefined` for every other line. */
export function diagRunSummarySegmentOf(
  entry: DiagEntry,
): DiagRunSummarySegment | undefined {
  if (entry.lvl !== "log") return undefined;
  switch (entry.msg) {
    case DIAG_RUN_SUMMARY_MESSAGES.phase:
      return entry.cat === SEGMENT_CATEGORY.phase ? "phase" : undefined;
    case DIAG_RUN_SUMMARY_MESSAGES.network:
      return entry.cat === SEGMENT_CATEGORY.network ? "network" : undefined;
    case DIAG_RUN_SUMMARY_MESSAGES.transfer:
      return entry.cat === SEGMENT_CATEGORY.transfer ? "transfer" : undefined;
    case DIAG_RUN_SUMMARY_MESSAGES.automatic:
      return entry.cat === SEGMENT_CATEGORY.automatic ? "automatic" : undefined;
    default:
      return undefined;
  }
}

/**
 * Group the summary lines into rounds, keeping the newest `limit`.
 *
 * A phase line closes a round because it is emitted last; the network /
 * transfer / automatic lines since the previous phase line belong to it.
 * Lines after the last phase line form an incomplete round (phase line lost,
 * e.g. a write failure) and are kept as such instead of being dropped: the
 * table marks the missing cells. Entries must be in chronological order
 * (`snapshot` already sorts its merged set).
 */
export function collectRecentRunSummaries(
  entries: readonly DiagEntry[],
  limit: number = DIAG_RUN_SUMMARY_LIMIT,
): DiagRunSummary[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const rounds: DiagRunSummary[] = [];
  let pending: DiagRunSummary = {};
  let pendingHasSegment = false;

  for (const entry of entries) {
    const segment = diagRunSummarySegmentOf(entry);
    if (!segment) continue;
    pending[segment] = entry;
    pendingHasSegment = true;
    if (segment === "phase") {
      rounds.push(pending);
      pending = {};
      pendingHasSegment = false;
    }
  }
  if (pendingHasSegment) rounds.push(pending);
  return rounds.slice(-Math.floor(limit));
}

interface DiagRunSummaryTableFormat {
  /** Report timestamp formatter (`HH:MM:SS`). */
  time: (ts: number) => string;
  /** Byte formatter used by the rest of the report. */
  size: (bytes: number) => string;
}

/**
 * Markdown rows for the report's "最近 5 轮汇总" table, newest round first.
 * Returns the header and separator too, so the caller only appends lines.
 */
export function formatDiagRunSummaryTable(
  rounds: readonly DiagRunSummary[],
  format: DiagRunSummaryTableFormat,
): string[] {
  const lines = [
    "| 时间 | 模式 | 状态 | 总耗时 | 主要阶段耗时 | 请求数 | 传输字节 |",
    "|------|------|------|--------|--------------|--------|----------|",
  ];
  for (let index = rounds.length - 1; index >= 0; index--) {
    lines.push(formatRunSummaryRow(rounds[index], format));
  }
  return lines;
}

/**
 * Why fewer than 5 rounds are listed. Never returns a blank explanation: a
 * report that shows fewer rows must say whether the log window or the
 * diagnostics switch is responsible (2026-10-26 A1).
 */
export function describeMissingRunSummaries(input: {
  roundCount: number;
  diagnosticsEnabled: boolean;
  hasLogEntries: boolean;
}): string | null {
  if (input.roundCount >= DIAG_RUN_SUMMARY_LIMIT) return null;
  if (input.roundCount > 0) {
    return "只列出日志里现存的这些轮次：更早轮次的摘要已滚出日志窗口"
      + "（报告只读取最近 3 个日志分段），或发生在诊断日志开启之前。";
  }
  if (!input.diagnosticsEnabled || !input.hasLogEntries) {
    return "诊断日志未开启，轮次摘要不会写入；开启后完成一轮同步再生成报告。";
  }
  return "最近 5 轮摘要已滚出日志窗口（报告只读取最近 3 个日志分段），"
    + "或诊断日志开启后尚未完成一轮同步。";
}

// ---- Row projection ----

const RUN_MODE_LABELS: Record<string, string> = {
  manual: "手动",
  auto: "自动",
  first: "首次",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  success: "已完成",
  failed: "失败",
  stopped: "已停止",
  cancelled: "已取消",
  authExpired: "登录过期",
};

const MAX_LISTED_PHASES = 3;

function formatRunSummaryRow(
  run: DiagRunSummary,
  format: DiagRunSummaryTableFormat,
): string {
  const phase = entryData(run.phase);
  const totals = recordField(entryData(run.network), "totals");
  const transfer = entryData(run.transfer);
  const uploadBytes = numberField(
    recordField(transfer, "upload"),
    "logicalBytes",
  );
  const downloadBytes = numberField(
    recordField(transfer, "download"),
    "logicalBytes",
  );
  const totalMs = numberField(phase, "totalMs");
  const mode = stringField(phase, "mode");
  const status = stringField(phase, "status");
  const cells = [
    format.time(roundTimestamp(run)),
    phase ? labelOf(RUN_MODE_LABELS, mode) : DIAG_RUN_SUMMARY_MISSING,
    phase ? labelOf(RUN_STATUS_LABELS, status) : DIAG_RUN_SUMMARY_MISSING,
    phase ? formatDuration(totalMs) : DIAG_RUN_SUMMARY_MISSING,
    phase
      ? formatTopPhases(recordField(phase, "phasesMs"))
      : DIAG_RUN_SUMMARY_MISSING,
    run.network ? formatRequestCount(totals) : DIAG_RUN_SUMMARY_MISSING,
    run.transfer
      ? formatTransferBytes(uploadBytes, downloadBytes, format)
      : DIAG_RUN_SUMMARY_MISSING,
  ];
  return `| ${cells.join(" | ")} |`;
}

/** The round's own clock: phase line first, else the latest segment it kept. */
function roundTimestamp(run: DiagRunSummary): number {
  if (run.phase) return run.phase.ts;
  return Math.max(
    run.network?.ts ?? 0,
    run.transfer?.ts ?? 0,
    run.automatic?.ts ?? 0,
  );
}

function formatRequestCount(totals: Record<string, unknown> | undefined): string {
  const attempts = numberField(totals, "attempts");
  return attempts === undefined ? "—" : String(attempts);
}

function formatTransferBytes(
  uploadBytes: number | undefined,
  downloadBytes: number | undefined,
  format: DiagRunSummaryTableFormat,
): string {
  if (uploadBytes === undefined && downloadBytes === undefined) return "—";
  return format.size((uploadBytes ?? 0) + (downloadBytes ?? 0));
}

function formatTopPhases(phasesMs: Record<string, unknown> | undefined): string {
  if (!phasesMs) return "—";
  const measured = Object.entries(phasesMs)
    .filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0
    )
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_LISTED_PHASES);
  if (measured.length === 0) return "—";
  return measured
    .map(([phase, ms]) => `${phase} ${formatDuration(ms)}`)
    .join(" / ");
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function labelOf(labels: Record<string, string>, value: string | undefined): string {
  if (value === undefined) return "—";
  return labels[value] ?? value;
}

function entryData(entry: DiagEntry | undefined): Record<string, unknown> | undefined {
  if (!entry || !isRecord(entry.data)) return undefined;
  return entry.data;
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const nested = record?.[key];
  return isRecord(nested) ? nested : undefined;
}

function numberField(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
