/**
 * Production adversarial tests for remote identity projection.
 *
 * These cases deliberately enter through SyncExecutor. They do not copy the
 * private projection or pollution algorithms into the test suite.
 */

import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import type { OneDriveClient } from "../src/onedrive/client";
import type { DriveItem } from "../src/onedrive/types";
import { getEasySyncPaths } from "../src/obsidian-compat";
import type { LocalScanner } from "../src/sync/local-scanner";
import { projectFileStatePathViewV2 } from "../src/sync/file-state-reducer-v2";
import { StateManager } from "../src/sync/state-manager";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { LocalFileEntry, RemoteFileEntry } from "../src/sync/types";

const ROOT_OLD = "files-root-old";
const ROOT_NEW = "files-root-new";
const CURRENT_SCOPE = {
  accountId: "account-current",
  driveId: "drive-current",
  vaultFolderId: "vault-current",
  filesRootId: ROOT_NEW,
};
const PATHS = getEasySyncPaths(".obsidian");

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
  const files = new Map<string, string>();
  const folders = new Set<string>();
  if (initialRemoteState !== null) {
    files.set(PATHS.remoteStateFile, JSON.stringify(initialRemoteState));
  }
  let saveQueue: Promise<void> = Promise.resolve();
  const parentPath = (path: string): string => {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "" : path.slice(0, separator);
  };
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
    read: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    }),
    write: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    readBinary: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return new TextEncoder().encode(value).buffer;
    }),
    writeBinary: vi.fn(async (path: string, value: ArrayBuffer) => {
      files.set(path, new TextDecoder().decode(value));
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
      folders.delete(path);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, value);
    }),
    mkdir: vi.fn(async (path: string) => {
      folders.add(path);
    }),
    list: vi.fn(async (path: string) => ({
      files: [...files.keys()]
        .filter((candidate) => parentPath(candidate) === path)
        .sort(),
      folders: [...folders]
        .filter((candidate) => parentPath(candidate) === path)
        .sort(),
    })),
  } as unknown as DataAdapter;
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
        adapter,
      },
    },
  };
  const state = new StateManager(plugin);
  await state.load();
  return state;
}

function publicRemoteState(
  entries: RemoteFileEntry[],
  deltaLink: string,
  scope: typeof CURRENT_SCOPE,
) {
  return {
    version: 1,
    generation: 0,
    scope,
    deltaLink,
    entries: Object.fromEntries(entries.map((entry) => [entry.path, entry])),
    folders: {},
    folderIndexComplete: true,
  };
}

function makeScanner(entries: LocalFileEntry[] = []): LocalScanner {
  const folderPaths = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index++) {
      folderPaths.add(segments.slice(0, index).join("/"));
    }
  }
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
      folders: [...folderPaths].sort().map((path) => ({ path, mtime: 1 })),
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    }),
    scanFile: vi.fn().mockResolvedValue(null),
    shouldSyncPath: vi.fn().mockReturnValue(true),
    shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
  } as unknown as LocalScanner;
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
  let sharedProtocol: { id: string; eTag: string; content: string } | null = null;
  let sharedProtocolV3: { id: string; eTag: string; content: string } | null = null;
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
      readSharedSyncProtocolObjects: vi.fn(async () => ({
        v2: sharedProtocol,
        v3: sharedProtocolV3,
      })),
      readSharedSyncProtocolV2: vi.fn(async () => sharedProtocol),
      createSharedSyncProtocolV2: vi.fn(async (
        _vaultName: string,
        content: string,
      ) => {
        sharedProtocol = {
          id: "protocol-id",
          eTag: "protocol-etag",
          content,
        };
        return { id: sharedProtocol.id, eTag: sharedProtocol.eTag };
      }),
      readSharedSyncProtocolV2ById: vi.fn(async (id: string) => {
        if (!sharedProtocol || sharedProtocol.id !== id) {
          throw new Error("protocol missing");
        }
        return sharedProtocol;
      }),
      readSharedSyncProtocolV3: vi.fn(async () => sharedProtocolV3),
      createSharedSyncProtocolV3: vi.fn(async (
        _vaultName: string,
        content: string,
      ) => {
        sharedProtocolV3 = {
          id: "protocol-v3-id",
          eTag: "protocol-v3-etag",
          content,
        };
        return { id: sharedProtocolV3.id, eTag: sharedProtocolV3.eTag };
      }),
      readSharedSyncProtocolV3ById: vi.fn(async (id: string) => {
        if (!sharedProtocolV3 || sharedProtocolV3.id !== id) {
          throw new Error("protocol V3 missing");
        }
        return sharedProtocolV3;
      }),
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
  const cached = options.cached ?? [remoteEntry("old.md", "old-id")];
  const cachedScope = {
    ...CURRENT_SCOPE,
    filesRootId: options.filesRootId ?? ROOT_NEW,
  };
  const state = await makeMemoryState(publicRemoteState(
    cached,
    "https://graph.example/delta-old",
    cachedScope,
  ));
  await state.bindAccount(CURRENT_SCOPE.accountId);
  const getDelta = vi.fn().mockResolvedValue({
    value: completeItems,
    "@odata.deltaLink": "https://graph.example/delta-rebuilt",
  });
  const { client, mutations } = makeOneDrive(
    getDelta,
    options.filesRootId ?? ROOT_NEW,
  );
  vi.mocked(client.fullScan).mockResolvedValue(completeItems);
  const executor = new SyncExecutor(
    client,
    makeScanner(options.local),
    state,
    "testVault",
  );

  const result = await executor.run("first", {
    onFirstSyncPreview: vi.fn().mockResolvedValue(false),
  });
  return { state, getDelta, mutations, result };
}

