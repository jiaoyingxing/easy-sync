import "fake-indexeddb/auto";

import { forceCloseDatabase } from "fake-indexeddb";
import { openDB, unwrap } from "idb";
import { describe, expect, it } from "vitest";
import {
  firstSyncVerificationEvidenceOperationId,
  IndexedDbRemoteScopeRecoveryEvidenceStore,
  type FirstSyncVerificationEvidenceOperationIdentityV2,
  type RemoteScopeRecoveryEvidenceOperationIdentityV1,
} from "../src/sync/remote-scope-recovery-evidence-store";

function identity(
  vaultInstanceId: string,
  patch: Partial<RemoteScopeRecoveryEvidenceOperationIdentityV1> = {},
): RemoteScopeRecoveryEvidenceOperationIdentityV1 {
  return {
    vaultInstanceId,
    sourceDatabaseId: "database-a",
    sourceStateDigest: "a".repeat(64),
    sourceCommitSeq: 5,
    sourceLifecycleEpoch: 2,
    sourceScope: {
      accountId: "account",
      driveId: "drive-old",
      vaultFolderId: "vault-old",
      filesRootId: "root-old",
    },
    observedScope: {
      accountId: "account",
      driveId: "drive-new",
      vaultFolderId: "vault-new",
      filesRootId: "root-new",
    },
    protocolBindingDigest: "b".repeat(64),
    ...patch,
  };
}

function firstSyncIdentity(
  vaultInstanceId: string,
  patch: Partial<FirstSyncVerificationEvidenceOperationIdentityV2> = {},
): FirstSyncVerificationEvidenceOperationIdentityV2 {
  return {
    operationKind: "first-sync-verification",
    vaultInstanceId,
    scope: {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "root",
    },
    protocolBindingDigest: "e".repeat(64),
    sourceCohort: {
      kind: "public-1.1.3",
      sourceStateDigest: "f".repeat(64),
    },
    ...patch,
  };
}

