/**
 * SyncExecutor — Main sync run orchestrator
 *
 * Ties together LocalScanner, OneDriveClient, SyncEngine, and StateManager
 * to execute a complete sync round. Handles:
 *  - First sync initialization (mode detection, plan preview)
 *  - Bidirectional sync (three-way comparison → plan → execute)
 *  - Per-file immediate persistence (interruption recovery)
 *  - Token expiry pause-and-resume
 *  - Change threshold pause
 *  - Sync lock (one run at a time)
 *  - Conflict and delete-confirmation routing
 */

import { Platform, type DataAdapter, type FileManager } from "obsidian";
import { sha256Hex } from "../crypto";
import { compatSetTimeout, getConfigDir, getEasySyncPaths } from "../obsidian-compat";
import { OneDriveError, OneDriveErrorType } from "../onedrive/types";
import type { DriveItem, UploadResult } from "../onedrive/types";
import { AuthError } from "../auth/types";
import { SyncActionType, planDigest, sameSyncScope } from "./types";
import type { OneDriveClient } from "../onedrive/client";
import { isEasySyncInternalPath } from "./local-scanner";
import type { LocalFileInspection, LocalScanner } from "./local-scanner";
import { isObsidianManagedConfigPath, remoteContentMatchesBase } from "./sync-engine";
import type { SyncEngine } from "./sync-engine";
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
  MutationReceiptV1,
  MutationCheckpointV1,
  MutationLedgerEntryV1,
} from "./types";
import type { DiagnosticLogger } from "./diagnostic-logger";
import type { I18n } from "../i18n/index";
import { SyncProgressStore, type FileProgress } from "./sync-progress";
import { OperationLifecycle } from "./operation-lifecycle";
import { EasySyncNoticeCenter, NOTICE_PRIORITY } from "../ui/notice-center";
import { LocalRecoveryJournal } from "./local-recovery-journal";
import { MergeReadyStore } from "./merge-ready-store";
import { evaluateConservativeMergeV2 } from "./conservative-merge-v2";
import { buildRemoteIndexV2 } from "./remote-index-v2";
import { compareV1WithV2Shadow } from "./read-only-shadow-v2";
import {
  ADAPTIVE_DOWNLOAD_MAX_BYTES,
  DownloadConcurrencyPolicy,
} from "./download-concurrency-policy";
import { resolveContentEquality } from "./content-equality";
import {
  applyAutomaticHandlingPolicy,
  DEFAULT_AUTOMATIC_HANDLING_POLICY,
  isAutomaticTextMergeCandidatePath,
  type AutomaticHandlingPolicy,
} from "./automatic-handling-policy";

/** Result of a sync run */
export interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  /** Files safely left for the next round because their version changed in flight. */
  deferred: number;
  skippedLarge: number;
  skippedIgnored: number;
  errors: number;
  authExpired: boolean;
  message: string;
  metrics?: ExecutionMetrics;
}

/** Result of executing a single plan item — caller collects baseUpsert/baseRemoval for batch persistence. */
export interface ItemExecutionResult {
  executed: boolean;
  /** True only after a local/remote file mutation returned successfully. */
  mutationApplied?: boolean;
  baseUpsert?: BaseFileEntry;
  baseRemoval?: string;
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

interface RemoteProjection {
  entries: RemoteFileEntry[];
  folders: RemoteFolderEntry[];
}

const SMALL_UPLOAD_CONCURRENCY = 5;
const CONCURRENT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const LARGE_UPLOAD_CONCURRENCY = 2;

const MOBILE_SMALL_UPLOAD_CONCURRENCY = 2;
const MOBILE_LARGE_UPLOAD_CONCURRENCY = 1;
const MOBILE_STREAM_DOWNLOAD_MIN_BYTES = 8 * 1024 * 1024;

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

/** Marks a failure that happened before the reviewed target was mutated. */
class SideMutationNotAppliedError extends Error {
  constructor(
    readonly original: unknown,
    readonly noticeAlreadyShown = false,
  ) {
    super(original instanceof Error ? original.message : "Reviewed mutation was not applied");
    this.name = "SideMutationNotAppliedError";
  }
}

/** Local CAS failed before commitDownloadedTempFile touched the target. */
class LocalCommitPreconditionError extends Error {}

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
  onFileComplete?: (path: string, actionType: SyncActionType, success: boolean, reason?: string, fileSize?: number) => void;
  onStateChange?: () => void;
  onConfirmThreshold?: (plan: SyncPlan) => Promise<boolean>;
  onFirstSyncPreview?: (plan: SyncPlan) => Promise<boolean>;
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
  private v2ShadowIdentityInput: {
    remoteItems: DriveItem[];
    v1RemoteEntries: RemoteFileEntry[];
  } | null = null;
  private automaticHandlingPolicy: AutomaticHandlingPolicy = {
    ...DEFAULT_AUTOMATIC_HANDLING_POLICY,
  };

