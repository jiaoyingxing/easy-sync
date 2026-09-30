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
import { EasySyncSyncView } from "../src/ui/sync-view";
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
  "is-offline",
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

/** `updateStatusBar()` coalesces per animation frame (2026-09-11, same model
 *  as the sidebar render and the sync Notice); assertions run one frame later.
 *  compatRequestAnimationFrame falls back to a ~16ms timer outside a host. */
function flushStatusBarFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe("updateStatusBar item structure", () => {
  it("renders icon-only segment > icon container (no text span) for the ready state", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    expect(el.classes.has("is-ready")).toBe(true);
    expect(IS_GROUP_CLASSES.filter((c) => c !== "is-ready" && el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("已就绪");

    const segment = segmentOf(el);
    expect(segment.className).toBe("status-bar-item-segment");
    expect(segment.children).toHaveLength(1);
    expect(segment.children[0].className).toBe("status-bar-item-icon");
    expect(segment.children[0].tag).toBe("div");
  });

  it("carries the last sync time as the aria-label (status full text, no EasySync: prefix)", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { lastSyncTime: number }).lastSyncTime = 1;
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    expect(el.classes.has("is-ready")).toBe(true);
    expect(el.attrs["aria-label"]).toMatch(/^上次同步 /);
    expect(el.attrs["aria-label"]).not.toContain("EasySync:");
    // Icon-only: the last-sync fact must not reappear as a permanent span.
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("maps a retry-pending latest round to the connecting form while the device reports a network", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { lastSyncTime: number }).lastSyncTime = 1;
    (plugin.state as never as { syncHistory: unknown[] }).syncHistory = [
      { id: "1", status: "retry-pending" },
    ];
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    // No network claim while the system flag does not say offline: the only
    // known fact is "the cloud was not readable" — the neutral connecting
    // form (no is-* class, same as auth initializing / session-pending).
    expect(el.classes.has("is-offline")).toBe(false);
    expect(IS_GROUP_CLASSES.filter((c) => el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("连接中…");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("keeps the offline group for a retry-pending round when the system reports the device offline", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { lastSyncTime: number }).lastSyncTime = 1;
    (plugin.state as never as { syncHistory: unknown[] }).syncHistory = [
      { id: "1", status: "retry-pending" },
    ];
    vi.stubGlobal("navigator", { onLine: false });
    try {
      plugin.updateStatusBar();
      // The frame callback reads the system flag, so the stub must cover it.
      await flushStatusBarFrame();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(el.classes.has("is-offline")).toBe(true);
    expect(IS_GROUP_CLASSES.filter((c) => c !== "is-offline" && el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("无网络连接");
    expect(RIBBON_STATUS_ICONS.offline).toBe("wifi-off");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("maps the syncing branch to the syncing group with the rotating class", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    plugin.syncExecutor = { isRunning: true, hasSideActionsInFlight: false } as never;
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    expect(el.classes.has("is-syncing")).toBe(true);
    expect(IS_GROUP_CLASSES.filter((c) => c !== "is-syncing" && el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("同步中…");
    expect(segmentOf(el).children).toHaveLength(1);
    expect(RIBBON_STATUS_ICONS.syncing).toBe("refresh-cw");
  });

  it("renders the held-lock phrase the moment the lock is acquired and restores idle on release", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    const lock = plugin as never as {
      acquireOpLock(operation: string): string | null;
      releaseOpLock(): void;
    };

    // 2026-09-20 回填实测：锁持有窗口（重置预检爬网、范围设置提交）没有轮次
    // 在跑、也没有其他事件会刷新状态栏——占用短语必须在获取锁的那一刻渲染，
    // 否则整个窗口停留在锁前旧文案（「空闲外观＋正在运行弹窗」错位回归）。
    expect(lock.acquireOpLock("reset")).toBeNull();
    await flushStatusBarFrame();
    expect(el.attrs["aria-label"]).toBe("重置进行中");
    expect(el.classes.has("is-syncing")).toBe(true);

    lock.releaseOpLock();
    await flushStatusBarFrame();
    expect(el.attrs["aria-label"]).toBe("已就绪");
    expect(el.classes.has("is-syncing")).toBe(false);
  });

  it("maps attention branches (conflicts / deletes / plan review) to the attention group", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}];
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    expect(el.classes.has("is-attention")).toBe(true);
    expect(el.classes.has("is-syncing")).toBe(false);
    expect(el.attrs["aria-label"]).toBe("2 项冲突");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("carries the compound status full text (conflicts · deletes) into the aria-label", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}, {}];
    (plugin.state as never as { pendingRemoteDeletes: unknown[] }).pendingRemoteDeletes =
      [{}, {}];
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    expect(el.classes.has("is-attention")).toBe(true);
    expect(el.attrs["aria-label"]).toBe("3 冲突 · 2 待删");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("maps the not-logged-in branch to the loggedOut group", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin as never as { auth: unknown }).auth = {
      isInitializing: false,
      authState: { isLoggedIn: false },
    };
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    expect(el.classes.has("is-loggedOut")).toBe(true);
    expect(el.attrs["aria-label"]).toBe("未登录");
    expect(segmentOf(el).children).toHaveLength(1);
    expect(RIBBON_STATUS_ICONS.loggedOut).toBe("cloud-off");
  });

  it("keeps the connecting branch neutral (plain cloud, no group class, no red)", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin as never as { auth: unknown }).auth = {
      isInitializing: true,
      authState: { isLoggedIn: false },
    };
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    // Contract: 连接中不红 → the fixed CSS rules only color `.is-*` classes,
    // so the branch carries no group class at all.
    expect(IS_GROUP_CLASSES.filter((c) => el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("连接中…");
    expect(segmentOf(el).children).toHaveLength(1);
  });

  it("resets a stale group class when re-rendering into the connecting branch", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}];
    plugin.updateStatusBar();
    await flushStatusBarFrame();
    expect(el.classes.has("is-attention")).toBe(true);

    (plugin as never as { auth: unknown }).auth = {
      isInitializing: true,
      authState: { isLoggedIn: false },
    };
    plugin.updateStatusBar();
    await flushStatusBarFrame();
    expect(IS_GROUP_CLASSES.filter((c) => el.classes.has(c))).toEqual([]);
  });

  it("swaps the group class when re-rendering into another state (remove-all then add)", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [{}, {}];
    plugin.updateStatusBar();
    await flushStatusBarFrame();
    expect(el.classes.has("is-attention")).toBe(true);

    (plugin.state as never as { pendingConflicts: unknown[] }).pendingConflicts =
      [];
    plugin.updateStatusBar();
    await flushStatusBarFrame();
    expect(el.classes.has("is-ready")).toBe(true);
    expect(el.classes.has("is-attention")).toBe(false);
  });
});

