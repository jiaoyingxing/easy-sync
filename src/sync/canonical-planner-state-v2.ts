import {
  projectRemoteNodesV2,
  type RemoteIndexV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import {
  validateEnvelope,
  type CommitMetaV2,
  type FolderAnchorV2,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import type {
  BaseFileEntry,
  RemoteFileEntry,
  SyncScope,
} from "./types";

export interface CanonicalPlannerStateRecordsV2 {
  meta: CommitMetaV2;
  scope: SyncScope;
  remoteIndex: Omit<RemoteIndexV2, "itemsById">;
  remoteNodes: readonly RemoteNodeV2[];
  fileAnchors: readonly SyncAnchorV2[];
  /** null means the committed generation predates folder-anchor initialization. */
  folderAnchors: readonly FolderAnchorV2[] | null;
}

/**
 * Read-only state graph consumed by the canonical candidate builder.
 *
 * It deliberately uses arrays and lookup maps rather than the persisted
 * record-shaped envelope. IndexedDB can therefore materialize planner facts
 * directly from object-store rows without hydrating SyncStateEnvelopeV2.
 */
export interface CanonicalPlannerStateV2 {
  version: 1;
  meta: Readonly<CommitMetaV2>;
  scope: Readonly<SyncScope>;
  remoteIndex: Readonly<Omit<RemoteIndexV2, "itemsById">>;
  remoteNodes: readonly Readonly<RemoteNodeV2>[];
  remoteNodeById: ReadonlyMap<string, Readonly<RemoteNodeV2>>;
  remotePathById: ReadonlyMap<string, string>;
  fileAnchors: readonly Readonly<SyncAnchorV2>[];
  fileAnchorById: ReadonlyMap<string, Readonly<SyncAnchorV2>>;
  folderAnchors: readonly Readonly<FolderAnchorV2>[] | null;
  folderAnchorById: ReadonlyMap<string, Readonly<FolderAnchorV2>>;
  folderAnchorByRemoteId: ReadonlyMap<string, Readonly<FolderAnchorV2>>;
  remoteFiles: readonly Readonly<RemoteFileEntry>[];
  baseFiles: readonly Readonly<BaseFileEntry>[];
}

export function canonicalPlannerStateFromEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
): CanonicalPlannerStateV2 {
  validateEnvelope(envelope);
  const { itemsById: _itemsById, ...remoteIndex } = envelope.remoteIndex;
  return createCanonicalPlannerStateV2({
    meta: envelope.meta,
    scope: envelope.scope,
    remoteIndex,
    remoteNodes: Object.values(envelope.remoteIndex.itemsById),
    fileAnchors: Object.values(envelope.anchors.byAnchorId),
    folderAnchors: envelope.folderAnchors
      ? Object.values(envelope.folderAnchors.byAnchorId)
      : null,
  });
}

export function createCanonicalPlannerStateV2(
  records: CanonicalPlannerStateRecordsV2,
): CanonicalPlannerStateV2 {
  assertPlannerHeader(records);
  const remoteNodes = [...records.remoteNodes]
    .sort((left, right) => compareText(left.id, right.id));
  const { nodeById, pathById } = projectRemoteNodesV2(
    remoteNodes,
    records.remoteIndex.filesRootId,
  );
  const fileAnchors = [...records.fileAnchors]
    .sort((left, right) => compareText(left.anchorId, right.anchorId));
  const fileAnchorById = uniqueMap(
    fileAnchors,
    (anchor) => anchor.anchorId,
    "file anchor",
  );
  const folderAnchors = records.folderAnchors === null
    ? null
    : [...records.folderAnchors]
      .sort((left, right) => compareText(left.anchorId, right.anchorId));
  const folderAnchorById = uniqueMap(
    folderAnchors ?? [],
    (anchor) => anchor.anchorId,
    "folder anchor",
  );
  const folderAnchorByRemoteId = uniqueMap(
    folderAnchors ?? [],
    (anchor) => anchor.remoteId,
    "folder remote identity",
  );
  const remoteFiles = remoteNodes
    .filter((node) => node.kind === "file")
    .map((node): RemoteFileEntry => ({
      path: requiredRemotePath(pathById, node.id),
      driveId: node.id,
      parentId: node.parentId,
      size: node.size ?? 0,
      mtime: node.mtime ?? 0,
      eTag: node.eTag ?? "",
      cTag: node.cTag ?? "",
      sha256Hash: node.contentHash,
      quickXorHash: node.quickXorHash,
    }))
    .sort(comparePath);
  const baseFiles = fileAnchors
    .map((anchor): BaseFileEntry => ({
      path: anchor.lastPath,
      hash: anchor.contentHash,
      size: anchor.size,
      eTag: anchor.remoteETag ?? "",
    }))
    .sort(comparePath);

  return {
    version: 1,
    meta: structuredClone(records.meta),
    scope: structuredClone(records.scope),
    remoteIndex: structuredClone(records.remoteIndex),
    remoteNodes,
    remoteNodeById: nodeById,
    remotePathById: pathById,
    fileAnchors,
    fileAnchorById,
    folderAnchors,
    folderAnchorById,
    folderAnchorByRemoteId,
    remoteFiles,
    baseFiles,
  };
}

function assertPlannerHeader(records: CanonicalPlannerStateRecordsV2): void {
  if (
    records.meta.schemaVersion !== 2
    || !Number.isSafeInteger(records.meta.lifecycleEpoch)
    || records.meta.lifecycleEpoch < 1
    || !Number.isSafeInteger(records.meta.commitSeq)
    || records.meta.commitSeq < 1
    || !Number.isFinite(records.meta.committedAt)
  ) {
    throw new Error("Canonical planner state commit metadata is invalid");
  }
  if (
    !records.scope.accountId
    || !records.scope.driveId
    || !records.scope.vaultFolderId
    || !records.scope.filesRootId
    || records.remoteIndex.schemaVersion !== 2
    || records.remoteIndex.filesRootId !== records.scope.filesRootId
    || !Number.isSafeInteger(records.remoteIndex.cursorRevision)
    || records.remoteIndex.cursorRevision < 0
    || records.remoteIndex.complete !== true
  ) {
    throw new Error("Canonical planner state scope or remote header is invalid");
  }
}

function uniqueMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (!key || result.has(key)) {
      throw new Error(`Canonical planner state has duplicate ${label}: ${key}`);
    }
    result.set(key, value);
  }
  return result;
}

function requiredRemotePath(
  pathById: ReadonlyMap<string, string>,
  remoteId: string,
): string {
  const path = pathById.get(remoteId);
  if (!path) {
    throw new Error(`Canonical planner state path is missing: ${remoteId}`);
  }
  return path;
}

function comparePath(
  left: Readonly<{ path: string }>,
  right: Readonly<{ path: string }>,
): number {
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
