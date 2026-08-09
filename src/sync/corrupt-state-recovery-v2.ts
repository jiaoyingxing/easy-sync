import type { DriveItem } from "../onedrive/types";
import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import { buildInitialFolderAnchorsV2 } from "./folder-state-v2";
import {
  buildRemoteIndexV2,
  type RemoteIndexProjectionV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type StateEnvelopeV2CorruptionEvidence,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  applyVerifiedRemoteHashes,
  exactNodeEquality,
  identityPath,
  refreshedFileAnchor,
  sortRecord,
  uniqueAnchorId,
} from "./recovery-anchor-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
} from "./types";

export interface CorruptStateRecoveryCandidateInputV2 {
  source: StateEnvelopeV2CorruptionEvidence;
  localScanComplete: boolean;
  localFolderScanComplete: boolean;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  /** Complete descendants of source.scope.filesRootId. */
  remoteItems: readonly DriveItem[];
  remoteScanComplete: boolean;
  deltaLink: string | null;
  /**
   * SHA-256 values calculated from bytes downloaded during this read-only
   * observation. Graph-provided SHA-256 values do not need to be repeated.
   */
  verifiedRemoteHashesById?: Readonly<Record<string, string>>;
  /** Only locally verified content-addressed objects may remain referenced. */
  verifiedAncestorHashes?: ReadonlySet<string>;
  now?: number;
}

export interface CorruptStateRecoveryFactsV2 {
  sourceAnchorsUsable: boolean;
  fileAnchorsPreservedById: number;
  fileAnchorsReboundByContent: number;
  fileAnchorsRefreshedEqual: number;
  fileAnchorsCreatedEqual: number;
  fileAnchorsRetired: number;
  folderAnchorsPreservedById: number;
  folderAnchorsRefreshedEqual: number;
  folderAnchorsCreatedEqual: number;
  folderAnchorsRetired: number;
  ancestorReferencesPreserved: number;
  ancestorReferencesDropped: number;
}

export interface CorruptStateRecoveryCandidateResultV2 {
  status: "ready" | "aborted";
  reason?:
    | "source-digest-mismatch"
    | "source-invalid"
    | "scan-incomplete"
    | "remote-identity-incomplete"
    | "remote-hash-evidence-invalid";
  envelope: SyncStateEnvelopeV2 | null;
  facts: CorruptStateRecoveryFactsV2;
  mutations: [];
}

/**
 * Build an in-memory V2 candidate from a source-digest-bound corrupt
 * committed envelope and a complete, stable live observation.
 *
 * A source anchor is reused only when the inspector proved that all anchor
 * sets are independently valid (the only such corruption class is
 * `remote-index`). Otherwise the builder discards the damaged anchor sets and
 * creates fresh common state solely from same-path, exact byte equality.
 */
export async function buildCorruptStateRecoveryCandidateV2(
  input: CorruptStateRecoveryCandidateInputV2,
): Promise<CorruptStateRecoveryCandidateResultV2> {
  const facts = emptyFacts();
  const abort = (
    reason: NonNullable<CorruptStateRecoveryCandidateResultV2["reason"]>,
  ): CorruptStateRecoveryCandidateResultV2 => ({
    status: "aborted",
    reason,
    envelope: null,
    facts,
    mutations: [],
  });

  if (
    await sha256Hex(
      new TextEncoder().encode(input.source.rawEnvelope).buffer,
    ) !== input.source.sourceDigest
  ) {
    return abort("source-digest-mismatch");
  }
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.source.rawEnvelope);
    if (!isRecord(parsed)) return abort("source-invalid");
    raw = parsed;
  } catch {
    return abort("source-invalid");
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
      input.source.scope.filesRootId,
      input.deltaLink,
      sourceCursorRevision(raw, input.source.corruption),
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

  const sourceAnchors = independentlyValidSourceAnchors(
    raw,
    input.source.corruption,
  );
  facts.sourceAnchorsUsable = sourceAnchors !== null;
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
    sourceAnchors?.anchors.byAnchorId ?? {},
  )) {
    const safePrior = retainVerifiedAncestor(
      prior,
      input.verifiedAncestorHashes ?? new Set(),
      facts,
    );
    const sameId = safePrior.remoteId
      ? projection.index.itemsById[safePrior.remoteId]
      : undefined;
    if (sameId?.kind === "file") {
      const remotePath = projection.pathById.get(sameId.id);
      const local = remotePath
        ? localByPath.get(identityPath(remotePath))
        : undefined;
      if (remotePath && local && exactFileEquality(local, sameId)) {
        fileAnchors[safePrior.anchorId] = refreshedFileAnchor(
          safePrior,
          sameId,
          remotePath,
          local.hash,
          local.size,
          now,
        );
        facts.fileAnchorsRefreshedEqual++;
      } else {
        fileAnchors[safePrior.anchorId] = safePrior;
        facts.fileAnchorsPreservedById++;
      }
      boundRemoteIds.add(sameId.id);
      continue;
    }

    const samePath = remoteFilesByPath.get(
      identityPath(safePrior.lastPath),
    );
    if (
      samePath
      && !boundRemoteIds.has(samePath.id)
      && exactNodeEquality(
        samePath,
        safePrior.contentHash,
        safePrior.size,
      )
    ) {
      fileAnchors[safePrior.anchorId] = refreshedFileAnchor(
        safePrior,
        samePath,
        projection.pathById.get(samePath.id) ?? safePrior.lastPath,
        safePrior.contentHash,
        safePrior.size,
        now,
      );
      boundRemoteIds.add(samePath.id);
      facts.fileAnchorsReboundByContent++;
      continue;
    }
    facts.fileAnchorsRetired++;
  }

  for (const [pathKey, remote] of remoteFilesByPath) {
    if (boundRemoteIds.has(remote.id)) continue;
    const local = localByPath.get(pathKey);
    if (!local || !exactFileEquality(local, remote)) continue;
    const path = projection.pathById.get(remote.id);
    if (!path) continue;
    const anchorId = uniqueAnchorId(
      `corrupt-recovered:${remote.id}`,
      fileAnchors,
    );
    fileAnchors[anchorId] = {
      anchorId,
      remoteId: remote.id,
      lastPath: path,
      contentHash: local.hash,
      size: local.size,
      remoteETag: remote.eTag,
      ...(remote.cTag ? { remoteCTag: remote.cTag } : {}),
      confirmedAt: now,
      confirmedBy: "equal-read",
    };
    boundRemoteIds.add(remote.id);
    facts.fileAnchorsCreatedEqual++;
  }

  const folderAnchors = rebuildFolderAnchors(
    sourceAnchors,
    input,
    projection,
    now,
    facts,
  );
  const rawMeta = isRecord(raw.meta) ? raw.meta : {};
  const candidate = {
    ...raw,
    meta: {
      ...rawMeta,
      schemaVersion: 2,
      lifecycleEpoch: input.source.sourceLifecycleEpoch + 1,
      commitSeq: input.source.sourceCommitSeq + 1,
      committedAt: now,
    },
    scope: { ...input.source.scope },
    remoteIndex: projection.index,
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(fileAnchors),
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(folderAnchors),
    },
  } as SyncStateEnvelopeV2;
  delete candidate.remoteScopeRecovery;
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

