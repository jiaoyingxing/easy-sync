/**
 * WebDAV 最小合同探针（W1）。
 *
 * 只回答「这些协议原语与条件语义在这台服务器上是否成立」，不接同步引擎、
 * 不写用户内容、不解释 planner：
 *
 * - `PROPFIND` `Depth: 0|1|infinity`，成功码必须是 **207**（200 不是 WebDAV
 *   multistatus，按失败处理）；
 * - `ETag` 强度：`W/"…"` 弱 ETag 不能用于 `If-Match`（RFC 7232 强比较），
 *   因此同时把 `conditionalUpdate` 与 `conditionalDelete` 判为 false；
 * - `If-Match`／`If-None-Match`、条件 `DELETE`、`MOVE`＋`Overwrite: F`、
 *   `MKCOL`、路径编码（空格、`#`、`%`、`+`、中文、emoji）；
 * - 安全边界：只接受 `https://`，只发 Basic（用户名＋密码／应用密码），
 *   拒绝把凭据放进 URL，拒绝匿名访问。
 *
 * 设计依据：`docs/temp/20261117-145947 S3与WebDAV V1切片设计.md` §13.2；
 * 能力位矩阵见该单 §3.1。探针结果**非权威**：可丢弃、每会话重探，任何一项
 * 没有观察到预期语义就降级为 false，不把「先查再写」伪装成条件写。
 *
 * 本模块只交付 W1 的最小探针，不包含 §13.2 的完整错误映射表、429
 * Retry-After 处置、Range 探测与 sidecar 身份账本；这些仍属 W1 后续切片。
 *
 * XML 走 `src/providers/xml.ts`（S3 与 WebDAV 共用同一窄解析器），生产与
 * 测试不各用一套。传输通过 `WebDavTransport` 注入：生产用
 * `createRequestUrlWebDavTransport`（宿主 `requestUrl`），测试用 Node `fetch`
 * 适配器；本模块不包含重试规则。
 */
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { compatClearTimeout, compatSetTimeout, type TimeoutHandle } from "../../obsidian-compat";
import type { ProviderCapabilities } from "../../sync/provider-capabilities";
import {
  childText,
  decodeXmlBytes,
  findChild,
  findChildren,
  parseXml,
  XmlParseError,
  type XmlElement,
} from "../xml";

/** 探针配置／安全边界不满足；发出任何请求之前抛出。 */
export class WebDavProbeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavProbeConfigError";
  }
}

/** 服务端返回了无法解释的 WebDAV 响应。 */
export class WebDavProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDavProtocolError";
  }
}

export interface WebDavCredentials {
  readonly username: string;
  /** 密码或应用密码（App Password）；不允许为空。 */
  readonly password: string;
}

/**
 * 安全边界：HTTPS only、Basic only、无匿名。
 *
 * 返回解析后的 URL 供调用方继续取 origin；任何一条不满足都在发请求前抛
 * `WebDavProbeConfigError`。`App Password` 与普通密码在协议上是同一个
 * Basic 密码，本层无法区分，只能在设置页提示用户优先使用应用密码。
 */
export function assertWebDavProbeSecurity(
  endpoint: string,
  credentials: WebDavCredentials,
): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WebDavProbeConfigError(`WebDAV endpoint "${endpoint}" is not an absolute URL`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebDavProbeConfigError(
      "WebDAV credentials must not be embedded in the endpoint URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new WebDavProbeConfigError(
      `WebDAV probe refuses ${url.protocol} endpoints; HTTPS is required (plaintext HTTP is not accepted)`,
    );
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new WebDavProbeConfigError(
      "WebDAV endpoint must not contain a query or fragment; pass the collection URL as endpoint/rootPath",
    );
  }
  if (credentials.username.trim().length === 0 || credentials.password.length === 0) {
    throw new WebDavProbeConfigError(
      "WebDAV probe requires Basic authentication with a non-empty username and password/app password; anonymous access is not supported",
    );
  }
  return url;
}

/** RFC 7617 Basic：按 UTF-8 字节编码用户名与密码，再做 Base64。 */
export function buildWebDavBasicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return `Basic ${btoa(binary)}`;
}

/** 规范化 WebDAV 路径：`\`→`/`、去空段与前导／尾随 `/`，拒绝 `.`／`..`。 */
export function normalizeWebDavPath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (segment === "." || segment === "..") {
      throw new WebDavProbeConfigError(`WebDAV path "${path}" contains a dot segment`);
    }
    normalized.push(segment);
  }
  return normalized.length === 0 ? "/" : `/${normalized.join("/")}`;
}

/**
 * 路径编码：逐段 `encodeURIComponent`，保留 `/` 分隔。
 *
 * `#`、`%`、`+`、空格、中文、emoji 都会被编码；`/` 不会被编码成 `%2F`
 * （那是路径分隔符，不是文件名字符）。
 */
export function encodeWebDavPath(path: string): string {
  const normalized = normalizeWebDavPath(path);
  if (normalized === "/") return "/";
  const encoded = normalized.slice(1).split("/").map((segment) => {
    try {
      return encodeURIComponent(segment);
    } catch {
      throw new WebDavProbeConfigError(
        `WebDAV path segment in "${path}" is not encodable (lone surrogate?)`,
      );
    }
  });
  return `/${encoded.join("/")}`;
}

/**
 * 把 URL pathname 还原成段路径：逐段解码一次，保留 `/` 分隔。
 *
 * 坐标层可能保存百分号编码（例如中文集合名），而 `WebDavClient` 的路径模型
 * 是解码后的段路径，最后由 `encodeWebDavPath` 统一编码一次。两侧必须共用
 * 这一个函数，否则会把 `%` 当普通字符二次编码。
 *
 * 单段解码失败时保留原段（与 `WebDavClient` 既有行为一致），不在这里抛错；
 * URL 形态的合法性由 `validateWebDavCoordinates` 负责。
 */
export function decodeWebDavPathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

/** 拼接根集合与相对路径；两边都会规范化并拒绝 `.`／`..`。 */
export function joinWebDavPath(root: string, relative: string): string {
  const rootPath = normalizeWebDavPath(root);
  const relativePath = normalizeWebDavPath(relative);
  if (relativePath === "/") return rootPath;
  return rootPath === "/" ? relativePath : `${rootPath}${relativePath}`;
}

/** 构造绝对请求 URL；endpoint 只提供 origin，集合根由 `rootPath` 承担。 */
export function buildWebDavUrl(endpoint: string, path: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WebDavProbeConfigError(`WebDAV endpoint "${endpoint}" is not an absolute URL`);
  }
  return `${url.origin}${encodeWebDavPath(path)}`;
}

