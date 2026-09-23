import { canonicalPlannerStateFromEnvelopeV2 } from "./canonical-planner-state-v2";
import { planFolderStateV2 } from "./folder-state-v2";
import { identityPath } from "./recovery-anchor-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  LocalFolderMoveHintV1,
  LocalFolderDeleteHintV1,
  RemoteFolderEntry,
  SyncScope,
} from "./types";

export interface SharedFolderIdentityResolutionSnapshotV1 {
  version: 1;
  revision: string;
  path: string;
  scope: SyncScope;
  sourceCommitSeq: number;
  folders: RemoteFolderEntry[];
}

/**
 * Outcome of one review attempt. `name-mismatch` is the one unavailable cause
 * the user can act on: the planner matched the pair by identity (letter case
 * and Unicode form do not matter there), so the same-name pair keeps being
 * reported while this entry can never confirm it — renaming one side to match
 * the other exactly is the only way out.
 */
export type SharedFolderIdentityResolutionOutcomeV1 =
  | { status: "ready"; snapshot: SharedFolderIdentityResolutionSnapshotV1 }
  | { status: "name-mismatch"; path: string }
  | { status: "unavailable" };

export interface SharedFolderIdentityResolutionFactsV1 {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  localMoveHints?: readonly LocalFolderMoveHintV1[];
  localFolderDeleteHints?: readonly LocalFolderDeleteHintV1[];
  includeFilePath?: (path: string) => boolean;
  includeFolderPath?: (path: string) => boolean;
  preserveFolderPath?: (path: string) => boolean;
}

/**
 * Freeze the exact local/remote folder chain shown to the user before an
 * explicit identity confirmation. Same paths alone never call this function:
 * the production folder planner must still report the selected path as an
 * unanchored shared folder under the current complete facts.
 */
export function buildSharedFolderIdentityResolutionSnapshotV1(
  path: string,
  facts: SharedFolderIdentityResolutionFactsV1,
): SharedFolderIdentityResolutionOutcomeV1 {
  if (!facts.localFolderScanComplete) return { status: "unavailable" };

  const state = canonicalPlannerStateFromEnvelopeV2(facts.envelope);
  const plan = planFolderStateV2({
    envelope: facts.envelope,
    localFiles: facts.localFiles,
    localFolders: facts.localFolders,
    localFolderScanComplete: facts.localFolderScanComplete,
    localMoveHints: facts.localMoveHints,
    localFolderDeleteHints: facts.localFolderDeleteHints,
    includeFilePath: facts.includeFilePath,
    includeFolderPath: facts.includeFolderPath,
    preserveFolderPath: facts.preserveFolderPath,
  });
  if (plan.status !== "planned") return { status: "unavailable" };

  const selected = plan.items.find((item) =>
    item.type === "conflict"
      && item.path === path
      && item.reason === "unanchored-shared-folder",
  );
  if (!selected?.remoteId) return { status: "unavailable" };

  const localFolderPaths = new Set(
    facts.localFolders.map((folder) => folder.path),
  );
  const folders: RemoteFolderEntry[] = [];
  for (const item of plan.items
    .filter((candidate) =>
      candidate.type === "conflict"
        && candidate.reason === "unanchored-shared-folder"
        && isSameOrAncestorPath(candidate.path, path),
    )
    .sort((left, right) =>
      pathDepth(left.path) - pathDepth(right.path)
        || left.path.localeCompare(right.path),
    )) {
    if (!item.remoteId || !localFolderPaths.has(item.path)) {
      return { status: "unavailable" };
    }
    const remote = state.remoteNodeById.get(item.remoteId);
    const remotePath = state.remotePathById.get(item.remoteId);
    if (remote?.kind !== "folder" || remotePath === undefined) {
      return { status: "unavailable" };
    }
    if (remotePath !== item.path) {
      return identityPath(remotePath) === identityPath(item.path)
        ? { status: "name-mismatch", path: item.path }
        : { status: "unavailable" };
    }
    if (!remote.eTag) return { status: "unavailable" };
    folders.push({
      path: item.path,
      driveId: remote.id,
      parentId: remote.parentId,
      name: remote.name,
      eTag: remote.eTag,
      ...(remote.cTag ? { cTag: remote.cTag } : {}),
    });
  }
  if (
    folders.length === 0
    || folders[folders.length - 1]?.path !== path
  ) return { status: "unavailable" };

  const snapshot = {
    version: 1 as const,
    path,
    scope: { ...state.scope },
    sourceCommitSeq: state.meta.commitSeq,
    folders,
  };
  return {
    status: "ready",
    snapshot: {
      ...snapshot,
      revision: JSON.stringify({
        lifecycleEpoch: state.meta.lifecycleEpoch,
        ...snapshot,
      }),
    },
  };
}

function isSameOrAncestorPath(candidate: string, path: string): boolean {
  return candidate === path || path.startsWith(`${candidate}/`);
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}
