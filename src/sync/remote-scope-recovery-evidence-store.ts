import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
} from "idb";
import { sha256Hex } from "../crypto";
import { isRecord } from "../obsidian-compat";
import { isIndexedDbVaultInstanceId } from "./indexeddb-vault-namespace";
import { isSyncScope, type SyncScope } from "./types";

const DATABASE_SCHEMA_VERSION = 1;
const DATABASE_NAME_PREFIX = "easy-sync:scope-recovery:";
const MAX_OPERATIONS = 3;
const OPERATION_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

export interface RemoteScopeRecoveryEvidenceOperationV1 {
  schemaVersion: 1;
  operationId: string;
  vaultInstanceId: string;
  sourceDatabaseId: string;
  sourceStateDigest: string;
  sourceCommitSeq: number;
  sourceLifecycleEpoch: number;
  sourceScope: SyncScope;
  observedScope: SyncScope;
  protocolBindingDigest: string;
  startedAt: number;
  updatedAt: number;
}

export type RemoteScopeRecoveryEvidenceOperationIdentityV1 = Omit<
  RemoteScopeRecoveryEvidenceOperationV1,
  "schemaVersion" | "operationId" | "startedAt" | "updatedAt"
>;

export type FirstSyncVerificationSourceCohortV2 =
  | { kind: "fresh" }
  | { kind: "public-1.1.3"; sourceStateDigest: string };

export interface FirstSyncVerificationEvidenceOperationV2 {
  schemaVersion: 2;
  operationKind: "first-sync-verification";
  operationId: string;
  vaultInstanceId: string;
  scope: SyncScope;
  protocolBindingDigest: string;
  sourceCohort: FirstSyncVerificationSourceCohortV2;
  startedAt: number;
  updatedAt: number;
}

export type FirstSyncVerificationEvidenceOperationIdentityV2 = Omit<
  FirstSyncVerificationEvidenceOperationV2,
  "schemaVersion" | "operationId" | "startedAt" | "updatedAt"
>;

type RemoteContentVerificationEvidenceOperation =
  | RemoteScopeRecoveryEvidenceOperationV1
  | FirstSyncVerificationEvidenceOperationV2;

export interface RemoteScopeRecoveryEvidenceReceiptV1 {
  schemaVersion: 1;
  operationId: string;
  remoteId: string;
  size: number;
  eTag: string;
  cTag?: string;
  sha256: string;
  verifiedAt: number;
}

export interface RemoteScopeRecoveryRemoteVersionV1 {
  remoteId: string;
  size: number;
  eTag: string;
  cTag?: string;
}

export interface RemoteScopeRecoveryEvidenceSummaryV1 {
  operationId: string;
  receipts: number;
  updatedAt: number;
}

interface RemoteScopeRecoveryEvidenceDb extends DBSchema {
  operations: {
    key: string;
    value: RemoteContentVerificationEvidenceOperation;
  };
  receipts: {
    key: [string, string];
    value: RemoteScopeRecoveryEvidenceReceiptV1;
    indexes: { "by-operation": string };
  };
}

export interface RemoteScopeRecoveryEvidenceStore {
  close(): Promise<void>;
  delete(): Promise<void>;
  begin(
    identity: RemoteScopeRecoveryEvidenceOperationIdentityV1,
    now?: number,
  ): Promise<RemoteScopeRecoveryEvidenceOperationV1>;
  beginFirstSyncVerification(
    identity: FirstSyncVerificationEvidenceOperationIdentityV2,
    now?: number,
  ): Promise<FirstSyncVerificationEvidenceOperationV2>;
  readValidReceipts(
    operationId: string,
    versions: readonly RemoteScopeRecoveryRemoteVersionV1[],
  ): Promise<{
    receiptsByRemoteId: ReadonlyMap<
      string,
      RemoteScopeRecoveryEvidenceReceiptV1
    >;
    invalidated: number;
  }>;
  putVerified(
    receipt: RemoteScopeRecoveryEvidenceReceiptV1,
  ): Promise<void>;
  summarize(operationId: string): Promise<RemoteScopeRecoveryEvidenceSummaryV1>;
  retire(operationId: string): Promise<void>;
  retireFirstSyncVerificationOperations(): Promise<number>;
}

