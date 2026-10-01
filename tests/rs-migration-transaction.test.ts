import { describe, expect, it, vi } from "vitest";
import type { OneDriveClient } from "../src/onedrive/client";
import type { DriveItem } from "../src/onedrive/types";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import {
  REMOTELY_SAVE_METADATA_FILE_PREFIX,
  runRsMigrationTransaction,
  seedBaseEntriesFromRsAdoption,
  type RsMigrationTransactionOutcome,
} from "../src/sync/rs-migration-transaction";
import type {
  LocalFileEntry,
  RemoteFileEntry,
} from "../src/sync/types";

function forbiddenError(): OneDriveError {
  return new OneDriveError(OneDriveErrorType.Forbidden, "403 Forbidden", 403);
}

const FILES_ROOT_ID = "files-root-id";
const SOURCE_DIR_ID = "rs-vault-dir-id";

function localEntry(overrides: Partial<LocalFileEntry> = {}): LocalFileEntry {
  return {
    path: "note.md",
    size: 100,
    mtime: 1,
    hash: "a".repeat(64),
    quickXorHash: "qx-local",
    binary: false,
    ...overrides,
  };
}

function remoteEntry(overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry {
  return {
    path: "note.md",
    driveId: "remote-id",
    size: 100,
    mtime: 1,
    eTag: "etag-1",
    cTag: "ctag-1",
    quickXorHash: "qx-local",
    ...overrides,
  };
}

describe("seedBaseEntriesFromRsAdoption", () => {
  it("seeds identical-content paths with the local sha256 and remote eTag", () => {
    const seeds = seedBaseEntriesFromRsAdoption(
      [localEntry()],
      [remoteEntry()],
    );
    expect(seeds).toEqual([
      { path: "note.md", hash: "a".repeat(64), size: 100, eTag: "etag-1" },
    ]);
  });

  it("rejects a quickXor mismatch even when the sha256 is absent", () => {
    const seeds = seedBaseEntriesFromRsAdoption(
      [localEntry()],
      [remoteEntry({ quickXorHash: "qx-remote" })],
    );
    expect(seeds).toEqual([]);
  });

  it("rejects a size mismatch", () => {
    const seeds = seedBaseEntriesFromRsAdoption(
      [localEntry()],
      [remoteEntry({ size: 101 })],
    );
    expect(seeds).toEqual([]);
  });

  it("rejects when a present Graph sha256 disagrees with the local hash", () => {
    const seeds = seedBaseEntriesFromRsAdoption(
      [localEntry()],
      [remoteEntry({ sha256Hash: "b".repeat(64) })],
    );
    expect(seeds).toEqual([]);
  });

  it("accepts a case-insensitively equal Graph sha256", () => {
    const seeds = seedBaseEntriesFromRsAdoption(
      [localEntry()],
      [remoteEntry({ sha256Hash: "A".repeat(64) })],
    );
    expect(seeds).toHaveLength(1);
  });

  it("skips paths missing either quickXor hash or the local counterpart", () => {
    const seeds = seedBaseEntriesFromRsAdoption(
      [
        localEntry({ path: "no-local-qx.md", quickXorHash: undefined }),
        localEntry({ path: "other.md" }),
      ],
      [
        remoteEntry({ path: "no-local-qx.md" }),
        remoteEntry({ path: "unpaired.md" }),
        remoteEntry({ path: "no-etag.md", eTag: "" }),
      ],
    );
    expect(seeds).toEqual([]);
  });
});

interface TransactionHarness {
  client: OneDriveClient;
  detect: ReturnType<typeof vi.fn>;
  listChildren: ReturnType<typeof vi.fn>;
  moveItem: ReturnType<typeof vi.fn>;
  copyItem: ReturnType<typeof vi.fn>;
  pollArrival: ReturnType<typeof vi.fn>;
  deleteItem: ReturnType<typeof vi.fn>;
}

function folderItem(
  id: string,
  name: string,
  parentId: string,
): DriveItem {
  return {
    id,
    name,
    folder: {},
    eTag: `etag-${id}`,
    parentReference: { driveId: "drive-1", id: parentId },
  };
}

function createHarness(): TransactionHarness {
  const detect = vi.fn();
  const listChildren = vi.fn();
  const moveItem = vi.fn();
  const copyItem = vi.fn();
  const pollArrival = vi.fn();
  const deleteItem = vi.fn();
  const client = {
    detectRemotelySaveRepository: detect,
    listFolderChildrenById: listChildren,
    moveItemById: moveItem,
    copyItemById: copyItem,
    pollChildArrivedInParent: pollArrival,
    deleteItem,
  } as unknown as OneDriveClient;
  return { client, detect, listChildren, moveItem, copyItem, pollArrival, deleteItem };
}

/** Destination listings are consumed in order: pre-check, then per-phase
 *  verification / cleanup listings. Source listings mirror the current
 *  source state the test wants the mock to report. */
function listingQueue(pages: DriveItem[][]): ReturnType<typeof vi.fn> {
  const queue = [...pages];
  return vi.fn(() => Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!));
}

