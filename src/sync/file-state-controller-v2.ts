import { projectFileStatePathViewV2 } from "./file-state-reducer-v2";
import {
  projectRemoteIndexV2,
  type RemoteIndexV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import {
  advanceRemoteIdentityLineageV2,
  validateEnvelope,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  sameSyncScope,
  type BaseFileEntry,
  type RemoteFileEntry,
  type RemoteFolderEntry,
  type SyncScope,
} from "./types";

export interface StatePathViewV2 {
  baseEntries: BaseFileEntry[];
  remoteEntries: RemoteFileEntry[];
  remoteFolders: RemoteFolderEntry[];
  deltaLink: string | null;
  scope: SyncScope;
}

export function projectStatePathViewV2(
  envelope: SyncStateEnvelopeV2,
): StatePathViewV2 {
  const files = projectFileStatePathViewV2(envelope);
  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  const remoteFolders = Object.values(envelope.remoteIndex.itemsById)
    .filter((node) => node.kind === "folder")
    .map((node): RemoteFolderEntry => ({
      path: pathById.get(node.id)!,
      driveId: node.id,
      parentId: node.parentId,
      name: node.name,
      ...(node.eTag !== undefined ? { eTag: node.eTag } : {}),
    }))
    .sort(comparePath);
  return {
    ...files,
    remoteFolders,
    deltaLink: envelope.remoteIndex.deltaLink,
    scope: { ...envelope.scope },
  };
}

export function replaceRemoteStateEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
  input: {
    entries: RemoteFileEntry[];
    folders: RemoteFolderEntry[];
    deltaLink: string | null;
    scope: SyncScope;
    committedAt?: number;
  },
): SyncStateEnvelopeV2 {
  validateEnvelope(envelope);
  if (!sameSyncScope(envelope.scope, input.scope)) {
    throw new Error("V2 remote state scope does not match the committed envelope");
  }

  const itemsById: Record<string, RemoteNodeV2> = {};
  for (const folder of input.folders) {
    assertUnusedId(itemsById, folder.driveId);
    const candidate: RemoteNodeV2 = {
      id: folder.driveId,
      parentId: folder.parentId,
      name: folder.name,
      kind: "folder",
      ...(folder.eTag !== undefined ? { eTag: folder.eTag } : {}),
    };
    const current = envelope.remoteIndex.itemsById[folder.driveId];
    itemsById[folder.driveId] =
      current && sameRemoteNode(current, candidate)
        ? current
        : candidate;
  }
  for (const entry of input.entries) {
    if (!entry.driveId) throw new Error(`V2 remote file is missing an id: ${entry.path}`);
    if (!entry.parentId) throw new Error(`V2 remote file is missing a parent id: ${entry.path}`);
    assertUnusedId(itemsById, entry.driveId);
    const candidate: RemoteNodeV2 = {
      id: entry.driveId,
      parentId: entry.parentId,
      name: fileName(entry.path),
      kind: "file",
      eTag: entry.eTag,
      cTag: entry.cTag,
      size: entry.size,
      mtime: entry.mtime,
      contentHash: entry.sha256Hash?.toLowerCase(),
      quickXorHash: entry.quickXorHash,
    };
    const current = envelope.remoteIndex.itemsById[entry.driveId];
    itemsById[entry.driveId] =
      current && sameRemoteNode(current, candidate)
        ? current
        : candidate;
  }

  const nextRemoteIndex: RemoteIndexV2 = {
    schemaVersion: 2,
    filesRootId: envelope.scope.filesRootId,
    cursorRevision: envelope.remoteIndex.cursorRevision + 1,
    deltaLink: input.deltaLink,
    complete: true,
    itemsById: sortRecordByKey(itemsById),
  };
  assertRemoteProjectionMatches(nextRemoteIndex, input.entries, input.folders);
  if (sameRemoteState(envelope.remoteIndex, nextRemoteIndex)) return envelope;

  return withNextCommit(envelope, {
    ...envelope,
    remoteIndex: nextRemoteIndex,
  }, input.committedAt);
}

