import {
  canonicalPlannerStateFromEnvelopeV2,
  type CanonicalPlannerStateV2,
} from "./canonical-planner-state-v2";
import type { RemoteNodeV2 } from "./remote-index-v2";
import type { LocalFileEntry } from "./types";
import type { SyncAnchorV2, SyncStateEnvelopeV2 } from "./state-envelope-v2";

export type IdentityRenameActionV2 =
  | {
      type: "reconcile-remote-identity";
      anchorId: string;
      previousRemoteId: string;
      remoteId: string;
      path: string;
      expectedRemoteETag: string;
    }
  | {
      type: "move-remote";
      anchorId: string;
      remoteId: string;
      fromPath: string;
      toPath: string;
      expectedRemoteETag: string;
      newName: string;
      newParentId: string;
    }
  | {
      type: "move-local";
      anchorId: string;
      remoteId: string;
      fromPath: string;
      toPath: string;
      expectedLocalHash: string;
      expectedLocalSize: number;
    }
  | {
      /** Legacy anchors without content-version evidence must prove the exact
       *  remote bytes before the public MoveLocalFile action can exist. */
      type: "verify-move-local";
      anchorId: string;
      remoteId: string;
      fromPath: string;
      toPath: string;
      expectedLocalHash: string;
      expectedLocalSize: number;
    }
  | {
      type: "conflict";
      anchorId: string;
      path: string;
      relatedPath?: string;
      relatedPaths?: string[];
      reason:
        | "remote-identity-missing"
        | "remote-content-changed"
        | "local-identity-ambiguous"
        | "local-destination-occupied"
        | "remote-destination-occupied"
        | "destination-parent-missing"
        | "both-paths-diverged"
        | "replacement-with-local-relocation"
        | "same-path-identity-occupied";
    };

export interface IdentityRenamePlanOptionsV2 {
  /**
   * Folder identities whose paths will be established by an earlier folder
   * move in the same SyncPlan. This does not mutate the committed envelope.
   */
  projectedFolderIdentities?: readonly {
    path: string;
    remoteId: string;
  }[];
}

/** Plan only identity-proven moves. Execution still requires local/remote CAS. */
export function planIdentityRenamesV2(
  envelope: SyncStateEnvelopeV2,
  localEntries: readonly LocalFileEntry[],
  options: IdentityRenamePlanOptionsV2 = {},
): IdentityRenameActionV2[] {
  return planIdentityRenamesFromStateV2(
    canonicalPlannerStateFromEnvelopeV2(envelope),
    localEntries,
    options,
  );
}

