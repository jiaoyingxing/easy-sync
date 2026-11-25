/**
 * WebDAV provider（W2a 合同面）。
 *
 * 把已落地的 `WebDavClient`（PROPFIND 元数据、条件更新、安全新建、MOVE 拒绝
 * 覆盖）与安全的控制面路径判定映射到引擎的 `SyncProvider` 34 方法合同面。
 * 本切片只交 provider 与测试，不接 `src/main.ts`／`src/sync`／引擎，也不做
 * 设置 UI；身份账本与引擎接线属于 W2b。
 *
 * ID 映射（W2a 约定，W2b2a 修正 `getFileMetadata.driveId`）：
 * - 条目 ID＝规范化 vault 相对路径（无前导 `/`），根 ID＝`"/"`；
 * - 父 ID＝父路径，顶层父 ID＝`"/"`；
 * - drive 容器身份＝endpoint origin（S0 `endpointId`，可由 options 覆盖），
 *   `RemoteVaultScope = { driveId, vaultFolderId: "/", filesRootId: "/" }`；
 *   根路径只进 `client.rootPath`／控制面判定，不进 `driveId`。
 * - `getFileMetadata.driveId` 是**条目身份**（与 OneDrive 的 item.id 同义），
 *   值为条目相对路径 `id`；`parentReference.driveId` 与 `RemoteVaultScope`
 *   仍用 origin。
 *
 * 能力缺失时 fail-closed：回收站恢复抛中性 `RemoteError`
 * （`type=Unknown`、`graphCode=capability-missing`），不静默成功；删除／改名／
 * 移动由 W3a 实现，全部要求复核过的强 ETag、控制面拒绝、移动前源复核与移动
 * 后双向回读；列表 `complete=false` 抛 `WebDavListingIncompleteError`，不把
 * 截断当完整；单次 PUT 超过当前平台能力 `maxSinglePutBytes`（桌面 100 MiB／
 * 移动 32 MiB）抛 `WebDavUploadTooLargeError`。
 * 不伪造 sha256／quickXor 等内容指纹；`getFileMetadata.cTag` 只回显 eTag。
 */
import type { DataAdapter } from "obsidian";
import type { ProviderCapabilities } from "../../sync/provider-capabilities";
import type { SyncProvider } from "../../sync/sync-provider";
import type { OneDriveMetadataReason } from "../../onedrive/client";
import type {
  DeltaPageCallback,
  DeltaResponse,
  DriveItem,
  DriveItemVersion,
  RemoteVaultScope,
  UploadResult,
} from "../../onedrive/types";
import { RemoteError, RemoteErrorType } from "../../remote/errors";
import { sha256Hex } from "../../crypto";
import {
  isWeakETag,
  joinWebDavPath,
  normalizeWebDavPath,
} from "./webdav-probe";
import {
  WebDavClient,
  WebDavPaginationError,
  WebDavPreconditionFailedError,
  WebDavRootMissingError,
  WebDavTargetExistsError,
  WebDavUnsafeDeleteError,
  type WebDavResourceStat,
} from "./webdav-client";
import {
  WebDavSharedProtocolStore,
  type WebDavSharedSyncProtocolControlObject,
  type WebDavSharedSyncProtocolObjectsObservation,
} from "./webdav-protocol";
import {
  isWebDavControlPlanePath,
  WEBDAV_CONTROL_DIRECTORY,
} from "./webdav-scope";
import {
  idForPath,
  loadIdentityLedger,
  moveIdentity,
  saveIdentityLedger,
} from "./webdav-identity-ledger";

/** 根条目的合成 ID；顶层条目的父 ID 也用同一个哨兵。 */
const WEBDAV_ROOT_ID = "/";

/** Cloud Bootstrap V2 控制文件（vault 相对路径）。 */
export const WEBDAV_CLOUD_BOOTSTRAP_V2_PATH =
  `${WEBDAV_CONTROL_DIRECTORY}/cloud-bootstrap-v2.json`;

/** Client 尚未 `initialize()`（capabilities 为 null）时构造或读取能力即失败。 */
export class WebDavProviderNotInitializedError extends Error {
  constructor() {
    super(
      "WebDavProvider requires an initialized WebDavClient (capabilities are null); call client.initialize() first",
    );
    this.name = "WebDavProviderNotInitializedError";
  }
}

/**
 * 列表达到服务器单次响应上限（可能是截断）。
 *
 * `path` 是绝对远端路径；`responseEntryCount` 是 multistatus 全部响应条目数
 * （含被列举集合自身），`limit` 是客户端上限。
 */
export class WebDavListingIncompleteError extends Error {
  constructor(
    readonly path: string,
    readonly responseEntryCount: number,
    readonly limit: number,
  ) {
    super(
      `WebDAV listing for ${path} returned ${responseEntryCount} response entries (limit ${limit}); refusing to treat a possibly truncated listing as complete`,
    );
    this.name = "WebDavListingIncompleteError";
  }
}

/** 单次 PUT 内容超过客户端安全阈值；请求未发出。 */
export class WebDavUploadTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `WebDAV upload is ${bytes} bytes, above the client single-PUT limit of ${limit} bytes`,
    );
    this.name = "WebDavUploadTooLargeError";
  }
}

