/**
 * Isolated IndexedDB/idb proof of concept for a future EasySync state base.
 *
 * This module is intentionally not imported by src/main.ts. It tests storage
 * and recovery contracts without changing the production V2 authority.
 */

import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from "idb";
import { sha256Hex } from "../../src/crypto";
import type { RemoteNodeV2 } from "../../src/sync/remote-index-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "../../src/sync/state-envelope-v2";
import {
  sameSyncScope,
  type MutationIntent,
  type MutationLedgerEntryV1,
  type MutationReceiptV1,
  type SyncScope,
} from "../../src/sync/types";

const DATABASE_SCHEMA_VERSION = 1;
const STATE_META_KEY = "state";
const DEFAULT_IMPORT_BATCH_SIZE = 1_000;

type ImportPhase = "importing" | "ready";

interface StoredEnvelopeHeader {
  meta: SyncStateEnvelopeV2["meta"];
  scope: SyncScope;
  remoteIndex: Omit<SyncStateEnvelopeV2["remoteIndex"], "itemsById">;
  anchorsSchemaVersion: 2;
  folderAnchorsPresent: boolean;
  folderAnchorsSchemaVersion?: 2;
  remoteScopeRecovery?: SyncStateEnvelopeV2["remoteScopeRecovery"];
}

interface StoredStateMeta {
  phase: ImportPhase;
  header: StoredEnvelopeHeader;
  sourceDigest: string;
  /** Commit revision covered by sourceDigest. Incremental commits deliberately
   * avoid re-hashing the complete 50k envelope in the foreground. */
  digestCommitSeq: number;
  expectedCounts: PocStateCounts;
  activatedAt?: number;
}

interface PocStateDb extends DBSchema {
  meta: {
    key: string;
    value: StoredStateMeta;
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
  mutationLedger: {
    key: string;
    value: MutationLedgerEntryV1;
  };
}

export interface PocStateCounts {
  remoteNodes: number;
  anchors: number;
  folderAnchors: number;
  mutationLedger: number;
}

export interface PocStateInspection {
  phase: ImportPhase | "missing";
  activationDigest: string | null;
  digestCommitSeq: number | null;
  counts: PocStateCounts;
  commitSeq: number | null;
}

export interface PocImportResult {
  digest: string;
  counts: PocStateCounts;
  batches: number;
  logicalWrites: number;
}

export type PocImportFailpoint =
  | { stage: "after-start" }
  | { stage: "after-remote-batch"; batch: number }
  | { stage: "after-anchor-batch"; batch: number }
  | { stage: "before-activation" };

export type PocFinalizeFailpoint =
  | "after-remote-node"
  | "after-anchor"
  | "before-meta"
  | "after-commit-response-lost";

export interface PocFinalizeInput {
  operationId: string;
  remoteNode: RemoteNodeV2;
  anchor: SyncAnchorV2;
  committedAt: number;
  failpoint?: PocFinalizeFailpoint;
}

export interface PocFinalizeResult {
  commitSeq: number;
  logicalWrites: number;
}

export class PocStateNotReadyError extends Error {
  constructor(readonly phase: ImportPhase | "missing") {
    super(`IndexedDB POC state is not ready: ${phase}`);
    this.name = "PocStateNotReadyError";
  }
}

export class IndexedDbStatePocStore {
  private dbPromise: Promise<IDBPDatabase<PocStateDb>> | null = null;

  constructor(readonly databaseName: string) {}

  static async delete(databaseName: string): Promise<void> {
    await deleteDB(databaseName);
  }

  async close(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (pending) (await pending).close();
  }

  async importEnvelope(
    envelope: SyncStateEnvelopeV2,
    options: {
      batchSize?: number;
      failpoint?: PocImportFailpoint;
    } = {},
  ): Promise<PocImportResult> {
    validateEnvelope(envelope);
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("IndexedDB POC batch size must be a positive integer");
    }

