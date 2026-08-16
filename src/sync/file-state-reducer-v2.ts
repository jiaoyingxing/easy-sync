import { projectRemoteIndexV2, type RemoteIndexV2, type RemoteNodeV2 } from "./remote-index-v2";
import {
  advanceRemoteIdentityLineageV2,
  validateEnvelope,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  sameSyncScope,
  type BaseFileEntry,
  type MutationAction,
  type MutationCheckpointV1,
  type MutationLedgerEntryV1,
  type MutationStateEffectV1,
  type ReceiptedRenameAnchorCollisionEvidenceV1,
  type RemoteFileEntry,
} from "./types";

export interface FileStatePathViewV2 {
  baseEntries: BaseFileEntry[];
  remoteEntries: RemoteFileEntry[];
}

export interface ReceiptedRenameAnchorCollisionV2 {
  evidence: ReceiptedRenameAnchorCollisionEvidenceV1;
  movedRemoteId: string;
  sourceAnchor: SyncAnchorV2;
  targetAnchor: SyncAnchorV2;
}

export interface RenameTargetAnchorCollisionV2 {
  movedRemoteId: string;
  sourceAnchor: SyncAnchorV2;
  targetAnchor: SyncAnchorV2;
}

export interface RenameTargetAnchorInspectionInputV2 {
  sourcePath: string;
  path: string;
  movedRemoteId: string;
  scope: SyncStateEnvelopeV2["scope"];
}

/** Detect a target anchor that would make every receipt for this rename
 * uncommittable. Executors use this as a zero-write preflight. */
export function inspectRenameTargetAnchorCollisionV2(
  envelope: SyncStateEnvelopeV2,
  input: Readonly<RenameTargetAnchorInspectionInputV2>,
): RenameTargetAnchorCollisionV2 | null {
  validateEnvelope(envelope);
  if (
    !input.sourcePath
    || input.sourcePath === input.path
    || !sameSyncScope(input.scope, envelope.scope)
  ) return null;
  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  if (
    pathById.get(input.movedRemoteId) !== input.sourcePath
    || findNodeIdByPath(pathById, input.path) !== undefined
  ) return null;
  const anchors = Object.values(envelope.anchors.byAnchorId);
  const sourceAnchor = anchors.find((anchor) =>
    anchor.remoteId === input.movedRemoteId
      && anchor.lastPath === input.sourcePath);
  const targetAnchor = anchors.find((anchor) =>
    anchor.lastPath === input.path
      && anchor.remoteId !== input.movedRemoteId);
  if (!sourceAnchor || !targetAnchor || sourceAnchor.anchorId === targetAnchor.anchorId) {
    return null;
  }
  return {
    movedRemoteId: input.movedRemoteId,
    sourceAnchor: structuredClone(sourceAnchor),
    targetAnchor: structuredClone(targetAnchor),
  };
}

/**
 * Recognize only the historical crash window where Graph accepted a remote
 * rename but its receipt cannot replace a different V2 anchor at the target.
 * This does not authorize recovery by itself; callers must still prove the
 * current local/path/Graph-ID facts before offering or executing a choice.
 */
