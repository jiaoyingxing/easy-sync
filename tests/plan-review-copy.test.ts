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
