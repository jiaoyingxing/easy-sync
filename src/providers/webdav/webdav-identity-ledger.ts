/**
 * WebDAV sidecar 身份账本（W1.6 基础层，不接引擎）。
 *
 * 设计依据：`S3与WebDAV V1切片设计` §13.6（2026-11-17 用户选 B：sidecar 身份
 * 账本）与 §13.3／§15.3。账本只回答「这个远端路径属于哪个稳定身份」，远端
 * 数据文件始终是唯一内容真相：
 *
 * - 只记录 path↔uuid（以及账本自身的 `updatedAt`），不记录内容哈希、版本
 *   历史、删除决定、计划或同步权威状态；不是第二 planner／ledger。
 * - 读取不删除、不修改任何用户文件，也不因条目缺失推断删除或移动。
 * - 写入必须条件写：更新带读取时的强 ETag 走 `If-Match`；新建走安全客户端
 *   的 staged-MOVE；412／目标已存在一律暴露为冲突，调用方重读，不自动合并。
 * - 缺失／损坏／不可解析不做猜测性恢复：只允许全量扫描后重建；重建结果在
 *   用户确认前是 `unverified`（自动删除与自动改名全部关闭）。
 *
 * 状态机（`WebDavIdentityLedgerState`）：
 *
 * | 状态 | 含义 | 自动删除／改名 |
 * | --- | --- | --- |
 * | `verified` | 格式有效、读到强 ETag、服务器支持 `If-Match` | 允许 |
 * | `read-only` | 格式有效，但无／弱 ETag 或无法证明条件写 | 禁止 |
 * | `missing` | 远端没有账本（含第三方工具未保留） | 禁止 |
 * | `corrupt` | 不是合法 JSON、schema 不符、路径／uuid 非法或重复 | 禁止 |
 * | `unavailable` | 网络、权限等读取失败 | 禁止 |
 * | `unverified` | 重建后尚未得到用户确认（调用方本地信任状态） | 禁止 |
 *
 * `unverified` 刻意不写进账本：账本只负责身份，用户确认是 W2 的本地流程
 * 状态。W2 必须把确认锚定在账本内容／ETag 上，重启后不能把未确认的重建
 * 自动当成已确认。
 */
import { RemoteError } from "../../remote/errors";
import { isWeakETag, normalizeWebDavPath } from "./webdav-probe";
import {
  WebDavClient,
  WebDavPreconditionFailedError,
  WebDavTargetExistsError,
  WebDavUnsafeCreateError,
  WebDavUnsafeUpdateError,
  type WebDavResourceStat,
  type WebDavWriteResult,
} from "./webdav-client";

/** 账本 schema 版本；不认识的新版本按 corrupt 处理。 */
export const WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION = 1;

/** `WebDavClient` 使用的根相对路径；`.easy-sync/` 已由控制面过滤整体排除。 */
export const WEBDAV_IDENTITY_LEDGER_PATH = ".easy-sync/identity.json";

/** vault 相对路径的最大长度（UTF-16 码元）。 */
export const WEBDAV_IDENTITY_MAX_PATH_LENGTH = 1024;

/**
 * 账本序列化后的字节上限；控制对象固定 8 MiB，与用户文件的单次 PUT 能力
 * （桌面 100 MiB／移动 32 MiB）解耦。超过不截断写入。
 */
export const WEBDAV_IDENTITY_MAX_LEDGER_BYTES = 8 * 1024 * 1024;

const CONTROL_DIRECTORY = ".easy-sync";
const CONTROL_FALLBACK_FILE = ".easy-sync-scope.json";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const UUID_PATTERN = /^[0-9a-f]{32}$/;
// eslint-disable-next-line no-control-regex -- 账本路径禁止 C0／DEL／C1 控制字符；字符类必须显式覆盖它们
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** 账本状态；只有 `verified` 允许自动删除与自动改名。 */
export type WebDavIdentityLedgerState =
  | "verified"
  | "read-only"
  | "missing"
  | "corrupt"
  | "unavailable"
  | "unverified";

/** W2 消费的身份策略；`requiresUserConfirmation` 只在 `verified` 时为 false。 */
export interface WebDavIdentityLedgerPolicy {
  readonly state: WebDavIdentityLedgerState;
  readonly autoDeleteAllowed: boolean;
  readonly autoRenameAllowed: boolean;
  readonly requiresUserConfirmation: boolean;
}

