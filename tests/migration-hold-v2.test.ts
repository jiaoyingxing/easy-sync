import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  migrationHoldReviewKindV2,
  MigrationHoldV2Store,
  type MigrationHoldV2Paths,
} from "../src/sync/migration-hold-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import {
  SyncActionType,
  type CanonicalPlanIdentityV2,
  type SyncPlanItem,
} from "../src/sync/types";
import { canonicalPlanDigestV2 } from "../src/sync/canonical-plan-v2";
import type {
  CommunityPluginEnablementMigrationCarrierV2,
} from "../src/sync/community-plugin-enablement";

const paths: MigrationHoldV2Paths = {
  committed: "plugin/state-v2.migration-hold.json",
  next: "plugin/state-v2.migration-hold.next.json",
};
const scope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "root",
};
const protocolBinding = {
  schemaVersion: 1 as const,
  protocolVersion: 2 as const,
  migrationGeneration: "a".repeat(64),
  confirmedAllDevicesUpdatedAt: 1900,
  recordId: "protocol-id",
  recordETag: "protocol-etag",
};
const protocolBindingV3 = {
  schemaVersion: 1 as const,
  protocolVersion: 3 as const,
  migrationGeneration: protocolBinding.migrationGeneration,
  predecessorProtocolVersion: 2 as const,
  predecessorContentSha256: "b".repeat(64),
  predecessorConfirmedAllDevicesUpdatedAt:
    protocolBinding.confirmedAllDevicesUpdatedAt,
  createdAt: 1950,
  contentSha256: "c".repeat(64),
  recordId: "protocol-v3-id",
  recordETag: "protocol-v3-etag",
};

function makeAdapter() {
  const files = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
  };
  return {
    adapter: adapter as unknown as DataAdapter,
    files,
    spies: adapter,
  };
}

function candidate(now = 1000): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 8,
      commitSeq: 1,
      committedAt: now,
    },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 1,
      deltaLink: null,
      complete: true,
      itemsById: {
        notes: {
          id: "notes",
          parentId: scope.filesRootId,
          name: "Notes",
          kind: "folder",
          eTag: "etag-notes",
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {},
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: {},
    },
  };
}

function identity(
  digest = canonicalPlanDigestV2({
    items,
    lastTotalFiles: 1,
    scope,
    sourceCommitSeq: 1,
  }),
): CanonicalPlanIdentityV2 {
  return {
    version: 2,
    scope,
    sourceCommitSeq: 1,
    digest,
  };
}

const items: SyncPlanItem[] = [{
  type: SyncActionType.CreateRemoteFolder,
  path: "Empty",
  folder: {
    parentRemoteId: scope.filesRootId,
    parentPath: "",
  },
}];
const review = {
  counts: {
    uploads: 0,
    downloads: 0,
    folders: 1,
    deletes: 0,
    conflicts: 0,
    skipped: 0,
  },
  impactCount: 1,
};
const sourceStateDigest = "1".repeat(64);
const communityPluginEnablement: CommunityPluginEnablementMigrationCarrierV2 = {
  version: 1,
  scope,
  source: {
    path: ".obsidian/community-plugins.json",
    selectedPluginIds: ["calendar"],
    local: {
      exists: true,
      contentHash: "a".repeat(64),
    },
    remote: {
      exists: true,
      contentHash: "b".repeat(64),
      remoteId: "community-plugins",
      eTag: "etag-community-plugins",
    },
  },
  anchors: {},
  pending: [{
    pluginId: "calendar",
    localEnabled: false,
    remoteEnabled: true,
  }],
  resolved: [],
};

