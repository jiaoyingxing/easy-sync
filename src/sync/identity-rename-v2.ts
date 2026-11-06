import {
  canonicalPlannerStateFromEnvelopeV2,
  type CanonicalPlannerStateV2,
} from "./canonical-planner-state-v2";
import type { RemoteNodeV2 } from "./remote-index-v2";
import {
  sameSyncScope,
  type LocalFileEntry,
  type LocalFolderMoveHintV1,
} from "./types";
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
        | "destination-parent-spelling-diverged"
        | "both-paths-diverged"
        | "replacement-with-local-relocation"
        | "same-path-identity-occupied";
    };

interface IdentityRenamePlanOptionsV2 {
  /**
   * Folder identities whose paths will be established by an earlier folder
   * move in the same SyncPlan. This does not mutate the committed envelope.
   */
  projectedFolderIdentities?: readonly {
    path: string;
    remoteId: string;
  }[];
  /**
   * Device-local host-rename evidence (`fromPath -> toPath`) bound to one
   * committed file identity. It may prove a relocation even when the local
   * content changed; it is single-device evidence and never replaces the
   * remote version, destination and CAS gates below.
   */
  localFileMoveHints?: readonly LocalFolderMoveHintV1[];
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
  const remoteIdByPath = new Map([...pathByRemoteId].map(([id, path]) => [normalizeIdentityPath(path), id]));
  const localByPath = new Map(localEntries.map((entry) => [normalizeIdentityPath(entry.path), entry]));
  const occupiedAnchoredLocalPaths = new Set(
    state.fileAnchors
      .filter((anchor) => anchor.remoteId)
      .map((anchor) => normalizeIdentityPath(anchor.lastPath))
      .filter((path) => localByPath.has(path)),
  );
  const unanchoredLocalByContent = new Map<string, LocalFileEntry[]>();
  for (const entry of localEntries) {
    if (occupiedAnchoredLocalPaths.has(normalizeIdentityPath(entry.path))) continue;
    const key = localContentKey(entry.hash, entry.size);
    const matches = unanchoredLocalByContent.get(key) ?? [];
    matches.push(entry);
    unanchoredLocalByContent.set(key, matches);
  }
  const committedFolderIdByPath = new Map<string, string>();
  const committedPathByFolderId = new Map<string, string>();
  for (const [id, path] of pathByRemoteId) {
    if (state.remoteNodeById.get(id)?.kind === "folder") {
      committedFolderIdByPath.set(normalizeIdentityPath(path), id);
      committedPathByFolderId.set(id, path);
    }
  }
  const folderIdByPath = new Map(committedFolderIdByPath);
  const pathByFolderId = new Map(committedPathByFolderId);
  for (const projected of options.projectedFolderIdentities ?? []) {
    const node = state.remoteNodeById.get(projected.remoteId);
    const key = normalizeIdentityPath(projected.path);
    const occupiedId = folderIdByPath.get(key);
    if (node?.kind === "folder" && (!occupiedId || occupiedId === projected.remoteId)) {
      folderIdByPath.set(key, projected.remoteId);
      pathByFolderId.set(projected.remoteId, projected.path);
    }
  }

  // Host-rename evidence is accepted only while it is still bound to the
  // committed anchor at its source path; a hint that survived a committed
  // move, a scope change or a replaced identity is inert. Claims are indexed
  // by destination so two identities cannot both claim one local file.
  const anchorByRemoteId = new Map<string, SyncAnchorV2>();
  for (const anchor of state.fileAnchors) {
    if (anchor.remoteId) anchorByRemoteId.set(anchor.remoteId, anchor);
  }
  const hintsByRemoteId = new Map<string, LocalFolderMoveHintV1>();
  const hintClaimsByDestination = new Map<string, LocalFolderMoveHintV1[]>();
  for (const hint of options.localFileMoveHints ?? []) {
    if (!sameSyncScope(hint.scope, state.scope)) continue;
    if (hint.toPath === ".trash" || hint.toPath.startsWith(".trash/")) continue;
    const boundAnchor = anchorByRemoteId.get(hint.remoteId);
    if (!boundAnchor
      || normalizeIdentityPath(hint.fromPath)
        !== normalizeIdentityPath(boundAnchor.lastPath)) continue;
    // The record layer keeps one hint per identity; a duplicated entry in
    // corrupted device data must not create a phantom second claim.
    if (hintsByRemoteId.has(hint.remoteId)) continue;
    hintsByRemoteId.set(hint.remoteId, hint);
    const destinationKey = normalizeIdentityPath(hint.toPath);
    const claims = hintClaimsByDestination.get(destinationKey) ?? [];
    claims.push(hint);
    hintClaimsByDestination.set(destinationKey, claims);
  }

