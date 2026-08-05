import {
  projectRemoteIndexV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  sameSyncScope,
  type FolderMutationIntentV2,
  type LocalFileEntry,
  type LocalFolderEntry,
  type MutationLedgerEntryV1,
  type RemoteFolderEntry,
} from "./types";

export type ScopeExpansionFolderAcceptanceV2 =
  | {
      status: "accepted";
      accepted: number;
      envelope: SyncStateEnvelopeV2;
    }
  | {
      status: "rejected";
      reason:
        | "local-folder-scan-incomplete"
        | "remote-identity-incomplete"
        | "local-path-missing"
        | "local-type-conflict"
        | "remote-identity-changed"
        | "folder-anchor-collision";
      accepted: 0;
      envelope: SyncStateEnvelopeV2;
    };

export type ConfirmedDescendantFolderRejectionReasonV2 =
  | "local-folder-scan-incomplete"
  | "remote-identity-incomplete"
  | "folder-anchors-uninitialized"
  | "local-topology-conflict"
  | "folder-anchor-collision";

export type ConfirmedDescendantFolderAcceptanceV2 =
  | {
      status: "accepted";
      accepted: number;
      evidenceFiles: number;
      envelope: SyncStateEnvelopeV2;
    }
  | {
      status: "rejected";
      reason: ConfirmedDescendantFolderRejectionReasonV2;
      accepted: 0;
      evidenceFiles: 0;
      envelope: SyncStateEnvelopeV2;
    };

/**
 * Accept a source-bound, user-authorized sync-scope expansion as V2 folder
 * identity only. This reducer has no Vault or Graph access and never creates a
 * mutation intent: all local and remote facts must already be complete.
 */
export function acceptScopeExpansionFolderAnchorsV2(input: {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  remoteIdentityComplete: boolean;
  authorizedFolders: readonly RemoteFolderEntry[];
  confirmedAt: number;
}): ScopeExpansionFolderAcceptanceV2 {
  validateEnvelope(input.envelope);
  const reject = (
    reason: Exclude<
      ScopeExpansionFolderAcceptanceV2,
      { status: "accepted" }
    >["reason"],
  ): ScopeExpansionFolderAcceptanceV2 => ({
    status: "rejected",
    reason,
    accepted: 0,
    envelope: input.envelope,
  });
  if (!input.localFolderScanComplete) {
    return reject("local-folder-scan-incomplete");
  }
  if (
    !input.remoteIdentityComplete
    || input.envelope.remoteIndex.complete !== true
  ) {
    return reject("remote-identity-incomplete");
  }
  if (!input.envelope.folderAnchors) {
    return reject("folder-anchor-collision");
  }

  const localFolders = new Set(
    input.localFolders.map((folder) => nfcPath(folder.path)),
  );
  const localFiles = new Set(
    input.localFiles.map((file) => identityPath(file.path)),
  );
  const remotePaths = projectRemoteIndexV2(input.envelope.remoteIndex);
  const currentAnchors = Object.values(
    input.envelope.folderAnchors.byAnchorId,
  );
  const additions: RemoteFolderEntry[] = [];
  const seenPaths = new Set<string>();
  const seenRemoteIds = new Set<string>();

  for (const authorized of [...input.authorizedFolders].sort(
    (left, right) =>
      pathDepth(left.path) - pathDepth(right.path)
      || left.path.localeCompare(right.path),
  )) {
    const pathKey = identityPath(authorized.path);
    if (
      seenPaths.has(pathKey)
      || seenRemoteIds.has(authorized.driveId)
    ) return reject("remote-identity-changed");
    seenPaths.add(pathKey);
    seenRemoteIds.add(authorized.driveId);
    if (!localFolders.has(nfcPath(authorized.path))) {
      return reject("local-path-missing");
    }
    if (localFiles.has(pathKey)) return reject("local-type-conflict");

    const node = input.envelope.remoteIndex.itemsById[authorized.driveId];
    if (
      !node
      || node.kind !== "folder"
      || remotePaths.get(authorized.driveId) !== authorized.path
      || node.parentId !== authorized.parentId
    ) return reject("remote-identity-changed");

    const exact = currentAnchors.find((anchor) =>
      anchor.remoteId === authorized.driveId
      && anchor.lastPath === authorized.path
      && anchor.parentRemoteId === authorized.parentId
    );
    if (exact) continue;
    if (currentAnchors.some((anchor) =>
      anchor.remoteId === authorized.driveId
      || identityPath(anchor.lastPath) === pathKey
    )) return reject("folder-anchor-collision");
    additions.push({
      ...authorized,
      ...(node.eTag !== undefined ? { eTag: node.eTag } : {}),
      ...(node.cTag !== undefined ? { cTag: node.cTag } : {}),
    });
  }

  if (additions.length === 0) {
    return {
      status: "accepted",
      accepted: 0,
      envelope: input.envelope,
    };
  }
  const nextCommitSeq = input.envelope.meta.commitSeq + 1;
  const nextAnchors = {
    ...input.envelope.folderAnchors.byAnchorId,
  };
  for (const folder of additions) {
    const anchorId = `folder:${folder.driveId}`;
    nextAnchors[anchorId] = {
      anchorId,
      remoteId: folder.driveId,
      lastPath: folder.path,
      parentRemoteId: folder.parentId,
      remoteETag: folder.eTag,
      confirmedGeneration: nextCommitSeq,
      confirmedAt: input.confirmedAt,
    };
  }
  const envelope: SyncStateEnvelopeV2 = {
    ...input.envelope,
    meta: {
      ...input.envelope.meta,
      commitSeq: nextCommitSeq,
      committedAt: input.confirmedAt,
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextAnchors),
    },
  };
  validateEnvelope(envelope);
  return {
    status: "accepted",
    accepted: additions.length,
    envelope,
  };
}

