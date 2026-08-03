import type { DataAdapter, Vault } from "obsidian";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MS_AUTH_CONFIG, SS_REFRESH_TOKEN } from "../src/auth/types";
import EasySyncPlugin from "../src/main";
import { LocalScanner } from "../src/sync/local-scanner";
import { public113MigrationInputDigest } from "../src/sync/public-1-1-3-state-import";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";

const FIXTURE_PATH = "tests/fixtures/release-1.1.3-upgrade.json";
const PLUGIN_DIR = ".obsidian/plugins/easy-sync";

interface Release113Fixture {
  provenance: {
    release: string;
    kind: string;
    containsUserData: boolean;
    sourceTag: string;
    sourceCommit: string;
    releaseAssets: Record<string, { bytes: number; sha256: string }>;
    sourceFiles: Record<string, string>;
  };
  manifest: Record<string, unknown>;
  oauth: {
    secretStorageKey: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
  };
  pluginData: Record<string, unknown>;
  sidecars: Record<string, unknown>;
}

function readRelease113Fixture(): {
  fixture: Release113Fixture;
  serialized: string;
} {
  const serialized = readFileSync(FIXTURE_PATH, "utf8");
  return {
    fixture: JSON.parse(serialized) as Release113Fixture,
    serialized,
  };
}

function makeRelease113Adapter(
  fixture: Release113Fixture,
): { adapter: DataAdapter; files: Map<string, string> } {
  const files = new Map(
    Object.entries(fixture.sidecars).map(([path, value]) => [
      path,
      JSON.stringify(value),
    ]),
  );
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
    mkdir: vi.fn(async () => undefined),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()].filter((entry) => {
        const separator = entry.lastIndexOf("/");
        return (separator < 0 ? "" : entry.slice(0, separator)) === path;
      }),
      folders: [],
    })),
  } as unknown as DataAdapter;
  return { adapter, files };
}

