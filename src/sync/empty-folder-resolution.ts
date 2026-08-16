import { canonicalPlannerStateFromEnvelopeV2 } from "./canonical-planner-state-v2";
import { planFolderStateV2 } from "./folder-state-v2";
import {
  validateEnvelope,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  LocalFolderMoveHintV1,
  SyncScope,
} from "./types";
import { sameSyncScope } from "./types";

export interface EmptyFolderResolutionSnapshotV1 {
  version: 1;
  revision: string;
  path: string;
  remoteId: string;
  remoteETag: string;
  /** Descendant-sensitive Graph tag. Required before direct cloud deletion. */
  remoteCTag?: string;
  parentRemoteId: string;
  parentPath: string;
  scope: SyncScope;
  candidatePaths: string[];
}

export interface EmptyFolderResolutionFactsV1 {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  localMoveHints?: readonly LocalFolderMoveHintV1[];
  includeFilePath?: (path: string) => boolean;
  includeFolderPath?: (path: string) => boolean;
  preserveFolderPath?: (path: string) => boolean;
}

export interface FolderSubtreeReviewMemberV1 {
  path: string;
  kind: "file" | "folder";
  remoteId: string;
  parentRemoteId: string;
  remoteETag?: string;
  remoteCTag?: string;
  size?: number;
  contentHash?: string;
  quickXorHash?: string;
}

/**
 * Read-only projection of one highest affected remote subtree.
 *
 * This is review evidence only. It does not authorize a local or remote
 * mutation and it is never persisted as another state source.
 */
export interface FolderSubtreeReviewSnapshotV1 {
  version: 1;
  revision: string;
  sourceCommitSeq: number;
  sourceLifecycleEpoch: number;
  path: string;
  scope: SyncScope;
  issuePaths: string[];
  members: FolderSubtreeReviewMemberV1[];
}

/**
 * Read-only facts for choosing the final location of one folder identity that
 * moved to different paths locally and remotely. The choice covers only the
 * folder location; ordinary sync still reconciles every descendant.
 */
export interface FolderLocationResolutionSnapshotV1 {
  version: 1;
  revision: string;
  sourceCommitSeq: number;
  sourceLifecycleEpoch: number;
  path: string;
  scope: SyncScope;
  remoteId: string;
  remoteETag: string;
  remoteSourceParentId: string;
  localTargetParentId: string;
  localTargetParentPath: string;
  localPath: string;
  remotePath: string;
}

export type FolderLocationResolutionChoiceV1 = "keep-local" | "keep-remote";

export type ReviewedFolderSubtreeRestoreV2 =
  | {
      status: "accepted";
      retiredFileAnchors: number;
      retiredFolderAnchors: number;
      envelope: SyncStateEnvelopeV2;
    }
  | {
      status: "rejected";
      reason: "source-changed" | "review-changed" | "remote-facts-changed";
      envelope: SyncStateEnvelopeV2;
    };

/**
 * Build the read-only facts shown by the empty-folder resolution UI.
 *
 * This deliberately reuses the production folder planner. It can only expose
 * an action when the current canonical facts still produce the exact
 * anchored-folder-missing-local conflict and every involved shell is empty.
 */