function independentlyValidSourceAnchors(
  raw: Record<string, unknown>,
  corruption: StateEnvelopeV2CorruptionEvidence["corruption"],
): Pick<SyncStateEnvelopeV2, "anchors" | "folderAnchors"> | null {
  if (corruption !== "remote-index") return null;
  const neutral = structuredClone(raw) as unknown as SyncStateEnvelopeV2;
  neutral.remoteIndex = {
    schemaVersion: 2,
    filesRootId: neutral.scope.filesRootId,
    cursorRevision: 0,
    deltaLink: null,
    complete: true,
    itemsById: {},
  };
  try {
    validateEnvelope(neutral);
    return {
      anchors: structuredClone(neutral.anchors),
      folderAnchors: structuredClone(neutral.folderAnchors),
    };
  } catch {
    return null;
  }
}

function rebuildFolderAnchors(
  sourceAnchors: Pick<
    SyncStateEnvelopeV2,
    "anchors" | "folderAnchors"
  > | null,
  input: CorruptStateRecoveryCandidateInputV2,
  projection: RemoteIndexProjectionV2,
  now: number,
  facts: CorruptStateRecoveryFactsV2,
): Record<string, FolderAnchorV2> {
  const localFolderPaths = new Set(
    input.localFolders.map((entry) => identityPath(entry.path)),
  );
  const anchors: Record<string, FolderAnchorV2> = {};
  const boundRemoteIds = new Set<string>();
  for (const prior of Object.values(
    sourceAnchors?.folderAnchors?.byAnchorId ?? {},
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
        confirmedGeneration: input.source.sourceCommitSeq + 1,
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
    confirmedGeneration: input.source.sourceCommitSeq + 1,
    confirmedAt: now,
  });
  for (const fresh of Object.values(shared)) {
    if (boundRemoteIds.has(fresh.remoteId)) continue;
    const anchorId = uniqueAnchorId(
      `corrupt-recovered-folder:${fresh.remoteId}`,
      anchors,
    );
    anchors[anchorId] = { ...fresh, anchorId };
    boundRemoteIds.add(fresh.remoteId);
    facts.folderAnchorsCreatedEqual++;
  }
  return anchors;
}

function retainVerifiedAncestor(
  prior: SyncAnchorV2,
  verified: ReadonlySet<string>,
  facts: CorruptStateRecoveryFactsV2,
): SyncAnchorV2 {
  const clone = structuredClone(prior);
  if (!clone.ancestorHash) return clone;
  if (verified.has(clone.ancestorHash)) {
    facts.ancestorReferencesPreserved++;
    return clone;
  }
  delete clone.ancestorHash;
  facts.ancestorReferencesDropped++;
  return clone;
}

function sourceCursorRevision(
  raw: Record<string, unknown>,
  corruption: StateEnvelopeV2CorruptionEvidence["corruption"],
): number {
  if (corruption !== "anchors" || !isRecord(raw.remoteIndex)) return 0;
  const revision = raw.remoteIndex.cursorRevision;
  return Number.isSafeInteger(revision) && Number(revision) >= 0
    ? Number(revision) + 1
    : 0;
}

function exactFileEquality(
  local: Pick<LocalFileEntry, "hash" | "size">,
  remote: RemoteNodeV2,
): boolean {
  return exactNodeEquality(remote, local.hash, local.size);
}

function emptyFacts(): CorruptStateRecoveryFactsV2 {
  return {
    sourceAnchorsUsable: false,
    fileAnchorsPreservedById: 0,
    fileAnchorsReboundByContent: 0,
    fileAnchorsRefreshedEqual: 0,
    fileAnchorsCreatedEqual: 0,
    fileAnchorsRetired: 0,
    folderAnchorsPreservedById: 0,
    folderAnchorsRefreshedEqual: 0,
    folderAnchorsCreatedEqual: 0,
    folderAnchorsRetired: 0,
    ancestorReferencesPreserved: 0,
    ancestorReferencesDropped: 0,
  };
}
