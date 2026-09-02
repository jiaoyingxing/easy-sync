import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin, { SyncPathSettingsUpdateError } from "../src/main";
import { sha256Hex } from "../src/crypto";
import {
  StateManager,
  SyncPathMutationRecoveryError,
} from "../src/sync/state-manager";
import {
  createCommunityPluginManifestObservation,
} from "../src/sync/community-plugin-bundle";
import {
  isFolderPathInSyncScopeSnapshot,
  type FolderSyncScopeSnapshotV1,
} from "../src/sync/local-scanner";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
} from "../src/sync/community-plugin-participation";
import {
  buildRemoteCommunityPluginCatalog,
  type RemoteCommunityPluginCatalogV1,
} from "../src/sync/community-plugin-remote-catalog";

function makeCommunityPluginScopeSwitchHarness(
  checkpointError?: Error,
  pendingRetirementError?: Error,
): {
  plugin: EasySyncPlugin;
  getParticipation: () => ReturnType<
    typeof createEmptyDeviceCommunityPluginParticipation
  >;
  commitSyncPathSettingsChange: ReturnType<typeof vi.fn>;
  retirePendingStateForPaths: ReturnType<typeof vi.fn>;
  updateCommunityPluginParticipationBatch: ReturnType<typeof vi.fn>;
  commitOrder: string[];
} {
  const plugin = new EasySyncPlugin();
  const commitOrder: string[] = [];
  let committedFingerprint = "";
  let participation = reduceDeviceCommunityPluginParticipation(
    createEmptyDeviceCommunityPluginParticipation(false),
    { type: "confirm-participating", pluginId: "calendar" },
  );
  Object.defineProperty(plugin, "app", {
    configurable: true,
    value: {
      vault: { adapter: {}, configDir: ".obsidian" },
      workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
    },
  });
  Object.defineProperty(plugin, "manifest", {
    configurable: true,
    value: { id: "easy-sync" },
  });
  const commitSyncPathSettingsChange = vi.fn(async (
    _isPathInScope: (path: string) => boolean,
    persistSettings: (data: Record<string, unknown>) => void,
    _selectedCommunityPluginIds?: readonly string[],
    scopeChange?: { targetSettingsFingerprint?: string },
  ) => {
    commitOrder.push("scope");
    if (checkpointError) throw checkpointError;
    persistSettings({});
    committedFingerprint = scopeChange?.targetSettingsFingerprint ?? "";
  });
  const applyParticipationCommand = vi.fn(async (command) => {
    participation = reduceDeviceCommunityPluginParticipation(
      participation,
      command,
    );
    return true;
  });
  const updateCommunityPluginParticipationBatch = vi.fn(async (commands) => {
    commitOrder.push("participation");
    for (const command of commands) {
      await applyParticipationCommand(command);
    }
    return true;
  });
  const retirePendingStateForPaths = vi.fn(async () => {
    commitOrder.push("pending");
    if (pendingRetirementError) throw pendingRetirementError;
  });
  plugin.state = {
    isV2StateActive: true,
    getCommunityPluginParticipation: () => structuredClone(participation),
    retirePendingStateForPaths,
    updateCommunityPluginParticipation: applyParticipationCommand,
    updateCommunityPluginParticipationBatch,
    hasV2StateLoadRecoveryBlock: false,
    hasV2RemoteScopeRecovery: false,
    hasMutationLedgerCorruption: false,
    hasMutationRecoveryQuarantineCorruption: false,
    mutationLedger: [],
    activeV2MigrationHold: null,
    hasCompleteRemoteFolderIndex: true,
    remoteFolders: [],
    commitSyncPathSettingsChange,
    get syncPathSettingsFingerprint() {
      return committedFingerprint;
    },
  } as never;
  plugin.scanner = {
    setConfig: vi.fn(),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
  } as never;
  plugin.syncExecutor = {
    hasActivityInFlight: false,
    setCommunityPluginSyncPolicy: vi.fn(),
  } as never;
  vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
  vi.spyOn(
    plugin as never,
    "ensureCommunityPluginParticipationInitialized",
  ).mockImplementation(async () => structuredClone(participation));
  vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(
    () => undefined,
  );
  return {
    plugin,
    getParticipation: () => structuredClone(participation),
    commitSyncPathSettingsChange,
    retirePendingStateForPaths,
    updateCommunityPluginParticipationBatch,
    commitOrder,
  };
}

