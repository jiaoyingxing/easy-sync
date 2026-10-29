import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import EasySyncPlugin from "../src/main";

interface FakeStatusBar {
  element: HTMLElement;
  addClass: ReturnType<typeof vi.fn>;
  removeClass: ReturnType<typeof vi.fn>;
  setCssProps: ReturnType<typeof vi.fn>;
  removeProperty: ReturnType<typeof vi.fn>;
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
  const element = {
    addClass,
    removeClass,
    setCssProps,
    style: { removeProperty, setProperty: vi.fn() },
  } as unknown as HTMLElement;
  return { element, addClass, removeClass, setCssProps, removeProperty };
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

  beforeEach(() => {
    Platform.isMobile = true;
    Platform.isMobileApp = true;
    statusBar = createFakeStatusBar();
    statusBarPresent = true;
    const querySelector = vi.fn((selector: string) =>
      selector === ".is-mobile .app-container .status-bar" && statusBarPresent
        ? statusBar.element
        : null,
    );
    (globalThis as { document?: Document }).document = {
      querySelector,
    } as unknown as Document;
    (globalThis as { window?: Window }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getComputedStyle: () => ({ getPropertyValue: () => "50px" }),
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
    // currently scheduled, so a later layout-ready callback cannot re-show.
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