export function buildEmptyFolderResolutionSnapshotV1(
  path: string,
  facts: EmptyFolderResolutionFactsV1,
): EmptyFolderResolutionSnapshotV1 | null {
  if (!facts.localFolderScanComplete) return null;

  const state = canonicalPlannerStateFromEnvelopeV2(facts.envelope);
  const plan = planFolderStateV2({
    envelope: facts.envelope,
    localFiles: facts.localFiles,
    localFolders: facts.localFolders,
    localFolderScanComplete: facts.localFolderScanComplete,
    localMoveHints: facts.localMoveHints,
    includeFilePath: facts.includeFilePath,
    includeFolderPath: facts.includeFolderPath,
    preserveFolderPath: facts.preserveFolderPath,
  });
  if (plan.status !== "planned") return null;

  const issue = plan.items.find((item) =>
    item.type === "conflict"
      && item.path === path
      && item.reason === "anchored-folder-missing-local",
  );
  if (!issue?.remoteId) return null;

  const anchor = state.folderAnchorByRemoteId.get(issue.remoteId);
  const remote = state.remoteNodeById.get(issue.remoteId);
  const remotePath = state.remotePathById.get(issue.remoteId);
  if (
    !anchor
    || remote?.kind !== "folder"
    || remotePath !== path
    || anchor.lastPath !== path
    || !remote.eTag
  ) return null;

  const remoteHasDescendants = [...state.remotePathById.entries()].some(
    ([remoteId, candidatePath]) =>
      remoteId !== issue.remoteId && isDescendant(candidatePath, path),
  );
  if (remoteHasDescendants) return null;

  const localFolderPaths = new Set(facts.localFolders.map((folder) => folder.path));
  if (localFolderPaths.has(path)) return null;
  const candidatePaths = [...new Set(issue.affectedPaths ?? [])]
    .filter((candidate) => candidate !== path && localFolderPaths.has(candidate))
    .sort((left, right) => left.localeCompare(right));
  // More than one empty shell is still ambiguous. This slice never turns a
  // picker into authority for an otherwise underdetermined folder history.
  if (candidatePaths.length !== 1) return null;

  const everyCandidateIsEmpty = candidatePaths.every((candidate) =>
    !facts.localFiles.some((file) => isDescendant(file.path, candidate))
      && !facts.localFolders.some((folder) =>
        folder.path !== candidate && isDescendant(folder.path, candidate),
      ),
  );
  if (!everyCandidateIsEmpty) return null;

  const parentPath = path.includes("/")
    ? path.slice(0, path.lastIndexOf("/"))
    : "";
  if (parentPath && !localFolderPaths.has(parentPath)) return null;

  const snapshot = {
    version: 1 as const,
    path,
    remoteId: remote.id,
    remoteETag: remote.eTag,
    ...(remote.cTag ? { remoteCTag: remote.cTag } : {}),
    parentRemoteId: remote.parentId,
    parentPath,
    scope: { ...state.scope },
    candidatePaths,
  };
  return {
    ...snapshot,
    revision: JSON.stringify({
      sourceCommitSeq: state.meta.commitSeq,
      ...snapshot,
    }),
  };
}

/**
 * Collapse nested anchored-folder-missing-local facts into one review root and
 * project the complete committed remote subtree below it.
 */
