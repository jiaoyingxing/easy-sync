import { buildCanonicalPlanCandidateV2 } from "./canonical-plan-v2";
import {
  planIdentityRenamesV2,
  type IdentityRenameActionV2,
} from "./identity-rename-v2";
import { projectRemoteIndexV2 } from "./remote-index-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  sameSyncScope,
  SyncActionType,
  type LocalFileEntry,
  type LocalFolderEntry,
  type LocalFolderMoveHintV1,
  type SyncScope,
} from "./types";

export type StaleIdentityIssueCodeV1 =
  | "identity-replacement-ambiguous"
  | "anchored-folder-missing-remote";

export type StaleIdentityResolutionKindV1 =
  | "file-replacement"
  | "folder-missing-remote";

export type StaleIdentityRemoteFactV1 =
  | {
      remoteId: string;
      status: "missing";
    }
  | {
      remoteId: string;
      status: "present";
      kind: "file" | "folder";
      path: string;
      name: string;
      parentRemoteId: string;
      eTag?: string;
      cTag?: string;
      size?: number;
    };

export interface StaleIdentityPathFactV1 {
  path: string;
  remote: Extract<StaleIdentityRemoteFactV1, { status: "present" }> | null;
}

/**
 * Exact, read-only review bundle for retiring one stale identity lineage.
 * Retiring a lineage is state-only: current local and remote objects remain
 * untouched and are handed back to the ordinary canonical planner.
 */
export interface StaleIdentityResolutionSnapshotV1 {
  version: 1;
  revision: string;
  kind: StaleIdentityResolutionKindV1;
  path: string;
  relatedPaths: string[];
  scope: SyncScope;
  sourceCommitSeq: number;
  sourceLifecycleEpoch: number;
  fileAnchors: SyncAnchorV2[];
  folderAnchors: FolderAnchorV2[];
  primaryRemote: StaleIdentityRemoteFactV1;
  pathFacts: StaleIdentityPathFactV1[];
}

export interface StaleIdentityResolutionFactsV1 {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  skippedLarge: readonly string[];
  localMoveHints?: readonly LocalFolderMoveHintV1[];
  includeFilePath?: (path: string) => boolean;
  includeFolderPath?: (path: string) => boolean;
  preserveFolderPath?: (path: string) => boolean;
  configDir: string;
  automaticDeleteLocalFiles: boolean;
}

export type StaleIdentityRetirementV2 =
  | {
      status: "accepted";
      retiredFileAnchors: number;
      retiredFolderAnchors: number;
      envelope: SyncStateEnvelopeV2;
    }
  | {
      status: "rejected";
      reason:
        | "source-changed"
        | "review-changed"
        | "anchors-changed"
        | "remote-facts-changed";
      envelope: SyncStateEnvelopeV2;
    };

/**
 * Rebuild the production canonical candidate and expose a resolution only for
 * the two stable stale-lineage conflicts. No path match or content guess may
 * manufacture this authority.
 */