/** 落盘后 SHA-256 与调用方提供的期望值不一致。 */
export class WebDavDownloadHashMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly expectedSha256: string,
    readonly actualSha256: string,
  ) {
    super(
      `WebDAV download hash mismatch for ${path}: expected ${expectedSha256}, got ${actualSha256}`,
    );
    this.name = "WebDavDownloadHashMismatchError";
  }
}

/**
 * 提供方没有该能力（删除／改名／移动／恢复）：中性错误，不静默成功。
 *
 * 继承 `RemoteError` 以便引擎既有错误路由直接消费；`graphCode` 固定为
 * `capability-missing`，`message` 说明具体方法。
 */
export class WebDavCapabilityMissingError extends RemoteError {
  constructor(
    readonly method: string,
    target?: string,
  ) {
    super(
      RemoteErrorType.Unknown,
      `WebDAV provider cannot ${method}${target ? ` (${target})` : ""}: capability-missing`,
      0,
      null,
      "capability-missing",
    );
    this.name = "WebDavCapabilityMissingError";
  }
}

export interface WebDavProviderOptions {
  /** 已 `initialize()` 的安全客户端；capabilities 必须非 null。 */
  readonly client: WebDavClient;
  /** 条目与 scope 的 drive 身份；缺省取 `new URL(client.endpoint).origin`
   *  （S0 `endpointId`），不是远端根路径。 */
  readonly driveId?: string;
  /** 上传回读缺 mtime 时的合成时钟；缺省 `new Date()`。 */
  readonly now?: () => Date;
}

/**
 * WebDAV 的 `SyncProvider` 实现（W2a）。
 *
 * 只做合同面映射：扫描用 Depth 1 BFS，元数据用 PROPFIND，传输走安全客户端；
 * 不接 planner／executor，不实现身份账本或删除语义。
 */
export class WebDavProvider implements SyncProvider {
  private readonly client: WebDavClient;
  private readonly driveId: string;
  private readonly now: () => Date;
  private readonly sharedProtocol: WebDavSharedProtocolStore;
  private abortSignal: AbortSignal | null = null;
  /** 本机是否已确认当前账本内容；构造期 fail-closed 为 false（W2b-2）。 */
  private identityLedgerTrusted = false;
  /**
   * Collections this provider already ensured during the current run.
   *
   * A first sync uploads many files into the same folder; without this cache
   * every upload repeats the parent-chain MKCOL (the server answers 405, but
   * it still costs a request). Nutstore's 600-request window makes that
   * overhead a real join failure mode. Cleared per run and on any upload
   * failure or collection delete, so an out-of-band deletion is re-probed by
   * the next run instead of being trusted forever.
   */
  private ensuredCollectionIds = new Set<string>();

  constructor(options: WebDavProviderOptions) {
    this.client = options.client;
    this.driveId = options.driveId ?? new URL(options.client.endpoint).origin;
    this.now = options.now ?? (() => new Date());
    this.sharedProtocol = new WebDavSharedProtocolStore(this.client);
    // 构造期 fail-closed：未 initialize() 的 client 不允许进入合同面。
    void this.capabilities;
  }

  get capabilities(): ProviderCapabilities {
    const capabilities = this.client.capabilities;
    if (!capabilities) throw new WebDavProviderNotInitializedError();
    return capabilities;
  }

  // ---- 运行度量与中断 ----

  setAbortSignal(signal: AbortSignal | null): void {
    this.abortSignal = signal;
  }

  beginRunMetrics(): void {
    // W2a 不采集运行度量；引擎接线时由 W2b 提供。
  }

  finishRunMetrics(): null {
    return null;
  }

  // ---- 文件夹创建 ----

  async createFolderPath(
    _vaultName: string,
    folderPath: string,
  ): Promise<DriveItem | null> {
    return await this.createFolderAt(relativeId(folderPath));
  }

  async createFolderByParentId(
    parentDriveItemId: string,
    name: string,
  ): Promise<DriveItem> {
    if (
      name.length === 0
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
    ) {
      throw new Error(`Invalid WebDAV folder name: ${name}`);
    }
    const parentId = relativeId(parentDriveItemId);
    const id = relativeId(
      parentId === WEBDAV_ROOT_ID ? name : `${parentId}/${name}`,
    );
    return await this.createFolderAt(id);
  }

  // ---- 元数据读 ----

  async getDriveItemMetadata(
    _vaultName: string,
    itemPath: string,
  ): Promise<DriveItem | null> {
    return await this.metadataAt(itemPath);
  }

  async getDriveItemMetadataById(
    driveItemId: string,
    _metadataReason?: OneDriveMetadataReason,
  ): Promise<DriveItem | null> {
    return await this.metadataAt(driveItemId);
  }

  async listDriveItemVersionsById(
    _driveItemId: string,
    _metadataReason?: OneDriveMetadataReason,
  ): Promise<DriveItemVersion[]> {
    return [];
  }

  async restoreDeletedDriveItemById(driveItemId: string): Promise<void> {
    throw new WebDavCapabilityMissingError(
      "restoreDeletedDriveItemById",
      driveItemId,
    );
  }

  async getFileMetadataByPaths(
    _vaultName: string,
    filePaths: readonly string[],
    _metadataReason?: OneDriveMetadataReason,
  ): Promise<Map<string, DriveItem | null>> {
    const result = new Map<string, DriveItem | null>();
    for (const filePath of new Set(filePaths)) {
      if (filePath.length === 0) continue;
      result.set(filePath, await this.metadataAt(filePath));
    }
    return result;
  }

