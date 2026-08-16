import { projectRemoteIndexV2 } from "./remote-index-v2";
import {
  type FolderAnchorV2,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  canonicalPlannerStateFromEnvelopeV2,
  type CanonicalPlannerStateV2,
} from "./canonical-planner-state-v2";
import { planIdentityRenamesFromStateV2 } from "./identity-rename-v2";
import type {
  LocalFileEntry,
  LocalFolderEntry,
  LocalFolderMoveHintV1,
} from "./types";

export type FolderPlanActionV2 =
  | "create-local"
  | "create-remote"
  | "move-local"
  | "move-remote"
  | "delete-local"
  | "delete-remote"
  | "conflict";

export type FolderPlanConflictReasonV2 =
  | "folder-anchors-uninitialized"
  | "anchored-folder-missing-local"
  | "anchored-folder-missing-remote"
  | "both-sides-moved"
  | "local-subtree-changed"
  | "remote-subtree-changed"
  | "target-occupied"
  | "scope-crossing"
  | "parent-chain-incomplete"
  | "type-conflict"
  | "unanchored-shared-folder"
  | "local-rename-evidence-conflict";

export interface FolderPlanImpactV2 {
  files: number;
  folders: number;
  bytes: number;
}

export interface FolderPlanItemV2 {
  type: FolderPlanActionV2;
  path: string;
  sourcePath?: string;
  targetPath?: string;
  remoteId?: string;
  reason?: FolderPlanConflictReasonV2;
  /** Complete snapshot roots whose ordinary file actions must be held together. */
  affectedPaths?: string[];
  impact: FolderPlanImpactV2;
}

export interface FolderPlanCountsV2 {
  createLocal: number;
  createRemote: number;
  moveLocal: number;
  moveRemote: number;
  deleteLocal: number;
  deleteRemote: number;
  conflicts: number;
}

export interface FolderStatePlanV2 {
  version: 1;
  status: "planned" | "rejected";
  rejectionReason?: "local-folder-scan-incomplete" | "local-normalized-path-conflict"
    | "folder-anchors-uninitialized";
  items: FolderPlanItemV2[];
  counts: FolderPlanCountsV2;
  /** Conservative, de-duplicated impact for the existing review threshold. */
  reviewImpact: FolderPlanImpactV2 & { actions: number };
  mutations: [];
}

export interface FolderStatePlanInputV2 {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  localMoveHints?: readonly LocalFolderMoveHintV1[];
  includeFilePath?: (path: string) => boolean;
  includeFolderPath?: (path: string) => boolean;
  /** Remote-only device scope that must not become a folder mutation/conflict. */
  preserveFolderPath?: (path: string) => boolean;
}

export interface FolderStatePlanViewInputV2
  extends Omit<FolderStatePlanInputV2, "envelope"> {
  state: CanonicalPlannerStateV2;
}

interface PlannedCandidate extends FolderPlanItemV2 {
  coverage: Array<{ side: "local" | "remote"; root: string }>;
}

/** Build initial same-path anchors for a brand-new envelope generation. */
export function buildInitialFolderAnchorsV2(input: {
  envelope: Pick<SyncStateEnvelopeV2, "remoteIndex">;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  confirmedGeneration: number;
  confirmedAt: number;
}): Record<string, FolderAnchorV2> {
  if (!Number.isSafeInteger(input.confirmedGeneration) || input.confirmedGeneration < 1) {
    throw new Error("Folder anchor generation is invalid");
  }
  const localFolderPaths = new Set(input.localFolders.map((entry) => nfcPath(entry.path)));
  const localFilePaths = new Set(input.localFiles.map((entry) => identityPath(entry.path)));
  const pathById = projectRemoteIndexV2(input.envelope.remoteIndex);
  const anchors: Record<string, FolderAnchorV2> = {};

  for (const node of Object.values(input.envelope.remoteIndex.itemsById)) {
    if (node.kind !== "folder") continue;
    const remotePath = pathById.get(node.id);
    if (!remotePath
      || !localFolderPaths.has(nfcPath(remotePath))
      || localFilePaths.has(identityPath(remotePath))) continue;
    const anchorId = `folder:${node.id}`;
    anchors[anchorId] = {
      anchorId,
      remoteId: node.id,
      lastPath: remotePath,
      parentRemoteId: node.parentId,
      remoteETag: node.eTag,
      confirmedGeneration: input.confirmedGeneration,
      confirmedAt: input.confirmedAt,
    };
  }
  return sortRecord(anchors);
}

/**
 * Produce S5 directory candidates only. It deliberately has no adapter,
 * Graph client, mutation intent or state writer.
 */
export function planFolderStateV2(input: FolderStatePlanInputV2): FolderStatePlanV2 {
  return planFolderStateFromViewV2({
    ...input,
    state: canonicalPlannerStateFromEnvelopeV2(input.envelope),
  });
}

