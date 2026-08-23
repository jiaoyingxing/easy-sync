/**
 * Canonical V2 file/folder action candidate.
 *
 * This module owns the pure composition boundary introduced by V2-11. It
 * derives file facts from the committed envelope, plans folder topology and
 * identity moves from the same envelope revision, and returns one new action
 * array. It performs no Vault, Graph, state, review, or mutation I/O.
 */

import {
  generateFileDecisionPlanV2,
  isObsidianManagedConfigPath,
} from "./file-decision-planner-v2";
import { normalizeVaultPathKey } from "../obsidian-compat";
import {
  planFolderStateFromViewV2,
  type FolderPlanConflictReasonV2,
  type FolderStatePlanV2,
} from "./folder-state-v2";
import {
  applyAutomaticHandlingPolicy,
  type AutomaticHandlingPolicy,
} from "./automatic-handling-policy";
import {
  contentDifferenceReceiptMatches,
  createContentDifferenceReceipt,
  resolveContentEquality,
  type ContentEqualityProof,
} from "./content-equality";
import {
  attachBaseAncestorHashesV2,
  upsertBaseStateEnvelopeV2,
} from "./file-state-controller-v2";
import {
  planIdentityRenamesFromStateV2,
  type IdentityRenameActionV2,
} from "./identity-rename-v2";
import {
  validateEnvelope,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  canonicalPlannerStateFromEnvelopeV2,
  type CanonicalPlannerStateV2,
} from "./canonical-planner-state-v2";
import {
  CHANGE_THRESHOLD_RATIO,
  SyncActionType,
  sameSyncScope,
  type BaseFileEntry,
  type CanonicalPlanIdentityV2,
  type CanonicalPlanReviewV2,
  type ContentComparisonReceiptV1,
  type LocalFileEntry,
  type LocalFolderEntry,
  type LocalFolderMoveHintV1,
  type RemoteFileEntry,
  type SyncPlanItem,
  type SyncScope,
} from "./types";

const MAX_UNANCHORED_DESCENDANT_EVIDENCE = 10;