function pendingMigrationRemoteSnapshot(state: StateManager): RemoteFileEntry[] {
  const candidate = state.activeV2MigrationHold?.candidate;
  if (!candidate) throw new Error("expected a pending V2 migration candidate");
  return projectFileStatePathViewV2(candidate).remoteEntries;
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

    expect(pendingMigrationRemoteSnapshot(result.state)).toEqual([
      expect.objectContaining({ path: "Notes/note.md", driveId: "note" }),
    ]);
    expect(result.getDelta).toHaveBeenCalledWith("testVault");
    expect(result.state.remoteDeltaLink).toBe("https://graph.example/delta-old");
    expectNoMutations(result.mutations);
  });

  it("preserves a legitimate user folder literally named files", async () => {
    const result = await runIdentityRebuild([
      folder(ROOT_NEW, "files", "vault-root"),
      folder("user-files", "files", ROOT_NEW),
      file("note", "note.md", "user-files"),
    ]);

    expect(pendingMigrationRemoteSnapshot(result.state)).toEqual([
      expect.objectContaining({ path: "files/note.md", driveId: "note" }),
    ]);
    expectNoMutations(result.mutations);
  });

  it("does not mistake a legitimate local files folder for legacy pollution", async () => {
    const state = await makeMemoryState(publicRemoteState(
      [remoteEntry("files/note.md", "note")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    ));
    await state.bindAccount(CURRENT_SCOPE.accountId);
    const local: LocalFileEntry = {
      path: "files/note.md",
      size: 4,
      mtime: 1,
      hash: "aa".repeat(32),
      binary: false,
    };
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        folder("user-files", "files", ROOT_NEW),
        file("note", "note.md", "user-files"),
      ],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const executor = new SyncExecutor(client, makeScanner([local]), state, "testVault");

    await executor.run("first", {
      onFirstSyncPreview: vi.fn().mockResolvedValue(false),
    });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(pendingMigrationRemoteSnapshot(state)).toEqual([
      expect.objectContaining({ path: "files/note.md" }),
    ]);
    expect(state.remoteSnapshot).toEqual([
      expect.objectContaining({ path: "files/note.md" }),
    ]);
    expectNoMutations(mutations);
  });

  it("keeps the committed snapshot when a scoped parent is missing", async () => {
    const result = await runIdentityRebuild([
      folder(ROOT_NEW, "files", "vault-root"),
      file("orphan", "orphan.md", "missing-parent"),
    ]);
    expect(result.result.success).toBe(false);
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

    expect(pendingMigrationRemoteSnapshot(result.state)).toEqual([]);
    expect(result.state.remoteDeltaLink).toBe("https://graph.example/delta-old");
    expectNoMutations(result.mutations);
  });

  it("keeps an existing file under its identity-proven parent when Graph path text contradicts it", async () => {
    const state = await makeMemoryState(publicRemoteState(
      [identityRemoteEntry("Safe/old-name.md", "note", "safe-folder")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    ));
    await state.bindAccount(CURRENT_SCOPE.accountId);
    const changed = file("note", "new-name.md", "safe-folder");
    changed.parentReference!.path = "/drives/drive-current/root:/Apps/EasySync/vaults/testVault/files/Forged";
    const getDelta = vi.fn().mockResolvedValue({
      value: [folder("safe-folder", "Safe", ROOT_NEW), changed],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const executor = new SyncExecutor(client, makeScanner(), state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(pendingMigrationRemoteSnapshot(state)).toEqual([
      expect.objectContaining({
        path: "Safe/new-name.md",
        driveId: "note",
        parentId: "safe-folder",
      }),
    ]);
    expectNoMutations(mutations);
  });

  it("applies a pathless file update when the cached and live parent identities match", async () => {
    const state = await makeMemoryState(publicRemoteState(
      [identityRemoteEntry("Safe/note.md", "note", "safe-folder")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    ));
    await state.bindAccount(CURRENT_SCOPE.accountId);
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        folder("safe-folder", "Safe", ROOT_NEW),
        file("note", "note.md", "safe-folder"),
      ],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const executor = new SyncExecutor(client, makeScanner(), state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(pendingMigrationRemoteSnapshot(state)).toEqual([
      expect.objectContaining({
        path: "Safe/note.md",
        driveId: "note",
        parentId: "safe-folder",
      }),
    ]);
    expectNoMutations(mutations);
  });

  it("rebuilds identity state for a new nested file instead of trusting Graph path text", async () => {
    const state = await makeMemoryState(publicRemoteState(
      [],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    ));
    await state.bindAccount(CURRENT_SCOPE.accountId);
    const live = file("note", "note.md", "safe-folder");
    live.parentReference!.path =
      "/drives/drive-current/root:/Apps/EasySync/vaults/testVault/files/Forged";
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        folder("safe-folder", "Safe", ROOT_NEW),
        live,
      ],
      "@odata.deltaLink": "https://graph.example/delta-rebuilt",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const executor = new SyncExecutor(client, makeScanner(), state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(pendingMigrationRemoteSnapshot(state)).toEqual([
      expect.objectContaining({
        path: "Safe/note.md",
        driveId: "note",
        parentId: "safe-folder",
      }),
    ]);
    expectNoMutations(mutations);
  });

  it("does not let an unknown tombstone delete a cached file by matching path text", async () => {
    const state = await makeMemoryState(publicRemoteState(
      [identityRemoteEntry("Safe/note.md", "real-note", "safe-folder")],
      "https://graph.example/delta-old",
      CURRENT_SCOPE,
    ));
    await state.bindAccount(CURRENT_SCOPE.accountId);
    const getDelta = vi.fn().mockResolvedValue({
      value: [
        folder("safe-folder", "Safe", ROOT_NEW),
        file("real-note", "note.md", "safe-folder"),
        {
          id: "unrelated-deleted-id",
          name: "note.md",
          deleted: { state: "deleted" },
          parentReference: {
            id: "safe-folder",
            path: "/drives/drive-current/root:/Apps/EasySync/vaults/testVault/files/Safe",
          },
        } satisfies DriveItem,
      ],
      "@odata.deltaLink": "https://graph.example/delta-next",
    });
    const { client, mutations } = makeOneDrive(getDelta);
    const executor = new SyncExecutor(client, makeScanner(), state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(pendingMigrationRemoteSnapshot(state)).toEqual([
      expect.objectContaining({ path: "Safe/note.md", driveId: "real-note" }),
    ]);
    expectNoMutations(mutations);
  });

  it("keeps the same identity-projected migration view on a repeated full observation", async () => {
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
        value: [
          folder("safe-folder", "Safe", ROOT_NEW),
          file("note", "note.md", "safe-folder"),
        ],
        "@odata.deltaLink": "https://graph.example/delta-2",
      });
    const { client, mutations } = makeOneDrive(getDelta);
    const executor = new SyncExecutor(client, makeScanner(), state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });
    const firstSnapshot = pendingMigrationRemoteSnapshot(state);
    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenNthCalledWith(1, "testVault");
    expect(getDelta).toHaveBeenNthCalledWith(2, "testVault");
    expect(pendingMigrationRemoteSnapshot(state)).toEqual(firstSnapshot);
    expectNoMutations(mutations);
  });

  it("rebuilds instead of reusing a cursor bound to a different files root", async () => {
    const state = await makeMemoryState(publicRemoteState(
      [remoteEntry("old-name.md", "note")],
      "https://graph.example/delta-old",
      { ...CURRENT_SCOPE, filesRootId: ROOT_OLD },
    ));
    await state.bindAccount(CURRENT_SCOPE.accountId);
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
    const executor = new SyncExecutor(client, makeScanner(), state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(pendingMigrationRemoteSnapshot(state)).toEqual([
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
    const executor = new SyncExecutor(client, makeScanner(), state, "testVault");

    await executor.run("first", { onFirstSyncPreview: vi.fn().mockResolvedValue(false) });

    expect(getDelta).toHaveBeenCalledTimes(1);
    expect(getDelta).toHaveBeenCalledWith("testVault");
    expect(pendingMigrationRemoteSnapshot(state)).toEqual([
      expect.objectContaining({ path: "current-name.md", driveId: "note" }),
    ]);
    expectNoMutations(mutations);
  });

});
