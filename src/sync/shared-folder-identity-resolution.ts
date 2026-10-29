import { canonicalPlannerStateFromEnvelopeV2 } from "./canonical-planner-state-v2";
import type { CanonicalPlannerStateV2 } from "./canonical-planner-state-v2";
import { planFolderStateV2 } from "./folder-state-v2";
import { identityPath } from "./recovery-anchor-v2";
import type { RemoteNodeV2 } from "./remote-index-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  LocalFolderMoveHintV1,
  LocalFolderDeleteHintV1,
  RemoteFolderEntry,
  SyncScope,
} from "./types";

/**
 * Facts the user can check before answering "are these the same folder?".
 * Counts only cover the syncable subtree (the same include/preserve predicates
 * the planner uses), are recursive, and exclude the target folder itself.
 */
interface SharedFolderIdentitySummaryV1 {
  localFiles: number;
  localFolders: number;
  remoteFiles: number;
  remoteFolders: number;
  /** Relative file paths present on both sides. */
  sameNameFiles: number;
  /** Among `sameNameFiles`: both sizes known and equal. */
  sameSizeFiles: number;
  localOnlyFiles: number;
  remoteOnlyFiles: number;
  /** File anchors under the target path, i.e. files that were synced before. */
  previouslySyncedFiles: number;
}

export interface SharedFolderIdentityResolutionSnapshotV1 {
  version: 1;
  revision: string;
  path: string;
  scope: SyncScope;
  sourceCommitSeq: number;
  folders: RemoteFolderEntry[];
  summary: SharedFolderIdentitySummaryV1;
}

/**
 * Outcome of one review attempt. `name-mismatch` is the one unavailable cause
 * the user can act on: the planner matched the pair by identity (letter case
 * and Unicode form do not matter there), so the same-name pair keeps being
 * reported while this entry can never confirm it — renaming one side to match
 * the other exactly is the only way out.
 */
type SharedFolderIdentityResolutionOutcomeV1 =
  | { status: "ready"; snapshot: SharedFolderIdentityResolutionSnapshotV1 }
  | { status: "name-mismatch"; path: string }
  | { status: "unavailable" };

interface SharedFolderIdentityResolutionFactsV1 {
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

  const summary = summarizeIdentityFacts(path, facts, state);
  const snapshot = {
    version: 1 as const,
    path,
    scope: { ...state.scope },
    sourceCommitSeq: state.meta.commitSeq,
    folders,
    summary,
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

/**
 * Count the facts that let the user judge whether the same-name pair is one
 * folder: how much each side holds, how many names match with equal size, and
 * what only one side has. Sizes (not hashes) are deliberately the only content
 * fact shown: equal size is a hint the user can check, never an identity proof.
 */
function summarizeIdentityFacts(
  path: string,
  facts: SharedFolderIdentityResolutionFactsV1,
  state: CanonicalPlannerStateV2,
): SharedFolderIdentitySummaryV1 {
  const root = path.replace(/\/+$/, "");
  const includeFile = facts.includeFilePath ?? (() => true);
  const includeFolder = facts.includeFolderPath ?? (() => true);
  const preserveFolder = facts.preserveFolderPath ?? (() => false);

  const localFilesByRelativePath = new Map<string, LocalFileEntry>();
  for (const file of facts.localFiles) {
    if (!isDescendantPath(file.path, root) || !includeFile(file.path)) continue;
    localFilesByRelativePath.set(relativeChildPath(file.path, root), file);
  }
  const remoteFilesByRelativePath = new Map<string, RemoteNodeV2>();
  for (const node of state.remoteNodes) {
    if (node.kind !== "file") continue;
    const remotePath = state.remotePathById.get(node.id);
    if (
      !remotePath
      || !isDescendantPath(remotePath, root)
      || !includeFile(remotePath)
    ) continue;
    remoteFilesByRelativePath.set(relativeChildPath(remotePath, root), node);
  }

  let sameNameFiles = 0;
  let sameSizeFiles = 0;
  for (const [relativePath, local] of localFilesByRelativePath) {
    const remote = remoteFilesByRelativePath.get(relativePath);
    if (!remote) continue;
    sameNameFiles++;
    if (
      typeof local.size === "number"
      && typeof remote.size === "number"
      && local.size === remote.size
    ) sameSizeFiles++;
  }
  let localOnlyFiles = 0;
  for (const relativePath of localFilesByRelativePath.keys()) {
    if (!remoteFilesByRelativePath.has(relativePath)) localOnlyFiles++;
  }
  let remoteOnlyFiles = 0;
  for (const relativePath of remoteFilesByRelativePath.keys()) {
    if (!localFilesByRelativePath.has(relativePath)) remoteOnlyFiles++;
  }

  let localFolders = 0;
  for (const folder of facts.localFolders) {
    if (!isDescendantPath(folder.path, root)) continue;
    if (!includeFolder(folder.path) || preserveFolder(folder.path)) continue;
    localFolders++;
  }
  let remoteFolders = 0;
  for (const node of state.remoteNodes) {
    if (node.kind !== "folder") continue;
    const remotePath = state.remotePathById.get(node.id);
    if (!remotePath || !isDescendantPath(remotePath, root)) continue;
    if (!includeFolder(remotePath) || preserveFolder(remotePath)) continue;
    remoteFolders++;
  }

  let previouslySyncedFiles = 0;
  for (const anchor of state.fileAnchors) {
    if (isDescendantPath(anchor.lastPath, root)) previouslySyncedFiles++;
  }

  return {
    localFiles: localFilesByRelativePath.size,
    localFolders,
    remoteFiles: remoteFilesByRelativePath.size,
    remoteFolders,
    sameNameFiles,
    sameSizeFiles,
    localOnlyFiles,
    remoteOnlyFiles,
    previouslySyncedFiles,
  };
}

function isDescendantPath(candidate: string, root: string): boolean {
  return candidate.startsWith(`${root}/`);
}

function relativeChildPath(candidate: string, root: string): string {
  return candidate.slice(root.length + 1);
}

function isSameOrAncestorPath(candidate: string, path: string): boolean {
  return candidate === path || path.startsWith(`${candidate}/`);
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}
