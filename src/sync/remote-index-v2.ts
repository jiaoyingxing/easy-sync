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

/** Rebuild the only supported path projection from a committed identity index. */
export function projectRemoteIndexV2(index: RemoteIndexV2): Map<string, string> {
  const pathById = new Map<string, string>();
  const visiting = new Set<string>();
  const resolvePath = (id: string): string => {
    const cached = pathById.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error(`Remote hierarchy cycle: ${id}`);
    const node = index.itemsById[id];
    if (!node) throw new Error(`Remote hierarchy missing node: ${id}`);
    visiting.add(id);
    let path: string;
    if (node.parentId === index.filesRootId) path = node.name;
    else {
      const parent = index.itemsById[node.parentId];
      if (!parent || parent.kind !== "folder") throw new Error(`Remote hierarchy missing parent: ${node.id}`);
      path = `${resolvePath(parent.id)}/${node.name}`;
    }
    visiting.delete(id);
    pathById.set(id, path);
    return path;
  };
  const seen = new Map<string, string>();
  for (const id of Object.keys(index.itemsById)) {
    const path = resolvePath(id);
    const normalized = path.normalize("NFC").toLocaleLowerCase();
    const existing = seen.get(normalized);
    if (existing && existing !== id) throw new Error(`Remote hierarchy duplicate path: ${path}`);
    seen.set(normalized, id);
  }
  return pathById;
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