describe("the attention members the bar was missing", () => {
  // 组归属与「不得声称就绪」由三载体一致性门覆盖（每个注意态场景都断言状态栏落到
  // attention 档）；这里只钉住各自复用的现役文案，避免同一事实两套说法。
  it("carries the settings wording while an automatic pause is active", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { lastSyncTime: number }).lastSyncTime = 1;
    (plugin as never as { autoSyncPaused: boolean }).autoSyncPaused = true;
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    // 复用设置页现役同一句（同一事实同一措辞）；点击仍是既有「打开同步侧栏」，
    // 提示不新增信息职责。
    expect(el.attrs["aria-label"]).toBe(
      "上次同步未完成，自动同步已暂停，请手动重试。",
    );
  });

  it("returns to the ready claim once a healthy round releases the pause", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin as never as { autoSyncPaused: boolean }).autoSyncPaused = true;
    plugin.updateStatusBar();
    await flushStatusBarFrame();
    expect(el.classes.has("is-attention")).toBe(true);

    (plugin as never as { autoSyncPaused: boolean }).autoSyncPaused = false;
    (plugin.state as never as { lastSyncTime: number }).lastSyncTime = 1;
    plugin.updateStatusBar();
    await flushStatusBarFrame();
    expect(el.classes.has("is-ready")).toBe(true);
    expect(el.attrs["aria-label"]).toMatch(/^上次同步 /);
  });

  it("carries the sidebar's count phrase for pending issues", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin.state as never as { pendingIssues: unknown[] }).pendingIssues = [
      {},
      {},
      {},
    ];
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    expect(el.attrs["aria-label"]).toBe("需要处理 3");
  });

  it("keeps the retry-pending presentation when a pause flag is also set (order guard)", async () => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    (plugin as never as { autoSyncPaused: boolean }).autoSyncPaused = true;
    (plugin.state as never as { syncHistory: unknown[] }).syncHistory = [
      { id: "1", status: "retry-pending" },
    ];
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    // 观察暂态轮的中性呈现优先于暂停：设备当前读不到云端是更近的事实，既有
    // 离线／连接中合同零变化。
    expect(IS_GROUP_CLASSES.filter((c) => el.classes.has(c))).toEqual([]);
    expect(el.attrs["aria-label"]).toBe("连接中…");
  });
});

