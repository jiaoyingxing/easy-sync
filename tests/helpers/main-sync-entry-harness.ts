// 主同步入口测试的共享夹具（原 tests/main-sync-entry.test.ts 前置块）。
// 拆分后由各 main-sync-entry-*.test.ts 导入；vi.mock 仍留在各测试文件内
// （mock 在共享模块里声明不会作用于测试文件自己导入的模块）。

import { vi } from "vitest";
import EasySyncPlugin from "../../src/main";
import type { SyncResult } from "../../src/sync/sync-executor";
import {
  createEmptyDeviceCommunityPluginParticipation,
  reduceDeviceCommunityPluginParticipation,
  type DeviceCommunityPluginParticipationV1,
} from "../../src/sync/community-plugin-participation";

export function okResult(): SyncResult {
  return {
    success: true,
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    deferred: 0,
    skippedLarge: 0,
    skippedIgnored: 0,
    errors: 0,
    authExpired: false,
    message: "ok",
  };
}

export function makePlugin(): EasySyncPlugin {
  const plugin = new EasySyncPlugin();
  plugin.app.vault.adapter.exists = vi.fn().mockResolvedValue(false);
  vi.spyOn(plugin as never, "ensureStateLoaded").mockResolvedValue(undefined);
  vi.spyOn(plugin as never, "handleSyncResult").mockResolvedValue(undefined);
  plugin.diag = {
    isEnabled: vi.fn().mockReturnValue(false),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setAdapter: vi.fn(),
    enableAll: vi.fn(),
    clear: vi.fn(),
    forceFlush: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as never;
  plugin.scanner = {
    setConfig: vi.fn(),
    shouldSyncPath: vi.fn((path: string) => !path.startsWith(".obsidian/plugins/easy-sync/tmp/")),
    shouldSyncFolderPath: vi.fn((path: string) => !path.startsWith(".obsidian/plugins/easy-sync/tmp/")),
  } as never;
  return plugin;
}

export function attachResetRecoveryHarness(plugin: EasySyncPlugin) {
  const invalidateLifecycle = vi.fn();
  const reset = vi.fn().mockResolvedValue(undefined);
  const resetPreservingIsolatedMutationRecovery = vi.fn()
    .mockResolvedValue(undefined);
  const forceReset = vi.fn().mockResolvedValue({
    at: 1,
    ledgerCount: 1,
    quarantineCount: 0,
    corrupt: false,
  });
  const clearScanCache = vi.fn().mockResolvedValue(undefined);
  const addSyncHistory = vi.fn().mockResolvedValue(undefined);
  const state = {
    isV2StateActive: true,
    boundAccountId: "account",
    mutationLedger: [{
      intent: { operationId: "pending", path: "notes/a.md" },
      receipt: null,
    }],
    mutationRecoveryQuarantine: [],
    hasMutationLedgerCorruption: false,
    hasMutationRecoveryQuarantineCorruption: false,
    hasV2StateLoadRecoveryBlock: false,
    hasV2RemoteScopeRecovery: false,
    planReviewActive: false,
    addSyncHistory,
    reset,
    resetPreservingIsolatedMutationRecovery,
    forceReset,
  };
  plugin.syncExecutor = {
    isRunning: false,
    hasActivityInFlight: false,
    invalidateLifecycle,
  } as never;
  plugin.auth = {
    authState: { isLoggedIn: true, accountId: "account" },
  } as never;
  plugin.state = state as never;
  plugin.scanner = { clearScanCache } as never;
  const saveSyncSettings = vi.spyOn(plugin, "saveSyncSettings")
    .mockResolvedValue(undefined);
  vi.spyOn(plugin as never, "checkAccountBinding").mockResolvedValue(true);
  return {
    state,
    invalidateLifecycle,
    reset,
    resetPreservingIsolatedMutationRecovery,
    forceReset,
    clearScanCache,
    addSyncHistory,
    saveSyncSettings,
  };
}

export function attachParticipationState(
  plugin: EasySyncPlugin,
  initial: DeviceCommunityPluginParticipationV1,
) {
  let participation = structuredClone(initial);
  const updateCommunityPluginParticipation = vi.fn(async (command) => {
    participation = reduceDeviceCommunityPluginParticipation(
      participation,
      command,
    );
    return true;
  });
  const state = {
    isV2StateActive: true,
    hasV2StateLoadRecoveryBlock: false,
    hasV2RemoteScopeRecovery: false,
    hasMutationLedgerCorruption: false,
    hasMutationRecoveryQuarantineCorruption: false,
    mutationLedger: [],
    activeV2MigrationHold: null,
    hasCompleteRemoteFolderIndex: false,
    remoteFolders: [],
    getCommunityPluginParticipation: vi.fn(() =>
      structuredClone(participation)
    ),
    updateCommunityPluginParticipation,
    updateCommunityPluginParticipationBatch: vi.fn(async (commands) => {
      for (const command of commands) {
        await updateCommunityPluginParticipation(command);
      }
      return true;
    }),
    retirePendingStateForPaths: vi.fn().mockResolvedValue(undefined),
    commitSyncPathSettingsChange: vi.fn(async (
      _isPathInScope: (path: string) => boolean,
      persistSettings: (data: Record<string, unknown>) => void,
    ) => persistSettings({})),
  };
  plugin.state = state as never;
  plugin.scanner = {
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    setConfig: vi.fn(),
  } as never;
  plugin.syncExecutor = {
    hasActivityInFlight: false,
    setCommunityPluginSyncPolicy: vi.fn(),
  } as never;
  vi.spyOn(plugin as never, "updateStatusBar")
    .mockImplementation(() => undefined);
  (plugin as never as {
    applyCommunityPluginParticipationProjection: (
      value: DeviceCommunityPluginParticipationV1,
    ) => void;
  }).applyCommunityPluginParticipationProjection(participation);
  return {
    state,
    current: () => structuredClone(participation),
  };
}

export function participating(pluginId = "calendar") {
  return reduceDeviceCommunityPluginParticipation(
    createEmptyDeviceCommunityPluginParticipation(true),
    {
      type: "confirm-participating",
      pluginId,
      localBundleDigest: "a".repeat(64),
    },
  );
}

export const COMMUNITY_PLUGIN_SCOPE = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};

export function changedRemotePluginJoin() {
  const requested = reduceDeviceCommunityPluginParticipation(
    createEmptyDeviceCommunityPluginParticipation(true),
    {
      type: "request-join",
      pluginId: "calendar",
      operationId: "join-calendar-1",
      targetCatalogRevision: 7,
      targetBundleDigest: "a".repeat(64),
    },
  );
  return reduceDeviceCommunityPluginParticipation(requested, {
    type: "block",
    pluginId: "calendar",
    reason: "remote-bundle-changed",
  });
}

export function remoteCalendarCatalog(revision = 8, digest = "b".repeat(64)) {
  return {
    version: 1 as const,
    scope: COMMUNITY_PLUGIN_SCOPE,
    complete: true,
    stale: false,
    revision,
    observedAt: 2,
    sourceDigest: "c".repeat(64),
    entries: [{
      pluginId: "calendar",
      bundleState: "complete" as const,
      bundleDigest: digest,
      members: ["main.js", "manifest.json", "styles.css"].map(
        (fileName, index) => ({
          path: `.obsidian/plugins/calendar/${fileName}`,
          remoteId: `remote-${index}`,
          parentId: "calendar-folder",
          size: index + 1,
          mtime: 2,
          eTag: `etag-${index}`,
          cTag: `ctag-${index}`,
          sha256Hash: null,
          quickXorHash: null,
        }),
      ),
    }],
  };
}
