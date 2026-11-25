/**
 * F3-c 激活：真正切换活动云端（两个方向共用同一条写入通路）。
 *
 * 钉住四件事：
 * 1. 切换后 `provider` 真的变了，且落盘的那一份也变了；
 * 2. 切换会写「首轮须手动」标记（自动轮让路，直到一轮手动同步成功）；
 * 3. 守卫复用现役谓词：忙碌／未结算恢复时拒绝，云不动、标记不写；
 * 4. 登录 OneDrive 的方向：确认后的意图只在登录成功那一刻兑换成切换；
 *    登录取消／失败则清掉意图，不替用户做决定。
 */
import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import { readCloudSettings } from "../src/cloud/cloud-settings";

const CLOUD_KEYS = { provider: "cloud-provider", webdav: "cloud-webdav" };
const FIRST_MANUAL_KEY = "easy-sync-activation-first-manual";

const coordinates = {
  url: "https://nas.example.com",
  username: "alice",
  rootPrefix: "EasySync",
};

const connection = {
  coordinates,
  credentialRevision: 2,
  lastTest: {
    testedAt: 1_700_000_000_000,
    ok: true,
    configFingerprint: "wd1-deadbeef",
  },
};

interface Harness {
  plugin: EasySyncPlugin;
  saved: () => Record<string, unknown>;
}

function makeHarness(options: {
  provider?: "onedrive" | "webdav";
  auth?: {
    isLoggedIn?: boolean;
    isPending?: boolean;
    isSessionPending?: boolean;
  } | null;
  busy?: boolean;
  unsettled?: boolean;
} = {}): Harness {
  const provider = options.provider ?? "onedrive";
  let persisted: Record<string, unknown> = {
    "cloud-provider": provider,
    "cloud-webdav": connection,
  };
  const plugin = new EasySyncPlugin();
  plugin.cloudSettings = {
    provider,
    webdav: connection as never,
  };
  vi.spyOn(plugin, "loadData").mockImplementation(
    async () => structuredClone(persisted),
  );
  vi.spyOn(plugin, "saveData").mockImplementation(async (next) => {
    persisted = structuredClone(next as Record<string, unknown>);
  });
  Object.defineProperty(plugin, "isSyncPathBusy", {
    value: () => options.busy === true,
    configurable: true,
  });
  Object.defineProperty(plugin, "hasUnsettledMutationRecovery", {
    value: () => options.unsettled === true,
    configurable: true,
  });
  Object.defineProperty(plugin, "noticeCenter", {
    value: {
      show: () => undefined,
      setNotificationPopups: () => undefined,
    },
    configurable: true,
  });
  Object.defineProperty(plugin, "invalidateWebDavRuntime", {
    value: () => undefined,
    configurable: true,
  });
  Object.defineProperty(plugin, "updateStatusBar", {
    value: () => undefined,
    configurable: true,
  });
  Object.defineProperty(plugin, "settingsTab", {
    value: null,
    configurable: true,
  });
  if (options.auth !== null) {
    Object.defineProperty(plugin, "auth", {
      value: {
        isInitializing: false,
        isPending: options.auth?.isPending ?? false,
        isSessionPending: options.auth?.isSessionPending ?? false,
        authState: { isLoggedIn: options.auth?.isLoggedIn ?? false },
      },
      configurable: true,
    });
  }
  return { plugin, saved: () => persisted };
}

type Internals = {
  switchActiveCloud(provider: "onedrive" | "webdav"): Promise<boolean>;
  handleOneDriveActivationProgress(): void;
  pendingOneDriveActivation: boolean;
};

