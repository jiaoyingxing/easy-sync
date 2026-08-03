import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from "idb";
import { sha256Hex } from "../crypto";
import { isIndexedDbVaultInstanceId } from "./indexeddb-vault-namespace";
import {
  createCanonicalPlannerStateV2,
  type CanonicalPlannerStateV2,
} from "./canonical-planner-state-v2";
import type { RemoteNodeV2 } from "./remote-index-v2";
import {
  validateEnvelope,
  type FolderAnchorV2,
  type SyncAnchorV2,
  type SyncStateEnvelopeV2,
} from "./state-envelope-v2";
import type { SyncScope } from "./types";

const DATABASE_SCHEMA_VERSION = 1;
const STATE_META_KEY = "state";
const DEFAULT_IMPORT_BATCH_SIZE = 1_000;
const DATABASE_NAME_PREFIX = "easy-sync:v2:public-1.1.3:";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

type ImportPhase = "importing" | "prepared";

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
  schemaVersion: 1;
  kind: "public-1.1.3-indexeddb-candidate";
  phase: ImportPhase;
  authority: "inactive";
  sourceBinding: {
    kind: "public-1.1.3";
    sourceStateDigest: string;
  };
  candidateDigest: string;
  plannerRowsDigest: string;
  digestCommitSeq: number;
  expectedCounts: IndexedDbPublic113StateCounts;
  header: StoredEnvelopeHeader;
  preparedAt?: number;
}

interface Public113StateDb extends DBSchema {
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
}

export interface IndexedDbPublic113StateCounts {
  remoteNodes: number;
  anchors: number;
  folderAnchors: number;
}

export interface IndexedDbPublic113StageResult {
  reused: boolean;
  candidateDigest: string;
  counts: IndexedDbPublic113StateCounts;
  batches: number;
}

export interface IndexedDbPublic113StateInspection {
  phase: ImportPhase | "missing";
  authority: "inactive" | null;
  sourceStateDigest: string | null;
  candidateDigest: string | null;
  digestCommitSeq: number | null;
  counts: IndexedDbPublic113StateCounts;
}

export interface IndexedDbPublic113PlannerView {
  sourceStateDigest: string;
  candidateDigest: string;
  counts: IndexedDbPublic113StateCounts;
  state: CanonicalPlannerStateV2;
}

export interface Public113IndexedDbCandidateStore {
  stageCandidate(
    candidate: SyncStateEnvelopeV2,
    options: {
      sourceStateDigest: string;
      now?: number;
      batchSize?: number;
      signal?: AbortSignal;
    },
  ): Promise<IndexedDbPublic113StageResult>;
  loadPreparedPlannerView?(
    expectedSourceStateDigest: string,
  ): Promise<IndexedDbPublic113PlannerView>;
  close(): Promise<void>;
  delete(): Promise<void>;
}

export type Public113IndexedDbCandidateStoreFactory = (
  sourceStateDigest: string,
) => Public113IndexedDbCandidateStore;

export class IndexedDbPublic113StateNotPreparedError extends Error {
  constructor(readonly phase: ImportPhase | "missing") {
    super(`Public 1.1.3 IndexedDB candidate is not prepared: ${phase}`);
    this.name = "IndexedDbPublic113StateNotPreparedError";
  }
}

/**
 * Production storage for the inactive IndexedDB copy prepared during the
 * public 1.1.3 migration. This store is deliberately not a V2 authority:
 * StateManager continues to publish and load the JSON envelope.
 */
