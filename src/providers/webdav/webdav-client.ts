/**
 * WebDAV 安全客户端（W1 收口／W2 基座）。
 *
 * 这层只回答「在这台服务器上，怎样把一次读写做成安全的最小动作」，不接
 * planner／executor，也不决定计划。设计依据：`S3与WebDAV V1切片设计`
 * §13.2（协议面与错误表）、§13.3（最小闭环）、§15.1–§15.3（条件请求与
 * fail-closed）。
 *
 * 关键取舍（2026-11-19 真实坚果云实测后）：
 * - `If-None-Match: *` 可能被服务器忽略（坚果云直接覆盖已有文件），所以
 *   新建文件在 `conditionalCreate=false` 时走「唯一临时名 PUT → MOVE
 *   Overwrite:F」；MOVE 拒绝覆盖（412 或 409）且目标字节未变才可信任。
 * - `If-Match` 在 PUT 上可用，在 DELETE 上可能被忽略（坚果云陈旧条件删除
 *   仍返回 204）。因此删除必须由调用方显式确认；没有条件删除能力时先在
 *   PROPFIND 复核 ETag，再做删除，并如实承认这不是原子条件删除。
 * - 元数据（ETag／长度）以 PROPFIND 为准：坚果云 HEAD 不回长度与 ETag。
 * - 根集合必须可写：坚果云 `/dav/` 本身不能直接放文件，必须选一个子文件夹。
 */
import type { ProviderCapabilities } from "../../sync/provider-capabilities";
import { hostPlatformFacts } from "../../obsidian-compat";
import {
  buildWebDavBasicAuthorization,
  buildWebDavUrl,
  decodeWebDavPathname,
  isWeakETag,
  joinWebDavPath,
  normalizeWebDavPath,
  parseWebDavMultiStatus,
  probeWebDavCapabilities,
  assertWebDavProbeSecurity,
  WEBDAV_MIN_TRANSFER_BYTES_PER_SECOND,
  WEBDAV_PROPFIND_BODY,
  type WebDavHttpResponse,
  type WebDavMultiStatusEntry,
  type WebDavPlatform,
  type WebDavProbeResult,
  type WebDavProtocolFacts,
  type WebDavTransport,
} from "./webdav-probe";
import {
  isWebDavCollectionExistsStatus,
  isWebDavMoveSuccessStatus,
  isWebDavSuccessStatus,
  webDavRemoteError,
} from "./webdav-errors";
import { RemoteError, RemoteErrorType } from "../../remote/errors";

/**
 * 服务器单次 PROPFIND 的条目上限。坚果云官方文档写明单次请求文件数
 * （含文件和文件夹）为 750，支持分页；官方口径没有说明是否把被列举集合
 * 自身算进去。本客户端不猜测未经验证的分页协议，按**全部响应条目（含集合
 * 自身）**达到 750 即视为可能截断（`complete=false`）；调用方不得据此推断删除。
 */
export const WEBDAV_LIST_ENTRY_LIMIT = 750;

/**
 * 单个目录列表最多跟随的页数。分页只在服务器明确给出 `Link: rel="next"`
 * 时发生；这个上限用于阻止异常服务器用无限 next 链拖住同步轮。
 * 100 页 ≈ 74,900 个直接子项，远高于单目录的可用规模。
 */
export const WEBDAV_LIST_MAX_PAGES = 100;

/** 客户端自有的临时目录；staged-MOVE 只在这里创建临时文件。 */
export const WEBDAV_TEMP_DIRECTORY = ".easy-sync/tmp";

/** staged-MOVE 临时文件名：`create-<base36 时间>-<hex>`。 */
export const WEBDAV_TEMP_FILE_PREFIX = "create-";

/** 临时文件的默认清理阈值（24 小时）；活跃写入不会停留这么久。 */
export const WEBDAV_TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const WEBDAV_TEMP_FILE_PATTERN = /^([0-9a-z]+)-([0-9a-f]+)$/;

export interface WebDavClientCredentials {
  readonly username: string;
  readonly password: string;
}

export interface WebDavClientOptions {
  /** 服务器 URL（必须 HTTPS）；可带集合路径，缺省作为根集合。 */
  readonly endpoint: string;
  /** 同步根集合的绝对路径；缺省取 endpoint 的 pathname。 */
  readonly rootPath?: string;
  readonly credentials: WebDavClientCredentials;
  readonly transport: WebDavTransport;
  readonly requestDeadlineMs?: number;
  /** 宿主平台；只决定静态 `maxSinglePutBytes` 能力位，缺省按宿主判断。 */
  readonly platform?: WebDavPlatform;
  /** 已知能力时跳过首次探针；未给时由 `probe()`／`initialize()` 填充。 */
  readonly capabilities?: Readonly<ProviderCapabilities>;
  readonly now?: () => Date;
}

export interface WebDavResourceStat {
  /** 服务器上解码后的绝对路径。 */
  readonly path: string;
  /** 相对同步根的路径；根自身为空串。 */
  readonly relativePath: string;
  readonly kind: "file" | "collection";
  readonly size: number | null;
  readonly eTag: string | null;
  /** 弱 ETag 不能用于 If-Match（RFC 7232 强比较）。 */
  readonly weakETag: boolean;
  readonly lastModified: string | null;
}

export interface WebDavWriteResult {
  readonly stat: WebDavResourceStat;
  /** 实际使用的安全策略；诊断需要知道这次是否走了临时名+MOVE。 */
  readonly strategy: "conditional-put" | "staged-move" | "conditional-update";
}

/**
 * 列表结果同时是条目数组，便于现有调用继续用 `length`／`map`；完整性必须
 * 显式读取 `complete`，不能把「返回了 N 条」当成「服务器只有 N 条」。
 */
