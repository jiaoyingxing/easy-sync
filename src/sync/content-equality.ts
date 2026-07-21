import { sha256Hex } from "../crypto";
import type { BaseFileEntry } from "./types";

export type ContentEqualityProof =
  | "remoteSha256"
  | "baseETag"
  | "downloadedSha256"
  | "sizeMismatch"
  | "insufficientEvidence";

export interface ContentEqualityResult {
  status: "equal" | "different" | "unknown";
  proof: ContentEqualityProof;
}

export interface ContentEqualityInput {
  local: { hash: string; size: number };
  remote: { sha256Hash?: string; size: number; eTag: string };
  base?: Pick<BaseFileEntry, "hash" | "size" | "eTag">;
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

  if (input.base?.eTag === input.remote.eTag) {
    return input.local.hash === input.base.hash && input.local.size === input.base.size
      ? { status: "equal", proof: "baseETag" }
      : { status: "different", proof: "baseETag" };
  }

  if (input.downloadedHash) {
    return input.local.hash === input.downloadedHash.toLowerCase()
      ? { status: "equal", proof: "downloadedSha256" }
      : { status: "different", proof: "downloadedSha256" };
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