export class IndexedDbPublic113StateStore
implements Public113IndexedDbCandidateStore {
  private dbPromise: Promise<IDBPDatabase<Public113StateDb>> | null = null;

  constructor(readonly databaseName: string) {
    if (!databaseName) {
      throw new Error("Public 1.1.3 IndexedDB database name is required");
    }
  }

  async close(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (pending) (await pending).close();
  }

  async delete(): Promise<void> {
    await this.close();
    await deleteDB(this.databaseName);
  }

  async stageCandidate(
    candidate: SyncStateEnvelopeV2,
    options: {
      sourceStateDigest: string;
      now?: number;
      batchSize?: number;
      signal?: AbortSignal;
    },
  ): Promise<IndexedDbPublic113StageResult> {
    const normalizedCandidate = normalizeCandidate(candidate);
    assertSha256Hex(
      options.sourceStateDigest,
      "public 1.1.3 source-state digest",
    );
    const batchSize = options.batchSize ?? DEFAULT_IMPORT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        "Public 1.1.3 IndexedDB batch size must be a positive integer",
      );
    }
    const candidateDigest = await canonicalIndexedDbCandidateDigest(
      normalizedCandidate,
    );
    const plannerRowsDigest = await canonicalPlannerRowsDigest(
      envelopeHeader(normalizedCandidate),
      Object.values(normalizedCandidate.remoteIndex.itemsById),
      Object.values(normalizedCandidate.anchors.byAnchorId),
      Object.values(normalizedCandidate.folderAnchors?.byAnchorId ?? {}),
    );
    const expectedCounts = envelopeCounts(normalizedCandidate);
    const existing = await this.readMeta();
    if (
      existing?.phase === "prepared"
      && existing.authority === "inactive"
      && existing.sourceBinding.sourceStateDigest
        === options.sourceStateDigest
      && existing.candidateDigest === candidateDigest
      && typeof existing.plannerRowsDigest === "string"
      && existing.plannerRowsDigest === plannerRowsDigest
      && sameCounts(existing.expectedCounts, expectedCounts)
    ) {
      try {
        await this.loadPreparedPlannerView(options.sourceStateDigest);
        return {
          reused: true,
          candidateDigest,
          counts: expectedCounts,
          batches: 0,
        };
      } catch {
        // The artifact is inactive and source-bound, so a failed verification
        // is safely repaired by replacing the complete staged copy below.
      }
    }

    const importingMeta: StoredStateMeta = {
      schemaVersion: 1,
      kind: "public-1.1.3-indexeddb-candidate",
      phase: "importing",
      authority: "inactive",
      sourceBinding: {
        kind: "public-1.1.3",
        sourceStateDigest: options.sourceStateDigest,
      },
      candidateDigest,
      plannerRowsDigest,
      digestCommitSeq: normalizedCandidate.meta.commitSeq,
      expectedCounts,
      header: envelopeHeader(normalizedCandidate),
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
      startTx.objectStore("meta").put(importingMeta, STATE_META_KEY),
      startTx.done,
    ]);
    throwIfAborted(options.signal);

    let batches = 0;
    batches += await putBatches(
      db,
      "remoteNodes",
      Object.values(normalizedCandidate.remoteIndex.itemsById),
      (node) => node.id,
      batchSize,
      options.signal,
    );
    batches += await putBatches(
      db,
      "anchors",
      Object.values(normalizedCandidate.anchors.byAnchorId),
      (anchor) => anchor.anchorId,
      batchSize,
      options.signal,
    );
    batches += await putBatches(
      db,
      "folderAnchors",
      Object.values(
        normalizedCandidate.folderAnchors?.byAnchorId ?? {},
      ),
      (anchor) => anchor.anchorId,
      batchSize,
      options.signal,
    );

    const storedCounts = await this.countRecords();
    assertCounts(expectedCounts, storedCounts);
    const reconstructed = await this.readEnvelope(importingMeta);
    const reconstructedDigest = await canonicalIndexedDbCandidateDigest(
      reconstructed,
    );
    if (reconstructedDigest !== candidateDigest) {
      throw new Error(
        "Public 1.1.3 IndexedDB candidate digest does not match its source",
      );
    }
    throwIfAborted(options.signal);

    const activationTx = db.transaction("meta", "readwrite", {
      durability: "strict",
    });
    await Promise.all([
      activationTx.store.put(
        {
          ...importingMeta,
          phase: "prepared",
          preparedAt: options.now ?? Date.now(),
        },
        STATE_META_KEY,
      ),
      activationTx.done,
    ]);
    return {
      reused: false,
      candidateDigest,
      counts: storedCounts,
      batches,
    };
  }

  async loadPreparedCandidate(
    expectedSourceStateDigest?: string,
  ): Promise<SyncStateEnvelopeV2> {
    if (expectedSourceStateDigest !== undefined) {
      assertSha256Hex(
        expectedSourceStateDigest,
        "expected public 1.1.3 source-state digest",
      );
    }
    const meta = await this.readMeta();
    if (!meta || meta.phase !== "prepared") {
      throw new IndexedDbPublic113StateNotPreparedError(
        meta?.phase ?? "missing",
      );
    }
    if (
      expectedSourceStateDigest !== undefined
      && meta.sourceBinding.sourceStateDigest
        !== expectedSourceStateDigest
    ) {
      throw new Error(
        "Public 1.1.3 IndexedDB candidate source binding does not match",
      );
    }
    const counts = await this.countRecords();
    assertCounts(meta.expectedCounts, counts);
    const candidate = await this.readEnvelope(meta);
    const digest = await canonicalIndexedDbCandidateDigest(candidate);
    if (
      meta.digestCommitSeq !== candidate.meta.commitSeq
      || digest !== meta.candidateDigest
    ) {
      throw new Error(
        "Public 1.1.3 IndexedDB prepared candidate digest does not match",
      );
    }
    return candidate;
  }

  async loadPreparedPlannerView(
    expectedSourceStateDigest: string,
  ): Promise<IndexedDbPublic113PlannerView> {
    assertSha256Hex(
      expectedSourceStateDigest,
      "expected public 1.1.3 source-state digest",
    );
    const meta = await this.readMeta();
    if (!meta || meta.phase !== "prepared") {
      throw new IndexedDbPublic113StateNotPreparedError(
        meta?.phase ?? "missing",
      );
    }
    if (
      meta.sourceBinding.sourceStateDigest !== expectedSourceStateDigest
    ) {
      throw new Error(
        "Public 1.1.3 IndexedDB planner view source binding does not match",
      );
    }
    if (typeof meta.plannerRowsDigest !== "string") {
      throw new Error(
        "Public 1.1.3 IndexedDB planner view integrity digest is missing",
      );
    }
    const counts = await this.countRecords();
    assertCounts(meta.expectedCounts, counts);
    const rows = await this.readPlannerRows();
    const rowsDigest = await canonicalPlannerRowsDigest(
      meta.header,
      rows.remoteNodes,
      rows.anchors,
      rows.folderAnchors,
    );
    if (rowsDigest !== meta.plannerRowsDigest) {
      throw new Error(
        "Public 1.1.3 IndexedDB planner view rows do not match",
      );
    }
    const state = createCanonicalPlannerStateV2({
      meta: structuredClone(meta.header.meta),
      scope: structuredClone(meta.header.scope),
      remoteIndex: structuredClone(meta.header.remoteIndex),
      remoteNodes: rows.remoteNodes,
      fileAnchors: rows.anchors,
      folderAnchors: meta.header.folderAnchorsPresent
        ? rows.folderAnchors
        : null,
    });
    if (state.meta.commitSeq !== meta.digestCommitSeq) {
      throw new Error(
        "Public 1.1.3 IndexedDB planner view revision does not match",
      );
    }
    return {
      sourceStateDigest: expectedSourceStateDigest,
      candidateDigest: meta.candidateDigest,
      counts,
      state,
    };
  }

  async inspect(): Promise<IndexedDbPublic113StateInspection> {
    const meta = await this.readMeta();
    return {
      phase: meta?.phase ?? "missing",
      authority: meta?.authority ?? null,
      sourceStateDigest:
        meta?.sourceBinding.sourceStateDigest ?? null,
      candidateDigest: meta?.candidateDigest ?? null,
      digestCommitSeq: meta?.digestCommitSeq ?? null,
      counts: await this.countRecords(),
    };
  }

  private async open(): Promise<IDBPDatabase<Public113StateDb>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<Public113StateDb>(
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

  private async readMeta(): Promise<StoredStateMeta | undefined> {
    return (await this.open()).get("meta", STATE_META_KEY);
  }

  private async countRecords(): Promise<IndexedDbPublic113StateCounts> {
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
    meta: StoredStateMeta,
  ): Promise<SyncStateEnvelopeV2> {
    const { remoteNodes, anchors, folderAnchors } =
      await this.readPlannerRows();
    const candidate: SyncStateEnvelopeV2 = {
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
    };
    validateEnvelope(candidate);
    return candidate;
  }

  private async readPlannerRows(): Promise<{
    remoteNodes: RemoteNodeV2[];
    anchors: SyncAnchorV2[];
    folderAnchors: FolderAnchorV2[];
  }> {
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
    return { remoteNodes, anchors, folderAnchors };
  }
}

