/**
 * 维护页「实验性」里的 WebDAV 入口（C3）合同测试。
 *
 * 2026-11-24 用户拍板：WebDAV 达到主流可用前，登录条目暂放「维护 → 实验性」，
 * 不占登录页主入口；达到 B 阶段验收后再迁回。
 *
 * 钉四件事：
 * 1) WebDAV 行出现在维护页实验性组，且不再出现在登录页；
 * 2) 行名带「试验性」标注（2026-11-22 拍板：标注属行名，不属说明句）；
 *    未配置时说明只写「未登录」，不带上次测试时间；
 * 3) 已连接时说明只显示 host；
 * 4) 同步模式行仍按 OneDrive 已登录或 WebDAV 已连接决定可见。
 */
import { describe, expect, it, vi } from "vitest";
import { buildLoginPage, buildMaintenancePage } from "../src/ui/settings-tab";
import { computeWebDavConfigFingerprint } from "../src/cloud/cloud-settings";
import { I18n } from "../src/i18n";
import type EasySyncPlugin from "../src/main";

function pluginWith(overrides: Record<string, unknown> = {}): EasySyncPlugin {
  return {
    app: {} as never,
    auth: {
      authState: { isLoggedIn: false, displayName: undefined, accountName: "" },
      isInitializing: false,
      isPending: false,
      deviceAttempt: null,
    },
    cloudSettings: { provider: "onedrive", webdav: null },
    hasSavedWebDavPassword: false,
    getIgnoredLocalOnlyCount: () => 0,
    lanAccelerationEnabled: false,
    logoutUser: vi.fn().mockResolvedValue(undefined),
    openWebDavConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EasySyncPlugin;
}

function webdavConnection(overrides: {
  testOk?: boolean;
  failureKind?: string;
} = {}) {
  const coordinates = {
    url: "https://nas.example.com/webdav",
    username: "alice",
    rootPrefix: "EasySync",
  };
  const credentialRevision = 1;
  return {
    coordinates,
    credentialRevision,
    lastTest: {
      testedAt: 1000,
      ok: overrides.testOk ?? true,
      configFingerprint: computeWebDavConfigFingerprint(
        coordinates,
        credentialRevision,
      ),
      ...(overrides.failureKind ? { failureKind: overrides.failureKind } : {}),
    },
  };
}

interface MaintenanceItem {
  name?: string;
  desc?: string;
  visible?: () => boolean;
  heading?: string;
  items?: MaintenanceItem[];
}

function flattenMaintenance(
  items: readonly MaintenanceItem[],
): MaintenanceItem[] {
  return items.flatMap((item) =>
    item.items ? [item, ...flattenMaintenance(item.items)] : [item],
  );
}

function maintenanceItems(plugin: EasySyncPlugin): MaintenanceItem[] {
  const i18n = new I18n("zh-cn");
  const t = i18n.t.bind(i18n);
  const page = buildMaintenancePage(t, plugin, {
    plugin,
    t,
    refresh: vi.fn(),
    noteExclusionChange: vi.fn(),
  }) as unknown as { items: MaintenanceItem[] };
  return flattenMaintenance(page.items);
}

function loginItems(plugin: EasySyncPlugin): Array<{
  name?: string;
  desc?: string;
  visible?: () => boolean;
}> {
  const i18n = new I18n("zh-cn");
  const page = buildLoginPage(i18n.t.bind(i18n), plugin) as unknown as {
    items: Array<{ name?: string; desc?: string; visible?: () => boolean }>;
  };
  return page.items;
}

describe("maintenance experimental WebDAV entry", () => {
  it("places the WebDAV row in the experimental group and removes it from login", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const items = maintenanceItems(pluginWith());
    const experimental = items.find(
      (item) => item.heading === t("settings.experimental.heading"),
    );
    const webdavRow = items.find(
      (item) => item.name === t("settings.webdav.connection.name"),
    );
    const lanRow = items.find(
      (item) => item.name === t("settings.lanAcceleration.name"),
    );

    expect(experimental).toBeDefined();
    expect(webdavRow).toBeDefined();
    expect(lanRow).toBeDefined();
    const experimentalIndex = items.indexOf(experimental!);
    const webdavIndex = items.indexOf(webdavRow!);
    const lanIndex = items.indexOf(lanRow!);
    expect(webdavIndex).toBeGreaterThan(experimentalIndex);
    expect(webdavIndex).toBeLessThan(lanIndex);

    // 行名带「试验性」标注（逐字钉住）；说明只写「未登录」，不带上次测试时间，
    // 也不带标注（2026-11-22 用户拍板：标注属行名，不属说明句）。
    expect(webdavRow!.name).toContain("试验性");
    expect(webdavRow!.desc).toBe(t("settings.webdav.connection.desc.unconfigured"));
    expect(webdavRow!.desc).not.toContain("试验性");

    // 登录页不再出现 WebDAV 行（2026-11-24 暂时收进维护页）。
    const loginNames = loginItems(pluginWith()).map((item) => item.name);
    expect(loginNames).not.toContain(t("settings.webdav.connection.name"));
  });

  it("shows host only and no test time in the connected description", () => {
    const t = new I18n("zh-cn").t.bind(new I18n("zh-cn"));
    const items = maintenanceItems(pluginWith({
      cloudSettings: { provider: "webdav", webdav: webdavConnection() },
      hasSavedWebDavPassword: true,
    }));
    const row = items.find((item) => item.name === t("settings.webdav.connection.name"));
    expect(row?.desc).toContain("nas.example.com");
    // 「上次测试 09:10」这类时间不进连接行（用户 2026-11-20 批注）。
    expect(row?.desc).not.toContain("上次测试");
  });

  it("hides the sync-mode row until OneDrive or WebDAV is usable", () => {
    const t = new I18n("zh-cn").t.bind(new I18n("zh-cn"));
    const modeRow = loginItems(pluginWith()).find(
      (item) => item.name === t("settings.syncMode.name"),
    );
    expect(modeRow?.visible?.()).toBe(false);

    const connected = pluginWith({
      cloudSettings: { provider: "webdav", webdav: webdavConnection() },
      hasSavedWebDavPassword: true,
    });
    expect(
      loginItems(connected).find(
        (item) => item.name === t("settings.syncMode.name"),
      )?.visible?.(),
    ).toBe(true);

    const onedrive = pluginWith({
      auth: {
        authState: { isLoggedIn: true, displayName: "张三", accountName: "" },
        isInitializing: false,
        isPending: false,
        deviceAttempt: null,
      },
    });
    expect(
      loginItems(onedrive).find(
        (item) => item.name === t("settings.syncMode.name"),
      )?.visible?.(),
    ).toBe(true);
  });
});
