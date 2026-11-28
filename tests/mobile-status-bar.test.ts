import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import EasySyncPlugin from "../src/main";

interface FakeStatusBar {
  element: HTMLElement;
  addClass: ReturnType<typeof vi.fn>;
  removeClass: ReturnType<typeof vi.fn>;
  setCssProps: ReturnType<typeof vi.fn>;
  removeProperty: ReturnType<typeof vi.fn>;
  setProperty: ReturnType<typeof vi.fn>;
}

function createFakeStatusBar(): FakeStatusBar {
  const classes = new Set<string>();
  const addClass = vi.fn((...tokens: string[]) => {
    for (const token of tokens) classes.add(token);
  });
  const removeClass = vi.fn((...tokens: string[]) => {
    for (const token of tokens) classes.delete(token);
  });
  const setCssProps = vi.fn((_props: Record<string, string>) => undefined);
  const removeProperty = vi.fn((_name: string) => undefined);
  const setProperty = vi.fn((_name: string, _value: string) => undefined);
  const element = {
    addClass,
    removeClass,
    setCssProps,
    style: { removeProperty, setProperty },
  } as unknown as HTMLElement;
  return { element, addClass, removeClass, setCssProps, removeProperty, setProperty };
}

interface PluginHarness {
  plugin: EasySyncPlugin;
  layoutReadyCallbacks: Array<() => void>;
  workspaceOn: ReturnType<typeof vi.fn>;
  workspaceOffref: ReturnType<typeof vi.fn>;
}

function makePlugin(): PluginHarness {
  const plugin = new EasySyncPlugin();
  const layoutReadyCallbacks: Array<() => void> = [];
  const workspaceOn = vi.fn(() => ({ event: "layout-change" }));
  const workspaceOffref = vi.fn();
  plugin.app = {
    workspace: {
      onLayoutReady: (callback: () => void) => {
        layoutReadyCallbacks.push(callback);
      },
      on: workspaceOn,
      offref: workspaceOffref,
    },
  } as never;
  return { plugin, layoutReadyCallbacks, workspaceOn, workspaceOffref };
}

function isRetryArmed(plugin: EasySyncPlugin): boolean {
  return (plugin as never as { mobileStatusBarLayoutRetryArmed: boolean })
    .mobileStatusBarLayoutRetryArmed;
}

