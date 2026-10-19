/**
 * 本机独有条目记录（片② 写入；片④ 消费、片⑤ 联动）。
 *
 * One-way mode hands an edited path to the cloud version but keeps the local
 * bytes as a vault-visible copy (「副本」/“Copy”). The copy is a plain new local
 * file, so the durable correspondence between the original path and its copy
 * (and the category) cannot live in the sync baseline: the baseline is only
 * for paths both sides agree on, and the copy must stay a local-only file
 * (must-preserve: 被拦掉的动作不写基线). This module owns that record family
 * and the documented copy-name template; the StateManager owns persistence.
 *
 * Shape follows the StateManager key family (`schemaVersion` + `kind` + array,
 * imperative reduce, corrupt storage degrades instead of throwing) and stays
 * deliberately minimal: original path, copy path, category, time. No index.
 */

import type { LocalOnlyCopyKindV1 } from "./types";

const LOCAL_ONLY_COPIES_KIND = "local-only-copies";
const LOCAL_ONLY_COPIES_SCHEMA_VERSION = 1;

export interface LocalOnlyCopyEntryV1 {
  version: 1;
  /** 原路径：本机改动被云端版本接管的那个文件。 */
  path: string;
  /** 副本路径：本机那份改动所在的新文件。 */
  copyPath: string;
  /** 类别：有基线改动 / 无基线同名。 */
  kind: LocalOnlyCopyKindV1;
  /** 记录时间（副本落盘的那一次）。 */
  recordedAt: number;
}

/**
 * 片④ 新建类：无基线、云端也没有的本机文件（没有副本可留）。它与改动类同处
 * 一个键、一条读写路径——侧栏条目与计数只有一个真源。
 */
export interface LocalOnlyCreatedEntryV1 {
  version: 1;
  /** 文件路径（行主体就是文件本身）。 */
  path: string;
  /** 记录时间（该路径被本轮核对为本机独有的那一次）。 */
  recordedAt: number;
}

export interface LocalOnlyCopiesV1 {
  schemaVersion: typeof LOCAL_ONLY_COPIES_SCHEMA_VERSION;
  kind: typeof LOCAL_ONLY_COPIES_KIND;
  /** 改动类：原路径 ↔ 副本路径。 */
  entries: LocalOnlyCopyEntryV1[];
  /** 新建类：本机独有、无云端的文件。 */
  created: LocalOnlyCreatedEntryV1[];
}

export function emptyLocalOnlyCopiesV1(): LocalOnlyCopiesV1 {
  return {
    schemaVersion: LOCAL_ONLY_COPIES_SCHEMA_VERSION,
    kind: LOCAL_ONLY_COPIES_KIND,
    entries: [],
    created: [],
  };
}

/**
 * Read the record family from plugin data. A missing container is the empty
 * family (fresh installs); anything that is not this exact container shape
 * degrades to `null` so a corrupt record can never fail the state load.
 * Individual malformed entries inside a valid container are dropped.
 */
export function readLocalOnlyCopiesV1(value: unknown): LocalOnlyCopiesV1 | null {
  if (value === undefined) return emptyLocalOnlyCopiesV1();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<LocalOnlyCopiesV1>;
  if (
    candidate.schemaVersion !== LOCAL_ONLY_COPIES_SCHEMA_VERSION
    || candidate.kind !== LOCAL_ONLY_COPIES_KIND
    || !Array.isArray(candidate.entries)
  ) {
    return null;
  }
  const entries: LocalOnlyCopyEntryV1[] = [];
  for (const raw of candidate.entries) {
    const entry = readLocalOnlyCopyEntryV1(raw);
    if (entry) entries.push(entry);
  }
  const created: LocalOnlyCreatedEntryV1[] = [];
  // 片④ 之前的记录没有 created 数组：缺省按空处理（向后兼容）。
  const rawCreated = candidate.created;
  if (rawCreated !== undefined && !Array.isArray(rawCreated)) return null;
  for (const raw of rawCreated ?? []) {
    const entry = readLocalOnlyCreatedEntryV1(raw);
    if (entry) created.push(entry);
  }
  return {
    schemaVersion: LOCAL_ONLY_COPIES_SCHEMA_VERSION,
    kind: LOCAL_ONLY_COPIES_KIND,
    entries,
    created,
  };
}