describe("plugin data cold-start cache", () => {
  it("refreshes the remote plugin catalog with metadata only and keeps it independent of local selection", async () => {
    const plugin = new EasySyncPlugin();
    let catalog: RemoteCommunityPluginCatalogV1 | null = null;
    const remoteItems = [
      {
        id: "config",
        name: ".obsidian",
        folder: {},
        parentReference: { id: "files", driveId: "drive" },
      },
      {
        id: "plugins",
        name: "plugins",
        folder: {},
        parentReference: { id: "config", driveId: "drive" },
      },
      {
        id: "calendar-root",
        name: "calendar",
        folder: {},
        parentReference: { id: "plugins", driveId: "drive" },
      },
      {
        id: "calendar-main",
        name: "main.js",
        size: 4,
        file: { hashes: {} },
        parentReference: { id: "calendar-root", driveId: "drive" },
        eTag: "etag-main",
        cTag: "ctag-main",
      },
      {
        id: "calendar-manifest",
        name: "manifest.json",
        size: 8,
        file: { hashes: {} },
        parentReference: { id: "calendar-root", driveId: "drive" },
        eTag: "etag-manifest",
        cTag: "ctag-manifest",
      },
    ];
    const getDeltaByFolderId = vi.fn().mockResolvedValue({
      value: remoteItems,
      "@odata.deltaLink": "cursor-1",
    });
    const downloadFile = vi.fn();
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          configDir: ".obsidian",
          adapter: {
            exists: vi.fn().mockResolvedValue(false),
            list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
            read: vi.fn().mockRejectedValue(new Error("missing")),
          },
        },
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.onedrive = { getDeltaByFolderId, downloadFile } as never;
    plugin.state = {
      isV2StateActive: true,
      remoteScope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "files",
      },
      remoteSnapshot: [],
      getRemoteCommunityPluginCatalog: () => catalog,
      setRemoteCommunityPluginCatalog: vi.fn(async (next) => {
        catalog = next;
      }),
      getCommunityPluginManifestObservations: vi.fn().mockReturnValue([]),
      getCommunityPluginParticipation: vi.fn().mockReturnValue(null),
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: null,
        anchors: {},
        pending: [],
      }),
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: true,
      remoteFolders: [],
      baseSnapshot: [],
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await plugin.refreshCommunityPluginRemoteCatalog();
    plugin.syncCommunityPlugins = false;
    plugin.communityPluginSyncPolicy.files = { mode: "none", pluginIds: [] };
    const inventory = await plugin.getCommunityPluginInventory();

    expect(getDeltaByFolderId).toHaveBeenCalledWith("files");
    expect(downloadFile).not.toHaveBeenCalled();
    expect(inventory).toEqual([
      expect.objectContaining({ id: "calendar", remote: true }),
    ]);
    await expect(plugin.hasTrustedCommunityPluginRemoteInventory("files"))
      .resolves.toBe(true);

    getDeltaByFolderId.mockRejectedValueOnce(new Error("offline"));
    await expect(plugin.refreshCommunityPluginRemoteCatalog())
      .rejects.toThrow("offline");

    // A single transient failure keeps the last trusted catalog usable.
    expect(downloadFile).not.toHaveBeenCalled();
    expect(catalog).toEqual(expect.objectContaining({
      complete: true,
      stale: false,
      entries: [expect.objectContaining({ pluginId: "calendar" })],
    }));
    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([
      expect.objectContaining({
        id: "calendar",
        remote: true,
      }),
    ]);
    await expect(plugin.hasTrustedCommunityPluginRemoteInventory("files"))
      .resolves.toBe(true);

    // Only consecutive failures downgrade the catalog to stale.
    getDeltaByFolderId.mockRejectedValueOnce(new Error("offline"));
    await expect(plugin.refreshCommunityPluginRemoteCatalog())
      .rejects.toThrow("offline");

    expect(downloadFile).not.toHaveBeenCalled();
    expect(catalog).toEqual(expect.objectContaining({
      complete: true,
      stale: true,
      entries: [expect.objectContaining({ pluginId: "calendar" })],
    }));
    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([
      expect.objectContaining({
        id: "calendar",
        remote: true,
        remoteCatalogStale: true,
      }),
    ]);
    await expect(plugin.hasTrustedCommunityPluginRemoteInventory("files"))
      .resolves.toBe(false);
  });

  it("reads and updates community-plugin file switches only through V2 participation", async () => {
    const plugin = new EasySyncPlugin();
    let participation = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      { type: "mark-never-participated", pluginId: "calendar" },
    );
    const updateCommunityPluginParticipation = vi.fn(async (command) => {
      participation = reduceDeviceCommunityPluginParticipation(
        participation,
        command,
      );
      return true;
    });
    const retirePendingStateForPaths = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
      read: vi.fn().mockRejectedValue(new Error("missing")),
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: { adapter, configDir: ".obsidian" },
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    const frozenLegacyPolicy = {
      version: 1 as const,
      files: {
        mode: "all" as const,
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: { mode: "none" as const, pluginIds: [] },
    };
    const remoteScope = {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "files",
    };
    const remoteCatalog: RemoteCommunityPluginCatalogV1 = {
      version: 1,
      scope: remoteScope,
      complete: true,
      stale: false,
      revision: 7,
      observedAt: 1,
      sourceDigest: "f".repeat(64),
      entries: [{
        pluginId: "calendar",
        bundleState: "complete",
        bundleDigest: "a".repeat(64),
        members: [{
          path: ".obsidian/plugins/calendar/main.js",
          remoteId: "calendar-main",
          parentId: "calendar-folder",
          size: 4,
          mtime: 1,
          eTag: "main-etag",
          cTag: "main-ctag",
          sha256Hash: null,
          quickXorHash: null,
        }, {
          path: ".obsidian/plugins/calendar/manifest.json",
          remoteId: "calendar-manifest",
          parentId: "calendar-folder",
          size: 8,
          mtime: 1,
          eTag: "manifest-etag",
          cTag: "manifest-ctag",
          sha256Hash: null,
          quickXorHash: null,
        }],
      }],
    };
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      "sync-community-plugins": true,
      "community-plugin-sync-policy": frozenLegacyPolicy,
    });
    plugin.state = {
      isV2StateActive: true,
      getCommunityPluginParticipation: () => structuredClone(participation),
      updateCommunityPluginParticipation,
      updateCommunityPluginParticipationBatch: vi.fn(async (commands) => {
        for (const command of commands) {
          await updateCommunityPluginParticipation(command);
        }
        return true;
      }),
      retirePendingStateForPaths,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      mutationLedger: [],
      remoteScope,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: false,
      remoteFolders: [],
      remoteSnapshot: [],
      baseSnapshot: [],
      getRemoteCommunityPluginCatalog: vi.fn().mockReturnValue(remoteCatalog),
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: remoteScope,
        anchors: {},
        pending: [],
      }),
      getCommunityPluginManifestObservations: vi.fn().mockReturnValue([]),
    } as never;
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
      getMobileDesktopOnlyCommunityPluginIds: vi.fn().mockReturnValue([]),
    } as never;
    plugin.scanner = { setConfig: vi.fn() } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    const scheduleJoinSync = vi.spyOn(
      plugin as never,
      "scheduleCommunityPluginJoinSync",
    ).mockImplementation(() => undefined);
    const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

    await plugin.updateCommunityPluginFilesSelection("calendar", true);

    expect(updateCommunityPluginParticipation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "request-join",
        pluginId: "calendar",
        operationId: expect.any(String),
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      }),
    );
    expect(scheduleJoinSync).toHaveBeenCalledTimes(1);
    expect(plugin.syncCommunityPlugins).toBe(true);
    expect(saveData).not.toHaveBeenCalled();
    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([
      expect.objectContaining({
        id: "calendar",
        participationPhase: "join-requested",
      }),
    ]);

    await plugin.updateCommunityPluginFilesSelection("calendar", false);
    expect(participation.pluginsById.calendar?.phase).toBe("excluded");
    const retireCalendarPath = retirePendingStateForPaths.mock.calls.at(-1)?.[0];
    expect(retireCalendarPath(
      ".obsidian/plugins/calendar/main.js",
    )).toBe(true);
    expect(retireCalendarPath("Notes/keep.md")).toBe(false);
    expect(retireCalendarPath(
      ".obsidian/plugins/easy-sync/main.js",
    )).toBe(false);
    expect(retirePendingStateForPaths.mock.calls.at(-1)?.[1]).toBe(true);
    expect(saveData).not.toHaveBeenCalled();

    await plugin.saveSyncSettings();
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      "sync-community-plugins": true,
      "community-plugin-sync-policy": expect.objectContaining({
        files: frozenLegacyPolicy.files,
      }),
    }));
  });

  it("routes the community-plugin outer switch through source-bound folder scope expansion", async () => {
    const {
      plugin,
      getParticipation,
      commitSyncPathSettingsChange,
      retirePendingStateForPaths,
      commitOrder,
    } = makeCommunityPluginScopeSwitchHarness();

    await plugin.updateCommunityPluginFilesScope(true);

    expect(getParticipation().scopeEnabled).toBe(true);
    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(retirePendingStateForPaths).not.toHaveBeenCalled();
    expect(commitOrder).toEqual(["scope", "participation"]);
    const selectedCommunityPluginIds =
      commitSyncPathSettingsChange.mock.calls[0]![2];
    const scopeChange = commitSyncPathSettingsChange.mock.calls[0]![3] as {
      folderScopeTransition: {
        previous: FolderSyncScopeSnapshotV1;
        target: FolderSyncScopeSnapshotV1;
      };
      requiresCompleteRemoteIdentitySnapshot: boolean;
    };
    expect(selectedCommunityPluginIds).toEqual(["calendar"]);
    expect(scopeChange.requiresCompleteRemoteIdentitySnapshot).toBe(true);
    expect(isFolderPathInSyncScopeSnapshot(
      scopeChange.folderScopeTransition.previous,
      ".obsidian/plugins/calendar",
    )).toBe(false);
    expect(isFolderPathInSyncScopeSnapshot(
      scopeChange.folderScopeTransition.target,
      ".obsidian/plugins/calendar",
    )).toBe(true);
  });

  it("persists the community-plugin switch before V2 activation without recovery or sync", async () => {
    const plugin = new EasySyncPlugin();
    const persisted: Record<string, unknown> = {};
    const commitSyncPathSettingsChange = vi.fn(async (
      _isPathInScope: (path: string) => boolean,
      persistSettings: (data: Record<string, unknown>) => void,
    ) => {
      persistSettings(persisted);
    });
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          configDir: ".obsidian",
          adapter: { exists: vi.fn().mockResolvedValue(false) },
        },
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.state = {
      isV2StateActive: false,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: false,
      remoteFolders: [],
      mutationLedger: [],
      commitSyncPathSettingsChange,
    } as never;
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    const ensureParticipation = vi.spyOn(
      plugin as never,
      "ensureCommunityPluginParticipationInitialized",
    );
    const runAutomaticSync = vi.spyOn(
      plugin as never,
      "runAutomaticSync",
    );
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(
      () => undefined,
    );

    await expect(plugin.updateCommunityPluginFilesScope(true)).resolves.toBeUndefined();

    expect(persisted["sync-community-plugins"]).toBe(true);
    expect(plugin.syncCommunityPlugins).toBe(true);
    expect(ensureParticipation).not.toHaveBeenCalled();
    expect(runAutomaticSync).not.toHaveBeenCalled();
    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
  });

  it("routes a participating plugin exclusion through the same scope transaction", async () => {
    const {
      plugin,
      getParticipation,
      commitSyncPathSettingsChange,
      retirePendingStateForPaths,
      commitOrder,
    } = makeCommunityPluginScopeSwitchHarness();
    await plugin.updateCommunityPluginFilesScope(true);
    commitSyncPathSettingsChange.mockClear();
    commitOrder.length = 0;

    await plugin.updateCommunityPluginFilesSelection("calendar", false);

    expect(getParticipation().pluginsById.calendar?.phase).toBe("excluded");
    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(retirePendingStateForPaths).not.toHaveBeenCalled();
    expect(commitOrder).toEqual(["scope", "participation"]);
    const scopeChange = commitSyncPathSettingsChange.mock.calls[0]![3] as {
      folderScopeTransition: {
        previous: FolderSyncScopeSnapshotV1;
        target: FolderSyncScopeSnapshotV1;
      };
    };
    expect(isFolderPathInSyncScopeSnapshot(
      scopeChange.folderScopeTransition.previous,
      ".obsidian/plugins/calendar",
    )).toBe(true);
    expect(isFolderPathInSyncScopeSnapshot(
      scopeChange.folderScopeTransition.target,
      ".obsidian/plugins/calendar",
    )).toBe(false);
  });

  it("keeps the prior participation authoritative when its scope checkpoint cannot be written", async () => {
    const { plugin, getParticipation, commitOrder } =
      makeCommunityPluginScopeSwitchHarness(
        new Error("checkpoint write interrupted"),
      );

    await expect(plugin.updateCommunityPluginFilesScope(true))
      .rejects.toThrow("checkpoint write interrupted");

    expect(getParticipation().scopeEnabled).toBe(false);
    expect(plugin.syncCommunityPlugins).toBe(false);
    expect(plugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: ["calendar"],
    });
    expect(commitOrder).toEqual(["scope"]);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("keeps the prior participation authoritative when the atomic participation commit fails after scope preparation", async () => {
    const {
      plugin,
      getParticipation,
      commitSyncPathSettingsChange,
      updateCommunityPluginParticipationBatch,
    } = makeCommunityPluginScopeSwitchHarness();
    updateCommunityPluginParticipationBatch.mockRejectedValueOnce(
      new Error("participation commit interrupted"),
    );

    await expect(plugin.updateCommunityPluginFilesScope(true))
      .rejects.toThrow("participation commit interrupted");

    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(updateCommunityPluginParticipationBatch).toHaveBeenCalledOnce();
    expect(getParticipation().scopeEnabled).toBe(false);
    expect(plugin.syncCommunityPlugins).toBe(false);
  });

  it("commits an explicit plugin-scope exit before settling its owned intent-only code upload", async () => {
    const {
      plugin,
      getParticipation,
      commitSyncPathSettingsChange,
      updateCommunityPluginParticipationBatch,
      commitOrder,
    } = makeCommunityPluginScopeSwitchHarness();
    const state = plugin.state as never as {
      mutationLedger: Array<{ intent: { operationId: string } }>;
    };
    state.mutationLedger.push({
      intent: { operationId: "resojot-main-upload" },
    });
    const inspect = vi.fn((
      isPluginExcluded: (pluginId: string) => boolean,
    ) => {
      expect(isPluginExcluded("calendar")).toBe(true);
      return [...state.mutationLedger];
    });
    const retire = vi.fn(async (
      isPluginExcluded: (pluginId: string) => boolean,
    ) => {
      expect(isPluginExcluded("calendar")).toBe(true);
      state.mutationLedger.splice(0);
      commitOrder.push("recovery-exit");
      return true;
    });
    Object.assign(plugin.syncExecutor as object, {
      inspectSelectedPluginCodeUploadRecoveriesForScopeExit: inspect,
      retireSelectedPluginCodeUploadRecoveriesForScopeExit: retire,
    });

    await expect(plugin.updateCommunityPluginFilesScope(false)).resolves.toBeUndefined();

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenCalledOnce();
    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(updateCommunityPluginParticipationBatch).toHaveBeenCalledOnce();
    expect(getParticipation().scopeEnabled).toBe(false);
    expect(plugin.syncCommunityPlugins).toBe(false);
    expect(commitOrder).toEqual([
      "participation",
      "scope",
      "recovery-exit",
      "pending",
    ]);
  });

  it("keeps the plugin excluded and the recovery evidence when the exit checkpoint fails", async () => {
    const {
      plugin,
      getParticipation,
      updateCommunityPluginParticipationBatch,
      commitOrder,
    } = makeCommunityPluginScopeSwitchHarness(
      new Error("checkpoint write interrupted"),
    );
    const state = plugin.state as never as {
      mutationLedger: Array<{ intent: { operationId: string } }>;
    };
    state.mutationLedger.push({
      intent: { operationId: "resojot-main-upload" },
    });
    const inspect = vi.fn().mockReturnValue([...state.mutationLedger]);
    const retire = vi.fn().mockResolvedValue(false);
    Object.assign(plugin.syncExecutor as object, {
      inspectSelectedPluginCodeUploadRecoveriesForScopeExit: inspect,
      retireSelectedPluginCodeUploadRecoveriesForScopeExit: retire,
    });

    await expect(plugin.updateCommunityPluginFilesScope(false))
      .rejects.toThrow("checkpoint write interrupted");

    expect(updateCommunityPluginParticipationBatch).toHaveBeenCalledOnce();
    expect(getParticipation().scopeEnabled).toBe(false);
    expect(plugin.syncCommunityPlugins).toBe(false);
    expect(state.mutationLedger).toHaveLength(1);
    expect(retire).not.toHaveBeenCalled();
    expect(commitOrder).toEqual(["participation", "scope"]);
  });

  it("resumes a durably excluded plugin scope before retiring old recovery evidence", async () => {
    const {
      plugin,
      getParticipation,
      commitSyncPathSettingsChange,
      commitOrder,
    } = makeCommunityPluginScopeSwitchHarness();
    const participation = getParticipation();
    const state = plugin.state as never as {
      mutationLedger: Array<{ intent: { operationId: string } }>;
    };
    state.mutationLedger.push({
      intent: { operationId: "resojot-main-upload" },
    });
    const inspect = vi.fn().mockReturnValue([...state.mutationLedger]);
    const retire = vi.fn(async () => {
      state.mutationLedger.splice(0);
      commitOrder.push("recovery-exit");
      return true;
    });
    Object.assign(plugin.syncExecutor as object, {
      inspectSelectedPluginCodeUploadRecoveriesForScopeExit: inspect,
      retireSelectedPluginCodeUploadRecoveriesForScopeExit: retire,
    });
    (plugin as unknown as {
      applyCommunityPluginParticipationProjection(
        value: typeof participation,
      ): void;
    }).applyCommunityPluginParticipationProjection(participation);

    await expect((plugin as unknown as {
      resumeExcludedCommunityPluginCodeRecoveryScopeExit(
        value: typeof participation,
      ): Promise<boolean>;
    }).resumeExcludedCommunityPluginCodeRecoveryScopeExit(participation))
      .resolves.toBe(true);

    expect(inspect).toHaveBeenCalledOnce();
    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
    expect(state.mutationLedger).toEqual([]);
    expect(commitOrder).toEqual(["scope", "recovery-exit"]);
  });

  it("keeps the prior participation authoritative when pending retirement fails before a metadata-only transition", async () => {
    const {
      plugin,
      getParticipation,
      retirePendingStateForPaths,
      updateCommunityPluginParticipationBatch,
      commitOrder,
    } = makeCommunityPluginScopeSwitchHarness(
      undefined,
      new Error("pending retirement interrupted"),
    );
    await updateCommunityPluginParticipationBatch([{
      type: "request-join",
      pluginId: "calendar",
      operationId: "join-calendar",
    }]);
    (plugin as unknown as {
      applyCommunityPluginParticipationProjection(
        value: ReturnType<typeof createEmptyDeviceCommunityPluginParticipation>,
      ): void;
    }).applyCommunityPluginParticipationProjection(getParticipation());
    retirePendingStateForPaths.mockClear();
    updateCommunityPluginParticipationBatch.mockClear();
    commitOrder.length = 0;

    await expect((plugin as unknown as {
      commitCommunityPluginParticipationCommands(
        commands: Array<{
          type: "block";
          pluginId: string;
          reason: string;
        }>,
        options: { commitSyncPathSettingsTransition: boolean },
      ): Promise<void>;
    }).commitCommunityPluginParticipationCommands([{
      type: "block",
      pluginId: "calendar",
      reason: "catalog-unavailable",
    }], {
      commitSyncPathSettingsTransition: true,
    }))
      .rejects.toThrow("pending retirement interrupted");

    expect(retirePendingStateForPaths).toHaveBeenCalledOnce();
    expect(updateCommunityPluginParticipationBatch).not.toHaveBeenCalled();
    expect(getParticipation().pluginsById.calendar?.phase)
      .toBe("join-requested");
    expect(plugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: [],
    });
    expect(commitOrder).toEqual(["pending"]);
  });

  it("retries a persisted blocked join and retires restore authority only after verified completion", async () => {
    const plugin = new EasySyncPlugin();
    const remoteScope = {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "files",
    };
    let participation = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      {
        type: "request-join",
        pluginId: "calendar",
        operationId: "join-calendar-1",
        targetCatalogRevision: 7,
        targetBundleDigest: "a".repeat(64),
      },
    );
    participation = reduceDeviceCommunityPluginParticipation(participation, {
      type: "block",
      pluginId: "calendar",
      reason: "catalog-unavailable",
    });
    participation = reduceDeviceCommunityPluginParticipation(participation, {
      type: "request-join",
      pluginId: "realtime-transcription",
      operationId: "join-realtime-1",
      targetCatalogRevision: 7,
      targetBundleDigest: "b".repeat(64),
    });
    participation = reduceDeviceCommunityPluginParticipation(participation, {
      type: "block",
      pluginId: "realtime-transcription",
      reason: "manifest-incompatible",
    });
    const updateCommunityPluginParticipation = vi.fn(async (command) => {
      participation = reduceDeviceCommunityPluginParticipation(
        participation,
        command,
      );
      return true;
    });
    const catalog: RemoteCommunityPluginCatalogV1 = {
      version: 1,
      scope: remoteScope,
      complete: true,
      stale: false,
      revision: 7,
      observedAt: 1,
      sourceDigest: "f".repeat(64),
      entries: [{
        pluginId: "calendar",
        bundleState: "complete",
        bundleDigest: "a".repeat(64),
        members: [{
          path: ".obsidian/plugins/calendar/main.js",
          remoteId: "main-id",
          parentId: "calendar-folder",
          size: 4,
          mtime: 1,
          eTag: "main-etag",
          cTag: "main-ctag",
          sha256Hash: null,
          quickXorHash: null,
        }, {
          path: ".obsidian/plugins/calendar/manifest.json",
          remoteId: "manifest-id",
          parentId: "calendar-folder",
          size: 8,
          mtime: 1,
          eTag: "manifest-etag",
          cTag: "manifest-ctag",
          sha256Hash: null,
          quickXorHash: null,
        }],
      }],
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          configDir: ".obsidian",
          adapter: { exists: vi.fn().mockResolvedValue(false) },
        },
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.state = {
      isV2StateActive: true,
      remoteScope,
      remoteGeneration: 4,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      mutationLedger: [],
      planReviewActive: false,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: true,
      remoteFolders: [{
        path: ".obsidian/plugins/calendar",
        driveId: "calendar-folder",
        parentId: "plugins-folder",
        name: "calendar",
      }],
      getCommunityPluginParticipation: () => structuredClone(participation),
      updateCommunityPluginParticipation,
      updateCommunityPluginParticipationBatch: vi.fn(async (commands) => {
        for (const command of commands) {
          await updateCommunityPluginParticipation(command);
        }
        return true;
      }),
      retirePendingStateForPaths: vi.fn().mockResolvedValue(undefined),
      commitSyncPathSettingsChange: vi.fn(async (
        _isPathInScope: (path: string) => boolean,
        persistSettings: (data: Record<string, unknown>) => void,
      ) => persistSettings({})),
      getRemoteCommunityPluginCatalog: vi.fn().mockReturnValue(catalog),
    } as never;
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.syncExecutor = {
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    (plugin as unknown as {
      communityPluginParticipation: typeof participation;
    }).communityPluginParticipation = structuredClone(participation);

    expect((plugin as unknown as {
      hasPendingCommunityPluginJoin(): boolean;
    }).hasPendingCommunityPluginJoin()).toBe(true);

    const prepared = await (plugin as unknown as {
      prepareCommunityPluginJoinsForSync(): Promise<{
        authorizations: Array<{ pluginId: string }>;
      }>;
    }).prepareCommunityPluginJoinsForSync();

    expect(prepared.authorizations).toEqual([
      expect.objectContaining({ pluginId: "calendar" }),
    ]);
    expect(participation.pluginsById["realtime-transcription"]).toMatchObject({
      phase: "blocked",
      blockedReason: "remote-bundle-missing",
      operationId: "join-realtime-1",
    });
    expect(participation.pluginsById.calendar?.phase).toBe("restoring");
    expect(plugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: ["calendar"],
    });
    expect(plugin.state.commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(plugin.state.commitSyncPathSettingsChange).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      ["calendar"],
      expect.objectContaining({
        requiresCompleteRemoteIdentitySnapshot: true,
      }),
    );

    updateCommunityPluginParticipation.mockRejectedValueOnce(
      new Error("completion checkpoint failed"),
    );
    await expect((plugin as unknown as {
      persistCommunityPluginJoinOutcomes(
        completed: { files: string[]; data: string[] },
        blocks: unknown[],
      ): Promise<void>;
    }).persistCommunityPluginJoinOutcomes(
      { files: ["calendar"], data: [] },
      [],
    )).rejects.toThrow("completion checkpoint failed");
    expect(participation.pluginsById.calendar?.phase).toBe("restoring");

    await (plugin as unknown as {
      persistCommunityPluginJoinOutcomes(
        completed: { files: string[]; data: string[] },
        blocks: unknown[],
      ): Promise<void>;
    }).persistCommunityPluginJoinOutcomes(
      { files: ["calendar"], data: [] },
      [],
    );

    expect(participation.pluginsById.calendar).toMatchObject({
      phase: "participating",
      lastConfirmedLocalBundleDigest: "a".repeat(64),
    });
    expect(participation.pluginsById.calendar?.joinedGeneration)
      .toBeUndefined();
    expect((plugin as unknown as {
      hasPendingCommunityPluginJoin(): boolean;
    }).hasPendingCommunityPluginJoin()).toBe(true);
    await expect((plugin as unknown as {
      prepareCommunityPluginJoinsForSync(): Promise<{
        authorizations: Array<{ pluginId: string }>;
      }>;
    }).prepareCommunityPluginJoinsForSync()).resolves.toEqual({
      authorizations: [],
    });
  });

  it("checkpoints a complete local plugin before its join enters file scope", async () => {
    const plugin = new EasySyncPlugin();
    const remoteScope = {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "files",
    };
    let participation = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      {
        type: "request-join",
        pluginId: "calendar",
        operationId: "join-calendar-local",
      },
    );
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          configDir: ".obsidian",
          adapter: {
            exists: vi.fn(async (path: string) =>
              path === ".obsidian/plugins/calendar/main.js"
              || path === ".obsidian/plugins/calendar/manifest.json"
            ),
          },
        },
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    const commitSyncPathSettingsChange = vi.fn(async (
      _isPathInScope: (path: string) => boolean,
      persistSettings: (data: Record<string, unknown>) => void,
    ) => persistSettings({}));
    plugin.state = {
      isV2StateActive: true,
      remoteScope,
      remoteGeneration: 4,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      mutationLedger: [],
      planReviewActive: false,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: true,
      remoteFolders: [{
        path: ".obsidian/plugins/calendar",
        driveId: "calendar-folder",
        parentId: "plugins-folder",
        name: "calendar",
      }],
      getCommunityPluginParticipation: () => structuredClone(participation),
      updateCommunityPluginParticipation: vi.fn(async (command) => {
        participation = reduceDeviceCommunityPluginParticipation(
          participation,
          command,
        );
        return true;
      }),
      updateCommunityPluginParticipationBatch: vi.fn(async (commands) => {
        for (const command of commands) {
          participation = reduceDeviceCommunityPluginParticipation(
            participation,
            command,
          );
        }
        return true;
      }),
      retirePendingStateForPaths: vi.fn().mockResolvedValue(undefined),
      commitSyncPathSettingsChange,
      getRemoteCommunityPluginCatalog: vi.fn().mockReturnValue(null),
    } as never;
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect((plugin as unknown as {
      prepareCommunityPluginJoinsForSync(): Promise<{
        authorizations: Array<{ pluginId: string }>;
      }>;
    }).prepareCommunityPluginJoinsForSync()).resolves.toEqual({
      authorizations: [],
    });

    expect(participation.pluginsById.calendar?.phase).toBe("participating");
    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(commitSyncPathSettingsChange).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      ["calendar"],
      expect.objectContaining({
        requiresCompleteRemoteIdentitySnapshot: true,
      }),
    );
  });

  it("coalesces repeated plugin switches into one automatic join round", async () => {
    vi.useFakeTimers();
    try {
      const plugin = new EasySyncPlugin();
      const runAutomaticSync = vi.spyOn(
        plugin as never,
        "runAutomaticSync",
      ).mockResolvedValue(true);
      plugin.setAutoSyncChangeDelaySeconds(1);
      const scheduler = plugin as unknown as {
        scheduleCommunityPluginJoinSync(trigger?: string): void;
      };

      scheduler.scheduleCommunityPluginJoinSync("first-switch");
      scheduler.scheduleCommunityPluginJoinSync("second-switch");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(runAutomaticSync).toHaveBeenCalledTimes(1);
      expect(runAutomaticSync).toHaveBeenCalledWith(
        "dirty",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("migrates the old file policy once before exposing the participation read model", async () => {
    const plugin = new EasySyncPlugin();
    const migrated = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      { type: "confirm-participating", pluginId: "calendar" },
    );
    let participationState: typeof migrated | null = null;
    const initializeCommunityPluginParticipation = vi.fn(async () => {
      participationState = migrated;
      return { changed: true, state: migrated };
    });
    const adapter = {
      exists: vi.fn(async (path: string) => [
        ".obsidian/plugins",
        ".obsidian/plugins/calendar/main.js",
        ".obsidian/plugins/calendar/manifest.json",
      ].includes(path)),
      list: vi.fn().mockResolvedValue({
        files: [],
        folders: [".obsidian/plugins/calendar"],
      }),
      read: vi.fn(async (path: string) => {
        if (path.endsWith("manifest.json")) {
          return JSON.stringify({
            id: "calendar",
            name: "Calendar",
            version: "1.0.0",
          });
        }
        throw new Error("missing");
      }),
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: { vault: { adapter, configDir: ".obsidian" } },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.syncCommunityPlugins = true;
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    };
    plugin.state = {
      isV2StateActive: true,
      getCommunityPluginParticipation: vi.fn(() => participationState),
      initializeCommunityPluginParticipation,
      remoteScope: null,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: false,
      remoteFolders: [],
      remoteSnapshot: [],
      baseSnapshot: [],
    } as never;
    plugin.scanner = { setConfig: vi.fn() } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await plugin.ensureCommunityPluginParticipationInitialized();
    await plugin.ensureCommunityPluginParticipationInitialized();

    expect(initializeCommunityPluginParticipation).toHaveBeenCalledOnce();
    expect(initializeCommunityPluginParticipation).toHaveBeenCalledWith(
      expect.objectContaining({
        filesEnabled: true,
        knownPluginIds: ["calendar"],
        completeLocalBundlePluginIds: ["calendar"],
      }),
    );
    expect(plugin.getCommunityPluginParticipation()?.pluginsById.calendar)
      .toMatchObject({ phase: "participating" });
  });

  it("defaults and normalizes the local-change sync delay without a cold-start write", async () => {
    const defaultPlugin = new EasySyncPlugin();
    vi.spyOn(defaultPlugin, "loadData").mockResolvedValue({});
    const defaultSave = vi.spyOn(defaultPlugin, "saveData").mockResolvedValue(undefined);

    await defaultPlugin.loadSyncSettings();

    expect(defaultPlugin.autoSyncChangeDelaySeconds).toBe(7);
    expect(defaultSave).not.toHaveBeenCalled();

    const clampedPlugin = new EasySyncPlugin();
    vi.spyOn(clampedPlugin, "loadData").mockResolvedValue({
      "auto-sync-change-delay-seconds": 99,
    });
    const clampedSave = vi.spyOn(clampedPlugin, "saveData").mockResolvedValue(undefined);

    await clampedPlugin.loadSyncSettings();

    expect(clampedPlugin.autoSyncChangeDelaySeconds).toBe(10);
    expect(clampedSave).not.toHaveBeenCalled();

    const disabledPlugin = new EasySyncPlugin();
    vi.spyOn(disabledPlugin, "loadData").mockResolvedValue({
      "auto-sync-change-delay-seconds": 0,
    });

    await disabledPlugin.loadSyncSettings();

    expect(disabledPlugin.autoSyncChangeDelaySeconds).toBe(0);

    clampedPlugin.setAutoSyncChangeDelaySeconds(0);
    await clampedPlugin.saveSyncSettings();
    expect(clampedSave).toHaveBeenCalledWith(expect.objectContaining({
      "auto-sync-change-delay-seconds": 0,
    }));
  });

  it("keeps an explicit community-plugin join working when local-change sync is off", async () => {
    vi.useFakeTimers();
    try {
      const plugin = new EasySyncPlugin();
      const runAutomaticSync = vi.spyOn(
        plugin as never,
        "runAutomaticSync",
      ).mockResolvedValue(true);
      plugin.setAutoSyncChangeDelaySeconds(0);
      const scheduler = plugin as unknown as {
        scheduleCommunityPluginJoinSync(trigger?: string): void;
      };

      scheduler.scheduleCommunityPluginJoinSync("explicit-switch");
      await vi.advanceTimersByTimeAsync(7_000);

      expect(runAutomaticSync).toHaveBeenCalledOnce();
      expect(runAutomaticSync).toHaveBeenCalledWith("dirty");
    } finally {
      vi.useRealTimers();
    }
  });

  it("migrates public booleans to outer switches with retained default-all policies", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      "sync-community-plugins": true,
      "sync-plugin-data": false,
    });
    vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

    await plugin.loadSyncSettings();

    expect(plugin.communityPluginSyncPolicy).toEqual({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "all", pluginIds: [] },
    });
    expect(plugin.syncCommunityPlugins).toBe(true);
    expect(plugin.syncPluginData).toBe(false);
    await plugin.saveSyncSettings();
    expect(plugin.saveData).toHaveBeenCalledWith(expect.objectContaining({
      "community-plugin-sync-policy": plugin.communityPluginSyncPolicy,
      "sync-community-plugins": true,
      "sync-plugin-data": false,
    }));

    const pausedPlugin = new EasySyncPlugin();
    vi.spyOn(pausedPlugin, "loadData").mockResolvedValue({
      "sync-community-plugins": false,
      "sync-plugin-data": true,
      "community-plugin-sync-policy": {
        version: 1,
        files: { mode: "selected", pluginIds: ["calendar"] },
        data: { mode: "selected", pluginIds: ["calendar"] },
      },
    });
    await pausedPlugin.loadSyncSettings();
    expect(pausedPlugin.syncCommunityPlugins).toBe(false);
    expect(pausedPlugin.syncPluginData).toBe(false);
    expect(pausedPlugin.communityPluginSyncPolicy).toEqual({
      version: 1,
      files: { mode: "selected", pluginIds: ["calendar"] },
      data: { mode: "selected", pluginIds: ["calendar"] },
    });
  });

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

  it("loads and normalizes the per-device notification popups level without a cold-start write", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      "notification-popups": "important",
    });
    const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

    await plugin.loadSyncSettings();

    expect(plugin.notificationPopups).toBe("important");
    expect(saveData).not.toHaveBeenCalled();

    const unknownPlugin = new EasySyncPlugin();
    vi.spyOn(unknownPlugin, "loadData").mockResolvedValue({
      "notification-popups": "sometimes",
    });
    const unknownSave = vi.spyOn(unknownPlugin, "saveData")
      .mockResolvedValue(undefined);
    await unknownPlugin.loadSyncSettings();
    expect(unknownPlugin.notificationPopups).toBe("all");
    expect(unknownSave).not.toHaveBeenCalled();

    const defaultPlugin = new EasySyncPlugin();
    vi.spyOn(defaultPlugin, "loadData").mockResolvedValue({});
    await defaultPlugin.loadSyncSettings();
    expect(defaultPlugin.notificationPopups).toBe("all");

    unknownPlugin.notificationPopups = "off";
    await unknownPlugin.saveSyncSettings();
    expect(unknownSave).toHaveBeenCalledWith(expect.objectContaining({
      "notification-popups": "off",
    }));
  });

  it("applies the notification popups level to the notice center", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      "notification-popups": "off",
    });
    vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);

    await plugin.loadSyncSettings();

    // loadSyncSettings applied the level: ambient requests are now rejected
    // even at critical priority, while feedback stays visible.
    expect(plugin.noticeCenter.show({
      key: "ambient",
      message: "m",
      priority: 60,
      category: "ambient",
    })).toBe(false);
    expect(plugin.noticeCenter.show({
      key: "feedback",
      message: "m",
      priority: 10,
    })).toBe(true);
    expect(plugin.noticeCenter.activeKey).toBe("feedback");

    // A direct apply after a settings change behaves the same.
    plugin.notificationPopups = "important";
    plugin.applyNotificationPopups();
    expect(plugin.noticeCenter.show({
      key: "ambient-low",
      message: "m",
      priority: 10,
      category: "ambient",
    })).toBe(false);
    expect(plugin.noticeCenter.show({
      key: "ambient-high",
      message: "m",
      priority: 40,
      category: "ambient",
    })).toBe(true);
    expect(plugin.noticeCenter.activeKey).toBe("ambient-high");
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

  it("releases a legacy conflict-only automatic pause after state load", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      "auto-sync-paused": true,
      "easy-sync-pending-conflicts": [{
        type: "conflict",
        path: "notes/conflict.md",
        reason: "reason.bothSidesModified",
      }],
      "easy-sync-history": [{
        id: "conflict-run",
        mode: "manual",
        status: "partial",
        startedAt: 1,
        endedAt: 2,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 1,
        skipped: 0,
        errors: 0,
        message: "result.conflictsPending",
        files: [],
      }],
    });
    const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync")
      .mockImplementation(() => undefined);

    await plugin.loadSyncSettings();
    expect(plugin.autoSyncPaused).toBe(true); // raw persisted value still paused

    // State load proves conflicts are the sole pause owner → release.
    plugin.state = {
      isV2StateActive: true,
      planReviewActive: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      mutationLedger: [],
      pendingRemoteDeletes: [],
      pendingIssues: [],
      pendingConflicts: [{
        type: "conflict",
        path: "notes/conflict.md",
        reason: "reason.bothSidesModified",
      }],
      syncHistory: [{
        id: "conflict-run",
        mode: "manual",
        status: "partial",
        startedAt: 1,
        endedAt: 2,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 1,
        skipped: 0,
        errors: 0,
        message: "result.conflictsPending",
        files: [],
      }],
    } as never;
    plugin._stateLoaded = true;

    await (plugin as never as {
      releaseLegacyConflictOnlyPauseIfSafe: () => Promise<void>;
    }).releaseLegacyConflictOnlyPauseIfSafe();

    expect(plugin.autoSyncPaused).toBe(false);
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).toHaveBeenCalledOnce();
    expect(saveData).not.toHaveBeenCalled();
  });

  it("keeps an automatic pause after state load when history also owns a failure", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = true;
    plugin.state = {
      isV2StateActive: true,
      planReviewActive: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      mutationLedger: [],
      pendingRemoteDeletes: [],
      pendingIssues: [],
      pendingConflicts: [{
        type: "conflict",
        path: "notes/conflict.md",
        reason: "reason.bothSidesModified",
      }],
      syncHistory: [{
        id: "failed-conflict-run",
        mode: "manual",
        status: "partial",
        startedAt: 1,
        endedAt: 2,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 1,
        skipped: 0,
        errors: 1,
        message: "result.partial",
        files: [],
      }],
    } as never;
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);

    await (plugin as never as {
      releaseLegacyConflictOnlyPauseIfSafe: () => Promise<void>;
    }).releaseLegacyConflictOnlyPauseIfSafe();

    // The error owns the pause; it must not be released by the conflict-only
    // migration path.
    expect(plugin.autoSyncPaused).toBe(true);
    expect(saveSyncSettings).not.toHaveBeenCalled();
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

  it("changes sync paths before first V2 activation without rewriting legacy remote state", async () => {
    const plugin = new EasySyncPlugin();
    let persistedData: Record<string, unknown> = {};
    let activeExcluded: string[] = [];
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          adapter: {
            read: vi.fn().mockResolvedValue(JSON.stringify({
              version: 1,
              generation: 4,
              deltaLink: "https://graph.example/public-1.1.3",
              scope: {
                accountId: "account-id",
                driveId: "drive-id",
                vaultFolderId: "vault-folder-id",
                filesRootId: "files-root-id",
              },
              entries: {
                "Notes/keep.md": {
                  path: "Notes/keep.md",
                  driveId: "note-id",
                  parentId: "files-root-id",
                  size: 4,
                  mtime: 1,
                  eTag: "etag-note",
                  cTag: "ctag-note",
                },
              },
            })),
            write: vi.fn().mockResolvedValue(undefined),
          },
          configDir: ".obsidian",
        },
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: {
        id: "easy-sync",
        dir: ".obsidian/plugins/easy-sync",
      },
    });
    vi.spyOn(plugin, "loadData").mockImplementation(
      async () => structuredClone(persistedData),
    );
    vi.spyOn(plugin, "saveData").mockImplementation(async (data) => {
      persistedData = structuredClone(data as Record<string, unknown>);
    });
    plugin.scanner = {
      setConfig: vi.fn((config: { excludedFolders?: string[] }) => {
        activeExcluded = [...(config.excludedFolders ?? [])];
      }),
      shouldSyncPath: vi.fn((path: string) =>
        !activeExcluded.some((folder) =>
          path === folder || path.startsWith(`${folder}/`),
        )),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as never;
    const state = new StateManager(plugin as never);
    await state.load();
    plugin.state = state;
    plugin.syncExecutor = { hasActivityInFlight: false } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await plugin.updateExcludedFolders(["Private"]);

    expect(state.isV2StateActive).toBe(false);
    expect(state.hasRemoteState).toBe(true);
    expect(plugin.excludedFolders).toEqual(["Private"]);
    expect(persistedData["sync-excluded-folders"]).toEqual(["Private"]);
    expect(state.remoteScope).toEqual({
      accountId: "account-id",
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    });
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("persists a source-bound V2 folder expansion instead of clearing its identity source", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncPluginFiles = false;
    let includePaths: string[] = [];
    const scanner = {
      setConfig: vi.fn((config: { includePaths?: string[] }) => {
        includePaths = [...(config.includePaths ?? [])];
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn((path: string) => {
        const prefix = `${path.replace(/\/+$/, "")}/`;
        return includePaths.some(
          (include) =>
            include.startsWith(prefix)
            || prefix.startsWith(include),
        );
      }),
    };
    plugin.scanner = scanner as never;
    (plugin as unknown as { applySyncPathSettings(): void })
      .applySyncPathSettings();
    const clearRemoteState = vi.fn().mockResolvedValue(undefined);
    const commitSyncPathSettingsChange = vi.fn(async (
      _isPathInScope: (path: string) => boolean,
      persistSettings: (data: Record<string, unknown>) => void,
      _selectedCommunityPluginIds: readonly string[] | undefined,
      scopeChange: {
        previousSettingsFingerprint: string;
        targetSettingsFingerprint: string;
        expandedFolderPaths: string[];
        includedFolderPaths: string[];
        requiresCompleteRemoteIdentitySnapshot: boolean;
      },
    ) => {
      expect(scopeChange.previousSettingsFingerprint)
        .not.toBe(scopeChange.targetSettingsFingerprint);
      expect(scopeChange.expandedFolderPaths).toEqual([
        ".obsidian",
        ".obsidian/plugins",
        ".obsidian/plugins/easy-sync",
      ]);
      expect(scopeChange.includedFolderPaths).toEqual([
        ".obsidian",
        ".obsidian/plugins",
        ".obsidian/plugins/easy-sync",
      ]);
      expect(scopeChange.requiresCompleteRemoteIdentitySnapshot).toBe(true);
      persistSettings({});
    });
    plugin.state = {
      isV2StateActive: true,
      hasCompleteRemoteFolderIndex: true,
      remoteFolders: [
        {
          path: ".obsidian",
          driveId: "folder-obsidian",
          parentId: "root",
          name: ".obsidian",
        },
        {
          path: ".obsidian/plugins",
          driveId: "folder-plugins",
          parentId: "folder-obsidian",
          name: "plugins",
        },
        {
          path: ".obsidian/plugins/easy-sync",
          driveId: "folder-easy-sync",
          parentId: "folder-plugins",
          name: "easy-sync",
        },
      ],
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      clearRemoteState,
      commitSyncPathSettingsChange,
    } as never;
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(
      () => undefined,
    );

    await plugin.updateSyncPathSettings({ syncPluginFiles: true });

    expect(clearRemoteState).not.toHaveBeenCalled();
    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(plugin.syncPluginFiles).toBe(true);
  });

  it("publishes independent EasySync and community-plugin scanner ownership", () => {
    const plugin = new EasySyncPlugin();
    const setConfig = vi.fn();
    plugin.scanner = { setConfig } as never;

    plugin.syncPluginFiles = false;
    plugin.syncCommunityPlugins = true;
    (plugin as unknown as { applySyncPathSettings(): void })
      .applySyncPathSettings();
    expect(setConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      includeOwnPluginCode: false,
      includePluginCode: true,
    }));

    plugin.syncPluginFiles = true;
    plugin.syncCommunityPlugins = false;
    (plugin as unknown as { applySyncPathSettings(): void })
      .applySyncPathSettings();
    expect(setConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      includeOwnPluginCode: true,
      includePluginCode: false,
    }));
  });

  it("adds bookmarks as one exact Obsidian config owner", () => {
    const plugin = new EasySyncPlugin();
    const setConfig = vi.fn();
    plugin.scanner = { setConfig } as never;
    plugin.syncBookmarks = true;

    (plugin as unknown as { applySyncPathSettings(): void })
      .applySyncPathSettings();

    const config = setConfig.mock.calls.at(-1)?.[0] as {
      includePaths?: string[];
    };
    expect(config.includePaths).toContain(".obsidian/bookmarks.json");
    expect(config.includePaths).not.toContain(".obsidian/graph.json");
    expect(config.includePaths).not.toContain(".obsidian/");
  });

  it("marks an effective community-plugin selection expansion for a complete remote identity refresh", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncCommunityPlugins = true;
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: { mode: "none", pluginIds: [] },
    };
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as never;
    const commitSyncPathSettingsChange = vi.fn(async (
      _isPathInScope: (path: string) => boolean,
      persistSettings: (data: Record<string, unknown>) => void,
      _selectedCommunityPluginIds: readonly string[] | undefined,
      scopeChange: {
        expandedFolderPaths: string[];
        folderScopeTransition: {
          previous: FolderSyncScopeSnapshotV1;
          target: FolderSyncScopeSnapshotV1;
        };
        requiresCompleteRemoteIdentitySnapshot: boolean;
      },
    ) => {
      expect(scopeChange.expandedFolderPaths).toEqual([]);
      expect(scopeChange.requiresCompleteRemoteIdentitySnapshot).toBe(true);
      expect(isFolderPathInSyncScopeSnapshot(
        scopeChange.folderScopeTransition.previous,
        ".obsidian/plugins/calendar",
      )).toBe(false);
      expect(isFolderPathInSyncScopeSnapshot(
        scopeChange.folderScopeTransition.target,
        ".obsidian/plugins/calendar",
      )).toBe(true);
      expect(isFolderPathInSyncScopeSnapshot(
        scopeChange.folderScopeTransition.target,
        ".obsidian/plugins/easy-sync",
      )).toBe(false);
      persistSettings({});
    });
    plugin.state = {
      isV2StateActive: true,
      hasCompleteRemoteFolderIndex: true,
      remoteFolders: [],
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      commitSyncPathSettingsChange,
    } as never;
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(
      () => undefined,
    );

    await plugin.updateSyncPathSettings({
      communityPluginSyncPolicy: {
        version: 1,
        files: {
          mode: "all",
          pluginIds: [],
          restoringPluginIds: ["calendar"],
        },
        data: { mode: "none", pluginIds: [] },
      },
    });

    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
    expect(plugin.communityPluginSyncPolicy.files).toEqual({
      mode: "all",
      pluginIds: [],
      restoringPluginIds: ["calendar"],
    });
  });

  it("pauses plugin data with plugin files without erasing retained selections", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncCommunityPlugins = true;
    plugin.syncPluginData = true;
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: {
        mode: "selected",
        pluginIds: ["dataview"],
      },
    };
    const savedData: Record<string, unknown> = {};
    const setConfig = vi.fn();
    plugin.scanner = {
      setConfig,
      shouldSyncPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      clearRemoteState: vi.fn().mockResolvedValue(undefined),
      commitSyncPathSettingsChange: vi.fn(async (
        _isPathInScope: (path: string) => boolean,
        persistSettings: (data: Record<string, unknown>) => void,
      ) => {
        persistSettings(savedData);
      }),
    } as never;
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(
      () => undefined,
    );

    await plugin.updateSyncPathSettings({
      syncCommunityPlugins: false,
    });

    expect(plugin.syncCommunityPlugins).toBe(false);
    expect(plugin.syncPluginData).toBe(false);
    expect(plugin.communityPluginSyncPolicy).toEqual({
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: {
        mode: "selected",
        pluginIds: ["dataview"],
      },
    });
    expect(savedData).toMatchObject({
      "sync-community-plugins": false,
      "sync-plugin-data": false,
      "community-plugin-sync-policy": plugin.communityPluginSyncPolicy,
    });
    expect(setConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      pluginCodeSelection: { mode: "none", pluginIds: [] },
      pluginDataSelection: { mode: "none", pluginIds: [] },
    }));

    await plugin.updateSyncPathSettings({
      syncCommunityPlugins: true,
    });

    expect(plugin.syncCommunityPlugins).toBe(true);
    expect(plugin.syncPluginData).toBe(false);
    expect(plugin.communityPluginSyncPolicy.data).toEqual({
      mode: "selected",
      pluginIds: ["dataview"],
    });
    expect(savedData).toMatchObject({
      "sync-community-plugins": true,
      "sync-plugin-data": false,
    });
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("retires a migration review before changing the sync path scope", async () => {
    const plugin = new EasySyncPlugin();
    const events: string[] = [];
    let activeHold: object | null = {};
    plugin.scanner = {
      setConfig: vi.fn(() => {
        events.push("apply-candidate");
      }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
    } as never;
    const state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      planReviewAuthorization: {
        revision: 1,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "root",
        },
        reviewKind: "v2-migration",
      },
      clearPlanReview: vi.fn(async () => {
        events.push("retire-migration-review");
        activeHold = null;
        return true;
      }),
      commitSyncPathSettingsChange: vi.fn(async (
        _isPathInScope: (path: string) => boolean,
        persistSettings: (data: Record<string, unknown>) => void,
      ) => {
        events.push("commit");
        persistSettings({});
      }),
    };
    Object.defineProperty(state, "activeV2MigrationHold", {
      get: () => activeHold,
    });
    plugin.state = state as never;
    plugin.syncExecutor = { hasActivityInFlight: false } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await plugin.updateExcludedFolders(["Private"]);

    expect(events).toEqual([
      "retire-migration-review",
      "apply-candidate",
      "commit",
    ]);
    expect(state.clearPlanReview).toHaveBeenCalledWith(
      state.planReviewAuthorization,
    );
  });

  it("does not change sync paths while a migration hold lacks a retireable authorization", async () => {
    const plugin = new EasySyncPlugin();
    const clearRemoteState = vi.fn().mockResolvedValue(undefined);
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      activeV2MigrationHold: {},
      planReviewAuthorization: null,
      clearRemoteState,
    } as never;
    plugin.syncExecutor = { hasActivityInFlight: false } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.updateExcludedFolders(["Private"]))
      .rejects.toThrow("valid migration review");
    expect(clearRemoteState).not.toHaveBeenCalled();
    expect(plugin.excludedFolders).toEqual([]);
  });

  it("prepares one account-bound cloud folder snapshot for the exclusion modal", async () => {
    const plugin = new EasySyncPlugin();
    const createSyncExclusionFolderSnapshot = vi.fn().mockResolvedValue({
      hadPendingReview: true,
      remoteFolderPaths: ["Cloud-only"],
    });
    plugin.auth = {
      authState: { accountId: "account" },
    } as never;
    plugin.state = { createSyncExclusionFolderSnapshot } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.createSyncExclusionFolderSnapshot()).resolves.toEqual({
      hadPendingReview: true,
      remoteFolderPaths: ["Cloud-only"],
    });
    expect(createSyncExclusionFolderSnapshot).toHaveBeenCalledWith("account");
  });

  it("persists inferred device-local plugin-data exclusions without re-entering the operation lock", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncCommunityPlugins = true;
    plugin.syncPluginData = true;
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "all", pluginIds: [] },
    };
    let savedData: Record<string, unknown> = {};
    const setConfig = vi.fn();
    const commitSyncPathSettingsChange = vi.fn(async (
      _isPathInScope: (path: string) => boolean,
      persistSettings: (data: Record<string, unknown>) => void,
    ) => {
      persistSettings(savedData);
    });
    plugin.scanner = {
      setConfig,
      shouldSyncPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      clearRemoteState: vi.fn().mockResolvedValue(undefined),
      commitSyncPathSettingsChange,
    } as never;
    plugin.syncExecutor = {
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(
      () => undefined,
    );

    await (plugin as unknown as {
      persistCommunityPluginLocalIgnores(
        ignores: { files: string[]; data: string[] },
      ): Promise<void>;
    }).persistCommunityPluginLocalIgnores({
      files: ["calendar"],
      data: ["quickadd"],
      folderMoveHintRemoteIds: ["plugin-folder-id"],
    });

    expect(plugin.communityPluginSyncPolicy).toEqual({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["quickadd"],
      },
    });
    expect(savedData["community-plugin-sync-policy"]).toEqual(
      plugin.communityPluginSyncPolicy,
    );
    expect(setConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      pluginCodeSelection: { mode: "all", pluginIds: [] },
      pluginDataSelection: expect.objectContaining({
        ignoredPluginIds: ["quickadd"],
      }),
    }));
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
    expect(commitSyncPathSettingsChange).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.objectContaining({
        retireLocalFolderMoveHintRemoteIds: ["plugin-folder-id"],
      }),
    );
  });

  it("retires completed plugin-data restore authority atomically and preserves it on write failure", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncCommunityPlugins = false;
    plugin.syncPluginData = true;
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: { mode: "none", pluginIds: [] },
      data: {
        mode: "all",
        pluginIds: [],
        restoringPluginIds: ["calendar"],
      },
    };
    let failWrite = true;
    let savedData: Record<string, unknown> = {};
    const commitSyncPathSettingsChange = vi.fn(async (
      _isPathInScope: (path: string) => boolean,
      persistSettings: (data: Record<string, unknown>) => void,
    ) => {
      if (failWrite) throw new Error("disk full");
      persistSettings(savedData);
    });
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.state = {
      hasMutationLedgerCorruption: false,
      mutationLedger: [],
      clearRemoteState: vi.fn().mockResolvedValue(undefined),
      commitSyncPathSettingsChange,
    } as never;
    plugin.syncExecutor = {
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(
      () => undefined,
    );
    const retire = () => (plugin as unknown as {
      persistCompletedCommunityPluginRestores(
        completed: { files: string[]; data: string[] },
      ): Promise<void>;
    }).persistCompletedCommunityPluginRestores({
      files: [],
      data: ["calendar"],
    });

    await expect(retire()).rejects.toThrow("disk full");
    expect(plugin.communityPluginSyncPolicy.data).toEqual({
      mode: "all",
      pluginIds: [],
      restoringPluginIds: ["calendar"],
    });

    failWrite = false;
    await expect(retire()).resolves.toBeUndefined();
    expect(plugin.communityPluginSyncPolicy.data).toEqual({
      mode: "all",
      pluginIds: [],
    });
    expect(savedData["community-plugin-sync-policy"]).toEqual(
      plugin.communityPluginSyncPolicy,
    );
    expect(commitSyncPathSettingsChange).toHaveBeenCalledTimes(2);
  });

  it("does not expose remote-only plugins from a complete legacy folder index without a catalog", async () => {
    const plugin = new EasySyncPlugin();
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
      read: vi.fn().mockRejectedValue(new Error("missing")),
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          adapter,
          configDir: ".obsidian",
        },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.state = {
      remoteScope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "files",
      },
      hasCompleteRemoteFolderIndex: true,
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope: null,
        anchors: {},
        pending: [],
      }),
      remoteFolders: [{
        path: ".obsidian/plugins/remote-only",
        driveId: "remote-only-id",
        parentId: "plugins-id",
        name: "remote-only",
      }],
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([]);
    await expect(
      plugin.hasTrustedCommunityPluginRemoteInventory(),
    ).resolves.toBe(false);
    await expect(
      plugin.hasTrustedCommunityPluginRemoteInventory("data"),
    ).resolves.toBe(true);
  });

  it("uses exact source-bound manifest evidence for a trusted remote-only plugin name", async () => {
    const plugin = new EasySyncPlugin();
    const scope = {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "files",
    };
    const manifestText = JSON.stringify({
      id: "calendar",
      name: "Calendar",
      version: "2.0.0",
      minAppVersion: "1.5.0",
    });
    const manifestBytes = new TextEncoder().encode(manifestText).buffer;
    const remoteManifest = {
      path: ".obsidian/plugins/calendar/manifest.json",
      driveId: "calendar-manifest-id",
      parentId: "calendar-folder-id",
      size: manifestBytes.byteLength,
      mtime: 1,
      eTag: "etag:calendar-manifest",
      cTag: "ctag:calendar-manifest",
      sha256Hash: await sha256Hex(manifestBytes),
    };
    const observation = await createCommunityPluginManifestObservation(
      scope,
      "calendar",
      remoteManifest,
      manifestBytes,
    );
    const catalog = await buildRemoteCommunityPluginCatalog({
      scope,
      configDir: ".obsidian",
      items: [
        {
          id: "config-folder-id",
          name: ".obsidian",
          folder: {},
          parentReference: { id: scope.filesRootId },
        },
        {
          id: "plugins-folder-id",
          name: "plugins",
          folder: {},
          parentReference: { id: "config-folder-id" },
        },
        {
          id: "calendar-folder-id",
          name: "calendar",
          folder: {},
          parentReference: { id: "plugins-folder-id" },
        },
        {
          id: "calendar-main-id",
          name: "main.js",
          size: 4,
          file: { hashes: {} },
          parentReference: { id: "calendar-folder-id" },
          eTag: "etag:calendar-main",
          cTag: "ctag:calendar-main",
        },
        {
          id: remoteManifest.driveId,
          name: "manifest.json",
          size: remoteManifest.size,
          file: { hashes: { sha256Hash: remoteManifest.sha256Hash } },
          parentReference: { id: remoteManifest.parentId },
          eTag: remoteManifest.eTag,
          cTag: remoteManifest.cTag,
        },
      ],
      manifestObservations: [observation],
      observedAt: 1,
      previous: null,
    });
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
      read: vi.fn().mockRejectedValue(new Error("missing")),
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          adapter,
          configDir: ".obsidian",
        },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.state = {
      remoteScope: scope,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: true,
      remoteFolders: [{
        path: ".obsidian/plugins/calendar",
        driveId: "calendar-folder-id",
        parentId: "plugins-folder-id",
        name: "calendar",
      }],
      remoteSnapshot: [remoteManifest],
      baseSnapshot: [],
      getRemoteCommunityPluginCatalog: vi.fn().mockReturnValue(catalog),
      getCommunityPluginEnablementState: vi.fn().mockReturnValue({
        version: 1,
        scope,
        anchors: {},
        pending: [],
      }),
      getCommunityPluginManifestObservations: vi.fn()
        .mockReturnValue([observation]),
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([
      expect.objectContaining({
        id: "calendar",
        name: "Calendar",
        local: false,
        remote: true,
      }),
    ]);
  });

  it("keeps a persisted restore-only plugin visible when both bundles are temporarily absent", async () => {
    const plugin = new EasySyncPlugin();
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
      read: vi.fn().mockRejectedValue(new Error("missing")),
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          adapter,
          configDir: ".obsidian",
        },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: { mode: "selected", pluginIds: ["calendar"] },
      data: { mode: "none", pluginIds: [] },
    };
    Object.assign(plugin as object, {
      communityPluginParticipation: {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          calendar: {
            pluginId: "calendar",
            phase: "restoring",
            operationId: "join-calendar",
            targetCatalogRevision: 1,
            targetBundleDigest: "a".repeat(64),
          },
        },
      },
    });
    plugin.state = {
      remoteScope: null,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: false,
      remoteFolders: [],
      remoteSnapshot: [],
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([
      expect.objectContaining({
        id: "calendar",
        local: false,
        remote: false,
      }),
    ]);
  });

  it("keeps a historical plugin visible while the current remote inventory is untrusted", async () => {
    const plugin = new EasySyncPlugin();
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
      read: vi.fn().mockRejectedValue(new Error("missing")),
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: {
        vault: {
          adapter,
          configDir: ".obsidian",
        },
      },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: { mode: "selected", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    };
    Object.assign(plugin as object, {
      communityPluginParticipation: {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "excluded" },
        },
      },
    });
    plugin.state = {
      remoteScope: null,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: false,
      remoteFolders: [],
      remoteSnapshot: [],
      baseSnapshot: [{
        path: ".obsidian/plugins/calendar/manifest.json",
        size: 2,
        hash: "a".repeat(64),
        eTag: "etag:calendar",
      }, {
        path: ".obsidian/plugins/calendar/data.json",
        size: 2,
        hash: "b".repeat(64),
        eTag: "etag:calendar-data",
      }],
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([
      expect.objectContaining({
        id: "calendar",
        local: false,
        remote: true,
        dataHistoricallyPresent: true,
      }),
    ]);
  });

  it("does not present historical data-only evidence as remote plugin code", async () => {
    const plugin = new EasySyncPlugin();
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
      read: vi.fn().mockRejectedValue(new Error("missing")),
    };
    Object.defineProperty(plugin, "app", {
      configurable: true,
      value: { vault: { adapter, configDir: ".obsidian" } },
    });
    Object.defineProperty(plugin, "manifest", {
      configurable: true,
      value: { id: "easy-sync" },
    });
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: { mode: "none", pluginIds: [] },
    };
    plugin.state = {
      remoteScope: null,
      activeV2MigrationHold: null,
      hasCompleteRemoteFolderIndex: false,
      remoteSnapshot: [],
      baseSnapshot: [{
        path: ".obsidian/plugins/calendar/data.json",
        size: 2,
        hash: "b".repeat(64),
        eTag: "etag:calendar-data",
      }],
    } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);

    await expect(plugin.getCommunityPluginInventory()).resolves.toEqual([
      expect.objectContaining({
        id: "calendar",
        local: false,
        remote: false,
        dataHistoricallyPresent: true,
      }),
    ]);
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
      activeV2MigrationHold: null,
      isV2StateActive: true,
      hasCompleteRemoteFolderIndex: false,
      remoteFolders: [],
      syncPathSettingsFingerprint: "before",
      commitSyncPathSettingsChange: vi.fn().mockRejectedValue(
        new SyncPathMutationRecoveryError(),
      ),
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
