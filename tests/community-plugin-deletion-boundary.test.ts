import { describe, expect, it } from "vitest";
import {
  applyCommunityPluginLocalIgnores,
  detectCommunityPluginLocalIgnores,
  isCommunityPluginFolderPreservedByPolicy,
  protectCommunityPluginPlan,
} from "../src/sync/community-plugin-deletion-boundary";
import type { CommunityPluginSyncPolicyV1 } from "../src/sync/community-plugin-sync-policy";
import {
  SyncActionType,
  type BaseFileEntry,
  type LocalFolderMoveHintV1,
  type LocalFileEntry,
  type RemoteFileEntry,
  type SyncPlanItem,
  type SyncScope,
} from "../src/sync/types";
import type { FolderAnchorV2 } from "../src/sync/state-envelope-v2";

const CONFIG_DIR = ".obsidian";
const POLICY: CommunityPluginSyncPolicyV1 = {
  version: 1,
  files: { mode: "all", pluginIds: [], ignoredPluginIds: [] },
  data: { mode: "all", pluginIds: [], ignoredPluginIds: [] },
};
const SCOPE: SyncScope = {
  accountId: "account",
  driveId: "drive",
  vaultFolderId: "vault",
  filesRootId: "files",
};

function local(path: string): LocalFileEntry {
  return {
    path,
    size: 1,
    mtime: 1,
    hash: "local",
    binary: false,
  };
}

function remote(path: string): RemoteFileEntry {
  return {
    path,
    driveId: `id:${path}`,
    parentId: "parent",
    size: 1,
    mtime: 1,
    eTag: `etag:${path}`,
  };
}

function base(path: string): BaseFileEntry {
  return {
    path,
    size: 1,
    hash: "base",
    eTag: `etag:${path}`,
  };
}

