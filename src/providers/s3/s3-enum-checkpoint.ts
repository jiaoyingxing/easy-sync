/**
 * LIST 续点（continuation token）持久化：fail-open 的非权威缓存。
 *
 * 规则（设计 §5.3）：
 * - 每轮 LIST 有页数预算；超预算时写入 `{prefix, continuationToken, startedAt,
 *   pages}`，本轮 `complete=false`、**零删除**，下一轮从 token 继续；
 * - 同页重复 key 去重（last-wins）；跨页重复视为列举异常，`complete=false`、
 *   零删除；
 * - token 被服务端拒绝（`InvalidArgument`）或缓存损坏 ⇒ 从头重列，仍零删除；
 * - 只有走到 `IsTruncated=false` 的那一轮才允许 `complete=true`。
 *
 * 本模块不写文件：调用方注入存储端口（S2 使用 `runtime/cache/s3-enum.json`）。
 * 缓存损坏不是同步权威，不得因为读失败就产生删除。
 */
import { OneDriveErrorType } from "../../onedrive/types";
import { S3Error } from "./s3-errors";

export interface S3ListedObject {
  readonly key: string;
  readonly size: number;
  readonly eTag: string | null;
  readonly lastModified: string | null;
}

export interface S3ListPage {
  readonly objects: readonly S3ListedObject[];
  readonly isTruncated: boolean;
  readonly nextContinuationToken?: string;
}

/** 续点存储端口；实现方负责原子写与路径。 */
export interface S3EnumCheckpointStore {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
  clear(): Promise<void>;
}

export interface S3EnumCheckpointV1 {
  readonly schemaVersion: 1;
  readonly providerKind: "s3";
  readonly scopeId: string;
  readonly prefix: string;
  readonly continuationToken: string;
  readonly startedAt: string;
  readonly pages: number;
}

export type S3EnumRestartReason = "none" | "corrupt" | "token-rejected";

export interface S3EnumerationOptions {
  readonly scopeId: string;
  readonly prefix: string;
  readonly pageBudget: number;
  readonly listPage: (continuationToken: string | undefined) => Promise<S3ListPage>;
  readonly store?: S3EnumCheckpointStore;
  readonly now?: () => Date;
}

export interface S3EnumerationResult {
  readonly objects: readonly S3ListedObject[];
  /** 只有完整走到 `IsTruncated=false` 才为 true。 */
  readonly complete: boolean;
  /** 删除是否允许；与 `complete` 同值，单独命名让调用点无法忽略。 */
  readonly deletionPermitted: boolean;
  readonly pages: number;
  readonly resumed: boolean;
  readonly restartReason: S3EnumRestartReason;
  readonly crossPageDuplicate: boolean;
  readonly checkpointWritten: boolean;
}

/** 续点损坏、scope／prefix 不匹配或 token 为空 ⇒ 视为没有续点。 */
export function parseS3EnumCheckpoint(
  raw: string | null,
  expected: { scopeId: string; prefix: string },
): S3EnumCheckpointV1 | null {
  if (raw === null || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.providerKind !== "s3") return null;
  if (record.scopeId !== expected.scopeId || record.prefix !== expected.prefix) return null;
  if (typeof record.continuationToken !== "string" || record.continuationToken.length === 0) return null;
  if (typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) return null;
  if (typeof record.pages !== "number" || !Number.isInteger(record.pages) || record.pages <= 0) return null;
  return {
    schemaVersion: 1,
    providerKind: "s3",
    scopeId: record.scopeId,
    prefix: record.prefix,
    continuationToken: record.continuationToken,
    startedAt: record.startedAt,
    pages: record.pages,
  };
}

export function serializeS3EnumCheckpoint(checkpoint: S3EnumCheckpointV1): string {
  return JSON.stringify({
    schemaVersion: checkpoint.schemaVersion,
    providerKind: checkpoint.providerKind,
    scopeId: checkpoint.scopeId,
    prefix: checkpoint.prefix,
    continuationToken: checkpoint.continuationToken,
    startedAt: checkpoint.startedAt,
    pages: checkpoint.pages,
  });
}

function isInvalidTokenError(error: unknown): boolean {
  return error instanceof S3Error && (error.code === "InvalidArgument" || error.status === 400);
}