export type RemoteScopeRecoveryEvidenceStoreFactory = (
  vaultInstanceId: string,
) => RemoteScopeRecoveryEvidenceStore;

/**
 * Disposable, non-authoritative per-file proof cache for one Vault instance.
 * Losing or rebuilding this database can only cause more GETs; it can never
 * select state authority or authorize a file mutation.
 */
export class IndexedDbRemoteScopeRecoveryEvidenceStore
implements RemoteScopeRecoveryEvidenceStore {
  readonly databaseName: string;
  private dbPromise:
    Promise<IDBPDatabase<RemoteScopeRecoveryEvidenceDb>> | null = null;

  constructor(readonly vaultInstanceId: string) {
    if (!isIndexedDbVaultInstanceId(vaultInstanceId)) {
      throw new Error("Remote scope recovery Vault identity is invalid");
    }
    this.databaseName = `${DATABASE_NAME_PREFIX}${vaultInstanceId}`;
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

  async begin(
    identity: RemoteScopeRecoveryEvidenceOperationIdentityV1,
    now = Date.now(),
  ): Promise<RemoteScopeRecoveryEvidenceOperationV1> {
    validateOperationIdentity(identity);
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("Remote scope recovery operation time is invalid");
    }
    const operationId = await remoteScopeRecoveryEvidenceOperationId(identity);
    const db = await this.open();
    const tx = db.transaction(["operations", "receipts"], "readwrite", {
      durability: "strict",
    });
    const current = await tx.objectStore("operations").get(operationId);
    const canReuse = current
      && isRemoteScopeRecoveryEvidenceOperationV1(current)
      && sameOperationIdentity(current, identity);
    if (current && !canReuse) {
      await this.deleteOperationInTransaction(tx, operationId);
    }
    const operation: RemoteScopeRecoveryEvidenceOperationV1 = canReuse
      ? { ...current, updatedAt: Math.max(now, current.updatedAt) }
      : {
          schemaVersion: 1,
          operationId,
          ...structuredClone(identity),
          startedAt: now,
          updatedAt: now,
        };
    await tx.objectStore("operations").put(operation);
    await this.pruneInTransaction(tx, operationId, now);
    await tx.done;

    const verified = await db.get("operations", operationId);
    if (
      !isRemoteScopeRecoveryEvidenceOperationV1(verified)
      || JSON.stringify(verified) !== JSON.stringify(operation)
    ) {
      throw new Error("Remote scope recovery evidence preflight read-back failed");
    }
    return structuredClone(operation);
  }

  async beginFirstSyncVerification(
    identity: FirstSyncVerificationEvidenceOperationIdentityV2,
    now = Date.now(),
  ): Promise<FirstSyncVerificationEvidenceOperationV2> {
    validateFirstSyncVerificationIdentity(identity);
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("First-sync verification operation time is invalid");
    }
    const operationId = await firstSyncVerificationEvidenceOperationId(
      identity,
    );
    const db = await this.open();
    const tx = db.transaction(["operations", "receipts"], "readwrite", {
      durability: "strict",
    });
    const current = await tx.objectStore("operations").get(operationId);
    const canReuse = current
      && isFirstSyncVerificationEvidenceOperationV2(current)
      && sameFirstSyncVerificationIdentity(current, identity);
    if (current && !canReuse) {
      await this.deleteOperationInTransaction(tx, operationId);
    }
    const operation: FirstSyncVerificationEvidenceOperationV2 = canReuse
      ? { ...current, updatedAt: Math.max(now, current.updatedAt) }
      : {
          schemaVersion: 2,
          operationKind: "first-sync-verification",
          operationId,
          vaultInstanceId: identity.vaultInstanceId,
          scope: structuredClone(identity.scope),
          protocolBindingDigest: identity.protocolBindingDigest,
          sourceCohort: structuredClone(identity.sourceCohort),
          startedAt: now,
          updatedAt: now,
        };
    await tx.objectStore("operations").put(operation);
    await this.pruneInTransaction(tx, operationId, now);
    await tx.done;

    const verified = await db.get("operations", operationId);
    if (
      !isFirstSyncVerificationEvidenceOperationV2(verified)
      || JSON.stringify(verified) !== JSON.stringify(operation)
    ) {
      throw new Error("First-sync verification evidence preflight read-back failed");
    }
    return structuredClone(operation);
  }

  async readValidReceipts(
    operationId: string,
    versions: readonly RemoteScopeRecoveryRemoteVersionV1[],
  ): Promise<{
    receiptsByRemoteId: ReadonlyMap<
      string,
      RemoteScopeRecoveryEvidenceReceiptV1
    >;
    invalidated: number;
  }> {
    if (!isSha256(operationId)) {
      throw new Error("Remote scope recovery operation ID is invalid");
    }
    const versionById = new Map<string, RemoteScopeRecoveryRemoteVersionV1>();
    for (const version of versions) {
      validateRemoteVersion(version);
      if (versionById.has(version.remoteId)) {
        throw new Error("Remote scope recovery versions contain a duplicate ID");
      }
      versionById.set(version.remoteId, version);
    }

    const db = await this.open();
    const operation = await db.get("operations", operationId);
    if (!isRemoteContentVerificationEvidenceOperation(operation)) {
      return { receiptsByRemoteId: new Map(), invalidated: 0 };
    }
    const tx = db.transaction("receipts", "readwrite", {
      durability: "strict",
    });
    const store = tx.objectStore("receipts");
    const existing = await store.index("by-operation").getAll(operationId);
    const valid = new Map<string, RemoteScopeRecoveryEvidenceReceiptV1>();
    let invalidated = 0;
    for (const raw of existing as unknown[]) {
      if (!isRemoteScopeRecoveryEvidenceReceiptV1(raw)) {
        invalidated++;
        if (
          isRecord(raw)
          && raw.operationId === operationId
          && typeof raw.remoteId === "string"
        ) {
          await store.delete([operationId, raw.remoteId]);
        }
        continue;
      }
      const version = versionById.get(raw.remoteId);
      if (!version || !receiptMatchesRemoteVersion(raw, version)) {
        invalidated++;
        await store.delete([operationId, raw.remoteId]);
        continue;
      }
      valid.set(raw.remoteId, structuredClone(raw));
    }
    await tx.done;
    return { receiptsByRemoteId: valid, invalidated };
  }

  async putVerified(
    receipt: RemoteScopeRecoveryEvidenceReceiptV1,
  ): Promise<void> {
    if (!isRemoteScopeRecoveryEvidenceReceiptV1(receipt)) {
      throw new Error("Remote scope recovery receipt is invalid");
    }
    const db = await this.open();
    const tx = db.transaction(["operations", "receipts"], "readwrite", {
      durability: "strict",
    });
    const operation = await tx.objectStore("operations").get(receipt.operationId);
    if (!isRemoteContentVerificationEvidenceOperation(operation)) {
      throw new Error("Remote scope recovery operation is unavailable");
    }
    await tx.objectStore("receipts").put(structuredClone(receipt));
    await tx.objectStore("operations").put({
      ...operation,
      updatedAt: Math.max(operation.updatedAt, receipt.verifiedAt),
    });
    await tx.done;
    const verified = await db.get(
      "receipts",
      [receipt.operationId, receipt.remoteId],
    );
    if (
      !isRemoteScopeRecoveryEvidenceReceiptV1(verified)
      || JSON.stringify(verified) !== JSON.stringify(receipt)
    ) {
      throw new Error("Remote scope recovery receipt read-back failed");
    }
  }

  async summarize(
    operationId: string,
  ): Promise<RemoteScopeRecoveryEvidenceSummaryV1> {
    if (!isSha256(operationId)) {
      throw new Error("Remote scope recovery operation ID is invalid");
    }
    const db = await this.open();
    const operation = await db.get("operations", operationId);
    if (!isRemoteContentVerificationEvidenceOperation(operation)) {
      return { operationId, receipts: 0, updatedAt: 0 };
    }
    const receipts = await db.countFromIndex(
      "receipts",
      "by-operation",
      operationId,
    );
    return { operationId, receipts, updatedAt: operation.updatedAt };
  }

  async retire(operationId: string): Promise<void> {
    if (!isSha256(operationId)) return;
    const db = await this.open();
    const tx = db.transaction(["operations", "receipts"], "readwrite", {
      durability: "strict",
    });
    await this.deleteOperationInTransaction(tx, operationId);
    await tx.done;
  }

  async retireFirstSyncVerificationOperations(): Promise<number> {
    const db = await this.open();
    const tx = db.transaction(["operations", "receipts"], "readwrite", {
      durability: "strict",
    });
    let retired = 0;
    let cursor = await tx.objectStore("operations").openCursor();
    while (cursor) {
      if (
        isRecord(cursor.value)
        && cursor.value.operationKind === "first-sync-verification"
      ) {
        await this.deleteOperationInTransaction(
          tx,
          String(cursor.primaryKey),
        );
        retired++;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return retired;
  }

  private open(): Promise<IDBPDatabase<RemoteScopeRecoveryEvidenceDb>> {
    if (!this.dbPromise) {
      this.dbPromise = this.openValidatedDatabase().catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  private async openValidatedDatabase():
  Promise<IDBPDatabase<RemoteScopeRecoveryEvidenceDb>> {
    let db: IDBPDatabase<RemoteScopeRecoveryEvidenceDb>;
    try {
      db = await this.openDatabaseAtCurrentVersion();
    } catch (error) {
      if (!isRecord(error) || error.name !== "VersionError") {
        throw error;
      }
      await deleteDB(this.databaseName);
      db = await this.openDatabaseAtCurrentVersion();
    }
    const hasStores = db.objectStoreNames.contains("operations")
      && db.objectStoreNames.contains("receipts");
    let hasReceiptIndex = false;
    if (hasStores) {
      const tx = db.transaction("receipts", "readonly");
      hasReceiptIndex = tx.store.indexNames.contains("by-operation");
      await tx.done;
    }
    if (hasStores && hasReceiptIndex) return db;

    db.close();
    await deleteDB(this.databaseName);
    return this.openDatabaseAtCurrentVersion();
  }

  private openDatabaseAtCurrentVersion():
  Promise<IDBPDatabase<RemoteScopeRecoveryEvidenceDb>> {
    return openDB<RemoteScopeRecoveryEvidenceDb>(
      this.databaseName,
      DATABASE_SCHEMA_VERSION,
      {
        upgrade(db) {
          if (!db.objectStoreNames.contains("operations")) {
            db.createObjectStore("operations", { keyPath: "operationId" });
          }
          if (!db.objectStoreNames.contains("receipts")) {
            const receipts = db.createObjectStore("receipts", {
              keyPath: ["operationId", "remoteId"],
            });
            receipts.createIndex("by-operation", "operationId");
          }
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

  private async pruneInTransaction(
    tx: IDBPTransaction<
      RemoteScopeRecoveryEvidenceDb,
      ["operations", "receipts"],
      "readwrite"
    >,
    keepOperationId: string,
    now: number,
  ): Promise<void> {
    const operations = (await tx.objectStore("operations").getAll())
      .filter(isRemoteContentVerificationEvidenceOperation)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const retainedOtherIds = new Set(
      operations
        .filter((operation) =>
          operation.operationId !== keepOperationId
          && now - operation.updatedAt <= OPERATION_TTL_MS)
        .slice(0, MAX_OPERATIONS - 1)
        .map((operation) => operation.operationId),
    );
    for (const operation of operations) {
      if (
        operation.operationId !== keepOperationId
        && !retainedOtherIds.has(operation.operationId)
      ) {
        await this.deleteOperationInTransaction(tx, operation.operationId);
      }
    }
  }

  private async deleteOperationInTransaction(
    tx: IDBPTransaction<
      RemoteScopeRecoveryEvidenceDb,
      ["operations", "receipts"],
      "readwrite"
    >,
    operationId: string,
  ): Promise<void> {
    const receiptStore = tx.objectStore("receipts");
    let cursor = await receiptStore.index("by-operation").openKeyCursor(
      operationId,
    );
    while (cursor) {
      await receiptStore.delete(cursor.primaryKey);
      cursor = await cursor.continue();
    }
    await tx.objectStore("operations").delete(operationId);
  }
}

export async function remoteScopeRecoveryEvidenceOperationId(
  identity: RemoteScopeRecoveryEvidenceOperationIdentityV1,
): Promise<string> {
  validateOperationIdentity(identity);
  return sha256Text(JSON.stringify({ schemaVersion: 1, ...identity }));
}

export async function firstSyncVerificationEvidenceOperationId(
  identity: FirstSyncVerificationEvidenceOperationIdentityV2,
): Promise<string> {
  validateFirstSyncVerificationIdentity(identity);
  return sha256Text(JSON.stringify(firstSyncVerificationIdentityPayload(
    identity,
  )));
}

export async function remoteScopeRecoveryProtocolBindingDigest(
  binding: unknown,
): Promise<string> {
  return sha256Text(JSON.stringify(binding));
}

function validateOperationIdentity(
  value: RemoteScopeRecoveryEvidenceOperationIdentityV1,
): void {
  if (
    !isIndexedDbVaultInstanceId(value.vaultInstanceId)
    || typeof value.sourceDatabaseId !== "string"
    || value.sourceDatabaseId.length === 0
    || !isSha256(value.sourceStateDigest)
    || !Number.isSafeInteger(value.sourceCommitSeq)
    || value.sourceCommitSeq < 1
    || !Number.isSafeInteger(value.sourceLifecycleEpoch)
    || value.sourceLifecycleEpoch < 0
    || !isSyncScope(value.sourceScope)
    || !isSyncScope(value.observedScope)
    || !isSha256(value.protocolBindingDigest)
  ) {
    throw new Error("Remote scope recovery operation identity is invalid");
  }
}

function isRemoteScopeRecoveryEvidenceOperationV1(
  value: unknown,
): value is RemoteScopeRecoveryEvidenceOperationV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "operationId",
    "vaultInstanceId",
    "sourceDatabaseId",
    "sourceStateDigest",
    "sourceCommitSeq",
    "sourceLifecycleEpoch",
    "sourceScope",
    "observedScope",
    "protocolBindingDigest",
    "startedAt",
    "updatedAt",
  ])) return false;
  try {
    validateOperationIdentity(value as unknown as RemoteScopeRecoveryEvidenceOperationIdentityV1);
  } catch {
    return false;
  }
  return value.schemaVersion === 1
    && isSha256(value.operationId)
    && Number.isFinite(value.startedAt)
    && Number(value.startedAt) >= 0
    && Number.isFinite(value.updatedAt)
    && Number(value.updatedAt) >= Number(value.startedAt);
}

function validateFirstSyncVerificationIdentity(
  value: FirstSyncVerificationEvidenceOperationIdentityV2,
): void {
  if (
    value.operationKind !== "first-sync-verification"
    || !isIndexedDbVaultInstanceId(value.vaultInstanceId)
    || !isSyncScope(value.scope)
    || !isSha256(value.protocolBindingDigest)
    || !isFirstSyncVerificationSourceCohortV2(value.sourceCohort)
  ) {
    throw new Error("First-sync verification operation identity is invalid");
  }
}

function isFirstSyncVerificationSourceCohortV2(
  value: unknown,
): value is FirstSyncVerificationSourceCohortV2 {
  if (!isRecord(value)) return false;
  if (value.kind === "fresh") {
    return hasExactKeys(value, ["kind"]);
  }
  return value.kind === "public-1.1.3"
    && hasExactKeys(value, ["kind", "sourceStateDigest"])
    && isSha256(value.sourceStateDigest);
}

function isFirstSyncVerificationEvidenceOperationV2(
  value: unknown,
): value is FirstSyncVerificationEvidenceOperationV2 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "operationKind",
    "operationId",
    "vaultInstanceId",
    "scope",
    "protocolBindingDigest",
    "sourceCohort",
    "startedAt",
    "updatedAt",
  ])) return false;
  try {
    validateFirstSyncVerificationIdentity(
      value as unknown as FirstSyncVerificationEvidenceOperationIdentityV2,
    );
  } catch {
    return false;
  }
  return value.schemaVersion === 2
    && isSha256(value.operationId)
    && Number.isFinite(value.startedAt)
    && Number(value.startedAt) >= 0
    && Number.isFinite(value.updatedAt)
    && Number(value.updatedAt) >= Number(value.startedAt);
}