export function inspectReceiptedRenameAnchorCollisionV2(
  envelope: SyncStateEnvelopeV2,
  ledgerEntry: Readonly<MutationLedgerEntryV1>,
): ReceiptedRenameAnchorCollisionV2 | null {
  validateEnvelope(envelope);
  const { intent, receipt } = ledgerEntry;
  if (
    intent.version !== 1
    || intent.action !== "renameRemote"
    || !intent.sourcePath
    || intent.sourcePath === intent.path
    || !intent.expectedLocal.exists
    || !intent.expectedRemote.exists
    || !receipt
    || receipt.operationId !== intent.operationId
    || !sameSyncScope(intent.scope, envelope.scope)
  ) return null;
  try {
    assertFileReceiptShape(
      intent.action,
      intent.path,
      intent.sourcePath,
      intent.stateEffect,
      receipt.checkpoint,
    );
  } catch {
    return null;
  }

  const base = receipt.checkpoint.baseUpserts[0];
  const moved = receipt.checkpoint.remoteUpserts[0];
  if (
    !base
    || !moved
    || moved.driveId !== intent.expectedRemote.driveId
    || moved.sha256Hash?.toLowerCase() !== base.hash.toLowerCase()
    || moved.size !== base.size
    || intent.expectedLocal.hash.toLowerCase() !== base.hash.toLowerCase()
    || intent.expectedLocal.size !== base.size
  ) return null;

  const preflight = inspectRenameTargetAnchorCollisionV2(envelope, {
    sourcePath: intent.sourcePath,
    path: intent.path,
    movedRemoteId: intent.expectedRemote.driveId,
    scope: intent.scope,
  });
  if (!preflight || preflight.movedRemoteId !== moved.driveId) return null;
  const originalAnchors = Object.values(envelope.anchors.byAnchorId);
  const sourceAnchor = preflight.sourceAnchor;
  const remainingAnchors = Object.fromEntries(
    originalAnchors
      .filter((anchor) => anchor.lastPath !== intent.sourcePath)
      .map((anchor) => [anchor.anchorId, anchor]),
  );
  const { prior, pathCollision } = findBaseUpsertAnchorContext(
    originalAnchors,
    remainingAnchors,
    intent.path,
    moved.driveId,
  );
  if (
    prior?.anchorId !== sourceAnchor.anchorId
    || !pathCollision
    || pathCollision.anchorId !== preflight.targetAnchor.anchorId
  ) return null;

  const staleRemoteIds = [...new Set([
    moved.driveId,
    pathCollision.remoteId,
  ].filter((id): id is string => Boolean(id)))].sort();
  return {
    evidence: {
      kind: "receipted-rename-target-anchor-collision",
      lifecycleEpoch: envelope.meta.lifecycleEpoch,
      sourceCommitSeq: envelope.meta.commitSeq,
      sourceAnchorId: sourceAnchor.anchorId,
      targetAnchorId: pathCollision.anchorId,
      staleRemoteIds,
    },
    movedRemoteId: moved.driveId,
    sourceAnchor: structuredClone(sourceAnchor),
    targetAnchor: structuredClone(pathCollision),
  };
}

/**
 * Pure V2 file-state reducer.
 *
 * It consumes an already durable V1 intent + receipt and derives the next
 * in-memory envelope. It never reads or writes the manifest, adapter, Vault,
 * Graph, or plugin data. Publication remains a separate transaction.
 */
export function reduceFileStateEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
  ledgerEntry: MutationLedgerEntryV1,
): SyncStateEnvelopeV2 {
  validateEnvelope(envelope);
  const { intent, receipt } = ledgerEntry;
  if (!receipt) throw new Error(`V2 reducer requires a completed receipt: ${intent.operationId}`);
  if (intent.version !== 1 || receipt.version !== 1) {
    throw new Error("V2 reducer received an unsupported mutation version");
  }
  if (receipt.operationId !== intent.operationId) {
    throw new Error(`V2 reducer receipt does not match intent: ${intent.operationId}`);
  }
  if (!sameSyncScope(intent.scope, envelope.scope)) {
    throw new Error("V2 reducer mutation scope does not match the committed envelope");
  }
  if (!Number.isFinite(receipt.completedAt)) {
    throw new Error("V2 reducer receipt completion time is invalid");
  }

  const checkpoint = receipt.checkpoint;
  assertFileReceiptShape(
    intent.action,
    intent.path,
    intent.sourcePath,
    intent.stateEffect,
    checkpoint,
  );
  const originalPathById = projectRemoteIndexV2(envelope.remoteIndex);
  const remoteDeletes = new Set(checkpoint.remoteDeletes);
  const nextItemsById: Record<string, RemoteNodeV2> = {
    ...envelope.remoteIndex.itemsById,
  };

  for (const path of checkpoint.remoteDeletes) {
    const nodeId = findNodeIdByPath(originalPathById, path);
    if (!nodeId) continue;
    if (nextItemsById[nodeId]?.kind !== "file") {
      throw new Error(`V2 file reducer cannot delete a folder: ${path}`);
    }
    delete nextItemsById[nodeId];
  }

  for (const entry of checkpoint.remoteUpserts) {
    applyRemoteUpsert(
      envelope.remoteIndex,
      nextItemsById,
      originalPathById,
      remoteDeletes,
      entry,
    );
  }

  const nextRemoteIndex: RemoteIndexV2 = {
    ...envelope.remoteIndex,
    itemsById: sortRecordByKey(nextItemsById),
  };
  const nextPathById = projectRemoteIndexV2(nextRemoteIndex);
  const originalAnchors = Object.values(envelope.anchors.byAnchorId);
  const nextAnchors: Record<string, SyncAnchorV2> = {
    ...envelope.anchors.byAnchorId,
  };

  for (const path of checkpoint.baseRemovals) {
    for (const anchor of Object.values(nextAnchors)) {
      if (anchor.lastPath === path) delete nextAnchors[anchor.anchorId];
    }
  }
  for (const base of checkpoint.baseUpserts) {
    applyBaseUpsert(
      nextRemoteIndex,
      nextPathById,
      originalAnchors,
      nextAnchors,
      base,
      intent.action,
      receipt.completedAt,
    );
  }

  const candidate: SyncStateEnvelopeV2 = {
    ...envelope,
    remoteIndex: nextRemoteIndex,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecordByKey(nextAnchors),
    },
  };
  if (sameFileState(envelope, candidate)) return envelope;

  const next: SyncStateEnvelopeV2 = {
    ...candidate,
    meta: {
      ...envelope.meta,
      commitSeq: envelope.meta.commitSeq + 1,
      committedAt: receipt.completedAt,
    },
  };
  validateEnvelope(next);
  return next;
}

