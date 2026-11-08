import { describe, expect, it } from "vitest";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import { validateEnvelope } from "../src/sync/state-envelope-v2";
import { canonicalPlannerStateFromEnvelopeV2 } from "../src/sync/canonical-planner-state-v2";

function envelope(commitSeq = 1): SyncStateEnvelopeV2 {
  return {
    meta: {
      schemaVersion: 2,
      lifecycleEpoch: 3,
      commitSeq,
      committedAt: 1000 + commitSeq,
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
      cursorRevision: commitSeq,
      deltaLink: `delta-${commitSeq}`,
      complete: true,
      itemsById: {
        folder: {
          id: "folder",
          parentId: "root",
          name: "notes",
          kind: "folder",
        },
        file: {
          id: "file",
          parentId: "folder",
          name: "a.md",
          kind: "file",
          eTag: `e${commitSeq}`,
          size: 1,
          contentHash: "a".repeat(64),
        },
      },
    },
    anchors: {
      schemaVersion: 2,
      byAnchorId: {
        "file:file": {
          anchorId: "file:file",
          remoteId: "file",
          lastPath: "notes/a.md",
          contentHash: "a".repeat(64),
          size: 1,
          remoteETag: `e${commitSeq}`,
          confirmedAt: 1,
          confirmedBy: "equal-read",
        },
      },
    },
    folderAnchors: {
      schemaVersion: 2,
      byAnchorId: {
        "folder:folder": {
          anchorId: "folder:folder",
          remoteId: "folder",
          parentRemoteId: "root",
          lastPath: "notes",
          confirmedGeneration: 1,
          confirmedAt: 1,
        },
      },
    },
  };
}

describe("V2 envelope immutable-snapshot memoization", () => {
  it("validates a repeated exact object once but every new object fully", () => {
    const tracked = (): { value: SyncStateEnvelopeV2; reads: () => number } => {
      let anchorReads = 0;
      const value = new Proxy(envelope(), {
        get(target, property, receiver) {
          if (property === "anchors") anchorReads += 1;
          return Reflect.get(target, property, receiver);
        },
      }) as SyncStateEnvelopeV2;
      return { value, reads: () => anchorReads };
    };

    const first = tracked();
    validateEnvelope(first.value);
    const firstReads = first.reads();
    expect(firstReads).toBeGreaterThan(0);

    validateEnvelope(first.value);
    expect(first.reads()).toBe(firstReads);

    // A distinct object with equal content is not the same snapshot and is
    // validated again (identity, not deep equality, is the cache key).
    const second = tracked();
    validateEnvelope(second.value);
    expect(second.reads()).toBeGreaterThan(0);
  });

  it("keeps rejecting an invalid object on every call", () => {
    const invalid = {
      ...envelope(),
      meta: { schemaVersion: 1 },
    } as unknown as SyncStateEnvelopeV2;
    expect(() => validateEnvelope(invalid)).toThrow();
    expect(() => validateEnvelope(invalid)).toThrow();
  });

  it("reuses the planner projection of the same envelope and rebuilds for a new one", () => {
    const first = envelope(1);
    const stateA = canonicalPlannerStateFromEnvelopeV2(first);
    const stateB = canonicalPlannerStateFromEnvelopeV2(first);
    expect(stateB).toBe(stateA);

    const second = envelope(2);
    const stateC = canonicalPlannerStateFromEnvelopeV2(second);
    expect(stateC).not.toBe(stateA);
    expect(stateC.meta.commitSeq).toBe(2);
  });
});
