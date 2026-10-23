// 手动同步、提示面、计划审阅与侧栏动作
// 由 tests/main-sync-entry.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
// vi.mock 不能跨文件继承，故各主题文件各自保留同一份 mock 前置块。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import type { SyncCallbacks, SyncResult } from "../src/sync/sync-executor";
import {
  ConservativeResetBlockedError,
  type SyncHistoryEntry,
} from "../src/sync/state-manager";
import { SyncActionType, type SyncPlan } from "../src/sync/types";
import { NOTICE_PRIORITY } from "../src/ui/notice-center";
import {
  okResult,
  makePlugin,
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

  it("shows only the threshold-skipped summary when an automatic run proceeded past the gate and completed (direction 3 wiring + 2026-09-15 减负 R-7)", async () => {
    // The executor records thresholdSkippedInAuto on runFacts; finishSyncNotice
    // must show the one-line summary INSTEAD of the completed notice — the
    // previous double-show made completed flash and get replaced downstream.
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

    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:threshold-skipped-auto",
      message: "notice.sync.thresholdSkippedInAuto",
      priority: NOTICE_PRIORITY.info,
      category: "ambient",
    }));
  });

  it("keeps the outcome notice plus the threshold summary for non-completed outcomes (R-7 merges only the completed double-show)", async () => {
    const plugin = makePlugin();
    plugin.app = { workspace: { leftSplit: undefined } } as never;
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    plugin.i18n = { t: (key: string) => key } as never;

    (plugin as never as { finishSyncNotice: (result: SyncResult) => void })
      .finishSyncNotice({
        ...okResult(),
        success: false,
        runFacts: {
          termination: "normal",
          ordinaryPlanning: "entered",
          userFileChanges: "none",
          thresholdSkippedInAuto: true,
        },
      });

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:failed",
    }));
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:threshold-skipped-auto",
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

  it("gives one-shot busy feedback instead of a silent return on manual sync", async () => {
    const plugin = makePlugin();
    const run = vi.fn();
    plugin.syncExecutor = { isRunning: true, run } as never;
    plugin.state = { planReviewActive: true } as never;
    const show = vi.fn();
    plugin.noticeCenter = { show, clear: vi.fn(), dispose: vi.fn() } as never;
    (plugin as never as { acquireOpLock: (name: string) => string | null })
      .acquireOpLock("recovery");

    await plugin.startManualSync();

    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]?.[0]).toMatchObject({ key: "sync-busy-hint" });
    expect(run).not.toHaveBeenCalled();
    expect((plugin as never as { opLock: string | null }).opLock).toBe("recovery");
  });

  it("renders the sidebar when a file completes so rows do not lag one item behind", () => {
    const plugin = makePlugin();
    const render = vi.fn();
    vi.spyOn(plugin, "syncView", "get").mockReturnValue({ render } as never);

    (plugin as never as {
      handleFileComplete: (
        path: string,
        actionType: SyncActionType,
        success: boolean,
      ) => void;
    }).handleFileComplete("Notes/A.md", SyncActionType.Upload, true);

    expect(render).toHaveBeenCalledOnce();
    expect(plugin.progressStore.state.completedFiles).toHaveLength(1);
  });

  it("coalesces status bar refreshes into one frame", async () => {
    const plugin = makePlugin();
    const doUpdate = vi.spyOn(plugin as never, "doUpdateStatusBar")
      .mockImplementation(() => undefined);

    plugin.updateStatusBar();
    plugin.updateStatusBar();
    plugin.updateStatusBar();

    await vi.waitFor(() => {
      expect(doUpdate).toHaveBeenCalled();
    }, { timeout: 5_000, interval: 16 });
    expect(doUpdate).toHaveBeenCalledOnce();
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
      message: "result.remoteReadUnavailable",
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
      message: "result.remoteReadUnavailable",
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
        message: "result.remoteReadUnavailable",
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
      message: "result.remoteReadUnavailable",
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
      message: "result.remoteReadUnavailable",
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
      message: "result.remoteReadUnavailable",
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

  it("falls back to ordinary handling when an isolated recovery coexists with deferred items", async () => {
    // 隔离"安静支路"要求 deferred === 0（无待办遗留才由它收尾）：有延后项时
    // 走普通轮收尾——不接管暂停、也不解除既有暂停，且不吞掉轮次提示。
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = true;
    plugin.state = {
      planReviewActive: false,
      syncHistory: [],
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
    } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    const finishSyncNotice = vi.spyOn(plugin as never, "finishSyncNotice")
      .mockImplementation(() => undefined);
    const clearSyncLifecycleNotice = vi.spyOn(plugin as never, "clearSyncLifecycleNotice")
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
      deferred: 1,
      message: "result.deferred",
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

    expect(finishSyncNotice).toHaveBeenCalledOnce();
    expect(clearSyncLifecycleNotice).not.toHaveBeenCalled();
    expect((plugin as never as {
      mutationRecoveryBlockReason: string | null;
    }).mutationRecoveryBlockReason).toBeNull();
    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps a mixed failing round on the ordinary path even when recovery isolated a record", async () => {
    // S2 反向控制项②：新通道只决定「哪些记录可被记录级冻结」，不许把一个
    // 仍然失败的轮次洗成隔离安静支路。隔离支路的条件是 errors === 0；本轮
    // 带着 errors: 1 与隔离记录 ⇒ 落回普通轮的暂停门（错误的非豁免族仍然
    // 暂停自动同步），而不是隔离支路的「不暂停并继续」。
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = {
      planReviewActive: false,
      syncHistory: [],
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
    } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    const finishSyncNotice = vi.spyOn(plugin as never, "finishSyncNotice")
      .mockImplementation(() => undefined);
    const clearSyncLifecycleNotice = vi.spyOn(plugin as never, "clearSyncLifecycleNotice")
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
    }, "manual");

    // The isolated quiet branch did not claim the round …
    expect(clearSyncLifecycleNotice).not.toHaveBeenCalled();
    expect((plugin as never as {
      mutationRecoveryBlockReason: string | null;
    }).mutationRecoveryBlockReason).toBeNull();
    // … the ordinary pause gate did, exactly as for any failing round.
    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
    expect(finishSyncNotice).toHaveBeenCalledOnce();
  });

  it("reports an active automatic pause instead of a network wait, and keeps the network form when nothing is paused", () => {
    const plugin = new EasySyncPlugin();
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
      mutationRecoveryQuarantine: [],
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      syncHistory: [],
    } as never;
    const stub = {
      snapshot: {
        state: "exhausted" as const,
        automaticObservations: 5,
        nextObservationAt: null,
      },
    };
    (plugin as never as { mutationRecoveryScheduler: typeof stub })
      .mutationRecoveryScheduler = stub;

    // A pause silences every automatic entry, so even an exhausted scheduler
    // must not be presented as "it will try again once the network is back"
    // (2026-10-13 field case: ten days of a paused record reading as a
    // network wait).
    plugin.autoSyncPaused = true;
    const paused = plugin.getMutationRecoveryDisplayState();
    expect(paused?.kind).toBe("blocked");
    // The reason chain decides whether the user gets an exit at all, so the
    // paused-without-recorded-reason shape must stay honest and closed rather
    // than claim a review that does not exist (2026-10-13 review finding).
    expect(paused?.blockReason).toBe("unknown");
    expect(paused?.manualResolutionAvailable).toBe(false);

    stub.snapshot = {
      state: "scheduled",
      automaticObservations: 1,
      nextObservationAt: Date.now() + 60_000,
    };
    expect(plugin.getMutationRecoveryDisplayState()?.kind).toBe("blocked");

    // A paused record whose persisted recovery row keeps a review-eligible
    // reason exposes the real exit — this is the state the field case could
    // never reach (2026-10-13 review finding).
    plugin.state.syncHistory = [{
      id: "mutation-recovery-1",
      mode: "auto",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      recovery: {
        state: "blocked",
        total: 1,
        settled: 0,
        remaining: 1,
        updatedAt: 2,
        blockReason: "facts-changed",
      },
    }] as never;
    plugin.syncExecutor = {
      canResolveMutationRecovery: (operationId?: string) => operationId === "pending",
    } as never;
    expect(plugin.getMutationRecoveryDisplayState()).toMatchObject({
      kind: "blocked",
      blockReason: "facts-changed",
      manualResolutionAvailable: true,
    });

    // Without a pause the scheduled retry keeps its network wording.
    plugin.autoSyncPaused = false;
    plugin.state.syncHistory = [] as never;
    plugin.syncExecutor = undefined as never;
    expect(plugin.getMutationRecoveryDisplayState()?.kind).toBe("waiting-network");
  });

  it("keeps the paused shape in the persisted recovery row when a retry is scheduled", async () => {
    const plugin = new EasySyncPlugin();
    const history: SyncHistoryEntry[] = [{
      id: "mutation-recovery-1",
      mode: "auto",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      recovery: {
        state: "blocked",
        total: 1,
        settled: 0,
        remaining: 1,
        updatedAt: 2,
        blockReason: "facts-changed",
      },
    }];
    const addSyncHistory = vi.fn().mockImplementation(async (
      entry: SyncHistoryEntry,
    ) => {
      history.splice(0, history.length, entry);
    });
    plugin.state = { syncHistory: history, addSyncHistory } as never;
    plugin.autoSyncPaused = true;
    (plugin as never as { updateStatusBar: unknown }).updateStatusBar = vi.fn();

    await (plugin as never as {
      handleMutationRecoverySchedulerState: (snapshot: {
        state: "scheduled";
        automaticObservations: number;
        nextObservationAt: number;
      }) => Promise<void>;
    }).handleMutationRecoverySchedulerState({
      state: "scheduled",
      automaticObservations: 1,
      nextObservationAt: Date.now() + 60_000,
    });

    // Scheduling a retry must not put the network wording back into the
    // persisted row while the pause silences that very retry.
    expect(history[0].recovery).toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
    });
    expect(history[0].recovery?.retryAt).toBeUndefined();
  });

  it("ends only a recovery-owned pause when a scheduled observation settles", async () => {
    const runOnce = async (recoveryRow: boolean) => {
      const plugin = makePlugin();
      plugin.syncInterval = 3;
      plugin.auth = { authState: { isLoggedIn: true } } as never;
      plugin._stateLoaded = true;
      plugin.autoSyncPaused = true;
      (plugin as never as { mutationRecoveryBlockReason: string | null })
        .mutationRecoveryBlockReason = recoveryRow ? "facts-changed" : null;
      plugin.state = {
        isV2StateActive: true,
        mutationLedger: [{
          intent: { operationId: "stuck", path: "notes/a.md" },
          receipt: null,
        }],
        planReviewActive: false,
        hasMutationLedgerCorruption: false,
        hasMutationRecoveryQuarantineCorruption: false,
        hasV2StateLoadRecoveryBlock: false,
        hasV2RemoteScopeRecovery: false,
        syncHistory: recoveryRow
          ? [{
              id: "mutation-recovery-1",
              mode: "auto",
              status: "partial",
              startedAt: 1,
              endedAt: 2,
              recovery: {
                state: "blocked",
                total: 1,
                settled: 0,
                remaining: 1,
                updatedAt: 2,
                blockReason: "facts-changed",
              },
            }]
          : [],
      } as never;
      plugin.syncExecutor = {
        canResolveMutationRecovery: () => false,
      } as never;
      const checkAccountBinding = vi.spyOn(plugin as never, "checkAccountBinding")
        .mockResolvedValue(true);
      (plugin as never as { dispatchSyncRun: unknown }).dispatchSyncRun =
        vi.fn().mockResolvedValue({
          success: true,
          errors: 0,
          mutationRecovery: {
            state: "settled",
            total: 1,
            settled: 1,
            remaining: 0,
            retryAfterSeconds: null,
          },
        });
      const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
        .mockResolvedValue(undefined);
      const startAutoSync = vi.spyOn(plugin, "startAutoSync")
        .mockImplementation(() => undefined);
      plugin.diag = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

      await (plugin as never as {
        runScheduledMutationRecoveryObservation: (args: {
          continuation: { settled: boolean; continueAfterIsolatedRecovery: boolean };
        }) => Promise<{ state: string }>;
      }).runScheduledMutationRecoveryObservation({
        continuation: { settled: false, continueAfterIsolatedRecovery: false },
      });

      return { plugin, checkAccountBinding, saveSyncSettings, startAutoSync };
    };

    // A pause a recovery block set is ended by the settling observation.
    const owned = await runOnce(true);
    expect(owned.checkAccountBinding).toHaveBeenCalled();
    expect(owned.plugin.autoSyncPaused).toBe(false);
    expect(owned.startAutoSync).toHaveBeenCalled();

    // A pause another cause owns (an incomplete or cancelled round) keeps its
    // own release rule: settling a record says nothing about that cause
    // (2026-10-13 review finding).
    const foreign = await runOnce(false);
    expect(foreign.plugin.autoSyncPaused).toBe(true);
    expect(foreign.saveSyncSettings).not.toHaveBeenCalled();
    expect(foreign.startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps the observation channel while any stuck record lacks a manual exit", () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin._stateLoaded = true;
    plugin.autoSyncPaused = true;
    plugin.state = {
      isV2StateActive: true,
      mutationLedger: [
        { intent: { operationId: "resolvable", path: "notes/a.md" }, receipt: null },
        { intent: { operationId: "stuck", path: ".obsidian/plugins/x/data.json" }, receipt: null },
      ],
      planReviewActive: false,
      syncHistory: [],
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      canResolveMutationRecovery: (operationId?: string) =>
        operationId === "resolvable",
    } as never;
    (plugin as never as { updateStatusBar: unknown }).updateStatusBar = vi.fn();
    vi.spyOn(plugin as never, "runScheduledMutationRecovery")
      .mockResolvedValue({ state: "inactive" });
    const request = (plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation.bind(plugin);

    // The first ledger row is manually resolvable, but the stuck one is not:
    // keying the gate on the wrong row would strand it without any channel
    // (2026-10-13 review finding).
    expect(request("mixed-ledger")).toBe(true);
    plugin.mutationRecoveryScheduler.cancel();

    // Every record resolvable: the user stays in charge, no observations.
    plugin.state.mutationLedger = [
      { intent: { operationId: "resolvable", path: "notes/a.md" }, receipt: null },
    ];
    expect(request("all-resolvable")).toBe(false);
    plugin.mutationRecoveryScheduler.cancel();
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

  it("still arms a persisted community plugin join on the lifecycle start entry under a delay-only master", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncChangeDelaySeconds = 7;
    plugin.autoSyncPaused = false;
    vi.spyOn(plugin as never, "hasPendingCommunityPluginJoin").mockReturnValue(true);
    const schedulePersistedJoinSync = vi.spyOn(
      plugin as never,
      "schedulePersistedCommunityPluginJoinSync",
    ).mockImplementation(() => undefined);

    plugin.startAutoSync();

    expect(schedulePersistedJoinSync).toHaveBeenCalledWith("auto-start");
  });

  it("does not arm persisted join or recovery rounds when auto sync is fully off", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncChangeDelaySeconds = 0;
    plugin.autoSyncOnStartup = false;
    plugin.autoSyncPaused = false;
    vi.spyOn(plugin as never, "hasPendingCommunityPluginJoin").mockReturnValue(true);
    const schedulePersistedJoinSync = vi.spyOn(
      plugin as never,
      "schedulePersistedCommunityPluginJoinSync",
    ).mockImplementation(() => undefined);
    const requestRecovery = vi.spyOn(
      plugin as never,
      "requestMutationRecoveryObservation",
    ).mockReturnValue(false);

    plugin.startAutoSync();

    expect(schedulePersistedJoinSync).not.toHaveBeenCalled();
    expect(requestRecovery).not.toHaveBeenCalled();
  });

  it("flushes a pending community plugin join round only when joins are pending", async () => {
    const plugin = new EasySyncPlugin();
    const startJoinNow = vi.spyOn(
      plugin as never,
      "startCommunityPluginJoinNow",
    ).mockImplementation(() => undefined);
    const hasPendingJoin = vi.spyOn(
      plugin as never,
      "hasPendingCommunityPluginJoin",
    ).mockReturnValue(true);

    // Manager-close flush: a batch of toggles ends with one round covering
    // every join request; plain scope views never start empty rounds.
    plugin.flushPendingCommunityPluginJoinSync();
    expect(startJoinNow).toHaveBeenCalledTimes(1);

    startJoinNow.mockClear();
    hasPendingJoin.mockReturnValue(false);
    plugin.flushPendingCommunityPluginJoinSync();
    expect(startJoinNow).not.toHaveBeenCalled();
  });

  it("runs settings mutations when sync is idle and drains queued ones in order after the round releases", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      isRunning: false,
    } as never;
    const order: string[] = [];

    // Idle fast path: no queue, no added latency.
    await plugin.runSettingsMutationWhenSyncIdle(async () => {
      order.push("idle");
    });
    expect(order).toEqual(["idle"]);

    // A round holds the operation lock: user-initiated mutations queue and
    // apply in order once the round releases — they must not bounce busy.
    const lock = plugin as never as {
      opLock: string | null;
      releaseOpLock(): void;
    };
    lock.opLock = "sync";
    const first = plugin.runSettingsMutationWhenSyncIdle(async () => {
      order.push("queued-1");
    });
    const second = plugin.runSettingsMutationWhenSyncIdle(async () => {
      order.push("queued-2");
    });
    expect(order).toEqual(["idle"]);

    lock.opLock = null;
    lock.releaseOpLock();
    await Promise.all([first, second]);
    expect(order).toEqual(["idle", "queued-1", "queued-2"]);
  });

  it("keeps draining when a queued settings mutation throws synchronously", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      isRunning: false,
    } as never;
    const order: string[] = [];
    const lock = plugin as never as {
      opLock: string | null;
      releaseOpLock(): void;
    };

    // A run that throws before its first await must still be observed as a
    // rejected promise: the drain shifts the item off the queue before running
    // it, so an escaping throw would abandon that handle (its row stuck
    // loading) and stop the drain for every mutation behind it.
    lock.opLock = "sync";
    const throwing = plugin.runSettingsMutationWhenSyncIdle(() => {
      throw new Error("boom");
    });
    const survivor = plugin.runSettingsMutationWhenSyncIdle(async () => {
      order.push("survivor");
    });

    lock.opLock = null;
    expect(() => lock.releaseOpLock()).not.toThrow();
    await expect(throwing).rejects.toThrow("boom");
    await survivor;
    expect(order).toEqual(["survivor"]);
  });

  it("supports cancelling a queued settings mutation before sync goes idle", async () => {
    const plugin = new EasySyncPlugin();
    plugin.syncExecutor = {
      hasActivityInFlight: false,
      isRunning: false,
    } as never;
    let ran = false;
    const lock = plugin as never as {
      opLock: string | null;
      releaseOpLock(): void;
    };

    // Idle fast path runs immediately and has nothing to cancel.
    const immediate = plugin.runSettingsMutationWhenSyncIdle(async () => {
      ran = true;
    });
    expect(immediate.isQueued()).toBe(false);
    await immediate;
    expect(ran).toBe(true);
    expect(immediate.cancel()).toBe(false);

    // Queued behind a round: cancel settles the promise without running it,
    // and the rest of the queue still applies in order.
    lock.opLock = "sync";
    ran = false;
    const cancelled = plugin.runSettingsMutationWhenSyncIdle(async () => {
      ran = true;
    });
    const survivor = plugin.runSettingsMutationWhenSyncIdle(async () => {
      ran = true;
    });
    expect(cancelled.isQueued()).toBe(true);
    expect(survivor.isQueued()).toBe(true);
    expect(cancelled.cancel()).toBe(true);
    await cancelled;
    expect(ran).toBe(false);
    lock.opLock = null;
    lock.releaseOpLock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(survivor.isQueued()).toBe(false);
    await survivor;
    expect(ran).toBe(true);

    // A mutation that already started applying cannot be cancelled.
    lock.opLock = "sync";
    let resolveRunning!: () => void;
    const running = plugin.runSettingsMutationWhenSyncIdle(
      () =>
        new Promise<void>((resolve) => {
          resolveRunning = resolve;
        }),
    );
    lock.opLock = null;
    lock.releaseOpLock();
    expect(running.cancel()).toBe(false);
    resolveRunning();
    await running;
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
    // 面板必须被重画（失效的旧控件不能静默返回）；次数不再恰好为一——
    // 2026-10-10 起同步入口占用在取得/释放锁时也各重画一次。
    expect(render).toHaveBeenCalled();
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
    // 同前：重画即达（次数不再恰好为一，见 2026-10-10 锁时机重画）。
    expect(render).toHaveBeenCalled();
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

  it("persists the canonical review counts instead of recounting raw plan items", async () => {
    const plugin = makePlugin();
    const scope = {
      accountId: "account",
      driveId: "drive",
      vaultFolderId: "vault",
      filesRootId: "files",
    };
    const items = [{ type: SyncActionType.Upload, path: "a.md" }];
    const canonicalCounts = {
      uploads: 4,
      downloads: 3,
      folders: 2,
      deletes: 1,
      conflicts: 5,
      skipped: 6,
    };
    const plan: SyncPlan = {
      items,
      lastTotalFiles: 10,
      confirmed: false,
      scope,
      canonicalReview: {
        counts: canonicalCounts,
        impactCount: 9,
      },
    };
    const setPlanReviewBundle = vi.fn().mockResolvedValue(undefined);
    plugin.state = {
      planReviewCanonicalIdentity: null,
      setPlanReviewBundle,
    } as never;
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);

    const alert = (plugin as never as {
      showPlanAlert: (kind: "threshold", plan: SyncPlan) => Promise<boolean>;
    }).showPlanAlert("threshold", plan);

    await expect(alert).resolves.toBe(false);
    expect(setPlanReviewBundle).toHaveBeenCalledWith(
      items,
      canonicalCounts,
      scope,
      undefined,
    );
  });

  it("fails closed when a plan review has no canonical review counts", async () => {
    const plugin = makePlugin();
    const plan: SyncPlan = {
      items: [{ type: SyncActionType.Upload, path: "a.md" }],
      lastTotalFiles: 10,
      confirmed: false,
      scope: {
        accountId: "account",
        driveId: "drive",
        vaultFolderId: "vault",
        filesRootId: "files",
      },
    };
    const setPlanReviewBundle = vi.fn().mockResolvedValue(undefined);
    plugin.state = { setPlanReviewBundle } as never;

    const alert = (plugin as never as {
      showPlanAlert: (kind: "threshold", plan: SyncPlan) => Promise<boolean>;
    }).showPlanAlert("threshold", plan);

    await expect(alert).rejects.toThrow("canonical review counts");
    expect(setPlanReviewBundle).not.toHaveBeenCalled();
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

  it("names the lock holder when a side action bounces off a held lock", async () => {
    const plugin = makePlugin();
    const show = vi.fn();
    plugin.i18n = {
      t: (key: string, params?: Record<string, unknown>) =>
        params === undefined ? key : `${key}:${JSON.stringify(params)}`,
    } as never;
    plugin.noticeCenter = { show, dispose: vi.fn() } as never;
    plugin.state = { isV2StateActive: true } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
    } as never;
    (plugin as never as { opLock: string | null }).opLock = "reset";

    await expect(plugin.resolveConflictKeepLocal("a.md"))
      .resolves.toBe(false);

    expect(show).toHaveBeenCalledOnce();
    const message = (show.mock.calls[0]?.[0] as { message: string }).message;
    expect(message).toContain("result.lockBusyWithHolder");
    expect(message).toContain("opHolder.reset");
  });

  it("keeps the run-level wording when a sync round causes the rejection", async () => {
    const plugin = makePlugin();
    const show = vi.fn();
    plugin.i18n = {
      t: (key: string, params?: Record<string, unknown>) =>
        params === undefined ? key : `${key}:${JSON.stringify(params)}`,
    } as never;
    plugin.noticeCenter = { show, dispose: vi.fn() } as never;
    plugin.state = { isV2StateActive: true } as never;
    plugin.syncExecutor = {
      isRunning: true,
      hasSideActionsInFlight: false,
    } as never;
    (plugin as never as { opLock: string | null }).opLock = "sync";

    await expect(plugin.resolveConflictKeepLocal("a.md"))
      .resolves.toBe(false);

    expect(show).toHaveBeenCalledOnce();
    const message = (show.mock.calls[0]?.[0] as { message: string }).message;
    expect(message).toContain("result.alreadyRunning");
    expect(message).not.toContain("result.lockBusyWithHolder");
  });

  it("shows the lock holder on the status bar while the lock is held without a run", () => {
    const plugin = makePlugin();
    const render = vi.fn();
    (plugin as never as { renderStatusBarItem: unknown }).renderStatusBarItem =
      render;
    (plugin as never as { updateRibbon: unknown }).updateRibbon = vi.fn();
    vi.spyOn(plugin as never, "getMutationRecoveryDisplayState")
      .mockReturnValue(null);
    plugin.auth = {
      isInitializing: false,
      isSessionPending: false,
      authState: { isLoggedIn: true },
    } as never;
    plugin.state = {
      planReviewActive: false,
      pendingConflicts: [],
      pendingRemoteDeletes: [],
      lastSyncTime: 0,
      syncHistory: [],
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
    } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    plugin.statusBarEl = { empty: () => undefined } as never;
    (plugin as never as { opLock: string | null }).opLock = "reset";

    (plugin as never as { doUpdateStatusBar: () => void }).doUpdateStatusBar();

    expect(render).toHaveBeenCalledOnce();
    const call = render.mock.calls[0];
    expect(call?.[0]).toBe(plugin.statusBarEl);
    expect(call?.[2]).toBe("syncing");
    expect(call?.[3]).toBe("status.occupiedReset");
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

});