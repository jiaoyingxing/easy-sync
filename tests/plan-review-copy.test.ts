import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

/** Finalized copy (issue #18 round, 2026-09-15): the first-sync and
 *  regenerated-plan review messages tell the user to keep the vault quiet
 *  until the plan is confirmed, because any change regenerates the plan. */
describe("plan review quiet-period guidance", () => {
  it("first-publish message asks the user to avoid file changes before confirming", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.readyMessage")).toBe(
      "同步计划已生成，请在侧边栏查看详情并确认执行。确认前请尽量避免改动文件；期间如有改动，计划会重新生成，需要重新确认。",
    );
    expect(en.t("syncPlan.readyMessage")).toBe(
      "Your sync plan is ready. Review the details in the sidebar before proceeding. Please avoid changing files until you confirm; any change regenerates the plan and requires a new review.",
    );
  });

  it("regenerated-plan message explains why the plan keeps coming back", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.reviewUpdatedMessage")).toBe(
      "同步范围或文件发生变化，计划已重新生成。请在侧边栏查看最新内容。确认完成前请尽量避免继续改动文件，否则计划会再次变化。",
    );
    expect(en.t("syncPlan.reviewUpdatedMessage")).toBe(
      "Your sync scope or files have changed, so the plan was regenerated. Review the updated details in the sidebar. Please avoid further file changes until you confirm, or the plan will change again.",
    );
  });
});

/** Finalized copy (2026-09-29, DECISIONS; reopens the 2026-09-17 sentence via
 *  its own registered reopener "special plans with conflicts cause the same
 *  confusion"): the summary slot now separates a flow line (what confirming
 *  does) from a decision note (when the plan's decision rows become
 *  actionable). Activation reviews defer conflicts and pending cloud-deletion
 *  confirmations to after the run; ordinary plans can decide them inline —
 *  each sentence must match the timing its rows really have. */
describe("plan confirm boundary sentence and cloud join summary", () => {
  it("boundary sentence is pinned verbatim in both locales", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.confirmBoundarySummary")).toBe(
      "本次只执行上传、下载等常规操作；冲突和云端已删除的文件现在就能逐条决定，也可以等本轮结束后再处理。",
    );
    expect(en.t("syncPlan.confirmBoundarySummary")).toBe(
      "This sync only performs routine operations such as uploads and downloads; you can decide conflicts and files already deleted from the cloud one by one right now, or wait until this sync finishes.",
    );
  });

  it("activation flow lines and the deferred decision note are pinned verbatim", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.migrationSummary")).toBe(
      "这台设备将升级到新版同步方式。确认后按下方计划同步。",
    );
    expect(en.t("syncPlan.migrationSummary")).toBe(
      "This device will switch to the new sync method. After you confirm, EasySync will sync according to the plan below.",
    );
    expect(zh.t("syncPlan.cloudJoinSummary")).toBe(
      "本设备正在加入已有同步。确认后先登记本机，再按下方计划同步。",
    );
    expect(en.t("syncPlan.cloudJoinSummary")).toBe(
      "This device is joining an existing sync. After you confirm, EasySync will first set up the local record, then sync according to the plan below.",
    );
    expect(zh.t("syncPlan.cloudJoinSummary")).not.toContain("同步状态");
    expect(zh.t("syncPlan.firstSyncSummary")).toBe(
      "这是这台设备的首次同步。确认后按下方计划建立同步。",
    );
    expect(en.t("syncPlan.firstSyncSummary")).toBe(
      "This is the first sync for this device. After you confirm, EasySync will set up sync according to the plan below.",
    );
    expect(zh.t("syncPlan.remoteScopeRecreateSummary")).toBe(
      "原云端同步目录无法继续使用。确认后重新创建目录并核对内容。",
    );
    expect(en.t("syncPlan.remoteScopeRecreateSummary")).toBe(
      "The previous remote sync folder can no longer be used. After you confirm, EasySync will recreate the folder and check the content.",
    );
    expect(zh.t("syncPlan.activationDecisionSummary")).toBe(
      "冲突和云端已删除的文件不会自动处理，同步完成后由你逐条决定。",
    );
    expect(en.t("syncPlan.activationDecisionSummary")).toBe(
      "Conflicts and files already deleted from the cloud are not handled automatically; you decide them one by one after the sync finishes.",
    );
  });

  it("activation and ordinary decision notes state different timings", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    // Activation reviews render decision rows read-only, so their note may not
    // claim inline decidability; the ordinary note must keep claiming it.
    expect(zh.t("syncPlan.activationDecisionSummary")).not.toContain(
      "现在就能",
    );
    expect(zh.t("syncPlan.confirmBoundarySummary")).toContain("现在就能");
    expect(zh.t("syncPlan.confirmBoundarySummary")).not.toContain("不碰");
    expect(en.t("syncPlan.confirmBoundarySummary")).not.toContain(
      "left untouched",
    );
  });
});