export function planFolderStateFromViewV2(
  input: FolderStatePlanViewInputV2,
): FolderStatePlanV2 {
  if (!input.localFolderScanComplete) {
    return rejectedPlan("local-folder-scan-incomplete");
  }
  if (input.state.folderAnchors === null) {
    return rejectedPlan("folder-anchors-uninitialized");
  }

  const includeFilePath = input.includeFilePath ?? (() => true);
  const includeFolderPath = input.includeFolderPath ?? (() => true);
  const preserveFolderPath = input.preserveFolderPath ?? (() => false);
  const remotePathById = input.state.remotePathById;
  const localFoldersByIdentity = new Map<string, string>();
  const localFoldersExact = new Set<string>();
  for (const folder of input.localFolders) {
    const key = identityPath(folder.path);
    const previous = localFoldersByIdentity.get(key);
    if (previous && previous !== folder.path) {
      return rejectedPlan("local-normalized-path-conflict");
    }
    localFoldersByIdentity.set(key, folder.path);
    localFoldersExact.add(nfcPath(folder.path));
  }
  const localFilesByIdentity = new Map(
    input.localFiles.map((entry) => [identityPath(entry.path), entry]),
  );
  const remoteFoldersByIdentity = new Map<string, { id: string; path: string }>();
  const remoteFilesByIdentity = new Map<string, { id: string; path: string }>();
  for (const node of input.state.remoteNodes) {
    const path = remotePathById.get(node.id);
    if (!path) continue;
    if (node.kind === "folder") {
      remoteFoldersByIdentity.set(identityPath(path), { id: node.id, path });
    } else {
      remoteFilesByIdentity.set(identityPath(path), { id: node.id, path });
    }
  }

  const anchors = input.state.folderAnchors
    .filter((anchor) => {
      if (!preserveFolderPath(anchor.lastPath)) return true;
      const remotePath = remotePathById.get(anchor.remoteId);
      return remotePath !== undefined && !preserveFolderPath(remotePath);
    })
    .sort((left, right) => pathDepth(left.lastPath) - pathDepth(right.lastPath)
      || left.lastPath.localeCompare(right.lastPath));
  const anchorByRemoteId = new Map(
    anchors.map((anchor) => [anchor.remoteId, anchor]),
  );
  const validLocalMoveHints = (input.localMoveHints ?? []).filter((hint) => {
    const hintedAnchor = anchorByRemoteId.get(hint.remoteId);
    return hintedAnchor
      && sameScopeIdentity(hint.scope, input.state.scope)
      && nfcPath(hintedAnchor.lastPath) === nfcPath(hint.fromPath);
  });
  const anchoredRemoteIds = new Set(anchors.map((anchor) => anchor.remoteId));
  const anchoredLastPaths = new Set(anchors.map((anchor) => identityPath(anchor.lastPath)));
  const occupiedAnchoredLocalIdentities = new Set(
    anchors
      .map((anchor) => identityPath(anchor.lastPath))
      .filter((path) => localFoldersByIdentity.has(path)),
  );
  const consumedLocalPaths = new Set<string>();
  const candidates: PlannedCandidate[] = [];
  let unresolvedLocalIdentity = false;
  let unresolvedRemoteIdentity = false;
  const inferredLocalByRemoteId = new Map<string, string>();
  const localEvidenceConflicts = new Set<string>();
  const localScopeCrossings = new Map<string, string>();

  for (const anchor of anchors) {
    const localAtOldPath = localFoldersExact.has(nfcPath(anchor.lastPath))
      ? anchor.lastPath
      : undefined;
    const identityEquivalentLocal = localFoldersByIdentity.get(identityPath(anchor.lastPath));
    if (
      !localAtOldPath
      && identityEquivalentLocal
      && nfcPath(identityEquivalentLocal) !== nfcPath(anchor.lastPath)
    ) {
      localEvidenceConflicts.add(anchor.remoteId);
      continue;
    }
    const projectedHintTargets = new Set(
      validLocalMoveHints
        .flatMap((hint) => {
          if (nfcPath(hint.fromPath) === nfcPath(anchor.lastPath)) {
            return [hint.toPath];
          }
          if (isDescendant(anchor.lastPath, hint.fromPath)) {
            return [translatePath(anchor.lastPath, hint.fromPath, hint.toPath)];
          }
          return [];
        }),
    );
    const scopeCrossingTargets = [...projectedHintTargets].filter(
      (path) => !includeFolderPath(path),
    );
    if (scopeCrossingTargets.length > 0) {
      localScopeCrossings.set(anchor.remoteId, scopeCrossingTargets[0]);
      continue;
    }
    const hintedTargets = new Set(
      [...projectedHintTargets]
        .filter((path) => localFoldersExact.has(nfcPath(path))),
    );
    if (hintedTargets.size > 1) {
      localEvidenceConflicts.add(anchor.remoteId);
      continue;
    }
    const hintedPath = hintedTargets.size === 1 ? [...hintedTargets][0] : undefined;
    const inferred = localAtOldPath
      ?? hintedPath
      ?? inferMovedLocalFolder(
        anchor,
        input.state.fileAnchors,
        input.localFiles,
        localFoldersExact,
        occupiedAnchoredLocalIdentities,
        includeFilePath,
      );
    if (inferred) inferredLocalByRemoteId.set(anchor.remoteId, inferred);
  }

  const claimedLocalPaths = new Set([
    ...anchoredLastPaths,
    ...[...inferredLocalByRemoteId.values()].map(identityPath),
  ]);
  const unclaimedLocalFolders = input.localFolders.filter(
    (folder) => includeFolderPath(folder.path)
      && !claimedLocalPaths.has(identityPath(folder.path)),
  );

  for (const anchor of anchors) {
    const remoteNode = input.state.remoteNodeById.get(anchor.remoteId);
    const remotePath = remoteNode?.kind === "folder"
      ? remotePathById.get(anchor.remoteId)
      : undefined;
    const inferredLocalPath = inferredLocalByRemoteId.get(anchor.remoteId);
    if (inferredLocalPath) consumedLocalPaths.add(identityPath(inferredLocalPath));

    const localScopeCrossingTarget = localScopeCrossings.get(anchor.remoteId);
    if (localScopeCrossingTarget) {
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "scope-crossing",
        anchor.remoteId,
        [
          { side: "local", root: localScopeCrossingTarget },
          ...(remotePath ? [{ side: "remote" as const, root: remotePath }] : []),
        ],
        input,
        remotePathById,
      ));
      continue;
    }

    if (localEvidenceConflicts.has(anchor.remoteId)) {
      unresolvedLocalIdentity = true;
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "local-rename-evidence-conflict",
        anchor.remoteId,
        [
          { side: "local", root: anchor.lastPath },
          ...(remotePath ? [{ side: "remote" as const, root: remotePath }] : []),
        ],
        input,
        remotePathById,
      ));
      continue;
    }

    if (!remotePath) {
      if (
        !includeFolderPath(anchor.lastPath)
        || (inferredLocalPath !== undefined && !includeFolderPath(inferredLocalPath))
      ) {
        candidates.push(conflictCandidate(
          anchor.lastPath,
          "scope-crossing",
          anchor.remoteId,
          inferredLocalPath ? [{ side: "local", root: inferredLocalPath }] : [],
          input,
          remotePathById,
        ));
        continue;
      }
      if (inferredLocalPath && nfcPath(inferredLocalPath) !== nfcPath(anchor.lastPath)) {
        unresolvedRemoteIdentity = true;
        candidates.push(conflictCandidate(
          anchor.lastPath,
          "anchored-folder-missing-remote",
          anchor.remoteId,
          [{ side: "local", root: inferredLocalPath }],
          input,
          remotePathById,
        ));
      } else {
        candidates.push(actionCandidate(
          "delete-local",
          anchor.lastPath,
          anchor.lastPath,
          undefined,
          anchor.remoteId,
          inferredLocalPath
            ? [{ side: "local", root: inferredLocalPath }]
            : [],
          input,
          remotePathById,
        ));
      }
      continue;
    }
    if (!inferredLocalPath) {
      if (!includeFolderPath(anchor.lastPath) || !includeFolderPath(remotePath)) {
        candidates.push(conflictCandidate(
          anchor.lastPath,
          "scope-crossing",
          anchor.remoteId,
          [{ side: "remote", root: remotePath }],
          input,
          remotePathById,
        ));
        continue;
      }
      if (unclaimedLocalFolders.length > 0) {
        unresolvedLocalIdentity = true;
        candidates.push(conflictCandidate(
          anchor.lastPath,
          "anchored-folder-missing-local",
          anchor.remoteId,
          [
            { side: "remote", root: remotePath },
            ...unclaimedLocalFolders.map((folder) => ({
              side: "local" as const,
              root: folder.path,
            })),
          ],
          input,
          remotePathById,
        ));
      } else {
        candidates.push(actionCandidate(
          "delete-remote",
          anchor.lastPath,
          anchor.lastPath,
          undefined,
          anchor.remoteId,
          [{ side: "remote", root: remotePath }],
          input,
          remotePathById,
        ));
      }
      continue;
    }

    const localMoved = nfcPath(inferredLocalPath) !== nfcPath(anchor.lastPath);
    const remoteMoved = nfcPath(remotePath) !== nfcPath(anchor.lastPath);
    if (!localMoved && !remoteMoved) continue;

    if (!includeFolderPath(anchor.lastPath)
      || !includeFolderPath(inferredLocalPath)
      || !includeFolderPath(remotePath)) {
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "scope-crossing",
        anchor.remoteId,
        [
          { side: "local", root: inferredLocalPath },
          { side: "remote", root: remotePath },
        ],
        input,
        remotePathById,
      ));
      continue;
    }
    if (localMoved && remoteMoved) {
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "both-sides-moved",
        anchor.remoteId,
        [
          { side: "local", root: inferredLocalPath },
          { side: "remote", root: remotePath },
        ],
        input,
        remotePathById,
      ));
      continue;
    }

    const localSubtreeComparison = compareLocalSubtreeToAnchors(
      anchor.lastPath,
      inferredLocalPath,
      input.state,
      input.localFiles,
      input.localFolders,
      includeFilePath,
      includeFolderPath,
    );
    const localUnchanged = localSubtreeComparison.contentMatches;
    const hasExactLocalMoveHint = validLocalMoveHints.some(
      (hint) => hint.remoteId === anchor.remoteId
        && nfcPath(hint.fromPath) === nfcPath(anchor.lastPath)
        && nfcPath(hint.toPath) === nfcPath(inferredLocalPath),
    );
    const hasSupportedLocalMoveHint = hasExactLocalMoveHint
      || validLocalMoveHints.some((hint) => (
        isDescendant(anchor.lastPath, hint.fromPath)
        && nfcPath(translatePath(
          anchor.lastPath,
          hint.fromPath,
          hint.toPath,
        )) === nfcPath(inferredLocalPath)
      ));
    // Exact TFolder evidence settles the root identity independently from its
    // current members. The canonical folder root protects every descendant
    // until the folder checkpoint, then the ordinary planner reads the new
    // active topology and reconciles added, removed, or changed members.
    const localTopologyMoveSafe = !localUnchanged
      && localMoved
      && !remoteMoved
      && hasExactLocalMoveHint;
    const localCompositionSafe = !localUnchanged
      && localMoved
      && !remoteMoved
      && hasSupportedLocalMoveHint
      && localSubtreeDiffIsAnchoredIncomingMoves(
        anchor,
        inferredLocalPath,
        input.state,
        input.localFiles,
        input.localFolders,
        includeFilePath,
        includeFolderPath,
      );
    const remoteUnchanged = remoteSubtreeMatchesAnchors(
      anchor.lastPath,
      remotePath,
      input.state,
      remotePathById,
      includeFilePath,
      includeFolderPath,
    );
    // The remote folder ID is the exact identity evidence for its root move.
    // Descendant changes do not invalidate that root identity: the protected
    // folder checkpoint moves the local tree first, then the ordinary planner
    // re-reads and reconciles the descendants under the committed target.
    const remoteTopologyMoveSafe = !remoteUnchanged
      && remoteMoved
      && !localMoved;
    if (!localUnchanged && !localTopologyMoveSafe && !localCompositionSafe) {
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "local-subtree-changed",
        anchor.remoteId,
        [{ side: "local", root: inferredLocalPath }],
        input,
        remotePathById,
      ));
      continue;
    }
    if (!remoteUnchanged && !remoteTopologyMoveSafe) {
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "remote-subtree-changed",
        anchor.remoteId,
        [{ side: "remote", root: remotePath }],
        input,
        remotePathById,
      ));
      continue;
    }

    if (remoteMoved) {
      const targetKey = identityPath(remotePath);
      if (localFoldersByIdentity.has(targetKey) || localFilesByIdentity.has(targetKey)) {
        candidates.push(conflictCandidate(
          anchor.lastPath,
          "target-occupied",
          anchor.remoteId,
          [
            { side: "local", root: inferredLocalPath },
            { side: "remote", root: remotePath },
          ],
          input,
          remotePathById,
        ));
        continue;
      }
      if (!localParentExists(remotePath, localFoldersByIdentity)
        && !plannedParentMoveExists("move-local", remotePath, candidates)) {
        candidates.push(conflictCandidate(
          anchor.lastPath,
          "parent-chain-incomplete",
          anchor.remoteId,
          [{ side: "remote", root: remotePath }],
          input,
          remotePathById,
        ));
        continue;
      }
      candidates.push(actionCandidate(
        "move-local",
        remotePath,
        anchor.lastPath,
        remotePath,
        anchor.remoteId,
        [{ side: "local", root: anchor.lastPath }],
        input,
        remotePathById,
      ));
      continue;
    }

    const targetKey = identityPath(inferredLocalPath);
    const occupiedRemote = remoteFoldersByIdentity.get(targetKey)
      ?? remoteFilesByIdentity.get(targetKey);
    if (occupiedRemote) {
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "target-occupied",
        anchor.remoteId,
        [
          { side: "local", root: inferredLocalPath },
          { side: "remote", root: remotePath },
        ],
        input,
        remotePathById,
      ));
      continue;
    }
    if (!remoteParentExists(inferredLocalPath, remoteFoldersByIdentity)
      && !plannedParentMoveExists("move-remote", inferredLocalPath, candidates)) {
      candidates.push(conflictCandidate(
        anchor.lastPath,
        "parent-chain-incomplete",
        anchor.remoteId,
        [{ side: "local", root: inferredLocalPath }],
        input,
        remotePathById,
      ));
      continue;
    }
    candidates.push(actionCandidate(
      "move-remote",
      inferredLocalPath,
      anchor.lastPath,
      inferredLocalPath,
      anchor.remoteId,
      [{ side: "remote", root: anchor.lastPath }],
      input,
      remotePathById,
    ));
  }

  for (const folder of input.localFolders) {
    if (preserveFolderPath(folder.path)) continue;
    if (!includeFolderPath(folder.path)) continue;
    const key = identityPath(folder.path);
    if (consumedLocalPaths.has(key) || anchoredLastPaths.has(key)) continue;
    const remoteFolder = remoteFoldersByIdentity.get(key);
    const remoteFile = remoteFilesByIdentity.get(key);
    if (remoteFile) {
      candidates.push(conflictCandidate(
        folder.path,
        "type-conflict",
        remoteFile.id,
        [{ side: "local", root: folder.path }],
        input,
        remotePathById,
      ));
    } else if (remoteFolder) {
      if (!anchoredRemoteIds.has(remoteFolder.id)) {
        candidates.push(conflictCandidate(
          folder.path,
          "unanchored-shared-folder",
          remoteFolder.id,
          [
            { side: "local", root: folder.path },
            { side: "remote", root: remoteFolder.path },
          ],
          input,
          remotePathById,
        ));
      }
    } else {
      if (unresolvedLocalIdentity) continue;
      candidates.push(actionCandidate(
        "create-remote",
        folder.path,
        undefined,
        folder.path,
        undefined,
        [{ side: "local", root: folder.path }],
        input,
        remotePathById,
      ));
    }
  }

  for (const [key, remoteFolder] of remoteFoldersByIdentity) {
    if (preserveFolderPath(remoteFolder.path)) continue;
    if (!includeFolderPath(remoteFolder.path)) continue;
    if (anchoredRemoteIds.has(remoteFolder.id) || localFoldersByIdentity.has(key)) continue;
    const localFile = localFilesByIdentity.get(key);
    if (localFile) {
      candidates.push(conflictCandidate(
        remoteFolder.path,
        "type-conflict",
        remoteFolder.id,
        [{ side: "remote", root: remoteFolder.path }],
        input,
        remotePathById,
      ));
    } else {
      if (unresolvedRemoteIdentity) continue;
      candidates.push(actionCandidate(
        "create-local",
        remoteFolder.path,
        undefined,
        remoteFolder.path,
        remoteFolder.id,
        [{ side: "remote", root: remoteFolder.path }],
        input,
        remotePathById,
      ));
    }
  }

  const collapsed = collapseCoveredMoves(candidates)
    .sort(comparePlanCandidate);
  return {
    version: 1,
    status: "planned",
    items: collapsed.map(({ coverage: _coverage, ...item }) => item),
    counts: countActions(collapsed),
    reviewImpact: calculateReviewImpact(collapsed, input, remotePathById),
    mutations: [],
  };
}

