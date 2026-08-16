import { describe, expect, it, vi } from "vitest";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import { SyncActionType } from "../src/sync/types";
import { createCommunityPluginManifestObservation } from "../src/sync/community-plugin-bundle";
import { buildRemoteCommunityPluginCatalog } from "../src/sync/community-plugin-remote-catalog";
import type { DriveItem } from "../src/onedrive/types";
import type {
  BaseFileEntry,
  FolderMutationIntentV2,
  MutationIntentV1,
  MutationReceiptV1,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlanItem,
} from "../src/sync/types";

const TEST_SCOPE = {
  accountId: "account-id",
  driveId: "drive-id",
  vaultFolderId: "vault-folder-id",
  filesRootId: "files-root-id",
};

function conflict(path: string): SyncPlanItem {
  return { type: SyncActionType.Conflict, path };
}

function pendingDelete(path: string): SyncPlanItem {
  return { type: SyncActionType.ConfirmLocalDelete, path };
}

function makeState() {
  const saveData = vi.fn().mockResolvedValue(undefined);
  const writeRemoteState = vi.fn().mockResolvedValue(undefined);
  const plugin: PluginDataStore = {
    loadData: vi.fn().mockResolvedValue({ "sync-interval": 7 }),
    updatePluginData: vi.fn().mockImplementation(
      async (mutator: (data: Record<string, unknown>) => void) => {
        const data = (await plugin.loadData()) ?? {};
        mutator(data);
        await saveData(data);
      },
    ),
    manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
    app: {
      vault: {
        adapter: {
          exists: vi.fn().mockResolvedValue(false),
          read: vi.fn().mockRejectedValue(new Error("missing")),
          write: writeRemoteState,
          remove: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
          rmdir: vi.fn().mockResolvedValue(undefined),
          stat: vi.fn().mockResolvedValue(null),
          readBinary: vi.fn().mockRejectedValue(new Error("missing")),
          writeBinary: vi.fn().mockResolvedValue(undefined),
        },
      },
    },
  };
  return {
    state: new StateManager(plugin),
    plugin,
    saveData,
    writeRemoteState,
  };
}

