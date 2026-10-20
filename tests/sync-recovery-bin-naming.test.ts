/**
 * 「同步回收站」定稿文案钉子（2026-10-20 用户圈定）。
 *
 * 命令名与设置行名共用一词；文件菜单项「找回历史版本」获用户认可、保持不动。
 * 详情定稿为「找回对象＋30 天窗口」：恢复为副本／从云端拉回已移出设置说明（打开后界面仍可见），任何一侧漂移或中英不等价直接红。
 */
import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

describe("同步回收站 定稿文案（2026-10-20 圈定）", () => {
  const zh = new I18n("zh-cn");
  const en = new I18n("en");

  it("命令名＝同步回收站（中英成对同指）", () => {
    expect(zh.t("recovery.command")).toBe("同步回收站");
    expect(en.t("recovery.command")).toBe("Sync recycle bin");
  });

  it("文件菜单项保持「找回历史版本」（用户认可现词不动）", () => {
    expect(zh.t("recovery.menuItem")).toBe("找回历史版本");
    expect(en.t("recovery.menuItem")).toBe("Recover previous versions");
  });

  it("设置行名与命令名同一词，按钮与组标题落定", () => {
    expect(zh.t("settings.recoveryBin.name")).toBe("同步回收站");
    expect(en.t("settings.recoveryBin.name")).toBe("Sync recycle bin");
    expect(zh.t("settings.recoveryBin.button")).toBe("打开");
    expect(en.t("settings.recoveryBin.button")).toBe("Open");
    expect(zh.t("settings.maintenanceAdvanced.heading")).toBe("高级");
    expect(en.t("settings.maintenanceAdvanced.heading")).toBe("Advanced");
  });

  it("详情文本定稿逐字＋双语等价（找回对象＋30 天窗口）", () => {
    expect(zh.t("settings.recoveryBin.desc")).toBe(
      "找回被删除或冲突时舍弃的内容，保留约 30 天。",
    );
    expect(en.t("settings.recoveryBin.desc")).toBe(
      "Recover deleted or conflict-discarded items; kept for about 30 days.",
    );
  });
});
