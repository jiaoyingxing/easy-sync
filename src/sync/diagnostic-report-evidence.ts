import { sha256Hex } from "../crypto";
import type { DiagEntry } from "./diagnostic-logger";
import { isRecord } from "../obsidian-compat";
import {
  SHARED_SYNC_PROTOCOL_PROFILE_DIAGNOSTIC_EVENT,
  type SharedSyncProtocolInconsistencyEvidence,
  type SharedSyncProtocolInconsistencyReason,
} from "./shared-sync-protocol-profile";
import { resolveContentEquality } from "./content-equality";
import type { CommunityPluginInventoryItem } from "./community-plugin-inventory";
import {
  isCommunityPluginDataSelected,
  isPluginSelected,
  type CommunityPluginSyncPolicyV1,
} from "./community-plugin-sync-policy";
import type {
  BaseFileEntry,
  FolderMutationActionV2,
  MutationAction,
  MutationLedgerEntryV1,
  SyncPlanItem,
} from "./types";

const shortHash = (value?: string): string => value
  ? value.toLowerCase().slice(0, 12)
  : "—";
const shortOpaque = (value?: string): string => value
  ? value.slice(0, 12)
  : "—";

export interface ConflictDiagnosticEvidence {
  equalityStatus: "equal" | "different" | "unknown";
  equalityProof: string;
  localHash: string;
  localSize?: number;
  localMtime?: number;
  localQuickXor: string;
  remoteSha256: string;
  remoteQuickXor: string;
  remoteSize?: number;
  remoteMtime?: number;
  remoteETag?: string;
  hasDecisionToken: boolean;
}

export interface SyncHistoryActionCounts {
  uploaded: number;
  downloaded: number;
  filesMoved: number;
  foldersCreated: number;
  foldersMoved: number;
  foldersDeleted: number;
  filesDeleted: number;
}

export type V2StorageAuthorityReportEvidence =
  | {
      kind: "json";
      stateCommitSeq: number;
      lifecycleEpoch: number;
    }
  | {
      kind: "indexeddb";
      databaseFingerprint: string;
      stateCommitSeq: number;
      lifecycleEpoch: number;
    };

export function formatV2StorageAuthorityEvidence(
  input: V2StorageAuthorityReportEvidence | null,
): string {
  if (!input) return "—";
  const revision = `commit ${input.stateCommitSeq} / epoch ${input.lifecycleEpoch}`;
  return input.kind === "indexeddb"
    ? `indexeddb（database fingerprint ${input.databaseFingerprint} / ${revision}）`
    : `json（${revision}）`;
}

export function formatDiagnosticAutomaticSyncSummary(input: {
  intervalMinutes: number;
  paused: boolean;
  changeDelaySeconds: number;
  dirtyPending: boolean;
  activity: string;
}): [string, string] {
  if (input.intervalMinutes <= 0) {
    return [
      "**自动同步**: 已关闭",
      "**修改后触发同步**: 未启用（自动同步已关闭）",
    ];
  }
  if (input.changeDelaySeconds <= 0) {
    return [
      `**自动同步**: ${input.paused
        ? "已暂停"
        : `运行中（每 ${input.intervalMinutes} 分钟）`}`,
      "**修改后触发同步**: 已关闭",
    ];
  }
  return [
    `**自动同步**: ${input.paused
      ? "已暂停"
      : `运行中（每 ${input.intervalMinutes} 分钟）`}`,
    `**修改后触发同步**: 本机变化后等待 ${input.changeDelaySeconds} 秒（${input.dirtyPending
      ? "已有待处理变化"
      : "当前无待处理变化"}）/ 当前状态：${input.activity}`,
  ];
}

export function projectSyncHistoryActionCounts(
  entry: {
    uploaded: number;
    downloaded: number;
    filesMoved?: number;
    foldersCreated?: number;
    foldersMoved?: number;
    foldersDeleted?: number;
    deleted: number;
  },
): SyncHistoryActionCounts {
  return {
    uploaded: entry.uploaded,
    downloaded: entry.downloaded,
    filesMoved: entry.filesMoved ?? 0,
    foldersCreated: entry.foldersCreated ?? 0,
    foldersMoved: entry.foldersMoved ?? 0,
    foldersDeleted: entry.foldersDeleted ?? 0,
    filesDeleted: entry.deleted,
  };
}

