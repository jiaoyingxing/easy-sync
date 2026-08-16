import { sha256Hex } from "../crypto";
import type {
  BaseFileEntry,
  ContentComparisonReceiptV1,
  LocalFileEntry,
  RemoteFileEntry,
} from "./types";

export type ContentEqualityProof =
  | "remoteSha256"
  | "verifiedRemoteReceipt"
  | "baseETag"
  | "downloadedSha256"
  | "quickXorMismatch"
  | "sizeMismatch"
  | "insufficientEvidence";

export interface ContentEqualityResult {
  status: "equal" | "different" | "unknown";
  proof: ContentEqualityProof;
}

export interface ContentEqualityInput {
  local: { hash: string; size: number; quickXorHash?: string };
  remote: {
    sha256Hash?: string;
    quickXorHash?: string;
    size: number;
    eTag: string;
  };
  base?: Pick<BaseFileEntry, "hash" | "size" | "eTag">;
  verifiedRemoteHash?: string;
  downloadedHash?: string;
}

/**
 * Resolve byte equality from the cheapest available hard evidence.
 * Size is only a rejection signal; it is never accepted as proof of equality.
 */
export function resolveContentEquality(
  input: ContentEqualityInput,
): ContentEqualityResult {
  if (input.local.size !== input.remote.size) {
    return { status: "different", proof: "sizeMismatch" };
  }

  if (input.remote.sha256Hash) {
    return input.local.hash === input.remote.sha256Hash.toLowerCase()
      ? { status: "equal", proof: "remoteSha256" }
      : { status: "different", proof: "remoteSha256" };
  }

  if (input.verifiedRemoteHash) {
    return input.local.hash === input.verifiedRemoteHash.toLowerCase()
      ? { status: "equal", proof: "verifiedRemoteReceipt" }
      : { status: "different", proof: "verifiedRemoteReceipt" };
  }

  if (input.downloadedHash) {
    return input.local.hash === input.downloadedHash.toLowerCase()
      ? { status: "equal", proof: "downloadedSha256" }
      : { status: "different", proof: "downloadedSha256" };
  }

  if (
    input.local.quickXorHash
    && input.remote.quickXorHash
    && input.local.quickXorHash !== input.remote.quickXorHash
  ) {
    return { status: "different", proof: "quickXorMismatch" };
  }

  if (input.base?.eTag === input.remote.eTag) {
    return input.local.hash === input.base.hash && input.local.size === input.base.size
      ? { status: "equal", proof: "baseETag" }
      : { status: "different", proof: "baseETag" };
  }

  return { status: "unknown", proof: "insufficientEvidence" };
}

export interface ContentBufferComparison {
  status: "equal" | "different";
  localHash: string;
  remoteHash: string;
  decodedTextEqual: boolean;
}

/** Compare raw bytes first; decoded text is explanation-only evidence. */
export async function compareContentBuffers(
  local: ArrayBuffer,
  remote: ArrayBuffer,
): Promise<ContentBufferComparison> {
  const [localHash, remoteHash] = await Promise.all([
    sha256Hex(local),
    sha256Hex(remote),
  ]);
  return {
    status: local.byteLength === remote.byteLength && localHash === remoteHash
      ? "equal"
      : "different",
    localHash,
    remoteHash,
    decodedTextEqual: new TextDecoder().decode(local) === new TextDecoder().decode(remote),
  };
}

/** Bind a completed byte-difference result to the exact compared versions. */
export function createContentDifferenceReceipt(
  local: Pick<LocalFileEntry, "hash" | "size">,
  remote: Pick<RemoteFileEntry, "driveId" | "eTag" | "size">,
  remoteHash: string,
): ContentComparisonReceiptV1 {
  return {
    version: 1,
    result: "different",
    localHash: local.hash,
    localSize: local.size,
    remoteDriveId: remote.driveId,
    remoteETag: remote.eTag,
    remoteSize: remote.size,
    remoteHash: remoteHash.toLowerCase(),
  };
}

/** Only an exact version match may suppress another download comparison. */
export function contentDifferenceReceiptMatches(
  receipt: ContentComparisonReceiptV1 | undefined,
  local: Pick<LocalFileEntry, "hash" | "size">,
  remote: Pick<RemoteFileEntry, "driveId" | "eTag" | "size">,
): boolean {
  return receipt?.version === 1
    && receipt.result === "different"
    && receipt.localHash === local.hash
    && receipt.localSize === local.size
    && receipt.remoteDriveId === remote.driveId
    && receipt.remoteETag === remote.eTag
    && receipt.remoteSize === remote.size
    && /^[0-9a-f]{64}$/i.test(receipt.remoteHash);
}
