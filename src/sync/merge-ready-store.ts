import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";

interface MergeReadyMetadataV1 {
  version: 1;
  operationId: string;
  hash: string;
  size: number;
  createdAt: number;
}

/**
 * One durable merged payload for the serial full-sync mutation lane.
 *
 * The mutation ledger owns authorization and recovery state. This store only
 * preserves the exact bytes needed to finish a remote-first merge after a
 * restart; an orphan without a matching ledger entry is safe to overwrite.
 */
export class MergeReadyStore {
  readonly directory: string;
  readonly metadataPath: string;
  readonly payloadPath: string;

  constructor(
    private readonly adapter: DataAdapter,
    tmpDir: string,
  ) {
    this.directory = `${tmpDir}/merge-ready`;
    this.metadataPath = `${this.directory}/metadata.json`;
    this.payloadPath = `${this.directory}/payload.bin`;
  }

  async prepare(
    operationId: string,
    bytes: ArrayBuffer,
    expected: { hash: string; size: number },
  ): Promise<void> {
    if (bytes.byteLength !== expected.size || await sha256Hex(bytes) !== expected.hash) {
      throw new Error("Merged payload does not match its target version");
    }
    await this.ensureDirectory();
    await this.removeIfExists(this.metadataPath);
    await this.removeIfExists(this.payloadPath);
    await this.adapter.writeBinary(this.payloadPath, bytes);
    const reread = await this.adapter.readBinary(this.payloadPath);
    if (reread.byteLength !== expected.size || await sha256Hex(reread) !== expected.hash) {
      throw new Error("Merged payload failed staged verification");
    }
    const metadata: MergeReadyMetadataV1 = {
      version: 1,
      operationId,
      hash: expected.hash,
      size: expected.size,
      createdAt: Date.now(),
    };
    await this.adapter.write(this.metadataPath, JSON.stringify(metadata));
    const committed = await this.readMetadata();
    if (!committed
      || committed.operationId !== operationId
      || committed.hash !== expected.hash
      || committed.size !== expected.size) {
      throw new Error("Merged payload metadata failed verification");
    }
  }

  async read(
    operationId: string,
    expected: { hash: string; size: number },
  ): Promise<ArrayBuffer | null> {
    const metadata = await this.readMetadata();
    if (!metadata
      || metadata.operationId !== operationId
      || metadata.hash !== expected.hash
      || metadata.size !== expected.size) return null;
    try {
      const bytes = await this.adapter.readBinary(this.payloadPath);
      if (bytes.byteLength !== expected.size || await sha256Hex(bytes) !== expected.hash) return null;
      return bytes;
    } catch {
      return null;
    }
  }

  async complete(operationId: string): Promise<void> {
    const metadata = await this.readMetadata();
    if (metadata && metadata.operationId !== operationId) return;
    await this.removeIfExists(this.metadataPath);
    await this.removeIfExists(this.payloadPath);
  }

  private async readMetadata(): Promise<MergeReadyMetadataV1 | null> {
    try {
      if (!await this.adapter.exists(this.metadataPath)) return null;
      const value = JSON.parse(await this.adapter.read(this.metadataPath)) as Partial<MergeReadyMetadataV1>;
      return value.version === 1
        && typeof value.operationId === "string"
        && typeof value.hash === "string"
        && typeof value.size === "number"
        && typeof value.createdAt === "number"
        ? value as MergeReadyMetadataV1
        : null;
    } catch {
      return null;
    }
  }

  private async ensureDirectory(): Promise<void> {
    const segments = this.directory.split("/");
    for (let index = 1; index <= segments.length; index++) {
      try { await this.adapter.mkdir(segments.slice(0, index).join("/")); } catch { /* exists */ }
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    try {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    } catch { /* cleanup is retried by the next prepare/complete */ }
  }
}
