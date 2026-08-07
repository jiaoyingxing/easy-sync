import { canonicalPlannerStateFromEnvelopeV2 } from "./canonical-planner-state-v2";
import { planFolderStateV2 } from "./folder-state-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  LocalFolderMoveHintV1,
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

export interface SharedFolderIdentityResolutionFactsV1 {
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
 * Freeze the exact local/remote folder chain shown to the user before an
 * explicit identity confirmation. Same paths alone never call this function:
 * the production folder planner must still report the selected path as an
 * unanchored shared folder under the current complete facts.
 */
export function buildSharedFolderIdentityResolutionSnapshotV1(
  path: string,
  facts: SharedFolderIdentityResolutionFactsV1,
): SharedFolderIdentityResolutionSnapshotV1 | null {
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

  const selected = plan.items.find((item) =>
    item.type === "conflict"
      && item.path === path
      && item.reason === "unanchored-shared-folder",
  );
  if (!selected?.remoteId) return null;

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
    if (!item.remoteId || !localFolderPaths.has(item.path)) return null;
    const remote = state.remoteNodeById.get(item.remoteId);
    if (
      remote?.kind !== "folder"
      || state.remotePathById.get(item.remoteId) !== item.path
      || !remote.eTag
    ) return null;
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
  ) return null;

  const snapshot = {
    version: 1 as const,
    path,
    scope: { ...state.scope },
    sourceCommitSeq: state.meta.commitSeq,
    folders,
  };
  return {
    ...snapshot,
    revision: JSON.stringify({
      lifecycleEpoch: state.meta.lifecycleEpoch,
      ...snapshot,
    }),
  };
}

function isSameOrAncestorPath(candidate: string, path: string): boolean {
  return candidate === path || path.startsWith(`${candidate}/`);
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}
