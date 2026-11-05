import type { DriveItem } from "../onedrive/types";
import type {
  ContentVersionToken,
  ExternalItemId,
  StrongContentFingerprint,
  VersionToken,
  WeakContentFingerprint,
} from "./types";

/**
 * 远端节点（刀 5b 中性词汇，2026-11-02）：字段名保留历史名（id／parentId／
 * eTag／cTag／contentHash／quickXorHash），类型与注释改中性语义。词汇表
 * 指针：src/sync/sync-provider.ts 文件头。
 */
export interface RemoteNodeV2 {
  /** 条目身份（历史名 id；OneDrive 下实存 driveItem id）。 */
  id: ExternalItemId;
  /** 父条目身份（历史名 parentId）。 */
  parentId: ExternalItemId;
  name: string;
  kind: "file" | "folder";
  /** 版本令牌（历史名 eTag），If-Match 与三方比较的远端版本事实。 */
  eTag?: VersionToken;
  /** 内容版本令牌（历史名 cTag），rename/move 不变的次级令牌。 */
  cTag?: ContentVersionToken;
  size?: number;
  mtime?: number;
  /** 强内容指纹（历史名 contentHash，OneDrive sha256Hash 小写）。 */
  contentHash?: StrongContentFingerprint;
  /** 弱内容指纹（历史名 quickXorHash）：只证不同、不证相同。 */
  quickXorHash?: WeakContentFingerprint;
}

export interface RemoteIndexV2 {
  schemaVersion: 2;
  /** 文件根身份（历史字段语义不变；OneDrive 下为 files/ 内容根的稳定 ID，
   *  绝不是外层库夹）。与条目级身份（ExternalItemId）名异实同级。 */
  filesRootId: string;
  /** 集合状态令牌（历史名 cursorRevision）：换游标不算内容变化。 */
  cursorRevision: number;
  /** 集合状态令牌（历史名 deltaLink）：换游标不算内容变化。 */
  deltaLink: string | null;
  complete: true;
  itemsById: Record<string, RemoteNodeV2>;
}

export interface RemoteIndexProjectionV2 {
  index: RemoteIndexV2;
  pathById: Map<string, string>;
}

interface RemoteNodeProjectionV2 {
  nodeById: Map<string, RemoteNodeV2>;
  pathById: Map<string, string>;
}

/**
 * Project stable remote identities without first rebuilding a record-shaped
 * RemoteIndexV2. IndexedDB planner views use this entry directly from rows;
 * the committed-envelope adapter below preserves the existing public API.
 */
export function projectRemoteNodesV2(
  nodes: readonly RemoteNodeV2[],
  filesRootId: string,
): RemoteNodeProjectionV2 {
  const nodeById = new Map<string, RemoteNodeV2>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) {
      throw new Error(`Remote hierarchy duplicate identity: ${node.id}`);
    }
    nodeById.set(node.id, node);
  }

  const pathById = new Map<string, string>();
  const visiting = new Set<string>();
  const resolvePath = (id: string): string => {
    const cached = pathById.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error(`Remote hierarchy cycle: ${id}`);
    const node = nodeById.get(id);
    if (!node) throw new Error(`Remote hierarchy missing node: ${id}`);
    visiting.add(id);
    let path: string;
    if (node.parentId === filesRootId) path = node.name;
    else {
      const parent = nodeById.get(node.parentId);
      if (!parent || parent.kind !== "folder") {
        throw new Error(`Remote hierarchy missing parent: ${node.id}`);
      }
      path = `${resolvePath(parent.id)}/${node.name}`;
    }
    visiting.delete(id);
    pathById.set(id, path);
    return path;
  };
  const seen = new Map<string, string>();
  for (const id of nodeById.keys()) {
    const path = resolvePath(id);
    const normalized = path.normalize("NFC").toLocaleLowerCase("en-US");
    const existing = seen.get(normalized);
    if (existing && existing !== id) {
      throw new Error(`Remote hierarchy duplicate path: ${path}`);
    }
    seen.set(normalized, id);
  }
  return { nodeById, pathById };
}

/** Rebuild the only supported path projection from a committed identity index. */
export function projectRemoteIndexV2(index: RemoteIndexV2): Map<string, string> {
  return projectRemoteNodesV2(
    Object.values(index.itemsById),
    index.filesRootId,
  ).pathById;
}

/**
 * Translate one anchored path across a folder-location change: `path` sits at
 * or below `fromRoot` and moves with it to `toRoot`, so only the prefix is
 * replaced.
 *
 * The reducer's folder-move receipt assertion (`V2 folder move file projection
 * changed`) compares this result **byte-for-byte** against the moved folder's
 * committed remote projection, and the canonical plan layer has to answer the
 * same question before it emits the move (F29 切片 1, 2026-10-16) — so both
 * sides share this single implementation instead of keeping two copies that
 * could drift apart. Deliberately no normalization here: the comparison it
 * feeds is exact, and the callers decide what counts as "below".
 */
export function translateAnchoredPathV2(
  path: string,
  fromRoot: string,
  toRoot: string,
): string {
  if (path === fromRoot) return toRoot;
  return `${toRoot}${path.slice(fromRoot.length)}`;
}

/** Strictly below `root`, matched on the same NFC form the reducer's
 *  descendant test uses (`path` itself is not a descendant of `root`). */
export function isAnchoredDescendantV2(path: string, root: string): boolean {
  return path.normalize("NFC").startsWith(`${root.normalize("NFC")}/`);
}

/** Build and validate a staging identity index. No state is published here. */
export function buildRemoteIndexV2(
  items: DriveItem[],
  filesRootId: string,
  deltaLink: string | null,
  cursorRevision = 0,
): RemoteIndexProjectionV2 {
  const latest = new Map<string, DriveItem>();
  for (const item of items) latest.set(item.id, item);
  const nodes = new Map<string, RemoteNodeV2>();
  for (const item of latest.values()) {
    if (item.deleted) continue;
    if (!item.id || !item.name || !item.parentReference?.id || (!item.file && !item.folder)) {
      throw new Error(`Remote identity incomplete: ${item.id}`);
    }
    nodes.set(item.id, {
      id: item.id,
      parentId: item.parentReference.id,
      name: item.name,
      kind: item.folder ? "folder" : "file",
      eTag: item.eTag,
      cTag: item.cTag,
      size: item.size,
      mtime: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : undefined,
      contentHash: item.file?.hashes?.sha256Hash?.toLowerCase(),
      quickXorHash: item.file?.hashes?.quickXorHash,
    });
  }

  const index: RemoteIndexV2 = {
      schemaVersion: 2,
      filesRootId,
      cursorRevision,
      deltaLink,
      complete: true,
      itemsById: Object.fromEntries(nodes),
  };
  return { index, pathById: projectRemoteIndexV2(index) };
}
