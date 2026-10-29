/** 下载通道与分段的诊断证据（2026-10-28，S1 预留）。
 *
 *  诊断报告里「下载通道与分段」区块只读这里。事实本应由产生它的地方写出：
 *  下载日志额外带一份结构化 payload（`msg` 保持原文），报告侧只做投影与
 *  排版，不再解析日志文本。
 *
 *  2026-10-28 回退（真机反馈「进度按 8 MiB 跳、取消卡死」）：移动端分块 /
 *  流式 / 通道择优三层已删除，证据生产者随之消失。本模块与报告区块保留，
 *  空窗口仍渲染表头与一行 `—`，等未来通道重新接线时再写入。
 *
 *  边界：
 *  - 只有诊断日志开关打开时报告才调用这里；开关关闭时报告逐字不变；
 *  - 纯只读：不参与任何同步判断，也不是持久状态；
 *  - 每个字段缺失都渲染 `—`，绝不猜。旧构筑物写下的日志、被裁剪过的老数据
 *    与「这条路径本来就没有证据」在报告里看起来一样。
 *
 *  报告体积：列表最多 5 个文件（其余只计数），单文件的窗口序列最多 8 个。
 *  一轮大文件多时这里不能把报告撑爆。
 */

import { isRecord } from "../obsidian-compat";
import type { DiagEntry } from "./diagnostic-logger";

/** 一条下载通道证据记录在 `data.event` 上的固定取值。 */
export const DOWNLOAD_TRANSFER_DIAGNOSTIC_EVENT = "download-transfer";

/** 这次尝试的末端校验方式。 */
type DownloadTransferVerification = "sha256" | "quickXor" | "size-only";

/** 这次尝试自己的结局：`fallback` ＝已交给其它通道继续（原因与回退前已落地
 *  字节在下面两个字段里），`cancelled` ＝被取消，没有交给其它通道。 */
type DownloadTransferOutcome = "complete" | "fallback" | "cancelled";

/** 报告窗口里按路径投影后的事实（同一路径取最新一次尝试）。 */
interface DownloadTransferEvidence {
  path: string;
  /** 该路径最新一条记录的时间，仅用于排序。 */
  lastAt: number;
  channel: string | null;
  chunkSizes: readonly number[] | null;
  chunks: number | null;
  verification: DownloadTransferVerification | null;
  /** `null` ＝窗口里没有记录说过是否发生回退。 */
  fallbackOccurred: boolean | null;
  fallback: { reason: string | null; completedBytes: number | null } | null;
}

const DOWNLOAD_TRANSFER_VERIFICATIONS: ReadonlySet<string> = new Set([
  "sha256",
  "quickXor",
  "size-only",
]);

const DOWNLOAD_TRANSFER_OUTCOMES: ReadonlySet<string> = new Set([
  "complete",
  "fallback",
  "cancelled",
]);

/** 通道标签只接受一个短 token：证据里写的是通道名，不是自由文本；这也能
 *  避免畸形日志把表格的 `|` 结构撑坏。 */
const DOWNLOAD_TRANSFER_CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/i;

/** 单条记录最多保留的窗口数。这里只防一条畸形记录把内存和报告撑大。 */
const MAX_STORED_CHUNK_SIZES = 4096;

/** 报告里每个文件最多列出的窗口数，其余用「…」收口。 */
const DOWNLOAD_TRANSFER_CHUNK_LIMIT = 8;

/** 报告里最多列出的文件数，其余只计数（「另有 N 个」）。 */
const DOWNLOAD_TRANSFER_FILE_LIMIT = 5;

const EMPTY_CELL = "—";

/** 一条日志记录归一化后的形状；缺的字段保持缺失。 */
interface ParsedDownloadTransferRecord {
  path: string;
  channel?: string;
  chunkSizes?: number[];
  chunks?: number;
  verification?: DownloadTransferVerification;
  outcome?: DownloadTransferOutcome;
  fallbackReason?: string;
  fallbackCompletedBytes?: number;
}

/**
 * 从报告窗口里按路径投影下载通道证据，最新的路径排在最前。
 *
 * 容错口径：`data` 不是对象、`event` 不匹配、路径不是非空字符串、枚举取值
 * 不在集合里、数值不是有限非负数——都按「这条记录没说」处理，跳过该项或整条
 * 记录，绝不抛错。畸形窗口只会让报告多几个 `—`。
 */
export function collectDownloadTransferEvidence(
  entries: readonly DiagEntry[],
): DownloadTransferEvidence[] {
  const byPath = new Map<string, DownloadTransferEvidence>();
  for (const entry of entries) {
    const record = parseDownloadTransferRecord(entry);
    if (!record) continue;
    const current = byPath.get(record.path) ?? {
      path: record.path,
      lastAt: entry.ts,
      channel: null,
      chunkSizes: null,
      chunks: null,
      verification: null,
      fallbackOccurred: null,
      fallback: null,
    };
    current.lastAt = entry.ts;
    if (record.channel) current.channel = record.channel;
    if (record.chunkSizes) current.chunkSizes = record.chunkSizes;
    if (record.chunks !== undefined) current.chunks = record.chunks;
    if (record.verification) current.verification = record.verification;
    if (record.outcome) {
      // 最新一次尝试说了算：回退过后又在同一路径重试成功，就不再是「有回退」。
      current.fallbackOccurred = record.outcome === "fallback";
      current.fallback = record.outcome === "fallback"
        ? {
            reason: record.fallbackReason ?? null,
            completedBytes: record.fallbackCompletedBytes ?? null,
          }
        : null;
    } else if (
      record.fallbackReason !== undefined
      || record.fallbackCompletedBytes !== undefined
    ) {
      // 没有 `outcome` 的老记录（只有原因或已落地字节）仍然算发生过回退。
      current.fallbackOccurred = true;
      current.fallback = {
        reason: record.fallbackReason ?? null,
        completedBytes: record.fallbackCompletedBytes ?? null,
      };
    }
    byPath.set(record.path, current);
  }
  return [...byPath.values()].sort((left, right) =>
    right.lastAt - left.lastAt || left.path.localeCompare(right.path)
  );
}

