import { describe, expect, it } from "vitest";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";
import type { SyncResult } from "../src/sync/sync-executor";

/**
 * B3a（2026-11-24 用户拍板 ≤16 文件/16 MiB）：路径身份 provider 下的纯本机
 * 小文件夹改名，拆成「目标集合创建 + 每个后代文件一条 RenameRemote」。
 *
 * 真实坚果云集合 MOVE 返回 403，且集合 ID 就是路径，稳定 ID 的文件夹移动
 * 回执无法套用。拆解后每个文件仍是既有文件级事务：源复核、MOVE、目标回读、
 * 锚点重绑与恢复全部复用；文件夹锚点在最后一个文件移动完成后统一翻译到
 * 目标路径，旧集合空壳按「保留空集合」记忆隐藏，不会重建本机。
 */
async function firstSync(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
  expectedUploads: number,
): Promise<void> {
  expect((await harness.runRound("manual")).message)
    .toBe("result.pausedForReview");
  const result = await harness.confirmRound(
    harness.state.planReviewAuthorization!,
  );
  expect(result).toMatchObject({
    success: true,
    errors: 0,
    uploaded: expectedUploads,
  });
}

function expectZeroPlan(result: SyncResult): void {
  expect(result).toMatchObject({
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    filesMoved: 0,
    foldersMoved: 0,
    foldersCreated: 0,
    foldersDeleted: 0,
    conflicts: 0,
    deferred: 0,
    errors: 0,
  });
}

function folderAnchorPaths(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): string[] {
  const envelope = harness.state.getCommittedV2Envelope();
  expect(envelope?.folderAnchors).toBeTruthy();
  return Object.values(envelope!.folderAnchors!.byAnchorId)
    .map((anchor) => anchor.lastPath)
    .sort();
}

function retainedPaths(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): string[] {
  return harness.state.retainedEmptyCollections
    .map((entry) => entry.path)
    .sort();
}