  constructor(
    private onedrive: OneDriveClient,
    private scanner: LocalScanner,
    private engine: SyncEngine,
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
      || key === "result.authExpired"
      || key === "notice.localRecoveryFailed"
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

  get isRunning(): boolean {
    return this.running;
  }

  setAutomaticHandlingPolicy(policy: Readonly<AutomaticHandlingPolicy>): void {
    this.automaticHandlingPolicy = { ...policy };
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
      cTag: "",
      sha256Hash: current.sha256Hash,
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
      throw new Error(`Remote version changed during download: ${path}`);
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

  private getMergeReadyStore(): MergeReadyStore {
    return new MergeReadyStore(
      this.scanner.vault.adapter,
      getEasySyncPaths(this.scanner.vault).tmpDir,
    );
  }

  private async removePathIfExists(path: string): Promise<void> {
    try { await this.scanner.vault.adapter.remove(path); } catch { /* noop */ }
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
    if (this.state.legacyAutoSyncAllowed === false) {
      return { success: false, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferred: 0, skippedLarge: 0, skippedIgnored: 0, errors: 1, authExpired: false, message: this.t("result.legacyStateDisabled") };
    }

    this.running = true;
    this.cancelled = false;
    this.remoteRecoveryPreviewRequired = false;
    this.localVersionRecoveredDuringLedger = false;
    this.v2ShadowIdentityInput = null;
    this.cancelController = new AbortController();
    const operationEpoch = this.lifecycle.capture();
    const automaticHandlingPolicy = { ...this.automaticHandlingPolicy };
    const automaticHandlingMetrics = createAutomaticHandlingMetrics(
      automaticHandlingPolicy,
    );
    this.startGeneration = this.state.remoteGeneration;
    this.onedrive.resetDownloadStrategy();
    this.onedrive.setAbortSignal(this.cancelController.signal);
    const collectNetworkMetrics = this.diag?.isEnabled?.("onedrive") === true;
    if (collectNetworkMetrics) this.onedrive.beginRunMetrics();

    const result: SyncResult = {
      success: false,
      uploaded: 0,
      downloaded: 0,
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

      // Step 1: Scan local files
      enterPhase("scan");
      this.progressStore?.setPhase("scanning");
      callbacks.onProgress?.(0, 1, this.t("progress.scanningLocal"));
      const scanResult = await this.scanner.scanAll();
      let localEntries = scanResult.entries;
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
      const restoredCommittedScope = !options.readOnlyPreview
        && this.state.mutationLedger.length === 0
        && Boolean(this.state.boundAccountId)
        && committedScope?.accountId === this.state.boundAccountId
        && Boolean(committedDeltaLink)
        && this.onedrive.restoreVaultScope(
          this.vaultName,
          {
            driveId: committedScope.driveId,
            vaultFolderId: committedScope.vaultFolderId,
            filesRootId: committedScope.filesRootId,
          },
          committedDeltaLink!,
        );
      const remoteVaultScope = restoredCommittedScope
        ? {
            driveId: committedScope!.driveId,
            vaultFolderId: committedScope!.vaultFolderId,
            filesRootId: committedScope!.filesRootId,
          }
        : options.readOnlyPreview
          ? await this.onedrive.initVaultScope(this.vaultName, { createMissing: false })
          : await this.onedrive.initVaultScope(this.vaultName);
      let syncScope: SyncScope = {
        accountId: this.state.boundAccountId,
        ...remoteVaultScope,
      };
      this.activeSyncScope = syncScope;
      if (this.shouldStop(result, operationEpoch)) return result;
      await this.recoverMutationLedger(syncScope, automaticHandlingMetrics);
      if (this.shouldStop(result, operationEpoch)) return result;
      if (this.localVersionRecoveredDuringLedger) {
        const recoveredScan = await this.scanner.scanAll();
        if (recoveredScan.complete === false || recoveredScan.failedPaths.length > 0) {
          result.errors = Math.max(1, new Set(recoveredScan.failedPaths).size);
          result.message = this.t("result.scanIncomplete");
          return result;
        }
        localEntries = recoveredScan.entries;
        this.localVersionRecoveredDuringLedger = false;
        this.diag?.warn("execute", "local scan refreshed after interrupted merge recovery");
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
        await this.state.clearRemoteState();
      }

      // Step 2: Bootstrap cloud baseline on new devices.
      // If local baseSnapshot is empty (fresh install / new device), try to
      // download the cloud baseline from .easy-sync/baseline.json. The cloud
      // baseline is only safe as a hint for paths that currently exist on both
      // sides; remote-only paths must still download instead of being treated
      // as local deletions.
      enterPhase("baseline");
      this.progressStore?.setPhase("baseline");
      callbacks.onProgress?.(0, 1, this.t("progress.loadingBaseline"));
      let cloudBaselineJson: string | null = null;
      if (this.state.baseSnapshot.length === 0) {
        // Retry up to 3 times with exponential backoff — transient network
        // errors are common on mobile and should not force a full conflict
        // dedup pass when the baseline file actually exists.
        const MAX_BASELINE_ATTEMPTS = 3;
        for (let attempt = 0; attempt < MAX_BASELINE_ATTEMPTS; attempt++) {
          try {
            cloudBaselineJson = await this.onedrive.downloadBaseline(this.vaultName);
            break; // success — exit retry loop
          } catch (e) {
            const isLast = attempt === MAX_BASELINE_ATTEMPTS - 1;
            if (e instanceof OneDriveError && e.type === OneDriveErrorType.NotFound) {
              this.diag?.log("state", "no cloud baseline (fresh vault, first sync ever)");
              break; // NotFound is not retryable
            }
            if (isLast) {
              this.diag?.warn("state", "cloud baseline download failed after retries", e instanceof Error ? e.message : String(e));
            } else {
              const waitMs = 500 * (2 ** attempt);
              this.diag?.log("state", `cloud baseline download failed (attempt ${attempt + 1}), retrying in ${waitMs}ms`);
              await new Promise<void>((resolve) => compatSetTimeout(() => resolve(), waitMs));
            }
          }
        }
      }
      if (this.shouldStop(result, operationEpoch)) return result;

      // Step 3: Get remote file list (delta or full scan)
      enterPhase("remoteChanges");
      this.progressStore?.setPhase("checking");
      callbacks.onProgress?.(0, 1, this.t("progress.checkingRemote"));
      const remotePreparation = await this.tryDeltaOrFullScan(
        operationEpoch,
        result,
        syncScope,
        localEntries,
      );
      let remoteEntries = remotePreparation.entries;
      syncScope = remotePreparation.scope;
      this.activeSyncScope = syncScope;
      if (this.shouldStop(result, operationEpoch)) return result;

      if (this.state.remoteGeneration !== this.startGeneration) {
        result.message = this.t("result.generationMismatch");
        this.diag?.warn("execute", `generation mismatch after delta scan (${this.startGeneration} → ${this.state.remoteGeneration}), aborting`);
        return result;
      }

      // Step 4: Load base snapshot
      let baseEntries = this.state.baseSnapshot.filter(
        (entry) => this.shouldIncludeRemotePath(entry.path),
      );
      let seededBaseEntries: BaseFileEntry[] = [];
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
        await this.state.upsertBaseEntries(eTagUpdates);
        const updatedByPath = new Map(eTagUpdates.map((entry) => [entry.path, entry]));
        baseEntries = baseEntries.map((entry) => updatedByPath.get(entry.path) ?? entry);
        this.diag?.log("state", `reconciled ${eTagUpdates.length} unchanged remote eTag(s)`);
      }
      if (this.shouldStop(result, operationEpoch)) return result;

      // Step 5: Generate sync plan
      enterPhase("planning");
      this.progressStore?.setPhase("planning");
      callbacks.onProgress?.(0, 1, this.t("progress.generatingPlan"));
      const plan = this.engine.generatePlan(
        localEntries,
        remoteEntries,
        baseEntries,
        skippedLarge,
      );
      plan.scope = syncScope;
      this.diag?.log("plan", `plan generated — ${plan.items.length} actions (up/down/del/conflict: ${plan.items.filter(i=>i.type===SyncActionType.Upload).length}/${plan.items.filter(i=>i.type===SyncActionType.Download).length}/${plan.items.filter(i=>i.type===SyncActionType.Conflict).length})`);
      this.observeV2ReadOnlyShadow(
        syncScope,
        localEntries,
        baseEntries,
        skippedLarge,
        plan,
      );

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
        const obsidianLocal = localEntries.filter((e) => e.path.startsWith(configPrefix));
        this.diag?.log("plan", `NO ${configPrefix} uploads in plan. localEntries with ${configPrefix}: ${obsidianLocal.map((e) => e.path).join(', ') || '(none)'}`);
      }

      // Step 5.5: Content hash dedup — for files that appear on both sides
      // without a base entry, compare actual content hashes to avoid false
      // conflicts when the same file exists on two devices (cloud baseline
      // covers most cases; this is the fallback for remaining edge cases).
      //
      // SAFETY LIMIT: during normal sync, download-based hash dedup is
      // capped at 10 files to avoid stalling on slow networks. During
      // bootstrap (baseline empty, cloud baseline unavailable), lift the
      // cap — the user expects the first sync to take longer, and leaving
      // false conflicts unresolved is worse than a few extra downloads.
      {
        const MAX_HASH_DEDUP_FILES = 10;
        const isBootstrap = baseEntries.length === 0;
        const pendingByPath = new Map(
          this.state.pendingConflicts.map((item) => [item.path, item]),
        );
        const baseByPath = new Map(
          baseEntries.map((entry) => [entry.path, entry]),
        );
        const candidates = plan.items.filter((item) => {
          if (
            item.type !== SyncActionType.Conflict
            || (item.reason !== "reason.newFileBothSides" && item.reason !== "reason.bothSidesModified")
            || !item.local
            || !item.remote
            || item.local.size !== item.remote.size
          ) {
            return false;
          }
          const pending = pendingByPath.get(item.path);
          const equality = resolveContentEquality({
            local: item.local,
            remote: item.remote,
            base: baseByPath.get(item.path),
          });
          return equality.status !== "unknown"
            || pending?.local?.hash !== item.local.hash
            || pending.remote?.eTag !== item.remote.eTag;
        });
        const evidenceCandidates = candidates.filter((item) => resolveContentEquality({
          local: item.local!,
          remote: item.remote!,
          base: baseByPath.get(item.path),
        }).status !== "unknown");
        const evidencePaths = new Set(evidenceCandidates.map((item) => item.path));
        const maxDownloads = isBootstrap
          ? candidates.length
          : MAX_HASH_DEDUP_FILES;
        const downloadCandidates = candidates
          .filter((item) => !evidencePaths.has(item.path))
          .slice(0, maxDownloads);
        const selectedCandidates = [...evidenceCandidates, ...downloadCandidates];
        const dedupTotal = selectedCandidates.length;

        if (candidates.length > 0) {
          this.progressStore?.setPhase("verifying");
          this.diag?.log(
            "plan",
            `hash dedup${isBootstrap ? " (bootstrap)" : ""} — ${evidenceCandidates.length} cached evidence candidate(s), ${downloadCandidates.length}/${candidates.length - evidenceCandidates.length} download candidate(s)`,
          );
        }

        const falseConflicts = new Set<string>();
        const matchedBaseEntries: BaseFileEntry[] = [];
        let dedupCount = 0;

        for (const item of selectedCandidates) {
          if (this.shouldStop(result, operationEpoch)) return result;
          // filter() guarantees local & remote are non-null, but TS
          // doesn't narrow through filter predicates
          const local = item.local!;
          const remote = item.remote!;

          dedupCount++;
          this.progressStore?.setProgress(dedupCount, dedupTotal, item.path);
          callbacks.onProgress?.(
            dedupCount,
            dedupTotal,
            this.t("progress.verifyingFiles", {
              current: dedupCount,
              total: dedupTotal,
            }),
          );

          try {
            this.diag?.log("plan", `hash dedup [${dedupCount}/${dedupTotal}] checking ${item.path} (${local.size} bytes)`);
            let equality = resolveContentEquality({
              local,
              remote,
              base: baseByPath.get(item.path),
            });
            if (equality.status === "unknown") {
              const remoteContent = await this.onedrive.downloadFile(
                this.vaultName,
                item.path,
                remote.downloadUrl,
                remote.driveId,
                remote.size,
              );
              equality = resolveContentEquality({
                local,
                remote,
                base: baseByPath.get(item.path),
                downloadedHash: await sha256Hex(remoteContent),
              });
            }
            if (equality.status === "equal") {
              this.diag?.log("plan", `hash dedup MATCH — ${item.path} identical via ${equality.proof}`);
              matchedBaseEntries.push({
                path: item.path,
                hash: local.hash,
                size: local.size,
                eTag: remote.eTag,
              });
              falseConflicts.add(item.path);
            } else {
              this.diag?.log("plan", `hash dedup MISMATCH — ${item.path} differs via ${equality.proof}`);
            }
          } catch (e) {
            this.diag?.warn("plan", `hash dedup skipped ${item.path} — download failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (matchedBaseEntries.length > 0) {
          if (this.shouldStop(result, operationEpoch)) return result;
          await this.state.upsertBaseEntries(matchedBaseEntries);
        }

        const skippedDownloadCandidates = candidates.length
          - evidenceCandidates.length
          - downloadCandidates.length;
        if (skippedDownloadCandidates > 0) {
          this.diag?.log(
            "plan",
            `hash dedup download cap reached (${MAX_HASH_DEDUP_FILES}), ${skippedDownloadCandidates} conflict(s) kept for manual resolution`,
          );
        }

        if (falseConflicts.size > 0) {
          this.diag?.log("plan", `hash dedup resolved ${falseConflicts.size} false conflicts`);
          plan.items = plan.items.filter(
            (item) => !falseConflicts.has(item.path),
          );
        }
      }

      plan.items = applyAutomaticHandlingPolicy(
        plan.items,
        automaticHandlingPolicy,
      );

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
            || item.type === SyncActionType.DeleteLocal)
          .map((item) => item.path),
      );
      if (this.shouldStop(result, operationEpoch)) return result;
      await this.state.prunePendingIssues(
        plan.items
          .filter((item) => isPendingIssueAction(item.type))
          .map((item) => item.path),
      );
      if (this.shouldStop(result, operationEpoch)) return result;

      // Every user-visible pending item must carry the exact reviewed
      // versions before a first-sync or threshold callback can persist it.
      this.bindPendingDecisionTokens(plan);

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
      // pre-execution rewrites (scan health, dedup, pending pruning). The
      // reviewed bundle stays in state until this point so stale plans re-pause.
      if (skipConfirmation && this.state.planReviewActive) {
        const authorizationIsCurrent = Boolean(
          reviewedAuthorization
          && reviewedAuthorization.revision === this.state.planReviewRevision
          && sameSyncScope(reviewedAuthorization.scope, this.state.planReviewScope)
          && sameSyncScope(reviewedAuthorization.scope, syncScope)
        );
        if (!authorizationIsCurrent) {
          this.diag?.warn("plan", "plan revision or scope changed since review — re-pausing for confirmation");
          if (callbacks.onConfirmThreshold) {
            await waitForReview(() => callbacks.onConfirmThreshold!(plan));
          }
          result.message = this.t("result.pausedForReview");
          return result;
        }
        const savedDigest = this.state.planReviewDigest;
        if (savedDigest && planDigest(plan.items) !== savedDigest) {
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
      if (!skipConfirmation && this.engine.shouldPauseForConfirmation(plan)) {
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
      );
      enterPhase("commit");
      if (this.shouldStop(result, operationEpoch)) return result;

      if (this.state.remoteGeneration !== this.startGeneration) {
        result.message = this.t("result.generationMismatch");
        this.diag?.warn("execute", `generation mismatch after executePlan (${this.startGeneration} → ${this.state.remoteGeneration}), aborting`);
        return result;
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
        if (seededBaseEntries.length > 0) {
          if (this.shouldStop(result, operationEpoch)) return result;
          await this.persistSeededBaseEntries(seededBaseEntries);
        }
        if (this.shouldStop(result, operationEpoch)) return result;
        await this.state.setLastSyncTime(Date.now());
        if (this.shouldStop(result, operationEpoch)) return result;
        await this.state.incrementRemoteGeneration();
      }

      result.success = !result.authExpired
        && !this.cancelled
        && result.errors === 0;
      // Preserve message set by executePlan (e.g. auth expired, cancelled)
      if (!result.message) {
        const resultKey = result.errors > 0
          ? "result.partial"
          : result.deferred > 0
            ? "result.deferred"
            : "result.synced";
        result.message = this.t(resultKey, {
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          deleted: result.deleted,
          conflicts: result.conflicts,
          deferred: result.deferred,
          errors: result.errors,
        });
      }

    } catch (e) {
      if (e instanceof AuthError) {
        this.invalidateLifecycle("auth-expired");
        result.authExpired = true;
        result.message = this.t("result.authExpired");
        result.success = false;
      } else {
        unexpectedFailure = true;
        result.message = this.t("result.syncFailed", { message: e instanceof Error ? e.message : "unknown error" });
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

  /** Execute plan items with per-file persistence */
  private async executePlan(
    plan: SyncPlan,
    result: SyncResult,
    callbacks: SyncCallbacks,
    operationEpoch: number,
    automaticHandlingPolicy: Readonly<AutomaticHandlingPolicy>,
    automaticHandlingMetrics: AutomaticHandlingMetrics,
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
      i.type === SyncActionType.Download || i.type === SyncActionType.RenameRemote;
    const isCleanup = (i: SyncPlanItem) =>
      i.type === SyncActionType.DeleteRemote || i.type === SyncActionType.DeleteLocal;
    const isPassthrough = (i: SyncPlanItem) =>
      !isSmallUpload(i) && !isLargeUpload(i) && !isDownload(i) && !isCleanup(i);

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
    this.diag?.log(
      "execute",
      `pools — small=${smallUploads.length}(${uploadConc}) large=${largeUploads.length}(${largeUploadConc}) download=${downloads.length}(adaptive 1→3 desktop small files) passthrough=${passthroughItems.length} cleanup=${cleanupItems.length}`,
    );

    const executePlanItem = async (
      item: SyncPlanItem,
      preparedDownload?: PreparedDownload,
    ): Promise<void> => {
      if (!this.canContinue(operationEpoch, result)) return;
      const position = ++started;
      this.progressStore?.setProgress(position, total, item.path, item.type);
      callbacks.onProgress?.(position, total, item.path);

      const fileSize = item.local?.size ?? item.remote?.size;
      const localHash = item.local?.hash;
      const remoteETag = item.remote?.eTag;
      const mutationIntent = plan.scope && isFileMutationAction(item.type)
        ? this.createMutationIntent(item, plan.scope)
        : null;
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
          await this.state.commitMutationCheckpoint(mutationIntent.operationId);
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
            callbacks.onFileComplete?.(
              item.path,
              itemResult.completionActionType ?? item.type,
              true,
              itemResult.completionReason,
              fileSize,
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
        }
        if (item.type === SyncActionType.RetryLater) {
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
        }
        callbacks.onFileComplete?.(
          item.path,
          itemResult.completionActionType ?? item.type,
          true,
          itemResult.completionReason,
          fileSize,
        );
      } catch (e) {
        let mutationRecovery: SideMutationRecoveryOutcome | null = null;
        if (mutationIntent && this.state.mutationLedger.some(
          (entry) => entry.intent.operationId === mutationIntent.operationId,
        )) {
          mutationRecovery = await this.reconcileFailedMutation(mutationIntent);
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
          if (isResolvedIssueAction(item.type)) resolvedIssuePaths.add(item.path);
          callbacks.onFileComplete?.(item.path, item.type, true, undefined, fileSize);
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

    // Step 1 — passthrough items (no network I/O)
    for (const item of passthroughItems) {
      if (!this.canContinue(operationEpoch, result)) break;
      await executePlanItem(item);
    }

    // Step 2a — uploads remain serial while every mutation owns one durable
    // intent/receipt checkpoint.
    for (const item of [...smallUploads, ...largeUploads]) {
      if (!this.canContinue(operationEpoch, result)) break;
      await executePlanItem(item);
    }

    // Step 2b — only the read-only network stage of independent desktop small
    // downloads may overlap. Local CAS, temp verification, intent/receipt and
    // checkpoint publication below remain strictly serial per file.
    let downloadIndex = 0;
    while (downloadIndex < downloads.length && this.canContinue(operationEpoch, result)) {
      const first = downloads[downloadIndex];
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

    // Step 3 — serial cleanup (deletes after all uploads/downloads)
    for (const item of cleanupItems) {
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
    if (remoteUpserts.length > 0 || remoteDeletes.length > 0) {
      if (!this.canContinue(operationEpoch, result)) return;
      await this.state.applyRemoteMutations(remoteUpserts, remoteDeletes);
    }
    this.diag?.log(
      "execute",
      `upload summary — files=${result.uploaded}, bytes=${metrics.uploadBytes}, peak=${metrics.peakUploads}/${uploadConc}, readMs=${metrics.uploadReadMs}, networkMs=${metrics.uploadNetworkMs}, elapsedMs=${Date.now() - startedAt}`,
    );

  }

  /** Reconcile every durable mutation record before reading a cursor or planning. */
  private createMutationIntent(item: SyncPlanItem, scope: SyncScope): MutationIntentV1 {
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
    intent: MutationIntentV1,
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
      await this.state.commitMutationCheckpoint(intent.operationId);
      return this.canContinue(operationEpoch);
    } catch (error) {
      if (error instanceof SideMutationNotAppliedError) {
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
      if (recovery === "applied") return this.canContinue(operationEpoch);
      throw error;
    }
  }

  /** Retry the exact checkpoint produced by a completed mutation. */
  private async retrySideMutationCheckpoint(
    intent: MutationIntentV1,
    checkpoint: MutationCheckpointV1,
  ): Promise<boolean> {
    try {
      await this.state.recordMutationReceipt({
        version: 1,
        operationId: intent.operationId,
        completedAt: Date.now(),
        checkpoint,
      });
      await this.state.commitMutationCheckpoint(intent.operationId);
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

  /** Re-read local/remote facts so a failed mutation can settle in the same round. */
  private async reconcileFailedMutation(
    intent: MutationIntentV1,
  ): Promise<SideMutationRecoveryOutcome> {
    try {
      const outcome = await this.classifyUnreceiptedMutation(intent);
      if (outcome === "not-applied") {
        await this.state.abandonMutationIntent(intent.operationId);
        this.diag?.log("execute", `mutation recovery proved not applied — ${intent.path}`);
        return "not-applied";
      }
      if (!outcome) {
        this.diag?.warn("execute", `mutation recovery remains unresolved — ${intent.path}`);
        return "unresolved";
      }
      await this.state.recordMutationReceipt({
        version: 1,
        operationId: intent.operationId,
        completedAt: Date.now(),
        checkpoint: outcome,
      });
      await this.state.commitMutationCheckpoint(intent.operationId);
      this.diag?.warn("execute", `mutation recovered and checkpointed in the same action — ${intent.path}`);
      return "applied";
    } catch (recoveryError) {
      this.diag?.warn(
        "execute",
        `mutation same-action recovery failed — ${intent.path}`,
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      );
      return "unresolved";
    }
  }

  private async recoverMutationLedger(
    syncScope: SyncScope,
    automaticHandlingMetrics?: AutomaticHandlingMetrics,
  ): Promise<void> {
    if (this.state.hasMutationLedgerCorruption) {
      throw new Error("Mutation recovery ledger is corrupt");
    }
    const mergeRecovery = automaticHandlingMetrics?.mergeRecovery;
    for (const record of [...(this.state.mutationLedger ?? [])]) {
      const isAutomaticMerge = record.intent.action === "merge";
      if (isAutomaticMerge && mergeRecovery) mergeRecovery.records++;
      if (!sameSyncScope(record.intent.scope, syncScope)) {
        throw new Error(`Mutation scope no longer matches: ${record.intent.operationId}`);
      }
      if (record.receipt) {
        if (!await this.verifyMutationReceipt(record)) {
          if (isAutomaticMerge && mergeRecovery) mergeRecovery.unresolved++;
          throw new Error(`Mutation receipt no longer matches local/remote facts: ${record.intent.operationId}`);
        }
        await this.state.commitMutationCheckpoint(record.intent.operationId);
        if (isAutomaticMerge) {
          if (mergeRecovery) mergeRecovery.receiptCommitted++;
          await this.getMergeReadyStore().complete(record.intent.operationId);
        }
        continue;
      }

      const outcome = await this.classifyUnreceiptedMutation(record.intent);
      if (outcome === "not-applied") {
        await this.state.abandonMutationIntent(record.intent.operationId);
        if (isAutomaticMerge) {
          if (mergeRecovery) mergeRecovery.notApplied++;
          await this.getMergeReadyStore().complete(record.intent.operationId);
        }
        continue;
      }
      if (!outcome) {
        if (isAutomaticMerge && mergeRecovery) mergeRecovery.unresolved++;
        throw new Error(`Mutation outcome requires manual review: ${record.intent.operationId}`);
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
      await this.state.commitMutationCheckpoint(record.intent.operationId);
      if (isAutomaticMerge) {
        await this.getMergeReadyStore().complete(record.intent.operationId);
      }
    }
  }

  private async verifyMutationReceipt(record: MutationLedgerEntryV1): Promise<boolean> {
    const receipt = record.receipt;
    if (!receipt) return false;
    const intent = record.intent;
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
      return await this.inspectRemotePath(intent.path) === undefined;
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

    // upload
    if (!base || !this.inspectionMatchesVersion(local, base)) return false;
    const remote = await this.inspectRemotePath(intent.path);
    const upsert = receipt.checkpoint.remoteUpserts.find((entry) => entry.path === intent.path);
    return Boolean(upsert && remote
      && remote.driveId === upsert.driveId
      && remote.eTag === upsert.eTag);
  }

  private async classifyUnreceiptedMutation(
    intent: MutationIntentV1,
  ): Promise<"not-applied" | MutationCheckpointV1 | null> {
    const local = await this.inspectLocalPath(intent.path);
    if (local === null || local.status === "uncertain") return null;
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
      (intent.action === "upload"
        || intent.action === "deleteRemote"
        || intent.action === "renameRemote")
      && remoteStillExpected
    ) return "not-applied";
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
      if (!current || !this.localMatchesRemoteHash(local.entry, current)) return null;
      checkpoint.baseUpserts.push(StateManager.toBaseEntry(local.entry, current));
      checkpoint.remoteUpserts.push(current);
      return checkpoint;
    }
    if (intent.action === "download") {
      if (!intent.expectedRemote.exists || local.status !== "present" || !local.entry) return null;
      const current = await this.inspectRemotePath(intent.path);
      if (!this.remoteMatchesExpectation(current, intent.expectedRemote)) return null;
      const expectedHash = intent.expectedRemote.sha256Hash?.toLowerCase();
      if (!expectedHash
        || local.entry.hash !== expectedHash
        || local.entry.size !== intent.expectedRemote.size) return null;
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
      checkpoint.remoteDeletes.push(intent.path);
      checkpoint.pendingDeleteRemovals.push(intent.path);
      return checkpoint;
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

  private inspectionMatchesExpectation(
    current: LocalFileInspection,
    expected: MutationIntentV1["expectedLocal"],
  ): boolean {
    if (!expected.exists) return current.status === "missing";
    return current.status === "present"
      && current.entry?.hash === expected.hash
      && current.entry.size === expected.size;
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
      await adapter.writeBinary(readyPath, payload);
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
    const baseContent = this.state.getBaseContent(item.path);
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
          throw new SideMutationNotAppliedError(`Local version changed before automatic merge: ${item.path}`);
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
        this.state.cacheBaseContent(item.path, merge.mergedBytes);
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
              if (this.localMatchesRemoteHash(item.local, fresh)) {
                const remoteEntry = this.toMetadataRemoteEntry(
                  item.path,
                  fresh,
                  item.remote?.parentId,
                );
                remoteUpserts.push(remoteEntry);
                return {
                  executed: true,
                  baseUpsert: StateManager.toBaseEntry(item.local, remoteEntry),
                };
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
              await this.scanner.vault.adapter.writeBinary(readyPath, content as ArrayBuffer);
              const readyBytes = await this.scanner.vault.adapter.readBinary(readyPath);
              const downloadedHash = downloaded.hash;
              if (
                readyBytes.byteLength !== (content as ArrayBuffer).byteLength
                || await sha256Hex(readyBytes) !== downloadedHash
              ) {
                throw new Error(`Downloaded temp file verification failed: ${item.path}`);
              }
              fileStat = await this.commitDownloadedTempFile(
                this.scanner.vault.adapter as StreamDownloadAdapter,
                item.path,
                readyPath,
                item.local,
                { size: (content as ArrayBuffer).byteLength, hash: downloadedHash },
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
          throw new Error(this.t("notice.decisionExpired"));
        }
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        const remote = await this.onedrive.getFileMetadata(this.vaultName, item.path);
        if (!this.canContinue(operationEpoch, result)) return { executed: false };
        if (remote) throw new Error(this.t("notice.decisionExpired"));

        const current = await this.inspectLocalPath(item.path);
        if (!current || current.status === "uncertain") {
          throw new Error(this.t("notice.localChangedSinceReview"));
        }
        if (current.status === "present" && !this.localExpectationMatches(item.local, current)) {
          throw new Error(this.t("notice.localChangedSinceReview"));
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
          updated = await this.onedrive.renameItem(
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
        remoteDeletes.push(item.renameFrom);
        remoteUpserts.push({
          path: item.path,
          driveId: updated.id,
          parentId: this.requireKnownRemoteParentId(
            item.path,
            updated.parentReference?.id,
            item.remote.parentId,
          ),
          size: updated.size ?? item.local.size,
          mtime: updated.lastModifiedDateTime
            ? new Date(updated.lastModifiedDateTime).getTime()
            : Date.now(),
          eTag: updated.eTag ?? "",
          cTag: updated.cTag ?? "",
          sha256Hash: item.local.hash,
        });
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
      if (local.hash !== entry.hash || local.size !== entry.size) continue;
      if (!remote.sha256Hash
        || remote.sha256Hash.toLowerCase() !== entry.hash.toLowerCase()
        || remote.size !== entry.size) continue;
      seeded.push({
        path,
        hash: entry.hash,
        size: entry.size,
        eTag: remote.eTag,
      });
    }

    return seeded;
  }

  private async persistSeededBaseEntries(entries: BaseFileEntry[]): Promise<void> {
    const merged = new Map<string, BaseFileEntry>();
    for (const entry of entries) {
      merged.set(entry.path, entry);
    }
    for (const entry of this.state.baseSnapshot) {
      merged.set(entry.path, entry);
    }
    await this.state.setBaseSnapshot([...merged.values()]);
  }

  /** Use persisted remote state for incremental delta, rebuilding on failure. */
  private async tryDeltaOrFullScan(
    operationEpoch: number,
    result: SyncResult,
    syncScope: SyncScope,
    localEntries: LocalFileEntry[],
  ): Promise<{ entries: RemoteFileEntry[]; scope: SyncScope }> {
    let currentScope = syncScope;
    let { filesRootId } = currentScope;
    if (this.state.hasRemoteState && this.state.remoteDeltaLink) {
      if (!sameSyncScope(this.state.remoteScope, syncScope)) {
        this.diag?.warn(
          "onedrive",
          "remote cache belongs to a different or incomplete sync scope; rebuilding from known Graph identities",
        );
        const entries = await this.rebuildRemoteStateFromIdentitySnapshot(
          operationEpoch,
          result,
          currentScope,
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
        await this.state.setRemoteState(
          entries,
          delta["@odata.deltaLink"] ?? null,
          currentScope,
          projection.folders,
        );
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
          );
          return { entries, scope: currentScope };
        }
        if (!isDeltaStateInvalid(e)) {
          throw e;
        }
        this.diag?.warn("onedrive", `incremental delta failed (${e instanceof Error ? e.message : "unknown"}), rebuilding remote cache`);
        if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
        this.onedrive.invalidateVaultScope(this.vaultName);
        const refreshedRemoteScope = await this.onedrive.initVaultScope(this.vaultName);
        const refreshedSyncScope: SyncScope = {
          accountId: currentScope.accountId,
          ...refreshedRemoteScope,
        };
        if (
          !sameSyncScope(refreshedSyncScope, currentScope)
          && this.state.mutationLedger.length > 0
        ) {
          throw new Error("Remote scope changed while mutation recovery is unresolved");
        }
        currentScope = refreshedSyncScope;
        this.activeSyncScope = currentScope;
        filesRootId = refreshedSyncScope.filesRootId;
        await this.state.clearRemoteState();
      }
    }

    try {
      const delta = await this.onedrive.getDelta(this.vaultName);
      const projection = this.projectCompleteRemoteSnapshot(delta.value, filesRootId);
      const entries = projection.entries;
      if (!this.canContinue(operationEpoch, result)) return { entries, scope: currentScope };
      await this.state.setRemoteState(
        entries,
        delta["@odata.deltaLink"] ?? null,
        currentScope,
        projection.folders,
      );
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
        await this.state.setRemoteState(entries, null, currentScope, projection.folders);
        this.diag?.log("onedrive", `full scan returned ${items.length} items → ${entries.length} remote entries`);
        return { entries, scope: currentScope };
      } catch (e2) {
        if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
        // Both delta and full scan failed — if NotFound, the vault folder is empty/new
        if (e2 instanceof OneDriveError && e2.type === OneDriveErrorType.NotFound) {
          if (!this.canContinue(operationEpoch, result)) return { entries: [], scope: currentScope };
          await this.state.setRemoteState([], null, currentScope);
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
  ): Promise<RemoteFileEntry[]> {
    const { filesRootId } = syncScope;
    const delta = await this.onedrive.getDelta(this.vaultName);
    const projection = this.projectCompleteRemoteSnapshot(delta.value, filesRootId);
    const entries = projection.entries;
    if (!this.canContinue(operationEpoch, result)) return entries;
    await this.state.setRemoteState(
      entries,
      delta["@odata.deltaLink"] ?? null,
      syncScope,
      projection.folders,
    );
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
        });
        continue;
      }
      if (!this.shouldIncludeRemotePath(path)) continue;
      entries.push(this.toRemoteEntry(item, path, node.parentId));
    }
    this.v2ShadowIdentityInput = {
      remoteItems: [...scopedItems],
      v1RemoteEntries: [...entries],
    };
    return { entries, folders };
  }

  private observeV2ReadOnlyShadow(
    syncScope: SyncScope,
    localEntries: LocalFileEntry[],
    baseEntries: BaseFileEntry[],
    skippedLarge: string[],
    v1Plan: SyncPlan,
  ): void {
    if (!this.diag || !this.v2ShadowIdentityInput) return;
    const report = compareV1WithV2Shadow({
      v1Scope: syncScope,
      v2Scope: { ...syncScope },
      remoteItems: this.v2ShadowIdentityInput.remoteItems,
      v1RemoteEntries: this.v2ShadowIdentityInput.v1RemoteEntries,
      localEntries,
      baseEntries,
      skippedLarge,
      v1Plan,
      includeRemotePath: (path) => this.shouldIncludeRemotePath(path),
    });
    this.diag.log(
      "plan",
      `V2 read-only shadow ${report.status} — remote ${report.remoteCounts.v1}/${report.remoteCounts.v2}, plan ${report.planCounts.v1}/${report.planCounts.v2}, differences=${report.differences.length}`,
      report,
    );
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
        // Graph reports parent folder metadata after a direct child changes.
        // When ID, name and parent still match the committed file cache, the
        // notification carries no logical path change for V1 to apply.
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
      cTag: "",
      sha256Hash: metadata.sha256Hash,
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

  /** Gate check: refuse state-modifying operations while a sync round is in-flight. */
  private acquireGate(op: string): string | null {
    if (this.running || this.sideActionRunning || this.queuedSideActionPaths.size > 0) return "sync";
    return null;
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
    if (this.state.legacyAutoSyncAllowed === false) {
      this.notice("result.legacyStateDisabled");
      return;
    }
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
    if (!this.shouldIncludeRemotePath(path)) {
      await this.state.removePendingConflict(path);
      this.notice("notice.configSyncDisabled", { path });
      return true;
    }
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
        await this.scanner.vault.adapter.writeBinary(readyPath, content);
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
        checkpoint.pendingConflictRemovals.push(path);
        return checkpoint;
      } catch (error) {
        if (error instanceof LocalCommitPreconditionError) {
          this.notice("notice.conflict.failed", {
            path,
            reason: this.t("notice.localChangedSinceReview"),
          });
          throw new SideMutationNotAppliedError(error, true);
        }
        if (error instanceof SideMutationNotAppliedError || targetMutationStarted) throw error;
        throw new SideMutationNotAppliedError(error);
      }
    });
    return committed ? content : null;
  }

  /** Resolve a conflict: keep local version (re-upload) */
  async resolveConflictKeepLocal(path: string): Promise<void> {
    if (this.state.legacyAutoSyncAllowed === false) {
      this.notice("result.legacyStateDisabled");
      return;
    }
    const conflict = this.state.pendingConflicts.find((c) => c.path === path);
    if (await this.expireManagedConfigDecision(path, conflict)) return;
    const actionType = conflict?.remote && !conflict.local
      ? SyncActionType.DeleteRemote
      : SyncActionType.Upload;
    return this.enqueueSideAction(path, actionType, async (operationEpoch) => {
      if (!this.canContinue(operationEpoch)) return;
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
        this.state.cacheBaseContent(path, content);
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
    if (this.state.legacyAutoSyncAllowed === false) {
      this.notice("result.legacyStateDisabled");
      return;
    }
    const conflict = this.state.pendingConflicts.find((c) => c.path === path);
    if (await this.expireManagedConfigDecision(path, conflict)) return;
    const actionType = conflict?.local && !conflict.remote
      ? SyncActionType.ConfirmLocalDelete
      : SyncActionType.Download;
    return this.enqueueSideAction(path, actionType, async (operationEpoch) => {
      if (!this.canContinue(operationEpoch)) return;
      const queuedConflict = this.state.pendingConflicts.find((c) => c.path === path);
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
          this.state.cacheBaseContent(path, content);
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
              throw new SideMutationNotAppliedError(
                new Error("Reviewed download cancelled before local commit"),
              );
            }
            if (!await this.guardReviewedLocalVersion(path, queuedConflict.local, "notice.conflict.failed")) {
              throw new SideMutationNotAppliedError(undefined, true);
            }
            if (!await this.guardReviewedRemoteVersion(queuedConflict, "notice.conflict.failed", "conflict")) {
              throw new SideMutationNotAppliedError(undefined, true);
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
              await this.scanner.vault.adapter.writeBinary(readyPath, content);
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
            checkpoint.pendingConflictRemovals.push(path);
            return checkpoint;
          } catch (error) {
            if (error instanceof SideMutationNotAppliedError || targetMutationStarted) throw error;
            throw new SideMutationNotAppliedError(error);
          }
        });
        if (!committed || !content) return;
        this.state.cacheBaseContent(path, content);
        this.notice("notice.conflict.keptRemote", { path });
        return true;
      } catch (rawError) {
        if (rawError instanceof SideMutationNotAppliedError && rawError.noticeAlreadyShown) return;
        const error = rawError instanceof SideMutationNotAppliedError
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
    const uniquePaths = [...new Set(paths)];
    await Promise.all(uniquePaths.map((path) => this.confirmRemoteDelete(path, false)));
  }

  /** Confirm a remote delete: delete local file */
  async confirmRemoteDelete(path: string, showSuccessNotice = true): Promise<void> {
    if (this.state.legacyAutoSyncAllowed === false) {
      this.notice("result.legacyStateDisabled");
      return;
    }
    return this.enqueueSideAction(path, SyncActionType.DeleteRemote, async (operationEpoch) => {
      const pending = this.state.pendingRemoteDeletes.find((d) => d.path === path);
      try {
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
        this.notice("notice.delete.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
      }
    });
  }

  /** Reject a remote delete: re-upload local file */
  async rejectRemoteDelete(path: string): Promise<void> {
    if (this.state.legacyAutoSyncAllowed === false) {
      this.notice("result.legacyStateDisabled");
      return;
    }
    return this.enqueueSideAction(path, SyncActionType.Upload, async (operationEpoch) => {
      if (!this.canContinue(operationEpoch)) return;
      const pending = this.state.pendingRemoteDeletes.find((d) => d.path === path);
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
        this.notice("notice.delete.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
      }
    });
  }
}

function isPendingIssueAction(type: SyncActionType): boolean {
  return type === SyncActionType.Upload
    || type === SyncActionType.Download
    || type === SyncActionType.DeleteRemote
    || type === SyncActionType.DeleteLocal
    || type === SyncActionType.SkipLargeFile
    || type === SyncActionType.RetryLater;
}

/** Unified auth failure check — covers OneDrive token expiry and AuthModule errors. */
function isAuthFailure(error: unknown): boolean {
  if (error instanceof OneDriveError && error.type === OneDriveErrorType.AuthExpired) return true;
  if (error instanceof AuthError) return true;
  return false;
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
    || type === SyncActionType.DeleteRemote
    || type === SyncActionType.DeleteLocal
    || type === SyncActionType.RenameRemote;
}

function isFileMutationAction(type: SyncActionType): boolean {
  return type === SyncActionType.Upload
    || type === SyncActionType.Download
    || type === SyncActionType.DeleteRemote
    || type === SyncActionType.DeleteLocal
    || type === SyncActionType.RenameRemote;
}

function isDeltaStateInvalid(error: unknown): boolean {
  if (!(error instanceof OneDriveError)) return false;
  return error.statusCode === 410
    || error.type === OneDriveErrorType.NotFound
    || error.graphCode === "resyncRequired"
    || error.graphCode === "syncStateNotFound"
    || error.graphCode === "invalidSyncState";
}

/** Match OneDrive's case-insensitive namespace while preserving display paths. */
function normalizeRemotePathKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
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
