import {
  isAnchoredDescendantV2,
  projectRemoteIndexV2,
  translateAnchoredPathV2,
  type RemoteNodeV2,
} from "./remote-index-v2";
import { identityPath } from "./recovery-anchor-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import type { LocalFileEntry, LocalFolderEntry } from "./types";

/** One path-identity folder whose anchored path spelling disappeared because
 *  both sides already use the same new spelling. */
export interface PathIdentityFolderSpellingConvergenceV2 {
  readonly anchorId: string;
  readonly oldRoot: string;
  readonly newRoot: string;
}

type PathIdentityFolderSpellingConvergenceResultV2 =
  | {
      status: "accepted";
      convergedFolderAnchors: number;
      convergedFileAnchors: number;
      envelope: SyncStateEnvelopeV2;
    }
  | {
      status: "rejected";
      reason: "source-changed" | "projection-changed";
    };

interface RemoteNodeAtPath {
  readonly node: RemoteNodeV2;
  readonly path: string;
}

interface DeriveInputV2 {
  envelope: Pick<
    SyncStateEnvelopeV2,
    "remoteIndex" | "folderAnchors" | "anchors"
  >;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  includeFolderPath?: (path: string) => boolean;
  preserveFolderPath?: (path: string) => boolean;
}

function remoteNodesByPath(
  envelope: Pick<SyncStateEnvelopeV2, "remoteIndex">,
): Map<string, RemoteNodeAtPath> {
  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  const nodes = new Map<string, RemoteNodeAtPath>();
  for (const [id, path] of pathById) {
    const node = envelope.remoteIndex.itemsById[id];
    if (node) nodes.set(nfcPath(path), { node, path });
  }
  return nodes;
}

/**
 * Path-identity providers (WebDAV/S3) change the item id with the spelling:
 * after a cloud-side case-only folder rename the old anchor's `remoteId` (the
 * old path) is gone, while the local and remote trees already use the new
 * spelling. The generic folder planner then emits a conflict whose
 * active-forget snapshot cannot find the old remote, leaving a button that can
 * never work.
 *
 * This narrow convergence re-claims the current same-path folder as the
 * continuation of the old anchor. It is state-only: no Vault or remote write,
 * and the ordinary plan reconciles content afterwards. Every anchored
 * descendant must exist on BOTH sides under the translated path with the same
 * kind; a deleted/changed tree shape keeps the visible defer. Content bytes are
 * not part of the proof (a later ordinary decision owns them).
 */
export function derivePathIdentityFolderSpellingConvergencesV2(
  input: DeriveInputV2,
): PathIdentityFolderSpellingConvergenceV2[] {
  if (!input.localFolderScanComplete) return [];
  if (input.envelope.remoteIndex.complete !== true) return [];
  if (!input.envelope.folderAnchors) return [];

  const nodes = remoteNodesByPath(input.envelope);
  const nodeById = input.envelope.remoteIndex.itemsById;
  const localFoldersByIdentity = new Map<string, string>();
  for (const folder of input.localFolders) {
    const key = identityPath(folder.path);
    const previous = localFoldersByIdentity.get(key);
    // Two local folders differing only by spelling are ambiguous.
    if (previous !== undefined && previous !== folder.path) return [];
    localFoldersByIdentity.set(key, folder.path);
  }
  const localFolderPaths = new Set(
    input.localFolders.map((folder) => nfcPath(folder.path)),
  );
  const localFilePaths = new Set(
    input.localFiles.map((entry) => nfcPath(entry.path)),
  );
  const include = input.includeFolderPath ?? (() => true);
  const preserve = input.preserveFolderPath ?? (() => false);
  const candidates: PathIdentityFolderSpellingConvergenceV2[] = [];

  for (const anchor of Object.values(input.envelope.folderAnchors.byAnchorId)) {
    const oldRoot = anchor.lastPath;
    // The old path id must be gone; otherwise the cloud still uses it.
    if (nodeById[anchor.remoteId] !== undefined) continue;
    if (nodes.has(nfcPath(oldRoot))) continue;
    const localFolder = localFoldersByIdentity.get(identityPath(oldRoot));
    if (!localFolder || nfcPath(localFolder) === nfcPath(oldRoot)) continue;
    const newRootAtPath = nodes.get(nfcPath(localFolder));
    if (!newRootAtPath || newRootAtPath.node.kind !== "folder") continue;
    const newRoot = newRootAtPath.path;
    if (identityPath(newRoot) !== identityPath(oldRoot)) continue;
    // A changed parent identity is a real move, not a spelling change.
    if (newRootAtPath.node.parentId !== anchor.parentRemoteId) continue;
    if (!include(oldRoot) || !include(newRoot)) continue;
    if (preserve(oldRoot) || preserve(newRoot)) continue;
    if (!localFolderPaths.has(nfcPath(newRoot))) continue;
    if (localFilePaths.has(nfcPath(newRoot))) continue;
    if (!subtreeShapeMatches(input.envelope, anchor, oldRoot, newRoot, {
      nodes,
      localFolderPaths,
      localFilePaths,
    })) continue;
    candidates.push({ anchorId: anchor.anchorId, oldRoot, newRoot });
  }
  if (candidates.length === 0) return [];

  // A nested candidate is already covered by translating the outer subtree.
  const roots = candidates.filter((candidate) => !candidates.some((other) =>
    other !== candidate
    && isAnchoredDescendantV2(candidate.oldRoot, other.oldRoot)));
  return roots.sort((left, right) =>
    pathDepth(left.oldRoot) - pathDepth(right.oldRoot)
    || left.oldRoot.localeCompare(right.oldRoot));
}