async function run(harness: TransactionHarness): Promise<RsMigrationTransactionOutcome> {
  return runRsMigrationTransaction({
    onedrive: harness.client,
    vaultName: "我的笔记",
    filesRootId: FILES_ROOT_ID,
  });
}

describe("runRsMigrationTransaction", () => {
  it("moves every child, cleans the metadata file, and returns the marker", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    // Listings in order: destination pre-check (empty), source children,
    // post-move destination (children + metadata file), cleanup re-list.
    harness.listChildren
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        folderItem("child-1", "笔记", SOURCE_DIR_ID),
        folderItem("child-2", " Attachments", SOURCE_DIR_ID),
        {
          id: "meta-id",
          name: `${REMOTELY_SAVE_METADATA_FILE_PREFIX}.json`,
          eTag: "etag-meta",
          parentReference: { driveId: "drive-1", id: SOURCE_DIR_ID },
        },
      ])
      .mockResolvedValue([
        folderItem("child-1", "笔记", FILES_ROOT_ID),
        folderItem("child-2", " Attachments", FILES_ROOT_ID),
        {
          id: "meta-id",
          name: `${REMOTELY_SAVE_METADATA_FILE_PREFIX}.json`,
          eTag: "etag-meta",
          parentReference: { driveId: "drive-1", id: FILES_ROOT_ID },
        },
      ]);
    harness.moveItem.mockImplementation(async (id: string, _eTag: string, name: string) =>
      folderItem(id, name, FILES_ROOT_ID));
    harness.deleteItem.mockResolvedValue(undefined);

    const outcome = await run(harness);
    expect(outcome.status).toBe("moved");
    // Three children moved (the metadata file among them) before its cleanup.
    expect(outcome.adoptedCount).toBe(3);
    expect(outcome.marker).toEqual({
      vaultName: "我的笔记",
      sourceVaultDirId: SOURCE_DIR_ID,
      strategy: "moved",
      completedAt: expect.any(Number),
    });
    expect(harness.moveItem).toHaveBeenCalledTimes(3);
    expect(harness.deleteItem).toHaveBeenCalledWith(
      "",
      "",
      undefined,
      "meta-id",
    );
  });

  it("falls back to copying the remainder when the move is refused", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    const firstChild = folderItem("child-1", "笔记", SOURCE_DIR_ID);
    const secondChild = folderItem("child-2", "附件", SOURCE_DIR_ID);
    harness.listChildren
      .mockResolvedValueOnce([])                          // destination pre-check
      .mockResolvedValueOnce([firstChild, secondChild])   // source children
      .mockResolvedValueOnce([firstChild])                // rollback listing (child-1 sits at dest)
      .mockResolvedValueOnce([])                          // copy-phase destination scan (rollback done)
      .mockResolvedValueOnce([firstChild, secondChild])   // copy-phase source re-read
      .mockResolvedValue([]);                             // cleanup re-list
    harness.moveItem
      .mockResolvedValueOnce(folderItem("child-1", "笔记", FILES_ROOT_ID)) // child-1 move verified
      .mockRejectedValueOnce(forbiddenError()) // child-2 refused
      .mockResolvedValue(folderItem("child-1", "笔记", SOURCE_DIR_ID));   // rollback succeeds
    harness.copyItem.mockImplementation(async (_id: string, _dest: string, name: string) =>
      folderItem(`copy-${name}`, name, FILES_ROOT_ID));

    const outcome = await run(harness);
    expect(outcome.status).toBe("copied");
    expect(outcome.adoptedCount).toBe(2);
    expect(outcome.marker?.strategy).toBe("copied");
    expect(harness.copyItem).toHaveBeenCalledTimes(2);
  });

  it("never double-adopts a child that already reached the destination", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    const firstChild = folderItem("child-1", "笔记", SOURCE_DIR_ID);
    const secondChild = folderItem("child-2", "附件", SOURCE_DIR_ID);
    harness.listChildren
      .mockResolvedValueOnce([])                          // destination pre-check
      .mockResolvedValueOnce([firstChild, secondChild])   // source children
      .mockResolvedValueOnce([firstChild])                // rollback listing (rollback will fail)
      .mockResolvedValueOnce([firstChild])                // copy-phase destination scan
      .mockResolvedValueOnce([firstChild, secondChild])   // copy-phase source re-read (stale overlap)
      .mockResolvedValue([]);                             // cleanup re-list
    harness.moveItem
      .mockResolvedValueOnce(folderItem("child-1", "笔记", FILES_ROOT_ID)) // child-1 move verified
      .mockRejectedValue(forbiddenError()); // child-2 refused; rollback also fails
    harness.copyItem.mockImplementation(async (_id: string, _dest: string, name: string) =>
      folderItem(`copy-${name}`, name, FILES_ROOT_ID));

    const outcome = await run(harness);
    expect(outcome.status).toBe("copied");
    expect(outcome.adoptedCount).toBe(2);
    // child-1 is adopted as already-present; only child-2 is copied.
    expect(harness.copyItem).toHaveBeenCalledTimes(1);
    expect(harness.copyItem).toHaveBeenCalledWith("child-2", FILES_ROOT_ID, "附件");
  });

  it("deletes only its own copies when the copy fallback fails", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    harness.listChildren
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        folderItem("child-1", "笔记", SOURCE_DIR_ID),
        folderItem("child-2", "附件", SOURCE_DIR_ID),
      ])
      .mockResolvedValueOnce([])   // copy-phase destination scan
      .mockResolvedValueOnce([
        folderItem("child-1", "笔记", SOURCE_DIR_ID),
        folderItem("child-2", "附件", SOURCE_DIR_ID),
      ])                            // copy-phase source re-read
      .mockResolvedValueOnce([folderItem("copy-笔记", "笔记", FILES_ROOT_ID)]);
    harness.moveItem.mockRejectedValueOnce(
      forbiddenError(),
    );
    harness.copyItem
      .mockResolvedValueOnce(folderItem("copy-笔记", "笔记", FILES_ROOT_ID))
      .mockRejectedValueOnce(new Error("network down"));

    const outcome = await run(harness);
    expect(outcome.status).toBe("failed");
    expect(outcome.marker).toBeNull();
    expect(harness.deleteItem).toHaveBeenCalledTimes(1);
    expect(harness.deleteItem).toHaveBeenCalledWith(
      "",
      "",
      undefined,
      "copy-笔记",
    );
  });

  it("rolls back moved children and fails when a later move errors", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    harness.listChildren
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        folderItem("child-1", "笔记", SOURCE_DIR_ID),
        folderItem("child-2", "附件", SOURCE_DIR_ID),
      ])
      .mockResolvedValue([folderItem("child-1", "笔记", FILES_ROOT_ID)]);
    harness.moveItem
      .mockResolvedValueOnce(folderItem("child-1", "笔记", FILES_ROOT_ID))
      .mockRejectedValueOnce(new Error("server exploded"));

    const outcome = await run(harness);
    expect(outcome.status).toBe("failed");
    expect(outcome.marker).toBeNull();
    // Rollback: child-1 moved back to the source directory.
    expect(harness.moveItem).toHaveBeenLastCalledWith(
      "child-1",
      expect.any(String),
      "笔记",
      SOURCE_DIR_ID,
    );
  });

  it("refuses a destination that is not empty", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    harness.listChildren.mockResolvedValueOnce([
      folderItem("existing", "已有内容", FILES_ROOT_ID),
    ]);
    const outcome = await run(harness);
    expect(outcome.status).toBe("destination-not-empty");
    expect(outcome.marker).toBeNull();
  });

  it("reports not-found without any listing when detection misses", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue(null);
    const outcome = await run(harness);
    expect(outcome.status).toBe("not-found");
    expect(harness.listChildren).not.toHaveBeenCalled();
  });

  it("reports an empty source as nothing to adopt", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    harness.listChildren
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const outcome = await run(harness);
    expect(outcome.status).toBe("empty-source");
    expect(outcome.marker).toBeNull();
  });

  it("fails closed when the metadata file cannot be deleted", async () => {
    const harness = createHarness();
    harness.detect.mockResolvedValue({
      driveId: "drive-1",
      appsContainerId: "apps-id",
      remotelySaveDirId: "rs-dir-id",
      vaultDirId: SOURCE_DIR_ID,
    });
    harness.listChildren
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([folderItem("child-1", "笔记", SOURCE_DIR_ID)])
      .mockResolvedValue([
        folderItem("child-1", "笔记", FILES_ROOT_ID),
        {
          id: "meta-id",
          name: `${REMOTELY_SAVE_METADATA_FILE_PREFIX}.json`,
          parentReference: { driveId: "drive-1", id: FILES_ROOT_ID },
        },
      ]);
    harness.moveItem.mockResolvedValue(
      folderItem("child-1", "笔记", FILES_ROOT_ID),
    );
    harness.deleteItem.mockRejectedValue(new Error("delete refused"));

    const outcome = await run(harness);
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("metadata-cleanup-failed");
    expect(outcome.marker).toBeNull();
  });
});
