import { describe, expect, it } from "vitest";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

/**
 * W3b2 安全闸：路径身份 provider 下的本地文件夹改名。
 *
 * B3a 起 ≤16 文件/16 MiB 的纯本机改名会拆成文件级移动；超过上限的文件夹
 * 仍必须 fail-closed。本用例钉住这条底线：
 * - 零远端删除（不能把云端内容当本地已删）；
 * - 旧路径子树字节不变、目标路径不存在；
 * - 不吃掉本机文件；
 * - 必须产生可见的延后计数，不能静默成功；
 * - 下一轮仍干净 defer，不留不可结算的 mutation。
 *
 * 画像必须包含 `no-collection-etag`：真实坚果云集合 PROPFIND 没有 ETag，
 * 只给集合发 ETag 的 fake 会让执行器走不到路径身份安全闸。
 */
describe("W3b2 安全闸：路径身份文件夹改名（超出拆解上限）", () => {
  it("17 个文件：整夹可见 defer、零远端变化、下一轮仍 defer", async () => {
    const localFiles: Record<string, string> = {
      [WEBDAV_COLD_START_USER_PATH]: "hello webdav cold start\n",
    };
    for (let index = 0; index < 17; index++) {
      localFiles[`docs/f${index}.md`] = `content-${index}`;
    }
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles,
      localFolders: ["docs"],
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      expect(await harness.confirmRound(harness.state.planReviewAuthorization!))
        .toMatchObject({ success: true, errors: 0, uploaded: 18 });
      expect(harness.remoteText(`${harness.fake.rootPath}/docs/f0.md`))
        .toBe("content-0");

      harness.renameLocalFolder("docs", "renamed");
      const first = await harness.runRound("manual");
      expect(first).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        filesMoved: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
      });
      expect(first.deferred).toBeGreaterThan(0);
      expect(harness.remoteText(`${harness.fake.rootPath}/docs/f16.md`))
        .toBe("content-16");
      expect(harness.remoteSnapshot(`${harness.fake.rootPath}/renamed`))
        .toBeNull();
      expect(harness.files.get("renamed/f16.md")).toBe("content-16");
      expect(harness.state.pendingPathIdentityFolderMoves).toEqual([]);

      const second = await harness.runRound("manual");
      expect(second).toMatchObject({
        success: true,
        errors: 0,
        foldersCreated: 0,
        filesMoved: 0,
      });
      expect(second.deferred).toBeGreaterThan(0);
      expect(harness.remoteText(`${harness.fake.rootPath}/docs/f0.md`))
        .toBe("content-0");
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
