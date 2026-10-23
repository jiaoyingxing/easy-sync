// 社区插件云端清理与轮末接收
// 由 tests/main-sync-entry.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
// vi.mock 不能跨文件继承，故各主题文件各自保留同一份 mock 前置块。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationV1,
} from "../src/sync/community-plugin-participation";
import { createEmptyCommunityPluginAdoptionMemory } from "../src/sync/community-plugin-adoption-memory";
import {
  okResult,
  makePlugin,
  attachParticipationState,
  participating,
  COMMUNITY_PLUGIN_SCOPE,
} from "./helpers/main-sync-entry-harness";

const confirmModalAwaitConfirm = vi.hoisted(() => vi.fn());
const scopeCrossingPromptAwaitChoice = vi.hoisted(() => vi.fn());
const scopeCrossingPromptMockArgs = vi.hoisted(() => [] as unknown[][]);

vi.mock("../src/auth/auth-module", () => ({
  AuthModule: class {
    authState = null;
    isInitializing = true;
    onStateChange = vi.fn();
    initialize = vi.fn().mockResolvedValue(undefined);
    getAccessToken = vi.fn().mockResolvedValue("token");
    checkDeviceCodeNow = vi.fn().mockResolvedValue(undefined);
    refreshNowIfNeeded = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../src/onedrive/client", () => ({
  OneDriveClient: class {},
}));

vi.mock("../src/sync/local-scanner", async () => {
  const actual = await vi.importActual<typeof import("../src/sync/local-scanner")>(
    "../src/sync/local-scanner",
  );
  return {
    LocalScanner: class {
      setDiag = vi.fn();
      setConfig = vi.fn();
    },
    createFolderSyncScopeSnapshotV1: () => ({
      version: 1,
      includedPaths: [],
      excludedFolders: [],
    }),
    // 内部路径判定取真实现：这条规则带配置目录与插件 ID 参数、覆盖
    // tmp / 状态文件 / 恢复副本整族，替身抄一份必然随规则漂移。
    isEasySyncInternalPath: actual.isEasySyncInternalPath,
    normalizeExcludedFolders: (paths: unknown[]) => paths.filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    ),
  };
});

vi.mock("../src/sync/state-manager", () => ({
  StateManager: class {
    isV2StateActive = false;
    v2StateLoadRecoveryBlock = null;
    planReviewActive = false;
    confirmedDescendantFileReconstruction = false;
    remoteSnapshot: unknown[] = [];
    remoteFolders: unknown[] = [];
    mutationLedger: unknown[] = [];
    close = vi.fn().mockResolvedValue(undefined);
    resetCircuitBreakers = vi.fn().mockResolvedValue(undefined);
  },
  SyncPathMutationRecoveryError: class extends Error {},
  ConservativeResetBlockedError: class extends Error {},
}));

vi.mock("../src/sync/diagnostic-logger", () => ({
  DiagnosticLogger: class {
    log = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    setAdapter = vi.fn();
    enableAll = vi.fn();
    clear = vi.fn();
    forceFlush = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../src/ui/settings-tab", () => ({
  EasySyncSettingTab: class {},
}));

vi.mock("../src/ui/sync-view", async () => {
  const actual = await vi.importActual<typeof import("../src/ui/sync-view")>(
    "../src/ui/sync-view",
  );
  return {
    SYNC_VIEW_TYPE: actual.SYNC_VIEW_TYPE,
    // 「计划已变、需要重建审阅」这条判定取真实现：替身抄的是同一算式，
    // 但它属于视图层不变量，抄一份就多一处会漂移的副本。
    shouldAutoRebuildPlanReview: actual.shouldAutoRebuildPlanReview,
    EasySyncSyncView: class {
      render = vi.fn();
    },
  };
});

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
  SyncPlanAlertModal: class {
    open = vi.fn();
  },
}));

