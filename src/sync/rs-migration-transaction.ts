/**
 * Remotely Save adoption transaction (2026-10-01 approved plan, S2).
 *
 * Moves — with an automatic copy fallback — the content of a detected
 * foreign vault directory (`/Apps/remotely-save/<vault name>/`) into this
 * vault's EasySync `files/` root, so the next fresh activation can seed
 * identical-content baselines instead of surfacing per-file conflicts.
 *
 * Write-scope discipline (carrier plan §3): the ONLY writes outside the
 * EasySync App Folder are the per-child move/copy of the foreign directory's
 * own children inside this one user-confirmed transaction. The cross-app
 * write capability is undocumented and treated as revocable — every failure
 * path is fail-closed, the destination must be empty, and any mid-way
 * failure of move mode rolls already-moved children back before reporting
 * failure. The Remotely Save metadata file is deleted after adoption (D10):
 * left in place it would enter the sync scope and be downloaded into the
 * vault as an ordinary note.
 *
 * Failure invariants: the adoption marker is returned only when the whole
 * content is in place; a failed transaction may leave SOME content adopted
 * (rollback is best effort) but never returns a marker, so the next round
 * fail-closes into the ordinary per-file conflict flow instead of
 * double-adopting. Cleanup deletions touch only this transaction's own
 * copies inside the EasySync App Folder — never a child that arrived by a
 * verified move.
 */
import type { OneDriveClient } from "../onedrive/client";
import type { DriveItem } from "../onedrive/types";
import { OneDriveError, OneDriveErrorType } from "../onedrive/types";
import type {
  BaseFileEntry,
  LocalFileEntry,
  RemoteFileEntry,
} from "./types";

/** Prefix of the Remotely Save remote-side metadata file (deleted after
 *  adoption; see module doc). */
export const REMOTELY_SAVE_METADATA_FILE_PREFIX =
  "_remotely-save-metadata-on-remote";

/** How long one folder-level move may take Graph to answer 202-async before
 *  the arrival poll gives up (per-child deadline inside the transaction). */
const RS_MIGRATION_MOVE_ARRIVAL_TIMEOUT_MS = 60_000;
const RS_MIGRATION_MOVE_ARRIVAL_POLL_INTERVAL_MS = 2_000;
/** Safety ceiling on the source directory's top-level children. A vault root
 *  far beyond this is treated as an unexpected shape and refused (fail-closed)
 *  instead of issuing an unbounded sequence of moves. */
const RS_MIGRATION_MAX_SOURCE_CHILDREN = 1_000;

export type RsMigrationTransactionStatus =
  | "moved"
  | "copied"
  | "empty-source"
  | "not-found"
  | "destination-not-empty"
  | "failed";

export interface RsMigrationTransactionOutcome {
  status: RsMigrationTransactionStatus;
  /** Children that now live under the EasySync files root. */
  adoptedCount: number;
  /** Reason for "failed" outcomes; diagnostic-only, never user copy. */
  reason?: string;
  /** Durable marker payload for the adoption seeding (set on moved/copied). */
  marker: {
    vaultName: string;
    sourceVaultDirId: string;
    strategy: "moved" | "copied";
    completedAt: number;
  } | null;
}

export interface RsMigrationTransactionInput {
  onedrive: OneDriveClient;
  vaultName: string;
  /** The EasySync files root (must already exist — initVaultScope ran). */
  filesRootId: string;
}

/** Adoption seed: pair the local scan against the complete remote snapshot of
 *  the adopted foreign content. quickXorHash equality plus size equality is
 *  the adoption evidence (the same "equal-read" strength the cloud-join
 *  bootstrap verifies device-side), and a present Graph sha256 that disagrees
 *  always rejects. Paths without both hashes stay out of the seed and fall
 *  through to the ordinary planner (upload / conflict), with the first-round
 *  content-verification budget as the final byte-level check. */
export function seedBaseEntriesFromRsAdoption(
  localEntries: readonly LocalFileEntry[],
  remoteEntries: readonly RemoteFileEntry[],
): BaseFileEntry[] {
  const localByPath = new Map(
    localEntries.map((entry) => [entry.path, entry]),
  );
  const seeds: BaseFileEntry[] = [];
  for (const remote of remoteEntries) {
    if (!remote.eTag) continue;
    const local = localByPath.get(remote.path);
    if (!local) continue;
    if (
      !remote.quickXorHash
      || !local.quickXorHash
      || remote.quickXorHash !== local.quickXorHash
    ) continue;
    if (remote.size !== local.size) continue;
    if (
      remote.sha256Hash
      && remote.sha256Hash.toLowerCase() !== local.hash.toLowerCase()
    ) continue;
    seeds.push({
      path: remote.path,
      hash: local.hash,
      size: local.size,
      eTag: remote.eTag,
    });
  }
  return seeds;
}

