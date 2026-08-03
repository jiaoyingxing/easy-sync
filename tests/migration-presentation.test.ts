import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";

const migrationKeys = [
  "syncPlan.migrationSummary",
  "syncPlan.confirmMigration",
  "syncPlan.migrationConfirmTitle",
  "syncPlan.migrationConfirmMessage",
  "syncPlan.migrationConfirmWarning",
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
      "正在升级这台设备的同步状态。建议先更新其他设备上的 EasySync，再继续操作。",
      "继续升级并同步",
      "升级这台设备的同步状态",
      "这台设备将改用新的同步状态。建议先更新其他使用此仓库的设备；长期离线的旧版本设备无法被自动发现。",
      "如果旧版本设备之后写入变化，EasySync 会将其作为普通外部变化重新核对。请尽快更新所有设备。",
      "继续升级并同步",
    ]);
    expect(migrationKeys.map((key) => en.t(key))).toEqual([
      "EasySync is upgrading this device's sync state. Update EasySync on other devices first when possible, then continue.",
      "Continue upgrade & sync",
      "Upgrade this device's sync state",
      "This device will switch to the new sync state. Update EasySync on other devices using this vault first when possible; old versions on long-offline devices cannot be discovered automatically.",
      "If an old-version device writes changes later, EasySync will recheck them as ordinary external changes. Update all devices as soon as practical.",
      "Continue upgrade & sync",
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