/**
 * Whether a freshly projected remote snapshot contains the exact same
 * identity/content facts as the committed envelope.
 *
 * The provider cursor is intentionally outside this comparison. A reviewed
 * plan may defer a cursor-only checkpoint, but it must still invalidate when
 * any file/folder identity, path, version, size, hash, or timestamp changes.
 */
export function remoteStateProjectionMatchesEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
  input: {
    entries: RemoteFileEntry[];
    folders: RemoteFolderEntry[];
    scope: SyncScope;
  },
): boolean {
  return replaceRemoteStateEnvelopeV2(envelope, {
    ...input,
    deltaLink: envelope.remoteIndex.deltaLink,
    committedAt: envelope.meta.committedAt,
  }) === envelope;
}

export function replaceBaseStateEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
  entries: BaseFileEntry[],
  committedAt = Date.now(),
): SyncStateEnvelopeV2 {
  validateEnvelope(envelope);
  const projected = projectFileStatePathViewV2(envelope).baseEntries;
  const normalizedEntries = [...entries].sort(comparePath);
  if (JSON.stringify(projected) === JSON.stringify(normalizedEntries)) return envelope;

  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  const remoteIdByPath = new Map<string, string>();
  for (const [id, path] of pathById) {
    if (envelope.remoteIndex.itemsById[id]?.kind === "file") {
      remoteIdByPath.set(path, id);
    }
  }
  const currentAnchors = Object.values(envelope.anchors.byAnchorId);
  const nextAnchors: Record<string, SyncAnchorV2> = {};

  for (const entry of normalizedEntries) {
    const anchor = createEqualReadAnchor(
      envelope,
      remoteIdByPath,
      currentAnchors,
      entry,
      committedAt,
    );
    nextAnchors[anchor.anchorId] = anchor;
  }

  return withNextCommit(envelope, {
    ...envelope,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecordByKey(nextAnchors),
    },
  }, committedAt);
}

export function upsertBaseStateEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
  entries: BaseFileEntry[],
  committedAt = Date.now(),
): SyncStateEnvelopeV2 {
  validateEnvelope(envelope);
  const currentByPath = new Map(
    projectFileStatePathViewV2(envelope).baseEntries.map((entry) => [entry.path, entry]),
  );
  const changedEntries = entries.filter(
    (entry) => !sameBaseEntry(currentByPath.get(entry.path), entry),
  );
  if (changedEntries.length === 0) return envelope;

  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  const remoteIdByPath = new Map<string, string>();
  for (const [id, path] of pathById) {
    if (envelope.remoteIndex.itemsById[id]?.kind === "file") {
      remoteIdByPath.set(path, id);
    }
  }
  const currentAnchors = Object.values(envelope.anchors.byAnchorId);
  const nextAnchors: Record<string, SyncAnchorV2> = {
    ...envelope.anchors.byAnchorId,
  };

  for (const entry of changedEntries) {
    const anchor = createEqualReadAnchor(
      envelope,
      remoteIdByPath,
      currentAnchors,
      entry,
      committedAt,
    );
    const prior = currentAnchors.find(
      (candidate) =>
        candidate.anchorId === anchor.anchorId
        || (anchor.remoteId !== undefined && candidate.remoteId === anchor.remoteId)
        || candidate.lastPath === entry.path,
    );
    const pathCollision = Object.values(nextAnchors).find(
      (candidate) =>
        candidate.lastPath === entry.path
        && candidate.anchorId !== prior?.anchorId,
    );
    if (pathCollision) {
      throw new Error(`V2 base state would replace another anchor: ${entry.path}`);
    }
    for (const candidate of Object.values(nextAnchors)) {
      if (
        candidate.anchorId === prior?.anchorId
        || (anchor.remoteId !== undefined && candidate.remoteId === anchor.remoteId)
        || candidate.lastPath === entry.path
      ) {
        delete nextAnchors[candidate.anchorId];
      }
    }
    nextAnchors[anchor.anchorId] = anchor;
  }

  return withNextCommit(envelope, {
    ...envelope,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecordByKey(nextAnchors),
    },
  }, committedAt);
}

