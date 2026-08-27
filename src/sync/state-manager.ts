/**
 * StateManager — Sync state persistence and recovery
 *
 * Manages the three snapshots (local, remote, base) and pending
 * conflict/delete lists. Uses Obsidian plugin data API for persistence.
 *
 * Key design: Per-file immediate persistence.
 * After each file operation succeeds, update baseSnapshot immediately.
 * On interruption, the next sync round naturally handles remaining diffs.
 */

import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";
import {
  getEasySyncPaths,
  getEasySyncLegacyPaths,
  getConfigDir,
  isRecord,
  isStringRecord,
} from "../obsidian-compat";
import {
  ensureEasySyncRuntimeLayoutMigration,
  clearEasySyncLegacyRuntimeLayout,
  noteHealthySyncAndCleanupEasySyncRuntimeLayout,
  type EasySyncLayoutMigrationStorage,
} from "./runtime-layout-migration";
import { AncestorStoreV2 } from "./ancestor-store-v2";
import {
  migrateLegacyCommunityPluginParticipation,
  readDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationCommand,
  type DeviceCommunityPluginParticipationV1,
  type LegacyCommunityPluginParticipationMigrationInput,
} from "./community-plugin-participation";
import {
  isFolderPathInSyncScopeSnapshot,
  readFolderSyncScopeSnapshotV1,
  type FolderSyncScopeSnapshotV1,
} from "./local-scanner";
import {
  attachBaseAncestorHashesV2,
  projectStatePathViewV2,
  removeBaseStateEnvelopeV2,
  replaceBaseStateEnvelopeV2,
  replaceRemoteStateEnvelopeV2,
  upsertBaseStateEnvelopeV2,
  type StatePathViewV2,
} from "./file-state-controller-v2";
import {
  inspectReceiptedRenameAnchorCollisionV2,
  reduceFileStateEnvelopeV2,
} from "./file-state-reducer-v2";
import { projectRemoteIndexV2 } from "./remote-index-v2";
import {
  areIndependentConservativeResetRecords,
  conservativeResetRecordPaths,
  conservativeResetRecordRemoteIds,
  isConservativeResetOrdinaryRecord,
  isOrdinaryFileRecoveryRecord,
} from "./conservative-reset-recovery";
import {
  acceptConfirmedDescendantFolderAnchorsV2,
  acceptScopeExpansionFolderAnchorsV2,
  isFolderMutationIntent,
  reduceFolderStateEnvelopeV2,
  type ConfirmedDescendantFolderRejectionReasonV2,
} from "./folder-state-reducer-v2";
import type {
  SharedFolderIdentityResolutionSnapshotV1,
} from "./shared-folder-identity-resolution";
import {
  retireReviewedStaleIdentityV2,
  type StaleIdentityResolutionSnapshotV1,
} from "./stale-identity-resolution";
import {
  acceptReviewedFolderSubtreeRestoreV2,
  type FolderSubtreeReviewSnapshotV1,
} from "./empty-folder-resolution";
import {
  StateEnvelopeV2LoadError,
  StateEnvelopeV2Store,
  validateEnvelope,
  type RemoteScopeRecoveryV2,
  type FolderAnchorV2,
  type SyncAnchorV2,
  type StateEnvelopeV2CorruptionEvidence,
  type StateEnvelopeV2CorruptionKind,
  type StateEnvelopeV2LoadFailureReason,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  sameStateV2AuthorityManifest,
  StateV2AuthorityWitnessLoadError,
  StateV2AuthorityWitnessStore,
  type StateV2IndexedDbStorageAuthority,
  type StateV2AuthorityWitness,
  type StateV2AuthorityWitnessLoadFailureReason,
} from "./state-v2-authority-witness";
import {
  deriveStateV2ActiveIndexedDbDatabaseId,
  StateV2IndexedDbActiveStateError,
  type StateV2IndexedDbActiveStore,
} from "./state-v2-indexeddb-active";
import {
  StateV2IndexedDbRecoveryStore,
  stateV2IndexedDbRecoveryEnvelopeDigest,
} from "./state-v2-indexeddb-recovery";
import { isIndexedDbVaultInstanceId } from "./indexeddb-vault-namespace";
import {
  StateV2ScopeTransitionError,
  StateV2ScopeTransitionStore,
  type StateV2ScopeTransitionFailureReason,
} from "./state-v2-scope-transition";
import {
  retainFileProgress,
  type FileProgress,
  type RemoteScopeRecoveryVerificationSummary,
} from "./sync-progress";
import {
  commitReviewedStateV2MigrationCandidate,
  readStateV2Manifest,
  sameStateV2MigrationCandidate,
  StateV2ManifestLoadError,
  type StateV2Manifest,
  type StateV2ManifestLoadFailureReason,
  type StateV2MigrationResult,
} from "./state-v2-migration";
import {
  isActiveMigrationHoldV2,
  migrationHoldReviewKindV2,
  MigrationHoldV2Store,
  type MigrationHoldV2,
} from "./migration-hold-v2";
import {
  CorruptStateRecoveryHoldV2Store,
  type CorruptStateRecoveryHoldV2,
} from "./corrupt-state-recovery-hold-v2";
import {
  CorruptStatePublicationV2Error,
  CorruptStatePublicationV2Store,
  type CorruptStatePublicationV2FailureReason,
} from "./corrupt-state-publication-v2";
import {
  type SharedSyncProtocolBinding,
} from "./sync-protocol-v3";
import {
  isSharedSyncProtocolBindingV2,
  type SharedSyncProtocolBindingV2,
} from "./sync-protocol-v2";
import {
  remoteScopeRecoveryProtocolBindingDigest,
  type FirstSyncVerificationEvidenceOperationV2,
  type RemoteScopeRecoveryEvidenceOperationV1,
  type RemoteScopeRecoveryEvidenceReceiptV1,
  type RemoteScopeRecoveryEvidenceStore,
  type RemoteScopeRecoveryEvidenceStoreFactory,
  type RemoteScopeRecoveryEvidenceSummaryV1,
  type RemoteScopeRecoveryRemoteVersionV1,
} from "./remote-scope-recovery-evidence-store";
import {
  createPublic113BackupSnapshot,
  createPublic113MigrationInput,
  public113BackupSnapshotDigest,
  public113MigrationInputDigest,
  type Public113MigrationInput,
} from "./public-1-1-3-state-import";
import {
  finalizePublic113PluginDataCutover,
  KEY_PUBLIC_113_CUTOVER,
  readPublic113CutoverMarker,
  type Public113CutoverMarkerV2,
} from "./public-1-1-3-cutover";
import {
  readCloudBootstrapPublicationCheckpointV2,
  type CloudBootstrapPublicationCheckpointV2,
} from "./cloud-bootstrap-v2";
import {
  readCommunityPluginManifestObservations,
  type CommunityPluginManifestObservationV1,
} from "./community-plugin-bundle";
import {
  readRemoteCommunityPluginCatalog,
  type RemoteCommunityPluginCatalogV1,
} from "./community-plugin-remote-catalog";
import type {
  Public113IndexedDbCandidateStoreFactory,
} from "./indexeddb-public-1-1-3-state";
import type {
  CanonicalPlannerStateV2,
} from "./canonical-planner-state-v2";
import { LocalRecoveryJournal } from "./local-recovery-journal";
import { MergeReadyStore } from "./merge-ready-store";

/** M14: minimal plugin-data store contract — EasySyncPlugin satisfies this. */
export interface PluginDataStore {
  loadData(): Promise<Record<string, unknown> | null>;
  updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void>;
  app: { vault: { adapter: DataAdapter; configDir: string } };
  layoutMigrationStorage?: EasySyncLayoutMigrationStorage;
  manifest: { dir?: string; id: string };
  indexedDbVaultInstanceId?: string;
  readIndexedDbVaultInstanceId?: () => string | null;
  createPublic113IndexedDbCandidateStore?:
    Public113IndexedDbCandidateStoreFactory;
  createStateV2IndexedDbActiveStore?: (
    databaseId: string,
    recovery: StateV2IndexedDbRecoveryStore,
  ) => StateV2IndexedDbActiveStore;
  createRemoteScopeRecoveryEvidenceStore?:
    RemoteScopeRecoveryEvidenceStoreFactory;
}

export interface MutationCheckpointCommitMetrics {
  operations: number;
  ancestorPublishMs: number;
  v2CommitMs: number;
  ledgerClearMs: number;
  totalMs: number;
}

export type V2StateLoadBlockReason =
  | StateEnvelopeV2LoadFailureReason
  | StateV2ManifestLoadFailureReason
  | StateV2AuthorityWitnessLoadFailureReason
  | StateV2ScopeTransitionFailureReason
  | CorruptStatePublicationV2FailureReason
  | "authority-witness-manifest-missing"
  | "authority-witness-mismatch"
  | "authority-witness-save-failed"
  | "legacy-v2-downgrade-artifacts-present"
  | "manifest-presence-unreadable"
  | "manifest-disappeared"
  | "manifest-envelope-missing"
  | "manifest-envelope-behind"
  | "indexeddb-authority-load-failed"
  | "indexeddb-authority-recovery-failed"
  | "migration-authority-commit-interrupted"
  | "migration-hold-unreadable"
  | "envelope-remote-index-corrupt"
  | "envelope-anchors-corrupt"
  | "envelope-remote-index-and-anchors-corrupt"
  | "corrupt-state-recovery-hold-unreadable"
  | "corrupt-state-recovery-hold-mismatch"
  | "public-1.1.3-cutover-backup-unreadable"
  | "public-1.1.3-cutover-marker-mismatch"
  | "public-1.1.3-cutover-finalization-failed"
  | "v2-mutation-ledger-migration-failed"
  | "v2-state-load-failed";

export interface V2StateLoadBlock {
  version: 2;
  kind: "v2-state-load-block";
  authority: "v2" | "v1-precommit" | "unknown";
  reason: V2StateLoadBlockReason;
  detectedAt: number;
  detail?: string;
}
import {
  type LocalFileEntry,
  type LocalFolderEntry,
  type RemoteFileEntry,
  type RemoteFolderEntry,
  type BaseFileEntry,
  type SyncPlanItem,
  type SyncDecisionToken,
  type PlanReviewCounts,
  type PlanReviewItem,
  type RemoteSyncState,
  type SyncScope,
  type PlanReviewAuthorization,
  type CanonicalPlanIdentityV2,
  type MutationIntent,
  type MutationIntentV1,
  type MutationReceiptV1,
  type MutationLedgerEntryV1,
  type ManualMutationResolutionV1,
  type CommunityPluginBundleSettlementV2,
  type ManualMutationResolutionAuditV1,
  type ReceiptedRenameAnchorCollisionEvidenceV1,
  type MutationRecoveryHistory,
  type SyncRunFacts,
  type LocalFolderMoveHintV1,
  type V2ActivationReviewKind,
  SyncActionType,
  planDigest,
  sameCanonicalPlanIdentityV2,
  sameSyncScope,
} from "./types";
import { BaseContentCache, isTextFile } from "./base-content-cache";

export class SyncPathMutationRecoveryError extends Error {
  constructor(message = "Cannot change sync paths while mutation recovery is unresolved") {
    super(message);
    this.name = "SyncPathMutationRecoveryError";
  }
}

/** Exact recovery evidence cannot be reduced to the conservative reset capsule. */
export class ConservativeResetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConservativeResetBlockedError";
  }
}

export interface StateV2PreparedActivationInput {
  candidate: SyncStateEnvelopeV2;
  canonicalIdentity: CanonicalPlanIdentityV2;
  source: Public113MigrationInput;
  purpose?: "zero-plan" | "legacy-mutation-recovery";
  now?: number;
}

export interface SyncExclusionFolderSnapshot {
  hadPendingReview: boolean;
  remoteFolderPaths: string[];
}

export interface SyncScopeExpansionMarkerV1 {
  version: 1;
  kind: "sync-scope-expansion";
  revision: number;
  previousSettingsFingerprint: string;
  targetSettingsFingerprint: string;
  source: {
    scope: SyncScope;
    commitSeq: number;
    lifecycleEpoch: number;
    anchorFingerprint: string;
  };
  folders: RemoteFolderEntry[];
  folderScopeTransition?: {
    previous: FolderSyncScopeSnapshotV1;
    target: FolderSyncScopeSnapshotV1;
  };
  requiresCompleteRemoteIdentitySnapshot: boolean;
  createdAt: number;
}

export interface SyncPathSettingsScopeChangeV1 {
  previousSettingsFingerprint: string;
  targetSettingsFingerprint: string;
  expandedFolderPaths: readonly string[];
  /** All source folder paths that remain in the final settings scope. */
  includedFolderPaths?: readonly string[];
  folderScopeTransition?: {
    previous: FolderSyncScopeSnapshotV1;
    target: FolderSyncScopeSnapshotV1;
  };
  requiresCompleteRemoteIdentitySnapshot?: boolean;
  retireLocalFolderMoveHintRemoteIds?: readonly string[];
  /** Exact unresolved uploads retained until this narrower scope is durable. */
  retainedMutationRecoveryScopeExit?: readonly Readonly<
    MutationLedgerEntryV1
  >[];
  now?: number;
}

export type SyncScopeExpansionPreparation =
  | { status: "none" }
  | { status: "blocked"; revision: number }
  | { status: "ready"; revision: number };

export type SyncScopeExpansionAcceptance =
  | { status: "none" | "blocked" | "stale"; accepted: 0 }
  | { status: "accepted"; accepted: number };

export type ReviewedSharedFolderIdentityAcceptance =
  | { status: "blocked" | "stale"; accepted: 0 }
  | { status: "accepted"; accepted: number };

export type ReviewedStaleIdentityRetirement =
  | {
      status: "blocked" | "stale";
      retiredFileAnchors: 0;
      retiredFolderAnchors: 0;
    }
  | {
      status: "accepted";
      retiredFileAnchors: number;
      retiredFolderAnchors: number;
    };

export type ReviewedFolderSubtreeRestoreAcceptance =
  | {
      status: "blocked" | "stale";
      retiredFileAnchors: 0;
      retiredFolderAnchors: 0;
    }
  | {
      status: "accepted";
      retiredFileAnchors: number;
      retiredFolderAnchors: number;
    };

export type ConfirmedDescendantFolderAcceptance =
  | { status: "none" | "blocked"; accepted: 0; evidenceFiles: 0 }
  | {
      status: "rejected";
      reason: ConfirmedDescendantFolderRejectionReasonV2;
      accepted: 0;
      evidenceFiles: 0;
    }
  | { status: "accepted"; accepted: number; evidenceFiles: number };

export type ConfirmedDescendantFileEvidenceAcceptance =
  | { status: "none" | "blocked"; accepted: 0 }
  | { status: "accepted"; accepted: number };

export interface ConfirmedDescendantFileReconstructionRootV1 {
  path: string;
  remoteId: string;
  confirmedGeneration: number;
}

export interface ConfirmedDescendantFileReconstructionCheckpointV1 {
  version: 1;
  kind: "confirmed-descendant-file-reconstruction";
  scope: SyncScope;
  lifecycleEpoch: number;
  sourceCommitSeq: number;
  roots: ConfirmedDescendantFileReconstructionRootV1[];
  startedAt: number;
}

export type ConfirmedDescendantFileReconstructionPreparation =
  | { status: "none" | "blocked"; roots: [] }
  | {
      status: "ready";
      roots: ConfirmedDescendantFileReconstructionRootV1[];
    };

interface V2MigrationAuthorizationInput {
  authorization: PlanReviewAuthorization;
  candidate: SyncStateEnvelopeV2;
  canonicalIdentity: CanonicalPlanIdentityV2;
}

export interface MutationRecoveryQuarantineEntryV2 {
  version: 2;
  kind: "mutation-recovery-quarantine";
  operationId: string;
  reason: "receipted-upload-version-unreachable";
  quarantinedAt: number;
  scope: SyncScope;
  sourceCommitSeq: number;
  remoteId: string;
  evidence: {
    localMissing: true;
    completeRemoteIndex: true;
    remotePathMissing: true;
    remoteIdMissing: true;
    graphItemMissing: true;
  };
  record: MutationLedgerEntryV1;
}

export interface Public113AncestorPreparation {
  hashesByPath: Readonly<Record<string, string>>;
  sourceEntries: number;
  published: number;
  rejected: number;
  unavailable: number;
}

/** Plugin data keys for state persistence */
const KEY_BASE_SNAPSHOT = "easy-sync-base-snapshot";
const KEY_PENDING_CONFLICTS = "easy-sync-pending-conflicts";
const KEY_PENDING_DELETES = "easy-sync-pending-remote-deletes";
const KEY_PENDING_ISSUES = "easy-sync-pending-issues";
const KEY_LAST_SYNC_TIME = "easy-sync-last-sync-time";
const KEY_PLAN_REVIEW_ACTIVE = "easy-sync-plan-review-active";
const KEY_PLAN_REVIEW_COUNTS = "easy-sync-plan-review-counts";
const KEY_PLAN_REVIEW_ITEMS = "easy-sync-plan-review-items";
const KEY_PLAN_REVIEW_DIGEST = "easy-sync-plan-review-digest";
const KEY_PLAN_REVIEW_REVISION = "easy-sync-plan-review-revision";
const KEY_PLAN_REVIEW_SCOPE = "easy-sync-plan-review-scope";
const KEY_PLAN_REVIEW_CANONICAL_IDENTITY =
  "easy-sync-plan-review-canonical-identity-v2";
const KEY_SYNC_HISTORY = "easy-sync-history";
const KEY_GENERATION = "easy-sync-generation";
const KEY_BOUND_ACCOUNT = "easy-sync-bound-account";
const KEY_PUBLIC_MUTATION_LEDGER = "easy-sync-mutation-ledger";
const KEY_MUTATION_LEDGER = "easy-sync-v2-mutation-ledger";
const KEY_MANUAL_MUTATION_RESOLUTION_AUDIT =
  "easy-sync-v2-manual-mutation-resolution-audit";
const KEY_V2_RECOVERY_QUARANTINE = "easy-sync-v2-recovery-quarantine";
const KEY_LOCAL_FOLDER_MOVE_HINTS = "easy-sync-local-folder-move-hints";
const KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE = "community-plugin-enablement-state";
const KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS =
  "community-plugin-manifest-observations";
const KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG =
  "remote-community-plugin-catalog";
const KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2 =
  "easy-sync-cloud-bootstrap-checkpoint-v2";
const KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION =
  "easy-sync-confirmed-descendant-file-reconstruction";
const KEY_SYNC_PATH_SETTINGS_REVISION =
  "easy-sync-sync-path-settings-revision";
const KEY_SYNC_PATH_SETTINGS_FINGERPRINT =
  "easy-sync-sync-path-settings-fingerprint";
const KEY_SYNC_SCOPE_EXPANSION =
  "easy-sync-sync-scope-expansion";
export type SyncHistoryStatus = "success" | "partial" | "cancelled" | "authExpired" | "failed";

export interface SyncHistoryEntry {
  id: string;
  mode: "manual" | "auto" | "first";
  status: SyncHistoryStatus;
  startedAt: number;
  endedAt: number;
  uploaded: number;
  downloaded: number;
  foldersCreated?: number;
  foldersMoved?: number;
  foldersDeleted?: number;
  filesMoved?: number;
  deleted: number;
  conflicts: number;
  deferred?: number;
  skipped: number;
  skippedLarge?: number;
  skippedIgnored?: number;
  skippedInvalidName?: number;
  errors: number;
  message: string;
  files: FileProgress[];
  uploadBytes?: number;
  uploadReadMs?: number;
  uploadNetworkMs?: number;
  peakUploads?: number;
  /** Aggregated status of one continuing mutation-recovery event. */
  recovery?: MutationRecoveryHistory;
  /** Aggregated GET-only scope proof; not included in file action counts. */
  remoteScopeRecovery?: RemoteScopeRecoveryVerificationSummary;
  /** Explicit executor-owned facts. Missing only on legacy history entries. */
  runFacts?: SyncRunFacts;
}

export interface PendingIssue {
  path: string;
  actionType: SyncActionType;
  /** Stable, localization-independent route for a supported resolution UI. */
  issueCode?:
    | "anchored-folder-missing-local"
    | "anchored-folder-missing-remote"
    | "identity-replacement-ambiguous"
    | "unanchored-shared-folder"
    | "folder-location-choice";
  reason?: string;
  updatedAt: number;
  fileSize?: number;
  /** M17: content hash/etag at time of failure — used to detect version changes */
  localHash?: string;
  remoteETag?: string;
  /** M17: consecutive failures with same version. >= 3 → circuit breaker. */
  consecutiveFailures?: number;
}

/** Top-level plugin data structure */
interface PluginData {
  [KEY_BASE_SNAPSHOT]: Record<string, BaseFileEntry>;
  [KEY_PENDING_CONFLICTS]: SyncPlanItem[];
  [KEY_PENDING_DELETES]: SyncPlanItem[];
  [KEY_PENDING_ISSUES]: PendingIssue[];
  [KEY_LAST_SYNC_TIME]: number;
  [KEY_PLAN_REVIEW_ACTIVE]: boolean;
  [KEY_PLAN_REVIEW_COUNTS]: PlanReviewCounts | null;
  [KEY_PLAN_REVIEW_ITEMS]: PlanReviewItem[];
  [KEY_PLAN_REVIEW_DIGEST]: string;
  [KEY_PLAN_REVIEW_REVISION]: number;
  [KEY_PLAN_REVIEW_SCOPE]: SyncScope | null;
  [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]: CanonicalPlanIdentityV2 | null;
  [KEY_SYNC_HISTORY]: SyncHistoryEntry[];
  [KEY_GENERATION]: number;
  [KEY_BOUND_ACCOUNT]: string;
  [KEY_PUBLIC_MUTATION_LEDGER]: MutationLedgerEntryV1[];
  [KEY_MUTATION_LEDGER]: MutationLedgerEntryV1[];
  [KEY_MANUAL_MUTATION_RESOLUTION_AUDIT]: ManualMutationResolutionAuditV1[];
  [KEY_V2_RECOVERY_QUARANTINE]: MutationRecoveryQuarantineEntryV2[];
  [KEY_LOCAL_FOLDER_MOVE_HINTS]: LocalFolderMoveHintV1[];
  [KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS]:
    CommunityPluginManifestObservationV1[];
  [KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG]:
    RemoteCommunityPluginCatalogV1 | null;
  [KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2]:
    CloudBootstrapPublicationCheckpointV2 | null;
  [KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION]:
    ConfirmedDescendantFileReconstructionCheckpointV1 | null;
  [KEY_SYNC_PATH_SETTINGS_REVISION]: number;
  [KEY_SYNC_PATH_SETTINGS_FINGERPRINT]: string;
  [KEY_SYNC_SCOPE_EXPANSION]: SyncScopeExpansionMarkerV1 | null;
  [KEY_PUBLIC_113_CUTOVER]: Public113CutoverMarkerV2 | null;
}

const DEFAULT_DATA: PluginData = {
  [KEY_BASE_SNAPSHOT]: {},
  [KEY_PENDING_CONFLICTS]: [],
  [KEY_PENDING_DELETES]: [],
  [KEY_PENDING_ISSUES]: [],
  [KEY_LAST_SYNC_TIME]: 0,
  [KEY_PLAN_REVIEW_ACTIVE]: false,
  [KEY_PLAN_REVIEW_COUNTS]: null,
  [KEY_PLAN_REVIEW_ITEMS]: [],
  [KEY_PLAN_REVIEW_DIGEST]: "",
  [KEY_PLAN_REVIEW_REVISION]: 0,
  [KEY_PLAN_REVIEW_SCOPE]: null,
  [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]: null,
  [KEY_SYNC_HISTORY]: [],
  [KEY_GENERATION]: 0,
  [KEY_BOUND_ACCOUNT]: "",
  [KEY_PUBLIC_MUTATION_LEDGER]: [],
  [KEY_MUTATION_LEDGER]: [],
  [KEY_MANUAL_MUTATION_RESOLUTION_AUDIT]: [],
  [KEY_V2_RECOVERY_QUARANTINE]: [],
  [KEY_LOCAL_FOLDER_MOVE_HINTS]: [],
  [KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS]: [],
  [KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG]: null,
  [KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2]: null,
  [KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION]: null,
  [KEY_SYNC_PATH_SETTINGS_REVISION]: 0,
  [KEY_SYNC_PATH_SETTINGS_FINGERPRINT]: "",
  [KEY_SYNC_SCOPE_EXPANSION]: null,
  [KEY_PUBLIC_113_CUTOVER]: null,
};

function createDefaultData(generation = 0, planRevision = 0): PluginData {
  return {
    ...DEFAULT_DATA,
    [KEY_BASE_SNAPSHOT]: {},
    [KEY_PENDING_CONFLICTS]: [],
    [KEY_PENDING_DELETES]: [],
    [KEY_PENDING_ISSUES]: [],
    [KEY_PLAN_REVIEW_ITEMS]: [],
    [KEY_PLAN_REVIEW_DIGEST]: "",
    [KEY_PLAN_REVIEW_REVISION]: planRevision,
    [KEY_PLAN_REVIEW_SCOPE]: null,
    [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]: null,
    [KEY_SYNC_HISTORY]: [],
    [KEY_GENERATION]: generation,
    [KEY_BOUND_ACCOUNT]: "",
    [KEY_PUBLIC_MUTATION_LEDGER]: [],
    [KEY_MUTATION_LEDGER]: [],
    [KEY_MANUAL_MUTATION_RESOLUTION_AUDIT]: [],
    [KEY_V2_RECOVERY_QUARANTINE]: [],
    [KEY_LOCAL_FOLDER_MOVE_HINTS]: [],
    [KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS]: [],
    [KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG]: null,
    [KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2]: null,
    [KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION]: null,
    [KEY_SYNC_PATH_SETTINGS_REVISION]: 0,
    [KEY_SYNC_PATH_SETTINGS_FINGERPRINT]: "",
    [KEY_SYNC_SCOPE_EXPANSION]: null,
    [KEY_PUBLIC_113_CUTOVER]: null,
  };
}

function classifyV2StateLoadError(error: unknown): V2StateLoadBlockReason {
  if (error instanceof StateEnvelopeV2LoadError) return error.reason;
  if (error instanceof StateV2ManifestLoadError) return error.reason;
  if (error instanceof StateV2AuthorityWitnessLoadError) return error.reason;
  if (error instanceof CorruptStatePublicationV2Error) return error.reason;
  return "v2-state-load-failed";
}

function stateLoadErrorDetail(error: unknown): string {
  const describe = (value: unknown): string => value instanceof Error
    ? `${value.name}: ${value.message}`
    : String(value);
  const primary = describe(error);
  const cause = error instanceof StateV2AuthorityWitnessLoadError
    ? error.cause
    : undefined;
  return cause === undefined ? primary : `${primary}; cause=${describe(cause)}`;
}

function corruptionLoadBlockReason(
  corruption: StateEnvelopeV2CorruptionKind,
): V2StateLoadBlockReason {
  switch (corruption) {
    case "remote-index":
      return "envelope-remote-index-corrupt";
    case "anchors":
      return "envelope-anchors-corrupt";
    case "remote-index-and-anchors":
      return "envelope-remote-index-and-anchors-corrupt";
  }
}

function protocolBindingForManifest(
  hold: MigrationHoldV2 | null,
  manifest: StateV2Manifest,
): SharedSyncProtocolBinding | undefined {
  if (
    !hold?.protocolBinding
    || !sameSyncScope(hold.scope, manifest.scope)
    || hold.candidate.meta.commitSeq !== manifest.stateCommitSeq
    || hold.candidate.meta.lifecycleEpoch !== manifest.lifecycleEpoch
  ) {
    return undefined;
  }
  return structuredClone(hold.protocolBinding);
}

interface StateV2StorageAuthorityEvidenceBase {
  stateCommitSeq: number;
  lifecycleEpoch: number;
}

export type StateV2StorageAuthorityEvidence =
  | (StateV2StorageAuthorityEvidenceBase & {
      kind: "json";
      databaseId: null;
    })
  | (StateV2StorageAuthorityEvidenceBase & {
      kind: "indexeddb";
      databaseId: string;
    });

export class StateManager {
  private data: PluginData;
  private pluginDataCommitQueue: Promise<void> = Promise.resolve();
  private remoteState: RemoteSyncState | null = null;
  private v2Envelope: SyncStateEnvelopeV2 | null = null;
  private v2PathView: StatePathViewV2 | null = null;
  private v2Store: StateEnvelopeV2Store | null = null;
  private v2IndexedDbStore: StateV2IndexedDbActiveStore | null = null;
  private remoteScopeRecoveryEvidenceStore:
    RemoteScopeRecoveryEvidenceStore | null = null;
  private v2AuthorityWitnessStore: StateV2AuthorityWitnessStore | null = null;
  private v2ScopeTransitionStore: StateV2ScopeTransitionStore | null = null;
  private v2StateCommitQueue: Promise<void> = Promise.resolve();
  private migrationHoldStore: MigrationHoldV2Store | null = null;
  private migrationHold: MigrationHoldV2 | null = null;
  private v2CorruptRecoveryHoldStore:
    CorruptStateRecoveryHoldV2Store | null = null;
  private v2CorruptRecoveryHold:
    CorruptStateRecoveryHoldV2 | null = null;
  private v2CorruptPublicationStore:
    CorruptStatePublicationV2Store | null = null;
  private v2StateLoadBlock: V2StateLoadBlock | null = null;
  private v2CorruptionEvidence: StateEnvelopeV2CorruptionEvidence | null = null;
  private legacyStateAllowed = true;
  private mutationLedgerCorrupt = false;
  private mutationRecoveryQuarantineCorrupt = false;
  private communityPluginEnablementRetiredThisLoad = false;
  private ancestorStoreV2: AncestorStoreV2 | null = null;
  private pendingV2AncestorContent = new Map<string, string | ArrayBuffer>();
  readonly baseContentCache = new BaseContentCache();

  constructor(private plugin: PluginDataStore) {
    this.data = createDefaultData();
  }

  /** Monotonically increasing counter — detects mid-sync resets or concurrent runs */
  get remoteGeneration(): number {
    return this.data[KEY_GENERATION];
  }

  async close(): Promise<void> {
    await this.v2IndexedDbStore?.close();
    await this.remoteScopeRecoveryEvidenceStore?.close();
    this.v2IndexedDbStore = null;
    this.remoteScopeRecoveryEvidenceStore = null;
  }

  consumeCommunityPluginEnablementRetiredThisLoad(): boolean {
    const retired = this.communityPluginEnablementRetiredThisLoad;
    this.communityPluginEnablementRetiredThisLoad = false;
    return retired;
  }

  /** Bump the generation counter and persist immediately. Called by reset() before clearing
   *  state (to abort any in-flight sync), and by sync completion (to signal success). */
  async incrementRemoteGeneration(): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_GENERATION]: current[KEY_GENERATION] + 1,
    }));
  }

  /** Load all state from plugin data */
  async load(): Promise<void> {
    await this.v2IndexedDbStore?.close();
    await this.remoteScopeRecoveryEvidenceStore?.close();
    this.v2Envelope = null;
    this.v2PathView = null;
    this.v2Store = null;
    this.v2IndexedDbStore = null;
    this.remoteScopeRecoveryEvidenceStore = null;
    this.v2AuthorityWitnessStore = null;
    this.v2ScopeTransitionStore = null;
    this.migrationHoldStore = null;
    this.migrationHold = null;
    this.v2CorruptRecoveryHoldStore = null;
    this.v2CorruptRecoveryHold = null;
    this.v2CorruptPublicationStore = null;
    this.v2StateLoadBlock = null;
    this.v2CorruptionEvidence = null;
    this.legacyStateAllowed = true;
    this.mutationLedgerCorrupt = false;
    this.mutationRecoveryQuarantineCorrupt = false;
    this.remoteState = null;
    this.ancestorStoreV2 = null;
    this.pendingV2AncestorContent.clear();
    const layoutPaths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const legacyLayoutPaths = getEasySyncLegacyPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    await ensureEasySyncRuntimeLayoutMigration(
      this.plugin.app.vault.adapter,
      layoutPaths,
      legacyLayoutPaths,
      this.plugin.layoutMigrationStorage,
    );
    const saved = await this.plugin.loadData();
    if (saved) {
      const rawPublicMutationLedger = saved[KEY_PUBLIC_MUTATION_LEDGER];
      const publicMutationLedger = parseMutationLedger(
        rawPublicMutationLedger,
      );
      const rawMutationLedger = saved[KEY_MUTATION_LEDGER];
      const mutationLedger = parseMutationLedger(rawMutationLedger);
      this.mutationLedgerCorrupt = isMalformedMutationLedger(
        rawPublicMutationLedger,
        publicMutationLedger,
      ) || isMalformedMutationLedger(
        rawMutationLedger,
        mutationLedger,
      ) || mutationLedgersDisagree(publicMutationLedger, mutationLedger);
      const rawRecoveryQuarantine = saved[KEY_V2_RECOVERY_QUARANTINE];
      const recoveryQuarantine = parseMutationRecoveryQuarantine(
        rawRecoveryQuarantine,
      );
      this.mutationRecoveryQuarantineCorrupt =
        rawRecoveryQuarantine !== undefined
        && (
          !Array.isArray(rawRecoveryQuarantine)
          || recoveryQuarantine.length !== rawRecoveryQuarantine.length
        );
      const communityPluginManifestObservations =
        await readCommunityPluginManifestObservations(
          saved[KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS],
        );
      const remoteCommunityPluginCatalog =
        await readRemoteCommunityPluginCatalog(
          saved[KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG],
        );
      this.data = {
        [KEY_BASE_SNAPSHOT]: saved[KEY_BASE_SNAPSHOT] ?? {},
        [KEY_PENDING_CONFLICTS]: saved[KEY_PENDING_CONFLICTS] ?? [],
        [KEY_PENDING_DELETES]: saved[KEY_PENDING_DELETES] ?? [],
        [KEY_PENDING_ISSUES]: Array.isArray(saved[KEY_PENDING_ISSUES])
          ? saved[KEY_PENDING_ISSUES]
          : [],
        [KEY_LAST_SYNC_TIME]: saved[KEY_LAST_SYNC_TIME] ?? 0,
        [KEY_PLAN_REVIEW_ACTIVE]: saved[KEY_PLAN_REVIEW_ACTIVE] ?? false,
        [KEY_PLAN_REVIEW_COUNTS]: saved[KEY_PLAN_REVIEW_COUNTS] ?? null,
        [KEY_PLAN_REVIEW_ITEMS]: saved[KEY_PLAN_REVIEW_ITEMS] ?? [],
        [KEY_PLAN_REVIEW_DIGEST]: saved[KEY_PLAN_REVIEW_DIGEST] ?? "",
        [KEY_PLAN_REVIEW_REVISION]: Number.isSafeInteger(saved[KEY_PLAN_REVIEW_REVISION])
          && Number(saved[KEY_PLAN_REVIEW_REVISION]) >= 0
          ? Number(saved[KEY_PLAN_REVIEW_REVISION])
          : 0,
        [KEY_PLAN_REVIEW_SCOPE]: isSyncScope(saved[KEY_PLAN_REVIEW_SCOPE])
          ? saved[KEY_PLAN_REVIEW_SCOPE]
          : null,
        [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]:
          parseCanonicalPlanIdentityV2(
            saved[KEY_PLAN_REVIEW_CANONICAL_IDENTITY],
          ),
        [KEY_SYNC_HISTORY]: Array.isArray(saved[KEY_SYNC_HISTORY])
          ? saved[KEY_SYNC_HISTORY]
          : [],
        [KEY_GENERATION]: saved[KEY_GENERATION] ?? 0,
        [KEY_BOUND_ACCOUNT]: saved[KEY_BOUND_ACCOUNT] ?? "",
        [KEY_PUBLIC_MUTATION_LEDGER]: publicMutationLedger,
        [KEY_MUTATION_LEDGER]: mutationLedger,
        [KEY_MANUAL_MUTATION_RESOLUTION_AUDIT]:
          parseManualMutationResolutionAudit(
            saved[KEY_MANUAL_MUTATION_RESOLUTION_AUDIT],
          ),
        [KEY_V2_RECOVERY_QUARANTINE]: recoveryQuarantine,
        [KEY_LOCAL_FOLDER_MOVE_HINTS]: parseLocalFolderMoveHints(
          saved[KEY_LOCAL_FOLDER_MOVE_HINTS],
        ),
        [KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS]:
          communityPluginManifestObservations,
        [KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG]:
          remoteCommunityPluginCatalog,
        [KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2]:
          readCloudBootstrapPublicationCheckpointV2(
            saved[KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2],
          ),
        [KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION]:
          readConfirmedDescendantFileReconstructionCheckpointV1(
            saved[KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION],
          ),
        [KEY_SYNC_PATH_SETTINGS_REVISION]:
          Number.isSafeInteger(saved[KEY_SYNC_PATH_SETTINGS_REVISION])
          && Number(saved[KEY_SYNC_PATH_SETTINGS_REVISION]) >= 0
            ? Number(saved[KEY_SYNC_PATH_SETTINGS_REVISION])
            : 0,
        [KEY_SYNC_PATH_SETTINGS_FINGERPRINT]:
          typeof saved[KEY_SYNC_PATH_SETTINGS_FINGERPRINT] === "string"
            ? saved[KEY_SYNC_PATH_SETTINGS_FINGERPRINT]
            : "",
        [KEY_SYNC_SCOPE_EXPANSION]: readSyncScopeExpansionMarkerV1(
          saved[KEY_SYNC_SCOPE_EXPANSION],
        ),
        [KEY_PUBLIC_113_CUTOVER]: readPublic113CutoverMarker(
          saved[KEY_PUBLIC_113_CUTOVER],
        ),
      } as PluginData;
    }
    await this.retireCommunityPluginEnablementPluginData(saved ?? {});
    const paths = getEasySyncPaths(this.plugin.app.vault, this.plugin.manifest.id);
    const adapter = this.plugin.app.vault.adapter;
    // Real Obsidian adapters expose exists(). Narrow compatibility/test
    // adapters that do not cannot reliably distinguish this new optional file
    // from another read target, so they remain on the legacy path.
    if (typeof (adapter as Partial<DataAdapter>).exists === "function") {
      this.v2AuthorityWitnessStore = this.createV2AuthorityWitnessStore(paths);
      this.v2ScopeTransitionStore = this.createV2ScopeTransitionStore(paths);
      this.v2CorruptPublicationStore =
        this.createV2CorruptPublicationStore(paths);
      this.migrationHoldStore = new MigrationHoldV2Store(
        adapter,
        {
          committed: paths.stateV2MigrationHoldFile,
          next: paths.stateV2MigrationHoldNextFile,
        },
      );
      this.v2CorruptRecoveryHoldStore =
        new CorruptStateRecoveryHoldV2Store(
          adapter,
          {
            committed: paths.stateV2CorruptRecoveryFile,
            next: paths.stateV2CorruptRecoveryNextFile,
          },
        );
      let corruptPublicationPresent: boolean;
      let scopeTransitionPresent: boolean;
      try {
        corruptPublicationPresent =
          await this.v2CorruptPublicationStore.hasControlRecord();
        scopeTransitionPresent =
          await adapter.exists(paths.stateV2ScopeTransitionFile)
          || await adapter.exists(paths.stateV2ScopeTransitionNextFile);
      } catch (error) {
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          classifyV2StateLoadError(error),
          "v2",
        );
        return;
      }
      if (corruptPublicationPresent && scopeTransitionPresent) {
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          "corrupt-state-publication-state-ambiguous",
          "v2",
        );
        return;
      }
      if (!corruptPublicationPresent) {
        try {
          await this.v2ScopeTransitionStore.recover();
        } catch (error) {
          this.legacyStateAllowed = false;
          this.setV2StateLoadBlock(
            error instanceof StateV2ScopeTransitionError
              ? error.reason
              : "scope-transition-state-ambiguous",
            "v2",
          );
          return;
        }
      }
      let manifestPresent: boolean;
      try {
        manifestPresent = await adapter.exists(paths.stateV2ManifestFile);
      } catch {
        // If manifest presence itself is unreadable, neither V1 nor V2 writes
        // are safe. Treat the authority as unknown and block before scan.
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          "manifest-presence-unreadable",
          "unknown",
        );
        return;
      }
      let authorityWitness: StateV2AuthorityWitness | null;
      try {
        authorityWitness = await this.v2AuthorityWitnessStore.load();
      } catch (error) {
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          classifyV2StateLoadError(error),
          manifestPresent ? "v2" : "unknown",
        );
        return;
      }
      let recoveredCorruptManifest: StateV2Manifest | null = null;
      if (corruptPublicationPresent) {
        // The committed manifest may be momentarily absent after the
        // transaction has retired the source slot but before promoting the
        // exact staged target. The source-bound publication journal owns this
        // gap, so recover it before applying the ordinary manifest-presence
        // authority gate.
        try {
          const recovered =
            await this.v2CorruptPublicationStore.recover();
          if (recovered) {
            this.legacyStateAllowed = false;
            this.remoteState = null;
            await this.v2CorruptRecoveryHoldStore.clear();
            this.v2CorruptRecoveryHold = null;
            await this.v2CorruptPublicationStore.finalize(recovered.record);
            recoveredCorruptManifest = recovered.manifest;
            manifestPresent = true;
            authorityWitness = await this.v2AuthorityWitnessStore.load();
          }
        } catch (error) {
          this.legacyStateAllowed = false;
          this.remoteState = null;
          this.setV2StateLoadBlock(
            classifyV2StateLoadError(error),
            "v2",
          );
          return;
        }
      }
      let migrationHoldUnreadable = false;
      try {
        this.migrationHold = await this.migrationHoldStore.load();
        if (this.migrationHold?.communityPluginEnablement) {
          this.communityPluginEnablementRetiredThisLoad = true;
          this.migrationHold =
            await this.migrationHoldStore
              .retireCommunityPluginEnablementCarrier();
        }
      } catch {
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          "migration-hold-unreadable",
          manifestPresent ? "v2" : "v1-precommit",
        );
        if (!manifestPresent) return;
        migrationHoldUnreadable = true;
      }
      if (manifestPresent) {
        // File existence is already durable evidence that the manifest-last
        // authority transaction selected V2. Never allow a later parse/load
        // failure to expose the V1 runtime again.
        this.legacyStateAllowed = false;
        this.remoteState = null;
        let manifest = recoveredCorruptManifest;
        if (!manifest) {
          try {
            manifest = await readStateV2Manifest(
              adapter,
              paths.stateV2ManifestFile,
            );
          } catch (error) {
            this.setV2StateLoadBlock(
              classifyV2StateLoadError(error),
              "v2",
            );
            return;
          }
        }
        if (!manifest) {
          this.setV2StateLoadBlock("manifest-disappeared", "v2");
          return;
        }
        if (
          authorityWitness
          && !sameStateV2AuthorityManifest(authorityWitness, manifest)
        ) {
          this.setV2StateLoadBlock("authority-witness-mismatch", "v2");
          return;
        }

        const store = this.createV2Store(paths);
        this.v2Store = store;
        let committed: SyncStateEnvelopeV2 | null;
        if (authorityWitness?.storageAuthority) {
          try {
            const selected = await this.loadSelectedIndexedDbStorage(
              paths,
              manifest,
              authorityWitness,
            );
            committed = selected.envelope;
            authorityWitness = selected.witness;
            this.v2IndexedDbStore = selected.store;
          } catch (error) {
            this.setV2StateLoadBlock(
              "indexeddb-authority-recovery-failed",
              "v2",
              error,
            );
            return;
          }
        } else {
          try {
            committed = await store.load(manifest.scope);
          } catch (error) {
            let failure: unknown = error;
            if (
              error instanceof StateEnvelopeV2LoadError
              && error.reason === "envelope-unsupported"
            ) {
              try {
                committed = await store.repairCursorOnly(manifest.scope);
              } catch (repairError) {
                failure = repairError;
                committed = null;
              }
            } else {
              committed = null;
            }
            if (!committed) {
              if (
                error instanceof StateEnvelopeV2LoadError
                && error.reason === "envelope-unsupported"
                && !migrationHoldUnreadable
                && !isActiveMigrationHoldV2(this.migrationHold)
                && !this.mutationLedgerCorrupt
                && !this.mutationRecoveryQuarantineCorrupt
                && this.mutationLedger.length === 0
                && this.data[KEY_V2_RECOVERY_QUARANTINE].length === 0
              ) {
                try {
                  this.v2CorruptionEvidence =
                    await store.inspectCorruptCommitted({
                      expectedScope: manifest.scope,
                      minimumCommitSeq: manifest.stateCommitSeq,
                      minimumLifecycleEpoch: manifest.lifecycleEpoch,
                    });
                } catch {
                  this.v2CorruptionEvidence = null;
                }
              }
              try {
                this.v2CorruptRecoveryHold =
                  await this.v2CorruptRecoveryHoldStore.load();
              } catch {
                this.setV2StateLoadBlock(
                  "corrupt-state-recovery-hold-unreadable",
                  "v2",
                );
                return;
              }
              if (
                this.v2CorruptRecoveryHold
                && (
                  !this.v2CorruptionEvidence
                  || this.v2CorruptRecoveryHold.sourceDigest
                    !== this.v2CorruptionEvidence.sourceDigest
                  || this.v2CorruptRecoveryHold.sourceCommitSeq
                    !== this.v2CorruptionEvidence.sourceCommitSeq
                  || this.v2CorruptRecoveryHold.sourceLifecycleEpoch
                    !== this.v2CorruptionEvidence.sourceLifecycleEpoch
                  || this.v2CorruptRecoveryHold.corruption
                    !== this.v2CorruptionEvidence.corruption
                  || !sameSyncScope(
                    this.v2CorruptRecoveryHold.scope,
                    this.v2CorruptionEvidence.scope,
                  )
                )
              ) {
                this.setV2StateLoadBlock(
                  "corrupt-state-recovery-hold-mismatch",
                  "v2",
                );
                return;
              }
              this.setV2StateLoadBlock(
                this.v2CorruptionEvidence
                  ? corruptionLoadBlockReason(
                      this.v2CorruptionEvidence.corruption,
                    )
                  : classifyV2StateLoadError(failure),
                "v2",
              );
              return;
            }
          }
        }
        if (!committed) {
          this.setV2StateLoadBlock("manifest-envelope-missing", "v2");
          return;
        }
        if (
          committed.meta.commitSeq < manifest.stateCommitSeq
          || committed.meta.lifecycleEpoch < manifest.lifecycleEpoch
        ) {
          this.setV2StateLoadBlock("manifest-envelope-behind", "v2");
          return;
        }
        if (migrationHoldUnreadable) {
          // The committed envelope remains the selected read-only V2 state,
          // but a corrupt migration control record cannot be used to recreate
          // a missing protocol-bound witness or finalize cutover metadata.
          this.activateV2Envelope(committed);
          return;
        }
        if (!authorityWitness) {
          try {
            authorityWitness = await this.v2AuthorityWitnessStore.publishActive(
              manifest,
              Date.now(),
              protocolBindingForManifest(this.migrationHold, manifest),
            );
          } catch (error) {
            this.setV2StateLoadBlock(
              "authority-witness-save-failed",
              "v2",
              error,
            );
            return;
          }
        }
        this.activateV2Envelope(committed);
        const cutoverFailure =
          await this.finalizePublic113CutoverIfRequired(paths);
        if (cutoverFailure) {
          this.setV2StateLoadBlock(cutoverFailure, "v2");
          return;
        }
        try {
          await this.migrateActiveMutationLedgerKeyIfRequired();
        } catch (error) {
          this.setV2StateLoadBlock(
            "v2-mutation-ledger-migration-failed",
            "v2",
            error,
          );
          return;
        }
        try {
          authorityWitness = await this.maybeSelectIndexedDbStorage(
            paths,
            manifest,
            authorityWitness,
            committed,
          );
        } catch (error) {
          this.setV2StateLoadBlock(
            "indexeddb-authority-load-failed",
            "v2",
            error,
          );
          return;
        }
        return;
      }

      if (authorityWitness) {
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          "authority-witness-manifest-missing",
          "v2",
        );
        return;
      }
      let legacyDowngradeArtifactsPresent: boolean;
      try {
        legacyDowngradeArtifactsPresent =
          await adapter.exists(paths.stateV2RetiredManifestFile)
          || await adapter.exists(paths.stateV2RollbackFile);
      } catch {
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          "manifest-presence-unreadable",
          "unknown",
        );
        return;
      }
      if (legacyDowngradeArtifactsPresent) {
        this.legacyStateAllowed = false;
        this.setV2StateLoadBlock(
          "legacy-v2-downgrade-artifacts-present",
          "unknown",
        );
        return;
      }
      this.legacyStateAllowed = true;
      await this.baseContentCache.load(
        adapter,
        paths.baseContentFile,
        getEasySyncLegacyPaths(
          this.plugin.app.vault,
          this.plugin.manifest.id,
        ).baseContentFile,
      );
      this.remoteState = await this.loadRemoteState();
      return;
    } else {
      this.v2ScopeTransitionStore = null;
      this.migrationHoldStore = null;
      this.migrationHold = null;
    }
    this.legacyStateAllowed = true;
    await this.baseContentCache.load(
      adapter,
      paths.baseContentFile,
      getEasySyncLegacyPaths(
        this.plugin.app.vault,
        this.plugin.manifest.id,
      ).baseContentFile,
    );
    this.remoteState = await this.loadRemoteState();
  }

  /** Record one fully healthy round and retire old layout files after the
   * small, local-only migration grace period. Cleanup never affects sync. */
  async noteHealthySync(): Promise<void> {
    const legacy = getEasySyncLegacyPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    await noteHealthySyncAndCleanupEasySyncRuntimeLayout(
      this.plugin.app.vault.adapter,
      legacy,
      this.plugin.layoutMigrationStorage,
    );
  }

  private setV2StateLoadBlock(
    reason: V2StateLoadBlockReason,
    authority: V2StateLoadBlock["authority"],
    error?: unknown,
  ): void {
    this.v2StateLoadBlock = {
      version: 2,
      kind: "v2-state-load-block",
      authority,
      reason,
      detectedAt: Date.now(),
      ...(error === undefined
        ? {}
        : { detail: stateLoadErrorDetail(error) }),
    };
  }

  private async finalizePublic113CutoverIfRequired(
    paths: ReturnType<typeof getEasySyncPaths>,
    now = Date.now(),
  ): Promise<
    | "public-1.1.3-cutover-backup-unreadable"
    | "public-1.1.3-cutover-marker-mismatch"
    | "public-1.1.3-cutover-finalization-failed"
    | null
  > {
    const adapter = this.plugin.app.vault.adapter;
    let backupSnapshot: unknown;
    try {
      if (!await adapter.exists(paths.stateV1BackupFile)) return null;
      const backup = JSON.parse(
        await adapter.read(paths.stateV1BackupFile),
      ) as unknown;
      if (
        !isRecord(backup)
        || backup.schemaVersion !== 1
        || !("snapshot" in backup)
      ) {
        return "public-1.1.3-cutover-backup-unreadable";
      }
      backupSnapshot = backup.snapshot;
    } catch {
      return "public-1.1.3-cutover-backup-unreadable";
    }

    const sourceStateDigest =
      isRecord(backupSnapshot)
      && typeof backupSnapshot.sourceStateDigest === "string"
      && /^[a-f0-9]{64}$/.test(backupSnapshot.sourceStateDigest)
        ? backupSnapshot.sourceStateDigest
        : await public113BackupSnapshotDigest(backupSnapshot);
    let rawPluginData: Record<string, unknown>;
    try {
      rawPluginData = await this.plugin.loadData() ?? {};
    } catch {
      return "public-1.1.3-cutover-finalization-failed";
    }
    const rawMarker = rawPluginData[KEY_PUBLIC_113_CUTOVER];
    const existingMarker = readPublic113CutoverMarker(rawMarker);
    if (
      (rawMarker !== undefined && rawMarker !== null && !existingMarker)
      || (
        existingMarker
        && existingMarker.sourceStateDigest !== sourceStateDigest
      )
    ) {
      return "public-1.1.3-cutover-marker-mismatch";
    }
    const liveLegacyBase = rawPluginData[KEY_BASE_SNAPSHOT];
    const liveLegacyBaseEmpty =
      !isRecord(liveLegacyBase)
      || Object.keys(liveLegacyBase).length === 0;
    const publicLedgerEmpty =
      !Array.isArray(rawPluginData[KEY_PUBLIC_MUTATION_LEDGER])
      || rawPluginData[KEY_PUBLIC_MUTATION_LEDGER].length === 0;
    const activeLedgerPresent =
      Array.isArray(rawPluginData[KEY_MUTATION_LEDGER]);
    if (
      existingMarker
      && liveLegacyBaseEmpty
      && publicLedgerEmpty
      && activeLedgerPresent
    ) {
      this.data = {
        ...this.data,
        [KEY_PUBLIC_113_CUTOVER]: existingMarker,
      };
      return null;
    }

    try {
      await this.commitPluginData((current) =>
        finalizePublic113PluginDataCutover({
          pluginData: current as unknown as Record<string, unknown>,
          sourceStateDigest,
          finalizedAt: now,
        }).pluginData as unknown as PluginData
      );
      return null;
    } catch {
      return "public-1.1.3-cutover-finalization-failed";
    }
  }

  private async migrateActiveMutationLedgerKeyIfRequired(): Promise<void> {
    if (!this.v2Envelope || this.v2StateLoadBlock) return;
    const publicLedger = this.data[KEY_PUBLIC_MUTATION_LEDGER];
    const activeLedger = this.data[KEY_MUTATION_LEDGER];
    if (publicLedger.length === 0) return;
    if (mutationLedgersDisagree(publicLedger, activeLedger)) {
      throw new Error("Public and V2 mutation ledgers disagree");
    }
    await this.commitPluginData((current) => ({
      ...current,
      [KEY_PUBLIC_MUTATION_LEDGER]: [],
      [KEY_MUTATION_LEDGER]: selectActiveMutationLedger(
        publicLedger,
        activeLedger,
      ),
    }));
  }

  /** Persist device-local PluginData through the shared serialized queue.
   *  Public 1.1.3 base-content.json is read-only migration evidence; active
   *  V2 ancestors are published through AncestorStoreV2 instead. */
  private save(buildNext: (current: PluginData) => PluginData): Promise<void> {
    return this.commitPluginData(buildNext);
  }

  /** Publish a complete PluginData candidate only after its durable write succeeds. */
  private commitPluginData(
    buildNext: (current: PluginData) => PluginData,
  ): Promise<void> {
    const task = this.pluginDataCommitQueue.then(async () => {
      const next = buildNext(this.data);
      if (next === this.data) return;
      await this.persistPluginData(next);
      this.data = next;
    });
    this.pluginDataCommitQueue = task.catch(() => undefined);
    return task;
  }

  private persistPluginData(snapshot: PluginData): Promise<void> {
    return this.plugin.updatePluginData((data) => {
      const snapshotRecord = snapshot as unknown as Record<string, unknown>;
      for (const key of Object.keys(snapshot)) {
        data[key] = snapshotRecord[key];
      }
      // The 1.2.7 enablement projection is read-only compatibility input.
      // Never let the in-memory compatibility default resurrect it.
      delete data[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE];
    });
  }

  /**
   * Retire the public 1.2.7 device-local enablement projection and stale
   * review items without touching either local or remote
   * community-plugins.json. Generic mutation ledgers are intentionally left
   * intact so response-unknown work can still be settled by evidence.
   */
  private async retireCommunityPluginEnablementPluginData(
    raw: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const configDir = getConfigDir(this.plugin.app.vault).replace(/\/+$/, "");
    const path = `${configDir}/community-plugins.json`;
    const hadLegacyState = raw[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]
      !== undefined;
    const hasPendingPathState = [
      KEY_PENDING_CONFLICTS,
      KEY_PENDING_DELETES,
      KEY_PENDING_ISSUES,
      KEY_PLAN_REVIEW_ITEMS,
    ].some((key) =>
      Array.isArray(raw[key])
      && (raw[key] as Array<{ path?: unknown }>).some(
        (item) => item?.path === path,
      )
    );
    if (!hadLegacyState && !hasPendingPathState) return;
    await this.plugin.updatePluginData((data) => {
      delete data[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE];
      for (const key of [
        KEY_PENDING_CONFLICTS,
        KEY_PENDING_DELETES,
        KEY_PENDING_ISSUES,
      ]) {
        if (Array.isArray(data[key])) {
          data[key] = (data[key] as Array<{ path?: unknown }>).filter(
            (item) => item?.path !== path,
          );
        }
      }
      const reviewedPathRetired = Array.isArray(data[KEY_PLAN_REVIEW_ITEMS])
        && (data[KEY_PLAN_REVIEW_ITEMS] as Array<{ path?: unknown }>).some(
          (item) => item?.path === path,
        );
      if (reviewedPathRetired) {
        data[KEY_PLAN_REVIEW_ACTIVE] = false;
        data[KEY_PLAN_REVIEW_COUNTS] = null;
        data[KEY_PLAN_REVIEW_ITEMS] = [];
        data[KEY_PLAN_REVIEW_DIGEST] = "";
        data[KEY_PLAN_REVIEW_REVISION] =
          Number.isSafeInteger(data[KEY_PLAN_REVIEW_REVISION])
            ? Number(data[KEY_PLAN_REVIEW_REVISION]) + 1
            : 1;
        data[KEY_PLAN_REVIEW_SCOPE] = null;
        data[KEY_PLAN_REVIEW_CANONICAL_IDENTITY] = null;
      }
    });
    this.communityPluginEnablementRetiredThisLoad = true;
    this.data[KEY_PENDING_CONFLICTS] =
      this.data[KEY_PENDING_CONFLICTS].filter((item) => item.path !== path);
    this.data[KEY_PENDING_DELETES] =
      this.data[KEY_PENDING_DELETES].filter((item) => item.path !== path);
    this.data[KEY_PENDING_ISSUES] =
      this.data[KEY_PENDING_ISSUES].filter((item) => item.path !== path);
    if (this.data[KEY_PLAN_REVIEW_ITEMS].some((item) => item.path === path)) {
      this.data = clearPlanReviewData(this.data);
    }
  }

  private async loadRemoteState(): Promise<RemoteSyncState | null> {
    const adapter = this.plugin.app.vault.adapter;
    const legacyPath = getEasySyncLegacyPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    ).remoteStateFile;
    for (const path of [this.remoteStatePath, legacyPath]) {
      try {
        const json = await adapter.read(path);
        return parseRemoteState(JSON.parse(json));
      } catch {
        // Try the public 1.1.3 path only when the new path is absent/unreadable.
      }
    }
    return null;
  }

  private get remoteStatePath(): string {
    return getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    ).remoteStateFile;
  }

  private activateV2Envelope(envelope: SyncStateEnvelopeV2): void {
    this.v2Envelope = envelope;
    this.v2PathView = null;
  }

  private getV2PathView(): StatePathViewV2 | null {
    if (!this.v2Envelope) return null;
    this.v2PathView ??= projectStatePathViewV2(this.v2Envelope);
    return this.v2PathView;
  }

  private createV2Store(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): StateEnvelopeV2Store {
    const ancestorStore = this.createAncestorStoreV2(paths);
    this.ancestorStoreV2 = ancestorStore;
    return new StateEnvelopeV2Store(
      this.plugin.app.vault.adapter,
      {
        committed: paths.stateV2File,
        next: paths.stateV2NextFile,
        previous: paths.stateV2PreviousFile,
        recovery: paths.stateV2RecoveryFile,
      },
      (hash) => ancestorStore.has(hash),
    );
  }

  private createV2IndexedDbRecoveryStore(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): StateV2IndexedDbRecoveryStore {
    return new StateV2IndexedDbRecoveryStore(
      this.plugin.app.vault.adapter,
      paths.stateV2IndexedDbRecoveryDir,
    );
  }

  private createV2IndexedDbActiveStore(
    databaseId: string,
    recovery: StateV2IndexedDbRecoveryStore,
  ): StateV2IndexedDbActiveStore | null {
    return this.plugin.createStateV2IndexedDbActiveStore?.(
      databaseId,
      recovery,
    ) ?? null;
  }

  private currentIndexedDbVaultInstanceId(): string | null {
    const captured = this.plugin.indexedDbVaultInstanceId;
    if (!isIndexedDbVaultInstanceId(captured)) return null;
    const readCurrent = this.plugin.readIndexedDbVaultInstanceId;
    if (!readCurrent) return captured;
    try {
      return readCurrent() === captured ? captured : null;
    } catch {
      return null;
    }
  }

  private async loadSelectedIndexedDbStorage(
    paths: ReturnType<typeof getEasySyncPaths>,
    manifest: StateV2Manifest,
    witness: StateV2AuthorityWitness,
  ): Promise<{
    envelope: SyncStateEnvelopeV2;
    store: StateV2IndexedDbActiveStore;
    witness: StateV2AuthorityWitness;
  }> {
    const selected = witness.storageAuthority;
    if (!selected || !this.v2AuthorityWitnessStore) {
      throw new Error("V2 IndexedDB storage authority is not selected");
    }
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    if (!vaultInstanceId) {
      throw new Error("V2 IndexedDB Vault instance identity is unavailable");
    }
    const recovery = this.createV2IndexedDbRecoveryStore(paths);
    let active: StateV2IndexedDbActiveStore;
    let envelope: SyncStateEnvelopeV2;
    let currentWitness = witness;
    const sameVaultInstance = selected.schemaVersion === 2
      && selected.vaultInstanceId === vaultInstanceId;
    if (!sameVaultInstance) {
      ({
        envelope,
        store: active,
        witness: currentWitness,
      } = await this.rebuildSelectedIndexedDbStorage({
        recovery,
        manifest,
        witness,
        selected,
        vaultInstanceId,
      }));
    } else {
      const selectedStore = this.createV2IndexedDbActiveStore(
        selected.databaseId,
        recovery,
      );
      if (!selectedStore) {
        throw new Error("V2 IndexedDB active-state factory is unavailable");
      }
      active = selectedStore;
      try {
        envelope = await active.load();
      } catch (error) {
        if (
          !(error instanceof StateV2IndexedDbActiveStateError)
          || error.reason !== "missing"
        ) {
          await active.close();
          throw error;
        }
        ({
          envelope,
          store: active,
          witness: currentWitness,
        } = await this.rebuildSelectedIndexedDbStorage({
          recovery,
          manifest,
          witness,
          selected,
          vaultInstanceId,
          previousStore: active,
          deletePrevious: true,
        }));
      }
    }
    await active.reconcileLoadedRecoveryDelta();
    const inspection = await active.inspect();
    const binding = currentWitness.storageAuthority;
    if (
      !binding
      || binding.databaseId !== active.databaseId
      || !sameSyncScope(envelope.scope, manifest.scope)
      || envelope.meta.commitSeq < manifest.stateCommitSeq
      || envelope.meta.lifecycleEpoch < manifest.lifecycleEpoch
      || inspection.commitSeq !== envelope.meta.commitSeq
      || inspection.lifecycleEpoch !== envelope.meta.lifecycleEpoch
      || !inspection.stateDigest
      || (
        envelope.meta.commitSeq === binding.stateCommitSeq
        && inspection.stateDigest !== binding.stateDigest
      )
      || this.currentIndexedDbVaultInstanceId() !== vaultInstanceId
    ) {
      await active.close();
      throw new Error(
        "V2 IndexedDB loaded state does not match its authority witness",
      );
    }
    await active.compactRecoveryIfNeeded().catch(() => undefined);
    return { envelope, store: active, witness: currentWitness };
  }

  private async rebuildSelectedIndexedDbStorage(input: {
    recovery: StateV2IndexedDbRecoveryStore;
    manifest: StateV2Manifest;
    witness: StateV2AuthorityWitness;
    selected: StateV2IndexedDbStorageAuthority;
    vaultInstanceId: string;
    previousStore?: StateV2IndexedDbActiveStore;
    deletePrevious?: boolean;
  }): Promise<{
    envelope: SyncStateEnvelopeV2;
    store: StateV2IndexedDbActiveStore;
    witness: StateV2AuthorityWitness;
  }> {
    const rebuilt = await input.recovery.rebuild();
    const rebuiltDigest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(rebuilt);
    if (
      !sameSyncScope(rebuilt.scope, input.manifest.scope)
      || rebuilt.meta.commitSeq < input.selected.stateCommitSeq
      || rebuilt.meta.lifecycleEpoch < input.selected.lifecycleEpoch
      || (
        rebuilt.meta.commitSeq === input.selected.stateCommitSeq
        && rebuiltDigest !== input.selected.stateDigest
      )
    ) {
      await input.previousStore?.close();
      throw new Error(
        "V2 IndexedDB recovery does not match selected authority",
      );
    }
    const replacementId =
      await deriveStateV2ActiveIndexedDbDatabaseId({
        vaultInstanceId: input.vaultInstanceId,
        stateDigest: rebuiltDigest,
        previousDatabaseId: input.selected.databaseId,
      });
    if (replacementId === input.selected.databaseId) {
      await input.previousStore?.close();
      throw new Error(
        "V2 IndexedDB replacement identity did not advance",
      );
    }
    const replacement = this.createV2IndexedDbActiveStore(
      replacementId,
      input.recovery,
    );
    if (!replacement) {
      await input.previousStore?.close();
      throw new Error("V2 IndexedDB recovery factory is unavailable");
    }
    try {
      await replacement.initialize(rebuilt);
      const nextStorage: StateV2IndexedDbStorageAuthority = {
        schemaVersion: 2,
        kind: "indexeddb",
        vaultInstanceId: input.vaultInstanceId,
        databaseId: replacementId,
        stateCommitSeq: rebuilt.meta.commitSeq,
        lifecycleEpoch: rebuilt.meta.lifecycleEpoch,
        stateDigest: rebuiltDigest,
        selectedAt: Math.max(Date.now(), input.selected.selectedAt),
      };
      const nextWitness =
        await this.v2AuthorityWitnessStore!.replaceIndexedDbStorage({
          expectedManifest: input.manifest,
          expectedRevision: input.witness.revision,
          expectedStorageAuthority: input.selected,
          nextStorageAuthority: nextStorage,
        });
      if (input.previousStore) {
        if (input.deletePrevious) await input.previousStore.delete();
        else await input.previousStore.close();
      }
      return {
        envelope: rebuilt,
        store: replacement,
        witness: nextWitness,
      };
    } catch (error) {
      await replacement.close();
      await input.previousStore?.close();
      throw error;
    }
  }

  private async maybeSelectIndexedDbStorage(
    paths: ReturnType<typeof getEasySyncPaths>,
    manifest: StateV2Manifest,
    witness: StateV2AuthorityWitness,
    envelope: SyncStateEnvelopeV2,
  ): Promise<StateV2AuthorityWitness> {
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    if (
      witness.storageAuthority
      || !this.plugin.createStateV2IndexedDbActiveStore
      || !this.v2AuthorityWitnessStore
      || !vaultInstanceId
    ) {
      return witness;
    }
    const stateDigest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(envelope);
    const databaseId = await deriveStateV2ActiveIndexedDbDatabaseId({
      vaultInstanceId,
      stateDigest,
    });
    const recovery = this.createV2IndexedDbRecoveryStore(paths);
    const active = this.createV2IndexedDbActiveStore(
      databaseId,
      recovery,
    );
    if (!active) return witness;
    try {
      await active.initialize(envelope);
    } catch {
      return this.closePreparedIndexedDbAndConfirmJsonAuthority(
        active,
        witness,
        "V2 IndexedDB authority changed while initialization failed",
      );
    }
    if (this.currentIndexedDbVaultInstanceId() !== vaultInstanceId) {
      return this.closePreparedIndexedDbAndConfirmJsonAuthority(
        active,
        witness,
        "V2 IndexedDB authority changed with the Vault identity",
      );
    }
    const storageAuthority: StateV2IndexedDbStorageAuthority = {
      schemaVersion: 2,
      kind: "indexeddb",
      vaultInstanceId,
      databaseId,
      stateCommitSeq: envelope.meta.commitSeq,
      lifecycleEpoch: envelope.meta.lifecycleEpoch,
      stateDigest,
      selectedAt: Date.now(),
    };
    let selected: StateV2AuthorityWitness;
    try {
      selected = await this.v2AuthorityWitnessStore.selectIndexedDbStorage({
        expectedManifest: manifest,
        expectedRevision: witness.revision,
        storageAuthority,
      });
    } catch (error) {
      const reread = await this.v2AuthorityWitnessStore.load();
      if (
        reread
        && reread.storageAuthority
        && JSON.stringify(reread.storageAuthority)
          === JSON.stringify(storageAuthority)
      ) {
        selected = reread;
      } else if (
        reread
        && JSON.stringify(reread) === JSON.stringify(witness)
      ) {
        await active.close().catch(() => undefined);
        return reread;
      } else {
        await active.close().catch(() => undefined);
        this.v2Envelope = null;
        this.v2PathView = null;
        throw error;
      }
    }
    const confirmed = await this.v2AuthorityWitnessStore.load();
    if (
      !confirmed
      || JSON.stringify(confirmed) !== JSON.stringify(selected)
      || this.currentIndexedDbVaultInstanceId() !== vaultInstanceId
    ) {
      await active.close();
      this.v2Envelope = null;
      this.v2PathView = null;
      throw new Error(
        "V2 IndexedDB Vault identity changed during authority selection",
      );
    }
    this.v2IndexedDbStore = active;
    return confirmed;
  }

  /**
   * A derived candidate ID is retry-stable and can be prepared concurrently.
   * Never delete it merely because this instance stayed on JSON: another
   * instance may already have selected the same physical database. JSON is a
   * safe fallback only while the complete authority witness is unchanged.
   */
  private async closePreparedIndexedDbAndConfirmJsonAuthority(
    active: StateV2IndexedDbActiveStore,
    witness: StateV2AuthorityWitness,
    changedMessage: string,
  ): Promise<StateV2AuthorityWitness> {
    await active.close().catch(() => undefined);
    const reread = await this.v2AuthorityWitnessStore!.load();
    if (
      reread
      && JSON.stringify(reread) === JSON.stringify(witness)
    ) {
      return reread;
    }
    this.v2Envelope = null;
    this.v2PathView = null;
    throw new Error(changedMessage);
  }

  private async publishV2Candidate(
    current: SyncStateEnvelopeV2,
    candidate: SyncStateEnvelopeV2,
  ): Promise<void> {
    if (this.v2IndexedDbStore) {
      if (!this.currentIndexedDbVaultInstanceId()) {
        throw new Error(
          "V2 IndexedDB Vault identity changed after activation",
        );
      }
      await this.v2IndexedDbStore.commit(current, candidate);
      return;
    }
    if (!this.v2Store) {
      throw new Error("V2 state controller is not active");
    }
    await this.v2Store.publish(candidate);
  }

  private async selectJsonV2Storage(
    manifest: StateV2Manifest,
    witness: StateV2AuthorityWitness,
  ): Promise<StateV2AuthorityWitness> {
    const storageAuthority = witness.storageAuthority;
    if (!storageAuthority) return witness;
    if (
      !this.v2Store
      || !this.v2IndexedDbStore
      || !this.v2Envelope
      || !this.v2AuthorityWitnessStore
    ) {
      throw new Error("V2 IndexedDB storage demotion is not ready");
    }
    await this.v2Store.replaceFromVerifiedExternalAuthority(
      this.v2Envelope,
    );
    const materialized = await this.v2Store.load(manifest.scope);
    if (
      !materialized
      || JSON.stringify(materialized)
        !== JSON.stringify(this.v2Envelope)
    ) {
      throw new Error(
        "V2 JSON storage did not materialize the selected IndexedDB state",
      );
    }
    let jsonWitness: StateV2AuthorityWitness;
    try {
      jsonWitness = await this.v2AuthorityWitnessStore.selectJsonStorage({
        expectedManifest: manifest,
        expectedRevision: witness.revision,
        expectedStorageAuthority: storageAuthority,
      });
    } catch (error) {
      const reread = await this.v2AuthorityWitnessStore.load();
      if (
        reread
        && !reread.storageAuthority
        && sameStateV2AuthorityManifest(reread, manifest)
      ) {
        jsonWitness = reread;
      } else {
        throw error;
      }
    }
    await this.v2IndexedDbStore.delete();
    this.v2IndexedDbStore = null;
    return jsonWitness;
  }

  private createAncestorStoreV2(
    paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    ),
  ): AncestorStoreV2 {
    return new AncestorStoreV2(
      this.plugin.app.vault.adapter,
      {
        directory: paths.ancestorsV2Dir,
        manifest: paths.ancestorManifestV2File,
        manifestNext: paths.ancestorManifestV2NextFile,
      },
    );
  }

  private createV2AuthorityWitnessStore(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): StateV2AuthorityWitnessStore {
    return new StateV2AuthorityWitnessStore(
      this.plugin.app.vault.adapter,
      {
        committed: paths.stateV2AuthorityWitnessFile,
        next: paths.stateV2AuthorityWitnessNextFile,
      },
    );
  }

  private createV2ScopeTransitionStore(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): StateV2ScopeTransitionStore {
    return new StateV2ScopeTransitionStore(
      this.plugin.app.vault.adapter,
      {
        stateCommitted: paths.stateV2File,
        stateNext: paths.stateV2NextFile,
        statePrevious: paths.stateV2PreviousFile,
        stateRecovery: paths.stateV2RecoveryFile,
        manifestCommitted: paths.stateV2ManifestFile,
        manifestNext: paths.stateV2ManifestNextFile,
        witness: {
          committed: paths.stateV2AuthorityWitnessFile,
          next: paths.stateV2AuthorityWitnessNextFile,
        },
        transitionCommitted: paths.stateV2ScopeTransitionFile,
        transitionNext: paths.stateV2ScopeTransitionNextFile,
      },
    );
  }

  private createV2CorruptPublicationStore(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): CorruptStatePublicationV2Store {
    return new CorruptStatePublicationV2Store(
      this.plugin.app.vault.adapter,
      {
        stateCommitted: paths.stateV2File,
        stateNext: paths.stateV2NextFile,
        statePrevious: paths.stateV2PreviousFile,
        stateRecovery: paths.stateV2RecoveryFile,
        manifestCommitted: paths.stateV2ManifestFile,
        manifestNext: paths.stateV2ManifestNextFile,
        witness: {
          committed: paths.stateV2AuthorityWitnessFile,
          next: paths.stateV2AuthorityWitnessNextFile,
        },
        scopeTransitionCommitted: paths.stateV2ScopeTransitionFile,
        scopeTransitionNext: paths.stateV2ScopeTransitionNextFile,
        forensicSourcePrefix: paths.stateV2CorruptSourcePrefix,
        publicationCommitted: paths.stateV2CorruptPublicationFile,
        publicationNext: paths.stateV2CorruptPublicationNextFile,
      },
    );
  }

  private commitV2State(
    buildNext: (current: SyncStateEnvelopeV2) => SyncStateEnvelopeV2,
  ): Promise<boolean> {
    let changed = false;
    const task = this.v2StateCommitQueue.then(async () => {
      if (this.v2StateLoadBlock) {
        throw new Error("V2 state writes are blocked until load recovery completes");
      }
      if (!this.v2Store || !this.v2Envelope) {
        throw new Error("V2 state controller is not active");
      }
      if (this.v2Envelope.remoteScopeRecovery) {
        throw new Error(
          "V2 state writes are blocked during remote scope recovery",
        );
      }
      const candidate = buildNext(this.v2Envelope);
      if (candidate === this.v2Envelope) return;
      await this.publishV2Candidate(this.v2Envelope, candidate);
      this.activateV2Envelope(candidate);
      changed = true;
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    return task.then(() => changed);
  }

  async stageV2RemoteScopeRecovery(input: {
    observedScope: SyncScope | null;
    now?: number;
  }): Promise<RemoteScopeRecoveryV2> {
    let staged: RemoteScopeRecoveryV2 | null = null;
    const task = this.v2StateCommitQueue.then(async () => {
      if (this.v2StateLoadBlock) {
        throw new Error("V2 state writes are blocked until load recovery completes");
      }
      if (!this.v2Store || !this.v2Envelope) {
        throw new Error("V2 state controller is not active");
      }
      if (
        this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
      ) {
        throw new Error(
          "V2 remote scope recovery cannot start while mutation recovery is unresolved",
        );
      }
      const current = this.v2Envelope;
      if (current.remoteScopeRecovery) {
        const sameObservation =
          current.remoteScopeRecovery.observedScope === null
            ? input.observedScope === null
            : sameSyncScope(
                current.remoteScopeRecovery.observedScope,
                input.observedScope,
              );
        if (!sameObservation) {
          throw new Error(
            "V2 remote scope recovery observation changed before completion",
          );
        }
        staged = structuredClone(current.remoteScopeRecovery);
        return;
      }
      if (
        input.observedScope
        && (
          input.observedScope.accountId !== current.scope.accountId
          || sameSyncScope(input.observedScope, current.scope)
        )
      ) {
        throw new Error("V2 remote scope recovery observation is invalid");
      }
      const now = input.now ?? Date.now();
      const recovery: RemoteScopeRecoveryV2 = {
        schemaVersion: 1,
        kind: "v2-remote-scope-recovery",
        reason: "committed-scope-unreachable",
        sourceCommitSeq: current.meta.commitSeq,
        observedScope: input.observedScope
          ? { ...input.observedScope }
          : null,
        observedAt: now,
      };
      const candidate: SyncStateEnvelopeV2 = {
        ...structuredClone(current),
        meta: {
          ...current.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: now,
        },
        remoteScopeRecovery: recovery,
      };
      await this.publishV2Candidate(current, candidate);
      this.activateV2Envelope(candidate);
      staged = structuredClone(recovery);
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
    if (!staged) {
      throw new Error("V2 remote scope recovery was not staged");
    }
    return staged;
  }

  /**
   * Replace only the GET-only path observation attached to an existing scope
   * hold. The committed scope, RemoteIndex and anchors stay unchanged. A
   * caller must still build a complete recovery candidate before authority can
   * move to the newly observed scope.
   */
  async refreshV2RemoteScopeRecoveryObservation(input: {
    observedScope: SyncScope | null;
    now?: number;
  }): Promise<RemoteScopeRecoveryV2> {
    let refreshed: RemoteScopeRecoveryV2 | null = null;
    const task = this.v2StateCommitQueue.then(async () => {
      if (this.v2StateLoadBlock) {
        throw new Error(
          "V2 remote scope recovery observation cannot refresh during load recovery",
        );
      }
      if (
        !this.v2Store
        || !this.v2Envelope
        || !this.v2Envelope.remoteScopeRecovery
      ) {
        throw new Error("V2 remote scope recovery observation is not active");
      }
      if (
        this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
        || await this.v2Store.hasRecoveryJournal()
      ) {
        throw new Error(
          "V2 remote scope recovery observation cannot refresh while recovery is unresolved",
        );
      }
      const current = this.v2Envelope;
      const existing = current.remoteScopeRecovery;
      if (!existing) {
        throw new Error("V2 remote scope recovery observation is not active");
      }
      if (
        input.observedScope
        && (
          input.observedScope.accountId !== current.scope.accountId
          || sameSyncScope(input.observedScope, current.scope)
        )
      ) {
        throw new Error(
          "V2 remote scope recovery refresh observation is invalid",
        );
      }
      const sameObservation =
        existing.observedScope === null
          ? input.observedScope === null
          : sameSyncScope(
              existing.observedScope,
              input.observedScope,
            );
      if (sameObservation) {
        refreshed = structuredClone(existing);
        return;
      }
      const now = input.now ?? Date.now();
      const recovery: RemoteScopeRecoveryV2 = {
        ...structuredClone(existing),
        sourceCommitSeq: current.meta.commitSeq,
        observedScope: input.observedScope
          ? { ...input.observedScope }
          : null,
        observedAt: now,
      };
      if (input.observedScope) delete recovery.scopeBootstrap;
      const candidate: SyncStateEnvelopeV2 = {
        ...structuredClone(current),
        meta: {
          ...current.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: now,
        },
        remoteScopeRecovery: recovery,
      };
      await this.publishV2Candidate(current, candidate);
      this.activateV2Envelope(candidate);
      refreshed = structuredClone(recovery);
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
    if (!refreshed) {
      throw new Error("V2 remote scope recovery observation was not refreshed");
    }
    return refreshed;
  }

  /**
   * Publish a durable review phase before any create-missing Graph request.
   * The review is bound to the new envelope revision; a crash before the
   * device-local review bundle is written can recreate the same bundle.
   */
  async stageV2RemoteScopeBootstrapReview(
    now = Date.now(),
  ): Promise<SyncStateEnvelopeV2> {
    let staged: SyncStateEnvelopeV2 | null = null;
    const task = this.v2StateCommitQueue.then(async () => {
      if (
        this.v2StateLoadBlock
        || !this.v2Store
        || !this.v2Envelope
      ) {
        throw new Error("V2 remote scope bootstrap review is not available");
      }
      const current = this.v2Envelope;
      const currentRecovery = current.remoteScopeRecovery;
      if (!currentRecovery) {
        throw new Error("V2 remote scope bootstrap review is not available");
      }
      if (
        currentRecovery.observedScope !== null
        || this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
        || await this.v2Store.hasRecoveryJournal()
      ) {
        throw new Error("V2 remote scope bootstrap review is not safe");
      }
      if (currentRecovery.scopeBootstrap) {
        staged = structuredClone(current);
        return;
      }
      const recovery: RemoteScopeRecoveryV2 = {
        ...structuredClone(currentRecovery),
        sourceCommitSeq: current.meta.commitSeq,
        scopeBootstrap: {
          schemaVersion: 1,
          kind: "v2-remote-scope-bootstrap-review",
          phase: "pending",
          reviewSourceCommitSeq: current.meta.commitSeq + 1,
          requestedAt: now,
        },
      };
      const candidate: SyncStateEnvelopeV2 = {
        ...structuredClone(current),
        meta: {
          ...current.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: now,
        },
        remoteScopeRecovery: recovery,
      };
      await this.publishV2Candidate(current, candidate);
      this.activateV2Envelope(candidate);
      staged = structuredClone(candidate);
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
    if (!staged) {
      throw new Error("V2 remote scope bootstrap review was not staged");
    }
    return staged;
  }

  /**
   * Convert an exact visible review into durable create-only authority.
   * This still performs no Graph request. Once confirmed, a later explicit
   * manual run may idempotently finish the remote infrastructure bootstrap.
   */
  async confirmV2RemoteScopeBootstrapReview(
    expected: PlanReviewAuthorization,
    now = Date.now(),
  ): Promise<SyncStateEnvelopeV2> {
    let confirmed: SyncStateEnvelopeV2 | null = null;
    const task = this.v2StateCommitQueue.then(async () => {
      if (
        this.v2StateLoadBlock
        || !this.v2Store
        || !this.v2Envelope
      ) {
        throw new Error("V2 remote scope bootstrap confirmation is not available");
      }
      const current = this.v2Envelope;
      const recovery = current.remoteScopeRecovery;
      if (!recovery) {
        throw new Error("V2 remote scope bootstrap confirmation is not available");
      }
      const bootstrap = recovery.scopeBootstrap;
      const activeAuthorization = this.planReviewAuthorization;
      if (
        recovery.observedScope !== null
        || !bootstrap
        || bootstrap.phase !== "pending"
        || !expected.canonicalIdentity
        || !activeAuthorization
        || expected.revision !== activeAuthorization.revision
        || !sameSyncScope(expected.scope, current.scope)
        || !sameSyncScope(activeAuthorization.scope, current.scope)
        || !sameCanonicalPlanIdentityV2(
          expected.canonicalIdentity,
          activeAuthorization.canonicalIdentity,
        )
        || expected.canonicalIdentity.sourceCommitSeq
          !== bootstrap.reviewSourceCommitSeq
        || expected.canonicalIdentity.sourceCommitSeq
          !== current.meta.commitSeq
        || expected.canonicalIdentity.digest !== this.planReviewDigest
        || this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
        || await this.v2Store.hasRecoveryJournal()
      ) {
        throw new Error(
          "V2 remote scope bootstrap review authorization is stale",
        );
      }
      const nextRecovery: RemoteScopeRecoveryV2 = {
        ...structuredClone(recovery),
        sourceCommitSeq: current.meta.commitSeq,
        scopeBootstrap: {
          ...structuredClone(bootstrap),
          phase: "confirmed",
          confirmedAt: now,
        },
      };
      const candidate: SyncStateEnvelopeV2 = {
        ...structuredClone(current),
        meta: {
          ...current.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: now,
        },
        remoteScopeRecovery: nextRecovery,
      };
      await this.publishV2Candidate(current, candidate);
      this.activateV2Envelope(candidate);
      confirmed = structuredClone(candidate);
      await this.clearStoredPlanReview();
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
    if (!confirmed) {
      throw new Error("V2 remote scope bootstrap review was not confirmed");
    }
    return confirmed;
  }

  /**
   * Remove a scope hold only after the caller has re-read and validated the
   * exact committed Graph identities. No V1 state is involved; the existing
   * V2 scope/index/anchors remain authoritative and the following ordinary
   * sync round revalidates current file facts.
   */
  async resolveV2RemoteScopeRecoveryToCommittedScope(
    provenScope: SyncScope,
    now = Date.now(),
  ): Promise<SyncStateEnvelopeV2> {
    let resolved: SyncStateEnvelopeV2 | null = null;
    const task = this.v2StateCommitQueue.then(async () => {
      if (this.v2StateLoadBlock) {
        throw new Error(
          "V2 remote scope recovery cannot resolve during load recovery",
        );
      }
      if (
        !this.v2Store
        || !this.v2Envelope
        || !this.v2Envelope.remoteScopeRecovery
      ) {
        throw new Error("V2 remote scope recovery is not active");
      }
      if (
        !sameSyncScope(provenScope, this.v2Envelope.scope)
        || this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
        || await this.v2Store.hasRecoveryJournal()
      ) {
        throw new Error(
          "V2 committed scope restoration proof is not safe",
        );
      }
      const current = this.v2Envelope;
      const candidate = structuredClone(current);
      candidate.meta = {
        ...current.meta,
        commitSeq: current.meta.commitSeq + 1,
        committedAt: now,
      };
      delete candidate.remoteScopeRecovery;
      await this.publishV2Candidate(current, candidate);
      this.activateV2Envelope(candidate);
      resolved = structuredClone(candidate);

      // The old review and pending decisions predate the period in which the
      // committed Graph identities were unreachable. Their exact V2 plan
      // identity is already stale after the state publication; clear the UI
      // projection before continuing the ordinary round.
      await this.commitPluginData((pluginData) => ({
        ...clearPlanReviewData(pluginData),
        [KEY_PENDING_CONFLICTS]: [],
        [KEY_PENDING_DELETES]: [],
        [KEY_PENDING_ISSUES]: [],
        [KEY_LOCAL_FOLDER_MOVE_HINTS]: [],
        [KEY_GENERATION]: pluginData[KEY_GENERATION] + 1,
      }));
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
    if (!resolved) {
      throw new Error("V2 committed scope recovery was not resolved");
    }
    return resolved;
  }

  /**
   * Atomically replace a held V2 scope with an already proven recovery
   * candidate. The transition store owns envelope/manifest/witness recovery;
   * this controller activates only the fully reloaded target generation.
   */
  async commitV2RemoteScopeRecoveryCandidate(
    candidate: SyncStateEnvelopeV2,
    now = Date.now(),
    nextProtocolBinding?: SharedSyncProtocolBinding,
  ): Promise<SyncStateEnvelopeV2> {
    let committed: SyncStateEnvelopeV2 | null = null;
    const task = this.v2StateCommitQueue.then(async () => {
      if (this.v2StateLoadBlock) {
        throw new Error("V2 scope recovery cannot commit during load recovery");
      }
      if (
        !this.v2Store
        || !this.v2Envelope
        || !this.v2Envelope.remoteScopeRecovery
        || !this.v2ScopeTransitionStore
        || !this.v2AuthorityWitnessStore
      ) {
        throw new Error("V2 scope recovery controller is not ready");
      }
      if (
        this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
        || await this.v2Store.hasRecoveryJournal()
      ) {
        throw new Error(
          "V2 scope recovery cannot commit while mutation or state recovery is unresolved",
        );
      }
      const paths = getEasySyncPaths(
        this.plugin.app.vault,
        this.plugin.manifest.id,
      );
      const sourceManifest = await readStateV2Manifest(
        this.plugin.app.vault.adapter,
        paths.stateV2ManifestFile,
      );
      let sourceWitness = await this.v2AuthorityWitnessStore.load();
      if (
        !sourceManifest
        || sourceWitness?.status !== "active"
        || !sameStateV2AuthorityManifest(sourceWitness, sourceManifest)
        || !sameSyncScope(sourceManifest.scope, this.v2Envelope.scope)
      ) {
        throw new Error(
          "V2 scope recovery manifest or authority witness changed",
        );
      }
      sourceWitness = await this.selectJsonV2Storage(
        sourceManifest,
        sourceWitness,
      );
      const sourceEnvelope = structuredClone(this.v2Envelope);
      await this.v2ScopeTransitionStore.commit({
        sourceEnvelope,
        candidate,
        sourceManifest,
        sourceWitness,
        ...(nextProtocolBinding
          ? { nextProtocolBinding }
          : {}),
        now,
      });
      const store = this.createV2Store(paths);
      const reloaded = await store.load(candidate.scope);
      if (
        !reloaded
        || JSON.stringify(reloaded) !== JSON.stringify(candidate)
      ) {
        throw new Error("V2 scope recovery candidate failed final reload");
      }
      this.v2Store = store;
      this.activateV2Envelope(reloaded);
      this.legacyStateAllowed = false;
      this.remoteState = null;
      committed = structuredClone(reloaded);
      const targetManifest = await readStateV2Manifest(
        this.plugin.app.vault.adapter,
        paths.stateV2ManifestFile,
      );
      const targetWitness = await this.v2AuthorityWitnessStore.load();
      if (
        !targetManifest
        || !targetWitness
        || !sameStateV2AuthorityManifest(targetWitness, targetManifest)
      ) {
        throw new Error(
          "V2 scope recovery target authority could not be reloaded",
        );
      }
      await this.maybeSelectIndexedDbStorage(
        paths,
        targetManifest,
        targetWitness,
        reloaded,
      );

      // All device-local decisions were bound to the unreachable source
      // scope. They cannot authorize the target scope; discard them only after
      // the target authority is durable and readable.
      await this.commitPluginData((current) => ({
        ...clearPlanReviewData(current),
        [KEY_PENDING_CONFLICTS]: [],
        [KEY_PENDING_DELETES]: [],
        [KEY_PENDING_ISSUES]: [],
        [KEY_LOCAL_FOLDER_MOVE_HINTS]: [],
        [KEY_GENERATION]: current[KEY_GENERATION] + 1,
      }));
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
    if (!committed) {
      throw new Error("V2 scope recovery candidate was not committed");
    }
    return committed;
  }

  /**
   * Expose public 1.1.3 state as a capability-free migration value.
   *
   * The returned object has no writer and is detached from StateManager's
   * mutable in-memory state. Production migration planning must use this
   * snapshot instead of advancing V1 state while it discovers live facts.
   */
  async readPublic113MigrationInput(): Promise<Public113MigrationInput> {
    if (this.v2Envelope || !this.legacyStateAllowed) {
      throw new Error("Public 1.1.3 migration input is unavailable after V2 activation");
    }
    const pluginData = await this.plugin.loadData() ?? {};
    let baseContentStatus: Public113MigrationInput["baseContentStatus"] =
      "missing";
    let baseContentRaw: string | null = null;
    let baseContentEntries: Record<string, string> = {};
    const baseContentPath = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    ).baseContentFile;
    const legacyBaseContentPath = getEasySyncLegacyPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    ).baseContentFile;
    try {
      const readablePath = await this.plugin.app.vault.adapter.exists(baseContentPath)
        ? baseContentPath
        : legacyBaseContentPath;
      if (await this.plugin.app.vault.adapter.exists(readablePath)) {
        try {
          baseContentRaw =
            await this.plugin.app.vault.adapter.read(readablePath);
          const parsed: unknown = JSON.parse(baseContentRaw);
          if (isStringRecord(parsed)) {
            baseContentStatus = "valid";
            baseContentEntries = structuredClone(parsed);
          } else {
            baseContentStatus = "invalid";
          }
        } catch {
          baseContentStatus = baseContentRaw === null
            ? "unreadable"
            : "invalid";
        }
      }
    } catch {
      baseContentStatus = "unreadable";
    }
    return createPublic113MigrationInput({
      lifecycleEpoch: this.data[KEY_GENERATION],
      pluginData,
      remoteState: this.remoteState,
      baseEntries: Object.values(this.data[KEY_BASE_SNAPSHOT]),
      baseContentEntries,
      baseContentRaw,
      baseContentStatus,
    });
  }

  /**
   * Distinguish real public-1.1.3 participation from current-version defaults.
   * Settings and account binding are deliberately not evidence because the
   * current build can persist both before its first sync.
   */
  hasPublic113MigrationEvidence(
    input: Readonly<Public113MigrationInput>,
  ): boolean {
    return input.remoteState !== null
      || input.baseEntries.length > 0
      || input.baseContentStatus !== "missing"
      || this.data[KEY_GENERATION] > 0
      || this.data[KEY_LAST_SYNC_TIME] > 0
      || this.data[KEY_PLAN_REVIEW_ACTIVE]
      || this.mutationLedger.length > 0
      || this.data[KEY_PENDING_CONFLICTS].length > 0
      || this.data[KEY_PENDING_ISSUES].length > 0
      || this.data[KEY_PENDING_DELETES].length > 0;
  }

  /**
   * Prepare the inactive public-1.1.3 candidate and return its source-bound
   * planner view directly from IndexedDB rows. JSON remains the only authority;
   * this method performs no manifest, PluginData, Graph or Vault mutation.
   */
  async preparePublic113IndexedDbPlannerState(
    candidate: SyncStateEnvelopeV2,
    source: Public113MigrationInput,
    now = Date.now(),
  ): Promise<CanonicalPlannerStateV2 | null> {
    const factory = this.plugin.createPublic113IndexedDbCandidateStore;
    if (!factory) return null;
    const requestedSourceDigest = await public113MigrationInputDigest(source);
    const currentSource = await this.readPublic113MigrationInput();
    if (
      await public113MigrationInputDigest(currentSource)
      !== requestedSourceDigest
    ) {
      throw new Error(
        "Public 1.1.3 input changed before IndexedDB planner preparation",
      );
    }
    const store = factory(requestedSourceDigest);
    if (typeof store.loadPreparedPlannerView !== "function") {
      await store.close();
      return null;
    }
    try {
      await store.stageCandidate(candidate, {
        sourceStateDigest: requestedSourceDigest,
        now,
      });
      const view = await store.loadPreparedPlannerView(
        requestedSourceDigest,
      );
      const postPreparationSource = await this.readPublic113MigrationInput();
      const postPreparationDigest =
        await public113MigrationInputDigest(postPreparationSource);
      if (postPreparationDigest !== requestedSourceDigest) {
        await store.delete();
        throw new Error(
          "Public 1.1.3 input changed during IndexedDB planner preparation",
        );
      }
      return view.state;
    } finally {
      await store.close();
    }
  }

  /**
   * Publish only base-content values that exactly match the public 1.1.3
   * base hash and byte size. The returned hashes are safe for a pure
   * migration candidate to reference; rejected or failed objects simply keep
   * automatic merge unavailable for that path.
   */
  async preparePublic113MigrationAncestors(
    source: Public113MigrationInput,
  ): Promise<Public113AncestorPreparation> {
    if (this.v2Envelope || !this.legacyStateAllowed) {
      throw new Error(
        "Public 1.1.3 ancestors are unavailable after V2 activation",
      );
    }
    const baseByPath = new Map(
      source.baseEntries.map((entry) => [entry.path, entry]),
    );
    const hashesByPath: Record<string, string> = {};
    let rejected = 0;
    let unavailable = 0;
    const store = this.createAncestorStoreV2();
    this.ancestorStoreV2 = store;
    const entries = (
      source.baseContentStatus === "valid"
        ? Object.entries(source.baseContentEntries)
        : []
    ).sort(([left], [right]) => left.localeCompare(right));
    for (const [path, content] of entries) {
      const base = baseByPath.get(path);
      const bytes = new TextEncoder().encode(content).buffer;
      if (
        !base
        || bytes.byteLength !== base.size
        || await sha256Hex(bytes) !== base.hash
      ) {
        rejected++;
        continue;
      }
      try {
        const hash = await store.putText(bytes);
        if (hash === base.hash) hashesByPath[path] = hash;
        else unavailable++;
      } catch {
        unavailable++;
      }
    }
    return {
      hashesByPath,
      sourceEntries: entries.length,
      published: Object.keys(hashesByPath).length,
      rejected,
      unavailable,
    };
  }

  /**
   * Reconcile non-authoritative migration artifacts before a candidate is
   * reviewed or published. A manifest or authority witness is never removed:
   * either one immediately closes the V1 writer. With neither present, stale
   * envelope/backup files are only prepared state and may be discarded so a
   * newly reviewed candidate does not become permanently wedged behind them.
   */
  private async reconcilePreManifestMigrationArtifacts(input: {
    candidate: SyncStateEnvelopeV2;
    source: Public113MigrationInput;
    forceReplace?: boolean;
  }): Promise<string> {
    if (this.v2Envelope || !this.legacyStateAllowed || this.v2StateLoadBlock) {
      throw new Error("Pre-manifest migration artifacts are not writable");
    }
    const currentSource = await this.readPublic113MigrationInput();
    const [sourceDigest, currentDigest] = await Promise.all([
      public113MigrationInputDigest(input.source),
      public113MigrationInputDigest(currentSource),
    ]);
    if (sourceDigest !== currentDigest) {
      throw new Error("Public 1.1.3 migration input changed before review");
    }

    const paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const adapter = this.plugin.app.vault.adapter;
    let manifestPresent: boolean;
    let witnessPresent: boolean;
    try {
      manifestPresent = await adapter.exists(paths.stateV2ManifestFile);
      witnessPresent =
        await adapter.exists(paths.stateV2AuthorityWitnessFile)
        || await adapter.exists(paths.stateV2AuthorityWitnessNextFile);
    } catch {
      this.legacyStateAllowed = false;
      this.remoteState = null;
      this.setV2StateLoadBlock("manifest-presence-unreadable", "unknown");
      throw new Error("Migration authority presence became unreadable");
    }
    if (manifestPresent || witnessPresent) {
      this.legacyStateAllowed = false;
      this.remoteState = null;
      this.setV2StateLoadBlock(
        manifestPresent
          ? "migration-authority-commit-interrupted"
          : "authority-witness-manifest-missing",
        "v2",
      );
      throw new Error("V2 migration authority is already durable");
    }

    const store = this.createV2Store(paths);
    let preparedEnvelope: SyncStateEnvelopeV2 | null = null;
    let preparedEnvelopeReadable = true;
    try {
      preparedEnvelope = await store.load(input.candidate.scope);
    } catch {
      preparedEnvelopeReadable = false;
    }
    const backupMatches = await this.preManifestBackupMatches(
      paths.stateV1BackupFile,
      createPublic113BackupSnapshot(input.source, sourceDigest),
    );
    if (
      input.forceReplace
      || !preparedEnvelopeReadable
      || (
        preparedEnvelope
        && !sameStateV2MigrationCandidate(
          preparedEnvelope,
          input.candidate,
        )
      )
      || backupMatches === false
    ) {
      await this.discardPreManifestMigrationArtifacts(paths);
    }
    return sourceDigest;
  }

  private async preManifestBackupMatches(
    path: string,
    snapshot: unknown,
  ): Promise<boolean | null> {
    const adapter = this.plugin.app.vault.adapter;
    if (!await adapter.exists(path)) return null;
    try {
      const backup = JSON.parse(await adapter.read(path)) as unknown;
      return isRecord(backup)
        && backup.schemaVersion === 1
        && Number.isFinite(backup.createdAt)
        && "snapshot" in backup
        && JSON.stringify(backup.snapshot) === JSON.stringify(snapshot);
    } catch {
      return false;
    }
  }

  private async discardPreManifestMigrationArtifacts(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    for (const path of [
      paths.stateV2File,
      paths.stateV2NextFile,
      paths.stateV2PreviousFile,
      paths.stateV2RecoveryFile,
      paths.stateV2ManifestNextFile,
      paths.stateV1BackupFile,
    ]) {
      if (await adapter.exists(path)) await adapter.remove(path);
    }
  }

  private async blockIfMigrationManifestBecameDurable(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    let manifestPresent: boolean;
    try {
      manifestPresent = await adapter.exists(paths.stateV2ManifestFile);
    } catch {
      this.legacyStateAllowed = false;
      this.remoteState = null;
      this.setV2StateLoadBlock("manifest-presence-unreadable", "unknown");
      return;
    }
    if (!manifestPresent) return;
    this.legacyStateAllowed = false;
    this.remoteState = null;
    this.setV2StateLoadBlock(
      "migration-authority-commit-interrupted",
      "v2",
    );
  }

  /**
   * Activate the exact caller-proven, sealed zero-plan candidate.
   *
   * The production orchestrator owns the complete scan and zero-plan gate.
   * This method owns the original public-1.1.3 backup, envelope -> manifest
   * transaction, and in-memory owner switch. It never prepares or writes a V1
   * remote/base state as an activation prerequisite.
   */
  async activatePreparedV2MigrationCandidate(
    input: StateV2PreparedActivationInput,
  ): Promise<StateV2MigrationResult> {
    if (this.v2Envelope || !this.legacyStateAllowed) {
      throw new Error("V2 file state is already active");
    }
    const purpose = input.purpose ?? "zero-plan";
    const legacyMutationLedger = parseMutationLedger(
      input.source.pluginData[KEY_PUBLIC_MUTATION_LEDGER],
    );
    if (
      this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || (
        purpose === "zero-plan"
        && this.mutationLedger.length > 0
      )
      || (
        purpose === "legacy-mutation-recovery"
        && (
          this.mutationLedger.length === 0
          || legacyMutationLedger.length
            !== this.mutationLedger.length
          || !sameMutationLedger(legacyMutationLedger, this.mutationLedger)
        )
      )
    ) {
      throw new Error(
        "Cannot activate V2 from the current mutation recovery state",
      );
    }
    if (
      input.source.kind !== "public-1.1.3-read-only-input"
      || input.source.lifecycleEpoch !== this.data[KEY_GENERATION]
      || input.candidate.meta.lifecycleEpoch !== input.source.lifecycleEpoch + 1
    ) {
      throw new Error("Public 1.1.3 migration input changed before V2 activation");
    }

    const paths = getEasySyncPaths(this.plugin.app.vault, this.plugin.manifest.id);
    const sourceStateDigest =
      await this.reconcilePreManifestMigrationArtifacts({
      candidate: input.candidate,
      source: input.source,
    });
    let result: StateV2MigrationResult;
    try {
      result = await commitReviewedStateV2MigrationCandidate(
        this.plugin.app.vault.adapter,
        {
          committed: paths.stateV2File,
          next: paths.stateV2NextFile,
          previous: paths.stateV2PreviousFile,
          recovery: paths.stateV2RecoveryFile,
          manifest: paths.stateV2ManifestFile,
          manifestNext: paths.stateV2ManifestNextFile,
          v1Backup: paths.stateV1BackupFile,
        },
        {
          candidate: input.candidate,
          canonicalIdentity: input.canonicalIdentity,
          v1Snapshot: createPublic113BackupSnapshot(
            input.source,
            sourceStateDigest,
          ),
          ancestorExists: (hash) =>
            (this.ancestorStoreV2 ?? this.createAncestorStoreV2()).has(hash),
          now: input.now,
        },
      );
    } catch (error) {
      await this.blockIfMigrationManifestBecameDurable(paths);
      throw error;
    }
    if (result.status !== "committed" && result.status !== "already-committed") {
      await this.blockIfMigrationManifestBecameDurable(paths);
      return result;
    }
    if (!result.manifest || !result.envelope || result.pending.length > 0) {
      throw new Error("V2 migration committed without a complete activation state");
    }

    const store = this.createV2Store(paths);
    const committed = await store.load(result.manifest.scope);
    if (
      !committed
      || committed.meta.commitSeq < result.manifest.stateCommitSeq
      || committed.meta.lifecycleEpoch < result.manifest.lifecycleEpoch
    ) {
      throw new Error("V2 activation could not load its committed envelope");
    }
    this.v2Store = store;
    this.activateV2Envelope(committed);
    this.remoteState = null;
    this.legacyStateAllowed = false;
    let authorityWitness: StateV2AuthorityWitness;
    try {
      const witnessStore = this.v2AuthorityWitnessStore
        ?? this.createV2AuthorityWitnessStore(paths);
      this.v2AuthorityWitnessStore = witnessStore;
      authorityWitness = await witnessStore.publishActive(
        result.manifest,
        input.now ?? Date.now(),
      );
    } catch (error) {
      this.setV2StateLoadBlock(
        "authority-witness-save-failed",
        "v2",
        error,
      );
      throw error;
    }
    const cutoverFailure = await this.finalizePublic113CutoverIfRequired(
      paths,
      input.now ?? Date.now(),
    );
    if (cutoverFailure) {
      this.setV2StateLoadBlock(cutoverFailure, "v2");
      throw new Error(
        "Public 1.1.3 control state could not be finalized after V2 activation",
      );
    }
    try {
      await this.migrateActiveMutationLedgerKeyIfRequired();
    } catch (error) {
      this.setV2StateLoadBlock(
        "v2-mutation-ledger-migration-failed",
        "v2",
        error,
      );
      throw error;
    }
    try {
      await this.maybeSelectIndexedDbStorage(
        paths,
        result.manifest,
        authorityWitness,
        committed,
      );
    } catch (error) {
      this.setV2StateLoadBlock(
        "indexeddb-authority-load-failed",
        "v2",
        error,
      );
      throw error;
    }
    return result;
  }

  // ---- Mutation recovery ledger ----

  get mutationLedger(): readonly MutationLedgerEntryV1[] {
    const publicLedger = this.data[KEY_PUBLIC_MUTATION_LEDGER];
    const activeLedger = this.data[KEY_MUTATION_LEDGER];
    if (this.v2Envelope || !this.legacyStateAllowed) {
      // Existing V2 builds used the public key for active recovery. Keep the
      // evidence visible while a load block prevents its one-time migration.
      return selectActiveMutationLedger(publicLedger, activeLedger);
    }
    return publicLedger;
  }

  get manualMutationResolutionAudit():
    readonly ManualMutationResolutionAuditV1[] {
    return this.data[KEY_MANUAL_MUTATION_RESOLUTION_AUDIT];
  }

  /**
   * Bind the one published incomplete scope shape to the already committed
   * V2 authority without rewriting the retained public-1.1.3 evidence.
   *
   * Public 1.1.3 accepted an empty accountId in mutation intents. It remains
   * recoverable only after this device has committed V2 for the exact same
   * drive/vault/root identities and the cutover marker binds the source
   * backup. Non-empty account mismatches and every other scope mismatch stay
   * blocked.
   */
  prepareMutationRecoveryRecord(
    record: MutationLedgerEntryV1,
    scope: SyncScope,
  ): MutationLedgerEntryV1 | null {
    if (sameSyncScope(record.intent.scope, scope)) return record;
    if (
      !this.v2Envelope
      || !sameSyncScope(this.v2Envelope.scope, scope)
      || !this.data[KEY_PUBLIC_113_CUTOVER]
      || record.intent.version !== 1
      || record.intent.scope.accountId !== ""
      || record.intent.scope.driveId !== scope.driveId
      || record.intent.scope.vaultFolderId !== scope.vaultFolderId
      || record.intent.scope.filesRootId !== scope.filesRootId
    ) {
      return null;
    }
    const rebound = structuredClone(record);
    rebound.intent.scope = {
      ...rebound.intent.scope,
      accountId: scope.accountId,
    };
    return rebound;
  }

  get mutationRecoveryQuarantine():
    readonly MutationRecoveryQuarantineEntryV2[] {
    return this.data[KEY_V2_RECOVERY_QUARANTINE];
  }

  get localFolderMoveHints(): readonly LocalFolderMoveHintV1[] {
    return this.data[KEY_LOCAL_FOLDER_MOVE_HINTS];
  }

  /**
   * Retain a TFolder rename as device-local identity evidence. The event is
   * accepted only when its source path is already bound to one committed V2
   * folder ID. The planner still has to prove complete local/remote facts.
   */
  async recordLocalFolderMoveHint(
    fromPath: string,
    toPath: string,
    observedAt = Date.now(),
  ): Promise<boolean> {
    if (
      this.v2StateLoadBlock
      || !this.v2Envelope?.folderAnchors
      || !isVaultRelativeMutationPath(fromPath)
      || !isVaultRelativeMutationPath(toPath)
      || normalizeFolderIdentityPath(fromPath) === normalizeFolderIdentityPath(toPath)
    ) return false;

    const directAnchor = Object.values(this.v2Envelope.folderAnchors.byAnchorId).find(
      (anchor) => anchor.lastPath.normalize("NFC") === fromPath.normalize("NFC"),
    );
    const chained = this.data[KEY_LOCAL_FOLDER_MOVE_HINTS].find(
      (hint) => sameSyncScope(hint.scope, this.v2Envelope!.scope)
        && hint.toPath.normalize("NFC") === fromPath.normalize("NFC"),
    );
    const remoteId = directAnchor?.remoteId ?? chained?.remoteId;
    if (!remoteId) return false;
    const originalFrom = chained?.fromPath ?? fromPath;

    await this.commitPluginData((current) => {
      const retained = current[KEY_LOCAL_FOLDER_MOVE_HINTS].filter(
        (hint) => hint.remoteId !== remoteId,
      );
      if (normalizeFolderIdentityPath(originalFrom) === normalizeFolderIdentityPath(toPath)) {
        return retained.length === current[KEY_LOCAL_FOLDER_MOVE_HINTS].length
          ? current
          : { ...current, [KEY_LOCAL_FOLDER_MOVE_HINTS]: retained };
      }
      const next: LocalFolderMoveHintV1 = {
        version: 1,
        scope: { ...this.v2Envelope!.scope },
        remoteId,
        fromPath: originalFrom,
        toPath,
        observedAt,
      };
      return {
        ...current,
        [KEY_LOCAL_FOLDER_MOVE_HINTS]: [...retained, next]
          .sort((left, right) => left.remoteId.localeCompare(right.remoteId)),
      };
    });
    return true;
  }

  get hasMutationLedgerCorruption(): boolean {
    return this.mutationLedgerCorrupt;
  }

  get hasMutationRecoveryQuarantineCorruption(): boolean {
    return this.mutationRecoveryQuarantineCorrupt;
  }

  /**
   * Atomically retire one receipted upload that is proven absent from both
   * sides while retaining its complete recovery evidence under V2 authority.
   *
   * This is not a checkpoint: no external mutation is claimed and the V2
   * envelope is intentionally unchanged. PluginData publication moves the
   * exact record from the active ledger into the append-only quarantine in one
   * durable write, so a failed save leaves the ledger blocking as before.
   */
  async quarantineUnreachableUploadReceipt(input: {
    record: MutationLedgerEntryV1;
    remoteId: string;
    localMissing: true;
    graphItemMissing: true;
    now?: number;
  }): Promise<MutationRecoveryQuarantineEntryV2> {
    const pathView = this.getV2PathView();
    if (
      this.v2StateLoadBlock
      || !this.v2Envelope
      || !pathView
      || !this.v2Store
      || this.legacyStateAllowed
    ) {
      throw new Error("V2 mutation quarantine requires active V2 authority");
    }
    if (
      this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
    ) {
      throw new Error("V2 mutation quarantine state is corrupt");
    }
    const { record } = input;
    const recordIndex = findUniqueMutationLedgerRecordIndex(
      this.data[KEY_MUTATION_LEDGER],
      record.intent.operationId,
    );
    const durableRecord = recordIndex < 0
      ? undefined
      : this.data[KEY_MUTATION_LEDGER][recordIndex];
    const preparedDurableRecord = durableRecord
      ? this.prepareMutationRecoveryRecord(
          durableRecord,
          this.v2Envelope.scope,
        )
      : null;
    if (
      !durableRecord
      || !preparedDurableRecord
      || JSON.stringify(preparedDurableRecord) !== JSON.stringify(record)
      || record.intent.action !== "upload"
      || !record.receipt
      || !isOrdinaryFileRecoveryRecord(record, this.v2Envelope.scope)
      || !sameSyncScope(record.intent.scope, this.v2Envelope.scope)
      || this.v2Envelope.remoteIndex.complete !== true
    ) {
      throw new Error("Only a bound receipted V2 upload may be quarantined");
    }
    const upserts = record.receipt.checkpoint.remoteUpserts.filter(
      (entry) =>
        entry.path === record.intent.path
        && entry.driveId === input.remoteId,
    );
    if (upserts.length !== 1) {
      throw new Error("V2 mutation quarantine remote identity is ambiguous");
    }
    if (
      pathView.remoteEntries.some(
        (entry) =>
          entry.path === record.intent.path
          || entry.driveId === input.remoteId,
      )
    ) {
      throw new Error("V2 mutation quarantine remote identity is still present");
    }

    const entry: MutationRecoveryQuarantineEntryV2 = {
      version: 2,
      kind: "mutation-recovery-quarantine",
      operationId: record.intent.operationId,
      reason: "receipted-upload-version-unreachable",
      quarantinedAt: input.now ?? Date.now(),
      scope: { ...this.v2Envelope.scope },
      sourceCommitSeq: this.v2Envelope.meta.commitSeq,
      remoteId: input.remoteId,
      evidence: {
        localMissing: input.localMissing,
        completeRemoteIndex: true,
        remotePathMissing: true,
        remoteIdMissing: true,
        graphItemMissing: input.graphItemMissing,
      },
      record: structuredClone(durableRecord),
    };
    await this.commitPluginData((current) => {
      const activeIndex = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        record.intent.operationId,
      );
      const active = activeIndex < 0
        ? undefined
        : current[KEY_MUTATION_LEDGER][activeIndex];
      const existing = current[KEY_V2_RECOVERY_QUARANTINE].find(
        (candidate) => candidate.operationId === record.intent.operationId,
      );
      if (!active) {
        if (
          existing
          && JSON.stringify(existing.record) === JSON.stringify(durableRecord)
        ) return current;
        throw new Error(
          `Mutation intent missing for quarantine: ${record.intent.operationId}`,
        );
      }
      if (JSON.stringify(active) !== JSON.stringify(durableRecord)) {
        throw new Error(
          `Mutation changed before quarantine: ${record.intent.operationId}`,
        );
      }
      if (existing) {
        throw new Error(
          `Mutation quarantine already exists: ${record.intent.operationId}`,
        );
      }
      return {
        ...current,
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (_candidate, index) => index !== activeIndex,
        ),
        [KEY_V2_RECOVERY_QUARANTINE]: [
          ...current[KEY_V2_RECOVERY_QUARANTINE],
          entry,
        ],
      };
    });
    return structuredClone(
      this.data[KEY_V2_RECOVERY_QUARANTINE].find(
        (candidate) => candidate.operationId === record.intent.operationId,
      ) ?? entry,
    );
  }

  async beginMutationIntent(intent: MutationIntent): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation intent requires active V2 authority");
    }
    if (this.mutationLedgerCorrupt) throw new Error("Mutation recovery ledger is corrupt");
    await this.commitPluginData((current) => {
      if (current[KEY_MUTATION_LEDGER].some((entry) => entry.intent.operationId === intent.operationId)) {
        throw new Error(`Duplicate mutation operation: ${intent.operationId}`);
      }
      if (current[KEY_MUTATION_LEDGER].some((entry) => entry.intent.path === intent.path)) {
        throw new Error(`Mutation already pending for path: ${intent.path}`);
      }
      return {
        ...current,
        [KEY_MUTATION_LEDGER]: [
          ...current[KEY_MUTATION_LEDGER],
          { intent, receipt: null },
        ],
      };
    });
  }

  /**
   * Persist one whole-plugin choice before any member mutation. The exact
   * predecessor ledger and ordinary conflict decisions remain in place until
   * the bundle reaches its final checkpoint.
   */
  async beginCommunityPluginBundleSettlement(
    expectedRecords: readonly Readonly<MutationLedgerEntryV1>[],
    expectedConflicts: readonly Readonly<SyncPlanItem>[],
    entry: Readonly<MutationLedgerEntryV1>,
  ): Promise<boolean> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Plugin bundle settlement requires active V2 authority");
    }
    if (
      this.mutationLedgerCorrupt
      || this.data[KEY_PUBLIC_MUTATION_LEDGER].length > 0
      || !isCommunityPluginBundleSettlementEntry(entry)
      || !sameSyncScope(entry.intent.scope, this.v2Envelope.scope)
    ) {
      throw new Error("Plugin bundle settlement evidence is invalid");
    }
    const settlement = entry.manualResolution;
    const expectedOperationIds = expectedRecords
      .map((record) => record.intent.operationId)
      .sort((left, right) => left.localeCompare(right));
    const allowedPredecessorPaths = new Set([
      `${settlement.pluginRoot}/main.js`,
      `${settlement.pluginRoot}/manifest.json`,
      `${settlement.pluginRoot}/styles.css`,
    ]);
    if (
      JSON.stringify(expectedOperationIds)
        !== JSON.stringify(settlement.predecessorOperationIds)
      || expectedRecords.some((record) =>
        record.intent.version !== 1
        || record.intent.action !== "upload"
        || record.intent.stateEffect !== undefined
        || record.intent.sourcePath !== undefined
        || record.receipt !== null
        || record.manualResolution !== undefined
        || !sameSyncScope(record.intent.scope, settlement.intent.scope)
        || !allowedPredecessorPaths.has(record.intent.path))
      || expectedConflicts.length !== settlement.conflictDecisions.length
    ) {
      throw new Error("Plugin bundle settlement evidence is invalid");
    }
    let persisted = false;
    await this.commitPluginData((current) => {
      const existing = current[KEY_MUTATION_LEDGER].find(
        (candidate) =>
          candidate.intent.operationId === entry.intent.operationId,
      );
      const currentPredecessors = settlement.predecessorOperationIds.map(
        (operationId) => current[KEY_MUTATION_LEDGER].find(
          (candidate) => candidate.intent.operationId === operationId,
        ),
      );
      const unexpectedBundleRecord = current[KEY_MUTATION_LEDGER].find(
        (candidate) =>
          candidate !== existing
          && candidate.manualResolution?.version === 2
          && candidate.manualResolution.pluginRoot === settlement.pluginRoot,
      );
      if (
        currentPredecessors.some((record) => !record)
        || !sameMutationLedger(
          currentPredecessors as MutationLedgerEntryV1[],
          expectedOperationIds.map((operationId) => expectedRecords.find(
            (record) => record.intent.operationId === operationId,
          )!),
        )
        || unexpectedBundleRecord
        || (existing && JSON.stringify(existing) !== JSON.stringify(entry))
      ) {
        throw new Error("Plugin bundle settlement predecessors changed");
      }
      for (const expected of expectedConflicts) {
        const active = current[KEY_PENDING_CONFLICTS].find(
          (candidate) => candidate.path === expected.path,
        );
        const bound = settlement.conflictDecisions.find(
          (candidate) => candidate.path === expected.path,
        );
        if (
          !active
          || !bound
          || JSON.stringify(active) !== JSON.stringify(expected)
          || JSON.stringify(bound.decisionToken)
            !== JSON.stringify(expected.decisionToken)
        ) {
          throw new Error("Plugin bundle settlement conflicts changed");
        }
      }
      persisted = true;
      if (existing) return current;
      return {
        ...current,
        [KEY_MUTATION_LEDGER]: [
          ...current[KEY_MUTATION_LEDGER],
          structuredClone(entry),
        ],
      };
    });
    return persisted;
  }

  /** Persist verified bundle-member receipts without losing earlier progress. */
  async recordCommunityPluginBundleSettlementReceipts(
    expectedEntry: Readonly<MutationLedgerEntryV1>,
    receipts: readonly Readonly<MutationReceiptV1>[],
  ): Promise<boolean> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Plugin bundle receipts require active V2 authority");
    }
    if (
      this.mutationLedgerCorrupt
      || !isCommunityPluginBundleSettlementEntry(expectedEntry)
    ) {
      throw new Error("Plugin bundle receipt evidence is invalid");
    }
    const settlement = expectedEntry.manualResolution;
    const receiptByOperationId = new Map(
      receipts.map((receipt) => [receipt.operationId, receipt]),
    );
    if (
      receipts.length === 0
      || receiptByOperationId.size !== receipts.length
      || receipts.some((receipt) => !settlement.members.some(
        (member) => member.intent.operationId === receipt.operationId,
      ))
      || receipts.some((receipt) => {
        const member = settlement.members.find(
          (candidate) => candidate.intent.operationId === receipt.operationId,
        );
        return Boolean(member?.receipt
          && JSON.stringify(member.receipt) !== JSON.stringify(receipt));
      })
    ) throw new Error("Plugin bundle receipts are invalid");
    const nextEntry: MutationLedgerEntryV1 = {
      ...expectedEntry,
      manualResolution: {
        ...settlement,
        members: settlement.members.map((member) => ({
          ...member,
          receipt: receiptByOperationId.has(member.intent.operationId)
            ? structuredClone(receiptByOperationId.get(member.intent.operationId)!)
            : member.receipt,
        })),
      },
    };
    if (!isCommunityPluginBundleSettlementEntry(nextEntry)) {
      throw new Error("Plugin bundle receipts are invalid");
    }
    let persisted = false;
    await this.commitPluginData((current) => {
      const index = current[KEY_MUTATION_LEDGER].findIndex(
        (candidate) =>
          candidate.intent.operationId === expectedEntry.intent.operationId,
      );
      if (index < 0) throw new Error("Plugin bundle settlement is missing");
      const active = current[KEY_MUTATION_LEDGER][index];
      if (JSON.stringify(active) === JSON.stringify(nextEntry)) {
        persisted = true;
        return current;
      }
      if (JSON.stringify(active) !== JSON.stringify(expectedEntry)) {
        throw new Error("Plugin bundle settlement changed before receipt");
      }
      const entries = [...current[KEY_MUTATION_LEDGER]];
      entries[index] = nextEntry;
      persisted = true;
      return { ...current, [KEY_MUTATION_LEDGER]: entries };
    });
    return persisted;
  }

  /**
   * Publish all reviewed member checkpoints as one V2 revision, then retire
   * the coordinator, its exact predecessors, and its exact conflicts.
   */
  async commitCommunityPluginBundleSettlementCheckpoint(
    expectedEntry: Readonly<MutationLedgerEntryV1>,
  ): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Plugin bundle checkpoint requires active V2 authority");
    }
    if (
      this.mutationLedgerCorrupt
      || !isCommunityPluginBundleSettlementEntry(expectedEntry)
      || !sameSyncScope(expectedEntry.intent.scope, this.v2Envelope.scope)
    ) {
      throw new Error("Plugin bundle checkpoint evidence is invalid");
    }
    const settlement = expectedEntry.manualResolution;
    if (settlement.members.some((member) => !member.receipt)) {
      throw new Error("Plugin bundle receipts are incomplete");
    }
    const assertCurrentEvidence = (
      current: Readonly<PluginData>,
    ): void => {
      const activeIndex = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        expectedEntry.intent.operationId,
      );
      const active = activeIndex < 0
        ? undefined
        : current[KEY_MUTATION_LEDGER][activeIndex];
      if (JSON.stringify(active) !== JSON.stringify(expectedEntry)) {
        throw new Error("Plugin bundle settlement changed before checkpoint");
      }
      for (const operationId of settlement.predecessorOperationIds) {
        const predecessorIndex = findUniqueMutationLedgerRecordIndex(
          current[KEY_MUTATION_LEDGER],
          operationId,
        );
        const predecessor = predecessorIndex < 0
          ? undefined
          : current[KEY_MUTATION_LEDGER][predecessorIndex];
        if (
          !predecessor
          || predecessor.receipt !== null
          || predecessor.manualResolution !== undefined
        ) {
          throw new Error("Plugin bundle predecessor changed before checkpoint");
        }
      }
      for (const conflict of settlement.conflictDecisions) {
        const activeConflict = current[KEY_PENDING_CONFLICTS].find(
          (candidate) => candidate.path === conflict.path,
        );
        if (
          !activeConflict?.decisionToken
          || JSON.stringify(activeConflict.decisionToken)
            !== JSON.stringify(conflict.decisionToken)
        ) {
          throw new Error("Plugin bundle conflict changed before checkpoint");
        }
      }
    };
    assertCurrentEvidence(this.data);
    const records = settlement.members.map((member) => ({
      intent: member.intent,
      receipt: member.receipt!,
    }));
    for (const record of records) {
      assertRemoteUpsertsHaveParentIdentity(record.receipt.checkpoint.remoteUpserts);
    }
    const baseUpserts = records.flatMap(
      (record) => record.receipt.checkpoint.baseUpserts,
    );
    const ancestorHashes = await this.publishPendingV2Ancestors(baseUpserts);
    await this.commitV2State((current) => {
      let reduced = current;
      let changed = false;
      let committedAt = current.meta.committedAt;
      for (const record of records) {
        const before = reduced;
        let next = reduceFileStateEnvelopeV2(before, record);
        if (Object.keys(ancestorHashes).length > 0) {
          next = attachBaseAncestorHashesV2(
            before,
            next,
            record.receipt.checkpoint.baseUpserts,
            ancestorHashes,
          );
        }
        if (next !== before) changed = true;
        reduced = next;
        committedAt = Math.max(committedAt, record.receipt.completedAt);
      }
      if (!changed) return current;
      const candidate: SyncStateEnvelopeV2 = {
        ...reduced,
        meta: {
          ...reduced.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt,
        },
      };
      validateEnvelope(candidate);
      return candidate;
    });
    this.clearPendingV2AncestorContent(baseUpserts);
    const retiredOperationIds = new Set([
      expectedEntry.intent.operationId,
      ...settlement.predecessorOperationIds,
    ]);
    const retiredConflictPaths = new Set(
      settlement.conflictDecisions.map((conflict) => conflict.path),
    );
    await this.commitPluginData((current) => {
      assertCurrentEvidence(current);
      const retiredIndexes = new Set([...retiredOperationIds].map(
        (operationId) => findUniqueMutationLedgerRecordIndex(
          current[KEY_MUTATION_LEDGER],
          operationId,
        ),
      ));
      return {
        ...current,
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (_candidate, index) => !retiredIndexes.has(index),
        ),
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (conflict) => !retiredConflictPaths.has(conflict.path),
        ),
      };
    });
  }

  /**
   * Attach one current-facts-bound user decision without replacing the
   * original recovery evidence. Older compatible builds ignore the optional
   * child and therefore continue to fail closed on the outer record.
   */
  async attachManualMutationResolution(
    expectedRecord: Readonly<MutationLedgerEntryV1>,
    resolution: Readonly<ManualMutationResolutionV1>,
  ): Promise<boolean> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Manual mutation resolution requires active V2 authority");
    }
    if (
      this.mutationLedgerCorrupt
      || !isManualMutationResolution(
        resolution,
        expectedRecord.intent,
        expectedRecord.receipt,
      )
      || !sameSyncScope(resolution.intent.scope, this.v2Envelope.scope)
      || resolution.intent.operationId === expectedRecord.intent.operationId
    ) {
      throw new Error("Manual mutation resolution evidence is invalid");
    }
    if (resolution.recoveryEvidence) {
      const collision = inspectReceiptedRenameAnchorCollisionV2(
        this.v2Envelope,
        expectedRecord,
      );
      if (
        !collision
        || JSON.stringify(collision.evidence) !== JSON.stringify(resolution.recoveryEvidence)
      ) {
        throw new Error("Manual mutation resolution evidence is invalid");
      }
    }
    let attached = false;
    await this.commitPluginData((current) => {
      const index = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        expectedRecord.intent.operationId,
      );
      if (index < 0) return current;
      const active = current[KEY_MUTATION_LEDGER][index];
      if (
        active.manualResolution
        || JSON.stringify(active) !== JSON.stringify(expectedRecord)
      ) return current;
      const entries = [...current[KEY_MUTATION_LEDGER]];
      entries[index] = {
        ...active,
        manualResolution: structuredClone(resolution),
      };
      attached = true;
      return { ...current, [KEY_MUTATION_LEDGER]: entries };
    });
    return attached;
  }

  /**
   * Replace one stale reviewed continuation with a fresh current-facts-bound
   * decision. The whole record, including its previous manual resolution, must
   * still be byte-identical to the reviewed expectation; otherwise the ledger
   * is left untouched. Whole-bundle settlements (version 2) are not accepted
   * here — they keep their own continuation contract.
   */
  async replaceManualMutationResolution(
    expectedRecord: Readonly<MutationLedgerEntryV1>,
    resolution: Readonly<ManualMutationResolutionV1>,
  ): Promise<boolean> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Manual mutation replacement requires active V2 authority");
    }
    if (
      this.mutationLedgerCorrupt
      || !isManualMutationResolution(
        resolution,
        expectedRecord.intent,
        expectedRecord.receipt,
      )
      || !sameSyncScope(resolution.intent.scope, this.v2Envelope.scope)
      || resolution.intent.operationId === expectedRecord.intent.operationId
      || resolution.recoveryEvidence !== undefined
    ) {
      throw new Error("Manual mutation replacement evidence is invalid");
    }
    let replaced = false;
    await this.commitPluginData((current) => {
      const index = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        expectedRecord.intent.operationId,
      );
      if (index < 0) return current;
      const active = current[KEY_MUTATION_LEDGER][index];
      if (
        !active.manualResolution
        || JSON.stringify(active) !== JSON.stringify(expectedRecord)
      ) return current;
      const entries = [...current[KEY_MUTATION_LEDGER]];
      entries[index] = {
        ...active,
        manualResolution: structuredClone(resolution),
      };
      replaced = true;
      return { ...current, [KEY_MUTATION_LEDGER]: entries };
    });
    return replaced;
  }

  async recordManualMutationResolutionReceipt(
    sourceOperationId: string,
    receipt: Readonly<MutationReceiptV1>,
  ): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Manual mutation receipt requires active V2 authority");
    }
    if (this.mutationLedgerCorrupt) {
      throw new Error("Mutation recovery ledger is corrupt");
    }
    await this.commitPluginData((current) => {
      const index = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        sourceOperationId,
      );
      if (index < 0) {
        throw new Error(`Mutation intent missing: ${sourceOperationId}`);
      }
      const active = current[KEY_MUTATION_LEDGER][index];
      const manual = active.manualResolution;
      if (
        !manual
        || manual.version !== 1
        || receipt.operationId !== manual.intent.operationId
      ) {
        throw new Error(`Manual mutation intent missing: ${sourceOperationId}`);
      }
      if (manual.receipt) {
        if (JSON.stringify(manual.receipt) === JSON.stringify(receipt)) return current;
        throw new Error(`Manual mutation receipt changed: ${sourceOperationId}`);
      }
      const entries = [...current[KEY_MUTATION_LEDGER]];
      entries[index] = {
        ...active,
        manualResolution: {
          ...manual,
          receipt: structuredClone(receipt),
        },
      };
      return { ...current, [KEY_MUTATION_LEDGER]: entries };
    });
  }

  /** Publish a reviewed continuation checkpoint, then retire its outer block. */
  async commitManualMutationResolutionCheckpoint(
    sourceOperationId: string,
  ): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Manual mutation checkpoint requires active V2 authority");
    }
    const recordIndex = findUniqueMutationLedgerRecordIndex(
      this.data[KEY_MUTATION_LEDGER],
      sourceOperationId,
    );
    const record = recordIndex < 0
      ? undefined
      : this.data[KEY_MUTATION_LEDGER][recordIndex];
    const manual = record?.manualResolution;
    if (!record || manual?.version !== 1 || !manual.receipt) {
      throw new Error(`Manual mutation receipt missing: ${sourceOperationId}`);
    }
    if (!sameSyncScope(manual.intent.scope, this.v2Envelope.scope)) {
      throw new Error(`Manual mutation scope no longer matches: ${sourceOperationId}`);
    }
    const checkpoint = manual.receipt.checkpoint;
    assertRemoteUpsertsHaveParentIdentity(checkpoint.remoteUpserts);
    const ancestorHashes = await this.publishPendingV2Ancestors(
      checkpoint.baseUpserts,
    );
    await this.commitV2State((current) => {
      const reduced = reduceFileStateEnvelopeV2(current, {
        intent: manual.intent,
        receipt: manual.receipt,
      });
      return Object.keys(ancestorHashes).length === 0
        ? reduced
        : attachBaseAncestorHashesV2(
            current,
            reduced,
            checkpoint.baseUpserts,
            ancestorHashes,
          );
    });
    this.clearPendingV2AncestorContent(checkpoint.baseUpserts);
    const audit: ManualMutationResolutionAuditV1 = {
      version: 1,
      sourceOperationId,
      resolutionOperationId: manual.intent.operationId,
      path: manual.intent.path,
      choice: manual.choice,
      action: manual.intent.action,
      externalMutation: manual.externalMutation,
      selectedAt: manual.selectedAt,
      completedAt: manual.receipt.completedAt,
    };
    await this.commitPluginData((current) => {
      const activeIndex = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        sourceOperationId,
      );
      const active = activeIndex < 0
        ? undefined
        : current[KEY_MUTATION_LEDGER][activeIndex];
      if (!active) {
        if (current[KEY_MANUAL_MUTATION_RESOLUTION_AUDIT].some(
          (entry) => entry.resolutionOperationId === manual.intent.operationId,
        )) return current;
        throw new Error(`Manual mutation intent missing: ${sourceOperationId}`);
      }
      if (JSON.stringify(active.manualResolution) !== JSON.stringify(manual)) {
        throw new Error(`Manual mutation changed before checkpoint: ${sourceOperationId}`);
      }
      return {
        ...current,
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (item) => !checkpoint.pendingConflictRemovals.includes(item.path),
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => !checkpoint.pendingDeleteRemovals.includes(item.path),
        ),
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (_entry, index) => index !== activeIndex,
        ),
        [KEY_MANUAL_MUTATION_RESOLUTION_AUDIT]: [
          ...current[KEY_MANUAL_MUTATION_RESOLUTION_AUDIT].filter(
            (entry) => entry.resolutionOperationId !== audit.resolutionOperationId,
          ),
          audit,
        ].slice(-20),
      };
    });
  }

  /**
   * Settle one stuck upload whose remote object was replaced by an identical
   * object under a new Graph identity. State-only: the envelope anchor is
   * rebound through the equal-read controller (identity lineage advance,
   * stable anchorId, eTag/path-collision CAS) and the exact ledger record is
   * retired with its stale pending delete in the same commit. No Vault or
   * Graph mutation is performed. A record changed since review returns false
   * and leaves the envelope publication in place for the next recovery round.
   */
  async settleReplacedIdentityUploadResolved(input: {
    expectedRecord: Readonly<MutationLedgerEntryV1>;
    entry: BaseFileEntry;
    oldRemoteId: string;
  }): Promise<boolean> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Replaced-identity rebind requires active V2 authority");
    }
    if (this.mutationLedgerCorrupt) {
      throw new Error("Mutation recovery ledger is corrupt");
    }
    await this.commitV2State((current) =>
      upsertBaseStateEnvelopeV2(current, [input.entry]));
    const operationId = input.expectedRecord.intent.operationId;
    const audit: ManualMutationResolutionAuditV1 = {
      version: 1,
      sourceOperationId: operationId,
      resolutionOperationId: `${operationId}-identical-rebind`,
      path: input.entry.path,
      choice: "keep-local",
      action: "upload",
      externalMutation: false,
      selectedAt: Date.now(),
      completedAt: Date.now(),
    };
    let retired = false;
    await this.commitPluginData((current) => {
      const index = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        operationId,
      );
      if (index < 0) return current;
      if (JSON.stringify(current[KEY_MUTATION_LEDGER][index])
        !== JSON.stringify(input.expectedRecord)) return current;
      retired = true;
      return {
        ...current,
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (_entry, entryIndex) => entryIndex !== index,
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => !(
            item.path === input.entry.path
            && item.decisionToken?.remote.exists === true
            && item.decisionToken.remote.driveId === input.oldRemoteId
          ),
        ),
        [KEY_MANUAL_MUTATION_RESOLUTION_AUDIT]: [
          ...current[KEY_MANUAL_MUTATION_RESOLUTION_AUDIT].filter(
            (entry) => entry.resolutionOperationId !== audit.resolutionOperationId,
          ),
          audit,
        ].slice(-20),
      };
    });
    return retired;
  }

  async recordMutationReceipt(receipt: MutationReceiptV1): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation receipt requires active V2 authority");
    }
    if (this.mutationLedgerCorrupt) throw new Error("Mutation recovery ledger is corrupt");
    await this.commitPluginData((current) => {
      const index = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        receipt.operationId,
      );
      if (index < 0) throw new Error(`Mutation intent missing: ${receipt.operationId}`);
      const entries = [...current[KEY_MUTATION_LEDGER]];
      const candidate = { ...entries[index], receipt };
      const preparedCandidate = this.prepareMutationRecoveryRecord(
        candidate,
        this.v2Envelope!.scope,
      );
      if (
        requiresOrdinaryFileRecoverySemanticGate(candidate)
        && (
          !preparedCandidate
          || !isOrdinaryFileRecoveryRecord(
            preparedCandidate,
            this.v2Envelope!.scope,
          )
        )
      ) {
        throw new Error(`Mutation receipt evidence is invalid: ${receipt.operationId}`);
      }
      entries[index] = candidate;
      return { ...current, [KEY_MUTATION_LEDGER]: entries };
    });
  }

  async abandonMutationIntent(operationId: string): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation abandon requires active V2 authority");
    }
    let abandonedPath: string | null = null;
    await this.commitPluginData((data) => {
      const currentIndex = findUniqueMutationLedgerRecordIndex(
        data[KEY_MUTATION_LEDGER],
        operationId,
      );
      const current = currentIndex < 0
        ? undefined
        : data[KEY_MUTATION_LEDGER][currentIndex];
      if (!current) return data;
      if (current.manualResolution) {
        throw new Error(`Cannot abandon reviewed mutation: ${operationId}`);
      }
      if (current.receipt) throw new Error(`Cannot abandon receipted mutation: ${operationId}`);
      const preparedCurrent = this.prepareMutationRecoveryRecord(
        current,
        this.v2Envelope!.scope,
      );
      if (
        requiresOrdinaryFileRecoverySemanticGate(current)
        && (
          !preparedCurrent
          || !isOrdinaryFileRecoveryRecord(
            preparedCurrent,
            this.v2Envelope!.scope,
          )
        )
      ) {
        throw new Error(`Mutation abandon evidence is invalid: ${operationId}`);
      }
      abandonedPath = current.intent.path;
      return {
        ...data,
        [KEY_MUTATION_LEDGER]: data[KEY_MUTATION_LEDGER].filter(
          (_entry, index) => index !== currentIndex,
        ),
      };
    });
    if (abandonedPath) this.pendingV2AncestorContent.delete(abandonedPath);
  }

  /**
   * Retire exact intent-only uploads after their owning paths are explicitly
   * leaving this device's sync scope. No local or remote file is changed; a
   * later re-entry must discover current facts through an ordinary scan.
   */
  async retireUnreceiptedMutationIntentsForScopeExit(
    expectedRecords: readonly Readonly<MutationLedgerEntryV1>[],
  ): Promise<number> {
    if (expectedRecords.length === 0) return 0;
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation scope exit requires active V2 authority");
    }
    if (
      this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || this.data[KEY_PUBLIC_MUTATION_LEDGER].length > 0
    ) {
      throw new Error("Mutation scope exit recovery state is not safe");
    }
    const operationIds = new Set<string>();
    for (const record of expectedRecords) {
      const intent = record.intent;
      if (
        isFolderMutationIntent(intent)
        || intent.version !== 1
        || intent.action !== "upload"
        || intent.sourcePath !== undefined
        || intent.stateEffect !== undefined
        || !intent.expectedLocal.exists
        || record.receipt !== null
        || record.manualResolution !== undefined
        || !sameSyncScope(intent.scope, this.v2Envelope.scope)
        || operationIds.has(intent.operationId)
      ) {
        throw new Error("Mutation scope exit evidence is invalid");
      }
      operationIds.add(intent.operationId);
    }
    const retiredPaths: string[] = [];
    await this.commitPluginData((current) => {
      for (const expected of expectedRecords) {
        const activeIndex = findUniqueMutationLedgerRecordIndex(
          current[KEY_MUTATION_LEDGER],
          expected.intent.operationId,
        );
        const active = activeIndex < 0
          ? undefined
          : current[KEY_MUTATION_LEDGER][activeIndex];
        if (!active || JSON.stringify(active) !== JSON.stringify(expected)) {
          throw new Error("Mutation changed before scope exit");
        }
        retiredPaths.push(active.intent.path);
      }
      return {
        ...current,
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (entry) => !operationIds.has(entry.intent.operationId),
        ),
      };
    });
    for (const path of retiredPaths) this.pendingV2AncestorContent.delete(path);
    return retiredPaths.length;
  }

  /** Publish a receipted mutation's base/remote/pending checkpoint, then clear it. */
  async commitMutationCheckpoint(
    operationId: string,
  ): Promise<MutationCheckpointCommitMetrics> {
    return this.commitMutationCheckpoints([operationId]);
  }

  /**
   * Retire the PluginData half of a file checkpoint whose authoritative V2
   * base effect was already published before a crash. This deliberately does
   * not replay the receipt into the current remote index: a complete identity
   * rebuild may already contain newer Graph facts.
   */
  async retireMutationCheckpointIfReflected(
    operationId: string,
    remoteObservationCommitSeq: number,
  ): Promise<boolean> {
    await this.v2StateCommitQueue;
    await this.pluginDataCommitQueue;
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      return false;
    }
    const expectedIndex = findUniqueMutationLedgerRecordIndex(
      this.data[KEY_MUTATION_LEDGER],
      operationId,
    );
    const expectedDurable = expectedIndex < 0
      ? undefined
      : this.data[KEY_MUTATION_LEDGER][expectedIndex];
    const expected = expectedDurable
      ? this.prepareMutationRecoveryRecord(
          expectedDurable,
          this.v2Envelope.scope,
        )
      : null;
    if (
      !expected?.receipt
      || isFolderMutationIntent(expected.intent)
      || expected.manualResolution !== undefined
    ) return false;
    const paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const sourceAuthority = await this.assertConservativeResetAuthority(
      paths,
      this.v2Envelope,
    );
    let admitted = false;
    await this.commitV2State((current) => {
      if (
        current.meta.commitSeq !== remoteObservationCommitSeq
        || !fileMutationCheckpointIsReflected(current, expected)
      ) return current;
      admitted = true;
      return {
        ...current,
        meta: {
          ...current.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: Math.max(current.meta.committedAt, Date.now()),
        },
      };
    });
    if (!admitted) return false;
    await this.assertConservativeResetAuthority(
      paths,
      this.v2Envelope,
      sourceAuthority,
    );
    const checkpoint = expected.receipt.checkpoint;
    const conflictRemovals = new Set(checkpoint.pendingConflictRemovals);
    const deleteRemovals = new Set(checkpoint.pendingDeleteRemovals);
    let retired = false;
    await this.commitPluginData((current) => {
      const activeIndex = findUniqueMutationLedgerRecordIndex(
        current[KEY_MUTATION_LEDGER],
        operationId,
      );
      const active = activeIndex < 0
        ? undefined
        : current[KEY_MUTATION_LEDGER][activeIndex];
      if (!active) {
        retired = true;
        return current;
      }
      if (
        JSON.stringify(active) !== JSON.stringify(expectedDurable)
        || !fileMutationCheckpointIsReflected(
          this.v2Envelope!,
          this.prepareMutationRecoveryRecord(
            active,
            this.v2Envelope!.scope,
          ) ?? active,
        )
      ) {
        throw new Error(`Mutation checkpoint changed before retirement: ${operationId}`);
      }
      retired = true;
      return {
        ...current,
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (item) => !conflictRemovals.has(item.path),
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => !deleteRemovals.has(item.path),
        ),
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (_entry, index) => index !== activeIndex,
        ),
      };
    });
    if (retired) {
      for (const base of checkpoint.baseUpserts) {
        this.pendingV2AncestorContent.delete(base.path);
      }
    }
    return retired;
  }

  /** Publish independent receipted mutations in one V2 revision, then clear them together. */
  async commitMutationCheckpoints(
    operationIds: readonly string[],
  ): Promise<MutationCheckpointCommitMetrics> {
    const totalStartedAt = Date.now();
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation checkpoint requires active V2 authority");
    }
    if (operationIds.length === 0 || operationIds.length > 32) {
      throw new Error("Mutation checkpoint batch must contain 1 to 32 operations");
    }
    if (new Set(operationIds).size !== operationIds.length) {
      throw new Error("Mutation checkpoint batch contains duplicate operations");
    }
    const records = operationIds.map((operationId) => {
      const recordIndex = findUniqueMutationLedgerRecordIndex(
        this.data[KEY_MUTATION_LEDGER],
        operationId,
      );
      const record = recordIndex < 0
        ? undefined
        : this.data[KEY_MUTATION_LEDGER][recordIndex];
      if (!record?.receipt) {
        throw new Error(`Mutation receipt missing: ${operationId}`);
      }
      assertRemoteUpsertsHaveParentIdentity(record.receipt.checkpoint.remoteUpserts);
      const recoveryRecord = this.prepareMutationRecoveryRecord(
        record,
        this.v2Envelope!.scope,
      );
      if (!recoveryRecord) {
        throw new Error(
          `Mutation scope no longer matches: ${record.intent.operationId}`,
        );
      }
      if (
        requiresOrdinaryFileRecoverySemanticGate(recoveryRecord)
        && !isOrdinaryFileRecoveryRecord(
          recoveryRecord,
          this.v2Envelope!.scope,
        )
      ) {
        throw new Error(
          `Mutation checkpoint evidence is invalid: ${record.intent.operationId}`,
        );
      }
      return recoveryRecord;
    });
    this.assertIndependentMutationCheckpointBatch(records);
    const checkpoints = records.map((record) => record.receipt!.checkpoint);
    const baseUpserts = checkpoints.flatMap((checkpoint) => checkpoint.baseUpserts);
    const ancestorStartedAt = Date.now();
    const ancestorHashes = records.some((record) => isFolderMutationIntent(record.intent))
      ? {}
      : await this.publishPendingV2Ancestors(baseUpserts);
    const ancestorPublishMs = Date.now() - ancestorStartedAt;
    const v2CommitStartedAt = Date.now();
    await this.commitV2State((current) => {
      let reduced = current;
      let changed = false;
      let committedAt = current.meta.committedAt;
      for (const record of records) {
        const before = reduced;
        const checkpoint = record.receipt!.checkpoint;
        let next = isFolderMutationIntent(record.intent)
          ? reduceFolderStateEnvelopeV2(before, record)
          : reduceFileStateEnvelopeV2(before, record);
        if (Object.keys(ancestorHashes).length > 0) {
          next = attachBaseAncestorHashesV2(
            before,
            next,
            checkpoint.baseUpserts,
            ancestorHashes,
          );
        }
        if (next !== before) changed = true;
        reduced = next;
        committedAt = Math.max(committedAt, record.receipt!.completedAt);
      }
      if (!changed) return current;
      const candidate: SyncStateEnvelopeV2 = {
        ...reduced,
        meta: {
          ...reduced.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt,
        },
      };
      validateEnvelope(candidate);
      return candidate;
    });
    const v2CommitMs = Date.now() - v2CommitStartedAt;
    this.clearPendingV2AncestorContent(baseUpserts);
    const conflictRemovals = new Set(
      checkpoints.flatMap((checkpoint) => checkpoint.pendingConflictRemovals),
    );
    const deleteRemovals = new Set(
      checkpoints.flatMap((checkpoint) => checkpoint.pendingDeleteRemovals),
    );
    const folderIssuePaths = new Set(
      records
        .filter((record) => isFolderMutationIntent(record.intent))
        .map((record) => record.intent.path),
    );
    const reviewedSubtreeIssueRoots = records
      .filter((record) => isFolderMutationIntent(record.intent)
        && record.intent.reviewedSubtreeDelete !== undefined)
      .map((record) => record.intent.path);
    const folderMoveHintRemovals = new Set(
      checkpoints.flatMap((checkpoint) => checkpoint.folderMoveHintRemovals ?? []),
    );
    const ledgerClearStartedAt = Date.now();
    await this.commitPluginData((current) => {
      const recordIndexes = new Set(records.map((expected) => {
        const index = findUniqueMutationLedgerRecordIndex(
          current[KEY_MUTATION_LEDGER],
          expected.intent.operationId,
        );
        const active = index < 0
          ? null
          : this.prepareMutationRecoveryRecord(
              current[KEY_MUTATION_LEDGER][index],
              this.v2Envelope!.scope,
            );
        if (
          !active
          || JSON.stringify(active) !== JSON.stringify(expected)
        ) {
          throw new Error(
            `Mutation changed before checkpoint cleanup: ${expected.intent.operationId}`,
          );
        }
        return index;
      }));
      return {
        ...current,
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (item) => !conflictRemovals.has(item.path),
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => !deleteRemovals.has(item.path),
        ),
        [KEY_PENDING_ISSUES]: current[KEY_PENDING_ISSUES].filter(
          (issue) => !folderIssuePaths.has(issue.path)
            && !reviewedSubtreeIssueRoots.some((root) =>
              isFolderIdentityPathAtOrBelow(issue.path, root)),
        ),
        [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
          (_entry, index) => !recordIndexes.has(index),
        ),
        [KEY_LOCAL_FOLDER_MOVE_HINTS]: current[KEY_LOCAL_FOLDER_MOVE_HINTS].filter(
          (hint) => !folderMoveHintRemovals.has(hint.remoteId),
        ),
      };
    });
    const ledgerClearMs = Date.now() - ledgerClearStartedAt;
    return {
      operations: records.length,
      ancestorPublishMs,
      v2CommitMs,
      ledgerClearMs,
      totalMs: Date.now() - totalStartedAt,
    };
  }

  private assertIndependentMutationCheckpointBatch(
    records: readonly MutationLedgerEntryV1[],
  ): void {
    if (records.length <= 1) return;
    if (records.some(
      (record) => isFolderMutationIntent(record.intent) || record.manualResolution,
    )) {
      throw new Error(
        "Mutation checkpoint batches support only independent file operations",
      );
    }
    const pathOwners = new Map<string, string>();
    const remoteIdOwners = new Map<string, string>();
    for (const record of records) {
      const operationId = record.intent.operationId;
      const checkpoint = record.receipt!.checkpoint;
      const paths = new Set([
        record.intent.path,
        record.intent.sourcePath,
        ...checkpoint.baseUpserts.map((entry) => entry.path),
        ...checkpoint.baseRemovals,
        ...checkpoint.remoteUpserts.map((entry) => entry.path),
        ...checkpoint.remoteDeletes,
        ...checkpoint.pendingConflictRemovals,
        ...checkpoint.pendingDeleteRemovals,
      ].filter((path): path is string => Boolean(path)));
      for (const path of paths) {
        const key = path.toLowerCase();
        const owner = pathOwners.get(key);
        if (owner && owner !== operationId) {
          throw new Error(`Mutation checkpoint batch paths overlap: ${path}`);
        }
        pathOwners.set(key, operationId);
      }
      for (const remote of checkpoint.remoteUpserts) {
        const owner = remoteIdOwners.get(remote.driveId);
        if (owner && owner !== operationId) {
          throw new Error(
            `Mutation checkpoint batch remote identities overlap: ${remote.driveId}`,
          );
        }
        remoteIdOwners.set(remote.driveId, operationId);
      }
    }
  }

  // ---- Base Snapshot (per-file persistence) ----

  get baseSnapshot(): BaseFileEntry[] {
    const pathView = this.getV2PathView();
    if (pathView) return pathView.baseEntries;
    return Object.values(this.data[KEY_BASE_SNAPSHOT]);
  }

  getBaseEntry(path: string): BaseFileEntry | undefined {
    const pathView = this.getV2PathView();
    if (pathView) {
      return pathView.baseEntries.find((entry) => entry.path === path);
    }
    return this.data[KEY_BASE_SNAPSHOT][path];
  }

  /** Update a single file's base entry immediately (per-file persistence) */
  async updateBaseEntry(entry: BaseFileEntry): Promise<void> {
    await this.upsertBaseEntries([entry]);
  }

  /** Update multiple base entries with a single persistence write. */
  async upsertBaseEntries(
    entries: BaseFileEntry[],
  ): Promise<Readonly<Record<string, string>>> {
    if (!this.v2Envelope) {
      throw new Error("Base state update requires an active V2 state controller");
    }
    const ancestorHashes = await this.publishPendingV2Ancestors(entries);
    await this.commitV2State((current) => attachBaseAncestorHashesV2(
      current,
      upsertBaseStateEnvelopeV2(current, entries),
      entries,
      ancestorHashes,
    ));
    this.clearPendingV2AncestorContent(entries);
    return ancestorHashes;
  }

  /** Commit exact-content evidence and retire its false conflict in one data write. */
  async reconcileIdenticalConflict(entry: BaseFileEntry): Promise<void> {
    if (!this.v2Envelope) {
      throw new Error("Conflict reconciliation requires an active V2 state controller");
    }
    const ancestorHashes = await this.publishPendingV2Ancestors([entry]);
    const changed = await this.commitV2State((current) => attachBaseAncestorHashesV2(
      current,
      upsertBaseStateEnvelopeV2(current, [entry]),
      [entry],
      ancestorHashes,
    ));
    this.clearPendingV2AncestorContent([entry]);
    await this.commitPluginData((current) => {
      const hasPending = current[KEY_PENDING_CONFLICTS].some(
        (item) => item.path === entry.path,
      );
      if (!hasPending && !changed) return current;
      return {
        ...current,
        [KEY_PENDING_CONFLICTS]: hasPending
          ? current[KEY_PENDING_CONFLICTS].filter(
            (item) => item.path !== entry.path,
          )
          : current[KEY_PENDING_CONFLICTS],
        [KEY_PLAN_REVIEW_ACTIVE]: false,
        [KEY_PLAN_REVIEW_COUNTS]: null,
        [KEY_PLAN_REVIEW_ITEMS]: [],
        [KEY_PLAN_REVIEW_DIGEST]: "",
        [KEY_PLAN_REVIEW_SCOPE]: null,
        [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]: null,
      };
    });
  }

  /** Remove a file from the base snapshot */
  async removeBaseEntry(path: string): Promise<void> {
    if (!this.v2Envelope) {
      throw new Error("Base state removal requires an active V2 state controller");
    }
    await this.commitV2State((current) =>
      removeBaseStateEnvelopeV2(current, [path]),
    );
    this.pendingV2AncestorContent.delete(path);
  }

  // ---- Base Content Cache (for three-way merge) ----

  cacheBaseContent(path: string, content: string | ArrayBuffer): void {
    if (!this.v2Envelope || !isTextFile(path)) return;
    const copy = typeof content === "string"
      ? content
      : content.slice(0);
    const size = typeof copy === "string"
      ? new TextEncoder().encode(copy).byteLength
      : copy.byteLength;
    if (size > 2 * 1024 * 1024) return;
    this.pendingV2AncestorContent.set(path, copy);
  }

  async getBaseContent(path: string): Promise<string | undefined> {
    if (!this.v2Envelope) return this.baseContentCache.get(path);
    const anchor = Object.values(this.v2Envelope.anchors.byAnchorId).find(
      (entry) => entry.lastPath === path,
    );
    if (
      !anchor?.ancestorHash
      || anchor.ancestorHash !== anchor.contentHash
      || !this.ancestorStoreV2
    ) return undefined;
    return (await this.ancestorStoreV2.getText(anchor.ancestorHash))
      ?? undefined;
  }

  private async publishPendingV2Ancestors(
    entries: readonly BaseFileEntry[],
  ): Promise<Readonly<Record<string, string>>> {
    if (!this.v2Envelope || entries.length === 0) return {};
    const store = this.ancestorStoreV2 ?? this.createAncestorStoreV2();
    this.ancestorStoreV2 = store;
    const hashes: Record<string, string> = {};
    for (const entry of entries) {
      const content = this.pendingV2AncestorContent.get(entry.path);
      if (content === undefined) continue;
      const bytes = typeof content === "string"
        ? new TextEncoder().encode(content).buffer
        : content;
      if (
        bytes.byteLength !== entry.size
        || await sha256Hex(bytes) !== entry.hash
      ) continue;
      try {
        const hash = await store.putText(bytes);
        if (hash === entry.hash) hashes[entry.path] = hash;
      } catch {
        // Ancestor availability is optional. Never attach a dangling hash or
        // roll back an otherwise proven common-state checkpoint.
      }
    }
    return hashes;
  }

  private clearPendingV2AncestorContent(
    entries: readonly BaseFileEntry[],
  ): void {
    for (const entry of entries) {
      this.pendingV2AncestorContent.delete(entry.path);
    }
  }

  /** Batch-remove multiple files from the base snapshot in a single save.
   *  ponytail: mirrors upsertBaseEntries — collect all paths, one persist. */
  async removeBaseEntries(paths: string[]): Promise<void> {
    if (!this.v2Envelope) {
      throw new Error("Base state removal requires an active V2 state controller");
    }
    await this.commitV2State((current) =>
      removeBaseStateEnvelopeV2(current, paths),
    );
    for (const path of paths) this.pendingV2AncestorContent.delete(path);
  }

  /** Replace the entire base snapshot (used after first sync or full scan sync) */
  async setBaseSnapshot(entries: BaseFileEntry[]): Promise<void> {
    if (!this.v2Envelope) {
      throw new Error("Base snapshot replacement requires an active V2 state controller");
    }
    const ancestorHashes = await this.publishPendingV2Ancestors(entries);
    await this.commitV2State((current) => attachBaseAncestorHashesV2(
      current,
      replaceBaseStateEnvelopeV2(current, entries),
      entries,
      ancestorHashes,
    ));
    this.clearPendingV2AncestorContent(entries);
  }

  // ---- Remote Snapshot / Delta ----

  get hasRemoteState(): boolean {
    if (this.v2Envelope) return true;
    return this.remoteState !== null;
  }

  get remoteSnapshot(): RemoteFileEntry[] {
    const pathView = this.getV2PathView();
    if (pathView) return pathView.remoteEntries;
    return Object.values(this.remoteState?.entries ?? {});
  }

  get remoteDeltaLink(): string | null {
    const pathView = this.getV2PathView();
    if (pathView) return pathView.deltaLink;
    return this.remoteState?.deltaLink ?? null;
  }

  get remoteFolders(): RemoteFolderEntry[] {
    const pathView = this.getV2PathView();
    if (pathView) return pathView.remoteFolders;
    return Object.values(this.remoteState?.folders ?? {});
  }

  get hasCompleteRemoteFolderIndex(): boolean {
    if (this.getV2PathView()) return true;
    return this.remoteState?.folderIndexComplete === true;
  }

  /**
   * Freeze the capability-free cloud folder facts that the existing exclusion
   * picker may show for one modal session. Active V2 uses only the complete
   * committed identity tree. A public-1.1.3 migration uses only the exact
   * durable candidate whose source digest and reviewed authorization still
   * match at read time.
   */
  async createSyncExclusionFolderSnapshot(
    currentAccountId: string,
  ): Promise<SyncExclusionFolderSnapshot> {
    const hadPendingReview = this.planReviewActive;
    const empty = (): SyncExclusionFolderSnapshot => ({
      hadPendingReview,
      remoteFolderPaths: [],
    });
    if (
      !currentAccountId
      || this.v2StateLoadBlock
      || this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || (
        this.boundAccountId.length > 0
        && this.boundAccountId !== currentAccountId
      )
    ) {
      return empty();
    }

    const migrationHold = this.activeV2MigrationHold;
    if (migrationHold) {
      const authorization = this.planReviewAuthorization;
      if (
        !authorization
        || authorization.reviewKind !== migrationHoldReviewKindV2(migrationHold)
        || migrationHold.scope.accountId !== currentAccountId
        || !await this.isCurrentV2MigrationAuthorization({
          authorization,
          candidate: migrationHold.candidate,
          canonicalIdentity: migrationHold.canonicalIdentity,
        })
      ) {
        return empty();
      }
      const currentHold = this.activeV2MigrationHold;
      if (
        !currentHold
        || currentHold.revision !== authorization.revision
        || !sameCanonicalPlanIdentityV2(
          currentHold.canonicalIdentity,
          authorization.canonicalIdentity,
        )
      ) {
        return empty();
      }
      try {
        return {
          hadPendingReview,
          remoteFolderPaths: projectStatePathViewV2(
            currentHold.candidate,
          ).remoteFolders.map((folder) => folder.path),
        };
      } catch {
        return empty();
      }
    }

    const pathView = this.getV2PathView();
    if (
      !this.v2Envelope
      || !pathView
      || this.v2Envelope.remoteIndex.complete !== true
      || this.v2Envelope.scope.accountId !== currentAccountId
      || this.v2Envelope.remoteScopeRecovery
    ) {
      return empty();
    }
    if (hadPendingReview) {
      const authorization = this.planReviewAuthorization;
      if (
        !authorization?.canonicalIdentity
        || authorization.reviewKind !== undefined
        || !sameSyncScope(authorization.scope, this.v2Envelope.scope)
        || authorization.canonicalIdentity.sourceCommitSeq
          !== this.v2Envelope.meta.commitSeq
      ) {
        return empty();
      }
    }
    return {
      hadPendingReview,
      remoteFolderPaths: pathView.remoteFolders.map(
        (folder) => folder.path,
      ),
    };
  }

  get remoteScope(): SyncScope | null {
    const pathView = this.getV2PathView();
    if (pathView) return pathView.scope;
    return this.remoteState?.scope ?? null;
  }

  getCommunityPluginManifestObservations():
    CommunityPluginManifestObservationV1[] {
    return structuredClone(
      this.data[KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS],
    );
  }

  async setCommunityPluginManifestObservations(
    observations: readonly Readonly<CommunityPluginManifestObservationV1>[],
  ): Promise<void> {
    const next = await readCommunityPluginManifestObservations(observations);
    if (next.length !== observations.length) {
      throw new Error("Community plugin manifest observation is invalid");
    }
    await this.commitPluginData((current) =>
      JSON.stringify(current[KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS])
        === JSON.stringify(next)
        ? current
        : {
            ...current,
            [KEY_COMMUNITY_PLUGIN_MANIFEST_OBSERVATIONS]: next,
          },
    );
  }

  getRemoteCommunityPluginCatalog(): RemoteCommunityPluginCatalogV1 | null {
    const current = this.data[KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG];
    return current ? structuredClone(current) : null;
  }

  async setRemoteCommunityPluginCatalog(
    catalog: Readonly<RemoteCommunityPluginCatalogV1>,
  ): Promise<void> {
    const next = await readRemoteCommunityPluginCatalog(catalog);
    if (!next) throw new Error("Remote community-plugin catalog is invalid");
    await this.commitPluginData((current) =>
      JSON.stringify(current[KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG])
          === JSON.stringify(next)
        ? current
        : {
            ...current,
            [KEY_REMOTE_COMMUNITY_PLUGIN_CATALOG]: next,
          },
    );
  }

  getCloudBootstrapPublicationCheckpointV2():
    CloudBootstrapPublicationCheckpointV2 | null {
    const current = this.data[KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2];
    return current ? { ...current, scope: { ...current.scope } } : null;
  }

  async setCloudBootstrapPublicationCheckpointV2(
    checkpoint: Readonly<CloudBootstrapPublicationCheckpointV2> | null,
  ): Promise<void> {
    const next = checkpoint
      ? readCloudBootstrapPublicationCheckpointV2(checkpoint)
      : null;
    if (checkpoint && !next) {
      throw new Error("Cloud bootstrap publication checkpoint is invalid");
    }
    await this.commitPluginData((current) =>
      JSON.stringify(current[KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2])
        === JSON.stringify(next)
        ? current
        : {
            ...current,
            [KEY_CLOUD_BOOTSTRAP_CHECKPOINT_V2]: next,
          },
    );
  }

  async setRemoteState(
    entries: RemoteFileEntry[],
    deltaLink: string | null,
    scope: SyncScope | null = null,
    folders: RemoteFolderEntry[] = [],
  ): Promise<void> {
    if (!this.v2Envelope) {
      throw new Error("Remote state replacement requires an active V2 state controller");
    }
    if (!scope) throw new Error("V2 remote state requires a complete sync scope");
    await this.commitV2State((current) =>
      replaceRemoteStateEnvelopeV2(current, {
        entries,
        folders,
        deltaLink,
        scope,
      }),
    );
  }

  async clearRemoteState(): Promise<void> {
    if (this.v2StateLoadBlock) {
      throw new Error("Cannot change remote state while V2 load recovery is unresolved");
    }
    if (!this.v2Envelope) {
      throw new Error("Remote state clearing requires an active V2 state controller");
    }
    await this.commitV2State((current) =>
      replaceRemoteStateEnvelopeV2(current, {
        entries: [],
        folders: [],
        deltaLink: null,
        scope: current.scope,
      }),
    );
  }

  /** Commit a device-local sync-path change through the shared PluginData writer.
   *  Durable base history is preserved; stale review state and out-of-scope
   *  pending items are retired in the same physical write as the settings. */
  async commitSyncPathSettingsChange(
    isPathInScope: (path: string) => boolean,
    persistSettings: (data: Record<string, unknown>) => void,
    _selectedCommunityPluginIds?: readonly string[],
    scopeChange?: Readonly<SyncPathSettingsScopeChangeV1>,
  ): Promise<void> {
    const retainedScopeExit =
      scopeChange?.retainedMutationRecoveryScopeExit ?? [];
    const allowsRetainedScopeExit = this
      .isExactRetainedMutationRecoveryScopeExit(
        this.data,
        retainedScopeExit,
        isPathInScope,
      );
    const allowsUnrelatedScopeChange = retainedScopeExit.length === 0
      && this.isExactRetainedMutationRecoveryInScope(
        this.data,
        isPathInScope,
      );
    const retainedInScopeRecovery = allowsUnrelatedScopeChange
      ? structuredClone(this.mutationLedger)
      : [];
    if (
      this.v2StateLoadBlock
      || this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || (this.mutationLedger.length > 0
        && !allowsRetainedScopeExit
        && !allowsUnrelatedScopeChange)
    ) {
      throw new SyncPathMutationRecoveryError();
    }
    const sourceEnvelope = this.v2Envelope;
    const sourceFoldersByPath = new Map(
      this.remoteFolders.map((folder) => [folder.path, folder]),
    );
    const sourceFolderAnchors = sourceEnvelope?.folderAnchors
      ? Object.values(sourceEnvelope.folderAnchors.byAnchorId)
      : [];
    const sourceAnchorFingerprint = sourceEnvelope
      ? await syncScopeExpansionAnchorFingerprint(sourceEnvelope)
      : "";
    const scopeExpansionSource = sourceEnvelope
      && sourceEnvelope.remoteIndex.complete === true
      ? {
          scope: { ...sourceEnvelope.scope },
          commitSeq: sourceEnvelope.meta.commitSeq,
          lifecycleEpoch: sourceEnvelope.meta.lifecycleEpoch,
          anchorFingerprint: sourceAnchorFingerprint,
        }
      : null;
    const expandedFolders = scopeChange && sourceEnvelope
      && sourceEnvelope.remoteIndex.complete === true
      ? [...new Set(scopeChange.expandedFolderPaths)]
          .map((path) => sourceFoldersByPath.get(path))
          .filter((folder): folder is RemoteFolderEntry => Boolean(folder))
          .filter((folder) => !sourceFolderAnchors.some(
            (anchor) =>
              anchor.remoteId === folder.driveId
              && anchor.lastPath === folder.path
              && anchor.parentRemoteId === folder.parentId,
          ))
          .sort(compareRemoteFolderPath)
      : [];
    const nextRevision = scopeChange
      ? this.data[KEY_SYNC_PATH_SETTINGS_REVISION] + 1
      : this.data[KEY_SYNC_PATH_SETTINGS_REVISION];
    const newScopeExpansion: SyncScopeExpansionMarkerV1 | null =
      scopeChange
      && scopeExpansionSource
      && (
        expandedFolders.length > 0
        || scopeChange.requiresCompleteRemoteIdentitySnapshot === true
      )
        ? {
            version: 1,
            kind: "sync-scope-expansion",
            revision: nextRevision,
            previousSettingsFingerprint:
              scopeChange.previousSettingsFingerprint,
            targetSettingsFingerprint:
              scopeChange.targetSettingsFingerprint,
            source: scopeExpansionSource,
            folders: expandedFolders.map((folder) => ({ ...folder })),
            ...(scopeChange.folderScopeTransition
              ? {
                  folderScopeTransition: {
                    previous: structuredClone(
                      scopeChange.folderScopeTransition.previous,
                    ),
                    target: structuredClone(
                      scopeChange.folderScopeTransition.target,
                    ),
                  },
                }
              : {}),
            requiresCompleteRemoteIdentitySnapshot:
              scopeChange.requiresCompleteRemoteIdentitySnapshot === true,
            createdAt: scopeChange.now ?? Date.now(),
          }
        : null;
    await this.commitPluginData((current) => {
      if (
        retainedScopeExit.length > 0
        && !this.isExactRetainedMutationRecoveryScopeExit(
          current,
          retainedScopeExit,
          isPathInScope,
        )
      ) {
        throw new SyncPathMutationRecoveryError(
          "Mutation changed before sync scope exit checkpoint",
        );
      }
      if (
        retainedInScopeRecovery.length > 0
        && current[KEY_MUTATION_LEDGER].length > 0
        && (!sameMutationLedger(
          current[KEY_MUTATION_LEDGER],
          retainedInScopeRecovery,
        ) || !this.isExactRetainedMutationRecoveryInScope(
          current,
          isPathInScope,
        ))
      ) {
        throw new SyncPathMutationRecoveryError(
          "Mutation changed before unrelated sync scope checkpoint",
        );
      }
      const retiredLocalFolderMoveHintRemoteIds = new Set(
        scopeChange?.retireLocalFolderMoveHintRemoteIds ?? [],
      );
      const scopeExpansion = scopeChange
        ? composeSyncScopeExpansionMarker({
            existing: current[KEY_SYNC_SCOPE_EXPANSION],
            next: newScopeExpansion,
            source: scopeExpansionSource,
            scopeChange,
            currentRevision: current[KEY_SYNC_PATH_SETTINGS_REVISION],
            currentSettingsFingerprint:
              current[KEY_SYNC_PATH_SETTINGS_FINGERPRINT],
            nextRevision,
          })
        : current[KEY_SYNC_SCOPE_EXPANSION];
      const next: PluginData = {
        ...current,
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (item) => isPathInScope(item.path),
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => isPathInScope(item.path),
        ),
        [KEY_PENDING_ISSUES]: current[KEY_PENDING_ISSUES].filter(
          (item) => isPathInScope(item.path),
        ),
        [KEY_PLAN_REVIEW_ACTIVE]: false,
        [KEY_PLAN_REVIEW_COUNTS]: null,
        [KEY_PLAN_REVIEW_ITEMS]: [],
        [KEY_PLAN_REVIEW_DIGEST]: "",
        [KEY_PLAN_REVIEW_REVISION]: current[KEY_PLAN_REVIEW_REVISION] + 1,
        [KEY_PLAN_REVIEW_SCOPE]: null,
        [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]: null,
        [KEY_LOCAL_FOLDER_MOVE_HINTS]:
          retiredLocalFolderMoveHintRemoteIds.size === 0
            ? current[KEY_LOCAL_FOLDER_MOVE_HINTS]
            : current[KEY_LOCAL_FOLDER_MOVE_HINTS].filter(
                (hint) =>
                  !retiredLocalFolderMoveHintRemoteIds.has(hint.remoteId),
              ),
        ...(scopeChange
          ? {
              [KEY_SYNC_PATH_SETTINGS_REVISION]: nextRevision,
              [KEY_SYNC_PATH_SETTINGS_FINGERPRINT]:
                scopeChange.targetSettingsFingerprint,
              [KEY_SYNC_SCOPE_EXPANSION]: scopeExpansion,
            }
          : {}),
      };
      persistSettings(next as unknown as Record<string, unknown>);
      return next;
    });
  }

  get syncPathSettingsFingerprint(): string {
    return this.data[KEY_SYNC_PATH_SETTINGS_FINGERPRINT];
  }

  private isExactRetainedMutationRecoveryScopeExit(
    data: Readonly<PluginData>,
    expectedRecords: readonly Readonly<MutationLedgerEntryV1>[],
    isPathInScope: (path: string) => boolean,
  ): boolean {
    if (
      expectedRecords.length === 0
      || !this.v2Envelope
      || this.legacyStateAllowed
      || data[KEY_PUBLIC_MUTATION_LEDGER].length > 0
      || !sameMutationLedger(
        data[KEY_MUTATION_LEDGER],
        expectedRecords,
      )
    ) return false;
    const operationIds = new Set<string>();
    return expectedRecords.every((record) => {
      const intent = record.intent;
      if (
        isFolderMutationIntent(intent)
        || intent.version !== 1
        || intent.action !== "upload"
        || intent.sourcePath !== undefined
        || intent.stateEffect !== undefined
        || !intent.expectedLocal.exists
        || record.receipt !== null
        || record.manualResolution !== undefined
        || !sameSyncScope(intent.scope, this.v2Envelope!.scope)
        || operationIds.has(intent.operationId)
        || isPathInScope(intent.path)
      ) return false;
      operationIds.add(intent.operationId);
      return true;
    });
  }

  /**
   * Permit a settings transaction to pass an unresolved ordinary file
   * mutation only when the target scope still includes every path protected by
   * that exact ledger. Folder, bundle and manual-settlement transactions keep
   * their existing global settings lock until their dedicated owner settles.
   */
  private isExactRetainedMutationRecoveryInScope(
    data: Readonly<PluginData>,
    isPathInScope: (path: string) => boolean,
  ): boolean {
    const records = data[KEY_MUTATION_LEDGER];
    if (
      records.length === 0
      || !this.v2Envelope
      || this.legacyStateAllowed
      || data[KEY_PUBLIC_MUTATION_LEDGER].length > 0
    ) return false;
    const operationIds = new Set<string>();
    return records.every((record) => {
      const intent = record.intent;
      if (
        intent.version !== 1
        || intent.stateEffect !== undefined
        || record.manualResolution !== undefined
        || !sameSyncScope(intent.scope, this.v2Envelope!.scope)
        || operationIds.has(intent.operationId)
        || !isPathInScope(intent.path)
        || (intent.sourcePath !== undefined
          && !isPathInScope(intent.sourcePath))
      ) return false;
      operationIds.add(intent.operationId);
      return true;
    });
  }

  get activeSyncScopeExpansion(): SyncScopeExpansionMarkerV1 | null {
    const marker = this.data[KEY_SYNC_SCOPE_EXPANSION];
    return marker ? structuredClone(marker) : null;
  }

  async prepareSyncScopeExpansion(
    scope: Readonly<SyncScope>,
  ): Promise<SyncScopeExpansionPreparation> {
    const marker = this.data[KEY_SYNC_SCOPE_EXPANSION];
    if (!marker) return { status: "none" };
    const state = await this.inspectSyncScopeExpansion(marker, scope);
    if (state === "already-applied" || state === "stale") {
      await this.clearSyncScopeExpansion(marker.revision);
      return { status: "none" };
    }
    return state === "blocked"
      ? { status: "blocked", revision: marker.revision }
      : { status: "ready", revision: marker.revision };
  }

  async acceptSyncScopeExpansionFolders(input: {
    expectedRevision: number;
    scope: Readonly<SyncScope>;
    localFiles: readonly LocalFileEntry[];
    localFolders: readonly LocalFolderEntry[];
    localFolderScanComplete: boolean;
    remoteIdentityComplete: boolean;
    sourceBoundCommunityPluginJoinRoots?: readonly Readonly<{
      path: string;
      remoteId: string;
    }>[];
    now?: number;
  }): Promise<SyncScopeExpansionAcceptance> {
    const marker = this.data[KEY_SYNC_SCOPE_EXPANSION];
    if (!marker || marker.revision !== input.expectedRevision) {
      return { status: "none", accepted: 0 };
    }
    const state = await this.inspectSyncScopeExpansion(marker, input.scope);
    if (state === "blocked") return { status: "blocked", accepted: 0 };
    if (state === "already-applied") {
      await this.clearSyncScopeExpansion(marker.revision);
      return { status: "accepted", accepted: 0 };
    }
    if (state === "stale") {
      await this.clearSyncScopeExpansion(marker.revision);
      return { status: "stale", accepted: 0 };
    }
    if (!input.localFolderScanComplete || !input.remoteIdentityComplete) {
      return { status: "blocked", accepted: 0 };
    }

    const envelope = this.v2Envelope;
    if (!envelope) {
      await this.clearSyncScopeExpansion(marker.revision);
      return { status: "stale", accepted: 0 };
    }
    const authorizedFolders = materializeSyncScopeExpansionFolders(
      marker,
      envelope,
    );
    const acceptanceFolders = materializeSourceBoundScopeExpansionFolders(
      marker,
      envelope,
      authorizedFolders,
      input.localFolders,
      input.sourceBoundCommunityPluginJoinRoots ?? [],
    );
    if (!acceptanceFolders) {
      await this.clearSyncScopeExpansion(marker.revision);
      return { status: "stale", accepted: 0 };
    }
    if (
      marker.requiresCompleteRemoteIdentitySnapshot
      && authorizedFolders.length === 0
    ) {
      await this.clearSyncScopeExpansion(marker.revision);
      return { status: "accepted", accepted: 0 };
    }
    const reduced = acceptScopeExpansionFolderAnchorsV2({
      envelope,
      localFiles: input.localFiles,
      localFolders: input.localFolders,
      localFolderScanComplete: input.localFolderScanComplete,
      remoteIdentityComplete: input.remoteIdentityComplete,
      authorizedFolders: acceptanceFolders,
      confirmedAt: input.now ?? Date.now(),
    });
    if (reduced.status !== "accepted") {
      await this.clearSyncScopeExpansion(marker.revision);
      return { status: "stale", accepted: 0 };
    }
    const expectedCommitSeq = envelope.meta.commitSeq;
    await this.commitV2State((current) => {
      if (
        !sameSyncScope(current.scope, marker.source.scope)
        || current.meta.lifecycleEpoch !== marker.source.lifecycleEpoch
        || current.meta.commitSeq !== expectedCommitSeq
      ) {
        throw new Error("Sync scope expansion source changed before state commit");
      }
      return acceptScopeExpansionFolderAnchorsV2({
        envelope: current,
        localFiles: input.localFiles,
        localFolders: input.localFolders,
        localFolderScanComplete: input.localFolderScanComplete,
        remoteIdentityComplete: input.remoteIdentityComplete,
        authorizedFolders: acceptanceFolders,
        confirmedAt: input.now ?? Date.now(),
      }).envelope;
    });
    await this.clearSyncScopeExpansion(marker.revision);
    return { status: "accepted", accepted: reduced.accepted };
  }

  /**
   * Commit an exact folder chain that the user explicitly reviewed as one
   * shared identity. The review is authority only for these folders: it does
   * not create a file/folder mutation or broaden the current sync scope.
   */
  async acceptReviewedSharedFolderIdentity(input: {
    reviewed: Readonly<SharedFolderIdentityResolutionSnapshotV1>;
    localFiles: readonly LocalFileEntry[];
    localFolders: readonly LocalFolderEntry[];
    localFolderScanComplete: boolean;
    remoteIdentityComplete: boolean;
    now?: number;
  }): Promise<ReviewedSharedFolderIdentityAcceptance> {
    const envelope = this.v2Envelope;
    if (
      !envelope
      || envelope.meta.commitSeq !== input.reviewed.sourceCommitSeq
      || !sameSyncScope(envelope.scope, input.reviewed.scope)
      || await this.confirmedDescendantEvidenceBlocked(input.reviewed.scope)
    ) {
      return { status: "blocked", accepted: 0 };
    }
    const confirmedAt = input.now ?? Date.now();
    const reduced = acceptScopeExpansionFolderAnchorsV2({
      envelope,
      localFiles: input.localFiles,
      localFolders: input.localFolders,
      localFolderScanComplete: input.localFolderScanComplete,
      remoteIdentityComplete: input.remoteIdentityComplete,
      authorizedFolders: input.reviewed.folders,
      confirmedAt,
    });
    if (reduced.status !== "accepted") {
      return { status: "stale", accepted: 0 };
    }

    const expectedCommitSeq = envelope.meta.commitSeq;
    const staleCommit = new Error(
      "Reviewed shared-folder identity changed before state commit",
    );
    try {
      await this.commitV2State((current) => {
        if (
          current.meta.commitSeq !== expectedCommitSeq
          || !sameSyncScope(current.scope, input.reviewed.scope)
        ) {
          throw staleCommit;
        }
        const currentReduction = acceptScopeExpansionFolderAnchorsV2({
          envelope: current,
          localFiles: input.localFiles,
          localFolders: input.localFolders,
          localFolderScanComplete: input.localFolderScanComplete,
          remoteIdentityComplete: input.remoteIdentityComplete,
          authorizedFolders: input.reviewed.folders,
          confirmedAt,
        });
        if (
          currentReduction.status !== "accepted"
          || currentReduction.accepted !== reduced.accepted
        ) {
          throw staleCommit;
        }
        return currentReduction.envelope;
      });
    } catch (error) {
      if (error === staleCommit) {
        return { status: "stale", accepted: 0 };
      }
      throw error;
    }
    return { status: "accepted", accepted: reduced.accepted };
  }

  /**
   * Retire an exact stale file/folder identity lineage after explicit review.
   * This updates V2 authority only: no Vault or Graph object is changed, and
   * all current objects return to the ordinary canonical planner afterwards.
   */
  async retireReviewedStaleIdentity(input: {
    reviewed: Readonly<StaleIdentityResolutionSnapshotV1>;
    now?: number;
  }): Promise<ReviewedStaleIdentityRetirement> {
    const envelope = this.v2Envelope;
    if (
      !envelope
      || envelope.meta.commitSeq !== input.reviewed.sourceCommitSeq
      || envelope.meta.lifecycleEpoch !== input.reviewed.sourceLifecycleEpoch
      || await this.confirmedDescendantEvidenceBlocked(input.reviewed.scope)
    ) {
      return {
        status: "blocked",
        retiredFileAnchors: 0,
        retiredFolderAnchors: 0,
      };
    }
    const retiredAt = input.now ?? Date.now();
    const preview = retireReviewedStaleIdentityV2(
      envelope,
      input.reviewed,
      retiredAt,
    );
    if (preview.status !== "accepted") {
      return {
        status: "stale",
        retiredFileAnchors: 0,
        retiredFolderAnchors: 0,
      };
    }

    const expectedCommitSeq = envelope.meta.commitSeq;
    const staleCommit = new Error(
      "Reviewed stale identity changed before state commit",
    );
    try {
      await this.commitV2State((current) => {
        if (
          current.meta.commitSeq !== expectedCommitSeq
          || current.meta.lifecycleEpoch !== input.reviewed.sourceLifecycleEpoch
          || !sameSyncScope(current.scope, input.reviewed.scope)
        ) throw staleCommit;
        const currentRetirement = retireReviewedStaleIdentityV2(
          current,
          input.reviewed,
          retiredAt,
        );
        if (
          currentRetirement.status !== "accepted"
          || currentRetirement.retiredFileAnchors
            !== preview.retiredFileAnchors
          || currentRetirement.retiredFolderAnchors
            !== preview.retiredFolderAnchors
        ) throw staleCommit;
        return currentRetirement.envelope;
      });
    } catch (error) {
      if (error === staleCommit) {
        return {
          status: "stale",
          retiredFileAnchors: 0,
          retiredFolderAnchors: 0,
        };
      }
      throw error;
    }

    const roots = uniqueIdentityPaths([
      input.reviewed.path,
      ...input.reviewed.relatedPaths,
    ]);
    const retiredFolderRemoteIds = new Set(
      input.reviewed.folderAnchors.map((anchor) => anchor.remoteId),
    );
    await this.commitPluginData((current) => {
      const isRetiredPath = (path: string): boolean => roots.some((root) =>
        isFolderIdentityPathAtOrBelow(path, root));
      const cleared = clearPlanReviewData({
        ...current,
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (item) => !isRetiredPath(item.path),
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => !isRetiredPath(item.path),
        ),
        [KEY_PENDING_ISSUES]: current[KEY_PENDING_ISSUES].filter(
          (item) => !isRetiredPath(item.path),
        ),
        [KEY_LOCAL_FOLDER_MOVE_HINTS]: current[KEY_LOCAL_FOLDER_MOVE_HINTS]
          .filter((hint) => !retiredFolderRemoteIds.has(hint.remoteId)),
      });
      return {
        ...cleared,
        [KEY_PLAN_REVIEW_REVISION]: current[KEY_PLAN_REVIEW_REVISION] + 1,
      };
    });
    return {
      status: "accepted",
      retiredFileAnchors: preview.retiredFileAnchors,
      retiredFolderAnchors: preview.retiredFolderAnchors,
    };
  }

  /**
   * Accept one exact "restore from cloud" subtree review as a state-only
   * transition. The complete remote index remains authoritative; only the old
   * common anchors below the reviewed root are retired so the ordinary V2
   * planner can recreate local folders and download files with its existing
   * durable mutation chain.
   */
  async acceptReviewedFolderSubtreeRestore(input: {
    reviewed: Readonly<FolderSubtreeReviewSnapshotV1>;
    now?: number;
  }): Promise<ReviewedFolderSubtreeRestoreAcceptance> {
    const envelope = this.v2Envelope;
    if (
      !envelope
      || envelope.meta.commitSeq !== input.reviewed.sourceCommitSeq
      || envelope.meta.lifecycleEpoch !== input.reviewed.sourceLifecycleEpoch
      || await this.confirmedDescendantEvidenceBlocked(input.reviewed.scope)
    ) {
      return {
        status: "blocked",
        retiredFileAnchors: 0,
        retiredFolderAnchors: 0,
      };
    }
    const committedAt = input.now ?? Date.now();
    const preview = acceptReviewedFolderSubtreeRestoreV2(
      envelope,
      input.reviewed,
      committedAt,
    );
    if (preview.status !== "accepted") {
      return {
        status: "stale",
        retiredFileAnchors: 0,
        retiredFolderAnchors: 0,
      };
    }

    const expectedCommitSeq = envelope.meta.commitSeq;
    const staleCommit = new Error(
      "Reviewed folder subtree changed before state commit",
    );
    try {
      await this.commitV2State((current) => {
        if (
          current.meta.commitSeq !== expectedCommitSeq
          || current.meta.lifecycleEpoch !== input.reviewed.sourceLifecycleEpoch
          || !sameSyncScope(current.scope, input.reviewed.scope)
        ) throw staleCommit;
        const currentAcceptance = acceptReviewedFolderSubtreeRestoreV2(
          current,
          input.reviewed,
          committedAt,
        );
        if (
          currentAcceptance.status !== "accepted"
          || currentAcceptance.retiredFileAnchors
            !== preview.retiredFileAnchors
          || currentAcceptance.retiredFolderAnchors
            !== preview.retiredFolderAnchors
        ) throw staleCommit;
        return currentAcceptance.envelope;
      });
    } catch (error) {
      if (error === staleCommit) {
        return {
          status: "stale",
          retiredFileAnchors: 0,
          retiredFolderAnchors: 0,
        };
      }
      throw error;
    }

    const retiredFolderRemoteIds = new Set(
      input.reviewed.members
        .filter((member) => member.kind === "folder")
        .map((member) => member.remoteId),
    );
    await this.commitPluginData((current) => {
      const isReviewedPath = (path: string): boolean =>
        isFolderIdentityPathAtOrBelow(path, input.reviewed.path);
      const cleared = clearPlanReviewData({
        ...current,
        [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
          (item) => !isReviewedPath(item.path),
        ),
        [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
          (item) => !isReviewedPath(item.path),
        ),
        [KEY_PENDING_ISSUES]: current[KEY_PENDING_ISSUES].filter(
          (item) => !isReviewedPath(item.path),
        ),
        [KEY_LOCAL_FOLDER_MOVE_HINTS]: current[KEY_LOCAL_FOLDER_MOVE_HINTS]
          .filter((hint) => !retiredFolderRemoteIds.has(hint.remoteId)),
      });
      return {
        ...cleared,
        [KEY_PLAN_REVIEW_REVISION]: current[KEY_PLAN_REVIEW_REVISION] + 1,
      };
    });
    return {
      status: "accepted",
      retiredFileAnchors: preview.retiredFileAnchors,
      retiredFolderAnchors: preview.retiredFolderAnchors,
    };
  }

  /**
   * Publish exact common file state that may subsequently prove a missing
   * folder-identity chain. This remains a StateManager-owned, state-only
   * checkpoint and is blocked by the same recovery facts as folder repair.
   */
  async acceptConfirmedDescendantFileEvidence(input: {
    scope: Readonly<SyncScope>;
    sourceCommitSeq: number;
    entries: readonly BaseFileEntry[];
  }): Promise<ConfirmedDescendantFileEvidenceAcceptance> {
    const envelope = this.v2Envelope;
    if (
      !envelope
      || envelope.meta.commitSeq !== input.sourceCommitSeq
      || await this.confirmedDescendantEvidenceBlocked(input.scope)
    ) {
      return { status: "blocked", accepted: 0 };
    }
    const changedEntries = input.entries.filter(
      (entry) => !sameBaseEntry(this.getBaseEntry(entry.path), entry),
    );
    if (changedEntries.length === 0) {
      return { status: "none", accepted: 0 };
    }

    const ancestorHashes =
      await this.publishPendingV2Ancestors(changedEntries);
    try {
      if (
        this.v2Envelope?.meta.commitSeq !== input.sourceCommitSeq
        || await this.confirmedDescendantEvidenceBlocked(input.scope)
      ) {
        return { status: "blocked", accepted: 0 };
      }
      await this.commitV2State((current) => {
        if (
          current.meta.commitSeq !== input.sourceCommitSeq
          || !sameSyncScope(current.scope, input.scope)
        ) {
          throw new Error(
            "Confirmed descendant file source changed before state commit",
          );
        }
        return attachBaseAncestorHashesV2(
          current,
          upsertBaseStateEnvelopeV2(current, changedEntries),
          changedEntries,
          ancestorHashes,
        );
      });
    } finally {
      this.clearPendingV2AncestorContent(changedEntries);
    }
    return { status: "accepted", accepted: changedEntries.length };
  }

  /**
   * Repair a missing folder-identity chain only when a currently confirmed
   * file anchor proves the same local and remote ancestry. This is a
   * state-only checkpoint: it never authorizes or performs file/folder
   * mutations and cannot claim an unknown empty folder.
   */
  async acceptConfirmedDescendantFolderAnchors(input: {
    scope: Readonly<SyncScope>;
    localFiles: readonly LocalFileEntry[];
    localFolders: readonly LocalFolderEntry[];
    localFolderScanComplete: boolean;
    remoteIdentityComplete: boolean;
    includeFilePath?: (path: string) => boolean;
    includeFolderPath?: (path: string) => boolean;
    recordReconstructionCheckpoint?: boolean;
    now?: number;
  }): Promise<ConfirmedDescendantFolderAcceptance> {
    const envelope = this.v2Envelope;
    if (
      !envelope
      || await this.confirmedDescendantEvidenceBlocked(input.scope)
    ) {
      return {
        status: "blocked",
        accepted: 0,
        evidenceFiles: 0,
      };
    }

    const confirmedAt = input.now ?? Date.now();
    const reduced = acceptConfirmedDescendantFolderAnchorsV2({
      envelope,
      localFiles: input.localFiles,
      localFolders: input.localFolders,
      localFolderScanComplete: input.localFolderScanComplete,
      remoteIdentityComplete: input.remoteIdentityComplete,
      includeFilePath: input.includeFilePath,
      includeFolderPath: input.includeFolderPath,
      confirmedAt,
    });
    if (reduced.status === "rejected") {
      return {
        status: "rejected",
        reason: reduced.reason,
        accepted: 0,
        evidenceFiles: 0,
      };
    }
    if (reduced.accepted === 0) {
      return {
        status: "none",
        accepted: 0,
        evidenceFiles: 0,
      };
    }

    const expectedCommitSeq = envelope.meta.commitSeq;
    const previousFolderAnchorIds = new Set(
      Object.keys(envelope.folderAnchors!.byAnchorId),
    );
    const addedFolderAnchors = Object.values(
      reduced.envelope.folderAnchors!.byAnchorId,
    ).filter((anchor) => !previousFolderAnchorIds.has(anchor.anchorId));
    const reconstructionRoots = addedFolderAnchors
      .filter((anchor) =>
        !addedFolderAnchors.some((candidate) =>
          candidate.anchorId !== anchor.anchorId
          && isSameOrDescendantPath(anchor.lastPath, candidate.lastPath),
        ),
      )
      .sort((left, right) => left.lastPath.localeCompare(right.lastPath))
      .map((anchor) => ({
        path: anchor.lastPath,
        remoteId: anchor.remoteId,
        confirmedGeneration: anchor.confirmedGeneration,
      }));
    await this.commitV2State((current) => {
      if (
        current.meta.commitSeq !== expectedCommitSeq
        || !sameSyncScope(current.scope, input.scope)
      ) {
        throw new Error(
          "Confirmed descendant folder source changed before state commit",
        );
      }
      const currentReduction = acceptConfirmedDescendantFolderAnchorsV2({
        envelope: current,
        localFiles: input.localFiles,
        localFolders: input.localFolders,
        localFolderScanComplete: input.localFolderScanComplete,
        remoteIdentityComplete: input.remoteIdentityComplete,
        includeFilePath: input.includeFilePath,
        includeFolderPath: input.includeFolderPath,
        confirmedAt,
      });
      if (
        currentReduction.status !== "accepted"
        || currentReduction.accepted !== reduced.accepted
        || currentReduction.evidenceFiles !== reduced.evidenceFiles
      ) {
        throw new Error(
          "Confirmed descendant folder evidence changed before state commit",
        );
      }
      return currentReduction.envelope;
    });
    if (input.recordReconstructionCheckpoint !== false) {
      await this.setConfirmedDescendantFileReconstructionCheckpoint({
        version: 1,
        kind: "confirmed-descendant-file-reconstruction",
        scope: { ...input.scope },
        lifecycleEpoch: reduced.envelope.meta.lifecycleEpoch,
        sourceCommitSeq: reduced.envelope.meta.commitSeq,
        roots: reconstructionRoots,
        startedAt: confirmedAt,
      });
    }
    return {
      status: "accepted",
      accepted: reduced.accepted,
      evidenceFiles: reduced.evidenceFiles,
    };
  }

  /**
   * Resume the non-authoritative file-baseline work opened by a confirmed
   * folder-chain repair. A pre-checkpoint build may be recognized only from
   * a same-generation nested anchor cohort plus more than one normal
   * verification batch below that exact subtree.
   */
  async prepareConfirmedDescendantFileReconstruction(input: {
    scope: Readonly<SyncScope>;
    localFolders: readonly LocalFolderEntry[];
    candidateItems: readonly SyncPlanItem[];
    now?: number;
  }): Promise<ConfirmedDescendantFileReconstructionPreparation> {
    const envelope = this.v2Envelope;
    if (!envelope) {
      return { status: "blocked", roots: [] };
    }
    const active =
      this.data[KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION];
    const relevantConflicts = input.candidateItems.filter((item) =>
      item.type === SyncActionType.Conflict
      && item.reason === "reason.newFileBothSides"
      && Boolean(item.local)
      && Boolean(item.remote),
    );
    // Keep the stable active-V2 hot path free of even local recovery-journal
    // probes. Only a durable continuation or a multi-batch legacy cohort can
    // enter the reconstruction safety gate.
    if (!active && relevantConflicts.length <= 10) {
      return { status: "none", roots: [] };
    }
    if (await this.confirmedDescendantEvidenceBlocked(input.scope)) {
      return { status: "blocked", roots: [] };
    }
    const localFolderPaths = new Set(
      input.localFolders.map((folder) =>
        normalizeFolderIdentityPath(folder.path)),
    );
    if (active) {
      if (
        this.confirmedDescendantFileReconstructionMatches(
          active,
          envelope,
          localFolderPaths,
        )
      ) {
        return {
          status: "ready",
          roots: structuredClone(active.roots),
        };
      }
      await this.setConfirmedDescendantFileReconstructionCheckpoint(null);
      return { status: "none", roots: [] };
    }

    if (relevantConflicts.length <= 10 || !envelope.folderAnchors) {
      return { status: "none", roots: [] };
    }
    const cohorts = new Map<number, FolderAnchorV2[]>();
    for (const anchor of Object.values(envelope.folderAnchors.byAnchorId)) {
      const cohort = cohorts.get(anchor.confirmedGeneration) ?? [];
      cohort.push(anchor);
      cohorts.set(anchor.confirmedGeneration, cohort);
    }
    const inferredRoots: ConfirmedDescendantFileReconstructionRootV1[] = [];
    for (const cohort of cohorts.values()) {
      if (cohort.length < 2) continue;
      const roots = cohort.filter((anchor) =>
        !cohort.some((candidate) =>
          candidate.anchorId !== anchor.anchorId
          && isSameOrDescendantPath(anchor.lastPath, candidate.lastPath),
        ),
      );
      for (const root of roots) {
        if (
          relevantConflicts.filter((item) =>
            isSameOrDescendantPath(item.path, root.lastPath),
          ).length <= 10
        ) continue;
        inferredRoots.push({
          path: root.lastPath,
          remoteId: root.remoteId,
          confirmedGeneration: root.confirmedGeneration,
        });
      }
    }
    const roots = deduplicateReconstructionRoots(inferredRoots).slice(0, 32);
    if (roots.length === 0) return { status: "none", roots: [] };
    const checkpoint: ConfirmedDescendantFileReconstructionCheckpointV1 = {
      version: 1,
      kind: "confirmed-descendant-file-reconstruction",
      scope: { ...input.scope },
      lifecycleEpoch: envelope.meta.lifecycleEpoch,
      sourceCommitSeq: envelope.meta.commitSeq,
      roots,
      startedAt: input.now ?? Date.now(),
    };
    if (
      !this.confirmedDescendantFileReconstructionMatches(
        checkpoint,
        envelope,
        localFolderPaths,
      )
    ) {
      return { status: "none", roots: [] };
    }
    await this.setConfirmedDescendantFileReconstructionCheckpoint(checkpoint);
    return {
      status: "ready",
      roots: structuredClone(roots),
    };
  }

  async completeConfirmedDescendantFileReconstruction(
    scope: Readonly<SyncScope>,
  ): Promise<boolean> {
    const active =
      this.data[KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION];
    if (!active || !sameSyncScope(active.scope, scope)) return false;
    await this.setConfirmedDescendantFileReconstructionCheckpoint(null);
    return true;
  }

  get confirmedDescendantFileReconstruction():
    ConfirmedDescendantFileReconstructionCheckpointV1 | null {
    const active =
      this.data[KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION];
    return active ? structuredClone(active) : null;
  }

  private confirmedDescendantFileReconstructionMatches(
    checkpoint: Readonly<ConfirmedDescendantFileReconstructionCheckpointV1>,
    envelope: Readonly<SyncStateEnvelopeV2>,
    localFolderPaths: ReadonlySet<string>,
  ): boolean {
    if (
      !sameSyncScope(checkpoint.scope, envelope.scope)
      || checkpoint.lifecycleEpoch !== envelope.meta.lifecycleEpoch
      || checkpoint.sourceCommitSeq > envelope.meta.commitSeq
      || !envelope.folderAnchors
    ) return false;
    return checkpoint.roots.every((root) => {
      const anchor = Object.values(envelope.folderAnchors!.byAnchorId).find(
        (candidate) =>
          candidate.remoteId === root.remoteId
          && candidate.lastPath === root.path
          && candidate.confirmedGeneration === root.confirmedGeneration,
      );
      const remote = envelope.remoteIndex.itemsById[root.remoteId];
      return Boolean(
        anchor
        && remote?.kind === "folder"
        && remote.parentId === anchor.parentRemoteId
        && (
          anchor.remoteETag === undefined
          || remote.eTag === anchor.remoteETag
        )
        && localFolderPaths.has(normalizeFolderIdentityPath(root.path)),
      );
    });
  }

  private async setConfirmedDescendantFileReconstructionCheckpoint(
    checkpoint:
      Readonly<ConfirmedDescendantFileReconstructionCheckpointV1> | null,
  ): Promise<void> {
    const next = checkpoint
      ? readConfirmedDescendantFileReconstructionCheckpointV1(checkpoint)
      : null;
    if (checkpoint && !next) {
      throw new Error(
        "Confirmed descendant file reconstruction checkpoint is invalid",
      );
    }
    await this.commitPluginData((current) =>
      JSON.stringify(
        current[KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION],
      ) === JSON.stringify(next)
        ? current
        : {
            ...current,
            [KEY_CONFIRMED_DESCENDANT_FILE_RECONSTRUCTION]: next,
          },
    );
  }

  private async confirmedDescendantEvidenceBlocked(
    scope: Readonly<SyncScope>,
  ): Promise<boolean> {
    const envelope = this.v2Envelope;
    return (
      !envelope
      || Boolean(this.v2StateLoadBlock)
      || !sameSyncScope(scope, envelope.scope)
      || this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || this.mutationLedger.length > 0
      || this.data[KEY_V2_RECOVERY_QUARANTINE].length > 0
      || Boolean(envelope.remoteScopeRecovery)
      || Boolean(this.data[KEY_PLAN_REVIEW_ACTIVE])
      || Boolean(this.data[KEY_SYNC_SCOPE_EXPANSION])
      || this.activeV2MigrationHold !== null
      || this.v2CorruptRecoveryHold !== null
      || await this.hasV2RecoveryJournal()
    );
  }

  private async inspectSyncScopeExpansion(
    marker: Readonly<SyncScopeExpansionMarkerV1>,
    scope: Readonly<SyncScope>,
  ): Promise<"ready" | "blocked" | "stale" | "already-applied"> {
    const envelope = this.v2Envelope;
    if (
      !envelope
      || this.v2StateLoadBlock
      || !sameSyncScope(scope, marker.source.scope)
      || !sameSyncScope(envelope.scope, marker.source.scope)
      || envelope.meta.lifecycleEpoch !== marker.source.lifecycleEpoch
      || envelope.meta.commitSeq < marker.source.commitSeq
      || this.data[KEY_SYNC_PATH_SETTINGS_REVISION] !== marker.revision
      || this.data[KEY_SYNC_PATH_SETTINGS_FINGERPRINT]
        !== marker.targetSettingsFingerprint
    ) return "stale";

    if (
      this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || this.mutationLedger.length > 0
      || this.data[KEY_V2_RECOVERY_QUARANTINE].length > 0
      || envelope.remoteScopeRecovery
      || this.data[KEY_PLAN_REVIEW_ACTIVE]
      || this.activeV2MigrationHold !== null
      || this.v2CorruptRecoveryHold !== null
      || await this.hasV2RecoveryJournal()
    ) return "blocked";

    const authorizedFolders = materializeSyncScopeExpansionFolders(
      marker,
      envelope,
    );
    const exactAcceptedRemoteIds = new Set<string>();
    for (const folder of authorizedFolders) {
      const exact = Object.values(
        envelope.folderAnchors?.byAnchorId ?? {},
      ).some((anchor) =>
        anchor.remoteId === folder.driveId
        && anchor.lastPath === folder.path
        && anchor.parentRemoteId === folder.parentId
      );
      if (exact) exactAcceptedRemoteIds.add(folder.driveId);
    }
    if (
      exactAcceptedRemoteIds.size > 0
      && exactAcceptedRemoteIds.size !== authorizedFolders.length
    ) return "stale";

    const currentFingerprint = await syncScopeExpansionAnchorFingerprint(
      envelope,
      exactAcceptedRemoteIds,
    );
    if (currentFingerprint !== marker.source.anchorFingerprint) return "stale";
    return (
      !marker.requiresCompleteRemoteIdentitySnapshot
      && exactAcceptedRemoteIds.size === authorizedFolders.length
    )
      ? "already-applied"
      : "ready";
  }

  private clearSyncScopeExpansion(expectedRevision: number): Promise<void> {
    return this.commitPluginData((current) => {
      const marker = current[KEY_SYNC_SCOPE_EXPANSION];
      if (!marker || marker.revision !== expectedRevision) return current;
      return {
        ...current,
        [KEY_SYNC_SCOPE_EXPANSION]: null,
      };
    });
  }

  async applyRemoteMutations(
    upserts: RemoteFileEntry[],
    deletedPaths: string[],
  ): Promise<void> {
    assertRemoteUpsertsHaveParentIdentity(upserts);
    if (!this.v2Envelope) {
      throw new Error("Remote state mutation requires an active V2 state controller");
    }
    await this.commitV2State((current) => {
      const projection = projectStatePathViewV2(current);
      const nextEntries = new Map(
        projection.remoteEntries.map((entry) => [entry.path, entry]),
      );
      for (const path of deletedPaths) nextEntries.delete(path);
      for (const entry of upserts) nextEntries.set(entry.path, entry);
      return replaceRemoteStateEnvelopeV2(current, {
        entries: [...nextEntries.values()],
        folders: projection.remoteFolders,
        deltaLink: current.remoteIndex.deltaLink,
        scope: current.scope,
      });
    });
  }

  /** Convert a LocalFileEntry + RemoteFileEntry pair into a BaseFileEntry */
  static toBaseEntry(local: LocalFileEntry, remote: RemoteFileEntry): BaseFileEntry {
    return {
      path: local.path,
      hash: local.hash,
      size: local.size,
      eTag: remote.eTag,
    };
  }

  // ---- Pending Conflicts ----

  get pendingConflicts(): SyncPlanItem[] {
    return this.data[KEY_PENDING_CONFLICTS];
  }

  async addPendingConflict(item: SyncPlanItem): Promise<void> {
    await this.upsertPendingConflicts([item]);
  }

  async upsertPendingConflicts(items: SyncPlanItem[]): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_CONFLICTS]: upsertPlanItems(
        current[KEY_PENDING_CONFLICTS],
        items,
      ),
    }));
  }

  async removePendingConflict(path: string): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
        (i) => i.path !== path,
      ),
    }));
  }

  async prunePendingConflicts(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    await this.save((current) => {
      const next = current[KEY_PENDING_CONFLICTS].filter((item) =>
        active.has(item.path),
      );
      return next.length === current[KEY_PENDING_CONFLICTS].length
        ? current
        : { ...current, [KEY_PENDING_CONFLICTS]: next };
    });
  }

  // ---- Pending Remote Deletes ----

  get pendingRemoteDeletes(): SyncPlanItem[] {
    return this.data[KEY_PENDING_DELETES];
  }

  async addPendingDelete(item: SyncPlanItem): Promise<void> {
    await this.upsertPendingDeletes([item]);
  }

  async upsertPendingDeletes(items: SyncPlanItem[]): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_DELETES]: upsertPlanItems(
        current[KEY_PENDING_DELETES],
        items,
      ),
    }));
  }

  async removePendingDelete(path: string): Promise<void> {
    await this.save((current) => ({
      ...current,
      [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
        (i) => i.path !== path,
      ),
    }));
  }

  async prunePendingDeletes(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    await this.save((current) => {
      const next = current[KEY_PENDING_DELETES].filter((item) =>
        active.has(item.path),
      );
      return next.length === current[KEY_PENDING_DELETES].length
        ? current
        : { ...current, [KEY_PENDING_DELETES]: next };
    });
  }

  // ---- Pending file issues ----

  get pendingIssues(): PendingIssue[] {
    return this.data[KEY_PENDING_ISSUES];
  }

  async reconcilePendingIssues(
    issues: PendingIssue[],
    resolvedPaths: Iterable<string>,
  ): Promise<void> {
    const resolved = new Set(resolvedPaths);
    await this.save((current) => {
      const byPath = new Map(
        current[KEY_PENDING_ISSUES].map((issue) => [issue.path, { ...issue }]),
      );
      for (const path of resolved) {
        byPath.delete(path);
      }
      for (const issue of issues) {
        const nextIssue = { ...issue };
        const existing = byPath.get(issue.path);
        if (issue.actionType === SyncActionType.FolderDeferred) {
          delete nextIssue.consecutiveFailures;
          byPath.set(issue.path, nextIssue);
          continue;
        }
        // M17: merge consecutive failures — same version increments counter.
        // === handles undefined correctly: both undefined → same version.
        if (
          existing
          && issue.localHash === existing.localHash
          && (issue.remoteETag ?? "") === (existing.remoteETag ?? "")
        ) {
          nextIssue.consecutiveFailures = (existing.consecutiveFailures ?? 1) + 1;
        } else if (existing && (issue.localHash !== existing.localHash || issue.remoteETag !== existing.remoteETag)) {
          // Version changed — reset counter
          nextIssue.consecutiveFailures = 1;
        }
        byPath.set(issue.path, nextIssue);
      }
      const next = [...byPath.values()];
      return samePendingIssues(current[KEY_PENDING_ISSUES], next)
        ? current
        : { ...current, [KEY_PENDING_ISSUES]: next };
    });
  }

  /** Reset all M17 circuit breaker counters. Call after auth scope change
   *  (re-login with broader permissions) so old failures don't block retries. */
  async resetCircuitBreakers(): Promise<void> {
    await this.save((current) => {
      const nextIssues = current[KEY_PENDING_ISSUES].map((issue) => ({ ...issue }));
      let changed = false;
      for (const issue of nextIssues) {
        if (issue.consecutiveFailures && issue.consecutiveFailures > 0) {
          issue.consecutiveFailures = 0;
          changed = true;
        }
      }
      return changed ? { ...current, [KEY_PENDING_ISSUES]: nextIssues } : current;
    });
  }

  /**
   * Retire pending issue rows whose path is no longer produced by the fresh
   * plan. With `onlyIssueCodes`, only rows carrying one of the given planner-
   * derived issue codes are eligible for retirement; execution-phase rows
   * (RetryLater / SkipLargeFile) keep their retry semantics.
   */
  async prunePendingIssues(
    activePaths: Iterable<string>,
    options: { onlyIssueCodes?: ReadonlySet<string> } = {},
  ): Promise<void> {
    const active = new Set(activePaths);
    const restrict = options.onlyIssueCodes;
    await this.save((current) => {
      const next = current[KEY_PENDING_ISSUES].filter((issue) =>
        active.has(issue.path)
        || (restrict ? !restrict.has(issue.issueCode ?? "") : false),
      );
      return next.length === current[KEY_PENDING_ISSUES].length
        ? current
        : { ...current, [KEY_PENDING_ISSUES]: next };
    });
  }

  /** Retire only the reviewed issue rows that one explicit side action settled. */
  async retirePendingIssues(paths: Iterable<string>): Promise<void> {
    const retired = new Set(paths);
    if (retired.size === 0) return;
    await this.save((current) => {
      const next = current[KEY_PENDING_ISSUES].filter((issue) =>
        !retired.has(issue.path),
      );
      return next.length === current[KEY_PENDING_ISSUES].length
        ? current
        : { ...current, [KEY_PENDING_ISSUES]: next };
    });
  }

  /**
   * Retire operational state that no longer belongs to this device's file
   * scope. This is deliberately separate from durable sync history: an old
   * failure remains auditable, but it must not keep the current UI blocked
   * after the user excludes the owning path.
   */
  async retirePendingStateForPaths(
    shouldRetire: (path: string) => boolean,
    invalidatePlanReview = false,
  ): Promise<void> {
    await this.save((current) => {
      const pendingConflicts = current[KEY_PENDING_CONFLICTS].filter(
        (item) => !shouldRetire(item.path),
      );
      const pendingDeletes = current[KEY_PENDING_DELETES].filter(
        (item) => !shouldRetire(item.path),
      );
      const pendingIssues = current[KEY_PENDING_ISSUES].filter(
        (item) => !shouldRetire(item.path),
      );
      const reviewedPathRetired = current[KEY_PLAN_REVIEW_ITEMS].some(
        (item) => shouldRetire(item.path),
      );
      const clearReview = invalidatePlanReview || reviewedPathRetired;
      const changed =
        pendingConflicts.length !== current[KEY_PENDING_CONFLICTS].length
        || pendingDeletes.length !== current[KEY_PENDING_DELETES].length
        || pendingIssues.length !== current[KEY_PENDING_ISSUES].length
        || clearReview;
      if (!changed) return current;
      return {
        ...current,
        [KEY_PENDING_CONFLICTS]: pendingConflicts,
        [KEY_PENDING_DELETES]: pendingDeletes,
        [KEY_PENDING_ISSUES]: pendingIssues,
        ...(clearReview
          ? {
              [KEY_PLAN_REVIEW_ACTIVE]: false,
              [KEY_PLAN_REVIEW_COUNTS]: null,
              [KEY_PLAN_REVIEW_ITEMS]: [],
              [KEY_PLAN_REVIEW_DIGEST]: "",
              [KEY_PLAN_REVIEW_REVISION]:
                current[KEY_PLAN_REVIEW_REVISION] + 1,
              [KEY_PLAN_REVIEW_SCOPE]: null,
              [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]: null,
            }
          : {}),
      };
    });
  }

  // ---- Plan Review ----

  get planReviewActive(): boolean {
    if (isActiveMigrationHoldV2(this.migrationHold)) {
      return true;
    }
    return this.data[KEY_PLAN_REVIEW_ACTIVE];
  }

  get planReviewCounts(): PlanReviewCounts | null {
    return isActiveMigrationHoldV2(this.migrationHold)
      ? structuredClone(this.migrationHold.canonicalReview.counts)
      : this.data[KEY_PLAN_REVIEW_COUNTS];
  }

  get planReviewItems(): PlanReviewItem[] {
    return isActiveMigrationHoldV2(this.migrationHold)
      ? structuredClone(this.migrationHold.items)
      : this.data[KEY_PLAN_REVIEW_ITEMS];
  }

  get planReviewRevision(): number {
    return isActiveMigrationHoldV2(this.migrationHold)
      ? this.migrationHold.revision
      : this.data[KEY_PLAN_REVIEW_REVISION];
  }

  get planReviewScope(): SyncScope | null {
    return isActiveMigrationHoldV2(this.migrationHold)
      ? { ...this.migrationHold.scope }
      : this.data[KEY_PLAN_REVIEW_SCOPE];
  }

  get planReviewCanonicalIdentity(): CanonicalPlanIdentityV2 | null {
    if (isActiveMigrationHoldV2(this.migrationHold)) {
      return structuredClone(this.migrationHold.canonicalIdentity);
    }
    const identity = this.data[KEY_PLAN_REVIEW_CANONICAL_IDENTITY];
    return identity ? structuredClone(identity) : null;
  }

  get planReviewAuthorization(): PlanReviewAuthorization | null {
    if (
      !this.planReviewActive
      || this.planReviewRevision < 1
      || !this.planReviewScope
    ) return null;
    const canonicalIdentity = this.planReviewCanonicalIdentity;
    if (
      canonicalIdentity
      && (
        !sameSyncScope(canonicalIdentity.scope, this.planReviewScope)
        || canonicalIdentity.digest !== this.planReviewDigest
      )
    ) return null;
    return {
      revision: this.planReviewRevision,
      scope: { ...this.planReviewScope },
      ...(canonicalIdentity ? { canonicalIdentity } : {}),
      ...(isActiveMigrationHoldV2(this.migrationHold)
        ? { reviewKind: migrationHoldReviewKindV2(this.migrationHold) }
        : {}),
    };
  }

  get activeV2MigrationHold(): MigrationHoldV2 | null {
    return isActiveMigrationHoldV2(this.migrationHold)
      ? structuredClone(this.migrationHold)
      : null;
  }

  async stageV2MigrationHold(input: {
    candidate: SyncStateEnvelopeV2;
    source: Public113MigrationInput;
    reviewKind: V2ActivationReviewKind;
    plan: {
      items: SyncPlanItem[];
      lastTotalFiles: number;
      canonicalIdentity?: CanonicalPlanIdentityV2;
      canonicalReview?: { counts: PlanReviewCounts; impactCount: number };
    };
    now?: number;
  }): Promise<MigrationHoldV2> {
    if (this.v2StateLoadBlock) {
      throw new Error("Cannot stage migration while V2 load recovery is unresolved");
    }
    if (!this.migrationHoldStore) {
      throw new Error("V2 migration hold storage is unavailable");
    }
    if (this.v2Envelope || !this.legacyStateAllowed) {
      throw new Error("Cannot stage a new migration hold after V2 activation");
    }
    if (!input.plan.canonicalIdentity || !input.plan.canonicalReview) {
      throw new Error("V2 migration hold requires a sealed canonical plan");
    }
    const currentHold = this.activeV2MigrationHold;
    const requestedSourceDigest =
      await public113MigrationInputDigest(input.source);
    const sourceStateDigest =
      await this.reconcilePreManifestMigrationArtifacts({
        candidate: input.candidate,
        source: input.source,
        forceReplace: Boolean(
          currentHold
          && (
            currentHold.sourceStateDigest !== requestedSourceDigest
            || migrationHoldReviewKindV2(currentHold) !== input.reviewKind
            || !sameCanonicalPlanIdentityV2(
              currentHold.canonicalIdentity,
              input.plan.canonicalIdentity,
            )
            || !sameStateV2MigrationCandidate(
              currentHold.candidate,
              input.candidate,
            )
          )
        ),
      });
    const hold = await this.migrationHoldStore.publishPending({
      candidate: input.candidate,
      sourceStateDigest,
      reviewKind: input.reviewKind,
      canonicalIdentity: input.plan.canonicalIdentity,
      canonicalReview: input.plan.canonicalReview,
      items: input.plan.items,
      lastTotalFiles: input.plan.lastTotalFiles,
      now: input.now,
    });
    this.migrationHold = hold;
    return structuredClone(hold);
  }

  async confirmV2MigrationHold(input: {
    authorization: PlanReviewAuthorization;
    candidate: SyncStateEnvelopeV2;
    canonicalIdentity: CanonicalPlanIdentityV2;
    protocolBinding: SharedSyncProtocolBinding;
    now?: number;
  }): Promise<MigrationHoldV2 | null> {
    if (!await this.isCurrentV2MigrationAuthorization(input)) return null;
    const hold = this.activeV2MigrationHold;
    if (!hold || !this.migrationHoldStore) return null;
    const confirmed = await this.migrationHoldStore.confirm(
      hold.revision,
      hold.canonicalIdentity,
      input.protocolBinding,
      input.now,
    );
    if (confirmed) this.migrationHold = confirmed;
    return confirmed ? structuredClone(confirmed) : null;
  }

  async checkpointPendingFirstSyncProtocolBinding(input: {
    authorization: PlanReviewAuthorization;
    candidate: SyncStateEnvelopeV2;
    canonicalIdentity: CanonicalPlanIdentityV2;
    protocolBinding: SharedSyncProtocolBindingV2;
    now?: number;
  }): Promise<MigrationHoldV2 | null> {
    if (
      input.authorization.reviewKind !== "v2-first-sync"
      || !isSharedSyncProtocolBindingV2(input.protocolBinding)
      || !await this.isCurrentV2MigrationAuthorization(input)
    ) {
      return null;
    }
    const hold = this.activeV2MigrationHold;
    if (
      !hold
      || hold.phase !== "pending"
      || migrationHoldReviewKindV2(hold) !== "v2-first-sync"
      || !this.migrationHoldStore
    ) {
      return null;
    }
    const checkpointed =
      await this.migrationHoldStore.checkpointPendingProtocolBinding(
        hold.revision,
        hold.canonicalIdentity,
        input.protocolBinding,
        input.now,
      );
    if (checkpointed) this.migrationHold = checkpointed;
    return checkpointed ? structuredClone(checkpointed) : null;
  }

  /**
   * Revalidate a pending public-1.1.3 migration review without acquiring any
   * remote capability. The executor calls this before shared protocol I/O;
   * confirmV2MigrationHold calls it again afterwards so a local source change
   * during the remote request still cannot commit the hold.
   */
  async isCurrentV2MigrationAuthorization(
    input: V2MigrationAuthorizationInput,
  ): Promise<boolean> {
    const hold = this.activeV2MigrationHold;
    if (!this.matchesPendingV2MigrationAuthorization(input, hold)) {
      return false;
    }
    const source = await this.readPublic113MigrationInput();
    const sourceStateDigest = await public113MigrationInputDigest(source);
    const currentHold = this.activeV2MigrationHold;
    return (
      this.matchesPendingV2MigrationAuthorization(input, currentHold)
      && sourceStateDigest === currentHold.sourceStateDigest
    );
  }

  private matchesPendingV2MigrationAuthorization(
    input: V2MigrationAuthorizationInput,
    hold: MigrationHoldV2 | null,
  ): hold is MigrationHoldV2 {
    return Boolean(
      hold
      && hold.phase === "pending"
      && this.migrationHoldStore
      && input.authorization.reviewKind === migrationHoldReviewKindV2(hold)
      && input.authorization.revision === hold.revision
      && sameSyncScope(input.authorization.scope, hold.scope)
      && sameCanonicalPlanIdentityV2(
        input.authorization.canonicalIdentity,
        hold.canonicalIdentity,
      )
      && sameCanonicalPlanIdentityV2(
        input.canonicalIdentity,
        hold.canonicalIdentity,
      )
      && sameStateV2MigrationCandidate(input.candidate, hold.candidate)
    );
  }

  async commitConfirmedV2MigrationHold(
    expected: Pick<MigrationHoldV2, "revision" | "canonicalIdentity">,
    now = Date.now(),
    purpose: "ordinary" | "legacy-mutation-recovery" = "ordinary",
  ): Promise<{
    migration: StateV2MigrationResult;
    hold: MigrationHoldV2;
  }> {
    const hold = this.activeV2MigrationHold;
    const legacyMutationRecovery =
      purpose === "legacy-mutation-recovery";
    if (
      !hold
      || hold.phase !== "confirmed"
      || hold.revision !== expected.revision
      || !sameCanonicalPlanIdentityV2(
        hold.canonicalIdentity,
        expected.canonicalIdentity,
      )
      || this.v2Envelope
      || !this.legacyStateAllowed
      || this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || (
        !legacyMutationRecovery
        && this.mutationLedger.length > 0
      )
      || (
        legacyMutationRecovery
        && this.mutationLedger.length === 0
      )
      || !hold.protocolBinding
    ) {
      throw new Error(
        "V2 migration hold cannot commit authority from the current state",
      );
    }
    const source = await this.readPublic113MigrationInput();
    const sourceStateDigest = await public113MigrationInputDigest(source);
    if (
      hold.candidate.meta.lifecycleEpoch !== source.lifecycleEpoch + 1
      || sourceStateDigest !== hold.sourceStateDigest
    ) {
      throw new Error(
        "V2 migration hold cannot commit after the public 1.1.3 input changed",
      );
    }
    const paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const reconciledSourceStateDigest =
      await this.reconcilePreManifestMigrationArtifacts({
      candidate: hold.candidate,
      source,
    });
    if (reconciledSourceStateDigest !== hold.sourceStateDigest) {
      throw new Error(
        "V2 migration hold source changed before authority commit",
      );
    }
    const indexedDbFactory =
      this.plugin.createPublic113IndexedDbCandidateStore;
    if (indexedDbFactory) {
      const indexedDbStore = indexedDbFactory(
        hold.sourceStateDigest,
      );
      try {
        await indexedDbStore.stageCandidate(hold.candidate, {
          sourceStateDigest: hold.sourceStateDigest,
          now,
        });
      } finally {
        await indexedDbStore.close();
      }
      const postStagingSource =
        await this.readPublic113MigrationInput();
      const postStagingSourceStateDigest =
        await public113MigrationInputDigest(postStagingSource);
      if (postStagingSourceStateDigest !== hold.sourceStateDigest) {
        throw new Error(
          "V2 migration hold source changed during IndexedDB staging",
        );
      }
    }
    let migration: StateV2MigrationResult;
    try {
      migration = await commitReviewedStateV2MigrationCandidate(
        this.plugin.app.vault.adapter,
        {
          committed: paths.stateV2File,
          next: paths.stateV2NextFile,
          previous: paths.stateV2PreviousFile,
          recovery: paths.stateV2RecoveryFile,
          manifest: paths.stateV2ManifestFile,
          manifestNext: paths.stateV2ManifestNextFile,
          v1Backup: paths.stateV1BackupFile,
        },
        {
          candidate: hold.candidate,
          canonicalIdentity: hold.canonicalIdentity,
          v1Snapshot: createPublic113BackupSnapshot(
            source,
            hold.sourceStateDigest,
          ),
          ancestorExists: (hash) =>
            (this.ancestorStoreV2 ?? this.createAncestorStoreV2()).has(hash),
          now,
        },
      );
    } catch (error) {
      await this.blockIfMigrationManifestBecameDurable(paths);
      throw error;
    }
    if (
      (migration.status !== "committed"
        && migration.status !== "already-committed")
      || !migration.manifest
      || !migration.envelope
    ) {
      await this.blockIfMigrationManifestBecameDurable(paths);
      throw new Error(
        `V2 migration authority commit failed: ${migration.reason ?? "unknown"}`,
      );
    }
    const store = this.createV2Store(paths);
    const committed = await store.load(migration.manifest.scope);
    if (
      !committed
      || committed.meta.commitSeq < migration.manifest.stateCommitSeq
      || committed.meta.lifecycleEpoch < migration.manifest.lifecycleEpoch
    ) {
      throw new Error(
        "V2 migration authority commit could not reload its envelope",
      );
    }
    this.v2Store = store;
    this.activateV2Envelope(committed);
    this.remoteState = null;
    this.legacyStateAllowed = false;
    let authorityWitness: StateV2AuthorityWitness;
    try {
      const witnessStore = this.v2AuthorityWitnessStore
        ?? this.createV2AuthorityWitnessStore(paths);
      this.v2AuthorityWitnessStore = witnessStore;
      authorityWitness = await witnessStore.publishActive(
        migration.manifest,
        now,
        hold.protocolBinding,
      );
    } catch (error) {
      this.setV2StateLoadBlock(
        "authority-witness-save-failed",
        "v2",
        error,
      );
      throw error;
    }
    const cutoverFailure = await this.finalizePublic113CutoverIfRequired(
      paths,
      now,
    );
    if (cutoverFailure) {
      this.setV2StateLoadBlock(cutoverFailure, "v2");
      throw new Error(
        "Public 1.1.3 control state could not be finalized after authority commit",
      );
    }
    try {
      await this.maybeSelectIndexedDbStorage(
        paths,
        migration.manifest,
        authorityWitness,
        committed,
      );
    } catch (error) {
      this.setV2StateLoadBlock(
        "indexeddb-authority-load-failed",
        "v2",
        error,
      );
      throw error;
    }

    const transitioned = await this.transitionV2MigrationHold(
      expected,
      "authority-committed",
      now,
    );
    if (!transitioned) {
      throw new Error(
        "V2 authority committed but migration hold phase did not advance",
      );
    }
    return { migration, hold: transitioned };
  }

  async transitionV2MigrationHold(
    expected: Pick<MigrationHoldV2, "revision" | "canonicalIdentity">,
    phase: "authority-committed" | "completed",
    now?: number,
  ): Promise<MigrationHoldV2 | null> {
    if (!this.migrationHoldStore) return null;
    if (phase === "completed") {
      // The active hold masks the public-1.1.3 review. Retire that stale
      // authorization before making the hold inactive so no crash can expose
      // it again after authority has moved to V2.
      await this.clearStoredPlanReview();
    }
    const next = await this.migrationHoldStore.transition(
      expected.revision,
      expected.canonicalIdentity,
      phase,
      now,
    );
    if (next) this.migrationHold = next;
    return next ? structuredClone(next) : null;
  }

  async setPlanReviewBundle(
    items: SyncPlanItem[],
    counts: PlanReviewCounts,
    scope: SyncScope,
    canonicalIdentity?: CanonicalPlanIdentityV2,
  ): Promise<void> {
    if (
      canonicalIdentity
      && (
        !sameSyncScope(canonicalIdentity.scope, scope)
        || !Number.isSafeInteger(canonicalIdentity.sourceCommitSeq)
        || canonicalIdentity.sourceCommitSeq < 0
        || canonicalIdentity.digest.length === 0
      )
    ) {
      throw new Error(
        "Canonical plan review identity is incomplete or does not match the active scope",
      );
    }
    const conflicts = items.filter((item) => item.type === SyncActionType.Conflict);
    const deletes = items.filter((item) =>
      item.type === SyncActionType.ConfirmLocalDelete
      || (
        item.type === SyncActionType.DeleteLocalFolder
        && item.requiresConfirmation
      ));
    await this.commitPluginData((current) => ({
      ...current,
      [KEY_PENDING_CONFLICTS]: upsertPlanItems(
        current[KEY_PENDING_CONFLICTS],
        conflicts,
      ),
      [KEY_PENDING_DELETES]: upsertPlanItems(
        current[KEY_PENDING_DELETES],
        deletes,
      ),
      [KEY_PLAN_REVIEW_ACTIVE]: true,
      [KEY_PLAN_REVIEW_COUNTS]: counts,
      [KEY_PLAN_REVIEW_ITEMS]: items.map(({ type, path, reason, local, remote, folder }) => ({
        type,
        path,
        reason,
        localHash: local?.hash,
        remoteETag: remote?.eTag,
        folderRemoteId: folder?.remoteId,
        folderRemoteETag: folder?.remoteETag,
        folderParentRemoteId: folder?.parentRemoteId,
        folderParentPath: folder?.parentPath,
        folderParentRemoteETag: folder?.parentRemoteETag,
      })),
      [KEY_PLAN_REVIEW_DIGEST]:
        canonicalIdentity?.digest ?? planDigest(items),
      [KEY_PLAN_REVIEW_REVISION]: current[KEY_PLAN_REVIEW_REVISION] + 1,
      [KEY_PLAN_REVIEW_SCOPE]: { ...scope },
      [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]:
        canonicalIdentity ? structuredClone(canonicalIdentity) : null,
    }));
  }

  get planReviewDigest(): string {
    return isActiveMigrationHoldV2(this.migrationHold)
      ? this.migrationHold.canonicalIdentity.digest
      : this.data[KEY_PLAN_REVIEW_DIGEST] ?? "";
  }

  private clearStoredPlanReview(): Promise<void> {
    return this.commitPluginData((current) => {
      if (!current[KEY_PLAN_REVIEW_ACTIVE]) return current;
      return clearPlanReviewData(current);
    });
  }

  async clearPlanReview(expected?: PlanReviewAuthorization): Promise<boolean> {
    const hold = this.activeV2MigrationHold;
    if (hold) {
      if (
        expected
        && (
          expected.reviewKind !== migrationHoldReviewKindV2(hold)
          || expected.revision !== hold.revision
          || !sameSyncScope(expected.scope, hold.scope)
          || !sameCanonicalPlanIdentityV2(
            expected.canonicalIdentity,
            hold.canonicalIdentity,
          )
        )
      ) {
        return false;
      }
      if (!this.migrationHoldStore) return false;
      if (hold.phase === "authority-committed") {
        await this.clearStoredPlanReview();
        const completed = await this.migrationHoldStore.transition(
          hold.revision,
          hold.canonicalIdentity,
          "completed",
        );
        if (!completed) return false;
        this.migrationHold = completed;
        return true;
      }
      if (hold.phase === "confirmed" && this.v2Envelope) {
        const authority = await this.migrationHoldStore.transition(
          hold.revision,
          hold.canonicalIdentity,
          "authority-committed",
        );
        if (!authority) return false;
        await this.clearStoredPlanReview();
        const completed = await this.migrationHoldStore.transition(
          authority.revision,
          authority.canonicalIdentity,
          "completed",
        );
        if (!completed) return false;
        this.migrationHold = completed;
        return true;
      }
      // An older 1.1.3 review is deliberately left untouched while the V2
      // migration hold is merely being prepared. Once the user explicitly
      // cancels that hold, retire the stale review before publishing the
      // cancellation so a crash cannot expose the old authorization again.
      const source = await this.readPublic113MigrationInput();
      await this.reconcilePreManifestMigrationArtifacts({
        candidate: hold.candidate,
        source,
        forceReplace: true,
      });
      const indexedDbFactory =
        this.plugin.createPublic113IndexedDbCandidateStore;
      if (indexedDbFactory) {
        const indexedDbStore = indexedDbFactory(
          hold.sourceStateDigest,
        );
        try {
          await indexedDbStore.delete();
        } finally {
          await indexedDbStore.close();
        }
      }
      await this.clearStoredPlanReview();
      const cancelled = await this.migrationHoldStore.transition(
        hold.revision,
        hold.canonicalIdentity,
        "cancelled",
      );
      if (!cancelled) return false;
      this.migrationHold = cancelled;
      return true;
    }
    const corruptRecoveryHold = this.v2CorruptRecoveryHold;
    if (corruptRecoveryHold) {
      const currentAuthorization = this.planReviewAuthorization;
      if (
        expected
        && (
          !currentAuthorization
          || currentAuthorization.revision !== expected.revision
          || !sameSyncScope(currentAuthorization.scope, expected.scope)
          || !sameCanonicalPlanIdentityV2(
            currentAuthorization.canonicalIdentity,
            expected.canonicalIdentity,
          )
          || !sameCanonicalPlanIdentityV2(
            corruptRecoveryHold.canonicalIdentity,
            expected.canonicalIdentity,
          )
        )
      ) {
        return false;
      }
      if (!this.v2CorruptRecoveryHoldStore) return false;
      // Retire the reusable authorization before deleting its source-bound
      // candidate. A crash between the two leaves a harmless hold that can
      // only be shown for review again; it cannot expose a runnable plan.
      await this.clearStoredPlanReview();
      await this.v2CorruptRecoveryHoldStore.clear();
      this.v2CorruptRecoveryHold = null;
      return true;
    }
    let cleared = false;
    await this.commitPluginData((current) => {
      if (expected && (
        !current[KEY_PLAN_REVIEW_ACTIVE]
        || current[KEY_PLAN_REVIEW_REVISION] !== expected.revision
        || !sameSyncScope(current[KEY_PLAN_REVIEW_SCOPE], expected.scope)
        || !sameCanonicalPlanIdentityV2(
          current[KEY_PLAN_REVIEW_CANONICAL_IDENTITY],
          expected.canonicalIdentity,
        )
      )) return current;
      cleared = true;
      return clearPlanReviewData(current);
    });
    return cleared;
  }

  // ---- Sync Time ----

  get lastSyncTime(): number {
    return this.data[KEY_LAST_SYNC_TIME];
  }

  async setLastSyncTime(time: number): Promise<void> {
    await this.save((current) => ({ ...current, [KEY_LAST_SYNC_TIME]: time }));
  }

  // ---- Account binding ----

  get boundAccountId(): string {
    return this.data[KEY_BOUND_ACCOUNT] ?? "";
  }

  /** False after the V2 manifest commits. Legacy V1 writers must fail closed. */
  get legacyAutoSyncAllowed(): boolean {
    return this.legacyStateAllowed;
  }

  /** Durable manifest authority may remain V2 even when its envelope cannot load. */
  get isV2AuthoritySelected(): boolean {
    return this.v2Envelope !== null
      || this.v2StateLoadBlock?.authority === "v2";
  }

  get v2StateLoadRecoveryBlock(): V2StateLoadBlock | null {
    return this.v2StateLoadBlock
      ? { ...this.v2StateLoadBlock }
      : null;
  }

  get hasV2StateLoadRecoveryBlock(): boolean {
    return this.v2StateLoadBlock !== null;
  }

  get v2CorruptStateRecoveryEvidence(): Omit<
    StateEnvelopeV2CorruptionEvidence,
    "rawEnvelope"
  > | null {
    if (!this.v2CorruptionEvidence) return null;
    const {
      rawEnvelope: _rawEnvelope,
      ...evidence
    } = this.v2CorruptionEvidence;
    return structuredClone(evidence);
  }

  /**
   * Preserve the exact damaged committed bytes before any live recovery
   * observation. The content-addressed forensic copy is not authority and
   * cannot activate a candidate; it only makes the source evidence durable.
   */
  async prepareV2CorruptStateRecoverySource():
    Promise<StateEnvelopeV2CorruptionEvidence> {
    const source = this.v2CorruptionEvidence;
    if (
      !source
      || this.v2StateLoadBlock?.authority !== "v2"
      || !this.v2StateLoadBlock.reason.startsWith("envelope-")
      || !this.v2StateLoadBlock.reason.endsWith("-corrupt")
    ) {
      throw new Error("No stable V2 corrupt-state source is available");
    }
    await this.assertV2CorruptStateRecoverySourceCurrent(
      source.sourceDigest,
    );
    const paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const adapter = this.plugin.app.vault.adapter;
    const committed =
      `${paths.stateV2CorruptSourcePrefix}${source.sourceDigest}.json`;
    const staged = `${committed}.next`;
    const inspect = async (
      path: string,
    ): Promise<"missing" | "exact" | "different"> => {
      if (!await adapter.exists(path)) return "missing";
      try {
        return await adapter.read(path) === source.rawEnvelope
          ? "exact"
          : "different";
      } catch {
        return "different";
      }
    };

    const committedState = await inspect(committed);
    if (committedState === "different") {
      throw new Error(
        "V2 corrupt-state forensic target contains different bytes",
      );
    }
    if (committedState === "missing") {
      const stagedState = await inspect(staged);
      if (stagedState === "different") {
        throw new Error(
          "V2 corrupt-state forensic staging contains different bytes",
        );
      }
      if (stagedState === "missing") {
        try {
          await adapter.write(staged, source.rawEnvelope);
        } catch (error) {
          if (await inspect(staged) !== "exact") throw error;
        }
      }
      if (await inspect(staged) !== "exact") {
        throw new Error(
          "V2 corrupt-state forensic staging failed exact read-back",
        );
      }
      try {
        await adapter.rename(staged, committed);
      } catch (error) {
        if (await inspect(committed) !== "exact") throw error;
      }
      if (await inspect(committed) !== "exact") {
        throw new Error(
          "V2 corrupt-state forensic copy failed exact publication",
        );
      }
    }
    const remainingStagedState = await inspect(staged);
    if (remainingStagedState === "different") {
      throw new Error(
        "V2 corrupt-state forensic staging contains different bytes",
      );
    }
    if (remainingStagedState === "exact") {
      try {
        await adapter.remove(staged);
      } catch {
        // The immutable committed copy is sufficient. A matching staged copy
        // is harmless and can be cleaned on the next explicit attempt.
      }
    }
    await this.assertV2CorruptStateRecoverySourceCurrent(
      source.sourceDigest,
    );
    return structuredClone(source);
  }

  /** Abort a recovery attempt if the selected corrupt authority changed. */
  async assertV2CorruptStateRecoverySourceCurrent(
    sourceDigest: string,
  ): Promise<void> {
    const source = this.v2CorruptionEvidence;
    if (!source || source.sourceDigest !== sourceDigest) {
      throw new Error("V2 corrupt-state recovery source changed");
    }
    const paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const raw = await this.plugin.app.vault.adapter.read(paths.stateV2File);
    if (
      raw !== source.rawEnvelope
      || await sha256Hex(new TextEncoder().encode(raw).buffer)
        !== source.sourceDigest
    ) {
      throw new Error("V2 corrupt-state committed bytes changed");
    }
  }

  /** Return only ancestor objects whose exact content-addressed bytes exist. */
  async verifyV2AncestorHashes(
    hashes: readonly string[],
  ): Promise<string[]> {
    const store = this.ancestorStoreV2 ?? this.createAncestorStoreV2();
    this.ancestorStoreV2 = store;
    const verified: string[] = [];
    for (const hash of [...new Set(hashes)].sort()) {
      if (await store.has(hash)) verified.push(hash);
    }
    return verified;
  }

  get activeV2CorruptStateRecoveryHold():
    CorruptStateRecoveryHoldV2 | null {
    return this.v2CorruptRecoveryHold
      ? structuredClone(this.v2CorruptRecoveryHold)
      : null;
  }

  async stageV2CorruptStateRecoveryHold(input: {
    source: StateEnvelopeV2CorruptionEvidence;
    candidate: SyncStateEnvelopeV2;
    canonicalIdentity: CorruptStateRecoveryHoldV2["canonicalIdentity"];
    canonicalReview: CorruptStateRecoveryHoldV2["canonicalReview"];
    lastTotalFiles: number;
    items: readonly SyncPlanItem[];
    now?: number;
  }): Promise<CorruptStateRecoveryHoldV2> {
    if (
      !this.v2CorruptRecoveryHoldStore
      || !this.v2CorruptionEvidence
      || input.source.sourceDigest
        !== this.v2CorruptionEvidence.sourceDigest
    ) {
      throw new Error("V2 corrupt-state recovery source is unavailable");
    }
    await this.prepareV2CorruptStateRecoverySource();
    const hold = await this.v2CorruptRecoveryHoldStore.publishPending({
      sourceDigest: input.source.sourceDigest,
      sourceCommitSeq: input.source.sourceCommitSeq,
      sourceLifecycleEpoch: input.source.sourceLifecycleEpoch,
      corruption: input.source.corruption,
      scope: input.source.scope,
      candidate: input.candidate,
      canonicalIdentity: input.canonicalIdentity,
      canonicalReview: input.canonicalReview,
      lastTotalFiles: input.lastTotalFiles,
      items: input.items,
      now: input.now,
    });
    this.v2CorruptRecoveryHold = hold;
    return structuredClone(hold);
  }

  async confirmV2CorruptStateRecoveryHold(
    authorization: PlanReviewAuthorization,
  ): Promise<CorruptStateRecoveryHoldV2 | null> {
    const hold = this.v2CorruptRecoveryHold;
    const currentAuthorization = this.planReviewAuthorization;
    if (
      !hold
      || !this.v2CorruptRecoveryHoldStore
      || !authorization.canonicalIdentity
      || !currentAuthorization
      || currentAuthorization.revision !== authorization.revision
      || !sameSyncScope(currentAuthorization.scope, authorization.scope)
      || !sameCanonicalPlanIdentityV2(
        currentAuthorization.canonicalIdentity,
        authorization.canonicalIdentity,
      )
      || !sameCanonicalPlanIdentityV2(
        hold.canonicalIdentity,
        authorization.canonicalIdentity,
      )
    ) return null;
    await this.assertV2CorruptStateRecoverySourceCurrent(
      hold.sourceDigest,
    );
    const confirmed = await this.v2CorruptRecoveryHoldStore.confirm(
      hold.canonicalIdentity,
    );
    this.v2CorruptRecoveryHold = confirmed;
    return confirmed ? structuredClone(confirmed) : null;
  }

  /**
   * Publish an exact, already-confirmed corrupt-state candidate through the
   * dedicated envelope → manifest → witness transaction.
   *
   * This method changes only V2 authority files. The reviewed plan remains in
   * PluginData so the ordinary V2 executor can revalidate and execute it after
   * the repaired state is active.
   */
  async publishConfirmedV2CorruptStateRecovery(
    authorization: PlanReviewAuthorization,
    now = Date.now(),
  ): Promise<SyncStateEnvelopeV2> {
    let published: SyncStateEnvelopeV2 | null = null;
    const task = this.v2StateCommitQueue.then(async () => {
      const hold = this.v2CorruptRecoveryHold;
      const currentAuthorization = this.planReviewAuthorization;
      if (
        !hold
        || hold.phase !== "confirmed"
        || !this.v2CorruptionEvidence
        || !this.v2CorruptPublicationStore
        || !this.v2CorruptRecoveryHoldStore
        || !this.v2AuthorityWitnessStore
        || this.v2StateLoadBlock?.authority !== "v2"
        || !this.v2StateLoadBlock.reason.startsWith("envelope-")
        || !this.v2StateLoadBlock.reason.endsWith("-corrupt")
        || !currentAuthorization
        || !authorization.canonicalIdentity
        || currentAuthorization.revision !== authorization.revision
        || !sameSyncScope(currentAuthorization.scope, authorization.scope)
        || !sameCanonicalPlanIdentityV2(
          currentAuthorization.canonicalIdentity,
          authorization.canonicalIdentity,
        )
        || !sameCanonicalPlanIdentityV2(
          hold.canonicalIdentity,
          authorization.canonicalIdentity,
        )
      ) {
        throw new Error(
          "V2 corrupt-state publication authorization is no longer current",
        );
      }
      if (
        this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
        || this.data[KEY_V2_RECOVERY_QUARANTINE].length > 0
      ) {
        throw new Error(
          "V2 corrupt-state publication cannot overlap mutation recovery",
        );
      }
      await this.prepareV2CorruptStateRecoverySource();
      await this.assertV2CorruptStateRecoverySourceCurrent(
        hold.sourceDigest,
      );
      const paths = getEasySyncPaths(
        this.plugin.app.vault,
        this.plugin.manifest.id,
      );
      const manifest = await readStateV2Manifest(
        this.plugin.app.vault.adapter,
        paths.stateV2ManifestFile,
      );
      const witness = await this.v2AuthorityWitnessStore.load();
      if (
        !manifest
        || !witness
        || witness.status !== "active"
        || !sameStateV2AuthorityManifest(witness, manifest)
        || !sameSyncScope(manifest.scope, hold.scope)
      ) {
        throw new Error(
          "V2 corrupt-state manifest or authority witness changed",
        );
      }
      const recovered = await this.v2CorruptPublicationStore.commit({
        confirmedHold: hold,
        sourceManifest: manifest,
        sourceWitness: witness,
        now,
      });
      await this.v2CorruptRecoveryHoldStore.clear();
      this.v2CorruptRecoveryHold = null;
      await this.v2CorruptPublicationStore.finalize(recovered.record);

      const store = this.createV2Store(paths);
      const reloaded = await store.load(recovered.manifest.scope);
      if (
        !reloaded
        || JSON.stringify(reloaded)
          !== JSON.stringify(recovered.envelope)
      ) {
        throw new Error(
          "V2 corrupt-state candidate failed final authority reload",
        );
      }
      this.v2Store = store;
      this.activateV2Envelope(reloaded);
      this.v2StateLoadBlock = null;
      this.v2CorruptionEvidence = null;
      this.legacyStateAllowed = false;
      this.remoteState = null;
      published = structuredClone(reloaded);
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
    if (!published) {
      throw new Error("V2 corrupt-state publication did not complete");
    }
    return published;
  }

  async clearV2CorruptStateRecoveryReview(): Promise<void> {
    await this.clearPlanReview();
  }

  /** Current builds can use the manifest-selected V2 file state controller. */
  get isV2StateActive(): boolean {
    return this.v2Envelope !== null;
  }

  /** Internal diagnostic input; fingerprint databaseId before external output. */
  get activeV2StorageAuthorityEvidence():
    StateV2StorageAuthorityEvidence | null {
    if (!this.v2Envelope) return null;
    const common = {
      stateCommitSeq: this.v2Envelope.meta.commitSeq,
      lifecycleEpoch: this.v2Envelope.meta.lifecycleEpoch,
    };
    return this.v2IndexedDbStore
      ? {
          ...common,
          kind: "indexeddb",
          databaseId: this.v2IndexedDbStore.databaseId,
        }
      : {
          ...common,
          kind: "json",
          databaseId: null,
        };
  }

  get activeV2RemoteScopeRecovery(): RemoteScopeRecoveryV2 | null {
    return this.v2Envelope?.remoteScopeRecovery
      ? structuredClone(this.v2Envelope.remoteScopeRecovery)
      : null;
  }

  get hasV2RemoteScopeRecovery(): boolean {
    return this.v2Envelope?.remoteScopeRecovery !== undefined;
  }

  /** Immutable publication input for a cloud recovery hint. */
  getCommittedV2Envelope(): SyncStateEnvelopeV2 | null {
    return this.v2Envelope ? structuredClone(this.v2Envelope) : null;
  }

  /**
   * Device-local community-plugin intent from the selected V2 authority.
   * This state says nothing about whether every other device has exited.
   */
  getCommunityPluginParticipation():
    DeviceCommunityPluginParticipationV1 | null {
    const value = this.v2Envelope?.communityPluginParticipation;
    return value
      ? readDeviceCommunityPluginParticipation(value, this.plugin.manifest.id)
      : null;
  }

  /** One-time legacy-policy migration. An existing V2 owner always wins. */
  async initializeCommunityPluginParticipation(
    input: Readonly<LegacyCommunityPluginParticipationMigrationInput>,
    now = Date.now(),
  ): Promise<{
    changed: boolean;
    state: DeviceCommunityPluginParticipationV1;
  }> {
    let published: DeviceCommunityPluginParticipationV1 | null = null;
    const changed = await this.commitV2State((current) => {
      if (current.communityPluginParticipation) {
        published = readDeviceCommunityPluginParticipation(
          current.communityPluginParticipation,
          this.plugin.manifest.id,
        );
        return current;
      }
      const migrated = migrateLegacyCommunityPluginParticipation({
        ...input,
        ownPluginId: this.plugin.manifest.id,
      });
      published = migrated;
      return {
        ...current,
        meta: {
          ...current.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: now,
        },
        communityPluginParticipation: migrated,
      };
    });
    if (!published) {
      throw new Error("Community-plugin participation migration did not run");
    }
    return { changed, state: structuredClone(published) };
  }

  async updateCommunityPluginParticipation(
    command: Readonly<DeviceCommunityPluginParticipationCommand>,
    now = Date.now(),
  ): Promise<boolean> {
    return this.updateCommunityPluginParticipationBatch([command], now);
  }

  async updateCommunityPluginParticipationBatch(
    commands: readonly Readonly<DeviceCommunityPluginParticipationCommand>[],
    now = Date.now(),
  ): Promise<boolean> {
    if (commands.length === 0) return false;
    return this.commitV2State((current) => {
      if (!current.communityPluginParticipation) {
        throw new Error(
          "Community-plugin participation must be migrated before update",
        );
      }
      let next = current.communityPluginParticipation;
      for (const command of commands) {
        next = reduceDeviceCommunityPluginParticipation(
          next,
          command,
          this.plugin.manifest.id,
        );
      }
      if (
        JSON.stringify(next)
          === JSON.stringify(current.communityPluginParticipation)
      ) return current;
      return {
        ...current,
        meta: {
          ...current.meta,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: now,
        },
        communityPluginParticipation: next,
      };
    });
  }

  async getActiveV2ProtocolBinding():
    Promise<SharedSyncProtocolBinding | null> {
    if (
      !this.v2Envelope
      || !this.v2AuthorityWitnessStore
      || this.v2StateLoadBlock
    ) return null;
    const witness = await this.v2AuthorityWitnessStore.load();
    return witness?.protocolBinding
      ? structuredClone(witness.protocolBinding)
      : null;
  }

  async upgradeActiveV2ProtocolBinding(input: {
    expectedBinding: SharedSyncProtocolBinding;
    nextBinding: SharedSyncProtocolBinding;
    now?: number;
  }): Promise<void> {
    const task = this.v2StateCommitQueue.then(async () => {
      if (
        !this.v2Envelope
        || this.v2StateLoadBlock
        || this.v2Envelope.remoteScopeRecovery
        || this.activeSyncScopeExpansion
        || !this.v2AuthorityWitnessStore
        || !this.v2Store
        || this.mutationLedgerCorrupt
        || this.mutationRecoveryQuarantineCorrupt
        || this.mutationLedger.length > 0
        || this.mutationRecoveryQuarantine.length > 0
        || await this.v2Store.hasRecoveryJournal()
      ) {
        throw new Error("V2 protocol binding upgrade is not safe");
      }
      const durablePluginData = await this.plugin.loadData() ?? {};
      const publicRaw = durablePluginData[KEY_PUBLIC_MUTATION_LEDGER];
      const activeRaw = durablePluginData[KEY_MUTATION_LEDGER];
      const durablePublicLedger = parseMutationLedger(publicRaw);
      const durableActiveLedger = parseMutationLedger(activeRaw);
      if (
        isMalformedMutationLedger(publicRaw, durablePublicLedger)
        || isMalformedMutationLedger(activeRaw, durableActiveLedger)
        || mutationLedgersDisagree(durablePublicLedger, durableActiveLedger)
        || selectActiveMutationLedger(durablePublicLedger, durableActiveLedger).length > 0
      ) {
        throw new Error("V2 protocol binding upgrade has durable mutation recovery");
      }
      const paths = getEasySyncPaths(this.plugin.app.vault, this.plugin.manifest.id);
      const manifest = await readStateV2Manifest(
        this.plugin.app.vault.adapter,
        paths.stateV2ManifestFile,
      );
      const witness = await this.v2AuthorityWitnessStore.load();
      if (
        !manifest
        || witness?.status !== "active"
        || !sameStateV2AuthorityManifest(witness, manifest)
      ) throw new Error("V2 protocol binding authority changed");
      await this.v2AuthorityWitnessStore.upgradeProtocolBinding({
        expectedManifest: manifest,
        expectedRevision: witness.revision,
        expectedBinding: input.expectedBinding,
        nextBinding: input.nextBinding,
        now: input.now,
      });
    });
    this.v2StateCommitQueue = task.catch(() => undefined);
    await task;
  }

  /**
   * Open and durably probe the disposable evidence cache for the exact
   * active-authority/observed-scope/protocol tuple.
   */
  async beginRemoteScopeRecoveryEvidence(
    observedScope: SyncScope,
    protocolBinding: SharedSyncProtocolBinding,
    now = Date.now(),
  ): Promise<RemoteScopeRecoveryEvidenceOperationV1> {
    const source = this.v2Envelope;
    if (
      !source
      || !source.remoteScopeRecovery
      || !source.remoteScopeRecovery.observedScope
      || !sameSyncScope(
        source.remoteScopeRecovery.observedScope,
        observedScope,
      )
    ) {
      throw new Error(
        "Remote scope recovery evidence source is not the active hold",
      );
    }
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    const factory = this.plugin.createRemoteScopeRecoveryEvidenceStore;
    if (!vaultInstanceId || !factory) {
      throw new Error(
        "Remote scope recovery evidence persistence is unavailable",
      );
    }
    const store = this.remoteScopeRecoveryEvidenceStore
      ?? factory(vaultInstanceId);
    this.remoteScopeRecoveryEvidenceStore = store;
    const sourceStateDigest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(source);
    const protocolBindingDigest =
      await remoteScopeRecoveryProtocolBindingDigest(protocolBinding);
    return store.begin({
      vaultInstanceId,
      sourceDatabaseId:
        this.v2IndexedDbStore?.databaseId ?? "json-authority",
      sourceStateDigest,
      sourceCommitSeq: source.meta.commitSeq,
      sourceLifecycleEpoch: source.meta.lifecycleEpoch,
      sourceScope: structuredClone(source.scope),
      observedScope: structuredClone(observedScope),
      protocolBindingDigest,
    }, now);
  }

  /**
   * Open the disposable proof cache for an exact pre-commit first-sync cohort.
   * This cache never selects authority or permits a mutation; callers must
   * fall back to downloading the remote body when it is unavailable.
   */
  async beginFirstSyncVerificationEvidence(
    scope: SyncScope,
    source: Public113MigrationInput | null,
    protocolBinding: unknown,
    now = Date.now(),
  ): Promise<FirstSyncVerificationEvidenceOperationV2> {
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    const factory = this.plugin.createRemoteScopeRecoveryEvidenceStore;
    if (!vaultInstanceId || !factory) {
      throw new Error("First-sync verification evidence persistence is unavailable");
    }
    const store = this.remoteScopeRecoveryEvidenceStore
      ?? factory(vaultInstanceId);
    this.remoteScopeRecoveryEvidenceStore = store;
    const protocolBindingDigest =
      await remoteScopeRecoveryProtocolBindingDigest(protocolBinding ?? null);
    return store.beginFirstSyncVerification({
      operationKind: "first-sync-verification",
      vaultInstanceId,
      scope: structuredClone(scope),
      protocolBindingDigest,
      sourceCohort: source
        ? {
            kind: "public-1.1.3",
            sourceStateDigest: await public113MigrationInputDigest(source),
          }
        : { kind: "fresh" },
    }, now);
  }

  async readValidFirstSyncVerificationEvidence(
    operationId: string,
    versions: readonly RemoteScopeRecoveryRemoteVersionV1[],
  ): Promise<{
    receiptsByRemoteId: ReadonlyMap<
      string,
      RemoteScopeRecoveryEvidenceReceiptV1
    >;
    invalidated: number;
  }> {
    if (!this.remoteScopeRecoveryEvidenceStore) {
      throw new Error("First-sync verification evidence store is not open");
    }
    return this.remoteScopeRecoveryEvidenceStore.readValidReceipts(
      operationId,
      versions,
    );
  }

  async putVerifiedFirstSyncVerificationEvidence(
    receipt: RemoteScopeRecoveryEvidenceReceiptV1,
  ): Promise<void> {
    if (!this.remoteScopeRecoveryEvidenceStore) {
      throw new Error("First-sync verification evidence store is not open");
    }
    await this.remoteScopeRecoveryEvidenceStore.putVerified(receipt);
  }

  async readValidRemoteScopeRecoveryEvidence(
    operationId: string,
    versions: readonly RemoteScopeRecoveryRemoteVersionV1[],
  ): Promise<{
    receiptsByRemoteId: ReadonlyMap<
      string,
      RemoteScopeRecoveryEvidenceReceiptV1
    >;
    invalidated: number;
  }> {
    if (!this.remoteScopeRecoveryEvidenceStore) {
      throw new Error("Remote scope recovery evidence store is not open");
    }
    return this.remoteScopeRecoveryEvidenceStore.readValidReceipts(
      operationId,
      versions,
    );
  }

  async putVerifiedRemoteScopeRecoveryEvidence(
    receipt: RemoteScopeRecoveryEvidenceReceiptV1,
  ): Promise<void> {
    if (!this.remoteScopeRecoveryEvidenceStore) {
      throw new Error("Remote scope recovery evidence store is not open");
    }
    await this.remoteScopeRecoveryEvidenceStore.putVerified(receipt);
  }

  async summarizeRemoteScopeRecoveryEvidence(
    operationId: string,
  ): Promise<RemoteScopeRecoveryEvidenceSummaryV1> {
    if (!this.remoteScopeRecoveryEvidenceStore) {
      return { operationId, receipts: 0, updatedAt: 0 };
    }
    return this.remoteScopeRecoveryEvidenceStore.summarize(operationId);
  }

  async retireRemoteScopeRecoveryEvidence(operationId: string): Promise<void> {
    await this.remoteScopeRecoveryEvidenceStore?.retire(operationId);
  }

  async retireFirstSyncVerificationEvidence(operationId: string): Promise<void> {
    await this.remoteScopeRecoveryEvidenceStore?.retire(operationId);
  }

  async retireAllFirstSyncVerificationEvidence(): Promise<number> {
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    const factory = this.plugin.createRemoteScopeRecoveryEvidenceStore;
    if (!vaultInstanceId || !factory) return 0;
    const store = this.remoteScopeRecoveryEvidenceStore
      ?? factory(vaultInstanceId);
    this.remoteScopeRecoveryEvidenceStore = store;
    return store.retireFirstSyncVerificationOperations();
  }

  async hasV2RecoveryJournal(): Promise<boolean> {
    return this.v2Store ? this.v2Store.hasRecoveryJournal() : false;
  }

  /** Bind the vault to an account. Once bound, only this account can sync.
   *  Returns true if binding changed (needs save). */
  async bindAccount(accountId: string): Promise<void> {
    if (this.v2StateLoadBlock) {
      throw new Error("Cannot bind account while V2 load recovery is unresolved");
    }
    if (this.data[KEY_BOUND_ACCOUNT] === accountId) return;
    await this.save((current) => current[KEY_BOUND_ACCOUNT] === accountId
      ? current
      : { ...current, [KEY_BOUND_ACCOUNT]: accountId });
  }

  get syncHistory(): SyncHistoryEntry[] {
    return this.data[KEY_SYNC_HISTORY];
  }

  async addSyncHistory(entry: SyncHistoryEntry): Promise<void> {
    const normalized = { ...entry, files: retainFileProgress(entry.files) };
    await this.save((current) => ({
      ...current,
      [KEY_SYNC_HISTORY]: [
        normalized,
        ...current[KEY_SYNC_HISTORY].filter((item) => item.id !== entry.id),
      ].slice(0, 10),
    }));
  }

  // ---- Reset ----

  /**
   * Clear this device's complete sync authority, baselines and records.
   *
   * Main drains and invalidates live work before entering here. A local file
   * replacement journal remains owned by the normal executor, and unresolved
   * mutation evidence continues to block reset. Diagnostic logs, plugin
   * assets, user files and all cloud objects stay outside this cleanup.
   */
  async reset(): Promise<void> {
    if (
      this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || this.mutationLedger.length > 0
      || this.mutationRecoveryQuarantine.length > 0
    ) {
      throw new Error("Cannot reset while mutation recovery is unresolved");
    }
    const paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const adapter = this.plugin.app.vault.adapter;
    if (await new LocalRecoveryJournal(adapter, paths.tmpDir).hasPendingRecovery()) {
      throw new ConservativeResetBlockedError(
        "Cannot reset while a local file recovery journal is pending",
      );
    }

    const indexedDbStore = await this.indexedDbStoreForLocalReset(paths);
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    const evidenceStore = this.remoteScopeRecoveryEvidenceStore
      ?? (
        vaultInstanceId && this.plugin.createRemoteScopeRecoveryEvidenceStore
          ? this.plugin.createRemoteScopeRecoveryEvidenceStore(vaultInstanceId)
          : null
      );
    const publicCandidate = this.migrationHold
      && this.plugin.createPublic113IndexedDbCandidateStore
      ? this.plugin.createPublic113IndexedDbCandidateStore(
          this.migrationHold.sourceStateDigest,
        )
      : null;
    const nextPlanReviewRevision = this.data[KEY_PLAN_REVIEW_REVISION] + 1;
    await this.save(() => createDefaultData(0, nextPlanReviewRevision));

    try {
      // The committed manifest is the local V2 cutover point. Remove it before
      // deleting the selected database so an interruption cannot silently
      // select a missing authority. A retry may finish any remaining cleanup.
      await this.removeLocalSyncArtifact(paths.stateV2ManifestFile);
      if (indexedDbStore) {
        try {
          await indexedDbStore.delete();
        } finally {
          if (indexedDbStore === this.v2IndexedDbStore) {
            this.v2IndexedDbStore = null;
          }
        }
      }
      if (publicCandidate) {
        try {
          await publicCandidate.delete();
        } finally {
          await publicCandidate.close();
        }
      }
      if (evidenceStore) {
        await evidenceStore.delete();
        if (evidenceStore === this.remoteScopeRecoveryEvidenceStore) {
          this.remoteScopeRecoveryEvidenceStore = null;
        }
      }
      await this.removeRemainingLocalSyncArtifacts(paths);
      await clearEasySyncLegacyRuntimeLayout(
        adapter,
        getEasySyncLegacyPaths(
          this.plugin.app.vault,
          this.plugin.manifest.id,
        ),
      );
    } catch (error) {
      await this.load().catch(() => undefined);
      throw error;
    }
    await this.load();
  }

  /**
   * Rebuild every regenerable local state around an exact ordered set of
   * independent ordinary-file recoveries. The active V2 owner, ledger and
   * union of committed file identities remain authoritative; no second
   * planner or recovery record is introduced.
   */
  async resetPreservingIsolatedMutationRecovery(
    expectedEntries: readonly Readonly<MutationLedgerEntryV1>[],
  ): Promise<void> {
    const retainedEntries = structuredClone([...expectedEntries]);
    if (retainedEntries.length === 0) {
      throw new ConservativeResetBlockedError(
        "Cannot conservatively reset without mutation recovery evidence",
      );
    }
    const paths = getEasySyncPaths(
      this.plugin.app.vault,
      this.plugin.manifest.id,
    );
    const adapter = this.plugin.app.vault.adapter;
    if (await new LocalRecoveryJournal(
      adapter,
      paths.tmpDir,
    ).hasPendingRecovery()) {
      throw new ConservativeResetBlockedError(
        "Cannot reset while a local file recovery journal is pending",
      );
    }
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    const evidenceStore = this.remoteScopeRecoveryEvidenceStore
      ?? (
        vaultInstanceId && this.plugin.createRemoteScopeRecoveryEvidenceStore
          ? this.plugin.createRemoteScopeRecoveryEvidenceStore(vaultInstanceId)
          : null
      );
    await this.v2StateCommitQueue;
    await this.pluginDataCommitQueue;

    const capsule = this.isolatedMutationRecoveryIdentityCapsule(
      retainedEntries,
    );
    if (!capsule) {
      throw new ConservativeResetBlockedError(
        "Cannot conservatively reset without an exact V2 file identity capsule",
      );
    }
    const retainedMerges = retainedEntries.filter((record) =>
      record.intent.action === "merge");
    if (retainedMerges.length > 1) {
      throw new ConservativeResetBlockedError(
        "Conservative reset cannot preserve multiple merge payloads",
      );
    }
    const retainedMerge = retainedMerges[0];
    const mergeReady = retainedMerge
      && retainedMerge.intent.version === 1
      && retainedMerge.intent.target
      ? {
          operationId: retainedMerge.intent.operationId,
          target: structuredClone(retainedMerge.intent.target),
        }
      : null;
    const mergeReadyStore = new MergeReadyStore(adapter, paths.tmpDir);
    if (
      mergeReady
      && !await mergeReadyStore.read(
        mergeReady.operationId,
        mergeReady.target,
      )
    ) {
      throw new ConservativeResetBlockedError(
        "Conservative reset merge payload is missing or changed",
      );
    }
    const referencedAncestorHashes = new Set(
      capsule.fileAnchors
        .map((anchor) => anchor.ancestorHash)
        .filter((hash): hash is string => hash !== undefined),
    );
    const retainedAncestorHashes = new Set(
      await this.verifyV2AncestorHashes([...referencedAncestorHashes]),
    );
    for (const anchor of capsule.fileAnchors) {
      if (
        anchor.ancestorHash
        && !retainedAncestorHashes.has(anchor.ancestorHash)
      ) {
        delete anchor.ancestorHash;
      }
    }
    const durablePluginData = await this.plugin.loadData() ?? {};
    const durablePublicRaw = durablePluginData[KEY_PUBLIC_MUTATION_LEDGER];
    const durableActiveRaw = durablePluginData[KEY_MUTATION_LEDGER];
    const durablePublicLedger = parseMutationLedger(durablePublicRaw);
    const durableActiveLedger = parseMutationLedger(durableActiveRaw);
    const durableQuarantineRaw =
      durablePluginData[KEY_V2_RECOVERY_QUARANTINE];
    const durableQuarantine = parseMutationRecoveryQuarantine(
      durableQuarantineRaw,
    );
    if (
      isMalformedMutationLedger(durablePublicRaw, durablePublicLedger)
      || isMalformedMutationLedger(durableActiveRaw, durableActiveLedger)
      || mutationLedgersDisagree(durablePublicLedger, durableActiveLedger)
      || durablePublicLedger.length > 0
      || JSON.stringify(durableActiveLedger)
        !== JSON.stringify(retainedEntries)
      || durablePluginData[KEY_BOUND_ACCOUNT]
        !== this.v2Envelope?.scope.accountId
      || (
        durableQuarantineRaw !== undefined
        && (
          !Array.isArray(durableQuarantineRaw)
          || durableQuarantine.length !== durableQuarantineRaw.length
        )
      )
      || durableQuarantine.length > 0
    ) {
      throw new ConservativeResetBlockedError(
        "Conservative reset recovery evidence changed before authority commit",
      );
    }

    const sourceAuthority = await this.assertConservativeResetAuthority(
      paths,
      this.v2Envelope!,
    );

    const now = Date.now();
    await this.commitV2State((current) => {
      const liveCapsule = this.isolatedMutationRecoveryIdentityCapsule(
        retainedEntries,
        current,
      );
      if (!liveCapsule) {
        throw new ConservativeResetBlockedError(
          "Conservative reset identity capsule changed before authority commit",
        );
      }
      for (const anchor of liveCapsule.fileAnchors) {
        if (
          anchor.ancestorHash
          && !retainedAncestorHashes.has(anchor.ancestorHash)
        ) {
          delete anchor.ancestorHash;
        }
      }
      if (sameConservativeResetEnvelope(current, liveCapsule)) {
        return current;
      }
      const {
        remoteScopeRecovery: _remoteScopeRecovery,
        communityPluginParticipation: _communityPluginParticipation,
        ...retained
      } = current;
      const candidate: SyncStateEnvelopeV2 = {
        ...retained,
        meta: {
          ...current.meta,
          lifecycleEpoch: current.meta.lifecycleEpoch + 1,
          commitSeq: current.meta.commitSeq + 1,
          committedAt: now,
        },
        remoteIndex: {
          schemaVersion: 2,
          filesRootId: current.scope.filesRootId,
          cursorRevision: 0,
          deltaLink: null,
          complete: true,
          itemsById: {},
        },
        anchors: {
          schemaVersion: 2,
          byAnchorId: Object.fromEntries(
            liveCapsule.fileAnchors.map((anchor) => [
              anchor.anchorId,
              structuredClone(anchor),
            ]),
          ),
        },
        folderAnchors: {
          schemaVersion: 2,
          byAnchorId: Object.fromEntries(
            liveCapsule.folderAnchors.map((anchor) => [
              anchor.anchorId,
              structuredClone(anchor),
            ]),
          ),
        },
      };
      validateEnvelope(candidate);
      return candidate;
    });
    const committedEnvelope = this.v2Envelope;
    if (!committedEnvelope) {
      throw new Error("Conservative reset lost its V2 authority");
    }
    await this.assertConservativeResetAuthority(
      paths,
      committedEnvelope,
      sourceAuthority,
    );

    const nextPlanReviewRevision = this.data[KEY_PLAN_REVIEW_REVISION] + 1;
    await this.commitPluginData((current) => {
      if (
        current[KEY_BOUND_ACCOUNT] !== this.v2Envelope?.scope.accountId
        || JSON.stringify(current[KEY_PUBLIC_MUTATION_LEDGER]) !== "[]"
        || JSON.stringify(current[KEY_MUTATION_LEDGER])
          !== JSON.stringify(retainedEntries)
        || current[KEY_V2_RECOVERY_QUARANTINE].length > 0
      ) {
        throw new ConservativeResetBlockedError(
          "Conservative reset recovery evidence changed during state cleanup",
        );
      }
      const next = createDefaultData(0, nextPlanReviewRevision);
      next[KEY_BOUND_ACCOUNT] = current[KEY_BOUND_ACCOUNT];
      next[KEY_MUTATION_LEDGER] = structuredClone(retainedEntries);
      next[KEY_SYNC_PATH_SETTINGS_REVISION] =
        current[KEY_SYNC_PATH_SETTINGS_REVISION];
      next[KEY_SYNC_PATH_SETTINGS_FINGERPRINT] =
        current[KEY_SYNC_PATH_SETTINGS_FINGERPRINT];
      next[KEY_PUBLIC_113_CUTOVER] = current[KEY_PUBLIC_113_CUTOVER];
      return next;
    });

    try {
      if (this.v2IndexedDbStore && this.v2Envelope) {
        await this.createV2IndexedDbRecoveryStore(paths)
          .compact(this.v2Envelope);
      }
      if (evidenceStore) {
        await evidenceStore.delete();
        if (evidenceStore === this.remoteScopeRecoveryEvidenceStore) {
          this.remoteScopeRecoveryEvidenceStore = null;
        }
      }
      await this.removeRegenerableLocalSyncArtifacts(
        paths,
        retainedAncestorHashes,
        mergeReady !== null,
      );
      await clearEasySyncLegacyRuntimeLayout(
        adapter,
        getEasySyncLegacyPaths(
          this.plugin.app.vault,
          this.plugin.manifest.id,
        ),
      );
    } catch (error) {
      await this.load().catch(() => undefined);
      throw error;
    }
    await this.load();
    const reloaded = this.v2Envelope;
    if (
      !reloaded
      || this.v2StateLoadBlock
      || this.legacyStateAllowed
      || !sameSyncScope(reloaded.scope, retainedEntries[0].intent.scope)
      || JSON.stringify(this.mutationLedger)
        !== JSON.stringify(retainedEntries)
      || !sameConservativeResetEnvelope(reloaded, capsule)
    ) {
      throw new Error(
        "Conservative reset failed its final authority reload",
      );
    }
    await this.assertConservativeResetAuthority(
      paths,
      reloaded,
      sourceAuthority,
    );
    if (
      mergeReady
      && !await mergeReadyStore.read(
        mergeReady.operationId,
        mergeReady.target,
      )
    ) {
      throw new Error(
        "Conservative reset lost its retained merge payload",
      );
    }
  }

  private async assertConservativeResetAuthority(
    paths: ReturnType<typeof getEasySyncPaths>,
    expectedEnvelope: Readonly<SyncStateEnvelopeV2>,
    expectedBinding?: Readonly<{
      manifest: StateV2Manifest;
      witness: StateV2AuthorityWitness;
      storageKind: "json" | "indexeddb";
      databaseId: string | null;
      vaultInstanceId: string | null;
    }>,
  ): Promise<{
    manifest: StateV2Manifest;
    witness: StateV2AuthorityWitness;
    storageKind: "json" | "indexeddb";
    databaseId: string | null;
    vaultInstanceId: string | null;
  }> {
    if (
      !this.v2Store
      || !this.v2AuthorityWitnessStore
      || this.v2StateLoadBlock
    ) {
      throw new ConservativeResetBlockedError(
        "Conservative reset V2 authority is unavailable",
      );
    }
    const manifest = await readStateV2Manifest(
      this.plugin.app.vault.adapter,
      paths.stateV2ManifestFile,
    );
    const witness = await this.v2AuthorityWitnessStore.load();
    if (
      !manifest
      || !witness
      || witness.status !== "active"
      || !sameStateV2AuthorityManifest(witness, manifest)
      || !sameSyncScope(manifest.scope, expectedEnvelope.scope)
      || expectedEnvelope.meta.commitSeq < manifest.stateCommitSeq
      || expectedEnvelope.meta.lifecycleEpoch < manifest.lifecycleEpoch
    ) {
      throw new ConservativeResetBlockedError(
        "Conservative reset manifest or authority witness changed",
      );
    }

    const selected = witness.storageAuthority;
    let binding: {
      manifest: StateV2Manifest;
      witness: StateV2AuthorityWitness;
      storageKind: "json" | "indexeddb";
      databaseId: string | null;
      vaultInstanceId: string | null;
    };
    if (this.v2IndexedDbStore) {
      const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
      if (
        !vaultInstanceId
        || !selected
        || selected.schemaVersion !== 2
        || selected.databaseId !== this.v2IndexedDbStore.databaseId
        || selected.vaultInstanceId !== vaultInstanceId
      ) {
        throw new ConservativeResetBlockedError(
          "Conservative reset IndexedDB authority binding changed",
        );
      }
      const [inspection, digest] = await Promise.all([
        this.v2IndexedDbStore.inspect(),
        stateV2IndexedDbRecoveryEnvelopeDigest(expectedEnvelope),
      ]);
      if (
        inspection.phase !== "ready"
        || inspection.databaseId !== selected.databaseId
        || inspection.commitSeq !== expectedEnvelope.meta.commitSeq
        || inspection.lifecycleEpoch !== expectedEnvelope.meta.lifecycleEpoch
        || inspection.stateDigest !== digest
      ) {
        throw new Error(
          "Conservative reset IndexedDB authority state changed",
        );
      }
      binding = {
        manifest: structuredClone(manifest),
        witness: structuredClone(witness),
        storageKind: "indexeddb",
        databaseId: selected.databaseId,
        vaultInstanceId,
      };
    } else {
      if (selected) {
        throw new ConservativeResetBlockedError(
          "Conservative reset JSON authority is no longer selected",
        );
      }
      const durableEnvelope = await this.v2Store.load(manifest.scope);
      if (
        !durableEnvelope
        || JSON.stringify(durableEnvelope)
          !== JSON.stringify(expectedEnvelope)
      ) {
        throw new Error(
          "Conservative reset JSON authority state changed",
        );
      }
      binding = {
        manifest: structuredClone(manifest),
        witness: structuredClone(witness),
        storageKind: "json",
        databaseId: null,
        vaultInstanceId: null,
      };
    }
    if (
      expectedBinding
      && (
        JSON.stringify(binding.manifest)
          !== JSON.stringify(expectedBinding.manifest)
        || JSON.stringify(binding.witness)
          !== JSON.stringify(expectedBinding.witness)
        || binding.storageKind !== expectedBinding.storageKind
        || binding.databaseId !== expectedBinding.databaseId
        || binding.vaultInstanceId !== expectedBinding.vaultInstanceId
      )
    ) {
      throw new ConservativeResetBlockedError(
        "Conservative reset authority changed during the transaction",
      );
    }
    return binding;
  }

  private isolatedMutationRecoveryIdentityCapsule(
    expectedEntries: readonly Readonly<MutationLedgerEntryV1>[],
    envelope = this.v2Envelope,
  ): {
    fileAnchors: SyncAnchorV2[];
    folderAnchors: FolderAnchorV2[];
  } | null {
    const scope = expectedEntries[0]?.intent.scope;
    if (
      expectedEntries.length === 0
      || !scope
      || !envelope
      || this.v2StateLoadBlock
      || this.legacyStateAllowed
      || envelope.remoteScopeRecovery
      || this.activeSyncScopeExpansion
      || isActiveMigrationHoldV2(this.migrationHold)
      || this.v2CorruptRecoveryHold
      || this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || this.mutationRecoveryQuarantine.length > 0
      || JSON.stringify(this.mutationLedger)
        !== JSON.stringify(expectedEntries)
      || !sameSyncScope(scope, envelope.scope)
      || this.data[KEY_BOUND_ACCOUNT] !== envelope.scope.accountId
    ) return null;

    if (expectedEntries.some((record) =>
      !isConservativeResetOrdinaryRecord(record, envelope.scope))) {
      return null;
    }
    const currentPathByRemoteId = projectRemoteIndexV2(
      envelope.remoteIndex,
    );
    if (!areIndependentConservativeResetRecords(
      expectedEntries,
      currentPathByRemoteId,
      Object.values(envelope.anchors.byAnchorId),
    )) return null;

    const anchors = Object.values(envelope.anchors.byAnchorId);
    const claims = expectedEntries.map((record) => ({
      record,
      pathKeys: new Set(conservativeResetRecordPaths(record).map(
        (path) => normalizeFolderIdentityPath(path),
      )),
      remoteIds: conservativeResetRecordRemoteIds(record),
      anchorIds: new Set<string>(),
    }));

    // deleteLocal intentionally carries expectedRemote=false. Its unique old
    // committed anchor supplies the exact Graph identity which the ordinary
    // recovery owner must prove absent before the record may settle.
    for (const claim of claims) {
      const intent = claim.record.intent;
      if (
        intent.version !== 1
        || intent.action !== "deleteLocal"
        || !intent.expectedLocal.exists
        || claim.remoteIds.size > 0
      ) continue;
      const expectedLocal = intent.expectedLocal;
      const candidates = anchors.filter((anchor) =>
        anchor.remoteId !== undefined
        && normalizeFolderIdentityPath(anchor.lastPath)
          === normalizeFolderIdentityPath(intent.path)
        && anchor.contentHash === expectedLocal.hash
        && anchor.size === expectedLocal.size);
      if (candidates.length === 0 && claim.record.receipt !== null) continue;
      if (candidates.length !== 1 || !candidates[0].remoteId) return null;
      claim.remoteIds.add(candidates[0].remoteId);
    }

    const remoteIdOwner = new Map<string, number>();
    for (const [index, claim] of claims.entries()) {
      for (const remoteId of claim.remoteIds) {
        if (remoteIdOwner.has(remoteId)) return null;
        remoteIdOwner.set(remoteId, index);
        const currentPath = currentPathByRemoteId.get(remoteId);
        if (currentPath) {
          claim.pathKeys.add(normalizeFolderIdentityPath(currentPath));
        }
      }
    }
    for (const anchor of anchors) {
      if (!anchor.remoteId) continue;
      const owner = remoteIdOwner.get(anchor.remoteId);
      if (owner === undefined) continue;
      claims[owner].anchorIds.add(anchor.anchorId);
      claims[owner].pathKeys.add(
        normalizeFolderIdentityPath(anchor.lastPath),
      );
    }

    const pathOwner = new Map<string, number>();
    for (const [index, claim] of claims.entries()) {
      for (const pathKey of claim.pathKeys) {
        if (pathOwner.has(pathKey)) return null;
        pathOwner.set(pathKey, index);
      }
    }
    // A distinct committed anchor occupying any owned source/target/current
    // path is not safe to preserve as a second baseline. It also closes the
    // indirect overlap A.path <-> anchor.remoteId <-> B.id.
    for (const anchor of anchors) {
      const pathOwnerIndex = pathOwner.get(
        normalizeFolderIdentityPath(anchor.lastPath),
      );
      if (
        pathOwnerIndex !== undefined
        && !claims[pathOwnerIndex].anchorIds.has(anchor.anchorId)
      ) return null;
    }

    for (const claim of claims) {
      const intent = claim.record.intent;
      if (intent.version !== 1) return null;
      const claimedAnchors = anchors.filter((anchor) =>
        claim.anchorIds.has(anchor.anchorId));
      if (claimedAnchors.length > 1) return null;
      const [anchor] = claimedAnchors;
      if (
        anchor
        && !anchorMatchesConservativeResetRecord(anchor, claim.record)
      ) return null;
      if (claim.record.receipt === null) {
        if (
          intent.action === "upload"
          && (
            !intent.expectedRemote.exists
            || !anchor
            || anchor.remoteId !== intent.expectedRemote.driveId
            || normalizeFolderIdentityPath(anchor.lastPath)
              !== normalizeFolderIdentityPath(intent.path)
          )
        ) return null;
        if (
          intent.action === "download"
          && intent.expectedLocal.exists
          && !anchor
        ) return null;
        if (
          intent.action === "deleteRemote"
          && !anchor
        ) return null;
        if (
          (intent.action === "renameRemote"
            || intent.action === "moveLocal")
          && (
            !intent.sourcePath
            || !anchor
            || normalizeFolderIdentityPath(anchor.lastPath)
              !== normalizeFolderIdentityPath(intent.sourcePath)
          )
        ) return null;
        if (
          (intent.action === "deleteLocal" || intent.action === "merge")
          && (
            !anchor
            || normalizeFolderIdentityPath(anchor.lastPath)
              !== normalizeFolderIdentityPath(intent.path)
          )
        ) return null;
      } else if (
        ((intent.action === "upload" && intent.expectedRemote.exists)
          || (intent.action === "download" && intent.expectedLocal.exists)
          || intent.action === "renameRemote"
          || intent.action === "moveLocal"
          || intent.action === "merge")
        && !anchor
      ) return null;
    }

    const retainedAnchorIds = new Set(
      claims.flatMap((claim) => [...claim.anchorIds]),
    );
    const fileAnchors = anchors
      .filter((anchor) => retainedAnchorIds.has(anchor.anchorId))
      .map((anchor) => structuredClone(anchor));

    return {
      fileAnchors,
      // Folder identity is rebuilt from the complete remote index before
      // recovery/planning. The shared protected-path boundary keeps both the
      // old and current parent shells out of the folder planner, so retaining
      // a stale or incomplete folder-anchor chain would add no safety.
      folderAnchors: [],
    };
  }

  private async removeRegenerableLocalSyncArtifacts(
    paths: ReturnType<typeof getEasySyncPaths>,
    retainedAncestorHashes: ReadonlySet<string>,
    retainMergeReady = false,
  ): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    const root = await adapter.list(paths.pluginDir);
    const dynamicArtifacts = root.files.filter((path) =>
      path.startsWith(paths.stateV2CorruptSourcePrefix)
      || path.startsWith(paths.stateV2ReactivationArchivePrefix)
    );
    for (const path of [
      paths.remoteStateFile,
      paths.stateV2RetiredManifestFile,
      paths.stateV2RollbackFile,
      paths.stateV2MigrationHoldFile,
      paths.stateV2MigrationHoldNextFile,
      paths.stateV2ScopeTransitionFile,
      paths.stateV2ScopeTransitionNextFile,
      paths.stateV2CorruptRecoveryFile,
      paths.stateV2CorruptRecoveryNextFile,
      paths.stateV2CorruptPublicationFile,
      paths.stateV2CorruptPublicationNextFile,
      paths.stateV1BackupFile,
      paths.baseContentFile,
      paths.ancestorManifestV2NextFile,
      paths.scanCacheFile,
      ...dynamicArtifacts,
    ]) {
      await this.removeLocalSyncArtifact(path);
    }
    if (retainedAncestorHashes.size > 0) {
      await this.createAncestorStoreV2(paths).sweep(
        retainedAncestorHashes,
        new Set(),
        new Set(),
      );
    } else {
      await this.removeLocalSyncArtifact(paths.ancestorManifestV2File);
    }
    for (const directory of [
      ...(retainedAncestorHashes.size === 0 ? [paths.ancestorsV2Dir] : []),
      ...(retainMergeReady ? [] : [paths.tmpDir]),
    ]) {
      if (await adapter.exists(directory)) {
        await adapter.rmdir(directory, true);
      }
    }
  }

  private async indexedDbStoreForLocalReset(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): Promise<StateV2IndexedDbActiveStore | null> {
    if (this.v2IndexedDbStore) return this.v2IndexedDbStore;
    const factory = this.plugin.createStateV2IndexedDbActiveStore;
    const vaultInstanceId = this.currentIndexedDbVaultInstanceId();
    if (!factory || !vaultInstanceId || !this.v2AuthorityWitnessStore) {
      return null;
    }
    let witness: StateV2AuthorityWitness | null;
    try {
      witness = await this.v2AuthorityWitnessStore.load();
    } catch {
      return null;
    }
    const authority = witness?.storageAuthority;
    if (
      !authority
      || authority.schemaVersion !== 2
      || authority.vaultInstanceId !== vaultInstanceId
    ) {
      return null;
    }
    return factory(
      authority.databaseId,
      this.createV2IndexedDbRecoveryStore(paths),
    );
  }

  private async removeRemainingLocalSyncArtifacts(
    paths: ReturnType<typeof getEasySyncPaths>,
  ): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    const root = await adapter.list(paths.pluginDir);
    const dynamicArtifacts = root.files.filter((path) =>
      path.startsWith(paths.stateV2CorruptSourcePrefix)
      || path.startsWith(paths.stateV2ReactivationArchivePrefix)
    );
    const files = [
      paths.remoteStateFile,
      paths.stateV2File,
      paths.stateV2NextFile,
      paths.stateV2PreviousFile,
      paths.stateV2RecoveryFile,
      paths.stateV2ManifestNextFile,
      paths.stateV2AuthorityWitnessFile,
      paths.stateV2AuthorityWitnessNextFile,
      paths.stateV2RetiredManifestFile,
      paths.stateV2RollbackFile,
      paths.stateV2MigrationHoldFile,
      paths.stateV2MigrationHoldNextFile,
      paths.stateV2ScopeTransitionFile,
      paths.stateV2ScopeTransitionNextFile,
      paths.stateV2CorruptRecoveryFile,
      paths.stateV2CorruptRecoveryNextFile,
      paths.stateV2CorruptPublicationFile,
      paths.stateV2CorruptPublicationNextFile,
      paths.stateV1BackupFile,
      paths.baseContentFile,
      paths.ancestorManifestV2File,
      paths.ancestorManifestV2NextFile,
      paths.scanCacheFile,
      ...dynamicArtifacts,
    ];
    for (const path of [...new Set(files)]) {
      await this.removeLocalSyncArtifact(path);
    }
    for (const directory of [
      paths.ancestorsV2Dir,
      paths.stateV2IndexedDbRecoveryDir,
      paths.tmpDir,
    ]) {
      if (await adapter.exists(directory)) {
        await adapter.rmdir(directory, true);
      }
    }
  }

  private async removeLocalSyncArtifact(path: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(path)) await adapter.remove(path);
  }
}

function sameBaseEntry(
  left: BaseFileEntry | undefined,
  right: BaseFileEntry,
): boolean {
  return left?.hash === right.hash
    && left.size === right.size
    && left.eTag === right.eTag;
}

function fileMutationCheckpointIsReflected(
  envelope: Readonly<SyncStateEnvelopeV2>,
  record: Readonly<MutationLedgerEntryV1>,
): boolean {
  if (
    !record.receipt
    || isFolderMutationIntent(record.intent)
    || record.manualResolution !== undefined
    || !sameSyncScope(record.intent.scope, envelope.scope)
    || envelope.remoteIndex.complete !== true
  ) return false;
  if (!isOrdinaryFileRecoveryRecord(record, envelope.scope)) return false;
  const checkpoint = record.receipt.checkpoint;
  const anchors = Object.values(envelope.anchors.byAnchorId);
  const anchorsAtPath = (path: string): SyncAnchorV2[] => anchors.filter(
    (anchor) => normalizeFolderIdentityPath(anchor.lastPath)
      === normalizeFolderIdentityPath(path),
  );
  for (const base of checkpoint.baseUpserts) {
    const candidates = anchorsAtPath(base.path).filter((anchor) =>
      anchor.contentHash === base.hash
        && anchor.size === base.size
        && anchor.remoteETag === base.eTag);
    if (candidates.length !== 1) return false;
    const remote = checkpoint.remoteUpserts.find((entry) =>
      normalizeFolderIdentityPath(entry.path)
        === normalizeFolderIdentityPath(base.path));
    const expectedRemoteId = remote?.driveId
      ?? (record.intent.expectedRemote.exists
        ? record.intent.expectedRemote.driveId
        : undefined);
    if (!expectedRemoteId || candidates[0].remoteId !== expectedRemoteId) {
      return false;
    }
  }
  for (const path of checkpoint.baseRemovals) {
    if (anchorsAtPath(path).length > 0) return false;
  }
  if (checkpoint.baseUpserts.length === 0) {
    const pathById = projectRemoteIndexV2(envelope.remoteIndex);
    for (const remote of checkpoint.remoteUpserts) {
      const node = envelope.remoteIndex.itemsById[remote.driveId];
      if (
        !node
        || node.kind !== "file"
        || normalizeFolderIdentityPath(pathById.get(remote.driveId) ?? "")
          !== normalizeFolderIdentityPath(remote.path)
        || node.eTag !== remote.eTag
        || node.size !== remote.size
        || (
          remote.sha256Hash !== undefined
          && node.contentHash?.toLowerCase()
            !== remote.sha256Hash.toLowerCase()
        )
      ) return false;
    }
  }
  return true;
}

function sameConservativeResetEnvelope(
  envelope: Readonly<SyncStateEnvelopeV2>,
  capsule: Readonly<{
    fileAnchors: readonly Readonly<SyncAnchorV2>[];
    folderAnchors: readonly Readonly<FolderAnchorV2>[];
  }>,
): boolean {
  const sorted = <T extends { anchorId: string }>(
    values: readonly Readonly<T>[],
  ): Readonly<T>[] => [...values].sort((left, right) =>
    left.anchorId.localeCompare(right.anchorId));
  return envelope.remoteIndex.cursorRevision === 0
    && envelope.remoteIndex.deltaLink === null
    && envelope.remoteIndex.complete === true
    && envelope.remoteIndex.filesRootId === envelope.scope.filesRootId
    && Object.keys(envelope.remoteIndex.itemsById).length === 0
    && envelope.remoteScopeRecovery === undefined
    && envelope.communityPluginParticipation === undefined
    && JSON.stringify(sorted(Object.values(envelope.anchors.byAnchorId)))
      === JSON.stringify(sorted(capsule.fileAnchors))
    && JSON.stringify(sorted(Object.values(
      envelope.folderAnchors?.byAnchorId ?? {},
    ))) === JSON.stringify(sorted(capsule.folderAnchors));
}

function anchorMatchesConservativeResetRecord(
  anchor: Readonly<SyncAnchorV2>,
  record: Readonly<MutationLedgerEntryV1>,
): boolean {
  const intent = record.intent;
  if (intent.version !== 1) return false;
  const pathMatches = (left: string, right: string): boolean =>
    normalizeFolderIdentityPath(left) === normalizeFolderIdentityPath(right);
  const localVersionMatches = (): boolean => intent.expectedLocal.exists
    && anchor.contentHash === intent.expectedLocal.hash
    && anchor.size === intent.expectedLocal.size;
  const remoteVersionMatches = (): boolean => intent.expectedRemote.exists
    && anchor.remoteId === intent.expectedRemote.driveId
    && anchor.remoteETag === intent.expectedRemote.eTag
    && anchor.size === intent.expectedRemote.size
    && (
      intent.expectedRemote.sha256Hash === undefined
      || anchor.contentHash
        === intent.expectedRemote.sha256Hash.toLowerCase()
    );

  let preState = false;
  switch (intent.action) {
    case "upload":
      preState = pathMatches(anchor.lastPath, intent.path)
        && remoteVersionMatches();
      break;
    case "download":
      preState = pathMatches(anchor.lastPath, intent.path)
        && intent.expectedRemote.exists
        && anchor.remoteId === intent.expectedRemote.driveId
        && localVersionMatches();
      break;
    case "deleteRemote":
      preState = pathMatches(anchor.lastPath, intent.path)
        && remoteVersionMatches();
      break;
    case "deleteLocal":
      preState = pathMatches(anchor.lastPath, intent.path)
        && localVersionMatches();
      break;
    case "renameRemote":
    case "moveLocal":
      preState = Boolean(intent.sourcePath)
        && pathMatches(anchor.lastPath, intent.sourcePath!)
        && intent.expectedRemote.exists
        && anchor.remoteId === intent.expectedRemote.driveId
        && anchor.remoteETag === intent.expectedRemote.eTag
        && localVersionMatches();
      break;
    case "merge":
      preState = pathMatches(anchor.lastPath, intent.path)
        && intent.expectedRemote.exists
        && anchor.remoteId === intent.expectedRemote.driveId;
      break;
  }
  if (preState) return true;
  if (!record.receipt) return false;

  const base = record.receipt.checkpoint.baseUpserts.find((entry) =>
    pathMatches(entry.path, anchor.lastPath));
  if (!base
    || anchor.contentHash !== base.hash
    || anchor.size !== base.size
    || anchor.remoteETag !== base.eTag) return false;
  const remote = record.receipt.checkpoint.remoteUpserts.find((entry) =>
    pathMatches(entry.path, anchor.lastPath));
  if (remote) {
    return anchor.remoteId === remote.driveId
      && anchor.remoteETag === remote.eTag;
  }
  return intent.action === "download"
    && intent.expectedRemote.exists
    && anchor.remoteId === intent.expectedRemote.driveId;
}

function parseLocalFolderMoveHints(value: unknown): LocalFolderMoveHintV1[] {
  if (!Array.isArray(value)) return [];
  const byRemoteId = new Map<string, LocalFolderMoveHintV1>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const hint = raw as Partial<LocalFolderMoveHintV1>;
    if (
      hint.version !== 1
      || !isSyncScope(hint.scope)
      || typeof hint.remoteId !== "string"
      || hint.remoteId.length === 0
      || !isVaultRelativeMutationPath(hint.fromPath)
      || !isVaultRelativeMutationPath(hint.toPath)
      || normalizeFolderIdentityPath(hint.fromPath)
        === normalizeFolderIdentityPath(hint.toPath)
      || typeof hint.observedAt !== "number"
      || !Number.isFinite(hint.observedAt)
    ) continue;
    const existing = byRemoteId.get(hint.remoteId);
    if (!existing || existing.observedAt < hint.observedAt) {
      byRemoteId.set(hint.remoteId, {
        version: 1,
        scope: { ...hint.scope },
        remoteId: hint.remoteId,
        fromPath: hint.fromPath,
        toPath: hint.toPath,
        observedAt: hint.observedAt,
      });
    }
  }
  return [...byRemoteId.values()]
    .sort((left, right) => left.remoteId.localeCompare(right.remoteId));
}

function normalizeFolderIdentityPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

function uniqueIdentityPaths(paths: readonly string[]): string[] {
  const byIdentity = new Map<string, string>();
  for (const path of paths) {
    const identity = normalizeFolderIdentityPath(path);
    if (!byIdentity.has(identity)) byIdentity.set(identity, path);
  }
  return [...byIdentity.values()].sort((left, right) => left.localeCompare(right));
}

function isFolderIdentityPathAtOrBelow(path: string, root: string): boolean {
  const normalizedPath = normalizeFolderIdentityPath(path);
  const normalizedRoot = normalizeFolderIdentityPath(root);
  return normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function isSameOrDescendantPath(path: string, root: string): boolean {
  const normalizedPath = path.normalize("NFC");
  const normalizedRoot = root.normalize("NFC");
  return normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function deduplicateReconstructionRoots(
  roots: readonly ConfirmedDescendantFileReconstructionRootV1[],
): ConfirmedDescendantFileReconstructionRootV1[] {
  const byPath = new Map<string, ConfirmedDescendantFileReconstructionRootV1>();
  for (const root of [...roots].sort((left, right) =>
    left.path.localeCompare(right.path))) {
    const pathKey = normalizeFolderIdentityPath(root.path);
    if (
      [...byPath.values()].some((candidate) =>
        isSameOrDescendantPath(root.path, candidate.path),
      )
    ) continue;
    byPath.set(pathKey, { ...root });
  }
  return [...byPath.values()];
}

function readConfirmedDescendantFileReconstructionCheckpointV1(
  value: unknown,
): ConfirmedDescendantFileReconstructionCheckpointV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate =
    value as Partial<ConfirmedDescendantFileReconstructionCheckpointV1>;
  if (
    candidate.version !== 1
    || candidate.kind !== "confirmed-descendant-file-reconstruction"
    || !isSyncScope(candidate.scope)
    || !Number.isSafeInteger(candidate.lifecycleEpoch)
    || Number(candidate.lifecycleEpoch) < 1
    || !Number.isSafeInteger(candidate.sourceCommitSeq)
    || Number(candidate.sourceCommitSeq) < 1
    || typeof candidate.startedAt !== "number"
    || !Number.isFinite(candidate.startedAt)
    || !Array.isArray(candidate.roots)
    || candidate.roots.length === 0
    || candidate.roots.length > 32
  ) return null;
  const roots: ConfirmedDescendantFileReconstructionRootV1[] = [];
  const paths = new Set<string>();
  const remoteIds = new Set<string>();
  for (const raw of candidate.roots) {
    if (!raw || typeof raw !== "object") return null;
    const root =
      raw as Partial<ConfirmedDescendantFileReconstructionRootV1>;
    if (
      !isVaultRelativeMutationPath(root.path)
      || typeof root.remoteId !== "string"
      || root.remoteId.length === 0
      || !Number.isSafeInteger(root.confirmedGeneration)
      || Number(root.confirmedGeneration) < 1
    ) return null;
    const pathKey = normalizeFolderIdentityPath(root.path);
    if (paths.has(pathKey) || remoteIds.has(root.remoteId)) return null;
    paths.add(pathKey);
    remoteIds.add(root.remoteId);
    roots.push({
      path: root.path,
      remoteId: root.remoteId,
      confirmedGeneration: Number(root.confirmedGeneration),
    });
  }
  return {
    version: 1,
    kind: "confirmed-descendant-file-reconstruction",
    scope: { ...candidate.scope },
    lifecycleEpoch: Number(candidate.lifecycleEpoch),
    sourceCommitSeq: Number(candidate.sourceCommitSeq),
    roots: deduplicateReconstructionRoots(roots),
    startedAt: candidate.startedAt,
  };
}

function parseRemoteState(value: unknown): RemoteSyncState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<RemoteSyncState>;
  if (state.version !== 1) return null;
  if (typeof state.generation !== "number") (state as Record<string, unknown>).generation = 0;
  const rawScope = (state).scope;
  if (rawScope !== undefined && rawScope !== null && !isSyncScope(rawScope)) return null;
  if (state.deltaLink !== null && typeof state.deltaLink !== "string") return null;
  if (!state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
    return null;
  }
  for (const [path, entry] of Object.entries(state.entries)) {
    if (!isRemoteEntry(entry) || entry.path !== path) return null;
  }
  const rawFolders = (state).folders;
  if (rawFolders !== undefined && (
    !rawFolders
    || typeof rawFolders !== "object"
    || Array.isArray(rawFolders)
  )) return null;
  const folders = (rawFolders ?? {});
  for (const [driveId, folder] of Object.entries(folders)) {
    if (!isRemoteFolderEntry(folder) || folder.driveId !== driveId) return null;
  }
  const rawFolderIndexComplete = (
    state
  ).folderIndexComplete;
  if (
    rawFolderIndexComplete !== undefined
    && typeof rawFolderIndexComplete !== "boolean"
  ) return null;
  return {
    version: 1,
    generation: state.generation ?? 0,
    scope: rawScope ?? null,
    deltaLink: state.deltaLink ?? null,
    entries: state.entries,
    folders,
    folderIndexComplete: rawFolderIndexComplete === true,
  };
}

function parseCanonicalPlanIdentityV2(
  value: unknown,
): CanonicalPlanIdentityV2 | null {
  if (
    !isRecord(value)
    || value.version !== 2
    || !Number.isSafeInteger(value.sourceCommitSeq)
    || Number(value.sourceCommitSeq) < 0
    || typeof value.digest !== "string"
    || value.digest.length === 0
    || !isSyncScope(value.scope)
  ) return null;
  return {
    version: 2,
    sourceCommitSeq: Number(value.sourceCommitSeq),
    digest: value.digest,
    scope: { ...value.scope },
  };
}

function isSyncScope(value: unknown): value is SyncScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Partial<SyncScope>;
  return typeof scope.accountId === "string"
    && typeof scope.driveId === "string"
    && typeof scope.vaultFolderId === "string"
    && typeof scope.filesRootId === "string";
}

function parseMutationLedger(value: unknown): MutationLedgerEntryV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isMutationLedgerEntry)) return [];
  const operationIds = new Set<string>();
  for (const entry of value) {
    if (operationIds.has(entry.intent.operationId)) return [];
    operationIds.add(entry.intent.operationId);
  }
  return value;
}

function findUniqueMutationLedgerRecordIndex(
  records: readonly Readonly<MutationLedgerEntryV1>[],
  operationId: string,
): number {
  let found = -1;
  for (const [index, record] of records.entries()) {
    if (record.intent.operationId !== operationId) continue;
    if (found >= 0) {
      throw new Error(`Duplicate mutation operation: ${operationId}`);
    }
    found = index;
  }
  return found;
}

function requiresOrdinaryFileRecoverySemanticGate(
  record: Readonly<MutationLedgerEntryV1>,
): boolean {
  return record.intent.version === 1
    && record.intent.stateEffect === undefined
    && record.manualResolution === undefined;
}

function isMalformedMutationLedger(
  raw: unknown,
  parsed: readonly MutationLedgerEntryV1[],
): boolean {
  return raw !== undefined
    && (!Array.isArray(raw) || parsed.length !== raw.length);
}

function sameMutationLedger(
  left: readonly MutationLedgerEntryV1[],
  right: readonly MutationLedgerEntryV1[],
): boolean {
  return left.length === right.length
    && JSON.stringify(left) === JSON.stringify(right);
}

function mutationLedgersDisagree(
  publicLedger: readonly MutationLedgerEntryV1[],
  activeLedger: readonly MutationLedgerEntryV1[],
): boolean {
  return publicLedger.length > 0
    && activeLedger.length > 0
    && !sameMutationLedger(publicLedger, activeLedger);
}

function selectActiveMutationLedger(
  publicLedger: MutationLedgerEntryV1[],
  activeLedger: MutationLedgerEntryV1[],
): MutationLedgerEntryV1[] {
  return activeLedger.length === 0 && publicLedger.length > 0
    ? publicLedger
    : activeLedger;
}

function parseManualMutationResolutionAudit(
  value: unknown,
): ManualMutationResolutionAuditV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isManualMutationResolutionAudit)) {
    return [];
  }
  return value.slice(-20);
}

function parseMutationRecoveryQuarantine(
  value: unknown,
): MutationRecoveryQuarantineEntryV2[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || !value.every(isMutationRecoveryQuarantineEntryV2)
  ) return [];
  const operationIds = new Set<string>();
  for (const entry of value) {
    if (operationIds.has(entry.operationId)) return [];
    operationIds.add(entry.operationId);
  }
  return value;
}

function isMutationRecoveryQuarantineEntryV2(
  value: unknown,
): value is MutationRecoveryQuarantineEntryV2 {
  if (!isRecord(value) || !isRecord(value.evidence)) return false;
  const record = value.record;
  return value.version === 2
    && value.kind === "mutation-recovery-quarantine"
    && typeof value.operationId === "string"
    && value.operationId.length > 0
    && value.reason === "receipted-upload-version-unreachable"
    && typeof value.quarantinedAt === "number"
    && Number.isFinite(value.quarantinedAt)
    && isSyncScope(value.scope)
    && Number.isSafeInteger(value.sourceCommitSeq)
    && Number(value.sourceCommitSeq) >= 1
    && typeof value.remoteId === "string"
    && value.remoteId.length > 0
    && value.evidence.localMissing === true
    && value.evidence.completeRemoteIndex === true
    && value.evidence.remotePathMissing === true
    && value.evidence.remoteIdMissing === true
    && value.evidence.graphItemMissing === true
    && isMutationLedgerEntry(record)
    && record.intent.operationId === value.operationId
    && record.intent.action === "upload"
    && record.receipt !== null
    && sameSyncScope(record.intent.scope, value.scope)
    && record.receipt.checkpoint.remoteUpserts.some(
      (entry) =>
        entry.path === record.intent.path
        && entry.driveId === value.remoteId,
    );
}

function isMutationLedgerEntry(value: unknown): value is MutationLedgerEntryV1 {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MutationLedgerEntryV1>;
  if (isCommunityPluginBundleSettlementEntry(value)) return true;
  return isMutationIntent(entry.intent)
    && (entry.receipt === null || isMutationReceipt(entry.receipt, entry.intent.operationId))
    && (entry.manualResolution === undefined
      || isManualMutationResolution(entry.manualResolution, entry.intent, entry.receipt));
}

function isCommunityPluginBundleSettlementEntry(
  value: unknown,
): value is MutationLedgerEntryV1 & {
  intent: MutationIntentV1;
  receipt: null;
  manualResolution: CommunityPluginBundleSettlementV2;
} {
  if (!isRecord(value)) return false;
  const intent = value.intent;
  const settlement = value.manualResolution;
  const predecessorOperationIds = isRecord(settlement)
    ? settlement.predecessorOperationIds
    : undefined;
  const conflictDecisions = isRecord(settlement)
    ? settlement.conflictDecisions
    : undefined;
  const members = isRecord(settlement) ? settlement.members : undefined;
  if (
    value.receipt !== null
    || !isRecord(intent)
    || !isRecord(settlement)
    || settlement.version !== 2
    || settlement.kind !== "community-plugin-bundle-settlement"
    || (settlement.choice !== "keep-local" && settlement.choice !== "keep-remote")
    || settlement.externalMutation !== true
    || settlement.receipt !== null
    || typeof settlement.factsDigest !== "string"
    || !/^[0-9a-f]{64}$/i.test(settlement.factsDigest)
    || typeof settlement.selectedAt !== "number"
    || !Number.isFinite(settlement.selectedAt)
    || typeof settlement.pluginId !== "string"
    || settlement.pluginId.length === 0
    || settlement.pluginId === "easy-sync"
    || settlement.pluginId.includes("/")
    || settlement.pluginId.includes("\\")
    || typeof settlement.pluginRoot !== "string"
    || !isVaultRelativeMutationPath(settlement.pluginRoot)
    || !settlement.pluginRoot.endsWith(`/plugins/${settlement.pluginId}`)
    || JSON.stringify(settlement.intent) !== JSON.stringify(intent)
    || !isMutationIntent(intent, true)
    || intent.version !== 1
    || intent.action !== (settlement.choice === "keep-local" ? "upload" : "download")
    || intent.stateEffect !== "settlement-only"
    || intent.path !== settlement.pluginRoot
    || intent.sourcePath !== undefined
    || intent.target !== undefined
    || intent.expectedLocal.exists
    || intent.expectedRemote.exists
    || !Array.isArray(predecessorOperationIds)
    || !Array.isArray(conflictDecisions)
    || !Array.isArray(members)
  ) return false;
  const predecessors = predecessorOperationIds as string[];
  if (
    new Set(predecessors).size !== predecessors.length
    || predecessors.some((operationId) =>
      typeof operationId !== "string" || operationId.length === 0)
    || [...predecessors].sort((left, right) => left.localeCompare(right))
      .some((operationId, index) => operationId !== predecessors[index])
  ) return false;
  const allowedPaths = new Set([
    `${settlement.pluginRoot}/main.js`,
    `${settlement.pluginRoot}/manifest.json`,
    `${settlement.pluginRoot}/styles.css`,
  ]);
  const memberPaths = new Set<string>();
  const memberOperationIds = new Set<string>([intent.operationId]);
  const memberIntents: MutationIntent[] = [];
  const memberRecords = members as Array<Record<string, unknown>>;
  for (const member of memberRecords) {
    if (!isRecord(member) || !isMutationIntent(member.intent, true)) return false;
    const memberIntent = member.intent;
    memberIntents.push(memberIntent);
    if (
      memberIntent.version !== 1
      || memberIntent.stateEffect !== "bundle-settlement"
      || memberIntent.sourcePath !== undefined
      || !sameSyncScope(memberIntent.scope, intent.scope)
      || memberIntent.planRevision !== intent.planRevision
      || !allowedPaths.has(memberIntent.path)
      || memberPaths.has(memberIntent.path)
      || memberOperationIds.has(memberIntent.operationId)
      || (member.receipt !== null
        && !isMutationReceipt(member.receipt, memberIntent.operationId))
    ) return false;
    const validAction = settlement.choice === "keep-local"
      ? memberIntent.expectedLocal.exists
        ? memberIntent.action === "upload"
          && memberIntent.target === undefined
        : memberIntent.action === "deleteRemote"
          && memberIntent.expectedRemote.exists
          && memberIntent.target === undefined
      : memberIntent.expectedRemote.exists
        ? memberIntent.action === "download"
          && typeof memberIntent.expectedRemote.sha256Hash === "string"
          && memberIntent.target === undefined
        : memberIntent.action === "deleteLocal"
          && memberIntent.expectedLocal.exists
          && memberIntent.target === undefined;
    if (!validAction) return false;
    memberPaths.add(memberIntent.path);
    memberOperationIds.add(memberIntent.operationId);
  }
  if (
    !memberPaths.has(`${settlement.pluginRoot}/main.js`)
    || !memberPaths.has(`${settlement.pluginRoot}/manifest.json`)
    || [...memberPaths].sort((left, right) => left.localeCompare(right))
      .some((path, index) => path !== memberIntents[index]?.path)
  ) return false;
  const conflictPaths = new Set<string>();
  const conflictRecords = conflictDecisions as Array<Record<string, unknown>>;
  for (const conflict of conflictRecords) {
    const decisionToken: unknown = conflict.decisionToken;
    if (
      !isRecord(conflict)
      || typeof conflict.path !== "string"
      || !memberPaths.has(conflict.path)
      || conflictPaths.has(conflict.path)
      || !isSyncDecisionToken(decisionToken)
      || !sameSyncScope(decisionToken.scope, intent.scope)
    ) return false;
    const memberIntentMatchesPath = memberIntents.find(
      (candidateIntent) => candidateIntent.path === conflict.path,
    )!;
    const localMatches = JSON.stringify(decisionToken.local)
      === JSON.stringify(memberIntentMatchesPath.expectedLocal);
    const remoteToken = decisionToken.remote as {
      exists?: unknown;
      driveId?: unknown;
      eTag?: unknown;
    };
    const remoteMatches = memberIntentMatchesPath.expectedRemote.exists
      ? remoteToken.exists === true
        && remoteToken.driveId
          === memberIntentMatchesPath.expectedRemote.driveId
        && remoteToken.eTag
          === memberIntentMatchesPath.expectedRemote.eTag
      : remoteToken.exists === false;
    if (!localMatches || !remoteMatches) return false;
    conflictPaths.add(conflict.path);
  }
  return [...conflictPaths].sort((left, right) => left.localeCompare(right))
    .every((path, index) =>
      path === conflictRecords[index]?.path);
}

function isSyncDecisionToken(value: unknown): value is SyncDecisionToken {
  if (!isRecord(value) || !isRecord(value.local) || !isRecord(value.remote)) {
    return false;
  }
  const local = value.local;
  const remote = value.remote;
  return value.version === 1
    && typeof value.vaultName === "string"
    && typeof value.accountId === "string"
    && isSyncScope(value.scope)
    && (value.ancestorHash === null || typeof value.ancestorHash === "string")
    && (local.exists === false || (
      local.exists === true
      && typeof local.hash === "string"
      && typeof local.size === "number"
      && Number.isFinite(local.size)
    ))
    && (remote.exists === false || (
      remote.exists === true
      && typeof remote.driveId === "string"
      && remote.driveId.length > 0
      && typeof remote.eTag === "string"
      && remote.eTag.length > 0
    ));
}

function isManualMutationResolution(
  value: unknown,
  sourceIntent?: MutationIntent,
  sourceReceipt?: MutationReceiptV1 | null,
): value is ManualMutationResolutionV1 {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1
    || (value.choice !== "keep-local" && value.choice !== "keep-remote")
    || typeof value.factsDigest !== "string"
    || !/^[0-9a-f]{64}$/i.test(value.factsDigest)
    || typeof value.selectedAt !== "number"
    || !Number.isFinite(value.selectedAt)
    || typeof value.externalMutation !== "boolean"
    || !isMutationIntent(value.intent, true)
    || value.intent.version !== 1
    || (value.intent.stateEffect !== undefined
      && value.intent.stateEffect !== "settlement-only")
    || !(value.intent.action === "upload"
      || value.intent.action === "download"
      || value.intent.action === "deleteRemote"
      || value.intent.action === "renameRemote"
      || value.intent.action === "moveLocal"
      || value.intent.action === "deleteLocal")
  ) return false;
  if (
    value.receipt !== null
    && !isMutationReceipt(value.receipt, value.intent.operationId)
  ) return false;
  if (
    value.recoveryEvidence !== undefined
    && !isReceiptedRenameAnchorCollisionEvidence(value.recoveryEvidence)
  ) return false;
  if (!value.externalMutation && value.receipt === null) return false;
  const hasSourcePath = typeof value.intent.sourcePath === "string";
  const settlementOnly = value.intent.stateEffect === "settlement-only";
  const isCollisionRecovery = Boolean(
    value.recoveryEvidence
    && value.externalMutation
    && value.choice === "keep-local"
    && hasSourcePath
    && value.intent.action === "upload"
    && value.intent.expectedLocal.exists
    && !value.intent.expectedRemote.exists,
  );
  const semanticActionMatches = !value.externalMutation
    ? (
        (value.intent.action === "upload"
          && value.intent.expectedLocal.exists
          && value.intent.expectedRemote.exists
          && (!hasSourcePath || value.intent.sourcePath !== value.intent.path))
        || (value.intent.action === "deleteLocal"
          && !hasSourcePath
          && !value.intent.expectedLocal.exists
          && !value.intent.expectedRemote.exists)
      )
    : hasSourcePath
      ? isCollisionRecovery || (
        value.recoveryEvidence === undefined
          && value.intent.expectedLocal.exists
          && value.intent.expectedRemote.exists
          && (
            (value.choice === "keep-local" && value.intent.action === "renameRemote")
            || (value.choice === "keep-remote" && value.intent.action === "moveLocal")
          )
      )
      : value.choice === "keep-local"
        ? value.intent.expectedLocal.exists
          ? value.intent.action === "upload"
          : value.intent.expectedRemote.exists
            && value.intent.action === "deleteRemote"
        : value.intent.expectedRemote.exists
          ? value.intent.action === "download"
          : value.intent.expectedLocal.exists
            && value.intent.action === "deleteLocal";
  if (!semanticActionMatches) return false;
  if (value.recoveryEvidence !== undefined && !isCollisionRecovery) return false;
  if (settlementOnly && (
    !sourceIntent
    || sourceIntent.version !== 1
    || sourceIntent.action !== "download"
    || sourceIntent.sourcePath !== undefined
    || sourceIntent.stateEffect !== undefined
    || !sourceIntent.expectedRemote.exists
  )) return false;
  if (!sourceIntent) return true;
  if (
    sourceIntent.version !== 1
    || sourceIntent.operationId === value.intent.operationId
    || !sameSyncScope(sourceIntent.scope, value.intent.scope)
  ) return false;
  const sourcePaths = [...new Set([
    sourceIntent.path,
    sourceIntent.sourcePath,
  ].filter((path): path is string => Boolean(path)))].sort();
  const resolutionPaths = [...new Set([
    value.intent.path,
    value.intent.sourcePath,
  ].filter((path): path is string => Boolean(path)))].sort();
  if (JSON.stringify(sourcePaths) !== JSON.stringify(resolutionPaths)) return false;
  if (!isCollisionRecovery) return true;
  if (
    sourceIntent.action !== "renameRemote"
    || !sourceIntent.sourcePath
    || !sourceIntent.expectedLocal.exists
    || !sourceIntent.expectedRemote.exists
    || !sourceReceipt
  ) return false;
  const checkpoint = sourceReceipt.checkpoint;
  return sourceReceipt.operationId === sourceIntent.operationId
    && checkpoint.baseUpserts.length === 1
    && checkpoint.baseUpserts[0]?.path === sourceIntent.path
    && checkpoint.baseRemovals.length === 1
    && checkpoint.baseRemovals[0] === sourceIntent.sourcePath
    && checkpoint.remoteUpserts.length === 1
    && checkpoint.remoteUpserts[0]?.path === sourceIntent.path
    && checkpoint.remoteUpserts[0]?.driveId === sourceIntent.expectedRemote.driveId
    && checkpoint.remoteDeletes.length === 1
    && checkpoint.remoteDeletes[0] === sourceIntent.sourcePath;
}

function isReceiptedRenameAnchorCollisionEvidence(
  value: unknown,
): value is ReceiptedRenameAnchorCollisionEvidenceV1 {
  if (!isRecord(value)) return false;
  const staleRemoteIds = value.staleRemoteIds as string[];
  return value.kind === "receipted-rename-target-anchor-collision"
    && Number.isSafeInteger(value.lifecycleEpoch)
    && (value.lifecycleEpoch as number) >= 0
    && Number.isSafeInteger(value.sourceCommitSeq)
    && (value.sourceCommitSeq as number) >= 1
    && typeof value.sourceAnchorId === "string"
    && value.sourceAnchorId.length > 0
    && typeof value.targetAnchorId === "string"
    && value.targetAnchorId.length > 0
    && value.sourceAnchorId !== value.targetAnchorId
    && Array.isArray(staleRemoteIds)
    && staleRemoteIds.length > 0
    && staleRemoteIds.every((remoteId) =>
      typeof remoteId === "string" && remoteId.length > 0)
    && new Set(staleRemoteIds).size === staleRemoteIds.length
    && [...staleRemoteIds].sort().every(
      (remoteId, index) => remoteId === staleRemoteIds[index],
    );
}

function isManualMutationResolutionAudit(
  value: unknown,
): value is ManualMutationResolutionAuditV1 {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.sourceOperationId === "string"
    && value.sourceOperationId.length > 0
    && typeof value.resolutionOperationId === "string"
    && value.resolutionOperationId.length > 0
    && isVaultRelativeMutationPath(value.path)
    && (value.choice === "keep-local" || value.choice === "keep-remote")
    && (value.action === "upload"
      || value.action === "download"
      || value.action === "deleteRemote"
      || value.action === "renameRemote"
      || value.action === "moveLocal"
      || value.action === "deleteLocal")
    && typeof value.externalMutation === "boolean"
    && typeof value.selectedAt === "number"
    && Number.isFinite(value.selectedAt)
    && typeof value.completedAt === "number"
    && Number.isFinite(value.completedAt);
}

function isMutationIntent(
  value: unknown,
  allowSettlementOnly = false,
): value is MutationIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<MutationIntent>;
  if (
    intent.version === 2
    && (intent.action === "createLocalFolder"
      || intent.action === "createRemoteFolder"
      || intent.action === "moveLocalFolder"
      || intent.action === "moveRemoteFolder"
      || intent.action === "deleteLocalFolder"
      || intent.action === "deleteRemoteFolder")
  ) {
    const folderIntent = value as Partial<Extract<MutationIntent, { version: 2 }>>;
    const isMove = folderIntent.action === "moveLocalFolder"
      || folderIntent.action === "moveRemoteFolder";
    const needsIdentity = folderIntent.action !== "createRemoteFolder";
    return typeof folderIntent.operationId === "string"
      && Number.isSafeInteger(folderIntent.planRevision)
      && isSyncScope(folderIntent.scope)
      && isVaultRelativeMutationPath(folderIntent.path)
      && (!isMove || isVaultRelativeMutationPath(folderIntent.sourcePath))
      && (!needsIdentity || typeof folderIntent.folderId === "string")
      && isFolderLocalExpectation(folderIntent.expectedLocal)
      && (folderIntent.expectedSourceLocal === undefined
        || isFolderLocalExpectation(folderIntent.expectedSourceLocal))
      && isFolderRemoteExpectation(folderIntent.expectedRemote)
      && isFolderParentExpectation(folderIntent.expectedParent)
      && (folderIntent.reviewedSubtreeDelete === undefined
        || (folderIntent.action === "deleteRemoteFolder"
          && isReviewedFolderSubtreeDeleteBinding(
            folderIntent.reviewedSubtreeDelete,
          )))
      && (folderIntent.reviewedLocationMove === undefined
        || ((folderIntent.action === "moveLocalFolder"
          || folderIntent.action === "moveRemoteFolder")
          && folderIntent.reviewedSubtreeDelete === undefined
          && isReviewedFolderLocationMoveBinding(
            folderIntent.reviewedLocationMove,
          )))
      && typeof folderIntent.createdAt === "number";
  }
  const fileIntent = value as Partial<MutationIntentV1>;
  const localOnlyDownload = fileIntent.stateEffect === "local-only";
  const settlementOnly = fileIntent.stateEffect === "settlement-only";
  const bundleSettlement = fileIntent.stateEffect === "bundle-settlement";
  return fileIntent.version === 1
    && typeof fileIntent.operationId === "string"
    && Number.isSafeInteger(fileIntent.planRevision)
    && isSyncScope(fileIntent.scope)
    && (fileIntent.action === "upload"
      || fileIntent.action === "download"
      || fileIntent.action === "deleteRemote"
      || fileIntent.action === "renameRemote"
      || fileIntent.action === "moveLocal"
      || fileIntent.action === "deleteLocal"
      || fileIntent.action === "merge")
    && typeof fileIntent.path === "string"
    && (fileIntent.sourcePath === undefined || typeof fileIntent.sourcePath === "string")
    && (fileIntent.stateEffect === undefined
      || localOnlyDownload
      || (allowSettlementOnly && (settlementOnly || bundleSettlement)))
    && isMutationLocalExpectation(fileIntent.expectedLocal)
    && isMutationRemoteExpectation(fileIntent.expectedRemote)
    && (fileIntent.target === undefined || isMutationVersion(fileIntent.target))
    && ((fileIntent.action !== "renameRemote" && fileIntent.action !== "moveLocal")
      || isVaultRelativeMutationPath(fileIntent.sourcePath))
    && (!localOnlyDownload || (
      fileIntent.action === "download"
      && isVaultRelativeMutationPath(fileIntent.sourcePath)
      && fileIntent.expectedLocal?.exists === false
      && isExistingMutationRemoteExpectation(fileIntent.expectedRemote)
      && isMutationVersion({
        hash: fileIntent.expectedRemote.sha256Hash,
        size: fileIntent.expectedRemote.size,
      })
    ))
    && (!settlementOnly || (
      (fileIntent.action === "upload"
        || fileIntent.action === "download"
        || fileIntent.action === "deleteRemote"
        || fileIntent.action === "deleteLocal")
      && fileIntent.sourcePath === undefined
      && fileIntent.target === undefined
    ))
    && (!bundleSettlement || (
      (fileIntent.action === "upload"
        || fileIntent.action === "download"
        || fileIntent.action === "deleteRemote"
        || fileIntent.action === "deleteLocal")
      && fileIntent.sourcePath === undefined
      && fileIntent.target === undefined
    ))
    && (fileIntent.action !== "merge"
      || (isExistingMutationLocalExpectation(fileIntent.expectedLocal)
        && isExistingMutationRemoteExpectation(fileIntent.expectedRemote)
        && isMutationVersion(fileIntent.target)))
    && typeof fileIntent.createdAt === "number";
}

function isFolderLocalExpectation(value: unknown): boolean {
  return Boolean(value && typeof value === "object"
    && typeof (value as { exists?: unknown }).exists === "boolean");
}

function isFolderRemoteExpectation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const expected = value as {
    exists?: unknown;
    driveId?: unknown;
    parentId?: unknown;
    eTag?: unknown;
  };
  return expected.exists === false
    || (expected.exists === true
      && typeof expected.driveId === "string"
      && typeof expected.parentId === "string"
      && (expected.eTag === undefined || typeof expected.eTag === "string"));
}

function isFolderParentExpectation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const expected = value as {
    driveId?: unknown;
    path?: unknown;
    eTag?: unknown;
  };
  return typeof expected.driveId === "string"
    && typeof expected.path === "string"
    && (expected.eTag === undefined || typeof expected.eTag === "string");
}

function isReviewedFolderSubtreeDeleteBinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const binding = value as {
    version?: unknown;
    sourceCommitSeq?: unknown;
    sourceLifecycleEpoch?: unknown;
    rootCTag?: unknown;
    memberCount?: unknown;
  };
  return binding.version === 1
    && Number.isSafeInteger(binding.sourceCommitSeq)
    && (binding.sourceCommitSeq as number) >= 0
    && Number.isSafeInteger(binding.sourceLifecycleEpoch)
    && (binding.sourceLifecycleEpoch as number) >= 0
    && typeof binding.rootCTag === "string"
    && binding.rootCTag.length > 0
    && binding.rootCTag.length <= 512
    && Number.isSafeInteger(binding.memberCount)
    && (binding.memberCount as number) > 1;
}

function isReviewedFolderLocationMoveBinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const binding = value as {
    version?: unknown;
    sourceCommitSeq?: unknown;
    sourceLifecycleEpoch?: unknown;
    sourceAnchorPath?: unknown;
  };
  return binding.version === 1
    && Number.isSafeInteger(binding.sourceCommitSeq)
    && (binding.sourceCommitSeq as number) >= 0
    && Number.isSafeInteger(binding.sourceLifecycleEpoch)
    && (binding.sourceLifecycleEpoch as number) >= 0
    && isVaultRelativeMutationPath(binding.sourceAnchorPath);
}

function isVaultRelativeMutationPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) =>
      Boolean(segment) && segment !== "." && segment !== "..");
}

function isExistingMutationLocalExpectation(
  value: unknown,
): value is Extract<MutationIntentV1["expectedLocal"], { exists: true }> {
  return Boolean(value && typeof value === "object" && (value as { exists?: unknown }).exists === true);
}

function isExistingMutationRemoteExpectation(
  value: unknown,
): value is Extract<MutationIntentV1["expectedRemote"], { exists: true }> {
  return Boolean(value && typeof value === "object" && (value as { exists?: unknown }).exists === true);
}

function isMutationVersion(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const version = value as { hash?: unknown; size?: unknown };
  return typeof version.hash === "string"
    && /^[0-9a-f]{64}$/i.test(version.hash)
    && Number.isSafeInteger(version.size)
    && (version.size as number) >= 0;
}

function isMutationLocalExpectation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const expected = value as { exists?: unknown; hash?: unknown; size?: unknown };
  return expected.exists === false
    || (expected.exists === true
      && typeof expected.hash === "string"
      && typeof expected.size === "number");
}

function isMutationRemoteExpectation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const expected = value as {
    exists?: unknown;
    driveId?: unknown;
    eTag?: unknown;
    size?: unknown;
    sha256Hash?: unknown;
  };
  return expected.exists === false
    || (expected.exists === true
      && typeof expected.driveId === "string"
      && typeof expected.eTag === "string"
      && typeof expected.size === "number"
      && (expected.sha256Hash === undefined || typeof expected.sha256Hash === "string"));
}

function isMutationReceipt(value: unknown, operationId: string): value is MutationReceiptV1 {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<MutationReceiptV1>;
  if (
    receipt.version !== 1
    || receipt.operationId !== operationId
    || typeof receipt.completedAt !== "number"
    || !receipt.checkpoint
    || typeof receipt.checkpoint !== "object"
  ) return false;
  const checkpoint = receipt.checkpoint;
  return Array.isArray(checkpoint.baseUpserts)
    && checkpoint.baseUpserts.every(isBaseEntry)
    && Array.isArray(checkpoint.baseRemovals)
    && checkpoint.baseRemovals.every((path) => typeof path === "string")
    && Array.isArray(checkpoint.remoteUpserts)
    && checkpoint.remoteUpserts.every(isRemoteEntry)
    && Array.isArray(checkpoint.remoteDeletes)
    && checkpoint.remoteDeletes.every((path) => typeof path === "string")
    && Array.isArray(checkpoint.pendingConflictRemovals)
    && checkpoint.pendingConflictRemovals.every((path) => typeof path === "string")
    && Array.isArray(checkpoint.pendingDeleteRemovals)
    && checkpoint.pendingDeleteRemovals.every((path) => typeof path === "string")
    && (checkpoint.folderUpserts === undefined
      || (Array.isArray(checkpoint.folderUpserts)
        && checkpoint.folderUpserts.every(isRemoteFolderEntry)))
    && (checkpoint.folderDeletes === undefined
      || (Array.isArray(checkpoint.folderDeletes)
        && checkpoint.folderDeletes.every((entry) =>
          Boolean(entry && typeof entry === "object")
          && isVaultRelativeMutationPath((entry as { path?: unknown }).path)
          && typeof (entry as { driveId?: unknown }).driveId === "string")))
    && (checkpoint.folderMoveHintRemovals === undefined
      || (Array.isArray(checkpoint.folderMoveHintRemovals)
        && checkpoint.folderMoveHintRemovals.every(
          (driveId) => typeof driveId === "string",
        )));
}

function isBaseEntry(value: unknown): value is BaseFileEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BaseFileEntry>;
  return typeof entry.path === "string"
    && typeof entry.hash === "string"
    && typeof entry.size === "number"
    && typeof entry.eTag === "string";
}

function isRemoteEntry(value: unknown): value is RemoteFileEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteFileEntry>;
  return typeof entry.path === "string"
    && typeof entry.driveId === "string"
    && (entry.parentId === undefined || typeof entry.parentId === "string")
    && typeof entry.size === "number"
    && typeof entry.mtime === "number"
    && typeof entry.eTag === "string"
    && typeof entry.cTag === "string"
    && (entry.sha256Hash === undefined || typeof entry.sha256Hash === "string")
    && (entry.quickXorHash === undefined || typeof entry.quickXorHash === "string");
}

function assertRemoteUpsertsHaveParentIdentity(entries: RemoteFileEntry[]): void {
  const incomplete = entries.find((entry) => !entry.parentId);
  if (incomplete) {
    throw new Error(`Remote cache upsert is missing parent identity: ${incomplete.path}`);
  }
}

function isRemoteFolderEntry(value: unknown): value is RemoteFolderEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RemoteFolderEntry>;
  return typeof entry.path === "string"
    && typeof entry.driveId === "string"
    && typeof entry.parentId === "string"
    && typeof entry.name === "string"
    && (entry.eTag === undefined || typeof entry.eTag === "string")
    && (entry.cTag === undefined || typeof entry.cTag === "string");
}

function readSyncScopeExpansionMarkerV1(
  value: unknown,
): SyncScopeExpansionMarkerV1 | null {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.kind !== "sync-scope-expansion"
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1
    || typeof value.previousSettingsFingerprint !== "string"
    || typeof value.targetSettingsFingerprint !== "string"
    || value.targetSettingsFingerprint.length === 0
    || !isRecord(value.source)
    || !isSyncScope(value.source.scope)
    || !Number.isSafeInteger(value.source.commitSeq)
    || Number(value.source.commitSeq) < 1
    || !Number.isSafeInteger(value.source.lifecycleEpoch)
    || Number(value.source.lifecycleEpoch) < 1
    || typeof value.source.anchorFingerprint !== "string"
    || value.source.anchorFingerprint.length === 0
    || !Array.isArray(value.folders)
    || !value.folders.every(isRemoteFolderEntry)
    || (
      value.requiresCompleteRemoteIdentitySnapshot !== undefined
      && typeof value.requiresCompleteRemoteIdentitySnapshot !== "boolean"
    )
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)
  ) return null;
  const folderScopeTransition = value.folderScopeTransition === undefined
    ? undefined
    : isRecord(value.folderScopeTransition)
      ? {
          previous: readFolderSyncScopeSnapshotV1(
            value.folderScopeTransition.previous,
          ),
          target: readFolderSyncScopeSnapshotV1(
            value.folderScopeTransition.target,
          ),
        }
      : null;
  if (
    folderScopeTransition === null
    || folderScopeTransition?.previous === null
    || folderScopeTransition?.target === null
  ) return null;
  const validatedFolderScopeTransition = folderScopeTransition
    ? {
        previous: folderScopeTransition.previous,
        target: folderScopeTransition.target,
      }
    : undefined;
  const requiresCompleteRemoteIdentitySnapshot =
    value.requiresCompleteRemoteIdentitySnapshot === true;
  if (
    value.folders.length === 0
    && !requiresCompleteRemoteIdentitySnapshot
  ) return null;
  const folders = value.folders.map((folder) => ({ ...folder }));
  if (
    new Set(folders.map((folder) => folder.path)).size !== folders.length
    || new Set(folders.map((folder) => folder.driveId)).size !== folders.length
  ) return null;
  return {
    version: 1,
    kind: "sync-scope-expansion",
    revision: Number(value.revision),
    previousSettingsFingerprint: value.previousSettingsFingerprint,
    targetSettingsFingerprint: value.targetSettingsFingerprint,
    source: {
      scope: { ...value.source.scope },
      commitSeq: Number(value.source.commitSeq),
      lifecycleEpoch: Number(value.source.lifecycleEpoch),
      anchorFingerprint: value.source.anchorFingerprint,
    },
    folders: folders.sort(compareRemoteFolderPath),
    ...(validatedFolderScopeTransition
      ? {
          folderScopeTransition: validatedFolderScopeTransition,
        }
      : {}),
    requiresCompleteRemoteIdentitySnapshot,
    createdAt: value.createdAt,
  };
}

async function syncScopeExpansionAnchorFingerprint(
  envelope: Readonly<SyncStateEnvelopeV2>,
  omitExactRemoteIds: ReadonlySet<string> = new Set(),
): Promise<string> {
  const serialized = JSON.stringify({
    files: Object.values(envelope.anchors.byAnchorId)
      .sort((left, right) => left.anchorId.localeCompare(right.anchorId)),
    folders: Object.values(envelope.folderAnchors?.byAnchorId ?? {})
      .filter((anchor) => !omitExactRemoteIds.has(anchor.remoteId))
      .sort((left, right) => left.anchorId.localeCompare(right.anchorId)),
  });
  return sha256Hex(new TextEncoder().encode(serialized).buffer);
}

function materializeSyncScopeExpansionFolders(
  marker: Readonly<SyncScopeExpansionMarkerV1>,
  envelope: Readonly<SyncStateEnvelopeV2>,
): RemoteFolderEntry[] {
  const transition = marker.folderScopeTransition;
  const foldersByRemoteId = new Map<string, RemoteFolderEntry>();
  for (const folder of marker.folders) {
    if (
      transition
      && !isFolderPathInSyncScopeSnapshot(transition.target, folder.path)
    ) continue;
    foldersByRemoteId.set(folder.driveId, { ...folder });
  }
  if (transition) {
    for (const folder of projectStatePathViewV2(envelope).remoteFolders) {
      if (
        isFolderPathInSyncScopeSnapshot(transition.previous, folder.path)
        || !isFolderPathInSyncScopeSnapshot(transition.target, folder.path)
      ) continue;
      foldersByRemoteId.set(folder.driveId, { ...folder });
    }
  }
  return [...foldersByRemoteId.values()].sort(compareRemoteFolderPath);
}

function materializeSourceBoundScopeExpansionFolders(
  marker: Readonly<SyncScopeExpansionMarkerV1>,
  envelope: Readonly<SyncStateEnvelopeV2>,
  authorizedFolders: readonly Readonly<RemoteFolderEntry>[],
  localFolders: readonly Readonly<LocalFolderEntry>[],
  joinRoots: readonly Readonly<{ path: string; remoteId: string }>[],
): RemoteFolderEntry[] | null {
  if (joinRoots.length === 0) {
    return authorizedFolders.map((folder) => ({ ...folder }));
  }
  const localPaths = new Set(localFolders.map((folder) => folder.path));
  const remoteFolders = projectStatePathViewV2(envelope).remoteFolders;
  const remoteFoldersById = new Map(
    remoteFolders.map((folder) => [folder.driveId, folder]),
  );
  const acceptanceById = new Map(
    authorizedFolders.map((folder) => [folder.driveId, { ...folder }]),
  );
  for (const root of joinRoots) {
    const remoteRoot = remoteFoldersById.get(root.remoteId);
    const rootWasAuthorized = authorizedFolders.some((folder) =>
      folder.driveId === root.remoteId && folder.path === root.path
    );
    if (
      !remoteRoot
      || remoteRoot.path !== root.path
      || !rootWasAuthorized
      || (
        marker.folderScopeTransition
        && !isFolderPathInSyncScopeSnapshot(
          marker.folderScopeTransition.target,
          remoteRoot.path,
        )
      )
    ) return null;
    // A reviewed remote-only plugin join authorizes the bundle download, not
    // a premature local identity for its still-absent root. It does prove the
    // exact ancestor chain used by those bundle members. Accept only parents
    // that are already present locally and remain inside the target scope;
    // the root is anchored later from the committed descendant files.
    if (!localPaths.has(root.path)) acceptanceById.delete(root.remoteId);
    let parentId = remoteRoot.parentId;
    while (parentId !== envelope.scope.filesRootId) {
      const parent = remoteFoldersById.get(parentId);
      if (
        !parent
        || !localPaths.has(parent.path)
        || (
          marker.folderScopeTransition
          && !isFolderPathInSyncScopeSnapshot(
            marker.folderScopeTransition.target,
            parent.path,
          )
        )
      ) return null;
      acceptanceById.set(parent.driveId, { ...parent });
      parentId = parent.parentId;
    }
  }
  return [...acceptanceById.values()].sort(compareRemoteFolderPath);
}

function composeSyncScopeExpansionMarker(input: Readonly<{
  existing: SyncScopeExpansionMarkerV1 | null;
  next: SyncScopeExpansionMarkerV1 | null;
  source: SyncScopeExpansionMarkerV1["source"] | null;
  scopeChange: Readonly<SyncPathSettingsScopeChangeV1>;
  currentRevision: number;
  currentSettingsFingerprint: string;
  nextRevision: number;
}>): SyncScopeExpansionMarkerV1 | null {
  const existing = input.existing;
  if (!existing) return input.next;
  const source = input.source;
  const continuous = Boolean(
    source
    && existing.revision === input.currentRevision
    && existing.targetSettingsFingerprint
      === input.scopeChange.previousSettingsFingerprint
    && input.currentSettingsFingerprint
      === input.scopeChange.previousSettingsFingerprint
    && sameSyncScope(existing.source.scope, source.scope)
    // Device-local participation may advance the V2 envelope between two
    // settings changes without changing any file/folder identity. The anchor
    // fingerprint below is the strict continuity proof; only reject a source
    // that moved backwards or changed that identity set.
    && existing.source.commitSeq <= source.commitSeq
    && existing.source.lifecycleEpoch === source.lifecycleEpoch
    && existing.source.anchorFingerprint === source.anchorFingerprint,
  );
  if (!continuous || !source) return input.next;

  const folderScopeTransition = existing.folderScopeTransition
    && input.scopeChange.folderScopeTransition
    ? {
        previous: structuredClone(existing.folderScopeTransition.previous),
        target: structuredClone(input.scopeChange.folderScopeTransition.target),
      }
    : input.next?.folderScopeTransition
      ? structuredClone(input.next.folderScopeTransition)
      : existing.folderScopeTransition
        ? structuredClone(existing.folderScopeTransition)
        : undefined;
  const includedFolderPaths = input.scopeChange.includedFolderPaths
    ? new Set(input.scopeChange.includedFolderPaths)
    : null;
  const foldersByRemoteId = new Map<string, RemoteFolderEntry>();
  for (const folder of [...existing.folders, ...(input.next?.folders ?? [])]) {
    if (
      folderScopeTransition
        ? !isFolderPathInSyncScopeSnapshot(
            folderScopeTransition.target,
            folder.path,
          )
        : includedFolderPaths && !includedFolderPaths.has(folder.path)
    ) continue;
    foldersByRemoteId.set(folder.driveId, { ...folder });
  }
  const folders = [...foldersByRemoteId.values()].sort(compareRemoteFolderPath);
  const requiresCompleteRemoteIdentitySnapshot =
    existing.requiresCompleteRemoteIdentitySnapshot
    || input.next?.requiresCompleteRemoteIdentitySnapshot === true;
  if (folders.length === 0 && !requiresCompleteRemoteIdentitySnapshot) {
    return null;
  }
  return {
    version: 1,
    kind: "sync-scope-expansion",
    revision: input.nextRevision,
    previousSettingsFingerprint: existing.previousSettingsFingerprint,
    targetSettingsFingerprint: input.scopeChange.targetSettingsFingerprint,
    source,
    folders,
    ...(folderScopeTransition ? { folderScopeTransition } : {}),
    requiresCompleteRemoteIdentitySnapshot,
    createdAt: Math.min(existing.createdAt, input.next?.createdAt ?? Infinity),
  };
}

function compareRemoteFolderPath(
  left: Readonly<RemoteFolderEntry>,
  right: Readonly<RemoteFolderEntry>,
): number {
  const leftDepth = left.path.split("/").length;
  const rightDepth = right.path.split("/").length;
  return leftDepth - rightDepth
    || left.path.localeCompare(right.path)
    || left.driveId.localeCompare(right.driveId);
}

function upsertPlanItems(
  existing: SyncPlanItem[],
  incoming: SyncPlanItem[],
): SyncPlanItem[] {
  const byPath = new Map(existing.map((item) => [item.path, item]));
  for (const item of incoming) {
    byPath.set(item.path, item);
  }
  return [...byPath.values()];
}

function clearPlanReviewData(current: PluginData): PluginData {
  return {
    ...current,
    [KEY_PLAN_REVIEW_ACTIVE]: false,
    [KEY_PLAN_REVIEW_COUNTS]: null,
    [KEY_PLAN_REVIEW_ITEMS]: [],
    [KEY_PLAN_REVIEW_DIGEST]: "",
    [KEY_PLAN_REVIEW_SCOPE]: null,
    [KEY_PLAN_REVIEW_CANONICAL_IDENTITY]: null,
  };
}

function samePendingIssues(left: PendingIssue[], right: PendingIssue[]): boolean {
  return left.length === right.length
    && right.every((issue, index) => {
      const current = left[index];
      return current?.path === issue.path
        && current.actionType === issue.actionType
        && current.issueCode === issue.issueCode
        && current.reason === issue.reason
        && current.updatedAt === issue.updatedAt;
    });
}
