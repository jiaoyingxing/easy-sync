/**
 * SyncProvider — 重构刀 5a 插座（零行为）。
 *
 * 把同步引擎（SyncExecutor 及其从引擎接收客户端的辅助模块）对 OneDrive
 * 客户端的消费面收拢成一个结构化接口：引擎字段 `onedrive` 的类型从
 * `OneDriveClient` 放宽为 `SyncProvider`，全部 `this.onedrive.*` 调用点、
 * 方法体、日志与字符串一字不动；构造点（src/main.ts）继续传入同一个
 * OneDriveClient 实例，结构化类型天然满足。OneDrive 行为零变化。
 *
 * 刀 5b（持久化中性化）开工时，本接口是待中性化的合同面：方法集与签名
 * 逐字复制自 OneDriveClient 的对应公开方法（含参数名、可选性、返回类型）。
 * 未收拢进本合同的能力（共享协议 V2/V3 写面的可选方法、`getDriveItemMetadataByIds`
 * 批量探针、RS 迁移专用方法）仍由引擎侧以能力探测（typeof 守卫）或
 * main.ts 直接持有的 OneDriveClient 消费，不属本合同。
 *
 * 签名引用的类型一律从既有模块 import（onedrive/types、onedrive/client 的
 * 导出类型、obsidian），不 import sync-executor（防环）。client.ts 中未导出
 * 的私有返回类型在下方「逐字镜像块」同形声明——结构相同即可赋值；镜像块
 * 与 client.ts 的漂移由文件末尾的编译期防漂移断言或引擎编译红拦截。
 *
 * 刀 5b 词汇表（2026-11-02，中性概念 ↔ OneDrive 字段映射）：本合同面与
 * 模型层的提供方元数据一律按中性概念声明（types.ts 的零运行时别名，
 * 字段名保留历史名）——
 *   外部条目身份 ExternalItemId ← driveId／parentId／remoteId（实存 driveItem id）
 *   版本令牌 VersionToken ← eTag（If-Match 全链＋三方比较兜底）
 *   内容版本令牌 ContentVersionToken ← cTag（rename/move 不变的次级令牌）
 *   强内容指纹 StrongContentFingerprint ← sha256Hash（逐字节等值证据）
 *   弱内容指纹 WeakContentFingerprint ← quickXorHash（只证不同）
 *   集合状态令牌 ← deltaLink／cursorRevision（换游标不算内容变化）
 *   集合根身份 ← SyncScope.driveId（与条目级历史名 driveId 名同实异）
 */

import type { DataAdapter } from "obsidian";
import type {
  DeltaPageCallback,
  DeltaResponse,
  DriveItem,
  DriveItemVersion,
  RemoteVaultScope,
  UploadResult,
} from "../onedrive/types";
import type {
  OneDriveClient,
  OneDriveMetadataReason,
  SharedSyncProtocolBindingProvenObject,
} from "../onedrive/client";

// ---- 逐字镜像块：client.ts 私有类型（未导出，无法 import，同形声明）----

/** 镜像 client.ts 私有 `UploadProgressCallback`。 */
type UploadProgressCallback = (
  uploadedBytes: number,
  totalBytes: number,
) => void;

/** 镜像 client.ts 私有 `DownloadToPathResult`。 */
interface DownloadToPathResult {
  size: number;
  hash: string;
}

/** 镜像 client.ts 私有 `OneDriveEndpointCategory`。 */
type OneDriveEndpointCategory =
  | "metadata"
  | "delta"
  | "simpleUpload"
  | "uploadSessionCreate"
  | "uploadSessionChunk"
  | "uploadSessionStatus"
  | "uploadSessionCancel"
  | "downloadUrl"
  | "contentFallback";

/** 镜像 client.ts 私有 `OneDriveAttemptStatusCategory`。 */
type OneDriveAttemptStatusCategory =
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

/** 镜像 client.ts 私有 `OneDriveMetadataReasonRunMetrics`。 */
interface OneDriveMetadataReasonRunMetrics {
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  elapsedMs: number;
}

/** 镜像 client.ts 私有 `OneDriveEndpointRunMetrics`。 */
interface OneDriveEndpointRunMetrics {
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

/** 镜像 client.ts 私有 `OneDriveRunMetricsSummary`。 */
interface OneDriveRunMetricsSummary {
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

/** 镜像 client.ts 私有 `SharedSyncProtocolControlObject`。 */
interface SharedSyncProtocolControlObject {
  id: string;
  eTag: string;
  content: string;
}

/** 镜像 client.ts 私有 `SharedSyncProtocolObjectsObservation`。 */
interface SharedSyncProtocolObjectsObservation {
  v2: SharedSyncProtocolControlObject | null;
  v3:
    | SharedSyncProtocolControlObject
    | SharedSyncProtocolBindingProvenObject
    | null;
}

/**
 * 同步引擎对云端客户端的消费合同（刀 5a 插座）。
 *
 * 方法集 = SyncExecutor 的 `this.onedrive.*` 实调（30 个方法）＋引擎内
 * cloud-bootstrap 传输工厂实调（4 个方法）。签名逐字复制自 OneDriveClient
 * 对应公开方法；客户端侧带默认值的参数在这里以可选参数表达（接口不能
 * 携带默认值，函数类型层面等价）。
 */
export interface SyncProvider {
  // ---- 运行度量与中断 ----
  setAbortSignal(signal: AbortSignal | null): void;
  beginRunMetrics(): void;
  finishRunMetrics(): OneDriveRunMetricsSummary | null;