/** Build a no-I/O explanation from the same evidence used by sync planning. */
export function buildConflictEvidence(
  item: SyncPlanItem,
  base?: BaseFileEntry,
): ConflictDiagnosticEvidence {
  const equality = item.local && item.remote
    ? resolveContentEquality({ local: item.local, remote: item.remote, base })
    : { status: "unknown" as const, proof: "missingSide" };
  return {
    equalityStatus: equality.status,
    equalityProof: equality.proof,
    localHash: shortHash(item.local?.hash),
    localSize: item.local?.size,
    localMtime: item.local?.mtime,
    localQuickXor: shortOpaque(item.local?.quickXorHash),
    remoteSha256: shortHash(item.remote?.sha256Hash),
    remoteQuickXor: shortOpaque(item.remote?.quickXorHash),
    remoteSize: item.remote?.size,
    remoteMtime: item.remote?.mtime,
    remoteETag: item.remote?.eTag,
    hasDecisionToken: Boolean(item.decisionToken),
  };
}

export function findLatestPhaseSummary(
  entries: readonly DiagEntry[],
): DiagEntry | undefined {
  return [...entries].reverse().find(
    (entry) => entry.cat === "lifecycle"
      && entry.lvl === "log"
      && entry.msg === "sync run phase summary",
  );
}

export function findLatestNetworkSummary(
  entries: readonly DiagEntry[],
): DiagEntry | undefined {
  return [...entries].reverse().find(
    (entry) => entry.cat === "onedrive"
      && entry.lvl === "log"
      && entry.msg === "sync network summary",
  );
}

export function findLatestTransferSummary(
  entries: readonly DiagEntry[],
): DiagEntry | undefined {
  return [...entries].reverse().find(
    (entry) => entry.cat === "execute"
      && entry.lvl === "log"
      && entry.msg === "sync file transfer summary",
  );
}

export function findLatestAutomaticHandlingSummary(
  entries: readonly DiagEntry[],
): DiagEntry | undefined {
  return [...entries].reverse().find(
    (entry) => entry.cat === "execute"
      && entry.lvl === "log"
      && entry.msg === "sync automatic handling summary",
  );
}

const SHARED_PROTOCOL_REASONS = new Set<SharedSyncProtocolInconsistencyReason>([
  "invalid-v2",
  "unsupported-v2",
  "invalid-v3",
  "unsupported-v3",
  "v2-scope-mismatch",
  "v3-only-unbound",
  "recovery-proof-incomplete",
  "binding-mismatch",
  "generation-mismatch",
  "predecessor-mismatch",
  "target-slot-occupied",
]);

/** Read only the fixed, already-redacted protocol profile diagnostic event. */
export function findLatestSharedProtocolProfileSummary(
  entries: readonly DiagEntry[],
): SharedSyncProtocolInconsistencyEvidence | undefined {
  for (const entry of [...entries].reverse()) {
    if (
      entry.cat !== "state"
      || entry.msg !== SHARED_SYNC_PROTOCOL_PROFILE_DIAGNOSTIC_EVENT
      || !isRecord(entry.data)
      || entry.data.status !== "inconsistent"
      || typeof entry.data.reason !== "string"
      || !SHARED_PROTOCOL_REASONS.has(
        entry.data.reason as SharedSyncProtocolInconsistencyReason,
      )
      || !isGenerationSummary(entry.data.v2Generation)
      || !isGenerationSummary(entry.data.v3Generation)
      || (
        entry.data.predecessor !== "match"
        && entry.data.predecessor !== "mismatch"
        && entry.data.predecessor !== "unavailable"
      )
    ) continue;
    return {
      status: "inconsistent",
      reason: entry.data.reason as SharedSyncProtocolInconsistencyReason,
      v2Generation: entry.data.v2Generation,
      v3Generation: entry.data.v3Generation,
      predecessor: entry.data.predecessor,
    };
  }
  return undefined;
}

function isGenerationSummary(value: unknown): value is string {
  return value === "—"
    || (typeof value === "string" && /^[0-9a-f]{12}$/.test(value));
}

export interface MutationRecoverySummary {
  total: number;
  intentOnly: number;
  receiptPendingCommit: number;
  byAction: Record<MutationAction | FolderMutationActionV2, number>;
}

