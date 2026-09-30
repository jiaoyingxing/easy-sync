/**
 * Session-scoped bytes fetched while building a community-plugin bundle
 * review snapshot. Keyed by pluginId → path → bytes + content identity.
 *
 * This is a pure display/staging cache: it never feeds `factsDigest`, never
 * authorizes a mutation, and is discarded when the executor or vault
 * changes. It lets the bundle sub-dialog ("查看差异") reuse content the
 * snapshot already downloaded instead of re-downloading it, and lets a
 * re-opened review re-render without re-fetching unchanged bytes.
 */
export class BundleReviewBytesCache {
  /** Global bytes-cache cap across all plugin bundles (LRU evicts whole plugin sets). */
  private static readonly MAX_TOTAL_BYTES = 16 * 1024 * 1024;
  /**
   * Per-member bytes bound, applied per cached file (each plugin bundle has
   * ≤3 members, so a plugin can hold up to 3 × 3 MiB = 9 MiB; the 16 MiB
   * global cap is the actual backstop).
   */
  private static readonly MAX_MEMBER_BYTES = 3 * 1024 * 1024;

  private byPlugin = new Map<string, Map<string, {
    hash: string;
    bytes: ArrayBuffer;
    mtime: number;
    driveId?: string;
    eTag?: string;
  }>>();
  private total = 0;

  get totalBytes(): number {
    return this.total;
  }

  set(
    pluginId: string,
    path: string,
    hash: string,
    bytes: ArrayBuffer,
    mtime: number,
    identity?: { driveId: string; eTag: string },
  ): void {
    if (bytes.byteLength > BundleReviewBytesCache.MAX_MEMBER_BYTES) {
      return; // never cache an oversized member
    }
    let byPath = this.byPlugin.get(pluginId);
    if (!byPath) {
      byPath = new Map();
      this.byPlugin.set(pluginId, byPath);
    }
    const previous = byPath.get(path);
    if (previous) this.total -= previous.bytes.byteLength;
    byPath.set(path, { hash, bytes, mtime, ...identity });
    this.total += bytes.byteLength;
    // LRU bump before the eviction sweep (1.4.3 review F1): writing to a
    // plugin set must move it to the MRU position first — otherwise a writer
    // that is currently the oldest key gets evicted by its own write (the
    // fresh bytes are dropped while unrelated newer sets survive).
    this.byPlugin.delete(pluginId);
    this.byPlugin.set(pluginId, byPath);
    // LRU over plugins: evict the least recently used plugin's whole set when
    // over the global cap. (Path-level LRU is unnecessary: ≤3 members each.)
    while (
      this.total
      > BundleReviewBytesCache.MAX_TOTAL_BYTES
      && this.byPlugin.size > 0
    ) {
      const oldestKey = this.byPlugin.keys().next().value as string;
      const removed = this.byPlugin.get(oldestKey);
      if (!removed) break;
      let removedBytes = 0;
      for (const cached of removed.values()) removedBytes += cached.bytes.byteLength;
      this.total -= removedBytes;
      this.byPlugin.delete(oldestKey);
    }
  }

  get(
    pluginId: string,
    path: string,
    expectedHash?: string,
    expectedIdentity?: { driveId?: string; eTag?: string },
  ): { bytes: ArrayBuffer; mtime: number; hash: string } | null {
    const byPath = this.byPlugin.get(pluginId);
    if (!byPath) return null;
    const cached = byPath.get(path);
    if (!cached) return null;
    if (expectedHash && cached.hash !== expectedHash) return null;
    if (
      expectedIdentity
      && ((
        expectedIdentity.driveId
        && cached.driveId
        && cached.driveId !== expectedIdentity.driveId
      ) || (
        expectedIdentity.eTag
        && cached.eTag
        && cached.eTag !== expectedIdentity.eTag
      ))
    ) return null;
    // LRU bump: move the plugin set to MRU position.
    this.byPlugin.delete(pluginId);
    this.byPlugin.set(pluginId, byPath);
    return { bytes: cached.bytes, mtime: cached.mtime, hash: cached.hash };
  }
}
