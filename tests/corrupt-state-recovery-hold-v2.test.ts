import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  canonicalPlanDigestV2,
  summarizeCanonicalPlanReviewV2,
} from "../src/sync/canonical-plan-v2";
import {
  CorruptStateRecoveryHoldV2Store,
} from "../src/sync/corrupt-state-recovery-hold-v2";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import {
  SyncActionType,
  type SyncPlanItem,
  type SyncScope,
} from "../src/sync/types";

const paths = {
  committed: ".obsidian/plugins/easy-sync/state-v2.corrupt-recovery.json",
  next: ".obsidian/plugins/easy-sync/state-v2.corrupt-recovery.next.json",
};
const scope: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};
const sourceDigest = "a".repeat(64);

function candidate(commitSeq = 4): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 3,
      commitSeq,
      committedAt: 4,
    },
    scope,
    remoteIndex: {
      schemaVersion: 2,
      filesRootId: scope.filesRootId,
      cursorRevision: 1,
      deltaLink: "delta",
      complete: true,
      itemsById: {},
    },
    anchors: { schemaVersion: 2, byAnchorId: {} },
    folderAnchors: { schemaVersion: 2, byAnchorId: {} },
  };
}

function input(items: SyncPlanItem[] = []) {
  const state = candidate();
  const canonicalIdentity = {
    version: 2 as const,
    scope,
    sourceCommitSeq: state.meta.commitSeq,
    digest: canonicalPlanDigestV2({
      items,
      lastTotalFiles: 1,
      scope,
      sourceCommitSeq: state.meta.commitSeq,
    }),
  };
  return {
    sourceDigest,
    sourceCommitSeq: 3,
    sourceLifecycleEpoch: 2,
    corruption: "anchors" as const,
    scope,
    candidate: state,
    canonicalIdentity,
    canonicalReview: summarizeCanonicalPlanReviewV2(items),
    lastTotalFiles: 1,
    items,
    now: 10,
  };
}

function makeStore() {
  const files = new Map<string, string>();
  let loseWriteResponse = false;
  let loseRenameResponse = false;
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
      if (loseWriteResponse) {
        loseWriteResponse = false;
        throw new Error("write response lost");
      }
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
      if (loseRenameResponse) {
        loseRenameResponse = false;
        throw new Error("rename response lost");
      }
    }),
  } as unknown as DataAdapter;
  return {
    files,
    store: new CorruptStateRecoveryHoldV2Store(adapter, paths),
    loseWrite: () => { loseWriteResponse = true; },
    loseRename: () => { loseRenameResponse = true; },
  };
}

describe("CorruptStateRecoveryHoldV2Store", () => {
  it("publishes and confirms one source-bound canonical review", async () => {
    const { store } = makeStore();
    const pending = await store.publishPending(input());
    const confirmed = await store.confirm(pending.canonicalIdentity, 11);

    expect(pending).toMatchObject({ revision: 1, phase: "pending" });
    expect(confirmed).toMatchObject({
      revision: 2,
      phase: "confirmed",
      sourceDigest,
    });
    await expect(store.load()).resolves.toEqual(confirmed);
  });

  it.each(["write", "rename"] as const)(
    "accepts %s response loss only after exact read-back",
    async (loss) => {
      const harness = makeStore();
      if (loss === "write") harness.loseWrite();
      else harness.loseRename();

      const hold = await harness.store.publishPending(input());

      expect(hold.phase).toBe("pending");
      expect(harness.files.has(paths.committed)).toBe(true);
      expect(harness.files.has(paths.next)).toBe(false);
    },
  );

  it("promotes an exact higher staged revision after restart", async () => {
    const harness = makeStore();
    const pending = await harness.store.publishPending(input());
    const staged = {
      ...pending,
      revision: 2,
      phase: "confirmed",
      updatedAt: 11,
    };
    harness.files.set(paths.next, JSON.stringify(staged));

    await expect(harness.store.load()).resolves.toEqual(staged);
    expect(harness.files.has(paths.next)).toBe(false);
  });

  it("rejects a damaged or fact-inconsistent control record", async () => {
    const harness = makeStore();
    harness.files.set(paths.committed, JSON.stringify({
      ...(await harness.store.publishPending(input())),
      sourceCommitSeq: 99,
    }));

    await expect(harness.store.load()).rejects.toThrow(
      "facts are inconsistent",
    );
  });

  it("replaces a confirmed stale review with a higher pending revision", async () => {
    const harness = makeStore();
    const pending = await harness.store.publishPending(input());
    await harness.store.confirm(pending.canonicalIdentity);
    const items: SyncPlanItem[] = [{
      type: SyncActionType.Download,
      path: "new.md",
      reason: "reason.remoteOnly",
    }];

    const replacement = await harness.store.publishPending(input(items));

    expect(replacement).toMatchObject({
      revision: 3,
      phase: "pending",
    });
    expect(replacement.items).toEqual(items);
  });
});