export function buildFolderSubtreeReviewSnapshotV1(
  requestedPath: string,
  facts: EmptyFolderResolutionFactsV1,
): FolderSubtreeReviewSnapshotV1 | null {
  if (!facts.localFolderScanComplete || facts.envelope.remoteIndex.complete !== true) {
    return null;
  }

  const state = canonicalPlannerStateFromEnvelopeV2(facts.envelope);
  const plan = planFolderStateV2({
    envelope: facts.envelope,
    localFiles: facts.localFiles,
    localFolders: facts.localFolders,
    localFolderScanComplete: facts.localFolderScanComplete,
    localMoveHints: facts.localMoveHints,
    includeFilePath: facts.includeFilePath,
    includeFolderPath: facts.includeFolderPath,
    preserveFolderPath: facts.preserveFolderPath,
  });
  if (plan.status !== "planned") return null;

  const missingLocalIssues = plan.items
    .filter((item) =>
      item.type === "conflict"
        && item.reason === "anchored-folder-missing-local"
        && item.remoteId,
    )
    .sort((left, right) =>
      pathDepth(left.path) - pathDepth(right.path)
        || left.path.localeCompare(right.path),
    );
  const rootIssue = missingLocalIssues.find((item) =>
    item.path === requestedPath || isDescendant(requestedPath, item.path),
  ) ?? missingLocalIssues.find((item) => isDescendant(item.path, requestedPath));
  if (!rootIssue?.remoteId) return null;

  const rootPath = rootIssue.path;
  const rootAnchor = state.folderAnchorByRemoteId.get(rootIssue.remoteId);
  if (
    !rootAnchor
    || rootAnchor.lastPath !== rootPath
    || state.remotePathById.get(rootIssue.remoteId) !== rootPath
  ) return null;

  if (
    facts.localFiles.some((file) =>
      file.path === rootPath || isDescendant(file.path, rootPath))
    || facts.localFolders.some((folder) =>
      folder.path === rootPath || isDescendant(folder.path, rootPath))
  ) return null;

  const members = state.remoteNodes
    .flatMap((node): FolderSubtreeReviewMemberV1[] => {
      const path = state.remotePathById.get(node.id);
      if (!path || (path !== rootPath && !isDescendant(path, rootPath))) return [];
      if (node.kind === "file") {
        if (facts.includeFilePath && !facts.includeFilePath(path)) return [];
        if (
          !node.eTag
          || !Number.isFinite(node.size)
          || node.size! < 0
          || (!node.contentHash && !node.quickXorHash)
        ) return [];
        return [{
          path,
          kind: "file",
          remoteId: node.id,
          parentRemoteId: node.parentId,
          remoteETag: node.eTag,
          ...(node.cTag ? { remoteCTag: node.cTag } : {}),
          size: node.size,
          ...(node.contentHash ? { contentHash: node.contentHash } : {}),
          ...(node.quickXorHash ? { quickXorHash: node.quickXorHash } : {}),
        }];
      }
      if (facts.includeFolderPath && !facts.includeFolderPath(path)) return [];
      if (!node.eTag) return [];
      return [{
        path,
        kind: "folder",
        remoteId: node.id,
        parentRemoteId: node.parentId,
        remoteETag: node.eTag,
        ...(node.cTag ? { remoteCTag: node.cTag } : {}),
      }];
    })
    .sort((left, right) =>
      pathDepth(left.path) - pathDepth(right.path)
        || left.path.localeCompare(right.path),
    );
  if (
    members.length === 0
    || members[0]?.path !== rootPath
    || members[0]?.kind !== "folder"
  ) return null;

  const expectedMemberCount = [...state.remotePathById.values()].filter(
    (path) => path === rootPath || isDescendant(path, rootPath),
  ).length;
  if (members.length !== expectedMemberCount) return null;

  const issuePaths = missingLocalIssues
    .map((item) => item.path)
    .filter((path) => path === rootPath || isDescendant(path, rootPath));
  const snapshot = {
    version: 1 as const,
    sourceCommitSeq: state.meta.commitSeq,
    sourceLifecycleEpoch: state.meta.lifecycleEpoch,
    path: rootPath,
    scope: { ...state.scope },
    issuePaths,
    members,
  };
  return {
    ...snapshot,
    revision: folderSubtreeReviewRevision(snapshot),
  };
}

/**
 * Build a root-location choice only for the exact two-sided move shape.
 *
 * Both target locations must still be free on the opposite side and both
 * parent chains must already exist. Target occupation, scope crossing and an
 * incomplete scan therefore remain ordinary fail-closed folder conflicts.
 */