/** Summarize durable recovery state without exposing paths or remote IDs. */
export function summarizeMutationRecovery(
  entries: readonly MutationLedgerEntryV1[],
): MutationRecoverySummary {
  const byAction: Record<MutationAction | FolderMutationActionV2, number> = {
    upload: 0,
    download: 0,
    deleteRemote: 0,
    renameRemote: 0,
    moveLocal: 0,
    deleteLocal: 0,
    merge: 0,
    createLocalFolder: 0,
    createRemoteFolder: 0,
    moveLocalFolder: 0,
    moveRemoteFolder: 0,
    deleteLocalFolder: 0,
    deleteRemoteFolder: 0,
  };
  let intentOnly = 0;
  let receiptPendingCommit = 0;
  for (const entry of entries) {
    byAction[entry.intent.action]++;
    if (entry.receipt) receiptPendingCommit++;
    else intentOnly++;
  }
  return {
    total: entries.length,
    intentOnly,
    receiptPendingCommit,
    byAction,
  };
}

export interface CommunityPluginSyncDiagnosticSummary {
  files: {
    mode: CommunityPluginSyncPolicyV1["files"]["mode"];
    selected: number;
    ignoredOnDevice: number;
  };
  data: {
    mode: CommunityPluginSyncPolicyV1["data"]["mode"];
    selected: number;
    ignoredOnDevice: number;
  };
  inventory: {
    total: number;
    local: number;
    remote: number;
    localOnly: number;
    remoteOnly: number;
    manifestIssues: number;
  };
  remoteInventoryTrusted: boolean;
  policyFingerprint: string;
}

/** Summarize fine-grained plugin sync without exposing plugin names, IDs or data. */
export async function summarizeCommunityPluginSync(input: {
  policy: Readonly<CommunityPluginSyncPolicyV1>;
  inventory: readonly CommunityPluginInventoryItem[];
  remoteInventoryTrusted: boolean;
}): Promise<CommunityPluginSyncDiagnosticSummary> {
  const effectiveDataIgnoredIds = new Set(
    input.policy.data.ignoredPluginIds ?? [],
  );
  for (const item of input.inventory) {
    if (
      isPluginSelected(input.policy.data, item.id)
      && !isCommunityPluginDataSelected(input.policy, item.id)
    ) {
      effectiveDataIgnoredIds.add(item.id);
    }
  }
  const policyFingerprint = (
    await sha256Hex(new TextEncoder().encode(JSON.stringify({
      version: 1,
      files: {
        mode: input.policy.files.mode,
        pluginIds: [...input.policy.files.pluginIds].sort(),
        ignoredPluginIds: [
          ...(input.policy.files.ignoredPluginIds ?? []),
        ].sort(),
      },
      data: {
        mode: input.policy.data.mode,
        pluginIds: [...input.policy.data.pluginIds].sort(),
        ignoredPluginIds: [
          ...(input.policy.data.ignoredPluginIds ?? []),
        ].sort(),
      },
    })).buffer)
  ).slice(0, 12);
  return {
    files: {
      mode: input.policy.files.mode,
      selected: input.policy.files.mode === "selected"
        ? input.policy.files.pluginIds.filter(
            (pluginId) => isPluginSelected(input.policy.files, pluginId),
          ).length
        : 0,
      ignoredOnDevice: input.policy.files.ignoredPluginIds?.length ?? 0,
    },
    data: {
      mode: input.policy.data.mode,
      selected: input.policy.data.mode === "selected"
        ? input.policy.data.pluginIds.filter(
            (pluginId) =>
              isCommunityPluginDataSelected(input.policy, pluginId),
          ).length
        : 0,
      ignoredOnDevice: effectiveDataIgnoredIds.size,
    },
    inventory: {
      total: input.inventory.length,
      local: input.inventory.filter((item) => item.local).length,
      remote: input.inventory.filter((item) => item.remote).length,
      localOnly: input.inventory.filter((item) => item.local && !item.remote).length,
      remoteOnly: input.inventory.filter((item) => !item.local && item.remote).length,
      manifestIssues: input.inventory.filter((item) => item.manifestIssue).length,
    },
    remoteInventoryTrusted: input.remoteInventoryTrusted,
    policyFingerprint,
  };
}

/** Stable report-safe identity for account, drive, folder, eTag, or build values. */
export async function fingerprintOpaqueValue(value?: string): Promise<string> {
  if (!value) return "—";
  return (await sha256Hex(new TextEncoder().encode(value).buffer)).slice(0, 12);
}

/** Issue #18 round (P3-b4): attribute mid-activation input-digest drift on the
 *  device itself. The report shows which plugin data keys were recently
 *  written — key names and time only, never values (插件数据内容不进报告). */
export function computeChangedPluginDataKeys(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    const left = before[key];
    const right = after[key];
    if (left === right) continue;
    if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) {
      changed.push(key);
    }
  }
  return changed;
}

export interface PluginDataWriteRecord {
  at: number;
  keys: string[];
}

export class RecentPluginDataWriteLog {
  private readonly entries: PluginDataWriteRecord[] = [];