  async listFolderChildrenById(driveItemId: string): Promise<DriveItem[]> {
    return await this.listFolder(driveItemId);
  }

  async getFileMetadata(
    _vaultName: string,
    filePath: string,
    _metadataReason?: OneDriveMetadataReason,
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
    const id = relativeId(filePath);
    const stat = await this.client.stat(this.clientPath(id));
    if (!stat || stat.kind !== "file") return null;
    const parsedMtime = stat.lastModified ? Date.parse(stat.lastModified) : 0;
    return {
      eTag: stat.eTag ?? "",
      // WebDAV 没有改名不变的内容版本令牌；只回显 eTag，且能力位为 false。
      cTag: stat.eTag ?? "",
      size: stat.size ?? 0,
      // W2b2a：这里的 `driveId` 是**条目身份**（OneDrive 返回 item.id），不是
      // drive 容器身份。WebDAV 条目 ID 是规范化相对路径；`parentReference`
      // 与 `RemoteVaultScope.driveId` 才继续使用 endpoint origin。
      driveId: id,
      parentId: parentIdOf(id),
      mtime: Number.isFinite(parsedMtime) ? parsedMtime : 0,
    };
  }

  // ---- Vault 范围生命周期 ----

  async initVaultScope(
    _vaultName: string,
    options: { createMissing?: boolean } = {},
  ): Promise<RemoteVaultScope> {
    let stat = await this.client.stat("");
    if (!stat) {
      if (options.createMissing === true) {
        stat = await this.client.ensureRootCollection();
      } else {
        throw new WebDavRootMissingError(this.client.rootPath);
      }
    }
    if (stat.kind !== "collection") {
      throw new WebDavRootMissingError(this.client.rootPath);
    }
    return this.vaultScope();
  }

  restoreVaultScope(
    _vaultName: string,
    _scope: RemoteVaultScope,
    _deltaLink: string,
  ): boolean {
    return false;
  }

  /**
   * 按已知身份恢复已提交 scope。W2b2a 起先验证根集合仍存在且是 collection：
   * 根被删除／改名时抛 `WebDavRootMissingError`，不得把「查不到根」当成
   * 「远端为空」继续交给 planner。
   */
  async restoreVaultScopeByIdentity(
    _vaultName: string,
    scope: RemoteVaultScope,
  ): Promise<RemoteVaultScope> {
    const stat = await this.client.stat("");
    if (!stat || stat.kind !== "collection") {
      throw new WebDavRootMissingError(this.client.rootPath);
    }
    return scope;
  }

  invalidateVaultScope(_vaultName: string): void {
    // 无缓存 scope；W2b 接线时再补。
  }

  isDeltaLinkForVault(_vaultName: string, _deltaLink: string): boolean {
    return false;
  }

  // ---- 下载策略（每轮提示） ----

  resetDownloadStrategy(): void {
    // 单流整包，没有降级档位。这里同时清空本轮集合缓存：执行器每轮开始都
    // 会调 `resetDownloadStrategy`，用它作为「新一轮远端前提重新观察」的边界；
    // 上一轮确保过的集合不能跨轮当作仍然存在。
    this.ensuredCollectionIds.clear();
    this.client.beginRoundStats();
  }

  /** 本轮 WebDAV 请求/列表读数；只进诊断摘要，不参与计划判断。 */
  webDavRoundStats(): ReturnType<WebDavClient["roundStats"]> {
    return this.client.roundStats();
  }

  hasDegradedDownloadPathThisRound(): boolean {
    return false;
  }

  // ---- 传输 ----

  async uploadFile(
    _vaultName: string,
    filePath: string,
    content: ArrayBuffer,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void,
    eTag?: string,
    driveItemId?: string,
  ): Promise<UploadResult> {
    const totalBytes = content.byteLength;
    const singlePutLimit = this.capabilities.maxSinglePutBytes;
    if (totalBytes > singlePutLimit) {
      throw new WebDavUploadTooLargeError(totalBytes, singlePutLimit);
    }
    const targetId = relativeId(
      driveItemId && driveItemId.length > 0 ? driveItemId : filePath,
    );
    const parentId = parentIdOf(targetId);
    if (parentId !== WEBDAV_ROOT_ID) {
      // W2b-4：远端集合必须真实存在，且服务器不会替我们递归——MKCOL 只建
      // 最后一级，父级缺失返回 409（坚果云 L2 已核证）。多级新目录里首批
      // 上传正好踩这一步，所以按层级从浅到深补齐。
      await this.ensureCollectionChain(parentId);
    }
    const bytes = new Uint8Array(content);
    onProgress?.(0, totalBytes);
    let result: Awaited<ReturnType<WebDavClient["createFile"]>>;
    try {
      result = eTag
        ? await this.client.updateFile(this.clientPath(targetId), bytes, eTag)
        : await this.client.createFile(this.clientPath(targetId), bytes);
    } catch (error) {
      // A failed write may mean a cached parent collection disappeared or is
      // no longer writable. Drop the round cache so the next run re-ensures
      // the whole chain instead of trusting this run's earlier success.
      this.ensuredCollectionIds.clear();
      throw error;
    }
    const writtenId = relativeId(result.stat.relativePath || targetId);
    onProgress?.(totalBytes, totalBytes);
    return this.toUploadResult(result.stat, writtenId, totalBytes);
  }

