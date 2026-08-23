import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import manifestJson from "../manifest.json";
import {
  EASY_SYNC_LEGACY_STORAGE_LAYOUT_VERSION,
  EASY_SYNC_STORAGE_LAYOUT_VERSION,
  getEasySyncLegacyPaths,
  getEasySyncPaths,
} from "../src/obsidian-compat";
import {
  createEmptyDeviceCommunityPluginParticipation,
} from "../src/sync/community-plugin-participation";
import { validateEnvelope } from "../src/sync/state-envelope-v2";
import { isStateV2Manifest } from "../src/sync/state-v2-migration";
import { sha256Hex } from "../src/crypto";
import {
  classifySharedSyncProtocolProfile,
} from "../src/sync/shared-sync-protocol-profile";
import {
  SYNC_PROTOCOL_V2_VERSION,
  parseSharedSyncProtocolV2,
  serializeSharedSyncProtocolV2,
} from "../src/sync/sync-protocol-v2";
import { SYNC_PROTOCOL_V3_VERSION } from "../src/sync/sync-protocol-v3";

const FIXTURE_PATH = "tests/fixtures/public-persistent-format-policy.json";

interface FormatProfile {
  fileStateModel: number;
  activeDatabaseSchema: number;
  authorityWitnessSchema: number;
  protocolV2: number;
  protocolV3: number | null;
  communityPluginParticipation: number;
  remoteScopeRecoveryEvidenceDb: number | null;
  storageLayout: number;
}

interface PolicyFixture {
  schemaVersion: number;
  policy: {
    currentPublicRelease: string;
    directUpgradeBaseline: string;
    currentRuntimeProfile: string;
    historicalMigrationFloor: string;
    unpublishedBuildsArePermanentInputs: boolean;
    breakingChangesRequireAdjacentMigration: boolean;
    ordinaryFeatureChangesRequireGlobalVersionBump: boolean;
  };
  families: Array<{
    id: string;
    owner: string;
    currentVersion: unknown;
    acceptedOptionalSemantics?: Record<string, string[]>;
  }>;
  profiles: Record<string, FormatProfile>;
  releases: Array<{
    version: string;
    commit: string;
    profile: string;
    proves: string;
    sourceBlobs: Record<string, string | null>;
  }>;
}

function readFixture(): PolicyFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as PolicyFixture;
}

const supportedReleases = [
  "1.1.3",
  "1.2.0",
  "1.2.1",
  "1.2.2",
  "1.2.3",
  "1.2.4",
  "1.2.5",
  "1.2.6",
  "1.2.7",
];