/**
 * Reconstruct missing ancestor folder anchors from already authoritative file
 * identity. A same-path folder is never sufficient evidence by itself: one of
 * its current descendants must still match the committed file anchor on local
 * bytes, remote identity/path and current remote content/version.
 *
 * This reducer is state-only. It never creates a Vault or Graph mutation and
 * leaves unrelated unknown or empty folders fail-closed.
 */
export function acceptConfirmedDescendantFolderAnchorsV2(input: {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  remoteIdentityComplete: boolean;
  includeFilePath?: (path: string) => boolean;
  includeFolderPath?: (path: string) => boolean;
  confirmedAt: number;
}): ConfirmedDescendantFolderAcceptanceV2 {
  validateEnvelope(input.envelope);
  const reject = (
    reason: ConfirmedDescendantFolderRejectionReasonV2,
  ): ConfirmedDescendantFolderAcceptanceV2 => ({
    status: "rejected",
    reason,
    accepted: 0,
    evidenceFiles: 0,
    envelope: input.envelope,
  });
  if (!input.localFolderScanComplete) {
    return reject("local-folder-scan-incomplete");
  }
  if (
    !input.remoteIdentityComplete
    || input.envelope.remoteIndex.complete !== true
  ) {
    return reject("remote-identity-incomplete");
  }
  if (!input.envelope.folderAnchors) {
    return reject("folder-anchors-uninitialized");
  }

  const includeFilePath = input.includeFilePath ?? (() => true);
  const includeFolderPath = input.includeFolderPath ?? (() => true);
  const localFiles = new Map<string, LocalFileEntry>();
  const localFolders = new Map<string, LocalFolderEntry>();
  for (const file of input.localFiles) {
    const key = identityPath(file.path);
    if (localFiles.has(key) || localFolders.has(key)) {
      return reject("local-topology-conflict");
    }
    localFiles.set(key, file);
  }
  for (const folder of input.localFolders) {
    const key = identityPath(folder.path);
    if (localFolders.has(key) || localFiles.has(key)) {
      return reject("local-topology-conflict");
    }
    localFolders.set(key, folder);
  }

  const remotePaths = projectRemoteIndexV2(input.envelope.remoteIndex);
  const currentAnchors = Object.values(
    input.envelope.folderAnchors.byAnchorId,
  );
  const additionsByRemoteId = new Map<string, RemoteFolderEntry>();
  const additionRemoteIdByPath = new Map<string, string>();
  let evidenceFiles = 0;

  for (const anchor of Object.values(input.envelope.anchors.byAnchorId)
    .sort((left, right) => left.lastPath.localeCompare(right.lastPath))) {
    if (!anchor.remoteId || !includeFilePath(anchor.lastPath)) continue;
    const local = localFiles.get(identityPath(anchor.lastPath));
    if (
      !local
      || nfcPath(local.path) !== nfcPath(anchor.lastPath)
      || local.hash !== anchor.contentHash
      || local.size !== anchor.size
    ) continue;
    const remote = input.envelope.remoteIndex.itemsById[anchor.remoteId];
    if (
      !remote
      || remote.kind !== "file"
      || remotePaths.get(remote.id) !== anchor.lastPath
      || remote.size !== anchor.size
      || !currentRemoteVersionMatchesAnchor(remote, anchor)
    ) continue;

    const candidateChain: RemoteFolderEntry[] = [];
    let expectedParentPath = parentPath(anchor.lastPath);
    let parentRemoteId = remote.parentId;
    let chainMatches = true;
    while (expectedParentPath !== "") {
      const parent = input.envelope.remoteIndex.itemsById[parentRemoteId];
      const localFolder = localFolders.get(identityPath(expectedParentPath));
      if (
        !parent
        || parent.kind !== "folder"
        || remotePaths.get(parent.id) !== expectedParentPath
        || !localFolder
        || nfcPath(localFolder.path) !== nfcPath(expectedParentPath)
        || !includeFolderPath(expectedParentPath)
      ) {
        chainMatches = false;
        break;
      }

      const exact = currentAnchors.find((folderAnchor) =>
        folderAnchor.remoteId === parent.id
        && folderAnchor.lastPath === expectedParentPath
        && folderAnchor.parentRemoteId === parent.parentId
      );
      if (!exact) {
        if (currentAnchors.some((folderAnchor) =>
          folderAnchor.remoteId === parent.id
          || identityPath(folderAnchor.lastPath)
            === identityPath(expectedParentPath)
        )) {
          return reject("folder-anchor-collision");
        }
        candidateChain.push({
          path: expectedParentPath,
          driveId: parent.id,
          parentId: parent.parentId,
          name: parent.name,
          ...(parent.eTag !== undefined ? { eTag: parent.eTag } : {}),
          ...(parent.cTag !== undefined ? { cTag: parent.cTag } : {}),
        });
      }
      expectedParentPath = parentPath(expectedParentPath);
      parentRemoteId = parent.parentId;
    }
    if (
      !chainMatches
      || parentRemoteId !== input.envelope.remoteIndex.filesRootId
    ) continue;

    for (const folder of candidateChain) {
      const pathKey = identityPath(folder.path);
      const existingById = additionsByRemoteId.get(folder.driveId);
      const existingIdAtPath = additionRemoteIdByPath.get(pathKey);
      if (
        (
          existingById
          && (
            existingById.path !== folder.path
            || existingById.parentId !== folder.parentId
          )
        )
        || (existingIdAtPath && existingIdAtPath !== folder.driveId)
      ) {
        return reject("folder-anchor-collision");
      }
      additionsByRemoteId.set(folder.driveId, folder);
      additionRemoteIdByPath.set(pathKey, folder.driveId);
    }
    if (candidateChain.length > 0) evidenceFiles++;
  }

  if (additionsByRemoteId.size === 0) {
    return {
      status: "accepted",
      accepted: 0,
      evidenceFiles: 0,
      envelope: input.envelope,
    };
  }
  const nextCommitSeq = input.envelope.meta.commitSeq + 1;
  const nextAnchors = {
    ...input.envelope.folderAnchors.byAnchorId,
  };
  for (const folder of [...additionsByRemoteId.values()].sort(
    (left, right) =>
      pathDepth(left.path) - pathDepth(right.path)
      || left.path.localeCompare(right.path),
  )) {
    const anchorId = `folder:${folder.driveId}`;
    nextAnchors[anchorId] = {
      anchorId,
      remoteId: folder.driveId,
      lastPath: folder.path,
      parentRemoteId: folder.parentId,
      remoteETag: folder.eTag,
      confirmedGeneration: nextCommitSeq,
      confirmedAt: input.confirmedAt,
    };
  }
  const envelope: SyncStateEnvelopeV2 = {
    ...input.envelope,
    meta: {
      ...input.envelope.meta,
      commitSeq: nextCommitSeq,
      committedAt: input.confirmedAt,
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextAnchors),
    },
  };
  validateEnvelope(envelope);
  return {
    status: "accepted",
    accepted: additionsByRemoteId.size,
    evidenceFiles,
    envelope,
  };
}

