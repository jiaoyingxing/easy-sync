/**
 * 单向同步「本机独有内容」三件优化的用户可见文案。
 *
 * 逐字钉住三件：件① 计划审阅里的事前告知句（三种组合）· 件② 侧栏批量处置行与
 * 它的确认弹框 · 件③ 设置页提醒行与一行反馈。批量按钮另有长度上限——用户
 * 反馈过按钮字多会在窄宽度折行。全部文字按 2026-10-12 末轮文案定稿（「尚未
 * 上传到云端」是面板与审阅句的统一说法，逐条行只讲这一行独有的信息；上一轮的
 * 「仅存于本机」随本轮退场，用户可见面零出现）。
 */
import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

describe("one-way local-only three-piece copy (三件优化)", () => {
  const zh = new I18n("zh-cn");
  const en = new I18n("en");

  it("pins the plan review note in all three combinations (件①)", () => {
    // 只有"尚未上传到云端"类：计数取自面板同源的行集。
    expect(zh.t("syncPlan.oneWayNote.localOnly", { localOnly: 3 })).toBe(
      "有 3 个文件尚未上传到云端。",
    );
    expect(en.t("syncPlan.oneWayNote.localOnly", { localOnly: 3 })).toBe(
      "3 file(s) have not been uploaded to the cloud yet.",
    );
    // 只有"与云端内容不同"类：计数取自随计划封存的审阅计数。
    expect(zh.t("syncPlan.oneWayNote.copies", { copies: 2 })).toBe(
      "有 2 个文件与云端内容不同。",
    );
    expect(en.t("syncPlan.oneWayNote.copies", { copies: 2 })).toBe(
      "2 file(s) differ from the cloud version.",
    );
    // 两类都命中：并集句，两类各报一个数（2026-10-12 末轮定稿：统一用"尚未上传
    // 到云端"一个说法，只报数量，不复述后果）。
    expect(zh.t("syncPlan.oneWayNote.both", { localOnly: 120, copies: 8 })).toBe(
      "有 120 个文件尚未上传到云端，另有 8 个文件与云端内容不同。",
    );
    expect(en.t("syncPlan.oneWayNote.both", { localOnly: 120, copies: 8 })).toBe(
      "120 file(s) have not been uploaded to the cloud yet, and 8 more differ from the cloud version.",
    );
    // 术语口径（i18n规范 §4）：插件界面写「本机／云端」，全案统一「尚未上传到
    // 云端」一个说法；不出现「冲突」（专有状态），也不再用已作废的「只在本机／
    // 独有／仅存于本机」。
    for (const sentence of [
      zh.t("syncPlan.oneWayNote.both", { localOnly: 1, copies: 1 }),
      zh.t("syncPlan.oneWayNote.localOnly", { localOnly: 1 }),
      zh.t("syncPlan.oneWayNote.copies", { copies: 1 }),
    ]) {
      expect(sentence).not.toContain("冲突");
      expect(sentence).not.toContain("独有");
      expect(sentence).not.toContain("只在本机");
      expect(sentence).not.toContain("仅存于本机");
    }
    expect(zh.t("syncPlan.oneWayNote.both", { localOnly: 1, copies: 1 }))
      .toContain("尚未上传到云端");
  });

  it("pins the batch row and its confirmation dialog (件②)", () => {
    expect(zh.t("syncView.localOnly.batchNote", { count: 12 })).toBe(
      "以下 12 个文件的修改或内容尚未上传到云端，请选择处理方式。",
    );
    expect(en.t("syncView.localOnly.batchNote", { count: 12 })).toBe(
      "The 12 file(s) below have edits or content not yet uploaded to the cloud. Choose how to handle them.",
    );
    expect(zh.t("syncView.localOnly.batchUploadAll")).toBe("全部上传");
    expect(en.t("syncView.localOnly.batchUploadAll")).toBe("Upload all");
    expect(zh.t("syncView.localOnly.batchKeepAll")).toBe("全部留在本机");
    expect(en.t("syncView.localOnly.batchKeepAll")).toBe("Keep all");
    // 按钮只在动作本身上加"全部"：4／6 字上限防窄屏折行（用户 2026-10-12 反馈）。
    expect(zh.t("syncView.localOnly.batchUploadAll").length).toBeLessThanOrEqual(4);
    expect(zh.t("syncView.localOnly.batchKeepAll").length).toBeLessThanOrEqual(6);
    // 确认弹框：标题指出决定；正文只说用户预料不到的两件事——上传后这批文件
    // 以云端为准（云端删除会带掉本机），以及云端同名的会自动跳过留在面板
    // （2026-10-12 末轮定稿，用户重写）。
    expect(zh.t("syncView.localOnly.batchConfirmTitle", { count: 12 })).toBe(
      "上传全部 12 个文件？",
    );
    expect(en.t("syncView.localOnly.batchConfirmTitle", { count: 12 })).toBe(
      "Upload all 12 file(s)?",
    );
    expect(zh.t("syncView.localOnly.batchConfirmMessage")).toBe(
      "上传后，这些文件以云端为准：云端删除，本机同步删除。同名文件会自动跳过，留在面板待处理。",
    );
    expect(en.t("syncView.localOnly.batchConfirmMessage")).toBe(
      "After the upload, the cloud takes precedence for these files: if the cloud deletes them, they are deleted here as well. Files whose names already exist in the cloud are skipped automatically and stay in the panel for you to handle.",
    );
    expect(zh.t("syncView.localOnly.batchConfirmUpload")).toBe("上传");
    expect(en.t("syncView.localOnly.batchConfirmUpload")).toBe("Upload");
    // 取消键沿用现役确认弹框用词，不新造。
    expect(zh.t("confirm.cancel")).toBe("取消");
    expect(en.t("confirm.cancel")).toBe("Cancel");
    // 逐条行（2026-10-12 末轮口径）：处境由列表级（批量行／审阅句）说一次；
    // 行内说明句只有改动类有（"这份副本里是什么"），新建类不写说明句。
    expect(zh.t("syncView.localOnly.batchNote", { count: 1 }))
      .toContain("尚未上传到云端");
    expect(zh.t("syncView.localOnly.reason.edited")).toBe(
      "本机修改已存入此副本。",
    );
    expect(en.t("syncView.localOnly.reason.edited")).toBe(
      "Edits made on this device are saved in this copy.",
    );
    expect(zh.t("syncView.localOnly.upload")).toBe("上传到云端");
    expect(zh.t("syncView.localOnly.keep")).toBe("留在本机，不再提醒");
  });

  it("pins the settings reminder row and its one-line feedback (件③)", () => {
    // 2026-10-12 末轮定稿：行名"不再提醒的文件"＋说明两句（用户原句：选择这一
    // 动作 ＋ 重置后的去向）＋按钮"重置"＋反馈带数量。
    expect(zh.t("settings.localOnlyIgnored.name")).toBe("不再提醒的文件");
    expect(en.t("settings.localOnlyIgnored.name")).toBe("Files with reminders off");
    expect(zh.t("settings.localOnlyIgnored.desc", { count: 2 })).toBe(
      "单向同步期间，你有 2 个文件选择了“留在本机，不再提醒”。重置后，它会重新出现在同步面板，可再次选择上传到云端或留在本机。",
    );
    expect(en.t("settings.localOnlyIgnored.desc", { count: 2 })).toBe(
      "While One-way sync is on, you chose not to be reminded about 2 file(s). After you reset, they will appear in the sync panel again, where you can choose to upload them to the cloud or keep them on this device.",
    );
    expect(zh.t("settings.localOnlyIgnored.button")).toBe("重置");
    expect(en.t("settings.localOnlyIgnored.button")).toBe("Reset");
    expect(zh.t("notice.localOnly.reminded", { count: 4 })).toBe(
      "已重置，4 个文件可在同步面板重新选择。",
    );
    expect(en.t("notice.localOnly.reminded", { count: 4 })).toBe(
      "Reminders reset. 4 file(s) can be decided again in the sync panel.",
    );
    // 状态词「不再提醒」仍与逐条动作名同源（说明句引用的是动作名原文）。
    expect(zh.t("settings.localOnlyIgnored.desc", { count: 2 }))
      .toContain("留在本机，不再提醒");
    expect(zh.t("syncView.localOnly.keep")).toContain("不再提醒");
  });
});
