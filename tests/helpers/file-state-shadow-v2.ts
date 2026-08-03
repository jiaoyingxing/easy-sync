import { projectFileStatePathViewV2 } from "../../src/sync/file-state-reducer-v2";
import { projectRemoteIndexV2, type RemoteNodeV2 } from "../../src/sync/remote-index-v2";
import {
  validateEnvelope,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "../../src/sync/state-envelope-v2";
import type {
  BaseFileEntry,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncScope,
} from "../../src/sync/types";

export interface FileStateShadowSeedV2 {
  scope: SyncScope;
  lifecycleEpoch: number;
  commitSeq: number;
  committedAt: number;
  remoteEntries: RemoteFileEntry[];
  remoteFolders: RemoteFolderEntry[];
  baseEntries: BaseFileEntry[];
}

export type FileStateShadowDifferenceKindV2 =
  | "base-count"
  | "base-entry"
  | "remote-count"
  | "remote-entry";

export interface FileStateShadowComparisonV2 {
  status: "match" | "differences";
  counts: {
    baseV1: number;
    baseV2: number;
    remoteV1: number;
    remoteV2: number;
  };
  differenceKinds: FileStateShadowDifferenceKindV2[];
}

/** Build an in-memory V2 seed from the already committed V1 state. */
export function createFileStateShadowEnvelopeV2(
  input: FileStateShadowSeedV2,
): SyncStateEnvelopeV2 {
  const itemsById: Record<string, RemoteNodeV2> = {};
  for (const folder of input.remoteFolders) {
    assertUnusedRemoteId(itemsById, folder.driveId);
    itemsById[folder.driveId] = {
      id: folder.driveId,
      parentId: folder.parentId,
      name: folder.name,
      kind: "folder",
    };
  }
  for (const entry of input.remoteEntries) {
    if (!entry.driveId) throw new Error(`V2 shadow remote file is missing an id: ${entry.path}`);
    if (!entry.parentId) {
      throw new Error(`V2 shadow remote file is missing a parent id: ${entry.path}`);
    }
    assertUnusedRemoteId(itemsById, entry.driveId);
    itemsById[entry.driveId] = {
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
  }

  const remoteIndex = {
    schemaVersion: 2 as const,
    filesRootId: input.scope.filesRootId,
    cursorRevision: 0,
    deltaLink: null,
    complete: true as const,
    itemsById: sortRecordByKey(itemsById),
  };
  const pathById = projectRemoteIndexV2(remoteIndex);
  for (const folder of input.remoteFolders) {
    if (pathById.get(folder.driveId) !== folder.path) {
      throw new Error(`V2 shadow folder projection differs from V1: ${folder.path}`);
    }
  }
  const remoteIdByPath = new Map<string, string>();
  for (const entry of input.remoteEntries) {
    if (pathById.get(entry.driveId) !== entry.path) {
      throw new Error(`V2 shadow file projection differs from V1: ${entry.path}`);
    }
    remoteIdByPath.set(entry.path, entry.driveId);
  }

  const byAnchorId: Record<string, SyncAnchorV2> = {};
  for (const entry of input.baseEntries) {
    const remoteId = remoteIdByPath.get(entry.path);
    const anchorId = remoteId
      ? `shadow:${remoteId}`
      : `shadow-path:${entry.path}`;
    byAnchorId[anchorId] = {
      anchorId,
      remoteId,
      lastPath: entry.path,
      contentHash: entry.hash,
      size: entry.size,
      remoteETag: entry.eTag,
      confirmedAt: input.committedAt,
      confirmedBy: "equal-read",
    };
  }

  const envelope: SyncStateEnvelopeV2 = {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: input.lifecycleEpoch,
      commitSeq: Math.max(1, input.commitSeq),
      committedAt: input.committedAt,
    },
    scope: { ...input.scope },
    remoteIndex,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecordByKey(byAnchorId),
    },
  };
  validateEnvelope(envelope);
  return envelope;
}

export function compareFileStateShadowV2(
  envelope: SyncStateEnvelopeV2,
  v1: {
    baseEntries: BaseFileEntry[];
    remoteEntries: RemoteFileEntry[];
  },
): FileStateShadowComparisonV2 {
  const projected = projectFileStatePathViewV2(envelope);
  const normalizedV1Base = [...v1.baseEntries].sort(comparePath);
  const normalizedV1Remote = v1.remoteEntries.map(normalizeRemoteEntry).sort(comparePath);
  const normalizedV2Remote = projected.remoteEntries.map(normalizeRemoteEntry).sort(comparePath);
  const differenceKinds = new Set<FileStateShadowDifferenceKindV2>();

  if (normalizedV1Base.length !== projected.baseEntries.length) {
    differenceKinds.add("base-count");
  }
  if (normalizedV1Remote.length !== normalizedV2Remote.length) {
    differenceKinds.add("remote-count");
  }
  if (!sameArray(normalizedV1Base, projected.baseEntries)) {
    differenceKinds.add("base-entry");
  }
  if (!sameArray(normalizedV1Remote, normalizedV2Remote)) {
    differenceKinds.add("remote-entry");
  }

  return {
    status: differenceKinds.size === 0 ? "match" : "differences",
    counts: {
      baseV1: normalizedV1Base.length,
      baseV2: projected.baseEntries.length,
      remoteV1: normalizedV1Remote.length,
      remoteV2: normalizedV2Remote.length,
    },
    differenceKinds: [...differenceKinds],
  };
}

function normalizeRemoteEntry(entry: RemoteFileEntry): RemoteFileEntry {
  return {
    path: entry.path,
    driveId: entry.driveId,
    parentId: entry.parentId,
    size: entry.size,
    mtime: entry.mtime,
    eTag: entry.eTag,
    cTag: entry.cTag,
    sha256Hash: entry.sha256Hash?.toLowerCase(),
    quickXorHash: entry.quickXorHash,
  };
}

function assertUnusedRemoteId(
  itemsById: Record<string, RemoteNodeV2>,
  id: string,
): void {
  if (!id || itemsById[id]) throw new Error(`V2 shadow remote identity is duplicated: ${id}`);
}

function fileName(path: string): string {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) {
    throw new Error(`V2 shadow file path is invalid: ${path}`);
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

function sameArray(left: unknown[], right: unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
