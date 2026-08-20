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
  type CommunityPluginGenerationCloudObjectV1,
  OneDriveError,
  OneDriveErrorType,
  RemoteVaultScopeIdentityError,
  SharedSyncProtocolObservationError,
  SyntheticRequestTimeoutError,
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

export interface SharedSyncProtocolControlObject {
  id: string;
  eTag: string;
  content: string;
}

export interface SharedSyncProtocolObjectsObservation {
  v2: SharedSyncProtocolControlObject | null;
  v3: SharedSyncProtocolControlObject | null;
}

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
const MAX_REMOTE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LEGACY_BASELINE_BYTES = 64 * 1024 * 1024;
const MAX_CLOUD_BOOTSTRAP_BYTES = 64 * 1024 * 1024;
const MAX_SHARED_PROTOCOL_BYTES = 1024 * 1024;
const MAX_COMMUNITY_PLUGIN_LIFECYCLE_BYTES = 8 * 1024 * 1024;
const ONEDRIVE_PERSONAL_DRIVE_ID_PATTERN = /^[0-9a-f]{16}$/i;

function isSameGraphDriveId(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return ONEDRIVE_PERSONAL_DRIVE_ID_PATTERN.test(actual)
    && ONEDRIVE_PERSONAL_DRIVE_ID_PATTERN.test(expected)
    && actual.toLowerCase() === expected.toLowerCase();
}

class ResponseByteBudgetError extends OneDriveError {
  constructor(label: string, maxBytes: number, observedBytes: number) {
    super(
      OneDriveErrorType.Unknown,
      `${label} exceeds safe download size (${observedBytes} > ${maxBytes})`,
    );
    this.name = "ResponseByteBudgetError";
  }
}

interface RequestOptions {
  deadlineMs?: number;
  maxAttempts?: number;
  extraHeaders?: Record<string, string>;
  perRequestTimeoutMs?: number;
  observationAttemptOffset?: number;
  metadataReason?: OneDriveMetadataReason;
  expectedNotFound?: boolean;
  maxResponseBytes?: number;
  responseLabel?: string;
  sharedSyncProtocolRequestKey?: string;
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
  /** requestUrl cannot be cancelled after our local deadline. Keep one raw
   * owner per shared-protocol component so later sync rounds cannot pile up
   * the same request or consume a response from an earlier observation. */
  private sharedSyncProtocolRequestsInFlight = new Map<
    string,
    Promise<RequestUrlResponse>
  >();

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

  /** Create one child folder under an already committed parent identity.
   *  Unlike the bootstrap path helper, a name collision remains an error so
   *  the mutation ledger can reconcile the exact outcome before retrying. */
  async createFolderByParentId(
    parentDriveItemId: string,
    name: string,
  ): Promise<DriveItem> {
    const response = await this.request(
      "POST",
      `/me/drive/items/${encodeURIComponent(parentDriveItemId)}/children`,
      {
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      },
    );
    const item = response.json as DriveItem;
    if (
      !item.id
      || !item.folder
      || item.name !== name
      || item.parentReference?.id !== parentDriveItemId
    ) {
      throw new Error(`Created folder metadata is incomplete or mismatched: ${name}`);
    }
    return item;
  }

  /** Resolve one exact child folder, creating it only when the committed
   *  parent listing proves that it is absent. Unknown create outcomes and
   *  name races are adopted only after an exact identity readback. */
  private async ensureFolderByParentId(
    parentDriveItemId: string,
    name: string,
    expectedDriveId?: string,
  ): Promise<DriveItem> {
    const resolveExactFolder = (children: DriveItem[]): DriveItem | null => {
      const matches = children.filter((item) => item.name === name);
      if (matches.length > 1) {
        throw new Error(`Folder child listing returned duplicate names: ${name}`);
      }
      const item = matches[0];
      if (!item) return null;
      if (
        !item.id
        || !item.folder
        || item.parentReference?.id !== parentDriveItemId
        || (
          expectedDriveId
          && item.parentReference.driveId
          && !isSameGraphDriveId(item.parentReference.driveId, expectedDriveId)
        )
      ) {
        throw new Error(`Folder metadata is incomplete or mismatched: ${name}`);
      }
      return item;
    };

    const existing = resolveExactFolder(
      await this.listFolderChildrenById(parentDriveItemId),
    );
    if (existing) return existing;

    try {
      return resolveExactFolder([
        await this.createFolderByParentId(parentDriveItemId, name),
      ]) as DriveItem;
    } catch (error) {
      const outcomeNeedsReadback = error instanceof OneDriveError && (
        error.type === OneDriveErrorType.Conflict
        || (
          error.type === OneDriveErrorType.NetworkError
          && error.statusCode === 0
        )
      );
      if (!outcomeNeedsReadback) throw error;

      const winner = resolveExactFolder(
        await this.listFolderChildrenById(parentDriveItemId),
      );
      if (winner) return winner;
      throw error;
    }
  }

