import { describe, expect, it } from "vitest";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

describe("StateManager 路径身份 folder anchor 重绑", () => {
  it("源子树下仍有 file anchor 时失败关闭，不推进提交序号", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: [...NUTSTORE_PROFILES, "no-collection-etag"],
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: "hello",
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
    });
    try {
      await harness.runRound("manual");
      await harness.confirmRound(harness.state.planReviewAuthorization!);
      const before = harness.state.getCommittedV2Envelope()!.meta.commitSeq;
      harness.renameLocalFolder("docs", "renamed");

      await expect(harness.state.rebindPathIdentityFolderAnchorsAfterMove({
        sourcePath: "docs",
        targetPath: "renamed",
        completedAt: 100,
      })).rejects.toThrow(/file anchor/);

      expect(harness.state.getCommittedV2Envelope()!.meta.commitSeq).toBe(before);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
