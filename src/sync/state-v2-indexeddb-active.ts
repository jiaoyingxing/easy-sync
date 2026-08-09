import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from "idb";
import { sha256Hex } from "../crypto";
import { isIndexedDbVaultInstanceId } from "./indexeddb-vault-namespace";
import type { RemoteNodeV2 } from "./remote-index-v2";
import {
  stateV2EnvelopeHeader,
  validateEnvelope,
  type FolderAnchorV2,
  type StateV2EnvelopeHeader,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import {
  StateV2IndexedDbRecoveryStore,
  stateV2IndexedDbRecoveryEnvelopeDigest,
} from "./state-v2-indexeddb-recovery";
import { sameSyncScope } from "./types";

const DATABASE_SCHEMA_VERSION = 1;
const STATE_META_KEY = "state";
const DEFAULT_IMPORT_BATCH_SIZE = 1_000;
const DATABASE_NAME_PREFIX = "easy-sync:v2:active:";
const DATABASE_ID_PATTERN = /^[a-f0-9]{32}$/;

type ActiveStatePhase = "preparing" | "ready";

interface StoredActiveStateMeta {
  schemaVersion: 1;
  kind: "state-v2-indexeddb-owner";
  phase: ActiveStatePhase;
  databaseId: string;
  stateDigest: string;
  expectedCounts: StateV2IndexedDbActiveCounts;
  header: StateV2EnvelopeHeader;
  readyAt?: number;
}

interface StateV2ActiveDb extends DBSchema {
  meta: {
    key: string;
    value: StoredActiveStateMeta;
  };
  remoteNodes: {
    key: string;
    value: RemoteNodeV2;
    indexes: { "by-parent": string };
  };
  anchors: {
    key: string;
    value: SyncAnchorV2;
    indexes: { "by-remote": string };
  };
  folderAnchors: {
    key: string;
    value: FolderAnchorV2;
    indexes: { "by-remote": string };
  };
}

export interface StateV2IndexedDbActiveCounts {
  remoteNodes: number;
  anchors: number;
  folderAnchors: number;
}

export interface StateV2IndexedDbActiveInspection {
  phase: ActiveStatePhase | "missing";
  databaseId: string | null;
  commitSeq: number | null;
  lifecycleEpoch: number | null;
  stateDigest: string | null;
  counts: StateV2IndexedDbActiveCounts;
}

export interface StateV2IndexedDbActiveInitializeResult {
  reused: boolean;
  stateDigest: string;
  counts: StateV2IndexedDbActiveCounts;
  batches: number;
  logicalWrites: number;
}

export interface StateV2IndexedDbActiveCommitResult {
  alreadyCommitted: boolean;
  commitSeq: number;
  stateDigest: string;
  logicalWrites: number;
}

export type StateV2IndexedDbRecoveryReconciliation =
  | "clean"
  | "witness-confirmed"
  | "orphan-retired";

export type StateV2IndexedDbActiveStateErrorReason =
  | "missing"
  | "not-ready"
  | "binding-mismatch"
  | "count-mismatch"
  | "digest-mismatch"
  | "revision-mismatch";

export class StateV2IndexedDbActiveStateError extends Error {
  constructor(
    readonly reason: StateV2IndexedDbActiveStateErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "StateV2IndexedDbActiveStateError";
  }
}

/**
 * Transactional IndexedDB owner for one explicitly identified V2 state base.
 *
 * Authority selection remains outside this class. A future manifest transaction
 * must bind the exact databaseId before StateManager may treat this database as
 * active. Recovery records are prepared before each strict transaction and
 * witnessed only after the committed metadata is read back.
 */
export class StateV2IndexedDbActiveStore {
  readonly databaseName: string;
  private dbPromise: Promise<IDBPDatabase<StateV2ActiveDb>> | null = null;
  private currentEnvelope: SyncStateEnvelopeV2 | null = null;
  private pendingWitnessCommit: {
    previous: SyncStateEnvelopeV2;
    next: SyncStateEnvelopeV2;
  } | null = null;

  constructor(
    readonly databaseId: string,
    private readonly recovery: StateV2IndexedDbRecoveryStore,
  ) {
    this.databaseName = stateV2ActiveIndexedDbDatabaseName(databaseId);
  }

  async close(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    this.currentEnvelope = null;
    this.pendingWitnessCommit = null;
    if (pending) (await pending).close();
  }

  async delete(): Promise<void> {
    await this.close();
    await deleteDB(this.databaseName);
  }

  async initialize(
    envelope: SyncStateEnvelopeV2,
    options: {
      batchSize?: number;
      now?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<StateV2IndexedDbActiveInitializeResult> {
    validateEnvelope(envelope);
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error(
        "IndexedDB active-state batch size must be a positive integer",
      );
    }
    throwIfAborted(options.signal);

    const stateDigest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(envelope);
    const expectedCounts = envelopeCounts(envelope);

    // A selected database without a full recovery checkpoint is not eligible
    // for authority. Publish and verify it before creating the ready database.
    await this.recovery.publishCheckpoint(envelope);

    const existing = await this.readMeta();
    if (existing) {
      if (
        existing.phase === "ready"
        && existing.databaseId === this.databaseId
        && existing.stateDigest === stateDigest
        && existing.header.meta.commitSeq === envelope.meta.commitSeq
        && sameCounts(existing.expectedCounts, expectedCounts)
      ) {
        const loaded = await this.load();
        if (
          await stateV2IndexedDbRecoveryEnvelopeDigest(loaded)
            !== stateDigest
        ) {
          throw new StateV2IndexedDbActiveStateError(
            "digest-mismatch",
            "IndexedDB active-state reuse did not reload the exact envelope",
          );
        }
        return {
          reused: true,
          stateDigest,
          counts: expectedCounts,
          batches: 0,
          logicalWrites: 0,
        };
      }
      const resumesExactPreparation =
        existing.phase === "preparing"
        && existing.databaseId === this.databaseId
        && existing.stateDigest === stateDigest
        && existing.header.meta.commitSeq === envelope.meta.commitSeq
        && sameCounts(existing.expectedCounts, expectedCounts);
      if (!resumesExactPreparation) {
        throw new StateV2IndexedDbActiveStateError(
          existing.databaseId === this.databaseId
            ? "revision-mismatch"
            : "binding-mismatch",
          "IndexedDB active-state database already contains a different state",
        );
      }
    }

    const preparing: StoredActiveStateMeta = {
      schemaVersion: 1,
      kind: "state-v2-indexeddb-owner",
      phase: "preparing",
      databaseId: this.databaseId,
      stateDigest,
      expectedCounts,
      header: stateV2EnvelopeHeader(envelope),
    };
    const db = await this.open();
    const startTx = db.transaction(
      ["meta", "remoteNodes", "anchors", "folderAnchors"],
      "readwrite",
      { durability: "strict" },
    );
    await Promise.all([
      startTx.objectStore("remoteNodes").clear(),
      startTx.objectStore("anchors").clear(),
      startTx.objectStore("folderAnchors").clear(),
      startTx.objectStore("meta").put(preparing, STATE_META_KEY),
      startTx.done,
    ]);
    throwIfAborted(options.signal);

    let batches = 0;
    batches += await putBatches(
      db,
      "remoteNodes",
      Object.values(envelope.remoteIndex.itemsById),
      (node) => node.id,
      batchSize,
      options.signal,
    );
    batches += await putBatches(
      db,
      "anchors",
      Object.values(envelope.anchors.byAnchorId),
      (anchor) => anchor.anchorId,
      batchSize,
      options.signal,
    );
    batches += await putBatches(
      db,
      "folderAnchors",
      Object.values(envelope.folderAnchors?.byAnchorId ?? {}),
      (anchor) => anchor.anchorId,
      batchSize,
      options.signal,
    );

    const storedCounts = await this.countRecords();
    assertCounts(expectedCounts, storedCounts);
    const reconstructed = await this.readEnvelope(preparing);
    if (
      await stateV2IndexedDbRecoveryEnvelopeDigest(reconstructed)
        !== stateDigest
    ) {
      throw new StateV2IndexedDbActiveStateError(
        "digest-mismatch",
        "IndexedDB active-state preparation did not rebuild the source envelope",
      );
    }
    throwIfAborted(options.signal);

    const activationTx = db.transaction("meta", "readwrite", {
      durability: "strict",
    });
    await Promise.all([
      activationTx.store.put(
        {
          ...preparing,
          phase: "ready",
          readyAt: options.now ?? Date.now(),
        },
        STATE_META_KEY,
      ),
      activationTx.done,
    ]);
    this.currentEnvelope = envelope;
    return {
      reused: false,
      stateDigest,
      counts: storedCounts,
      batches,
      logicalWrites:
        storedCounts.remoteNodes
        + storedCounts.anchors
        + storedCounts.folderAnchors
        + 2,
    };
  }

  async load(): Promise<SyncStateEnvelopeV2> {
    const meta = await this.readMeta();
    if (!meta) {
      throw new StateV2IndexedDbActiveStateError(
        "missing",
        "IndexedDB active-state metadata is missing",
      );
    }
    assertReadyMeta(meta, this.databaseId);
    const counts = await this.countRecords();
    assertCounts(meta.expectedCounts, counts);
    const envelope = await this.readEnvelope(meta);
    const digest = await stateV2IndexedDbRecoveryEnvelopeDigest(envelope);
    if (digest !== meta.stateDigest) {
      throw new StateV2IndexedDbActiveStateError(
        "digest-mismatch",
        "IndexedDB active-state digest does not match its rows",
      );
    }
    this.currentEnvelope = envelope;
    return envelope;
  }

  /**
   * Finishes the recovery witness after a process stopped between the
   * successful database transaction and witness publication. External
   * authority recovery must first establish that this database is selected.
   */
  async confirmLoadedRecoveryDelta(): Promise<void> {
    const envelope = this.currentEnvelope ?? await this.load();
    const meta = await this.readMeta();
    if (!meta) {
      throw new StateV2IndexedDbActiveStateError(
        "missing",
        "IndexedDB active-state metadata is missing during recovery confirmation",
      );
    }
    assertReadyMeta(meta, this.databaseId);
    const digest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(envelope);
    if (
      meta.header.meta.commitSeq !== envelope.meta.commitSeq
      || meta.stateDigest !== digest
    ) {
      throw new StateV2IndexedDbActiveStateError(
        "digest-mismatch",
        "IndexedDB active-state recovery confirmation does not match loaded state",
      );
    }
    await this.recovery.confirmValidatedCommittedDelta(envelope, digest);
    this.pendingWitnessCommit = null;
  }

  async reconcileLoadedRecoveryDelta(): Promise<
    StateV2IndexedDbRecoveryReconciliation
  > {
    const envelope = this.currentEnvelope ?? await this.load();
    const digest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(envelope);
    await this.assertExactActiveEnvelope(envelope, digest);
    let result: StateV2IndexedDbRecoveryReconciliation = "clean";
    if (await this.recovery.needsCommitWitness(envelope.meta.commitSeq)) {
      await this.confirmLoadedRecoveryDelta();
      result = "witness-confirmed";
    }
    if (await this.recovery.retireUncommittedFutureDelta(
      envelope,
      digest,
      async () => this.assertExactActiveEnvelope(envelope, digest),
    )) {
      result = "orphan-retired";
    }
    return result;
  }

  async compactRecoveryIfNeeded(
    minimumStaleRecords = 512,
  ): Promise<boolean> {
    const envelope = this.currentEnvelope ?? await this.load();
    if (
      !await this.recovery.shouldCompact(
        envelope.meta.commitSeq,
        minimumStaleRecords,
      )
    ) {
      return false;
    }
    await this.recovery.compact(envelope);
    return true;
  }

  async commit(
    previous: SyncStateEnvelopeV2,
    next: SyncStateEnvelopeV2,
  ): Promise<StateV2IndexedDbActiveCommitResult> {
    const resumesPendingWitness =
      this.pendingWitnessCommit?.previous === previous
      && this.pendingWitnessCommit.next === next;
    if (previous !== this.currentEnvelope && !resumesPendingWitness) {
      throw new StateV2IndexedDbActiveStateError(
        "revision-mismatch",
        "IndexedDB active-state commit must use the exact loaded envelope",
      );
    }
    if (!resumesPendingWitness) validateEnvelope(next);
    if (!sameSyncScope(previous.scope, next.scope)) {
      throw new Error(
        "IndexedDB active-state incremental commit cannot change sync scope",
      );
    }
    if (next.meta.commitSeq !== previous.meta.commitSeq + 1) {
      throw new Error(
        "IndexedDB active-state commit must advance exactly one revision",
      );
    }
    if (next.meta.lifecycleEpoch < previous.meta.lifecycleEpoch) {
      throw new Error(
        "IndexedDB active-state commit cannot move lifecycle backwards",
      );
    }

    const meta = await this.readMeta();
    if (!meta) {
      throw new StateV2IndexedDbActiveStateError(
        "missing",
        "IndexedDB active-state metadata is missing during commit",
      );
    }
    assertReadyMeta(meta, this.databaseId);

    const databaseAtPrevious =
      meta.header.meta.commitSeq === previous.meta.commitSeq;
    const databaseAtNext =
      meta.header.meta.commitSeq === next.meta.commitSeq;
    if (!databaseAtPrevious && !databaseAtNext) {
      throw new StateV2IndexedDbActiveStateError(
        "revision-mismatch",
        "IndexedDB active-state current revision does not match commit input",
      );
    }
    const prepared = await this.recovery.prepareValidatedDelta(
      previous,
      next,
      databaseAtPrevious
        ? { previousEnvelopeDigest: meta.stateDigest }
        : {},
    );
    if (
      databaseAtNext
      && meta.stateDigest === prepared.nextEnvelopeDigest
    ) {
      await this.recovery.confirmValidatedCommittedDelta(
        next,
        prepared.nextEnvelopeDigest,
      );
      this.currentEnvelope = next;
      this.pendingWitnessCommit = null;
      return {
        alreadyCommitted: true,
        commitSeq: next.meta.commitSeq,
        stateDigest: prepared.nextEnvelopeDigest,
        logicalWrites: 0,
      };
    }
    if (
      !databaseAtPrevious
      || meta.stateDigest !== prepared.previousEnvelopeDigest
    ) {
      throw new StateV2IndexedDbActiveStateError(
        "revision-mismatch",
        "IndexedDB active-state current revision does not match commit input",
      );
    }

    const remoteNodes = prepared.remoteNodes;
    const anchors = prepared.anchors;
    const folderAnchors = prepared.folderAnchors;
    const nextMeta: StoredActiveStateMeta = {
      ...meta,
      stateDigest: prepared.nextEnvelopeDigest,
      expectedCounts: envelopeCounts(next),
      header: stateV2EnvelopeHeader(next),
    };
    const db = await this.open();
    const tx = db.transaction(
      ["meta", "remoteNodes", "anchors", "folderAnchors"],
      "readwrite",
      { durability: "strict" },
    );
    try {
      await applyRowChanges(
        tx.objectStore("remoteNodes"),
        remoteNodes,
        (node) => node.id,
      );
      await applyRowChanges(
        tx.objectStore("anchors"),
        anchors,
        (anchor) => anchor.anchorId,
      );
      await applyRowChanges(
        tx.objectStore("folderAnchors"),
        folderAnchors,
        (anchor) => anchor.anchorId,
      );
      await tx.objectStore("meta").put(nextMeta, STATE_META_KEY);
      await tx.done;
    } catch (error) {
      abortTransaction(tx);
      await tx.done.catch(() => undefined);
      throw error;
    }

    const committedMeta = await this.readMeta();
    if (
      !committedMeta
      || committedMeta.phase !== "ready"
      || committedMeta.databaseId !== this.databaseId
      || committedMeta.header.meta.commitSeq !== next.meta.commitSeq
      || committedMeta.stateDigest !== prepared.nextEnvelopeDigest
    ) {
      throw new StateV2IndexedDbActiveStateError(
        "revision-mismatch",
        "IndexedDB active-state commit could not read back its revision",
      );
    }
    this.pendingWitnessCommit = { previous, next };
    await this.recovery.confirmValidatedCommittedDelta(
      next,
      prepared.nextEnvelopeDigest,
    );
    this.currentEnvelope = next;
    this.pendingWitnessCommit = null;
    return {
      alreadyCommitted: false,
      commitSeq: next.meta.commitSeq,
      stateDigest: prepared.nextEnvelopeDigest,
      logicalWrites:
        remoteNodes.upserts.length
        + remoteNodes.deletes.length
        + anchors.upserts.length
        + anchors.deletes.length
        + folderAnchors.upserts.length
        + folderAnchors.deletes.length
        + 1,
    };
  }

  /**
   * Rebuild only the exact envelope. The caller must initialize a fresh
   * databaseId and atomically switch external authority to that new database;
   * this method never overwrites or reuses a selected database.
   */
  async rebuildRecoveryEnvelope(): Promise<SyncStateEnvelopeV2> {
    return this.recovery.rebuild();
  }

  async inspect(): Promise<StateV2IndexedDbActiveInspection> {
    const meta = await this.readMeta();
    return {
      phase: meta?.phase ?? "missing",
      databaseId: meta?.databaseId ?? null,
      commitSeq: meta?.header.meta.commitSeq ?? null,
      lifecycleEpoch: meta?.header.meta.lifecycleEpoch ?? null,
      stateDigest: meta?.stateDigest ?? null,
      counts: await this.countRecords(),
    };
  }

  private async assertExactActiveEnvelope(
    expected: SyncStateEnvelopeV2,
    expectedDigest: string,
  ): Promise<void> {
    const meta = await this.readMeta();
    if (!meta) {
      throw new StateV2IndexedDbActiveStateError(
        "missing",
        "IndexedDB active-state metadata is missing during recovery reconciliation",
      );
    }
    assertReadyMeta(meta, this.databaseId);
    if (
      meta.header.meta.commitSeq !== expected.meta.commitSeq
      || meta.header.meta.lifecycleEpoch !== expected.meta.lifecycleEpoch
      || meta.stateDigest !== expectedDigest
    ) {
      throw new StateV2IndexedDbActiveStateError(
        "revision-mismatch",
        "IndexedDB active-state revision changed during recovery reconciliation",
      );
    }
    const counts = await this.countRecords();
    assertCounts(meta.expectedCounts, counts);
    const reloaded = await this.readEnvelope(meta);
    if (
      await stateV2IndexedDbRecoveryEnvelopeDigest(reloaded)
        !== expectedDigest
    ) {
      throw new StateV2IndexedDbActiveStateError(
        "digest-mismatch",
        "IndexedDB active-state rows changed during recovery reconciliation",
      );
    }
  }

  private async open(): Promise<IDBPDatabase<StateV2ActiveDb>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<StateV2ActiveDb>(
        this.databaseName,
        DATABASE_SCHEMA_VERSION,
        {
          upgrade(db) {
            db.createObjectStore("meta");
            const remoteNodes = db.createObjectStore("remoteNodes");
            remoteNodes.createIndex("by-parent", "parentId");
            const anchors = db.createObjectStore("anchors");
            anchors.createIndex("by-remote", "remoteId");
            const folderAnchors = db.createObjectStore("folderAnchors");
            folderAnchors.createIndex("by-remote", "remoteId");
          },
          blocking: () => {
            void this.close();
          },
          terminated: () => {
            this.dbPromise = null;
          },
        },
      );
    }
    return this.dbPromise;
  }

  private async readMeta(): Promise<StoredActiveStateMeta | undefined> {
    return (await this.open()).get("meta", STATE_META_KEY);
  }

  private async countRecords(): Promise<StateV2IndexedDbActiveCounts> {
    const db = await this.open();
    const tx = db.transaction(
      ["remoteNodes", "anchors", "folderAnchors"],
      "readonly",
    );
    const [remoteNodes, anchors, folderAnchors] = await Promise.all([
      tx.objectStore("remoteNodes").count(),
      tx.objectStore("anchors").count(),
      tx.objectStore("folderAnchors").count(),
      tx.done,
    ]);
    return { remoteNodes, anchors, folderAnchors };
  }

  private async readEnvelope(
    meta: StoredActiveStateMeta,
  ): Promise<SyncStateEnvelopeV2> {
    const db = await this.open();
    const tx = db.transaction(
      ["remoteNodes", "anchors", "folderAnchors"],
      "readonly",
    );
    const [remoteNodes, anchors, folderAnchors] = await Promise.all([
      tx.objectStore("remoteNodes").getAll(),
      tx.objectStore("anchors").getAll(),
      tx.objectStore("folderAnchors").getAll(),
      tx.done,
    ]);
    const envelope: SyncStateEnvelopeV2 = {
      meta: structuredClone(meta.header.meta),
      scope: structuredClone(meta.header.scope),
      remoteIndex: {
        ...structuredClone(meta.header.remoteIndex),
        itemsById: Object.fromEntries(
          remoteNodes
            .sort((left, right) => compareText(left.id, right.id))
            .map((node) => [node.id, node]),
        ),
      },
      anchors: {
        schemaVersion: meta.header.anchorsSchemaVersion,
        byAnchorId: Object.fromEntries(
          anchors
            .sort((left, right) =>
              compareText(left.anchorId, right.anchorId))
            .map((anchor) => [anchor.anchorId, anchor]),
        ),
      },
      ...(meta.header.folderAnchorsPresent
        ? {
            folderAnchors: {
              schemaVersion:
                meta.header.folderAnchorsSchemaVersion ?? 2,
              byAnchorId: Object.fromEntries(
                folderAnchors
                  .sort((left, right) =>
                    compareText(left.anchorId, right.anchorId))
                  .map((anchor) => [anchor.anchorId, anchor]),
              ),
            },
          }
        : {}),
      ...(meta.header.remoteScopeRecovery
        ? {
            remoteScopeRecovery: structuredClone(
              meta.header.remoteScopeRecovery,
            ),
          }
        : {}),
      ...(meta.header.communityPluginParticipation
        ? {
            communityPluginParticipation: structuredClone(
              meta.header.communityPluginParticipation,
            ),
          }
        : {}),
    };
    validateEnvelope(envelope);
    return envelope;
  }
}

