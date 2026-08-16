import { describe, expect, it } from "vitest";
import {
  validateCommunityPluginEnablementMigrationCarrierV2,
} from "../src/sync/community-plugin-enablement";

const carrier = {
  version: 1 as const,
  scope: {
    accountId: "account",
    driveId: "drive",
    vaultFolderId: "vault",
    filesRootId: "files",
  },
  source: {
    path: ".obsidian/community-plugins.json",
    selectedPluginIds: ["calendar"],
    local: { exists: true, contentHash: "a".repeat(64) },
    remote: {
      exists: true,
      contentHash: "b".repeat(64),
      remoteId: "remote",
      eTag: "etag",
    },
  },
  anchors: { "startup-optimizer": false },
  pending: [{
    pluginId: "calendar",
    localEnabled: true,
    remoteEnabled: false,
  }],
  resolved: [],
};

describe("public 1.2.7 community-plugin enablement carrier", () => {
  it("accepts the exact legacy shape as read-only compatibility input", () => {
    expect(() => validateCommunityPluginEnablementMigrationCarrierV2(carrier))
      .not.toThrow();
  });

  it("rejects malformed or out-of-scope decision records", () => {
    expect(() => validateCommunityPluginEnablementMigrationCarrierV2({
      ...carrier,
      pending: [{
        pluginId: "not-selected",
        localEnabled: true,
        remoteEnabled: false,
      }],
    })).toThrow(/migration carrier is invalid/);
    expect(() => validateCommunityPluginEnablementMigrationCarrierV2({
      ...carrier,
      source: { ...carrier.source, remote: { exists: true } },
    })).toThrow(/migration carrier is invalid/);
  });
});
