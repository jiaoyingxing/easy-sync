import { describe, expect, it } from "vitest";
import {
  EASY_SYNC_STORAGE_LAYOUT_VERSION,
  EASY_SYNC_LEGACY_STORAGE_LAYOUT_VERSION,
  getEasySyncPaths,
  getEasySyncLegacyPaths,
  isEasySyncSelfSyncFilePath,
} from "../src/obsidian-compat";

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
});