export function buildStaleIdentityResolutionSnapshotV1(
  path: string,
  issueCode: StaleIdentityIssueCodeV1,
  facts: StaleIdentityResolutionFactsV1,
): StaleIdentityResolutionSnapshotV1 | null {
  if (
    !facts.localFolderScanComplete
    || facts.envelope.remoteIndex.complete !== true
    || !facts.envelope.folderAnchors
  ) return null;

  const candidate = buildCanonicalPlanCandidateV2(facts);
  if (candidate.status !== "planned") return null;
  const statePaths = projectRemoteIndexV2(facts.envelope.remoteIndex);

  if (issueCode === "identity-replacement-ambiguous") {
    const deferred = candidate.items.filter((item) =>
      item.type === SyncActionType.FolderDeferred
        && item.path === path
        && item.reason === "reason.identityReplacement.ambiguous",
    );
    if (deferred.length !== 1) return null;

    const includeFilePath = facts.includeFilePath ?? (() => true);
    const actions = planIdentityRenamesV2(
      facts.envelope,
      facts.localFiles.filter((entry) => includeFilePath(entry.path)),
    ).filter((action): action is Extract<
      IdentityRenameActionV2,
      { type: "conflict" }
    > =>
      action.type === "conflict"
        && action.path === path
        && (
          action.reason === "replacement-with-local-relocation"
          || action.reason === "same-path-identity-occupied"
          || action.reason === "remote-identity-missing"
        ),
    );
    if (actions.length !== 1) return null;
    const action = actions[0]!;
    const relatedPaths = uniqueSorted([
      action.relatedPath,
      ...(action.relatedPaths ?? []),
    ].filter((value): value is string => Boolean(value)));
    if (relatedPaths.some((candidatePath) => !includeFilePath(candidatePath))) {
      return null;
    }
    const anchor = facts.envelope.anchors.byAnchorId[action.anchorId];
    if (!anchor?.remoteId || anchor.lastPath !== path) return null;
    return finalizeSnapshot({
      version: 1,
      kind: "file-replacement",
      path,
      relatedPaths,
      scope: { ...facts.envelope.scope },
      sourceCommitSeq: facts.envelope.meta.commitSeq,
      sourceLifecycleEpoch: facts.envelope.meta.lifecycleEpoch,
      fileAnchors: [structuredClone(anchor)],
      folderAnchors: [],
      primaryRemote: remoteFactForId(
        facts.envelope,
        statePaths,
        anchor.remoteId,
      ),
      pathFacts: pathFactsFor(
        facts.envelope,
        statePaths,
        [path, ...relatedPaths],
      ),
    });
  }

  const deferred = candidate.items.filter((item) =>
    item.type === SyncActionType.FolderDeferred
      && item.path === path
      && item.reason === "reason.folder.anchored-folder-missing-remote",
  );
  const folderConflicts = candidate.folderPlan.items.filter((item) =>
    item.type === "conflict"
      && item.path === path
      && item.reason === "anchored-folder-missing-remote",
  );
  if (deferred.length !== 1 || folderConflicts.length !== 1) return null;
  const conflict = folderConflicts[0]!;
  if (!conflict.remoteId) return null;
  const relatedPaths = uniqueSorted(
    (conflict.affectedPaths ?? []).filter((candidatePath) => candidatePath !== path),
  );
  if (
    relatedPaths.length !== 1
    || !facts.localFolders.some((folder) => samePath(folder.path, relatedPaths[0]!))
  ) return null;

  const folderAnchors = Object.values(facts.envelope.folderAnchors.byAnchorId)
    .filter((anchor) => isAtOrBelow(anchor.lastPath, path))
    .sort(compareAnchorId)
    .map((anchor) => structuredClone(anchor));
  const selectedAnchor = folderAnchors.find((anchor) =>
    anchor.remoteId === conflict.remoteId && samePath(anchor.lastPath, path));
  if (!selectedAnchor) return null;
  const fileAnchors = Object.values(facts.envelope.anchors.byAnchorId)
    .filter((anchor) => isAtOrBelow(anchor.lastPath, path))
    .sort(compareAnchorId)
    .map((anchor) => structuredClone(anchor));
  const allRemoteIds = [
    ...folderAnchors.map((anchor) => anchor.remoteId),
    ...fileAnchors.map((anchor) => anchor.remoteId),
  ];
  if (
    allRemoteIds.some((remoteId) =>
      !remoteId || facts.envelope.remoteIndex.itemsById[remoteId] !== undefined)
  ) return null;

  return finalizeSnapshot({
    version: 1,
    kind: "folder-missing-remote",
    path,
    relatedPaths,
    scope: { ...facts.envelope.scope },
    sourceCommitSeq: facts.envelope.meta.commitSeq,
    sourceLifecycleEpoch: facts.envelope.meta.lifecycleEpoch,
    fileAnchors,
    folderAnchors,
    primaryRemote: remoteFactForId(
      facts.envelope,
      statePaths,
      selectedAnchor.remoteId,
    ),
    pathFacts: pathFactsFor(
      facts.envelope,
      statePaths,
      [path, ...relatedPaths],
    ),
  });
}

/**
 * Pure CAS-style reducer for the state-only retirement. It accepts only the
 * exact reviewed envelope revision, anchors, and remote identity projection.
 */
