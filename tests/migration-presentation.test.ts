import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

const migrationKeys = [
  "syncPlan.migrationSummary",
  "syncPlan.confirmMigration",
  "syncPlan.migrationConfirmTitle",
  "syncPlan.migrationConfirmMessage",
  "syncPlan.migrationConfirm",
] as const;

describe("migration presentation", () => {
  it("explains an existing-cloud join without presenting it as an upgrade", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.cloudJoinSummary")).toBe(
      "这台设备正在加入已有同步状态。确认计划后，EasySync 会先建立本机同步状态，再按计划同步文件。",
    );
    expect(en.t("syncPlan.cloudJoinSummary")).toBe(
      "This device is joining existing sync state. After you confirm the plan, EasySync will establish local sync state and then sync the listed files.",
    );
    expect(zh.t("syncPlan.cloudJoinSummary")).not.toMatch(/\bV2\b|V1/i);
    expect(en.t("syncPlan.cloudJoinSummary")).not.toMatch(/\bV2\b|V1/i);
  });

  it("asks for a per-device upgrade decision without claiming all devices are known", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(migrationKeys.map((key) => zh.t(key))).toEqual([
      "这台设备需要完成一次同步升级。确认后，将按下方计划继续同步。",
      "继续升级并同步",
      "继续升级并同步？",
      "EasySync 会先完成这台设备的同步升级，再按侧栏计划同步文件。仍在使用旧版 EasySync 的设备若之后再次同步，可能出现冲突或待处理项，建议尽快更新这些设备。取消不会修改本地或云端文件。",
      "继续",
    ]);
    expect(migrationKeys.map((key) => en.t(key))).toEqual([
      "This device needs a one-time sync upgrade. After you confirm, it will continue with the plan below.",
      "Continue upgrade & sync",
      "Continue upgrade & sync?",
      "EasySync will complete the sync upgrade on this device, then sync the files in the sidebar plan. If a device still using an older version of EasySync syncs again later, conflicts or other pending items may appear; update those devices as soon as possible. Cancelling will not change local or cloud files.",
      "Continue",
    ]);
  });

  it("keeps internal state-generation names out of ordinary blocking results", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const keys = [
      "result.legacyStateDisabled",
      "result.v2RecoveryBlocked",
      "result.v2StateLoadBlocked",
      "result.v2ProtocolBlocked",
    ] as const;

    for (const text of keys.map((key) => zh.t(key))) {
      expect(text).not.toMatch(/\bV2\b|ledger|manifest|scope|generation/i);
    }
    for (const text of keys.map((key) => en.t(key))) {
      expect(text).not.toMatch(/\bV2\b|ledger|manifest|scope|generation/i);
    }
  });
});
