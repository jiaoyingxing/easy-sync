/**
 * WebDAV 共享同步协议控制对象（W2b2b1）。
 *
 * 只负责 `.easy-sync/protocol-v2.json` 与 `.easy-sync/protocol-v3.json` 的
 * 存取，不生成协议内容（内容由 `src/sync/sync-protocol-v2.ts`／
 * `sync-protocol-v3.ts` 生成），也不接引擎／StateManager／`src/main.ts`。
 *
 * 安全口径：
 * - ID 用规范化 vault 相对路径，与 provider 的 WebDAV 条目 ID 一致；
 *   `readById` 只接受两个精确槽位路径。
 * - ETag 必须来自 PROPFIND（`WebDavClient.stat`／写入后的 readback），且只
 *   接受强 ETag；弱 ETag 或缺失一律 fail-closed。
 * - 内容上限 1 MiB，创建／更新前按实际 UTF-8 字节拒绝；读取时既看声明长度，
 *   也看 GET 实际字节。
 * - `.easy-sync` 不存在 → 两个槽位都返回 null；列表截断、重复槽位、槽位是
 *   collection、读取失败（非 404）都必须抛错，不能伪装成「不存在」。
 */
import { RemoteError, RemoteErrorType } from "../../remote/errors";
import { WEBDAV_CONTROL_DIRECTORY } from "./webdav-scope";
import { isWeakETag } from "./webdav-probe";
import {
  WebDavClient,
  WebDavPreconditionFailedError,
  WebDavTargetExistsError,
  type WebDavListResult,
  type WebDavResourceStat,
} from "./webdav-client";

/** 共享协议控制对象的内容上限（1 MiB，与 OneDrive 同名常量同值）。 */
export const MAX_SHARED_PROTOCOL_BYTES = 1024 * 1024;

/** V2 控制对象（不可变 predecessor）的 vault 相对路径。 */
export const WEBDAV_SHARED_PROTOCOL_V2_PATH =
  `${WEBDAV_CONTROL_DIRECTORY}/protocol-v2.json`;

/** V3 控制对象（generation 记录）的 vault 相对路径。 */
export const WEBDAV_SHARED_PROTOCOL_V3_PATH =
  `${WEBDAV_CONTROL_DIRECTORY}/protocol-v3.json`;

export type WebDavSharedProtocolSlot = "v2" | "v3";

export interface WebDavSharedSyncProtocolControlObject {
  id: string;
  eTag: string;
  content: string;
}

/**
 * 一次控制目录观察。该切片不做 V3 binding 跳过优化：`expectedV3Slot` 被
 * 刻意忽略，两个槽位只要存在就总是携带真实内容。
 */
export interface WebDavSharedSyncProtocolObjectsObservation {
  v2: WebDavSharedSyncProtocolControlObject | null;
  v3: WebDavSharedSyncProtocolControlObject | null;
}

/** 控制对象层错误基类；调用方可按具体子类区分失败语义。 */
export class WebDavSharedProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavSharedProtocolError";
  }
}

/** 槽位路径／形态不合法（未知 ID、重复、非文件、控制目录不是集合）。 */
export class WebDavSharedProtocolSlotError extends WebDavSharedProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "WebDavSharedProtocolSlotError";
  }
}

/** ETag 缺失或为弱 ETag；不能用于读取绑定或 If-Match。 */
export class WebDavSharedProtocolEtagError extends WebDavSharedProtocolError {
  constructor(
    readonly objectId: string,
    readonly detail: "missing" | "weak" | "caller-missing" | "caller-weak",
  ) {
    super(
      `WebDAV shared protocol object ${objectId} has ${detail === "missing" || detail === "caller-missing" ? "no" : "a weak"} ETag; refusing to bind or write without a strong ETag`,
    );
    this.name = "WebDavSharedProtocolEtagError";
  }
}