  constructor(private readonly capacity = 20) {}

  record(at: number, keys: string[]): void {
    this.entries.push({ at, keys: [...keys] });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  list(): readonly PluginDataWriteRecord[] {
    return [...this.entries];
  }
}

export function formatRecentPluginDataWrites(
  entries: readonly PluginDataWriteRecord[],
): string[] {
  const pad = (value: number) => String(value).padStart(2, "0");
  return entries.map(({ at, keys }) => {
    const date = new Date(at);
    const stamp = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${
      pad(date.getHours())
    }:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    return `- ${stamp} — ${keys.length > 0 ? keys.join(", ") : "(键值无净变化)"}`;
  });
}

/** Reset lineage recorded by the reset flow (survives the reset itself because
 *  it lives in the settings domain of plugin data). Lets any later report
 *  organize the device's surviving evidence: attribute logs to before/after
 *  the reset and embed the pre-reset report's core sections. */
export interface DiagnosticResetFacts {
  resetAt: number;
  variant: "normal" | "isolated" | "forced";
  /** File name (vault root) of the pre-reset report captured during that
   *  reset. Absent when the reset-time report generation failed. */
  preResetReportFile?: string;
  pluginVersion: string;
}

const DIAGNOSTIC_RESET_VARIANTS: ReadonlySet<string> = new Set([
  "normal",
  "isolated",
  "forced",
]);

export function parseDiagnosticResetFacts(value: unknown): DiagnosticResetFacts | null {
  if (!isRecord(value)) return null;
  const resetAt = value.resetAt;
  const variant = value.variant;
  const pluginVersion = value.pluginVersion;
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return null;
  if (typeof variant !== "string" || !DIAGNOSTIC_RESET_VARIANTS.has(variant)) return null;
  if (typeof pluginVersion !== "string" || pluginVersion.length === 0) return null;
  const preResetReportFile = value.preResetReportFile;
  if (preResetReportFile !== undefined && typeof preResetReportFile !== "string") return null;
  return {
    resetAt,
    variant: variant as DiagnosticResetFacts["variant"],
    ...(typeof preResetReportFile === "string" && preResetReportFile.length > 0
      ? { preResetReportFile }
      : {}),
    pluginVersion,
  };
}

/** Phase label for one log timestamp relative to the latest reset. Empty when
 *  no reset facts exist (the report keeps its pre-reset-facts shape). */
export function resetPhasePrefix(
  ts: number,
  facts: DiagnosticResetFacts | null,
): string {
  if (!facts) return "";
  return ts < facts.resetAt ? "【重置前】" : "【重置后】";
}

/** Core sections of a pre-reset report that are worth carrying into any later
 *  report: the wiped-state evidence. Anomaly logs are deliberately excluded —
 *  the disk JSONL they come from survives the reset and the current report
 *  already carries them. */
const PRE_RESET_REPORT_CORE_SECTIONS = [
  "## 当前同步概况",
  "## 技术状态证据",
  "## 近期同步记录",
  "## 当前待处理问题",
  "## 自动处理与恢复摘要",
] as const;

/** Embed ceiling for the pre-reset report excerpt. Measured basis: 8 real
 *  reports (2026-09-18~20, three test vaults) had core sections of 2,507–4,751
 *  chars; 16,000 chars keeps ~3x headroom for much heavier vaults while
 *  bounding the attachment size. */
export const PRE_RESET_REPORT_EMBED_CHAR_LIMIT = 16_000;

/** Extract the core sections of a previously generated report. Sections are
 *  matched by their stable top-level headers and run until the next top-level
 *  header (subsections ride along). Returns "" when nothing matches. */
export function extractPreResetReportCore(
  content: string,
  maxChars: number,
): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current === null) return;
    const section = buffer.join("\n").trimEnd();
    if (section.length > 0) {
      if (kept.length > 0) kept.push("");
      kept.push(section);
    }
  };
  for (const line of lines) {
    const header = PRE_RESET_REPORT_CORE_SECTIONS.find((h) => line.startsWith(h));
    if (header) {
      flush();
      current = header;
      buffer = [line];
      continue;
    }
    if (current !== null && /^## /.test(line)) {
      flush();
      current = null;
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  if (kept.length === 0) return "";
  let joined = kept.join("\n");
  if (maxChars > 0 && joined.length > maxChars) {
    joined = `${joined.slice(0, maxChars).replace(/\n[^\n]*$/, "")}\n\n*（超过嵌入上限，已截断）*`;
  }
  return joined;
}