export async function runRsMigrationTransaction(
  input: RsMigrationTransactionInput,
): Promise<RsMigrationTransactionOutcome> {
  const { onedrive, vaultName, filesRootId } = input;

  // Re-verify the foreign repository at transaction time — the offer-time
  // detection is only a snapshot and the confirmation must act on current
  // facts.
  let detected: Awaited<
    ReturnType<OneDriveClient["detectRemotelySaveRepository"]>
  >;
  try {
    detected = await onedrive.detectRemotelySaveRepository(vaultName);
  } catch (error) {
    return {
      status: "failed",
      adoptedCount: 0,
      reason: `detection-failed: ${errorMessage(error)}`,
      marker: null,
    };
  }
  if (!detected) return { status: "not-found", adoptedCount: 0, marker: null };

  const destinationChildren = await onedrive.listFolderChildrenById(filesRootId);
  if (destinationChildren.length > 0) {
    return {
      status: "destination-not-empty",
      adoptedCount: 0,
      reason: "destination-not-empty",
      marker: null,
    };
  }

  const sourceChildren = await onedrive.listFolderChildrenById(
    detected.vaultDirId,
  );
  if (sourceChildren.length > RS_MIGRATION_MAX_SOURCE_CHILDREN) {
    return {
      status: "failed",
      adoptedCount: 0,
      reason: `source-children-exceed-budget: ${sourceChildren.length}`,
      marker: null,
    };
  }
  if (sourceChildren.length === 0) {
    return { status: "empty-source", adoptedCount: 0, marker: null };
  }

  const moveOutcome = await moveAllChildren({
    onedrive,
    sourceChildren,
    sourceVaultDirId: detected.vaultDirId,
    filesRootId,
  });
  if (moveOutcome.status === "moved") {
    if (
      !await cleanupRemotelySaveMetadataFiles(onedrive, filesRootId)
    ) {
      return {
        status: "failed",
        adoptedCount: moveOutcome.movedNames.length,
        reason: "metadata-cleanup-failed",
        marker: null,
      };
    }
    return {
      status: "moved",
      adoptedCount: moveOutcome.movedNames.length,
      marker: {
        vaultName,
        sourceVaultDirId: detected.vaultDirId,
        strategy: "moved",
        completedAt: Date.now(),
      },
    };
  }
  if (moveOutcome.status !== "forbidden") {
    return {
      status: "failed",
      adoptedCount: 0,
      reason: moveOutcome.reason,
      marker: null,
    };
  }

  // Move was refused — the adopted fallback re-reads the source (children
  // that were moved back are present again) and copies the remainder. Copy
  // keeps the source intact, so there is nothing to roll back; the source
  // directory stays for the user to dispose of (D7). A child that already
  // arrived via the move phase is adopted as-is and never re-copied.
  const adoptedNames: string[] = [];
  const copiedNames: string[] = [];
  const destinationNames = new Set(
    (await onedrive.listFolderChildrenById(filesRootId)).map(
      (item) => item.name,
    ),
  );
  const remainingChildren = await onedrive.listFolderChildrenById(
    detected.vaultDirId,
  );
  for (const child of remainingChildren) {
    if (destinationNames.has(child.name)) {
      adoptedNames.push(child.name);
      continue;
    }
    try {
      await onedrive.copyItemById(child.id, filesRootId, child.name);
      copiedNames.push(child.name);
    } catch (error) {
      await deleteOwnCopiesOnFailure(onedrive, filesRootId, copiedNames);
      return {
        status: "failed",
        adoptedCount: 0,
        reason: `copy-failed: ${errorMessage(error)}`,
        marker: null,
      };
    }
  }
  if (
    !await cleanupRemotelySaveMetadataFiles(onedrive, filesRootId)
  ) {
    return {
      status: "failed",
      adoptedCount: adoptedNames.length + copiedNames.length,
      reason: "metadata-cleanup-failed",
      marker: null,
    };
  }
  return {
    status: "copied",
    adoptedCount: adoptedNames.length + copiedNames.length,
    marker: {
      vaultName,
      sourceVaultDirId: detected.vaultDirId,
      strategy: "copied",
      completedAt: Date.now(),
    },
  };
}

