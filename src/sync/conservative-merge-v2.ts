import { sha256Hex } from "../crypto";
import { threeWayMerge } from "./merge-engine";

const MAX_MERGE_INPUT_BYTES = 2 * 1024 * 1024;

export interface MergeVersionV2 {
  bytes: ArrayBuffer;
  hash: string;
  size: number;
}

export interface ConservativeMergeInputV2 {
  ancestor: { bytes: ArrayBuffer; hash: string };
  local: MergeVersionV2;
  remote: MergeVersionV2 & { remoteId: string; eTag: string };
  expectedRemoteId: string;
  expectedRemoteETag: string;
  lifecycleCurrent: boolean;
  envelopeCommitCurrent: boolean;
  localVersionCurrent: boolean;
  remoteVersionCurrent: boolean;
  recoveryPending: boolean;
}

export type ConservativeMergeResultV2 =
  | {
      status: "ready";
      mergedText: string;
      mergedBytes: ArrayBuffer;
      mergedHash: string;
      mutations: [];
    }
  | {
      status: "manual";
      reason: "stale-version" | "recovery-pending" | "invalid-hash" | "invalid-utf8" | "mixed-line-endings" | "too-large" | "overlap";
      mutations: [];
    };

/**
 * Pure preflight for a conservative merge candidate. It never writes either
 * side; callers still need local-ready CAS, remote ID+eTag CAS and envelope
 * publication as one recoverable transaction.
 */
export async function evaluateConservativeMergeV2(
  input: ConservativeMergeInputV2,
): Promise<ConservativeMergeResultV2> {
  if (!input.lifecycleCurrent || !input.envelopeCommitCurrent
    || !input.localVersionCurrent || !input.remoteVersionCurrent
    || input.remote.remoteId !== input.expectedRemoteId
    || input.remote.eTag !== input.expectedRemoteETag) {
    return manual("stale-version");
  }
  if (input.recoveryPending) return manual("recovery-pending");
  if ([input.ancestor.bytes, input.local.bytes, input.remote.bytes]
    .some((bytes) => bytes.byteLength > MAX_MERGE_INPUT_BYTES)) return manual("too-large");
  if (input.local.bytes.byteLength !== input.local.size
    || input.remote.bytes.byteLength !== input.remote.size) return manual("invalid-hash");

  const [ancestorHash, localHash, remoteHash] = await Promise.all([
    sha256Hex(input.ancestor.bytes),
    sha256Hex(input.local.bytes),
    sha256Hex(input.remote.bytes),
  ]);
  if (ancestorHash !== input.ancestor.hash
    || localHash !== input.local.hash
    || remoteHash !== input.remote.hash) return manual("invalid-hash");

  const ancestor = strictUtf8(input.ancestor.bytes);
  const local = strictUtf8(input.local.bytes);
  const remote = strictUtf8(input.remote.bytes);
  if (ancestor === null || local === null || remote === null) return manual("invalid-utf8");

  const lineEnding = sharedLineEnding([ancestor, local, remote]);
  if (lineEnding === null) return manual("mixed-line-endings");

  const merged = threeWayMerge(ancestor, local, remote);
  if (merged.hasConflicts) return manual("overlap");
  const mergedText = lineEnding === "\n"
    ? merged.merged
    : merged.merged.replace(/\n/g, lineEnding);
  const encoded = new TextEncoder().encode(mergedText).buffer;
  if (encoded.byteLength > MAX_MERGE_INPUT_BYTES) return manual("too-large");
  return {
    status: "ready",
    mergedText,
    mergedBytes: encoded,
    mergedHash: await sha256Hex(encoded),
    mutations: [],
  };
}

function sharedLineEnding(contents: string[]): "\n" | "\r\n" | "\r" | null {
  const observed = new Set<"\n" | "\r\n" | "\r">();
  for (const content of contents) {
    let own: "\n" | "\r\n" | "\r" | null = null;
    for (let index = 0; index < content.length; index++) {
      if (content[index] === "\r") {
        const current = content[index + 1] === "\n" ? "\r\n" : "\r";
        if (own && own !== current) return null;
        own = current;
        if (current === "\r\n") index++;
      } else if (content[index] === "\n") {
        if (own && own !== "\n") return null;
        own = "\n";
      }
    }
    if (own) observed.add(own);
  }
  if (observed.size > 1) return null;
  return observed.values().next().value ?? "\n";
}

function strictUtf8(bytes: ArrayBuffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength !== bytes.byteLength) return null;
    const source = new Uint8Array(bytes);
    if (!encoded.every((value, index) => value === source[index])) return null;
    return text;
  } catch {
    return null;
  }
}

function manual(
  reason: Extract<ConservativeMergeResultV2, { status: "manual" }>["reason"],
): Extract<ConservativeMergeResultV2, { status: "manual" }> {
  return { status: "manual", reason, mutations: [] };
}