/**
 * 三载体一致性门（2026-09-29 用户指令「实测，把对不上的状态都修复掉」）。
 *
 * 专题合同（`docs/topics/同步状态提示体系.md` 核心定位＋共同原则 1/2）：同一同步事实、
 * 共享语义、按载体差异化展示；宽状态判为需要注意时，三个载体不得互相矛盾。本门把
 * 同一场景同时喂给桌面状态栏、侧栏状态线与 Ribbon，断言三者落到同一语义档——载体的
 * 文案密度可以不同（侧栏「尚未同步」vs 状态栏「已就绪」），但**档位**必须一致。
 *
 * 有意例外（各有已拍板出处，不由本门覆盖）：
 *  - Ribbon 不表达离线／观察暂态轮（2026-08-29 拍板「ribbon 图标不改」，DECISIONS 在案）；
 *  - Ribbon 在初始化／会话待续时不动（2026-09-11 拍板，其点击本身是重试路径）；
 *  - 状态栏的锁占用短语是它独有的载体级补充（2026-09-20 拍板 A2），侧栏无对应档位。
 */
type CarrierToken =
  | "loggedOut"
  | "connecting"
  | "running"
  | "cancelling"
  | "attention"
  | "offline"
  | "ready";

interface CarrierScenario {
  name: string;
  token: CarrierToken;
  /** Ribbon 是否参与本场景（false = 上述已拍板例外）。 */
  ribbon: boolean;
  apply: (plugin: EasySyncPlugin) => void;
}

function sidebarStatusState(plugin: EasySyncPlugin): Record<string, unknown> {
  const state = plugin.state as never as {
    lastSyncTime: number;
    planReviewActive: boolean;
    pendingConflicts: unknown[];
    pendingRemoteDeletes: unknown[];
    pendingIssues: unknown[];
    syncHistory: Array<{ status: string }>;
  };
  return {
    isLoggedIn: plugin.auth?.authState.isLoggedIn ?? false,
    isInitializing: plugin.auth?.isInitializing ?? false,
    isPending: (plugin.auth as never as { isPending?: boolean })?.isPending ?? false,
    sessionPending:
      (plugin.auth as never as { isSessionPending?: boolean })?.isSessionPending ?? false,
    isRunning: plugin.syncExecutor?.isRunning ?? false,
    lastSyncTime: state.lastSyncTime,
    pendingCount:
      state.pendingConflicts.length
      + state.pendingRemoteDeletes.length
      + state.pendingIssues.length,
    planReviewActive: state.planReviewActive,
    autoSyncPaused: plugin.autoSyncPaused,
    mutationRecovery: plugin.getMutationRecoveryDisplayState(),
    latestHistory: state.syncHistory?.[0],
    progress: plugin.progressStore.state,
  };
}

