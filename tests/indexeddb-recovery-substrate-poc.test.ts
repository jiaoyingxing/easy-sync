import "fake-indexeddb/auto";

import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  IndexedDbStatePocStore,
  canonicalEnvelopeDigest,
} from "./poc/indexeddb-state-poc";
import {
  StateV2IndexedDbRecoveryStore,
  stateV2IndexedDbRecoveryEnvelopeDigest,
} from "../src/sync/state-v2-indexeddb-recovery";
import {
  createLargeV2Envelope,
  LARGE_V2_FIXTURE_SCOPE,
} from "./helpers/large-v2-envelope";
import type {
  MutationIntentV1,
  MutationReceiptV1,
} from "../src/sync/types";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";

class MemoryRecoveryAdapter {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly failAfterWrite = new Set<string>();
  readonly failAfterRename = new Set<string>();
  readonly failAfterRemove = new Set<string>();
  readonly mtimes = new Map<string, number>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
    if (this.failAfterWrite.delete(path)) {
      throw new Error(`injected response loss after write: ${path}`);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`missing: ${from}`);
    this.files.set(to, value);
    this.files.delete(from);
    if (this.failAfterRename.delete(to)) {
      throw new Error(`injected response loss after rename: ${to}`);
    }
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    if (this.failAfterRemove.delete(path)) {
      throw new Error(`injected response loss after remove: ${path}`);
    }
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return {
      files: [...this.files.keys()]
        .filter((candidate) => candidate.startsWith(`${path}/`))
        .sort(),
      folders: [],
    };
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async stat(path: string): Promise<{
    ctime: number;
    mtime: number;
    size: number;
    type: string;
  } | null> {
    if (!this.files.has(path) && !this.folders.has(path)) return null;
    return {
      ctime: this.mtimes.get(path) ?? 0,
      mtime: this.mtimes.get(path) ?? 0,
      size: 0,
      type: "file",
    };
  }
}

