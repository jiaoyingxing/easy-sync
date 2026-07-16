import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth/auth-module", () => ({
  AuthModule: class {},
}));

vi.mock("../src/onedrive/client", () => ({
  OneDriveClient: class {},
}));

vi.mock("../src/sync/local-scanner", () => ({
  LocalScanner: class {},
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
import type { SyncResult } from "../src/sync/sync-executor";

function okResult(): SyncResult {
  return {
    success: true,
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
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
  return plugin;
}

describe("main sync entry guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("keeps the reviewed plan in state until manual sync hands off to the executor", async () => {
    const plugin = makePlugin();
    const clearPlanReview = vi.fn().mockResolvedValue(undefined);
    plugin.state = {
      planReviewActive: true,
      clearPlanReview,
    } as never;
    vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
    plugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockImplementation(async (_mode: string, _callbacks: unknown, skipConfirmation: boolean) => {
        expect(skipConfirmation).toBe(true);
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
    const clearPlanReview = vi.fn().mockResolvedValue(undefined);
    plugin.state = {
      planReviewActive: true,
      clearPlanReview,
    } as never;
    plugin.syncExecutor = {
      isRunning: false,
      run: vi.fn().mockImplementation(async (_mode: string, _callbacks: unknown, skipConfirmation: boolean) => {
        expect(skipConfirmation).toBe(true);
        expect(plugin.state?.planReviewActive).toBe(true);
        expect(clearPlanReview).not.toHaveBeenCalled();
        return okResult();
      }),
    } as never;

    await plugin.executePlanReview();

    expect(clearPlanReview).not.toHaveBeenCalled();
  });
});