  /** Read any file/folder item by vault-relative path without conflating a
   *  folder with a missing file. */
  async getDriveItemMetadata(
    vaultName: string,
    itemPath: string,
  ): Promise<DriveItem | null> {
    try {
      const apiPath = APP_FOLDER_PATHS.filePath(
        this.getStorageVaultName(vaultName),
        itemPath,
      );
      const response = await this.request(
        "GET",
        apiPath,
        undefined,
        undefined,
        { metadataReason: "other", expectedNotFound: true },
      );
      return response.json as DriveItem;
    } catch (error) {
      if (error instanceof OneDriveError && error.type === OneDriveErrorType.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /** Read a committed parent identity immediately before a create-only write. */
  async getDriveItemMetadataById(
    driveItemId: string,
    metadataReason: OneDriveMetadataReason = "other",
  ): Promise<DriveItem | null> {
    try {
      const response = await this.request(
        "GET",
        `/me/drive/items/${encodeURIComponent(driveItemId)}`,
        undefined,
        undefined,
        { metadataReason, expectedNotFound: true },
      );
      return response.json as DriveItem;
    } catch (error) {
      if (error instanceof OneDriveError && error.type === OneDriveErrorType.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /** Read up to 20 independent driveItem identities per Graph JSON batch.
   *  Every sub-response is checked independently; retryable or malformed
   *  sub-responses fall back through the ordinary single-item GET contract. */
  async getDriveItemMetadataByIds(
    driveItemIds: readonly string[],
    metadataReason: OneDriveMetadataReason = "other",
  ): Promise<Map<string, DriveItem | null>> {
    const uniqueIds = [...new Set(driveItemIds.filter(Boolean))];
    const resolved = new Map<string, DriveItem | null>();
    for (let offset = 0; offset < uniqueIds.length; offset += 20) {
      const batchIds = uniqueIds.slice(offset, offset + 20);
      const response = await this.request(
        "POST",
        "/$batch",
        {
          requests: batchIds.map((driveItemId, index) => ({
            id: String(index + 1),
            method: "GET",
            url: `/me/drive/items/${encodeURIComponent(driveItemId)}`,
          })),
        },
        undefined,
        { metadataReason },
      );
      const body = isRecord(response.json) ? response.json : {};
      const rawSubresponses = Array.isArray(body.responses)
        ? body.responses
        : [];
      const subresponses = new Map(
        rawSubresponses.filter(isRecord).map((item) => [
          typeof item.id === "string" ? item.id : "",
          item as {
          id?: string;
          status?: number;
          headers?: Record<string, string>;
          body?: unknown;
          },
        ]),
      );
      for (let index = 0; index < batchIds.length; index++) {
        const driveItemId = batchIds[index];
        const subresponse = subresponses.get(String(index + 1));
        if (subresponse?.status === 200 && isRecord(subresponse.body)) {
          const item = subresponse.body as unknown as DriveItem;
          if (item.id === driveItemId) {
            resolved.set(driveItemId, item);
            continue;
          }
        }
        if (subresponse?.status === 404) {
          resolved.set(driveItemId, null);
          continue;
        }
        if (subresponse?.status === 401 || subresponse?.status === 403) {
          throw this.classifyError({
            status: subresponse.status,
            headers: subresponse.headers ?? {},
            json: isRecord(subresponse.body) ? subresponse.body : {},
          } as RequestUrlResponse);
        }
        if (
          subresponse?.status === 429
          || (typeof subresponse?.status === "number"
            && [500, 502, 503, 504].includes(subresponse.status))
        ) {
          const error = this.classifyError({
            status: subresponse.status,
            headers: subresponse.headers ?? {},
            json: isRecord(subresponse.body) ? subresponse.body : {},
          } as RequestUrlResponse);
          await sleepWithAbort(retryDelayMs(error, 1), this.abortSignal);
        }
        resolved.set(
          driveItemId,
          await this.getDriveItemMetadataById(driveItemId, metadataReason),
        );
      }
    }
    return resolved;
  }

  /** Read up to 20 vault-relative file paths per Graph JSON batch and return
   *  presence per path (null = provably absent). Every sub-response is checked
   *  independently; retryable or malformed sub-responses fall back through the
   *  ordinary single-item GET contract. */
  async getFileMetadataByPaths(
    vaultName: string,
    filePaths: readonly string[],
    metadataReason: OneDriveMetadataReason = "other",
  ): Promise<Map<string, DriveItem | null>> {
    const uniquePaths = [...new Set(filePaths.filter(Boolean))];
    const resolved = new Map<string, DriveItem | null>();
    for (let offset = 0; offset < uniquePaths.length; offset += 20) {
      const batchPaths = uniquePaths.slice(offset, offset + 20);
      const response = await this.request(
        "POST",
        "/$batch",
        {
          requests: batchPaths.map((path, index) => ({
            id: String(index + 1),
            method: "GET",
            url: APP_FOLDER_PATHS.filePath(
              this.getStorageVaultName(vaultName),
              path,
            ),
          })),
        },
        undefined,
        { metadataReason },
      );
      const body = isRecord(response.json) ? response.json : {};
      const rawSubresponses = Array.isArray(body.responses)
        ? body.responses
        : [];
      const subresponses = new Map(
        rawSubresponses.filter(isRecord).map((item) => [
          typeof item.id === "string" ? item.id : "",
          item as {
          id?: string;
          status?: number;
          headers?: Record<string, string>;
          body?: unknown;
          },
        ]),
      );
      for (let index = 0; index < batchPaths.length; index++) {
        const path = batchPaths[index];
        const subresponse = subresponses.get(String(index + 1));
        if (subresponse?.status === 200 && isRecord(subresponse.body)) {
          resolved.set(path, subresponse.body as unknown as DriveItem);
          continue;
        }
        if (subresponse?.status === 404) {
          resolved.set(path, null);
          continue;
        }
        if (subresponse?.status === 401 || subresponse?.status === 403) {
          throw this.classifyError({
            status: subresponse.status,
            headers: subresponse.headers ?? {},
            json: isRecord(subresponse.body) ? subresponse.body : {},
          } as RequestUrlResponse);
        }
        if (
          subresponse?.status === 429
          || (typeof subresponse?.status === "number"
            && [500, 502, 503, 504].includes(subresponse.status))
        ) {
          const error = this.classifyError({
            status: subresponse.status,
            headers: subresponse.headers ?? {},
            json: isRecord(subresponse.body) ? subresponse.body : {},
          } as RequestUrlResponse);
          await sleepWithAbort(retryDelayMs(error, 1), this.abortSignal);
        }
        resolved.set(
          path,
          await this.getDriveItemMetadata(vaultName, path),
        );
      }
    }
    return resolved;
  }

  /** List every direct child of one committed folder identity.
   *  Folder deletion callers use this immediately before DELETE and therefore
   *  must consume every Graph page rather than trusting childCount metadata. */
  async listFolderChildrenById(driveItemId: string): Promise<DriveItem[]> {
    const children: DriveItem[] = [];
    let url = `/me/drive/items/${encodeURIComponent(driveItemId)}/children`;
    while (url) {
      const response = await this.request("GET", url);
      const data = response.json as {
        value?: DriveItem[];
        "@odata.nextLink"?: string;
      };
      const page = data.value ?? [];
      if (page.some((item) => item.parentReference?.id !== driveItemId)) {
        throw new Error(`Folder child listing returned a different parent identity: ${driveItemId}`);
      }
      children.push(...page);
      url = data["@odata.nextLink"] ?? "";
    }
    return children;
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

    const createMissing = options.createMissing ?? true;
    // Graph creates the dedicated App Folder when the special folder itself
    // is requested. Do this before probing named descendants on a fresh drive.
    // Read-only callers deliberately skip it because that GET can create the
    // app root as an observable remote side effect.
    const appRoot = createMissing ? await this.getAppFolder() : null;
    const storageVaultName = await this.resolveStorageVaultName(vaultName);
    this.storageVaultNames.set(vaultName, storageVaultName);

    const vaultPath = APP_FOLDER_PATHS.vaultDir(storageVaultName);
    const filesPath = APP_FOLDER_PATHS.filesDir(storageVaultName);
    let vaultFolder: DriveItem;
    let filesFolder: DriveItem;
    let driveId: string | undefined;

    if (createMissing) {
      if (
        !appRoot
        || !appRoot.id
        || !appRoot.folder
        || (
          appRoot.specialFolder
          && appRoot.specialFolder.name !== "approot"
          && appRoot.specialFolder.name !== "appRoot"
        )
      ) {
        throw new Error("Invalid App Folder root metadata");
      }
      driveId = appRoot.parentReference?.driveId;
      const vaultsFolder = await this.ensureFolderByParentId(
        appRoot.id,
        "vaults",
        driveId,
      );
      driveId ??= vaultsFolder.parentReference?.driveId;
      vaultFolder = await this.ensureFolderByParentId(
        vaultsFolder.id,
        storageVaultName,
        driveId,
      );
      driveId ??= vaultFolder.parentReference?.driveId;
      filesFolder = await this.ensureFolderByParentId(
        vaultFolder.id,
        "files",
        driveId,
      );
      driveId ??= filesFolder.parentReference?.driveId;
      await this.ensureFolderByParentId(
        vaultFolder.id,
        ".easy-sync",
        driveId,
      );
    } else {
      vaultFolder = (
        await this.request("GET", vaultPath)
      ).json as DriveItem;
      filesFolder = (
        await this.request("GET", filesPath)
      ).json as DriveItem;
      driveId = filesFolder.parentReference?.driveId
        ?? vaultFolder.parentReference?.driveId;
    }

    if (!vaultFolder.id || !vaultFolder.folder) {
      throw new Error(`Invalid vault folder metadata: ${vaultPath}`);
    }

    if (!filesFolder.id || !filesFolder.folder) {
      throw new Error(`Invalid files root metadata: ${filesPath}`);
    }
    if (
      filesFolder.parentReference?.id
      && filesFolder.parentReference.id !== vaultFolder.id
    ) {
      throw new Error(`Files root parent identity mismatch: ${filesPath}`);
    }

    if (!driveId) {
      const drive = (await this.request("GET", "/me/drive?$select=id")).json as { id?: string };
      driveId = drive.id;
    }
    if (!driveId) throw new Error(`Missing drive identity for vault: ${vaultName}`);

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

  /**
   * Restore a committed scope from Graph-owned identities when a delta cursor
   * is missing or unusable. This is the authoritative fallback for legacy
   * encoded vault directories: names choose presentation paths, IDs choose the
   * actual storage tree.
   */
  async restoreVaultScopeByIdentity(
    vaultName: string,
    scope: RemoteVaultScope,
  ): Promise<RemoteVaultScope> {
    if (!scope.driveId || !scope.vaultFolderId || !scope.filesRootId) {
      throw new RemoteVaultScopeIdentityError("scope-incomplete");
    }
    const [vaultResponse, filesResponse] = await Promise.all([
      this.request(
        "GET",
        `/me/drive/items/${encodeURIComponent(scope.vaultFolderId)}`,
      ),
      this.request(
        "GET",
        `/me/drive/items/${encodeURIComponent(scope.filesRootId)}`,
      ),
    ]);
    const vaultFolder = vaultResponse.json as DriveItem;
    const filesFolder = filesResponse.json as DriveItem;
    const allowedVaultNames = new Set([vaultName, encodeURIComponent(vaultName)]);
    if (
      vaultFolder.id !== scope.vaultFolderId
      || !vaultFolder.folder
      || !vaultFolder.name
      || !allowedVaultNames.has(vaultFolder.name)
    ) {
      throw new RemoteVaultScopeIdentityError("vault-folder-invalid");
    }
    if (
      filesFolder.id !== scope.filesRootId
      || !filesFolder.folder
      || filesFolder.name !== "files"
      || filesFolder.parentReference?.id !== scope.vaultFolderId
    ) {
      throw new RemoteVaultScopeIdentityError("files-root-invalid");
    }
    const observedDriveIds = [
      vaultFolder.parentReference?.driveId,
      filesFolder.parentReference?.driveId,
    ].filter((value): value is string => Boolean(value));
    if (observedDriveIds.some((value) => value !== scope.driveId)) {
      throw new RemoteVaultScopeIdentityError("drive-invalid");
    }

    this.storageVaultNames.set(vaultName, vaultFolder.name);
    this.vaultScopes.set(vaultName, { ...scope });
    this.initializedVaults.add(vaultName);
    return { ...scope };
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

  /** Upload a file, using an upload session above 4 MiB.
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
    const targetPath = driveItemId
      ? `/me/drive/items/${encodeURIComponent(driveItemId)}`
      : APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath);
    if (shouldUseUploadSession(content.byteLength)) {
      return this.uploadLargeFile(
        filePath,
        driveItemId
          ? `${targetPath}/createUploadSession`
          : `${targetPath}:/createUploadSession`,
        content,
        onProgress,
        eTag,
        driveItemId ? "replace" : "fail",
      );
    }
    const apiPath = driveItemId
      ? `${targetPath}/content`
      : `${targetPath}:/content?@microsoft.graph.conflictBehavior=fail`;
    const headers: Record<string, string> = {};
    if (eTag) headers["If-Match"] = eTag;
    const response = await this.request(
      "PUT",
      apiPath,
      content,
      "application/octet-stream",
      {
        extraHeaders: headers,
        // A single non-resumable PUT must outlive slow uploads. The flat 15s
        // REQUEST_TIMEOUT_MS misclassified slow-but-successful uploads as
        // network failures, so reuse the upload-session transfer budget (min
        // 30s, rate-scaled, capped 5min). Timeout outcome stays non-retryable.
        perRequestTimeoutMs: uploadSessionChunkTimeoutMs(content.byteLength, null),
      },
    );
    onProgress?.(content.byteLength, content.byteLength);
    return response.json as UploadResult;
  }

  private async uploadLargeFile(
    displayPath: string,
    apiPath: string,
    content: ArrayBuffer,
    onProgress?: UploadProgressCallback,
    eTag?: string,
    conflictBehavior: "fail" | "replace" = "fail",
  ): Promise<UploadResult> {
    throwIfAborted(this.abortSignal);
    const extraHeaders = eTag ? { "If-Match": eTag } : undefined;
    const sessionResponse = await this.request(
      "POST",
      apiPath,
      {
        item: { "@microsoft.graph.conflictBehavior": conflictBehavior },
      },
      undefined,
      { extraHeaders },
    );
    const uploadUrl = (sessionResponse.json as { uploadUrl?: string }).uploadUrl;
    if (!uploadUrl) {
      throw new OneDriveError(
        OneDriveErrorType.Unknown,
        `Upload session did not return an uploadUrl: ${displayPath}`,
      );
    }

    this.diag?.log(
      "onedrive",
      `large upload session — path=${displayPath}, bytes=${content.byteLength}`,
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
            `Upload session returned an invalid missing range: ${displayPath}`,
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
            `Upload session returned unexpected status ${response.status}: ${displayPath}`,
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
            `Upload session did not advance after an accepted fragment: ${displayPath}`,
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
          `large upload progress — path=${displayPath}, uploaded=${reportedProgress}/${content.byteLength}, chunkBytes=${chunk.byteLength}, timeoutMs=${timeoutMs}`,
        );
        onProgress?.(reportedProgress, content.byteLength);
      }

      throw new OneDriveError(
        OneDriveErrorType.Unknown,
        `Upload session ended without a completed driveItem: ${displayPath}`,
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

  /** Keep route selection identical while each public entry owns its sink. */
  private async downloadWithWaterfall<T>(input: {
    operationName: "downloadFile" | "downloadFileToPath";
    vaultName: string;
    filePath: string;
    downloadUrl?: string;
    driveItemId?: string;
    fileSize: number;
    onProgress?: (downloaded: number, total: number) => void;
    loadDownloadUrl: (
      url: string,
      signal: AbortSignal,
    ) => Promise<{ value: T; bytes: number }>;
    loadRequestUrlResponse: (
      response: RequestUrlResponse,
    ) => Promise<{ value: T; bytes: number }>;
    loadContent: (
      apiPath: string,
      requestOptions: RequestOptions,
    ) => Promise<T>;
    afterContentShortcut?: (value: T) => void;
    afterHintDownload?: (value: T) => void;
  }): Promise<T> {
    throwIfAborted(this.abortSignal);
    const maxResponseBytes = remoteFileByteBudget(input.fileSize, input.filePath);
    let metadataAuthError: OneDriveError | null = null;
    const primaryTimeoutMs = downloadTimeoutMs(input.fileSize);
    const failureReserveMs = Math.ceil(
      primaryTimeoutMs * DOWNLOAD_FAILURE_RESERVE_RATIO,
    );
    const timeoutMs = primaryTimeoutMs + failureReserveMs;
    const deadlineMs = Date.now() + timeoutMs;
    const remainingMs = () =>
      ensureDownloadBudget(deadlineMs, input.filePath);
    const loadDownloadUrl = async (
      url: string,
      maxAttempts: number,
    ): Promise<T> => {
      let observedAttempt = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        observedAttempt++;
        const fetchStartedAt = this.beginMetricAttempt("downloadUrl");
        try {
          const result = await withAbortableTimeout(
            (signal) => input.loadDownloadUrl(url, signal),
            remainingMs(),
            this.abortSignal,
          );
          this.finishMetricAttempt(
            "downloadUrl",
            "success",
            fetchStartedAt,
            result.bytes,
            observedAttempt > 1 ? result.bytes : 0,
          );
          return result.value;
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
          if (isResponseByteBudgetError(error)) throw error;
          let err = error;
          if (
            err instanceof TypeError
            || (err as { status?: number }).status === 0
          ) {
            observedAttempt++;
            const fallbackStartedAt = this.beginMetricAttempt("downloadUrl");
            try {
              throwIfAborted(this.abortSignal);
              const response = await withTimeout(
                requestUrl({ url, method: "GET" }),
                remainingMs(),
              );
              const result = await input.loadRequestUrlResponse(response);
              this.finishMetricAttempt(
                "downloadUrl",
                "success",
                fallbackStartedAt,
                result.bytes,
                observedAttempt > 1 ? result.bytes : 0,
              );
              return result.value;
            } catch (fallbackErr) {
              this.finishMetricAttempt(
                "downloadUrl",
                rawAttemptStatus(fallbackErr, this.abortSignal),
                fallbackStartedAt,
              );
              if (isResponseByteBudgetError(fallbackErr)) throw fallbackErr;
              err = fallbackErr;
            }
          }
          if (isUncancellableRequestTimeout(err)) {
            throw downloadTimeoutError(input.filePath);
          }
          if (
            attempt === maxAttempts
            || !isTransientDownloadUrlError(err)
          ) {
            throw err;
          }
          const remaining = remainingMs();
          if (remaining <= RETRY_BASE_MS) throw err;
          this.diag?.warn(
            "onedrive",
            `${input.operationName} "${input.filePath}" — CDN retry ${attempt + 1}/${maxAttempts}, remainingMs=${remaining}`,
            requestErrorMessage(err),
          );
          await sleepWithAbort(RETRY_BASE_MS, this.abortSignal);
        }
      }
      throw new OneDriveError(
        OneDriveErrorType.NetworkError,
        `Download failed for: ${input.filePath}`,
      );
    };
    const contentRequestOptions: RequestOptions = {
      deadlineMs,
      maxAttempts: 2,
      perRequestTimeoutMs: DOWNLOAD_MAX_TIMEOUT_MS,
      maxResponseBytes,
      responseLabel: `Remote file "${input.filePath}"`,
    };
    const metaRequestOptions: RequestOptions = {
      deadlineMs,
      maxAttempts: 1,
      metadataReason: "downloadUrlRefresh",
    };
    this.diag?.log(
      "onedrive",
      `${input.operationName} "${input.filePath}" — size=${input.fileSize}, primaryMs=${primaryTimeoutMs}, reserveMs=${failureReserveMs}, budgetMs=${timeoutMs}, hint=${this.downloadMethod ?? "none"}`,
    );
    input.onProgress?.(0, input.fileSize);

    if (this.downloadMethod === "content" && input.driveItemId) {
      const tierStartMs = Date.now();
      try {
        const apiPath = `${APP_FOLDER_PATHS.filePath(
          this.getStorageVaultName(input.vaultName),
          input.filePath,
        )}:/content`;
        const value = await input.loadContent(apiPath, contentRequestOptions);
        input.afterContentShortcut?.(value);
        return value;
      } catch (err) {
        if (isResponseByteBudgetError(err)) throw err;
        if (isUncancellableRequestTimeout(err)) {
          throw downloadTimeoutError(input.filePath);
        }
        if (isAuthExpired(err)) throw err;
        this.diag?.warn(
          "onedrive",
          `${input.operationName} "${input.filePath}" — content shortcut failed, falling back to full waterfall`,
          { ...downloadErrorData(err), tierMs: Date.now() - tierStartMs },
        );
      }
    }

    if (input.downloadUrl && !this.cdnFailedThisRound) {
      const tierStartMs = Date.now();
      try {
        const value = await loadDownloadUrl(input.downloadUrl, 1);
        this.downloadMethod = "downloadUrl";
        input.afterHintDownload?.(value);
        return value;
      } catch (err) {
        if (isResponseByteBudgetError(err)) throw err;
        this.diag?.warn(
          "onedrive",
          `${input.operationName} "${input.filePath}" — downloadUrl failed, trying item metadata`,
          { ...downloadErrorData(err), tierMs: Date.now() - tierStartMs },
        );
        this.cdnFailedThisRound = true;
        remainingMs();
      }
    }

    if (input.driveItemId) {
      const tierStartMs = Date.now();
      try {
        throwIfAborted(this.abortSignal);
        const metaResp = await this.request(
          "GET",
          `/me/drive/items/${input.driveItemId}?select=id,name,size,file,@microsoft.graph.downloadUrl`,
          undefined,
          undefined,
          metaRequestOptions,
        );
        const meta = metaResp.json as {
          "@microsoft.graph.downloadUrl"?: string;
        };
        if (meta["@microsoft.graph.downloadUrl"]) {
          const value = await loadDownloadUrl(
            meta["@microsoft.graph.downloadUrl"],
            input.downloadUrl ? 1 : 2,
          );
          this.downloadMethod = "downloadUrl";
          return value;
        }
      } catch (err) {
        if (isResponseByteBudgetError(err)) throw err;
        if (isAuthExpired(err)) metadataAuthError = err;
        this.diag?.warn(
          "onedrive",
          `${input.operationName} "${input.filePath}" — item metadata downloadUrl failed, trying path /content`,
          { ...downloadErrorData(err), tierMs: Date.now() - tierStartMs },
        );
        this.cdnFailedThisRound = true;
        remainingMs();
      }
    }

    if (this.contentFailedThisRound) {
      this.diag?.log(
        "onedrive",
        `${input.operationName} "${input.filePath}" — /content blocked this round, no fallback available`,
      );
      throw new OneDriveError(
        OneDriveErrorType.NetworkError,
        `Content endpoint unavailable for: ${input.filePath}`,
      );
    }

    const pathTierStartMs = Date.now();
    try {
      this.diag?.log(
        "onedrive",
        `${input.operationName} "${input.filePath}" — executing path /content fallback, remainingMs=${remainingMs()}`,
      );
      const apiPath = `${APP_FOLDER_PATHS.filePath(
        this.getStorageVaultName(input.vaultName),
        input.filePath,
      )}:/content`;
      const value = await input.loadContent(apiPath, contentRequestOptions);
      this.downloadMethod = "content";
      return value;
    } catch (err) {
      if (isResponseByteBudgetError(err)) throw err;
      if (isUncancellableRequestTimeout(err)) {
        throw downloadTimeoutError(input.filePath);
      }
      if (isAuthExpired(err)) {
        throw metadataAuthError
          ?? asFileDownloadUnauthorized(err, input.filePath);
      }
      this.diag?.warn(
        "onedrive",
        `${input.operationName} "${input.filePath}" — path /content failed, trying item ID /content`,
        { ...downloadErrorData(err), tierMs: Date.now() - pathTierStartMs },
      );
      remainingMs();
    }

    if (input.driveItemId) {
      const itemTierStartMs = Date.now();
      try {
        throwIfAborted(this.abortSignal);
        this.diag?.log(
          "onedrive",
          `${input.operationName} "${input.filePath}" — executing item ID /content fallback, remainingMs=${remainingMs()}`,
        );
        const value = await input.loadContent(
          `/me/drive/items/${input.driveItemId}/content`,
          contentRequestOptions,
        );
        this.downloadMethod = "content";
        return value;
      } catch (err) {
        if (isResponseByteBudgetError(err)) throw err;
        if (isAuthExpired(err)) {
          throw metadataAuthError
            ?? asFileDownloadUnauthorized(err, input.filePath);
        }
        this.diag?.warn(
          "onedrive",
          `${input.operationName} "${input.filePath}" — item ID /content failed, no remaining fallback`,
          { ...downloadErrorData(err), tierMs: Date.now() - itemTierStartMs },
        );
        this.contentFailedThisRound = true;
        throw err;
      }
    }

    this.contentFailedThisRound = true;
    throw new OneDriveError(
      OneDriveErrorType.NotFound,
      `No download method available for: ${input.filePath}`,
    );
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
    const maxResponseBytes = remoteFileByteBudget(fileSize, filePath);
    return this.downloadWithWaterfall({
      operationName: "downloadFile",
      vaultName,
      filePath,
      downloadUrl,
      driveItemId,
      fileSize,
      onProgress,
      loadDownloadUrl: async (url, signal) => {
        const response = await downloadUrlFetch(
          url,
          maxResponseBytes,
          `Remote file "${filePath}"`,
          onProgress,
          signal,
        );
        return {
          value: response.arrayBuffer,
          bytes: responsePayloadByteLength(response),
        };
      },
      loadRequestUrlResponse: async (response) => {
        assertResponseByteBudget(
          response,
          maxResponseBytes,
          `Remote file "${filePath}"`,
        );
        return {
          value: response.arrayBuffer,
          bytes: responsePayloadByteLength(response),
        };
      },
      loadContent: async (apiPath, requestOptions) =>
        (await this.contentGet(apiPath, requestOptions, onProgress)).arrayBuffer,
      afterContentShortcut: (buffer) => {
        onProgress?.(0, fileSize || buffer.byteLength);
        onProgress?.(buffer.byteLength, fileSize || buffer.byteLength);
      },
      afterHintDownload: (buffer) => {
        onProgress?.(buffer.byteLength, fileSize || buffer.byteLength);
      },
    });
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
    const maxResponseBytes = remoteFileByteBudget(fileSize, filePath);
    return this.downloadWithWaterfall({
      operationName: "downloadFileToPath",
      vaultName,
      filePath,
      downloadUrl,
      driveItemId,
      fileSize,
      onProgress,
      loadDownloadUrl: async (url, signal) => {
        const result = await downloadUrlFetchToBinaryFile(
          url,
          adapter,
          localPath,
          expectedSha256,
          maxResponseBytes,
          `Remote file "${filePath}"`,
          onProgress,
          signal,
        );
        return { value: result, bytes: result.size };
      },
      loadRequestUrlResponse: async (response) => {
        const result = await writeArrayBufferToBinaryFile(
          adapter,
          localPath,
          response.arrayBuffer,
          expectedSha256,
          fileSize,
          maxResponseBytes,
          `Remote file "${filePath}"`,
          onProgress,
        );
        return { value: result, bytes: result.size };
      },
      loadContent: (apiPath, requestOptions) =>
        this.contentGetToPath(
          apiPath,
          adapter,
          localPath,
          expectedSha256,
          requestOptions,
          onProgress,
        ),
    });
  }

  /** Delete a file or folder.
   *  @param matchTag  When set, the DELETE includes an If-Match header. Use a
   *                   folder cTag for an empty-folder delete because its eTag
   *                   does not reliably change when descendants change. */
  async deleteItem(
    vaultName: string,
    itemPath: string,
    matchTag?: string,
    driveItemId?: string,
  ): Promise<void> {
    const apiPath = driveItemId
      ? `/me/drive/items/${encodeURIComponent(driveItemId)}`
      : APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), itemPath);
    await this.request("DELETE", apiPath, undefined, undefined, undefined, matchTag);
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
    const response = await this.request("PATCH", apiPath, { name: newName }, undefined, undefined, eTag);
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
  ): Promise<{
    eTag: string;
    cTag: string;
    size: number;
    sha256Hash?: string;
    quickXorHash?: string;
    downloadUrl?: string;
    driveId: string;
    parentId?: string;
    mtime: number;
  } | null> {
    try {
      const apiPath = APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath);
      const response = await this.request(
        "GET",
        apiPath,
        undefined,
        undefined,
        { metadataReason, expectedNotFound: true },
      );
      const item = response.json as DriveItem;
      if (!item.file) return null;
      return {
        eTag: item.eTag ?? "",
        cTag: item.cTag ?? "",
        size: item.size ?? 0,
        sha256Hash: item.file?.hashes?.sha256Hash?.toLowerCase(),
        quickXorHash: item.file?.hashes?.quickXorHash,
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
      assertDeclaredRemoteSize(
        baseline.size,
        MAX_LEGACY_BASELINE_BYTES,
        "Cloud baseline",
      );

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
          return responseToText(
            downloadResp,
            MAX_LEGACY_BASELINE_BYTES,
            "Cloud baseline",
          );
        } catch (error) {
          if (isResponseByteBudgetError(error)) throw error;
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
            size?: number;
            "@microsoft.graph.downloadUrl"?: string;
          };
          assertDeclaredRemoteSize(
            meta.size,
            MAX_LEGACY_BASELINE_BYTES,
            "Cloud baseline",
          );
          if (meta["@microsoft.graph.downloadUrl"]) {
            const downloadResp = await withTimeout(
              requestUrl({
                url: meta["@microsoft.graph.downloadUrl"],
                method: "GET",
              }),
              8000,
            );
            this.diag?.log("onedrive", "cloud baseline downloaded via item metadata downloadUrl fallback");
            return responseToText(
              downloadResp,
              MAX_LEGACY_BASELINE_BYTES,
              "Cloud baseline",
            );
          }
        } catch (error) {
          if (isResponseByteBudgetError(error)) throw error;
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
        {
          maxResponseBytes: MAX_LEGACY_BASELINE_BYTES,
          responseLabel: "Cloud baseline",
        },
      );
      this.diag?.log("onedrive", "cloud baseline downloaded via direct item /content fallback");
      return responseToText(
        response,
        MAX_LEGACY_BASELINE_BYTES,
        "Cloud baseline",
      );
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
    return this.readPluginControlItemV2(item, "CloudBootstrapV2");
  }

  async readCloudBootstrapV2ById(
    id: string,
  ): Promise<{ id: string; eTag: string; content: string }> {
    const metaResp = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(id)}?select=id,name,size,eTag,file,@microsoft.graph.downloadUrl`,
    );
    return this.readPluginControlItemV2(
      metaResp.json as DriveItem,
      "CloudBootstrapV2",
    );
  }

  async createCloudBootstrapV2(
    vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const apiPath = `${APP_FOLDER_PATHS.pluginDir(this.getStorageVaultName(vaultName))}/bootstrap-v2.json:/content?@microsoft.graph.conflictBehavior=fail`;
    const response = await this.request("PUT", apiPath, content, "application/json");
    return requirePluginControlFileVersion(response.json, "CloudBootstrapV2");
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
      {},
      eTag,
    );
    return requirePluginControlFileVersion(response.json, "CloudBootstrapV2");
  }

  // ---- Shared Sync Protocol V2 ----

  /** Read the fixed V2 and V3 slots from one complete control-directory
   * observation. The directory snapshot is never cached across sync rounds;
   * body reads may run in parallel only after every directory page is known. */
  async readSharedSyncProtocolObjects(
    vaultName: string,
  ): Promise<SharedSyncProtocolObjectsObservation> {
    const storageVaultName = this.getStorageVaultName(vaultName);
    const requestOwnerPrefix = `sharedProtocol:${storageVaultName}`;
    const children = await this.listSharedSyncProtocolControlChildren(
      storageVaultName,
      `${requestOwnerPrefix}:directory`,
    );

    let v2Item: DriveItem | null;
    let v3Item: DriveItem | null;
    try {
      v2Item = selectSharedSyncProtocolSlot(children, "protocol-v2.json");
      v3Item = selectSharedSyncProtocolSlot(children, "protocol-v3.json");
    } catch (error) {
      throw new SharedSyncProtocolObservationError("directory", error);
    }

    const [v2, v3] = await Promise.all([
      v2Item
        ? this.readObservedSharedSyncProtocolItem(
          v2Item,
          "SharedSyncProtocolV2",
          `${requestOwnerPrefix}:v2`,
        )
          .catch((error: unknown) => {
            throw new SharedSyncProtocolObservationError("v2", error);
          })
        : null,
      v3Item
        ? this.readObservedSharedSyncProtocolItem(
          v3Item,
          "SharedSyncProtocolV3",
          `${requestOwnerPrefix}:v3`,
        )
          .catch((error: unknown) => {
            throw new SharedSyncProtocolObservationError("v3", error);
          })
        : null,
    ]);
    return { v2, v3 };
  }

  private async listSharedSyncProtocolControlChildren(
    storageVaultName: string,
    requestKey: string,
  ): Promise<DriveItem[]> {
    const children: DriveItem[] = [];
    const observedPages = new Set<string>();
    let url: string | null =
      `${APP_FOLDER_PATHS.pluginDir(storageVaultName)}:/children?select=id,name,size,eTag,file,@microsoft.graph.downloadUrl`;
    while (url) {
      if (observedPages.has(url)) {
        throw new Error("Shared sync protocol directory pagination repeated a page");
      }
      observedPages.add(url);
      const response = await this.request(
        "GET",
        url,
        undefined,
        undefined,
        { sharedSyncProtocolRequestKey: requestKey },
      );
      const data = response.json as {
        value?: DriveItem[];
        "@odata.nextLink"?: unknown;
      };
      if (!Array.isArray(data.value)) {
        throw new Error("Shared sync protocol directory response is invalid");
      }
      children.push(...data.value);
      const nextLink = data["@odata.nextLink"];
      if (nextLink === undefined) {
        url = null;
      } else if (typeof nextLink === "string" && nextLink.length > 0) {
        url = nextLink;
      } else {
        throw new Error("Shared sync protocol directory continuation is invalid");
      }
    }
    return children;
  }

  /** Read bytes bound to the exact directory observation. A missing download
   * URL invalidates the whole profile; refreshing one slot independently or
   * falling back to current-by-ID content would mix two observation times. */
  private async readObservedSharedSyncProtocolItem(
    item: DriveItem,
    label: "SharedSyncProtocolV2" | "SharedSyncProtocolV3",
    requestKey: string,
  ): Promise<SharedSyncProtocolControlObject> {
    const downloadUrl = item["@microsoft.graph.downloadUrl"];
    if (!item.id || !item.eTag || !downloadUrl) {
      throw new Error(`${label} directory observation is incomplete`);
    }
    const maxResponseBytes = pluginControlByteBudget(label);
    assertDeclaredRemoteSize(item.size, maxResponseBytes, label);
    let response: RequestUrlResponse;
    try {
      response = await this.requestSharedSyncProtocolUrl(
        requestKey,
        8000,
        () => requestUrl({
          url: downloadUrl,
          method: "GET",
        }),
      );
    } catch (error) {
      if (isResponseByteBudgetError(error)) throw error;
      if (error instanceof SyntheticRequestTimeoutError) {
        this.diag?.warn(
          "onedrive",
          error.source === "deadline"
            ? `request local deadline elapsed — method=GET, endpoint=sharedProtocolContent, timeoutMs=${error.timeoutMs}, HTTP status unavailable`
            : `request not dispatched — method=GET, endpoint=sharedProtocolContent, prior requestUrl remains in flight after timeoutMs=${error.timeoutMs}, HTTP status unavailable`,
        );
        throw error;
      }
      throw this.toRequestError(error, downloadUrl);
    }
    return {
      id: item.id,
      eTag: item.eTag,
      content: responseToText(response, maxResponseBytes, label),
    };
  }

  private requestSharedSyncProtocolUrl(
    requestKey: string,
    timeoutMs: number,
    dispatch: () => Promise<RequestUrlResponse>,
  ): Promise<RequestUrlResponse> {
    if (this.sharedSyncProtocolRequestsInFlight.has(requestKey)) {
      return Promise.reject(new SyntheticRequestTimeoutError(
        timeoutMs,
        "prior-request-in-flight",
      ));
    }

    const rawRequest = dispatch();
    this.sharedSyncProtocolRequestsInFlight.set(requestKey, rawRequest);
    let localDeadlineElapsed = false;
    const releaseOwner = (outcome: "fulfilled" | "rejected") => {
      if (this.sharedSyncProtocolRequestsInFlight.get(requestKey) === rawRequest) {
        this.sharedSyncProtocolRequestsInFlight.delete(requestKey);
      }
      if (localDeadlineElapsed) {
        const component = requestKey.slice(requestKey.lastIndexOf(":") + 1);
        this.diag?.log(
          "onedrive",
          "shared protocol request settled after its local deadline",
          {
            component,
            source: "late-settlement",
            outcome,
          },
        );
      }
    };
    // Both settlement paths are handled even after the local timeout has won.
    // The late value only releases ownership; it is never returned to a later
    // observation.
    void rawRequest.then(
      () => releaseOwner("fulfilled"),
      () => releaseOwner("rejected"),
    );
    return withTimeout(rawRequest, timeoutMs).catch((error: unknown) => {
      if (
        error instanceof SyntheticRequestTimeoutError
        && error.source === "deadline"
      ) {
        localDeadlineElapsed = true;
        // Release ownership at the local deadline so the next sync round can
        // re-dispatch instead of being permanently blocked when the underlying
        // requestUrl promise never settles. The identity check keeps a newer
        // owner intact; the late settlement then only logs (its value is never
        // returned to a later observation).
        if (this.sharedSyncProtocolRequestsInFlight.get(requestKey) === rawRequest) {
          this.sharedSyncProtocolRequestsInFlight.delete(requestKey);
        }
      }
      throw error;
    });
  }

  async readSharedSyncProtocolV2(
    vaultName: string,
  ): Promise<{ id: string; eTag: string; content: string } | null> {
    const storageVaultName = this.getStorageVaultName(vaultName);
    const childrenResp = await this.request(
      "GET",
      `${APP_FOLDER_PATHS.pluginDir(storageVaultName)}:/children`,
    );
    const children = (childrenResp.json as { value?: DriveItem[] }).value ?? [];
    const item = children.find(
      (entry) => entry.name === "protocol-v2.json" && entry.file,
    );
    if (!item) return null;
    return this.readPluginControlItemV2(item, "SharedSyncProtocolV2");
  }

  async readSharedSyncProtocolV2ById(
    id: string,
  ): Promise<{ id: string; eTag: string; content: string }> {
    const metaResp = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(id)}?select=id,name,size,eTag,file,@microsoft.graph.downloadUrl`,
    );
    return this.readPluginControlItemV2(
      metaResp.json as DriveItem,
      "SharedSyncProtocolV2",
    );
  }

  async createSharedSyncProtocolV2(
    vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const apiPath = `${APP_FOLDER_PATHS.pluginDir(this.getStorageVaultName(vaultName))}/protocol-v2.json:/content?@microsoft.graph.conflictBehavior=fail`;
    const response = await this.request(
      "PUT",
      apiPath,
      content,
      "application/json",
    );
    return requirePluginControlFileVersion(
      response.json,
      "SharedSyncProtocolV2",
    );
  }

  // ---- Shared Sync Protocol V3 ----

  async readSharedSyncProtocolV3(
    vaultName: string,
  ): Promise<{ id: string; eTag: string; content: string } | null> {
    const storageVaultName = this.getStorageVaultName(vaultName);
    const childrenResp = await this.request(
      "GET",
      `${APP_FOLDER_PATHS.pluginDir(storageVaultName)}:/children`,
    );
    const children = (childrenResp.json as { value?: DriveItem[] }).value ?? [];
    const item = children.find(
      (entry) => entry.name === "protocol-v3.json" && entry.file,
    );
    if (!item) return null;
    return this.readPluginControlItemV2(item, "SharedSyncProtocolV3");
  }

  async readSharedSyncProtocolV3ById(
    id: string,
  ): Promise<{ id: string; eTag: string; content: string }> {
    const metaResp = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(id)}?select=id,name,size,eTag,file,@microsoft.graph.downloadUrl`,
    );
    return this.readPluginControlItemV2(
      metaResp.json as DriveItem,
      "SharedSyncProtocolV3",
    );
  }

  async createSharedSyncProtocolV3(
    vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const apiPath = `${APP_FOLDER_PATHS.pluginDir(this.getStorageVaultName(vaultName))}/protocol-v3.json:/content?@microsoft.graph.conflictBehavior=fail`;
    const response = await this.request(
      "PUT",
      apiPath,
      content,
      "application/json",
    );
    return requirePluginControlFileVersion(
      response.json,
      "SharedSyncProtocolV3",
    );
  }

  // ---- Community-plugin lifecycle V1 ----

  async readCommunityPluginLifecycleV1(
    vaultName: string,
  ): Promise<{ id: string; eTag: string; content: string } | null> {
    const storageVaultName = this.getStorageVaultName(vaultName);
    const childrenResp = await this.request(
      "GET",
      `${APP_FOLDER_PATHS.pluginDir(storageVaultName)}:/children`,
    );
    const children = (childrenResp.json as { value?: DriveItem[] }).value ?? [];
    const item = children.find(
      (entry) => entry.name === "community-plugin-lifecycle-v1.json" && entry.file,
    );
    if (!item) return null;
    return this.readPluginControlItemV2(item, "CommunityPluginLifecycleV1");
  }

  async readCommunityPluginLifecycleV1ById(
    id: string,
  ): Promise<{ id: string; eTag: string; content: string }> {
    const metaResp = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(id)}?select=id,name,size,eTag,file,@microsoft.graph.downloadUrl`,
    );
    return this.readPluginControlItemV2(
      metaResp.json as DriveItem,
      "CommunityPluginLifecycleV1",
    );
  }

