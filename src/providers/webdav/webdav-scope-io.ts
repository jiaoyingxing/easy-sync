/**
 * `WebDavClient` → `WebDavScopeRemoteIo` 适配器（W1.5）。
 *
 * S0 的 `ensureWebDavScopeMarker` 只做决策，不关心安全原语怎么实现；但
 * `putText(createOnly: true)` 在坚果云上会被忽略（`If-None-Match` 不生效，
 * 已有标记被覆盖）。本适配器把 IO 语义钉到安全客户端上：
 *
 * - 创建标记：走 `createFile` 的 staged-MOVE 安全新建，目标已存在→412，
 *   绝不覆盖；服务器连安全新建原语都没有时返回 428（本地 fail-closed）。
 * - 替换标记：必须带读取时的强 ETag 走 `If-Match`；没有 ETag 不发送请求，
 *   直接返回 428；服务器返回 412 即拒绝，保留远端旧标记。
 * - 读标记：返回强 ETag 供替换使用；弱 ETag 按 null 处理（RFC 7232 强比较）。
 * - 列表：透传 `complete`；调用方不得把截断列表当成完整事实。
 *
 * 本模块不改变 S0 的决策规则，也不接引擎。
 */
import { RemoteError } from "../../remote/errors";
import { normalizeWebDavPath } from "./webdav-probe";
import {
  WebDavClient,
  WebDavPreconditionFailedError,
  WebDavTargetExistsError,
  WebDavUnsafeCreateError,
  WebDavUnsafeUpdateError,
} from "./webdav-client";
import {
  WebDavScopeConfigError,
  type WebDavScopeListingEntry,
  type WebDavScopeRemoteIo,
  type WebDavScopeStatResult,
} from "./webdav-scope";

/** 本地安全前置失败（缺 ETag／缺安全原语）使用的合成状态：428 Precondition Required。 */
export const WEBDAV_SCOPE_UNSAFE_WRITE_STATUS = 428;

export interface WebDavClientScopeIoOptions {
  /** 标记文件的内容类型；默认 JSON。 */
  readonly contentType?: string;
}

export class WebDavClientScopeIo implements WebDavScopeRemoteIo {
  private readonly client: WebDavClient;
  private readonly contentType: string;

  constructor(client: WebDavClient, options: WebDavClientScopeIoOptions = {}) {
    this.client = client;
    this.contentType = options.contentType ?? "application/json; charset=utf-8";
  }

  async stat(path: string): Promise<WebDavScopeStatResult> {
    try {
      const stat = await this.client.stat(this.relativePath(path));
      if (!stat) return { status: 404, isCollection: false };
      return { status: 207, isCollection: stat.kind === "collection" };
    } catch (error) {
      return { status: remoteStatusOf(error), isCollection: false };
    }
  }

  mkcol(path: string): Promise<number> {
    return this.client.mkcol(this.relativePath(path));
  }

  async putText(
    path: string,
    text: string,
    options: { readonly createOnly: boolean; readonly ifMatch?: string | null },
  ): Promise<number> {
    const bytes = new TextEncoder().encode(text);
    if (options.createOnly) {
      try {
        await this.client.createFile(this.relativePath(path), bytes, {
          contentType: this.contentType,
        });
        return 201;
      } catch (error) {
        return writeStatusOf(error);
      }
    }
    const ifMatch = options.ifMatch?.trim() ?? "";
    if (ifMatch.length === 0) {
      // 没有旧 ETag 就不发请求：无条件 PUT 会把「覆盖」伪装成「替换」。
      return WEBDAV_SCOPE_UNSAFE_WRITE_STATUS;
    }
    try {
      await this.client.updateFile(this.relativePath(path), bytes, ifMatch, {
        contentType: this.contentType,
      });
      return 204;
    } catch (error) {
      return writeStatusOf(error);
    }
  }

  async getText(path: string): Promise<{
    status: number;
    text: string;
    eTag: string | null;
  }> {
    try {
      const read = await this.client.readFile(this.relativePath(path));
      return {
        status: 200,
        text: new TextDecoder("utf-8").decode(read.bytes),
        // 弱 ETag 不能用于 If-Match；按「没有可用 ETag」返回，替换即 fail-closed。
        eTag: read.stat.weakETag ? null : read.stat.eTag,
      };
    } catch (error) {
      return { status: remoteStatusOf(error), text: "", eTag: null };
    }
  }

  async list(path: string): Promise<{
    status: number;
    entries: readonly WebDavScopeListingEntry[];
    complete: boolean;
  }> {
    try {
      const listing = await this.client.list(this.relativePath(path));
      return {
        status: 207,
        entries: listing.map((entry) => ({
          path: entry.path,
          isCollection: entry.kind === "collection",
          size: entry.size ?? 0,
        })),
        complete: listing.complete,
      };
    } catch (error) {
      return {
        status: remoteStatusOf(error),
        entries: [],
        complete: false,
      };
    }
  }

  /**
   * S0 使用相对根集合的绝对远端路径（如 `/vault/.easy-sync/scope.json`），
   * `WebDavClient` 使用相对路径；越界路径直接拒绝，避免把标记写到根外。
   */
  private relativePath(absolutePath: string): string {
    const normalized = normalizeWebDavPath(absolutePath);
    const root = this.client.rootPath;
    if (normalized === root) return "";
    const prefix = root === "/" ? "/" : `${root}/`;
    if (!normalized.startsWith(prefix)) {
      throw new WebDavScopeConfigError(
        `WebDAV scope path "${absolutePath}" is outside the client root "${root}"`,
      );
    }
    return normalized.slice(prefix.length);
  }
}

function writeStatusOf(error: unknown): number {
  if (error instanceof WebDavTargetExistsError) return 412;
  if (error instanceof WebDavPreconditionFailedError) return 412;
  if (error instanceof WebDavUnsafeCreateError || error instanceof WebDavUnsafeUpdateError) {
    return WEBDAV_SCOPE_UNSAFE_WRITE_STATUS;
  }
  return remoteStatusOf(error);
}

function remoteStatusOf(error: unknown): number {
  if (error instanceof RemoteError && Number.isFinite(error.statusCode)) {
    return error.statusCode;
  }
  return 0;
}
