/**
 * OneDriveClient — Microsoft Graph API wrapper for App Folder operations
 *
 * All methods use delegated permissions (Files.ReadWrite).
 * Access token is obtained from AuthModule.getAccessToken().
 *
 * Error handling: all non-2xx responses are classified into OneDriveErrorType
 * and thrown as OneDriveError. The caller can distinguish transient errors
 * (RateLimited, ServerError) from permanent ones (NotFound, Forbidden).
 */

import { requestUrl, type DataAdapter, type RequestUrlResponse } from "obsidian";
import { sha256Hex } from "../crypto";
import {
  compatClearTimeout,
  compatSetTimeout,
  DEFAULT_CONFIG_DIR,
  getEasySyncPaths,
  isRecord,
  isStringRecord,
} from "../obsidian-compat";
import {
  type DriveItem,
  type DeltaResponse,
  type RemoteVaultScope,
  type UploadResult,
  OneDriveError,
  OneDriveErrorType,
  GRAPH_BASE_URL,
  APP_FOLDER_PATHS,
} from "./types";
import {
  firstMissingUploadRange,
  shouldUseUploadSession,
  uploadRangeEndExclusive,
  uploadSessionChunkSize,
  uploadSessionChunkTimeoutMs,
  type UploadMissingRange,
} from "./upload-session-policy";
import type { DiagnosticLogger } from "../sync/diagnostic-logger";

/** Callback to get a fresh access token */
export type TokenProvider = () => Promise<string>;
type UploadProgressCallback = (uploadedBytes: number, totalBytes: number) => void;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const RETRY_JITTER_MS = 250;
const DOWNLOAD_BASE_TIMEOUT_MS = 30_000;  // 30s base — covers slow/unstable connections
const DOWNLOAD_PER_MIB_TIMEOUT_MS = 3_000;  // 3s/MiB — slower connections need more headroom
const DOWNLOAD_MAX_TIMEOUT_MS = 300_000; // 5min hard cap — slow connections may need minutes, not seconds
const DOWNLOAD_FAILURE_RESERVE_RATIO = 0.5;  // 50% reserve for slow/stalled connections
const UPLOAD_SESSION_CONTROL_TIMEOUT_MS = 15_000;
const MAX_UPLOAD_SESSION_RECOVERIES = 3;

interface RequestOptions {
  deadlineMs?: number;
  maxAttempts?: number;
  extraHeaders?: Record<string, string>;
  perRequestTimeoutMs?: number;
  observationAttemptOffset?: number;
  metadataReason?: OneDriveMetadataReason;
  expectedNotFound?: boolean;
}

export type OneDriveEndpointCategory =
  | "metadata"
  | "delta"
  | "simpleUpload"
  | "uploadSessionCreate"
  | "uploadSessionChunk"
  | "uploadSessionStatus"
  | "uploadSessionCancel"
  | "downloadUrl"
  | "contentFallback";

export type OneDriveAttemptStatusCategory =
  | "success"
  | "cancelled"
  | "auth"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "precondition"
  | "rangeNotSatisfiable"
  | "rateLimited"
  | "insufficientStorage"
  | "serverError"
  | "network"
  | "unknown";

export type OneDriveMetadataReason =
  | "downloadUrlRefresh"
  | "downloadVersionVerify"
  | "other";

export interface OneDriveMetadataReasonRunMetrics {
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  elapsedMs: number;
}

export interface OneDriveEndpointRunMetrics {
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  elapsedMs: number;
  effectiveBytes: number;
  failedBytes: number;
  retriedBytes: number;
  peakConcurrency: number;
  statusCategories: Partial<Record<OneDriveAttemptStatusCategory, number>>;
}

export interface OneDriveRunMetricsSummary {
  schemaVersion: 2;
  tokenAcquisition: {
    attempts: number;
    elapsedMs: number;
    maxElapsedMs: number;
  };
  totals: Omit<OneDriveEndpointRunMetrics, "statusCategories">;
  endpoints: Partial<Record<OneDriveEndpointCategory, OneDriveEndpointRunMetrics>>;
  metadataReasons: Partial<Record<OneDriveMetadataReason, OneDriveMetadataReasonRunMetrics>>;
}

interface MutableEndpointRunMetrics extends OneDriveEndpointRunMetrics {
  activeConcurrency: number;
}

interface ActiveRunMetrics {
  activeConcurrency: number;
  peakConcurrency: number;
  tokenAcquisition: {
    attempts: number;
    elapsedMs: number;
    maxElapsedMs: number;
  };
  endpoints: Partial<Record<OneDriveEndpointCategory, MutableEndpointRunMetrics>>;
  metadataReasons: Partial<Record<OneDriveMetadataReason, OneDriveMetadataReasonRunMetrics>>;
}

interface DownloadToPathResult {
  size: number;
  hash: string;
}

export class OneDriveClient {
  private initializedVaults = new Set<string>();
  private storageVaultNames = new Map<string, string>();
  private vaultScopes = new Map<string, RemoteVaultScope>();
  private abortSignal: AbortSignal | null = null;
  /** Remember which download strategy worked last in this sync round so
   *  subsequent files skip the waterfall of known-broken tiers. */
  private downloadMethod: "downloadUrl" | "content" | null = null;
  /** M13: set when both /content tiers fail for a file in this round.
   *  Subsequent files skip /content entirely — it's confirmed broken. */
  private contentFailedThisRound = false;
  /** Set when CDN downloadUrl fails for a file this round.
   *  Subsequent files skip CDN entirely — saves budget for /content. */
  private cdnFailedThisRound = false;
  private runMetrics: ActiveRunMetrics | null = null;

  constructor(
    private getToken: TokenProvider,
    private diag?: DiagnosticLogger,
    private configDir = DEFAULT_CONFIG_DIR,
    private pluginId = "easy-sync",
  ) {}

  setAbortSignal(signal: AbortSignal | null): void {
    this.abortSignal = signal;
  }

  /** Start an in-memory diagnostic scope for one sync round. */
  beginRunMetrics(): void {
    this.runMetrics = {
      activeConcurrency: 0,
      peakConcurrency: 0,
      tokenAcquisition: {
        attempts: 0,
        elapsedMs: 0,
        maxElapsedMs: 0,
      },
      endpoints: {},
      metadataReasons: {},
    };
  }

  /** Finish the current diagnostic scope without persisting any state. */
  finishRunMetrics(): OneDriveRunMetricsSummary | null {
    const active = this.runMetrics;
    this.runMetrics = null;
    if (!active) return null;

    const endpoints: OneDriveRunMetricsSummary["endpoints"] = {};
    const totals: OneDriveRunMetricsSummary["totals"] = {
      attempts: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      elapsedMs: 0,
      effectiveBytes: 0,
      failedBytes: 0,
      retriedBytes: 0,
      peakConcurrency: active.peakConcurrency,
    };
    for (const [category, metrics] of Object.entries(active.endpoints) as Array<
      [OneDriveEndpointCategory, MutableEndpointRunMetrics]
    >) {
      const { activeConcurrency: _activeConcurrency, ...snapshot } = metrics;
      endpoints[category] = {
        ...snapshot,
        statusCategories: { ...snapshot.statusCategories },
      };
      totals.attempts += snapshot.attempts;
      totals.succeeded += snapshot.succeeded;
      totals.failed += snapshot.failed;
      totals.cancelled += snapshot.cancelled;
      totals.elapsedMs += snapshot.elapsedMs;
      totals.effectiveBytes += snapshot.effectiveBytes;
      totals.failedBytes += snapshot.failedBytes;
      totals.retriedBytes += snapshot.retriedBytes;
    }
    return {
      schemaVersion: 2,
      tokenAcquisition: { ...active.tokenAcquisition },
      totals,
      endpoints,
      metadataReasons: Object.fromEntries(
        Object.entries(active.metadataReasons).map(([reason, metrics]) => [
          reason,
          { ...metrics },
        ]),
      ),
    };
  }

  private recordTokenAcquisition(startedAt: number): void {
    const active = this.runMetrics;
    if (!active) return;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    active.tokenAcquisition.attempts++;
    active.tokenAcquisition.elapsedMs += elapsedMs;
    active.tokenAcquisition.maxElapsedMs = Math.max(
      active.tokenAcquisition.maxElapsedMs,
      elapsedMs,
    );
  }

  private async acquireToken(): Promise<string> {
    const startedAt = Date.now();
    try {
      return await this.getToken();
    } finally {
      this.recordTokenAcquisition(startedAt);
    }
  }

  private beginMetricAttempt(endpoint: OneDriveEndpointCategory): number {
    const startedAt = Date.now();
    const active = this.runMetrics;
    if (!active) return startedAt;
    const metrics = active.endpoints[endpoint] ?? createEndpointRunMetrics();
    active.endpoints[endpoint] = metrics;
    metrics.activeConcurrency++;
    metrics.peakConcurrency = Math.max(metrics.peakConcurrency, metrics.activeConcurrency);
    active.activeConcurrency++;
    active.peakConcurrency = Math.max(active.peakConcurrency, active.activeConcurrency);
    return startedAt;
  }

  private finishMetricAttempt(
    endpoint: OneDriveEndpointCategory,
    status: OneDriveAttemptStatusCategory,
    startedAt: number,
    effectiveBytes = 0,
    retriedBytes = 0,
    failedBytes = 0,
    metadataReason?: OneDriveMetadataReason,
    countsAsSucceeded = false,
  ): void {
    const active = this.runMetrics;
    if (!active) return;
    const metrics = active.endpoints[endpoint] ?? createEndpointRunMetrics();
    active.endpoints[endpoint] = metrics;
    metrics.attempts++;
    metrics.elapsedMs += Math.max(0, Date.now() - startedAt);
    metrics.effectiveBytes += Math.max(0, effectiveBytes);
    metrics.retriedBytes += Math.max(0, retriedBytes);
    metrics.failedBytes += Math.max(0, failedBytes);
    metrics.statusCategories[status] = (metrics.statusCategories[status] ?? 0) + 1;
    if (status === "success" || countsAsSucceeded) {
      metrics.succeeded++;
    } else if (status === "cancelled") {
      metrics.cancelled++;
    } else {
      metrics.failed++;
    }
    metrics.activeConcurrency = Math.max(0, metrics.activeConcurrency - 1);
    active.activeConcurrency = Math.max(0, active.activeConcurrency - 1);
    if (endpoint === "metadata" && metadataReason) {
      const reasonMetrics = active.metadataReasons[metadataReason]
        ?? createMetadataReasonRunMetrics();
      active.metadataReasons[metadataReason] = reasonMetrics;
      reasonMetrics.attempts++;
      reasonMetrics.elapsedMs += Math.max(0, Date.now() - startedAt);
      if (status === "success" || countsAsSucceeded) reasonMetrics.succeeded++;
      else if (status === "cancelled") reasonMetrics.cancelled++;
      else reasonMetrics.failed++;
    }
  }

  // ---- App Folder Bootstrap ----

  /** Get the App Folder special folder metadata */
  async getAppFolder(): Promise<DriveItem> {
    const response = await this.request("GET", APP_FOLDER_PATHS.appRoot);
    return response.json as DriveItem;
  }

  /** Ensure a directory exists and return its metadata when Graph creates it. */
  async createFolder(folderPath: string): Promise<DriveItem | null> {
    // For path-based creation, we use:
    // PUT /me/drive/special/approot:/path/to/folder
    const encodedName = folderPath.split("/").pop() || "";
    try {
      const response = await this.request(
        "PUT",
        folderPath,
        {
          name: decodeURIComponent(encodedName),
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        },
      );
      return response.json as DriveItem;
    } catch (e) {
      if (e instanceof OneDriveError && e.type === OneDriveErrorType.Conflict) {
        this.diag?.log("onedrive", `folder already exists (409): ${folderPath}`);
        return null;
      }
      throw e;
    }
  }

