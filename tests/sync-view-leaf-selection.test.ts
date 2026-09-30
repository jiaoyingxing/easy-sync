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
    workspace: { getLeavesOfType: () => leaves, ...extra },
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

  it("creates the single view through the left sidebar when none exists", async () => {
    const setViewState = vi.fn().mockResolvedValue(undefined);
    const revealLeaf = vi.fn();
    const plugin = pluginWith([], { revealLeaf, getLeftLeaf: () => ({ setViewState }) });

    await plugin.activateSyncView();

    expect(setViewState).toHaveBeenCalledWith({ type: SYNC_VIEW_TYPE, active: true });
    expect(revealLeaf).not.toHaveBeenCalled();
  });
});