/** 服务端 `href` → 本地路径；href 可以是绝对 URL 或绝对路径。 */
export function decodeWebDavHref(href: string, baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new WebDavProtocolError(`WebDAV href "${href}" is not a valid URL`);
  }
  const decoded = url.pathname.split("/").map((segment) => {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw new WebDavProtocolError(`WebDAV href "${href}" contains invalid percent-encoding`);
    }
    // A segment that decodes to a separator is not a name the local filesystem
    // can represent at this path: treating it as a folder boundary would turn
    // one remote entry into a phantom subtree (the endpoint-config decoder
    // already rejects the same shape). Fail closed instead of reinterpreting.
    if (value.includes("/") || value.includes("\\")) {
      throw new WebDavProtocolError(
        `WebDAV href "${href}" encodes a path separator inside a segment`,
      );
    }
    return value;
  });
  const joined = decoded.join("/");
  const normalized = joined.length === 0 ? "/" : joined.startsWith("/") ? joined : `/${joined}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** 弱 ETag 判定（`W/"…"`）。弱 ETag 不能用于 `If-Match`。 */
export function isWeakETag(eTag: string): boolean {
  return /^\s*W\//i.test(eTag);
}

/**
 * RFC 4918 `If` 头的最小构造：`If: (["etag"])`。
 *
 * 传进来的 ETag 已含引号（如 `"abc"`），所以外层不再补引号；方括号包住
 * 实体标签。只支持「当前 ETag 必须匹配」这一种状态列表，不构造 Not 前缀
 * 或锁令牌形式。
 */
export function buildWebDavIfHeader(eTag: string): string {
  return `([${eTag}])`;
}

export const WEBDAV_PROPFIND_BODY = [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<d:propfind xmlns:d="DAV:">`,
  `  <d:prop>`,
  `    <d:displayname/>`,
  `    <d:resourcetype/>`,
  `    <d:getetag/>`,
  `    <d:getcontentlength/>`,
  `    <d:getlastmodified/>`,
  `  </d:prop>`,
  `</d:propfind>`,
].join("\n");

export interface WebDavMultiStatusEntry {
  /** 响应里的原始 href。 */
  readonly href: string;
  /** 解码后的绝对路径。 */
  readonly path: string;
  /** `response/status` 或 `propstat/status` 的 HTTP 码；缺失为 0。 */
  readonly status: number;
  readonly isCollection: boolean;
  readonly eTag: string | null;
  readonly contentLength: number | null;
  readonly lastModified: string | null;
  readonly displayName: string | null;
}

/**
 * 解析 `207 Multistatus`。根元素不是 `multistatus` 或条目缺 `href` 时抛
 * `WebDavProtocolError`——不返回半份结果。
 */
export function parseWebDavMultiStatus(
  xml: string,
  baseUrl: string,
): WebDavMultiStatusEntry[] {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (error) {
    if (error instanceof XmlParseError) {
      throw new WebDavProtocolError(`WebDAV multistatus XML is invalid: ${error.message}`);
    }
    throw error;
  }
  if (root.localName !== "multistatus") {
    throw new WebDavProtocolError(
      `Expected WebDAV multistatus root, got <${root.localName}>; HTTP 200 is not a valid PROPFIND success`,
    );
  }
  const entries: WebDavMultiStatusEntry[] = [];
  for (const response of findChildren(root, "response")) {
    const href = childText(response, "href")?.trim();
    if (!href) {
      throw new WebDavProtocolError("WebDAV multistatus response is missing href");
    }
    const propstats = findChildren(response, "propstat");
    let status = parseStatusLine(childText(response, "status"));
    let props: XmlElement | null = null;
    for (const propstat of propstats) {
      const propstatStatus = parseStatusLine(childText(propstat, "status"));
      if (propstatStatus !== null && propstatStatus >= 200 && propstatStatus < 300) {
        // 2xx propstat 是「资源存在」的直接证据；混合 propstat 时不能被
        // 另一个 404 propstat 覆盖成「不存在」。
        if (props === null) props = findChild(propstat, "prop");
        status = propstatStatus;
      } else if (status === null && propstatStatus !== null) {
        status = propstatStatus;
      }
    }
    if (props === null && propstats.length > 0) {
      props = findChild(propstats[0], "prop");
    }
    const resourceType = props ? findChild(props, "resourcetype") : null;
    const rawLength = props ? childText(props, "getcontentlength") : null;
    const contentLength = rawLength === null ? null : Number.parseInt(rawLength, 10);
    entries.push({
      href,
      path: decodeWebDavHref(href, baseUrl),
      status: status ?? 0,
      isCollection: resourceType !== null && findChild(resourceType, "collection") !== null,
      eTag: props ? childText(props, "getetag") : null,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      lastModified: props ? childText(props, "getlastmodified") : null,
      displayName: props ? childText(props, "displayname") : null,
    });
  }
  return entries;
}

function parseStatusLine(value: string | null): number | null {
  if (!value) return null;
  const match = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(value);
  return match ? Number.parseInt(match[1], 10) : null;
}

export type WebDavPlatform = "desktop" | "mobile";

/**
 * WebDAV 单次 PUT 的客户端切路阈值。
 *
 * 2026-11-24 真实坚果云探针：8／16／32／64／100 MiB 单次 PUT 均返回 201，
 * 读回长度一致；失败模式不是服务器拒绝大请求，而是客户端 30 秒 deadline
 * 先到。`Content-Range` 不是续传（每次都会整体替换），因此没有私有分块/
 * 断点续传，只有整文件 PUT。
 *
 * 桌面按实测门取 100 MiB；移动端按 B 验收初始门取 32 MiB，真机内存读数
 * 出来前不继续抬高。
 */
export const WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP = 100 * 1024 * 1024;
export const WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE = 32 * 1024 * 1024;

/** 传输 deadline 的保守下限；实测生产路径 32 MiB 上传约 365 KiB/s。 */
export const WEBDAV_MIN_TRANSFER_BYTES_PER_SECOND = 256 * 1024;

function webdavMaxSinglePutBytes(
  platform: WebDavPlatform = "desktop",
): number {
  return platform === "mobile"
    ? WEBDAV_MAX_SINGLE_PUT_BYTES_MOBILE
    : WEBDAV_MAX_SINGLE_PUT_BYTES_DESKTOP;
}

/**
 * 14 位能力的 fail-closed 基线：静态事实写死，条件位全部 false，等探针在
 * 真实响应上逐项改为 true。`rangeDownload` 保持 false：真实坚果云 Range GET
 * 返回 206，但执行器目前没有消费 Range 的下载/续传路径，等 B2b 接上再打开。
 */
export function webdavCapabilities(
  platform: WebDavPlatform = "desktop",
): Readonly<ProviderCapabilities> {
  return Object.freeze({
    stableIdentity: false,
    conditionalCreate: false,
    conditionalUpdate: false,
    conditionalDelete: false,
    serverSideMove: false,
    deltaCursor: false,
    folderEntity: true,
    contentChecksum: false,
    contentVersionToken: false,
    versionHistory: false,
    recycleBin: false,
    rangeDownload: false,
    resumableUpload: false,
    maxSinglePutBytes: webdavMaxSinglePutBytes(platform),
  });
}