describe("community plugin deletion boundary", () => {
  it("turns a previously shared but now absent local plugin into a device-local ignore", () => {
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const manifest = `${CONFIG_DIR}/plugins/calendar/manifest.json`;
    const data = `${CONFIG_DIR}/plugins/calendar/data.json`;

    expect(detectCommunityPluginLocalIgnores({
      policy: POLICY,
      configDir: CONFIG_DIR,
      localEntries: [],
      remoteEntries: [remote(main), remote(manifest), remote(data)],
      baseEntries: [base(main), base(manifest), base(data)],
    })).toEqual({
      files: ["calendar"],
      data: ["calendar"],
    });
  });

  it("keeps a complete remote-only plugin off on a device that never installed it", () => {
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const manifest = `${CONFIG_DIR}/plugins/calendar/manifest.json`;

    expect(detectCommunityPluginLocalIgnores({
      policy: POLICY,
      configDir: CONFIG_DIR,
      localEntries: [],
      remoteEntries: [remote(main), remote(manifest)],
      baseEntries: [],
    })).toEqual({
      files: ["calendar"],
      data: [],
    });
  });

  it("keeps a partial remote-only plugin off on a device that never installed it", () => {
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;

    expect(detectCommunityPluginLocalIgnores({
      policy: POLICY,
      configDir: CONFIG_DIR,
      localEntries: [],
      remoteEntries: [remote(main)],
      baseEntries: [],
    })).toEqual({
      files: ["calendar"],
      data: [],
    });
  });

  it("does not turn a partial local bundle into a device-local ignore", () => {
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const manifest = `${CONFIG_DIR}/plugins/calendar/manifest.json`;

    expect(detectCommunityPluginLocalIgnores({
      policy: POLICY,
      configDir: CONFIG_DIR,
      localEntries: [local(manifest)],
      remoteEntries: [remote(main), remote(manifest)],
      baseEntries: [],
    })).toEqual({
      files: [],
      data: [],
    });
  });

  it("uses complete folder evidence only to retire a move hint, not to infer local participation", () => {
    const root = `${CONFIG_DIR}/plugins/calendar`;
    const main = `${root}/main.js`;
    const manifest = `${root}/manifest.json`;
    const hint: LocalFolderMoveHintV1 = {
      version: 1,
      scope: SCOPE,
      remoteId: "folder-calendar",
      fromPath: root,
      toPath: `.trash/${root}`,
      observedAt: 1,
    };
    const anchor: FolderAnchorV2 = {
      anchorId: "folder:calendar",
      remoteId: hint.remoteId,
      lastPath: root,
      parentRemoteId: "folder-plugins",
      confirmedGeneration: 1,
      confirmedAt: 1,
    };
    const input = {
      policy: POLICY,
      configDir: CONFIG_DIR,
      localEntries: [],
      remoteEntries: [remote(main), remote(manifest)],
      baseEntries: [],
      folderMoveEvidence: {
        scope: SCOPE,
        localFolderScanComplete: true,
        remoteFolderIndexComplete: true,
        hints: [hint],
        anchors: [anchor],
        remoteFolders: [{
          path: root,
          driveId: hint.remoteId,
          parentId: anchor.parentRemoteId,
          name: "calendar",
        }],
        isFolderPathInScope: (path: string) => !path.startsWith(".trash/"),
      },
    };

    expect(detectCommunityPluginLocalIgnores(input)).toEqual({
      files: ["calendar"],
      data: [],
      folderMoveHintRemoteIds: [hint.remoteId],
    });
    expect(detectCommunityPluginLocalIgnores({
      ...input,
      folderMoveEvidence: {
        ...input.folderMoveEvidence,
        remoteFolderIndexComplete: false,
      },
    })).toEqual({
      files: ["calendar"],
      data: [],
    });
  });

  it("keeps ignored plugins outside this device without deleting cloud content", () => {
    const next = applyCommunityPluginLocalIgnores(POLICY, {
      files: ["calendar"],
      data: ["calendar"],
    });
    expect(next.files.ignoredPluginIds).toEqual(["calendar"]);
    expect(next.data.ignoredPluginIds).toEqual(["calendar"]);

    const plan: SyncPlanItem[] = [
      {
        type: SyncActionType.DeleteRemote,
        path: `${CONFIG_DIR}/plugins/calendar/main.js`,
        remote: remote(`${CONFIG_DIR}/plugins/calendar/main.js`),
      },
      {
        type: SyncActionType.DeleteRemote,
        path: `${CONFIG_DIR}/plugins/calendar/data.json`,
        remote: remote(`${CONFIG_DIR}/plugins/calendar/data.json`),
      },
    ];
    expect(protectCommunityPluginPlan(plan, next, CONFIG_DIR)).toEqual([]);
  });

  it("preserves only excluded community plugin folder subtrees as remote-only", () => {
    const ignored = applyCommunityPluginLocalIgnores(POLICY, {
      files: ["calendar"],
      data: [],
    });

    expect(isCommunityPluginFolderPreservedByPolicy(
      `${CONFIG_DIR}/plugins/calendar`,
      ignored,
      CONFIG_DIR,
    )).toBe(true);
    expect(isCommunityPluginFolderPreservedByPolicy(
      `${CONFIG_DIR}/plugins/calendar/runtime/cache`,
      ignored,
      CONFIG_DIR,
    )).toBe(true);
    expect(isCommunityPluginFolderPreservedByPolicy(
      `${CONFIG_DIR}/plugins/dataview`,
      ignored,
      CONFIG_DIR,
    )).toBe(false);
    expect(isCommunityPluginFolderPreservedByPolicy(
      "Private/calendar",
      ignored,
      CONFIG_DIR,
    )).toBe(false);
    expect(isCommunityPluginFolderPreservedByPolicy(
      `${CONFIG_DIR}/plugins/easy-sync`,
      ignored,
      CONFIG_DIR,
    )).toBe(false);
  });

  it("preserves an explicitly rejoining plugin root until its bundle restore completes", () => {
    const restoring: CommunityPluginSyncPolicyV1 = {
      version: 1,
      files: {
        mode: "selected",
        pluginIds: ["calendar"],
      },
      data: { mode: "none", pluginIds: [] },
    };
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;

    expect(isCommunityPluginFolderPreservedByPolicy(
      `${CONFIG_DIR}/plugins/calendar`,
      restoring,
      CONFIG_DIR,
      "easy-sync",
      ["calendar"],
    )).toBe(true);
    expect(protectCommunityPluginPlan(
      [{
        type: SyncActionType.DeleteRemote,
        path: main,
        remote: remote(main),
      }],
      restoring,
      CONFIG_DIR,
      [],
      "easy-sync",
      {
        remoteEntries: [remote(main)],
        anchoredRemoteIdByPath: new Map(),
        restoringFilePluginIds: ["calendar"],
      },
    )).toEqual([{
      type: SyncActionType.Download,
      path: main,
      remote: remote(main),
    }]);
  });

  it("restores a changed same-identity remote member instead of keeping an identity deferral", () => {
    const restoring: CommunityPluginSyncPolicyV1 = {
      version: 1,
      files: {
        mode: "selected",
        pluginIds: ["calendar"],
      },
      data: { mode: "none", pluginIds: [] },
    };
    const manifest = `${CONFIG_DIR}/plugins/calendar/manifest.json`;
    const remoteManifest = remote(manifest);
    const deferred: SyncPlanItem = {
      type: SyncActionType.FolderDeferred,
      path: manifest,
      reason: "reason.identityMove.deferred",
    };

    expect(protectCommunityPluginPlan(
      [deferred],
      restoring,
      CONFIG_DIR,
      [],
      "easy-sync",
      {
        remoteEntries: [remoteManifest],
        anchoredRemoteIdByPath: new Map([[manifest, remoteManifest.driveId]]),
        restoringFilePluginIds: ["calendar"],
      },
    )).toEqual([{
      type: SyncActionType.Download,
      path: manifest,
      remote: remoteManifest,
    }]);
    expect(protectCommunityPluginPlan(
      [deferred],
      restoring,
      CONFIG_DIR,
      [],
      "easy-sync",
      {
        remoteEntries: [remoteManifest],
        anchoredRemoteIdByPath: new Map([[manifest, "replacement-id"]]),
        restoringFilePluginIds: ["calendar"],
      },
    )).toEqual([deferred]);
  });

  it("never lets restore authority overwrite an existing locally modified member", () => {
    const restoring: CommunityPluginSyncPolicyV1 = {
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        restoringPluginIds: ["calendar"],
      },
      data: { mode: "none", pluginIds: [] },
    };
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const changedLocal = {
      ...local(main),
      hash: "locally-modified",
      size: 17,
    };
    const conflict: SyncPlanItem = {
      type: SyncActionType.Conflict,
      path: main,
      local: changedLocal,
      remote: remote(main),
      reason: "reason.bothSidesModified",
    };

    expect(protectCommunityPluginPlan(
      [conflict],
      restoring,
      CONFIG_DIR,
      [changedLocal],
    )).toEqual([conflict]);
  });

  it("keeps plugin data outside the plan when plugin files do not participate", () => {
    const policy: CommunityPluginSyncPolicyV1 = {
      version: 1,
      files: {
        mode: "all",
        pluginIds: [],
        ignoredPluginIds: ["calendar"],
      },
      data: { mode: "all", pluginIds: [] },
    };
    const dataPath = `${CONFIG_DIR}/plugins/calendar/data.json`;
    expect(protectCommunityPluginPlan([{
      type: SyncActionType.Upload,
      path: dataPath,
      local: local(dataPath),
    }], policy, CONFIG_DIR)).toEqual([]);
  });

  it("restores a remotely missing participating plugin file instead of asking to delete local", () => {
    const path = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const plan: SyncPlanItem[] = [{
      type: SyncActionType.ConfirmLocalDelete,
      path,
      local: local(path),
    }];

    expect(protectCommunityPluginPlan(plan, POLICY, CONFIG_DIR)).toEqual([{
      type: SyncActionType.Upload,
      path,
      local: local(path),
    }]);
  });

  it("restores a locally modified participating plugin file when remote is missing", () => {
    const path = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const changedLocal = {
      ...local(path),
      size: 12,
      mtime: 20,
      hash: "local-new",
    };
    const plan: SyncPlanItem[] = [{
      type: SyncActionType.Conflict,
      path,
      local: changedLocal,
      reason: "reason.remoteDeletedLocalModified",
    }];

    expect(protectCommunityPluginPlan(
      plan,
      POLICY,
      CONFIG_DIR,
      [changedLocal],
    )).toEqual([{
      type: SyncActionType.Upload,
      path,
      local: changedLocal,
    }]);
  });

  it("repairs a missing member of a still-present local plugin bundle from cloud", () => {
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const manifest = `${CONFIG_DIR}/plugins/calendar/manifest.json`;
    const plan: SyncPlanItem[] = [{
      type: SyncActionType.DeleteRemote,
      path: main,
      remote: remote(main),
    }];

    expect(protectCommunityPluginPlan(
      plan,
      POLICY,
      CONFIG_DIR,
      [local(manifest)],
    )).toEqual([{
      type: SyncActionType.Download,
      path: main,
      remote: remote(main),
    }]);
  });

  it("repairs a missing local bundle member even when the remote file changed", () => {
    const main = `${CONFIG_DIR}/plugins/calendar/main.js`;
    const manifest = `${CONFIG_DIR}/plugins/calendar/manifest.json`;
    const plan: SyncPlanItem[] = [{
      type: SyncActionType.Conflict,
      path: main,
      remote: remote(main),
      reason: "reason.localDeletedRemoteModified",
    }];

    expect(protectCommunityPluginPlan(
      plan,
      POLICY,
      CONFIG_DIR,
      [local(manifest)],
    )).toEqual([{
      type: SyncActionType.Download,
      path: main,
      remote: remote(main),
    }]);
  });
});