/**
 * Validate only the durable, action-specific shape of one ordinary-file
 * receipt. This deliberately does not read or mutate an envelope, so reset
 * admission can reject malformed recovery evidence before changing authority.
 */
export function assertFileMutationReceiptShapeV1(
  ledgerEntry: Readonly<MutationLedgerEntryV1>,
): void {
  const { intent, receipt } = ledgerEntry;
  if (isFolderMutationIntentForReceiptValidation(intent)) {
    throw new Error("V2 file receipt validator received a folder mutation");
  }
  if (!receipt) return;
  if (intent.version !== 1 || receipt.version !== 1) {
    throw new Error("V2 reducer received an unsupported mutation version");
  }
  if (receipt.operationId !== intent.operationId) {
    throw new Error(`V2 reducer receipt does not match intent: ${intent.operationId}`);
  }
  if (!Number.isFinite(receipt.completedAt)) {
    throw new Error("V2 reducer receipt completion time is invalid");
  }
  assertFileReceiptShape(
    intent.action,
    intent.path,
    intent.sourcePath,
    intent.stateEffect,
    receipt.checkpoint,
  );
}

function isFolderMutationIntentForReceiptValidation(
  intent: MutationLedgerEntryV1["intent"],
): intent is Extract<MutationLedgerEntryV1["intent"], { version: 2 }> {
  return intent.version === 2;
}

/**
 * Derive the path-keyed read model used by executor-side lookups and
 * diagnostics from the authoritative V2 identity state.
 *
 * This is not a planner input or a second state source. Volatile download URLs
 * and UI pending state are deliberately not part of the committed envelope.
 */
