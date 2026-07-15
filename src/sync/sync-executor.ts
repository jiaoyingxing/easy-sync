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

import { Notice, Platform, type DataAdapter, type FileManager } from "obsidian";
import { compatSetTimeout, getConfigDir, getEasySyncPaths } from "../obsidian-compat";
import { OneDriveError, OneDriveErrorType } from "../onedrive/types";
import type { DriveItem, UploadResult } from "../onedrive/types";
import { AuthError } from "../auth/types";
import { SyncActionType, planDigest } from "./types";
import type { OneDriveClient } from "../onedrive/client";
import { fullHash, isEasySyncInternalPath } from "./local-scanner";
import type { LocalScanner } from "./local-scanner";
import { remoteContentMatchesBase } from "./sync-engine";
import type { SyncEngine } from "./sync-engine";
import { StateManager } from "./state-manager";
import type { PendingIssue } from "./state-manager";
import { threeWayMerge } from "./merge-engine";
import { isTextFile } from "./base-content-cache";
import type {
  BaseFileEntry,
  CloudBaseline,
  LocalFileEntry,
  RemoteFileEntry,
  SyncPlan,
  SyncPlanItem,
} from "./types";
import type { DiagnosticLogger } from "./diagnostic-logger";
import type { I18n } from "../i18n/index";
import type { SyncProgressStore } from "./sync-progress";

/** Result of a sync run */
export interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
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
  baseUpsert?: BaseFileEntry;
  baseRemoval?: string;
}

/** Sync run mode */
export type SyncMode = "manual" | "auto" | "first";

type StreamDownloadAdapter = DataAdapter & {
  appendBinary: (normalizedPath: string, data: ArrayBuffer) => Promise<void>;
  rename: (normalizedPath: string, normalizedNewPath: string) => Promise<void>;
};

const SMALL_UPLOAD_CONCURRENCY = 5;
const CONCURRENT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const LARGE_UPLOAD_CONCURRENCY = 2;
const DOWNLOAD_CONCURRENCY = 1;  // serial — slow connections need full bandwidth per file

const MOBILE_SMALL_UPLOAD_CONCURRENCY = 2;
const MOBILE_LARGE_UPLOAD_CONCURRENCY = 1;
const MOBILE_DOWNLOAD_CONCURRENCY = 1;  // serial — consistent with desktop: slow connections need full bandwidth
const MOBILE_STREAM_DOWNLOAD_MIN_BYTES = 8 * 1024 * 1024;

interface ExecutionMetrics {
  uploadBytes: number;
  uploadReadMs: number;
  uploadNetworkMs: number;
  uploadCheckpointMs: number;
  activeUploads: number;
  peakUploads: number;
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
  private cancelled = false;
  private cancelController: AbortController | null = null;
  private startGeneration = 0;

