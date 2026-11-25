/**
 * Provider-neutral LAN content-source seam (S2a, experimental).
 *
 * The cloud stays the sole authority. The sender serves only a file whose V2
 * base entry binds the local sha256 to the cloud eTag the receiver asked for;
 * the receiver verifies the downloaded sha256 against that attested hash and
 * the existing post-download eTag re-read confirms the cloud version. No cloud
 * sha256/sidecar is required; the V2 base is the upload/sync receipt.
 */
import type { DataAdapter } from "obsidian";
import type { LanRouteType } from "./lan-diagnostics";

export interface LanContentHint {
  /** Vault-relative path the receiver is downloading. */
  readonly path: string;
  /** Cloud version token from the receiver's authorized plan entry. */
  readonly eTag: string;
  /** Exact byte size from the plan entry. */
  readonly size: number;
  /** Optional cloud sha256 when the provider supplies one. */
  readonly expectedSha256?: string;
}

export interface LanContentResult {
  /** Downloaded bytes. */
  readonly bytes: ArrayBuffer;
  /** Sender-attested sha256 (its V2 base hash for this path/eTag). */
  readonly sha256: string;
}

export interface LanContentSource {
  /** Return the whole payload plus the sender's attested sha256. */
  downloadFile(
    hint: LanContentHint,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<LanContentResult>;

  /** Write to the caller's temp path; return size and the attested sha256. */
  downloadFileToPath(
    hint: LanContentHint,
    localPath: string,
    adapter: DataAdapter,
    onProgress?: (downloaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<{ size: number; hash: string }>;

  /** Selected ICE candidate type for diagnostics; never an address. */
  getRouteType?(): Promise<LanRouteType>;
}

/**
 * S5a: automatic connection provider (desktop watcher / mobile acquirer).
 *
 * The client holds only this narrow seam: when the user switch is on and a file
 * reaches the threshold, the download entry asks for a live source once and
 * then reuses it for every later file. Returning `null` means "no source right
 * now" and the caller keeps the unchanged cloud path.
 */
export interface LanSourceProvider {
  /**
   * Return a live source, acquiring one only when no reusable channel exists.
   * Must resolve within its own bounded window and must never throw.
   */
  acquire(hint: LanContentHint): Promise<LanContentSource | null>;
  /**
   * Begin acquiring without waiting. The sync entry calls this when a round
   * starts so the handshake overlaps scanning and planning; by the time the
   * first download asks, the channel is often already open.
   */
  prewarm?(): void;
  /** Stop all background polling and drop any cached source immediately. */
  stop(): void;
}
