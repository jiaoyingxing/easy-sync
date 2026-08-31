import { describe, expect, it, vi } from "vitest";
import { Setting, ButtonComponent } from "./__mocks__/obsidian";
import {
  buildAccountSettingDefinitions,
  buildSettingDefinitions,
} from "../src/ui/settings-tab";
import { I18n } from "../src/i18n";
import type EasySyncPlugin from "../src/main";

// The reset definition opens a ConfirmModal before clearing state. Mock it so
// we can drive both the confirmed and the cancelled path.
const confirmResult = { value: true };
vi.mock("../src/ui/confirm-modal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ui/confirm-modal")>();
  return {
    ...actual,
    ConfirmModal: class {
      constructor(
        private _app: unknown,
        private _title: string,
        private _desc: unknown,
        private _confirm: string,
        private _cancel: string,
        private _t: unknown,
        private _opts?: { danger?: boolean },
      ) {}
      async awaitConfirm(): Promise<boolean> {
        return confirmResult.value;
      }
    },
  };
});

/**
 * Minimal EasySyncPlugin-shaped object: only the members
 * `buildSettingDefinitions()` touches are provided.
 */
function createMockPlugin(): EasySyncPlugin {
  return {
    app: {} as never,
    manifest: { version: "1.4.0" },
    syncMaxFileSizeMb: 500,
    syncInterval: 3,
    autoSyncChangeDelaySeconds: 5,
    notificationPopups: "all",
    diagLogEnabled: false,
    autoSyncPaused: false,
    excludedFolders: [],
    saveSyncSettings: vi.fn().mockResolvedValue(undefined),
    applyMaxFileSize: vi.fn(),
    applyNotificationPopups: vi.fn(),
    applyDiagnosticSetting: vi.fn(),
    restartAutoSync: vi.fn(),
    setAutoSyncChangeDelaySeconds: vi.fn(),
    resetSyncState: vi.fn().mockResolvedValue(undefined),
    generateDiagnosticReport: vi.fn().mockResolvedValue(undefined),
    hasCompletedSyncState: () => false,
    auth: {
      authState: { isLoggedIn: false, displayName: undefined },
      isInitializing: false,
      isPending: false,
      deviceAttempt: null,
    },
    progressStore: { state: {} },
    syncExecutor: undefined,
    state: undefined,
    startManualSync: vi.fn(),
    startFirstSync: vi.fn(),
    executePlanReview: vi.fn(),
    cancelSync: vi.fn(),
    logoutUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as EasySyncPlugin;
}

describe("buildSettingDefinitions", () => {
  it("returns declarative groups for scope, automatic, display and maintenance", () => {
    const plugin = createMockPlugin();
    const t = new I18n("zh-cn").t.bind(new I18n("zh-cn"));
    const defs = buildSettingDefinitions(t, plugin);

    const groups = defs.filter((d) => (d as { type?: string }).type === "group");
    expect(groups.length).toBeGreaterThanOrEqual(4);

    const headings = groups.map((g) => (g as { heading?: string }).heading);
    expect(headings).toContain("范围");
    expect(headings).toContain("自动");
    expect(headings).toContain("显示");
    expect(headings).toContain("维护");
  });

  it("renders every definition without throwing", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);

    const renderable = (def: unknown): Array<{ render: (setting: never) => void }> => {
      const typed = def as { type?: string; items?: unknown[]; render?: (setting: never) => void };
      if (typed.type === "group" && Array.isArray(typed.items)) {
        return typed.items.flatMap((item) => renderable(item));
      }
      return typed.render ? [typed as { render: (setting: never) => void }] : [];
    };

    const items = defs.flatMap((def) => renderable(def));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      // Provide a mock Setting so addButton/addSlider/addDropdown/addToggle work.
      const setting = new Setting({} as HTMLElement) as never;
      expect(() => item.render(setting)).not.toThrow();
    }
  });

  it("does not mutate plugin state while building the definition list", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const snapshot = {
      syncMaxFileSizeMb: plugin.syncMaxFileSizeMb,
      syncInterval: plugin.syncInterval,
      notificationPopups: plugin.notificationPopups,
    };
    buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    expect(plugin.syncMaxFileSizeMb).toBe(snapshot.syncMaxFileSizeMb);
    expect(plugin.syncInterval).toBe(snapshot.syncInterval);
    expect(plugin.notificationPopups).toBe(snapshot.notificationPopups);
  });
});