  async downloadFile(
    _vaultName: string,
    filePath: string,
    _downloadUrl?: string,
    _driveItemId?: string,
    _fileSize?: number,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<ArrayBuffer> {
    const id = relativeId(filePath);
    const { bytes, stat } = await this.client.readFile(this.clientPath(id));
    const buffer = toArrayBuffer(bytes);
    const total = stat.size ?? buffer.byteLength;
    onProgress?.(0, total);
    onProgress?.(total, total);
    return buffer;
  }

  async downloadFileToPath(
    _vaultName: string,
    filePath: string,
    localPath: string,
    adapter: DataAdapter,
    _downloadUrl?: string,
    _driveItemId?: string,
    _fileSize?: number,
    expectedSha256?: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<{ size: number; hash: string }> {
    const id = relativeId(filePath);
    const { bytes, stat } = await this.client.readFile(this.clientPath(id));
    const buffer = toArrayBuffer(bytes);
    const total = stat.size ?? buffer.byteLength;
    onProgress?.(0, total);
    await adapter.writeBinary(localPath, buffer);
    const hash = await sha256Hex(buffer);
    const expected = expectedSha256?.trim().toLowerCase() ?? "";
    if (expected.length > 0 && hash !== expected) {
      throw new WebDavDownloadHashMismatchError(id, expected, hash);
    }
    onProgress?.(total, total);
    return { size: buffer.byteLength, hash };
  }

  /**
   * 删除单个文件或空集合。
   *
   * 用户数据必须带调用方复核过的 ETag：文件在支持条件删除的服务器上直接
   * `If-Match`；不支持时退化为 PROPFIND 复核后 DELETE（check-then-delete，
   * 设计允许的降级路径）。集合只允许删空壳；坚果云一类没有条件删除能力的
   * 服务器拒绝删除集合并保留空壳（`webdav-collection-delete-unavailable`），
   * 由 W3 引擎按「内容已删、空集合保留」结算，不在此处做无条件 DELETE。
   */
  async deleteItem(
    _vaultName: string,
    itemPath: string,
    matchTag?: string,
    driveItemId?: string,
  ): Promise<void> {
    const id = relativeId(driveItemId ?? itemPath);
    this.assertUserPath(id, "delete");
    const eTag = this.requireMutationEtag(id, matchTag);

    let stat: WebDavResourceStat | null;
    try {
      stat = await this.client.stat(this.clientPath(id));
    } catch (error) {
      throw this.mutationError(id, error);
    }
    if (!stat) return;

    try {
      if (stat.kind === "collection") {
        if (!this.capabilities.conditionalDelete) {
          // No conditional collection DELETE: prove the shell is empty but do
          // not send DELETE. The engine settles "content deleted, empty
          // collection retained" and remembers the shell in plugin data.
          const children = await this.client.list(this.clientPath(id));
          if (!children.complete || children.length > 0) {
            throw new WebDavUnsafeDeleteError(
              `WebDAV collection is not provably empty: ${id}`,
            );
          }
          return;
        }
        await this.client.deleteEmptyCollection(this.clientPath(id), {
          confirmed: true,
          ifMatch: eTag,
        });
        this.ensuredCollectionIds.delete(id);
        for (const cached of [...this.ensuredCollectionIds]) {
          if (cached.startsWith(`${id}/`)) this.ensuredCollectionIds.delete(cached);
        }
      } else {
        await this.client.deleteFile(this.clientPath(id), {
          confirmed: true,
          ifMatch: eTag,
        });
      }
    } catch (error) {
      throw this.mutationError(id, error);
    }

    let after: WebDavResourceStat | null;
    try {
      after = await this.client.stat(this.clientPath(id));
    } catch (error) {
      throw this.mutationError(id, error);
    }
    if (after) {
      throw new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV delete readback still present: ${id}`,
        409,
        null,
        "webdav-delete-readback",
      );
    }
  }

  /**
   * 同目录改名：源 ID 优先用 plan 复核过的 `driveItemId`（WebDAV 为相对
   * 路径），目标由 `newPath` 规范化得到。移动前复核源 ETag，移动后回读目标
   * 并确认源已消失；目标已存在或源版本变化都抛中性冲突。
   */
  async renameItem(
    _vaultName: string,
    oldPath: string,
    newPath: string,
    driveItemId: string,
    eTag: string,
  ): Promise<DriveItem> {
    const sourceId = relativeId(driveItemId || oldPath);
    const targetId = relativeId(newPath);
    return await this.moveAt(sourceId, targetId, eTag, "rename");
  }

  /**
   * 按身份移动／改名：`newParentId` 是目标父路径（根为 `/`），`newName` 是
   * 目标名。路径由两者拼接并规范化；文件夹移动走同一 MOVE。
   */
  async moveItemById(
    driveItemId: string,
    eTag: string,
    newName: string,
    newParentId: string,
  ): Promise<DriveItem> {
    const sourceId = relativeId(driveItemId);
    const parentId = relativeId(newParentId);
    const name = newName.trim();
    if (
      name.length === 0
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
    ) {
      throw new RemoteError(
        RemoteErrorType.Conflict,
        `Invalid WebDAV move name: ${newName}`,
        409,
        null,
        "webdav-invalid-move-name",
      );
    }
    const targetId = relativeId(
      parentId === WEBDAV_ROOT_ID ? name : `${parentId}/${name}`,
    );
    return await this.moveAt(sourceId, targetId, eTag, "move");
  }

  /**
   * Read the sidecar identity ledger only when it is verified (strong ETag +
   * proven conditional write) **and this device confirmed that exact content**.
   *
   * Used by the executor to recognize a cross-device move by uuid. Remote
   * `verified` only proves the file is protected by a conditional write; it
   * does not prove this device ever agreed with the uuid→path mapping. A
   * rebuilt ledger (uuid reassigned after loss) is `verified` too, so trusting
   * it alone would turn "another device renamed a file" into local file
   * operations without the user ever seeing it. `setIdentityLedgerTrust`
   * carries the local confirmation (W2b-2 anchor); until it is set,
   * read-only/missing/unconfirmed ledgers return null and are never guessed.
   */
  async readVerifiedIdentityLedger(): Promise<Record<string, string> | null> {
    if (!this.identityLedgerTrusted) return null;
    const loaded = await loadIdentityLedger(this.client);
    return loaded.state === "verified" && loaded.ledger
      ? { ...loaded.ledger.entries }
      : null;
  }

  /**
   * Set whether this device has confirmed the current ledger content.
   *
   * `false` is the construction default (fail-closed): a provider built without
   * a trust decision must not authorize identity inference. Startup bootstrap
   * sets it from the local anchor and its own ledger read; the runtime flips it
   * after a successful round anchors the ledger.
   */
  setIdentityLedgerTrust(trusted: boolean): void {
    this.identityLedgerTrusted = trusted;
  }

  /** Whether identity inference is currently authorized (diagnostics/tests). */
  get identityLedgerConfirmed(): boolean {
    return this.identityLedgerTrusted;
  }

  /**
   * Ledger facts for the local trust decision (W2b-2).
   *
   * Unlike `readVerifiedIdentityLedger`, this ignores the current trust state on
   * purpose: the caller is deciding whether to anchor the content. Only a
   * `verified` ledger (strong ETag + proven conditional write) may be anchored,
   * so `canUpdate` travels with the entries.
   */
  async readIdentityLedgerForTrust(): Promise<{
    readonly state: string;
    readonly canUpdate: boolean;
    readonly entries: Record<string, string> | null;
    readonly eTag: string | null;
  }> {
    const loaded = await loadIdentityLedger(this.client);
    return {
      state: loaded.state,
      canUpdate: loaded.canUpdate,
      entries: loaded.state === "verified" && loaded.ledger
        ? { ...loaded.ledger.entries }
        : null,
      eTag: loaded.eTag,
    };
  }

  async downloadBaseline(_vaultName: string): Promise<string | null> {
    return null;
  }

  // ---- Cloud Bootstrap V2 ----

  async readCloudBootstrapV2(
    _vaultName: string,
  ): Promise<{ id: string; eTag: string; content: string } | null> {
    const id = WEBDAV_CLOUD_BOOTSTRAP_V2_PATH;
    try {
      const read = await this.client.readFile(id);
      return {
        id,
        eTag: read.stat.eTag ?? "",
        content: decodeBytes(read.bytes),
      };
    } catch (error) {
      // 404 是「控制文件不存在」的合法首同步状态，不是失败。
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async readCloudBootstrapV2ById(
    id: string,
  ): Promise<{ id: string; eTag: string; content: string }> {
    const targetId = relativeId(id);
    const read = await this.client.readFile(this.clientPath(targetId));
    return {
      id: targetId,
      eTag: read.stat.eTag ?? "",
      content: decodeBytes(read.bytes),
    };
  }

  async createCloudBootstrapV2(
    _vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const bytes = new TextEncoder().encode(content);
    // 条件创建不可用时 client.createFile 会走 staged-MOVE 并自行建 tmp；
    // 控制目录本身仍需先确保存在，且不能靠无条件 PUT 猜。
    await this.client.ensureCollection(WEBDAV_CONTROL_DIRECTORY);
    const result = await this.client.createFile(
      WEBDAV_CLOUD_BOOTSTRAP_V2_PATH,
      bytes,
      { contentType: "application/json" },
    );
    return {
      id: WEBDAV_CLOUD_BOOTSTRAP_V2_PATH,
      eTag: result.stat.eTag ?? "",
    };
  }

  async updateCloudBootstrapV2(
    id: string,
    eTag: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const targetId = relativeId(id);
    const bytes = new TextEncoder().encode(content);
    const result = await this.client.updateFile(
      this.clientPath(targetId),
      bytes,
      eTag,
      { contentType: "application/json" },
    );
    return { id: targetId, eTag: result.stat.eTag ?? "" };
  }

  // ---- 共享同步协议画像（W2b2b1） ----

  /**
   * 读取 `.easy-sync` 的两个固定控制槽位。
   *
   * `expectedV3Slot` 刻意忽略：WebDAV 控制文件很小，始终读取真实字节比
   * identity 跳过更安全；列表截断、重复、collection 或读取失败都抛错。
   */
  async readSharedSyncProtocolObjects(
    _vaultName: string,
    _expectedV3Slot?: { id: string; eTag: string },
  ): Promise<WebDavSharedSyncProtocolObjectsObservation> {
    return await this.sharedProtocol.readObjects();
  }

  /** 按精确 V2 槽位路径读取（其它 ID 在发请求前拒绝）。 */
  async readSharedSyncProtocolV2ById(
    id: string,
  ): Promise<WebDavSharedSyncProtocolControlObject> {
    return await this.sharedProtocol.readById(id, "v2");
  }

  /** 安全创建 V2 predecessor；目标已存在时抛冲突，不覆盖。 */
  async createSharedSyncProtocolV2(
    _vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    return await this.sharedProtocol.create("v2", content);
  }

  /** V2 repair 的条件覆盖；调用方必须持有当前强 ETag。 */
  async overwriteSharedSyncProtocolV2(
    id: string,
    eTag: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    return await this.sharedProtocol.overwriteV2(id, eTag, content);
  }

  /** 按精确 V3 槽位路径读取（其它 ID 在发请求前拒绝）。 */
  async readSharedSyncProtocolV3ById(
    id: string,
  ): Promise<WebDavSharedSyncProtocolControlObject> {
    return await this.sharedProtocol.readById(id, "v3");
  }

  /** 安全创建 V3 generation 记录；目标已存在时抛冲突，不覆盖。 */
  async createSharedSyncProtocolV3(
    _vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    return await this.sharedProtocol.create("v3", content);
  }

  // ---- Delta 与全量扫描 ----

  async getDelta(
    vaultName: string,
    _deltaToken?: string,
    _onPage?: DeltaPageCallback,
  ): Promise<DeltaResponse> {
    // WebDAV 没有增量游标（deltaCursor=false）；退化为一次完整扫描，不伪造 deltaLink。
    return { value: await this.fullScan(vaultName) };
  }

  async getDeltaByFolderId(
    folderId: string,
    _deltaToken?: string,
    _onPage?: DeltaPageCallback,
  ): Promise<DeltaResponse> {
    return { value: await this.listFolder(folderId) };
  }

  async fullScan(_vaultName: string): Promise<DriveItem[]> {
    const items: DriveItem[] = [];
    const queue: string[] = [WEBDAV_ROOT_ID];
    for (let index = 0; index < queue.length; index += 1) {
      const children = await this.listFolder(queue[index]);
      for (const child of children) {
        items.push(child);
        if (child.folder) queue.push(child.id);
      }
    }
    return items;
  }

  // ---- 内部映射 ----

  /**
   * 共用的改名／移动执行器。
   *
   * 1. 源／目标都不得落在控制面；
   * 2. 必须持有复核过的强 ETag；
   * 3. 移动前 `PROPFIND` 复核源身份与 ETag；
   * 4. `MOVE Overwrite: F`（目标已存在即拒绝）；
   * 5. 移动后回读目标形态与源消失；任一不符 fail-closed。
   */
  private async moveAt(
    sourceId: string,
    targetId: string,
    eTag: string,
    operation: "rename" | "move",
  ): Promise<DriveItem> {
    this.assertUserPath(sourceId, operation);
    this.assertUserPath(targetId, operation);
    const reviewedETag = this.requireMutationEtag(sourceId, eTag);
    if (sourceId === targetId) {
      const current = await this.metadataAt(sourceId);
      if (!current) {
        throw new RemoteError(
          RemoteErrorType.NotFound,
          `WebDAV ${operation} source not found: ${sourceId}`,
          404,
          null,
          "http-404",
        );
      }
      return current;
    }

    let source: WebDavResourceStat | null;
    try {
      source = await this.client.stat(this.clientPath(sourceId));
    } catch (error) {
      throw this.mutationError(sourceId, error);
    }
    if (!source) {
      throw new RemoteError(
        RemoteErrorType.NotFound,
        `WebDAV ${operation} source not found: ${sourceId}`,
        404,
        null,
        "http-404",
      );
    }
    if (source.eTag !== reviewedETag) {
      throw new RemoteError(
        RemoteErrorType.PreconditionFailed,
        `WebDAV ${operation} source ETag changed: ${sourceId}`,
        412,
        null,
        "webdav-source-etag-changed",
      );
    }

    try {
      await this.client.moveFile(
        this.clientPath(sourceId),
        this.clientPath(targetId),
        { ifMatch: reviewedETag },
      );
    } catch (error) {
      throw this.mutationError(targetId, error);
    }

    let target: WebDavResourceStat | null;
    let sourceAfter: WebDavResourceStat | null;
    try {
      [target, sourceAfter] = await Promise.all([
        this.client.stat(this.clientPath(targetId)),
        this.client.stat(this.clientPath(sourceId)),
      ]);
    } catch (error) {
      throw this.mutationError(targetId, error);
    }
    if (!target) {
      throw new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV ${operation} readback target missing: ${targetId}`,
        409,
        null,
        "webdav-move-readback",
      );
    }
    if (target.kind !== source.kind) {
      throw new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV ${operation} readback kind changed: ${targetId}`,
        409,
        null,
        "webdav-move-readback",
      );
    }
    if (sourceAfter) {
      throw new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV ${operation} readback source still present: ${sourceId}`,
        409,
        null,
        "webdav-move-readback",
      );
    }
    await this.rebindIdentityOnMove(sourceId, targetId);
    return this.toDriveItem(target, targetId);
  }