function inferMovedLocalFolder(
  anchor: FolderAnchorV2,
  fileAnchors: readonly Readonly<SyncAnchorV2>[],
  localFiles: readonly LocalFileEntry[],
  localFoldersExact: ReadonlySet<string>,
  occupiedAnchoredLocalIdentities: ReadonlySet<string>,
  includeFilePath: (path: string) => boolean,
): string | undefined {
  const descendants = fileAnchors
    .filter((entry) => isDescendant(entry.lastPath, anchor.lastPath)
      && includeFilePath(entry.lastPath));
  if (descendants.length === 0) return undefined;

  let candidates: Set<string> | null = null;
  for (const entry of descendants) {
    const relative = relativePath(entry.lastPath, anchor.lastPath);
    const suffix = `/${relative}`;
    const roots = new Set(
      localFiles
        .filter((file) => file.hash === entry.contentHash && file.size === entry.size)
        .flatMap((file) => nfcPath(file.path).endsWith(nfcPath(suffix))
          ? [file.path.slice(0, file.path.length - suffix.length)]
          : [])
        .filter((root) => root.length > 0
          && localFoldersExact.has(nfcPath(root))
          && !occupiedAnchoredLocalIdentities.has(identityPath(root))),
    );
    if (candidates === null) {
      candidates = roots;
    } else {
      const currentCandidates: Set<string> = candidates;
      candidates = new Set(
        [...currentCandidates].filter((candidate) => roots.has(candidate)),
      );
    }
    if (candidates.size === 0) return undefined;
  }
  return candidates && candidates.size === 1 ? [...candidates][0] : undefined;
}