/**
 * 账本 v1 的持久化形状。字段顺序固定；`entries` 在序列化时按 uuid 排序，
 * 每个 uuid 指向一个规范化的 vault 相对路径。
 */
export interface WebDavIdentityLedgerV1 {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly entries: Readonly<Record<string, string>>;
}

/** 校验失败的原因码；`too-large` 同时用于读取与序列化边界。 */
export type WebDavIdentityLedgerValidationIssue =
  | "not-object"
  | "shape"
  | "schema-version"
  | "updated-at"
  | "entries"
  | "uuid"
  | "path"
  | "duplicate-path"
  | "too-large"
  | "encoding"
  | "json";

/** `validateLedger`／`parseIdentityLedger` 的结果；成功时带规范化副本。 */
export interface WebDavIdentityLedgerValidation {
  readonly ok: boolean;
  readonly ledger: WebDavIdentityLedgerV1 | null;
  readonly issue: WebDavIdentityLedgerValidationIssue | null;
  readonly detail: string | null;
}

/** 一次账本读取的完整结果；`ledger` 只在格式有效时非空。 */
export interface WebDavIdentityLedgerLoadResult {
  readonly state: WebDavIdentityLedgerState;
  readonly ledger: WebDavIdentityLedgerV1 | null;
  /** 可用于 `If-Match` 的强 ETag；无／弱 ETag 时为 null（原始值见 `weakETag`）。 */
  readonly eTag: string | null;
  readonly weakETag: boolean;
  /** 强 ETag 且服务器支持 `If-Match` 时才为 true。 */
  readonly canUpdate: boolean;
  /** 诊断码；`verified` 时为 null。 */
  readonly issue: string | null;
  readonly policy: WebDavIdentityLedgerPolicy;
}

/** 写入期望：创建只允许安全新建；更新必须带读取时的强 ETag。 */
export type WebDavIdentityLedgerWriteExpectation =
  | { readonly kind: "create" }
  | { readonly kind: "update"; readonly eTag: string };

/** 写后回读结果；`state` 只可能是 verified／read-only。 */
export interface WebDavIdentityLedgerSaveResult {
  readonly ledger: WebDavIdentityLedgerV1;
  readonly state: "verified" | "read-only";
  readonly eTag: string | null;
  readonly weakETag: boolean;
  readonly canUpdate: boolean;
  readonly strategy: WebDavWriteResult["strategy"];
  readonly policy: WebDavIdentityLedgerPolicy;
}

/** 重建结果：内容已保存，但身份在用户确认前一律 `unverified`。 */
export interface WebDavIdentityLedgerRebuildResult {
  readonly state: "unverified";
  readonly ledger: WebDavIdentityLedgerV1;
  readonly eTag: string | null;
  readonly weakETag: boolean;
  readonly canUpdate: boolean;
  readonly policy: WebDavIdentityLedgerPolicy;
}

/** 412／目标已存在；`remote` 是重新读到的远端事实，调用方自行决定下一步。 */
export class IdentityLedgerConflictError extends Error {
  constructor(
    readonly operation: "create" | "update",
    readonly expectedETag: string | null,
    readonly remote: WebDavIdentityLedgerLoadResult,
  ) {
    super(
      `WebDAV identity ledger ${operation} conflicted with the remote copy (remote state: ${remote.state})`,
    );
    this.name = "IdentityLedgerConflictError";
  }
}

/** 没有安全写入原语或没有可用 ETag；调用方不得退回无条件覆盖。 */
export class IdentityLedgerUnsafeWriteError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "missing-etag"
      | "weak-etag"
      | "no-safe-primitive"
      | "remote-unavailable",
  ) {
    super(message);
    this.name = "IdentityLedgerUnsafeWriteError";
  }
}

/** 序列化超过 8 MiB；不截断写入，状态按 `unverified` 处理。 */
export class IdentityLedgerTooLargeError extends Error {
  readonly state = "unverified" as const;
  readonly policy: WebDavIdentityLedgerPolicy;

  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`WebDAV identity ledger is ${bytes} bytes; the limit is ${maxBytes} bytes`);
    this.name = "IdentityLedgerTooLargeError";
    this.policy = identityLedgerPolicy("unverified");
  }
}

