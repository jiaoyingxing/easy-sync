import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";

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
  isEasySyncInternalPath: (path: string) => path.includes("/.obsidian/plugins/easy-sync/tmp/")
    || path.startsWith(".obsidian/plugins/easy-sync/tmp/"),
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

function makePlugin(): EasySyncPlugin {
  const plugin = new EasySyncPlugin();
  plugin.app.vault.adapter.exists = vi.fn().mockResolvedValue(false);
  vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
  vi.spyOn(plugin as never, "handleSyncResult").mockResolvedValue(undefined);
  plugin.diag = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
  plugin.scanner = {
    shouldSyncPath: vi.fn(() => true),
    shouldSyncFolderPath: vi.fn(() => true),
  } as never;
  return plugin;
}

describe("resolution rows settle without forcing a full sync round", () => {
  it("retireReviewedStaleIdentity does not start a manual sync round", async () => {
    const plugin = makePlugin();
    const startManualSync = vi.spyOn(plugin as never, "startManualSync")
      .mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "runSideActionIntent")
      .mockImplementation(async (
        _path: string,
        _failureKey: string,
        action: (executor: unknown) => Promise<void>,
      ) => {
        const executor = {
          retireReviewedStaleIdentity: vi.fn().mockResolvedValue(true),
        };
        await action(executor);
        return true;
      });
    const reviewed = {
      path: "Notes",
      kind: "folder-missing-remote",
      revision: "r1",
    } as never;

    const settled = await plugin.retireReviewedStaleIdentity(reviewed);
    expect(settled).toBe(true);
    expect(startManualSync).not.toHaveBeenCalled();
  });

  it("restoreScopeCrossingMove does not start a manual sync round", async () => {
    const plugin = makePlugin();
    const startManualSync = vi.spyOn(plugin as never, "startManualSync")
      .mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "runSideActionIntent")
      .mockImplementation(async (
        _path: string,
        _failureKey: string,
        action: (executor: unknown) => Promise<void>,
      ) => {
        const executor = {
          restoreScopeCrossingMove: vi.fn().mockResolvedValue(true),
        };
        await action(executor);
        return true;
      });
    const reviewed = {
      rowPath: "Notes",
      kind: "folder",
      revision: "r1",
    } as never;

    const settled = await plugin.restoreScopeCrossingMove(reviewed);
    expect(settled).toBe(true);
    expect(startManualSync).not.toHaveBeenCalled();
  });

  it("resolveReviewedFolderLocation does not start a manual sync round", async () => {
    const plugin = makePlugin();
    const startManualSync = vi.spyOn(plugin as never, "startManualSync")
      .mockResolvedValue(undefined);
    vi.spyOn(plugin as never, "runSideActionIntent")
      .mockImplementation(async (
        _path: string,
        _failureKey: string,
        action: (executor: unknown) => Promise<void>,
      ) => {
        const executor = {
          resolveReviewedFolderLocation: vi.fn().mockResolvedValue(true),
        };
        await action(executor);
        return true;
      });
    const reviewed = {
      path: "Notes",
      revision: "r1",
    } as never;

    const settled = await plugin.resolveReviewedFolderLocation(
      reviewed,
      "keep-local",
    );
    expect(settled).toBe(true);
    expect(startManualSync).not.toHaveBeenCalled();
  });
});