/** 协议事实：不是 14 位能力，但同样决定这轮能不能安全地做。 */
export interface WebDavProtocolFacts {
  readonly rootReadable: boolean;
  /** Depth 0 只返回探针集合自身（恰好 1 条）。 */
  readonly depthZero: boolean;
  /** Depth 1 恰好返回探针集合＋直接子项，不夹带更深层。 */
  readonly depthOne: boolean;
  /** Depth infinity 确实包含嵌套后代；Depth 1 未通过时恒为 false。 */
  readonly depthInfinity: boolean;
  readonly head: boolean;
  readonly etagPresent: boolean;
  readonly weakETag: boolean;
  /** 目标已存在时 `MOVE`＋`Overwrite: F` 返回 412 或 409，且目标字节未被改。 */
  readonly moveOverwriteReject: boolean;
  /** `MOVE` Destination 对六类字符的编码往返；MOVE 不可用时为 false。 */
  readonly moveDestinationEncoding: boolean;
  /** `MKCOL` 只建最后一级：父级缺失 409、已存在 405。 */
  readonly mkcolSingleLevel: boolean;
  /** PUT／PROPFIND href 对六类字符的往返一致（不含 MOVE）。 */
  readonly pathEncodingRoundTrip: boolean;
}

export interface WebDavProbeObservation {
  readonly step: string;
  readonly expected: string;
  readonly observed: string;
  readonly passed: boolean;
}

export interface WebDavProbeSecurityFacts {
  /** 客户端强制使用的协议；不是对服务端证书的观测。 */
  readonly clientScheme: "https";
  /** 客户端强制使用的认证方式；不是对服务端认证配置的观测。 */
  readonly clientAuthentication: "basic";
  /** 未带 Authorization 的 PROPFIND 是否被服务端拒绝（401／403）。 */
  readonly anonymousRejected: boolean;
}

export interface WebDavProbeResult {
  readonly capabilities: Readonly<ProviderCapabilities>;
  readonly protocolFacts: Readonly<WebDavProtocolFacts>;
  readonly security: Readonly<WebDavProbeSecurityFacts>;
  readonly observations: readonly WebDavProbeObservation[];
  readonly probedAt: string;
}

export interface WebDavHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: ArrayBuffer;
  readonly deadlineMs: number;
}

export interface WebDavHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ArrayBuffer;
}

export type WebDavTransport = (request: WebDavHttpRequest) => Promise<WebDavHttpResponse>;

export type RequestUrlFunction = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

/**
 * 生产传输：`requestUrl({throw:false})` 保留 4xx／5xx 响应体；`requestUrl`
 * 不可中断、整包缓冲，所以本层自建 deadline，超时折成 `status: 0`（网络错误）。
 * 超时后请求可能仍在宿主侧运行，诊断必须如实说明。
 */
export function createRequestUrlWebDavTransport(options: {
  readonly requestUrlFn?: RequestUrlFunction;
} = {}): WebDavTransport {
  const requestUrlFn = options.requestUrlFn ?? requestUrl;
  return async (request: WebDavHttpRequest): Promise<WebDavHttpResponse> => {
    const deadlineMs = Number.isFinite(request.deadlineMs) && request.deadlineMs > 0
      ? request.deadlineMs
      : 60_000;
    const pending = Promise.resolve().then(() =>
      requestUrlFn({
        url: request.url,
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        throw: false,
      }),
    );
    let timer: TimeoutHandle | undefined;
    const timeout = new Promise<"deadline">((resolve) => {
      timer = compatSetTimeout(() => resolve("deadline"), deadlineMs);
    });
    try {
      const result = await Promise.race([pending, timeout]);
      if (result === "deadline") {
        pending.catch(() => undefined);
        return emptyResponse(0);
      }
      return {
        status: Number.isFinite(result.status) ? result.status : 0,
        headers: result.headers ?? {},
        body: result.arrayBuffer instanceof ArrayBuffer ? result.arrayBuffer : new ArrayBuffer(0),
      };
    } catch {
      return emptyResponse(0);
    } finally {
      if (timer !== undefined) compatClearTimeout(timer);
    }
  };
}

function emptyResponse(status: number): WebDavHttpResponse {
  return { status, headers: {}, body: new ArrayBuffer(0) };
}

export interface WebDavProbeConfig {
  /** 服务器 origin；若 URL 自带路径且未给 `rootPath`，该路径作为集合根。 */
  readonly endpoint: string;
  /** 远端根集合路径；缺省取 endpoint 的 pathname。 */
  readonly rootPath?: string;
  readonly credentials: WebDavCredentials;
  readonly transport: WebDavTransport;
  readonly requestDeadlineMs?: number;
  /** 宿主平台；只影响 `maxSinglePutBytes` 的静态能力位，缺省桌面。 */
  readonly platform?: WebDavPlatform;
  readonly now?: () => Date;
  readonly randomSuffix?: () => string;
}

interface ProbeState {
  anonymousRejected: boolean;
  rootReadable: boolean;
  depthZero: boolean;
  depthOne: boolean;
  depthInfinity: boolean;
  head: boolean;
  conditionalCreate: boolean;
  conditionalUpdate: boolean;
  conditionalDelete: boolean;
  etagPresent: boolean;
  weakETag: boolean;
  serverSideMove: boolean;
  moveSupported: boolean;
  moveOverwriteReject: boolean;
  moveDestinationEncoding: boolean;
  mkcolSingleLevel: boolean;
  pathEncodingRoundTrip: boolean;
}

interface ProbeContext {
  readonly baseUrl: string;
  readonly rootPath: string;
  readonly authorization: string;
  readonly transport: WebDavTransport;
  readonly deadlineMs: number;
  readonly prefix: string;
  readonly prefixPath: string;
  readonly created: string[];
  readonly observations: WebDavProbeObservation[];
}

interface PropfindResult {
  readonly response: WebDavHttpResponse;
  readonly entries: WebDavMultiStatusEntry[];
  readonly error: string | null;
}

interface SendOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: ArrayBuffer;
  /** 仅用于「服务端是否拒绝匿名」观测；正常探针请求一律带 Basic。 */
  readonly includeAuthorization?: boolean;
}

const FIRST_BODY = "easysync-webdav-probe-v1";
const UPDATED_BODY = "easysync-webdav-probe-v2";
const COLLISION_BODY = "easysync-webdav-probe-collision";
const STALE_ETAG = '"easysync-stale-probe"';
const MOVE_SOURCE_BODY = "easysync-webdav-probe-move-source";
const MOVE_TARGET_BODY = "easysync-webdav-probe-move-target";
const PROBE_REQUEST_DEADLINE_MS = 30_000;

/**
 * 逐会话探针。任何一步失败都只降级对应能力并留下 observation，不中断整组；
 * 探针对象在 `finally` 中尽力清理，清理后复扫一次根集合确认没有残留。
 */