  // ---- 文件夹创建 ----
  createFolderPath(
    vaultName: string,
    folderPath: string,
  ): Promise<DriveItem | null>;
  createFolderByParentId(
    parentDriveItemId: string,
    name: string,
  ): Promise<DriveItem>;

  // ---- 元数据读 ----
  getDriveItemMetadata(
    vaultName: string,
    itemPath: string,
  ): Promise<DriveItem | null>;
  getDriveItemMetadataById(
    driveItemId: string,
    metadataReason?: OneDriveMetadataReason,
  ): Promise<DriveItem | null>;
  listDriveItemVersionsById(
    driveItemId: string,
    metadataReason?: OneDriveMetadataReason,
  ): Promise<DriveItemVersion[]>;
  restoreDeletedDriveItemById(driveItemId: string): Promise<void>;
  getFileMetadataByPaths(
    vaultName: string,
    filePaths: readonly string[],
    metadataReason?: OneDriveMetadataReason,
  ): Promise<Map<string, DriveItem | null>>;
  listFolderChildrenById(driveItemId: string): Promise<DriveItem[]>;
  getFileMetadata(
    vaultName: string,
    filePath: string,
    metadataReason?: OneDriveMetadataReason,
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
  } | null>;

  // ---- Vault 范围生命周期 ----
  initVaultScope(
    vaultName: string,
    options?: { createMissing?: boolean },
  ): Promise<RemoteVaultScope>;
  restoreVaultScope(
    vaultName: string,
    scope: RemoteVaultScope,
    deltaLink: string,
  ): boolean;
  restoreVaultScopeByIdentity(
    vaultName: string,
    scope: RemoteVaultScope,
  ): Promise<RemoteVaultScope>;
  invalidateVaultScope(vaultName: string): void;
  isDeltaLinkForVault(vaultName: string, deltaLink: string): boolean;

  // ---- 下载策略（每轮提示） ----
  resetDownloadStrategy(): void;
  hasDegradedDownloadPathThisRound(): boolean;

  // ---- 传输 ----
  uploadFile(
    vaultName: string,
    filePath: string,
    content: ArrayBuffer,
    onProgress?: UploadProgressCallback,
    eTag?: string,
    driveItemId?: string,
  ): Promise<UploadResult>;
  downloadFile(
    vaultName: string,
    filePath: string,
    downloadUrl?: string,
    driveItemId?: string,
    fileSize?: number,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<ArrayBuffer>;
  downloadFileToPath(
    vaultName: string,
    filePath: string,
    localPath: string,
    adapter: DataAdapter,
    downloadUrl?: string,
    driveItemId?: string,
    fileSize?: number,
    expectedSha256?: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<DownloadToPathResult>;
  deleteItem(
    vaultName: string,
    itemPath: string,
    matchTag?: string,
    driveItemId?: string,
  ): Promise<void>;
  renameItem(
    _vaultName: string,
    _oldPath: string,
    newPath: string,
    driveItemId: string,
    eTag: string,
  ): Promise<DriveItem>;
  moveItemById(
    driveItemId: string,
    eTag: string,
    newName: string,
    newParentId: string,
  ): Promise<DriveItem>;
  downloadBaseline(vaultName: string): Promise<string | null>;

  // ---- Cloud Bootstrap V2 ----
  readCloudBootstrapV2(
    vaultName: string,
  ): Promise<{ id: string; eTag: string; content: string } | null>;
  readCloudBootstrapV2ById(
    id: string,
  ): Promise<{ id: string; eTag: string; content: string }>;
  createCloudBootstrapV2(
    vaultName: string,
    content: string,
  ): Promise<{ id: string; eTag: string }>;
  updateCloudBootstrapV2(
    id: string,
    eTag: string,
    content: string,
  ): Promise<{ id: string; eTag: string }>;

  // ---- 共享同步协议画像 ----
  readSharedSyncProtocolObjects(
    vaultName: string,
    expectedV3Slot?: { id: string; eTag: string },
  ): Promise<SharedSyncProtocolObjectsObservation>;

  // ---- Delta 与全量扫描 ----
  getDelta(
    vaultName: string,
    deltaToken?: string,
    onPage?: DeltaPageCallback,
  ): Promise<DeltaResponse>;
  getDeltaByFolderId(
    folderId: string,
    deltaToken?: string,
    onPage?: DeltaPageCallback,
  ): Promise<DeltaResponse>;
  fullScan(vaultName: string): Promise<DriveItem[]>;
}

// ---- 编译期防漂移断言 ----
// OneDriveClient 必须持续可赋值给 SyncProvider：任一被收拢方法在 client.ts
// 漂移（改名、参数、可选性、返回类型）时，下面的值级赋值编译红。纯类型级
// 检查：不构造实例，运行期只有一个常量布尔，零行为。刻意不导出——防漂移
// 检查只属于本文件，export-surface 门也要求导出必须有文件外引用。
type OneDriveClientImplementsSyncProvider = OneDriveClient extends SyncProvider
  ? true
  : never;
const oneDriveClientImplementsSyncProvider: OneDriveClientImplementsSyncProvider =
  true;
// 断言常量只在本文件消费（防漂移检查不外泄成导出面）；void 保持零运行时行为。
void oneDriveClientImplementsSyncProvider;
