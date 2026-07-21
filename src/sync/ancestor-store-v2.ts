import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";

const MAX_ANCESTOR_BYTES = 2 * 1024 * 1024;

interface ListResult {
  files: string[];
  folders: string[];
}

type AncestorAdapter = DataAdapter & {
  list(path: string): Promise<ListResult>;
};

export interface AncestorStoreV2Paths {
  directory: string;
  manifest: string;
  manifestNext: string;
}

export interface AncestorManifestV2 {
  schemaVersion: 2;
  textHashes: string[];
}

/** SHA-256 content-addressed, strict UTF-8 ancestor storage. */
export class AncestorStoreV2 {
  constructor(
    private readonly adapter: DataAdapter,
    readonly paths: AncestorStoreV2Paths,
  ) {}

  async putText(content: string | ArrayBuffer): Promise<string | null> {
    const bytes = toStrictUtf8Bytes(content);
    if (!bytes || bytes.byteLength > MAX_ANCESTOR_BYTES) return null;
    const hash = await sha256Hex(bytes);
    const target = this.pathFor(hash);
    if (await this.adapter.exists(target)) {
      if (!await this.verifyObject(hash)) throw new Error(`Ancestor object is corrupt: ${hash}`);
      return hash;
    }

    await this.ensureDirectory();
    const next = `${this.paths.directory}/.${hash}.next`;
    await this.removeIfExists(next);
    await this.adapter.write(next, new TextDecoder().decode(bytes));
    if (!await this.verifyPath(next, hash)) {
      throw new Error(`Ancestor staged object failed verification: ${hash}`);
    }
    try {
      await this.adapter.rename(next, target);
    } catch (error) {
      // A concurrent content-addressed writer is harmless only if the final
      // object is present and valid.
      if (!await this.adapter.exists(target) || !await this.verifyObject(hash)) throw error;
      await this.removeIfExists(next);
    }
    if (!await this.verifyObject(hash)) throw new Error(`Ancestor object failed publication: ${hash}`);
    await this.publishManifest(await this.listHashes());
    return hash;
  }

  async getText(hash: string): Promise<string | null> {
    if (!isSha256(hash) || !await this.verifyObject(hash)) return null;
    return this.adapter.read(this.pathFor(hash));
  }

  async has(hash: string): Promise<boolean> {
    return isSha256(hash) && this.verifyObject(hash);
  }

  /**
   * Delete only objects that are neither reachable nor protected by recovery
   * or the caller's two-commit grace window.
   */
  async sweep(
    reachableHashes: ReadonlySet<string>,
    recoveryProtectedHashes: ReadonlySet<string>,
    graceProtectedHashes: ReadonlySet<string>,
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const hash of await this.listHashes()) {
      if (reachableHashes.has(hash)
        || recoveryProtectedHashes.has(hash)
        || graceProtectedHashes.has(hash)) continue;
      await this.adapter.remove(this.pathFor(hash));
      removed.push(hash);
    }
    await this.publishManifest(await this.listHashes());
    return removed;
  }

  private pathFor(hash: string): string {
    return `${this.paths.directory}/${hash}.txt`;
  }

  private async verifyObject(hash: string): Promise<boolean> {
    const path = this.pathFor(hash);
    if (!await this.adapter.exists(path)) return false;
    return this.verifyPath(path, hash);
  }

  private async verifyPath(path: string, expectedHash: string): Promise<boolean> {
    try {
      const text = await this.adapter.read(path);
      const bytes = new TextEncoder().encode(text).buffer;
      return await sha256Hex(bytes) === expectedHash;
    } catch {
      return false;
    }
  }

  private async listHashes(): Promise<string[]> {
    if (!await this.adapter.exists(this.paths.directory)) return [];
    const list = (this.adapter as AncestorAdapter).list;
    if (typeof list !== "function") throw new Error("Ancestor adapter cannot list objects");
    const result = await list.call(this.adapter, this.paths.directory);
    return result.files
      .map((path) => path.slice(path.lastIndexOf("/") + 1))
      .filter((name) => /^[a-f0-9]{64}\.txt$/i.test(name))
      .map((name) => name.slice(0, -4).toLowerCase())
      .sort();
  }

  private async publishManifest(hashes: string[]): Promise<void> {
    const manifest: AncestorManifestV2 = {
      schemaVersion: 2,
      textHashes: [...new Set(hashes)].sort(),
    };
    await this.removeIfExists(this.paths.manifestNext);
    await this.adapter.write(this.paths.manifestNext, JSON.stringify(manifest));
    const reread = JSON.parse(await this.adapter.read(this.paths.manifestNext)) as AncestorManifestV2;
    if (reread.schemaVersion !== 2 || JSON.stringify(reread.textHashes) !== JSON.stringify(manifest.textHashes)) {
      throw new Error("Ancestor manifest failed staged verification");
    }
    await this.removeIfExists(this.paths.manifest);
    await this.adapter.rename(this.paths.manifestNext, this.paths.manifest);
  }

  private async ensureDirectory(): Promise<void> {
    const segments = this.paths.directory.split("/");
    for (let i = 1; i <= segments.length; i++) {
      try { await this.adapter.mkdir(segments.slice(0, i).join("/")); } catch { /* exists */ }
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

function toStrictUtf8Bytes(content: string | ArrayBuffer): ArrayBuffer | null {
  if (typeof content === "string") return new TextEncoder().encode(content).buffer;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const encoded = new TextEncoder().encode(text).buffer;
    // Reject non-canonical byte sequences instead of silently normalizing them.
    if (!sameBytes(content, encoded)) return null;
    return encoded;
  } catch {
    return null;
  }
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}