function compareLocalSubtreeToAnchors(
  oldRoot: string,
  currentRoot: string,
  state: CanonicalPlannerStateV2,
  localFiles: readonly LocalFileEntry[],
  localFolders: readonly LocalFolderEntry[],
  includeFilePath: (path: string) => boolean,
  includeFolderPath: (path: string) => boolean,
): { topologyMatches: boolean; contentMatches: boolean } {
  const expectedFiles = new Map<string, SyncAnchorV2>();
  for (const anchor of state.fileAnchors) {
    if (isDescendant(anchor.lastPath, oldRoot) && includeFilePath(anchor.lastPath)) {
      expectedFiles.set(identityPath(relativePath(anchor.lastPath, oldRoot)), anchor);
    }
  }
  const actualFiles = localFiles.filter(
    (entry) => isDescendant(entry.path, currentRoot) && includeFilePath(entry.path),
  );
  if (actualFiles.length !== expectedFiles.size) {
    return { topologyMatches: false, contentMatches: false };
  }
  let contentMatches = true;
  for (const file of actualFiles) {
    const anchor = expectedFiles.get(identityPath(relativePath(file.path, currentRoot)));
    if (!anchor) return { topologyMatches: false, contentMatches: false };
    if (anchor.contentHash !== file.hash || anchor.size !== file.size) {
      contentMatches = false;
    }
  }

  const expectedFolders = new Set(
    (state.folderAnchors ?? [])
      .filter((anchor) => isDescendant(anchor.lastPath, oldRoot)
        && includeFolderPath(anchor.lastPath))
      .map((anchor) => identityPath(relativePath(anchor.lastPath, oldRoot))),
  );
  const actualFolders = new Set(
    localFolders
      .filter((folder) => isDescendant(folder.path, currentRoot)
        && includeFolderPath(folder.path))
      .map((folder) => identityPath(relativePath(folder.path, currentRoot))),
  );
  if (!sameStringSet(expectedFolders, actualFolders)) {
    return { topologyMatches: false, contentMatches: false };
  }
  return { topologyMatches: true, contentMatches };
}

