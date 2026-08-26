/**
 * Status bar item structure & class gate.
 *
 * 状态栏增强（2026-08-26 拍板）：`updateStatusBar()` 不再只 setText，而是
 * 重建宿主结构 `status-bar-item-segment` > `status-bar-item-icon`（setIcon）。
 * 切片 2（2026-08-26）：
 *  - 图标着色弃用 `data-easy-sync-status` 属性选择器，改用与侧栏状态行同构的
 *    `.is-*` 类（is-loggedOut / is-cancelling / is-syncing / is-attention /
 *    is-success / is-ready）：先 removeClass 全套再 addClass 当前态；连接中
 *    不落任何 is-* 类（灰）；
 *  - 点击（onload 一次性 `onClickEvent`）改调私有 `handleRibbonClick()`，
 *    与 ribbon 同语义（未登录→打开设置 / ready→startManualSync / 其余→打开视图）。
 * 切片 3（2026-08-26，本门）：纯图标定稿（方案 A，官方 Sync 同构）——
 * **不再创建文本 span**，结构仅 `status-bar-item-segment` > `status-bar-item-icon`
 * （setIcon svg 无文本）；就绪态图标上绿（CSS `.is-ready … { color: var(--color-green) }`）；
 * 状态全文进 setTooltip / `aria-label`（复用现有 status.* 文案，同一 `text`
 * 变量喂两处 → tooltip 与 aria-label 同文案，无障碍一致）；点击语义与 is-* 类体系不变。
 * 本 gate 用与 sync-view.test.ts 相同的 fake-element 风格锁定：
 *  - 结构（segment > icon，**无文本 span**）、is-* 类与 aria-label（状态全文）；
 *  - 各分支 → 语义组映射（loggedOut→cloud-off、syncing→refresh-cw、
 *    attention→cloud-alert、ready→cloud；连接中不落组、不红、无 is-* 类）；
 *  - `initStatusBar()` 一次性添加 item 类与点击绑定（handleRibbonClick）。
 */
import { describe, expect, it, vi } from "vitest";
import EasySyncPlugin from "../src/main";
import { I18n } from "../src/i18n";
import { RIBBON_STATUS_ICONS } from "../src/ui/ribbon-status";
import type { SyncProgressState } from "../src/sync/sync-progress";

interface FakeStatusBarElement {
  tag: string;
  className: string;
  text: string;
  children: FakeStatusBarElement[];
  attrs: Record<string, string>;
  classes: Set<string>;
  clickHandler: (() => void) | null;
  empty(): void;
  addClass(...names: string[]): void;
  removeClass(...names: string[]): void;
  toggleClass(name: string, on: boolean): void;
  onClickEvent(handler: () => void): void;
  setAttr(name: string, value: string): void;
  removeAttribute(name: string): void;
  createDiv(params?: { cls?: string }): FakeStatusBarElement;
  createSpan(params?: { cls?: string; text?: string }): FakeStatusBarElement;
}

function createFakeStatusBarElement(
  tag = "div",
  className = "",
): FakeStatusBarElement {
  const element: FakeStatusBarElement = {
    tag,
    className,
    text: "",
    children: [],
    attrs: {},
    classes: new Set<string>(),
    clickHandler: null,
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
    onClickEvent(handler: () => void) {
      this.clickHandler = handler;
    },
    setAttr(name: string, value: string) {
      this.attrs[name] = value;
    },
    removeAttribute(name: string) {
      delete this.attrs[name];
    },
    createDiv(params) {
      const child = createFakeStatusBarElement("div", params?.cls ?? "");
      this.children.push(child);
      return child;
    },
    createSpan(params) {
      const child = createFakeStatusBarElement("span", params?.cls ?? "");
      if (params?.text !== undefined) child.text = params.text;
      this.children.push(child);
      return child;
    },
  };
  return element;
}