describe("MigrationHoldV2Store", () => {
  it("publishes a complete candidate and review through a read-back-verified two-slot record", async () => {
    const { adapter, files } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);

    const hold = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      now: 2000,
    });

    expect(hold).toMatchObject({
      schemaVersion: 1,
      kind: "state-v2-migration-hold",
      revision: 1,
      phase: "pending",
      createdAt: 2000,
      updatedAt: 2000,
      scope,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items: [{
        type: SyncActionType.CreateRemoteFolder,
        path: "Empty",
        folderParentRemoteId: scope.filesRootId,
        folderParentPath: "",
      }],
    });
    expect(files.has(paths.committed)).toBe(true);
    expect(files.has(paths.next)).toBe(false);
    expect(await store.load()).toEqual(hold);
    expect(migrationHoldReviewKindV2(hold)).toBe("v2-migration");
  });

  it("persists cloud-join classification without changing the hold schema", async () => {
    const { adapter } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);

    const hold = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      reviewKind: "v2-cloud-join",
      now: 2000,
    });

    expect(hold.reviewKind).toBe("v2-cloud-join");
    expect(migrationHoldReviewKindV2(hold)).toBe("v2-cloud-join");
    expect((await store.load())?.reviewKind).toBe("v2-cloud-join");
  });

  it("checkpoints the exact V2 binding on a pending first-sync hold and keeps an exact repeat idempotent", async () => {
    const { adapter, spies } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const pending = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      reviewKind: "v2-first-sync",
      now: 2000,
    });

    const checkpoint = await store.checkpointPendingProtocolBinding(
      pending.revision,
      pending.canonicalIdentity,
      protocolBinding,
      2100,
    );

    expect(checkpoint).toMatchObject({
      phase: "pending",
      reviewKind: "v2-first-sync",
      revision: pending.revision + 1,
      createdAt: pending.createdAt,
      updatedAt: 2100,
      protocolBinding,
    });
    expect(await store.load()).toEqual(checkpoint);
    const writesAfterCheckpoint = spies.write.mock.calls.length;

    const repeated = await store.checkpointPendingProtocolBinding(
      checkpoint!.revision,
      checkpoint!.canonicalIdentity,
      protocolBinding,
      2200,
    );

    expect(repeated).toEqual(checkpoint);
    expect(repeated?.revision).toBe(pending.revision + 1);
    expect(spies.write).toHaveBeenCalledTimes(writesAfterCheckpoint);
  });

  it("rejects a stale checkpoint revision and a different binding without changing the pending hold", async () => {
    const { adapter, spies } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const pending = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      reviewKind: "v2-first-sync",
      now: 2000,
    });

    await expect(store.checkpointPendingProtocolBinding(
      pending.revision - 1,
      pending.canonicalIdentity,
      protocolBinding,
      2050,
    )).resolves.toBeNull();
    const checkpoint = await store.checkpointPendingProtocolBinding(
      pending.revision,
      pending.canonicalIdentity,
      protocolBinding,
      2100,
    );
    const writesAfterCheckpoint = spies.write.mock.calls.length;

    await expect(store.checkpointPendingProtocolBinding(
      checkpoint!.revision,
      checkpoint!.canonicalIdentity,
      {
        ...protocolBinding,
        recordETag: "different-protocol-etag",
      },
      2200,
    )).resolves.toBeNull();
    expect(await store.load()).toEqual(checkpoint);
    expect(spies.write).toHaveBeenCalledTimes(writesAfterCheckpoint);
  });

  it("rejects a pending protocol checkpoint outside a first-sync V2 transaction", async () => {
    const { adapter } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const cloudJoin = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      reviewKind: "v2-cloud-join",
      now: 2000,
    });

    await expect(store.checkpointPendingProtocolBinding(
      cloudJoin.revision,
      cloudJoin.canonicalIdentity,
      protocolBinding,
      2100,
    )).resolves.toBeNull();
    expect(await store.load()).toEqual(cloudJoin);

    const firstSync = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      reviewKind: "v2-first-sync",
      now: 2200,
    });
    await expect(store.checkpointPendingProtocolBinding(
      firstSync.revision,
      firstSync.canonicalIdentity,
      protocolBindingV3 as never,
      2300,
    )).resolves.toBeNull();
    expect(await store.load()).toEqual(firstSync);
  });

  it.each([
    [
      "a non-first-sync review kind",
      { reviewKind: "v2-cloud-join", protocolBinding },
    ],
    [
      "a V3 checkpoint binding",
      { reviewKind: "v2-first-sync", protocolBinding: protocolBindingV3 },
    ],
  ] as const)("rejects a persisted pending hold with %s", async (_label, patch) => {
    const { adapter, files } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const pending = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      reviewKind: "v2-first-sync",
      now: 2000,
    });
    files.set(paths.committed, JSON.stringify({
      ...pending,
      ...patch,
    }));

    await expect(store.load()).rejects.toThrow();
  });

  it("does not create a new revision for the same semantic candidate", async () => {
    const { adapter, spies } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const first = await store.publishPending({
      candidate: candidate(1000),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      now: 2000,
    });
    const writes = spies.write.mock.calls.length;

    const second = await store.publishPending({
      candidate: candidate(9999),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      now: 3000,
    });

    expect(second.revision).toBe(first.revision);
    expect(spies.write).toHaveBeenCalledTimes(writes);
  });

  it("creates a new pending revision when non-plan source state changed", async () => {
    const { adapter } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const first = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      now: 2000,
    });

    const second = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest: "2".repeat(64),
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      now: 3000,
    });

    expect(second).toMatchObject({
      revision: first.revision + 1,
      phase: "pending",
      sourceStateDigest: "2".repeat(64),
    });
  });

  it("uses revision and sealed identity as the phase-transition CAS", async () => {
    const { adapter } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const pending = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      now: 2000,
    });

    await expect(store.confirm(
      pending.revision,
      identity("other"),
      protocolBinding,
      2100,
    )).resolves.toBeNull();
    const confirmed = await store.confirm(
      pending.revision,
      identity(),
      protocolBinding,
      2200,
    );
    expect(confirmed).toMatchObject({
      revision: 2,
      phase: "confirmed",
      createdAt: 2000,
      updatedAt: 2200,
      protocolBinding,
    });
    await expect(store.transition(
      pending.revision,
      identity(),
      "authority-committed",
    )).resolves.toBeNull();
    await expect(store.transition(
      confirmed!.revision,
      identity(),
      "authority-committed",
      2300,
    )).resolves.toMatchObject({
      revision: 3,
      phase: "authority-committed",
    });
  });

  it("retires a legacy enablement carrier without changing the review", async () => {
    const { adapter } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const carrier: CommunityPluginEnablementMigrationCarrierV2 = {
      ...communityPluginEnablement,
      source: {
        ...communityPluginEnablement.source,
        selectedPluginIds: ["calendar", "quickadd"],
      },
      pending: [
        ...communityPluginEnablement.pending,
        {
          pluginId: "quickadd",
          localEnabled: true,
          remoteEnabled: false,
        },
      ],
    };
    const pending = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      communityPluginEnablement: carrier,
      now: 2000,
    });
    const retired = await store.retireCommunityPluginEnablementCarrier(2100);
    expect(retired).toMatchObject({
      revision: pending.revision + 1,
      canonicalIdentity: pending.canonicalIdentity,
      canonicalReview: pending.canonicalReview,
      items: pending.items,
    });
    expect(retired?.communityPluginEnablement).toBeUndefined();
  });

  it("confirms after the legacy enablement carrier is retired", async () => {
    const { adapter } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const pending = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      communityPluginEnablement,
    });

    const retired = await store.retireCommunityPluginEnablementCarrier();
    await expect(store.confirm(
      retired!.revision,
      retired!.canonicalIdentity,
      protocolBinding,
    )).resolves.toMatchObject({ phase: "confirmed" });
  });

  it("recovers a newer staged revision after interruption", async () => {
    const { adapter, files } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const pending = await store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
      now: 2000,
    });
    files.set(paths.next, JSON.stringify({
      ...pending,
      revision: 2,
      phase: "confirmed",
      updatedAt: 2200,
      protocolBinding,
    }));

    await expect(store.load()).resolves.toMatchObject({
      revision: 2,
      phase: "confirmed",
    });
    expect(files.has(paths.next)).toBe(false);
    expect(JSON.parse(files.get(paths.committed)!)).toMatchObject({
      revision: 2,
      phase: "confirmed",
    });
  });

  it("rejects an incomplete candidate before writing a hold", async () => {
    const { adapter, files } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);
    const incomplete = candidate();
    delete incomplete.folderAnchors;

    await expect(store.publishPending({
      candidate: incomplete,
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items,
      lastTotalFiles: 1,
    })).rejects.toThrow("not bound");
    expect(files.size).toBe(0);
  });

  it("rejects review actions that do not match the sealed identity", async () => {
    const { adapter, files } = makeAdapter();
    const store = new MigrationHoldV2Store(adapter, paths);

    await expect(store.publishPending({
      candidate: candidate(),
      sourceStateDigest,
      canonicalIdentity: identity(),
      canonicalReview: review,
      items: [{
        ...items[0],
        path: "Different",
      }],
      lastTotalFiles: 1,
    })).rejects.toThrow("not bound");
    expect(files.size).toBe(0);
  });
});
