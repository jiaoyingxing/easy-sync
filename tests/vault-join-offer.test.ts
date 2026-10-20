/**
 * EasySync repository join offer (carrier 20261003-2128, R1) — main-layer
 * behavior: gate conditions, name comparison, count-only offer, the
 * offer→list→offer loop, RS priority at the first-sync wiring points, and
 * the fresh-login notice. 2026-10-10 追加：首同步前两次询问的并发预取（R4）、
 * 只读准备期可取消（R1）与 RS 检测失败可见化（R2）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const vaultJoinAwaitAction = vi.hoisted(() => vi.fn());
const vaultJoinArgs = vi.hoisted(() => [] as unknown[][]);
const vaultJoinListAwaitAction = vi.hoisted(() => vi.fn());
const vaultJoinListArgs = vi.hoisted(() => [] as unknown[][]);

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
  isEasySyncInternalPath: () => false,
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

vi.mock("../src/ui/scope-crossing-prompt-modal", () => ({
  ScopeCrossingPromptModal: class {},
}));

vi.mock("../src/ui/vault-join-offer-modal", () => ({
  VaultJoinOfferModal: class {
    awaitAction = vaultJoinAwaitAction;
    constructor(...args: unknown[]) {
      vaultJoinArgs.push(args);
    }
  },
}));

vi.mock("../src/ui/vault-join-repository-list-modal", () => ({
  VaultJoinRepositoryListModal: class {
    awaitAction = vaultJoinListAwaitAction;
    constructor(...args: unknown[]) {
      vaultJoinListArgs.push(args);
    }
  },
}));

import EasySyncPlugin from "../src/main";
import { OneDriveDriveUnavailableError } from "../src/onedrive/types";
import { NOTICE_PRIORITY } from "../src/ui/notice-center";

function makePlugin(): {
  plugin: EasySyncPlugin;
  t: ReturnType<typeof vi.fn>;
} {
  const plugin = new EasySyncPlugin();
  plugin.diag = {
    isEnabled: vi.fn().mockReturnValue(false),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
  const t = vi.fn((key: string) => key);
  plugin.i18n = { t, language: "zh-cn" } as never;
  plugin.noticeCenter = {
    show: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  } as never;
  vi.spyOn(plugin.app.vault, "getName").mockReturnValue("奇奇怪怪");
  return { plugin, t };
}

/** 检测层的注入：数组＝「有活仓但都不同名」（名单完整），`"same-name"`＝同名
 *  快通道命中（名单未列举，2026-10-10 R3），Error＝检测失败。 */
type DetectionInput = string[] | Error | "same-name";

function attachDetection(
  plugin: EasySyncPlugin,
  detection: DetectionInput,
): { detect: ReturnType<typeof vi.fn> } {
  const detect = vi.fn();
  if (detection instanceof Error) {
    detect.mockRejectedValue(detection);
  } else if (detection === "same-name") {
    detect.mockResolvedValue({ kind: "same-name" });
  } else if (detection.length === 0) {
    detect.mockResolvedValue({ kind: "none" });
  } else {
    detect.mockResolvedValue({ kind: "others", repositories: detection });
  }
  plugin.onedrive = { detectExistingEasySyncRepositories: detect } as never;
  plugin.syncExecutor = { isRunning: false } as never;
  plugin.state = {
    lastSyncTime: 0,
    baseSnapshot: [],
    planReviewActive: false,
  } as never;
  plugin.auth = {
    authState: { isLoggedIn: true, accountId: "account" },
  } as never;
  return { detect };
}

function callOffer(plugin: EasySyncPlugin): Promise<string> {
  return (plugin as never as {
    maybeOfferExistingVaultJoin(): Promise<string>;
  }).maybeOfferExistingVaultJoin();
}

function callNotice(plugin: EasySyncPlugin): Promise<void> {
  return (plugin as never as {
    offerVaultJoinNoticeAfterFreshLogin(): Promise<void>;
  }).offerVaultJoinNoticeAfterFreshLogin();
}