  /**
   * Best-effort sidecar identity rebind after a successful user move.
   *
   * Only a verified ledger (strong ETag + proven conditional update) is
   * touched. Missing/read-only/unverified ledgers, a missing binding, a
   * concurrent conflict, or any write failure leave the move successful; the
   * next verification/rebuild settles the record instead of blocking data.
   */
  private async rebindIdentityOnMove(
    fromId: string,
    toId: string,
  ): Promise<void> {
    try {
      const loaded = await loadIdentityLedger(this.client);
      if (
        loaded.state !== "verified"
        || !loaded.ledger
        || !loaded.eTag
        || !loaded.canUpdate
      ) return;
      const id = idForPath(loaded.ledger, fromId);
      if (id === null) return;
      if (idForPath(loaded.ledger, toId) === id) return;
      const next = moveIdentity(loaded.ledger, id, toId);
      await saveIdentityLedger(this.client, next, {
        kind: "update",
        eTag: loaded.eTag,
      });
    } catch {
      // Data safety first: the remote MOVE already succeeded; a ledger
      // conflict must not turn it into a failed user action.
    }
  }

  /** 用户数据 mutation 必须持有复核过的强 ETag；弱／缺失在发请求前拒绝。 */
  private requireMutationEtag(
    id: string,
    eTag: string | null | undefined,
  ): string {
    const normalized = eTag?.trim() ?? "";
    if (normalized.length === 0 || isWeakETag(normalized)) {
      throw new RemoteError(
        RemoteErrorType.PreconditionFailed,
        `WebDAV mutation requires a reviewed strong ETag: ${id}`,
        412,
        null,
        "webdav-mutation-requires-etag",
      );
    }
    return normalized;
  }

