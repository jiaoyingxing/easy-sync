/**
 * EasySync Sync Engine Types
 *
 * Core data types for local snapshots, remote snapshots, sync plans,
 * and the three-way comparison engine.
 */

import type { PluginScopeSelection } from "./community-plugin-sync-policy";

export type SyncAttentionReason =
  | "community-plugin-enablement-decision-required";

/** Stable, localization-independent attention emitted by one sync run. */
export interface SyncAttention {
  reason: SyncAttentionReason;
  count: number;
}

// ---- File Metadata ----

/** Local file snapshot entry */
export interface LocalFileEntry {
  /** Vault-relative path (forward slashes, no leading slash) */
  path: string;
  /** File size in bytes */
  size: number;
  /** Last modified time (epoch ms) */
  mtime: number;
  /** Full SHA-256 hash of file content (64 hex characters) */
  hash: string;
  /** OneDrive-compatible QuickXor content hash when calculated from the same bytes */
  quickXorHash?: string;
  /** Whether the file is binary (true) or text (false) */
  binary: boolean;
}

/** Local folder topology entry. The vault root itself is never included. */
export interface LocalFolderEntry {
  /** Vault-relative path (forward slashes, no leading or trailing slash) */
  path: string;
}

/** Remote file snapshot entry */
export interface RemoteFileEntry {
  /** Vault-relative path (forward slashes, no leading slash) */
  path: string;
  /** OneDrive driveItem id */
  driveId: string;
  /** Stable OneDrive parent driveItem id; absent only on legacy/local mutation entries. */
  parentId?: string;
  /** Pre-signed download URL (from @microsoft.graph.downloadUrl) */
  downloadUrl?: string;
  /** File size in bytes */
  size: number;
  /** Last modified time from OneDrive (epoch ms) */
  mtime: number;
  /** ETag from OneDrive */
  eTag: string;
  /** CTag from OneDrive */
  cTag: string;
  /** SHA-256 content hash from OneDrive metadata when available */
  sha256Hash?: string;
  /**
   * OneDrive QuickXor content hash when available.
   * A mismatch proves different bytes; a match is not SHA-256-grade equality.
   */
  quickXorHash?: string;
}

/** Persisted Graph folder identity used only to project incremental deltas. */
export interface RemoteFolderEntry {
  /** Vault-relative folder path below files/ (forward slashes). */
  path: string;
  /** Stable OneDrive driveItem id. */
  driveId: string;
  /** Stable parent driveItem id. */
  parentId: string;
  /** Current Graph-owned folder name. */
  name: string;
  /** Graph metadata version for rename/move and create-parent guards. */
  eTag?: string;
  /** Descendant-sensitive tag when the provider exposes it for folders. */
  cTag?: string;
}

/** Complete identity boundary for every reusable sync artifact. */
export interface SyncScope {
  accountId: string;
  driveId: string;
  vaultFolderId: string;
  filesRootId: string;
}

export function isSyncScope(value: unknown): value is SyncScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Partial<SyncScope>;
  return typeof scope.accountId === "string" && scope.accountId.length > 0
    && typeof scope.driveId === "string" && scope.driveId.length > 0
    && typeof scope.vaultFolderId === "string" && scope.vaultFolderId.length > 0
    && typeof scope.filesRootId === "string" && scope.filesRootId.length > 0;
}

export interface RemoteSyncState {
  version: 1;
  /** Monotonically increasing counter — detects mid-sync resets or concurrent runs */
  generation: number;
  /** Null means legacy/incomplete identity and must never authorize cursor reuse. */
  scope: SyncScope | null;
  deltaLink: string | null;
  entries: Record<string, RemoteFileEntry>;
  /** Same-generation folder identity index; missing in legacy V1 files. */
  folders: Record<string, RemoteFolderEntry>;
  /** True only after a complete identity scan established the folder index. */
  folderIndexComplete?: boolean;
}

/** Baseline entry — the state after last successful sync */
export interface BaseFileEntry {
  path: string;
  /** Hash at last sync (for local comparison) */
  hash: string;
  /** Size at last sync */
  size: number;
  /** ETag at last sync (for remote comparison) */
  eTag: string;
}

// ---- Sync Plan Types ----

