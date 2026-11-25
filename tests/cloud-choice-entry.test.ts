/**
 * F4/S5：侧栏登录入口先问「选择同步方式」（A5）。
 *
 * 三条边界（切片 §7 未知第 3 条点名要核对的那条）：
 * 1. 干净的未登录 → 先问云端；选 OneDrive 才进现役的「跳转／代码」选择，
 *    选 WebDAV 直接开配置弹窗；
 * 2. 已有登录在等待（设备码倒计时）→ **不插**云端选择，直接续接原流程；
 * 3. 设置页的入口不经过这一层（它继续用 `handleAuthEntryAction`，本门不碰）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleSidebarAuthEntry,
  type SidebarAuthEntryHost,
} from "../src/ui/auth-entry-flow";

const cloudChoiceState = vi.hoisted(() => ({
  shown: 0,
  lastOptions: null as null | {
    title: string;
    onedrive: { name: string; desc: string };
    webdav: { name: string; desc: string };
  },
  action: "dismiss" as "onedrive" | "webdav" | "dismiss",
}));

vi.mock("../src/ui/cloud-choice-modal", () => ({
  CloudChoiceModal: class {
    constructor(_app: unknown, options: NonNullable<typeof cloudChoiceState.lastOptions>) {
      cloudChoiceState.shown += 1;
      cloudChoiceState.lastOptions = options;
    }

    async openAndWait(): Promise<{ action: typeof cloudChoiceState.action }> {
      return { action: cloudChoiceState.action };
    }
  },
}));

const methodModalState = vi.hoisted(() => ({ shown: 0 }));

vi.mock("../src/ui/auth-method-modal", () => ({
  AuthMethodModal: class {
    constructor() {
      methodModalState.shown += 1;
    }

    async awaitAction(): Promise<{ action: "dismiss" }> {
      return { action: "dismiss" };
    }
  },
}));

const deviceModalState = vi.hoisted(() => ({ shown: 0 }));

vi.mock("../src/ui/auth-device-code-modal", () => ({
  AuthDeviceCodeModal: class {
    constructor() {
      deviceModalState.shown += 1;
    }

    open(): void {}
  },
}));

interface AuthFixture {
  isInitializing?: boolean;
  isLoggedIn?: boolean;
  isPending?: boolean;
  deviceAttempt?: unknown;
}

function makeHost(
  auth: AuthFixture | null,
  openWebDavConfig = vi.fn(async () => undefined),
): { host: SidebarAuthEntryHost; openWebDavConfig: typeof openWebDavConfig } {
  const host: SidebarAuthEntryHost = {
    app: {} as never,
    auth: auth === null
      ? null
      : {
        isInitializing: auth.isInitializing ?? false,
        isPending: auth.isPending ?? false,
        authState: { isLoggedIn: auth.isLoggedIn ?? false },
        deviceAttempt: auth.deviceAttempt ?? null,
        checkAuthStatus: () => false,
        cancelPendingLogin: () => undefined,
      } as never,
    i18n: {
      t: (key: string) => key,
    } as never,
    noticeCenter: { show: () => undefined } as never,
    openWebDavConfig,
  };
  return { host, openWebDavConfig };
}

beforeEach(() => {
  cloudChoiceState.shown = 0;
  cloudChoiceState.lastOptions = null;
  cloudChoiceState.action = "dismiss";
  methodModalState.shown = 0;
  deviceModalState.shown = 0;
});

describe("侧栏登录入口：先问同步方式", () => {
  it("干净的未登录：先弹云端选择，标题与两行文案逐字是拍板稿", async () => {
    const { host, openWebDavConfig } = makeHost({});
    await handleSidebarAuthEntry(host);

    expect(cloudChoiceState.shown).toBe(1);
    expect(cloudChoiceState.lastOptions).toEqual({
      title: "cloudChoice.title",
      onedrive: {
        name: "cloudChoice.onedrive.name",
        desc: "cloudChoice.onedrive.desc",
      },
      webdav: {
        name: "cloudChoice.webdav.name",
        desc: "cloudChoice.webdav.desc",
      },
    });
    // 关掉＝什么都不做（不登录、不开配置）。
    expect(methodModalState.shown).toBe(0);
    expect(openWebDavConfig).not.toHaveBeenCalled();
  });

  it("选 OneDrive：再进现役的两选项弹窗，一步不少一步不多", async () => {
    cloudChoiceState.action = "onedrive";
    const { host, openWebDavConfig } = makeHost({});
    await handleSidebarAuthEntry(host);

    expect(cloudChoiceState.shown).toBe(1);
    expect(methodModalState.shown).toBe(1);
    expect(openWebDavConfig).not.toHaveBeenCalled();
  });

  it("选 WebDAV：直接开配置弹窗，不经过登录方式选择", async () => {
    cloudChoiceState.action = "webdav";
    const { host, openWebDavConfig } = makeHost({});
    await handleSidebarAuthEntry(host);

    expect(cloudChoiceState.shown).toBe(1);
    expect(openWebDavConfig).toHaveBeenCalledTimes(1);
    expect(methodModalState.shown).toBe(0);
  });

  it("设备码等待中：不插云端选择，直接续接原流程", async () => {
    const { host } = makeHost({
      isPending: true,
      deviceAttempt: { userCode: "ABCD-EFGH" },
    });
    await handleSidebarAuthEntry(host);

    expect(cloudChoiceState.shown).toBe(0);
    expect(deviceModalState.shown).toBe(1);
  });

  it("已登录／冷启动校验中：不弹任何东西", async () => {
    for (const auth of [{ isLoggedIn: true }, { isInitializing: true }]) {
      const { host } = makeHost(auth);
      await handleSidebarAuthEntry(host);
    }
    expect(cloudChoiceState.shown).toBe(0);
    expect(methodModalState.shown).toBe(0);
    expect(deviceModalState.shown).toBe(0);
  });
});
