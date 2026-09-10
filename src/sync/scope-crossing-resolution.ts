/**
 * Slice-2 scope-crossing resolution review.
 *
 * A file/folder that left the sync scope is recorded as a device-local move
 * hint. While that hint is bound, the planner holds the old path's remote
 * deletion behind a reviewable scope-crossing pending row. This module turns
 * one pending row into the read-only facts (snapshot) that let the user undo
 * the move or confirm leaving sync. It performs no Vault, Graph, state, or
 * mutation I/O — the executor owns the live recheck and the writes.
 */

import {
  isAtOrBelowPath,
  normalizeRemotePathKey,
} from "./canonical-plan-v2";
import {
  sameSyncScope,
  type LocalFolderMoveHintV1,
  type SyncScope,
} from "./types";
import { type SyncStateEnvelopeV2 } from "./state-envelope-v2";

export interface ScopeCrossingResolutionSnapshotV1 {
  version: 1;
  scope: SyncScope;
  kind: "folder" | "file";
  /** The pending row the user is reviewing (old synced path). */
  rowPath: string;
  /** The root path that left the sync scope (undo target / delete anchor). */
  fromPath: string;
  /** The recorded current local location of the move root. */
  toPath: string;
  remoteId: string;
  /** Content identity of the reviewed facts; drift invalidates it. */
  revision: string;
}

export interface ScopeCrossingResolutionFactsV1 {
  envelope: SyncStateEnvelopeV2;
  folderMoveHints: readonly LocalFolderMoveHintV1[];
  fileMoveHints: readonly LocalFolderMoveHintV1[];
}

/** The move hint that owns one scope-crossing row, with its bound anchor. */
export interface ScopeCrossingCoveringHintV1 {
  kind: "folder" | "file";
  hint: LocalFolderMoveHintV1;
  anchorLastPath: string;
}

/** ".trash" is the deletion gesture; it never produces a scope-crossing row. */
function isVaultTrashPath(path: string): boolean {
  return path === ".trash" || path.startsWith(".trash/");
}

function snapshotRevision(input: {
  kind: "folder" | "file";
  rowPath: string;
  fromPath: string;
  toPath: string;
  remoteId: string;
  anchorLastPath: string;
  observedAt: number;
  scope: SyncScope;
}): string {
  return JSON.stringify([
    input.kind,
    input.rowPath,
    input.fromPath,
    input.toPath,
    input.remoteId,
    input.anchorLastPath,
    input.observedAt,
    input.scope.accountId,
    input.scope.driveId,
    input.scope.vaultFolderId,
    input.scope.filesRootId,
  ]);
}

/**
 * Resolve one pending scope-crossing row to its covering move hint, or null
 * when the row has no exit on this device (drift/settings forms that carry no
 * recorded move). Folder hints own their whole subtree: rows on nested
 * anchored folders resolve through the covering root hint. Shared by the
 * action-time snapshot below and the render-time exit-availability check so
 * both accept on exactly the same facts.
 */
export function findScopeCrossingCoveringHintV1(
  rowPath: string,
  input: ScopeCrossingResolutionFactsV1,
): ScopeCrossingCoveringHintV1 | null {
  const { envelope } = input;
  if (!envelope.folderAnchors) return null;

  for (const hint of input.folderMoveHints) {
    if (!sameSyncScope(hint.scope, envelope.scope)) continue;
    if (isVaultTrashPath(hint.toPath)) continue;
    const anchor = Object.values(envelope.folderAnchors.byAnchorId).find(
      (candidate) =>
        candidate.remoteId === hint.remoteId
        && normalizeRemotePathKey(candidate.lastPath)
          === normalizeRemotePathKey(hint.fromPath),
    );
    if (!anchor) continue;
    if (
      normalizeRemotePathKey(rowPath) === normalizeRemotePathKey(hint.fromPath)
      || isAtOrBelowPath(rowPath, hint.fromPath)
    ) {
      return { kind: "folder", hint, anchorLastPath: anchor.lastPath };
    }
  }

  // File hints are root-only rows (the planner holds one path per hint).
  for (const hint of input.fileMoveHints) {
    if (!sameSyncScope(hint.scope, envelope.scope)) continue;
    if (isVaultTrashPath(hint.toPath)) continue;
    if (normalizeRemotePathKey(rowPath) !== normalizeRemotePathKey(hint.fromPath)) {
      continue;
    }
    const anchor = Object.values(envelope.anchors.byAnchorId).find(
      (candidate) =>
        candidate.remoteId === hint.remoteId
        && normalizeRemotePathKey(candidate.lastPath)
          === normalizeRemotePathKey(hint.fromPath),
    );
    if (!anchor) continue;
    return { kind: "file", hint, anchorLastPath: anchor.lastPath };
  }

  return null;
}

/**
 * Build the read-only facts for one scope-crossing pending row, or null when
 * the row is stale (hint retired, anchor unbound, scope moved on, or the row
 * no longer belongs to this device's scope-crossing family).
 */
export function buildScopeCrossingResolutionSnapshotV1(
  rowPath: string,
  input: ScopeCrossingResolutionFactsV1,
): ScopeCrossingResolutionSnapshotV1 | null {
  const covered = findScopeCrossingCoveringHintV1(rowPath, input);
  if (!covered) return null;
  const { kind, hint, anchorLastPath } = covered;
  return {
    version: 1,
    scope: { ...input.envelope.scope },
    kind,
    rowPath,
    fromPath: hint.fromPath,
    toPath: hint.toPath,
    remoteId: hint.remoteId,
    revision: snapshotRevision({
      kind,
      rowPath,
      fromPath: hint.fromPath,
      toPath: hint.toPath,
      remoteId: hint.remoteId,
      anchorLastPath,
      observedAt: hint.observedAt,
      scope: input.envelope.scope,
    }),
  };
}