export async function probeWebDavCapabilities(
  config: WebDavProbeConfig,
): Promise<WebDavProbeResult> {
  const endpointUrl = assertWebDavProbeSecurity(config.endpoint, config.credentials);
  const rootPath = normalizeWebDavPath(
    config.rootPath !== undefined
      ? config.rootPath
      : decodeWebDavHref(endpointUrl.pathname === "" ? "/" : endpointUrl.pathname, endpointUrl.origin),
  );
  const suffix = config.randomSuffix ? config.randomSuffix() : randomSuffix();
  const prefix = `.easy-sync-probe-${suffix}`;
  const ctx: ProbeContext = {
    baseUrl: endpointUrl.origin,
    rootPath,
    authorization: buildWebDavBasicAuthorization(
      config.credentials.username,
      config.credentials.password,
    ),
    transport: config.transport,
    deadlineMs: Number.isFinite(config.requestDeadlineMs) && (config.requestDeadlineMs ?? 0) > 0
      ? (config.requestDeadlineMs as number)
      : PROBE_REQUEST_DEADLINE_MS,
    prefix,
    prefixPath: joinWebDavPath(rootPath, prefix),
    created: [],
    observations: [],
  };
  const state: ProbeState = {
    anonymousRejected: false,
    rootReadable: false,
    depthZero: false,
    depthOne: false,
    depthInfinity: false,
    head: false,
    conditionalCreate: false,
    conditionalUpdate: false,
    conditionalDelete: false,
    etagPresent: false,
    weakETag: false,
    serverSideMove: false,
    moveSupported: false,
    moveOverwriteReject: false,
    moveDestinationEncoding: false,
    mkcolSingleLevel: false,
    pathEncodingRoundTrip: false,
  };

  try {
    await runRootChecks(ctx, state);
    if (state.rootReadable) {
      await runEtagChecks(ctx, state);
      await runMoveChecks(ctx, state);
      await runMkcolChecks(ctx, state);
      await runEncodingChecks(ctx, state);
    }
  } finally {
    await cleanupProbeResources(ctx);
  }

  if (state.rootReadable) {
    await recordResiduals(ctx);
  }

  return {
    capabilities: Object.freeze({
      ...webdavCapabilities(config.platform),
      conditionalCreate: state.conditionalCreate,
      conditionalUpdate: state.conditionalUpdate,
      conditionalDelete: state.conditionalDelete,
      serverSideMove: state.serverSideMove,
    }),
    protocolFacts: Object.freeze({
      rootReadable: state.rootReadable,
      depthZero: state.depthZero,
      depthOne: state.depthOne,
      depthInfinity: state.depthInfinity,
      head: state.head,
      etagPresent: state.etagPresent,
      weakETag: state.weakETag,
      moveOverwriteReject: state.moveOverwriteReject,
      moveDestinationEncoding: state.moveDestinationEncoding,
      mkcolSingleLevel: state.mkcolSingleLevel,
      pathEncodingRoundTrip: state.pathEncodingRoundTrip,
    }),
    security: Object.freeze({
      clientScheme: "https",
      clientAuthentication: "basic",
      anonymousRejected: state.anonymousRejected,
    } as const),
    observations: [...ctx.observations],
    probedAt: (config.now ? config.now() : new Date()).toISOString(),
  };
}

async function runRootChecks(ctx: ProbeContext, state: ProbeState): Promise<void> {
  const anonymous = await send(ctx, "PROPFIND", ctx.rootPath, {
    headers: {
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
      Accept: "application/xml",
    },
    body: toArrayBuffer(WEBDAV_PROPFIND_BODY),
    includeAuthorization: false,
  });
  state.anonymousRejected = anonymous.status === 401 || anonymous.status === 403;
  record(
    ctx,
    "auth:anonymous",
    "HTTP 401/403 without Authorization",
    `HTTP ${anonymous.status}`,
    state.anonymousRejected,
  );

  const root = await propfind(ctx, ctx.rootPath, "0");
  if (root.response.status !== 207) {
    record(
      ctx,
      "propfind:root",
      "HTTP 207 Multistatus",
      `HTTP ${root.response.status}`,
      false,
    );
    return;
  }
  if (root.error !== null) {
    record(ctx, "propfind:root", "parse 207 multistatus", root.error, false);
    return;
  }
  const rootEntry = root.entries.find((entry) => entry.path === ctx.rootPath) ?? root.entries[0];
  state.rootReadable = rootEntry !== undefined && rootEntry.isCollection;
  record(
    ctx,
    "propfind:root",
    "HTTP 207 with a collection response",
    rootEntry === undefined
      ? "207 with no response entries"
      : `207; ${rootEntry.isCollection ? "collection" : "not a collection"}`,
    state.rootReadable,
  );
  if (!state.rootReadable) return;

  await runDepthChecks(ctx, state);
}

/**
 * Depth 用探针自己的三层小树做差分，而不是数用户根集合的条数：
 *
 * - Depth 0 必须恰好返回 1 条（探针集合自身）；
 * - Depth 1 必须恰好返回 3 条（集合＋两个直接子项），且不包含嵌套文件；
 * - Depth infinity 必须返回 4 条并包含嵌套文件。
 *
 * 这样服务器静默忽略或截断 Depth、或每次只返回同一份根时，三项都会失败；
 * 同时避免对用户根做 `Depth: infinity` 全量遍历（§13.7 的内存／超时风险）。
 */