  async createCommunityPluginLifecycleV1(
    vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const apiPath = `${APP_FOLDER_PATHS.pluginDir(this.getStorageVaultName(vaultName))}/community-plugin-lifecycle-v1.json:/content?@microsoft.graph.conflictBehavior=fail`;
    const response = await this.request("PUT", apiPath, content, "application/json");
    return requirePluginControlFileVersion(response.json, "CommunityPluginLifecycleV1");
  }

  async updateCommunityPluginLifecycleV1(
    id: string,
    eTag: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const response = await this.request(
      "PUT",
      `/me/drive/items/${encodeURIComponent(id)}/content`,
      content,
      "application/json",
      {},
      eTag,
    );
    return requirePluginControlFileVersion(response.json, "CommunityPluginLifecycleV1");
  }

  // ---- Community-plugin generation immutable content ----

  /**
   * Create one immutable generation object below `.easy-sync`. Parent folders
   * are resolved by exact identity first; the object write itself always uses
   * Graph conflictBehavior=fail and therefore never overwrites existing bytes.
   */
  async createCommunityPluginGenerationObjectV1(
    vaultName: string,
    objectPath: string,
    content: ArrayBuffer,
  ): Promise<UploadResult> {
    const segments = communityPluginGenerationObjectSegments(objectPath);
    await this.ensureCommunityPluginGenerationParentV1(
      vaultName,
      segments.slice(0, -1),
    );
    const targetPath = APP_FOLDER_PATHS.pluginItem(
      this.getStorageVaultName(vaultName),
      objectPath,
    );
    if (shouldUseUploadSession(content.byteLength)) {
      return this.uploadLargeFile(
        objectPath,
        `${targetPath}:/createUploadSession`,
        content,
        undefined,
        undefined,
        "fail",
      );
    }
    const response = await this.request(
      "PUT",
      `${targetPath}:/content?@microsoft.graph.conflictBehavior=fail`,
      content,
      "application/octet-stream",
    );
    return response.json as UploadResult;
  }

