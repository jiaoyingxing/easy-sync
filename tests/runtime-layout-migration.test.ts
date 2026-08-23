import type { DataAdapter } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
  getEasySyncLegacyPaths,
  getEasySyncPaths,
} from "../src/obsidian-compat";
import {
  EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD,
  EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY,
  EasySyncRuntimeLayoutMigrationConflict,
  ensureEasySyncRuntimeLayoutMigration,
  noteHealthySyncAndCleanupEasySyncRuntimeLayout,
} from "../src/sync/runtime-layout-migration";

function makeAdapter(initial: Record<string, string> = {}): {
  adapter: DataAdapter;
  files: Map<string, string>;
  directories: Set<string>;
} {
  const files = new Map(Object.entries(initial));
  const directories = new Set<string>([".obsidian", ".obsidian/plugins"]);
  for (const path of files.keys()) {
    const parts = path.split("/");
    parts.pop();
    for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || directories.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      const separator = path.lastIndexOf("/");
      const parent = separator < 0 ? "" : path.slice(0, separator);
      if (parent && !directories.has(parent)) {
        throw new Error(`missing parent directory: ${parent}`);
      }
      files.set(path, value);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    mkdir: vi.fn(async (path: string) => {
      directories.add(path);
    }),
    rmdir: vi.fn(async (path: string, recursive: boolean) => {
      if (recursive) {
        for (const file of [...files.keys()]) {
          if (file === path || file.startsWith(`${path}/`)) files.delete(file);
        }
        for (const directory of [...directories]) {
          if (directory === path || directory.startsWith(`${path}/`)) directories.delete(directory);
        }
        return;
      }
      const hasChildren = [...files.keys(), ...directories]
        .some((child) => child.startsWith(`${path}/`));
      if (hasChildren) {
        throw new Error(`directory is not empty: ${path}`);
      }
      directories.delete(path);
    }),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()].filter((file) => {
        const index = file.lastIndexOf("/");
        return (index < 0 ? "" : file.slice(0, index)) === path;
      }),
      folders: [...directories].filter((directory) => {
        const index = directory.lastIndexOf("/");
        return (index < 0 ? "" : directory.slice(0, index)) === path;
      }),
    })),
  } as unknown as DataAdapter;
  return { adapter, files, directories };
}

function makeStorage(): { storage: { loadLocalStorage: (key: string) => unknown; saveLocalStorage: (key: string, value: unknown) => void }; values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    storage: {
      loadLocalStorage: (key) => values.get(key) ?? null,
      saveLocalStorage: (key, value) => {
        if (value === null) values.delete(key);
        else values.set(key, value);
      },
    },
  };
}