export function retireReviewedStaleIdentityV2(
  envelope: SyncStateEnvelopeV2,
  reviewed: Readonly<StaleIdentityResolutionSnapshotV1>,
  retiredAt: number,
): StaleIdentityRetirementV2 {
  validateEnvelope(envelope);
  const reject = (
    reason: Extract<StaleIdentityRetirementV2, { status: "rejected" }>["reason"],
  ): StaleIdentityRetirementV2 => ({ status: "rejected", reason, envelope });
  if (
    envelope.remoteIndex.complete !== true
    || !envelope.folderAnchors
    || envelope.meta.commitSeq !== reviewed.sourceCommitSeq
    || envelope.meta.lifecycleEpoch !== reviewed.sourceLifecycleEpoch
    || !sameSyncScope(envelope.scope, reviewed.scope)
  ) return reject("source-changed");

  const { revision: _revision, ...reviewBody } = reviewed;
  if (reviewed.revision !== reviewRevision(reviewBody)) {
    return reject("review-changed");
  }
  const currentFileAnchors = exactAnchors(
    envelope.anchors.byAnchorId,
    reviewed.fileAnchors,
  );
  const currentFolderAnchors = exactAnchors(
    envelope.folderAnchors.byAnchorId,
    reviewed.folderAnchors,
  );
  if (!currentFileAnchors || !currentFolderAnchors) {
    return reject("anchors-changed");
  }

  if (reviewed.kind === "file-replacement") {
    if (
      currentFileAnchors.length !== 1
      || currentFolderAnchors.length !== 0
      || currentFileAnchors[0]!.lastPath !== reviewed.path
      || !currentFileAnchors[0]!.remoteId
      || currentFileAnchors[0]!.remoteId !== reviewed.primaryRemote.remoteId
    ) return reject("review-changed");
  } else {
    const selected = currentFolderAnchors.find((anchor) =>
      anchor.remoteId === reviewed.primaryRemote.remoteId
        && samePath(anchor.lastPath, reviewed.path));
    if (
      !selected
      || currentFolderAnchors.some((anchor) =>
        !isAtOrBelow(anchor.lastPath, reviewed.path))
      || currentFileAnchors.some((anchor) =>
        !isAtOrBelow(anchor.lastPath, reviewed.path) || !anchor.remoteId)
      || [...currentFolderAnchors, ...currentFileAnchors].some((anchor) =>
        Boolean(anchor.remoteId)
          && envelope.remoteIndex.itemsById[anchor.remoteId!] !== undefined)
    ) return reject("remote-facts-changed");
  }

  const statePaths = projectRemoteIndexV2(envelope.remoteIndex);
  const currentPrimary = remoteFactForId(
    envelope,
    statePaths,
    reviewed.primaryRemote.remoteId,
  );
  const currentPathFacts = pathFactsFor(
    envelope,
    statePaths,
    reviewed.pathFacts.map((fact) => fact.path),
  );
  if (
    JSON.stringify(currentPrimary) !== JSON.stringify(reviewed.primaryRemote)
    || JSON.stringify(currentPathFacts) !== JSON.stringify(reviewed.pathFacts)
  ) return reject("remote-facts-changed");

  const nextFileAnchors = { ...envelope.anchors.byAnchorId };
  for (const anchor of currentFileAnchors) delete nextFileAnchors[anchor.anchorId];
  const nextFolderAnchors = { ...envelope.folderAnchors.byAnchorId };
  for (const anchor of currentFolderAnchors) delete nextFolderAnchors[anchor.anchorId];
  const next: SyncStateEnvelopeV2 = {
    ...envelope,
    meta: {
      ...envelope.meta,
      commitSeq: envelope.meta.commitSeq + 1,
      committedAt: retiredAt,
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
  return {
    status: "accepted",
    retiredFileAnchors: currentFileAnchors.length,
    retiredFolderAnchors: currentFolderAnchors.length,
    envelope: next,
  };
}

function finalizeSnapshot(
  body: Omit<StaleIdentityResolutionSnapshotV1, "revision">,
): StaleIdentityResolutionSnapshotV1 {
  return { ...body, revision: reviewRevision(body) };
}

function reviewRevision(
  body: Omit<StaleIdentityResolutionSnapshotV1, "revision">,
): string {
  return JSON.stringify(body);
}

function remoteFactForId(
  envelope: SyncStateEnvelopeV2,
  paths: ReadonlyMap<string, string>,
  remoteId: string,
): StaleIdentityRemoteFactV1 {
  const node = envelope.remoteIndex.itemsById[remoteId];
  const path = paths.get(remoteId);
  if (!node || !path) return { remoteId, status: "missing" };
  return {
    remoteId,
    status: "present",
    kind: node.kind,
    path,
    name: node.name,
    parentRemoteId: node.parentId,
    ...(node.eTag !== undefined ? { eTag: node.eTag } : {}),
    ...(node.cTag !== undefined ? { cTag: node.cTag } : {}),
    ...(node.kind === "file" && node.size !== undefined ? { size: node.size } : {}),
  };
}

function pathFactsFor(
  envelope: SyncStateEnvelopeV2,
  paths: ReadonlyMap<string, string>,
  requestedPaths: readonly string[],
): StaleIdentityPathFactV1[] {
  const idByPath = new Map(
    [...paths].map(([remoteId, path]) => [identityPath(path), remoteId]),
  );
  return uniqueSorted(requestedPaths).map((path) => {
    const remoteId = idByPath.get(identityPath(path));
    const remote = remoteId
      ? remoteFactForId(envelope, paths, remoteId)
      : null;
    return {
      path,
      remote: remote?.status === "present" ? remote : null,
    };
  });
}

function exactAnchors<T extends { anchorId: string }>(
  current: Readonly<Record<string, T>>,
  reviewed: readonly Readonly<T>[],
): T[] | null {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const expected of reviewed) {
    if (seen.has(expected.anchorId)) return null;
    seen.add(expected.anchorId);
    const actual = current[expected.anchorId];
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) return null;
    result.push(actual);
  }
  return result;
}

function uniqueSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function compareAnchorId<T extends { anchorId: string }>(left: T, right: T): number {
  return left.anchorId.localeCompare(right.anchorId);
}

function isAtOrBelow(path: string, root: string): boolean {
  const key = identityPath(path);
  const rootKey = identityPath(root);
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

function samePath(left: string, right: string): boolean {
  return identityPath(left) === identityPath(right);
}

function identityPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
