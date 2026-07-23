import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/auth/auth-module", () => ({
  AuthModule: class {},
}));

vi.mock("../src/onedrive/client", () => ({
  OneDriveClient: class {},
}));

vi.mock("../src/sync/local-scanner", () => ({
  LocalScanner: class {},
  isEasySyncInternalPath: (path: string) => path.includes("/.obsidian/plugins/easy-sync/tmp/")
    || path.startsWith(".obsidian/plugins/easy-sync/tmp/"),
  normalizeExcludedFolders: (paths: unknown[]) => paths.filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  ),
}));

vi.mock("../src/sync/sync-engine", () => ({
  SyncEngine: class {},
}));

vi.mock("../src/sync/state-manager", () => ({
  StateManager: class {},
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
  ConfirmModal: class {},
  SyncPlanAlertModal: class {},
}));

import EasySyncPlugin from "../src/main";
import type { SyncCallbacks, SyncResult } from "../src/sync/sync-executor";
import type { SyncPlan } from "../src/sync/types";

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
  vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
  vi.spyOn(plugin as never, "handleSyncResult").mockResolvedValue(undefined);
  plugin.diag = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
  plugin.scanner = {
    shouldSyncPath: vi.fn((path: string) => !path.startsWith(".obsidian/plugins/easy-sync/tmp/")),
  } as never;
  return plugin;
}

describe("main sync entry guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("keeps automatic sync active when an in-flight file was safely deferred", async () => {
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
      deferred: 1,
      message: "result.deferred",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).toHaveBeenCalledOnce();
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
      planReviewAuthorization: authorization,
      clearPlanReview,
    } as never;
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

    await plugin.executePlanReview();

    expect(clearPlanReview).not.toHaveBeenCalled();
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

    await plugin.resetSyncState();

    expect(invalidateLifecycle).toHaveBeenCalledWith("reset");
    expect(invalidateLifecycle.mock.invocationCallOrder[0]).toBeLessThan(reset.mock.invocationCallOrder[0]);
    expect(clearScanCache).toHaveBeenCalledOnce();
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
});
