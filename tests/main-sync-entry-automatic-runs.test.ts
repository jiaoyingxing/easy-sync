// 自动触发门、恢复接管与迁移设置
// 由 tests/main-sync-entry.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
// vi.mock 不能跨文件继承，故各主题文件各自保留同一份 mock 前置块。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncCallbacks, SyncResult } from "../src/sync/sync-executor";
import { MutationRecoveryScheduler } from "../src/sync/mutation-recovery-scheduler";
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
  MAX_MUTATION_CHECKPOINT_BATCH: 64,
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

  it("yields the automatic round while a conflict batch is in flight", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = { planReviewActive: false } as never;
    (plugin as never as {
      conflictBatchDirection: "local" | "remote" | null;
    }).conflictBatchDirection = "local";
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    const consumed = await (plugin as never as {
      runAutomaticSync: (trigger: "interval") => Promise<boolean>;
    }).runAutomaticSync("interval");

    // Busy gate: not consumed, no full round, no lock left behind.
    expect(consumed).toBe(false);
    expect(run).not.toHaveBeenCalled();
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

  it("uses a persisted active V2 intent as a cold-start trigger without accepting public precommit or a resolvable paused record", async () => {
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
    // A pause alone no longer suppresses the channel (2026-10-13): whether the
    // stuck record has a manual exit decides, because the pause's recorded
    // reason is memory-only and would strand records across restarts. At this
    // point no executor can answer the eligibility gate, so no manual exit is
    // available and the bounded observation proceeds.
    expect((plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation("paused")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runScheduled).toHaveBeenCalledTimes(2);

    // B4 (2026-09-28 用户拍板): a paused block whose record has no manual
    // exit (self-bundle path class) keeps bounded observations alive —
    // the automatic settlement is that record's only outlet (field case E).
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      canResolveMutationRecovery: vi.fn().mockReturnValue(false),
    } as never;
    (
      plugin as never as { mutationRecoveryBlockReason: string | null }
    ).mutationRecoveryBlockReason = "state-unavailable";
    expect((plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation("foreground")).toBe(true);

    // A paused block whose record IS manually resolvable keeps the user in
    // charge: no scheduler observations behind their back.
    plugin.syncExecutor = {
      isRunning: false,
      hasSideActionsInFlight: false,
      canResolveMutationRecovery: vi.fn().mockReturnValue(true),
    } as never;
    (
      plugin as never as { mutationRecoveryBlockReason: string | null }
    ).mutationRecoveryBlockReason = "facts-changed";
    expect((plugin as never as {
      requestMutationRecoveryObservation: (trigger: string) => boolean;
    }).requestMutationRecoveryObservation("foreground")).toBe(false);
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

  it("ends a paused no-exit block when a scheduled observation settles it (B4)", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = true;
    (
      plugin as never as { mutationRecoveryBlockReason: string | null }
    ).mutationRecoveryBlockReason = "state-unavailable";
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
    const startAutoSync = vi.spyOn(plugin as never, "startAutoSync")
      .mockImplementation(() => undefined);
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    const run = vi.fn().mockImplementation(async () => {
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
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    const outcome = await (plugin as never as {
      runScheduledMutationRecovery: () => Promise<{ state: string }>;
    }).runScheduledMutationRecovery();

    expect(outcome).toEqual({ state: "settled" });
    expect(plugin.autoSyncPaused).toBe(false);
    expect(startAutoSync).toHaveBeenCalledOnce();
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

});