/** 控制对象超过 1 MiB；不会发出内容写入请求。 */
export class WebDavSharedProtocolTooLargeError extends WebDavSharedProtocolError {
  constructor(
    readonly objectId: string,
    readonly bytes: number,
    readonly limit: number = MAX_SHARED_PROTOCOL_BYTES,
  ) {
    super(
      `WebDAV shared protocol object ${objectId} is ${bytes} bytes, above the ${limit}-byte limit`,
    );
    this.name = "WebDavSharedProtocolTooLargeError";
  }
}

/** 控制目录列表达到服务器单次响应上限，可能截断；不能据此当作空目录。 */
export class WebDavSharedProtocolListingIncompleteError
  extends WebDavSharedProtocolError {
  constructor(
    readonly directory: string,
    readonly responseEntryCount: number,
    readonly limit: number,
  ) {
    super(
      `WebDAV shared protocol directory ${directory} returned ${responseEntryCount} response entries (limit ${limit}); refusing to treat a possibly truncated listing as complete`,
    );
    this.name = "WebDavSharedProtocolListingIncompleteError";
  }
}

/**
 * 冲突／412。继承中性 `RemoteError`，让引擎既有错误路由能识别并 fail-closed，
 * 而不是把「目标已存在」或「陈旧 ETag」当成写入成功。
 */
export class WebDavSharedProtocolConflictError extends RemoteError {
  constructor(
    readonly objectId: string,
    readonly reason: "target-exists" | "precondition-failed",
    statusCode: number,
  ) {
    super(
      reason === "target-exists"
        ? RemoteErrorType.Conflict
        : RemoteErrorType.PreconditionFailed,
      reason === "target-exists"
        ? `WebDAV shared protocol target already exists: ${objectId}`
        : `WebDAV shared protocol precondition failed for ${objectId}`,
      statusCode,
      null,
      reason,
    );
    this.name = "WebDavSharedProtocolConflictError";
  }
}

/**
 * 两个固定槽位的存取器。
 *
 * 所有方法只做控制对象读写；不探测能力差异，能力由 `WebDavClient` 先行
 * 探针决定（条件创建、staged-MOVE、`If-Match`）。
 */
export class WebDavSharedProtocolStore {
  constructor(private readonly client: WebDavClient) {}

  /**
   * 读取 `.easy-sync` 的完整控制目录观察。
   *
   * `expectedV3Slot` 刻意不参与决策：控制文件很小，字节证明比 identity
   * 跳过更安全；这里始终读取两个槽位的真实内容。
   */
  async readObjects(
    _expectedV3Slot?: { readonly id: string; readonly eTag: string },
  ): Promise<WebDavSharedSyncProtocolObjectsObservation> {
    const directoryStat = await this.client.stat(WEBDAV_CONTROL_DIRECTORY);
    if (directoryStat === null) return { v2: null, v3: null };
    if (directoryStat.kind !== "collection") {
      throw new WebDavSharedProtocolSlotError(
        `WebDAV shared protocol path ${WEBDAV_CONTROL_DIRECTORY} is not a collection`,
      );
    }

    let listing: WebDavListResult;
    try {
      listing = await this.client.list(WEBDAV_CONTROL_DIRECTORY);
    } catch (error) {
      // 目录在 stat 之后消失：与「控制目录不存在」同义；其余失败原样上抛。
      if (isNotFoundError(error)) return { v2: null, v3: null };
      throw error;
    }
    if (!listing.complete) {
      throw new WebDavSharedProtocolListingIncompleteError(
        WEBDAV_CONTROL_DIRECTORY,
        listing.responseEntryCount,
        listing.entryLimit,
      );
    }

    const v2Entry = selectProtocolSlot(listing, WEBDAV_SHARED_PROTOCOL_V2_PATH);
    const v3Entry = selectProtocolSlot(listing, WEBDAV_SHARED_PROTOCOL_V3_PATH);
    const [v2, v3] = await Promise.all([
      v2Entry === null
        ? Promise.resolve(null)
        : this.readSlot(WEBDAV_SHARED_PROTOCOL_V2_PATH),
      v3Entry === null
        ? Promise.resolve(null)
        : this.readSlot(WEBDAV_SHARED_PROTOCOL_V3_PATH),
    ]);
    return { v2, v3 };
  }