/**
 * Attach locally verified common text to the exact base reconciliation that
 * produced it. The ancestor is part of the same authoritative checkpoint:
 * when the base projection itself is unchanged, attaching new evidence still
 * advances the envelope revision.
 */
export function attachBaseAncestorHashesV2(
  current: SyncStateEnvelopeV2,
  candidate: SyncStateEnvelopeV2,
  entries: readonly BaseFileEntry[],
  hashesByPath: Readonly<Record<string, string>>,
  committedAt = Date.now(),
): SyncStateEnvelopeV2 {
  validateEnvelope(current);
  validateEnvelope(candidate);
  if (!sameSyncScope(current.scope, candidate.scope)) {
    throw new Error("V2 ancestor state scope does not match the committed envelope");
  }
  if (Object.keys(hashesByPath).length === 0) return candidate;

  let nextAnchors = candidate.anchors.byAnchorId;
  let changed = false;
  for (const base of entries) {
    const hash = hashesByPath[base.path];
    if (hash !== base.hash) continue;
    const anchor = Object.values(nextAnchors).find(
      (entry) =>
        entry.lastPath === base.path
        && entry.contentHash === base.hash
        && entry.size === base.size
        && entry.remoteETag === base.eTag,
    );
    if (!anchor || anchor.ancestorHash === hash) continue;
    if (!changed) nextAnchors = { ...nextAnchors };
    nextAnchors[anchor.anchorId] = {
      ...anchor,
      ancestorHash: hash,
    };
    changed = true;
  }
  if (!changed) return candidate;
  const next: SyncStateEnvelopeV2 = {
    ...candidate,
    anchors: {
      ...candidate.anchors,
      byAnchorId: nextAnchors,
    },
  };
  if (candidate === current) {
    next.meta = {
      ...next.meta,
      commitSeq: current.meta.commitSeq + 1,
      committedAt,
    };
  }
  validateEnvelope(next);
  return next;
}

export function removeBaseStateEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
  paths: readonly string[],
  committedAt = Date.now(),
): SyncStateEnvelopeV2 {
  validateEnvelope(envelope);
  const removed = new Set(paths);
  const nextAnchors = Object.fromEntries(
    Object.entries(envelope.anchors.byAnchorId)
      .filter(([, anchor]) => !removed.has(anchor.lastPath)),
  );
  if (
    Object.keys(nextAnchors).length
    === Object.keys(envelope.anchors.byAnchorId).length
  ) {
    return envelope;
  }
  return withNextCommit(envelope, {
    ...envelope,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecordByKey(nextAnchors),
    },
  }, committedAt);
}