/**
 * A direct TFolder rename may share one plan with files moved into that folder,
 * but only when every extra local file is an unchanged, uniquely anchored V2
 * identity. Carried descendants must still match their committed relative
 * paths exactly; edits, copies, new files, moves out, and folder-shape changes
 * remain fail-closed.
 */
function localSubtreeDiffIsAnchoredIncomingMoves(
  folderAnchor: FolderAnchorV2,
  currentRoot: string,
  state: CanonicalPlannerStateV2,
  localFiles: readonly LocalFileEntry[],
  localFolders: readonly LocalFolderEntry[],
  includeFilePath: (path: string) => boolean,
  includeFolderPath: (path: string) => boolean,
): boolean {
  const oldRoot = folderAnchor.lastPath;
  const expectedFiles = new Map<string, SyncAnchorV2>();
  for (const anchor of state.fileAnchors) {
    if (isDescendant(anchor.lastPath, oldRoot) && includeFilePath(anchor.lastPath)) {
      expectedFiles.set(identityPath(relativePath(anchor.lastPath, oldRoot)), anchor);
    }
  }

  const incomingMoves = new Map(
    planIdentityRenamesFromStateV2(
      state,
      localFiles,
      {
        projectedFolderIdentities: projectFolderIdentitiesForMove(
          state,
          oldRoot,
          currentRoot,
        ),
      },
    )
      .flatMap((action) => action.type === "move-remote"
        && !isDescendant(action.fromPath, oldRoot)
        && isDescendant(action.toPath, currentRoot)
        ? [[identityPath(action.toPath), action] as const]
        : []),
  );
  const matchedExpected = new Set<string>();
  const matchedIncoming = new Set<string>();
  for (const file of localFiles) {
    if (!isDescendant(file.path, currentRoot) || !includeFilePath(file.path)) continue;
    const relative = identityPath(relativePath(file.path, currentRoot));
    const expected = expectedFiles.get(relative);
    if (expected) {
      if (expected.contentHash !== file.hash || expected.size !== file.size) return false;
      matchedExpected.add(relative);
      continue;
    }
    const incoming = incomingMoves.get(identityPath(file.path));
    if (!incoming) return false;
    matchedIncoming.add(identityPath(file.path));
  }
  if (matchedExpected.size !== expectedFiles.size
    || matchedIncoming.size !== incomingMoves.size) return false;

  const expectedFolders = new Set(
    (state.folderAnchors ?? [])
      .filter((anchor) => isDescendant(anchor.lastPath, oldRoot)
        && includeFolderPath(anchor.lastPath))
      .map((anchor) => identityPath(relativePath(anchor.lastPath, oldRoot))),
  );
  const actualFolders = new Set(
    localFolders
      .filter((folder) => isDescendant(folder.path, currentRoot)
        && includeFolderPath(folder.path))
      .map((folder) => identityPath(relativePath(folder.path, currentRoot))),
  );
  return sameStringSet(expectedFolders, actualFolders);
}

