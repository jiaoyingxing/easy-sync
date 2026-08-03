/**
 * SyncExecutor — Main sync run orchestrator
 *
 * Ties together LocalScanner, OneDriveClient, the canonical V2 planners, and
 * StateManager to execute a complete sync round. Handles:
 *  - First sync initialization (mode detection, plan preview)
 *  - Bidirectional sync (three-way comparison → plan → execute)
 *  - Per-file immediate persistence (interruption recovery)
 *  - Token expiry pause-and-resume
 *  - Change threshold pause
 *  - Sync lock (one run at a time)
 *  - Conflict and delete-confirmation routing
 */

import {
  Platform,
  TFile,
  TFolder,
  requireApiVersion,
  type DataAdapter,
  type FileManager,
} from "obsidian";
import { sha256Hex } from "../crypto";
import {
  compatSetTimeout,
  getConfigDir,
  getEasySyncPaths,
  isEasySyncSelfSyncFilePath,
  isRecord,
} from "../obsidian-compat";
import {
  OneDriveError,
  OneDriveErrorType,
  RemoteVaultScopeIdentityError,
} from "../onedrive/types";
import type {
  DriveItem,
  RemoteVaultScopeIdentityFailureReason,
  UploadResult,
} from "../onedrive/types";
import { AuthError } from "../auth/types";
import {
  SyncActionType,
  planDigest,
  sameCanonicalPlanIdentityV2,
  sameSyncScope,
} from "./types";
import type { OneDriveClient } from "../onedrive/client";
import { isEasySyncInternalPath } from "./local-scanner";
import type { LocalFileInspection, LocalScanner } from "./local-scanner";
import {
  isObsidianManagedConfigPath,
  protectEasySyncSelfSyncPlan,
  remoteContentMatchesBase,
} from "./file-decision-planner-v2";
import { StateManager } from "./state-manager";
import type { PendingIssue } from "./state-manager";
import type {
  BaseFileEntry,
  CloudBaseline,
  LocalFileEntry,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncDecisionToken,
  SyncPlan,
  SyncPlanItem,
  SyncScope,
  PlanReviewAuthorization,
  MutationIntentV1,
  FolderMutationIntentV2,
  MutationIntent,
  MutationReceiptV1,
  MutationCheckpointV1,
  MutationLedgerEntryV1,
  MutationRecoveryRunSummary,
  SyncAttention,
  V2ActivationReviewKind,
} from "./types";
import type { DiagnosticLogger } from "./diagnostic-logger";
import {
  remoteStateProjectionMatchesEnvelopeV2,
  upsertBaseStateEnvelopeV2,
} from "./file-state-controller-v2";
import type {
  StateEnvelopeV2CorruptionEvidence,
  SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import type { CanonicalPlannerStateV2 } from "./canonical-planner-state-v2";
import type { I18n } from "../i18n/index";
import { SyncProgressStore, type FileProgress } from "./sync-progress";
import { OperationLifecycle } from "./operation-lifecycle";
import { EasySyncNoticeCenter, NOTICE_PRIORITY } from "../ui/notice-center";
import { LocalRecoveryJournal } from "./local-recovery-journal";
import { MergeReadyStore } from "./merge-ready-store";
import {
  createTextMergeManualEvidenceV1,
  evaluateConservativeMergeV2,
  matchingTextMergeManualEvidenceV1,
  type TextMergeEvidenceIdentityV1,
} from "./conservative-merge-v2";
import {
  buildRemoteIndexV2,
  projectRemoteIndexV2,
  type RemoteIndexV2,
} from "./remote-index-v2";
import { isFolderMutationIntent } from "./folder-state-reducer-v2";
import {
  buildCanonicalPlanCandidateFromStateV2,
  buildCanonicalPlanCandidateV2,
  canonicalPlanDigestV2,
  finalizeCanonicalPlanCandidateV2,
  finalizeUnanchoredFolderEvidenceV2,
  folderPathDepth,
  isAtOrBelowPath,
  isProtectedFolderDeletePath,
  normalizeRemotePathKey,
  parentFolderPath,
  sealCanonicalPlanV2,
  summarizeCanonicalPlanReviewV2,
  type CanonicalPlanCandidateV2,
  type FinalizedCanonicalPlanV2,
} from "./canonical-plan-v2";
import {
  ADAPTIVE_DOWNLOAD_MAX_BYTES,
  DownloadConcurrencyPolicy,
} from "./download-concurrency-policy";
import {
  contentDifferenceReceiptMatches,
  resolveContentEquality,
} from "./content-equality";
import {
  cloudBootstrapAnchorDigestV2,
  cloudBootstrapCheckpointMatchesEnvelopeV2,
  createOneDriveCloudBootstrapTransportV2,
  publishCloudBootstrapV2,
  verifyCloudBootstrapV2,
} from "./cloud-bootstrap-v2";
import {
  buildStateV2MigrationCandidate,
  sameStateV2MigrationCandidate,
  sameStateV2MigrationResumeFacts,
} from "./state-v2-migration";
import {
  migrationPlanFactsDigestV2,
  migrationHoldReviewKindV2,
  type MigrationHoldV2,
} from "./migration-hold-v2";
import {
  createOneDriveSharedSyncProtocolTransportV2,
  ensureSharedSyncProtocolV2,
  type SharedSyncProtocolBindingV2,
  type SharedSyncProtocolTransportV2,
} from "./sync-protocol-v2";
import {
  buildRemoteScopeRecoveryCandidateV2,
} from "./remote-scope-recovery-v2";
import {
  buildCorruptStateRecoveryCandidateV2,
} from "./corrupt-state-recovery-v2";
import {
  DEFAULT_AUTOMATIC_HANDLING_POLICY,
  isAutomaticTextMergeCandidatePath,
  type AutomaticHandlingPolicy,
} from "./automatic-handling-policy";
import {
  cloneCommunityPluginSyncPolicy,
  DEFAULT_COMMUNITY_PLUGIN_SYNC_POLICY,
  getRestoringPluginIds,
  isPluginSelected,
  type CommunityPluginRestoreSet,
  type CommunityPluginSyncPolicyV1,
  type PluginScopeSelection,
} from "./community-plugin-sync-policy";
import {
  applyCommunityPluginLocalIgnores,
  classifyCommunityPluginManagedPath,
  collectCommunityPluginIdsForEnablement,
  detectCommunityPluginDataLocalIgnores,
  detectCommunityPluginLocalIgnores,
  isCommunityPluginFolderPreservedByPolicy,
  isCommunityPluginPathSelectedByPolicy,
  protectCommunityPluginPlan,
  type CommunityPluginLocalIgnores,
} from "./community-plugin-deletion-boundary";
import {
  parseCommunityPluginEnablementJson,
  prepareCommunityPluginEnablementFromObservations,
  sameCommunityPluginEnablementMigrationCarrierV2,
  serializeCommunityPluginEnablementJson,
  type CommunityPluginEnablementCommittedObservationV1,
  type CommunityPluginEnablementMigrationCarrierV2,
  type CommunityPluginEnablementSourceV2,
  type PreparedCommunityPluginEnablement,
} from "./community-plugin-enablement";
import {
  assessCommunityPluginManifestCompatibility,
  compareCommunityPluginVersions,
  communityPluginManifestObservationMatchesRemote,
  communityPluginManifestRemoteSourceKey,
  createCommunityPluginManifestObservation,
  parseCommunityPluginBundleManifest,
  parseCommunityPluginBundlePath,
  type CommunityPluginManifestObservationV1,
} from "./community-plugin-bundle";
import {
  validateCommunityPluginJoinAuthorization,
  type CommunityPluginJoinAuthorization,
  type CommunityPluginJoinBlock,
} from "./community-plugin-join";

/** Result of a sync run */
export interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  /** Number of local and remote folders created by the V2 folder chain. */
  foldersCreated?: number;
  /** Number of identity-preserving local/remote folder moves. */
  foldersMoved?: number;
  /** Number of empty folder shells removed after a second read. */
  foldersDeleted?: number;
  /** Number of identity-preserving local file moves. */
  filesMoved?: number;
  deleted: number;
  conflicts: number;
  /** Files safely left for the next round because their version changed in flight. */
  deferred: number;
  skippedLarge: number;
  skippedIgnored: number;
  errors: number;
  authExpired: boolean;
  message: string;
  /** Stable user-attention reason; presentation must not infer this from message text. */
  attention?: SyncAttention;
  /** Device-local plugin opt-outs inferred from a prior shared item disappearing locally. */
  communityPluginLocalIgnores?: CommunityPluginLocalIgnores;
  /** Explicit device-local rejoin authorizations whose remote content is now
   *  durably present again and may be retired from settings. */
  communityPluginRestoresCompleted?: CommunityPluginRestoreSet;
  /** Persisted device join operations rejected before plugin mutation. */
  communityPluginJoinBlocks?: CommunityPluginJoinBlock[];
  /** Internal one-shot handoff: V2 authority imported and settled a public
   *  1.1.3 ledger, so Main should immediately run the ordinary V2 round. */
  continueAfterStateOnlyMigrationRecovery?: boolean;
  /** Internal one-shot handoff: a reviewed corrupt V2 state was republished,
   *  so Main should revalidate the same authorization in the ordinary V2
   *  mutation chain. */
  continueAfterV2CorruptStateRecovery?: boolean;
  /** Internal state-only continuation: a repaired folder subtree still has
   *  unverified file identities. Main must yield the current UI round and
   *  start a separate bounded continuation; this grants no mutation power. */
  continueAfterConfirmedDescendantFileReconstruction?: boolean;
  /** The state-only continuation stopped on an observation/publication
   *  failure rather than an ordinary slice limit. Main applies bounded
   *  cross-round backoff before eventually surfacing the failure. */
  descendantFileReconstructionRetryableFailure?: boolean;
  /** Internal recovery fact for an active V2 mutation ledger. This carries no
   *  user-file or Graph mutation authority: it only tells Main whether an
   *  evidence observation settled the existing records, should be retried
   *  after a transient Graph failure, or reached a stable fail-closed
   *  boundary. */
  mutationRecovery?: MutationRecoveryRunSummary;
  metrics?: ExecutionMetrics;
}

/** Result of executing a single plan item — caller collects baseUpsert/baseRemoval for batch persistence. */
export interface ItemExecutionResult {
  executed: boolean;
  /** True only after a local/remote file mutation returned successfully. */
  mutationApplied?: boolean;
  baseUpsert?: BaseFileEntry;
  baseRemoval?: string;
  /** Exact remote folder identity to publish with a folder-create receipt. */
  folderUpsert?: RemoteFolderEntry;
  /** Exact remote folder identity retired by an empty-shell delete. */
  folderDelete?: { path: string; driveId: string };
  /** A Conflict item completed automatically and must not enter pending review. */
  resolvedConflict?: boolean;
  /** User-facing action used by progress/history after a conflict is resolved automatically. */
  completionActionType?: SyncActionType;
  completionReason?: string;
}

/** Sync run mode */
export type SyncMode = "manual" | "auto" | "first";

export interface SyncRunOptions {
  /** Generate and persist a plan without any file mutation or create request. */
  readOnlyPreview?: boolean;
  /** Explicit user-triggered recovery of a held V2 remote scope. Automatic
   *  sync never sets this flag and remains paused. */
  recoverV2RemoteScope?: boolean;
  /** Explicit manual recovery for a stable corrupt V2 committed envelope.
   *  Collection is GET-only; only a current reviewed authorization may publish
   *  V2 authority, and plan actions remain owned by the ordinary V2 round. */
  recoverV2CorruptState?: boolean;
  /** One-shot permission to create the shared V2 protocol. Public 1.1.3
   *  migration also requires the dedicated risk confirmation; ordinary first
   *  sync receives permission from confirmation of its canonical plan. */
  acknowledgeMigrationRisk?: boolean;
  /** Observe and settle only the active V2 mutation ledger. Even when all
   *  records settle, return before baseline loading, planning, or mutation. */
  recoveryOnly?: boolean;
  /** Internal, device-local restore authorities derived from persisted V2
   * participation plus a fresh, complete remote plugin catalog. */
  communityPluginJoinAuthorizations?: readonly CommunityPluginJoinAuthorization[];
}

function excludeSelectedCommunityPluginFiles(
  policy: Readonly<CommunityPluginSyncPolicyV1>,
  pluginIds: readonly string[],
): CommunityPluginSyncPolicyV1 {
  if (policy.files.mode !== "selected") {
    throw new Error(
      "Community-plugin join requires the selected V2 participation projection",
    );
  }
  const excluded = new Set(pluginIds);
  return {
    ...cloneCommunityPluginSyncPolicy(policy),
    files: {
      mode: "selected",
      pluginIds: policy.files.pluginIds.filter((pluginId) =>
        !excluded.has(pluginId)
      ),
    },
  };
}

interface PreparedCommunityPluginEnablementWork {
  path: string;
  selectedPluginIds: string[];
  observedLocal: LocalFileEntry | undefined;
  observedLocalIds: string[];
  observedRemote: RemoteFileEntry | undefined;
  observedRemoteIds: string[];
  observation: CommunityPluginEnablementCommittedObservationV1;
  prepared: PreparedCommunityPluginEnablement;
  migrationCarrier: CommunityPluginEnablementMigrationCarrierV2;
}

class CommunityPluginEnablementVersionChangedError extends Error {
  constructor(readonly side: "local" | "remote") {
    super(`Community plugin enablement ${side} version changed`);
  }
}

type StreamDownloadAdapter = DataAdapter & {
  appendBinary: (normalizedPath: string, data: ArrayBuffer) => Promise<void>;
  rename: (normalizedPath: string, normalizedNewPath: string) => Promise<void>;
};

class IncrementalRemoteHierarchyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncrementalRemoteHierarchyError";
  }
}

class MutationRecoveryBlockedError extends Error {
  constructor(
    readonly summary: MutationRecoveryRunSummary,
    cause: Error,
  ) {
    super(cause.message);
    this.name = "MutationRecoveryBlockedError";
  }
}

type V2CommittedScopeLossReason =
  | "graph-not-found"
  | RemoteVaultScopeIdentityFailureReason;

class V2CommittedScopeUnreachableError extends Error {
  constructor(
    readonly observedScope: SyncScope | null,
    readonly causeReason: V2CommittedScopeLossReason,
  ) {
    super("Committed V2 remote scope is unreachable");
    this.name = "V2CommittedScopeUnreachableError";
  }
}

interface RemoteProjection {
  entries: RemoteFileEntry[];
  folders: RemoteFolderEntry[];
}

type LocalFolderInspection =
  | { status: "missing" }
  | { status: "present" }
  | { status: "file" }
  | { status: "uncertain" };

type RemoteFolderInspection =
  | { status: "missing" }
  | { status: "folder"; entry: RemoteFolderEntry }
  | { status: "file" };

const SMALL_UPLOAD_CONCURRENCY = 5;
const CONCURRENT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const LARGE_UPLOAD_CONCURRENCY = 2;

const MOBILE_SMALL_UPLOAD_CONCURRENCY = 2;
const MOBILE_LARGE_UPLOAD_CONCURRENCY = 1;
const MOBILE_STREAM_DOWNLOAD_MIN_BYTES = 8 * 1024 * 1024;
const MOBILE_PLUGIN_MANIFEST_PREFLIGHT_CONCURRENCY = 3;
const ANDROID_TEMP_WRITE_MAX_ATTEMPTS = 3;

interface PreparedDownload {
  content?: ArrayBuffer;
  downloaded?: { size: number; hash: string };
  error?: unknown;
}

export interface ReviewedContentEqualityProof {
  localHash: string;
  localSize: number;
  remoteHash: string;
  remoteSize: number;
  remoteETag: string;
}

type SideActionPreparationPhase =
  | "localRecovery"
  | "remotePrepare"
  | "scopeValidation"
  | "mutationRecovery"
  | "action";

type SideMutationRecoveryOutcome = "applied" | "not-applied" | "unresolved";
interface SideMutationRecoveryResult {
  outcome: SideMutationRecoveryOutcome;
  retryableObservationError: OneDriveError | null;
}

/** Marks a failure that happened before the reviewed target was mutated. */
class MutationNotAppliedError extends Error {
  constructor(
    readonly original: unknown,
    readonly noticeAlreadyShown = false,
  ) {
    super(original instanceof Error ? original.message : "Reviewed mutation was not applied");
    this.name = "MutationNotAppliedError";
  }
}

/** Local CAS failed before commitDownloadedTempFile touched the target. */
class LocalCommitPreconditionError extends Error {}

/** Local file changed after DeleteLocal was planned but before deletion began. */
class LocalVersionChangedBeforeDeleteError extends Error {
  constructor(path: string) {
    super(`Local version changed before deletion: ${path}`);
    this.name = "LocalVersionChangedBeforeDeleteError";
  }
}

/** The downloaded bytes belong to a remote version that is no longer current. */
class DownloadRemoteVersionChangedError extends Error {
  constructor(path: string) {
    super(`Remote version changed during download: ${path}`);
    this.name = "DownloadRemoteVersionChangedError";
  }
}

export interface FileTransferMetrics {
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  logicalBytes: number;
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

export type AutomaticMergeManualReason =
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
  uploadNetworkMs: number;
  activeUploads: number;
  peakUploads: number;
  fileTransfers: {
    upload: FileTransferMetrics;
    download: FileTransferMetrics;
  };
  automaticHandling: AutomaticHandlingMetrics;
}

type SyncRunPhase =
  | "recovery"
  | "scan"
  | "remotePrepare"
  | "baseline"
  | "remoteChanges"
  | "planning"
  | "reviewWait"
  | "transfer"
  | "commit";

type SyncRunPhaseDurations = Record<SyncRunPhase, number>;

function createFileTransferMetrics(): FileTransferMetrics {
  return {
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    logicalBytes: 0,
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

function createAutomaticHandlingMetrics(
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

function recordAutomaticMergeManual(
  metrics: AutomaticHandlingMetrics,
  reason: AutomaticMergeManualReason,
): null {
  metrics.textMerge.keptManual++;
  metrics.textMerge.manualReasons[reason] =
    (metrics.textMerge.manualReasons[reason] ?? 0) + 1;
  return null;
}

/** Callbacks for UI updates during sync */
export interface SyncCallbacks {
  onProgress?: (current: number, total: number, currentFile: string) => void;
  onFileProgress?: (downloaded: number, total: number) => void;
  onFileComplete?: (
    path: string,
    actionType: SyncActionType,
    success: boolean,
    reason?: string,
    fileSize?: number,
    sourcePath?: string,
  ) => void;
  onStateChange?: () => void;
  onConfirmThreshold?: (plan: SyncPlan) => Promise<boolean>;
  onFirstSyncPreview?: (plan: SyncPlan) => Promise<boolean>;
}

function availableSharedSyncProtocolTransportV2(
  client: OneDriveClient,
  vaultName: string,
): SharedSyncProtocolTransportV2 | null {
  const candidate = client as OneDriveClient & {
    readSharedSyncProtocolV2?: OneDriveClient["readSharedSyncProtocolV2"];
    createSharedSyncProtocolV2?: OneDriveClient["createSharedSyncProtocolV2"];
    readSharedSyncProtocolV2ById?:
      OneDriveClient["readSharedSyncProtocolV2ById"];
  };
  return typeof candidate.readSharedSyncProtocolV2 === "function"
    && typeof candidate.createSharedSyncProtocolV2 === "function"
    && typeof candidate.readSharedSyncProtocolV2ById === "function"
    ? createOneDriveSharedSyncProtocolTransportV2(candidate, vaultName)
    : null;
}

export class SyncExecutor {
  private running = false;
  private sideActionRunning = false;
  private sideActionQueue: Promise<void> = Promise.resolve();
  private queuedSideActionPaths = new Set<string>();
  private sideActionBatchTotal = 0;
  private sideActionBatchSettled = 0;
  private cancelled = false;
  private cancelController: AbortController | null = null;
  private startGeneration = 0;
  private mutationSequence = 0;
  private activeSyncScope: SyncScope | null = null;
  private remoteRecoveryPreviewRequired = false;
  private localVersionRecoveredDuringLedger = false;
  private completeRemoteItems: DriveItem[] | null = null;
  private automaticHandlingPolicy: AutomaticHandlingPolicy = {
    ...DEFAULT_AUTOMATIC_HANDLING_POLICY,
  };
  private communityPluginSyncPolicy = cloneCommunityPluginSyncPolicy(
    DEFAULT_COMMUNITY_PLUGIN_SYNC_POLICY,
  );
  private mobileCommunityPluginPreparedManifests = new Map<string, {
    sourceKey: string;
    prepared: PreparedDownload;
  }>();
  private mobileDesktopOnlyPluginIds = new Set<string>();

  constructor(
    private onedrive: OneDriveClient,
    private scanner: LocalScanner,
    private state: StateManager,
    private vaultName: string,
    private i18n?: I18n,
    private progressStore?: SyncProgressStore,
    private diag?: DiagnosticLogger,
    private fileManager?: FileManager,
    private onProgressUpdate?: () => void,
    private lifecycle: OperationLifecycle = new OperationLifecycle(),
    private noticeCenter: EasySyncNoticeCenter = new EasySyncNoticeCenter(),
  ) {}

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n?.t(key, params) ?? key;
  }

  /** Show a translated notice to the user */
  private notice(key: string, params?: Record<string, string | number>): void {
    const priority = key === "result.legacyStateDisabled"
      || key === "result.v2StateLoadBlocked"
      || key === "result.v2ScopeRecoveryPending"
      || key === "result.authExpired"
      || key === "notice.localRecoveryFailed"
      || key === "notice.v2MigrationRequired"
      || key === "notice.sideActionScopeChanged"
      || key === "notice.sideActionMutationRecoveryFailed"
      ? NOTICE_PRIORITY.critical
      : key.endsWith(".failed") || key === "notice.conflict.downloadFailed"
        ? NOTICE_PRIORITY.failure
        : NOTICE_PRIORITY.action;
    this.noticeCenter.show({
      key: `side-action:${key}:${params?.path ?? ""}`,
      message: this.t(key, params),
      priority,
      className: "easy-sync-notice-action",
    });
  }

  private stopSideActionForStateRecovery(): boolean {
    if (this.state.hasV2StateLoadRecoveryBlock) {
      this.notice("result.v2StateLoadBlocked");
      return true;
    }
    if (this.state.hasV2RemoteScopeRecovery) {
      this.notice("result.v2ScopeRecoveryPending");
      return true;
    }
    if (this.state.legacyAutoSyncAllowed === false && !this.state.isV2StateActive) {
      this.notice("result.legacyStateDisabled");
      return true;
    }
    return false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setAutomaticHandlingPolicy(policy: Readonly<AutomaticHandlingPolicy>): void {
    this.automaticHandlingPolicy = { ...policy };
  }

  setCommunityPluginSyncPolicy(
    policy: Readonly<CommunityPluginSyncPolicyV1>,
  ): void {
    this.communityPluginSyncPolicy = cloneCommunityPluginSyncPolicy(policy);
  }

  getMobileDesktopOnlyCommunityPluginIds(): string[] {
    return [...this.mobileDesktopOnlyPluginIds].sort((left, right) =>
      left.localeCompare(right));
  }

  get hasSideActionsInFlight(): boolean {
    return this.sideActionRunning || this.queuedSideActionPaths.size > 0;
  }

  isSideActionQueued(path: string): boolean {
    return this.queuedSideActionPaths.has(path);
  }

  cancel(): void {
    this.invalidateLifecycle("cancel");
  }

  invalidateLifecycle(reason: string): void {
    this.cancelled = true;
    this.lifecycle.invalidate(reason);
    this.cancelController?.abort();
  }

  get hasActivityInFlight(): boolean {
    return this.running || this.hasSideActionsInFlight;
  }

  private markCancelled(result: SyncResult): void {
    result.message = this.t("result.cancelled");
  }

  private canContinue(epoch: number, result?: SyncResult): boolean {
    return !this.cancelled
      && this.lifecycle.isCurrent(epoch)
      && !result?.authExpired;
  }

  private shouldStop(result: SyncResult, epoch: number): boolean {
    if (this.canContinue(epoch, result)) return false;
    this.markCancelled(result);
    return true;
  }

  private localMatchesRemoteHash(
    local: Pick<LocalFileEntry, "hash" | "size">,
    remote: { sha256Hash?: string; size: number },
  ): boolean {
    return Boolean(remote.sha256Hash) && resolveContentEquality({
      local,
      remote: { ...remote, eTag: "" },
    }).status === "equal";
  }

  private async inspectLocalPath(path: string): Promise<LocalFileInspection | null> {
    const scanner = this.scanner as LocalScanner & {
      inspectFile?: (filePath: string) => Promise<LocalFileInspection>;
    };
    if (typeof scanner.inspectFile !== "function") return null;
    return scanner.inspectFile(path);
  }

  private async inspectLocalFolder(path: string): Promise<LocalFolderInspection> {
    const vault = this.scanner.vault as LocalScanner["vault"] & {
      getAbstractFileByPath?: (folderPath: string) => unknown;
    };
    try {
      const abstract = vault.getAbstractFileByPath?.(path);
      if (abstract) {
        return abstract instanceof TFolder
          ? { status: "present" }
          : { status: "file" };
      }
    } catch {
      return { status: "uncertain" };
    }

    try {
      const stat = await vault.adapter.stat(path);
      if (!stat) return { status: "missing" };
      const type = (stat as { type?: unknown }).type;
      if (type === "folder") return { status: "present" };
      if (type === "file") return { status: "file" };
      const list = (vault.adapter as DataAdapter & {
        list?: (folderPath: string) => Promise<unknown>;
      }).list;
      if (typeof list === "function") {
        try {
          await list.call(vault.adapter, path);
          return { status: "present" };
        } catch {
          return { status: "file" };
        }
      }
      return { status: "uncertain" };
    } catch {
      return { status: "uncertain" };
    }
  }

  private async inspectRemoteFolder(path: string): Promise<RemoteFolderInspection> {
    const item = await this.onedrive.getDriveItemMetadata(this.vaultName, path);
    if (!item) return { status: "missing" };
    if (!item.folder) return { status: "file" };
    if (!item.id || !item.name || !item.parentReference?.id) {
      throw new Error(`Remote folder identity is incomplete: ${path}`);
    }
    return {
      status: "folder",
      entry: {
        path,
        driveId: item.id,
        parentId: item.parentReference.id,
        name: item.name,
        eTag: item.eTag,
      },
    };
  }

  private folderRemoteExpectationMatches(
    current: RemoteFolderInspection,
    expected: FolderMutationIntentV2["expectedRemote"],
  ): boolean {
    if (!expected.exists) return current.status === "missing";
    return current.status === "folder"
      && current.entry.driveId === expected.driveId
      && current.entry.parentId === expected.parentId
      && (
        expected.eTag === undefined
        || current.entry.eTag === expected.eTag
      );
  }

  private async createLocalFolder(path: string): Promise<void> {
    const configDir = getConfigDir(this.scanner.vault);
    const useAdapter = path === configDir || path.startsWith(`${configDir}/`);
    const vault = this.scanner.vault as LocalScanner["vault"] & {
      createFolder?: (folderPath: string) => Promise<void>;
    };
    if (!useAdapter && typeof vault.createFolder === "function") {
      await vault.createFolder(path);
      return;
    }
    await vault.adapter.mkdir(path);
  }

  private async renameLocalFolder(sourcePath: string, targetPath: string): Promise<void> {
    const configDir = getConfigDir(this.scanner.vault);
    const touchesConfig = [sourcePath, targetPath].some(
      (path) => path === configDir || path.startsWith(`${configDir}/`),
    );
    await this.ensureParentDirs(targetPath);
    if (touchesConfig) {
      const adapter = this.scanner.vault.adapter as DataAdapter & {
        rename?: (from: string, to: string) => Promise<void>;
      };
      if (typeof adapter.rename !== "function") {
        throw new Error(`Local adapter cannot move a config folder safely: ${sourcePath}`);
      }
      await adapter.rename(sourcePath, targetPath);
    } else {
      const vault = this.scanner.vault as LocalScanner["vault"] & {
        getAbstractFileByPath?: (path: string) => unknown;
        rename?: (file: TFolder, target: string) => Promise<void>;
      };
      const source = vault.getAbstractFileByPath?.(sourcePath);
      if (!(source instanceof TFolder) || typeof vault.rename !== "function") {
        throw new Error(`Local folder identity changed before move: ${sourcePath}`);
      }
      await vault.rename(source, targetPath);
    }
    const [sourceAfter, targetAfter] = await Promise.all([
      this.inspectLocalFolder(sourcePath),
      this.inspectLocalFolder(targetPath),
    ]);
    if (sourceAfter.status !== "missing" || targetAfter.status !== "present") {
      throw new Error(`Local folder move read-back failed: ${sourcePath} -> ${targetPath}`);
    }
  }

  private async renameLocalFile(sourcePath: string, targetPath: string): Promise<void> {
    const configDir = getConfigDir(this.scanner.vault);
    const touchesConfig = [sourcePath, targetPath].some(
      (path) => path === configDir || path.startsWith(`${configDir}/`),
    );
    await this.ensureParentDirs(targetPath);
    if (touchesConfig) {
      const adapter = this.scanner.vault.adapter as DataAdapter & {
        rename?: (from: string, to: string) => Promise<void>;
      };
      if (typeof adapter.rename !== "function") {
        throw new Error(`Local adapter cannot move a config file safely: ${sourcePath}`);
      }
      await adapter.rename(sourcePath, targetPath);
      return;
    }
    const vault = this.scanner.vault as LocalScanner["vault"] & {
      getAbstractFileByPath?: (path: string) => unknown;
      rename?: (file: TFile, target: string) => Promise<void>;
    };
    const source = vault.getAbstractFileByPath?.(sourcePath);
    if (!(source instanceof TFile) || typeof vault.rename !== "function") {
      throw new Error(`Local file identity changed before move: ${sourcePath}`);
    }
    await vault.rename(source, targetPath);
  }

  private async isLocalFolderEmpty(path: string): Promise<boolean> {
    const adapter = this.scanner.vault.adapter as DataAdapter & {
      list?: (folderPath: string) => Promise<unknown>;
    };
    if (typeof adapter.list !== "function") return false;
    try {
      const result = await adapter.list(path) as {
        files?: unknown;
        folders?: unknown;
      };
      return Array.isArray(result?.files)
        && Array.isArray(result?.folders)
        && result.files.length === 0
        && result.folders.length === 0;
    } catch {
      return false;
    }
  }

  private async deleteEmptyLocalFolder(path: string): Promise<void> {
    if (isProtectedFolderDeletePath(path, getConfigDir(this.scanner.vault))) {
      throw new Error(`Protected config folder cannot be deleted by folder sync: ${path}`);
    }
    if (!await this.isLocalFolderEmpty(path)) {
      throw new Error(`Local folder is not confirmed empty: ${path}`);
    }
    const vault = this.scanner.vault as LocalScanner["vault"] & {
      getAbstractFileByPath?: (folderPath: string) => unknown;
    };
    const folder = vault.getAbstractFileByPath?.(path);
    if (!(folder instanceof TFolder) || !this.fileManager) {
      throw new Error(`Local folder cannot be moved to trash safely: ${path}`);
    }
    await this.fileManager.trashFile(folder);
    if ((await this.inspectLocalFolder(path)).status !== "missing") {
      throw new Error(`Local folder delete read-back failed: ${path}`);
    }
  }

  private localExpectationMatches(
    expected: LocalFileEntry | undefined,
    current: LocalFileInspection,
  ): boolean {
    if (current.status === "uncertain") return false;
    if (!expected) return current.status === "missing";
    return current.status === "present"
      && Boolean(current.entry)
      && current.entry!.hash === expected.hash
      && current.entry!.size === expected.size;
  }

  /** Read-only eligibility gate used before adaptive network prefetch. */
  private async canPrefetchDownload(item: SyncPlanItem): Promise<boolean> {
    if (
      Platform.isMobile
      || item.type !== SyncActionType.Download
      || !item.remote
      || item.remote.size > ADAPTIVE_DOWNLOAD_MAX_BYTES
    ) return false;
    const current = await this.inspectLocalPath(item.path);
    return current === null || this.localExpectationMatches(item.local, current);
  }

  /** Compare the current local file with the exact version shown to the user.
   *  Legacy scanner doubles do not expose inspectFile(); production always does. */
  private async reviewedLocalVersionStillMatches(
    path: string,
    expected: LocalFileEntry | undefined,
  ): Promise<boolean> {
    const current = await this.inspectLocalPath(path);
    return current === null || this.localExpectationMatches(expected, current);
  }

  private async guardReviewedLocalVersion(
    path: string,
    expected: LocalFileEntry | undefined,
    noticeKey: "notice.conflict.failed" | "notice.delete.failed",
  ): Promise<boolean> {
    try {
      if (await this.reviewedLocalVersionStillMatches(path, expected)) return true;
    } catch (error) {
      this.diag?.warn(
        "execute",
        `local version check failed before reviewed action — ${path}`,
        error instanceof Error ? error.message : String(error),
      );
    }
    this.diag?.warn("execute", `reviewed action blocked — ${path} changed locally`);
    this.notice(noticeKey, { path, reason: this.t("notice.localChangedSinceReview") });
    return false;
  }

  private createDecisionToken(item: SyncPlanItem): SyncDecisionToken {
    const scope = this.activeSyncScope ?? this.state.remoteScope;
    if (!scope) throw new Error("Cannot bind a decision token without a complete sync scope");
    const ancestor = typeof this.state.getBaseEntry === "function"
      ? this.state.getBaseEntry(item.path)
      : this.state.baseSnapshot.find((entry) => entry.path === item.path);
    return {
      version: 1,
      vaultName: this.vaultName,
      accountId: this.state.boundAccountId ?? "",
      scope: { ...scope },
      local: item.local
        ? { exists: true, hash: item.local.hash, size: item.local.size }
        : { exists: false },
      remote: item.remote
        ? { exists: true, driveId: item.remote.driveId, eTag: item.remote.eTag }
        : { exists: false },
      ancestorHash: ancestor?.hash ?? null,
    };
  }

  private withDecisionToken(item: SyncPlanItem): SyncPlanItem {
    return { ...item, decisionToken: this.createDecisionToken(item) };
  }

  private bindPendingDecisionTokens(plan: SyncPlan): void {
      plan.items = plan.items.map((item) =>
      item.type === SyncActionType.Conflict
        || item.type === SyncActionType.ConfirmLocalDelete
        ? this.withDecisionToken(item)
        : item,
    );
  }

  private decisionTokenMatchesSnapshot(item: SyncPlanItem): boolean {
    const token = item.decisionToken;
    if (
      !isSyncDecisionToken(token)
      || token.vaultName !== this.vaultName
      || token.accountId !== (this.state.boundAccountId ?? "")
      || !sameSyncScope(token.scope, this.activeSyncScope ?? this.state.remoteScope)
    ) return false;
    if (token.local.exists !== Boolean(item.local)) return false;
    if (
      token.local.exists
      && (!item.local || token.local.hash !== item.local.hash || token.local.size !== item.local.size)
    ) return false;
    if (token.remote.exists !== Boolean(item.remote)) return false;
    if (
      token.remote.exists
      && (!item.remote || token.remote.driveId !== item.remote.driveId || token.remote.eTag !== item.remote.eTag)
    ) return false;
    const ancestor = this.state.baseSnapshot.find((entry) => entry.path === item.path);
    return token.ancestorHash === (ancestor?.hash ?? null);
  }

  private guardDecisionToken(
    item: SyncPlanItem,
    noticeKey: "notice.conflict.failed" | "notice.delete.failed",
  ): boolean {
    if (this.decisionTokenMatchesSnapshot(item)) return true;
    this.diag?.warn("execute", `reviewed action blocked — missing or stale decision token for ${item.path}`);
    this.notice(noticeKey, { path: item.path, reason: this.t("notice.decisionExpired") });
    return false;
  }

  private async inspectRemotePath(
    path: string,
    metadataReason: "downloadVersionVerify" | "other" = "other",
  ): Promise<RemoteFileEntry | undefined> {
    const current = await this.onedrive.getFileMetadata(
      this.vaultName,
      path,
      metadataReason,
    );
    if (!current) return undefined;
    return {
      path,
      driveId: current.driveId,
      parentId: current.parentId,
      downloadUrl: current.downloadUrl,
      size: current.size,
      mtime: current.mtime,
      eTag: current.eTag,
      cTag: current.cTag ?? "",
      sha256Hash: current.sha256Hash,
      quickXorHash: current.quickXorHash,
    };
  }

  private async guardReviewedRemoteVersion(
    item: SyncPlanItem,
    noticeKey: "notice.conflict.failed" | "notice.delete.failed",
    pendingKind: "conflict" | "delete",
  ): Promise<boolean> {
    const token = item.decisionToken;
    if (!token) return false;
    const path = item.remote?.path ?? item.path;
    let current: RemoteFileEntry | undefined;
    try {
      current = await this.inspectRemotePath(path);
    } catch (error) {
      this.notice(noticeKey, {
        path: item.path,
        reason: error instanceof Error ? error.message : this.t("general.unknown"),
      });
      return false;
    }
    const matches = token.remote.exists
      ? Boolean(current
        && current.driveId === token.remote.driveId
        && current.eTag === token.remote.eTag)
      : !current;
    if (matches) return true;

    const refreshed: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path: item.path,
      local: item.local,
      remote: current,
      reason: item.local && current
        ? "reason.bothSidesModified"
        : item.local
          ? "reason.remoteDeletedLocalModified"
          : "reason.localDeletedRemoteModified",
    };
    await this.state.addPendingConflict(this.withDecisionToken(refreshed));
    if (pendingKind === "delete") await this.state.removePendingDelete(item.path);
    this.notice(noticeKey, { path: item.path, reason: this.t("notice.decisionExpired") });
    return false;
  }

  private async guardDownloadLocalVersion(
    item: SyncPlanItem,
    result: SyncResult,
    operationEpoch: number,
  ): Promise<ItemExecutionResult | null> {
    const current = await this.inspectLocalPath(item.path);
    if (!current) return null;
    if (current.status === "uncertain") {
      throw new Error(`Local version could not be verified before write: ${item.path}`);
    }
    if (this.localExpectationMatches(item.local, current)) return null;

    const currentEntry = current.status === "present" ? current.entry : undefined;
    if (currentEntry && item.remote) {
      const base = this.state.baseSnapshot.find((entry) => entry.path === item.path);
      let equality = resolveContentEquality({
        local: currentEntry,
        remote: item.remote,
        base,
      });
      if (
        equality.status === "unknown"
        && Boolean(item.local)
        && currentEntry.size === item.remote.size
        && item.remote.size <= ADAPTIVE_DOWNLOAD_MAX_BYTES
      ) {
        try {
          const remoteContent = await this.onedrive.downloadFile(
            this.vaultName,
            item.path,
            item.remote.downloadUrl,
            item.remote.driveId,
            item.remote.size,
          );
          const downloaded = {
            size: remoteContent.byteLength,
            hash: await sha256Hex(remoteContent),
          };
          await this.verifyDownloadedPayload(item.path, item.remote, downloaded);
          equality = resolveContentEquality({
            local: currentEntry,
            remote: item.remote,
            base,
            downloadedHash: downloaded.hash,
          });
          this.diag?.log(
            "execute",
            `download race equality fallback ${equality.status} — ${item.path}`,
          );
        } catch (error) {
          this.diag?.warn(
            "execute",
            `download race equality fallback unavailable — ${item.path}: ${this.failureReason(error)}`,
          );
        }
      }
      if (equality.status === "equal") {
        return {
          executed: true,
          baseUpsert: StateManager.toBaseEntry(currentEntry, item.remote),
        };
      }
    }

    this.diag?.warn(
      "execute",
      `download blocked — ${item.path} local version no longer matches the scan expectation`,
    );
    return this.queuePendingConflict({
      ...item,
      type: SyncActionType.Conflict,
      local: currentEntry,
      reason: item.local
        ? current.status === "missing"
          ? "reason.localDeletedRemoteModified"
          : "reason.bothSidesModified"
        : "reason.newFileBothSides",
    }, result, operationEpoch);
  }

  private async verifyDownloadedPayload(
    path: string,
    remote: RemoteFileEntry,
    downloaded: { size: number; hash: string },
    remoteVersionAlreadyVerified = false,
  ): Promise<void> {
    if (downloaded.size !== remote.size) {
      throw new Error(`Downloaded size mismatch: ${path} (${downloaded.size} != ${remote.size})`);
    }
    if (remote.sha256Hash) {
      if (downloaded.hash !== remote.sha256Hash.toLowerCase()) {
        throw new Error(`Downloaded SHA-256 mismatch: ${path}`);
      }
      return;
    }
    if (remoteVersionAlreadyVerified) return;

    const current = await this.inspectRemotePath(path, "downloadVersionVerify");
    if (!current || current.driveId !== remote.driveId || current.eTag !== remote.eTag) {
      throw new DownloadRemoteVersionChangedError(path);
    }
  }

  private getStreamDownloadAdapter(fileSize: number): StreamDownloadAdapter | null {
    if (!Platform.isMobile || fileSize < MOBILE_STREAM_DOWNLOAD_MIN_BYTES) {
      return null;
    }
    const adapter = this.scanner.vault.adapter as StreamDownloadAdapter;
    if (typeof adapter.appendBinary !== "function" || typeof adapter.rename !== "function") {
      this.diag?.warn(
        "execute",
        `mobile streamed download unavailable — appendBinary/rename missing, fileSize=${fileSize}`,
      );
      return null;
    }
    return adapter;
  }

  private getDownloadTempPath(filePath: string): string {
    const { tmpDir } = getEasySyncPaths(this.scanner.vault);
    return `${tmpDir}/downloads/${filePath}.part`;
  }

  private getRecoveryJournal(): LocalRecoveryJournal {
    return new LocalRecoveryJournal(
      this.scanner.vault.adapter,
      getEasySyncPaths(this.scanner.vault).tmpDir,
    );
  }

  private async prepareCommunityPluginEnablementWork(
    path: string,
    selection: Readonly<PluginScopeSelection>,
    localEntries: LocalFileEntry[],
    remoteEntries: RemoteFileEntry[],
    scope: SyncScope,
  ): Promise<PreparedCommunityPluginEnablementWork> {
    const observedLocal = localEntries.find((entry) => entry.path === path);
    const observedRemote = remoteEntries.find((entry) => entry.path === path);
    const carriedOrStored =
      this.state.getCommunityPluginEnablementState(scope);
    const configDir = getConfigDir(this.scanner.vault);
    const discoveredPluginIds = [...localEntries, ...remoteEntries].flatMap(
      (entry) => {
        const managed = classifyCommunityPluginManagedPath(
          entry.path,
          configDir,
        );
        return managed?.kind === "files" ? [managed.pluginId] : [];
      },
    );
    const cachedObservation = carriedOrStored.observation;
    const cachedSource = cachedObservation?.source;
    const canReuseLocal = Boolean(
      cachedObservation
      && cachedSource?.path === path
      && (
        observedLocal
          ? cachedSource.local.exists
            && cachedSource.local.contentHash === observedLocal.hash
          : !cachedSource.local.exists
      ),
    );
    const canReuseRemote = Boolean(
      cachedObservation
      && cachedSource?.path === path
      && (
        observedRemote
          ? cachedSource.remote.exists
            && cachedSource.remote.remoteId === observedRemote.driveId
            && cachedSource.remote.eTag === observedRemote.eTag
          : !cachedSource.remote.exists
      ),
    );

    const observedLocalBytes = observedLocal && !canReuseLocal
      ? await this.readObservedCommunityPluginEnablementLocal(
          path,
          observedLocal,
        )
      : null;
    const remoteBytes = observedRemote && !canReuseRemote
      ? await this.onedrive.downloadFile(
          this.vaultName,
          path,
          observedRemote.downloadUrl,
          observedRemote.driveId,
          observedRemote.size,
        )
      : null;
    const observedRemoteHash = observedRemote
      ? canReuseRemote
        ? cachedSource?.remote.contentHash
        : remoteBytes
          ? await sha256Hex(remoteBytes)
          : undefined
      : undefined;
    if (observedRemote && !canReuseRemote && !remoteBytes) {
      throw new Error(
        "Community plugin enablement remote content is unavailable",
      );
    }
    if (observedRemote && remoteBytes && observedRemoteHash) {
      await this.verifyDownloadedPayload(path, observedRemote, {
        size: remoteBytes.byteLength,
        hash: observedRemoteHash,
      });
    }

    const observedLocalIds = canReuseLocal && cachedObservation
      ? [...cachedObservation.localPluginIds]
      : parseCommunityPluginEnablementJson(
        observedLocalBytes
          ? new TextDecoder().decode(observedLocalBytes)
          : "[]",
      );
    const observedRemoteIds = canReuseRemote && cachedObservation
      ? [...cachedObservation.remotePluginIds]
      : parseCommunityPluginEnablementJson(
        remoteBytes
          ? new TextDecoder().decode(remoteBytes)
          : "[]",
      );
    const selectedPluginIds = collectCommunityPluginIdsForEnablement(
      selection,
      [
        ...discoveredPluginIds,
        ...selection.pluginIds,
        ...observedLocalIds,
        ...observedRemoteIds,
        ...Object.keys(carriedOrStored.anchors),
      ],
      discoveredPluginIds,
    );
    const source: CommunityPluginEnablementSourceV2 = {
      path,
      selectedPluginIds: [...selectedPluginIds],
      local: observedLocal
        ? {
            exists: true,
            contentHash: observedLocal.hash,
          }
        : { exists: false },
      remote: observedRemote && observedRemoteHash
        ? {
            exists: true,
            contentHash: observedRemoteHash,
            remoteId: observedRemote.driveId,
            eTag: observedRemote.eTag,
          }
        : { exists: false },
    };
    const observation: CommunityPluginEnablementCommittedObservationV1 = {
      version: 1,
      source: {
        ...source,
        selectedPluginIds: [...source.selectedPluginIds],
        local: { ...source.local },
        remote: { ...source.remote },
      },
      localPluginIds: [...observedLocalIds],
      remotePluginIds: [...observedRemoteIds],
    };
    const sourceAwareState = this.state as StateManager & {
      getCommunityPluginEnablementStateForMigrationSource?:
        StateManager["getCommunityPluginEnablementStateForMigrationSource"];
    };
    const current =
      typeof sourceAwareState
        .getCommunityPluginEnablementStateForMigrationSource === "function"
        ? sourceAwareState.getCommunityPluginEnablementStateForMigrationSource(
            scope,
            source,
          )
        : carriedOrStored;
    const prepared = prepareCommunityPluginEnablementFromObservations(
      { exists: observedLocal !== undefined, pluginIds: observedLocalIds },
      { exists: observedRemote !== undefined, pluginIds: observedRemoteIds },
      selectedPluginIds,
      current.anchors,
      current.pending,
    );
    const resolved = current.pending.flatMap((item) =>
      typeof item.resolvedEnabled === "boolean"
        ? [{ ...item, resolvedEnabled: item.resolvedEnabled }]
        : []
    );
    const carrierAnchors = { ...prepared.anchors };
    for (const item of resolved) delete carrierAnchors[item.pluginId];
    return {
      path,
      selectedPluginIds: [...selectedPluginIds],
      observedLocal,
      observedLocalIds,
      observedRemote,
      observedRemoteIds,
      observation,
      prepared,
      migrationCarrier: {
        version: 1,
        scope: { ...scope },
        source,
        anchors: carrierAnchors,
        pending: prepared.pending.map((item) => ({ ...item })),
        resolved,
      },
    };
  }

  private async applyCommunityPluginEnablementWork(
    work: PreparedCommunityPluginEnablementWork,
    scope: SyncScope,
    result: SyncResult,
    callbacks: SyncCallbacks,
    operationEpoch: number,
  ): Promise<void> {
    await this.assertCommunityPluginEnablementBundlesReady(work);
    if (!this.canContinue(operationEpoch, result)) return;
    const actionCount = Number(work.prepared.remoteChanged)
      + Number(work.prepared.localChanged);
    const baseTotal = this.progressStore?.state.total ?? 0;
    const visibleTotal = baseTotal + actionCount;
    let visibleCurrent = baseTotal;
    const beginVisibleAction = (actionType: SyncActionType): void => {
      visibleCurrent++;
      this.progressStore?.setProgress(
        visibleCurrent,
        visibleTotal,
        work.path,
        actionType,
      );
      callbacks.onProgress?.(visibleCurrent, visibleTotal, work.path);
    };

    if (work.prepared.remoteChanged) {
      await this.assertCommunityPluginEnablementLocalUnchanged(work);
      if (!this.canContinue(operationEpoch, result)) return;
      const content = serializeCommunityPluginEnablementJson(
        work.prepared.remote,
      );
      if (!this.canContinue(operationEpoch, result)) return;
      beginVisibleAction(SyncActionType.Upload);
      const uploadResult = await this.onedrive.uploadFile(
        this.vaultName,
        work.path,
        content,
        callbacks.onFileProgress,
        work.observedRemote?.eTag,
        work.observedRemote?.driveId,
      );
      if (!this.canContinue(operationEpoch, result)) return;
      const hash = await sha256Hex(content);
      if (!this.canContinue(operationEpoch, result)) return;
      const uploaded = this.toUploadedRemoteEntry(
        work.path,
        {
          path: work.path,
          size: content.byteLength,
          mtime: Date.now(),
          hash,
          binary: false,
        },
        uploadResult,
        work.observedRemote?.parentId,
      );
      await this.state.applyRemoteMutations([uploaded], []);
      if (!this.canContinue(operationEpoch, result)) return;
      work.observedRemote = uploaded;
      work.observedRemoteIds = [...work.prepared.remote];
      work.observation.source.remote = {
        exists: true,
        contentHash: hash,
        remoteId: uploaded.driveId,
        eTag: uploaded.eTag,
      };
      work.observation.remotePluginIds = [...work.prepared.remote];
      result.uploaded++;
      callbacks.onFileComplete?.(
        work.path,
        SyncActionType.Upload,
        true,
        undefined,
        content.byteLength,
      );
    }

    if (work.prepared.localChanged) {
      const content = serializeCommunityPluginEnablementJson(
        work.prepared.local,
      );
      beginVisibleAction(SyncActionType.Download);
      if (!await this.commitCommunityPluginEnablementLocal(
        work,
        content,
        result,
        operationEpoch,
      )) return;
      work.observation.source.local = {
        exists: true,
        contentHash: await sha256Hex(content),
      };
      work.observation.localPluginIds = [...work.prepared.local];
      result.downloaded++;
      callbacks.onFileComplete?.(
        work.path,
        SyncActionType.Download,
        true,
        undefined,
        content.byteLength,
      );
    }

    if (!this.canContinue(operationEpoch, result)) return;
    await this.state.setCommunityPluginEnablementState({
      version: 1,
      scope,
      anchors: work.prepared.anchors,
      pending: [],
      observation: work.observation,
    });
    if (!this.canContinue(operationEpoch, result)) return;
    this.diag?.log(
      "execute",
      "community plugin enablement structured sync committed",
      {
        selected: work.selectedPluginIds.length,
        anchors: Object.keys(work.prepared.anchors).length,
        localChanged: work.prepared.localChanged,
        remoteChanged: work.prepared.remoteChanged,
      },
    );
  }

  private async readObservedCommunityPluginEnablementLocal(
    path: string,
    expected: LocalFileEntry,
  ): Promise<ArrayBuffer> {
    const content = await this.scanner.vault.adapter.readBinary(path);
    if (
      content.byteLength !== expected.size
      || await sha256Hex(content) !== expected.hash
    ) {
      throw new CommunityPluginEnablementVersionChangedError("local");
    }
    return content;
  }

  private async assertCommunityPluginEnablementLocalUnchanged(
    work: PreparedCommunityPluginEnablementWork,
  ): Promise<void> {
    const adapter = this.scanner.vault.adapter;
    if (!work.observedLocal) {
      if (await adapter.stat(work.path)) {
        throw new CommunityPluginEnablementVersionChangedError("local");
      }
      return;
    }
    await this.readObservedCommunityPluginEnablementLocal(
      work.path,
      work.observedLocal,
    );
  }

  private async commitCommunityPluginEnablementLocal(
    work: PreparedCommunityPluginEnablementWork,
    content: ArrayBuffer,
    result: SyncResult,
    operationEpoch: number,
  ): Promise<boolean> {
    await this.assertCommunityPluginEnablementLocalUnchanged(work);
    if (!this.canContinue(operationEpoch, result)) return false;
    const adapter = this.scanner.vault.adapter;
    const expected = work.observedLocal;
    const original = expected
      ? await this.readObservedCommunityPluginEnablementLocal(work.path, expected)
      : null;
    if (!this.canContinue(operationEpoch, result)) return false;
    const downloaded = {
      size: content.byteLength,
      hash: await sha256Hex(content),
    };
    if (!this.canContinue(operationEpoch, result)) return false;
    const journal = this.getRecoveryJournal();
    await journal.prepareCopiedOriginal(
      work.path,
      expected,
      original,
      downloaded,
    );
    if (!this.canContinue(operationEpoch, result)) return false;
    try {
      await this.assertCommunityPluginEnablementLocalUnchanged(work);
      if (!this.canContinue(operationEpoch, result)) return false;
      await adapter.writeBinary(work.path, content);
      if (!this.canContinue(operationEpoch, result)) return false;
      const committed = await adapter.readBinary(work.path);
      if (!this.canContinue(operationEpoch, result)) return false;
      if (
        committed.byteLength !== downloaded.size
        || await sha256Hex(committed) !== downloaded.hash
      ) {
        throw new Error("Community plugin enablement local verification failed");
      }
      if (!this.canContinue(operationEpoch, result)) return false;
      await journal.complete();
      return this.canContinue(operationEpoch, result);
    } catch (error) {
      await journal.recover();
      throw error;
    }
  }

  private async assertCommunityPluginEnablementBundlesReady(
    work: PreparedCommunityPluginEnablementWork,
  ): Promise<void> {
    const localBefore = new Set(work.observedLocalIds);
    const remoteBefore = new Set(work.observedRemoteIds);
    const localAfter = new Set(work.prepared.local);
    const remoteAfter = new Set(work.prepared.remote);
    const localToEnable = work.selectedPluginIds.filter(
      (pluginId) => !localBefore.has(pluginId) && localAfter.has(pluginId),
    );
    const remoteToEnable = work.selectedPluginIds.filter(
      (pluginId) => !remoteBefore.has(pluginId) && remoteAfter.has(pluginId),
    );
    const configDir = getConfigDir(this.scanner.vault);
    const adapter = this.scanner.vault.adapter;

    for (const pluginId of localToEnable) {
      const root = `${configDir}/plugins/${pluginId}`;
      if (
        !await adapter.exists(`${root}/main.js`)
        || !await adapter.exists(`${root}/manifest.json`)
      ) {
        throw new Error(`Selected plugin bundle is incomplete locally: ${pluginId}`);
      }
      let manifest;
      try {
        manifest = parseCommunityPluginBundleManifest(
          await adapter.read(`${root}/manifest.json`),
          pluginId,
        );
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? `${error.message} (local)`
            : `Selected plugin manifest is unreadable locally: ${pluginId}`,
        );
      }
      const incompatibility = assessCommunityPluginManifestCompatibility(
        manifest,
        {
          localVersion: null,
          isMobile: Platform.isMobile,
          apiVersionSupported: manifest.minAppVersion
            ? requireApiVersion(manifest.minAppVersion)
            : true,
        },
      );
      if (incompatibility) {
        throw new Error(
          `Selected plugin cannot be enabled locally (${incompatibility}): ${pluginId}`,
        );
      }
    }

    const remotePaths = new Set(
      this.state.remoteSnapshot.map((entry) => entry.path),
    );
    for (const pluginId of remoteToEnable) {
      const root = `${configDir}/plugins/${pluginId}`;
      if (
        !remotePaths.has(`${root}/main.js`)
        || !remotePaths.has(`${root}/manifest.json`)
      ) {
        throw new Error(`Selected plugin bundle is incomplete remotely: ${pluginId}`);
      }
    }
  }

  /**
   * A selected remote bundle must pass mobile compatibility checks before it
   * can enter the canonical plan. The verified manifest bytes are reused by
   * bundle staging and retained as disposable, source-bound name evidence.
   * Never download a manifest solely to improve inventory presentation.
   */
  private async prepareMobileCommunityPluginManifestEvidence(input: {
    policy: Readonly<CommunityPluginSyncPolicyV1>;
    configDir: string;
    localEntries: readonly LocalFileEntry[];
    remoteEntries: readonly RemoteFileEntry[];
    scope: Readonly<SyncScope>;
    result: SyncResult;
    operationEpoch: number;
    joiningPluginIds?: readonly string[];
  }): Promise<{
    desktopOnlyPluginIds: string[];
    incompatiblePluginIds: string[];
    observations: CommunityPluginManifestObservationV1[];
  }> {
    this.mobileDesktopOnlyPluginIds.clear();
    this.mobileCommunityPluginPreparedManifests.clear();
    if (!Platform.isMobile || input.policy.files.mode === "none") {
      return {
        desktopOnlyPluginIds: [],
        incompatiblePluginIds: [],
        observations: [],
      };
    }

    const startedAt = Date.now();
    const localPaths = new Set(input.localEntries.map((entry) => entry.path));
    const remoteBundles = new Map<string, {
      main?: RemoteFileEntry;
      manifest?: RemoteFileEntry;
    }>();
    for (const remote of input.remoteEntries) {
      const parsed = parseCommunityPluginBundlePath(
        remote.path,
        input.configDir,
      );
      if (
        !parsed
        || parsed.pluginId === "easy-sync"
        || !isPluginSelected(input.policy.files, parsed.pluginId)
      ) {
        continue;
      }
      const bundle = remoteBundles.get(parsed.pluginId) ?? {};
      if (parsed.fileName === "main.js") bundle.main = remote;
      else if (parsed.fileName === "manifest.json") bundle.manifest = remote;
      remoteBundles.set(parsed.pluginId, bundle);
    }

    const candidates: Array<{
      pluginId: string;
      manifest: RemoteFileEntry;
    }> = [];
    for (const [pluginId, bundle] of remoteBundles) {
      if (!bundle.main || !bundle.manifest) continue;
      const root = `${input.configDir.replace(/\/+$/, "")}/plugins/${pluginId}`;
      if (
        localPaths.has(`${root}/manifest.json`)
        && localPaths.has(`${root}/main.js`)
      ) continue;
      candidates.push({
        pluginId,
        manifest: bundle.manifest,
      });
    }

    const stored = this.state.getCommunityPluginManifestObservations();
    const observationsByPlugin = new Map<
      string,
      CommunityPluginManifestObservationV1
    >();
    const misses: typeof candidates = [];
    let cacheHits = 0;
    for (const candidate of candidates) {
      const cached = stored.find((observation) =>
        observation.pluginId === candidate.pluginId
        && communityPluginManifestObservationMatchesRemote(
          observation,
          input.scope,
          candidate.manifest,
        ));
      if (cached) {
        cacheHits++;
        observationsByPlugin.set(candidate.pluginId, cached);
      } else {
        misses.push(candidate);
      }
    }

    let nextMissIndex = 0;
    let activeManifestReads = 0;
    let peakManifestReads = 0;
    let manifestReads = 0;
    const workerCount = Math.min(
      MOBILE_PLUGIN_MANIFEST_PREFLIGHT_CONCURRENCY,
      misses.length,
    );
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextMissIndex++;
        const candidate = misses[index];
        if (!candidate) return;
        manifestReads++;
        activeManifestReads++;
        peakManifestReads = Math.max(peakManifestReads, activeManifestReads);
        try {
          const content = await this.onedrive.downloadFile(
            this.vaultName,
            candidate.manifest.path,
            candidate.manifest.downloadUrl,
            candidate.manifest.driveId,
            candidate.manifest.size,
          );
          const downloaded = {
            size: content.byteLength,
            hash: await sha256Hex(content),
          };
          await this.verifyDownloadedPayload(
            candidate.manifest.path,
            candidate.manifest,
            downloaded,
          );
          const observation = await createCommunityPluginManifestObservation(
            input.scope,
            candidate.pluginId,
            candidate.manifest,
            content,
          );
          observationsByPlugin.set(candidate.pluginId, observation);
          this.mobileCommunityPluginPreparedManifests.set(
            candidate.manifest.path,
            {
              sourceKey: communityPluginManifestRemoteSourceKey(
                input.scope,
                candidate.manifest,
              ),
              prepared: { content, downloaded },
            },
          );
        } finally {
          activeManifestReads = Math.max(0, activeManifestReads - 1);
        }
      }
    });
    const settled = await Promise.allSettled(workers);
    this.diag?.log(
      "execute",
      "mobile community plugin manifest participation preflight",
      {
        schemaVersion: 1,
        candidates: candidates.length,
        cacheHits,
        manifestReads,
        concurrencyLimit: MOBILE_PLUGIN_MANIFEST_PREFLIGHT_CONCURRENCY,
        peakConcurrency: peakManifestReads,
        elapsedMs: Date.now() - startedAt,
      },
    );
    const failed = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (failed) throw failed.reason;
    if (!this.canContinue(input.operationEpoch, input.result)) {
      return {
        desktopOnlyPluginIds: [],
        incompatiblePluginIds: [],
        observations: [],
      };
    }

    const observations = candidates
      .map((candidate) => observationsByPlugin.get(candidate.pluginId))
      .filter(
        (item): item is CommunityPluginManifestObservationV1 =>
          item !== undefined,
      )
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    const desktopOnlyPluginIds: string[] = [];
    const incompatiblePluginIds: string[] = [];
    const joiningPluginIds = new Set(
      input.joiningPluginIds ?? [],
    );
    for (const candidate of candidates) {
      const observation = observationsByPlugin.get(candidate.pluginId);
      if (!observation) {
        throw new Error(
          `Selected plugin manifest observation is missing: ${candidate.pluginId}`,
        );
      }
      const manifest = parseCommunityPluginBundleManifest(
        observation.manifestText,
        candidate.pluginId,
      );
      const incompatibility = assessCommunityPluginManifestCompatibility(
        manifest,
        {
          localVersion: null,
          isMobile: true,
          apiVersionSupported: manifest.minAppVersion
            ? requireApiVersion(manifest.minAppVersion)
            : true,
        },
      );
      if (incompatibility === "desktop-only") {
        desktopOnlyPluginIds.push(candidate.pluginId);
        if (joiningPluginIds.has(candidate.pluginId)) {
          incompatiblePluginIds.push(candidate.pluginId);
        }
      } else if (incompatibility) {
        if (joiningPluginIds.has(candidate.pluginId)) {
          incompatiblePluginIds.push(candidate.pluginId);
          continue;
        }
        throw new Error(
          `Selected plugin bundle is incompatible (${incompatibility}): ${candidate.pluginId}`,
        );
      }
    }
    const sorted = desktopOnlyPluginIds.sort((left, right) =>
      left.localeCompare(right));
    this.mobileDesktopOnlyPluginIds = new Set(sorted);
    return {
      desktopOnlyPluginIds: sorted,
      incompatiblePluginIds: [...new Set(incompatiblePluginIds)].sort(
        (left, right) => left.localeCompare(right),
      ),
      observations,
    };
  }

  private async persistCommunityPluginManifestObservations(
    observations: readonly CommunityPluginManifestObservationV1[],
  ): Promise<void> {
    try {
      await this.state.setCommunityPluginManifestObservations(observations);
    } catch (error) {
      this.diag?.warn(
        "state",
        "community plugin manifest observations were not persisted",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /**
   * Stage every changed file for each selected community-plugin bundle before
   * the first target write. This cannot make several filesystem replacements
   * atomic, but it guarantees a network, hash, manifest, downgrade, or host
   * compatibility failure leaves the whole plugin bundle untouched.
   */
  private async prepareCommunityPluginBundleDownloads(
    downloads: readonly SyncPlanItem[],
    policy: Readonly<CommunityPluginSyncPolicyV1>,
    metrics: ExecutionMetrics,
    result: SyncResult,
    operationEpoch: number,
    onBundleProgress?: (
      root: string,
      downloaded: number,
      total: number,
    ) => void,
  ): Promise<Map<string, PreparedDownload>> {
    const preparedByPath = new Map<string, PreparedDownload>();
    if (policy.files.mode === "none") return preparedByPath;

    const configDir = getConfigDir(this.scanner.vault);
    const groups = new Map<string, SyncPlanItem[]>();
    for (const item of downloads) {
      if (item.type !== SyncActionType.Download || !item.remote) continue;
      const parsed = parseCommunityPluginBundlePath(item.path, configDir);
      if (!parsed || !isPluginSelected(policy.files, parsed.pluginId)) continue;
      const group = groups.get(parsed.pluginId) ?? [];
      group.push(item);
      groups.set(parsed.pluginId, group);
    }
    if (groups.size === 0) return preparedByPath;

    const remoteByPath = new Map(
      this.state.remoteSnapshot.map((entry) => [entry.path, entry]),
    );
    const transferMetrics = metrics.fileTransfers.download;
    const adapter = this.scanner.vault.adapter;

    const stageRemote = async (
      path: string,
      remote: RemoteFileEntry,
      countAsPlanTransfer: boolean,
      onProgress?: (downloaded: number, total: number) => void,
    ): Promise<PreparedDownload> => {
      if (countAsPlanTransfer) {
        transferMetrics.activeConcurrency++;
        transferMetrics.peakConcurrency = Math.max(
          transferMetrics.peakConcurrency,
          transferMetrics.activeConcurrency,
        );
      }
      try {
        const preflightPrepared =
          this.mobileCommunityPluginPreparedManifests.get(path);
        if (
          preflightPrepared
          && this.activeSyncScope
          && preflightPrepared.sourceKey
            === communityPluginManifestRemoteSourceKey(
              this.activeSyncScope,
              remote,
            )
        ) {
          this.mobileCommunityPluginPreparedManifests.delete(path);
          onProgress?.(remote.size, remote.size);
          return preflightPrepared.prepared;
        }
        const transferStartedAt = Date.now();
        let content: ArrayBuffer;
        try {
          content = await this.onedrive.downloadFile(
            this.vaultName,
            path,
            remote.downloadUrl,
            remote.driveId,
            remote.size,
            onProgress,
          );
        } finally {
          if (countAsPlanTransfer) {
            transferMetrics.stagesMs.contentTransfer +=
              Date.now() - transferStartedAt;
          }
        }
        const hashStartedAt = Date.now();
        const downloaded = {
          size: content.byteLength,
          hash: await sha256Hex(content),
        };
        if (countAsPlanTransfer) {
          transferMetrics.stagesMs.contentHash += Date.now() - hashStartedAt;
        }
        const verifyStartedAt = Date.now();
        try {
          await this.verifyDownloadedPayload(path, remote, downloaded);
        } finally {
          if (countAsPlanTransfer) {
            transferMetrics.stagesMs.remoteVersionVerify +=
              Date.now() - verifyStartedAt;
          }
        }
        return { content, downloaded };
      } finally {
        if (countAsPlanTransfer) {
          transferMetrics.activeConcurrency = Math.max(
            0,
            transferMetrics.activeConcurrency - 1,
          );
        }
      }
    };

    for (const [pluginId, items] of groups) {
      const root = `${configDir}/plugins/${pluginId}`;
      const mainPath = `${root}/main.js`;
      const manifestPath = `${root}/manifest.json`;
      const downloadedByPath = new Map<string, number>();
      const totalByPath = new Map(
        items.map((item) => [item.path, item.remote?.size ?? 0]),
      );
      const reportFileProgress = (
        path: string,
        downloaded: number,
        total: number,
      ): void => {
        const reportedDownloaded = Number.isFinite(downloaded)
          ? Math.max(0, downloaded)
          : 0;
        const reportedTotal = Number.isFinite(total)
          ? Math.max(0, total)
          : 0;
        downloadedByPath.set(
          path,
          Math.max(downloadedByPath.get(path) ?? 0, reportedDownloaded),
        );
        totalByPath.set(
          path,
          Math.max(
            totalByPath.get(path) ?? 0,
            reportedTotal,
            reportedDownloaded,
          ),
        );
        onBundleProgress?.(
          root,
          [...downloadedByPath.values()].reduce(
            (sum, value) => sum + value,
            0,
          ),
          [...totalByPath.values()].reduce(
            (sum, value) => sum + value,
            0,
          ),
        );
      };
      let groupPrepared: Array<[SyncPlanItem, PreparedDownload]> = [];
      transferMetrics.started += items.length;
      try {
        const remoteMain = remoteByPath.get(mainPath);
        const remoteManifest = remoteByPath.get(manifestPath);
        if (!remoteMain || !remoteManifest) {
          throw new Error(`Selected plugin bundle is incomplete remotely: ${pluginId}`);
        }

        groupPrepared = await Promise.all(items.map(
          async (item): Promise<[SyncPlanItem, PreparedDownload]> => {
            try {
              return [
                item,
                await stageRemote(
                  item.path,
                  item.remote!,
                  true,
                  (downloaded, total) =>
                    reportFileProgress(item.path, downloaded, total),
                ),
              ];
            } catch (error) {
              return [item, { error }];
            }
          },
        ));
        const failedPreparation = groupPrepared.find(
          ([, prepared]) => prepared.error !== undefined,
        )?.[1];
        if (failedPreparation?.error !== undefined) {
          throw failedPreparation.error;
        }
        if (!this.canContinue(operationEpoch, result)) {
          transferMetrics.cancelled += items.length;
          return preparedByPath;
        }

        const plannedManifest = groupPrepared.find(
          ([item]) => item.path === manifestPath,
        )?.[1];
        const manifestPrepared = plannedManifest
          ?? await stageRemote(
            manifestPath,
            remoteManifest,
            false,
            (downloaded, total) =>
              reportFileProgress(manifestPath, downloaded, total),
          );
        if (!manifestPrepared.content) {
          throw new Error(`Selected plugin manifest download failed: ${pluginId}`);
        }
        const manifest = parseCommunityPluginBundleManifest(
          new TextDecoder().decode(manifestPrepared.content),
          pluginId,
        );

        let localVersion: string | null = null;
        if (await adapter.exists(manifestPath)) {
          localVersion = parseCommunityPluginBundleManifest(
            await adapter.read(manifestPath),
            pluginId,
          ).version;
        }
        const incompatibility = assessCommunityPluginManifestCompatibility(
          manifest,
          {
            localVersion,
            isMobile: Platform.isMobile,
            apiVersionSupported: manifest.minAppVersion
              ? requireApiVersion(manifest.minAppVersion)
              : true,
          },
        );
        if (incompatibility) {
          throw new Error(
            `Selected plugin bundle is incompatible (${incompatibility}): ${pluginId}`,
          );
        }
        for (const [item, prepared] of groupPrepared) {
          preparedByPath.set(item.path, prepared);
        }
        this.diag?.log("execute", "selected plugin bundle preflight passed", {
          schemaVersion: 1,
          files: items.length,
          hasStyles: remoteByPath.has(`${root}/styles.css`),
        });
      } catch (error) {
        for (const item of items) {
          preparedByPath.set(item.path, { error });
        }
        this.diag?.warn(
          "execute",
          "selected plugin bundle preflight blocked local writes",
          {
            schemaVersion: 1,
            files: items.length,
            reason: this.failureReason(error),
          },
        );
      }
    }
    return preparedByPath;
  }

  /** Validate selected plugin upload sources and prevent remote downgrades. */
  private async prepareCommunityPluginBundleUploads(
    uploads: readonly SyncPlanItem[],
    policy: Readonly<CommunityPluginSyncPolicyV1>,
    result: SyncResult,
    operationEpoch: number,
  ): Promise<Map<string, unknown>> {
    const errorsByPath = new Map<string, unknown>();
    if (policy.files.mode === "none") return errorsByPath;

    const configDir = getConfigDir(this.scanner.vault);
    const groups = new Map<string, SyncPlanItem[]>();
    for (const item of uploads) {
      if (item.type !== SyncActionType.Upload || !item.local) continue;
      const parsed = parseCommunityPluginBundlePath(item.path, configDir);
      if (!parsed || !isPluginSelected(policy.files, parsed.pluginId)) continue;
      const group = groups.get(parsed.pluginId) ?? [];
      group.push(item);
      groups.set(parsed.pluginId, group);
    }
    if (groups.size === 0) return errorsByPath;

    const adapter = this.scanner.vault.adapter;
    const remoteByPath = new Map(
      this.state.remoteSnapshot.map((entry) => [entry.path, entry]),
    );
    for (const [pluginId, items] of groups) {
      const root = `${configDir}/plugins/${pluginId}`;
      const mainPath = `${root}/main.js`;
      const manifestPath = `${root}/manifest.json`;
      try {
        if (
          !await adapter.exists(mainPath)
          || !await adapter.exists(manifestPath)
        ) {
          throw new Error(`Selected plugin bundle is incomplete locally: ${pluginId}`);
        }
        const localManifest = parseCommunityPluginBundleManifest(
          await adapter.read(manifestPath),
          pluginId,
        );
        const remoteManifestEntry = remoteByPath.get(manifestPath);
        if (remoteManifestEntry) {
          const remotePrepared = await this.onedrive.downloadFile(
            this.vaultName,
            manifestPath,
            remoteManifestEntry.downloadUrl,
            remoteManifestEntry.driveId,
            remoteManifestEntry.size,
          );
          await this.verifyDownloadedPayload(
            manifestPath,
            remoteManifestEntry,
            {
              size: remotePrepared.byteLength,
              hash: await sha256Hex(remotePrepared),
            },
          );
          const remoteManifest = parseCommunityPluginBundleManifest(
            new TextDecoder().decode(remotePrepared),
            pluginId,
          );
          if (localManifest.version !== remoteManifest.version) {
            const comparison = compareCommunityPluginVersions(
              localManifest.version,
              remoteManifest.version,
            );
            if (comparison === null) {
              this.diag?.log(
                "execute",
                "selected plugin raw versions are not both SemVer; automatic downgrade judgment was skipped",
                {
                  schemaVersion: 1,
                  files: items.length,
                },
              );
            }
            if (comparison !== null && comparison < 0) {
              throw new Error(
                `Selected plugin upload would downgrade remote bundle: ${pluginId}`,
              );
            }
          }
        }
        if (!this.canContinue(operationEpoch, result)) return errorsByPath;
        this.diag?.log("execute", "selected plugin upload preflight passed", {
          schemaVersion: 1,
          files: items.length,
        });
      } catch (error) {
        for (const item of items) errorsByPath.set(item.path, error);
        this.diag?.warn(
          "execute",
          "selected plugin upload preflight blocked remote writes",
          {
            schemaVersion: 1,
            files: items.length,
            reason: this.failureReason(error),
          },
        );
      }
    }
    return errorsByPath;
  }

  private getMergeReadyStore(): MergeReadyStore {
    return new MergeReadyStore(
      this.scanner.vault.adapter,
      getEasySyncPaths(this.scanner.vault).tmpDir,
    );
  }

  private async removePathIfExists(path: string): Promise<void> {
    try { await this.scanner.vault.adapter.remove(path); } catch { /* noop */ }
  }

  /**
   * Android device-storage vaults can occasionally create a new adapter file
   * as zero bytes even though writeBinary() resolved. Keep that empty temp file
   * in place so a bounded retry overwrites an existing file. Every other error
   * and the final exact byte/hash decision stay with the existing commit gate.
   */
  private async writeBinaryTempFileWithAndroidZeroByteRetry(
    targetPath: string,
    tempPath: string,
    content: ArrayBuffer,
  ): Promise<void> {
    const adapter = this.scanner.vault.adapter;
    const maxAttempts = Platform.isAndroidApp && content.byteLength > 0
      ? ANDROID_TEMP_WRITE_MAX_ATTEMPTS
      : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await adapter.writeBinary(tempPath, content);
      if (maxAttempts === 1) return;
      const stat = await adapter.stat(tempPath);
      if (stat?.size !== 0) return;

      const willRetry = attempt < maxAttempts;
      this.diag?.warn(
        "execute",
        willRetry
          ? `Android created an empty temp file for ${targetPath}; rewriting the existing file (${attempt + 1}/${maxAttempts})`
          : `Android temp file remained empty for ${targetPath}; retry budget exhausted`,
        {
          attempt,
          maxAttempts,
          expectedSize: content.byteLength,
          observedSize: 0,
          failureKind: "zero-byte-create",
        },
      );
    }
  }

  private async commitDownloadedTempFile(
    adapter: StreamDownloadAdapter,
    targetPath: string,
    tempPath: string,
    expected: LocalFileEntry | undefined,
    downloaded: { size: number; hash: string },
  ): Promise<{ size: number; mtime?: number } | null> {
    const recoveryPath = `${targetPath}.easy-sync-recovery`;
    const existing = await adapter.stat(targetPath);
    if (expected) {
      if (!existing) {
        await this.removePathIfExists(tempPath);
        throw new LocalCommitPreconditionError(`Local file disappeared before replacement: ${targetPath}`);
      }
      const currentBytes = await adapter.readBinary(targetPath);
      if (currentBytes.byteLength !== expected.size || await sha256Hex(currentBytes) !== expected.hash) {
        await this.removePathIfExists(tempPath);
        throw new LocalCommitPreconditionError(`Local file changed before replacement: ${targetPath}`);
      }
    } else if (existing) {
      await this.removePathIfExists(tempPath);
      throw new LocalCommitPreconditionError(`Local file appeared before replacement: ${targetPath}`);
    }

    const tempStat = await adapter.stat(tempPath);
    if (!tempStat || tempStat.size !== downloaded.size) {
      await this.removePathIfExists(tempPath);
      throw new Error(`Downloaded temp file verification failed: ${targetPath}`);
    }
    const tempBytes = await adapter.readBinary(tempPath);
    if (
      tempBytes.byteLength !== downloaded.size
      || await sha256Hex(tempBytes) !== downloaded.hash
    ) {
      await this.removePathIfExists(tempPath);
      throw new Error(`Downloaded temp file verification failed: ${targetPath}`);
    }

    const journal = this.getRecoveryJournal();
    await this.removePathIfExists(recoveryPath);
    await journal.prepareRenamedOriginal(
      targetPath,
      expected,
      recoveryPath,
      downloaded,
    );
    try {
      if (existing) await adapter.rename(targetPath, recoveryPath);
      await adapter.rename(tempPath, targetPath);
      const stat = await adapter.stat(targetPath);
      if (!stat || stat.size !== downloaded.size) {
        throw new Error(`Downloaded target verification failed: ${targetPath}`);
      }
      await journal.complete();
      return stat ? { size: stat.size, mtime: stat.mtime } : null;
    } catch (error) {
      await journal.recover();
      await this.removePathIfExists(tempPath);
      throw error;
    }
  }

  /**
   * Execute a sync round.
   *
   * @param mode  "first" for initial sync, "manual" or "auto" for subsequent
   * @param callbacks  UI callbacks for progress and confirmations
   * @param skipConfirmation  skip threshold/first-sync checks (user confirmed from sidebar)
   */
  async run(
    mode: SyncMode,
    callbacks: SyncCallbacks = {},
    skipConfirmation = false,
    reviewedAuthorization?: PlanReviewAuthorization,
    options: SyncRunOptions = {},
  ): Promise<SyncResult> {
    if (this.running || this.sideActionRunning || this.queuedSideActionPaths.size > 0) {
      return { success: false, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferred: 0, skippedLarge: 0, skippedIgnored: 0, errors: 0, authExpired: false, message: this.t("result.alreadyRunning") };
    }
    if (
      this.state.legacyAutoSyncAllowed === false
      && !this.state.isV2StateActive
      && !this.state.hasV2StateLoadRecoveryBlock
    ) {
      return { success: false, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferred: 0, skippedLarge: 0, skippedIgnored: 0, errors: 1, authExpired: false, message: this.t("result.legacyStateDisabled") };
    }
    if (options.recoveryOnly === true && !this.state.isV2StateActive) {
      return {
        success: false,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
        skippedLarge: 0,
        skippedIgnored: 0,
        errors: 1,
        authExpired: false,
        message: this.t("result.v2RecoveryBlocked"),
      };
    }

    this.running = true;
    this.cancelled = false;
    this.remoteRecoveryPreviewRequired = false;
    this.localVersionRecoveredDuringLedger = false;
    this.completeRemoteItems = null;
    this.cancelController = new AbortController();
    const operationEpoch = this.lifecycle.capture();
    const automaticHandlingPolicy = { ...this.automaticHandlingPolicy };
    let communityPluginSyncPolicy = cloneCommunityPluginSyncPolicy(
      this.communityPluginSyncPolicy,
    );
    const automaticHandlingMetrics = createAutomaticHandlingMetrics(
      automaticHandlingPolicy,
    );
    const reviewedActivationRequested =
      reviewedAuthorization?.reviewKind !== undefined;
    const prepareV2MigrationCandidate =
      this.state.legacyAutoSyncAllowed
      && !this.state.isV2StateActive;
    const public113MigrationInput = prepareV2MigrationCandidate
      ? await this.state.readPublic113MigrationInput()
      : null;
    const public113MigrationEvidence = Boolean(
      public113MigrationInput
      && this.state.hasPublic113MigrationEvidence(public113MigrationInput),
    );
    let activationReviewKind: V2ActivationReviewKind | null =
      prepareV2MigrationCandidate && public113MigrationEvidence
        ? "v2-migration"
        : null;
    const takeOverPublic113MutationLedger =
      prepareV2MigrationCandidate
      && public113MigrationEvidence
      && this.state.mutationLedger.length > 0;
    const attemptV2Activation =
      prepareV2MigrationCandidate
      && options.readOnlyPreview !== true;
    const resumeCommittedV2Migration =
      reviewedActivationRequested
      && options.readOnlyPreview !== true
      && this.state.isV2StateActive
      && this.state.activeV2MigrationHold !== null;
    const recoveryOnly =
      options.recoveryOnly === true
      && this.state.isV2StateActive
      && !prepareV2MigrationCandidate;
    const recoveryRecordsAtStart = recoveryOnly
      ? this.state.mutationLedger.length
      : 0;
    let migrationAuthorityCommittedThisRun = false;
    let migrationExecutionHold: MigrationHoldV2 | null = null;
    this.startGeneration = this.state.remoteGeneration;
    this.onedrive.resetDownloadStrategy();
    this.onedrive.setAbortSignal(this.cancelController.signal);
    const collectNetworkMetrics = this.diag?.isEnabled?.("onedrive") === true;
    if (collectNetworkMetrics) this.onedrive.beginRunMetrics();

    const result: SyncResult = {
      success: false,
      uploaded: 0,
      downloaded: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      filesMoved: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      skippedLarge: 0,
      skippedIgnored: 0,
      errors: 0,
      authExpired: false,
      message: "",
    };
    const runStartedAt = Date.now();
    const phasesMs: SyncRunPhaseDurations = {
      recovery: 0,
      scan: 0,
      remotePrepare: 0,
      baseline: 0,
      remoteChanges: 0,
      planning: 0,
      reviewWait: 0,
      transfer: 0,
      commit: 0,
    };
    let activePhase: SyncRunPhase | null = "recovery";
    let activePhaseStartedAt = runStartedAt;
    let unexpectedFailure = false;
    const finishActivePhase = (): void => {
      if (!activePhase) return;
      phasesMs[activePhase] += Math.max(0, Date.now() - activePhaseStartedAt);
      activePhase = null;
    };
    const enterPhase = (nextPhase: SyncRunPhase): void => {
      finishActivePhase();
      activePhase = nextPhase;
      activePhaseStartedAt = Date.now();
    };
    const waitForReview = async (review: () => Promise<boolean>): Promise<boolean> => {
      const priorPhase = activePhase;
      enterPhase("reviewWait");
      try {
        return await review();
      } finally {
        if (priorPhase) enterPhase(priorPhase);
      }
    };

    try {
      // Step 0: finish rollback from any interrupted local replacement before
      // scanning. This journal is independent of sync/base/remote state.
      try {
        const recoveryOutcome = await this.getRecoveryJournal().recover();
        if (recoveryOutcome !== "none") {
          this.diag?.warn("execute", `interrupted local write recovery completed — ${recoveryOutcome}`);
        }
      } catch (error) {
        result.errors = 1;
        result.message = this.t("result.localRecoveryFailed");
        this.diag?.error(
          "execute",
          "local recovery failed — stopping before scan and remote preparation",
          error instanceof Error ? error.message : String(error),
        );
        return result;
      }
      if (this.shouldStop(result, operationEpoch)) return result;
      if (
        this.state.hasV2StateLoadRecoveryBlock
        && options.recoverV2CorruptState === true
        && mode !== "auto"
        && this.state.v2CorruptStateRecoveryEvidence
      ) {
        return await this.runV2CorruptStateEvidenceCollection({
          result,
          callbacks,
          operationEpoch,
          automaticHandlingPolicy,
          communityPluginSyncPolicy,
          enterPhase,
          reviewedAuthorization:
            skipConfirmation ? reviewedAuthorization : undefined,
        });
      }
      if (this.state.hasV2StateLoadRecoveryBlock) {
        result.errors = 1;
        result.message = this.t("result.v2StateLoadBlocked");
        this.diag?.error(
          "state",
          "V2 state authority could not be loaded safely; stopped before scan and Graph preparation",
          this.state.v2StateLoadRecoveryBlock,
        );
        return result;
      }
      if (this.state.hasV2RemoteScopeRecovery) {
        if (
          options.recoverV2RemoteScope === true
          && mode !== "auto"
        ) {
          const recoveryResult = await this.runV2RemoteScopeRecovery({
            result,
            callbacks,
            operationEpoch,
            automaticHandlingPolicy,
            communityPluginSyncPolicy,
            enterPhase,
            reviewedAuthorization:
              skipConfirmation ? reviewedAuthorization : undefined,
          });
          if (recoveryResult) return recoveryResult;
        }
        if (this.state.hasV2RemoteScopeRecovery) {
          result.deferred = 1;
          result.message = this.t("result.v2ScopeRecoveryPending");
          this.diag?.warn(
            "state",
            "V2 remote scope recovery is pending; ordinary sync stopped before scan and Graph preparation",
            {
              reason: this.state.activeV2RemoteScopeRecovery?.reason ?? null,
              observedScopeAvailable:
                this.state.activeV2RemoteScopeRecovery?.observedScope !== null,
              mutations: 0,
            },
          );
          return result;
        }
      }
      if (
        this.state.isV2StateActive
        && this.state.hasMutationRecoveryQuarantineCorruption
      ) {
        const remaining = Math.max(
          1,
          this.state.mutationLedger.length
            + this.state.mutationRecoveryQuarantine.length,
        );
        result.mutationRecovery = {
          state: "blocked",
          total: remaining,
          settled: 0,
          remaining,
          retryAfterSeconds: null,
          blockReason: "evidence-corrupt",
        };
        result.errors = 1;
        result.message = this.t("result.v2RecoveryBlocked");
        this.diag?.error(
          "state",
          "V2 mutation recovery quarantine is corrupt; stopped before scan and Graph preparation",
        );
        return result;
      }
      if (
        prepareV2MigrationCandidate
        && (
          this.state.hasMutationLedgerCorruption
          || (
            options.readOnlyPreview === true
            && this.state.mutationLedger.length > 0
          )
        )
      ) {
        result.errors = 1;
        result.message = this.t("result.legacyRecoveryNeedsMigration");
        this.diag?.warn(
          "state",
          "public 1.1.3 mutation recovery requires an explicit V2 migration policy; stopped before scan and Graph preparation",
          {
            ledgerRecords: this.state.mutationLedger.length,
            ledgerCorrupt: this.state.hasMutationLedgerCorruption,
            mutations: 0,
          },
        );
        return result;
      }

      // Step 1: Scan local files
      enterPhase("scan");
      this.progressStore?.setPhase("scanning");
      callbacks.onProgress?.(0, 1, this.t("progress.scanningLocal"));
      const scanResult = await this.scanner.scanAll();
      let localEntries = scanResult.entries;
      let localFolders = scanResult.folders ?? [];
      let localFolderScanComplete = scanResult.folderScanComplete === true;
      const { skippedLarge, failedPaths } = scanResult;
      result.skippedLarge = skippedLarge.length;
      if (this.shouldStop(result, operationEpoch)) return result;
      if (scanResult.complete === false || failedPaths.length > 0) {
        result.errors = Math.max(1, new Set(failedPaths).size);
        result.message = this.t("result.scanIncomplete");
        this.diag?.warn(
          "scan",
          `scan incomplete — stopping round before remote preparation; ${result.errors} path(s) uncertain: ${failedPaths.slice(0, 5).join(", ")}`,
        );
        return result;
      }

      // Step 1.5: Resolve and initialize the remote vault directory.
      enterPhase("remotePrepare");
      this.progressStore?.setPhase("preparing");
      callbacks.onProgress?.(0, 1, this.t("progress.preparingRemote"));
      const committedScope = this.state.remoteScope;
      const committedDeltaLink = this.state.remoteDeltaLink;
      const canRestoreCommittedScope = Boolean(this.state.boundAccountId)
        && committedScope?.accountId === this.state.boundAccountId
        && Boolean(committedScope);
      let restoredCommittedScope = canRestoreCommittedScope
        && Boolean(committedDeltaLink)
        && this.onedrive.restoreVaultScope(
          this.vaultName,
          {
            driveId: committedScope!.driveId,
            vaultFolderId: committedScope!.vaultFolderId,
            filesRootId: committedScope!.filesRootId,
          },
          committedDeltaLink!,
        );
      if (
        canRestoreCommittedScope
        && !restoredCommittedScope
        && typeof this.onedrive.restoreVaultScopeByIdentity === "function"
      ) {
        try {
          const restored = await this.onedrive.restoreVaultScopeByIdentity(
            this.vaultName,
            {
              driveId: committedScope!.driveId,
              vaultFolderId: committedScope!.vaultFolderId,
              filesRootId: committedScope!.filesRootId,
            },
          );
          restoredCommittedScope = restored.driveId === committedScope!.driveId
            && restored.vaultFolderId === committedScope!.vaultFolderId
            && restored.filesRootId === committedScope!.filesRootId;
        } catch (error) {
          if (
            !this.state.isV2StateActive
            || this.state.mutationLedger.length > 0
          ) throw error;
          const scopeLoss = await this.resolveV2CommittedScopeLoss(
            committedScope!,
            error,
          );
          await this.stageV2CommittedScopeRecovery(result, scopeLoss);
          if (
            mode !== "auto"
            && options.readOnlyPreview !== true
          ) {
            const recoveryResult = await this.runV2RemoteScopeRecovery({
              result,
              callbacks,
              operationEpoch,
              automaticHandlingPolicy,
              communityPluginSyncPolicy,
              enterPhase,
            });
            if (recoveryResult) return recoveryResult;
            restoredCommittedScope = true;
            result.deferred = 0;
            result.message = "";
          } else {
            return result;
          }
        }
      }
      const remoteVaultScope = restoredCommittedScope
        ? {
            driveId: committedScope!.driveId,
            vaultFolderId: committedScope!.vaultFolderId,
            filesRootId: committedScope!.filesRootId,
          }
        : options.readOnlyPreview || recoveryOnly
          ? await this.onedrive.initVaultScope(this.vaultName, { createMissing: false })
          : await this.onedrive.initVaultScope(this.vaultName);
      let syncScope: SyncScope = {
        accountId: this.state.boundAccountId,
        ...remoteVaultScope,
      };
      this.activeSyncScope = syncScope;
      if (this.shouldStop(result, operationEpoch)) return result;
      if (prepareV2MigrationCandidate && activationReviewKind === null) {
        const protocolTransport = availableSharedSyncProtocolTransportV2(
          this.onedrive,
          this.vaultName,
        );
        if (!protocolTransport) {
          result.errors = 1;
          result.message = this.t("result.v2ProtocolBlocked");
          this.diag?.error(
            "state",
            "shared V2 sync protocol transport is unavailable during activation classification",
          );
          return result;
        }
        const protocol = await ensureSharedSyncProtocolV2(
          protocolTransport,
          {
            scope: syncScope,
            acknowledgeMigrationRisk: false,
          },
        );
        if (protocol.status === "ready") {
          activationReviewKind = "v2-cloud-join";
          this.diag?.log(
            "state",
            "fresh V2 device classified as joining an existing shared sync state",
            {
              migrationGeneration:
                protocol.binding.migrationGeneration.slice(0, 12),
              mutations: 0,
            },
          );
        } else if (protocol.status === "acknowledgement-required") {
          activationReviewKind = "v2-first-sync";
          this.diag?.log(
            "state",
            "fresh V2 device classified as the first device for this sync state",
            { mutations: 0 },
          );
        } else {
          result.errors = 1;
          result.message = this.t("result.v2ProtocolBlocked");
          this.diag?.error(
            "state",
            "fresh V2 activation could not classify the shared sync state safely",
            { reason: protocol.reason, mutations: 0 },
          );
          return result;
        }
      }
      if (!takeOverPublic113MutationLedger) {
        if (
          this.state.isV2StateActive
          && this.state.mutationLedger.length > 0
        ) {
          await this.rebuildRemoteStateFromIdentitySnapshot(
            operationEpoch,
            result,
            syncScope,
          );
          if (this.shouldStop(result, operationEpoch)) return result;
        }
        const mutationRecovery = await this.recoverMutationLedger(
          syncScope,
          automaticHandlingMetrics,
        );
        if (this.shouldStop(result, operationEpoch)) return result;
        if (this.localVersionRecoveredDuringLedger) {
          const recoveredScan = await this.scanner.scanAll();
          if (
            recoveredScan.complete === false
            || recoveredScan.failedPaths.length > 0
          ) {
            result.errors = Math.max(
              1,
              new Set(recoveredScan.failedPaths).size,
            );
            result.message = this.t("result.scanIncomplete");
            return result;
          }
          localEntries = recoveredScan.entries;
          localFolders = recoveredScan.folders ?? [];
          localFolderScanComplete =
            recoveredScan.folderScanComplete === true;
          this.localVersionRecoveredDuringLedger = false;
          this.diag?.warn(
            "execute",
            "local scan refreshed after interrupted merge recovery",
          );
        }
        if (recoveryOnly) {
          result.mutationRecovery = mutationRecovery ?? {
            state: "settled",
            total: recoveryRecordsAtStart,
            settled: Math.max(
              0,
              recoveryRecordsAtStart - this.state.mutationLedger.length,
            ),
            remaining: this.state.mutationLedger.length,
            retryAfterSeconds: null,
          };
          result.success = this.state.mutationLedger.length === 0;
          result.message = this.t(
            result.success ? "result.synced" : "result.syncFailed",
            result.success
              ? {
                  uploaded: 0,
                  downloaded: 0,
                  foldersCreated: 0,
                  foldersMoved: 0,
                  foldersDeleted: 0,
                  filesMoved: 0,
                  deleted: 0,
                  conflicts: 0,
                  deferred: 0,
                  errors: 0,
                }
              : { message: "Mutation recovery remains pending" },
          );
          this.diag?.log(
            "execute",
            "recovery-only V2 round stopped before baseline and planning",
            {
              ...result.mutationRecovery,
              externalMutations: 0,
            },
          );
          return result;
        }
      }
      const scopeExpansionState = this.state as StateManager & Partial<
        Pick<StateManager, "prepareSyncScopeExpansion">
      >;
      const scopeExpansionPreparation =
        this.state.isV2StateActive
        && typeof scopeExpansionState.prepareSyncScopeExpansion === "function"
        ? await scopeExpansionState.prepareSyncScopeExpansion(syncScope)
        : { status: "none" as const };
      if (scopeExpansionPreparation.status === "blocked") {
        this.diag?.warn(
          "state",
          "device-local sync scope expansion remains blocked by unsettled recovery or review state",
          {
            revision: scopeExpansionPreparation.revision,
            mutations: 0,
          },
        );
        const blockedExpansion = this.state.activeSyncScopeExpansion;
        if (
          blockedExpansion?.revision === scopeExpansionPreparation.revision
          && blockedExpansion.requiresCompleteRemoteIdentitySnapshot
        ) {
          result.deferred = 1;
          result.message = this.t("result.deferred", { deferred: 1 });
          this.diag?.warn(
            "state",
            "file scope expansion stopped before remote scan and planning until complete remote identity recovery is safe",
            {
              revision: scopeExpansionPreparation.revision,
              mutations: 0,
            },
          );
          return result;
        }
      }
      let forceCompleteRemoteIdentitySnapshot =
        prepareV2MigrationCandidate
        || scopeExpansionPreparation.status === "ready"
        || (options.communityPluginJoinAuthorizations?.length ?? 0) > 0;
      const structuredCommunityPluginPathForIdentity =
        communityPluginSyncPolicy.files.mode !== "none"
          ? `${getConfigDir(this.scanner.vault)}/community-plugins.json`
          : null;
      const enablementObservation = structuredCommunityPluginPathForIdentity
        ? this.state.getCommunityPluginEnablementState(syncScope).observation
        : undefined;
      const structuredRemoteIdentityMissing = Boolean(
        this.state.isV2StateActive
        && this.state.hasRemoteState
        && this.state.remoteDeltaLink
        && structuredCommunityPluginPathForIdentity
        && !this.state.remoteSnapshot.some(
          (entry) => entry.path === structuredCommunityPluginPathForIdentity,
        )
        && enablementObservation
          ?.source.path === structuredCommunityPluginPathForIdentity
        && enablementObservation.source.remote.exists
        && enablementObservation.source.remote.contentHash
        && enablementObservation.source.remote.remoteId
        && enablementObservation.source.remote.eTag,
      );
      if (structuredRemoteIdentityMissing) {
        forceCompleteRemoteIdentitySnapshot = true;
        this.diag?.warn(
          "onedrive",
          "committed community plugin enablement observation is missing from the V2 remote identity snapshot; rebuilding once before structured sync",
          {
            path: structuredCommunityPluginPathForIdentity,
            mutations: 0,
          },
        );
      }
      if (
        this.state.remoteDeltaLink
        && !this.onedrive.isDeltaLinkForVault(
          this.vaultName,
          this.state.remoteDeltaLink,
        )
      ) {
        this.diag?.warn("onedrive", "remote delta cache belongs to a different vault directory, rebuilding");
        if (this.shouldStop(result, operationEpoch)) return result;
        if (this.state.isV2StateActive) {
          forceCompleteRemoteIdentitySnapshot = true;
          this.diag?.warn(
            "onedrive",
            "committed V2 delta route does not match its vault identity; rebuilding from the verified committed scope",
          );
        } else if (!prepareV2MigrationCandidate) {
          await this.state.clearRemoteState();
        }
      }

      // Step 2: Load a non-authoritative cloud recovery hint when the local
      // base still needs reconstruction. The legacy
      // baseline is a read-only public-1.1.3 migration input only; once V2 is
      // authoritative it must never re-enter runtime planning as a fallback.
      enterPhase("baseline");
      this.progressStore?.setPhase("baseline");
      callbacks.onProgress?.(0, 1, this.t("progress.loadingBaseline"));
      // Capture this before cloud-baseline hints are projected into the
      // planning base. A reset may seed only some paths; those hints must not
      // make the remaining paths look like an established vault.
      const startedWithoutCommittedBase = (
        public113MigrationInput?.baseEntries
        ?? this.state.baseSnapshot
      ).length === 0;
      // A prior interrupted/partial reset run may already have persisted some
      // exact-content bases. lastSyncTime stays zero until the reconstruction
      // reaches a fully healthy round, so keep lifting the verification cap.
      const baselineReconstructionIncomplete = startedWithoutCommittedBase
        || this.state.lastSyncTime === 0;
      // A public-1.1.3 device can join after another device has already
      // committed V2 authority. Its local V1 base may be only partially
      // reconstructed even though the shared V2 bootstrap now carries exact,
      // version-bound content evidence for the remaining paths. Read that
      // non-authoritative hint during migration preparation as well; the
      // existing verifier still accepts each path only when the current
      // remote identity/version and the freshly scanned local SHA-256 agree.
      const shouldReadCloudBootstrapV2 = startedWithoutCommittedBase
        || (
          prepareV2MigrationCandidate
          && baselineReconstructionIncomplete
        );
      let cloudBootstrapV2Json: string | null = null;
      let cloudBaselineJson: string | null = null;
      if (shouldReadCloudBootstrapV2) {
        const cloudBootstrapClient = this.onedrive as OneDriveClient & {
          readCloudBootstrapV2?: OneDriveClient["readCloudBootstrapV2"];
        };
        if (typeof cloudBootstrapClient.readCloudBootstrapV2 === "function") {
          try {
            cloudBootstrapV2Json = (
              await cloudBootstrapClient.readCloudBootstrapV2(this.vaultName)
            )?.content ?? null;
          } catch (error) {
            this.diag?.warn(
              "state",
              this.state.isV2StateActive
                ? "V2 cloud bootstrap read failed; legacy baseline fallback is disabled after V2 authority"
                : startedWithoutCommittedBase
                  ? "V2 cloud bootstrap read failed; falling back to public-1.1.3 legacy baseline"
                  : "V2 cloud bootstrap read failed; continuing with exact public-1.1.3 content verification",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (
          startedWithoutCommittedBase
          && !cloudBootstrapV2Json
          && !this.state.isV2StateActive
        ) {
          cloudBaselineJson = await this.downloadLegacyCloudBaseline();
        }
      }
      if (this.shouldStop(result, operationEpoch)) return result;

      // Step 3: Get remote file list (delta or full scan)
      enterPhase("remoteChanges");
      this.progressStore?.setPhase("checking");
      callbacks.onProgress?.(0, 1, this.t("progress.checkingRemote"));
      const migrationSourceRemoteEntries = prepareV2MigrationCandidate
        ? public113MigrationInput!.remoteEntries.map((entry) => ({ ...entry }))
        : [];
      let remotePreparation: { entries: RemoteFileEntry[]; scope: SyncScope };
      try {
        remotePreparation = await this.tryDeltaOrFullScan(
          operationEpoch,
          result,
          syncScope,
          localEntries,
          forceCompleteRemoteIdentitySnapshot,
          !prepareV2MigrationCandidate,
          (
            this.state.isV2StateActive
            && skipConfirmation
            && this.state.planReviewActive
          )
            ? reviewedAuthorization?.canonicalIdentity?.sourceCommitSeq
            : undefined,
        );
      } catch (error) {
        if (!(error instanceof V2CommittedScopeUnreachableError)) throw error;
        await this.stageV2CommittedScopeRecovery(result, error);
        return result;
      }
      let remoteEntries = remotePreparation.entries;
      syncScope = remotePreparation.scope;
      this.activeSyncScope = syncScope;
      if (this.shouldStop(result, operationEpoch)) return result;
      const migrationRemoteItems = this.completeRemoteItems;

      if (this.state.remoteGeneration !== this.startGeneration) {
        result.message = this.t("result.generationMismatch");
        this.diag?.warn("execute", `generation mismatch after delta scan (${this.startGeneration} → ${this.state.remoteGeneration}), aborting`);
        return result;
      }
      if (scopeExpansionPreparation.status === "ready") {
        const accepted = await this.state.acceptSyncScopeExpansionFolders({
          expectedRevision: scopeExpansionPreparation.revision,
          scope: syncScope,
          localFiles: localEntries,
          localFolders,
          localFolderScanComplete,
          remoteIdentityComplete:
            this.completeRemoteItems !== null
            && this.state.hasCompleteRemoteFolderIndex,
        });
        if (accepted.status === "accepted") {
          this.diag?.log(
            "state",
            "device-local sync scope expansion completed source-bound remote identity preparation",
            {
              revision: scopeExpansionPreparation.revision,
              accepted: accepted.accepted,
              mutations: 0,
            },
          );
        } else {
          this.diag?.warn(
            "state",
            accepted.status === "stale"
              ? "device-local sync scope expansion authorization became stale; ordinary folder safety remains active"
              : "device-local sync scope expansion could not be accepted from complete current facts",
            {
              revision: scopeExpansionPreparation.revision,
              status: accepted.status,
              mutations: 0,
            },
          );
        }
      }

      // Step 4: Load base snapshot
      let baseEntries = (
        public113MigrationInput?.baseEntries
        ?? this.state.baseSnapshot
      ).filter(
        (entry) => this.shouldIncludeRemotePath(entry.path),
      );
      let seededBaseEntries: BaseFileEntry[] = [];
      let seededBaseEntriesPersisted = false;
      if (cloudBootstrapV2Json) {
        const bootstrapSeeds = this.seedBaseEntriesFromCloudBootstrapV2(
          cloudBootstrapV2Json,
          syncScope,
          localEntries,
          remoteEntries,
        );
        if (bootstrapSeeds.length > 0) {
          // CloudBootstrapV2 is a non-authoritative hint. It may fill only
          // paths that public 1.1.3 has not anchored yet; an existing V1 base
          // remains the migration source even when the cloud hint describes a
          // newer exact common version.
          const existingPathKeys = new Set(
            baseEntries.map((entry) => normalizeRemotePathKey(entry.path)),
          );
          seededBaseEntries = bootstrapSeeds.filter((entry) =>
            !existingPathKeys.has(normalizeRemotePathKey(entry.path)),
          );
          if (seededBaseEntries.length > 0) {
            baseEntries = [...baseEntries, ...seededBaseEntries];
            this.diag?.log(
              "state",
              `V2 cloud bootstrap seeded ${seededBaseEntries.length} previously unanchored version-bound path(s)`,
            );
          }
        } else if (baseEntries.length === 0) {
          this.diag?.warn(
            "state",
            "V2 cloud bootstrap had no currently verifiable shared paths",
          );
          if (!this.state.isV2StateActive) {
            cloudBaselineJson = await this.downloadLegacyCloudBaseline();
          }
        }
      }
      if (baseEntries.length === 0 && cloudBaselineJson) {
        seededBaseEntries = this.seedBaseEntriesFromCloudBaseline(
          cloudBaselineJson,
          localEntries,
          remoteEntries,
        );
        if (seededBaseEntries.length > 0) {
          baseEntries = seededBaseEntries;
          this.diag?.log("state", `cloud baseline seeded ${seededBaseEntries.length} shared path(s)`);
        } else {
          this.diag?.log("state", "cloud baseline loaded, but no shared paths eligible");
        }
      }
      if (
        this.state.isV2StateActive
        && seededBaseEntries.length > 0
      ) {
        if (this.shouldStop(result, operationEpoch)) return result;
        await this.persistSeededBaseEntries(seededBaseEntries);
        seededBaseEntriesPersisted = true;
      }

      const remoteByPath = new Map(remoteEntries.map((entry) => [entry.path, entry]));
      const eTagUpdates = baseEntries.flatMap((base) => {
        const remote = remoteByPath.get(base.path);
        if (!remote || remote.eTag === base.eTag || !remoteContentMatchesBase(remote, base)) {
          return [];
        }
        return [{ ...base, eTag: remote.eTag }];
      });
      if (eTagUpdates.length > 0) {
        if (this.shouldStop(result, operationEpoch)) return result;
        if (!prepareV2MigrationCandidate) {
          await this.state.upsertBaseEntries(eTagUpdates);
        }
        const updatedByPath = new Map(eTagUpdates.map((entry) => [entry.path, entry]));
        baseEntries = baseEntries.map((entry) => updatedByPath.get(entry.path) ?? entry);
        this.diag?.log(
          "state",
          prepareV2MigrationCandidate
            ? `projected ${eTagUpdates.length} unchanged remote eTag(s) into the read-only migration candidate`
            : `reconciled ${eTagUpdates.length} unchanged remote eTag(s)`,
        );
      }
      if (this.shouldStop(result, operationEpoch)) return result;

      const configDir = getConfigDir(this.scanner.vault);
      const communityPluginJoinBlocks: CommunityPluginJoinBlock[] = [];
      const joinAuthorizationsByPluginId = new Map(
        (options.communityPluginJoinAuthorizations ?? []).map(
          (authorization) => [authorization.pluginId, authorization],
        ),
      );
      const recordCommunityPluginJoinBlocks = (
        blocks: readonly Readonly<CommunityPluginJoinBlock>[],
      ): void => {
        const known = new Set(
          communityPluginJoinBlocks.map((item) => item.pluginId),
        );
        const added = blocks.filter((item) => !known.has(item.pluginId));
        if (added.length === 0) return;
        communityPluginJoinBlocks.push(...added.map((item) => ({ ...item })));
        communityPluginSyncPolicy = excludeSelectedCommunityPluginFiles(
          communityPluginSyncPolicy,
          added.map((item) => item.pluginId),
        );
        result.communityPluginJoinBlocks = communityPluginJoinBlocks.map(
          (item) => ({ ...item }),
        );
        result.deferred += added.length;
      };
      const identityBlocks: CommunityPluginJoinBlock[] = [];
      for (const authorization of
        options.communityPluginJoinAuthorizations ?? []) {
        const validation = validateCommunityPluginJoinAuthorization(
          authorization,
          remoteEntries,
          syncScope,
        );
        if (validation.status === "valid") continue;
        identityBlocks.push({
          pluginId: authorization.pluginId,
          operationId: authorization.operationId,
          reason: validation.reason,
        });
      }
      recordCommunityPluginJoinBlocks(identityBlocks);
      for (const block of identityBlocks) {
        joinAuthorizationsByPluginId.delete(block.pluginId);
      }
      if (identityBlocks.length > 0) {
        this.diag?.warn(
          "plan",
          "community plugin join target changed; affected bundles stopped before mutation",
          {
            count: identityBlocks.length,
            reasons: identityBlocks.map((item) => item.reason),
            mutations: 0,
          },
        );
      }
      const detectedCommunityPluginLocalIgnores: CommunityPluginLocalIgnores =
        prepareV2MigrationCandidate
          ? detectCommunityPluginLocalIgnores({
              policy: communityPluginSyncPolicy,
              configDir,
              localEntries,
              remoteEntries,
              baseEntries,
            })
          : {
              files: [],
              data: detectCommunityPluginDataLocalIgnores({
                policy: communityPluginSyncPolicy,
                configDir,
                localEntries,
                remoteEntries,
                baseEntries,
              }),
            };
      const hasDetectedCommunityPluginLocalIgnores =
        detectedCommunityPluginLocalIgnores.files.length > 0
        || detectedCommunityPluginLocalIgnores.data.length > 0;
      if (hasDetectedCommunityPluginLocalIgnores) {
        communityPluginSyncPolicy = applyCommunityPluginLocalIgnores(
          communityPluginSyncPolicy,
          detectedCommunityPluginLocalIgnores,
        );
        if (!prepareV2MigrationCandidate) {
          result.communityPluginLocalIgnores =
            detectedCommunityPluginLocalIgnores;
        }
        this.diag?.log(
          "plan",
          prepareV2MigrationCandidate
            ? "public community plugin absence projected into migration candidate"
            : "community plugin data absence converted to device-local ignore",
          {
            schemaVersion: 1,
            files: detectedCommunityPluginLocalIgnores.files.length,
            data: detectedCommunityPluginLocalIgnores.data.length,
            mutations: 0,
          },
        );
      }
      const communityPluginManifestEvidence =
        await this.prepareMobileCommunityPluginManifestEvidence({
          policy: communityPluginSyncPolicy,
          configDir,
          localEntries,
          remoteEntries,
          scope: syncScope,
          result,
          operationEpoch,
          joiningPluginIds: [...joinAuthorizationsByPluginId.keys()],
        });
      const manifestCompatibilityBlocks =
        communityPluginManifestEvidence.incompatiblePluginIds.flatMap(
          (pluginId): CommunityPluginJoinBlock[] => {
            const authorization = joinAuthorizationsByPluginId.get(pluginId);
            return authorization
              ? [{
                  pluginId,
                  operationId: authorization.operationId,
                  reason: "manifest-incompatible",
                }]
              : [];
          },
        );
      recordCommunityPluginJoinBlocks(manifestCompatibilityBlocks);
      for (const block of manifestCompatibilityBlocks) {
        joinAuthorizationsByPluginId.delete(block.pluginId);
      }
      if (manifestCompatibilityBlocks.length > 0) {
        this.diag?.warn(
          "plan",
          "community plugin join manifest is incompatible; affected bundles stopped before mutation",
          {
            count: manifestCompatibilityBlocks.length,
            mutations: 0,
          },
        );
      }
      let communityPluginManifestObservationsPersisted = false;
      const publishCommunityPluginPostAuthorityState = async (): Promise<void> => {
        if (!communityPluginManifestObservationsPersisted) {
          await this.persistCommunityPluginManifestObservations(
            communityPluginManifestEvidence.observations,
          );
          communityPluginManifestObservationsPersisted = true;
        }
        if (hasDetectedCommunityPluginLocalIgnores) {
          result.communityPluginLocalIgnores =
            detectedCommunityPluginLocalIgnores;
        }
      };
      if (this.shouldStop(result, operationEpoch)) return result;
      if (
        this.state.isV2StateActive
        && !prepareV2MigrationCandidate
      ) {
        await publishCommunityPluginPostAuthorityState();
      }
      const mobileDesktopOnlyPluginIds =
        communityPluginManifestEvidence.desktopOnlyPluginIds;
      if (mobileDesktopOnlyPluginIds.length > 0) {
        communityPluginSyncPolicy = prepareV2MigrationCandidate
          ? applyCommunityPluginLocalIgnores(
              communityPluginSyncPolicy,
              {
                files: mobileDesktopOnlyPluginIds,
                data: [],
              },
            )
          : excludeSelectedCommunityPluginFiles(
              communityPluginSyncPolicy,
              mobileDesktopOnlyPluginIds,
            );
        this.diag?.log(
          "plan",
          "desktop-only community plugin bundles excluded from mobile participation",
          {
            schemaVersion: 1,
            count: mobileDesktopOnlyPluginIds.length,
            mutations: 0,
          },
        );
      }

      localEntries = localEntries.filter((entry) =>
        isCommunityPluginPathSelectedByPolicy(
          entry.path,
          communityPluginSyncPolicy,
          configDir,
        )
      );
      remoteEntries = remoteEntries.filter((entry) =>
        isCommunityPluginPathSelectedByPolicy(
          entry.path,
          communityPluginSyncPolicy,
          configDir,
        )
      );
      baseEntries = baseEntries.filter((entry) =>
        isCommunityPluginPathSelectedByPolicy(
          entry.path,
          communityPluginSyncPolicy,
          configDir,
        )
      );

      const structuredCommunityPluginPath = communityPluginSyncPolicy.files.mode !== "none"
        ? `${getConfigDir(this.scanner.vault)}/community-plugins.json`
        : null;
      let communityPluginEnablementWork: PreparedCommunityPluginEnablementWork | null = null;
      let communityPluginEnablementDecisionRequired = false;
      if (structuredCommunityPluginPath) {
        try {
          communityPluginEnablementWork =
            await this.prepareCommunityPluginEnablementWork(
              structuredCommunityPluginPath,
              communityPluginSyncPolicy.files,
              localEntries,
              remoteEntries,
              syncScope,
            );
        } catch (error) {
          if (error instanceof CommunityPluginEnablementVersionChangedError) {
            result.deferred = 1;
            result.message = this.t("result.deferred", { deferred: 1 });
            this.diag?.warn(
              "execute",
              "community plugin enablement changed during preparation; deferred",
              { side: error.side, mutations: 0 },
            );
            return result;
          }
          result.errors = 1;
          result.message = this.t("result.communityPluginEnablementInvalid");
          this.diag?.error(
            "execute",
            "community plugin enablement preparation failed closed",
            error instanceof Error ? error.message : String(error),
          );
          return result;
        }
        if (this.shouldStop(result, operationEpoch)) return result;
        if (communityPluginEnablementWork.prepared.status === "decision-required") {
          if (!prepareV2MigrationCandidate) {
            await this.state.setCommunityPluginEnablementState({
              version: 1,
              scope: syncScope,
              anchors: communityPluginEnablementWork.prepared.anchors,
              pending: communityPluginEnablementWork.prepared.pending,
              observation: communityPluginEnablementWork.observation,
            });
          } else {
            communityPluginEnablementDecisionRequired = true;
          }
          result.attention = {
            reason: "community-plugin-enablement-decision-required",
            count: communityPluginEnablementWork.prepared.pending.length,
          };
          result.message = this.t("result.communityPluginEnablementDecisionRequired");
          this.diag?.warn(
            "plan",
            prepareV2MigrationCandidate
              ? "public 1.1.3 community plugin enablement requires a V2 migration decision; legacy state left unchanged"
              : "community plugin enablement requires an explicit first observation decision",
            {
              pluginIds: communityPluginEnablementWork.prepared.pending.map(
                (item) => item.pluginId,
              ),
              mutations: 0,
            },
          );
          if (!prepareV2MigrationCandidate) return result;
        }
      }

      const planningLocalEntries = structuredCommunityPluginPath
        ? localEntries.filter((entry) => entry.path !== structuredCommunityPluginPath)
        : localEntries;
      // Step 5: Generate sync plan
      enterPhase("planning");
      this.progressStore?.setPhase("planning");
      callbacks.onProgress?.(0, 1, this.t("progress.generatingPlan"));
      const v2PlanState = this.state as StateManager & {
        getCommittedV2Envelope?: StateManager["getCommittedV2Envelope"];
      };
      let canonicalPlanCandidate: CanonicalPlanCandidateV2 | null = null;
      let migrationCandidateEnvelope: SyncStateEnvelopeV2 | null = null;
      let migrationPlannerState: CanonicalPlannerStateV2 | null = null;
      let committedV2Envelope =
        typeof v2PlanState.getCommittedV2Envelope === "function"
          ? v2PlanState.getCommittedV2Envelope()
          : null;
      if (prepareV2MigrationCandidate) {
        if (!migrationRemoteItems) {
          result.deferred = 1;
          result.message = this.t("result.deferred", { deferred: 1 });
          this.diag?.warn(
            "state",
            "V2 migration candidate requires a complete remote identity snapshot",
            { mutations: 0 },
          );
          return result;
        }
        const migrationBaseByPath = new Map(
          public113MigrationInput!.baseEntries
            .filter((entry) => entry.path !== structuredCommunityPluginPath)
            .map((entry) => [entry.path, { ...entry }]),
        );
        for (const entry of seededBaseEntries) {
          if (entry.path !== structuredCommunityPluginPath) {
            migrationBaseByPath.set(entry.path, { ...entry });
          }
        }
        for (const entry of eTagUpdates) {
          if (entry.path !== structuredCommunityPluginPath) {
            migrationBaseByPath.set(entry.path, { ...entry });
          }
        }
        const ancestorPreparation = attemptV2Activation
          ? await this.state.preparePublic113MigrationAncestors(
              public113MigrationInput!,
            )
          : null;
        if (ancestorPreparation) {
          this.diag?.log(
            "state",
            "public 1.1.3 base-content prepared for V2 ancestors",
            {
              sourceEntries: ancestorPreparation.sourceEntries,
              published: ancestorPreparation.published,
              rejected: ancestorPreparation.rejected,
              unavailable: ancestorPreparation.unavailable,
              mutations: 0,
            },
          );
        }
        const preparedMigration = buildStateV2MigrationCandidate({
          scope: syncScope,
          lifecycleEpoch: this.state.remoteGeneration,
          localScanComplete: true,
          remoteScanComplete: true,
          folderScanComplete: localFolderScanComplete,
          localEntries: planningLocalEntries,
          localFolders,
          remoteItems: migrationRemoteItems,
          v1Base: [...migrationBaseByPath.values()],
          v1RemoteEntries: migrationSourceRemoteEntries.filter(
            (entry) =>
              entry.path !== structuredCommunityPluginPath
              && isCommunityPluginPathSelectedByPolicy(
                entry.path,
                communityPluginSyncPolicy,
                configDir,
              ),
          ),
          preservedBasePaths: public113MigrationInput!.baseEntries
            .filter((entry) => !this.shouldIncludeRemotePath(entry.path))
            .map((entry) => entry.path),
          requireCompleteAnchors: true,
          allowChangedAnchors: true,
          v1MutationLedger: this.state.mutationLedger,
          v1PendingConflicts: this.state.pendingConflicts,
          v1VaultName: this.vaultName,
          ancestorHashesByPath: ancestorPreparation?.hashesByPath,
        });
        if (
          preparedMigration.status !== "ready"
          || !preparedMigration.envelope
        ) {
          result.deferred = Math.max(1, preparedMigration.pending.length);
          result.message = this.t("result.deferred", {
            deferred: result.deferred,
          });
          this.diag?.warn(
            "state",
            "V2 migration candidate rejected before authority change",
            {
              reason: preparedMigration.reason,
              pending: preparedMigration.pending.length,
              mutations: 0,
            },
          );
          return result;
        }
        migrationCandidateEnvelope = preparedMigration.envelope;
        if (attemptV2Activation) {
          migrationPlannerState =
            await this.state.preparePublic113IndexedDbPlannerState(
              migrationCandidateEnvelope,
              public113MigrationInput!,
            );
          if (migrationPlannerState) {
            this.diag?.log(
              "state",
              "public 1.1.3 canonical planner is using the source-bound inactive IndexedDB view",
              {
                sourceCommitSeq: migrationPlannerState.meta.commitSeq,
                remoteNodes: migrationPlannerState.remoteNodes.length,
                fileAnchors: migrationPlannerState.fileAnchors.length,
                folderAnchors:
                  migrationPlannerState.folderAnchors?.length ?? 0,
                mutations: 0,
              },
            );
          }
        }
      }
      let canonicalSourceEnvelope =
        committedV2Envelope ?? migrationCandidateEnvelope;
      const includeCanonicalFilePath = (path: string): boolean =>
        path !== structuredCommunityPluginPath
        && this.shouldIncludeRemotePath(path);
      const includeCanonicalFolderPath = (path: string): boolean =>
        this.scanner.shouldSyncFolderPath(path);
      const preserveCanonicalFolderPath = (path: string): boolean =>
        !includeCanonicalFolderPath(path)
        || isCommunityPluginFolderPreservedByPolicy(
          path,
          communityPluginSyncPolicy,
          configDir,
          "easy-sync",
          [...joinAuthorizationsByPluginId.keys()],
        );
      const resolveCanonicalRemoteContentHash = async (
        item: Readonly<SyncPlanItem>,
        progress: { current: number; total: number },
        resetProgressPhase = true,
      ): Promise<string> => {
        const remote = item.remote!;
        const verificationSize = item.local?.size ?? remote.size;
        if (resetProgressPhase) this.progressStore?.setPhase("verifying");
        this.progressStore?.setProgress(
          progress.current,
          progress.total,
          item.path,
        );
        callbacks.onProgress?.(
          progress.current,
          progress.total,
          this.t("progress.verifyingFiles", progress),
        );
        this.diag?.log(
          "plan",
          `canonical content verification [${progress.current}/${progress.total}] checking ${item.path} (${verificationSize} bytes)`,
        );
        const remoteContent = await this.onedrive.downloadFile(
          this.vaultName,
          item.path,
          remote.downloadUrl,
          remote.driveId,
          remote.size,
        );
        const downloadedHash = await sha256Hex(remoteContent);
        await this.verifyDownloadedPayload(item.path, remote, {
          size: remoteContent.byteLength,
          hash: downloadedHash,
        });
        return downloadedHash;
      };
      if (migrationPlannerState) {
        canonicalPlanCandidate = buildCanonicalPlanCandidateFromStateV2({
          state: migrationPlannerState,
          localFiles: planningLocalEntries,
          localFolders,
          localFolderScanComplete,
          skippedLarge,
          localMoveHints: this.state.localFolderMoveHints,
          includeFilePath: includeCanonicalFilePath,
          includeFolderPath: includeCanonicalFolderPath,
          preserveFolderPath: preserveCanonicalFolderPath,
          configDir,
          automaticDeleteLocalFiles:
            automaticHandlingPolicy.autoDeleteLocalFiles,
        });
      } else if (canonicalSourceEnvelope) {
        canonicalPlanCandidate = buildCanonicalPlanCandidateV2({
          envelope: canonicalSourceEnvelope,
          localFiles: planningLocalEntries,
          localFolders,
          localFolderScanComplete,
          skippedLarge,
          localMoveHints: this.state.localFolderMoveHints,
          includeFilePath: includeCanonicalFilePath,
          includeFolderPath: includeCanonicalFolderPath,
          preserveFolderPath: preserveCanonicalFolderPath,
          configDir,
          automaticDeleteLocalFiles:
            automaticHandlingPolicy.autoDeleteLocalFiles,
        });
      }
      if (
        this.state.isV2StateActive
        && !prepareV2MigrationCandidate
        && canonicalPlanCandidate?.folderPlan.items.some(
          (item) => item.reason === "unanchored-shared-folder",
        )
      ) {
        const acceptConfirmedDescendantFolders = () =>
          this.state.acceptConfirmedDescendantFolderAnchors({
            scope: syncScope,
            localFiles: planningLocalEntries,
            localFolders,
            localFolderScanComplete,
            remoteIdentityComplete: this.state.hasCompleteRemoteFolderIndex,
            includeFilePath: includeCanonicalFilePath,
            includeFolderPath: (path) =>
              includeCanonicalFolderPath(path)
              && !preserveCanonicalFolderPath(path),
          });
        let reconstructed = await acceptConfirmedDescendantFolders();
        if (reconstructed.status === "none") {
          const evidence = await finalizeUnanchoredFolderEvidenceV2({
            candidate: canonicalPlanCandidate,
            envelope: canonicalSourceEnvelope!,
            vaultName: this.vaultName,
            accountId: this.state.boundAccountId ?? "",
            automaticHandlingPolicy,
            baselineReconstructionIncomplete,
            pendingContentComparisons: this.state.pendingConflicts.map(
              (item) => ({
                path: item.path,
                contentComparison: item.contentComparison,
              }),
            ),
            resolveRemoteContentHash: resolveCanonicalRemoteContentHash,
          });
          if (this.shouldStop(result, operationEpoch)) return result;
          if (evidence.baseUpserts.length > 0) {
            const evidenceItemsByPath = new Map(
              canonicalPlanCandidate.unanchoredDescendantEvidence.map(
                (item) => [item.path, item],
              ),
            );
            const currentEvidence: BaseFileEntry[] = [];
            for (const entry of evidence.baseUpserts) {
              const sourceItem = evidenceItemsByPath.get(entry.path);
              const expectedLocal = sourceItem?.local;
              const expectedRemote = sourceItem?.remote;
              if (!expectedLocal || !expectedRemote) continue;
              const [currentLocal, currentRemote] = await Promise.all([
                this.inspectLocalPath(entry.path),
                this.inspectRemotePath(entry.path),
              ]);
              if (
                currentLocal?.status !== "present"
                || !this.inspectionMatchesVersion(
                  currentLocal,
                  expectedLocal,
                )
                || !currentRemote
                || currentRemote.driveId !== expectedRemote.driveId
                || currentRemote.eTag !== expectedRemote.eTag
                || currentRemote.size !== expectedRemote.size
              ) {
                this.diag?.warn(
                  "state",
                  `unanchored folder evidence changed before publication — ${entry.path}`,
                  { mutations: 0 },
                );
                continue;
              }
              currentEvidence.push(entry);
            }
            if (this.shouldStop(result, operationEpoch)) return result;
            if (currentEvidence.length > 0) {
              await this.stageVerifiedLocalAncestorContent(currentEvidence);
              const publication =
                await this.state.acceptConfirmedDescendantFileEvidence({
                  scope: syncScope,
                  sourceCommitSeq: canonicalSourceEnvelope!.meta.commitSeq,
                  entries: currentEvidence,
                });
              if (publication.status !== "accepted") {
                this.diag?.warn(
                  "state",
                  "exact descendant file evidence publication remained fail-closed",
                  {
                    reason: publication.status,
                    candidates: evidence.contentVerification.candidates,
                    mutations: 0,
                  },
                );
              } else {
                this.diag?.log(
                  "state",
                  "published exact descendant file evidence for unanchored folder recovery",
                  {
                    accepted: publication.accepted,
                    candidates: evidence.contentVerification.candidates,
                    downloads: evidence.contentVerification.downloads,
                    mutations: 0,
                  },
                );
                committedV2Envelope =
                  typeof v2PlanState.getCommittedV2Envelope === "function"
                    ? v2PlanState.getCommittedV2Envelope()
                    : null;
                canonicalSourceEnvelope =
                  committedV2Envelope ?? migrationCandidateEnvelope;
                if (!canonicalSourceEnvelope) {
                  throw new Error(
                    "Exact descendant evidence publication lost V2 authority",
                  );
                }
                canonicalPlanCandidate = buildCanonicalPlanCandidateV2({
                  envelope: canonicalSourceEnvelope,
                  localFiles: planningLocalEntries,
                  localFolders,
                  localFolderScanComplete,
                  skippedLarge,
                  localMoveHints: this.state.localFolderMoveHints,
                  includeFilePath: includeCanonicalFilePath,
                  includeFolderPath: includeCanonicalFolderPath,
                  preserveFolderPath: preserveCanonicalFolderPath,
                  configDir,
                  automaticDeleteLocalFiles:
                    automaticHandlingPolicy.autoDeleteLocalFiles,
                });
                reconstructed = await acceptConfirmedDescendantFolders();
              }
            }
          }
        }
        if (reconstructed.status === "accepted") {
          this.diag?.log(
            "state",
            "reconstructed source-bound folder identities from confirmed descendant files",
            {
              accepted: reconstructed.accepted,
              evidenceFiles: reconstructed.evidenceFiles,
              mutations: 0,
            },
          );
          committedV2Envelope =
            typeof v2PlanState.getCommittedV2Envelope === "function"
              ? v2PlanState.getCommittedV2Envelope()
              : null;
          canonicalSourceEnvelope =
            committedV2Envelope ?? migrationCandidateEnvelope;
          if (!canonicalSourceEnvelope) {
            throw new Error(
              "Confirmed descendant folder reconstruction lost V2 authority",
            );
          }
          canonicalPlanCandidate = buildCanonicalPlanCandidateV2({
            envelope: canonicalSourceEnvelope,
            localFiles: planningLocalEntries,
            localFolders,
            localFolderScanComplete,
            skippedLarge,
            localMoveHints: this.state.localFolderMoveHints,
            includeFilePath: includeCanonicalFilePath,
            includeFolderPath: includeCanonicalFolderPath,
            preserveFolderPath: preserveCanonicalFolderPath,
            configDir,
            automaticDeleteLocalFiles:
              automaticHandlingPolicy.autoDeleteLocalFiles,
          });
        } else if (reconstructed.status === "rejected") {
          this.diag?.warn(
            "state",
            "confirmed descendant folder identity reconstruction remained fail-closed",
            {
              reason: reconstructed.reason,
              mutations: 0,
            },
          );
        }
      }
      if (
        this.state.isV2StateActive
        && !prepareV2MigrationCandidate
        && canonicalPlanCandidate?.status === "planned"
      ) {
        const reconstruction =
          await this.state.prepareConfirmedDescendantFileReconstruction?.({
            scope: syncScope,
            localFolders,
            candidateItems: canonicalPlanCandidate.items,
          }) ?? { status: "none" as const, roots: [] };
        if (reconstruction.status === "ready") {
          const reconstructionStartedAt = Date.now();
          const reconstructionRoots =
            reconstruction.roots.map((root) => root.path);
          const reconstructionComparisons = new Map(
            this.state.pendingConflicts.map((item) => [item.path, item]),
          );
          const isReconstructionCandidate = (
            item: Readonly<SyncPlanItem>,
          ): boolean =>
            item.type === SyncActionType.Conflict
            && item.reason === "reason.newFileBothSides"
            && Boolean(item.local)
            && Boolean(item.remote)
            && item.local!.size === item.remote!.size
            && resolveContentEquality({
              local: item.local!,
              remote: item.remote!,
            }).status !== "different"
            && reconstructionRoots.some((root) =>
              isAtOrBelowPath(item.path, root));
          const reconstructionEvidenceStatus = (
            item: Readonly<SyncPlanItem>,
          ) => resolveContentEquality({
            local: item.local!,
            remote: item.remote!,
          }).status;
          const pendingComparisonFor = (
            item: Readonly<SyncPlanItem>,
          ): SyncPlanItem | undefined => {
            const pending = reconstructionComparisons.get(item.path);
            return pending
              && item.local
              && item.remote
              && contentDifferenceReceiptMatches(
                pending.contentComparison,
                item.local,
                item.remote,
              )
              ? pending
              : undefined;
          };
          const initialCandidates = canonicalPlanCandidate.items.filter(
            (item) =>
              isReconstructionCandidate(item)
              && !pendingComparisonFor(item),
          ).sort((left, right) => {
            const leftNeedsDownload =
              reconstructionEvidenceStatus(left) === "unknown";
            const rightNeedsDownload =
              reconstructionEvidenceStatus(right) === "unknown";
            if (leftNeedsDownload !== rightNeedsDownload) {
              return leftNeedsDownload ? 1 : -1;
            }
            return left.path.localeCompare(right.path);
          });
          let batches = 0;
          let verified = 0;
          let downloads = 0;
          let verifiedBytes = 0;
          let downloadBytes = 0;
          const pauseReconstructionForRetry = (
            message: string,
          ): SyncResult => {
            result.success = false;
            result.deferred++;
            result.continueAfterConfirmedDescendantFileReconstruction = true;
            result.descendantFileReconstructionRetryableFailure = true;
            result.errors = Math.max(1, result.errors);
            result.message = this.t("result.syncFailed", { message });
            return result;
          };
          this.diag?.log(
            "state",
            "starting source-bound descendant file baseline reconstruction",
            {
              roots: reconstructionRoots.length,
              candidates: initialCandidates.length,
              zeroDownloadCandidates: initialCandidates.filter(
                (item) =>
                  reconstructionEvidenceStatus(item) !== "unknown",
              ).length,
              bytes: initialCandidates.reduce(
                (total, item) => total + (item.remote?.size ?? 0),
                0,
              ),
              visibleSession: "single",
              mutations: 0,
            },
          );
          if (initialCandidates.length > 0) {
            this.progressStore?.setPhase("verifying");
            this.progressStore?.setProgress(
              0,
              initialCandidates.length,
              "",
            );
            callbacks.onProgress?.(
              0,
              initialCandidates.length,
              this.t("progress.verifyingFiles", {
                current: 0,
                total: initialCandidates.length,
              }),
            );
          }
          while (true) {
            if (this.shouldStop(result, operationEpoch)) return result;
            const unresolved = canonicalPlanCandidate.items.filter(
              (item) =>
                isReconstructionCandidate(item)
                && !pendingComparisonFor(item),
            ).sort((left, right) => {
              const leftNeedsDownload =
                reconstructionEvidenceStatus(left) === "unknown";
              const rightNeedsDownload =
                reconstructionEvidenceStatus(right) === "unknown";
              if (leftNeedsDownload !== rightNeedsDownload) {
                return leftNeedsDownload ? 1 : -1;
              }
              return left.path.localeCompare(right.path);
            });
            if (unresolved.length === 0) break;
            const next = unresolved[0];
            if (!next) break;
            const batch = [next];
            batches++;
            const reconstructionProgress = {
              current: verified + 1,
              total: initialCandidates.length,
            };
            this.progressStore?.setProgress(
              reconstructionProgress.current,
              reconstructionProgress.total,
              next.path,
            );
            callbacks.onProgress?.(
              reconstructionProgress.current,
              reconstructionProgress.total,
              this.t("progress.verifyingFiles", reconstructionProgress),
            );
            const batchNeedsDownload =
              reconstructionEvidenceStatus(next) === "unknown";
            if (batchNeedsDownload) {
              const size = next.remote?.size ?? 0;
              downloadBytes += size;
            }
            verifiedBytes += batch.reduce(
              (total, item) => total + (item.remote?.size ?? 0),
              0,
            );
            const sourceEnvelope =
              this.state.getCommittedV2Envelope();
            if (!sourceEnvelope) {
              throw new Error(
                "Descendant file reconstruction lost V2 authority",
              );
            }
            const finalizedBatch =
              await finalizeCanonicalPlanCandidateV2({
                candidate: {
                  ...canonicalPlanCandidate,
                  items: batch.map((item) => ({ ...item })),
                  identityReplacements: [],
                },
                envelope: sourceEnvelope,
                vaultName: this.vaultName,
                accountId: this.state.boundAccountId ?? "",
                automaticHandlingPolicy,
                baselineReconstructionIncomplete: false,
                pendingContentComparisons:
                  [...reconstructionComparisons.values()].map((item) => ({
                    path: item.path,
                    contentComparison: item.contentComparison,
                  })),
                resolveRemoteContentHash: (item) =>
                  resolveCanonicalRemoteContentHash(
                    item,
                    reconstructionProgress,
                    false,
                  ),
              });
            downloads += finalizedBatch.contentVerification.downloads;
            const failures =
              finalizedBatch.contentVerification.results.filter(
                (item) => item.outcome === "failed",
              );
            if (failures.length > 0) {
              this.diag?.warn(
                "state",
                "descendant file baseline reconstruction interrupted during verification",
                {
                  batch: batches,
                  failed: failures.length,
                  completed: verified,
                  mutations: 0,
                },
              );
              return pauseReconstructionForRetry(
                "descendant file baseline verification failed",
              );
            }
            const differences = finalizedBatch.items.filter((item) =>
              item.type === SyncActionType.Conflict
              && Boolean(item.contentComparison),
            );
            if (differences.length > 0) {
              await this.state.upsertPendingConflicts(differences);
              for (const item of differences) {
                reconstructionComparisons.set(item.path, item);
              }
            }
            const currentEvidence: BaseFileEntry[] = [];
            if (finalizedBatch.baseUpserts.length > 0) {
              const batchByPath = new Map(
                batch.map((item) => [item.path, item]),
              );
              for (const entry of finalizedBatch.baseUpserts) {
                const sourceItem = batchByPath.get(entry.path);
                const expectedLocal = sourceItem?.local;
                const expectedRemote = sourceItem?.remote;
                if (!expectedLocal || !expectedRemote) continue;
                const [currentLocal, currentRemote] = await Promise.all([
                  this.inspectLocalPath(entry.path),
                  this.inspectRemotePath(entry.path),
                ]);
                if (
                  currentLocal?.status !== "present"
                  || !this.inspectionMatchesVersion(
                    currentLocal,
                    expectedLocal,
                  )
                  || !currentRemote
                  || currentRemote.driveId !== expectedRemote.driveId
                  || currentRemote.eTag !== expectedRemote.eTag
                  || currentRemote.size !== expectedRemote.size
                ) continue;
                currentEvidence.push(entry);
              }
              if (
                currentEvidence.length
                !== finalizedBatch.baseUpserts.length
              ) {
                this.diag?.warn(
                  "state",
                  "descendant file baseline evidence changed before publication",
                  {
                    batch: batches,
                    candidates: finalizedBatch.baseUpserts.length,
                    current: currentEvidence.length,
                    mutations: 0,
                  },
                );
                return pauseReconstructionForRetry(
                  "descendant file baseline evidence changed",
                );
              }
              await this.stageVerifiedLocalAncestorContent(currentEvidence);
              const publication =
                await this.state.acceptConfirmedDescendantFileEvidence({
                  scope: syncScope,
                  sourceCommitSeq: sourceEnvelope.meta.commitSeq,
                  entries: currentEvidence,
                });
              if (
                publication.status !== "accepted"
                || publication.accepted !== currentEvidence.length
              ) {
                this.diag?.warn(
                  "state",
                  "descendant file baseline publication remained fail-closed",
                  {
                    batch: batches,
                    status: publication.status,
                    candidates: currentEvidence.length,
                    mutations: 0,
                  },
                );
                return pauseReconstructionForRetry(
                  "descendant file baseline publication was blocked",
                );
              }
            }
            const settled =
              currentEvidence.length + differences.length;
            if (settled !== batch.length) {
              this.diag?.warn(
                "state",
                "descendant file baseline batch did not settle every source version",
                {
                  batch: batches,
                  candidates: batch.length,
                  settled,
                  mutations: 0,
                },
              );
              return pauseReconstructionForRetry(
                "descendant file baseline batch did not settle",
              );
            }
            verified += settled;
            committedV2Envelope =
              typeof v2PlanState.getCommittedV2Envelope === "function"
                ? v2PlanState.getCommittedV2Envelope()
                : null;
            canonicalSourceEnvelope =
              committedV2Envelope ?? migrationCandidateEnvelope;
            if (!canonicalSourceEnvelope) {
              throw new Error(
                "Descendant file baseline publication lost V2 authority",
              );
            }
            canonicalPlanCandidate = buildCanonicalPlanCandidateV2({
              envelope: canonicalSourceEnvelope,
              localFiles: planningLocalEntries,
              localFolders,
              localFolderScanComplete,
              skippedLarge,
              localMoveHints: this.state.localFolderMoveHints,
              includeFilePath: includeCanonicalFilePath,
              includeFolderPath: includeCanonicalFolderPath,
              preserveFolderPath: preserveCanonicalFolderPath,
              configDir,
              automaticDeleteLocalFiles:
                automaticHandlingPolicy.autoDeleteLocalFiles,
            });
          }
          await this.state.completeConfirmedDescendantFileReconstruction?.(
            syncScope,
          );
          canonicalPlanCandidate = buildCanonicalPlanCandidateV2({
            envelope: canonicalSourceEnvelope!,
            localFiles: planningLocalEntries,
            localFolders,
            localFolderScanComplete,
            skippedLarge,
            localMoveHints: this.state.localFolderMoveHints,
            includeFilePath: includeCanonicalFilePath,
            includeFolderPath: includeCanonicalFolderPath,
            preserveFolderPath: preserveCanonicalFolderPath,
            configDir,
            automaticDeleteLocalFiles:
              automaticHandlingPolicy.autoDeleteLocalFiles,
          });
          this.diag?.log(
            "state",
            "completed source-bound descendant file baseline reconstruction",
            {
              roots: reconstructionRoots.length,
              batches,
              verified,
              downloads,
              bytes: verifiedBytes,
              downloadBytes,
              elapsedMs: Date.now() - reconstructionStartedAt,
              mutations: 0,
            },
          );
        }
      }
      let plan: SyncPlan;
      if (canonicalPlanCandidate) {
        plan = {
          items: canonicalPlanCandidate.items,
          lastTotalFiles: canonicalPlanCandidate.lastTotalFiles,
          confirmed: false,
          scope: { ...canonicalPlanCandidate.scope },
        };
      } else {
        throw new Error(
          "V2 canonical planning requires an active envelope or a complete migration candidate",
        );
      }
      if (canonicalPlanCandidate?.status === "rejected") {
        result.deferred = 1;
        result.message = this.t("result.deferred", { deferred: 1 });
        this.diag?.warn(
          "plan",
          "V2 canonical candidate rejected before mutation",
          {
            reason: canonicalPlanCandidate.rejectionReason,
            sourceCommitSeq: canonicalPlanCandidate.sourceCommitSeq,
            mutations: 0,
          },
        );
        return result;
      }
      const anchoredRemoteIdByPath = new Map(
        (
          migrationPlannerState?.fileAnchors
          ?? (canonicalSourceEnvelope
            ? Object.values(canonicalSourceEnvelope.anchors.byAnchorId)
            : [])
        ).flatMap((anchor) =>
          anchor.remoteId
            ? [[anchor.lastPath, anchor.remoteId] as const]
            : []
        ),
      );
      plan.items = protectEasySyncSelfSyncPlan(
        protectCommunityPluginPlan(
          plan.items,
          communityPluginSyncPolicy,
          configDir,
          planningLocalEntries,
          "easy-sync",
          {
            remoteEntries,
            anchoredRemoteIdByPath,
            restoringFilePluginIds: [
              ...joinAuthorizationsByPluginId.keys(),
            ],
          },
        ),
        configDir,
      );
      plan.scope = syncScope;
      this.diag?.log("plan", `plan generated — ${plan.items.length} actions (up/down/del/conflict: ${plan.items.filter(i=>i.type===SyncActionType.Upload).length}/${plan.items.filter(i=>i.type===SyncActionType.Download).length}/${plan.items.filter(i=>i.type===SyncActionType.Conflict).length})`);
      if (this.shouldStop(result, operationEpoch)) return result;
      // M17: circuit breaker — skip items with 3+ consecutive same-version failures.
      // ponytail: manual/first sync is an explicit user retry, so don't silently
      // keep skipping on stale breaker state; auto sync keeps the guardrail.
      const breakerMap = new Map<string, PendingIssue>();
      for (const issue of this.state.pendingIssues) {
        if ((issue.consecutiveFailures ?? 0) >= 3) {
          breakerMap.set(issue.path, issue);
        }
      }
      if (breakerMap.size > 0) {
        let breakerCount = 0;
        const breakerApplies = mode === "auto";
        for (const item of plan.items) {
          const breaker = breakerMap.get(item.path);
          if (breaker && item.local?.hash === breaker.localHash && item.remote?.eTag === breaker.remoteETag) {
            breakerCount++;
            if (breakerApplies) {
              item.type = SyncActionType.RetryLater;
              item.reason = "reason.circuitBreaker";
            }
          }
        }
        if (breakerCount > 0) {
          this.diag?.log(
            "plan",
            breakerApplies
              ? `M17 circuit breaker — ${breakerCount} item(s) skipped (3+ consecutive failures)`
              : `M17 circuit breaker bypassed for ${mode} sync — ${breakerCount} item(s) will retry despite 3+ consecutive failures`,
          );
        }
      }

      const configPrefix = `${getConfigDir(this.scanner.vault)}/`;
      const obsidianUploads = plan.items.filter((i) =>
        i.type === SyncActionType.Upload && i.path.startsWith(configPrefix));
      if (obsidianUploads.length > 0) {
        this.diag?.log("plan", `plan includes ${configPrefix} uploads: ${obsidianUploads.map((i) => i.path).join(', ')}`);
      } else {
        const obsidianLocal = planningLocalEntries.filter((e) => e.path.startsWith(configPrefix));
        this.diag?.log("plan", `NO ${configPrefix} uploads in plan. localEntries with ${configPrefix}: ${obsidianLocal.map((e) => e.path).join(', ') || '(none)'}`);
      }

      // Step 5.5: Content hash dedup — for files that appear on both sides
      // without a base entry, compare actual content hashes to avoid false
      // conflicts when the same file exists on two devices (cloud baseline
      // covers most cases; this is the fallback for remaining edge cases).
      //
      // SAFETY LIMIT: during normal sync, download-based hash dedup is
      // capped at 10 files to avoid stalling on slow networks. When the run
      // started without any committed base (fresh install or explicit reset),
      // lift the cap even if cloud-baseline hints seed only some paths.
      // Uncompared pending items remain eligible on later rounds; only a
      // version-bound byte-difference receipt may suppress another download.
      let finalizedCanonicalPlan: FinalizedCanonicalPlanV2 | null = null;
      let canonicalFinalizationEnvelope: SyncStateEnvelopeV2 | null = null;
      let contentEqualityBaseUpserts: BaseFileEntry[] = [];
      let contentEqualityAncestorHashes:
        Readonly<Record<string, string>> | undefined;
      if (canonicalPlanCandidate) {
        const finalizedEnvelope = migrationCandidateEnvelope
          ?? (
            typeof v2PlanState.getCommittedV2Envelope === "function"
              ? v2PlanState.getCommittedV2Envelope()
              : null
          );
        if (!finalizedEnvelope) {
          throw new Error(
            "V2 canonical finalization requires a committed envelope",
          );
        }
        canonicalFinalizationEnvelope = finalizedEnvelope;
        finalizedCanonicalPlan = await finalizeCanonicalPlanCandidateV2({
          candidate: {
            ...canonicalPlanCandidate,
            items: plan.items,
          },
          envelope: finalizedEnvelope,
          vaultName: this.vaultName,
          accountId: this.state.boundAccountId ?? "",
          automaticHandlingPolicy,
          baselineReconstructionIncomplete,
          pendingContentComparisons: this.state.pendingConflicts.map(
            (item) => ({
              path: item.path,
              contentComparison: item.contentComparison,
            }),
          ),
          resolveRemoteContentHash: resolveCanonicalRemoteContentHash,
        });
        contentEqualityBaseUpserts = finalizedCanonicalPlan.baseUpserts;
        plan.items = finalizedCanonicalPlan.items;
        canonicalPlanCandidate = finalizedCanonicalPlan;
        const verification = finalizedCanonicalPlan.contentVerification;
        if (verification.candidates > 0) {
          this.diag?.log(
            "plan",
            `V2 canonical content verification — ${verification.cachedEvidence} cached evidence candidate(s), ${verification.downloads} download candidate(s), ${verification.skippedDownloads} deferred`,
          );
          for (const item of verification.results) {
            if (item.outcome === "failed") {
              this.diag?.warn(
                "plan",
                `canonical content verification kept ${item.path} — ${item.error ?? "unknown failure"}`,
              );
            } else {
              this.diag?.log(
                "plan",
                `canonical content verification ${item.outcome.toUpperCase()} — ${item.path} via ${item.proof}`,
              );
            }
          }
        }
      }
      if (contentEqualityBaseUpserts.length > 0) {
        if (this.shouldStop(result, operationEpoch)) return result;
        if (!prepareV2MigrationCandidate) {
          await this.stageVerifiedLocalAncestorContent(
            contentEqualityBaseUpserts,
          );
          contentEqualityAncestorHashes =
            await this.state.upsertBaseEntries(contentEqualityBaseUpserts);
        }
        if (migrationCandidateEnvelope) {
          const unpublishedCandidateMeta = migrationCandidateEnvelope.meta;
          const contentFinalizedCandidate = upsertBaseStateEnvelopeV2(
            migrationCandidateEnvelope,
            contentEqualityBaseUpserts,
            unpublishedCandidateMeta.committedAt,
          );
          // Content verification is still part of constructing the first
          // unpublished migration candidate. The general V2 controller
          // increments commitSeq for an already authoritative envelope; do
          // not turn this in-memory preparation into a fictitious prior
          // publication.
          migrationCandidateEnvelope = {
            ...contentFinalizedCandidate,
            meta: { ...unpublishedCandidateMeta },
          };
        }
      }
      if (finalizedCanonicalPlan) {
        const committedEnvelope = migrationCandidateEnvelope
          ?? (
            typeof v2PlanState.getCommittedV2Envelope === "function"
              ? v2PlanState.getCommittedV2Envelope()
              : null
          );
        if (!canonicalFinalizationEnvelope || !committedEnvelope) {
          throw new Error(
            "V2 canonical sealing requires both source and committed envelopes",
          );
        }
        const sealed = sealCanonicalPlanV2({
          finalized: finalizedCanonicalPlan,
          sourceEnvelope: canonicalFinalizationEnvelope,
          committedEnvelope,
          ancestorHashesByPath: contentEqualityAncestorHashes,
          unpublishedMigrationCandidate: prepareV2MigrationCandidate,
        });
        finalizedCanonicalPlan = sealed;
        canonicalPlanCandidate = sealed;
        plan.items = sealed.items;
        plan.scope = { ...sealed.scope };
        plan.canonicalIdentity = sealed.canonicalIdentity;
        plan.canonicalReview = sealed.canonicalReview;
        this.diag?.log(
          "plan",
          `V2 canonical plan sealed at commit ${sealed.sourceCommitSeq}`,
          {
            sourceCommitSeq: sealed.sourceCommitSeq,
            actions: sealed.items.length,
            reviewImpact: sealed.canonicalReview.impactCount,
            digestBytes: sealed.canonicalIdentity.digest.length,
            mutations: 0,
          },
        );
      }

      const executableFolderPlan = canonicalPlanCandidate?.folderPlan ?? null;
      if (executableFolderPlan) {
        this.diag?.log(
          "plan",
          `V2 folder actions joined main plan — create-local=${executableFolderPlan.counts.createLocal}, create-remote=${executableFolderPlan.counts.createRemote}, move-local=${executableFolderPlan.counts.moveLocal}, move-remote=${executableFolderPlan.counts.moveRemote}, delete-local=${executableFolderPlan.counts.deleteLocal}, delete-remote=${executableFolderPlan.counts.deleteRemote}, conflicts=${executableFolderPlan.counts.conflicts}`,
          {
            phase: "plan",
            counts: executableFolderPlan.counts,
            reviewImpact: executableFolderPlan.reviewImpact,
            mutations: 0,
          },
        );
      }

      if (resumeCommittedV2Migration) {
        let hold = this.state.activeV2MigrationHold;
        const authorizationMatchesHold = Boolean(
          hold
          && reviewedAuthorization
          && reviewedAuthorization.revision === hold.revision
          && sameSyncScope(reviewedAuthorization.scope, hold.scope)
          && sameCanonicalPlanIdentityV2(
            reviewedAuthorization.canonicalIdentity,
            hold.canonicalIdentity,
          )
        );
        const exactPlanIdentity = Boolean(
          hold
          && plan.canonicalIdentity
          && sameCanonicalPlanIdentityV2(
            plan.canonicalIdentity,
            hold.canonicalIdentity,
          )
        );
        const currentEnvelope = this.state.getCommittedV2Envelope();
        const cursorPublicationRebind = Boolean(
          hold
          && plan.canonicalIdentity
          && currentEnvelope
          && sameStateV2MigrationResumeFacts(
            hold.candidate,
            currentEnvelope,
          )
          && migrationPlanFactsDigestV2({
            items: plan.items,
            lastTotalFiles: plan.lastTotalFiles,
            scope: plan.canonicalIdentity.scope,
          }) === hold.planFactsDigest
        );
        const authorizationMatches = authorizationMatchesHold
          && (exactPlanIdentity || cursorPublicationRebind);
        if (hold?.phase === "confirmed") {
          hold = await this.state.transitionV2MigrationHold(
            hold,
            "authority-committed",
          );
        }
        if (
          authorizationMatches
          && hold?.phase === "authority-committed"
        ) {
          plan.reviewKind = migrationHoldReviewKindV2(hold);
          plan.confirmed = true;
          migrationAuthorityCommittedThisRun = true;
          await publishCommunityPluginPostAuthorityState();
          migrationExecutionHold = hold;
          if (!exactPlanIdentity) {
            this.diag?.log(
              "state",
              "V2 migration resume rebound across a cursor-only state publication",
              {
                phase: "activation",
                reviewedCommitSeq:
                  hold.canonicalIdentity.sourceCommitSeq,
                currentCommitSeq:
                  plan.canonicalIdentity?.sourceCommitSeq,
                mutations: 0,
              },
            );
          }
        } else {
          const convergedAfterCommittedMigration = Boolean(
            hold?.phase === "authority-committed"
            && plan.items.length === 0
            && this.state.mutationLedger.length === 0
            && result.errors === 0
            && result.deferred === 0
            && result.conflicts === 0
          );
          if (convergedAfterCommittedMigration) {
            const completed = await this.state.transitionV2MigrationHold(
              hold!,
              "completed",
            );
            if (!completed) {
              throw new Error(
                "Converged V2 migration hold could not complete",
              );
            }
            plan.reviewKind = undefined;
            this.diag?.log(
              "state",
              "V2 migration transaction recovered as already converged",
              {
                phase: "activation",
                mutations: 0,
              },
            );
          } else {
            if (hold?.phase === "authority-committed") {
              await this.state.transitionV2MigrationHold(hold, "completed");
            } else if (hold?.phase === "pending" && reviewedAuthorization) {
              await this.state.clearPlanReview(reviewedAuthorization);
            }
            plan.reviewKind = undefined;
            this.diag?.warn(
              "state",
              "V2 migration resume facts changed; converted to a normal V2 review",
              {
                phase: "activation",
                mutations: 0,
              },
            );
            const publishPreview =
              callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
            if (publishPreview) {
              await waitForReview(() => publishPreview(plan));
            }
            result.message = this.t("result.pausedForReview");
            return result;
          }
        }
      }

      // Every pre-authority V2 entry path enters the same durable review
      // transaction. The review kind preserves whether this is a public
      // 1.1.3 migration, a join to existing cloud V2, or the first V2 device.
      if (attemptV2Activation) {
        if (
          !migrationCandidateEnvelope
          || !plan.canonicalIdentity
          || !plan.canonicalReview
          || activationReviewKind === null
        ) {
          throw new Error(
            "V2 activation requires a classified sealed candidate",
          );
        }
        const reviewKind = activationReviewKind;
        const migrationCommunityPluginEnablement =
          communityPluginEnablementWork?.migrationCarrier;
        if (communityPluginEnablementDecisionRequired) {
          const hold = await this.state.stageV2MigrationHold({
            candidate: migrationCandidateEnvelope,
            source: public113MigrationInput!,
            reviewKind,
            plan,
            communityPluginEnablement:
              migrationCommunityPluginEnablement,
          });
          this.diag?.warn(
            "state",
            "V2 migration held on source-bound community plugin enablement decisions",
            {
              phase: "activation",
              holdRevision: hold.revision,
              decisions:
                migrationCommunityPluginEnablement?.pending.length ?? 0,
              mutations: 0,
            },
          );
          return result;
        }
        plan.reviewKind = reviewKind;
        if (
          skipConfirmation
          && reviewedAuthorization?.reviewKind === reviewKind
        ) {
          const existingConfirmed = this.state.activeV2MigrationHold;
          const reviewedMigrationStillCurrent =
            (
              existingConfirmed?.phase === "confirmed"
              && sameCommunityPluginEnablementMigrationCarrierV2(
                existingConfirmed.communityPluginEnablement,
                migrationCommunityPluginEnablement,
              )
            )
            || await this.state.isCurrentV2MigrationAuthorization({
              authorization: reviewedAuthorization,
              candidate: migrationCandidateEnvelope,
              canonicalIdentity: plan.canonicalIdentity,
              communityPluginEnablement:
                migrationCommunityPluginEnablement,
            });
          let protocolBinding =
            existingConfirmed?.phase === "confirmed"
              ? existingConfirmed.protocolBinding
              : undefined;
          if (reviewedMigrationStillCurrent && !protocolBinding) {
            // Public 1.1.3 migration alone needs the dedicated upgrade-risk
            // acknowledgement. A reviewed first-sync plan may create the
            // initial record; cloud join must only adopt an existing record.
            if (
              reviewKind === "v2-migration"
              && options.acknowledgeMigrationRisk !== true
            ) {
              result.message = this.t("result.pausedForReview");
              this.diag?.warn(
                "state",
                "V2 migration remains paused until this device acknowledges the migration risk",
                { mutations: 0 },
              );
              return result;
            }
            const protocolTransport = availableSharedSyncProtocolTransportV2(
              this.onedrive,
              this.vaultName,
            );
            if (!protocolTransport) {
              result.errors = 1;
              result.message = this.t("result.v2ProtocolBlocked");
              this.diag?.error(
                "state",
                "shared V2 sync protocol transport is unavailable",
              );
              return result;
            }
            const protocol = await ensureSharedSyncProtocolV2(
              protocolTransport,
              {
                scope: syncScope,
                acknowledgeMigrationRisk:
                  reviewKind !== "v2-cloud-join",
              },
            );
            if (protocol.status === "acknowledgement-required") {
              result.errors = 1;
              result.message = this.t("result.v2ProtocolBlocked");
              this.diag?.error(
                "state",
                "reviewed cloud V2 join lost its shared protocol before authority commit",
              );
              return result;
            }
            if (protocol.status === "blocked") {
              result.errors = 1;
              result.message = this.t("result.v2ProtocolBlocked");
              this.diag?.error(
                "state",
                "shared V2 sync protocol could not be joined safely",
                { reason: protocol.reason, mutations: 0 },
              );
              return result;
            }
            protocolBinding = protocol.binding;
            this.diag?.log(
              "state",
              `shared V2 sync protocol joined from ${protocol.source}`,
              {
                protocolVersion: protocol.binding.protocolVersion,
                migrationGeneration:
                  protocol.binding.migrationGeneration.slice(0, 12),
                mutations: 0,
              },
            );
          }
          let confirmed: MigrationHoldV2 | null = null;
          if (reviewedMigrationStillCurrent) {
            confirmed = (
              existingConfirmed?.phase === "confirmed"
              && reviewedAuthorization.revision === existingConfirmed.revision
              && sameSyncScope(
                reviewedAuthorization.scope,
                existingConfirmed.scope,
              )
              && sameCanonicalPlanIdentityV2(
                reviewedAuthorization.canonicalIdentity,
                existingConfirmed.canonicalIdentity,
              )
              && sameCanonicalPlanIdentityV2(
                plan.canonicalIdentity,
                existingConfirmed.canonicalIdentity,
              )
              && sameStateV2MigrationCandidate(
                migrationCandidateEnvelope,
                existingConfirmed.candidate,
              )
              && sameCommunityPluginEnablementMigrationCarrierV2(
                migrationCommunityPluginEnablement,
                existingConfirmed.communityPluginEnablement,
              )
            )
              ? existingConfirmed
              : await this.state.confirmV2MigrationHold({
                  authorization: reviewedAuthorization,
                  candidate: migrationCandidateEnvelope,
                  canonicalIdentity: plan.canonicalIdentity,
                  communityPluginEnablement:
                    migrationCommunityPluginEnablement,
                  protocolBinding: protocolBinding!,
                });
          }
          if (confirmed) {
            const committed =
              await this.state.commitConfirmedV2MigrationHold(
                confirmed,
                Date.now(),
                takeOverPublic113MutationLedger
                  ? "legacy-mutation-recovery"
                  : "ordinary",
            );
            migrationAuthorityCommittedThisRun = true;
            await publishCommunityPluginPostAuthorityState();
            migrationExecutionHold = committed.hold;
            plan.confirmed = true;
            this.diag?.warn(
              "state",
              "V2 migration authority committed from the reviewed hold",
              {
                phase: "activation",
                holdRevision: committed.hold.revision,
                planItems: plan.items.length,
                mutations: 0,
              },
            );
            if (takeOverPublic113MutationLedger) {
              await this.recoverMutationLedger(
                syncScope,
                automaticHandlingMetrics,
              );
              if (this.shouldStop(result, operationEpoch)) return result;
              if (this.state.mutationLedger.length > 0) {
                throw new Error(
                  "Public 1.1.3 mutation recovery remains unresolved under V2 authority",
                );
              }
              const completed = await this.state.transitionV2MigrationHold(
                committed.hold,
                "completed",
              );
              if (!completed) {
                throw new Error(
                  "V2 migration hold did not complete after legacy mutation recovery",
                );
              }
              result.success = true;
              result.message = this.t("result.synced", {
                uploaded: 0,
                downloaded: 0,
                foldersCreated: 0,
                foldersMoved: 0,
                foldersDeleted: 0,
                filesMoved: 0,
                deleted: 0,
                conflicts: 0,
                deferred: 0,
                errors: 0,
              });
              result.continueAfterStateOnlyMigrationRecovery = true;
              return result;
            }
          } else {
            await this.state.stageV2MigrationHold({
              candidate: migrationCandidateEnvelope,
              source: public113MigrationInput!,
              reviewKind,
              plan,
              communityPluginEnablement:
                migrationCommunityPluginEnablement,
            });
            this.diag?.warn(
              "state",
              "V2 migration review changed before authority commit",
              {
                phase: "activation",
                planItems: plan.items.length,
                mutations: 0,
              },
            );
            const publishPreview =
              callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
            if (publishPreview) {
              await waitForReview(() => publishPreview(plan));
            }
            result.message = this.t("result.pausedForReview");
            return result;
          }
        } else {
          const hold = await this.state.stageV2MigrationHold({
            candidate: migrationCandidateEnvelope,
            source: public113MigrationInput!,
            reviewKind,
            plan,
            communityPluginEnablement:
              migrationCommunityPluginEnablement,
          });
          this.diag?.warn(
            "state",
            "V2 controlled activation held on a canonical migration plan",
            {
              phase: "activation",
              holdRevision: hold.revision,
              planItems: plan.items.length,
              mutations: 0,
            },
          );
          const publishPreview =
            callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
          if (publishPreview) {
            await waitForReview(() => publishPreview(plan));
          }
          result.message = this.t("result.pausedForReview");
          return result;
        }
      }

      // Every user-visible pending item must carry the exact reviewed
      // versions before a first-sync or threshold callback can persist it.
      if (!finalizedCanonicalPlan) {
        this.bindPendingDecisionTokens(plan);
      }

      if (options.readOnlyPreview) {
        const publishPreview = callbacks.onFirstSyncPreview ?? callbacks.onConfirmThreshold;
        if (publishPreview) await waitForReview(() => publishPreview(plan));
        this.diag?.warn(
          "plan",
          "explicit read-only preview enforced; Graph creates=0, file mutations=0",
          {
            scope: syncScope,
            counts: this.summarizePlanActions(plan),
            total: plan.items.length,
            sample: plan.items.slice(0, 10).map((item) => ({
              type: item.type,
              path: item.path,
              reason: item.reason,
            })),
            mutations: 0,
          },
        );
        result.message = this.t("result.pausedForReview");
        return result;
      }

      // A legacy namespace recovery is never executable in the same round.
      // Persist/show the corrected plan once, but ignore a callback that would
      // otherwise authorize immediate execution. The following round starts
      // from the clean committed snapshot and must pass normal revision gates.
      if (this.remoteRecoveryPreviewRequired) {
        const counts = this.summarizePlanActions(plan);
        const anomalies = plan.items
          .filter((item) => item.path.startsWith("files/") || item.path.startsWith(".easy-sync/"))
          .slice(0, 10)
          .map((item) => `${item.type}:${item.path}`);
        this.diag?.warn(
          "plan",
          "remote namespace recovery forced a read-only preview; file mutations=0",
          {
            scope: syncScope,
            counts,
            total: plan.items.length,
            priorBaseCount: baseEntries.length,
            anomalies,
            sample: plan.items.slice(0, 10).map((item) => ({
              type: item.type,
              path: item.path,
              reason: item.reason,
            })),
            mutations: 0,
          },
        );
        const publishPreview = callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
        if (publishPreview) await waitForReview(() => publishPreview(plan));
        result.message = this.t("result.pausedForReview");
        return result;
      }

      // If the user is executing a reviewed plan, verify the digest after all
      // pre-execution rewrites (scan health and dedup). The
      // reviewed bundle stays in state until this point so stale plans re-pause.
      if (
        skipConfirmation
        && this.state.planReviewActive
        && !migrationAuthorityCommittedThisRun
        && !attemptV2Activation
      ) {
        const authorizationIsCurrent = Boolean(
          reviewedAuthorization
          && reviewedAuthorization.revision === this.state.planReviewRevision
          && sameSyncScope(reviewedAuthorization.scope, this.state.planReviewScope)
          && sameSyncScope(reviewedAuthorization.scope, syncScope)
          && sameCanonicalPlanIdentityV2(
            reviewedAuthorization.canonicalIdentity,
            plan.canonicalIdentity,
          )
          && sameCanonicalPlanIdentityV2(
            this.state.planReviewCanonicalIdentity,
            plan.canonicalIdentity,
          )
        );
        if (!authorizationIsCurrent) {
          this.diag?.warn(
            "plan",
            "plan revision, scope, or canonical identity changed since review — re-pausing for confirmation",
          );
          if (callbacks.onConfirmThreshold) {
            await waitForReview(() => callbacks.onConfirmThreshold!(plan));
          }
          result.message = this.t("result.pausedForReview");
          return result;
        }
        const savedDigest = this.state.planReviewDigest;
        const currentDigest = plan.canonicalIdentity
          ? canonicalPlanDigestV2({
              items: plan.items,
              lastTotalFiles: plan.lastTotalFiles,
              scope: plan.canonicalIdentity.scope,
              sourceCommitSeq:
                plan.canonicalIdentity.sourceCommitSeq,
            })
          : planDigest(plan.items);
        const sealedIdentityChanged = Boolean(
          plan.canonicalIdentity
          && currentDigest !== plan.canonicalIdentity.digest
        );
        if (
          sealedIdentityChanged
          || (savedDigest && currentDigest !== savedDigest)
        ) {
          this.diag?.warn("plan", "plan changed since review — re-pausing for confirmation");
          const confirmed = callbacks.onConfirmThreshold
            ? await waitForReview(() => callbacks.onConfirmThreshold!(plan))
            : false;
          if (!confirmed) {
            result.message = this.t("result.pausedForReview");
            return result;
          }
          if (this.shouldStop(result, operationEpoch)) return result;
        }
        if (this.shouldStop(result, operationEpoch)) return result;
        const cleared = await this.state.clearPlanReview(reviewedAuthorization);
        if (!cleared) {
          this.diag?.warn("plan", "plan review changed before authorization commit — stopping before mutation");
          result.message = this.t("result.pausedForReview");
          return result;
        }
      }

      // Step 6: Threshold check (skip if user is confirming a reviewed plan)
      if (!finalizedCanonicalPlan) {
        throw new Error("V2 canonical plan was not finalized");
      }
      const authorizedJoinPaths = new Set(
        [...joinAuthorizationsByPluginId.values()].flatMap((authorization) =>
          authorization.members.map((member) => member.path)
        ),
      );
      const planContainsOnlyExplicitJoinDownloads = plan.items.length > 0
        && plan.items.every((item) =>
          item.type === SyncActionType.Download
          && authorizedJoinPaths.has(item.path)
        );
      const requiresThresholdConfirmation =
        finalizedCanonicalPlan.requiresThresholdConfirmation
        && !planContainsOnlyExplicitJoinDownloads;
      if (!skipConfirmation && requiresThresholdConfirmation) {
        if (callbacks.onConfirmThreshold) {
          const confirmed = await waitForReview(() => callbacks.onConfirmThreshold!(plan));
          if (!confirmed) {
            result.message = this.t("result.pausedForReview");
            return result;
          }
          if (this.shouldStop(result, operationEpoch)) return result;
        }
        plan.confirmed = true;
      }

      // Step 7: First sync preview (skip if user is confirming a reviewed plan)
      if (!skipConfirmation && mode === "first") {
        if (callbacks.onFirstSyncPreview) {
          const confirmed = await waitForReview(() => callbacks.onFirstSyncPreview!(plan));
          if (!confirmed) {
            result.message = this.t("result.pausedForReview");
            return result;
          }
          if (this.shouldStop(result, operationEpoch)) return result;
        }
        plan.confirmed = true;
      }

      // Authority may change only after every mandatory review gate has
      // authorized this exact zero-plan round. A declined first-sync preview
      // or a forced recovery preview must leave V1 authoritative.
      if (attemptV2Activation && !migrationAuthorityCommittedThisRun) {
        const structuredFileMutationPending =
          communityPluginEnablementWork?.prepared.localChanged === true
          || communityPluginEnablementWork?.prepared.remoteChanged === true;
        const activationReady = plan.items.length === 0
          && result.skippedLarge === 0
          && result.skippedIgnored === 0
          && !structuredFileMutationPending
          && localFolderScanComplete
          && this.state.mutationLedger.length === 0
          && !this.state.hasMutationLedgerCorruption
          && migrationRemoteItems !== null
          && migrationCandidateEnvelope !== null
          && plan.canonicalIdentity !== undefined
          && public113MigrationInput !== null;
        if (activationReady) {
          const migration =
            await this.state.activatePreparedV2MigrationCandidate({
              candidate: migrationCandidateEnvelope!,
              canonicalIdentity: plan.canonicalIdentity!,
              source: public113MigrationInput!,
            });
          this.diag?.log("state", `V2 controlled activation ${migration.status}`, {
            phase: "activation",
            status: migration.status,
            reason: migration.reason,
            pending: migration.pending.length,
            mutations: migration.mutations.length,
          });
          if (migration.status !== "committed" && migration.status !== "already-committed") {
            throw new Error(`V2 state activation aborted: ${migration.reason ?? "unknown"}`);
          }
          await publishCommunityPluginPostAuthorityState();
          if (
            this.state.planReviewActive
            && !this.state.activeV2MigrationHold
          ) {
            await this.state.clearPlanReview();
          }
        } else {
          this.diag?.warn("state", "V2 controlled activation held before mutation", {
            phase: "activation",
            planItems: plan.items.length,
            skippedLarge: result.skippedLarge,
            skippedIgnored: result.skippedIgnored,
            structuredFileMutationPending,
            localFolderScanComplete,
            planReviewActive: this.state.planReviewActive,
            pendingConflicts: this.state.pendingConflicts.length,
            pendingDeletes: this.state.pendingRemoteDeletes.length,
            pendingIssues: this.state.pendingIssues.length,
            mutationLedger: this.state.mutationLedger.length,
            remoteIdentityComplete: migrationRemoteItems !== null,
            mutations: 0,
          });
          result.message = this.t("result.pausedForReview");
          return result;
        }
      }

      // Pending decisions are ancillary UI state, not planning authority.
      // Prune them only after every review/activation gate has passed so a
      // preview never rewrites legacy state and a zero-plan migration can
      // archive the original public-1.1.3 snapshot before retiring stale UI.
      if (this.shouldStop(result, operationEpoch)) return result;
      await this.state.prunePendingConflicts(
        plan.items
          .filter((item) => item.type === SyncActionType.Conflict)
          .map((item) => item.path),
      );
      if (this.shouldStop(result, operationEpoch)) return result;
      await this.state.prunePendingDeletes(
        plan.items
          .filter((item) => item.type === SyncActionType.ConfirmLocalDelete
            || item.type === SyncActionType.DeleteLocal
            || (
              item.type === SyncActionType.DeleteLocalFolder
              && item.requiresConfirmation
            ))
          .map((item) => item.path),
      );
      if (this.shouldStop(result, operationEpoch)) return result;
      await this.state.prunePendingIssues(
        plan.items
          .filter((item) => isPendingIssueAction(item.type))
          .map((item) => item.path),
      );
      if (this.shouldStop(result, operationEpoch)) return result;

      // Step 8: Execute plan items
      enterPhase("transfer");
      this.progressStore?.setPhase("executing");
      await this.executePlan(
        plan,
        result,
        callbacks,
        operationEpoch,
        automaticHandlingPolicy,
        automaticHandlingMetrics,
        communityPluginSyncPolicy,
      );
      if (
        migrationExecutionHold
        && result.errors === 0
        && result.deferred === 0
        && this.state.mutationLedger.length === 0
      ) {
        const completed = await this.state.transitionV2MigrationHold(
          migrationExecutionHold,
          "completed",
        );
        if (!completed) {
          throw new Error(
            "V2 migration plan finished but its hold did not complete",
          );
        }
        migrationExecutionHold = completed;
      }
      if (
        communityPluginEnablementWork
        && result.errors === 0
        && result.conflicts === 0
        && result.deferred === 0
        && !this.shouldStop(result, operationEpoch)
      ) {
        try {
          await this.applyCommunityPluginEnablementWork(
            communityPluginEnablementWork,
            syncScope,
            result,
            callbacks,
            operationEpoch,
          );
        } catch (error) {
          if (
            error instanceof CommunityPluginEnablementVersionChangedError
            || (error instanceof OneDriveError && isRemoteMutationConflict(error))
          ) {
            result.deferred++;
            this.diag?.warn(
              "execute",
              "community plugin enablement changed during transfer; deferred",
              {
                side: error instanceof CommunityPluginEnablementVersionChangedError
                  ? error.side
                  : "remote",
                mutations: 0,
              },
            );
          } else {
            result.errors++;
            result.message = this.t("result.communityPluginEnablementInvalid");
            this.diag?.error(
              "execute",
              "community plugin enablement apply failed closed",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }
      enterPhase("commit");
      if (this.shouldStop(result, operationEpoch)) return result;

      if (this.state.remoteGeneration !== this.startGeneration) {
        result.message = this.t("result.generationMismatch");
        this.diag?.warn("execute", `generation mismatch after executePlan (${this.startGeneration} → ${this.state.remoteGeneration}), aborting`);
        return result;
      }

      const completedCommunityPluginRestores =
        await this.detectCompletedCommunityPluginRestores(
          communityPluginSyncPolicy,
          remoteEntries,
          configDir,
          [...joinAuthorizationsByPluginId.keys()],
        );
      if (
        completedCommunityPluginRestores.files.length > 0
        || completedCommunityPluginRestores.data.length > 0
      ) {
        result.communityPluginRestoresCompleted =
          completedCommunityPluginRestores;
      }

      // Step 9: Mark healthy sync — only when no conflicts, pending deletes,
      // errors, skipped files, or auth issues remain.
      const isHealthy = !result.authExpired
        && !this.cancelled
        && this.lifecycle.isCurrent(operationEpoch)
        && result.errors === 0
        && result.conflicts === 0
        && result.deferred === 0
        && result.skippedLarge === 0
        && result.skippedIgnored === 0;
      if (isHealthy) {
        if (
          seededBaseEntries.length > 0
          && !seededBaseEntriesPersisted
        ) {
          if (this.shouldStop(result, operationEpoch)) return result;
          await this.persistSeededBaseEntries(seededBaseEntries);
        }
        if (this.shouldStop(result, operationEpoch)) return result;
        await this.state.setLastSyncTime(Date.now());
        if (this.shouldStop(result, operationEpoch)) return result;
        await this.state.incrementRemoteGeneration();
        if (this.shouldStop(result, operationEpoch)) return result;
        await this.publishHealthyCloudBootstrapV2(
          operationEpoch,
        );
      }

      result.success = !result.authExpired
        && !this.cancelled
        && result.errors === 0;
      // Preserve message set by executePlan (e.g. auth expired, cancelled)
      if (!result.message) {
        const skipped = result.skippedLarge + result.skippedIgnored;
        const resultKey = result.errors > 0
          ? "result.partial"
          : result.conflicts > 0
            ? "result.conflictsPending"
            : result.deferred > 0
              ? "result.deferred"
              : skipped > 0
                ? "result.skipped"
                : "result.synced";
        result.message = this.t(resultKey, {
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          foldersCreated: result.foldersCreated ?? 0,
          foldersMoved: result.foldersMoved ?? 0,
          foldersDeleted: result.foldersDeleted ?? 0,
          filesMoved: result.filesMoved ?? 0,
          deleted: result.deleted,
          conflicts: result.conflicts,
          deferred: result.deferred,
          skipped,
          errors: result.errors,
        });
      }

    } catch (e) {
      if (e instanceof AuthError) {
        this.invalidateLifecycle("auth-expired");
        result.authExpired = true;
        result.message = this.t("result.authExpired");
        result.success = false;
      } else if (!this.canContinue(operationEpoch, result)) {
        // An aborted Graph observation can surface as the same status-0
        // NetworkError used for a genuine outage. Lifecycle invalidation is
        // authoritative: cancellation must never arm cross-round retries.
        this.markCancelled(result);
        result.success = false;
      } else {
        if (e instanceof MutationRecoveryBlockedError) {
          result.mutationRecovery = e.summary;
        } else if (
          this.state.isV2StateActive
          && this.state.mutationLedger.length > 0
          && isRetryableMutationRecoveryObservationError(e)
        ) {
          const remaining = this.state.mutationLedger.length;
          const total = Math.max(recoveryRecordsAtStart, remaining);
          result.mutationRecovery = {
            state: "network-unavailable",
            total,
            settled: Math.max(0, total - remaining),
            remaining,
            retryAfterSeconds: e.retryAfterSeconds,
          };
        } else if (
          this.state.isV2StateActive
          && this.state.mutationLedger.length > 0
          && result.mutationRecovery === undefined
        ) {
          const remaining = this.state.mutationLedger.length;
          const total = Math.max(recoveryRecordsAtStart, remaining);
          result.mutationRecovery = {
            state: "blocked",
            total,
            settled: Math.max(0, total - remaining),
            remaining,
            retryAfterSeconds: null,
            blockReason: this.state.hasMutationLedgerCorruption
              ? "evidence-corrupt"
              : "state-unavailable",
          };
        }
        unexpectedFailure = true;
        result.errors = Math.max(1, result.errors);
        result.message = this.t("result.syncFailed", { message: e instanceof Error ? e.message : "unknown error" });
        this.diag?.error(
          "execute",
          "sync run failed unexpectedly",
          e instanceof Error ? e.message : String(e),
        );
      }
    } finally {
      finishActivePhase();
      const networkMetrics = collectNetworkMetrics
        ? this.onedrive.finishRunMetrics()
        : null;
      if (networkMetrics) {
        this.diag?.log("onedrive", "sync network summary", networkMetrics);
      }
      if (result.metrics) {
        this.diag?.log("execute", "sync file transfer summary", {
          schemaVersion: 2,
          platform: Platform.isMobile ? "mobile" : "desktop",
          upload: result.metrics.fileTransfers.upload,
          download: result.metrics.fileTransfers.download,
        });
      }
      automaticHandlingMetrics.recoveryPendingAtEnd = {
        deleteLocal: this.state.mutationLedger.filter(
          (entry) => entry.intent.action === "deleteLocal",
        ).length,
        merge: this.state.mutationLedger.filter(
          (entry) => entry.intent.action === "merge",
        ).length,
      };
      this.diag?.log(
        "execute",
        "sync automatic handling summary",
        {
          schemaVersion: 1,
          ...automaticHandlingMetrics,
        },
      );
      this.diag?.log("lifecycle", "sync run phase summary", {
        schemaVersion: 2,
        platform: Platform.isMobile ? "mobile" : "desktop",
        mode,
        status: result.success
          ? "success"
          : result.authExpired
            ? "authExpired"
            : this.cancelled
              ? "cancelled"
              : unexpectedFailure || result.errors > 0
                ? "failed"
                : "stopped",
        readOnlyPreview: options.readOnlyPreview === true,
        counts: {
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          deleted: result.deleted,
          conflicts: result.conflicts,
          deferred: result.deferred,
          errors: result.errors,
          skippedLarge: result.skippedLarge,
          skippedIgnored: result.skippedIgnored,
        },
        phasesMs,
        totalMs: Math.max(0, Date.now() - runStartedAt),
      });
      this.onedrive.setAbortSignal(null);
      this.cancelController = null;
      this.activeSyncScope = null;
      this.running = false;
      this.progressStore?.finish();
      callbacks.onStateChange?.();
    }

    return result;
  }

  private async detectCompletedCommunityPluginRestores(
    policy: Readonly<CommunityPluginSyncPolicyV1>,
    remoteEntries: readonly RemoteFileEntry[],
    configDir: string,
    restoringFilePluginIds: readonly string[],
  ): Promise<{ files: string[]; data: string[] }> {
    const restoringFiles = new Set(restoringFilePluginIds);
    const restoringData = new Set(getRestoringPluginIds(policy.data));
    if (restoringFiles.size === 0 && restoringData.size === 0) {
      return { files: [], data: [] };
    }

    const remoteFiles = new Map<string, RemoteFileEntry[]>();
    const remoteData = new Map<string, RemoteFileEntry>();
    for (const entry of remoteEntries) {
      const classified = classifyCommunityPluginManagedPath(
        entry.path,
        configDir,
      );
      if (!classified || classified.kind === "enablement") continue;
      if (classified.kind === "data") {
        if (restoringData.has(classified.pluginId)) {
          remoteData.set(classified.pluginId, entry);
        }
        continue;
      }
      if (!restoringFiles.has(classified.pluginId)) continue;
      const entries = remoteFiles.get(classified.pluginId) ?? [];
      entries.push(entry);
      remoteFiles.set(classified.pluginId, entries);
    }

    const locallyMatchesCommittedRemote = async (
      remote: RemoteFileEntry,
    ): Promise<boolean> => {
      const base = this.state.getBaseEntry(remote.path);
      if (!base || base.size !== remote.size) return false;
      const remoteVersionMatches = remote.sha256Hash
        ? remoteContentMatchesBase(remote, base)
        : base.eTag === remote.eTag;
      if (!remoteVersionMatches) return false;
      try {
        const content = await this.scanner.vault.adapter.readBinary(
          remote.path,
        );
        return content.byteLength === base.size
          && await sha256Hex(content) === base.hash;
      } catch {
        return false;
      }
    };

    const files: string[] = [];
    for (const pluginId of [...restoringFiles].sort()) {
      const entries = remoteFiles.get(pluginId) ?? [];
      if (entries.length === 0) continue;
      const names = new Set(entries.map((entry) =>
        parseCommunityPluginBundlePath(entry.path, configDir)?.fileName));
      if (!names.has("main.js") || !names.has("manifest.json")) continue;
      if ((await Promise.all(
        entries.map(locallyMatchesCommittedRemote),
      )).every(Boolean)) {
        files.push(pluginId);
      }
    }

    const data: string[] = [];
    for (const pluginId of [...restoringData].sort()) {
      const remote = remoteData.get(pluginId);
      if (remote && await locallyMatchesCommittedRemote(remote)) {
        data.push(pluginId);
      }
    }
    return { files, data };
  }

  /** Execute plan items with per-file persistence */
  private async executePlan(
    plan: SyncPlan,
    result: SyncResult,
    callbacks: SyncCallbacks,
    operationEpoch: number,
    automaticHandlingPolicy: Readonly<AutomaticHandlingPolicy>,
    automaticHandlingMetrics: AutomaticHandlingMetrics,
    communityPluginSyncPolicy: Readonly<CommunityPluginSyncPolicyV1>,
  ): Promise<void> {
    const startedAt = Date.now();
    let total = plan.items.length;
    const pendingConflicts: SyncPlanItem[] = [];
    const pendingDeletes: SyncPlanItem[] = [];
    const pendingIssues: PendingIssue[] = [];
    const resolvedIssuePaths = new Set<string>();
    const remoteUpserts: RemoteFileEntry[] = [];
    const remoteDeletes: string[] = [];
    // P1-a: collect base entry updates for batch persistence after pools drain
    const baseUpserts: BaseFileEntry[] = [];
    const baseRemovals: string[] = [];
    const metrics: ExecutionMetrics = {
      uploadBytes: 0,
      uploadReadMs: 0,
      uploadNetworkMs: 0,
      activeUploads: 0,
      peakUploads: 0,
      fileTransfers: {
        upload: createFileTransferMetrics(),
        download: createFileTransferMetrics(),
      },
      automaticHandling: automaticHandlingMetrics,
    };
    // Attach the live accumulator immediately so cancellations and early
    // checkpoint failures retain the file-level outcome evidence.
    result.metrics = metrics;
    const isSmallUpload = (i: SyncPlanItem) =>
      i.type === SyncActionType.Upload && Boolean(i.local)
      && i.local!.size <= CONCURRENT_UPLOAD_MAX_BYTES;
    const isLargeUpload = (i: SyncPlanItem) =>
      i.type === SyncActionType.Upload && Boolean(i.local)
      && i.local!.size > CONCURRENT_UPLOAD_MAX_BYTES;
    const isDownload = (i: SyncPlanItem) =>
      i.type === SyncActionType.Download
      || i.type === SyncActionType.RenameRemote
      || i.type === SyncActionType.MoveLocalFile;
    const isFolderCreate = (i: SyncPlanItem) =>
      i.type === SyncActionType.CreateLocalFolder
      || i.type === SyncActionType.CreateRemoteFolder;
    const isFolderMove = (i: SyncPlanItem) =>
      i.type === SyncActionType.MoveLocalFolder
      || i.type === SyncActionType.MoveRemoteFolder;
    const isFolderDelete = (i: SyncPlanItem) =>
      i.type === SyncActionType.DeleteLocalFolder
      || i.type === SyncActionType.DeleteRemoteFolder;
    const isCleanup = (i: SyncPlanItem) =>
      i.type === SyncActionType.DeleteRemote || i.type === SyncActionType.DeleteLocal;
    const isPassthrough = (i: SyncPlanItem) =>
      !isFolderCreate(i) && !isFolderMove(i) && !isFolderDelete(i)
      && !isSmallUpload(i) && !isLargeUpload(i) && !isDownload(i) && !isCleanup(i);

    const folderCreates  = plan.items.filter(isFolderCreate);
    const folderMoves    = plan.items.filter(isFolderMove);
    const folderDeletes  = plan.items.filter(isFolderDelete);
    const smallUploads   = plan.items.filter(isSmallUpload);
    const largeUploads   = plan.items.filter(isLargeUpload);
    const downloads      = plan.items.filter(isDownload);
    const cleanupItems   = plan.items.filter(isCleanup);
    const passthroughItems = plan.items.filter(isPassthrough);
    metrics.automaticHandling.deleteLocal.candidates =
      automaticHandlingPolicy.autoDeleteLocalFiles
        ? cleanupItems.filter((item) => item.type === SyncActionType.DeleteLocal).length
        : 0;

    // Effective concurrency — cap lower on mobile to avoid memory-pressure kills
    const uploadConc = Platform.isMobile ? MOBILE_SMALL_UPLOAD_CONCURRENCY : SMALL_UPLOAD_CONCURRENCY;
    const largeUploadConc = Platform.isMobile ? MOBILE_LARGE_UPLOAD_CONCURRENCY : LARGE_UPLOAD_CONCURRENCY;
    const downloadPolicy = new DownloadConcurrencyPolicy();

    // M11: mobile file-size guard — warn when the configured limit exceeds the
    // validated safe ceiling (100 MiB). Real-device stair-step validation pending.
    if (Platform.isMobile && this.scanner.getMaxFileSize() > 100 * 1024 * 1024) {
      this.diag?.warn("execute", `mobile maxFileSize=${this.scanner.getMaxFileSize()} exceeds validated 100 MiB ceiling — large files may OOM or timeout`);
    }

    // M19: anti-downgrade guard for EasySync self-sync.
    // Before any plugin files are downloaded, fetch remote manifest.json and
    // compare versions. If remote < local, skip all EasySync downloads this round.
    const { pluginDirPrefix } = getEasySyncPaths(this.scanner.vault);
    const easySyncDownloads = downloads.filter((i) =>
      i.path.startsWith(pluginDirPrefix));
    if (easySyncDownloads.length > 0) {
      const skipped = await this.guardEasySyncDowngrade(easySyncDownloads);
      if (skipped > 0) {
        // Remove skipped items from the download pool
        const skippedPaths = new Set(easySyncDownloads.slice(0, skipped).map((i) => i.path));
        const origLen = downloads.length;
        for (let i = downloads.length - 1; i >= 0; i--) {
          if (skippedPaths.has(downloads[i].path)) downloads.splice(i, 1);
        }
        total -= origLen - downloads.length;
        this.diag?.log("execute", `M19 anti-downgrade — skipped ${skipped} EasySync file(s), remote version is older`);
      }
    }

    let started = 0;
    this.progressStore?.setProgress(0, total, "");
    callbacks.onProgress?.(0, total, "");
    this.diag?.log(
      "execute",
      `pools — folders=${folderCreates.length} small=${smallUploads.length}(${uploadConc}) large=${largeUploads.length}(${largeUploadConc}) download=${downloads.length}(adaptive 1→3 desktop small files) passthrough=${passthroughItems.length} cleanup=${cleanupItems.length}`,
    );

    const executePlanItem = async (
      item: SyncPlanItem,
      preparedDownload?: PreparedDownload,
    ): Promise<void> => {
      if (!this.canContinue(operationEpoch, result)) return;
      const position = ++started;
      this.progressStore?.setProgress(position, total, item.path, item.type);
      callbacks.onProgress?.(position, total, item.path);

      const fileSize = fileSizeForAction(item, item.type);
      const localHash = item.local?.hash;
      const remoteETag = item.remote?.eTag;
      let mutationIntent: MutationIntent | null = null;
      const remoteUpsertStart = remoteUpserts.length;
      const remoteDeleteStart = remoteDeletes.length;
      const transferDirection = item.type === SyncActionType.Upload
        ? "upload"
        : item.type === SyncActionType.Download
          ? "download"
          : null;
      const transferMetrics = transferDirection
        ? metrics.fileTransfers[transferDirection]
        : null;
      const transferAlreadyStarted = transferDirection === "download"
        && preparedDownload !== undefined;
      const completedBefore = transferDirection === "upload"
        ? result.uploaded
        : result.downloaded;
      const deletedBefore = result.deleted;
      const foldersCreatedBefore = result.foldersCreated ?? 0;
      const foldersMovedBefore = result.foldersMoved ?? 0;
      const foldersDeletedBefore = result.foldersDeleted ?? 0;
      const filesMovedBefore = result.filesMoved ?? 0;
      const automaticMergeCandidatesBefore =
        metrics.automaticHandling.textMerge.candidates;
      const automaticMergeSettledBefore =
        metrics.automaticHandling.textMerge.completed
        + metrics.automaticHandling.textMerge.keptManual
        + metrics.automaticHandling.textMerge.failed
        + metrics.automaticHandling.textMerge.cancelled;
      let transferOutcome: "succeeded" | "failed" | "cancelled" | "skipped" | null = null;
      let automaticDeleteCompleted = false;
      if (transferMetrics && !transferAlreadyStarted) {
        transferMetrics.started++;
        transferMetrics.activeConcurrency++;
        transferMetrics.peakConcurrency = Math.max(
          transferMetrics.peakConcurrency,
          transferMetrics.activeConcurrency,
        );
      }

      try {
        this.diag?.log("execute", `[${position}/${total}] ${item.type} ${item.path}`);
        if (preparedDownload?.error) throw preparedDownload.error;
        mutationIntent = plan.scope
          && isMutationAction(item.type)
          && !item.requiresConfirmation
          ? this.createMutationIntent(item, plan.scope)
          : null;
        if (mutationIntent) await this.state.beginMutationIntent(mutationIntent);
        const itemResult = await this.executeItem(
          item,
          result,
          remoteUpserts,
          remoteDeletes,
          metrics,
          callbacks,
          operationEpoch,
          automaticHandlingPolicy,
          preparedDownload,
        );
        if (mutationIntent && !itemResult.mutationApplied) {
          await this.state.abandonMutationIntent(mutationIntent.operationId);
        }
        if (mutationIntent && itemResult.mutationApplied) {
          const checkpoint = emptyMutationCheckpoint();
          checkpoint.remoteUpserts.push(...remoteUpserts.splice(remoteUpsertStart));
          checkpoint.remoteDeletes.push(...remoteDeletes.splice(remoteDeleteStart));
          if (itemResult.baseUpsert) checkpoint.baseUpserts.push(itemResult.baseUpsert);
          if (itemResult.baseRemoval) checkpoint.baseRemovals.push(itemResult.baseRemoval);
          if (itemResult.folderUpsert) checkpoint.folderUpserts = [itemResult.folderUpsert];
          if (itemResult.folderDelete) checkpoint.folderDeletes = [itemResult.folderDelete];
          if (
            isFolderMove(item)
            || isFolderDelete(item)
          ) {
            const remoteId = item.folder?.remoteId;
            if (remoteId) {
              checkpoint.folderMoveHintRemovals = isFolderMove(item) && item.renameFrom
                ? this.folderIdentityIdsAtOrBelow(item.renameFrom)
                : [remoteId];
            }
          }
          if (automaticHandlingPolicy.autoDeleteLocalFiles
            && item.type === SyncActionType.DeleteLocal) {
            checkpoint.pendingDeleteRemovals.push(item.path);
          }
          const receipt: MutationReceiptV1 = {
            version: 1,
            operationId: mutationIntent.operationId,
            completedAt: Date.now(),
            checkpoint,
          };
          await this.state.recordMutationReceipt(receipt);
          if (!this.canContinue(operationEpoch, result)) return;
          await this.commitMutationCheckpoint(mutationIntent.operationId);
          if (item.type === SyncActionType.DeleteLocal) {
            metrics.automaticHandling.deleteLocal.completed++;
            automaticDeleteCompleted = true;
          }
          itemResult.baseUpsert = undefined;
          itemResult.baseRemoval = undefined;
        }
        if (!this.canContinue(operationEpoch, result)) return;
        if (!itemResult.executed) {
          transferOutcome = transferMetrics ? "skipped" : null;
          if (itemResult.completionReason) {
            const completionActionType =
              itemResult.completionActionType ?? item.type;
            callbacks.onFileComplete?.(
              item.path,
              completionActionType,
              true,
              itemResult.completionReason,
              fileSizeForAction(item, completionActionType),
            );
          }
          return;
        }
        if (transferMetrics && transferDirection) {
          const completedAfter = transferDirection === "upload"
            ? result.uploaded
            : result.downloaded;
          if (completedAfter > completedBefore) {
            transferOutcome = "succeeded";
            transferMetrics.logicalBytes += Math.max(0, fileSize ?? 0);
          } else {
            transferOutcome = "skipped";
          }
        }
        // P1-a: collect deferred base entry updates for batch persistence
        if (itemResult.baseUpsert) baseUpserts.push(itemResult.baseUpsert);
        if (itemResult.baseRemoval) baseRemovals.push(itemResult.baseRemoval);
        if (item.type === SyncActionType.Conflict && !itemResult.resolvedConflict) {
          pendingConflicts.push(this.withDecisionToken(item));
        } else if (item.type === SyncActionType.ConfirmLocalDelete) {
          pendingDeletes.push(this.withDecisionToken(item));
        } else if (
          item.type === SyncActionType.DeleteLocalFolder
          && item.requiresConfirmation
        ) {
          pendingDeletes.push(item);
        }
        if (
          item.type === SyncActionType.RetryLater
          || item.type === SyncActionType.FolderDeferred
        ) {
          const reason = item.reason
            ? this.t(item.reason)
            : this.t("syncView.failure.local");
          pendingIssues.push({
            path: item.path,
            actionType: item.type,
            reason,
            updatedAt: Date.now(),
            fileSize,
            localHash,
            remoteETag,
            consecutiveFailures: 1,
          });
          callbacks.onFileComplete?.(item.path, item.type, false, reason, fileSize);
          return;
        }
        if (item.type === SyncActionType.SkipLargeFile) {
          const reason = item.reason
            ? this.t(item.reason)
            : this.t("syncView.fileStatus.skip");
          pendingIssues.push({
            path: item.path,
            actionType: item.type,
            reason,
            updatedAt: Date.now(),
            fileSize,
            localHash,
            remoteETag,
          });
          callbacks.onFileComplete?.(item.path, item.type, true, reason, fileSize);
          return;
        }
        if (isResolvedIssueAction(item.type)) {
          resolvedIssuePaths.add(item.path);
          if (item.renameFrom) resolvedIssuePaths.add(item.renameFrom);
        }
        const completionActionType =
          itemResult.completionActionType ?? item.type;
        const completionFileSize = fileSizeForAction(
          item,
          completionActionType,
        );
        if (item.renameFrom) {
          callbacks.onFileComplete?.(
            item.path,
            completionActionType,
            true,
            itemResult.completionReason,
            completionFileSize,
            item.renameFrom,
          );
        } else {
          callbacks.onFileComplete?.(
            item.path,
            completionActionType,
            true,
            itemResult.completionReason,
            completionFileSize,
          );
        }
      } catch (e) {
        let mutationRecovery: SideMutationRecoveryOutcome | null = null;
        let retryableRecoveryObservationError: OneDriveError | null = null;
        const activeIntent = mutationIntent;
        const activeRecord = activeIntent
          ? this.state.mutationLedger.find(
              (entry) => entry.intent.operationId === activeIntent.operationId,
            )
          : undefined;
        if (activeIntent && e instanceof MutationNotAppliedError) {
          try {
            await this.abandonKnownUnappliedMutation(
              activeIntent,
              "mutation stopped before target change and was abandoned",
            );
            mutationRecovery = "not-applied";
          } catch (abandonError) {
            this.diag?.warn(
              "execute",
              `mutation could not abandon its precondition-failed intent — ${activeIntent.path}`,
              abandonError instanceof Error
                ? abandonError.message
                : String(abandonError),
            );
            mutationRecovery = "unresolved";
          }
        } else if (activeIntent && activeRecord?.receipt) {
          try {
            await this.commitMutationCheckpoint(
              activeIntent.operationId,
            );
            this.diag?.warn(
              "execute",
              `recorded mutation checkpoint retried in the same action — ${activeIntent.path}`,
            );
            mutationRecovery = "applied";
          } catch (checkpointError) {
            this.diag?.warn(
              "execute",
              `recorded mutation checkpoint retry failed — ${activeIntent.path}`,
              checkpointError instanceof Error
                ? checkpointError.message
                : String(checkpointError),
            );
            mutationRecovery = "unresolved";
          }
        } else if (activeIntent && activeRecord) {
          const recovery = await this.reconcileFailedMutation(activeIntent);
          mutationRecovery = recovery.outcome;
          retryableRecoveryObservationError =
            recovery.retryableObservationError;
        }
        if (mutationRecovery === "applied") {
          if (!this.canContinue(operationEpoch, result)) {
            transferOutcome = transferMetrics ? "cancelled" : null;
            return;
          }
          if (item.type === SyncActionType.Upload && result.uploaded === completedBefore) {
            result.uploaded++;
            metrics.uploadBytes += Math.max(0, fileSize ?? 0);
          } else if (item.type === SyncActionType.Download && result.downloaded === completedBefore) {
            result.downloaded++;
          } else if (
            (item.type === SyncActionType.DeleteLocal || item.type === SyncActionType.DeleteRemote)
            && result.deleted === deletedBefore
          ) {
            result.deleted++;
          } else if (isFolderCreate(item)
            && (result.foldersCreated ?? 0) === foldersCreatedBefore) {
            result.foldersCreated = foldersCreatedBefore + 1;
          } else if (isFolderMove(item)
            && (result.foldersMoved ?? 0) === foldersMovedBefore) {
            result.foldersMoved = foldersMovedBefore + 1;
          } else if (isFolderDelete(item)
            && (result.foldersDeleted ?? 0) === foldersDeletedBefore) {
            result.foldersDeleted = foldersDeletedBefore + 1;
          } else if (
            (item.type === SyncActionType.MoveLocalFile
              || (item.type === SyncActionType.RenameRemote
                && Boolean(item.targetParentRemoteId)))
            && (result.filesMoved ?? 0) === filesMovedBefore) {
            result.filesMoved = filesMovedBefore + 1;
          }
          if (automaticHandlingPolicy.autoDeleteLocalFiles
            && item.type === SyncActionType.DeleteLocal
            && !automaticDeleteCompleted) {
            metrics.automaticHandling.deleteLocal.completed++;
            automaticDeleteCompleted = true;
          }
          if (transferMetrics) {
            transferOutcome = "succeeded";
            transferMetrics.logicalBytes += Math.max(0, fileSize ?? 0);
          }
          if (isResolvedIssueAction(item.type)) {
            resolvedIssuePaths.add(item.path);
            if (item.renameFrom) resolvedIssuePaths.add(item.renameFrom);
          }
          if (item.renameFrom) {
            callbacks.onFileComplete?.(
              item.path,
              item.type,
              true,
              undefined,
              fileSize,
              item.renameFrom,
            );
          } else {
            callbacks.onFileComplete?.(
              item.path,
              item.type,
              true,
              undefined,
              fileSize,
            );
          }
          return;
        }
        if (automaticHandlingPolicy.autoDeleteLocalFiles
          && item.type === SyncActionType.DeleteLocal
          && !automaticDeleteCompleted) {
          metrics.automaticHandling.deleteLocal.failed++;
        }
        const automaticMergeSettledAfter =
          metrics.automaticHandling.textMerge.completed
          + metrics.automaticHandling.textMerge.keptManual
          + metrics.automaticHandling.textMerge.failed
          + metrics.automaticHandling.textMerge.cancelled;
        if (metrics.automaticHandling.textMerge.candidates > automaticMergeCandidatesBefore
          && automaticMergeSettledAfter === automaticMergeSettledBefore) {
          metrics.automaticHandling.textMerge.failed++;
        }
        if (this.cancelled && !result.authExpired) {
          transferOutcome = transferMetrics ? "cancelled" : null;
          this.diag?.log("execute", `[${position}/${total}] ${item.type} ${item.path} aborted after cancellation`);
          return;
        }
        transferOutcome = transferMetrics ? "failed" : null;
        this.diag?.error("execute", `[${position}/${total}] ${item.type} ${item.path} FAILED: ${e instanceof Error ? e.message : String(e)}`, errorDiagData(e));
        // Auth failure at any file stops the entire pool immediately —
        // no point letting other workers continue with a dead token.
        if (isAuthFailure(e)) {
          result.authExpired = true;
          result.message = this.t("result.authExpired");
          this.invalidateLifecycle("auth-expired");
          callbacks.onFileComplete?.(item.path, item.type, false, this.failureReason(e), fileSize);
          return;
        }
        result.errors++;
        if (
          retryableRecoveryObservationError
          && this.state.isV2StateActive
          && this.state.mutationLedger.length > 0
        ) {
          const remaining = this.state.mutationLedger.length;
          const previous = result.mutationRecovery;
          const retryAfterSeconds =
            retryableRecoveryObservationError.retryAfterSeconds;
          result.mutationRecovery = {
            state: "network-unavailable",
            total: Math.max(previous?.total ?? 0, remaining),
            settled: previous?.settled ?? 0,
            remaining,
            retryAfterSeconds:
              previous?.retryAfterSeconds === null
                ? retryAfterSeconds
                : retryAfterSeconds === null
                  ? previous?.retryAfterSeconds ?? null
                  : Math.max(
                      previous?.retryAfterSeconds ?? 0,
                      retryAfterSeconds,
                    ),
          };
        }
        const reason = this.failureReason(e);
        pendingIssues.push({
          path: item.path,
          actionType: item.type,
          reason,
          updatedAt: Date.now(),
          fileSize,
          localHash,
          remoteETag,
          consecutiveFailures: 1,
        });
        callbacks.onFileComplete?.(item.path, item.type, false, reason, fileSize);
      } finally {
        if (transferMetrics) {
          const outcome = transferOutcome ?? "cancelled";
          transferMetrics[outcome]++;
          if (!transferAlreadyStarted) {
            transferMetrics.activeConcurrency = Math.max(0, transferMetrics.activeConcurrency - 1);
          }
        }
      }
    };

    // Step 1 — create folders parent-first so every later file mutation has a
    // committed destination parent identity on both sides.
    for (const item of folderCreates) {
      if (!this.canContinue(operationEpoch, result)) break;
      await executePlanItem(item);
    }

    // Step 1b — identity moves run after creates, before file mutations. A
    // top-level folder receipt reprojects the entire committed subtree.
    for (const item of folderMoves) {
      if (!this.canContinue(operationEpoch, result)) break;
      await executePlanItem(item);
    }

    // Step 2 — passthrough items (no network I/O)
    for (const item of passthroughItems) {
      if (!this.canContinue(operationEpoch, result)) break;
      await executePlanItem(item);
    }

    const uploadItems = [...smallUploads, ...largeUploads];
    const communityPluginUploadErrors =
      await this.prepareCommunityPluginBundleUploads(
        uploadItems,
        communityPluginSyncPolicy,
        result,
        operationEpoch,
      );

    // Step 3a — uploads remain serial while every mutation owns one durable
    // intent/receipt checkpoint.
    for (const item of uploadItems) {
      if (!this.canContinue(operationEpoch, result)) break;
      const preflightError = communityPluginUploadErrors.get(item.path);
      await executePlanItem(
        item,
        preflightError === undefined ? undefined : { error: preflightError },
      );
    }

    let visibleBundleRoot = "";
    const preparedCommunityPluginDownloads =
      await this.prepareCommunityPluginBundleDownloads(
        downloads,
        communityPluginSyncPolicy,
        metrics,
        result,
        operationEpoch,
        (root, downloaded, totalBytes) => {
          if (visibleBundleRoot !== root) {
            visibleBundleRoot = root;
            const position = total > 0
              ? Math.min(started + 1, total)
              : 0;
            this.progressStore?.setProgress(
              position,
              total,
              root,
              SyncActionType.Download,
            );
            callbacks.onProgress?.(position, total, root);
          }
          callbacks.onFileProgress?.(downloaded, totalBytes);
        },
      );

    // Step 3b — only the read-only network stage of independent desktop small
    // downloads may overlap. Local CAS, temp verification, intent/receipt and
    // checkpoint publication below remain strictly serial per file.
    let downloadIndex = 0;
    while (downloadIndex < downloads.length && this.canContinue(operationEpoch, result)) {
      const first = downloads[downloadIndex];
      const preparedCommunityPluginDownload =
        preparedCommunityPluginDownloads.get(first.path);
      if (preparedCommunityPluginDownload) {
        await executePlanItem(first, preparedCommunityPluginDownload);
        downloadIndex++;
        continue;
      }
      const eligible = await this.canPrefetchDownload(first);
      if (!eligible) {
        await executePlanItem(first);
        downloadIndex++;
        continue;
      }

      const batch: SyncPlanItem[] = [first];
      downloadIndex++;
      while (downloadIndex < downloads.length && batch.length < downloadPolicy.limit) {
        const candidate = downloads[downloadIndex];
        if (!await this.canPrefetchDownload(candidate)) break;
        batch.push(candidate);
        downloadIndex++;
      }

      const batchStartedAt = Date.now();
      let activePrefetch = 0;
      const prepared = await Promise.all(batch.map(async (item): Promise<PreparedDownload> => {
        metrics.fileTransfers.download.started++;
        activePrefetch++;
        metrics.fileTransfers.download.activeConcurrency++;
        metrics.fileTransfers.download.peakConcurrency = Math.max(
          metrics.fileTransfers.download.peakConcurrency,
          activePrefetch,
        );
        try {
          let content: ArrayBuffer;
          const transferStartedAt = Date.now();
          try {
            content = await this.onedrive.downloadFile(
              this.vaultName,
              item.path,
              item.remote!.downloadUrl,
              item.remote!.driveId,
              item.remote!.size,
              undefined,
            );
          } finally {
            metrics.fileTransfers.download.stagesMs.contentTransfer +=
              Date.now() - transferStartedAt;
          }
          const hashStartedAt = Date.now();
          const downloaded = {
            size: content.byteLength,
            hash: await sha256Hex(content),
          };
          metrics.fileTransfers.download.stagesMs.contentHash += Date.now() - hashStartedAt;
          const remoteVerifyStartedAt = Date.now();
          try {
            await this.verifyDownloadedPayload(item.path, item.remote!, downloaded);
          } finally {
            metrics.fileTransfers.download.stagesMs.remoteVersionVerify +=
              Date.now() - remoteVerifyStartedAt;
          }
          return { content, downloaded };
        } catch (error) {
          return { error };
        } finally {
          activePrefetch--;
          metrics.fileTransfers.download.activeConcurrency = Math.max(
            0,
            metrics.fileTransfers.download.activeConcurrency - 1,
          );
        }
      }));
      const failed = prepared.some((item) => item.error !== undefined);
      const downloadedBytes = prepared.reduce(
        (sum, item) => sum + (item.downloaded?.size ?? 0),
        0,
      );
      const degradedProbe = this.onedrive as OneDriveClient & {
        hasDegradedDownloadPathThisRound?: () => boolean;
      };
      downloadPolicy.observeBatch({
        files: prepared.length,
        bytes: downloadedBytes,
        elapsedMs: Date.now() - batchStartedAt,
        failed,
        degradedPath: degradedProbe.hasDegradedDownloadPathThisRound?.() ?? false,
      });
      this.diag?.log("execute", "adaptive download batch", {
        schemaVersion: 1,
        files: batch.length,
        bytes: downloadedBytes,
        elapsedMs: Math.max(0, Date.now() - batchStartedAt),
        failed,
        nextConcurrency: downloadPolicy.limit,
        lockedSerial: downloadPolicy.isLockedSerial,
      });
      if (!this.canContinue(operationEpoch, result)) {
        metrics.fileTransfers.download.cancelled += batch.length;
        break;
      }
      for (let index = 0; index < batch.length; index++) {
        if (!this.canContinue(operationEpoch, result)) break;
        await executePlanItem(batch[index], prepared[index]);
      }
    }

    // Step 4 — serial cleanup (deletes after all uploads/downloads)
    for (const item of cleanupItems) {
      if (!this.canContinue(operationEpoch, result)) break;
      await executePlanItem(item);
    }

    // Step 5 — directory shells are removed child-first only after every file
    // action settled. Each executor branch re-lists the target immediately.
    for (const item of folderDeletes) {
      if (!this.canContinue(operationEpoch, result)) break;
      await executePlanItem(item);
    }

    if (!this.canContinue(operationEpoch, result)) {
      this.diag?.log("execute", `sync cancelled after starting ${started}/${total} item(s)`);
      result.message = this.t("result.cancelled");
      return;
    }
    if ((this.state.mutationLedger?.length ?? 0) > 0) {
      throw new Error("Mutation recovery is unresolved; shared state checkpoint stopped");
    }

    // State-only convergence can observe a newer remote version without
    // performing a mutation (for example, an If-Match upload race whose
    // winner already has the local bytes). Publish that remote identity
    // before a base anchor is allowed to reference its eTag.
    if (remoteUpserts.length > 0 || remoteDeletes.length > 0) {
      if (!this.canContinue(operationEpoch, result)) return;
      await this.state.applyRemoteMutations(remoteUpserts, remoteDeletes);
    }

    // P1-a: batch persist base entry updates (deferred from per-file calls)
    if (baseUpserts.length > 0) {
      if (!this.canContinue(operationEpoch, result)) return;
      await this.state.upsertBaseEntries(baseUpserts);
    }
    if (baseRemovals.length > 0) {
      if (!this.canContinue(operationEpoch, result)) return;
      await this.state.removeBaseEntries(baseRemovals);
    }

    if (pendingConflicts.length > 0) {
      if (!this.canContinue(operationEpoch, result)) return;
      await this.state.upsertPendingConflicts(pendingConflicts);
    }
    if (pendingDeletes.length > 0) {
      if (!this.canContinue(operationEpoch, result)) return;
      await this.state.upsertPendingDeletes(pendingDeletes);
    }
    if (!this.canContinue(operationEpoch, result)) return;
    await this.state.reconcilePendingIssues(pendingIssues, resolvedIssuePaths);
    this.diag?.log(
      "execute",
      `upload summary — files=${result.uploaded}, bytes=${metrics.uploadBytes}, peak=${metrics.peakUploads}/${uploadConc}, readMs=${metrics.uploadReadMs}, networkMs=${metrics.uploadNetworkMs}, elapsedMs=${Date.now() - startedAt}`,
    );

  }

  /** Reconcile every durable mutation record before reading a cursor or planning. */
  private resolveCurrentFolderParent(
    folder: NonNullable<SyncPlanItem["folder"]>,
  ): { driveId: string; eTag?: string } {
    const envelope = this.state.getCommittedV2Envelope();
    if (!envelope) throw new Error("Folder mutation requires the active V2 envelope");
    if (folder.parentPath === "") {
      if (
        folder.parentRemoteId
        && folder.parentRemoteId !== envelope.scope.filesRootId
      ) {
        throw new Error("Folder plan root identity changed before execution");
      }
      return { driveId: envelope.scope.filesRootId };
    }

    const pathById = projectRemoteIndexV2(envelope.remoteIndex);
    const current = Object.values(envelope.remoteIndex.itemsById).find(
      (node) => node.kind === "folder"
        && normalizeRemotePathKey(pathById.get(node.id) ?? "")
          === normalizeRemotePathKey(folder.parentPath),
    );
    if (
      !current
      || (folder.parentRemoteId && current.id !== folder.parentRemoteId)
    ) {
      throw new Error(`Folder parent identity changed before execution: ${folder.parentPath}`);
    }
    return { driveId: current.id, eTag: current.eTag };
  }

  /**
   * OneDrive can advance a newly created folder's eTag immediately after the
   * POST response. Commit only an exact ID read-back so the receipt, remote
   * index, and folder anchor all carry the version later CAS actions will see.
   * If this GET cannot prove the created identity, the already-durable intent
   * remains recoverable through the ordinary folder mutation path.
   */
  private async createRemoteFolderWithReadback(
    path: string,
    parentRemoteId: string,
  ): Promise<RemoteFolderEntry> {
    const created = await this.onedrive.createFolderByParentId(
      parentRemoteId,
      folderName(path),
    );
    const readBack = await this.onedrive.getDriveItemMetadataById(created.id);
    if (
      !readBack?.folder
      || readBack.id !== created.id
      || readBack.name !== folderName(path)
      || readBack.parentReference?.id !== parentRemoteId
      || !readBack.eTag
    ) {
      throw new Error(`Created remote folder read-back is incomplete or mismatched: ${path}`);
    }
    if (created.eTag && created.eTag !== readBack.eTag) {
      this.diag?.log(
        "onedrive",
        `folder create version advanced before receipt — ${path}`,
        {
          driveItemId: readBack.id,
          responseVersionChanged: true,
        },
      );
    }
    return toRemoteFolderEntry(path, readBack);
  }

  private createMutationIntent(item: SyncPlanItem, scope: SyncScope): MutationIntent {
    if (isFolderMutationAction(item.type)) {
      if (!item.folder) {
        throw new Error(`Folder mutation has no identity metadata: ${item.path}`);
      }
      const createLocal = item.type === SyncActionType.CreateLocalFolder;
      const createRemote = item.type === SyncActionType.CreateRemoteFolder;
      const moveLocal = item.type === SyncActionType.MoveLocalFolder;
      const moveRemote = item.type === SyncActionType.MoveRemoteFolder;
      const deleteLocal = item.type === SyncActionType.DeleteLocalFolder;
      const deleteRemote = item.type === SyncActionType.DeleteRemoteFolder;
      const parent = createLocal || createRemote || moveLocal || moveRemote
        ? this.resolveCurrentFolderParent(item.folder)
        : {
            driveId: item.folder.parentRemoteId
              ?? item.folder.sourceParentRemoteId
              ?? this.state.getCommittedV2Envelope()?.scope.filesRootId
              ?? "",
            eTag: item.folder.parentRemoteETag,
          };
      if (!parent.driveId) {
        throw new Error(`Folder mutation has no parent identity: ${item.path}`);
      }
      item.folder.parentRemoteId = parent.driveId;
      item.folder.parentRemoteETag = parent.eTag;
      if (createLocal && !item.folder.remoteId) {
        throw new Error(`Local folder create has no remote identity: ${item.path}`);
      }
      if ((moveLocal || moveRemote || deleteLocal || deleteRemote) && !item.folder.remoteId) {
        throw new Error(`Folder mutation has no committed identity: ${item.path}`);
      }
      return {
        version: 2,
        operationId: `${Date.now()}-${++this.mutationSequence}-${item.type}`,
        planRevision: this.state.planReviewRevision,
        scope: { ...scope },
        action: createLocal
          ? "createLocalFolder"
          : createRemote
            ? "createRemoteFolder"
            : moveLocal
              ? "moveLocalFolder"
              : moveRemote
                ? "moveRemoteFolder"
                : deleteLocal
                  ? "deleteLocalFolder"
                  : "deleteRemoteFolder",
        path: item.path,
        sourcePath: item.renameFrom,
        folderId: item.folder.remoteId,
        expectedLocal: {
          exists: createRemote || moveRemote || deleteLocal,
        },
        expectedSourceLocal: moveLocal ? { exists: true } : undefined,
        expectedRemote: createLocal || moveLocal || moveRemote || deleteRemote
          ? {
              exists: true,
              driveId: item.folder.remoteId!,
              parentId: moveRemote || deleteRemote
                ? item.folder.sourceParentRemoteId ?? parent.driveId
                : parent.driveId,
              eTag: item.folder.remoteETag,
            }
          : { exists: false },
        expectedParent: {
          driveId: parent.driveId,
          path: item.folder.parentPath,
          eTag: parent.eTag,
        },
        createdAt: Date.now(),
      };
    }
    return {
      version: 1,
      operationId: `${Date.now()}-${++this.mutationSequence}-${item.type}`,
      planRevision: this.state.planReviewRevision,
      scope: { ...scope },
      action: item.type === SyncActionType.DeleteRemote
        ? "deleteRemote"
        : item.type === SyncActionType.DeleteLocal
          ? "deleteLocal"
        : item.type === SyncActionType.RenameRemote
          ? "renameRemote"
          : item.type === SyncActionType.MoveLocalFile
            ? "moveLocal"
          : item.type === SyncActionType.Download
            ? "download"
            : "upload",
      path: item.path,
      sourcePath: item.renameFrom,
      expectedLocal: item.local
        ? { exists: true, hash: item.local.hash, size: item.local.size }
        : { exists: false },
      expectedRemote: item.remote
        ? {
            exists: true,
            driveId: item.remote.driveId,
            eTag: item.remote.eTag,
            size: item.remote.size,
            sha256Hash: item.remote.sha256Hash,
          }
        : { exists: false },
      createdAt: Date.now(),
    };
  }

  private createSideMutationIntent(
    item: SyncPlanItem,
    action: MutationIntentV1["action"],
    expectedLocalOverride?: SyncDecisionToken["local"],
  ): MutationIntentV1 {
    const token = item.decisionToken;
    const scope = this.activeSyncScope;
    if (!token || !scope) throw new Error("Reviewed mutation has no current authorization scope");
    return {
      version: 1,
      operationId: `${Date.now()}-${++this.mutationSequence}-${action}`,
      planRevision: this.state.planReviewRevision,
      scope: { ...scope },
      action,
      path: item.path,
      expectedLocal: expectedLocalOverride ?? token.local,
      expectedRemote: token.remote.exists
        ? {
            ...token.remote,
            size: item.remote?.size ?? 0,
            sha256Hash: item.remote?.sha256Hash,
          }
        : token.remote,
      createdAt: Date.now(),
    };
  }

  private createMergeMutationIntent(
    item: SyncPlanItem,
    target: { hash: string; size: number },
  ): MutationIntentV1 {
    const scope = this.activeSyncScope;
    if (!scope || !item.local || !item.remote) {
      throw new Error("Automatic merge has no current local, remote, or scope");
    }
    return {
      version: 1,
      operationId: `${Date.now()}-${++this.mutationSequence}-merge`,
      planRevision: this.state.planReviewRevision,
      scope: { ...scope },
      action: "merge",
      path: item.path,
      expectedLocal: {
        exists: true,
        hash: item.local.hash,
        size: item.local.size,
      },
      expectedRemote: {
        exists: true,
        driveId: item.remote.driveId,
        eTag: item.remote.eTag,
        size: item.remote.size,
        sha256Hash: item.remote.sha256Hash,
      },
      target: { ...target },
      createdAt: Date.now(),
    };
  }

  private async runDurableSideMutation(
    intent: MutationIntent,
    operationEpoch: number,
    mutate: () => Promise<MutationCheckpointV1>,
  ): Promise<boolean> {
    await this.state.beginMutationIntent(intent);
    let checkpoint: MutationCheckpointV1 | null = null;
    try {
      checkpoint = await mutate();
      await this.state.recordMutationReceipt({
        version: 1,
        operationId: intent.operationId,
        completedAt: Date.now(),
        checkpoint,
      });
      if (!this.canContinue(operationEpoch)) return false;
      await this.commitMutationCheckpoint(intent.operationId);
      return this.canContinue(operationEpoch);
    } catch (error) {
      if (error instanceof MutationNotAppliedError) {
        try {
          await this.state.abandonMutationIntent(intent.operationId);
          this.diag?.log("execute", `side mutation proved not applied and was abandoned — ${intent.path}`);
        } catch (recoveryError) {
          this.diag?.warn(
            "execute",
            `side mutation could not abandon its not-applied intent — ${intent.path}`,
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          );
        }
        throw error;
      }

      if (checkpoint && await this.retrySideMutationCheckpoint(intent, checkpoint)) {
        return this.canContinue(operationEpoch);
      }
      const recovery = await this.reconcileFailedMutation(intent);
      if (recovery.outcome === "applied") {
        return this.canContinue(operationEpoch);
      }
      throw error;
    }
  }

  /** Retry the exact checkpoint produced by a completed mutation. */
  private async retrySideMutationCheckpoint(
    intent: MutationIntent,
    checkpoint: MutationCheckpointV1,
  ): Promise<boolean> {
    try {
      await this.state.recordMutationReceipt({
        version: 1,
        operationId: intent.operationId,
        completedAt: Date.now(),
        checkpoint,
      });
      await this.commitMutationCheckpoint(intent.operationId);
      this.diag?.warn("execute", `side mutation checkpoint retried in the same action — ${intent.path}`);
      return true;
    } catch (recoveryError) {
      this.diag?.warn(
        "execute",
        `side mutation checkpoint retry failed — ${intent.path}`,
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      );
      return false;
    }
  }

  /** Keep the ledger capability at one owner when non-application is already known. */
  private async abandonKnownUnappliedMutation(
    intent: MutationIntent,
    message: string,
  ): Promise<void> {
    await this.state.abandonMutationIntent(intent.operationId);
    this.diag?.log("execute", `${message} — ${intent.path}`);
  }

  /** Re-read local/remote facts so a failed mutation can settle in the same round. */
  private async reconcileFailedMutation(
    intent: MutationIntent,
  ): Promise<SideMutationRecoveryResult> {
    try {
      const outcome = await this.classifyUnreceiptedMutation(intent);
      if (outcome === "not-applied") {
        await this.abandonKnownUnappliedMutation(
          intent,
          "mutation recovery proved not applied",
        );
        return {
          outcome: "not-applied",
          retryableObservationError: null,
        };
      }
      if (!outcome) {
        this.diag?.warn("execute", `mutation recovery remains unresolved — ${intent.path}`);
        return {
          outcome: "unresolved",
          retryableObservationError: null,
        };
      }
      await this.state.recordMutationReceipt({
        version: 1,
        operationId: intent.operationId,
        completedAt: Date.now(),
        checkpoint: outcome,
      });
      await this.commitMutationCheckpoint(intent.operationId);
      this.diag?.warn("execute", `mutation recovered and checkpointed in the same action — ${intent.path}`);
      return {
        outcome: "applied",
        retryableObservationError: null,
      };
    } catch (recoveryError) {
      this.diag?.warn(
        "execute",
        `mutation same-action recovery failed — ${intent.path}`,
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      );
      return {
        outcome: "unresolved",
        retryableObservationError:
          isRetryableMutationRecoveryObservationError(recoveryError)
            ? recoveryError
            : null,
      };
    }
  }

  private async recoverMutationLedger(
    syncScope: SyncScope,
    automaticHandlingMetrics?: AutomaticHandlingMetrics,
  ): Promise<MutationRecoveryRunSummary | null> {
    if (this.state.hasMutationLedgerCorruption) {
      const total = this.state.mutationLedger.length;
      throw new MutationRecoveryBlockedError({
        state: "blocked",
        total,
        settled: 0,
        remaining: total,
        retryAfterSeconds: null,
        blockReason: "evidence-corrupt",
      }, new Error("Mutation recovery ledger is corrupt"));
    }
    const mergeRecovery = automaticHandlingMetrics?.mergeRecovery;
    const persistedRecords = [...(this.state.mutationLedger ?? [])];
    const blocked: Array<{
      operationId: string;
      reason:
        | "outcome-unresolved"
        | "observation-unavailable"
        | "dependent-on-unresolved";
      error: Error;
      retryable: boolean;
    }> = [];
    const blockedIntents: Array<{
      intent: MutationIntent;
      retryable: boolean;
    }> = [];
    let settled = 0;
    let applied = 0;
    let notApplied = 0;
    let receiptCommitted = 0;
    let quarantined = 0;
    for (const persistedRecord of persistedRecords) {
      const record = this.state.prepareMutationRecoveryRecord(
        persistedRecord,
        syncScope,
      );
      if (!record) {
        throw new MutationRecoveryBlockedError({
          state: "blocked",
          total: persistedRecords.length,
          settled,
          remaining: this.state.mutationLedger.length,
          retryAfterSeconds: null,
          blockReason: "scope-changed",
        }, new Error(
          `Mutation scope no longer matches: ${persistedRecord.intent.operationId}`,
        ));
      }
      const blockingDependency = blockedIntents.find((blockedIntent) =>
        mutationRecoveryIntentsOverlap(blockedIntent.intent, record.intent));
      if (blockingDependency) {
        blocked.push({
          operationId: record.intent.operationId,
          reason: "dependent-on-unresolved",
          error: new Error(
            `Mutation recovery waits for an earlier dependent operation: ${record.intent.operationId}`,
          ),
          retryable: blockingDependency.retryable,
        });
        blockedIntents.push({
          intent: record.intent,
          retryable: blockingDependency.retryable,
        });
        continue;
      }
      const isAutomaticMerge = record.intent.action === "merge";
      if (isAutomaticMerge && mergeRecovery) mergeRecovery.records++;
      if (record.receipt) {
        let receiptMatches: boolean;
        try {
          receiptMatches = await this.verifyMutationReceipt(record);
        } catch (error) {
          if (
            this.cancelled
            || !isRetryableMutationRecoveryObservationError(error)
          ) throw error;
          blocked.push({
            operationId: record.intent.operationId,
            reason: "observation-unavailable",
            error,
            retryable: true,
          });
          blockedIntents.push({
            intent: record.intent,
            retryable: true,
          });
          if (isAutomaticMerge && mergeRecovery) mergeRecovery.unresolved++;
          continue;
        }
        if (!receiptMatches) {
          const unreachableUpload = this.state.isV2StateActive
            ? await this.proveUnreachableReceiptedUpload(record)
            : null;
          if (unreachableUpload) {
            const quarantine =
              await this.state.quarantineUnreachableUploadReceipt({
                record,
                remoteId: unreachableUpload.remoteId,
                localMissing: true,
                graphItemMissing: true,
              });
            this.diag?.warn(
              "state",
              `unreachable upload receipt quarantined under V2 authority — ${record.intent.path}`,
              {
                operationId: record.intent.operationId,
                sourceCommitSeq: quarantine.sourceCommitSeq,
                reason: quarantine.reason,
                activeLedgerRecords: this.state.mutationLedger.length,
                quarantinedRecords:
                  this.state.mutationRecoveryQuarantine.length,
                mutations: 0,
              },
            );
            quarantined++;
            settled++;
            continue;
          }
          if (isAutomaticMerge && mergeRecovery) mergeRecovery.unresolved++;
          throw new MutationRecoveryBlockedError({
            state: "blocked",
            total: persistedRecords.length,
            settled,
            remaining: this.state.mutationLedger.length,
            retryAfterSeconds: null,
            blockReason: "facts-changed",
          }, new Error(
            `Mutation receipt no longer matches local/remote facts: ${record.intent.operationId}`,
          ));
        }
        await this.commitMutationCheckpoint(record.intent.operationId);
        receiptCommitted++;
        settled++;
        if (isAutomaticMerge) {
          if (mergeRecovery) mergeRecovery.receiptCommitted++;
          await this.getMergeReadyStore().complete(record.intent.operationId);
        }
        continue;
      }

      let outcome: "not-applied" | MutationCheckpointV1 | null;
      try {
        outcome = await this.classifyUnreceiptedMutation(record.intent);
      } catch (error) {
        if (
          this.cancelled
          || !isRetryableMutationRecoveryObservationError(error)
        ) throw error;
        blocked.push({
          operationId: record.intent.operationId,
          reason: "observation-unavailable",
          error,
          retryable: true,
        });
        blockedIntents.push({
          intent: record.intent,
          retryable: true,
        });
        if (isAutomaticMerge && mergeRecovery) mergeRecovery.unresolved++;
        continue;
      }
      if (outcome === "not-applied") {
        await this.state.abandonMutationIntent(record.intent.operationId);
        notApplied++;
        settled++;
        if (isAutomaticMerge) {
          if (mergeRecovery) mergeRecovery.notApplied++;
          await this.getMergeReadyStore().complete(record.intent.operationId);
        }
        continue;
      }
      if (!outcome) {
        if (isAutomaticMerge && mergeRecovery) mergeRecovery.unresolved++;
        blocked.push({
          operationId: record.intent.operationId,
          reason: "outcome-unresolved",
          error: new Error(
            `Mutation outcome requires manual review: ${record.intent.operationId}`,
          ),
          retryable: false,
        });
        blockedIntents.push({
          intent: record.intent,
          retryable: false,
        });
        continue;
      }
      if (isAutomaticMerge) {
        if (outcome.baseUpserts.some((entry) => entry.path === record.intent.path)) {
          if (mergeRecovery) mergeRecovery.remoteCommittedLocalRecovered++;
        } else {
          if (mergeRecovery) mergeRecovery.remoteCommittedLocalPending++;
        }
      }
      const receipt: MutationReceiptV1 = {
        version: 1,
        operationId: record.intent.operationId,
        completedAt: Date.now(),
        checkpoint: outcome,
      };
      await this.state.recordMutationReceipt(receipt);
      await this.commitMutationCheckpoint(record.intent.operationId);
      applied++;
      settled++;
      if (isAutomaticMerge) {
        await this.getMergeReadyStore().complete(record.intent.operationId);
      }
    }
    let recoverySummary: MutationRecoveryRunSummary | null = null;
    if (persistedRecords.length > 0) {
      const blockedByReason = blocked.reduce<Record<string, number>>(
        (counts, item) => {
          counts[item.reason] = (counts[item.reason] ?? 0) + 1;
          return counts;
        },
        {},
      );
      const allBlockedRetryable =
        blocked.length > 0
        && blocked.every((item) => item.retryable);
      const retryAfterSeconds = blocked.reduce<number | null>(
        (maximum, item) => {
          if (
            !item.retryable
            || !(item.error instanceof OneDriveError)
            || item.error.retryAfterSeconds === null
          ) return maximum;
          return maximum === null
            ? item.error.retryAfterSeconds
            : Math.max(maximum, item.error.retryAfterSeconds);
        },
        null,
      );
      recoverySummary = {
        state: blocked.length === 0
          ? "settled"
          : allBlockedRetryable
            ? "network-unavailable"
            : "blocked",
        total: persistedRecords.length,
        settled,
        remaining: this.state.mutationLedger.length,
        retryAfterSeconds,
        ...(!allBlockedRetryable && blocked.length > 0
          ? { blockReason: "facts-changed" as const }
          : {}),
      };
      const diagnosticSummary = {
        schemaVersion: 1,
        ...recoverySummary,
        applied,
        notApplied,
        receiptCommitted,
        quarantined,
        blocked: blocked.length,
        blockedByReason,
        firstBlockedOperationId: blocked[0]?.operationId ?? null,
        externalMutations: 0,
      };
      if (blocked.length > 0) {
        this.diag?.warn(
          "execute",
          "mutation recovery batch summary",
          diagnosticSummary,
        );
      } else {
        this.diag?.log(
          "execute",
          "mutation recovery batch summary",
          diagnosticSummary,
        );
      }
    }
    if (blocked.length > 0) {
      throw new MutationRecoveryBlockedError(
        recoverySummary!,
        blocked[0].error,
      );
    }
    return recoverySummary;
  }

  /**
   * A receipted upload can leave the active V2 ledger only after independent
   * local, complete-index, and exact Graph identity facts prove that the
   * receipt-owned version no longer exists. The StateManager then moves the
   * complete record into the durable V2 recovery quarantine atomically.
   */
  private async proveUnreachableReceiptedUpload(
    record: MutationLedgerEntryV1,
  ): Promise<{ remoteId: string } | null> {
    if (
      record.intent.action !== "upload"
      || !record.receipt
      || !this.state.hasCompleteRemoteFolderIndex
    ) return null;
    const local = await this.inspectLocalPath(record.intent.path);
    if (!local || local.status !== "missing") return null;
    const upserts = record.receipt.checkpoint.remoteUpserts.filter(
      (entry) => entry.path === record.intent.path,
    );
    if (upserts.length !== 1) return null;
    const [upsert] = upserts;
    if (this.state.remoteSnapshot.some(
      (entry) => entry.path === record.intent.path || entry.driveId === upsert.driveId,
    )) return null;
    const client = this.onedrive as OneDriveClient & {
      getDriveItemMetadataById?: OneDriveClient["getDriveItemMetadataById"];
    };
    if (typeof client.getDriveItemMetadataById !== "function") return null;
    return await client.getDriveItemMetadataById(upsert.driveId) === null
      ? { remoteId: upsert.driveId }
      : null;
  }

  private async verifyMutationReceipt(record: MutationLedgerEntryV1): Promise<boolean> {
    const receipt = record.receipt;
    if (!receipt) return false;
    const intent = record.intent;
    if (isFolderMutationIntent(intent)) {
      if (intent.action === "deleteLocalFolder" || intent.action === "deleteRemoteFolder") {
        if (!intent.folderId) return false;
        const deletion = receipt.checkpoint.folderDeletes?.find(
          (entry) => entry.path === intent.path && entry.driveId === intent.folderId,
        );
        if (!deletion || (await this.inspectLocalFolder(intent.path)).status !== "missing") {
          return false;
        }
        return await this.onedrive.getDriveItemMetadataById(intent.folderId) === null;
      }

      const [local, remote] = await Promise.all([
        this.inspectLocalFolder(intent.path),
        this.inspectRemoteFolder(intent.path),
      ]);
      if (local.status !== "present") return false;
      const upsert = receipt.checkpoint.folderUpserts?.find(
        (entry) => entry.path === intent.path,
      );
      const targetMatches = Boolean(
        upsert
        && remote.status === "folder"
        && remote.entry.driveId === upsert.driveId
        && remote.entry.parentId === upsert.parentId
        && (
          upsert.eTag === undefined
          || remote.entry.eTag === upsert.eTag
        ),
      );
      if (!targetMatches) return false;
      if (intent.action === "moveLocalFolder" || intent.action === "moveRemoteFolder") {
        if (!intent.sourcePath) return false;
        const [localSource, remoteSource] = await Promise.all([
          this.inspectLocalFolder(intent.sourcePath),
          this.inspectRemoteFolder(intent.sourcePath),
        ]);
        return localSource.status === "missing" && remoteSource.status === "missing";
      }
      return true;
    }
    const local = await this.inspectLocalPath(intent.path);
    if (local === null || local.status === "uncertain") return false;
    const base = receipt.checkpoint.baseUpserts.find((entry) => entry.path === intent.path);

    if (intent.action === "download") {
      if (!base || !this.inspectionMatchesVersion(local, base)) return false;
      const remote = await this.inspectRemotePath(intent.path);
      return this.remoteMatchesExpectation(remote, intent.expectedRemote);
    }
    if (intent.action === "deleteLocal") {
      return local.status === "missing";
    }
    if (intent.action === "deleteRemote") {
      if (!intent.expectedRemote.exists) return false;
      const currentAtPath = await this.inspectRemotePath(intent.path);
      if (this.remoteMatchesExpectation(currentAtPath, intent.expectedRemote)) {
        return false;
      }
      return await this.onedrive.getDriveItemMetadataById(
        intent.expectedRemote.driveId,
      ) === null;
    }
    if (intent.action === "merge") {
      if (!intent.target) return false;
      const remote = await this.inspectRemotePath(intent.path);
      const upsert = receipt.checkpoint.remoteUpserts.find((entry) => entry.path === intent.path);
      if (!upsert || !remote
        || remote.driveId !== upsert.driveId
        || remote.eTag !== upsert.eTag
        || !await this.remoteMatchesTarget(remote, intent.target)) return false;
      return !base || this.inspectionMatchesVersion(local, base);
    }
    if (intent.action === "renameRemote") {
      if (!intent.sourcePath || !base || !this.inspectionMatchesVersion(local, base)) return false;
      const [source, target] = await Promise.all([
        this.inspectRemotePath(intent.sourcePath),
        this.inspectRemotePath(intent.path),
      ]);
      const upsert = receipt.checkpoint.remoteUpserts.find((entry) => entry.path === intent.path);
      return !source && Boolean(upsert && target
        && target.driveId === upsert.driveId
          && target.eTag === upsert.eTag);
    }
    if (intent.action === "moveLocal") {
      if (!intent.sourcePath || !base || !this.inspectionMatchesVersion(local, base)) return false;
      const [sourceLocal, sourceRemote, targetRemote] = await Promise.all([
        this.inspectLocalPath(intent.sourcePath),
        this.inspectRemotePath(intent.sourcePath),
        this.inspectRemotePath(intent.path),
      ]);
      const upsert = receipt.checkpoint.remoteUpserts.find(
        (entry) => entry.path === intent.path,
      );
      return sourceLocal?.status === "missing"
        && sourceRemote === undefined
        && Boolean(upsert && targetRemote
          && targetRemote.driveId === upsert.driveId
          && targetRemote.eTag === upsert.eTag);
    }

    // upload
    if (intent.action !== "upload") {
      return assertNeverMutationAction(intent.action);
    }
    const remote = await this.inspectRemotePath(intent.path);
    const upsert = receipt.checkpoint.remoteUpserts.find((entry) => entry.path === intent.path);
    if (!base || !upsert || !remote
      || remote.driveId !== upsert.driveId
      || remote.eTag !== upsert.eTag) return false;
    if (this.inspectionMatchesVersion(local, base)) return true;
    if (local.status !== "missing") return false;
    return this.restoreReceiptedUploadLocal(intent.path, remote, base);
  }

  /**
   * A durable upload receipt proves which remote version was created. If the
   * local source disappears before checkpoint publication, restore that exact
   * version through the normal journaled local-commit path instead of either
   * abandoning the receipt or publishing a false common anchor.
   */
  private async restoreReceiptedUploadLocal(
    path: string,
    remote: RemoteFileEntry,
    expected: BaseFileEntry,
  ): Promise<boolean> {
    const adapter = this.scanner.vault.adapter as StreamDownloadAdapter;
    if (typeof adapter.rename !== "function") return false;
    const readyPath = `${this.getDownloadTempPath(path)}.receipt-ready`;
    await this.ensureParentDirs(readyPath);
    await this.removePathIfExists(readyPath);
    let downloaded: { size: number; hash: string };
    let content: ArrayBuffer | null = null;
    try {
      const streamAdapter = this.getStreamDownloadAdapter(remote.size);
      if (streamAdapter) {
        downloaded = await this.onedrive.downloadFileToPath(
          this.vaultName,
          path,
          readyPath,
          streamAdapter,
          remote.downloadUrl,
          remote.driveId,
          remote.size,
          expected.hash,
        );
      } else {
        content = await this.onedrive.downloadFile(
          this.vaultName,
          path,
          remote.downloadUrl,
          remote.driveId,
          remote.size,
        );
        downloaded = {
          size: content.byteLength,
          hash: await sha256Hex(content),
        };
        await this.writeBinaryTempFileWithAndroidZeroByteRetry(path, readyPath, content);
      }
      if (downloaded.size !== expected.size || downloaded.hash !== expected.hash) {
        return false;
      }
      await this.verifyDownloadedPayload(path, remote, downloaded, true);
      const currentRemote = await this.inspectRemotePath(path);
      if (
        !currentRemote
        || currentRemote.driveId !== remote.driveId
        || currentRemote.eTag !== remote.eTag
      ) return false;
      const currentLocal = await this.inspectLocalPath(path);
      if (!currentLocal || currentLocal.status !== "missing") return false;
      await this.ensureParentDirs(path);
      await this.commitDownloadedTempFile(
        adapter,
        path,
        readyPath,
        undefined,
        downloaded,
      );
      const restored = await this.inspectLocalPath(path);
      if (!restored || !this.inspectionMatchesVersion(restored, expected)) return false;
      if (content) this.state.cacheBaseContent(path, content);
      this.localVersionRecoveredDuringLedger = true;
      this.diag?.warn(
        "execute",
        `receipted upload restored its missing local source before checkpoint — ${path}`,
      );
      return true;
    } finally {
      await this.removePathIfExists(readyPath);
    }
  }

  private async classifyUnreceiptedMutation(
    intent: MutationIntent,
  ): Promise<"not-applied" | MutationCheckpointV1 | null> {
    if (isFolderMutationIntent(intent)) {
      return this.classifyUnreceiptedFolderMutation(intent);
    }
    const local = await this.inspectLocalPath(intent.path);
    if (local === null || local.status === "uncertain") return null;
    if (intent.action === "moveLocal") {
      if (!intent.sourcePath || !intent.expectedLocal.exists || !intent.expectedRemote.exists) {
        return null;
      }
      const [sourceLocal, sourceRemote, targetRemote] = await Promise.all([
        this.inspectLocalPath(intent.sourcePath),
        this.inspectRemotePath(intent.sourcePath),
        this.inspectRemotePath(intent.path),
      ]);
      if (!sourceLocal || sourceLocal.status === "uncertain") return null;
      const sourceStillExpected = this.inspectionMatchesExpectation(
        sourceLocal,
        intent.expectedLocal,
      );
      const targetStillMissing = local.status === "missing";
      const remoteStillExpected = this.remoteMatchesExpectation(
        targetRemote,
        intent.expectedRemote,
      );
      if (
        sourceStillExpected
        && targetStillMissing
        && sourceRemote === undefined
        && remoteStillExpected
      ) return "not-applied";
      if (
        sourceLocal.status !== "missing"
        || !this.inspectionMatchesExpectation(local, intent.expectedLocal)
        || sourceRemote !== undefined
        || !remoteStillExpected
        || !targetRemote
      ) return null;
      const checkpoint = emptyMutationCheckpoint();
      checkpoint.baseRemovals.push(intent.sourcePath);
      checkpoint.baseUpserts.push({
        path: intent.path,
        hash: intent.expectedLocal.hash,
        size: intent.expectedLocal.size,
        eTag: targetRemote.eTag,
      });
      checkpoint.remoteDeletes.push(intent.sourcePath);
      checkpoint.remoteUpserts.push(targetRemote);
      return checkpoint;
    }
    const remotePath = intent.action === "renameRemote"
      ? intent.sourcePath ?? intent.path
      : intent.path;
    const remote = await this.inspectRemotePath(remotePath);
    const localStillExpected = this.inspectionMatchesExpectation(local, intent.expectedLocal);
    const remoteStillExpected = this.remoteMatchesExpectation(remote, intent.expectedRemote);
    if (intent.action === "merge") {
      if (!intent.target || !intent.expectedLocal.exists || !intent.expectedRemote.exists) return null;
      if (remoteStillExpected) return localStillExpected ? "not-applied" : null;
      if (!remote || !await this.remoteMatchesTarget(remote, intent.target)) return null;

      const checkpoint = emptyMutationCheckpoint();
      const currentRemote = {
        ...remote,
        parentId: this.requireKnownRemoteParentId(
          intent.path,
          remote.parentId,
        ),
        sha256Hash: intent.target.hash,
      };
      checkpoint.remoteUpserts.push(currentRemote);

      let currentLocal = local;
      if (localStillExpected) {
        const payload = await this.getMergeReadyStore().read(intent.operationId, intent.target);
        if (!payload) return null;
        await this.commitMergeLocally(intent.path, intent.expectedLocal, intent.target, payload);
        const recoveredLocal = await this.inspectLocalPath(intent.path);
        if (!recoveredLocal || recoveredLocal.status === "uncertain") return null;
        currentLocal = recoveredLocal;
        this.localVersionRecoveredDuringLedger = true;
      }
      if (this.inspectionMatchesVersion(currentLocal, intent.target)) {
        checkpoint.baseUpserts.push({
          path: intent.path,
          hash: intent.target.hash,
          size: intent.target.size,
          eTag: currentRemote.eTag,
        });
        checkpoint.pendingConflictRemovals.push(intent.path);
      }
      return checkpoint;
    }
    if (
      (intent.action === "upload" || intent.action === "renameRemote")
      && remoteStillExpected
    ) return "not-applied";
    if (intent.action === "deleteRemote") {
      if (!intent.expectedRemote.exists) return null;
      if (remoteStillExpected) return "not-applied";
      const exactRemote = await this.onedrive.getDriveItemMetadataById(
        intent.expectedRemote.driveId,
      );
      if (exactRemote !== null) return null;
    }
    if ((intent.action === "download" || intent.action === "deleteLocal") && localStillExpected) {
      return "not-applied";
    }

    const checkpoint = emptyMutationCheckpoint();
    if (intent.action === "upload") {
      if (
        local.status !== "present"
        || !local.entry
        || !intent.expectedLocal.exists
        || local.entry.hash !== intent.expectedLocal.hash
        || local.entry.size !== intent.expectedLocal.size
      ) return null;
      const current = await this.inspectRemotePath(intent.path);
      if (
        !current
        || !await this.remoteMatchesTarget(current, intent.expectedLocal)
      ) return null;
      checkpoint.baseUpserts.push(StateManager.toBaseEntry(local.entry, current));
      checkpoint.remoteUpserts.push(current);
      return checkpoint;
    }
    if (intent.action === "download") {
      if (!intent.expectedRemote.exists || local.status !== "present" || !local.entry) return null;
      const current = await this.inspectRemotePath(intent.path);
      if (!this.remoteMatchesExpectation(current, intent.expectedRemote)) return null;
      const expectedHash = intent.expectedRemote.sha256Hash?.toLowerCase();
      if (local.entry.size !== intent.expectedRemote.size) return null;
      if (expectedHash) {
        if (local.entry.hash !== expectedHash) return null;
      } else if (!current || !await this.remoteMatchesTarget(
        current,
        { hash: local.entry.hash, size: local.entry.size },
        true,
      )) {
        return null;
      }
      checkpoint.baseUpserts.push({
        path: intent.path,
        hash: local.entry.hash,
        size: local.entry.size,
        eTag: intent.expectedRemote.eTag,
      });
      return checkpoint;
    }
    if (intent.action === "deleteRemote") {
      if (await this.inspectRemotePath(intent.path)) return null;
      checkpoint.baseRemovals.push(intent.path);
      checkpoint.remoteDeletes.push(intent.path);
      return checkpoint;
    }
    if (intent.action === "deleteLocal") {
      if (local.status !== "missing") return null;
      checkpoint.baseRemovals.push(intent.path);
      checkpoint.pendingDeleteRemovals.push(intent.path);
      return checkpoint;
    }
    if (intent.action !== "renameRemote") {
      return assertNeverMutationAction(intent.action);
    }
    if (!intent.sourcePath || !intent.expectedRemote.exists) return null;
    const [source, target] = await Promise.all([
      this.inspectRemotePath(intent.sourcePath),
      this.inspectRemotePath(intent.path),
    ]);
    if (source || !target || target.driveId !== intent.expectedRemote.driveId) return null;
    if (!intent.expectedLocal.exists || local.status !== "present" || !local.entry) return null;
    checkpoint.baseRemovals.push(intent.sourcePath);
    checkpoint.baseUpserts.push({
      path: intent.path,
      hash: local.entry.hash,
      size: local.entry.size,
      eTag: target.eTag,
    });
    checkpoint.remoteDeletes.push(intent.sourcePath);
    checkpoint.remoteUpserts.push(target);
    return checkpoint;
  }

  private async classifyUnreceiptedFolderMutation(
    intent: FolderMutationIntentV2,
  ): Promise<"not-applied" | MutationCheckpointV1 | null> {
    const [local, remote] = await Promise.all([
      this.inspectLocalFolder(intent.path),
      this.inspectRemoteFolder(intent.path),
    ]);
    if (local.status === "uncertain" || local.status === "file" || remote.status === "file") {
      return null;
    }

    if (intent.action === "createLocalFolder") {
      if (!this.folderRemoteExpectationMatches(remote, intent.expectedRemote)) return null;
      if (local.status === "missing") return "not-applied";
      if (remote.status !== "folder") return null;
      return folderMutationCheckpoint(remote.entry);
    }
    if (intent.action === "moveLocalFolder" || intent.action === "moveRemoteFolder") {
      if (!intent.sourcePath || !intent.folderId || !intent.expectedRemote.exists) return null;
      const [sourceLocal, sourceRemote, targetById] = await Promise.all([
        this.inspectLocalFolder(intent.sourcePath),
        this.inspectRemoteFolder(intent.sourcePath),
        this.onedrive.getDriveItemMetadataById(intent.folderId),
      ]);
      if (
        sourceLocal.status === "uncertain"
        || sourceLocal.status === "file"
        || sourceRemote.status === "file"
      ) return null;
      if (intent.action === "moveLocalFolder") {
        if (
          sourceLocal.status === "present"
          && local.status === "missing"
          && sourceRemote.status === "missing"
          && this.folderRemoteExpectationMatches(remote, intent.expectedRemote)
        ) return "not-applied";
      } else if (
        sourceLocal.status === "missing"
        && local.status === "present"
        && this.folderRemoteExpectationMatches(sourceRemote, intent.expectedRemote)
        && remote.status === "missing"
      ) {
        return "not-applied";
      }
      if (
        sourceLocal.status !== "missing"
        || local.status !== "present"
        || sourceRemote.status !== "missing"
        || remote.status !== "folder"
        || remote.entry.driveId !== intent.folderId
        || remote.entry.parentId !== intent.expectedParent.driveId
        || !targetById?.folder
        || targetById.id !== intent.folderId
        || targetById.parentReference?.id !== intent.expectedParent.driveId
      ) return null;
      const checkpoint = folderMutationCheckpoint(remote.entry);
      checkpoint.folderMoveHintRemovals = this.folderIdentityIdsAtOrBelow(
        intent.sourcePath,
      );
      return checkpoint;
    }
    if (intent.action === "deleteLocalFolder" || intent.action === "deleteRemoteFolder") {
      if (!intent.folderId) return null;
      const remoteById = await this.onedrive.getDriveItemMetadataById(intent.folderId);
      if (intent.action === "deleteLocalFolder") {
        if (
          local.status === "present"
          && remote.status === "missing"
          && remoteById === null
        ) return "not-applied";
      } else if (
        local.status === "missing"
        && this.folderRemoteExpectationMatches(remote, intent.expectedRemote)
        && remoteById?.id === intent.folderId
      ) {
        return "not-applied";
      }
      if (
        local.status !== "missing"
        || remoteById !== null
        || (remote.status === "folder" && remote.entry.driveId === intent.folderId)
      ) return null;
      const checkpoint = folderDeleteCheckpoint(intent.path, intent.folderId);
      if (this.state.pendingRemoteDeletes.some((item) => item.path === intent.path)) {
        checkpoint.pendingDeleteRemovals.push(intent.path);
      }
      return checkpoint;
    }

    if (intent.action !== "createRemoteFolder") {
      return assertNeverMutationAction(intent.action);
    }
    if (local.status !== "present") return null;
    if (remote.status === "missing") return "not-applied";
    if (remote.entry.parentId !== intent.expectedParent.driveId) return null;
    const checkpoint = folderMutationCheckpoint(remote.entry);
    if (
      intent.action === "createRemoteFolder"
      && this.state.pendingRemoteDeletes.some((item) => item.path === intent.path)
    ) checkpoint.pendingDeleteRemovals.push(intent.path);
    return checkpoint;
  }

  private inspectionMatchesExpectation(
    current: LocalFileInspection,
    expected: MutationIntentV1["expectedLocal"],
  ): boolean {
    if (!expected.exists) return current.status === "missing";
    return current.status === "present"
      && current.entry?.hash === expected.hash
      && current.entry.size === expected.size;
  }

  private folderIdentityIdsAtOrBelow(path: string): string[] {
    const envelope = this.state.getCommittedV2Envelope();
    if (!envelope?.folderAnchors) return [];
    return Object.values(envelope.folderAnchors.byAnchorId)
      .filter((anchor) => isAtOrBelowPath(anchor.lastPath, path))
      .map((anchor) => anchor.remoteId)
      .sort((left, right) => left.localeCompare(right));
  }

  private inspectionMatchesVersion(
    current: LocalFileInspection,
    expected: Pick<BaseFileEntry, "hash" | "size">,
  ): boolean {
    return current.status === "present"
      && current.entry?.hash === expected.hash
      && current.entry.size === expected.size;
  }

  private remoteMatchesExpectation(
    current: RemoteFileEntry | undefined,
    expected: MutationIntentV1["expectedRemote"],
  ): boolean {
    if (!expected.exists) return current === undefined;
    return Boolean(current
      && current.driveId === expected.driveId
      && current.eTag === expected.eTag);
  }

  private async remoteMatchesTarget(
    remote: RemoteFileEntry,
    target: { hash: string; size: number },
    requireReadback = false,
  ): Promise<boolean> {
    if (remote.size !== target.size) return false;
    if (!requireReadback && remote.sha256Hash?.toLowerCase() === target.hash) return true;
    const bytes = await this.onedrive.downloadFile(
      this.vaultName,
      remote.path,
      remote.downloadUrl,
      remote.driveId,
      remote.size,
    );
    if (bytes.byteLength !== target.size || await sha256Hex(bytes) !== target.hash) return false;
    const current = await this.inspectRemotePath(remote.path);
    return Boolean(current
      && current.driveId === remote.driveId
      && current.eTag === remote.eTag);
  }

  private async commitMergeLocally(
    path: string,
    expected: Extract<MutationIntentV1["expectedLocal"], { exists: true }>,
    target: { hash: string; size: number },
    payload: ArrayBuffer,
  ): Promise<void> {
    const adapter = this.scanner.vault.adapter as StreamDownloadAdapter;
    if (typeof adapter.rename !== "function") {
      throw new Error(`Local adapter cannot commit a merged file safely: ${path}`);
    }
    const readyPath = `${this.getDownloadTempPath(path)}.merge-ready`;
    await this.ensureParentDirs(readyPath);
    await this.removePathIfExists(readyPath);
    try {
      await this.writeBinaryTempFileWithAndroidZeroByteRetry(path, readyPath, payload);
      await this.commitDownloadedTempFile(
        adapter,
        path,
        readyPath,
        {
          path,
          hash: expected.hash,
          size: expected.size,
          mtime: 0,
          binary: false,
        },
        target,
      );
    } finally {
      await this.removePathIfExists(readyPath);
    }
  }

  private failureReason(error: unknown): string {
    if (error instanceof MutationNotAppliedError) {
      return this.failureReason(error.original);
    }
    if (error instanceof LocalVersionChangedBeforeDeleteError) {
      return this.t("syncView.failure.localChangedBeforeDelete");
    }
    if (error instanceof DownloadRemoteVersionChangedError) {
      return this.t("syncView.failure.remoteChangedDuringDownload");
    }
    if (error instanceof OneDriveError) {
      switch (error.type) {
        case OneDriveErrorType.Unauthorized:
        case OneDriveErrorType.Forbidden:
          return this.t("syncView.failure.contentUnavailable");
        case OneDriveErrorType.NetworkError:
          return this.t("syncView.failure.network");
        case OneDriveErrorType.RateLimited:
          return this.t("syncView.failure.rateLimited");
        case OneDriveErrorType.InsufficientStorage:
          return this.t("syncView.failure.storageFull");
        case OneDriveErrorType.AuthExpired:
          return this.t("syncView.failure.authExpired");
        default:
          return this.t("syncView.failure.remote");
      }
    }
    return this.t("syncView.failure.local");
  }

  private stopSideActionForAuthFailure(path: string, error: unknown): boolean {
    if (!isAuthFailure(error)) return false;
    this.invalidateLifecycle("auth-expired");
    this.notice("result.authExpired", { path });
    return true;
  }

  private async tryAutomaticTextMerge(
    item: SyncPlanItem,
    result: SyncResult,
    metrics: ExecutionMetrics,
    callbacks: SyncCallbacks,
    operationEpoch: number,
    automaticHandlingPolicy: Readonly<AutomaticHandlingPolicy>,
  ): Promise<ItemExecutionResult | null> {
    if (!automaticHandlingPolicy.mergeNonOverlappingText
      || item.reason !== "reason.bothSidesModified") return null;

    const automaticMetrics = metrics.automaticHandling;
    automaticMetrics.textMerge.candidates++;
    if (!item.local || !item.remote) {
      return recordAutomaticMergeManual(automaticMetrics, "missing-version");
    }
    if (item.local.binary) {
      return recordAutomaticMergeManual(automaticMetrics, "binary-file");
    }
    if (isObsidianManagedConfigPath(item.path)) {
      return recordAutomaticMergeManual(automaticMetrics, "protected-config");
    }
    if (!isAutomaticTextMergeCandidatePath(
      item.path,
      getConfigDir(this.scanner.vault),
    )) {
      return recordAutomaticMergeManual(automaticMetrics, "unsupported-text-path");
    }

    const base = typeof this.state.getBaseEntry === "function"
      ? this.state.getBaseEntry(item.path)
      : this.state.baseSnapshot.find((entry) => entry.path === item.path);
    const activeScope = this.activeSyncScope ?? this.state.remoteScope;
    const evidenceIdentity: TextMergeEvidenceIdentityV1 | null =
      base && activeScope
        ? {
            scope: activeScope,
            ancestor: base,
            local: item.local,
            remote: item.remote,
          }
        : null;
    const previousConflict = this.state.pendingConflicts.find(
      (pending) => pending.path === item.path,
    );
    const cachedManualEvidence = evidenceIdentity
      ? matchingTextMergeManualEvidenceV1(
          previousConflict?.textMergeEvidence,
          evidenceIdentity,
        )
      : null;
    if (cachedManualEvidence) {
      item.textMergeEvidence = cachedManualEvidence;
      this.diag?.log(
        "execute",
        `automatic merge kept manual from exact cached evidence — ${item.path}, reason=${cachedManualEvidence.reason}`,
      );
      return recordAutomaticMergeManual(
        automaticMetrics,
        cachedManualEvidence.reason,
      );
    }
    delete item.textMergeEvidence;
    const baseContent = await this.state.getBaseContent(item.path);
    if (!base || baseContent === undefined) {
      return recordAutomaticMergeManual(automaticMetrics, "ancestor-unavailable");
    }

    const ancestorBytes = new TextEncoder().encode(baseContent).buffer;
    if (ancestorBytes.byteLength !== base.size || await sha256Hex(ancestorBytes) !== base.hash) {
      this.diag?.warn("execute", `automatic merge skipped — cached ancestor is not the committed base: ${item.path}`);
      return recordAutomaticMergeManual(automaticMetrics, "ancestor-unverified");
    }

    const inspectedBeforeRead = await this.inspectLocalPath(item.path);
    if (!inspectedBeforeRead
      || inspectedBeforeRead.status === "uncertain"
      || !this.inspectionMatchesVersion(inspectedBeforeRead, item.local)) {
      return recordAutomaticMergeManual(automaticMetrics, "local-version-changed");
    }
    const localBytes = await this.scanner.vault.adapter.readBinary(item.path);
    if (localBytes.byteLength !== item.local.size || await sha256Hex(localBytes) !== item.local.hash) {
      return recordAutomaticMergeManual(automaticMetrics, "local-version-changed");
    }
    if (!this.canContinue(operationEpoch, result)) {
      automaticMetrics.textMerge.cancelled++;
      return { executed: false };
    }

    const remoteBytes = await this.onedrive.downloadFile(
      this.vaultName,
      item.path,
      item.remote.downloadUrl,
      item.remote.driveId,
      item.remote.size,
      callbacks.onFileProgress,
    );
    const remoteHash = await sha256Hex(remoteBytes);
    await this.verifyDownloadedPayload(item.path, item.remote, {
      size: remoteBytes.byteLength,
      hash: remoteHash,
    });
    const remoteCurrent = await this.inspectRemotePath(item.path);
    if (!remoteCurrent
      || remoteCurrent.driveId !== item.remote.driveId
      || remoteCurrent.eTag !== item.remote.eTag) {
      return recordAutomaticMergeManual(automaticMetrics, "remote-version-changed");
    }

    const merge = await evaluateConservativeMergeV2({
      ancestor: { bytes: ancestorBytes, hash: base.hash },
      local: { bytes: localBytes, hash: item.local.hash, size: item.local.size },
      remote: {
        bytes: remoteBytes,
        hash: remoteHash,
        size: item.remote.size,
        remoteId: item.remote.driveId,
        eTag: item.remote.eTag,
      },
      expectedRemoteId: item.remote.driveId,
      expectedRemoteETag: item.remote.eTag,
      lifecycleCurrent: this.canContinue(operationEpoch, result),
      envelopeCommitCurrent: Boolean(this.activeSyncScope
        && (!this.state.remoteScope || sameSyncScope(this.activeSyncScope, this.state.remoteScope))),
      localVersionCurrent: true,
      remoteVersionCurrent: true,
      recoveryPending: this.state.mutationLedger.length > 0,
    });
    if (merge.status !== "ready") {
      const evidence = evidenceIdentity
        ? createTextMergeManualEvidenceV1(
            evidenceIdentity,
            merge.reason,
            remoteHash,
          )
        : null;
      if (evidence) item.textMergeEvidence = evidence;
      this.diag?.log("execute", `automatic merge kept manual — ${item.path}, reason=${merge.reason}`);
      return recordAutomaticMergeManual(automaticMetrics, merge.reason);
    }

    const target = { hash: merge.mergedHash, size: merge.mergedBytes.byteLength };
    const intent = this.createMergeMutationIntent(item, target);
    const readyStore = this.getMergeReadyStore();
    await readyStore.prepare(intent.operationId, merge.mergedBytes, target);
    try {
      const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
        const localBeforeRemote = await this.inspectLocalPath(item.path);
        if (!localBeforeRemote
          || localBeforeRemote.status === "uncertain"
          || !this.inspectionMatchesExpectation(localBeforeRemote, intent.expectedLocal)) {
          throw new MutationNotAppliedError(`Local version changed before automatic merge: ${item.path}`);
        }

        await this.onedrive.uploadFile(
          this.vaultName,
          item.path,
          merge.mergedBytes,
          callbacks.onFileProgress,
          item.remote!.eTag,
          item.remote!.driveId,
        );
        const uploadedRemote = await this.inspectRemotePath(item.path);
        if (!uploadedRemote || !await this.remoteMatchesTarget(uploadedRemote, target, true)) {
          throw new Error(`Automatic merge remote read-back failed: ${item.path}`);
        }
        const remoteEntry: RemoteFileEntry = {
          ...uploadedRemote,
          parentId: this.requireKnownRemoteParentId(
            item.path,
            uploadedRemote.parentId,
            item.remote?.parentId,
          ),
          sha256Hash: target.hash,
        };

        let localAfterRemote = await this.inspectLocalPath(item.path);
        if (!localAfterRemote || localAfterRemote.status === "uncertain") {
          throw new Error(`Local version could not be verified after automatic merge: ${item.path}`);
        }
        if (this.inspectionMatchesExpectation(localAfterRemote, intent.expectedLocal)) {
          await this.commitMergeLocally(
            item.path,
            intent.expectedLocal as Extract<MutationIntentV1["expectedLocal"], { exists: true }>,
            target,
            merge.mergedBytes,
          );
          localAfterRemote = await this.inspectLocalPath(item.path);
          if (!localAfterRemote || localAfterRemote.status === "uncertain") {
            throw new Error(`Merged local version could not be verified: ${item.path}`);
          }
        }

        const checkpoint = emptyMutationCheckpoint();
        checkpoint.remoteUpserts.push(remoteEntry);
        if (this.inspectionMatchesVersion(localAfterRemote, target)) {
          checkpoint.baseUpserts.push({
            path: item.path,
            hash: target.hash,
            size: target.size,
            eTag: remoteEntry.eTag,
          });
          this.state.cacheBaseContent(item.path, merge.mergedBytes);
          checkpoint.pendingConflictRemovals.push(item.path);
        }
        return checkpoint;
      });
      if (!committed) {
        automaticMetrics.textMerge.cancelled++;
        return { executed: false };
      }

      const [localAfterCommit, remoteAfterCommit] = await Promise.all([
        this.inspectLocalPath(item.path),
        this.inspectRemotePath(item.path),
      ]);
      const fullyMerged = Boolean(localAfterCommit
        && this.inspectionMatchesVersion(localAfterCommit, target));
      if (localAfterCommit?.status === "present" && localAfterCommit.entry) {
        item.local = localAfterCommit.entry;
      } else if (localAfterCommit?.status === "missing") {
        item.local = undefined;
      }
      if (remoteAfterCommit) item.remote = remoteAfterCommit;
      result.uploaded++;
      metrics.uploadBytes += target.size;
      if (fullyMerged) {
        automaticMetrics.textMerge.completed++;
        return {
          executed: true,
          resolvedConflict: true,
          completionActionType: SyncActionType.Upload,
          completionReason: this.t("syncView.merge.autoMerged", { path: item.path }),
        };
      }
      this.diag?.warn(
        "execute",
        `automatic merge preserved a newer local version after remote commit — ${item.path}`,
      );
      item.reason = item.local
        ? "reason.bothSidesModified"
        : "reason.localDeletedRemoteModified";
      recordAutomaticMergeManual(
        automaticMetrics,
        "remote-committed-local-pending",
      );
      return { executed: true };
    } catch (error) {
      const unresolved = this.state.mutationLedger.some(
        (entry) => entry.intent.operationId === intent.operationId,
      );
      if (!unresolved) await readyStore.complete(intent.operationId);
      if (unresolved || isAuthFailure(error)) throw error;
      this.diag?.warn(
        "execute",
        `automatic merge degraded to manual review — ${item.path}`,
        error instanceof Error ? error.message : String(error),
      );
      return recordAutomaticMergeManual(automaticMetrics, "execution-failed");
    } finally {
      if (!this.state.mutationLedger.some(
        (entry) => entry.intent.operationId === intent.operationId,
      )) {
        await readyStore.complete(intent.operationId);
      }
    }
  }

  private async queuePendingConflict(
    item: SyncPlanItem,
    result: SyncResult,
    operationEpoch: number,
  ): Promise<ItemExecutionResult> {
    if (!this.canContinue(operationEpoch, result)) return { executed: false };
    await this.state.addPendingConflict(this.withDecisionToken(item));
    if (!this.canContinue(operationEpoch, result)) return { executed: false };
    result.conflicts++;
    return { executed: true };
  }

  private async executeItem(
    item: SyncPlanItem,
    result: SyncResult,
    remoteUpserts: RemoteFileEntry[],
    remoteDeletes: string[],
    metrics: ExecutionMetrics,
    callbacks: SyncCallbacks,
    operationEpoch: number,
    automaticHandlingPolicy: Readonly<AutomaticHandlingPolicy>,
    preparedDownload?: PreparedDownload,
  ): Promise<ItemExecutionResult> {
    switch (item.type) {
      case SyncActionType.CreateRemoteFolder: {
        if (!item.folder) return { executed: false };
        const parentRemoteId = item.folder.parentRemoteId;
        if (!parentRemoteId) return { executed: false };
        const local = await this.inspectLocalFolder(item.path);
        if (local.status !== "present") {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.local-source-changed"),
          };
        }

        const target = await this.inspectRemoteFolder(item.path);
        if (target.status === "file") {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.type-conflict"),
          };
        }
        if (target.status === "folder") {
          if (target.entry.parentId !== parentRemoteId) {
            result.deferred++;
            return {
              executed: false,
              completionActionType: SyncActionType.FolderDeferred,
              completionReason: this.t("reason.folder.parent-chain-incomplete"),
            };
          }
          result.foldersCreated = (result.foldersCreated ?? 0) + 1;
          return {
            executed: true,
            mutationApplied: true,
            folderUpsert: target.entry,
          };
        }

        const envelope = this.state.getCommittedV2Envelope();
        if (!envelope) {
          throw new Error("Folder mutation requires the active V2 envelope");
        }
        const parentStillOwnsPath = item.folder.parentPath === ""
          ? await this.onedrive.getDriveItemMetadataById(parentRemoteId)
              .then((parent) => Boolean(parent?.folder && parent.id === parentRemoteId))
          : await this.inspectRemoteFolder(item.folder.parentPath)
              .then((parent) => {
                const committedParent =
                  envelope.remoteIndex.itemsById[parentRemoteId];
                return parent.status === "folder"
                  && parent.entry.driveId === parentRemoteId
                  && committedParent?.kind === "folder"
                  && parent.entry.parentId === committedParent.parentId;
              });
        if (!parentStillOwnsPath) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.parent-version-changed"),
          };
        }
        const folderUpsert = await this.createRemoteFolderWithReadback(
          item.path,
          parentRemoteId,
        );
        result.foldersCreated = (result.foldersCreated ?? 0) + 1;
        return {
          executed: true,
          mutationApplied: true,
          folderUpsert,
        };
      }

      case SyncActionType.CreateLocalFolder: {
        if (!item.folder?.remoteId || !item.folder.parentRemoteId) {
          return { executed: false };
        }
        const remote = await this.inspectRemoteFolder(item.path);
        if (
          remote.status !== "folder"
          || remote.entry.driveId !== item.folder.remoteId
          || remote.entry.parentId !== item.folder.parentRemoteId
          || (
            item.folder.remoteETag !== undefined
            && remote.entry.eTag !== item.folder.remoteETag
          )
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.remote-version-changed"),
          };
        }

        const local = await this.inspectLocalFolder(item.path);
        if (local.status === "file" || local.status === "uncertain") {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t(
              local.status === "file"
                ? "reason.folder.type-conflict"
                : "reason.folder.local-inspection-failed",
            ),
          };
        }
        if (local.status === "missing") {
          await this.createLocalFolder(item.path);
          const readback = await this.inspectLocalFolder(item.path);
          if (readback.status !== "present") {
            throw new Error(`Local folder create read-back failed: ${item.path}`);
          }
        }
        result.foldersCreated = (result.foldersCreated ?? 0) + 1;
        return {
          executed: true,
          mutationApplied: true,
          folderUpsert: remote.entry,
        };
      }

      case SyncActionType.MoveRemoteFolder: {
        if (
          !item.renameFrom
          || !item.folder?.remoteId
          || !item.folder.parentRemoteId
          || !item.folder.sourceParentRemoteId
          || !item.folder.remoteETag
        ) return { executed: false };
        const [localSource, localTarget, remoteSource, remoteTarget] = await Promise.all([
          this.inspectLocalFolder(item.renameFrom),
          this.inspectLocalFolder(item.path),
          this.inspectRemoteFolder(item.renameFrom),
          this.inspectRemoteFolder(item.path),
        ]);
        if (
          localSource.status !== "missing"
          || localTarget.status !== "present"
          || remoteTarget.status !== "missing"
          || remoteSource.status !== "folder"
          || remoteSource.entry.driveId !== item.folder.remoteId
          || remoteSource.entry.parentId !== item.folder.sourceParentRemoteId
          || remoteSource.entry.eTag !== item.folder.remoteETag
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.remote-version-changed"),
          };
        }
        const [targetParent, targetParentByPath] = await Promise.all([
          this.onedrive.getDriveItemMetadataById(item.folder.parentRemoteId),
          item.folder.parentPath === ""
            ? Promise.resolve(null)
            : this.inspectRemoteFolder(item.folder.parentPath),
        ]);
        if (
          !targetParent?.folder
          || targetParent.id !== item.folder.parentRemoteId
          || (
            item.folder.parentPath !== ""
            && (
              targetParentByPath?.status !== "folder"
              || targetParentByPath.entry.driveId !== item.folder.parentRemoteId
            )
          )
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.parent-version-changed"),
          };
        }
        if (!this.canContinue(operationEpoch, result)) return { executed: false };

        let moved: DriveItem;
        try {
          moved = await this.onedrive.moveItemById(
            item.folder.remoteId,
            item.folder.remoteETag,
            folderName(item.path),
            item.folder.parentRemoteId,
          );
        } catch (error) {
          if (!(error instanceof OneDriveError) || !isRemoteMutationConflict(error)) throw error;
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.remote-version-changed"),
          };
        }
        const folderUpsert = toRemoteFolderEntry(item.path, moved);
        const [sourceAfter, targetAfter, idAfter] = await Promise.all([
          this.inspectRemoteFolder(item.renameFrom),
          this.inspectRemoteFolder(item.path),
          this.onedrive.getDriveItemMetadataById(item.folder.remoteId),
        ]);
        if (
          sourceAfter.status !== "missing"
          || targetAfter.status !== "folder"
          || targetAfter.entry.driveId !== item.folder.remoteId
          || targetAfter.entry.parentId !== item.folder.parentRemoteId
          || !idAfter?.folder
          || idAfter.id !== item.folder.remoteId
          || idAfter.parentReference?.id !== item.folder.parentRemoteId
          || folderUpsert.driveId !== targetAfter.entry.driveId
          || folderUpsert.eTag !== targetAfter.entry.eTag
        ) {
          throw new Error(`Remote folder move read-back failed: ${item.renameFrom} -> ${item.path}`);
        }
        result.foldersMoved = (result.foldersMoved ?? 0) + 1;
        return {
          executed: true,
          mutationApplied: true,
          folderUpsert: targetAfter.entry,
        };
      }

      case SyncActionType.MoveLocalFolder: {
        if (
          !item.renameFrom
          || !item.folder?.remoteId
          || !item.folder.parentRemoteId
          || !item.folder.remoteETag
        ) return { executed: false };
        const [localSource, localTarget, remoteSource, remoteTarget] = await Promise.all([
          this.inspectLocalFolder(item.renameFrom),
          this.inspectLocalFolder(item.path),
          this.inspectRemoteFolder(item.renameFrom),
          this.inspectRemoteFolder(item.path),
        ]);
        if (
          localSource.status !== "present"
          || localTarget.status !== "missing"
          || remoteSource.status !== "missing"
          || remoteTarget.status !== "folder"
          || remoteTarget.entry.driveId !== item.folder.remoteId
          || remoteTarget.entry.parentId !== item.folder.parentRemoteId
          || remoteTarget.entry.eTag !== item.folder.remoteETag
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.local-source-changed"),
          };
        }
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        await this.renameLocalFolder(item.renameFrom, item.path);
        result.foldersMoved = (result.foldersMoved ?? 0) + 1;
        return {
          executed: true,
          mutationApplied: true,
          folderUpsert: remoteTarget.entry,
        };
      }

      case SyncActionType.DeleteRemoteFolder: {
        if (
          !item.folder?.remoteId
          || !item.folder.sourceParentRemoteId
          || !item.folder.remoteETag
        ) return { executed: false };
        const local = await this.inspectLocalFolder(item.path);
        if (local.status !== "missing") {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.local-source-changed"),
          };
        }
        const [byId, byPath] = await Promise.all([
          this.onedrive.getDriveItemMetadataById(item.folder.remoteId),
          this.inspectRemoteFolder(item.path),
        ]);
        if (!byId) {
          if (byPath.status !== "missing") {
            result.deferred++;
            return {
              executed: false,
              completionActionType: SyncActionType.FolderDeferred,
              completionReason: this.t("reason.folder.remote-version-changed"),
            };
          }
          result.foldersDeleted = (result.foldersDeleted ?? 0) + 1;
          return {
            executed: true,
            mutationApplied: true,
            folderDelete: { path: item.path, driveId: item.folder.remoteId },
          };
        }
        if (
          !byId.folder
          || byId.parentReference?.id !== item.folder.sourceParentRemoteId
          || byId.eTag !== item.folder.remoteETag
          || byPath.status !== "folder"
          || byPath.entry.driveId !== item.folder.remoteId
          || byPath.entry.parentId !== item.folder.sourceParentRemoteId
          || byPath.entry.eTag !== item.folder.remoteETag
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.remote-version-changed"),
          };
        }
        const children = await this.onedrive.listFolderChildrenById(item.folder.remoteId);
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        if (children.length > 0) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.remote-subtree-changed"),
          };
        }
        const [localBeforeDelete, current, currentByPath] = await Promise.all([
          this.inspectLocalFolder(item.path),
          this.onedrive.getDriveItemMetadataById(item.folder.remoteId),
          this.inspectRemoteFolder(item.path),
        ]);
        if (
          localBeforeDelete.status !== "missing"
          || !current?.folder
          || current.parentReference?.id !== item.folder.sourceParentRemoteId
          || current.eTag !== item.folder.remoteETag
          || currentByPath.status !== "folder"
          || currentByPath.entry.driveId !== item.folder.remoteId
          || currentByPath.entry.parentId !== item.folder.sourceParentRemoteId
          || currentByPath.entry.eTag !== item.folder.remoteETag
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.remote-version-changed"),
          };
        }
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        try {
          await this.onedrive.deleteItem(
            this.vaultName,
            item.path,
            item.folder.remoteETag,
            item.folder.remoteId,
          );
        } catch (error) {
          if (!(error instanceof OneDriveError) || !isRemoteMutationConflict(error)) throw error;
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.remote-version-changed"),
          };
        }
        if (await this.onedrive.getDriveItemMetadataById(item.folder.remoteId)) {
          throw new Error(`Remote folder delete read-back failed: ${item.path}`);
        }
        result.foldersDeleted = (result.foldersDeleted ?? 0) + 1;
        return {
          executed: true,
          mutationApplied: true,
          folderDelete: { path: item.path, driveId: item.folder.remoteId },
        };
      }

      case SyncActionType.DeleteLocalFolder: {
        if (!item.folder?.remoteId) return { executed: false };
        if (item.requiresConfirmation) {
          return { executed: true };
        }
        const [remoteById, remoteByPath, local] = await Promise.all([
          this.onedrive.getDriveItemMetadataById(item.folder.remoteId),
          this.inspectRemoteFolder(item.path),
          this.inspectLocalFolder(item.path),
        ]);
        if (
          remoteById
          || remoteByPath.status !== "missing"
          || local.status === "file"
          || local.status === "uncertain"
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.FolderDeferred,
            completionReason: this.t("reason.folder.local-inspection-failed"),
          };
        }
        if (local.status === "present") {
          if (!this.canContinue(operationEpoch, result)) return { executed: false };
          await this.deleteEmptyLocalFolder(item.path);
        }
        result.foldersDeleted = (result.foldersDeleted ?? 0) + 1;
        return {
          executed: true,
          mutationApplied: true,
          folderDelete: { path: item.path, driveId: item.folder.remoteId },
        };
      }

      case SyncActionType.MoveLocalFile: {
        if (!item.renameFrom || !item.local || !item.remote) return { executed: false };
        const [sourceLocal, targetLocal, remoteSource, remoteTarget] = await Promise.all([
          this.inspectLocalPath(item.renameFrom),
          this.inspectLocalPath(item.path),
          this.inspectRemotePath(item.renameFrom),
          this.inspectRemotePath(item.path),
        ]);
        if (
          !sourceLocal
          || !targetLocal
          || sourceLocal.status === "uncertain"
          || targetLocal.status === "uncertain"
          || !this.localExpectationMatches(item.local, sourceLocal)
          || targetLocal.status !== "missing"
          || remoteSource !== undefined
          || !this.remoteMatchesExpectation(remoteTarget, {
            exists: true,
            driveId: item.remote.driveId,
            eTag: item.remote.eTag,
            size: item.remote.size,
            sha256Hash: item.remote.sha256Hash,
          })
        ) {
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.RetryLater,
            completionReason: this.t("syncView.fileStatus.deferred"),
          };
        }
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        await this.renameLocalFile(item.renameFrom, item.path);
        const [sourceAfter, targetAfter] = await Promise.all([
          this.inspectLocalPath(item.renameFrom),
          this.inspectLocalPath(item.path),
        ]);
        if (
          !sourceAfter
          || !targetAfter
          || sourceAfter.status !== "missing"
          || !this.localExpectationMatches(item.local, targetAfter)
        ) {
          throw new Error(`Local file move read-back failed: ${item.renameFrom} -> ${item.path}`);
        }
        remoteDeletes.push(item.renameFrom);
        remoteUpserts.push({ ...item.remote, path: item.path });
        result.filesMoved = (result.filesMoved ?? 0) + 1;
        return {
          executed: true,
          mutationApplied: true,
          baseRemoval: item.renameFrom,
          baseUpsert: {
            path: item.path,
            hash: item.local.hash,
            size: item.local.size,
            eTag: item.remote.eTag,
          },
        };
      }

      case SyncActionType.Upload: {
        if (!item.local) break;
        const readStartedAt = Date.now();
        const content = await this.scanner.vault.adapter.readBinary(item.path);
        const readElapsedMs = Date.now() - readStartedAt;
        metrics.uploadReadMs += readElapsedMs;
        metrics.fileTransfers.upload.stagesMs.sourceRead += readElapsedMs;
        if (!this.canContinue(operationEpoch, result)) return { executed: false };

        // Re-check hash — file may have changed since scan.
        // If hash differs, skip this round; the change will be picked up next sync.
        const hashStartedAt = Date.now();
        const actualHash = await sha256Hex(content);
        metrics.fileTransfers.upload.stagesMs.contentHash += Date.now() - hashStartedAt;
        if (actualHash !== item.local.hash) {
          this.diag?.warn("execute", `upload skipped — ${item.path} hash changed since scan (${item.local.hash.slice(0, 8)}… → ${actualHash.slice(0, 8)}…)`);
          result.deferred++;
          return {
            executed: false,
            completionActionType: SyncActionType.RetryLater,
            completionReason: this.t("syncView.fileStatus.deferred"),
          };
        }
        if (!this.canContinue(operationEpoch, result)) return { executed: false };

        metrics.activeUploads++;
        metrics.peakUploads = Math.max(metrics.peakUploads, metrics.activeUploads);
        const uploadStartedAt = Date.now();
        let uploadResult: UploadResult;
        try {
          uploadResult = await this.onedrive.uploadFile(
            this.vaultName,
            item.path,
            content,
            callbacks.onFileProgress,
            item.baseEtag,
            item.remote?.driveId,
          );
          const uploadElapsedMs = Date.now() - uploadStartedAt;
          metrics.uploadNetworkMs += uploadElapsedMs;
          metrics.fileTransfers.upload.stagesMs.contentTransfer += uploadElapsedMs;
        } catch (e) {
          const uploadElapsedMs = Date.now() - uploadStartedAt;
          metrics.uploadNetworkMs += uploadElapsedMs;
          metrics.fileTransfers.upload.stagesMs.contentTransfer += uploadElapsedMs;
          if (
            e instanceof OneDriveError
            && isRemoteMutationConflict(e)
          ) {
            // Another device changed this file since we scanned remote.
            // Fetch current remote state and route to conflict.
            const fresh = await this.onedrive.getFileMetadata(
              this.vaultName,
              item.path,
            );
            if (!this.canContinue(operationEpoch, result)) {
              metrics.activeUploads--;
              return { executed: false };
            }
            if (fresh) {
              metrics.activeUploads--;
              const remoteEntry = this.toMetadataRemoteEntry(
                item.path,
                fresh,
                item.remote?.parentId,
              );
              const metadataEquality = resolveContentEquality({
                local: item.local,
                remote: { ...fresh, eTag: fresh.eTag },
              });
              let sameContent = metadataEquality.status === "equal";
              if (metadataEquality.status === "unknown") {
                try {
                  sameContent = await this.remoteMatchesTarget(
                    remoteEntry,
                    item.local,
                    true,
                  );
                } catch (comparisonError) {
                  this.diag?.warn(
                    "execute",
                    `upload race content read-back failed — ${item.path}`,
                    comparisonError,
                  );
                }
              }
              if (!this.canContinue(operationEpoch, result)) {
                return { executed: false };
              }
              if (sameContent) {
                remoteUpserts.push(remoteEntry);
                return {
                  executed: true,
                  baseUpsert: StateManager.toBaseEntry(item.local, remoteEntry),
                };
              }
              remoteUpserts.push(remoteEntry);
              return this.queuePendingConflict({
                type: SyncActionType.Conflict,
                path: item.path,
                local: item.local,
                remote: remoteEntry,
                reason: "reason.bothSidesModified",
              }, result, operationEpoch);
            }
            // File was deleted remotely — re-upload without If-Match
            if (!this.canContinue(operationEpoch, result)) {
              metrics.activeUploads--;
              return { executed: false };
            }
            const retryStartedAt = Date.now();
            try {
              uploadResult = await this.onedrive.uploadFile(
                this.vaultName,
                item.path,
                content,
                callbacks.onFileProgress,
              );
            } catch (retryError) {
              if (retryError instanceof OneDriveError && isRemoteMutationConflict(retryError)) {
                const raced = await this.onedrive.getFileMetadata(this.vaultName, item.path);
                if (!this.canContinue(operationEpoch, result)) {
                  metrics.activeUploads--;
                  return { executed: false };
                }
                if (raced) {
                  const racedEntry = this.toMetadataRemoteEntry(
                    item.path,
                    raced,
                    item.remote?.parentId,
                  );
                  metrics.activeUploads--;
                  remoteUpserts.push(racedEntry);
                  return this.queuePendingConflict({
                    type: SyncActionType.Conflict,
                    path: item.path,
                    local: item.local,
                    remote: racedEntry,
                    reason: "reason.newFileBothSides",
                  }, result, operationEpoch);
                }
              }
              metrics.activeUploads--;
              throw retryError;
            }
            const retryElapsedMs = Date.now() - retryStartedAt;
            metrics.uploadNetworkMs += retryElapsedMs;
            metrics.fileTransfers.upload.stagesMs.contentTransfer += retryElapsedMs;
            // fall through to post-upload logic
          } else {
            metrics.activeUploads--;
            throw e;
          }
        }
        metrics.activeUploads--;

        const baseUpsert: BaseFileEntry = {
          path: item.path,
          hash: item.local.hash,
          size: item.local.size,
          eTag: uploadResult.eTag ?? "",
        };
        metrics.uploadBytes += item.local.size;
        remoteUpserts.push(this.toUploadedRemoteEntry(
          item.path,
          item.local,
          uploadResult,
          item.remote?.parentId,
        ));
        result.uploaded++;
        this.state.cacheBaseContent(item.path, content);
        return { executed: true, mutationApplied: true, baseUpsert };
      }

      case SyncActionType.Download: {
        if (!item.remote) break;
        const usesLocalCas = typeof (this.scanner as LocalScanner & { inspectFile?: unknown }).inspectFile === "function";
        const firstLocalGuardStartedAt = Date.now();
        const beforeDownload = await this.guardDownloadLocalVersion(item, result, operationEpoch);
        metrics.fileTransfers.download.stagesMs.localVersionGuard +=
          Date.now() - firstLocalGuardStartedAt;
        if (beforeDownload) return beforeDownload;
        const streamAdapter = this.getStreamDownloadAdapter(item.remote.size);
        const tempDownloadPath = streamAdapter ? this.getDownloadTempPath(item.path) : null;
        let streamedDownload: { size: number; hash: string } | null = null;
        let content: ArrayBuffer | null = preparedDownload?.content ?? null;
        if (preparedDownload?.downloaded) {
          streamedDownload = preparedDownload.downloaded;
        } else if (streamAdapter && tempDownloadPath) {
          await this.ensureParentDirs(tempDownloadPath);
          this.diag?.log("execute", `download streaming to temp file — ${item.path}`);
          const transferStartedAt = Date.now();
          try {
            streamedDownload = await this.onedrive.downloadFileToPath(
              this.vaultName,
              item.path,
              tempDownloadPath,
              streamAdapter,
              item.remote.downloadUrl,
              item.remote.driveId,
              item.remote.size,
              item.remote.sha256Hash,
              callbacks.onFileProgress,
            );
          } finally {
            metrics.fileTransfers.download.stagesMs.contentTransfer +=
              Date.now() - transferStartedAt;
          }
        } else {
          const transferStartedAt = Date.now();
          try {
            content = await this.onedrive.downloadFile(
              this.vaultName,
              item.path,
              item.remote.downloadUrl,
              item.remote.driveId,
              item.remote.size,
              callbacks.onFileProgress,
            );
          } finally {
            metrics.fileTransfers.download.stagesMs.contentTransfer +=
              Date.now() - transferStartedAt;
          }
        }
        let downloaded = streamedDownload;
        if (!downloaded) {
          const hashStartedAt = Date.now();
          downloaded = {
            size: (content as ArrayBuffer).byteLength,
            hash: await sha256Hex(content as ArrayBuffer),
          };
          metrics.fileTransfers.download.stagesMs.contentHash += Date.now() - hashStartedAt;
        }
        if (!preparedDownload?.downloaded) {
          const remoteVerifyStartedAt = Date.now();
          try {
            await this.verifyDownloadedPayload(item.path, item.remote, downloaded);
          } catch (error) {
            if (tempDownloadPath) await this.removePathIfExists(tempDownloadPath);
            throw error;
          } finally {
            metrics.fileTransfers.download.stagesMs.remoteVersionVerify +=
              Date.now() - remoteVerifyStartedAt;
          }
        }
        if (!this.canContinue(operationEpoch, result)) {
          if (tempDownloadPath) {
            await this.removePathIfExists(tempDownloadPath);
          }
          return { executed: false };
        }
        const secondLocalGuardStartedAt = Date.now();
        const beforeWrite = await this.guardDownloadLocalVersion(item, result, operationEpoch);
        metrics.fileTransfers.download.stagesMs.localVersionGuard +=
          Date.now() - secondLocalGuardStartedAt;
        if (beforeWrite) {
          if (tempDownloadPath) {
            await this.removePathIfExists(tempDownloadPath);
          }
          return beforeWrite;
        }
        const localCommitStartedAt = Date.now();
        // Ensure all parent directories exist (recursive)
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        await this.ensureParentDirs(item.path);
        // Verify local file hasn't changed since scan before overwriting.
        // If the local file was modified after the scan, route to conflict
        // instead of silently overwriting the user's changes.
        if (!usesLocalCas && item.local) {
          let currentContent: ArrayBuffer | null = null;
          try { currentContent = await this.scanner.vault.adapter.readBinary(item.path); } catch { /* file doesn't exist yet */ }
          if (currentContent) {
            const currentHash = await sha256Hex(currentContent);
            if (currentHash !== item.local.hash) {
              this.diag?.warn("execute", `download blocked — ${item.path} was modified locally since scan (${item.local.hash.slice(0, 8)}… → ${currentHash.slice(0, 8)}…)`);
              if (this.localMatchesRemoteHash({ hash: currentHash, size: currentContent.byteLength }, item.remote)) {
                if (tempDownloadPath) {
                  await this.removePathIfExists(tempDownloadPath);
                }
                return {
                  executed: true,
                  baseUpsert: StateManager.toBaseEntry(
                    { ...item.local, hash: currentHash, size: currentContent.byteLength },
                    item.remote,
                  ),
                };
              }
              const stat = await this.scanner.vault.adapter.stat(item.path);
              if (tempDownloadPath) {
                await this.removePathIfExists(tempDownloadPath);
              }
              return this.queuePendingConflict({
                ...item,
                type: SyncActionType.Conflict,
                local: {
                  ...item.local,
                  hash: currentHash,
                  size: currentContent.byteLength,
                  mtime: stat?.mtime ?? item.local.mtime,
                },
                reason: "reason.bothSidesModified",
              }, result, operationEpoch);
            }
          }
        }
        let fileStat: { size: number; mtime?: number } | null = null;
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        if (streamAdapter && tempDownloadPath && streamedDownload) {
          try {
            if (usesLocalCas) {
              fileStat = await this.commitDownloadedTempFile(
                streamAdapter,
                item.path,
                tempDownloadPath,
                item.local,
                streamedDownload,
              );
            } else {
              // Compatibility path for isolated/legacy scanner doubles. The
              // production LocalScanner always exposes inspectFile().
              await streamAdapter.rename(tempDownloadPath, item.path);
              const stat = await streamAdapter.stat(item.path);
              fileStat = stat ? { size: stat.size, mtime: stat.mtime } : null;
            }
          } catch (writeErr) {
            this.diag?.warn("execute", `streamed download commit failed for ${item.path}, recovery attempted`, writeErr instanceof Error ? writeErr.message : String(writeErr));
            if (writeErr instanceof LocalCommitPreconditionError) {
              const guarded = await this.guardDownloadLocalVersion(item, result, operationEpoch);
              if (guarded) return guarded;
              result.deferred++;
              return {
                executed: false,
                completionActionType: SyncActionType.RetryLater,
                completionReason: this.t("syncView.fileStatus.deferred"),
              };
            }
            throw writeErr;
          }
        } else {
          // Write and verify away from the target, then journal the short
          // replacement window so a restart can roll it back safely.
          if (!usesLocalCas) {
            await this.scanner.vault.adapter.writeBinary(item.path, content as ArrayBuffer);
            const stat = await this.scanner.vault.adapter.stat(item.path);
            fileStat = stat ? { size: stat.size, mtime: stat.mtime } : null;
          } else {
            const readyPath = `${this.getDownloadTempPath(item.path)}.ready`;
            try {
              await this.ensureParentDirs(readyPath);
              await this.removePathIfExists(readyPath);
              await this.writeBinaryTempFileWithAndroidZeroByteRetry(
                item.path,
                readyPath,
                content as ArrayBuffer,
              );
              const readyBytes = await this.scanner.vault.adapter.readBinary(readyPath);
              if (
                readyBytes.byteLength !== (content as ArrayBuffer).byteLength
                || await sha256Hex(readyBytes) !== downloaded.hash
              ) {
                throw new Error(`Downloaded temp file verification failed: ${item.path}`);
              }
              fileStat = await this.commitDownloadedTempFile(
                this.scanner.vault.adapter as StreamDownloadAdapter,
                item.path,
                readyPath,
                item.local,
                downloaded,
              );
            } catch (writeErr) {
              await this.removePathIfExists(readyPath);
              this.diag?.warn("execute", `download write failed for ${item.path}, recovery attempted`, writeErr instanceof Error ? writeErr.message : String(writeErr));
              if (writeErr instanceof LocalCommitPreconditionError) {
                const guarded = await this.guardDownloadLocalVersion(item, result, operationEpoch);
                if (guarded) return guarded;
                result.deferred++;
                return {
                  executed: false,
                  completionActionType: SyncActionType.RetryLater,
                  completionReason: this.t("syncView.fileStatus.deferred"),
                };
              }
              throw writeErr;
            }
          }
        }
        metrics.fileTransfers.download.stagesMs.localCommit +=
          Date.now() - localCommitStartedAt;

        const hash = downloaded.hash;
        result.downloaded++;
        if (content) {
          this.state.cacheBaseContent(item.path, content);
        }
        return {
          executed: true,
          mutationApplied: true,
          baseUpsert: {
            path: item.path,
            hash,
            size: fileStat?.size ?? downloaded.size,
            eTag: item.remote.eTag,
          },
        };
      }

      case SyncActionType.DeleteRemote: {
        try {
          if (!this.canContinue(operationEpoch, result)) return { executed: false };
          await this.onedrive.deleteItem(
            this.vaultName,
            item.path,
            item.remote?.eTag,
            item.remote?.driveId,
          );
        } catch (e) {
          if (e instanceof OneDriveError && isRemoteMutationConflict(e)) {
            // File was modified remotely since plan — route to conflict
            this.diag?.warn("execute", `delete blocked — ${item.path} eTag changed since plan`);
            const fresh = await this.onedrive.getFileMetadata(
              this.vaultName,
              item.path,
            );
            if (!this.canContinue(operationEpoch, result)) return { executed: false };
            if (!fresh) {
              remoteDeletes.push(item.path);
              result.deleted++;
              return { executed: true, baseRemoval: item.path };
            }
            const remoteEntry = this.toMetadataRemoteEntry(
              item.path,
              fresh,
              item.remote?.parentId,
            );
            remoteUpserts.push(remoteEntry);
            return this.queuePendingConflict({
              type: SyncActionType.Conflict,
              path: item.path,
              remote: remoteEntry,
              reason: "reason.localDeletedRemoteModified",
            }, result, operationEpoch);
          }
          throw e;
        }
        remoteDeletes.push(item.path);
        result.deleted++;
        return { executed: true, mutationApplied: true, baseRemoval: item.path };
      }

      case SyncActionType.DeleteLocal: {
        if (!item.local) return { executed: false };
        if (isObsidianManagedConfigPath(item.path)) {
          throw new MutationNotAppliedError(
            new Error(this.t("notice.decisionExpired")),
          );
        }
        let current: LocalFileInspection;
        try {
          if (!this.canContinue(operationEpoch, result)) return { executed: false };
          const remote = await this.onedrive.getFileMetadata(this.vaultName, item.path);
          if (!this.canContinue(operationEpoch, result)) return { executed: false };
          if (remote) throw new Error(this.t("notice.decisionExpired"));

          const inspected = await this.inspectLocalPath(item.path);
          if (!inspected || inspected.status === "uncertain") {
            throw new Error(this.t("notice.localChangedSinceReview"));
          }
          if (
            inspected.status === "present"
            && !this.localExpectationMatches(item.local, inspected)
          ) {
            throw new LocalVersionChangedBeforeDeleteError(item.path);
          }
          current = inspected;
        } catch (error) {
          throw new MutationNotAppliedError(error);
        }
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        if (current.status === "present") await this.deleteLocalPath(item.path);
        result.deleted++;
        return { executed: true, mutationApplied: true, baseRemoval: item.path };
      }

      case SyncActionType.RenameRemote: {
        if (!item.renameFrom || !item.local || !item.remote) return { executed: false };
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        let updated: DriveItem;
        try {
          updated = item.targetParentRemoteId
            ? await this.onedrive.moveItemById(
                item.remote.driveId,
                item.remote.eTag,
                folderName(item.path),
                item.targetParentRemoteId,
              )
            : await this.onedrive.renameItem(
                this.vaultName,
                item.renameFrom,
                item.path,
                item.remote.driveId,
                item.remote.eTag,
              );
        } catch (error) {
          if (!(error instanceof OneDriveError) || !isRemoteMutationConflict(error)) throw error;
          const fresh = await this.onedrive.getFileMetadata(this.vaultName, item.renameFrom);
          if (!this.canContinue(operationEpoch, result)) return { executed: false };
          if (!fresh) {
            return this.queuePendingConflict({
              type: SyncActionType.Conflict,
              path: item.path,
              local: item.local,
              reason: "reason.remoteDeletedLocalModified",
            }, result, operationEpoch);
          }
          const remoteEntry = this.toMetadataRemoteEntry(
            item.renameFrom,
            fresh,
            item.remote.parentId,
          );
          remoteUpserts.push(remoteEntry);
          return this.queuePendingConflict({
            type: SyncActionType.Conflict,
            path: item.path,
            local: item.local,
            remote: remoteEntry,
            reason: "reason.bothSidesModified",
          }, result, operationEpoch);
        }
        // Defer persistent base removal and upsert to batch flush in caller.
        // Caller will see baseRemoval + baseUpsert and do both after pool drain.
        // Update remote state: old path removed, new path added
        const movedRemote: RemoteFileEntry = {
          path: item.path,
          driveId: updated.id,
          parentId: this.requireKnownRemoteParentId(
            item.path,
            updated.parentReference?.id,
            item.targetParentRemoteId ?? item.remote.parentId,
          ),
          size: updated.size ?? item.local.size,
          mtime: updated.lastModifiedDateTime
            ? new Date(updated.lastModifiedDateTime).getTime()
            : Date.now(),
          eTag: updated.eTag ?? "",
          cTag: updated.cTag ?? "",
          sha256Hash: item.local.hash,
          quickXorHash: item.local.quickXorHash,
        };
        if (
          updated.id !== item.remote.driveId
          || (
            item.targetParentRemoteId
            && movedRemote.parentId !== item.targetParentRemoteId
          )
        ) {
          throw new Error(`Remote file move lost its identity: ${item.renameFrom} -> ${item.path}`);
        }
        const [sourceAfter, targetAfter] = await Promise.all([
          this.inspectRemotePath(item.renameFrom),
          this.inspectRemotePath(item.path),
        ]);
        if (
          sourceAfter
          || !targetAfter
          || targetAfter.driveId !== item.remote.driveId
          || targetAfter.eTag !== movedRemote.eTag
          || (
            item.targetParentRemoteId
            && targetAfter.parentId !== item.targetParentRemoteId
          )
        ) {
          throw new Error(`Remote file move read-back failed: ${item.renameFrom} -> ${item.path}`);
        }
        remoteDeletes.push(item.renameFrom);
        remoteUpserts.push(movedRemote);
        if (item.targetParentRemoteId) {
          result.filesMoved = (result.filesMoved ?? 0) + 1;
        }
        return {
          executed: true,
          mutationApplied: true,
          baseUpsert: { path: item.path, hash: item.local.hash, size: item.local.size, eTag: updated.eTag ?? "" },
          baseRemoval: item.renameFrom,
        };
      }

      case SyncActionType.ConfirmLocalDelete: {
        // Route to pending — user must confirm
        result.conflicts++;
        return { executed: true };
      }

      case SyncActionType.Conflict: {
        const automatic = await this.tryAutomaticTextMerge(
          item,
          result,
          metrics,
          callbacks,
          operationEpoch,
          automaticHandlingPolicy,
        );
        if (automatic?.resolvedConflict || automatic?.executed === false) return automatic;
        result.conflicts++;
        return automatic ?? { executed: true };
      }

      case SyncActionType.SkipLargeFile:
        return { executed: true };

      case SyncActionType.SkipIgnoredPath:
        result.skippedIgnored++;
        return { executed: true };

      case SyncActionType.RetryLater:
        result.errors++;
        return { executed: true };

      case SyncActionType.FolderDeferred:
        result.deferred++;
        return { executed: true };

      case SyncActionType.AuthExpired:
        result.authExpired = true;
        return { executed: true };
    }
    return { executed: true };
  }

  private seedBaseEntriesFromCloudBaseline(
    json: string,
    localEntries: LocalFileEntry[],
    remoteEntries: RemoteFileEntry[],
  ): BaseFileEntry[] {
    let baseline: CloudBaseline;
    try {
      baseline = JSON.parse(json) as CloudBaseline;
    } catch (e) {
      this.diag?.warn("state", "cloud baseline parse failed", e);
      return [];
    }

    if (baseline.vaultName !== this.vaultName
      || !baseline.files || typeof baseline.files !== "object") {
      return [];
    }

    const localByPath = new Map(localEntries.map((entry) => [entry.path, entry]));
    const remoteByPath = new Map(remoteEntries.map((entry) => [entry.path, entry]));
    const seeded: BaseFileEntry[] = [];

    for (const [path, entry] of Object.entries(baseline.files)) {
      const local = localByPath.get(path);
      const remote = remoteByPath.get(path);
      if (!local || !remote) continue;
      if (typeof entry?.hash !== "string"
        || !/^[0-9a-f]{64}$/i.test(entry.hash)
        || typeof entry.size !== "number"
        || !Number.isSafeInteger(entry.size)
        || entry.size < 0
        || typeof entry.eTag !== "string"
        || !entry.eTag) continue;
      if (resolveContentEquality({
        local,
        remote,
        base: entry,
      }).status !== "equal") continue;
      seeded.push({
        path,
        hash: entry.hash,
        size: entry.size,
        eTag: remote.eTag,
      });
    }

    return seeded;
  }

  private seedBaseEntriesFromCloudBootstrapV2(
    json: string,
    syncScope: SyncScope,
    localEntries: LocalFileEntry[],
    remoteEntries: RemoteFileEntry[],
  ): BaseFileEntry[] {
    let remoteIndex: RemoteIndexV2 | null = null;
    const state = this.state as StateManager & {
      getCommittedV2Envelope?: StateManager["getCommittedV2Envelope"];
    };
    const committed = typeof state.getCommittedV2Envelope === "function"
      ? state.getCommittedV2Envelope()
      : null;
    if (committed && sameSyncScope(committed.scope, syncScope)) {
      remoteIndex = committed.remoteIndex;
    } else if (this.completeRemoteItems) {
      try {
        remoteIndex = buildRemoteIndexV2(
          this.completeRemoteItems,
          syncScope.filesRootId,
          null,
        ).index;
      } catch (error) {
        this.diag?.warn(
          "state",
          "V2 cloud bootstrap rejected because the remote identity index is incomplete",
          error instanceof Error ? error.message : String(error),
        );
        return [];
      }
    }
    if (!remoteIndex) return [];
    const verified = verifyCloudBootstrapV2(
      json,
      syncScope,
      remoteIndex,
      localEntries,
    );
    if (verified.status !== "verified") {
      this.diag?.warn(
        "state",
        `V2 cloud bootstrap rejected: ${verified.reason ?? "unknown"}`,
      );
      return [];
    }
    const remoteById = new Map(
      remoteEntries.map((entry) => [entry.driveId, entry]),
    );
    const localByPath = new Map(
      localEntries.map((entry) => [entry.path, entry]),
    );
    return verified.anchors.flatMap((anchor) => {
      const remote = remoteById.get(anchor.remoteId);
      const local = localByPath.get(anchor.lastPath);
      const sameObservedVersion = remote
        && remote.path === anchor.lastPath
        && remote.size === anchor.size
        && (
          anchor.remoteCTag
            ? remote.cTag === anchor.remoteCTag
            : Boolean(anchor.remoteETag)
              && remote.eTag === anchor.remoteETag
        )
        && (
          !remote.sha256Hash
          || remote.sha256Hash.toLowerCase() === anchor.contentHash.toLowerCase()
        )
        && (
          !remote.quickXorHash
          || !local?.quickXorHash
          || remote.quickXorHash === local.quickXorHash
        );
      return sameObservedVersion
        ? [{
            path: anchor.lastPath,
            hash: anchor.contentHash,
            size: anchor.size,
            eTag: remote.eTag,
          }]
        : [];
    });
  }

  private async downloadLegacyCloudBaseline(): Promise<string | null> {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.onedrive.downloadBaseline(this.vaultName);
      } catch (error) {
        const isLast = attempt === maxAttempts - 1;
        if (error instanceof OneDriveError && error.type === OneDriveErrorType.NotFound) {
          this.diag?.log("state", "no legacy cloud baseline");
          return null;
        }
        if (isLast) {
          this.diag?.warn(
            "state",
            "legacy cloud baseline download failed after retries",
            error instanceof Error ? error.message : String(error),
          );
          return null;
        }
        const waitMs = 500 * (2 ** attempt);
        this.diag?.log(
          "state",
          `legacy cloud baseline download failed (attempt ${attempt + 1}), retrying in ${waitMs}ms`,
        );
        await new Promise<void>((resolve) =>
          compatSetTimeout(() => resolve(), waitMs));
      }
    }
    return null;
  }

  private async publishHealthyCloudBootstrapV2(
    operationEpoch: number,
  ): Promise<void> {
    const state = this.state as StateManager & {
      getCommittedV2Envelope?: StateManager["getCommittedV2Envelope"];
      hasV2RecoveryJournal?: StateManager["hasV2RecoveryJournal"];
      getCloudBootstrapPublicationCheckpointV2?:
        StateManager["getCloudBootstrapPublicationCheckpointV2"];
      setCloudBootstrapPublicationCheckpointV2?:
        StateManager["setCloudBootstrapPublicationCheckpointV2"];
    };
    if (
      state.isV2StateActive !== true
      || typeof state.getCommittedV2Envelope !== "function"
      || typeof state.hasV2RecoveryJournal !== "function"
    ) return;
    const envelope = state.getCommittedV2Envelope();
    if (!envelope) return;
    const checkpoint =
      typeof state.getCloudBootstrapPublicationCheckpointV2 === "function"
        ? state.getCloudBootstrapPublicationCheckpointV2()
        : null;
    const anchorDigest = await cloudBootstrapAnchorDigestV2(envelope);
    if (
      checkpoint
      && cloudBootstrapCheckpointMatchesEnvelopeV2(
        checkpoint,
        envelope,
        anchorDigest,
      )
    ) return;
    const client = this.onedrive as OneDriveClient & {
      readCloudBootstrapV2?: OneDriveClient["readCloudBootstrapV2"];
      createCloudBootstrapV2?: OneDriveClient["createCloudBootstrapV2"];
      updateCloudBootstrapV2?: OneDriveClient["updateCloudBootstrapV2"];
      readCloudBootstrapV2ById?: OneDriveClient["readCloudBootstrapV2ById"];
    };
    if (
      typeof client.readCloudBootstrapV2 !== "function"
      || typeof client.createCloudBootstrapV2 !== "function"
      || typeof client.updateCloudBootstrapV2 !== "function"
      || typeof client.readCloudBootstrapV2ById !== "function"
    ) return;
    try {
      const result = await publishCloudBootstrapV2(
        createOneDriveCloudBootstrapTransportV2(client, this.vaultName),
        envelope,
        {
          envelopeCommitted: true,
          localScanComplete: true,
          remoteScanComplete: envelope.remoteIndex.complete === true,
          lifecycleCurrent: this.canContinue(operationEpoch),
          unresolvedMutations: this.state.mutationLedger.length,
          pendingItems: this.state.pendingConflicts.length
            + this.state.pendingRemoteDeletes.length
            + this.state.pendingIssues.length,
          stateRecoveryPending: await state.hasV2RecoveryJournal(),
        },
        Date.now(),
        checkpoint,
      );
      if (
        !result.dirty
        && result.checkpoint
        && typeof state.setCloudBootstrapPublicationCheckpointV2
          === "function"
      ) {
        await state.setCloudBootstrapPublicationCheckpointV2(
          result.checkpoint,
        );
      }
      if (result.published) {
        this.diag?.log(
          "state",
          `V2 cloud bootstrap published revision ${result.revision}`,
        );
      } else if (result.dirty) {
        this.diag?.warn(
          "state",
          `V2 cloud bootstrap remains dirty: ${result.reason ?? "unknown"}`,
        );
      }
    } catch (error) {
      this.diag?.warn(
        "state",
        "V2 cloud bootstrap publication deferred",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async persistSeededBaseEntries(entries: BaseFileEntry[]): Promise<void> {
    const merged = new Map<string, BaseFileEntry>();
    for (const entry of entries) {
      merged.set(entry.path, entry);
    }
    for (const entry of this.state.baseSnapshot) {
      merged.set(entry.path, entry);
    }
    const next = [...merged.values()];
    await this.stageVerifiedLocalAncestorContent(next);
    await this.state.setBaseSnapshot(next);
  }

  private async stageVerifiedLocalAncestorContent(
    entries: readonly BaseFileEntry[],
  ): Promise<void> {
    const configDir = getConfigDir(this.scanner.vault);
    for (const entry of entries) {
      if (
        entry.size > 2 * 1024 * 1024
        || !isAutomaticTextMergeCandidatePath(entry.path, configDir)
      ) continue;
      try {
        const content =
          await this.scanner.vault.adapter.readBinary(entry.path);
        if (
          content.byteLength === entry.size
          && await sha256Hex(content) === entry.hash
        ) {
          this.state.cacheBaseContent(entry.path, content);
        }
      } catch {
        // A common-state proof remains valid without ancestor bytes. Missing
        // text only disables future automatic merge for this path.
      }
    }
  }

  /**
   * Manual-only proof collection for a stable corrupt committed V2 envelope.
   * Collection is GET-only. A source-bound reviewed authorization may enter the
   * dedicated authority publication transaction; user/Graph plan mutations
   * remain outside this method and are revalidated by the ordinary V2 round.
   */
  private async runV2CorruptStateEvidenceCollection(input: {
    result: SyncResult;
    callbacks: SyncCallbacks;
    operationEpoch: number;
    automaticHandlingPolicy: AutomaticHandlingPolicy;
    communityPluginSyncPolicy: CommunityPluginSyncPolicyV1;
    enterPhase: (phase: SyncRunPhase) => void;
    reviewedAuthorization?: PlanReviewAuthorization;
  }): Promise<SyncResult> {
    const {
      result,
      callbacks,
      operationEpoch,
      automaticHandlingPolicy,
      communityPluginSyncPolicy,
      enterPhase,
      reviewedAuthorization,
    } = input;
    const publicEvidence = this.state.v2CorruptStateRecoveryEvidence;
    if (!publicEvidence) {
      result.errors = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      return result;
    }
    if (
      this.state.boundAccountId
      && this.state.boundAccountId !== publicEvidence.scope.accountId
    ) {
      result.errors = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.error(
        "state",
        "V2 corrupt-state evidence account does not match the bound account",
        { mutations: 0 },
      );
      return result;
    }

    let source: StateEnvelopeV2CorruptionEvidence;
    try {
      source = await this.state.prepareV2CorruptStateRecoverySource();
    } catch (error) {
      result.errors = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.error(
        "state",
        "V2 corrupt-state forensic source could not be preserved",
        error instanceof Error ? error.message : String(error),
      );
      return result;
    }
    const existingHold =
      this.state.activeV2CorruptStateRecoveryHold;
    if (existingHold) {
      const plan: SyncPlan = {
        items: structuredClone(existingHold.items),
        lastTotalFiles: existingHold.lastTotalFiles,
        confirmed: existingHold.phase === "confirmed",
        scope: { ...existingHold.scope },
        canonicalIdentity:
          structuredClone(existingHold.canonicalIdentity),
        canonicalReview: structuredClone(existingHold.canonicalReview),
      };
      if (
        reviewedAuthorization?.canonicalIdentity
        && sameCanonicalPlanIdentityV2(
          reviewedAuthorization.canonicalIdentity,
          existingHold.canonicalIdentity,
        )
      ) {
        const confirmed =
          await this.state.confirmV2CorruptStateRecoveryHold(
            reviewedAuthorization,
          );
        if (confirmed) {
          try {
            const published =
              await this.state.publishConfirmedV2CorruptStateRecovery(
                reviewedAuthorization,
              );
            result.success = true;
            result.message = this.t("result.synced", {
              uploaded: 0,
              downloaded: 0,
              foldersCreated: 0,
              foldersMoved: 0,
              foldersDeleted: 0,
              filesMoved: 0,
              deleted: 0,
              conflicts: 0,
              deferred: 0,
              errors: 0,
            });
            result.continueAfterV2CorruptStateRecovery = true;
            this.diag?.warn(
              "state",
              "V2 corrupt-state recovery authority published; handing the reviewed plan to the ordinary V2 chain",
              {
                holdRevision: confirmed.revision,
                sourceDigest: confirmed.sourceDigest,
                sourceCommitSeq: confirmed.sourceCommitSeq,
                targetCommitSeq: published.meta.commitSeq,
                planItems: confirmed.items.length,
                mutations: 0,
              },
            );
          } catch (error) {
            result.errors = 1;
            result.message = this.t("result.v2StateLoadBlocked");
            this.diag?.error(
              "state",
              "V2 corrupt-state recovery authority publication failed closed",
              error instanceof Error ? error.message : String(error),
            );
          }
          return result;
        }
      }
      const publishPreview =
        callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
      if (publishPreview) await publishPreview(plan);
      result.message = this.t("result.pausedForReview");
      return result;
    }
    enterPhase("remotePrepare");
    this.progressStore?.setPhase("preparing");
    callbacks.onProgress?.(0, 1, this.t("progress.preparingRemote"));
    if (
      typeof this.onedrive.restoreVaultScopeByIdentity !== "function"
    ) {
      result.errors = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      return result;
    }
    try {
      this.onedrive.invalidateVaultScope(this.vaultName);
      const restored = await this.onedrive.restoreVaultScopeByIdentity(
        this.vaultName,
        {
          driveId: source.scope.driveId,
          vaultFolderId: source.scope.vaultFolderId,
          filesRootId: source.scope.filesRootId,
        },
      );
      if (
        restored.driveId !== source.scope.driveId
        || restored.vaultFolderId !== source.scope.vaultFolderId
        || restored.filesRootId !== source.scope.filesRootId
      ) {
        throw new Error(
          "V2 corrupt-state scope identity read-back changed",
        );
      }
    } catch (error) {
      result.deferred = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.warn(
        "state",
        "V2 corrupt-state exact remote scope is not currently observable",
        {
          cause: error instanceof Error ? error.message : String(error),
          mutations: 0,
        },
      );
      return result;
    }
    if (this.shouldStop(result, operationEpoch)) return result;

    enterPhase("scan");
    this.progressStore?.setPhase("scanning");
    callbacks.onProgress?.(0, 1, this.t("progress.scanningLocal"));
    const scan = await this.scanner.scanAll();
    if (
      scan.complete === false
      || scan.failedPaths.length > 0
      || scan.folderScanComplete !== true
    ) {
      result.errors = Math.max(1, new Set(scan.failedPaths).size);
      result.message = this.t("result.scanIncomplete");
      return result;
    }
    if (this.shouldStop(result, operationEpoch)) return result;

    enterPhase("remoteChanges");
    this.progressStore?.setPhase("checking");
    callbacks.onProgress?.(0, 1, this.t("progress.checkingRemote"));
    const firstDelta = await this.onedrive.getDeltaByFolderId(
      source.scope.filesRootId,
    );
    const liveItems = [...new Map(
      firstDelta.value.map((item) => [item.id, item]),
    ).values()].filter((item) =>
      !item.deleted && Boolean(item.file || item.folder));
    const remoteItems = this.selectFilesRootDescendants(
      liveItems,
      source.scope.filesRootId,
    );
    let preliminary;
    try {
      preliminary = buildRemoteIndexV2(
        remoteItems,
        source.scope.filesRootId,
        firstDelta["@odata.deltaLink"] ?? null,
      );
    } catch (error) {
      result.errors = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.error(
        "state",
        "V2 corrupt-state live remote identity snapshot is incomplete",
        error instanceof Error ? error.message : String(error),
      );
      return result;
    }
    const localByPath = new Map(
      scan.entries.map((entry) => [
        normalizeRemotePathKey(entry.path),
        entry,
      ]),
    );
    const itemById = new Map(remoteItems.map((item) => [item.id, item]));
    const verifiedRemoteHashesById: Record<string, string> = {};
    const verificationCandidates = Object.values(
      preliminary.index.itemsById,
    ).flatMap((node) => {
      if (node.kind !== "file" || node.contentHash) return [];
      const path = preliminary.pathById.get(node.id);
      if (!path || typeof node.size !== "number") return [];
      const local = localByPath.get(normalizeRemotePathKey(path));
      return local?.size === node.size ? [{ node, path }] : [];
    });
    let verifiedCount = 0;
    for (const { node, path } of verificationCandidates) {
      verifiedCount++;
      this.progressStore?.setPhase("verifying");
      this.progressStore?.setProgress(
        verifiedCount,
        verificationCandidates.length,
        path,
      );
      callbacks.onProgress?.(
        verifiedCount,
        verificationCandidates.length,
        this.t("progress.verifyingFiles", {
          current: verifiedCount,
          total: verificationCandidates.length,
        }),
      );
      const item = itemById.get(node.id);
      if (!item) {
        result.errors = 1;
        result.message = this.t("result.v2StateLoadBlocked");
        return result;
      }
      const content = await this.onedrive.downloadFile(
        this.vaultName,
        path,
        item["@microsoft.graph.downloadUrl"],
        node.id,
        node.size,
      );
      const hash = await sha256Hex(content);
      await this.verifyDownloadedPayload(
        path,
        this.toRemoteEntry(item, path, node.parentId),
        { size: content.byteLength, hash },
      );
      verifiedRemoteHashesById[node.id] = hash;
      if (this.shouldStop(result, operationEpoch)) return result;
    }

    const firstDeltaLink = firstDelta["@odata.deltaLink"];
    if (!firstDeltaLink) {
      result.deferred = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      return result;
    }
    const stabilityDelta = await this.onedrive.getDeltaByFolderId(
      source.scope.filesRootId,
      firstDeltaLink,
    );
    if (stabilityDelta.value.length > 0) {
      result.deferred = Math.max(1, stabilityDelta.value.length);
      result.message = this.t("result.generationMismatch");
      this.diag?.warn(
        "state",
        "V2 corrupt-state live tree changed during evidence collection",
        {
          changedItems: stabilityDelta.value.length,
          mutations: 0,
        },
      );
      return result;
    }
    try {
      this.onedrive.invalidateVaultScope(this.vaultName);
      const restored = await this.onedrive.restoreVaultScopeByIdentity(
        this.vaultName,
        {
          driveId: source.scope.driveId,
          vaultFolderId: source.scope.vaultFolderId,
          filesRootId: source.scope.filesRootId,
        },
      );
      if (
        restored.driveId !== source.scope.driveId
        || restored.vaultFolderId !== source.scope.vaultFolderId
        || restored.filesRootId !== source.scope.filesRootId
      ) {
        throw new Error(
          "V2 corrupt-state scope identity changed during collection",
        );
      }
      await this.state.assertV2CorruptStateRecoverySourceCurrent(
        source.sourceDigest,
      );
    } catch (error) {
      result.deferred = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.warn(
        "state",
        "V2 corrupt-state source or scope changed during evidence collection",
        {
          cause: error instanceof Error ? error.message : String(error),
          mutations: 0,
        },
      );
      return result;
    }

    const sourceAncestorHashes =
      source.corruption === "remote-index"
        ? collectCorruptSourceAncestorHashes(source.rawEnvelope)
        : [];
    const verifiedAncestorHashes = new Set(
      await this.state.verifyV2AncestorHashes(sourceAncestorHashes),
    );
    const prepared = await buildCorruptStateRecoveryCandidateV2({
      source,
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: scan.entries,
      localFolders: scan.folders ?? [],
      remoteItems,
      remoteScanComplete: true,
      deltaLink: stabilityDelta["@odata.deltaLink"] ?? firstDeltaLink,
      verifiedRemoteHashesById,
      verifiedAncestorHashes,
    });
    if (prepared.status !== "ready" || !prepared.envelope) {
      result.deferred = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.warn(
        "state",
        "V2 corrupt-state recovery candidate was rejected",
        {
          reason: prepared.reason ?? "unknown",
          mutations: 0,
        },
      );
      return result;
    }

    enterPhase("planning");
    this.progressStore?.setPhase("planning");
    const configDir = getConfigDir(this.scanner.vault);
    const structuredCommunityPluginPath =
      communityPluginSyncPolicy.files.mode !== "none"
        ? `${configDir}/community-plugins.json`
        : null;
    const planningLocalEntries = scan.entries.filter((entry) =>
      entry.path !== structuredCommunityPluginPath
      && this.shouldIncludeRemotePath(entry.path)
      && isCommunityPluginPathSelectedByPolicy(
        entry.path,
        communityPluginSyncPolicy,
        configDir,
      ));
    let canonical = buildCanonicalPlanCandidateV2({
      envelope: prepared.envelope,
      localFiles: planningLocalEntries,
      localFolders: scan.folders ?? [],
      localFolderScanComplete: true,
      skippedLarge: scan.skippedLarge,
      localMoveHints: [],
      includeFilePath: (path) =>
        path !== structuredCommunityPluginPath
        && this.shouldIncludeRemotePath(path)
        && isCommunityPluginPathSelectedByPolicy(
          path,
          communityPluginSyncPolicy,
          configDir,
        ),
      includeFolderPath: (path) =>
        this.scanner.shouldSyncFolderPath(path),
      preserveFolderPath: (path) =>
        !this.scanner.shouldSyncFolderPath(path)
        || isCommunityPluginFolderPreservedByPolicy(
          path,
          communityPluginSyncPolicy,
          configDir,
        ),
      configDir,
      automaticDeleteLocalFiles:
        automaticHandlingPolicy.autoDeleteLocalFiles,
    });
    if (canonical.status === "rejected") {
      result.deferred = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.warn(
        "plan",
        "V2 corrupt-state canonical candidate was rejected",
        { reason: canonical.rejectionReason, mutations: 0 },
      );
      return result;
    }
    canonical = {
      ...canonical,
      items: protectEasySyncSelfSyncPlan(
        protectCommunityPluginPlan(
          canonical.items,
          communityPluginSyncPolicy,
          configDir,
          planningLocalEntries,
        ),
        configDir,
      ),
    };
    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate: canonical,
      envelope: prepared.envelope,
      vaultName: this.vaultName,
      accountId: source.scope.accountId,
      automaticHandlingPolicy,
      baselineReconstructionIncomplete: false,
      pendingContentComparisons: [],
      resolveRemoteContentHash: async (item, progress) => {
        const remote = item.remote!;
        const live = itemById.get(remote.driveId);
        if (!live) {
          throw new Error(
            `V2 corrupt-state remote item disappeared: ${remote.driveId}`,
          );
        }
        this.progressStore?.setPhase("verifying");
        this.progressStore?.setProgress(
          progress.current,
          progress.total,
          item.path,
        );
        callbacks.onProgress?.(
          progress.current,
          progress.total,
          this.t("progress.verifyingFiles", progress),
        );
        const content = await this.onedrive.downloadFile(
          this.vaultName,
          item.path,
          live["@microsoft.graph.downloadUrl"],
          remote.driveId,
          remote.size,
        );
        const hash = await sha256Hex(content);
        await this.verifyDownloadedPayload(
          item.path,
          remote,
          { size: content.byteLength, hash },
        );
        return hash;
      },
    });
    if (finalized.baseUpserts.length > 0) {
      result.deferred = Math.max(1, finalized.baseUpserts.length);
      result.message = this.t("result.v2StateLoadBlocked");
      this.diag?.warn(
        "plan",
        "V2 corrupt-state candidate omitted newly proven common versions",
        {
          baseUpserts: finalized.baseUpserts.length,
          mutations: 0,
        },
      );
      return result;
    }
    await this.state.assertV2CorruptStateRecoverySourceCurrent(
      source.sourceDigest,
    );
    const canonicalReview =
      summarizeCanonicalPlanReviewV2(finalized.items);
    const canonicalIdentity = {
      version: 2 as const,
      scope: { ...prepared.envelope.scope },
      sourceCommitSeq: prepared.envelope.meta.commitSeq,
      digest: canonicalPlanDigestV2({
        items: finalized.items,
        lastTotalFiles: finalized.lastTotalFiles,
        scope: prepared.envelope.scope,
        sourceCommitSeq: prepared.envelope.meta.commitSeq,
      }),
    };
    const hold = await this.state.stageV2CorruptStateRecoveryHold({
      source,
      candidate: prepared.envelope,
      canonicalIdentity,
      canonicalReview,
      lastTotalFiles: finalized.lastTotalFiles,
      items: finalized.items,
    });
    const plan: SyncPlan = {
      items: structuredClone(hold.items),
      lastTotalFiles: hold.lastTotalFiles,
      confirmed: false,
      scope: { ...hold.scope },
      canonicalIdentity: structuredClone(hold.canonicalIdentity),
      canonicalReview: structuredClone(hold.canonicalReview),
    };
    this.diag?.warn(
      "state",
      "V2 corrupt-state GET-only candidate staged for canonical review; authority remains blocked",
      {
        sourceDigest: source.sourceDigest,
        sourceCommitSeq: source.sourceCommitSeq,
        targetCommitSeq: prepared.envelope.meta.commitSeq,
        facts: prepared.facts,
        planItems: finalized.items.length,
        reviewImpact: canonicalReview.impactCount,
        holdRevision: hold.revision,
        mutations: 0,
      },
    );
    const publishPreview =
      callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
    if (publishPreview) await publishPreview(plan);
    result.message = this.t("result.pausedForReview");
    return result;
  }

  private async runV2RemoteScopeRecovery(input: {
    result: SyncResult;
    callbacks: SyncCallbacks;
    operationEpoch: number;
    automaticHandlingPolicy: AutomaticHandlingPolicy;
    communityPluginSyncPolicy: CommunityPluginSyncPolicyV1;
    enterPhase: (phase: SyncRunPhase) => void;
    reviewedAuthorization?: PlanReviewAuthorization;
  }): Promise<SyncResult | null> {
    const {
      result,
      callbacks,
      operationEpoch,
      automaticHandlingPolicy,
      communityPluginSyncPolicy,
      enterPhase,
      reviewedAuthorization,
    } = input;
    let sourceEnvelope = this.state.getCommittedV2Envelope();
    let recovery = sourceEnvelope?.remoteScopeRecovery;
    if (!sourceEnvelope || !recovery) {
      result.errors = 1;
      result.message = this.t("result.v2StateLoadBlocked");
      return result;
    }
    enterPhase("remotePrepare");
    this.progressStore?.setPhase("preparing");
    callbacks.onProgress?.(0, 1, this.t("progress.preparingRemote"));
    // Re-read the configured path on every explicit recovery attempt. An
    // earlier replacement identity may still exist after it was moved away;
    // ID lookup alone would then prove the wrong folder, while a path-based
    // delta could silently observe a newer replacement. A previously
    // confirmed bootstrap is the sole exception: retry its idempotent
    // create-missing sequence first so a crash after creating only part of
    // the infrastructure cannot strand the control transaction.
    let observedScope =
      recovery.scopeBootstrap?.phase === "confirmed"
        ? await this.createV2RemoteScopeInfrastructure(
            sourceEnvelope.scope.accountId,
          )
        : await this.observeCurrentV2RecoveryScope(
            sourceEnvelope.scope.accountId,
          );

    if (
      observedScope
      && sameSyncScope(observedScope, sourceEnvelope.scope)
    ) {
      await this.state.resolveV2RemoteScopeRecoveryToCommittedScope(
        observedScope,
      );
      this.activeSyncScope = observedScope;
      this.startGeneration = this.state.remoteGeneration;
      this.diag?.warn(
        "state",
        "committed V2 remote scope identity is reachable again; cleared the hold and resumed the ordinary V2 round",
        { mutations: 0 },
      );
      return null;
    }

    const observationChanged =
      recovery.observedScope === null
        ? observedScope !== null
        : !sameSyncScope(recovery.observedScope, observedScope);
    if (observationChanged) {
      await this.state.refreshV2RemoteScopeRecoveryObservation({
        observedScope,
      });
      sourceEnvelope = this.state.getCommittedV2Envelope();
      recovery = sourceEnvelope?.remoteScopeRecovery;
      if (!sourceEnvelope || !recovery) {
        result.errors = 1;
        result.message = this.t("result.v2StateLoadBlocked");
        return result;
      }
      this.startGeneration = this.state.remoteGeneration;
      this.diag?.warn(
        "state",
        "V2 remote scope recovery refreshed its GET-only path observation",
        {
          observedScopeAvailable: observedScope !== null,
          mutations: 0,
        },
      );
    }
    if (!observedScope) {
      if (!recovery.scopeBootstrap) {
        sourceEnvelope =
          await this.state.stageV2RemoteScopeBootstrapReview();
        recovery = sourceEnvelope.remoteScopeRecovery;
        this.startGeneration = this.state.remoteGeneration;
      }
      const reviewPlan = this.buildV2RemoteScopeBootstrapReview(
        sourceEnvelope,
      );
      const reviewedBootstrap =
        recovery?.scopeBootstrap?.phase === "pending"
        && reviewedAuthorization?.canonicalIdentity !== undefined
        && sameCanonicalPlanIdentityV2(
          reviewedAuthorization.canonicalIdentity,
          reviewPlan.canonicalIdentity,
        )
        && reviewedAuthorization.revision
          === this.state.planReviewRevision
        && sameSyncScope(
          reviewedAuthorization.scope,
          sourceEnvelope.scope,
        );
      if (!reviewedBootstrap) {
        const publishPreview =
          callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
        if (publishPreview) await publishPreview(reviewPlan);
        result.message = this.t("result.pausedForReview");
        this.diag?.warn(
          "state",
          "missing V2 remote scope requires an explicit create-only infrastructure review",
          {
            phase: recovery?.scopeBootstrap?.phase ?? null,
            mutations: 0,
          },
        );
        return result;
      }

      sourceEnvelope =
        await this.state.confirmV2RemoteScopeBootstrapReview(
          reviewedAuthorization!,
        );
      recovery = sourceEnvelope.remoteScopeRecovery;
      this.startGeneration = this.state.remoteGeneration;
      observedScope = await this.createV2RemoteScopeInfrastructure(
        sourceEnvelope.scope.accountId,
      );
      if (sameSyncScope(observedScope, sourceEnvelope.scope)) {
        await this.state.resolveV2RemoteScopeRecoveryToCommittedScope(
          observedScope,
        );
        this.activeSyncScope = observedScope;
        this.startGeneration = this.state.remoteGeneration;
        return null;
      }
      await this.state.refreshV2RemoteScopeRecoveryObservation({
        observedScope,
      });
      sourceEnvelope = this.state.getCommittedV2Envelope();
      recovery = sourceEnvelope?.remoteScopeRecovery;
      if (!sourceEnvelope || !recovery) {
        result.errors = 1;
        result.message = this.t("result.v2StateLoadBlocked");
        return result;
      }
      this.startGeneration = this.state.remoteGeneration;
      this.diag?.warn(
        "state",
        "confirmed V2 remote scope infrastructure was created and rebound to its exact identities",
        { mutations: 1 },
      );
    }
    if (
      !recovery.observedScope
      || !sameSyncScope(observedScope, recovery.observedScope)
    ) {
      result.deferred = 1;
      result.message = this.t("result.v2ScopeRecoveryPending");
      return result;
    }

    // A path lookup can refresh an observation without marking the scope as
    // initialized. Rebind the exact identities once before delta access so no
    // later client helper can fall through to create-missing initialization.
    this.onedrive.invalidateVaultScope(this.vaultName);
    const restoredObserved = await this.onedrive.restoreVaultScopeByIdentity(
      this.vaultName,
      {
        driveId: observedScope.driveId,
        vaultFolderId: observedScope.vaultFolderId,
        filesRootId: observedScope.filesRootId,
      },
    );
    if (
      restoredObserved.driveId !== observedScope.driveId
      || restoredObserved.vaultFolderId !== observedScope.vaultFolderId
      || restoredObserved.filesRootId !== observedScope.filesRootId
    ) {
      result.deferred = 1;
      result.message = this.t("result.v2ScopeRecoveryPending");
      return result;
    }
    const initialPathBinding = await this.recheckV2RecoveryPathBinding(
      sourceEnvelope.scope,
      observedScope,
    );
    if (initialPathBinding !== "stable") {
      if (initialPathBinding === "committed-scope-restored") return null;
      result.deferred = 1;
      result.message = this.t("result.v2ScopeRecoveryPending");
      this.diag?.warn(
        "state",
        "V2 remote scope path ownership changed before identity snapshot collection",
        { mutations: 0 },
      );
      return result;
    }
    this.activeSyncScope = observedScope;
    if (this.shouldStop(result, operationEpoch)) return result;

    enterPhase("scan");
    this.progressStore?.setPhase("scanning");
    callbacks.onProgress?.(0, 1, this.t("progress.scanningLocal"));
    const scan = await this.scanner.scanAll();
    if (
      scan.complete === false
      || scan.failedPaths.length > 0
      || scan.folderScanComplete !== true
    ) {
      result.errors = Math.max(1, new Set(scan.failedPaths).size);
      result.message = this.t("result.scanIncomplete");
      return result;
    }
    if (this.shouldStop(result, operationEpoch)) return result;

    enterPhase("remoteChanges");
    this.progressStore?.setPhase("checking");
    callbacks.onProgress?.(0, 1, this.t("progress.checkingRemote"));
    const firstDelta = await this.onedrive.getDeltaByFolderId(
      observedScope.filesRootId,
    );
    const liveItems = [...new Map(
      firstDelta.value.map((item) => [item.id, item]),
    ).values()].filter((item) =>
      !item.deleted && Boolean(item.file || item.folder));
    const remoteItems = this.selectFilesRootDescendants(
      liveItems,
      observedScope.filesRootId,
    );
    const preliminary = buildRemoteIndexV2(
      remoteItems,
      observedScope.filesRootId,
      firstDelta["@odata.deltaLink"] ?? null,
      sourceEnvelope.remoteIndex.cursorRevision + 1,
    );
    const localByPath = new Map(
      scan.entries.map((entry) => [
        normalizeRemotePathKey(entry.path),
        entry,
      ]),
    );
    const oldAnchorByPath = new Map(
      Object.values(sourceEnvelope.anchors.byAnchorId).map((anchor) => [
        normalizeRemotePathKey(anchor.lastPath),
        anchor,
      ]),
    );
    const itemById = new Map(remoteItems.map((item) => [item.id, item]));
    const verifiedRemoteHashesById: Record<string, string> = {};
    const verificationCandidates = Object.values(
      preliminary.index.itemsById,
    ).flatMap((node) => {
      if (node.kind !== "file" || node.contentHash) return [];
      const path = preliminary.pathById.get(node.id);
      if (!path || typeof node.size !== "number") return [];
      const pathKey = normalizeRemotePathKey(path);
      const local = localByPath.get(pathKey);
      const prior = oldAnchorByPath.get(pathKey);
      return (
          local?.size === node.size
          || prior?.size === node.size
        )
        ? [{ node, path }]
        : [];
    });
    let verifiedCount = 0;
    for (const { node, path } of verificationCandidates) {
      verifiedCount++;
      this.progressStore?.setPhase("verifying");
      this.progressStore?.setProgress(
        verifiedCount,
        verificationCandidates.length,
        path,
      );
      callbacks.onProgress?.(
        verifiedCount,
        verificationCandidates.length,
        this.t("progress.verifyingFiles", {
          current: verifiedCount,
          total: verificationCandidates.length,
        }),
      );
      const item = itemById.get(node.id);
      if (!item) {
        throw new Error(`V2 scope recovery remote item disappeared: ${node.id}`);
      }
      const content = await this.onedrive.downloadFile(
        this.vaultName,
        path,
        item["@microsoft.graph.downloadUrl"],
        node.id,
        node.size,
      );
      const hash = await sha256Hex(content);
      await this.verifyDownloadedPayload(
        path,
        this.toRemoteEntry(item, path, node.parentId),
        { size: content.byteLength, hash },
      );
      verifiedRemoteHashesById[node.id] = hash;
      if (this.shouldStop(result, operationEpoch)) return result;
    }

    // Bind downloaded content evidence to the complete identity snapshot.
    // Any change after the first delta makes this attempt stale; the user can
    // retry from a fresh complete snapshot without committing partial facts.
    const firstDeltaLink = firstDelta["@odata.deltaLink"];
    if (!firstDeltaLink) {
      result.deferred = 1;
      result.message = this.t("result.v2ScopeRecoveryPending");
      this.diag?.warn(
        "state",
        "V2 remote scope recovery complete scan returned no stable delta cursor",
        { mutations: 0 },
      );
      return result;
    }
    const stabilityDelta = await this.onedrive.getDeltaByFolderId(
      observedScope.filesRootId,
      firstDeltaLink,
    );
    if (stabilityDelta.value.length > 0) {
      result.deferred = Math.max(1, stabilityDelta.value.length);
      result.message = this.t("result.generationMismatch");
      this.diag?.warn(
        "state",
        "V2 remote scope recovery live tree changed during proof collection; candidate discarded",
        {
          changedItems: stabilityDelta.value.length,
          mutations: 0,
        },
      );
      return result;
    }
    const finalPathBinding = await this.recheckV2RecoveryPathBinding(
      sourceEnvelope.scope,
      observedScope,
    );
    if (finalPathBinding !== "stable") {
      if (finalPathBinding === "committed-scope-restored") return null;
      result.deferred = 1;
      result.message = this.t("result.v2ScopeRecoveryPending");
      this.diag?.warn(
        "state",
        "V2 remote scope path ownership changed during identity snapshot collection; candidate discarded",
        { mutations: 0 },
      );
      return result;
    }

    const prepared = buildRemoteScopeRecoveryCandidateV2({
      sourceEnvelope,
      observedScope,
      localScanComplete: true,
      localFolderScanComplete: true,
      localFiles: scan.entries,
      localFolders: scan.folders ?? [],
      remoteItems,
      remoteScanComplete: true,
      deltaLink: stabilityDelta["@odata.deltaLink"]
        ?? firstDeltaLink,
      verifiedRemoteHashesById,
    });
    if (prepared.status !== "ready" || !prepared.envelope) {
      result.deferred = 1;
      result.message = this.t("result.v2ScopeRecoveryPending");
      this.diag?.warn(
        "state",
        "V2 remote scope recovery candidate was rejected",
        {
          reason: prepared.reason ?? "unknown",
          mutations: 0,
        },
      );
      return result;
    }

    enterPhase("planning");
    this.progressStore?.setPhase("planning");
    const configDir = getConfigDir(this.scanner.vault);
    const structuredCommunityPluginPath =
      communityPluginSyncPolicy.files.mode !== "none"
        ? `${configDir}/community-plugins.json`
        : null;
    const planningLocalEntries = scan.entries.filter((entry) =>
      entry.path !== structuredCommunityPluginPath
      && this.shouldIncludeRemotePath(entry.path)
      && isCommunityPluginPathSelectedByPolicy(
        entry.path,
        communityPluginSyncPolicy,
        configDir,
      ));
    let canonical = buildCanonicalPlanCandidateV2({
      envelope: prepared.envelope,
      localFiles: planningLocalEntries,
      localFolders: scan.folders ?? [],
      localFolderScanComplete: true,
      skippedLarge: scan.skippedLarge,
      localMoveHints: [],
      includeFilePath: (path) =>
        path !== structuredCommunityPluginPath
        && this.shouldIncludeRemotePath(path)
        && isCommunityPluginPathSelectedByPolicy(
          path,
          communityPluginSyncPolicy,
          configDir,
        ),
      includeFolderPath: (path) =>
        this.scanner.shouldSyncFolderPath(path),
      preserveFolderPath: (path) =>
        !this.scanner.shouldSyncFolderPath(path)
        || isCommunityPluginFolderPreservedByPolicy(
          path,
          communityPluginSyncPolicy,
          configDir,
        ),
      configDir,
      automaticDeleteLocalFiles:
        automaticHandlingPolicy.autoDeleteLocalFiles,
    });
    if (canonical.status === "rejected") {
      result.deferred = 1;
      result.message = this.t("result.v2ScopeRecoveryPending");
      this.diag?.warn(
        "plan",
        "V2 remote scope recovery canonical candidate was rejected",
        {
          reason: canonical.rejectionReason,
          mutations: 0,
        },
      );
      return result;
    }
    canonical = {
      ...canonical,
      items: protectEasySyncSelfSyncPlan(
        protectCommunityPluginPlan(
          canonical.items,
          communityPluginSyncPolicy,
          configDir,
          planningLocalEntries,
        ),
        configDir,
      ),
    };
    const finalized = await finalizeCanonicalPlanCandidateV2({
      candidate: canonical,
      envelope: prepared.envelope,
      vaultName: this.vaultName,
      accountId: this.state.boundAccountId,
      automaticHandlingPolicy,
      baselineReconstructionIncomplete: false,
      pendingContentComparisons: [],
      resolveRemoteContentHash: async (item, progress) => {
        const remote = item.remote!;
        this.progressStore?.setPhase("verifying");
        this.progressStore?.setProgress(
          progress.current,
          progress.total,
          item.path,
        );
        callbacks.onProgress?.(
          progress.current,
          progress.total,
          this.t("progress.verifyingFiles", progress),
        );
        const content = await this.onedrive.downloadFile(
          this.vaultName,
          item.path,
          remote.downloadUrl,
          remote.driveId,
          remote.size,
        );
        const hash = await sha256Hex(content);
        await this.verifyDownloadedPayload(
          item.path,
          remote,
          { size: content.byteLength, hash },
        );
        return hash;
      },
    });
    if (finalized.baseUpserts.length > 0) {
      throw new Error(
        "V2 scope recovery candidate missed exact common content evidence",
      );
    }

    enterPhase("commit");
    const sourceProtocolBinding =
      await this.state.getActiveV2ProtocolBinding();
    let nextProtocolBinding: SharedSyncProtocolBindingV2 | undefined;
    if (sourceProtocolBinding) {
      const relocatedProtocol = await ensureSharedSyncProtocolV2(
        createOneDriveSharedSyncProtocolTransportV2(
          this.onedrive,
          this.vaultName,
        ),
        {
          scope: prepared.envelope.scope,
          acknowledgeMigrationRisk: false,
          expectedBinding: sourceProtocolBinding,
        },
      );
      if (relocatedProtocol.status !== "ready") {
        result.errors = 1;
        result.message = this.t("result.v2ProtocolBlocked");
        this.diag?.error(
          "state",
          "shared V2 sync protocol could not follow the recovered scope",
          {
            reason: relocatedProtocol.status === "blocked"
              ? relocatedProtocol.reason
              : "acknowledgement-required",
            mutations: 0,
          },
        );
        return result;
      }
      nextProtocolBinding = relocatedProtocol.binding;
    }
    const committed = await this.state.commitV2RemoteScopeRecoveryCandidate(
      prepared.envelope,
      Date.now(),
      nextProtocolBinding,
    );
    const sealed = sealCanonicalPlanV2({
      finalized,
      sourceEnvelope: prepared.envelope,
      committedEnvelope: committed,
    });
    const plan: SyncPlan = {
      items: sealed.items,
      lastTotalFiles: sealed.lastTotalFiles,
      confirmed: false,
      scope: { ...sealed.scope },
      canonicalIdentity: sealed.canonicalIdentity,
      canonicalReview: sealed.canonicalReview,
    };
    this.diag?.warn(
      "state",
      "V2 remote scope recovery authority committed from complete live facts",
      {
        facts: prepared.facts,
        planItems: plan.items.length,
        sourceCommitSeq: sourceEnvelope.meta.commitSeq,
        targetCommitSeq: committed.meta.commitSeq,
        mutations: 0,
      },
    );
    if (plan.items.length > 0) {
      const publishPreview =
        callbacks.onConfirmThreshold ?? callbacks.onFirstSyncPreview;
      if (publishPreview) await publishPreview(plan);
      result.message = this.t("result.pausedForReview");
      return result;
    }

    await this.state.setLastSyncTime(Date.now());
    result.success = true;
    result.message = this.t("result.synced", {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    return result;
  }

  private buildV2RemoteScopeBootstrapReview(
    envelope: SyncStateEnvelopeV2,
  ): SyncPlan {
    const bootstrap = envelope.remoteScopeRecovery?.scopeBootstrap;
    if (
      envelope.remoteScopeRecovery?.observedScope !== null
      || !bootstrap
      || bootstrap.phase !== "pending"
      || bootstrap.reviewSourceCommitSeq !== envelope.meta.commitSeq
    ) {
      throw new Error("V2 remote scope bootstrap review facts are invalid");
    }
    const items: SyncPlanItem[] = [{
      type: SyncActionType.RecreateRemoteScope,
      path: this.vaultName,
      reason: "reason.remoteScopeRecreate",
      reviewImpactCount: 1,
    }];
    const lastTotalFiles = Object.keys(
      envelope.anchors.byAnchorId,
    ).length;
    const digest = canonicalPlanDigestV2({
      items,
      lastTotalFiles,
      scope: envelope.scope,
      sourceCommitSeq: envelope.meta.commitSeq,
    });
    return {
      items,
      lastTotalFiles,
      confirmed: false,
      scope: { ...envelope.scope },
      canonicalIdentity: {
        version: 2,
        scope: { ...envelope.scope },
        sourceCommitSeq: envelope.meta.commitSeq,
        digest,
      },
      canonicalReview: summarizeCanonicalPlanReviewV2(items),
    };
  }

  private async createV2RemoteScopeInfrastructure(
    accountId: string,
  ): Promise<SyncScope> {
    this.onedrive.invalidateVaultScope(this.vaultName);
    const created = await this.onedrive.initVaultScope(
      this.vaultName,
      { createMissing: true },
    );
    this.onedrive.invalidateVaultScope(this.vaultName);
    const restored = await this.onedrive.restoreVaultScopeByIdentity(
      this.vaultName,
      created,
    );
    if (
      restored.driveId !== created.driveId
      || restored.vaultFolderId !== created.vaultFolderId
      || restored.filesRootId !== created.filesRootId
    ) {
      throw new Error(
        "Created V2 remote scope identities failed exact read-back",
      );
    }
    return {
      accountId,
      ...restored,
    };
  }

  private async observeCurrentV2RecoveryScope(
    accountId: string,
  ): Promise<SyncScope | null> {
    this.onedrive.invalidateVaultScope(this.vaultName);
    try {
      const observed = await this.onedrive.initVaultScope(
        this.vaultName,
        { createMissing: false },
      );
      return {
        accountId,
        ...observed,
      };
    } catch (error) {
      if (remoteScopeLossReason(error)) return null;
      throw error;
    }
  }

  private async recheckV2RecoveryPathBinding(
    committedScope: SyncScope,
    expectedObservedScope: SyncScope,
  ): Promise<
    "stable"
    | "committed-scope-restored"
    | "observation-changed"
  > {
    const currentPathScope = await this.observeCurrentV2RecoveryScope(
      committedScope.accountId,
    );
    if (
      currentPathScope
      && sameSyncScope(currentPathScope, expectedObservedScope)
    ) {
      return "stable";
    }
    if (
      currentPathScope
      && sameSyncScope(currentPathScope, committedScope)
    ) {
      await this.state.resolveV2RemoteScopeRecoveryToCommittedScope(
        currentPathScope,
      );
      this.activeSyncScope = currentPathScope;
      this.startGeneration = this.state.remoteGeneration;
      return "committed-scope-restored";
    }
    await this.state.refreshV2RemoteScopeRecoveryObservation({
      observedScope: currentPathScope,
    });
    this.startGeneration = this.state.remoteGeneration;
    return "observation-changed";
  }

  private async resolveV2CommittedScopeLoss(
    committedScope: SyncScope,
    cause: unknown,
  ): Promise<V2CommittedScopeUnreachableError> {
    const causeReason = remoteScopeLossReason(cause);
    if (!causeReason) throw cause;
    this.onedrive.invalidateVaultScope(this.vaultName);
    let observedScope: SyncScope | null = null;
    try {
      const observed = await this.onedrive.initVaultScope(
        this.vaultName,
        { createMissing: false },
      );
      observedScope = {
        accountId: committedScope.accountId,
        ...observed,
      };
      if (sameSyncScope(observedScope, committedScope)) {
        // The path lookup still resolves the exact committed identities, so
        // the earlier failure is not sufficient proof of scope loss.
        throw cause;
      }
    } catch (observationError) {
      if (observationError === cause) throw observationError;
      if (!remoteScopeLossReason(observationError)) {
        throw observationError;
      }
      observedScope = null;
    }
    return new V2CommittedScopeUnreachableError(
      observedScope,
      causeReason,
    );
  }

  private async stageV2CommittedScopeRecovery(
    result: SyncResult,
    scopeLoss: V2CommittedScopeUnreachableError,
  ): Promise<void> {
    const recovery = await this.state.stageV2RemoteScopeRecovery({
      observedScope: scopeLoss.observedScope,
    });
    result.deferred = Math.max(1, result.deferred);
    result.message = this.t("result.v2ScopeRecoveryPending");
    this.diag?.warn(
      "state",
      "committed V2 remote scope is unreachable; staged a V2-only recovery hold without creating or mutating a remote scope",
      {
        reason: recovery.reason,
        sourceCommitSeq: recovery.sourceCommitSeq,
        observedScopeAvailable: recovery.observedScope !== null,
        causeReason: scopeLoss.causeReason,
        mutations: 0,
      },
    );
  }

  private async commitPreparedRemoteState(
    entries: RemoteFileEntry[],
    deltaLink: string | null,
    scope: SyncScope,
    folders: RemoteFolderEntry[] = [],
  ): Promise<void> {
    await this.state.setRemoteState(entries, deltaLink, scope, folders);
  }

  /** Use persisted remote state for incremental delta, rebuilding on failure. */
  private async tryDeltaOrFullScan(
    operationEpoch: number,
    result: SyncResult,
    syncScope: SyncScope,
    localEntries: LocalFileEntry[],
    forceCompleteIdentitySnapshot = false,
    persistPreparedState = true,
    preserveReviewedSourceCommitSeq?: number,
  ): Promise<{ entries: RemoteFileEntry[]; scope: SyncScope }> {
    let currentScope = syncScope;
    let { filesRootId } = currentScope;
    if (!forceCompleteIdentitySnapshot
      && this.state.hasRemoteState
      && this.state.remoteDeltaLink) {
      if (!sameSyncScope(this.state.remoteScope, syncScope)) {
        this.diag?.warn(
          "onedrive",
          "remote cache belongs to a different or incomplete sync scope; rebuilding from known Graph identities",
        );
        const entries = await this.rebuildRemoteStateFromIdentitySnapshot(
          operationEpoch,
          result,
          currentScope,
          persistPreparedState,
        );
        return { entries, scope: currentScope };
      }
      if (this.state.hasCompleteRemoteFolderIndex === false) {
        this.diag?.warn(
          "onedrive",
          "remote cache predates the complete folder identity index; rebuilding from known Graph identities",
        );
        const entries = await this.rebuildRemoteStateFromIdentitySnapshot(
          operationEpoch,
          result,
          currentScope,
          persistPreparedState,
        );
        return { entries, scope: currentScope };
      }
      if (this.hasLegacyFilesRootPollution(this.state.remoteSnapshot, localEntries)) {
        this.remoteRecoveryPreviewRequired = true;
        this.diag?.warn(
          "onedrive",
          "remote cache contains the legacy files/ namespace prefix; rebuilding from the known files root",
        );
        const entries = await this.rebuildRemoteStateFromIdentitySnapshot(
          operationEpoch,
          result,
          currentScope,
          persistPreparedState,
        );
        return { entries, scope: currentScope };
      }
      try {
        const delta = await this.onedrive.getDelta(
          this.vaultName,
          this.state.remoteDeltaLink,
        );
        const projection = this.applyRemoteDelta(
          this.state.remoteSnapshot,
          this.state.remoteFolders,
          delta.value,
          filesRootId,
        );
        const entries = projection.entries;
        if (!this.canContinue(operationEpoch, result)) return { entries, scope: currentScope };
        const currentEnvelope = this.state.getCommittedV2Envelope();
        const preserveReviewedCursorOnly = Boolean(
          preserveReviewedSourceCommitSeq !== undefined
          && currentEnvelope
          && currentEnvelope.meta.commitSeq
            === preserveReviewedSourceCommitSeq
          && remoteStateProjectionMatchesEnvelopeV2(
            currentEnvelope,
            {
              entries,
              folders: projection.folders,
              scope: currentScope,
            },
          )
        );
        if (persistPreparedState && !preserveReviewedCursorOnly) {
          await this.commitPreparedRemoteState(
            entries,
            delta["@odata.deltaLink"] ?? null,
            currentScope,
            projection.folders,
          );
        } else if (preserveReviewedCursorOnly) {
          this.diag?.log(
            "state",
            "deferred a projection-identical delta cursor checkpoint until the sealed reviewed plan is resolved",
            {
              sourceCommitSeq: preserveReviewedSourceCommitSeq,
              replayedNotifications: delta.value.length,
              mutations: 0,
            },
          );
        }
        this.diag?.log("onedrive", `incremental delta returned ${delta.value.length} change(s) → ${entries.length} cached remote entries`);
        return { entries, scope: currentScope };
      } catch (e) {
        if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
        if (e instanceof IncrementalRemoteHierarchyError) {
          this.diag?.warn(
            "onedrive",
            `${e.message}; rebuilding a complete remote identity snapshot`,
          );
          const entries = await this.rebuildRemoteStateFromIdentitySnapshot(
            operationEpoch,
            result,
            currentScope,
            persistPreparedState,
          );
          return { entries, scope: currentScope };
        }
        if (!isDeltaStateInvalid(e)) {
          throw e;
        }
        this.diag?.warn("onedrive", `incremental delta failed (${e instanceof Error ? e.message : "unknown"}), rebuilding remote cache`);
        if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
        this.onedrive.invalidateVaultScope(this.vaultName);
        let refreshedRemoteScope: {
          driveId: string;
          vaultFolderId: string;
          filesRootId: string;
        } | null = null;
        if (typeof this.onedrive.restoreVaultScopeByIdentity === "function") {
          try {
            refreshedRemoteScope = await this.onedrive.restoreVaultScopeByIdentity(
              this.vaultName,
              {
                driveId: currentScope.driveId,
                vaultFolderId: currentScope.vaultFolderId,
                filesRootId: currentScope.filesRootId,
              },
            );
          } catch (identityError) {
            if (this.state.isV2StateActive) {
              if (this.state.mutationLedger.length > 0) throw identityError;
              throw await this.resolveV2CommittedScopeLoss(
                currentScope,
                identityError,
              );
            }
            this.diag?.warn(
              "onedrive",
              "committed remote identities are no longer restorable; resolving the live V1 scope",
              identityError instanceof Error ? identityError.message : String(identityError),
            );
          }
        }
        refreshedRemoteScope ??= await this.onedrive.initVaultScope(this.vaultName);
        const refreshedSyncScope: SyncScope = {
          accountId: currentScope.accountId,
          ...refreshedRemoteScope,
        };
        if (
          !sameSyncScope(refreshedSyncScope, currentScope)
          && (
            this.state.mutationLedger.length > 0
            || this.state.isV2StateActive
          )
        ) {
          throw new Error("Committed remote scope changed during protected state recovery");
        }
        currentScope = refreshedSyncScope;
        this.activeSyncScope = currentScope;
        filesRootId = refreshedSyncScope.filesRootId;
      }
    }

    try {
      const delta = await this.onedrive.getDelta(this.vaultName);
      const projection = this.projectCompleteRemoteSnapshot(delta.value, filesRootId);
      const entries = projection.entries;
      if (!this.canContinue(operationEpoch, result)) return { entries, scope: currentScope };
      if (persistPreparedState) {
        await this.commitPreparedRemoteState(
          entries,
          delta["@odata.deltaLink"] ?? null,
          currentScope,
          projection.folders,
        );
      }
      this.diag?.log("onedrive", `delta returned ${delta.value.length} items → ${entries.length} remote entries`);
      return { entries, scope: currentScope };
    } catch (e) {
      if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
      // Delta failed — try full scan
      this.diag?.warn("onedrive", `delta failed (${e instanceof Error ? e.message : 'unknown'}), falling back to full scan`);
      try {
        const items = await this.onedrive.fullScan(this.vaultName);
        const projection = this.projectCompleteRemoteSnapshot(items, filesRootId);
        const entries = projection.entries;
        if (!this.canContinue(operationEpoch, result)) return { entries, scope: currentScope };
        if (persistPreparedState) {
          await this.commitPreparedRemoteState(
            entries,
            null,
            currentScope,
            projection.folders,
          );
        }
        this.diag?.log("onedrive", `full scan returned ${items.length} items → ${entries.length} remote entries`);
        return { entries, scope: currentScope };
      } catch (e2) {
        if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
        // Both delta and full scan failed — if NotFound, the vault folder is empty/new
        if (e2 instanceof OneDriveError && e2.type === OneDriveErrorType.NotFound) {
          if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
          if (persistPreparedState) {
            await this.commitPreparedRemoteState([], null, currentScope);
          }
          return { entries: [], scope: currentScope };
        }
        throw e2;
      }
    }
  }

  /** Rebuild a path-complete V1 snapshot through the validated V2 identity
   * projector. The existing committed snapshot/cursor stays untouched until
   * the complete replacement has passed hierarchy validation. */
  private async rebuildRemoteStateFromIdentitySnapshot(
    operationEpoch: number,
    result: SyncResult,
    syncScope: SyncScope,
    persistPreparedState = true,
  ): Promise<RemoteFileEntry[]> {
    const { filesRootId } = syncScope;
    const delta = await this.onedrive.getDelta(this.vaultName);
    const projection = this.projectCompleteRemoteSnapshot(delta.value, filesRootId);
    const entries = projection.entries;
    if (!this.canContinue(operationEpoch, result)) return entries;
    if (persistPreparedState) {
      await this.commitPreparedRemoteState(
        entries,
        delta["@odata.deltaLink"] ?? null,
        syncScope,
        projection.folders,
      );
    }
    this.diag?.log(
      "onedrive",
      `remote identity rebuild returned ${delta.value.length} item(s) → ${entries.length} cached remote entries`,
    );
    return entries;
  }

  private projectCompleteRemoteSnapshot(
    items: DriveItem[],
    filesRootId: string,
  ): RemoteProjection {
    const latestById = new Map<string, DriveItem>();
    for (const item of items) latestById.set(item.id, item);
    const liveItems = [...latestById.values()].filter(
      (item) => !item.deleted && Boolean(item.file || item.folder),
    );

    const scopedItems = this.selectFilesRootDescendants(liveItems, filesRootId);
    const projection = buildRemoteIndexV2(
      scopedItems,
      filesRootId,
      null,
    );
    const entries: RemoteFileEntry[] = [];
    const folders: RemoteFolderEntry[] = [];
    for (const node of Object.values(projection.index.itemsById)) {
      const item = latestById.get(node.id);
      const path = projection.pathById.get(node.id);
      if (!item || !path) {
        throw new Error(`Remote hierarchy projection incomplete: ${node.id}`);
      }
      if (node.kind === "folder") {
        folders.push({
          path,
          driveId: node.id,
          parentId: node.parentId,
          name: item.name,
          ...(item.eTag !== undefined ? { eTag: item.eTag } : {}),
        });
        continue;
      }
      if (!this.shouldIncludeRemotePath(path)) continue;
      entries.push(this.toRemoteEntry(item, path, node.parentId));
    }
    this.completeRemoteItems = [...scopedItems];
    return { entries, folders };
  }

  private async commitMutationCheckpoint(operationId: string): Promise<void> {
    await this.state.commitMutationCheckpoint(operationId);
  }

  private selectFilesRootDescendants(
    liveItems: DriveItem[],
    filesRootId: string,
  ): DriveItem[] {
    const childrenByParent = new Map<string, DriveItem[]>();
    for (const item of liveItems) {
      const parentId = item.parentReference?.id;
      if (!parentId) throw new Error(`Remote identity incomplete: ${item.id}`);
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(item);
      childrenByParent.set(parentId, siblings);
    }

    const descendants: DriveItem[] = [];
    const descendantIds = new Set<string>();
    const pending = [filesRootId];
    while (pending.length > 0) {
      const parentId = pending.shift()!;
      for (const child of childrenByParent.get(parentId) ?? []) {
        if (child.id === filesRootId || descendantIds.has(child.id)) {
          throw new Error(`Remote hierarchy cycle: ${child.id}`);
        }
        descendantIds.add(child.id);
        descendants.push(child);
        if (child.folder) pending.push(child.id);
      }
    }

    const filesRoot = liveItems.find((item) => item.id === filesRootId);
    const allowedOutside = new Set<string>([filesRootId]);
    if (filesRoot?.parentReference?.id) {
      let ancestorId: string | undefined = filesRoot.parentReference.id;
      while (ancestorId) {
        allowedOutside.add(ancestorId);
        const ancestor = liveItems.find((item) => item.id === ancestorId);
        ancestorId = ancestor?.parentReference?.id;
      }
      const outsidePending = (childrenByParent.get(filesRoot.parentReference.id) ?? [])
        .filter((item) => item.id !== filesRootId);
      while (outsidePending.length > 0) {
        const outside = outsidePending.shift()!;
        if (allowedOutside.has(outside.id)) continue;
        allowedOutside.add(outside.id);
        if (outside.folder) {
          outsidePending.push(...(childrenByParent.get(outside.id) ?? []));
        }
      }
    }

    const unresolved = liveItems.filter(
      (item) => !descendantIds.has(item.id) && !allowedOutside.has(item.id),
    );
    if (unresolved.length > 0) {
      throw new Error(`Remote hierarchy outside known files root: ${unresolved[0].id}`);
    }
    return descendants;
  }

  private hasLegacyFilesRootPollution(
    remoteEntries: RemoteFileEntry[],
    localEntries: LocalFileEntry[],
  ): boolean {
    if (remoteEntries.length === 0
      || !remoteEntries.every((entry) => entry.path.startsWith("files/"))) {
      return false;
    }
    const knownPaths = new Set([
      ...localEntries.map((entry) => entry.path),
      ...this.state.baseSnapshot.map((entry) => entry.path),
    ]);
    return remoteEntries.some((entry) => {
      const unprefixed = entry.path.slice("files/".length);
      return knownPaths.has(unprefixed) && !knownPaths.has(entry.path);
    });
  }

  private summarizePlanActions(plan: SyncPlan): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of plan.items) counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }

  private applyRemoteDelta(
    cachedEntries: RemoteFileEntry[],
    cachedFolders: RemoteFolderEntry[],
    changes: DriveItem[],
    filesRootId: string,
  ): RemoteProjection {
    const syncableCachedEntries = cachedEntries.filter(
      (entry) => this.shouldIncludeRemotePath(entry.path),
    );
    const byPath = new Map(syncableCachedEntries.map((entry) => [entry.path, entry]));
    const byDriveId = new Map(syncableCachedEntries.map((entry) => [entry.driveId, entry]));
    const driveIdByPathKey = new Map<string, string>();
    const folderPathById = new Map<string, string>([[filesRootId, ""]]);
    const folderIdByPathKey = new Map<string, string>([[normalizeRemotePathKey(""), filesRootId]]);
    const foldersById = new Map<string, RemoteFolderEntry>();
    for (const folder of [...cachedFolders].sort(
      (left, right) => left.path.split("/").length - right.path.split("/").length,
    )) {
      const separator = folder.path.lastIndexOf("/");
      const expectedName = separator >= 0
        ? folder.path.slice(separator + 1)
        : folder.path;
      const parentPath = separator >= 0 ? folder.path.slice(0, separator) : "";
      const expectedParentId = folderIdByPathKey.get(normalizeRemotePathKey(parentPath));
      if (
        !folder.path
        || folder.name !== expectedName
        || !expectedParentId
        || folder.parentId !== expectedParentId
      ) {
        throw new IncrementalRemoteHierarchyError(`Remote hierarchy invalid cached folder ${folder.driveId}`);
      }
      const pathKey = normalizeRemotePathKey(folder.path);
      const existingId = folderIdByPathKey.get(pathKey);
      if (existingId && existingId !== folder.driveId) {
        throw new IncrementalRemoteHierarchyError(`Remote hierarchy duplicate cached folder path: ${folder.path}`);
      }
      folderPathById.set(folder.driveId, folder.path);
      folderIdByPathKey.set(pathKey, folder.driveId);
      foldersById.set(folder.driveId, folder);
    }
    for (const entry of syncableCachedEntries) {
      const key = normalizeRemotePathKey(entry.path);
      const owner = driveIdByPathKey.get(key);
      if (owner && owner !== entry.driveId) {
        throw new IncrementalRemoteHierarchyError(`Remote hierarchy duplicate cached path: ${entry.path}`);
      }
      driveIdByPathKey.set(key, entry.driveId);
      if (entry.parentId) {
        const separator = entry.path.lastIndexOf("/");
        const folderPath = separator >= 0 ? entry.path.slice(0, separator) : "";
        const existingPath = folderPathById.get(entry.parentId);
        if (existingPath !== undefined && existingPath !== folderPath) {
          throw new IncrementalRemoteHierarchyError(`Remote hierarchy inconsistent cached parent: ${entry.parentId}`);
        }
        const folderKey = normalizeRemotePathKey(folderPath);
        const existingId = folderIdByPathKey.get(folderKey);
        if (existingId && existingId !== entry.parentId) {
          throw new IncrementalRemoteHierarchyError(`Remote hierarchy duplicate cached folder path: ${folderPath}`);
        }
        folderPathById.set(entry.parentId, folderPath);
        folderIdByPathKey.set(folderKey, entry.parentId);
      }
    }
    for (const [driveId, path] of folderPathById) {
      if (driveId === filesRootId || foldersById.has(driveId) || !path) continue;
      const separator = path.lastIndexOf("/");
      const parentPath = separator >= 0 ? path.slice(0, separator) : "";
      const parentId = folderIdByPathKey.get(normalizeRemotePathKey(parentPath));
      if (!parentId) continue;
      foldersById.set(driveId, {
        path,
        driveId,
        parentId,
        name: separator >= 0 ? path.slice(separator + 1) : path,
      });
    }
    const latestById = new Map<string, DriveItem>();
    for (const change of changes) latestById.set(change.id, change);

    for (const change of latestById.values()) {
      let previous = byDriveId.get(change.id);
      if (change.id === filesRootId) {
        if (change.deleted || !change.folder) {
          throw new IncrementalRemoteHierarchyError("Remote hierarchy changed the known files root");
        }
        // OneDrive emits a folder delta for the scoped root when its direct
        // children change. The root identity anchors every cached path, so a
        // live mutation of that exact known ID carries no path change to apply.
        continue;
      }
      if (change.deleted) {
        if (previous) {
          byPath.delete(previous.path);
          driveIdByPathKey.delete(normalizeRemotePathKey(previous.path));
          byDriveId.delete(change.id);
        } else if (foldersById.has(change.id)) {
          throw new IncrementalRemoteHierarchyError(`Remote hierarchy deleted known folder ${change.id}`);
        }
        continue;
      }
      if (change.folder) {
        const previousFolder = foldersById.get(change.id);
        const parentId = change.parentReference?.id;
        if (!previousFolder || !parentId) {
          throw new IncrementalRemoteHierarchyError(`Remote hierarchy incomplete: folder mutation ${change.id}`);
        }
        if (
          change.name !== previousFolder.name
          || parentId !== previousFolder.parentId
        ) {
          throw new IncrementalRemoteHierarchyError(`Remote hierarchy changed known folder ${change.id}`);
        }
        // Graph reports both direct folder writes and parent metadata changes
        // with the same stable identity/path. Preserve the newer version even
        // when there is no hierarchy change: later folder CAS must not retry a
        // stale eTag forever after a real 412.
        if (change.eTag !== undefined && change.eTag !== previousFolder.eTag) {
          foldersById.set(change.id, {
            ...previousFolder,
            eTag: change.eTag,
          });
        }
        continue;
      }
      if (!change.file) {
        continue;
      }
      const parentId = change.parentReference?.id;
      if (!parentId) {
        throw new IncrementalRemoteHierarchyError(`Remote hierarchy incomplete: missing parent identity for ${change.id}`);
      }

      let projectedPath: string;
      if (previous) {
        if (!previous.parentId) {
          const separator = previous.path.lastIndexOf("/");
          const expectedParentPath = separator >= 0 ? previous.path.slice(0, separator) : "";
          const provenParentPath = folderPathById.get(parentId);
          if (provenParentPath !== expectedParentPath) {
            throw new IncrementalRemoteHierarchyError(`Remote hierarchy incomplete: legacy cached parent for ${change.id}`);
          }
          previous = { ...previous, parentId };
          byPath.set(previous.path, previous);
          byDriveId.set(previous.driveId, previous);
        }
        if (previous.parentId !== parentId) {
          throw new IncrementalRemoteHierarchyError(`Remote hierarchy changed parent for ${change.id}`);
        }
        const separator = previous.path.lastIndexOf("/");
        projectedPath = separator >= 0
          ? `${previous.path.slice(0, separator)}/${change.name}`
          : change.name;
        byPath.delete(previous.path);
        driveIdByPathKey.delete(normalizeRemotePathKey(previous.path));
      } else {
        const parentPath = folderPathById.get(parentId);
        if (parentPath === undefined) {
          throw new IncrementalRemoteHierarchyError(`Remote hierarchy missing known parent for ${change.id}`);
        }
        projectedPath = parentPath ? `${parentPath}/${change.name}` : change.name;
      }

      const collisionKey = normalizeRemotePathKey(projectedPath);
      const collisionOwner = driveIdByPathKey.get(collisionKey);
      if (collisionOwner && collisionOwner !== change.id) {
        throw new IncrementalRemoteHierarchyError(`Remote hierarchy duplicate path: ${projectedPath}`);
      }
      const entry = this.toRemoteEntry(change, projectedPath, parentId);
      if (!this.shouldIncludeRemotePath(entry.path)) {
        byDriveId.delete(change.id);
        continue;
      }
      byPath.set(entry.path, entry);
      byDriveId.set(entry.driveId, entry);
      driveIdByPathKey.set(collisionKey, entry.driveId);
    }

    return {
      entries: [...byPath.values()],
      folders: [...foldersById.values()],
    };
  }

  private shouldIncludeRemotePath(path: string): boolean {
    return typeof this.scanner.shouldSyncPath === "function"
      ? this.scanner.shouldSyncPath(path)
      : !isEasySyncInternalPath(path, getConfigDir(this.scanner.vault));
  }

  /** Convert a Graph item only after an ID/parentId projection has authorized its path. */
  private toRemoteEntry(d: DriveItem, projectedPath: string, parentId: string) {
    return {
      path: projectedPath,
      driveId: d.id,
      parentId,
      downloadUrl: d["@microsoft.graph.downloadUrl"],
      size: d.size ?? 0,
      mtime: d.lastModifiedDateTime
        ? new Date(d.lastModifiedDateTime).getTime()
        : 0,
      eTag: d.eTag ?? "",
      cTag: d.cTag ?? "",
      sha256Hash: d.file?.hashes?.sha256Hash?.toLowerCase(),
      quickXorHash: d.file?.hashes?.quickXorHash,
    };
  }

  private toUploadedRemoteEntry(
    path: string,
    local: LocalFileEntry,
    uploadResult: UploadResult,
    knownParentId?: string,
  ): RemoteFileEntry {
    if (!uploadResult.id || !uploadResult.eTag) {
      throw new Error(`Upload response is missing stable identity/version: ${path}`);
    }
    return {
      path,
      driveId: uploadResult.id,
      parentId: this.requireKnownRemoteParentId(
        path,
        uploadResult.parentReference?.id,
        knownParentId,
      ),
      size: uploadResult.size ?? local.size,
      mtime: uploadResult.lastModifiedDateTime
        ? new Date(uploadResult.lastModifiedDateTime).getTime()
        : Date.now(),
      eTag: uploadResult.eTag,
      cTag: uploadResult.cTag ?? "",
      sha256Hash: local.hash,
      quickXorHash: local.quickXorHash,
    };
  }

  private toMetadataRemoteEntry(
    path: string,
    metadata: NonNullable<Awaited<ReturnType<OneDriveClient["getFileMetadata"]>>>,
    knownParentId?: string,
  ): RemoteFileEntry {
    return {
      path,
      driveId: metadata.driveId,
      parentId: this.requireKnownRemoteParentId(path, metadata.parentId, knownParentId),
      downloadUrl: metadata.downloadUrl,
      size: metadata.size,
      mtime: metadata.mtime,
      eTag: metadata.eTag,
      cTag: metadata.cTag ?? "",
      sha256Hash: metadata.sha256Hash,
      quickXorHash: metadata.quickXorHash,
    };
  }

  private requireKnownRemoteParentId(
    path: string,
    graphParentId?: string,
    reviewedParentId?: string,
  ): string {
    if (graphParentId) return graphParentId;
    if (reviewedParentId) return reviewedParentId;

    const separator = path.lastIndexOf("/");
    const parentPath = separator >= 0 ? path.slice(0, separator) : "";
    if (!parentPath) {
      const filesRootId = this.activeSyncScope?.filesRootId ?? this.state.remoteScope?.filesRootId;
      if (filesRootId) return filesRootId;
    }

    const knownFolder = (this.state.remoteFolders ?? []).find(
      (folder) => normalizeRemotePathKey(folder.path) === normalizeRemotePathKey(parentPath),
    );
    if (knownFolder) return knownFolder.driveId;
    throw new Error(`Remote cache upsert is missing parent identity: ${path}`);
  }

  /**
   * Ensure all parent directories for a file exist, creating them
   * bottom-up to handle non-recursive adapter.mkdir implementations.
   */
  /** M19: compare local vs remote EasySync manifest.json version.
   *  Returns the number of EasySync items to skip (0 = remote >= local, all = downgrade). */
  private async guardEasySyncDowngrade(
    items: SyncPlanItem[],
  ): Promise<number> {
    const { manifestFile } = getEasySyncPaths(this.scanner.vault);
    const manifestItem = items.find((i) => i.path === manifestFile);
    if (!manifestItem?.remote) return 0; // no remote manifest to check

    // Read local version
    let localVersion = "";
    try {
      const localRaw = await this.scanner.vault.adapter.read(manifestFile);
      const localManifest = JSON.parse(localRaw) as { version?: string };
      localVersion = localManifest.version ?? "";
    } catch {
      // No local manifest — first install, allow
      return 0;
    }

    // Fetch remote version from the plan item's remote metadata
    // (manifest.json is small; download inline before the pool starts)
    try {
      const remoteContent = await this.onedrive.downloadFile(
        this.vaultName,
        manifestItem.path,
        manifestItem.remote.downloadUrl,
        manifestItem.remote.driveId,
        manifestItem.remote.size,
      );
      const remoteText = new TextDecoder().decode(remoteContent);
      const remoteManifest = JSON.parse(remoteText) as { version?: string };
      const remoteVersion = remoteManifest.version ?? "";

      if (remoteVersion && localVersion && remoteVersion < localVersion) {
        this.diag?.warn(
          "execute",
          `M19 anti-downgrade — remote EasySync ${remoteVersion} < local ${localVersion}, skipping plugin file sync this round`,
        );
        return items.length; // skip all EasySync files
      }
    } catch (err) {
      // Can't fetch remote manifest — allow the sync to proceed
      // (downgrade guard is best-effort; don't block normal sync)
      this.diag?.log("execute", `M19 anti-downgrade — could not fetch remote manifest, allowing sync: ${err instanceof Error ? err.message : String(err)}`);
    }

    return 0;
  }

  private async ensureParentDirs(filePath: string): Promise<void> {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (!dir) return;

    // Build the chain of directories to create
    const segments = dir.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const partial = segments.slice(0, i).join("/");
      try {
        await this.scanner.vault.adapter.mkdir(partial);
      } catch {
        // Directory might already exist — continue to next segment
      }
    }
  }

  private handleSideActionPreparationFailure(
    path: string,
    phase: SideActionPreparationPhase,
    error: unknown,
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.diag?.warn("execute", `side action preparation failed — phase=${phase}, path=${path}`, reason);
    if (isAuthFailure(error)) {
      this.invalidateLifecycle("auth-expired");
      this.notice("result.authExpired", { path });
      return;
    }
    switch (phase) {
      case "localRecovery":
        this.notice("notice.localRecoveryFailed", { path });
        return;
      case "remotePrepare":
        this.notice("notice.sideActionRemotePrepareFailed", { path });
        return;
      case "scopeValidation":
        this.notice("notice.sideActionScopeChanged", { path });
        return;
      case "mutationRecovery":
        this.notice("notice.sideActionMutationRecoveryFailed", { path });
        return;
      case "action":
        this.notice("notice.conflict.failed", {
          path,
          reason: this.failureReason(error),
        });
    }
  }

  private enqueueSideAction(
    path: string,
    actionType: SyncActionType,
    task: (operationEpoch: number) => Promise<boolean | void>,
    completionPresentation?: Pick<FileProgress, "status" | "reason">,
  ): Promise<void> {
    if (this.state.isV2StateActive === false) {
      this.notice("notice.v2MigrationRequired");
      return Promise.resolve();
    }
    if (this.running) {
      this.notice("notice.conflict.failed", { path, reason: this.t("result.lockBusy") });
      return Promise.resolve();
    }
    if (this.queuedSideActionPaths.has(path)) {
      return Promise.resolve();
    }

    if (!this.sideActionRunning && this.queuedSideActionPaths.size === 0) {
      this.cancelled = false;
      if (this.progressStore?.state.activityKind === "sideAction") {
        this.sideActionBatchTotal = Math.max(
          this.sideActionBatchTotal,
          this.progressStore.state.total,
        );
        this.sideActionBatchSettled = Math.max(
          this.sideActionBatchSettled,
          this.progressStore.state.total,
        );
        this.progressStore.resumeSideActionBatch();
      } else {
        this.sideActionBatchTotal = 0;
        this.sideActionBatchSettled = 0;
        this.progressStore?.markStarted("sideAction");
        this.progressStore?.setPhase("executing");
      }
    }
    const operationEpoch = this.lifecycle.capture();

    this.queuedSideActionPaths.add(path);
    this.sideActionBatchTotal++;
    const currentProgress = this.progressStore?.state;
    if (currentProgress?.currentFile) {
      this.progressStore?.setProgress(
        currentProgress.current,
        this.sideActionBatchTotal,
        currentProgress.currentFile,
        currentProgress.currentActionType,
      );
    }
    this.diag?.log("execute", `queued side action ${actionType} ${path}`);
    this.onProgressUpdate?.();

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    // ponytail: one shared side-action queue keeps conflict/delete picks serial; split by lane only if real throughput needs appear
    this.sideActionQueue = this.sideActionQueue
      .catch(() => undefined)
      .then(async () => {
        let started = false;
        let succeeded = false;
        let preparationPhase: SideActionPreparationPhase = "localRecovery";
        try {
          if (!this.canContinue(operationEpoch)) return;
          this.beginSideAction(path, actionType);
          started = true;
          await this.getRecoveryJournal().recover();
          if (!this.canContinue(operationEpoch)) return;
          preparationPhase = "remotePrepare";
          const remoteScope = await this.onedrive.initVaultScope(this.vaultName);
          this.activeSyncScope = {
            accountId: this.state.boundAccountId,
            ...remoteScope,
          };
          preparationPhase = "scopeValidation";
          if (this.state.remoteScope && !sameSyncScope(this.state.remoteScope, this.activeSyncScope)) {
            throw new Error("Reviewed action scope no longer matches the current Graph scope");
          }
          preparationPhase = "mutationRecovery";
          await this.recoverMutationLedger(this.activeSyncScope);
          if (!this.canContinue(operationEpoch)) return;
          preparationPhase = "action";
          succeeded = await task(operationEpoch) === true;
        } catch (error) {
          this.handleSideActionPreparationFailure(path, preparationPhase, error);
        } finally {
          if (started) this.completeSideAction(
            path,
            actionType,
            succeeded,
            completionPresentation,
          );
          this.queuedSideActionPaths.delete(path);
          this.activeSyncScope = null;
          this.finishSideAction(this.queuedSideActionPaths.size === 0);
          resolveCompletion();
        }
      });

    return completion;
  }

  private beginSideAction(path: string, actionType: SyncActionType): void {
    this.sideActionRunning = true;
    this.progressStore?.setProgress(
      this.sideActionBatchSettled + 1,
      this.sideActionBatchTotal,
      path,
      actionType,
    );
    this.onProgressUpdate?.();
  }

  private updateSideActionProgress(bytes: number, total: number): void {
    this.progressStore?.setByteProgress(bytes, total);
    this.onProgressUpdate?.();
  }

  private completeSideAction(
    path: string,
    actionType: SyncActionType,
    succeeded: boolean,
    completion?: Pick<FileProgress, "status" | "reason">,
  ): void {
    this.progressStore?.completeCurrentItem();
    this.progressStore?.addCompletedFile({
      path,
      status: succeeded && completion?.status
        ? completion.status
        : succeeded
        ? actionType === SyncActionType.ConfirmLocalDelete
          ? "delete"
          : SyncProgressStore.actionToStatus(actionType)
        : "error",
      actionType,
      reason: succeeded ? completion?.reason : undefined,
    });
    this.sideActionBatchSettled++;
    this.onProgressUpdate?.();
  }

  /** Retire a false conflict from exact bytes already inspected by the detail view. */
  async reconcileIdenticalConflict(
    path: string,
    proof: ReviewedContentEqualityProof,
  ): Promise<void> {
    if (this.stopSideActionForStateRecovery()) return;
    const conflict = this.state.pendingConflicts.find((item) => item.path === path);
    if (!conflict?.local || !conflict.remote) {
      this.notice("notice.conflict.failed", { path, reason: this.t("notice.decisionExpired") });
      return;
    }
    if (
      proof.localHash !== proof.remoteHash
      || proof.localSize !== proof.remoteSize
      || proof.remoteETag !== conflict.remote.eTag
    ) {
      this.notice("notice.conflict.failed", { path, reason: this.t("notice.decisionExpired") });
      return;
    }

    return this.enqueueSideAction(
      path,
      SyncActionType.Conflict,
      async (operationEpoch) => {
        const queued = this.state.pendingConflicts.find((item) => item.path === path);
        if (!queued?.local || !queued.remote) return;
        if (!this.guardDecisionToken(queued, "notice.conflict.failed")) return;
        const expectedLocal: LocalFileEntry = {
          ...queued.local,
          hash: proof.localHash,
          size: proof.localSize,
        };
        if (!await this.guardReviewedLocalVersion(path, expectedLocal, "notice.conflict.failed")) return;
        if (!await this.guardReviewedRemoteVersion(queued, "notice.conflict.failed", "conflict")) return;
        if (!this.canContinue(operationEpoch)) return;
        await this.stageVerifiedLocalAncestorContent([{
          path,
          hash: proof.localHash,
          size: proof.localSize,
          eTag: queued.remote.eTag,
        }]);
        await this.state.reconcileIdenticalConflict({
          path,
          hash: proof.localHash,
          size: proof.localSize,
          eTag: queued.remote.eTag,
        });
        this.diag?.log("execute", `exact-content conflict reconciled — ${path}`);
        this.notice("notice.conflict.identical", { path });
        return true;
      },
      { status: "skip", reason: this.t("notice.conflict.identical", { path }) },
    );
  }

  private finishSideAction(batchFinished: boolean): void {
    this.sideActionRunning = false;
    if (batchFinished) this.progressStore?.finish();
    this.onProgressUpdate?.();
  }

  private async deleteLocalPath(path: string): Promise<void> {
    const tfile = this.scanner.vault.getFileByPath(path);
    if (tfile) {
      if (this.fileManager) {
        // A failed trash operation must remain a failure. Falling back to a
        // permanent delete would silently defeat the user's recovery path.
        await this.fileManager.trashFile(tfile);
      } else {
        await this.scanner.vault.adapter.remove(path);
      }
      return;
    }
    await this.scanner.vault.adapter.remove(path);
  }

  private async expireManagedConfigDecision(
    path: string,
    conflict: SyncPlanItem | undefined,
  ): Promise<boolean> {
    if (!isObsidianManagedConfigPath(path)) return false;
    // Older builds persisted one-sided managed-config conflicts whose buttons
    // meant delete. Retire those decisions and let the next plan use the
    // current non-destructive restore/create policy.
    if (conflict && (!conflict.local || !conflict.remote)) {
      await this.state.removePendingConflict(path);
      this.notice("notice.conflict.failed", {
        path,
        reason: this.t("notice.decisionExpired"),
      });
      return true;
    }
    return false;
  }

  private async expireOutOfScopeConflictDecision(
    path: string,
  ): Promise<boolean> {
    if (this.shouldIncludeRemotePath(path)) return false;
    await this.state.removePendingConflict(path);
    this.notice("notice.configSyncDisabled", { path });
    return true;
  }

  private async expireEasySyncSelfDeletionDecision(
    path: string,
    conflict: SyncPlanItem | undefined,
  ): Promise<boolean> {
    if (
      !conflict?.local
      || conflict.remote
      || !isEasySyncSelfSyncFilePath(
        path,
        getConfigDir(this.scanner.vault),
      )
    ) return false;
    await this.state.removePendingConflict(path);
    this.notice("notice.conflict.failed", {
      path,
      reason: this.t("notice.decisionExpired"),
    });
    return true;
  }

  private async expireOutOfScopeDeleteDecision(
    path: string,
    folder: boolean,
  ): Promise<boolean> {
    const inScope = folder
      ? this.scanner.shouldSyncFolderPath(path)
      : this.shouldIncludeRemotePath(path);
    if (inScope) return false;
    await this.state.removePendingDelete(path);
    this.notice("notice.configSyncDisabled", { path });
    return true;
  }

  private async expireCommunityPluginDeletionDecision(
    path: string,
    conflict: SyncPlanItem | undefined,
  ): Promise<boolean> {
    if (
      !conflict
      || (conflict.local && conflict.remote)
      || !classifyCommunityPluginManagedPath(
        path,
        getConfigDir(this.scanner.vault),
      )
    ) return false;
    await this.state.removePendingConflict(path);
    this.notice("notice.communityPlugins.globalDeleteUnavailable");
    return true;
  }

  private async readManagedConfigSnapshot(
    path: string,
    content: ArrayBuffer,
  ): Promise<LocalFileEntry | null> {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      JSON.parse(text);
    } catch {
      this.notice("notice.conflict.failed", {
        path,
        reason: this.t("notice.configSnapshotInvalid"),
      });
      return null;
    }
    const stat = await this.scanner.vault.adapter.stat(path);
    return {
      path,
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: stat?.mtime ?? Date.now(),
      binary: false,
    };
  }

  private async replaceManagedConfigWithRemote(
    queuedConflict: SyncPlanItem,
    operationEpoch: number,
  ): Promise<ArrayBuffer | null> {
    const path = queuedConflict.path;
    const content = await this.onedrive.downloadFile(
      this.vaultName,
      path,
      queuedConflict.remote!.downloadUrl,
      queuedConflict.remote!.driveId,
      queuedConflict.remote!.size,
      (downloaded, total) => this.updateSideActionProgress(downloaded, total),
    );
    if (!this.canContinue(operationEpoch)) return null;
    if (!await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")) {
      return null;
    }
    const hash = await sha256Hex(content);
    await this.verifyDownloadedPayload(
      path,
      queuedConflict.remote!,
      { size: content.byteLength, hash },
      true,
    );
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
    } catch {
      this.notice("notice.conflict.failed", {
        path,
        reason: this.t("notice.configSnapshotInvalid"),
      });
      return null;
    }

    const current = await this.inspectLocalPath(path);
    if (current?.status === "uncertain") {
      this.notice("notice.conflict.failed", {
        path,
        reason: this.t("notice.localChangedSinceReview"),
      });
      return null;
    }
    const expected = current?.status === "present"
      ? current.entry
      : current?.status === "missing"
        ? undefined
        : queuedConflict.local;
    const expectedLocal: SyncDecisionToken["local"] = expected
      ? { exists: true, hash: expected.hash, size: expected.size }
      : { exists: false };
    const intent = this.createSideMutationIntent(queuedConflict, "download", expectedLocal);
    const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
      let targetMutationStarted = false;
      try {
        const readyPath = `${this.getDownloadTempPath(path)}.ready`;
        await this.ensureParentDirs(readyPath);
        await this.removePathIfExists(readyPath);
        await this.writeBinaryTempFileWithAndroidZeroByteRetry(
          path,
          readyPath,
          content,
        );
        targetMutationStarted = true;
        await this.commitDownloadedTempFile(
          this.scanner.vault.adapter as StreamDownloadAdapter,
          path,
          readyPath,
          expected,
          { size: content.byteLength, hash },
        );
        const stat = await this.scanner.vault.adapter.stat(path);
        const checkpoint = emptyMutationCheckpoint();
        checkpoint.baseUpserts.push({
          path,
          hash,
          size: stat?.size ?? content.byteLength,
          eTag: queuedConflict.remote!.eTag,
        });
        this.state.cacheBaseContent(path, content);
        checkpoint.pendingConflictRemovals.push(path);
        return checkpoint;
      } catch (error) {
        if (error instanceof LocalCommitPreconditionError) {
          this.notice("notice.conflict.failed", {
            path,
            reason: this.t("notice.localChangedSinceReview"),
          });
          throw new MutationNotAppliedError(error, true);
        }
        if (error instanceof MutationNotAppliedError || targetMutationStarted) throw error;
        throw new MutationNotAppliedError(error);
      }
    });
    return committed ? content : null;
  }

  /** Resolve a conflict: keep local version (re-upload) */
  async resolveConflictKeepLocal(path: string): Promise<void> {
    if (this.stopSideActionForStateRecovery()) return;
    const conflict = this.state.pendingConflicts.find((c) => c.path === path);
    if (await this.expireOutOfScopeConflictDecision(path)) return;
    if (await this.expireCommunityPluginDeletionDecision(path, conflict)) {
      return;
    }
    if (await this.expireManagedConfigDecision(path, conflict)) return;
    const actionType = conflict?.remote && !conflict.local
      ? SyncActionType.DeleteRemote
      : SyncActionType.Upload;
    return this.enqueueSideAction(path, actionType, async (operationEpoch) => {
      if (!this.canContinue(operationEpoch)) return;
      if (await this.expireOutOfScopeConflictDecision(path)) return;
      const queuedConflict = this.state.pendingConflicts.find((c) => c.path === path);
      if (queuedConflict?.remote && !queuedConflict.local) {
        try {
          if (!this.guardDecisionToken(queuedConflict, "notice.conflict.failed")) return;
          if (!await this.guardReviewedLocalVersion(path, undefined, "notice.conflict.failed")) return;
          if (!await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")) return;
          if (!this.canContinue(operationEpoch)) return;
          const intent = this.createSideMutationIntent(queuedConflict, "deleteRemote");
          const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
            await this.onedrive.deleteItem(
              this.vaultName,
              path,
              queuedConflict.remote!.eTag,
              queuedConflict.remote!.driveId,
            );
            const checkpoint = emptyMutationCheckpoint();
            checkpoint.baseRemovals.push(path);
            checkpoint.remoteDeletes.push(path);
            checkpoint.pendingConflictRemovals.push(path);
            return checkpoint;
          });
          if (!committed) return;
          this.notice("notice.conflict.keptLocal", { path });
          return true;
        } catch (e) {
          if (e instanceof OneDriveError && isRemoteMutationConflict(e)) {
            await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict");
            return;
          }
          this.notice("notice.conflict.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
        }
        return;
      }
      if (!queuedConflict?.local) {
        this.notice("notice.conflict.failed", { path, reason: this.t("general.unknown") });
        return;
      }
      try {
        const managedConfig = isObsidianManagedConfigPath(path);
        if (!this.guardDecisionToken(queuedConflict, "notice.conflict.failed")) return;
        if (!managedConfig
          && !await this.guardReviewedLocalVersion(path, queuedConflict.local, "notice.conflict.failed")) return;
        if (!await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")) return;
        const content = await this.scanner.vault.adapter.readBinary(path);
        const uploadLocal = managedConfig
          ? await this.readManagedConfigSnapshot(path, content)
          : queuedConflict.local;
        if (!uploadLocal) return;
        const hasProductionInspection = typeof (this.scanner as LocalScanner & { inspectFile?: unknown }).inspectFile === "function";
        if (!managedConfig
          && ((hasProductionInspection && await sha256Hex(content) !== uploadLocal.hash)
            || content.byteLength !== uploadLocal.size)) {
          this.notice("notice.conflict.failed", { path, reason: this.t("notice.localChangedSinceReview") });
          return;
        }
        if (!this.canContinue(operationEpoch)) return;
        const expectedLocal = managedConfig
          ? { exists: true as const, hash: uploadLocal.hash, size: uploadLocal.size }
          : undefined;
        const intent = this.createSideMutationIntent(queuedConflict, "upload", expectedLocal);
        const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
          const uploadResult = await this.onedrive.uploadFile(
            this.vaultName,
            path,
            content,
            (uploaded, total) => this.updateSideActionProgress(uploaded, total),
            queuedConflict.remote?.eTag,
            queuedConflict.remote?.driveId,
          );
          const checkpoint = emptyMutationCheckpoint();
          checkpoint.baseUpserts.push({
            path,
            hash: uploadLocal.hash,
            size: uploadLocal.size,
            eTag: uploadResult.eTag ?? "",
          });
          this.state.cacheBaseContent(path, content);
          checkpoint.remoteUpserts.push(this.toUploadedRemoteEntry(
            path,
            uploadLocal,
            uploadResult,
            queuedConflict.remote?.parentId,
          ));
          checkpoint.pendingConflictRemovals.push(path);
          return checkpoint;
        });
        if (!committed) return;
        this.notice("notice.conflict.keptLocal", { path });
        return true;
      } catch (e) {
        if (this.stopSideActionForAuthFailure(path, e)) return;
        if (e instanceof OneDriveError && isRemoteMutationConflict(e)) {
          await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict");
          return;
        }
        this.notice("notice.conflict.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
      }
    });
  }

  /** Resolve a conflict: keep remote version (re-download) */
  async resolveConflictKeepRemote(path: string): Promise<void> {
    if (this.stopSideActionForStateRecovery()) return;
    const conflict = this.state.pendingConflicts.find((c) => c.path === path);
    if (await this.expireOutOfScopeConflictDecision(path)) return;
    if (await this.expireEasySyncSelfDeletionDecision(path, conflict)) return;
    if (await this.expireCommunityPluginDeletionDecision(path, conflict)) {
      return;
    }
    if (await this.expireManagedConfigDecision(path, conflict)) return;
    const actionType = conflict?.local && !conflict.remote
      ? SyncActionType.ConfirmLocalDelete
      : SyncActionType.Download;
    return this.enqueueSideAction(path, actionType, async (operationEpoch) => {
      if (!this.canContinue(operationEpoch)) return;
      if (await this.expireOutOfScopeConflictDecision(path)) return;
      const queuedConflict = this.state.pendingConflicts.find((c) => c.path === path);
      if (await this.expireEasySyncSelfDeletionDecision(path, queuedConflict)) {
        return;
      }
      if (queuedConflict?.local && !queuedConflict.remote) {
        try {
          if (!this.guardDecisionToken(queuedConflict, "notice.conflict.failed")) return;
          if (!await this.guardReviewedLocalVersion(path, queuedConflict.local, "notice.conflict.failed")) return;
          if (!await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")) return;
          if (!this.canContinue(operationEpoch)) return;
          const intent = this.createSideMutationIntent(queuedConflict, "deleteLocal");
          const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
            await this.deleteLocalPath(path);
            const checkpoint = emptyMutationCheckpoint();
            checkpoint.baseRemovals.push(path);
            checkpoint.remoteDeletes.push(path);
            checkpoint.pendingConflictRemovals.push(path);
            return checkpoint;
          });
          if (!committed) return;
          this.notice("notice.conflict.keptRemote", { path });
          return true;
        } catch (e) {
          if (this.stopSideActionForAuthFailure(path, e)) return;
          this.notice("notice.conflict.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
        }
        return;
      }
      if (!queuedConflict?.remote) {
        this.notice("notice.conflict.failed", { path, reason: this.t("general.unknown") });
        return;
      }
      try {
        const managedConfig = isObsidianManagedConfigPath(path);
        if (!this.guardDecisionToken(queuedConflict, "notice.conflict.failed")) return;
        if (!managedConfig
          && !await this.guardReviewedLocalVersion(path, queuedConflict.local, "notice.conflict.failed")) return;
        if (!await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")) return;
        if (managedConfig) {
          const content = await this.replaceManagedConfigWithRemote(queuedConflict, operationEpoch);
          if (!content) return;
          this.notice("notice.conflict.keptRemote", { path });
          return true;
        }
        const intent = this.createSideMutationIntent(queuedConflict, "download");
        let content: ArrayBuffer | null = null;
        const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
          let targetMutationStarted = false;
          try {
            content = await this.onedrive.downloadFile(
              this.vaultName,
              path,
              queuedConflict.remote!.downloadUrl,
              queuedConflict.remote!.driveId,
              queuedConflict.remote!.size,
              (downloaded, total) => this.updateSideActionProgress(downloaded, total),
            );
            if (!this.canContinue(operationEpoch)) {
              throw new MutationNotAppliedError(
                new Error("Reviewed download cancelled before local commit"),
              );
            }
            if (!await this.guardReviewedLocalVersion(path, queuedConflict.local, "notice.conflict.failed")) {
              throw new MutationNotAppliedError(undefined, true);
            }
            if (!await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")) {
              throw new MutationNotAppliedError(undefined, true);
            }
            const hash = await sha256Hex(content);
            await this.verifyDownloadedPayload(
              path,
              queuedConflict.remote!,
              { size: content.byteLength, hash },
              true,
            );
            if (typeof (this.scanner as LocalScanner & { inspectFile?: unknown }).inspectFile === "function") {
              const readyPath = `${this.getDownloadTempPath(path)}.ready`;
              await this.ensureParentDirs(readyPath);
              await this.removePathIfExists(readyPath);
              await this.writeBinaryTempFileWithAndroidZeroByteRetry(
                path,
                readyPath,
                content,
              );
              targetMutationStarted = true;
              await this.commitDownloadedTempFile(
                this.scanner.vault.adapter as StreamDownloadAdapter,
                path,
                readyPath,
                queuedConflict.local,
                { size: content.byteLength, hash },
              );
            } else {
              await this.ensureParentDirs(path);
              targetMutationStarted = true;
              await this.scanner.vault.adapter.writeBinary(path, content);
            }
            const stat = await this.scanner.vault.adapter.stat(path);
            const checkpoint = emptyMutationCheckpoint();
            checkpoint.baseUpserts.push({
              path,
              hash,
              size: stat?.size ?? content.byteLength,
              eTag: queuedConflict.remote!.eTag,
            });
            this.state.cacheBaseContent(path, content);
            checkpoint.pendingConflictRemovals.push(path);
            return checkpoint;
          } catch (error) {
            if (error instanceof MutationNotAppliedError || targetMutationStarted) throw error;
            throw new MutationNotAppliedError(error);
          }
        });
        if (!committed || !content) return;
        this.notice("notice.conflict.keptRemote", { path });
        return true;
      } catch (rawError) {
        if (rawError instanceof MutationNotAppliedError && rawError.noticeAlreadyShown) return;
        const error = rawError instanceof MutationNotAppliedError
          ? rawError.original
          : rawError;
        if (this.stopSideActionForAuthFailure(path, error)) return;
        if (error instanceof OneDriveError && isRemoteMutationConflict(error)) {
          await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict");
          return;
        }
        if (
          error instanceof OneDriveError
          && (error.type === OneDriveErrorType.NetworkError
            || error.type === OneDriveErrorType.Unauthorized
            || error.type === OneDriveErrorType.Forbidden)
        ) {
          this.notice("notice.conflict.downloadFailed", { path });
          return;
        }
        this.notice("notice.conflict.failed", {
          path,
          reason: this.failureReason(error),
        });
      }
    });
  }

  /** Confirm the exact pending delete paths from one user action. */
  async confirmRemoteDeletes(paths: readonly string[]): Promise<void> {
    const pendingByPath = new Map(
      this.state.pendingRemoteDeletes.map((item) => [item.path, item]),
    );
    const uniquePaths = [...new Set(paths)].sort((leftPath, rightPath) => {
      const leftIsFolder = Boolean(pendingByPath.get(leftPath)?.folder);
      const rightIsFolder = Boolean(pendingByPath.get(rightPath)?.folder);
      if (leftIsFolder !== rightIsFolder) return leftIsFolder ? 1 : -1;
      if (leftIsFolder && rightIsFolder) {
        return folderPathDepth(rightPath) - folderPathDepth(leftPath)
          || leftPath.localeCompare(rightPath);
      }
      return leftPath.localeCompare(rightPath);
    });
    await Promise.all(uniquePaths.map((path) => this.confirmRemoteDelete(path, false)));
  }

  /** Confirm a remote delete: delete local file */
  async confirmRemoteDelete(path: string, showSuccessNotice = true): Promise<void> {
    if (this.stopSideActionForStateRecovery()) return;
    const initialPending = this.state.pendingRemoteDeletes.find((item) => item.path === path);
    if (await this.expireOutOfScopeDeleteDecision(
      path,
      Boolean(initialPending?.folder),
    )) return;
    if (isEasySyncSelfSyncFilePath(path, getConfigDir(this.scanner.vault))) {
      await this.state.removePendingDelete(path);
      this.notice("notice.delete.failed", {
        path,
        reason: this.t("notice.decisionExpired"),
      });
      return;
    }
    if (
      classifyCommunityPluginManagedPath(
        path,
        getConfigDir(this.scanner.vault),
      )?.kind !== undefined
    ) {
      await this.state.removePendingDelete(path);
      this.notice("notice.communityPlugins.globalDeleteUnavailable");
      return;
    }
    const actionType = initialPending?.folder
      ? SyncActionType.DeleteLocalFolder
      : SyncActionType.DeleteRemote;
    return this.enqueueSideAction(path, actionType, async (operationEpoch) => {
      const pending = this.state.pendingRemoteDeletes.find((d) => d.path === path);
      if (await this.expireOutOfScopeDeleteDecision(
        path,
        Boolean(pending?.folder),
      )) return;
      try {
        if (pending?.folder?.remoteId) {
          const envelope = this.state.getCommittedV2Envelope();
          const syncScope = this.activeSyncScope ?? this.state.remoteScope;
          const anchor = Object.values(envelope?.folderAnchors?.byAnchorId ?? {}).find(
            (candidate) => candidate.remoteId === pending.folder!.remoteId
              && candidate.lastPath === path,
          );
          if (!envelope || !syncScope || !anchor || !sameSyncScope(envelope.scope, syncScope)) {
            this.notice("notice.delete.failed", {
              path,
              reason: this.t("notice.decisionExpired"),
            });
            return;
          }
          const intent: FolderMutationIntentV2 = {
            version: 2,
            operationId: `${Date.now()}-${++this.mutationSequence}-deleteLocalFolder`,
            planRevision: this.state.planReviewRevision,
            scope: { ...syncScope },
            action: "deleteLocalFolder",
            path,
            folderId: anchor.remoteId,
            expectedLocal: { exists: true },
            expectedRemote: { exists: false },
            expectedParent: {
              driveId: anchor.parentRemoteId,
              path: parentFolderPath(path),
            },
            createdAt: Date.now(),
          };
          const committed = await this.runDurableSideMutation(
            intent,
            operationEpoch,
            async () => {
              const [remoteById, remoteByPath, local] = await Promise.all([
                this.onedrive.getDriveItemMetadataById(anchor.remoteId),
                this.inspectRemoteFolder(path),
                this.inspectLocalFolder(path),
              ]);
              if (
                remoteById
                || remoteByPath.status !== "missing"
                || local.status !== "present"
              ) {
                throw new MutationNotAppliedError(this.t("notice.decisionExpired"));
              }
              await this.deleteEmptyLocalFolder(path);
              const checkpoint = folderDeleteCheckpoint(path, anchor.remoteId);
              checkpoint.pendingDeleteRemovals.push(path);
              return checkpoint;
            },
          );
          if (!committed) return;
          if (showSuccessNotice) this.notice("notice.delete.confirmed", { path });
          return true;
        }
        if (!pending?.local) {
          this.notice("notice.delete.failed", { path, reason: this.t("general.unknown") });
          return;
        }
        if (!this.guardDecisionToken(pending, "notice.delete.failed")) return;
        if (!await this.guardReviewedLocalVersion(path, pending.local, "notice.delete.failed")) return;
        if (!await this.guardReviewedRemoteVersion(pending, "notice.delete.failed", "delete")) return;
        if (!this.canContinue(operationEpoch)) return;
        const intent = this.createSideMutationIntent(pending, "deleteLocal");
        const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
          await this.deleteLocalPath(path);
          const checkpoint = emptyMutationCheckpoint();
          checkpoint.baseRemovals.push(path);
          checkpoint.pendingDeleteRemovals.push(path);
          return checkpoint;
        });
        if (!committed) return;
        if (showSuccessNotice) this.notice("notice.delete.confirmed", { path });
        return true;
      } catch (e) {
        if (this.stopSideActionForAuthFailure(path, e)) return;
        if (pending && e instanceof OneDriveError && isRemoteMutationConflict(e)) {
          await this.guardReviewedRemoteVersion(pending, "notice.delete.failed", "delete");
          return;
        }
        this.notice("notice.delete.failed", { path, reason: this.failureReason(e) });
      }
    });
  }

  /** Reject a remote delete: re-upload local file */
  async rejectRemoteDelete(path: string): Promise<void> {
    if (this.stopSideActionForStateRecovery()) return;
    const initialPending = this.state.pendingRemoteDeletes.find((item) => item.path === path);
    const actionType = initialPending?.folder
      ? SyncActionType.CreateRemoteFolder
      : SyncActionType.Upload;
    return this.enqueueSideAction(path, actionType, async (operationEpoch) => {
      if (!this.canContinue(operationEpoch)) return;
      const pending = this.state.pendingRemoteDeletes.find((d) => d.path === path);
      if (pending?.folder?.remoteId) {
        try {
          const envelope = this.state.getCommittedV2Envelope();
          const syncScope = this.activeSyncScope ?? this.state.remoteScope;
          const anchor = Object.values(envelope?.folderAnchors?.byAnchorId ?? {}).find(
            (candidate) => candidate.remoteId === pending.folder!.remoteId
              && candidate.lastPath === path,
          );
          if (!envelope || !syncScope || !anchor || !sameSyncScope(envelope.scope, syncScope)) {
            this.notice("notice.delete.failed", {
              path,
              reason: this.t("notice.decisionExpired"),
            });
            return;
          }
          const parent = this.resolveCurrentFolderParent({
            ...pending.folder,
            parentRemoteId: anchor.parentRemoteId,
            parentPath: parentFolderPath(path),
          });
          const intent: FolderMutationIntentV2 = {
            version: 2,
            operationId: `${Date.now()}-${++this.mutationSequence}-createRemoteFolder`,
            planRevision: this.state.planReviewRevision,
            scope: { ...syncScope },
            action: "createRemoteFolder",
            path,
            expectedLocal: { exists: true },
            expectedRemote: { exists: false },
            expectedParent: {
              driveId: parent.driveId,
              path: parentFolderPath(path),
              eTag: parent.eTag,
            },
            createdAt: Date.now(),
          };
          const committed = await this.runDurableSideMutation(
            intent,
            operationEpoch,
            async () => {
              const [local, remote] = await Promise.all([
                this.inspectLocalFolder(path),
                this.inspectRemoteFolder(path),
              ]);
              if (local.status !== "present" || remote.status !== "missing") {
                throw new MutationNotAppliedError(this.t("notice.decisionExpired"));
              }
              const folder = await this.createRemoteFolderWithReadback(
                path,
                parent.driveId,
              );
              if (folder.parentId !== parent.driveId) {
                throw new Error(`Remote folder recreate parent changed: ${path}`);
              }
              const checkpoint = folderMutationCheckpoint(folder);
              checkpoint.pendingDeleteRemovals.push(path);
              return checkpoint;
            },
          );
          if (!committed) return;
          this.notice("notice.delete.rejected", { path });
          return true;
        } catch (e) {
          if (this.stopSideActionForAuthFailure(path, e)) return;
          this.notice("notice.delete.failed", {
            path,
            reason: this.failureReason(e),
          });
        }
        return;
      }
      if (!pending?.local) {
        this.notice("notice.delete.failed", { path, reason: this.t("general.unknown") });
        return;
      }
      try {
        if (!this.guardDecisionToken(pending, "notice.delete.failed")) return;
        if (!await this.guardReviewedLocalVersion(path, pending.local, "notice.delete.failed")) return;
        if (!await this.guardReviewedRemoteVersion(pending, "notice.delete.failed", "delete")) return;
        const content = await this.scanner.vault.adapter.readBinary(path);
        const contentHash = typeof (this.scanner as LocalScanner & { inspectFile?: unknown }).inspectFile === "function"
          ? await sha256Hex(content)
          : pending.local.hash;
        if (contentHash !== pending.local.hash || content.byteLength !== pending.local.size) {
          this.notice("notice.delete.failed", { path, reason: this.t("notice.localChangedSinceReview") });
          return;
        }
        if (!this.canContinue(operationEpoch)) return;
        const intent = this.createSideMutationIntent(pending, "upload");
        const committed = await this.runDurableSideMutation(intent, operationEpoch, async () => {
          const uploadResult = await this.onedrive.uploadFile(
            this.vaultName,
            path,
            content,
            (uploaded, total) => this.updateSideActionProgress(uploaded, total),
          );
          const checkpoint = emptyMutationCheckpoint();
          checkpoint.baseUpserts.push({
            path, hash: pending.local!.hash, size: pending.local!.size, eTag: uploadResult.eTag ?? "",
          });
          this.state.cacheBaseContent(path, content);
          checkpoint.remoteUpserts.push(this.toUploadedRemoteEntry(
            path,
            pending.local!,
            uploadResult,
            pending.remote?.parentId,
          ));
          checkpoint.pendingDeleteRemovals.push(path);
          return checkpoint;
        });
        if (!committed) return;
        this.notice("notice.delete.rejected", { path });
        return true;
      } catch (e) {
        if (this.stopSideActionForAuthFailure(path, e)) return;
        if (e instanceof OneDriveError && isRemoteMutationConflict(e)) {
          await this.guardReviewedRemoteVersion(pending, "notice.delete.failed", "delete");
          return;
        }
        this.notice("notice.delete.failed", { path, reason: this.failureReason(e) });
      }
    });
  }
}

/**
 * Size shown for an action and counted as its logical transfer payload.
 * A download replaces the local version, so its authoritative size is the
 * reviewed remote version rather than the file that is about to be replaced.
 */
function fileSizeForAction(
  item: SyncPlanItem,
  actionType: SyncActionType,
): number | undefined {
  if (
    actionType === SyncActionType.Download
    || actionType === SyncActionType.DeleteRemote
  ) {
    return item.remote?.size ?? item.local?.size;
  }
  return item.local?.size ?? item.remote?.size;
}

function isPendingIssueAction(type: SyncActionType): boolean {
  return type === SyncActionType.Upload
    || type === SyncActionType.Download
    || type === SyncActionType.CreateRemoteFolder
    || type === SyncActionType.CreateLocalFolder
    || type === SyncActionType.MoveRemoteFolder
    || type === SyncActionType.MoveLocalFolder
    || type === SyncActionType.DeleteRemoteFolder
    || type === SyncActionType.DeleteLocalFolder
    || type === SyncActionType.MoveLocalFile
    || type === SyncActionType.FolderDeferred
    || type === SyncActionType.DeleteRemote
    || type === SyncActionType.DeleteLocal
    || type === SyncActionType.RenameRemote
    || type === SyncActionType.SkipLargeFile
    || type === SyncActionType.RetryLater;
}

/** Unified auth failure check — covers OneDrive token expiry and AuthModule errors. */
function isAuthFailure(error: unknown): boolean {
  if (error instanceof OneDriveError && error.type === OneDriveErrorType.AuthExpired) return true;
  if (error instanceof AuthError) return true;
  return false;
}

/**
 * A transient Graph read failure proves nothing about the mutation outcome,
 * but it also does not invalidate the independent evidence available for
 * later ledger records. Keep the failed intent pending and continue read-only
 * recovery. Request-level retry budgets are already exhausted before a 429 or
 * retryable 5xx reaches this cross-round classifier.
 */
function isRetryableMutationRecoveryObservationError(
  error: unknown,
): error is OneDriveError {
  return error instanceof OneDriveError
    && (
      error.type === OneDriveErrorType.NetworkError
      || error.type === OneDriveErrorType.RateLimited
      || error.type === OneDriveErrorType.ServerError
    );
}

function mutationRecoveryIntentsOverlap(
  left: MutationIntent,
  right: MutationIntent,
): boolean {
  const leftPaths = [left.path, left.sourcePath].filter(
    (path): path is string => Boolean(path),
  );
  const rightPaths = [right.path, right.sourcePath].filter(
    (path): path is string => Boolean(path),
  );
  const leftUsesSubtree = isFolderMutationIntent(left);
  const rightUsesSubtree = isFolderMutationIntent(right);
  return leftPaths.some((leftPath) =>
    rightPaths.some((rightPath) =>
      leftPath === rightPath
      || (leftUsesSubtree && isAtOrBelowPath(rightPath, leftPath))
      || (rightUsesSubtree && isAtOrBelowPath(leftPath, rightPath))));
}

function isRemoteMutationConflict(error: OneDriveError): boolean {
  return error.type === OneDriveErrorType.PreconditionFailed
    || error.type === OneDriveErrorType.Conflict
    || error.type === OneDriveErrorType.NotFound;
}

function isSyncDecisionToken(value: unknown): value is SyncDecisionToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<SyncDecisionToken>;
  if (
    token.version !== 1
    || typeof token.vaultName !== "string"
    || typeof token.accountId !== "string"
    || !isCompleteSyncScope(token.scope)
    || (token.ancestorHash !== null && typeof token.ancestorHash !== "string")
    || !token.local
    || typeof token.local !== "object"
    || !token.remote
    || typeof token.remote !== "object"
  ) return false;
  if (token.local.exists) {
    if (typeof token.local.hash !== "string" || typeof token.local.size !== "number") return false;
  } else if (token.local.exists !== false) return false;
  if (token.remote.exists) {
    if (typeof token.remote.driveId !== "string" || typeof token.remote.eTag !== "string") return false;
  } else if (token.remote.exists !== false) return false;
  return true;
}

function isCompleteSyncScope(value: unknown): value is SyncScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Partial<SyncScope>;
  return typeof scope.accountId === "string"
    && typeof scope.driveId === "string"
    && typeof scope.vaultFolderId === "string"
    && typeof scope.filesRootId === "string";
}

function isResolvedIssueAction(type: SyncActionType): boolean {
  return type === SyncActionType.Upload
    || type === SyncActionType.Download
    || type === SyncActionType.CreateRemoteFolder
    || type === SyncActionType.CreateLocalFolder
    || type === SyncActionType.MoveRemoteFolder
    || type === SyncActionType.MoveLocalFolder
    || type === SyncActionType.DeleteRemoteFolder
    || type === SyncActionType.DeleteLocalFolder
    || type === SyncActionType.MoveLocalFile
    || type === SyncActionType.DeleteRemote
    || type === SyncActionType.DeleteLocal
    || type === SyncActionType.RenameRemote;
}

function isFileMutationAction(type: SyncActionType): boolean {
  return type === SyncActionType.Upload
    || type === SyncActionType.Download
    || type === SyncActionType.MoveLocalFile
    || type === SyncActionType.DeleteRemote
    || type === SyncActionType.DeleteLocal
    || type === SyncActionType.RenameRemote;
}

function isFolderMutationAction(type: SyncActionType): boolean {
  return type === SyncActionType.CreateRemoteFolder
    || type === SyncActionType.CreateLocalFolder
    || type === SyncActionType.MoveRemoteFolder
    || type === SyncActionType.MoveLocalFolder
    || type === SyncActionType.DeleteRemoteFolder
    || type === SyncActionType.DeleteLocalFolder;
}

function isMutationAction(type: SyncActionType): boolean {
  return isFileMutationAction(type) || isFolderMutationAction(type);
}

function isDeltaStateInvalid(error: unknown): boolean {
  if (!(error instanceof OneDriveError)) return false;
  return error.statusCode === 410
    || error.type === OneDriveErrorType.NotFound
    || error.graphCode === "resyncRequired"
    || error.graphCode === "syncStateNotFound"
    || error.graphCode === "invalidSyncState";
}

function remoteScopeLossReason(
  error: unknown,
): V2CommittedScopeLossReason | null {
  if (
    error instanceof OneDriveError
    && error.type === OneDriveErrorType.NotFound
  ) {
    return "graph-not-found";
  }
  if (error instanceof RemoteVaultScopeIdentityError) return error.reason;
  return null;
}

function emptyMutationCheckpoint(): MutationCheckpointV1 {
  return {
    baseUpserts: [],
    baseRemovals: [],
    remoteUpserts: [],
    remoteDeletes: [],
    pendingConflictRemovals: [],
    pendingDeleteRemovals: [],
  };
}

function assertNeverMutationAction(action: never): never {
  throw new Error(`Unsupported mutation recovery action: ${String(action)}`);
}

function folderMutationCheckpoint(
  entry: RemoteFolderEntry,
  consumedMoveHintRemoteId?: string,
): MutationCheckpointV1 {
  return {
    ...emptyMutationCheckpoint(),
    folderUpserts: [{ ...entry }],
    ...(consumedMoveHintRemoteId
      ? { folderMoveHintRemovals: [consumedMoveHintRemoteId] }
      : {}),
  };
}

function folderDeleteCheckpoint(path: string, driveId: string): MutationCheckpointV1 {
  return {
    ...emptyMutationCheckpoint(),
    folderDeletes: [{ path, driveId }],
    folderMoveHintRemovals: [driveId],
  };
}

function folderName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function toRemoteFolderEntry(path: string, item: DriveItem): RemoteFolderEntry {
  if (!item.id || !item.name || !item.folder || !item.parentReference?.id) {
    throw new Error(`Remote folder read-back is incomplete: ${path}`);
  }
  return {
    path,
    driveId: item.id,
    parentId: item.parentReference.id,
    name: item.name,
    eTag: item.eTag,
  };
}

function collectCorruptSourceAncestorHashes(rawEnvelope: string): string[] {
  try {
    const raw = JSON.parse(rawEnvelope);
    if (!isRecord(raw) || !isRecord(raw.anchors)) return [];
    const byAnchorId = raw.anchors.byAnchorId;
    if (!isRecord(byAnchorId)) return [];
    return [...new Set(
      Object.values(byAnchorId).flatMap((value) =>
        isRecord(value)
        && typeof value.ancestorHash === "string"
        && /^[a-f0-9]{64}$/i.test(value.ancestorHash)
          ? [value.ancestorHash.toLowerCase()]
          : []),
    )].sort();
  } catch {
    return [];
  }
}

/** Extract structured diagnostic data from an error for the diag log.
 *  OneDriveError yields type/statusCode/graphCode; generic errors yield just message. */
function errorDiagData(error: unknown): Record<string, unknown> {
  if (error instanceof OneDriveError) {
    return {
      errorType: error.type,
      statusCode: error.statusCode,
      graphCode: error.graphCode,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message };
}
