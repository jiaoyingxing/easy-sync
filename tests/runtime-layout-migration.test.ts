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
  toLayoutMigrationConflict,
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

  // 2026-10-16（Q3）：旧版把远端枚举检查点放在插件根目录，当前布局在
  // `runtime/cache/` 下；补登记后它必须真的被搬过去（与扫描缓存同档）。
  // 检查点本身是 fail-open 缓存（缺失／过期只会退化成整段重读，不会读出错数据），
  // 所以这条钉的是"旧文件不再滞留"——未登记的文件永远不会被发现，也就永远
  // 不会被清理，旧布局目录会一直留着。
  it("carries the legacy remote-enumeration checkpoint into the cache directory", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.remoteEnumCheckpointFile]: "{\"scopeFingerprint\":\"s\"}",
    });

    const result = await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy);

    expect(result.migrated).toEqual([legacy.remoteEnumCheckpointFile]);
    expect(files.get(current.remoteEnumCheckpointFile))
      .toBe("{\"scopeFingerprint\":\"s\"}");
  });

  // 同族的第二个面（Q3 核到）：两份拷贝字节不一致时，缓存类必须**跳过**而不是
  // 阻断整次布局迁移——当前的扫描缓存本来就在可丢弃档，检查点必须同档，否则
  // 一个过期缓存会把布局升级卡死（fail-open 缓存没有这种权限）。
  it("skips a stale checkpoint copy instead of blocking the layout change", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.remoteEnumCheckpointFile]: "{\"stale\":true}",
      [current.remoteEnumCheckpointFile]: "{\"fresh\":true}",
    });

    const result = await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy);

    expect(result.conflicts).toEqual([legacy.remoteEnumCheckpointFile]);
    expect(files.get(current.remoteEnumCheckpointFile)).toBe("{\"fresh\":true}");
  });

  // 2026-10-16（Q3 顺带核到）：前缀组的**目标路径**写法。旧版把两类隔离文件与
  // 目录直接放在插件根下，新布局把它们收进 state/v2 与 objects/ 下——目标必须是
  // "旧的相对路径前缀换成新的相对路径前缀"，不是"再剥一次插件目录前缀"。
  it("maps the root-level prefix groups onto their new relative prefixes", async () => {
    const { adapter, files } = makeAdapter({
      [`${legacy.pluginDir}/state-v2.corrupt-source-1.json`]: "corrupt",
      [`${legacy.pluginDir}/state-v2.reactivation-archive-2.json`]: "archive",
      [`${legacy.stateV2IndexedDbRecoveryDir}/db.bin`]: "indexeddb",
      [`${legacy.ancestorsV2Dir}/tree.json`]: "ancestors",
    });

    const result = await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy);

    expect(result.migrated).toHaveLength(4);
    expect(files.get(`${current.pluginDir}/state/v2/state-v2.corrupt-source-1.json`))
      .toBe("corrupt");
    expect(files.get(`${current.pluginDir}/state/v2/state-v2.reactivation-archive-2.json`))
      .toBe("archive");
    expect(files.get(`${current.pluginDir}/state/v2/indexeddb-recovery/db.bin`))
      .toBe("indexeddb");
    expect(files.get(`${current.pluginDir}/objects/ancestors-v2/tree.json`))
      .toBe("ancestors");
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

  it("still migrates a sidecar that appears during the grace period", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.remoteStateFile]: "initial",
    });
    const { storage } = makeStorage();
    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);
    expect(files.has(current.stateV2RollbackFile)).toBe(false);

    // A downgraded or interrupted run writes the old layout again while the
    // legacy tree is still waiting for cleanup.
    files.set(legacy.stateV2RollbackFile, "late-arrival");

    const result = await ensureEasySyncRuntimeLayoutMigration(
      adapter,
      current,
      legacy,
      storage,
    );

    expect(result.migrated).toEqual([legacy.stateV2RollbackFile]);
    expect(files.get(current.stateV2RollbackFile)).toBe("late-arrival");
  });

  it("carries the cleanup count forward when it re-runs during the grace period", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.remoteStateFile]: "initial",
    });
    const { storage, values } = makeStorage();
    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);
    expect(values.get(EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY))
      .toMatchObject({ stableSyncs: 0, completed: false });
    await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);
    await noteHealthySyncAndCleanupEasySyncRuntimeLayout(adapter, legacy, storage);

    files.set(legacy.stateV2RollbackFile, "late-arrival");
    await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy, storage);

    expect(values.get(EASY_SYNC_LAYOUT_MIGRATION_STORAGE_KEY))
      .toMatchObject({ stableSyncs: 2, completed: false });
  });

  it("skips a diverged discardable sidecar instead of blocking", async () => {
    const { adapter, files } = makeAdapter({
      [legacy.scanCacheFile]: "stale-cache",
      [current.scanCacheFile]: "rebuilt-cache",
    });

    const result = await ensureEasySyncRuntimeLayoutMigration(adapter, current, legacy);

    expect(result.conflicts).toEqual([legacy.scanCacheFile]);
    expect(files.get(legacy.scanCacheFile)).toBe("stale-cache");
    expect(files.get(current.scanCacheFile)).toBe("rebuilt-cache");
  });

  it("narrows only a layout conflict out of an unknown failure", async () => {
    const conflict = new EasySyncRuntimeLayoutMigrationConflict("a", "b");
    expect(toLayoutMigrationConflict(conflict)).toBe(conflict);
    expect(toLayoutMigrationConflict(new Error("boom"))).toBe(null);
    expect(toLayoutMigrationConflict("boom")).toBe(null);
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