function projectFolderIdentitiesForMove(
  state: CanonicalPlannerStateV2,
  sourceRoot: string,
  targetRoot: string,
): Array<{ path: string; remoteId: string }> {
  return (state.folderAnchors ?? [])
    .filter((anchor) => isAtOrBelow(anchor.lastPath, sourceRoot))
    .map((anchor) => ({
      path: nfcPath(anchor.lastPath) === nfcPath(sourceRoot)
        ? targetRoot
        : translatePath(anchor.lastPath, sourceRoot, targetRoot),
      remoteId: anchor.remoteId,
    }));
}

function remoteSubtreeMatchesAnchors(
  oldRoot: string,
  currentRoot: string,
  state: CanonicalPlannerStateV2,
  remotePathById: ReadonlyMap<string, string>,
  includeFilePath: (path: string) => boolean,
  includeFolderPath: (path: string) => boolean,
): boolean {
  const anchoredFileById = new Map(
    state.fileAnchors
      .filter((anchor): anchor is SyncAnchorV2 & { remoteId: string } =>
        Boolean(anchor.remoteId)
        && isDescendant(anchor.lastPath, oldRoot)
        && includeFilePath(anchor.lastPath))
      .map((anchor) => [anchor.remoteId, anchor]),
  );
  const anchoredFolderById = new Map(
    (state.folderAnchors ?? [])
      .filter((anchor) => isDescendant(anchor.lastPath, oldRoot)
        && includeFolderPath(anchor.lastPath))
      .map((anchor) => [anchor.remoteId, anchor]),
  );
  const actualFolderRelatives = new Set<string>();
  const expectedFolderRelatives = new Set<string>();
  for (const anchor of anchoredFolderById.values()) {
    if (includeFolderPath(anchor.lastPath)) {
      expectedFolderRelatives.add(identityPath(relativePath(anchor.lastPath, oldRoot)));
    }
  }

  let actualFileCount = 0;
  for (const node of state.remoteNodes) {
    const path = remotePathById.get(node.id);
    if (!path || !isDescendant(path, currentRoot)) continue;
    const relative = identityPath(relativePath(path, currentRoot));
    if (node.kind === "file" && includeFilePath(path)) {
      actualFileCount++;
      const anchor = anchoredFileById.get(node.id);
      const sameContentVersion = node.contentHash
        ? anchor?.contentHash === node.contentHash
        : Boolean(anchor?.remoteETag) && anchor?.remoteETag === node.eTag;
      if (!anchor
        || identityPath(relativePath(anchor.lastPath, oldRoot)) !== relative
        || !sameContentVersion
        || anchor.size !== node.size) return false;
    } else if (node.kind === "folder" && includeFolderPath(path)) {
      const anchor = anchoredFolderById.get(node.id);
      if (!anchor
        || identityPath(relativePath(anchor.lastPath, oldRoot)) !== relative) return false;
      actualFolderRelatives.add(relative);
    }
  }
  return actualFileCount === anchoredFileById.size
    && sameStringSet(expectedFolderRelatives, actualFolderRelatives);
}

