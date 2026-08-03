import type { DriveItem } from "../onedrive/types";
import { buildInitialFolderAnchorsV2 } from "./folder-state-v2";
import {
  buildRemoteIndexV2,
  type RemoteIndexProjectionV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import {
  advanceRemoteIdentityLineageV2,
  validateEnvelope,
  type FolderAnchorV2,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  sameSyncScope,
  type LocalFileEntry,
  type LocalFolderEntry,
  type SyncScope,
} from "./types";

export interface RemoteScopeRecoveryCandidateInputV2 {
  sourceEnvelope: SyncStateEnvelopeV2;
  observedScope: SyncScope;
  localScanComplete: boolean;
  localFolderScanComplete: boolean;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  /** Complete descendants of observedScope.filesRootId. */
  remoteItems: readonly DriveItem[];
  remoteScanComplete: boolean;
  deltaLink: string | null;
  /**
   * SHA-256 values calculated from bytes downloaded during this read-only
   * recovery observation. Graph-provided SHA-256 values remain authoritative
   * and do not need to be repeated here.
   */
  verifiedRemoteHashesById?: Readonly<Record<string, string>>;
  now?: number;
}

export interface RemoteScopeRecoveryFactsV2 {
  fileAnchorsPreservedById: number;
  fileAnchorsReboundByContent: number;
  fileAnchorsRefreshedEqual: number;
  fileAnchorsCreatedEqual: number;
  fileAnchorsRetired: number;
  folderAnchorsPreservedById: number;
  folderAnchorsRefreshedEqual: number;
  folderAnchorsCreatedEqual: number;
  folderAnchorsRetired: number;
}

export interface RemoteScopeRecoveryCandidateResultV2 {
  status: "ready" | "aborted";
  reason?:
    | "source-not-held"
    | "scope-invalid"
    | "scan-incomplete"
    | "remote-identity-incomplete"
    | "remote-hash-evidence-invalid";
  envelope: SyncStateEnvelopeV2 | null;
  facts: RemoteScopeRecoveryFactsV2;
  mutations: [];
}

/**
 * Rebuild a V2 envelope after the committed OneDrive scope became
 * unreachable.
 *
 * This function is deliberately capability-free: it cannot read a Vault,
 * call Graph, publish state, or mutate user files. A path is only a candidate
 * locator. File associations require stable remote identity or exact SHA-256
 * plus size evidence; folder associations require stable remote identity or
 * an independently observed same-path topology on both sides.
 */
export function buildRemoteScopeRecoveryCandidateV2(
  input: RemoteScopeRecoveryCandidateInputV2,
): RemoteScopeRecoveryCandidateResultV2 {
  const facts = emptyFacts();
  const abort = (
    reason: NonNullable<RemoteScopeRecoveryCandidateResultV2["reason"]>,
  ): RemoteScopeRecoveryCandidateResultV2 => ({
    status: "aborted",
    reason,
    envelope: null,
    facts,
    mutations: [],
  });

  try {
    validateEnvelope(input.sourceEnvelope);
  } catch {
    return abort("source-not-held");
  }
  const hold = input.sourceEnvelope.remoteScopeRecovery;
  if (!hold || hold.observedScope === null) return abort("source-not-held");
  if (
    !sameSyncScope(hold.observedScope, input.observedScope)
    || sameSyncScope(input.sourceEnvelope.scope, input.observedScope)
    || input.sourceEnvelope.scope.accountId !== input.observedScope.accountId
  ) {
    return abort("scope-invalid");
  }
  if (
    !input.localScanComplete
    || !input.localFolderScanComplete
    || !input.remoteScanComplete
  ) {
    return abort("scan-incomplete");
  }

  let projection: RemoteIndexProjectionV2;
  try {
    projection = buildRemoteIndexV2(
      [...input.remoteItems],
      input.observedScope.filesRootId,
      input.deltaLink,
      input.sourceEnvelope.remoteIndex.cursorRevision + 1,
    );
  } catch {
    return abort("remote-identity-incomplete");
  }
  if (!applyVerifiedRemoteHashes(
    projection,
    input.verifiedRemoteHashesById ?? {},
  )) {
    return abort("remote-hash-evidence-invalid");
  }

  const now = input.now ?? Date.now();
  const localByPath = new Map(
    input.localFiles.map((entry) => [identityPath(entry.path), entry]),
  );
  const remoteFilesByPath = new Map<string, RemoteNodeV2>();
  for (const node of Object.values(projection.index.itemsById)) {
    if (node.kind !== "file") continue;
    const path = projection.pathById.get(node.id);
    if (path) remoteFilesByPath.set(identityPath(path), node);
  }

  const fileAnchors: Record<string, SyncAnchorV2> = {};
  const boundRemoteIds = new Set<string>();
  for (const prior of Object.values(
    input.sourceEnvelope.anchors.byAnchorId,
  )) {
    const sameId = prior.remoteId
      ? projection.index.itemsById[prior.remoteId]
      : undefined;
    if (sameId?.kind === "file") {
      const remotePath = projection.pathById.get(sameId.id);
      const local = remotePath
        ? localByPath.get(identityPath(remotePath))
        : undefined;
      if (remotePath && local && exactFileEquality(local, sameId)) {
        fileAnchors[prior.anchorId] = refreshedFileAnchor(
          prior,
          sameId,
          remotePath,
          local.hash,
          local.size,
          now,
        );
        facts.fileAnchorsRefreshedEqual++;
      } else {
        fileAnchors[prior.anchorId] = structuredClone(prior);
        facts.fileAnchorsPreservedById++;
      }
      boundRemoteIds.add(sameId.id);
      continue;
    }

    const samePath = remoteFilesByPath.get(identityPath(prior.lastPath));
    if (
      samePath
      && !boundRemoteIds.has(samePath.id)
      && exactNodeEquality(samePath, prior.contentHash, prior.size)
    ) {
      fileAnchors[prior.anchorId] = refreshedFileAnchor(
        prior,
        samePath,
        projection.pathById.get(samePath.id) ?? prior.lastPath,
        prior.contentHash,
        prior.size,
        now,
      );
      boundRemoteIds.add(samePath.id);
      facts.fileAnchorsReboundByContent++;
      continue;
    }
    facts.fileAnchorsRetired++;
  }

  // A newly observed common version is safe base state even when no historical
  // association survived. It is a fresh anchor, never a path-based inheritance
  // of the old logical identity.
  for (const [pathKey, remote] of remoteFilesByPath) {
    if (boundRemoteIds.has(remote.id)) continue;
    const local = localByPath.get(pathKey);
    if (!local || !exactFileEquality(local, remote)) continue;
    const path = projection.pathById.get(remote.id);
    if (!path) continue;
    const anchorId = uniqueAnchorId(
      `scope-recovered:${remote.id}`,
      fileAnchors,
    );
    fileAnchors[anchorId] = {
      anchorId,
      remoteId: remote.id,
      lastPath: path,
      contentHash: local.hash,
      size: local.size,
      remoteETag: remote.eTag,
      confirmedAt: now,
      confirmedBy: "equal-read",
    };
    boundRemoteIds.add(remote.id);
    facts.fileAnchorsCreatedEqual++;
  }

  const folderAnchors = rebuildFolderAnchors(
    input,
    projection,
    now,
    facts,
  );
  const candidate: SyncStateEnvelopeV2 = {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: input.sourceEnvelope.meta.lifecycleEpoch + 1,
      commitSeq: input.sourceEnvelope.meta.commitSeq + 1,
      committedAt: now,
    },
    scope: { ...input.observedScope },
    remoteIndex: projection.index,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(fileAnchors),
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(folderAnchors),
    },
  };
  try {
    validateEnvelope(candidate);
  } catch {
    return abort("remote-identity-incomplete");
  }
  return {
    status: "ready",
    envelope: candidate,
    facts,
    mutations: [],
  };
}