  /** Initialize the App Folder directory structure and return Graph-owned identities.
   *  Read-only preview callers can require existing folders so this method
   *  uses GET only and never sends an idempotent create request. */
  async initVaultScope(
    vaultName: string,
    options: { createMissing?: boolean } = {},
  ): Promise<RemoteVaultScope> {
    if (this.initializedVaults.has(vaultName)) {
      const scope = this.vaultScopes.get(vaultName);
      if (!scope) throw new Error(`Missing initialized vault scope: ${vaultName}`);
      return scope;
    }

    const storageVaultName = await this.resolveStorageVaultName(vaultName);
    this.storageVaultNames.set(vaultName, storageVaultName);

    const createMissing = options.createMissing ?? true;

    // Create or resolve vault directory.
    const vaultPath = APP_FOLDER_PATHS.vaultDir(storageVaultName);
    const createdVaultFolder = createMissing
      ? await this.createFolder(vaultPath)
      : null;
    const vaultFolder = createdVaultFolder ?? (
      await this.request("GET", vaultPath)
    ).json as DriveItem;
    if (!vaultFolder.id || !vaultFolder.folder) {
      throw new Error(`Invalid vault folder metadata: ${vaultPath}`);
    }

    // Create or resolve files/ directory.
    const filesPath = APP_FOLDER_PATHS.filesDir(storageVaultName);
    const createdFilesFolder = createMissing
      ? await this.createFolder(filesPath)
      : null;
    const filesFolder = createdFilesFolder ?? (
      await this.request("GET", filesPath)
    ).json as DriveItem;
    if (!filesFolder.id || !filesFolder.folder) {
      throw new Error(`Invalid files root metadata: ${filesPath}`);
    }
    if (
      filesFolder.parentReference?.id
      && filesFolder.parentReference.id !== vaultFolder.id
    ) {
      throw new Error(`Files root parent identity mismatch: ${filesPath}`);
    }

    let driveId = filesFolder.parentReference?.driveId
      ?? vaultFolder.parentReference?.driveId;
    if (!driveId) {
      const drive = (await this.request("GET", "/me/drive?$select=id")).json as { id?: string };
      driveId = drive.id;
    }
    if (!driveId) throw new Error(`Missing drive identity for vault: ${vaultName}`);

    if (createMissing) {
      const pluginPath = APP_FOLDER_PATHS.pluginDir(storageVaultName);
      await this.createFolder(pluginPath);
    }
    const scope: RemoteVaultScope = {
      driveId,
      vaultFolderId: vaultFolder.id,
      filesRootId: filesFolder.id,
    };
    this.vaultScopes.set(vaultName, scope);
    if (createMissing) this.initializedVaults.add(vaultName);
    return scope;
  }

  /** Restore a previously committed Graph-owned scope without probing folders.
   *  The delta link must still prove which canonical/legacy storage path owns
   *  the cursor; callers fall back to live initialization when it cannot. */
  restoreVaultScope(
    vaultName: string,
    scope: RemoteVaultScope,
    deltaLink: string,
  ): boolean {
    if (!scope.driveId || !scope.vaultFolderId || !scope.filesRootId || !deltaLink) {
      return false;
    }
    const candidates = [vaultName];
    const legacyName = encodeURIComponent(vaultName);
    if (legacyName !== vaultName) candidates.push(legacyName);
    const storageVaultName = candidates.find((candidate) =>
      deltaLink.includes(APP_FOLDER_PATHS.filesDelta(candidate))
    );
    if (!storageVaultName) return false;

    this.storageVaultNames.set(vaultName, storageVaultName);
    this.vaultScopes.set(vaultName, { ...scope });
    this.initializedVaults.add(vaultName);
    return true;
  }

  invalidateVaultScope(vaultName: string): void {
    this.initializedVaults.delete(vaultName);
    this.storageVaultNames.delete(vaultName);
    this.vaultScopes.delete(vaultName);
  }

  isDeltaLinkForVault(vaultName: string, deltaLink: string): boolean {
    return deltaLink.includes(
      APP_FOLDER_PATHS.filesDelta(this.getStorageVaultName(vaultName)),
    );
  }

  /** Reset the per-round download strategy hint. Called at the start of
   *  each sync round so the first file runs the full waterfall. */
  resetDownloadStrategy(): void {
    this.downloadMethod = null;
    this.contentFailedThisRound = false;
    this.cdnFailedThisRound = false;
  }

  /**
   * A read-only signal for the per-run small-file download controller.
   * Once a CDN/content fallback or a retryable transport failure is observed,
   * callers must keep the remainder of the round serial.
   */
  hasDegradedDownloadPathThisRound(): boolean {
    if (this.cdnFailedThisRound || this.contentFailedThisRound) return true;
    const unhealthy = new Set<OneDriveAttemptStatusCategory>([
      "rateLimited",
      "serverError",
      "network",
      "unknown",
    ]);
    for (const endpoint of ["downloadUrl", "contentFallback"] as const) {
      const categories = this.runMetrics?.endpoints[endpoint]?.statusCategories;
      if (!categories) continue;
      for (const category of unhealthy) {
        if ((categories[category] ?? 0) > 0) return true;
      }
    }
    return false;
  }

  private getStorageVaultName(vaultName: string): string {
    return this.storageVaultNames.get(vaultName) ?? vaultName;
  }

  private async resolveStorageVaultName(vaultName: string): Promise<string> {
    const legacyName = encodeURIComponent(vaultName);
    if (legacyName === vaultName) return vaultName;

    let children: DriveItem[];
    try {
      const response = await this.request(
        "GET",
        "/me/drive/special/approot:/vaults:/children",
      );
      children = (response.json as { value?: DriveItem[] }).value ?? [];
    } catch (error) {
      if (error instanceof OneDriveError && error.type === OneDriveErrorType.NotFound) {
        return vaultName;
      }
      throw error;
    }

    const names = new Set(children.filter((item) => item.folder).map((item) => item.name));
    const hasCanonical = names.has(vaultName);
    const hasLegacy = names.has(legacyName);
    if (!hasLegacy) return vaultName;
    if (!hasCanonical) {
      this.diag?.warn("onedrive", `using legacy encoded vault directory: ${legacyName}`);
      return legacyName;
    }

    const [canonicalHasContent, legacyHasContent] = await Promise.all([
      this.hasNonBootstrapContent(vaultName),
      this.hasNonBootstrapContent(legacyName),
    ]);
    if (!canonicalHasContent && legacyHasContent) {
      this.diag?.warn("onedrive", `using legacy encoded vault directory with existing content: ${legacyName}`);
      return legacyName;
    }
    if (canonicalHasContent && legacyHasContent) {
      throw new OneDriveError(
        OneDriveErrorType.Conflict,
        `Both canonical and legacy vault directories contain sync content: ${vaultName}`,
        409,
      );
    }
    return vaultName;
  }

  private async hasNonBootstrapContent(storageVaultName: string): Promise<boolean> {
    const filesPath = APP_FOLDER_PATHS.filesDir(storageVaultName);
    const { configDir } = getEasySyncPaths(this.configDir, this.pluginId);
    const levels = [
      { path: filesPath, allowed: configDir },
      { path: `${filesPath}/${configDir}`, allowed: "plugins" },
      { path: `${filesPath}/${configDir}/plugins`, allowed: this.pluginId },
    ];

    for (const level of levels) {
      let children: DriveItem[];
      try {
        const response = await this.request("GET", `${level.path}:/children`);
        children = (response.json as { value?: DriveItem[] }).value ?? [];
      } catch (error) {
        if (error instanceof OneDriveError && error.type === OneDriveErrorType.NotFound) {
          return false;
        }
        throw error;
      }
      if (children.some((item) => item.name !== level.allowed)) return true;
      const next = children.find((item) => item.name === level.allowed);
      if (!next) return false;
      if (!next.folder) return true;
    }
    return false;
  }

  /**
   * Check if a vault directory already exists and is non-empty.
   * Returns true if the directory exists and contains files/subdirectories.
   */
  async vaultExists(vaultName: string): Promise<boolean> {
    try {
      const childrenPath = `${APP_FOLDER_PATHS.filesDir(this.getStorageVaultName(vaultName))}:/children`;
      const response = await this.request("GET", childrenPath);
      const data = response.json as { value: DriveItem[] };
      return data.value.length > 0;
    } catch (e) {
      if (e instanceof OneDriveError && e.type === OneDriveErrorType.NotFound) {
        return false;
      }
      throw e;
    }
  }

  // ---- File Operations ----

  /** Upload a file, using an upload session above 10 MiB.
   *
   *  @param eTag  When set, the upload includes an If-Match header. OneDrive
   *               rejects the request with 412 if the remote eTag has changed,
   *               preventing silent overwrite of another device's changes. */
  async uploadFile(
    vaultName: string,
    filePath: string,
    content: ArrayBuffer,
    onProgress?: UploadProgressCallback,
    eTag?: string,
    driveItemId?: string,
  ): Promise<UploadResult> {
    throwIfAborted(this.abortSignal);
    onProgress?.(0, content.byteLength);
    if (shouldUseUploadSession(content.byteLength)) {
      return this.uploadLargeFile(vaultName, filePath, content, onProgress, eTag, driveItemId);
    }
    const apiPath = driveItemId
      ? `/me/drive/items/${encodeURIComponent(driveItemId)}/content`
      : `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/content?@microsoft.graph.conflictBehavior=fail`;
    const headers: Record<string, string> = {};
    if (eTag) headers["If-Match"] = eTag;
    const response = await this.request(
      "PUT",
      apiPath,
      content,
      "application/octet-stream",
      undefined,
      { extraHeaders: headers },
    );
    onProgress?.(content.byteLength, content.byteLength);
    return response.json as UploadResult;
  }

  private async uploadLargeFile(
    vaultName: string,
    filePath: string,
    content: ArrayBuffer,
    onProgress?: UploadProgressCallback,
    eTag?: string,
    driveItemId?: string,
  ): Promise<UploadResult> {
    throwIfAborted(this.abortSignal);
    const apiPath = driveItemId
      ? `/me/drive/items/${encodeURIComponent(driveItemId)}/createUploadSession`
      : `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/createUploadSession`;
    const extraHeaders = eTag ? { "If-Match": eTag } : undefined;
    const sessionResponse = await this.request(
      "POST",
      apiPath,
      {
        item: { "@microsoft.graph.conflictBehavior": driveItemId ? "replace" : "fail" },
      },
      undefined,
      undefined,
      { extraHeaders },
    );
    const uploadUrl = (sessionResponse.json as { uploadUrl?: string }).uploadUrl;
    if (!uploadUrl) {
      throw new OneDriveError(
        OneDriveErrorType.Unknown,
        `Upload session did not return an uploadUrl: ${filePath}`,
      );
    }

    this.diag?.log(
      "onedrive",
      `large upload session — path=${filePath}, bytes=${content.byteLength}`,
    );
    let range: UploadMissingRange = { start: 0, endExclusive: content.byteLength };
    let observedBytesPerSecond: number | null = null;
    let recovering = false;
    let recoveriesForRange = 0;
    let reportedProgress = 0;

    try {
      while (range.start < content.byteLength) {
        throwIfAborted(this.abortSignal);
        const chunkSize = uploadSessionChunkSize(observedBytesPerSecond, recovering);
        const endExclusive = uploadRangeEndExclusive(range, chunkSize, content.byteLength);
        if (endExclusive <= range.start) {
          throw new OneDriveError(
            OneDriveErrorType.Unknown,
            `Upload session returned an invalid missing range: ${filePath}`,
          );
        }
        const end = endExclusive - 1;
        const chunk = content.slice(range.start, endExclusive);
        const timeoutMs = uploadSessionChunkTimeoutMs(chunk.byteLength, observedBytesPerSecond);
        const startedAt = Date.now();
        let response: RequestUrlResponse;
        try {
          response = await this.uploadChunk(
            uploadUrl,
            chunk,
            range.start,
            end,
            content.byteLength,
            timeoutMs,
          );
        } catch (rawError) {
          if (isAbortError(rawError)) throw rawError;
          const error = rawError instanceof OneDriveError
            ? rawError
            : this.toRequestError(rawError, uploadUrl);
          if (isUncancellableRequestTimeout(error)) throw error;
          if (!isRecoverableUploadSessionError(error)) throw error;
          recoveriesForRange++;
          if (recoveriesForRange > MAX_UPLOAD_SESSION_RECOVERIES) throw error;
          range = await this.recoverUploadSessionRange(
            uploadUrl,
            content.byteLength,
            error,
          );
          recovering = true;
          this.diag?.warn(
            "onedrive",
            `large upload resumed from session state — next=${range.start}, recovery=${recoveriesForRange}/${MAX_UPLOAD_SESSION_RECOVERIES}`,
          );
          continue;
        }

        if (response.status === 200 || response.status === 201) {
          onProgress?.(content.byteLength, content.byteLength);
          return response.json as UploadResult;
        }
        if (response.status !== 202) {
          throw new OneDriveError(
            OneDriveErrorType.Unknown,
            `Upload session returned unexpected status ${response.status}: ${filePath}`,
            response.status,
          );
        }

        const nextRange = firstMissingUploadRange(
          (response.json as { nextExpectedRanges?: unknown } | undefined)?.nextExpectedRanges,
          content.byteLength,
        ) ?? await this.getUploadSessionRange(uploadUrl, content.byteLength);
        if (nextRange.start <= range.start) {
          throw new OneDriveError(
            OneDriveErrorType.Unknown,
            `Upload session did not advance after an accepted fragment: ${filePath}`,
          );
        }

        const elapsedMs = Math.max(1, Date.now() - startedAt);
        observedBytesPerSecond = chunk.byteLength / (elapsedMs / 1000);
        range = nextRange;
        recovering = false;
        recoveriesForRange = 0;
        reportedProgress = Math.max(reportedProgress, Math.min(range.start, content.byteLength));
        this.diag?.log(
          "onedrive",
          `large upload progress — path=${filePath}, uploaded=${reportedProgress}/${content.byteLength}, chunkBytes=${chunk.byteLength}, timeoutMs=${timeoutMs}`,
        );
        onProgress?.(reportedProgress, content.byteLength);
      }

      throw new OneDriveError(
        OneDriveErrorType.Unknown,
        `Upload session ended without a completed driveItem: ${filePath}`,
      );
    } catch (error) {
      if (!isUncancellableRequestTimeout(error)) {
        await this.cancelUploadSessionBestEffort(uploadUrl);
      }
      throw error;
    }
  }