  /** 控制面（`.easy-sync/**`、scope 回退标记）与根集合不参与用户 mutation。 */
  private assertUserPath(id: string, operation: string): void {
    if (id === WEBDAV_ROOT_ID) {
      throw new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV ${operation} cannot target the root collection`,
        409,
        null,
        "webdav-root-immutable",
      );
    }
    const absolute = joinWebDavPath(this.client.rootPath, id);
    if (isWebDavControlPlanePath(this.client.rootPath, absolute)) {
      throw new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV ${operation} cannot touch the control plane: ${id}`,
        409,
        null,
        "webdav-control-plane-immutable",
      );
    }
  }

  /** 把安全客户端的条件错误折成引擎可识别的中性冲突。 */
  private mutationError(id: string, error: unknown): unknown {
    if (error instanceof RemoteError) return error;
    if (error instanceof WebDavTargetExistsError) {
      return new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV target already exists: ${id}`,
        409,
        null,
        "webdav-target-exists",
      );
    }
    if (error instanceof WebDavPreconditionFailedError) {
      return new RemoteError(
        RemoteErrorType.PreconditionFailed,
        `WebDAV precondition failed: ${id}`,
        412,
        null,
        "webdav-precondition-failed",
      );
    }
    if (error instanceof WebDavUnsafeDeleteError) {
      return new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV delete refused: ${id}`,
        409,
        null,
        "webdav-unsafe-delete",
      );
    }
    if (error instanceof WebDavListingIncompleteError) {
      return new RemoteError(
        RemoteErrorType.Conflict,
        `WebDAV listing incomplete: ${id}`,
        409,
        null,
        "webdav-listing-incomplete",
      );
    }
    return error;
  }

  private async metadataAt(path: string): Promise<DriveItem | null> {
    const id = relativeId(path);
    const stat = await this.client.stat(this.clientPath(id));
    return stat ? this.toDriveItem(stat, id) : null;
  }

  /**
   * Depth 1 列一个目录的直接子项。
   *
   * 列表 `complete=false` 一律抛错（不得把截断当完整，也不得据此推断删除）；
   * 控制面 `.easy-sync/**` 与 `.easy-sync-scope.json` 在此整棵排除。
   *
   * 根集合 404 必须与普通子目录 404 区分：引擎的 `tryDeltaOrFullScan` 会把
   * `RemoteError(NotFound)` 当成「远端为空／新建」并持久化空快照；根被删除
   * 时那会直接变成删除本地基线的确认计划。因此根 404 改抛
   * `WebDavRootMissingError`（非 `RemoteError`），让整轮失败而不是产生删除。
   */
  private async listFolder(folderId: string): Promise<DriveItem[]> {
    const id = relativeId(folderId);
    let listing: Awaited<ReturnType<WebDavClient["list"]>>;
    try {
      listing = await this.client.list(this.clientPath(id));
    } catch (error) {
      if (id === WEBDAV_ROOT_ID && isNotFoundError(error)) {
        throw new WebDavRootMissingError(this.client.rootPath);
      }
      if (error instanceof WebDavPaginationError) {
        throw new RemoteError(
          RemoteErrorType.Conflict,
          `WebDAV listing pagination refused: ${error.message}`,
          409,
          null,
          "webdav-pagination-invalid",
        );
      }
      throw error;
    }
    if (!listing.complete) {
      throw new WebDavListingIncompleteError(
        joinWebDavPath(this.client.rootPath, id),
        listing.responseEntryCount,
        listing.entryLimit,
      );
    }
    const items: DriveItem[] = [];
    for (const entry of listing) {
      if (isWebDavControlPlanePath(this.client.rootPath, entry.path)) continue;
      items.push(this.toDriveItem(entry, relativeId(entry.relativePath)));
    }
    return items;
  }

  private toDriveItem(stat: WebDavResourceStat, id: string): DriveItem {
    const item: DriveItem = {
      id,
      name: this.nameOfId(id),
      parentReference: {
        driveId: this.driveId,
        id: parentIdOf(id),
      },
    };
    if (stat.kind === "collection") {
      item.folder = {};
    } else {
      item.file = {};
      item.size = stat.size ?? 0;
    }
    if (stat.eTag !== null) item.eTag = stat.eTag;
    if (stat.lastModified !== null) item.lastModifiedDateTime = stat.lastModified;
    return item;
  }

  /**
   * 逐级补齐上传目标的父级链（W2b-4，**只用于上传**）。
   *
   * WebDAV 的 MKCOL 只建最后一级，父级缺失时服务器返回 409，它不会替你递归
   * （坚果云真实 L2 已核证）。从本地新建的多级目录首批上传（远端整条链都不
   * 存在）时，只对直接父级调一次 MKCOL 必然失败。
   *
   * 为什么建夹不这样递归：`createFolderPath`／`createFolderByParentId` 的契约
   * 是「父级缺失就上抛 409，不静默合成」——设计 §13.3 明确要求初始化不递归
   * 猜路径，否则一个拼错的深层路径会悄悄造出一整棵空目录。上传不同：引擎已经
   * 决定要写这个文件，它的父级就是必须存在的前提，补齐是执行这个决定而不是
   * 扩大用户意图。
   *
   * 每一级都走 `ensureCollection`（已存在由客户端按幂等吞掉 405／201），从最浅
   * 一级开始，保证父级先于子级存在。不做存在性预读：多一次 PROPFIND 换不来
   * 更强的保证，只多一轮往返。
   */
  private async ensureCollectionChain(id: string): Promise<void> {
    const segments = id.split("/").filter((segment) => segment.length > 0);
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (this.ensuredCollectionIds.has(current)) continue;
      await this.client.ensureCollection(current);
      this.ensuredCollectionIds.add(current);
    }
  }

  /**
   * 真实创建集合（MKCOL）后回读 PROPFIND，返回服务器元数据。
   *
   * 已存在由客户端按幂等处理；父级缺失时 MKCOL 的 409 原样上抛，不合成。
   */
  private async createFolderAt(id: string): Promise<DriveItem> {
    if (id !== WEBDAV_ROOT_ID) {
      await this.client.ensureCollection(id);
      this.ensuredCollectionIds.add(id);
    }
    const stat = await this.client.stat(this.clientPath(id));
    if (!stat || stat.kind !== "collection") {
      throw new Error(`WebDAV folder creation did not produce a collection: ${id}`);
    }
    return this.toDriveItem(stat, id);
  }

  private toUploadResult(
    stat: WebDavResourceStat,
    id: string,
    fallbackSize: number,
  ): UploadResult {
    return {
      id,
      name: this.nameOfId(id),
      size: stat.size ?? fallbackSize,
      eTag: stat.eTag ?? undefined,
      lastModifiedDateTime: stat.lastModified ?? this.now().toISOString(),
      parentReference: {
        driveId: this.driveId,
        id: parentIdOf(id),
      },
    };
  }

  private vaultScope(): RemoteVaultScope {
    return {
      driveId: this.driveId,
      vaultFolderId: WEBDAV_ROOT_ID,
      filesRootId: WEBDAV_ROOT_ID,
    };
  }

  private clientPath(id: string): string {
    return id === WEBDAV_ROOT_ID ? "" : id;
  }

  private nameOfId(id: string): string {
    if (id === WEBDAV_ROOT_ID) {
      if (this.client.rootPath === WEBDAV_ROOT_ID) return WEBDAV_ROOT_ID;
      const segments = this.client.rootPath.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? WEBDAV_ROOT_ID;
    }
    const index = id.lastIndexOf("/");
    return index < 0 ? id : id.slice(index + 1);
  }
}

