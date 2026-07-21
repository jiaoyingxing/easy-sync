import type { DataAdapter } from "obsidian";
import type { DriveItem } from "../onedrive/types";
import { isRecord } from "../obsidian-compat";
import { buildRemoteIndexV2 } from "./remote-index-v2";
import {
  isSyncScope,
  sameSyncScope,
  type BaseFileEntry,
  type LocalFileEntry,
  type SyncScope,
} from "./types";
import {
  StateEnvelopeV2Store,
  type StateEnvelopeV2Paths,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";

export interface StateV2MigrationPaths extends StateEnvelopeV2Paths {
  manifest: string;
  manifestNext: string;
  v1Backup: string;
}

export interface CloudBootstrapAnchorHintV2 {
  remoteId?: string;
  lastPath: string;
  contentHash: string;
  size: number;
  remoteETag?: string;
}

export interface StateV2MigrationInput {
  scope: SyncScope;
  lifecycleEpoch: number;
  localScanComplete: boolean;
  remoteScanComplete: boolean;
  localEntries: LocalFileEntry[];
  remoteItems: DriveItem[];
  v1Base: BaseFileEntry[];
  v1Snapshot: unknown;
  cloudHints?: CloudBootstrapAnchorHintV2[];
  now?: number;
}

export interface StateV2MigrationPending {
  sourcePath: string;
  reason: "identity-not-unique-or-unverified" | "cloud-hint-not-verified";
}

export interface StateV2Manifest {
  schemaVersion: 2;
  activeState: "state-v2.json";
  stateCommitSeq: number;
  lifecycleEpoch: number;
  scope: SyncScope;
  migratedAt: number;
  legacyAutoSyncAllowed: false;
}

export interface StateV2MigrationResult {
  status: "committed" | "already-committed" | "aborted";
  reason?: "scan-incomplete" | "remote-identity-incomplete" | "state-save-failure";
  pending: StateV2MigrationPending[];
  mutations: [];
  envelope: SyncStateEnvelopeV2 | null;
  manifest: StateV2Manifest | null;
  v1BackupRetained: true;
}

/**
 * Read-only V1→V2 migration. It consumes already completed local/remote scans,
 * never calls a file or Graph mutation API, and cuts the V2 manifest only after
 * the envelope is committed and readable.
 */
export async function migrateV1ToV2(
  adapter: DataAdapter,
  paths: StateV2MigrationPaths,
  input: StateV2MigrationInput,
): Promise<StateV2MigrationResult> {
  const baseResult = { pending: [] as StateV2MigrationPending[], mutations: [] as [], v1BackupRetained: true as const };
  if (!input.localScanComplete || !input.remoteScanComplete) {
    return { ...baseResult, status: "aborted", reason: "scan-incomplete", envelope: null, manifest: null };
  }

  const existingManifest = await readStateV2Manifest(adapter, paths.manifest);
  if (existingManifest) {
    if (!sameSyncScope(existingManifest.scope, input.scope)) {
      throw new Error("V2 manifest belongs to another account or vault");
    }
    const envelopeStore = new StateEnvelopeV2Store(adapter, paths);
    const committed = await envelopeStore.load(input.scope);
    if (!committed || committed.meta.commitSeq !== existingManifest.stateCommitSeq) {
      throw new Error("V2 manifest does not have a matching committed envelope");
    }
    return { ...baseResult, status: "already-committed", envelope: committed, manifest: existingManifest };
  }

  let projection: ReturnType<typeof buildRemoteIndexV2>;
  try {
    projection = buildRemoteIndexV2(input.remoteItems, input.scope.filesRootId, null, 1);
  } catch {
    return { ...baseResult, status: "aborted", reason: "remote-identity-incomplete", envelope: null, manifest: null };
  }

  const now = input.now ?? Date.now();
  const anchors: Record<string, SyncAnchorV2> = {};
  for (const base of input.v1Base) {
    const anchor = migrateBaseAnchor(base, input.localEntries, projection.pathById, projection.index.itemsById, now);
    if (anchor) anchors[anchor.anchorId] = anchor;
    else baseResult.pending.push({ sourcePath: base.path, reason: "identity-not-unique-or-unverified" });
  }
  for (const hint of input.cloudHints ?? []) {
    const anchor = migrateCloudHint(hint, input.localEntries, projection.pathById, projection.index.itemsById, now);
    if (anchor && !Object.values(anchors).some((entry) => entry.remoteId === anchor.remoteId)) {
      anchors[anchor.anchorId] = anchor;
    } else if (!anchor) {
      baseResult.pending.push({ sourcePath: hint.lastPath, reason: "cloud-hint-not-verified" });
    }
  }

  const candidate: SyncStateEnvelopeV2 = {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: input.lifecycleEpoch + 1,
      commitSeq: 1,
      committedAt: now,
    },
    scope: input.scope,
    remoteIndex: projection.index,
    anchors: { schemaVersion: 2, byAnchorId: anchors },
  };

  await writeV1BackupOnce(adapter, paths.v1Backup, input.v1Snapshot, now);
  const envelopeStore = new StateEnvelopeV2Store(adapter, paths);
  let committed = await envelopeStore.load(input.scope);
  try {
    if (!committed) {
      await envelopeStore.publish(candidate);
      committed = await envelopeStore.load(input.scope);
    }
    if (!committed) throw new Error("V2 envelope was not published");
  } catch {
    return { ...baseResult, status: "aborted", reason: "state-save-failure", envelope: null, manifest: null };
  }

  const manifest: StateV2Manifest = {
    schemaVersion: 2,
    activeState: "state-v2.json",
    stateCommitSeq: committed.meta.commitSeq,
    lifecycleEpoch: committed.meta.lifecycleEpoch,
    scope: committed.scope,
    migratedAt: now,
    legacyAutoSyncAllowed: false,
  };
  try {
    await publishManifest(adapter, paths, manifest);
  } catch {
    return { ...baseResult, status: "aborted", reason: "state-save-failure", envelope: null, manifest: null };
  }
  return { ...baseResult, status: "committed", envelope: committed, manifest };
}

