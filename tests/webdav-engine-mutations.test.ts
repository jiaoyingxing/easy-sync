import { describe, expect, it } from "vitest";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

async function firstSync(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
): Promise<void> {
  expect((await harness.runRound("manual")).message)
    .toBe("result.pausedForReview");
  const result = await harness.confirmRound(
    harness.state.planReviewAuthorization!,
  );
  expect(result).toMatchObject({ success: true, uploaded: 1, errors: 0 });
}

function expectZeroPlan(result: Awaited<ReturnType<
  Awaited<ReturnType<typeof createWebDavColdStartHarness>>["runRound"]
>>): void {
  expect(result).toMatchObject({
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    filesMoved: 0,
    foldersMoved: 0,
    conflicts: 0,
    errors: 0,
  });
}

function expectAnchorAtPath(
  harness: Awaited<ReturnType<typeof createWebDavColdStartHarness>>,
  path: string,
  absentPath: string,
): void {
  const envelope = harness.state.getCommittedV2Envelope();
  expect(envelope).not.toBeNull();
  const anchors = Object.values(envelope!.anchors.byAnchorId);
  expect(anchors.some((anchor) =>
    anchor.lastPath === path && anchor.remoteId === path)).toBe(true);
  expect(anchors.some((anchor) => anchor.lastPath === absentPath)).toBe(false);
  expect(envelope!.remoteIndex.itemsById[path]).toBeDefined();
  expect(envelope!.remoteIndex.itemsById[absentPath]).toBeUndefined();
}

describe("W3b 引擎路径身份：文件改名", () => {
  it("同目录改名：远端 MOVE、锚点重绑、次轮零计划、重启后仍零计划", async () => {
    let harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await firstSync(harness);
      expect(harness.remoteText(`${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`))
        .toBe("hello webdav cold start\n");

      harness.renameLocal(WEBDAV_COLD_START_USER_PATH, "renamed.md");
      const result = await harness.runRound("manual");
      expect(result.errors).toBe(0);
      expect(result.filesMoved).toBe(1);
      expect(harness.remoteText(`${harness.fake.rootPath}/renamed.md`))
        .toBe("hello webdav cold start\n");
      expect(harness.remoteText(`${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`))
        .toBeNull();
      expectAnchorAtPath(harness, "renamed.md", WEBDAV_COLD_START_USER_PATH);

      expectZeroPlan(await harness.runRound("manual"));

      harness = await harness.restart();
      expectZeroPlan(await harness.runRound("manual"));
      expect(harness.remoteText(`${harness.fake.rootPath}/renamed.md`))
        .toBe("hello webdav cold start\n");
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("跨目录移动：先建远端父文件夹，下一轮 MOVE 文件，随后零计划", async () => {
    let harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
    });
    try {
      await firstSync(harness);
      harness.localFolderPaths.add("sub");
      harness.renameLocal(WEBDAV_COLD_START_USER_PATH, "sub/note.md");

      // 第 1 轮：父文件夹先落远端；文件移动依赖目标父锚点，下一轮再计划。
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
      expect(harness.remoteSnapshot(`${harness.fake.rootPath}/sub`))
        .toMatchObject({ kind: "collection" });

      // 第 2 轮：文件 MOVE 到新父目录。
      const second = await harness.runRound("manual");
      expect(second).toMatchObject({
        success: true,
        errors: 0,
        filesMoved: 1,
        foldersCreated: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(harness.remoteText(`${harness.fake.rootPath}/sub/note.md`))
        .toBe("hello webdav cold start\n");
      expect(harness.remoteText(`${harness.fake.rootPath}/${WEBDAV_COLD_START_USER_PATH}`))
        .toBeNull();
      expectAnchorAtPath(harness, "sub/note.md", WEBDAV_COLD_START_USER_PATH);

      expectZeroPlan(await harness.runRound("manual"));

      harness = await harness.restart();
      expectZeroPlan(await harness.runRound("manual"));
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("文件夹改名：小夹拆成目标建夹＋文件 MOVE，次轮零计划", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: ["strict"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello webdav cold start\n",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      const initial = await harness.confirmRound(
        harness.state.planReviewAuthorization!,
      );
      expect(initial).toMatchObject({ success: true, errors: 0, uploaded: 2 });
      expect(harness.remoteSnapshot(`${harness.fake.rootPath}/docs`))
        .toMatchObject({ kind: "collection" });
      expect(harness.remoteText(`${harness.fake.rootPath}/docs/a.md`))
        .toBe("alpha");

      harness.renameLocalFolder("docs", "renamed");
      const moved = await harness.runRound("manual");

      expect(moved).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 1,
        foldersMoved: 0,
        filesMoved: 1,
        deferred: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
      });
      expect(harness.remoteText(`${harness.fake.rootPath}/docs/a.md`))
        .toBeNull();
      expect(harness.remoteText(`${harness.fake.rootPath}/renamed/a.md`))
        .toBe("alpha");
      expect(harness.files.get("renamed/a.md")).toBe("alpha");

      // 次轮零计划：不留无法结算的 mutation intent。
      expectZeroPlan(await harness.runRound("manual"));
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
