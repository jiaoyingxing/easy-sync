/**
 * WebDAV scope 身份与远端根占用标记（设计 §2.1、§6 S0）。
 *
 * `providerKind + endpoint + account + container + root` 才是完整 scope：
 *
 * - `endpointId` = origin（必须 `https://`，规范化由 `URL` 完成）；
 * - `containerId` = `""`（origin 已表达容器）；
 * - `rootPath` = 根集合路径（以 `/` 开头、无尾 `/`；根集合为 `/`）；
 * - `credentialBindingId` = sha256("easysync/scope/v1|webdav|"+origin+"|"+username)
 *   的前 32 位十六进制。它只表达「这是哪个账号签的 scope」，不是授权。
 *
 * 根占用标记 `<root>/.easy-sync/scope.json`（先 MKCOL `.easy-sync`）；服务器
 * 不允许 MKCOL 时回退单文件 `<root>/.easy-sync-scope.json`。标记是控制面
 * 对象，不含任何凭据明文，写入必须 create-only；只有用户显式确认「接管」
 * 后才允许替换。本模块不接引擎，IO 通过 `WebDavScopeRemoteIo` 注入。
 */
import { sha256Hex } from "../../crypto";
import type { SyncScope } from "../../sync/types";

export const WEBDAV_SCOPE_SCHEMA_VERSION = 1;
export const WEBDAV_CREDENTIAL_BINDING_PREFIX = "easysync/scope/v1|webdav|";
export const WEBDAV_CONTROL_DIRECTORY = ".easy-sync";
export const WEBDAV_SCOPE_MARKER_FILE = "scope.json";
export const WEBDAV_SCOPE_FALLBACK_FILE = ".easy-sync-scope.json";

/** scope 配置／协议边界不满足；发出任何请求之前抛出。 */
export class WebDavScopeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavScopeConfigError";
  }
}

/** 服务端返回了无法解释的 WebDAV 响应。 */
export class WebDavScopeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavScopeProtocolError";
  }
}

/** S0 新增字段里的 WebDAV 部分。 */
export interface WebDavScopeFields {
  readonly providerKind: "webdav";
  readonly endpointId: string;
  readonly containerId: "";
  readonly rootPath: string;
  readonly credentialBindingId: string;
}

export interface WebDavScopeInput {
  readonly endpoint: string;
  /** 远端根集合路径；缺省取 endpoint 的 pathname。 */
  readonly rootPath?: string;
  readonly username: string;
}

export interface ResolvedWebDavScopeEndpoint {
  readonly origin: string;
  readonly rootPath: string;
}

/**
 * 规范化 WebDAV 根集合路径：`\`→`/`、去空段与前导／尾随 `/`，拒绝 `.`／`..`。
 * 根集合返回 `/`；控制命名空间不能作为根。
 */
export function normalizeWebDavRootPath(rootPath: string): string {
  const normalized = normalizeWebDavPathForComparison(rootPath);
  if (normalized === "/") return "/";
  const firstSegment = normalized.slice(1).split("/")[0];
  if (firstSegment === WEBDAV_CONTROL_DIRECTORY) {
    throw new WebDavScopeConfigError(
      `WebDAV root path cannot be the control directory "${WEBDAV_CONTROL_DIRECTORY}"`,
    );
  }
  return normalized;
}

/** 任意远端路径的规范化；用于控制面判断，不限制根集合本身。 */
function normalizeWebDavPathForComparison(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (segment === "." || segment === "..") {
      throw new WebDavScopeConfigError(`WebDAV path "${path}" contains a dot segment`);
    }
    normalized.push(segment);
  }
  return normalized.length === 0 ? "/" : `/${normalized.join("/")}`;
}

/**
 * 解析 endpoint 与根集合：仅接受 `https://`，拒绝 URL 内凭据、查询与片段。
 *
 * endpoint 自带路径且未给 `rootPath` 时，该路径就是根集合；两者都给且不一致
 * 时拒绝——不能静默忽略其中一个，否则 scope 身份会与实际根不一致。
 */