describe("maybeOfferExistingVaultJoin", () => {
  afterEach(() => {
    vaultJoinAwaitAction.mockReset();
    vaultJoinArgs.length = 0;
    vaultJoinListAwaitAction.mockReset();
    vaultJoinListArgs.length = 0;
    vi.restoreAllMocks();
  });

  it("continues the plain first sync when the cloud has no EasySync repositories", async () => {
    const { plugin } = makePlugin();
    const { detect } = attachDetection(plugin, []);

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(detect).toHaveBeenCalledOnce();
    expect(vaultJoinArgs).toHaveLength(0);
  });

  it("continues without an offer when a repository name matches byte-for-byte", async () => {
    const { plugin } = makePlugin();
    attachDetection(plugin, ["其他库", "奇奇怪怪"]);

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(vaultJoinArgs).toHaveLength(0);
  });

  it("offers the join when the only repository differs by letter case", async () => {
    const { plugin } = makePlugin();
    vi.spyOn(plugin.app.vault, "getName").mockReturnValue("Notes");
    attachDetection(plugin, ["notes"]);
    vaultJoinAwaitAction.mockResolvedValue({ action: "dismiss" });

    await expect(callOffer(plugin)).resolves.toBe("abort");
    expect(vaultJoinArgs).toHaveLength(1);
    const views = vaultJoinArgs[0]?.[1] as Record<string, unknown>;
    expect(views.title).toBe("vaultJoin.offerTitle");
    expect(views.body).toBe("vaultJoin.offerBody");
    expect(views.join).toMatchObject({ title: "vaultJoin.offerJoinTitle" });
    expect(views.fresh).toMatchObject({ title: "vaultJoin.offerFreshTitle" });
  });

  it("names only the repository count in the offer body", async () => {
    const { plugin, t } = makePlugin();
    attachDetection(plugin, ["工作库", "生活库"]);
    vaultJoinAwaitAction.mockResolvedValue({ action: "fresh-sync" });

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(t).toHaveBeenCalledWith("vaultJoin.offerBody", { count: 2 });
    expect(t).not.toHaveBeenCalledWith(
      "vaultJoin.offerBody",
      expect.objectContaining({ vaults: expect.anything() }),
    );
  });

  it("opens the repository list on join, then returns to the offer until a decision", async () => {
    const { plugin } = makePlugin();
    attachDetection(plugin, ["工作库", "生活库"]);
    vaultJoinAwaitAction
      .mockResolvedValueOnce({ action: "join" })
      .mockResolvedValueOnce({ action: "fresh-sync" });
    vaultJoinListAwaitAction.mockResolvedValue(undefined);

    await expect(callOffer(plugin)).resolves.toBe("continue");

    expect(vaultJoinAwaitAction).toHaveBeenCalledTimes(2);
    expect(vaultJoinListAwaitAction).toHaveBeenCalledOnce();
    const listViews = vaultJoinListArgs[0]?.[1] as Record<string, unknown>;
    expect(listViews.title).toBe("vaultJoin.listTitle");
    expect(listViews.rows).toEqual(["工作库", "生活库"]);
    expect(listViews.copiedNotice).toBe("vaultJoin.nameCopied");
  });

  it("stops this round when the offer is dismissed", async () => {
    const { plugin } = makePlugin();
    attachDetection(plugin, ["工作库"]);
    vaultJoinAwaitAction.mockResolvedValue({ action: "dismiss" });

    await expect(callOffer(plugin)).resolves.toBe("abort");
    expect(vaultJoinListAwaitAction).not.toHaveBeenCalled();
  });

  it("stays silent when the same-name fast path answered without listing", async () => {
    // 快通道命中（名单未列举）：这条路上既不弹框也不能弹登录提示（零打扰不变）。
    const { plugin } = makePlugin();
    attachDetection(plugin, "same-name");

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(vaultJoinArgs).toHaveLength(0);
  });

  it("continues the plain first sync when detection fails, with a diagnostic note", async () => {
    const { plugin } = makePlugin();
    attachDetection(plugin, new Error("network down"));

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(vaultJoinArgs).toHaveLength(0);
    expect((plugin.diag as never as { warn: ReturnType<typeof vi.fn> }).warn)
      .toHaveBeenCalled();
  });

  it("never runs for vaults that already completed a sync", async () => {
    const { plugin } = makePlugin();
    const { detect } = attachDetection(plugin, ["工作库"]);
    plugin.state = {
      lastSyncTime: 1,
      baseSnapshot: [],
      planReviewActive: false,
    } as never;

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(detect).not.toHaveBeenCalled();
  });

  it("never runs while a plan review is pending", async () => {
    const { plugin } = makePlugin();
    const { detect } = attachDetection(plugin, ["工作库"]);
    (plugin.state as never as { planReviewActive: boolean }).planReviewActive = true;

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(detect).not.toHaveBeenCalled();
  });

  it("never runs while logged out", async () => {
    const { plugin } = makePlugin();
    const { detect } = attachDetection(plugin, ["工作库"]);
    (plugin.auth as never as { authState: { isLoggedIn: boolean } })
      .authState.isLoggedIn = false;

    await expect(callOffer(plugin)).resolves.toBe("continue");
    expect(detect).not.toHaveBeenCalled();
  });
});

