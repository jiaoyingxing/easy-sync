import {
  isAnchoredDescendantV2,
  projectRemoteIndexV2,
  translateAnchoredPathV2,
} from "./remote-index-v2";
import { identityPath } from "./recovery-anchor-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import type { LocalFileEntry, LocalFolderEntry } from "./types";

/** One stale folder anchor whose committed spelling can move to the spelling
 *  both sides already use, without any local or remote write. */
export interface ConvergedFolderAnchorSpellingV2 {
  readonly anchorId: string;
  readonly remoteId: string;
  readonly fromPath: string;
  readonly toPath: string;
}

type FolderAnchorSpellingConvergenceResultV2 =
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

interface DeriveInputV2 {
  envelope: Pick<SyncStateEnvelopeV2, "remoteIndex" | "folderAnchors" | "scope">;
  localFiles: readonly LocalFileEntry[];
  localFolders: readonly LocalFolderEntry[];
  localFolderScanComplete: boolean;
  includeFolderPath?: (path: string) => boolean;
  preserveFolderPath?: (path: string) => boolean;
}

/**
 * Derive folder anchors whose recorded spelling is stale because BOTH sides
 * already use the same spelling. A case-only folder rename first fails closed
 * in the folder planner (local-rename-evidence-conflict / target-occupied);
 * once the user makes both sides identical, only the committed anchor keeps the
 * old spelling and every later round repeats the same conflict forever.
 *
 * This is the narrow, provable slice of the folder-layer convergence gap:
 * - the anchored remote folder still exists under the same remote identity and
 *   its parent is unchanged (this is a spelling change, not a real move);
 * - the committed and remote paths are identity-equal but not NFC-equal
 *   (case-only), so the conflict is purely spelling;
 * - a local folder exists at the remote canonical spelling exactly, and no
 *   local file occupies that identity;
 * - both spellings stay inside the sync scope.
 *
 * The result authorizes one state-only subtree rebind; it never writes the
 * vault or the remote.
 */
export function deriveConvergedFolderAnchorSpellingsV2(
  input: DeriveInputV2,
): ConvergedFolderAnchorSpellingV2[] {
  if (!input.localFolderScanComplete) return [];
  if (input.envelope.remoteIndex.complete !== true) return [];
  if (!input.envelope.folderAnchors) return [];

  const pathById = projectRemoteIndexV2(input.envelope.remoteIndex);
  const localFoldersByIdentity = new Map<string, string>();
  for (const folder of input.localFolders) {
    const key = identityPath(folder.path);
    const previous = localFoldersByIdentity.get(key);
    // Two local folders differing only by spelling make the local fact
    // ambiguous; the planner rejects that scan shape on its own.
    if (previous !== undefined && previous !== folder.path) return [];
    localFoldersByIdentity.set(key, folder.path);
  }
  const localFileIdentities = new Set(
    input.localFiles.map((entry) => identityPath(entry.path)),
  );
  const include = input.includeFolderPath ?? (() => true);
  const preserve = input.preserveFolderPath ?? (() => false);

  const candidates: ConvergedFolderAnchorSpellingV2[] = [];
  for (const anchor of Object.values(input.envelope.folderAnchors.byAnchorId)) {
    const node = input.envelope.remoteIndex.itemsById[anchor.remoteId];
    const remotePath = pathById.get(anchor.remoteId);
    if (!node || node.kind !== "folder" || remotePath === undefined) continue;
    if (nfcPath(anchor.lastPath) === nfcPath(remotePath)) continue;
    if (identityPath(anchor.lastPath) !== identityPath(remotePath)) continue;
    // A changed parent identity makes this a real move, not a spelling edit;
    // leave it to the ordinary folder-move planner.
    if (anchor.parentRemoteId !== node.parentId) continue;
    if (!include(anchor.lastPath) || !include(remotePath)) continue;
    if (preserve(anchor.lastPath) || preserve(remotePath)) continue;
    const localPath = localFoldersByIdentity.get(identityPath(remotePath));
    if (!localPath || nfcPath(localPath) !== nfcPath(remotePath)) continue;
    if (localFileIdentities.has(identityPath(remotePath))) continue;
    candidates.push({
      anchorId: anchor.anchorId,
      remoteId: anchor.remoteId,
      fromPath: anchor.lastPath,
      toPath: remotePath,
    });
  }
  if (candidates.length === 0) return [];

  // A nested candidate is already covered by translating the outer subtree;
  // keeping it would rebind the same anchor twice.
  const roots = candidates.filter((candidate) => !candidates.some((other) =>
    other !== candidate
    && isAnchoredDescendantV2(candidate.fromPath, other.fromPath)));
  return roots.sort((left, right) =>
    pathDepth(left.fromPath) - pathDepth(right.fromPath)
    || left.fromPath.localeCompare(right.fromPath));
}