  private async uploadChunk(
    uploadUrl: string,
    chunk: ArrayBuffer,
    start: number,
    end: number,
    total: number,
    timeoutMs: number,
  ): Promise<RequestUrlResponse> {
    // Try native fetch first — bypasses requestUrl mobile bugs
    // (Android base64 encoding, iOS status=0 on non-Graph domains).
    // Azure Blob upload session URLs are non-Graph, same risk profile as CDN downloadUrl.
    let observedAttempt = 1;
    const fetchStartedAt = this.beginMetricAttempt("uploadSessionChunk");
    try {
      const response = await withAbortableTimeout(
        (signal) => uploadChunkFetch(uploadUrl, chunk, start, end, total, signal),
        timeoutMs,
        this.abortSignal,
      );
      this.finishMetricAttempt(
        "uploadSessionChunk",
        "success",
        fetchStartedAt,
        chunk.byteLength,
      );
      return response;
    } catch (fetchError) {
      this.finishMetricAttempt(
        "uploadSessionChunk",
        rawAttemptStatus(fetchError, this.abortSignal),
        fetchStartedAt,
      );
      if (isAbortError(fetchError)) throw fetchError;
      if (!isFetchUnavailableError(fetchError)) {
        const classified = classifyUploadSessionUrlError(this.toRequestError(fetchError, uploadUrl));
        if (isRequestTimeoutError(fetchError)) {
          throw new OneDriveError(
            OneDriveErrorType.NetworkError,
            `Abortable upload chunk timed out after ${timeoutMs}ms`,
            classified.statusCode,
            classified.retryAfterSeconds,
            classified.graphCode,
          );
        }
        throw classified;
      }
      this.diag?.log("onedrive", "upload chunk fetch unavailable, falling back to requestUrl");
    }

    throwIfAborted(this.abortSignal);
    observedAttempt++;
    const fallbackStartedAt = this.beginMetricAttempt("uploadSessionChunk");
    try {
      const response = await withTimeout(
        requestUrl({
          url: uploadUrl,
          method: "PUT",
          headers: {
            "Content-Range": `bytes ${start}-${end}/${total}`,
          },
          body: chunk,
          contentType: "application/octet-stream",
        }),
        timeoutMs,
      );
      this.finishMetricAttempt(
        "uploadSessionChunk",
        "success",
        fallbackStartedAt,
        chunk.byteLength,
        observedAttempt > 1 ? chunk.byteLength : 0,
      );
      return response;
    } catch (rawError) {
      this.finishMetricAttempt(
        "uploadSessionChunk",
        rawAttemptStatus(rawError, this.abortSignal),
        fallbackStartedAt,
        0,
        observedAttempt > 1 ? chunk.byteLength : 0,
      );
      this.diag?.warn(
        "onedrive",
        `large upload chunk failed — range=${start}-${end}, bytes=${chunk.byteLength}, hostError=${requestErrorMessage(rawError)}`,
      );
      throw classifyUploadSessionUrlError(this.toRequestError(rawError, uploadUrl));
    }
  }

  private async recoverUploadSessionRange(
    uploadUrl: string,
    totalBytes: number,
    cause: OneDriveError,
  ): Promise<UploadMissingRange> {
    for (let attempt = 1; attempt <= MAX_UPLOAD_SESSION_RECOVERIES; attempt++) {
      throwIfAborted(this.abortSignal);
      if (attempt > 1 || cause.type !== OneDriveErrorType.RangeNotSatisfiable) {
        await sleepWithAbort(retryDelayMs(cause, attempt), this.abortSignal);
      }
      try {
        return await this.getUploadSessionRange(uploadUrl, totalBytes);
      } catch (rawError) {
        if (isAbortError(rawError)) throw rawError;
        const error = rawError instanceof OneDriveError
          ? rawError
          : this.toRequestError(rawError, uploadUrl);
        if (
          isUncancellableRequestTimeout(error)
          || !isTransientRequestError(error)
          || attempt === MAX_UPLOAD_SESSION_RECOVERIES
        ) {
          throw error;
        }
      }
    }
    throw cause;
  }

  private async getUploadSessionRange(
    uploadUrl: string,
    totalBytes: number,
  ): Promise<UploadMissingRange> {
    const response = await this.uploadSessionControlRequest(uploadUrl, "GET");
    const range = firstMissingUploadRange(
      (response.json as { nextExpectedRanges?: unknown } | undefined)?.nextExpectedRanges,
      totalBytes,
    );
    if (!range) {
      throw new OneDriveError(
        OneDriveErrorType.Unknown,
        "Upload session status returned no valid missing range",
      );
    }
    return range;
  }

  private async uploadSessionControlRequest(
    uploadUrl: string,
    method: "GET" | "DELETE",
  ): Promise<RequestUrlResponse> {
    const endpoint: OneDriveEndpointCategory = method === "GET"
      ? "uploadSessionStatus"
      : "uploadSessionCancel";
    const fetchStartedAt = this.beginMetricAttempt(endpoint);
    try {
      const response = await withAbortableTimeout(
        (signal) => uploadSessionControlFetch(uploadUrl, method, signal),
        UPLOAD_SESSION_CONTROL_TIMEOUT_MS,
        method === "GET" ? this.abortSignal : null,
      );
      this.finishMetricAttempt(endpoint, "success", fetchStartedAt);
      return response;
    } catch (fetchError) {
      this.finishMetricAttempt(
        endpoint,
        rawAttemptStatus(fetchError, method === "GET" ? this.abortSignal : null),
        fetchStartedAt,
      );
      if (isAbortError(fetchError)) throw fetchError;
      if (!isFetchUnavailableError(fetchError)) {
        throw classifyUploadSessionUrlError(this.toRequestError(fetchError, uploadUrl));
      }
    }

    const fallbackStartedAt = this.beginMetricAttempt(endpoint);
    try {
      const response = await withTimeout(
        requestUrl({ url: uploadUrl, method }),
        UPLOAD_SESSION_CONTROL_TIMEOUT_MS,
      );
      this.finishMetricAttempt(endpoint, "success", fallbackStartedAt);
      return response;
    } catch (rawError) {
      this.finishMetricAttempt(
        endpoint,
        rawAttemptStatus(rawError, method === "GET" ? this.abortSignal : null),
        fallbackStartedAt,
      );
      throw classifyUploadSessionUrlError(this.toRequestError(rawError, uploadUrl));
    }
  }

  private async cancelUploadSessionBestEffort(uploadUrl: string): Promise<void> {
    try {
      await this.uploadSessionControlRequest(uploadUrl, "DELETE");
      this.diag?.log("onedrive", "upload session cancelled and temporary data cleanup requested");
    } catch (error) {
      const classified = error instanceof OneDriveError
        ? error
        : this.toRequestError(error, uploadUrl);
      if (classified.type !== OneDriveErrorType.NotFound) {
        this.diag?.warn(
          "onedrive",
          `upload session cleanup failed — type=${classified.type}, status=${classified.statusCode}`,
        );
      }
    }
  }