export interface WebDavListResult extends Array<WebDavResourceStat> {
  /**
   * `true` 表示列表已经完整。单页响应按 750 保守判定；服务器用
   * `Link: rel="next"` 分页时，跟随到没有 next 的最后一页即为完整。
   * 无 next 且正文条目达到上限的单页响应仍视为可能截断（保持 W1.5 的
   * fail-closed 语义），除非本客户端已经亲眼见过该服务器分页。
   */
  readonly complete: boolean;
  /** multistatus 的全部 response 条目数（含每页的集合自身）。 */
  readonly responseEntryCount: number;
  readonly entryLimit: number;
  /** 实际发出的 PROPFIND 页数；1 表示没有分页。 */
  readonly pageCount: number;
}

export type WebDavPaginationFailure =
  | "invalid-next-link"
  | "next-link-outside-collection"
  | "pagination-cycle"
  | "pagination-page-limit"
  | "duplicate-entry-across-pages"
  | "conflicting-duplicate-entry";

/**
 * 分页响应不可安全使用：next 链接越出集合、循环、页数超限，或同一路径
 * 在两页给出冲突事实。调用方必须整轮失败，不能按部分列表推断远端删除。
 */
export class WebDavPaginationError extends Error {
  constructor(
    readonly path: string,
    readonly reason: WebDavPaginationFailure,
    detail = "",
  ) {
    super(
      `WebDAV pagination refused for ${path}: ${reason}${detail.length > 0 ? ` (${detail})` : ""}`,
    );
    this.name = "WebDavPaginationError";
  }
}

export interface WebDavTemporaryCleanupFailure {
  readonly path: string;
  /** 0 表示传输失败或本地安全前置失败。 */
  readonly status: number;
}

/** `.easy-sync/tmp` 的过期临时文件清理结果；只包含控制面条目。 */
export interface WebDavTemporaryCleanupResult {
  readonly directory: string;
  readonly directoryPresent: boolean;
  /** 本次列表是否完整；截断只缩小清理范围，不影响用户路径。 */
  readonly listingComplete: boolean;
  /** 检查过的直接子文件数（不含集合、非本客户端命名的文件）。 */
  readonly scanned: number;
  readonly deleted: readonly string[];
  readonly failures: readonly WebDavTemporaryCleanupFailure[];
}

/** 目标已存在；新建／改名不会覆盖目标。 */
export class WebDavTargetExistsError extends Error {
  constructor(readonly path: string) {
    super(`WebDAV target already exists: ${path}`);
    this.name = "WebDavTargetExistsError";
  }
}

/** 条件删除前置失败；调用方应复核远端事实。 */
export class WebDavPreconditionFailedError extends Error {
  constructor(readonly path: string, message = "WebDAV precondition failed") {
    super(message);
    this.name = "WebDavPreconditionFailedError";
  }
}

/** 服务器没有可安全新建文件的原语（条件创建与 MOVE 都不可用）。 */
export class WebDavUnsafeCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavUnsafeCreateError";
  }
}

/** 服务器没有可安全更新文件的条件写入能力。 */
export class WebDavUnsafeUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavUnsafeUpdateError";
  }
}

/** 删除没有显式确认，或没有可接受的条件证据；调用方不得静默绕过。 */
export class WebDavUnsafeDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavUnsafeDeleteError";
  }
}

/** 写入后回读的长度与本次写入不一致。 */
export class WebDavReadbackMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly expectedBytes: number,
    readonly actualBytes: number | null,
  ) {
    super(
      `WebDAV readback mismatch for ${path}: expected ${expectedBytes} bytes, got ${actualBytes ?? "unknown"}`,
    );
    this.name = "WebDavReadbackMismatchError";
  }
}

/** 根集合本身不能直接承载文件（例如坚果云 `/dav/`），必须选子文件夹。 */
export class WebDavRootNotWritableError extends Error {
  constructor(readonly rootPath: string, readonly status: number) {
    super(
      `WebDAV root "${rootPath}" is not writable as a file collection (HTTP ${status}); choose a subfolder as the sync root`,
    );
    this.name = "WebDavRootNotWritableError";
  }
}

/** 根集合不存在且不能只建最后一级。 */
export class WebDavRootMissingError extends Error {
  constructor(readonly rootPath: string) {
    super(`WebDAV root collection does not exist: ${rootPath}`);
    this.name = "WebDavRootMissingError";
  }
}

export class WebDavClient {
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly rootPath: string;
  private readonly credentials: WebDavClientCredentials;
  private readonly authorization: string;
  private readonly transport: WebDavTransport;
  private readonly deadlineMs: number;
  private readonly platform: WebDavPlatform;
  private readonly now: () => Date;
  private cachedCapabilities: Readonly<ProviderCapabilities> | null;
  private protocolFacts: Readonly<WebDavProtocolFacts> | null = null;
  /** 是否亲眼见过该服务器返回 `Link: rel="next"`。 */
  private paginationObserved = false;
  private requestTotal = 0;
  private readonly requestByMethod = new Map<string, number>();
  /** Per-round baselines for the diagnostic phase summary. */
  private roundRequestStart = 0;
  private roundRequestByMethodStart = new Map<string, number>();
  private roundListCalls = 0;
  private roundMaxListPages = 0;
  /**
   * The staged-MOVE temp collections are control-plane state this client
   * created. Ensure them once per session instead of two MKCOLs before every
   * write: a first join does dozens of staged creates (protocol objects,
   * identity ledger, every uploaded file), and Nutstore's 600-request window
   * must not be spent re-proving directories that already exist. A PUT that
   * reports a missing parent clears the flag and recreates them once.
   */
  private stagedMoveDirectoriesReady = false;