  constructor(
    private onedrive: OneDriveClient,
    private scanner: LocalScanner,
    private engine: SyncEngine,
    private state: StateManager,
    private vaultName: string,
    private i18n?: I18n,
    private progressStore?: SyncProgressStore,
    private diag?: DiagnosticLogger,
    private autoMerge = true,
    private fileManager?: FileManager,
  ) {}

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n?.t(key, params) ?? key;
  }

  /** Show a translated notice to the user */
  private notice(key: string, params?: Record<string, string | number>): void {
    new Notice(this.t(key, params));
  }

  get isRunning(): boolean {
    return this.running;
  }

  cancel(): void {
    this.cancelled = true;
    this.cancelController?.abort();
  }

  private markCancelled(result: SyncResult): void {
    result.message = this.t("result.cancelled");
  }

  private shouldStop(result: SyncResult): boolean {
    if (!this.cancelled) return false;
    this.markCancelled(result);
    return true;
  }

  private localMatchesRemoteHash(
    local: Pick<LocalFileEntry, "hash" | "size">,
    remote: { sha256Hash?: string; size: number },
  ): boolean {
    return Boolean(
      remote.sha256Hash
      && local.size === remote.size
      && local.hash === remote.sha256Hash.toLowerCase(),
    );
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

  private async removePathIfExists(path: string): Promise<void> {
    try { await this.scanner.vault.adapter.remove(path); } catch { /* noop */ }
  }

  private async commitDownloadedTempFile(
    adapter: StreamDownloadAdapter,
    targetPath: string,
    tempPath: string,
  ): Promise<{ size: number; mtime?: number } | null> {
    const recoveryPath = `${targetPath}.easy-sync-recovery`;
    const existing = await adapter.stat(targetPath);
    await this.removePathIfExists(recoveryPath);
    if (existing) {
      await adapter.rename(targetPath, recoveryPath);
    }
    try {
      await adapter.rename(tempPath, targetPath);
      const stat = await adapter.stat(targetPath);
      if (existing) {
        await this.removePathIfExists(recoveryPath);
      }
      return stat ? { size: stat.size, mtime: stat.mtime } : null;
    } catch (error) {
      await this.removePathIfExists(targetPath);
      if (existing) {
        try {
          await adapter.rename(recoveryPath, targetPath);
        } catch {
          try {
            const recoveryBytes = await adapter.readBinary(recoveryPath);
            await adapter.writeBinary(targetPath, recoveryBytes);
          } catch { /* best-effort */ }
          await this.removePathIfExists(recoveryPath);
        }
      }
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
  async run(mode: SyncMode, callbacks: SyncCallbacks = {}, skipConfirmation = false): Promise<SyncResult> {
    if (this.running) {
      return { success: false, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skippedLarge: 0, skippedIgnored: 0, errors: 0, authExpired: false, message: this.t("result.alreadyRunning") };
    }

    this.running = true;
    this.cancelled = false;
    this.cancelController = new AbortController();
    this.startGeneration = this.state.remoteGeneration;
    this.onedrive.resetDownloadStrategy();
    this.onedrive.setAbortSignal(this.cancelController.signal);

    const result: SyncResult = {
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skippedLarge: 0,
      skippedIgnored: 0,
      errors: 0,
      authExpired: false,
      message: "",
    };

    try {
      // Step 1: Scan local files
      this.progressStore?.setPhase("scanning");
      callbacks.onProgress?.(0, 1, this.t("progress.scanningLocal"));
      const { entries: localEntries, skippedLarge, failedPaths } = await this.scanner.scanAll();
      result.skippedLarge = skippedLarge.length;
      if (this.shouldStop(result)) return result;

      // Step 1.5: Resolve and initialize the remote vault directory.
      this.progressStore?.setPhase("preparing");
      callbacks.onProgress?.(0, 1, this.t("progress.preparingRemote"));
      await this.onedrive.initVaultDirectories(this.vaultName);
      if (this.shouldStop(result)) return result;
      if (
        this.state.remoteDeltaLink
        && !this.onedrive.isDeltaLinkForVault(
          this.vaultName,
          this.state.remoteDeltaLink,
        )
      ) {
        this.diag?.warn("onedrive", "remote delta cache belongs to a different vault directory, rebuilding");
        await this.state.clearRemoteState();
      }

      // Step 2: Bootstrap cloud baseline on new devices.
      // If local baseSnapshot is empty (fresh install / new device), try to
      // download the cloud baseline from .easy-sync/baseline.json. The cloud
      // baseline is only safe as a hint for paths that currently exist on both
      // sides; remote-only paths must still download instead of being treated
      // as local deletions.
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
      if (this.shouldStop(result)) return result;

      // Step 3: Get remote file list (delta or full scan)
      this.progressStore?.setPhase("checking");
      callbacks.onProgress?.(0, 1, this.t("progress.checkingRemote"));
      let remoteEntries = await this.tryDeltaOrFullScan();
      if (this.shouldStop(result)) return result;

      if (this.state.remoteGeneration !== this.startGeneration) {
        result.message = this.t("result.generationMismatch");
        this.diag?.warn("execute", `generation mismatch after delta scan (${this.startGeneration} → ${this.state.remoteGeneration}), aborting`);
        return result;
      }

      // Step 4: Load base snapshot
      let baseEntries = this.state.baseSnapshot;
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
        await this.state.upsertBaseEntries(eTagUpdates);
        const updatedByPath = new Map(eTagUpdates.map((entry) => [entry.path, entry]));
        baseEntries = baseEntries.map((entry) => updatedByPath.get(entry.path) ?? entry);
        this.diag?.log("state", `reconciled ${eTagUpdates.length} unchanged remote eTag(s)`);
      }
      if (this.shouldStop(result)) return result;

      // Step 5: Generate sync plan
      this.progressStore?.setPhase("planning");
      callbacks.onProgress?.(0, 1, this.t("progress.generatingPlan"));
      const plan = this.engine.generatePlan(
        localEntries,
        remoteEntries,
        baseEntries,
        skippedLarge,
      );
      this.diag?.log("plan", `plan generated — ${plan.items.length} actions (up/down/del/conflict: ${plan.items.filter(i=>i.type===SyncActionType.Upload).length}/${plan.items.filter(i=>i.type===SyncActionType.Download).length}/${plan.items.filter(i=>i.type===SyncActionType.Conflict).length})`);

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

      // Step 5.5: Scan health check — if any file failed to read,
      // destructive actions (DeleteRemote, ConfirmLocalDelete) are unsafe
      // because a read failure looks like a missing file to the engine.
      if (failedPaths.length > 0) {
        this.diag?.warn("scan", `scan unhealthy — ${failedPaths.length} file(s) failed to read, blocking destructive actions. Failed: ${failedPaths.slice(0, 5).join(', ')}`);
        for (const item of plan.items) {
          if (item.type === SyncActionType.DeleteRemote || item.type === SyncActionType.ConfirmLocalDelete) {
            item.type = SyncActionType.RetryLater;
            item.reason = "reason.scanUnhealthy";
          }
        }
      }

      // Step 5.6: Content hash dedup — for files that appear on both sides
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
        const isBootstrap = seededBaseEntries.length === 0;
        const pendingByPath = new Map(
          this.state.pendingConflicts.map((item) => [item.path, item]),
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
          return Boolean(item.remote.sha256Hash)
            || pending?.local?.hash !== item.local.hash
            || pending.remote?.eTag !== item.remote.eTag;
        });
        const metadataCandidates = candidates.filter((item) => item.remote?.sha256Hash);
        const maxDownloads = isBootstrap
          ? candidates.length
          : MAX_HASH_DEDUP_FILES;
        const downloadCandidates = candidates
          .filter((item) => !item.remote?.sha256Hash)
          .slice(0, maxDownloads);
        const selectedCandidates = [...metadataCandidates, ...downloadCandidates];
        const dedupTotal = selectedCandidates.length;

        if (candidates.length > 0) {
          this.progressStore?.setPhase("verifying");
          this.diag?.log(
            "plan",
            `hash dedup${isBootstrap ? " (bootstrap)" : ""} — ${metadataCandidates.length} metadata hash candidate(s), ${downloadCandidates.length}/${candidates.length - metadataCandidates.length} download candidate(s)`,
          );
        }

        const falseConflicts = new Set<string>();
        const matchedBaseEntries: BaseFileEntry[] = [];
        let dedupCount = 0;

        for (const item of selectedCandidates) {
          if (this.shouldStop(result)) return result;
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
            if (remote.sha256Hash) {
              if (local.hash === remote.sha256Hash) {
                this.diag?.log("plan", `hash dedup MATCH — ${item.path} identical on both sides via remote sha256`);
                matchedBaseEntries.push({
                  path: item.path,
                  hash: local.hash,
                  size: local.size,
                  eTag: remote.eTag,
                });
                falseConflicts.add(item.path);
                continue;
              }
              this.diag?.log("plan", `hash dedup MISMATCH — ${item.path} remote sha256 differs from local hash`);
              continue;
            }
            const remoteContent = await this.onedrive.downloadFile(
              this.vaultName,
              item.path,
              remote.downloadUrl,
              remote.driveId,
              remote.size,
            );
            const remoteHash = await fullHash(remoteContent);
            if (local.hash === remoteHash) {
              this.diag?.log("plan", `hash dedup MATCH — ${item.path} identical on both sides`);
              matchedBaseEntries.push({
                path: item.path,
                hash: local.hash,
                size: local.size,
                eTag: remote.eTag,
              });
              falseConflicts.add(item.path);
            } else {
              this.diag?.log("plan", `hash dedup MISMATCH — ${item.path} content differs`);
            }
          } catch (e) {
            this.diag?.warn("plan", `hash dedup skipped ${item.path} — download failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (matchedBaseEntries.length > 0) {
          await this.state.upsertBaseEntries(matchedBaseEntries);
        }

        const skippedDownloadCandidates = candidates.length
          - metadataCandidates.length
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

      if (failedPaths.length === 0) {
        await this.state.prunePendingConflicts(
          plan.items
            .filter((item) => item.type === SyncActionType.Conflict)
            .map((item) => item.path),
        );
        await this.state.prunePendingDeletes(
          plan.items
            .filter((item) => item.type === SyncActionType.ConfirmLocalDelete)
            .map((item) => item.path),
        );
        await this.state.prunePendingIssues(
          plan.items
            .filter((item) => isPendingIssueAction(item.type))
            .map((item) => item.path),
        );
      }

      // If the user is executing a reviewed plan, verify the digest after all
      // pre-execution rewrites (scan health, dedup, pending pruning). The
      // reviewed bundle stays in state until this point so stale plans re-pause.
      if (skipConfirmation && this.state.planReviewActive) {
        const savedDigest = this.state.planReviewDigest;
        if (savedDigest && planDigest(plan.items) !== savedDigest) {
          this.diag?.warn("plan", "plan changed since review — re-pausing for confirmation");
          const confirmed = callbacks.onConfirmThreshold
            ? await callbacks.onConfirmThreshold(plan)
            : false;
          if (!confirmed) {
            result.message = this.t("result.pausedForReview");
            return result;
          }
        }
        await this.state.clearPlanReview();
      }

      // Step 6: Threshold check (skip if user is confirming a reviewed plan)
      if (!skipConfirmation && this.engine.shouldPauseForConfirmation(plan)) {
        if (callbacks.onConfirmThreshold) {
          const confirmed = await callbacks.onConfirmThreshold(plan);
          if (!confirmed) {
            result.message = this.t("result.pausedForReview");
            return result;
          }
        }
        plan.confirmed = true;
      }

      // Step 7: First sync preview (skip if user is confirming a reviewed plan)
      if (!skipConfirmation && mode === "first") {
        if (callbacks.onFirstSyncPreview) {
          const confirmed = await callbacks.onFirstSyncPreview(plan);
          if (!confirmed) {
            result.message = this.t("result.pausedForReview");
            return result;
          }
        }
        plan.confirmed = true;
      }

      // Step 8: Execute plan items
      this.progressStore?.setPhase("executing");
      await this.executePlan(plan, result, callbacks);
      if (this.shouldStop(result)) return result;

      if (this.state.remoteGeneration !== this.startGeneration) {
        result.message = this.t("result.generationMismatch");
        this.diag?.warn("execute", `generation mismatch after executePlan (${this.startGeneration} → ${this.state.remoteGeneration}), aborting`);
        return result;
      }

      // Step 9: Mark healthy sync — only when no conflicts, pending deletes,
      // errors, skipped files, or auth issues remain.
      const isHealthy = !result.authExpired
        && !this.cancelled
        && result.errors === 0
        && result.conflicts === 0
        && result.skippedLarge === 0
        && result.skippedIgnored === 0;
      if (isHealthy) {
        if (seededBaseEntries.length > 0) {
          await this.persistSeededBaseEntries(seededBaseEntries);
        }
        await this.state.setLastSyncTime(Date.now());
        await this.state.incrementRemoteGeneration();
      }

      // Step 9.5: Upload cloud baseline — only when sync is fully healthy.
      // Partial successes must not be used as bootstrap data for new devices.
      if (isHealthy && this.state.needsCloudBaselineUpload) {
        try {
          const baseline: CloudBaseline = {
            vaultName: this.vaultName,
            lastSyncAt: this.state.lastSyncTime,
            files: {},
          };
          for (const entry of this.state.baseSnapshot) {
            baseline.files[entry.path] = {
              hash: entry.hash,
              size: entry.size,
              eTag: entry.eTag,
              mtime: 0, // mtime is device-local, not meaningful cross-device
            };
          }
          const json = JSON.stringify(baseline);
          await this.onedrive.uploadBaseline(this.vaultName, json);
          await this.state.markCloudBaselineSynced();
        } catch (e) {
          // Cloud baseline upload is best-effort — don't block sync result
          this.diag?.warn("state", "failed to upload cloud baseline", e);
        }
      }

      result.success = !result.authExpired
        && !this.cancelled
        && result.errors === 0;
      // Preserve message set by executePlan (e.g. auth expired, cancelled)
      if (!result.message) {
        result.message = this.t(result.errors > 0 ? "result.partial" : "result.synced", {
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          deleted: result.deleted,
          conflicts: result.conflicts,
          errors: result.errors,
        });
      }

    } catch (e) {
      if (e instanceof AuthError) {
        result.authExpired = true;
        result.message = this.t("result.authExpired");
        result.success = false;
      } else {
        result.message = this.t("result.syncFailed", { message: e instanceof Error ? e.message : "unknown error" });
      }
    } finally {
      this.onedrive.setAbortSignal(null);
      this.cancelController = null;
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
      uploadCheckpointMs: 0,
      activeUploads: 0,
      peakUploads: 0,
    };
    const isSmallUpload = (i: SyncPlanItem) =>
      i.type === SyncActionType.Upload && Boolean(i.local)
      && i.local!.size <= CONCURRENT_UPLOAD_MAX_BYTES;
    const isLargeUpload = (i: SyncPlanItem) =>
      i.type === SyncActionType.Upload && Boolean(i.local)
      && i.local!.size > CONCURRENT_UPLOAD_MAX_BYTES;
    const isDownload = (i: SyncPlanItem) =>
      i.type === SyncActionType.Download || i.type === SyncActionType.RenameRemote;
    const isCleanup = (i: SyncPlanItem) =>
      i.type === SyncActionType.DeleteRemote;
    const isPassthrough = (i: SyncPlanItem) =>
      !isSmallUpload(i) && !isLargeUpload(i) && !isDownload(i) && !isCleanup(i);

    const smallUploads   = plan.items.filter(isSmallUpload);
    const largeUploads   = plan.items.filter(isLargeUpload);
    const downloads      = plan.items.filter(isDownload);
    const cleanupItems   = plan.items.filter(isCleanup);
    const passthroughItems = plan.items.filter(isPassthrough);

    // Effective concurrency — cap lower on mobile to avoid memory-pressure kills
    const uploadConc = Platform.isMobile ? MOBILE_SMALL_UPLOAD_CONCURRENCY : SMALL_UPLOAD_CONCURRENCY;
    const largeUploadConc = Platform.isMobile ? MOBILE_LARGE_UPLOAD_CONCURRENCY : LARGE_UPLOAD_CONCURRENCY;
    const downloadConc = Platform.isMobile ? MOBILE_DOWNLOAD_CONCURRENCY : DOWNLOAD_CONCURRENCY;

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
      `pools — small=${smallUploads.length}(${uploadConc}) large=${largeUploads.length}(${largeUploadConc}) download=${downloads.length}(${downloadConc}) passthrough=${passthroughItems.length} cleanup=${cleanupItems.length}`,
    );

    const executePlanItem = async (item: SyncPlanItem): Promise<void> => {
      if (this.cancelled || result.authExpired) return;
      const position = ++started;
      this.progressStore?.setProgress(position, total, item.path, item.type);
      callbacks.onProgress?.(position, total, item.path);

      const fileSize = item.local?.size ?? item.remote?.size;
      const localHash = item.local?.hash;
      const remoteETag = item.remote?.eTag;

      try {
        this.diag?.log("execute", `[${position}/${total}] ${item.type} ${item.path}`);
        const itemResult = await this.executeItem(
          item,
          result,
          remoteUpserts,
          remoteDeletes,
          metrics,
          callbacks,
        );
        if (!itemResult.executed) return;
        // P1-a: collect deferred base entry updates for batch persistence
        if (itemResult.baseUpsert) baseUpserts.push(itemResult.baseUpsert);
        if (itemResult.baseRemoval) baseRemovals.push(itemResult.baseRemoval);
        if (item.type === SyncActionType.Conflict) {
          pendingConflicts.push(item);
        } else if (item.type === SyncActionType.ConfirmLocalDelete) {
          pendingDeletes.push(item);
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
        callbacks.onFileComplete?.(item.path, item.type, true, undefined, fileSize);
      } catch (e) {
        if (this.cancelled && !result.authExpired) {
          this.diag?.log("execute", `[${position}/${total}] ${item.type} ${item.path} aborted after cancellation`);
          return;
        }
        this.diag?.error("execute", `[${position}/${total}] ${item.type} ${item.path} FAILED: ${e instanceof Error ? e.message : String(e)}`, errorDiagData(e));
        // Auth failure at any file stops the entire pool immediately —
        // no point letting other workers continue with a dead token.
        if (isAuthFailure(e)) {
          result.authExpired = true;
          result.message = this.t("result.authExpired");
          this.cancelled = true;
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
      }
    };

    // Step 1 — passthrough items (no network I/O)
    for (const item of passthroughItems) {
      if (this.cancelled || result.authExpired) break;
      await executePlanItem(item);
    }

    // Step 2 — three concurrent pools
    const makePool = (items: SyncPlanItem[], n: number): Promise<void> => {
      if (items.length === 0) return Promise.resolve();
      let idx = 0;
      return Promise.all(
        Array.from({ length: Math.min(n, items.length) }, async () => {
          while (!this.cancelled && !result.authExpired) {
            const i = idx++;
            if (i >= items.length) return;
            await executePlanItem(items[i]);
          }
        }),
      ).then(() => undefined);
    };

    await Promise.all([
      makePool(smallUploads, uploadConc),
      makePool(largeUploads, largeUploadConc),
      makePool(downloads, downloadConc),
    ]);

    // Step 3 — serial cleanup (deletes after all uploads/downloads)
    for (const item of cleanupItems) {
      if (this.cancelled || result.authExpired) break;
      await executePlanItem(item);
    }

    if (this.cancelled) {
      this.diag?.log("execute", `sync cancelled after starting ${started}/${total} item(s)`);
      result.message = this.t("result.cancelled");
    }

    // P1-a: batch persist base entry updates (deferred from per-file calls)
    if (baseUpserts.length > 0) {
      await this.state.upsertBaseEntries(baseUpserts);
    }
    if (baseRemovals.length > 0) {
      await this.state.removeBaseEntries(baseRemovals);
    }

    if (pendingConflicts.length > 0) {
      await this.state.upsertPendingConflicts(pendingConflicts);
    }
    if (pendingDeletes.length > 0) {
      await this.state.upsertPendingDeletes(pendingDeletes);
    }
    await this.state.reconcilePendingIssues(pendingIssues, resolvedIssuePaths);
    if (remoteUpserts.length > 0 || remoteDeletes.length > 0) {
      await this.state.applyRemoteMutations(remoteUpserts, remoteDeletes);
    }
    this.diag?.log(
      "execute",
      `upload summary — files=${result.uploaded}, bytes=${metrics.uploadBytes}, peak=${metrics.peakUploads}/${uploadConc}, readMs=${metrics.uploadReadMs}, networkMs=${metrics.uploadNetworkMs}, checkpointMs=${metrics.uploadCheckpointMs}, elapsedMs=${Date.now() - startedAt}`,
    );

    result.metrics = metrics;
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
        case OneDriveErrorType.AuthExpired:
          return this.t("syncView.failure.authExpired");
        default:
          return this.t("syncView.failure.remote");
      }
    }
    return this.t("syncView.failure.local");
  }

  private async queuePendingConflict(
    item: SyncPlanItem,
    result: SyncResult,
  ): Promise<ItemExecutionResult> {
    await this.state.addPendingConflict(item);
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
  ): Promise<ItemExecutionResult> {
    switch (item.type) {
      case SyncActionType.Upload: {
        if (!item.local) break;
        const readStartedAt = Date.now();
        const content = await this.scanner.vault.adapter.readBinary(item.path);
        metrics.uploadReadMs += Date.now() - readStartedAt;
        if (this.cancelled || result.authExpired) return { executed: false };

        // Re-check hash — file may have changed since scan.
        // If hash differs, skip this round; the change will be picked up next sync.
        const actualHash = await fullHash(content);
        if (actualHash !== item.local.hash) {
          this.diag?.warn("execute", `upload skipped — ${item.path} hash changed since scan (${item.local.hash.slice(0, 8)}… → ${actualHash.slice(0, 8)}…)`);
          throw new Error(`Local file changed since scan: ${item.path}`);
        }

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
          );
          metrics.uploadNetworkMs += Date.now() - uploadStartedAt;
        } catch (e) {
          metrics.uploadNetworkMs += Date.now() - uploadStartedAt;
          if (
            e instanceof OneDriveError
            && e.type === OneDriveErrorType.PreconditionFailed
          ) {
            // Another device changed this file since we scanned remote.
            // Fetch current remote state and route to conflict.
            const fresh = await this.onedrive.getFileMetadata(
              this.vaultName,
              item.path,
            );
            if (fresh) {
              metrics.activeUploads--;
              if (this.localMatchesRemoteHash(item.local, fresh)) {
                const remoteEntry: RemoteFileEntry = {
                  path: item.path,
                  driveId: fresh.driveId,
                  downloadUrl: fresh.downloadUrl,
                  size: fresh.size,
                  mtime: fresh.mtime,
                  eTag: fresh.eTag,
                  cTag: "",
                  sha256Hash: fresh.sha256Hash,
                };
                remoteUpserts.push(remoteEntry);
                return {
                  executed: true,
                  baseUpsert: StateManager.toBaseEntry(item.local, remoteEntry),
                };
              }
              const remoteEntry: RemoteFileEntry = {
                path: item.path,
                driveId: fresh.driveId,
                downloadUrl: fresh.downloadUrl,
                size: fresh.size,
                mtime: fresh.mtime,
                eTag: fresh.eTag,
                cTag: "",
                sha256Hash: fresh.sha256Hash,
              };
              remoteUpserts.push(remoteEntry);
              return this.queuePendingConflict({
                type: SyncActionType.Conflict,
                path: item.path,
                local: item.local,
                remote: remoteEntry,
                reason: "reason.bothSidesModified",
              }, result);
            }
            // File was deleted remotely — re-upload without If-Match
            const retryStartedAt = Date.now();
            uploadResult = await this.onedrive.uploadFile(
              this.vaultName,
              item.path,
              content,
              callbacks.onFileProgress,
            );
            metrics.uploadNetworkMs += Date.now() - retryStartedAt;
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
        ));
        result.uploaded++;
        this.state.cacheBaseContent(item.path, content);
        return { executed: true, baseUpsert };
      }

      case SyncActionType.Download: {
        if (!item.remote) break;
        const streamAdapter = this.getStreamDownloadAdapter(item.remote.size);
        const tempDownloadPath = streamAdapter ? this.getDownloadTempPath(item.path) : null;
        let streamedDownload: { size: number; hash: string } | null = null;
        let content: ArrayBuffer | null = null;
        if (streamAdapter && tempDownloadPath) {
          await this.ensureParentDirs(tempDownloadPath);
          this.diag?.log("execute", `download streaming to temp file — ${item.path}`);
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
        } else {
          content = await this.onedrive.downloadFile(
            this.vaultName,
            item.path,
            item.remote.downloadUrl,
            item.remote.driveId,
            item.remote.size,
            callbacks.onFileProgress,
          );
        }
        if (this.cancelled || result.authExpired) {
          if (tempDownloadPath) {
            await this.removePathIfExists(tempDownloadPath);
          }
          return { executed: false };
        }
        // Ensure all parent directories exist (recursive)
        await this.ensureParentDirs(item.path);
        // Verify local file hasn't changed since scan before overwriting.
        // If the local file was modified after the scan, route to conflict
        // instead of silently overwriting the user's changes.
        if (item.local) {
          let currentContent: ArrayBuffer | null = null;
          try { currentContent = await this.scanner.vault.adapter.readBinary(item.path); } catch { /* file doesn't exist yet */ }
          if (currentContent) {
            const currentHash = await fullHash(currentContent);
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
              }, result);
            }
          }
        }
        let fileStat: { size: number; mtime?: number } | null = null;
        if (streamAdapter && tempDownloadPath && streamedDownload) {
          try {
            fileStat = await this.commitDownloadedTempFile(streamAdapter, item.path, tempDownloadPath);
          } catch (writeErr) {
            this.diag?.warn("execute", `streamed download commit failed for ${item.path}, recovery attempted`, writeErr instanceof Error ? writeErr.message : String(writeErr));
            throw writeErr;
          }
        } else {
          // Safe write: save recovery copy before overwriting, then verify
          // file exists on disk. Recovery is best-effort (Obsidian lacks
          // atomic cross-platform binary replace).
          const recoveryPath = `${item.path}.easy-sync-recovery`;
          let hadRecovery = false;
          try {
            try {
              const oldContent = await this.scanner.vault.adapter.readBinary(item.path);
              await this.scanner.vault.adapter.writeBinary(recoveryPath, oldContent);
              hadRecovery = true;
            } catch { /* file doesn't exist yet — nothing to recover */ }

            await this.scanner.vault.adapter.writeBinary(item.path, content as ArrayBuffer);

            fileStat = await this.scanner.vault.adapter.stat(item.path);

            if (hadRecovery) {
              try { await this.scanner.vault.adapter.remove(recoveryPath); } catch { /* best-effort */ }
            }
          } catch (writeErr) {
            if (hadRecovery) {
              try { await this.scanner.vault.adapter.writeBinary(item.path, await this.scanner.vault.adapter.readBinary(recoveryPath)); } catch { /* best-effort */ }
              try { await this.scanner.vault.adapter.remove(recoveryPath); } catch { /* best-effort */ }
            }
            this.diag?.warn("execute", `download write failed for ${item.path}, recovery attempted`, writeErr instanceof Error ? writeErr.message : String(writeErr));
            throw writeErr;
          }
        }

        const hash = streamedDownload?.hash ?? await fullHash(content as ArrayBuffer);
        result.downloaded++;
        if (content) {
          this.state.cacheBaseContent(item.path, content);
        }
        return {
          executed: true,
          baseUpsert: {
            path: item.path,
            hash,
            size: fileStat?.size ?? streamedDownload?.size ?? (content as ArrayBuffer).byteLength,
            eTag: item.remote.eTag,
          },
        };
      }

      case SyncActionType.DeleteRemote: {
        try {
          await this.onedrive.deleteItem(this.vaultName, item.path, item.remote?.eTag);
        } catch (e) {
          if (e instanceof OneDriveError && e.type === OneDriveErrorType.PreconditionFailed) {
            // File was modified remotely since plan — route to conflict
            this.diag?.warn("execute", `delete blocked — ${item.path} eTag changed since plan`);
            const fresh = await this.onedrive.getFileMetadata(
              this.vaultName,
              item.path,
            );
            if (!fresh) {
              remoteDeletes.push(item.path);
              result.deleted++;
              return { executed: true, baseRemoval: item.path };
            }
            const remoteEntry: RemoteFileEntry = {
              path: item.path,
              driveId: fresh.driveId,
              downloadUrl: fresh.downloadUrl,
              size: fresh.size,
              mtime: fresh.mtime,
              eTag: fresh.eTag,
              cTag: "",
              sha256Hash: fresh.sha256Hash,
            };
            remoteUpserts.push(remoteEntry);
            return this.queuePendingConflict({
              type: SyncActionType.Conflict,
              path: item.path,
              remote: remoteEntry,
              reason: "reason.localDeletedRemoteModified",
            }, result);
          }
          throw e;
        }
        remoteDeletes.push(item.path);
        result.deleted++;
        return { executed: true, baseRemoval: item.path };
      }

      case SyncActionType.RenameRemote: {
        if (!item.renameFrom || !item.local) return { executed: false };
        const updated = await this.onedrive.renameItem(
          this.vaultName,
          item.renameFrom,
          item.path,
        );
        // Defer persistent base removal and upsert to batch flush in caller.
        // Caller will see baseRemoval + baseUpsert and do both after pool drain.
        // Update remote state: old path removed, new path added
        remoteDeletes.push(item.renameFrom);
        remoteUpserts.push({
          path: item.path,
          driveId: updated.id,
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
        // Attempt three-way merge for text files with cached base content
        if (this.autoMerge && item.local && item.remote && isTextFile(item.path)) {
          const baseContent = this.state.getBaseContent(item.path);
          if (baseContent) {
            try {
              const localRaw = await this.scanner.vault.adapter.readBinary(item.path);
              const localContent = new TextDecoder().decode(localRaw);
              const remoteRaw = await this.onedrive.downloadFile(
                this.vaultName,
                item.path,
                item.remote.downloadUrl,
                item.remote.driveId,
                item.remote.size,
              );
              const remoteContent = new TextDecoder().decode(remoteRaw);
              const mergeResult = threeWayMerge(baseContent, localContent, remoteContent);

              if (!mergeResult.hasConflicts) {
                // Clean merge — write merged result locally and upload
                const mergedBytes = new TextEncoder().encode(mergeResult.merged).buffer;
                await this.scanner.vault.adapter.writeBinary(item.path, mergedBytes);
                const hash = await fullHash(mergedBytes);
                const uploadResult = await this.onedrive.uploadFile(
                  this.vaultName,
                  item.path,
                  mergedBytes,
                  undefined,
                  item.baseEtag,
                );
                this.state.cacheBaseContent(item.path, mergeResult.merged);
                new Notice(this.t("syncView.merge.autoMerged", { path: item.path }));
                result.uploaded++;
                return {
                  executed: true,
                  baseUpsert: {
                    path: item.path,
                    hash,
                    size: mergedBytes.byteLength,
                    eTag: uploadResult.eTag ?? "",
                  },
                };
              }

              // Merge had conflicts — attach result for diff UI
              item.mergedContent = mergeResult.merged;
              item.hasMergeConflicts = true;
            } catch {
              if (this.cancelled || result.authExpired) return { executed: false };
              // Network/I/O error — fall through to normal conflict routing
            }
          }
        }

        // Route to pending — user must resolve
        result.conflicts++;
        return { executed: true };
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

    if (!baseline.files || typeof baseline.files !== "object") {
      return [];
    }

    const localPaths = new Set(localEntries.map((entry) => entry.path));
    const remotePaths = new Set(remoteEntries.map((entry) => entry.path));
    const seeded: BaseFileEntry[] = [];

    for (const [path, entry] of Object.entries(baseline.files)) {
      if (!localPaths.has(path) || !remotePaths.has(path)) {
        continue;
      }
      seeded.push({
        path,
        hash: entry.hash,
        size: entry.size,
        eTag: entry.eTag,
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
  private async tryDeltaOrFullScan(): Promise<RemoteFileEntry[]> {
    if (this.state.hasRemoteState && this.state.remoteDeltaLink) {
      try {
        const delta = await this.onedrive.getDelta(
          this.vaultName,
          this.state.remoteDeltaLink,
        );
        const entries = this.applyRemoteDelta(
          this.state.remoteSnapshot,
          delta.value,
        );
        await this.state.setRemoteState(
          entries,
          delta["@odata.deltaLink"] ?? null,
        );
        this.diag?.log("onedrive", `incremental delta returned ${delta.value.length} change(s) → ${entries.length} cached remote entries`);
        return entries;
      } catch (e) {
        if (!isDeltaStateInvalid(e)) {
          throw e;
        }
        this.diag?.warn("onedrive", `incremental delta failed (${e instanceof Error ? e.message : "unknown"}), rebuilding remote cache`);
        await this.state.clearRemoteState();
      }
    }

    try {
      const delta = await this.onedrive.getDelta(this.vaultName);
      const entries = delta.value
        .filter((d) => !d.deleted && d.file)
        .map((d: DriveItem) => this.toRemoteEntry(d))
        .filter((entry) => this.shouldIncludeRemotePath(entry.path));
      await this.state.setRemoteState(
        entries,
        delta["@odata.deltaLink"] ?? null,
      );
      this.diag?.log("onedrive", `delta returned ${delta.value.length} items → ${entries.length} remote entries`);
      return entries;
    } catch (e) {
      // Delta failed — try full scan
      this.diag?.warn("onedrive", `delta failed (${e instanceof Error ? e.message : 'unknown'}), falling back to full scan`);
      try {
        const items = await this.onedrive.fullScan(this.vaultName);
        const entries = items
          .filter((d: DriveItem) => !d.deleted && d.file)
          .map((d: DriveItem) => this.toRemoteEntry(d))
          .filter((entry) => this.shouldIncludeRemotePath(entry.path));
        await this.state.setRemoteState(entries, null);
        this.diag?.log("onedrive", `full scan returned ${items.length} items → ${entries.length} remote entries`);
        return entries;
      } catch (e2) {
        // Both delta and full scan failed — if NotFound, the vault folder is empty/new
        if (e2 instanceof OneDriveError && e2.type === OneDriveErrorType.NotFound) {
          await this.state.setRemoteState([], null);
          return [];
        }
        throw e2;
      }
    }
  }

  private applyRemoteDelta(
    cachedEntries: RemoteFileEntry[],
    changes: DriveItem[],
  ): RemoteFileEntry[] {
    const syncableCachedEntries = cachedEntries.filter(
      (entry) => this.shouldIncludeRemotePath(entry.path),
    );
    const byPath = new Map(syncableCachedEntries.map((entry) => [entry.path, entry]));
    const pathByDriveId = new Map(syncableCachedEntries.map((entry) => [entry.driveId, entry.path]));

    for (const change of changes) {
      const previousPath = pathByDriveId.get(change.id);
      if (previousPath) {
        byPath.delete(previousPath);
      }
      if (change.deleted) {
        if (!previousPath) {
          byPath.delete(extractVaultPath(
            change.name,
            change.parentReference?.path,
          ));
        }
        continue;
      }
      if (!change.file) {
        continue;
      }
      const entry = this.toRemoteEntry(change);
      if (!this.shouldIncludeRemotePath(entry.path)) {
        continue;
      }
      byPath.set(entry.path, entry);
      pathByDriveId.set(entry.driveId, entry.path);
    }

    return [...byPath.values()];
  }

  private shouldIncludeRemotePath(path: string): boolean {
    return typeof this.scanner.shouldSyncPath === "function"
      ? this.scanner.shouldSyncPath(path)
      : !isEasySyncInternalPath(path, getConfigDir(this.scanner.vault));
  }

  /**
   * Convert a OneDrive DriveItem to a RemoteFileEntry.
   * Extracts the vault-relative path from parentReference.path,
   * falling back to d.name for root-level files.
   *
   * App Folder path structure:
   *   /drives/<id>/root:/Apps/EasySync/vaults/<vault>/files/<subdir>/<name>
   * Vault-relative path is everything after /files/:
   *   <subdir>/<name>  or just <name> for root-level files
   */
  private toRemoteEntry(d: DriveItem) {
    const vaultPath = extractVaultPath(d.name, d.parentReference?.path);
    return {
      path: vaultPath,
      driveId: d.id,
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
  ): RemoteFileEntry {
    return {
      path,
      driveId: uploadResult.id ?? "",
      size: uploadResult.size ?? local.size,
      mtime: uploadResult.lastModifiedDateTime
        ? new Date(uploadResult.lastModifiedDateTime).getTime()
        : Date.now(),
      eTag: uploadResult.eTag ?? "",
      cTag: uploadResult.cTag ?? "",
      sha256Hash: local.hash,
    };
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
    if (this.running) return "sync";
    return null;
  }

  /** Resolve a conflict: keep local version (re-upload) */
  async resolveConflictKeepLocal(path: string): Promise<void> {
    if (this.acquireGate("resolveConflict")) {
      this.notice("notice.conflict.failed", { path, reason: this.t("result.lockBusy") });
      return;
    }
    const conflict = this.state.pendingConflicts.find((c) => c.path === path);
    if (conflict?.remote && !conflict.local) {
      try {
        await this.onedrive.deleteItem(this.vaultName, path, conflict.remote.eTag);
        await this.state.removePendingConflict(path);
        await this.state.removeBaseEntry(path);
        await this.state.applyRemoteMutations([], [path]);
        this.notice("notice.conflict.keptLocal", { path });
      } catch (e) {
        this.notice("notice.conflict.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
      }
      return;
    }
    if (!conflict?.local) {
      this.notice("notice.conflict.failed", { path, reason: this.t("general.unknown") });
      return;
    }
    try {
      const content = await this.scanner.vault.adapter.readBinary(path);
      const uploadResult = await this.onedrive.uploadFile(this.vaultName, path, content);
      await this.state.updateBaseEntry({
        path,
        hash: conflict.local.hash,
        size: conflict.local.size,
        eTag: uploadResult.eTag ?? "",
      });
      await this.state.applyRemoteMutations([
        this.toUploadedRemoteEntry(path, conflict.local, uploadResult),
      ], []);
      await this.state.removePendingConflict(path);
      this.state.cacheBaseContent(path, content);
      this.notice("notice.conflict.keptLocal", { path });
    } catch (e) {
      this.notice("notice.conflict.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
    }
  }

  /** Resolve a conflict: keep remote version (re-download) */
  async resolveConflictKeepRemote(path: string): Promise<void> {
    if (this.acquireGate("resolveConflict")) {
      this.notice("notice.conflict.failed", { path, reason: this.t("result.lockBusy") });
      return;
    }
    const conflict = this.state.pendingConflicts.find((c) => c.path === path);
    if (!conflict?.remote) {
      this.notice("notice.conflict.failed", { path, reason: this.t("general.unknown") });
      return;
    }
    try {
      const content = await this.onedrive.downloadFile(
        this.vaultName,
        path,
        conflict.remote.downloadUrl,
        conflict.remote.driveId,
        conflict.remote.size,
      );
      await this.ensureParentDirs(path);
      await this.scanner.vault.adapter.writeBinary(path, content);
      // Hash from memory — content is already loaded, no need to re-read
      const hash = await fullHash(content);
      const stat = await this.scanner.vault.adapter.stat(path);
      await this.state.updateBaseEntry({
        path,
        hash,
        size: stat?.size ?? content.byteLength,
        eTag: conflict.remote.eTag,
      });
      await this.state.removePendingConflict(path);
      this.state.cacheBaseContent(path, content);
      this.notice("notice.conflict.keptRemote", { path });
    } catch {
      // Download failed — most likely network restriction (401 on /content, DNS block on downloadUrl).
      // Show a user-friendly message instead of the raw HTTP error.
      this.notice("notice.conflict.downloadFailed");
    }
  }

  /** Confirm a remote delete: delete local file */
  async confirmRemoteDelete(path: string): Promise<void> {
    if (this.acquireGate("confirmDelete")) {
      this.notice("notice.delete.failed", { path, reason: this.t("result.lockBusy") });
      return;
    }
    try {
      // Try Obsidian Trash first (recoverable), fall back to permanent remove
      const tfile = this.scanner.vault.getFileByPath(path);
      if (tfile) {
        try {
          if (this.fileManager) {
            await this.fileManager.trashFile(tfile);
          } else {
            await this.scanner.vault.adapter.remove(path);
          }
        } catch {
          await this.scanner.vault.adapter.remove(path);
        }
      } else {
        await this.scanner.vault.adapter.remove(path);
      }
      await this.state.removeBaseEntry(path);
      await this.state.removePendingDelete(path);
      this.notice("notice.delete.confirmed", { path });
    } catch (e) {
      this.notice("notice.delete.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
    }
  }

  /** Reject a remote delete: re-upload local file */
  async rejectRemoteDelete(path: string): Promise<void> {
    if (this.acquireGate("rejectDelete")) {
      this.notice("notice.delete.failed", { path, reason: this.t("result.lockBusy") });
      return;
    }
    const pending = this.state.pendingRemoteDeletes.find((d) => d.path === path);
    if (!pending?.local) {
      this.notice("notice.delete.failed", { path, reason: this.t("general.unknown") });
      return;
    }
    try {
      const content = await this.scanner.vault.adapter.readBinary(path);
      const uploadResult = await this.onedrive.uploadFile(this.vaultName, path, content);
      await this.state.updateBaseEntry({
        path, hash: pending.local.hash, size: pending.local.size, eTag: uploadResult.eTag ?? "",
      });
      await this.state.applyRemoteMutations([
        this.toUploadedRemoteEntry(path, pending.local, uploadResult),
      ], []);
      await this.state.removePendingDelete(path);
      this.notice("notice.delete.rejected", { path });
    } catch (e) {
      this.notice("notice.delete.failed", { path, reason: e instanceof Error ? e.message : this.t("general.unknown") });
    }
  }
}

function isPendingIssueAction(type: SyncActionType): boolean {
  return type === SyncActionType.Upload
    || type === SyncActionType.Download
    || type === SyncActionType.DeleteRemote
    || type === SyncActionType.SkipLargeFile
    || type === SyncActionType.RetryLater;
}

/** Unified auth failure check — covers OneDrive token expiry and AuthModule errors. */
function isAuthFailure(error: unknown): boolean {
  if (error instanceof OneDriveError && error.type === OneDriveErrorType.AuthExpired) return true;
  if (error instanceof AuthError) return true;
  return false;
}

function isResolvedIssueAction(type: SyncActionType): boolean {
  return type === SyncActionType.Upload
    || type === SyncActionType.Download
    || type === SyncActionType.DeleteRemote
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

/**
 * Extract the vault-relative path from a OneDrive DriveItem.
 *
 * parentPath example:
 *   /drives/b!abc/root:/Apps/EasySync/vaults/myVault/files/subdir
 * name: note.md
 * → returns "subdir/note.md"
 *
 * parentPath root-level:
 *   /drives/b!abc/root:/Apps/EasySync/vaults/myVault/files
 * name: note.md
 * → returns "note.md"
 */
function extractVaultPath(name: string, parentPath?: string): string {
  if (!parentPath) return name;

  // Find the /files segment in the parent path.
  // Using lastIndexOf to handle edge cases where "files" might appear elsewhere.
  const filesIdx = parentPath.lastIndexOf("/files");
  if (filesIdx === -1) return name;

  // Everything after /files is the subdirectory path
  const afterFiles = parentPath.substring(filesIdx + "/files".length);
  // afterFiles: "" (root-level) or "/subdir" or "/subdir/deep"
  const dirPart = afterFiles.startsWith("/")
    ? afterFiles.substring(1)
    : afterFiles;

  return dirPart ? `${dirPart}/${name}` : name;
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