describe("StateManager batch persistence", () => {
  it("keeps public 1.1.3 base and remote evidence read-only before V2 activation", async () => {
    const entry: BaseFileEntry = {
      path: "note.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-note",
    };
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      parentId: TEST_SCOPE.filesRootId,
      size: 10,
      mtime: 1,
      eTag: "etag-note",
      cTag: "ctag-note",
    };
    const operations: Array<(state: StateManager) => Promise<unknown>> = [
      (state) => state.upsertBaseEntries([entry]),
      (state) => state.reconcileIdenticalConflict(entry),
      (state) => state.removeBaseEntry(entry.path),
      (state) => state.removeBaseEntries([entry.path]),
      (state) => state.setBaseSnapshot([entry]),
      (state) => state.setRemoteState([remote], "delta-1", TEST_SCOPE),
      (state) => state.clearRemoteState(),
      (state) => state.applyRemoteMutations([remote], []),
    ];

    for (const operation of operations) {
      const { state, saveData, writeRemoteState } = makeState();
      await expect(operation(state)).rejects.toThrow("active V2 state");
      expect(saveData).not.toHaveBeenCalled();
      expect(writeRemoteState).not.toHaveBeenCalled();
      expect(state.baseSnapshot).toEqual([]);
      expect(state.remoteSnapshot).toEqual([]);
    }

    const { state } = makeState();
    state.cacheBaseContent(
      entry.path,
      new TextEncoder().encode("migration preview must stay read-only").buffer,
    );
    await expect(state.getBaseContent(entry.path)).resolves.toBeUndefined();
  });

  it("owns the disposable remote plugin catalog and drops corrupt cache on load", async () => {
    const { state, plugin, saveData } = makeState();
    const items: DriveItem[] = [
      {
        id: "config",
        name: ".obsidian",
        folder: {},
        parentReference: { id: TEST_SCOPE.filesRootId },
      },
      {
        id: "plugins",
        name: "plugins",
        folder: {},
        parentReference: { id: "config" },
      },
      {
        id: "calendar-root",
        name: "calendar",
        folder: {},
        parentReference: { id: "plugins" },
      },
      {
        id: "calendar-main",
        name: "main.js",
        size: 4,
        file: { hashes: {} },
        parentReference: { id: "calendar-root" },
        eTag: "etag-main",
        cTag: "ctag-main",
      },
      {
        id: "calendar-manifest",
        name: "manifest.json",
        size: 8,
        file: { hashes: {} },
        parentReference: { id: "calendar-root" },
        eTag: "etag-manifest",
        cTag: "ctag-manifest",
      },
    ];
    const catalog = await buildRemoteCommunityPluginCatalog({
      scope: TEST_SCOPE,
      configDir: ".obsidian",
      items,
      manifestObservations: [],
      observedAt: 10,
      previous: null,
    });

    await state.load();
    await state.setRemoteCommunityPluginCatalog(catalog);
    await state.setRemoteCommunityPluginCatalog(catalog);

    expect(state.getRemoteCommunityPluginCatalog()).toEqual(catalog);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      "remote-community-plugin-catalog": catalog,
    }));

    vi.mocked(plugin.loadData).mockResolvedValue({
      "remote-community-plugin-catalog": catalog,
    });
    const validReopen = new StateManager(plugin);
    await validReopen.load();
    expect(validReopen.getRemoteCommunityPluginCatalog()).toEqual(catalog);

    vi.mocked(plugin.loadData).mockResolvedValue({
      "remote-community-plugin-catalog": {
        ...catalog,
        sourceDigest: "0".repeat(64),
      },
    });
    const reopened = new StateManager(plugin);
    await reopened.load();
    expect(reopened.getRemoteCommunityPluginCatalog()).toBeNull();
  });

  it("owns disposable manifest observations and discards corrupt cached evidence on load", async () => {
    const { state, plugin, saveData } = makeState();
    vi.mocked(plugin.loadData).mockResolvedValue({
      "community-plugin-manifest-observations": [{
        version: 1,
        scope: TEST_SCOPE,
        pluginId: "calendar",
        source: {
          path: ".obsidian/plugins/calendar/manifest.json",
          remoteId: "manifest-id",
          eTag: "etag-1",
          cTag: "ctag-1",
          size: 40,
          sha256Hash: null,
          quickXorHash: null,
          contentHash: "0".repeat(64),
        },
        manifestText: JSON.stringify({
          id: "calendar",
          version: "1.0.0",
          isDesktopOnly: true,
        }),
      }],
    });

    await state.load();

    expect(state.getCommunityPluginManifestObservations()).toEqual([]);
    expect(saveData).not.toHaveBeenCalled();

    const manifestText = JSON.stringify({
      id: "calendar",
      version: "1.0.0",
      isDesktopOnly: true,
    });
    const content = new TextEncoder().encode(manifestText).buffer;
    const observation = await createCommunityPluginManifestObservation(
      TEST_SCOPE,
      "calendar",
      {
        path: ".obsidian/plugins/calendar/manifest.json",
        driveId: "manifest-id",
        parentId: "plugin-folder-id",
        size: content.byteLength,
        mtime: 1,
        eTag: "etag-1",
        cTag: "ctag-1",
      },
      content,
    );

    await state.setCommunityPluginManifestObservations([observation]);
    await state.setCommunityPluginManifestObservations([observation]);

    expect(state.getCommunityPluginManifestObservations()).toEqual([
      observation,
    ]);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      "community-plugin-manifest-observations": [observation],
    }));
  });

  it("commits sync-path settings with scoped pending state and invalidates the reviewed plan", async () => {
    const { state, saveData } = makeState();
    await state.upsertPendingConflicts([
      conflict("Notes/keep.md"),
      conflict("Private/drop.md"),
    ]);
    await state.upsertPendingDeletes([
      pendingDelete("Notes/delete.md"),
      pendingDelete("Private/delete.md"),
    ]);
    await state.reconcilePendingIssues([
      {
        path: "Notes/retry.md",
        actionType: SyncActionType.Upload,
        updatedAt: 1,
      },
      {
        path: "Private/retry.md",
        actionType: SyncActionType.Upload,
        updatedAt: 1,
      },
    ], []);
    await state.setPlanReviewBundle(
      [conflict("Notes/keep.md"), conflict("Private/drop.md")],
      { uploads: 0, downloads: 0, deletes: 0, conflicts: 2, skipped: 0 },
      TEST_SCOPE,
    );
    const priorRevision = state.planReviewRevision;
    saveData.mockClear();

    await state.commitSyncPathSettingsChange(
      (path) => !path.toLocaleLowerCase().startsWith("private/"),
      (data) => {
        data["sync-excluded-folders"] = ["Private"];
      },
    );

    expect(state.pendingConflicts.map((item) => item.path)).toEqual(["Notes/keep.md"]);
    expect(state.pendingRemoteDeletes.map((item) => item.path)).toEqual(["Notes/delete.md"]);
    expect(state.pendingIssues.map((item) => item.path)).toEqual(["Notes/retry.md"]);
    expect(state.planReviewActive).toBe(false);
    expect(state.planReviewItems).toEqual([]);
    expect(state.planReviewRevision).toBe(priorRevision + 1);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      "sync-excluded-folders": ["Private"],
      "easy-sync-pending-conflicts": [expect.objectContaining({ path: "Notes/keep.md" })],
      "easy-sync-pending-remote-deletes": [expect.objectContaining({ path: "Notes/delete.md" })],
      "easy-sync-plan-review-active": false,
    }));
  });

  it("retires out-of-scope operational state without deleting sync history", async () => {
    const { state, saveData } = makeState();
    const pluginPath = ".obsidian/plugins/yolo/main.js";
    const notePath = "Notes/keep.md";
    await state.upsertPendingConflicts([
      conflict(pluginPath),
      conflict(notePath),
    ]);
    await state.upsertPendingDeletes([
      pendingDelete(pluginPath),
      pendingDelete(notePath),
    ]);
    await state.reconcilePendingIssues([{
      path: pluginPath,
      actionType: SyncActionType.Download,
      reason: "local write failed",
      updatedAt: 1,
    }, {
      path: notePath,
      actionType: SyncActionType.Upload,
      reason: "network",
      updatedAt: 1,
    }], []);
    await state.setPlanReviewBundle(
      [conflict(pluginPath), conflict(notePath)],
      { uploads: 0, downloads: 0, deletes: 0, conflicts: 2, skipped: 0 },
      TEST_SCOPE,
    );
    await state.addSyncHistory({
      id: "historical-yolo-failure",
      mode: "manual",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 1,
      message: "partial",
      files: [{ path: pluginPath, status: "error" }],
    });
    const priorRevision = state.planReviewRevision;
    saveData.mockClear();

    await state.retirePendingStateForPaths(
      (path) => path.startsWith(".obsidian/plugins/yolo/"),
    );

    expect(state.pendingConflicts.map((item) => item.path)).toEqual([notePath]);
    expect(state.pendingRemoteDeletes.map((item) => item.path)).toEqual([notePath]);
    expect(state.pendingIssues.map((item) => item.path)).toEqual([notePath]);
    expect(state.planReviewActive).toBe(false);
    expect(state.planReviewItems).toEqual([]);
    expect(state.planReviewRevision).toBe(priorRevision + 1);
    expect(state.syncHistory[0]?.files).toEqual([
      { path: pluginPath, status: "error" },
    ]);
    expect(saveData).toHaveBeenCalledTimes(1);
  });

  it("does not publish scoped pending state when the combined settings write fails", async () => {
    const { state, saveData } = makeState();
    await state.upsertPendingConflicts([
      conflict("Notes/keep.md"),
      conflict("Private/drop.md"),
    ]);
    await state.setPlanReviewBundle(
      [conflict("Private/drop.md")],
      { uploads: 0, downloads: 0, deletes: 0, conflicts: 1, skipped: 0 },
      TEST_SCOPE,
    );
    const priorRevision = state.planReviewRevision;
    saveData.mockRejectedValueOnce(new Error("disk full"));

    await expect(state.commitSyncPathSettingsChange(
      (path) => !path.startsWith("Private/"),
      (data) => {
        data["sync-excluded-folders"] = ["Private"];
      },
    )).rejects.toThrow("disk full");

    expect(state.pendingConflicts.map((item) => item.path)).toEqual([
      "Notes/keep.md",
      "Private/drop.md",
    ]);
    expect(state.planReviewActive).toBe(true);
    expect(state.planReviewRevision).toBe(priorRevision);
  });

  it("retires consumed folder move evidence with the local sync-path decision", async () => {
    const { state, plugin, saveData } = makeState();
    vi.mocked(plugin.loadData).mockResolvedValue({
      "easy-sync-local-folder-move-hints": [{
        version: 1,
        scope: TEST_SCOPE,
        remoteId: "plugin-folder-id",
        fromPath: ".obsidian/plugins/calendar",
        toPath: ".trash/.obsidian/plugins/calendar",
        observedAt: 1,
      }],
    });
    await state.load();
    saveData.mockClear();

    await state.commitSyncPathSettingsChange(
      () => true,
      (data) => {
        data["community-plugin-sync-policy"] = {
          version: 1,
          files: { mode: "all", pluginIds: [], ignoredPluginIds: ["calendar"] },
          data: { mode: "none", pluginIds: [] },
        };
      },
      undefined,
      {
        previousSettingsFingerprint: "before",
        targetSettingsFingerprint: "after",
        expandedFolderPaths: [],
        retireLocalFolderMoveHintRemoteIds: ["plugin-folder-id"],
      },
    );

    expect(state.localFolderMoveHints).toEqual([]);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      "easy-sync-local-folder-move-hints": [],
      "community-plugin-sync-policy": expect.objectContaining({
        files: expect.objectContaining({
          ignoredPluginIds: ["calendar"],
        }),
      }),
    }));
  });

  it("does not reconcile an identical conflict into public 1.1.3 state", async () => {
    const { state, saveData } = makeState();
    const path = "same.md";
    await state.upsertPendingConflicts([conflict(path)]);
    await state.setPlanReviewBundle(
      [conflict(path)],
      { uploads: 0, downloads: 0, deletes: 0, conflicts: 1, skipped: 0 },
      TEST_SCOPE,
    );
    saveData.mockClear();

    const entry: BaseFileEntry = {
      path,
      hash: "aa".repeat(32),
      size: 12,
      eTag: "etag-same",
    };
    await expect(state.reconcileIdenticalConflict(entry))
      .rejects.toThrow("active V2 state");

    expect(state.baseSnapshot).toEqual([]);
    expect(state.pendingConflicts).toEqual([conflict(path)]);
    expect(state.planReviewActive).toBe(true);
    expect(state.planReviewItems).toEqual([conflict(path)]);
    expect(saveData).not.toHaveBeenCalled();
  });

  it("keeps a public mutation receipt until V2 can commit its checkpoint", async () => {
    const { state, plugin } = makeState();
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "op-1",
      planRevision: 3,
      scope: TEST_SCOPE,
      action: "upload",
      path: "note.md",
      expectedLocal: { exists: true, hash: "aa".repeat(32), size: 10 },
      expectedRemote: { exists: false },
      createdAt: 1,
    };
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      parentId: "files-root-id",
      size: 10,
      mtime: 2,
      eTag: "etag-new",
      cTag: "ctag-new",
      sha256Hash: "aa".repeat(32),
    };
    const receipt: MutationReceiptV1 = {
      version: 1,
      operationId: intent.operationId,
      completedAt: 2,
      checkpoint: {
        baseUpserts: [{ path: "note.md", hash: "aa".repeat(32), size: 10, eTag: "etag-new" }],
        baseRemovals: [],
        remoteUpserts: [remote],
        remoteDeletes: [],
        pendingConflictRemovals: ["note.md"],
        pendingDeleteRemovals: ["note.md"],
      },
    };
    vi.mocked(plugin.loadData).mockResolvedValue({
      "easy-sync-mutation-ledger": [{ intent, receipt }],
    });
    await state.load();
    await state.upsertPendingConflicts([conflict("note.md")]);
    await state.upsertPendingDeletes([pendingDelete("note.md")]);

    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.baseSnapshot).toEqual([]);
    await expect(state.commitMutationCheckpoint(intent.operationId))
      .rejects.toThrow("active V2 authority");
    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.baseSnapshot).toEqual([]);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.pendingConflicts).toEqual([conflict("note.md")]);
    expect(state.pendingRemoteDeletes).toEqual([pendingDelete("note.md")]);
  });

  it("loads only merge intents with an exact target version", async () => {
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "merge-1",
      planRevision: 2,
      scope: TEST_SCOPE,
      action: "merge",
      path: "note.md",
      expectedLocal: { exists: true, hash: "aa".repeat(32), size: 10 },
      expectedRemote: {
        exists: true,
        driveId: "item-note",
        eTag: "etag-old",
        size: 11,
        sha256Hash: "bb".repeat(32),
      },
      target: { hash: "cc".repeat(32), size: 12 },
      createdAt: 1,
    };
    const loadState = async (candidate: MutationIntentV1) => {
      const plugin: PluginDataStore = {
        loadData: vi.fn().mockResolvedValue({
          "easy-sync-mutation-ledger": [{ intent: candidate, receipt: null }],
        }),
        updatePluginData: vi.fn().mockResolvedValue(undefined),
        manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
        app: {
          vault: {
            adapter: {
              read: vi.fn().mockRejectedValue(new Error("missing")),
              write: vi.fn().mockResolvedValue(undefined),
            },
          },
        },
      };
      const state = new StateManager(plugin);
      await state.load();
      return state;
    };

    const valid = await loadState(intent);
    expect(valid.hasMutationLedgerCorruption).toBe(false);
    expect(valid.mutationLedger).toEqual([{ intent, receipt: null }]);

    const corrupt = await loadState({
      ...intent,
      target: { hash: "not-a-sha256", size: -1 },
    });
    expect(corrupt.hasMutationLedgerCorruption).toBe(true);
    expect(corrupt.mutationLedger).toEqual([]);
  });

  it("loads V2 folder move/delete checkpoints and their consumed local hints", async () => {
    const intent: FolderMutationIntentV2 = {
      version: 2,
      operationId: "folder-move-1",
      planRevision: 4,
      scope: TEST_SCOPE,
      action: "moveRemoteFolder",
      path: "Archive",
      sourcePath: "Notes",
      folderId: "folder-notes",
      expectedLocal: { exists: true },
      expectedRemote: {
        exists: true,
        driveId: "folder-notes",
        parentId: TEST_SCOPE.filesRootId,
        eTag: "etag-notes",
      },
      expectedParent: {
        driveId: TEST_SCOPE.filesRootId,
        path: "",
      },
      createdAt: 1,
    };
    const receipt: MutationReceiptV1 = {
      version: 1,
      operationId: intent.operationId,
      completedAt: 2,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
        folderUpserts: [{
          path: "Archive",
          driveId: "folder-notes",
          parentId: TEST_SCOPE.filesRootId,
          name: "Archive",
          eTag: "etag-archive",
          cTag: "ctag-archive",
        }],
        folderMoveHintRemovals: ["folder-notes"],
      },
    };
    const plugin: PluginDataStore = {
      loadData: vi.fn().mockResolvedValue({
        "easy-sync-mutation-ledger": [{ intent, receipt }],
        "easy-sync-local-folder-move-hints": [{
          version: 1,
          scope: TEST_SCOPE,
          remoteId: "folder-notes",
          fromPath: "Notes",
          toPath: "Archive",
          observedAt: 1,
        }],
      }),
      updatePluginData: vi.fn().mockResolvedValue(undefined),
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
      app: {
        vault: {
          adapter: {
            read: vi.fn().mockRejectedValue(new Error("missing")),
            write: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
    };
    const state = new StateManager(plugin);

    await state.load();

    expect(state.hasMutationLedgerCorruption).toBe(false);
    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.localFolderMoveHints).toHaveLength(1);

    const legacyFolder = { ...receipt.checkpoint.folderUpserts![0] };
    delete legacyFolder.cTag;
    const legacyReceipt: MutationReceiptV1 = {
      ...receipt,
      checkpoint: {
        ...receipt.checkpoint,
        folderUpserts: [legacyFolder],
      },
    };
    const legacyPlugin: PluginDataStore = {
      ...plugin,
      loadData: vi.fn().mockResolvedValue({
        "easy-sync-mutation-ledger": [{ intent, receipt: legacyReceipt }],
      }),
    };
    const legacyState = new StateManager(legacyPlugin);

    await legacyState.load();

    expect(legacyState.hasMutationLedgerCorruption).toBe(false);
    expect(legacyState.mutationLedger).toEqual([{
      intent,
      receipt: legacyReceipt,
    }]);
  });

  it("rejects a folder checkpoint with a malformed content tag", async () => {
    const intent: FolderMutationIntentV2 = {
      version: 2,
      operationId: "folder-delete-invalid-ctag",
      planRevision: 4,
      scope: TEST_SCOPE,
      action: "deleteRemoteFolder",
      path: "Archive",
      folderId: "folder-archive",
      expectedLocal: { exists: false },
      expectedRemote: {
        exists: true,
        driveId: "folder-archive",
        parentId: TEST_SCOPE.filesRootId,
        eTag: "etag-archive",
      },
      createdAt: 1,
    };
    const plugin: PluginDataStore = {
      loadData: vi.fn().mockResolvedValue({
        "easy-sync-mutation-ledger": [{
          intent,
          receipt: {
            version: 1,
            operationId: intent.operationId,
            completedAt: 2,
            checkpoint: {
              baseUpserts: [],
              baseRemovals: [],
              remoteUpserts: [],
              remoteDeletes: [],
              pendingConflictRemovals: [],
              pendingDeleteRemovals: [],
              folderUpserts: [{
                path: "Archive",
                driveId: "folder-archive",
                parentId: TEST_SCOPE.filesRootId,
                name: "Archive",
                eTag: "etag-archive",
                cTag: 42,
              }],
            },
          },
        }],
      }),
      updatePluginData: vi.fn().mockResolvedValue(undefined),
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
      app: {
        vault: {
          adapter: {
            read: vi.fn().mockRejectedValue(new Error("missing")),
            write: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
    };
    const state = new StateManager(plugin);

    await state.load();

    expect(state.hasMutationLedgerCorruption).toBe(true);
    expect(state.mutationLedger).toEqual([]);
  });

  it("rejects a fresh remote cache mutation without a parent identity", async () => {
    const { state } = makeState();
    const incomplete: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      size: 10,
      mtime: 2,
      eTag: "etag-new",
      cTag: "ctag-new",
    };

    await expect(state.applyRemoteMutations([incomplete], []))
      .rejects.toThrow("parent identity");

    expect(state.remoteSnapshot).toEqual([]);
  });

  it("keeps a malformed public receipt blocked before V2 activation", async () => {
    const { state, plugin } = makeState();
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "op-incomplete-parent",
      planRevision: 1,
      scope: TEST_SCOPE,
      action: "upload",
      path: "note.md",
      expectedLocal: { exists: true, hash: "aa".repeat(32), size: 10 },
      expectedRemote: { exists: false },
      createdAt: 1,
    };
    const receipt: MutationReceiptV1 = {
      version: 1,
      operationId: intent.operationId,
      completedAt: 2,
      checkpoint: {
        baseUpserts: [],
        baseRemovals: [],
        remoteUpserts: [{
          path: "note.md",
          driveId: "item-note",
          size: 10,
          mtime: 2,
          eTag: "etag-new",
          cTag: "ctag-new",
        }],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    };
    vi.mocked(plugin.loadData).mockResolvedValue({
      "easy-sync-mutation-ledger": [{ intent, receipt }],
    });
    await state.load();

    await expect(state.commitMutationCheckpoint(intent.operationId))
      .rejects.toThrow("active V2 authority");

    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.remoteSnapshot).toEqual([]);
  });

  it("does not consume a public receipt before V2 activation", async () => {
    const { state, saveData, plugin } = makeState();
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "op-failed-checkpoint",
      planRevision: 1,
      scope: TEST_SCOPE,
      action: "download",
      path: "note.md",
      expectedLocal: { exists: false },
      expectedRemote: {
        exists: true,
        driveId: "item-note",
        eTag: "etag-note",
        size: 10,
        sha256Hash: "aa".repeat(32),
      },
      createdAt: 1,
    };
    const receipt: MutationReceiptV1 = {
      version: 1,
      operationId: intent.operationId,
      completedAt: 2,
      checkpoint: {
        baseUpserts: [{ path: "note.md", hash: "aa".repeat(32), size: 10, eTag: "etag-note" }],
        baseRemovals: [],
        remoteUpserts: [],
        remoteDeletes: [],
        pendingConflictRemovals: [],
        pendingDeleteRemovals: [],
      },
    };
    vi.mocked(plugin.loadData).mockResolvedValue({
      "easy-sync-mutation-ledger": [{ intent, receipt }],
    });
    await state.load();
    saveData.mockClear();

    await expect(state.commitMutationCheckpoint(intent.operationId))
      .rejects.toThrow("active V2 authority");

    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.baseSnapshot).toEqual([]);
    expect(saveData).not.toHaveBeenCalled();
  });

  it("does not publish a base snapshot before V2 activation", async () => {
    const { state, saveData } = makeState();
    const entry: BaseFileEntry = {
      path: "failed.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-failed",
    };
    await expect(state.upsertBaseEntries([entry]))
      .rejects.toThrow("active V2 state");

    expect(state.baseSnapshot).toEqual([]);
    expect(saveData).not.toHaveBeenCalled();
    await state.setLastSyncTime(123);
    expect(state.lastSyncTime).toBe(123);
    expect(saveData.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      "easy-sync-base-snapshot": {},
      "easy-sync-last-sync-time": 123,
    }));
  });

  it("keeps pending lists and scalar state unchanged when persistence fails", async () => {
    const { state, saveData } = makeState();
    saveData.mockRejectedValueOnce(new Error("disk full"));

    await expect(state.upsertPendingConflicts([conflict("failed.md")]))
      .rejects.toThrow("disk full");
    expect(state.pendingConflicts).toEqual([]);

    saveData.mockRejectedValueOnce(new Error("disk full"));
    await expect(state.setLastSyncTime(456)).rejects.toThrow("disk full");
    expect(state.lastSyncTime).toBe(0);
  });

  it("does not append preview content to the public ancestor cache", async () => {
    const { state } = makeState();
    const content = new TextEncoder().encode("base line 1\nbase line 2").buffer;

    state.cacheBaseContent("note.md", content);

    await expect(state.getBaseContent("note.md"))
      .resolves.toBeUndefined();
  });

  it("upserts a large conflict batch with one save", async () => {
    const { state, saveData } = makeState();
    const items = [
      ...Array.from({ length: 1000 }, (_, index) => conflict(`note-${index}.md`)),
      { ...conflict("note-0.md"), reason: "reason.updated" },
    ];

    await state.upsertPendingConflicts(items);

    expect(state.pendingConflicts).toHaveLength(1000);
    expect(state.pendingConflicts[0].reason).toBe("reason.updated");
    expect(saveData).toHaveBeenCalledTimes(1);
  });

  it("persists plan conflicts, deletes, and counts atomically", async () => {
    const { state, saveData } = makeState();
    const upload: SyncPlanItem = {
      type: SyncActionType.Upload,
      path: "upload.md",
      local: {
        path: "upload.md",
        size: 10,
        mtime: 1,
        hash: "aa".repeat(32),
        binary: false,
      },
    };
    const items = [
      upload,
      conflict("conflict.md"),
      pendingDelete("deleted.md"),
      {
        type: SyncActionType.SkipLargeFile,
        path: "large.bin",
        reason: "reason.fileExceedsSizeLimit",
      },
    ];

    await state.setPlanReviewBundle(
      items,
      { uploads: 1, downloads: 0, deletes: 1, conflicts: 1, skipped: 1 },
      TEST_SCOPE,
    );

    expect(state.planReviewActive).toBe(true);
    expect(state.planReviewRevision).toBe(1);
    expect(state.planReviewScope).toEqual(TEST_SCOPE);
    expect(state.pendingConflicts.map((item) => item.path)).toEqual(["conflict.md"]);
    expect(state.pendingRemoteDeletes.map((item) => item.path)).toEqual(["deleted.md"]);
    expect(state.planReviewCounts).toEqual({
      uploads: 1,
      downloads: 0,
      deletes: 1,
      conflicts: 1,
      skipped: 1,
    });
    expect(state.planReviewItems).toEqual([
      { type: SyncActionType.Upload, path: "upload.md", localHash: "aa".repeat(32), remoteETag: undefined, reason: undefined },
      { type: SyncActionType.Conflict, path: "conflict.md", localHash: undefined, remoteETag: undefined, reason: undefined },
      { type: SyncActionType.ConfirmLocalDelete, path: "deleted.md", localHash: undefined, remoteETag: undefined, reason: undefined },
      {
        type: SyncActionType.SkipLargeFile,
        path: "large.bin",
        reason: "reason.fileExceedsSizeLimit",
        localHash: undefined,
        remoteETag: undefined,
      },
    ]);
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(saveData.mock.calls[0][0]).toEqual(expect.objectContaining({
      "easy-sync-plan-review-active": true,
      "easy-sync-plan-review-revision": 1,
      "easy-sync-plan-review-scope": TEST_SCOPE,
      "easy-sync-plan-review-digest": state.planReviewDigest,
    }));
  });

  it("restores the previous review bundle when persistence fails", async () => {
    const { state } = makeState();
    const oldConflict = conflict("old.md");
    await state.setPlanReviewBundle(
      [oldConflict],
      { uploads: 0, downloads: 0, deletes: 0, conflicts: 1, skipped: 0 },
      TEST_SCOPE,
    );
    const oldDigest = state.planReviewDigest;
    const oldItems = state.planReviewItems;
    const oldCounts = state.planReviewCounts;
    const oldRevision = state.planReviewRevision;
    const oldScope = state.planReviewScope;
    const oldConflicts = state.pendingConflicts;
    const store = (state as unknown as {
      plugin: PluginDataStore;
    }).plugin;
    store.updatePluginData = vi.fn().mockRejectedValue(new Error("disk full"));

    await expect(state.setPlanReviewBundle(
      [{
        type: SyncActionType.Upload,
        path: "new.md",
        local: {
          path: "new.md",
          size: 1,
          mtime: 1,
          hash: "aa".repeat(32),
          binary: false,
        },
      }],
      { uploads: 1, downloads: 0, deletes: 0, conflicts: 0, skipped: 0 },
      { ...TEST_SCOPE, driveId: "drive-new" },
    )).rejects.toThrow("disk full");

    expect(state.planReviewActive).toBe(true);
    expect(state.planReviewDigest).toBe(oldDigest);
    expect(state.planReviewItems).toEqual(oldItems);
    expect(state.planReviewCounts).toEqual(oldCounts);
    expect(state.planReviewRevision).toBe(oldRevision);
    expect(state.planReviewScope).toEqual(oldScope);
    expect(state.pendingConflicts).toEqual(oldConflicts);
  });

  it("increments plan revisions and refuses a stale clear authorization", async () => {
    const { state } = makeState();
    const counts = { uploads: 0, downloads: 0, deletes: 0, conflicts: 0, skipped: 0 };

    await state.setPlanReviewBundle([], counts, TEST_SCOPE);
    const first = state.planReviewAuthorization;
    await state.setPlanReviewBundle([], counts, TEST_SCOPE);
    const second = state.planReviewAuthorization;

    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
    await expect(state.clearPlanReview(first ?? undefined)).resolves.toBe(false);
    expect(state.planReviewActive).toBe(true);
    await expect(state.clearPlanReview(second ?? undefined)).resolves.toBe(true);
    expect(state.planReviewActive).toBe(false);
    expect(state.planReviewRevision).toBe(2);
    expect(state.planReviewScope).toBeNull();
  });

  it("binds a V2 review revision to the sealed canonical identity", async () => {
    const { state, saveData } = makeState();
    const counts = {
      uploads: 0,
      downloads: 0,
      deletes: 0,
      conflicts: 0,
      skipped: 0,
    };
    const canonicalIdentity = {
      version: 2 as const,
      scope: TEST_SCOPE,
      sourceCommitSeq: 12,
      digest: "sealed-plan-12",
    };

    await state.setPlanReviewBundle(
      [],
      counts,
      TEST_SCOPE,
      canonicalIdentity,
    );
    const authorization = state.planReviewAuthorization;

    expect(state.planReviewDigest).toBe("sealed-plan-12");
    expect(state.planReviewCanonicalIdentity).toEqual(canonicalIdentity);
    expect(authorization).toEqual({
      revision: 1,
      scope: TEST_SCOPE,
      canonicalIdentity,
    });
    expect(saveData.mock.calls[0][0]).toEqual(expect.objectContaining({
      "easy-sync-plan-review-canonical-identity-v2": canonicalIdentity,
    }));

    await expect(state.clearPlanReview({
      ...authorization!,
      canonicalIdentity: {
        ...canonicalIdentity,
        digest: "different-plan",
      },
    })).resolves.toBe(false);
    expect(state.planReviewActive).toBe(true);
    await expect(state.clearPlanReview(authorization!)).resolves.toBe(true);
  });

  it("does not replace the public remote snapshot before V2 activation", async () => {
    const { state, saveData, writeRemoteState } = makeState();
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      parentId: "files-root-id",
      size: 10,
      mtime: 1,
      eTag: "etag",
      cTag: "ctag",
    };

    const scope = {
      accountId: "account-id",
      driveId: "drive-id",
      vaultFolderId: "vault-folder-id",
      filesRootId: "files-root-id",
    };
    const folder: RemoteFolderEntry = {
      path: "Empty",
      driveId: "empty-folder-id",
      parentId: "files-root-id",
      name: "Empty",
    };
    await expect(state.setRemoteState(
      [remote],
      "https://graph.example/delta-1",
      scope,
      [folder],
    )).rejects.toThrow("active V2 state");

    expect(state.hasRemoteState).toBe(false);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteDeltaLink).toBeNull();
    expect(state.remoteScope).toBeNull();
    expect(state.remoteFolders).toEqual([]);
    expect(state.hasCompleteRemoteFolderIndex).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    expect(writeRemoteState).not.toHaveBeenCalled();
  });

  it("loads a legacy remote cache without a files root identity", async () => {
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      size: 10,
      mtime: 1,
      eTag: "etag",
      cTag: "ctag",
    };
    const plugin: PluginDataStore = {
      loadData: vi.fn().mockResolvedValue({}),
      updatePluginData: vi.fn().mockResolvedValue(undefined),
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
      app: {
        vault: {
          adapter: {
            read: vi.fn().mockResolvedValue(JSON.stringify({
              version: 1,
              generation: 0,
              deltaLink: "https://graph.example/legacy",
              entries: { "note.md": remote },
            })),
            write: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
    };
    const state = new StateManager(plugin);

    await state.load();

    expect(state.hasRemoteState).toBe(true);
    expect(state.remoteScope).toBeNull();
    expect(state.remoteSnapshot).toEqual([remote]);
    expect(state.remoteFolders).toEqual([]);
    expect(state.hasCompleteRemoteFolderIndex).toBe(false);
  });

  it("ignores a corrupt persisted remote cache", async () => {
    const saveData = vi.fn().mockResolvedValue(undefined);
    const plugin: PluginDataStore = {
      loadData: vi.fn().mockResolvedValue({}),
      updatePluginData: vi.fn().mockImplementation(
        async (mutator) => { const d = (await plugin.loadData()) ?? {}; mutator(d); await saveData(d); },
      ),
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
      app: {
        vault: {
          adapter: {
            read: vi.fn().mockResolvedValue(JSON.stringify({
          version: 99,
          deltaLink: "expired",
          entries: { "stale.md": { path: "stale.md" } },
            })),
            write: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
    };
    const state = new StateManager(plugin);

    await state.load();

    expect(state.hasRemoteState).toBe(false);
    expect(state.remoteSnapshot).toEqual([]);
    expect(state.remoteDeltaLink).toBeNull();
  });

  it("keeps ten runs, every issue, and at most one hundred successful files per run", async () => {
    const { state } = makeState();
    const files = [
      { path: "early-error.md", status: "error" as const },
      { path: "early-skip.bin", status: "skip" as const },
      ...Array.from({ length: 120 }, (_, index) => ({
      path: `note-${index}.md`,
      status: "upload" as const,
      })),
      { path: "late-conflict.md", status: "conflict" as const },
    ];

    for (let index = 0; index < 12; index++) {
      await state.addSyncHistory({
        id: String(index),
        mode: "manual",
        status: "success",
        startedAt: index,
        endedAt: index + 1,
        uploaded: 120,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        skipped: 0,
        errors: 0,
        message: "synced",
        files,
      });
    }

    expect(state.syncHistory).toHaveLength(10);
    expect(state.syncHistory[0].id).toBe("11");
    expect(state.syncHistory[0].files).toHaveLength(103);
    expect(state.syncHistory[0].files.map((file) => file.path)).toContain("early-error.md");
    expect(state.syncHistory[0].files.map((file) => file.path)).toContain("early-skip.bin");
    expect(state.syncHistory[0].files.map((file) => file.path)).toContain("late-conflict.md");
    expect(state.syncHistory[0].files.filter((file) => file.status === "upload")).toHaveLength(100);
    expect(state.syncHistory[0].files.find((file) => file.path === "note-0.md")).toBeUndefined();
    expect(state.syncHistory[0].files.find((file) => file.path === "note-20.md")).toBeDefined();
    expect(state.syncHistory[9].id).toBe("2");
  });

  it("upserts file issues by path and removes resolved or stale entries", async () => {
    const { state } = makeState();

    await state.reconcilePendingIssues([
      {
        path: "upload.md",
        actionType: SyncActionType.Upload,
        reason: "network",
        updatedAt: 1,
      },
      {
        path: "large.bin",
        actionType: SyncActionType.SkipLargeFile,
        reason: "too large",
        updatedAt: 1,
      },
    ], []);
    await state.reconcilePendingIssues([
      {
        path: "upload.md",
        actionType: SyncActionType.Upload,
        reason: "rate limited",
        updatedAt: 2,
      },
    ], ["large.bin"]);

    expect(state.pendingIssues).toEqual([
      {
        path: "upload.md",
        actionType: SyncActionType.Upload,
        reason: "rate limited",
        updatedAt: 2,
        consecutiveFailures: 2,
      },
    ]);

    await state.prunePendingIssues([]);
    expect(state.pendingIssues).toEqual([]);
  });

  it("increments consecutive failures even when remoteETag is missing", async () => {
    const { state } = makeState();

    await state.reconcilePendingIssues([
      {
        path: "upload.md",
        actionType: SyncActionType.Upload,
        reason: "network",
        updatedAt: 1,
        localHash: "aa".repeat(32),
      },
    ], []);
    await state.reconcilePendingIssues([
      {
        path: "upload.md",
        actionType: SyncActionType.Upload,
        reason: "network",
        updatedAt: 2,
        localHash: "aa".repeat(32),
      },
    ], []);

    expect(state.pendingIssues).toEqual([
      {
        path: "upload.md",
        actionType: SyncActionType.Upload,
        reason: "network",
        updatedAt: 2,
        localHash: "aa".repeat(32),
        consecutiveFailures: 2,
      },
    ]);
  });

  it("does not count stable user-decision deferrals as transfer failures", async () => {
    const { state } = makeState();
    const issue = {
      path: "old.md",
      actionType: SyncActionType.FolderDeferred,
      reason: "needs a decision",
      updatedAt: 1,
    };

    await state.reconcilePendingIssues([issue], []);
    await state.reconcilePendingIssues([{ ...issue, updatedAt: 2 }], []);

    expect(state.pendingIssues).toEqual([{
      ...issue,
      updatedAt: 2,
    }]);
  });

  it("loads persisted sync history after a plugin restart", async () => {
    const savedEntry = {
      id: "saved",
      mode: "auto" as const,
      status: "partial" as const,
      startedAt: 1,
      endedAt: 2,
      uploaded: 1,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 1,
      message: "partial",
      files: [{ path: "failed.md", status: "error" as const }],
    };
    const saveData = vi.fn().mockResolvedValue(undefined);
    const plugin: PluginDataStore = {
      loadData: vi.fn().mockResolvedValue({ "easy-sync-history": [savedEntry] }),
      updatePluginData: vi.fn().mockImplementation(
        async (mutator) => { const d = (await plugin.loadData()) ?? {}; mutator(d); await saveData(d); },
      ),
      manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
      app: {
        vault: {
          adapter: {
            read: vi.fn().mockRejectedValue(new Error("missing")),
          },
        },
      },
    };
    const state = new StateManager(plugin);

    await state.load();

    expect(state.syncHistory).toEqual([savedEntry]);
  });
});

describe("StateManager reset generation contract", () => {
  it("reset clears the generation with the rest of the local sync records", async () => {
    const { state, saveData } = makeState();
    await state.load();

    // Simulate existing state: generation 7
    const gen7data = {};
    (state as unknown as Record<string, unknown>).incrementGen = async function () {
      for (let i = 0; i < 7; i++) await state.incrementRemoteGeneration();
    };
    for (let i = 0; i < 7; i++) {
      await state.incrementRemoteGeneration();
    }
    expect(state.remoteGeneration).toBe(7);

    // Reset returns the device to an unclassified local state.
    await state.reset();
    expect(state.remoteGeneration).toBe(0);

    // Repeating the idempotent cleanup stays fresh.
    await state.reset();
    expect(state.remoteGeneration).toBe(0);
  });

  it("starts at zero on fresh install", () => {
    const { state } = makeState();
    expect(state.remoteGeneration).toBe(0);
  });
});
