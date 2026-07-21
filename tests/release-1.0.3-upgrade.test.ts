import type { DataAdapter, Vault } from "obsidian";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MS_AUTH_CONFIG, SS_REFRESH_TOKEN } from "../src/auth/types";
import EasySyncPlugin from "../src/main";
import { LocalScanner } from "../src/sync/local-scanner";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import { SyncActionType } from "../src/sync/types";

const PLUGIN_DIR = ".obsidian/plugins/easy-sync";
const LEGACY_REMOTE_STATE_PATH = `${PLUGIN_DIR}/remote-state.json`;
const LEGACY_BASE_CONTENT_PATH = `${PLUGIN_DIR}/base-content.json`;
const LEGACY_SCAN_CACHE_PATH = `${PLUGIN_DIR}/scan-cache.json`;

function release103PluginData(autoMerge: boolean): Record<string, unknown> {
  const conflict = {
    type: SyncActionType.Conflict,
    path: "notes/conflict.md",
    reason: "reason.bothModified",
  };
  const pendingDelete = {
    type: SyncActionType.ConfirmLocalDelete,
    path: "notes/deleted-remotely.md",
  };
  return {
    "sync-interval": 7,
    "sync-plugin-files": true,
    "sync-max-file-size-mb": 128,
    "sync-diagnostic-logging": true,
    "sync-editor": true,
    "sync-appearance": false,
    "sync-themes": true,
    "sync-hotkeys": true,
    "sync-core-plugins": false,
    "sync-community-plugins": true,
    "sync-plugin-data": false,
    "auto-sync-paused": true,
    "sync-auto-merge": autoMerge,
    "easy-sync-profile-cache": { displayName: "Release User", accountId: "account-103" },
    "easy-sync-base-snapshot": {
      "notes/a.md": {
        path: "notes/a.md",
        hash: "aa".repeat(32),
        size: 12,
        eTag: "etag-a",
      },
    },
    "easy-sync-pending-conflicts": [conflict],
    "easy-sync-pending-remote-deletes": [pendingDelete],
    "easy-sync-pending-issues": [],
    "easy-sync-last-sync-time": 1_721_234_567_890,
    "easy-sync-plan-review-active": true,
    "easy-sync-plan-review-counts": {
      uploads: 0,
      downloads: 0,
      deletes: 1,
      conflicts: 1,
      skipped: 0,
    },
    "easy-sync-plan-review-items": [conflict, pendingDelete],
    "easy-sync-plan-review-digest": "legacy-review-digest",
    "easy-sync-cloud-baseline-dirty": true,
    "easy-sync-history": [],
    "easy-sync-generation": 7,
    "easy-sync-bound-account": "account-103",
    "release-1.0.3-unknown-key": { mustSurvive: true },
  };
}

function makeLegacyAdapter(): { adapter: DataAdapter; files: Map<string, string> } {
  const files = new Map<string, string>([
    [LEGACY_REMOTE_STATE_PATH, JSON.stringify({
      version: 1,
      generation: 7,
      deltaLink: "https://graph.example/release-1.0.3",
      entries: {
        "notes/a.md": {
          path: "notes/a.md",
          driveId: "remote-a",
          size: 12,
          mtime: 1,
          eTag: "etag-a",
          cTag: "ctag-a",
        },
      },
    })],
    [LEGACY_BASE_CONTENT_PATH, JSON.stringify({ "notes/a.md": "release baseline" })],
    [LEGACY_SCAN_CACHE_PATH, JSON.stringify({
      format: 1,
      entries: {
        "notes/a.md": {
          mtime: 1,
          size: 12,
          hash: "aa".repeat(32),
          binary: false,
        },
      },
    })],
  ]);
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
  } as unknown as DataAdapter;
  return { adapter, files };
}