async function runDepthChecks(ctx: ProbeContext, state: ProbeState): Promise<void> {
  const depthRoot = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-depth`);
  const depthChild = joinWebDavPath(depthRoot, "child");
  const depthFile = joinWebDavPath(depthRoot, "direct.md");
  const depthNested = joinWebDavPath(depthChild, "nested.md");
  const fileHeaders = {
    "If-None-Match": "*",
    "Content-Type": "text/plain; charset=utf-8",
  };

  const rootMkcol = await send(ctx, "MKCOL", depthRoot);
  if (rootMkcol.status !== 201) {
    record(ctx, "depth:setup", "MKCOL probe collection returns 201", `HTTP ${rootMkcol.status}`, false);
    return;
  }
  ctx.created.push(depthRoot);

  const childMkcol = await send(ctx, "MKCOL", depthChild);
  if (childMkcol.status !== 201) {
    record(ctx, "depth:setup", "MKCOL child collection returns 201", `HTTP ${childMkcol.status}`, false);
    return;
  }
  ctx.created.push(depthChild);

  const directPut = await send(ctx, "PUT", depthFile, {
    headers: fileHeaders,
    body: toArrayBuffer("easysync-depth-direct"),
  });
  if (!isSuccess(directPut.status)) {
    record(ctx, "depth:setup", "PUT direct file returns 2xx", `HTTP ${directPut.status}`, false);
    return;
  }
  ctx.created.push(depthFile);

  const nestedPut = await send(ctx, "PUT", depthNested, {
    headers: fileHeaders,
    body: toArrayBuffer("easysync-depth-nested"),
  });
  if (!isSuccess(nestedPut.status)) {
    record(ctx, "depth:setup", "PUT nested file returns 2xx", `HTTP ${nestedPut.status}`, false);
    return;
  }
  ctx.created.push(depthNested);

  const zero = await propfind(ctx, depthRoot, "0");
  const zeroEntry = zero.response.status === 207
    ? zero.entries.find((entry) => entry.path === depthRoot) ?? zero.entries[0]
    : undefined;
  const zeroOk = zero.response.status === 207
    && zero.error === null
    && zero.entries.length === 1
    && zeroEntry?.path === depthRoot
    && zeroEntry.isCollection;
  state.depthZero = zeroOk;
  record(
    ctx,
    "depth:0",
    "exactly one response: the probe collection",
    describeDepth(zero),
    zeroOk,
  );

  const one = await propfind(ctx, depthRoot, "1");
  const onePaths = new Set(one.response.status === 207 ? one.entries.map((entry) => entry.path) : []);
  const oneOk = one.response.status === 207
    && one.error === null
    && one.entries.length === 3
    && onePaths.has(depthRoot)
    && onePaths.has(depthChild)
    && onePaths.has(depthFile)
    && !onePaths.has(depthNested);
  state.depthOne = zeroOk && oneOk;
  record(
    ctx,
    "depth:1",
    "exactly the collection plus its two direct children",
    describeDepth(one),
    oneOk,
  );

  const infinity = await propfind(ctx, depthRoot, "infinity");
  const infinityPaths = new Set(
    infinity.response.status === 207 ? infinity.entries.map((entry) => entry.path) : [],
  );
  const infinityOk = infinity.response.status === 207
    && infinity.error === null
    && infinity.entries.length === 4
    && infinityPaths.has(depthRoot)
    && infinityPaths.has(depthChild)
    && infinityPaths.has(depthFile)
    && infinityPaths.has(depthNested);
  state.depthInfinity = state.depthOne && infinityOk;
  record(
    ctx,
    "depth:infinity",
    "includes the nested descendant",
    describeDepth(infinity),
    infinityOk,
  );
}

function describeDepth(result: PropfindResult): string {
  if (result.error !== null) return `207 parse error: ${result.error}`;
  if (result.response.status !== 207) return `HTTP ${result.response.status}`;
  const paths = result.entries.map((entry) => entry.path).join(", ");
  return `HTTP 207; ${result.entries.length} response(s): ${paths || "(none)"}`;
}

async function runEtagChecks(ctx: ProbeContext, state: ProbeState): Promise<void> {
  const basePath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-base.md`);

  const create = await send(ctx, "PUT", basePath, {
    headers: { "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8" },
    body: toArrayBuffer(FIRST_BODY),
  });
  if (!isSuccess(create.status)) {
    record(
      ctx,
      "conditionalCreate:first",
      "201/204 for a fresh create-only PUT",
      `HTTP ${create.status}`,
      false,
    );
    return;
  }
  // 只有创建成功才登记清理，避免碰巧占用同一路径的用户对象。
  ctx.created.push(basePath);
  record(ctx, "conditionalCreate:first", "201/204 for a fresh create-only PUT", `HTTP ${create.status}`, true);

  const head = await send(ctx, "HEAD", basePath);
  const headLength = headerValue(head.headers, "content-length");
  state.head = head.status === 200 && headLength === String(FIRST_BODY.length);
  record(
    ctx,
    "head",
    "HEAD 200 with the created Content-Length",
    `HTTP ${head.status}; length ${headLength ?? "missing"}`,
    state.head,
  );

  const collision = await send(ctx, "PUT", basePath, {
    headers: { "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8" },
    body: toArrayBuffer(COLLISION_BODY),
  });
  if (collision.status === 412) {
    const readBack = await send(ctx, "GET", basePath);
    const unchanged = readBack.status === 200 && textBody(readBack) === FIRST_BODY;
    state.conditionalCreate = unchanged;
    record(
      ctx,
      "conditionalCreate:collision",
      "HTTP 412 and the existing bytes unchanged",
      `HTTP ${collision.status}; bytes ${unchanged ? "unchanged" : "changed"}`,
      unchanged,
    );
  } else {
    state.conditionalCreate = false;
    record(
      ctx,
      "conditionalCreate:collision",
      "HTTP 412",
      `HTTP ${collision.status}; the server accepted the collision write`,
      false,
    );
  }

  const baseETag = await readETag(ctx, basePath);
  state.etagPresent = baseETag !== null;
  if (baseETag === null) {
    record(ctx, "etag:present", "getetag present", "missing", false);
    return;
  }
  state.weakETag = isWeakETag(baseETag);
  if (state.weakETag) {
    state.conditionalUpdate = false;
    state.conditionalDelete = false;
    record(
      ctx,
      "conditionalUpdate:weak-etag",
      "weak ETag disables If-Match (RFC 7232 strong comparison)",
      `ETag ${baseETag}`,
      true,
    );
    record(
      ctx,
      "conditionalDelete:weak-etag",
      "weak ETag disables If-Match (RFC 7232 strong comparison)",
      `ETag ${baseETag}`,
      true,
    );
    return;
  }

  const ifMatchUpdate = await tryConditionalUpdate(ctx, basePath, "If-Match", baseETag);
  record(
    ctx,
    "conditionalUpdate:stale",
    "HTTP 412 for stale If-Match",
    ifMatchUpdate.staleRejected ? "HTTP 412" : ifMatchUpdate.observed,
    ifMatchUpdate.staleRejected,
  );
  if (ifMatchUpdate.staleRejected) {
    record(
      ctx,
      "conditionalUpdate:current",
      "2xx and updated bytes read back",
      ifMatchUpdate.observed,
      ifMatchUpdate.applied,
    );
  }
  state.conditionalUpdate = ifMatchUpdate.applied;

  // 只认 RFC 4918 If 头的服务器（设计 §13.2、§15.1 的 Nextcloud 场景）：
  // If-Match 没证明成功时，再按 `If: (["etag"])` 构造一次。
  if (!state.conditionalUpdate) {
    const fallbackETag = await readETag(ctx, basePath);
    if (fallbackETag === null) {
      record(ctx, "conditionalUpdate:rfc4918-if", "ETag from PROPFIND", "no ETag", false);
    } else {
      const ifUpdate = await tryConditionalUpdate(ctx, basePath, "If", fallbackETag);
      state.conditionalUpdate = ifUpdate.applied;
      record(
        ctx,
        "conditionalUpdate:rfc4918-if",
        "stale If rejected and current If applies with updated bytes",
        ifUpdate.observed,
        ifUpdate.applied,
      );
    }
  }

  const deleteETag = await readETag(ctx, basePath);
  if (deleteETag !== null) {
    const ifMatchDelete = await tryConditionalDelete(ctx, basePath, "If-Match", deleteETag);
    record(
      ctx,
      "conditionalDelete:stale",
      "HTTP 412 for stale If-Match",
      ifMatchDelete.staleRejected ? "HTTP 412" : ifMatchDelete.observed,
      ifMatchDelete.staleRejected,
    );
    if (ifMatchDelete.staleRejected) {
      record(
        ctx,
        "conditionalDelete:current",
        "204 and PROPFIND confirms absence after a current If-Match",
        ifMatchDelete.observed,
        ifMatchDelete.deleted,
      );
    }
    state.conditionalDelete = ifMatchDelete.deleted;
    if (ifMatchDelete.deleted || await isResourceAbsent(ctx, basePath)) {
      removeCreated(ctx, basePath);
    }
  } else {
    record(ctx, "conditionalDelete:current", "ETag from PROPFIND", "no ETag", false);
  }

  if (!state.conditionalDelete) {
    const ifDeletePath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-if-delete.md`);
    const createIfDelete = await send(ctx, "PUT", ifDeletePath, {
      headers: { "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8" },
      body: toArrayBuffer("easysync-webdav-probe-if-delete"),
    });
    if (!isSuccess(createIfDelete.status)) {
      record(
        ctx,
        "conditionalDelete:rfc4918-if",
        "create-only PUT for the If-header probe",
        `HTTP ${createIfDelete.status}`,
        false,
      );
      return;
    }
    ctx.created.push(ifDeletePath);
    const ifDeleteETag = await readETag(ctx, ifDeletePath);
    if (ifDeleteETag === null) {
      record(ctx, "conditionalDelete:rfc4918-if", "ETag from PROPFIND", "no ETag", false);
      return;
    }
    const ifDelete = await tryConditionalDelete(ctx, ifDeletePath, "If", ifDeleteETag);
    state.conditionalDelete = ifDelete.deleted;
    record(
      ctx,
      "conditionalDelete:rfc4918-if",
      "stale If rejected and current If deletes; PROPFIND confirms absence",
      ifDelete.observed,
      ifDelete.deleted,
    );
    if (ifDelete.deleted || await isResourceAbsent(ctx, ifDeletePath)) {
      removeCreated(ctx, ifDeletePath);
    }
  }
}

async function tryConditionalUpdate(
  ctx: ProbeContext,
  path: string,
  headerName: "If-Match" | "If",
  currentETag: string,
): Promise<{ staleRejected: boolean; applied: boolean; observed: string }> {
  const staleValue = headerName === "If" ? buildWebDavIfHeader(STALE_ETAG) : STALE_ETAG;
  const stale = await send(ctx, "PUT", path, {
    headers: { [headerName]: staleValue, "Content-Type": "text/plain; charset=utf-8" },
    body: toArrayBuffer(UPDATED_BODY),
  });
  if (stale.status !== 412) {
    return {
      staleRejected: false,
      applied: false,
      observed: `HTTP ${stale.status}; stale ${headerName} was accepted`,
    };
  }
  const currentValue = headerName === "If" ? buildWebDavIfHeader(currentETag) : currentETag;
  const fresh = await send(ctx, "PUT", path, {
    headers: { [headerName]: currentValue, "Content-Type": "text/plain; charset=utf-8" },
    body: toArrayBuffer(UPDATED_BODY),
  });
  const applied = isSuccess(fresh.status) && await readBodyEquals(ctx, path, UPDATED_BODY);
  return {
    staleRejected: true,
    applied,
    observed: `HTTP 412/${fresh.status}; bytes ${applied ? "updated" : "not updated"}`,
  };
}

async function tryConditionalDelete(
  ctx: ProbeContext,
  path: string,
  headerName: "If-Match" | "If",
  currentETag: string,
): Promise<{ staleRejected: boolean; deleted: boolean; observed: string }> {
  const staleValue = headerName === "If" ? buildWebDavIfHeader(STALE_ETAG) : STALE_ETAG;
  const stale = await send(ctx, "DELETE", path, {
    headers: { [headerName]: staleValue },
  });
  if (stale.status !== 412) {
    return {
      staleRejected: false,
      deleted: false,
      observed: `HTTP ${stale.status}; stale ${headerName} was accepted`,
    };
  }
  const currentValue = headerName === "If" ? buildWebDavIfHeader(currentETag) : currentETag;
  const current = await send(ctx, "DELETE", path, {
    headers: { [headerName]: currentValue },
  });
  const deleted = current.status === 204 || current.status === 200;
  if (!deleted) {
    return {
      staleRejected: true,
      deleted: false,
      observed: `HTTP 412/${current.status}; still present`,
    };
  }
  const absent = await isResourceAbsent(ctx, path);
  return {
    staleRejected: true,
    deleted: absent,
    observed: `HTTP 412/${current.status}; ${absent ? "absent" : "still present"}`,
  };
}

/**
 * `207 Multistatus` 里的 per-response 状态：`response/status` 或 `propstat/status`
 * 为 404／410 时，该 href 不是「存在」的证据。只看 href 会把「207 包着 404」
 * 的服务端误判成资源仍在（条件删除假阴性、移动目标假阳性、残留误报）。
 */
function entryIsAbsent(entry: WebDavMultiStatusEntry): boolean {
  return entry.status === 404 || entry.status === 410;
}

function findPresentEntry(
  result: PropfindResult,
  path: string,
): WebDavMultiStatusEntry | undefined {
  return result.entries.find((entry) => entry.path === path && !entryIsAbsent(entry));
}

/** 只有顶层 404／410 或 207 内同 path 的 404／410 才算「不存在」证据。 */
function isAbsentFromPropfind(result: PropfindResult, path: string): boolean {
  if (result.response.status === 404 || result.response.status === 410) return true;
  if (result.response.status !== 207 || result.error !== null) return false;
  return result.entries.some((entry) => entry.path === path && entryIsAbsent(entry));
}

async function readETag(ctx: ProbeContext, path: string): Promise<string | null> {
  const read = await propfind(ctx, path, "0");
  if (read.response.status !== 207 || read.error !== null) return null;
  const entry = findPresentEntry(read, path)
    ?? (read.entries.length === 1 && !entryIsAbsent(read.entries[0]) ? read.entries[0] : undefined);
  return entry?.eTag ?? null;
}

async function readBodyEquals(ctx: ProbeContext, path: string, expected: string): Promise<boolean> {
  const read = await send(ctx, "GET", path);
  return read.status === 200 && textBody(read) === expected;
}

async function isResourceAbsent(ctx: ProbeContext, path: string): Promise<boolean> {
  const read = await propfind(ctx, path, "0");
  return isAbsentFromPropfind(read, path);
}

function headerValue(
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

async function runMoveChecks(ctx: ProbeContext, state: ProbeState): Promise<void> {
  const sourcePath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-move-source.md`);
  const targetPath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-move-target.md`);
  const freshPath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-move-fresh.md`);

  const sourcePut = await send(ctx, "PUT", sourcePath, {
    headers: { "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8" },
    body: toArrayBuffer(MOVE_SOURCE_BODY),
  });
  if (!isSuccess(sourcePut.status)) {
    record(ctx, "move:setup", "create-only PUT for the MOVE source", `HTTP ${sourcePut.status}`, false);
    return;
  }
  ctx.created.push(sourcePath);

  const targetPut = await send(ctx, "PUT", targetPath, {
    headers: { "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8" },
    body: toArrayBuffer(MOVE_TARGET_BODY),
  });
  if (!isSuccess(targetPut.status)) {
    record(ctx, "move:setup", "create-only PUT for the MOVE target", `HTTP ${targetPut.status}`, false);
    return;
  }
  ctx.created.push(targetPath);

  const firstMove = await send(ctx, "MOVE", sourcePath, {
    headers: {
      Destination: buildWebDavUrl(ctx.baseUrl, targetPath),
      Overwrite: "F",
    },
  });

  // 412 是 RFC 4918 的「目标已存在」；部分服务器（坚果云）用 409 表达同一
  // 拒绝。两者都必须回读目标字节：只有目标未被改写，拒绝覆盖才算成立。
  if (firstMove.status === 412 || firstMove.status === 409) {
    const targetRead = await send(ctx, "GET", targetPath);
    const targetUnchanged = targetRead.status === 200 && textBody(targetRead) === MOVE_TARGET_BODY;
    state.moveOverwriteReject = targetUnchanged;
    record(
      ctx,
      "move:overwrite-f",
      "HTTP 412/409 and the destination bytes unchanged",
      `HTTP ${firstMove.status}; destination ${targetUnchanged ? "unchanged" : "was modified"}`,
      targetUnchanged,
    );
    if (!targetUnchanged) {
      state.moveSupported = false;
      state.serverSideMove = false;
      return;
    }
    const secondMove = await send(ctx, "MOVE", sourcePath, {
      headers: {
        Destination: buildWebDavUrl(ctx.baseUrl, freshPath),
        Overwrite: "F",
      },
    });
    state.moveSupported = isMoveSuccess(secondMove.status);
    record(
      ctx,
      "move:absent-destination",
      "201/204 when the destination is absent",
      `HTTP ${secondMove.status}`,
      state.moveSupported,
    );
    if (!state.moveSupported) return;

    ctx.created.push(freshPath);
    removeCreated(ctx, sourcePath);
    const oldRead = await propfind(ctx, sourcePath, "0");
    const newRead = await propfind(ctx, freshPath, "0");
    const oldGone = isAbsentFromPropfind(oldRead, sourcePath);
    const newThere = newRead.response.status === 207
      && newRead.error === null
      && findPresentEntry(newRead, freshPath) !== undefined;
    state.serverSideMove = oldGone && newThere;
    record(
      ctx,
      "move:source-absent",
      "PROPFIND source is absent (404 or 207 with a 404 response)",
      `HTTP ${oldRead.response.status}`,
      oldGone,
    );
    record(
      ctx,
      "move:destination-present",
      "PROPFIND destination returns 207 with a present entry",
      `HTTP ${newRead.response.status}`,
      newThere,
    );
    return;
  }

  if (isMoveSuccess(firstMove.status)) {
    state.moveSupported = true;
    state.moveOverwriteReject = false;
    state.serverSideMove = false;
    removeCreated(ctx, sourcePath);
    const targetRead = await send(ctx, "GET", targetPath);
    const overwritten = targetRead.status === 200 && textBody(targetRead) === MOVE_SOURCE_BODY;
    record(
      ctx,
      "move:overwrite-f",
      "HTTP 412 when the destination exists and Overwrite: F",
      `HTTP ${firstMove.status}; Overwrite: F was ignored${overwritten ? "; destination was overwritten" : ""}`,
      false,
    );
    return;
  }

  state.moveSupported = false;
  state.moveOverwriteReject = false;
  state.serverSideMove = false;
  record(
    ctx,
    "move:overwrite-f",
    "HTTP 412/409 when the destination exists and Overwrite: F",
    `HTTP ${firstMove.status}`,
    false,
  );
}