    const digest = await canonicalEnvelopeDigest(envelope);
    const expectedCounts: PocStateCounts = {
      remoteNodes: Object.keys(envelope.remoteIndex.itemsById).length,
      anchors: Object.keys(envelope.anchors.byAnchorId).length,
      folderAnchors: Object.keys(
        envelope.folderAnchors?.byAnchorId ?? {},
      ).length,
      mutationLedger: 0,
    };
    const importingMeta: StoredStateMeta = {
      phase: "importing",
      header: envelopeHeader(envelope),
      sourceDigest: digest,
      digestCommitSeq: envelope.meta.commitSeq,
      expectedCounts,
    };
    const db = await this.open();
    const startTx = db.transaction(
      [
        "meta",
        "remoteNodes",
        "anchors",
        "folderAnchors",
        "mutationLedger",
      ],
      "readwrite",
      { durability: "strict" },
    );
    await Promise.all([
      startTx.objectStore("remoteNodes").clear(),
      startTx.objectStore("anchors").clear(),
      startTx.objectStore("folderAnchors").clear(),
      startTx.objectStore("mutationLedger").clear(),
      startTx.objectStore("meta").put(importingMeta, STATE_META_KEY),
      startTx.done,
    ]);
    if (options.failpoint?.stage === "after-start") {
      throw new Error("POC failpoint: after-start");
    }

    let batches = 0;
    let logicalWrites = 1;
    const remoteNodes = Object.values(envelope.remoteIndex.itemsById);
    batches += await putBatches(
      db,
      "remoteNodes",
      remoteNodes,
      (node) => node.id,
      batchSize,
      (batch) => {
        logicalWrites += Math.min(
          batchSize,
          remoteNodes.length - ((batch - 1) * batchSize),
        );
        if (
          options.failpoint?.stage === "after-remote-batch"
          && options.failpoint.batch === batch
        ) {
          throw new Error(`POC failpoint: after-remote-batch:${batch}`);
        }
      },
    );

    const anchors = Object.values(envelope.anchors.byAnchorId);
    batches += await putBatches(
      db,
      "anchors",
      anchors,
      (anchor) => anchor.anchorId,
      batchSize,
      (batch) => {
        logicalWrites += Math.min(
          batchSize,
          anchors.length - ((batch - 1) * batchSize),
        );
        if (
          options.failpoint?.stage === "after-anchor-batch"
          && options.failpoint.batch === batch
        ) {
          throw new Error(`POC failpoint: after-anchor-batch:${batch}`);
        }
      },
    );

    const folderAnchors = Object.values(
      envelope.folderAnchors?.byAnchorId ?? {},
    );
    batches += await putBatches(
      db,
      "folderAnchors",
      folderAnchors,
      (anchor) => anchor.anchorId,
      batchSize,
    );
    logicalWrites += folderAnchors.length;

    const storedCounts = await this.countRecords();
    assertCounts(expectedCounts, storedCounts);
    const reconstructed = await this.readEnvelope(importingMeta);
    const reconstructedDigest = await canonicalEnvelopeDigest(reconstructed);
    if (reconstructedDigest !== digest) {
      throw new Error(
        "IndexedDB POC staging digest does not match the source envelope",
      );
    }
    if (options.failpoint?.stage === "before-activation") {
      throw new Error("POC failpoint: before-activation");
    }

    const activationTx = db.transaction("meta", "readwrite", {
      durability: "strict",
    });
    await Promise.all([
      activationTx.store.put(
        {
          ...importingMeta,
          phase: "ready",
          activatedAt: Date.now(),
        },
        STATE_META_KEY,
      ),
      activationTx.done,
    ]);
    logicalWrites += 1;
    return { digest, counts: storedCounts, batches, logicalWrites };
  }

  async loadReadyEnvelope(): Promise<SyncStateEnvelopeV2> {
    const db = await this.open();
    const meta = await db.get("meta", STATE_META_KEY);
    if (!meta || meta.phase !== "ready") {
      throw new PocStateNotReadyError(meta?.phase ?? "missing");
    }
    const counts = await this.countRecords();
    assertCounts(meta.expectedCounts, counts);
    const envelope = await this.readEnvelope(meta);
    if (meta.digestCommitSeq === envelope.meta.commitSeq) {
      const digest = await canonicalEnvelopeDigest(envelope);
      if (digest !== meta.sourceDigest) {
        throw new Error(
          "IndexedDB POC ready-state digest does not match activation digest",
        );
      }
    }
    return envelope;
  }

  async inspect(): Promise<PocStateInspection> {
    const db = await this.open();
    const meta = await db.get("meta", STATE_META_KEY);
    return {
      phase: meta?.phase ?? "missing",
      activationDigest: meta?.sourceDigest ?? null,
      digestCommitSeq: meta?.digestCommitSeq ?? null,
      counts: await this.countRecords(),
      commitSeq: meta?.header.meta.commitSeq ?? null,
    };
  }

