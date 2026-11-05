/**
 * Executor execution/metrics types and pure metrics helpers — moved verbatim
 * out of `sync-executor.ts` (分解刀 4, pure move + export). `sync-executor.ts`
 * imports every member; no shape, default value or comment changed.
 */

import type {
  BaseFileEntry,
  MutationIntent,
  MutationReceiptV1,
  RemoteFileEntry,
  SyncActionType,
  SyncPlanItem,
} from "./types";
import type {
  MutationCheckpointCommitMetrics,
  PendingIssue,
} from "./state-manager";
import type { AutomaticHandlingPolicy } from "./automatic-handling-policy";
import type { DownloadConcurrencyPolicy } from "./download-concurrency-policy";
import type { UploadConcurrencyPolicy } from "./upload-concurrency-policy";

export interface PreparedDownload {
  content?: ArrayBuffer;
  downloaded?: { size: number; hash: string };
  error?: unknown;
}

export interface FileTransferMetrics {
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  logicalBytes: number;
  /** Busy wall clock of this direction: only the time during which at least
   *  one transfer of the direction was moving (or signalling) bytes. Whole-body
   *  transports book their call window — their only byte report lands after
   *  the payload already moved. Concurrent calls overlap, so this is the
   *  honest denominator for a combined throughput — the sum of their own
   *  durations would report the link divided by the pool depth. */
  busyMs: number;
  activeConcurrency: number;
  peakConcurrency: number;
  stagesMs: {
    sourceRead: number;
    contentTransfer: number;
    contentHash: number;
    remoteVersionVerify: number;
    localVersionGuard: number;
    localCommit: number;
  };
}

/** Byte-level progress of one transport call still in flight, kept so the
 *  connection-speed sampler sees movement before the file-level ledger
 *  accrues. `startedAt` is the first nonzero byte event: session setup and
 *  first-byte latency are not transfer time. */
export interface InFlightTransfer {
  direction: "upload" | "download";
  bytesSoFar: number;
  startedAt: number;
}

type AutomaticMergeManualReason =
  | "missing-version"
  | "binary-file"
  | "unsupported-text-path"
  | "protected-config"
  | "ancestor-unavailable"
  | "ancestor-unverified"
  | "local-version-changed"
  | "remote-version-changed"
  | "stale-version"
  | "recovery-pending"
  | "invalid-hash"
  | "invalid-utf8"
  | "mixed-line-endings"
  | "too-large"
  | "overlap"
  | "remote-committed-local-pending"
  | "execution-failed";

export interface AutomaticHandlingMetrics {
  policy: AutomaticHandlingPolicy;
  deleteLocal: {
    candidates: number;
    completed: number;
    failed: number;
  };
  textMerge: {
    candidates: number;
    completed: number;
    keptManual: number;
    failed: number;
    cancelled: number;
    manualReasons: Partial<Record<AutomaticMergeManualReason, number>>;
  };
  mergeRecovery: {
    records: number;
    receiptCommitted: number;
    notApplied: number;
    remoteCommittedLocalRecovered: number;
    remoteCommittedLocalPending: number;
    unresolved: number;
  };
  recoveryPendingAtEnd: {
    deleteLocal: number;
    merge: number;
  };
}

export interface ExecutionMetrics {
  uploadBytes: number;
  uploadReadMs: number;
  activeUploads: number;
  peakUploads: number;
  fileTransfers: {
    upload: FileTransferMetrics;
    download: FileTransferMetrics;
  };
  mutationPersistence: MutationPersistenceMetrics;
  automaticHandling: AutomaticHandlingMetrics;
}

interface MutationPersistenceMetrics {
  intentWrites: number;
  receiptWrites: number;
  /** Logical mutation receipts covered by successful checkpoint commits. */
  checkpointOperations: number;
  /** Physical V2 checkpoint commits, after any safe batching. */
  checkpointCommits: number;
  checkpointFailures: number;
  stagesMs: {
    intentPersist: number;
    receiptPersist: number;
    checkpointAncestorPublish: number;
    checkpointV2Commit: number;
    checkpointLedgerClear: number;
    checkpointTotal: number;
  };
}

export type SyncRunPhase =
  | "recovery"
  | "scan"
  | "remotePrepare"
  | "baseline"
  | "remoteChanges"
  | "planning"
  | "reviewWait"
  | "transfer"
  | "commit";

export type SyncRunPhaseDurations = Record<SyncRunPhase, number>;

export function createFileTransferMetrics(): FileTransferMetrics {
  return {
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    logicalBytes: 0,
    busyMs: 0,
    activeConcurrency: 0,
    peakConcurrency: 0,
    stagesMs: {
      sourceRead: 0,
      contentTransfer: 0,
      contentHash: 0,
      remoteVersionVerify: 0,
      localVersionGuard: 0,
      localCommit: 0,
    },
  };
}

export function createMutationPersistenceMetrics(): MutationPersistenceMetrics {
  return {
    intentWrites: 0,
    receiptWrites: 0,
    checkpointOperations: 0,
    checkpointCommits: 0,
    checkpointFailures: 0,
    stagesMs: {
      intentPersist: 0,
      receiptPersist: 0,
      checkpointAncestorPublish: 0,
      checkpointV2Commit: 0,
      checkpointLedgerClear: 0,
      checkpointTotal: 0,
    },
  };
}

