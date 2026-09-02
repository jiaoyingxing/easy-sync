import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TFolder } from "obsidian";

const confirmModalAwaitConfirm = vi.hoisted(() => vi.fn());

vi.mock("../src/auth/auth-module", () => ({
  AuthModule: class {},
}));

vi.mock("../src/onedrive/client", () => ({
  OneDriveClient: class {},
}));

vi.mock("../src/sync/local-scanner", () => ({
  LocalScanner: class {},
  createFolderSyncScopeSnapshotV1: () => ({
    version: 1,
    includedPaths: [],
    excludedFolders: [],
  }),
  isEasySyncInternalPath: (path: string) => path.includes("/.obsidian/plugins/easy-sync/tmp/")
    || path.startsWith(".obsidian/plugins/easy-sync/tmp/"),
  normalizeExcludedFolders: (paths: unknown[]) => paths.filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  ),
}));

vi.mock("../src/sync/state-manager", () => ({
  StateManager: class {},
  SyncPathMutationRecoveryError: class extends Error {},
  ConservativeResetBlockedError: class extends Error {},
}));

vi.mock("../src/sync/diagnostic-logger", () => ({
  DiagnosticLogger: class {
    log = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    setAdapter = vi.fn();
  },
}));

vi.mock("../src/ui/settings-tab", () => ({
  EasySyncSettingTab: class {},
}));

vi.mock("../src/ui/sync-view", () => ({
  SYNC_VIEW_TYPE: "easy-sync-detail",
  shouldAutoRebuildPlanReview: (
    counts: {
      uploads: number;
      downloads: number;
      folders?: number;
      deletes: number;
      conflicts: number;
      skipped: number;
    } | null,
    items: unknown[],
  ) => Boolean(
    counts
    && items.length === 0
    && counts.uploads + counts.downloads + (counts.folders ?? 0)
      + counts.deletes + counts.conflicts + counts.skipped > 0
  ),
  EasySyncSyncView: class {
    render = vi.fn();
  },
}));

vi.mock("../src/ui/ribbon-status", () => ({
  RIBBON_STATUS_ICONS: {},
  resolveRibbonStatus: () => ({
    icon: "cloud",
    label: "idle",
    ariaLabel: "idle",
    tooltip: "idle",
    cssClass: "",
    needsAttention: false,
  }),
}));

vi.mock("../src/ui/confirm-modal", () => ({
  ConfirmModal: class {
    awaitConfirm = confirmModalAwaitConfirm;
  },
  SyncPlanAlertModal: class {},
}));

import EasySyncPlugin from "../src/main";
import { I18n } from "../src/i18n";
import type { SyncCallbacks, SyncResult } from "../src/sync/sync-executor";
import {
  ConservativeResetBlockedError,
  type SyncHistoryEntry,
} from "../src/sync/state-manager";
import { SyncActionType, type SyncPlan } from "../src/sync/types";
import { MutationRecoveryScheduler } from "../src/sync/mutation-recovery-scheduler";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationV1,
} from "../src/sync/community-plugin-participation";
import { NOTICE_PRIORITY } from "../src/ui/notice-center";

function okResult(): SyncResult {
  return {
    success: true,
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    deferred: 0,
    skippedLarge: 0,
    skippedIgnored: 0,
    errors: 0,
    authExpired: false,
    message: "ok",
  };
}

function makePlugin(): EasySyncPlugin {
  const plugin = new EasySyncPlugin();
  plugin.app.vault.adapter.exists = vi.fn().mockResolvedValue(false);
  vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
  vi.spyOn(plugin as never, "handleSyncResult").mockResolvedValue(undefined);
  plugin.diag = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
  plugin.scanner = {
    shouldSyncPath: vi.fn((path: string) => !path.startsWith(".obsidian/plugins/easy-sync/tmp/")),
    shouldSyncFolderPath: vi.fn((path: string) => !path.startsWith(".obsidian/plugins/easy-sync/tmp/")),
  } as never;
  return plugin;
}

function attachResetRecoveryHarness(plugin: EasySyncPlugin) {
  const invalidateLifecycle = vi.fn();
  const reset = vi.fn().mockResolvedValue(undefined);
  const resetPreservingIsolatedMutationRecovery = vi.fn()
    .mockResolvedValue(undefined);
  const forceReset = vi.fn().mockResolvedValue({
    at: 1,
    ledgerCount: 1,
    quarantineCount: 0,
    corrupt: false,
  });
  const clearScanCache = vi.fn().mockResolvedValue(undefined);
  const addSyncHistory = vi.fn().mockResolvedValue(undefined);
  const state = {
    isV2StateActive: true,
    boundAccountId: "account",
    mutationLedger: [{
      intent: { operationId: "pending", path: "notes/a.md" },
      receipt: null,
    }],
    mutationRecoveryQuarantine: [],
    hasMutationLedgerCorruption: false,
    hasMutationRecoveryQuarantineCorruption: false,
    hasV2StateLoadRecoveryBlock: false,
    hasV2RemoteScopeRecovery: false,
    planReviewActive: false,
    addSyncHistory,
    reset,
    resetPreservingIsolatedMutationRecovery,
    forceReset,
  };
  plugin.syncExecutor = {
    isRunning: false,
    hasActivityInFlight: false,
    invalidateLifecycle,
  } as never;
  plugin.auth = {
    authState: { isLoggedIn: true, accountId: "account" },
  } as never;
  plugin.state = state as never;
  plugin.scanner = { clearScanCache } as never;
  const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
    .mockResolvedValue(undefined);
  vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
  return {
    state,
    invalidateLifecycle,
    reset,
    resetPreservingIsolatedMutationRecovery,
    forceReset,
    clearScanCache,
    addSyncHistory,
    saveSyncSettings,
  };
}

function attachParticipationState(
  plugin: EasySyncPlugin,
  initial: DeviceCommunityPluginParticipationV1,
) {
  let participation = structuredClone(initial);
  const updateCommunityPluginParticipation = vi.fn(async (command) => {
    participation = reduceDeviceCommunityPluginParticipation(
      participation,
      command,
    );
    return true;
  });
  const state = {
    isV2StateActive: true,
    hasV2StateLoadRecoveryBlock: false,
    hasV2RemoteScopeRecovery: false,
    hasMutationLedgerCorruption: false,
    hasMutationRecoveryQuarantineCorruption: false,
    mutationLedger: [],
    activeV2MigrationHold: null,
    hasCompleteRemoteFolderIndex: false,
    remoteFolders: [],
    getCommunityPluginParticipation: vi.fn(() =>
      structuredClone(participation)
    ),
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
  };
  plugin.state = state as never;
  plugin.scanner = {
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    setConfig: vi.fn(),
  } as never;
  plugin.syncExecutor = {
    hasActivityInFlight: false,
    setCommunityPluginSyncPolicy: vi.fn(),
  } as never;
  vi.spyOn(plugin as never, "updateStatusBar")
    .mockImplementation(() => undefined);
  (plugin as never as {
    applyCommunityPluginParticipationProjection: (
      value: DeviceCommunityPluginParticipationV1,
    ) => void;
  }).applyCommunityPluginParticipationProjection(participation);
  return {
    state,
    current: () => structuredClone(participation),
  };
}

function participating(pluginId = "calendar") {
  return reduceDeviceCommunityPluginParticipation(
    createEmptyDeviceCommunityPluginParticipation(true),
    {
      type: "confirm-participating",
      pluginId,
      localBundleDigest: "a".repeat(64),
    },
  );
}

const COMMUNITY_PLUGIN_SCOPE = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};

function changedRemotePluginJoin() {
  const requested = reduceDeviceCommunityPluginParticipation(
    createEmptyDeviceCommunityPluginParticipation(true),
    {
      type: "request-join",
      pluginId: "calendar",
      operationId: "join-calendar-1",
      targetCatalogRevision: 7,
      targetBundleDigest: "a".repeat(64),
    },
  );
  return reduceDeviceCommunityPluginParticipation(requested, {
    type: "block",
    pluginId: "calendar",
    reason: "remote-bundle-changed",
  });
}

function remoteCalendarCatalog(revision = 8, digest = "b".repeat(64)) {
  return {
    version: 1 as const,
    scope: COMMUNITY_PLUGIN_SCOPE,
    complete: true,
    stale: false,
    revision,
    observedAt: 2,
    sourceDigest: "c".repeat(64),
    entries: [{
      pluginId: "calendar",
      bundleState: "complete" as const,
      bundleDigest: digest,
      members: ["main.js", "manifest.json", "styles.css"].map(
        (fileName, index) => ({
          path: `.obsidian/plugins/calendar/${fileName}`,
          remoteId: `remote-${index}`,
          parentId: "calendar-folder",
          size: index + 1,
          mtime: 2,
          eTag: `etag-${index}`,
          cTag: `ctag-${index}`,
          sha256Hash: null,
          quickXorHash: null,
        }),
      ),
    }],
  };
}

