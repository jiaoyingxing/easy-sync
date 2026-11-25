/**
 * S3 key ↔ 库内路径的映射与本地落盘安全判定（设计 §9.2）。
 *
 * S3 以 key 为代理身份：key 是 UTF-8 字节串，没有目录对象；本地用 `/` 分隔
 * 的路径表达同一棵树。两条容易出错的规则在这里集中处理：
 *
 * - NFC 归一后再比较；大小写／NFC 折叠后撞车的两个 key 必须 fail-closed，
 *   不能静默选一个（SC-19）；
 * - Windows 保留名、非法字符、段尾点／空格、`.`／`..`、空段、超长段都是
 *   「需改名的非法文件名」——既不落盘，也不删除远端、不重试写入。
 *
 * 本模块纯函数、无 IO。
 */
import { S3Error, s3ProtocolError } from "./s3-errors";

/** S3 key 的 UTF-8 字节上限（协议事实）。 */
export const MAX_S3_KEY_BYTES = 1024;
/** 单段 UTF-8 字节上限（与常见文件系统对齐）。 */
export const MAX_KEY_SEGMENT_BYTES = 255;
/** S3 控制命名空间目录名。 */
export const S3_CONTROL_DIRECTORY = ".easy-sync";

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const WINDOWS_ILLEGAL_CHARACTERS = /[:*?"<>|]/;

export type VaultSegmentProblem =
  | "reserved-name"
  | "illegal-character"
  | "trailing-dot-or-space"
  | "dot-segment"
  | "empty-segment"
  | "segment-too-long"
  | "key-too-long";

export interface VaultSegmentIssue {
  readonly segment: string;
  readonly problem: VaultSegmentProblem;
  readonly detail: string;
}

export interface VaultPathInspection {
  readonly ok: boolean;
  readonly issues: readonly VaultSegmentIssue[];
}

export interface S3PathCollision {
  /** 折叠后的身份（NFC + 小写）。 */
  readonly folded: string;
  /** 撞车的原始路径，按首次出现顺序。 */
  readonly paths: readonly string[];
}

/** 折叠路径身份：NFC + 小写；用于检测大小写／Unicode 等价冲突。 */
export function foldPathIdentity(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * 规范化根前缀：NFC、`\`→`/`、去前导与尾随 `/`。空串表示桶根。
 * `.easy-sync` 作为根会与控制命名空间撞车，直接拒绝。
 */
export function normalizeRootPrefix(root: string): string {
  const normalized = root
    .trim()
    .replace(/\\/g, "/")
    .normalize("NFC")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (normalized.length === 0) return "";
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw s3ProtocolError(`S3 root prefix "${root}" contains an empty segment`);
    }
    if (segment === "." || segment === "..") {
      throw s3ProtocolError(`S3 root prefix "${root}" contains a dot segment`);
    }
  }
  if (segments[0] === S3_CONTROL_DIRECTORY) {
    throw s3ProtocolError(`S3 root prefix cannot be the control directory "${S3_CONTROL_DIRECTORY}"`);
  }
  return normalized;
}

/** 库内相对路径 → NFC、`\`→`/`；不做 Windows 合法性判断。 */
export function normalizeVaultRelativePath(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC").replace(/^\/+/, "");
}

/** 本地相对路径 → S3 key。空路径返回根前缀本身（调用方不应上传根）。 */
export function vaultPathToKey(rootPrefix: string, relativePath: string): string {
  const root = normalizeRootPrefix(rootPrefix);
  const relative = normalizeVaultRelativePath(relativePath);
  if (relative.length === 0) return root;
  return root.length === 0 ? relative : `${root}/${relative}`;
}

/** S3 key → 本地相对路径；不在根前缀内或是控制对象时返回 null。 */
export function keyToRelativePath(rootPrefix: string, key: string): string | null {
  const root = normalizeRootPrefix(rootPrefix);
  // 远端 key 可能来自其它平台，先做 NFC 再比较与返回，保证与
  // `vaultPathToKey` 的反向同构（设计 §5.2）。
  const normalizedKey = key.normalize("NFC");
  if (isControlPlaneKey(root, normalizedKey)) return null;
  if (root.length === 0) return normalizedKey;
  const prefix = `${root}/`;
  if (normalizedKey === root) return null;
  if (!normalizedKey.startsWith(prefix)) return null;
  return normalizedKey.slice(prefix.length);
}

/** 控制命名空间（`<root>/.easy-sync/`）与根标记文件不是用户内容。 */
export function isControlPlaneKey(rootPrefix: string, key: string): boolean {
  const root = normalizeRootPrefix(rootPrefix);
  const controlPrefix = root.length === 0 ? `${S3_CONTROL_DIRECTORY}/` : `${root}/${S3_CONTROL_DIRECTORY}/`;
  if (key.startsWith(controlPrefix)) return true;
  const marker = root.length === 0 ? ".easy-sync-scope.json" : `${root}/.easy-sync-scope.json`;
  return key === marker;
}

/** 以 `/` 结尾且大小为 0 的对象是目录占位，不是文件也不是合成目录节点。 */
export function isDirectoryPlaceholderKey(key: string, size?: number): boolean {
  return key.endsWith("/") && (size === undefined || size === 0);
}

/** `<root>/.easy-sync/scope.json` 的 key。 */
export function scopeMarkerKey(rootPrefix: string): string {
  const root = normalizeRootPrefix(rootPrefix);
  return root.length === 0
    ? `${S3_CONTROL_DIRECTORY}/scope.json`
    : `${root}/${S3_CONTROL_DIRECTORY}/scope.json`;
}

/**
 * 检查一条本地相对路径能否安全落盘。返回所有问题，而不是第一个——界面要
 * 能一次告诉用户这条路径为什么需要改名。
 */
export function inspectVaultRelativePath(relativePath: string): VaultPathInspection {
  const path = relativePath.replace(/\\/g, "/").normalize("NFC");
  const issues: VaultSegmentIssue[] = [];
  if (path.length === 0) {
    issues.push({ segment: "", problem: "empty-segment", detail: "Path is empty" });
    return { ok: false, issues };
  }
  const keyBytes = new TextEncoder().encode(path).byteLength;
  if (keyBytes > MAX_S3_KEY_BYTES) {
    issues.push({
      segment: "",
      problem: "key-too-long",
      detail: `Path is ${keyBytes} UTF-8 bytes, above the S3 key limit of ${MAX_S3_KEY_BYTES}`,
    });
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      issues.push({ segment, problem: "empty-segment", detail: "Path contains an empty segment" });
      continue;
    }
    if (segment === "." || segment === "..") {
      issues.push({ segment, problem: "dot-segment", detail: `Segment "${segment}" is a dot segment` });
      continue;
    }
    if (WINDOWS_RESERVED_NAMES.test(segment)) {
      issues.push({ segment, problem: "reserved-name", detail: `Segment "${segment}" is a Windows reserved name` });
    }
    if (WINDOWS_ILLEGAL_CHARACTERS.test(segment)) {
      issues.push({
        segment,
        problem: "illegal-character",
        detail: `Segment "${segment}" contains a character that is illegal on Windows`,
      });
    }
    if (/[. ]$/.test(segment)) {
      issues.push({
        segment,
        problem: "trailing-dot-or-space",
        detail: `Segment "${segment}" ends with a dot or space`,
      });
    }
    const segmentBytes = new TextEncoder().encode(segment).byteLength;
    if (segmentBytes > MAX_KEY_SEGMENT_BYTES) {
      issues.push({
        segment,
        problem: "segment-too-long",
        detail: `Segment is ${segmentBytes} UTF-8 bytes, above ${MAX_KEY_SEGMENT_BYTES}`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** 找出折叠后撞车的路径组；没有撞车返回空数组。 */
export function findPathCollisions(paths: readonly string[]): S3PathCollision[] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const folded = foldPathIdentity(path);
    const group = groups.get(folded);
    if (group) group.push(path);
    else groups.set(folded, [path]);
  }
  const collisions: S3PathCollision[] = [];
  for (const [folded, group] of groups) {
    if (group.length > 1) collisions.push({ folded, paths: group });
  }
  return collisions;
}

/** 路径身份冲突：本轮不得生成删除计划（SC-19）。 */
export class S3PathConflictError extends S3Error {
  readonly collisions: readonly S3PathCollision[];

  constructor(collisions: readonly S3PathCollision[]) {
    const sample = collisions
      .slice(0, 3)
      .map((collision) => collision.paths.join(" / "))
      .join("; ");
    const error = s3ProtocolError(`S3 path identity collision: ${sample}`);
    super(error);
    this.name = "S3PathConflictError";
    this.collisions = collisions;
  }
}

/** 折叠后撞车即抛错；调用方把本轮索引标为 complete=false、零删除。 */
export function assertNoPathCollisions(paths: readonly string[]): void {
  const collisions = findPathCollisions(paths);
  if (collisions.length > 0) throw new S3PathConflictError(collisions);
}