function createEqualReadAnchor(
  envelope: SyncStateEnvelopeV2,
  remoteIdByPath: ReadonlyMap<string, string>,
  currentAnchors: readonly SyncAnchorV2[],
  entry: BaseFileEntry,
  committedAt: number,
): SyncAnchorV2 {
  const remoteId = remoteIdByPath.get(entry.path);
  const prior = (remoteId
    ? currentAnchors.find((anchor) => anchor.remoteId === remoteId)
    : undefined)
    ?? currentAnchors.find((anchor) => anchor.lastPath === entry.path);
  if (!remoteId && !prior) {
    throw new Error(`V2 base state has no remote identity or prior anchor: ${entry.path}`);
  }
  const remote = remoteId ? envelope.remoteIndex.itemsById[remoteId] : undefined;
  if (remote && remote.kind !== "file") {
    throw new Error(`V2 base state points to a non-file identity: ${entry.path}`);
  }
  if (remote?.eTag !== undefined && remote.eTag !== entry.eTag) {
    throw new Error(`V2 base state remote version mismatch: ${entry.path}`);
  }
  const stableRemoteId = remoteId ?? prior?.remoteId;
  const anchorId = prior?.anchorId
    ?? (stableRemoteId ? `file:${stableRemoteId}` : `file-path:${entry.path}`);
  const remoteIdentityLineage = advanceRemoteIdentityLineageV2(
    prior,
    {
      remoteId: stableRemoteId,
      path: entry.path,
      contentHash: entry.hash,
      size: entry.size,
      remoteETag: entry.eTag,
      confirmedAt: committedAt,
      confirmedBy: "equal-read",
    },
  );
  return {
    anchorId,
    remoteId: stableRemoteId,
    lastPath: entry.path,
    contentHash: entry.hash,
    size: entry.size,
    remoteETag: entry.eTag,
    ancestorHash: prior?.contentHash === entry.hash
      ? prior.ancestorHash
      : undefined,
    ...(remoteIdentityLineage
      ? { remoteIdentityLineage }
      : {}),
    confirmedAt: committedAt,
    confirmedBy: "equal-read",
  };
}

function withNextCommit(
  previous: SyncStateEnvelopeV2,
  candidate: SyncStateEnvelopeV2,
  committedAt = Date.now(),
): SyncStateEnvelopeV2 {
  const next: SyncStateEnvelopeV2 = {
    ...candidate,
    meta: {
      ...previous.meta,
      commitSeq: previous.meta.commitSeq + 1,
      committedAt,
    },
  };
  validateEnvelope(next);
  return next;
}

function assertRemoteProjectionMatches(
  index: RemoteIndexV2,
  entries: RemoteFileEntry[],
  folders: RemoteFolderEntry[],
): void {
  const pathById = projectRemoteIndexV2(index);
  for (const entry of entries) {
    if (pathById.get(entry.driveId) !== entry.path) {
      throw new Error(`V2 remote file projection differs from input: ${entry.path}`);
    }
  }
  for (const folder of folders) {
    if (pathById.get(folder.driveId) !== folder.path) {
      throw new Error(`V2 remote folder projection differs from input: ${folder.path}`);
    }
  }
}

function sameRemoteState(left: RemoteIndexV2, right: RemoteIndexV2): boolean {
  if (
    left.filesRootId !== right.filesRootId
    || left.deltaLink !== right.deltaLink
  ) return false;
  const leftIds = Object.keys(left.itemsById);
  const rightIds = Object.keys(right.itemsById);
  return leftIds.length === rightIds.length
    && rightIds.every((id) => {
      const leftNode = left.itemsById[id];
      const rightNode = right.itemsById[id];
      return leftNode !== undefined
        && rightNode !== undefined
        && sameRemoteNode(leftNode, rightNode);
    });
}

function sameRemoteNode(
  left: RemoteNodeV2,
  right: RemoteNodeV2,
): boolean {
  return left.id === right.id
    && left.parentId === right.parentId
    && left.name === right.name
    && left.kind === right.kind
    && left.eTag === right.eTag
    && left.cTag === right.cTag
    && left.size === right.size
    && left.mtime === right.mtime
    && left.contentHash === right.contentHash
    && left.quickXorHash === right.quickXorHash;
}

function sameBaseEntry(
  left: BaseFileEntry | undefined,
  right: BaseFileEntry,
): boolean {
  return left?.path === right.path
    && left.hash === right.hash
    && left.size === right.size
    && left.eTag === right.eTag;
}

function assertUnusedId(itemsById: Record<string, RemoteNodeV2>, id: string): void {
  if (!id || itemsById[id]) throw new Error(`V2 remote identity is duplicated: ${id}`);
}

function fileName(path: string): string {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`V2 remote file path is invalid: ${path}`);
  }
  return path.slice(path.lastIndexOf("/") + 1);
}

function sortRecordByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
