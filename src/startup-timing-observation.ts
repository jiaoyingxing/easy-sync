import type { DataAdapter } from "obsidian";
import type {
  PluginColdStartSummary,
  StartupStageMark,
} from "./startup-performance";

/**
 * Resident startup-timing observation (diagnostics-only, 2026-11-05).
 *
 * The in-memory tracker in `startup-performance.ts` owns the live marks. This
 * module turns the completed session into one bounded, path-free record and
 * renders the diagnostic report section. It is deliberately separate from the
 * diagnostic logger: the JSONL buffer is a rolling window that sync activity
 * can push a cold-start line out of, while "continuously restart and compare"
 * needs a small, stable, per-startup record.
 *
 * Cost boundary: marks are `performance.now()` only; this module does one
 * read + one write after state/auth are already ready, and never on the onload
 * critical path. When diagnostics are off the caller does not call it at all.
 * Privacy boundary: stage names, relative milliseconds, coarse platform/host
 * facts and readiness outcomes only; no paths, accounts, tokens or content.
 */

export const STARTUP_TIMING_OBSERVATION_FILE =
  "startup-timing-observations.json";
export const STARTUP_TIMING_OBSERVATION_MAX_RECORDS = 40;
const STARTUP_TIMING_REPORT_LIMIT = 5;

const MAX_STAGES = 32;
const MAX_STAGE_NAME_LENGTH = 48;
const MAX_FACT_LENGTH = 64;

export interface StartupTimingObservationRecord {
  schemaVersion: 1;
  recordedAt: string;
  platform: "desktop" | "mobile";
  apiVersion: string;
  pluginVersion: string;
  visibilityAtOnload: string;
  readyMs: {
    ui: number;
    state: number;
    auth: number;
  };
  onloadReturnedMs: number | null;
  layoutReadyMs: number | null;
  hostLayoutWaitMs: number | null;
  pluginDataReadMs: number;
  stateOutcome: "ready" | "failed" | "";
  authOutcome: "ready" | "failed" | "";
  stages: StartupStageMark[];
}

export function buildStartupTimingObservation(
  summary: PluginColdStartSummary,
  recordedAt = new Date().toISOString(),
): StartupTimingObservationRecord {
  return {
    schemaVersion: 1,
    recordedAt,
    platform: summary.platform,
    apiVersion: summary.host?.apiVersion ?? "",
    pluginVersion: summary.host?.pluginVersion ?? "",
    visibilityAtOnload: summary.host?.visibilityAtOnload ?? "",
    readyMs: { ...summary.readyMs },
    onloadReturnedMs: summary.onloadReturnedMs,
    layoutReadyMs: summary.layoutReadyMs,
    hostLayoutWaitMs: summary.hostLayoutWaitMs,
    pluginDataReadMs: summary.pluginData.readMs,
    stateOutcome: summary.state.outcome,
    authOutcome: summary.auth.outcome,
    stages: summary.stages.slice(0, MAX_STAGES).map((mark) => ({ ...mark })),
  };
}

export function normalizeStartupTimingObservation(
  input: unknown,
): StartupTimingObservationRecord | null {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== 1) return null;
  const platform = input.platform;
  if (platform !== "desktop" && platform !== "mobile") return null;
  const readyMs: Record<string, unknown> =
    isRecord(input.readyMs) ? input.readyMs : {};
  return {
    schemaVersion: 1,
    recordedAt: cleanFact(input.recordedAt),
    platform,
    apiVersion: cleanFact(input.apiVersion),
    pluginVersion: cleanFact(input.pluginVersion),
    visibilityAtOnload: cleanFact(input.visibilityAtOnload),
    readyMs: {
      ui: nonNegative(readyMs.ui),
      state: nonNegative(readyMs.state),
      auth: nonNegative(readyMs.auth),
    },
    onloadReturnedMs: nullableNonNegative(input.onloadReturnedMs),
    layoutReadyMs: nullableNonNegative(input.layoutReadyMs),
    hostLayoutWaitMs: nullableNonNegative(input.hostLayoutWaitMs),
    pluginDataReadMs: nonNegative(input.pluginDataReadMs),
    stateOutcome: readOutcome(input.stateOutcome),
    authOutcome: readOutcome(input.authOutcome),
    stages: normalizeStages(input.stages),
  };
}

/** Read the bounded record set; any missing/corrupt file reads as empty. */
export async function readStartupTimingObservations(
  adapter: Pick<DataAdapter, "exists" | "read">,
  logsDir: string,
): Promise<StartupTimingObservationRecord[]> {
  try {
    const path = observationPath(logsDir);
    if (!(await adapter.exists(path))) return [];
    const parsed: unknown = JSON.parse(await adapter.read(path));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStartupTimingObservation)
      .filter((record): record is StartupTimingObservationRecord => record !== null);
  } catch {
    return [];
  }
}