async function runMkcolChecks(ctx: ProbeContext, state: ProbeState): Promise<void> {
  const directoryPath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-dir`);
  const missingParentPath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-missing/child`);

  const create = await send(ctx, "MKCOL", directoryPath);
  if (create.status !== 201) {
    state.mkcolSingleLevel = false;
    record(ctx, "mkcol:create", "HTTP 201", `HTTP ${create.status}`, false);
    return;
  }
  ctx.created.push(directoryPath);
  record(ctx, "mkcol:create", "HTTP 201", "HTTP 201", true);

  const existing = await send(ctx, "MKCOL", directoryPath);
  record(ctx, "mkcol:existing", "HTTP 405 when the collection exists", `HTTP ${existing.status}`, existing.status === 405);

  const missingParent = await send(ctx, "MKCOL", missingParentPath);
  const rejected = missingParent.status === 409;
  if (missingParent.status === 201) {
    ctx.created.push(
      joinWebDavPath(ctx.rootPath, `${ctx.prefix}-missing`),
      missingParentPath,
    );
  }
  record(
    ctx,
    "mkcol:missing-parent",
    "HTTP 409 when the parent collection is missing",
    `HTTP ${missingParent.status}`,
    rejected,
  );
  state.mkcolSingleLevel = existing.status === 405 && rejected;

  const deleteDirectory = await send(ctx, "DELETE", directoryPath);
  if (isSuccess(deleteDirectory.status)) removeCreated(ctx, directoryPath);
}

