import "fake-indexeddb/auto";

import { forceCloseDatabase } from "fake-indexeddb";
import type { DataAdapter } from "obsidian";
import { openDB, unwrap } from "idb";
import { describe, expect, it } from "vitest";
import {
  StateV2IndexedDbActiveStateError,
  StateV2IndexedDbActiveStore,
  createStateV2ActiveIndexedDbDatabaseId,
  deriveStateV2ActiveIndexedDbDatabaseId,
} from "../src/sync/state-v2-indexeddb-active";
import {
  StateV2IndexedDbRecoveryStore,
  stateV2IndexedDbRecoveryEnvelopeDigest,
} from "../src/sync/state-v2-indexeddb-recovery";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import { createLargeV2Envelope } from "./helpers/large-v2-envelope";
import {
  injectActiveCommitCompletionFault,
  type ActiveCommitCompletionFaultName,
} from "./helpers/indexeddb-completion-fault";

class MemoryRecoveryAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly failBeforeWrite = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    if (this.failBeforeWrite.delete(path)) {
      throw new Error(`injected write failure: ${path}`);
    }
    this.files.set(path, value);
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`missing: ${from}`);
    this.files.set(to, value);
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()]
        .filter((entry) => entry.startsWith(prefix))
        .sort(),
      folders: [],
    };
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
}