function rebuildFolderAnchors(
  input: RemoteScopeRecoveryCandidateInputV2,
  projection: RemoteIndexProjectionV2,
  now: number,
  facts: RemoteScopeRecoveryFactsV2,
): Record<string, FolderAnchorV2> {
  const localFolderPaths = new Set(
    input.localFolders.map((entry) => identityPath(entry.path)),
  );
  const anchors: Record<string, FolderAnchorV2> = {};
  const boundRemoteIds = new Set<string>();
  for (const prior of Object.values(
    input.sourceEnvelope.folderAnchors?.byAnchorId ?? {},
  )) {
    const remote = projection.index.itemsById[prior.remoteId];
    if (remote?.kind !== "folder") {
      facts.folderAnchorsRetired++;
      continue;
    }
    const remotePath = projection.pathById.get(remote.id);
    if (remotePath && localFolderPaths.has(identityPath(remotePath))) {
      anchors[prior.anchorId] = {
        ...structuredClone(prior),
        lastPath: remotePath,
        parentRemoteId: remote.parentId,
        remoteETag: remote.eTag,
        confirmedGeneration: input.sourceEnvelope.meta.commitSeq + 1,
        confirmedAt: now,
      };
      facts.folderAnchorsRefreshedEqual++;
    } else {
      anchors[prior.anchorId] = structuredClone(prior);
      facts.folderAnchorsPreservedById++;
    }
    boundRemoteIds.add(remote.id);
  }

  const shared = buildInitialFolderAnchorsV2({
    envelope: { remoteIndex: projection.index },
    localFiles: input.localFiles,
    localFolders: input.localFolders,
    confirmedGeneration: input.sourceEnvelope.meta.commitSeq + 1,
    confirmedAt: now,
  });
  for (const fresh of Object.values(shared)) {
    if (boundRemoteIds.has(fresh.remoteId)) continue;
    const anchorId = uniqueAnchorId(
      `scope-recovered-folder:${fresh.remoteId}`,
      anchors,
    );
    anchors[anchorId] = { ...fresh, anchorId };
    boundRemoteIds.add(fresh.remoteId);
    facts.folderAnchorsCreatedEqual++;
  }
  return anchors;
}

