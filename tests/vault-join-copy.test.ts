import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

/**
 * 加入云端仓库弹框与 Notice 定稿文案（2026-10-03 用户审核 R1 修订版；载体
 * `20261003-2128` §R1 修订二）。硬约束落逐字断言：
 * ①初始文案只说数量、不列名单（名单归二级弹框）；
 * ②选项名「作为新仓库同步」，全链路（含引号内指引）逐字一致；
 * ③「单独」措辞全面禁用（用户点名误导）。
 */
const VAULT_JOIN_KEYS = [
  "vaultJoin.offerTitle",
  "vaultJoin.offerBody",
  "vaultJoin.offerJoinTitle",
  "vaultJoin.offerJoinDesc",
  "vaultJoin.offerFreshTitle",
  "vaultJoin.offerFreshDesc",
  "vaultJoin.listTitle",
  "vaultJoin.listGuide",
  "vaultJoin.listEmpty",
  "vaultJoin.nameCopied",
  "vaultJoin.copyUnavailable",
  "vaultJoin.detectNotice",
] as const;

describe("vault join offer copy", () => {
  it("states the count only and keeps the join guidance one step down", () => {
    const zh = new I18n("zh-cn");

    expect(zh.t("vaultJoin.offerTitle")).toBe("检测到云端已有同步仓库");
    expect(zh.t("vaultJoin.offerBody", { count: 11 })).toBe(
      "云端已有 11 个 EasySync 同步仓库。你可以加入其中一个，或作为新仓库同步。",
    );
    expect(zh.t("vaultJoin.offerJoinTitle")).toBe("加入云端仓库");
    expect(zh.t("vaultJoin.offerJoinDesc")).toBe(
      "从云端已有的仓库里选一个加入，可复制仓库名称。",
    );
    expect(zh.t("vaultJoin.listTitle")).toBe("选择要加入的仓库");
    expect(zh.t("vaultJoin.listGuide")).toBe(
      "把本仓库重命名为下面任一个名称（与云端完全一致，包括大小写），再重新同步即可加入；云端已有的文件不会重复上传。点击名称可复制。",
    );
    expect(zh.t("vaultJoin.listEmpty")).toBe(
      "未找到可加入的仓库。关闭后可选择「作为新仓库同步」。",
    );
    expect(zh.t("vaultJoin.nameCopied")).toBe("已复制仓库名称");
    expect(zh.t("vaultJoin.copyUnavailable")).toBe(
      "无法复制，请手动记录名称。",
    );
    expect(zh.t("vaultJoin.detectNotice", { count: 11 })).toBe(
      "检测到云端已有 11 个 EasySync 同步仓库。首次同步时可选择加入，或作为新仓库同步。",
    );
  });

  it("names the fresh option \u201c作为新仓库同步\u201d everywhere, including quoted guidance", () => {
    const zh = new I18n("zh-cn");
    const freshTitle = zh.t("vaultJoin.offerFreshTitle");

    expect(freshTitle).toBe("作为新仓库同步");
    expect(zh.t("vaultJoin.offerFreshDesc")).toBe(
      "忽略云端已有仓库，本仓库将作为新仓库同步。",
    );
    expect(zh.t("vaultJoin.listEmpty")).toContain(`「${freshTitle}」`);
    expect(zh.t("vaultJoin.offerBody", { count: 1 })).toContain(freshTitle);
  });

  it("drops the \u201c单独\u201d wording and the promise that implies peer pressure", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    for (const key of VAULT_JOIN_KEYS) {
      expect(zh.t(key, { count: 2 })).not.toContain("单独");
    }
    expect(en.t("vaultJoin.offerFreshTitle")).toBe("Sync as a new repository");
    expect(en.t("vaultJoin.offerFreshDesc")).toBe(
      "Ignores the existing cloud repositories; this vault syncs as a new repository.",
    );
    expect(en.t("vaultJoin.offerFreshDesc")).not.toContain("independent");
  });

  it("keeps the English side on the same concept, action and promise", () => {
    const en = new I18n("en");

    expect(en.t("vaultJoin.offerTitle")).toBe(
      "Existing EasySync repository detected",
    );
    expect(en.t("vaultJoin.offerBody", { count: 11 })).toBe(
      "The cloud already has 11 EasySync repositories. You can join one, or sync this vault as a new repository.",
    );
    expect(en.t("vaultJoin.offerJoinDesc")).toContain("copy its name");
    expect(en.t("vaultJoin.listGuide")).toContain("including letter case");
    expect(en.t("vaultJoin.listGuide")).toContain("Click a name to copy it");
    expect(en.t("vaultJoin.listEmpty")).toContain("Sync as a new repository");
    expect(en.t("vaultJoin.detectNotice", { count: 11 })).toBe(
      "Existing EasySync repositories detected in the cloud: 11. Your first sync can join one, or sync this vault as a new repository.",
    );
  });

  it("substitutes the count placeholder in both locales", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("vaultJoin.offerBody", { count: 3 })).toContain("3 个");
    expect(en.t("vaultJoin.offerBody", { count: 3 })).toContain("3 EasySync");
    expect(zh.t("vaultJoin.offerBody", { count: 3 })).not.toContain("{count}");
    expect(en.t("vaultJoin.offerBody", { count: 3 })).not.toContain("{count}");
  });
});
