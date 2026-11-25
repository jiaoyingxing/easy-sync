import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import {
  isEasySyncInternalPath,
  isPathExcludedByFolders,
  LocalScanner,
} from "../src/sync/local-scanner";
import {
  getEasySyncPaths,
  getEasySyncLegacyPaths,
  isEasySyncSelfSyncFilePath,
} from "../src/obsidian-compat";
import {
  isPluginDataSelected,
  isPluginSelected,
  normalizePluginScopeSelection,
} from "../src/sync/community-plugin-sync-policy";
import type { ScanConfig } from "../src/sync/types";

/**
 * Oracle for the cached exclusion index: the same rules and order as the
 * pre-index implementation, recomputed from exported helpers per path. The
 * scan hot path must return exactly this answer for every branch (internal
 * state, excluded folders, own plugin, community plugins, include/exclude
 * prefixes, OS noise).
 */
function referenceIsExcluded(
  path: string,
  config: ScanConfig,
  configDir: string,
  pluginId: string,
): boolean {
  const paths = getEasySyncPaths(configDir, pluginId);
  if (isEasySyncInternalPath(path, configDir, pluginId)) return true;
  if (isPathExcludedByFolders(path, config.excludedFolders)) return true;
  if (path === paths.pluginDir || path.startsWith(paths.pluginDirPrefix)) {
    return config.includeOwnPluginCode !== true
      || !isEasySyncSelfSyncFilePath(path, configDir, pluginId);
  }
  if (
    path.startsWith(paths.pluginRoot)
    && path !== paths.pluginDir
    && !path.startsWith(paths.pluginDirPrefix)
  ) {
    const parts = path.slice(paths.pluginRoot.length).split("/");
    if (parts.length !== 2) return true;
    const [communityPluginId, fileName] = parts;
    const code = normalizePluginScopeSelection(
      config.pluginCodeSelection,
      config.includePluginCode,
      pluginId,
    );
    const data = normalizePluginScopeSelection(
      config.pluginDataSelection,
      config.includePluginData,
      pluginId,
    );
    if (fileName === "data.json") {
      return !isPluginDataSelected(code, data, communityPluginId);
    }
    return !isPluginSelected(code, communityPluginId)
      || !["main.js", "manifest.json", "styles.css"].includes(fileName);
  }
  for (const prefix of config.includePaths) {
    if (path.startsWith(prefix)) return false;
  }
  for (const prefix of config.excludePaths) {
    if (path.startsWith(prefix)) return true;
  }
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name.startsWith("~$") || name.endsWith(".tmp")) return true;
  return name === ".ds_store" || name === "thumbs.db";
}

function scanner(config: Partial<ScanConfig>): LocalScanner {
  const vault = { configDir: ".obsidian" } as unknown as Vault;
  return new LocalScanner(vault, config);
}

const CONFIGS: Array<{ name: string; config: Partial<ScanConfig> }> = [
  { name: "defaults", config: {} },
  {
    name: "own plugin code on",
    config: { includeOwnPluginCode: true },
  },
  {
    name: "folder exclusion + parent",
    config: { excludedFolders: ["Private", "Shared/Sub"] },
  },
  {
    name: "include overrides exclude and OS noise",
    config: {
      includePaths: ["Private", "Notes/keep.tmp"],
      excludePaths: ["Private/secret"],
    },
  },
  {
    name: "community plugin selections",
    config: {
      includePluginCode: true,
      includePluginData: true,
      pluginCodeSelection: { mode: "include", pluginIds: ["selected"] },
      pluginDataSelection: { mode: "exclude", pluginIds: ["selected"] },
    },
  },
];

const PATHS = (() => {
  const paths = getEasySyncPaths(".obsidian", "easy-sync");
  const legacy = getEasySyncLegacyPaths(".obsidian", "easy-sync");
  return [
    "Notes/note.md",
    "Notes/~$Report.docx",
    "Notes/scratch.tmp",
    "Notes/Thumbs.db",
    "notes/keep.tmp",
    "Private/note.md",
    "private/Nested/note.md",
    "Private-old/note.md",
    "Public/Private/note.md",
    "Shared/Sub/note.md",
    "Shared/Sub-old/note.md",
    ".obsidian/app.json",
    ".obsidian/plugins",
    ".obsidian/plugins/easy-sync/main.js",
    ".obsidian/plugins/easy-sync/manifest.json",
    ".obsidian/plugins/easy-sync/styles.css",
    ".obsidian/plugins/easy-sync/data.json",
    ".obsidian/plugins/easy-sync/tmp/download.part",
    ".obsidian/plugins/easy-sync/state/v2/state-v2.json",
    ".obsidian/plugins/easy-sync/logs/2026-11-25.log",
    ".obsidian/plugins/other/main.js",
    ".obsidian/plugins/other/manifest.json",
    ".obsidian/plugins/other/styles.css",
    ".obsidian/plugins/other/data.json",
    ".obsidian/plugins/other/runtime/cache.json",
    ".obsidian/plugins/selected/main.js",
    ".obsidian/plugins/selected/data.json",
    ".obsidian/plugins/selected/README.md",
    paths.dataFile,
    paths.remoteStateFile,
    paths.stateV2File,
    paths.stateV2NextFile,
    paths.stateV2ManifestFile,
    paths.stateV2AuthorityWitnessFile,
    paths.stateV2IndexedDbRecoveryDir,
    `${paths.stateV2IndexedDbRecoveryDir}/db.json`,
    paths.stateV2CorruptSourcePrefix + "old.json",
    paths.stateV2CorruptSourcePrefix + "old.json.next",
    paths.stateV2ReactivationArchivePrefix + "old.json",
    paths.stateV2ReactivationArchivePrefix + "old.txt",
    `${paths.pluginDirPrefix}data.sync-conflict-note.json`,
    `${paths.pluginDirPrefix}data.sync-conflict-note.txt`,
    paths.logsDir,
    `${paths.logsDir}/x.log`,
    paths.tmpDir,
    `${paths.tmpDir}/x.part`,
    paths.ancestorsV2Dir,
    `${paths.ancestorsV2Dir}/hash`,
    paths.scanCacheFile,
    paths.deletionLedgerFile,
    `${paths.deletionLedgerFile}.next`,
    legacy.dataFile,
    legacy.remoteStateFile,
    legacy.stateV2File,
    legacy.baseContentFile,
    legacy.deletionLedgerFile,
    `${legacy.deletionLedgerFile}.next`,
    `${legacy.logsDir}/x.log`,
    `${legacy.tmpDir}/x.part`,
    "Notes/.easy-sync-recovery-2026-01-01.md",
    "Notes/report.docx",
  ];
})();

describe("cached scanner exclusion index", () => {
  it("matches the per-path reference implementation across every branch", () => {
    for (const { name, config } of CONFIGS) {
      const instance = scanner(config);
      // The scanner's own normalized config is the input both sides must
      // agree on (defaults, `.obsidian/` exclusion and folder normalization).
      const effective = (instance as unknown as { config: ScanConfig }).config;
      for (const path of PATHS) {
        expect(
          instance.shouldSyncPath(path),
          `${name} / ${path}`,
        ).toBe(!referenceIsExcluded(path, effective, ".obsidian", "easy-sync"));
      }
    }
  });

  it("keeps folder exclusions case-insensitive after the index is reused", () => {
    const instance = scanner({ excludedFolders: ["Private"] });
    expect(instance.shouldSyncFolderPath("Private")).toBe(false);
    expect(instance.shouldSyncFolderPath("PRIVATE/Nested")).toBe(false);
    expect(instance.shouldSyncFolderPath("Private-old")).toBe(true);
  });
});
