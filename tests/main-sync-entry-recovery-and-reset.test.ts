// 恢复、重置与自动同步暂停豁免
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
import {
  okResult,
  makePlugin,
  attachResetRecoveryHarness,
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
      "Error: state cleanup failed",
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
      "Error: settings write failed",
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

  it("keeps the manual resolution exit reachable under a state-unavailable stamp when the record is eligible", () => {
    const plugin = makePlugin();
    plugin.state = {
      isV2StateActive: true,
      syncHistory: [],
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      canResolveMutationRecovery: vi.fn().mockReturnValue(true),
    } as never;
    // The stamp a crashed round leaves behind must not freeze a resolvable
    // record behind "export or reset" (field reports 2026-09-28).
    (plugin as never as {
      mutationRecoveryBlockReason: string | null;
    }).mutationRecoveryBlockReason = "state-unavailable";

    expect(plugin.getMutationRecoveryDisplayState()).toMatchObject({
      kind: "blocked",
      blockReason: "state-unavailable",
      manualResolutionAvailable: true,
    });
  });

  it("keeps the manual resolution exit hidden under a state-unavailable stamp when the record is ineligible", () => {
    const plugin = makePlugin();
    plugin.state = {
      isV2StateActive: true,
      syncHistory: [],
      mutationLedger: [{
        intent: { operationId: "pending", path: "notes/a.md" },
        receipt: null,
      }],
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      canResolveMutationRecovery: vi.fn().mockReturnValue(false),
    } as never;
    (plugin as never as {
      mutationRecoveryBlockReason: string | null;
    }).mutationRecoveryBlockReason = "state-unavailable";

    expect(plugin.getMutationRecoveryDisplayState()).toMatchObject({
      kind: "blocked",
      blockReason: "state-unavailable",
      manualResolutionAvailable: false,
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
      "Error: IndexedDB commit failed",
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

  it("routes a non-isolatable managed config record to the forced-reset tier after B1 (2026-10-13)", async () => {
    // B1 只放宽普通同步轮的隔离集合；重置预检观察轮保持严格 ⇒ 配置路径记录
    // 在预检里必为 blocked（绝不 isolated）⇒ 仍走强制确认档。与上一条
    // （isolated 走保全档）互为反面，钉住这条分档不被静默放宽。
    const plugin = makePlugin();
    const {
      reset,
      forceReset,
      resetPreservingIsolatedMutationRecovery,
    } = attachResetRecoveryHarness(plugin);
    const retained = {
      intent: {
        version: 1 as const,
        operationId: "op-config-stuck",
        planRevision: 1,
        scope: {
          accountId: "account",
          driveId: "drive",
          vaultFolderId: "vault",
          filesRootId: "root",
        },
        action: "upload" as const,
        path: ".obsidian/plugins/easy-sync/main.js",
        expectedLocal: {
          exists: true as const,
          hash: "aa".repeat(32),
          size: 3,
        },
        expectedRemote: {
          exists: true as const,
          driveId: "remote-main",
          eTag: "etag-main",
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
        // 严格观察轮对这条记录的产物：blocked 且不带 isolated。
        mutationRecovery: {
          state: "blocked",
          total: 1,
          settled: 0,
          remaining: 1,
          retryAfterSeconds: null,
          blockReason: "facts-changed",
          blockedOperationId: retained.intent.operationId,
        },
      });
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    confirmModalAwaitConfirm.mockResolvedValueOnce(true);

    await plugin.resetSyncState();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(forceReset).toHaveBeenCalledOnce();
    expect(resetPreservingIsolatedMutationRecovery).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
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

  it("keeps exact recovery evidence when the conservative capsule is rejected and forced reset is declined", async () => {
    const plugin = makePlugin();
    const {
      state,
      reset,
      resetPreservingIsolatedMutationRecovery,
      forceReset,
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
    confirmModalAwaitConfirm.mockResolvedValueOnce(false);

    await expect(plugin.resetSyncState()).resolves.toBeUndefined();

    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(forceReset).not.toHaveBeenCalled();
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

  it("force resets after informed confirmation when the conservative capsule is rejected", async () => {
    const plugin = makePlugin();
    const {
      state,
      reset,
      resetPreservingIsolatedMutationRecovery,
      forceReset,
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
    confirmModalAwaitConfirm.mockResolvedValueOnce(true);

    await plugin.resetSyncState();

    expect(confirmModalAwaitConfirm).toHaveBeenCalledOnce();
    expect(forceReset).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(state.mutationLedger).toHaveLength(1);
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(clearScanCache).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-complete",
    }));
    expect(show).not.toHaveBeenCalledWith(expect.objectContaining({
      key: "reset-mutation-recovery-blocked",
    }));
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
      "Error: IndexedDB commit failed",
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

  it("does not pause auto sync when the only outcome is a remote-version-changed deferral", async () => {
    // 2026-09-28 热文件改判：下载中云端版本变化延后为单项，轮内 errors=0、
    // success=true——暂停门不得因 deferred>0 把自动同步停掉。
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
      success: true,
      errors: 0,
      deferred: 1,
      message: "result.deferred",
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

  it("does not pause auto sync when every failure is a network-class transfer failure", async () => {
    // 2026-10-16 用户拍板：断网造成的失败是环境瞬态，不是未知结果。整库暂停会
    // 把 M17 网络退避臂（每 15 分钟一次真实重试）一起关掉，落成"必须手动同步
    // 才继续"——长时间不关机的机器恢复联网后正是这样停摆的。
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
      errors: 2,
      networkFailureErrors: 2,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("does not pause auto sync when a round mixes exempt failure families", async () => {
    // 组合现场（2026-10-16 review）：网络长时间不稳时，同一轮里既可能有被 M17
    // 熔断延后的项（同版本已连续失败 3 次），也可能有刚断链的项。两者各自都不该
    // 让整库停摆，混在一起同样不该——判据是"每个错误都属于既有豁免族"，不是
    // "某一族恰好等于全部错误"。
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
      errors: 2,
      breakerDeferredErrors: 1,
      networkFailureErrors: 1,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps pausing when exempt counters over-count the round's errors", async () => {
    // 反假绿控制项：豁免族的和必须与 errors 严格相等。这里延后项在轮内没走到
    // 执行（错误没被计入），网络族单独看又恰好等于 errors——旧判据会把它当成
    // "只剩网络族"而放过整轮，新判据按和比对，和（4）大于 errors（1），仍暂停。
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
      errors: 1,
      breakerDeferredErrors: 2,
      networkFailureErrors: 1,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps pausing auto sync when network failures are mixed with other failures", async () => {
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
      networkFailureErrors: 1,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("does not pause auto sync when the only failure is a plan-layer identity deferral", async () => {
    // 2026-10-18 用户拍板：计划层 RetryLater（`reason.identityReplacement.
    // verificationPending`，文案自陈「本轮未作更改」、设计语义＝下一轮再验证）
    // 不再触发整库暂停——把它停下来等手动同步，正好否掉它自己「下一轮再验证」
    // 的语义。失败仍如实进历史与失败提示（本项同时钉住这两处照常收到这一轮）。
    const plugin = new EasySyncPlugin();
    plugin.autoSyncPaused = false;
    plugin.state = { planReviewActive: false } as never;
    plugin.i18n = { t: (key: string) => key } as never;
    const finishSyncNotice = vi.spyOn(plugin as never, "finishSyncNotice").mockImplementation(() => undefined);
    const recordSyncHistory = vi.spyOn(plugin as never, "recordSyncHistory").mockResolvedValue(undefined);
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
      errors: 1,
      planningDeferredErrors: 1,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
    expect(recordSyncHistory).toHaveBeenCalledTimes(1);
    expect(recordSyncHistory.mock.calls[0][0]).toMatchObject({
      success: false,
      errors: 1,
      planningDeferredErrors: 1,
      message: "syncFailed",
    });
    expect(finishSyncNotice).toHaveBeenCalledTimes(1);
  });

  it("keeps pausing auto sync when a plan-layer deferral is mixed with a family-outside failure", async () => {
    // 反假绿控制项：豁免的是「整轮每个错误都属于豁免族」，不是「有这一类延后
    // 就不暂停」。混入族外失败（这一轮 errors=2、其中延后只占 1）照旧暂停。
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
      errors: 2,
      planningDeferredErrors: 1,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("does not pause auto sync when a plan-layer deferral mixes with other exempt families", async () => {
    // 组合现场：计划层延后与熔断延后、网络类失败同轮出现时，每个错误仍在豁免
    // 族内——求和等式判据保持不变（F30 三处边界之一：豁免族相混不停摆）。
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
      planningDeferredErrors: 1,
      breakerDeferredErrors: 1,
      networkFailureErrors: 1,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(false);
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(saveSyncSettings).not.toHaveBeenCalled();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

  it("keeps pausing when the plan-layer deferral counter over-counts the round's errors", async () => {
    // 反假绿控制项：求和等式语义不变——四族之和必须严格等于 errors。这里延后
    // 计数（2）大于 errors（1，延后项在轮内没走到执行），和大于 errors ⇒ 仍暂停。
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
      errors: 1,
      planningDeferredErrors: 2,
      message: "syncFailed",
    }, "auto");

    expect(plugin.autoSyncPaused).toBe(true);
    expect(stopAutoSync).toHaveBeenCalledOnce();
    expect(saveSyncSettings).toHaveBeenCalledOnce();
    expect(startAutoSync).not.toHaveBeenCalled();
  });

});