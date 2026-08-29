import type { DataAdapter } from "obsidian";
import type { DriveItem } from "../onedrive/types";
import { isRecord } from "../obsidian-compat";
import { buildRemoteIndexV2 } from "./remote-index-v2";
import {
  isSyncScope,
  sameSyncScope,
  SyncActionType,
  type BaseFileEntry,
  type CanonicalPlanIdentityV2,
  type LocalFileEntry,
  type LocalFolderEntry,
  type MutationLedgerEntryV1,
  type RemoteFileEntry,
  type SyncPlanItem,
  type SyncScope,
} from "./types";
import {
  StateEnvelopeV2Store,
  validateEnvelope,
  type StateEnvelopeV2Paths,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  cloudBootstrapRemoteVersionMatches,
  type CloudBootstrapAnchorV2,
} from "./cloud-bootstrap-v2";
import { buildInitialFolderAnchorsV2 } from "./folder-state-v2";

export interface StateV2MigrationPaths extends StateEnvelopeV2Paths {
  manifest: string;
  manifestNext: string;
  v1Backup: string;
}

export interface CloudBootstrapAnchorHintV2
  extends Omit<CloudBootstrapAnchorV2, "remoteId"> {
  remoteId?: string;
}

export interface StateV2MigrationInput {
  scope: SyncScope;
  lifecycleEpoch: number;
  localScanComplete: boolean;
  remoteScanComplete: boolean;
  localEntries: LocalFileEntry[];
  /** Complete folder snapshot used only to establish exact same-path anchors. */
  localFolders?: LocalFolderEntry[];
  folderScanComplete?: boolean;
  remoteItems: DriveItem[];
  v1Base: BaseFileEntry[];
  /** Last V1 remote snapshot captured before live remote preparation. When
   *  its version still matches the common base, its driveId is historical
   *  identity evidence even if the live item moved, changed, or disappeared. */
  v1RemoteEntries?: RemoteFileEntry[];
  v1Snapshot: unknown;
  cloudHints?: CloudBootstrapAnchorHintV2[];
  /** V1 base paths intentionally outside this device's active scan scope.
   *  Their last committed anchors must survive migration without treating the
   *  deliberate absence as current content evidence. */
  preservedBasePaths?: string[];
  /** Production activation requires every V1 base entry to have a safe V2
   *  anchor. Fixture/model callers may leave this false to inspect pending. */
  requireCompleteAnchors?: boolean;
  /** Already published, content-addressed V2 ancestor objects. A candidate
   *  may reference only a hash that exactly matches the corresponding base. */
  ancestorHashesByPath?: Readonly<Record<string, string>>;
  now?: number;
}