export enum SyncActionType {
  Upload = "upload",
  Download = "download",
  RecreateRemoteScope = "recreateRemoteScope",
  CreateRemoteFolder = "createRemoteFolder",
  CreateLocalFolder = "createLocalFolder",
  MoveRemoteFolder = "moveRemoteFolder",
  MoveLocalFolder = "moveLocalFolder",
  DeleteRemoteFolder = "deleteRemoteFolder",
  DeleteLocalFolder = "deleteLocalFolder",
  MoveLocalFile = "moveLocalFile",
  FolderDeferred = "folderDeferred",
  DeleteRemote = "deleteRemote",
  DeleteLocal = "deleteLocal",
  ConfirmLocalDelete = "confirmLocalDelete",
  RenameRemote = "renameRemote",
  Conflict = "conflict",
  SkipLargeFile = "skipLargeFile",
  SkipIgnoredPath = "skipIgnoredPath",
  RetryLater = "retryLater",
  AuthExpired = "authExpired",
}

export interface SyncPlanFolder {
  /** Stable remote identity when the folder already exists remotely. */
  remoteId?: string;
  /** Parent identity used for create-only Graph writes and read-back checks. */
  parentRemoteId?: string;
  /** Vault-relative parent path; empty means the committed files root. */
  parentPath: string;
  /** Folder version captured by the committed V2 envelope. */
  remoteETag?: string;
  /** Parent version captured by the committed V2 envelope. */
  parentRemoteETag?: string;
  /** Source parent identity for an identity-preserving move or delete. */
  sourceParentRemoteId?: string;
}

export interface SyncPlanItem {
  type: SyncActionType;
  /** Vault-relative file path */
  path: string;
  /** Local file metadata (for upload, conflict) */
  local?: LocalFileEntry;
  /** Remote file metadata (for download, conflict) */
  remote?: RemoteFileEntry;
  /** Present only for V2 folder actions. */
  folder?: SyncPlanFolder;
  /** Reason for skip or retry */
  reason?: string;
  /** eTag from the baseline entry — used as If-Match on upload to prevent
   *  silent overwrite when another device changed the file concurrently. */
  baseEtag?: string;
  /** For RenameRemote: the old path the file is being renamed from. */
  renameFrom?: string;
  /** Destination parent identity for a cross-directory file move. */
  targetParentRemoteId?: string;
  /** Destructive local folder shell removal still awaits the existing delete approval. */
  requiresConfirmation?: boolean;
  /** Grouped identity action weight used by the existing bulk-change review gate. */
  reviewImpactCount?: number;
  /** Exact versions authorized by a user-facing pending decision. */
  decisionToken?: SyncDecisionToken;
  /**
   * Durable proof that these exact local and remote versions were already
   * compared byte-for-byte and are different. Missing means comparison has
   * not completed, not that the versions are known to differ.
   */
  contentComparison?: ContentComparisonReceiptV1;
  /**
   * Discardable, non-authoritative observation that the exact ancestor/local/
   * remote versions were already proven to require manual text resolution.
   * It never authorizes a mutation and is ignored on any source mismatch.
   */
  textMergeEvidence?: TextMergeManualEvidenceV1;
}

export interface ContentComparisonReceiptV1 {
  version: 1;
  result: "different";
  localHash: string;
  localSize: number;
  remoteDriveId: string;
  remoteETag: string;
  remoteSize: number;
  remoteHash: string;
}

export type TextMergeManualEvidenceReasonV1 =
  | "invalid-utf8"
  | "mixed-line-endings"
  | "too-large"
  | "overlap";

export interface TextMergeManualEvidenceV1 {
  version: 1;
  algorithm: "conservative-line-merge-v1";
  result: "manual";
  reason: TextMergeManualEvidenceReasonV1;
  scope: SyncScope;
  ancestorHash: string;
  ancestorSize: number;
  ancestorETag: string;
  localHash: string;
  localSize: number;
  remoteDriveId: string;
  remoteETag: string;
  remoteSize: number;
  remoteHash: string;
}

export interface SyncDecisionToken {
  version: 1;
  vaultName: string;
  accountId: string;
  scope: SyncScope;
  local: { exists: false } | { exists: true; hash: string; size: number };
  remote: { exists: false } | { exists: true; driveId: string; eTag: string };
  ancestorHash: string | null;
}

