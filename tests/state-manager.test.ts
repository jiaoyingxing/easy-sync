import { describe, expect, it, vi } from "vitest";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import { SyncActionType } from "../src/sync/types";
import type {
  BaseFileEntry,
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
          read: vi.fn().mockRejectedValue(new Error("missing")),
          write: writeRemoteState,
        },
      },
    },
  };
  return { state: new StateManager(plugin), saveData, writeRemoteState };
}

describe("StateManager batch persistence", () => {
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

  it("atomically commits an identical conflict as base and removes the pending item", async () => {
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
    await state.reconcileIdenticalConflict(entry);

    expect(state.baseSnapshot).toEqual([entry]);
    expect(state.pendingConflicts).toEqual([]);
    expect(state.planReviewActive).toBe(false);
    expect(state.planReviewItems).toEqual([]);
    expect(saveData).toHaveBeenCalledTimes(1);
  });

  it("keeps a mutation receipt until base, remote, and pending checkpoints commit", async () => {
    const { state } = makeState();
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
    await state.setRemoteState([], "https://graph.example/delta", TEST_SCOPE);
    await state.upsertPendingConflicts([conflict("note.md")]);
    await state.upsertPendingDeletes([pendingDelete("note.md")]);

    await state.beginMutationIntent(intent);
    await state.recordMutationReceipt(receipt);

    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.baseSnapshot).toEqual([]);
    await state.commitMutationCheckpoint(intent.operationId);
    expect(state.mutationLedger).toEqual([]);
    expect(state.baseSnapshot).toEqual(receipt.checkpoint.baseUpserts);
    expect(state.remoteSnapshot).toEqual([remote]);
    expect(state.pendingConflicts).toEqual([]);
    expect(state.pendingRemoteDeletes).toEqual([]);
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

  it("rejects a fresh remote cache mutation without a parent identity", async () => {
    const { state } = makeState();
    await state.setRemoteState([], "https://graph.example/delta", TEST_SCOPE);
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

  it("keeps a mutation receipt when its remote upsert lacks a parent identity", async () => {
    const { state } = makeState();
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
    await state.setRemoteState([], "https://graph.example/delta", TEST_SCOPE);
    await state.beginMutationIntent(intent);
    await state.recordMutationReceipt(receipt);

    await expect(state.commitMutationCheckpoint(intent.operationId))
      .rejects.toThrow("parent identity");

    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.remoteSnapshot).toEqual([]);
  });

  it("preserves a receipt when its shared-state checkpoint save fails", async () => {
    const { state, saveData } = makeState();
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
    await state.beginMutationIntent(intent);
    await state.recordMutationReceipt(receipt);
    saveData.mockRejectedValueOnce(new Error("disk full"));

    await expect(state.commitMutationCheckpoint(intent.operationId)).rejects.toThrow("disk full");

    expect(state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(state.baseSnapshot).toEqual([]);
  });

  it("does not publish a failed base snapshot write into memory or a later save", async () => {
    const { state, saveData } = makeState();
    const entry: BaseFileEntry = {
      path: "failed.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag-failed",
    };
    saveData.mockRejectedValueOnce(new Error("disk full"));

    await expect(state.upsertBaseEntries([entry])).rejects.toThrow("disk full");

    expect(state.baseSnapshot).toEqual([]);
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

  it("Preflight Merge — caches a text ancestor received as ArrayBuffer", () => {
    const { state } = makeState();
    const content = new TextEncoder().encode("base line 1\nbase line 2").buffer;

    state.cacheBaseContent("note.md", content);

    expect(state.getBaseContent("note.md")).toBe("base line 1\nbase line 2");
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

  it("persists the remote snapshot and delta link atomically", async () => {
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
    await state.setRemoteState(
      [remote],
      "https://graph.example/delta-1",
      scope,
      [folder],
    );

    expect(state.hasRemoteState).toBe(true);
    expect(state.remoteSnapshot).toEqual([remote]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-1");
    expect(state.remoteScope).toEqual(scope);
    expect(state.remoteFolders).toEqual([folder]);
    expect(saveData).not.toHaveBeenCalled();
    expect(writeRemoteState).toHaveBeenCalledTimes(1);
    expect(writeRemoteState.mock.calls[0][0]).toBe(
      ".obsidian/plugins/easy-sync/remote-state.json",
    );
    expect(JSON.parse(writeRemoteState.mock.calls[0][1])).toMatchObject({
      version: 1,
      scope,
      deltaLink: "https://graph.example/delta-1",
      entries: { "note.md": remote },
      folders: { "empty-folder-id": folder },
    });
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

describe("StateManager generation monotonic contract", () => {
  it("reset preserves incremented generation instead of resetting to zero", async () => {
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

    // Reset: generation must increase, not reset to 0
    await state.reset();
    expect(state.remoteGeneration).toBe(8);

    // Another reset: keeps incrementing
    await state.reset();
    expect(state.remoteGeneration).toBe(9);
  });

  it("starts at zero on fresh install", () => {
    const { state } = makeState();
    expect(state.remoteGeneration).toBe(0);
  });
});
