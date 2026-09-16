import { describe, expect, it } from "vitest";
import {
  STATE_V1_MIGRATION_CASES,
  migrationCase,
} from "./fixtures/state-v1-migration-cases";
import {
  simulateV1ToV2Migration,
} from "./helpers/state-v2-migration-model";
import {
  describeStateV2MigrationCandidateDriftV1,
  sameStateV2MigrationCandidate,
} from "../src/sync/state-v2-migration";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";

const driftEnvelope = (overrides: Record<string, unknown> = {}) => ({
  meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq: 1, committedAt: 1 },
  scope: {
    accountId: "acc",
    driveId: "drive",
    vaultFolderId: "vault",
    filesRootId: "root",
  },
  remoteIndex: {
    complete: true,
    deltaLink: null,
    cursorRevision: 1,
    itemsById: {} as Record<string, unknown>,
  },
  anchors: { schemaVersion: 2, byAnchorId: {} as Record<string, unknown> },
  ...overrides,
}) as unknown as SyncStateEnvelopeV2;

describe("V2 migration candidate drift diagnostics", () => {
  it("agrees with the commit gate on identical candidates", () => {
    const committed = driftEnvelope();
    const candidate = driftEnvelope();
    expect(sameStateV2MigrationCandidate(committed, candidate)).toBe(true);
    expect(describeStateV2MigrationCandidateDriftV1(committed, candidate))
      .toEqual({
        sameScope: true,
        sameRemoteIndex: true,
        sameAnchors: true,
        sameFolderAnchors: true,
      });
  });

  it("normalizes anchor timestamps away exactly like the commit gate", () => {
    const committed = driftEnvelope();
    const candidate = driftEnvelope({
      anchors: {
        schemaVersion: 2,
        byAnchorId: {
          "cloud:r1": {
            anchorId: "cloud:r1",
            remoteId: "r1",
            lastPath: "a.md",
            contentHash: "aa".repeat(32),
            size: 1,
            confirmedAt: 999,
            confirmedBy: "cloud-verified",
          },
        },
      },
    });
    (committed.anchors.byAnchorId as Record<string, unknown>)["cloud:r1"] = {
      ...(candidate.anchors.byAnchorId["cloud:r1"] as Record<string, unknown>),
      confirmedAt: 1,
    };
    expect(sameStateV2MigrationCandidate(committed, candidate)).toBe(true);
    expect(
      describeStateV2MigrationCandidateDriftV1(committed, candidate).sameAnchors,
    ).toBe(true);
  });

  it("reports anchor drift without blaming the remote index", () => {
    const committed = driftEnvelope();
    const candidate = driftEnvelope({
      anchors: {
        schemaVersion: 2,
        byAnchorId: {
          "cloud:r1": {
            anchorId: "cloud:r1",
            remoteId: "r1",
            lastPath: "a.md",
            contentHash: "aa".repeat(32),
            size: 1,
            confirmedAt: 1,
            confirmedBy: "cloud-verified",
          },
        },
      },
    });
    expect(sameStateV2MigrationCandidate(committed, candidate)).toBe(false);
    expect(describeStateV2MigrationCandidateDriftV1(committed, candidate))
      .toEqual({
        sameScope: true,
        sameRemoteIndex: true,
        sameAnchors: false,
        sameFolderAnchors: true,
      });
  });

  it("reports remote index version drift separately from anchors", () => {
    const anchor = {
      anchorId: "cloud:r1",
      remoteId: "r1",
      lastPath: "a.md",
      contentHash: "aa".repeat(32),
      size: 1,
      confirmedAt: 1,
      confirmedBy: "cloud-verified",
    };
    const committed = driftEnvelope({
      remoteIndex: {
        complete: true,
        deltaLink: null,
        cursorRevision: 1,
        itemsById: {
          r1: {
            id: "r1",
            kind: "file",
            path: "a.md",
            eTag: "etag-1",
            size: 1,
          },
        },
      },
      anchors: { schemaVersion: 2, byAnchorId: { "cloud:r1": anchor } },
    });
    const candidate = driftEnvelope({
      remoteIndex: {
        complete: true,
        deltaLink: null,
        cursorRevision: 1,
        itemsById: {
          r1: {
            id: "r1",
            kind: "file",
            path: "a.md",
            eTag: "etag-2",
            size: 1,
          },
        },
      },
      anchors: { schemaVersion: 2, byAnchorId: { "cloud:r1": anchor } },
    });
    expect(sameStateV2MigrationCandidate(committed, candidate)).toBe(false);
    expect(describeStateV2MigrationCandidateDriftV1(committed, candidate))
      .toEqual({
        sameScope: true,
        sameRemoteIndex: false,
        sameAnchors: true,
        sameFolderAnchors: true,
      });
  });

  it("reports scope drift", () => {
    const committed = driftEnvelope();
    const candidate = driftEnvelope({
      scope: {
        accountId: "acc2",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "root",
      },
    });
    expect(sameStateV2MigrationCandidate(committed, candidate)).toBe(false);
    expect(describeStateV2MigrationCandidateDriftV1(committed, candidate))
      .toEqual({
        sameScope: false,
        sameRemoteIndex: true,
        sameAnchors: true,
        sameFolderAnchors: true,
      });
  });
});

