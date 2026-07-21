/**
 * Production adversarial tests for remote identity projection.
 *
 * These cases deliberately enter through SyncExecutor. They do not copy the
 * private projection or pollution algorithms into the test suite.
 */

import { describe, expect, it, vi } from "vitest";
import type { OneDriveClient } from "../src/onedrive/client";
import type { DriveItem } from "../src/onedrive/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import { StateManager } from "../src/sync/state-manager";
import { SyncExecutor } from "../src/sync/sync-executor";
import { SyncEngine } from "../src/sync/sync-engine";
import type { LocalFileEntry, RemoteFileEntry } from "../src/sync/types";

const ROOT_OLD = "files-root-old";
const ROOT_NEW = "files-root-new";
const CURRENT_SCOPE = {
  accountId: "account-current",
  driveId: "drive-current",
  vaultFolderId: "vault-current",
  filesRootId: ROOT_NEW,
};

function remoteEntry(path: string, driveId = `remote-${path}`): RemoteFileEntry {
  return {
    path,
    driveId,
    size: 4,
    mtime: 1,
    eTag: `etag-${driveId}`,
    cTag: `ctag-${driveId}`,
  };
}

function identityRemoteEntry(
  path: string,
  driveId: string,
  parentId: string,
): RemoteFileEntry & { parentId: string } {
  return {
    ...remoteEntry(path, driveId),
    parentId,
  };
}

function folder(id: string, name: string, parentId: string): DriveItem {
  return {
    id,
    name,
    folder: { childCount: 1 },
    parentReference: { id: parentId },
    eTag: `etag-${id}`,
  };
}

function file(id: string, name: string, parentId: string): DriveItem {
  return {
    id,
    name,
    size: 4,
    file: { hashes: { sha256Hash: "aa".repeat(32) } },
    parentReference: { id: parentId },
    lastModifiedDateTime: "2026-07-18T00:00:00.000Z",
    eTag: `etag-${id}`,
    cTag: `ctag-${id}`,
  };
}

async function makeMemoryState(initialRemoteState: unknown = null) {
  let persisted: Record<string, unknown> = {};
  let remoteStateJson: string | null = initialRemoteState === null
    ? null
    : JSON.stringify(initialRemoteState);
  let saveQueue: Promise<void> = Promise.resolve();
  const plugin = {
    loadData: vi.fn(async () => persisted),
    saveData: vi.fn(async (next: Record<string, unknown>) => {
      persisted = structuredClone(next);
    }),
    updatePluginData: vi.fn(async (mutator: (data: Record<string, unknown>) => void) => {
      const task = saveQueue.then(async () => {
        const data = (await plugin.loadData()) ?? {};
        mutator(data);
        await plugin.saveData(data);
      });
      saveQueue = task.catch(() => undefined);
      return task;
    }),
    manifest: { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          read: vi.fn(async () => {
            if (remoteStateJson === null) throw new Error("missing");
            return remoteStateJson;
          }),
          write: vi.fn(async (_path: string, value: string) => {
            remoteStateJson = value;
          }),
        },
      },
    },
  };
  const state = new StateManager(plugin);
  await state.load();
  return state;
}

function makeScanner(entries: LocalFileEntry[] = []): LocalScanner {
  return {
    vault: {
      adapter: {
        read: vi.fn().mockResolvedValue(""),
        write: vi.fn().mockResolvedValue(undefined),
        readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
        writeBinary: vi.fn().mockResolvedValue(undefined),
        appendBinary: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockResolvedValue(false),
        stat: vi.fn().mockResolvedValue(null),
      },
      getFiles: vi.fn().mockReturnValue([]),
      getName: vi.fn().mockReturnValue("testVault"),
    },
    scanAll: vi.fn().mockResolvedValue({
      entries,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    }),
    scanFile: vi.fn().mockResolvedValue(null),
  } as unknown as LocalScanner;
}

function makeEngine() {
  const generatePlan = vi.fn().mockReturnValue({
    items: [],
    lastTotalFiles: 0,
    confirmed: false,
  });
  return {
    generatePlan,
    engine: {
      generatePlan,
      shouldPauseForConfirmation: vi.fn().mockReturnValue(false),
    } as unknown as SyncEngine,
  };
}

function makeOneDrive(
  getDelta: ReturnType<typeof vi.fn>,
  filesRootId = ROOT_NEW,
) {
  const vaultScope = {
    driveId: "drive-current",
    vaultFolderId: "vault-current",
    filesRootId,
  };
  const mutations = {
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    downloadFileToPath: vi.fn(),
    deleteItem: vi.fn(),
  };
  return {
    client: {
      downloadBaseline: vi.fn().mockResolvedValue(null),
      initVaultScope: vi.fn().mockResolvedValue(vaultScope),
      restoreVaultScope: vi.fn().mockReturnValue(false),
      invalidateVaultScope: vi.fn(),
      isDeltaLinkForVault: vi.fn().mockReturnValue(true),
      setAbortSignal: vi.fn(),
      resetDownloadStrategy: vi.fn(),
      getDelta,
      fullScan: vi.fn().mockResolvedValue([]),
      getFileMetadata: vi.fn().mockResolvedValue(null),
      ...mutations,
    } as unknown as OneDriveClient,
    mutations,
  };
}