function actionCandidate(
  type: Exclude<FolderPlanActionV2, "conflict">,
  path: string,
  sourcePath: string | undefined,
  targetPath: string | undefined,
  remoteId: string | undefined,
  coverage: PlannedCandidate["coverage"],
  input: FolderStatePlanViewInputV2,
  remotePathById: ReadonlyMap<string, string>,
): PlannedCandidate {
  return {
    type,
    path,
    sourcePath,
    targetPath,
    remoteId,
    affectedPaths: uniqueCoveragePaths(coverage),
    impact: impactForCoverage(coverage, input, remotePathById),
    coverage,
  };
}

function conflictCandidate(
  path: string,
  reason: FolderPlanConflictReasonV2,
  remoteId: string | undefined,
  coverage: PlannedCandidate["coverage"],
  input: FolderStatePlanViewInputV2,
  remotePathById: ReadonlyMap<string, string>,
): PlannedCandidate {
  return {
    type: "conflict",
    path,
    remoteId,
    reason,
    affectedPaths: uniqueCoveragePaths(coverage),
    impact: impactForCoverage(coverage, input, remotePathById),
    coverage,
  };
}

function uniqueCoveragePaths(coverage: PlannedCandidate["coverage"]): string[] {
  return [...new Set(coverage.map((item) => item.root))]
    .sort((left, right) => left.localeCompare(right));
}

function impactForCoverage(
  coverage: PlannedCandidate["coverage"],
  input: FolderStatePlanViewInputV2,
  remotePathById: ReadonlyMap<string, string>,
): FolderPlanImpactV2 {
  const files = new Set<string>();
  const folders = new Set<string>();
  let bytes = 0;
  const byteKeys = new Set<string>();
  for (const item of coverage) {
    if (item.side === "local") {
      for (const folder of input.localFolders) {
        if (isAtOrBelow(folder.path, item.root)) folders.add(`local:${identityPath(folder.path)}`);
      }
      for (const file of input.localFiles) {
        if (!isDescendant(file.path, item.root)) continue;
        const key = `local:${identityPath(file.path)}`;
        files.add(key);
        if (!byteKeys.has(key)) {
          byteKeys.add(key);
          bytes += file.size;
        }
      }
    } else {
      for (const node of input.state.remoteNodes) {
        const path = remotePathById.get(node.id);
        if (!path) continue;
        if (node.kind === "folder" && isAtOrBelow(path, item.root)) {
          folders.add(`remote:${node.id}`);
        } else if (node.kind === "file" && isDescendant(path, item.root)) {
          const key = `remote:${node.id}`;
          files.add(key);
          if (!byteKeys.has(key)) {
            byteKeys.add(key);
            bytes += node.size ?? 0;
          }
        }
      }
    }
  }
  return { files: files.size, folders: folders.size, bytes };
}