describe("V1 to V2 migration preflight model", () => {
  it("migrates an exact V1 path only when current local and remote versions still match", () => {
    const result = simulateV1ToV2Migration(migrationCase("normal-v1"));
    expect(result.status).toBe("committed");
    expect(result.fullScanUsed).toBe(true);
    expect(result.legacyAutoSyncAllowed).toBe(false);
    expect(result.publishedEnvelope?.anchors.byAnchorId["migrated:remote-a"]).toMatchObject({
      remoteId: "remote-a",
      lastPath: "notes/a.md",
      confirmedBy: "v1-exact",
    });
  });

  it("aborts the whole migration when a remote node has no stable driveItem id", () => {
    const result = simulateV1ToV2Migration(migrationCase("missing-drive-id"));
    expect(result).toMatchObject({
      status: "aborted",
      reason: "remote-identity-incomplete",
      publishedEnvelope: null,
    });
  });

  it("keeps same-hash multi-path candidates pending instead of merging identities", () => {
    const result = simulateV1ToV2Migration(migrationCase("same-hash-multiple-paths"));
    expect(result.status).toBe("committed");
    expect(result.publishedEnvelope?.anchors.byAnchorId).toEqual({});
    expect(result.pending).toEqual([
      { sourcePath: "old.md", reason: "identity-not-unique-or-unverified" },
    ]);
  });

  it("recognizes an already-moved path only from a unique local+remote content match", () => {
    const result = simulateV1ToV2Migration(migrationCase("path-already-moved"));
    expect(result.publishedEnvelope?.anchors.byAnchorId["migrated:remote-moved"]).toMatchObject({
      lastPath: "new/path.md",
      confirmedBy: "v1-unique-content",
    });
    expect(result.mutations).toEqual([]);
  });

  it("seeds a cloud-only hint from local SHA and a cTag-bound remote identity", () => {
    const result = simulateV1ToV2Migration(migrationCase("cloud-baseline-only"));
    expect(result.publishedEnvelope?.anchors.byAnchorId["cloud:remote-cloud"]).toMatchObject({
      contentHash: "bb".repeat(32),
      confirmedBy: "cloud-verified",
    });
  });

  it("discards an invalid V1 delta cursor and builds V2 only from the complete full scan", () => {
    const result = simulateV1ToV2Migration(migrationCase("invalid-delta-link"));
    expect(result.fullScanUsed).toBe(true);
    expect(result.publishedEnvelope?.remoteIndex).toMatchObject({
      complete: true,
      deltaLink: null,
    });
  });

  it("publishes nothing when either local or remote scan is incomplete", () => {
    const localIncomplete = migrationCase("normal-v1");
    localIncomplete.localScanComplete = false;
    const remoteIncomplete = migrationCase("normal-v1");
    remoteIncomplete.remoteScanComplete = false;
    for (const fixture of [localIncomplete, remoteIncomplete]) {
      expect(simulateV1ToV2Migration(fixture)).toMatchObject({
        status: "aborted",
        reason: "scan-incomplete",
        publishedEnvelope: null,
        stagedEnvelope: null,
      });
    }
  });

  it("keeps V1 authoritative when migration is interrupted or envelope save fails", () => {
    for (const fault of ["interrupt-before-publish", "save-failure"] as const) {
      const result = simulateV1ToV2Migration(migrationCase("normal-v1"), fault);
      expect(result.publishedEnvelope).toBeNull();
      expect(result.stagedEnvelope).not.toBeNull();
      expect(result.v1BackupRetained).toBe(true);
      expect(result.legacyAutoSyncAllowed).toBe(true);
    }
  });

  it("never emits file or Graph mutations during any migration fixture", () => {
    for (const fixture of STATE_V1_MIGRATION_CASES) {
      expect(simulateV1ToV2Migration(fixture).mutations).toEqual([]);
    }
  });

});