async function runIdentityRebuild(
  completeItems: DriveItem[],
  options: {
    filesRootId?: string;
    cached?: RemoteFileEntry[];
    local?: LocalFileEntry[];
  } = {},
) {
  const state = await makeMemoryState();
  await state.bindAccount(CURRENT_SCOPE.accountId);
  const cached = options.cached ?? [remoteEntry("old.md", "old-id")];
  await state.setRemoteState(cached, "https://graph.example/delta-old", {
    ...CURRENT_SCOPE,
    filesRootId: options.filesRootId ?? ROOT_NEW,
  });
  const getDelta = vi.fn()
    .mockResolvedValueOnce({
      value: [folder("changed-folder", "changed", options.filesRootId ?? ROOT_NEW)],
      "@odata.deltaLink": "https://graph.example/delta-unsafe",
    })
    .mockResolvedValueOnce({
      value: completeItems,
      "@odata.deltaLink": "https://graph.example/delta-rebuilt",
    });
  const { client, mutations } = makeOneDrive(
    getDelta,
    options.filesRootId ?? ROOT_NEW,
  );
  const { engine, generatePlan } = makeEngine();
  const executor = new SyncExecutor(
    client,
    makeScanner(options.local),
    engine,
    state,
    "testVault",
  );

  const result = await executor.run("first", {
    onFirstSyncPreview: vi.fn().mockResolvedValue(false),
  });
  return { state, getDelta, generatePlan, mutations, result };
}

function expectNoMutations(mutations: ReturnType<typeof makeOneDrive>["mutations"]): void {
  expect(mutations.uploadFile).not.toHaveBeenCalled();
  expect(mutations.downloadFile).not.toHaveBeenCalled();
  expect(mutations.downloadFileToPath).not.toHaveBeenCalled();
  expect(mutations.deleteItem).not.toHaveBeenCalled();
}

