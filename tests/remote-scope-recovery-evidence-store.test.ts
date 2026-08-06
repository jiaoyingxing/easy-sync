import "fake-indexeddb/auto";

import { forceCloseDatabase } from "fake-indexeddb";
import { openDB, unwrap } from "idb";
import { describe, expect, it } from "vitest";
import {
  IndexedDbRemoteScopeRecoveryEvidenceStore,
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
