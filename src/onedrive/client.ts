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
  type UploadResult,
  OneDriveError,
  OneDriveErrorType,
  GRAPH_BASE_URL,
  APP_FOLDER_PATHS,
} from "./types";
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
const SIMPLE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const KIB_320 = 320 * 1024;
const MIN_CHUNK_SIZE = KIB_320;
const MAX_CHUNK_SIZE = 60 * 1024 * 1024;
const TARGET_CHUNKS_PER_FILE = 20;

/** Pick chunk size so large files finish in ~20 round-trips.
 *  Must be a multiple of 320 KiB (Graph API requirement for non-final chunks). */
function calculateChunkSize(fileSize: number): number {
    const target = Math.floor(fileSize / TARGET_CHUNKS_PER_FILE);
    const aligned = Math.ceil(
        Math.max(target, MIN_CHUNK_SIZE) / KIB_320
    ) * KIB_320;
    return Math.min(aligned, MAX_CHUNK_SIZE);
}

// ---- Download chunking (parallel Range requests) ----

/** Files above this size use parallel chunked download when a downloadUrl is available. */
// ponytail: keep parallel download disabled until Range handling has a real safety contract.
const PARALLEL_DOWNLOAD_THRESHOLD = Number.MAX_SAFE_INTEGER;
/** Target chunk size for parallel downloads. */
const PARALLEL_DOWNLOAD_CHUNK = 16 * 1024 * 1024;        // 16 MiB
/** Max concurrent Range requests per file. */
const PARALLEL_DOWNLOAD_CONCURRENCY = 4;
const UPLOAD_CHUNK_TIMEOUT_MS = 45_000;
const MAX_UPLOAD_CHUNK_ATTEMPTS = 2;

interface RequestOptions {
  deadlineMs?: number;
  maxAttempts?: number;
  extraHeaders?: Record<string, string>;
  perRequestTimeoutMs?: number;
}

interface DownloadToPathResult {
  size: number;
  hash: string;
}

export class OneDriveClient {
  private initializedVaults = new Set<string>();
  private storageVaultNames = new Map<string, string>();
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

  constructor(
    private getToken: TokenProvider,
    private diag?: DiagnosticLogger,
    private configDir = DEFAULT_CONFIG_DIR,
    private pluginId = "easy-sync",
  ) {}

  setAbortSignal(signal: AbortSignal | null): void {
    this.abortSignal = signal;
  }

  // ---- App Folder Bootstrap ----

  /** Get the App Folder special folder metadata */
  async getAppFolder(): Promise<DriveItem> {
    const response = await this.request("GET", APP_FOLDER_PATHS.appRoot);
    return response.json as DriveItem;
  }

