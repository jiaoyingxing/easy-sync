/**
 * 找回入口接线（`src/main.ts`）：命令＋文件菜单项。
 *
 * 弹框在这里替身化——本文件只验两个入口的登记、过滤与点击语义；弹框本身的
 * 渲染与动作在 `recovery-modal.test.ts` 里按真实现验。
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import EasySyncPlugin from "../src/main";
import { I18n } from "../src/i18n";

const modalCalls = vi.hoisted(() => [] as Array<{
  options: Record<string, unknown>;
  opened: boolean;
}>);

vi.mock("../src/ui/recovery-modal", () => ({
  RecoveryModal: class {
    private readonly record: {
      options: Record<string, unknown>;
      opened: boolean;
    };

    constructor(_app: unknown, options: Record<string, unknown>) {
      this.record = { options, opened: false };
      modalCalls.push(this.record);
    }

    open(): void {
      this.record.opened = true;
    }
  },
}));

interface MenuItemRecord {
  title?: string;
  icon?: string;
  section?: string;
  click?: () => void;
}

interface FakeMenuItem {
  setTitle(title: string): FakeMenuItem;
  setIcon(icon: string): FakeMenuItem;
  setSection(section: string): FakeMenuItem;
  onClick(handler: () => void): FakeMenuItem;
}

type FileMenuHandler = (menu: unknown, file: unknown) => void;

function makeFakeMenu(items: MenuItemRecord[]) {
  const menu = {
    sectionsDeclared: [] as string[][],
    addSections(sectionNames: string[]) {
      menu.sectionsDeclared.push([...sectionNames]);
      return menu;
    },
    addItem(callback: (item: FakeMenuItem) => void): void {
      const record: MenuItemRecord = {};
      const item: FakeMenuItem = {
        setTitle(title: string) {
          record.title = title;
          return item;
        },
        setIcon(icon: string) {
          record.icon = icon;
          return item;
        },
        setSection(section: string) {
          record.section = section;
          return item;
        },
        onClick(handler: () => void) {
          record.click = handler;
          return item;
        },
      };
      callback(item);
      items.push(record);
    },
  };
  return menu;
}

function makePlugin() {
  const plugin = new EasySyncPlugin();
  const commands: Array<{ id: string; name: string; callback: () => void }> = [];
  const fileMenuHandlers: FileMenuHandler[] = [];
  const adapter = {
    exists: vi.fn(async () => false),
    list: vi.fn(async () => ({ files: [], folders: [] })),
    stat: vi.fn(async () => null),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    mkdir: vi.fn(async () => undefined),
    writeBinary: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  const state = { kind: "state" };
  const cloud = { kind: "cloud" };
  plugin.i18n = new I18n("zh-cn");
  plugin.addCommand = (command) => {
    commands.push(command as unknown as (typeof commands)[number]);
  };
  plugin.registerEvent = () => undefined;
  plugin.app = {
    vault: {
      configDir: ".obsidian",
      adapter,
      getName: () => "testVault",
      getFiles: () => [],
    },
    workspace: {
      on: (event: string, handler: FileMenuHandler) => {
        if (event === "file-menu") fileMenuHandlers.push(handler);
        return { event };
      },
    },
  } as never;
  plugin.state = state as never;
  plugin.onedrive = cloud as never;
  return { plugin, commands, fileMenuHandlers, adapter, state, cloud };
}

function registerRecoveryUi(plugin: EasySyncPlugin): void {
  (plugin as never as { registerRecoveryUi(): void }).registerRecoveryUi();
}

describe("recovery entry registration", () => {
  beforeEach(() => {
    modalCalls.length = 0;
  });

  it("registers the open-recovery command which opens the global list", () => {
    const { plugin, commands } = makePlugin();
    registerRecoveryUi(plugin);

    expect(commands.map((command) => command.id)).toEqual(["open-recovery"]);
    expect(commands[0].name).toBe(plugin.i18n.t("recovery.command"));

    commands[0].callback();
    expect(modalCalls).toHaveLength(1);
    expect(modalCalls[0].opened).toBe(true);
    // 不带路径＝总列表（"不知道文件在哪"场景）。
    expect("path" in modalCalls[0].options).toBe(false);
  });

  it("adds a file menu item for files only", () => {
    const { plugin, fileMenuHandlers } = makePlugin();
    registerRecoveryUi(plugin);
    expect(fileMenuHandlers).toHaveLength(1);
    const items: MenuItemRecord[] = [];

    const menu = makeFakeMenu(items);
    fileMenuHandlers[0](menu, new TFolder("notes"));
    expect(items).toHaveLength(0);
    expect(menu.sectionsDeclared).toEqual([]);

    fileMenuHandlers[0](menu, new TFile("notes/a.md"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: plugin.i18n.t("recovery.menuItem"),
      icon: "history",
      // 专属分组：不进官方 action 组，与系统动作分开（2026-10-20 用户拍板）。
      section: "easy-sync",
    });
    // 专属分组要在宿主名单里预声明，才会渲染到重命名/删除（danger 组）之上；
    // 只 setSection 会被宿主追加到名单末尾沉底（2026-10-20 宿主取证）。
    expect(menu.sectionsDeclared).toEqual([["easy-sync"]]);
  });

  it("opens the modal preselected with the clicked file's path", () => {
    const { plugin, fileMenuHandlers } = makePlugin();
    registerRecoveryUi(plugin);
    const items: MenuItemRecord[] = [];
    fileMenuHandlers[0](makeFakeMenu(items), new TFile("notes/a.md"));

    items[0].click?.();
    expect(modalCalls).toHaveLength(1);
    expect(modalCalls[0].opened).toBe(true);
    expect(modalCalls[0].options.path).toBe("notes/a.md");
  });

  it("hands the modal the live plugin dependencies", () => {
    const { plugin, commands, adapter, state, cloud } = makePlugin();
    registerRecoveryUi(plugin);

    commands[0].callback();
    expect(modalCalls[0].options).toMatchObject({
      adapter,
      state,
      cloud,
      i18n: plugin.i18n,
      noticeCenter: plugin.noticeCenter,
      pluginDir: ".obsidian/plugins/easy-sync",
      tmpDir: ".obsidian/plugins/easy-sync/runtime",
    });
    // 打开入口本身只开弹框：门面不碰任何写口。
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    expect(adapter.rename).not.toHaveBeenCalled();
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("registers from the plugin's Register UI section", () => {
    // 接线在 onload 的 ④ Register UI 段（视图／命令／Ribbon 同段）；
    // 这里用源码位置锁定，避免只测到方法而没接进启动链。
    const source = readFileSync("src/main.ts", "utf8");
    const start = source.indexOf("④ Register UI");
    const end = source.indexOf("⑤ Background auth init");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("this.registerRecoveryUi();");
  });
});
