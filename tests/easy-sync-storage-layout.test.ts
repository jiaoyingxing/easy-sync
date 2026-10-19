import { describe, expect, it } from "vitest";
import {
  EASY_SYNC_LEGACY_SIDECAR_KEYS,
  EASY_SYNC_SIDECAR_KEYS,
  EASY_SYNC_STORAGE_LAYOUT_VERSION,
  EASY_SYNC_LEGACY_STORAGE_LAYOUT_VERSION,
  getEasySyncPaths,
  getEasySyncLegacyPaths,
  isEasySyncSelfSyncFilePath,
} from "../src/obsidian-compat";
import {
  EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS,
  EASY_SYNC_LAYOUT_DISCARDABLE_SIDECAR_KEYS,
  EASY_SYNC_LAYOUT_NESTED_PREFIX_MIGRATION_KEYS,
  EASY_SYNC_LAYOUT_PROBE_SENTINEL_KEYS,
  EASY_SYNC_LAYOUT_ROOT_PREFIX_MIGRATION_KEYS,
} from "../src/sync/runtime-layout-migration";

describe("EasySync local storage layout registry", () => {
  it("keeps the current layout behind one versioned path contract", () => {
    const paths = getEasySyncPaths(".obsidian");

    expect(paths.storageLayoutVersion).toBe(EASY_SYNC_STORAGE_LAYOUT_VERSION);
    expect(paths.storageLayoutVersion).toBe(2);
    expect(paths.pluginDir).toBe(".obsidian/plugins/easy-sync");
    expect(paths.dataFile).toBe(".obsidian/plugins/easy-sync/data.json");
    expect(paths.stateV2File).toBe(".obsidian/plugins/easy-sync/state/v2/state-v2.json");
    expect(paths.stateV2IndexedDbRecoveryDir).toBe(
      ".obsidian/plugins/easy-sync/state/v2/indexeddb-recovery",
    );
    expect(paths.ancestorsV2Dir).toBe(".obsidian/plugins/easy-sync/objects/ancestors-v2");
    expect(paths.scanCacheFile).toBe(".obsidian/plugins/easy-sync/runtime/cache/scan-cache.json");
  });

  it("keeps the public 1.1.3 layout available only as a migration source", () => {
    const paths = getEasySyncLegacyPaths(".obsidian");

    expect(paths.storageLayoutVersion).toBe(EASY_SYNC_LEGACY_STORAGE_LAYOUT_VERSION);
    expect(paths.remoteStateFile).toBe(".obsidian/plugins/easy-sync/remote-state.json");
    expect(paths.stateV2File).toBe(".obsidian/plugins/easy-sync/state-v2.json");
    expect(paths.tmpDir).toBe(".obsidian/plugins/easy-sync/tmp");
  });

  it("keeps self-sync limited to the three bundle files", () => {
    expect(isEasySyncSelfSyncFilePath(".obsidian/plugins/easy-sync/main.js")).toBe(true);
    expect(isEasySyncSelfSyncFilePath(".obsidian/plugins/easy-sync/manifest.json")).toBe(true);
    expect(isEasySyncSelfSyncFilePath(".obsidian/plugins/easy-sync/styles.css")).toBe(true);
    expect(isEasySyncSelfSyncFilePath(".obsidian/plugins/easy-sync/versions.json")).toBe(false);
    expect(isEasySyncSelfSyncFilePath(".obsidian/plugins/easy-sync/data.json")).toBe(false);
    expect(isEasySyncSelfSyncFilePath(".obsidian/plugins/easy-sync/state-v2.json")).toBe(false);
    expect(isEasySyncSelfSyncFilePath(".obsidian/plugins/easy-sync/state-v2/other.js")).toBe(false);
    expect(isEasySyncSelfSyncFilePath(".OBSIDIAN/PLUGINS/EASY-SYNC/MAIN.JS")).toBe(true);
  });

  it("derives all instances from the same registry regardless of config dir or plugin id", () => {
    const paths = getEasySyncPaths("custom-config", "custom-id");

    expect(paths.storageLayoutVersion).toBe(2);
    expect(paths.pluginDir).toBe("custom-config/plugins/custom-id");
    expect(paths.remoteStateFile).toBe("custom-config/plugins/custom-id/state/legacy/remote-state.json");
    expect(paths.tmpDir).toBe("custom-config/plugins/custom-id/runtime");
    expect(isEasySyncSelfSyncFilePath(
      "custom-config/plugins/custom-id/main.js",
      "custom-config",
      "custom-id",
    )).toBe(true);
  });

  // 2026-10-16（Q3，全仓审计复核授权项）：迁移映射表的**清单完整性门**。
  // 病根：映射表是手写清单，新增一个 sidecar 时不会有任何东西变红；本轮就抓到
  // 一个漏项（旧版远端枚举检查点，见下一条）。判据＝每个登记在册的 sidecar
  // 要么在映射表里（一对一／两组前缀），要么在两套布局里**拼写本来相同**
  // （同路径不需要迁移，如日志目录）；两条都不满足即视为漏项。
  it("accounts for every registered sidecar in the layout migration table", () => {
    const current = getEasySyncPaths(".obsidian");
    const legacy = getEasySyncLegacyPaths(".obsidian");
    const mapped = new Set<string>([
      ...EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS,
      ...EASY_SYNC_LAYOUT_ROOT_PREFIX_MIGRATION_KEYS,
      ...EASY_SYNC_LAYOUT_NESTED_PREFIX_MIGRATION_KEYS,
    ]);
    const registered = new Set<string>(EASY_SYNC_SIDECAR_KEYS);

    // 漏项：登记在册、却既没进映射表、两套布局拼写又不相同。
    expect(EASY_SYNC_SIDECAR_KEYS.filter((key) => (
      !mapped.has(key) && legacy[key] !== current[key]
    ))).toEqual([]);

    // 陈旧项：映射表里写了登记册里已经没有的键（改名／删项后的残留）。
    expect([...mapped].filter((key) => !registered.has(key))).toEqual([]);

    // 两套布局的键集必须一致：只在一边存在的键根本无法映射。
    expect([...EASY_SYNC_LEGACY_SIDECAR_KEYS].sort()).toEqual(
      [...EASY_SYNC_SIDECAR_KEYS].sort(),
    );
  });

  // 同一条门覆盖迁移模块里的另外两张手写清单：探测哨兵（决定要不要走旧树）与
  // 可丢弃档（两份拷贝字节不一致时跳过而不阻断）。任何一张写了登记册以外的键、
  // 或写了不会迁移的键，都会在这里变红——漏项的两种典型形态。
  it("keeps the migration probe and discard lists inside the registered sidecars", () => {
    const current = getEasySyncPaths(".obsidian");
    const legacy = getEasySyncLegacyPaths(".obsidian");
    const registered = new Set<string>(EASY_SYNC_SIDECAR_KEYS);
    const mapped = new Set<string>([
      ...EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS,
      ...EASY_SYNC_LAYOUT_ROOT_PREFIX_MIGRATION_KEYS,
      ...EASY_SYNC_LAYOUT_NESTED_PREFIX_MIGRATION_KEYS,
    ]);

    for (const keyList of [
      EASY_SYNC_LAYOUT_PROBE_SENTINEL_KEYS,
      EASY_SYNC_LAYOUT_DISCARDABLE_SIDECAR_KEYS,
    ]) {
      // 登记册里没有这个键 ⇒ 清单过期（改名／删项残留）。
      expect(keyList.filter((key) => !registered.has(key))).toEqual([]);
      // 没进映射表且两套布局拼写相同 ⇒ 这条清单管不到任何东西（写错了对象）。
      expect(keyList.filter((key) => (
        !mapped.has(key) && legacy[key] === current[key]
      ))).toEqual([]);
    }

    // 可丢弃档与探测哨兵都必须真的在映射表里，否则它们永远不会被走到
    // （第 398-401 行的筛选会把未映射的文件整个丢掉）。
    expect(EASY_SYNC_LAYOUT_DISCARDABLE_SIDECAR_KEYS
      .filter((key) => !mapped.has(key))).toEqual([]);
  });

  // 上一条门抓到的那个实际漏项（2026-10-16 补登记）：旧版布局把远端枚举检查点
  // 放在插件根目录，当前布局在 `runtime/cache/` 下——与同为缓存的扫描缓存
  // （`scan-cache.json`）同形，属于应迁移项；不迁移的后果是旧文件留在原地，
  // 旧布局目录因非空而无法清理（检查点本身是 fail-open 缓存，迁错不会造成错数据）。
  it("registers the legacy remote-enumeration checkpoint as a migration source", () => {
    const current = getEasySyncPaths(".obsidian");
    const legacy = getEasySyncLegacyPaths(".obsidian");

    expect(EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS).toContain("remoteEnumCheckpointFile");
    expect(legacy.remoteEnumCheckpointFile).toBe(
      ".obsidian/plugins/easy-sync/remote-enum-checkpoint.json",
    );
    expect(current.remoteEnumCheckpointFile).toBe(
      ".obsidian/plugins/easy-sync/runtime/cache/remote-enum-checkpoint.json",
    );

    // 兄弟缓存（扫描缓存）在映射表里，两者必须同档——这就是"漏项"的判据来源。
    expect(EASY_SYNC_LAYOUT_DIRECT_MIGRATION_KEYS).toContain("scanCacheFile");
  });
});