/** 写入成功但回读的字节／解析结果与写入不一致。 */
export class IdentityLedgerReadbackError extends Error {
  constructor(readonly path: string, message: string) {
    super(`WebDAV identity ledger readback failed for ${path}: ${message}`);
    this.name = "IdentityLedgerReadbackError";
  }
}

/** 账本输入不合法；在发出任何请求之前抛出。 */
export class IdentityLedgerValidationError extends Error {
  constructor(
    readonly issue: WebDavIdentityLedgerValidationIssue,
    message: string,
  ) {
    super(message);
    this.name = "IdentityLedgerValidationError";
  }
}

/** 纯身份操作的目标冲突：同一 path 或同一 id 已被占用。 */
export class IdentityLedgerIdentityConflictError extends Error {
  constructor(
    message: string,
    readonly id: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "IdentityLedgerIdentityConflictError";
  }
}

/** 移动一个账本里不存在的 uuid。 */
export class IdentityLedgerUnknownIdentityError extends Error {
  constructor(readonly id: string) {
    super(`WebDAV identity ledger has no entry for id ${id}`);
    this.name = "IdentityLedgerUnknownIdentityError";
  }
}

/** 健康账本（verified／内容有效的 read-only）不得在无显式确认时重置 uuid。 */
export class IdentityLedgerRebuildNotAllowedError extends Error {
  constructor(readonly state: "verified" | "read-only") {
    super(
      `WebDAV identity ledger is healthy (${state}); resetting uuid mappings requires explicit confirmation (confirmedReset: true)`,
    );
    this.name = "IdentityLedgerRebuildNotAllowedError";
  }
}

/** `<root>/.easy-sync/identity.json` 的绝对远端路径。 */
export function webDavIdentityLedgerPath(rootPath: string): string {
  const root = normalizeWebDavPath(rootPath);
  return root === "/" ? `/${WEBDAV_IDENTITY_LEDGER_PATH}` : `${root}/${WEBDAV_IDENTITY_LEDGER_PATH}`;
}

/** 状态 → 策略；只有 `verified` 打开自动删除与自动改名。 */
export function identityLedgerPolicy(
  state: WebDavIdentityLedgerState,
): WebDavIdentityLedgerPolicy {
  const verified = state === "verified";
  return {
    state,
    autoDeleteAllowed: verified,
    autoRenameAllowed: verified,
    requiresUserConfirmation: !verified,
  };
}

/**
 * 校验任意对象是否为合法账本。只做内存判断，不产生 I/O。
 *
 * 规则：顶层字段必须恰好是 `schemaVersion`／`updatedAt`／`entries`；uuid 为
 * 32 位小写十六进制；path 为规范化 vault 相对路径（无前导／尾随 `/`、无
 * 空段、无 `.`／`..`、无控制字符、≤1024）；两个 uuid 不得指向同一 path。
 */
export function validateLedger(value: unknown): WebDavIdentityLedgerValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("not-object", "identity ledger must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "entries,schemaVersion,updatedAt") {
    return invalid("shape", "identity ledger must contain exactly schemaVersion, updatedAt and entries");
  }
  if (record.schemaVersion !== WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION) {
    return invalid("schema-version", `unsupported identity ledger schemaVersion ${String(record.schemaVersion)}`);
  }
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    return invalid("updated-at", "updatedAt must be an ISO timestamp");
  }
  const rawEntries = record.entries;
  if (typeof rawEntries !== "object" || rawEntries === null || Array.isArray(rawEntries)) {
    return invalid("entries", "entries must be an object mapping uuid to path");
  }

  const entries: Record<string, string> = {};
  const seenPaths = new Set<string>();
  for (const [id, path] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!UUID_PATTERN.test(id)) {
      return invalid("uuid", `invalid identity uuid "${id}"`);
    }
    const pathIssue = storedPathIssue(path);
    if (pathIssue !== null) {
      return invalid("path", pathIssue);
    }
    const normalized = path as string;
    if (seenPaths.has(normalized)) {
      return invalid("duplicate-path", `two identities point at the same path "${normalized}"`);
    }
    seenPaths.add(normalized);
    entries[id] = normalized;
  }

  return {
    ok: true,
    ledger: {
      schemaVersion: WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION,
      updatedAt: record.updatedAt,
      entries,
    },
    issue: null,
    detail: null,
  };
}

