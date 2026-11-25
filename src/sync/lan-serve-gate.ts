/**
 * Sender-side LAN serve gate (S5a, experimental).
 *
 * The sender must prove that the local file it is about to serve is exactly the
 * cloud version the receiver asked for. The six checks below are the single
 * implementation shared by the automatic connection manager and the dev
 * diagnostic modal; either caller may not relax them.
 *
 * Order (all must hold, first failure wins):
 *   1. sync state/scanner ready;
 *   2. a V2 base receipt exists for the path;
 *   3. `base.eTag === request.eTag`;
 *   4. `base.size === request.size`;
 *   5. the path is inside the current sync scope;
 *   6. the current local file hash equals `base.hash`;
 *   7. the freshly read cloud metadata eTag still equals `request.eTag`.
 *
 * Only then are bytes read and re-hashed, and the response carries
 * `sha256 = base.hash`. The receiver independently verifies the bytes against
 * that attestation; the existing post-download eTag re-read confirms the cloud
 * version. This module performs no I/O by itself and knows no provider.
 */
import type { LocalFileInspection } from "./local-scanner";
import type { BaseFileEntry } from "./types";

/** One receiver request: authorized path plus its cloud version and size. */
export interface LanServeRequest {
  path: string;
  eTag: string;
  size: number;
}

/** Bytes plus the sender's V2 base hash attestation. */
export interface LanServeResult {
  bytes: ArrayBuffer;
  sha256: string;
}

/** Either a served payload or a stable, non-secret refusal reason. */
export type LanServeOutcome = LanServeResult | { error: string };

/** Provider-neutral seams the gate needs; no Vue/Graph/WebRTC object is held. */
export interface LanServeGateDeps {
  /** True when sync state and the local scanner are ready to answer. */
  isReady(): boolean;
  /** Current V2 base receipt for a vault-relative path. */
  getBaseEntry(path: string): BaseFileEntry | undefined;
  /** Current sync-scope predicate (exclusions, plugin internals apply). */
  shouldSyncPath(path: string): boolean;
  /** Local file inspection used for the pre-read hash check. */
  inspectFile(path: string): Promise<LocalFileInspection>;
  /** Fresh cloud metadata eTag, or null when the provider has no version. */
  readRemoteETag(path: string): Promise<string | null>;
  /** Read the exact local bytes that will be served. */
  readLocalBytes(path: string): Promise<ArrayBuffer>;
  /** Hash of exact bytes; injectable so tests need no WebCrypto fidelity. */
  hashBytes(bytes: ArrayBuffer): Promise<string>;
}

/**
 * Run the six checks and, when they all pass, read and attest the bytes.
 * Any mismatch returns `{ error }`; nothing is retried or repaired here.
 */
export async function resolveLanServeFile(
  deps: LanServeGateDeps,
  request: LanServeRequest,
): Promise<LanServeOutcome> {
  if (!deps.isReady()) {
    return { error: "sync state is not ready" };
  }
  const base = deps.getBaseEntry(request.path);
  if (base === undefined) {
    return { error: "file has no synced base entry" };
  }
  if (base.eTag !== request.eTag) {
    return { error: "cloud version does not match the base receipt" };
  }
  if (base.size !== request.size) {
    return { error: "size does not match the base receipt" };
  }
  if (!deps.shouldSyncPath(request.path)) {
    return { error: "path is outside the sync scope" };
  }
  const inspected = await deps.inspectFile(request.path);
  if (inspected.status !== "present" || inspected.entry === undefined) {
    return { error: "local file is not available" };
  }
  if (inspected.entry.hash !== base.hash) {
    return { error: "local file changed since the last sync" };
  }
  const remoteETag = await deps.readRemoteETag(request.path);
  if (remoteETag === null || remoteETag !== request.eTag) {
    return { error: "cloud version changed" };
  }
  const bytes = await deps.readLocalBytes(request.path);
  if (await deps.hashBytes(bytes) !== base.hash) {
    return { error: "local file changed while it was read" };
  }
  return { bytes, sha256: base.hash };
}
