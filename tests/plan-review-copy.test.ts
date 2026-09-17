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

/** Finalized copy (2026-09-17, DECISIONS): the plan review section states the
 *  confirm button's boundary in one sentence when the ordinary plan contains
 *  decision rows (conflicts / deletions awaiting approval), and the cloud-join
 *  summary drops the internal "sync state" wording for plain user language. */
describe("plan confirm boundary sentence and cloud join summary", () => {
  it("boundary sentence is pinned verbatim in both locales", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.confirmBoundarySummary")).toBe(
      "本次只执行上传、下载等常规操作；冲突和云端已删除的文件不碰，完成后由你决定。",
    );
    expect(en.t("syncPlan.confirmBoundarySummary")).toBe(
      "This sync only performs routine operations such as uploads and downloads; conflicts and files already deleted from the cloud are left untouched, and you decide them once it completes.",
    );
  });

  it("cloud join summary speaks of joining an existing sync, not sync state", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.cloudJoinSummary")).toBe(
      "本设备正在加入已有同步。确认计划后，EasySync 会先完成本机登记，再按计划同步文件。",
    );
    expect(en.t("syncPlan.cloudJoinSummary")).toBe(
      "This device is joining an existing sync. After you confirm the plan, EasySync will first set up the local record, then sync files according to the plan.",
    );
    expect(zh.t("syncPlan.cloudJoinSummary")).not.toContain("同步状态");
  });
});