  async getMutation(
    operationId: string,
  ): Promise<MutationLedgerEntryV1 | undefined> {
    return (await this.open()).get("mutationLedger", operationId);
  }

  async beginMutationIntent(intent: MutationIntent): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(["meta", "mutationLedger"], "readwrite", {
      durability: "strict",
    });
    const meta = await tx.objectStore("meta").get(STATE_META_KEY);
    assertReadyScope(meta, intent.scope);
    const existing = await tx.objectStore("mutationLedger").get(
      intent.operationId,
    );
    if (existing) {
      throw new Error(`IndexedDB POC mutation already exists: ${
        intent.operationId
      }`);
    }
    const nextMeta: StoredStateMeta = {
      ...meta,
      expectedCounts: {
        ...meta.expectedCounts,
        mutationLedger: meta.expectedCounts.mutationLedger + 1,
      },
    };
    await Promise.all([
      tx.objectStore("mutationLedger").put(
        { intent, receipt: null },
        intent.operationId,
      ),
      tx.objectStore("meta").put(nextMeta, STATE_META_KEY),
      tx.done,
    ]);
  }

  async recordMutationReceipt(receipt: MutationReceiptV1): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(["meta", "mutationLedger"], "readwrite", {
      durability: "strict",
    });
    const meta = await tx.objectStore("meta").get(STATE_META_KEY);
    if (!meta || meta.phase !== "ready") {
      abortTransaction(tx);
      throw new PocStateNotReadyError(meta?.phase ?? "missing");
    }
    const existing = await tx.objectStore("mutationLedger").get(
      receipt.operationId,
    );
    if (!existing) {
      abortTransaction(tx);
      throw new Error(
        `IndexedDB POC mutation intent is missing: ${receipt.operationId}`,
      );
    }
    await Promise.all([
      tx.objectStore("mutationLedger").put(
        { intent: existing.intent, receipt },
        receipt.operationId,
      ),
      tx.done,
    ]);
  }

  async finalizeMutation(
    input: PocFinalizeInput,
  ): Promise<PocFinalizeResult> {
    const db = await this.open();
    const tx = db.transaction(
      ["meta", "remoteNodes", "anchors", "mutationLedger"],
      "readwrite",
      { durability: "strict" },
    );
    try {
      const meta = await tx.objectStore("meta").get(STATE_META_KEY);
      if (!meta || meta.phase !== "ready") {
        throw new PocStateNotReadyError(meta?.phase ?? "missing");
      }
      const ledger = await tx.objectStore("mutationLedger").get(
        input.operationId,
      );
      if (!ledger?.receipt) {
        throw new Error(
          `IndexedDB POC mutation receipt is missing: ${input.operationId}`,
        );
      }
      await tx.objectStore("remoteNodes").put(
        input.remoteNode,
        input.remoteNode.id,
      );
      if (input.failpoint === "after-remote-node") {
        throw new Error("POC failpoint: after-remote-node");
      }
      await tx.objectStore("anchors").put(
        input.anchor,
        input.anchor.anchorId,
      );
      if (input.failpoint === "after-anchor") {
        throw new Error("POC failpoint: after-anchor");
      }
      if (input.failpoint === "before-meta") {
        throw new Error("POC failpoint: before-meta");
      }
      const nextCommitSeq = meta.header.meta.commitSeq + 1;
      const nextMeta: StoredStateMeta = {
        ...meta,
        header: {
          ...meta.header,
          meta: {
            ...meta.header.meta,
            commitSeq: nextCommitSeq,
            committedAt: input.committedAt,
          },
        },
        expectedCounts: {
          ...meta.expectedCounts,
          mutationLedger: meta.expectedCounts.mutationLedger - 1,
        },
      };
      await tx.objectStore("mutationLedger").delete(input.operationId);
      await tx.objectStore("meta").put(nextMeta, STATE_META_KEY);
      await tx.done;
      if (input.failpoint === "after-commit-response-lost") {
        throw new Error("POC failpoint: after-commit-response-lost");
      }
      return { commitSeq: nextCommitSeq, logicalWrites: 4 };
    } catch (error) {
      abortTransaction(tx);
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  private async open(): Promise<IDBPDatabase<PocStateDb>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<PocStateDb>(
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
            db.createObjectStore("mutationLedger");
          },
          blocking: () => {
            void this.close();
          },
        },
      );
    }
    return this.dbPromise;
  }

  private async countRecords(): Promise<PocStateCounts> {
    const db = await this.open();
    const tx = db.transaction(
      ["remoteNodes", "anchors", "folderAnchors", "mutationLedger"],
      "readonly",
    );
    const [remoteNodes, anchors, folderAnchors, mutationLedger] =
      await Promise.all([
        tx.objectStore("remoteNodes").count(),
        tx.objectStore("anchors").count(),
        tx.objectStore("folderAnchors").count(),
        tx.objectStore("mutationLedger").count(),
        tx.done,
      ]);
    return { remoteNodes, anchors, folderAnchors, mutationLedger };
  }

  private async readEnvelope(
    meta: StoredStateMeta,
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
      meta: { ...meta.header.meta },
      scope: { ...meta.header.scope },
      remoteIndex: {
        ...meta.header.remoteIndex,
        itemsById: Object.fromEntries(
          remoteNodes
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((node) => [node.id, node]),
        ),
      },
      anchors: {
        schemaVersion: meta.header.anchorsSchemaVersion,
        byAnchorId: Object.fromEntries(
          anchors
            .sort((left, right) =>
              left.anchorId.localeCompare(right.anchorId))
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
                    left.anchorId.localeCompare(right.anchorId))
                  .map((anchor) => [anchor.anchorId, anchor]),
              ),
            },
          }
        : {}),
      ...(meta.header.remoteScopeRecovery
        ? { remoteScopeRecovery: meta.header.remoteScopeRecovery }
        : {}),
    };
    validateEnvelope(envelope);
    return envelope;
  }
}

