import { describe, expect, it, vi } from "vitest";
import {
  executeCommunityPluginCloudCleanupV1,
  isCommunityPluginCloudCleanupCandidateV1,
  normalizeCommunityPluginCloudCleanupMarkersV1,
  planCommunityPluginCloudCleanupMarkerSweepV1,
  planCommunityPluginCloudCleanupIndexReappearanceV1,
  planCommunityPluginCloudCleanupV1,
} from "../src/sync/community-plugin-cloud-cleanup-v1";
import type { RemoteFileEntry } from "../src/sync/types";

function remote(
  path: string,
  overrides: Partial<RemoteFileEntry> = {},
): RemoteFileEntry {
  return {
    path,
    driveId: `id:${path}`,
    parentId: "plugin-folder-id",
    size: 10,
    mtime: 1,
    eTag: `etag:${path}`,
    cTag: `ctag:${path}`,
    ...overrides,
  };
}

describe("community plugin cloud cleanup", () => {
  it("plans only the three managed bundle members for one cleanable plugin", () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
        remote(".obsidian/plugins/calendar/manifest.json"),
        remote(".obsidian/plugins/calendar/styles.css"),
        remote(".obsidian/plugins/calendar/data.json"),
        remote(".obsidian/plugins/calendar/extra/file.txt"),
        remote(".obsidian/plugins/dataview/main.js"),
        remote(".obsidian/plugins/easy-sync/main.js"),
      ],
    });
    expect(plan.objects.map((object) => object.fileName)).toEqual([
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    expect(
      plan.objects.every((object) => !object.path.includes("data.json")),
    ).toBe(true);
  });

  it("classifies cleanable rows by local deletion evidence", () => {
    // This device removed the plugin locally and the cloud still holds it.
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "excluded",
      local: false,
      remote: true,
    })).toBe(true);
    // Same local evidence with no participation record yet on this device
    // (never-participated or pre-V2-migration undefined) is still the
    // "plugin files only in the cloud" row the user can decide to clean.
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "never-participated",
      local: false,
      remote: true,
    })).toBe(true);
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: undefined,
      local: false,
      remote: true,
    })).toBe(true);
    // Sync toggled off while the plugin stays installed locally.
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "excluded",
      local: true,
      remote: true,
    })).toBe(false);
    // Active participation, in-flight joins/restores/exits and blocked
    // restores never show the cleanup affordance, even if the local
    // directory is currently absent.
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "participating",
      local: false,
      remote: true,
    })).toBe(false);
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "join-requested",
      local: false,
      remote: true,
    })).toBe(false);
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "restoring",
      local: false,
      remote: true,
    })).toBe(false);
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "exit-requested",
      local: false,
      remote: true,
    })).toBe(false);
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "blocked",
      local: false,
      remote: true,
    })).toBe(false);
    expect(isCommunityPluginCloudCleanupCandidateV1({
      phase: "excluded",
      local: false,
      remote: false,
    })).toBe(false);
  });

  it("deletes each planned object with If-Match and verifies absence by path read-back", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
        remote(".obsidian/plugins/calendar/manifest.json"),
      ],
    });
    const pathMetadata = new Map<string, { remoteId: string; eTag: string } | null>([
      [plan.objects[0]!.path, {
        remoteId: plan.objects[0]!.remoteId,
        eTag: plan.objects[0]!.eTag,
      }],
      [plan.objects[1]!.path, {
        remoteId: plan.objects[1]!.remoteId,
        eTag: plan.objects[1]!.eTag,
      }],
    ]);
    const getFileMetadataByPath = vi.fn(async (path: string) =>
      pathMetadata.get(path) ?? null);
    const deleteItem = vi.fn(async (
      _vaultName: string,
      path: string,
      eTag: string | undefined,
    ) => {
      if (eTag !== pathMetadata.get(path)?.eTag) {
        throw new Error("412 precondition failed");
      }
      pathMetadata.set(path, null);
    });
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(result).toEqual({ status: "completed", deleted: 2 });
    expect(deleteItem).toHaveBeenCalledTimes(2);
    expect(deleteItem.mock.calls.every((call) => call[2] !== undefined))
      .toBe(true);

    // Re-entrant run with an empty plan performs zero deletes.
    const rerun = await executeCommunityPluginCloudCleanupV1({
      plan: planCommunityPluginCloudCleanupV1({
        pluginId: "calendar",
        configDir: ".obsidian",
        remoteEntries: [],
      }),
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(rerun).toEqual({ status: "completed", deleted: 0 });
    expect(deleteItem).toHaveBeenCalledTimes(2);
  });

  it("blocks instead of claiming success when the planned identity is stale but the path still holds a different item", async () => {
    // 2026-09-15 regression: the old id-only pre-check treated "id absent"
    // as "path clean" and reported a no-op cleanup as completed while the
    // real file stayed in the cloud.
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getFileMetadataByPath = vi.fn(async () => ({
      remoteId: "current-item-id",
      eTag: "etag:current",
    }));
    const deleteItem = vi.fn();
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(result).toEqual({
      status: "blocked",
      deleted: 0,
      path: ".obsidian/plugins/calendar/main.js",
      reason: "evidence-stale",
    });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("skips paths that are genuinely absent and completes", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getFileMetadataByPath = vi.fn(async () => null);
    const deleteItem = vi.fn();
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(result).toEqual({ status: "completed", deleted: 0 });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("blocks before any delete when the remote eTag changed", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getFileMetadataByPath = vi.fn(async () => ({
      remoteId: plan.objects[0]!.remoteId,
      eTag: "etag:changed",
    }));
    const deleteItem = vi.fn();
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(result).toEqual({
      status: "blocked",
      deleted: 0,
      path: ".obsidian/plugins/calendar/main.js",
      reason: "remote-changed",
    });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("blocks when path read-back still sees the object after delete", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getFileMetadataByPath = vi.fn(async () => ({
      remoteId: plan.objects[0]!.remoteId,
      eTag: plan.objects[0]!.eTag,
    }));
    const deleteItem = vi.fn(async () => undefined);
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(result).toEqual({
      status: "blocked",
      deleted: 0,
      path: ".obsidian/plugins/calendar/main.js",
      reason: "read-back-failed",
    });
  });

  it("blocks when the conditional delete fails", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getFileMetadataByPath = vi.fn(async () => ({
      remoteId: plan.objects[0]!.remoteId,
      eTag: plan.objects[0]!.eTag,
    }));
    const deleteItem = vi.fn(async () => {
      throw new Error("412 precondition failed");
    });
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("delete-failed");
      expect(result.path).toBe(".obsidian/plugins/calendar/main.js");
    }
    expect(result.deleted).toBe(0);
  });

  it("fails with the responsible path when the path metadata read errors", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getFileMetadataByPath = vi.fn(async () => {
      throw new Error("network down");
    });
    const deleteItem = vi.fn();
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getFileMetadataByPath,
        deleteItem,
      },
    });
    expect(result).toEqual({
      status: "failed",
      deleted: 0,
      path: ".obsidian/plugins/calendar/main.js",
      error: "network down",
    });
    expect(deleteItem).not.toHaveBeenCalled();
  });
});