function applyVerifiedRemoteHashes(
  projection: RemoteIndexProjectionV2,
  hashes: Readonly<Record<string, string>>,
): boolean {
  for (const [id, rawHash] of Object.entries(hashes)) {
    const node = projection.index.itemsById[id];
    const hash = rawHash.toLowerCase();
    if (!node || node.kind !== "file" || !isSha256(hash)) return false;
    if (node.contentHash && node.contentHash !== hash) return false;
    node.contentHash = hash;
  }
  return true;
}

function refreshedFileAnchor(
  prior: SyncAnchorV2,
  remote: RemoteNodeV2,
  path: string,
  contentHash: string,
  size: number,
  now: number,
): SyncAnchorV2 {
  return {
    ...structuredClone(prior),
    remoteId: remote.id,
    lastPath: path,
    contentHash,
    size,
    remoteETag: remote.eTag,
    remoteIdentityLineage: advanceRemoteIdentityLineageV2(prior, {
      remoteId: remote.id,
      path,
      contentHash,
      size,
      remoteETag: remote.eTag,
      confirmedAt: now,
      confirmedBy: "equal-read",
    }),
    confirmedAt: now,
    confirmedBy: "equal-read",
  };
}

function exactFileEquality(
  local: Pick<LocalFileEntry, "hash" | "size">,
  remote: RemoteNodeV2,
): boolean {
  return exactNodeEquality(remote, local.hash, local.size);
}

function exactNodeEquality(
  remote: RemoteNodeV2,
  hash: string,
  size: number,
): boolean {
  return remote.kind === "file"
    && remote.contentHash === hash.toLowerCase()
    && remote.size === size;
}

function identityPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function uniqueAnchorId<T>(
  preferred: string,
  record: Readonly<Record<string, T>>,
): string {
  if (!(preferred in record)) return preferred;
  let suffix = 2;
  while (`${preferred}:${suffix}` in record) suffix++;
  return `${preferred}:${suffix}`;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left.localeCompare(right)),
  );
}

function emptyFacts(): RemoteScopeRecoveryFactsV2 {
  return {
    fileAnchorsPreservedById: 0,
    fileAnchorsReboundByContent: 0,
    fileAnchorsRefreshedEqual: 0,
    fileAnchorsCreatedEqual: 0,
    fileAnchorsRetired: 0,
    folderAnchorsPreservedById: 0,
    folderAnchorsRefreshedEqual: 0,
    folderAnchorsCreatedEqual: 0,
    folderAnchorsRetired: 0,
  };
}
