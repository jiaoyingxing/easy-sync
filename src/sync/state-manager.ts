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
  getPluginDir,
  isRecord,
  isStringRecord,
} from "../obsidian-compat";
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
import { reduceFileStateEnvelopeV2 } from "./file-state-reducer-v2";
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
  StateEnvelopeV2LoadError,
  StateEnvelopeV2Store,
  type RemoteScopeRecoveryV2,
  type FolderAnchorV2,
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
import type { SharedSyncProtocolBinding } from "./sync-protocol-v3";
import {
  remoteScopeRecoveryProtocolBindingDigest,
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

/** M14: minimal plugin-data store contract — EasySyncPlugin satisfies this. */
export interface PluginDataStore {
  loadData(): Promise<Record<string, unknown> | null>;
  updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void>;
  app: { vault: { adapter: DataAdapter; configDir: string } };
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
  type ManualMutationResolutionAuditV1,
  type MutationRecoveryHistory,
  type SyncAttention,
  type LocalFolderMoveHintV1,
  type V2ActivationReviewKind,
  SyncActionType,
  planDigest,
  sameCanonicalPlanIdentityV2,
  sameSyncScope,
} from "./types";
import { BaseContentCache, isTextFile } from "./base-content-cache";
import {
  projectCommunityPluginEnablementCarrierStateV2,
  readCommunityPluginEnablementCommittedObservationV1,
  sameCommunityPluginEnablementCarrierScopeV2,
  sameCommunityPluginEnablementCommittedObservationV1,
  sameCommunityPluginEnablementDecisionSet,
  sameCommunityPluginEnablementMigrationCarrierV2,
  sameCommunityPluginEnablementSourceV2,
  type CommunityPluginEnablementCommittedObservationV1,
  type CommunityPluginEnablementDecisionResolution,
  type CommunityPluginEnablementMigrationCarrierV2,
  type CommunityPluginEnablementSourceV2,
  type PluginEnablementAnchorsV1,
} from "./community-plugin-enablement";

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
  communityPluginEnablement?: CommunityPluginEnablementMigrationCarrierV2;
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
const REMOTE_STATE_FILE = "remote-state.json";

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
  errors: number;
  message: string;
  files: FileProgress[];
  uploadBytes?: number;
  uploadReadMs?: number;
  uploadNetworkMs?: number;
  peakUploads?: number;
  /** Aggregated status of one continuing mutation-recovery event. */
  recovery?: MutationRecoveryHistory;
  /** Stable reason for a user decision that stopped this run. */
  attention?: SyncAttention;
  /** Aggregated GET-only scope proof; not included in file action counts. */
  remoteScopeRecovery?: RemoteScopeRecoveryVerificationSummary;
}

export interface PendingIssue {
  path: string;
  actionType: SyncActionType;
  /** Stable, localization-independent route for a supported resolution UI. */
  issueCode?:
    | "anchored-folder-missing-local"
    | "anchored-folder-missing-remote"
    | "identity-replacement-ambiguous"
    | "unanchored-shared-folder";
  reason?: string;
  updatedAt: number;
  fileSize?: number;
  /** M17: content hash/etag at time of failure — used to detect version changes */
  localHash?: string;
  remoteETag?: string;
  /** M17: consecutive failures with same version. >= 3 → circuit breaker. */
  consecutiveFailures?: number;
}

export interface PendingCommunityPluginEnablementDecision {
  pluginId: string;
  localEnabled: boolean;
  remoteEnabled: boolean;
  resolvedEnabled?: boolean;
}

export interface CommunityPluginEnablementDecisionSnapshot {
  revision: string;
  decisions: PendingCommunityPluginEnablementDecision[];
}