export interface StateV2MigrationCandidateInput
  extends Omit<StateV2MigrationInput, "v1Snapshot"> {
  /** Retain a proven V1 remote identity even when one or both live sides
   *  changed from the common base. This is valid only for an unpublished
   *  candidate that will feed the canonical migration plan. */
  allowChangedAnchors?: boolean;
  /** Parsed public-1.1.3 recovery evidence. It may retain only the remote
   *  identity of an exact unreceipted download; it never proves the mutation
   *  applied and never enters the candidate envelope. */
  v1MutationLedger?: readonly MutationLedgerEntryV1[];
  /** Parsed public-1.1.3 pending conflicts. A unique, exact record may prove
   *  the current remote identity for a changed common ancestor; it never
   *  authorizes the stale V1 review or any mutation. */
  v1PendingConflicts?: readonly SyncPlanItem[];
  /** Public V1 decision tokens are bound to the storage Vault name as well as
   *  Graph scope. */
  v1VaultName?: string;
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

export type StateV2ManifestLoadFailureReason =
  | "manifest-unreadable"
  | "manifest-unsupported";

export class StateV2ManifestLoadError extends Error {
  constructor(
    readonly reason: StateV2ManifestLoadFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "StateV2ManifestLoadError";
  }
}

export interface StateV2MigrationResult {
  status: "committed" | "already-committed" | "aborted";
  reason?:
    | "scan-incomplete"
    | "remote-identity-incomplete"
    | "anchor-incomplete"
    | "committed-envelope-mismatch"
    | "state-save-failure";
  pending: StateV2MigrationPending[];
  mutations: [];
  envelope: SyncStateEnvelopeV2 | null;
  manifest: StateV2Manifest | null;
  v1BackupRetained: true;
}

export interface StateV2MigrationCandidateResult {
  status: "ready" | "aborted";
  reason?:
    | "scan-incomplete"
    | "remote-identity-incomplete"
    | "anchor-incomplete";
  pending: StateV2MigrationPending[];
  mutations: [];
  envelope: SyncStateEnvelopeV2 | null;
}

export interface ReviewedStateV2MigrationInput {
  candidate: SyncStateEnvelopeV2;
  canonicalIdentity: CanonicalPlanIdentityV2;
  v1Snapshot: unknown;
  ancestorExists?: (hash: string) => Promise<boolean>;
  now?: number;
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
  const baseResult = {
    pending: [] as StateV2MigrationPending[],
    mutations: [] as [],
    v1BackupRetained: true as const,
  };

  const existing = await readExistingMigration(
    adapter,
    paths,
    input.scope,
    baseResult,
  );
  if (existing) return existing;

  const prepared = buildStateV2MigrationCandidate({
    ...input,
    // Publication is permitted only after an external exact zero-plan gate.
    // Never let a caller turn changed live facts into committed base state.
    allowChangedAnchors: false,
  });
  if (prepared.status === "aborted" || !prepared.envelope) {
    return {
      ...baseResult,
      pending: prepared.pending,
      status: "aborted",
      reason: prepared.reason,
      envelope: null,
      manifest: null,
    };
  }
  baseResult.pending.push(...prepared.pending);
  return publishMigrationCandidate(
    adapter,
    paths,
    prepared.envelope,
    input.v1Snapshot,
    input.now ?? Date.now(),
    baseResult,
  );
}

/**
 * Commit the exact candidate bound to a durable reviewed migration hold.
 *
 * The caller must re-create and compare both the candidate and sealed plan
 * before calling. This function validates that binding, writes only internal
 * state, and makes V2 authoritative by publishing the manifest last.
 */
export async function commitReviewedStateV2MigrationCandidate(
  adapter: DataAdapter,
  paths: StateV2MigrationPaths,
  input: ReviewedStateV2MigrationInput,
): Promise<StateV2MigrationResult> {
  validateEnvelope(input.candidate);
  if (
    input.candidate.remoteIndex.complete !== true
    || !input.candidate.folderAnchors
    || input.candidate.meta.commitSeq !== 1
    || input.canonicalIdentity.version !== 2
    || input.canonicalIdentity.sourceCommitSeq
      !== input.candidate.meta.commitSeq
    || input.canonicalIdentity.digest.length === 0
    || !sameSyncScope(
      input.canonicalIdentity.scope,
      input.candidate.scope,
    )
  ) {
    throw new Error(
      "Reviewed V2 migration candidate is not bound to a complete sealed plan",
    );
  }
  const baseResult = {
    pending: [] as StateV2MigrationPending[],
    mutations: [] as [],
    v1BackupRetained: true as const,
  };
  const existing = await readExistingMigration(
    adapter,
    paths,
    input.candidate.scope,
    baseResult,
    input.candidate,
  );
  if (existing) return existing;
  return publishMigrationCandidate(
    adapter,
    paths,
    input.candidate,
    input.v1Snapshot,
    input.now ?? Date.now(),
    baseResult,
    input.ancestorExists,
  );
}

async function readExistingMigration(
  adapter: DataAdapter,
  paths: StateV2MigrationPaths,
  scope: SyncScope,
  baseResult: {
    pending: StateV2MigrationPending[];
    mutations: [];
    v1BackupRetained: true;
  },
  expectedCandidate?: SyncStateEnvelopeV2,
): Promise<StateV2MigrationResult | null> {
  const existingManifest = await readStateV2Manifest(adapter, paths.manifest);
  if (!existingManifest) return null;
  if (!sameSyncScope(existingManifest.scope, scope)) {
    throw new Error("V2 manifest belongs to another account or vault");
  }
  const envelopeStore = new StateEnvelopeV2Store(adapter, paths);
  const committed = await envelopeStore.load(scope);
  if (
    !committed
    || committed.meta.commitSeq < existingManifest.stateCommitSeq
    || committed.meta.lifecycleEpoch < existingManifest.lifecycleEpoch
  ) {
    throw new Error("V2 manifest does not have a current committed envelope");
  }
  if (
    expectedCandidate
    && !sameStateV2MigrationCandidate(committed, expectedCandidate)
  ) {
    throw new Error(
      "Committed V2 authority does not match the reviewed migration candidate",
    );
  }
  return {
    ...baseResult,
    status: "already-committed",
    envelope: committed,
    manifest: existingManifest,
  };
}

async function publishMigrationCandidate(
  adapter: DataAdapter,
  paths: StateV2MigrationPaths,
  candidate: SyncStateEnvelopeV2,
  v1Snapshot: unknown,
  now: number,
  baseResult: {
    pending: StateV2MigrationPending[];
    mutations: [];
    v1BackupRetained: true;
  },
  ancestorExists?: (hash: string) => Promise<boolean>,
): Promise<StateV2MigrationResult> {
  const envelopeStore = new StateEnvelopeV2Store(
    adapter,
    paths,
    ancestorExists,
  );
  try {
    await writeV1BackupOnce(adapter, paths.v1Backup, v1Snapshot, now);
  } catch {
    return {
      ...baseResult,
      status: "aborted",
      reason: "state-save-failure",
      envelope: null,
      manifest: null,
    };
  }
  let committed: SyncStateEnvelopeV2 | null;
  try {
    committed = await envelopeStore.load(candidate.scope);
  } catch {
    return {
      ...baseResult,
      status: "aborted",
      reason: "committed-envelope-mismatch",
      envelope: null,
      manifest: null,
    };
  }
  try {
    if (!committed) {
      await envelopeStore.publish(candidate);
      committed = await envelopeStore.load(candidate.scope);
    } else if (!sameStateV2MigrationCandidate(committed, candidate)) {
      return {
        ...baseResult,
        status: "aborted",
        reason: "committed-envelope-mismatch",
        envelope: null,
        manifest: null,
      };
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

/**
 * Build the complete V2 migration state in memory.
 *
 * This function has no adapter, Vault, Graph, manifest, or user-file mutation
 * capability. It is the only allowed bridge from read-only V1 facts to a V2
 * candidate envelope; publication and authority switching remain separate.
 */
export function buildStateV2MigrationCandidate(
  input: StateV2MigrationCandidateInput,
): StateV2MigrationCandidateResult {
  const baseResult = {
    pending: [] as StateV2MigrationPending[],
    mutations: [] as [],
  };
  if (
    !input.localScanComplete
    || !input.remoteScanComplete
    || input.folderScanComplete === false
  ) {
    return {
      ...baseResult,
      status: "aborted",
      reason: "scan-incomplete",
      envelope: null,
    };
  }

  let projection: ReturnType<typeof buildRemoteIndexV2>;
  try {
    projection = buildRemoteIndexV2(input.remoteItems, input.scope.filesRootId, null, 1);
  } catch {
    return {
      ...baseResult,
      status: "aborted",
      reason: "remote-identity-incomplete",
      envelope: null,
    };
  }

  const now = input.now ?? Date.now();
  const anchors: Record<string, SyncAnchorV2> = {};
  const v1BasePaths = new Set(input.v1Base.map((entry) => entry.path));
  const preservedBasePaths = new Set(input.preservedBasePaths ?? []);
  for (const base of input.v1Base) {
    const preserveOutsideCurrentScope = preservedBasePaths.has(base.path);
    const anchor = migrateBaseAnchor(
      base,
      input.localEntries,
      projection.pathById,
      projection.index.itemsById,
      input.v1RemoteEntries ?? [],
      input.scope,
      input.v1MutationLedger ?? [],
      input.v1PendingConflicts ?? [],
      input.v1VaultName,
      v1BasePaths,
      input.allowChangedAnchors === true,
      now,
    ) ?? (preserveOutsideCurrentScope
      ? preserveUnscannedBaseAnchor(
          base,
          projection.pathById,
          projection.index.itemsById,
          now,
        )
      : null);
    if (anchor) {
      const ancestorHash = input.ancestorHashesByPath?.[base.path];
      if (ancestorHash === base.hash) anchor.ancestorHash = ancestorHash;
      anchors[anchor.anchorId] = anchor;
    }
    else if (
      isRetiredBaseAnchor(
        base,
        input.localEntries,
        projection.pathById,
        projection.index.itemsById,
      )
      || (
        input.allowChangedAnchors === true
        && isHistoricalPathUnoccupied(
          base,
          input.localEntries,
          projection.pathById,
          projection.index.itemsById,
        )
      )
    ) {
      // A complete local + remote observation proves the historical path is
      // absent. Strict publication still requires every relocation candidate
      // to be gone. A reviewed unpublished candidate may instead retire this
      // old path without guessing identity; any current candidate path remains
      // an independent canonical-plan fact behind the migration hold.
      continue;
    }
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
  if (input.requireCompleteAnchors && baseResult.pending.length > 0) {
    return {
      ...baseResult,
      status: "aborted",
      reason: "anchor-incomplete",
      envelope: null,
    };
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
    ...(input.folderScanComplete === true
      ? {
          folderAnchors: {
            schemaVersion: 2 as const,
            byAnchorId: buildInitialFolderAnchorsV2({
              envelope: { remoteIndex: projection.index },
              localFiles: input.localEntries,
              localFolders: input.localFolders ?? [],
              confirmedGeneration: 1,
              confirmedAt: now,
            }),
          },
        }
      : {}),
  };

  return {
    ...baseResult,
    status: "ready",
    envelope: candidate,
  };
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
  } catch {
    // Some narrow test/compat adapters omit exists(); a failed read is the only
    // missing-file signal available to them. Real Obsidian adapters take the
    // strict exists→read path above, where corrupt content still fails closed.
    if (typeof exists !== "function") return null;
    throw new StateV2ManifestLoadError(
      "manifest-unreadable",
      "V2 state manifest is unreadable",
    );
  }
  if (!isStateV2Manifest(value)) {
    throw new StateV2ManifestLoadError(
      "manifest-unsupported",
      "V2 state manifest has an unsupported format",
    );
  }
  return value;
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
  if (await adapter.exists(path)) {
    const existing = JSON.parse(await adapter.read(path)) as unknown;
    if (
      !isRecord(existing)
      || existing.schemaVersion !== 1
      || !Number.isFinite(existing.createdAt)
      || !("snapshot" in existing)
      || JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)
    ) {
      throw new Error("Existing V1 backup does not match this migration input");
    }
    return;
  }
  const backup = { schemaVersion: 1, createdAt, snapshot };
  await adapter.write(path, JSON.stringify(backup));
  const reread = JSON.parse(await adapter.read(path)) as unknown;
  if (!isRecord(reread) || reread.schemaVersion !== 1 || !("snapshot" in reread)) {
    throw new Error("V1 backup failed read-back verification");
  }
}

async function removeIfExists(adapter: DataAdapter, path: string): Promise<void> {
  if (await adapter.exists(path)) await adapter.remove(path);
}

function migrateBaseAnchor(
  base: BaseFileEntry,
  localEntries: LocalFileEntry[],
  pathById: Map<string, string>,
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"],
  v1RemoteEntries: RemoteFileEntry[],
  scope: SyncScope,
  v1MutationLedger: readonly MutationLedgerEntryV1[],
  v1PendingConflicts: readonly SyncPlanItem[],
  v1VaultName: string | undefined,
  v1BasePaths: ReadonlySet<string>,
  allowChangedAnchors: boolean,
  now: number,
): SyncAnchorV2 | null {
  const localAtPath = localEntries.find((entry) => entry.path === base.path);
  const localStillMatchesBase =
    localAtPath?.hash === base.hash && localAtPath.size === base.size;
  const historicalRemote = v1RemoteEntries.find(
    (entry) =>
      entry.path === base.path
      && entry.eTag === base.eTag
      && Boolean(entry.driveId),
  );
  if (
    historicalRemote?.driveId
    && (allowChangedAnchors || localStillMatchesBase)
  ) {
    const liveNode = itemsById[historicalRemote.driveId];
    if (!liveNode || liveNode.kind === "file") {
      return makeAnchor(
        historicalRemote.driveId,
        base.path,
        base.hash,
        base.size,
        base.eTag,
        now,
        "migrated",
        liveNode?.kind === "file" ? liveNode.cTag : undefined,
      );
    }
  }

  if (allowChangedAnchors) {
    const interruptedDownloadRemoteId =
      findExactInterruptedDownloadRemoteId({
        base,
        scope,
        ledger: v1MutationLedger,
        pathById,
        itemsById,
      });
    if (interruptedDownloadRemoteId) {
      return makeAnchor(
        interruptedDownloadRemoteId,
        base.path,
        base.hash,
        base.size,
        base.eTag,
        now,
        "migrated",
        itemsById[interruptedDownloadRemoteId]?.kind === "file"
          ? itemsById[interruptedDownloadRemoteId].cTag
          : undefined,
      );
    }
    const pendingConflictRemoteId =
      findExactPendingConflictRemoteId({
        base,
        scope,
        pendingConflicts: v1PendingConflicts,
        vaultName: v1VaultName,
        v1RemoteEntries,
        pathById,
        itemsById,
      });
    if (pendingConflictRemoteId) {
      return makeAnchor(
        pendingConflictRemoteId,
        base.path,
        base.hash,
        base.size,
        base.eTag,
        now,
        "migrated",
        itemsById[pendingConflictRemoteId]?.kind === "file"
          ? itemsById[pendingConflictRemoteId].cTag
          : undefined,
      );
    }
    const historicalRelocation = findExactHistoricalRelocation({
      base,
      localEntries,
      v1RemoteEntries,
      v1BasePaths,
      pathById,
      itemsById,
    });
    if (historicalRelocation) {
      return makeAnchor(
        historicalRelocation.driveId,
        historicalRelocation.path,
        base.hash,
        base.size,
        base.eTag,
        now,
        "migrated",
        itemsById[historicalRelocation.driveId]?.kind === "file"
          ? itemsById[historicalRelocation.driveId].cTag
          : undefined,
      );
    }
  }

  const remoteAtPath = Object.values(itemsById).find((node) =>
    node.kind === "file" && pathById.get(node.id) === base.path,
  );
  if (
    remoteAtPath
    && (allowChangedAnchors || localStillMatchesBase)
    && (
      remoteAtPath.eTag === base.eTag
      || remoteAtPath.contentHash === base.hash
    )
  ) {
    return makeAnchor(
      remoteAtPath.id,
      base.path,
      base.hash,
      base.size,
      base.eTag,
      now,
      "migrated",
      remoteAtPath.cTag,
    );
  }

  const localCandidates = localEntries.filter((entry) => entry.hash === base.hash && entry.size === base.size);
  const remoteCandidates = Object.values(itemsById).filter((node) =>
    node.kind === "file" && node.contentHash === base.hash && node.size === base.size,
  );
  if (localCandidates.length !== 1 || remoteCandidates.length !== 1) return null;
  const remotePath = pathById.get(remoteCandidates[0].id);
  if (!remotePath || remotePath !== localCandidates[0].path) return null;
  return makeAnchor(
    remoteCandidates[0].id,
    remotePath,
    base.hash,
    base.size,
    remoteCandidates[0].eTag,
    now,
    "migrated",
    remoteCandidates[0].cTag,
  );
}

function findExactInterruptedDownloadRemoteId(input: {
  base: BaseFileEntry;
  scope: SyncScope;
  ledger: readonly MutationLedgerEntryV1[];
  pathById: Map<string, string>;
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"];
}): string | null {
  const matches = input.ledger.filter((record) => {
    const intent = record.intent;
    if (
      record.receipt !== null
      || intent.version !== 1
      || intent.action !== "download"
      || intent.path !== input.base.path
      || !samePublic113RecoveryScope(intent.scope, input.scope)
      || !intent.expectedLocal.exists
      || intent.expectedLocal.hash !== input.base.hash
      || intent.expectedLocal.size !== input.base.size
      || !intent.expectedRemote.exists
    ) {
      return false;
    }
    const liveRemote = input.itemsById[intent.expectedRemote.driveId];
    return liveRemote?.kind === "file"
      && input.pathById.get(liveRemote.id) === input.base.path
      && liveRemote.eTag === intent.expectedRemote.eTag
      && liveRemote.size === intent.expectedRemote.size;
  });
  if (matches.length !== 1) return null;
  const expectedRemote = matches[0].intent.expectedRemote;
  return expectedRemote.exists ? expectedRemote.driveId : null;
}

/**
 * A public-1.1.3 conflict is device-local review evidence, not an execution
 * grant. It may retain only the current remote identity for the unpublished
 * V2 candidate when every persisted and live version fact is exact:
 *
 * - one conflict at this path;
 * - exact Vault + Graph scope, the public local facts, remote ID/eTag/size and
 *   ancestor hash recorded by the public decision token;
 * - the public remote snapshot and the complete live snapshot agree on that
 *   same current identity;
 *
 * Published ancestor bytes are deliberately optional here. Their absence
 * disables automatic merge by leaving anchor.ancestorHash unset, but does not
 * erase otherwise exact remote identity evidence. The current local file is
 * deliberately not trusted from this old record: the canonical planner scans
 * it independently, which also permits the plugin's own files to change during
 * upgrade. Any remote identity ambiguity still returns null.
 */
function findExactPendingConflictRemoteId(input: {
  base: BaseFileEntry;
  scope: SyncScope;
  pendingConflicts: readonly SyncPlanItem[];
  vaultName: string | undefined;
  v1RemoteEntries: readonly RemoteFileEntry[];
  pathById: Map<string, string>;
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"];
}): string | null {
  const atPath = input.pendingConflicts.filter(
    (item) => item.path === input.base.path,
  );
  if (
    atPath.length !== 1
    || !input.vaultName
  ) {
    return null;
  }
  const conflict = atPath[0];
  const token = conflict.decisionToken;
  const local = conflict.local;
  const remote = conflict.remote;
  if (
    conflict.type !== SyncActionType.Conflict
    || !token
    || token.version !== 1
    || token.vaultName !== input.vaultName
    || token.accountId !== token.scope.accountId
    || !samePublic113RecoveryScope(token.scope, input.scope)
    || token.ancestorHash !== input.base.hash
    || !token.local.exists
    || !token.remote.exists
    || !local
    || local.path !== input.base.path
    || token.local.hash !== local.hash
    || token.local.size !== local.size
    || !remote
    || remote.path !== input.base.path
    || token.remote.driveId !== remote.driveId
    || token.remote.eTag !== remote.eTag
  ) {
    return null;
  }
  const historical = input.v1RemoteEntries.filter(
    (entry) =>
      entry.path === input.base.path
      && entry.driveId === remote.driveId
      && entry.eTag === remote.eTag
      && entry.size === remote.size
      && (
        !remote.parentId
        || entry.parentId === remote.parentId
      ),
  );
  if (historical.length !== 1) return null;
  const liveRemote = input.itemsById[remote.driveId];
  if (
    !liveRemote
    || liveRemote.kind !== "file"
    || input.pathById.get(liveRemote.id) !== input.base.path
    || liveRemote.eTag !== remote.eTag
    || liveRemote.size !== remote.size
    || (
      remote.parentId
      && liveRemote.parentId !== remote.parentId
    )
  ) {
    return null;
  }
  return remote.driveId;
}

function findExactHistoricalRelocation(input: {
  base: BaseFileEntry;
  localEntries: readonly LocalFileEntry[];
  v1RemoteEntries: readonly RemoteFileEntry[];
  v1BasePaths: ReadonlySet<string>;
  pathById: ReadonlyMap<string, string>;
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"];
}): RemoteFileEntry | null {
  const candidates = input.v1RemoteEntries.filter(
    (entry) =>
      entry.path !== input.base.path
      && !input.v1BasePaths.has(entry.path)
      && Boolean(entry.driveId)
      && entry.eTag === input.base.eTag
      && entry.size === input.base.size,
  );
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const liveRemote = input.itemsById[candidate.driveId];
  const liveLocal = input.localEntries.filter(
    (entry) =>
      entry.path === candidate.path
      && entry.hash === input.base.hash
      && entry.size === input.base.size,
  );
  if (
    !liveRemote
    || liveRemote.kind !== "file"
    || input.pathById.get(liveRemote.id) !== candidate.path
    || liveRemote.eTag !== candidate.eTag
    || liveRemote.size !== candidate.size
    || liveRemote.parentId !== candidate.parentId
    || liveLocal.length !== 1
  ) {
    return null;
  }
  return candidate;
}

function samePublic113RecoveryScope(
  source: SyncScope,
  current: SyncScope,
): boolean {
  return sameSyncScope(source, current)
    || (
      source.accountId === ""
      && source.driveId === current.driveId
      && source.vaultFolderId === current.vaultFolderId
      && source.filesRootId === current.filesRootId
    );
}

function isRetiredBaseAnchor(
  base: BaseFileEntry,
  localEntries: LocalFileEntry[],
  pathById: Map<string, string>,
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"],
): boolean {
  const localAtPath = localEntries.some((entry) => entry.path === base.path);
  const localContentCandidate = localEntries.some(
    (entry) => entry.hash === base.hash && entry.size === base.size,
  );
  const remoteFiles = Object.values(itemsById).filter(
    (node) => node.kind === "file",
  );
  const remoteAtPath = remoteFiles.some(
    (node) => pathById.get(node.id) === base.path,
  );
  const remoteContentCandidate = remoteFiles.some(
    (node) => node.contentHash === base.hash && node.size === base.size,
  );
  return !localAtPath
    && !localContentCandidate
    && !remoteAtPath
    && !remoteContentCandidate;
}

function isHistoricalPathUnoccupied(
  base: BaseFileEntry,
  localEntries: LocalFileEntry[],
  pathById: Map<string, string>,
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"],
): boolean {
  const localAtPath = localEntries.some((entry) => entry.path === base.path);
  const remoteAtPath = Object.values(itemsById).some(
    (node) => node.kind === "file" && pathById.get(node.id) === base.path,
  );
  return !localAtPath && !remoteAtPath;
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
  if (pathById.get(remote.id) !== hint.lastPath
    || !cloudBootstrapRemoteVersionMatches(remote, hint)) return null;
  return makeAnchor(
    remote.id,
    hint.lastPath,
    hint.contentHash,
    hint.size,
    remote.eTag,
    now,
    "cloud",
    remote.cTag,
  );
}

function preserveUnscannedBaseAnchor(
  base: BaseFileEntry,
  pathById: Map<string, string>,
  itemsById: SyncStateEnvelopeV2["remoteIndex"]["itemsById"],
  now: number,
): SyncAnchorV2 {
  const remote = Object.values(itemsById).find((node) =>
    node.kind === "file" && pathById.get(node.id) === base.path,
  );
  const remoteId = remote?.id;
  return {
    anchorId: remoteId ? `migrated:${remoteId}` : `migrated-path:${base.path}`,
    remoteId,
    lastPath: base.path,
    contentHash: base.hash,
    size: base.size,
    remoteETag: base.eTag,
    ...(remote?.kind === "file" && remote.cTag
      ? { remoteCTag: remote.cTag }
      : {}),
    confirmedAt: now,
    confirmedBy: "equal-read",
  };
}

export function sameStateV2MigrationCandidate(
  committed: SyncStateEnvelopeV2,
  candidate: SyncStateEnvelopeV2,
): boolean {
  return JSON.stringify(normalizeMigrationEnvelope(committed, false))
    === JSON.stringify(normalizeMigrationEnvelope(candidate, false));
}

/**
 * Proves that a post-cutover V2 envelope differs from the reviewed migration
 * candidate only by the normal remote-index cursor publication.
 *
 * Commit sequence, delta cursor and cursor revision are controller metadata.
 * Scope, lifecycle, every remote item/version, and all file/folder anchors
 * remain exact. The executor additionally compares the normalized canonical
 * action digest before reusing the reviewed migration authorization.
 */
export function sameStateV2MigrationResumeFacts(
  reviewed: SyncStateEnvelopeV2,
  current: SyncStateEnvelopeV2,
): boolean {
  return JSON.stringify(normalizeMigrationEnvelope(reviewed, true))
    === JSON.stringify(normalizeMigrationEnvelope(current, true));
}

function normalizeMigrationEnvelope(
  envelope: SyncStateEnvelopeV2,
  ignoreCursorPublication: boolean,
): unknown {
  return {
    meta: {
      schemaVersion: envelope.meta.schemaVersion,
      lifecycleEpoch: envelope.meta.lifecycleEpoch,
      commitSeq: ignoreCursorPublication ? 0 : envelope.meta.commitSeq,
    },
    scope: envelope.scope,
    remoteIndex: {
      ...envelope.remoteIndex,
      ...(ignoreCursorPublication
        ? { cursorRevision: 0, deltaLink: null }
        : {}),
      itemsById: sortRecordByKey(envelope.remoteIndex.itemsById),
    },
    anchors: {
      schemaVersion: envelope.anchors.schemaVersion,
      byAnchorId: sortRecordByKey(
        Object.fromEntries(
          Object.entries(envelope.anchors.byAnchorId).map(([anchorId, anchor]) => [
            anchorId,
            { ...anchor, confirmedAt: 0 },
          ]),
        ),
      ),
    },
    folderAnchors: envelope.folderAnchors
      ? {
          schemaVersion: envelope.folderAnchors.schemaVersion,
          byAnchorId: sortRecordByKey(
            Object.fromEntries(
              Object.entries(envelope.folderAnchors.byAnchorId).map(([anchorId, anchor]) => [
                anchorId,
                { ...anchor, confirmedAt: 0 },
              ]),
            ),
          ),
        }
      : undefined,
  };
}

function sortRecordByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function makeAnchor(
  remoteId: string,
  path: string,
  hash: string,
  size: number,
  remoteETag: string | undefined,
  now: number,
  prefix = "migrated",
  remoteCTag?: string,
): SyncAnchorV2 {
  return {
    anchorId: `${prefix}:${remoteId}`,
    remoteId,
    lastPath: path,
    contentHash: hash,
    size,
    remoteETag,
    ...(remoteCTag ? { remoteCTag } : {}),
    confirmedAt: now,
    confirmedBy: "equal-read",
  };
}

export function isStateV2Manifest(value: unknown): value is StateV2Manifest {
  return isRecord(value)
    && value.schemaVersion === 2
    && value.activeState === "state-v2.json"
    && Number.isSafeInteger(value.stateCommitSeq) && (value.stateCommitSeq as number) >= 1
    && Number.isSafeInteger(value.lifecycleEpoch) && (value.lifecycleEpoch as number) >= 0
    && isSyncScope(value.scope)
    && Number.isFinite(value.migratedAt)
    && value.legacyAutoSyncAllowed === false;
}
