/**
 * 云端连接设置（C1 数据层；本切片零可见变化）。
 *
 * 只定义「非秘密坐标」与「连接状态」的持久化形状、校验与归一化；
 * 秘密（WebDAV 密码／S3 密钥）由 `cloud-secrets.ts` 走 SecretStorage，
 * 绝不进 `data.json`，也不进日志与诊断报告。
 *
 * 边界：
 * - OneDrive 用户不写云端类型字段（缺省即 OneDrive），读取时零迁移。
 * - 本切片刻意不被 `src/main.ts`／`src/ui/**` 引用：先落数据层与测试，
 *   接线属 C2／C3。
 * - 能力位（14 位）只作为内部执行依据，不落这份设置，也不进任何界面；
 *   连接测试只记录「成功／失败／原因」，不持久化能力快照。
 */

/** 云端类型；缺省视为 `onedrive`（OneDrive 用户不写这个字段）。 */
type CloudProviderKind = "onedrive" | "webdav" | "s3";

/**
 * 连接状态（持久化的只有证据，不持久化瞬时态）。
 *
 * - `unconfigured`：没有坐标或凭据；
 * - `untested`：坐标与凭据已在位，但没有成功的连接测试；
 * - `connected`：最近一次连接测试通过；
 * - `failed`：最近一次连接测试失败（`failureKind` 说明类型）。
 *
 * 「测试中」是内存瞬时态，不落盘；冷启动不读它。
 */
type CloudConnectionStatus =
  | "unconfigured"
  | "untested"
  | "connected"
  | "failed";

/** 失败类别：只用于选择用户可见的一句话，不记录服务端原文。 */
export type CloudConnectionFailureKind =
  | "authRejected"
  | "forbidden"
  | "notFound"
  | "network"
  | "tls"
  | "rateLimited"
  | "service"
  | "config"
  | "unknown";

/** WebDAV 坐标（`data.json`，全部非秘密）。 */
export interface WebDavCloudCoordinatesV1 {
  /** 用户输入的 HTTPS 集合地址，末尾斜杠已去掉。 */
  readonly url: string;
  /** Basic 认证用户名（与 OneDrive 的 displayName 同类：坐标/显示字段）。 */
  readonly username: string;
  /** 相对 url 的同步根；空串表示 url 本身。 */
  readonly rootPrefix: string;
}

/** 一次连接测试的结果；只保留脱敏后的用户可见所需事实。 */
interface CloudConnectionTestRecordV1 {
  /** 测试完成时间（毫秒）。 */
  readonly testedAt: number;
  readonly ok: boolean;
  /** 失败类别；`ok` 为真时缺省。 */
  readonly failureKind?: CloudConnectionFailureKind;
  /**
   * 配置指纹：坐标 + credentialRevision。指纹不一致表示「坐标或凭据变过，
   * 上次测试不再作数」，状态回到 `untested`。
   */
  readonly configFingerprint: string;
}

export interface WebDavCloudConnectionV1 {
  readonly coordinates: WebDavCloudCoordinatesV1;
  /** 凭据版本计数：每次成功写入密码 +1，让旧测试结果立即失效。 */
  readonly credentialRevision: number;
  readonly lastTest: CloudConnectionTestRecordV1 | null;
}

export interface CloudSettingsV1 {
  /** 当前云端；缺省 `onedrive`。 */
  readonly provider: CloudProviderKind;
  readonly webdav: WebDavCloudConnectionV1 | null;
}

export const EMPTY_CLOUD_SETTINGS: CloudSettingsV1 = {
  provider: "onedrive",
  webdav: null,
};

/** 失败类别 → i18n key 后缀；界面层按此取现役中性句子。 */
const CLOUD_FAILURE_KIND_KEYS: Readonly<
  Record<CloudConnectionFailureKind, string>
> = {
  authRejected: "authRejected",
  forbidden: "forbidden",
  notFound: "notFound",
  network: "network",
  tls: "tls",
  rateLimited: "rateLimited",
  service: "service",
  config: "config",
  unknown: "unknown",
};

const MAX_URL_LENGTH = 2048;
const MAX_USERNAME_LENGTH = 256;
const MAX_ROOT_PREFIX_LENGTH = 512;