  /** Download file content as ArrayBuffer.
   *
   *  Download strategy (in priority order):
   *  1. Pre-signed downloadUrl (if provided) — bypasses /content 401 entirely
   *  2. Fetch fresh downloadUrl from item metadata, then download via that URL
   *  3. Path-based /content endpoint
   *  4. Item ID /content endpoint (last resort)
   *
   *  /content GET returns 401 even with Files.ReadWrite for App Folder files,
   *  so the downloadUrl path is the primary reliable method. */
  async downloadFile(
    vaultName: string,
    filePath: string,
    downloadUrl?: string,
    driveItemId?: string,
    fileSize = 0,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<ArrayBuffer> {
    throwIfAborted(this.abortSignal);
    let metadataAuthError: OneDriveError | null = null;
    const primaryTimeoutMs = downloadTimeoutMs(fileSize);
    const failureReserveMs = Math.ceil(primaryTimeoutMs * DOWNLOAD_FAILURE_RESERVE_RATIO);
    const timeoutMs = primaryTimeoutMs + failureReserveMs;
    let deadlineMs = Date.now() + timeoutMs;
    const remainingMs = () => ensureDownloadBudget(deadlineMs, filePath);
    const fetchDownloadUrl = async (
      url: string,
      maxAttempts: number,
      onDlProgress?: (downloaded: number, total: number) => void,
    ): Promise<RequestUrlResponse> => {
      let observedAttempt = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        observedAttempt++;
        const fetchStartedAt = this.beginMetricAttempt("downloadUrl");
        try {
          const response = await withAbortableTimeout(
            (signal) => downloadUrlFetch(url, onDlProgress, signal),
            remainingMs(),
            this.abortSignal,
          );
          const bytes = responsePayloadByteLength(response);
          this.finishMetricAttempt(
            "downloadUrl",
            "success",
            fetchStartedAt,
            bytes,
            observedAttempt > 1 ? bytes : 0,
          );
          return response;
        } catch (error) {
          this.finishMetricAttempt(
            "downloadUrl",
            rawAttemptStatus(error, this.abortSignal),
            fetchStartedAt,
            0,
            0,
            transferredBytesFromError(error),
          );
          if (isAbortError(error)) throw error;
          let err = error;
          // fetch CORS/network error → fall back to requestUrl
          if (err instanceof TypeError || (err as { status?: number }).status === 0) {
            observedAttempt++;
            const fallbackStartedAt = this.beginMetricAttempt("downloadUrl");
            try {
              throwIfAborted(this.abortSignal);
              const response = await withTimeout(
                requestUrl({ url, method: "GET" }),
                remainingMs(),
              );
              const bytes = responsePayloadByteLength(response);
              this.finishMetricAttempt(
                "downloadUrl",
                "success",
                fallbackStartedAt,
                bytes,
                observedAttempt > 1 ? bytes : 0,
              );
              return response;
            } catch (fallbackErr) {
              this.finishMetricAttempt(
                "downloadUrl",
                rawAttemptStatus(fallbackErr, this.abortSignal),
                fallbackStartedAt,
              );
              err = fallbackErr;
            }
          }
          if (isUncancellableRequestTimeout(err)) {
            throw downloadTimeoutError(filePath);
          }
          if (attempt === maxAttempts || !isTransientDownloadUrlError(err)) {
            throw err;
          }
          const remaining = remainingMs();
          if (remaining <= RETRY_BASE_MS) throw err;
          this.diag?.warn(
            "onedrive",
            `downloadFile "${filePath}" — CDN retry ${attempt + 1}/${maxAttempts}, remainingMs=${remaining}`,
            requestErrorMessage(err),
          );
          await sleep(RETRY_BASE_MS);
        }
      }
      throw new OneDriveError(OneDriveErrorType.NetworkError, `Download failed for: ${filePath}`);
    };
    // content endpoints need longer per-request timeout for large files
    const contentRequestOptions: RequestOptions = {
      deadlineMs,
      maxAttempts: 2,
      perRequestTimeoutMs: DOWNLOAD_MAX_TIMEOUT_MS,
    };
    const metaRequestOptions: RequestOptions = {
      deadlineMs,
      maxAttempts: 1,
      metadataReason: "downloadUrlRefresh",
    };
    this.diag?.log(
      "onedrive",
      `downloadFile "${filePath}" — size=${fileSize}, primaryMs=${primaryTimeoutMs}, reserveMs=${failureReserveMs}, budgetMs=${timeoutMs}, hint=${this.downloadMethod ?? "none"}`,
    );
    // Report initial progress immediately so the sidebar shows 0/total
    // even before the first byte arrives (all sub-paths update from here).
    onProgress?.(0, fileSize);

    // If this round already learned that download URLs are blocked,
    // skip the CDN tiers and go straight to the Graph /content API.
    if (this.downloadMethod === "content" && driveItemId) {
      const tier0StartMs = Date.now();
      try {
        const apiPath = `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/content`;
        const response = await this.contentGet(apiPath, contentRequestOptions, onProgress);
        const buf = response.arrayBuffer;
        onProgress?.(0, fileSize || buf.byteLength);
        onProgress?.(buf.byteLength, fileSize || buf.byteLength);
        return buf;
      } catch (err) {
        if (isUncancellableRequestTimeout(err)) throw downloadTimeoutError(filePath);
        if (isAuthExpired(err)) throw err;
        this.diag?.warn("onedrive", `downloadFile "${filePath}" — content shortcut failed, falling back to full waterfall`, { ...downloadErrorData(err), tierMs: Date.now() - tier0StartMs });
        // Continue to full waterfall as last resort
      }
    }

    // Primary: pre-signed download URL. Skip if CDN was confirmed
    // unreachable earlier this round — saves budget for /content.
    if (downloadUrl && !this.cdnFailedThisRound) {
      const tier2StartMs = Date.now();
      try {
        const response = await fetchDownloadUrl(downloadUrl, 1, onProgress);
        this.downloadMethod = "downloadUrl";
        const buf = response.arrayBuffer;
        onProgress?.(buf.byteLength, fileSize || buf.byteLength);
        return buf;
      } catch (err) {
        this.diag?.warn("onedrive", `downloadFile "${filePath}" — downloadUrl failed, trying item metadata`, { ...downloadErrorData(err), tierMs: Date.now() - tier2StartMs });
        this.cdnFailedThisRound = true;
        remainingMs();
      }
    }

    // Secondary: fetch downloadUrl from item metadata, then use it
    if (driveItemId) {
      const tier3StartMs = Date.now();
      try {
        throwIfAborted(this.abortSignal);
        const metaResp = await this.request(
          "GET",
          `/me/drive/items/${driveItemId}?select=id,name,size,file,@microsoft.graph.downloadUrl`,
          undefined,
          undefined,
          undefined,
          metaRequestOptions,
        );
        const meta = metaResp.json as { "@microsoft.graph.downloadUrl"?: string };
        if (meta["@microsoft.graph.downloadUrl"]) {
          const dlResp = await fetchDownloadUrl(
            meta["@microsoft.graph.downloadUrl"],
            downloadUrl ? 1 : 2,
            onProgress,
          );
          this.downloadMethod = "downloadUrl";
          return dlResp.arrayBuffer;
        }
      } catch (err) {
        if (isAuthExpired(err)) {
          metadataAuthError = err;
        }
        this.diag?.warn("onedrive", `downloadFile "${filePath}" — item metadata downloadUrl failed, trying path /content`, { ...downloadErrorData(err), tierMs: Date.now() - tier3StartMs });
        this.cdnFailedThisRound = true;
        remainingMs();
      }
    }

    // M13: if /content was confirmed broken earlier this round, skip both tiers
    if (this.contentFailedThisRound) {
      this.diag?.log("onedrive", `downloadFile "${filePath}" — /content blocked this round, no fallback available`);
      throw new OneDriveError(OneDriveErrorType.NetworkError, `Content endpoint unavailable for: ${filePath}`);
    }

    // Tertiary: path-based /content endpoint
    const tier4StartMs = Date.now();
    try {
      this.diag?.log(
        "onedrive",
        `downloadFile "${filePath}" — executing path /content fallback, remainingMs=${remainingMs()}`,
      );
      const apiPath = `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/content`;

      const response = await this.contentGet(apiPath, contentRequestOptions, onProgress);
      this.downloadMethod = "content";
      return response.arrayBuffer;
    } catch (err) {
      if (isUncancellableRequestTimeout(err)) throw downloadTimeoutError(filePath);
      if (isAuthExpired(err)) {
        throw metadataAuthError ?? asFileDownloadUnauthorized(err, filePath);
      }
      this.diag?.warn("onedrive", `downloadFile "${filePath}" — path /content failed, trying item ID /content`, { ...downloadErrorData(err), tierMs: Date.now() - tier4StartMs });
      remainingMs();
    }

    // Last resort: item ID /content endpoint
    if (driveItemId) {
      const tier5StartMs = Date.now();
      try {
        throwIfAborted(this.abortSignal);
        this.diag?.log(
          "onedrive",
          `downloadFile "${filePath}" — executing item ID /content fallback, remainingMs=${remainingMs()}`,
        );
        const apiPath = `/me/drive/items/${driveItemId}/content`;
        const response = await this.contentGet(apiPath, contentRequestOptions, onProgress);
        this.downloadMethod = "content";
        return response.arrayBuffer;
      } catch (err) {
        if (isAuthExpired(err)) {
          throw metadataAuthError ?? asFileDownloadUnauthorized(err, filePath);
        }
        this.diag?.warn("onedrive", `downloadFile "${filePath}" — item ID /content failed, no remaining fallback`, { ...downloadErrorData(err), tierMs: Date.now() - tier5StartMs });
        // M13: both /content tiers failed — mark broken for remainder of this round
        this.contentFailedThisRound = true;
        throw err;
      }
    }

    // M13: both /content tiers failed or no driveItemId for tier 5 — mark broken
    this.contentFailedThisRound = true;
    throw new OneDriveError(
      OneDriveErrorType.NotFound,
      `No download method available for: ${filePath}`,
    );
  }

  /** Download directly to a local temp file.
   *
   *  Used by the sync executor on modern mobile runtimes to avoid holding
   *  large downloads entirely in memory before writing them to disk. */
  async downloadFileToPath(
    vaultName: string,
    filePath: string,
    localPath: string,
    adapter: DataAdapter,
    downloadUrl?: string,
    driveItemId?: string,
    fileSize = 0,
    expectedSha256?: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<DownloadToPathResult> {
    throwIfAborted(this.abortSignal);
    let metadataAuthError: OneDriveError | null = null;
    const primaryTimeoutMs = downloadTimeoutMs(fileSize);
    const failureReserveMs = Math.ceil(primaryTimeoutMs * DOWNLOAD_FAILURE_RESERVE_RATIO);
    const timeoutMs = primaryTimeoutMs + failureReserveMs;
    let deadlineMs = Date.now() + timeoutMs;
    const remainingMs = () => ensureDownloadBudget(deadlineMs, filePath);
    const writeDownloadUrl = async (
      url: string,
      maxAttempts: number,
      onDlProgress?: (downloaded: number, total: number) => void,
    ): Promise<DownloadToPathResult> => {
      let observedAttempt = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        observedAttempt++;
        const fetchStartedAt = this.beginMetricAttempt("downloadUrl");
        try {
          const result = await withAbortableTimeout(
            (signal) => downloadUrlFetchToBinaryFile(
              url,
              adapter,
              localPath,
              expectedSha256,
              onDlProgress,
              signal,
            ),
            remainingMs(),
            this.abortSignal,
          );
          this.finishMetricAttempt(
            "downloadUrl",
            "success",
            fetchStartedAt,
            result.size,
            observedAttempt > 1 ? result.size : 0,
          );
          return result;
        } catch (error) {
          this.finishMetricAttempt(
            "downloadUrl",
            rawAttemptStatus(error, this.abortSignal),
            fetchStartedAt,
            0,
            0,
            transferredBytesFromError(error),
          );
          if (isAbortError(error)) throw error;
          let err = error;
          if (err instanceof TypeError || (err as { status?: number }).status === 0) {
            observedAttempt++;
            const fallbackStartedAt = this.beginMetricAttempt("downloadUrl");
            try {
              throwIfAborted(this.abortSignal);
              const response = await withTimeout(
                requestUrl({ url, method: "GET" }),
                remainingMs(),
              );
              const result = await writeArrayBufferToBinaryFile(
                adapter,
                localPath,
                response.arrayBuffer,
                expectedSha256,
                fileSize,
                onDlProgress,
              );
              this.finishMetricAttempt(
                "downloadUrl",
                "success",
                fallbackStartedAt,
                result.size,
                observedAttempt > 1 ? result.size : 0,
              );
              return result;
            } catch (fallbackErr) {
              this.finishMetricAttempt(
                "downloadUrl",
                rawAttemptStatus(fallbackErr, this.abortSignal),
                fallbackStartedAt,
              );
              err = fallbackErr;
            }
          }
          if (isUncancellableRequestTimeout(err)) {
            throw downloadTimeoutError(filePath);
          }
          if (attempt === maxAttempts || !isTransientDownloadUrlError(err)) {
            throw err;
          }
          const remaining = remainingMs();
          if (remaining <= RETRY_BASE_MS) throw err;
          this.diag?.warn(
            "onedrive",
            `downloadFileToPath "${filePath}" — CDN retry ${attempt + 1}/${maxAttempts}, remainingMs=${remaining}`,
            requestErrorMessage(err),
          );
          await sleep(RETRY_BASE_MS);
        }
      }
      throw new OneDriveError(OneDriveErrorType.NetworkError, `Download failed for: ${filePath}`);
    };
    const contentRequestOptions: RequestOptions = {
      deadlineMs,
      maxAttempts: 2,
      perRequestTimeoutMs: DOWNLOAD_MAX_TIMEOUT_MS,
    };
    const metaRequestOptions: RequestOptions = {
      deadlineMs,
      maxAttempts: 1,
      metadataReason: "downloadUrlRefresh",
    };
    this.diag?.log(
      "onedrive",
      `downloadFileToPath "${filePath}" — size=${fileSize}, primaryMs=${primaryTimeoutMs}, reserveMs=${failureReserveMs}, budgetMs=${timeoutMs}, hint=${this.downloadMethod ?? "none"}`,
    );
    onProgress?.(0, fileSize);

    if (this.downloadMethod === "content" && driveItemId) {
      const tier0StartMs = Date.now();
      try {
        const apiPath = `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/content`;
        return await this.contentGetToPath(
          apiPath,
          adapter,
          localPath,
          expectedSha256,
          contentRequestOptions,
          onProgress,
        );
      } catch (err) {
        if (isUncancellableRequestTimeout(err)) throw downloadTimeoutError(filePath);
        if (isAuthExpired(err)) throw err;
        this.diag?.warn("onedrive", `downloadFileToPath "${filePath}" — content shortcut failed, falling back to full waterfall`, { ...downloadErrorData(err), tierMs: Date.now() - tier0StartMs });
      }
    }

    if (downloadUrl && !this.cdnFailedThisRound) {
      const tier1StartMs = Date.now();
      try {
        const result = await writeDownloadUrl(downloadUrl, 1, onProgress);
        this.downloadMethod = "downloadUrl";
        return result;
      } catch (err) {
        this.diag?.warn("onedrive", `downloadFileToPath "${filePath}" — downloadUrl failed, trying item metadata`, { ...downloadErrorData(err), tierMs: Date.now() - tier1StartMs });
        this.cdnFailedThisRound = true;
        remainingMs();
      }
    }

    if (driveItemId) {
      const tier2StartMs = Date.now();
      try {
        throwIfAborted(this.abortSignal);
        const metaResp = await this.request(
          "GET",
          `/me/drive/items/${driveItemId}?select=id,name,size,file,@microsoft.graph.downloadUrl`,
          undefined,
          undefined,
          undefined,
          metaRequestOptions,
        );
        const meta = metaResp.json as { "@microsoft.graph.downloadUrl"?: string };
        if (meta["@microsoft.graph.downloadUrl"]) {
          const result = await writeDownloadUrl(
            meta["@microsoft.graph.downloadUrl"],
            downloadUrl ? 1 : 2,
            onProgress,
          );
          this.downloadMethod = "downloadUrl";
          return result;
        }
      } catch (err) {
        if (isAuthExpired(err)) {
          metadataAuthError = err;
        }
        this.diag?.warn("onedrive", `downloadFileToPath "${filePath}" — item metadata downloadUrl failed, trying path /content`, { ...downloadErrorData(err), tierMs: Date.now() - tier2StartMs });
        this.cdnFailedThisRound = true;
        remainingMs();
      }
    }

    if (this.contentFailedThisRound) {
      this.diag?.log("onedrive", `downloadFileToPath "${filePath}" — /content blocked this round, no fallback available`);
      throw new OneDriveError(OneDriveErrorType.NetworkError, `Content endpoint unavailable for: ${filePath}`);
    }

    const tier3StartMs = Date.now();
    try {
      this.diag?.log(
        "onedrive",
        `downloadFileToPath "${filePath}" — executing path /content fallback, remainingMs=${remainingMs()}`,
      );
      const apiPath = `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/content`;
      const result = await this.contentGetToPath(
        apiPath,
        adapter,
        localPath,
        expectedSha256,
        contentRequestOptions,
        onProgress,
      );
      this.downloadMethod = "content";
      return result;
    } catch (err) {
      if (isUncancellableRequestTimeout(err)) throw downloadTimeoutError(filePath);
      if (isAuthExpired(err)) {
        throw metadataAuthError ?? asFileDownloadUnauthorized(err, filePath);
      }
      this.diag?.warn("onedrive", `downloadFileToPath "${filePath}" — path /content failed, trying item ID /content`, { ...downloadErrorData(err), tierMs: Date.now() - tier3StartMs });
      remainingMs();
    }

    if (driveItemId) {
      const tier4StartMs = Date.now();
      try {
        throwIfAborted(this.abortSignal);
        this.diag?.log(
          "onedrive",
          `downloadFileToPath "${filePath}" — executing item ID /content fallback, remainingMs=${remainingMs()}`,
        );
        const apiPath = `/me/drive/items/${driveItemId}/content`;
        const result = await this.contentGetToPath(
          apiPath,
          adapter,
          localPath,
          expectedSha256,
          contentRequestOptions,
          onProgress,
        );
        this.downloadMethod = "content";
        return result;
      } catch (err) {
        if (isAuthExpired(err)) {
          throw metadataAuthError ?? asFileDownloadUnauthorized(err, filePath);
        }
        this.diag?.warn("onedrive", `downloadFileToPath "${filePath}" — item ID /content failed, no remaining fallback`, { ...downloadErrorData(err), tierMs: Date.now() - tier4StartMs });
        this.contentFailedThisRound = true;
        throw err;
      }
    }

    this.contentFailedThisRound = true;
    throw new OneDriveError(
      OneDriveErrorType.NotFound,
      `No download method available for: ${filePath}`,
    );
  }