export function projectFileStatePathViewV2(
  envelope: SyncStateEnvelopeV2,
): FileStatePathViewV2 {
  validateEnvelope(envelope);
  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  const remoteEntries = Object.values(envelope.remoteIndex.itemsById)
    .filter((node) => node.kind === "file")
    .map((node): RemoteFileEntry => ({
      path: pathById.get(node.id)!,
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
  const baseEntries = Object.values(envelope.anchors.byAnchorId)
    .map((anchor): BaseFileEntry => ({
      path: anchor.lastPath,
      hash: anchor.contentHash,
      size: anchor.size,
      eTag: anchor.remoteETag ?? "",
    }))
    .sort(comparePath);
  return { baseEntries, remoteEntries };
}

function applyRemoteUpsert(
  originalIndex: RemoteIndexV2,
  itemsById: Record<string, RemoteNodeV2>,
  originalPathById: Map<string, string>,
  remoteDeletes: Set<string>,
  entry: RemoteFileEntry,
): void {
  if (!entry.driveId) throw new Error(`V2 remote upsert is missing a drive id: ${entry.path}`);
  if (!entry.parentId) throw new Error(`V2 remote upsert is missing a parent id: ${entry.path}`);
  const { name, parentPath } = splitFilePath(entry.path);
  const workingIndex: RemoteIndexV2 = {
    ...originalIndex,
    itemsById,
  };
  const workingPathById = projectRemoteIndexV2(workingIndex);
  const occupiedId = findNodeIdByPath(workingPathById, entry.path);
  if (occupiedId && occupiedId !== entry.driveId) {
    throw new Error(`V2 remote upsert would replace another identity: ${entry.path}`);
  }

  const priorPath = originalPathById.get(entry.driveId);
  if (priorPath && priorPath !== entry.path && !remoteDeletes.has(priorPath)) {
    throw new Error(`V2 remote move is missing its source deletion: ${priorPath}`);
  }
  assertParentMatchesPath(workingIndex, workingPathById, entry.parentId, parentPath);

  itemsById[entry.driveId] = {
    id: entry.driveId,
    parentId: entry.parentId,
    name,
    kind: "file",
    eTag: entry.eTag,
    cTag: entry.cTag,
    size: entry.size,
    mtime: entry.mtime,
    contentHash: entry.sha256Hash?.toLowerCase(),
    quickXorHash: entry.quickXorHash,
  };
}

function assertFileReceiptShape(
  action: MutationAction,
  path: string,
  sourcePath: string | undefined,
  stateEffect: MutationStateEffectV1 | undefined,
  checkpoint: MutationCheckpointV1,
): void {
  if (
    (checkpoint.folderUpserts?.length ?? 0) > 0
    || (checkpoint.folderDeletes?.length ?? 0) > 0
    || (checkpoint.folderMoveHintRemovals?.length ?? 0) > 0
  ) {
    throw new Error(`V2 file receipt contains folder state: ${path}`);
  }
  const baseUpsertPaths = checkpoint.baseUpserts.map((entry) => entry.path);
  const remoteUpsertPaths = checkpoint.remoteUpserts.map((entry) => entry.path);
  const expectPaths = (
    actual: readonly string[],
    expected: readonly string[],
    label: string,
  ): void => {
    if (
      actual.length !== expected.length
      || actual.some((value, index) => value !== expected[index])
    ) {
      throw new Error(`V2 ${action} receipt has invalid ${label}: ${path}`);
    }
  };

  if (stateEffect === "local-only") {
    if (action !== "download" || !sourcePath) {
      throw new Error(`V2 local-only receipt is not a source-bound download: ${path}`);
    }
    expectPaths(baseUpsertPaths, [], "base upserts");
    expectPaths(checkpoint.baseRemovals, [], "base removals");
    expectPaths(remoteUpsertPaths, [], "remote upserts");
    expectPaths(checkpoint.remoteDeletes, [], "remote deletes");
    expectPaths(checkpoint.pendingConflictRemovals, [], "pending conflict removals");
    expectPaths(checkpoint.pendingDeleteRemovals, [], "pending delete removals");
    return;
  }
  if (stateEffect === "settlement-only") {
    if (
      sourcePath
      || !(action === "upload"
        || action === "download"
        || action === "deleteRemote"
        || action === "deleteLocal")
    ) {
      throw new Error(`V2 settlement-only receipt is not a single-path side choice: ${path}`);
    }
    expectPaths(baseUpsertPaths, [], "base upserts");
    expectPaths(checkpoint.baseRemovals, [], "base removals");
    expectPaths(remoteUpsertPaths, [], "remote upserts");
    expectPaths(checkpoint.remoteDeletes, [], "remote deletes");
    expectPaths(checkpoint.pendingConflictRemovals, [], "pending conflict removals");
    expectPaths(checkpoint.pendingDeleteRemovals, [], "pending delete removals");
    return;
  }
  if (stateEffect === "bundle-settlement") {
    if (sourcePath || !(action === "upload"
      || action === "download"
      || action === "deleteRemote"
      || action === "deleteLocal")) {
      throw new Error(`V2 bundle-settlement receipt has invalid action: ${path}`);
    }
    if (action === "download" || action === "upload") {
      expectPaths(baseUpsertPaths, [path], "base upserts");
      expectPaths(checkpoint.baseRemovals, [], "base removals");
      expectPaths(remoteUpsertPaths, [path], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, [], "remote deletes");
    } else {
      expectPaths(baseUpsertPaths, [], "base upserts");
      expectPaths(checkpoint.baseRemovals, [path], "base removals");
      expectPaths(remoteUpsertPaths, [], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, [path], "remote deletes");
    }
    expectPaths(checkpoint.pendingConflictRemovals, [], "pending conflict removals");
    expectPaths(checkpoint.pendingDeleteRemovals, [], "pending delete removals");
    return;
  }

  switch (action) {
    case "upload":
      expectPaths(baseUpsertPaths, [path], "base upserts");
      expectPaths(checkpoint.baseRemovals, sourcePath ? [sourcePath] : [], "base removals");
      expectPaths(remoteUpsertPaths, [path], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, sourcePath ? [sourcePath] : [], "remote deletes");
      return;
    case "download":
      expectPaths(baseUpsertPaths, [path], "base upserts");
      expectPaths(checkpoint.baseRemovals, [], "base removals");
      expectPaths(remoteUpsertPaths, [], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, [], "remote deletes");
      return;
    case "deleteRemote":
      expectPaths(baseUpsertPaths, [], "base upserts");
      expectPaths(checkpoint.baseRemovals, [path], "base removals");
      expectPaths(remoteUpsertPaths, [], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, [path], "remote deletes");
      return;
    case "deleteLocal":
      expectPaths(baseUpsertPaths, [], "base upserts");
      expectPaths(checkpoint.baseRemovals, [path], "base removals");
      expectPaths(remoteUpsertPaths, [], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, [], "remote deletes");
      return;
    case "renameRemote":
    case "moveLocal":
      if (!sourcePath) {
        throw new Error(`V2 ${action} receipt is missing its source path: ${path}`);
      }
      expectPaths(baseUpsertPaths, [path], "base upserts");
      expectPaths(checkpoint.baseRemovals, [sourcePath], "base removals");
      expectPaths(remoteUpsertPaths, [path], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, [sourcePath], "remote deletes");
      return;
    case "merge":
      if (baseUpsertPaths.length > 1 || baseUpsertPaths.some((entry) => entry !== path)) {
        throw new Error(`V2 merge receipt has invalid base upserts: ${path}`);
      }
      expectPaths(checkpoint.baseRemovals, [], "base removals");
      expectPaths(remoteUpsertPaths, [path], "remote upserts");
      expectPaths(checkpoint.remoteDeletes, [], "remote deletes");
      return;
  }
}

function applyBaseUpsert(
  remoteIndex: RemoteIndexV2,
  pathById: Map<string, string>,
  originalAnchors: SyncAnchorV2[],
  anchors: Record<string, SyncAnchorV2>,
  base: BaseFileEntry,
  action: MutationAction,
  completedAt: number,
): void {
  const remoteId = findNodeIdByPath(pathById, base.path);
  const remote = remoteId ? remoteIndex.itemsById[remoteId] : undefined;
  if (!remoteId || !remote || remote.kind !== "file") {
    throw new Error(`V2 base upsert has no remote file identity: ${base.path}`);
  }
  if (remote.eTag !== undefined && remote.eTag !== base.eTag) {
    throw new Error(`V2 base upsert remote version mismatch: ${base.path}`);
  }

  const { prior, pathCollision } = findBaseUpsertAnchorContext(
    originalAnchors,
    anchors,
    base.path,
    remoteId,
  );
  if (pathCollision && pathCollision.anchorId !== prior?.anchorId) {
    throw new Error(`V2 base upsert would replace another anchor: ${base.path}`);
  }
  for (const anchor of Object.values(anchors)) {
    if (anchor.remoteId === remoteId || anchor.lastPath === base.path) {
      delete anchors[anchor.anchorId];
    }
  }

  const anchorId = prior?.anchorId ?? `file:${remoteId}`;
  const preserveAncestor = prior?.contentHash === base.hash
    ? prior.ancestorHash
    : undefined;
  const confirmedBy = confirmationFor(action);
  const remoteIdentityLineage = advanceRemoteIdentityLineageV2(
    prior,
    {
      remoteId,
      path: base.path,
      contentHash: base.hash,
      size: base.size,
      remoteETag: base.eTag,
      confirmedAt: completedAt,
      confirmedBy,
    },
  );
  anchors[anchorId] = {
    anchorId,
    remoteId,
    lastPath: base.path,
    contentHash: base.hash,
    size: base.size,
    remoteETag: base.eTag,
    ...(remote.cTag ? { remoteCTag: remote.cTag } : {}),
    ancestorHash: preserveAncestor,
    ...(remoteIdentityLineage
      ? { remoteIdentityLineage }
      : {}),
    confirmedAt: completedAt,
    confirmedBy,
  };
}

function findBaseUpsertAnchorContext(
  originalAnchors: readonly SyncAnchorV2[],
  anchors: Readonly<Record<string, SyncAnchorV2>>,
  path: string,
  remoteId: string,
): { prior: SyncAnchorV2 | undefined; pathCollision: SyncAnchorV2 | undefined } {
  const prior = originalAnchors.find((anchor) => anchor.remoteId === remoteId)
    ?? originalAnchors.find((anchor) => anchor.lastPath === path);
  const pathCollision = Object.values(anchors).find(
    (anchor) => anchor.lastPath === path && anchor.remoteId !== remoteId,
  );
  return { prior, pathCollision };
}

function confirmationFor(action: MutationAction): SyncAnchorV2["confirmedBy"] {
  switch (action) {
    case "upload":
      return "upload-cas";
    case "download":
      return "download-cas";
    case "renameRemote":
    case "moveLocal":
      return "rename-cas";
    case "merge":
      return "merge-cas";
    case "deleteRemote":
    case "deleteLocal":
      return "equal-read";
  }
}

function assertParentMatchesPath(
  index: RemoteIndexV2,
  pathById: Map<string, string>,
  parentId: string,
  parentPath: string,
): void {
  if (parentPath === "") {
    if (parentId !== index.filesRootId) {
      throw new Error("V2 root file upsert has a non-root parent identity");
    }
    return;
  }
  const parent = index.itemsById[parentId];
  if (!parent || parent.kind !== "folder" || pathById.get(parentId) !== parentPath) {
    throw new Error(`V2 remote upsert parent does not match path: ${parentPath}`);
  }
}

function findNodeIdByPath(
  pathById: Map<string, string>,
  path: string,
): string | undefined {
  for (const [id, projectedPath] of pathById) {
    if (projectedPath === path) return id;
  }
  return undefined;
}

function splitFilePath(path: string): { parentPath: string; name: string } {
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`V2 file path is invalid: ${path}`);
  }
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { parentPath: "", name: path }
    : { parentPath: path.slice(0, separator), name: path.slice(separator + 1) };
}

function sameFileState(
  left: SyncStateEnvelopeV2,
  right: SyncStateEnvelopeV2,
): boolean {
  return sameSyncScope(left.scope, right.scope)
    && left.remoteIndex.schemaVersion === right.remoteIndex.schemaVersion
    && left.remoteIndex.filesRootId === right.remoteIndex.filesRootId
    && left.remoteIndex.cursorRevision === right.remoteIndex.cursorRevision
    && left.remoteIndex.deltaLink === right.remoteIndex.deltaLink
    && left.remoteIndex.complete === right.remoteIndex.complete
    && sameRecordRows(
      left.remoteIndex.itemsById,
      right.remoteIndex.itemsById,
    )
    && left.anchors.schemaVersion === right.anchors.schemaVersion
    && sameRecordRows(
      left.anchors.byAnchorId,
      right.anchors.byAnchorId,
    );
}

function sameRecordRows<T>(
  left: Record<string, T>,
  right: Record<string, T>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && rightKeys.every((key) => {
      const leftValue = left[key];
      const rightValue = right[key];
      return leftValue !== undefined
        && rightValue !== undefined
        && (
          leftValue === rightValue
          || JSON.stringify(leftValue) === JSON.stringify(rightValue)
        );
    });
}

function sortRecordByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