export interface SyncPlan {
  items: SyncPlanItem[];
  /** Total file count from last successful sync (for threshold check) */
  lastTotalFiles: number;
  /** Whether the plan has been confirmed by user (if threshold was exceeded) */
  confirmed: boolean;
  /** Filled by SyncExecutor after resolving the current Graph scope. */
  scope?: SyncScope;
  /** V2-only sealed identity for the exact ordered plan and source revision. */
  canonicalIdentity?: CanonicalPlanIdentityV2;
  /** V2-only review facts derived by the same owner that sealed the plan. */
  canonicalReview?: CanonicalPlanReviewV2;
  /** V2 activation review is a control-plane hold, never a V1 execution grant. */
  reviewKind?: V2ActivationReviewKind;
}

export type V2ActivationReviewKind =
  | "v2-migration"
  | "v2-cloud-join"
  | "v2-first-sync";

export interface CanonicalPlanIdentityV2 {
  version: 2;
  scope: SyncScope;
  sourceCommitSeq: number;
  digest: string;
}

export interface CanonicalPlanReviewV2 {
  counts: PlanReviewCounts;
  /** Weighted change count used by the bulk-change review policy. */
  impactCount: number;
}

export interface PlanReviewAuthorization {
  /**
   * Device-local review-record CAS. This is not the V2 plan revision; the
   * canonical identity carries the committed source revision and digest.
   */
  revision: number;
  scope: SyncScope;
  /** Absent for review bundles imported from the public V1 runtime. */
  canonicalIdentity?: CanonicalPlanIdentityV2;
  /** Present only when the review record belongs to the V2 activation hold. */
  reviewKind?: V2ActivationReviewKind;
}

export type MutationAction =
  | "upload"
  | "download"
  | "deleteRemote"
  | "renameRemote"
  | "moveLocal"
  | "deleteLocal"
  | "merge";
export type FolderMutationActionV2 =
  | "createLocalFolder"
  | "createRemoteFolder"
  | "moveLocalFolder"
  | "moveRemoteFolder"
  | "deleteLocalFolder"
  | "deleteRemoteFolder";

export type MutationLocalExpectation =
  | { exists: false }
  | { exists: true; hash: string; size: number };

export type MutationRemoteExpectation =
  | { exists: false }
  | { exists: true; driveId: string; eTag: string; size: number; sha256Hash?: string };

/** Durable fact written before any local or remote file mutation. */
export interface MutationIntentV1 {
  version: 1;
  operationId: string;
  planRevision: number;
  scope: SyncScope;
  action: MutationAction;
  path: string;
  sourcePath?: string;
  expectedLocal: MutationLocalExpectation;
  expectedRemote: MutationRemoteExpectation;
  /** Exact result bytes persisted in merge-ready storage before a merge mutates either side. */
  target?: { hash: string; size: number };
  createdAt: number;
}

export interface FolderMutationIntentV2 {
  version: 2;
  operationId: string;
  planRevision: number;
  scope: SyncScope;
  action: FolderMutationActionV2;
  path: string;
  sourcePath?: string;
  /** Stable identity retained even when the current remote index has a tombstone. */
  folderId?: string;
  expectedLocal: { exists: boolean };
  expectedSourceLocal?: { exists: boolean };
  expectedRemote:
    | { exists: false }
    | {
        exists: true;
        driveId: string;
        parentId: string;
        eTag?: string;
      };
  expectedParent: {
    driveId: string;
    path: string;
    eTag?: string;
  };
  createdAt: number;
}

export type MutationIntent = MutationIntentV1 | FolderMutationIntentV2;

export interface MutationCheckpointV1 {
  baseUpserts: BaseFileEntry[];
  baseRemovals: string[];
  remoteUpserts: RemoteFileEntry[];
  remoteDeletes: string[];
  pendingConflictRemovals: string[];
  pendingDeleteRemovals: string[];
  /** V2-only directory facts produced by create-local/create-remote. */
  folderUpserts?: RemoteFolderEntry[];
  /** V2-only directory identities retired after an empty-shell delete. */
  folderDeletes?: Array<{ path: string; driveId: string }>;
  /** Device-local rename hints consumed by a committed folder mutation. */
  folderMoveHintRemovals?: string[];
}

/** Durable mutation result; shared state may advance only after this exists. */
export interface MutationReceiptV1 {
  version: 1;
  operationId: string;
  completedAt: number;
  checkpoint: MutationCheckpointV1;
}

export type ManualMutationResolutionChoiceV1 = "keep-local" | "keep-remote";

/** Exact V2 state evidence for recovering one receipted remote rename whose
 * checkpoint is blocked by a distinct anchor already owning the target path. */