/**
 * Apply one durable V2 folder-create receipt to the shared identity envelope.
 *
 * The reducer has no Vault, Adapter or Graph access. Both create directions
 * converge on the same result: the remote folder identity is present in the
 * current index and a same-generation folder anchor binds it to the local
 * path.
 */
export function reduceFolderStateEnvelopeV2(
  envelope: SyncStateEnvelopeV2,
  ledgerEntry: MutationLedgerEntryV1,
): SyncStateEnvelopeV2 {
  validateEnvelope(envelope);
  const { intent, receipt } = ledgerEntry;
  if (!isFolderMutationIntent(intent)) {
    throw new Error(`V2 folder reducer received a non-folder intent: ${intent.operationId}`);
  }
  if (!receipt) {
    throw new Error(`V2 folder reducer requires a completed receipt: ${intent.operationId}`);
  }
  if (receipt.operationId !== intent.operationId) {
    throw new Error(`V2 folder reducer receipt does not match intent: ${intent.operationId}`);
  }
  if (!sameSyncScope(intent.scope, envelope.scope)) {
    throw new Error("V2 folder reducer mutation scope does not match the committed envelope");
  }
  if (!envelope.folderAnchors) {
    throw new Error("V2 folder reducer requires initialized folder anchors");
  }
  if (
    receipt.checkpoint.baseUpserts.length > 0
    || receipt.checkpoint.baseRemovals.length > 0
    || receipt.checkpoint.remoteUpserts.length > 0
    || receipt.checkpoint.remoteDeletes.length > 0
    || receipt.checkpoint.pendingConflictRemovals.length > 0
  ) {
    throw new Error(`V2 folder receipt contains file state: ${intent.path}`);
  }
  if (intent.action === "moveLocalFolder" || intent.action === "moveRemoteFolder") {
    return reduceFolderMove(envelope, ledgerEntry);
  }
  if (intent.action === "deleteLocalFolder" || intent.action === "deleteRemoteFolder") {
    return reduceFolderDelete(envelope, ledgerEntry);
  }

  const folderUpserts = receipt.checkpoint.folderUpserts ?? [];
  if (folderUpserts.length !== 1 || folderUpserts[0].path !== intent.path) {
    throw new Error(`V2 folder receipt must contain exactly one target folder: ${intent.path}`);
  }
  const upsert = folderUpserts[0];
  assertFolderReceiptMatchesIntent(intent, upsert);

  const originalPathById = projectRemoteIndexV2(envelope.remoteIndex);
  const occupied = [...originalPathById].find(
    ([, path]) => identityPath(path) === identityPath(upsert.path),
  );
  if (occupied && occupied[0] !== upsert.driveId) {
    throw new Error(`V2 folder upsert would replace another identity: ${upsert.path}`);
  }
  assertParentMatchesPath(envelope, upsert);

  const nextItemsById: Record<string, RemoteNodeV2> = {
    ...envelope.remoteIndex.itemsById,
    [upsert.driveId]: {
      id: upsert.driveId,
      parentId: upsert.parentId,
      name: upsert.name,
      kind: "folder",
      eTag: upsert.eTag,
      cTag: upsert.cTag,
    },
  };
  const nextRemoteIndex = {
    ...envelope.remoteIndex,
    itemsById: sortRecord(nextItemsById),
  };
  const projected = projectRemoteIndexV2(nextRemoteIndex);
  if (projected.get(upsert.driveId) !== upsert.path) {
    throw new Error(`V2 folder upsert projection differs from receipt: ${upsert.path}`);
  }

  const existingAnchor = Object.values(envelope.folderAnchors.byAnchorId).find(
    (anchor) => anchor.remoteId === upsert.driveId,
  );
  const existingNode = envelope.remoteIndex.itemsById[upsert.driveId];
  if (
    existingNode?.kind === "folder"
    && originalPathById.get(upsert.driveId) === upsert.path
    && existingNode.parentId === upsert.parentId
    && existingNode.name === upsert.name
    && existingNode.eTag === upsert.eTag
    && existingNode.cTag === upsert.cTag
    && existingAnchor?.lastPath === upsert.path
    && existingAnchor.parentRemoteId === upsert.parentId
    && existingAnchor.remoteETag === upsert.eTag
  ) {
    return envelope;
  }

  const nextCommitSeq = envelope.meta.commitSeq + 1;
  const nextAnchors = { ...envelope.folderAnchors.byAnchorId };
  for (const anchor of Object.values(nextAnchors)) {
    if (
      anchor.remoteId === upsert.driveId
      || identityPath(anchor.lastPath) === identityPath(upsert.path)
    ) {
      delete nextAnchors[anchor.anchorId];
    }
  }
  const prior = existingAnchor;
  const anchorId = prior?.anchorId ?? `folder:${upsert.driveId}`;
  const nextAnchor: FolderAnchorV2 = {
    anchorId,
    remoteId: upsert.driveId,
    lastPath: upsert.path,
    parentRemoteId: upsert.parentId,
    remoteETag: upsert.eTag,
    confirmedGeneration: nextCommitSeq,
    confirmedAt: receipt.completedAt,
  };
  nextAnchors[anchorId] = nextAnchor;

  const next: SyncStateEnvelopeV2 = {
    ...envelope,
    meta: {
      ...envelope.meta,
      commitSeq: nextCommitSeq,
      committedAt: receipt.completedAt,
    },
    remoteIndex: nextRemoteIndex,
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextAnchors),
    },
  };
  validateEnvelope(next);
  return next;
}