  /** Delete a file or folder.
   *  @param eTag  When set, the DELETE includes an If-Match header. If the
   *               file has been modified remotely since the plan was generated,
   *               the server returns 412 and the caller routes to conflict. */
  async deleteItem(
    vaultName: string,
    itemPath: string,
    eTag?: string,
    driveItemId?: string,
  ): Promise<void> {
    const apiPath = driveItemId
      ? `/me/drive/items/${encodeURIComponent(driveItemId)}`
      : APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), itemPath);
    await this.request("DELETE", apiPath, undefined, undefined, undefined, undefined, eTag);
  }

  /** Rename a file on OneDrive without re-uploading content.
   *
   *  Uses the reviewed driveItem identity and If-Match version.
   *  OneDrive handles the rename server-side — no content transfer.
   *
   *  Returns the updated DriveItem so callers can grab the new eTag. */
  async renameItem(
    _vaultName: string,
    _oldPath: string,
    newPath: string,
    driveItemId: string,
    eTag: string,
  ): Promise<DriveItem> {
    const apiPath = `/me/drive/items/${encodeURIComponent(driveItemId)}`;
    const newName = newPath.split("/").pop() || newPath;
    const response = await this.request("PATCH", apiPath, { name: newName }, undefined, undefined, undefined, eTag);
    return response.json as DriveItem;
  }

  /** Move/rename a known driveItem using reviewed identity + version. */
  async moveItemById(
    driveItemId: string,
    eTag: string,
    newName: string,
    newParentId: string,
  ): Promise<DriveItem> {
    const response = await this.request(
      "PATCH",
      `/me/drive/items/${encodeURIComponent(driveItemId)}`,
      { name: newName, parentReference: { id: newParentId } },
      undefined,
      undefined,
      undefined,
      eTag,
    );
    return response.json as DriveItem;
  }

  /** Fetch current metadata for a single file — used when an If-Match upload
   *  fails with 412 to get fresh remote info for conflict creation. */
  async getFileMetadata(
    vaultName: string,
    filePath: string,
    metadataReason: OneDriveMetadataReason = "other",
  ): Promise<{ eTag: string; size: number; sha256Hash?: string; downloadUrl?: string; driveId: string; parentId?: string; mtime: number } | null> {
    try {
      const apiPath = APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath);
      const response = await this.request(
        "GET",
        apiPath,
        undefined,
        undefined,
        undefined,
        { metadataReason, expectedNotFound: true },
      );
      const item = response.json as DriveItem;
      if (!item.file) return null;
      return {
        eTag: item.eTag ?? "",
        size: item.size ?? 0,
        sha256Hash: item.file?.hashes?.sha256Hash?.toLowerCase(),
        downloadUrl: item["@microsoft.graph.downloadUrl"],
        driveId: item.id,
        parentId: item.parentReference?.id,
        mtime: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : 0,
      };
    } catch (e) {
      if (e instanceof OneDriveError && e.type === OneDriveErrorType.NotFound) {
        return null;
      }
      throw e;
    }
  }

  // ---- Cloud Baseline ----

  /** Download the cloud baseline snapshot from .easy-sync/baseline.json.
   *  Returns null if the file doesn't exist (NotFound → first sync on a fresh vault). */
  async downloadBaseline(vaultName: string): Promise<string | null> {
    const storageVaultName = this.getStorageVaultName(vaultName);
    try {
      const childrenResp = await this.request(
        "GET",
        `${APP_FOLDER_PATHS.pluginDir(storageVaultName)}:/children`,
      );
      const children = (childrenResp.json as { value?: DriveItem[] }).value ?? [];
      const baseline = children.find((item) => item.name === "baseline.json" && item.file);
      if (!baseline) {
        return null;
      }

      // ponytail: children already gives us the file id and a downloadUrl,
      // so reuse that instead of a second metadata hop that proved flaky.
      if (baseline["@microsoft.graph.downloadUrl"]) {
        try {
          const downloadResp = await withTimeout(
            requestUrl({
              url: baseline["@microsoft.graph.downloadUrl"],
              method: "GET",
            }),
            8000,
          );
          this.diag?.log("onedrive", "cloud baseline downloaded via plugin-dir children downloadUrl");
          return responseToText(downloadResp);
        } catch (error) {
          rethrowUncancellableRequestTimeout(error);
          // downloadUrl may expire or be blocked — fall through to Graph fallback
        }
      }

      if (baseline.id) {
        try {
          const metaResp = await this.request(
            "GET",
            `/me/drive/items/${baseline.id}?select=id,name,size,file,@microsoft.graph.downloadUrl`,
          );
          const meta = metaResp.json as {
            "@microsoft.graph.downloadUrl"?: string;
          };
          if (meta["@microsoft.graph.downloadUrl"]) {
            const downloadResp = await withTimeout(
              requestUrl({
                url: meta["@microsoft.graph.downloadUrl"],
                method: "GET",
              }),
              8000,
            );
            this.diag?.log("onedrive", "cloud baseline downloaded via item metadata downloadUrl fallback");
            return responseToText(downloadResp);
          }
        } catch (error) {
          rethrowUncancellableRequestTimeout(error);
          // fall through to direct Graph /content
        }
      }

      if (!baseline.id) {
        return null;
      }

      const response = await this.request(
        "GET",
        `/me/drive/items/${baseline.id}/content`,
        undefined,
        undefined,
        "json",
      );
      this.diag?.log("onedrive", "cloud baseline downloaded via direct item /content fallback");
      return responseToText(response);
    } catch (e) {
      if (e instanceof OneDriveError && e.type === OneDriveErrorType.NotFound) {
        return null;
      }
      throw e;
    }
  }

  // ---- Cloud Bootstrap V2 ----

  async readCloudBootstrapV2(
    vaultName: string,
  ): Promise<{ id: string; eTag: string; content: string } | null> {
    const storageVaultName = this.getStorageVaultName(vaultName);
    const childrenResp = await this.request(
      "GET",
      `${APP_FOLDER_PATHS.pluginDir(storageVaultName)}:/children`,
    );
    const children = (childrenResp.json as { value?: DriveItem[] }).value ?? [];
    const item = children.find((entry) => entry.name === "bootstrap-v2.json" && entry.file);
    if (!item) return null;
    return this.readCloudBootstrapItemV2(item);
  }

  async readCloudBootstrapV2ById(
    id: string,
  ): Promise<{ id: string; eTag: string; content: string }> {
    const metaResp = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(id)}?select=id,name,eTag,file,@microsoft.graph.downloadUrl`,
    );
    return this.readCloudBootstrapItemV2(metaResp.json as DriveItem);
  }

  async createCloudBootstrapV2(
    vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const apiPath = `${APP_FOLDER_PATHS.pluginDir(this.getStorageVaultName(vaultName))}/bootstrap-v2.json:/content?@microsoft.graph.conflictBehavior=fail`;
    const response = await this.request("PUT", apiPath, content, "application/json");
    return requireCloudBootstrapVersion(response.json);
  }

  async updateCloudBootstrapV2(
    id: string,
    eTag: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const response = await this.request(
      "PUT",
      `/me/drive/items/${encodeURIComponent(id)}/content`,
      content,
      "application/json",
      undefined,
      {},
      eTag,
    );
    return requireCloudBootstrapVersion(response.json);
  }

  private async readCloudBootstrapItemV2(
    initial: DriveItem,
  ): Promise<{ id: string; eTag: string; content: string }> {
    if (!initial.id) throw new Error("CloudBootstrapV2 item has no driveItem id");
    let item = initial;
    if (!item.eTag || !item["@microsoft.graph.downloadUrl"]) {
      const metaResp = await this.request(
        "GET",
        `/me/drive/items/${encodeURIComponent(item.id)}?select=id,name,eTag,file,@microsoft.graph.downloadUrl`,
      );
      item = metaResp.json as DriveItem;
    }
    if (!item.eTag) throw new Error("CloudBootstrapV2 item has no eTag");
    if (item["@microsoft.graph.downloadUrl"]) {
      try {
        const response = await withTimeout(requestUrl({
          url: item["@microsoft.graph.downloadUrl"],
          method: "GET",
        }), 8000);
        return { id: item.id, eTag: item.eTag, content: responseToText(response) };
      } catch (error) {
        rethrowUncancellableRequestTimeout(error);
        // Fall through to the authenticated ID /content path.
      }
    }
    const response = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(item.id)}/content`,
      undefined,
      undefined,
      "json",
    );
    return { id: item.id, eTag: item.eTag, content: responseToText(response) };
  }

  // ---- Directory Listing ----

  /** List all items in the files directory (recursive). */
  async listFiles(vaultName: string): Promise<DriveItem[]> {
    const rootPath = APP_FOLDER_PATHS.filesDir(this.getStorageVaultName(vaultName));
    return this.listRecursive(rootPath);
  }

  /** Recursively list all files in a directory and its subdirectories. */
  private async listRecursive(dirPath: string): Promise<DriveItem[]> {
    const apiPath = `${dirPath}:/children`;
    const result: DriveItem[] = [];
    let url: string | null = apiPath;

    while (url) {
      const response = await this.request("GET", url);
      const data = response.json as { value: DriveItem[]; "@odata.nextLink"?: string };
      for (const item of data.value) {
        result.push(item);
        if (item.folder) {
          const subPath = `${dirPath}/${encodeURIComponent(item.name)}`;
          const children = await this.listRecursive(subPath);
          result.push(...children);
        }
      }
      url = data["@odata.nextLink"] || null;
    }

    return result;
  }

  // ---- Delta / Change Tracking ----

  /**
   * Query delta for the files directory.
   * Pass a deltaToken to get changes since that token.
   * Returns the delta response with changed items and new deltaToken.
   * Handles pagination via @odata.nextLink.
   */
  async getDelta(
    vaultName: string,
    deltaToken?: string,
  ): Promise<DeltaResponse> {
    let url: string;
    if (deltaToken) {
      url = deltaToken;
    } else {
      url = APP_FOLDER_PATHS.filesDelta(this.getStorageVaultName(vaultName));
    }

    const allValues: DriveItem[] = [];
    let deltaLink: string | undefined;
    let nextLink: string | undefined;

    while (url) {
      const response = await this.request("GET", url);
      const data = response.json as DeltaResponse;
      allValues.push(...data.value);
      deltaLink = data["@odata.deltaLink"];
      nextLink = data["@odata.nextLink"];
      url = nextLink || "";
    }

    return {
      value: allValues,
      "@odata.deltaLink": deltaLink,
    };
  }

  /**
   * Full scan fallback when delta is unavailable.
   * Returns files and folders so callers can rebuild paths from identities.
   */
  async fullScan(vaultName: string): Promise<DriveItem[]> {
    return this.listFiles(vaultName);
  }

  // ---- Request Helper ----

  /** GET a /content endpoint using native fetch (primary) with requestUrl
   *  fallback.  fetch strips the Authorization header on cross-origin
   *  redirects (graph.microsoft.com → sharepoint.com) which avoids the
   *  401 that requestUrl triggers by forwarding the Bearer token to
   *  SharePoint's already-authenticated download.aspx. */
  private async contentGet(
    apiPath: string,
    options: RequestOptions,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<RequestUrlResponse> {
    throwIfAborted(this.abortSignal);
    const token = await this.acquireToken();
    const url = apiPath.startsWith("https://")
      ? apiPath
      : `${GRAPH_BASE_URL}${apiPath}`;

    const fetchStartedAt = this.beginMetricAttempt("contentFallback");
    try {
      const timeoutMs = requestTimeoutWithCap(options.deadlineMs, options.perRequestTimeoutMs ?? DOWNLOAD_MAX_TIMEOUT_MS);
      this.diag?.log("onedrive", `contentGet — trying fetch, timeoutMs=${timeoutMs}, url=${sanitizeUrl(url)}`);
      const response = await withAbortableTimeout(
        (signal) => contentUrlFetch(url, token, onProgress, signal),
        timeoutMs,
        this.abortSignal,
      );
      this.finishMetricAttempt(
        "contentFallback",
        "success",
        fetchStartedAt,
        responsePayloadByteLength(response),
      );
      return response;
    } catch (fetchErr) {
      this.finishMetricAttempt(
        "contentFallback",
        rawAttemptStatus(fetchErr, this.abortSignal),
        fetchStartedAt,
        0,
        0,
        transferredBytesFromError(fetchErr),
      );
      if (isAbortError(fetchErr)) throw fetchErr;
      this.diag?.log("onedrive", `content fetch failed, falling back to requestUrl: ${requestErrorMessage(fetchErr)}`);
    }

    // Fall back to requestUrl — may 401 on SharePoint redirect but
    // handles environments where fetch is unavailable.
    return this.request(
      "GET",
      apiPath,
      undefined,
      undefined,
      "arraybuffer",
      { ...options, observationAttemptOffset: 1 },
    );
  }

  private async contentGetToPath(
    apiPath: string,
    adapter: DataAdapter,
    localPath: string,
    expectedSha256: string | undefined,
    options: RequestOptions,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<DownloadToPathResult> {
    throwIfAborted(this.abortSignal);
    const token = await this.acquireToken();
    const url = apiPath.startsWith("https://")
      ? apiPath
      : `${GRAPH_BASE_URL}${apiPath}`;

    const fetchStartedAt = this.beginMetricAttempt("contentFallback");
    try {
      const timeoutMs = requestTimeoutWithCap(options.deadlineMs, options.perRequestTimeoutMs ?? DOWNLOAD_MAX_TIMEOUT_MS);
      this.diag?.log("onedrive", `contentGetToPath — trying fetch stream, timeoutMs=${timeoutMs}, url=${sanitizeUrl(url)}`);
      const result = await withAbortableTimeout(
        (signal) => contentUrlFetchToBinaryFile(
          url,
          token,
          adapter,
          localPath,
          expectedSha256,
          onProgress,
          signal,
        ),
        timeoutMs,
        this.abortSignal,
      );
      this.finishMetricAttempt(
        "contentFallback",
        "success",
        fetchStartedAt,
        result.size,
      );
      return result;
    } catch (fetchErr) {
      this.finishMetricAttempt(
        "contentFallback",
        rawAttemptStatus(fetchErr, this.abortSignal),
        fetchStartedAt,
        0,
        0,
        transferredBytesFromError(fetchErr),
      );
      if (isAbortError(fetchErr)) throw fetchErr;
      this.diag?.log("onedrive", `content stream fetch failed, falling back to requestUrl: ${requestErrorMessage(fetchErr)}`);
    }

    const response = await this.request(
      "GET",
      apiPath,
      undefined,
      undefined,
      "arraybuffer",
      { ...options, observationAttemptOffset: 1 },
    );
    return writeArrayBufferToBinaryFile(
      adapter,
      localPath,
      response.arrayBuffer,
      expectedSha256,
      0,
      onProgress,
    );
  }

  private async request(
    method: string,
    apiPath: string,
    body?: unknown,
    contentType?: string,
    responseType?: "json" | "arraybuffer",
    options: RequestOptions = {},
    ifMatch?: string,
  ): Promise<RequestUrlResponse> {
    throwIfAborted(this.abortSignal);
    const token = await this.acquireToken();
    const url = apiPath.startsWith("https://")
      ? apiPath
      : `${GRAPH_BASE_URL}${apiPath}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (ifMatch) headers["If-Match"] = ifMatch;

    let requestBody: ArrayBuffer | string | undefined;
    if (body !== undefined) {
      if (contentType) {
        headers["Content-Type"] = contentType;
      } else {
        headers["Content-Type"] = "application/json";
      }
      requestBody =
        body instanceof ArrayBuffer
          ? body
          : typeof body === "string"
            ? body
            : JSON.stringify(body);
    }

    if (options.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }

    const maxAttempts = options.maxAttempts ?? MAX_REQUEST_ATTEMPTS;
    const endpoint = classifyRequestEndpoint(method, apiPath);
    const requestBytes = endpoint === "simpleUpload"
      ? requestPayloadByteLength(requestBody)
      : 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(this.abortSignal);
      const attemptStartedAt = this.beginMetricAttempt(endpoint);
      try {
        const timeoutMs = options.perRequestTimeoutMs
          ? requestTimeoutWithCap(options.deadlineMs, options.perRequestTimeoutMs)
          : requestTimeoutMs(options.deadlineMs);
        const response = await withTimeout(
          requestUrl({
            url,
            method,
            headers,
            body: requestBody,
            contentType,
          }),
          timeoutMs,
        );
        const effectiveBytes = endpoint === "simpleUpload"
          ? requestBytes
          : endpoint === "contentFallback"
            ? responsePayloadByteLength(response)
            : 0;
        const observedAttempt = attempt + (options.observationAttemptOffset ?? 0);
        this.finishMetricAttempt(
          endpoint,
          "success",
          attemptStartedAt,
          effectiveBytes,
          observedAttempt > 1 ? effectiveBytes : 0,
          0,
          options.metadataReason ?? (endpoint === "metadata" ? "other" : undefined),
        );
        return response;
      } catch (rawError) {
        const error = this.toRequestError(rawError, url, options.expectedNotFound === true);
        const expectedNotFound = options.expectedNotFound === true
          && error.type === OneDriveErrorType.NotFound;
        const observedAttempt = attempt + (options.observationAttemptOffset ?? 0);
        this.finishMetricAttempt(
          endpoint,
          requestAttemptStatus(error, this.abortSignal),
          attemptStartedAt,
          0,
          observedAttempt > 1 ? requestBytes : 0,
          0,
          options.metadataReason ?? (endpoint === "metadata" ? "other" : undefined),
          expectedNotFound,
        );
        if (
          isRequestTimeoutError(rawError)
          || (method !== "GET" && method !== "HEAD" && rawStatusCode(rawError) === 0)
        ) {
          this.diag?.warn(
            "onedrive",
            `request outcome unclear — not retrying method=${method}, endpoint=${endpoint}`,
          );
          throw error;
        }
        if (error.type === OneDriveErrorType.NotFound) {
          this.initializedVaults.clear();
          this.storageVaultNames.clear();
          this.vaultScopes.clear();
        }
        if (expectedNotFound) throw error;
        if (
          method === "DELETE"
          && attempt > 1
          && error.type === OneDriveErrorType.NotFound
        ) {
          this.diag?.log("onedrive", `DELETE retry confirmed item already absent — url=${url.substring(0, 120)}`);
          return { status: 204, headers: {}, json: {} } as RequestUrlResponse;
        }

        if (!isTransientRequestError(error) || attempt === maxAttempts) {
          if (!(method === "PUT" && error.type === OneDriveErrorType.Conflict)) {
            this.diag?.warn(
              "onedrive",
              `request failed — attempt=${attempt}/${maxAttempts}, type=${error.type}, url=${url.substring(0, 120)}`,
            );
          }
          throw error;
        }

        const waitMs = retryDelayMs(error, attempt);
        this.diag?.warn(
          "onedrive",
          `request retry — attempt=${attempt}/${maxAttempts}, type=${error.type}, waitMs=${waitMs}, url=${url.substring(0, 120)}`,
        );
        if (options.deadlineMs && Date.now() + waitMs >= options.deadlineMs) {
          throw error;
        }
        await sleep(waitMs);
      }
    }

    throw new OneDriveError(OneDriveErrorType.Unknown, `Request failed: ${url}`);
  }

  private toRequestError(
    rawError: unknown,
    url: string,
    suppressExpectedNotFoundWarning = false,
  ): OneDriveError {
    // Obsidian's requestUrl throws on non-2xx. The error object carries
    // status, headers, and sometimes json/text from the response.
    const errAny = isRecord(rawError) ? rawError : {};
    const errStatus = typeof errAny.status === "number" ? errAny.status : 0;
    const errHeaders = isStringRecord(errAny.headers) ? errAny.headers : {};
    let graphBody: Record<string, unknown> | undefined;
    if (isRecord(errAny.json)) {
      graphBody = errAny.json;
    } else if (errAny.text && typeof errAny.text === "string") {
      try {
        const parsed: unknown = JSON.parse(errAny.text);
        if (isRecord(parsed)) graphBody = parsed;
      } catch {
        // Not JSON
      }
    }
    const graphErr = graphBody?.error as Record<string, unknown> | undefined;
    // 409 is "folder already exists" — handled gracefully, don't alarm the user
    if (errStatus === 409) {
      this.diag?.log("onedrive", `requestUrl 409 — ${sanitizeUrl(url)}`);
    } else if (!(suppressExpectedNotFoundWarning && errStatus === 404)) {
      this.diag?.warn("onedrive", `requestUrl error — status=${errStatus}, graphCode=${graphErr?.code || "none"}, graphMsg=${graphErr?.message || "none"}, url=${sanitizeUrl(url)}`);
    }

    if (errStatus) {
      return this.classifyError({
        status: errStatus,
        headers: errHeaders,
        json: graphBody,
      } as RequestUrlResponse);
    }

    const errMsg = rawError instanceof Error ? rawError.message : String(rawError);
    return new OneDriveError(
      OneDriveErrorType.NetworkError,
      `Network error: ${errMsg}`,
    );
  }

  /** Classify an HTTP error response into OneDriveErrorType */
  private classifyError(response: RequestUrlResponse): OneDriveError {
    const status = response.status;
    const retryAfter = parseRetryAfter(response.headers);
    const graphError = tryParseGraphError(response);

    const message = graphError
      ? `${graphError.code}: ${graphError.message}`
      : `HTTP ${status}`;

    switch (status) {
      case 401:
        return new OneDriveError(
          OneDriveErrorType.AuthExpired,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 403:
        return new OneDriveError(
          OneDriveErrorType.Forbidden,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 404:
        return new OneDriveError(
          OneDriveErrorType.NotFound,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 409:
        return new OneDriveError(
          OneDriveErrorType.Conflict,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 412:
        return new OneDriveError(
          OneDriveErrorType.PreconditionFailed,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 416:
        return new OneDriveError(
          OneDriveErrorType.RangeNotSatisfiable,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 429:
        return new OneDriveError(
          OneDriveErrorType.RateLimited,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 507:
        return new OneDriveError(
          OneDriveErrorType.InsufficientStorage,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      case 500:
      case 502:
      case 503:
      case 504:
        return new OneDriveError(
          OneDriveErrorType.ServerError,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
      default:
        return new OneDriveError(
          OneDriveErrorType.Unknown,
          message,
          status,
          retryAfter,
          graphError?.code ?? null,
        );
    }
  }
}

function isAuthExpired(error: unknown): error is OneDriveError {
  return error instanceof OneDriveError
    && error.type === OneDriveErrorType.AuthExpired;
}

function createEndpointRunMetrics(): MutableEndpointRunMetrics {
  return {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    elapsedMs: 0,
    effectiveBytes: 0,
    failedBytes: 0,
    retriedBytes: 0,
    peakConcurrency: 0,
    statusCategories: {},
    activeConcurrency: 0,
  };
}

function createMetadataReasonRunMetrics(): OneDriveMetadataReasonRunMetrics {
  return {
    attempts: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    elapsedMs: 0,
  };
}

function classifyRequestEndpoint(method: string, apiPath: string): OneDriveEndpointCategory {
  const normalizedMethod = method.toUpperCase();
  const path = apiPath.toLowerCase();
  if (path.includes("/delta")) return "delta";
  if (path.includes("createuploadsession")) return "uploadSessionCreate";
  if (path.includes("/content")) {
    return normalizedMethod === "PUT" ? "simpleUpload" : "contentFallback";
  }
  return "metadata";
}

function requestPayloadByteLength(body: ArrayBuffer | string | undefined): number {
  if (body instanceof ArrayBuffer) return body.byteLength;
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : 0;
}

function responsePayloadByteLength(response: RequestUrlResponse): number {
  return response.arrayBuffer instanceof ArrayBuffer ? response.arrayBuffer.byteLength : 0;
}

function requestAttemptStatus(
  error: OneDriveError,
  signal: AbortSignal | null,
): OneDriveAttemptStatusCategory {
  if (signal?.aborted || isAbortError(error)) return "cancelled";
  switch (error.type) {
    case OneDriveErrorType.AuthExpired:
    case OneDriveErrorType.Unauthorized:
      return "auth";
    case OneDriveErrorType.Forbidden:
      return "forbidden";
    case OneDriveErrorType.NotFound:
      return "notFound";
    case OneDriveErrorType.Conflict:
      return "conflict";
    case OneDriveErrorType.PreconditionFailed:
      return "precondition";
    case OneDriveErrorType.RangeNotSatisfiable:
      return "rangeNotSatisfiable";
    case OneDriveErrorType.RateLimited:
      return "rateLimited";
    case OneDriveErrorType.InsufficientStorage:
      return "insufficientStorage";
    case OneDriveErrorType.ServerError:
      return "serverError";
    case OneDriveErrorType.NetworkError:
      return "network";
    default:
      return "unknown";
  }
}

function rawAttemptStatus(
  error: unknown,
  signal: AbortSignal | null,
): OneDriveAttemptStatusCategory {
  if (signal?.aborted || isAbortError(error)) return "cancelled";
  if (error instanceof OneDriveError) return requestAttemptStatus(error, signal);
  const status = isRecord(error) && typeof error.status === "number"
    ? error.status
    : 0;
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 412) return "precondition";
  if (status === 416) return "rangeNotSatisfiable";
  if (status === 429) return "rateLimited";
  if (status === 507) return "insufficientStorage";
  if ([500, 502, 503, 504].includes(status)) return "serverError";
  if (status === 0 || error instanceof TypeError) return "network";
  return "unknown";
}

function asFileDownloadUnauthorized(
  error: OneDriveError,
  filePath: string,
): OneDriveError {
  return new OneDriveError(
    OneDriveErrorType.Unauthorized,
    `File content download rejected for: ${filePath}`,
    error.statusCode,
    error.retryAfterSeconds,
    error.graphCode,
  );
}

function downloadTimeoutMs(fileSize: number): number {
  const sizeMiB = Math.ceil(Math.max(0, fileSize) / (1024 * 1024));
  return Math.min(
    DOWNLOAD_MAX_TIMEOUT_MS,
    DOWNLOAD_BASE_TIMEOUT_MS + sizeMiB * DOWNLOAD_PER_MIB_TIMEOUT_MS,
  );
}

function ensureDownloadBudget(deadlineMs: number, filePath: string): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new OneDriveError(
      OneDriveErrorType.NetworkError,
      `Download timed out for: ${filePath}`,
    );
  }
  return remaining;
}

function downloadTimeoutError(filePath: string): OneDriveError {
  return new OneDriveError(
    OneDriveErrorType.NetworkError,
    `Download timed out for: ${filePath}`,
  );
}

function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Request timed out after ");
}

function rethrowUncancellableRequestTimeout(error: unknown): void {
  if (isRequestTimeoutError(error)) {
    throw new OneDriveError(OneDriveErrorType.NetworkError, requestErrorMessage(error));
  }
}

function rawStatusCode(error: unknown): number {
  return isRecord(error) && typeof error.status === "number" ? error.status : 0;
}

function isUncancellableRequestTimeout(error: unknown): boolean {
  return isRequestTimeoutError(error)
    || (error instanceof OneDriveError && error.message.includes("Request timed out after "));
}

function isTransientDownloadUrlError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  // status=0 means no HTTP response (DNS/TCP/TLS failure) — retrying the
  // same CDN URL won't help. Fall through to metadata refresh or /content.
  if (typeof status !== "number" || status === 0) return false;
  return status === 408 || status === 429 || status >= 500;
}

function requestTimeoutMs(deadlineMs?: number): number {
  if (!deadlineMs) return REQUEST_TIMEOUT_MS;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new OneDriveError(
      OneDriveErrorType.NetworkError,
      "Request deadline exceeded",
    );
  }
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

/** Like requestTimeoutMs but uses `cap` instead of the global 15 s limit.
 *  Content downloads call this so per-attempt timeout matches the file budget. */
function requestTimeoutWithCap(deadlineMs: number | undefined, cap: number): number {
  if (!deadlineMs) return cap;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new OneDriveError(
      OneDriveErrorType.NetworkError,
      "Request deadline exceeded",
    );
  }
  return Math.min(cap, remaining);
}

// ---- Error Parsing Helpers ----

function parseRetryAfter(
  headers: Record<string, string>,
): number | null {
  const value = headers["retry-after"];
  if (!value) return null;
  const seconds = parseInt(value, 10);
  return isNaN(seconds) ? null : seconds;
}

function tryParseGraphError(response: RequestUrlResponse): {
  code: string;
  message: string;
} | null {
  try {
    const json = response.json as Record<string, unknown>;
    if (json?.error && typeof json.error === "object") {
      const err = json.error as Record<string, unknown>;
      return {
        code: String(err.code || "unknown"),
        message: String(err.message || "no message"),
      };
    }
  } catch {
    // Not JSON
  }
  return null;
}

/**
 * Race a promise against a timeout.
 * Rejects with a generic Error if the promise doesn't resolve within `ms`.
 */

/** Strip query parameters and fragment from a URL for log safety. */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    const q = url.indexOf("?");
    return q >= 0 ? url.substring(0, q) : url;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = compatSetTimeout(
      () => reject(new Error(`Request timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        compatClearTimeout(timer);
        resolve(value);
      },
      (error) => {
        compatClearTimeout(timer);
        reject(toErrorLike(error));
      },
    );
  });
}