function isRemoteContentVerificationEvidenceOperation(
  value: unknown,
): value is RemoteContentVerificationEvidenceOperation {
  return isRemoteScopeRecoveryEvidenceOperationV1(value)
    || isFirstSyncVerificationEvidenceOperationV2(value);
}

function isRemoteScopeRecoveryEvidenceReceiptV1(
  value: unknown,
): value is RemoteScopeRecoveryEvidenceReceiptV1 {
  return isRecord(value)
    && hasExactKeys(value, [
      "schemaVersion",
      "operationId",
      "remoteId",
      "size",
      "eTag",
      ...(value.cTag === undefined ? [] : ["cTag"]),
      "sha256",
      "verifiedAt",
    ])
    && value.schemaVersion === 1
    && isSha256(value.operationId)
    && typeof value.remoteId === "string"
    && value.remoteId.length > 0
    && Number.isSafeInteger(value.size)
    && Number(value.size) >= 0
    && typeof value.eTag === "string"
    && value.eTag.length > 0
    && (
      value.cTag === undefined
      || (typeof value.cTag === "string" && value.cTag.length > 0)
    )
    && isSha256(value.sha256)
    && Number.isFinite(value.verifiedAt)
    && Number(value.verifiedAt) >= 0;
}

function validateRemoteVersion(
  value: RemoteScopeRecoveryRemoteVersionV1,
): void {
  if (
    typeof value.remoteId !== "string"
    || value.remoteId.length === 0
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || typeof value.eTag !== "string"
    || value.eTag.length === 0
    || (
      value.cTag !== undefined
      && (typeof value.cTag !== "string" || value.cTag.length === 0)
    )
  ) {
    throw new Error("Remote scope recovery remote version is invalid");
  }
}