function barToken(el: FakeStatusBarElement, connecting: string): CarrierToken | "other" {
  if (el.classes.has("is-loggedOut")) return "loggedOut";
  if (el.classes.has("is-cancelling")) return "cancelling";
  if (el.classes.has("is-attention")) return "attention";
  if (el.classes.has("is-offline")) return "offline";
  if (el.classes.has("is-syncing")) {
    return el.attrs["aria-label"] === "正在取消…" ? "cancelling" : "running";
  }
  if (el.classes.has("is-ready") || el.classes.has("is-success")) return "ready";
  return el.attrs["aria-label"] === connecting ? "connecting" : "other";
}

function sidebarToken(presentation: { status: string; label: string }, i18n: I18n): CarrierToken | "other" {
  switch (presentation.status) {
    case "loggedOut":
      return "loggedOut";
    case "cancelling":
      return "cancelling";
    case "attention":
      return "attention";
    case "offline":
      return "offline";
    case "syncing":
      return "running";
    case "success":
      return "ready";
    case "ready":
      return presentation.label === i18n.t("syncView.never") ? "ready" : "connecting";
    default:
      return "other";
  }
}

function ribbonToken(plugin: EasySyncPlugin): CarrierToken | "other" {
  switch ((plugin as never as { getRibbonStatus(): string }).getRibbonStatus()) {
    case "loggedOut":
      return "loggedOut";
    case "cancelling":
      return "cancelling";
    case "attention":
      return "attention";
    case "syncing":
      return "running";
    case "success":
    case "ready":
      return "ready";
    default:
      return "other";
  }
}

