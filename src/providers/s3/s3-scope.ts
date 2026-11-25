/**
 * S3 scope 身份与远端根占用标记（设计 §2.1、§6）。
 *
 * `providerKind + endpoint + account + container + root` 才是完整 scope：
 *
 * - `endpointId` = 规范化 origin ＋ `|` ＋ region；
 * - `containerId` = bucket；
 * - `rootPath` = 规范化根前缀；
 * - `credentialBindingId` = sha256("easysync/scope/v1|s3|"+endpointId+"|"+accessKeyId)
 *   的前 32 位十六进制。它只表达「这是哪个账号签的 scope」，不是授权。
 *
 * `scope.json` 是控制面对象，**不含任何凭据明文**；写入必须 create-only。
 */
import { sha256Hex } from "../../crypto";
import type { SyncScope } from "../../sync/types";
import { isControlPlaneKey, normalizeRootPrefix, scopeMarkerKey, S3_CONTROL_DIRECTORY } from "./s3-key";
import { s3ProtocolError } from "./s3-errors";

export const S3_SCOPE_SCHEMA_VERSION = 1;
export const S3_CREDENTIAL_BINDING_PREFIX = "easysync/scope/v1|s3|";

/** S0 新增字段里的 S3 部分。 */
export interface S3ScopeFields {
  readonly providerKind: "s3";
  readonly endpointId: string;
  readonly containerId: string;
  readonly rootPath: string;
  readonly credentialBindingId: string;
}

export interface S3ScopeInput {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly rootPath?: string;
  readonly accessKeyId: string;
}

export interface NormalizedS3Endpoint {
  readonly origin: string;
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly port: string;
}

/**
 * 规范化 endpoint：协议＋小写 host＋非默认端口。
 * 不接受 userinfo、query、hash 或非根路径——endpoint 与 bucket／root 分开表达。
 */
export function normalizeS3Endpoint(endpoint: string): NormalizedS3Endpoint {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw s3ProtocolError(`Invalid S3 endpoint "${endpoint}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw s3ProtocolError(`S3 endpoint must use http or https: "${endpoint}"`);
  }
  if (url.username || url.password) {
    throw s3ProtocolError("S3 endpoint must not contain credentials");
  }
  if (url.search || url.hash) {
    throw s3ProtocolError("S3 endpoint must not contain a query or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw s3ProtocolError("S3 endpoint must be an origin without a path");
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : "";
  return {
    origin: `${url.protocol}//${url.hostname.toLowerCase()}${port}`,
    protocol: url.protocol,
    hostname: url.hostname.toLowerCase(),
    port,
  };
}

/** 构造 S3 scope 字段；异步因为 credentialBindingId 走 WebCrypto SHA-256。 */
export async function buildS3ScopeFields(input: S3ScopeInput): Promise<S3ScopeFields> {
  const endpoint = normalizeS3Endpoint(input.endpoint);
  const region = input.region.trim().toLowerCase();
  if (region.length === 0) throw s3ProtocolError("S3 region is required");
  const bucket = input.bucket.trim();
  if (bucket.length === 0 || bucket.includes("/")) {
    throw s3ProtocolError(`Invalid S3 bucket "${input.bucket}"`);
  }
  const accessKeyId = input.accessKeyId.trim();
  if (accessKeyId.length === 0) throw s3ProtocolError("S3 access key id is required");
  const endpointId = `${endpoint.origin}|${region}`;
  const credentialBindingId = await hashPrefix(
    `${S3_CREDENTIAL_BINDING_PREFIX}${endpointId}|${accessKeyId}`,
    32,
  );
  return {
    providerKind: "s3",
    endpointId,
    containerId: bucket,
    rootPath: normalizeRootPrefix(input.rootPath ?? ""),
    credentialBindingId,
  };
}

/**
 * 完整 scope 摘要，用于 `scope.json` 的 `scopeId`。它把五元组一起折叠，
 * 任一字段变化都会得到不同的 scopeId；不用于授权判断。
 */