  /** Resolve an immutable object by its canonical control-root path. */
  async readCommunityPluginGenerationObjectV1(
    vaultName: string,
    objectPath: string,
    maxBytes: number,
  ): Promise<CommunityPluginGenerationCloudObjectV1 | null> {
    const segments = communityPluginGenerationObjectSegments(objectPath);
    const expectedName = segments[segments.length - 1];
    try {
      const response = await this.request(
        "GET",
        `${APP_FOLDER_PATHS.pluginItem(
          this.getStorageVaultName(vaultName),
          objectPath,
        )}?select=id,name,size,eTag,cTag,file,parentReference,@microsoft.graph.downloadUrl`,
        undefined,
        undefined,
        { metadataReason: "other", expectedNotFound: true },
      );
      const item = response.json as DriveItem;
      if (item.name !== expectedName) {
        throw new Error(`Immutable generation object name mismatch: ${objectPath}`);
      }
      return this.readCommunityPluginGenerationObjectItemV1(item, maxBytes);
    } catch (error) {
      if (error instanceof OneDriveError && error.type === OneDriveErrorType.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /** Resolve immutable bytes only by the driveItem identity captured at create. */
  async readCommunityPluginGenerationObjectV1ById(
    id: string,
    maxBytes: number,
  ): Promise<CommunityPluginGenerationCloudObjectV1> {
    if (!id || id.length > 512) throw new Error("Immutable generation object ID is invalid");
    const response = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(id)}?select=id,name,size,eTag,cTag,file,parentReference,@microsoft.graph.downloadUrl`,
      undefined,
      undefined,
      { metadataReason: "other" },
    );
    const item = response.json as DriveItem;
    if (item.id !== id) throw new Error("Immutable generation object identity changed");
    return this.readCommunityPluginGenerationObjectItemV1(item, maxBytes);
  }

  private async ensureCommunityPluginGenerationParentV1(
    vaultName: string,
    segments: readonly string[],
  ): Promise<DriveItem> {
    const storageVaultName = this.getStorageVaultName(vaultName);
    let parentPath = APP_FOLDER_PATHS.pluginDir(storageVaultName);
    let parent = (await this.request("GET", parentPath)).json as DriveItem;
    if (!parent.id || !parent.folder) {
      throw new Error("Plugin control root identity is invalid");
    }
    for (const segment of segments) {
      const childPath = `${parentPath}/${encodeURIComponent(segment)}`;
      const created = await this.createFolder(childPath);
      const child = created ?? (await this.request("GET", childPath)).json as DriveItem;
      if (
        !child.id
        || !child.folder
        || child.name !== segment
        || child.parentReference?.id !== parent.id
      ) {
        throw new Error(`Immutable generation parent identity mismatch: ${segment}`);
      }
      parent = child;
      parentPath = childPath;
    }
    return parent;
  }

  private async readCommunityPluginGenerationObjectItemV1(
    item: DriveItem,
    maxBytes: number,
  ): Promise<CommunityPluginGenerationCloudObjectV1> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_REMOTE_FILE_BYTES) {
      throw new Error("Immutable generation object byte budget is invalid");
    }
    if (
      !item.id
      || !item.file
      || !item.name
      || !item.parentReference?.id
      || !Number.isSafeInteger(item.size)
      || Number(item.size) < 0
      || (!item.eTag && !item.cTag)
    ) {
      throw new Error("Immutable generation object metadata is incomplete");
    }
    assertDeclaredRemoteSize(item.size, maxBytes, "CommunityPluginGenerationObjectV1");
    let content: ArrayBuffer | null = null;
    if (item["@microsoft.graph.downloadUrl"]) {
      try {
        const response = await withAbortableTimeout(
          (signal) => downloadUrlFetch(
            item["@microsoft.graph.downloadUrl"]!,
            maxBytes,
            "CommunityPluginGenerationObjectV1",
            undefined,
            signal,
          ),
          downloadTimeoutMs(Number(item.size)),
          this.abortSignal,
        );
        content = response.arrayBuffer;
      } catch (error) {
        if (isResponseByteBudgetError(error)) throw error;
        rethrowUncancellableRequestTimeout(error);
      }
    }
    if (!content) {
      content = (await this.contentGet(
        `/me/drive/items/${encodeURIComponent(item.id)}/content`,
        {
          maxAttempts: 2,
          maxResponseBytes: maxBytes,
          responseLabel: "CommunityPluginGenerationObjectV1",
        },
      )).arrayBuffer;
    }
    assertByteBudget(content.byteLength, maxBytes, "CommunityPluginGenerationObjectV1");
    return {
      id: item.id,
      name: item.name,
      parentId: item.parentReference.id,
      size: Number(item.size),
      eTag: item.eTag ?? "",
      cTag: item.cTag ?? "",
      content,
    };
  }

  private async readPluginControlItemV2(
    initial: DriveItem,
    label:
      | "CloudBootstrapV2"
      | "SharedSyncProtocolV2"
      | "SharedSyncProtocolV3"
      | "CommunityPluginLifecycleV1",
  ): Promise<{ id: string; eTag: string; content: string }> {
    if (!initial.id) throw new Error(`${label} item has no driveItem id`);
    const maxResponseBytes = pluginControlByteBudget(label);
    let item = initial;
    assertDeclaredRemoteSize(item.size, maxResponseBytes, label);
    if (!item.eTag || !item["@microsoft.graph.downloadUrl"]) {
      const metaResp = await this.request(
        "GET",
        `/me/drive/items/${encodeURIComponent(item.id)}?select=id,name,size,eTag,file,@microsoft.graph.downloadUrl`,
      );
      item = metaResp.json as DriveItem;
      assertDeclaredRemoteSize(item.size, maxResponseBytes, label);
    }
    if (!item.eTag) throw new Error(`${label} item has no eTag`);
    if (item["@microsoft.graph.downloadUrl"]) {
      try {
        const response = await withTimeout(requestUrl({
          url: item["@microsoft.graph.downloadUrl"],
          method: "GET",
        }), 8000);
        return {
          id: item.id,
          eTag: item.eTag,
          content: responseToText(response, maxResponseBytes, label),
        };
      } catch (error) {
        if (isResponseByteBudgetError(error)) throw error;
        rethrowUncancellableRequestTimeout(error);
        // Fall through to the authenticated ID /content path.
      }
    }
    const response = await this.request(
      "GET",
      `/me/drive/items/${encodeURIComponent(item.id)}/content`,
      undefined,
      undefined,
      { maxResponseBytes, responseLabel: label },
    );
    return {
      id: item.id,
      eTag: item.eTag,
      content: responseToText(response, maxResponseBytes, label),
    };
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
    return this.collectDelta(
      deltaToken
        ?? APP_FOLDER_PATHS.filesDelta(this.getStorageVaultName(vaultName)),
    );
  }

  /**
   * Query a delta feed from one Graph-owned folder identity. Scope recovery
   * uses this instead of a path endpoint so a concurrent replacement at the
   * configured path cannot redirect the evidence scan to a different root.
   */
  async getDeltaByFolderId(
    folderId: string,
    deltaToken?: string,
  ): Promise<DeltaResponse> {
    if (!folderId) throw new Error("Missing folder identity for delta");
    return this.collectDelta(
      deltaToken
        ?? `/me/drive/items/${encodeURIComponent(folderId)}/delta`,
    );
  }

  private async collectDelta(initialUrl: string): Promise<DeltaResponse> {
    let url = initialUrl;
    const allValues: DriveItem[] = [];
    let deltaLink: string | undefined;
    let nextLink: string | undefined;

    while (url) {
      const response = await this.request("GET", url);
      const data = response.json as DeltaResponse;
      allValues.push(...data.value);
      deltaLink = data["@odata.deltaLink"];
      nextLink = data["@odata.nextLink"];
      if (deltaLink) validateGraphContinuationUrl(deltaLink);
      if (nextLink) validateGraphContinuationUrl(nextLink);
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
    const url = resolveAuthenticatedGraphUrl(apiPath);
    const token = await this.acquireToken();

    const fetchStartedAt = this.beginMetricAttempt("contentFallback");
    try {
      const timeoutMs = requestTimeoutWithCap(options.deadlineMs, options.perRequestTimeoutMs ?? DOWNLOAD_MAX_TIMEOUT_MS);
      this.diag?.log("onedrive", `contentGet — trying fetch, timeoutMs=${timeoutMs}, url=${sanitizeUrl(url)}`);
      const response = await withAbortableTimeout(
        (signal) => contentUrlFetch(
          url,
          token,
          options.maxResponseBytes,
          options.responseLabel,
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
      if (isResponseByteBudgetError(fetchErr)) throw fetchErr;
      this.diag?.log("onedrive", `content fetch failed, falling back to requestUrl: ${requestErrorMessage(fetchErr)}`);
    }

    // Fall back to requestUrl — may 401 on SharePoint redirect but
    // handles environments where fetch is unavailable.
    return this.request(
      "GET",
      apiPath,
      undefined,
      undefined,
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
    const url = resolveAuthenticatedGraphUrl(apiPath);
    const token = await this.acquireToken();

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
          options.maxResponseBytes,
          options.responseLabel,
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
      if (isResponseByteBudgetError(fetchErr)) throw fetchErr;
      this.diag?.log("onedrive", `content stream fetch failed, falling back to requestUrl: ${requestErrorMessage(fetchErr)}`);
    }

    const response = await this.request(
      "GET",
      apiPath,
      undefined,
      undefined,
      { ...options, observationAttemptOffset: 1 },
    );
    return writeArrayBufferToBinaryFile(
      adapter,
      localPath,
      response.arrayBuffer,
      expectedSha256,
      0,
      options.maxResponseBytes,
      options.responseLabel,
      onProgress,
    );
  }

  private async request(
    method: string,
    apiPath: string,
    body?: unknown,
    contentType?: string,
    options: RequestOptions = {},
    ifMatch?: string,
  ): Promise<RequestUrlResponse> {
    throwIfAborted(this.abortSignal);
    const url = resolveAuthenticatedGraphUrl(apiPath);
    const token = await this.acquireToken();

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
        const dispatch = () => requestUrl({
            url,
            method,
            headers,
            body: requestBody,
            contentType,
          });
        const response = options.sharedSyncProtocolRequestKey
          ? await this.requestSharedSyncProtocolUrl(
            options.sharedSyncProtocolRequestKey,
            timeoutMs,
            dispatch,
          )
          : await withTimeout(dispatch(), timeoutMs);
        if (options.maxResponseBytes !== undefined) {
          assertResponseByteBudget(
            response,
            options.maxResponseBytes,
            options.responseLabel ?? "Graph response",
          );
        }
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
        const syntheticTimeout = rawError instanceof SyntheticRequestTimeoutError;
        const error = syntheticTimeout
          ? new OneDriveError(
              OneDriveErrorType.NetworkError,
              rawError.message,
            )
          : this.toRequestError(rawError, url, options.expectedNotFound === true);
        if (syntheticTimeout) {
          this.diag?.warn(
            "onedrive",
            rawError.source === "deadline"
              ? `request local deadline elapsed — method=${method}, endpoint=${endpoint}, timeoutMs=${rawError.timeoutMs}, HTTP status unavailable`
              : `request not dispatched — method=${method}, endpoint=${endpoint}, prior requestUrl remains in flight after timeoutMs=${rawError.timeoutMs}, HTTP status unavailable`,
          );
        }
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
          throw syntheticTimeout && options.sharedSyncProtocolRequestKey
            ? rawError
            : error;
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
          this.diag?.log("onedrive", `DELETE retry confirmed item already absent — url=${sanitizeUrl(url)}`);
          return { status: 204, headers: {}, json: {} } as RequestUrlResponse;
        }

        if (!isTransientRequestError(error) || attempt === maxAttempts) {
          if (!(method === "PUT" && error.type === OneDriveErrorType.Conflict)) {
            this.diag?.warn(
              "onedrive",
              `request failed — attempt=${attempt}/${maxAttempts}, type=${error.type}, url=${sanitizeUrl(url)}`,
            );
          }
          throw error;
        }

        const waitMs = retryDelayMs(error, attempt);
        this.diag?.warn(
          "onedrive",
          `request retry — attempt=${attempt}/${maxAttempts}, type=${error.type}, waitMs=${waitMs}, url=${sanitizeUrl(url)}`,
        );
        if (options.deadlineMs && Date.now() + waitMs >= options.deadlineMs) {
          throw error;
        }
        await sleepWithAbort(waitMs, this.abortSignal);
      }
    }

    throw new OneDriveError(OneDriveErrorType.Unknown, `Request failed: ${sanitizeUrl(url)}`);
  }

  private toRequestError(
    rawError: unknown,
    url: string,
    suppressExpectedNotFoundWarning = false,
  ): OneDriveError {
    if (rawError instanceof OneDriveError) return rawError;
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
    } else if (errStatus > 0 && !(suppressExpectedNotFoundWarning && errStatus === 404)) {
      this.diag?.warn("onedrive", `requestUrl HTTP error — status=${errStatus}, graphCode=${graphErr?.code || "none"}, graphMsg=${graphErr?.message || "none"}, url=${sanitizeUrl(url)}`);
    } else if (errStatus === 0) {
      this.diag?.warn(
        "onedrive",
        `request transport failed — HTTP status unavailable, url=${sanitizeUrl(url)}`,
      );
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

function communityPluginGenerationObjectSegments(objectPath: string): string[] {
  if (
    typeof objectPath !== "string"
    || objectPath.length === 0
    || objectPath.length > 2_048
    || objectPath.includes("\\")
  ) {
    throw new Error("Immutable generation object path is invalid");
  }
  const segments = objectPath.split("/");
  if (
    segments.length < 2
    || segments[0] !== "community-plugin-content-v1"
    || segments.some((segment) => !/^[a-z0-9][a-z0-9.-]*$/.test(segment))
  ) {
    throw new Error("Immutable generation object path is invalid");
  }
  return segments;
}

function responsePayloadByteLength(response: RequestUrlResponse): number {
  if (response.arrayBuffer instanceof ArrayBuffer) return response.arrayBuffer.byteLength;
  if (typeof response.text === "string") {
    return new TextEncoder().encode(response.text).byteLength;
  }
  if (response.json !== undefined) {
    return new TextEncoder().encode(JSON.stringify(response.json)).byteLength;
  }
  return 0;
}

function remoteFileByteBudget(fileSize: number, filePath: string): number {
  assertDeclaredRemoteSize(
    fileSize,
    MAX_REMOTE_FILE_BYTES,
    `Remote file "${filePath}"`,
  );
  return Number.isFinite(fileSize) && fileSize > 0
    ? fileSize
    : MAX_REMOTE_FILE_BYTES;
}

function pluginControlByteBudget(
  label:
    | "CloudBootstrapV2"
    | "SharedSyncProtocolV2"
    | "SharedSyncProtocolV3"
    | "CommunityPluginLifecycleV1",
): number {
  if (label === "CloudBootstrapV2") return MAX_CLOUD_BOOTSTRAP_BYTES;
  if (label === "CommunityPluginLifecycleV1") {
    return MAX_COMMUNITY_PLUGIN_LIFECYCLE_BYTES;
  }
  return MAX_SHARED_PROTOCOL_BYTES;
}

function selectSharedSyncProtocolSlot(
  children: readonly DriveItem[],
  name: "protocol-v2.json" | "protocol-v3.json",
): DriveItem | null {
  const matches = children.filter((item) => item.name === name);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(`Shared sync protocol slot ${name} is duplicated`);
  }
  const [item] = matches;
  if (!item.file) {
    throw new Error(`Shared sync protocol slot ${name} is not a file`);
  }
  if (
    !item.id
    || !item.eTag
    || typeof item.size !== "number"
    || !Number.isSafeInteger(item.size)
    || item.size < 0
    || typeof item["@microsoft.graph.downloadUrl"] !== "string"
    || item["@microsoft.graph.downloadUrl"]!.length === 0
  ) {
    throw new Error(`Shared sync protocol slot ${name} metadata is incomplete`);
  }
  return item;
}

function assertResponseByteBudget(
  response: RequestUrlResponse,
  maxBytes: number,
  label: string,
): void {
  assertByteBudget(responsePayloadByteLength(response), maxBytes, label);
}

function assertDeclaredRemoteSize(
  size: number | undefined,
  maxBytes: number,
  label: string,
): void {
  if (typeof size === "number" && Number.isFinite(size) && size > maxBytes) {
    throw new ResponseByteBudgetError(label, maxBytes, size);
  }
}

function assertByteBudget(
  observedBytes: number,
  maxBytes: number,
  label: string,
): void {
  if (observedBytes > maxBytes) {
    throw new ResponseByteBudgetError(label, maxBytes, observedBytes);
  }
}

function isResponseByteBudgetError(error: unknown): error is ResponseByteBudgetError {
  return error instanceof ResponseByteBudgetError;
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
  return error instanceof SyntheticRequestTimeoutError
    || (error instanceof Error && error.message.startsWith("Request timed out after "));
}

function rethrowUncancellableRequestTimeout(error: unknown): void {
  if (isRequestTimeoutError(error)) {
    throw new OneDriveError(
      OneDriveErrorType.NetworkError,
      requestErrorMessage(error),
    );
  }
}

function rawStatusCode(error: unknown): number {
  return isRecord(error) && typeof error.status === "number" ? error.status : 0;
}

function isUncancellableRequestTimeout(error: unknown): boolean {
  return error instanceof SyntheticRequestTimeoutError
    || isRequestTimeoutError(error)
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
 * Rejects with a typed local deadline if the promise doesn't resolve within
 * `ms`. Callers decide whether that type is part of their public contract.
 */

const GRAPH_ORIGIN = new URL(GRAPH_BASE_URL).origin;
const GRAPH_API_PATH_PREFIX = new URL(GRAPH_BASE_URL).pathname;

/** Resolve the only routes that may receive a Microsoft Graph bearer token. */
function resolveAuthenticatedGraphUrl(apiPath: string): string {
  let parsed: URL;
  const absoluteUrl = /^[a-z][a-z\d+.-]*:/i.test(apiPath)
    ? apiPath
    : `${GRAPH_BASE_URL}${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;
  try {
    parsed = new URL(absoluteUrl);
  } catch {
    throw new OneDriveError(
      OneDriveErrorType.Unknown,
      "Blocked invalid Microsoft Graph request URL",
    );
  }
  const route = parsed.pathname.slice(GRAPH_API_PATH_PREFIX.length);
  const allowedRoute = route === "/$batch"
    || route === "/me/drive"
    || route.startsWith("/me/drive/")
    || route.startsWith("/drives/");
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== GRAPH_ORIGIN
    || parsed.username !== ""
    || parsed.password !== ""
    || !parsed.pathname.startsWith(`${GRAPH_API_PATH_PREFIX}/`)
    || !allowedRoute
  ) {
    throw new OneDriveError(
      OneDriveErrorType.Unknown,
      `Blocked untrusted Microsoft Graph request: ${sanitizeUrl(apiPath)}`,
    );
  }
  return absoluteUrl;
}

function validateGraphContinuationUrl(url: string): void {
  resolveAuthenticatedGraphUrl(url);
}

/** Strip credentials, query parameters, and fragments from a URL for log safety. */
function sanitizeUrl(url: string): string {
  try {
    const absoluteUrl = /^[a-z][a-z\d+.-]*:/i.test(url)
      ? url
      : `${GRAPH_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
    const u = new URL(absoluteUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = compatSetTimeout(
      () => reject(new SyntheticRequestTimeoutError(ms)),
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

function requirePluginControlFileVersion(
  value: unknown,
  label:
    | "CloudBootstrapV2"
    | "SharedSyncProtocolV2"
    | "SharedSyncProtocolV3"
    | "CommunityPluginLifecycleV1",
): { id: string; eTag: string } {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} write returned no metadata`);
  }
  const item = value as Partial<DriveItem>;
  if (!item.id || !item.eTag) {
    throw new Error(`${label} write returned no id/eTag`);
  }
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

function responseToText(
  response: RequestUrlResponse,
  maxBytes: number,
  label: string,
): string {
  assertResponseByteBudget(response, maxBytes, label);
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

function responseContentLength(response: Response): number {
  const raw = response.headers.get("Content-Length");
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Shared helper: read a fetch Response as ArrayBuffer, optionally reporting
 *  byte-level progress via streaming read.  Falls back to simple arrayBuffer()
 *  when no progress callback is provided. */
async function readResponseBuffer(
  res: Response,
  maxBytes: number,
  label: string,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const contentLength = responseContentLength(res);
  assertDeclaredRemoteSize(contentLength, maxBytes, label);
  if (!res.body) {
    const data = await res.arrayBuffer();
    assertByteBudget(data.byteLength, maxBytes, label);
    return data;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      assertByteBudget(downloaded + value.length, maxBytes, label);
      chunks.push(value);
      downloaded += value.length;
      onProgress?.(downloaded, contentLength || downloaded);
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
  maxBytes = MAX_REMOTE_FILE_BYTES,
  label = `Remote file "${path}"`,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<DownloadToPathResult> {
  assertByteBudget(data.byteLength, maxBytes, label);
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
  maxBytes = MAX_REMOTE_FILE_BYTES,
  label = `Remote file "${path}"`,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DownloadToPathResult> {
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const contentLength = responseContentLength(res);
  assertDeclaredRemoteSize(contentLength, maxBytes, label);
  if (!res.body) {
    return writeArrayBufferToBinaryFile(
      adapter,
      path,
      await res.arrayBuffer(),
      expectedSha256,
      contentLength,
      maxBytes,
      label,
      onProgress,
    );
  }
  await safeRemove(adapter, path);
  const reader = res.body.getReader();
  const hasher = new StreamingSha256();
  let downloaded = 0;
  let wrote = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      assertByteBudget(downloaded + value.length, maxBytes, label);
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
  maxBytes = MAX_REMOTE_FILE_BYTES,
  label = "Graph content response",
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RequestUrlResponse> {
  const res = await browserFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  const buf = await readResponseBuffer(res, maxBytes, label, onProgress, signal);
  return { arrayBuffer: buf, status: res.status, headers: {} } as RequestUrlResponse;
}

async function contentUrlFetchToBinaryFile(
  url: string,
  token: string,
  adapter: DataAdapter,
  path: string,
  expectedSha256?: string,
  maxBytes = MAX_REMOTE_FILE_BYTES,
  label = `Remote file "${path}"`,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DownloadToPathResult> {
  const res = await browserFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  return streamResponseToBinaryFile(
    res,
    adapter,
    path,
    expectedSha256,
    maxBytes,
    label,
    onProgress,
    signal,
  );
}

/** Download a CDN pre-signed URL using native fetch (bypasses requestUrl
 *  mobile bugs: Android base64 encoding, iOS status=0 on CDN domains).
 *  Only active in browser/Electron/WebView environments (has window).
 *  Returns a minimal RequestUrlResponse shape for compatibility. */
async function downloadUrlFetch(
  url: string,
  maxBytes = MAX_REMOTE_FILE_BYTES,
  label = "Remote file",
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<RequestUrlResponse> {
  const res = await browserFetch(url, { cache: "no-store", signal });
  const buf = await readResponseBuffer(res, maxBytes, label, onProgress, signal);
  return { arrayBuffer: buf, status: res.status, headers: {} } as RequestUrlResponse;
}

async function downloadUrlFetchToBinaryFile(
  url: string,
  adapter: DataAdapter,
  path: string,
  expectedSha256?: string,
  maxBytes = MAX_REMOTE_FILE_BYTES,
  label = `Remote file "${path}"`,
  onProgress?: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DownloadToPathResult> {
  const res = await browserFetch(url, { cache: "no-store", signal });
  return streamResponseToBinaryFile(
    res,
    adapter,
    path,
    expectedSha256,
    maxBytes,
    label,
    onProgress,
    signal,
  );
}
