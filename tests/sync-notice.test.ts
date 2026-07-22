import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressBarComponent } from "obsidian";
import { I18n } from "../src/i18n";
import {
  createSyncProgressNoticeMessage,
  formatSyncProgressNoticeLabel,
  resolveSyncProgressNoticePresentation,
  resolveSyncNoticeOutcome,
  shouldSuppressSyncNoticeForVisibleSidebar,
} from "../src/ui/sync-notice";
import type { SyncProgressState } from "../src/sync/sync-progress";
import type { SyncResult } from "../src/sync/sync-executor";

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    success: true,
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    deferred: 0,
    skippedLarge: 0,
    skippedIgnored: 0,
    errors: 0,
    authExpired: false,
    message: "synced",
    ...overrides,
  };
}

describe("resolveSyncNoticeOutcome", () => {
  it("shows completion after a successful no-change sync", () => {
    expect(resolveSyncNoticeOutcome(result())).toEqual({
      kind: "completed",
      count: 0,
    });
  });

  it("also shows completion when files changed", () => {
    expect(resolveSyncNoticeOutcome(result({ uploaded: 1 }))).toEqual({
      kind: "completed",
      count: 0,
    });
  });

  it("does not call an incomplete no-change round completed", () => {
    expect(resolveSyncNoticeOutcome(result({ skippedLarge: 1 }))).toBeNull();
  });

  it("does not show a success notice while an actively changing file waits for the next round", () => {
    expect(resolveSyncNoticeOutcome(result({ deferred: 1 }))).toBeNull();
  });

  it("surfaces conflicts instead of a completion message", () => {
    expect(resolveSyncNoticeOutcome(result({ uploaded: 1, conflicts: 2 }))).toEqual({
      kind: "conflicts",
      count: 2,
    });
  });

  it("uses failure when errors and conflicts occur in the same run", () => {
    expect(resolveSyncNoticeOutcome(result({
      success: false,
      errors: 1,
      conflicts: 2,
    }))).toEqual({ kind: "failed", count: 0 });
  });

  it("keeps review, cancellation and auth expiry distinct from generic failure", () => {
    expect(resolveSyncNoticeOutcome(result({ success: false }), { pausedForReview: true }))
      .toEqual({ kind: "review", count: 0 });
    expect(resolveSyncNoticeOutcome(result({ success: false }), { cancelled: true }))
      .toEqual({ kind: "cancelled", count: 0 });
    expect(resolveSyncNoticeOutcome(result({ success: false, authExpired: true })))
      .toEqual({ kind: "authExpired", count: 0 });
  });
});

describe("shouldSuppressSyncNoticeForVisibleSidebar", () => {
  it("suppresses duplicate sync notices while the EasySync sidebar is visible", () => {
    expect(shouldSuppressSyncNoticeForVisibleSidebar({
      leftSidebarCollapsed: false,
      easySyncViewVisibleInLeftSidebar: true,
    })).toBe(true);
  });

  it("keeps sync notices when the sidebar is collapsed or another sidebar tab is visible", () => {
    expect(shouldSuppressSyncNoticeForVisibleSidebar({
      leftSidebarCollapsed: true,
      easySyncViewVisibleInLeftSidebar: true,
    })).toBe(false);
    expect(shouldSuppressSyncNoticeForVisibleSidebar({
      leftSidebarCollapsed: false,
      easySyncViewVisibleInLeftSidebar: false,
    })).toBe(false);
  });
});

function progress(
  overrides: Partial<SyncProgressState> = {},
): SyncProgressState {
  return {
    phase: "idle",
    current: 0,
    total: 0,
    currentFile: "",
    currentItemBytes: 0,
    currentItemTotalBytes: 0,
    currentItemComplete: false,
    cancelRequested: false,
    completedFiles: [],
    startedAt: 1,
    ...overrides,
  };
}

