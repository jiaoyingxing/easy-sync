/**
 * F5 状态载体：三个载体（桌面状态栏／侧栏／Ribbon）判「当前云端是否就绪」，
 * 不再判「微软是否登录」。
 *
 * 设计口径（2026-11-23 §5.3）：WebDAV 激活时，从没登录过微软的库也必须是
 * 「就绪」而不是「未登录」；OneDrive 未登录时逐字不变。改法是一份中性事实
 * `activeCloudReadiness()`，三个载体只消费它——本门钉住这份事实的两种取值，
 * 以及状态栏／Ribbon 的实际呈现，防止哪一处又自己回去读 `authState`。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import { I18n } from "../src/i18n";
import type { SyncProgressState } from "../src/sync/sync-progress";
import type { CloudSettingsV1 } from "../src/cloud/cloud-settings";

const EMPTY_PROGRESS: SyncProgressState = {
  phase: "idle",
  current: 0,
  total: 0,
  currentFile: "",
  currentItemBytes: 0,
  currentItemTotalBytes: 0,
  currentItemComplete: false,
  cancelRequested: false,
  completedFiles: [],
  completedCount: 0,
  startedAt: 0,
};

const WEBDAV_SETTINGS: CloudSettingsV1 = {
  provider: "webdav",
  webdav: {
    coordinates: {
      url: "https://nas.example.com",
      username: "alice",
      rootPrefix: "EasySync",
    },
    credentialRevision: 1,
    lastTest: { testedAt: 1, ok: true, configFingerprint: "wd1-test" },
  },
};

const ONEDRIVE_SETTINGS: CloudSettingsV1 = {
  provider: "onedrive",
  webdav: null,
};

interface FakeStatusBarElement {
  attrs: Record<string, string>;
  classes: Set<string>;
  children: FakeStatusBarElement[];
  empty(): void;
  addClass(...names: string[]): void;
  removeClass(...names: string[]): void;
  toggleClass(name: string, on: boolean): void;
  setAttr(name: string, value: string): void;
  removeAttribute(name: string): void;
  createDiv(params?: { cls?: string }): FakeStatusBarElement;
  createSpan(params?: { cls?: string; text?: string }): FakeStatusBarElement;
}

function fakeStatusBarElement(): FakeStatusBarElement {
  const element: FakeStatusBarElement = {
    attrs: {},
    classes: new Set<string>(),
    children: [],
    empty() {
      this.children = [];
    },
    addClass(...names: string[]) {
      for (const name of names) this.classes.add(name);
    },
    removeClass(...names: string[]) {
      for (const name of names) this.classes.delete(name);
    },
    toggleClass(name: string, on: boolean) {
      if (on) this.classes.add(name);
      else this.classes.delete(name);
    },
    setAttr(name: string, value: string) {
      this.attrs[name] = value;
    },
    removeAttribute(name: string) {
      delete this.attrs[name];
    },
    createDiv(params) {
      const child = fakeStatusBarElement();
      child.classes.add(params?.cls ?? "");
      this.children.push(child);
      return child;
    },
    createSpan(params) {
      const child = fakeStatusBarElement();
      child.classes.add(params?.cls ?? "");
      this.children.push(child);
      return child;
    },
  };
  return element;
}

interface AuthFixture {
  isInitializing?: boolean;
  isLoggedIn?: boolean;
  isPending?: boolean;
  isSessionPending?: boolean;
}

/** 最小可用的插件实例：只装状态栏／Ribbon 判定需要的面。 */
function makePlugin(
  cloudSettings: CloudSettingsV1,
  auth: AuthFixture,
): EasySyncPlugin {
  const plugin = new EasySyncPlugin();
  plugin.i18n = new I18n("zh-cn");
  plugin.cloudSettings = cloudSettings;
  plugin.progressStore = { state: { ...EMPTY_PROGRESS } } as never;
  plugin.syncExecutor = null;
  (plugin as never as { settingsTab: unknown }).settingsTab = null;
  (plugin as never as { auth: unknown }).auth = {
    isInitializing: auth.isInitializing ?? false,
    isPending: auth.isPending ?? false,
    isSessionPending: auth.isSessionPending ?? false,
    authState: { isLoggedIn: auth.isLoggedIn ?? false },
  };
  (plugin as never as { state: unknown }).state = {
    planReviewActive: false,
    pendingConflicts: [],
    pendingRemoteDeletes: [],
    pendingIssues: [],
    lastSyncTime: 0,
  };
  vi.spyOn(
    plugin as never,
    "getMutationRecoveryDisplayState",
  ).mockReturnValue(null);
  return plugin;
}

function flushStatusBarFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function renderStatusBar(
  plugin: EasySyncPlugin,
): Promise<FakeStatusBarElement> {
  const el = fakeStatusBarElement();
  (plugin as never as { statusBarEl: unknown }).statusBarEl = el;
  plugin.updateStatusBar();
  await flushStatusBarFrame();
  return el;
}

describe("activeCloudReadiness 中性事实", () => {
  it("WebDAV 激活时与 OneDrive 登录态完全无关（未登录／冷启动中都算就绪）", () => {
    for (const auth of [
      {},
      { isLoggedIn: true },
      { isInitializing: true },
      { isLoggedIn: true, isSessionPending: true },
      { isPending: true },
    ] as AuthFixture[]) {
      const plugin = makePlugin(WEBDAV_SETTINGS, auth);
      expect(plugin.activeCloudReadiness()).toEqual({
        provider: "webdav",
        initializing: false,
        loggedIn: true,
        loginPending: false,
        sessionPending: false,
      });
    }
  });

  it("OneDrive 下逐字返回现役 auth 事实（行为零变化）", () => {
    const plugin = makePlugin(ONEDRIVE_SETTINGS, {
      isInitializing: true,
      isLoggedIn: true,
      isPending: true,
      isSessionPending: true,
    });
    expect(plugin.activeCloudReadiness()).toEqual({
      provider: "onedrive",
      initializing: true,
      loggedIn: true,
      loginPending: true,
      sessionPending: true,
    });

    const loggedOut = makePlugin(ONEDRIVE_SETTINGS, {});
    expect(loggedOut.activeCloudReadiness()).toEqual({
      provider: "onedrive",
      initializing: false,
      loggedIn: false,
      loginPending: false,
      sessionPending: false,
    });
  });

  it("provider=webdav 但坐标缺失（fail-closed 残留）按 OneDrive 处理", () => {
    const plugin = makePlugin(
      { provider: "webdav", webdav: null },
      { isLoggedIn: false },
    );
    expect(plugin.activeCloudReadiness().provider).toBe("onedrive");
    expect(plugin.activeCloudReadiness().loggedIn).toBe(false);
  });
});

describe("状态栏按活动云端判定", () => {
  it("WebDAV 激活 + 从未登录微软：显示就绪，不是「未登录」", async () => {
    const plugin = makePlugin(WEBDAV_SETTINGS, {});
    const el = await renderStatusBar(plugin);
    expect(el.classes.has("is-ready")).toBe(true);
    expect(el.classes.has("is-loggedOut")).toBe(false);
    expect(el.attrs["aria-label"]).toBe("已就绪");
  });

  it("WebDAV 激活 + OneDrive 冷启动校验中：仍显示就绪，不是「连接中」", async () => {
    const plugin = makePlugin(WEBDAV_SETTINGS, { isInitializing: true });
    const el = await renderStatusBar(plugin);
    expect(el.classes.has("is-ready")).toBe(true);
    expect(el.attrs["aria-label"]).toBe("已就绪");
  });

  it("OneDrive 未登录：逐字不变（未登录）", async () => {
    const plugin = makePlugin(ONEDRIVE_SETTINGS, {});
    const el = await renderStatusBar(plugin);
    expect(el.classes.has("is-loggedOut")).toBe(true);
    expect(el.attrs["aria-label"]).toBe("未登录");
  });
});

describe("Ribbon 按活动云端判定", () => {
  it("WebDAV 激活 + 未登录微软：不是 loggedOut 档", () => {
    const plugin = makePlugin(WEBDAV_SETTINGS, {});
    const status = (plugin as never as { getRibbonStatus(): string })
      .getRibbonStatus();
    expect(status).not.toBe("loggedOut");
  });

  it("OneDrive 未登录：仍是 loggedOut 档", () => {
    const plugin = makePlugin(ONEDRIVE_SETTINGS, {});
    const status = (plugin as never as { getRibbonStatus(): string })
      .getRibbonStatus();
    expect(status).toBe("loggedOut");
  });
});

describe("判定只有一份来源", () => {
  const viewSource = readFileSync("src/ui/sync-view.ts", "utf8");

  it("侧栏不再自己读 authState.isLoggedIn（F5 前它判的就是「微软是否登录」）", () => {
    expect(viewSource).not.toContain("authState?.isLoggedIn");
    expect(viewSource).toContain("activeCloudReadiness()");
  });
});