vi.mock("../src/ui/scope-crossing-prompt-modal", () => ({
  ScopeCrossingPromptModal: class {
    awaitChoice = scopeCrossingPromptAwaitChoice;
    constructor(...args: unknown[]) {
      scopeCrossingPromptMockArgs.push(args);
    }
  },
}));

describe("main sync entry guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    confirmModalAwaitConfirm.mockReset();
    confirmModalAwaitConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  function attachFreshCleanupCatalog(plugin: ReturnType<typeof makePlugin>): void {
    plugin.refreshCommunityPluginRemoteCatalog = vi.fn().mockResolvedValue({
      version: 1,
      complete: true,
      stale: false,
      revision: 5,
      observedAt: 1,
      sourceDigest: "a".repeat(64),
      scope: {},
      entries: [{
        pluginId: "calendar",
        bundleState: "complete",
        bundleDigest: "b".repeat(64),
        members: [{
          path: ".obsidian/plugins/calendar/main.js",
          remoteId: "id:main",
          parentId: "folder",
          size: 10,
          mtime: 1,
          eTag: "etag:main",
          cTag: "ctag:main",
          sha256Hash: null,
          quickXorHash: null,
        }],
      }],
    });
  }

  it("lets a never-participated device run the dedicated cloud cleanup", async () => {
    const plugin = makePlugin();
    attachParticipationState(
      plugin,
      {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "never-participated" },
        },
      },
    );
    attachFreshCleanupCatalog(plugin);
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
    const startJoinNow = vi.fn();
    plugin.startCommunityPluginJoinNow = startJoinNow as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(true);
    expect(runCommunityPluginCloudCleanup).toHaveBeenCalledWith(
      "calendar",
      { entries: [expect.objectContaining({
        path: ".obsidian/plugins/calendar/main.js",
        driveId: "id:main",
      })] },
    );
    expect(startJoinNow).toHaveBeenCalledTimes(1);

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "cloud-cleanup:done:calendar",
    }));
  });

  it("stops before planning when no fresh catalog evidence is available", async () => {
    const plugin = makePlugin();
    attachParticipationState(
      plugin,
      {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "never-participated" },
        },
      },
    );
    plugin.refreshCommunityPluginRemoteCatalog = vi.fn().mockRejectedValue(
      new Error("delta unavailable"),
    );
    const runCommunityPluginCloudCleanup = vi.fn();
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
    const startJoinNow = vi.fn();
    plugin.startCommunityPluginJoinNow = startJoinNow as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(false);
    expect(runCommunityPluginCloudCleanup).not.toHaveBeenCalled();
    expect(startJoinNow).not.toHaveBeenCalled();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "cloud-cleanup:failed:calendar",
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

  it("drops duplicate cleanup markers silently when the complete bundle reappears", () => {
    const plugin = makePlugin();
    plugin.state = {
      isV2StateActive: true,
      getCommunityPluginParticipation: vi.fn(() => ({
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "excluded" },
        },
      })),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 1 },
      { pluginId: "calendar", cleanedAt: 2 },
    ]);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    const catalog = {
      version: 1,
      complete: true,
      stale: false,
      revision: 5,
      observedAt: 1,
      sourceDigest: "a".repeat(64),
      scope: {},
      entries: [{
        pluginId: "calendar",
        bundleState: "complete",
        bundleDigest: "b".repeat(64),
        members: [],
      }],
    };
    (plugin as never as {
      sweepCommunityPluginCloudCleanupMarkers(
        reappearedPluginIds: readonly string[],
      ): void;
    }).sweepCommunityPluginCloudCleanupMarkers(["calendar"]);
    // No dedicated reappearance notice (2026-09-09 用户拍板): the row simply
    // un-hides on the next refresh.
    expect(show).not.toHaveBeenCalled();
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [],
    );
  });

  it("keeps the marker while the bundle stays gone; drops it on reappearance regardless of phase", () => {
    const completeCalendarCatalog = {
      version: 1,
      complete: true,
      stale: false,
      revision: 5,
      observedAt: 1,
      sourceDigest: "a".repeat(64),
      scope: {},
      entries: [{
        pluginId: "calendar",
        bundleState: "complete",
        bundleDigest: "b".repeat(64),
        members: [],
      }],
    };
    // Gone: excluded phase but no complete bundle in the catalog.
    const gone = makePlugin();
    gone.state = {
      isV2StateActive: true,
      getCommunityPluginParticipation: vi.fn(() => ({
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "excluded" },
        },
      })),
    } as never;
    gone.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 1 },
    ]);
    const saveGone = vi.fn();
    gone.app.saveLocalStorage = saveGone as never;
    const showGone = vi.fn();
    gone.noticeCenter = {
      show: showGone,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    const emptyCatalog = {
      version: 1,
      complete: true,
      stale: false,
      revision: 5,
      observedAt: 1,
      sourceDigest: "a".repeat(64),
      scope: {},
      entries: [],
    };
    (gone as never as {
      sweepCommunityPluginCloudCleanupMarkers(
        reappearedPluginIds: readonly string[],
      ): void;
    }).sweepCommunityPluginCloudCleanupMarkers([]);
    expect(showGone).not.toHaveBeenCalled();
    expect(saveGone).not.toHaveBeenCalled();
    // Participating: the bundle is back — the marker is dead weight there
    // (hiding requires no local files, and an explicit re-join clears the
    // marker too), so the sweep drops it instead of leaving an orphan.
    const active = makePlugin();
    active.state = {
      isV2StateActive: true,
      getCommunityPluginParticipation: vi.fn(() => ({
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "participating" },
        },
      })),
    } as never;
    active.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 1 },
    ]);
    const saveActive = vi.fn();
    active.app.saveLocalStorage = saveActive as never;
    (active as never as {
      sweepCommunityPluginCloudCleanupMarkers(
        reappearedPluginIds: readonly string[],
      ): void;
    }).sweepCommunityPluginCloudCleanupMarkers(["calendar"]);
    expect(saveActive).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [],
    );
  });

  it("un-hides a cleaned plugin whose complete bundle reappears in the fresh delta catalog — silently", () => {
    const plugin = makePlugin();
    plugin.state = {
      isV2StateActive: true,
      getCommunityPluginParticipation: vi.fn(() => ({
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "excluded" },
        },
      })),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 1 },
    ]);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    const catalog = {
      version: 1,
      complete: true,
      stale: false,
      revision: 5,
      observedAt: 1,
      sourceDigest: "a".repeat(64),
      scope: {},
      entries: [{
        pluginId: "calendar",
        bundleState: "complete",
        bundleDigest: "b".repeat(64),
        members: [],
        manifestName: "Calendar",
      }],
    };
    (plugin as never as {
      sweepCommunityPluginCloudCleanupMarkers(
        reappearedPluginIds: readonly string[],
      ): void;
    }).sweepCommunityPluginCloudCleanupMarkers(["calendar"]);
    // The reappearance un-hides the row without any dedicated notice.
    expect(show).not.toHaveBeenCalled();
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [],
    );
  });

  it("keeps the marker when the fresh catalog only lists the plugin as partial", () => {
    const plugin = makePlugin();
    plugin.state = {
      isV2StateActive: true,
      getCommunityPluginParticipation: vi.fn(() => ({
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "excluded" },
        },
      })),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 1 },
    ]);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    const catalog = {
      version: 1,
      complete: true,
      stale: false,
      revision: 5,
      observedAt: 1,
      sourceDigest: "a".repeat(64),
      scope: {},
      entries: [{
        pluginId: "calendar",
        bundleState: "partial",
        bundleDigest: "b".repeat(64),
        members: [],
      }],
    };
    (plugin as never as {
      sweepCommunityPluginCloudCleanupMarkers(
        reappearedPluginIds: readonly string[],
      ): void;
    }).sweepCommunityPluginCloudCleanupMarkers([]);
    expect(show).not.toHaveBeenCalled();
    expect(saveLocalStorage).not.toHaveBeenCalled();
  });

  it("drops the cleanup marker when the user explicitly re-joins the plugin", () => {
    const plugin = makePlugin();
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", cleanedAt: 1 },
      { pluginId: "other", cleanedAt: 2 },
    ]);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;
    (plugin as never as {
      clearCommunityPluginCloudCleanupMarker(pluginId: string): void;
    }).clearCommunityPluginCloudCleanupMarker("calendar");
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [{ pluginId: "other", cleanedAt: 2 }],
    );
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
    attachFreshCleanupCatalog(plugin);
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
    const startJoinNow = vi.fn();
    plugin.startCommunityPluginJoinNow = startJoinNow as never;
    const commitParticipation = vi.fn().mockResolvedValue(undefined);
    plugin.commitCommunityPluginParticipationCommand =
      commitParticipation as never;
    const persistAdoption = vi.fn().mockResolvedValue(undefined);
    plugin.persistCommunityPluginAdoptionCommand = persistAdoption as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(true);
    expect(runCommunityPluginCloudCleanup).toHaveBeenCalledWith(
      "calendar",
      { entries: [expect.objectContaining({ driveId: "id:main" })] },
    );
    expect(commitParticipation).toHaveBeenCalledWith({
      type: "confirm-excluded",
      pluginId: "calendar",
    });
    expect(persistAdoption).toHaveBeenCalledWith({
      type: "remove-pending",
      pluginId: "calendar",
    });
    expect(startJoinNow).toHaveBeenCalledTimes(1);

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "cloud-cleanup:done:calendar",
    }));
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [{ pluginId: "calendar", cleanedAt: expect.any(Number) }],
    );
  });

  it("keeps a successful cleanup when the participation exit fails afterwards", async () => {
    const plugin = makePlugin();
    attachParticipationState(
      plugin,
      reduceDeviceCommunityPluginParticipation(
        createEmptyDeviceCommunityPluginParticipation(true),
        { type: "confirm-excluded", pluginId: "calendar" },
      ),
    );
    attachFreshCleanupCatalog(plugin);
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
    plugin.commitCommunityPluginParticipationCommand = vi.fn()
      .mockRejectedValue(new Error("busy")) as never;
    plugin.persistCommunityPluginAdoptionCommand = vi.fn()
      .mockRejectedValue(new Error("busy")) as never;
    plugin.diag = { warn: vi.fn() } as never;
    const startJoinNow = vi.fn();
    plugin.startCommunityPluginJoinNow = startJoinNow as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(true);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "cloud-cleanup:done:calendar",
    }));
    expect(startJoinNow).toHaveBeenCalledTimes(1);

    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-community-plugin-cloud-cleanup-v1",
      [{ pluginId: "calendar", cleanedAt: expect.any(Number) }],
    );
  });

  it("removes a cleaned plugin from both sides of the local sync policy (thorough removal)", async () => {
    const plugin = makePlugin();
    attachParticipationState(
      plugin,
      {
        schemaVersion: 1,
        kind: "device-community-plugin-participation",
        scopeEnabled: true,
        pluginsById: {
          calendar: { pluginId: "calendar", phase: "never-participated" },
        },
      },
    );
    plugin.communityPluginSyncPolicy = {
      version: 1,
      files: { mode: "selected", pluginIds: ["calendar", "other"] },
      data: { mode: "selected", pluginIds: ["calendar"] },
    } as never;
    attachFreshCleanupCatalog(plugin);
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
    const startJoinNow = vi.fn();
    plugin.startCommunityPluginJoinNow = startJoinNow as never;

    await expect(plugin.runCommunityPluginCloudCleanup("calendar"))
      .resolves.toBe(true);
    expect(updateSyncPathSettings).toHaveBeenCalledTimes(1);
    expect(startJoinNow).toHaveBeenCalledTimes(1);

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
      sweepCommunityPluginCloudCleanupMarkers(
        reappearedPluginIds: readonly string[],
      ): void;
    }).sweepCommunityPluginCloudCleanupMarkers([]);

    expect(show).not.toHaveBeenCalled();
    // Nothing changed: the marker stays persisted and no write is issued.
    expect(saveLocalStorage).not.toHaveBeenCalled();
  });

  it("notices once per plugin when an upload downgrade is deferred (A1)", () => {
    const plugin = makePlugin();
    const show = vi.fn();
    plugin.noticeCenter = {
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue(null);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;

    (plugin as never as {
      maybeNoticeCommunityPluginUploadDowngrades(
        deferred: readonly string[] | undefined,
      ): void;
    }).maybeNoticeCommunityPluginUploadDowngrades(["calendar"]);

    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "plugin-upload-downgrade:calendar",
    }));
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-upload-downgrade-notice-v1",
      [expect.objectContaining({ pluginId: "calendar" })],
    );

    // Second identical round: no repeat notice, marker retained.
    show.mockClear();
    saveLocalStorage.mockClear();
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", noticedAt: 123 },
    ]);
    (plugin as never as {
      maybeNoticeCommunityPluginUploadDowngrades(
        deferred: readonly string[] | undefined,
      ): void;
    }).maybeNoticeCommunityPluginUploadDowngrades(["calendar"]);

    expect(show).not.toHaveBeenCalled();
    expect(saveLocalStorage).not.toHaveBeenCalled();
  });

  it("retires the upload-downgrade marker once the deferral converges (A1)", () => {
    const plugin = makePlugin();
    const show = vi.fn();
    plugin.noticeCenter = {
      show,
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    plugin.app.loadLocalStorage = vi.fn().mockReturnValue([
      { pluginId: "calendar", noticedAt: 123 },
    ]);
    const saveLocalStorage = vi.fn();
    plugin.app.saveLocalStorage = saveLocalStorage as never;

    (plugin as never as {
      maybeNoticeCommunityPluginUploadDowngrades(
        deferred: readonly string[] | undefined,
      ): void;
    }).maybeNoticeCommunityPluginUploadDowngrades([]);

    expect(show).not.toHaveBeenCalled();
    expect(saveLocalStorage).toHaveBeenCalledWith(
      "easy-sync-upload-downgrade-notice-v1",
      [],
    );
  });
});