export async function canonicalEnvelopeDigest(
  envelope: SyncStateEnvelopeV2,
): Promise<string> {
  const canonical = JSON.stringify(sortJsonValue(envelope));
  return sha256Hex(new TextEncoder().encode(canonical).buffer);
}

function envelopeHeader(
  envelope: SyncStateEnvelopeV2,
): StoredEnvelopeHeader {
  const { itemsById: _itemsById, ...remoteIndex } = envelope.remoteIndex;
  return {
    meta: { ...envelope.meta },
    scope: { ...envelope.scope },
    remoteIndex,
    anchorsSchemaVersion: envelope.anchors.schemaVersion,
    folderAnchorsPresent: envelope.folderAnchors !== undefined,
    ...(envelope.folderAnchors
      ? { folderAnchorsSchemaVersion: envelope.folderAnchors.schemaVersion }
      : {}),
    ...(envelope.remoteScopeRecovery
      ? { remoteScopeRecovery: envelope.remoteScopeRecovery }
      : {}),
  };
}

async function putBatches<
  StoreName extends "remoteNodes" | "anchors" | "folderAnchors",
  Value extends
    | RemoteNodeV2
    | SyncAnchorV2
    | FolderAnchorV2,
>(
  db: IDBPDatabase<PocStateDb>,
  storeName: StoreName,
  values: readonly Value[],
  keyOf: (value: Value) => string,
  batchSize: number,
  afterBatch?: (batch: number) => void,
): Promise<number> {
  let batches = 0;
  for (let offset = 0; offset < values.length; offset += batchSize) {
    const tx = db.transaction(storeName, "readwrite");
    const requests = values
      .slice(offset, offset + batchSize)
      .map((value) => tx.store.put(value, keyOf(value)));
    await Promise.all([...requests, tx.done]);
    batches += 1;
    afterBatch?.(batches);
  }
  return batches;
}

function assertReadyScope(
  meta: StoredStateMeta | undefined,
  scope: SyncScope,
): asserts meta is StoredStateMeta {
  if (!meta || meta.phase !== "ready") {
    throw new PocStateNotReadyError(meta?.phase ?? "missing");
  }
  if (!sameSyncScope(meta.header.scope, scope)) {
    throw new Error("IndexedDB POC mutation scope does not match state scope");
  }
}

function assertCounts(
  expected: PocStateCounts,
  actual: PocStateCounts,
): void {
  for (const key of Object.keys(expected) as Array<keyof PocStateCounts>) {
    if (expected[key] !== actual[key]) {
      throw new Error(
        `IndexedDB POC ${key} count mismatch: expected ${expected[key]}, `
        + `got ${actual[key]}`,
      );
    }
  }
}

function abortTransaction(transaction: { abort(): void }): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have aborted due to the triggering error.
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}
