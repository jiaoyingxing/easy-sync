/**
 * Executor recovery / classification parameter and result types — moved
 * verbatim out of `sync-executor.ts` (分解刀 4, pure move + export).
 * `sync-executor.ts` imports every member; no shape or comment changed.
 *
 * 分解残余（有意记录）：方案点名的恢复/分类类型里，凡签名引用了留在
 * sync-executor 的门面或内部符号（SyncResult、SyncCallbacks、SyncRunOptions、
 * SyncMode、ItemExecutionResult、SharedSyncProtocol* 族、SyncExecutor 类本体、
 * resolveBatchMetadataClient）的都留在原地，避免新模块反向 import
 * sync-executor 成环——见本轮收尾报告的去向对照表。
 */

import type {
  OneDriveError,
  SharedSyncProtocolObservationComponent,
} from "../onedrive/types";
import type {
  BaseFileEntry,
  FolderMutationIntentV2,
  MutationCheckpointV1,
  SyncPlan,
  SyncPlanItem,
  SyncScope,
} from "./types";
import type {
  CanonicalPlanCandidateV2,
  FinalizedCanonicalPlanV2,
} from "./canonical-plan-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";
import type { StateManager } from "./state-manager";
import type { AutomaticHandlingPolicy } from "./automatic-handling-policy";
import type {
  FolderLocationResolutionChoiceV1,
  FolderLocationResolutionSnapshotV1,
  FolderSubtreeReviewSnapshotV1,
} from "./empty-folder-resolution";
import type { buildRemoteIndexV2 } from "./remote-index-v2";

export interface RetryableObservationDisposition {
  kind: "retryable-observation";
  phase: "remotePrepare";
  code:
    | "shared-control-read-unavailable"
    | "ordinary-remote-read-unavailable";
  retry: "next-sync";
  component:
    | SharedSyncProtocolObservationComponent
    | "ordinary-remote";
}

export type SyncRunDisposition = RetryableObservationDisposition;

/** Monotonic execution facts owned by the executor. Presentation and
 * scheduling must not reconstruct these facts from aggregate counters. */
export type RetryableObservationResultClassification =
  | { kind: "absent" }
  | { kind: "valid"; disposition: RetryableObservationDisposition }
  | { kind: "contradictory"; disposition: RetryableObservationDisposition };

export type SideActionPreparationPhase =
  | "localRecovery"
  | "remotePrepare"
  | "scopeValidation"
  | "mutationRecovery"
  | "action";

export type SideMutationRecoveryOutcome = "applied" | "not-applied" | "unresolved";
export interface SideMutationRecoveryResult {
  outcome: SideMutationRecoveryOutcome;
  retryableObservationError: OneDriveError | null;
}

export type FinalizeCanonicalContentVerificationArgs = {
  plan: SyncPlan;
  canonicalPlanCandidate: CanonicalPlanCandidateV2 | null;
  migrationCandidateEnvelope: SyncStateEnvelopeV2 | null;
  v2PlanState: StateManager & {
    getCommittedV2Envelope?: StateManager["getCommittedV2Envelope"];
  };
  verifiedFirstSyncRemoteHashesById: ReadonlyMap<string, string>;
  automaticHandlingPolicy: AutomaticHandlingPolicy;
  baselineReconstructionIncomplete: boolean;
  resolveCanonicalRemoteContentHash: (
    item: Readonly<SyncPlanItem>,
    progress: { current: number; total: number },
    resetProgressPhase?: boolean,
  ) => Promise<string>;
  refreshVerificationDownloadUrls: (
    items: ReadonlyArray<SyncPlanItem>,
  ) => Promise<void>;
};

export type FinalizeCanonicalContentVerificationOutcome = {
  finalizedCanonicalPlan: FinalizedCanonicalPlanV2 | null;
  canonicalPlanCandidate: CanonicalPlanCandidateV2 | null;
  canonicalFinalizationEnvelope: SyncStateEnvelopeV2 | null;
  contentEqualityBaseUpserts: BaseFileEntry[];
};

