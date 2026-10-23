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
import { describeError, normalizeVaultPathKey } from "../obsidian-compat";
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
  applyOneWayLocalDeletedPullBackPlan,
  applyOneWayLocalOnlyCopyPlan,
  DEFAULT_SYNC_DIRECTION,
  forceRemoteFolderDeleteFollow,
  isExcludedFromOneWaySyncPath,
  suppressOutboundUserContentActions,
  type SyncDirection,
} from "./sync-direction";
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
import { isEasySyncInternalPath } from "./local-scanner";
import {
  isAnchoredDescendantV2,
  projectRemoteNodesV2,
  translateAnchoredPathV2,
} from "./remote-index-v2";
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
  type LocalFolderDeleteHintV1,
  type RemoteFileEntry,
  type SyncPlanItem,
  type SyncScope,
} from "./types";

const MAX_UNANCHORED_DESCENDANT_EVIDENCE = 10;

interface CanonicalPlanFactsV2 {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  skippedLarge: readonly string[];
  /** Device large-file exclusion threshold in bytes; absent disables the download gate. */
  maxFileSizeBytes?: number;
  localMoveHints?: readonly LocalFolderMoveHintV1[];
  localFolderDeleteHints?: readonly LocalFolderDeleteHintV1[];
  localFileMoveHints?: readonly LocalFolderMoveHintV1[];
  includeFilePath?: (path: string) => boolean;
  includeFolderPath?: (path: string) => boolean;
  preserveFolderPath?: (path: string) => boolean;
  configDir: string;
  automaticDeleteLocalFiles: boolean;
}

interface CanonicalPlanViewFactsV2
  extends Omit<CanonicalPlanFactsV2, "envelope"> {
  state: CanonicalPlannerStateV2;
}

interface CanonicalActionCompositionFactsV2
  extends Omit<CanonicalPlanViewFactsV2, "skippedLarge"> {
  fileItems: readonly SyncPlanItem[];
  lastTotalFiles: number;
}

type CanonicalPlanRejectionReasonV2 =
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

interface CanonicalIdentityReplacementV2 {
  anchorId: string;
  previousRemoteId: string;
  remoteId: string;
  path: string;
  local?: LocalFileEntry;
  remote: RemoteFileEntry;
  base: BaseFileEntry;
}

interface CanonicalIdentityMoveVerificationV2 {
  anchorId: string;
  remoteId: string;
  fromPath: string;
  toPath: string;
  local: LocalFileEntry;
  remote: RemoteFileEntry;
  base: BaseFileEntry;
}

interface PendingContentComparisonV2 {
  path: string;
  contentComparison?: ContentComparisonReceiptV1;
}

interface ContentVerificationResultV2 {
  path: string;
  outcome: "equal" | "different" | "failed";
  proof?: ContentEqualityProof;
  downloaded: boolean;
  error?: string;
}