export async function buildS3ScopeId(fields: S3ScopeFields): Promise<string> {
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
 * S3 身份 → 中性 `SyncScope`（S0 只提供映射，不接引擎）。
 *
 * 四元按设计 §2.1 派生：accountId＝credentialBindingId、driveId＝containerId、
 * vaultFolderId＝filesRootId＝rootPath。桶根（rootPath 为空串）没有远端路径
 * 可表达，用合成根 ID `"/"` 填 `vaultFolderId/filesRootId`（设计 §2.1
 * 「filesRootId＝rootPath 或根集合 id」）；`rootPath` 字段本身仍是空串。
 * `"/"` **不是远端 key**，不得用它拼接远端路径。
 *
 * 设计 §9.2 写作 `filesRootId=<root>/`（带尾 `/`），与 §2.1 的
 * `filesRootId=rootPath`（无尾 `/`）存在歧义；S0 **按 §2.1 优先**，保持无尾
 * `/`，文档统一由编排层处理。
 */
export function s3ScopeFieldsToSyncScope(fields: S3ScopeFields): SyncScope {
  requireNonEmptyScopeField(fields.endpointId, "endpointId");
  requireNonEmptyScopeField(fields.containerId, "containerId");
  requireNonEmptyScopeField(fields.credentialBindingId, "credentialBindingId");
  const rootPath = normalizeRootPrefix(fields.rootPath);
  const rootId = rootPath.length === 0 ? "/" : rootPath;
  return {
    accountId: fields.credentialBindingId,
    driveId: fields.containerId,
    vaultFolderId: rootId,
    filesRootId: rootId,
    providerKind: fields.providerKind,
    endpointId: fields.endpointId,
    containerId: fields.containerId,
    rootPath,
    credentialBindingId: fields.credentialBindingId,
  };
}

function requireNonEmptyScopeField(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw s3ProtocolError(`S3 scope field "${field}" must be a non-empty string`);
  }
}

async function hashPrefix(value: string, length: number): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(value).buffer);
  return digest.slice(0, length);
}

/** `<root>/.easy-sync/scope.json` 的内容。字段顺序固定，便于逐字节比较。 */
export interface S3ScopeMarkerV1 {
  readonly schemaVersion: 1;
  readonly providerKind: "s3";
  readonly vaultName: string;
  readonly scopeId: string;
  readonly createdAt: string;
}

export interface BuildS3ScopeMarkerInput {
  readonly vaultName: string;
  readonly scopeId: string;
  readonly createdAt?: Date;
}