type MoveAllOutcome =
  | { status: "moved"; movedNames: string[] }
  | { status: "forbidden" }
  | { status: "failed"; reason: string };

async function moveAllChildren(args: {
  onedrive: OneDriveClient;
  sourceChildren: DriveItem[];
  sourceVaultDirId: string;
  filesRootId: string;
}): Promise<MoveAllOutcome> {
  const { onedrive, sourceChildren, sourceVaultDirId, filesRootId } = args;
  const movedNames: string[] = [];
  for (const child of sourceChildren) {
    try {
      const moved = await onedrive.moveItemById(
        child.id,
        child.eTag ?? "",
        child.name,
        filesRootId,
      );
      const verified =
        moved
        && moved.id === child.id
        && moved.name === child.name
        && moved.parentReference?.id === filesRootId;
      if (!verified) {
        // Graph answered asynchronously (or with an unexpected shape):
        // observe the arrival at the destination like a copy.
        const arrived = await onedrive.pollChildArrivedInParent(
          filesRootId,
          child.name,
          RS_MIGRATION_MOVE_ARRIVAL_TIMEOUT_MS,
          RS_MIGRATION_MOVE_ARRIVAL_POLL_INTERVAL_MS,
        );
        if (!arrived) {
          await rollbackMovedChildren(
            onedrive,
            filesRootId,
            sourceVaultDirId,
            movedNames,
          );
          return {
            status: "failed",
            reason: `move-arrival-timeout: ${child.name}`,
          };
        }
      }
      movedNames.push(child.name);
    } catch (error) {
      await rollbackMovedChildren(
        onedrive,
        filesRootId,
        sourceVaultDirId,
        movedNames,
      );
      return {
        status: error instanceof OneDriveError
          && error.type === OneDriveErrorType.Forbidden
          ? "forbidden"
          : "failed",
        reason: `move-failed: ${errorMessage(error)}`,
      };
    }
  }
  return { status: "moved", movedNames };
}

/** Move already-adopted children back to the source directory. Best effort:
 *  a rollback failure is invisible here by design — the outcome reports
 *  failure without a marker, so the next round fail-closes into the
 *  ordinary conflict flow instead of double-adopting. */
async function rollbackMovedChildren(
  onedrive: OneDriveClient,
  filesRootId: string,
  sourceVaultDirId: string,
  movedNames: readonly string[],
): Promise<void> {
  for (const name of movedNames) {
    try {
      const children = await onedrive.listFolderChildrenById(filesRootId);
      const child = children.find((item) => item.name === name);
      if (!child) continue;
      await onedrive.moveItemById(
        child.id,
        child.eTag ?? "",
        child.name,
        sourceVaultDirId,
      );
    } catch {
      // Best effort; the outcome already reports failure.
    }
  }
}

/** Delete the copies this transaction's fallback created (they live inside
 *  the EasySync App Folder, where deletion is unconditionally ours). Never
 *  touches a child that arrived through a verified move. */
async function deleteOwnCopiesOnFailure(
  onedrive: OneDriveClient,
  filesRootId: string,
  copiedNames: readonly string[],
): Promise<void> {
  if (copiedNames.length === 0) return;
  try {
    const children = await onedrive.listFolderChildrenById(filesRootId);
    const copyNameSet = new Set(copiedNames);
    for (const child of children) {
      if (!copyNameSet.has(child.name)) continue;
      await onedrive.deleteItem("", "", undefined, child.id);
    }
  } catch {
    // Best effort cleanup; the outcome already reports failure.
  }
}

/** D10: remove the Remotely Save remote-side metadata file(s) from the
 *  adopted content. Returns false when a metadata file exists but cannot be
 *  deleted — the caller must fail closed rather than let the file enter the
 *  sync scope. */
async function cleanupRemotelySaveMetadataFiles(
  onedrive: OneDriveClient,
  filesRootId: string,
): Promise<boolean> {
  try {
    const children = await onedrive.listFolderChildrenById(filesRootId);
    for (const child of children) {
      if (
        !child.name.toLowerCase().startsWith(REMOTELY_SAVE_METADATA_FILE_PREFIX)
      ) continue;
      await onedrive.deleteItem("", "", undefined, child.id);
    }
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof OneDriveError) {
    return `${error.type}${error.graphCode ? `:${error.graphCode}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}