async function runEncodingChecks(ctx: ProbeContext, state: ProbeState): Promise<void> {
  const names: ReadonlyArray<{ readonly label: string; readonly name: string }> = [
    { label: "space", name: "space name.md" },
    { label: "hash", name: "hash#name.md" },
    { label: "percent", name: "percent%name.md" },
    { label: "plus", name: "plus+name.md" },
    { label: "cjk", name: "中文 名.md" },
    { label: "emoji", name: "emoji-😀.md" },
  ];
  const expectedPaths: string[] = [];
  let filesOk = true;

  for (const [index, item] of names.entries()) {
    const path = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-enc-${index}-${item.name}`);
    expectedPaths.push(path);
    const put = await send(ctx, "PUT", path, {
      headers: { "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8" },
      body: toArrayBuffer(`easysync-encoding-${item.label}`),
    });
    if (!isSuccess(put.status)) {
      filesOk = false;
      record(ctx, `encoding:${item.label}`, "create-only PUT with an encoded path", `HTTP ${put.status}`, false);
      continue;
    }
    ctx.created.push(path);
    const read = await propfind(ctx, path, "0");
    const entry = read.response.status === 207
      ? findPresentEntry(read, path)
        ?? (read.entries.length === 1 && !entryIsAbsent(read.entries[0]) ? read.entries[0] : undefined)
      : undefined;
    const matched = read.response.status === 207 && read.error === null && entry?.path === path;
    if (!matched) filesOk = false;
    record(
      ctx,
      `encoding:${item.label}`,
      "PUT and PROPFIND round-trip the same decoded name",
      `HTTP ${put.status}; PROPFIND HTTP ${read.response.status}${entry ? `; path ${entry.path}` : ""}`,
      matched,
    );
  }

  const listing = await propfind(ctx, ctx.rootPath, "1");
  const listed = new Set(
    listing.response.status === 207 && listing.error === null
      ? listing.entries.filter((entry) => !entryIsAbsent(entry)).map((entry) => entry.path)
      : [],
  );
  const missing = expectedPaths.filter((path) => !listed.has(path));
  if (missing.length > 0) filesOk = false;
  record(
    ctx,
    "encoding:depth1-listing",
    "every encoded name is listed back with the same decoded path",
    missing.length === 0 ? "all listed" : `missing: ${missing.join(", ")}`,
    missing.length === 0,
  );

  let moveOk = false;
  if (state.moveSupported) {
    const sourceName = "移动 源#%.md";
    const targetName = "移动 目标 #%😀+中文.md";
    const sourcePath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-enc-move-${sourceName}`);
    const targetPath = joinWebDavPath(ctx.rootPath, `${ctx.prefix}-enc-move-${targetName}`);
    const sourcePut = await send(ctx, "PUT", sourcePath, {
      headers: { "If-None-Match": "*", "Content-Type": "text/plain; charset=utf-8" },
      body: toArrayBuffer("easysync-encoding-move"),
    });
    if (!isSuccess(sourcePut.status)) {
      record(ctx, "encoding:move-destination", "create-only PUT", `HTTP ${sourcePut.status}`, false);
    } else {
      ctx.created.push(sourcePath);
      const move = await send(ctx, "MOVE", sourcePath, {
        headers: {
          Destination: buildWebDavUrl(ctx.baseUrl, targetPath),
          Overwrite: "F",
        },
      });
      const moved = isMoveSuccess(move.status);
      const targetRead = moved ? await propfind(ctx, targetPath, "0") : null;
      const targetListed = targetRead !== null
        && targetRead.response.status === 207
        && targetRead.error === null
        && findPresentEntry(targetRead, targetPath) !== undefined;
      const sourceRead = moved ? await propfind(ctx, sourcePath, "0") : null;
      const sourceGone = sourceRead !== null && isAbsentFromPropfind(sourceRead, sourcePath);
      moveOk = moved && targetListed && sourceGone;
      if (moved) {
        ctx.created.push(targetPath);
        removeCreated(ctx, sourcePath);
      }
      record(
        ctx,
        "encoding:move-destination",
        "MOVE Destination with encoded names; source gone and target present",
        `HTTP ${move.status}; target ${targetListed ? "present" : "missing"}; source ${sourceGone ? "absent" : "still present"}`,
        moveOk,
      );
    }
  } else {
    record(
      ctx,
      "encoding:move-destination",
      "MOVE Destination must be verified",
      "skipped because MOVE is not available; not counted as passed",
      false,
    );
  }

  state.pathEncodingRoundTrip = filesOk;
  state.moveDestinationEncoding = moveOk;
}