export function buildS3ScopeMarker(input: BuildS3ScopeMarkerInput): S3ScopeMarkerV1 {
  const vaultName = input.vaultName.trim();
  if (vaultName.length === 0) throw s3ProtocolError("Vault name is required for the S3 scope marker");
  if (!/^[0-9a-f]{16,64}$/.test(input.scopeId)) {
    throw s3ProtocolError(`Invalid S3 scope id "${input.scopeId}"`);
  }
  return {
    schemaVersion: S3_SCOPE_SCHEMA_VERSION,
    providerKind: "s3",
    vaultName,
    scopeId: input.scopeId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

export function serializeS3ScopeMarker(marker: S3ScopeMarkerV1): string {
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

export function parseS3ScopeMarker(text: string): S3ScopeMarkerV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw s3ProtocolError("S3 scope marker is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw s3ProtocolError("S3 scope marker must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== S3_SCOPE_SCHEMA_VERSION) {
    throw s3ProtocolError(`Unsupported S3 scope marker schemaVersion ${String(record.schemaVersion)}`);
  }
  if (record.providerKind !== "s3") {
    throw s3ProtocolError(`S3 scope marker providerKind must be "s3"`);
  }
  const vaultName = record.vaultName;
  const scopeId = record.scopeId;
  const createdAt = record.createdAt;
  if (typeof vaultName !== "string" || vaultName.length === 0) {
    throw s3ProtocolError(`S3 scope marker field "vaultName" must be a non-empty string`);
  }
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    throw s3ProtocolError(`S3 scope marker field "scopeId" must be a non-empty string`);
  }
  if (typeof createdAt !== "string" || createdAt.length === 0) {
    throw s3ProtocolError(`S3 scope marker field "createdAt" must be a non-empty string`);
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw s3ProtocolError("S3 scope marker createdAt must be an ISO date");
  }
  return {
    schemaVersion: 1,
    providerKind: "s3",
    vaultName,
    scopeId,
    createdAt,
  };
}

/** `scope.json` 的远端 key。 */
export function s3ScopeMarkerKey(rootPath: string): string {
  return scopeMarkerKey(rootPath);
}

/** 探针/初始化写入 `scope.json` 前应使用的目录 key（尾 `/` 供 MKCOL/占位）。 */
export function s3ControlDirectoryKey(rootPath: string): string {
  const root = normalizeRootPrefix(rootPath);
  return root.length === 0
    ? `${S3_CONTROL_DIRECTORY}/`
    : `${root}/${S3_CONTROL_DIRECTORY}/`;
}

export type S3ScopeMarkerAction =
  | "initialize"
  | "accept"
  | "takeover-required"
  | "refuse";

export interface S3ScopeMarkerDecision {
  readonly action: S3ScopeMarkerAction;
  readonly reason: string;
}

export interface S3LocalScopeIdentity {
  readonly scopeId: string;
  readonly vaultName: string;
  /** 本地是否已有同步状态（baseline／ledger 等）。 */
  readonly localStatePresent: boolean;
}

/**
 * 决定远端标记与本地 scope 的关系：
 *
 * - 没有标记 ⇒ 允许初始化；
 * - scopeId 与 vaultName 都相同 ⇒ 接受；
 * - scopeId 相同但 vaultName 不同 ⇒ 拒绝（另一个库占用同一远端根）；
 * - vaultName 相同但 scopeId 不同 ⇒ 需要显式「接管」确认（换账号／端点）；
 * - 两者都不同 ⇒ 拒绝。
 */
export function decideS3ScopeMarker(
  existing: S3ScopeMarkerV1 | null,
  local: S3LocalScopeIdentity,
): S3ScopeMarkerDecision {
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

/**
 * 桶／前缀内已有非控制面对象时必须显式确认——桶根（rootPath 为空）同样适用，
 * 不能把别人的内容静默纳入对账。
 */
export function requiresExistingContentConfirmation(objectCount: number): boolean {
  return objectCount > 0;
}

// ---------------------------------------------------------------------------
// S0 远端根占用：create-only 初始化／读取／校验（注入 IO，不接引擎）
// ---------------------------------------------------------------------------

/** 初始化只需要标记 key 的 HEAD／GET／PUT 与内容探测 LIST。 */
export interface S3ScopeMarkerIo {
  head(key: string): Promise<{ readonly exists: boolean }>;
  /** GET 标记正文；不存在返回 null。读取失败应抛错，不能当成「没有标记」。 */
  readText(key: string): Promise<string | null>;
  /** create-only 写入；目标已存在返回 false 且不覆盖。 */
  writeCreateOnly(key: string, text: string): Promise<boolean>;
  /** 仅在用户显式确认「接管」后使用；控制面对象，不是用户内容。 */
  writeReplace(key: string, text: string): Promise<void>;
  /** 列出前缀下对象；`isTruncated` 为 true 时对象数至少是返回值长度。 */
  list(prefix: string, maxKeys: number): Promise<{
    readonly objects: readonly { readonly key: string; readonly size: number }[];
    readonly isTruncated: boolean;
  }>;
}

export type S3ScopeInitAction =
  | "initialize"
  | "accept"
  | "takeover-required"
  | "takeover"
  | "existing-content-confirm"
  | "refuse";

export interface S3ScopeInitInput {
  readonly io: S3ScopeMarkerIo;
  readonly rootPath: string;
  /** 本地准备写入的标记（已含 scopeId 与 vaultName）。 */
  readonly marker: S3ScopeMarkerV1;
  /** 本地是否已有同步状态（baseline／ledger 等）。 */
  readonly localStatePresent: boolean;
  /** 用户已显式确认「接管同名的另一个 scope」。 */
  readonly confirmTakeover?: boolean;
  /** 用户已显式确认「把前缀／桶根里已有内容纳入对账」。 */
  readonly confirmExistingContent?: boolean;
  /** 内容探测页大小；默认 1000（S3 ListObjectsV2 上限）。 */
  readonly maxKeys?: number;
}

export interface S3ScopeInitResult {
  readonly action: S3ScopeInitAction;
  /** 是否允许本轮生成写入计划；未确认的确认态一律 false。 */
  readonly mayWrite: boolean;
  readonly markerWritten: boolean;
  readonly markerKey: string;
  /** 前缀内非控制面对象数；LIST 截断时至少是这么多。 */
  readonly existingObjectCount: number;
  readonly reason: string;
}

/** 读取并校验远端标记；不存在返回 null，存在但不可解析则抛错。 */
export async function readS3ScopeMarker(
  io: Pick<S3ScopeMarkerIo, "head" | "readText">,
  rootPath: string,
): Promise<S3ScopeMarkerV1 | null> {
  const key = s3ScopeMarkerKey(rootPath);
  const head = await io.head(key);
  if (!head.exists) return null;
  const text = await io.readText(key);
  if (text === null) {
    throw s3ProtocolError("S3 scope marker exists but its body is unreadable");
  }
  return parseS3ScopeMarker(text);
}

/**
 * S0 根占用初始化：标记匹配即接受；不同库拒绝；同库换 scope 或前缀非空
 * 都需要显式确认，确认前零写入、零计划。
 */
export async function ensureS3ScopeMarker(
  input: S3ScopeInitInput,
): Promise<S3ScopeInitResult> {
  const markerKey = s3ScopeMarkerKey(input.rootPath);
  const local = {
    scopeId: input.marker.scopeId,
    vaultName: input.marker.vaultName,
    localStatePresent: input.localStatePresent,
  };
  let existing: S3ScopeMarkerV1 | null;
  try {
    existing = await readS3ScopeMarker(input.io, input.rootPath);
  } catch (error) {
    return initResult("refuse", false, false, markerKey, 0, describeError(error));
  }

  if (existing) {
    const decision = decideS3ScopeMarker(existing, local);
    if (decision.action === "accept") {
      return initResult("accept", true, false, markerKey, 0, decision.reason);
    }
    if (decision.action === "refuse") {
      return initResult("refuse", false, false, markerKey, 0, decision.reason);
    }
    if (decision.action !== "takeover-required") {
      return initResult("refuse", false, false, markerKey, 0, decision.reason);
    }
    if (input.confirmTakeover !== true) {
      return initResult("takeover-required", false, false, markerKey, 0, decision.reason);
    }
    try {
      await input.io.writeReplace(markerKey, serializeS3ScopeMarker(input.marker));
    } catch (error) {
      return initResult("refuse", false, false, markerKey, 0, describeError(error));
    }
    return initResult(
      "takeover",
      true,
      true,
      markerKey,
      0,
      "Remote marker was replaced after explicit takeover confirmation",
    );
  }

  const root = normalizeRootPrefix(input.rootPath);
  let existingObjectCount = 0;
  let truncated = false;
  try {
    const maxKeys = Number.isSafeInteger(input.maxKeys) && (input.maxKeys as number) > 0
      ? (input.maxKeys as number)
      : 1000;
    const page = await input.io.list(
      root.length === 0 ? "" : `${root}/`,
      maxKeys,
    );
    const content = page.objects.filter((object) => !isControlPlaneKey(root, object.key));
    existingObjectCount = content.length;
    truncated = page.isTruncated;
  } catch (error) {
    return initResult("refuse", false, false, markerKey, 0, describeError(error));
  }

  if (
    (requiresExistingContentConfirmation(existingObjectCount) || truncated)
    && input.confirmExistingContent !== true
  ) {
    return initResult(
      "existing-content-confirm",
      false,
      false,
      markerKey,
      existingObjectCount,
      truncated
        ? `The root prefix has at least ${existingObjectCount} listed object(s) and at least one more object is not listed; explicit confirmation is required`
        : `The root prefix already contains ${existingObjectCount} object(s); explicit confirmation is required`,
    );
  }

  let created: boolean;
  try {
    created = await input.io.writeCreateOnly(markerKey, serializeS3ScopeMarker(input.marker));
  } catch (error) {
    return initResult(
      "refuse",
      false,
      false,
      markerKey,
      existingObjectCount,
      describeError(error),
    );
  }
  if (!created) {
    // 另一个实例在探测与写入之间创建了标记：绝不覆盖，重读后重新判定。
    let raced: S3ScopeMarkerV1 | null;
    try {
      raced = await readS3ScopeMarker(input.io, input.rootPath);
    } catch (error) {
      return initResult("refuse", false, false, markerKey, existingObjectCount, describeError(error));
    }
    if (!raced) {
      return initResult(
        "refuse",
        false,
        false,
        markerKey,
        existingObjectCount,
        "S3 rejected the create-only marker write but no marker is readable",
      );
    }
    const decision = decideS3ScopeMarker(raced, local);
    if (decision.action === "accept") {
      return initResult("accept", true, false, markerKey, existingObjectCount, decision.reason);
    }
    if (decision.action === "takeover-required" && input.confirmTakeover === true) {
      try {
        await input.io.writeReplace(markerKey, serializeS3ScopeMarker(input.marker));
      } catch (error) {
        return initResult("refuse", false, false, markerKey, existingObjectCount, describeError(error));
      }
      return initResult(
        "takeover",
        true,
        true,
        markerKey,
        existingObjectCount,
        "Remote marker was replaced after explicit takeover confirmation",
      );
    }
    return initResult(
      decision.action === "takeover-required" ? "takeover-required" : "refuse",
      false,
      false,
      markerKey,
      existingObjectCount,
      decision.reason,
    );
  }

  return initResult(
    "initialize",
    true,
    true,
    markerKey,
    existingObjectCount,
    input.confirmExistingContent === true && (existingObjectCount > 0 || truncated)
      ? "Remote marker created after explicit existing-content confirmation"
      : "Remote marker created",
  );
}

function initResult(
  action: S3ScopeInitAction,
  mayWrite: boolean,
  markerWritten: boolean,
  markerKey: string,
  existingObjectCount: number,
  reason: string,
): S3ScopeInitResult {
  return { action, mayWrite, markerWritten, markerKey, existingObjectCount, reason };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