describe("IndexedDB authority recovery substrate", () => {
  it("returns a bounded per-identity remote change history across commit deltas", async () => {
    const adapter = new MemoryRecoveryAdapter() as unknown as DataAdapter;
    const store = new StateV2IndexedDbRecoveryStore(adapter, "state/recovery");
    const base = createLargeV2Envelope(1);
    const nodeX = {
      id: "node-x",
      parentId: "folder-bulk",
      name: "note-x.md",
      kind: "file" as const,
      size: 2,
      mtime: 2,
      eTag: "etag-x",
      cTag: "ctag-x",
      contentHash: "b".repeat(64),
    };
    const anchorX = {
      anchorId: "file:node-x",
      remoteId: "node-x",
      lastPath: "Bulk/note-x.md",
      contentHash: "b".repeat(64),
      size: 2,
      remoteETag: "etag-x",
      confirmedAt: 2,
      confirmedBy: "equal-read" as const,
    };
    const withNode = structuredClone(base);
    withNode.meta = { ...withNode.meta, commitSeq: base.meta.commitSeq + 1 };
    withNode.remoteIndex = {
      ...withNode.remoteIndex,
      itemsById: { ...withNode.remoteIndex.itemsById, "node-x": nodeX },
    };
    withNode.anchors = {
      schemaVersion: 2,
      byAnchorId: {
        ...withNode.anchors.byAnchorId,
        "file:node-x": anchorX,
      },
    };
    await store.prepareDelta(base, withNode);

    const withoutNode = structuredClone(withNode);
    withoutNode.meta = {
      ...withNode.meta,
      commitSeq: withNode.meta.commitSeq + 1,
    };
    const remainingItems = { ...withNode.remoteIndex.itemsById };
    delete remainingItems["node-x"];
    const remainingAnchors = { ...withNode.anchors.byAnchorId };
    delete remainingAnchors["file:node-x"];
    withoutNode.remoteIndex = {
      ...withoutNode.remoteIndex,
      itemsById: remainingItems,
    };
    withoutNode.anchors = {
      schemaVersion: 2,
      byAnchorId: remainingAnchors,
    };
    await store.prepareDelta(withNode, withoutNode);

    const history = await store.remoteNodeHistory("node-x", 10);
    expect(history.map((event) => [event.commitSeq, event.kind])).toEqual([
      [5, "delete"],
      [4, "upsert"],
    ]);
    expect(history[1].node).toMatchObject({ id: "node-x", eTag: "etag-x" });
    expect(history[0].node).toBeNull();
  });

  it("keeps one 50k-state mutation recovery record bounded", async () => {
    const source = createLargeV2Envelope(50_000);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.publishCheckpoint(source);
    await recovery.prepareDelta(source, next);
    await recovery.confirmCommittedDelta(next);

    const checkpointBytes = (await files.read(
      recovery.checkpointPath(3),
    )).length;
    const preparedDeltaBytes = (
      await files.read(recovery.deltaPath(4))
    ).length;
    const commitWitnessBytes = (
      await files.read(recovery.commitWitnessPath(4))
    ).length;
    const totalCommitBytes = preparedDeltaBytes + commitWitnessBytes;
    expect(totalCommitBytes).toBeLessThan(4_096);
    expect(totalCommitBytes).toBeLessThan(checkpointBytes / 1_000);
    expect(await canonicalEnvelopeDigest(await recovery.rebuild()))
      .toBe(await canonicalEnvelopeDigest(next));
    console.log("[indexeddb-recovery-substrate-50k]", JSON.stringify({
      schemaVersion: 1,
      files: 50_000,
      checkpointBytes,
      preparedDeltaBytes,
      commitWitnessBytes,
      totalCommitBytes,
      checkpointToCommitRatio: Number(
        (checkpointBytes / totalCommitBytes).toFixed(1),
      ),
      previousCommitSeq: 3,
      nextCommitSeq: 4,
    }));
  }, 30_000);

  it("distinguishes an unwitnessed delta from an already bound commit", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.publishCheckpoint(source);
    await recovery.prepareDelta(source, next);
    await expect(
      recovery.needsCommitWitness(next.meta.commitSeq),
    ).resolves.toBe(true);

    await recovery.confirmCommittedDelta(next);
    await expect(
      recovery.needsCommitWitness(next.meta.commitSeq),
    ).resolves.toBe(false);
  });

  it("rebuilds a deleted database from one checkpoint and one bounded delta", async () => {
    const source = createLargeV2Envelope(100);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    const databaseName = uniqueDatabaseName("loss-source");
    const rebuiltDatabaseName = uniqueDatabaseName("loss-rebuilt");
    const store = new IndexedDbStatePocStore(databaseName);
    const rebuiltStore = new IndexedDbStatePocStore(rebuiltDatabaseName);
    try {
      await recovery.publishCheckpoint(source);
      // The durable delta is published before the local database transaction.
      await recovery.prepareDelta(source, next);
      await store.importEnvelope(source);
      const { intent, receipt } = mutationFacts(source);
      await store.beginMutationIntent(intent);
      await store.recordMutationReceipt(receipt);
      await store.finalizeMutation({
        operationId: intent.operationId,
        remoteNode: next.remoteIndex.itemsById["file-00000"]!,
        anchor: next.anchors.byAnchorId["file:file-00000"]!,
        committedAt: next.meta.committedAt,
      });
      await recovery.confirmCommittedDelta(next);
      await store.close();

      // Simulate WebView origin eviction after the database commit.
      await IndexedDbStatePocStore.delete(databaseName);
      const rebuilt = await recovery.rebuild();
      expect(await canonicalEnvelopeDigest(rebuilt))
        .toBe(await canonicalEnvelopeDigest(next));
      expect(rebuilt.meta.commitSeq).toBe(4);

      await rebuiltStore.importEnvelope(rebuilt);
      await rebuiltStore.close();
      const reopened = new IndexedDbStatePocStore(rebuiltDatabaseName);
      expect(await canonicalEnvelopeDigest(await reopened.loadReadyEnvelope()))
        .toBe(await canonicalEnvelopeDigest(next));
      await reopened.close();
    } finally {
      await store.close();
      await rebuiltStore.close();
      await IndexedDbStatePocStore.delete(databaseName);
      await IndexedDbStatePocStore.delete(rebuiltDatabaseName);
    }
  });

  it("reconciles a committed database transaction after its response is lost", async () => {
    const source = createLargeV2Envelope(100);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    const databaseName = uniqueDatabaseName("commit-response-lost");
    const store = new IndexedDbStatePocStore(databaseName);
    try {
      await recovery.publishCheckpoint(source);
      await recovery.prepareDelta(source, next);
      await store.importEnvelope(source);
      const { intent, receipt } = mutationFacts(source);
      await store.beginMutationIntent(intent);
      await store.recordMutationReceipt(receipt);
      await expect(store.finalizeMutation({
        operationId: intent.operationId,
        remoteNode: next.remoteIndex.itemsById["file-00000"]!,
        anchor: next.anchors.byAnchorId["file:file-00000"]!,
        committedAt: next.meta.committedAt,
        failpoint: "after-commit-response-lost",
      })).rejects.toThrow("after-commit-response-lost");
      await store.close();

      const reopened = new IndexedDbStatePocStore(databaseName);
      const committed = await reopened.loadReadyEnvelope();
      expect(await canonicalEnvelopeDigest(committed))
        .toBe(await canonicalEnvelopeDigest(next));
      await recovery.confirmCommittedDelta(committed);
      await reopened.close();

      await IndexedDbStatePocStore.delete(databaseName);
      expect(await canonicalEnvelopeDigest(await recovery.rebuild()))
        .toBe(await canonicalEnvelopeDigest(next));
    } finally {
      await store.close();
      await IndexedDbStatePocStore.delete(databaseName);
    }
  });

  it("rolls forward an exact record after staged-write or rename-response loss", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");

    const stagedFiles = new MemoryRecoveryAdapter();
    const staged = recoveryStore(stagedFiles);
    stagedFiles.failAfterWrite.add(
      `${staged.checkpointPath(source.meta.commitSeq)}.next`,
    );
    await expect(staged.publishCheckpoint(source)).rejects.toThrow(
      "response loss after write",
    );
    expect(await canonicalEnvelopeDigest(await staged.rebuild()))
      .toBe(await canonicalEnvelopeDigest(source));

    const preparedFiles = new MemoryRecoveryAdapter();
    const prepared = recoveryStore(preparedFiles);
    await prepared.publishCheckpoint(source);
    preparedFiles.failAfterWrite.add(`${prepared.deltaPath(4)}.next`);
    await expect(prepared.prepareDelta(source, next)).rejects.toThrow(
      "response loss after write",
    );
    await expect(prepared.rebuild()).rejects.toThrow(
      "prepared delta has no commit witness",
    );
    await prepared.confirmCommittedDelta(next);
    expect(await canonicalEnvelopeDigest(await prepared.rebuild()))
      .toBe(await canonicalEnvelopeDigest(next));

    const renamedFiles = new MemoryRecoveryAdapter();
    const renamed = recoveryStore(renamedFiles);
    await renamed.publishCheckpoint(source);
    renamedFiles.failAfterRename.add(renamed.deltaPath(4));
    await expect(renamed.prepareDelta(source, next)).rejects.toThrow(
      "response loss after rename",
    );
    renamedFiles.failAfterRename.add(renamed.commitWitnessPath(4));
    await expect(renamed.confirmCommittedDelta(next)).rejects.toThrow(
      "response loss after rename",
    );
    expect(await canonicalEnvelopeDigest(await renamed.rebuild()))
      .toBe(await canonicalEnvelopeDigest(next));
  });

  it("blocks a deleted database when a prepared delta has no commit witness", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.publishCheckpoint(source);
    await recovery.prepareDelta(source, next);

    await expect(recovery.rebuild()).rejects.toThrow(
      "prepared delta has no commit witness",
    );
  });

  it("protects the exact active checkpoint before retiring one unwitnessed future delta", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.prepareDelta(source, next);
    const sourceDigest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(source);
    let reverifyCount = 0;

    await expect(recovery.retireUncommittedFutureDelta(
      source,
      sourceDigest,
      async () => {
        reverifyCount += 1;
      },
    )).resolves.toBe(true);

    expect(reverifyCount).toBe(2);
    expect(files.files.has(recovery.deltaPath(next.meta.commitSeq)))
      .toBe(false);
    expect(files.files.has(recovery.checkpointPath(source.meta.commitSeq)))
      .toBe(true);
    expect(await recovery.rebuild()).toEqual(source);
  });

  it("fails closed instead of retiring a witnessed, mismatched, or gapped future delta", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const afterNext = nextEnvelope(next, "c".repeat(64), "etag-after");
    const sourceDigest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(source);

    const witnessedFiles = new MemoryRecoveryAdapter();
    const witnessed = recoveryStore(witnessedFiles);
    await witnessed.publishCheckpoint(source);
    await witnessed.prepareDelta(source, next);
    await witnessed.confirmCommittedDelta(next);
    await expect(witnessed.retireUncommittedFutureDelta(
      source,
      sourceDigest,
      async () => undefined,
    )).rejects.toThrow("future commit witness blocks");
    expect(witnessedFiles.files.has(witnessed.deltaPath(next.meta.commitSeq)))
      .toBe(true);

    const mismatchedFiles = new MemoryRecoveryAdapter();
    const mismatched = recoveryStore(mismatchedFiles);
    await mismatched.prepareDelta(source, next);
    await expect(mismatched.retireUncommittedFutureDelta(
      source,
      "0".repeat(64),
      async () => undefined,
    )).rejects.toThrow("active envelope digest does not match");
    expect(mismatchedFiles.files.has(mismatched.deltaPath(next.meta.commitSeq)))
      .toBe(true);

    const gappedFiles = new MemoryRecoveryAdapter();
    const gapped = recoveryStore(gappedFiles);
    await gapped.prepareDelta(source, next);
    await gapped.prepareDelta(next, afterNext);
    await gappedFiles.remove(gapped.deltaPath(next.meta.commitSeq));
    await expect(gapped.retireUncommittedFutureDelta(
      source,
      sourceDigest,
      async () => undefined,
    )).rejects.toThrow("gap or branch");
    expect(gappedFiles.files.has(gapped.deltaPath(afterNext.meta.commitSeq)))
      .toBe(true);
  });

  it("fails closed when committed and staged future bytes disagree", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.prepareDelta(source, next);
    const target = recovery.deltaPath(next.meta.commitSeq);
    await files.write(`${target}.next`, `${await files.read(target)} `);

    await expect(recovery.retireUncommittedFutureDelta(
      source,
      await stateV2IndexedDbRecoveryEnvelopeDigest(source),
      async () => undefined,
    )).rejects.toThrow("committed and staged records differ");
    expect(files.files.has(target)).toBe(true);
  });

  it("resumes exact checkpoint publication and delete response loss", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    const sourceDigest =
      await stateV2IndexedDbRecoveryEnvelopeDigest(source);
    await recovery.prepareDelta(source, next);
    files.failAfterWrite.add(
      `${recovery.checkpointPath(source.meta.commitSeq)}.next`,
    );

    await expect(recovery.retireUncommittedFutureDelta(
      source,
      sourceDigest,
      async () => undefined,
    )).rejects.toThrow("response loss after write");
    files.failAfterRemove.add(recovery.deltaPath(next.meta.commitSeq));
    await expect(recovery.retireUncommittedFutureDelta(
      source,
      sourceDigest,
      async () => undefined,
    )).resolves.toBe(true);

    expect(files.files.has(recovery.deltaPath(next.meta.commitSeq)))
      .toBe(false);
    expect(await recovery.rebuild()).toEqual(source);
  });

  it("rejects a missing middle record instead of guessing across a gap", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const afterNext = nextEnvelope(next, "c".repeat(64), "etag-after");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.publishCheckpoint(source);
    await recovery.prepareDelta(source, next);
    await recovery.confirmCommittedDelta(next);
    await recovery.prepareDelta(next, afterNext);
    await recovery.confirmCommittedDelta(afterNext);
    await files.remove(recovery.deltaPath(4));

    await expect(recovery.rebuild()).rejects.toThrow(
      "commit witness is missing its delta",
    );
  });

  it("rejects a tampered recovery record before rebuilding any authority", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.publishCheckpoint(source);
    await recovery.prepareDelta(source, next);
    await recovery.confirmCommittedDelta(next);
    const path = recovery.deltaPath(4);
    const tampered = JSON.parse(await files.read(path)) as {
      nextEnvelopeDigest: string;
    };
    tampered.nextEnvelopeDigest = "0".repeat(64);
    await files.write(path, JSON.stringify(tampered));

    await expect(recovery.rebuild()).rejects.toThrow(
      "record digest does not match",
    );
  });

  it("recovers an interrupted compaction and ignores covered old deltas", async () => {
    const source = createLargeV2Envelope(10);
    const next = nextEnvelope(source, "b".repeat(64), "etag-next");
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.publishCheckpoint(source);
    await recovery.prepareDelta(source, next);
    await recovery.confirmCommittedDelta(next);
    await expect(recovery.shouldCompact(next.meta.commitSeq, 3))
      .resolves.toBe(true);
    await expect(recovery.shouldCompact(next.meta.commitSeq, 4))
      .resolves.toBe(false);
    files.failAfterWrite.add(
      `${recovery.checkpointPath(next.meta.commitSeq)}.next`,
    );
    await expect(recovery.compact(next)).rejects.toThrow(
      "response loss after write",
    );

    expect(await canonicalEnvelopeDigest(await recovery.rebuild()))
      .toBe(await canonicalEnvelopeDigest(next));
    await recovery.compact(next);
    expect(files.files.has(recovery.deltaPath(4))).toBe(false);
    expect(files.files.has(recovery.commitWitnessPath(4))).toBe(false);
    expect(files.files.has(recovery.checkpointPath(3))).toBe(false);
    expect(files.files.has(recovery.checkpointPath(4))).toBe(true);
    await expect(recovery.shouldCompact(next.meta.commitSeq, 1))
      .resolves.toBe(false);
  });

  it("replays a header-only state commit without rewriting identity rows", async () => {
    const source = createLargeV2Envelope(100);
    const next = structuredClone(source);
    next.meta = {
      ...next.meta,
      commitSeq: 4,
      committedAt: 2,
    };
    next.remoteIndex = {
      ...next.remoteIndex,
      cursorRevision: 2,
      deltaLink: "delta-next",
    };
    const files = new MemoryRecoveryAdapter();
    const recovery = recoveryStore(files);
    await recovery.publishCheckpoint(source);
    await recovery.prepareDelta(source, next);
    await recovery.confirmCommittedDelta(next);
    const delta = JSON.parse(await files.read(recovery.deltaPath(4))) as {
      remoteNodeUpserts: unknown[];
      anchorUpserts: unknown[];
      folderAnchorUpserts: unknown[];
    };
    expect(delta.remoteNodeUpserts).toEqual([]);
    expect(delta.anchorUpserts).toEqual([]);
    expect(delta.folderAnchorUpserts).toEqual([]);
    expect(await canonicalEnvelopeDigest(await recovery.rebuild()))
      .toBe(await canonicalEnvelopeDigest(next));
  });
});