export type CreateFolderMutationIntentArgs = {
  item: SyncPlanItem;
  scope: SyncScope;
};

export type CreateFolderMutationIntentOutcome =
  | { terminated: FolderMutationIntentV2 }
  | { terminated: null };

export type PersistedMutationRecoveryAccumulatorState = {
  hierarchyRefreshedForRecovery: boolean;
  reflectedCheckpointRetirementCommitSeq: number | undefined;
  settled: number;
  applied: number;
  notApplied: number;
  receiptCommitted: number;
  quarantined: number;
  externalMutations: number;
};

export type SettlePersistedManualMutationResolutionOutcome =
  | { terminated: PersistedMutationRecoveryAccumulatorState }
  | { terminated: null; settled: number; externalMutations: number };

export type CommitReviewedFolderLocationResolutionArgs = {
  intent: FolderMutationIntentV2;
  operationEpoch: number;
  current: FolderLocationResolutionSnapshotV1;
  item: SyncPlanItem;
  choice: FolderLocationResolutionChoiceV1;
};

export type CommitReviewedFolderLocationResolutionOutcome = {
  resolved: boolean;
  value: boolean | undefined;
};

export type CommitReviewedFolderSubtreeDeletionArgs = {
  intent: FolderMutationIntentV2;
  operationEpoch: number;
  current: FolderSubtreeReviewSnapshotV1;
  root: FolderSubtreeReviewSnapshotV1["members"][number];
};

export type CommitReviewedFolderSubtreeDeletionOutcome = {
  deleted: boolean;
  value: boolean | undefined;
};

export type CommitReviewedRemoteDownloadTransferArgs = {
  path: string;
  queuedConflict: SyncPlanItem;
  operationEpoch: number;
  transferState: { targetMutationStarted: boolean };
};

export type CommitReviewedRemoteDownloadTransferOutcome = {
  content: ArrayBuffer | null;
  checkpoint: MutationCheckpointV1;
};

export type ConfirmPendingFolderRemoteDeleteArgs = {
  path: string;
  pending: SyncPlanItem | undefined;
  operationEpoch: number;
  options: { preverifiedAbsent?: boolean } | undefined;
  showSuccessNotice: boolean;
};

export type ConfirmPendingFolderRemoteDeleteOutcome =
  | { handled: true; value: boolean | undefined }
  | { handled: false };

export type SettleAppliedMutationRecoveryOutcome =
  | { cancelled: true; transferOutcome: "cancelled" | null }
  | { cancelled: false; transferOutcome: "succeeded" | "failed" | "cancelled" | "skipped" | null };

export type V2ScopeRecoveryVerificationCandidate = {
  node: ReturnType<typeof buildRemoteIndexV2>["index"]["itemsById"][string];
  path: string;
};

export type RejectRemoteDeleteFolderArgs = {
  pending: SyncPlanItem;
  path: string;
  operationEpoch: number;
};

export type RejectRemoteDeleteFolderOutcome =
  | { handled: true; value: boolean | undefined }
  | { handled: false };

/** Committed facts a recycle-bin restore can be checked against without
 *  downloading the restored bytes. Built only when every fact is present. */
export type RestoreFastPathPlan = {
  remoteId: string;
  remoteCTag: string;
  anchorHash: string;
  anchorSize: number;
  anchorETag: string | undefined;
  expectedParentId: string;
  expectedName: string;
};

export type RestoreFastPathOutcome =
  /** Proof succeeded: no upload, commit this checkpoint. */
  | { kind: "restored"; checkpoint: MutationCheckpointV1 }
  /** Continue with the ordinary upload; `restored` targets the restored item. */
  | { kind: "upload"; restored?: { driveItemId: string; eTag: string } }
  /** Restore provably did not land: abandon the intent, keep the row. */
  | { kind: "abandon" }
  /** Restore may have landed but could not be verified: keep the intent for
   *  mutation recovery instead of uploading (a duplicate is worse). */
  | { kind: "unresolved"; error: Error };