  /** Ensure a directory exists (idempotent — 409 Conflict is treated as success) */
  async createFolder(folderPath: string): Promise<void> {
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
      void response;
    } catch (e) {
      if (e instanceof OneDriveError && e.type === OneDriveErrorType.Conflict) {
        this.diag?.log("onedrive", `folder already exists (409): ${folderPath}`);
        return;
      }
      throw e;
    }
  }

  /** Initialize the App Folder directory structure for a vault */
  async initVaultDirectories(vaultName: string): Promise<void> {
    if (this.initializedVaults.has(vaultName)) return;

    const storageVaultName = await this.resolveStorageVaultName(vaultName);
    this.storageVaultNames.set(vaultName, storageVaultName);

    // Create vault directory
    const vaultPath = APP_FOLDER_PATHS.vaultDir(storageVaultName);
    await this.createFolder(vaultPath);

    // Create files/ directory
    const filesPath = APP_FOLDER_PATHS.filesDir(storageVaultName);
    await this.createFolder(filesPath);

    // Create .easy-sync/ directory
    const pluginPath = APP_FOLDER_PATHS.pluginDir(storageVaultName);
    await this.createFolder(pluginPath);
    this.initializedVaults.add(vaultName);
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

  /** Upload a file, using an upload session above 50MB.
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
  ): Promise<UploadResult> {
    throwIfAborted(this.abortSignal);
    onProgress?.(0, content.byteLength);
    if (content.byteLength > SIMPLE_UPLOAD_MAX_BYTES) {
      return this.uploadLargeFile(vaultName, filePath, content, onProgress, eTag);
    }
    const apiPath = `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/content`;
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
  ): Promise<UploadResult> {
    throwIfAborted(this.abortSignal);
    const apiPath = `${APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath)}:/createUploadSession`;
    const extraHeaders = eTag ? { "If-Match": eTag } : undefined;
    const sessionResponse = await this.request(
      "POST",
      apiPath,
      {
        item: { "@microsoft.graph.conflictBehavior": "replace" },
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

    const chunkSize = calculateChunkSize(content.byteLength);

    this.diag?.log(
      "onedrive",
      `large upload session — path=${filePath}, bytes=${content.byteLength}, chunkBytes=${chunkSize}`,
    );
    for (let start = 0; start < content.byteLength; start += chunkSize) {
      throwIfAborted(this.abortSignal);
      const end = Math.min(content.byteLength, start + chunkSize) - 1;
      const response = await this.uploadChunk(
        uploadUrl,
        content.slice(start, end + 1),
        start,
        end,
        content.byteLength,
      );
      this.diag?.log(
        "onedrive",
        `large upload progress — path=${filePath}, uploaded=${end + 1}/${content.byteLength}`,
      );
      onProgress?.(end + 1, content.byteLength);
      if (response.status === 200 || response.status === 201) {
        return response.json as UploadResult;
      }
    }

    throw new OneDriveError(
      OneDriveErrorType.Unknown,
      `Upload session ended without a completed driveItem: ${filePath}`,
    );
  }

  private async uploadChunk(
    uploadUrl: string,
    chunk: ArrayBuffer,
    start: number,
    end: number,
    total: number,
  ): Promise<RequestUrlResponse> {
    // Try native fetch first — bypasses requestUrl mobile bugs
    // (Android base64 encoding, iOS status=0 on non-Graph domains).
    // Azure Blob upload session URLs are non-Graph, same risk profile as CDN downloadUrl.
    try {
      return await withTimeout(
        uploadChunkFetch(uploadUrl, chunk, start, end, total, this.abortSignal ?? undefined),
        UPLOAD_CHUNK_TIMEOUT_MS,
      );
    } catch (fetchError) {
      if (isAbortError(fetchError)) throw fetchError;
      this.diag?.log("onedrive", `upload chunk fetch failed, falling back to requestUrl: ${requestErrorMessage(fetchError)}`);
    }

    // Fall back to requestUrl with retry
    for (let attempt = 1; attempt <= MAX_UPLOAD_CHUNK_ATTEMPTS; attempt++) {
      throwIfAborted(this.abortSignal);
      try {
        return await withTimeout(
          requestUrl({
            url: uploadUrl,
            method: "PUT",
            headers: {
              "Content-Range": `bytes ${start}-${end}/${total}`,
            },
            body: chunk,
            contentType: "application/octet-stream",
          }),
          UPLOAD_CHUNK_TIMEOUT_MS,
        );
      } catch (rawError) {
        this.diag?.warn(
          "onedrive",
          `large upload chunk failed — range=${start}-${end}, bytes=${chunk.byteLength}, attempt=${attempt}/${MAX_UPLOAD_CHUNK_ATTEMPTS}, hostError=${requestErrorMessage(rawError)}`,
        );
        const classified = this.toRequestError(rawError, uploadUrl);
        const error = classified.type === OneDriveErrorType.AuthExpired
          ? new OneDriveError(
            OneDriveErrorType.Unauthorized,
            classified.message,
            classified.statusCode,
            classified.retryAfterSeconds,
            classified.graphCode,
          )
          : classified;
        if (!isTransientRequestError(error) || attempt === MAX_UPLOAD_CHUNK_ATTEMPTS) {
          throw error;
        }
        const waitMs = retryDelayMs(error, attempt);
        this.diag?.warn(
          "onedrive",
          `large upload chunk retry — range=${start}-${end}, attempt=${attempt}/${MAX_UPLOAD_CHUNK_ATTEMPTS}, waitMs=${waitMs}`,
        );
        await sleep(waitMs);
      }
    }
    throw new OneDriveError(OneDriveErrorType.Unknown, "Upload chunk failed");
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
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await withAbortableTimeout(
            (signal) => downloadUrlFetch(url, onDlProgress, signal),
            remainingMs(),
            this.abortSignal,
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          let err = error;
          // fetch CORS/network error → fall back to requestUrl
          if (err instanceof TypeError || (err as { status?: number }).status === 0) {
            try {
              throwIfAborted(this.abortSignal);
              return await withTimeout(
                requestUrl({ url, method: "GET" }),
                remainingMs(),
              );
            } catch (fallbackErr) {
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
    const metaRequestOptions: RequestOptions = { deadlineMs, maxAttempts: 1 };
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
        const buf = response.arrayBuffer as ArrayBuffer;
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
      if (
        fileSize > PARALLEL_DOWNLOAD_THRESHOLD
        && this.downloadMethod !== "content"
      ) {
        throwIfAborted(this.abortSignal);
        const tier1StartMs = Date.now();
        try {
          const result = await this.downloadParallel(
            downloadUrl,
            fileSize,
            remainingMs,
            onProgress,
            (extendByMs) => {
              deadlineMs = Math.max(deadlineMs, Date.now() + extendByMs);
            },
          );
          this.downloadMethod = "downloadUrl";
          return result;
        } catch (err) {
          if (isUncancellableRequestTimeout(err)) throw downloadTimeoutError(filePath);
          this.diag?.warn(
            "onedrive",
            `downloadFile "${filePath}" — parallel download failed, falling back to serial`,
            { ...downloadErrorData(err), tierMs: Date.now() - tier1StartMs },
          );
          remainingMs();
        }
      }

      const tier2StartMs = Date.now();
      try {
        const response = await fetchDownloadUrl(downloadUrl, 1, onProgress);
        this.downloadMethod = "downloadUrl";
        const buf = response.arrayBuffer as ArrayBuffer;
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
          return dlResp.arrayBuffer as ArrayBuffer;
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

      // For large files, use parallel Range requests against /content.
      if (fileSize > PARALLEL_DOWNLOAD_THRESHOLD) {
        const url = `${GRAPH_BASE_URL}${apiPath}`;
        throwIfAborted(this.abortSignal);
        const token = await this.getToken();
        const result = await this.downloadParallel(
          url, fileSize, remainingMs, onProgress,
          (extendByMs) => { deadlineMs = Math.max(deadlineMs, Date.now() + extendByMs); },
          { Authorization: `Bearer ${token}` },
        );
        this.downloadMethod = "content";
        return result;
      }

      const response = await this.contentGet(apiPath, contentRequestOptions, onProgress);
      this.downloadMethod = "content";
      return response.arrayBuffer as ArrayBuffer;
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
        return response.arrayBuffer as ArrayBuffer;
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
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await withAbortableTimeout(
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
        } catch (error) {
          if (isAbortError(error)) throw error;
          let err = error;
          if (err instanceof TypeError || (err as { status?: number }).status === 0) {
            try {
              throwIfAborted(this.abortSignal);
              const response = await withTimeout(
                requestUrl({ url, method: "GET" }),
                remainingMs(),
              );
              return await writeArrayBufferToBinaryFile(
                adapter,
                localPath,
                response.arrayBuffer as ArrayBuffer,
                expectedSha256,
                fileSize,
                onDlProgress,
              );
            } catch (fallbackErr) {
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
    const metaRequestOptions: RequestOptions = { deadlineMs, maxAttempts: 1 };
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

  /** Download a large file in parallel chunks via HTTP Range requests.
   *  Falls back to serial download on any chunk failure.
   *  Only called when downloadUrl is available and fileSize > threshold. */
  private async downloadParallel(
    downloadUrl: string,
    fileSize: number,
    remainingMs: () => number,
    onProgress?: (downloaded: number, total: number) => void,
    extendDeadline?: (byMs: number) => void,
    extraHeaders?: Record<string, string>,
  ): Promise<ArrayBuffer> {
    throwIfAborted(this.abortSignal);
    const totalChunks = Math.ceil(fileSize / PARALLEL_DOWNLOAD_CHUNK);
    const chunks = new Array<ArrayBuffer | null>(totalChunks).fill(null);
    let downloadedSize = 0;
    let index = 0;

    this.diag?.log(
      "onedrive",
      `parallel download — url=${downloadUrl.substring(0, 80)}… chunks=${totalChunks}×${PARALLEL_DOWNLOAD_CHUNK / (1024 * 1024)}MiB concurrency=${PARALLEL_DOWNLOAD_CONCURRENCY}`,
    );

    const worker = async (): Promise<void> => {
      while (index < totalChunks) {
        throwIfAborted(this.abortSignal);
        const i = index++;
        const start = i * PARALLEL_DOWNLOAD_CHUNK;
        const end = Math.min(start + PARALLEL_DOWNLOAD_CHUNK, fileSize) - 1;
        const budgetMs = remainingMs();

        const headers: Record<string, string> = {
          Range: `bytes=${start}-${end}`,
          ...extraHeaders,
        };
        const resp = await withTimeout(
          requestUrl({ url: downloadUrl, method: "GET", headers }),
          Math.min(budgetMs, 30_000),
        );

        // If the server ignores Range and returns the full file, use it directly.
        if (resp.status === 200 && i === 0) {
          this.diag?.log("onedrive", "parallel download — server returned full file (Range not supported)");
          const buf = resp.arrayBuffer as ArrayBuffer;
          chunks[0] = buf;
          onProgress?.(buf.byteLength, fileSize);
          return;
        }

        const buf = resp.arrayBuffer as ArrayBuffer;
        chunks[i] = buf;
        downloadedSize += buf.byteLength;
        onProgress?.(downloadedSize, fileSize);
        // Each completed chunk proves the network is alive — extend the
        // total deadline so large files don't hit the cap while making progress.
        extendDeadline?.(downloadTimeoutMs(buf.byteLength));
      }
    };

    await Promise.all(
      Array.from({ length: PARALLEL_DOWNLOAD_CONCURRENCY }, () => worker()),
    );

    // Assemble — ensure every chunk succeeded
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (!chunks[i]) {
        throw new OneDriveError(
          OneDriveErrorType.Unknown,
          `Parallel download chunk ${i} missing`,
        );
      }
      total += chunks[i]!.byteLength;
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(new Uint8Array(chunk!), offset);
      offset += chunk!.byteLength;
    }

    this.diag?.log(
      "onedrive",
      `parallel download complete — ${totalChunks} chunks, ${total} bytes`,
    );
    return result.buffer as ArrayBuffer;
  }

  /** Delete a file or folder.
   *  @param eTag  When set, the DELETE includes an If-Match header. If the
   *               file has been modified remotely since the plan was generated,
   *               the server returns 412 and the caller routes to conflict. */
  async deleteItem(vaultName: string, itemPath: string, eTag?: string): Promise<void> {
    const apiPath = APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), itemPath);
    await this.request("DELETE", apiPath, undefined, undefined, undefined, undefined, eTag);
  }

  /** Rename a file on OneDrive without re-uploading content.
   *
   *  Uses PATCH on the path-based endpoint with only `name` set.
   *  OneDrive handles the rename server-side — no content transfer.
   *
   *  ponytail: only same-directory renames. Cross-directory moves would
   *  need the destination folder's driveItem ID for parentReference;
   *  those fall through to the Upload+DeleteRemote path for now.
   *
   *  Returns the updated DriveItem so callers can grab the new eTag. */
  async renameItem(
    vaultName: string,
    oldPath: string,
    newPath: string,
  ): Promise<DriveItem> {
    const apiPath = APP_FOLDER_PATHS.filePath(
      this.getStorageVaultName(vaultName),
      oldPath,
    );
    const newName = newPath.split("/").pop() || newPath;
    const response = await this.request("PATCH", apiPath, { name: newName });
    return response.json as DriveItem;
  }

  /** Fetch current metadata for a single file — used when an If-Match upload
   *  fails with 412 to get fresh remote info for conflict creation. */
  async getFileMetadata(
    vaultName: string,
    filePath: string,
  ): Promise<{ eTag: string; size: number; sha256Hash?: string; downloadUrl?: string; driveId: string; mtime: number } | null> {
    try {
      const apiPath = APP_FOLDER_PATHS.filePath(this.getStorageVaultName(vaultName), filePath);
      const response = await this.request("GET", apiPath);
      const item = response.json as DriveItem;
      if (!item.file) return null;
      return {
        eTag: item.eTag ?? "",
        size: item.size ?? 0,
        sha256Hash: item.file?.hashes?.sha256Hash?.toLowerCase(),
        downloadUrl: item["@microsoft.graph.downloadUrl"],
        driveId: item.id,
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

  /** Upload the cloud baseline snapshot to .easy-sync/baseline.json */
  async uploadBaseline(vaultName: string, content: string): Promise<void> {
    const apiPath = `${APP_FOLDER_PATHS.pluginDir(this.getStorageVaultName(vaultName))}/baseline.json:/content`;
    await this.request("PUT", apiPath, content, "application/json");
  }

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
        } catch {
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
        } catch {
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
   * Lists all files and returns as a flat DriveItem array.
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
    const token = await this.getToken();
    const url = apiPath.startsWith("https://")
      ? apiPath
      : `${GRAPH_BASE_URL}${apiPath}`;

    try {
      const timeoutMs = requestTimeoutWithCap(options.deadlineMs, options.perRequestTimeoutMs ?? DOWNLOAD_MAX_TIMEOUT_MS);
      this.diag?.log("onedrive", `contentGet — trying fetch, timeoutMs=${timeoutMs}, url=${sanitizeUrl(url)}`);
      return await withAbortableTimeout(
        (signal) => contentUrlFetch(url, token, onProgress, signal),
        timeoutMs,
        this.abortSignal,
      );
    } catch (fetchErr) {
      if (isAbortError(fetchErr)) throw fetchErr;
      this.diag?.log("onedrive", `content fetch failed, falling back to requestUrl: ${requestErrorMessage(fetchErr)}`);
    }

    // Fall back to requestUrl — may 401 on SharePoint redirect but
    // handles environments where fetch is unavailable.
    return this.request("GET", apiPath, undefined, undefined, "arraybuffer", options);
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
    const token = await this.getToken();
    const url = apiPath.startsWith("https://")
      ? apiPath
      : `${GRAPH_BASE_URL}${apiPath}`;

    try {
      const timeoutMs = requestTimeoutWithCap(options.deadlineMs, options.perRequestTimeoutMs ?? DOWNLOAD_MAX_TIMEOUT_MS);
      this.diag?.log("onedrive", `contentGetToPath — trying fetch stream, timeoutMs=${timeoutMs}, url=${sanitizeUrl(url)}`);
      return await withAbortableTimeout(
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
    } catch (fetchErr) {
      if (isAbortError(fetchErr)) throw fetchErr;
      this.diag?.log("onedrive", `content stream fetch failed, falling back to requestUrl: ${requestErrorMessage(fetchErr)}`);
    }

    const response = await this.request("GET", apiPath, undefined, undefined, "arraybuffer", options);
    return writeArrayBufferToBinaryFile(
      adapter,
      localPath,
      response.arrayBuffer as ArrayBuffer,
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
    const token = await this.getToken();
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
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(this.abortSignal);
      try {
        const timeoutMs = options.perRequestTimeoutMs
          ? requestTimeoutWithCap(options.deadlineMs, options.perRequestTimeoutMs)
          : requestTimeoutMs(options.deadlineMs);
        return await withTimeout(
          requestUrl({
            url,
            method,
            headers,
            body: requestBody,
            contentType,
          }),
          timeoutMs,
        );
      } catch (rawError) {
        const error = this.toRequestError(rawError, url);
        if (error.type === OneDriveErrorType.NotFound) {
          this.initializedVaults.clear();
          this.storageVaultNames.clear();
        }
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

  private toRequestError(rawError: unknown, url: string): OneDriveError {
    // Obsidian's requestUrl throws on non-2xx. The error object carries
    // status, headers, and sometimes json/text from the response.
    const errAny = isRecord(rawError) ? rawError : {};
    const errStatus = typeof errAny.status === "number" ? errAny.status : 0;
    const errHeaders = isStringRecord(errAny.headers) ? errAny.headers : {};
    let graphBody: Record<string, unknown> | undefined;
    if (isRecord(errAny.json)) {
      graphBody = errAny.json;
    } else if (errAny.text && typeof errAny.text === "string") {
      try { graphBody = JSON.parse(errAny.text); } catch { /* not JSON */ }
    }
    const graphErr = graphBody?.error as Record<string, unknown> | undefined;
    // 409 is "folder already exists" — handled gracefully, don't alarm the user
    if (errStatus === 409) {
      this.diag?.log("onedrive", `requestUrl 409 — ${sanitizeUrl(url)}`);
    } else {
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
      case 429:
        return new OneDriveError(
          OneDriveErrorType.RateLimited,
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
  if (typeof window === "undefined") {
    throw new TypeError("fetch unavailable");
  }
  const fetchFn = window["fetch"]?.bind(window) ?? globalThis["fetch"]?.bind(globalThis);
  if (!fetchFn) throw new TypeError("fetch unavailable");
  return fetchFn(input, init);
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

async function safeRemove(adapter: DataAdapter, path: string): Promise<void> {
  try { await adapter.remove(path); } catch { /* noop */ }
}

function exactArrayBuffer(chunk: Uint8Array): ArrayBuffer {
  return chunk.slice().buffer as ArrayBuffer;
}

async function sha256Hex(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
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
  return new Promise((resolve) => compatSetTimeout(resolve, ms));
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
    // Simulate requestUrl error shape so downstream error handling works
    const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  // 200/201 → driveItem JSON, 202 (Accepted) → no body
  let json: unknown = undefined;
  try { json = await res.json(); } catch { /* 202 Accepted has no body */ }
  return { json, status: res.status, headers: {} } as RequestUrlResponse;
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
  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    onProgress(downloaded, contentLength || downloaded);
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
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
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