  /** 按精确槽位路径读取；未知路径在发请求前拒绝。 */
  async readById(
    id: string,
    slot: WebDavSharedProtocolSlot,
  ): Promise<WebDavSharedSyncProtocolControlObject> {
    assertSlotId(id, slot);
    const object = await this.readSlot(id);
    if (object === null) {
      throw new RemoteError(
        RemoteErrorType.NotFound,
        `WebDAV shared protocol object not found: ${id}`,
        404,
        null,
        "http-404",
      );
    }
    return object;
  }

  /** 安全新建一个槽位；目标已存在时抛冲突，绝不覆盖。 */
  async create(
    slot: WebDavSharedProtocolSlot,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    const id = pathForSlot(slot);
    const bytes = encodeContent(id, content);
    await this.client.ensureCollection(WEBDAV_CONTROL_DIRECTORY);

    let result: Awaited<ReturnType<WebDavClient["createFile"]>>;
    try {
      result = await this.client.createFile(id, bytes, {
        contentType: "application/json",
      });
    } catch (error) {
      if (error instanceof WebDavTargetExistsError) {
        throw new WebDavSharedProtocolConflictError(id, "target-exists", 412);
      }
      throw error;
    }
    assertReadbackWithinLimit(id, result.stat);
    return {
      id: requireReadbackPath(id, result.stat),
      eTag: requireStrongETag(id, result.stat),
    };
  }

  /**
   * V2 repair 的条件覆盖：只允许 `protocol-v2.json`，调用方必须持有当前强
   * ETag。412／409 抛冲突，不自动重读合并。
   */
  async overwriteV2(
    id: string,
    eTag: string,
    content: string,
  ): Promise<{ id: string; eTag: string }> {
    assertSlotId(id, "v2");
    requireStrongCallerETag(id, eTag);
    const bytes = encodeContent(id, content);

    let result: Awaited<ReturnType<WebDavClient["updateFile"]>>;
    try {
      result = await this.client.updateFile(id, bytes, eTag, {
        contentType: "application/json",
      });
    } catch (error) {
      if (error instanceof WebDavPreconditionFailedError) {
        throw new WebDavSharedProtocolConflictError(
          id,
          "precondition-failed",
          412,
        );
      }
      throw error;
    }
    assertReadbackWithinLimit(id, result.stat);
    return {
      id: requireReadbackPath(id, result.stat),
      eTag: requireStrongETag(id, result.stat),
    };
  }

