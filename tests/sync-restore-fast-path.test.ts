// 「保留文件」的回收站恢复快路径：只对 ≥8 MiB 文件、只在 cTag 能证明
// 「恢复出来的就是上次同步那一版」时免上传；其余路径必须回到现役上传或
// 保留待确认行，不得盲上传。
import "fake-indexeddb/auto";
import {
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { quickXorHashBase64, sha256Hex } from "../src/crypto";
import {
  OneDriveError,
  OneDriveErrorType,
  type DriveItem,
} from "../src/onedrive/types";
import {
  makeHarness,
  scope,
} from "./helpers/state-v2-activation-harness";

const BIG_SIZE = 8 * 1024 * 1024;
let bigText: string;
let bigHash: string;
let bigQuickXor: string;

beforeAll(async () => {
  bigText = "a".repeat(BIG_SIZE);
  const bytes = new TextEncoder().encode(bigText);
  bigHash = await sha256Hex(bytes);
  bigQuickXor = quickXorHashBase64(bytes);
});

type Harness = ReturnType<typeof makeHarness>;

function makeBigFileHarness(options: {
  inFolder?: boolean;
  remoteCTag?: string | null;
} = {}): {
  harness: Harness;
  filePath: string;
  fileId: string;
  parentId: string;
  folderId: string | null;
} {
  const inFolder = options.inFolder === true;
  const filePath = inFolder ? "Notes/big.bin" : "big.bin";
  const fileId = "file-big";
  const folderId = inFolder ? "folder-notes" : null;
  const parentId = folderId ?? scope.filesRootId;
  const remoteCTag = options.remoteCTag === undefined
    ? "ctag-big"
    : options.remoteCTag;
  const remoteItems: DriveItem[] = [
    ...(folderId
      ? [{
        id: folderId,
        name: "Notes",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-notes",
        cTag: "ctag-notes",
      } satisfies DriveItem]
      : []),
    {
      id: fileId,
      name: "big.bin",
      size: BIG_SIZE,
      file: { hashes: { sha256Hash: bigHash, quickXorHash: bigQuickXor } },
      parentReference: { id: parentId },
      eTag: "etag-big",
      ...(remoteCTag === null ? {} : { cTag: remoteCTag }),
    },
  ];
  const harness = makeHarness({
    base: [{ path: filePath, size: BIG_SIZE, hash: bigHash, eTag: "etag-big" }],
    local: [{
      path: filePath,
      size: BIG_SIZE,
      mtime: 1,
      hash: bigHash,
      quickXorHash: bigQuickXor,
      binary: true,
    }],
    localFolders: folderId ? [{ path: "Notes" }] : [],
    remoteItems,
    initialFiles: { [filePath]: bigText },
    remoteFileContents: { [filePath]: bigText },
  });
  return { harness, filePath, fileId, parentId, folderId };
}

async function activateAndLoseRemote(
  harness: Harness,
  fileId: string,
): Promise<void> {
  await harness.state.load();
  const activated = await harness.executor.run(
    "manual",
    {},
    false,
    undefined,
    { activateV2State: true },
  );
  expect(activated.success).toBe(true);
  const index = harness.remoteItemState.findIndex((item) => item.id === fileId);
  expect(index).toBeGreaterThanOrEqual(0);
  harness.remoteItemState.splice(index, 1);
  const deleted = await harness.executor.run("manual");
  expect(deleted.success).toBe(true);
}

function restoredItem(input: {
  fileId: string;
  parentId: string;
  cTag?: string;
  eTag?: string;
  name?: string;
  includeSha256?: boolean;
}): DriveItem {
  return {
    id: input.fileId,
    name: input.name ?? "big.bin",
    size: BIG_SIZE,
    file: {
      hashes: {
        // OneDrive Personal normally omits SHA-256; default to that shape so
        // the test exercises the cTag proof instead of the sha256 shortcut.
        ...(input.includeSha256 ? { sha256Hash: bigHash } : {}),
        quickXorHash: bigQuickXor,
      },
    },
    parentReference: { id: input.parentId },
    eTag: input.eTag ?? "etag-big-restored",
    ...(input.cTag === undefined ? {} : { cTag: input.cTag }),
  };
}

function installRestore(
  harness: Harness,
  item: DriveItem,
): void {
  harness.mutations.restoreDeletedDriveItemById.mockImplementationOnce(async () => {
    harness.remoteItemState.push(item);
  });
}

describe("restore fast path for keeping a large remote-deleted file", () => {
  it("commits without uploading when the restored cTag matches the anchor", async () => {
    const { harness, filePath, fileId, parentId } = makeBigFileHarness();
    await activateAndLoseRemote(harness, fileId);
    expect(harness.state.pendingRemoteDeletes.map((item) => item.path))
      .toContain(filePath);
    harness.mutations.uploadFile.mockClear();
    installRestore(harness, restoredItem({ fileId, parentId, cTag: "ctag-big" }));

    await harness.executor.rejectRemoteDelete(filePath);

    expect(harness.mutations.restoreDeletedDriveItemById)
      .toHaveBeenCalledWith(fileId);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(harness.state.remoteETagForPath(filePath)).toBe("etag-big-restored");
    expect(await harness.executor.run("manual")).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      errors: 0,
    });
  });

  it("uploads over the restored item by id and If-Match when cTag differs", async () => {
    const { harness, filePath, fileId, parentId } = makeBigFileHarness();
    await activateAndLoseRemote(harness, fileId);
    harness.mutations.uploadFile.mockClear();
    const restored = restoredItem({
      fileId,
      parentId,
      cTag: "ctag-other",
      eTag: "etag-big-restored",
    });
    installRestore(harness, restored);
    harness.mutations.uploadFile.mockResolvedValueOnce({
      id: fileId,
      eTag: "etag-big-uploaded",
      size: BIG_SIZE,
      parentReference: { id: parentId },
    });

    await harness.executor.rejectRemoteDelete(filePath);

    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    const call = harness.mutations.uploadFile.mock.calls[0];
    expect(call[4]).toBe("etag-big-restored");
    expect(call[5]).toBe(fileId);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(harness.state.remoteETagForPath(filePath)).toBe("etag-big-uploaded");
  });

  it("falls back to the ordinary path upload when restore reports the item purged", async () => {
    const { harness, filePath, fileId } = makeBigFileHarness();
    await activateAndLoseRemote(harness, fileId);
    harness.mutations.uploadFile.mockClear();
    harness.mutations.restoreDeletedDriveItemById.mockRejectedValueOnce(
      new OneDriveError(OneDriveErrorType.NotFound, "not in recycle bin", 404),
    );
    harness.mutations.uploadFile.mockResolvedValueOnce({
      id: "file-big-uploaded",
      eTag: "etag-big-uploaded",
      size: BIG_SIZE,
      parentReference: { id: scope.filesRootId },
    });

    await harness.executor.rejectRemoteDelete(filePath);

    expect(harness.mutations.restoreDeletedDriveItemById).toHaveBeenCalledTimes(1);
    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    const call = harness.mutations.uploadFile.mock.calls[0];
    expect(call[4]).toBeUndefined();
    expect(call[5]).toBeUndefined();
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("keeps the row and does not upload when the restore outcome is ambiguous", async () => {
    const { harness, filePath, fileId } = makeBigFileHarness();
    await activateAndLoseRemote(harness, fileId);
    harness.mutations.uploadFile.mockClear();
    harness.mutations.restoreDeletedDriveItemById.mockRejectedValueOnce(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    );

    await harness.executor.rejectRemoteDelete(filePath);

    expect(harness.mutations.restoreDeletedDriveItemById).toHaveBeenCalledTimes(1);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.state.pendingRemoteDeletes.map((item) => item.path))
      .toContain(filePath);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("skips the restore when the committed parent folder cTag moved", async () => {
    const { harness, filePath, fileId, folderId, parentId } = makeBigFileHarness({
      inFolder: true,
    });
    await activateAndLoseRemote(harness, fileId);
    harness.mutations.uploadFile.mockClear();
    harness.mutations.restoreDeletedDriveItemById.mockClear();
    const baseGetById = harness.client.getDriveItemMetadataById
      .getMockImplementation()!;
    harness.client.getDriveItemMetadataById.mockImplementation(async (id: string) => {
      if (id === folderId) {
        return {
          id: folderId,
          name: "Notes",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-notes",
          cTag: "ctag-notes-changed",
        } as DriveItem;
      }
      return baseGetById(id);
    });
    harness.mutations.uploadFile.mockResolvedValueOnce({
      id: "file-big-uploaded",
      eTag: "etag-big-uploaded",
      size: BIG_SIZE,
      parentReference: { id: parentId },
    });

    await harness.executor.rejectRemoteDelete(filePath);

    expect(harness.mutations.restoreDeletedDriveItemById).not.toHaveBeenCalled();
    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.mutations.uploadFile.mock.calls[0][5]).toBeUndefined();
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
  });

  it("does not restore below the 8 MiB gate", async () => {
    const smallText = "small";
    const smallBytes = new TextEncoder().encode(smallText);
    const smallHash = await sha256Hex(smallBytes);
    const harness = makeHarness({
      base: [{ path: "small.md", size: smallBytes.byteLength, hash: smallHash, eTag: "etag-small" }],
      local: [{
        path: "small.md",
        size: smallBytes.byteLength,
        mtime: 1,
        hash: smallHash,
        quickXorHash: quickXorHashBase64(smallBytes),
        binary: false,
      }],
      localFolders: [],
      remoteItems: [{
        id: "file-small",
        name: "small.md",
        size: smallBytes.byteLength,
        file: { hashes: { sha256Hash: smallHash } },
        parentReference: { id: scope.filesRootId },
        eTag: "etag-small",
        cTag: "ctag-small",
      }],
      initialFiles: { "small.md": smallText },
      remoteFileContents: { "small.md": smallText },
    });
    await activateAndLoseRemote(harness, "file-small");
    harness.mutations.uploadFile.mockClear();
    harness.mutations.restoreDeletedDriveItemById.mockClear();
    harness.mutations.uploadFile.mockResolvedValueOnce({
      id: "file-small-uploaded",
      eTag: "etag-small-uploaded",
      size: smallBytes.byteLength,
      parentReference: { id: scope.filesRootId },
    });

    await harness.executor.rejectRemoteDelete("small.md");

    expect(harness.mutations.restoreDeletedDriveItemById).not.toHaveBeenCalled();
    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
  });

  it("does not restore when the anchor has no committed cTag", async () => {
    const { harness, filePath, fileId } = makeBigFileHarness({
      remoteCTag: null,
    });
    await activateAndLoseRemote(harness, fileId);
    harness.mutations.uploadFile.mockClear();
    harness.mutations.restoreDeletedDriveItemById.mockClear();
    harness.mutations.uploadFile.mockResolvedValueOnce({
      id: "file-big-uploaded",
      eTag: "etag-big-uploaded",
      size: BIG_SIZE,
      parentReference: { id: scope.filesRootId },
    });

    await harness.executor.rejectRemoteDelete(filePath);

    expect(harness.mutations.restoreDeletedDriveItemById).not.toHaveBeenCalled();
    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
  });

  it("removes a restored copy that landed under a different name, then uploads", async () => {
    const { harness, filePath, fileId, parentId } = makeBigFileHarness();
    await activateAndLoseRemote(harness, fileId);
    harness.mutations.uploadFile.mockClear();
    harness.mutations.deleteItem.mockClear();
    const misplaced = restoredItem({
      fileId,
      parentId,
      name: "big(1).bin",
    });
    installRestore(harness, misplaced);
    harness.mutations.uploadFile.mockResolvedValueOnce({
      id: "file-big-uploaded",
      eTag: "etag-big-uploaded",
      size: BIG_SIZE,
      parentReference: { id: parentId },
    });

    await harness.executor.rejectRemoteDelete(filePath);

    expect(harness.mutations.deleteItem).toHaveBeenCalledWith(
      expect.any(String),
      filePath,
      "etag-big-restored",
      fileId,
    );
    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    expect(harness.mutations.uploadFile.mock.calls[0][5]).toBeUndefined();
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
  });
});