describe("three-carrier parity — the same scenario must land on the same token", () => {
  const setState = (plugin: EasySyncPlugin, patch: Record<string, unknown>): void => {
    Object.assign(
      plugin.state as never as Record<string, unknown>,
      {
        planReviewActive: false,
        pendingConflicts: [],
        pendingRemoteDeletes: [],
        pendingIssues: [],
        syncHistory: [],
        lastSyncTime: 0,
      },
      patch,
    );
  };
  const setAuth = (
    plugin: EasySyncPlugin,
    patch: { isInitializing?: boolean; isLoggedIn?: boolean },
  ): void => {
    (plugin as never as { auth: unknown }).auth = {
      isInitializing: patch.isInitializing ?? false,
      authState: { isLoggedIn: patch.isLoggedIn ?? true },
    };
  };
  const setRecovery = (plugin: EasySyncPlugin, kind: string | null): void => {
    vi.spyOn(plugin as never, "getMutationRecoveryDisplayState").mockReturnValue(
      (kind ? { kind } : null) as never,
    );
  };

  const SCENARIOS: CarrierScenario[] = [
    {
      name: "未登录",
      token: "loggedOut",
      ribbon: true,
      apply: (p) => {
        setAuth(p, { isLoggedIn: false });
      },
    },
    {
      name: "登录初始化中（连接中）",
      token: "connecting",
      ribbon: false,
      apply: (p) => {
        setAuth(p, { isInitializing: true, isLoggedIn: false });
      },
    },
    {
      name: "会话待续（连接中）",
      token: "connecting",
      ribbon: false,
      apply: (p) => {
        (p as never as { auth: unknown }).auth = {
          isInitializing: false,
          isSessionPending: true,
          authState: { isLoggedIn: true },
        };
      },
    },
    {
      name: "运行中",
      token: "running",
      ribbon: true,
      apply: (p) => {
        p.syncExecutor = { isRunning: true, hasSideActionsInFlight: false } as never;
        setState(p, { lastSyncTime: 1, syncHistory: [{ status: "success" }] });
      },
    },
    {
      name: "正在取消",
      token: "cancelling",
      ribbon: true,
      apply: (p) => {
        p.syncExecutor = { isRunning: true, hasSideActionsInFlight: false } as never;
        setState(p, { lastSyncTime: 1, syncHistory: [{ status: "success" }] });
        (p.progressStore.state as { cancelRequested: boolean }).cancelRequested = true;
      },
    },
    {
      name: "计划待审阅",
      token: "attention",
      ribbon: true,
      apply: (p) => {
        setState(p, { planReviewActive: true, syncHistory: [{ status: "success" }] });
      },
    },
    {
      name: "冲突",
      token: "attention",
      ribbon: true,
      apply: (p) => {
        setState(p, {
          pendingConflicts: [{}, {}],
          lastSyncTime: 1,
          syncHistory: [{ status: "success" }],
        });
      },
    },
    {
      name: "待确认删除",
      token: "attention",
      ribbon: true,
      apply: (p) => {
        setState(p, {
          pendingRemoteDeletes: [{}],
          lastSyncTime: 1,
          syncHistory: [{ status: "success" }],
        });
      },
    },
    {
      name: "待处理事项",
      token: "attention",
      ribbon: true,
      apply: (p) => {
        setState(p, {
          pendingIssues: [{}, {}],
          lastSyncTime: 1,
          syncHistory: [{ status: "success" }],
        });
      },
    },
    {
      name: "自动同步暂停",
      token: "attention",
      ribbon: true,
      apply: (p) => {
        p.autoSyncPaused = true;
        setState(p, { lastSyncTime: 1, syncHistory: [{ status: "cancelled" }] });
      },
    },
    {
      name: "恢复阻塞",
      token: "attention",
      ribbon: true,
      apply: (p) => {
        setRecovery(p, "blocked");
        setState(p, { syncHistory: [{ status: "partial" }] });
      },
    },
    {
      name: "等待网络恢复",
      token: "attention",
      ribbon: true,
      apply: (p) => {
        setRecovery(p, "waiting-network");
        setState(p, { syncHistory: [{ status: "partial" }] });
      },
    },
    {
      name: "观察暂态轮（设备有网）",
      token: "connecting",
      ribbon: false,
      apply: (p) => {
        setState(p, { lastSyncTime: 1, syncHistory: [{ status: "retry-pending" }] });
      },
    },
    {
      name: "观察暂态轮（系统离线）",
      token: "offline",
      ribbon: false,
      apply: (p) => {
        setState(p, { lastSyncTime: 1, syncHistory: [{ status: "retry-pending" }] });
        vi.stubGlobal("navigator", { onLine: false });
      },
    },
    {
      name: "就绪（有成功轮）",
      token: "ready",
      ribbon: true,
      apply: (p) => {
        setState(p, { lastSyncTime: 1, syncHistory: [{ status: "success" }] });
      },
    },
    {
      name: "从未同步",
      token: "ready",
      ribbon: true,
      apply: () => {},
    },
  ];

  it.each(SCENARIOS)("$name", async (scenario) => {
    const el = createFakeStatusBarElement();
    const plugin = makePlugin(el);
    scenario.apply(plugin);
    plugin.updateStatusBar();
    await flushStatusBarFrame();

    const view = Object.create(EasySyncSyncView.prototype) as never as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: unknown) => { status: string; label: string };
    };
    view.plugin = { i18n: plugin.i18n };

    try {
      const tokens = {
        bar: barToken(el, plugin.i18n.t("status.connecting")),
        sidebar: sidebarToken(view.getStatusPresentation(sidebarStatusState(plugin)), plugin.i18n),
        ribbon: scenario.ribbon ? ribbonToken(plugin) : scenario.token,
      };
      expect({ scenario: scenario.name, ...tokens }).toEqual({
        scenario: scenario.name,
        bar: scenario.token,
        sidebar: scenario.token,
        ribbon: scenario.token,
      });
    } finally {
      vi.unstubAllGlobals();
    }
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