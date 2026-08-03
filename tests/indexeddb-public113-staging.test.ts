import "fake-indexeddb/auto";
import { forceCloseDatabase } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  IndexedDbPublic113StateStore,
  IndexedDbPublic113StateNotPreparedError,
  canonicalIndexedDbCandidateDigest,
  public113IndexedDbDatabaseName,
} from "../src/sync/indexeddb-public-1-1-3-state";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import {
  buildCanonicalPlanCandidateFromStateV2,
  buildCanonicalPlanCandidateV2,
  canonicalPlanDigestV2,
} from "../src/sync/canonical-plan-v2";

const sourceStateDigest = "a".repeat(64);

function candidate(
  contentHash = "b".repeat(64),
): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 8,
      commitSeq: 1,
      committedAt: 1721234567890,
    },
    scope: {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "root",
    },
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: "root",
      cursorRevision: 7,
      deltaLink: "delta",
      complete: true,
      itemsById: {
        folder: {
          id: "folder",
          parentId: "root",
          name: "Notes",
          kind: "folder",
          eTag: "folder-etag",
        },
        file: {
          id: "file",
          parentId: "folder",
          name: "note.md",
          kind: "file",
          eTag: "file-etag",
          cTag: undefined,
          size: 5,
          contentHash,
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        "anchor:file": {
          anchorId: "anchor:file",
          remoteId: "file",
          lastPath: "Notes/note.md",
          contentHash,
          size: 5,
          remoteETag: "file-etag",
          confirmedAt: 1721234567890,
          confirmedBy: "equal-read",
        },
      },
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: {
        "anchor:folder": {
          anchorId: "anchor:folder",
          remoteId: "folder",
          lastPath: "Notes",
          parentRemoteId: "root",
          remoteETag: "folder-etag",
          confirmedGeneration: 1,
          confirmedAt: 1721234567890,
        },
      },
    },
  };
}

function databaseName(label: string): string {
  return `easy-sync-test:${label}:${crypto.randomUUID()}`;
}