function calculateReviewImpact(
  items: readonly PlannedCandidate[],
  input: FolderStatePlanViewInputV2,
  remotePathById: ReadonlyMap<string, string>,
): FolderStatePlanV2["reviewImpact"] {
  const impact = impactForCoverage(items.flatMap((item) => item.coverage), input, remotePathById);
  return { actions: items.length, ...impact };
}

function collapseCoveredMoves(items: readonly PlannedCandidate[]): PlannedCandidate[] {
  const kept: PlannedCandidate[] = [];
  for (const item of [...items].sort(compareMoveCoverage)) {
    if (
      (item.type === "move-local" || item.type === "move-remote")
      && item.sourcePath
      && item.targetPath
      && kept.some((parent) =>
        parent.type === item.type
        && Boolean(parent.sourcePath)
        && Boolean(parent.targetPath)
        && isDescendant(item.sourcePath!, parent.sourcePath!)
        && nfcPath(item.targetPath!) === nfcPath(
          translatePath(item.sourcePath!, parent.sourcePath!, parent.targetPath!),
        ))
    ) continue;
    kept.push(item);
  }
  return kept;
}

function countActions(items: readonly FolderPlanItemV2[]): FolderPlanCountsV2 {
  return {
    createLocal: items.filter((item) => item.type === "create-local").length,
    createRemote: items.filter((item) => item.type === "create-remote").length,
    moveLocal: items.filter((item) => item.type === "move-local").length,
    moveRemote: items.filter((item) => item.type === "move-remote").length,
    deleteLocal: items.filter((item) => item.type === "delete-local").length,
    deleteRemote: items.filter((item) => item.type === "delete-remote").length,
    conflicts: items.filter((item) => item.type === "conflict").length,
  };
}

function rejectedPlan(
  reason: NonNullable<FolderStatePlanV2["rejectionReason"]>,
): FolderStatePlanV2 {
  return {
    version: 1,
    status: "rejected",
    rejectionReason: reason,
    items: [],
    counts: {
      createLocal: 0,
      createRemote: 0,
      moveLocal: 0,
      moveRemote: 0,
      deleteLocal: 0,
      deleteRemote: 0,
      conflicts: 0,
    },
    reviewImpact: { actions: 0, files: 0, folders: 0, bytes: 0 },
    mutations: [],
  };
}

function localParentExists(
  path: string,
  localFoldersByIdentity: ReadonlyMap<string, string>,
): boolean {
  const parent = parentPath(path);
  return parent === "" || localFoldersByIdentity.has(identityPath(parent));
}

function remoteParentExists(
  path: string,
  remoteFoldersByIdentity: ReadonlyMap<string, { id: string; path: string }>,
): boolean {
  const parent = parentPath(path);
  return parent === "" || remoteFoldersByIdentity.has(identityPath(parent));
}

function plannedParentMoveExists(
  type: "move-local" | "move-remote",
  path: string,
  candidates: readonly PlannedCandidate[],
): boolean {
  const parent = parentPath(path);
  return parent !== "" && candidates.some(
    (candidate) => candidate.type === type
      && candidate.targetPath !== undefined
      && identityPath(candidate.targetPath) === identityPath(parent),
  );
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function compareMoveCoverage(left: PlannedCandidate, right: PlannedCandidate): number {
  return pathDepth(left.sourcePath ?? left.path) - pathDepth(right.sourcePath ?? right.path)
    || comparePlanCandidate(left, right);
}

function comparePlanCandidate(left: FolderPlanItemV2, right: FolderPlanItemV2): number {
  return left.path.localeCompare(right.path) || left.type.localeCompare(right.type);
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function relativePath(path: string, root: string): string {
  return path.slice(root.length + 1);
}

function translatePath(path: string, fromRoot: string, toRoot: string): string {
  return `${toRoot}/${relativePath(path, fromRoot)}`;
}

function isDescendant(path: string, root: string): boolean {
  return nfcPath(path).startsWith(`${nfcPath(root)}/`);
}

function isAtOrBelow(path: string, root: string): boolean {
  return nfcPath(path) === nfcPath(root) || isDescendant(path, root);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function identityPath(path: string): string {
  return nfcPath(path).toLocaleLowerCase();
}

function nfcPath(path: string): string {
  return path.normalize("NFC");
}

function sameScopeIdentity(
  left: LocalFolderMoveHintV1["scope"],
  right: LocalFolderMoveHintV1["scope"],
): boolean {
  return left.accountId === right.accountId
    && left.driveId === right.driveId
    && left.vaultFolderId === right.vaultFolderId
    && left.filesRootId === right.filesRootId;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