export interface CommunityPluginEnablementStateV1 {
  version: 1;
  scope: SyncScope | null;
  anchors: PluginEnablementAnchorsV1;
  pending: PendingCommunityPluginEnablementDecision[];
  observation?: CommunityPluginEnablementCommittedObservationV1;
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
  [KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]: CommunityPluginEnablementStateV1;
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
  [KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]: createEmptyCommunityPluginEnablementState(),
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
    [KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]: createEmptyCommunityPluginEnablementState(),
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
    const saved = await this.plugin.loadData();
    if (saved) {
      const rawPublicMutationLedger = saved[KEY_PUBLIC_MUTATION_LEDGER];
      const publicMutationLedger = parseMutationLedger(
        rawPublicMutationLedger,
      );
      const rawMutationLedger = saved[KEY_MUTATION_LEDGER];
      const mutationLedger = parseMutationLedger(rawMutationLedger);
      this.mutationLedgerCorrupt = (
        rawPublicMutationLedger !== undefined
        && (
          !Array.isArray(rawPublicMutationLedger)
          || publicMutationLedger.length !== rawPublicMutationLedger.length
        )
      ) || (
        rawMutationLedger !== undefined
        && (
          !Array.isArray(rawMutationLedger)
          || mutationLedger.length !== rawMutationLedger.length
        )
      ) || (
        publicMutationLedger.length > 0
        && mutationLedger.length > 0
        && JSON.stringify(publicMutationLedger)
          !== JSON.stringify(mutationLedger)
      );
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
        [KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]: parseCommunityPluginEnablementState(
          saved[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE],
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
      await this.baseContentCache.load(adapter, this.pluginDir);
      this.remoteState = await this.loadRemoteState();
      return;
    } else {
      this.v2ScopeTransitionStore = null;
      this.migrationHoldStore = null;
      this.migrationHold = null;
    }
    this.legacyStateAllowed = true;
    await this.baseContentCache.load(adapter, this.pluginDir);
    this.remoteState = await this.loadRemoteState();
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
    const communityPluginEnablement =
      this.migrationHold?.communityPluginEnablement;
    if (
      communityPluginEnablement
      && this.migrationHold?.sourceStateDigest !== sourceStateDigest
    ) {
      return "public-1.1.3-cutover-marker-mismatch";
    }
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
          communityPluginEnablement,
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
    if (
      activeLedger.length > 0
      && JSON.stringify(publicLedger) !== JSON.stringify(activeLedger)
    ) {
      throw new Error("Public and V2 mutation ledgers disagree");
    }
    await this.commitPluginData((current) => ({
      ...current,
      [KEY_PUBLIC_MUTATION_LEDGER]: [],
      [KEY_MUTATION_LEDGER]: activeLedger.length > 0
        ? activeLedger
        : publicLedger,
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
    });
  }

  private get pluginDir(): string {
    return this.plugin.manifest.dir
      ?? getPluginDir(this.plugin.app.vault, this.plugin.manifest.id);
  }

  private async loadRemoteState(): Promise<RemoteSyncState | null> {
    try {
      const json = await this.plugin.app.vault.adapter.read(this.remoteStatePath);
      return parseRemoteState(JSON.parse(json));
    } catch {
      return null;
    }
  }

  private get remoteStatePath(): string {
    return `${this.pluginDir}/${REMOTE_STATE_FILE}`;
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
    const baseContentPath = `${this.pluginDir}/base-content.json`;
    try {
      if (await this.plugin.app.vault.adapter.exists(baseContentPath)) {
        try {
          baseContentRaw =
            await this.plugin.app.vault.adapter.read(baseContentPath);
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
      || this.data[KEY_PENDING_DELETES].length > 0
      || this.data[KEY_SYNC_HISTORY].length > 0;
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
          || JSON.stringify(legacyMutationLedger)
            !== JSON.stringify(this.mutationLedger)
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
      return activeLedger.length === 0 && publicLedger.length > 0
        ? publicLedger
        : activeLedger;
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
    if (
      record.intent.action !== "upload"
      || !record.receipt
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
      record: structuredClone(record),
    };
    await this.commitPluginData((current) => {
      const active = current[KEY_MUTATION_LEDGER].find(
        (candidate) =>
          candidate.intent.operationId === record.intent.operationId,
      );
      const existing = current[KEY_V2_RECOVERY_QUARANTINE].find(
        (candidate) => candidate.operationId === record.intent.operationId,
      );
      if (!active) {
        if (
          existing
          && JSON.stringify(existing.record) === JSON.stringify(record)
        ) return current;
        throw new Error(
          `Mutation intent missing for quarantine: ${record.intent.operationId}`,
        );
      }
      if (JSON.stringify(active) !== JSON.stringify(record)) {
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
          (candidate) =>
            candidate.intent.operationId !== record.intent.operationId,
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
      || !isManualMutationResolution(resolution, expectedRecord.intent)
      || !sameSyncScope(resolution.intent.scope, this.v2Envelope.scope)
      || resolution.intent.operationId === expectedRecord.intent.operationId
    ) {
      throw new Error("Manual mutation resolution evidence is invalid");
    }
    let attached = false;
    await this.commitPluginData((current) => {
      const index = current[KEY_MUTATION_LEDGER].findIndex(
        (entry) => entry.intent.operationId === expectedRecord.intent.operationId,
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
      const index = current[KEY_MUTATION_LEDGER].findIndex(
        (entry) => entry.intent.operationId === sourceOperationId,
      );
      if (index < 0) {
        throw new Error(`Mutation intent missing: ${sourceOperationId}`);
      }
      const active = current[KEY_MUTATION_LEDGER][index];
      const manual = active.manualResolution;
      if (!manual || receipt.operationId !== manual.intent.operationId) {
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
    const record = this.data[KEY_MUTATION_LEDGER].find(
      (entry) => entry.intent.operationId === sourceOperationId,
    );
    const manual = record?.manualResolution;
    if (!record || !manual?.receipt) {
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
      const active = current[KEY_MUTATION_LEDGER].find(
        (entry) => entry.intent.operationId === sourceOperationId,
      );
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
          (entry) => entry.intent.operationId !== sourceOperationId,
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

  async recordMutationReceipt(receipt: MutationReceiptV1): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation receipt requires active V2 authority");
    }
    if (this.mutationLedgerCorrupt) throw new Error("Mutation recovery ledger is corrupt");
    await this.commitPluginData((current) => {
      const index = current[KEY_MUTATION_LEDGER].findIndex(
        (entry) => entry.intent.operationId === receipt.operationId,
      );
      if (index < 0) throw new Error(`Mutation intent missing: ${receipt.operationId}`);
      const entries = [...current[KEY_MUTATION_LEDGER]];
      entries[index] = { ...entries[index], receipt };
      return { ...current, [KEY_MUTATION_LEDGER]: entries };
    });
  }

  async abandonMutationIntent(operationId: string): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation abandon requires active V2 authority");
    }
    let abandonedPath: string | null = null;
    await this.commitPluginData((data) => {
      const current = data[KEY_MUTATION_LEDGER].find(
        (entry) => entry.intent.operationId === operationId,
      );
      if (!current) return data;
      if (current.manualResolution) {
        throw new Error(`Cannot abandon reviewed mutation: ${operationId}`);
      }
      if (current.receipt) throw new Error(`Cannot abandon receipted mutation: ${operationId}`);
      abandonedPath = current.intent.path;
      return {
        ...data,
        [KEY_MUTATION_LEDGER]: data[KEY_MUTATION_LEDGER].filter(
          (entry) => entry.intent.operationId !== operationId,
        ),
      };
    });
    if (abandonedPath) this.pendingV2AncestorContent.delete(abandonedPath);
  }

  /** Publish a receipted mutation's base/remote/pending checkpoint, then clear it. */
  async commitMutationCheckpoint(operationId: string): Promise<void> {
    if (this.v2StateLoadBlock || !this.v2Envelope || this.legacyStateAllowed) {
      throw new Error("Mutation checkpoint requires active V2 authority");
    }
    const record = this.data[KEY_MUTATION_LEDGER].find(
      (entry) => entry.intent.operationId === operationId,
    );
    if (!record?.receipt) throw new Error(`Mutation receipt missing: ${operationId}`);
    const checkpoint = record.receipt.checkpoint;
    assertRemoteUpsertsHaveParentIdentity(checkpoint.remoteUpserts);

    const recoveryRecord = this.prepareMutationRecoveryRecord(
      record,
      this.v2Envelope.scope,
    );
    if (!recoveryRecord) {
      throw new Error(
        `Mutation scope no longer matches: ${record.intent.operationId}`,
      );
    }
    const ancestorHashes = isFolderMutationIntent(record.intent)
      ? {}
      : await this.publishPendingV2Ancestors(checkpoint.baseUpserts);
    await this.commitV2State((current) => {
      const reduced = isFolderMutationIntent(record.intent)
        ? reduceFolderStateEnvelopeV2(current, recoveryRecord)
        : reduceFileStateEnvelopeV2(current, recoveryRecord);
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
    await this.commitPluginData((current) => ({
      ...current,
      [KEY_PENDING_CONFLICTS]: current[KEY_PENDING_CONFLICTS].filter(
        (item) => !checkpoint.pendingConflictRemovals.includes(item.path),
      ),
      [KEY_PENDING_DELETES]: current[KEY_PENDING_DELETES].filter(
        (item) => !checkpoint.pendingDeleteRemovals.includes(item.path),
      ),
      [KEY_PENDING_ISSUES]: isFolderMutationIntent(record.intent)
        ? current[KEY_PENDING_ISSUES].filter(
            (issue) => issue.path !== record.intent.path,
          )
        : current[KEY_PENDING_ISSUES],
      [KEY_MUTATION_LEDGER]: current[KEY_MUTATION_LEDGER].filter(
        (entry) => entry.intent.operationId !== operationId,
      ),
      [KEY_LOCAL_FOLDER_MOVE_HINTS]: current[KEY_LOCAL_FOLDER_MOVE_HINTS].filter(
        (hint) => !(checkpoint.folderMoveHintRemovals ?? []).includes(hint.remoteId),
      ),
    }));
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

  getCommunityPluginEnablementState(
    scope: SyncScope,
  ): CommunityPluginEnablementStateV1 {
    const carried = this.activeV2MigrationHold?.communityPluginEnablement;
    if (
      carried
      && sameCommunityPluginEnablementCarrierScopeV2(carried, scope)
    ) {
      const projected =
        projectCommunityPluginEnablementCarrierStateV2(carried);
      return {
        version: 1,
        scope: { ...carried.scope },
        anchors: projected.anchors,
        pending: projected.pending,
      };
    }
    return this.getStoredCommunityPluginEnablementState(scope);
  }

  getCommunityPluginEnablementStateForMigrationSource(
    scope: SyncScope,
    source: Readonly<CommunityPluginEnablementSourceV2>,
  ): CommunityPluginEnablementStateV1 {
    const carried = this.activeV2MigrationHold?.communityPluginEnablement;
    if (
      carried
      && sameCommunityPluginEnablementCarrierScopeV2(carried, scope)
      && sameCommunityPluginEnablementSourceV2(carried.source, source)
    ) {
      return {
        version: 1,
        scope: { ...carried.scope },
        anchors: { ...carried.anchors },
        pending: [
          ...carried.pending.map((item) => ({ ...item })),
          ...carried.resolved.map((item) => ({ ...item })),
        ],
      };
    }
    return this.getStoredCommunityPluginEnablementState(scope);
  }

  private getStoredCommunityPluginEnablementState(
    scope: SyncScope,
  ): CommunityPluginEnablementStateV1 {
    const current = this.data[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE];
    if (!current.scope || !sameSyncScope(current.scope, scope)) {
      return {
        version: 1,
        scope: { ...scope },
        anchors: {},
        pending: [],
      };
    }
    return cloneCommunityPluginEnablementState(current);
  }

  async setCommunityPluginEnablementState(
    state: Readonly<CommunityPluginEnablementStateV1>,
  ): Promise<void> {
    const next = normalizeCommunityPluginEnablementState(state);
    await this.commitPluginData((current) =>
      sameCommunityPluginEnablementState(
        current[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE],
        next,
      )
        ? current
        : {
            ...current,
            [KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]: next,
          },
    );
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

  async resolveCommunityPluginEnablementDecisions(
    scope: SyncScope,
    expectedRevision: string,
    resolutions: readonly Readonly<
      CommunityPluginEnablementDecisionResolution
    >[],
  ): Promise<boolean> {
    const snapshot = this.getCommunityPluginEnablementDecisionSnapshot(scope);
    if (snapshot.revision !== expectedRevision) return false;
    const hold = this.activeV2MigrationHold;
    const carried = hold?.communityPluginEnablement;
    if (
      hold
      && carried
      && sameCommunityPluginEnablementCarrierScopeV2(carried, scope)
      && this.migrationHoldStore
    ) {
      const source = await this.readPublic113MigrationInput();
      if (
        await public113MigrationInputDigest(source)
        !== hold.sourceStateDigest
      ) return false;
      const resolved =
        await this.migrationHoldStore.resolveCommunityPluginEnablementDecisions(
          hold.revision,
          hold.canonicalIdentity,
          resolutions,
        );
      if (!resolved) return false;
      this.migrationHold = resolved;
      return true;
    }

    let resolved = false;
    await this.commitPluginData((current) => {
      const state = current[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE];
      if (
        !state.scope
        || !sameSyncScope(state.scope, scope)
        || communityPluginEnablementDecisionRevision(
          state.scope,
          state.pending,
        ) !== expectedRevision
        || !sameCommunityPluginEnablementDecisionSet(
          state.pending,
          resolutions,
        )
      ) return current;
      const enabledById = new Map(
        resolutions.map((item) => [item.pluginId, item.enabled]),
      );
      resolved = true;
      return {
        ...current,
        [KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]: {
          ...state,
          pending: state.pending.map((item) => ({
            ...item,
            resolvedEnabled: enabledById.get(item.pluginId)!,
          })),
        },
      };
    });
    return resolved;
  }

  getCommunityPluginEnablementDecisionSnapshot(
    scope: SyncScope,
  ): CommunityPluginEnablementDecisionSnapshot {
    const hold = this.activeV2MigrationHold;
    const carried = hold?.communityPluginEnablement;
    if (
      carried
      && sameCommunityPluginEnablementCarrierScopeV2(carried, scope)
    ) {
      return {
        revision: communityPluginEnablementMigrationDecisionRevision(
          hold,
          carried,
        ),
        decisions: carried.pending.map((item) => ({ ...item })),
      };
    }
    const state = this.getCommunityPluginEnablementState(scope);
    return {
      revision: communityPluginEnablementDecisionRevision(
        scope,
        state.pending,
      ),
      decisions: state.pending.map((item) => ({ ...item })),
    };
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
    selectedCommunityPluginIds?: readonly string[],
    scopeChange?: Readonly<SyncPathSettingsScopeChangeV1>,
  ): Promise<void> {
    if (
      this.v2StateLoadBlock
      || this.mutationLedgerCorrupt
      || this.mutationRecoveryQuarantineCorrupt
      || this.mutationLedger.length > 0
    ) {
      throw new Error("Cannot change sync paths while mutation recovery is unresolved");
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
      const selectedCommunityPluginIdSet = selectedCommunityPluginIds === undefined
        ? null
        : new Set(selectedCommunityPluginIds);
      const retiredLocalFolderMoveHintRemoteIds = new Set(
        scopeChange?.retireLocalFolderMoveHintRemoteIds ?? [],
      );
      const enablementState = current[KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE];
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
        [KEY_COMMUNITY_PLUGIN_ENABLEMENT_STATE]:
          selectedCommunityPluginIdSet === null
            ? enablementState
            : {
                ...enablementState,
                pending: enablementState.pending.filter(
                  (item) => selectedCommunityPluginIdSet.has(item.pluginId),
                ),
              },
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
      authorizedFolders,
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
        authorizedFolders: materializeSyncScopeExpansionFolders(
          marker,
          current,
        ),
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
    await this.setConfirmedDescendantFileReconstructionCheckpoint({
      version: 1,
      kind: "confirmed-descendant-file-reconstruction",
      scope: { ...input.scope },
      lifecycleEpoch: reduced.envelope.meta.lifecycleEpoch,
      sourceCommitSeq: reduced.envelope.meta.commitSeq,
      roots: reconstructionRoots,
      startedAt: confirmedAt,
    });
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

  async prunePendingIssues(activePaths: Iterable<string>): Promise<void> {
    const active = new Set(activePaths);
    await this.save((current) => {
      const next = current[KEY_PENDING_ISSUES].filter((issue) =>
        active.has(issue.path),
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
      return (
        this.migrationHold.communityPluginEnablement?.pending.length ?? 0
      ) === 0;
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
    communityPluginEnablement?: CommunityPluginEnablementMigrationCarrierV2;
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
      communityPluginEnablement: input.communityPluginEnablement,
      now: input.now,
    });
    this.migrationHold = hold;
    return structuredClone(hold);
  }

  async confirmV2MigrationHold(input: {
    authorization: PlanReviewAuthorization;
    candidate: SyncStateEnvelopeV2;
    canonicalIdentity: CanonicalPlanIdentityV2;
    communityPluginEnablement:
      CommunityPluginEnablementMigrationCarrierV2 | undefined;
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
      && sourceStateDigest === currentHold!.sourceStateDigest
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
      && (
        !("communityPluginEnablement" in input)
        || sameCommunityPluginEnablementMigrationCarrierV2(
          input.communityPluginEnablement,
          hold.communityPluginEnablement,
        )
      )
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
      || (hold.communityPluginEnablement?.pending.length ?? 0) > 0
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
   * replacement journal is still settled first, and unresolved remote
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
    await new LocalRecoveryJournal(adapter, paths.tmpDir).recover();

    const indexedDbStore = await this.indexedDbStoreForLocalReset(paths);
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
      await this.removeRemainingLocalSyncArtifacts(paths);
    } catch (error) {
      await this.load().catch(() => undefined);
      throw error;
    }
    await this.load();
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

function createEmptyCommunityPluginEnablementState(): CommunityPluginEnablementStateV1 {
  return {
    version: 1,
    scope: null,
    anchors: {},
    pending: [],
  };
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

function parseCommunityPluginEnablementState(
  value: unknown,
): CommunityPluginEnablementStateV1 {
  if (!value || typeof value !== "object") {
    return createEmptyCommunityPluginEnablementState();
  }
  const candidate = value as Partial<CommunityPluginEnablementStateV1>;
  if (candidate.version !== 1) {
    return createEmptyCommunityPluginEnablementState();
  }
  return normalizeCommunityPluginEnablementState({
    version: 1,
    scope: isSyncScope(candidate.scope) ? candidate.scope : null,
    anchors: candidate.anchors ?? {},
    pending: Array.isArray(candidate.pending) ? candidate.pending : [],
    observation: readCommunityPluginEnablementCommittedObservationV1(
      candidate.observation,
    ) ?? undefined,
  });
}

function normalizeCommunityPluginEnablementState(
  state: Readonly<CommunityPluginEnablementStateV1>,
): CommunityPluginEnablementStateV1 {
  const anchors: PluginEnablementAnchorsV1 = {};
  for (const [pluginId, enabled] of Object.entries(state.anchors)) {
    if (isSafeCommunityPluginId(pluginId) && typeof enabled === "boolean") {
      anchors[pluginId] = enabled;
    }
  }
  const pendingById = new Map<string, PendingCommunityPluginEnablementDecision>();
  for (const item of state.pending) {
    if (
      !item
      || !isSafeCommunityPluginId(item.pluginId)
      || typeof item.localEnabled !== "boolean"
      || typeof item.remoteEnabled !== "boolean"
    ) continue;
    pendingById.set(item.pluginId, {
      pluginId: item.pluginId,
      localEnabled: item.localEnabled,
      remoteEnabled: item.remoteEnabled,
      ...(typeof item.resolvedEnabled === "boolean"
        ? { resolvedEnabled: item.resolvedEnabled }
        : {}),
    });
  }
  return {
    version: 1,
    scope: state.scope ? { ...state.scope } : null,
    anchors: Object.fromEntries(
      Object.entries(anchors).sort(([left], [right]) => left.localeCompare(right)),
    ),
    pending: [...pendingById.values()]
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
    ...(state.observation
      ? {
          observation: {
            version: 1,
            source: {
              ...state.observation.source,
              selectedPluginIds: [
                ...state.observation.source.selectedPluginIds,
              ],
              local: { ...state.observation.source.local },
              remote: { ...state.observation.source.remote },
            },
            localPluginIds: [...state.observation.localPluginIds],
            remotePluginIds: [...state.observation.remotePluginIds],
          },
        }
      : {}),
  };
}

function cloneCommunityPluginEnablementState(
  state: Readonly<CommunityPluginEnablementStateV1>,
): CommunityPluginEnablementStateV1 {
  return {
    version: 1,
    scope: state.scope ? { ...state.scope } : null,
    anchors: { ...state.anchors },
    pending: state.pending.map((item) => ({ ...item })),
    ...(state.observation
      ? {
          observation: {
            version: 1,
            source: {
              ...state.observation.source,
              selectedPluginIds: [
                ...state.observation.source.selectedPluginIds,
              ],
              local: { ...state.observation.source.local },
              remote: { ...state.observation.source.remote },
            },
            localPluginIds: [...state.observation.localPluginIds],
            remotePluginIds: [...state.observation.remotePluginIds],
          },
        }
      : {}),
  };
}

function sameCommunityPluginEnablementState(
  left: Readonly<CommunityPluginEnablementStateV1>,
  right: Readonly<CommunityPluginEnablementStateV1>,
): boolean {
  return left.version === right.version
    && JSON.stringify(left.scope) === JSON.stringify(right.scope)
    && JSON.stringify(left.anchors) === JSON.stringify(right.anchors)
    && JSON.stringify(left.pending) === JSON.stringify(right.pending)
    && sameCommunityPluginEnablementCommittedObservationV1(
      left.observation,
      right.observation,
    );
}

function isSafeCommunityPluginId(pluginId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(pluginId)
    && pluginId.toLowerCase() !== "easy-sync";
}

function parseRemoteState(value: unknown): RemoteSyncState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<RemoteSyncState>;
  if (state.version !== 1) return null;
  if (typeof state.generation !== "number") (state as Record<string, unknown>).generation = 0;
  const rawScope = (state as Partial<RemoteSyncState>).scope;
  if (rawScope !== undefined && rawScope !== null && !isSyncScope(rawScope)) return null;
  if (state.deltaLink !== null && typeof state.deltaLink !== "string") return null;
  if (!state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
    return null;
  }
  for (const [path, entry] of Object.entries(state.entries)) {
    if (!isRemoteEntry(entry) || entry.path !== path) return null;
  }
  const rawFolders = (state as Partial<RemoteSyncState>).folders;
  if (rawFolders !== undefined && (
    !rawFolders
    || typeof rawFolders !== "object"
    || Array.isArray(rawFolders)
  )) return null;
  const folders = (rawFolders ?? {}) as Record<string, RemoteFolderEntry>;
  for (const [driveId, folder] of Object.entries(folders)) {
    if (!isRemoteFolderEntry(folder) || folder.driveId !== driveId) return null;
  }
  const rawFolderIndexComplete = (
    state as Partial<RemoteSyncState>
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
    entries: state.entries as Record<string, RemoteFileEntry>,
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
  return value;
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
  return isMutationIntent(entry.intent)
    && (entry.receipt === null || isMutationReceipt(entry.receipt, entry.intent.operationId))
    && (entry.manualResolution === undefined
      || isManualMutationResolution(entry.manualResolution, entry.intent));
}

function isManualMutationResolution(
  value: unknown,
  sourceIntent?: MutationIntent,
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
    || !isMutationIntent(value.intent)
    || value.intent.version !== 1
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
  if (!value.externalMutation && value.receipt === null) return false;
  const hasSourcePath = typeof value.intent.sourcePath === "string";
  const semanticActionMatches = !value.externalMutation
    ? !hasSourcePath && (
        (value.intent.action === "upload"
          && value.intent.expectedLocal.exists
          && value.intent.expectedRemote.exists)
        || (value.intent.action === "deleteLocal"
          && !value.intent.expectedLocal.exists
          && !value.intent.expectedRemote.exists)
      )
    : hasSourcePath
      ? value.intent.expectedLocal.exists
        && value.intent.expectedRemote.exists
        && (
          (value.choice === "keep-local" && value.intent.action === "renameRemote")
          || (value.choice === "keep-remote" && value.intent.action === "moveLocal")
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
  return JSON.stringify(sourcePaths) === JSON.stringify(resolutionPaths);
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

function isMutationIntent(value: unknown): value is MutationIntent {
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
      && typeof folderIntent.createdAt === "number";
  }
  const fileIntent = value as Partial<MutationIntentV1>;
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
    && isMutationLocalExpectation(fileIntent.expectedLocal)
    && isMutationRemoteExpectation(fileIntent.expectedRemote)
    && (fileIntent.target === undefined || isMutationVersion(fileIntent.target))
    && ((fileIntent.action !== "renameRemote" && fileIntent.action !== "moveLocal")
      || isVaultRelativeMutationPath(fileIntent.sourcePath))
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

function isVaultRelativeMutationPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) =>
      Boolean(segment) && segment !== "." && segment !== "..");
}

function isExistingMutationLocalExpectation(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { exists?: unknown }).exists === true);
}

function isExistingMutationRemoteExpectation(value: unknown): boolean {
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
    && existing.source.commitSeq === source.commitSeq
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

function communityPluginEnablementDecisionRevision(
  scope: Readonly<SyncScope>,
  pending: readonly Readonly<PendingCommunityPluginEnablementDecision>[],
): string {
  return JSON.stringify({
    scope,
    pending: [...pending]
      .map((item) => ({ ...item }))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
  });
}

function communityPluginEnablementMigrationDecisionRevision(
  hold: Readonly<Pick<
    MigrationHoldV2,
    "revision" | "canonicalIdentity" | "sourceStateDigest"
  >>,
  carrier: Readonly<CommunityPluginEnablementMigrationCarrierV2>,
): string {
  return JSON.stringify({
    kind: "migration",
    holdRevision: hold.revision,
    canonicalIdentity: hold.canonicalIdentity,
    sourceStateDigest: hold.sourceStateDigest,
    scope: carrier.scope,
    source: carrier.source,
    pending: [...carrier.pending]
      .map((item) => ({ ...item }))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
  });
}