function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outerSignal: AbortSignal | null | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) {
        controller.abort();
      } else {
        outerSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
    const timer = compatSetTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    run(controller.signal).then(
      (value) => {
        compatClearTimeout(timer);
        outerSignal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        compatClearTimeout(timer);
        outerSignal?.removeEventListener("abort", onAbort);
        if (timedOut && isAbortError(error)) {
          reject(new Error(`Request timed out after ${ms}ms`));
          return;
        }
        reject(toErrorLike(error));
      },
    );
  });
}

function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const currentWindow = typeof window !== "undefined" ? (window.activeWindow ?? window) : null;
  if (currentWindow && typeof currentWindow.fetch === "function") {
    return currentWindow.fetch(input, init);
  }
  throw new TypeError("fetch unavailable");
}

function toErrorLike(error: unknown): Error {
  if (error instanceof Error) return error;
  const wrapped = new Error(String(error));
  if (isRecord(error)) Object.assign(wrapped, error);
  return wrapped;
}

function isTransientRequestError(error: OneDriveError): boolean {
  return error.type === OneDriveErrorType.NetworkError
    || error.type === OneDriveErrorType.RateLimited
    || error.type === OneDriveErrorType.ServerError;
}

function isRecoverableUploadSessionError(error: OneDriveError): boolean {
  return error.type === OneDriveErrorType.NetworkError
    || error.type === OneDriveErrorType.RateLimited
    || error.type === OneDriveErrorType.ServerError
    || error.type === OneDriveErrorType.RangeNotSatisfiable;
}