export function stateV2ActiveIndexedDbDatabaseName(
  databaseId: string,
): string {
  if (!DATABASE_ID_PATTERN.test(databaseId)) {
    throw new Error(
      "IndexedDB active-state database ID must be 32 lowercase hex characters",
    );
  }
  return `${DATABASE_NAME_PREFIX}${databaseId}`;
}

/**
 * Derive a retry-stable identity for a StateManager selection boundary.
 *
 * The previous ID is included for recovery replacement, so a genuinely lost
 * selected database advances to a different identity while a crash before the
 * witness commit reuses the same prepared replacement on restart.
 */
export async function deriveStateV2ActiveIndexedDbDatabaseId(input: {
  vaultInstanceId: string;
  stateDigest: string;
  previousDatabaseId?: string;
}): Promise<string> {
  if (!isIndexedDbVaultInstanceId(input.vaultInstanceId)) {
    throw new Error(
      "IndexedDB active-state Vault instance ID must be 32 lowercase hex characters",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.stateDigest)) {
    throw new Error(
      "IndexedDB active-state digest must be 64 lowercase hex characters",
    );
  }
  if (
    input.previousDatabaseId !== undefined
    && !DATABASE_ID_PATTERN.test(input.previousDatabaseId)
  ) {
    throw new Error(
      "IndexedDB active-state previous database ID must be 32 lowercase hex characters",
    );
  }
  const seed = JSON.stringify({
    schemaVersion: 1,
    vaultInstanceId: input.vaultInstanceId,
    stateDigest: input.stateDigest,
    ...(input.previousDatabaseId
      ? { previousDatabaseId: input.previousDatabaseId }
      : {}),
  });
  return (
    await sha256Hex(new TextEncoder().encode(seed).buffer)
  ).slice(0, 32);
}