export interface ReceiptedRenameAnchorCollisionEvidenceV1 {
  kind: "receipted-rename-target-anchor-collision";
  lifecycleEpoch: number;
  sourceCommitSeq: number;
  sourceAnchorId: string;
  targetAnchorId: string;
  /** Every stale Graph identity that must remain absent through publication. */
  staleRemoteIds: string[];
}

/**
 * A user-reviewed continuation of one otherwise blocked mutation record.
 *
 * The outer intent/receipt remain untouched so downgrade readers fail closed
 * without losing the original blocking evidence. Newer builds execute and
 * checkpoint only this nested, current-facts-bound continuation.
 */
export interface ManualMutationResolutionV1 {
  version: 1;
  choice: ManualMutationResolutionChoiceV1;
  factsDigest: string;
  selectedAt: number;
  /** False only when strict equality permits a state-only reconciliation. */
  externalMutation: boolean;
  recoveryEvidence?: ReceiptedRenameAnchorCollisionEvidenceV1;
  intent: MutationIntentV1;
  receipt: MutationReceiptV1 | null;
}

export interface MutationLedgerEntryV1 {
  intent: MutationIntent;
  receipt: MutationReceiptV1 | null;
  manualResolution?: ManualMutationResolutionV1;
}

export interface ManualMutationResolutionAuditV1 {
  version: 1;
  sourceOperationId: string;
  resolutionOperationId: string;
  path: string;
  choice: ManualMutationResolutionChoiceV1;
  action: MutationAction;
  externalMutation: boolean;
  selectedAt: number;
  completedAt: number;
}

export interface ManualMutationResolutionLocalFactV1 {
  path: string;
  exists: boolean;
  hash?: string;
  size?: number;
}

export interface ManualMutationResolutionRemoteFactV1 {
  path: string;
  exists: boolean;
  driveId?: string;
  eTag?: string;
  hash?: string;
  size?: number;
}

export interface ManualMutationResolutionOptionV1 {
  available: boolean;
  deletesOtherSide: boolean;
}

/** Read-only facts shown to the user and rechecked before a manual choice. */
export interface ManualMutationResolutionSnapshotV1 {
  version: 1;
  sourceOperationId: string;
  scope: SyncScope;
  previousAction: MutationAction;
  path: string;
  sourcePath?: string;
  local: ManualMutationResolutionLocalFactV1[];
  remote: ManualMutationResolutionRemoteFactV1[];
  recoveryEvidence?: ReceiptedRenameAnchorCollisionEvidenceV1;
  factsDigest: string;
  identical: boolean;
  keepLocal: ManualMutationResolutionOptionV1;
  keepRemote: ManualMutationResolutionOptionV1;
}

/**
 * Stable non-authoritative reason codes for exposing why an active V2
 * mutation recovery stopped. These codes may be retained in sync history for
 * diagnostics and presentation, but never authorize a file or Graph write.
 */
export type MutationRecoveryBlockReason =
  | "facts-changed"
  | "scope-changed"
  | "account-changed"
  | "evidence-corrupt"
  | "state-unavailable"
  | "automatic-budget-exhausted"
  | "unknown";

export interface MutationRecoveryRunSummary {
  state: "settled" | "network-unavailable" | "blocked";
  total: number;
  settled: number;
  remaining: number;
  retryAfterSeconds: number | null;
  blockReason?: MutationRecoveryBlockReason;
  /** First non-retryable root record that can be reviewed by the user. */
  blockedOperationId?: string;
}

export interface MutationRecoveryHistory {
  state: "waiting-network" | "recovered" | "blocked";
  total: number;
  settled: number;
  remaining: number;
  updatedAt: number;
  retryAt?: number;
  blockReason?: MutationRecoveryBlockReason;
  blockedOperationId?: string;
}

/**
 * Device-local evidence captured from Obsidian's TFolder rename event.
 * It never authorizes a mutation alone; the V2 planner must bind it to the
 * same committed folder ID and re-check both complete snapshots.
 */
export interface LocalFolderMoveHintV1 {
  version: 1;
  scope: SyncScope;
  remoteId: string;
  fromPath: string;
  toPath: string;
  observedAt: number;
}