  constructor(options: WebDavClientOptions) {
    const endpointUrl = assertWebDavProbeSecurity(options.endpoint, options.credentials);
    this.endpoint = options.endpoint;
    this.baseUrl = endpointUrl.origin;
    const endpointPath = decodeWebDavPathname(endpointUrl.pathname);
    this.rootPath = normalizeWebDavPath(options.rootPath ?? endpointPath);
    this.credentials = { ...options.credentials };
    this.authorization = buildWebDavBasicAuthorization(
      options.credentials.username,
      options.credentials.password,
    );
    this.transport = async (request) => {
      this.requestTotal += 1;
      this.requestByMethod.set(request.method, (this.requestByMethod.get(request.method) ?? 0) + 1);
      return await options.transport(request);
    };
    this.deadlineMs = Number.isFinite(options.requestDeadlineMs) && (options.requestDeadlineMs ?? 0) > 0
      ? (options.requestDeadlineMs as number)
      : 30_000;
    this.platform = options.platform
      ?? (hostPlatformFacts.isMobileApp ? "mobile" : "desktop");
    this.now = options.now ?? (() => new Date());
    this.cachedCapabilities = options.capabilities ?? null;
  }

  get capabilities(): Readonly<ProviderCapabilities> | null {
    return this.cachedCapabilities;
  }

  get protocol(): Readonly<WebDavProtocolFacts> | null {
    return this.protocolFacts;
  }

  /** 本客户端实例累计发出的 HTTP 请求数（含探针与失败尝试）。 */
  get requestCount(): number {
    return this.requestTotal;
  }

