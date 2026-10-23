// 入口守卫、onload 生命周期与自动同步通道
// 由 tests/main-sync-entry.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
// vi.mock 不能跨文件继承，故各主题文件各自保留同一份 mock 前置块。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { I18n } from "../src/i18n";
import type { SyncCallbacks, SyncResult } from "../src/sync/sync-executor";
import { SyncActionType, type SyncPlan } from "../src/sync/types";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationV1,
} from "../src/sync/community-plugin-participation";
import { isEasySyncInternalPath } from "../src/sync/local-scanner";
import { SYNC_VIEW_TYPE, shouldAutoRebuildPlanReview } from "../src/ui/sync-view";
import {
  okResult,
  makePlugin,
  attachParticipationState,
  participating,
  COMMUNITY_PLUGIN_SCOPE,
  changedRemotePluginJoin,
  remoteCalendarCatalog,
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

// 本套件用替身替掉扫描器与侧栏视图，但其中两条规则不属于「外部依赖」，
// 而是产品自己的判定。替身必须直接引用真实现：验收「替身没有变成第二份
// 实现」，否则规则一改，替身会继续按旧规则放行，本套件全绿却已经失真。
describe("test harness delegates product rules", () => {
  it("两条规则与视图类型都取自真实现", async () => {
    const actualScanner = await vi.importActual<
      typeof import("../src/sync/local-scanner")
    >("../src/sync/local-scanner");
    const actualSyncView = await vi.importActual<
      typeof import("../src/ui/sync-view")
    >("../src/ui/sync-view");
    expect(isEasySyncInternalPath, "内部路径判定必须复用真规则而非另抄一份")
      .toBe(actualScanner.isEasySyncInternalPath);
    expect(shouldAutoRebuildPlanReview, "审阅重建判定必须复用真规则而非另抄一份")
      .toBe(actualSyncView.shouldAutoRebuildPlanReview);
    expect(SYNC_VIEW_TYPE).toBe(actualSyncView.SYNC_VIEW_TYPE);
  });

  it("内部路径判定按真规则工作：状态文件与配置目录都在判据内", () => {
    expect(isEasySyncInternalPath(".obsidian/plugins/easy-sync/tmp/scratch.md"))
      .toBe(true);
    // 插件自己的状态文件同样不是同步范围——早期替身只认临时目录，漏了这一族。
    expect(isEasySyncInternalPath(".obsidian/plugins/easy-sync/data.json"))
      .toBe(true);
    // 配置目录是入参而非写死的 .obsidian：换目录后判据跟着换。
    expect(isEasySyncInternalPath(
      ".vault2/plugins/easy-sync/tmp/scratch.md",
      ".vault2",
    )).toBe(true);
    expect(isEasySyncInternalPath(".vault2/plugins/easy-sync/tmp/scratch.md"))
      .toBe(false);
  });
});

describe("main sync entry guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    confirmModalAwaitConfirm.mockReset();
    confirmModalAwaitConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("re-applies the max-file-size threshold after the scanner is created", () => {
    // 2026-09-16 真机取证：onload 第①步 loadSyncSettings() 里的 applyMaxFileSize()
    // 跑在 scanner 创建之前，`this.scanner?.setConfig` 被可选链静默吞掉——
    // 每次重载/重启阈值都悄悄回到默认值，只有当场改设置才生效。
    // 守卫：scanner 创建点必须像 applySyncPathSettings 一样补调 applyMaxFileSize。
    const source = readFileSync("src/main.ts", "utf8");
    const creationAt = source.indexOf("this.scanner = new LocalScanner(");
    expect(creationAt).toBeGreaterThan(-1);
    const afterCreation = source.slice(creationAt, creationAt + 700);
    expect(afterCreation).toContain("this.applyMaxFileSize()");
  });

  it("keeps the skip-row delta wiring: baseline filter, mirror overwrite, state accessors, history group", () => {
    // 2026-09-16 拍板（方案单 §十二）：稳定被排除文件不逐行重演——
    // 结算按基准过滤、轮末镜像覆写、StateManager 两方法、历史折叠组。
    const executorSource = readFileSync("src/sync/sync-executor.ts", "utf8");
    const settlementAt = executorSource.indexOf(
      "if (item.type === SyncActionType.SkipLargeFile) {",
    );
    expect(settlementAt).toBeGreaterThan(-1);
    const settlementWindow = executorSource.slice(
      settlementAt,
      settlementAt + 600,
    );
    expect(settlementWindow).toContain("settledSkipPaths.add(item.path)");
    expect(settlementWindow).toContain("skipBaseline.has(item.path)");
    expect(executorSource).toContain(
      "commitSizeExclusionBaseline",
    );

    const stateSource = readFileSync("src/sync/state-manager.ts", "utf8");
    expect(stateSource).toContain("getSizeExclusionBaseline");
    expect(stateSource).toContain("commitSizeExclusionBaseline");

    const viewSource = readFileSync("src/ui/sync-view.ts", "utf8");
    expect(viewSource).toContain("easy-sync-history-skip-group");
    expect(viewSource).toContain("syncView.history.skipGroupTitle");
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

  it("records the wall-clock failure moment on error rows and renders it in the report failure detail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T22:21:09"));
    const failureMoment = Date.now();
    const plugin = makePlugin();
    const executorSource = readFileSync("src/sync/sync-executor.ts", "utf8");
    const mainSource = readFileSync("src/main.ts", "utf8");
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
      "附件/录音/resojot-20260910125415.wav",
      SyncActionType.Download,
      false,
      "网络请求失败",
      2599824,
    );
    handleFileComplete(
      "Projects/New.md",
      SyncActionType.Download,
      true,
      undefined,
      12,
    );

    expect(plugin.progressStore.state.completedFiles).toEqual([
      expect.objectContaining({
        path: "附件/录音/resojot-20260910125415.wav",
        status: "error",
        failedAt: failureMoment,
      }),
      expect.objectContaining({
        path: "Projects/New.md",
        status: "download",
        failedAt: undefined,
      }),
    ]);
    // The report failure detail prefers the per-file failure moment and only
    // falls back to the round start for legacy history entries.
    expect(mainSource).toContain("${fmtShort(f.failedAt ?? f.historyStartedAt)}");
    // Side-action errors (folder/conflict rows) record the same field.
    expect(executorSource).toContain("failedAt: status === \"error\" ? Date.now() : undefined,");
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

  it("attaches vault lifecycle listeners only after layout ready (host init create flood)", () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    const vaultListeners = new Map<string, (file: unknown) => void>();
    const layoutReadyCallbacks: Array<() => void> = [];
    plugin.app = {
      workspace: {
        onLayoutReady: (callback: () => void) => {
          layoutReadyCallbacks.push(callback);
        },
        getLeavesOfType: () => [],
      },
      vault: {
        adapter: { exists: vi.fn().mockResolvedValue(false) },
        on: (event: string, callback: (file: unknown) => void) => {
          vaultListeners.set(event, callback);
          return { event };
        },
        getFiles: () => [],
        getName: () => "testVault",
      },
      fileManager: {},
    } as never;

    (plugin as never as { registerVaultLifecycleListeners: () => void })
      .registerVaultLifecycleListeners();

    // Obsidian's vault initialization calls `create` for every existing file
    // (official load-time guide). Before layout ready nothing may listen, or
    // the host's own init flood reads as local modifications and schedules an
    // auto-sync round on the next start (2026-08-02 archived design §4.5/§6.1;
    // measured on the host 2026-10-14: hint marked 43ms after onload).
    expect(vaultListeners.size).toBe(0);
    expect(plugin.autoSyncDirtyHint.pending).toBe(false);
    expect(plugin.diag.log).not.toHaveBeenCalledWith(
      "execute",
      "local dirty hint scheduled normal auto sync",
      expect.anything(),
    );

    // Once the workspace is ready the same event is a real local change.
    layoutReadyCallbacks.forEach((callback) => callback());
    expect([...vaultListeners.keys()].sort()).toEqual([
      "create",
      "delete",
      "modify",
      "rename",
    ]);
    vaultListeners.get("create")?.({ path: "notes/a.md" });

    expect(plugin.autoSyncDirtyHint.pending).toBe(true);
    expect(plugin.diag.log).toHaveBeenCalledWith(
      "execute",
      "local dirty hint scheduled normal auto sync",
      expect.objectContaining({ debounceMs: 7_000 }),
    );
    plugin.stopAutoSync();
  });

  it("does not attach vault listeners when the plugin unloaded before layout ready", () => {
    const plugin = makePlugin();
    const vaultListeners = new Map<string, unknown>();
    const layoutReadyCallbacks: Array<() => void> = [];
    plugin.app = {
      workspace: {
        onLayoutReady: (callback: () => void) => {
          layoutReadyCallbacks.push(callback);
        },
        getLeavesOfType: () => [],
      },
      vault: {
        adapter: { exists: vi.fn().mockResolvedValue(false) },
        on: (event: string, callback: unknown) => {
          vaultListeners.set(event, callback);
          return { event };
        },
        getFiles: () => [],
        getName: () => "testVault",
      },
      fileManager: {},
    } as never;
    // The unload signal onunload sets before late onLayoutReady callbacks run.
    (plugin as never as { unloaded: boolean }).unloaded = true;

    (plugin as never as { registerVaultLifecycleListeners: () => void })
      .registerVaultLifecycleListeners();
    layoutReadyCallbacks.forEach((callback) => callback());

    expect(vaultListeners.size).toBe(0);
  });

  it("wires commands, the sync view, lifecycle listeners and layout-ready work from onload", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    const commands: Array<{ id?: string }> = [];
    const views: Array<{ type: string; creator: unknown }> = [];
    const layoutReadyCallbacks: Array<() => void> = [];
    const workspaceOn = vi.fn((event: string) => ({ event }));
    const vaultOn = vi.fn((event: string) => ({ event }));
    const previousDocument = (globalThis as { document?: Document }).document;
    (globalThis as { document?: Document }).document = {
      visibilityState: "visible",
      querySelector: vi.fn(() => null),
    } as unknown as Document;

    const localValues = new Map<string, unknown>();
    plugin.app = {
      workspace: {
        onLayoutReady: (callback: () => void) => {
          layoutReadyCallbacks.push(callback);
        },
        on: workspaceOn,
        offref: vi.fn(),
      },
      vault: {
        adapter: {},
        on: vaultOn,
        getConfig: () => ".obsidian",
        getFiles: () => [],
        getName: () => "testVault",
        configDir: ".obsidian",
      },
      fileManager: {},
      loadLocalStorage: (key: string) => localValues.get(key) ?? null,
      saveLocalStorage: (key: string, value: unknown) => {
        localValues.set(key, value);
      },
    } as never;

    vi.spyOn(plugin, "addRibbonIcon").mockReturnValue({
      addClass: vi.fn(),
    } as unknown as HTMLElement);
    vi.spyOn(plugin, "addStatusBarItem").mockReturnValue({
      addClass: vi.fn(),
      onClickEvent: vi.fn(),
    } as unknown as HTMLElement);
    vi.spyOn(plugin, "addCommand").mockImplementation((command) => {
      commands.push(command as { id?: string });
    });
    vi.spyOn(plugin, "registerView").mockImplementation((type, creator) => {
      views.push({ type, creator });
    });
    const registerVaultLifecycleListeners = vi.spyOn(
      plugin as never,
      "registerVaultLifecycleListeners",
    );
    const startAutoSync = vi.spyOn(plugin, "startAutoSync")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin, "updateStatusBar").mockImplementation(() => undefined);
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    try {
      await plugin.onload();
    } finally {
      if (previousDocument === undefined) {
        delete (globalThis as { document?: Document }).document;
      } else {
        (globalThis as { document?: Document }).document = previousDocument;
      }
    }

    expect(commands.map((command) => command.id)).toEqual([
      "start-sync",
      "show-detail",
      "open-recovery",
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.type).toBe(SYNC_VIEW_TYPE);
    expect(views[0]?.creator).toBeTypeOf("function");
    expect(registerVaultLifecycleListeners).toHaveBeenCalledOnce();
    expect(startAutoSync).toHaveBeenCalledOnce();

    // Update reminder, auth+state background start, vault lifecycle listeners.
    expect(layoutReadyCallbacks).toHaveLength(3);
    layoutReadyCallbacks.forEach((callback) => callback());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const auth = plugin.auth as unknown as {
      initialize: ReturnType<typeof vi.fn>;
    };
    expect(auth.initialize).toHaveBeenCalledOnce();
    expect(plugin.ensureStateLoaded).toHaveBeenCalledOnce();
    expect(vaultOn.mock.calls.map(([event]) => event).sort()).toEqual([
      "create",
      "delete",
      "modify",
      "rename",
    ]);
    expect(runAutomaticSync).toHaveBeenCalledWith("startup");
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

  it("runs local-change sync when only the change trigger is enabled", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncPaused = false;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(7_000);

    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("dirty");
    plugin.stopAutoSync();
  });

  it("keeps the shared auto entry open for a dirty round under a delay-only master", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncPaused = false;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = { planReviewActive: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    const consumed = await (plugin as never as {
      runAutomaticSync: (trigger: "dirty") => Promise<boolean>;
    }).runAutomaticSync("dirty");

    expect(consumed).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("drops a persisted join dirty round when the auto sync master is off", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncChangeDelaySeconds = 0;
    // Every channel off — the startup channel defaults on, so leaving it true
    // would keep the master on by itself.
    plugin.autoSyncOnStartup = false;
    plugin.autoSyncPaused = false;
    vi.spyOn(plugin as never, "hasPendingCommunityPluginJoin")
      .mockReturnValue(true);
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = { planReviewActive: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);
    const run = vi.fn().mockResolvedValue(okResult());
    plugin.syncExecutor = { isRunning: false, run } as never;

    const consumed = await (plugin as never as {
      runAutomaticSync: (trigger: "dirty") => Promise<boolean>;
    }).runAutomaticSync("dirty");

    expect(consumed).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();
  });

  it("turning the auto sync master off stops every channel and remembers their settings", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 10;
    plugin.setAutoSyncChangeDelaySeconds(4);
    plugin.autoSyncOnStartup = true;
    plugin.autoSyncPaused = true;
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const restartAutoSync = vi.spyOn(plugin as never, "restartAutoSync")
      .mockImplementation(() => undefined);

    await plugin.setAutoSyncMasterEnabled(false);

    expect(plugin.syncInterval).toBe(0);
    expect(plugin.autoSyncChangeDelaySeconds).toBe(0);
    expect(plugin.autoSyncOnStartup).toBe(false);
    expect(plugin.autoSyncPaused).toBe(false);
    expect(saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(restartAutoSync).toHaveBeenCalledTimes(1);

    await plugin.setAutoSyncMasterEnabled(true);

    expect(plugin.syncInterval).toBe(10);
    expect(plugin.autoSyncChangeDelaySeconds).toBe(4);
    expect(plugin.autoSyncOnStartup).toBe(true);
  });

  it("turning the master back on keeps a channel the user had disabled", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 10;
    plugin.setAutoSyncChangeDelaySeconds(0);
    vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "restartAutoSync")
      .mockImplementation(() => undefined);

    await plugin.setAutoSyncMasterEnabled(false);
    await plugin.setAutoSyncMasterEnabled(true);

    expect(plugin.syncInterval).toBe(10);
    expect(plugin.autoSyncChangeDelaySeconds).toBe(0);
  });

  it("restores default auto sync settings when the master turns on without a remembered snapshot", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncChangeDelaySeconds = 0;
    vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "restartAutoSync")
      .mockImplementation(() => undefined);

    await plugin.setAutoSyncMasterEnabled(true);

    expect(plugin.syncInterval).toBe(3);
    expect(plugin.autoSyncChangeDelaySeconds).toBe(7);
    // 启动通道一并回默认（2026-10-13 新增第三通道）。
    expect(plugin.autoSyncOnStartup).toBe(true);
  });

  it("keeps the master on with only the startup channel enabled", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    plugin.setAutoSyncChangeDelaySeconds(0);
    plugin.autoSyncOnStartup = true;
    vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "restartAutoSync")
      .mockImplementation(() => undefined);

    expect(plugin.isAutoSyncMasterEnabled()).toBe(true);

    // 关掉唯一开着的通道：总开关落回关闭并记住它，再开时恢复。
    await plugin.setAutoSyncMasterEnabled(false);
    expect(plugin.isAutoSyncMasterEnabled()).toBe(false);

    await plugin.setAutoSyncMasterEnabled(true);
    expect(plugin.autoSyncOnStartup).toBe(true);
    expect(plugin.isAutoSyncMasterEnabled()).toBe(true);
  });

  it("runs one startup round for a joined vault and never the first-sync flow", async () => {
    const unjoined = makePlugin();
    unjoined.auth = { authState: { isLoggedIn: true } } as never;
    unjoined.state = { planReviewActive: false } as never;
    vi.spyOn(unjoined as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(unjoined as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(unjoined as never, "updateStatusBar").mockImplementation(() => undefined);
    // 首同步流程的代表性入口：命中即证明启动轮进了不该进的分支。
    const unjoinedFirstSyncFlow = vi.spyOn(unjoined as never, "maybeRunRsMigrationOffer")
      .mockResolvedValue("fresh");
    const unjoinedRun = vi.fn().mockResolvedValue(okResult());
    unjoined.syncExecutor = { isRunning: false, run: unjoinedRun } as never;

    const unjoinedConsumed = await (unjoined as never as {
      runAutomaticSync: (trigger: "startup") => Promise<boolean>;
    }).runAutomaticSync("startup");

    // 未加入云端仓库：启动轮原地让路，绝不进入首同步（迁移询问／加入选择）分支。
    expect(unjoinedConsumed).toBe(true);
    expect(unjoinedRun).not.toHaveBeenCalled();
    expect(unjoinedFirstSyncFlow).not.toHaveBeenCalled();

    const joined = makePlugin();
    joined.auth = { authState: { isLoggedIn: true } } as never;
    joined.state = { planReviewActive: false, lastSyncTime: 1 } as never;
    vi.spyOn(joined as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(joined as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(joined as never, "updateStatusBar").mockImplementation(() => undefined);
    const joinedRun = vi.fn().mockResolvedValue(okResult());
    joined.syncExecutor = { isRunning: false, run: joinedRun } as never;

    const joinedConsumed = await (joined as never as {
      runAutomaticSync: (trigger: "startup") => Promise<boolean>;
    }).runAutomaticSync("startup");

    expect(joinedConsumed).toBe(true);
    expect(joinedRun).toHaveBeenCalledTimes(1);
    expect(joinedRun.mock.calls[0]?.[0]).toBe("auto");
  });

  it("fires the once-per-session startup round only after auth and state are both ready", async () => {
    const plugin = makePlugin();
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    const note = (signal: "auth" | "state"): void =>
      (plugin as never as {
        noteStartupReadinessSettled: (signal: "auth" | "state") => void;
      }).noteStartupReadinessSettled(signal);

    // 状态先就绪时不能抢跑：登录还在后台恢复，提前发轮会被「未登录静默跳过」
    // 消费掉且不重来。
    note("state");
    expect(runAutomaticSync).not.toHaveBeenCalled();

    note("auth");
    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("startup");

    // 之后的就绪回报（重载等）不补发第二轮。
    note("auth");
    note("state");
    expect(runAutomaticSync).toHaveBeenCalledOnce();
  });

  it("hands a busy startup round to the retry wheel instead of losing it", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(false); // 忙：本轮未被消费
    const note = (signal: "auth" | "state"): void =>
      (plugin as never as {
        noteStartupReadinessSettled: (signal: "auth" | "state") => void;
      }).noteStartupReadinessSettled(signal);

    note("auth");
    note("state");
    await vi.advanceTimersByTimeAsync(0);
    expect(runAutomaticSync).toHaveBeenCalledTimes(1);

    // 静默窗口后自动再试，直到某一轮被真正消费。
    await vi.advanceTimersByTimeAsync(7_000);
    expect(runAutomaticSync).toHaveBeenCalledTimes(2);
    plugin.stopAutoSync();
  });

  it("arms the startup round from the state success path but not from a failed state load", () => {
    // 失败分支报到会把重试轮挂在 ensureStateLoaded 的失败缓存上（7 秒一次的失败
    // 循环），且此时没有可规划的状态。源码守卫：成功分支保留报到调用，失败分支不得有
    // ——两侧都删时前半句会先红（守卫不空转）。
    // prettier-ignore
    const source = readFileSync("src/main.ts", "utf8");
    expect(source).toContain(
      'this.schedulePersistedCommunityPluginJoinSync("state-loaded");\n'
      + "          this.noteStartupReadinessSettled(\"state\");",
    );
    const warnIndex = source.indexOf('"background state load failed"');
    expect(warnIndex).toBeGreaterThan(-1);
    const branchEnd = source.indexOf("});", warnIndex);
    const failureBranch = source.slice(warnIndex, branchEnd);
    expect(failureBranch).not.toContain("noteStartupReadinessSettled");
  });

  it("keeps 1-minute and 1-second triggers to one round at a time", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 1;
    plugin.setAutoSyncChangeDelaySeconds(1);
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = { planReviewActive: false } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    vi.spyOn(plugin as never, "beginSyncNotice").mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar").mockImplementation(() => undefined);
    let releaseRun!: () => void;
    const run = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        releaseRun = () => resolve(okResult());
      }),
    );
    plugin.syncExecutor = { isRunning: false, run } as never;
    plugin.startAutoSync();

    // A 1s-debounce edit starts the round; the round stays in flight.
    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    // The 1-minute interval tick lands while the dirty round is in flight:
    // the busy guard refuses it — no second dispatch, no queueing.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(run).toHaveBeenCalledTimes(1);

    releaseRun();
    await vi.advanceTimersByTimeAsync(0);
    expect((plugin as never as { opLock: string | null }).opLock).toBeNull();

    // The next interval tick starts a fresh round; the hint was consumed by
    // the round it started, not dropped.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    plugin.stopAutoSync();
  });

  it("keeps a pending local-change window alive across a delay adjustment that keeps the master on", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    plugin.autoSyncPaused = false;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(3_000);

    // Plain 7s→1s adjustment (master stays on): the pending window
    // reschedules with the new delay instead of being cancelled.
    plugin.setAutoSyncChangeDelaySeconds(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runAutomaticSync).toHaveBeenCalledOnce();
    expect(runAutomaticSync).toHaveBeenCalledWith("dirty");
    plugin.stopAutoSync();
  });

  it("releases the delay-only master and its pending window when the delay is set to zero", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 0;
    plugin.autoSyncPaused = false;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);

    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/a.md");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runAutomaticSync).not.toHaveBeenCalled();

    plugin.setAutoSyncChangeDelaySeconds(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAutomaticSync).not.toHaveBeenCalled();

    // With the master off, later edits are not scheduled either.
    (plugin as never as { markLocalDirtyHint: (path: string) => void })
      .markLocalDirtyHint("notes/b.md");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runAutomaticSync).not.toHaveBeenCalled();
  });

  it("gates mutation recovery observation on the master switch rather than the scheduled interval", () => {
    const plugin = makePlugin();
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    plugin.state = {
      isV2StateActive: true,
      hasMutationLedgerCorruption: false,
      hasMutationRecoveryQuarantineCorruption: false,
      hasV2StateLoadRecoveryBlock: false,
      hasV2RemoteScopeRecovery: false,
      planReviewActive: false,
      mutationLedger: [{ intent: { operationId: "pending" }, receipt: null }],
    } as never;
    (plugin as never as { _stateLoaded: boolean })._stateLoaded = true;
    const requestObservation = vi.spyOn(
      plugin.mutationRecoveryScheduler,
      "requestObservation",
    ).mockReturnValue(true);
    const observe = (trigger: string): boolean =>
      (plugin as never as {
        requestMutationRecoveryObservation: (trigger: string) => boolean;
      }).requestMutationRecoveryObservation(trigger);

    // Delay-only master (scheduled off): observation still armed.
    plugin.syncInterval = 0;
    plugin.autoSyncChangeDelaySeconds = 7;
    expect(observe("foreground")).toBe(true);
    expect(requestObservation).toHaveBeenCalledTimes(1);

    // Master fully off: nothing armed.
    plugin.autoSyncChangeDelaySeconds = 0;
    plugin.autoSyncOnStartup = false;
    expect(observe("foreground")).toBe(false);
    expect(requestObservation).toHaveBeenCalledTimes(1);

    // Scheduled-only master: observation armed again.
    plugin.syncInterval = 3;
    expect(observe("interval")).toBe(true);
    expect(requestObservation).toHaveBeenCalledTimes(2);
  });

  it("snapshots and restores the dual-1 configuration through the master switch", async () => {
    const plugin = makePlugin();
    plugin.syncInterval = 1;
    plugin.setAutoSyncChangeDelaySeconds(1);
    vi.spyOn(plugin, "saveSyncSettings").mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "restartAutoSync")
      .mockImplementation(() => undefined);

    await plugin.setAutoSyncMasterEnabled(false);
    expect(plugin.syncInterval).toBe(0);
    expect(plugin.autoSyncChangeDelaySeconds).toBe(0);

    await plugin.setAutoSyncMasterEnabled(true);
    expect(plugin.syncInterval).toBe(1);
    expect(plugin.autoSyncChangeDelaySeconds).toBe(1);
  });

});