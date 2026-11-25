/**
 * 局域网加速的诊断报告投影（S5b，实验性）。
 *
 * 报告里「局域网加速（被动记录）」区块只读这里：最近一次尝试来自
 * `LanDiagnostics.getLast()`，次数来自同一实例的只增计数器，两者都是纯内存
 * 事实。本模块不发起任何网络请求、不读盘、不解析日志文本。
 *
 * 日志侧只做白名单投影：只保留 step / result / route / bytes / elapsedMs 五类
 * 字段，room secret、候选文本、地址与端口都不在允许名单里，即使未来某条日志
 * 的 `data` 意外带上它们也不会进入报告。
 *
 * 报告是中文技术向固定文案（见 [诊断报告] 专题「当前不做」：不做多语言），
 * 因此这里与报告其余节一样直接写中文，不新增 i18n 键。
 */
import type {
  LanDiagnosticCounters,
  LanDiagnosticOutcome,
  LanDiagnosticReason,
  LanDiagnosticSnapshot,
} from "./lan-diagnostics";
import type { DiagEntry } from "./diagnostic-logger";

/** 「近期异常日志」里最多列出的局域网日志条数。逐文件一条命中日志，条数
 *  远多于告警，因此给它一个比 200 更短的上限，避免把真实异常挤出去。 */
export const LAN_DIAGNOSTIC_LOG_LIMIT = 40;
/** 报告里允许出现的日志字段白名单。 */
const LAN_LOG_DATA_FIELDS = [
  "step",
  "result",
  "route",
  "bytes",
  "elapsedMs",
] as const;

const REASON_LABELS: Record<LanDiagnosticReason, string> = {
  "disabled": "开关已关闭",
  "below-threshold": "文件低于触发大小",
  "no-source": "没有可用的局域网连接",
  "source-error": "局域网传输失败",
  "hash-mismatch": "校验不一致",
  "route-relay": "走了中继路线，已回退",
};

const OUTCOME_LABELS: Record<LanDiagnosticOutcome, string> = {
  hit: "命中",
  fallback: "回退",
  rejected: "拒绝",
  skipped: "跳过",
};

/** 报告时间格式与报告其余节一致：`MM/DD HH:mm`。 */
function formatLanReportTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 最近一次尝试的描述；没有尝试时返回空态句。命中不写「原因」，其余结局都
 *  写明原因与路线/字节/耗时，不让读者以为这次没测过。 */
export function formatLanLastAttempt(
  last: LanDiagnosticSnapshot | null,
): string {
  if (last === null) return "未发生局域网尝试";
  const facts = `路线 ${last.route}，${last.bytes} 字节，耗时 ${last.elapsedMs} ms，${formatLanReportTime(last.at)}`;
  if (last.outcome === "hit") return `最近一次命中：${facts}`;
  const reason = last.reason === undefined ? "—" : REASON_LABELS[last.reason];
  return `最近一次${OUTCOME_LABELS[last.outcome]}：原因 ${reason}（${facts}）`;
}

/** 报告节：最近一次尝试 + 本次会话次数（紧邻「连接速度（被动实测）」之后）。 */
export function formatLanDiagnosticsSection(input: {
  last: LanDiagnosticSnapshot | null;
  counters: LanDiagnosticCounters;
}): string[] {
  const { last, counters } = input;
  const lines: string[] = [];
  lines.push("## 局域网加速（被动记录）");
  lines.push("");
  lines.push(`**最近一次尝试**: ${formatLanLastAttempt(last)}`);
  lines.push(
    `**本次会话次数**: 命中 ${counters.hit} / 回退 ${counters.fallback} / 拒绝 ${counters.rejected} / 跳过 ${counters.skipped}`,
  );
  lines.push("");
  lines.push(
    "记录只读本机内存快照（最近一次尝试与本次会话计数），不发起任何网络请求、不落盘、不进同步历史；路线类别只表示所选候选类型，不含地址、端口或候选文本。",
  );
  lines.push("");
  return lines;
}

/** 日志是否属于局域网记录。条件显式写出，普通 execute 日志不会被卷进来。 */
export function isLanDiagnosticLogEntry(entry: DiagEntry): boolean {
  return entry.cat === "execute" && /^LAN /.test(entry.msg);
}

/**
 * 按白名单投影日志 `data`；什么合法字段都没有时返回 undefined。
 * 返回类型只含字符串与数字，报告侧不再直接序列化原始对象。
 */
export function projectLanDiagnosticLogData(
  value: unknown,
): Record<string, string | number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const projected: Record<string, string | number> = {};
  for (const field of LAN_LOG_DATA_FIELDS) {
    const candidate = source[field];
    if (typeof candidate === "string" || typeof candidate === "number") {
      projected[field] = candidate;
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * 报告里「局域网日志」小节的完整行（标题、代码块与逐条投影）。
 *
 * 调用方已经把 LAN 条件放进主过滤；这里不再二次筛选普通日志。`prefix`
 * 用于沿用「重置前／重置后」标注，保持与相邻日志节同一时间语义。
 */
export function formatLanLogSection(
  entries: readonly DiagEntry[],
  prefix: (ts: number) => string = () => "",
): string[] {
  const lines: string[] = [];
  if (entries.length === 0) return lines;
  lines.push("### 局域网日志");
  lines.push("");
  lines.push("```");
  for (const entry of entries) {
    lines.push(
      `${formatLanReportTime(entry.ts)}${prefix(entry.ts)} [${entry.cat}] ${entry.msg}`,
    );
    const data = projectLanDiagnosticLogData(entry.data);
    if (data !== undefined) {
      lines.push(`  detail: ${JSON.stringify(data)}`);
    }
  }
  lines.push("```");
  return lines;
}