function classifyUploadSessionUrlError(error: OneDriveError): OneDriveError {
  if (error.type !== OneDriveErrorType.AuthExpired) return error;
  return new OneDriveError(
    OneDriveErrorType.Unauthorized,
    error.message,
    error.statusCode,
    error.retryAfterSeconds,
    error.graphCode,
  );
}

function isFetchUnavailableError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch unavailable";
}

function retryDelayMs(error: OneDriveError, attempt: number): number {
  const base = error.type === OneDriveErrorType.RateLimited
    && error.retryAfterSeconds !== null
    ? error.retryAfterSeconds * 1000
    : RETRY_BASE_MS * (2 ** (attempt - 1));
  return base + Math.floor(Math.random() * RETRY_JITTER_MS);
}

function requestErrorMessage(rawError: unknown): string {
  const message = rawError instanceof Error ? rawError.message : String(rawError);
  return message.replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function requireCloudBootstrapVersion(value: unknown): { id: string; eTag: string } {
  if (!value || typeof value !== "object") throw new Error("CloudBootstrapV2 write returned no metadata");
  const item = value as Partial<DriveItem>;
  if (!item.id || !item.eTag) throw new Error("CloudBootstrapV2 write returned no id/eTag");
  return { id: item.id, eTag: item.eTag };
}

async function safeRemove(adapter: DataAdapter, path: string): Promise<void> {
  try { await adapter.remove(path); } catch { /* noop */ }
}

function exactArrayBuffer(chunk: Uint8Array): ArrayBuffer {
  return chunk.slice().buffer;
}

class StreamingSha256 {
  private static readonly K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private pending = new Uint8Array(64);
  private pendingLength = 0;
  private totalBytes = 0;

  update(chunk: Uint8Array): void {
    let offset = 0;
    this.totalBytes += chunk.length;
    if (this.pendingLength > 0) {
      const take = Math.min(64 - this.pendingLength, chunk.length);
      this.pending.set(chunk.subarray(0, take), this.pendingLength);
      this.pendingLength += take;
      offset += take;
      if (this.pendingLength === 64) {
        this.processBlock(this.pending, 0);
        this.pendingLength = 0;
      }
    }
    while (offset + 64 <= chunk.length) {
      this.processBlock(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.length) {
      this.pending.set(chunk.subarray(offset), 0);
      this.pendingLength = chunk.length - offset;
    }
  }

  digestHex(): string {
    const finalBlock = new Uint8Array(128);
    if (this.pendingLength > 0) {
      finalBlock.set(this.pending.subarray(0, this.pendingLength), 0);
    }
    finalBlock[this.pendingLength] = 0x80;
    const totalBitLength = this.totalBytes * 8;
    const needsTwoBlocks = this.pendingLength >= 56;
    const lengthOffset = needsTwoBlocks ? 120 : 56;
    const lo = totalBitLength >>> 0;
    finalBlock[lengthOffset + 4] = (lo >>> 24) & 0xff;
    finalBlock[lengthOffset + 5] = (lo >>> 16) & 0xff;
    finalBlock[lengthOffset + 6] = (lo >>> 8) & 0xff;
    finalBlock[lengthOffset + 7] = lo & 0xff;
    this.processBlock(finalBlock, 0);
    if (needsTwoBlocks) {
      this.processBlock(finalBlock, 64);
    }
    const bytes = new Uint8Array(32);
    const words = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    for (let i = 0; i < 8; i++) {
      bytes[i * 4] = (words[i] >>> 24) & 0xff;
      bytes[i * 4 + 1] = (words[i] >>> 16) & 0xff;
      bytes[i * 4 + 2] = (words[i] >>> 8) & 0xff;
      bytes[i * 4 + 3] = words[i] & 0xff;
    }
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  private processBlock(block: Uint8Array, offset: number): void {
    const w = new Uint32Array(64);
    for (let t = 0; t < 16; t++) {
      const i = offset + t * 4;
      w[t] = (block[i] << 24)
        | (block[i + 1] << 16)
        | (block[i + 2] << 8)
        | block[i + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr32(w[t - 15], 7) ^ rotr32(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr32(w[t - 2], 17) ^ rotr32(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + StreamingSha256.K[t] + w[t]) | 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
    this.h5 = (this.h5 + f) | 0;
    this.h6 = (this.h6 + g) | 0;
    this.h7 = (this.h7 + h) | 0;
  }
}

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw abortError();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => compatSetTimeout(() => resolve(), ms));
}

function sleepWithAbort(ms: number, signal: AbortSignal | null): Promise<void> {
  if (!signal) return sleep(ms);
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = compatSetTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      compatClearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function responseToText(response: RequestUrlResponse): string {
  if (typeof response.text === "string") {
    return response.text;
  }
  if (response.arrayBuffer instanceof ArrayBuffer) {
    return new TextDecoder().decode(response.arrayBuffer);
  }
  return JSON.stringify(response.json ?? null);
}

/** Extract structured error data for diag logging. */
function downloadErrorData(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof OneDriveError) {
    return { message, errorType: err.type, statusCode: err.statusCode, graphCode: err.graphCode };
  }
  return { message };
}

/** Upload a chunk to an Azure Blob upload session URL using native fetch
 *  (bypasses requestUrl mobile bugs: Android base64 encoding, iOS status=0
 *  on non-Graph domains). Only active in browser/Electron/WebView environments
 *  (has window). Returns a minimal RequestUrlResponse shape for compatibility. */
async function uploadChunkFetch(
  uploadUrl: string,
  chunk: ArrayBuffer,
  start: number,
  end: number,
  total: number,
  signal?: AbortSignal,
): Promise<RequestUrlResponse> {
  // In Node.js (test), fall through to requestUrl — fetch with fake timers hangs.
  const res = await browserFetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Type": "application/octet-stream",
    },
    body: chunk,
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw await fetchResponseError(res);
  }
  // 200/201 → driveItem JSON, 202 (Accepted) → no body
  let json: unknown = undefined;
  try { json = await res.json(); } catch { /* 202 Accepted has no body */ }
  return { json, status: res.status, headers: {} } as RequestUrlResponse;
}

async function uploadSessionControlFetch(
  uploadUrl: string,
  method: "GET" | "DELETE",
  signal: AbortSignal,
): Promise<RequestUrlResponse> {
  const res = await browserFetch(uploadUrl, {
    method,
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw await fetchResponseError(res);
  }
  let json: unknown = undefined;
  if (res.status !== 204) {
    try { json = await res.json(); } catch { /* empty control response */ }
  }
  return { json, status: res.status, headers: {} } as RequestUrlResponse;
}

async function fetchResponseError(response: Response): Promise<Error> {
  const headers: Record<string, string> = {};
  response.headers?.forEach((value, key) => {
    headers[key] = value;
  });
  let json: unknown = undefined;
  let text: string | undefined;
  try {
    json = await response.json();
  } catch {
    try { text = await response.text(); } catch { /* empty error body */ }
  }
  return Object.assign(new Error(`HTTP ${response.status}`), {
    status: response.status,
    headers,
    ...(json === undefined ? {} : { json }),
    ...(text === undefined ? {} : { text }),
  });
}

/** Shared helper: read a fetch Response as ArrayBuffer, optionally reporting
 *  byte-level progress via streaming read.  Falls back to simple arrayBuffer()
 *  when no progress callback is provided. */
async function readResponseBuffer(
  res: Response,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  if (!onProgress || !res.body) {
    return res.arrayBuffer();
  }
  const contentLength = parseInt(res.headers.get("Content-Length") || "0", 10);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;
      onProgress(downloaded, contentLength || downloaded);
    }
  } catch (error) {
    throw withTransferredBytes(error, downloaded);
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  const buf = new Uint8Array(downloaded);
  let pos = 0;
  for (const chunk of chunks) {
    buf.set(chunk, pos);
    pos += chunk.length;
  }
  return buf.buffer;
}

async function writeArrayBufferToBinaryFile(
  adapter: DataAdapter,
  path: string,
  data: ArrayBuffer,
  expectedSha256?: string,
  declaredSize = 0,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<DownloadToPathResult> {
  await safeRemove(adapter, path);
  await adapter.writeBinary(path, data);
  const size = data.byteLength;
  const hash = await sha256Hex(data);
  if (expectedSha256 && hash !== expectedSha256.toLowerCase()) {
    await safeRemove(adapter, path);
    throw new OneDriveError(
      OneDriveErrorType.NetworkError,
      `Downloaded content hash mismatch for: ${path}`,
    );
  }
  onProgress?.(size, declaredSize || size);
  return { size, hash };
}

async function streamResponseToBinaryFile(
  res: Response,
  adapter: DataAdapter,
  path: string,
  expectedSha256?: string,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DownloadToPathResult> {
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  if (!res.body) {
    return writeArrayBufferToBinaryFile(
      adapter,
      path,
      await res.arrayBuffer(),
      expectedSha256,
      parseInt(res.headers.get("Content-Length") || "0", 10),
      onProgress,
    );
  }
  await safeRemove(adapter, path);
  const contentLength = parseInt(res.headers.get("Content-Length") || "0", 10);
  const reader = res.body.getReader();
  const hasher = new StreamingSha256();
  let downloaded = 0;
  let wrote = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      const chunk = exactArrayBuffer(value);
      if (!wrote) {
        await adapter.writeBinary(path, chunk);
        wrote = true;
      } else {
        await adapter.appendBinary(path, chunk);
      }
      downloaded += value.length;
      onProgress?.(downloaded, contentLength || downloaded);
    }
    if (!wrote) {
      await adapter.writeBinary(path, new ArrayBuffer(0));
    }
    const hash = hasher.digestHex();
    if (expectedSha256 && hash !== expectedSha256.toLowerCase()) {
      await safeRemove(adapter, path);
      throw new OneDriveError(
        OneDriveErrorType.NetworkError,
        `Downloaded content hash mismatch for: ${path}`,
      );
    }
    return { size: downloaded, hash };
  } catch (error) {
    await safeRemove(adapter, path);
    throw withTransferredBytes(error, downloaded);
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
}

function withTransferredBytes(error: unknown, transferredBytes: number): unknown {
  if (transferredBytes <= 0) return error;
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    try {
      const target = error as { transferredBytes?: number };
      target.transferredBytes = Math.max(target.transferredBytes ?? 0, transferredBytes);
    } catch { /* Preserve the original error even when it is not extensible. */ }
    return error;
  }
  return Object.assign(new Error(String(error)), { transferredBytes });
}

function transferredBytesFromError(error: unknown): number {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return 0;
  const value = (error as { transferredBytes?: unknown }).transferredBytes;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Download via a Graph API /content endpoint using native fetch.
 *  Includes the Authorization header for the initial Graph call, but
 *  fetch correctly strips it when following cross-origin redirects to
 *  SharePoint download.aspx.  requestUrl forwards the auth header blindly
 *  and SharePoint rejects it as 401 (the URL is already authenticated
 *  via a tempauth query parameter).
 *  Only active in browser/Electron/WebView environments (has window). */
async function contentUrlFetch(
  url: string,
  token: string,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RequestUrlResponse> {
  const res = await browserFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  const buf = await readResponseBuffer(res, onProgress, signal);
  return { arrayBuffer: buf, status: res.status, headers: {} } as RequestUrlResponse;
}

async function contentUrlFetchToBinaryFile(
  url: string,
  token: string,
  adapter: DataAdapter,
  path: string,
  expectedSha256?: string,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DownloadToPathResult> {
  const res = await browserFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  return streamResponseToBinaryFile(res, adapter, path, expectedSha256, onProgress, signal);
}

/** Download a CDN pre-signed URL using native fetch (bypasses requestUrl
 *  mobile bugs: Android base64 encoding, iOS status=0 on CDN domains).
 *  Only active in browser/Electron/WebView environments (has window).
 *  Returns a minimal RequestUrlResponse shape for compatibility. */
async function downloadUrlFetch(
  url: string,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RequestUrlResponse> {
  const res = await browserFetch(url, { cache: "no-store", signal });
  const buf = await readResponseBuffer(res, onProgress, signal);
  return { arrayBuffer: buf, status: res.status, headers: {} } as RequestUrlResponse;
}

async function downloadUrlFetchToBinaryFile(
  url: string,
  adapter: DataAdapter,
  path: string,
  expectedSha256?: string,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DownloadToPathResult> {
  const res = await browserFetch(url, { cache: "no-store", signal });
  return streamResponseToBinaryFile(res, adapter, path, expectedSha256, onProgress, signal);
}