  /** 读取单个槽位；404 → null，其余失败原样上抛（不伪装成空）。 */
  private async readSlot(
    id: string,
  ): Promise<WebDavSharedSyncProtocolControlObject | null> {
    const stat = await this.client.stat(id);
    if (stat === null) return null;
    assertFileStat(id, stat);
    assertDeclaredSize(id, stat.size);

    let read: Awaited<ReturnType<WebDavClient["readFile"]>>;
    try {
      read = await this.client.readFile(id, { stat });
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
    assertDeclaredSize(id, read.stat.size);
    if (read.bytes.byteLength > MAX_SHARED_PROTOCOL_BYTES) {
      throw new WebDavSharedProtocolTooLargeError(
        id,
        read.bytes.byteLength,
      );
    }
    return {
      id,
      eTag: requireStrongETag(id, read.stat),
      content: decodeBytes(read.bytes),
    };
  }
}

function pathForSlot(slot: WebDavSharedProtocolSlot): string {
  return slot === "v2"
    ? WEBDAV_SHARED_PROTOCOL_V2_PATH
    : WEBDAV_SHARED_PROTOCOL_V3_PATH;
}

function slotForId(id: string): WebDavSharedProtocolSlot | null {
  if (id === WEBDAV_SHARED_PROTOCOL_V2_PATH) return "v2";
  if (id === WEBDAV_SHARED_PROTOCOL_V3_PATH) return "v3";
  return null;
}

function assertSlotId(id: string, slot: WebDavSharedProtocolSlot): void {
  const actual = slotForId(id);
  if (actual === null) {
    throw new WebDavSharedProtocolSlotError(
      `WebDAV shared protocol ID is not one of the fixed slots: ${id}`,
    );
  }
  if (actual !== slot) {
    throw new WebDavSharedProtocolSlotError(
      `WebDAV shared protocol ${slot} call cannot use the ${actual} slot: ${id}`,
    );
  }
}

/**
 * 从完整列表中选择固定槽位：无匹配 → null，重复或不是 file → 抛错。
 */
function selectProtocolSlot(
  listing: WebDavListResult,
  targetPath: string,
): WebDavResourceStat | null {
  const matches = listing.filter((entry) => entry.relativePath === targetPath);
  if (matches.length > 1) {
    throw new WebDavSharedProtocolSlotError(
      `WebDAV shared protocol slot ${targetPath} is duplicated (${matches.length} entries)`,
    );
  }
  const match = matches[0];
  if (match === undefined) return null;
  assertFileStat(targetPath, match);
  return match;
}

function assertFileStat(
  id: string,
  stat: Pick<WebDavResourceStat, "kind">,
): void {
  if (stat.kind !== "file") {
    throw new WebDavSharedProtocolSlotError(
      `WebDAV shared protocol slot ${id} is not a file`,
    );
  }
}

function assertDeclaredSize(id: string, size: number | null): void {
  if (size !== null && size > MAX_SHARED_PROTOCOL_BYTES) {
    throw new WebDavSharedProtocolTooLargeError(id, size);
  }
}

function assertReadbackWithinLimit(
  id: string,
  stat: WebDavResourceStat,
): void {
  assertDeclaredSize(id, stat.size);
}

/** 回读路径必须与请求的固定槽位一致；否则本次写入的 id 不可信。 */
function requireReadbackPath(
  id: string,
  stat: Pick<WebDavResourceStat, "relativePath">,
): string {
  if (stat.relativePath !== id) {
    throw new WebDavSharedProtocolSlotError(
      `WebDAV shared protocol readback path mismatch for ${id}: ${stat.relativePath}`,
    );
  }
  return stat.relativePath;
}

/** 只接受非空强 ETag；ETag 的 DQUOTE 形态不是校验重点，弱前缀与缺失才是失败条件。 */
function requireStrongETag(
  id: string,
  stat: Pick<WebDavResourceStat, "eTag" | "weakETag">,
): string {
  if (stat.eTag === null || stat.eTag.trim().length === 0) {
    throw new WebDavSharedProtocolEtagError(id, "missing");
  }
  if (stat.weakETag || isWeakETag(stat.eTag)) {
    throw new WebDavSharedProtocolEtagError(id, "weak");
  }
  return stat.eTag;
}

/** 调用方传入的 If-Match：空串或无强 ETag 时不发请求。 */
function requireStrongCallerETag(id: string, eTag: string): void {
  if (eTag.trim().length === 0) {
    throw new WebDavSharedProtocolEtagError(id, "caller-missing");
  }
  if (isWeakETag(eTag)) {
    throw new WebDavSharedProtocolEtagError(id, "caller-weak");
  }
}

/** 创建／更新前按实际 UTF-8 字节校验 1 MiB 上限。 */
function encodeContent(id: string, content: string): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_SHARED_PROTOCOL_BYTES) {
    throw new WebDavSharedProtocolTooLargeError(id, bytes.byteLength);
  }
  return bytes;
}

/** 控制对象按 UTF-8 读取；非法字节由 TextDecoder 的替换字符兜底。 */
function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** 404 是「不存在」；其余失败继续上抛。 */
function isNotFoundError(error: unknown): boolean {
  return error instanceof RemoteError
    && (error.type === RemoteErrorType.NotFound || error.statusCode === 404);
}
