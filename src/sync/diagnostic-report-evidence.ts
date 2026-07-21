import { sha256Hex } from "../crypto";
import type { DiagEntry } from "./diagnostic-logger";
import { resolveContentEquality } from "./content-equality";
import type {
  BaseFileEntry,
  MutationAction,
  MutationLedgerEntryV1,
  SyncPlanItem,
} from "./types";

const shortHash = (value?: string): string => value
  ? value.toLowerCase().slice(0, 12)
  : "—";

export interface ConflictDiagnosticEvidence {
  equalityStatus: "equal" | "different" | "unknown";
  equalityProof: string;
  localHash: string;
  localSize?: number;
  localMtime?: number;
  remoteSha256: string;
  remoteSize?: number;
  remoteMtime?: number;
  remoteETag?: string;
  hasDecisionToken: boolean;
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
    remoteSha256: shortHash(item.remote?.sha256Hash),
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
  byAction: Record<MutationAction, number>;
}

/** Summarize durable recovery state without exposing paths or remote IDs. */
export function summarizeMutationRecovery(
  entries: readonly MutationLedgerEntryV1[],
): MutationRecoverySummary {
  const byAction: Record<MutationAction, number> = {
    upload: 0,
    download: 0,
    deleteRemote: 0,
    renameRemote: 0,
    deleteLocal: 0,
    merge: 0,
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

/** Stable report-safe identity for account, drive, folder, eTag, or build values. */
export async function fingerprintOpaqueValue(value?: string): Promise<string> {
  if (!value) return "—";
  return (await sha256Hex(new TextEncoder().encode(value).buffer)).slice(0, 12);
}