/**
 * Pure state-only rebind of one reviewed spelling convergence. Every anchor in
 * the source subtree must project exactly to its translated path in the
 * committed remote index — the same byte-exact descendant projection the folder
 * move reducer requires from a receipt. Any mismatch rejects the whole rebind
 * (fail closed) instead of leaving half the subtree under the old spelling.
 *
 * No provider mutation is authorized and no remote node is added or removed:
 * the remote index already describes the new spelling.
 */
export function applyConvergedFolderAnchorSpellingV2(
  envelope: SyncStateEnvelopeV2,
  reviewed: Readonly<ConvergedFolderAnchorSpellingV2>,
  confirmedAt: number,
): FolderAnchorSpellingConvergenceResultV2 {
  const reject = (
    reason: Extract<
      FolderAnchorSpellingConvergenceResultV2,
      { status: "rejected" }
    >["reason"],
  ): FolderAnchorSpellingConvergenceResultV2 => ({ status: "rejected", reason });
  if (envelope.remoteIndex.complete !== true || !envelope.folderAnchors) {
    return reject("source-changed");
  }
  const current = envelope.folderAnchors.byAnchorId[reviewed.anchorId];
  const node = envelope.remoteIndex.itemsById[reviewed.remoteId];
  const pathById = projectRemoteIndexV2(envelope.remoteIndex);
  const rootPath = pathById.get(reviewed.remoteId);
  if (
    !current
    || current.remoteId !== reviewed.remoteId
    || current.lastPath !== reviewed.fromPath
    || !node
    || node.kind !== "folder"
    || rootPath === undefined
    || nfcPath(rootPath) !== nfcPath(reviewed.toPath)
  ) return reject("source-changed");

  const nextCommitSeq = envelope.meta.commitSeq + 1;
  const nextFolderAnchors: Record<string, FolderAnchorV2> = {
    ...envelope.folderAnchors.byAnchorId,
  };
  let convergedFolderAnchors = 0;
  for (const anchor of Object.values(nextFolderAnchors)) {
    if (!isAtOrBelow(anchor.lastPath, reviewed.fromPath)) continue;
    const translated = translateAnchoredPathV2(
      anchor.lastPath,
      reviewed.fromPath,
      rootPath,
    );
    const anchorNode = envelope.remoteIndex.itemsById[anchor.remoteId];
    if (
      pathById.get(anchor.remoteId) !== translated
      || !anchorNode
      || anchorNode.kind !== "folder"
    ) return reject("projection-changed");
    nextFolderAnchors[anchor.anchorId] = {
      ...anchor,
      lastPath: translated,
      parentRemoteId: anchorNode.parentId,
      ...(anchorNode.eTag !== undefined ? { remoteETag: anchorNode.eTag } : {}),
      confirmedGeneration: nextCommitSeq,
      confirmedAt,
    };
    convergedFolderAnchors++;
  }
  if (convergedFolderAnchors === 0) return reject("source-changed");

  const nextFileAnchors = { ...envelope.anchors.byAnchorId };
  let convergedFileAnchors = 0;
  for (const anchor of Object.values(nextFileAnchors)) {
    if (!isAnchoredDescendantV2(anchor.lastPath, reviewed.fromPath)) continue;
    const translated = translateAnchoredPathV2(
      anchor.lastPath,
      reviewed.fromPath,
      rootPath,
    );
    if (!anchor.remoteId || pathById.get(anchor.remoteId) !== translated) {
      return reject("projection-changed");
    }
    nextFileAnchors[anchor.anchorId] = {
      ...anchor,
      lastPath: translated,
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
