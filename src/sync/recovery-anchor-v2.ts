import type {
  RemoteIndexProjectionV2,
  RemoteNodeV2,
} from "./remote-index-v2";
import {
  advanceRemoteIdentityLineageV2,
  type SyncAnchorV2,
} from "./state-envelope-v2";

/** Pure anchor primitives shared by the two capability-free recovery builders. */
export function applyVerifiedRemoteHashes(
  projection: RemoteIndexProjectionV2,
  hashes: Readonly<Record<string, string>>,
): boolean {
  for (const [id, rawHash] of Object.entries(hashes)) {
    const node = projection.index.itemsById[id];
    const hash = rawHash.toLowerCase();
    if (!node || node.kind !== "file" || !isSha256(hash)) return false;
    if (node.contentHash && node.contentHash !== hash) return false;
    node.contentHash = hash;
  }
  return true;
}

export function refreshedFileAnchor(
  prior: SyncAnchorV2,
  remote: RemoteNodeV2,
  path: string,
  contentHash: string,
  size: number,
  now: number,
): SyncAnchorV2 {
  return {
    ...structuredClone(prior),
    remoteId: remote.id,
    lastPath: path,
    contentHash,
    size,
    remoteETag: remote.eTag,
    remoteCTag: remote.cTag,
    remoteIdentityLineage: advanceRemoteIdentityLineageV2(prior, {
      remoteId: remote.id,
      path,
      contentHash,
      size,
      remoteETag: remote.eTag,
      confirmedAt: now,
      confirmedBy: "equal-read",
    }),
    confirmedAt: now,
    confirmedBy: "equal-read",
  };
}

export function exactNodeEquality(
  remote: RemoteNodeV2,
  hash: string,
  size: number,
): boolean {
  return remote.kind === "file"
    && remote.contentHash === hash.toLowerCase()
    && remote.size === size;
}

export function identityPath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase();
}

export function uniqueAnchorId<T>(
  preferred: string,
  record: Readonly<Record<string, T>>,
): string {
  if (!(preferred in record)) return preferred;
  let suffix = 2;
  while (`${preferred}:${suffix}` in record) suffix++;
  return `${preferred}:${suffix}`;
}

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left.localeCompare(right)),
  );
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