function readLocalOnlyCreatedEntryV1(
  value: unknown,
): LocalOnlyCreatedEntryV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<LocalOnlyCreatedEntryV1>;
  if (
    candidate.version !== 1
    || typeof candidate.path !== "string"
    || candidate.path.length === 0
    || typeof candidate.recordedAt !== "number"
    || !Number.isFinite(candidate.recordedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    path: candidate.path,
    recordedAt: candidate.recordedAt,
  };
}

function readLocalOnlyCopyEntryV1(value: unknown): LocalOnlyCopyEntryV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<LocalOnlyCopyEntryV1>;
  if (
    candidate.version !== 1
    || typeof candidate.path !== "string"
    || candidate.path.length === 0
    || typeof candidate.copyPath !== "string"
    || candidate.copyPath.length === 0
    || candidate.path === candidate.copyPath
    || (
      candidate.kind !== "edited"
      && candidate.kind !== "new-file-both-sides"
    )
    || typeof candidate.recordedAt !== "number"
    || !Number.isFinite(candidate.recordedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    path: candidate.path,
    copyPath: candidate.copyPath,
    kind: candidate.kind,
    recordedAt: candidate.recordedAt,
  };
}

/**
 * Imperative reduce: (原路径, 副本路径) is the identity, so a replayed append
 * of the same copy updates its timestamp instead of duplicating the record,
 * while a second copy of the same original path stays a second record
 * ("每次改动留一份、可留多份").
 */
export function upsertLocalOnlyCopyEntryV1(
  current: LocalOnlyCopiesV1 | null,
  entry: LocalOnlyCopyEntryV1,
): LocalOnlyCopiesV1 {
  const base = current ?? emptyLocalOnlyCopiesV1();
  const next = base.entries.map((candidate) => ({ ...candidate }));
  const index = next.findIndex((candidate) =>
    candidate.path === entry.path && candidate.copyPath === entry.copyPath);
  if (index >= 0) next[index] = { ...entry };
  else next.push({ ...entry });
  return { ...base, entries: next };
}

/**
 * 片④ 侧栏条目（单一真源）：改动类＝原路径（上传目标是副本），新建类＝文件
 * 本身。副本路径不再作为"本机新建"重复登记。
 */
export interface LocalOnlyEntryRowV1 {
  kind: "edited" | "created";
  /** 行主体路径（改动类＝原路径，新建类＝文件本身）。 */
  path: string;
  /** 「上传到云端」的目标文件。 */
  targetPath: string;
}

export function projectLocalOnlyEntryRowsV1(input: {
  copies: readonly LocalOnlyCopyEntryV1[];
  created: readonly LocalOnlyCreatedEntryV1[];
}): LocalOnlyEntryRowV1[] {
  const rows: LocalOnlyEntryRowV1[] = input.copies.map((entry) => ({
    kind: "edited" as const,
    path: entry.path,
    targetPath: entry.copyPath,
  }));
  const copyPaths = new Set(input.copies.map((entry) => entry.copyPath));
  for (const entry of input.created) {
    if (copyPaths.has(entry.path)) continue;
    rows.push({ kind: "created", path: entry.path, targetPath: entry.path });
  }
  return rows;
}

