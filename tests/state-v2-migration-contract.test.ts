import { describe, expect, it } from "vitest";
import {
  STATE_V1_MIGRATION_CASES,
  migrationCase,
} from "./fixtures/state-v1-migration-cases";
import {
  simulateV1ToV2Migration,
  v1BackupCleanupAllowed,
} from "./helpers/state-v2-migration-model";

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

  it("seeds a cloud-only hint only after current local hash and remote id/hash both verify", () => {
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

  it("retains the V1 backup until desktop, mobile, cloud, and journal gates all pass", () => {
    expect(v1BackupCleanupAllowed({
      desktopHealthy: true,
      mobileHealthy: true,
      cloudBootstrapV2Published: true,
      recoveryJournalsEmpty: true,
    })).toBe(true);
    expect(v1BackupCleanupAllowed({
      desktopHealthy: true,
      mobileHealthy: false,
      cloudBootstrapV2Published: true,
      recoveryJournalsEmpty: true,
    })).toBe(false);
  });
});