export function planIdentityRenamesFromStateV2(
  state: CanonicalPlannerStateV2,
  localEntries: readonly LocalFileEntry[],
  options: IdentityRenamePlanOptionsV2 = {},
): IdentityRenameActionV2[] {
  const pathByRemoteId = state.remotePathById;
  const remoteIdByPath = new Map([...pathByRemoteId].map(([id, path]) => [normalizePath(path), id]));
  const localByPath = new Map(localEntries.map((entry) => [normalizePath(entry.path), entry]));
  const occupiedAnchoredLocalPaths = new Set(
    state.fileAnchors
      .filter((anchor) => anchor.remoteId)
      .map((anchor) => normalizePath(anchor.lastPath))
      .filter((path) => localByPath.has(path)),
  );
  const unanchoredLocalByContent = new Map<string, LocalFileEntry[]>();
  for (const entry of localEntries) {
    if (occupiedAnchoredLocalPaths.has(normalizePath(entry.path))) continue;
    const key = localContentKey(entry.hash, entry.size);
    const matches = unanchoredLocalByContent.get(key) ?? [];
    matches.push(entry);
    unanchoredLocalByContent.set(key, matches);
  }
  const folderIdByPath = new Map<string, string>();
  for (const [id, path] of pathByRemoteId) {
    if (state.remoteNodeById.get(id)?.kind === "folder") {
      folderIdByPath.set(normalizePath(path), id);
    }
  }
  for (const projected of options.projectedFolderIdentities ?? []) {
    const node = state.remoteNodeById.get(projected.remoteId);
    const key = normalizePath(projected.path);
    const occupiedId = folderIdByPath.get(key);
    if (node?.kind === "folder" && (!occupiedId || occupiedId === projected.remoteId)) {
      folderIdByPath.set(key, projected.remoteId);
    }
  }

  const actions: IdentityRenameActionV2[] = [];
  for (const anchor of state.fileAnchors) {
    if (!anchor.remoteId) continue;
    const remote = state.remoteNodeById.get(anchor.remoteId);
    const remotePath = pathByRemoteId.get(anchor.remoteId);
    const anchorPathKey = normalizePath(anchor.lastPath);
    const occupantId = remoteIdByPath.get(anchorPathKey);
    const occupant = occupantId
      ? state.remoteNodeById.get(occupantId)
      : undefined;
    const oldLocal = localByPath.get(anchorPathKey);
    const matchingLocals = unanchoredLocalByContent.get(
      localContentKey(anchor.contentHash, anchor.size),
    ) ?? [];

    if (!remote || remote.kind !== "file" || !remotePath) {
      if (
        occupantId
        && occupantId !== anchor.remoteId
        && occupant?.kind === "file"
      ) {
        if (!oldLocal && matchingLocals.length > 0) {
          actions.push(conflict(
            anchor,
            anchor.lastPath,
            "replacement-with-local-relocation",
            matchingLocals.length === 1 ? matchingLocals[0].path : undefined,
            matchingLocals.length > 1
              ? matchingLocals.map((entry) => entry.path)
              : undefined,
          ));
        } else {
          actions.push({
            type: "reconcile-remote-identity",
            anchorId: anchor.anchorId,
            previousRemoteId: anchor.remoteId,
            remoteId: occupantId,
            path: anchor.lastPath,
            expectedRemoteETag: occupant.eTag ?? "",
          });
        }
        continue;
      }
      if (!oldLocal && matchingLocals.length > 0) {
        actions.push(conflict(
          anchor,
          anchor.lastPath,
          "remote-identity-missing",
          matchingLocals.length === 1 ? matchingLocals[0].path : undefined,
          matchingLocals.length > 1
            ? matchingLocals.map((entry) => entry.path)
            : undefined,
        ));
      }
      continue;
    }

    if (
      remotePath !== anchor.lastPath
      && occupantId
      && occupantId !== remote.id
    ) {
      actions.push(conflict(
        anchor,
        anchor.lastPath,
        "same-path-identity-occupied",
        remotePath,
      ));
      continue;
    }

    // Remote identity moved while local stayed at the anchored path.
    if (remotePath !== anchor.lastPath && oldLocal) {
      const remoteHashKnown = remote.contentHash !== undefined;
      const contentTagComparable =
        !remoteHashKnown
        && anchor.remoteCTag !== undefined
        && remote.cTag !== undefined;
      const localChanged = !localMatchesAnchor(oldLocal, anchor);
      // A unilateral remote move+edit (local unchanged, remote content version
      // advanced) is not a divergence: follow the remote move here and let the
      // ordinary same-path content decision converge the bytes afterwards
      // (file-decision-planner-v2 downloads when local matches the anchor, so
      // the remote version wins). Only a local-side change keeps the fail-
      // closed conflict for the moved path.
      if (localChanged) {
        actions.push(conflict(
          anchor,
          anchor.lastPath,
          "both-paths-diverged",
          remotePath,
        ));
      } else if (localByPath.has(normalizePath(remotePath))) {
        actions.push(conflict(
          anchor,
          remotePath,
          "local-destination-occupied",
          anchor.lastPath,
        ));
      } else if (
        remoteHashKnown
        || contentTagComparable
      ) {
        actions.push({
          type: "move-local",
          anchorId: anchor.anchorId,
          remoteId: remote.id,
          fromPath: anchor.lastPath,
          toPath: remotePath,
          expectedLocalHash: oldLocal.hash,
          expectedLocalSize: oldLocal.size,
        });
      } else {
        actions.push({
          type: "verify-move-local",
          anchorId: anchor.anchorId,
          remoteId: remote.id,
          fromPath: anchor.lastPath,
          toPath: remotePath,
          expectedLocalHash: oldLocal.hash,
          expectedLocalSize: oldLocal.size,
        });
      }
      continue;
    }

    // Both sides already show the same path. Nothing to move.
    if (remotePath !== anchor.lastPath
      && matchingLocals.length === 1
      && matchingLocals[0].path === remotePath) continue;

    // Local disappeared from the anchor path: only a unique content-identical
    // candidate may authorize a remote identity move.
    if (!oldLocal) {
      if (matchingLocals.length === 0) {
        continue;
      }
      if (matchingLocals.length > 1) {
        actions.push(conflict(
          anchor,
          anchor.lastPath,
          "local-identity-ambiguous",
          undefined,
          matchingLocals.map((entry) => entry.path),
        ));
        continue;
      }
      const destination = matchingLocals[0];
      if (remotePath !== anchor.lastPath) {
        actions.push(conflict(anchor, destination.path, "both-paths-diverged"));
        continue;
      }
      if (!remoteMatchesAnchor(remote, anchor)) {
        actions.push(conflict(
          anchor,
          anchor.lastPath,
          "remote-content-changed",
          destination.path,
        ));
        continue;
      }
      const occupiedId = remoteIdByPath.get(normalizePath(destination.path));
      if (occupiedId && occupiedId !== remote.id) {
        actions.push(conflict(
          anchor,
          destination.path,
          "remote-destination-occupied",
          anchor.lastPath,
        ));
        continue;
      }
      const slash = destination.path.lastIndexOf("/");
      const parentPath = slash === -1 ? "" : destination.path.slice(0, slash);
      const parentId = parentPath === ""
        ? state.remoteIndex.filesRootId
        : folderIdByPath.get(normalizePath(parentPath));
      if (!parentId) {
        actions.push(conflict(
          anchor,
          destination.path,
          "destination-parent-missing",
          anchor.lastPath,
        ));
        continue;
      }
      actions.push({
        type: "move-remote",
        anchorId: anchor.anchorId,
        remoteId: remote.id,
        fromPath: anchor.lastPath,
        toPath: destination.path,
        expectedRemoteETag: remote.eTag!,
        newName: destination.path.slice(slash + 1),
        newParentId: parentId,
      });
    }
  }
  return actions;
}