export function isFolderMutationIntent(
  intent: MutationLedgerEntryV1["intent"],
): intent is FolderMutationIntentV2 {
  return intent.version === 2
    && (intent.action === "createLocalFolder"
      || intent.action === "createRemoteFolder"
      || intent.action === "moveLocalFolder"
      || intent.action === "moveRemoteFolder"
      || intent.action === "deleteLocalFolder"
      || intent.action === "deleteRemoteFolder");
}

function reduceFolderMove(
  envelope: SyncStateEnvelopeV2,
  ledgerEntry: MutationLedgerEntryV1,
): SyncStateEnvelopeV2 {
  const intent = ledgerEntry.intent as FolderMutationIntentV2;
  const receipt = ledgerEntry.receipt!;
  if (!intent.sourcePath || !intent.folderId || !intent.expectedRemote.exists) {
    throw new Error(`V2 folder move intent is incomplete: ${intent.path}`);
  }
  const folderUpserts = receipt.checkpoint.folderUpserts ?? [];
  if (folderUpserts.length !== 1 || folderUpserts[0].path !== intent.path) {
    throw new Error(`V2 folder move receipt must contain exactly one target folder: ${intent.path}`);
  }
  const upsert = folderUpserts[0];
  if (
    upsert.driveId !== intent.folderId
    || upsert.driveId !== intent.expectedRemote.driveId
    || upsert.parentId !== intent.expectedParent.driveId
  ) {
    throw new Error(`V2 folder move receipt lost its committed identity: ${intent.path}`);
  }
  assertParentMatchesPath(envelope, upsert);

  const originalPathById = projectRemoteIndexV2(envelope.remoteIndex);
  const originalNode = envelope.remoteIndex.itemsById[upsert.driveId];
  if (!originalNode || originalNode.kind !== "folder") {
    throw new Error(`V2 folder move source identity is missing: ${intent.sourcePath}`);
  }
  const occupied = [...originalPathById].find(
    ([id, path]) => id !== upsert.driveId
      && identityPath(path) === identityPath(upsert.path),
  );
  if (occupied) {
    throw new Error(`V2 folder move would replace another identity: ${upsert.path}`);
  }

  const nextItemsById: Record<string, RemoteNodeV2> = {
    ...envelope.remoteIndex.itemsById,
    [upsert.driveId]: {
      ...originalNode,
      parentId: upsert.parentId,
      name: upsert.name,
      eTag: upsert.eTag,
      cTag: upsert.cTag,
    },
  };
  const nextRemoteIndex = {
    ...envelope.remoteIndex,
    itemsById: sortRecord(nextItemsById),
  };
  const nextPathById = projectRemoteIndexV2(nextRemoteIndex);
  if (nextPathById.get(upsert.driveId) !== upsert.path) {
    throw new Error(`V2 folder move projection differs from receipt: ${upsert.path}`);
  }

  const sourcePath = intent.sourcePath;
  const nextCommitSeq = envelope.meta.commitSeq + 1;
  const nextFolderAnchors = { ...envelope.folderAnchors!.byAnchorId };
  let movedFolderAnchors = 0;
  for (const anchor of Object.values(nextFolderAnchors)) {
    if (!isAtOrBelow(anchor.lastPath, sourcePath)) continue;
    const projectedPath = nextPathById.get(anchor.remoteId);
    const translated = translatePath(anchor.lastPath, sourcePath, intent.path);
    if (projectedPath !== translated) {
      throw new Error(`V2 folder move descendant projection changed: ${anchor.lastPath}`);
    }
    const node = nextRemoteIndex.itemsById[anchor.remoteId];
    if (!node || node.kind !== "folder") {
      throw new Error(`V2 folder move descendant identity is missing: ${anchor.lastPath}`);
    }
    nextFolderAnchors[anchor.anchorId] = {
      ...anchor,
      lastPath: translated,
      parentRemoteId: node.parentId,
      remoteETag: node.eTag,
      confirmedGeneration: nextCommitSeq,
      confirmedAt: receipt.completedAt,
    };
    movedFolderAnchors++;
  }
  if (movedFolderAnchors === 0) {
    const alreadyMoved = Object.values(nextFolderAnchors).some(
      (anchor) => anchor.remoteId === intent.folderId
        && anchor.lastPath === intent.path
        && anchor.parentRemoteId === upsert.parentId
        && anchor.remoteETag === upsert.eTag,
    );
    if (alreadyMoved) return envelope;
    throw new Error(`V2 folder move has no committed source anchor: ${intent.sourcePath}`);
  }

  const nextFileAnchors = { ...envelope.anchors.byAnchorId };
  for (const anchor of Object.values(nextFileAnchors)) {
    if (!isDescendant(anchor.lastPath, sourcePath)) continue;
    const translated = translatePath(anchor.lastPath, sourcePath, intent.path);
    if (!anchor.remoteId || nextPathById.get(anchor.remoteId) !== translated) {
      throw new Error(`V2 folder move file projection changed: ${anchor.lastPath}`);
    }
    nextFileAnchors[anchor.anchorId] = {
      ...anchor,
      lastPath: translated,
      confirmedAt: receipt.completedAt,
      confirmedBy: "folder-move-cas",
    };
  }

  const next: SyncStateEnvelopeV2 = {
    ...envelope,
    meta: {
      ...envelope.meta,
      commitSeq: nextCommitSeq,
      committedAt: receipt.completedAt,
    },
    remoteIndex: nextRemoteIndex,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextFileAnchors),
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextFolderAnchors),
    },
  };
  validateEnvelope(next);
  return next;
}