export interface CanonicalPlanFactsV2 {
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

export interface CanonicalPlanViewFactsV2
  extends Omit<CanonicalPlanFactsV2, "envelope"> {
  state: CanonicalPlannerStateV2;
}

interface CanonicalActionCompositionFactsV2
  extends Omit<CanonicalPlanViewFactsV2, "skippedLarge"> {
  fileItems: readonly SyncPlanItem[];
  lastTotalFiles: number;
}

export type CanonicalPlanRejectionReasonV2 =
  NonNullable<FolderStatePlanV2["rejectionReason"]>;

export interface CanonicalPlanCandidateV2 {
  version: 2;
  status: "planned" | "rejected";
  rejectionReason?: CanonicalPlanRejectionReasonV2;
  scope: SyncScope;
  sourceCommitSeq: number;
  items: SyncPlanItem[];
  lastTotalFiles: number;
  folderPlan: FolderStatePlanV2;
  /** Same-path remote identity replacements owned by V2 finalization. */
  identityReplacements: CanonicalIdentityReplacementV2[];
  /** Same-ID remote path changes that need one strict content read before a
   *  public local-move action may enter the executable plan. */
  identityMoveVerifications: CanonicalIdentityMoveVerificationV2[];
  /**
   * Non-executable exact-content candidates below leaf shared folders whose
   * identities are not anchored yet. These candidates may establish common
   * file state only; they never enter the canonical action array.
   */
  unanchoredDescendantEvidence: SyncPlanItem[];
}

export interface CanonicalIdentityReplacementV2 {
  anchorId: string;
  previousRemoteId: string;
  remoteId: string;
  path: string;
  local?: LocalFileEntry;
  remote: RemoteFileEntry;
  base: BaseFileEntry;
}

export interface CanonicalIdentityMoveVerificationV2 {
  anchorId: string;
  remoteId: string;
  fromPath: string;
  toPath: string;
  local: LocalFileEntry;
  remote: RemoteFileEntry;
  base: BaseFileEntry;
}

export interface PendingContentComparisonV2 {
  path: string;
  contentComparison?: ContentComparisonReceiptV1;
}

export interface ContentVerificationResultV2 {
  path: string;
  outcome: "equal" | "different" | "failed";
  proof?: ContentEqualityProof;
  downloaded: boolean;
  error?: string;
}

export interface CanonicalContentVerificationV2 {
  candidates: number;
  cachedEvidence: number;
  downloads: number;
  skippedDownloads: number;
  results: ContentVerificationResultV2[];
}

export interface FinalizedCanonicalPlanV2 extends CanonicalPlanCandidateV2 {
  baseUpserts: BaseFileEntry[];
  contentVerification: CanonicalContentVerificationV2;
  requiresThresholdConfirmation: boolean;
}

export interface SealedCanonicalPlanV2 extends FinalizedCanonicalPlanV2 {
  canonicalIdentity: CanonicalPlanIdentityV2;
  canonicalReview: CanonicalPlanReviewV2;
}

export interface FinalizeCanonicalPlanInputV2 {
  candidate: CanonicalPlanCandidateV2;
  envelope: SyncStateEnvelopeV2;
  vaultName: string;
  accountId: string;
  automaticHandlingPolicy: Readonly<AutomaticHandlingPolicy>;
  baselineReconstructionIncomplete: boolean;
  pendingContentComparisons?: readonly PendingContentComparisonV2[];
  verifiedRemoteContentHashesById?: ReadonlyMap<string, string>;
  resolveRemoteContentHash: (
    item: Readonly<SyncPlanItem>,
    progress: { current: number; total: number },
  ) => Promise<string>;
}

export interface SealCanonicalPlanInputV2 {
  finalized: FinalizedCanonicalPlanV2;
  sourceEnvelope: SyncStateEnvelopeV2;
  committedEnvelope: SyncStateEnvelopeV2;
  /** Exact local ancestor hashes attached by the state-controller commit. */
  ancestorHashesByPath?: Readonly<Record<string, string>>;
  /** Public-1.1.3 content verification may refine the first in-memory
   * migration candidate before any V2 envelope has been published. */
  unpublishedMigrationCandidate?: boolean;
}

/**
 * Build the complete action candidate directly from canonical V2 state.
 *
 * No path-keyed V1 base/remote projection is accepted from the caller:
 * remote entries and common ancestors are derived from RemoteIndexV2 and
 * anchors in the same committed envelope revision.
 */
export function buildCanonicalPlanCandidateV2(
  input: CanonicalPlanFactsV2,
): CanonicalPlanCandidateV2 {
  return buildCanonicalPlanCandidateFromStateV2({
    ...input,
    state: canonicalPlannerStateFromEnvelopeV2(input.envelope),
  });
}

export function buildCanonicalPlanCandidateFromStateV2(
  input: CanonicalPlanViewFactsV2,
): CanonicalPlanCandidateV2 {
  const includeFilePath = input.includeFilePath ?? (() => true);
  const localFiles = input.localFiles.filter((entry) =>
    includeFilePath(entry.path));
  const fileFacts = projectCanonicalFileFactsFromStateV2(
    input.state,
    includeFilePath,
  );
  const filePlan = generateFileDecisionPlanV2({
    localEntries: localFiles,
    remoteEntries: fileFacts.remoteEntries,
    baseEntries: fileFacts.baseEntries,
    skippedLarge: input.skippedLarge.filter(includeFilePath),
  });

  return composeCanonicalActionsV2({
    ...input,
    localFiles,
    fileItems: filePlan.items,
    lastTotalFiles: filePlan.lastTotalFiles,
  });
}

/**
 * Compose already-prepared file actions with folder and identity actions.
 *
 * The input array is never mutated. This is the only V2 owner for protecting
 * folder subtrees, carrying file identities with folder moves, and ordering
 * file/folder actions into one candidate.
 */
function composeCanonicalActionsV2(
  input: CanonicalActionCompositionFactsV2,
): CanonicalPlanCandidateV2 {
  const folderPlan = planFolderStateFromViewV2({
    state: input.state,
    localFiles: input.localFiles,
    localFolders: input.localFolders,
    localFolderScanComplete: input.localFolderScanComplete,
    localMoveHints: input.localMoveHints,
    includeFilePath: input.includeFilePath,
    includeFolderPath: input.includeFolderPath,
    preserveFolderPath: input.preserveFolderPath,
  });
  const base: Omit<CanonicalPlanCandidateV2, "status" | "items"> = {
    version: 2,
    scope: { ...input.state.scope },
    sourceCommitSeq: input.state.meta.commitSeq,
    lastTotalFiles: input.lastTotalFiles,
    folderPlan,
    identityReplacements: [],
    identityMoveVerifications: [],
    unanchoredDescendantEvidence: [],
  };
  if (folderPlan.status !== "planned") {
    return {
      ...base,
      status: "rejected",
      rejectionReason: folderPlan.rejectionReason,
      items: [],
    };
  }

  const state = input.state;
  const carriedFolderMoves: Array<{
    sourcePath: string;
    targetPath: string;
  }> = [];
  const projectedFolderIdentities: Array<{
    path: string;
    remoteId: string;
  }> = [];
  for (const item of folderPlan.items) {
    if (
      (item.type === "move-remote" || item.type === "move-local")
      && item.sourcePath
      && item.targetPath
      && item.remoteId
    ) {
      carriedFolderMoves.push({
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
      });
      if (item.type === "move-remote") {
        projectedFolderIdentities.push(
          ...projectFolderIdentitiesForMove(
            state,
            item.sourcePath,
            item.targetPath,
          ),
        );
      }
    }
  }

  const remoteIdByPath = new Map(
    [...state.remotePathById]
      .map(([id, path]) => [normalizeRemotePathKey(path), id]),
  );
  const remoteFilesById = new Map(
    projectCanonicalFileFactsFromStateV2(
      state,
      input.includeFilePath ?? (() => true),
    )
      .remoteEntries
      .map((entry) => [entry.driveId, entry]),
  );
  const plannedRemoteCreates = new Set(
    folderPlan.items
      .filter((item) => item.type === "create-remote")
      .map((item) => normalizeRemotePathKey(item.path)),
  );
  const createItems: SyncPlanItem[] = [];
  const moveItems: SyncPlanItem[] = [];
  const deleteItems: SyncPlanItem[] = [];
  const deferredItems: SyncPlanItem[] = [];
  const protectedRoots = new Set<string>();
  const unanchoredProtectedRoots = new Set<string>();
  const otherProtectedRoots = new Set<string>();

  for (const item of folderPlan.items) {
    if (item.type === "create-remote") {
      const parent = parentFolderPath(item.path);
      const parentRemoteId = parent === ""
        ? state.scope.filesRootId
        : remoteIdByPath.get(normalizeRemotePathKey(parent));
      const parentNode = parentRemoteId
        ? state.remoteNodeById.get(parentRemoteId)
        : undefined;
      if (
        (!parentRemoteId
          && !plannedRemoteCreates.has(normalizeRemotePathKey(parent)))
        || (parentRemoteId && parent !== "" && parentNode?.kind !== "folder")
      ) {
        deferredItems.push(toDeferredFolderPlanItem(
          item.path,
          "parent-chain-incomplete",
        ));
        continue;
      }
      createItems.push({
        type: SyncActionType.CreateRemoteFolder,
        path: item.path,
        folder: {
          parentRemoteId,
          parentPath: parent,
          parentRemoteETag: parentNode?.eTag,
        },
      });
      continue;
    }

    if (item.type === "create-local" && item.remoteId) {
      const remoteNode = state.remoteNodeById.get(item.remoteId);
      if (!remoteNode || remoteNode.kind !== "folder") {
        deferredItems.push(toDeferredFolderPlanItem(
          item.path,
          "parent-chain-incomplete",
        ));
        continue;
      }
      const parentNode = state.remoteNodeById.get(remoteNode.parentId);
      createItems.push({
        type: SyncActionType.CreateLocalFolder,
        path: item.path,
        folder: {
          remoteId: remoteNode.id,
          remoteETag: remoteNode.eTag,
          parentRemoteId: remoteNode.parentId,
          parentPath: parentFolderPath(item.path),
          parentRemoteETag: parentNode?.eTag,
        },
      });
      continue;
    }

    if (
      (item.type === "move-remote" || item.type === "move-local")
      && item.remoteId
      && item.sourcePath
      && item.targetPath
    ) {
      const remoteNode = state.remoteNodeById.get(item.remoteId);
      const anchor = state.folderAnchorByRemoteId.get(item.remoteId);
      if (!remoteNode || remoteNode.kind !== "folder" || !anchor) {
        deferredItems.push(toDeferredFolderPlanItem(
          item.path,
          "parent-chain-incomplete",
        ));
        continue;
      }
      const parent = parentFolderPath(item.targetPath);
      const parentRemoteId = parent === ""
        ? state.scope.filesRootId
        : remoteIdByPath.get(normalizeRemotePathKey(parent));
      const parentNode = parentRemoteId
        ? state.remoteNodeById.get(parentRemoteId)
        : undefined;
      if (
        (!parentRemoteId
          && !plannedRemoteCreates.has(normalizeRemotePathKey(parent)))
        || (parentRemoteId && parent !== "" && parentNode?.kind !== "folder")
      ) {
        deferredItems.push(toDeferredFolderPlanItem(
          item.path,
          "parent-chain-incomplete",
        ));
        continue;
      }
      moveItems.push({
        type: item.type === "move-remote"
          ? SyncActionType.MoveRemoteFolder
          : SyncActionType.MoveLocalFolder,
        path: item.targetPath,
        renameFrom: item.sourcePath,
        reviewImpactCount: Math.max(
          1,
          item.impact.files + item.impact.folders,
        ),
        folder: {
          remoteId: item.remoteId,
          remoteETag: remoteNode.eTag ?? anchor.remoteETag,
          parentRemoteId,
          parentPath: parent,
          parentRemoteETag: parentNode?.eTag,
          sourceParentRemoteId: item.type === "move-remote"
            ? remoteNode.parentId
            : anchor.parentRemoteId,
        },
      });
      for (const root of [
        item.sourcePath,
        item.targetPath,
        ...(item.affectedPaths ?? []),
      ]) {
        protectedRoots.add(root);
        otherProtectedRoots.add(root);
      }
      continue;
    }

    if (
      (item.type === "delete-remote" || item.type === "delete-local")
      && item.remoteId
    ) {
      const anchor = state.folderAnchorByRemoteId.get(item.remoteId);
      if (
        !anchor
        || isProtectedFolderDeletePath(item.path, input.configDir)
      ) {
        deferredItems.push(toDeferredFolderPlanItem(
          item.path,
          anchor ? "scope-crossing" : "parent-chain-incomplete",
        ));
        continue;
      }
      const remoteNode = state.remoteNodeById.get(item.remoteId);
      deleteItems.push({
        type: item.type === "delete-remote"
          ? SyncActionType.DeleteRemoteFolder
          : SyncActionType.DeleteLocalFolder,
        path: item.path,
        // A remote-deleted folder only needs user approval while a local
        // folder still exists to be removed. When both sides are already
        // absent, execute the identity retirement directly so the old anchor
        // cannot strand an empty, permanently pending delete.
        requiresConfirmation: item.type === "delete-local"
          && !input.automaticDeleteLocalFiles
          && item.impact.folders > 0,
        folder: {
          remoteId: item.remoteId,
          remoteETag: remoteNode?.eTag ?? anchor.remoteETag,
          parentRemoteId: remoteNode?.parentId ?? anchor.parentRemoteId,
          parentPath: parentFolderPath(item.path),
          sourceParentRemoteId: remoteNode?.parentId
            ?? anchor.parentRemoteId,
        },
      });
      continue;
    }

    for (const root of item.affectedPaths ?? [item.path]) {
      protectedRoots.add(root);
      if (item.reason === "unanchored-shared-folder") {
        unanchoredProtectedRoots.add(root);
      } else {
        otherProtectedRoots.add(root);
      }
    }
    deferredItems.push(toDeferredFolderPlanItem(item.path, item.reason));
  }

  const leafUnanchoredRoots = [...unanchoredProtectedRoots].filter(
    (root) =>
      ![...unanchoredProtectedRoots].some(
        (candidate) =>
          candidate !== root
          && isAtOrBelowPath(candidate, root),
      ),
  );
  const unanchoredEvidenceCandidates = input.fileItems
    .filter((candidate) =>
      candidate.type === SyncActionType.Conflict
      && candidate.reason === "reason.newFileBothSides"
      && Boolean(candidate.local)
      && Boolean(candidate.remote)
      && candidate.local!.size === candidate.remote!.size
      && leafUnanchoredRoots.some((root) =>
        isAtOrBelowPath(candidate.path, root))
      && ![...otherProtectedRoots].some((root) =>
        isAtOrBelowPath(candidate.path, root)),
    )
    .sort((left, right) =>
      folderPathDepth(right.path) - folderPathDepth(left.path)
      || left.path.localeCompare(right.path))
    .map(clonePlanItem);
  const unanchoredDescendantEvidence = unanchoredEvidenceCandidates.slice(
    0,
    MAX_UNANCHORED_DESCENDANT_EVIDENCE,
  );

  let fileItems = input.fileItems.filter((candidate) =>
    ![candidate.path, candidate.renameFrom]
      .filter((path): path is string => Boolean(path))
      .some((path) =>
        [...protectedRoots].some((root) => isAtOrBelowPath(path, root))),
  );

  const identityItems: SyncPlanItem[] = [];
  const identityReplacements: CanonicalIdentityReplacementV2[] = [];
  const identityMoveVerifications: CanonicalIdentityMoveVerificationV2[] = [];
  const includeFilePath = input.includeFilePath ?? (() => true);
  for (const action of planIdentityRenamesFromStateV2(
    state,
    input.localFiles,
    { projectedFolderIdentities },
  )) {
    if (action.type === "conflict" && !includeFilePath(action.path)) continue;
    if (
      action.type === "reconcile-remote-identity"
      && !includeFilePath(action.path)
    ) continue;
    if (
      action.type !== "conflict"
      && action.type !== "reconcile-remote-identity"
      && (
        !includeFilePath(action.fromPath)
        || !includeFilePath(action.toPath)
      )
    ) continue;
    if (
      "fromPath" in action
      && isFileMoveCarriedByFolderMove(
        action.fromPath,
        action.toPath,
        carriedFolderMoves,
      )
    ) continue;
    if (action.type === "conflict") {
      if (
        [...protectedRoots].some((root) =>
          isAtOrBelowPath(action.path, root))
      ) continue;
      if (action.reason === "local-identity-ambiguous") {
        const oldPathKey = normalizeRemotePathKey(action.path);
        const ordinaryOldPathDecision = fileItems.find((candidate) =>
          normalizeRemotePathKey(candidate.path) === oldPathKey
          && (
            candidate.type === SyncActionType.Conflict
            || candidate.type === SyncActionType.DeleteRemote
          )
        );
        if (ordinaryOldPathDecision?.type === SyncActionType.Conflict) {
          // The file planner already keeps the old cloud path behind a normal
          // decision while uploading every distinct local path. Preserve that
          // safe plan instead of turning same-content copies into a global
          // identity deferral.
          continue;
        }
        if (ordinaryOldPathDecision?.type === SyncActionType.DeleteRemote) {
          fileItems = fileItems.filter(
            (candidate) => candidate !== ordinaryOldPathDecision,
          );
          fileItems.push({
            type: SyncActionType.Conflict,
            path: action.path,
            remote: ordinaryOldPathDecision.remote,
            reason: "reason.renameIdentityAmbiguous",
          });
          continue;
        }
      }
      const blockedPaths = new Set(
        [action.path, action.relatedPath, ...(action.relatedPaths ?? [])]
          .filter((path): path is string => Boolean(path))
          .map(normalizeRemotePathKey),
      );
      fileItems = fileItems.filter(
        (candidate) =>
          !blockedPaths.has(normalizeRemotePathKey(candidate.path))
          && !blockedPaths.has(
            normalizeRemotePathKey(candidate.renameFrom ?? ""),
          ),
      );
      const identityReplacementConflict =
        action.reason === "replacement-with-local-relocation"
        || action.reason === "same-path-identity-occupied"
        || action.reason === "remote-identity-missing";
      deferredItems.push({
        type: SyncActionType.FolderDeferred,
        path: action.path,
        reason: identityReplacementConflict
          ? "reason.identityReplacement.ambiguous"
          : identityMoveConflictReason(action.reason),
      });
      continue;
    }

    if (action.type === "verify-move-local") {
      const anchor = state.fileAnchorById.get(action.anchorId);
      const local = input.localFiles.find(
        (entry) =>
          normalizeRemotePathKey(entry.path)
          === normalizeRemotePathKey(action.fromPath),
      );
      const remote = remoteFilesById.get(action.remoteId);
      if (
        !anchor
        || anchor.remoteId !== action.remoteId
        || !local
        || local.hash !== action.expectedLocalHash
        || local.size !== action.expectedLocalSize
        || !remote
      ) {
        deferredItems.push(identityMovePendingItem(
          action.toPath,
          "reason.identityMove.factsChanged",
        ));
        continue;
      }
      const blockedPaths = new Set(
        [action.fromPath, action.toPath].map(normalizeRemotePathKey),
      );
      fileItems = fileItems.filter(
        (candidate) =>
          !blockedPaths.has(normalizeRemotePathKey(candidate.path))
          && !blockedPaths.has(
            normalizeRemotePathKey(candidate.renameFrom ?? ""),
          ),
      );
      identityMoveVerifications.push({
        anchorId: action.anchorId,
        remoteId: action.remoteId,
        fromPath: action.fromPath,
        toPath: action.toPath,
        local,
        remote,
        base: {
          path: anchor.lastPath,
          hash: anchor.contentHash,
          size: anchor.size,
          eTag: anchor.remoteETag ?? "",
        },
      });
      continue;
    }

    if (action.type === "reconcile-remote-identity") {
      const anchor = state.fileAnchorById.get(action.anchorId);
      const remote = remoteFilesById.get(action.remoteId);
      const local = input.localFiles.find(
        (entry) =>
          normalizeRemotePathKey(entry.path)
          === normalizeRemotePathKey(action.path),
      );
      if (
        !anchor
        || !anchor.remoteId
        || anchor.remoteId !== action.previousRemoteId
        || !remote
        || remote.eTag !== action.expectedRemoteETag
      ) {
        deferredItems.push({
          type: SyncActionType.RetryLater,
          path: action.path,
          reason: "reason.identityReplacement.verificationPending",
        });
        continue;
      }
      const replacementPath = normalizeRemotePathKey(action.path);
      fileItems = fileItems.filter(
        (candidate) =>
          normalizeRemotePathKey(candidate.path) !== replacementPath
          && normalizeRemotePathKey(candidate.renameFrom ?? "")
            !== replacementPath,
      );
      identityReplacements.push({
        anchorId: action.anchorId,
        previousRemoteId: action.previousRemoteId,
        remoteId: action.remoteId,
        path: action.path,
        ...(local ? { local } : {}),
        remote,
        base: {
          path: anchor.lastPath,
          hash: anchor.contentHash,
          size: anchor.size,
          eTag: anchor.remoteETag ?? "",
        },
      });
      continue;
    }

    const localPath = action.type === "move-remote"
      ? action.toPath
      : action.fromPath;
    const local = input.localFiles.find(
      (entry) =>
        normalizeRemotePathKey(entry.path)
        === normalizeRemotePathKey(localPath),
    );
    const remote = remoteFilesById.get(action.remoteId);
    if (!local || !remote) {
      deferredItems.push({
        type: SyncActionType.FolderDeferred,
        path: action.toPath,
        reason: "reason.identityMove.factsChanged",
      });
      continue;
    }
    const movedPaths = new Set(
      [action.fromPath, action.toPath].map(normalizeRemotePathKey),
    );
    fileItems = fileItems.filter(
      (candidate) =>
        !movedPaths.has(normalizeRemotePathKey(candidate.path))
        && !movedPaths.has(
          normalizeRemotePathKey(candidate.renameFrom ?? ""),
        ),
    );
    identityItems.push(action.type === "move-remote"
      ? {
          type: SyncActionType.RenameRemote,
          path: action.toPath,
          renameFrom: action.fromPath,
          targetParentRemoteId: action.newParentId,
          local,
          remote,
          baseEtag: action.expectedRemoteETag,
        }
      : {
          type: SyncActionType.MoveLocalFile,
          path: action.toPath,
          renameFrom: action.fromPath,
          local,
          remote,
        });
  }

  createItems.sort((left, right) =>
    folderPathDepth(left.path) - folderPathDepth(right.path)
    || left.path.localeCompare(right.path)
    || left.type.localeCompare(right.type));
  moveItems.sort((left, right) =>
    folderPathDepth(left.renameFrom ?? left.path)
      - folderPathDepth(right.renameFrom ?? right.path)
    || left.path.localeCompare(right.path));
  deleteItems.sort((left, right) =>
    folderPathDepth(right.path) - folderPathDepth(left.path)
    || left.path.localeCompare(right.path));
  deferredItems.sort((left, right) => left.path.localeCompare(right.path));

  return {
    ...base,
    status: "planned",
    identityReplacements,
    identityMoveVerifications,
    unanchoredDescendantEvidence,
    items: [
      ...createItems,
      ...moveItems,
      ...identityItems,
      ...fileItems,
      ...deleteItems,
      ...deferredItems,
    ],
  };
}

/**
 * Verify common file state below an unanchored shared-folder leaf without
 * authorizing any file or folder action. The caller may publish only returned
 * base upserts, then rebuild the canonical candidate from the new envelope.
 */
export async function finalizeUnanchoredFolderEvidenceV2(
  input: FinalizeCanonicalPlanInputV2,
): Promise<Pick<
  FinalizedCanonicalPlanV2,
  "baseUpserts" | "contentVerification"
>> {
  if (
    input.candidate.status !== "planned"
    || input.candidate.unanchoredDescendantEvidence.length === 0
  ) {
    return {
      baseUpserts: [],
      contentVerification: emptyContentVerification(),
    };
  }
  const finalized = await finalizeCanonicalPlanCandidateV2({
    ...input,
    candidate: {
      ...input.candidate,
      items: input.candidate.unanchoredDescendantEvidence.map(clonePlanItem),
      identityReplacements: [],
      identityMoveVerifications: [],
    },
  });
  return {
    baseUpserts: finalized.baseUpserts,
    contentVerification: finalized.contentVerification,
  };
}

/**
 * Finalize plan-time policy against the exact candidate revision.
 *
 * The caller supplies only the byte-download adapter. Candidate selection,
 * evidence reuse, download budget, automatic delete projection, decision
 * tokens and the change threshold are owned here.
 */
export async function finalizeCanonicalPlanCandidateV2(
  input: FinalizeCanonicalPlanInputV2,
): Promise<FinalizedCanonicalPlanV2> {
  validateEnvelope(input.envelope);
  assertCandidateMatchesEnvelope(input.candidate, input.envelope);
  if (input.candidate.status !== "planned") {
    return {
      ...input.candidate,
      items: [],
      baseUpserts: [],
      contentVerification: emptyContentVerification(),
      requiresThresholdConfirmation: false,
    };
  }

  let items = input.candidate.items.map(clonePlanItem);
  const includeAll = () => true;
  const baseByPath = new Map(
    projectCanonicalFileFactsV2(input.envelope, includeAll)
      .baseEntries
      .map((entry) => [entry.path, entry]),
  );
  const pendingByPath = new Map(
    (input.pendingContentComparisons ?? []).map((entry) => [
      entry.path,
      entry.contentComparison,
    ]),
  );
  const identityResults: ContentVerificationResultV2[] = [];
  const identityBaseUpserts: BaseFileEntry[] = [];
  const identityItems: SyncPlanItem[] = [];
  const identityReplacements =
    input.candidate.identityReplacements ?? [];
  const identityMoveVerifications =
    input.candidate.identityMoveVerifications ?? [];
  let identityCachedEvidence = 0;
  let identityDownloads = 0;
  let remainingDownloadBudget = input.baselineReconstructionIncomplete
    ? Number.POSITIVE_INFINITY
    : 10;

  const identityCandidateCount =
    identityMoveVerifications.length + identityReplacements.length;
  const identityProgressTotal = Math.min(
    identityCandidateCount,
    input.baselineReconstructionIncomplete
      ? identityCandidateCount
      : 10,
  );

  for (const verification of identityMoveVerifications) {
    let remoteHash = verification.remote.sha256Hash?.toLowerCase();
    let proof: ContentEqualityProof = remoteHash
      ? "remoteSha256"
      : "insufficientEvidence";
    if (!remoteHash) {
      remoteHash = input.verifiedRemoteContentHashesById
        ?.get(verification.remote.driveId)
        ?.toLowerCase();
      if (remoteHash) proof = "verifiedRemoteReceipt";
    }
    let downloadedThisRound = false;
    if (remoteHash) {
      identityCachedEvidence++;
    } else if (remainingDownloadBudget > 0) {
      remainingDownloadBudget--;
      identityDownloads++;
      downloadedThisRound = true;
      try {
        remoteHash = (
          await input.resolveRemoteContentHash({
            type: SyncActionType.Conflict,
            path: verification.toPath,
            local: verification.local,
            remote: verification.remote,
            reason: "reason.identityMove.verificationFailed",
          }, {
            current: identityDownloads,
            total: identityProgressTotal,
          })
        ).toLowerCase();
        proof = "downloadedSha256";
      } catch (error) {
        identityItems.push(identityMovePendingItem(
          verification.toPath,
          "reason.identityMove.verificationFailed",
        ));
        identityResults.push({
          path: verification.toPath,
          outcome: "failed",
          downloaded: true,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    } else {
      identityItems.push(identityMovePendingItem(
        verification.toPath,
        "reason.identityMove.verificationFailed",
      ));
      continue;
    }

    const equal =
      verification.local.hash === verification.base.hash
      && verification.local.size === verification.base.size
      && verification.remote.size === verification.base.size
      && remoteHash === verification.base.hash;
    if (equal) {
      identityItems.push({
        type: SyncActionType.MoveLocalFile,
        path: verification.toPath,
        renameFrom: verification.fromPath,
        local: { ...verification.local },
        remote: { ...verification.remote },
      });
    } else {
      identityItems.push(identityMovePendingItem(
        verification.toPath,
        "reason.identityMove.contentChanged",
      ));
    }
    identityResults.push({
      path: verification.toPath,
      outcome: equal ? "equal" : "different",
      proof,
      downloaded: downloadedThisRound,
    });
  }

  for (const replacement of identityReplacements) {
    const pendingReceipt = pendingByPath.get(replacement.path);
    let remoteHash = replacement.remote.sha256Hash?.toLowerCase();
    let proof: ContentEqualityProof = remoteHash
      ? "remoteSha256"
      : "insufficientEvidence";
    if (!remoteHash) {
      remoteHash = input.verifiedRemoteContentHashesById
        ?.get(replacement.remote.driveId)
        ?.toLowerCase();
      if (remoteHash) proof = "verifiedRemoteReceipt";
    }
    let downloadedThisRound = false;
    if (
      !remoteHash
      && replacement.local
      && contentDifferenceReceiptMatches(
        pendingReceipt,
        replacement.local,
        replacement.remote,
      )
    ) {
      remoteHash = pendingReceipt!.remoteHash.toLowerCase();
      proof = "downloadedSha256";
    }
    if (remoteHash) {
      identityCachedEvidence++;
    } else if (remainingDownloadBudget > 0) {
      remainingDownloadBudget--;
      identityDownloads++;
      downloadedThisRound = true;
      try {
        remoteHash = (
          await input.resolveRemoteContentHash({
            type: SyncActionType.Conflict,
            path: replacement.path,
            local: replacement.local,
            remote: replacement.remote,
            reason: "reason.identityReplacement.verificationPending",
          }, {
            current: identityDownloads,
            total: identityProgressTotal,
          })
        ).toLowerCase();
        proof = "downloadedSha256";
      } catch (error) {
        identityItems.push(identityReplacementPendingItem(replacement.path));
        identityResults.push({
          path: replacement.path,
          outcome: "failed",
          downloaded: true,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    } else {
      identityItems.push(identityReplacementPendingItem(replacement.path));
      continue;
    }

    const decision = classifyIdentityReplacementV2(
      replacement,
      remoteHash,
    );
    if ("baseUpsert" in decision) {
      identityBaseUpserts.push(decision.baseUpsert);
    } else {
      identityItems.push(decision.item);
    }
    identityResults.push({
      path: replacement.path,
      outcome: remoteHash === replacement.base.hash
        && replacement.remote.size === replacement.base.size
        ? "equal"
        : "different",
      proof,
      downloaded: downloadedThisRound,
    });
  }

  const candidates = items.filter((item) => {
    if (
      item.type !== SyncActionType.Conflict
      || (
        item.reason !== "reason.newFileBothSides"
        && item.reason !== "reason.bothSidesModified"
      )
      || !item.local
      || !item.remote
      || item.local.size !== item.remote.size
    ) {
      return false;
    }
    const equality = resolveContentEquality({
      local: item.local,
      remote: item.remote,
      base: baseByPath.get(item.path),
      verifiedRemoteHash: input.verifiedRemoteContentHashesById
        ?.get(item.remote.driveId),
    });
    if (equality.status !== "unknown") return true;
    const receipt = pendingByPath.get(item.path);
    if (contentDifferenceReceiptMatches(
      receipt,
      item.local,
      item.remote,
    )) {
      item.contentComparison = receipt;
      return false;
    }
    return true;
  });
  const evidenceCandidates = candidates.filter((item) =>
    resolveContentEquality({
      local: item.local!,
      remote: item.remote!,
      base: baseByPath.get(item.path),
      verifiedRemoteHash: input.verifiedRemoteContentHashesById
        ?.get(item.remote!.driveId),
    }).status !== "unknown");
  const evidencePaths = new Set(
    evidenceCandidates.map((item) => item.path),
  );
  const maxDownloads = input.baselineReconstructionIncomplete
    ? candidates.length
    : remainingDownloadBudget;
  const downloadCandidates = candidates
    .filter((item) => !evidencePaths.has(item.path))
    .slice(0, maxDownloads);
  const selectedCandidates = [
    ...evidenceCandidates,
    ...downloadCandidates,
  ];
  const falseConflicts = new Set<string>();
  const baseUpserts: BaseFileEntry[] = [...identityBaseUpserts];
  const results: ContentVerificationResultV2[] = [];

  for (let index = 0; index < selectedCandidates.length; index++) {
    const item = selectedCandidates[index]!;
    const local = item.local!;
    const remote = item.remote!;
    let equality = resolveContentEquality({
      local,
      remote,
      base: baseByPath.get(item.path),
      verifiedRemoteHash: input.verifiedRemoteContentHashesById
        ?.get(remote.driveId),
    });
    let downloadedHash: string | undefined;
    try {
      if (equality.status === "unknown") {
        downloadedHash = await input.resolveRemoteContentHash(item, {
          current: index + 1,
          total: selectedCandidates.length,
        });
        equality = resolveContentEquality({
          local,
          remote,
          base: baseByPath.get(item.path),
          downloadedHash,
        });
      }
      if (equality.status === "equal") {
        falseConflicts.add(item.path);
        baseUpserts.push({
          path: item.path,
          hash: local.hash,
          size: local.size,
          eTag: remote.eTag,
        });
      } else if (downloadedHash) {
        item.contentComparison = createContentDifferenceReceipt(
          local,
          remote,
          downloadedHash,
        );
      }
      results.push({
        path: item.path,
        outcome: equality.status === "equal" ? "equal" : "different",
        proof: equality.proof,
        downloaded: downloadedHash !== undefined,
      });
    } catch (error) {
      results.push({
        path: item.path,
        outcome: "failed",
        downloaded: downloadedHash !== undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (falseConflicts.size > 0) {
    items = items.filter((item) => !falseConflicts.has(item.path));
  }
  items = [...identityItems, ...items];
  items = applyAutomaticHandlingPolicy(
    items,
    input.automaticHandlingPolicy,
  );
  items = bindCanonicalDecisionTokensV2(items, {
    envelope: input.envelope,
    vaultName: input.vaultName,
    accountId: input.accountId,
  });
  const requiresThresholdConfirmation =
    shouldPauseCanonicalPlanForReviewV2(
      summarizeCanonicalPlanReviewV2(items).impactCount,
      input.candidate.lastTotalFiles,
    );

  return {
    ...input.candidate,
    items,
    baseUpserts,
    contentVerification: {
      candidates:
        identityCandidateCount
        + candidates.length,
      cachedEvidence:
        identityCachedEvidence
        + evidenceCandidates.length,
      downloads:
        identityDownloads
        + downloadCandidates.length,
      skippedDownloads:
        identityCandidateCount
        - identityCachedEvidence
        - identityDownloads
        + candidates.length
        - evidenceCandidates.length
        - downloadCandidates.length,
      results: [...identityResults, ...results],
    },
    requiresThresholdConfirmation,
  };
}

function classifyIdentityReplacementV2(
  replacement: CanonicalIdentityReplacementV2,
  remoteHash: string,
): { baseUpsert: BaseFileEntry } | { item: SyncPlanItem } {
  const { local, remote, base, path } = replacement;
  const normalizedRemoteHash = remoteHash.toLowerCase();
  const remoteMatchesBase =
    remote.size === base.size
    && normalizedRemoteHash === base.hash;
  const remoteWithHash: RemoteFileEntry = {
    ...remote,
    sha256Hash: normalizedRemoteHash,
  };

  if (!local) {
    if (isObsidianManagedConfigPath(path)) {
      return {
        item: {
          type: SyncActionType.Download,
          path,
          remote: remoteWithHash,
        },
      };
    }
    if (remoteMatchesBase) {
      return {
        item: {
          type: SyncActionType.DeleteRemote,
          path,
          remote: remoteWithHash,
          reason: "reason.fileDeletedLocally",
        },
      };
    }
    return {
      item: {
        type: SyncActionType.Conflict,
        path,
        remote: remoteWithHash,
        reason: "reason.localDeletedRemoteModified",
      },
    };
  }

  const localMatchesBase =
    local.hash === base.hash
    && local.size === base.size;
  const localMatchesRemote =
    local.hash === normalizedRemoteHash
    && local.size === remote.size;

  if (localMatchesRemote) {
    return {
      baseUpsert: {
        path,
        hash: local.hash,
        size: local.size,
        eTag: remote.eTag,
      },
    };
  }
  if (!localMatchesBase && remoteMatchesBase) {
    return {
      item: {
        type: SyncActionType.Upload,
        path,
        local,
        remote: remoteWithHash,
        baseEtag: remote.eTag,
      },
    };
  }
  if (localMatchesBase && !remoteMatchesBase) {
    return {
      item: {
        type: SyncActionType.Download,
        path,
        local,
        remote: remoteWithHash,
      },
    };
  }
  return {
    item: {
      type: SyncActionType.Conflict,
      path,
      local,
      remote: remoteWithHash,
      reason: "reason.bothSidesModified",
    },
  };
}

function identityReplacementPendingItem(path: string): SyncPlanItem {
  return {
    type: SyncActionType.FolderDeferred,
    path,
    reason: "reason.identityReplacement.verificationPending",
  };
}

type IdentityRenameConflictReasonV2 = Extract<
  IdentityRenameActionV2,
  { type: "conflict" }
>["reason"];

function identityMoveConflictReason(
  reason: IdentityRenameConflictReasonV2,
): string {
  switch (reason) {
    case "local-destination-occupied":
      return "reason.identityMove.localTargetOccupied";
    case "remote-destination-occupied":
      return "reason.identityMove.remoteTargetOccupied";
    case "remote-content-changed":
      return "reason.identityMove.contentChanged";
    case "both-paths-diverged":
      return "reason.identityMove.bothSidesChanged";
    case "local-identity-ambiguous":
      return "reason.identityMove.multipleCandidates";
    case "destination-parent-missing":
      return "reason.identityMove.parentUnavailable";
    default:
      return "reason.identityMove.deferred";
  }
}

function identityMovePendingItem(
  path: string,
  reason: string,
): SyncPlanItem {
  return {
    type: SyncActionType.FolderDeferred,
    path,
    reason,
  };
}

/**
 * Seal the only executable V2 plan identity.
 *
 * Content-equality reads may legitimately add exact base anchors after the
 * candidate was finalized. That one transition is accepted only when the
 * committed envelope is exactly the state-controller projection of those
 * upserts and no surviving action overlaps the reconciled paths. Any other
 * revision change fails closed.
 */
export function sealCanonicalPlanV2(
  input: SealCanonicalPlanInputV2,
): SealedCanonicalPlanV2 {
  validateEnvelope(input.sourceEnvelope);
  validateEnvelope(input.committedEnvelope);
  assertCandidateMatchesEnvelope(input.finalized, input.sourceEnvelope);
  if (input.finalized.status !== "planned") {
    throw new Error("Rejected canonical plans cannot be sealed");
  }
  if (!sameEnvelopeScope(input.sourceEnvelope, input.committedEnvelope)) {
    throw new Error("Canonical plan scope changed before sealing");
  }

  const reconciledPaths = new Set(
    input.finalized.baseUpserts.map((entry) =>
      normalizeRemotePathKey(entry.path)),
  );
  for (const item of input.finalized.items) {
    if ([item.path, item.renameFrom]
      .filter((path): path is string => Boolean(path))
      .some((path) => reconciledPaths.has(normalizeRemotePathKey(path)))) {
      throw new Error(
        `Canonical plan still acts on a reconciled path: ${item.path}`,
      );
    }
    if (
      isFolderPlanAction(item.type)
      && [...reconciledPaths].some((path) =>
        isAtOrBelowPath(path, normalizeRemotePathKey(item.path))
        || (
          item.renameFrom !== undefined
          && isAtOrBelowPath(
            path,
            normalizeRemotePathKey(item.renameFrom),
          )
        ))
    ) {
      throw new Error(
        `Canonical folder action overlaps a reconciled path: ${item.path}`,
      );
    }
  }

  const baseEnvelope = upsertBaseStateEnvelopeV2(
    input.sourceEnvelope,
    input.finalized.baseUpserts,
    input.committedEnvelope.meta.committedAt,
  );
  let expectedEnvelope = attachBaseAncestorHashesV2(
    input.sourceEnvelope,
    baseEnvelope,
    input.finalized.baseUpserts,
    input.ancestorHashesByPath ?? {},
    input.committedEnvelope.meta.committedAt,
  );
  if (input.unpublishedMigrationCandidate) {
    if (
      input.sourceEnvelope.meta.commitSeq !== 1
      || input.committedEnvelope.meta.commitSeq !== 1
      || JSON.stringify(input.sourceEnvelope.meta)
        !== JSON.stringify(input.committedEnvelope.meta)
    ) {
      throw new Error(
        "Unpublished migration reconciliation is not the first exact candidate",
      );
    }
    expectedEnvelope = {
      ...expectedEnvelope,
      meta: { ...input.sourceEnvelope.meta },
    };
  }
  if (!sameSealingEnvelope(expectedEnvelope, input.committedEnvelope)) {
    throw new Error(
      "Canonical plan source changed outside its verified base reconciliation",
    );
  }

  const items = orderCanonicalPlanItemsV2(input.finalized.items);
  const sourceCommitSeq = input.committedEnvelope.meta.commitSeq;
  const canonicalReview = summarizeCanonicalPlanReviewV2(items);
  const digest = canonicalPlanDigestV2({
    items,
    lastTotalFiles: input.finalized.lastTotalFiles,
    scope: input.committedEnvelope.scope,
    sourceCommitSeq,
  });
  return {
    ...input.finalized,
    sourceCommitSeq,
    scope: { ...input.committedEnvelope.scope },
    items,
    requiresThresholdConfirmation:
      shouldPauseCanonicalPlanForReviewV2(
        canonicalReview.impactCount,
        input.finalized.lastTotalFiles,
      ),
    canonicalIdentity: {
      version: 2,
      scope: { ...input.committedEnvelope.scope },
      sourceCommitSeq,
      digest,
    },
    canonicalReview,
  };
}

export function canonicalPlanDigestV2(input: {
  items: readonly SyncPlanItem[];
  lastTotalFiles: number;
  scope: SyncScope;
  sourceCommitSeq: number;
}): string {
  return JSON.stringify({
    version: 2,
    sourceCommitSeq: input.sourceCommitSeq,
    scope: [
      input.scope.accountId,
      input.scope.driveId,
      input.scope.vaultFolderId,
      input.scope.filesRootId,
    ],
    lastTotalFiles: input.lastTotalFiles,
    items: input.items.map(canonicalPlanItemFactsV2),
  });
}

export function summarizeCanonicalPlanReviewV2(
  items: readonly SyncPlanItem[],
): CanonicalPlanReviewV2 {
  const counts = {
    uploads: 0,
    downloads: 0,
    folders: 0,
    deletes: 0,
    conflicts: 0,
    skipped: 0,
  };
  let impactCount = 0;
  for (const item of items) {
    if (item.type === SyncActionType.Upload) counts.uploads++;
    if (item.type === SyncActionType.Download) counts.downloads++;
    if (
      item.type === SyncActionType.RecreateRemoteScope
      ||
      item.type === SyncActionType.CreateRemoteFolder
      || item.type === SyncActionType.CreateLocalFolder
      || item.type === SyncActionType.MoveRemoteFolder
      || item.type === SyncActionType.MoveLocalFolder
    ) counts.folders++;
    if (
      item.type === SyncActionType.DeleteRemote
      || item.type === SyncActionType.DeleteLocal
      || item.type === SyncActionType.ConfirmLocalDelete
      || item.type === SyncActionType.DeleteRemoteFolder
      || item.type === SyncActionType.DeleteLocalFolder
    ) counts.deletes++;
    if (item.type === SyncActionType.Conflict) counts.conflicts++;
    if (
      item.type === SyncActionType.SkipLargeFile
      || item.type === SyncActionType.SkipIgnoredPath
    ) counts.skipped++;
    if (countsForCanonicalReviewImpact(item.type)) {
      impactCount += Math.max(1, item.reviewImpactCount ?? 1);
    }
  }
  return { counts, impactCount };
}

export function orderCanonicalPlanItemsV2(
  items: readonly SyncPlanItem[],
): SyncPlanItem[] {
  return items.map(clonePlanItem).sort((left, right) => {
    const priority = canonicalActionPriority(left.type)
      - canonicalActionPriority(right.type);
    if (priority !== 0) return priority;
    if (isFolderCreateAction(left.type) && isFolderCreateAction(right.type)) {
      const depth = folderPathDepth(left.path) - folderPathDepth(right.path);
      if (depth !== 0) return depth;
    }
    if (isFolderMoveAction(left.type) && isFolderMoveAction(right.type)) {
      const depth = folderPathDepth(left.renameFrom ?? left.path)
        - folderPathDepth(right.renameFrom ?? right.path);
      if (depth !== 0) return depth;
    }
    if (isFolderDeleteAction(left.type) && isFolderDeleteAction(right.type)) {
      const depth = folderPathDepth(right.path) - folderPathDepth(left.path);
      if (depth !== 0) return depth;
    }
    return normalizeRemotePathKey(left.path).localeCompare(
      normalizeRemotePathKey(right.path),
    ) || left.type.localeCompare(right.type)
      || (left.renameFrom ?? "").localeCompare(right.renameFrom ?? "");
  });
}

function projectCanonicalFileFactsV2(
  envelope: SyncStateEnvelopeV2,
  includeFilePath: (path: string) => boolean,
): {
  remoteEntries: RemoteFileEntry[];
  baseEntries: BaseFileEntry[];
} {
  return projectCanonicalFileFactsFromStateV2(
    canonicalPlannerStateFromEnvelopeV2(envelope),
    includeFilePath,
  );
}

function projectCanonicalFileFactsFromStateV2(
  state: CanonicalPlannerStateV2,
  includeFilePath: (path: string) => boolean,
): {
  remoteEntries: RemoteFileEntry[];
  baseEntries: BaseFileEntry[];
} {
  const remoteEntries = state.remoteFiles
    .filter((entry) => includeFilePath(entry.path))
    .map((entry) => ({ ...entry }))
    .sort(comparePath);
  const baseEntries = state.baseFiles
    .filter((entry) => includeFilePath(entry.path))
    .map((entry) => ({ ...entry }))
    .sort(comparePath);
  return { remoteEntries, baseEntries };
}

function bindCanonicalDecisionTokensV2(
  items: readonly SyncPlanItem[],
  input: {
    envelope: SyncStateEnvelopeV2;
    vaultName: string;
    accountId: string;
  },
): SyncPlanItem[] {
  const ancestorByPath = new Map(
    Object.values(input.envelope.anchors.byAnchorId).map((anchor) => [
      anchor.lastPath,
      anchor.contentHash,
    ]),
  );
  return items.map((item) =>
    item.type === SyncActionType.Conflict
      || item.type === SyncActionType.ConfirmLocalDelete
      ? {
          ...item,
          decisionToken: {
            version: 1,
            vaultName: input.vaultName,
            accountId: input.accountId,
            scope: { ...input.envelope.scope },
            local: item.local
              ? {
                  exists: true,
                  hash: item.local.hash,
                  size: item.local.size,
                }
              : { exists: false },
            remote: item.remote
              ? {
                  exists: true,
                  driveId: item.remote.driveId,
                  eTag: item.remote.eTag,
                }
              : { exists: false },
            ancestorHash: ancestorByPath.get(item.path) ?? null,
          },
        }
      : item,
  );
}

function assertCandidateMatchesEnvelope(
  candidate: CanonicalPlanCandidateV2,
  envelope: SyncStateEnvelopeV2,
): void {
  if (
    candidate.sourceCommitSeq !== envelope.meta.commitSeq
    || candidate.scope.accountId !== envelope.scope.accountId
    || candidate.scope.driveId !== envelope.scope.driveId
    || candidate.scope.vaultFolderId !== envelope.scope.vaultFolderId
    || candidate.scope.filesRootId !== envelope.scope.filesRootId
  ) {
    throw new Error(
      "Canonical plan candidate no longer matches its V2 envelope revision",
    );
  }
}

function clonePlanItem(item: SyncPlanItem): SyncPlanItem {
  return {
    ...item,
    ...(item.local ? { local: { ...item.local } } : {}),
    ...(item.remote ? { remote: { ...item.remote } } : {}),
    ...(item.folder ? { folder: { ...item.folder } } : {}),
    ...(item.decisionToken
      ? { decisionToken: structuredClone(item.decisionToken) }
      : {}),
    ...(item.contentComparison
      ? { contentComparison: { ...item.contentComparison } }
      : {}),
    ...(item.textMergeEvidence
      ? { textMergeEvidence: structuredClone(item.textMergeEvidence) }
      : {}),
  };
}

function emptyContentVerification(): CanonicalContentVerificationV2 {
  return {
    candidates: 0,
    cachedEvidence: 0,
    downloads: 0,
    skippedDownloads: 0,
    results: [],
  };
}

export function shouldPauseCanonicalPlanForReviewV2(
  impactCount: number,
  lastTotalFiles: number,
): boolean {
  return lastTotalFiles > 0
    && impactCount / lastTotalFiles > CHANGE_THRESHOLD_RATIO;
}

function countsForCanonicalReviewImpact(type: SyncActionType): boolean {
  return type !== SyncActionType.SkipLargeFile
    && type !== SyncActionType.SkipIgnoredPath
    && type !== SyncActionType.RetryLater
    && type !== SyncActionType.FolderDeferred
    && type !== SyncActionType.RenameRemote
    && type !== SyncActionType.Conflict
    && type !== SyncActionType.ConfirmLocalDelete;
}

function canonicalPlanItemFactsV2(item: SyncPlanItem): unknown[] {
  const token = item.decisionToken;
  const comparison = item.contentComparison;
  return [
    item.type,
    item.path,
    item.reason ?? null,
    item.local
      ? [
          item.local.path,
          item.local.hash,
          item.local.size,
          item.local.binary,
        ]
      : null,
    item.remote
      ? [
          item.remote.path,
          item.remote.driveId,
          item.remote.parentId,
          item.remote.size,
          item.remote.eTag,
          item.remote.cTag,
          item.remote.sha256Hash ?? null,
          item.remote.quickXorHash ?? null,
        ]
      : null,
    item.folder
      ? [
          item.folder.remoteId ?? null,
          item.folder.parentRemoteId ?? null,
          item.folder.parentPath,
          item.folder.remoteETag ?? null,
          item.folder.parentRemoteETag ?? null,
          item.folder.sourceParentRemoteId ?? null,
        ]
      : null,
    item.baseEtag ?? null,
    item.renameFrom ?? null,
    item.targetParentRemoteId ?? null,
    item.requiresConfirmation ?? false,
    item.reviewImpactCount ?? 1,
    token
      ? [
          token.version,
          token.vaultName,
          token.accountId,
          token.scope.accountId,
          token.scope.driveId,
          token.scope.vaultFolderId,
          token.scope.filesRootId,
          token.local.exists
            ? [true, token.local.hash, token.local.size]
            : [false],
          token.remote.exists
            ? [true, token.remote.driveId, token.remote.eTag]
            : [false],
          token.ancestorHash,
        ]
      : null,
    comparison
      ? [
          comparison.version,
          comparison.result,
          comparison.localHash,
          comparison.localSize,
          comparison.remoteDriveId,
          comparison.remoteETag,
          comparison.remoteSize,
          comparison.remoteHash,
        ]
      : null,
  ];
}

function sameEnvelopeScope(
  left: SyncStateEnvelopeV2,
  right: SyncStateEnvelopeV2,
): boolean {
  return sameSyncScope(left.scope, right.scope);
}

function sameSealingEnvelope(
  left: SyncStateEnvelopeV2,
  right: SyncStateEnvelopeV2,
): boolean {
  return JSON.stringify(sealingEnvelopeFacts(left))
    === JSON.stringify(sealingEnvelopeFacts(right));
}

function sealingEnvelopeFacts(envelope: SyncStateEnvelopeV2): unknown {
  return {
    meta: [
      envelope.meta.schemaVersion,
      envelope.meta.lifecycleEpoch,
      envelope.meta.commitSeq,
      envelope.meta.committedAt,
    ],
    scope: [
      envelope.scope.accountId,
      envelope.scope.driveId,
      envelope.scope.vaultFolderId,
      envelope.scope.filesRootId,
    ],
    remoteIndex: {
      schemaVersion: envelope.remoteIndex.schemaVersion,
      filesRootId: envelope.remoteIndex.filesRootId,
      cursorRevision: envelope.remoteIndex.cursorRevision,
      deltaLink: envelope.remoteIndex.deltaLink,
      complete: envelope.remoteIndex.complete,
      itemsById: Object.entries(envelope.remoteIndex.itemsById)
        .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
    },
    anchors: Object.entries(envelope.anchors.byAnchorId)
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
    folderAnchors: envelope.folderAnchors
      ? Object.entries(envelope.folderAnchors.byAnchorId)
          .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
      : null,
  };
}

function canonicalActionPriority(type: SyncActionType): number {
  switch (type) {
    case SyncActionType.RecreateRemoteScope:
    case SyncActionType.CreateLocalFolder:
    case SyncActionType.CreateRemoteFolder:
      return 0;
    case SyncActionType.MoveLocalFolder:
    case SyncActionType.MoveRemoteFolder:
      return 1;
    case SyncActionType.MoveLocalFile:
    case SyncActionType.RenameRemote:
      return 2;
    case SyncActionType.Upload:
    case SyncActionType.Download:
      return 3;
    case SyncActionType.SkipLargeFile:
    case SyncActionType.SkipIgnoredPath:
      return 4;
    case SyncActionType.RetryLater:
    case SyncActionType.FolderDeferred:
      return 5;
    case SyncActionType.Conflict:
      return 6;
    case SyncActionType.ConfirmLocalDelete:
      return 7;
    case SyncActionType.DeleteLocal:
    case SyncActionType.DeleteRemote:
      return 8;
    case SyncActionType.DeleteLocalFolder:
    case SyncActionType.DeleteRemoteFolder:
      return 9;
    case SyncActionType.AuthExpired:
      return 10;
    default:
      throw new Error(`Unsupported canonical action type: ${String(type)}`);
  }
}

function isFolderCreateAction(type: SyncActionType): boolean {
  return type === SyncActionType.CreateLocalFolder
    || type === SyncActionType.CreateRemoteFolder;
}

function isFolderMoveAction(type: SyncActionType): boolean {
  return type === SyncActionType.MoveLocalFolder
    || type === SyncActionType.MoveRemoteFolder;
}

function isFolderDeleteAction(type: SyncActionType): boolean {
  return type === SyncActionType.DeleteLocalFolder
    || type === SyncActionType.DeleteRemoteFolder;
}

function isFolderPlanAction(type: SyncActionType): boolean {
  return isFolderCreateAction(type)
    || isFolderMoveAction(type)
    || isFolderDeleteAction(type);
}

function toDeferredFolderPlanItem(
  path: string,
  reason?: FolderPlanConflictReasonV2,
): SyncPlanItem {
  return {
    type: SyncActionType.FolderDeferred,
    path,
    reason: reason
      ? `reason.folder.${reason}`
      : "reason.folder.deferred",
  };
}

function isFileMoveCarriedByFolderMove(
  fromPath: string,
  toPath: string,
  folderMoves: readonly { sourcePath: string; targetPath: string }[],
): boolean {
  return folderMoves.some((move) => {
    if (
      !isAtOrBelowPath(fromPath, move.sourcePath)
      || normalizeRemotePathKey(fromPath)
        === normalizeRemotePathKey(move.sourcePath)
    ) {
      return false;
    }
    const translated = `${move.targetPath}${fromPath.slice(
      move.sourcePath.length,
    )}`;
    return normalizeRemotePathKey(toPath)
      === normalizeRemotePathKey(translated);
  });
}

function projectFolderIdentitiesForMove(
  state: CanonicalPlannerStateV2,
  sourceRoot: string,
  targetRoot: string,
): Array<{ path: string; remoteId: string }> {
  return (state.folderAnchors ?? [])
    .filter((anchor) => isAtOrBelowPath(anchor.lastPath, sourceRoot))
    .map((anchor) => ({
      path: normalizeRemotePathKey(anchor.lastPath)
        === normalizeRemotePathKey(sourceRoot)
        ? targetRoot
        : `${targetRoot}${anchor.lastPath.slice(sourceRoot.length)}`,
      remoteId: anchor.remoteId,
    }));
}

/** Match OneDrive's case-insensitive namespace while preserving display paths. */
export function normalizeRemotePathKey(path: string): string {
  return normalizeVaultPathKey(path);
}

export function isAtOrBelowPath(path: string, root: string): boolean {
  const normalizedPath = normalizeRemotePathKey(path);
  const normalizedRoot = normalizeRemotePathKey(root);
  return normalizedPath === normalizedRoot
    || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function isProtectedFolderDeletePath(
  path: string,
  configDir: string,
): boolean {
  return isAtOrBelowPath(path, configDir);
}

export function parentFolderPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function folderPathDepth(path: string): number {
  return path.split("/").length;
}

function comparePath(
  left: { path: string },
  right: { path: string },
): number {
  return left.path.localeCompare(right.path);
}
