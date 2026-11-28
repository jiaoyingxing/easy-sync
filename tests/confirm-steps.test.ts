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

  // 2026-11-27 user decision: the accept button's weight follows the
  // consequence. "destroy" (files are deleted) renders the host's solid tier;
  // "rebuildable" (only local recorded state is cleared) renders the tinted
  // tier. The option is no longer a boolean, so every call site must state
  // which one it means.
  it("maps the danger tier to the matching footer variant", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../src/ui/confirm-modal.ts"),
      "utf8",
    );
    expect(source).toContain('this.options?.danger === "destroy" ? "destructive-primary"');
    expect(source).toContain('this.options?.danger === "rebuildable" ? "destructive"');
    expect(source).not.toContain("this.options?.danger ?");
  });

  it("keeps every destructive confirm call site on an explicit tier", () => {
    const filesToScan = [
      "src/main.ts",
      "src/ui/config-sync-modal.ts",
      "src/ui/mutation-recovery-resolution-modal.ts",
      "src/ui/settings-page-rows.ts",
      "src/ui/settings-tab.ts",
      "src/ui/sync-view.ts",
    ];
    const offenders: string[] = [];
    for (const rel of filesToScan) {
      const source = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
      if (/danger:\s*true/u.test(source)) offenders.push(`${rel} (boolean danger)`);
      const tiers = source.match(/danger:\s*"(destroy|rebuildable)"/gu) ?? [];
      if (tiers.length === 0) offenders.push(`${rel} (no tier declared)`);
    }
    expect(offenders).toEqual([]);
  });

  // 2026-11-27 second pass (user correction): the accept key of a
  // confirmation dialog is that dialog's only action, so it always takes the
  // solid weight — the host's own `prompt()` calls `setCta()` before the
  // accept configurator runs. "Rebuildable" is therefore NOT a reason to drop
  // to the tinted tier; the only reason to drop is another primary action
  // competing in the same footer. These four sites were mis-tiered.
  it("puts every confirmation accept key on the solid tier", () => {
    const filesToScan = [
      "src/main.ts",
      "src/ui/config-sync-modal.ts",
      "src/ui/settings-page-rows.ts",
      "src/ui/settings-tab.ts",
    ];
    const offenders: string[] = [];
    for (const rel of filesToScan) {
      const source = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
      const tiers = source.match(/danger:\s*"(destroy|rebuildable)"/gu) ?? [];
      if (tiers.some((tier) => tier.endsWith('"rebuildable"'))) {
        offenders.push(`${rel} (tinted accept key)`);
      }
    }
    expect(offenders).toEqual([]);
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
