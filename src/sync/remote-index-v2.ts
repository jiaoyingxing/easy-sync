import type { DriveItem } from "../onedrive/types";

export interface RemoteNodeV2 {
  id: string;
  parentId: string;
  name: string;
  kind: "file" | "folder";
  eTag?: string;
  cTag?: string;
  size?: number;
  mtime?: number;
  contentHash?: string;
  quickXorHash?: string;
}

export interface RemoteIndexV2 {
  schemaVersion: 2;
  /** Stable OneDrive ID of the files/ content root, never the outer vault folder. */
  filesRootId: string;
  cursorRevision: number;
  deltaLink: string | null;
  complete: true;
  itemsById: Record<string, RemoteNodeV2>;
}

export interface RemoteIndexProjectionV2 {
  index: RemoteIndexV2;
  pathById: Map<string, string>;
}

export interface RemoteNodeProjectionV2 {
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
    const normalized = path.normalize("NFC").toLocaleLowerCase();
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
