// 切片 3/2、同步模式切换与单向本机独有行
// 由 tests/main-sync-entry.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
// vi.mock 不能跨文件继承，故各主题文件各自保留同一份 mock 前置块。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import EasySyncPlugin from "../src/main";
import { I18n } from "../src/i18n";
import type { SyncCallbacks, SyncResult } from "../src/sync/sync-executor";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationV1,
} from "../src/sync/community-plugin-participation";
import { createEmptyCommunityPluginAdoptionMemory } from "../src/sync/community-plugin-adoption-memory";
import {
  okResult,
  makePlugin,
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

describe("slice-3 no-restart enablement for explicit downloads", () => {
  function completedRestoreResult(): SyncResult {
    return {
      ...okResult(),
      communityPluginRestoresCompleted: {
        files: ["calendar"],
        data: [],
      },
    };
  }

  function makeEnableHarness() {
    const plugin = makePlugin();
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    let participation = reduceDeviceCommunityPluginParticipation(
      createEmptyDeviceCommunityPluginParticipation(true),
      { type: "request-join", pluginId: "calendar", operationId: "join-1" },
    );
    participation = reduceDeviceCommunityPluginParticipation(
      participation,
      { type: "begin-restore", pluginId: "calendar" },
    );
    let store = createEmptyCommunityPluginAdoptionMemory();
    const memoryUpdate = vi.fn(async (next) => {
      store = structuredClone(next);
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
      remoteScope: COMMUNITY_PLUGIN_SCOPE,
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
      commitSyncPathSettingsChange: vi.fn(async (
        _isPathInScope: unknown,
        persistSettings: (data: Record<string, unknown>) => void,
      ) => persistSettings({})),
      getCommunityPluginManifestObservations: vi.fn(() => []),
      setCommunityPluginManifestObservations: vi.fn().mockResolvedValue(
        undefined,
      ),
      getRemoteCommunityPluginCatalog: vi.fn(() => null),
      setRemoteCommunityPluginCatalog: vi.fn().mockResolvedValue(undefined),
      getCommittedRemoteIndex: () => committedPluginIndex(),
      getCommunityPluginAdoptionMemory: () => structuredClone(store),
      updateCommunityPluginAdoptionMemory: memoryUpdate,
    };
    plugin.state = state as never;
    plugin.i18n = new I18n("zh-cn");
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
    plugin.scanner = {
      setConfig: vi.fn(),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      setCommunityPluginSyncPolicy: vi.fn(),
      run: vi.fn().mockResolvedValue(completedRestoreResult()),
    } as never;
    (plugin as never as {
      applyCommunityPluginParticipationProjection: (
        value: DeviceCommunityPluginParticipationV1,
      ) => void;
    }).applyCommunityPluginParticipationProjection(participation);
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    plugin.noticeCenter = {
      show: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    } as never;
    return {
      plugin,
      state,
      participation: () => structuredClone(participation),
      memory: () => structuredClone(store),
      memoryUpdate,
      show: plugin.noticeCenter!.show as ReturnType<typeof vi.fn>,
    };
  }

  it("enables each explicitly downloaded plugin through the host API without notices", async () => {
    const { plugin, show } = makeEnableHarness();
    const enablePluginAndSave = vi.fn().mockResolvedValue(undefined);
    const loadManifests = vi.fn().mockResolvedValue(undefined);
    plugin.app.plugins = { loadManifests, enablePluginAndSave } as never;

    const result = await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(result?.success).toBe(true);
    expect(loadManifests).toHaveBeenCalledTimes(1);
    expect(enablePluginAndSave).toHaveBeenCalledTimes(1);
    expect(enablePluginAndSave).toHaveBeenCalledWith("calendar");
    expect(show).not.toHaveBeenCalled();
  });

  it("falls back with a manual-enable notice and never fails the round", async () => {
    const { plugin, show } = makeEnableHarness();
    plugin.app.plugins = {
      loadManifests: vi.fn().mockResolvedValue(undefined),
      enablePluginAndSave: vi.fn().mockRejectedValue(new Error("host")),
    } as never;

    const result = await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(result?.success).toBe(true);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "sync-result:community-plugin-enable-fallback",
    }));
    // The notice text names the plugin (manifest unreadable in this harness
    // falls back to the plugin id inside the label).
    const message = (show.mock.calls[0]?.[0] as { message?: string }).message
      ?? "";
    expect(message).toContain("calendar");
  });

  it("keeps automatic updates out of the enablement path", async () => {
    const { plugin, show } = makeEnableHarness();
    const enablePluginAndSave = vi.fn();
    plugin.app.plugins = {
      loadManifests: vi.fn(),
      enablePluginAndSave,
    } as never;
    // The ordinary update result carries no completed restores: a
    // participating plugin's version bump must never reach enablement.
    (plugin.syncExecutor!.run as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ...okResult(),
        communityPluginRestoresCompleted: { files: [], data: [] },
      });

    await (plugin as never as {
      dispatchSyncRun: (request: { mode: "manual" }) => Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });

    expect(enablePluginAndSave).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });
});


