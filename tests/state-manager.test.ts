import { describe, expect, it, vi } from "vitest";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import { SyncActionType } from "../src/sync/types";
import type { BaseFileEntry, RemoteFileEntry, SyncPlanItem } from "../src/sync/types";

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
    );

    expect(state.planReviewActive).toBe(true);
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
  });

  it("marks the cloud baseline dirty only when base entries change", async () => {
    const { state, saveData } = makeState();
    const entry: BaseFileEntry = {
      path: "note.md",
      hash: "aa".repeat(32),
      size: 10,
      eTag: "etag",
    };

    await state.markCloudBaselineSynced();
    expect(state.needsCloudBaselineUpload).toBe(false);

    await state.upsertBaseEntries([entry]);
    expect(state.needsCloudBaselineUpload).toBe(true);

    await state.markCloudBaselineSynced();
    saveData.mockClear();
    await state.upsertBaseEntries([entry]);

    expect(state.needsCloudBaselineUpload).toBe(false);
    expect(saveData).not.toHaveBeenCalled();
  });

  it("persists the remote snapshot and delta link atomically", async () => {
    const { state, saveData, writeRemoteState } = makeState();
    const remote: RemoteFileEntry = {
      path: "note.md",
      driveId: "item-note",
      size: 10,
      mtime: 1,
      eTag: "etag",
      cTag: "ctag",
    };

    await state.setRemoteState([remote], "https://graph.example/delta-1");

    expect(state.hasRemoteState).toBe(true);
    expect(state.remoteSnapshot).toEqual([remote]);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-1");
    expect(saveData).not.toHaveBeenCalled();
    expect(writeRemoteState).toHaveBeenCalledTimes(1);
    expect(writeRemoteState.mock.calls[0][0]).toBe(
      ".obsidian/plugins/easy-sync/remote-state.json",
    );
    expect(JSON.parse(writeRemoteState.mock.calls[0][1])).toMatchObject({
      version: 1,
      deltaLink: "https://graph.example/delta-1",
      entries: { "note.md": remote },
    });
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