describe("main sync entry guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    confirmModalAwaitConfirm.mockReset();
    confirmModalAwaitConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one executor run call site with explicit mode callback contracts", async () => {
    const source = readFileSync("src/main.ts", "utf8");
    expect(source.match(/syncExecutor\.run\(/g) ?? []).toHaveLength(1);

    const plugin = makePlugin();
    const createCallbacks = (plugin as never as {
      createSyncCallbacks: (mode: "first" | "manual" | "auto") => SyncCallbacks;
    }).createSyncCallbacks.bind(plugin);
    const firstCallbacks = createCallbacks("first");
    const manualCallbacks = createCallbacks("manual");
    const autoCallbacks = createCallbacks("auto");
    const plan: SyncPlan = { items: [], lastTotalFiles: 0, confirmed: false };

    expect(firstCallbacks.onFirstSyncPreview).toBeTypeOf("function");
    expect(manualCallbacks.onFirstSyncPreview).toBeUndefined();
    expect(autoCallbacks.onFirstSyncPreview).toBeUndefined();
    await expect(autoCallbacks.onConfirmThreshold?.(plan)).resolves.toBe(false);
  });

  it("keeps the last trusted catalog on one refresh failure and downgrades on consecutive failures", async () => {
    const plugin = makePlugin();
    const setRemote = vi.fn().mockResolvedValue(undefined);
    const state = {
      isV2StateActive: true,
      remoteScope: COMMUNITY_PLUGIN_SCOPE,
      getCommunityPluginManifestObservations: vi.fn(() => []),
      getRemoteCommunityPluginCatalog: vi.fn(() => remoteCalendarCatalog()),
      setRemoteCommunityPluginCatalog: setRemote,
    };
    plugin.state = state as never;
    const delta = vi.fn()
      .mockRejectedValueOnce(new Error("delta timed out"))
      .mockRejectedValueOnce(new Error("delta timed out"))
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "fresh",
      });
    plugin.onedrive = { getDeltaByFolderId: delta } as never;
    const refresh = (plugin as never as {
      refreshCommunityPluginRemoteCatalog(): Promise<unknown>;
    }).refreshCommunityPluginRemoteCatalog.bind(plugin);

    // First failure: the previously trusted catalog stays trusted.
    await expect(refresh()).rejects.toThrow("delta timed out");
    expect(setRemote).not.toHaveBeenCalled();

    // Second consecutive failure: downgrade to stale.
    await expect(refresh()).rejects.toThrow("delta timed out");
    expect(setRemote).toHaveBeenCalledTimes(1);
    expect(setRemote.mock.calls[0]?.[0]).toMatchObject({ stale: true });

    // A success resets the counter; the next single failure keeps trust.
    await expect(refresh()).resolves.toMatchObject({ stale: false });
    const afterSuccess = vi.fn().mockRejectedValueOnce(
      new Error("delta timed out"),
    );
    plugin.onedrive = { getDeltaByFolderId: afterSuccess } as never;
    await expect(refresh()).rejects.toThrow("delta timed out");
    // Two writes total: the stale downgrade and the successful refresh. The
    // single failure after success must not write again.
    expect(setRemote).toHaveBeenCalledTimes(2);
  });

  it("delegates non-busy settings changes with pending file recovery to the state transaction", async () => {
    const plugin = makePlugin();
    const commitSyncPathSettingsChange = vi.fn().mockResolvedValue(undefined);
    plugin.state = {
      activeV2MigrationHold: null,
      isV2StateActive: true,
      hasCompleteRemoteFolderIndex: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      mutationLedger: [{
        intent: {
          version: 1,
          operationId: "pending-note-upload",
          planRevision: 1,
          scope: COMMUNITY_PLUGIN_SCOPE,
          action: "upload",
          path: "Notes/pending.md",
          expectedLocal: { exists: true, hash: "a".repeat(64), size: 1 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      }],
      remoteFolders: [],
      syncPathSettingsFingerprint: "before",
      commitSyncPathSettingsChange,
    } as never;
    plugin.scanner = {
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      setConfig: vi.fn(),
    } as never;
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);

    await plugin.updateSyncPathSettings({
      syncBookmarks: !plugin.syncBookmarks,
    });

    expect(commitSyncPathSettingsChange).toHaveBeenCalledOnce();
  });

  it("rechecks a changed remote plugin without requiring the user to toggle its switch", async () => {
    const plugin = makePlugin();
    const attached = attachParticipationState(plugin, changedRemotePluginJoin());
    const currentCatalog = remoteCalendarCatalog();
    Object.assign(attached.state, {
      remoteScope: COMMUNITY_PLUGIN_SCOPE,
      getRemoteCommunityPluginCatalog: vi.fn(() =>
        remoteCalendarCatalog(7, "a".repeat(64))
      ),
    });
    const refreshCatalog = vi.spyOn(
      plugin,
      "refreshCommunityPluginRemoteCatalog",
    ).mockResolvedValue(currentCatalog);

    expect((plugin as never as {
      hasPendingCommunityPluginJoin(): boolean;
    }).hasPendingCommunityPluginJoin()).toBe(true);

    await expect((plugin as never as {
      prepareCommunityPluginJoinsForSync(): Promise<{
        authorizations: Array<{
          pluginId: string;
          operationId: string;
          targetCatalogRevision: number;
          targetBundleDigest: string;
        }>;
      }>;
    }).prepareCommunityPluginJoinsForSync()).resolves.toMatchObject({
      authorizations: [{
        pluginId: "calendar",
        operationId: "join-calendar-1",
        targetCatalogRevision: 8,
        targetBundleDigest: "b".repeat(64),
      }],
    });
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(attached.current().pluginsById.calendar).toMatchObject({
      phase: "restoring",
      operationId: "join-calendar-1",
      targetCatalogRevision: 8,
      targetBundleDigest: "b".repeat(64),
    });
    expect(plugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: ["calendar"],
    });
  });

  it("returns a selected local plugin with a stale target to ordinary planning", async () => {
    const plugin = makePlugin();
    const attached = attachParticipationState(plugin, changedRemotePluginJoin());
    plugin.app.vault.adapter.exists = vi.fn(async (path: string) =>
      path.endsWith("/main.js") || path.endsWith("/manifest.json")
    );
    const refreshCatalog = vi.spyOn(
      plugin,
      "refreshCommunityPluginRemoteCatalog",
    );

    await expect((plugin as never as {
      prepareCommunityPluginJoinsForSync(): Promise<{
        authorizations: unknown[];
      }>;
    }).prepareCommunityPluginJoinsForSync()).resolves.toEqual({
      authorizations: [],
    });

    expect(refreshCatalog).not.toHaveBeenCalled();
    expect(attached.current().pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "participating",
    });
    expect(plugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: ["calendar"],
    });
  });

  it("keeps a partial local plugin selected and binds its complete cloud bundle for review", async () => {
    const plugin = makePlugin();
    const requested = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      {
        type: "request-join",
        pluginId: "calendar",
        operationId: "join-calendar-partial",
      },
    );
    const attached = attachParticipationState(plugin, requested);
    Object.assign(attached.state, {
      remoteScope: COMMUNITY_PLUGIN_SCOPE,
      getRemoteCommunityPluginCatalog: vi.fn(() => null),
    });
    plugin.app.vault.adapter.exists = vi.fn(async (path: string) =>
      path.endsWith("/main.js")
    );
    const refreshCatalog = vi.spyOn(
      plugin,
      "refreshCommunityPluginRemoteCatalog",
    ).mockResolvedValue(remoteCalendarCatalog());

    await expect((plugin as never as {
      prepareCommunityPluginJoinsForSync(): Promise<{
        authorizations: Array<{
          pluginId: string;
          operationId: string;
          targetCatalogRevision: number;
          targetBundleDigest: string;
        }>;
      }>;
    }).prepareCommunityPluginJoinsForSync()).resolves.toMatchObject({
      authorizations: [{
        pluginId: "calendar",
        operationId: "join-calendar-partial",
        targetCatalogRevision: 8,
        targetBundleDigest: "b".repeat(64),
      }],
    });
    expect(refreshCatalog).toHaveBeenCalledOnce();
    expect(attached.current().pluginsById.calendar).toMatchObject({
      phase: "restoring",
      operationId: "join-calendar-partial",
      targetCatalogRevision: 8,
      targetBundleDigest: "b".repeat(64),
    });
    expect(plugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: ["calendar"],
    });
  });

  it("does not start a lifecycle observation after an ordinary sync", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    const observe = vi.fn();
    (plugin as never as {
      communityPluginLifecycleDeviceObserver: { observe: typeof observe };
    }).communityPluginLifecycleDeviceObserver = { observe };
    const result = okResult();
    plugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockResolvedValue(result),
    } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(observe).not.toHaveBeenCalled();
  });

  it("refines the executor compatibility count into an action-accurate remote deletion result", async () => {
    const plugin = makePlugin();
    plugin.i18n = new I18n("zh-cn");
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    const run = vi.fn().mockImplementation(async (
      _mode: string,
      callbacks: SyncCallbacks,
    ) => {
      callbacks.onFileComplete?.(
        "deleted-remotely.md",
        SyncActionType.ConfirmLocalDelete,
        true,
      );
      return {
        ...okResult(),
        conflicts: 1,
        message: "本轮有 1 项冲突待处理",
      };
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    const result = await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(result?.conflicts).toBe(1);
    expect(result?.message).toBe("本轮有 1 项云端删除待确认");
  });

  it("keeps the old path for move-result presentation and does not mark safe deferrals as failures", () => {
    const plugin = makePlugin();
    const executorSource = readFileSync("src/sync/sync-executor.ts", "utf8");
    const handleFileComplete = (plugin as never as {
      handleFileComplete: (
        path: string,
        actionType: SyncActionType,
        success: boolean,
        reason?: string,
        fileSize?: number,
        sourcePath?: string,
      ) => void;
    }).handleFileComplete.bind(plugin);

    handleFileComplete(
      "Projects/New.md",
      SyncActionType.RenameRemote,
      true,
      undefined,
      12,
      "Projects/Old.md",
    );
    handleFileComplete(
      "Deferred.md",
      SyncActionType.RetryLater,
      false,
      "changed again",
    );

    expect(plugin.progressStore.state.completedFiles).toEqual([
      expect.objectContaining({
        path: "Projects/New.md",
        sourcePath: "Projects/Old.md",
        status: "upload",
        actionType: SyncActionType.RenameRemote,
      }),
      expect.objectContaining({
        path: "Deferred.md",
        status: "skip",
        actionType: SyncActionType.RetryLater,
      }),
    ]);
    expect(executorSource).toContain("completionFileSize,\n            item.renameFrom,");
    expect(executorSource).toContain("fileSize,\n              item.renameFrom,");
  });

  it("debounces local dirty events into the shared automatic sync entry", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(4_000);
    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/b.md");
    await vi.advanceTimersByTimeAsync(6_999);
    expect(runAutomaticSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("dirty");
    expect(plugin.diag.log).toHaveBeenCalledTimes(1);
    expect(plugin.diag.log).toHaveBeenCalledWith(
      "execute",
      "local dirty hint scheduled normal auto sync",
      expect.objectContaining({ debounceMs: 7_000 }),
    );
    plugin.stopAutoSync();
  });

  it("uses the configured local-change delay for dirty-triggered sync", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.setAutoSyncChangeDelaySeconds(2);
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(runAutomaticSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(plugin.diag.log).toHaveBeenCalledWith(
      "execute",
      "local dirty hint scheduled normal auto sync",
      expect.objectContaining({ debounceMs: 2_000 }),
    );
    plugin.stopAutoSync();
  });

  it("does not schedule local-change sync when its delay is set to zero", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.setAutoSyncChangeDelaySeconds(0);
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAutomaticSync).not.toHaveBeenCalled();
    expect(plugin.diag.log).not.toHaveBeenCalledWith(
      "execute",
      "local dirty hint scheduled normal auto sync",
      expect.anything(),
    );
  });

  it("cancels an already pending local-change sync when set to zero", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(1_000);
    plugin.setAutoSyncChangeDelaySeconds(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAutomaticSync).not.toHaveBeenCalled();
  });

  it("does not schedule a dirty run for EasySync internal state", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint(".obsidian/plugins/easy-sync/tmp/downloads/a.part");
    await vi.advanceTimersByTimeAsync(7_000);

    expect(runAutomaticSync).not.toHaveBeenCalled();
  });

  it("does not schedule a dirty run for a path outside the configured sync scope", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.scanner = {
      shouldSyncPath: vi.fn().mockReturnValue(false),
    } as never;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint(".obsidian/plugins/other/data.json");
    await vi.advanceTimersByTimeAsync(7_000);

    expect(runAutomaticSync).not.toHaveBeenCalled();
  });

  it("schedules a rename when either the old or new path is in sync scope", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    const shouldSyncPath = vi.fn((path: string) => path === "notes/old.md");
    plugin.scanner = { shouldSyncPath } as never;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string, oldPath?: string) => void })
      .markLocalDirtyHint("excluded/old.md", "notes/old.md");
    await vi.advanceTimersByTimeAsync(7_000);

    expect(shouldSyncPath).toHaveBeenCalledWith("excluded/old.md");
    expect(shouldSyncPath).toHaveBeenCalledWith("notes/old.md");
    expect(runAutomaticSync).toHaveBeenCalledOnce();
  });

  it("uses folder scope for a TFolder change without also evaluating it as a file", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    const shouldSyncPath = vi.fn().mockReturnValue(false);
    const shouldSyncFolderPath = vi.fn().mockReturnValue(true);
    plugin.scanner = { shouldSyncPath, shouldSyncFolderPath } as never;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as {
      handleLocalVaultChange: (file: TFolder) => void;
    }).handleLocalVaultChange(
      new TFolder(".obsidian/plugins/calendar"),
    );
    await vi.advanceTimersByTimeAsync(7_000);

    expect(shouldSyncFolderPath).toHaveBeenCalledOnce();
    expect(shouldSyncFolderPath).toHaveBeenCalledWith(
      ".obsidian/plugins/calendar",
    );
    expect(shouldSyncPath).not.toHaveBeenCalled();
    expect(runAutomaticSync).toHaveBeenCalledOnce();
    plugin.stopAutoSync();
  });

  it("persists a two-observation local exit through the V2 participation owner", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    const deleteItem = vi.fn();
    plugin.onedrive = { deleteItem } as never;
    const participation = attachParticipationState(plugin, participating());

    await (plugin as never as {
      handleLocalVaultDelete: (file: TFolder) => Promise<void>;
    }).handleLocalVaultDelete(
      new TFolder(".obsidian/plugins/calendar"),
    );

    expect(participation.current().pluginsById.calendar).toMatchObject({
      phase: "exit-requested",
      lastConfirmedLocalBundleDigest: "a".repeat(64),
    });
    expect(plugin.isCommunityPluginFilesParticipationEnabled("calendar"))
      .toBe(false);

    await vi.advanceTimersByTimeAsync(150);
    await (plugin as never as {
      communityPluginLocalReconciliationQueue: Promise<void>;
    }).communityPluginLocalReconciliationQueue;

    expect(participation.current().pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "excluded",
    });
    expect(participation.state.updateCommunityPluginParticipation)
      .toHaveBeenCalledTimes(2);
    expect(participation.state.commitSyncPathSettingsChange)
      .toHaveBeenCalledOnce();
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("persists an ordinary restore completion without lifecycle generation", async () => {
    const plugin = makePlugin();
    let restoring = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      {
        type: "request-join",
        pluginId: "calendar",
        operationId: "join-calendar-generation",
        targetCatalogRevision: 7,
        targetBundleDigest: "b".repeat(64),
      },
    );
    restoring = reduceDeviceCommunityPluginParticipation(restoring, {
      type: "begin-restore",
      pluginId: "calendar",
    });
    const participation = attachParticipationState(plugin, restoring);

    await (plugin as never as {
      persistCommunityPluginJoinOutcomes: (
        completed: { files: string[]; data: string[] },
        blocks: unknown[],
      ) => Promise<void>;
    }).persistCommunityPluginJoinOutcomes(
      { files: ["calendar"], data: [] },
      [],
    );

    expect(participation.current().pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "participating",
      lastConfirmedLocalBundleDigest: "b".repeat(64),
    });
  });

  it("reuses only the exact restoring authorization for the current reviewed plan", async () => {
    const plugin = makePlugin();
    const scope = {
      accountId: "account-reviewed-restore",
      driveId: "drive-reviewed-restore",
      vaultFolderId: "vault-reviewed-restore",
      filesRootId: "root-reviewed-restore",
    };
    const canonicalIdentity = {
      version: 2 as const,
      scope,
      sourceCommitSeq: 11,
      digest: "c".repeat(64),
    };
    const reviewedAuthorization = {
      revision: 9,
      scope,
      canonicalIdentity,
    };
    let restoring = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      {
        type: "request-join",
        pluginId: "dataview",
        operationId: "join-dataview-reviewed-plan",
        targetCatalogRevision: 7,
        targetBundleDigest: "b".repeat(64),
      },
    );
    restoring = reduceDeviceCommunityPluginParticipation(restoring, {
      type: "begin-restore",
      pluginId: "dataview",
    });
    const participation = attachParticipationState(plugin, restoring);
    Object.assign(participation.state, {
      remoteScope: scope,
      planReviewActive: true,
      planReviewAuthorization: reviewedAuthorization,
      getRemoteCommunityPluginCatalog: vi.fn(() => ({
        version: 1,
        scope,
        complete: true,
        stale: false,
        revision: 7,
        observedAt: 1,
        sourceDigest: "d".repeat(64),
        entries: [{
          pluginId: "dataview",
          bundleState: "complete",
          bundleDigest: "b".repeat(64),
          members: ["main.js", "manifest.json", "styles.css"].map(
            (fileName, index) => ({
              path: `.obsidian/plugins/dataview/${fileName}`,
              remoteId: `remote-dataview-${index}`,
              parentId: "remote-dataview-parent",
              size: index + 1,
              mtime: 1,
              eTag: `etag-${index}`,
              cTag: `ctag-${index}`,
              sha256Hash: null,
              quickXorHash: null,
            }),
          ),
        }],
      })),
    });

    const prepare = (plugin as never as {
      prepareCommunityPluginJoinsForSync: (
        authorization?: typeof reviewedAuthorization,
      ) => Promise<{
        authorizations: Array<{
          pluginId: string;
          operationId: string;
          targetCatalogRevision: number;
          targetBundleDigest: string;
        }>;
      }>;
    }).prepareCommunityPluginJoinsForSync.bind(plugin);

    await expect(prepare(reviewedAuthorization)).resolves.toMatchObject({
      authorizations: [{
        pluginId: "dataview",
        operationId: "join-dataview-reviewed-plan",
        targetCatalogRevision: 7,
        targetBundleDigest: "b".repeat(64),
      }],
    });
    expect(participation.state.updateCommunityPluginParticipationBatch)
      .not.toHaveBeenCalled();

    await expect(prepare({
      ...reviewedAuthorization,
      revision: reviewedAuthorization.revision - 1,
    })).resolves.toEqual({ authorizations: [] });
    expect(participation.state.updateCommunityPluginParticipationBatch)
      .not.toHaveBeenCalled();
  });

  it("persists an ordinary participating entry without lifecycle generation", async () => {
    const plugin = makePlugin();
    const participation = attachParticipationState(
      plugin,
      reduceDeviceCommunityPluginParticipation(
        createEmptyDeviceCommunityPluginParticipation(true),
        { type: "confirm-participating", pluginId: "calendar" },
      ),
    );

    await (plugin as never as {
      persistCommunityPluginJoinOutcomes: (
        completed: { files: string[]; data: string[] },
        blocks: unknown[],
      ) => Promise<void>;
    }).persistCommunityPluginJoinOutcomes(
      { files: [], data: [] },
      [],
    );

    expect(participation.current().pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "participating",
    });
  });

  it("restores participation when a transient uninstall is followed by a managed file create", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    const existing = new Set<string>();
    plugin.app.vault.adapter.exists = vi.fn(async (path: string) =>
      existing.has(path)
    );
    const participation = attachParticipationState(plugin, participating());

    await (plugin as never as {
      handleLocalVaultDelete: (file: TFolder) => Promise<void>;
    }).handleLocalVaultDelete(
      new TFolder(".obsidian/plugins/calendar"),
    );
    expect(participation.current().pluginsById.calendar?.phase)
      .toBe("exit-requested");

    existing.add(".obsidian/plugins/calendar/manifest.json");
    (plugin as never as {
      handleLocalVaultChange: (
        file: { path: string },
        kind: "create",
      ) => void;
    }).handleLocalVaultChange(
      { path: ".obsidian/plugins/calendar/manifest.json" },
      "create",
    );
    await (plugin as never as {
      communityPluginLocalReconciliationQueue: Promise<void>;
    }).communityPluginLocalReconciliationQueue;

    expect(participation.current().pluginsById.calendar).toEqual({
      pluginId: "calendar",
      phase: "participating",
      lastConfirmedLocalBundleDigest: "a".repeat(64),
    });
    expect(participation.state.commitSyncPathSettingsChange)
      .toHaveBeenCalledTimes(2);
  });

  it("repairs a missed uninstall from the shared startup reconciliation entry", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    const participation = attachParticipationState(plugin, participating());

    await (plugin as never as {
      scheduleCommunityPluginLocalReconciliation: (
        trigger: string,
      ) => Promise<void>;
    }).scheduleCommunityPluginLocalReconciliation("state-loaded");
    expect(participation.current().pluginsById.calendar?.phase)
      .toBe("exit-requested");

    await vi.advanceTimersByTimeAsync(150);
    await (plugin as never as {
      communityPluginLocalReconciliationQueue: Promise<void>;
    }).communityPluginLocalReconciliationQueue;
    expect(participation.current().pluginsById.calendar?.phase)
      .toBe("excluded");
  });

  it("auto-participates complete local installs without reviving exclusions", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    const localFiles = new Set([
      ".obsidian/plugins/new-plugin/main.js",
      ".obsidian/plugins/new-plugin/manifest.json",
      ".obsidian/plugins/old-plugin/main.js",
      ".obsidian/plugins/old-plugin/manifest.json",
    ]);
    plugin.app.vault.adapter.exists = vi.fn(async (path: string) =>
      path === ".obsidian/plugins" || localFiles.has(path)
    );
    plugin.app.vault.adapter.list = vi.fn(async (path: string) =>
      path === ".obsidian/plugins"
        ? {
            files: [],
            folders: [
              ".obsidian/plugins/new-plugin",
              ".obsidian/plugins/old-plugin",
            ],
          }
        : { files: [], folders: [] }
    );
    const initial = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      { type: "confirm-excluded", pluginId: "old-plugin" },
    );
    const participation = attachParticipationState(plugin, initial);

    await (plugin as never as {
      scheduleCommunityPluginLocalReconciliation: (
        trigger: string,
      ) => Promise<void>;
    }).scheduleCommunityPluginLocalReconciliation("state-loaded");

    expect(participation.current().pluginsById["new-plugin"]).toEqual({
      pluginId: "new-plugin",
      phase: "participating",
    });
    expect(participation.current().pluginsById["old-plugin"]).toEqual({
      pluginId: "old-plugin",
      phase: "excluded",
    });
    expect(participation.state.commitSyncPathSettingsChange)
      .toHaveBeenCalledOnce();
  });

  it("uses local plugin file create events as an auto-participation hint", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    const localFiles = new Set([
      ".obsidian/plugins/new-plugin/main.js",
      ".obsidian/plugins/new-plugin/manifest.json",
    ]);
    plugin.app.vault.adapter.exists = vi.fn(async (path: string) =>
      localFiles.has(path)
    );
    const participation = attachParticipationState(
      plugin,
      createEmptyDeviceCommunityPluginParticipation(true),
    );

    (plugin as never as {
      handleLocalVaultChange: (
        file: { path: string },
        kind: "create",
      ) => void;
    }).handleLocalVaultChange(
      { path: ".obsidian/plugins/new-plugin/manifest.json" },
      "create",
    );
    await (plugin as never as {
      communityPluginLocalReconciliationQueue: Promise<void>;
    }).communityPluginLocalReconciliationQueue;

    expect(participation.current().pluginsById["new-plugin"]).toEqual({
      pluginId: "new-plugin",
      phase: "participating",
    });
  });

  it("does not infer participation before V2 activation", async () => {
    const plugin = makePlugin();
    plugin.state = { isV2StateActive: false } as never;
    const updateSyncPathSettings = vi.spyOn(plugin, "updateSyncPathSettings")
      .mockResolvedValue(undefined);

    await (plugin as never as {
      handleLocalVaultDelete: (file: TFolder) => Promise<void>;
    }).handleLocalVaultDelete(
      new TFolder(".obsidian/plugins/calendar"),
    );

    expect(updateSyncPathSettings).not.toHaveBeenCalled();
  });

  it("persists one TFolder move hint before scheduling one folder-scoped dirty run", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    const shouldSyncPath = vi.fn().mockReturnValue(false);
    const shouldSyncFolderPath = vi.fn((path: string) =>
      path === ".obsidian/plugins/calendar"
    );
    plugin.scanner = { shouldSyncPath, shouldSyncFolderPath } as never;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    let releaseMoveHint!: () => void;
    const captureLocalFolderMoveHint = vi.spyOn(
      plugin as never,
      "captureLocalFolderMoveHint",
    ).mockImplementation(() => new Promise<void>((resolve) => {
      releaseMoveHint = resolve;
    }));
    const markLocalDirtyFolderHint = vi.spyOn(
      plugin as never,
      "markLocalDirtyFolderHint",
    );

    const handled = (plugin as never as {
      handleLocalVaultRename: (
        file: TFolder,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename(
      new TFolder("archive/calendar"),
      ".obsidian/plugins/calendar",
    );

    expect(captureLocalFolderMoveHint).toHaveBeenCalledOnce();
    expect(markLocalDirtyFolderHint).not.toHaveBeenCalled();
    releaseMoveHint();
    await handled;

    expect(markLocalDirtyFolderHint).toHaveBeenCalledOnce();
    expect(markLocalDirtyFolderHint).toHaveBeenCalledWith(
      "archive/calendar",
      ".obsidian/plugins/calendar",
    );
    expect(shouldSyncFolderPath).toHaveBeenCalledTimes(2);
    expect(shouldSyncPath).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(runAutomaticSync).toHaveBeenCalledOnce();
    plugin.stopAutoSync();
  });

  it("immediately opts out a plugin root renamed outside its exact managed path", async () => {
    const plugin = makePlugin();
    const participation = attachParticipationState(plugin, participating());
    const captureLocalFolderMoveHint = vi.spyOn(
      plugin as never,
      "captureLocalFolderMoveHint",
    ).mockResolvedValue(undefined);

    await (plugin as never as {
      handleLocalVaultRename: (
        file: TFolder,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename(
      new TFolder("archive/calendar"),
      ".obsidian/plugins/calendar",
    );

    expect(captureLocalFolderMoveHint).toHaveBeenCalledWith(
      ".obsidian/plugins/calendar",
      "archive/calendar",
    );
    expect(captureLocalFolderMoveHint.mock.invocationCallOrder[0])
      .toBeLessThan(
        participation.state.updateCommunityPluginParticipation
          .mock.invocationCallOrder[0]!,
      );
    expect(participation.current().pluginsById.calendar?.phase)
      .toBe("exit-requested");
  });

  it("does not opt out a plugin that is moved back before the rename-out evidence commits", async () => {
    const plugin = makePlugin();
    plugin.state = { isV2StateActive: true } as never;
    plugin.app.vault.adapter.exists = vi.fn(async (path: string) =>
      path === ".obsidian/plugins/calendar"
      || path === ".obsidian/plugins/calendar/manifest.json"
    );
    let releaseFirstMove!: () => void;
    const firstMove = new Promise<void>((resolve) => {
      releaseFirstMove = resolve;
    });
    const captureLocalFolderMoveHint = vi.spyOn(
      plugin as never,
      "captureLocalFolderMoveHint",
    )
      .mockImplementationOnce(async () => firstMove)
      .mockResolvedValue(undefined);
    const updateSyncPathSettings = vi.spyOn(plugin, "updateSyncPathSettings")
      .mockResolvedValue(undefined);
    const handleRename = (plugin as never as {
      handleLocalVaultRename: (
        file: TFolder,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename.bind(plugin);

    const movedOut = handleRename(
      new TFolder("archive/calendar"),
      ".obsidian/plugins/calendar",
    );
    await vi.waitFor(() => expect(captureLocalFolderMoveHint).toHaveBeenCalled());
    await handleRename(
      new TFolder(".obsidian/plugins/calendar"),
      "archive/calendar",
    );
    releaseFirstMove();
    await movedOut;

    expect(updateSyncPathSettings).not.toHaveBeenCalled();
  });

  it("coalesces inventory events and ignores ordinary plugin file modifications", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    const revision = vi.fn();
    plugin.onCommunityPluginInventoryRevision(revision);
    const handleChange = (plugin as never as {
      handleLocalVaultChange: (
        file: { path: string },
        kind: "create" | "modify",
      ) => void;
    }).handleLocalVaultChange.bind(plugin);
    const handleDelete = (plugin as never as {
      handleLocalVaultDelete: (file: { path: string }) => Promise<void>;
    }).handleLocalVaultDelete.bind(plugin);

    handleChange({ path: ".obsidian/plugins/calendar/data.json" }, "modify");
    handleChange({ path: ".obsidian/plugins/calendar/main.js" }, "modify");
    handleChange({ path: ".obsidian/plugins/calendar/styles.css" }, "modify");
    await vi.advanceTimersByTimeAsync(200);
    expect(revision).not.toHaveBeenCalled();

    handleChange({ path: ".obsidian/plugins/calendar/manifest.json" }, "modify");
    handleChange(new TFolder(".obsidian/plugins/dataview"), "create");
    await handleDelete({ path: ".obsidian/plugins/calendar/data.json" });
    await vi.advanceTimersByTimeAsync(99);
    expect(revision).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revision).toHaveBeenCalledOnce();
  });

  it("does not let an uninstall event from an unloaded instance write settings", async () => {
    const plugin = makePlugin();
    let releaseStateLoad!: () => void;
    const stateLoad = new Promise<void>((resolve) => {
      releaseStateLoad = resolve;
    });
    const ensureStateLoaded = vi.spyOn(plugin as never, "ensureStateLoaded")
      .mockImplementation(async () => {
        await stateLoad;
      });
    plugin.state = {
      isV2StateActive: true,
      close: vi.fn().mockResolvedValue(undefined),
    } as never;
    plugin.noticeCenter = {
      dispose: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
    } as never;
    plugin.diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as never;
    const updateSyncPathSettings = vi.spyOn(plugin, "updateSyncPathSettings")
      .mockResolvedValue(undefined);

    const handled = (plugin as never as {
      handleLocalVaultDelete: (file: TFolder) => Promise<void>;
    }).handleLocalVaultDelete(
      new TFolder(".obsidian/plugins/calendar"),
    );
    await vi.waitFor(() => expect(ensureStateLoaded).toHaveBeenCalledOnce());
    plugin.onunload();
    releaseStateLoad();
    await handled;

    expect(updateSyncPathSettings).not.toHaveBeenCalled();
  });

  it("runs dirty and interval triggers through the same account/plan/activity gate", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = { planReviewActive: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    const dirtyConsumed = await (plugin as never as {
      runAutomaticSync: (trigger: "dirty") => Promise<boolean>;
    }).runAutomaticSync("dirty");
    const intervalConsumed = await (plugin as never as {
      runAutomaticSync: (trigger: "interval") => Promise<boolean>;
    }).runAutomaticSync("interval");

    expect(dirtyConsumed).toBe(true);
    expect(intervalConsumed).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.every((call) => call[0] === "auto")).toBe(true);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("routes automatic triggers with persisted V2 mutation intent to recovery instead of a normal plan", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{ intent: { operationId: "pending" }, receipt: null }],
      planReviewActive: false,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    const requestRecovery = vi.spyOn(
      plugin as never,
      "requestMutationRecoveryObservation",
    ).mockReturnValue(true);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    const consumed = await (plugin as never as {
      runAutomaticSync: (trigger: "interval") => Promise<boolean>;
    }).runAutomaticSync("interval");

    expect(consumed).toBe(true);
    expect(requestRecovery).toHaveBeenCalledWith("interval");
    expect(run).not.toHaveBeenCalled();
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("uses a persisted active V2 intent as a cold-start trigger without accepting public precommit or paused state", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin._stateLoaded = true;
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{ intent: { operationId: "persisted" }, receipt: null }],
      planReviewActive: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
    } as never;
    const runScheduled = vi.spyOn(
      plugin as never,
      "runScheduledMutationRecovery",
    ).mockResolvedValue({ state: "inactive" });

    const scheduled = (plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation("state-loaded");
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduled).toBe(true);
    expect(runScheduled).toHaveBeenCalledOnce();

    plugin.state.isV2StateActive = false;
    expect((plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation("public-precommit")).toBe(false);

    plugin.state.isV2StateActive = true;
    plugin.autoSyncPaused = true;
    expect((plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation("paused")).toBe(false);
    plugin.stopAutoSync();
  });

  it("wakes exhausted recovery only from foreground, auth, or periodic triggers", () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin._stateLoaded = true;
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{ intent: { operationId: "persisted" }, receipt: null }],
      planReviewActive: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
    } as never;
    const scheduler = (plugin as never as {
      mutationRecoveryScheduler: MutationRecoveryScheduler;
    }).mutationRecoveryScheduler;
    vi.spyOn(scheduler, "budgetExhausted", "get").mockReturnValue(true);
    const requestObservation = vi.spyOn(scheduler, "requestObservation")
      .mockReturnValue(false);
    const requestAfterExhaustion = vi.spyOn(
      scheduler,
      "requestObservationAfterExhaustion",
    ).mockReturnValue(true);
    const request = (trigger: string) => (plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation(trigger);

    expect(request("dirty")).toBe(false);
    expect(request("foreground")).toBe(true);
    expect(request("auth-state")).toBe(true);
    expect(request("interval")).toBe(true);
    expect(request("auto-start")).toBe(true);
    expect(requestObservation).toHaveBeenCalledOnce();
    expect(requestAfterExhaustion).toHaveBeenCalledTimes(4);
  });

  it("settles scheduled recovery in recovery-only mode before starting a separate canonical round", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.auth = {
      authState: {
        isLoggedIn: true,
        accountId: "account",
      },
    } as never;
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{ intent: { operationId: "pending" }, receipt: null }],
      planReviewActive: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    const run = vi.fn().mockImplementation(
      async (
        _mode: string,
        _callbacks: unknown,
        _skip: boolean,
        _authorization: unknown,
        options: { recoveryOnly?: boolean },
      ) => {
        expect(options).toEqual({ recoveryOnly: true });
        plugin.state!.mutationLedger.splice(0);
        return {
          ...okResult(),
          mutationRecovery: {
            state: "settled" as const,
            total: 1,
            settled: 1,
            remaining: 0,
            retryAfterSeconds: null,
          },
        };
      },
    );
    plugin.syncExecutor = { isRunning: false, run } as never;

    const outcome = await (plugin as never as {
      runScheduledMutationRecovery: () => Promise<{ state: string }>;
    }).runScheduledMutationRecovery();

    expect(outcome).toEqual({ state: "settled" });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("auto");
    expect(runAutomaticSync).toHaveBeenCalledWith("recovery-continuation");
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("continues ordinary automatic work after recovery isolates one file", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.auth = {
      authState: {
        isLoggedIn: true,
        accountId: "account",
      },
    } as never;
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{ intent: { operationId: "pending" }, receipt: null }],
      planReviewActive: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    const run = vi.fn().mockResolvedValue({
      ...okResult(),
      mutationRecovery: {
        state: "blocked" as const,
        total: 1,
        settled: 0,
        remaining: 1,
        retryAfterSeconds: null,
        blockReason: "facts-changed" as const,
        blockedOperationId: "pending",
        isolated: true,
      },
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    const outcome = await (plugin as never as {
      runScheduledMutationRecovery: () => Promise<{ state: string }>;
    }).runScheduledMutationRecovery();

    expect(outcome).toEqual({ state: "inactive" });
    expect(run).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("recovery-continuation");
    expect(plugin.autoSyncPaused).toBe(false);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("continues once with an ordinary V2 round after state-only legacy ledger recovery", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = { planReviewActive: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);
    const run = vi.fn()
      .mockResolvedValueOnce({
        ...okResult(),
        continueAfterStateOnlyMigrationRecovery: true,
      })
      .mockResolvedValueOnce(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    const consumed = await (plugin as never as {
      runAutomaticSync: (trigger: "dirty") => Promise<boolean>;
    }).runAutomaticSync("dirty");

    expect(consumed).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toBe("auto");
    expect(run.mock.calls[1]?.[0]).toBe("auto");
    expect(run.mock.calls[1]?.[2]).toBe(false);
    expect(run.mock.calls[1]?.[3]).toBeUndefined();
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("does not restart the visible sync for a successful subtree baseline continuation", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncPaused = true;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    const reconstruction = {
      version: 1,
      kind: "confirmed-descendant-file-reconstruction",
      roots: [{ path: ".obsidian/plugins", remoteId: "plugins", confirmedGeneration: 1 }],
    };
    plugin.state = {
      isV2StateActive: true,
      legacyAutoSyncAllowed: false,
      hasV2StateLoadRecoveryBlock: false,
      planReviewActive: false,
      confirmedDescendantFileReconstruction: reconstruction,
      mutationLedger: [],
    } as never;
    vi.spyOn(plugin as never, "checkAccountBindingForSync")
      .mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    const run = vi.fn().mockResolvedValue({
      ...okResult(),
      deferred: 1,
      continueAfterConfirmedDescendantFileReconstruction: true,
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();

    expect(run.mock.calls[0]?.[0]).toBe("manual");
    expect(plugin.autoSyncPaused).toBe(true);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("bounds automatic subtree reconstruction retries after repeated observation failures", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = {
      isV2StateActive: true,
      legacyAutoSyncAllowed: false,
      hasV2StateLoadRecoveryBlock: false,
      planReviewActive: false,
      confirmedDescendantFileReconstruction: {
        version: 1,
        kind: "confirmed-descendant-file-reconstruction",
        roots: [{
          path: ".obsidian/plugins",
          remoteId: "plugins",
          confirmedGeneration: 1,
        }],
      },
      mutationLedger: [],
    } as never;
    vi.spyOn(plugin as never, "checkAccountBindingForSync")
      .mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    const run = vi.fn().mockResolvedValue({
      ...okResult(),
      success: false,
      deferred: 1,
      errors: 1,
      continueAfterConfirmedDescendantFileReconstruction: true,
      descendantFileReconstructionRetryableFailure: true,
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });
    expect(run).toHaveBeenCalledTimes(1);

    for (const delay of [5_000, 15_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.waitFor(() =>
        expect(run).toHaveBeenCalledTimes(
          [5_000, 15_000, 30_000].indexOf(delay) + 2,
        ));
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(run).toHaveBeenCalledTimes(4);
    expect(
      (plugin as never as {
        descendantFileReconstructionTimer: unknown;
      }).descendantFileReconstructionTimer,
    ).toBeNull();
  });

  it("continues corrupt-state recovery with the same sealed review authorization", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    const authorization = {
      revision: 7,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "root",
      },
      canonicalIdentity: {
        version: 2 as const,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "root",
        },
        sourceCommitSeq: 4,
        digest: "sealed",
      },
    };
    const run = vi.fn()
      .mockResolvedValueOnce({
        ...okResult(),
        continueAfterV2CorruptStateRecovery: true,
      })
      .mockResolvedValueOnce(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
        skipConfirmation: boolean;
        reviewedAuthorization: typeof authorization;
        options: { recoverV2CorruptState: true };
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({
      mode: "manual",
      skipConfirmation: true,
      reviewedAuthorization: authorization,
      options: { recoverV2CorruptState: true },
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[2]).toBe(true);
    expect(run.mock.calls[0]?.[3]).toEqual(authorization);
    expect(run.mock.calls[1]?.[2]).toBe(true);
    expect(run.mock.calls[1]?.[3]).toEqual(authorization);
  });

  it("persists the migration auto-pause before a precommit executor snapshots public state", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    plugin.autoSyncPaused = false;
    plugin.state = {
      legacyAutoSyncAllowed: true,
      isV2StateActive: false,
    } as never;
    const order: string[] = [];
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync")
      .mockImplementation(() => undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockImplementation(async () => {
        order.push("save-settings");
        expect(plugin.autoSyncPaused).toBe(true);
      });
    const run = vi.fn().mockImplementation(async () => {
      order.push("executor-run");
      expect(plugin.autoSyncPaused).toBe(true);
      expect(saveSyncSettings).toHaveBeenCalledOnce();
      return {
        ...okResult(),
        success: false,
        message: "result.pausedForReview",
      };
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "first";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "first" });

    expect(order).toEqual(["save-settings", "executor-run"]);
    expect(stopAutoSync).toHaveBeenCalledOnce();
  });

  it("persists the current settings shape before precommit even when auto sync is already paused", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    plugin.autoSyncPaused = true;
    plugin.state = {
      legacyAutoSyncAllowed: true,
      isV2StateActive: false,
    } as never;
    const order: string[] = [];
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin, "saveSyncSettings").mockImplementation(async () => {
      order.push("save-settings");
    });
    const run = vi.fn().mockImplementation(async () => {
      order.push("executor-run");
      return {
        ...okResult(),
        success: false,
        message: "result.pausedForReview",
      };
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(order).toEqual(["save-settings", "executor-run"]);
    expect(stopAutoSync).not.toHaveBeenCalled();
  });

  it("keeps a public read-only preview free of migration setting writes", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    plugin.autoSyncPaused = false;
    plugin.state = {
      legacyAutoSyncAllowed: true,
      isV2StateActive: false,
    } as never;
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const run = vi.fn().mockImplementation(async () => {
      expect(plugin.autoSyncPaused).toBe(false);
      return okResult();
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
        options: { readOnlyPreview: true };
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({
      mode: "manual",
      options: { readOnlyPreview: true },
    });

    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it("persists inferred plugin opt-outs only after V2 authority is active", async () => {
    const result = {
      ...okResult(),
      communityPluginLocalIgnores: {
        files: ["calendar"],
        data: [],
      },
    };

    const previewPlugin = makePlugin();
    vi.spyOn(previewPlugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    previewPlugin.state = {
      legacyAutoSyncAllowed: true,
      isV2StateActive: false,
    } as never;
    const previewPersist = vi.spyOn(
      previewPlugin as never,
      "persistCommunityPluginLocalIgnores",
    ).mockResolvedValue(undefined);
    previewPlugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockResolvedValue(result),
    } as never;

    await (previewPlugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
        options: { readOnlyPreview: true };
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({
      mode: "manual",
      options: { readOnlyPreview: true },
    });

    expect(previewPersist).not.toHaveBeenCalled();

    const activePlugin = makePlugin();
    vi.spyOn(activePlugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    activePlugin.state = {
      legacyAutoSyncAllowed: false,
      isV2StateActive: true,
    } as never;
    const activePersist = vi.spyOn(
      activePlugin as never,
      "persistCommunityPluginLocalIgnores",
    ).mockResolvedValue(undefined);
    activePlugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockResolvedValue(result),
    } as never;

    await (activePlugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(activePersist).toHaveBeenCalledOnce();
    expect(activePersist).toHaveBeenCalledWith({
      files: ["calendar"],
      data: [],
    });
  });

  it("does not persist public migration settings after V2 is active", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    plugin.autoSyncPaused = false;
    plugin.state = {
      legacyAutoSyncAllowed: true,
      isV2StateActive: true,
    } as never;
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(plugin.autoSyncPaused).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("stops before a precommit executor when the migration pause cannot persist", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    plugin.autoSyncPaused = false;
    plugin.state = {
      legacyAutoSyncAllowed: true,
      isV2StateActive: false,
    } as never;
    vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin, "saveSyncSettings")
      .mockRejectedValue(new Error("PluginData write failed"));
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await expect((plugin as never as {
      dispatchSyncRun: (request: {
        mode: "first";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "first" }))
      .rejects.toThrow("PluginData write failed");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("retains a dirty hint when the shared operation gate is busy", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.syncExecutor = { isRunning: true, run: vi.fn() } as never;

    const consumed = await (plugin as never as {
      runAutomaticSync: (trigger: "dirty") => Promise<boolean>;
    }).runAutomaticSync("dirty");

    expect(consumed).toBe(false);
    expect(plugin.syncExecutor.run).not.toHaveBeenCalled();
  });

  it("does not consume a dirty hint when automatic sync setup fails", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    const run = vi.fn();
    plugin.syncExecutor = { isRunning: false, run } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded")
      .mockRejectedValueOnce(new Error("state temporarily unavailable"));

    const consumed = await (plugin as never as {
      runAutomaticSync: (trigger: "dirty") => Promise<boolean>;
    }).runAutomaticSync("dirty");

    expect(consumed).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("keeps periodic reconciliation even when no local dirty event arrives", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    plugin.startAutoSync();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);

    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("interval");
    plugin.stopAutoSync();
  });

  it("suppresses sync lifecycle notices while the EasySync sidebar is visible on desktop or mobile", () => {
    const leftSidebar = { collapsed: false };
    const desktopTabs = { parent: leftSidebar };
    let visible = true;
    let leafParent: object = desktopTabs;
    const plugin = makePlugin();
    const show = vi.fn();
    const clear = vi.fn();
    plugin.noticeCenter = { show, clear, dispose: vi.fn() } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    plugin.app = {
      workspace: {
        leftSplit: leftSidebar,
        getLeavesOfType: () => [{
          parent: leafParent,
          view: {
            containerEl: {
              isShown: () => visible,
            },
          },
          // The real Obsidian runtime does not return ViewState.active here.
          getViewState: () => ({ type: "easy-sync-detail" }),
        }],
      },
    } as never;

    (plugin as never as { beginSyncNotice: () => void }).beginSyncNotice();
    (plugin as never as { finishSyncNotice: (result: SyncResult) => void })
      .finishSyncNotice(okResult());

    expect(show).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith("sync-progress");

    leftSidebar.collapsed = true;
    (plugin as never as { beginSyncNotice: () => void }).beginSyncNotice();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-progress",
    }));

    show.mockClear();
    leftSidebar.collapsed = false;
    visible = false;
    (plugin as never as { beginSyncNotice: () => void }).beginSyncNotice();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-progress",
    }));

    show.mockClear();
    visible = true;
    leafParent = leftSidebar;
    (plugin as never as { beginSyncNotice: () => void }).beginSyncNotice();
    expect(show).not.toHaveBeenCalled();
  });

  it("shows the threshold-skipped summary notice after an automatic run proceeded past the gate (direction 3 wiring)", async () => {
    // The executor records thresholdSkippedInAuto on runFacts; finishSyncNotice
    // must map it to the one-line summary notice with the completed outcome
    // (single-slot center replaces the completed notice downstream).
    const plugin = makePlugin();
    plugin.app = { workspace: { leftSplit: undefined } } as never;
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    plugin.i18n = { t: (key: string) => key } as never;

    (plugin as never as { finishSyncNotice: (result: SyncResult) => void })
      .finishSyncNotice({
        ...okResult(),
        runFacts: {
          termination: "normal",
          ordinaryPlanning: "entered",
          userFileChanges: "none",
          thresholdSkippedInAuto: true,
        },
      });

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:threshold-skipped-auto",
      message: "notice.sync.thresholdSkippedInAuto",
      priority: NOTICE_PRIORITY.info,
      category: "ambient",
    }));
    // Completed outcome is still emitted first; the single-slot center
    // replaces it with the summary when priorities are equal.
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:completed",
    }));
  });

  it("does not show the threshold-skipped summary for a run with no flag", async () => {
    const plugin = makePlugin();
    plugin.app = { workspace: { leftSplit: undefined } } as never;
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    plugin.i18n = { t: (key: string) => key } as never;

    (plugin as never as { finishSyncNotice: (result: SyncResult) => void })
      .finishSyncNotice(okResult());

    expect(show).not.toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:threshold-skipped-auto",
    }));
  });

  it("re-evaluates an in-flight sync notice when the visible sidebar tab changes", () => {
    const leftSidebar = { collapsed: false };
    const desktopTabs = { parent: leftSidebar };
    let visible = true;
    const plugin = makePlugin();
    const clear = vi.fn();
    plugin.noticeCenter = { show: vi.fn(), clear, dispose: vi.fn() } as never;
    plugin.syncExecutor = { isRunning: true } as never;
    plugin.app = {
      workspace: {
        leftSplit: leftSidebar,
        getLeavesOfType: () => [{
          parent: desktopTabs,
          view: {
            containerEl: {
              isShown: () => visible,
            },
          },
          getViewState: () => ({ type: "easy-sync-detail" }),
        }],
      },
    } as never;
    const render = vi.spyOn(plugin as never, "renderSyncNoticeProgress")
      .mockImplementation(() => undefined);

    (plugin as never as { refreshSyncNoticeVisibility: () => void })
      .refreshSyncNoticeVisibility();
    expect(clear).toHaveBeenCalledWith("sync-progress");
    expect(render).not.toHaveBeenCalled();

    visible = false;
    (plugin as never as { refreshSyncNoticeVisibility: () => void })
      .refreshSyncNoticeVisibility();
    expect(render).toHaveBeenCalledOnce();
  });

  it("releases the sync lock when manual sync is blocked before execution", async () => {
    const plugin = makePlugin();
    plugin.syncExecutor = { isRunning: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(false);

    await plugin.startManualSync();

    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("releases the sync lock when first sync is blocked before execution", async () => {
    const plugin = makePlugin();
    plugin.syncExecutor = { isRunning: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(false);

    await plugin.startFirstSync();

    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("passes the explicit read-only preview contract to the executor", async () => {
    const plugin = makePlugin();
    plugin.state = { planReviewActive: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.startFirstSync({ readOnlyPreview: true });

    expect(run.mock.calls[0]?.[4]).toEqual({ readOnlyPreview: true });
  });

  it("routes a manual stable V2 corruption through account-bound GET-only recovery", async () => {
    const plugin = makePlugin();
    plugin.state = {
      hasV2StateLoadRecoveryBlock: true,
      v2CorruptStateRecoveryEvidence: {
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "root",
        },
      },
      planReviewActive: false,
      lastSyncTime: 1,
      baseSnapshot: [{ path: "old.md" }],
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.startManualSync();

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("manual");
    expect(run.mock.calls[0]?.[4]).toEqual({
      recoverV2CorruptState: true,
    });
  });

  it("self-heals a transient V2 state load block by reloading before a manual sync", async () => {
    const plugin = makePlugin();
    let blocked = true;
    const load = vi.fn(async () => {
      blocked = false;
    });
    plugin.state = {
      get hasV2StateLoadRecoveryBlock() {
        return blocked;
      },
      get v2StateLoadRecoveryBlock() {
        return blocked
          ? {
              version: 2,
              kind: "v2-state-load-block",
              authority: "v2",
              reason: "manifest-presence-unreadable",
              detectedAt: 1,
            }
          : null;
      },
      load,
      lastSyncTime: 1,
      baseSnapshot: [{ path: "old.md" }],
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.startManualSync();

    expect(load).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("manual");
    expect(run.mock.calls[0]?.[4]).not.toEqual(
      expect.objectContaining({ recoverV2CorruptState: true }),
    );
  });

  it("retries a transient V2 state load block with bounded backoff until it heals", async () => {
    vi.useFakeTimers();
    try {
      const plugin = makePlugin();
      let blocked = true;
      let failures = 0;
      const load = vi.fn(async () => {
        failures += 1;
        if (failures >= 2) blocked = false;
      });
      plugin.state = {
        get hasV2StateLoadRecoveryBlock() {
          return blocked;
        },
        get v2StateLoadRecoveryBlock() {
          return blocked
            ? {
                version: 2,
                kind: "v2-state-load-block",
                authority: "v2",
                reason: "migration-hold-unreadable",
                detectedAt: 1,
              }
            : null;
        },
        load,
        lastSyncTime: 1,
        baseSnapshot: [{ path: "old.md" }],
      } as never;
      vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
      vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
      const run = vi.fn().mockResolvedValue(okResult());
      plugin.syncExecutor = { isRunning: false, run } as never;

      await plugin.startManualSync();

      // First attempt failed; a backoff retry was scheduled.
      expect(load).toHaveBeenCalledTimes(1);
      expect(blocked).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);

      // The backoff retry reloaded and the block cleared.
      expect(load).toHaveBeenCalledTimes(2);
      expect(blocked).toBe(false);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule reload retries for a durable V2 state load block", async () => {
    vi.useFakeTimers();
    try {
      const plugin = makePlugin();
      const load = vi.fn().mockResolvedValue(undefined);
      plugin.state = {
        hasV2StateLoadRecoveryBlock: true,
        v2StateLoadRecoveryBlock: {
          version: 2,
          kind: "v2-state-load-block",
          authority: "v2",
          reason: "authority-witness-mismatch",
          detectedAt: 1,
        },
        load,
        v2CorruptStateRecoveryEvidence: null,
        lastSyncTime: 1,
        baseSnapshot: [{ path: "old.md" }],
      } as never;
      vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
      vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
      const run = vi.fn().mockResolvedValue(okResult());
      plugin.syncExecutor = { isRunning: false, run } as never;

      await plugin.startManualSync();

      expect(load).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);

      // No backoff retry for a durable reason; the blocked dispatch still ran.
      expect(load).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an exact reviewed corrupt-state authorization back to the recovery control plane", async () => {
    const plugin = makePlugin();
    const authorization = {
      revision: 4,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "root",
      },
      canonicalIdentity: {
        version: 2,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "root",
        },
        sourceCommitSeq: 5,
        digest: "digest",
      },
    };
    plugin.state = {
      hasV2StateLoadRecoveryBlock: true,
      v2CorruptStateRecoveryEvidence: { scope: authorization.scope },
      planReviewActive: true,
      planReviewAuthorization: authorization,
      lastSyncTime: 1,
      baseSnapshot: [{ path: "old.md" }],
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview();

    expect(run.mock.calls[0]?.[2]).toBe(true);
    expect(run.mock.calls[0]?.[3]).toBe(authorization);
    expect(run.mock.calls[0]?.[4]).toEqual({
      recoverV2CorruptState: true,
    });
  });

  it("clears a corrupt-state hold before recalculating its review", async () => {
    const plugin = makePlugin();
    const clearV2CorruptStateRecoveryReview = vi.fn();
    plugin.state = {
      v2CorruptStateRecoveryEvidence: { sourceDigest: "digest" },
      activeV2CorruptStateRecoveryHold: { phase: "pending" },
      clearV2CorruptStateRecoveryReview,
    } as never;
    plugin.syncExecutor = { isRunning: false } as never;
    const startFirstSync = vi.spyOn(plugin, "startFirstSync")
      .mockResolvedValue(undefined);

    await plugin.rebuildPlanReview();

    expect(clearV2CorruptStateRecoveryReview).toHaveBeenCalledOnce();
    expect(startFirstSync).toHaveBeenCalledOnce();
  });

  it("routes a manual held-scope sync into explicit V2 recovery instead of stale review execution", async () => {
    const plugin = makePlugin();
    const authorization = {
      revision: 3,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "root",
      },
    };
    plugin.state = {
      hasV2RemoteScopeRecovery: true,
      planReviewActive: true,
      planReviewAuthorization: authorization,
      lastSyncTime: 1,
      baseSnapshot: [{ path: "old.md" }],
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.startManualSync();

    expect(run.mock.calls[0]?.[2]).toBe(true);
    expect(run.mock.calls[0]?.[3]).toBe(authorization);
    expect(run.mock.calls[0]?.[4]).toEqual({
      recoverV2RemoteScope: true,
    });
  });

  it("only asks to create a missing remote scope from the reviewed plan action", async () => {
    const plugin = makePlugin();
    const translate = vi.fn((key: string) => key);
    plugin.i18n = { t: translate } as never;
    const authorization = {
      revision: 3,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "root",
      },
    };
    plugin.state = {
      hasV2RemoteScopeRecovery: true,
      planReviewActive: true,
      planReviewItems: [{
        type: SyncActionType.RecreateRemoteScope,
        path: "vault",
      }],
      planReviewAuthorization: authorization,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.startFirstSync();
    expect(confirmModalAwaitConfirm).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[4]).toEqual({
      recoverV2RemoteScope: true,
    });

    await plugin.executePlanReview();
    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledWith(
      "syncPlan.remoteScopeRecreateConfirmTitle",
    );
    expect(translate).toHaveBeenCalledWith(
      "syncPlan.remoteScopeRecreateConfirmMessage",
    );
    expect(translate).toHaveBeenCalledWith(
      "syncPlan.remoteScopeRecreateConfirm",
    );
    expect(run.mock.calls[1]?.[2]).toBe(true);
    expect(run.mock.calls[1]?.[3]).toBe(authorization);
    expect(run.mock.calls[1]?.[4]).toEqual({
      recoverV2RemoteScope: true,
    });
  });

  it("routes manual sync to first-sync preview when the vault has no sync state yet", async () => {
    const plugin = makePlugin();
    plugin.syncExecutor = { isRunning: false } as never;
    plugin.state = {
      planReviewActive: false,
      lastSyncTime: 0,
      baseSnapshot: [],
    } as never;
    const startFirstSync = vi.spyOn(plugin, "startFirstSync").mockResolvedValue(undefined);

    await plugin.startManualSync();

    expect(startFirstSync).toHaveBeenCalledOnce();
  });

  it("keeps automatic sync paused while a generated plan awaits review", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = true;
    plugin.state = { planReviewActive: true } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    if (typeof (plugin as never as { finishSyncNotice?: unknown }).finishSyncNotice === "function") {
      vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    }
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "first") => Promise<void>;
    }).handleSyncResult({ ...okResult(), message: "result.pausedForReview" }, "first");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps automatic sync paused from structured runFacts even when the message is not the pause text (finding ⑥)", async () => {
    // Consumers must read runFacts.planReviewPaused instead of sniffing the
    // localised message: a translated/renamed message must not change the
    // pause decision (review 2026-09-02 finding ⑥, C9/C13).
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = true;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    if (typeof (plugin as never as { finishSyncNotice?: unknown }).finishSyncNotice === "function") {
      vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    }
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "first") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      message: "some-custom-message-not-the-pause-text",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "entered",
        userFileChanges: "none",
        planReviewPaused: true,
      },
    }, "first");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("recognises cancellation from structured runFacts termination (finding ⑥)", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      message: "a-custom-cancel-wording",
      runFacts: {
        termination: "cancelled",
        ordinaryPlanning: "entered",
        userFileChanges: "none",
      },
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
  });

  it("pauses automatic sync after an unexpected incomplete result with no file error count", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      message: "result.syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
  });

  it("keeps the normal interval alive after a retryable control-plane observation failure even when the scan found an oversized file", async () => {
    vi.useFakeTimers();
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync");
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    plugin.startAutoSync();
    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      errors: 1,
      skippedLarge: 1,
      message: "result.sharedControlReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "unknown",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "shared-control-read-unavailable",
        retry: "next-sync",
        component: "directory",
      },
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("interval");
    plugin.stopAutoSync();
  });

  it("keeps the normal interval alive after a retryable ordinary remote read failure before planning", async () => {
    vi.useFakeTimers();
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync");
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    plugin.startAutoSync();
    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      errors: 1,
      message: "result.ordinaryRemoteReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "unknown",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "ordinary-remote-read-unavailable",
        retry: "next-sync",
        component: "ordinary-remote",
      },
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("interval");
    plugin.stopAutoSync();
  });

  it("persists a retryable shared-control observation as one retry-pending run before the next interval succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00+08:00"));
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.i18n = { t: (key: string) => key } as never;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    const history: SyncHistoryEntry[] = [];
    const addSyncHistory = vi.fn().mockImplementation(async (
      entry: SyncHistoryEntry,
    ) => {
      history.splice(
        0,
        history.length,
        entry,
        ...history.filter((item) => item.id !== entry.id).slice(0, 9),
      );
    });
    plugin.state = {
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      mutationLedger: [],
      planReviewActive: false,
      syncHistory: history,
      addSyncHistory,
    } as never;
    const run = vi.fn()
      .mockResolvedValueOnce({
        ...okResult(),
        success: false,
        errors: 1,
        message: "result.sharedControlReadUnavailable",
        runFacts: {
          termination: "normal",
          ordinaryPlanning: "not-entered",
          userFileChanges: "unknown",
        },
        disposition: {
          kind: "retryable-observation",
          phase: "remotePrepare",
          code: "shared-control-read-unavailable",
          retry: "next-sync",
          component: "directory",
        },
      } satisfies SyncResult)
      .mockResolvedValueOnce({
        ...okResult(),
        message: "result.synced",
        runFacts: {
          termination: "normal",
          ordinaryPlanning: "entered",
          userFileChanges: "none",
        },
      } satisfies SyncResult);
    plugin.syncExecutor = { isRunning: false, run } as never;
    vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "showRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync");
    const automaticSync = plugin as never as {
      runAutomaticSync: (trigger: "interval") => Promise<boolean>;
      autoSyncTimer: number | null;
    };
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync");

    plugin.startAutoSync();
    await expect(automaticSync.runAutomaticSync("interval")).resolves.toBe(true);

    expect(run).toHaveBeenCalledOnce();
    expect(addSyncHistory).toHaveBeenCalledOnce();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      mode: "auto",
      status: "retry-pending",
      errors: 0,
      message: "result.sharedControlReadUnavailable",
      files: [],
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "unknown",
      },
    });
    expect(plugin.autoSyncPaused).toBe(false);
    expect(automaticSync.autoSyncTimer).not.toBeNull();
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(runAutomaticSync).toHaveBeenCalledTimes(2);
    await expect(
      runAutomaticSync.mock.results[1]?.value as Promise<boolean>,
    ).resolves.toBe(true);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map((call) => call[0])).toEqual(["auto", "auto"]);
    expect(addSyncHistory).toHaveBeenCalledTimes(2);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      mode: "auto",
      status: "success",
      errors: 0,
      message: "result.synced",
      files: [],
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "entered",
        userFileChanges: "none",
      },
    });
    expect(history[1]).toMatchObject({
      status: "retry-pending",
      errors: 0,
      message: "result.sharedControlReadUnavailable",
      files: [],
      runFacts: { userFileChanges: "unknown" },
    });
    expect(plugin.autoSyncPaused).toBe(false);
    expect(automaticSync.autoSyncTimer).not.toBeNull();
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    plugin.stopAutoSync();
  });

  it("does not clear a pause owned by another failure when a manual observation is retryable", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = true;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "manual") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      errors: 1,
      message: "result.sharedControlReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "unknown",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "shared-control-read-unavailable",
        retry: "next-sync",
        component: "v3",
      },
    }, "manual");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
  });

  it("fails closed when a retryable-observation disposition contradicts completed file work", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      uploaded: 1,
      errors: 1,
      message: "contradictory result",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "entered",
        userFileChanges: "performed",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "shared-control-read-unavailable",
        retry: "next-sync",
        component: "directory",
      },
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(plugin.diag.error).toHaveBeenCalledWith(
      "execute",
      expect.stringContaining("contradicted"),
      expect.objectContaining({ uploaded: 1 }),
    );
  });

  it("keeps automatic sync active and schedules another observation after a transient recovery failure", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.state = {
      planReviewActive: false,
      isV2StateActive: true,
      mutationLedger: [{ intent: { operationId: "pending" }, receipt: null }],
    } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const schedule = vi.spyOn(
      (plugin as never as {
        mutationRecoveryScheduler: {
          continueAfterExternalFailure: (seconds: number | null) => boolean;
        };
      }).mutationRecoveryScheduler,
      "continueAfterExternalFailure",
    ).mockReturnValue(true);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (
        result: SyncResult,
        mode: "auto",
        recoveryOnly?: boolean,
      ) => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      errors: 1,
      message: "result.syncFailed",
      mutationRecovery: {
        state: "network-unavailable",
        total: 1,
        settled: 0,
        remaining: 1,
        retryAfterSeconds: 17,
      },
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledWith(17);
  });

  it("does not pause the Vault when one ordinary-file recovery is isolated", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = true;
    plugin.state = {
      planReviewActive: false,
      syncHistory: [],
      addSyncHistory: vi.fn().mockResolvedValue(undefined),
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
    } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "clearSyncLifecycleNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync")
      .mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (
        result: SyncResult,
        mode: "manual",
      ) => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      mutationRecovery: {
        state: "blocked",
        total: 1,
        settled: 0,
        remaining: 1,
        retryAfterSeconds: null,
        blockReason: "facts-changed",
        blockedOperationId: "pending",
        isolated: true,
      },
    }, "manual");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).toHaveBeenCalledOnce();
  });

  it("keeps automatic sync active when conflicts coexist with isolated recovery", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = {
      planReviewActive: false,
      syncHistory: [],
      addSyncHistory: vi.fn().mockResolvedValue(undefined),
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
    } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (
        result: SyncResult,
        mode: "manual",
      ) => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      conflicts: 1,
      mutationRecovery: {
        state: "blocked",
        total: 1,
        settled: 0,
        remaining: 1,
        retryAfterSeconds: null,
        blockReason: "facts-changed",
        blockedOperationId: "pending",
        isolated: true,
      },
    }, "manual");

    // Neither conflicts (2026-09-01) nor an isolated ordinary-file recovery
    // pause the vault; unrelated files keep syncing.
    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
  });

  it("updates one continuing history event across retries and marks it recovered when evidence settles", async () => {
    const plugin = new EasySyncPlugin();
    const history: SyncHistoryEntry[] = [{
      id: "mutation-recovery-1",
      mode: "auto",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
      files: [],
      recovery: {
        state: "waiting-network",
        total: 1,
        settled: 0,
        remaining: 1,
        updatedAt: 2,
      },
    }];
    const addSyncHistory = vi.fn().mockImplementation(async (
      entry: SyncHistoryEntry,
    ) => {
      history.splice(
        0,
        history.length,
        entry,
      );
    });
    plugin.state = { syncHistory: history, addSyncHistory } as never;
    plugin.progressStore.markStarted("mutationRecovery");
    const record = (plugin as never as {
      recordSyncHistory: (
        result: SyncResult,
        mode: "auto",
        recoveryOnly: boolean,
        context: {
          priorTotal: number;
          priorRemaining: number;
          newRemaining: number;
        },
      ) => Promise<void>;
    }).recordSyncHistory.bind(plugin);

    await record({
      ...okResult(),
      success: false,
      errors: 1,
      mutationRecovery: {
        state: "network-unavailable",
        total: 1,
        settled: 0,
        remaining: 1,
        retryAfterSeconds: 10,
      },
    }, "auto", true, {
      priorTotal: 1,
      priorRemaining: 1,
      newRemaining: 0,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "mutation-recovery-1",
      status: "partial",
      recovery: { state: "waiting-network", remaining: 1 },
    });

    await record({
      ...okResult(),
      mutationRecovery: {
        state: "settled",
        total: 1,
        settled: 1,
        remaining: 0,
        retryAfterSeconds: null,
      },
    }, "auto", true, {
      priorTotal: 1,
      priorRemaining: 0,
      newRemaining: 0,
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "mutation-recovery-1",
      status: "success",
      errors: 0,
      recovery: {
        state: "recovered",
        settled: 1,
        remaining: 0,
      },
    });
  });

  it("records unresolved conflicts as partial instead of a completed run", async () => {
    const plugin = new EasySyncPlugin();
    const addSyncHistory = vi.fn().mockResolvedValue(undefined);
    plugin.state = {
      syncHistory: [],
      addSyncHistory,
    } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    plugin.progressStore.markStarted("fullSync");

    await (plugin as never as {
      recordSyncHistory: (
        result: SyncResult,
        mode: "manual",
        recoveryOnly: boolean,
        context: {
          priorTotal: number;
          priorRemaining: number;
          newRemaining: number;
        },
      ) => Promise<void>;
    }).recordSyncHistory({
      ...okResult(),
      conflicts: 1,
      message: "result.conflictsPending",
    }, "manual", false, {
      priorTotal: 0,
      priorRemaining: 0,
      newRemaining: 0,
    });

    expect(addSyncHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "partial",
        conflicts: 1,
        message: "result.conflictsPending",
      }),
    );
  });

  it("keeps automatic sync available when the fast recovery budget is exhausted", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    const history: SyncHistoryEntry[] = [{
      id: "mutation-recovery-1",
      mode: "auto" as const,
      status: "partial" as const,
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
      files: [],
      recovery: {
        state: "waiting-network" as const,
        total: 1,
        settled: 0,
        remaining: 1,
        updatedAt: 2,
      },
    }];
    const addSyncHistory = vi.fn().mockImplementation(async (
      entry: SyncHistoryEntry,
    ) => {
      history.splice(0, history.length, entry);
    });
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
      mutationRecoveryQuarantine: [],
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      syncHistory: history,
      addSyncHistory,
    } as never;
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync")
      .mockImplementation(() => undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);
    plugin.diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never;

    await (plugin as never as {
      handleMutationRecoveryBudgetExhausted: () => Promise<void>;
    }).handleMutationRecoveryBudgetExhausted();

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(addSyncHistory).not.toHaveBeenCalled();
    expect(history[0]).toEqual(expect.objectContaining({
      id: "mutation-recovery-1",
      recovery: expect.objectContaining({
        state: "waiting-network",
        remaining: 1,
      }),
    }));
    expect((plugin as never as {
      mutationRecoveryBlockReason: string | null;
    }).mutationRecoveryBlockReason).toBeNull();
    expect(plugin.diag.warn).toHaveBeenCalledWith(
      "execute",
      "fast mutation recovery budget exhausted; waiting for an external observation trigger",
      expect.objectContaining({ remaining: 1, mutations: 0 }),
    );
  });

  it("turns a stable scope mismatch into one persistent recovery block with a concise sidebar notice", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.auth = {
      authState: { isLoggedIn: true, accountId: "account" },
    } as never;
    const history: unknown[] = [];
    const addSyncHistory = vi.fn().mockImplementation(async (entry: unknown) => {
      history.splice(0, history.length, entry);
    });
    const run = vi.fn();
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{
        intent: {
          operationId: "pending",
          path: "notes/a.md",
          createdAt: 1,
        },
        receipt: null,
      }],
      mutationRecoveryQuarantine: [],
      syncHistory: history,
      addSyncHistory,
      planReviewActive: false,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: true,
    } as never;
    plugin.syncExecutor = { isRunning: false, run } as never;
    vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    const outcome = await (plugin as never as {
      runScheduledMutationRecovery: () => Promise<{ state: string }>;
    }).runScheduledMutationRecovery();

    expect(outcome).toEqual({ state: "blocked" });
    expect(run).not.toHaveBeenCalled();
    expect(plugin.autoSyncPaused).toBe(true);
    expect(addSyncHistory).toHaveBeenCalledWith(expect.objectContaining({
      recovery: expect.objectContaining({
        state: "blocked",
        blockReason: "scope-changed",
      }),
    }));
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:recovery-blocked",
      message: "Some unfinished operations cannot be confirmed automatically. Open the EasySync sidebar for details, or export a diagnostic report.",
    }));
    expect(show.mock.calls[0]?.[0]?.message).not.toContain(
      "The sync location no longer matches",
    );
    expect(show.mock.calls[0]?.[0]?.message).not.toContain("notes/a.md");
  });

  it("does not recommend reset when the current account differs during unfinished-operation recovery", async () => {
    const plugin = makePlugin();
    plugin.autoSyncPaused = false;
    plugin.auth = {
      authState: { isLoggedIn: true, accountId: "account-new" },
    } as never;
    const history: unknown[] = [];
    const addSyncHistory = vi.fn().mockImplementation(async (entry: unknown) => {
      history.splice(0, history.length, entry);
    });
    const bindAccount = vi.fn();
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    plugin.state = {
      isV2StateActive: true,
      boundAccountId: "account-old",
      bindAccount,
      mutationLedger: [{
        intent: {
          operationId: "pending",
          path: "notes/a.md",
          createdAt: 1,
        },
        receipt: null,
      }],
      mutationRecoveryQuarantine: [],
      syncHistory: history,
      addSyncHistory,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      hasV2StateLoadRecoveryBlock: false,
    } as never;
    vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    const allowed = await (plugin as never as {
      checkAccountBindingForSync: () => Promise<boolean>;
    }).checkAccountBindingForSync();

    expect(allowed).toBe(false);
    expect(bindAccount).not.toHaveBeenCalled();
    expect(plugin.autoSyncPaused).toBe(true);
    const messages = show.mock.calls.map((call) => String(call[0]?.message));
    expect(messages.join("\n")).toContain(
      "Switch back to the original account",
    );
    expect(messages.join("\n")).not.toContain(
      "Reset sync state before switching accounts",
    );
  });

  it("keeps automatic sync active when an in-flight file was safely deferred", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const resetAutoSyncTimer = vi.spyOn(plugin as never, "resetAutoSyncTimer")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      deferred: 1,
      message: "result.deferred",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(resetAutoSyncTimer).toHaveBeenCalledOnce();
  });

  it("does not re-arm a persisted community plugin join after a successful automatic sync", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    // A pending join — even one permanently blocked but recheckable like
    // remote-bundle-missing — must not re-arm the dirty trigger here.
    vi.spyOn(plugin as never, "hasPendingCommunityPluginJoin").mockReturnValue(true);
    const scheduleCommunityPluginJoinSync = vi.spyOn(
      plugin as never,
      "scheduleCommunityPluginJoinSync",
    );
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({ ...okResult() }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    // The successful automatic run only resets the interval gap; re-arming the
    // join here was what produced the observed ~10s infinite "修改后同步" loop.
    expect(scheduleCommunityPluginJoinSync).not.toHaveBeenCalled();
  });

  it("still arms a persisted community plugin join on the lifecycle start entry", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncPaused = false;
    vi.spyOn(plugin as never, "hasPendingCommunityPluginJoin").mockReturnValue(true);
    const schedulePersistedJoinSync = vi.spyOn(
      plugin as never,
      "schedulePersistedCommunityPluginJoinSync",
    ).mockImplementation(() => undefined);

    plugin.startAutoSync();

    expect(schedulePersistedJoinSync).toHaveBeenCalledWith("auto-start");
  });

  it("keeps automatic sync active when an otherwise successful run leaves pending conflicts", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      conflicts: 1,
      message: "result.conflictsPending",
    }, "auto");

    // Conflicts are pending decisions, not a sync gate: automatic sync keeps
    // running and the rest of the vault keeps syncing (2026-09-01 decision).
    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("does not clear an existing automatic sync pause with a deferred manual run", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = true;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "manual") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      deferred: 1,
      message: "result.deferred",
    }, "manual");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps the reviewed plan in state until manual sync hands off to the executor", async () => {
    const plugin = makePlugin();
    const clearPlanReview = vi.fn().mockResolvedValue(undefined);
    const authorization = {
      revision: 3,
      scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "files" },
    };
    plugin.state = {
      planReviewActive: true,
      planReviewAuthorization: authorization,
      clearPlanReview,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    plugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockImplementation(async (_mode: string, _callbacks: unknown, skipConfirmation: boolean, reviewedAuthorization: unknown) => {
        expect(skipConfirmation).toBe(true);
        expect(reviewedAuthorization).toEqual(authorization);
        expect(plugin.state?.planReviewActive).toBe(true);
        expect(clearPlanReview).not.toHaveBeenCalled();
        return okResult();
      }),
    } as never;

    await plugin.startManualSync();

    expect(clearPlanReview).not.toHaveBeenCalled();
  });

  it("keeps the reviewed plan in state until sidebar execution hands off to the executor", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    const clearPlanReview = vi.fn().mockResolvedValue(undefined);
    const authorization = {
      revision: 4,
      scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "files" },
    };
    plugin.state = {
      planReviewActive: true,
      planReviewRevision: 4,
      planReviewCounts: {
        uploads: 1,
        downloads: 0,
        folders: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      planReviewItems: [{ type: SyncActionType.Upload, path: "ready.md" }],
      planReviewAuthorization: authorization,
      clearPlanReview,
    } as never;
    const joinAuthorization = {
      pluginId: "dataview",
      operationId: "join-dataview-reviewed-plan",
      targetCatalogRevision: 7,
      targetBundleDigest: "b".repeat(64),
      scope: authorization.scope,
      members: [],
    };
    const prepareCommunityPluginJoinsForSync = vi.spyOn(
      plugin as never,
      "prepareCommunityPluginJoinsForSync",
    ).mockResolvedValue({ authorizations: [joinAuthorization] });
    plugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockImplementation(async (_mode: string, _callbacks: unknown, skipConfirmation: boolean, reviewedAuthorization: unknown, options: unknown) => {
        expect(skipConfirmation).toBe(true);
        expect(reviewedAuthorization).toEqual(authorization);
        expect(options).toEqual({
          communityPluginJoinAuthorizations: [joinAuthorization],
        });
        expect(plugin.state?.planReviewActive).toBe(true);
        expect(clearPlanReview).not.toHaveBeenCalled();
        return okResult();
      }),
    } as never;

    await plugin.executePlanReview(4);

    expect(prepareCommunityPluginJoinsForSync)
      .toHaveBeenCalledWith(authorization);
    expect(clearPlanReview).not.toHaveBeenCalled();
  });

  it("does not execute a stale sidebar plan control after the review revision changes", async () => {
    const plugin = makePlugin();
    const render = vi.fn();
    plugin.app.workspace.getLeavesOfType = vi.fn().mockReturnValue([{
      view: { render },
    }]) as never;
    plugin.state = {
      planReviewActive: true,
      planReviewRevision: 9,
      planReviewCounts: {
        uploads: 1,
        downloads: 0,
        folders: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      planReviewItems: [{ type: SyncActionType.Upload, path: "new.md" }],
    } as never;
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview(8);

    expect(run).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
  });

  it("does not execute a plan whose persisted counts have no review details", async () => {
    const plugin = makePlugin();
    const render = vi.fn();
    plugin.app.workspace.getLeavesOfType = vi.fn().mockReturnValue([{
      view: { render },
    }]) as never;
    plugin.state = {
      planReviewActive: true,
      planReviewRevision: 9,
      planReviewCounts: {
        uploads: 1,
        downloads: 0,
        folders: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      planReviewItems: [],
    } as never;
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview(9);

    expect(run).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
  });

  it("requires migration-risk acknowledgement before executing a V2 migration review", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    plugin.i18n = { t: (key: string) => key } as never;
    const authorization = {
      reviewKind: "v2-migration" as const,
      revision: 4,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "files",
      },
    };
    plugin.state = {
      planReviewActive: true,
      planReviewAuthorization: authorization,
    } as never;
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview();

    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[2]).toBe(true);
    expect(run.mock.calls[0]?.[3]).toBe(authorization);
    expect(run.mock.calls[0]?.[4]).toEqual({
      acknowledgeMigrationRisk: true,
    });
  });

  it("keeps a V2 migration review pending when risk acknowledgement is cancelled", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    plugin.i18n = { t: (key: string) => key } as never;
    confirmModalAwaitConfirm.mockResolvedValueOnce(false);
    plugin.state = {
      planReviewActive: true,
      planReviewAuthorization: {
        reviewKind: "v2-migration",
        revision: 4,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "files",
        },
      },
    } as never;
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview();

    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(plugin.state.planReviewActive).toBe(true);
  });

  it("joins existing cloud V2 without showing the public-upgrade warning", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    const authorization = {
      reviewKind: "v2-cloud-join" as const,
      revision: 4,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "files",
      },
    };
    plugin.state = {
      planReviewActive: true,
      planReviewAuthorization: authorization,
    } as never;
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview();

    expect(confirmModalAwaitConfirm).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[3]).toBe(authorization);
    expect(run.mock.calls[0]?.[4]).toEqual({});
  });

  it("creates first V2 protocol from ordinary plan confirmation without a remote-folder warning", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    const authorization = {
      reviewKind: "v2-first-sync" as const,
      revision: 4,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "files",
      },
    };
    plugin.state = {
      planReviewActive: true,
      planReviewAuthorization: authorization,
    } as never;
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview();

    expect(confirmModalAwaitConfirm).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[3]).toBe(authorization);
    expect(run.mock.calls[0]?.[4]).toEqual({
      acknowledgeMigrationRisk: true,
    });
  });

  it("keeps a missing remote-scope plan pending when folder creation is cancelled", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    confirmModalAwaitConfirm.mockResolvedValueOnce(false);
    plugin.state = {
      planReviewActive: true,
      hasV2RemoteScopeRecovery: true,
      planReviewItems: [{
        type: SyncActionType.RecreateRemoteScope,
        path: "vault",
      }],
      planReviewAuthorization: {
        revision: 4,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "files",
        },
      },
    } as never;
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview();

    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(plugin.state.planReviewActive).toBe(true);
  });

  it("blocks sidebar plan execution when the current token account no longer matches", async () => {
    const plugin = makePlugin();
    plugin.state = {
      planReviewActive: true,
      planReviewAuthorization: {
        revision: 5,
        scope: { accountId: "account-old", driveId: "drive", vaultFolderId: "vault", filesRootId: "files" },
      },
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    await plugin.executePlanReview();

    expect(run).not.toHaveBeenCalled();
    expect(plugin.state.planReviewActive).toBe(true);
  });

  it("writes a changed reviewed plan back through the normal threshold alert", async () => {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    plugin.state = { planReviewActive: true } as never;
    const changedPlan: SyncPlan = {
      items: [],
      lastTotalFiles: 12,
      confirmed: false,
    };
    const showPlanAlert = vi.spyOn(plugin as never, "showPlanAlert")
      .mockResolvedValue(false);
    plugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockImplementation(async (_mode: string, callbacks: SyncCallbacks) => {
        expect(callbacks.onConfirmThreshold).toBeTypeOf("function");
        await callbacks.onConfirmThreshold?.(changedPlan);
        return okResult();
      }),
    } as never;

    await plugin.executePlanReview();

    expect(showPlanAlert).toHaveBeenCalledWith("threshold", changedPlan);
  });

  it("recalculates a migration review through the default V2 entry", async () => {
    const plugin = makePlugin();
    const clearPlanReview = vi.fn().mockResolvedValue(true);
    plugin.state = {
      planReviewAuthorization: {
        reviewKind: "v2-migration",
        revision: 4,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "files",
        },
      },
      clearPlanReview,
    } as never;
    plugin.syncExecutor = { isRunning: false } as never;
    const startFirstSync = vi.spyOn(plugin, "startFirstSync")
      .mockResolvedValue(undefined);

    await plugin.rebuildPlanReview();

    expect(clearPlanReview).toHaveBeenCalledOnce();
    expect(startFirstSync).toHaveBeenCalledWith();
  });

  it("routes a UI conflict decision through state load and the current account gate", async () => {
    const plugin = makePlugin();
    const resolveConflictKeepLocal = vi.fn().mockResolvedValue(undefined);
    plugin.state = {} as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      resolveConflictKeepLocal,
    } as never;
    const checkAccountBinding = vi.spyOn(plugin as never, "checkAccountBinding")
      .mockResolvedValue(true);
    const updateStatusBar = vi.spyOn(plugin, "updateStatusBar")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin, "syncView", "get").mockReturnValue(null);

    await expect(plugin.resolveConflictKeepLocal("note.md")).resolves.toBe(true);

    expect(plugin.ensureStateLoaded).toHaveBeenCalledOnce();
    expect(checkAccountBinding).toHaveBeenCalledOnce();
    expect(resolveConflictKeepLocal).toHaveBeenCalledWith("note.md");
    expect(updateStatusBar).toHaveBeenCalledOnce();
  });

  it("releases a conflict-owned automatic pause after the final pending decision settles", async () => {
    const plugin = makePlugin();
    plugin.autoSyncPaused = true;
    plugin.syncInterval = 5;
    const history: SyncHistoryEntry[] = [{
      id: "conflict-run",
      mode: "manual",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      uploaded: 2,
      downloaded: 1,
      deleted: 0,
      conflicts: 2,
      deferred: 0,
      skipped: 0,
      errors: 0,
      message: "result.conflictsPending",
      files: [],
    }];
    const state = {
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      mutationLedger: [],
      mutationRecoveryQuarantine: [],
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      planReviewActive: false,
      pendingIssues: [],
      pendingConflicts: [{ path: "a.md" }, { path: "b.md" }],
      pendingRemoteDeletes: [],
      syncHistory: history,
    };
    const resolveConflictKeepLocal = vi.fn().mockImplementation(async (path: string) => {
      const index = state.pendingConflicts.findIndex((item) => item.path === path);
      if (index >= 0) state.pendingConflicts.splice(index, 1);
    });
    plugin.state = state as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      resolveConflictKeepLocal,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    vi.spyOn(plugin, "syncView", "get").mockReturnValue(null);

    await expect(plugin.resolveConflictKeepLocal("a.md")).resolves.toBe(true);

    expect(plugin.autoSyncPaused).toBe(true);
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();

    await expect(plugin.resolveConflictKeepLocal("b.md")).resolves.toBe(true);

    expect(plugin.autoSyncPaused).toBe(false);
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).toHaveBeenCalledOnce();
    expect(history[0]?.status).toBe("partial");
  });

  it("keeps the automatic pause when the latest conflicted run also had an error", async () => {
    const plugin = makePlugin();
    plugin.autoSyncPaused = true;
    const state = {
      isV2StateActive: true,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      mutationLedger: [],
      mutationRecoveryQuarantine: [],
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      planReviewActive: false,
      pendingIssues: [],
      pendingConflicts: [{ path: "note.md" }],
      pendingRemoteDeletes: [],
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
      } satisfies SyncHistoryEntry],
    };
    plugin.state = state as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      resolveConflictKeepLocal: vi.fn().mockImplementation(async () => {
        state.pendingConflicts.splice(0, state.pendingConflicts.length);
      }),
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    vi.spyOn(plugin, "syncView", "get").mockReturnValue(null);

    await expect(plugin.resolveConflictKeepLocal("note.md")).resolves.toBe(true);

    expect(plugin.autoSyncPaused).toBe(true);
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("blocks legacy side actions until the default sync entry has committed V2 authority", async () => {
    const plugin = makePlugin();
    const resolveConflictKeepLocal = vi.fn().mockResolvedValue(undefined);
    const show = vi.fn();
    plugin.i18n = { t: (key: string) => key } as never;
    plugin.noticeCenter = { show, dispose: vi.fn() } as never;
    plugin.state = { isV2StateActive: false } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      resolveConflictKeepLocal,
    } as never;
    const checkAccountBinding = vi.spyOn(plugin as never, "checkAccountBinding")
      .mockResolvedValue(true);

    await expect(plugin.resolveConflictKeepLocal("legacy.md"))
      .resolves.toBe(false);

    expect(resolveConflictKeepLocal).not.toHaveBeenCalled();
    expect(checkAccountBinding).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "side-action-gateway:v2-migration-required",
      message: "notice.v2MigrationRequired",
    }));
  });

  it("submits one exact pending-delete snapshot through the existing side-action gateway", async () => {
    const plugin = makePlugin();
    const confirmRemoteDeletes = vi.fn().mockResolvedValue(undefined);
    plugin.state = {
      pendingRemoteDeletes: [
        { path: "a.md" },
        { path: "b.md" },
        { path: "new-after-click.md" },
      ],
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      confirmRemoteDeletes,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    vi.spyOn(plugin, "syncView", "get").mockReturnValue(null);

    await expect(plugin.confirmRemoteDeletes(["a.md", "b.md", "missing.md"]))
      .resolves.toBe(true);

    expect(confirmRemoteDeletes).toHaveBeenCalledOnce();
    expect(confirmRemoteDeletes).toHaveBeenCalledWith(["a.md", "b.md"]);
  });

  it("shows one queueing notice for a batch delete before entering the side-action gateway", async () => {
    const plugin = makePlugin();
    const show = vi.fn();
    const confirmRemoteDeletes = vi.fn().mockResolvedValue(undefined);
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    plugin.state = {
      pendingRemoteDeletes: [
        { path: "a.md" },
        { path: "b.md" },
      ],
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      confirmRemoteDeletes,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    vi.spyOn(plugin, "syncView", "get").mockReturnValue(null);

    await expect(plugin.confirmRemoteDeletes(["a.md", "b.md"]))
      .resolves.toBe(true);

    // 入队提示先于网关执行弹出，且走 ambient 过滤（遵循「通知弹窗」设置）。
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "side-action:batch-delete:queueing",
      message: "notice.delete.queueing",
      category: "ambient",
    }));
    expect(confirmRemoteDeletes).toHaveBeenCalledOnce();
  });

  it("blocks UI side actions when the current token account does not match", async () => {
    const plugin = makePlugin();
    const resolveConflictKeepRemote = vi.fn();
    plugin.state = {} as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      resolveConflictKeepRemote,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(false);

    await expect(plugin.resolveConflictKeepRemote("note.md")).resolves.toBe(false);

    expect(resolveConflictKeepRemote).not.toHaveBeenCalled();
  });

  it("uses the existing activity gate without replacing the executor side-action queue", async () => {
    const plugin = makePlugin();
    const confirmRemoteDelete = vi.fn().mockResolvedValue(undefined);
    const show = vi.fn();
    plugin.noticeCenter = { show, dispose: vi.fn() } as never;
    plugin.state = {} as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      confirmRemoteDelete,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    (plugin as never as { acquireOpLock: (operation: string) => string | null })
      .acquireOpLock("reset");

    await expect(plugin.confirmRemoteDelete("note.md")).resolves.toBe(false);

    expect(confirmRemoteDelete).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledOnce();
  });

  it("keeps multiple UI decisions on the executor-owned queue entry", async () => {
    const plugin = makePlugin();
    const rejectRemoteDelete = vi.fn().mockResolvedValue(undefined);
    plugin.state = {} as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: true,
      rejectRemoteDelete,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    vi.spyOn(plugin, "syncView", "get").mockReturnValue(null);

    const results = await Promise.all([
      plugin.rejectRemoteDelete("a.md"),
      plugin.rejectRemoteDelete("b.md"),
    ]);

    expect(results).toEqual([true, true]);
    expect(rejectRemoteDelete.mock.calls).toEqual([["a.md"], ["b.md"]]);
  });

  it("contains gateway setup failures and leaves the executor untouched", async () => {
    const plugin = makePlugin();
    const resolveConflictKeepLocal = vi.fn();
    const show = vi.fn();
    plugin.noticeCenter = { show, dispose: vi.fn() } as never;
    plugin.state = {} as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      resolveConflictKeepLocal,
    } as never;
    vi.mocked(plugin.ensureStateLoaded).mockRejectedValueOnce(new Error("state unavailable"));
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    vi.spyOn(plugin, "syncView", "get").mockReturnValue(null);

    await expect(plugin.resolveConflictKeepLocal("note.md")).resolves.toBe(false);

    expect(resolveConflictKeepLocal).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledOnce();
    expect(plugin.diag.warn).toHaveBeenCalled();
  });

  it("invalidates the shared lifecycle before resetting sync state", async () => {
    const plugin = makePlugin();
    const invalidateLifecycle = vi.fn();
    const reset = vi.fn().mockResolvedValue(undefined);
    const clearScanCache = vi.fn().mockResolvedValue(undefined);
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      invalidateLifecycle,
    } as never;
    plugin.state = { reset } as never;
    plugin.scanner = { clearScanCache } as never;
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);

    await plugin.resetSyncState();

    expect(invalidateLifecycle).toHaveBeenCalledWith("reset");
    expect(invalidateLifecycle.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]);
    expect(clearScanCache).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
  });

  it("allows explicit local-state reset through a V2 load block when no mutation evidence is unresolved", async () => {
    const plugin = makePlugin();
    const reset = vi.fn().mockResolvedValue(undefined);
    const clearScanCache = vi.fn().mockResolvedValue(undefined);
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      invalidateLifecycle: vi.fn(),
    } as never;
    plugin.state = {
      hasV2StateLoadRecoveryBlock: true,
      mutationLedger: [],
      mutationRecoveryQuarantine: [],
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      reset,
    } as never;
    plugin.scanner = { clearScanCache } as never;
    vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);

    await plugin.resetSyncState();

    expect(reset).toHaveBeenCalledOnce();
    expect(clearScanCache).toHaveBeenCalledOnce();
  });

  it("shows a localized failure when local-state reset cannot finish", async () => {
    const plugin = makePlugin();
    const show = vi.fn();
    plugin.noticeCenter = { show, dispose: vi.fn() } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      invalidateLifecycle: vi.fn(),
    } as never;
    plugin.state = {
      mutationLedger: [],
      mutationRecoveryQuarantine: [],
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      reset: vi.fn().mockRejectedValue(new Error("state cleanup failed")),
    } as never;

    await expect(plugin.resetSyncState()).resolves.toBeUndefined();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-failed",
    }));
    expect(plugin.diag.error).toHaveBeenCalledWith(
      "state",
      "local sync state reset failed",
      expect.any(Error),
    );
  });

  it("contains a post-reset settings persistence failure and leaves reset retryable", async () => {
    const plugin = makePlugin();
    const show = vi.fn();
    const reset = vi.fn().mockResolvedValue(undefined);
    const clearScanCache = vi.fn().mockResolvedValue(undefined);
    plugin.noticeCenter = { show, dispose: vi.fn() } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      invalidateLifecycle: vi.fn(),
    } as never;
    plugin.state = {
      mutationLedger: [],
      mutationRecoveryQuarantine: [],
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      reset,
    } as never;
    plugin.scanner = { clearScanCache } as never;
    vi.spyOn(plugin, "saveSyncSettings")
      .mockRejectedValue(new Error("settings write failed"));

    await expect(plugin.resetSyncState()).resolves.toBeUndefined();

    expect(reset).toHaveBeenCalledOnce();
    expect(clearScanCache).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-failed",
    }));
    expect(show).not.toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-complete",
    }));
    expect(plugin.diag.error).toHaveBeenCalledWith(
      "state",
      "local reset maintenance failed",
      expect.any(Error),
    );
  });

  it("settles readable mutation recovery under the reset lock before clearing local sync state", async () => {
    const plugin = makePlugin();
    const {
      state,
      invalidateLifecycle,
      reset,
      clearScanCache,
      saveSyncSettings,
    } =
      attachResetRecoveryHarness(plugin);
    state.planReviewActive = true;
    const dispatch = vi.spyOn(plugin as never, "dispatchSyncRun")
      .mockImplementation(async (request: {
        mode: string;
        options?: { recoveryOnly?: boolean };
      }) => {
        expect(request).toMatchObject({
          mode: "manual",
          options: {
            recoveryOnly: true,
            mutationRecoveryObservationOnly: true,
          },
          resultOwner: "reset",
        });
        expect((plugin as never as { opLock: string | null }).opLock)
          .toBe("reset");
        expect(invalidateLifecycle).toHaveBeenCalledWith("reset");
        state.mutationLedger.splice(0);
        return {
          ...okResult(),
          mutationRecovery: {
            state: "settled" as const,
            total: 1,
            settled: 1,
            remaining: 0,
            retryAfterSeconds: null,
          },
        };
      });

    await plugin.resetSyncState();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      reset.mock.invocationCallOrder[0],
    );
    expect(clearScanCache).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("keeps reset-owned recovery outside ordinary sync result handling", async () => {
    const plugin = makePlugin();
    const handleSyncResult = vi.mocked(
      (plugin as never as { handleSyncResult: () => Promise<void> })
        .handleSyncResult,
    );
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearSyncLifecycleNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    plugin.state = {
      isV2StateActive: true,
      syncHistory: [],
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
      addSyncHistory: vi.fn(async (entry) => {
        (plugin.state?.syncHistory ?? []).splice(
          0,
          plugin.state?.syncHistory.length ?? 0,
          entry,
        );
      }),
    } as never;
    const run = vi.fn().mockImplementation(async () => {
      plugin.progressStore.finish();
      return {
        ...okResult(),
        success: false,
        errors: 1,
        mutationRecovery: {
          state: "blocked" as const,
          total: 1,
          settled: 0,
          remaining: 1,
          retryAfterSeconds: null,
          blockReason: "facts-changed",
          blockedOperationId: "pending",
        },
      };
    });
    plugin.syncExecutor = {
      isRunning: false,
      run,
      canResolveMutationRecovery: vi.fn().mockReturnValue(true),
    } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
        options: { recoveryOnly: true };
        resultOwner: "reset";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({
      mode: "manual",
      options: { recoveryOnly: true },
      resultOwner: "reset",
    });

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[4]).toMatchObject({ recoveryOnly: true });
    expect(handleSyncResult).not.toHaveBeenCalled();
    expect(plugin.state.addSyncHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({
          state: "blocked",
          blockReason: "facts-changed",
          blockedOperationId: "pending",
        }),
      }),
    );
    expect(plugin.getMutationRecoveryDisplayState()).toMatchObject({
      kind: "blocked",
      blockReason: "facts-changed",
      blockedOperationId: "pending",
    });
  });

  it("does not invent a network recovery history when reset receives no recovery summary", async () => {
    const plugin = makePlugin();
    const addSyncHistory = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearSyncLifecycleNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    plugin.state = {
      isV2StateActive: true,
      syncHistory: [],
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
      addSyncHistory,
    } as never;
    const run = vi.fn().mockImplementation(async () => {
      plugin.progressStore.finish();
      return {
        ...okResult(),
        success: false,
        errors: 1,
        message: "local scan incomplete",
      };
    });
    plugin.syncExecutor = {
      isRunning: false,
      run,
      canResolveMutationRecovery: vi.fn().mockReturnValue(false),
    } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
        options: { recoveryOnly: true };
        resultOwner: "reset";
      }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({
      mode: "manual",
      options: { recoveryOnly: true },
      resultOwner: "reset",
    });

    expect(addSyncHistory).not.toHaveBeenCalled();
    expect(plugin.getMutationRecoveryDisplayState()).toMatchObject({
      kind: "checking",
      blockReason: null,
    });
  });

  it("offers informed forced reset confirmation when one reset-owned recovery attempt stays blocked", async () => {
    const plugin = makePlugin();
    const {
      state,
      invalidateLifecycle,
      reset,
      forceReset,
      saveSyncSettings,
    } =
      attachResetRecoveryHarness(plugin);
    const show = vi.fn();
    plugin.noticeCenter = {
      activeKey: null,
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    const dispatch = vi.spyOn(plugin as never, "dispatchSyncRun")
      .mockResolvedValue({
        ...okResult(),
        success: false,
        errors: 1,
        mutationRecovery: {
          state: "blocked",
          total: 1,
          settled: 0,
          remaining: 1,
          retryAfterSeconds: null,
          blockReason: "facts-changed",
          blockedOperationId: "pending",
        },
      });
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    confirmModalAwaitConfirm.mockResolvedValueOnce(false);

    await plugin.resetSyncState();

    expect(invalidateLifecycle).toHaveBeenCalledWith("reset");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(forceReset).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("force resets after informed confirmation when recovery stays blocked", async () => {
    const plugin = makePlugin();
    const {
      forceReset,
      clearScanCache,
      saveSyncSettings,
      reset,
    } = attachResetRecoveryHarness(plugin);
    const show = vi.fn();
    plugin.noticeCenter = {
      activeKey: null,
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    const dispatch = vi.spyOn(plugin as never, "dispatchSyncRun")
      .mockResolvedValue({
        ...okResult(),
        success: false,
        errors: 1,
        mutationRecovery: {
          state: "blocked",
          total: 1,
          settled: 0,
          remaining: 1,
          retryAfterSeconds: null,
          blockReason: "facts-changed",
          blockedOperationId: "pending",
        },
      });
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    confirmModalAwaitConfirm.mockResolvedValueOnce(true);

    await plugin.resetSyncState();

    expect(forceReset).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(clearScanCache).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-complete",
    }));
  });

  it("reports a reset failure and keeps evidence when forced reset throws", async () => {
    const plugin = makePlugin();
    const {
      state,
      forceReset,
      reset,
      saveSyncSettings,
    } = attachResetRecoveryHarness(plugin);
    forceReset.mockRejectedValue(new Error("IndexedDB commit failed"));
    const show = vi.fn();
    plugin.noticeCenter = {
      activeKey: null,
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    const dispatch = vi.spyOn(plugin as never, "dispatchSyncRun")
      .mockResolvedValue({
        ...okResult(),
        success: false,
        errors: 1,
        mutationRecovery: {
          state: "blocked",
          total: 1,
          settled: 0,
          remaining: 1,
          retryAfterSeconds: null,
          blockReason: "facts-changed",
          blockedOperationId: "pending",
        },
      });
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    confirmModalAwaitConfirm.mockResolvedValueOnce(true);

    await expect(plugin.resetSyncState()).resolves.toBeUndefined();

    expect(forceReset).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-failed",
    }));
    expect(plugin.diag.error).toHaveBeenCalledWith(
      "state",
      "local sync state reset failed",
      expect.objectContaining({ message: "IndexedDB commit failed" }),
    );
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("keeps isolated conservative reset out of the forced-reset path", async () => {
    const plugin = makePlugin();
    const {
      forceReset,
      resetPreservingIsolatedMutationRecovery,
    } = attachResetRecoveryHarness(plugin);
    const retained = {
      intent: {
        version: 1 as const,
        operationId: "pending",
        planRevision: 1,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "root",
        },
        action: "upload" as const,
        path: "notes/a.md",
        expectedLocal: {
          exists: true as const,
          hash: "aa".repeat(32),
          size: 3,
        },
        expectedRemote: {
          exists: true as const,
          driveId: "remote-a",
          eTag: "etag-a",
          size: 3,
          sha256Hash: "aa".repeat(32),
        },
        createdAt: 1,
      },
      receipt: null,
    };
    plugin.state.mutationLedger.splice(0, 1, retained);
    const dispatch = vi.spyOn(plugin as never, "dispatchSyncRun")
      .mockResolvedValue({
        ...okResult(),
        success: false,
        errors: 1,
        mutationRecovery: {
          state: "blocked",
          total: 1,
          settled: 0,
          remaining: 1,
          retryAfterSeconds: null,
          blockReason: "facts-changed",
          blockedOperationId: retained.intent.operationId,
          isolated: true,
        },
      });
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);

    await plugin.resetSyncState();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(confirmModalAwaitConfirm).not.toHaveBeenCalled();
    expect(forceReset).not.toHaveBeenCalled();
    expect(resetPreservingIsolatedMutationRecovery).toHaveBeenCalledOnce();
  });


  it("conservatively resets unrelated state after one ordinary file is precisely isolated", async () => {
    const plugin = makePlugin();
    const {
      state,
      reset,
      resetPreservingIsolatedMutationRecovery,
      clearScanCache,
      saveSyncSettings,
    } = attachResetRecoveryHarness(plugin);
    const retained = {
      intent: {
        version: 1 as const,
        operationId: "pending",
        planRevision: 1,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "root",
        },
        action: "upload" as const,
        path: "notes/a.md",
        expectedLocal: {
          exists: true as const,
          hash: "aa".repeat(32),
          size: 3,
        },
        expectedRemote: {
          exists: true as const,
          driveId: "remote-a",
          eTag: "etag-a",
          size: 3,
          sha256Hash: "aa".repeat(32),
        },
        createdAt: 1,
      },
      receipt: null,
    };
    state.mutationLedger.splice(0, 1, retained);
    const dispatch = vi.spyOn(plugin as never, "dispatchSyncRun")
      .mockResolvedValue({
        ...okResult(),
        success: false,
        errors: 1,
        mutationRecovery: {
          state: "blocked",
          total: 1,
          settled: 0,
          remaining: 1,
          retryAfterSeconds: null,
          blockReason: "facts-changed",
          blockedOperationId: retained.intent.operationId,
          isolated: true,
        },
      });

    await plugin.resetSyncState();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(resetPreservingIsolatedMutationRecovery)
      .toHaveBeenCalledOnce();
    expect(resetPreservingIsolatedMutationRecovery)
      .toHaveBeenCalledWith([retained]);
    expect(state.mutationLedger).toEqual([retained]);
    expect(clearScanCache).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
  });

  it("keeps exact recovery evidence when the conservative reset capsule cannot be proven", async () => {
    const plugin = makePlugin();
    const {
      state,
      reset,
      resetPreservingIsolatedMutationRecovery,
      clearScanCache,
      saveSyncSettings,
    } = attachResetRecoveryHarness(plugin);
    resetPreservingIsolatedMutationRecovery.mockRejectedValue(
      new ConservativeResetBlockedError(
        "missing committed identity capsule",
      ),
    );
    const show = vi.fn();
    plugin.noticeCenter = {
      activeKey: null,
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "dispatchSyncRun").mockResolvedValue({
      ...okResult(),
      success: false,
      errors: 1,
      mutationRecovery: {
        state: "blocked",
        total: 1,
        settled: 0,
        remaining: 1,
        retryAfterSeconds: null,
        blockReason: "facts-changed",
        blockedOperationId: "pending",
        isolated: true,
      },
    });

    await expect(plugin.resetSyncState()).resolves.toBeUndefined();

    expect(reset).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(clearScanCache).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-mutation-recovery-blocked",
    }));
    expect(plugin.diag.warn).toHaveBeenCalledWith(
      "state",
      "conservative local reset kept unresolved recovery evidence",
      "missing committed identity capsule",
    );
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("reports a reset failure when conservative state maintenance I/O fails", async () => {
    const plugin = makePlugin();
    const {
      state,
      reset,
      resetPreservingIsolatedMutationRecovery,
      clearScanCache,
      saveSyncSettings,
    } = attachResetRecoveryHarness(plugin);
    resetPreservingIsolatedMutationRecovery.mockRejectedValue(
      new Error("IndexedDB commit failed"),
    );
    const show = vi.fn();
    plugin.noticeCenter = {
      activeKey: null,
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    vi.spyOn(plugin as never, "dispatchSyncRun").mockResolvedValue({
      ...okResult(),
      success: false,
      errors: 1,
      mutationRecovery: {
        state: "blocked",
        total: 1,
        settled: 0,
        remaining: 1,
        retryAfterSeconds: null,
        blockReason: "facts-changed",
        blockedOperationId: "pending",
        isolated: true,
      },
    });

    await expect(plugin.resetSyncState()).resolves.toBeUndefined();

    expect(reset).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(clearScanCache).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-failed",
    }));
    expect(show).not.toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-mutation-recovery-blocked",
    }));
    expect(plugin.diag.error).toHaveBeenCalledWith(
      "state",
      "local sync state reset failed",
      expect.objectContaining({ message: "IndexedDB commit failed" }),
    );
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("keeps recovery evidence and reset retryable when account verification fails", async () => {
    const plugin = makePlugin();
    const { state, reset } = attachResetRecoveryHarness(plugin);
    const show = vi.fn();
    plugin.noticeCenter = {
      activeKey: null,
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    vi.mocked(
      (plugin as never as {
        checkAccountBinding: () => Promise<boolean>;
      }).checkAccountBinding,
    ).mockRejectedValue(new Error("account lookup failed"));
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    confirmModalAwaitConfirm.mockResolvedValueOnce(false);

    await expect(plugin.resetSyncState()).resolves.toBeUndefined();

    expect(reset).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(plugin.diag.warn).toHaveBeenCalledWith(
      "execute",
      "reset preflight mutation recovery failed",
      "account lookup failed",
    );
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("invalidates the shared lifecycle before logging out", async () => {
    const plugin = makePlugin();
    const invalidateLifecycle = vi.fn();
    const logout = vi.fn().mockResolvedValue(undefined);
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      invalidateLifecycle,
    } as never;
    plugin.auth = { logout } as never;

    await plugin.logoutUser();

    expect(invalidateLifecycle).toHaveBeenCalledWith("logout");
    expect(invalidateLifecycle.mock.invocationCallOrder[0]).toBeLessThan(logout.mock.invocationCallOrder[0]);
  });

  it("invalidates in-flight work and closes the UI side-action gateway on unload", async () => {
    const plugin = makePlugin();
    const invalidateLifecycle = vi.fn();
    plugin.syncExecutor = { invalidateLifecycle } as never;
    plugin.diag = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as never;

    plugin.onunload();

    expect(invalidateLifecycle).toHaveBeenCalledWith("unload");
    expect(plugin.syncExecutor).toBeNull();
    await expect(plugin.resolveConflictKeepLocal("note.md")).resolves.toBe(false);
  });

  it("does not pause auto sync when every failure is a community-plugin identity block", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      errors: 3,
      identityBlockedErrors: 3,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps pausing auto sync when identity blocks are mixed with ordinary failures", async () => {
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    const stopAutoSync = vi.spyOn(plugin, "stopAutoSync").mockImplementation(() => undefined);
    const startAutoSync = vi.spyOn(plugin, "startAutoSync").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);

    await (plugin as never as {
      handleSyncResult: (result: SyncResult, mode: "auto") => Promise<void>;
    }).handleSyncResult({
      ...okResult(),
      success: false,
      errors: 3,
      identityBlockedErrors: 1,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps a participating plugin out of the dedicated cloud cleanup", async () => {
    const plugin = makePlugin();
    attachParticipationState(plugin, participating());
    const runCommunityPluginCloudCleanup = vi.fn();
    plugin.syncExecutor = {
      isRunning: false,
      runCommunityPluginCloudCleanup,
    } as never;
    plugin.noticeCenter = {
      show: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(false);
    expect(runCommunityPluginCloudCleanup).not.toHaveBeenCalled();
  });

  it("lets a never-participated device run the dedicated cloud cleanup", async () => {
    const plugin = makePlugin();
    attachParticipationState(
      plugin,
      reduceDeviceCommunityPluginParticipation(
        createEmptyDeviceCommunityPluginParticipation(true),
        { type: "mark-never-participated", pluginId: "calendar" },
      ),
    );
    const runCommunityPluginCloudCleanup = vi.fn().mockResolvedValue({
      status: "completed",
      deleted: 3,
    });
    plugin.syncExecutor = {
      isRunning: false,
      runCommunityPluginCloudCleanup,
    } as never;
    const show = vi.fn();
    plugin.noticeCenter = {
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue(null);
    plugin.app.saveLocalStorage = vi.fn() as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(true);
    expect(runCommunityPluginCloudCleanup).toHaveBeenCalledWith("calendar");
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "cloud-cleanup:done:calendar",
    }));
  });

  it("exposes persisted cloud-cleanup markers for the settings UI", () => {
    const plugin = makePlugin();
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 123 },
    ]);
    plugin.app.saveLocalStorage = vi.fn() as never;
    expect((plugin as never as {
      getCommunityPluginCloudCleanupMarkers(): readonly {
        pluginId: string;
        cleanedAt: number;
      }[];
    }).getCommunityPluginCloudCleanupMarkers()).toEqual([
      { pluginId: "calendar", cleanedAt: 123 },
    ]);
  });

  it("cleans an exited plugin through the dedicated transaction and records a marker", async () => {
    const plugin = makePlugin();
    attachParticipationState(
      plugin,
      reduceDeviceCommunityPluginParticipation(
        createEmptyDeviceCommunityPluginParticipation(true),
        { type: "confirm-excluded", pluginId: "calendar" },
      ),
    );
    const runCommunityPluginCloudCleanup = vi.fn().mockResolvedValue({
      status: "completed",
      deleted: 2,
    });
    plugin.syncExecutor = {
      isRunning: false,
      runCommunityPluginCloudCleanup,
    } as never;
    const show = vi.fn();
    plugin.noticeCenter = {
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue(null);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(true);
    expect(runCommunityPluginCloudCleanup).toHaveBeenCalledWith("calendar");
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "cloud-cleanup:done:calendar",
    }));
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [{ pluginId: "calendar", cleanedAt: expect.any(Number) }],
    );
  });

  it("removes a cleaned plugin from both sides of the local sync policy (thorough removal)", async () => {
    const plugin = makePlugin();
    attachParticipationState(
      plugin,
      reduceDeviceCommunityPluginParticipation(
        createEmptyDeviceCommunityPluginParticipation(true),
        { type: "mark-never-participated", pluginId: "calendar" },
      ),
    );
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: { mode: "selected", pluginIds: ["calendar", "other"] },
      data: { mode: "selected", pluginIds: ["calendar"] },
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      runCommunityPluginCloudCleanup: vi.fn().mockResolvedValue({
        status: "completed",
        deleted: 3,
      }),
    } as never;
    plugin.noticeCenter = {
      show: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue(null);
    plugin.app.saveLocalStorage = vi.fn() as never;
    const updateSyncPathSettings = vi.fn().mockResolvedValue(undefined);
    plugin.updateSyncPathSettings = updateSyncPathSettings as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(true);
    expect(updateSyncPathSettings).toHaveBeenCalledTimes(1);
    const patch = updateSyncPathSettings.mock.calls[0][0] as {
      communityPluginSyncPolicy: {
        files: { pluginIds: string[] };
        data: { pluginIds: string[] };
      };
    };
    expect(patch.communityPluginSyncPolicy.files.pluginIds)
      .toEqual(["other"]);
    expect(patch.communityPluginSyncPolicy.data.pluginIds).toEqual([]);
  });

  it("notices once when a cleaned plugin reappears on the cloud", () => {
    const plugin = makePlugin();
    const state = {
      isV2StateActive: true,
      remoteSnapshot: [{
        path: ".obsidian/plugins/calendar/main.js",
        driveId: "main-id",
        parentId: "parent",
        size: 10,
        mtime: 1,
        eTag: "etag",
      }],
      getCommunityPluginParticipation: vi.fn().mockReturnValue(
        reduceDeviceCommunityPluginParticipation(
          createEmptyDeviceCommunityPluginParticipation(true),
          { type: "confirm-excluded", pluginId: "calendar" },
        ),
      ),
    };
    plugin.state = state as never;
    const show = vi.fn();
    plugin.noticeCenter = {
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 123 },
    ]);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;

    (plugin as never as {
      maybeNoticeCommunityPluginCloudResurrection(): void;
    }).maybeNoticeCommunityPluginCloudResurrection();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "cloud-cleanup:resurrected:calendar",
    }));
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [],
    );
  });

  it("keeps the marker when the cleaned plugin stays absent", () => {
    const plugin = makePlugin();
    const state = {
      isV2StateActive: true,
      remoteSnapshot: [],
      getCommunityPluginParticipation: vi.fn().mockReturnValue(
        reduceDeviceCommunityPluginParticipation(
          createEmptyDeviceCommunityPluginParticipation(true),
          { type: "confirm-excluded", pluginId: "calendar" },
        ),
      ),
    };
    plugin.state = state as never;
    const show = vi.fn();
    plugin.noticeCenter = {
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    const marker = { pluginId: "calendar", cleanedAt: 123 };
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([marker]);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;

    (plugin as never as {
      maybeNoticeCommunityPluginCloudResurrection(): void;
    }).maybeNoticeCommunityPluginCloudResurrection();

    expect(show).not.toHaveBeenCalled();
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [marker],
    );
  });
});
