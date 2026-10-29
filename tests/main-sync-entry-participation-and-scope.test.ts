// 本机范围变更与社区插件参与生命周期
// 由 tests/main-sync-entry.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
// 保留同名容器 describe，用例全名与拆分前一致。
// vi.mock 不能跨文件继承，故各主题文件各自保留同一份 mock 前置块。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationV1,
} from "../src/sync/community-plugin-participation";
import {
  makePlugin,
  attachParticipationState,
  participating,
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

  it("persists one TFile out-of-scope move hint before scheduling the file dirty run", async () => {
    vi.useFakeTimers();
    const plugin = makePlugin();
    plugin.syncInterval = 3;
    const shouldSyncPath = vi.fn((path: string) => path === "Notes/a.md");
    plugin.scanner = { shouldSyncPath, shouldSyncFolderPath: vi.fn(() => true) } as never;
    const runAutomaticSync = vi.spyOn(plugin as never, "runAutomaticSync")
      .mockResolvedValue(true);
    let releaseMoveHint!: () => void;
    const captureLocalFileMoveHint = vi.spyOn(
      plugin as never,
      "captureLocalFileMoveHint",
    ).mockImplementation(() => new Promise<void>((resolve) => {
      releaseMoveHint = resolve;
    }));
    const markLocalDirtyHint = vi.spyOn(plugin as never, "markLocalDirtyHint");

    const handled = (plugin as never as {
      handleLocalVaultRename: (
        file: TFile,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename(
      new TFile("archive/a.md"),
      "Notes/a.md",
    );

    expect(captureLocalFileMoveHint).toHaveBeenCalledOnce();
    expect(captureLocalFileMoveHint).toHaveBeenCalledWith(
      "Notes/a.md",
      "archive/a.md",
    );
    expect(markLocalDirtyHint).not.toHaveBeenCalled();
    releaseMoveHint();
    await handled;

    expect(markLocalDirtyHint).toHaveBeenCalledWith(
      "archive/a.md",
      "Notes/a.md",
    );
    await vi.advanceTimersByTimeAsync(7_000);
    expect(runAutomaticSync).toHaveBeenCalledOnce();
    plugin.stopAutoSync();
  });

  it("does not retain a file move hint when the destination stays in the sync scope", async () => {
    const plugin = makePlugin();
    const recordLocalFileMoveHint = vi.fn().mockResolvedValue(true);
    plugin.state = { recordLocalFileMoveHint } as never;

    await (plugin as never as {
      handleLocalVaultRename: (
        file: TFile,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename(
      new TFile("Notes/moved.md"),
      "Notes/a.md",
    );

    expect(recordLocalFileMoveHint).not.toHaveBeenCalled();
  });

  it("does not retain a file move hint when the destination is the vault trash", async () => {
    const plugin = makePlugin();
    plugin.scanner = {
      shouldSyncPath: vi.fn().mockReturnValue(false),
      shouldSyncFolderPath: vi.fn(() => true),
    } as never;
    const recordLocalFileMoveHint = vi.fn().mockResolvedValue(true);
    plugin.state = { recordLocalFileMoveHint } as never;

    await (plugin as never as {
      handleLocalVaultRename: (
        file: TFile,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename(
      new TFile(".trash/a.md"),
      "Notes/a.md",
    );

    expect(recordLocalFileMoveHint).not.toHaveBeenCalled();
  });

  it("retains a file move hint when the destination is out of scope and not the trash", async () => {
    const plugin = makePlugin();
    plugin.scanner = {
      shouldSyncPath: vi.fn().mockReturnValue(false),
      shouldSyncFolderPath: vi.fn(() => true),
    } as never;
    const recordLocalFileMoveHint = vi.fn().mockResolvedValue(true);
    plugin.state = { recordLocalFileMoveHint } as never;

    await (plugin as never as {
      handleLocalVaultRename: (
        file: TFile,
        oldPath: string,
      ) => Promise<void>;
    }).handleLocalVaultRename(
      new TFile("Archive/a.md"),
      "Notes/a.md",
    );

    expect(recordLocalFileMoveHint).toHaveBeenCalledOnce();
    expect(recordLocalFileMoveHint).toHaveBeenCalledWith(
      "Notes/a.md",
      "Archive/a.md",
    );
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

});