const IDLE_PROGRESS: SyncProgressState = {
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

const IS_GROUP_CLASSES = [
  "is-loggedOut",
  "is-cancelling",
  "is-syncing",
  "is-attention",
  "is-success",
  "is-ready",
] as const;

/** Logged-in, idle, no pending state — drives the ready branch. */
function makePlugin(statusBarEl: FakeStatusBarElement): EasySyncPlugin {
  const plugin = new EasySyncPlugin();
  plugin.i18n = new I18n("zh-cn");
  plugin.progressStore = { state: { ...IDLE_PROGRESS } } as never;
  plugin.syncExecutor = null;
  (plugin as never as { settingsTab: unknown }).settingsTab = null;
  (plugin as never as { statusBarEl: unknown }).statusBarEl = statusBarEl;
  (plugin as never as { auth: unknown }).auth = {
    isInitializing: false,
    authState: { isLoggedIn: true },
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

function segmentOf(el: FakeStatusBarElement): FakeStatusBarElement {
  return el.children[0];
}

describe("updateStatusBar item structure", () => {
  it("renders icon-only segment > icon container (no text span) for the ready state", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    plugin.updateStatusBar();

    expect(el.classes.has("is-ready")).toBe(true);
    expect(IS_GROUP_CLASSES.filter((c) => c !== "is-ready" && el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("已就绪");

    const segment = segmentOf(el);
    expect(segment.className).toBe("status-bar-item-segment");
    expect(segment.children).toHaveLength(1);
    expect(segment.children[0].className).toBe("status-bar-item-icon");
    expect(segment.children[0].tag).toBe("div");
  });

  it("carries the last sync time as the aria-label (status full text, no EasySync: prefix)", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { lastSyncTime: number }).lastSyncTime = 1;
    plugin.updateStatusBar();

    expect(el.classes.has("is-ready")).toBe(true);
    expect(el.attrs["aria-label"]).toMatch(/^上次同步 /);
    expect(el.attrs["aria-label"]).not.toContain("EasySync:");
    // Icon-only: the last-sync fact must not reappear as a permanent span.
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("maps the syncing branch to the syncing group with the rotating class", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    plugin.syncExecutor = { isRunning: true, hasSideActionsInFlight: false } as never;
    plugin.updateStatusBar();

    expect(el.classes.has("is-syncing")).toBe(true);
    expect(IS_GROUP_CLASSES.filter((c) => c !== "is-syncing" && el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("同步中…");
    expect(segmentOf(el).children).toHaveLength(1);
    expect(RIBBON_STATUS_ICONS.syncing).toBe("refresh-cw");
  });

  it("maps attention branches (conflicts / deletes / plan review) to the attention group", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}];
    plugin.updateStatusBar();

    expect(el.classes.has("is-attention")).toBe(true);
    expect(el.classes.has("is-syncing")).toBe(false);
    expect(el.attrs["aria-label"]).toBe("2 项冲突");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("carries the compound status full text (conflicts · deletes) into the aria-label", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}, {}];
    (plugin.state as never as { pendingRemoteDeletes: unknown[] }).pendingRemoteDeletes =
      [{}, {}];
    plugin.updateStatusBar();

    expect(el.classes.has("is-attention")).toBe(true);
    expect(el.attrs["aria-label"]).toBe("3 冲突 · 2 待删");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("maps the not-logged-in branch to the loggedOut group", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin as never as { auth: unknown }).auth = {
      isInitializing: false,
      authState: { isLoggedIn: false },
    };
    plugin.updateStatusBar();

    expect(el.classes.has("is-loggedOut")).toBe(true);
    expect(el.attrs["aria-label"]).toBe("未登录");
    expect(segmentOf(el).children).toHaveLength(1);
    expect(RIBBON_STATUS_ICONS.loggedOut).toBe("cloud-off");
  });

  it("keeps the connecting branch neutral (plain cloud, no group class, no red)", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin as never as { auth: unknown }).auth = {
      isInitializing: true,
      authState: { isLoggedIn: false },
    };
    plugin.updateStatusBar();

    // Contract: 连接中不红 → the fixed CSS rules only color `.is-*` classes,
    // so the branch carries no group class at all.
    expect(IS_GROUP_CLASSES.filter((c) => el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("连接中…");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("resets a stale group class when re-rendering into the connecting branch", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}];
    plugin.updateStatusBar();
    expect(el.classes.has("is-attention")).toBe(true);

    (plugin as never as { auth: unknown }).auth = {
      isInitializing: true,
      authState: { isLoggedIn: false },
    };
    plugin.updateStatusBar();
    expect(IS_GROUP_CLASSES.filter((c) => el.classes.has(c))).toEqual([]);
  });

  it("swaps the group class when re-rendering into another state (remove-all then add)", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}];
    plugin.updateStatusBar();
    expect(el.classes.has("is-attention")).toBe(true);

    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [];
    plugin.updateStatusBar();
    expect(el.classes.has("is-ready")).toBe(true);
    expect(el.classes.has("is-attention")).toBe(false);
  });
});

describe("initStatusBar one-time binding", () => {
  it("adds the item class + mod-clickable and binds a single click to handleRibbonClick", () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    const handleClick = vi
      .spyOn(
        plugin as unknown as { handleRibbonClick: () => Promise<void> },
        "handleRibbonClick",
      )
      .mockResolvedValue(undefined);

    (plugin as never as { initStatusBar: () => void }).initStatusBar.call(plugin);

    expect(el.classes.has("easy-sync-status-bar-item")).toBe(true);
    expect(el.classes.has("mod-clickable")).toBe(true);
    expect(el.clickHandler).toBeTruthy();
    el.clickHandler!();
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it("is a no-op when the status bar item does not exist (mobile guard)", () => {
    const plugin = makePlugin(createFakeStatusBarElement());
    (plugin as never as { statusBarEl: unknown }).statusBarEl = null;
    expect(() =>
      (plugin as never as { initStatusBar: () => void }).initStatusBar.call(plugin),
    ).not.toThrow();
  });
});