function nextEnvelope(
  source: SyncStateEnvelopeV2,
  contentHash: string,
  eTag: string,
): SyncStateEnvelopeV2 {
  const next = structuredClone(source);
  next.meta = {
    ...next.meta,
    commitSeq: source.meta.commitSeq + 1,
    committedAt: source.meta.committedAt + 1,
  };
  next.remoteIndex.itemsById["file-00000"] = {
    ...next.remoteIndex.itemsById["file-00000"]!,
    size: 2,
    eTag,
    contentHash,
  };
  next.anchors.byAnchorId["file:file-00000"] = {
    ...next.anchors.byAnchorId["file:file-00000"]!,
    size: 2,
    remoteETag: eTag,
    contentHash,
    confirmedAt: next.meta.committedAt,
    confirmedBy: "upload-cas",
  };
  return next;
}

function mutationFacts(source: SyncStateEnvelopeV2): {
  intent: MutationIntentV1;
  receipt: MutationReceiptV1;
} {
  const operationId = "poc-upload-00000";
  return {
    intent: {
      version: 1,
      operationId,
      planRevision: source.meta.commitSeq,
      scope: { ...LARGE_V2_FIXTURE_SCOPE },
      action: "upload",
      path: "Bulk/note-00000.md",
      expectedLocal: {
        exists: true,
        hash: "b".repeat(64),
        size: 2,
      },
      expectedRemote: {
        exists: true,
        driveId: "file-00000",
        eTag: "etag-00000",
        size: 1,
        sha256Hash: "a".repeat(64),
      },
      createdAt: 10,
    },
    receipt: {
      version: 1,
      operationId,
      completedAt: 11,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    },
  };
}

function recoveryStore(
  adapter: MemoryRecoveryAdapter,
): StateV2IndexedDbRecoveryStore {
  return new StateV2IndexedDbRecoveryStore(
    adapter as unknown as DataAdapter,
    "recovery",
  );
}

function uniqueDatabaseName(label: string): string {
  return `easy-sync-indexeddb-recovery-poc-${label}-${Date.now()}-${Math.random()}`;
}
