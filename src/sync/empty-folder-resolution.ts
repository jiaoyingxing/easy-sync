import { canonicalPlannerStateFromEnvelopeV2 } from "./canonical-planner-state-v2";
import { planFolderStateV2 } from "./folder-state-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  LocalFolderMoveHintV1,
  SyncScope,
} from "./types";

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

function isDescendant(path: string, parent: string): boolean {
  return path.length > parent.length && path.startsWith(`${parent}/`);
}