/**
 * 解析 JSON 文本／字节并校验。字节超过 8 MiB 时返回 `too-large`，不尝试
 * 截断或继续解析。不产生 I/O。
 */
export function parseIdentityLedger(input: string | Uint8Array): WebDavIdentityLedgerValidation {
  let text: string;
  if (typeof input === "string") {
    if (encodedLength(input) > WEBDAV_IDENTITY_MAX_LEDGER_BYTES) {
      return invalid("too-large", "identity ledger exceeds the 8 MiB single-put limit");
    }
    text = input;
  } else {
    if (input.byteLength > WEBDAV_IDENTITY_MAX_LEDGER_BYTES) {
      return invalid("too-large", "identity ledger exceeds the 8 MiB single-put limit");
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return invalid("encoding", "identity ledger is not valid UTF-8");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("json", "identity ledger is not valid JSON");
  }
  return validateLedger(parsed);
}

/**
 * 稳定序列化：顶层字段顺序固定为 schemaVersion／updatedAt／entries，
 * entries 按 uuid 升序，手工拼接以避免 JS 整数键重排。超过 8 MiB 抛
 * `IdentityLedgerTooLargeError`（状态 unverified），绝不截断。
 */
export function serializeIdentityLedger(ledger: WebDavIdentityLedgerV1): string {
  const validation = validateLedger(ledger);
  const parsed = validation.ledger;
  if (!validation.ok || parsed === null) {
    throw new IdentityLedgerValidationError(
      validation.issue ?? "shape",
      validation.detail ?? "invalid WebDAV identity ledger",
    );
  }
  const ids = Object.keys(parsed.entries).sort();
  const entries = ids
    .map((id) => `${JSON.stringify(id)}:${JSON.stringify(parsed.entries[id])}`)
    .join(",");
  const text = `{"schemaVersion":${WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION},"updatedAt":${JSON.stringify(parsed.updatedAt)},"entries":{${entries}}}`;
  const bytes = encodedLength(text);
  if (bytes > WEBDAV_IDENTITY_MAX_LEDGER_BYTES) {
    throw new IdentityLedgerTooLargeError(bytes, WEBDAV_IDENTITY_MAX_LEDGER_BYTES);
  }
  return text;
}

/**
 * 把一个新路径绑定到新 uuid。路径已绑定且未指定不同 id 时幂等返回；指定
 * 的 id 已绑定其他路径、或路径已属于其他 id 时抛身份冲突。纯函数。
 */
export function bindIdentity(
  ledger: WebDavIdentityLedgerV1,
  path: string,
  options: { readonly id?: string } = {},
): WebDavIdentityLedgerV1 {
  const base = requireValidLedger(ledger);
  const normalized = normalizeIdentityPath(path);
  const existing = findIdForPath(base.entries, normalized);
  if (existing !== null) {
    if (options.id !== undefined && options.id !== existing) {
      throw new IdentityLedgerIdentityConflictError(
        `Path "${normalized}" is already bound to identity ${existing}`,
        existing,
        normalized,
      );
    }
    return base;
  }
  const id = options.id ?? generateIdentityId();
  if (!UUID_PATTERN.test(id)) {
    throw new IdentityLedgerValidationError("uuid", `invalid identity uuid "${id}"`);
  }
  if (base.entries[id] !== undefined) {
    throw new IdentityLedgerIdentityConflictError(
      `Identity ${id} is already bound to "${base.entries[id]}"`,
      id,
      base.entries[id],
    );
  }
  return {
    ...base,
    entries: { ...base.entries, [id]: normalized },
  };
}

/**
 * 改名／移动：保留 uuid，只改它指向的 path。目标 path 已被其他 uuid 占用
 * 时抛身份冲突。纯函数，不产生远端 MOVE，也不推断文件删除。
 */
export function moveIdentity(
  ledger: WebDavIdentityLedgerV1,
  id: string,
  toPath: string,
): WebDavIdentityLedgerV1 {
  const base = requireValidLedger(ledger);
  const current = base.entries[id];
  if (current === undefined) {
    throw new IdentityLedgerUnknownIdentityError(id);
  }
  const normalized = normalizeIdentityPath(toPath);
  if (current === normalized) return base;
  const occupant = findIdForPath(base.entries, normalized);
  if (occupant !== null) {
    throw new IdentityLedgerIdentityConflictError(
      `Path "${normalized}" is already bound to identity ${occupant}`,
      occupant,
      normalized,
    );
  }
  return {
    ...base,
    entries: { ...base.entries, [id]: normalized },
  };
}

/**
 * 只从账本移除一个 uuid；不删除、不移动任何远端文件，也不推断远端删除。
 * 纯函数。
 */
export function removeIdentity(
  ledger: WebDavIdentityLedgerV1,
  id: string,
): WebDavIdentityLedgerV1 {
  const base = requireValidLedger(ledger);
  if (base.entries[id] === undefined) return base;
  const entries = { ...base.entries };
  delete entries[id];
  return { ...base, entries };
}

/** 按路径查 uuid；路径不合法或未绑定时返回 null。纯函数。 */
export function idForPath(ledger: WebDavIdentityLedgerV1, path: string): string | null {
  const normalized = tryNormalizeIdentityPath(path);
  if (normalized === null) return null;
  return findIdForPath(ledger.entries, normalized);
}

/** 按 uuid 查路径；未绑定时返回 null。纯函数。 */
export function pathForId(ledger: WebDavIdentityLedgerV1, id: string): string | null {
  return ledger.entries[id] ?? null;
}

/**
 * 读取远端账本。只做 PROPFIND／GET：
 *
 * - 404 → `missing`；
 * - 解析／校验失败 → `corrupt`（含 schema 不符、重复 path、超长 path、超 8 MiB）；
 * - 强 ETag 且服务器支持 If-Match → `verified`；
 * - 无／弱 ETag，或无法证明条件写 → `read-only`；
 * - 网络／权限等读取失败 → `unavailable`。
 *
 * 不删除、不修改任何用户文件；条目缺失不等于远端文件删除。
 */
export async function loadIdentityLedger(
  client: WebDavClient,
): Promise<WebDavIdentityLedgerLoadResult> {
  let stat: WebDavResourceStat | null;
  try {
    stat = await client.stat(WEBDAV_IDENTITY_LEDGER_PATH);
  } catch (error) {
    return failure("unavailable", issueFromError(error), null, false);
  }
  if (stat === null) {
    return failure("missing", null, null, false);
  }
  if (stat.kind !== "file") {
    return failure("corrupt", "not-file", stat, false);
  }
  if (stat.size !== null && stat.size > WEBDAV_IDENTITY_MAX_LEDGER_BYTES) {
    return failure("corrupt", "too-large", stat, false);
  }

  let read: { bytes: Uint8Array; stat: WebDavResourceStat };
  try {
    read = await client.readFile(WEBDAV_IDENTITY_LEDGER_PATH, { stat });
  } catch (error) {
    if (isNotFound(error)) {
      return failure("missing", null, null, false);
    }
    return failure("unavailable", issueFromError(error), null, false);
  }
  if (read.bytes.byteLength > WEBDAV_IDENTITY_MAX_LEDGER_BYTES) {
    return failure("corrupt", "too-large", read.stat, false);
  }

  const validation = parseIdentityLedger(read.bytes);
  if (!validation.ok || validation.ledger === null) {
    return failure(
      "corrupt",
      validation.issue ?? "json",
      read.stat,
      canConditionalUpdate(client, read.stat),
    );
  }
  return loadedResult(validation.ledger, read.stat, client);
}

/**
 * 保存账本。`create` 走安全客户端的安全新建（条件创建或 staged-MOVE）；
 * `update` 必须带读取时的强 ETag 走 `If-Match`。412／目标已存在抛
 * `IdentityLedgerConflictError`，`remote` 是重新读取的远端事实；没有安全
 * 原语或 ETag 时抛 `IdentityLedgerUnsafeWriteError`，绝不退回无条件覆盖。
 * 写后回读字节并重新解析，长度／内容不一致即失败。
 */
export async function saveIdentityLedger(
  client: WebDavClient,
  ledger: WebDavIdentityLedgerV1,
  expected: WebDavIdentityLedgerWriteExpectation,
  options: { readonly now?: Date } = {},
): Promise<WebDavIdentityLedgerSaveResult> {
  const input = validateLedger(ledger);
  if (!input.ok || input.ledger === null) {
    throw new IdentityLedgerValidationError(
      input.issue ?? "shape",
      input.detail ?? "invalid WebDAV identity ledger",
    );
  }
  const claimed: WebDavIdentityLedgerV1 = {
    schemaVersion: WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION,
    updatedAt: (options.now ?? new Date()).toISOString(),
    entries: { ...input.ledger.entries },
  };
  const validation = validateLedger(claimed);
  if (!validation.ok || validation.ledger === null) {
    throw new IdentityLedgerValidationError(
      validation.issue ?? "shape",
      validation.detail ?? "invalid WebDAV identity ledger",
    );
  }
  const serialized = serializeIdentityLedger(validation.ledger);
  const bytes = new TextEncoder().encode(serialized);

  let write: WebDavWriteResult;
  try {
    if (expected.kind === "create") {
      write = await client.createFile(WEBDAV_IDENTITY_LEDGER_PATH, bytes, {
        contentType: JSON_CONTENT_TYPE,
      });
    } else {
      const ifMatch = expected.eTag.trim();
      if (ifMatch.length === 0) {
        throw new IdentityLedgerUnsafeWriteError(
          "WebDAV identity ledger update requires a non-empty strong ETag",
          "missing-etag",
        );
      }
      if (isWeakETag(ifMatch)) {
        throw new IdentityLedgerUnsafeWriteError(
          "WebDAV identity ledger update refuses a weak ETag",
          "weak-etag",
        );
      }
      write = await client.updateFile(WEBDAV_IDENTITY_LEDGER_PATH, bytes, ifMatch, {
        contentType: JSON_CONTENT_TYPE,
      });
    }
  } catch (error) {
    if (error instanceof IdentityLedgerUnsafeWriteError) throw error;
    if (error instanceof WebDavTargetExistsError || error instanceof WebDavPreconditionFailedError) {
      const remote = await loadIdentityLedger(client);
      throw new IdentityLedgerConflictError(
        expected.kind,
        expected.kind === "update" ? expected.eTag : null,
        remote,
      );
    }
    if (error instanceof WebDavUnsafeCreateError || error instanceof WebDavUnsafeUpdateError) {
      throw new IdentityLedgerUnsafeWriteError(
        `WebDAV server has no safe primitive for the identity ledger: ${error.message}`,
        "no-safe-primitive",
      );
    }
    throw error;
  }

  let readback: { bytes: Uint8Array; stat: WebDavResourceStat };
  try {
    readback = await client.readFile(WEBDAV_IDENTITY_LEDGER_PATH);
  } catch (error) {
    throw new IdentityLedgerReadbackError(
      WEBDAV_IDENTITY_LEDGER_PATH,
      `read failed after write (${issueFromError(error)})`,
    );
  }
  if (!bytesEqual(readback.bytes, bytes)) {
    throw new IdentityLedgerReadbackError(
      WEBDAV_IDENTITY_LEDGER_PATH,
      "bytes read back do not match the bytes written",
    );
  }
  const parsed = parseIdentityLedger(readback.bytes);
  if (!parsed.ok || parsed.ledger === null) {
    throw new IdentityLedgerReadbackError(
      WEBDAV_IDENTITY_LEDGER_PATH,
      `written ledger is not parseable (${parsed.issue ?? "json"})`,
    );
  }

  const canUpdate = canConditionalUpdate(client, readback.stat);
  const state: "verified" | "read-only" = canUpdate ? "verified" : "read-only";
  return {
    ledger: parsed.ledger,
    state,
    eTag: strongETag(readback.stat),
    weakETag: isWeakETagStat(readback.stat),
    canUpdate,
    strategy: write.strategy,
    policy: identityLedgerPolicy(state),
  };
}

/**
 * 全量扫描后的账本重建：为每个 path 分配新的唯一 uuid，保存后返回
 * `unverified`。不清空／删除任何远端文件，只写账本。
 *
 * 只有缺失／损坏／无法读取的账本才自动重建。健康账本（`verified`，或内容
 * 有效但只读的 `read-only`）默认拒绝，必须显式传 `confirmedReset: true`
 * 才会重置 uuid 映射；拒绝时不发写入请求。
 *
 * 远端已有合法账本时按当前内容做条件替换；损坏账本只有在读到强 ETag 时
 * 才允许替换；无／弱 ETag 或远端不可用一律 fail-closed。
 */
export async function rebuildIdentityLedger(
  client: WebDavClient,
  paths: readonly string[],
  options: { readonly now?: Date; readonly confirmedReset?: boolean } = {},
): Promise<WebDavIdentityLedgerRebuildResult> {
  const current = await loadIdentityLedger(client);
  if (current.state === "unavailable") {
    throw new IdentityLedgerUnsafeWriteError(
      "WebDAV identity ledger is unavailable; refusing to rebuild without reading the remote copy",
      "remote-unavailable",
    );
  }
  const healthyState = current.state === "verified"
    ? "verified"
    : current.state === "read-only" && current.ledger !== null
      ? "read-only"
      : null;
  if (healthyState !== null && options.confirmedReset !== true) {
    throw new IdentityLedgerRebuildNotAllowedError(healthyState);
  }

  const entries: Record<string, string> = {};
  for (const path of paths) {
    const normalized = normalizeIdentityPath(path);
    if (findIdForPath(entries, normalized) !== null) continue;
    let id = generateIdentityId();
    while (entries[id] !== undefined) id = generateIdentityId();
    entries[id] = normalized;
  }

  const ledger: WebDavIdentityLedgerV1 = {
    schemaVersion: WEBDAV_IDENTITY_LEDGER_SCHEMA_VERSION,
    updatedAt: (options.now ?? new Date()).toISOString(),
    entries,
  };

  let expectation: WebDavIdentityLedgerWriteExpectation;
  if (current.state === "missing") {
    expectation = { kind: "create" };
  } else {
    if (current.eTag === null) {
      throw new IdentityLedgerUnsafeWriteError(
        "Existing WebDAV identity ledger has no usable strong ETag; refusing an unconditional rebuild",
        current.weakETag ? "weak-etag" : "missing-etag",
      );
    }
    expectation = { kind: "update", eTag: current.eTag };
  }

  const saved = await saveIdentityLedger(client, ledger, expectation, options);
  return {
    state: "unverified",
    ledger: saved.ledger,
    eTag: saved.eTag,
    weakETag: saved.weakETag,
    canUpdate: saved.canUpdate,
    policy: identityLedgerPolicy("unverified"),
  };
}

/**
 * 用户确认重建后的账本。纯状态转换：只有远端写入仍可条件更新（强 ETag＋
 * If-Match 能力）时才转为 `verified`，否则保持 `read-only`。
 *
 * 确认本身不写远端；W2 需把确认锚定到 `ledger`／`eTag` 并持久化本地状态。
 */
export function confirmRebuild(
  rebuilt: WebDavIdentityLedgerRebuildResult,
): WebDavIdentityLedgerLoadResult {
  return verifiedView(rebuilt);
}

/**
 * 把已有读取／重建结果标记为用户已确认。缺失／损坏／不可用没有可确认的
 * 账本；`read-only` 不会仅凭确认变成 `verified`。纯状态转换。
 */
export function markVerified(
  result: WebDavIdentityLedgerLoadResult | WebDavIdentityLedgerRebuildResult,
): WebDavIdentityLedgerLoadResult {
  return verifiedView(result);
}

function verifiedView(
  result: WebDavIdentityLedgerLoadResult | WebDavIdentityLedgerRebuildResult,
): WebDavIdentityLedgerLoadResult {
  const ledger = result.ledger;
  if (ledger === null) {
    throw new IdentityLedgerValidationError(
      "shape",
      "cannot confirm an identity ledger that was not read successfully",
    );
  }
  const confirmed = result.state === "verified"
    || (result.state === "unverified" && result.canUpdate && result.eTag !== null);
  const state: WebDavIdentityLedgerState = confirmed ? "verified" : "read-only";
  return {
    state,
    ledger,
    eTag: result.eTag,
    weakETag: result.weakETag,
    canUpdate: confirmed,
    issue: confirmed ? null : "confirmation-requires-strong-etag",
    policy: identityLedgerPolicy(state),
  };
}

function loadedResult(
  ledger: WebDavIdentityLedgerV1,
  stat: WebDavResourceStat,
  client: WebDavClient,
): WebDavIdentityLedgerLoadResult {
  const eTag = strongETag(stat);
  const canUpdate = eTag !== null && client.capabilities?.conditionalUpdate === true;
  const state: WebDavIdentityLedgerState = canUpdate ? "verified" : "read-only";
  let issue: string | null = null;
  if (!canUpdate) {
    if (eTag === null) {
      issue = isWeakETagStat(stat) ? "weak-etag" : "missing-etag";
    } else if (client.capabilities === null) {
      issue = "capabilities-unknown";
    } else {
      issue = "conditional-update-unavailable";
    }
  }
  return {
    state,
    ledger,
    eTag,
    weakETag: isWeakETagStat(stat),
    canUpdate,
    issue,
    policy: identityLedgerPolicy(state),
  };
}

function failure(
  state: "missing" | "corrupt" | "unavailable",
  issue: string | null,
  stat: WebDavResourceStat | null,
  canUpdate: boolean,
): WebDavIdentityLedgerLoadResult {
  return {
    state,
    ledger: null,
    eTag: stat === null ? null : strongETag(stat),
    weakETag: stat !== null && isWeakETagStat(stat),
    canUpdate,
    issue,
    policy: identityLedgerPolicy(state),
  };
}

function canConditionalUpdate(client: WebDavClient, stat: WebDavResourceStat): boolean {
  return strongETag(stat) !== null && client.capabilities?.conditionalUpdate === true;
}

function strongETag(stat: WebDavResourceStat): string | null {
  const raw = stat.eTag?.trim() ?? "";
  if (raw.length === 0) return null;
  if (stat.weakETag || isWeakETag(raw)) return null;
  return raw;
}

function isWeakETagStat(stat: WebDavResourceStat): boolean {
  return stat.weakETag || (stat.eTag !== null && isWeakETag(stat.eTag));
}

function requireValidLedger(ledger: WebDavIdentityLedgerV1): WebDavIdentityLedgerV1 {
  const validation = validateLedger(ledger);
  if (!validation.ok || validation.ledger === null) {
    throw new IdentityLedgerValidationError(
      validation.issue ?? "shape",
      validation.detail ?? "invalid WebDAV identity ledger",
    );
  }
  return validation.ledger;
}

function normalizeIdentityPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new IdentityLedgerValidationError("path", "identity path must be a non-empty string");
  }
  if (CONTROL_CHARACTER_PATTERN.test(path)) {
    throw new IdentityLedgerValidationError("path", "identity path must not contain control characters");
  }
  if (path.includes("\\")) {
    throw new IdentityLedgerValidationError("path", "identity path must use forward slashes");
  }
  const collapsed = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
  const issue = storedPathIssue(collapsed);
  if (issue !== null) {
    throw new IdentityLedgerValidationError("path", issue);
  }
  return collapsed;
}