describe("public release 1.1.3 upgrade boundary", () => {
  it("assigns every public PluginData key and sidecar to an explicit V2 disposition", () => {
    const { fixture } = readRelease113Fixture();
    const preservedSettingsIdentityAndHistory = [
      "auto-sync-paused",
      "easy-sync-bound-account",
      "easy-sync-history",
      "easy-sync-last-sync-time",
      "easy-sync-profile-cache",
      "release-1.1.3-unknown-key",
      "sync-appearance",
      "sync-auto-conflict-policy",
      "sync-auto-merge",
      "sync-community-plugins",
      "sync-core-plugins",
      "sync-diagnostic-logging",
      "sync-editor",
      "sync-excluded-folders",
      "sync-hotkeys",
      "sync-interval",
      "sync-max-file-size-mb",
      "sync-plugin-data",
      "sync-plugin-files",
      "sync-themes",
    ];
    const retainedV2ControlState = [
      "easy-sync-generation",
      "easy-sync-mutation-ledger",
      "easy-sync-plan-review-revision",
    ];
    const convertedThenRetired = [
      "easy-sync-base-snapshot",
    ];
    const retiredDeviceLocalDecisions = [
      "easy-sync-pending-conflicts",
      "easy-sync-pending-issues",
      "easy-sync-pending-remote-deletes",
      "easy-sync-plan-review-active",
      "easy-sync-plan-review-counts",
      "easy-sync-plan-review-digest",
      "easy-sync-plan-review-items",
      "easy-sync-plan-review-scope",
    ];

    expect([
      ...preservedSettingsIdentityAndHistory,
      ...retainedV2ControlState,
      ...convertedThenRetired,
      ...retiredDeviceLocalDecisions,
    ].sort()).toEqual(Object.keys(fixture.pluginData).sort());
    expect(Object.keys(fixture.sidecars).sort()).toEqual([
      `${PLUGIN_DIR}/base-content.json`,
      `${PLUGIN_DIR}/remote-state.json`,
      `${PLUGIN_DIR}/scan-cache.json`,
    ]);
  });

  it("pins the exact public tag, release assets, manifest, and OAuth identity", () => {
    const { fixture, serialized } = readRelease113Fixture();
    const currentManifest = JSON.parse(readFileSync("manifest.json", "utf8")) as {
      id: string;
      minAppVersion: string;
      isDesktopOnly: boolean;
    };

    expect(fixture.provenance).toMatchObject({
      release: "1.1.3",
      kind: "schema-exemplar",
      containsUserData: false,
      sourceTag: "1.1.3",
      sourceCommit: "01a4ac30936a89c53ddbf521e7ea9399d71e79c4",
      releaseAssets: {
        "main.js": {
          bytes: 630_669,
          sha256: "efee3d8a67a0bd7dacf7816eea92d1f1efa6498ae708f0fd137348717af3db91",
        },
        "manifest.json": {
          bytes: 321,
          sha256: "bd436312289ad658726ac3fc116755a6ab0aca3910afb0e24552d5d5192244d4",
        },
        "styles.css": {
          bytes: 17_554,
          sha256: "1d295c09152dd3070295c44f47114e336a81d69bbf24f2890529e4166ce24e10",
        },
      },
    });
    expect(fixture.provenance.sourceFiles).toMatchObject({
      "src/main.ts": "7fcde78df6d4bf684bfe99fce3363823529fea9b461e985128b47aac131d539e",
      "src/sync/sync-engine.ts": "ad708214a0421025889cd334f8d3e91b885b7df4747d55ecd425fe8a2a8aa581",
      "src/sync/sync-executor.ts": "d24af74247d08256454c14524559fcc7e03e0a65b3e9c2ee6475c70dca8fdde5",
      "src/sync/state-manager.ts": "11b1701a9487582fc3bc43a24411d04ea03aa8df0af8c5ea79d34c6ff54a94b8",
      "src/sync/types.ts": "d2243c1e34529bfcf99f332ddc7dc10b87d9c9039abb03d1c60b7d38558e7d55",
    });
    expect(createHash("sha256").update(serialized).digest("hex"))
      .toBe("300d018817d1ea6d3546d6d8e46ae01a829308be56ed955f631c7871117c8d39");
    expect(fixture.manifest).toEqual({
      id: "easy-sync",
      name: "EasySync",
      version: "1.1.3",
      minAppVersion: "1.11.4",
      description: "Two-way OneDrive sync with conflict safeguards, mobile support, and optional settings/plugin sync.",
      author: "Jiao Yingxing",
      authorUrl: "https://github.com/jiaoyingxing",
      isDesktopOnly: false,
    });
    expect(currentManifest).toMatchObject({
      id: fixture.manifest.id,
      minAppVersion: fixture.manifest.minAppVersion,
      isDesktopOnly: fixture.manifest.isDesktopOnly,
    });
    expect(SS_REFRESH_TOKEN).toBe(fixture.oauth.secretStorageKey);
    expect(MS_AUTH_CONFIG).toMatchObject({
      clientId: fixture.oauth.clientId,
      redirectUri: fixture.oauth.redirectUri,
      scopes: fixture.oauth.scopes,
    });
  });

  it("loads the complete 1.1.3 PluginData and sidecar shapes without treating current main as the source", async () => {
    const { fixture } = readRelease113Fixture();
    let persisted = structuredClone(fixture.pluginData);
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockImplementation(async () => structuredClone(persisted));
    vi.spyOn(plugin, "saveData").mockImplementation(async (next) => {
      persisted = structuredClone(next as Record<string, unknown>);
    });
    const { adapter } = makeRelease113Adapter(fixture);
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

    expect(plugin.syncInterval).toBe(3);
    expect(plugin.autoSyncChangeDelaySeconds).toBe(7);
    expect(plugin.syncPluginFiles).toBe(true);
    expect(plugin.syncMaxFileSizeMb).toBe(128);
    expect(plugin.excludedFolders).toEqual(["Private"]);
    expect(plugin.autoSyncPaused).toBe(true);
    expect(plugin.automaticHandlingPolicy).toEqual({
      autoDeleteLocalFiles: false,
      mergeNonOverlappingText: true,
    });
    expect(state.baseSnapshot.map((entry) => entry.path).sort()).toEqual([
      "notes/conflict.md",
      "notes/stable.md",
    ]);
    expect(state.pendingConflicts.map((item) => item.path)).toEqual(["notes/conflict.md"]);
    expect(state.pendingRemoteDeletes.map((item) => item.path)).toEqual([
      "notes/deleted-remotely.md",
    ]);
    expect(state.pendingIssues.map((item) => item.path)).toEqual(["notes/recover.md"]);
    expect(state.planReviewAuthorization).toEqual({
      revision: 12,
      scope: {
        accountId: "fixture-account-113",
        driveId: "fixture-drive-113",
        vaultFolderId: "fixture-vault-folder-113",
        filesRootId: "fixture-files-root-113",
      },
    });
    expect(state.mutationLedger).toEqual([
      expect.objectContaining({
        intent: expect.objectContaining({
          operationId: "release-1.1.3-interrupted-download",
          action: "download",
          path: "notes/recover.md",
        }),
        receipt: null,
      }),
    ]);
    expect(state.remoteGeneration).toBe(11);
    expect(state.boundAccountId).toBe("fixture-account-113");
    expect(state.remoteScope).toEqual(state.planReviewScope);
    expect(state.remoteFolders).toEqual([
      expect.objectContaining({
        path: "notes",
        driveId: "fixture-folder-notes",
        parentId: "fixture-files-root-113",
      }),
    ]);
    expect(state.remoteSnapshot.map((entry) => entry.path).sort()).toEqual([
      "notes/conflict.md",
      "notes/recover.md",
      "notes/stable.md",
    ]);
    await expect(state.getBaseContent("notes/stable.md"))
      .resolves.toBe("release-1.1.3 stable baseline\n");
    expect(state.legacyAutoSyncAllowed).toBe(true);

    const source = await state.readPublic113MigrationInput();
    expect(source).toMatchObject({
      baseContentStatus: "valid",
      baseContentEntries:
        fixture.sidecars[`${PLUGIN_DIR}/base-content.json`],
    });
    expect(source.baseContentRaw).toBe(JSON.stringify(
      fixture.sidecars[`${PLUGIN_DIR}/base-content.json`],
    ));
    const ancestorPreparation =
      await state.preparePublic113MigrationAncestors(source);
    expect(ancestorPreparation).toEqual({
      hashesByPath: {
        "notes/stable.md":
          "ed88b149ed4b8200429b1eba3751ea8461c260e4ffc1c489b48047132db92cab",
        "notes/conflict.md":
          "2369f0667c374bd72db2f812f457f4847e664a2b73d2737b1d62828a45dda7e5",
      },
      sourceEntries: 2,
      published: 2,
      rejected: 0,
      unavailable: 0,
    });

    await expect(state.setLastSyncTime(1_800_000_000_000)).resolves.toBeUndefined();
    await expect(plugin.saveSyncSettings()).resolves.toBeUndefined();

    expect(persisted).toEqual(expect.objectContaining({
      "auto-sync-change-delay-seconds": 7,
      "easy-sync-last-sync-time": 1_800_000_000_000,
      "easy-sync-mutation-ledger": fixture.pluginData["easy-sync-mutation-ledger"],
      "release-1.1.3-unknown-key": { mustSurvive: true },
    }));
  });

  it("keeps the complete public source digest stable across Main's migration pause lifecycle", async () => {
    const { fixture } = readRelease113Fixture();
    const pluginData = structuredClone(fixture.pluginData);
    pluginData["auto-sync-paused"] = false;
    delete pluginData["auto-sync-change-delay-seconds"];
    delete pluginData["community-plugin-sync-policy"];
    let persisted = structuredClone(pluginData);
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockImplementation(
      async () => structuredClone(persisted),
    );
    vi.spyOn(plugin, "saveData").mockImplementation(async (next) => {
      persisted = structuredClone(next as Record<string, unknown>);
    });
    const { adapter } = makeRelease113Adapter(fixture);
    const store: PluginDataStore = {
      loadData: () => plugin.loadPluginData(),
      updatePluginData: (mutator) => (plugin as unknown as {
        updatePluginData(
          callback: (data: Record<string, unknown>) => void,
        ): Promise<void>;
      }).updatePluginData(mutator),
      app: { vault: { adapter, configDir: ".obsidian" } },
      manifest: { id: "easy-sync", dir: PLUGIN_DIR },
    };
    const state = new StateManager(store);

    await plugin.loadSyncSettings();
    await state.load();
    plugin.state = state;
    vi.spyOn(plugin as never, "beginSyncNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "finishSyncNotice")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    vi.spyOn(plugin as never, "clearRibbonSuccess")
      .mockImplementation(() => undefined);
    const sourceBefore = await state.readPublic113MigrationInput();
    const digestBefore = await public113MigrationInputDigest(sourceBefore);
    const historyBefore = structuredClone(persisted["easy-sync-history"]);
    let digestAtExecutor = "";
    const pausedMessage = plugin.i18n.t("result.pausedForReview");
    const run = vi.fn().mockImplementation(async () => {
      const source = await state.readPublic113MigrationInput();
      digestAtExecutor = await public113MigrationInputDigest(source);
      expect(plugin.autoSyncPaused).toBe(true);
      expect(persisted).toEqual(expect.objectContaining({
        "auto-sync-paused": true,
        "auto-sync-change-delay-seconds": 7,
        "community-plugin-sync-policy": {
          version: 1,
          files: { mode: "all", pluginIds: [] },
          data: { mode: "all", pluginIds: [] },
        },
        "release-1.1.3-unknown-key": { mustSurvive: true },
      }));
      return {
        success: false,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
        skippedLarge: 0,
        skippedIgnored: 0,
        errors: 0,
        authExpired: false,
        message: pausedMessage,
      };
    });
    plugin.syncExecutor = { isRunning: false, run } as never;

    await (plugin as never as {
      dispatchSyncRun: (request: {
        mode: "manual";
      }) => Promise<unknown>;
    }).dispatchSyncRun({ mode: "manual" });

    const sourceAfter = await state.readPublic113MigrationInput();
    const digestAfter = await public113MigrationInputDigest(sourceAfter);
    expect(digestAtExecutor).not.toBe("");
    expect(digestBefore).not.toBe(digestAtExecutor);
    expect(digestAfter).toBe(digestAtExecutor);
    expect(persisted["easy-sync-history"]).toEqual(historyBefore);
    expect(run).toHaveBeenCalledOnce();
  });

  it("pins the public mutation ledger exemplar at its exact serialized boundary", () => {
    const { fixture } = readRelease113Fixture();
    const ledger = fixture.pluginData["easy-sync-mutation-ledger"] as Array<{
      intent: Record<string, unknown>;
      receipt: unknown;
    }>;
    const serializedLedger = JSON.stringify(ledger);

    expect(Buffer.byteLength(serializedLedger)).toBe(473);
    expect(createHash("sha256").update(serializedLedger).digest("hex"))
      .toBe("3c1cf1b90d8bad54959e5a4a03ad615c1ee5793ee118cfc166be48327582268e");
    expect(Object.keys(ledger[0])).toEqual(["intent", "receipt"]);
    expect(Object.keys(ledger[0].intent)).toEqual([
      "version",
      "operationId",
      "planRevision",
      "scope",
      "action",
      "path",
      "expectedLocal",
      "expectedRemote",
      "createdAt",
    ]);
    expect(ledger[0].receipt).toBeNull();
  });

  it("preserves the public parser's empty account, receipt checkpoint, and unknown fields", async () => {
    const { fixture } = readRelease113Fixture();
    const sourceLedger = structuredClone(
      fixture.pluginData["easy-sync-mutation-ledger"],
    ) as Array<{ intent: Record<string, unknown> }>;
    const sourceIntent = sourceLedger[0].intent;
    const sourceScope = sourceIntent.scope as Record<string, unknown>;
    const remoteState = fixture.sidecars[
      `${PLUGIN_DIR}/remote-state.json`
    ] as {
      entries: Record<string, Record<string, unknown>>;
    };
    const baseSnapshot = fixture.pluginData[
      "easy-sync-base-snapshot"
    ] as Record<string, Record<string, unknown>>;
    const operationId = "release-1.1.3-receipted-empty-account";
    const releaseCompatibleLedger = [{
      intent: {
        ...sourceIntent,
        operationId,
        scope: {
          ...sourceScope,
          accountId: "",
        },
        releaseFutureIntentField: { mustSurvive: true },
      },
      receipt: {
        version: 1,
        operationId,
        completedAt: 1_721_234_506_000,
        checkpoint: {
          baseUpserts: [baseSnapshot["notes/stable.md"]],
          baseRemovals: ["notes/old-base.md"],
          remoteUpserts: [remoteState.entries["notes/stable.md"]],
          remoteDeletes: ["notes/old-remote.md"],
          pendingConflictRemovals: ["notes/old-conflict.md"],
          pendingDeleteRemovals: ["notes/old-delete.md"],
          releaseFutureCheckpointField: { mustSurvive: true },
        },
        releaseFutureReceiptField: { mustSurvive: true },
      },
      releaseFutureEntryField: { mustSurvive: true },
    }];
    const pluginData = {
      ...structuredClone(fixture.pluginData),
      "easy-sync-mutation-ledger": releaseCompatibleLedger,
    };
    let persisted = structuredClone(pluginData);
    const plugin = new EasySyncPlugin();
    vi.spyOn(plugin, "loadData").mockImplementation(
      async () => structuredClone(persisted),
    );
    vi.spyOn(plugin, "saveData").mockImplementation(async (next) => {
      persisted = structuredClone(next as Record<string, unknown>);
    });
    const { adapter } = makeRelease113Adapter(fixture);
    const store: PluginDataStore = {
      loadData: () => plugin.loadPluginData(),
      updatePluginData: (mutator) => (plugin as unknown as {
        updatePluginData(callback: (data: Record<string, unknown>) => void): Promise<void>;
      }).updatePluginData(mutator),
      app: { vault: { adapter, configDir: ".obsidian" } },
      manifest: { id: "easy-sync", dir: PLUGIN_DIR },
    };
    const state = new StateManager(store);

    await expect(state.load()).resolves.toBeUndefined();

    expect(state.hasMutationLedgerCorruption).toBe(false);
    expect(state.mutationLedger).toEqual(releaseCompatibleLedger);
    expect(state.mutationLedger[0].intent.scope.accountId).toBe("");
    expect(Object.keys(state.mutationLedger[0].receipt!.checkpoint).sort())
      .toEqual([
        "baseRemovals",
        "baseUpserts",
        "pendingConflictRemovals",
        "pendingDeleteRemovals",
        "releaseFutureCheckpointField",
        "remoteDeletes",
        "remoteUpserts",
      ]);

    const source = await state.readPublic113MigrationInput();
    expect(source.pluginData["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);

    await state.setLastSyncTime(1_800_000_000_001);

    expect(persisted["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
  });

  it("reuses the public 1.1.3 format-1 scan cache without rereading unchanged content", async () => {
    const { fixture } = readRelease113Fixture();
    const { adapter } = makeRelease113Adapter(fixture);
    const readBinary = vi.fn(async () => {
      throw new Error("unchanged 1.1.3 cached content must not be read");
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
        path: "notes/stable.md",
        stat: { mtime: 1_721_234_500_000, size: 30 },
      }]),
    } as unknown as Vault;
    const scanner = new LocalScanner(vault, {
      excludePaths: [],
      includePaths: [],
      maxFileSize: 500 * 1024 * 1024,
      includePluginCode: false,
      includePluginData: false,
    });

    const result = await scanner.scanAll();

    expect(result).toMatchObject({ complete: true, failedPaths: [] });
    expect(result.entries).toEqual([{
      path: "notes/stable.md",
      mtime: 1_721_234_500_000,
      size: 30,
      hash: "ed88b149ed4b8200429b1eba3751ea8461c260e4ffc1c489b48047132db92cab",
      binary: false,
    }]);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it("keeps the older 1.0.3 test as a separate historical guard", () => {
    const historicalGuard = readFileSync("tests/release-1.0.3-upgrade.test.ts", "utf8");

    expect(historicalGuard).toContain('describe("release 1.0.3 in-place upgrade"');
    expect(historicalGuard).not.toContain("public release 1.1.3 upgrade boundary");
  });
});