export function buildFolderLocationResolutionSnapshotV1(
  requestedPath: string,
  facts: EmptyFolderResolutionFactsV1,
): FolderLocationResolutionSnapshotV1 | null {
  if (!facts.localFolderScanComplete || facts.envelope.remoteIndex.complete !== true) {
    return null;
  }

  const state = canonicalPlannerStateFromEnvelopeV2(facts.envelope);
  const plan = planFolderStateV2({
    envelope: facts.envelope,
    localFiles: facts.localFiles,
    localFolders: facts.localFolders,
    localFolderScanComplete: facts.localFolderScanComplete,
    localMoveHints: facts.localMoveHints,
    includeFilePath: facts.includeFilePath,
    includeFolderPath: facts.includeFolderPath,
    preserveFolderPath: facts.preserveFolderPath,
  });
  if (plan.status !== "planned") return null;

  const issue = plan.items.find((item) =>
    item.type === "conflict"
      && item.path === requestedPath
      && item.reason === "both-sides-moved"
      && item.remoteId,
  );
  if (!issue?.remoteId) return null;

  const anchor = state.folderAnchorByRemoteId.get(issue.remoteId);
  const remote = state.remoteNodeById.get(issue.remoteId);
  const remotePath = state.remotePathById.get(issue.remoteId);
  if (
    !anchor
    || remote?.kind !== "folder"
    || !remotePath
    || !remote.eTag
    || anchor.lastPath !== requestedPath
    || sameReviewPath(remotePath, requestedPath)
  ) return null;

  const localFolderPaths = new Set(facts.localFolders.map((folder) => folder.path));
  const localCandidates = [...new Set(issue.affectedPaths ?? [])]
    .filter((candidate) =>
      !sameReviewPath(candidate, remotePath)
        && !sameReviewPath(candidate, requestedPath)
        && localFolderPaths.has(candidate),
    );
  if (localCandidates.length !== 1) return null;
  const localPath = localCandidates[0];

  const localOccupiedPaths = new Set([
    ...facts.localFolders.map((folder) => reviewPathIdentity(folder.path)),
    ...facts.localFiles.map((file) => reviewPathIdentity(file.path)),
  ]);
  const remoteOccupiedPaths = new Set(
    [...state.remotePathById.values()].map(reviewPathIdentity),
  );
  if (
    localOccupiedPaths.has(reviewPathIdentity(requestedPath))
    || localOccupiedPaths.has(reviewPathIdentity(remotePath))
    || remoteOccupiedPaths.has(reviewPathIdentity(requestedPath))
    || remoteOccupiedPaths.has(reviewPathIdentity(localPath))
  ) return null;

  const localTargetParentPath = folderParentPath(localPath);
  const localTargetParentId = localTargetParentPath === ""
    ? state.scope.filesRootId
    : state.remoteNodes.find((node) =>
      node.kind === "folder"
        && sameReviewPath(
          state.remotePathById.get(node.id) ?? "",
          localTargetParentPath,
        ),
    )?.id;
  if (!localTargetParentId) return null;

  const remoteParentPath = folderParentPath(remotePath);
  if (
    remote.parentId !== (remoteParentPath === ""
      ? state.scope.filesRootId
      : state.remoteNodes.find((node) =>
        node.kind === "folder"
          && sameReviewPath(
            state.remotePathById.get(node.id) ?? "",
            remoteParentPath,
          ),
      )?.id)
    || (remoteParentPath !== "" && !localFolderPaths.has(remoteParentPath))
  ) return null;

  const snapshot = {
    version: 1 as const,
    sourceCommitSeq: state.meta.commitSeq,
    sourceLifecycleEpoch: state.meta.lifecycleEpoch,
    path: requestedPath,
    scope: { ...state.scope },
    remoteId: remote.id,
    remoteETag: remote.eTag,
    remoteSourceParentId: remote.parentId,
    localTargetParentId,
    localTargetParentPath,
    localPath,
    remotePath,
  };
  return {
    ...snapshot,
    revision: JSON.stringify(snapshot),
  };
}

/**
 * Accept an exact "keep cloud" subtree review without mutating either side.
 *
 * Retiring the old common anchors removes only the obsolete interpretation
 * that local absence may mean a cloud deletion. The complete RemoteIndex is
 * retained, so the ordinary canonical planner subsequently emits the existing
 * parent-first CreateLocalFolder and per-file Download actions. This keeps
 * transfer intents, receipts, checkpoints and crash recovery in one engine.
 */