describe("offerVaultJoinNoticeAfterFreshLogin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the one-shot notice naming only the count", async () => {
    const { plugin, t } = makePlugin();
    attachDetection(plugin, ["工作库"]);
    const show = (plugin.noticeCenter as never as { show: ReturnType<typeof vi.fn> })
      .show;

    await callNotice(plugin);

    expect(t).toHaveBeenCalledWith("vaultJoin.detectNotice", { count: 1 });
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0]?.[0]).toMatchObject({
      key: "vault-join-detect",
      priority: NOTICE_PRIORITY.info,
    });
  });

  it("stays silent when a repository already matches this vault's name", async () => {
    const { plugin } = makePlugin();
    attachDetection(plugin, ["奇奇怪怪"]);
    const show = (plugin.noticeCenter as never as { show: ReturnType<typeof vi.fn> })
      .show;

    await callNotice(plugin);

    expect(show).not.toHaveBeenCalled();
  });

  it("stays silent on detection failure", async () => {
    const { plugin } = makePlugin();
    attachDetection(plugin, new Error("network down"));
    const show = (plugin.noticeCenter as never as { show: ReturnType<typeof vi.fn> })
      .show;

    await callNotice(plugin);

    expect(show).not.toHaveBeenCalled();
  });
});

function attachFirstSyncHarness(plugin: EasySyncPlugin) {
  plugin.state = {
    planReviewActive: false,
    hasV2RemoteScopeRecovery: false,
  } as never;
  plugin.syncExecutor = { isRunning: false } as never;
  vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
  vi.spyOn(plugin as never, "dispatchV2StateLoadBlockIfPresent")
    .mockResolvedValue(false);
  vi.spyOn(plugin as never, "checkAccountBindingForSync").mockResolvedValue(true);
  const panel = vi.spyOn(plugin, "activateSyncView").mockResolvedValue(undefined);
  const dispatch = vi.spyOn(plugin as never, "dispatchSyncRun")
    .mockResolvedValue(undefined);
  const migrate = vi.spyOn(plugin as never, "maybeRunRsMigrationOffer");
  const join = vi.spyOn(plugin as never, "maybeOfferExistingVaultJoin");
  return { dispatch, migrate, join, panel };
}

