/**
 * 刷新目标叶的选择合同（2026-09-29 真机实测发现）。
 *
 * 现场＝用户看到「侧栏状态显示停在旧帧」：插件以 `getLeavesOfType(...)[0]` 盲取第一个
 * 叶，而一个隐藏、未初始化的重复 EasySync 叶排在前面时，所有 `render()` 都刷到那个看
 * 不见的叶，可见面板冻结在重复叶出现的那一刻（实测：测试库侧栏停在「已取消 20:48」，
 * 而数据早已是成功后的一轮）。
 *
 * 合同＝优先驱动宿主真正展示的叶（`view.containerEl.isShown()`），其次才回退到第一个；
 * 完全没有叶时返回 null；首叶仍是热重载守卫的落点（旧原型无 `render` 时不驱动）。
 *
 * 当前适用上限：多个面板同时可见时只驱动其中一个（先发现即用），其余面板停在上一次
 * 渲染；重开触发见 `src/main.ts` 的 `primarySyncViewLeaf()` 注释。
 */
import { describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import EasySyncPlugin from "../src/main";
import { SYNC_VIEW_TYPE } from "../src/ui/sync-view";

interface FakeLeaf {
  view: { render?: () => void; containerEl?: { isShown: () => boolean } };
}

function fakeLeaf(shown: boolean | null, withRender = true): FakeLeaf {
  const view: FakeLeaf["view"] = {};
  if (withRender) view.render = vi.fn();
  if (shown !== null) view.containerEl = { isShown: () => shown };
  return { view };
}

function pluginWith(
  leaves: FakeLeaf[],
  extra: Record<string, unknown> = {},
): EasySyncPlugin {
  const plugin = new EasySyncPlugin();
  (plugin as never as { app: unknown }).app = {
    workspace: {
      getLeavesOfType: () => leaves,
      setActiveLeaf: vi.fn(),
      containerEl: { ownerDocument: { defaultView: { focus: vi.fn() } } },
      ...extra,
    },
  };
  return plugin;
}

describe("syncView leaf selection", () => {
  it("drives the shown leaf even when a hidden duplicate comes first", () => {
    const hidden = fakeLeaf(false);
    const shown = fakeLeaf(true);
    expect(pluginWith([hidden, shown]).syncView).toBe(shown.view);
    expect(pluginWith([hidden, shown]).syncView).not.toBe(hidden.view);
  });

  it("falls back to the first leaf when none is shown", () => {
    const first = fakeLeaf(false);
    const second = fakeLeaf(false);
    expect(pluginWith([first, second]).syncView).toBe(first.view);
  });

  it("returns the only leaf when the host reports no containerEl (legacy fakes)", () => {
    const bare = fakeLeaf(null);
    expect(pluginWith([bare]).syncView).toBe(bare.view);
  });

  it("returns null when no EasySync leaf exists", () => {
    expect(pluginWith([]).syncView).toBeNull();
  });

  it("keeps the hot-reload guard: a shown leaf without render is not driven", () => {
    const stale = fakeLeaf(true, false);
    expect(pluginWith([stale]).syncView).toBeNull();
  });
});

describe("activateSyncView leaf handling", () => {
  it("reveals the shown leaf instead of opening another one", async () => {
    const hidden = fakeLeaf(false);
    const shown = fakeLeaf(true);
    const revealLeaf = vi.fn().mockResolvedValue(undefined);
    const setViewState = vi.fn().mockResolvedValue(undefined);
    const plugin = pluginWith([hidden, shown], {
      revealLeaf,
      getLeftLeaf: () => ({ setViewState }),
    });

    await plugin.activateSyncView();

    expect(revealLeaf).toHaveBeenCalledWith(shown);
    expect(setViewState).not.toHaveBeenCalled();
  });

  it("creates the single view through the left sidebar and reveals it when none exists", async () => {
    const setViewState = vi.fn().mockResolvedValue(undefined);
    const revealLeaf = vi.fn().mockResolvedValue(undefined);
    const created = { setViewState };
    const plugin = pluginWith([], { revealLeaf, getLeftLeaf: () => created });

    await plugin.activateSyncView();

    expect(setViewState).toHaveBeenCalledWith({ type: SYNC_VIEW_TYPE, active: true });
    // 2026-10-09 宿主实测：侧栏折叠时 setViewState 只创建视图、面板不可见（点设置页
    // 「同步面板／打开」看起来毫无反应），创建后必须补 revealLeaf——官方语义即
    // 「叶在侧栏中时侧栏会被展开」（见 main.ts 同处注释）。
    expect(revealLeaf).toHaveBeenCalledWith(created);
    expect(revealLeaf.mock.invocationCallOrder[0]).toBeGreaterThan(
      setViewState.mock.invocationCallOrder[0],
    );
  });

  it("stays a no-op when the host exposes no left leaf", async () => {
    const revealLeaf = vi.fn().mockResolvedValue(undefined);
    const plugin = pluginWith([], { revealLeaf, getLeftLeaf: () => null });

    await expect(plugin.activateSyncView()).resolves.toBeUndefined();

    expect(revealLeaf).not.toHaveBeenCalled();
  });

  it("strongly focuses the revealed panel (OpenPlug pairing)", async () => {
    // 2026-11-10 用户反馈：桌面设置面是独立窗口，只 reveal 时侧栏变化被挡住，
    // 像点了没反应。合同＝revealLeaf ＋ setActiveLeaf({focus:true}) 成对（照 OpenPlug）。
    const shown = fakeLeaf(true);
    const setActiveLeaf = vi.fn();
    const plugin = pluginWith([shown], {
      revealLeaf: vi.fn().mockResolvedValue(undefined),
      setActiveLeaf,
    });

    await plugin.activateSyncView();

    expect(setActiveLeaf).toHaveBeenCalledWith(shown, { focus: true });
  });
});

describe("openSyncPanelFromSettings", () => {
  function pluginWithSettings(
    close: () => void,
    order: string[] = [],
  ): EasySyncPlugin {
    const plugin = new EasySyncPlugin();
    const leaf = { view: { containerEl: { isShown: () => true } } };
    (plugin as never as { app: unknown }).app = {
      workspace: {
        getLeavesOfType: () => [leaf],
        setActiveLeaf: vi.fn(),
        containerEl: { ownerDocument: { defaultView: { focus: vi.fn() } } },
        revealLeaf: vi.fn(async () => {
          order.push("reveal");
        }),
      },
      setting: {
        close: () => {
          order.push("close");
          close();
        },
      },
    };
    return plugin;
  }

  it("dismisses the settings surface before revealing the panel on desktop", async () => {
    // 照 OpenPlug：桌面 1.13+ 设置面是独立窗口、挡在主窗前；不收走设置时
    // reveal／setActiveLeaf 的激活被遮挡，用户感知「点了没反应」（2026-11-10）。
    const close = vi.fn();
    const order: string[] = [];
    const plugin = pluginWithSettings(close, order);

    await plugin.openSyncPanelFromSettings();

    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["close", "reveal"]);
  });

  it("reveals the panel before dismissing the settings surface on mobile", async () => {
    // 手机设置是全屏模态：抽屉可在设置面后先展开；先收设置会闪一帧空工作区
    // （2026-10-09 真机反馈），与桌面顺序相反。2026-11-10 审查恢复该分支。
    const close = vi.fn();
    const order: string[] = [];
    const plugin = pluginWithSettings(close, order);
    Platform.isMobile = true;
    try {
      await plugin.openSyncPanelFromSettings();
    } finally {
      Platform.isMobile = false;
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["reveal", "close"]);
  });
});
