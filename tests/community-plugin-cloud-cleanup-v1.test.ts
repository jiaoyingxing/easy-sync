import { describe, expect, it, vi } from "vitest";
import {
  executeCommunityPluginCloudCleanupV1,
  isCommunityPluginCloudCleanupCandidateV1,
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

  it("deletes each planned object with If-Match and verifies absence by read-back", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
        remote(".obsidian/plugins/calendar/manifest.json"),
      ],
    });
    const metadata = new Map<string, { id: string; eTag: string } | null>([
      [plan.objects[0]!.remoteId, {
        id: plan.objects[0]!.remoteId,
        eTag: plan.objects[0]!.eTag,
      }],
      [plan.objects[1]!.remoteId, {
        id: plan.objects[1]!.remoteId,
        eTag: plan.objects[1]!.eTag,
      }],
    ]);
    const getDriveItemMetadataById = vi.fn(async (id: string) =>
      metadata.get(id) ?? null);
    const deleteItem = vi.fn(async (
      _vaultName: string,
      _path: string,
      eTag: string | undefined,
      driveId: string,
    ) => {
      if (eTag !== metadata.get(driveId)?.eTag) {
        throw new Error("412 precondition failed");
      }
      metadata.set(driveId, null);
    });
    const transport = {
      vaultName: "testVault",
      getDriveItemMetadataById,
      deleteItem,
    };
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport,
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
      transport,
    });
    expect(rerun).toEqual({ status: "completed", deleted: 0 });
    expect(deleteItem).toHaveBeenCalledTimes(2);
  });

  it("blocks before any delete when the remote eTag changed", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getDriveItemMetadataById = vi.fn(async () => ({
      id: plan.objects[0]!.remoteId,
      eTag: "etag:changed",
    }));
    const deleteItem = vi.fn();
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getDriveItemMetadataById,
        deleteItem,
      },
    });
    expect(result).toEqual({
      status: "blocked",
      deleted: 0,
      reason: "remote-changed",
    });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("blocks when read-back still sees the object after delete", async () => {
    const plan = planCommunityPluginCloudCleanupV1({
      pluginId: "calendar",
      configDir: ".obsidian",
      remoteEntries: [
        remote(".obsidian/plugins/calendar/main.js"),
      ],
    });
    const getDriveItemMetadataById = vi.fn(async () => ({
      id: plan.objects[0]!.remoteId,
      eTag: plan.objects[0]!.eTag,
    }));
    const deleteItem = vi.fn(async () => undefined);
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getDriveItemMetadataById,
        deleteItem,
      },
    });
    expect(result).toEqual({
      status: "blocked",
      deleted: 0,
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
    const getDriveItemMetadataById = vi.fn(async () => ({
      id: plan.objects[0]!.remoteId,
      eTag: plan.objects[0]!.eTag,
    }));
    const deleteItem = vi.fn(async () => {
      throw new Error("412 precondition failed");
    });
    const result = await executeCommunityPluginCloudCleanupV1({
      plan,
      transport: {
        vaultName: "testVault",
        getDriveItemMetadataById,
        deleteItem,
      },
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("delete-failed");
    }
    expect(result.deleted).toBe(0);
  });
});
