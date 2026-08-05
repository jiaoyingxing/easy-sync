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
      "这台设备将改用新版同步方式，并按下方计划同步文件。",
      "继续升级并同步",
      "改用新版同步方式？",
      "确认后会按计划同步文件。其他设备若仍使用旧版 EasySync，之后同步可能出现冲突，请先更新。",
      "继续",
    ]);
    expect(migrationKeys.map((key) => en.t(key))).toEqual([
      "This device will switch to the new sync method and sync files according to the plan below.",
      "Continue upgrade & sync",
      "Switch to the new sync method?",
      "After confirmation, EasySync will sync files according to the plan. If other devices still use an older version of EasySync, syncing from them later may cause conflicts; update them first.",
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