describe("buildAccountSettingDefinitions", () => {
  it("always includes the account/login row", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);

    expect((group as { type?: string }).type).toBe("group");
    const items = (group as { items: Array<{ name?: string }> }).items;
    expect(items.length).toBe(2);
    expect(items[0].name).toBe(i18n.t("settings.account.name"));
  });

  it("hides the sync-action row until the user is signed in", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = (group as {
      items: Array<{ name?: string; visible?: () => boolean }>;
    }).items;
    const syncItem = items.find((i) => i.name === i18n.t("settings.firstSync.name"));
    expect(syncItem).toBeDefined();
    // Logged out: the sync action must not render (mirrors renderAccountSection).
    expect(syncItem?.visible?.()).toBe(false);
  });

  it("shows the sync-action row once the user is signed in", () => {
    const plugin = createMockPlugin();
    (plugin.auth as unknown as {
      authState: { isLoggedIn: boolean; displayName?: string };
    }).authState.isLoggedIn = true;
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = (group as {
      items: Array<{ name?: string; visible?: () => boolean }>;
    }).items;
    const syncItem = items.find((i) => i.name === i18n.t("settings.firstSync.name"));
    expect(syncItem?.visible?.()).toBe(true);
  });

  it("renders the account row without throwing", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const group = buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = (group as { items: Array<{ render?: (s: never) => void }> }).items;
    for (const item of items) {
      if (item.render) {
        const setting = new Setting({} as HTMLElement) as never;
        expect(() => item.render(setting)).not.toThrow();
      }
    }
  });
});

describe("declarative reset button", () => {
  function findResetItem(defs: ReturnType<typeof buildSettingDefinitions>) {
    const walk = (def: unknown): Array<{
      name?: string;
      render?: (s: never) => void;
    }> => {
      const typed = def as { type?: string; items?: unknown[]; render?: (s: never) => void };
      if (typed.type === "group" && Array.isArray(typed.items)) {
        return typed.items.flatMap((item) => walk(item));
      }
      return typed.render ? [typed as { name?: string; render?: (s: never) => void }] : [];
    };
    const i18n = new I18n("zh-cn");
    const items = defs.flatMap((def) => walk(def));
    return items.find((i) => i.name === i18n.t("settings.reset.name"));
  }

  it("applies the destructive mod-warning style to the reset button", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const resetItem = findResetItem(defs);
    expect(resetItem).toBeDefined();

    const setting = new Setting({} as HTMLElement) as never;
    const addClass = vi.fn();
    const btn = new ButtonComponent({} as HTMLElement) as unknown as {
      buttonEl: { classList: { add: (c: string) => void } };
      setButtonText: (t: string) => unknown;
      onClick: (cb: () => void | Promise<void>) => unknown;
    };
    (btn as unknown as { buttonEl: unknown }).buttonEl = { classList: { add: addClass } };
    let clickHandler: (() => void | Promise<void>) | null = null;
    btn.setButtonText = (() => btn) as never;
    btn.onClick = ((cb: () => void | Promise<void>) => { clickHandler = cb; return btn; }) as never;
    vi.spyOn(setting as never, "addButton").mockImplementation(
      (cb: (b: unknown) => void) => { cb(btn); return setting; },
    );
    resetItem!.render!(setting);

    expect(addClass).toHaveBeenCalledWith("mod-warning");
  });

  it("calls resetSyncState only after the confirm modal is accepted", async () => {
    const plugin = createMockPlugin();
    const resetSyncState = vi.fn().mockResolvedValue(undefined);
    (plugin as unknown as { resetSyncState: unknown }).resetSyncState = resetSyncState;
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const resetItem = findResetItem(defs);

    const setting = new Setting({} as HTMLElement) as never;
    const btn = new ButtonComponent({} as HTMLElement) as unknown as {
      buttonEl: { classList: { add: (c: string) => void } };
      setButtonText: (t: string) => unknown;
      onClick: (cb: () => void | Promise<void>) => unknown;
    };
    (btn as unknown as { buttonEl: unknown }).buttonEl = { classList: { add: () => undefined } };
    let clickHandler: (() => void | Promise<void>) | null = null;
    btn.setButtonText = (() => btn) as never;
    btn.onClick = ((cb: () => void | Promise<void>) => { clickHandler = cb; return btn; }) as never;
    vi.spyOn(setting as never, "addButton").mockImplementation(
      (cb: (b: unknown) => void) => { cb(btn); return setting; },
    );
    resetItem!.render!(setting);

    // Accepted confirm -> reset runs.
    confirmResult.value = true;
    await clickHandler!();
    expect(resetSyncState).toHaveBeenCalledTimes(1);

    // Cancelled confirm -> reset does not run.
    confirmResult.value = false;
    await clickHandler!();
    expect(resetSyncState).toHaveBeenCalledTimes(1);
  });
});