export async function readStateV2Manifest(
  adapter: DataAdapter,
  path: string,
): Promise<StateV2Manifest | null> {
  const exists = (adapter as Partial<DataAdapter>).exists;
  if (typeof exists === "function" && !await exists.call(adapter, path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(await adapter.read(path));
  } catch (error) {
    // Some narrow test/compat adapters omit exists(); a failed read is the only
    // missing-file signal available to them. Real Obsidian adapters take the
    // strict exists→read path above, where corrupt content still fails closed.
    if (typeof exists !== "function") return null;
    throw new Error("V2 state manifest is unreadable");
  }
  if (!isManifest(value)) throw new Error("V2 state manifest has an unsupported format");
  return value;
}

export function v1BackupCleanupAllowed(input: {
  desktopHealthy: boolean;
  mobileHealthy: boolean;
  cloudBootstrapV2Published: boolean;
  recoveryJournalsEmpty: boolean;
}): boolean {
  return input.desktopHealthy
    && input.mobileHealthy
    && input.cloudBootstrapV2Published
    && input.recoveryJournalsEmpty;
}

async function publishManifest(
  adapter: DataAdapter,
  paths: Pick<StateV2MigrationPaths, "manifest" | "manifestNext">,
  manifest: StateV2Manifest,
): Promise<void> {
  await removeIfExists(adapter, paths.manifestNext);
  await adapter.write(paths.manifestNext, JSON.stringify(manifest));
  const staged = await readStateV2Manifest(adapter, paths.manifestNext);
  if (!staged || JSON.stringify(staged) !== JSON.stringify(manifest)) {
    throw new Error("V2 manifest failed staged read-back verification");
  }
  if (await adapter.exists(paths.manifest)) {
    const current = await readStateV2Manifest(adapter, paths.manifest);
    if (JSON.stringify(current) !== JSON.stringify(manifest)) {
      throw new Error("A different V2 manifest is already committed");
    }
    await removeIfExists(adapter, paths.manifestNext);
    return;
  }
  await adapter.rename(paths.manifestNext, paths.manifest);
  const committed = await readStateV2Manifest(adapter, paths.manifest);
  if (!committed || JSON.stringify(committed) !== JSON.stringify(manifest)) {
    throw new Error("V2 manifest failed committed read-back verification");
  }
}

async function writeV1BackupOnce(
  adapter: DataAdapter,
  path: string,
  snapshot: unknown,
  createdAt: number,
): Promise<void> {
  if (await adapter.exists(path)) return;
  const backup = { schemaVersion: 1, createdAt, snapshot };
  await adapter.write(path, JSON.stringify(backup));
  const reread = JSON.parse(await adapter.read(path)) as unknown;
  if (!isRecord(reread) || reread.schemaVersion !== 1 || !("snapshot" in reread)) {
    throw new Error("V1 backup failed read-back verification");
  }
}

function migrateBaseAnchor(
  base: BaseFileEntry,
  localEntries: LocalFileEntry[],
  pathById: Map<string, string>,
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"],
  now: number,
): SyncAnchorV2 | null {
  const localAtPath = localEntries.find((entry) => entry.path === base.path);
  const remoteAtPath = Object.values(itemsById).find((node) =>
    node.kind === "file" && pathById.get(node.id) === base.path,
  );
  if (localAtPath?.hash === base.hash && localAtPath.size === base.size
    && remoteAtPath && (remoteAtPath.eTag === base.eTag || remoteAtPath.contentHash === base.hash)) {
    return makeAnchor(remoteAtPath.id, base.path, base.hash, base.size, remoteAtPath.eTag, now);
  }

  const localCandidates = localEntries.filter((entry) => entry.hash === base.hash && entry.size === base.size);
  const remoteCandidates = Object.values(itemsById).filter((node) =>
    node.kind === "file" && node.contentHash === base.hash && node.size === base.size,
  );
  if (localCandidates.length !== 1 || remoteCandidates.length !== 1) return null;
  const remotePath = pathById.get(remoteCandidates[0]!.id);
  if (!remotePath || remotePath !== localCandidates[0]!.path) return null;
  return makeAnchor(remoteCandidates[0]!.id, remotePath, base.hash, base.size, remoteCandidates[0]!.eTag, now);
}

function migrateCloudHint(
  hint: CloudBootstrapAnchorHintV2,
  localEntries: LocalFileEntry[],
  pathById: Map<string, string>,
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"],
  now: number,
): SyncAnchorV2 | null {
  if (!hint.remoteId) return null;
  const local = localEntries.find((entry) => entry.path === hint.lastPath);
  const remote = itemsById[hint.remoteId];
  if (!local || !remote || remote.kind !== "file") return null;
  if (local.hash !== hint.contentHash || local.size !== hint.size) return null;
  if (pathById.get(remote.id) !== hint.lastPath || remote.contentHash !== hint.contentHash) return null;
  return makeAnchor(remote.id, hint.lastPath, hint.contentHash, hint.size, remote.eTag, now, "cloud");
}

function makeAnchor(
  remoteId: string,
  path: string,
  hash: string,
  size: number,
  remoteETag: string | undefined,
  now: number,
  prefix = "migrated",
): SyncAnchorV2 {
  return {
    anchorId: `${prefix}:${remoteId}`,
    remoteId,
    lastPath: path,
    contentHash: hash,
    size,
    remoteETag,
    confirmedAt: now,
    confirmedBy: "equal-read",
  };
}

function isManifest(value: unknown): value is StateV2Manifest {
  return isRecord(value)
    && value.schemaVersion === 2
    && value.activeState === "state-v2.json"
    && Number.isSafeInteger(value.stateCommitSeq) && (value.stateCommitSeq as number) >= 1
    && Number.isSafeInteger(value.lifecycleEpoch) && (value.lifecycleEpoch as number) >= 0
    && isSyncScope(value.scope)
    && typeof value.migratedAt === "number"
    && value.legacyAutoSyncAllowed === false;
}

async function removeIfExists(adapter: DataAdapter, path: string): Promise<void> {
  if (await adapter.exists(path)) await adapter.remove(path);
}