describe("remote identity projection adversarial contract", () => {
  it("publishes only descendants of the known files root", async () => {
    const result = await runIdentityRebuild([
      folder("vault-root", "testVault", "app-root"),
      folder(ROOT_NEW, "files", "vault-root"),
      folder("plugin-root", ".easy-sync", "vault-root"),
      folder("notes", "Notes", ROOT_NEW),
      file("note", "note.md", "notes"),
      file("internal", "baseline.json", "plugin-root"),
    ]);

    expect(result.state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "Notes/note.md", driveId: "note" }),
    ]);
    expect(result.state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
    expectNoMutations(result.mutations);
  });

  it("preserves a legitimate user folder literally named files", async () => {
    const result = await runIdentityRebuild([
      folder(ROOT_NEW, "files", "vault-root"),
      folder("user-files", "files", ROOT_NEW),
      file("note", "note.md", "user-files"),
    ]);

    expect(result.state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "files/note.md", driveId: "note" }),
    ]);
    expectNoMutations(result.mutations);
  });

  it("does not mistake a legitimate local files folder for legacy pollution", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    await state.setRemoteState(
      [remoteEntry("files/note.md", "note")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    );
    const local: LocalFileEntry = {
      path: "files/note.md",
      size: 4,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner([local]), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault", "https://graph.example/delta-old");
    expect(state.remoteSnapshot).toEqual([expect.objectContaining({ path: "files/note.md" })]);
    expectNoMutations(mutations);
  });

  it("keeps the committed snapshot when a scoped parent is missing", async () => {
    const result = await runIdentityRebuild([
      folder(ROOT_NEW, "files", "vault-root"),
      file("orphan", "orphan.md", "missing-parent"),
    ]);

    expect(result.result.success).toBe(false);
    expect(result.generatePlan).not.toHaveBeenCalled();
    expect(result.state.remoteSnapshot).toEqual([remoteEntry("old.md", "old-id")]);
    expect(result.state.remoteDeltaLink).toBe("https://graph.example/delta-old");
    expectNoMutations(result.mutations);
  });

  it("rejects a child whose parent identity is a file", async () => {
    const result = await runIdentityRebuild([
      folder(ROOT_NEW, "files", "vault-root"),
      file("not-folder", "parent.bin", ROOT_NEW),
      file("child", "child.md", "not-folder"),
    ]);

    expect(result.result.success).toBe(false);
    expect(result.generatePlan).not.toHaveBeenCalled();
    expect(result.state.remoteSnapshot).toEqual([remoteEntry("old.md", "old-id")]);
    expectNoMutations(result.mutations);
  });

  it("rejects an unrelated component that cannot be proven outside the root", async () => {
    const result = await runIdentityRebuild([
      folder("notes", "Notes", ROOT_NEW),
      file("note", "note.md", "notes"),
      folder("other", "Other", "unknown-root"),
      file("outside", "outside.md", "other"),
    ]);

    expect(result.result.success).toBe(false);
    expect(result.generatePlan).not.toHaveBeenCalled();
    expect(result.state.remoteSnapshot).toEqual([remoteEntry("old.md", "old-id")]);
    expectNoMutations(result.mutations);
  });

  it("rejects Unicode-normalized or case-folded duplicate paths", async () => {
    const result = await runIdentityRebuild([
      folder(ROOT_NEW, "files", "vault-root"),
      file("upper", "Note.md", ROOT_NEW),
      file("lower", "note.md", ROOT_NEW),
    ]);

    expect(result.result.success).toBe(false);
    expect(result.result.message).toBe("result.syncFailed");
    expect(result.state.remoteSnapshot).toEqual([remoteEntry("old.md", "old-id")]);
    expectNoMutations(result.mutations);
  });

  it("honors latest-by-id deletion in a complete snapshot", async () => {
    const deleted: DriveItem = {
      id: "note",
      name: "note.md",
      deleted: { state: "deleted" },
      parentReference: { id: ROOT_NEW },
    };
    const result = await runIdentityRebuild([
      folder(ROOT_NEW, "files", "vault-root"),
      file("note", "note.md", ROOT_NEW),
      deleted,
    ]);

    expect(result.state.remoteSnapshot).toEqual([]);
    expect(result.state.remoteDeltaLink).toBe("https://graph.example/delta-rebuilt");
    expectNoMutations(result.mutations);
  });

  it("keeps an existing file under its identity-proven parent when Graph path text contradicts it", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    await state.setRemoteState(
      [identityRemoteEntry("Safe/old-name.md", "note", "safe-folder")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    );
    const changed = file("note", "new-name.md", "safe-folder");
    changed.parentReference!.path = "/drives/drive-current/root:/Apps/EasySync/vaults/testVault/files/Forged";
    const getDelta = vi.fn().mockResolvedValue({
      value: [changed],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner(), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Safe/new-name.md",
        driveId: "note",
        parentId: "safe-folder",
      }),
    ]);
    expectNoMutations(mutations);
  });

  it("applies a pathless file update when the cached and live parent identities match", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    await state.setRemoteState(
      [identityRemoteEntry("Safe/note.md", "note", "safe-folder")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [file("note", "note.md", "safe-folder")],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner(), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Safe/note.md",
        driveId: "note",
        parentId: "safe-folder",
      }),
    ]);
    expectNoMutations(mutations);
  });

  it("rebuilds identity state for a new nested file instead of trusting Graph path text", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    await state.setRemoteState(
      [],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    );
    const unproven = file("note", "note.md", "unknown-folder");
    unproven.parentReference!.path = "/drives/drive-current/root:/Apps/EasySync/vaults/testVault/files/Forged";
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [unproven],
        "@odata.deltaLink": "https://graph.example/delta-unsafe",
      })
      .mockResolvedValueOnce({
        value: [
          folder("safe-folder", "Safe", ROOT_NEW),
          file("note", "note.md", "safe-folder"),
        ],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      });
    const { client, mutations } = makeOneDrive(getDelta);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner(), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenNthCalledWith(1, "testVault", "https://graph.example/delta-old");
    expect(getDelta).toHaveBeenNthCalledWith(2, "testVault");
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({
        path: "Safe/note.md",
        driveId: "note",
        parentId: "safe-folder",
      }),
    ]);
    expectNoMutations(mutations);
  });

  it("does not let an unknown tombstone delete a cached file by matching path text", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    await state.setRemoteState(
      [identityRemoteEntry("Safe/note.md", "real-note", "safe-folder")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    );
    const getDelta = vi.fn().mockResolvedValue({
      value: [{
        id: "unrelated-deleted-id",
        name: "note.md",
        deleted: { state: "deleted" },
        parentReference: {
          id: "safe-folder",
          path: "/drives/drive-current/root:/Apps/EasySync/vaults/testVault/files/Safe",
        },
      } satisfies DriveItem],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner(), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "Safe/note.md", driveId: "real-note" }),
    ]);
    expectNoMutations(mutations);
  });

  it("keeps the same identity-projected view on the following zero-delta round", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    const getDelta = vi.fn()
      .mockResolvedValueOnce({
        value: [
          folder("safe-folder", "Safe", ROOT_NEW),
          file("note", "note.md", "safe-folder"),
        ],
        "@odata.deltaLink": "https://graph.example/delta-1",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-2",
      });
    const { client, mutations } = makeOneDrive(getDelta);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner(), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });
    const firstSnapshot = structuredClone(state.remoteSnapshot);
    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenNthCalledWith(1, "testVault");
    expect(getDelta).toHaveBeenNthCalledWith(2, "testVault", "https://graph.example/delta-1");
    expect(state.remoteSnapshot).toEqual(firstSnapshot);
    expect(state.remoteDeltaLink).toBe("https://graph.example/delta-2");
    expectNoMutations(mutations);
  });

  it("rebuilds instead of reusing a cursor bound to a different files root", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    await (state as unknown as {
      setRemoteState(entries: RemoteFileEntry[], deltaLink: string, scope: typeof CURRENT_SCOPE): Promise<void>;
    }).setRemoteState(
      [remoteEntry("old-name.md", "note")],
      "https://graph.example/delta-old",
      { ...CURRENT_SCOPE, filesRootId: ROOT_OLD },
    );
    const getDelta = vi.fn().mockImplementation(async (_vaultName: string, deltaLink?: string) => {
      if (deltaLink) {
        return { value: [], "@odata.deltaLink": "https://graph.example/delta-wrongly-reused" };
      }
      return {
        value: [file("note", "current-name.md", ROOT_NEW)],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      };
    });
    const { client, mutations } = makeOneDrive(getDelta, ROOT_NEW);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner(), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "current-name.md", driveId: "note" }),
    ]);
    expectNoMutations(mutations);
  });

  it.each([
    ["account", { accountId: "account-old", driveId: "drive-current", vaultFolderId: "vault-current" }],
    ["drive", { accountId: "account-current", driveId: "drive-old", vaultFolderId: "vault-current" }],
    ["vault folder", { accountId: "account-current", driveId: "drive-current", vaultFolderId: "vault-old" }],
  ])("rebuilds instead of reusing a cursor bound to a different %s identity", async (_label, oldScope) => {
    const state = await makeMemoryState({
      version: 1,
      generation: 0,
      // Kept only so the pre-scope implementation would consider the old
      // cache reusable. The production assertion below must defeat that.
      filesRootId: ROOT_NEW,
      scope: { ...oldScope, filesRootId: ROOT_NEW },
      deltaLink: "https://graph.example/delta-old",
      entries: {
        "old-name.md": remoteEntry("old-name.md", "note"),
      },
    });
    await state.bindAccount("account-current");
    const getDelta = vi.fn().mockImplementation(async (_vaultName: string, deltaLink?: string) => {
      if (deltaLink) {
        return { value: [], "@odata.deltaLink": "https://graph.example/delta-wrongly-reused" };
      }
      return {
        value: [file("note", "current-name.md", ROOT_NEW)],
        "@odata.deltaLink": "https://graph.example/delta-rebuilt",
      };
    });
    const { client, mutations } = makeOneDrive(getDelta, ROOT_NEW);
    const { engine } = makeEngine();
    const executor = new SyncExecutor(client, makeScanner(), engine, state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "current-name.md", driveId: "note" }),
    ]);
    expectNoMutations(mutations);
  });

  it("runs the V2 shadow from the production full-rebuild path without mutations", async () => {
    const state = await makeMemoryState();
    await state.bindAccount(CURRENT_SCOPE.accountId);
    const local: LocalFileEntry = {
      path: "Safe/note.md",
      size: 4,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    await state.updateBaseEntry({
      path: local.path,
      size: local.size,
      hash: local.hash,
      eTag: "etag-note",
    });
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        folder("safe-folder", "Safe", ROOT_NEW),
        file("note", "note.md", "safe-folder"),
      ],
      "@odata.deltaLink": "https://graph.example/delta-shadow",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const log = vi.fn();
    const diag = { log, warn: vi.fn(), error: vi.fn() } as unknown as DiagnosticLogger;
    const executor = new SyncExecutor(
      client,
      makeScanner([local]),
      new SyncEngine(),
      state,
      "testVault",
      undefined,
      undefined,
      diag,
    );

    await executor.run("first", {
      onFirstSyncPreview: vi.fn().mockResolvedValue(false),
    });

    const shadowCall = log.mock.calls.find(([category, message]) =>
      category === "plan" && String(message).startsWith("V2 read-only shadow"));
    expect(shadowCall?.[2]).toMatchObject({
      status: "match",
      remoteCounts: { v1: 1, v2: 1 },
      planCounts: { v1: 0, v2: 0 },
      mutations: [],
      manifestWrites: 0,
    });
    expectNoMutations(mutations);
  });
});