describe("release 1.0.3 in-place upgrade", () => {
  it("retains the plugin and OAuth identity that own the 1.0.3 data and refresh token", () => {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
      id: string;
      minAppVersion: string;
      isDesktopOnly: boolean;
    };

    expect(manifest).toMatchObject({
      id: "easy-sync",
      minAppVersion: "1.11.4",
      isDesktopOnly: false,
    });
    expect(SS_REFRESH_TOKEN).toBe("easy-sync-onedrive-refresh-token");
    expect(MS_AUTH_CONFIG).toMatchObject({
      clientId: "7d9ac248-9c51-422f-8cba-49e0a6a1ed67",
      redirectUri: "obsidian://easy-sync-auth",
      scopes: ["User.Read", "offline_access", "Files.ReadWrite.AppFolder", "Files.Read"],
    });
  });

  it.each([true, false])(
    "preserves the release user's explicit auto-merge=%s choice without granting delete authority",
    async (autoMerge) => {
      const plugin = new EasySyncPlugin();
      vi.spyOn(plugin, "loadData").mockResolvedValue(release103PluginData(autoMerge));

      await expect(plugin.loadSyncSettings()).resolves.toBeUndefined();

      expect(plugin.automaticHandlingPolicy).toEqual({
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: autoMerge,
      });
    },
  );

  it("loads the full release state, fails old review authorization closed, and preserves unknown keys on first write", async () => {
    let persisted = release103PluginData(false);
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockImplementation(async () => structuredClone(persisted));
    vi.spyOn(plugin, "saveData").mockImplementation(async (next) => {
      persisted = structuredClone(next as Record<string, unknown>);
    });
    const { adapter } = makeLegacyAdapter();
    const store: PluginDataStore = {
      loadData: () => plugin.loadPluginData(),
      updatePluginData: (mutator) => (plugin as unknown as {
        updatePluginData(callback: (data: Record<string, unknown>) => void): Promise<void>;
      }).updatePluginData(mutator),
      app: { vault: { adapter, configDir: ".obsidian" } },
      manifest: { id: "easy-sync", dir: PLUGIN_DIR },
    };
    const state = new StateManager(store);

    await expect(plugin.loadSyncSettings()).resolves.toBeUndefined();
    await expect(state.load()).resolves.toBeUndefined();

    expect(plugin.syncInterval).toBe(7);
    expect(plugin.syncPluginFiles).toBe(true);
    expect(plugin.autoSyncPaused).toBe(true);
    expect(plugin.automaticHandlingPolicy).toEqual({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: false,
    });
    expect(state.baseSnapshot).toEqual([
      expect.objectContaining({ path: "notes/a.md", eTag: "etag-a" }),
    ]);
    expect(state.pendingConflicts.map((item) => item.path)).toEqual(["notes/conflict.md"]);
    expect(state.pendingRemoteDeletes.map((item) => item.path)).toEqual(["notes/deleted-remotely.md"]);
    expect(state.planReviewActive).toBe(true);
    expect(state.planReviewAuthorization).toBeNull();
    expect(state.remoteGeneration).toBe(7);
    expect(state.boundAccountId).toBe("account-103");
    expect(state.remoteScope).toBeNull();
    expect(state.remoteFolders).toEqual([]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "notes/a.md", driveId: "remote-a" }),
    ]);
    expect(state.getBaseContent("notes/a.md")).toBe("release baseline");
    expect(state.legacyAutoSyncAllowed).toBe(true);

    await expect(state.setLastSyncTime(1_800_000_000_000)).resolves.toBeUndefined();
    await expect(plugin.saveSyncSettings()).resolves.toBeUndefined();

    expect(persisted).toEqual(expect.objectContaining({
      "sync-auto-merge": false,
      "sync-auto-conflict-policy": {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: false,
      },
      "easy-sync-cloud-baseline-dirty": true,
      "easy-sync-last-sync-time": 1_800_000_000_000,
      "release-1.0.3-unknown-key": { mustSurvive: true },
    }));
  });

  it("reuses the 1.0.3 scan cache without rereading unchanged user content", async () => {
    const { adapter } = makeLegacyAdapter();
    const readBinary = vi.fn(async () => {
      throw new Error("unchanged cached content must not be read");
    });
    Object.assign(adapter, {
      readBinary,
      write: vi.fn(async () => {}),
      list: vi.fn(async () => ({ files: [], folders: [] })),
    });
    const vault = {
      adapter,
      configDir: ".obsidian",
      getFiles: vi.fn(() => [{
        path: "notes/a.md",
        stat: { mtime: 1, size: 12 },
      }]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: [],
      maxFileSize: 50 * 1024 * 1024,
      includePluginCode: false,
      includePluginData: false,
    });

    const result = await scanner.scanAll();

    expect(result).toMatchObject({ complete: true, failedPaths: [] });
    expect(result.entries).toEqual([{
      path: "notes/a.md",
      mtime: 1,
      size: 12,
      hash: "aa".repeat(32),
      binary: false,
    }]);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it("prefers a canonical current policy over a contradictory 1.0.3 fallback", async () => {
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockResolvedValue({
      ...release103PluginData(false),
      "sync-auto-conflict-policy": {
        autoDeleteLocalFiles: true,
        mergeNonOverlappingText: true,
      },
    });

    await expect(plugin.loadSyncSettings()).resolves.toBeUndefined();

    expect(plugin.automaticHandlingPolicy).toEqual({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
  });
});