/**
 * Pure state-only re-claim. Every anchor in the old subtree must project to a
 * committed remote node of the same kind; the derivation already checked the
 * local side. Any mismatch rejects the whole rebind. No remote node is added,
 * removed or rewritten.
 */
export function applyPathIdentityFolderSpellingConvergenceV2(
  envelope: SyncStateEnvelopeV2,
  reviewed: Readonly<PathIdentityFolderSpellingConvergenceV2>,
  confirmedAt: number,
): PathIdentityFolderSpellingConvergenceResultV2 {
  const reject = (
    reason: Extract<
      PathIdentityFolderSpellingConvergenceResultV2,
      { status: "rejected" }
    >["reason"],
  ): PathIdentityFolderSpellingConvergenceResultV2 => ({ status: "rejected", reason });
  if (envelope.remoteIndex.complete !== true || !envelope.folderAnchors) {
    return reject("source-changed");
  }
  const current = envelope.folderAnchors.byAnchorId[reviewed.anchorId];
  const nodes = remoteNodesByPath(envelope);
  const rootAtPath = nodes.get(nfcPath(reviewed.newRoot));
  if (
    !current
    || current.remoteId !== reviewed.oldRoot
    || current.lastPath !== reviewed.oldRoot
    || envelope.remoteIndex.itemsById[reviewed.oldRoot] !== undefined
    || !rootAtPath
    || rootAtPath.node.kind !== "folder"
    || rootAtPath.node.parentId !== current.parentRemoteId
  ) return reject("source-changed");

  const nextCommitSeq = envelope.meta.commitSeq + 1;
  const nextFolderAnchors: Record<string, FolderAnchorV2> = {
    ...envelope.folderAnchors.byAnchorId,
  };
  let convergedFolderAnchors = 0;
  for (const anchor of Object.values(nextFolderAnchors)) {
    if (!isAtOrBelow(anchor.lastPath, reviewed.oldRoot)) continue;
    const translated = translateAnchoredPathV2(
      anchor.lastPath,
      reviewed.oldRoot,
      reviewed.newRoot,
    );
    const atPath = nodes.get(nfcPath(translated));
    if (!atPath || atPath.node.kind !== "folder") {
      return reject("projection-changed");
    }
    if (atPath.node.parentId !== expectedParentPath(anchor, {
      oldRoot: reviewed.oldRoot,
      newRoot: reviewed.newRoot,
      rootParentRemoteId: current.parentRemoteId,
    })) {
      return reject("projection-changed");
    }
    nextFolderAnchors[anchor.anchorId] = {
      ...anchor,
      remoteId: atPath.path,
      lastPath: atPath.path,
      parentRemoteId: atPath.node.parentId,
      ...(atPath.node.eTag !== undefined
        ? { remoteETag: atPath.node.eTag }
        : {}),
      confirmedGeneration: nextCommitSeq,
      confirmedAt,
    };
    convergedFolderAnchors++;
  }
  if (convergedFolderAnchors === 0) return reject("source-changed");

  const nextFileAnchors: Record<string, SyncAnchorV2> = {
    ...envelope.anchors.byAnchorId,
  };
  let convergedFileAnchors = 0;
  for (const anchor of Object.values(nextFileAnchors)) {
    if (!isAnchoredDescendantV2(anchor.lastPath, reviewed.oldRoot)) continue;
    if (!anchor.remoteId) return reject("projection-changed");
    const translated = translateAnchoredPathV2(
      anchor.lastPath,
      reviewed.oldRoot,
      reviewed.newRoot,
    );
    const atPath = nodes.get(nfcPath(translated));
    if (!atPath || atPath.node.kind !== "file") {
      return reject("projection-changed");
    }
    nextFileAnchors[anchor.anchorId] = {
      ...anchor,
      remoteId: atPath.path,
      lastPath: atPath.path,
      ...(atPath.node.eTag !== undefined
        ? { remoteETag: atPath.node.eTag }
        : {}),
      confirmedAt,
      confirmedBy: "folder-spelling-convergence",
    };
    convergedFileAnchors++;
  }

  const next: SyncStateEnvelopeV2 = {
    ...envelope,
    meta: {
      ...envelope.meta,
      commitSeq: nextCommitSeq,
      committedAt: confirmedAt,
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextFileAnchors),
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: sortRecord(nextFolderAnchors),
    },
  };
  validateEnvelope(next);
  return {
    status: "accepted",
    convergedFolderAnchors,
    convergedFileAnchors,
    envelope: next,
  };
}