/**
 * 驱动一轮完整列举。调用方的 `listPage(undefined)` 必须从第一页开始。
 *
 * 注意：续点只保存 token（设计 §5.3 的固定载荷），不保存已经列出的对象；
 * 上一轮返回的对象由调用方负责并入索引。续点轮次的结果只包含从 token 之后
 * 的页，不能单独当作完整索引使用。
 *
 * 任何异常路径都返回 `complete=false` 并保留已有对象快照；删除由上层按
 * `deletionPermitted` 决定，不能把「没列全」当「远端删了」。
 */
export async function runS3Enumeration(
  options: S3EnumerationOptions,
): Promise<S3EnumerationResult> {
  if (!Number.isInteger(options.pageBudget) || options.pageBudget <= 0) {
    throw new S3Error({
      type: OneDriveErrorType.Unknown,
      code: "InvalidPageBudget",
      status: 0,
      retry: "none",
      message: `S3 enumeration page budget must be a positive integer, got ${options.pageBudget}`,
    });
  }
  const now = options.now ?? (() => new Date());
  let continuationToken: string | undefined;
  let resumed = false;
  let restartReason: S3EnumRestartReason = "none";
  let checkpointWritten = false;
  let restoredStartedAt: string | null = null;
  let restoredPages = 0;

  if (options.store) {
    let raw: string | null = null;
    try {
      raw = await options.store.read();
    } catch {
      restartReason = "corrupt";
    }
    if (raw !== null && raw !== undefined) {
      const checkpoint = parseS3EnumCheckpoint(raw, {
        scopeId: options.scopeId,
        prefix: options.prefix,
      });
      if (checkpoint) {
        continuationToken = checkpoint.continuationToken;
        resumed = true;
        restoredStartedAt = checkpoint.startedAt;
        restoredPages = checkpoint.pages;
      } else {
        restartReason = "corrupt";
        await clearStore(options.store);
      }
    }
  }

  const objects = new Map<string, S3ListedObject>();
  let seenKeys = new Set<string>();
  let pages = 0;
  let crossPageDuplicate = false;
  let restartedAfterTokenRejection = false;
  let complete = false;

  const resetToHead = (): void => {
    continuationToken = undefined;
    resumed = false;
    objects.clear();
    seenKeys = new Set<string>();
    pages = 0;
    crossPageDuplicate = false;
    restoredStartedAt = null;
    restoredPages = 0;
  };

  for (;;) {
    let page: S3ListPage;
    try {
      page = await options.listPage(continuationToken);
    } catch (error) {
      if (continuationToken !== undefined && !restartedAfterTokenRejection && isInvalidTokenError(error)) {
        restartedAfterTokenRejection = true;
        restartReason = "token-rejected";
        resetToHead();
        if (options.store) await clearStore(options.store);
        continue;
      }
      throw error;
    }
    pages += 1;
    const pageKeys = new Set<string>();
    for (const object of page.objects) {
      if (seenKeys.has(object.key)) crossPageDuplicate = true;
      pageKeys.add(object.key);
      objects.set(object.key, object);
    }
    for (const key of pageKeys) seenKeys.add(key);
    if (crossPageDuplicate) {
      // 列举本身不可信：不写续点、不产生删除；下一轮从头重列。
      if (options.store) await clearStore(options.store);
      break;
    }
    if (!page.isTruncated) {
      complete = true;
      if (options.store) await clearStore(options.store);
      break;
    }
    const nextToken = page.nextContinuationToken;
    if (!nextToken) {
      // Truncated 却没有 token：无法证明已列全，零删除。
      if (options.store) await clearStore(options.store);
      break;
    }
    const totalPages = restoredPages + pages;
    if (pages >= options.pageBudget) {
      if (options.store) {
        const checkpoint: S3EnumCheckpointV1 = {
          schemaVersion: 1,
          providerKind: "s3",
          scopeId: options.scopeId,
          prefix: options.prefix,
          continuationToken: nextToken,
          startedAt: restoredStartedAt ?? now().toISOString(),
          pages: totalPages,
        };
        try {
          await options.store.write(serializeS3EnumCheckpoint(checkpoint));
          checkpointWritten = true;
        } catch {
          checkpointWritten = false;
        }
      }
      break;
    }
    continuationToken = nextToken;
  }

  return {
    objects: [...objects.values()],
    complete,
    deletionPermitted: complete,
    pages,
    resumed,
    restartReason,
    crossPageDuplicate,
    checkpointWritten,
  };
}

async function clearStore(store: S3EnumCheckpointStore): Promise<void> {
  try {
    await store.clear();
  } catch {
    // 非权威缓存清理失败不改变本轮判定。
  }
}