function internals(plugin: EasySyncPlugin): Internals {
  return plugin as unknown as Internals;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("F3-c 激活：切换活动云端", () => {
  it("OneDrive → WebDAV：provider 与落盘都切换，并写下首轮须手动", async () => {
    const harness = makeHarness({ provider: "onedrive" });
    await expect(
      internals(harness.plugin).switchActiveCloud("webdav"),
    ).resolves.toBe(true);

    expect(harness.plugin.cloudSettings.provider).toBe("webdav");
    expect(harness.plugin.activationFirstManualPending).toBe(true);
    const reread = readCloudSettings(harness.saved(), CLOUD_KEYS);
    expect(reread.provider).toBe("webdav");
    expect(harness.saved()[FIRST_MANUAL_KEY]).toBe(true);
  });

  it("已是目标云端时是空操作，不写盘", async () => {
    const harness = makeHarness({ provider: "webdav" });
    const saveData = harness.plugin.saveData as unknown as ReturnType<typeof vi.fn>;
    await expect(
      internals(harness.plugin).switchActiveCloud("webdav"),
    ).resolves.toBe(true);
    expect(saveData).not.toHaveBeenCalled();
    expect(harness.plugin.activationFirstManualPending).toBe(false);
  });

  it("守卫：有轮次在跑／有未结算恢复时拒绝，云不动、标记不写", async () => {
    for (const flags of [{ busy: true }, { unsettled: true }]) {
      const harness = makeHarness({ provider: "onedrive", ...flags });
      await expect(
        internals(harness.plugin).switchActiveCloud("webdav"),
      ).resolves.toBe(false);
      expect(harness.plugin.cloudSettings.provider).toBe("onedrive");
      expect(harness.plugin.activationFirstManualPending).toBe(false);
    }
  });

  it("首轮须手动：自动轮一律让路", async () => {
    const harness = makeHarness({ provider: "webdav" });
    harness.plugin.activationFirstManualPending = true;
    const ran = await (
      harness.plugin as unknown as {
        runAutomaticSync(trigger: string): Promise<boolean>;
      }
    ).runAutomaticSync("interval");
    // 返回 true＝「没有需要继续做的事」，与 autoSyncPaused 同一条让路口径；
    // 且不摸执行器／权锁（首行就返回了）。
    expect(ran).toBe(true);
  });
});

describe("F3-c WebDAV 方向的入口确认", () => {
  it("点 WebDAV「登录」（OneDrive 正在用）：先确认；取消则什么都不发生", async () => {
    const harness = makeHarness({ provider: "onedrive" });
    const confirm = vi
      .spyOn(harness.plugin, "confirmCloudActivation")
      .mockResolvedValue(false);
    const saveData = harness.plugin.saveData as unknown as ReturnType<typeof vi.fn>;

    await harness.plugin.openWebDavConfig();

    expect(confirm).toHaveBeenCalledTimes(1);
    // 确认被取消：不建运行时、不写盘、活动云端不动（连表单都不打开）。
    expect(saveData).not.toHaveBeenCalled();
    expect(harness.plugin.cloudSettings.provider).toBe("onedrive");
  });
});

describe("F3-c 登录 OneDrive 的方向", () => {  it("确认后的意图在登录成功那一刻兑换成切换", async () => {
    const harness = makeHarness({
      provider: "webdav",
      auth: { isLoggedIn: true },
    });
    internals(harness.plugin).pendingOneDriveActivation = true;

    internals(harness.plugin).handleOneDriveActivationProgress();
    await flush();

    expect(harness.plugin.cloudSettings.provider).toBe("onedrive");
    expect(internals(harness.plugin).pendingOneDriveActivation).toBe(false);
    expect(harness.plugin.activationFirstManualPending).toBe(true);
  });

  it("登录取消／失败（既没登录也没有等待中的尝试）＝清掉意图，不切换", async () => {
    const harness = makeHarness({
      provider: "webdav",
      auth: { isLoggedIn: false, isPending: false },
    });
    internals(harness.plugin).pendingOneDriveActivation = true;

    internals(harness.plugin).handleOneDriveActivationProgress();
    await flush();

    expect(harness.plugin.cloudSettings.provider).toBe("webdav");
    expect(internals(harness.plugin).pendingOneDriveActivation).toBe(false);
  });

  it("等待中的设备码登录不清掉意图（等它成功）", async () => {
    const harness = makeHarness({
      provider: "webdav",
      auth: { isLoggedIn: false, isPending: true },
    });
    internals(harness.plugin).pendingOneDriveActivation = true;

    internals(harness.plugin).handleOneDriveActivationProgress();
    await flush();

    expect(internals(harness.plugin).pendingOneDriveActivation).toBe(true);
    expect(harness.plugin.cloudSettings.provider).toBe("webdav");
  });
});