// ---- 切片 2：即时弹框（去抖队列/批量合并/动作执行）----
describe("slice-2 immediate scope-crossing prompt", () => {
  beforeEach(() => {
    scopeCrossingPromptAwaitChoice.mockReset();
    scopeCrossingPromptMockArgs.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePromptPlugin() {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.scanner = {
      shouldSyncPath: vi.fn((path: string) => path.startsWith("Notes")),
      shouldSyncFolderPath: vi.fn(() => true),
    } as never;
    const recordLocalFileMoveHint = vi.fn().mockResolvedValue(true);
    const retireLocalMoveHintsByRemoteIds = vi.fn().mockResolvedValue(undefined);
    let fileHints: Array<{
      remoteId: string;
      fromPath: string;
      toPath: string;
    }> = [];
    plugin.state = {
      recordLocalFileMoveHint,
      retireLocalMoveHintsByRemoteIds,
      get localFileMoveHints() {
        return fileHints;
      },
      localFolderMoveHints: [],
    } as never;
    return {
      plugin,
      recordLocalFileMoveHint,
      retireLocalMoveHintsByRemoteIds,
      seedHint: (remoteId: string, fromPath: string, toPath: string) => {
        fileHints = [...fileHints, { remoteId, fromPath, toPath }];
      },
    };
  }

  function renameFile(
    plugin: EasySyncPlugin,
    fromPath: string,
    toPath: string,
  ) {
    return (plugin as never as {
      handleLocalVaultRename: (
        file: TFile,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename(new TFile(toPath), fromPath);
  }

  it("debounces a burst of out-of-scope moves into one batch prompt and applies confirm to every item", async () => {
    const { plugin, retireLocalMoveHintsByRemoteIds, seedHint } =
      makePromptPlugin();
    seedHint("file-a", "Notes/a.md", "Archive/a.md");
    seedHint("file-b", "Notes/b.md", "Archive/b.md");
    scopeCrossingPromptAwaitChoice.mockResolvedValue("confirm");

    const first = renameFile(plugin, "Notes/a.md", "Archive/a.md");
    const second = renameFile(plugin, "Notes/b.md", "Archive/b.md");
    await Promise.all([first, second]);

    expect(scopeCrossingPromptMockArgs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(700);

    expect(scopeCrossingPromptMockArgs).toHaveLength(1);
    const args = scopeCrossingPromptMockArgs[0]!;
    expect(typeof args[1]).toBe("string");
    expect(typeof args[2]).toBe("string");
    // 批量合并提示行（第 4 个构造参数）应存在。
    expect(args[3]).not.toBeNull();
    // 弹框必须点名被移出的对象：首项进正文，其余项进批量行。
    expect(String(args[2])).toContain("Notes/a.md");
    expect(String(args[3])).toContain("Notes/b.md");

    await vi.waitFor(() => {
      expect(retireLocalMoveHintsByRemoteIds).toHaveBeenCalledTimes(2);
    }, { timeout: 5_000 });
    expect(retireLocalMoveHintsByRemoteIds).toHaveBeenCalledWith(["file-a"]);
    expect(retireLocalMoveHintsByRemoteIds).toHaveBeenCalledWith(["file-b"]);
    plugin.stopAutoSync();
  });

  it("keeps the prompt inside the scope when the user dismisses it", async () => {
    const { plugin, retireLocalMoveHintsByRemoteIds, seedHint } =
      makePromptPlugin();
    seedHint("file-a", "Notes/a.md", "Archive/a.md");
    scopeCrossingPromptAwaitChoice.mockResolvedValue(null);

    await renameFile(plugin, "Notes/a.md", "Archive/a.md");
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(0);

    expect(scopeCrossingPromptMockArgs).toHaveLength(1);
    expect(retireLocalMoveHintsByRemoteIds).not.toHaveBeenCalled();
    plugin.stopAutoSync();
  });

  it("opens no prompt when the destination stays inside the sync scope", async () => {
    const { plugin, retireLocalMoveHintsByRemoteIds } = makePromptPlugin();
    const shouldSyncPath = vi.fn().mockReturnValue(true);
    plugin.scanner = {
      shouldSyncPath,
      shouldSyncFolderPath: vi.fn(() => true),
    } as never;

    await renameFile(plugin, "Notes/a.md", "Notes/b.md");
    await vi.advanceTimersByTimeAsync(700);

    expect(shouldSyncPath).toHaveBeenCalled();
    expect(scopeCrossingPromptMockArgs).toHaveLength(0);
    expect(retireLocalMoveHintsByRemoteIds).not.toHaveBeenCalled();
    plugin.stopAutoSync();
  });

  it("keeps EasySync's own download recovery rename out of the scope-crossing path", async () => {
    // 真实链路：下载覆盖一个已同步文件时，插件先把旧文件改名为
    // `<path>.easy-sync-recovery` 再写回新内容。该改名同样会到达 vault
    // rename 事件，但它不是用户把文件移出同步范围。
    const { plugin, recordLocalFileMoveHint, retireLocalMoveHintsByRemoteIds } =
      makePromptPlugin();
    plugin.scanner = {
      shouldSyncPath: vi.fn((path: string) =>
        path.startsWith("Notes") && !path.endsWith(".easy-sync-recovery")),
      shouldSyncFolderPath: vi.fn(() => true),
    } as never;

    await renameFile(
      plugin,
      "Notes/a.md",
      "Notes/a.md.easy-sync-recovery",
    );
    await vi.advanceTimersByTimeAsync(700);

    expect(recordLocalFileMoveHint).not.toHaveBeenCalled();
    expect(scopeCrossingPromptMockArgs).toHaveLength(0);
    expect(retireLocalMoveHintsByRemoteIds).not.toHaveBeenCalled();
    plugin.stopAutoSync();
  });
});


describe("sync mode switch transaction (片⑥)", () => {
  function attachSyncModeHarness(plugin: EasySyncPlugin) {
    const retireLocalOnlyEntries = vi.fn().mockResolvedValue(undefined);
    const state = {
      planReviewActive: false,
      baseSnapshot: [],
      remoteSnapshot: [],
      pendingRemoteDeletes: [],
      // 未结算 mutation 台账：默认空（既有用例走"无未结算记录→正常提交"）。
      mutationLedger: [] as unknown[],
      localOnlyCopyEntries: [{
        version: 1,
        path: "note.md",
        copyPath: "note（副本）.md",
        kind: "edited",
        recordedAt: 1,
      }],
      localOnlyCreatedEntries: [
        { version: 1, path: "new-note.md", recordedAt: 1 },
      ],
      localOnlyIgnoreMemory: {
        schemaVersion: 1,
        kind: "local-only-ignore-memory",
        ignoredPaths: ["new-note.md"],
      },
      clearPlanReview: vi.fn().mockResolvedValue(true),
      retireLocalOnlyEntries,
    };
    const setSyncDirection = vi.fn();
    const syncViewRender = vi.fn();
    const refreshSyncState = vi.fn();
    plugin.state = state as never;
    // syncView 是 getter（main.ts:1515），settingsTab 是私有字段：分别用 getter
    // spy 与直接赋值替换，观察切换后的两处刷新。
    vi.spyOn(plugin, "syncView", "get").mockReturnValue({
      render: syncViewRender,
    } as never);
    plugin.settingsTab = { refreshSyncState } as never;
    plugin.syncExecutor = {
      isRunning: false,
      hasActivityInFlight: false,
      setSyncDirection,
    } as never;
    const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
      .mockResolvedValue(undefined);
    const noticeShow = vi.spyOn(plugin.noticeCenter, "show");
    return {
      state,
      setSyncDirection,
      saveSyncSettings,
      noticeShow,
      retireLocalOnlyEntries,
      syncViewRender,
      refreshSyncState,
    };
  }

  it("commits the direction through the settings write and pushes it to the executor", async () => {
    const plugin = makePlugin();
    const harness = attachSyncModeHarness(plugin);
    expect(plugin.syncDirection).toBe("two-way");

    await expect(plugin.updateSyncDirection("one-way")).resolves.toBe(true);

    expect(plugin.syncDirection).toBe("one-way");
    expect(harness.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(harness.setSyncDirection).toHaveBeenCalledWith("one-way");
    // 片⑦：两处按方向渲染的面（「自动处理」行隐藏＋E1 常驻标识）靠这次刷新
    // 立即生效（设置页组重渲染＋侧栏面板重渲染）。
    expect(harness.refreshSyncState).toHaveBeenCalled();
    expect(harness.syncViewRender).toHaveBeenCalled();
    // 不动账本：开启方向不碰任何记录/条目（关闭方向才按 per-class 作废）。
    expect(harness.retireLocalOnlyEntries).not.toHaveBeenCalled();
    expect(harness.state.localOnlyCopyEntries).toHaveLength(1);
  });

  it("retires the local-only entries when switching back to two-way, keeping files and ignore memory", async () => {
    const plugin = makePlugin();
    plugin.syncDirection = "one-way";
    const harness = attachSyncModeHarness(plugin);

    await expect(plugin.updateSyncDirection("two-way")).resolves.toBe(true);

    expect(plugin.syncDirection).toBe("two-way");
    expect(harness.setSyncDirection).toHaveBeenCalledWith("two-way");
    // per-class 作废：条目（记录）退场；忽略记忆保留（效力随模式结束）。
    expect(harness.retireLocalOnlyEntries).toHaveBeenCalledWith({
      paths: ["note.md", "new-note.md"],
      copyPaths: ["note（副本）.md"],
    });
    expect(plugin.state?.localOnlyIgnoreMemory.ignoredPaths)
      .toEqual(["new-note.md"]);
  });

  it("rejects the switch while a round or side action is in flight, without any write", async () => {
    const plugin = makePlugin();
    const harness = attachSyncModeHarness(plugin);
    (plugin.syncExecutor as never as { hasActivityInFlight: boolean })
      .hasActivityInFlight = true;

    await expect(plugin.updateSyncDirection("one-way")).resolves.toBe(false);

    expect(plugin.syncDirection).toBe("two-way");
    expect(harness.saveSyncSettings).not.toHaveBeenCalled();
    expect(harness.setSyncDirection).not.toHaveBeenCalled();
    // 不静默失败：按现役忙碌形状给出占用原因。
    expect(harness.noticeShow).toHaveBeenCalled();
  });

  it("aborts a stale operation and rolls the field back when the write fails", async () => {
    const plugin = makePlugin();
    const harness = attachSyncModeHarness(plugin);

    // 中断注入：弹框期间操作生命周期被作废 → 提交拒绝，不写任何东西。
    const epoch = plugin.captureOperationEpoch();
    (plugin as never as { operationLifecycle: { invalidate(r: string): number } })
      .operationLifecycle.invalidate("test");
    await expect(plugin.updateSyncDirection("one-way", epoch)).rejects.toThrow(
      "Operation lifecycle was invalidated",
    );
    expect(plugin.syncDirection).toBe("two-way");
    expect(harness.saveSyncSettings).not.toHaveBeenCalled();

    // 写入失败：字段回退（可重试），抛出给调用方（复用 settingsSaveFailed）。
    harness.saveSyncSettings.mockRejectedValueOnce(new Error("disk full"));
    await expect(plugin.updateSyncDirection("one-way")).rejects.toThrow(
      "disk full",
    );
    expect(plugin.syncDirection).toBe("two-way");
    expect(harness.setSyncDirection).not.toHaveBeenCalled();
  });

  it("rejects the switch while an unsettled mutation record exists, without any write", async () => {
    const plugin = makePlugin();
    const harness = attachSyncModeHarness(plugin);
    // 未结算的出站 intent 会在下一轮被 recoverMutationLedger 结算/补完——那会在
    // 单向模式下产生一笔云端写入，所以有未结算记录时必须先拒绝。
    (plugin.state as never as { mutationLedger: unknown[] }).mutationLedger = [
      {
        intent: {
          version: 1,
          operationId: "pending-upload",
          planRevision: 0,
          scope: {},
          action: "upload",
          path: "note.md",
          expectedLocal: { exists: true, hash: "h", size: 1 },
          expectedRemote: { exists: false },
          createdAt: 1,
        },
        receipt: null,
      },
    ];

    await expect(plugin.updateSyncDirection("one-way")).resolves.toBe(false);

    expect(plugin.syncDirection).toBe("two-way");
    expect(harness.saveSyncSettings).not.toHaveBeenCalled();
    expect(harness.setSyncDirection).not.toHaveBeenCalled();
    // 复用现成文案，不新增键；呈现照忙碌门形状（不静默失败）。
    expect(harness.noticeShow).toHaveBeenCalledWith(expect.objectContaining({
      message: plugin.i18n.t("notice.sideActionPendingWork"),
    }));
  });

  it("applies the unsettled-mutation gate in both directions", async () => {
    const plugin = makePlugin();
    plugin.syncDirection = "one-way";
    const harness = attachSyncModeHarness(plugin);
    (plugin.state as never as { mutationLedger: unknown[] }).mutationLedger = [
      { intent: { operationId: "pending" }, receipt: null },
    ];

    // 单向→双向同样过门（方向无关）。
    await expect(plugin.updateSyncDirection("two-way")).resolves.toBe(false);

    expect(plugin.syncDirection).toBe("one-way");
    expect(harness.saveSyncSettings).not.toHaveBeenCalled();
    expect(harness.setSyncDirection).not.toHaveBeenCalled();
    expect(harness.noticeShow).toHaveBeenCalledWith(expect.objectContaining({
      message: plugin.i18n.t("notice.sideActionPendingWork"),
    }));
  });

  it("rejects the switch on a corrupt mutation ledger, same criterion as the settings commit", async () => {
    const plugin = makePlugin();
    const harness = attachSyncModeHarness(plugin);
    // 同口径来源 state-manager.ts:5954-5963：损坏/隔离/载入阻塞与"台账非空"
    // 同属"恢复未完成"，同样拒绝（台账本身为空）。
    (plugin.state as never as { hasMutationLedgerCorruption: boolean })
      .hasMutationLedgerCorruption = true;

    await expect(plugin.updateSyncDirection("one-way")).resolves.toBe(false);

    expect(plugin.syncDirection).toBe("two-way");
    expect(harness.saveSyncSettings).not.toHaveBeenCalled();
    expect(harness.noticeShow).toHaveBeenCalled();
  });

  it("keeps the ledger untouched across both directions", async () => {
    const plugin = makePlugin();
    plugin.syncDirection = "one-way";
    const harness = attachSyncModeHarness(plugin);
    const state = plugin.state as never as Record<string, unknown>;
    // 账本事实（基线与远端快照）：切换只写 `sync-direction` 这一个键，两份
    // 指纹（以及它们的形状）一字不动；状态对象上也不新增任何记录面。
    state.baseSnapshot = [
      { path: "note.md", hash: "base-hash", size: 4, eTag: "etag-base" },
    ];
    state.remoteSnapshot = [{ path: "note.md", driveId: "d", eTag: "e" }];
    const before = JSON.stringify({
      base: state.baseSnapshot,
      remote: state.remoteSnapshot,
      keys: Object.keys(state).sort(),
    });

    await expect(plugin.updateSyncDirection("two-way")).resolves.toBe(true);
    await expect(plugin.updateSyncDirection("one-way")).resolves.toBe(true);

    expect(JSON.stringify({
      base: state.baseSnapshot,
      remote: state.remoteSnapshot,
      keys: Object.keys(state).sort(),
    })).toBe(before);
    // 唯一被动的状态面＝关闭方向时本机独有条目的 per-class 作废（记录退场）。
    expect(harness.retireLocalOnlyEntries).toHaveBeenCalledTimes(1);
    expect(harness.saveSyncSettings).toHaveBeenCalledTimes(2);
  });

  it("reports the gate counts from live facts and the disable counts from the row family", async () => {
    const plugin = makePlugin();
    attachSyncModeHarness(plugin);
    // 开启侧：一次本机扫描（只读、无网络）＋状态里的待确认删除。
    const state = plugin.state as never as Record<string, unknown>;
    state.baseSnapshot = [
      { path: "note.md", hash: "base-hash", size: 4, eTag: "etag-base" },
    ];
    state.remoteSnapshot = [
      { path: "remote-only.md", driveId: "d", size: 1, mtime: 1, eTag: "e", sha256Hash: "s" },
    ];
    state.pendingRemoteDeletes = [{ path: "gone.md" }];
    plugin.scanner = {
      scanAll: vi.fn().mockResolvedValue({
        entries: [
          // 有基线且本机改过 → 计 1。
          { path: "note.md", hash: "edited-hash", size: 9, mtime: 1, binary: false },
          // 无基线但云端已有同名 → 计 1（同样会留副本）。
          { path: "remote-only.md", hash: "same", size: 1, mtime: 1, binary: false },
          // 无基线、云端也没有 → 不计（片③ 的新建保留，不产生副本）。
          { path: "local-only.md", hash: "x", size: 1, mtime: 1, binary: false },
        ],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
    } as never;

    await expect(plugin.getSyncModeGateCounts()).resolves.toEqual({
      edited: 2,
      blockedDeletes: 1,
    });

    // 关闭侧：本机独有条目总数含被"不再提醒"的项，另一数是其中仍被忽略的。
    expect(plugin.getSyncModeDisableCounts()).toEqual({
      pendingUploads: 2,
      dismissed: 1,
    });
  });
});


describe("one-way local-only batch row and reversal entry (三件优化 件②/件③)", () => {
  function attachLocalOnlyHarness(
    plugin: EasySyncPlugin,
    options: { ignoredPaths?: string[] } = {},
  ) {
    const ignoreLocalOnlyPaths = vi.fn().mockResolvedValue(undefined);
    const clearAllLocalOnlyIgnorePaths = vi.fn().mockResolvedValue(undefined);
    const state = {
      localOnlyCopyEntries: [{
        version: 1,
        path: "note.md",
        copyPath: "note（副本）.md",
        kind: "edited",
        recordedAt: 1,
      }],
      localOnlyCreatedEntries: [
        { version: 1, path: "new-note.md", recordedAt: 1 },
        { version: 1, path: "gone.md", recordedAt: 1 },
      ],
      localOnlyIgnoreMemory: {
        schemaVersion: 1,
        kind: "local-only-ignore-memory",
        // 记忆里刻意留一条"已退场"的旧路径：面板不会列出它，计数也不该算进去。
        ignoredPaths: options.ignoredPaths ?? ["new-note.md", "已退场的旧记录.md"],
      },
      ignoreLocalOnlyPaths,
      clearAllLocalOnlyIgnorePaths,
    };
    plugin.state = state as never;
    const syncViewRender = vi.fn();
    const refreshSyncState = vi.fn();
    vi.spyOn(plugin, "syncView", "get").mockReturnValue({
      render: syncViewRender,
    } as never);
    plugin.settingsTab = { refreshSyncState } as never;
    const noticeShow = vi.spyOn(plugin.noticeCenter, "show");
    return {
      state,
      ignoreLocalOnlyPaths,
      clearAllLocalOnlyIgnorePaths,
      noticeShow,
      syncViewRender,
      refreshSyncState,
    };
  }

  it("writes the whole batch of ignores in one call and refreshes both panes (件②)", async () => {
    const plugin = makePlugin();
    plugin.syncDirection = "one-way";
    const harness = attachLocalOnlyHarness(plugin);

    await plugin.ignoreLocalOnlyEntries([
      "note（副本）.md",
      "new-note.md",
    ]);

    // 一次写入整批（键＝行代表的上传目标路径，与逐条行同一把键）。
    expect(harness.ignoreLocalOnlyPaths).toHaveBeenCalledTimes(1);
    expect(harness.ignoreLocalOnlyPaths).toHaveBeenCalledWith([
      "note（副本）.md",
      "new-note.md",
    ]);
    // 行消失即反馈：侧栏与设置页两组都刷新（设置页那一行按计数重估）。
    expect(harness.syncViewRender).toHaveBeenCalled();
    expect(harness.refreshSyncState).toHaveBeenCalled();
  });

  it("counts only the ignored entries still in the record family, and returns zero in two-way (件③)", async () => {
    const plugin = makePlugin();
    plugin.syncDirection = "one-way";
    const harness = attachLocalOnlyHarness(plugin);

    // 记录族里当前存在的三条：edited(note.md)／created(new-note.md)／created(gone.md)；
    // 记忆命中两条，其中"已退场的旧记录.md"不在族里 ⇒ 只数 1。
    expect(plugin.getIgnoredLocalOnlyCount()).toBe(1);

    const twoWay = makePlugin();
    const twoWayHarness = attachLocalOnlyHarness(twoWay);
    expect(twoWay.getIgnoredLocalOnlyCount()).toBe(0);
    await twoWay.ignoreLocalOnlyEntries(["a.md"]);
    await twoWay.clearLocalOnlyIgnores();
    expect(twoWayHarness.ignoreLocalOnlyPaths).not.toHaveBeenCalled();
    expect(twoWayHarness.clearAllLocalOnlyIgnorePaths).not.toHaveBeenCalled();
    void harness;
  });

  it("reversal clears the memory once and reports one line, without touching files (件③)", async () => {
    const plugin = makePlugin();
    plugin.syncDirection = "one-way";
    // 反馈句逐字（中文侧；英文同键见语言用例）。
    plugin.i18n = new I18n("zh-cn");
    const harness = attachLocalOnlyHarness(plugin);

    await plugin.clearLocalOnlyIgnores();

    expect(harness.clearAllLocalOnlyIgnorePaths).toHaveBeenCalledTimes(1);
    const messages = harness.noticeShow.mock.calls
      .map((entry) => (entry[0] as { message: string }).message);
    // 反馈带数量（2026-10-12 文案重设计定稿）：harness 里记录族有 1 条命中忽略记忆。
    expect(messages).toContain("已重置，1 个文件可在同步面板重新选择。");
    // 条目回归：两处按方向/计数渲染的面都刷新。
    expect(harness.syncViewRender).toHaveBeenCalled();
    expect(harness.refreshSyncState).toHaveBeenCalled();
  });

  it("reversal is a zero-action no-op when nothing is currently ignored (件③)", async () => {
    const plugin = makePlugin();
    plugin.syncDirection = "one-way";
    const harness = attachLocalOnlyHarness(plugin, {
      ignoredPaths: ["已退场的旧记录.md"],
    });

    expect(plugin.getIgnoredLocalOnlyCount()).toBe(0);
    await plugin.clearLocalOnlyIgnores();

    // 没有可收回的内容：不写记忆、不弹反馈（设置页那一行也不出现）。
    expect(harness.clearAllLocalOnlyIgnorePaths).not.toHaveBeenCalled();
    expect(harness.noticeShow).not.toHaveBeenCalled();
    expect(harness.syncViewRender).not.toHaveBeenCalled();
  });
});