describe("declarative completeness vs display()", () => {
  function groupHeadings(defs: ReturnType<typeof buildSettingDefinitions>): string[] {
    const i18n = new I18n("zh-cn");
    return defs
      .filter((d) => (d as { type?: string }).type === "group")
      .map((g) => (g as { heading?: string }).heading)
      .filter((h): h is string => h !== undefined);
  }

  function itemsInGroup(
    defs: ReturnType<typeof buildSettingDefinitions>,
    heading: string,
  ): Array<{ name?: string; visible?: () => boolean }> {
    const group = defs.find((d) => (d as { heading?: string }).heading === heading) as
      | { items?: Array<{ name?: string; visible?: () => boolean }> }
      | undefined;
    return group?.items ?? [];
  }

  it("covers all six groups rendered by display()", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = [
      buildAccountSettingDefinitions(i18n.t.bind(i18n), plugin),
      ...buildSettingDefinitions(i18n.t.bind(i18n), plugin),
    ];
    const headings = groupHeadings(defs);
    expect(headings).toContain(i18n.t("settings.group.scope"));
    expect(headings).toContain(i18n.t("settings.group.automatic"));
    expect(headings).toContain(i18n.t("settings.group.display"));
    expect(headings).toContain(i18n.t("settings.group.about"));
    expect(headings).toContain(i18n.t("settings.group.maintenance"));
    // The account group is unheaded; verify it exists as the first entry.
    expect((defs[0] as { type?: string }).type).toBe("group");
  });

  it("keeps auto sync as a single toggle+configure row; sliders moved to the modal", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = itemsInGroup(defs, i18n.t("settings.group.automatic"));
    const autoSync = items.find((i) => i.name === i18n.t("settings.autoSync.name"));
    expect(autoSync).toBeDefined();
    // The interval/delay sliders no longer exist as settings-page rows.
    expect(items.find((i) => i.name === i18n.t("settings.syncInterval.name"))).toBeUndefined();
    expect(
      items.find((i) => i.name === i18n.t("settings.autoSyncChangeDelay.name")),
    ).toBeUndefined();
  });

  it("includes the about group with product and author entries", () => {
    const plugin = createMockPlugin();
    const i18n = new I18n("zh-cn");
    const defs = buildSettingDefinitions(i18n.t.bind(i18n), plugin);
    const items = itemsInGroup(defs, i18n.t("settings.group.about"));
    expect(items.some((i) => i.name === i18n.t("settings.about.product.name"))).toBe(true);
    expect(items.some((i) => i.name === i18n.t("settings.about.author.name"))).toBe(true);
  });
});
