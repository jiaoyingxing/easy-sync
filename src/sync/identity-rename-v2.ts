import { projectRemoteIndexV2 } from "./remote-index-v2";
import type { LocalFileEntry } from "./types";
import type { SyncAnchorV2, SyncStateEnvelopeV2 } from "./state-envelope-v2";

export type IdentityRenameActionV2 =
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
      type: "conflict";
      anchorId: string;
      path: string;
      reason: "remote-identity-missing" | "remote-content-changed" | "local-identity-ambiguous" | "destination-occupied" | "destination-parent-missing" | "both-paths-diverged";
    };

/** Plan only identity-proven moves. Execution still requires local/remote CAS. */
export function planIdentityRenamesV2(
  envelope: SyncStateEnvelopeV2,
  localEntries: readonly LocalFileEntry[],
): IdentityRenameActionV2[] {
  const pathByRemoteId = projectRemoteIndexV2(envelope.remoteIndex);
  const remoteIdByPath = new Map([...pathByRemoteId].map(([id, path]) => [normalizePath(path), id]));
  const localByPath = new Map(localEntries.map((entry) => [normalizePath(entry.path), entry]));
  const folderIdByPath = new Map<string, string>();
  for (const [id, path] of pathByRemoteId) {
    if (envelope.remoteIndex.itemsById[id]?.kind === "folder") folderIdByPath.set(normalizePath(path), id);
  }

  const actions: IdentityRenameActionV2[] = [];
  for (const anchor of Object.values(envelope.anchors.byAnchorId)) {
    if (!anchor.remoteId) continue;
    const remote = envelope.remoteIndex.itemsById[anchor.remoteId];
    const remotePath = pathByRemoteId.get(anchor.remoteId);
    if (!remote || remote.kind !== "file" || !remotePath) {
      actions.push(conflict(anchor, anchor.lastPath, "remote-identity-missing"));
      continue;
    }
    const oldLocal = localByPath.get(normalizePath(anchor.lastPath));
    const matchingLocals = localEntries.filter((entry) =>
      entry.hash === anchor.contentHash && entry.size === anchor.size,
    );

    // Remote identity moved while local stayed at the anchored path.
    if (remotePath !== anchor.lastPath && oldLocal) {
      if (!localMatchesAnchor(oldLocal, anchor)
        || remote.contentHash !== anchor.contentHash
        || remote.size !== anchor.size) {
        actions.push(conflict(anchor, anchor.lastPath, "both-paths-diverged"));
      } else if (localByPath.has(normalizePath(remotePath))) {
        actions.push(conflict(anchor, remotePath, "destination-occupied"));
      } else {
        actions.push({
          type: "move-local",
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
      && matchingLocals[0]!.path === remotePath) continue;

    // Local disappeared from the anchor path: only a unique content-identical
    // candidate may authorize a remote identity move.
    if (!oldLocal) {
      if (matchingLocals.length !== 1) {
        actions.push(conflict(anchor, anchor.lastPath, "local-identity-ambiguous"));
        continue;
      }
      const destination = matchingLocals[0]!;
      if (remotePath !== anchor.lastPath) {
        actions.push(conflict(anchor, destination.path, "both-paths-diverged"));
        continue;
      }
      if (!remoteMatchesAnchor(remote, anchor)) {
        actions.push(conflict(anchor, anchor.lastPath, "remote-content-changed"));
        continue;
      }
      const occupiedId = remoteIdByPath.get(normalizePath(destination.path));
      if (occupiedId && occupiedId !== remote.id) {
        actions.push(conflict(anchor, destination.path, "destination-occupied"));
        continue;
      }
      const slash = destination.path.lastIndexOf("/");
      const parentPath = slash === -1 ? "" : destination.path.slice(0, slash);
      const parentId = parentPath === ""
        ? envelope.remoteIndex.filesRootId
        : folderIdByPath.get(normalizePath(parentPath));
      if (!parentId) {
        actions.push(conflict(anchor, destination.path, "destination-parent-missing"));
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
  remote: SyncStateEnvelopeV2["remoteIndex"]["itemsById"][string],
  anchor: SyncAnchorV2,
): boolean {
  if (!remote.eTag || !anchor.remoteETag) return false;
  if (remote.contentHash) {
    return remote.contentHash === anchor.contentHash && remote.size === anchor.size;
  }
  return remote.eTag === anchor.remoteETag && remote.size === anchor.size;
}

function localMatchesAnchor(local: LocalFileEntry, anchor: SyncAnchorV2): boolean {
  return local.hash === anchor.contentHash && local.size === anchor.size;
}

function conflict(
  anchor: SyncAnchorV2,
  path: string,
  reason: Extract<IdentityRenameActionV2, { type: "conflict" }>["reason"],
): IdentityRenameActionV2 {
  return { type: "conflict", anchorId: anchor.anchorId, path, reason };
}

function normalizePath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}