export function public113IndexedDbDatabaseName(
  vaultInstanceId: string,
  sourceStateDigest: string,
): string {
  if (!isIndexedDbVaultInstanceId(vaultInstanceId)) {
    throw new Error(
      "Public 1.1.3 IndexedDB Vault instance ID must be 32 lowercase hex characters",
    );
  }
  assertSha256Hex(sourceStateDigest, "public 1.1.3 source-state digest");
  return `${DATABASE_NAME_PREFIX}${vaultInstanceId}:${sourceStateDigest}`;
}

export async function canonicalIndexedDbCandidateDigest(
  candidate: SyncStateEnvelopeV2,
): Promise<string> {
  const canonical = JSON.stringify(normalizeCandidate(candidate));
  return sha256Hex(new TextEncoder().encode(canonical).buffer);
}

async function canonicalPlannerRowsDigest(
  header: StoredEnvelopeHeader,
  remoteNodes: readonly RemoteNodeV2[],
  anchors: readonly SyncAnchorV2[],
  folderAnchors: readonly FolderAnchorV2[],
): Promise<string> {
  const canonical = JSON.stringify(sortJsonValue({
    header,
    remoteNodes: [...remoteNodes]
      .sort((left, right) => compareText(left.id, right.id)),
    anchors: [...anchors]
      .sort((left, right) => compareText(left.anchorId, right.anchorId)),
    folderAnchors: [...folderAnchors]
      .sort((left, right) => compareText(left.anchorId, right.anchorId)),
  }));
  return sha256Hex(new TextEncoder().encode(canonical).buffer);
}

