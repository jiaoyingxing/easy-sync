import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isCommunityPluginGenerationCleanupCheckpointV1,
} from "../src/sync/community-plugin-generation-cleanup-cloud-v1";
import {
  COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY,
} from "../src/sync/community-plugin-lifecycle-device-v1";

describe("community-plugin generation cleanup v2 bundle-only contract", () => {
  it("rejects the unpublished enablement-coupled cleanup checkpoint", () => {
    expect(isCommunityPluginGenerationCleanupCheckpointV1({
      schemaVersion: 1,
      kind: "community-plugin-generation-cleanup-checkpoint",
      snapshotDigest: "a".repeat(64),
      pluginId: "calendar",
      generation: 1,
      enablementReceipt: {
        remoteId: "community-plugins-json",
      },
      objectConfirmations: [],
    })).toBe(false);
  });

  it("uses a new local checkpoint key for the bundle-only schema", () => {
    expect(COMMUNITY_PLUGIN_GENERATION_CLEANUP_CHECKPOINT_KEY).toBe(
      "easy-sync-community-plugin-generation-cleanup-checkpoint-v2",
    );
  });

  it("keeps production cleanup independent from community-plugins.json", () => {
    const pure = readFileSync(
      "src/sync/community-plugin-generation-cleanup-v1.ts",
      "utf8",
    );
    const cloud = readFileSync(
      "src/sync/community-plugin-generation-cleanup-cloud-v1.ts",
      "utf8",
    );
    const runtime = readFileSync(
      "src/sync/community-plugin-generation-cleanup-runtime-v1.ts",
      "utf8",
    );

    for (const source of [pure, cloud, runtime]) {
      expect(source.replace(/\/\*[\s\S]*?\*\//g, ""))
        .not.toContain("community-plugins.json");
      expect(source).not.toContain("enablementObservation");
      expect(source).not.toContain("enablementReceipt");
    }
    expect(pure).toContain("schemaVersion: 2");
    expect(cloud).toContain("objectConfirmations");
  });
});
