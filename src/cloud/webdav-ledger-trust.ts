/**
 * WebDAV 身份账本的「重建未确认」本地标记（W2b-2）。
 *
 * 账本只回答「这个远端路径属于哪个稳定身份」。设计 §13.6 要求的是另一件事：
 * **远端账本被重建后，在用户看到一次成功同步之前，不许把这份新身份当成已
 * 确认**。重建意味着 uuid 全部换新，此前基于 uuid 的跨设备改名／删除识别
 * 失去依据；此时若照旧自动删除本机文件，就是在没有证据的情况下删用户数据。
 *
 * 因此本模块不持久化「我同意过这份内容」，而是持久化**待确认状态**：
 *
 * - 启动引导真的重建了账本 ⇒ 写一条标记（`scopeId` ＋ 当时的账本摘要与强
 *   ETag，后两者只作排障证据）。
 * - 有标记的 scope 一律按未确认处理，直到**一轮真的成功**之后清除标记。
 * - 没有标记的 scope 按已确认处理：这是加入既有云端、或已确认过的设备，
 *   跨设备改名识别照常工作。
 *
 * 为什么不是「内容指纹必须一直匹配」：另一台设备每次改名／新增文件都会改变
 * 账本内容，若以内容相等为信任前提，需要识别的那次变化本身就会把信任打掉，
 * 跨设备改名识别会永远关闭。uuid 空间是否被重建，才是这里真正要区分的事，
 * 而重建只发生在引导阶段——由标记如实记录。
 *
 * 本模块零 I/O：只做内存校验与比较，读写由调用方经端口完成。
 */
import { sha256Hex } from "../crypto";

const MARKER_KIND = "webdav-ledger-rebuild-pending";
const SCHEMA_VERSION = 1;
const SCOPE_ID_PATTERN = /^[0-9a-f]{16,64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** 强 ETag 只作为证据保存，除长度截断外不做任何解读。 */
const MAX_ETAG_LENGTH = 512;

/** 判定未确认状态所需的最小账本事实（结构类型，避免依赖 provider 模块）。 */
interface WebDavLedgerPendingFacts {
  readonly state: string;
  readonly canUpdate: boolean;
  readonly ledger: { readonly entries: Readonly<Record<string, string>> } | null;
}

/**
 * 一条「重建未确认」标记。
 *
 * `entriesDigest`／`eTag` 是重建当时的证据，不参与判定：判定只看
 * `scopeId`——同一云端根上有未确认的重建，就必须等一次成功同步。
 */
export interface WebDavLedgerRebuildMarkerV1 {
  readonly schemaVersion: 1;
  readonly kind: "webdav-ledger-rebuild-pending";
  /** 五字段 scope 折叠出的 scopeId（`buildWebDavScopeId`）。 */
  readonly scopeId: string;
  /** 重建那一刻账本 uuid→path 全量内容的 SHA-256（证据）。 */
  readonly entriesDigest: string;
  /** 重建后回读到的强 ETag；空串表示当时没有可用 ETag（证据）。 */
  readonly eTag: string;
  /** 记录时间（毫秒时间戳）。 */
  readonly recordedAt: number;
}

/**
 * 账本内容的稳定摘要（证据字段）。
 *
 * 按 uuid 升序拼接 `uuid\0path\n`：与序列化器同一排序口径，不依赖对象键
 * 插入顺序，也不受 `updatedAt` 影响。
 */
async function entriesDigest(
  entries: Readonly<Record<string, string>>,
): Promise<string> {
  const ids = Object.keys(entries).sort();
  let material = "";
  for (const id of ids) {
    material += `${id}\u0000${entries[id] ?? ""}\n`;
  }
  return await sha256Hex(new TextEncoder().encode(material).buffer);
}

/**
 * 用刚重建出来的账本生成标记。调用方必须是「真的重建了」（远端原本缺失／
 * 损坏）这一种情况；正常读到的 verified 账本不得写标记，否则会把已自洽的
 * 设备错判成待确认。
 */
export async function createWebDavLedgerRebuildMarker(input: {
  readonly scopeId: string;
  readonly entries: Readonly<Record<string, string>>;
  readonly eTag: string | null;
  readonly now: number;
}): Promise<WebDavLedgerRebuildMarkerV1> {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: MARKER_KIND,
    scopeId: input.scopeId,
    entriesDigest: await entriesDigest(input.entries),
    eTag: (input.eTag ?? "").trim().slice(0, MAX_ETAG_LENGTH),
    recordedAt: Number.isFinite(input.now) ? Math.max(0, Math.floor(input.now)) : 0,
  };
}

/**
 * 读取持久化值。任何异常形状都退回 null（＝没有待确认的重建）。
 *
 * 这里刻意「读不懂就当没有」：标记是**加严**闸门的记录，缺少它不会放开任何
 * 新的写权限——自动删除仍要用户自己开、身份推断仍要求远端 verified。
 */
export function readWebDavLedgerRebuildMarker(
  value: unknown,
): WebDavLedgerRebuildMarkerV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION) return null;
  if (record.kind !== MARKER_KIND) return null;
  if (typeof record.scopeId !== "string" || !SCOPE_ID_PATTERN.test(record.scopeId)) {
    return null;
  }
  const entriesDigestValue = typeof record.entriesDigest === "string"
    && DIGEST_PATTERN.test(record.entriesDigest)
    ? record.entriesDigest
    : "";
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: MARKER_KIND,
    scopeId: record.scopeId,
    entriesDigest: entriesDigestValue,
    eTag: typeof record.eTag === "string"
      ? record.eTag.slice(0, MAX_ETAG_LENGTH)
      : "",
    recordedAt: typeof record.recordedAt === "number"
      && Number.isFinite(record.recordedAt)
      ? Math.max(0, Math.floor(record.recordedAt))
      : 0,
  };
}

/**
 * 这份 scope 当前是否处于「重建未确认」。
 *
 * 只看标记归属的 scope：远端账本此刻是否 verified 不改变结论——未确认讲的是
 * 「本机还没见过一次成功同步」，不是「远端正不正常」。
 */
export function isWebDavLedgerRebuildPending(input: {
  readonly marker: WebDavLedgerRebuildMarkerV1 | null;
  readonly scopeId: string;
}): boolean {
  const { marker, scopeId } = input;
  if (!marker) return false;
  return marker.scopeId === scopeId;
}

/**
 * 是否可以按「已确认」使用远端 verified 账本做身份推断。
 *
 * 三条件必须同时成立：没有待确认的重建、远端账本 `verified` 且条件写可用、
 * 账本内容可读。只读账本（弱 ETag／无条件写）证明不了身份事实能被条件写
 * 保护，不参与自动改名与自动删除。
 */
export function mayTrustWebDavLedger(input: {
  readonly marker: WebDavLedgerRebuildMarkerV1 | null;
  readonly facts: WebDavLedgerPendingFacts;
  readonly scopeId: string;
}): boolean {
  if (isWebDavLedgerRebuildPending({ marker: input.marker, scopeId: input.scopeId })) {
    return false;
  }
  const { facts } = input;
  return facts.state === "verified" && facts.canUpdate && facts.ledger !== null;
}