  const actions: IdentityRenameActionV2[] = [];
  for (const anchor of state.fileAnchors) {
    planIdentityRenameForAnchorV2({
      anchor,
      state,
      pathByRemoteId,
      remoteIdByPath,
      localByPath,
      unanchoredLocalByContent,
      occupiedAnchoredLocalPaths,
      hintsByRemoteId,
      hintClaimsByDestination,
      folderIdByPath,
      pathByFolderId,
      committedFolderIdByPath,
      committedPathByFolderId,
      actions,
    });
  }
  return actions;
}

/**
 * Plan the identity-rename actions for one anchor of the planner state.
 *
 * Every early exit in this phase means "no further action for this anchor" and
 * is expressed as a plain return: the caller's loop simply moves on to the next
 * anchor. All produced actions are pushed into the shared `actions` array passed
 * by reference, so the phase owns no products of its own.
 */
function planIdentityRenameForAnchorV2(args: {
  anchor: SyncAnchorV2;
  state: CanonicalPlannerStateV2;
  pathByRemoteId: CanonicalPlannerStateV2["remotePathById"];
  remoteIdByPath: Map<string, string>;
  localByPath: Map<string, LocalFileEntry>;
  unanchoredLocalByContent: Map<string, LocalFileEntry[]>;
  occupiedAnchoredLocalPaths: ReadonlySet<string>;
  hintsByRemoteId: ReadonlyMap<string, LocalFolderMoveHintV1>;
  hintClaimsByDestination: ReadonlyMap<string, readonly LocalFolderMoveHintV1[]>;
  folderIdByPath: Map<string, string>;
  pathByFolderId: Map<string, string>;
  committedFolderIdByPath: Map<string, string>;
  committedPathByFolderId: Map<string, string>;
  actions: IdentityRenameActionV2[];
}): void {
  const {
    anchor,
    state,
    pathByRemoteId,
    remoteIdByPath,
    localByPath,
    unanchoredLocalByContent,
    occupiedAnchoredLocalPaths,
    hintsByRemoteId,
    hintClaimsByDestination,
    folderIdByPath,
    pathByFolderId,
    committedFolderIdByPath,
    committedPathByFolderId,
    actions,
  } = args;
    if (!anchor.remoteId) return;
    const remote = state.remoteNodeById.get(anchor.remoteId);
    const remotePath = pathByRemoteId.get(anchor.remoteId);
    const anchorPathKey = normalizeIdentityPath(anchor.lastPath);
    const occupantId = remoteIdByPath.get(anchorPathKey);
    const occupant = occupantId
      ? state.remoteNodeById.get(occupantId)
      : undefined;
    const oldLocal = localByPath.get(anchorPathKey);
    const matchingLocals = unanchoredLocalByContent.get(
      localContentKey(anchor.contentHash, anchor.size),
    ) ?? [];
    const boundHint = anchor.remoteId
      ? hintsByRemoteId.get(anchor.remoteId)
      : undefined;
    const hintedLocal = boundHint
      ? localByPath.get(normalizeIdentityPath(boundHint.toPath))
      : undefined;

    if (!remote || remote.kind !== "file" || !remotePath) {
      if (
        occupantId
        && occupantId !== anchor.remoteId
        && occupant?.kind === "file"
      ) {
        if (!oldLocal && (matchingLocals.length > 0 || hintedLocal)) {
          // A same-path replacement plus a proven local relocation is still
          // ambiguous: the vanished identity cannot be proven to be the
          // replacement. Content pairing alone missed the edited hint case;
          // the host hint now names the real relocation, so never rebind.
          const relocationLocals = matchingLocals.length > 0
            ? matchingLocals
            : [hintedLocal!];
          actions.push(conflict(
            anchor,
            anchor.lastPath,
            "replacement-with-local-relocation",
            relocationLocals.length === 1
              ? relocationLocals[0].path
              : undefined,
            relocationLocals.length > 1
              ? relocationLocals.map((entry) => entry.path)
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
        return;
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
      return;
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
      return;
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
      //
      // A case/Unicode-only remote rename folds to the anchored key, so the
      // entry the destination key holds IS `oldLocal` — a spelling alias of the
      // moved identity, never an occupier. Reading it as occupancy produced a
      // false `local-destination-occupied` conflict for every cloud-side
      // capitalization change (2026-11-05, F34 family); only a destination on
      // a different folded path can be occupied by another local file.
      const destinationOccupied = localByPath.has(
        normalizeIdentityPath(remotePath),
      ) && normalizeIdentityPath(remotePath) !== anchorPathKey;
      if (localChanged) {
        actions.push(conflict(
          anchor,
          anchor.lastPath,
          "both-paths-diverged",
          remotePath,
        ));
      } else if (destinationOccupied) {
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
      return;
    }

    // Both sides already show the same path. Nothing to move.
    if (remotePath !== anchor.lastPath
      && matchingLocals.length === 1
      && matchingLocals[0].path === remotePath) return;

    // Local disappeared from the anchor path. A host rename hint bound to this
    // committed identity is stronger evidence than content pairing: it proves
    // the relocation even when the local bytes changed. Without a usable hint
    // the historical rule stands — only a unique content-identical candidate
    // may authorize the move.
    if (!oldLocal) {
      const hintResolution = resolveRelocatedLocalHintDestination({
        anchor,
        hint: boundHint,
        remotePath,
        localByPath,
        occupiedAnchoredLocalPaths,
        hintClaimsByDestination,
      });
      if (hintResolution.kind === "conflict") {
        actions.push(hintResolution.action);
        return;
      }
      if (
        hintResolution.kind === "converged"
        || hintResolution.kind === "blocked"
      ) return;
      const hintProven = hintResolution.kind === "move";
      planIdentityRenameForRelocatedLocalV2({
        anchor,
        state,
        remote,
        remotePath,
        matchingLocals: hintProven
          ? [hintResolution.destination]
          : matchingLocals,
        remoteIdByPath,
        // A hint may only land in a committed folder identity. A folder the
        // same plan creates or moves stays with the folder layer (fail closed
        // here) instead of widening this slice into folder projection.
        folderIdByPath: hintProven
          ? committedFolderIdByPath
          : folderIdByPath,
        pathByFolderId: hintProven
          ? committedPathByFolderId
          : pathByFolderId,
        actions,
      });
    }
}

type RelocatedLocalHintResolutionV2 =
  | { kind: "none" }
  | { kind: "blocked" }
  | { kind: "converged" }
  | { kind: "move"; destination: LocalFileEntry }
  | {
      kind: "conflict";
      action: Extract<IdentityRenameActionV2, { type: "conflict" }>;
    };

/**
 * Resolve the destination a host rename hint proves for a vanished local path.
 *
 * The hint index has already bound the hint to the committed anchor and its
 * current source path. This phase only validates the destination against the
 * local scan: a missing destination blocks (the file was deleted after the
 * rename), an anchored occupant and a shared claim block as conflicts, and a
 * destination that already equals the remote path means both sides converged.
 */
function resolveRelocatedLocalHintDestination(args: {
  anchor: SyncAnchorV2;
  hint: LocalFolderMoveHintV1 | undefined;
  remotePath: string;
  localByPath: Map<string, LocalFileEntry>;
  occupiedAnchoredLocalPaths: ReadonlySet<string>;
  hintClaimsByDestination: ReadonlyMap<string, readonly LocalFolderMoveHintV1[]>;
}): RelocatedLocalHintResolutionV2 {
  const {
    anchor,
    hint,
    remotePath,
    localByPath,
    occupiedAnchoredLocalPaths,
    hintClaimsByDestination,
  } = args;
  if (!hint) return { kind: "none" };
  const destinationKey = normalizeIdentityPath(hint.toPath);
  const destination = localByPath.get(destinationKey);
  // The hinted destination disappeared after the rename: falling back to a
  // content-identical copy elsewhere would claim the wrong file. Keep the
  // ordinary deletion/conflict decision instead.
  if (!destination) return { kind: "blocked" };
  const claims = hintClaimsByDestination.get(destinationKey) ?? [];
  if (claims.length > 1) {
    return {
      kind: "conflict",
      action: conflict(
        anchor,
        destination.path,
        "local-identity-ambiguous",
        undefined,
        claims
          .filter((claim) => claim.remoteId !== hint.remoteId)
          .map((claim) => claim.fromPath),
      ),
    };
  }
  if (occupiedAnchoredLocalPaths.has(destinationKey)) {
    return {
      kind: "conflict",
      action: conflict(
        anchor,
        destination.path,
        "local-destination-occupied",
        anchor.lastPath,
      ),
    };
  }
  if (destinationKey === normalizeIdentityPath(remotePath)) {
    return { kind: "converged" };
  }
  return { kind: "move", destination };
}

/**
 * Plan the identity-rename actions for an anchor whose local file left the
 * anchored path (the caller enters this phase only when no local entry
 * occupies `anchor.lastPath`).
 *
 * The caller supplies either the hint-proven destination (one entry) or the
 * historical unique content-identical candidates. Every other shape becomes a
 * fail-closed conflict. Every early exit is a plain return meaning "no further
 * action for this anchor": this phase is the caller's tail statement, so
 * returning here is the same as returning from `planIdentityRenameForAnchorV2`.
 * All produced actions are pushed into the shared `actions` array passed by
 * reference, so the phase owns no products of its own.
 */
function planIdentityRenameForRelocatedLocalV2(args: {
  anchor: SyncAnchorV2;
  state: CanonicalPlannerStateV2;
  remote: RemoteNodeV2;
  remotePath: string;
  matchingLocals: readonly LocalFileEntry[];
  remoteIdByPath: Map<string, string>;
  folderIdByPath: Map<string, string>;
  pathByFolderId: Map<string, string>;
  actions: IdentityRenameActionV2[];
}): void {
  const {
    anchor,
    state,
    remote,
    remotePath,
    matchingLocals,
    remoteIdByPath,
    folderIdByPath,
    pathByFolderId,
    actions,
  } = args;
  if (matchingLocals.length === 0) {
    return;
  }
  if (matchingLocals.length > 1) {
    actions.push(conflict(
      anchor,
      anchor.lastPath,
      "local-identity-ambiguous",
      undefined,
      matchingLocals.map((entry) => entry.path),
    ));
    return;
  }
  const destination = matchingLocals[0];
  if (remotePath !== anchor.lastPath) {
    actions.push(conflict(anchor, destination.path, "both-paths-diverged"));
    return;
  }
  if (!remoteMatchesAnchor(remote, anchor)) {
    actions.push(conflict(
      anchor,
      anchor.lastPath,
      "remote-content-changed",
      destination.path,
    ));
    return;
  }
  const occupiedId = remoteIdByPath.get(normalizeIdentityPath(destination.path));
  if (occupiedId && occupiedId !== remote.id) {
    actions.push(conflict(
      anchor,
      destination.path,
      "remote-destination-occupied",
      anchor.lastPath,
    ));
    return;
  }
  const slash = destination.path.lastIndexOf("/");
  const parentPath = slash === -1 ? "" : destination.path.slice(0, slash);
  const parentId = parentPath === ""
    ? state.remoteIndex.filesRootId
    : folderIdByPath.get(normalizeIdentityPath(parentPath));
  if (!parentId) {
    actions.push(conflict(
      anchor,
      destination.path,
      "destination-parent-missing",
      anchor.lastPath,
    ));
    return;
  }
  // The parent resolved by identity alias (NFC + case fold), but this move
  // would be recorded under the local spelling while the committed tree keeps
  // the canonical one: the byte-exact parent receipt can then never commit
  // (field case 2026-10-14 — `Videos/` against index `videos/`). Withhold the
  // remote move and let the folder layer's deferral carry the divergence.
  const canonicalParentPath = parentPath === ""
    ? ""
    : pathByFolderId.get(parentId);
  if (canonicalParentPath !== parentPath) {
    actions.push(conflict(
      anchor,
      destination.path,
      "destination-parent-spelling-diverged",
      anchor.lastPath,
    ));
    return;
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
): Extract<IdentityRenameActionV2, { type: "conflict" }> {
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

/** Rename-matching path key: NFC + en-US case folding (not separator
 *  normalization). Semantically equivalent to the shared `identityPath`. */
function normalizeIdentityPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function localContentKey(hash: string, size: number): string {
  return `${size}:${hash}`;
}
