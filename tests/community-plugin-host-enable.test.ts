import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  readCommunityPluginHostEnableApi,
  tryEnableDownloadedCommunityPlugin,
} from "../src/community-plugin-host-enable";

function appWithPlugins(plugins: unknown): App {
  return { plugins } as unknown as App;
}

describe("community-plugin host enablement probe", () => {
  it("falls back when the host API is absent or partial", async () => {
    expect(readCommunityPluginHostEnableApi(appWithPlugins(undefined))).toBeNull();
    expect(readCommunityPluginHostEnableApi(appWithPlugins({}))).toBeNull();
    expect(readCommunityPluginHostEnableApi(appWithPlugins({
      loadManifests: vi.fn(),
    }))).toBeNull();
    expect(readCommunityPluginHostEnableApi(appWithPlugins({
      enablePluginAndSave: vi.fn(),
    }))).toBeNull();

    await expect(tryEnableDownloadedCommunityPlugin(
      appWithPlugins(undefined),
      "calendar",
    )).resolves.toEqual({ kind: "fallback", reason: "host-api-unavailable" });
  });

  it("registers manifests and enables the plugin in the open-plug order", async () => {
    const loadManifests = vi.fn().mockResolvedValue(undefined);
    const enablePluginAndSave = vi.fn().mockResolvedValue(undefined);
    const app = appWithPlugins({ loadManifests, enablePluginAndSave });

    await expect(tryEnableDownloadedCommunityPlugin(app, "calendar"))
      .resolves.toEqual({ kind: "enabled" });

    expect(loadManifests).toHaveBeenCalledTimes(1);
    expect(enablePluginAndSave).toHaveBeenCalledTimes(1);
    expect(enablePluginAndSave).toHaveBeenCalledWith("calendar");
    // loadManifests runs before the enable call (fresh manifest must exist
    // when the enablement path resolves the plugin id).
    expect(loadManifests.mock.invocationCallOrder[0])
      .toBeLessThan(enablePluginAndSave.mock.invocationCallOrder[0]);
  });

  it("falls back on any host throw and never throws itself", async () => {
    const enableError = new Error("host rejected");
    const failingEnable = appWithPlugins({
      loadManifests: vi.fn().mockResolvedValue(undefined),
      enablePluginAndSave: vi.fn().mockRejectedValue(enableError),
    });
    await expect(tryEnableDownloadedCommunityPlugin(failingEnable, "beta"))
      .resolves.toEqual({ kind: "fallback", reason: "host rejected" });

    const failingLoad = appWithPlugins({
      loadManifests: vi.fn().mockRejectedValue(new Error("load failed")),
      enablePluginAndSave: vi.fn(),
    });
    await expect(tryEnableDownloadedCommunityPlugin(failingLoad, "beta"))
      .resolves.toEqual({ kind: "fallback", reason: "load failed" });

    const syncThrowing = appWithPlugins({
      loadManifests: vi.fn(() => {
        throw new Error("sync throw");
      }),
      enablePluginAndSave: vi.fn(),
    });
    await expect(tryEnableDownloadedCommunityPlugin(syncThrowing, "beta"))
      .resolves.toEqual({ kind: "fallback", reason: "sync throw" });
  });
});