function tryNormalizeIdentityPath(path: string): string | null {
  try {
    return normalizeIdentityPath(path);
  } catch {
    return null;
  }
}

function storedPathIssue(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) {
    return "identity path must be a non-empty vault-relative string";
  }
  if (CONTROL_CHARACTER_PATTERN.test(path)) {
    return "identity path must not contain control characters";
  }
  if (path.includes("\\")) {
    return "identity path must use forward slashes";
  }
  if (path.startsWith("/") || path.endsWith("/")) {
    return "identity path must not start or end with a slash";
  }
  if (path.includes("//")) {
    return "identity path must not contain empty segments";
  }
  if (path.length > WEBDAV_IDENTITY_MAX_PATH_LENGTH) {
    return `identity path exceeds ${WEBDAV_IDENTITY_MAX_PATH_LENGTH} characters`;
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return "identity path must not contain empty, \".\" or \"..\" segments";
    }
  }
  if (path === CONTROL_DIRECTORY || path.startsWith(`${CONTROL_DIRECTORY}/`) || path === CONTROL_FALLBACK_FILE) {
    return "identity path must not point into the EasySync control plane";
  }
  return null;
}

function findIdForPath(
  entries: Readonly<Record<string, string>>,
  path: string,
): string | null {
  for (const [id, candidate] of Object.entries(entries)) {
    if (candidate === path) return id;
  }
  return null;
}

function generateIdentityId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
  return id;
}

function invalid(
  issue: WebDavIdentityLedgerValidationIssue,
  detail: string,
): WebDavIdentityLedgerValidation {
  return { ok: false, ledger: null, issue, detail };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function encodedLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function isNotFound(error: unknown): boolean {
  return error instanceof RemoteError && error.statusCode === 404;
}

function issueFromError(error: unknown): string {
  if (error instanceof RemoteError) {
    return error.statusCode === 0 ? "network-error" : `http-${error.statusCode}`;
  }
  return "unexpected-error";
}