describe("public persistent-format compatibility policy", () => {
  it("freezes every supported public release without promoting rolling builds", () => {
    const fixture = readFixture();

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.releases.map((entry) => entry.version)).toEqual(supportedReleases);
    expect(fixture.policy).toMatchObject({
      currentPublicRelease: "1.2.7",
      directUpgradeBaseline: "1.2.7",
      historicalMigrationFloor: "1.1.3",
      unpublishedBuildsArePermanentInputs: false,
      breakingChangesRequireAdjacentMigration: true,
      ordinaryFeatureChangesRequireGlobalVersionBump: false,
    });

    for (const release of fixture.releases) {
      expect(release.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(release.proves.length).toBeGreaterThan(20);
      if (release.version !== "1.1.3") {
        expect(fixture.profiles[release.profile]).toBeDefined();
      }
      for (const oid of Object.values(release.sourceBlobs)) {
        if (oid !== null) expect(oid).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it("keeps version families separate instead of treating the plugin version as a schema", () => {
    const fixture = readFixture();
    const familyIds = fixture.families.map((family) => family.id);

    expect(new Set(familyIds).size).toBe(familyIds.length);
    expect(familyIds).toEqual(expect.arrayContaining([
      "public-1.1.3-import",
      "v2-file-state-envelope",
      "v2-active-indexeddb",
      "v2-authority-witness",
      "protocol-v2",
      "protocol-v3",
      "community-plugin-participation",
      "v2-recovery-control-records",
      "remote-scope-recovery-evidence-db",
      "easy-sync-runtime-layout",
      "rebuildable-caches-and-presentation",
    ]));
    expect(fixture.families.find(
      (family) => family.id === "v2-recovery-control-records",
    )?.acceptedOptionalSemantics).toEqual({
      fileMutationIntentV1StateEffect: ["local-only", "settlement-only"],
    });
    expect(fixture.families.find(
      (family) => family.id === "v2-recovery-control-records",
    )).toMatchObject({
      acceptedNestedVersions: {
        fileMutationIntent: [1],
        folderMutationIntent: [2],
        communityPluginBundleSettlement: [2],
        mutationReceipt: [1],
      },
    });
    expect(fixture.families.find(
      (family) => family.id === "remote-scope-recovery-evidence-db",
    )).toMatchObject({
      currentVersion: fixture.profiles[fixture.policy.currentRuntimeProfile]
        .remoteScopeRecoveryEvidenceDb,
      owner: "src/sync/remote-scope-recovery-evidence-store.ts",
      acceptedNestedVersions: {
        operationRecord: [1, 2],
        receipt: [1],
      },
    });
    expect(fixture.profiles["v2-initial"]).not.toEqual(
      fixture.profiles["v2-with-generation-lineage"],
    );
    expect(fixture.profiles["v2-with-generation-lineage"]).not.toEqual(
      fixture.profiles["v2-with-local-layout-v2"],
    );
  });

  it("matches the current public release and current runtime version vector", () => {
    const fixture = readFixture();
    const currentRelease = fixture.releases.at(-1)!;
    const currentProfile = fixture.profiles[currentRelease.profile]!;

    expect(packageJson.version).toBe(manifestJson.version);
    expect(currentRelease.version).toBe(fixture.policy.currentPublicRelease);
    expect(currentRelease.profile).toBe(fixture.policy.currentRuntimeProfile);
    expect(currentProfile).toMatchObject({
      fileStateModel: 2,
      activeDatabaseSchema: 1,
      authorityWitnessSchema: 1,
      protocolV2: SYNC_PROTOCOL_V2_VERSION,
      protocolV3: SYNC_PROTOCOL_V3_VERSION,
      communityPluginParticipation: 1,
      remoteScopeRecoveryEvidenceDb: 1,
      storageLayout: EASY_SYNC_STORAGE_LAYOUT_VERSION,
    });
    expect(EASY_SYNC_LEGACY_STORAGE_LAYOUT_VERSION).toBe(1);
    expect(getEasySyncPaths(".obsidian").storageLayoutVersion).toBe(2);
    expect(getEasySyncLegacyPaths(".obsidian").storageLayoutVersion).toBe(1);
    expect(createEmptyDeviceCommunityPluginParticipation().schemaVersion).toBe(1);
  });

  it("keeps the frozen public V2 formats readable by the current owners", () => {
    const scope = {
      accountId: "fixture-account",
      driveId: "fixture-drive",
      vaultFolderId: "fixture-vault",
      filesRootId: "fixture-root",
    };
    const envelope = {
      meta: { schemaVersion: 2, lifecycleEpoch: 1, commitSeq: 1, committedAt: 1 },
      scope,
      remoteIndex: {
        schemaVersion: 2,
        filesRootId: scope.filesRootId,
        cursorRevision: 0,
        deltaLink: null,
        complete: true,
        itemsById: {},
      },
      anchors: { schemaVersion: 2, byAnchorId: {} },
    };

    expect(() => validateEnvelope(envelope)).not.toThrow();
    expect(isStateV2Manifest({
      schemaVersion: 2,
      activeState: "state-v2.json",
      stateCommitSeq: 1,
      lifecycleEpoch: 1,
      scope,
      migratedAt: 1,
      legacyAutoSyncAllowed: false,
    })).toBe(true);
    const publicProtocol = {
      schemaVersion: 1,
      kind: "easy-sync-v2-protocol" as const,
      protocolVersion: 2 as const,
      migrationGeneration: "a".repeat(64),
      scope,
      confirmedAllDevicesUpdatedAt: 1,
      createdAt: 1,
    };
    const frozenBytes = JSON.stringify(publicProtocol);
    expect(parseSharedSyncProtocolV2(frozenBytes)).not.toBeNull();
    expect(serializeSharedSyncProtocolV2(publicProtocol)).toBe(frozenBytes);
  });

  it("classifies every frozen public V2 protocol profile by its declared version vector", async () => {
    const fixture = readFixture();
    const scope = {
      accountId: "fixture-account",
      driveId: "fixture-drive",
      vaultFolderId: "fixture-vault",
      filesRootId: "fixture-root",
    };
    const protocolV2 = {
      schemaVersion: 1 as const,
      kind: "easy-sync-v2-protocol" as const,
      protocolVersion: 2 as const,
      migrationGeneration: "a".repeat(64),
      scope,
      confirmedAllDevicesUpdatedAt: 1,
      createdAt: 1,
    };
    const v2Content = serializeSharedSyncProtocolV2(protocolV2);
    const predecessorContentSha256 = await sha256Hex(
      new TextEncoder().encode(v2Content).buffer,
    );
    const v2 = { id: "v2-id", eTag: "v2-etag", content: v2Content };
    const v3 = {
      id: "v3-id",
      eTag: "v3-etag",
      content: JSON.stringify({
        schemaVersion: 1,
        kind: "easy-sync-generation-protocol",
        protocolVersion: 3,
        migrationGeneration: protocolV2.migrationGeneration,
        predecessor: {
          protocolVersion: 2,
          contentSha256: predecessorContentSha256,
        },
        createdAt: protocolV2.createdAt,
      }),
    };

    for (const release of fixture.releases.filter(
      (entry) => entry.version.startsWith("1.2."),
    )) {
      const profile = fixture.profiles[release.profile]!;
      const classified = await classifySharedSyncProtocolProfile({
        v2,
        v3: profile.protocolV3 === null ? null : v3,
        targetScope: scope,
      });
      expect({ version: release.version, status: classified.status }).toEqual({
        version: release.version,
        status: ["1.2.0", "1.2.1"].includes(release.version)
          ? "legacy-v2"
          : "healthy",
      });
    }
  });
});