export function sameSyncScope(left: SyncScope | null, right: SyncScope | null): boolean {
  return left?.accountId === right?.accountId
    && left?.driveId === right?.driveId
    && left?.vaultFolderId === right?.vaultFolderId
    && left?.filesRootId === right?.filesRootId;
}

export function sameCanonicalPlanIdentityV2(
  left: CanonicalPlanIdentityV2 | null | undefined,
  right: CanonicalPlanIdentityV2 | null | undefined,
): boolean {
  if (!left || !right) return left == null && right == null;
  return left.version === 2
    && right.version === 2
    && left.sourceCommitSeq === right.sourceCommitSeq
    && left.digest === right.digest
    && sameSyncScope(left.scope, right.scope);
}

// ---- Scan Configuration ----

export interface ScanConfig {
  /** Paths to exclude from sync (glob-like prefixes) */
  excludePaths: string[];
  /** Device-local vault-relative folders excluded from sync.
   *  These exact folder boundaries take precedence over includePaths. */
  excludedFolders?: string[];
  /** Paths that override exclusions. Checked before excludePaths —
   *  a path matching any includePath is never excluded. */
  includePaths: string[];
  /** Maximum file size in bytes (default 100MB) */
  maxFileSize: number;
  /** Include EasySync's own main.js, manifest.json, and styles.css. */
  includeOwnPluginCode?: boolean;
  /** Include community plugin code files under the vault config dir plugin area. */
  includePluginCode?: boolean;
  /** Include community plugin data.json files under the vault config dir plugin area. */
  includePluginData?: boolean;
  /** Fine-grained community plugin code scope. Overrides includePluginCode when present. */
  pluginCodeSelection?: PluginScopeSelection;
  /** Fine-grained community plugin data scope. Overrides includePluginData when present. */
  pluginDataSelection?: PluginScopeSelection;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  excludePaths: [".trash/", ".DS_Store", "Thumbs.db"],
  excludedFolders: [],
  // M19: EasySync self-sync default OFF. Explicit opt-in via syncOwnPlugin setting
  // with anti-downgrade protection (manifest.json version comparison).
  includePaths: [],
  maxFileSize: 500 * 1024 * 1024,
  includeOwnPluginCode: false,
  includePluginCode: false,
  includePluginData: false,
};

// ---- Change Threshold ----

/** If changed files exceed this ratio of total files, pause for confirmation */
export const CHANGE_THRESHOLD_RATIO = 0.5;

// ---- Cloud Baseline ----

/** A single file entry in the cloud baseline snapshot */
export interface BaselineFileEntry {
  hash: string;
  size: number;
  eTag: string;
  mtime: number;
}

// ---- Plan Review (sidebar preview before execution) ----

/** Summary counts for a sync plan held for user review in the sidebar */
export interface PlanReviewCounts {
  uploads: number;
  downloads: number;
  /** Aggregate folder/scope changes for legacy count-only review bundles. */
  folders?: number;
  deletes: number;
  conflicts: number;
  skipped: number;
}

export interface PlanReviewItem {
  type: SyncActionType;
  path: string;
  reason?: string;
  /** Hash from the local file at review time — used to detect plan staleness */
  localHash?: string;
  /** eTag from the remote file at review time */
  remoteETag?: string;
  /** Stable folder identity/version used to make review digests stale-safe. */
  folderRemoteId?: string;
  folderRemoteETag?: string;
  folderParentRemoteId?: string;
  folderParentPath?: string;
  folderParentRemoteETag?: string;
}

/** Compute a stable digest from plan items — used to detect plan changes
 *  between review and execution. */
export function planDigest(items: readonly SyncPlanItem[]): string {
  const normalized = items
    .map((i) => [
      i.path,
      i.type,
      i.local?.hash ?? "",
      i.remote?.eTag ?? "",
      i.folder?.remoteId ?? "",
      i.folder?.remoteETag ?? "",
      i.folder?.parentRemoteId ?? "",
      i.folder?.parentPath ?? "",
      i.folder?.parentRemoteETag ?? "",
      i.requiresConfirmation ? "confirm" : "",
      i.reviewImpactCount ?? 1,
    ].join("|"))
    .sort();
  return normalized.join("\n");
}

/** Cloud baseline snapshot stored at .easy-sync/baseline.json in the App Folder.
 *  Used to bootstrap sync state on a new device without re-scanning every file. */
export interface CloudBaseline {
  vaultName: string;
  lastSyncAt: number;
  files: Record<string, BaselineFileEntry>;
}