function subtreeShapeMatches(
  envelope: Pick<SyncStateEnvelopeV2, "folderAnchors" | "anchors">,
  root: FolderAnchorV2,
  oldRoot: string,
  newRoot: string,
  facts: {
    nodes: ReadonlyMap<string, RemoteNodeAtPath>;
    localFolderPaths: ReadonlySet<string>;
    localFilePaths: ReadonlySet<string>;
  },
): boolean {
  for (const anchor of Object.values(envelope.folderAnchors!.byAnchorId)) {
    if (!isAtOrBelow(anchor.lastPath, oldRoot)) continue;
    const translated = translateAnchoredPathV2(anchor.lastPath, oldRoot, newRoot);
    const atPath = facts.nodes.get(nfcPath(translated));
    if (!atPath || atPath.node.kind !== "folder") return false;
    if (atPath.node.parentId !== expectedParentPath(anchor, {
      oldRoot,
      newRoot,
      rootParentRemoteId: root.parentRemoteId,
    })) return false;
    if (!facts.localFolderPaths.has(nfcPath(translated))) return false;
    if (anchor.anchorId === root.anchorId && translated !== newRoot) return false;
  }
  for (const anchor of Object.values(envelope.anchors.byAnchorId)) {
    if (!isAnchoredDescendantV2(anchor.lastPath, oldRoot)) continue;
    if (!anchor.remoteId) return false;
    const translated = translateAnchoredPathV2(anchor.lastPath, oldRoot, newRoot);
    const atPath = facts.nodes.get(nfcPath(translated));
    if (!atPath || atPath.node.kind !== "file") return false;
    if (!facts.localFilePaths.has(nfcPath(translated))) return false;
  }
  return true;
}

function expectedParentPath(
  anchor: Pick<FolderAnchorV2, "lastPath">,
  review: {
    oldRoot: string;
    newRoot: string;
    rootParentRemoteId: string;
  },
): string {
  if (nfcPath(anchor.lastPath) === nfcPath(review.oldRoot)) {
    return review.rootParentRemoteId;
  }
  return translateAnchoredPathV2(
    parentPath(anchor.lastPath),
    review.oldRoot,
    review.newRoot,
  );
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function nfcPath(path: string): string {
  return path.normalize("NFC");
}

function isAtOrBelow(path: string, root: string): boolean {
  const key = identityPath(path);
  const rootKey = identityPath(root);
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
