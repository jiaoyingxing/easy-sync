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
  type LocalFolderDeleteHintV1,
  type SyncScope,
} from "./types";

export type StaleIdentityIssueCodeV1 =
  | "identity-replacement-ambiguous"
  | "anchored-folder-missing-remote"
  | "local-rename-evidence-conflict"
  | "local-subtree-changed"
  | "remote-subtree-changed"
  | "target-occupied"
  | "parent-chain-incomplete";

export type StaleIdentityResolutionKindV1 =
  | "file-replacement"
  | "folder-missing-remote"
  | "folder-active-forget";

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
  /** Device large-file exclusion threshold in bytes; absent disables the download gate. */
  maxFileSizeBytes?: number;
  localMoveHints?: readonly LocalFolderMoveHintV1[];
  localFolderDeleteHints?: readonly LocalFolderDeleteHintV1[];
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
    const action = actions[0];
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

  if (isFolderActiveForgetIssueCode(issueCode)) {
    const snapshot = buildFolderActiveForgetSnapshotV1(
      path,
      issueCode,
      candidate,
      facts.envelope,
      statePaths,
    );
    if (snapshot) return snapshot;
    return null;
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
  const conflict = folderConflicts[0];
  if (!conflict.remoteId) return null;
  const relatedPaths = uniqueSorted(
    (conflict.affectedPaths ?? []).filter((candidatePath) => candidatePath !== path),
  );
  if (
    relatedPaths.length !== 1
    || !facts.localFolders.some((folder) => samePath(folder.path, relatedPaths[0]))
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
 * Folder-planner conflicts where the anchored remote folder is STILL PRESENT
 * but the tracking relationship is what the user wants to forget ("无法唯一
 * 确认改名" and its sibling shapes). Forgetting removes local anchors only;
 * the remote node stays in the remote index and the next ordinary plan re-meets
 * the folder as an unanchored remote folder (create-local when no local folder
 * occupies the name; unanchored-shared-folder review when one does).
 */
const FOLDER_ACTIVE_FORGET_ISSUE_CODES: ReadonlySet<StaleIdentityIssueCodeV1> =
  new Set([
    "local-rename-evidence-conflict",
    "local-subtree-changed",
    "remote-subtree-changed",
    "target-occupied",
    "parent-chain-incomplete",
  ]);

const FOLDER_ACTIVE_FORGET_REASONS: ReadonlySet<string> = new Set([
  "reason.folder.local-rename-evidence-conflict",
  "reason.folder.local-subtree-changed",
  "reason.folder.remote-subtree-changed",
  "reason.folder.target-occupied",
  "reason.folder.parent-chain-incomplete",
]);

function isFolderActiveForgetIssueCode(
  issueCode: StaleIdentityIssueCodeV1,
): boolean {
  return FOLDER_ACTIVE_FORGET_ISSUE_CODES.has(issueCode);
}

function buildFolderActiveForgetSnapshotV1(
  path: string,
  issueCode: StaleIdentityIssueCodeV1,
  candidate: Exclude<
    ReturnType<typeof buildCanonicalPlanCandidateV2>,
    { status: "rejected" }
  >,
  envelope: SyncStateEnvelopeV2,
  statePaths: ReadonlyMap<string, string>,
): StaleIdentityResolutionSnapshotV1 | null {
  const reason = [...FOLDER_ACTIVE_FORGET_REASONS].find((r) =>
    r.endsWith(`.${issueCode}`));
  if (!reason) return null;
  const deferred = candidate.items.filter((item) =>
    item.type === SyncActionType.FolderDeferred
      && item.path === path
      && item.reason === reason,
  );
  if (deferred.length !== 1) return null;

  const selectedFolderAnchor = Object.values(envelope.folderAnchors!.byAnchorId)
    .find((anchor) => samePath(anchor.lastPath, path));
  if (!selectedFolderAnchor?.remoteId) return null;
  // Active-forget only applies while the remote folder is still present; once
  // it disappears this becomes the stale-lineage (folder-missing-remote) shape.
  if (envelope.remoteIndex.itemsById[selectedFolderAnchor.remoteId] === undefined) {
    return null;
  }

  const folderAnchors = Object.values(envelope.folderAnchors!.byAnchorId)
    .filter((anchor) => isAtOrBelow(anchor.lastPath, path))
    .sort(compareAnchorId)
    .map((anchor) => structuredClone(anchor));
  if (!folderAnchors.some((anchor) =>
    anchor.remoteId === selectedFolderAnchor.remoteId)) return null;
  const fileAnchors = Object.values(envelope.anchors.byAnchorId)
    .filter((anchor) => isAtOrBelow(anchor.lastPath, path))
    .sort(compareAnchorId)
    .map((anchor) => structuredClone(anchor));
  if (fileAnchors.some((anchor) => !anchor.remoteId)) return null;
  const relatedPaths = uniqueSorted(
    folderAnchors
      .filter((anchor) => !samePath(anchor.lastPath, path))
      .map((anchor) => anchor.lastPath)
      .concat(fileAnchors.map((anchor) => anchor.lastPath)),
  );
  return finalizeSnapshot({
    version: 1,
    kind: "folder-active-forget",
    path,
    relatedPaths,
    scope: { ...envelope.scope },
    sourceCommitSeq: envelope.meta.commitSeq,
    sourceLifecycleEpoch: envelope.meta.lifecycleEpoch,
    fileAnchors,
    folderAnchors,
    primaryRemote: remoteFactForId(
      envelope,
      statePaths,
      selectedFolderAnchor.remoteId,
    ),
    pathFacts: pathFactsFor(
      envelope,
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
      || currentFileAnchors[0].lastPath !== reviewed.path
      || !currentFileAnchors[0].remoteId
      || currentFileAnchors[0].remoteId !== reviewed.primaryRemote.remoteId
    ) return reject("review-changed");
  } else if (reviewed.kind === "folder-active-forget") {
    // The user explicitly forgets a tracking relationship whose remote object
    // is still present. The primary remote must still exist (that is what
    // distinguishes this shape from folder-missing-remote), and the reviewed
    // anchors must exactly match the current folder subtree.
    const selected = currentFolderAnchors.find((anchor) =>
      anchor.remoteId === reviewed.primaryRemote.remoteId
        && samePath(anchor.lastPath, reviewed.path));
    if (
      !selected
      || envelope.remoteIndex.itemsById[selected.remoteId] === undefined
      || currentFolderAnchors.some((anchor) =>
        !isAtOrBelow(anchor.lastPath, reviewed.path))
      || currentFileAnchors.some((anchor) =>
        !isAtOrBelow(anchor.lastPath, reviewed.path) || !anchor.remoteId)
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
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