  /** 按方法累计的请求数；用于 WebDAV 请求预算与诊断读数。 */
  get requestCountsByMethod(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.requestByMethod);
  }

  /** 一轮开始的读数基线；执行器每轮入口调用一次。 */
  beginRoundStats(): void {
    this.roundRequestStart = this.requestTotal;
    this.roundRequestByMethodStart = new Map(this.requestByMethod);
    this.roundListCalls = 0;
    this.roundMaxListPages = 0;
  }

  /** 本轮请求数与列表次数；只作诊断，不参与计划或重试判断。 */
  roundStats(): {
    requests: { total: number; byMethod: Record<string, number> };
    listings: { calls: number; maxPages: number };
  } {
    const byMethod: Record<string, number> = {};
    for (const [method, count] of this.requestByMethod) {
      const delta = count - (this.roundRequestByMethodStart.get(method) ?? 0);
      if (delta > 0) byMethod[method] = delta;
    }
    return {
      requests: {
        total: Math.max(0, this.requestTotal - this.roundRequestStart),
        byMethod,
      },
      listings: {
        calls: this.roundListCalls,
        maxPages: this.roundMaxListPages,
      },
    };
  }

  /**
   * 首次使用前的完整初始化：根集合存在→根可写→能力探针。
   * 根可写检查会写一个唯一的点文件并立即删除；根不可写时拒绝继续。
   */
  async initialize(): Promise<WebDavProbeResult> {
    await this.ensureRootCollection();
    await this.ensureRootWritable();
    return await this.probe();
  }

  /** 运行能力探针；结果同时写入 `capabilities` 与 `protocol`。 */
  async probe(): Promise<WebDavProbeResult> {
    const result = await probeWebDavCapabilities({
      endpoint: this.endpoint,
      rootPath: this.rootPath,
      credentials: this.credentials,
      transport: this.transport,
      requestDeadlineMs: this.deadlineMs,
      platform: this.platform,
      now: this.now,
    });
    this.cachedCapabilities = result.capabilities;
    this.protocolFacts = result.protocolFacts;
    return result;
  }

  /** 根集合必须存在；不存在时只允许创建最后一级（父级缺失即失败）。 */
  async ensureRootCollection(): Promise<WebDavResourceStat> {
    const current = await this.stat("");
    if (current) {
      if (current.kind !== "collection") {
        throw new WebDavRootMissingError(this.rootPath);
      }
      return current;
    }
    if (this.rootPath === "/") {
      throw new WebDavRootMissingError(this.rootPath);
    }
    const mkcol = await this.send("MKCOL", this.rootPath);
    if (!isWebDavCollectionExistsStatus(mkcol.status)) {
      this.throwFor(mkcol);
    }
    const created = await this.stat("");
    if (!created || created.kind !== "collection") {
      throw new WebDavRootMissingError(this.rootPath);
    }
    return created;
  }

  /**
   * 根集合必须能直接承载文件。坚果云的 `/dav/` 只能建子文件夹、不能直接
   * PUT 文件；这类根必须被拒绝，而不是等到第一次上传才逐个 404。
   */
  async ensureRootWritable(): Promise<void> {
    const probePath = this.resolve(`.easysync-root-probe-${randomSuffix()}`);
    const response = await this.send("PUT", probePath, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: toArrayBuffer("easysync-root-probe"),
    });
    if (response.status === 404 || response.status === 403) {
      throw new WebDavRootNotWritableError(this.rootPath, response.status);
    }
    if (!isWebDavSuccessStatus(response.status)) {
      this.throwFor(response);
    }
    const cleanup = await this.send("DELETE", probePath);
    if (!isWebDavSuccessStatus(cleanup.status) && cleanup.status !== 404) {
      this.throwFor(cleanup);
    }
  }

  /** PROPFIND Depth 0；不存在返回 null。 */
  async stat(relativePath = ""): Promise<WebDavResourceStat | null> {
    const absolute = this.resolve(relativePath);
    const result = await this.propfind(absolute, "0");
    if (result.response.status === 404) return null;
    if (result.response.status !== 207) {
      this.throwFor(result.response);
    }
    const self = result.entries.find((entry) => entry.path === absolute) ?? result.entries[0];
    if (!self || self.status === 404) return null;
    return this.toStat(self);
  }

  /**
   * PROPFIND Depth 1；只返回根以下的直接子项（不递归）。
   *
   * 坚果云一类服务器在单次响应超过 750 条时用 `Link: …; rel="next"` 分页。
   * 客户端逐页跟随，但只接受同 origin、同一集合路径的 next 链接；跨集合、
   * 循环、页数超限、同路径事实冲突都整轮失败（`WebDavPaginationError`），
   * 不把部分列表交给调用方推断删除。
   *
   * `complete` 的口径：服务器从未展示过分页时，单页仍按 750 保守判定；
   * 跟随过 next（或本客户端此前见过该服务器分页）后，没有 next 就是服务器
   * 明确表示列表结束。
   */
  async list(relativePath = ""): Promise<WebDavListResult> {
    const absolute = this.resolve(relativePath);
    let pageUrl = buildWebDavUrl(this.baseUrl, absolute);
    const visited = new Set<string>();
    const out: WebDavResourceStat[] = [];
    const seenAtPage = new Map<string, { page: number; stat: WebDavResourceStat }>();
    let pageCount = 0;
    let responseEntryCount = 0;
    let lastPageEntryCount = 0;

    for (;;) {
      if (pageCount >= WEBDAV_LIST_MAX_PAGES) {
        throw new WebDavPaginationError(
          absolute,
          "pagination-page-limit",
          `more than ${WEBDAV_LIST_MAX_PAGES} pages`,
        );
      }
      if (visited.has(pageUrl)) {
        throw new WebDavPaginationError(absolute, "pagination-cycle", pageUrl);
      }
      visited.add(pageUrl);

      const result = await this.propfindAt(pageUrl, "1");
      if (result.response.status === 404) {
        this.throwFor(result.response);
      }
      if (result.response.status !== 207) {
        this.throwFor(result.response);
      }
      pageCount += 1;
      lastPageEntryCount = result.entries.length;
      responseEntryCount += result.entries.length;

      for (const entry of result.entries) {
        if (entry.path === absolute) continue;
        if (entry.status !== 0 && !isWebDavSuccessStatus(entry.status)) continue;
        // Depth 1 只接受被列举集合的直接子项；越界或嵌套条目不能混进这一层。
        const childPrefix = absolute === "/" ? "/" : `${absolute}/`;
        if (!entry.path.startsWith(childPrefix)) continue;
        const childName = entry.path.slice(childPrefix.length);
        if (childName.length === 0 || childName.includes("/")) continue;
        if (this.relativeOf(entry.path) === null) continue;
        const stat = this.toStat(entry);
        const prior = seenAtPage.get(stat.path);
        if (prior !== undefined && prior.page !== pageCount) {
          // 正常分页不会把同一个子项放进两页；跨页重复只能是服务器异常。
          // 同一页内重复保持旧行为，由控制对象／计划层各自的判重逻辑处理。
          throw new WebDavPaginationError(
            absolute,
            sameWebDavStat(prior.stat, stat)
              ? "duplicate-entry-across-pages"
              : "conflicting-duplicate-entry",
            stat.path,
          );
        }
        seenAtPage.set(stat.path, { page: pageCount, stat });
        out.push(stat);
      }

      const nextTargets = nextLinkTargets(webDavHeaderValue(result.response.headers, "link"));
      if (nextTargets.length === 0) break;
      if (new Set(nextTargets).size > 1) {
        throw new WebDavPaginationError(
          absolute,
          "invalid-next-link",
          "multiple different next links",
        );
      }
      pageUrl = this.resolveNextPageUrl(pageUrl, nextTargets[0], absolute);
      this.paginationObserved = true;
    }

    const complete = pageCount > 1 || this.paginationObserved
      ? true
      : lastPageEntryCount < WEBDAV_LIST_ENTRY_LIMIT;
    this.roundListCalls += 1;
    this.roundMaxListPages = Math.max(this.roundMaxListPages, pageCount);
    return Object.assign(out, {
      complete,
      responseEntryCount,
      entryLimit: WEBDAV_LIST_ENTRY_LIMIT,
      pageCount,
    });
  }

  /**
   * 读取文件内容；长度以 PROPFIND 为准并与 GET 字节数核对。
   *
   * `options.stat` lets a caller that just read the same path reuse that
   * stat instead of paying a second PROPFIND. Control-plane readers (protocol
   * slots, identity ledger) already stat before deciding to read, and a first
   * join reads them several times inside Nutstore's 600-request window.
   */
  async readFile(
    relativePath: string,
    options: { readonly stat?: WebDavResourceStat } = {},
  ): Promise<{ bytes: Uint8Array; stat: WebDavResourceStat }> {
    const absolute = this.resolve(relativePath);
    const stat = options.stat ?? await this.stat(relativePath);
    if (!stat) {
      throw webDavRemoteError({ status: 404, now: this.now() });
    }
    if (stat.kind !== "file") {
      throw webDavRemoteError({ status: 405, now: this.now() });
    }
    const response = await this.send("GET", absolute, {
      deadlineMs: this.transferDeadlineMs(stat.size ?? 0),
    });
    if (response.status === 404) {
      throw webDavRemoteError({ status: 404, headers: response.headers, now: this.now() });
    }
    if (!isWebDavSuccessStatus(response.status)) {
      this.throwFor(response);
    }
    const bytes = new Uint8Array(response.body);
    if (stat.size !== null && bytes.byteLength !== stat.size) {
      throw new WebDavReadbackMismatchError(absolute, stat.size, bytes.byteLength);
    }
    return { bytes, stat };
  }

  /**
   * 安全新建文件。
   *
   * - 条件创建可用：直接 `If-None-Match: *`，目标已存在时 412/409；
   * - 否则必须同时具备服务端 MOVE 与「拒绝覆盖」证据：唯一临时名 PUT，
   *   再 MOVE 到目标；MOVE 的 412/409 表示目标已存在，临时文件保留可清理；
   * - 两者都没有：抛 `WebDavUnsafeCreateError`，绝不退回无条件 PUT。
   */
  async createFile(
    relativePath: string,
    bytes: Uint8Array,
    options: { readonly contentType?: string } = {},
  ): Promise<WebDavWriteResult> {
    const absolute = this.resolve(relativePath);
    const capabilities = await this.requireCapabilities();
    if (capabilities.conditionalCreate) {
      const response = await this.send("PUT", absolute, {
        headers: {
          "If-None-Match": "*",
          "Content-Type": options.contentType ?? "application/octet-stream",
        },
        body: toBuffer(bytes),
        deadlineMs: this.transferDeadlineMs(bytes.byteLength),
      });
      if (response.status === 412 || response.status === 409) {
        throw new WebDavTargetExistsError(absolute);
      }
      if (!isWebDavSuccessStatus(response.status)) {
        this.throwFor(response);
      }
      return { stat: await this.readback(relativePath, bytes), strategy: "conditional-put" };
    }
    if (capabilities.serverSideMove) {
      return { stat: await this.createViaMove(absolute, bytes, options), strategy: "staged-move" };
    }
    throw new WebDavUnsafeCreateError(
      "WebDAV server supports neither conditional create nor a verified non-overwriting MOVE; refusing to create files",
    );
  }

  /**
   * 条件更新：必须同时有 `conditionalUpdate` 能力和本次读到的 ETag。
   * 没有 If-Match 证据时拒绝写入，避免把「覆盖」伪装成「更新」。
   */
  async updateFile(
    relativePath: string,
    bytes: Uint8Array,
    ifMatch: string,
    options: { readonly contentType?: string } = {},
  ): Promise<WebDavWriteResult> {
    const capabilities = await this.requireCapabilities();
    if (!capabilities.conditionalUpdate) {
      throw new WebDavUnsafeUpdateError(
        "WebDAV server does not honor If-Match; refusing an unconditional overwrite",
      );
    }
    if (ifMatch.trim().length === 0) {
      throw new WebDavUnsafeUpdateError("WebDAV update requires a non-empty If-Match ETag");
    }
    const absolute = this.resolve(relativePath);
    const response = await this.send("PUT", absolute, {
      headers: {
        "If-Match": ifMatch,
        "Content-Type": options.contentType ?? "application/octet-stream",
      },
      body: toBuffer(bytes),
      deadlineMs: this.transferDeadlineMs(bytes.byteLength),
    });
    if (response.status === 412 || response.status === 409) {
      throw new WebDavPreconditionFailedError(absolute);
    }
    if (!isWebDavSuccessStatus(response.status)) {
      this.throwFor(response);
    }
    return { stat: await this.readback(relativePath, bytes), strategy: "conditional-update" };
  }

  /**
   * 删除文件。`confirmed` 必须是调用方明确的人工确认；本层不把「有 ETag」
   * 当成原子条件删除的证据。
   *
   * - 有条件删除能力：必须带 If-Match，412 立即失败；
   * - 无该能力：先 PROPFIND 复核 ETag，再发无条件 DELETE；这是设计允许的
   *   降级路径，但仍是 check-then-delete，调用方必须已获得用户确认。
   */
  async deleteFile(
    relativePath: string,
    options: { readonly ifMatch?: string | null; readonly confirmed: boolean },
  ): Promise<void> {
    if (options.confirmed !== true) {
      throw new WebDavUnsafeDeleteError(
        "WebDAV deletion requires explicit user confirmation; refusing an implicit delete",
      );
    }
    const capabilities = await this.requireCapabilities();
    const absolute = this.resolve(relativePath);
    const headers: Record<string, string> = {};
    if (capabilities.conditionalDelete) {
      if (!options.ifMatch) {
        throw new WebDavUnsafeDeleteError(
          "WebDAV server supports conditional delete; a reviewed If-Match ETag is required",
        );
      }
      headers["If-Match"] = options.ifMatch;
    } else if (options.ifMatch) {
      const current = await this.stat(relativePath);
      if (!current) return;
      if (current.eTag !== options.ifMatch) {
        throw new WebDavPreconditionFailedError(absolute, "WebDAV ETag changed before delete");
      }
    }
    const response = await this.send("DELETE", absolute, { headers });
    if (response.status === 404) return;
    if (response.status === 412 || response.status === 409) {
      throw new WebDavPreconditionFailedError(absolute);
    }
    if (!isWebDavSuccessStatus(response.status)) {
      this.throwFor(response);
    }
  }

  /**
   * 服务端改名／移动；目标已存在时 412 或 409 均不覆盖。
   *
   * `ifMatch` 是调用方已复核的源 ETag：作为 `If-Match` 发出（服务器若忽略，
   * 调用方仍须自己做移动前复核与移动后回读）。412／409 先回查目标：目标存在
   * 按「拒绝覆盖」分类，目标不存在则按源条件失败分类——两者都是 fail-closed。
   */
  async moveFile(
    fromRelativePath: string,
    toRelativePath: string,
    options: { readonly ifMatch?: string | null } = {},
  ): Promise<WebDavResourceStat> {
    const capabilities = await this.requireCapabilities();
    if (!capabilities.serverSideMove) {
      throw new Error("WebDAV server does not support verified server-side move");
    }
    const from = this.resolve(fromRelativePath);
    const to = this.resolve(toRelativePath);
    const headers: Record<string, string> = {
      Destination: buildWebDavUrl(this.baseUrl, to),
      Overwrite: "F",
    };
    const ifMatch = options.ifMatch?.trim() ?? "";
    if (ifMatch.length > 0) headers["If-Match"] = ifMatch;
    const response = await this.send("MOVE", from, { headers });
    if (response.status === 412 || response.status === 409) {
      const currentTarget = await this.stat(toRelativePath);
      if (currentTarget) throw new WebDavTargetExistsError(to);
      if (response.status === 409) {
        // 目标不存在而 MOVE 返回 409：常见于目标父集合缺失或服务器拒绝该
        // 移动；不是源条件失败，按中性冲突交给调用方复核。
        throw new RemoteError(
          RemoteErrorType.Conflict,
          `WebDAV move conflict (destination parent missing or server rejected): ${to}`,
          409,
          null,
          "webdav-move-conflict",
        );
      }
      throw new WebDavPreconditionFailedError(
        from,
        "WebDAV move source precondition failed",
      );
    }
    if (!isWebDavMoveSuccessStatus(response.status)) {
      this.throwFor(response);
    }
    const stat = await this.stat(toRelativePath);
    if (!stat) {
      throw new WebDavReadbackMismatchError(to, 1, null);
    }
    return stat;
  }

  /** 创建集合；已存在（405 或 201）按成功处理，父级缺失按 Conflict 失败。 */
  async ensureCollection(relativePath: string): Promise<void> {
    const absolute = this.resolve(relativePath);
    const response = await this.send("MKCOL", absolute);
    if (isWebDavCollectionExistsStatus(response.status)) return;
    this.throwFor(response);
  }

  /** Staged-MOVE 的临时集合：同一会话只确认一次，缺失时按 404/409 自愈。 */
  private async ensureStagedMoveDirectories(): Promise<void> {
    if (this.stagedMoveDirectoriesReady) return;
    await this.ensureCollection(".easy-sync");
    await this.ensureCollection(".easy-sync/tmp");
    this.stagedMoveDirectoriesReady = true;
  }

  /**
   * 直接发 MKCOL 并返回原始状态码（0 表示传输失败）。
   * scope 标记初始化需要区分 201／405／403 来选择标准或回退形态。
   */
  async mkcol(relativePath: string): Promise<number> {
    const response = await this.send("MKCOL", this.resolve(relativePath));
    return response.status;
  }

  /**
   * 删除空集合；任何子项都会拒绝（不递归删除）。
   *
   * 用户数据删除应带 `ifMatch`：服务器支持条件删除时以 `If-Match` 发出；
   * 不支持时先复核集合 ETag 再 DELETE（check-then-delete，设计允许的降级）。
   * 省略 `ifMatch` 只用于控制面／测试清理；调用方必须已明确确认。
   * 顶层集合可能被服务器禁止删除（坚果云的「sandbox」），此时如实抛错。
   */
  async deleteEmptyCollection(
    relativePath: string,
    options: { readonly confirmed: boolean; readonly ifMatch?: string | null },
  ): Promise<void> {
    if (options.confirmed !== true) {
      throw new WebDavUnsafeDeleteError(
        "WebDAV collection deletion requires explicit user confirmation",
      );
    }
    const children = await this.list(relativePath);
    if (!children.complete) {
      throw new WebDavUnsafeDeleteError(
        `WebDAV listing for ${relativePath} reached the ${children.entryLimit}-entry server limit and may be truncated; refusing to treat it as an empty collection`,
      );
    }
    if (children.length > 0) {
      throw new WebDavUnsafeDeleteError(
        `WebDAV collection is not empty: ${relativePath}`,
      );
    }
    const capabilities = await this.requireCapabilities();
    const headers: Record<string, string> = {};
    const ifMatch = options.ifMatch?.trim() ?? "";
    if (capabilities.conditionalDelete) {
      if (ifMatch.length > 0) headers["If-Match"] = ifMatch;
    } else if (ifMatch.length > 0) {
      const current = await this.stat(relativePath);
      if (!current) return;
      if (current.eTag !== ifMatch) {
        throw new WebDavPreconditionFailedError(
          this.resolve(relativePath),
          "WebDAV collection ETag changed before delete",
        );
      }
    }
    const response = await this.send("DELETE", this.resolve(relativePath), {
      headers,
    });
    if (response.status === 404) return;
    if (response.status === 412 || response.status === 409) {
      throw new WebDavPreconditionFailedError(this.resolve(relativePath));
    }
    if (!isWebDavSuccessStatus(response.status)) {
      this.throwFor(response);
    }
  }

  /**
   * 清理 `.easy-sync/tmp` 下由本客户端命名且已过期的 staged-MOVE 临时文件。
   *
   * 边界：只检查 `.easy-sync/tmp` 的直接子文件；只接受
   * `create-<base36 时间>-<hex>`；名字里的时间或 `getlastmodified` 任一超过
   * 阈值才删除。集合、其他名字的文件、临时目录之外的路径一律不碰。目录不存在
   * （或不是集合）时 no-op。
   */
  async cleanupStaleTemporaryFiles(
    options: { readonly olderThanMs?: number } = {},
  ): Promise<WebDavTemporaryCleanupResult> {
    const directory = WEBDAV_TEMP_DIRECTORY;
    const olderThanMs = Number.isFinite(options.olderThanMs) && (options.olderThanMs ?? 0) > 0
      ? (options.olderThanMs as number)
      : WEBDAV_TEMP_FILE_MAX_AGE_MS;
    const directoryStat = await this.stat(directory);
    if (!directoryStat || directoryStat.kind !== "collection") {
      return {
        directory,
        directoryPresent: directoryStat !== null,
        listingComplete: true,
        scanned: 0,
        deleted: [],
        failures: [],
      };
    }
    let listing: WebDavListResult;
    try {
      listing = await this.list(directory);
    } catch (error) {
      if (error instanceof RemoteError && error.statusCode === 404) {
        return {
          directory,
          directoryPresent: true,
          listingComplete: true,
          scanned: 0,
          deleted: [],
          failures: [],
        };
      }
      throw error;
    }
    const now = this.now().getTime();
    const prefix = `${directory}/`;
    const deleted: string[] = [];
    const failures: WebDavTemporaryCleanupFailure[] = [];
    let scanned = 0;
    for (const entry of listing) {
      if (entry.kind !== "file") continue;
      if (!entry.relativePath.startsWith(prefix)) continue;
      const name = entry.relativePath.slice(prefix.length);
      if (name.length === 0 || name.includes("/")) continue;
      if (!name.startsWith(WEBDAV_TEMP_FILE_PREFIX)) continue;
      const match = WEBDAV_TEMP_FILE_PATTERN.exec(name.slice(WEBDAV_TEMP_FILE_PREFIX.length));
      if (!match) continue;
      scanned += 1;
      const nameCreatedAt = Number.parseInt(match[1], 36);
      const lastModified = entry.lastModified === null ? Number.NaN : Date.parse(entry.lastModified);
      const staleByName = Number.isFinite(nameCreatedAt) && now - nameCreatedAt >= olderThanMs;
      const staleByMtime = Number.isFinite(lastModified) && now - lastModified >= olderThanMs;
      if (!staleByName && !staleByMtime) continue;
      try {
        await this.deleteFile(entry.relativePath, { confirmed: true, ifMatch: entry.eTag });
        deleted.push(entry.relativePath);
      } catch (error) {
        failures.push({ path: entry.relativePath, status: remoteStatusOf(error) });
      }
    }
    return {
      directory,
      directoryPresent: true,
      listingComplete: listing.complete,
      scanned,
      deleted,
      failures,
    };
  }

  private async createViaMove(
    absolute: string,
    bytes: Uint8Array,
    options: { readonly contentType?: string },
  ): Promise<WebDavResourceStat> {
    await this.ensureStagedMoveDirectories();
    const temp = this.resolve(`.easy-sync/tmp/create-${randomSuffix()}`);
    const putTemp = () => this.send("PUT", temp, {
      headers: { "Content-Type": options.contentType ?? "application/octet-stream" },
      body: toBuffer(bytes),
      deadlineMs: this.transferDeadlineMs(bytes.byteLength),
    });
    let put = await putTemp();
    if (put.status === 404 || put.status === 409) {
      // The temp collections were removed out-of-band (another client cleaned
      // `.easy-sync/tmp`, or the control directory was reset). Recreate once
      // and retry; a second failure is a real conflict.
      this.stagedMoveDirectoriesReady = false;
      await this.ensureStagedMoveDirectories();
      put = await putTemp();
    }
    if (!isWebDavSuccessStatus(put.status)) {
      this.throwFor(put);
    }
    try {
      const move = await this.send("MOVE", temp, {
        headers: {
          Destination: buildWebDavUrl(this.baseUrl, absolute),
          Overwrite: "F",
        },
      });
      if (move.status === 412 || move.status === 409) {
        throw new WebDavTargetExistsError(absolute);
      }
      if (!isWebDavMoveSuccessStatus(move.status)) {
        this.throwFor(move);
      }
    } catch (error) {
      await this.deleteQuietly(temp);
      throw error;
    }
    const relative = this.relativeOf(absolute);
    if (relative === null) {
      throw new WebDavReadbackMismatchError(absolute, bytes.byteLength, null);
    }
    return await this.readback(relative, bytes);
  }

  private async readback(relativePath: string, bytes: Uint8Array): Promise<WebDavResourceStat> {
    const stat = await this.stat(relativePath);
    if (!stat) {
      throw new WebDavReadbackMismatchError(this.resolve(relativePath), bytes.byteLength, null);
    }
    if (stat.size !== null && stat.size !== bytes.byteLength) {
      throw new WebDavReadbackMismatchError(this.resolve(relativePath), bytes.byteLength, stat.size);
    }
    return stat;
  }

  private async deleteQuietly(absolutePath: string): Promise<void> {
    try {
      await this.send("DELETE", absolutePath);
    } catch {
      // 临时文件清理是尽力而为；残留由下一轮 `.easy-sync/tmp` 清扫处理。
    }
  }

  private async requireCapabilities(): Promise<Readonly<ProviderCapabilities>> {
    if (this.cachedCapabilities) return this.cachedCapabilities;
    const result = await this.probe();
    return result.capabilities;
  }

  private async propfind(
    absolutePath: string,
    depth: "0" | "1",
  ): Promise<{ response: WebDavHttpResponse; entries: WebDavMultiStatusEntry[] }> {
    return await this.propfindAt(buildWebDavUrl(this.baseUrl, absolutePath), depth);
  }

  private async propfindAt(
    url: string,
    depth: "0" | "1",
  ): Promise<{ response: WebDavHttpResponse; entries: WebDavMultiStatusEntry[] }> {
    const response = await this.sendUrl("PROPFIND", url, {
      headers: {
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: toArrayBuffer(WEBDAV_PROPFIND_BODY),
    });
    if (response.status !== 207) {
      return { response, entries: [] };
    }
    const text = decodeBody(response.body);
    return {
      response,
      entries: parseWebDavMultiStatus(text, this.baseUrl),
    };
  }

  /**
   * 大文件传输的 soft deadline。`requestUrl` 不能真正中断，deadline 只是
   * 客户端停止等待的兜底；按 256 KiB/s 的保守下限加 30 秒余量，避免 64/100
   * MiB 在默认 30 秒处被误判为网络失败。实测 32–64 MiB 约 1.1–1.7 MiB/s。
   */
  private transferDeadlineMs(bytes: number): number {
    if (!Number.isFinite(bytes) || bytes <= 0) return this.deadlineMs;
    const transferMs = Math.ceil(
      (bytes / WEBDAV_MIN_TRANSFER_BYTES_PER_SECOND) * 1000,
    );
    return Math.max(this.deadlineMs, transferMs + 30_000);
  }

  private async send(
    method: string,
    absolutePath: string,
    options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: ArrayBuffer;
      readonly deadlineMs?: number;
    } = {},
  ): Promise<WebDavHttpResponse> {
    return await this.sendUrl(method, buildWebDavUrl(this.baseUrl, absolutePath), options);
  }

  private async sendUrl(
    method: string,
    url: string,
    options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: ArrayBuffer;
      readonly deadlineMs?: number;
    } = {},
  ): Promise<WebDavHttpResponse> {
    try {
      return await this.transport({
        method,
        url,
        headers: { Authorization: this.authorization, ...options.headers },
        body: options.body,
        deadlineMs: options.deadlineMs ?? this.deadlineMs,
      });
    } catch {
      return { status: 0, headers: {}, body: new ArrayBuffer(0) };
    }
  }

  private throwFor(response: WebDavHttpResponse): never {
    throw webDavRemoteError({
      status: response.status,
      headers: response.headers,
      bodyText: decodeBody(response.body),
      now: this.now(),
    });
  }

  private resolve(relativePath: string): string {
    const relative = normalizeWebDavPath(relativePath === "" ? "/" : relativePath);
    return relative === "/" ? this.rootPath : joinWebDavPath(this.rootPath, relative);
  }

  private relativeOf(absolutePath: string): string | null {
    if (absolutePath === this.rootPath) return "";
    if (this.rootPath === "/") {
      return absolutePath === "/" ? "" : absolutePath.replace(/^\//, "");
    }
    const prefix = `${this.rootPath}/`;
    return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : null;
  }

  /**
   * 校验服务器给的 next 链接：必须仍是同一个 HTTPS origin、同一个集合路径，
   * 不能带凭据或 fragment。query 由服务器决定（坚果云是 `?mk=…`），不猜格式。
   */
  private resolveNextPageUrl(
    currentUrl: string,
    target: string,
    expectedPath: string,
  ): string {
    let url: URL;
    try {
      url = new URL(target, currentUrl);
    } catch {
      throw new WebDavPaginationError(expectedPath, "invalid-next-link", target);
    }
    if (url.protocol !== "https:" || url.origin !== this.baseUrl) {
      throw new WebDavPaginationError(expectedPath, "next-link-outside-collection", target);
    }
    if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
      throw new WebDavPaginationError(expectedPath, "invalid-next-link", target);
    }
    let decoded: string;
    try {
      decoded = normalizeWebDavPath(decodeWebDavPathname(url.pathname));
    } catch {
      throw new WebDavPaginationError(expectedPath, "invalid-next-link", target);
    }
    if (decoded !== expectedPath) {
      throw new WebDavPaginationError(expectedPath, "next-link-outside-collection", target);
    }
    return url.href;
  }

  private toStat(entry: WebDavMultiStatusEntry): WebDavResourceStat {
    return {
      path: entry.path,
      relativePath: this.relativeOf(entry.path) ?? "",
      kind: entry.isCollection ? "collection" : "file",
      size: entry.contentLength,
      eTag: entry.eTag,
      weakETag: entry.eTag !== null && isWeakETag(entry.eTag),
      lastModified: entry.lastModified,
    };
  }
}

