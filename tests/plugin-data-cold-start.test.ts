import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin, { SyncPathSettingsUpdateError } from "../src/main";

describe("plugin data cold-start cache", () => {
  it("loads and normalizes device-local folder exclusions without a cold-start write", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      "sync-excluded-folders": [
        " Notes\\Private/ ",
        "notes/private/archive",
        ".obsidian/themes",
      ],
    });
    const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

    await plugin.loadSyncSettings();

    expect(plugin.excludedFolders).toEqual(["Notes/Private"]);
    expect(saveData).not.toHaveBeenCalled();
  });

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

  it("changes sync paths only after clearing remote cache and commits settings with scoped pending state", async () => {
    const plugin = new EasySyncPlugin();
    const events: string[] = [];
    let activeExcluded: string[] = [];
    let savedData: Record<string, unknown> = {};
    plugin.scanner = {
      setConfig: vi.fn((config: { excludedFolders?: string[] }) => {
        activeExcluded = [...(config.excludedFolders ?? [])];
        events.push(activeExcluded.length > 0 ? "apply-candidate" : "apply-previous");
      }),
      shouldSyncPath: vi.fn((path: string) =>
        !activeExcluded.some((folder) =>
          path === folder || path.startsWith(`${folder}/`),
        )),
    } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      clearRemoteState: vi.fn(async () => {
        events.push("clear-remote");
      }),
      commitSyncPathSettingsChange: vi.fn(async (
        isPathInScope: (path: string) => boolean,
        persistSettings: (data: Record<string, unknown>) => void,
      ) => {
        events.push("commit");
        expect(isPathInScope("Private/note.md")).toBe(false);
        expect(isPathInScope("Notes/note.md")).toBe(true);
        persistSettings(savedData);
      }),
    } as never;
    plugin.syncExecutor = { hasActivityInFlight: false } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await plugin.updateExcludedFolders(["Private"]);

    expect(events).toEqual(["clear-remote", "apply-candidate", "commit"]);
    expect(plugin.excludedFolders).toEqual(["Private"]);
    expect(savedData["sync-excluded-folders"]).toEqual(["Private"]);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("rolls scanner settings back when the combined sync-path write fails", async () => {
    const plugin = new EasySyncPlugin();
    const applied: string[][] = [];
    plugin.scanner = {
      setConfig: vi.fn((config: { excludedFolders?: string[] }) => {
        applied.push([...(config.excludedFolders ?? [])]);
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      clearRemoteState: vi.fn().mockResolvedValue(undefined),
      commitSyncPathSettingsChange: vi.fn().mockRejectedValue(new Error("disk full")),
    } as never;
    plugin.syncExecutor = { hasActivityInFlight: false } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.updateExcludedFolders(["Private"]))
      .rejects.toThrow("disk full");

    expect(plugin.excludedFolders).toEqual([]);
    expect(applied).toEqual([["Private"], []]);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("rejects sync-path changes while sync or mutation recovery is active", async () => {
    const plugin = new EasySyncPlugin();
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
    } as never;
    plugin.syncExecutor = { hasActivityInFlight: true } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.updateExcludedFolders(["Private"]))
      .rejects.toMatchObject<Partial<SyncPathSettingsUpdateError>>({ code: "busy" });

    plugin.syncExecutor = { hasActivityInFlight: false } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [{}],
    } as never;

    await expect(plugin.updateExcludedFolders(["Private"]))
      .rejects.toMatchObject<Partial<SyncPathSettingsUpdateError>>({ code: "recovery" });
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
