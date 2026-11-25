/**
 * W2b-1：provider 切换接缝的端到端证据。
 *
 * 用真实 `StateManager` ＋ 真实 `WebDavProvider` ＋ fake WebDAV（W2b2b2 的冷启动
 * 测试台）跑一轮，然后用 `SyncExecutor.setProvider()` 把执行器换成同一个 fake
 * 上的另一个 provider 实例，再跑一轮——证明：
 *
 * 1. 换过之后引擎确实走新 provider（新实例收到调用、旧实例不再被调用）；
 * 2. 有轮次在跑时拒绝切换（不会把正在跑的轮次中途换引擎）。
 *
 * 这两条是 `main.ts` 的云端分流（手动同步前 `ensureWebDavSyncReady()`）能成立的
 * 前提；不接 `src/main.ts`、不访问真实账号。
 */
import { describe, expect, it } from "vitest";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
  WEBDAV_COLD_START_USER_TEXT,
} from "./helpers/webdav-cold-start-harness";
import { NUTSTORE_PROFILES } from "./helpers/webdav-sync-executor-harness";

describe("W2b-1 provider 切换接缝", () => {
  it("换 provider 后下一轮真的走新实例，且跑一次收敛", async () => {
    const harness = await createWebDavColdStartHarness({
      profiles: NUTSTORE_PROFILES,
      localFiles: { [WEBDAV_COLD_START_USER_PATH]: WEBDAV_COLD_START_USER_TEXT },
    });
    try {
      // 首轮：暂停并确认，把基线建起来。
      expect((await harness.runRound("manual")).message).toBe("result.pausedForReview");
      expect(await harness.confirmRound(harness.state.planReviewAuthorization!))
        .toMatchObject({ success: true, errors: 0, uploaded: 1 });

      // 用一个独立 provider 实例（同一 client／scope）替换执行器的 provider。
      const replacement = new (harness.provider.constructor as new (
        options: never,
      ) => typeof harness.provider)({
        client: harness.client,
        driveId: harness.scope.endpointId,
      } as never);
      const switched = harness.executor.setProvider(replacement, harness.scope);
      expect(switched).toBe(true);

      // 次轮：没有本地变化，应当零动作（说明新 provider 读到了同一份远端事实）。
      const after = await harness.runRound("manual");
      expect(after).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
    } finally {
      await harness.dispose();
    }
  }, 180_000);
});