/** 大小写不敏感地取一个响应头；多个同名头由宿主用逗号合并。 */
function webDavHeaderValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * 解析 `Link` 头里的 `rel="next"` 目标（RFC 8288）。
 * 只收集 next；同头里的 prev/last 等不关心。
 */
function nextLinkTargets(header: string | undefined): string[] {
  if (!header) return [];
  const targets: string[] = [];
  const linkPattern = /<([^>]*)>([^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(header)) !== null) {
    const params = match[2] ?? "";
    const relMatch = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(params);
    const relations = (relMatch?.[1] ?? relMatch?.[2] ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((relation) => relation.length > 0);
    if (relations.includes("next")) targets.push(match[1]);
  }
  return targets;
}

/** 同一路径跨页出现时，只有全部事实一致才允许去重。 */
function sameWebDavStat(left: WebDavResourceStat, right: WebDavResourceStat): boolean {
  return left.path === right.path
    && left.relativePath === right.relativePath
    && left.kind === right.kind
    && left.size === right.size
    && left.eTag === right.eTag
    && left.weakETag === right.weakETag
    && left.lastModified === right.lastModified;
}

/** 中性 RemoteError → HTTP 状态；安全前置失败按 0 记录。 */
function remoteStatusOf(error: unknown): number {
  if (error instanceof RemoteError && Number.isFinite(error.statusCode)) {
    return error.statusCode;
  }
  return 0;
}

function decodeBody(body: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(body));
  } catch {
    return "";
  }
}

function toArrayBuffer(text: string): ArrayBuffer {
  return toBuffer(new TextEncoder().encode(text));
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${Date.now().toString(36)}-${hex}`;
}