function receiptMatchesRemoteVersion(
  receipt: RemoteScopeRecoveryEvidenceReceiptV1,
  version: RemoteScopeRecoveryRemoteVersionV1,
): boolean {
  if (receipt.remoteId !== version.remoteId || receipt.size !== version.size) {
    return false;
  }
  return receipt.cTag && version.cTag
    ? receipt.cTag === version.cTag
    : receipt.eTag === version.eTag;
}

function sameOperationIdentity(
  operation: RemoteScopeRecoveryEvidenceOperationV1,
  identity: RemoteScopeRecoveryEvidenceOperationIdentityV1,
): boolean {
  const {
    schemaVersion: _schemaVersion,
    operationId: _operationId,
    startedAt: _startedAt,
    updatedAt: _updatedAt,
    ...currentIdentity
  } = operation;
  return JSON.stringify(currentIdentity) === JSON.stringify(identity);
}

function sameFirstSyncVerificationIdentity(
  operation: FirstSyncVerificationEvidenceOperationV2,
  identity: FirstSyncVerificationEvidenceOperationIdentityV2,
): boolean {
  return JSON.stringify(firstSyncVerificationIdentityPayload(operation))
    === JSON.stringify(firstSyncVerificationIdentityPayload(identity));
}

function firstSyncVerificationIdentityPayload(
  identity: FirstSyncVerificationEvidenceOperationIdentityV2,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    operationKind: "first-sync-verification",
    vaultInstanceId: identity.vaultInstanceId,
    scope: {
      accountId: identity.scope.accountId,
      driveId: identity.scope.driveId,
      vaultFolderId: identity.scope.vaultFolderId,
      filesRootId: identity.scope.filesRootId,
    },
    protocolBindingDigest: identity.protocolBindingDigest,
    sourceCohort: identity.sourceCohort.kind === "fresh"
      ? { kind: "fresh" }
      : {
          kind: "public-1.1.3",
          sourceStateDigest: identity.sourceCohort.sourceStateDigest,
        },
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256Text(content: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(content).buffer);
}