function remoteMatchesAnchor(
  remote: Readonly<RemoteNodeV2>,
  anchor: SyncAnchorV2,
): boolean {
  if (remote.size !== anchor.size) return false;
  if (remote.contentHash) {
    return remote.contentHash === anchor.contentHash;
  }
  if (remote.cTag && anchor.remoteCTag) {
    return remote.cTag === anchor.remoteCTag;
  }
  return Boolean(
    remote.eTag
    && anchor.remoteETag
    && remote.eTag === anchor.remoteETag,
  );
}

function localMatchesAnchor(local: LocalFileEntry, anchor: SyncAnchorV2): boolean {
  return local.hash === anchor.contentHash && local.size === anchor.size;
}

function conflict(
  anchor: SyncAnchorV2,
  path: string,
  reason: Extract<IdentityRenameActionV2, { type: "conflict" }>["reason"],
  relatedPath?: string,
  relatedPaths?: string[],
): IdentityRenameActionV2 {
  return {
    type: "conflict",
    anchorId: anchor.anchorId,
    path,
    reason,
    ...(relatedPath ? { relatedPath } : {}),
    ...(relatedPaths && relatedPaths.length > 0
      ? { relatedPaths }
      : {}),
  };
}

function normalizePath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

function localContentKey(hash: string, size: number): string {
  return `${size}:${hash}`;
}
