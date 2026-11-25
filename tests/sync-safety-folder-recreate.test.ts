// 云端文件夹已删、本机同路径还在且有本机独有内容：整轮行为验证。
//
// 计划层用例（tests/folder-state-v2.test.ts）只证明“该发重建而不是删除”。
// 这个文件把一整轮真跑一遍：建云端文件夹 → 上传新内容 → 不删本机任何东西 →
// 整轮成功；再跑一轮应当零动作（收敛）。它补的是“判断对了，但执行链没接上”
// 的空档——计划层绿、执行链断的例子在本仓并不罕见。

import { describe, it, expect, vi } from "vitest";
import { TFolder } from "obsidian";
import { sha256Hex } from "../src/crypto";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import type { LocalFileEntry } from "../src/sync/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { DriveItem } from "../src/onedrive/types";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

describe("cloud-deleted folder with local-only content", () => {
  it("re-creates the folder, uploads the new note, deletes nothing and converges next round", async () => {
    const notePath = "Inbox/new-note.md";
    const noteBytes = new TextEncoder().encode("a note written on this device");
    const note: LocalFileEntry = {
      path: notePath,
      hash: await sha256Hex(noteBytes.buffer),
      size: noteBytes.byteLength,
      mtime: 1,
      binary: false,
    };
    const liveFolders = new Set(["Inbox"]);
    const readBinary = vi.fn(async (path: string) => {
      if (path !== notePath) throw new Error(`missing ${path}`);
      return noteBytes.slice(0).buffer;
    });
    const adapter = makeMockAdapter({
      exists: vi.fn(async (path: string) =>
        path === notePath || liveFolders.has(path)),
      stat: vi.fn(async (path: string) => {
        if (path === notePath) return { size: note.size, mtime: 1 };
        return liveFolders.has(path) ? { type: "folder", size: 0, mtime: 1 } : null;
      }),
      list: vi.fn(async (path: string) => {
        const prefix = path === "" ? "" : `${path}/`;
        const relative = (candidate: string) =>
          path === "" ? candidate : candidate.slice(prefix.length);
        return {
          files: path === "" || path === "Inbox" ? [notePath] : [],
          folders: [...liveFolders].filter((candidate) =>
            candidate !== path
            && candidate.startsWith(prefix)
            && !relative(candidate).includes("/")),
        };
      }),
      readBinary,
    });
    const trashFile = vi.fn(async (folder: TFolder) => {
      liveFolders.delete(folder.path);
    });
    // 云端文件夹已不存在：远端索引里没有 Inbox，只剩一条指向它的旧锚点。
    const state = makeActiveV2State([], [], {
      folderAnchors: [
        {
          remoteId: "inbox-old",
          lastPath: "Inbox",
          parentId: TEST_SYNC_SCOPE.filesRootId,
          eTag: "etag-inbox-old",
        },
      ],
    });
    const createdFolders = new Map<string, DriveItem>();
    const createFolderByParentId = vi.fn(
      async (parentDriveItemId: string, name: string): Promise<DriveItem> => {
        const created: DriveItem = {
          id: "inbox-recreated",
          name,
          folder: {},
          parentReference: { id: parentDriveItemId },
          eTag: "etag-inbox-recreated",
        };
        createdFolders.set(name, created);
        return created;
      },
    );
    const uploadFile = vi.fn(async () => ({
      id: "note-uploaded",
      eTag: "etag-note-uploaded",
      size: note.size,
      parentReference: { id: "inbox-recreated" },
    }));
    const scanner = {
      vault: {
        adapter,
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
        getAbstractFileByPath: vi.fn((path: string) =>
          liveFolders.has(path) ? new TFolder(path) : null),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [note],
        folders: [{ path: "Inbox" }],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn(async (path: string) =>
        path === notePath
          ? { status: "present" as const, entry: note }
          : { status: "missing" as const }),
      shouldSyncPath: vi.fn().mockReturnValue(true),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
    } as unknown as LocalScanner;
    const executor = new SyncExecutor(
      makeMockOneDrive({
        createFolderByParentId,
        uploadFile,
        getDriveItemMetadata: vi.fn(async (_vault: string, path: string) =>
          createdFolders.get(path.split("/").pop() ?? "") ?? null),
        getDriveItemMetadataById: vi.fn(async (id: string) => {
          if (id === TEST_SYNC_SCOPE.filesRootId) {
            return {
              id,
              name: "root",
              folder: {},
              parentReference: { id: "drive-root" },
              eTag: "etag-root",
            };
          }
          return [...createdFolders.values()].find((folder) => folder.id === id)
            ?? null;
        }),
      }),
      scanner,
      state,
      "testVault",
      undefined,
      undefined,
      undefined,
      { trashFile } as never,
    );

    const round = await executor.run("manual", {});

    // 云端把这条路径建回来了，父身份用的是同步根。
    expect(createFolderByParentId).toHaveBeenCalledTimes(1);
    expect(createFolderByParentId).toHaveBeenCalledWith(
      TEST_SYNC_SCOPE.filesRootId,
      "Inbox",
    );
    // 新笔记按普通上传进了重建出来的文件夹。
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(readBinary).toHaveBeenCalledWith(notePath);
    // 一个文件都没删：本机独有的内容不能被跟随删除带走。
    expect(trashFile).not.toHaveBeenCalled();
    expect(liveFolders.has("Inbox")).toBe(true);
    // 整轮成功、不计删除。
    expect(round.errors).toBe(0);
    expect(round.success).toBe(true);
    expect(round.foldersDeleted ?? 0).toBe(0);
    expect(round.uploaded).toBe(1);

    const second = await executor.run("manual", {});
    expect(second.errors).toBe(0);
    expect(second.success).toBe(true);
    expect(second.uploaded).toBe(0);
    expect(second.foldersCreated ?? 0).toBe(0);
    expect((second as SyncResult).deferred).toBe(0);
  });
});