describe("mobile status bar", () => {
  const previousMobile = Platform.isMobile;
  const previousMobileApp = Platform.isMobileApp;
  const previousDocument = (globalThis as { document?: Document }).document;
  const previousWindow = (globalThis as { window?: Window }).window;
  let statusBar: FakeStatusBar;
  let statusBarPresent: boolean;
  let navbar: HTMLElement | null;
  let navbarDisplay: string;

  beforeEach(() => {
    // 判据是 UI 形态：真机与桌面 app.emulateMobile() 同一条路径
    // （2026-11-27 回归：桌面模拟移动端曾因 isMobileApp 门整条跳过，
    // 而宿主已用 `.is-mobile .status-bar` 隐藏桌面状态栏，右下角全空）。
    Platform.isMobile = true;
    Platform.isMobileApp = false;
    statusBar = createFakeStatusBar();
    statusBarPresent = true;
    navbar = null;
    navbarDisplay = "none";
    const querySelector = vi.fn((selector: string) => {
      if (selector === ".is-mobile .app-container .status-bar") {
        return statusBarPresent ? statusBar.element : null;
      }
      if (selector === ".mobile-navbar") return navbar;
      return null;
    });
    (globalThis as { document?: Document }).document = {
      querySelector,
    } as unknown as Document;
    (globalThis as { window?: Window }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getComputedStyle: () => ({
        display: navbarDisplay,
        getPropertyValue: () => "52px",
      }),
    } as unknown as Window;
  });

  afterEach(() => {
    Platform.isMobile = previousMobile;
    Platform.isMobileApp = previousMobileApp;
    if (previousDocument === undefined) {
      delete (globalThis as { document?: Document }).document;
    } else {
      (globalThis as { document?: Document }).document = previousDocument;
    }
    if (previousWindow === undefined) {
      delete (globalThis as { window?: Window }).window;
    } else {
      (globalThis as { window?: Window }).window = previousWindow;
    }
    vi.restoreAllMocks();
  });

  it("adds the shown class on enable and removes it on disable", () => {
    const { plugin, workspaceOn, workspaceOffref } = makePlugin();

    plugin.applyMobileStatusBar();

    expect(statusBar.addClass).toHaveBeenCalledWith(
      "easy-sync-mobile-status-bar-shown",
    );
    expect(statusBar.setCssProps).toHaveBeenCalledWith({ display: "flex" });
    expect(isRetryArmed(plugin)).toBe(false);
    expect(workspaceOn).toHaveBeenCalledWith(
      "layout-change",
      expect.any(Function),
    );

    // Arm the retry by hand: a disable must drop it even when no retry is
    // currently scheduled. (The later layout-ready callback is actually stopped
    // by its own `this.mobileStatusBar` check; this test only pins the flag.)
    (plugin as never as { mobileStatusBarLayoutRetryArmed: boolean })
      .mobileStatusBarLayoutRetryArmed = true;
    plugin.mobileStatusBar = false;
    plugin.applyMobileStatusBar();

    expect(statusBar.removeClass).toHaveBeenCalledWith(
      "easy-sync-mobile-status-bar-shown",
    );
    expect(statusBar.setCssProps).toHaveBeenCalledWith({ display: "" });
    expect(statusBar.removeProperty).toHaveBeenCalledWith("margin-bottom");
    expect(isRetryArmed(plugin)).toBe(false);
    expect(workspaceOffref).toHaveBeenCalledOnce();
  });

  it("does nothing on the normal desktop UI", () => {
    Platform.isMobile = false;
    const { plugin, workspaceOn, layoutReadyCallbacks } = makePlugin();
    const enable = vi.spyOn(plugin as never, "enableMobileStatusBar");
    const disable = vi.spyOn(plugin as never, "disableMobileStatusBar");

    plugin.applyMobileStatusBar();

    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    expect(workspaceOn).not.toHaveBeenCalled();
    expect(layoutReadyCallbacks).toHaveLength(0);
    expect(statusBar.addClass).not.toHaveBeenCalled();
  });

  it("does not reserve navbar space when the tablet navbar is display:none", () => {
    // 平板形态的宿主保留 `.mobile-navbar` 元素但把它藏起来；按存在性判断会
    // 让状态图标悬空（2026-11-27 实测 52px）。
    navbar = {} as HTMLElement;
    navbarDisplay = "none";
    const { plugin } = makePlugin();

    (plugin as never as { refreshMobileStatusBarOffset: () => void })
      .refreshMobileStatusBarOffset();

    expect(statusBar.removeProperty).toHaveBeenCalledWith("margin-bottom");
    expect(statusBar.setProperty).not.toHaveBeenCalled();
  });

  it("reserves the navbar height when the navbar is actually laid out", () => {
    navbar = {} as HTMLElement;
    navbarDisplay = "flex";
    const { plugin } = makePlugin();

    (plugin as never as { refreshMobileStatusBarOffset: () => void })
      .refreshMobileStatusBarOffset();

    expect(statusBar.setProperty).toHaveBeenCalledWith("margin-bottom", "52px");
    expect(statusBar.removeProperty).not.toHaveBeenCalled();
  });

  it("retries exactly once when the host status-bar element stays absent", () => {
    statusBarPresent = false;
    const { plugin, layoutReadyCallbacks } = makePlugin();
    const enable = vi.spyOn(plugin as never, "enableMobileStatusBar");

    plugin.applyMobileStatusBar();

    expect(enable).toHaveBeenCalledOnce();
    expect(isRetryArmed(plugin)).toBe(true);
    expect(layoutReadyCallbacks).toHaveLength(1);

    layoutReadyCallbacks[0]();

    // The retry ran once and saw the element still missing: it must not arm
    // another layout-ready callback (the pre-fix unbounded loop).
    expect(enable).toHaveBeenCalledOnce();
    expect(layoutReadyCallbacks).toHaveLength(1);
    expect(isRetryArmed(plugin)).toBe(false);
  });

  it("uses the retry when the host element shows up before layout ready", () => {
    statusBarPresent = false;
    const { plugin, layoutReadyCallbacks } = makePlugin();

    plugin.applyMobileStatusBar();
    expect(statusBar.addClass).not.toHaveBeenCalled();

    statusBarPresent = true;
    layoutReadyCallbacks[0]();

    expect(statusBar.addClass).toHaveBeenCalledWith(
      "easy-sync-mobile-status-bar-shown",
    );
    expect(layoutReadyCallbacks).toHaveLength(1);
    expect(isRetryArmed(plugin)).toBe(false);
  });
});
