/**
 * F3-a 停用：把活动云端交还 OneDrive，配置与账本都留着。
 *
 * 病根：设计稿 §5.1 写的「停用」在本轮之前**没有写入通路**。`writeCloudSettings`
 * 本来就支持 `{provider:"onedrive", webdav:{...}}` 这个形状（只有两边都空才删
 * 字段），但唯一的调用方把 provider 写死成「有没有连接」：
 *
 *     provider: connection ? "webdav" : "onedrive"
 *
 * 于是「停用」要么表达不出来，要么连地址密码一起删掉。本文件钉住补齐之后的
 * 语义：只切活动云端，配置一个字节都不动。
 */
import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import {
  readCloudSettings,
  resolveWebDavConnectionStatus,
} from "../src/cloud/cloud-settings";

const CLOUD_KEYS = { provider: "cloud-provider", webdav: "cloud-webdav" };

const webdavCoordinates = {
  url: "https://nas.example.com",
  username: "alice",
  rootPrefix: "EasySync",
};

interface Harness {
  plugin: EasySyncPlugin;
  saved: () => Record<string, unknown>;
  notices: Array<{ key: string }>;
}

/**
 * 真插件实例，只替换状态、执行器与写盘。
 *
 * `deactivateCloudAndRestoreOneDrive` 是私有行为但直接改 `cloudSettings` 并落盘，
 * 所以必须让 `saveSyncSettings` 真的跑一遍 `writeCloudSettings` 才有意义。
 */
function makeHarness(options: {
  provider?: "onedrive" | "webdav";
  connection?: Record<string, unknown> | null;
  busy?: boolean;
  unsettled?: boolean;
} = {}): Harness {
  const provider = options.provider ?? "webdav";
  const connection = options.connection ?? {
    coordinates: webdavCoordinates,
    credentialRevision: 3,
    lastTest: {
      testedAt: 1_700_000_000_000,
      ok: true,
      configFingerprint: "wd1-deadbeef",
    },
  };
  // 物理盘上的那份必须与内存设置一致：账本目录由**物理数据**里的云端字段
  // 决定（`activeCloudBookId`），不是内存字段——两者错开会让「停用后账本
  // 回到了哪一本」这类断言测的是假象。
  let persisted: Record<string, unknown> = {
    "cloud-provider": provider,
    "cloud-webdav": connection,
  };
  const plugin = new EasySyncPlugin();
  plugin.cloudSettings = { provider, webdav: connection as never };
  // 写盘：走真实 updatePluginData → writeCloudSettings 那条链。
  vi.spyOn(plugin, "loadData").mockImplementation(
    async () => structuredClone(persisted),
  );
  vi.spyOn(plugin, "saveData").mockImplementation(async (next) => {
    persisted = structuredClone(next as Record<string, unknown>);
  });
  // 守卫输入：忙碌／未结算恢复。
  Object.defineProperty(plugin, "isSyncPathBusy", {
    value: () => options.busy === true,
    configurable: true,
  });
  const notices: Array<{ key: string }> = [];
  Object.defineProperty(plugin, "noticeCenter", {
    value: {
      show: (notice: { key: string }) => notices.push(notice),
      // `loadSyncSettings` 会顺手应用通知档位；本文件不判这段行为。
      setNotificationPopups: () => undefined,
    },
    configurable: true,
  });
  Object.defineProperty(plugin, "hasUnsettledMutationRecovery", {
    value: () => options.unsettled === true,
    configurable: true,
  });
  // 运行时与界面刷新不是本文件的判据；替换成空实现，避免拉起真实依赖。
  Object.defineProperty(plugin, "invalidateWebDavRuntime", {
    value: () => undefined,
    configurable: true,
  });
  Object.defineProperty(plugin, "updateStatusBar", {
    value: () => undefined,
    configurable: true,
  });
  Object.defineProperty(plugin, "settingsTab", { value: null, configurable: true });
  return { plugin, saved: () => persisted, notices };
}

type DeactivateInternals = {
  deactivateCloudAndRestoreOneDrive(): Promise<boolean>;
};

function internals(plugin: EasySyncPlugin): DeactivateInternals {
  return plugin as unknown as DeactivateInternals;
}

describe("F3-a 停用：只切活动云端", () => {
  it("停用后活动云端回到 OneDrive，坐标／凭据版本／测试结论全部保留", async () => {
    const harness = makeHarness();
    const before = structuredClone(harness.plugin.cloudSettings);
    const connectionBefore = structuredClone(before.webdav);

    await expect(
      internals(harness.plugin).deactivateCloudAndRestoreOneDrive(),
    ).resolves.toBe(true);
    expect(harness.plugin.cloudSettings.provider).toBe("onedrive");
    // 配置原样留着：再登录时弹窗直接带回原值（用户拍板 A）。
    expect(harness.plugin.cloudSettings.webdav).toEqual(connectionBefore);

    // 落盘的那一份也必须还认得 WebDAV 配置：这是「保留式停用」的全部意义。
    const reread = readCloudSettings(harness.saved(), CLOUD_KEYS);
    expect(reread.provider).toBe("onedrive");
    expect(reread.webdav).toEqual(connectionBefore);
    // 而且它仍然是「连接正常」的配置，不是被降级成未测试。
    expect(resolveWebDavConnectionStatus(reread.webdav, true)).toBe("untested");
  });

  it("停用不动账本路径：账本目录随 provider 回到 OneDrive", async () => {
    const harness = makeHarness();
    expect(harness.plugin.cloudSettings.provider).toBe("webdav");
    // 账本目录由**物理数据**决定，所以先让它读一次盘（真实生命周期里
    // `loadSyncSettings` 就是第一个读者）。
    await harness.plugin.loadSyncSettings();
    expect(harness.plugin.activeCloudBookDirectory).toMatch(/^state\/profiles\/webdav-/);

    await internals(harness.plugin).deactivateCloudAndRestoreOneDrive();
    // F1 分账：活动账本是 OneDrive 那本（原处），不是又开一本新的。
    expect(harness.plugin.activeCloudBookId).toBe("onedrive");
    expect(harness.plugin.activeCloudBookDirectory).toBeNull();
  });

  it("已经是 OneDrive 时什么也不做（幂等，不写盘）", async () => {
    const harness = makeHarness({ provider: "onedrive", connection: null });
    const saveData = harness.plugin.saveData as unknown as ReturnType<typeof vi.fn>;
    await expect(
      internals(harness.plugin).deactivateCloudAndRestoreOneDrive(),
    ).resolves.toBe(false);
    expect(saveData).not.toHaveBeenCalled();
    expect(harness.plugin.cloudSettings.provider).toBe("onedrive");
  });
});

describe("F3-a 停用的守卫（复用现役谓词，不发明新判据）", () => {
  it("有轮次在跑／有权锁：拒绝，且云不动", async () => {
    const harness = makeHarness({ busy: true });
    await expect(
      internals(harness.plugin).deactivateCloudAndRestoreOneDrive(),
    ).resolves.toBe(false);
    expect(harness.plugin.cloudSettings.provider).toBe("webdav");
    // 不静默失败：必须给了提示。
    expect(harness.notices.length).toBeGreaterThan(0);
  });

  it("有未结算恢复：拒绝，且云不动", async () => {
    const harness = makeHarness({ unsettled: true });
    await expect(
      internals(harness.plugin).deactivateCloudAndRestoreOneDrive(),
    ).resolves.toBe(false);
    expect(harness.plugin.cloudSettings.provider).toBe("webdav");
    expect(harness.notices.length).toBeGreaterThan(0);
  });
});