export function acceptReviewedFolderSubtreeRestoreV2(
  envelope: SyncStateEnvelopeV2,
  reviewed: Readonly<FolderSubtreeReviewSnapshotV1>,
  committedAt: number,
): ReviewedFolderSubtreeRestoreV2 {
  validateEnvelope(envelope);
  const reject = (
    reason: Extract<ReviewedFolderSubtreeRestoreV2, { status: "rejected" }>["reason"],
  ): ReviewedFolderSubtreeRestoreV2 => ({ status: "rejected", reason, envelope });
  if (
    envelope.remoteIndex.complete !== true
    || !envelope.folderAnchors
    || envelope.meta.commitSeq !== reviewed.sourceCommitSeq
    || envelope.meta.lifecycleEpoch !== reviewed.sourceLifecycleEpoch
    || !sameSyncScope(envelope.scope, reviewed.scope)
  ) return reject("source-changed");

  const { revision: _revision, ...reviewBody } = reviewed;
  if (reviewed.revision !== folderSubtreeReviewRevision(reviewBody)) {
    return reject("review-changed");
  }

  const state = canonicalPlannerStateFromEnvelopeV2(envelope);
  const currentMembers = projectRemoteSubtreeMembers(state, reviewed.path);
  if (
    currentMembers.length === 0
    || currentMembers[0]?.kind !== "folder"
    || currentMembers[0]?.path !== reviewed.path
    || JSON.stringify(currentMembers) !== JSON.stringify(reviewed.members)
  ) return reject("remote-facts-changed");

  const nextFileAnchors = { ...envelope.anchors.byAnchorId };
  const retiredFileAnchors = Object.values(nextFileAnchors).filter((anchor) =>
    isAtOrBelow(anchor.lastPath, reviewed.path));
  for (const anchor of retiredFileAnchors) delete nextFileAnchors[anchor.anchorId];

  const nextFolderAnchors = { ...envelope.folderAnchors.byAnchorId };
  const retiredFolderAnchors = Object.values(nextFolderAnchors).filter((anchor) =>
    isAtOrBelow(anchor.lastPath, reviewed.path));
  if (!retiredFolderAnchors.some((anchor) => anchor.lastPath === reviewed.path)) {
    return reject("review-changed");
  }
  for (const anchor of retiredFolderAnchors) {
    delete nextFolderAnchors[anchor.anchorId];
  }

  const next: SyncStateEnvelopeV2 = {
    ...envelope,
    meta: {
      ...envelope.meta,
      commitSeq: envelope.meta.commitSeq + 1,
      committedAt,
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
    retiredFileAnchors: retiredFileAnchors.length,
    retiredFolderAnchors: retiredFolderAnchors.length,
    envelope: next,
  };
}

function projectRemoteSubtreeMembers(
  state: ReturnType<typeof canonicalPlannerStateFromEnvelopeV2>,
  rootPath: string,
): FolderSubtreeReviewMemberV1[] {
  return state.remoteNodes
    .flatMap((node): FolderSubtreeReviewMemberV1[] => {
      const path = state.remotePathById.get(node.id);
      if (!path || !isAtOrBelow(path, rootPath)) return [];
      return node.kind === "file"
        ? [{
            path,
            kind: "file",
            remoteId: node.id,
            parentRemoteId: node.parentId,
            ...(node.eTag ? { remoteETag: node.eTag } : {}),
            ...(node.cTag ? { remoteCTag: node.cTag } : {}),
            ...(node.size !== undefined ? { size: node.size } : {}),
            ...(node.contentHash ? { contentHash: node.contentHash } : {}),
            ...(node.quickXorHash ? { quickXorHash: node.quickXorHash } : {}),
          }]
        : [{
            path,
            kind: "folder",
            remoteId: node.id,
            parentRemoteId: node.parentId,
            ...(node.eTag ? { remoteETag: node.eTag } : {}),
            ...(node.cTag ? { remoteCTag: node.cTag } : {}),
          }];
    })
    .sort((left, right) =>
      pathDepth(left.path) - pathDepth(right.path)
        || left.path.localeCompare(right.path));
}

function folderSubtreeReviewRevision(
  body: Omit<FolderSubtreeReviewSnapshotV1, "revision">,
): string {
  return JSON.stringify(body);
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isAtOrBelow(path: string, root: string): boolean {
  return path === root || isDescendant(path, root);
}

function isDescendant(path: string, parent: string): boolean {
  return path.length > parent.length && path.startsWith(`${parent}/`);
}

function folderParentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function sameReviewPath(left: string, right: string): boolean {
  return reviewPathIdentity(left) === reviewPathIdentity(right);
}

function reviewPathIdentity(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC").toLocaleLowerCase("en-US");
}

function pathDepth(path: string): number {
  return path.split("/").length;
}
