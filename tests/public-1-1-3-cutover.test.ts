import { describe, expect, it } from "vitest";
import {
  finalizePublic113PluginDataCutover,
  KEY_PUBLIC_113_CUTOVER,
} from "../src/sync/public-1-1-3-cutover";

const digest = "a".repeat(64);
describe("public 1.1.3 PluginData cutover", () => {
  it("retires stale decisions and moves the public ledger to the V2 recovery key", () => {
    const mutationLedger = [{
      intent: {
        version: 1,
        operationId: "pending-operation",
      },
      receipt: null,
    }];
    const source = {
      "sync-interval": 3,
      "sync-auto-conflict-policy": {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      "easy-sync-profile-cache": {
        displayName: "Fixture",
        accountId: "account",
      },
      "easy-sync-bound-account": "account",
      "easy-sync-base-snapshot": {
        "note.md": { path: "note.md", hash: digest, size: 1, eTag: "etag" },
      },
      "easy-sync-last-sync-time": 123,
      "easy-sync-history": [{ id: "history" }],
      "easy-sync-mutation-ledger": mutationLedger,
      "easy-sync-pending-conflicts": [{ path: "conflict.md" }],
      "easy-sync-pending-remote-deletes": [{ path: "deleted.md" }],
      "easy-sync-pending-issues": [{ path: "retry.md" }],
      "easy-sync-plan-review-active": true,
      "easy-sync-plan-review-counts": { conflicts: 1 },
      "easy-sync-plan-review-items": [{ path: "conflict.md" }],
      "easy-sync-plan-review-digest": "old-review",
      "easy-sync-plan-review-revision": 12,
      "easy-sync-plan-review-scope": { accountId: "account" },
      "easy-sync-plan-review-canonical-identity-v2": { digest: "old" },
      "easy-sync-local-folder-move-hints": [{ remoteId: "folder" }],
      "release-1.1.3-unknown-key": { mustSurvive: true },
    };

    const result = finalizePublic113PluginDataCutover({
      pluginData: source,
      sourceStateDigest: digest,
      finalizedAt: 456,
    });

    expect(result.pluginData).toEqual(expect.objectContaining({
      "sync-interval": source["sync-interval"],
      "sync-auto-conflict-policy": source["sync-auto-conflict-policy"],
      "easy-sync-profile-cache": source["easy-sync-profile-cache"],
      "easy-sync-bound-account": source["easy-sync-bound-account"],
      "easy-sync-base-snapshot": {},
      "easy-sync-last-sync-time": source["easy-sync-last-sync-time"],
      "easy-sync-history": source["easy-sync-history"],
      "easy-sync-mutation-ledger": [],
      "easy-sync-v2-mutation-ledger": mutationLedger,
      "release-1.1.3-unknown-key": { mustSurvive: true },
      "easy-sync-pending-conflicts": [],
      "easy-sync-pending-remote-deletes": [],
      "easy-sync-pending-issues": [],
      "easy-sync-plan-review-active": false,
      "easy-sync-plan-review-counts": null,
      "easy-sync-plan-review-items": [],
      "easy-sync-plan-review-digest": "",
      "easy-sync-plan-review-revision": 13,
      "easy-sync-plan-review-scope": null,
      "easy-sync-plan-review-canonical-identity-v2": null,
      "easy-sync-local-folder-move-hints": [],
    }));
    expect(result.marker).toEqual({
      version: 2,
      kind: "public-1.1.3-cutover",
      sourceStateDigest: digest,
      finalizedAt: 456,
      importedLegacyMutationRecords: 1,
      retired: {
        conflicts: 1,
        remoteDeletes: 1,
        issues: 1,
        reviewActive: true,
        localFolderMoveHints: 1,
      },
    });
    expect(result.pluginData[KEY_PUBLIC_113_CUTOVER]).toEqual(result.marker);
    expect(source[KEY_PUBLIC_113_CUTOVER as keyof typeof source]).toBeUndefined();
  });

  it("is idempotent for the same source and rejects a different source", () => {
    const first = finalizePublic113PluginDataCutover({
      pluginData: {},
      sourceStateDigest: digest,
      finalizedAt: 1,
    });
    const repeated = finalizePublic113PluginDataCutover({
      pluginData: {
        ...first.pluginData,
        "easy-sync-base-snapshot": {
          "leftover.md": {
            path: "leftover.md",
            hash: digest,
            size: 1,
            eTag: "etag",
          },
        },
      },
      sourceStateDigest: digest,
      finalizedAt: 2,
    });

    expect(repeated.marker).toEqual(first.marker);
    expect(repeated.pluginData["easy-sync-base-snapshot"]).toEqual({});
    expect(() => finalizePublic113PluginDataCutover({
      pluginData: first.pluginData,
      sourceStateDigest: "b".repeat(64),
      finalizedAt: 3,
    })).toThrow(/another migration input/);
  });

  it("finishes the ledger-key migration for an already finalized older V2 build", () => {
    const ledger = [{ intent: { operationId: "legacy-active" }, receipt: null }];
    const first = finalizePublic113PluginDataCutover({
      pluginData: { "easy-sync-mutation-ledger": ledger },
      sourceStateDigest: digest,
      finalizedAt: 1,
    });
    const legacyActive = {
      ...first.pluginData,
      "easy-sync-mutation-ledger": ledger,
      "easy-sync-v2-mutation-ledger": [],
    };

    const migrated = finalizePublic113PluginDataCutover({
      pluginData: legacyActive,
      sourceStateDigest: digest,
      finalizedAt: 2,
    });

    expect(migrated.pluginData["easy-sync-mutation-ledger"]).toEqual([]);
    expect(migrated.pluginData["easy-sync-v2-mutation-ledger"]).toEqual(ledger);
    expect(migrated.marker).toEqual(first.marker);
  });

  it("does not publish the retired enablement projection", () => {
    const result = finalizePublic113PluginDataCutover({
      pluginData: {
        "community-plugin-enablement-state": {
          version: 1,
          anchors: { "startup-optimizer": false },
          pending: [],
        },
      },
      sourceStateDigest: digest,
      finalizedAt: 1,
    });

    expect(result.pluginData["community-plugin-enablement-state"])
      .toBeUndefined();
  });
});
