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
  /** Paths already attempted this round; they keep their review row. */
  skippedPaths: ReadonlySet<string>;
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
  downloaded: boolean;
}

/**
 * Pick the first replacement whose occupant hash is already known or can be
 * read within the remaining budget. Returns null when no candidate can be
 * proven this round. A candidate whose bytes differ (or cannot be read) is
 * added to `skippedPaths` for this round only; the ordinary review row keeps
 * its full safety net.
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
    let downloaded = false;
    if (!remoteHash) {
      if (input.remainingDownloads <= 0) continue;
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
        downloaded = true;
      } catch {
        continue;
      }
    }
    if (
      occupant.size !== anchor.size
      || remoteHash !== anchor.contentHash.toLowerCase()
    ) continue;

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
    return { path: action.path, snapshot, downloaded };
  }
  return null;
}