describe("cloud cleanup markers: normalization and resurrection sweep", () => {
  it("normalizes duplicate markers to one per plugin, keeping the newest", () => {
    expect(normalizeCommunityPluginCloudCleanupMarkersV1([
      { pluginId: "zeta", cleanedAt: 5 },
      { pluginId: "calendar", cleanedAt: 2 },
      { pluginId: "calendar", cleanedAt: 1 },
      { pluginId: "calendar", cleanedAt: 3 },
      { pluginId: "zeta", cleanedAt: 4 },
    ])).toEqual([
      { pluginId: "calendar", cleanedAt: 3 },
      { pluginId: "zeta", cleanedAt: 5 },
    ]);
  });

  it("drops a marker once the plugin's complete bundle reappears, whatever this device remembers", () => {
    const sweep = planCommunityPluginCloudCleanupMarkerSweepV1({
      markers: [
        { pluginId: "calendar", cleanedAt: 1 },
        { pluginId: "calendar", cleanedAt: 2 },
        { pluginId: "other", cleanedAt: 3 },
      ],
      reappearedPluginIds: ["calendar"],
    });
    expect(sweep.resurrectedPluginIds).toEqual(["calendar"]);
    expect(sweep.remaining).toEqual([{ pluginId: "other", cleanedAt: 3 }]);
  });

  it("keeps the marker while the bundle is still gone from the cloud", () => {
    const sweep = planCommunityPluginCloudCleanupMarkerSweepV1({
      markers: [{ pluginId: "calendar", cleanedAt: 1 }],
      reappearedPluginIds: [],
    });
    expect(sweep.remaining).toEqual([
      { pluginId: "calendar", cleanedAt: 1 },
    ]);
    expect(sweep.resurrectedPluginIds).toEqual([]);
  });

  it("lists each resurrected plugin once even with duplicate markers", () => {
    const sweep = planCommunityPluginCloudCleanupMarkerSweepV1({
      markers: [
        { pluginId: "calendar", cleanedAt: 1 },
        { pluginId: "calendar", cleanedAt: 2 },
      ],
      reappearedPluginIds: ["calendar"],
    });
    expect(sweep.resurrectedPluginIds).toEqual(["calendar"]);
    expect(sweep.remaining).toEqual([]);
  });
});

describe("index-based reappearance evidence freshness", () => {
  const baseMarker = { pluginId: "calendar", cleanedAt: 1_000 };

  function indexEntry(
    pluginId: string,
    bundleState: "complete" | "partial",
    maxMtime: number,
  ): {
    pluginId: string;
    bundleState: "complete" | "partial";
    members: readonly { mtime: number }[];
  } {
    return {
      pluginId,
      bundleState,
      members: [{ mtime: maxMtime }, { mtime: maxMtime - 5 }],
    };
  }

  it("keeps a just-cleaned plugin out of reappearance while the index still shows the pre-cleanup bundle", async () => {
    // 2026-09-16: our own cloud deletion reaches the committed index one
    // delta later; in that window the index still lists the deleted bundle.
    // That is NOT a reappearance and must not drop the cleanup marker.
    const plan = planCommunityPluginCloudCleanupIndexReappearanceV1({
      entries: [indexEntry("calendar", "complete", 500)],
      markers: [baseMarker],
    });
    expect(plan).toEqual([]);
  });

  it("counts index evidence as reappearance once it postdates the cleanup", async () => {
    const plan = planCommunityPluginCloudCleanupIndexReappearanceV1({
      entries: [indexEntry("calendar", "complete", 2_000)],
      markers: [baseMarker],
    });
    expect(plan).toEqual(["calendar"]);
  });

  it("passes plugins without markers through unchanged", async () => {
    const plan = planCommunityPluginCloudCleanupIndexReappearanceV1({
      entries: [
        indexEntry("calendar", "complete", 500),
        indexEntry("other", "complete", 10),
      ],
      markers: [baseMarker],
    });
    expect(plan).toEqual(["other"]);
  });

  it("ignores partial bundles and plugins without markers", async () => {
    const plan = planCommunityPluginCloudCleanupIndexReappearanceV1({
      entries: [indexEntry("calendar", "partial", 2_000)],
      markers: [baseMarker],
    });
    expect(plan).toEqual([]);
  });
});