function reduceFolderDelete(
  envelope: SyncStateEnvelopeV2,
  ledgerEntry: MutationLedgerEntryV1,
): SyncStateEnvelopeV2 {
  const intent = ledgerEntry.intent as FolderMutationIntentV2;
  const receipt = ledgerEntry.receipt!;
  const deletes = receipt.checkpoint.folderDeletes ?? [];
  if (
    !intent.folderId
    || deletes.length !== 1
    || deletes[0].driveId !== intent.folderId
    || deletes[0].path !== intent.path
  ) {
    throw new Error(`V2 folder delete receipt is incomplete: ${intent.path}`);
  }
  const nextItemsById = { ...envelope.remoteIndex.itemsById };
  const descendantFileAnchors = Object.values(envelope.anchors.byAnchorId).filter(
    (anchor) => isDescendant(anchor.lastPath, intent.path),
  );
  const descendantFolderAnchors = Object.values(
    envelope.folderAnchors!.byAnchorId,
  ).filter(
    (anchor) => anchor.remoteId !== intent.folderId
      && isDescendant(anchor.lastPath, intent.path),
  );
  if (
    descendantFileAnchors.some(
      (anchor) => !anchor.remoteId || nextItemsById[anchor.remoteId] !== undefined,
    )
    || descendantFolderAnchors.some(
      (anchor) => nextItemsById[anchor.remoteId] !== undefined,
    )
  ) {
    throw new Error(`V2 folder delete still has committed descendants: ${intent.path}`);
  }

  const currentNode = nextItemsById[intent.folderId];
  if (currentNode && currentNode.kind !== "folder") {
    throw new Error(`V2 folder delete identity changed type: ${intent.path}`);
  }
  if (Object.values(nextItemsById).some((node) => node.parentId === intent.folderId)) {
    throw new Error(`V2 folder delete still has remote children: ${intent.path}`);
  }
  delete nextItemsById[intent.folderId];

  const nextFileAnchors = { ...envelope.anchors.byAnchorId };
  for (const anchor of descendantFileAnchors) {
    delete nextFileAnchors[anchor.anchorId];
  }
  const nextFolderAnchors = { ...envelope.folderAnchors!.byAnchorId };
  let removed = descendantFileAnchors.length > 0
    || descendantFolderAnchors.length > 0;
  for (const anchor of descendantFolderAnchors) {
    delete nextFolderAnchors[anchor.anchorId];
  }
  for (const anchor of Object.values(nextFolderAnchors)) {
    if (anchor.remoteId === intent.folderId) {
      delete nextFolderAnchors[anchor.anchorId];
      removed = true;
    }
  }
  if (!removed && !currentNode) return envelope;

  const next: SyncStateEnvelopeV2 = {
    ...envelope,
    meta: {
      ...envelope.meta,
      commitSeq: envelope.meta.commitSeq + 1,
      committedAt: receipt.completedAt,
    },
    remoteIndex: {
      ...envelope.remoteIndex,
      itemsById: sortRecord(nextItemsById),
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextFileAnchors),
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextFolderAnchors),
    },
  };
  validateEnvelope(next);
  return next;
}