describe("production-capable IndexedDB active state owner", () => {
  it("initializes, reloads, and idempotently reuses one exact database", async () => {
    const envelope = createLargeV2Envelope(20);
    const harness = createHarness();
    try {
      const initialized = await harness.store.initialize(envelope, {
        now: 100,
      });
      expect(initialized.reused).toBe(false);
      expect(initialized.counts).toEqual({
        remoteNodes: 21,
        anchors: 20,
        folderAnchors: 1,
      });
      expect(await harness.store.load()).toEqual(envelope);
      expect((await harness.store.initialize(envelope)).reused).toBe(true);
      expect(await harness.store.inspect()).toMatchObject({
        phase: "ready",
        databaseId: harness.databaseId,
        commitSeq: envelope.meta.commitSeq,
      });
      await expect(harness.store.reconcileLoadedRecoveryDelta()).resolves.toBe(
        "clean",
      );
    } finally {
      await harness.store.delete();
    }
  });

  it("keeps device community-plugin participation across IndexedDB reload", async () => {
    const envelope = createLargeV2Envelope(2);
    envelope.communityPluginParticipation = {
      schemaVersion: 1,
      kind: "device-community-plugin-participation",
      scopeEnabled: true,
      pluginsById: {
        calendar: {
          pluginId: "calendar",
          phase: "participating",
          joinedGeneration: 3,
          lastConfirmedLocalBundleDigest: "c".repeat(64),
        },
      },
    };
    const harness = createHarness();
    try {
      await harness.store.initialize(envelope);

      expect(await harness.store.load()).toEqual(envelope);
    } finally {
      await harness.store.delete();
    }
  });

  it("resumes the exact preparation after a process stops between batches", async () => {
    const envelope = createLargeV2Envelope(20);
    const harness = createHarness();
    let restarted: StateV2IndexedDbActiveStore | null = null;
    let abortChecks = 0;
    const interruptedSignal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 4;
      },
    } as AbortSignal;
    try {
      await expect(harness.store.initialize(envelope, {
        batchSize: 1,
        signal: interruptedSignal,
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(await harness.store.inspect()).toMatchObject({
        phase: "preparing",
        databaseId: harness.databaseId,
      });

      await harness.store.close();
      restarted = new StateV2IndexedDbActiveStore(
        harness.databaseId,
        harness.recovery,
      );
      const resumed = await restarted.initialize(envelope, { batchSize: 3 });

      expect(resumed.reused).toBe(false);
      expect(await restarted.load()).toEqual(envelope);
      expect(await restarted.inspect()).toMatchObject({
        phase: "ready",
        databaseId: harness.databaseId,
        commitSeq: envelope.meta.commitSeq,
      });
    } finally {
      await (restarted ?? harness.store).delete();
    }
  });

  it("derives retry-stable but Vault- and transition-scoped database identities", async () => {
    const stateDigest = "a".repeat(64);
    const base = {
      vaultInstanceId: "1".repeat(32),
      stateDigest,
    };
    const first = await deriveStateV2ActiveIndexedDbDatabaseId(base);

    expect(await deriveStateV2ActiveIndexedDbDatabaseId(base)).toBe(first);
    expect(await deriveStateV2ActiveIndexedDbDatabaseId({
      ...base,
      vaultInstanceId: "2".repeat(32),
    })).not.toBe(first);
    expect(await deriveStateV2ActiveIndexedDbDatabaseId({
      ...base,
      previousDatabaseId: first,
    })).not.toBe(first);
  });

  it("reopens after the active IndexedDB connection terminates", async () => {
    const envelope = createLargeV2Envelope(20);
    const harness = createHarness();
    try {
      await harness.store.initialize(envelope);

      await forceTerminateActiveDatabaseConnection(
        harness.store.databaseName,
      );

      expect(await harness.store.load()).toEqual(envelope);
      expect(await harness.store.inspect()).toMatchObject({
        phase: "ready",
        databaseId: harness.databaseId,
        commitSeq: envelope.meta.commitSeq,
      });
    } finally {
      await harness.store.delete();
    }
  });

  it("commits only changed rows plus metadata and witnesses recovery", async () => {
    const source = createLargeV2Envelope(100);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const harness = createHarness();
    try {
      await harness.store.initialize(source);
      const committed = await harness.store.commit(source, next);
      expect(committed).toMatchObject({
        alreadyCommitted: false,
        commitSeq: next.meta.commitSeq,
        logicalWrites: 3,
      });
      expect(await harness.store.load()).toEqual(next);
      expect(await harness.store.rebuildRecoveryEnvelope()).toEqual(next);
      expect((await harness.store.load()).anchors.byAnchorId["file:file-00000"])
        .toMatchObject({ remoteCTag: "ctag-etag-next" });
    } finally {
      await harness.store.delete();
    }
  });

  it.each([
    "QuotaExceededError",
    "UnknownError",
    "AbortError",
  ] as const)(
    "atomically rolls back a %s raised at transaction completion",
    async (faultName) => {
      const source = createLargeV2Envelope(20);
      const harness = createHarness();
      let completionFault: ReturnType<
        typeof injectActiveCommitCompletionFault
      > | null = null;
      try {
        await harness.store.initialize(source);
        const previousEnvelope = await harness.store.load();
        const next = nextEnvelope(
          previousEnvelope,
          "b".repeat(64),
          "etag-next",
        );
        const previousInspection = await harness.store.inspect();
        completionFault = injectActiveCommitCompletionFault(faultName);
        const failedCommit = harness.store.commit(previousEnvelope, next);

        await expect(failedCommit).rejects.toMatchObject({
          name: faultName,
        });
        expect(await failedCommit.catch((error: unknown) => error))
          .toBeInstanceOf(DOMException);
        expect(completionFault.injectionCount()).toBe(1);
        expect(completionFault.observation()).toMatchObject({
          mode: "readwrite",
          pendingRequests: 0,
          state: "active",
          storeNames: ["anchors", "folderAnchors", "meta", "remoteNodes"],
        });
        expect(completionFault.observation()!.rollbackOperations)
          .toBeGreaterThanOrEqual(3);

        const retainedEnvelope = await harness.store.load();
        expect(retainedEnvelope).toEqual(previousEnvelope);
        expect(await harness.store.inspect()).toEqual(previousInspection);
        expect(
          harness.adapter.files.has(
            harness.recovery.deltaPath(next.meta.commitSeq),
          ),
        ).toBe(true);
        expect(
          harness.adapter.files.has(
            harness.recovery.commitWitnessPath(next.meta.commitSeq),
          ),
        ).toBe(false);
        await expect(harness.store.rebuildRecoveryEnvelope()).rejects.toThrow(
          "prepared delta has no commit witness",
        );

        completionFault.restore();
        const retried = await harness.store.commit(retainedEnvelope, next);
        expect(retried).toEqual({
          alreadyCommitted: false,
          commitSeq: next.meta.commitSeq,
          stateDigest: await stateV2IndexedDbRecoveryEnvelopeDigest(next),
          logicalWrites: 3,
        });
        expect(await harness.store.load()).toEqual(next);
        expect(await harness.store.rebuildRecoveryEnvelope()).toEqual(next);
        await expect(
          harness.store.commit(retainedEnvelope, next),
        ).rejects.toMatchObject({
          name: "StateV2IndexedDbActiveStateError",
          reason: "revision-mismatch",
        });
        expect(await harness.store.load()).toEqual(next);
      } finally {
        completionFault?.restore();
        await harness.store.delete();
      }
    },
  );

  it(
    "retires an uncommitted future delta before a restarted store commits different next bytes",
    async () => {
      const source = createLargeV2Envelope(20);
      const abandoned = nextEnvelope(
        source,
        "b".repeat(64),
        "etag-abandoned",
      );
      const replacement = nextEnvelope(
        source,
        "c".repeat(64),
        "etag-replacement",
      );
      const harness = createHarness();
      let restarted: StateV2IndexedDbActiveStore | null = null;
      const completionFault = injectActiveCommitCompletionFault("AbortError");
      try {
        await harness.store.initialize(source);
        await expect(
          harness.store.commit(source, abandoned),
        ).rejects.toMatchObject({
          name: "AbortError",
        });
        completionFault.restore();

        expect(await harness.store.load()).toEqual(source);
        expect(
          harness.adapter.files.has(
            harness.recovery.deltaPath(abandoned.meta.commitSeq),
          ),
        ).toBe(true);
        expect(
          harness.adapter.files.has(
            harness.recovery.commitWitnessPath(abandoned.meta.commitSeq),
          ),
        ).toBe(false);

        await harness.store.close();
        restarted = new StateV2IndexedDbActiveStore(
          harness.databaseId,
          harness.recovery,
        );
        const retained = await restarted.load();
        expect(retained).toEqual(source);
        await expect(
          restarted.reconcileLoadedRecoveryDelta(),
        ).resolves.toBe("orphan-retired");

        await expect(restarted.commit(retained, replacement)).resolves.toEqual({
          alreadyCommitted: false,
          commitSeq: replacement.meta.commitSeq,
          stateDigest:
            await stateV2IndexedDbRecoveryEnvelopeDigest(replacement),
          logicalWrites: 3,
        });
        expect(await restarted.load()).toEqual(replacement);
        expect(await restarted.rebuildRecoveryEnvelope()).toEqual(replacement);
      } finally {
        completionFault.restore();
        await (restarted ?? harness.store).delete();
      }
    },
  );

  it("retries witness publication without rewriting the committed database", async () => {
    const source = createLargeV2Envelope(20);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const harness = createHarness();
    try {
      await harness.store.initialize(source);
      harness.adapter.failBeforeWrite.add(
        `${harness.recovery.commitWitnessPath(next.meta.commitSeq)}.next`,
      );
      await expect(harness.store.commit(source, next)).rejects.toThrow(
        "injected write failure",
      );

      const resumed = await harness.store.commit(source, next);
      expect(resumed).toMatchObject({
        alreadyCommitted: true,
        logicalWrites: 0,
      });
      expect(await harness.store.rebuildRecoveryEnvelope()).toEqual(next);
    } finally {
      await harness.store.delete();
    }
  });

  it("resumes witness publication after a process boundary", async () => {
    const source = createLargeV2Envelope(20);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const harness = createHarness();
    let restarted: StateV2IndexedDbActiveStore | null = null;
    try {
      await harness.store.initialize(source);
      harness.adapter.failBeforeWrite.add(
        `${harness.recovery.commitWitnessPath(next.meta.commitSeq)}.next`,
      );
      await expect(harness.store.commit(source, next)).rejects.toThrow(
        "injected write failure",
      );
      await expect(harness.store.rebuildRecoveryEnvelope()).rejects.toThrow(
        "prepared delta has no commit witness",
      );

      await harness.store.close();
      restarted = new StateV2IndexedDbActiveStore(
        harness.databaseId,
        harness.recovery,
      );
      expect(await restarted.load()).toEqual(next);
      await expect(restarted.reconcileLoadedRecoveryDelta()).resolves.toBe(
        "witness-confirmed",
      );
      expect(await restarted.rebuildRecoveryEnvelope()).toEqual(next);
    } finally {
      await (restarted ?? harness.store).delete();
    }
  });

  it(
    "reports a fully witnessed loaded commit as clean after restart",
    async () => {
      const source = createLargeV2Envelope(20);
      const next = nextEnvelope(source, "b".repeat(64), "etag-next");
      const harness = createHarness();
      let restarted: StateV2IndexedDbActiveStore | null = null;
      try {
        await harness.store.initialize(source);
        await harness.store.commit(source, next);
        await harness.store.close();
        restarted = new StateV2IndexedDbActiveStore(
          harness.databaseId,
          harness.recovery,
        );
        expect(await restarted.load()).toEqual(next);
        await expect(
          restarted.reconcileLoadedRecoveryDelta(),
        ).resolves.toBe("clean");
      } finally {
        await (restarted ?? harness.store).delete();
      }
    },
  );

  it("rejects a stale or branched incremental commit", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const branch = nextEnvelope(source, "c".repeat(64), "etag-branch");
    const harness = createHarness();
    try {
      await harness.store.initialize(source);
      await harness.store.commit(source, next);
      await expect(harness.store.commit(source, branch)).rejects.toMatchObject({
        name: "StateV2IndexedDbActiveStateError",
        reason: "revision-mismatch",
      });
      expect(await harness.store.load()).toEqual(next);
    } finally {
      await harness.store.delete();
    }
  });

  it("detects row tampering instead of trusting metadata and counts", async () => {
    const source = createLargeV2Envelope(10);
    const harness = createHarness();
    try {
      await harness.store.initialize(source);
      const db = await openDB(harness.store.databaseName, 1);
      const changed = {
        ...source.remoteIndex.itemsById["file-00000"]!,
        eTag: "tampered",
      };
      await db.put("remoteNodes", changed, changed.id);
      db.close();

      await expect(harness.store.load()).rejects.toBeInstanceOf(
        StateV2IndexedDbActiveStateError,
      );
      await expect(harness.store.load()).rejects.toMatchObject({
        reason: "digest-mismatch",
      });
    } finally {
      await harness.store.delete();
    }
  });

  it("preserves a future delta when uncached database rows no longer match the loaded state", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const harness = createHarness();
    try {
      await harness.store.initialize(source);
      await harness.store.load();
      await harness.recovery.prepareDelta(source, next);
      const db = await openDB(harness.store.databaseName, 1);
      const changed = {
        ...source.remoteIndex.itemsById["file-00000"]!,
        eTag: "changed-after-load",
      };
      await db.put("remoteNodes", changed, changed.id);
      db.close();

      await expect(
        harness.store.reconcileLoadedRecoveryDelta(),
      ).rejects.toMatchObject({
        name: "StateV2IndexedDbActiveStateError",
        reason: "digest-mismatch",
      });
      expect(
        harness.adapter.files.has(
          harness.recovery.deltaPath(next.meta.commitSeq),
        ),
      ).toBe(true);
    } finally {
      await harness.store.delete();
    }
  });

  it("rebuilds a lost authority only into a fresh database identity", async () => {
    const source = createLargeV2Envelope(20);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const harness = createHarness();
    let replacement: StateV2IndexedDbActiveStore | null = null;
    try {
      await harness.store.initialize(source);
      await harness.store.commit(source, next);
      await harness.store.delete();
      await expect(harness.store.load()).rejects.toMatchObject({
        reason: "missing",
      });

      const rebuilt = await harness.store.rebuildRecoveryEnvelope();
      const replacementId = createStateV2ActiveIndexedDbDatabaseId();
      replacement = new StateV2IndexedDbActiveStore(
        replacementId,
        harness.recovery,
      );
      await replacement.initialize(rebuilt);
      expect(replacement.databaseId).not.toBe(harness.databaseId);
      expect(await replacement.load()).toEqual(next);
      expect(await harness.store.inspect()).toMatchObject({
        phase: "missing",
      });
    } finally {
      await harness.store.delete();
      await replacement?.delete();
    }
  });

  it("keeps one 50k active commit bounded to changed rows", async () => {
    const source = createLargeV2Envelope(50_000);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const harness = createHarness();
    try {
      const startedAt = performance.now();
      await harness.store.initialize(source);
      const initializedMs = performance.now() - startedAt;
      const commitStartedAt = performance.now();
      const committed = await harness.store.commit(source, next);
      const commitMs = performance.now() - commitStartedAt;
      const deltaBytes = harness.adapter.files.get(
        harness.recovery.deltaPath(next.meta.commitSeq),
      )!.length;
      const witnessBytes = harness.adapter.files.get(
        harness.recovery.commitWitnessPath(next.meta.commitSeq),
      )!.length;
      const digestStartedAt = performance.now();
      const expectedDigest =
        await stateV2IndexedDbRecoveryEnvelopeDigest(next);
      const digestMs = performance.now() - digestStartedAt;

      expect(committed.logicalWrites).toBe(3);
      expect(deltaBytes + witnessBytes).toBeLessThan(4_096);
      expect(await harness.store.inspect()).toMatchObject({
        phase: "ready",
        commitSeq: next.meta.commitSeq,
        stateDigest: expectedDigest,
      });

      console.log("[indexeddb-active-state-50k]", JSON.stringify({
        schemaVersion: 1,
        files: 50_000,
        initializedMs: Number(initializedMs.toFixed(3)),
        commitMs: Number(commitMs.toFixed(3)),
        digestMs: Number(digestMs.toFixed(3)),
        logicalWrites: committed.logicalWrites,
        preparedDeltaBytes: deltaBytes,
        commitWitnessBytes: witnessBytes,
        totalCommitBytes: deltaBytes + witnessBytes,
      }));
    } finally {
      await harness.store.delete();
    }
  }, 60_000);
});