async function propfind(
  ctx: ProbeContext,
  path: string,
  depth: "0" | "1" | "infinity",
): Promise<PropfindResult> {
  const response = await send(ctx, "PROPFIND", path, {
    headers: {
      Depth: depth,
      "Content-Type": "application/xml; charset=utf-8",
      Accept: "application/xml",
    },
    body: toArrayBuffer(WEBDAV_PROPFIND_BODY),
  });
  if (response.status !== 207) return { response, entries: [], error: null };
  try {
    return {
      response,
      entries: parseWebDavMultiStatus(bodyText(response), ctx.baseUrl),
      error: null,
    };
  } catch (error) {
    return {
      response,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function send(
  ctx: ProbeContext,
  method: string,
  path: string,
  options: SendOptions = {},
): Promise<WebDavHttpResponse> {
  const headers: Record<string, string> = options.includeAuthorization === false
    ? { ...options.headers }
    : { Authorization: ctx.authorization, ...options.headers };
  try {
    return await ctx.transport({
      method,
      url: buildWebDavUrl(ctx.baseUrl, path),
      headers,
      body: options.body,
      deadlineMs: ctx.deadlineMs,
    });
  } catch {
    return emptyResponse(0);
  }
}

async function cleanupProbeResources(ctx: ProbeContext): Promise<void> {
  const unique = Array.from(new Set(ctx.created))
    .filter((path) => path.startsWith(ctx.prefixPath))
    .sort((left, right) => pathDepth(right) - pathDepth(left));
  for (const path of unique) {
    try {
      await send(ctx, "DELETE", path);
    } catch {
      // 清理是尽力而为；残留由 recordResiduals 记录，不覆盖主结果。
    }
  }
}

async function recordResiduals(ctx: ProbeContext): Promise<void> {
  const listing = await propfind(ctx, ctx.rootPath, "1");
  const leftovers = listing.response.status === 207 && listing.error === null
    ? listing.entries.filter(
      (entry) => entry.path.startsWith(ctx.prefixPath) && !entryIsAbsent(entry),
    )
    : [];
  record(
    ctx,
    "cleanup:residual",
    "no probe resources remain under the root",
    listing.response.status === 207 && listing.error === null
      ? `${leftovers.length} probe resource(s) left`
      : `PROPFIND HTTP ${listing.response.status}${listing.error === null ? "" : `; ${listing.error}`}; residual check skipped`,
    listing.response.status === 207 && listing.error === null && leftovers.length === 0,
  );
}

function record(
  ctx: ProbeContext,
  step: string,
  expected: string,
  observed: string,
  passed: boolean,
): void {
  ctx.observations.push({ step, expected, observed, passed });
}

function removeCreated(ctx: ProbeContext, path: string): void {
  const index = ctx.created.indexOf(path);
  if (index >= 0) ctx.created.splice(index, 1);
}

function pathDepth(path: string): number {
  return path.split("/").filter((segment) => segment.length > 0).length;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 设计 §13.2：MOVE 的成功码是 201／204，200 不算。 */
function isMoveSuccess(status: number): boolean {
  return status === 201 || status === 204;
}

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function bodyText(response: WebDavHttpResponse): string {
  try {
    return decodeXmlBytes(response.body);
  } catch {
    return new TextDecoder().decode(response.body);
  }
}

function textBody(response: WebDavHttpResponse): string {
  return new TextDecoder().decode(response.body);
}

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${Date.now().toString(36)}-${hex}`;
}