export function recordCheckpointMetrics(
  target: MutationPersistenceMetrics,
  detail: MutationCheckpointCommitMetrics | undefined,
  elapsedMs: number,
): void {
  target.checkpointCommits++;
  target.checkpointOperations += detail?.operations ?? 1;
  target.stagesMs.checkpointTotal += detail?.totalMs ?? elapsedMs;
  target.stagesMs.checkpointAncestorPublish += detail?.ancestorPublishMs ?? 0;
  target.stagesMs.checkpointV2Commit += detail?.v2CommitMs ?? 0;
  target.stagesMs.checkpointLedgerClear += detail?.ledgerClearMs ?? 0;
}

export interface DeferredMutationCompletion {
  operationId: string;
  path: string;
  actionType: SyncActionType;
  reason?: string;
  fileSize?: number;
  renameFrom?: string;
}

/** One persisted batch's shared bookkeeping (cleanup wave, upload batch):
 *  every member's mutation intent is already durable (pre-written by the
 *  batch), receipts are collected instead of written per file, and the batch
 *  commits one checkpoint for all of them. `intent === null` keeps that member
 *  on the ordinary per-file path. */
export interface CleanupWaveHandoff {
  intent: MutationIntent | null;
  receipts: MutationReceiptV1[];
}

/** One small upload's transfer evidence, filled by `executeUploadItem` and
 *  read by the adaptive upload pool right after the item settles.
 *
 *  The pool owns the record and stamps the depth the file was served at; the
 *  transfer path only writes what it alone knows (how long the PUT itself
 *  took, and whether the failure was a rate limit). Only the pool passes one:
 *  every other upload path (large files, manual single-item runs) leaves it
 *  undefined and pays nothing. */
export interface UploadTransferObservation {
  bytes: number;
  /** `contentTransfer` duration of the settled PUT, in ms. */
  transferMs: number;
  /** `none` = the item settled without a PUT (preflight, conflict, cancel):
   *  no throughput sample and no failure streak entry. */
  outcome: "none" | "success" | "failure";
  /** The failure was a 429/509 that survived the request-level retry budget. */
  throttled: boolean;
  /** Retry-After of that rate limit; `null` when the response carried none. */
  retryAfterSeconds: number | null;
}

/** Shared per-run execution state for `executePlan`'s phase methods: the
 *  counters, ledger containers, pools, policies and folder predicates one
 *  plan round threads through its sequential phases, upload pools, download
 *  window, cleanup waves and the folder-delete + finalize phase. Built once
 *  at the start of the run; phase methods mutate it in place. Internal to
 *  this module — never exported. */
export interface ExecutionPhaseState {
  /** Wall-clock start of the run (upload summary elapsed time). */
  startedAt: number;
  /** Progress denominator: only items that produce actions (2026-10-25). */
  total: number;
  /** Settled (finished) plan items — the visible progress counter. */
  settled: number;
  pendingConflicts: SyncPlanItem[];
  pendingDeletes: SyncPlanItem[];
  pendingIssues: PendingIssue[];
  resolvedIssuePaths: Set<string>;
  skipBaseline: Set<string>;
  settledSkipPaths: Set<string>;
  skipDeltaDisabled: boolean;
  remoteUpserts: RemoteFileEntry[];
  remoteDeletes: string[];
  baseUpserts: BaseFileEntry[];
  baseRemovals: string[];
  metrics: ExecutionMetrics;
  uploadPolicy: UploadConcurrencyPolicy;
  downloadPolicy: DownloadConcurrencyPolicy;
  folderCreates: SyncPlanItem[];
  folderMoves: SyncPlanItem[];
  folderDeletes: SyncPlanItem[];
  smallUploads: SyncPlanItem[];
  largeUploads: SyncPlanItem[];
  downloads: SyncPlanItem[];
  cleanupItems: SyncPlanItem[];
  passthroughItems: SyncPlanItem[];
  isFolderCreate: (candidate: SyncPlanItem) => boolean;
  isFolderMove: (candidate: SyncPlanItem) => boolean;
  isFolderDelete: (candidate: SyncPlanItem) => boolean;
}

/** One cleanup wave's per-DELETE duration distribution (rounded ms). Nearest
 *  rank on the sorted samples, so p95 >= p50 by construction. Observability
 *  only: nothing branches on these numbers. */
interface LatencySummaryMs {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export function summarizeLatencyMs(samples: readonly number[]): LatencySummaryMs {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (percentile: number): number => {
    const rank = Math.ceil((percentile / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
  };
  return {
    count: sorted.length,
    p50: Math.max(0, Math.round(at(50))),
    p95: Math.max(0, Math.round(at(95))),
    max: Math.max(0, Math.round(sorted[sorted.length - 1])),
  };
}

export function createAutomaticHandlingMetrics(
  policy: Readonly<AutomaticHandlingPolicy>,
): AutomaticHandlingMetrics {
  return {
    policy: { ...policy },
    deleteLocal: {
      candidates: 0,
      completed: 0,
      failed: 0,
    },
    textMerge: {
      candidates: 0,
      completed: 0,
      keptManual: 0,
      failed: 0,
      cancelled: 0,
      manualReasons: {},
    },
    mergeRecovery: {
      records: 0,
      receiptCommitted: 0,
      notApplied: 0,
      remoteCommittedLocalRecovered: 0,
      remoteCommittedLocalPending: 0,
      unresolved: 0,
    },
    recoveryPendingAtEnd: {
      deleteLocal: 0,
      merge: 0,
    },
  };
}

export function recordAutomaticMergeManual(
  metrics: AutomaticHandlingMetrics,
  reason: AutomaticMergeManualReason,
): null {
  metrics.textMerge.keptManual++;
  metrics.textMerge.manualReasons[reason] =
    (metrics.textMerge.manualReasons[reason] ?? 0) + 1;
  return null;
}