describe("round-end community-plugin adoption reconcile", () => {
  function calendarManifestText(): string {
    return JSON.stringify({
      id: "calendar",
      version: "2.0.0",
      name: "Calendar",
      isDesktopOnly: false,
    });
  }

  function committedPluginIndex(): {
    schemaVersion: 2;
    filesRootId: string;
    cursorRevision: number;
    deltaLink: null;
    complete: true;
    itemsById: Record<string, unknown>;
  } {
    const manifestBytes = new TextEncoder().encode(calendarManifestText());
    const file = (
      id: string,
      name: string,
      parentId: string,
      size: number,
    ) => ({
      id,
      parentId,
      name,
      kind: "file",
      size,
      mtime: 2,
      eTag: `etag-${id}`,
      cTag: `ctag-${id}`,
    });
    return {
      schemaVersion: 2,
      filesRootId: "files",
      cursorRevision: 0,
      deltaLink: null,
      complete: true,
      itemsById: {
        "obsidian-folder": {
          id: "obsidian-folder",
          parentId: "files",
          name: ".obsidian",
          kind: "folder",
        },
        "plugins-folder": {
          id: "plugins-folder",
          parentId: "obsidian-folder",
          name: "plugins",
          kind: "folder",
        },
        "calendar-folder": {
          id: "calendar-folder",
          parentId: "plugins-folder",
          name: "calendar",
          kind: "folder",
        },
        "calendar-main": file("calendar-main", "main.js", "calendar-folder", 4),
        "calendar-manifest": file(
          "calendar-manifest",
          "manifest.json",
          "calendar-folder",
          manifestBytes.byteLength,
        ),
        "calendar-styles": file(
          "calendar-styles",
          "styles.css",
          "calendar-folder",
          3,
        ),
      },
    };
  }

  function adoptionStateHarness(
    initial: ReturnType<typeof createEmptyCommunityPluginAdoptionMemory>,
  ) {
    let store = structuredClone(initial);
    const update = vi.fn(async (
      next: ReturnType<typeof createEmptyCommunityPluginAdoptionMemory>,
    ) => {
      store = structuredClone(next);
    });
    return {
      store: () => structuredClone(store),
      update,
    };
  }

  function makeRoundPlugin(
    memory: ReturnType<typeof createEmptyCommunityPluginAdoptionMemory>,
  ) {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    const memoryHarness = adoptionStateHarness(memory);
    const state = {
      isV2StateActive: true,
      remoteScope: COMMUNITY_PLUGIN_SCOPE,
      getCommunityPluginManifestObservations: vi.fn(() => []),
      setCommunityPluginManifestObservations: vi.fn().mockResolvedValue(
        undefined,
      ),
      getRemoteCommunityPluginCatalog: vi.fn(() => null),
      setRemoteCommunityPluginCatalog: vi.fn().mockResolvedValue(undefined),
      getCommittedRemoteIndex: () => committedPluginIndex(),
      getCommunityPluginAdoptionMemory: memoryHarness.store,
      updateCommunityPluginAdoptionMemory: memoryHarness.update,
    };
    plugin.state = state as never;
    plugin.onedrive = {
      downloadFile: vi.fn(async (
        _vault: string,
        path: string,
        _destination: unknown,
        _itemId: string,
        size: number,
      ) => {
        const bytes = path.endsWith("manifest.json")
          ? new TextEncoder().encode(calendarManifestText())
          : new Uint8Array(size);
        return bytes.buffer;
      }),
    } as never;
    (plugin as never as { syncCommunityPlugins: boolean }).syncCommunityPlugins
      = true;
    (plugin as never as { communityPluginParticipation: unknown })
      .communityPluginParticipation = createEmptyDeviceCommunityPluginParticipation(
        true,
      );
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    plugin.noticeCenter = {
      show: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      run: vi.fn().mockResolvedValue(okResult()),
    } as never;
    return { plugin, state, memoryHarness };
  }

  it("discovers a new complete bundle into pending rows and stays idempotent across rounds", async () => {
    const { plugin, memoryHarness } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(memoryHarness.store()).toEqual({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: [],
      pendingPluginIds: ["calendar"],
    });
    expect(memoryHarness.update).toHaveBeenCalledTimes(1);

    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });
    // The second settled round reconciles to the same set: no write.
    expect(memoryHarness.update).toHaveBeenCalledTimes(1);
  });

  it("does not propose a plugin whose local bundle is already complete", async () => {
    const { plugin, memoryHarness } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    // Calendar is installed on this device with its sync toggle off: the
    // adoption row's "not yet downloaded" premise is false, so the round-end
    // reconcile must keep it out of pending.
    plugin.app.vault.adapter.exists = vi.fn(async (path: string) =>
      path.endsWith("plugins/calendar/main.js")
      || path.endsWith("plugins/calendar/manifest.json"),
    );
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(memoryHarness.store()).toEqual({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: [],
      pendingPluginIds: [],
    });
    expect(memoryHarness.update).not.toHaveBeenCalled();
  });

  it("never re-proposes an ignored plugin and reconciles a joined plugin away", async () => {
    const { plugin, memoryHarness } = makeRoundPlugin({
      ...createEmptyCommunityPluginAdoptionMemory(),
      ignoredPluginIds: ["calendar"],
      pendingPluginIds: ["calendar"],
    });
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });

    // Ignored plugins are dropped from pending and stay suppressed.
    expect(memoryHarness.store()).toEqual({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: ["calendar"],
      pendingPluginIds: [],
    });
    expect(memoryHarness.update).toHaveBeenCalledTimes(1);
  });

  it("exposes pending rows and retires them via skip", async () => {
    const { plugin, memoryHarness } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });

    // No stored observation in this harness: the row falls back to the id.
    expect(plugin.getCommunityPluginAdoptionRows()).toEqual([{
      pluginId: "calendar",
      displayName: "calendar",
      desktopOnly: false,
    }]);

    await plugin.skipCommunityPluginAdoption("calendar");
    expect(memoryHarness.store()).toEqual({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: ["calendar"],
      pendingPluginIds: [],
    });
    expect(plugin.getCommunityPluginAdoptionRows()).toEqual([]);
  });

  it("download retires the row and takes the explicit join path once", async () => {
    const { plugin, memoryHarness } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });
    const join = vi.spyOn(
      plugin,
      "updateCommunityPluginFilesSelection",
    ).mockResolvedValue(undefined);

    await plugin.downloadCommunityPluginAdoption("calendar");

    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith("calendar", true);
    expect(memoryHarness.store()).toEqual({
      schemaVersion: 1,
      kind: "community-plugin-adoption-memory",
      ignoredPluginIds: [],
      pendingPluginIds: [],
    });
  });

  it("a failed download still retires the row and surfaces feedback", async () => {
    const { plugin, memoryHarness } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    const show = plugin.noticeCenter!.show as ReturnType<typeof vi.fn>;
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });
    vi.spyOn(
      plugin,
      "updateCommunityPluginFilesSelection",
    ).mockRejectedValue(new Error("network"));

    await plugin.downloadCommunityPluginAdoption("calendar");

    expect(memoryHarness.store().pendingPluginIds).toEqual([]);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "side-action:adoption:download-failed",
    }));
  });

  it("a failed row retirement still runs the join and keeps the row visible", async () => {
    const { plugin, state, memoryHarness } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });
    vi.spyOn(
      state,
      "updateCommunityPluginAdoptionMemory",
    ).mockRejectedValueOnce(new Error("disk"));
    const join = vi.spyOn(
      plugin,
      "updateCommunityPluginFilesSelection",
    ).mockResolvedValue(undefined);

    await plugin.downloadCommunityPluginAdoption("calendar");

    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith("calendar", true);
    expect(memoryHarness.store().pendingPluginIds).toEqual(["calendar"]);
  });

  it("a failed skip persist is silent and keeps the row", async () => {
    const { plugin, state, memoryHarness } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });
    vi.spyOn(
      state,
      "updateCommunityPluginAdoptionMemory",
    ).mockRejectedValueOnce(new Error("disk"));

    await expect(
      plugin.skipCommunityPluginAdoption("calendar"),
    ).resolves.toBeUndefined();

    expect(memoryHarness.store().pendingPluginIds).toEqual(["calendar"]);
    expect(memoryHarness.store().ignoredPluginIds).toEqual([]);
  });

  it("queues the adoption download behind an in-flight round instead of surfacing busy", async () => {
    const { plugin } = makeRoundPlugin(
      createEmptyCommunityPluginAdoptionMemory(),
    );
    const show = plugin.noticeCenter!.show as ReturnType<typeof vi.fn>;
    const join = vi.spyOn(
      plugin,
      "updateCommunityPluginFilesSelection",
    ).mockResolvedValue(undefined);
    const lock = plugin as never as {
      opLock: string | null;
      releaseOpLock(): void;
    };

    // A round holds the operation lock: the click must not bounce with the
    // busy notice — it waits and applies when the round releases.
    lock.opLock = "sync";
    const download = plugin.downloadCommunityPluginAdoption("calendar");
    await Promise.resolve();
    expect(join).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();

    lock.opLock = null;
    lock.releaseOpLock();
    await download;
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith("calendar", true);
  });
});