/** 规范化 vault 相对路径；根统一为 `"/"`，条目无前导 `/`。 */
function relativeId(path: string): string {
  const normalized = normalizeWebDavPath(path.length === 0 ? "/" : path);
  return normalized === "/" ? WEBDAV_ROOT_ID : normalized.slice(1);
}

/** 父路径；顶层与根自身都返回根 ID。 */
function parentIdOf(id: string): string {
  if (id === WEBDAV_ROOT_ID) return WEBDAV_ROOT_ID;
  const index = id.lastIndexOf("/");
  return index <= 0 ? WEBDAV_ROOT_ID : id.slice(0, index);
}

/** `Uint8Array` → 独立 `ArrayBuffer`（避免共享底层缓冲区）。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** 控制面内容按 UTF-8 读取；非法字节由 TextDecoder 的替换字符兜底。 */
function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** 404 是「不存在」而不是普通失败；其余错误继续上抛。 */
function isNotFoundError(error: unknown): boolean {
  return error instanceof RemoteError
    && (error.type === RemoteErrorType.NotFound || error.statusCode === 404);
}

// ---- 编译期合同断言 ----
// WebDavProvider 必须持续可赋值给 SyncProvider：任一合同方法漂移时这里编译红。
type WebDavProviderImplementsSyncProvider = WebDavProvider extends SyncProvider
  ? true
  : never;
const webDavProviderImplementsSyncProvider: WebDavProviderImplementsSyncProvider =
  true;
void webDavProviderImplementsSyncProvider;
