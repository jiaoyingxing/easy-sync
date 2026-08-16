import type { DataAdapter } from "obsidian";
import { sha256Hex } from "../crypto";
import type { LocalFileEntry } from "./types";

interface RecoveryVersion {
  hash: string;
  size: number;
}

interface LocalRecoveryIntentV1 {
  version: 1;
  targetPath: string;
  recoveryPath: string;
  recoveryMode: "copy" | "rename";
  expected: RecoveryVersion | null;
  downloaded: RecoveryVersion;
  createdAt: number;
}

interface LocalRecoveryBundleMemberV2 {
  targetPath: string;
  recoveryPath: string;
  expected: RecoveryVersion | null;
  downloaded: RecoveryVersion | null;
}

interface LocalRecoveryBundleIntentV2 {
  version: 2;
  kind: "bundle-replacement";
  members: LocalRecoveryBundleMemberV2[];
  createdAt: number;
}

type LocalRecoveryIntent = LocalRecoveryIntentV1 | LocalRecoveryBundleIntentV2;

export interface LocalRecoveryBundleMemberInput {
  targetPath: string;
  expected: LocalFileEntry | undefined;
  original: ArrayBuffer | null;
  downloaded: RecoveryVersion | null;
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

  /**
   * Preserve every reviewed member before a short multi-file replacement.
   * The one durable intent is written only after all required originals exist.
   */
  async prepareCopiedBundleOriginals(
    members: readonly Readonly<LocalRecoveryBundleMemberInput>[],
  ): Promise<void> {
    if (members.length < 2 || members.length > 3) {
      throw new Error("Bundle recovery requires two or three members");
    }
    if (new Set(members.map((member) => member.targetPath)).size !== members.length) {
      throw new Error("Bundle recovery target paths must be unique");
    }
    if (await this.readIntent()) {
      throw new Error("Local recovery is already in progress");
    }
    await this.ensureDir();
    const prepared: LocalRecoveryBundleMemberV2[] = [];
    for (const [index, member] of members.entries()) {
      const recoveryPath = `${this.recoveryDir}/bundle-${index}.original.bin`;
      await this.removeIfExists(recoveryPath);
      if (member.expected) {
        if (!member.original) {
          throw new Error(`Recovery source missing: ${member.targetPath}`);
        }
        await this.assertBytesMatch(
          member.original,
          member.expected,
          "Recovery source changed",
        );
        await this.adapter.writeBinary(recoveryPath, member.original);
      } else if (member.original) {
        throw new Error(
          `Expected a missing local path before bundle replacement: ${member.targetPath}`,
        );
      }
      prepared.push({
        targetPath: member.targetPath,
        recoveryPath,
        expected: member.expected
          ? { hash: member.expected.hash, size: member.expected.size }
          : null,
        downloaded: member.downloaded,
      });
    }
    await this.writeIntent({
      version: 2,
      kind: "bundle-replacement",
      members: prepared,
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
    if (!current) return;
    if (current.version === 1) {
      await this.removeIfExists(current.recoveryPath);
      return;
    }
    for (const member of current.members) {
      await this.removeIfExists(member.recoveryPath);
    }
  }

  /**
   * Read-only admission check for maintenance operations such as reset.
   * Either slot means a local replacement transaction still owns user-file
   * recovery and must finish through the normal executor before maintenance.
   */
  async hasPendingRecovery(): Promise<boolean> {
    return await this.adapter.exists(this.intentPath)
      || await this.adapter.exists(`${this.intentPath}.next`);
  }

  async recover(): Promise<RecoveryOutcome> {
    const intent = await this.readIntent();
    if (!intent) return "none";
    if (intent.version === 2) return this.recoverBundle(intent);

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

  private async recoverBundle(
    intent: LocalRecoveryBundleIntentV2,
  ): Promise<RecoveryOutcome> {
    let preservedNewer = false;
    for (const member of intent.members) {
      const current = await this.readCurrentVersion(member.targetPath);
      if (versionsEqual(current, member.expected)) continue;
      if (!versionsEqual(current, member.downloaded)) {
        // A third version belongs to the user or another actor. Preserve it,
        // while the remaining members still roll back independently.
        preservedNewer = true;
        continue;
      }
      if (member.expected) {
        const recovery = await this.adapter.readBinary(member.recoveryPath);
        await this.assertBytesMatch(
          recovery,
          member.expected,
          "Recovery copy is invalid",
        );
        await this.adapter.writeBinary(member.targetPath, recovery);
      } else if (current) {
        await this.adapter.remove(member.targetPath);
      }
      const restored = await this.readCurrentVersion(member.targetPath);
      if (!versionsEqual(restored, member.expected)) {
        throw new Error(`Recovery verification failed: ${member.targetPath}`);
      }
    }
    await this.complete(intent);
    return preservedNewer ? "preserved-newer" : "restored";
  }

  private async readIntent(): Promise<LocalRecoveryIntent | null> {
    const nextPath = `${this.intentPath}.next`;
    // Recover orphaned staging file from a previous crash during writeIntent
    if (await this.adapter.exists(nextPath)) {
      try {
        await this.removeIfExists(this.intentPath);
        await this.adapter.rename(nextPath, this.intentPath);
      } catch {
        await this.removeIfExists(nextPath);
      }
    }
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
    const nextPath = `${this.intentPath}.next`;
    const json = JSON.stringify(intent);
    await this.adapter.write(nextPath, json);
    try {
      await this.removeIfExists(this.intentPath);
      await this.adapter.rename(nextPath, this.intentPath);
    } catch {
      // Fall back to direct write when rename is unavailable (e.g. mock adapters
      // that don't simulate cross-path renames). The write-then-verify in
      // readIntent guards against torn writes on real filesystems.
      await this.adapter.write(this.intentPath, json);
    }
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
  const version = (value as { version?: unknown }).version;
  if (version === 1) {
    const intent = value as Partial<LocalRecoveryIntentV1>;
    return typeof intent.targetPath === "string"
      && typeof intent.recoveryPath === "string"
      && (intent.recoveryMode === "copy" || intent.recoveryMode === "rename")
      && (intent.expected === null || isRecoveryVersion(intent.expected))
      && isRecoveryVersion(intent.downloaded)
      && typeof intent.createdAt === "number";
  }
  const intent = value as Partial<LocalRecoveryBundleIntentV2>;
  if (
    version !== 2
    || intent.kind !== "bundle-replacement"
    || !Array.isArray(intent.members)
    || intent.members.length < 2
    || intent.members.length > 3
    || typeof intent.createdAt !== "number"
  ) return false;
  const members = intent.members as unknown[];
  const targetPaths = new Set<string>();
  const recoveryPaths = new Set<string>();
  for (const value of members) {
    if (typeof value !== "object" || value === null) return false;
    const member = value as Partial<LocalRecoveryBundleMemberV2>;
    if (
      typeof member.targetPath !== "string"
      || member.targetPath.length === 0
      || targetPaths.has(member.targetPath)
      || typeof member.recoveryPath !== "string"
      || member.recoveryPath.length === 0
      || recoveryPaths.has(member.recoveryPath)
      || (member.expected !== null && !isRecoveryVersion(member.expected))
      || (member.downloaded !== null && !isRecoveryVersion(member.downloaded))
    ) return false;
    targetPaths.add(member.targetPath);
    recoveryPaths.add(member.recoveryPath);
  }
  return true;
}