function envelopeCounts(
  envelope: SyncStateEnvelopeV2,
): StateV2IndexedDbActiveCounts {
  return {
    remoteNodes: Object.keys(envelope.remoteIndex.itemsById).length,
    anchors: Object.keys(envelope.anchors.byAnchorId).length,
    folderAnchors: Object.keys(
      envelope.folderAnchors?.byAnchorId ?? {},
    ).length,
  };
}

async function applyRowChanges<
  Value extends RemoteNodeV2 | SyncAnchorV2 | FolderAnchorV2,
>(
  store: {
    put(value: Value, key: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  },
  changes: { upserts: Value[]; deletes: string[] },
  keyOf: (value: Value) => string,
): Promise<void> {
  for (const key of changes.deletes) await store.delete(key);
  for (const value of changes.upserts) {
    await store.put(value, keyOf(value));
  }
}

async function putBatches<
  StoreName extends "remoteNodes" | "anchors" | "folderAnchors",
  Value extends RemoteNodeV2 | SyncAnchorV2 | FolderAnchorV2,
>(
  db: IDBPDatabase<StateV2ActiveDb>,
  storeName: StoreName,
  values: readonly Value[],
  keyOf: (value: Value) => string,
  batchSize: number,
  signal?: AbortSignal,
): Promise<number> {
  let batches = 0;
  for (let offset = 0; offset < values.length; offset += batchSize) {
    throwIfAborted(signal);
    const tx = db.transaction(storeName, "readwrite", {
      durability: "strict",
    });
    const requests = values
      .slice(offset, offset + batchSize)
      .map((value) => tx.store.put(value, keyOf(value)));
    await Promise.all([...requests, tx.done]);
    batches += 1;
  }
  throwIfAborted(signal);
  return batches;
}

function assertReadyMeta(
  meta: StoredActiveStateMeta,
  expectedDatabaseId: string,
): void {
  if (meta.phase !== "ready") {
    throw new StateV2IndexedDbActiveStateError(
      "not-ready",
      "IndexedDB active-state database is not ready",
    );
  }
  if (meta.databaseId !== expectedDatabaseId) {
    throw new StateV2IndexedDbActiveStateError(
      "binding-mismatch",
      "IndexedDB active-state database binding does not match",
    );
  }
}

function assertCounts(
  expected: StateV2IndexedDbActiveCounts,
  actual: StateV2IndexedDbActiveCounts,
): void {
  for (
    const key of Object.keys(expected) as
      Array<keyof StateV2IndexedDbActiveCounts>
  ) {
    if (expected[key] !== actual[key]) {
      throw new StateV2IndexedDbActiveStateError(
        "count-mismatch",
        `IndexedDB active-state ${key} count mismatch: `
        + `expected ${expected[key]}, got ${actual[key]}`,
      );
    }
  }
}

function sameCounts(
  left: StateV2IndexedDbActiveCounts,
  right: StateV2IndexedDbActiveCounts,
): boolean {
  return left.remoteNodes === right.remoteNodes
    && left.anchors === right.anchors
    && left.folderAnchors === right.folderAnchors;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function abortTransaction(transaction: { abort(): void }): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already be committed or aborted.
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException(
    "IndexedDB active-state preparation aborted",
    "AbortError",
  );
}