interface CloudCoordinatesValidation {
  /** 规范化后的坐标；`error` 非空时为 null。 */
  readonly value: WebDavCloudCoordinatesV1 | null;
  readonly error: "urlInvalid" | "usernameInvalid" | "rootPrefixInvalid" | null;
}

/**
 * 校验并规范化 WebDAV 坐标。
 *
 * 只接受 `https://`：明文 HTTP 与匿名访问都不在 V1 范围内（2026-11-17 拍板）。
 * 地址里不允许内嵌用户名/密码、查询串或片段；末尾斜杠去掉，方便与服务器
 * 路径比对。根路径按 vault 相对语义清理：去首尾斜杠、拒绝 `..`／反斜杠／
 * 控制字符。
 */
export function validateWebDavCoordinates(input: {
  readonly url: string;
  readonly username: string;
  readonly rootPrefix: string;
}): CloudCoordinatesValidation {
  const rawUrl = input.url.trim();
  if (rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    return { value: null, error: "urlInvalid" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { value: null, error: "urlInvalid" };
  }
  if (parsed.protocol !== "https:") {
    return { value: null, error: "urlInvalid" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { value: null, error: "urlInvalid" };
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    return { value: null, error: "urlInvalid" };
  }
  const username = input.username.trim();
  if (username.length === 0
    || username.length > MAX_USERNAME_LENGTH
    || hasControlChars(username)) {
    return { value: null, error: "usernameInvalid" };
  }
  const rootPrefix = normalizeCloudRootPrefix(input.rootPrefix);
  if (rootPrefix === null) {
    return { value: null, error: "rootPrefixInvalid" };
  }
  // 保留 pathname 的百分号编码：服务器路径可能真有非 ASCII 集合名。
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  return {
    value: { url, username, rootPrefix },
    error: null,
  };
}

/**
 * 同步根路径归一化：`/`、`\`、`.`、`..` 与控制字符一律拒绝；返回不带首尾
 * 斜杠的相对路径，空串表示集合地址本身。
 */
export function normalizeCloudRootPrefix(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (trimmed.length === 0) return "";
  if (trimmed.length > MAX_ROOT_PREFIX_LENGTH) return null;
  if (trimmed.includes("\\") || hasControlChars(trimmed)) return null;
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return null;
  }
  return trimmed;
}

/**
 * 配置指纹：坐标 + 凭据版本。用 FNV-1a 折叠成短串，只用于「是否变过」的
 * 相等判断；不是安全哈希，也不承载任何秘密。
 */
export function computeWebDavConfigFingerprint(
  coordinates: WebDavCloudCoordinatesV1,
  credentialRevision: number,
): string {
  const material = [
    "webdav",
    coordinates.url,
    coordinates.username,
    coordinates.rootPrefix,
    String(normalizeCredentialRevision(credentialRevision)),
  ].join("\u0000");
  return `wd1-${fnv1aHex(material)}`;
}

/** 派生当前连接状态；`lastTest` 指纹过期即回到 `untested`。 */
export function resolveWebDavConnectionStatus(
  connection: WebDavCloudConnectionV1 | null,
  credentialsPresent: boolean,
): CloudConnectionStatus {
  if (!connection || !credentialsPresent) return "unconfigured";
  const { coordinates, credentialRevision, lastTest } = connection;
  if (!lastTest) return "untested";
  const current = computeWebDavConfigFingerprint(coordinates, credentialRevision);
  if (lastTest.configFingerprint !== current) return "untested";
  return lastTest.ok ? "connected" : "failed";
}

/** 读取持久化值；任何异常形状都退回安全默认（OneDrive、无 WebDAV）。 */
export function readCloudSettings(
  value: unknown,
  keys: { readonly provider: string; readonly webdav: string },
): CloudSettingsV1 {
  if (!isRecord(value)) return EMPTY_CLOUD_SETTINGS;
  const provider = readProvider(value[keys.provider]);
  const webdav = readWebDavConnection(value[keys.webdav]);
  // provider 指向 WebDAV 但没有可用坐标：退回 OneDrive，避免「已选云端但
  // 无凭据」的半状态（与 2026-11-17 的 fail-closed 口径一致）。
  if (provider === "webdav" && !webdav) {
    return { provider: "onedrive", webdav: null };
  }
  return { provider, webdav };
}

/** 写回持久化值：OneDrive 用户不写任何字段，保持零迁移。 */
export function writeCloudSettings(
  target: Record<string, unknown>,
  settings: CloudSettingsV1,
  keys: { readonly provider: string; readonly webdav: string },
): void {
  if (settings.provider === "onedrive" && settings.webdav === null) {
    delete target[keys.provider];
    delete target[keys.webdav];
    return;
  }
  target[keys.provider] = settings.provider;
  target[keys.webdav] = settings.webdav === null
    ? null
    : {
      coordinates: { ...settings.webdav.coordinates },
      credentialRevision: normalizeCredentialRevision(
        settings.webdav.credentialRevision,
      ),
      lastTest: settings.webdav.lastTest === null
        ? null
        : { ...settings.webdav.lastTest },
    };
}

/** 连接测试通过后写回连接记录；`revision` 参与指纹。 */
export function markWebDavTested(
  connection: WebDavCloudConnectionV1,
  result: {
    readonly ok: boolean;
    readonly failureKind?: CloudConnectionFailureKind;
    readonly testedAt: number;
  },
): WebDavCloudConnectionV1 {
  const lastTest: CloudConnectionTestRecordV1 = {
    testedAt: Math.max(0, Math.floor(result.testedAt)),
    ok: result.ok,
    configFingerprint: computeWebDavConfigFingerprint(
      connection.coordinates,
      connection.credentialRevision,
    ),
    ...(!result.ok && result.failureKind
      ? { failureKind: result.failureKind }
      : {}),
  };
  return { ...connection, lastTest };
}

/** 凭据轮换：先递增版本（旧测试立即失效），调用方再写 SecretStorage。 */
export function bumpCredentialRevision(
  connection: WebDavCloudConnectionV1,
): WebDavCloudConnectionV1 {
  return {
    ...connection,
    credentialRevision: normalizeCredentialRevision(
      connection.credentialRevision + 1,
    ),
    lastTest: null,
  };
}

function readProvider(value: unknown): CloudProviderKind {
  // S3 的数据层随 S3 切片落地；读到未知值一律按 OneDrive 处理（fail-closed）。
  if (value === "webdav") return "webdav";
  return "onedrive";
}

function readWebDavConnection(value: unknown): WebDavCloudConnectionV1 | null {
  if (!isRecord(value)) return null;
  const coordinates = readCoordinates(value.coordinates);
  if (!coordinates) return null;
  return {
    coordinates,
    credentialRevision: normalizeCredentialRevision(value.credentialRevision),
    lastTest: readTestRecord(value.lastTest),
  };
}

function readCoordinates(value: unknown): WebDavCloudCoordinatesV1 | null {
  if (!isRecord(value)
    || typeof value.url !== "string"
    || typeof value.username !== "string"
    || typeof value.rootPrefix !== "string") {
    return null;
  }
  const validated = validateWebDavCoordinates({
    url: value.url,
    username: value.username,
    rootPrefix: value.rootPrefix,
  });
  if (!validated.value) return null;
  return validated.value;
}

function readTestRecord(value: unknown): CloudConnectionTestRecordV1 | null {
  if (!isRecord(value)
    || typeof value.testedAt !== "number"
    || typeof value.ok !== "boolean"
    || typeof value.configFingerprint !== "string") {
    return null;
  }
  const failureKind = typeof value.failureKind === "string"
    && Object.prototype.hasOwnProperty.call(
      CLOUD_FAILURE_KIND_KEYS,
      value.failureKind,
    )
    ? value.failureKind as CloudConnectionFailureKind
    : undefined;
  return {
    testedAt: Number.isFinite(value.testedAt) ? Math.max(0, Math.floor(value.testedAt)) : 0,
    ok: value.ok,
    configFingerprint: value.configFingerprint,
    ...(failureKind ? { failureKind } : {}),
  };
}

function normalizeCredentialRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function hasControlChars(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 0x20);
}

/** FNV-1a 32 位；只做短指纹，不用于任何安全判定。 */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