describe("public 1.1.3 IndexedDB candidate staging", () => {
  it("uses a distinct inactive database namespace for each Vault instance", () => {
    const first = public113IndexedDbDatabaseName(
      "1".repeat(32),
      sourceStateDigest,
    );
    const second = public113IndexedDbDatabaseName(
      "2".repeat(32),
      sourceStateDigest,
    );

    expect(first).not.toBe(second);
    expect(first).toContain(`:${"1".repeat(32)}:${sourceStateDigest}`);
    expect(second).toContain(`:${"2".repeat(32)}:${sourceStateDigest}`);
  });

  it("keeps same-source candidates isolated when another Vault database is deleted", async () => {
    const firstName = public113IndexedDbDatabaseName(
      "3".repeat(32),
      sourceStateDigest,
    );
    const secondName = public113IndexedDbDatabaseName(
      "4".repeat(32),
      sourceStateDigest,
    );
    const first = new IndexedDbPublic113StateStore(firstName);
    const second = new IndexedDbPublic113StateStore(secondName);
    try {
      const expected = candidate();
      await first.stageCandidate(expected, { sourceStateDigest });
      await second.stageCandidate(expected, { sourceStateDigest });

      await first.delete();

      await expect(second.loadPreparedCandidate(sourceStateDigest))
        .resolves.toEqual(JSON.parse(JSON.stringify(expected)));
    } finally {
      await first.delete();
      await second.delete();
    }
  });

  it("never exposes a prepared candidate to a different public source digest", async () => {
    const name = databaseName("source-binding");
    const staleSourceDigest = "c".repeat(64);
    const currentSourceDigest = "d".repeat(64);
    const store = new IndexedDbPublic113StateStore(name);
    try {
      await store.stageCandidate(candidate(), {
        sourceStateDigest: staleSourceDigest,
      });

      await expect(store.loadPreparedCandidate(currentSourceDigest))
        .rejects.toThrow(
          "Public 1.1.3 IndexedDB candidate source binding does not match",
        );
      await expect(store.loadPreparedPlannerView(currentSourceDigest))
        .rejects.toThrow(
          "Public 1.1.3 IndexedDB planner view source binding does not match",
        );
      expect(await store.inspect()).toMatchObject({
        phase: "prepared",
        authority: "inactive",
        sourceStateDigest: staleSourceDigest,
      });
    } finally {
      await store.delete();
    }
  });

  it("prepares, closes and reopens the exact candidate with matching counts and digest", async () => {
    const name = databaseName("reopen");
    const store = new IndexedDbPublic113StateStore(name);
    try {
      const expected = candidate();
      const staged = await store.stageCandidate(expected, {
        sourceStateDigest,
        now: 1721234567999,
        batchSize: 1,
      });

      expect(staged).toMatchObject({
        reused: false,
        counts: {
          remoteNodes: 2,
          anchors: 1,
          folderAnchors: 1,
        },
      });
      expect(staged.candidateDigest).toBe(
        await canonicalIndexedDbCandidateDigest(expected),
      );
      expect(await store.inspect()).toMatchObject({
        phase: "prepared",
        authority: "inactive",
        sourceStateDigest,
        candidateDigest: staged.candidateDigest,
        counts: staged.counts,
      });

      await store.close();
      const reopened = new IndexedDbPublic113StateStore(name);
      const loaded = await reopened.loadPreparedCandidate(sourceStateDigest);
      expect(loaded).toEqual(JSON.parse(JSON.stringify(expected)));
      const envelopeHydration = vi.spyOn(
        reopened,
        "loadPreparedCandidate",
      );
      const view = await reopened.loadPreparedPlannerView(sourceStateDigest);
      expect(envelopeHydration).not.toHaveBeenCalled();
      expect(view).toMatchObject({
        sourceStateDigest,
        candidateDigest: staged.candidateDigest,
        counts: staged.counts,
      });
      expect(view.state).not.toHaveProperty("envelope");
      expect(view.state.remotePathById.get("file"))
        .toBe("Notes/note.md");
      const plannerInput = {
        localFiles: [{
          path: "Notes/note.md",
          size: 5,
          mtime: 1,
          hash: "b".repeat(64),
          binary: false,
        }],
        localFolders: [{ path: "Notes" }],
        localFolderScanComplete: true,
        skippedLarge: [],
        configDir: ".obsidian",
        automaticDeleteLocalFiles: false,
      } as const;
      const envelopePlan = buildCanonicalPlanCandidateV2({
        ...plannerInput,
        envelope: expected,
      });
      const viewPlan = buildCanonicalPlanCandidateFromStateV2({
        ...plannerInput,
        state: view.state,
      });
      expect(planDigest(viewPlan)).toBe(planDigest(envelopePlan));
      await reopened.close();
    } finally {
      await store.delete();
    }
  });

  it("never exposes an interrupted import as a prepared candidate", async () => {
    const name = databaseName("interrupted");
    const store = new IndexedDbPublic113StateStore(name);
    try {
      const controller = new AbortController();
      controller.abort("cancel staging");

      await expect(store.stageCandidate(candidate(), {
        sourceStateDigest,
        signal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(await store.inspect()).toMatchObject({
        phase: "importing",
        authority: "inactive",
        sourceStateDigest,
      });
      await expect(
        store.loadPreparedCandidate(sourceStateDigest),
      ).rejects.toBeInstanceOf(
        IndexedDbPublic113StateNotPreparedError,
      );
      await expect(
        store.loadPreparedPlannerView(sourceStateDigest),
      ).rejects.toBeInstanceOf(
        IndexedDbPublic113StateNotPreparedError,
      );
    } finally {
      await store.delete();
    }
  });

  it("reopens a prepared candidate after its connection terminates", async () => {
    const name = databaseName("terminated");
    const store = new IndexedDbPublic113StateStore(name);
    try {
      const expected = candidate();
      await store.stageCandidate(expected, { sourceStateDigest });

      await forceTerminateStoreConnection(name);

      await expect(
        store.loadPreparedCandidate(sourceStateDigest),
      ).resolves.toEqual(JSON.parse(JSON.stringify(expected)));
    } finally {
      await store.delete();
    }
  });

  it("reuses an exact prepared candidate and replaces a changed one", async () => {
    const name = databaseName("idempotent");
    const store = new IndexedDbPublic113StateStore(name);
    try {
      const original = candidate();
      const first = await store.stageCandidate(original, {
        sourceStateDigest,
        now: 1,
      });
      const reused = await store.stageCandidate(original, {
        sourceStateDigest,
        now: 2,
      });
      expect(reused).toEqual({
        ...first,
        reused: true,
        batches: 0,
      });

      const changed = candidate("c".repeat(64));
      const replaced = await store.stageCandidate(changed, {
        sourceStateDigest,
        now: 3,
      });
      expect(replaced.reused).toBe(false);
      expect(replaced.candidateDigest).not.toBe(first.candidateDigest);
      expect(
        await store.loadPreparedCandidate(sourceStateDigest),
      ).toEqual(JSON.parse(JSON.stringify(changed)));
    } finally {
      await store.delete();
    }
  });

  it("rejects a same-count planner row change instead of planning from it", async () => {
    const name = databaseName("planner-integrity");
    const store = new IndexedDbPublic113StateStore(name);
    try {
      await store.stageCandidate(candidate(), { sourceStateDigest });
      await store.close();
      const db = await openRawDatabase(name);
      const tx = db.transaction("remoteNodes", "readwrite");
      const objectStore = tx.objectStore("remoteNodes");
      const node = await rawRequest<Record<string, unknown>>(
        objectStore.get("file"),
      );
      await rawRequest(objectStore.put({
        ...node,
        size: 999,
      }, "file"));
      await rawTransaction(tx);
      db.close();

      const reopened = new IndexedDbPublic113StateStore(name);
      await expect(
        reopened.loadPreparedPlannerView(sourceStateDigest),
      ).rejects.toThrow(
        "Public 1.1.3 IndexedDB planner view rows do not match",
      );
      await reopened.close();
    } finally {
      await store.delete();
    }
  });
});

function planDigest(
  plan: ReturnType<typeof buildCanonicalPlanCandidateV2>,
): string {
  return canonicalPlanDigestV2({
    items: plan.items,
    lastTotalFiles: plan.lastTotalFiles,
    scope: plan.scope,
    sourceCommitSeq: plan.sourceCommitSeq,
  });
}

function openRawDatabase(name: string): Promise<IDBDatabase> {
  return rawRequest(indexedDB.open(name));
}

interface FakeIndexedDbDatabaseInternals extends IDBDatabase {
  _rawDatabase: {
    connections: FakeIndexedDbDatabaseInternals[];
  };
}

async function forceTerminateStoreConnection(name: string): Promise<void> {
  const probe = await openRawDatabase(name) as FakeIndexedDbDatabaseInternals;
  const activeConnections = probe._rawDatabase.connections.filter(
    (connection) => connection !== probe,
  );
  probe.close();
  if (activeConnections.length !== 1) {
    throw new Error(
      `expected one active IndexedDB connection, got ${activeConnections.length}`,
    );
  }
  forceCloseDatabase(activeConnections[0]!);
}

function rawRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rawTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}