function parseDownloadTransferRecord(
  entry: DiagEntry,
): ParsedDownloadTransferRecord | null {
  const data = entry.data;
  if (!isRecord(data)) return null;
  if (data.event !== DOWNLOAD_TRANSFER_DIAGNOSTIC_EVENT) return null;
  if (typeof data.path !== "string" || data.path.length === 0) return null;
  const record: ParsedDownloadTransferRecord = { path: data.path };
  if (
    typeof data.channel === "string"
    && DOWNLOAD_TRANSFER_CHANNEL_PATTERN.test(data.channel)
  ) {
    record.channel = data.channel;
  }
  const chunkSizes = readChunkSizes(data.chunkSizes);
  if (chunkSizes) record.chunkSizes = chunkSizes;
  const chunks = readCount(data.chunks);
  if (chunks !== undefined) record.chunks = chunks;
  if (
    typeof data.verification === "string"
    && DOWNLOAD_TRANSFER_VERIFICATIONS.has(data.verification)
  ) {
    record.verification = data.verification as DownloadTransferVerification;
  }
  if (
    typeof data.outcome === "string"
    && DOWNLOAD_TRANSFER_OUTCOMES.has(data.outcome)
  ) {
    record.outcome = data.outcome as DownloadTransferOutcome;
  }
  if (typeof data.fallbackReason === "string" && data.fallbackReason.length > 0) {
    record.fallbackReason = data.fallbackReason;
  }
  const completedBytes = readCount(data.fallbackCompletedBytes);
  if (completedBytes !== undefined) {
    record.fallbackCompletedBytes = completedBytes;
  }
  return record;
}

/** 整条序列里有一个坏值就当作「没说过」：一半的 `chunkSizes` 比 `—` 更误导。 */
function readChunkSizes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sizes: number[] = [];
  for (const size of value) {
    if (sizes.length >= MAX_STORED_CHUNK_SIZES) break;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      return undefined;
    }
    sizes.push(Math.floor(size));
  }
  return sizes;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * 报告的「下载通道与分段」区块（仅诊断日志开启时由 `main.ts` 追加）。
 *
 * 没有证据时也渲染表头与一行 `—`：当前没有生产者，必须还能看出「这个区块
 * 在场、只是没有数据」，而不是整块消失。
 */
export function formatDownloadTransferSection(
  evidence: readonly DownloadTransferEvidence[],
): string[] {
  const lines: string[] = [];
  lines.push("## 下载通道与分段");
  lines.push("");
  lines.push("| 文件 | 通道 | 分段 | 回退 | 校验 |");
  lines.push("|------|------|------|------|------|");
  if (evidence.length === 0) {
    lines.push(
      `| ${EMPTY_CELL} | ${EMPTY_CELL} | ${EMPTY_CELL} | ${EMPTY_CELL} | ${EMPTY_CELL} |`,
    );
  } else {
    for (const item of evidence.slice(0, DOWNLOAD_TRANSFER_FILE_LIMIT)) {
      lines.push(
        `| \`${item.path.replace(/`/g, "\\`")}\` | ${item.channel ?? EMPTY_CELL} | ${formatChunkSequenceCell(item)} | ${formatFallbackCell(item)} | ${item.verification ?? EMPTY_CELL} |`,
      );
    }
  }
  const hidden = evidence.length - DOWNLOAD_TRANSFER_FILE_LIMIT;
  if (hidden > 0) {
    lines.push("");
    lines.push(`*另有 ${hidden} 个文件未列出。*`);
  }
  lines.push("");
  return lines;
}

/** `8388608,12582912（2 段）`；无窗口时 `—`，超出上限用「…」收口但段数照实。 */
function formatChunkSequenceCell(item: DownloadTransferEvidence): string {
  const sizes = item.chunkSizes;
  if (!sizes || sizes.length === 0) return EMPTY_CELL;
  const shown = sizes.slice(0, DOWNLOAD_TRANSFER_CHUNK_LIMIT).join(",");
  const ellipsis = sizes.length > DOWNLOAD_TRANSFER_CHUNK_LIMIT ? "…" : "";
  const count = item.chunks ?? sizes.length;
  return `${shown}${ellipsis}（${count} 段）`;
}

/** `有（timeout）· 回退前已落地 8388608 B` / `无` / `—`。 */
function formatFallbackCell(item: DownloadTransferEvidence): string {
  if (item.fallbackOccurred === null) return EMPTY_CELL;
  if (!item.fallbackOccurred) return "无";
  const reason = item.fallback?.reason ?? EMPTY_CELL;
  const completedBytes = item.fallback?.completedBytes;
  const landed = completedBytes === null || completedBytes === undefined
    ? EMPTY_CELL
    : `${completedBytes} B`;
  return `有（${reason}）· 回退前已落地 ${landed}`;
}