export function resolveWebDavScopeEndpoint(
  endpoint: string,
  rootPath?: string,
): ResolvedWebDavScopeEndpoint {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WebDavScopeConfigError(`WebDAV endpoint "${endpoint}" is not an absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new WebDavScopeConfigError(
      `WebDAV endpoint must use https: "${endpoint}"`,
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebDavScopeConfigError("WebDAV endpoint must not contain credentials");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new WebDavScopeConfigError(
      "WebDAV endpoint must not contain a query or fragment; pass the collection URL as endpoint/rootPath",
    );
  }
  const endpointRoot = normalizeWebDavRootPath(decodeWebDavPathname(url.pathname));
  if (rootPath === undefined) {
    return { origin: url.origin, rootPath: endpointRoot };
  }
  const normalizedRoot = normalizeWebDavRootPath(rootPath);
  if (endpointRoot !== "/" && endpointRoot !== normalizedRoot) {
    throw new WebDavScopeConfigError(
      `WebDAV endpoint path "${endpointRoot}" does not match rootPath "${normalizedRoot}"`,
    );
  }
  return { origin: url.origin, rootPath: normalizedRoot };
}

/** 端点配置的严格解码：非法百分号编码与解码后变成路径分隔符的段都在保存前
 *  拒绝。服务端 `href` 走 `decodeWebDavHref`，同样拒绝解码后的分隔符；两处
 *  是同一个「一个段不能被重新解释成多级路径」规则，语义必须保持一致。 */
function decodeWebDavPathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new WebDavScopeConfigError(
          `WebDAV endpoint path contains invalid percent-encoding: "${pathname}"`,
        );
      }
      if (decoded.includes("/") || decoded.includes("\\")) {
        throw new WebDavScopeConfigError(
          `WebDAV endpoint path segment "${segment}" encodes a path separator`,
        );
      }
      return decoded;
    })
    .join("/");
}

/** 构造 WebDAV scope 字段；异步因为 credentialBindingId 走 WebCrypto SHA-256。 */
export async function buildWebDavScopeFields(input: WebDavScopeInput): Promise<WebDavScopeFields> {
  const resolved = resolveWebDavScopeEndpoint(input.endpoint, input.rootPath);
  const username = input.username.trim();
  if (username.length === 0) {
    throw new WebDavScopeConfigError("WebDAV username is required");
  }
  const credentialBindingId = await hashPrefix(
    `${WEBDAV_CREDENTIAL_BINDING_PREFIX}${resolved.origin}|${username}`,
    32,
  );
  return {
    providerKind: "webdav",
    endpointId: resolved.origin,
    containerId: "",
    rootPath: resolved.rootPath,
    credentialBindingId,
  };
}

/**
 * 完整 scope 摘要，用于 `scope.json` 的 `scopeId`。它把五元组一起折叠，
 * 任一字段变化都会得到不同的 scopeId；不用于授权判断。
 */
export async function buildWebDavScopeId(fields: WebDavScopeFields): Promise<string> {
  return hashPrefix(
    [
      "easysync/scope-id/v1",
      fields.providerKind,
      fields.endpointId,
      fields.containerId,
      fields.rootPath,
      fields.credentialBindingId,
    ].join("|"),
    32,
  );
}

/**
 * WebDAV 身份 → 中性 `SyncScope`（W2b2a 修正根口径）。
 *
 * 四元按设计 §2.1 派生：accountId＝credentialBindingId、driveId＝origin、
 * **vaultFolderId＝filesRootId＝`"/"`**。provider 的根 ID 就是 `"/"`，条目 ID
 * 是相对根路径；若这里填绝对 `rootPath`（如 `/vault`），引擎
 * `selectFilesRootDescendants`／`buildRemoteIndexV2` 会找不到任何后代，首轮
 * 上传／下载全部失败。绝对根路径只保存在 `rootPath` 字段，用于控制面与诊断。
 */
export function webDavScopeFieldsToSyncScope(fields: WebDavScopeFields): SyncScope {
  return {
    accountId: fields.credentialBindingId,
    driveId: fields.endpointId,
    vaultFolderId: "/",
    filesRootId: "/",
    providerKind: fields.providerKind,
    endpointId: fields.endpointId,
    containerId: fields.containerId,
    rootPath: fields.rootPath,
    credentialBindingId: fields.credentialBindingId,
  };
}

async function hashPrefix(value: string, length: number): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(value).buffer);
  return digest.slice(0, length);
}

// ---------------------------------------------------------------------------
// 控制面路径
// ---------------------------------------------------------------------------

export function webDavControlDirectoryPath(rootPath: string): string {
  const root = normalizeWebDavRootPath(rootPath);
  return root === "/" ? `/${WEBDAV_CONTROL_DIRECTORY}` : `${root}/${WEBDAV_CONTROL_DIRECTORY}`;
}

/** 标准标记 `<root>/.easy-sync/scope.json`。 */
export function webDavScopeMarkerPath(rootPath: string): string {
  return `${webDavControlDirectoryPath(rootPath)}/${WEBDAV_SCOPE_MARKER_FILE}`;
}

/** MKCOL 不可用时的回退标记 `<root>/.easy-sync-scope.json`。 */
export function webDavScopeFallbackMarkerPath(rootPath: string): string {
  const root = normalizeWebDavRootPath(rootPath);
  return root === "/" ? `/${WEBDAV_SCOPE_FALLBACK_FILE}` : `${root}/${WEBDAV_SCOPE_FALLBACK_FILE}`;
}

/** 控制命名空间与根标记不是用户内容；远端过滤层必须用它排除。 */
export function isWebDavControlPlanePath(rootPath: string, path: string): boolean {
  const normalized = normalizeWebDavPathForComparison(path);
  const controlDirectory = webDavControlDirectoryPath(rootPath);
  return normalized === controlDirectory
    || normalized.startsWith(`${controlDirectory}/`)
    || normalized === webDavScopeFallbackMarkerPath(rootPath);
}

// ---------------------------------------------------------------------------
// 根占用标记
// ---------------------------------------------------------------------------

/** `<root>/.easy-sync/scope.json` 的内容。字段顺序固定，便于逐字节比较。 */
export interface WebDavScopeMarkerV1 {
  readonly schemaVersion: 1;
  readonly providerKind: "webdav";
  readonly vaultName: string;
  readonly scopeId: string;
  readonly createdAt: string;
}

export interface BuildWebDavScopeMarkerInput {
  readonly vaultName: string;
  readonly scopeId: string;
  readonly createdAt?: Date;
}

export function buildWebDavScopeMarker(input: BuildWebDavScopeMarkerInput): WebDavScopeMarkerV1 {
  const vaultName = input.vaultName.trim();
  if (vaultName.length === 0) {
    throw new WebDavScopeConfigError("Vault name is required for the WebDAV scope marker");
  }
  if (!/^[0-9a-f]{16,64}$/.test(input.scopeId)) {
    throw new WebDavScopeConfigError(`Invalid WebDAV scope id "${input.scopeId}"`);
  }
  return {
    schemaVersion: WEBDAV_SCOPE_SCHEMA_VERSION,
    providerKind: "webdav",
    vaultName,
    scopeId: input.scopeId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

export function serializeWebDavScopeMarker(marker: WebDavScopeMarkerV1): string {
  return JSON.stringify(
    {
      schemaVersion: marker.schemaVersion,
      providerKind: marker.providerKind,
      vaultName: marker.vaultName,
      scopeId: marker.scopeId,
      createdAt: marker.createdAt,
    },
    null,
    2,
  );
}

export function parseWebDavScopeMarker(text: string): WebDavScopeMarkerV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WebDavScopeProtocolError("WebDAV scope marker is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WebDavScopeProtocolError("WebDAV scope marker must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== WEBDAV_SCOPE_SCHEMA_VERSION) {
    throw new WebDavScopeProtocolError(
      `Unsupported WebDAV scope marker schemaVersion ${String(record.schemaVersion)}`,
    );
  }
  if (record.providerKind !== "webdav") {
    throw new WebDavScopeProtocolError(`WebDAV scope marker providerKind must be "webdav"`);
  }
  const vaultName = record.vaultName;
  const scopeId = record.scopeId;
  const createdAt = record.createdAt;
  if (typeof vaultName !== "string" || vaultName.length === 0) {
    throw new WebDavScopeProtocolError(`WebDAV scope marker field "vaultName" must be a non-empty string`);
  }
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    throw new WebDavScopeProtocolError(`WebDAV scope marker field "scopeId" must be a non-empty string`);
  }
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    throw new WebDavScopeProtocolError(`WebDAV scope marker field "createdAt" must be a non-empty string`);
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new WebDavScopeProtocolError("WebDAV scope marker createdAt must be an ISO date");
  }
  return {
    schemaVersion: 1,
    providerKind: "webdav",
    vaultName,
    scopeId,
    createdAt,
  };
}

export type WebDavScopeMarkerStyle = "directory" | "fallback";

export interface WebDavScopeMarkerLocation {
  readonly path: string;
  readonly style: WebDavScopeMarkerStyle;
  readonly marker: WebDavScopeMarkerV1;
  /**
   * 读取时的强 ETag；替换标记必须原样作为 `If-Match`。弱 ETag 或服务器不
   * 返回 ETag 时为 null，调用方必须 fail-closed，不得无条件覆盖。
   */
  readonly eTag: string | null;
}

export type WebDavScopeMarkerAction =
  | "initialize"
  | "accept"
  | "takeover-required"
  | "refuse";

export interface WebDavScopeMarkerDecision {
  readonly action: WebDavScopeMarkerAction;
  readonly reason: string;
}

export interface WebDavLocalScopeIdentity {
  readonly scopeId: string;
  readonly vaultName: string;
  /** 本地是否已有同步状态（baseline／ledger 等）。 */
  readonly localStatePresent: boolean;
}

/**
 * 决定远端标记与本地 scope 的关系（与 S3 同一套规则）：
 *
 * - 没有标记 ⇒ 允许初始化；
 * - scopeId 与 vaultName 都相同 ⇒ 接受；
 * - scopeId 相同但 vaultName 不同 ⇒ 拒绝（另一个库占用同一远端根）；
 * - vaultName 相同但 scopeId 不同 ⇒ 需要显式「接管」确认（换账号／端点）；
 * - 两者都不同 ⇒ 拒绝。
 */
export function decideWebDavScopeMarker(
  existing: WebDavScopeMarkerV1 | null,
  local: WebDavLocalScopeIdentity,
): WebDavScopeMarkerDecision {
  if (!existing) {
    return { action: "initialize", reason: "No remote scope marker exists" };
  }
  if (existing.scopeId === local.scopeId) {
    if (existing.vaultName === local.vaultName) {
      return { action: "accept", reason: "Remote marker matches the local scope" };
    }
    return {
      action: "refuse",
      reason: `Remote marker belongs to vault "${existing.vaultName}", not "${local.vaultName}"`,
    };
  }
  if (existing.vaultName === local.vaultName) {
    return {
      action: "takeover-required",
      reason: local.localStatePresent
        ? "Same vault name but a different scope (endpoint/account/root changed)"
        : "Same vault name and local state is missing",
    };
  }
  return {
    action: "refuse",
    reason: `Remote marker has scope ${existing.scopeId} from vault "${existing.vaultName}"`,
  };
}

/** 非空根集合且没有标记时，已有内容必须显式确认。 */
export function requiresExistingWebDavContentConfirmation(entryCount: number): boolean {
  return entryCount > 0;
}

// ---------------------------------------------------------------------------
// S0 初始化：create-only 写入／读取／校验（注入 IO，不接引擎）
// ---------------------------------------------------------------------------

/** PROPFIND Depth: 0 的结果；`status` 为 HTTP 码，0 表示网络／超时。 */
export interface WebDavScopeStatResult {
  readonly status: number;
  readonly isCollection: boolean;
}

export interface WebDavScopeListingEntry {
  readonly path: string;
  readonly isCollection: boolean;
  readonly size: number;
}

/**
 * 初始化只需要的 WebDAV 原语。实现方负责 URL 编码、Basic 认证、deadline 与
 * 响应解析；本模块只做 scope／标记决策，不重试、不写用户内容。
 *
 * 成功码约定：PROPFIND 必须是 207（200 不是 multistatus）；MKCOL 201；
 * PUT 2xx；GET 200；404／410 表示不存在。
 */
export interface WebDavScopeRemoteIo {
  stat(path: string): Promise<WebDavScopeStatResult>;
  mkcol(path: string): Promise<number>;
  putText(
    path: string,
    text: string,
    options: {
      readonly createOnly: boolean;
      /** createOnly=false 时必须提供旧 ETag；缺失即 fail-closed。 */
      readonly ifMatch?: string | null;
    },
  ): Promise<number>;
  getText(path: string): Promise<{
    readonly status: number;
    readonly text: string;
    /** 强 ETag；缺失或弱 ETag 用 null 表示，替换标记时不得猜。 */
    readonly eTag?: string | null;
  }>;
  list(path: string): Promise<{
    readonly status: number;
    readonly entries: readonly WebDavScopeListingEntry[];
    /**
     * 列表是否完整。缺省按旧 IO 行为视为完整；显式 false 时不得把条目数
     * 当作完整事实，已有内容确认必须触发。
     */
    readonly complete?: boolean;
  }>;
}

/** 读取并校验标记：先标准路径、再回退路径；都没有返回 null。 */
export async function readWebDavScopeMarker(
  io: Pick<WebDavScopeRemoteIo, "getText">,
  rootPath: string,
): Promise<WebDavScopeMarkerLocation | null> {
  const candidates: ReadonlyArray<{ readonly path: string; readonly style: WebDavScopeMarkerStyle }> = [
    { path: webDavScopeMarkerPath(rootPath), style: "directory" },
    { path: webDavScopeFallbackMarkerPath(rootPath), style: "fallback" },
  ];
  for (const candidate of candidates) {
    const read = await io.getText(candidate.path);
    if (read.status === 404 || read.status === 410) continue;
    if (read.status !== 200) {
      throw new WebDavScopeProtocolError(
        `WebDAV scope marker ${candidate.path} is unreadable (HTTP ${read.status})`,
      );
    }
    return {
      path: candidate.path,
      style: candidate.style,
      marker: parseWebDavScopeMarker(read.text),
      eTag: read.eTag ?? null,
    };
  }
  return null;
}

export type WebDavScopeInitAction =
  | "initialize"
  | "accept"
  | "takeover-required"
  | "takeover"
  | "existing-content-confirm"
  | "refuse";

export interface WebDavScopeInitInput {
  readonly io: WebDavScopeRemoteIo;
  readonly rootPath: string;
  /** 本地准备写入的标记（已含 scopeId 与 vaultName）。 */
  readonly marker: WebDavScopeMarkerV1;
  /** 本地是否已有同步状态（baseline／ledger 等）。 */
  readonly localStatePresent: boolean;
  /** 用户已显式确认「接管同名的另一个 scope」。 */
  readonly confirmTakeover?: boolean;
  /** 用户已显式确认「把根集合里已有内容纳入对账」。 */
  readonly confirmExistingContent?: boolean;
}

export interface WebDavScopeInitResult {
  readonly action: WebDavScopeInitAction;
  /** 是否允许本轮生成写入计划；未确认的确认态一律 false。 */
  readonly mayWrite: boolean;
  readonly markerWritten: boolean;
  readonly markerPath: string | null;
  readonly markerStyle: WebDavScopeMarkerStyle | null;
  /** 根集合内非控制面条目数。 */
  readonly existingEntryCount: number;
  /** 根列表是否完整；false 表示条目数只是下界，不能据此推断没有更多内容。 */
  readonly existingEntriesComplete: boolean;
  readonly reason: string;
}

/**
 * S0 根占用初始化。确认前零写入：既不 MKCOL，也不 PUT；只做 GET／PROPFIND。
 */
export async function ensureWebDavScopeMarker(
  input: WebDavScopeInitInput,
): Promise<WebDavScopeInitResult> {
  const root = normalizeWebDavRootPath(input.rootPath);
  const local = {
    scopeId: input.marker.scopeId,
    vaultName: input.marker.vaultName,
    localStatePresent: input.localStatePresent,
  };
  let existing: WebDavScopeMarkerLocation | null;
  try {
    existing = await readWebDavScopeMarker(input.io, root);
  } catch (error) {
    return initResult("refuse", false, false, null, null, 0, describeError(error));
  }

  if (existing) {
    const decision = decideWebDavScopeMarker(existing.marker, local);
    if (decision.action === "accept") {
      return initResult(
        "accept",
        true,
        false,
        existing.path,
        existing.style,
        0,
        decision.reason,
      );
    }
    if (decision.action !== "takeover-required") {
      return initResult(
        "refuse",
        false,
        false,
        existing.path,
        existing.style,
        0,
        decision.reason,
      );
    }
    if (input.confirmTakeover !== true) {
      return initResult(
        "takeover-required",
        false,
        false,
        existing.path,
        existing.style,
        0,
        decision.reason,
      );
    }
    if (existing.eTag === null) {
      return initResult(
        "refuse",
        false,
        false,
        existing.path,
        existing.style,
        0,
        "WebDAV scope marker replace requires the current strong ETag (If-Match); the server returned none",
      );
    }
    const status = await writeScopeMarker(
      input.io,
      existing.path,
      serializeWebDavScopeMarker(input.marker),
      false,
      existing.eTag,
    );
    if (status === null) {
      return initResult(
        "refuse",
        false,
        false,
        existing.path,
        existing.style,
        0,
        "WebDAV scope marker replace failed with a network error",
      );
    }
    if (!isSuccess(status)) {
      return initResult(
        "refuse",
        false,
        false,
        existing.path,
        existing.style,
        0,
        `WebDAV scope marker replace failed (HTTP ${status})`,
      );
    }
    return initResult(
      "takeover",
      true,
      true,
      existing.path,
      existing.style,
      0,
      "Remote marker was replaced after explicit takeover confirmation",
    );
  }

  let listing: Awaited<ReturnType<WebDavScopeRemoteIo["list"]>>;
  try {
    listing = await input.io.list(root);
  } catch (error) {
    return initResult("refuse", false, false, null, null, 0, describeError(error));
  }
  if (listing.status !== 207) {
    return initResult(
      "refuse",
      false,
      false,
      null,
      null,
      0,
      `WebDAV root listing must return HTTP 207, got ${listing.status}`,
    );
  }
  const existingEntryCount = listing.entries.filter(
    (entry) => !isRootListingSelfEntry(root, entry.path)
      && !isControlPlaneEntry(root, entry.path),
  ).length;
  const listingComplete = listing.complete !== false;

  if ((requiresExistingWebDavContentConfirmation(existingEntryCount) || !listingComplete)
    && input.confirmExistingContent !== true) {
    return initResult(
      "existing-content-confirm",
      false,
      false,
      null,
      null,
      existingEntryCount,
      listingComplete
        ? `The root collection already contains ${existingEntryCount} item(s); explicit confirmation is required`
        : `The root listing may be truncated at the server entry limit (${existingEntryCount} visible non-control item(s)); explicit confirmation is required`,
      listingComplete,
    );
  }

  let style: WebDavScopeMarkerStyle;
  try {
    style = await chooseMarkerStyle(input.io, root);
  } catch (error) {
    return initResult(
      "refuse",
      false,
      false,
      null,
      null,
      existingEntryCount,
      describeError(error),
      listingComplete,
    );
  }
  const markerPath = style === "directory"
    ? webDavScopeMarkerPath(root)
    : webDavScopeFallbackMarkerPath(root);
  const status = await writeScopeMarker(
    input.io,
    markerPath,
    serializeWebDavScopeMarker(input.marker),
    true,
  );
  if (status === null) {
    return initResult(
      "refuse",
      false,
      false,
      markerPath,
      style,
      existingEntryCount,
      "WebDAV scope marker create-only PUT failed with a network error",
      listingComplete,
    );
  }
  if (isSuccess(status)) {
    const reason = input.confirmExistingContent === true && (!listingComplete || existingEntryCount > 0)
      ? listingComplete
        ? "Remote marker created after explicit existing-content confirmation"
        : "Remote marker created after explicit confirmation of a possibly truncated listing"
      : "Remote marker created";
    return initResult(
      "initialize",
      true,
      true,
      markerPath,
      style,
      existingEntryCount,
      reason,
      listingComplete,
    );
  }
  if (status !== 412) {
    return initResult(
      "refuse",
      false,
      false,
      markerPath,
      style,
      existingEntryCount,
      `WebDAV scope marker create-only PUT failed (HTTP ${status})`,
      listingComplete,
    );
  }

  // 另一个实例在探测与写入之间创建了标记：绝不覆盖，重读后重新判定。
  let raced: WebDavScopeMarkerLocation | null;
  try {
    raced = await readWebDavScopeMarker(input.io, root);
  } catch (error) {
    return initResult(
      "refuse",
      false,
      false,
      markerPath,
      style,
      existingEntryCount,
      describeError(error),
      listingComplete,
    );
  }
  if (!raced) {
    return initResult(
      "refuse",
      false,
      false,
      markerPath,
      style,
      existingEntryCount,
      "WebDAV rejected the create-only marker write but no marker is readable",
      listingComplete,
    );
  }
  const decision = decideWebDavScopeMarker(raced.marker, local);
  if (decision.action === "accept") {
    return initResult(
      "accept",
      true,
      false,
      raced.path,
      raced.style,
      existingEntryCount,
      decision.reason,
      listingComplete,
    );
  }
  if (decision.action === "takeover-required" && input.confirmTakeover === true) {
    if (raced.eTag === null) {
      return initResult(
        "refuse",
        false,
        false,
        raced.path,
        raced.style,
        existingEntryCount,
        "WebDAV scope marker replace requires the current strong ETag (If-Match); the server returned none",
        listingComplete,
      );
    }
    const replaceStatus = await writeScopeMarker(
      input.io,
      raced.path,
      serializeWebDavScopeMarker(input.marker),
      false,
      raced.eTag,
    );
    if (replaceStatus === null || !isSuccess(replaceStatus)) {
      return initResult(
        "refuse",
        false,
        false,
        raced.path,
        raced.style,
        existingEntryCount,
        replaceStatus === null
          ? "WebDAV scope marker replace failed with a network error"
          : `WebDAV scope marker replace failed (HTTP ${replaceStatus})`,
        listingComplete,
      );
    }
    return initResult(
      "takeover",
      true,
      true,
      raced.path,
      raced.style,
      existingEntryCount,
      "Remote marker was replaced after explicit takeover confirmation",
      listingComplete,
    );
  }
  return initResult(
    decision.action === "takeover-required" ? "takeover-required" : "refuse",
    false,
    false,
    raced.path,
    raced.style,
    existingEntryCount,
    decision.reason,
    listingComplete,
  );
}

async function writeScopeMarker(
  io: WebDavScopeRemoteIo,
  path: string,
  text: string,
  createOnly: boolean,
  ifMatch: string | null = null,
): Promise<number | null> {
  try {
    return await io.putText(path, text, { createOnly, ifMatch });
  } catch {
    return null;
  }
}

/** 根集合 Depth 1 列表里代表根自身的条目不算「已有内容」。 */
function isRootListingSelfEntry(root: string, path: string): boolean {
  try {
    return normalizeWebDavRootPath(path) === root;
  } catch {
    return false;
  }
}

/** 列表条目是否属于控制命名空间；异常路径按用户内容处理（需确认）。 */
function isControlPlaneEntry(root: string, path: string): boolean {
  try {
    return isWebDavControlPlanePath(root, path);
  } catch {
    return false;
  }
}

/**
 * 选择标记形态：先 MKCOL `.easy-sync`。201/200 ⇒ 标准；405 时用 PROPFIND
 * 确认集合是否已存在，存在则标准，否则回退；其余「不允许」状态回退单文件。
 */
async function chooseMarkerStyle(  io: WebDavScopeRemoteIo,
  root: string,
): Promise<WebDavScopeMarkerStyle> {
  const control = webDavControlDirectoryPath(root);
  const mkcolStatus = await io.mkcol(control);
  if (isSuccess(mkcolStatus)) return "directory";
  if (mkcolStatus === 0) {
    throw new WebDavScopeProtocolError("MKCOL failed with a network error");
  }
  if (mkcolStatus === 405) {
    const stat = await io.stat(control);
    if (stat.status === 207 && stat.isCollection) return "directory";
  }
  return "fallback";
}

function initResult(
  action: WebDavScopeInitAction,
  mayWrite: boolean,
  markerWritten: boolean,
  markerPath: string | null,
  markerStyle: WebDavScopeMarkerStyle | null,
  existingEntryCount: number,
  reason: string,
  existingEntriesComplete = true,
): WebDavScopeInitResult {
  return {
    action,
    mayWrite,
    markerWritten,
    markerPath,
    markerStyle,
    existingEntryCount,
    existingEntriesComplete,
    reason,
  };
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
