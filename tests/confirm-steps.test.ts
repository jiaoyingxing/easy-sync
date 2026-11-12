import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

/**
 * 2026-10-31 confirmation-copy round: multi-action / multi-rule bodies use a
 * native ordered list, single actions stay one sentence. (Zero-file actions are
 * not covered here.) No DOM harness exists in this repo, so the render slot is
 * pinned by source shape and the copy by locale values.
 */
describe("confirm modal numbered steps (2026-10-31)", () => {
  it("renders the steps slot as a native ordered list between lines and warning", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../src/ui/confirm-modal.ts"),
      "utf8",
    );
    expect(source).toContain('contentEl.createEl("ol", { cls: "easy-sync-confirm-steps" })');
    expect(source).toContain("this.options?.steps");
    // The slot order stays message -> lines -> steps -> warning.
    const linesIndex = source.indexOf("this.options?.lines");
    const stepsIndex = source.indexOf("this.options?.steps");
    const warningIndex = source.indexOf("this.options?.warning");
    expect(linesIndex).toBeGreaterThan(-1);
    expect(stepsIndex).toBeGreaterThan(linesIndex);
    expect(warningIndex).toBeGreaterThan(stepsIndex);
  });

  it("pins the batch conflict rules as three lines per direction", () => {
    const zh = new I18n("zh-cn");
    expect(zh.t("syncView.conflict.batchKeepLocalStep.cloudOnly"))
      .toBe("只在云端的文件：删除。");
    expect(zh.t("syncView.conflict.batchKeepLocalStep.localOnly"))
      .toBe("只在本机的文件：上传到云端。");
    expect(zh.t("syncView.conflict.batchKeepLocalStep.both"))
      .toBe("两侧都有的文件：用本机版本覆盖云端。");
    expect(zh.t("syncView.conflict.batchKeepRemoteStep.localOnly"))
      .toBe("只在本机的文件：删除。");
    expect(zh.t("syncView.conflict.batchKeepRemoteStep.cloudOnly"))
      .toBe("只在云端的文件：下载到本机。");
    expect(zh.t("syncView.conflict.batchKeepRemoteStep.both"))
      .toBe("两侧都有的文件：用云端版本覆盖本机。");
  });

  it("keeps the batch upload body to two outcome lines", () => {
    const zh = new I18n("zh-cn");
    expect(zh.t("syncView.localOnly.batchConfirmStep.authoritative"))
      .toBe("以云端为准：云端删除时，本机同步删除。");
    expect(zh.t("syncView.localOnly.batchConfirmStep.sameName"))
      .toBe("同名文件：跳过，留在面板待处理。");
  });

  it("pins the bulk data-sync rules as three lines", () => {
    const zh = new I18n("zh-cn");
    expect(zh.t("settings.communityPlugins.data.experimentalBulkStep.shared"))
      .toBe("各设备共用一份插件设置。");
    expect(zh.t("settings.communityPlugins.data.experimentalBulkStep.replace"))
      .toBe("任何设备修改，都会覆盖其他设备的设置。");
    expect(zh.t("settings.communityPlugins.data.experimentalBulkStep.conflict"))
      .toBe("两台设备同时修改会冲突，只能整份二选一；另一边的修改会丢失。");
  });

  it("keeps the single-action delete as one tightened sentence", () => {
    const zh = new I18n("zh-cn");
    expect(zh.t("syncView.delete.confirmAllMessage", { count: 3 }))
      .toBe("这些文件已在云端删除。继续会删除本机对应的 3 个文件。");
  });
});