function normalizeCandidate(
  candidate: SyncStateEnvelopeV2,
): SyncStateEnvelopeV2 {
  validateEnvelope(candidate);
  const normalized = sortJsonValue(candidate);
  validateEnvelope(normalized);
  return normalized;
}

function envelopeHeader(
  candidate: SyncStateEnvelopeV2,
): StoredEnvelopeHeader {
  const { itemsById: _itemsById, ...remoteIndex } =
    candidate.remoteIndex;
  return {
    meta: structuredClone(candidate.meta),
    scope: structuredClone(candidate.scope),
    remoteIndex: structuredClone(remoteIndex),
    anchorsSchemaVersion: candidate.anchors.schemaVersion,
    folderAnchorsPresent: candidate.folderAnchors !== undefined,
    ...(candidate.folderAnchors
      ? {
          folderAnchorsSchemaVersion:
            candidate.folderAnchors.schemaVersion,
        }
      : {}),
    ...(candidate.remoteScopeRecovery
      ? {
          remoteScopeRecovery: structuredClone(
            candidate.remoteScopeRecovery,
          ),
        }
      : {}),
  };
}

function envelopeCounts(
  candidate: SyncStateEnvelopeV2,
): IndexedDbPublic113StateCounts {
  return {
    remoteNodes: Object.keys(candidate.remoteIndex.itemsById).length,
    anchors: Object.keys(candidate.anchors.byAnchorId).length,
    folderAnchors: Object.keys(
      candidate.folderAnchors?.byAnchorId ?? {},
    ).length,
  };
}

async function putBatches<
  StoreName extends "remoteNodes" | "anchors" | "folderAnchors",
  Value extends RemoteNodeV2 | SyncAnchorV2 | FolderAnchorV2,
>(
  db: IDBPDatabase<Public113StateDb>,
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

function assertCounts(
  expected: IndexedDbPublic113StateCounts,
  actual: IndexedDbPublic113StateCounts,
): void {
  for (
    const key of Object.keys(expected) as
      Array<keyof IndexedDbPublic113StateCounts>
  ) {
    if (expected[key] !== actual[key]) {
      throw new Error(
        `Public 1.1.3 IndexedDB ${key} count mismatch: `
        + `expected ${expected[key]}, got ${actual[key]}`,
      );
    }
  }
}

function sameCounts(
  left: IndexedDbPublic113StateCounts,
  right: IndexedDbPublic113StateCounts,
): boolean {
  return left.remoteNodes === right.remoteNodes
    && left.anchors === right.anchors
    && left.folderAnchors === right.folderAnchors;
}

function assertSha256Hex(value: string, label: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("IndexedDB candidate staging aborted", "AbortError");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
