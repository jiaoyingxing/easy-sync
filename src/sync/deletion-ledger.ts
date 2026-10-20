/**
 * 删除记录簿（文件版本找回刀一之二）：本设备每执行一次「删除云端内容」记一条
 * 可恢复线索。
 *
 * OneDrive 官方没有「列回收站」API，恢复只能靠 driveItem id —— 这个 id 只在删除
 * 发生的那一刻在手里，之后没有任何入口能再拿到。所以本设备每成功删掉一个云端
 * 对象，就记 `{ 远端 id, 路径, 时刻, 文件/文件夹 }` 一条，供后续「找回」入口据
 * 此发起恢复。官方回收站只留 30 天，记录簿的保留窗口与它对齐。
 *
 * 落点＝设备本地记录族（`data.json` 的一个键，不进 V2 信封、不进同步）：它天然
 * 是每台设备各自的记录、不属同步权威。形状与 `local-only-copies` 同族
 * （`schemaVersion` ＋ `kind` ＋ 数组，命令式 reduce，损坏降级不抛），代价＝没有
 * 状态提交的同事务保护——丢记录只会少一条可恢复线索，云端对象仍在回收站。
 *
 * 注释只写约束，不写叙事。
 */

const DELETION_LEDGER_KIND = "easy-sync-deletion-ledger";
const DELETION_LEDGER_SCHEMA_VERSION = 1;

/** 保留窗口：与 OneDrive 官方回收站一致（30 天）。 */
export const DELETION_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeletionLedgerEntryV1 {
  /** 远端 driveItem id：记录簿的身份，也是恢复时唯一可用的入口。 */
  remoteId: string;
  /** 删除发生时该对象的库内路径。 */
  path: string;
  /** 删除时刻（本机时间）。 */
  deletedAt: number;
  /** 文件／文件夹：文件夹级删除在回收站里是同一个 item。 */
  kind: "file" | "folder";
}

export interface DeletionLedgerV1 {
  schemaVersion: typeof DELETION_LEDGER_SCHEMA_VERSION;
  kind: typeof DELETION_LEDGER_KIND;
  entries: DeletionLedgerEntryV1[];
}

export function emptyDeletionLedgerV1(): DeletionLedgerV1 {
  return {
    schemaVersion: DELETION_LEDGER_SCHEMA_VERSION,
    kind: DELETION_LEDGER_KIND,
    entries: [],
  };
}

/**
 * Read the record family from plugin data. A missing container is the empty
 * family (fresh installs); anything that is not this exact container shape
 * degrades to `null` so a corrupt record can never fail the state load and the
 * store keeps an empty family. Individual malformed entries inside a valid
 * container are dropped.
 */
export function readDeletionLedgerV1(value: unknown): DeletionLedgerV1 | null {
  if (value === undefined) return emptyDeletionLedgerV1();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<DeletionLedgerV1>;
  if (
    candidate.schemaVersion !== DELETION_LEDGER_SCHEMA_VERSION
    || candidate.kind !== DELETION_LEDGER_KIND
    || !Array.isArray(candidate.entries)
  ) {
    return null;
  }
  const entries: DeletionLedgerEntryV1[] = [];
  for (const raw of candidate.entries) {
    const entry = readDeletionLedgerEntryV1(raw);
    if (entry) entries.push(entry);
  }
  return {
    schemaVersion: DELETION_LEDGER_SCHEMA_VERSION,
    kind: DELETION_LEDGER_KIND,
    entries,
  };
}

function readDeletionLedgerEntryV1(
  value: unknown,
): DeletionLedgerEntryV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<DeletionLedgerEntryV1>;
  if (
    typeof candidate.remoteId !== "string"
    || candidate.remoteId.length === 0
    || typeof candidate.path !== "string"
    || candidate.path.length === 0
    || typeof candidate.deletedAt !== "number"
    || !Number.isFinite(candidate.deletedAt)
    || (candidate.kind !== "file" && candidate.kind !== "folder")
  ) {
    return null;
  }
  return {
    remoteId: candidate.remoteId,
    path: candidate.path,
    deletedAt: candidate.deletedAt,
    kind: candidate.kind,
  };
}

/**
 * Imperative reduce: the remote id is the identity, so a replayed write of the
 * same deletion (a retried/recovered mutation on the same object) updates the
 * record instead of duplicating it.
 */
export function upsertDeletionLedgerEntryV1(
  current: DeletionLedgerV1 | null,
  entry: DeletionLedgerEntryV1,
): DeletionLedgerV1 {
  const base = current ?? emptyDeletionLedgerV1();
  const index = base.entries.findIndex(
    (candidate) => candidate.remoteId === entry.remoteId,
  );
  if (index < 0) {
    return { ...base, entries: [...base.entries, { ...entry }] };
  }
  if (sameDeletionLedgerEntryV1(base.entries[index], entry)) return base;
  const entries = base.entries.map((candidate) => ({ ...candidate }));
  entries[index] = { ...entry };
  return { ...base, entries };
}

/** 摘除窗口起点：早于它的记录已出官方回收站（或即将出）。 */
export function deletionLedgerCutoffV1(now: number): number {
  return now - DELETION_LEDGER_RETENTION_MS;
}

/**
 * Drop records that left the retention window (`deletedAt < cutoff`). Returns
 * the input family object unchanged when nothing expires, so callers can skip
 * the durable write.
 */
export function pruneDeletionLedgerV1(
  current: DeletionLedgerV1 | null,
  input: { now: number },
): DeletionLedgerV1 {
  const base = current ?? emptyDeletionLedgerV1();
  const cutoff = deletionLedgerCutoffV1(input.now);
  const entries = base.entries.filter((entry) => entry.deletedAt >= cutoff);
  if (entries.length === base.entries.length) return base;
  return { ...base, entries: entries.map((entry) => ({ ...entry })) };
}

function sameDeletionLedgerEntryV1(
  left: DeletionLedgerEntryV1,
  right: DeletionLedgerEntryV1,
): boolean {
  return left.remoteId === right.remoteId
    && left.path === right.path
    && left.deletedAt === right.deletedAt
    && left.kind === right.kind;
}

/** 记录族是否逐字段相同（用于跳过无变化的持久化写入）。 */
export function sameDeletionLedgerV1(
  left: DeletionLedgerV1,
  right: DeletionLedgerV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