function assertFolderReceiptMatchesIntent(
  intent: FolderMutationIntentV2,
  upsert: RemoteFolderEntry,
): void {
  if (!upsert.driveId || !upsert.parentId || !upsert.name || !upsert.path) {
    throw new Error(`V2 folder receipt is incomplete: ${intent.path}`);
  }
  if (upsert.parentId !== intent.expectedParent.driveId) {
    throw new Error(`V2 folder receipt parent identity changed: ${intent.path}`);
  }
  if (
    intent.action === "createLocalFolder"
    && (
      !intent.expectedRemote.exists
      || upsert.driveId !== intent.expectedRemote.driveId
      || upsert.parentId !== intent.expectedRemote.parentId
      || (
        intent.expectedRemote.eTag !== undefined
        && upsert.eTag !== intent.expectedRemote.eTag
      )
    )
  ) {
    throw new Error(`V2 local folder create lost its remote identity: ${intent.path}`);
  }
  if (intent.action === "createRemoteFolder" && intent.expectedRemote.exists) {
    throw new Error(`V2 remote folder create expected an existing target: ${intent.path}`);
  }
}

function assertParentMatchesPath(
  envelope: SyncStateEnvelopeV2,
  upsert: RemoteFolderEntry,
): void {
  const expectedParentPath = parentPath(upsert.path);
  if (expectedParentPath === "") {
    if (upsert.parentId !== envelope.scope.filesRootId) {
      throw new Error(`V2 root folder has a non-root parent identity: ${upsert.path}`);
    }
    return;
  }
  const parent = envelope.remoteIndex.itemsById[upsert.parentId];
  if (!parent || parent.kind !== "folder") {
    throw new Error(`V2 folder parent identity is missing: ${upsert.path}`);
  }
  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  if (pathById.get(parent.id) !== expectedParentPath) {
    throw new Error(`V2 folder parent path changed: ${upsert.path}`);
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function translatePath(path: string, fromRoot: string, toRoot: string): string {
  if (path === fromRoot) return toRoot;
  return `${toRoot}${path.slice(fromRoot.length)}`;
}

function isDescendant(path: string, root: string): boolean {
  return path.normalize("NFC").startsWith(`${root.normalize("NFC")}/`);
}

function isAtOrBelow(path: string, root: string): boolean {
  return path.normalize("NFC") === root.normalize("NFC") || isDescendant(path, root);
}

function identityPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

function nfcPath(path: string): string {
  return path.normalize("NFC");
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function currentRemoteVersionMatchesAnchor(
  remote: RemoteNodeV2,
  anchor: SyncStateEnvelopeV2["anchors"]["byAnchorId"][string],
): boolean {
  if (remote.contentHash !== undefined) {
    return remote.contentHash.toLowerCase() === anchor.contentHash.toLowerCase();
  }
  return remote.eTag !== undefined
    && anchor.remoteETag !== undefined
    && remote.eTag === anchor.remoteETag;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
