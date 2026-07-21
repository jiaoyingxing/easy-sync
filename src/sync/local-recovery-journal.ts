import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";
import type { LocalFileEntry } from "./types";

interface RecoveryVersion {
  hash: string;
  size: number;
}

interface LocalRecoveryIntent {
  version: 1;
  targetPath: string;
  recoveryPath: string;
  recoveryMode: "copy" | "rename";
  expected: RecoveryVersion | null;
  downloaded: RecoveryVersion;
  createdAt: number;
}

export type RecoveryOutcome = "none" | "restored" | "preserved-newer";

/**
 * A state-neutral, single-writer journal for local download replacement.
 * It deliberately contains no sync baseline, remote cursor, or manifest data.
 */
export class LocalRecoveryJournal {
  readonly recoveryDir: string;
  readonly intentPath: string;
  readonly copiedOriginalPath: string;

  constructor(
    private adapter: DataAdapter,
    tmpDir: string,
  ) {
    this.recoveryDir = `${tmpDir}/recovery`;
    this.intentPath = `${this.recoveryDir}/intent.json`;
    this.copiedOriginalPath = `${this.recoveryDir}/original.bin`;
  }

  async prepareCopiedOriginal(
    targetPath: string,
    expected: LocalFileEntry | undefined,
    original: ArrayBuffer | null,
    downloaded: RecoveryVersion,
  ): Promise<void> {
    await this.ensureDir();
    await this.removeIfExists(this.copiedOriginalPath);
    if (expected) {
      if (!original) throw new Error(`Recovery source missing: ${targetPath}`);
      await this.assertBytesMatch(original, expected, "Recovery source changed");
      await this.adapter.writeBinary(this.copiedOriginalPath, original);
    } else if (original) {
      throw new Error(`Expected a missing local path before download: ${targetPath}`);
    }
    await this.writeIntent({
      version: 1,
      targetPath,
      recoveryPath: this.copiedOriginalPath,
      recoveryMode: "copy",
      expected: expected ? { hash: expected.hash, size: expected.size } : null,
      downloaded,
      createdAt: Date.now(),
    });
  }

  async prepareRenamedOriginal(
    targetPath: string,
    expected: LocalFileEntry | undefined,
    recoveryPath: string,
    downloaded: RecoveryVersion,
  ): Promise<void> {
    await this.ensureDir();
    await this.writeIntent({
      version: 1,
      targetPath,
      recoveryPath,
      recoveryMode: "rename",
      expected: expected ? { hash: expected.hash, size: expected.size } : null,
      downloaded,
      createdAt: Date.now(),
    });
  }

  async complete(intent?: LocalRecoveryIntent): Promise<void> {
    const current = intent ?? await this.readIntent();
    // The intent is authoritative. Clear it first and fail loudly if that is
    // impossible. An orphaned recovery copy is harmless; an intent whose
    // recovery copy was already deleted is not recoverable.
    if (await this.adapter.exists(this.intentPath)) {
      await this.adapter.remove(this.intentPath);
    }
    if (current) await this.removeIfExists(current.recoveryPath);
  }

  async recover(): Promise<RecoveryOutcome> {
    const intent = await this.readIntent();
    if (!intent) return "none";

    const current = await this.readCurrentVersion(intent.targetPath);
    const currentIsExpected = versionsEqual(current, intent.expected);
    const currentIsDownloaded = versionsEqual(current, intent.downloaded);

    if (currentIsExpected) {
      await this.complete(intent);
      return "restored";
    }

    // A third version can only be a newer user/external write. Never replace it
    // with either the old recovery copy or the interrupted download.
    if (current && !currentIsDownloaded) {
      await this.complete(intent);
      return "preserved-newer";
    }

    if (intent.expected) {
      const recovery = await this.adapter.readBinary(intent.recoveryPath);
      await this.assertBytesMatch(recovery, intent.expected, "Recovery copy is invalid");
      await this.adapter.writeBinary(intent.targetPath, recovery);
      const restored = await this.readCurrentVersion(intent.targetPath);
      if (!versionsEqual(restored, intent.expected)) {
        throw new Error(`Recovery verification failed: ${intent.targetPath}`);
      }
    } else if (currentIsDownloaded) {
      await this.adapter.remove(intent.targetPath);
    }

    await this.complete(intent);
    return "restored";
  }

  private async readIntent(): Promise<LocalRecoveryIntent | null> {
    if (!await this.adapter.exists(this.intentPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.adapter.read(this.intentPath));
    } catch {
      throw new Error("Local recovery journal is unreadable");
    }
    if (!isRecoveryIntent(parsed)) {
      throw new Error("Local recovery journal has an unsupported format");
    }
    return parsed;
  }

  private async writeIntent(intent: LocalRecoveryIntent): Promise<void> {
    await this.adapter.write(this.intentPath, JSON.stringify(intent));
  }

  private async readCurrentVersion(path: string): Promise<RecoveryVersion | null> {
    const stat = await this.adapter.stat(path);
    if (!stat) return null;
    const bytes = await this.adapter.readBinary(path);
    return { hash: await sha256Hex(bytes), size: bytes.byteLength };
  }

  private async assertBytesMatch(
    bytes: ArrayBuffer,
    expected: RecoveryVersion,
    label: string,
  ): Promise<void> {
    if (bytes.byteLength !== expected.size || await sha256Hex(bytes) !== expected.hash) {
      throw new Error(`${label}: hash or size mismatch`);
    }
  }

  private async ensureDir(): Promise<void> {
    const segments = this.recoveryDir.split("/");
    for (let i = 1; i <= segments.length; i++) {
      try { await this.adapter.mkdir(segments.slice(0, i).join("/")); } catch { /* already exists */ }
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    try {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    } catch { /* cleanup is retried by the next recovery pass */ }
  }
}

function versionsEqual(a: RecoveryVersion | null, b: RecoveryVersion | null): boolean {
  return a === null ? b === null : b !== null && a.hash === b.hash && a.size === b.size;
}

function isRecoveryVersion(value: unknown): value is RecoveryVersion {
  return typeof value === "object"
    && value !== null
    && typeof (value as RecoveryVersion).hash === "string"
    && typeof (value as RecoveryVersion).size === "number";
}

function isRecoveryIntent(value: unknown): value is LocalRecoveryIntent {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as Partial<LocalRecoveryIntent>;
  return intent.version === 1
    && typeof intent.targetPath === "string"
    && typeof intent.recoveryPath === "string"
    && (intent.recoveryMode === "copy" || intent.recoveryMode === "rename")
    && (intent.expected === null || isRecoveryVersion(intent.expected))
    && isRecoveryVersion(intent.downloaded)
    && typeof intent.createdAt === "number";
}