interface CanonicalContentVerificationV2 {
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

interface SealedCanonicalPlanV2 extends FinalizedCanonicalPlanV2 {
  canonicalIdentity: CanonicalPlanIdentityV2;
  canonicalReview: CanonicalPlanReviewV2;
}

export interface FinalizeCanonicalPlanInputV2 {
  candidate: CanonicalPlanCandidateV2;
  envelope: SyncStateEnvelopeV2;
  vaultName: string;
  accountId: string;
  configDir: string;
  automaticHandlingPolicy: Readonly<AutomaticHandlingPolicy>;
  /**
   * Committed sync direction. Absent means two-way, which keeps every existing
   * caller and fixture on today's exact output. In one-way mode cloud-bound
   * user-content actions are dropped here (before decision tokens and the
   * review impact count) and the remote delete follow is forced on.
   */
  syncDirection?: SyncDirection;
  baselineReconstructionIncomplete: boolean;
  pendingContentComparisons?: readonly PendingContentComparisonV2[];
  verifiedRemoteContentHashesById?: ReadonlyMap<string, string>;
  resolveRemoteContentHash: (
    item: Readonly<SyncPlanItem>,
    progress: { current: number; total: number },
  ) => Promise<string>;
  /** Knife-1 (2026-09-08, carrier `docs/temp/20260908-1331`): optional
   *  planner-stage downloadUrl refresh for the *exact* budgeted verification
   *  download set (conflict-candidate downloads below). The planner invokes it
   *  at most once with those candidates before downloading; implementations
   *  fill `item.remote.downloadUrl` on the planner-owned clones (safe: the
   *  planner clones every candidate) only when returned metadata matched the
   *  planned remote id + eTag (mirror of the Step-3b universal-refresh
   *  contract). Fail-open: absent, throwing, or unfilled items keep the
   *  per-file waterfall refresh exactly as before — no behavior weakening. */
  refreshVerificationDownloadUrls?: (
    items: ReadonlyArray<SyncPlanItem>,
  ) => Promise<void>;
  /** Knife-2 (2026-09-08, carrier `docs/temp/20260908-1331`): optional
   *  bounded read-only window for plan-time content-verification downloads.
   *  When provided, the conflict-candidate downloads below run in windows of
   *  at most `maxFiles` files and `maxBytes` total bytes (a candidate larger
   *  than the byte budget downloads alone), while per-item decisions, budget
   *  accounting and receipts stay serial in the original loop order. Absent =
   *  strictly serial verification downloads (today's behavior). */
  verificationDownloadWindow?: {
    maxFiles: number;
    maxBytes: number;
  };
}

interface SealCanonicalPlanInputV2 {
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
    configDir: input.configDir,
    maxFileSizeBytes: input.maxFileSizeBytes,
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
interface CanonicalCarriedFolderMovesInputV2 {
  folderPlan: ReturnType<typeof planFolderStateFromViewV2>;
  state: CanonicalActionCompositionFactsV2["state"];
}

interface CanonicalCarriedFolderMovesV2 {
  carriedFolderMoves: Array<{ sourcePath: string; targetPath: string }>;
  projectedFolderIdentities: Array<{ path: string; remoteId: string }>;
}

/**
 * Collect the folder moves this plan already carries (source→target) and, for
 * every `move-remote`, the projected folder identities that move implies.
 * Extracted verbatim from `composeCanonicalActionsV2`（2026-10-16 第二期类内分解，
 * 逐 token 等价）。
 */
function collectCarriedFolderMovesV2({
  folderPlan,
  state,
}: CanonicalCarriedFolderMovesInputV2): CanonicalCarriedFolderMovesV2 {
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

  return { carriedFolderMoves, projectedFolderIdentities };
}

interface CanonicalPlanIndexesInputV2 {
  state: CanonicalActionCompositionFactsV2["state"];
  input: CanonicalActionCompositionFactsV2;
  folderPlan: ReturnType<typeof planFolderStateFromViewV2>;
}

interface CanonicalPlanIndexFactsV2 {
  remoteIdByPath: Map<string, string>;
  canonicalFolderPathById: Map<string, string>;
  plannedRemoteFolderPaths: Map<string, string>;
  remoteFilesById: Map<
    string,
    ReturnType<typeof projectCanonicalFileFactsFromStateV2>["remoteEntries"][number]
  >;
  plannedRemoteCreates: Set<string>;
}

/**
 * Build the lookup facts the per-item pass needs: folded remote path → id, the
 * canonical (byte-exact) spelling per folder identity, the planned spellings of
 * folders this same plan decided to create/move, the projected remote file facts
 * and the set of planned remote creates. Extracted verbatim from
 * `composeCanonicalActionsV2`（2026-10-16 第二期类内分解，逐 token 等价）。
 */
function buildCanonicalPlanIndexesV2({
  state,
  input,
  folderPlan,
}: CanonicalPlanIndexesInputV2): CanonicalPlanIndexFactsV2 {
  const remoteIdByPath = new Map(
    [...state.remotePathById]
      .map(([id, path]) => [normalizeRemotePathKey(path), id]),
  );
  // Canonical spelling per folder identity — the spelling a receipt must repeat
  // byte-for-byte. Identity resolution folds case/NFC (remoteIdByPath), but the
  // reducer asserts the destination parent path byte-for-byte
  // (`V2 folder parent path changed`), so the byte check needs the index
  // spelling, not the folded key.
  const canonicalFolderPathById = new Map<string, string>();
  for (const [id, path] of state.remotePathById) {
    if (state.remoteNodeById.get(id)?.kind === "folder") {
      canonicalFolderPathById.set(id, path);
    }
  }
  // Folder paths this same plan already decided to create/move: their intended
  // spelling is definitionally authoritative until the create commits, so a
  // child planned under a planned parent is judged against the planned
  // spelling instead of the folded key set.
  const plannedRemoteFolderPaths = new Map<string, string>();
  for (const item of folderPlan.items) {
    if (item.type === "create-remote" || item.type === "move-remote") {
      plannedRemoteFolderPaths.set(
        normalizeRemotePathKey(item.path),
        item.path,
      );
    }
  }
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

  return {
    remoteIdByPath,
    canonicalFolderPathById,
    plannedRemoteFolderPaths,
    remoteFilesById,
    plannedRemoteCreates,
  };
}

function composeCanonicalActionsV2(
  input: CanonicalActionCompositionFactsV2,
): CanonicalPlanCandidateV2 {
  const folderPlan = planFolderStateFromViewV2({
    state: input.state,
    localFiles: input.localFiles,
    localFolders: input.localFolders,
    localFolderScanComplete: input.localFolderScanComplete,
    localMoveHints: input.localMoveHints,
    localFolderDeleteHints: input.localFolderDeleteHints,
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
  const { carriedFolderMoves, projectedFolderIdentities } = collectCarriedFolderMovesV2({
    folderPlan,
    state,
  });

  // 索引与"逐字节规范拼写"来源见 buildCanonicalPlanIndexesV2 的同名注释
  // （folder identity 的规范拼写＝回执必须逐字节复述的那种写法）。
  const {
    remoteIdByPath,
    canonicalFolderPathById,
    plannedRemoteFolderPaths,
    remoteFilesById,
    plannedRemoteCreates,
  } = buildCanonicalPlanIndexesV2({ state, input, folderPlan });
  const createItems: SyncPlanItem[] = [];
  const moveItems: SyncPlanItem[] = [];
  const deleteItems: SyncPlanItem[] = [];
  const deferredItems: SyncPlanItem[] = [];
  const protectedRoots = new Set<string>();
  const unanchoredProtectedRoots = new Set<string>();
  const otherProtectedRoots = new Set<string>();

  for (const item of folderPlan.items) {
    applyFolderPlanItemV2({
      item,
      state,
      remoteIdByPath,
      canonicalFolderPathById,
      plannedRemoteFolderPaths,
      plannedRemoteCreates,
      configDir: input.configDir,
      automaticDeleteLocalFiles: input.automaticDeleteLocalFiles,
      createItems,
      moveItems,
      deleteItems,
      deferredItems,
      protectedRoots,
      unanchoredProtectedRoots,
      otherProtectedRoots,
    });
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

  // Slice-2: a file whose recorded out-of-scope destination is positively
  // outside the sync scope (and not the vault trash) must not silently fall
  // into the "local disappearance == deletion" path. Hold its remote deletion
  // as a reviewable scope-crossing deferral until the user undoes the move or
  // confirms leaving sync. Trash destinations and destinations that are back
  // in scope keep their ordinary semantics.
  const fileScopeCrossingHoldPaths = collectFileScopeCrossingHolds(
    input.localFileMoveHints ?? [],
    state,
    input.includeFilePath ?? (() => true),
    input.configDir,
  );
  if (fileScopeCrossingHoldPaths.size > 0) {
    const heldFileItems: SyncPlanItem[] = [];
    for (const candidate of fileItems) {
      if (
        candidate.type === SyncActionType.DeleteRemote
        && fileScopeCrossingHoldPaths.has(normalizeRemotePathKey(candidate.path))
      ) {
        deferredItems.push({
          type: SyncActionType.FolderDeferred,
          path: candidate.path,
          reason: "reason.file.scope-crossing",
        });
      } else {
        heldFileItems.push(candidate);
      }
    }
    fileItems = heldFileItems;
  }

  const includeFilePath = input.includeFilePath ?? (() => true);
  const identityResult = applyIdentityRenameActionsV2({
    state,
    localFiles: input.localFiles,
    projectedFolderIdentities,
    includeFilePath,
    carriedFolderMoves,
    remoteFilesById,
    protectedRoots,
    fileItems,
    deferredItems,
  });
  fileItems = identityResult.fileItems;
  const {
    identityItems,
    identityReplacements,
    identityMoveVerifications,
  } = identityResult;

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
 * Apply one planned folder action to the composed folder decision arrays.
 *
 * A create, move or delete either joins its action array or becomes a
 * per-action deferral; every decomposed item path additionally joins the
 * protected-root sets the later file filtering and descendant-evidence
 * steps consult. The caller's containers are threaded by reference and no
 * binding is reassigned, so a terminal per-item outcome is a plain return.
 */
type CanonicalFolderPlanItemV2 = Parameters<typeof applyFolderPlanItemV2>[0]["item"];

interface ApplyCreateRemoteFolderItemInputV2 {
  item: CanonicalFolderPlanItemV2;
  state: Parameters<typeof applyFolderPlanItemV2>[0]["state"];
  remoteIdByPath: ReadonlyMap<string, string>;
  canonicalFolderPathById: ReadonlyMap<string, string>;
  plannedRemoteCreates: ReadonlySet<string>;
  plannedRemoteFolderPaths: ReadonlyMap<string, string>;
  createItems: SyncPlanItem[];
  deferredItems: SyncPlanItem[];
}

/**
 * `create-remote` folder items: resolve the parent identity through the folded
 * key, defer while the parent chain is incomplete, and — A1「乙」(2026-10-16) —
 * withhold the create while the parent path is only a **spelling alias** of the
 * index spelling (the receipt must repeat it byte-for-byte, otherwise the
 * reducer throws `V2 folder parent path changed`). Extracted verbatim from
 * `applyFolderPlanItemV2`（2026-10-16 第二期类内分解，逐 token 等价；块内三处
 * `return;` 原样保留，语义不变）。
 */
function applyCreateRemoteFolderItemV2({
  item,
  state,
  remoteIdByPath,
  canonicalFolderPathById,
  plannedRemoteCreates,
  plannedRemoteFolderPaths,
  createItems,
  deferredItems,
}: ApplyCreateRemoteFolderItemInputV2): void {
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
    return;
  }
  // A1 乙 (2026-10-16): the parent identity above is resolved through the
  // folded key (NFC + case), but the receipt must repeat the index spelling
  // byte-for-byte — `V2 folder parent path changed` is otherwise thrown when
  // the create commits (field shape: index `videos/`, local `Videos/`).
  // Withhold the create while the parent is only a spelling alias (root is
  // exempt; a parent planned in this same plan is not).
  const createParentCanonicalPath = parent === ""
    ? ""
    : parentRemoteId
      ? canonicalFolderPathById.get(parentRemoteId)
        ?? plannedRemoteFolderPaths.get(normalizeRemotePathKey(parent))
      : plannedRemoteFolderPaths.get(normalizeRemotePathKey(parent));
  if (
    createParentCanonicalPath !== undefined
    && createParentCanonicalPath !== parent
  ) {
    deferredItems.push(toDeferredFolderPlanItem(
      item.path,
      "parent-chain-incomplete",
    ));
    return;
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
  return;
}

type CanonicalFolderMoveItemV2 =
  Omit<CanonicalFolderPlanItemV2, "remoteId" | "sourcePath" | "targetPath"> & {
    remoteId: string;
    sourcePath: string;
    targetPath: string;
  };

interface ApplyFolderMoveItemInputV2 {
  item: CanonicalFolderMoveItemV2;
  state: Parameters<typeof applyFolderPlanItemV2>[0]["state"];
  remoteIdByPath: ReadonlyMap<string, string>;
  plannedRemoteCreates: ReadonlySet<string>;
  canonicalFolderPathById: ReadonlyMap<string, string>;
  plannedRemoteFolderPaths: ReadonlyMap<string, string>;
  moveItems: SyncPlanItem[];
  deferredItems: SyncPlanItem[];
  protectedRoots: Set<string>;
  otherProtectedRoots: Set<string>;
}

/**
 * `move-remote` / `move-local` folder items: defer while the anchor or the
 * destination parent chain is unusable, then — A1「乙」(2026-10-16) — withhold
 * the move while the destination parent path is only a **spelling alias** of the
 * index spelling; otherwise emit the folder move and protect both roots.
 * Extracted verbatim from `applyFolderPlanItemV2`（2026-10-16 第二期类内分解，
 * 逐 token 等价；块内四处 `return;` 原样保留）。
 */
function applyFolderMoveItemV2({
  item,
  state,
  remoteIdByPath,
  plannedRemoteCreates,
  canonicalFolderPathById,
  plannedRemoteFolderPaths,
  moveItems,
  deferredItems,
  protectedRoots,
  otherProtectedRoots,
}: ApplyFolderMoveItemInputV2): void {
  const remoteNode = state.remoteNodeById.get(item.remoteId);
  const anchor = state.folderAnchorByRemoteId.get(item.remoteId);
  if (!remoteNode || remoteNode.kind !== "folder" || !anchor) {
    deferredItems.push(toDeferredFolderPlanItem(
      item.path,
      "parent-chain-incomplete",
    ));
    return;
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
    return;
  }
  // A1 乙 (2026-10-16) — same byte-exact spelling gate as the create-remote
  // branch above: the destination parent identity is resolved through the
  // folded key, while the receipt records `item.targetPath` (local spelling)
  // and the reducer asserts the parent path byte-for-byte, so a move whose
  // destination parent is only a spelling alias must not be emitted (field
  // shape: anchor `videos/Notes`, local parent `Videos`). Root is exempt; a
  // parent moved/created in this same plan is judged by the planned spelling.
  const moveParentCanonicalPath = parent === ""
    ? ""
    : parentRemoteId
      ? canonicalFolderPathById.get(parentRemoteId)
        ?? plannedRemoteFolderPaths.get(normalizeRemotePathKey(parent))
      : plannedRemoteFolderPaths.get(normalizeRemotePathKey(parent));
  if (
    moveParentCanonicalPath !== undefined
    && moveParentCanonicalPath !== parent
  ) {
    deferredItems.push(toDeferredFolderPlanItem(
      item.path,
      "parent-chain-incomplete",
    ));
    return;
  }
  // F29 切片 1 (2026-10-16) — descendant projection gate, the same invariant
  // the reducer enforces when it commits this folder-move receipt
  // (`folder-state-reducer-v2.ts`: the receipt's folder upsert is applied to the
  // committed index, and every file anchor below the source path must then
  // project to the mechanical translation). When the cloud re-organized the
  // subtree itself — a descendant re-parented, its identity replaced, or the
  // anchor tombstoned — that assertion is unsatisfiable and the receipt would
  // never commit: the record stays at `receiptPendingCommit` and every later
  // round dies in the recovery step (field case 2026-10-16, Android 1.5.9:
  // whole-vault stall, no exit, reset only). Withhold the move instead: the
  // descendants reconcile through the ordinary file layer first, and the next
  // round emits this move against an aligned subtree, so the folder location
  // still converges — one round later and without a stuck record.
  //
  // Ask the question exactly the way the reducer will: patch the moved node
  // with the receipt facts and project that. For `move-remote` the remote has
  // not moved yet, so the current index alone would answer wrong (every
  // descendant would look diverged). A destination parent created in this same
  // plan has no identity yet — there the gate stays open and the reducer
  // judges the committed result, as before.
  if (parentRemoteId !== undefined) {
    const movedName = item.targetPath.slice(item.targetPath.lastIndexOf("/") + 1);
    const patchedPathById = projectRemoteNodesV2(
      state.remoteNodes.map((node) => node.id === item.remoteId
        ? { ...node, parentId: parentRemoteId, name: movedName }
        : node),
      state.scope.filesRootId,
    ).pathById;
    for (const anchor of state.fileAnchors) {
      if (!isAnchoredDescendantV2(anchor.lastPath, item.sourcePath)) continue;
      const translatedDescendant = translateAnchoredPathV2(
        anchor.lastPath,
        item.sourcePath,
        item.targetPath,
      );
      if (
        !anchor.remoteId
        || patchedPathById.get(anchor.remoteId) !== translatedDescendant
      ) {
        deferredItems.push(toDeferredFolderPlanItem(
          item.path,
          "remote-subtree-changed",
        ));
        return;
      }
    }
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
  return;
}

function applyFolderPlanItemV2(args: {
  item: FolderStatePlanV2["items"][number];
  state: CanonicalPlannerStateV2;
  remoteIdByPath: Map<string, string>;
  canonicalFolderPathById: ReadonlyMap<string, string>;
  plannedRemoteFolderPaths: ReadonlyMap<string, string>;
  plannedRemoteCreates: Set<string>;
  configDir: string;
  automaticDeleteLocalFiles: boolean;
  createItems: SyncPlanItem[];
  moveItems: SyncPlanItem[];
  deleteItems: SyncPlanItem[];
  deferredItems: SyncPlanItem[];
  protectedRoots: Set<string>;
  unanchoredProtectedRoots: Set<string>;
  otherProtectedRoots: Set<string>;
}): void {
  const {
    item,
    state,
    remoteIdByPath,
    canonicalFolderPathById,
    plannedRemoteFolderPaths,
    plannedRemoteCreates,
    configDir,
    automaticDeleteLocalFiles,
    createItems,
    moveItems,
    deleteItems,
    deferredItems,
    protectedRoots,
    unanchoredProtectedRoots,
    otherProtectedRoots,
  } = args;

  if (item.type === "create-remote") {
    applyCreateRemoteFolderItemV2({
      item,
      state,
      remoteIdByPath,
      canonicalFolderPathById,
      plannedRemoteCreates,
      plannedRemoteFolderPaths,
      createItems,
      deferredItems,
    });
    return;
  }

  if (item.type === "create-local" && item.remoteId) {
    const remoteNode = state.remoteNodeById.get(item.remoteId);
    if (!remoteNode || remoteNode.kind !== "folder") {
      deferredItems.push(toDeferredFolderPlanItem(
        item.path,
        "parent-chain-incomplete",
      ));
      return;
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
    return;
  }

  if (
    (item.type === "move-remote" || item.type === "move-local")
    && item.remoteId
    && item.sourcePath
    && item.targetPath
  ) {
    applyFolderMoveItemV2({
      // 上方守卫已证明这三个字段存在；TS 只收窄属性访问、不重定对象类型，
      // 故在此显式收窄（避免在搬移块里改写引用方式）。
      item: item as CanonicalFolderMoveItemV2,
      state,
      remoteIdByPath,
      plannedRemoteCreates,
      canonicalFolderPathById,
      plannedRemoteFolderPaths,
      moveItems,
      deferredItems,
      protectedRoots,
      otherProtectedRoots,
    });
    return;
  }

  if (
    (item.type === "delete-remote" || item.type === "delete-local")
    && item.remoteId
  ) {
    const anchor = state.folderAnchorByRemoteId.get(item.remoteId);
    if (
      !anchor
      || isProtectedFolderDeletePath(item.path, configDir)
    ) {
      deferredItems.push(toDeferredFolderPlanItem(
        item.path,
        anchor ? "scope-crossing" : "parent-chain-incomplete",
      ));
      return;
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
        && !automaticDeleteLocalFiles
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
    return;
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

/**
 * Apply the identity-rename decisions planned from the same state revision to
 * the composed file and folder decision arrays.
 *
 * Each planned action either joins the plan (rename / move items, same-path
 * identity replacements, move verifications) or becomes a per-action deferral;
 * file items an identity decision owns are dropped from the ordinary file
 * decisions in the same iteration order as before. Returns the updated file
 * items plus the identity products the candidate is composed from.
 */
type IdentityRenameActionItemV2 = ReturnType<typeof planIdentityRenamesFromStateV2>[number];
type VerifyMoveLocalIdentityActionV2 = Extract<
  IdentityRenameActionItemV2,
  { type: "verify-move-local" }
>;

interface ApplyVerifyMoveLocalIdentityActionInputV2 {
  action: VerifyMoveLocalIdentityActionV2;
  state: Parameters<typeof applyIdentityRenameActionsV2>[0]["state"];
  localFiles: Parameters<typeof applyIdentityRenameActionsV2>[0]["localFiles"];
  remoteFilesById: ReadonlyMap<
    string,
    ReturnType<typeof projectCanonicalFileFactsFromStateV2>["remoteEntries"][number]
  >;
  deferredItems: SyncPlanItem[];
  identityMoveVerifications: CanonicalIdentityMoveVerificationV2[];
  fileItems: SyncPlanItem[];
}

/**
 * `verify-move-local` identity actions: defer while the anchor/local/remote facts
 * no longer match, then drop the file items the move blocks and record the
 * verification. Returns the (possibly filtered) file items so the caller can
 * keep its `fileItems` binding. Extracted verbatim from
 * `applyIdentityRenameActionsV2`（2026-10-16 第二期类内分解；块内两处 `continue;`
 * 改为 `return fileItems;`，其余逐字符未改）。
 */
function applyVerifyMoveLocalIdentityActionV2({
  action,
  state,
  localFiles,
  remoteFilesById,
  deferredItems,
  identityMoveVerifications,
  fileItems,
}: ApplyVerifyMoveLocalIdentityActionInputV2): SyncPlanItem[] {
  const anchor = state.fileAnchorById.get(action.anchorId);
  const local = localFiles.find(
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
    return fileItems;
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
  return fileItems;
}

type IdentityConflictActionV2 = Extract<IdentityRenameActionItemV2, { type: "conflict" }>;

interface ApplyIdentityConflictActionInputV2 {
  action: IdentityConflictActionV2;
  protectedRoots: ReadonlySet<string>;
  fileItems: SyncPlanItem[];
  deferredItems: SyncPlanItem[];
}

/**
 * `conflict` identity actions: keep out of already-protected roots, preserve an
 * existing ordinary decision for the old cloud path when the local identity is
 * only ambiguous, otherwise drop the blocked file items and defer the identity
 * work. Returns the (possibly rewritten) file items so the caller can keep its
 * `fileItems` binding. Extracted verbatim from `applyIdentityRenameActionsV2`
 * （2026-10-16 第二期类内分解；块内四处 `continue;` 改为 `return fileItems;`，
 * 其余逐字符未改）。
 */
function applyIdentityConflictActionV2({
  action,
  protectedRoots,
  fileItems,
  deferredItems,
}: ApplyIdentityConflictActionInputV2): SyncPlanItem[] {
  if (
    [...protectedRoots].some((root) =>
      isAtOrBelowPath(action.path, root))
  ) return fileItems;
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
      return fileItems;
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
      return fileItems;
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
  return fileItems;
}

type ReconcileRemoteIdentityActionV2 = Extract<
  IdentityRenameActionItemV2,
  { type: "reconcile-remote-identity" }
>;

interface ApplyReconcileRemoteIdentityActionInputV2 {
  action: ReconcileRemoteIdentityActionV2;
  state: Parameters<typeof applyIdentityRenameActionsV2>[0]["state"];
  localFiles: Parameters<typeof applyIdentityRenameActionsV2>[0]["localFiles"];
  remoteFilesById: ReadonlyMap<
    string,
    ReturnType<typeof projectCanonicalFileFactsFromStateV2>["remoteEntries"][number]
  >;
  fileItems: SyncPlanItem[];
  deferredItems: SyncPlanItem[];
  identityReplacements: CanonicalIdentityReplacementV2[];
}

/**
 * `reconcile-remote-identity` identity actions: defer while the anchor/remote
 * facts no longer match, otherwise drop the file items at the replaced path and
 * record the identity replacement. Returns the (possibly filtered) file items so
 * the caller can keep its `fileItems` binding. Extracted verbatim from
 * `applyIdentityRenameActionsV2`（2026-10-16 第二期类内分解；块内两处 `continue;`
 * 改为 `return fileItems;`，其余逐字符未改）。
 */
function applyReconcileRemoteIdentityActionV2({
  action,
  state,
  localFiles,
  remoteFilesById,
  fileItems,
  deferredItems,
  identityReplacements,
}: ApplyReconcileRemoteIdentityActionInputV2): SyncPlanItem[] {
  const anchor = state.fileAnchorById.get(action.anchorId);
  const remote = remoteFilesById.get(action.remoteId);
  const local = localFiles.find(
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
    return fileItems;
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
  return fileItems;
}

function applyIdentityRenameActionsV2(args: {
  state: CanonicalPlannerStateV2;
  localFiles: readonly LocalFileEntry[];
  projectedFolderIdentities: readonly { path: string; remoteId: string }[];
  includeFilePath: (path: string) => boolean;
  carriedFolderMoves: readonly { sourcePath: string; targetPath: string }[];
  remoteFilesById: Map<string, RemoteFileEntry>;
  protectedRoots: Set<string>;
  fileItems: SyncPlanItem[];
  deferredItems: SyncPlanItem[];
}): {
  fileItems: SyncPlanItem[];
  identityItems: SyncPlanItem[];
  identityReplacements: CanonicalIdentityReplacementV2[];
  identityMoveVerifications: CanonicalIdentityMoveVerificationV2[];
} {
  const {
    state,
    localFiles,
    projectedFolderIdentities,
    includeFilePath,
    carriedFolderMoves,
    remoteFilesById,
    protectedRoots,
    deferredItems,
  } = args;
  let { fileItems } = args;
  const identityItems: SyncPlanItem[] = [];
  const identityReplacements: CanonicalIdentityReplacementV2[] = [];
  const identityMoveVerifications: CanonicalIdentityMoveVerificationV2[] = [];
  for (const action of planIdentityRenamesFromStateV2(
    state,
    localFiles,
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
      fileItems = applyIdentityConflictActionV2({
        action,
        protectedRoots,
        fileItems,
        deferredItems,
      });
      continue;
    }

    if (action.type === "verify-move-local") {
      fileItems = applyVerifyMoveLocalIdentityActionV2({
        action,
        state,
        localFiles,
        remoteFilesById,
        deferredItems,
        identityMoveVerifications,
        fileItems,
      });
      continue;
    }

    if (action.type === "reconcile-remote-identity") {
      fileItems = applyReconcileRemoteIdentityActionV2({
        action,
        state,
        localFiles,
        remoteFilesById,
        fileItems,
        deferredItems,
        identityReplacements,
      });
      continue;
    }

    const localPath = action.type === "move-remote"
      ? action.toPath
      : action.fromPath;
    const local = localFiles.find(
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
  return {
    fileItems,
    identityItems,
    identityReplacements,
    identityMoveVerifications,
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
interface SelectContentVerificationCandidatesInputV2 {
  items: SyncPlanItem[];
  baseByPath: ReadonlyMap<string, Parameters<typeof resolveContentEquality>[0]["base"]>;
  pendingByPath: ReadonlyMap<string, Parameters<typeof contentDifferenceReceiptMatches>[0]>;
  input: Parameters<typeof finalizeCanonicalPlanCandidateV2>[0];
  remainingDownloadBudget: number;
}

interface SelectedContentVerificationCandidatesV2 {
  candidates: SyncPlanItem[];
  evidenceCandidates: SyncPlanItem[];
  downloadCandidates: SyncPlanItem[];
  selectedCandidates: SyncPlanItem[];
}

/**
 * Pick the conflict candidates whose content equality is worth verifying: the
 * ones with unknown equality (minus those a pending receipt already explains,
 * whose receipt is stamped onto the item), the evidence-only subset, and the
 * budgeted download subset that follows. Extracted verbatim from
 * `finalizeCanonicalPlanCandidateV2`（2026-10-16 第二期类内分解，逐 token 等价）。
 */
function selectContentVerificationCandidatesV2({
  items,
  baseByPath,
  pendingByPath,
  input,
  remainingDownloadBudget,
}: SelectContentVerificationCandidatesInputV2): SelectedContentVerificationCandidatesV2 {
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

  return {
    candidates,
    evidenceCandidates,
    downloadCandidates,
    selectedCandidates,
  };
}

interface VerificationPrefetchInputV2 {
  downloadCandidates: SyncPlanItem[];
  input: Parameters<typeof finalizeCanonicalPlanCandidateV2>[0];
}

/**
 * Knife-1 (2026-09-08, carrier `docs/temp/20260908-1331`): planner-stage
 * downloadUrl refresh for exactly the budgeted verification download set.
 * Called at most once, before any content download below; fail-open — a
 * missing or throwing hook leaves every URL unset so the per-file waterfall
 * refresh behaves exactly as before batching. Extracted verbatim from
 * `finalizeCanonicalPlanCandidateV2`（2026-10-16 第二期类内分解，逐 token 等价）。
 */
async function refreshVerificationDownloadUrlsV2({
  downloadCandidates,
  input,
}: VerificationPrefetchInputV2): Promise<void> {
  if (downloadCandidates.length > 0 && input.refreshVerificationDownloadUrls) {
    try {
      await input.refreshVerificationDownloadUrls(downloadCandidates);
    } catch {
      // Fail-open by contract: never let an optimization hook change the
      // verification outcome; unrefreshed items keep the per-file waterfall.
    }
  }
}

/**
 * Knife-2 (2026-09-08, carrier `docs/temp/20260908-1331`): bounded
 * read-only overlap for the conflict-candidate verification downloads.
 * downloadCandidates is the exact budgeted set the loop below downloads
 * (every member has unknown equality by construction), so we may prefetch
 * them in windows of at most maxFiles files / maxBytes bytes while the
 * per-item decision loop below stays serial and consumes results in its
 * original order. Fail-open: a missing window keeps strictly serial
 * verification downloads (today's behavior); a member missing from the
 * prefetch map falls back to the original serial await. Extracted verbatim from
 * `finalizeCanonicalPlanCandidateV2`（2026-10-16 第二期类内分解，逐 token 等价）。
 */
async function prefetchVerificationDownloadHashesV2({
  downloadCandidates,
  input,
}: VerificationPrefetchInputV2): Promise<
  Map<string, { hash: string } | { error: unknown }>
> {
  const downloadWindow = input.verificationDownloadWindow;
  const prefetchedDownloadHashes = new Map<
    string,
    { hash: string } | { error: unknown }
  >();
  if (
    downloadWindow
    && downloadWindow.maxFiles >= 1
    && downloadWindow.maxBytes >= 1
    && downloadCandidates.length > 1
  ) {
    const windowMembers: SyncPlanItem[] = [];
    let windowBytes = 0;
    let prefetchedCount = 0;
    const flushWindow = async (): Promise<void> => {
      if (windowMembers.length === 0) return;
      await Promise.all(windowMembers.map(async (item, inside) => {
        try {
          const hash = await input.resolveRemoteContentHash(item, {
            current: prefetchedCount + inside + 1,
            total: downloadCandidates.length,
          });
          prefetchedDownloadHashes.set(item.path, { hash });
        } catch (error) {
          prefetchedDownloadHashes.set(item.path, { error });
        }
      }));
      prefetchedCount += windowMembers.length;
      windowMembers.length = 0;
      windowBytes = 0;
    };
    for (const item of downloadCandidates) {
      const bytes = item.remote?.size ?? item.local?.size ?? 0;
      if (
        windowMembers.length >= downloadWindow.maxFiles
        || (windowMembers.length > 0 && windowBytes + bytes > downloadWindow.maxBytes)
      ) {
        await flushWindow();
      }
      windowMembers.push(item);
      windowBytes += bytes;
    }
    await flushWindow();
  }

  return prefetchedDownloadHashes;
}

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
    const counters = await settleIdentityMoveVerificationV2({
      verification,
      verifiedRemoteContentHashesById: input.verifiedRemoteContentHashesById,
      resolveRemoteContentHash: input.resolveRemoteContentHash,
      identityItems,
      identityResults,
      identityProgressTotal,
      identityCachedEvidence,
      identityDownloads,
      remainingDownloadBudget,
    });
    identityCachedEvidence = counters.identityCachedEvidence;
    identityDownloads = counters.identityDownloads;
    remainingDownloadBudget = counters.remainingDownloadBudget;
  }

  for (const replacement of identityReplacements) {
    const counters = await settleIdentityReplacementVerificationV2({
      replacement,
      pendingByPath,
      verifiedRemoteContentHashesById: input.verifiedRemoteContentHashesById,
      resolveRemoteContentHash: input.resolveRemoteContentHash,
      configDir: input.configDir,
      identityItems,
      identityBaseUpserts,
      identityResults,
      identityProgressTotal,
      identityCachedEvidence,
      identityDownloads,
      remainingDownloadBudget,
    });
    identityCachedEvidence = counters.identityCachedEvidence;
    identityDownloads = counters.identityDownloads;
    remainingDownloadBudget = counters.remainingDownloadBudget;
  }

  const {
    candidates,
    evidenceCandidates,
    downloadCandidates,
    selectedCandidates,
  } = selectContentVerificationCandidatesV2({
    items,
    baseByPath,
    pendingByPath,
    input,
    remainingDownloadBudget,
  });
  await refreshVerificationDownloadUrlsV2({ downloadCandidates, input });
  const prefetchedDownloadHashes = await prefetchVerificationDownloadHashesV2({
    downloadCandidates,
    input,
  });
  const falseConflicts = new Set<string>();
  const baseUpserts: BaseFileEntry[] = [...identityBaseUpserts];
  const results: ContentVerificationResultV2[] = [];

  for (let index = 0; index < selectedCandidates.length; index++) {
    await settleSelectedCandidateVerificationV2({
      index,
      selectedCandidates,
      baseByPath,
      verifiedRemoteContentHashesById: input.verifiedRemoteContentHashesById,
      prefetchedDownloadHashes,
      resolveRemoteContentHash: input.resolveRemoteContentHash,
      falseConflicts,
      baseUpserts,
      results,
    });
  }

  if (falseConflicts.size > 0) {
    items = items.filter((item) => !falseConflicts.has(item.path));
  }
  items = [...identityItems, ...items];
  // 片①／片② 单向同步的单一挂点：改写与抑制都必须发生在决策令牌绑定
  // （bindCanonicalDecisionTokensV2）与审阅影响计数
  // （shouldPauseCanonicalPlanForReviewV2）之前，被拦掉的动作既不产生令牌也不
  // 抬高审阅门槛。顺序＝先把本机改动/无基线同名改写成"留副本＋云端接管"的下载
  // （片②），再丢弃其余出站动作（片①）。单向模式下删除跟随强制恒开——文件级
  // 口径即 `autoDeleteLocalFiles = true` 的等效行为（applyAutomaticHandlingPolicy
  // 是它唯一的功能性应用点）；目录级标记在建计划期就已由该开关决定，只能在这里
  // 清掉（SkipLargeFile 等其余标记一律不动）。
  const oneWay = (input.syncDirection ?? DEFAULT_SYNC_DIRECTION) === "one-way";
  if (oneWay) {
    items = applyOneWayLocalOnlyCopyPlan(items, input.configDir);
    items = applyOneWayLocalDeletedPullBackPlan(items, input.configDir);
    items = suppressOutboundUserContentActions(items, input.configDir);
    items = forceRemoteFolderDeleteFollow(items, input.configDir);
  }
  items = applyAutomaticHandlingPolicy(
    items,
    oneWay
      ? { ...input.automaticHandlingPolicy, autoDeleteLocalFiles: true }
      : input.automaticHandlingPolicy,
    input.configDir,
    // 排除块的"本机跟随云端删除"仍按双向裁决（配置白名单目录 owner 也在内）：
    // 强制跟随只落在模式自己的范围上，与上面的目录标记同一判定。
    oneWay
      ? (path) => isExcludedFromOneWaySyncPath(path, input.configDir)
      : undefined,
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

/** Download-counter snapshot returned by one identity verification pass. */
interface IdentityVerificationCountersV2 {
  identityCachedEvidence: number;
  identityDownloads: number;
  remainingDownloadBudget: number;
}

/** Cached remote content hashes by drive id, as supplied by the caller. */
type VerifiedRemoteContentHashesByIdV2 =
  FinalizeCanonicalPlanInputV2["verifiedRemoteContentHashesById"];
/** Budgeted content-hash download adapter, as supplied by the caller. */
type ResolveRemoteContentHashV2 =
  FinalizeCanonicalPlanInputV2["resolveRemoteContentHash"];

/**
 * Settle one identity move verification against the current content
 * evidence: the recorded hash, the verified-hash lookup or one budgeted
 * download decide equality, then the verification contributes either the
 * public local-move action or a pending deferral plus one result entry. The
 * caller's containers are threaded by reference; the returned counter
 * snapshot replaces the caller's bindings.
 */
async function settleIdentityMoveVerificationV2(args: {
  verification: CanonicalIdentityMoveVerificationV2;
  verifiedRemoteContentHashesById: VerifiedRemoteContentHashesByIdV2;
  resolveRemoteContentHash: ResolveRemoteContentHashV2;
  identityItems: SyncPlanItem[];
  identityResults: ContentVerificationResultV2[];
  identityProgressTotal: number;
  identityCachedEvidence: number;
  identityDownloads: number;
  remainingDownloadBudget: number;
}): Promise<IdentityVerificationCountersV2> {
  const {
    verification,
    verifiedRemoteContentHashesById,
    resolveRemoteContentHash,
    identityItems,
    identityResults,
    identityProgressTotal,
  } = args;
  let {
    identityCachedEvidence,
    identityDownloads,
    remainingDownloadBudget,
  } = args;
  const counters = (): IdentityVerificationCountersV2 => ({
    identityCachedEvidence,
    identityDownloads,
    remainingDownloadBudget,
  });

  let remoteHash = verification.remote.sha256Hash?.toLowerCase();
  let proof: ContentEqualityProof = remoteHash
    ? "remoteSha256"
    : "insufficientEvidence";
  if (!remoteHash) {
    remoteHash = verifiedRemoteContentHashesById
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
        await resolveRemoteContentHash({
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
        error: describeError(error),
      });
      return counters();
    }
  } else {
    identityItems.push(identityMovePendingItem(
      verification.toPath,
      "reason.identityMove.verificationFailed",
    ));
    return counters();
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
  return counters();
}

/**
 * Settle one identity replacement against the current content evidence: a
 * persisted difference receipt, the recorded hash, the verified-hash lookup
 * or one budgeted download decide equality, then the replacement becomes a
 * base upsert or a download/delete/conflict action. The caller's containers
 * are threaded by reference; the returned counter snapshot replaces the
 * caller's bindings.
 */
async function settleIdentityReplacementVerificationV2(args: {
  replacement: CanonicalIdentityReplacementV2;
  pendingByPath: ReadonlyMap<string, ContentComparisonReceiptV1 | undefined>;
  verifiedRemoteContentHashesById: VerifiedRemoteContentHashesByIdV2;
  resolveRemoteContentHash: ResolveRemoteContentHashV2;
  configDir: string;
  identityItems: SyncPlanItem[];
  identityBaseUpserts: BaseFileEntry[];
  identityResults: ContentVerificationResultV2[];
  identityProgressTotal: number;
  identityCachedEvidence: number;
  identityDownloads: number;
  remainingDownloadBudget: number;
}): Promise<IdentityVerificationCountersV2> {
  const {
    replacement,
    pendingByPath,
    verifiedRemoteContentHashesById,
    resolveRemoteContentHash,
    configDir,
    identityItems,
    identityBaseUpserts,
    identityResults,
    identityProgressTotal,
  } = args;
  let {
    identityCachedEvidence,
    identityDownloads,
    remainingDownloadBudget,
  } = args;
  const counters = (): IdentityVerificationCountersV2 => ({
    identityCachedEvidence,
    identityDownloads,
    remainingDownloadBudget,
  });

  const pendingReceipt = pendingByPath.get(replacement.path);
  let remoteHash = replacement.remote.sha256Hash?.toLowerCase();
  let proof: ContentEqualityProof = remoteHash
    ? "remoteSha256"
    : "insufficientEvidence";
  if (!remoteHash) {
    remoteHash = verifiedRemoteContentHashesById
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
        await resolveRemoteContentHash({
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
        error: describeError(error),
      });
      return counters();
    }
  } else {
    identityItems.push(identityReplacementPendingItem(replacement.path));
    return counters();
  }

  const decision = classifyIdentityReplacementV2(
    replacement,
    remoteHash,
    configDir,
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
  return counters();
}

/**
 * Settle one selected conflict candidate: reuse a prefetched hash or run the
 * one budgeted download, then record a false-conflict base upsert, a
 * difference receipt on the planner-owned clone, or a failed result. The
 * caller's containers are threaded by reference and no binding is
 * reassigned, so this phase has no value to return.
 */
async function settleSelectedCandidateVerificationV2(args: {
  index: number;
  selectedCandidates: readonly SyncPlanItem[];
  baseByPath: ReadonlyMap<string, BaseFileEntry>;
  verifiedRemoteContentHashesById: VerifiedRemoteContentHashesByIdV2;
  prefetchedDownloadHashes: ReadonlyMap<
    string,
    { hash: string } | { error: unknown }
  >;
  resolveRemoteContentHash: ResolveRemoteContentHashV2;
  falseConflicts: Set<string>;
  baseUpserts: BaseFileEntry[];
  results: ContentVerificationResultV2[];
}): Promise<void> {
  const {
    index,
    selectedCandidates,
    baseByPath,
    verifiedRemoteContentHashesById,
    prefetchedDownloadHashes,
    resolveRemoteContentHash,
    falseConflicts,
    baseUpserts,
    results,
  } = args;

  const item = selectedCandidates[index];
  const local = item.local!;
  const remote = item.remote!;
  let equality = resolveContentEquality({
    local,
    remote,
    base: baseByPath.get(item.path),
    verifiedRemoteHash: verifiedRemoteContentHashesById
      ?.get(remote.driveId),
  });
  let downloadedHash: string | undefined;
  try {
    if (equality.status === "unknown") {
      const prefetched = prefetchedDownloadHashes.get(item.path);
      if (prefetched) {
        if ("error" in prefetched) {
          const failure = prefetched.error;
          throw failure instanceof Error
            ? failure
            : new Error(String(failure));
        }
        downloadedHash = prefetched.hash;
      } else {
        downloadedHash = await resolveRemoteContentHash(item, {
          current: index + 1,
          total: selectedCandidates.length,
        });
      }
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
      error: describeError(error),
    });
  }
}

function classifyIdentityReplacementV2(
  replacement: CanonicalIdentityReplacementV2,
  remoteHash: string,
  configDir: string,
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
    if (isObsidianManagedConfigPath(path, configDir)) {
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
  let localOnlyCopies = 0;
  let impactCount = 0;
  for (const item of items) {
    if (item.type === SyncActionType.Upload) counts.uploads++;
    if (item.type === SyncActionType.Download) counts.downloads++;
    // 片② 单向模式的留副本改写项：只有计划生产链会写这个标记，双向计划里恒为
    // 0——为 0 时不落字段，计数对象对所有非单向调用方保持原形状。
    if (item.localOnlyCopyKind !== undefined) localOnlyCopies++;
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
      || item.type === SyncActionType.SkipOneDriveInvalidName
    ) counts.skipped++;
    if (countsForCanonicalReviewImpact(item.type)) {
      impactCount += Math.max(1, item.reviewImpactCount ?? 1);
    }
  }
  return {
    counts: localOnlyCopies > 0 ? { ...counts, localOnlyCopies } : counts,
    impactCount,
  };
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
    // Appended last on purpose: the nested-name map below indexes by position.
    item.localOnlyCopyKind ?? null,
  ];
}

/** Field names for canonicalPlanItemFactsV2 positions, in the same order. */
const CANONICAL_PLAN_ITEM_FACT_NAMES_V2 = [
  "type",
  "path",
  "reason",
  "local",
  "remote",
  "folder",
  "baseEtag",
  "renameFrom",
  "targetParentRemoteId",
  "requiresConfirmation",
  "reviewImpactCount",
  "decisionToken",
  "contentComparison",
  "localOnlyCopyKind",
] as const;

/** Nested fact names per top-level position of canonicalPlanItemFactsV2. */
const CANONICAL_PLAN_ITEM_FACT_NESTED_NAMES_V2: Readonly<
  Record<number, readonly string[]>
> = {
  3: ["local.path", "local.hash", "local.size", "local.binary"],
  4: [
    "remote.path",
    "remote.driveId",
    "remote.parentId",
    "remote.size",
    "remote.eTag",
    "remote.cTag",
    "remote.sha256Hash",
    "remote.quickXorHash",
  ],
  5: [
    "folder.remoteId",
    "folder.parentRemoteId",
    "folder.parentPath",
    "folder.remoteETag",
    "folder.parentRemoteETag",
    "folder.sourceParentRemoteId",
  ],
  11: [
    "decisionToken.version",
    "decisionToken.vaultName",
    "decisionToken.accountId",
    "decisionToken.scope.accountId",
    "decisionToken.scope.driveId",
    "decisionToken.scope.vaultFolderId",
    "decisionToken.scope.filesRootId",
    "decisionToken.local",
    "decisionToken.remote",
    "decisionToken.ancestorHash",
  ],
  12: [
    "contentComparison.version",
    "contentComparison.result",
    "contentComparison.localHash",
    "contentComparison.localSize",
    "contentComparison.remoteDriveId",
    "contentComparison.remoteETag",
    "contentComparison.remoteSize",
    "contentComparison.remoteHash",
  ],
};

/**
 * Fact names the published review projection can show a user (see
 * migration-hold-v2 projectReviewItems). Drift outside this set is invisible
 * in the review the user is asked to confirm.
 */
const CANONICAL_REVIEW_VISIBLE_FACT_NAMES_V2 = new Set<string>([
  "type",
  "path",
  "reason",
  "local.hash",
  "remote.eTag",
  "folder.remoteId",
  "folder.remoteETag",
  "folder.parentRemoteId",
  "folder.parentPath",
  "folder.parentRemoteETag",
]);

const CANONICAL_PLAN_ITEM_FACTS_DRIFT_SAMPLE_LIMIT_V2 = 10;

type CanonicalPlanItemFactsDriftReasonV2 =
  | "unparsable"
  | "shape-mismatch"
  | "sealed-plan-not-reproducible";

interface CanonicalPlanItemFactsDriftSampleV2 {
  kind: "changed" | "added" | "removed";
  type: string;
  path: string;
  /** Changed fact names; empty for a structurally added or removed item. */
  fields: string[];
}

export interface CanonicalPlanItemFactsDriftV2 {
  available: boolean;
  reason: CanonicalPlanItemFactsDriftReasonV2 | null;
  /** Sealed item counts per side; null when a digest could not be read. */
  items: { previous: number; next: number } | null;
  lastTotalFiles: { previous: number; next: number } | null;
  changed: number;
  added: number;
  removed: number;
  samples: CanonicalPlanItemFactsDriftSampleV2[];
  samplesOmitted: number;
  /** True only with at least one change, all of it outside the fields the
   *  published review projection carries. */
  outsideReviewFields: boolean;
}

interface CanonicalPlanDigestFactsV2 {
  scope: SyncScope;
  sourceCommitSeq: number;
  lastTotalFiles: number;
  items: CanonicalPlanItemFactsV2[];
}

/** One sealed item's ordered facts; positions align with the name table. */
type CanonicalPlanItemFactsV2 = unknown[];

/**
 * Diagnostic item-fact drift between the sealed plan of a previous review hold
 * and the freshly sealed plan of this round.
 *
 * The previous side is read back from `canonicalIdentity.digest`, which is the
 * exact JSON serialization of the sealed item facts (never a hash), so the
 * knife needs no new persisted state. The report is bounded and leak-free:
 * paths and field names only, never field values. Names align position by
 * position with canonicalPlanItemFactsV2; the guard test in
 * tests/canonical-plan-v2.test.ts turns red when that layout moves.
 *
 * This never throws: a caller logging a review drift must not turn a
 * diagnostic into a new failure. `available: false` carries the reason.
 */
export function describeCanonicalPlanItemFactsDriftV2(input: {
  previousDigest: string;
  nextItems: readonly SyncPlanItem[];
  nextDigest: string;
  limit?: number;
}): CanonicalPlanItemFactsDriftV2 {
  try {
    const previous = readCanonicalPlanDigestFactsV2(input.previousDigest);
    if (typeof previous === "string") {
      return unavailableCanonicalPlanItemFactsDriftV2(previous);
    }
    const next = readCanonicalPlanDigestFactsV2(input.nextDigest);
    if (typeof next === "string") {
      return unavailableCanonicalPlanItemFactsDriftV2(next);
    }
    // The sealed plan of this round must be reproducible from the items the
    // caller handed in; otherwise the pairing below would attribute drift to
    // facts that never belonged to the sealed digest.
    const reproduced = canonicalPlanDigestV2({
      items: input.nextItems,
      lastTotalFiles: next.lastTotalFiles,
      scope: next.scope,
      sourceCommitSeq: next.sourceCommitSeq,
    });
    if (reproduced !== input.nextDigest) {
      return unavailableCanonicalPlanItemFactsDriftV2(
        "sealed-plan-not-reproducible",
      );
    }
    return diffCanonicalPlanItemFactsV2({
      previous: previous.items,
      next: input.nextItems.map(canonicalPlanItemFactsV2),
      previousLastTotalFiles: previous.lastTotalFiles,
      nextLastTotalFiles: next.lastTotalFiles,
      limit: input.limit ?? CANONICAL_PLAN_ITEM_FACTS_DRIFT_SAMPLE_LIMIT_V2,
    });
  } catch {
    // Observing a review drift must never add a failure of its own.
    return unavailableCanonicalPlanItemFactsDriftV2("unparsable");
  }
}

function unavailableCanonicalPlanItemFactsDriftV2(
  reason: CanonicalPlanItemFactsDriftReasonV2,
): CanonicalPlanItemFactsDriftV2 {
  return {
    available: false,
    reason,
    items: null,
    lastTotalFiles: null,
    changed: 0,
    added: 0,
    removed: 0,
    samples: [],
    samplesOmitted: 0,
    outsideReviewFields: false,
  };
}

function readCanonicalPlanDigestFactsV2(
  digest: string,
): CanonicalPlanDigestFactsV2 | CanonicalPlanItemFactsDriftReasonV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(digest);
  } catch {
    return "unparsable";
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 2
  ) {
    return "shape-mismatch";
  }
  const record = parsed as Record<string, unknown>;
  const scope = readCanonicalPlanDigestScopeV2(record.scope);
  if (
    !scope
    || !Number.isSafeInteger(record.sourceCommitSeq)
    || !Number.isSafeInteger(record.lastTotalFiles)
    || !Array.isArray(record.items)
    || !record.items.every((entry) =>
      Array.isArray(entry)
      && entry.length === CANONICAL_PLAN_ITEM_FACT_NAMES_V2.length
      && typeof entry[0] === "string"
      && typeof entry[1] === "string"
    )
  ) {
    return "shape-mismatch";
  }
  return {
    scope,
    sourceCommitSeq: Number(record.sourceCommitSeq),
    lastTotalFiles: Number(record.lastTotalFiles),
    items: record.items as CanonicalPlanItemFactsV2[],
  };
}

function readCanonicalPlanDigestScopeV2(value: unknown): SyncScope | null {
  if (
    !Array.isArray(value)
    || value.length !== 4
    || !value.every((part) => typeof part === "string")
  ) {
    return null;
  }
  return {
    accountId: String(value[0]),
    driveId: String(value[1]),
    vaultFolderId: String(value[2]),
    filesRootId: String(value[3]),
  };
}

function diffCanonicalPlanItemFactsV2(input: {
  previous: CanonicalPlanItemFactsV2[];
  next: CanonicalPlanItemFactsV2[];
  previousLastTotalFiles: number;
  nextLastTotalFiles: number;
  limit: number;
}): CanonicalPlanItemFactsDriftV2 {
  const group = (facts: readonly CanonicalPlanItemFactsV2[]) => {
    const groups = new Map<string, number[]>();
    facts.forEach((entry, index) => {
      const key = `${String(entry[0])}\u0000${String(entry[1])}`;
      const indexes = groups.get(key);
      if (indexes) indexes.push(index);
      else groups.set(key, [index]);
    });
    return groups;
  };
  const sampleOf = (
    kind: CanonicalPlanItemFactsDriftSampleV2["kind"],
    facts: CanonicalPlanItemFactsV2,
    fields: string[],
  ): CanonicalPlanItemFactsDriftSampleV2 => ({
    kind,
    type: String(facts[0]),
    path: String(facts[1]),
    fields,
  });
  const previousGroups = group(input.previous);
  const nextGroups = group(input.next);
  const samples: CanonicalPlanItemFactsDriftSampleV2[] = [];
  let changed = 0;
  let added = 0;
  let removed = 0;
  let outsideReviewFields = true;
  const pushSample = (
    kind: CanonicalPlanItemFactsDriftSampleV2["kind"],
    facts: CanonicalPlanItemFactsV2,
    fields: string[],
  ): void => {
    if (samples.length < input.limit) {
      samples.push(sampleOf(kind, facts, fields));
    }
  };
  for (const [key, previousIndexes] of previousGroups) {
    const nextIndexes = nextGroups.get(key) ?? [];
    const paired = Math.min(previousIndexes.length, nextIndexes.length);
    for (let position = 0; position < paired; position++) {
      const previousFacts = input.previous[previousIndexes[position]];
      const nextFacts = input.next[nextIndexes[position]];
      const fields = canonicalPlanItemFactChangeNamesV2(previousFacts, nextFacts);
      if (fields.length === 0) continue;
      changed++;
      // The flag stays true only while every changed field is one the review
      // projection cannot show.
      if (fields.some((field) =>
        CANONICAL_REVIEW_VISIBLE_FACT_NAMES_V2.has(field))) {
        outsideReviewFields = false;
      }
      pushSample("changed", previousFacts, fields);
    }
    for (let position = paired; position < previousIndexes.length; position++) {
      removed++;
      // An item appearing or disappearing moves the reviewed (type,path) set,
      // which the projection shows as a whole.
      outsideReviewFields = false;
      pushSample("removed", input.previous[previousIndexes[position]], []);
    }
  }
  for (const [key, nextIndexes] of nextGroups) {
    const previousIndexes = previousGroups.get(key) ?? [];
    for (let position = previousIndexes.length; position < nextIndexes.length;
      position++) {
      added++;
      outsideReviewFields = false;
      pushSample("added", input.next[nextIndexes[position]], []);
    }
  }
  const total = changed + added + removed;
  return {
    available: true,
    reason: null,
    items: { previous: input.previous.length, next: input.next.length },
    lastTotalFiles: {
      previous: input.previousLastTotalFiles,
      next: input.nextLastTotalFiles,
    },
    changed,
    added,
    removed,
    samples,
    samplesOmitted: Math.max(0, total - samples.length),
    outsideReviewFields: total > 0 && outsideReviewFields,
  };
}

function canonicalPlanItemFactChangeNamesV2(
  previous: CanonicalPlanItemFactsV2,
  next: CanonicalPlanItemFactsV2,
): string[] {
  const names: string[] = [];
  CANONICAL_PLAN_ITEM_FACT_NAMES_V2.forEach((name, position) => {
    const previousValue = previous[position];
    const nextValue = next[position];
    if (sameCanonicalPlanItemFactValueV2(previousValue, nextValue)) return;
    const nested = CANONICAL_PLAN_ITEM_FACT_NESTED_NAMES_V2[position];
    if (
      !nested
      || !Array.isArray(previousValue)
      || !Array.isArray(nextValue)
      || previousValue.length !== nested.length
      || nextValue.length !== nested.length
    ) {
      names.push(name);
      return;
    }
    nested.forEach((nestedName, nestedPosition) => {
      if (!sameCanonicalPlanItemFactValueV2(
        previousValue[nestedPosition],
        nextValue[nestedPosition],
      )) {
        names.push(nestedName);
      }
    });
  });
  return names;
}

function sameCanonicalPlanItemFactValueV2(
  left: unknown,
  right: unknown,
): boolean {
  // Deep equality over the same JSON shape the digest itself serializes.
  return JSON.stringify(left) === JSON.stringify(right);
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

export function canonicalActionPriority(type: SyncActionType): number {
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
    case SyncActionType.SkipOneDriveInvalidName:
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

/**
 * Collect the old-path hold keys of file out-of-scope destination hints that
 * are still bound to a committed file identity and point outside the current
 * sync scope (but not into the vault trash). Mirrors the acceptance rules of
 * the record layer (state-manager) and revalidates the destination against the
 * current scope so a hint whose destination re-entered the scope becomes
 * inert without any state write — including EasySync's own bookkeeping
 * destinations, which are out of scope by construction and therefore never
 * evidence that the file left sync.
 */
function collectFileScopeCrossingHolds(
  hints: readonly LocalFolderMoveHintV1[],
  state: CanonicalPlannerStateV2,
  includeFilePath: (path: string) => boolean,
  configDir: string,
): Set<string> {
  const holds = new Set<string>();
  for (const hint of hints) {
    if (!sameSyncScope(hint.scope, state.scope)) continue;
    if (hint.toPath === ".trash" || hint.toPath.startsWith(".trash/")) continue;
    if (isEasySyncInternalPath(hint.toPath, configDir)) continue;
    const anchored = state.fileAnchors.some((anchor) =>
      anchor.remoteId === hint.remoteId
      && normalizeRemotePathKey(anchor.lastPath)
        === normalizeRemotePathKey(hint.fromPath));
    if (!anchored) continue;
    if (includeFilePath(hint.toPath)) continue;
    holds.add(normalizeRemotePathKey(hint.fromPath));
  }
  return holds;
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

export function projectFolderIdentitiesForMove(
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
  // Only the config directory root and the community-plugin subtree keep the
  // folder-delete protection: plugin code/data carries per-device
  // participation semantics, and the root is the scope boundary. Theme and
  // snippet directories are user content (DECISIONS 2026-07-16 does not
  // extend the managed-config protection to them) and follow the ordinary
  // folder delete chain, whose execution still requires an exact empty
  // remote subtree, an If-Match delete into the recycle bin and a read-back.
  if (!isAtOrBelowPath(path, configDir)) return false;
  return normalizeRemotePathKey(path) === normalizeRemotePathKey(configDir)
    || isAtOrBelowPath(path, `${configDir}/plugins`);
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