interface FakeIndexedDbDatabaseInternals extends IDBDatabase {
  _rawDatabase: {
    connections: FakeIndexedDbDatabaseInternals[];
  };
}

async function forceTerminateActiveDatabaseConnection(
  databaseName: string,
): Promise<void> {
  const probe = await openDB(databaseName, 1);
  const rawProbe = unwrap(probe) as FakeIndexedDbDatabaseInternals;
  const activeConnections = rawProbe._rawDatabase.connections.filter(
    (connection) => connection !== rawProbe,
  );
  probe.close();
  if (activeConnections.length !== 1) {
    throw new Error(
      `expected one active IndexedDB connection, got ${activeConnections.length}`,
    );
  }
  forceCloseDatabase(activeConnections[0]!);
}

function createHarness(): {
  adapter: MemoryRecoveryAdapter;
  recovery: StateV2IndexedDbRecoveryStore;
  databaseId: string;
  store: StateV2IndexedDbActiveStore;
} {
  const adapter = new MemoryRecoveryAdapter();
  const recovery = new StateV2IndexedDbRecoveryStore(
    adapter as unknown as DataAdapter,
    "recovery",
  );
  const databaseId = createStateV2ActiveIndexedDbDatabaseId();
  return {
    adapter,
    recovery,
    databaseId,
    store: new StateV2IndexedDbActiveStore(databaseId, recovery),
  };
}

function nextEnvelope(
  source: SyncStateEnvelopeV2,
  contentHash: string,
  eTag: string,
): SyncStateEnvelopeV2 {
  const committedAt = source.meta.committedAt + 1;
  const nextNode = {
    ...source.remoteIndex.itemsById["file-00000"]!,
    size: 2,
    eTag,
    cTag: `ctag-${eTag}`,
    contentHash,
  };
  const nextAnchor = {
    ...source.anchors.byAnchorId["file:file-00000"]!,
    size: 2,
    remoteETag: eTag,
    remoteCTag: `ctag-${eTag}`,
    contentHash,
    confirmedAt: committedAt,
    confirmedBy: "upload-cas" as const,
  };
  return {
    ...source,
    meta: {
      ...source.meta,
      commitSeq: source.meta.commitSeq + 1,
      committedAt,
    },
    remoteIndex: {
      ...source.remoteIndex,
      itemsById: {
        ...source.remoteIndex.itemsById,
        [nextNode.id]: nextNode,
      },
    },
    anchors: {
      ...source.anchors,
      byAnchorId: {
        ...source.anchors.byAnchorId,
        [nextAnchor.anchorId]: nextAnchor,
      },
    },
  };
}