describe("remote scope recovery evidence store", () => {
  it("persists exact receipts across a close and reuses only matching versions", async () => {
    const vaultInstanceId = "1".repeat(32);
    const first = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const operation = await first.begin(identity(vaultInstanceId), 100);
      await first.putVerified({
        schemaVersion: 1,
        operationId: operation.operationId,
        remoteId: "remote-a",
        size: 10,
        eTag: "etag-a",
        cTag: "ctag-a",
        sha256: "c".repeat(64),
        verifiedAt: 110,
      });
      await first.close();

      const restarted = new IndexedDbRemoteScopeRecoveryEvidenceStore(
        vaultInstanceId,
      );
      const sameOperation = await restarted.begin(identity(vaultInstanceId), 120);
      expect(sameOperation.operationId).toBe(operation.operationId);
      const reused = await restarted.readValidReceipts(
        operation.operationId,
        [{
          remoteId: "remote-a",
          size: 10,
          eTag: "etag-changed-but-ctag-stable",
          cTag: "ctag-a",
        }],
      );
      expect(reused.invalidated).toBe(0);
      expect(reused.receiptsByRemoteId.get("remote-a")?.sha256)
        .toBe("c".repeat(64));
      await restarted.close();
    } finally {
      await first.delete();
    }
  });

  it("keeps the public V1 recovery operation readable beside a V2 first-sync operation", async () => {
    const vaultInstanceId = "9".repeat(32);
    const first = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const recovery = await first.begin(identity(vaultInstanceId), 100);
      const verification = await first.beginFirstSyncVerification(
        firstSyncIdentity(vaultInstanceId),
        110,
      );
      expect(recovery.schemaVersion).toBe(1);
      expect(verification).toMatchObject({
        schemaVersion: 2,
        operationKind: "first-sync-verification",
      });
      expect(verification.operationId).not.toBe(recovery.operationId);
      await first.putVerified({
        schemaVersion: 1,
        operationId: recovery.operationId,
        remoteId: "recovery-file",
        size: 10,
        eTag: "recovery-etag",
        sha256: "a".repeat(64),
        verifiedAt: 120,
      });
      await first.putVerified({
        schemaVersion: 1,
        operationId: verification.operationId,
        remoteId: "first-sync-file",
        size: 20,
        eTag: "first-sync-etag",
        sha256: "b".repeat(64),
        verifiedAt: 130,
      });
      await first.close();

      const restarted = new IndexedDbRemoteScopeRecoveryEvidenceStore(
        vaultInstanceId,
      );
      const sameRecovery = await restarted.begin(identity(vaultInstanceId), 140);
      const sameVerification = await restarted.beginFirstSyncVerification(
        firstSyncIdentity(vaultInstanceId),
        150,
      );
      expect(sameRecovery.operationId).toBe(recovery.operationId);
      expect(sameVerification.operationId).toBe(verification.operationId);
      await expect(restarted.summarize(recovery.operationId)).resolves
        .toMatchObject({ receipts: 1 });
      await expect(restarted.summarize(verification.operationId)).resolves
        .toMatchObject({ receipts: 1 });
      await restarted.close();
    } finally {
      await first.delete();
    }
  });

  it("isolates first-sync receipts by scope, protocol binding, and source cohort", async () => {
    const vaultInstanceId = "a".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const original = await store.beginFirstSyncVerification(
        firstSyncIdentity(vaultInstanceId),
        100,
      );
      const sourceIdentity = firstSyncIdentity(vaultInstanceId);
      const reorderedIdentity: FirstSyncVerificationEvidenceOperationIdentityV2 = {
        sourceCohort: structuredClone(sourceIdentity.sourceCohort),
        protocolBindingDigest: sourceIdentity.protocolBindingDigest,
        scope: {
          filesRootId: sourceIdentity.scope.filesRootId,
          vaultFolderId: sourceIdentity.scope.vaultFolderId,
          driveId: sourceIdentity.scope.driveId,
          accountId: sourceIdentity.scope.accountId,
        },
        vaultInstanceId: sourceIdentity.vaultInstanceId,
        operationKind: "first-sync-verification",
      };
      await expect(firstSyncVerificationEvidenceOperationId(reorderedIdentity))
        .resolves.toBe(original.operationId);
      await store.putVerified({
        schemaVersion: 1,
        operationId: original.operationId,
        remoteId: "remote-a",
        size: 10,
        eTag: "etag-a",
        sha256: "c".repeat(64),
        verifiedAt: 110,
      });
      const changedScopeId = await firstSyncVerificationEvidenceOperationId(
        firstSyncIdentity(vaultInstanceId, {
          scope: {
            ...firstSyncIdentity(vaultInstanceId).scope,
            filesRootId: "another-root",
          },
        }),
      );
      const changedAccountId = await firstSyncVerificationEvidenceOperationId(
        firstSyncIdentity(vaultInstanceId, {
          scope: {
            ...firstSyncIdentity(vaultInstanceId).scope,
            accountId: "another-account",
          },
        }),
      );
      const changedDriveId = await firstSyncVerificationEvidenceOperationId(
        firstSyncIdentity(vaultInstanceId, {
          scope: {
            ...firstSyncIdentity(vaultInstanceId).scope,
            driveId: "another-drive",
          },
        }),
      );
      const changedProtocolId = await firstSyncVerificationEvidenceOperationId(
        firstSyncIdentity(vaultInstanceId, {
          protocolBindingDigest: "d".repeat(64),
        }),
      );
      const changedCohortId = await firstSyncVerificationEvidenceOperationId(
        firstSyncIdentity(vaultInstanceId, {
          sourceCohort: { kind: "fresh" },
        }),
      );

      expect(new Set([
        original.operationId,
        changedScopeId,
        changedAccountId,
        changedDriveId,
        changedProtocolId,
        changedCohortId,
      ]).size).toBe(6);
      const unavailable = await store.readValidReceipts(
        changedScopeId,
        [{ remoteId: "remote-a", size: 10, eTag: "etag-a" }],
      );
      expect(unavailable.receiptsByRemoteId.size).toBe(0);
      const reusable = await store.readValidReceipts(
        original.operationId,
        [{ remoteId: "remote-a", size: 10, eTag: "etag-a" }],
      );
      expect(reusable.receiptsByRemoteId.get("remote-a")?.sha256)
        .toBe("c".repeat(64));
    } finally {
      await store.delete();
    }
  });

  it("fails closed on a corrupt first-sync operation and clears its orphaned receipts on replacement", async () => {
    const vaultInstanceId = "b".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const identityValue = firstSyncIdentity(vaultInstanceId);
      const operation = await store.beginFirstSyncVerification(
        identityValue,
        100,
      );
      await store.putVerified({
        schemaVersion: 1,
        operationId: operation.operationId,
        remoteId: "remote-a",
        size: 10,
        eTag: "etag-a",
        sha256: "c".repeat(64),
        verifiedAt: 110,
      });
      await store.close();
      const raw = await openDB(store.databaseName, 1);
      await raw.put("operations", {
        ...operation,
        scope: { ...operation.scope, driveId: "" },
      });
      raw.close();

      const restarted = new IndexedDbRemoteScopeRecoveryEvidenceStore(
        vaultInstanceId,
      );
      const hidden = await restarted.readValidReceipts(
        operation.operationId,
        [{ remoteId: "remote-a", size: 10, eTag: "etag-a" }],
      );
      expect(hidden.receiptsByRemoteId.size).toBe(0);
      await expect(restarted.summarize(operation.operationId)).resolves
        .toEqual({
          operationId: operation.operationId,
          receipts: 0,
          updatedAt: 0,
        });
      const replacement = await restarted.beginFirstSyncVerification(
        identityValue,
        120,
      );
      expect(replacement.operationId).toBe(operation.operationId);
      await expect(restarted.summarize(operation.operationId)).resolves
        .toMatchObject({ receipts: 0, updatedAt: 120 });
      await restarted.close();
    } finally {
      await store.delete();
    }
  });

  it("invalidates only the changed object and falls back to eTag when cTag is absent", async () => {
    const vaultInstanceId = "2".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const operation = await store.begin(identity(vaultInstanceId), 100);
      for (const [remoteId, eTag, cTag, sha] of [
        ["remote-a", "etag-a", "ctag-a", "c".repeat(64)],
        ["remote-b", "etag-b", undefined, "d".repeat(64)],
      ] as const) {
        await store.putVerified({
          schemaVersion: 1,
          operationId: operation.operationId,
          remoteId,
          size: 10,
          eTag,
          ...(cTag ? { cTag } : {}),
          sha256: sha,
          verifiedAt: 110,
        });
      }

      const result = await store.readValidReceipts(operation.operationId, [
        {
          remoteId: "remote-a",
          size: 10,
          eTag: "etag-a-2",
          cTag: "ctag-changed",
        },
        {
          remoteId: "remote-b",
          size: 10,
          eTag: "etag-b",
        },
      ]);

      expect(result.invalidated).toBe(1);
      expect([...result.receiptsByRemoteId.keys()]).toEqual(["remote-b"]);
      await expect(store.summarize(operation.operationId)).resolves
        .toMatchObject({ receipts: 1 });
    } finally {
      await store.delete();
    }
  });

  it("recovers its cached connection after IndexedDB terminates it", async () => {
    const vaultInstanceId = "3".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const operation = await store.begin(identity(vaultInstanceId), 100);
      await forceTerminateDatabaseConnection(store.databaseName);

      await store.putVerified({
        schemaVersion: 1,
        operationId: operation.operationId,
        remoteId: "remote-a",
        size: 10,
        eTag: "etag-a",
        sha256: "e".repeat(64),
        verifiedAt: 110,
      });

      await expect(store.summarize(operation.operationId)).resolves
        .toMatchObject({ receipts: 1 });
    } finally {
      await store.delete();
    }
  });

  it("retires only the completed operation", async () => {
    const vaultInstanceId = "4".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const first = await store.begin(identity(vaultInstanceId), 100);
      const second = await store.begin(identity(vaultInstanceId, {
        observedScope: {
          ...identity(vaultInstanceId).observedScope,
          filesRootId: "root-newer",
        },
      }), 200);
      await store.retire(first.operationId);

      await expect(store.summarize(first.operationId)).resolves
        .toEqual({ operationId: first.operationId, receipts: 0, updatedAt: 0 });
      await expect(store.summarize(second.operationId)).resolves
        .toMatchObject({ operationId: second.operationId, updatedAt: 200 });
    } finally {
      await store.delete();
    }
  });

  it("retires every first-sync operation without touching scope recovery", async () => {
    const vaultInstanceId = "d".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const recovery = await store.begin(identity(vaultInstanceId), 100);
      const first = await store.beginFirstSyncVerification(
        firstSyncIdentity(vaultInstanceId),
        110,
      );
      const second = await store.beginFirstSyncVerification(
        firstSyncIdentity(vaultInstanceId, {
          sourceCohort: { kind: "fresh" },
        }),
        120,
      );

      await expect(store.retireFirstSyncVerificationOperations())
        .resolves.toBe(2);
      await expect(store.summarize(recovery.operationId)).resolves
        .toMatchObject({ operationId: recovery.operationId, updatedAt: 100 });
      await expect(store.summarize(first.operationId)).resolves
        .toEqual({ operationId: first.operationId, receipts: 0, updatedAt: 0 });
      await expect(store.summarize(second.operationId)).resolves
        .toEqual({ operationId: second.operationId, receipts: 0, updatedAt: 0 });
      await expect(store.retireFirstSyncVerificationOperations())
        .resolves.toBe(0);
    } finally {
      await store.delete();
    }
  });

  it("discards an incompatible disposable schema and starts empty", async () => {
    const vaultInstanceId = "5".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    const incompatible = await openDB(store.databaseName, 1, {
      upgrade(db) {
        db.createObjectStore("obsolete");
      },
    });
    incompatible.close();
    try {
      const operation = await store.begin(identity(vaultInstanceId), 100);
      await expect(store.summarize(operation.operationId)).resolves
        .toEqual({
          operationId: operation.operationId,
          receipts: 0,
          updatedAt: 100,
        });
    } finally {
      await store.delete();
    }
  });

  it("rebuilds a disposable database created by a newer schema", async () => {
    const vaultInstanceId = "6".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    const newer = await openDB(store.databaseName, 2, {
      upgrade(db) {
        db.createObjectStore("future");
      },
    });
    newer.close();
    try {
      const operation = await store.begin(identity(vaultInstanceId), 100);
      await expect(store.summarize(operation.operationId)).resolves
        .toMatchObject({ receipts: 0, updatedAt: 100 });
    } finally {
      await store.delete();
    }
  });

  it("bounds stale operations without deleting the current operation", async () => {
    const vaultInstanceId = "7".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const operations = [];
      for (let index = 0; index < 4; index++) {
        operations.push(await store.begin(identity(vaultInstanceId, {
          observedScope: {
            ...identity(vaultInstanceId).observedScope,
            filesRootId: `root-${index}`,
          },
        }), 100 + index));
      }

      await expect(store.summarize(operations[0]!.operationId)).resolves
        .toMatchObject({ receipts: 0, updatedAt: 0 });
      for (const operation of operations.slice(1)) {
        await expect(store.summarize(operation.operationId)).resolves
          .toMatchObject({ updatedAt: operation.updatedAt });
      }
    } finally {
      await store.delete();
    }
  });

  it("retains 1384 of 1385 reported-scale receipts across restart", async () => {
    const vaultInstanceId = "8".repeat(32);
    const store = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      vaultInstanceId,
    );
    try {
      const operation = await store.begin(identity(vaultInstanceId), 100);
      for (let index = 0; index < 1_384; index++) {
        await store.putVerified({
          schemaVersion: 1,
          operationId: operation.operationId,
          remoteId: `remote-${index}`,
          size: 10,
          eTag: `etag-${index}`,
          cTag: `ctag-${index}`,
          sha256: index.toString(16).padStart(64, "0"),
          verifiedAt: 101 + index,
        });
      }
      await store.close();

      const restarted = new IndexedDbRemoteScopeRecoveryEvidenceStore(
        vaultInstanceId,
      );
      const versions = Array.from({ length: 1_385 }, (_, index) => ({
        remoteId: `remote-${index}`,
        size: 10,
        eTag: `etag-${index}`,
        cTag: `ctag-${index}`,
      }));
      const reused = await restarted.readValidReceipts(
        operation.operationId,
        versions,
      );

      expect(reused.receiptsByRemoteId.size).toBe(1_384);
      expect(reused.receiptsByRemoteId.has("remote-1384")).toBe(false);
      await restarted.close();
    } finally {
      await store.delete();
    }
  }, 30_000);
});

interface FakeIndexedDbDatabaseInternals extends IDBDatabase {
  _rawDatabase: {
    connections: FakeIndexedDbDatabaseInternals[];
  };
}

async function forceTerminateDatabaseConnection(
  databaseName: string,
): Promise<void> {
  const probe = await openDB(databaseName, 1);
  const rawProbe = unwrap(probe) as FakeIndexedDbDatabaseInternals;
  const activeConnections = rawProbe._rawDatabase.connections.filter(
    (connection) => connection !== rawProbe,
  );
  probe.close();
  if (activeConnections.length !== 1) {
    throw new Error(`expected one active connection, got ${activeConnections.length}`);
  }
  forceCloseDatabase(activeConnections[0]!);
}
