import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import type { DriveItem } from "../src/onedrive/types";
import type { LocalFileEntry } from "../src/sync/types";
import { getEasySyncPaths } from "../src/obsidian-compat";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import { SyncExecutor } from "../src/sync/sync-executor";
import {
  migrateV1ToV2,
  readStateV2Manifest,
  v1BackupCleanupAllowed,
  type StateV2MigrationInput,
  type StateV2MigrationPaths,
} from "../src/sync/state-v2-migration";
import {
  STATE_V1_MIGRATION_CASES,
  migrationCase,
  type MigrationFixture,
} from "./fixtures/state-v1-migration-cases";

const paths: StateV2MigrationPaths = {
  committed: "plugin/state-v2.json",
  next: "plugin/state-v2.next.json",
  previous: "plugin/state-v2.previous.json",
  recovery: "plugin/state-v2.recovery.json",
  manifest: "plugin/state-v2.manifest.json",
  manifestNext: "plugin/state-v2.manifest.next.json",
  v1Backup: "plugin/state-v1.backup.json",
};

function makeAdapter() {
  const files = new Map<string, string>();
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
    remove: vi.fn(async (path: string) => { files.delete(path); }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
  };
  return { adapter: adapter as unknown as DataAdapter, files, spies: adapter };
}

function toInput(fixture: MigrationFixture): StateV2MigrationInput {
  const localEntries: LocalFileEntry[] = fixture.local.map((entry) => ({
    ...entry,
    mtime: 1,
    binary: false,
  }));
  const remoteItems: DriveItem[] = fixture.remote
    .filter((entry) => entry.parentId !== null)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      size: entry.size,
      eTag: entry.eTag,
      parentReference: { id: entry.parentId! },
      ...(entry.kind === "folder"
        ? { folder: {} }
        : { file: { hashes: entry.contentHash ? { sha256Hash: entry.contentHash } : undefined } }),
    }));
  return {
    scope: {
      accountId: fixture.accountId,
      driveId: fixture.driveId,
      vaultFolderId: fixture.vaultFolderId,
      filesRootId: fixture.filesRootId,
    },
    lifecycleEpoch: fixture.v1Generation,
    localScanComplete: fixture.localScanComplete,
    remoteScanComplete: fixture.remoteScanComplete,
    localEntries,
    remoteItems,
    v1Base: fixture.v1Base,
    v1Snapshot: { base: fixture.v1Base, deltaLink: fixture.v1DeltaLink },
    cloudHints: fixture.cloudAnchors,
    now: 1234,
  };
}

describe("production V1 to V2 migration", () => {
  it.each(STATE_V1_MIGRATION_CASES.map((fixture) => [fixture.id, fixture] as const))(
    "runs %s through real V2 serialization with no user-file mutation",
    async (id, fixture) => {
      const { adapter, files } = makeAdapter();
      const result = await migrateV1ToV2(adapter, paths, toInput(fixture));

      expect(result.mutations).toEqual([]);
      if (id === "missing-drive-id") {
        expect(result).toMatchObject({ status: "aborted", reason: "remote-identity-incomplete" });
        expect(files.size).toBe(0);
        return;
      }
      expect(result.status).toBe("committed");
      expect(result.envelope?.remoteIndex.deltaLink).toBeNull();
      expect(result.manifest?.legacyAutoSyncAllowed).toBe(false);
      expect(files.has(paths.v1Backup)).toBe(true);
      expect(files.has(paths.manifest)).toBe(true);
      expect(await readStateV2Manifest(adapter, paths.manifest)).toEqual(result.manifest);
    },
  );

  it("publishes nothing when either full scan is incomplete", async () => {
    const { adapter, files } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    input.localScanComplete = false;

    await expect(migrateV1ToV2(adapter, paths, input)).resolves.toMatchObject({
      status: "aborted",
      reason: "scan-incomplete",
      mutations: [],
    });
    expect(files.size).toBe(0);
  });

  it("keeps the V1 backup and committed envelope when manifest publication fails, then resumes", async () => {
    const { adapter, files, spies } = makeAdapter();
    const input = toInput(migrationCase("normal-v1"));
    const originalRename = spies.rename.getMockImplementation()!;
    spies.rename.mockImplementation(async (from: string, to: string) => {
      if (from === paths.manifestNext) throw new Error("manifest rename failed");
      return originalRename(from, to);
    });

    await expect(migrateV1ToV2(adapter, paths, input)).resolves.toMatchObject({
      status: "aborted",
      reason: "state-save-failure",
      mutations: [],
    });
    expect(files.has(paths.committed)).toBe(true);
    expect(files.has(paths.v1Backup)).toBe(true);
    expect(files.has(paths.manifest)).toBe(false);

    spies.rename.mockImplementation(originalRename);
    await expect(migrateV1ToV2(adapter, paths, input)).resolves.toMatchObject({ status: "committed" });
    expect(files.has(paths.manifest)).toBe(true);
  });

  it("does not clean V1 backup until every recovery gate is healthy", () => {
    expect(v1BackupCleanupAllowed({
      desktopHealthy: true,
      mobileHealthy: true,
      cloudBootstrapV2Published: true,
      recoveryJournalsEmpty: false,
    })).toBe(false);
    expect(v1BackupCleanupAllowed({
      desktopHealthy: true,
      mobileHealthy: true,
      cloudBootstrapV2Published: true,
      recoveryJournalsEmpty: true,
    })).toBe(true);
  });

  it("loads the manifest as a hard gate for every legacy sync writer", async () => {
    const { adapter, files } = makeAdapter();
    const actualPaths = getEasySyncPaths(".obsidian");
    const manifest = {
      schemaVersion: 2,
      activeState: "state-v2.json",
      stateCommitSeq: 1,
      lifecycleEpoch: 2,
      scope: { accountId: "account", driveId: "drive", vaultFolderId: "vault", filesRootId: "root" },
      migratedAt: 1234,
      legacyAutoSyncAllowed: false,
    };
    files.set(actualPaths.stateV2ManifestFile, JSON.stringify(manifest));
    const plugin: PluginDataStore = {
      loadData: vi.fn().mockResolvedValue({}),
      updatePluginData: vi.fn().mockResolvedValue(undefined),
      app: { vault: { adapter, configDir: ".obsidian" } },
      manifest: { id: "easy-sync", dir: actualPaths.pluginDir },
    };
    const state = new StateManager(plugin);
    await state.load();

    expect(state.legacyAutoSyncAllowed).toBe(false);
    await expect(state.reset()).rejects.toThrow("disabled");
    const executor = new SyncExecutor(
      {} as never,
      {} as never,
      {} as never,
      state,
      "vault",
    );
    await expect(executor.run("auto")).resolves.toMatchObject({
      success: false,
      errors: 1,
      message: "result.legacyStateDisabled",
    });
  });
});
