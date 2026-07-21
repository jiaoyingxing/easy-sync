/**
 * EasySync Sync Engine Types
 *
 * Core data types for local snapshots, remote snapshots, sync plans,
 * and the three-way comparison engine.
 */

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
  /** Whether the file is binary (true) or text (false) */
  binary: boolean;
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

export interface SyncPlanItem {
  type: SyncActionType;
  /** Vault-relative file path */
  path: string;
  /** Local file metadata (for upload, conflict) */
  local?: LocalFileEntry;
  /** Remote file metadata (for download, conflict) */
  remote?: RemoteFileEntry;
  /** Reason for skip or retry */
  reason?: string;
  /** eTag from the baseline entry — used as If-Match on upload to prevent
   *  silent overwrite when another device changed the file concurrently. */
  baseEtag?: string;
  /** For RenameRemote: the old path the file is being renamed from. */
  renameFrom?: string;
  /** Exact versions authorized by a user-facing pending decision. */
  decisionToken?: SyncDecisionToken;
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
}

export interface PlanReviewAuthorization {
  revision: number;
  scope: SyncScope;
}

export type MutationAction = "upload" | "download" | "deleteRemote" | "renameRemote" | "deleteLocal" | "merge";

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

export interface MutationCheckpointV1 {
  baseUpserts: BaseFileEntry[];
  baseRemovals: string[];
  remoteUpserts: RemoteFileEntry[];
  remoteDeletes: string[];
  pendingConflictRemovals: string[];
  pendingDeleteRemovals: string[];
}

/** Durable mutation result; shared state may advance only after this exists. */
export interface MutationReceiptV1 {
  version: 1;
  operationId: string;
  completedAt: number;
  checkpoint: MutationCheckpointV1;
}

export interface MutationLedgerEntryV1 {
  intent: MutationIntentV1;
  receipt: MutationReceiptV1 | null;
}

export function sameSyncScope(left: SyncScope | null, right: SyncScope | null): boolean {
  return left?.accountId === right?.accountId
    && left?.driveId === right?.driveId
    && left?.vaultFolderId === right?.vaultFolderId
    && left?.filesRootId === right?.filesRootId;
}

// ---- Scan Configuration ----

export interface ScanConfig {
  /** Paths to exclude from sync (glob-like prefixes) */
  excludePaths: string[];
  /** Paths that override exclusions. Checked before excludePaths —
   *  a path matching any includePath is never excluded. */
  includePaths: string[];
  /** Maximum file size in bytes (default 100MB) */
  maxFileSize: number;
  /** Include community plugin code files under the vault config dir plugin area. */
  includePluginCode?: boolean;
  /** Include community plugin data.json files under the vault config dir plugin area. */
  includePluginData?: boolean;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  excludePaths: [".trash/", ".DS_Store", "Thumbs.db"],
  // M19: EasySync self-sync default OFF. Explicit opt-in via syncOwnPlugin setting
  // with anti-downgrade protection (manifest.json version comparison).
  includePaths: [],
  maxFileSize: 500 * 1024 * 1024,
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
}

/** Compute a stable digest from plan items — used to detect plan changes
 *  between review and execution. */
export function planDigest(items: readonly SyncPlanItem[]): string {
  const normalized = items
    .map((i) => `${i.path}|${i.type}|${i.local?.hash ?? ""}|${i.remote?.eTag ?? ""}`)
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