describe("EasySync runtime layout migration", () => {
  const current = getEasySyncPaths(".obsidian");
  const legacy = getEasySyncLegacyPaths(".obsidian");

  it("copies known legacy sidecars into the target tree and preserves unknown files", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.remoteStateFile]: "remote",
      [`${legacy.tmpDir}/pending.json`]: "pending",
      [`${legacy.pluginDir}/notes.txt`]: "leave-me",
    });

    const result = await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy);

    expect(result.migrated).toHaveLength(2);
    expect(files.get(current.remoteStateFile)).toBe("remote");
    expect(files.get(`${current.tmpDir}/pending.json`)).toBe("pending");
    expect(files.has(legacy.remoteStateFile)).toBe(true);
    expect(files.has(`${legacy.pluginDir}/notes.txt`)).toBe(true);
  });

  it("discovers an isolated legacy V2 or ancestor state file", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.stateV2File]: "state",
      [legacy.ancestorManifestV2File]: "ancestors",
    });
    const { storage } = makeStorage();

    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);

    expect(files.get(current.stateV2File)).toBe("state");
    expect(files.get(current.ancestorManifestV2File)).toBe("ancestors");
  });

  it("provisions the current layout for a fresh install and repairs missing directories after marking", async () => {
    const { adapter, directories } = makeAdapter();
    const { storage } = makeStorage();

    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);

    for (const directory of [
      `${current.pluginDir}/state`,
      `${current.pluginDir}/state/legacy`,
      `${current.pluginDir}/state/v2`,
      `${current.pluginDir}/objects`,
      current.tmpDir,
      `${current.tmpDir}/cache`,
    ]) {
      expect(directories.has(directory)).toBe(true);
    }

    for (const directory of [...directories]) {
      if (directory.startsWith(`${current.pluginDir}/state`)) {
        directories.delete(directory);
      }
    }

    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);

    expect(directories.has(`${current.pluginDir}/state/v2`)).toBe(true);
    await expect(
      adapter.write(current.stateV2MigrationHoldNextFile, "{}"),
    ).resolves.toBeUndefined();
  });

  it("blocks only when old and new copies disagree", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.remoteStateFile]: "old",
      [current.remoteStateFile]: "new",
    });

    await expect(
      ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy),
    ).rejects.toBeInstanceOf(EasySyncRuntimeLayoutMigrationConflict);
    expect(files.get(legacy.remoteStateFile)).toBe("old");
    expect(files.get(current.remoteStateFile)).toBe("new");
  });

  it("keeps the current layout authoritative after the verified migration", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.remoteStateFile]: "initial",
    });
    const { storage } = makeStorage();

    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);
    files.set(current.remoteStateFile, "current-layout-update");

    await expect(
      ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage),
    ).resolves.toMatchObject({ conflicts: [] });
    expect(files.get(current.remoteStateFile)).toBe("current-layout-update");
    expect(files.get(legacy.remoteStateFile)).toBe("initial");
  });

  it("removes old copies after three healthy rounds, then becomes silent", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.baseContentFile]: "base",
    });
    const { storage, values } = makeStorage();
    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);
    files.set(current.baseContentFile, "current-layout-update");

    const first = await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);
    const second = await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);
    const third = await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);
    expect(first.stableSyncs).toBe(1);
    expect(second.stableSyncs).toBe(2);
    expect(third.cleaned).toBe(true);
    expect(files.has(legacy.baseContentFile)).toBe(false);
    expect(values.get(EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY)).toEqual({
      version: 1,
      stableSyncs: EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD,
      completed: true,
    });

    const silent = await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);
    expect(silent.stableSyncs).toBe(0);
    expect(silent.remaining).toEqual([]);
    expect(EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD).toBe(3);

    files.set(legacy.baseContentFile, "stale-old-device-copy");
    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);
    expect(files.get(current.baseContentFile)).toBe("current-layout-update");
  });

  it("prunes empty legacy directory shells after the stable cleanup threshold", async () => {
    const { adapter, directories, files } = makeAdapter({
      [legacy.baseContentFile]: "base",
    });
    const { storage } = makeStorage();
    directories.add(legacy.ancestorsV2Dir);
    directories.add(legacy.stateV2IndexedDbRecoveryDir);
    directories.add(legacy.tmpDir);
    directories.add(`${legacy.tmpDir}/downloads`);
    directories.add(`${legacy.tmpDir}/downloads/empty-note-folder`);

    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);

    await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);
    await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);
    const result = await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);

    expect(result.cleaned).toBe(true);
    expect(files.has(legacy.baseContentFile)).toBe(false);
    expect(directories.has(legacy.ancestorsV2Dir)).toBe(false);
    expect(directories.has(legacy.stateV2IndexedDbRecoveryDir)).toBe(false);
    expect(directories.has(legacy.tmpDir)).toBe(false);
    expect(directories.has(`${legacy.tmpDir}/downloads`)).toBe(false);
    expect(directories.has(`${legacy.tmpDir}/downloads/empty-note-folder`)).toBe(false);
  });

  it("does not delete files or their parent directories when pruning after completion", async () => {
    const { adapter, directories, files } = makeAdapter({
      [`${legacy.tmpDir}/downloads/keep.txt`]: "keep",
    });
    const { storage } = makeStorage();
    storage.saveLocalStorage(EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY, {
      version: 1,
      stableSyncs: EASY_SYNC_LAYOUT_CLEANUP_STABLE_SYNC_THRESHOLD,
      completed: true,
    });
    directories.add(legacy.ancestorsV2Dir);
    directories.add(`${legacy.tmpDir}/downloads/empty-sibling`);

    const result = await noteHealthySyncAndCleanupEasySyncRuntimeLayout(
      adapter,
      legacy,
      storage,
    );

    expect(result.cleaned).toBe(true);
    expect(files.get(`${legacy.tmpDir}/downloads/keep.txt`)).toBe("keep");
    expect(directories.has(legacy.tmpDir)).toBe(true);
    expect(directories.has(`${legacy.tmpDir}/downloads`)).toBe(true);
    expect(directories.has(`${legacy.tmpDir}/downloads/empty-sibling`)).toBe(false);
    expect(directories.has(legacy.ancestorsV2Dir)).toBe(false);
    expect(adapter.remove).not.toHaveBeenCalled();
  });
});