describe("startFirstSync join-offer wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips the join offer when the Remotely Save adoption ran this round", async () => {
    const { plugin } = makePlugin();
    const harness = attachFirstSyncHarness(plugin);
    harness.migrate.mockResolvedValue("migrated");
    harness.join.mockResolvedValue("continue");

    await plugin.startFirstSync();

    expect(harness.join).not.toHaveBeenCalled();
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it("runs the join offer when no Remotely Save repository is paired", async () => {
    const { plugin } = makePlugin();
    const harness = attachFirstSyncHarness(plugin);
    harness.migrate.mockResolvedValue("fresh");
    harness.join.mockResolvedValue("continue");

    await plugin.startFirstSync();

    expect(harness.join).toHaveBeenCalledOnce();
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it("stops before dispatch when the join offer aborts the round", async () => {
    const { plugin } = makePlugin();
    const harness = attachFirstSyncHarness(plugin);
    harness.migrate.mockResolvedValue("fresh");
    harness.join.mockResolvedValue("abort");

    await plugin.startFirstSync();

    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("opens the sync panel before the repository detections", async () => {
    // 2026-10-10 拍板：面板先开——用户点完同步马上能在侧栏看到「同步进行中…」，
    // 而不是等云端仓库检测（首同步实测 6.5s+）跑完才把面板弹出来。
    const { plugin } = makePlugin();
    const harness = attachFirstSyncHarness(plugin);
    const order: string[] = [];
    harness.panel.mockImplementation(async () => { order.push("panel"); });
    harness.migrate.mockImplementation(async () => {
      order.push("rs");
      return "fresh";
    });
    harness.join.mockImplementation(async () => {
      order.push("join");
      return "continue";
    });

    await plugin.startFirstSync();

    expect(order).toEqual(["panel", "rs", "join"]);
  });
});

describe("sync entry preparation (2026-10-10: R4 并发预取 / R1 只读准备期可取消)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function attachInquiryDeps(
    plugin: EasySyncPlugin,
  ): { detect: ReturnType<typeof vi.fn>; setAbortSignal: ReturnType<typeof vi.fn> } {
    const detect = vi.fn().mockResolvedValue({ kind: "none" });
    const setAbortSignal = vi.fn();
    plugin.onedrive = {
      detectExistingEasySyncRepositories: detect,
      setAbortSignal,
    } as never;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    return { detect, setAbortSignal };
  }

  it("prefetches the join detection while the Remotely Save inquiry is still running", async () => {
    // R4：两个只读检测互不依赖，加入检测必须在 RS 询问还没回来时就已经发出。
    const { plugin } = makePlugin();
    const harness = attachFirstSyncHarness(plugin);
    const { detect } = attachInquiryDeps(plugin);
    let releaseRs = (): void => {};
    const rsGate = new Promise<void>((resolve) => {
      releaseRs = resolve;
    });
    harness.migrate.mockImplementation(async () => {
      await rsGate;
      return "fresh";
    });
    harness.join.mockResolvedValue("continue");

    const pending = plugin.startFirstSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.migrate).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalled(); // RS 尚未返回，加入检测已发出＝并发

    releaseRs();
    await pending;
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it("arms the entry cancel for the read-only wait and clears it after dispatch", async () => {
    // R1：等待段可取消（armed）；结束时必须收回并清空中止信号——否则留下一枚
    // 已中止的信号会让后续所有云端请求立刻失败。
    const { plugin } = makePlugin();
    const harness = attachFirstSyncHarness(plugin);
    const { setAbortSignal } = attachInquiryDeps(plugin);
    let releaseRs = (): void => {};
    const rsGate = new Promise<void>((resolve) => {
      releaseRs = resolve;
    });
    harness.migrate.mockImplementation(async () => {
      await rsGate;
      return "fresh";
    });
    harness.join.mockResolvedValue("continue");

    const pending = plugin.startFirstSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plugin.isSyncEntryCancellable).toBe(true);

    releaseRs();
    await pending;

    expect(plugin.isSyncEntryCancellable).toBe(false);
    expect(setAbortSignal).toHaveBeenCalledTimes(2);
    expect(setAbortSignal.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(setAbortSignal.mock.calls[1]?.[0]).toBeNull();
  });

  it("ends the round without dispatching when the user cancels the preparation", async () => {
    const { plugin } = makePlugin();
    const harness = attachFirstSyncHarness(plugin);
    attachInquiryDeps(plugin);
    let releaseRs = (): void => {};
    const rsGate = new Promise<void>((resolve) => {
      releaseRs = resolve;
    });
    harness.migrate.mockImplementation(async () => {
      await rsGate;
      return "fresh";
    });
    harness.join.mockResolvedValue("continue");
    const noticeShow = (plugin.noticeCenter as never as {
      show: ReturnType<typeof vi.fn>;
    }).show;

    const pending = plugin.startFirstSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(plugin.isSyncEntryCancellable).toBe(true);

    await plugin.cancelSync();
    expect(noticeShow).toHaveBeenCalledWith(
      expect.objectContaining({ key: "sync-entry-cancelled" }),
    );

    releaseRs();
    await pending;

    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(plugin.isSyncEntryCancellable).toBe(false);
  });
});

describe("Remotely Save detection failure visibility (2026-10-10 R2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function attachRsDeps(
    plugin: EasySyncPlugin,
    failure: Error,
    driveFailure?: Error,
  ): { show: ReturnType<typeof vi.fn> } {
    plugin.onedrive = {
      ensureDriveAvailable: driveFailure
        ? vi.fn().mockRejectedValue(driveFailure)
        : vi.fn().mockResolvedValue(undefined),
      detectRemotelySaveRepository: vi.fn().mockRejectedValue(failure),
      setAbortSignal: vi.fn(),
    } as never;
    plugin.syncExecutor = { isRunning: false } as never;
    plugin.state = {
      lastSyncTime: 0,
      baseSnapshot: [],
      planReviewActive: false,
    } as never;
    plugin.auth = { authState: { isLoggedIn: true } } as never;
    return (plugin.noticeCenter as never as { show: ReturnType<typeof vi.fn> });
  }

  function callRsOffer(plugin: EasySyncPlugin): Promise<string> {
    return (plugin as never as {
      maybeRunRsMigrationOffer(): Promise<string>;
    }).maybeRunRsMigrationOffer();
  }

  it("tells the user why nothing happened instead of ending the round silently", async () => {
    const { plugin } = makePlugin();
    const notice = attachRsDeps(plugin, new Error("network down"));

    await expect(callRsOffer(plugin)).resolves.toBe("abort");

    expect(notice.show).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "rs-migration-detect-failed",
        message: "rsMigration.detectFailedNotice",
      }),
    );
  });

  it("names the account-level cause when the drive itself is unavailable", async () => {
    const { plugin } = makePlugin();
    const driveFailure = new OneDriveDriveUnavailableError();
    const notice = attachRsDeps(plugin, driveFailure, driveFailure);
    const detect = (plugin.onedrive as never as {
      detectRemotelySaveRepository: ReturnType<typeof vi.fn>;
    }).detectRemotelySaveRepository;

    await expect(callRsOffer(plugin)).resolves.toBe("abort");

    expect(detect).not.toHaveBeenCalled();
    expect(notice.show).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "rs-migration-no-onedrive",
        message: "rsMigration.noOneDriveNotice",
      }),
    );
  });

  it("keeps a user cancel silent (cancel is not a detection failure)", async () => {
    const { plugin } = makePlugin();
    const notice = attachRsDeps(plugin, new Error("aborted"));
    (plugin as never as { entryCancelController: unknown }).entryCancelController = {
      signal: AbortSignal.abort(),
    };
    const warn = (plugin.diag as never as { warn: ReturnType<typeof vi.fn> }).warn;

    await expect(callRsOffer(plugin)).resolves.toBe("abort");

    expect(notice.show).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