/** 记录族是否逐字段相同（用于跳过无变化的持久化写入）。 */
export function sameLocalOnlyFamilyV1(
  left: LocalOnlyCopiesV1,
  right: LocalOnlyCopiesV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 片④ 每轮核对（单向模式）：把"本机独有"这一事实写进同一个记录族。
 *
 * - 改动类的记录只在副本仍是本机独有文件时保留（副本被上传／改名／删除后，
 *   记录连同条目一起退场）；
 * - 新建类＝本机独有路径里**不属于任何副本**的那些（副本不得重复登记为本机
 *   新建），已存在的时间戳保留、消失的路径整条退场。
 */
export function reconcileLocalOnlyEntriesV1(
  current: LocalOnlyCopiesV1 | null,
  input: {
    localOnlyPaths: ReadonlySet<string>;
    now: number;
  },
): LocalOnlyCopiesV1 {
  const base = current ?? emptyLocalOnlyCopiesV1();
  const entries = base.entries
    .filter((entry) => input.localOnlyPaths.has(entry.copyPath))
    .map((entry) => ({ ...entry }));
  const copyPaths = new Set(entries.map((entry) => entry.copyPath));
  const recordedAtByPath = new Map(
    base.created.map((entry) => [entry.path, entry.recordedAt]),
  );
  const created = [...input.localOnlyPaths]
    .filter((path) => !copyPaths.has(path))
    .sort((left, right) => left.localeCompare(right))
    .map((path): LocalOnlyCreatedEntryV1 => ({
      version: 1,
      path,
      recordedAt: recordedAtByPath.get(path) ?? input.now,
    }));
  return { ...base, entries, created };
}

/** 上传成功／路径作废：按原路径与副本路径退场对应记录。 */
export function retireLocalOnlyEntriesV1(
  current: LocalOnlyCopiesV1 | null,
  input: {
    paths?: readonly string[];
    copyPaths?: readonly string[];
  },
): LocalOnlyCopiesV1 {
  const base = current ?? emptyLocalOnlyCopiesV1();
  const paths = new Set(input.paths ?? []);
  const copyPaths = new Set(input.copyPaths ?? []);
  return {
    ...base,
    entries: base.entries.filter((entry) =>
      !copyPaths.has(entry.copyPath) && !paths.has(entry.path)),
    created: base.created.filter((entry) => !paths.has(entry.path)),
  };
}

/**
 * Documented copy-name template
 * `{原名}（{标签} {yyyy-MM-dd HHmm}）{扩展名}` (2026-09-21「冲突副本」先例形状，
 * 标签用「副本」/“Copy”——设备中立：文件被带到其他设备后"本机"会失真；
 * 时分不加任何标点：`:` 不是合法 Windows 文件名字符，而库要同步到
 * Windows／安卓，`-`／`.` 也一律不用，避免与日期段混淆).
 * `changedAt` is the source time of the local
 * version, so the name is deterministic for one local version — a replay
 * reaches the same candidate name and reuses the copy instead of adding a
 * second one. `attempt` > 0 is the collision fallback: a taken name gets a
 * numeric suffix inside the parenthesis ("同分钟重名与既有文件重名都要防撞").
 */
export function localOnlyCopyPathV1(input: {
  path: string;
  label: string;
  changedAt: number;
  attempt?: number;
}): string {
  const attempt = Math.max(0, Math.trunc(input.attempt ?? 0));
  const separator = input.path.lastIndexOf("/");
  const directory = separator < 0 ? "" : input.path.slice(0, separator + 1);
  const baseName = input.path.slice(separator + 1);
  const dot = baseName.lastIndexOf(".");
  const stem = dot <= 0 ? baseName : baseName.slice(0, dot);
  const extension = dot <= 0 ? "" : baseName.slice(dot);
  const suffix = attempt === 0 ? "" : ` ${attempt + 1}`;
  return `${directory}${stem}（${input.label} ${localOnlyCopyStampV1(input.changedAt)}${suffix}）${extension}`;
}

function localOnlyCopyStampV1(changedAt: number): string {
  const at = Number.isFinite(changedAt) && changedAt > 0 ? changedAt : Date.now();
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}