describe("B3a 路径身份小文件夹改名拆解", () => {
  it("2 文件嵌套改名：目标建夹、逐文件 MOVE、锚点重绑、空壳保留、下一轮与重启零计划", async () => {
    let harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello webdav cold start\n",
        "docs/a.md": "alpha",
        "docs/sub/b.md": "beta",
      },
      localFolders: ["docs", "docs/sub"],
    });
    try {
      await firstSync(harness, 3);
      const root = harness.fake.rootPath;
      expect(harness.remoteSnapshot(`${root}/docs`))
        .toMatchObject({ kind: "collection" });

      harness.renameLocalFolder("docs", "renamed");
      const actions: string[] = [];
      const moved = await harness.runRound("manual", {
        onFileComplete: (path, actionType) => {
          actions.push(`${actionType}:${path}`);
        },
      });
      expect(moved).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        foldersCreated: 2,
        foldersMoved: 0,
        foldersDeleted: 0,
        filesMoved: 2,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
      });
      // 计划审阅/完成行的形状：先建目标集合（父先子后），再逐文件改名。
      expect(actions).toEqual([
        "createRemoteFolder:renamed",
        "createRemoteFolder:renamed/sub",
        "renameRemote:renamed/a.md",
        "renameRemote:renamed/sub/b.md",
      ]);

      expect(harness.remoteText(`${root}/docs/a.md`)).toBeNull();
      expect(harness.remoteText(`${root}/docs/sub/b.md`)).toBeNull();
      expect(harness.remoteText(`${root}/renamed/a.md`)).toBe("alpha");
      expect(harness.remoteText(`${root}/renamed/sub/b.md`)).toBe("beta");
      // 服务器不允许集合删除：旧集合空壳仍在远端，但没有文件。
      expect(harness.remoteSnapshot(`${root}/docs`))
        .toMatchObject({ kind: "collection" });
      expect(harness.remoteSnapshot(`${root}/docs/sub`))
        .toMatchObject({ kind: "collection" });

      expect(folderAnchorPaths(harness)).toEqual([
        "renamed",
        "renamed/sub",
      ]);
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);
      expect(retainedPaths(harness)).toEqual(["docs", "docs/sub"]);
      expect(harness.files.get("renamed/a.md")).toBe("alpha");
      expect(harness.files.get("renamed/sub/b.md")).toBe("beta");

      expectZeroPlan(await harness.runRound("manual"));

      harness = await harness.restart();
      expectZeroPlan(await harness.runRound("manual"));
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("总字节超过 16 MiB：整夹保持可见 defer，远端零变化", async () => {
    const big = "x".repeat(17 * 1024 * 1024);
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/big.bin": big,
        "docs/small.md": "small",
      },
      localFolders: ["docs"],
    });
    try {
      await firstSync(harness, 3);
      const root = harness.fake.rootPath;
      harness.renameLocalFolder("docs", "renamed");
      const moved = await harness.runRound("manual");
      expect(moved).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 0,
        filesMoved: 0,
        uploaded: 0,
        downloaded: 0,
        deferred: 1,
      });
      expect(harness.remoteBytes(`${root}/docs/big.bin`)?.byteLength)
        .toBe(17 * 1024 * 1024);
      expect(harness.remoteSnapshot(`${root}/renamed`)).toBeNull();
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("跨设备整夹改名：不自动执行文件夹级移动，两侧字节都保留", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
    });
    try {
      await firstSync(harness, 2);
      const root = harness.fake.rootPath;
      const remoteMoveStatus = await harness.moveRemote(
        `${root}/docs`,
        `${root}/renamed`,
      );
      expect(remoteMoveStatus).toBeGreaterThanOrEqual(200);
      expect(remoteMoveStatus).toBeLessThan(300);

      // 路径身份没有稳定 folder id，跨设备整夹改名仍不进文件级拆解：
      // 不执行任何文件夹级移动，也不删除任何一侧；冲突/延后至少一项可见。
      const moved = await harness.runRound("manual");
      expect(moved).toMatchObject({
        success: true,
        errors: 0,
        foldersMoved: 0,
        filesMoved: 0,
        uploaded: 0,
        deleted: 0,
      });
      expect(moved.conflicts + moved.deferred).toBeGreaterThan(0);
      expect(harness.remoteText(`${root}/renamed/a.md`)).toBe("alpha");
      expect(harness.files.get("docs/a.md")).toBe("alpha");
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);

      const again = await harness.runRound("manual");
      expect(again).toMatchObject({
        success: true,
        errors: 0,
        foldersMoved: 0,
        filesMoved: 0,
        deleted: 0,
      });
      expect(harness.files.get("docs/a.md")).toBe("alpha");
      expect(harness.remoteText(`${root}/renamed/a.md`)).toBe("alpha");
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("一个文件移动失败：其余完成、失败项保留两侧；下一轮只续做剩余并收口", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/a.md": "alpha",
        "docs/sub/b.md": "beta",
      },
      localFolders: ["docs", "docs/sub"],
    });
    try {
      await firstSync(harness, 3);
      const root = harness.fake.rootPath;
      harness.renameLocalFolder("docs", "renamed");
      harness.fake.failMoveFor(`${root}/docs/a.md`, 409);

      const partial = await harness.runRound("manual");
      expect(partial).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 2,
        foldersMoved: 0,
        filesMoved: 1,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 1,
      });
      // 失败文件两侧都保留；成功的文件已在目标。
      expect(harness.remoteText(`${root}/docs/a.md`)).toBe("alpha");
      expect(harness.remoteText(`${root}/renamed/a.md`)).toBeNull();
      expect(harness.remoteText(`${root}/renamed/sub/b.md`)).toBe("beta");
      expect(harness.files.get("renamed/a.md")).toBe("alpha");
      expect(harness.files.get("renamed/sub/b.md")).toBe("beta");
      // 源子树仍有文件身份：文件夹锚点不得提前重绑，续做记录保留。
      expect(folderAnchorPaths(harness)).toEqual([
        "docs",
        "docs/sub",
        "renamed",
        "renamed/sub",
      ]);
      expect(harness.state.pendingPathIdentityFolderMoves).toHaveLength(1);
      expect(retainedPaths(harness)).toEqual([]);

      harness.fake.clearMoveFailures();
      const continuation = await harness.runRound("manual");
      expect(continuation).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        filesMoved: 1,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
      });
      expect(harness.remoteText(`${root}/docs/a.md`)).toBeNull();
      expect(harness.remoteText(`${root}/renamed/a.md`)).toBe("alpha");
      expect(folderAnchorPaths(harness)).toEqual([
        "renamed",
        "renamed/sub",
      ]);
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);
      expect(retainedPaths(harness)).toEqual(["docs", "docs/sub"]);

      expectZeroPlan(await harness.runRound("manual"));
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});