/**
 * Append one completed session, keeping the newest 40 records. Returns false
 * when the write failed; observation must never affect sync or startup.
 */
export async function appendStartupTimingObservation(
  adapter: Pick<DataAdapter, "exists" | "read" | "write" | "mkdir">,
  logsDir: string,
  record: StartupTimingObservationRecord,
): Promise<boolean> {
  try {
    const current = await readStartupTimingObservations(adapter, logsDir);
    const next = [
      ...current,
      normalizeStartupTimingObservation(record),
    ]
      .filter((item): item is StartupTimingObservationRecord => item !== null)
      .slice(-STARTUP_TIMING_OBSERVATION_MAX_RECORDS);
    try {
      await adapter.mkdir(logsDir);
    } catch {
      // The directory may already exist or be unreadable; the write below is
      // the authoritative failure point.
    }
    await adapter.write(
      observationPath(logsDir),
      `${JSON.stringify(next, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Diagnostic-report section. Pure and path-free; the caller appends the lines.
 * `records` is newest-last; the report shows the newest `limit` sessions.
 */
export function formatStartupTimingSection(
  records: readonly StartupTimingObservationRecord[],
  limit = STARTUP_TIMING_REPORT_LIMIT,
): string[] {
  const lines: string[] = ["## 启动耗时观察", ""];
  lines.push(
    "> 只含阶段名与毫秒，不含路径、账号或内容。它不是官方 Startup time 槽；官方读数仍按《冷启动口径与官方取数》§3 取。插件重载时布局可能已就绪，宿主等待会显示 0；该列只在完整冷启动有意义。",
  );
  lines.push("");
  if (records.length === 0) {
    lines.push("开启诊断日志后，每次冷启动会记录一条；当前还没有记录。");
    return lines;
  }
  const sorted = [...records].sort((left, right) =>
    left.recordedAt < right.recordedAt ? 1 : left.recordedAt > right.recordedAt ? -1 : 0
  );
  const recent = sorted.slice(0, Math.max(0, limit));
  const mobile = records.filter((record) => record.platform === "mobile").length;
  lines.push(
    `**会话记录**: 共 ${records.length} 条（最近一次 ${formatRecordedAt(sorted[0]?.recordedAt ?? "")}）`,
  );
  lines.push(
    `**平台分布**: 桌面 ${records.length - mobile} 条 / 移动 ${mobile} 条`,
  );
  lines.push("");
  lines.push(
    "| 记录时间 | 平台 | 插件同步段 | 宿主 layout-ready 等待 | state 就绪 | auth 就绪 | 数据读取 |",
  );
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const record of recent) {
    lines.push(
      `| ${formatRecordedAt(record.recordedAt)} | ${record.platform} | ${formatMs(record.onloadReturnedMs)} | ${formatMs(record.hostLayoutWaitMs)} | ${formatMs(record.readyMs.state)} | ${formatMs(record.readyMs.auth)} | ${formatMs(record.pluginDataReadMs)} |`,
    );
  }
  const latest = recent[0];
  if (latest && latest.stages.length > 0) {
    lines.push("");
    lines.push("**最近一次阶段**（相对 onload 起点）:");
    lines.push("");
    lines.push("| 阶段 | 时刻 | 距上一阶段 |");
    lines.push("| --- | ---: | ---: |");
    let previous = 0;
    for (const mark of latest.stages) {
      const at = nonNegative(mark.atMs);
      lines.push(`| ${mark.stage || "(unnamed)"} | ${formatMs(at)} | ${formatMs(at - previous)} |`);
      previous = at;
    }
  }
  return lines;
}

function observationPath(logsDir: string): string {
  return `${logsDir.replace(/\/+$/, "")}/${STARTUP_TIMING_OBSERVATION_FILE}`;
}

function normalizeStages(input: unknown): StartupStageMark[] {
  if (!Array.isArray(input)) return [];
  const stages: StartupStageMark[] = [];
  for (const candidate of input) {
    if (stages.length >= MAX_STAGES) break;
    if (!isRecord(candidate)) continue;
    const stage = cleanFact(candidate.stage).slice(0, MAX_STAGE_NAME_LENGTH);
    const atMs = nullableNonNegative(candidate.atMs);
    if (!stage || atMs === null) continue;
    stages.push({ stage, atMs });
  }
  return stages.sort((left, right) => left.atMs - right.atMs);
}

function readOutcome(value: unknown): "ready" | "failed" | "" {
  return value === "ready" || value === "failed" ? value : "";
}

function formatRecordedAt(value: string): string {
  const normalized = value.replace("T", " ").replace(/\..*$/, "");
  return normalized || "—";
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}ms`;
}

function cleanFact(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LENGTH)
    : "";
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function nullableNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
