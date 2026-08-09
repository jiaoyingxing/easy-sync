import { sha256Hex } from "../crypto";
import type { DiagEntry } from "./diagnostic-logger";
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
    `**修改后触发同步**: 本地变化后等待 ${input.changeDelaySeconds} 秒（${input.dirtyPending
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
  enablement: { anchors: number; pending: number };
  remoteInventoryTrusted: boolean;
  policyFingerprint: string;
}

/** Summarize fine-grained plugin sync without exposing plugin names, IDs or data. */
export async function summarizeCommunityPluginSync(input: {
  policy: Readonly<CommunityPluginSyncPolicyV1>;
  inventory: readonly CommunityPluginInventoryItem[];
  remoteInventoryTrusted: boolean;
  anchors: number;
  pending: number;
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
    enablement: {
      anchors: Math.max(0, input.anchors),
      pending: Math.max(0, input.pending),
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
