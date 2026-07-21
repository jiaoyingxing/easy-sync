import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";

describe("plugin data cold-start cache", () => {
  it("defaults legacy conflict switches to no deletion authority and saves the canonical policy", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      "sync-auto-conflict-policy": {
        identicalNewFiles: false,
        identicalModifiedFiles: true,
      },
    });
    const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

    await plugin.loadSyncSettings();
    expect(plugin.automaticHandlingPolicy).toEqual({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: true,
    });
    expect(saveData).not.toHaveBeenCalled();

    plugin.automaticHandlingPolicy = {
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: false,
    };
    await plugin.saveSyncSettings();

    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      "sync-auto-conflict-policy": {
        autoDeleteLocalFiles: true,
        mergeNonOverlappingText: false,
      },
    }));
  });

  it("applies a policy change to future runs and clears an already reviewed plan", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({});
    vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
    const setAutomaticHandlingPolicy = vi.fn();
    const clearPlanReview = vi.fn().mockResolvedValue(undefined);
    plugin.syncExecutor = { setAutomaticHandlingPolicy } as never;
    plugin.state = { planReviewActive: true, clearPlanReview } as never;

    await plugin.updateAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: false,
    });

    expect(setAutomaticHandlingPolicy).toHaveBeenCalledWith({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: false,
    });
    expect(clearPlanReview).toHaveBeenCalledTimes(1);
  });

  it("shares one physical load across the settings, auth, and state consumers", async () => {
    const plugin = new EasySyncPlugin();
    const physicalLoad = vi.spyOn(plugin, "loadData").mockResolvedValue({
      "sync-interval": 7,
      "easy-sync-profile-cache": { displayName: "User", accountId: "account" },
      "easy-sync-base-snapshot": {},
    });
    const loadPluginData = (plugin as unknown as {
      loadPluginData(): Promise<Record<string, unknown> | null>;
    }).loadPluginData.bind(plugin);

    const [settings, auth, state] = await Promise.all([
      loadPluginData(),
      loadPluginData(),
      loadPluginData(),
    ]);

    expect(physicalLoad).toHaveBeenCalledTimes(1);
    expect(settings).toEqual(auth);
    expect(auth).toEqual(state);
    expect(settings).not.toBe(auth);
  });

  it("A0-P reports whole-file PluginData write cost only through the existing state diagnostics", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({ existing: "易同步" });
    vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
    const log = vi.spyOn(plugin.diag, "log");
    const updatePluginData = (plugin as unknown as {
      updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void>;
    }).updatePluginData.bind(plugin);

    plugin.diag.enableAll();
    await updatePluginData((data) => { data.changed = true; });

    expect(log).toHaveBeenCalledWith(
      "state",
      "plugin data write",
      expect.objectContaining({
        topLevelKeys: 2,
        serializedBytes: new TextEncoder().encode(JSON.stringify({ existing: "易同步", changed: true })).byteLength,
        elapsedMs: expect.any(Number),
        prepareMs: expect.any(Number),
        measurementMs: expect.any(Number),
        saveMs: expect.any(Number),
        publishMs: expect.any(Number),
        totalMs: expect.any(Number),
      }),
    );
  });

  it("keeps the last committed cache when a PluginData write fails", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({ committed: true });
    vi.spyOn(plugin, "saveData").mockRejectedValue(new Error("disk full"));
    const loadPluginData = (plugin as unknown as {
      loadPluginData(): Promise<Record<string, unknown> | null>;
    }).loadPluginData.bind(plugin);
    const updatePluginData = (plugin as unknown as {
      updatePluginData(mutator: (data: Record<string, unknown>) => void): Promise<void>;
    }).updatePluginData.bind(plugin);

    await expect(updatePluginData((data) => {
      data.committed = false;
      data.uncommitted = true;
    })).rejects.toThrow("disk full");

    expect(await loadPluginData()).toEqual({ committed: true });
  });
});