describe("B3a 边界：保持失败关闭的形状", () => {
  it("移入新建父目录：第一轮建父夹，第二轮完成拆解，第三轮零计划", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/a.md": "alpha",
        "docs/sub/b.md": "beta",
      },
      localFolders: ["docs", "docs/sub"],
    });
    try {
      await firstSync(harness, 3);
      const root = harness.fake.rootPath;
      harness.localFolderPaths.add("container");
      harness.renameLocalFolder("docs", "container/docs");

      // 第一轮：目标父目录是本机新建的，先只建父集合；移动留到下一轮。
      const first = await harness.runRound("manual");
      expect(first).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 1,
        filesMoved: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(first.deferred).toBeGreaterThan(0);
      expect(harness.remoteSnapshot(`${root}/container`))
        .toMatchObject({ kind: "collection" });
      expect(harness.remoteText(`${root}/docs/a.md`)).toBe("alpha");
      expect(harness.remoteText(`${root}/container/docs/a.md`)).toBeNull();
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);

      // 第二轮：父级已提交，拆解正常执行。
      const second = await harness.runRound("manual");
      expect(second).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 2,
        filesMoved: 2,
        deferred: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(harness.remoteText(`${root}/container/docs/a.md`)).toBe("alpha");
      expect(harness.remoteText(`${root}/container/docs/sub/b.md`)).toBe("beta");
      expect(harness.remoteText(`${root}/docs/a.md`)).toBeNull();
      expect(folderAnchorPaths(harness)).toEqual([
        "container",
        "container/docs",
        "container/docs/sub",
      ]);
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);
      expect(retainedPaths(harness)).toEqual(["docs", "docs/sub"]);

      expectZeroPlan(await harness.runRound("manual"));
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("仅大小写改名：保持 defer，远端与两侧内容都不动", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
    });
    try {
      await firstSync(harness, 2);
      const root = harness.fake.rootPath;
      harness.renameLocalFolder("docs", "Docs");
      const first = await harness.runRound("manual");
      expect(first).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 0,
        filesMoved: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(first.deferred).toBeGreaterThan(0);
      expect(harness.remoteText(`${root}/docs/a.md`)).toBe("alpha");
      expect(harness.files.get("Docs/a.md")).toBe("alpha");
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);

      const again = await harness.runRound("manual");
      expect(again).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 0,
        filesMoved: 0,
      });
      expect(again.deferred).toBeGreaterThan(0);
      expect(harness.remoteText(`${root}/docs/a.md`)).toBe("alpha");
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("改名同时编辑内容：编辑内容落位、旧路径清理、文件夹身份不冒充移动", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
    });
    try {
      await firstSync(harness, 2);
      const root = harness.fake.rootPath;
      harness.renameLocalFolder("docs", "renamed");
      harness.files.set("renamed/a.md", "alpha edited");
      const entry = harness.localEntryState.find(
        (candidate) => candidate.path === "renamed/a.md",
      );
      expect(entry).toBeDefined();
      entry!.hash = "";
      entry!.size = new TextEncoder().encode("alpha edited").byteLength;

      // 没有宿主文件夹改名提示时，改内容的后代让整夹身份无法证明。当前安全
      // 结局是非身份移动：先把编辑后的内容建到目标并核验，再清理旧远端路径；
      // 旧文件夹锚点保持 defer，不会伪装成一次整夹身份移动。
      const moved = await harness.runRound("manual");
      expect(moved).toMatchObject({
        success: true,
        errors: 0,
        filesMoved: 0,
        uploaded: 1,
        downloaded: 0,
        deleted: 1,
        conflicts: 0,
      });
      expect(harness.remoteText(`${root}/docs/a.md`)).toBeNull();
      expect(harness.remoteText(`${root}/renamed/a.md`)).toBe("alpha edited");
      expect(harness.files.get("renamed/a.md")).toBe("alpha edited");
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
