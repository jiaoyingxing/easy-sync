/**
 * Provable same-path replacement settlement.
 *
 * The identity layer treats a different remote object at an anchor's old path
 * plus one or more same-content local files elsewhere as
 * `replacement-with-local-relocation` and asks the user to forget the stale
 * lineage. The answer is unique when the occupant's bytes are proven equal to
 * the committed anchor: keep both objects, retire only the stale tracking
 * record, and let the ordinary planner meet the occupant as a new cloud file
 * and the local copies as ordinary local-only content. Nothing is uploaded,
 * downloaded, overwritten or deleted by the retirement itself.
 *
 * This module selects one such retirement at a time. The caller applies the
 * existing reviewed-retirement reducer, so no second state-write path is
 * introduced and unproven replacements keep today's review row.
 */

import { normalizeRemotePathKey } from "./canonical-plan-v2";
import {
  planIdentityRenamesV2,
  type IdentityRenameActionV2,
} from "./identity-rename-v2";
import {
  buildStaleIdentityResolutionSnapshotV1,
  type StaleIdentityResolutionSnapshotV1,
} from "./stale-identity-resolution";
import {
  SyncActionType,
  type LocalFileEntry,
  type LocalFolderDeleteHintV1,
  type LocalFolderEntry,
  type LocalFolderMoveHintV1,
  type RemoteFileEntry,
  type SyncPlanItem,
} from "./types";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";

interface SelectProvablyReplacedIdentityRetirementInputV2 {
  envelope: SyncStateEnvelopeV2;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  skippedLarge: readonly string[];
  maxFileSizeBytes?: number;
  localMoveHints?: readonly LocalFolderMoveHintV1[];
  localFolderDeleteHints?: readonly LocalFolderDeleteHintV1[];
  remoteEntries: readonly RemoteFileEntry[];
  includeFilePath: (path: string) => boolean;
  includeFolderPath: (path: string) => boolean;
  preserveFolderPath: (path: string) => boolean;
  configDir: string;
  automaticDeleteLocalFiles: boolean;
  /** Paths already attempted this round; unprovable candidates are added by
   *  the selector and keep their review row. */
  skippedPaths: Set<string>;
  /** Remaining plan-time content downloads. Absent = no download allowed. */
  remainingDownloads: number;
  resolveRemoteContentHash: (
    item: Readonly<SyncPlanItem>,
    progress: { current: number; total: number },
  ) => Promise<string>;
}

interface ProvablyReplacedIdentityRetirementV2 {
  path: string;
  snapshot: StaleIdentityResolutionSnapshotV1;
  /** Whole-file verification downloads consumed by this selection. */
  downloadsConsumed: number;
}

/**
 * Pick the first replacement whose occupant hash is already known or can be
 * read within the remaining budget. Returns null when no candidate can be
 * proven this round. Candidates whose bytes differ (or cannot be read) are
 * recorded in `skippedPaths` for the rest of the round: they keep their review
 * row and the caller does not re-select and re-download them. `downloadsConsumed`
 * reports how many verification downloads this selection used, including reads
 * made for candidates that turned out different, so the caller charges every
 * download to the round's budget.
 */
export async function selectNextProvablyReplacedIdentityRetirementV2(
  input: SelectProvablyReplacedIdentityRetirementInputV2,
): Promise<ProvablyReplacedIdentityRetirementV2 | null> {
  const actions = planIdentityRenamesV2(
    input.envelope,
    input.localFiles,
  ).filter((action): action is Extract<
    IdentityRenameActionV2,
    { type: "conflict" }
  > =>
    action.type === "conflict"
    && action.reason === "replacement-with-local-relocation"
    && !input.skippedPaths.has(action.path),
  );
  let downloadsConsumed = 0;
  for (const action of actions) {
    const anchor = input.envelope.anchors.byAnchorId[action.anchorId];
    if (
      !anchor
      || !anchor.remoteId
      || anchor.lastPath !== action.path
    ) continue;
    const occupant = input.remoteEntries.find((entry) =>
      normalizeRemotePathKey(entry.path) === normalizeRemotePathKey(action.path));
    if (!occupant) continue;

    let remoteHash = occupant.sha256Hash?.toLowerCase();
    if (!remoteHash) {
      if (downloadsConsumed >= input.remainingDownloads) continue;
      // Charge the attempt before it runs: a failed or different read still
      // consumed one of the round's verification downloads.
      downloadsConsumed += 1;
      try {
        remoteHash = (await input.resolveRemoteContentHash(
          {
            type: SyncActionType.Conflict,
            path: action.path,
            remote: occupant,
            reason: "reason.identityReplacement.verificationPending",
          },
          { current: 1, total: 1 },
        )).toLowerCase();
      } catch {
        input.skippedPaths.add(action.path);
        continue;
      }
    }
    if (
      occupant.size !== anchor.size
      || remoteHash !== anchor.contentHash.toLowerCase()
    ) {
      input.skippedPaths.add(action.path);
      continue;
    }

    const snapshot = buildStaleIdentityResolutionSnapshotV1(
      action.path,
      "identity-replacement-ambiguous",
      {
        envelope: input.envelope,
        localFiles: input.localFiles,
        localFolders: input.localFolders,
        localFolderScanComplete: input.localFolderScanComplete,
        skippedLarge: input.skippedLarge,
        ...(input.maxFileSizeBytes !== undefined
          ? { maxFileSizeBytes: input.maxFileSizeBytes }
          : {}),
        ...(input.localMoveHints
          ? { localMoveHints: input.localMoveHints }
          : {}),
        ...(input.localFolderDeleteHints
          ? { localFolderDeleteHints: input.localFolderDeleteHints }
          : {}),
        includeFilePath: input.includeFilePath,
        includeFolderPath: input.includeFolderPath,
        preserveFolderPath: input.preserveFolderPath,
        configDir: input.configDir,
        automaticDeleteLocalFiles: input.automaticDeleteLocalFiles,
      },
    );
    if (!snapshot) continue;
    return { path: action.path, snapshot, downloadsConsumed };
  }
  return null;
}