describe("resolveSyncProgressNoticePresentation", () => {
  it("moves from start into named pre-execution stages without inventing progress", () => {
    expect(resolveSyncProgressNoticePresentation(progress())).toMatchObject({
      kind: "starting",
      determinate: false,
      percent: 0,
    });
    expect(resolveSyncProgressNoticePresentation(progress({ phase: "preparing" })))
      .toMatchObject({
        kind: "stage",
        determinate: false,
        percent: 0,
        activity: { kind: "preparing", labelKey: "progress.preparingRemote" },
      });
  });

  it("shows a progress bar only after a phase exposes concrete progress", () => {
    for (const phase of [
      "idle",
      "scanning",
      "preparing",
      "baseline",
      "checking",
      "planning",
    ] as const) {
      expect(resolveSyncProgressNoticePresentation(progress({ phase })))
        .toMatchObject({ showProgressBar: false });
    }

    expect(resolveSyncProgressNoticePresentation(progress({
      phase: "verifying",
      current: 2,
      total: 5,
    }))).toMatchObject({ showProgressBar: true });
    expect(resolveSyncProgressNoticePresentation(progress({ phase: "verifying" })))
      .toMatchObject({ showProgressBar: false });
    expect(resolveSyncProgressNoticePresentation(progress({
      phase: "executing",
      current: 3,
      total: 12,
    }))).toMatchObject({ showProgressBar: true });
    expect(resolveSyncProgressNoticePresentation(progress({ phase: "executing" })))
      .toMatchObject({ showProgressBar: false });
  });

  it("uses whole-run progress only when execution has a known total", () => {
    expect(resolveSyncProgressNoticePresentation(progress({
      phase: "executing",
      current: 3,
      total: 12,
      currentItemBytes: 50,
      currentItemTotalBytes: 100,
    }))).toMatchObject({
      kind: "progress",
      determinate: true,
      percent: 21,
      current: 3,
      total: 12,
    });
  });

  it("surfaces cancelling before the terminal cancelled result", () => {
    expect(resolveSyncProgressNoticePresentation(progress({
      phase: "executing",
      current: 2,
      total: 5,
      cancelRequested: true,
    }))).toMatchObject({
      kind: "cancelling",
      activity: { kind: "cancelling" },
    });
  });

  it("uses phase counts directly while verifying files", () => {
    expect(resolveSyncProgressNoticePresentation(progress({
      phase: "verifying",
      current: 2,
      total: 5,
    }))).toMatchObject({
      kind: "stage",
      determinate: true,
      percent: 40,
    });
  });

  it("formats the visible lifecycle sequence with concise localized text", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);
    const cases = [
      [progress(), "☁️ 开始同步"],
      [progress({ phase: "scanning" }), "☁️ 扫描本地文件…"],
      [progress({ phase: "preparing" }), "☁️ 准备远端存储…"],
      [progress({ phase: "checking" }), "☁️ 检查远端变更…"],
      [progress({ phase: "planning" }), "☁️ 生成同步计划…"],
      [progress({ phase: "executing", current: 3, total: 12 }), "☁️ 正在同步 3/12"],
      [progress({ phase: "executing", cancelRequested: true }), "⛔ 正在取消同步…"],
    ] as const;

    for (const [state, expected] of cases) {
      const presentation = resolveSyncProgressNoticePresentation(state);
      expect(formatSyncProgressNoticeLabel(presentation, t)).toBe(expected);
    }
  });
});

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly classList = {
    add: (...tokens: string[]) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const token of tokens) classes.add(token);
      this.className = [...classes].join(" ");
    },
  };
  className = "";
  textContent = "";

  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

describe("createSyncProgressNoticeMessage", () => {
  const ProgressBarMock = ProgressBarComponent as unknown as {
    instances: Array<ProgressBarComponent & { containerEl: HTMLElement }>;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    ProgressBarMock.instances.length = 0;
  });

  it("uses Obsidian ProgressBarComponent for determinate progress", () => {
    vi.stubGlobal("document", {
      createDocumentFragment: () => new FakeNode(),
      createElement: () => new FakeNode(),
    });

    createSyncProgressNoticeMessage("Syncing 3/12", 21, true);

    expect(ProgressBarMock.instances).toHaveLength(1);
    expect(ProgressBarMock.instances[0].getValue()).toBe(21);
    expect((ProgressBarMock.instances[0].containerEl as unknown as FakeNode).className)
      .toBe("easy-sync-notice-progress-native");
  });

  it("uses the same official component at zero for unknown-total progress", () => {
    vi.stubGlobal("document", {
      createDocumentFragment: () => new FakeNode(),
      createElement: () => new FakeNode(),
    });

    createSyncProgressNoticeMessage("Starting sync", 0, false);

    expect(ProgressBarMock.instances).toHaveLength(1);
    expect(ProgressBarMock.instances[0].getValue()).toBe(0);
    expect((ProgressBarMock.instances[0].containerEl as unknown as FakeNode).className)
      .toBe("easy-sync-notice-progress-native");
  });

  it("renders stage text without a progress component when the phase has no progress signal", () => {
    vi.stubGlobal("document", {
      createDocumentFragment: () => new FakeNode(),
      createElement: () => new FakeNode(),
    });

    const message = createSyncProgressNoticeMessage(
      "Checking remote changes",
      0,
      false,
      false,
    ) as unknown as FakeNode;

    expect(ProgressBarMock.instances).toHaveLength(0);
    expect(message.children[0]?.children).toHaveLength(1);
    expect(message.children[0]?.className)
      .toBe("easy-sync-notice-progress-content is-text-only");
    expect(message.children[0]?.children[0]?.textContent).toBe("Checking remote changes");
  });

  it("fits text-only and phone progress notices to their visible content", () => {
    const styles = readFileSync("styles.css", "utf8");
    const textOnlyBlock = styles.match(
      /\.easy-sync-notice-progress-content\.is-text-only\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(textOnlyBlock).toMatch(/width:\s*auto/);

    const phoneBlock = styles.match(
      /\.is-phone \.notice\.easy-sync-notice-progress\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(phoneBlock).toMatch(/align-self:\s*center/);
    expect(phoneBlock).toMatch(/width:\s*fit-content/);
  });
});
