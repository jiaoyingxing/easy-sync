import { describe, expect, it, vi } from "vitest";
import {
  buildAdaptivePathLayout,
  diffCompletedFileRows,
  selectCompletedDisplayRows,
  buildSyncPlanDisplayGroups,
  buildSyncPlanDisplayRows,
  buildSyncPlanMeasuredVirtualOffsets,
  buildSyncPlanVirtualOffsets,
  buildSyncPlanVirtualWindow,
  buildSyncPendingDisplayRows,
  buildSyncViewContentKey,
  fitDirectoryTail,
  EasySyncSyncView,
  countOmittedSyncHistorySuccessfulFiles,
  formatFileProgressLabel,
  formatPendingIssueChipLabel,
  groupBundleConflictReviews,
  groupPendingIssuesForReview,
  formatSyncHistoryCounts,
  collectBatchConflictItems,
  isBatchedConflictSet,
  isBatchedDeleteSet,
  isConflictBatchExcludedPath,
  isDecisionRowKey,
  resolveDecisionRowDefaultOpen,
  isPlanReviewRefreshedSinceShown,
  collectHistorySkipRows,
  partitionCompletedProgressRows,
  resolveCompletedActionCount,
  resolveFileProgressPresentation,
  resolvePlanReviewDetailsState,
  resolveRemoteScopeRecoveryFailurePresentation,
  resolveSyncViewBodyMode,
  resolveSyncViewPrimaryAction,
  resolveSyncViewProgressPanelVisibility,
  resolveSyncViewStatusDetailMode,
  resolveSyncViewStatusDetailText,
  shouldExpandAllVisibleDetails,
  shouldAutoRebuildPlanReview,
  sharedFolderIdentityConfirmLines,
  SYNC_PLAN_VIRTUAL_OVERSCAN,
  syncViewProgressPercent,
  trimFilePathPrefix,
} from "../src/ui/sync-view";
import { I18n } from "../src/i18n";
import en from "../src/i18n/en";
import zhCN from "../src/i18n/zh-cn";
import { SyncActionType } from "../src/sync/types";
import type { SyncPlanItem } from "../src/sync/types";
import { ConfirmModal } from "../src/ui/confirm-modal";
import { formatFileSize } from "../src/ui/file-comparison-modal";
import { functionBody, readSourceFile } from "./helpers/source-scope";

interface FakeHistoryElement {
  tag: string;
  className: string;
  text: string;
  open: boolean;
  children: FakeHistoryElement[];
  createDiv(className?: string): FakeHistoryElement;
  createSpan(className?: string): FakeHistoryElement;
  createEl(tag: string, className?: string): FakeHistoryElement;
  setText(text: string): FakeHistoryElement;
  addEventListener(type: string, handler: () => void): void;
  readonly firstElementChild: FakeHistoryElement | null;
  listeners: Record<string, Array<() => void>>;
}

function createFakeHistoryElement(
  tag = "div",
  className = "",
): FakeHistoryElement {
  const element: FakeHistoryElement = {
    tag,
    className,
    text: "",
    open: false,
    children: [],
    createDiv(childClass = "") {
      const child = createFakeHistoryElement("div", childClass);
      this.children.push(child);
      return child;
    },
    createSpan(childClass = "") {
      const child = createFakeHistoryElement("span", childClass);
      this.children.push(child);
      return child;
    },
    createEl(childTag, childClass = "") {
      const child = createFakeHistoryElement(childTag, childClass);
      this.children.push(child);
      return child;
    },
    setText(text) {
      this.text = text;
      return this;
    },
    listeners: {},
    addEventListener(type: string, handler: () => void) {
      (this.listeners[type] ??= []).push(handler);
    },
    get firstElementChild() {
      return this.children[0] ?? null;
    },
  };
  return element;
}

function collectFakeHistoryText(element: FakeHistoryElement): string[] {
  return [
    ...(element.text ? [element.text] : []),
    ...element.children.flatMap(collectFakeHistoryText),
  ];
}

/** Minimal DOM stand-in for the adaptive path pass: rows, path children,
 *  sibling order and the two box metrics the layout reads. */
class FakeAdaptivePathElement {
  className: string;
  textContent = "";
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => undefined };
  clientWidth = 40;
  left = 10;
  rectCalls = 0;
  children: FakeAdaptivePathElement[] = [];
  parentElement: FakeAdaptivePathElement | null = null;

  constructor(className = "") {
    this.className = className;
  }

  get classList(): {
    contains(name: string): boolean;
    add(name: string): void;
  } {
    return {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => {
        if (!this.className.split(/\s+/).includes(name)) {
          this.className = `${this.className} ${name}`.trim();
        }
      },
    };
  }

  get scrollWidth(): number {
    return this.textContent.length * 10;
  }

  get previousElementSibling(): FakeAdaptivePathElement | null {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return index > 0 ? parent.children[index - 1] : null;
  }

  get nextElementSibling(): FakeAdaptivePathElement | null {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return index >= 0 && index + 1 < parent.children.length
      ? parent.children[index + 1]
      : null;
  }

  setText(text: string): this {
    this.textContent = text;
    return this;
  }

  setAttribute(): void {
    // aria-hidden and friends are irrelevant to the measured geometry.
  }

  getBoundingClientRect(): { left: number } {
    this.rectCalls++;
    return { left: this.left };
  }

  createDiv(className = ""): FakeAdaptivePathElement {
    const child = new FakeAdaptivePathElement(className);
    // A gray-directory prefix fits without tail truncation in these fixtures.
    child.clientWidth = 400;
    child.left = 0;
    this.appendChild(child);
    return child;
  }

  appendChild(child: FakeAdaptivePathElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  prepend(child: FakeAdaptivePathElement): void {
    child.parentElement = this;
    this.children.unshift(child);
  }

  before(node: FakeAdaptivePathElement): void {
    const parent = this.parentElement;
    if (!parent) return;
    // Mirror DOM `before`: move an already-parented node instead of cloning it.
    const existingIndex = parent.children.indexOf(node);
    if (existingIndex >= 0) parent.children.splice(existingIndex, 1);
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 0, node);
    node.parentElement = parent;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  querySelector(selector: string): FakeAdaptivePathElement | null {
    if (selector !== ".easy-sync-adaptive-path") return null;
    return this.children.find((child) =>
      child.classList.contains("easy-sync-adaptive-path")) ?? null;
  }
}

function createFakePathRow(path: string): {
  row: FakeAdaptivePathElement;
  pathEl: FakeAdaptivePathElement;
} {
  const row = new FakeAdaptivePathElement(
    "easy-sync-file-row easy-sync-path-layout-item",
  );
  const pathEl = new FakeAdaptivePathElement(
    "easy-sync-file-path easy-sync-adaptive-path",
  );
  pathEl.dataset.easySyncFullPath = path;
  pathEl.setText(path);
  row.appendChild(pathEl);
  return { row, pathEl };
}

function createBareSyncView(): EasySyncSyncView {
  const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
  Object.assign(view as object, {
    adaptivePathRowStates: new WeakMap(),
    adaptivePathScopeStates: new WeakMap(),
    adaptivePathTextWidths: new Map(),
    adaptivePathDirectoryTexts: new Map(),
    adaptivePathMonospaceAdvances: new Map(),
    adaptivePathProbe: null,
    adaptivePathProbeFontKey: null,
  });
  return view;
}

describe("syncViewProgressPercent", () => {
  it("keeps sidebar file-count progress separate from floating byte-folded progress", () => {
    expect(syncViewProgressPercent({
      phase: "executing",
      current: 3,
      total: 12,
      currentFile: "large.bin",
      currentItemBytes: 50,
      currentItemTotalBytes: 100,
      currentItemComplete: false,
      cancelRequested: false,
      completedFiles: [],
      completedCount: 0,
      startedAt: 1,
    })).toBe(25);
  });
});

describe("configuration-skip rows stay out of the completed counts", () => {
  const row = (
    path: string,
    actionType: SyncActionType | undefined,
  ) => ({
    path,
    status: "skip" as const,
    actionType,
  });

  it("partitions size/ignored-path skips away from real completed rows", () => {
    const rows = partitionCompletedProgressRows([
      row("big.mp4", SyncActionType.SkipLargeFile),
      row("note.md", SyncActionType.Upload),
      row("ignored.md", SyncActionType.SkipIgnoredPath),
      row("bad?.md", SyncActionType.SkipOneDriveInvalidName),
    ]);
    expect(rows.action.map((entry) => entry.path)).toEqual([
      "note.md",
      "bad?.md",
    ]);
    expect(rows.skipped.map((entry) => entry.path)).toEqual([
      "big.mp4",
      "ignored.md",
    ]);
  });

  it("reports the completed subtitle count without the zero-action skips", () => {
    const state = {
      phase: "executing" as const,
      current: 2,
      total: 2,
      currentFile: "",
      currentItemBytes: 0,
      currentItemTotalBytes: 0,
      cancelRequested: false,
      completedFiles: [
        row("note.md", SyncActionType.Upload),
        row("big.mp4", SyncActionType.SkipLargeFile),
        row("big-2.mp4", SyncActionType.SkipLargeFile),
      ],
      // The retained row list caps successes, so the true total lives here.
      completedCount: 3,
      startedAt: 1,
    };
    expect(resolveCompletedActionCount(state)).toBe(1);
    // 非法文件名是真实用户行动（改名），照常计数。
    expect(resolveCompletedActionCount({
      ...state,
      completedFiles: [
        ...state.completedFiles,
        row("bad?.md", SyncActionType.SkipOneDriveInvalidName),
      ],
      completedCount: 4,
    })).toBe(2);
    // 只有跳过行时不出现负值。
    expect(resolveCompletedActionCount({
      ...state,
      completedFiles: [row("big.mp4", SyncActionType.SkipLargeFile)],
      completedCount: 1,
    })).toBe(0);
  });
});

describe("history keeps the skip list every round", () => {
  const skipRow = (path: string) => ({
    path,
    status: "skip" as const,
    actionType: SyncActionType.SkipLargeFile,
  });

  it("rebuilds the fold from retained paths when the round emitted no rows", () => {
    // 2026-10-25 拍板：运行列表只报新面孔，历史每条记录都能展开同一份清单。
    const result = collectHistorySkipRows({
      files: [],
      skipPaths: ["video.mp4", "podcast.m4a"],
      total: 2,
    });
    expect(result.rows.map((entry) => entry.path)).toEqual([
      "video.mp4",
      "podcast.m4a",
    ]);
    expect(result.rows.every((entry) => entry.actionType === SyncActionType.SkipLargeFile))
      .toBe(true);
    expect(result.total).toBe(2);
    expect(result.omitted).toBe(0);
  });

  it("keeps emitted rows and dedupes the retained paths against them", () => {
    const result = collectHistorySkipRows({
      files: [skipRow("video.mp4"), { path: "note.md", status: "upload" as const, actionType: SyncActionType.Upload }],
      skipPaths: ["video.mp4", "podcast.m4a"],
      total: 2,
    });
    expect(result.rows.map((entry) => entry.path)).toEqual([
      "video.mp4",
      "podcast.m4a",
    ]);
    // 上传行不混进跳过折叠组。
    expect(result.rows.some((entry) => entry.path === "note.md")).toBe(false);
  });

  it("reports the round's true total and the omitted remainder", () => {
    const result = collectHistorySkipRows({
      files: [],
      skipPaths: ["a.mp4", "b.mp4"],
      total: 5,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.omitted).toBe(3);
    // 老条目没有 skipPaths：只有发行过的行能显示，总数缺席时不报省略。
    expect(collectHistorySkipRows({ files: [skipRow("old.mp4")], skipPaths: undefined }))
      .toEqual({ rows: [skipRow("old.mp4")], total: 1, omitted: 0 });
  });
});

describe("shared sidebar detail controls", () => {
  it("collapses nested missing-local folder issues into one root review", () => {
    const issue = (path: string, issueCode?: "anchored-folder-missing-local") => ({
      path,
      actionType: SyncActionType.FolderDeferred,
      issueCode,
      updatedAt: 1,
    });
    const grouped = groupPendingIssuesForReview([
      issue("Issues/CAD", "anchored-folder-missing-local"),
      issue("Other"),
      issue("Issues", "anchored-folder-missing-local"),
      issue("Issues/CAD/Parts", "anchored-folder-missing-local"),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ issue: { path: "Other" } });
    expect(grouped[1]).toMatchObject({
      issue: { path: "Issues" },
      nestedIssues: [
        { path: "Issues/CAD" },
        { path: "Issues/CAD/Parts" },
      ],
    });
  });

  it("builds pending display rows in display order with stable keys and retryable flags", () => {
    const issue = (path: string, actionType: SyncActionType) => ({
      path,
      actionType,
      issueCode: undefined,
      updatedAt: 1,
    });
    const rows = buildSyncPendingDisplayRows({
      adoptionRows: [{ pluginId: "resp", displayName: "Resojot", desktopOnly: false }],
      failures: [{ issue: issue("a.md", SyncActionType.Upload), nestedIssues: [] }],
      conflictEntries: [
        { kind: "file" as const, item: { type: SyncActionType.Conflict, path: "c.md" } },
        {
          kind: "bundle" as const,
          pluginId: "resp",
          items: [{ type: SyncActionType.Conflict, path: ".obsidian/plugins/resp/main.js" }],
        },
      ],
      pendingDeletes: [
        { type: SyncActionType.ConfirmLocalDelete, path: "d1.md" },
        { type: SyncActionType.ConfirmLocalDelete, path: "d2.md" },
      ],
      skipped: [{ issue: issue("big.bin", SyncActionType.SkipLargeFile), nestedIssues: [] }],
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "adoption",
      "issue",
      "conflict",
      "pluginConflict",
      "batchDelete",
      "delete",
      "delete",
      "issue",
    ]);
    expect(rows[0].key).toBe("adoption:resp");
    expect(rows[1].key).toBe(`issue:${SyncActionType.Upload}::a.md`);
    expect(rows[1].retryable).toBe(true);
    expect(rows[2].key).toBe("conflict:c.md");
    expect(rows[3].key).toBe("plugin:resp");
    expect(rows[4].key).toBe("batch-delete");
    expect(rows[4].deletes).toHaveLength(2);
    expect(rows[5].key).toBe("delete:d1.md");
    expect(rows[6].key).toBe("delete:d2.md");
    expect(rows[7].key).toBe(`issue:${SyncActionType.SkipLargeFile}::big.bin`);
    expect(rows[7].retryable).toBe(false);
  });

  it("omits the batch delete row unless more than one delete is pending", () => {
    const rows = buildSyncPendingDisplayRows({
      adoptionRows: [],
      failures: [],
      conflictEntries: [],
      pendingDeletes: [{ type: SyncActionType.ConfirmLocalDelete, path: "only.md" }],
      skipped: [],
    });
    expect(rows.map((row) => row.kind)).toEqual(["delete"]);
  });

  it("windows the pending section with the shared decision-row machinery", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const sectionStart = source.indexOf("private renderPendingSection");
    const sectionEnd = source.indexOf("private renderPendingRow(", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    expect(section).toContain("buildSyncPendingDisplayRows(");
    expect(section).toContain("easy-sync-plan-virtual-list");
    expect(section).toContain("buildSyncPlanVirtualWindow(");
    expect(section).toContain("planDecisionRowsInFlight.has(row.key)");
    expect(section).toContain("this.planVirtualRenderers.add(renderPendingWindow)");
    expect(section).toContain("applyPlanRowExpansionIn(visible, this.renderedBatchedRows)");
    expect(section).toContain("isBatchedDeleteSet(rows.map((row) => row.key))");
    // 件②：本机独有条目族走同一判据（成批时逐条行默认收起，出口是批量行）。
    expect(section).toContain("isBatchedLocalOnlySet(");
    expect(section).not.toContain("for (const item of pendingDeletes) this.renderDeleteItem");
  });

  it("groups each bundle — community plugin or EasySync's own files — into one review row", () => {
    const conflict = (path: string) => ({
      type: SyncActionType.Conflict,
      path,
    });
    const grouped = groupBundleConflictReviews([
      conflict(".obsidian/plugins/resojot/main.js"),
      conflict("note.md"),
      conflict(".obsidian/plugins/resojot/manifest.json"),
      conflict(".obsidian/plugins/resojot/styles.css"),
      conflict(".obsidian/plugins/easy-sync/main.js"),
      conflict(".obsidian/plugins/easy-sync/manifest.json"),
      conflict(".obsidian/plugins/easy-sync/styles.css"),
      conflict(".obsidian/plugins/resojot/data.json"),
    ], ".obsidian");

    // EasySync 自己的三份插件文件同样按 bundle 合成一行（社区插件与本机自身
    // 各一行），其余普通冲突与 data.json 仍是逐条 file 行。
    expect(grouped.map((entry) => entry.kind)).toEqual([
      "bundle",
      "file",
      "bundle",
      "file",
    ]);
    expect(grouped[0]).toMatchObject({
      kind: "bundle",
      pluginId: "resojot",
      items: [
        { path: ".obsidian/plugins/resojot/main.js" },
        { path: ".obsidian/plugins/resojot/manifest.json" },
        { path: ".obsidian/plugins/resojot/styles.css" },
      ],
    });
    // EasySync 自身的三件套同样合成一行：用户在待处理区看到的是「EasySync
    // 自己的文件」，而不是三条看不懂的配置路径。
    expect(grouped[2]).toMatchObject({
      kind: "bundle",
      pluginId: "easy-sync",
      items: [
        { path: ".obsidian/plugins/easy-sync/main.js" },
        { path: ".obsidian/plugins/easy-sync/manifest.json" },
        { path: ".obsidian/plugins/easy-sync/styles.css" },
      ],
    });
    // 同目录下的非三件套文件（data.json）不受整包吸收。
    expect(grouped[3]).toMatchObject({
      kind: "file",
      item: { path: ".obsidian/plugins/resojot/data.json" },
    });
  });

  it("uses the current visible state to choose the next global action", () => {
    expect(shouldExpandAllVisibleDetails([true, true])).toBe(false);
    expect(shouldExpandAllVisibleDetails([true, false])).toBe(true);
    expect(shouldExpandAllVisibleDetails([false, false])).toBe(true);
  });

  it("uses one human-readable file-size contract across comparison modals", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("resolves decision rows by class default, then session override, then the row's own choice", () => {
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      sessionOverride: "default",
      planRowExpandedState: new Map<string, boolean>(),
    });
    const state = (
      view as unknown as { planRowExpandedState: Map<string, boolean> }
    ).planRowExpandedState;
    const decide = (
      view as unknown as {
        resolvePlanRowOpen(
          key: string,
          batchedRows: {
            deleteRowsBatched: boolean;
            localOnlyRowsBatched: boolean;
          },
        ): boolean;
      }
    ).resolvePlanRowOpen.bind(view);
    const batched = (
      deleteRowsBatched: boolean,
      localOnlyRowsBatched = false,
    ) => ({ deleteRowsBatched, localOnlyRowsBatched });

    // 类别默认：决策行展开（出口第一眼可见），只读行折叠。
    expect(decide("conflict:a.md", batched(false))).toBe(true);
    expect(decide("plugin:resp", batched(false))).toBe(true);
    expect(decide("adoption:resp", batched(false))).toBe(true);
    expect(decide("issue:download:timeout:a.md", batched(false))).toBe(false);
    // 成批的待确认删除默认收起（出口是批量入口），单条时展开。
    expect(decide("delete:a.md", batched(false))).toBe(true);
    expect(decide("delete:a.md", batched(true))).toBe(false);
    // 件② 同一规则搬到本机独有条目族：成批（≥2 条）时逐条默认收起。
    expect(decide("localOnly:a.md", batched(false))).toBe(true);
    expect(decide("localOnly:a.md", batched(false, true))).toBe(false);
    // 更新提示行（2026-10-28 拍板）：默认展开，避免「去更新」藏在折叠里。
    expect(decide("update:available", batched(false))).toBe(true);

    // 行级手势压过类别默认。
    state.set("conflict:a.md", false);
    expect(decide("conflict:a.md", batched(false))).toBe(false);
    state.set("issue:download:timeout:a.md", true);
    expect(decide("issue:download:timeout:a.md", batched(false))).toBe(true);
    // 用户手动收起的更新提示行，重建后不回弹。
    state.set("update:available", false);
    expect(decide("update:available", batched(false))).toBe(false);

    // 会话级覆盖压过类别默认，但压不过行级手势。
    Object.assign(view as object, { sessionOverride: "expanded" });
    expect(decide("issue:download:timeout:b.md", batched(false))).toBe(true);
    expect(decide("conflict:a.md", batched(false))).toBe(false);
    Object.assign(view as object, { sessionOverride: "collapsed" });
    expect(decide("conflict:b.md", batched(false))).toBe(false);
    expect(decide("delete:a.md", batched(false))).toBe(false);
  });

  it("keeps the session override and the row-class default as separate facts", () => {
    // 成批删除的判据与批量删除入口同一条件；只读行不进决策行集合。
    expect(isBatchedDeleteSet(["delete:a.md"])).toBe(false);
    expect(isBatchedDeleteSet(["delete:a.md", "delete:b.md"])).toBe(true);
    expect(isBatchedDeleteSet(["conflict:a.md", "delete:a.md"])).toBe(false);
    expect(isDecisionRowKey("conflict:a.md")).toBe(true);
    expect(isDecisionRowKey("delete:a.md")).toBe(true);
    expect(isDecisionRowKey("plugin:resp")).toBe(true);
    expect(isDecisionRowKey("adoption:resp")).toBe(true);
    expect(isDecisionRowKey("update:available")).toBe(true);
    expect(isDecisionRowKey("issue:upload:timeout:a.md")).toBe(false);
    expect(isDecisionRowKey("row:Upload:a.md")).toBe(false);
    expect(isDecisionRowKey("batch-delete")).toBe(false);
  });

  it("registers every collapsible details site with its fold class", () => {
    // 折叠体系准入（2026-09-23）：新增可折叠面必须同时登记〔类别／默认态依据／
    // 记忆粒度／覆盖与重置〕，否则这里会红——站点按「所在函数＋创建时类名」登记，
    // 类别语义见 docs/topics/侧栏 UI - 文件列表.md「决策行窗口化与展开记忆」节。
    const registry: Record<string, string> = {
      "renderConflictItem|easy-sync-tree-item": "decision",
      "renderDeleteItem|easy-sync-tree-item": "decision",
      "renderAdoptionItem|easy-sync-tree-item": "decision",
      "renderBundleConflictItem|easy-sync-tree-item": "decision",
      "renderPendingIssue|easy-sync-tree-item": "decision",
      "renderLocalOnlyItem|easy-sync-tree-item": "decision",
      "createTreeGroup|easy-sync-tree-item": "container",
      "renderMutationRecoverySection|easy-sync-tree-item easy-sync-recovery-details": "readonly",
      "renderHistorySection|easy-sync-history-run easy-sync-tree-item": "readonly",
      // 运行中列表与历史条目共用的「按设置跳过」折叠件（2026-10-25 拍板）：
      // 站点随共享化移到 createSkipFold，类别与默认态不变。
      "createSkipFold|easy-sync-history-skip-group easy-sync-tree-item": "readonly",
      // 更新提示行 2026-10-28 起按决策行族默认展开（出口只在折叠里）。
      "renderUpdateAvailableItem|easy-sync-tree-item": "decision",
      "measurePlanDecisionRowHeights|easy-sync-tree-item easy-sync-plan-decision-probe": "probe",
    };
    const source = readSourceFile("src/ui/sync-view.ts");
    const found: string[] = [];
    for (const match of source.matchAll(/createEl\(\s*"details"/g)) {
      const at = match.index ?? 0;
      const window = source.slice(at + match[0].length, at + 240);
      const cls = /(?:cls:\s*)?"([^"]+)"/.exec(window)?.[1] ?? "?";
      const declarations = [
        ...source.slice(0, at).matchAll(/\n  (?:private |public )?(?:readonly )?(?:async )?([A-Za-z0-9_]+)\(/g),
      ];
      const fn = declarations[declarations.length - 1]?.[1] ?? "?";
      found.push(`${fn}|${cls}`);
    }
    expect(found.sort()).toEqual(Object.keys(registry).sort());
    // 决策行站点必须真的带行身份（否则展开记忆与默认态都没有锚点）。
    for (const site of found.filter((entry) => registry[entry] === "decision")) {
      const fn = site.split("|")[0];
      const start = source.indexOf(`private ${fn}(`);
      expect(source.slice(start, start + 1600)).toContain("details.dataset.easySyncPlanRow = rowKey");
    }
  });

  it("renders recovery files through the standard row and disclosure contract", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const start = source.indexOf("  private renderMutationRecoverySection(");
    const end = source.indexOf("\n  private appendRecoveryFileRow(", start);
    const section = source.slice(start, end);
    expect(section).toContain("displayedPaths.length === 1");
    expect(section).toContain("easy-sync-recovery-details");
    expect(section).toContain("easy-sync-file-list easy-sync-path-layout");
    expect(section).toContain("easy-sync-tree-label");
    expect(section).toContain('t("syncView.recovery.details")');
    expect(section).toContain("syncView.recovery.openAccountSettings");
    expect(section).toContain("this.plugin.openPluginSettings()");
    expect(section).not.toContain("easy-sync-recovery-subject");
    expect(section).not.toContain("easy-sync-recovery-facts");
    expect(section).not.toContain("createSkipFold");
  });

  it("does not let a new plan revision wipe the user's explicit global choice", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const revisionStart = source.indexOf(
      "if (this.renderedPlanReviewRevision !== syncState.planReviewRevision) {",
    );
    const revisionBlock = source.slice(revisionStart, revisionStart + 900);
    // 修订变化只清行级／组级记忆（行身份不再指同一对象），会话级覆盖保持。
    expect(revisionBlock).toContain("this.planGroupExpandedState.clear()");
    expect(revisionBlock).toContain("this.planRowExpandedState.clear()");
    expect(revisionBlock).not.toContain("sessionOverride");

    // 默认态下工具栏不得铺开或收起任何东西：类别默认说了算。
    const toggleStart = source.indexOf("private toggleAllDetails()");
    const toggleBody = source.slice(toggleStart, toggleStart + 700);
    expect(toggleBody).toContain('if (this.sessionOverride === "default") return;');

    // 分组头的类别默认＝含决策项就展开，而不是一律折叠。
    const groupStart = source.indexOf("private resolvePlanGroupOpen(");
    const groupBody = source.slice(groupStart, groupStart + 500);
    expect(groupBody).toContain("return hasDecisionRows;");
  });

  it("records a decision row's open state from the user's gesture, not the toggle event", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const toggleStart = source.indexOf("private readonly handlePathLayoutToggle");
    const intentStart = source.indexOf("private readonly handlePlanRowToggleIntent");
    const resizeStart = source.indexOf("private readonly handlePathLayoutResize");
    const toggleHandler = source.slice(toggleStart, intentStart);
    const intentHandler = source.slice(intentStart, resizeStart);

    // `toggle` also fires for our own programmatic writes
    // (applyPlanRowExpansionIn, toggleAllDetails), so recording there pins rows
    // the user never touched.
    expect(toggleHandler).not.toContain("rememberPlanRowExpansion");
    expect(toggleHandler).toContain("this.updateCollapseTogglePresentation()");
    // A summary click is the only user driver of a <details> state change.
    expect(intentHandler).toContain('target.closest("summary")');
    expect(intentHandler).toContain("this.rememberPlanRowExpansion(key, !host.open)");
  });
});

describe("sync view status copy and scrolling layout", () => {
  it("keeps expanded history details subordinate to the summary with host UI tokens", () => {
    const styles = readSourceFile("styles.css");

    expect(styles).toMatch(
      /\.easy-sync-history-detail\s*\{[^}]*font-size:\s*var\(--font-ui-smaller\);[^}]*line-height:\s*var\(--line-height-tight\);/s,
    );
    expect(styles).not.toMatch(
      /\.easy-sync-history-detail\s*\{[^}]*(?:font-size|line-height):\s*\d+(?:\.\d+)?(?:px|rem|em);/s,
    );
  });

  it("keeps upgrade, recovery, and unavailable-state copy concise and factual", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("syncPlan.detailsUnavailable"))
      .toBe("暂时无法显示同步计划明细。");
    expect(en.t("syncPlan.detailsUnavailable"))
      .toBe("Sync plan details are temporarily unavailable.");
    expect(zh.t("syncPlan.restoringDetails")).toBe("正在恢复计划明细");
    expect(zh.t("syncPlan.restoreDetails")).toBe("恢复计划明细");
    expect(zh.t("syncPlan.remoteScopeRecreateSummary"))
      .toBe("原云端同步目录无法继续使用。确认后重新创建目录并核对内容。");
    expect(en.t("syncPlan.remoteScopeRecreateSummary"))
      .toContain("previous cloud sync folder");
    expect(zh.t("result.remoteReadUnavailable"))
      .toBe("暂时连不上云端，本轮没有同步任何文件；网络恢复后会自动重试。");
    expect(en.t("result.remoteReadUnavailable"))
      .toBe("The cloud is temporarily unreachable, so nothing was synced this round. EasySync will retry automatically once the connection recovers.");
    // 2026-09-15 文案减负 R-1：云端状态读取失败两键并一，旧键必须已删除。
    expect(zh.t("result.sharedControlReadUnavailable"))
      .toBe("result.sharedControlReadUnavailable");
    expect(zh.t("result.ordinaryRemoteReadUnavailable"))
      .toBe("result.ordinaryRemoteReadUnavailable");
    // 2026-09-15 文案减负 R-2：冲突下载失败提示去掉通用兜底尾句。
    expect(zh.t("notice.conflict.downloadFailed"))
      .toBe("未能下载云端版本，本次未作更改；请稍后重试。");
    expect(en.t("notice.conflict.downloadFailed"))
      .toBe("The cloud version could not be downloaded, so nothing was changed. Try again later.");
    expect(zh.t("syncView.history.noFileChanges"))
      .toBe("本轮没有文件变更。");
    expect(en.t("syncView.history.noFileChanges"))
      .toBe("No files changed in this sync.");

    const source = readSourceFile("src/ui/sync-view.ts");
    expect(source).not.toContain("CommunityPluginLegacyMigration");
    expect(source).not.toContain("syncView.communityPlugins.migration");
  });

  it("states unfinished-operation direction and details without engineering copy", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const zhDelete = zh.t("syncView.mutationResolution.deleteConfirmMessage", {
      choice: "保留当前本机",
      path: "note.md",
    });

    expect(zhDelete).toContain("在所选一侧不存在");
    expect(zhDelete).toContain("删除另一侧现有的副本");
    expect(zh.t("syncView.mutationResolution.previousAction", { action: "上传本机文件" }))
      .toBe("上次操作：上传本机文件");
    expect(en.t("syncView.mutationResolution.previousAction", { action: "Upload local file" }))
      .toBe("Previous operation: Upload local file");
    expect(zh.t("syncView.mutationResolution.present", { size: "1.0 KB" }))
      .toBe("1.0 KB");
    expect(en.t("syncView.mutationResolution.present", { size: "1.0 KB" }))
      .toBe("1.0 KB");
    expect(zh.t("syncView.mutationResolution.technicalDetails")).toBe("查看技术详情");
    expect(en.t("syncView.mutationResolution.technicalDetails")).toBe("View technical details");
    expect([
      zh.t("syncView.mutationResolution.unavailable"),
      zh.t("notice.mutationResolution.unavailable"),
      en.t("syncView.mutationResolution.unavailable"),
      en.t("notice.mutationResolution.unavailable"),
    ].join("\n")).not.toMatch(/安全归并|reduced safely|verification evidence/);

    const modalSource = readSourceFile("src/ui/mutation-recovery-resolution-modal.ts");
    expect(modalSource).toContain("formatFileSize(fact.size ?? 0)");
    expect(modalSource).not.toContain(")：${");
  });

  it("separates empty-folder situations from actions without exposing folder internals", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const modalSource = readSourceFile("src/ui/empty-folder-resolution-modal.ts");

    expect([
      zh.t("syncView.emptyFolder.deleteUnavailableDescription"),
      zh.t("syncView.emptyFolder.deleteDescription"),
    ].join("\n")).not.toMatch(/版本凭据|身份和版本/);
    expect([
      en.t("syncView.emptyFolder.deleteUnavailableDescription"),
      en.t("syncView.emptyFolder.deleteDescription"),
    ].join("\n")).not.toMatch(/folder version|identity and version/i);
    // The delete option is the single destructive confirmation (2026-09-29 拍板)：
    // the consequence sentence that used to live in the second gate must stay
    // visible on the option itself.
    expect(zh.t("syncView.emptyFolder.deleteDescription"))
      .toContain("影响其他设备看到的云端内容");
    expect(zh.t("syncView.emptyFolder.deleteDescription"))
      .toContain("仍为空且没有变化");
    expect(en.t("syncView.emptyFolder.deleteDescription"))
      .toContain("other devices");
    expect(en.t("syncView.emptyFolder.deleteDescription"))
      .toContain("still empty and unchanged");
    expect(modalSource).toContain(
      '.setName(this.t("syncView.emptyFolder.restoreTitle"))',
    );
    expect(modalSource).toContain(
      '.setButtonText(this.t("syncView.emptyFolder.restore"))',
    );
    expect(modalSource).toContain(
      '.setName(this.snapshot.remoteETag\n        ? this.t("syncView.emptyFolder.delete")',
    );
    expect(modalSource).toContain(
      '.setButtonText(this.t("syncView.emptyFolder.deleteConfirm"))',
    );
    expect(zh.t("syncView.folderSubtree.review")).toBe("核对文件夹");
    expect(zh.t("syncView.folderSubtree.description", { path: "问题" }))
      .toContain("上次同步确认的云端内容");
    expect(en.t("syncView.folderSubtree.description", { path: "Issues" }))
      .toContain("cloud contents confirmed by the last sync");
    expect([
      zh.t("syncView.folderSubtree.deleteUnavailableDescription"),
      en.t("syncView.folderSubtree.deleteUnavailableDescription"),
    ].join("\n")).not.toMatch(/版本凭据|version proof/i);
    expect(modalSource).toContain('if ("members" in this.snapshot)');
    expect(modalSource).toContain('this.renderSubtreeReview(contentEl)');
    expect(modalSource).toContain(
      '.setName(this.t("syncView.folderSubtree.restoreTitle"))',
    );
    expect(modalSource).toContain(
      '.setButtonText(this.t("syncView.folderSubtree.restore"))',
    );
    expect(modalSource).toContain(
      '.setName(root?.remoteETag\n        ? this.t("syncView.folderSubtree.deleteTitle")',
    );
    expect(modalSource).toContain(
      '.setButtonText(this.t("syncView.folderSubtree.delete"))',
    );
    expect(zh.t("syncView.folderLocation.resolve")).toBe("选择位置");
    expect(zh.t("syncView.folderLocation.description", { path: "原文件夹" }))
      .toContain("请选择同步后使用的位置");
    expect(en.t("syncView.folderLocation.description", { path: "Original" }))
      .toContain("Choose the location to use after syncing");
    expect(modalSource).toContain('if ("localPath" in this.snapshot)');
    expect(modalSource).toContain('this.renderLocationReview(contentEl)');
    expect(modalSource).toContain(
      '.setButtonText(this.t("syncView.folderLocation.keepLocal"))',
    );
    expect(modalSource).toContain(
      '.setButtonText(this.t("syncView.folderLocation.keepRemote"))',
    );
    expect([
      zh.t("syncView.folderLocation.title"),
      zh.t("syncView.folderLocation.description", { path: "原文件夹" }),
      en.t("syncView.folderLocation.title"),
      en.t("syncView.folderLocation.description", { path: "Original" }),
    ].join("\n")).not.toMatch(/锚点|身份|eTag|anchor|identity/i);
  });

  it("keeps empty-folder and subtree deletion at a single confirmation gate", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const start = source.indexOf("  private async openEmptyFolderResolution(");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\n  private ", start + 1);
    const method = source.slice(start, end < 0 ? undefined : end);
    // 2026-09-29 拍板：第一层弹框的红键即最终授权，不再叠第二道 ConfirmModal；
    // 删前核对与版本门由执行链独立承担（评审后远端变化即不删、零 mutation）。
    expect(method).not.toContain("ConfirmModal");
    expect(method).toContain(
      "this.plugin.deleteReviewedEmptyRemoteFolder(snapshot)",
    );
    expect(method).toContain(
      "this.plugin.deleteReviewedFolderSubtree(subtree)",
    );
  });

  it("explains same-content copies through the existing cloud-location decision", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("reason.renameIdentityAmbiguous"))
      .toBe("发现多个内容相同的文件，请选择是否保留云端原位置。");
    expect(en.t("reason.renameIdentityAmbiguous"))
      .toBe("Multiple files have the same content. Choose whether to keep the original cloud location.");
  });

  it("keeps verification copy and the adjacent item count non-duplicative", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("progress.verifyingFiles", { current: 2, total: 5 }))
      .toBe("验证文件一致性…");
    // 量词「项」是 2026-07-11 用户要求，2026-10-27 决定恢复；验证文案本身不带计数。
    expect(zh.t("syncView.progress.items", { current: 2, total: 5 }))
      .toBe("2/5项");
    expect(zh.t("syncView.progress.items", { current: 32, total: 2001 }))
      .toBe("32/2001项");
    expect(en.t("progress.verifyingFiles", { current: 2, total: 5 }))
      .toBe("Verifying file consistency…");
    expect(en.t("syncView.progress.items", { current: 2, total: 5 }))
      .toBe("2/5 items");
  });

  it("removes the in-flight badge everywhere it used to live", () => {
    const view = readSourceFile("src/ui/sync-view.ts");
    const styles = readSourceFile("styles.css");
    const executor = readSourceFile("src/sync/sync-executor.ts");

    // 2026-10-27 用户拍板：未经批准加的「处理中 N」整块回退，不留空容器、
    // 不留只被它读取的计数。
    expect(view).not.toContain("easy-sync-status-inflight");
    expect(view).not.toContain("inFlightBadgeEl");
    expect(view).not.toContain("updateInFlightBadge");
    expect(styles).not.toContain(".easy-sync-status-inflight");
    expect(executor).not.toContain("inFlightItemCount");
    expect(executor).not.toContain("inFlightItems");
    for (const locale of [zhCN, en]) {
      expect(Object.keys(locale)).not.toContain("syncView.progress.inFlight");
    }
  });

  it("renders the speed chip only when the sampler has a quotable reading", () => {
    // 用户拍板 2026-10-27：底部连接速度不准确就不显示。采样不足时整块不渲染，
    // 连空容器都不留——隐藏态就是「从来没有过读数」的既有布局。
    const makeContainer = () => {
      const children: Array<{ className: string }> = [];
      const container = {
        children,
        createDiv(className = "") {
          const child = {
            className,
            style: {} as Record<string, string>,
            textContent: "",
            createSpan(spanClass = "") {
              const span = {
                className: spanClass,
                textContent: "",
                setText(value: string) {
                  this.textContent = value;
                  return this;
                },
              };
              return span;
            },
            addClass() {
              return child;
            },
            removeClass() {
              return child;
            },
            setText(value: string) {
              child.textContent = value;
              return child;
            },
          };
          children.push(child);
          return child;
        },
      };
      return container;
    };
    const render = (reading: { level: string; kbps: number | null } | null) => {
      const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
      Object.assign(view as object, {
        // Prototype-only harness bypasses the constructor's default; give the
        // view the desktop UI-mode fact explicitly (the injected seam this
        // slice introduced).
        platformFacts: { isMobile: false },
        plugin: {
          i18n: new I18n("zh-cn"),
          getTransferRateReading: () => reading,
        },
      });
      const container = makeContainer();
      (view as unknown as {
        renderTransferRateFooter: (target: unknown) => void;
      }).renderTransferRateFooter(container);
      return container;
    };

    expect(render(null).children).toHaveLength(0);
    const shown = render({ level: "medium", kbps: 512 });
    expect(shown.children).toHaveLength(1);
    expect(shown.children[0].className).toBe("easy-sync-transfer-rate");
  });

  it("takes the speed chip away instead of leaving an empty slot", () => {
    // 读数过期时走的是移除节点，不是留一个空壳/占位；布局回到没有读数的常态。
    const removed: string[] = [];
    const indicator = {
      remove: () => {
        removed.push("chip");
      },
    };
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      contentEl: {
        querySelector: (selector: string) =>
          selector === ".easy-sync-transfer-rate" ? indicator : null,
      },
      plugin: {
        i18n: new I18n("zh-cn"),
        getTransferRateReading: () => null,
      },
    });
    (view as unknown as { refreshTransferRateValue: () => void })
      .refreshTransferRateValue();
    expect(removed).toEqual(["chip"]);
  });

  it("reserves no space for the speed chip when it is absent", () => {
    // 隐藏不得留下空位：载体本身没有预留高度，也没有为隐藏态保留盒子的规则
    // （移动端 is-hidden 用 display:none；is-anchor-pending 的 visibility 只
    // 服务首次锚定前的待命，不属于隐藏读数）。
    const styles = readSourceFile("styles.css");
    const baseRule = styles.match(/^\.easy-sync-transfer-rate \{[^}]*\}/m)?.[0] ?? "";
    expect(baseRule).not.toBe("");
    expect(baseRule).not.toMatch(/min-height|height:/);
    expect(styles).toContain(
      "body.is-mobile .easy-sync-transfer-rate.is-mobile-footer.is-hidden {\n  display: none;\n}",
    );
  });

  it("shows the user-checkable facts before the same-folder question", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const snapshot = {
      path: ".obsidian/plugins",
      summary: {
        localFiles: 12,
        localFolders: 3,
        remoteFiles: 11,
        remoteFolders: 3,
        sameNameFiles: 10,
        sameSizeFiles: 8,
        localOnlyFiles: 2,
        remoteOnlyFiles: 1,
        previouslySyncedFiles: 12,
      },
    };

    expect(zh.t("syncView.sharedFolderIdentity.resolve")).toBe("查看");
    expect(zh.t("syncView.sharedFolderIdentity.confirmTitle"))
      .toBe("确认文件夹身份");
    expect(sharedFolderIdentityConfirmLines(snapshot, zh.t.bind(zh))).toEqual([
      "“.obsidian/plugins”未登记，无法自动匹配。",
      "本机共 12 个文件 / 3 个文件夹，云端共 11 个文件 / 3 个文件夹。",
      "同名文件 10 个，其中 8 个大小一致。",
      "本机独有 2 个，云端独有 1 个。",
      "本机曾同步过 12 个文件。",
      "请确认是同一文件夹后继续。",
    ]);
    expect(en.t("syncView.sharedFolderIdentity.resolve")).toBe("Review");
    expect(en.t("syncView.sharedFolderIdentity.confirmTitle"))
      .toBe("Confirm folder identity");
    expect(sharedFolderIdentityConfirmLines(snapshot, en.t.bind(en))).toEqual([
      "“.obsidian/plugins” is not registered, so EasySync cannot match it automatically.",
      "This device has 12 files / 3 folders; the cloud has 11 files / 3 folders.",
      "10 files have the same name on both sides; 8 of them are the same size.",
      "Only on this device: 2; only in the cloud: 1.",
      "12 files here were synced before.",
      "Confirm they are the same folder to continue.",
    ]);
    expect(zh.t("notice.sharedFolderIdentity.failed", {
      path: ".obsidian/plugins",
      reason: "raw-provider-error",
    })).not.toContain("raw-provider-error");
    expect(en.t("notice.sharedFolderIdentity.failed", {
      path: ".obsidian/plugins",
      reason: "raw-provider-error",
    })).not.toContain("raw-provider-error");
  });

  it("adds the empty-side warnings only when one side holds nothing", () => {
    const zh = new I18n("zh-cn");
    const snapshot = {
      path: "Clippings",
      summary: {
        localFiles: 0,
        localFolders: 0,
        remoteFiles: 4,
        remoteFolders: 0,
        sameNameFiles: 0,
        sameSizeFiles: 0,
        localOnlyFiles: 0,
        remoteOnlyFiles: 4,
        previouslySyncedFiles: 0,
      },
    };

    expect(sharedFolderIdentityConfirmLines(snapshot, zh.t.bind(zh))).toEqual([
      "“Clippings”未登记，无法自动匹配。",
      "本机共 0 个文件 / 0 个文件夹，云端共 4 个文件 / 0 个文件夹。",
      "同名文件 0 个，其中 0 个大小一致。",
      "本机独有 0 个，云端独有 4 个。",
      "本机文件夹是空的。",
      "请确认是同一文件夹后继续。",
    ]);
  });

  it("keeps stale-identity retirement state-only and hides raw failures", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const zhMessage = zh.t("syncView.staleIdentity.fileMessage", {
      path: "Notes/a.md",
    });
    const enMessage = en.t("syncView.staleIdentity.fileMessage", {
      path: "Notes/a.md",
    });

    expect(zh.t("syncView.staleIdentity.resolve"))
      .toBe("保留双方并重新对账");
    expect(zhMessage).toContain("继续只会解除这条失效的历史身份");
    expect(zhMessage).toContain("不会上传、下载、覆盖或删除任何文件");
    expect(en.t("syncView.staleIdentity.resolve"))
      .toBe("Keep both and reconcile");
    expect(enMessage).toContain("only detaches that stale historical identity");
    expect(enMessage).toContain("does not upload, download, overwrite, or delete");
    expect(zh.t("notice.staleIdentity.failed", {
      path: "Notes/a.md",
      reason: "raw-provider-error",
    })).not.toContain("raw-provider-error");
    expect(en.t("notice.staleIdentity.failed", {
      path: "Notes/a.md",
      reason: "raw-provider-error",
    })).not.toContain("raw-provider-error");
  });

  it("keeps the sidebar toolbar and primary action fixed above one independent content scroller", () => {
    const styles = readSourceFile("styles.css");
    const desktopViewBlock = styles.match(
      /body:not\(\.is-mobile\) \.view-content\.easy-sync-view\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    const toolbarBlock = styles.match(
      /body:not\(\.is-mobile\) \.view-content\.easy-sync-view > \.nav-header\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    const mobileViewBlock = styles.match(
      /body\.is-mobile \.view-content\.easy-sync-view\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    const mobileToolbarBlock = styles.match(
      /body\.is-mobile \.view-content\.easy-sync-view > \.nav-header\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    const desktopContentBlock = styles.match(
      /body:not\(\.is-mobile\) \.easy-sync-view-content\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    const statusBlock = styles.match(
      /\.easy-sync-status-panel\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    const mobileStatusBlock = styles.match(
      /body\.is-mobile \.view-content\.easy-sync-view > \.easy-sync-status-panel\s*\{([^}]*)\}/s,
    )?.[1] ?? "";
    const darkMobileStatusBlock = styles.match(
      /body\.theme-dark\.is-mobile \.view-content\.easy-sync-view > \.easy-sync-status-panel\s*\{([^}]*)\}/s,
    )?.[1] ?? "";

    expect(desktopViewBlock).toContain("display: flex");
    expect(desktopViewBlock).toContain("flex-direction: column");
    expect(desktopViewBlock).toContain("overflow: hidden");
    expect(toolbarBlock).toContain("position: sticky");
    expect(toolbarBlock).toContain("top: 0");
    expect(toolbarBlock).toContain("background: transparent");
    expect(mobileViewBlock).toContain("padding-bottom: max(var(--safe-area-inset-bottom), var(--size-4-8))");
    expect(mobileViewBlock).not.toMatch(/background(?:-color)?:/);
    expect(mobileToolbarBlock).not.toMatch(/background(?:-color)?:/);
    expect(desktopContentBlock).toContain("flex: 1 1 auto");
    expect(desktopContentBlock).toContain("min-height: 0");
    expect(desktopContentBlock).toContain("overflow-y: auto");
    expect(statusBlock).toContain("flex: 0 0 auto");
    expect(statusBlock).not.toMatch(/background(?:-color)?:/);
    expect(mobileStatusBlock).toContain("position: sticky");
    expect(mobileStatusBlock).toContain("top: 0");
    expect(mobileStatusBlock).toContain("z-index: 1");
    expect(mobileStatusBlock).toContain(
      "background-color: var(--mobile-sidebar-background, var(--background-primary))",
    );
    expect(darkMobileStatusBlock).toContain(
      "background-color: var(--mobile-sidebar-background, var(--background-secondary))",
    );
    expect(styles).not.toMatch(
      /body\.is-mobile \.view-content\.easy-sync-view > \.nav-header\s*\{[^}]*position:\s*sticky/s,
    );
    expect(styles).not.toMatch(
      /body\.is-mobile \.easy-sync-view-content\s*\{[^}]*overflow(?:-y)?:/s,
    );
  });

  it("never paints the host bottom action bar or disables its fade", () => {
    const styles = readSourceFile("styles.css");
    // 宿主抽屉底栏的渐隐是标准样式（2026-10-27 用户 iPhone 真机指认：官方文件
    // 列表与 EasySync 列表都带渐隐）。插件给 `.nav-buttons-container` 画实体底色
    // 会盖掉列表化进背景的过渡，关掉它的 ::after 更会把渐隐整条抹掉——2026-10-27
    // 一次误改正是这两条（已回退）。这里钉住：插件不得改底栏表面，也不得动宿主
    // 画在 `nav-buttons-container` / `workspace-leaf-content` 上的渐隐层。
    expect(styles).not.toMatch(
      /\.nav-buttons-container[^{]*\{[^}]*background(?:-color)?:/s,
    );
    expect(styles).not.toMatch(
      /\.nav-buttons-container[^{]*::after[^{]*\{[^}]*display:\s*none/s,
    );
    expect(styles).not.toMatch(
      /\.workspace-leaf-content[^{]*::after[^{]*\{[^}]*display:\s*none/s,
    );
  });
});

describe("buildSyncViewContentKey", () => {
  const baseInput = {
    isLoggedIn: false,
    isInitializing: false,
    isPending: false,
    isRunning: true,
    canCancel: false,
    syncEntryInProgress: false,
    bodyMode: "progress" as const,
    progress: {
      phase: "executing" as const,
      current: 1,
      total: 3,
      currentFile: "note.md",
      completedFiles: [],
      completedCount: 0,
      currentItemBytes: 0,
      currentItemTotalBytes: 0,
      cancelRequested: false,
    },
    planReviewActive: false,
    planReviewDetailsState: "ready" as const,
    pendingIssues: [],
    conflicts: [],
    pendingDeletes: [],
    communityPluginEnablementPending: 0,
    planReviewCounts: null,
    planReviewRevision: 0,
    history: [],
    lastSyncTime: 0,
    mutationRecovery: null,
  };

  it("changes when history is toggled even during a running sync", () => {
    const collapsed = buildSyncViewContentKey(false, baseInput);
    const expanded = buildSyncViewContentKey(true, baseInput);

    expect(collapsed).not.toBe(expanded);
    expect(collapsed).toContain("history:closed");
    expect(expanded).toContain("history:open:");
  });

  it("rebuilds when executing progress becomes determinate", () => {
    const withoutTotal = buildSyncViewContentKey(false, {
      ...baseInput,
      progress: {
        ...baseInput.progress,
        current: 0,
        total: 0,
        currentFile: "",
      },
    });
    const withTotal = buildSyncViewContentKey(false, {
      ...baseInput,
      progress: {
        ...baseInput.progress,
        current: 0,
        total: 3,
        currentFile: "",
      },
    });

    expect(withoutTotal).not.toBe(withTotal);
  });

  it("tracks resumable remote-scope verification even when all work is reused", () => {
    const withoutEvidence = buildSyncViewContentKey(false, {
      ...baseInput,
      progress: {
        ...baseInput.progress,
        phase: "checking",
        current: 0,
        total: 0,
        currentFile: "",
      },
    });
    const withEvidence = buildSyncViewContentKey(false, {
      ...baseInput,
      progress: {
        ...baseInput.progress,
        phase: "checking",
        current: 0,
        total: 0,
        currentFile: "",
        recoveryVerification: {
          operationFingerprint: "abcdef123456",
          protocolPreflight: "ready",
          total: 3,
          verifiedThisRun: 0,
          reused: 3,
          invalidated: 0,
          remaining: 0,
        },
      },
    });

    expect(withEvidence).not.toBe(withoutEvidence);
    expect(withEvidence).toContain("determinate");
    expect(withEvidence).toContain("abcdef123456:ready:3:0:3:0:0");
  });

  it("tracks history ids when the expanded list changes", () => {
    const empty = buildSyncViewContentKey(true, baseInput);
    const withEntry = buildSyncViewContentKey(true, {
      ...baseInput,
      history: [{
        id: "run-1",
        mode: "manual",
        status: "partial",
        startedAt: 1,
        endedAt: 2,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        skipped: 0,
        errors: 1,
        files: [],
      }],
    });

    expect(empty).not.toBe(withEntry);
    expect(withEntry).toContain("run-1");
  });

  it("refreshes expanded history when a persisted run message changes", () => {
    const entry = {
      id: "run-message",
      mode: "auto" as const,
      status: "failed" as const,
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 1,
      message: "first reason",
      files: [],
    };
    const first = buildSyncViewContentKey(true, {
      ...baseInput,
      history: [entry],
    });
    const updated = buildSyncViewContentKey(true, {
      ...baseInput,
      history: [{ ...entry, message: "updated reason" }],
    });

    expect(updated).not.toBe(first);
  });

  it("rebuilds a pending row when a stable resolution code appears", () => {
    const legacy = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [{
        path: "Notes",
        actionType: SyncActionType.FolderDeferred,
        reason: "folder missing",
        updatedAt: 1,
      }],
    });
    const actionable = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [{
        path: "Notes",
        actionType: SyncActionType.FolderDeferred,
        issueCode: "anchored-folder-missing-local",
        reason: "folder missing",
        updatedAt: 1,
      }],
    });

    expect(actionable).not.toBe(legacy);
    expect(actionable).toContain("anchored-folder-missing-local");
  });

  it("serializes provided pending issue groups instead of collapsing them", () => {
    const issue = {
      path: "Notes",
      actionType: SyncActionType.FolderDeferred,
      reason: "folder missing",
      updatedAt: 1,
    };
    const withGroups = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [],
      pendingIssueGroups: [{ issue, nestedIssues: [] }],
    });
    const withOtherGroups = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [],
      pendingIssueGroups: [{
        issue: { ...issue, path: "Archive" },
        nestedIssues: [],
      }],
    });
    const sameGroupsTwice = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [],
      pendingIssueGroups: [{ issue, nestedIssues: [] }],
    });

    expect(withGroups).not.toBe(withOtherGroups);
    expect(withGroups).toBe(sameGroupsTwice);
    expect(withGroups).not.toContain("[object Object]");
    expect(withGroups).toContain("folderDeferred::Notes:1:folder missing");
  });

  it("rebuilds a pending body when adoption rows appear, change, or retire", () => {
    const pendingBase = { ...baseInput, bodyMode: "pending" as const };
    const empty = buildSyncViewContentKey(false, {
      ...pendingBase,
      adoptionRows: [],
    });
    const withRow = buildSyncViewContentKey(false, {
      ...pendingBase,
      adoptionRows: [{
        pluginId: "calendar",
        displayName: "Calendar",
        desktopOnly: true,
      }],
    });
    const reflagged = buildSyncViewContentKey(false, {
      ...pendingBase,
      adoptionRows: [{
        pluginId: "calendar",
        displayName: "Calendar",
        desktopOnly: false,
      }],
    });

    expect(withRow).not.toBe(empty);
    expect(withRow).toContain("calendar");
    expect(reflagged).not.toBe(withRow);
    const retired = buildSyncViewContentKey(false, {
      ...pendingBase,
      adoptionRows: [],
    });
    expect(retired).toBe(empty);
  });

  it("rebuilds an unanchored shared-folder row for explicit identity review", () => {
    const legacy = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [{
        path: ".obsidian/plugins",
        actionType: SyncActionType.FolderDeferred,
        reason: "folder identity pending",
        updatedAt: 1,
      }],
    });
    const actionable = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [{
        path: ".obsidian/plugins",
        actionType: SyncActionType.FolderDeferred,
        issueCode: "unanchored-shared-folder",
        reason: "folder identity pending",
        updatedAt: 1,
      }],
    });

    expect(actionable).not.toBe(legacy);
    expect(actionable).toContain("unanchored-shared-folder");
  });

  it("rebuilds an active-forget folder row for explicit untracking", () => {
    const legacy = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [{
        path: "Notes",
        actionType: SyncActionType.FolderDeferred,
        reason: "rename evidence conflicts",
        updatedAt: 1,
      }],
    });
    const actionable = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "pending",
      pendingIssues: [{
        path: "Notes",
        actionType: SyncActionType.FolderDeferred,
        issueCode: "local-rename-evidence-conflict",
        reason: "rename evidence conflicts",
        updatedAt: 1,
      }],
    });

    expect(actionable).not.toBe(legacy);
    expect(actionable).toContain("local-rename-evidence-conflict");
  });

  it("changes when auth initialization finishes so the action button can rebuild", () => {
    const initializing = buildSyncViewContentKey(false, {
      ...baseInput,
      isInitializing: true,
      isLoggedIn: false,
      isRunning: false,
      progress: {
        ...baseInput.progress,
        phase: "idle",
      },
    });
    const ready = buildSyncViewContentKey(false, {
      ...baseInput,
      isInitializing: false,
      isLoggedIn: true,
      isRunning: false,
      progress: {
        ...baseInput.progress,
        phase: "idle",
      },
    });

    expect(initializing).not.toBe(ready);
    expect(initializing).toContain("auth:1:0");
    expect(ready).toContain("auth:0:1");
  });

  it("changes when login starts waiting for authorization so the account action can rebuild", () => {
    const loggedOut = buildSyncViewContentKey(false, {
      ...baseInput,
      isRunning: false,
      progress: {
        ...baseInput.progress,
        phase: "idle",
      },
    });
    const pending = buildSyncViewContentKey(false, {
      ...baseInput,
      isPending: true,
      isRunning: false,
      progress: {
        ...baseInput.progress,
        phase: "idle",
      },
    });

    expect(loggedOut).not.toBe(pending);
  });

  it("changes when a reviewed plan settles from running to paused so action buttons rebuild", () => {
    const runningPlan = buildSyncViewContentKey(false, {
      ...baseInput,
      isLoggedIn: true,
      isRunning: true,
      planReviewActive: true,
      bodyMode: "plan" as const,
      canCancel: true,
      planReviewCounts: {
        uploads: 1,
        downloads: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      planReviewRevision: 1,
    });
    const pausedPlan = buildSyncViewContentKey(false, {
      ...baseInput,
      isLoggedIn: true,
      isRunning: false,
      canCancel: false,
      planReviewActive: true,
      bodyMode: "plan" as const,
      progress: {
        ...baseInput.progress,
        phase: "done",
      },
      planReviewCounts: {
        uploads: 1,
        downloads: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      planReviewRevision: 1,
    });

    expect(runningPlan).not.toBe(pausedPlan);
    expect(runningPlan).toContain("run:1");
    expect(pausedPlan).toContain("run:0");
  });

  it("changes when an unfinished operation moves from network wait to a stable block", () => {
    const waiting = buildSyncViewContentKey(false, {
      ...baseInput,
      isLoggedIn: true,
      isRunning: false,
      bodyMode: "recovery",
      mutationRecovery: {
        kind: "waiting-network",
        total: 2,
        settled: 1,
        remaining: 1,
        retryAt: 1234,
        firstPath: "notes/a.md",
        blockReason: null,
      },
    });
    const blocked = buildSyncViewContentKey(false, {
      ...baseInput,
      isLoggedIn: true,
      isRunning: false,
      bodyMode: "recovery",
      mutationRecovery: {
        kind: "blocked",
        total: 2,
        settled: 1,
        remaining: 1,
        retryAt: null,
        firstPath: "notes/a.md",
        blockReason: "facts-changed",
      },
    });

    expect(waiting).not.toBe(blocked);
    expect(waiting).toContain("recovery:waiting-network");
    expect(blocked).toContain("recovery:blocked");
  });

  it("refreshes expanded history when one recovery event advances without changing its id", () => {
    const historyEntry = {
      id: "mutation-recovery-1",
      mode: "auto" as const,
      status: "partial" as const,
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
      files: [],
      recovery: {
        state: "waiting-network" as const,
        total: 2,
        settled: 0,
        remaining: 2,
        updatedAt: 2,
        retryAt: 100,
      },
    };
    const waiting = buildSyncViewContentKey(true, {
      ...baseInput,
      history: [historyEntry],
    });
    const recovered = buildSyncViewContentKey(true, {
      ...baseInput,
      history: [{
        ...historyEntry,
        status: "success",
        recovery: {
          state: "recovered",
          total: 2,
          settled: 2,
          remaining: 0,
          updatedAt: 3,
        },
      }],
    });

    expect(waiting).not.toBe(recovered);
    expect(recovered).toContain("recovered:2:2:0");
  });

  it("changes when a count-only folder review changes", () => {
    const oneFolder = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "plan",
      planReviewActive: true,
      planReviewCounts: {
        uploads: 0,
        downloads: 0,
        folders: 1,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
    });
    const twoFolders = buildSyncViewContentKey(false, {
      ...baseInput,
      bodyMode: "plan",
      planReviewActive: true,
      planReviewCounts: {
        uploads: 0,
        downloads: 0,
        folders: 2,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
    });

    expect(oneFolder).not.toBe(twoFolders);
  });

  it("keeps large plan keys bounded and refreshes by the persisted revision", () => {
    const plan = {
      ...baseInput,
      bodyMode: "plan" as const,
      planReviewActive: true,
      planReviewRevision: 7,
      planReviewCounts: {
        uploads: 50_000,
        downloads: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
    };
    const first = buildSyncViewContentKey(false, plan);
    const updated = buildSyncViewContentKey(false, {
      ...plan,
      planReviewRevision: 8,
    });

    expect(first.length).toBeLessThan(300);
    expect(first).toContain("revision:7");
    expect(updated).not.toBe(first);
  });

  it("keeps pending body mode while a side action is processing", () => {
    const waiting = buildSyncViewContentKey(false, {
      ...baseInput,
      isLoggedIn: true,
      isRunning: false,
      canCancel: false,
      bodyMode: "pending",
      progress: {
        ...baseInput.progress,
        phase: "idle",
      },
      conflicts: [{
        type: "conflict",
        path: "a.md",
      }],
    });
    const processing = buildSyncViewContentKey(false, {
      ...baseInput,
      isLoggedIn: true,
      isRunning: true,
      canCancel: false,
      bodyMode: "pending",
      conflicts: [{
        type: "conflict",
        path: "a.md",
      }],
    });

    expect(waiting).toContain("pending:");
    expect(processing).toContain("pending:");
    expect(processing).not.toContain("progress:");
    expect(waiting).not.toBe(processing);
    expect(processing).toContain("run:1:0");
  });

  it("only trims a path when the computed prefix actually matches", () => {
    expect(trimFilePathPrefix("Resojot Todo.md", "test/")).toBe("Resojot Todo.md");
    expect(trimFilePathPrefix("test/Resojot Todo.md", "test/")).toBe("Resojot Todo.md");
  });

  it("prepends only the new sibling row when a sibling appears later", () => {
    const existing = { path: "test/333333(4)-副本.md", status: "download" } as const;
    const initial = diffCompletedFileRows(new Map(), [existing]);
    const withSibling = diffCompletedFileRows(initial.nextLedger, [
      existing,
      { path: "test/444444.md", status: "download" },
    ]);

    expect(initial.prepend.map((file) => file.path)).toEqual([
      "test/333333(4)-副本.md",
    ]);
    expect(withSibling.prepend.map((file) => file.path)).toEqual([
      "test/444444.md",
    ]);
    expect(withSibling.removePaths).toEqual([]);
  });

  it("removes and re-prepends a path when the same path changes action type", () => {
    const created = diffCompletedFileRows(new Map(), [{
      path: "Folder",
      status: "folder",
      actionType: SyncActionType.CreateRemoteFolder,
    }] as never);
    const moved = diffCompletedFileRows(created.nextLedger, [{
      path: "Folder",
      status: "folder",
      actionType: SyncActionType.MoveRemoteFolder,
    }] as never);

    expect(moved.prepend).toHaveLength(1);
    expect(moved.prepend[0].actionType).toBe(SyncActionType.MoveRemoteFolder);
    expect(moved.removePaths).toEqual(["Folder"]);
  });

  it("mounts only the newest completed page and counts the rest", () => {
    const files = Array.from({ length: 350 }, (_, index) => ({
      path: `f-${index}.md`,
      status: "upload",
    })) as never[];
    const display = selectCompletedDisplayRows(files);
    expect(display.rows).toHaveLength(300);
    expect(display.rows[0].path).toBe("f-349.md");
    expect(display.rows[299].path).toBe("f-50.md");
    expect(display.omitted).toBe(50);

    const deduped = selectCompletedDisplayRows([
      { path: "a.md", status: "error" },
      { path: "b.md", status: "upload" },
      { path: "a.md", status: "upload" },
    ] as never[]);
    expect(deduped.rows.map((file) => file.path)).toEqual(["a.md", "b.md"]);
    expect(deduped.omitted).toBe(0);
  });

  it("renders the newest completed page with a summary row", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const render = source.slice(
      source.indexOf("private renderFileResults("),
      source.indexOf("private updateCompletedOmittedRow("),
    );
    expect(render).toContain("selectCompletedDisplayRows(files)");
    expect(render).toContain("this.updateCompletedOmittedRow(display.omitted, t)");
    expect(source).toContain('t("syncView.progress.omitted"');
  });

  it("keeps retained rows untouched when nothing changed", () => {
    const files = [
      { path: "a.md", status: "download" },
      { path: "b.md", status: "upload" },
    ] as never[];
    const initial = diffCompletedFileRows(new Map(), files);
    const again = diffCompletedFileRows(initial.nextLedger, files);

    expect(again.prepend).toEqual([]);
    expect(again.removePaths).toEqual([]);
    expect([...again.nextLedger.entries()]).toEqual([
      ...initial.nextLedger.entries(),
    ]);
  });

  it("drops only the row that fell off the retention cap", () => {
    const initial = diffCompletedFileRows(new Map(), [
      { path: "old.md", status: "download" },
      { path: "mid.md", status: "upload" },
      { path: "new.md", status: "download" },
    ] as never);
    const afterCap = diffCompletedFileRows(initial.nextLedger, [
      { path: "mid.md", status: "upload" },
      { path: "new.md", status: "download" },
      { path: "latest.md", status: "upload" },
    ] as never);

    expect(afterCap.prepend.map((file) => file.path)).toEqual(["latest.md"]);
    expect(afterCap.removePaths).toEqual(["old.md"]);
  });

  it("renders the newest occurrence once when a path completes twice", () => {
    const diff = diffCompletedFileRows(new Map(), [
      { path: "twice.md", status: "download" },
      { path: "twice.md", status: "upload" },
    ] as never);

    expect(diff.prepend).toHaveLength(1);
    expect(diff.prepend[0].status).toBe("upload");
  });

  it("keeps failure rows in the diff without cap filtering", () => {
    const diff = diffCompletedFileRows(new Map(), [
      { path: "failed.md", status: "error", reason: "timeout" },
    ] as never);

    expect(diff.prepend).toHaveLength(1);
    expect(diff.prepend[0].status).toBe("error");
    expect(diff.removePaths).toEqual([]);
  });

  it("keeps incremental append order, partition and dedup equal to the full render", () => {
    const files = [
      { path: "skip.bin", status: "skip", actionType: SyncActionType.SkipLargeFile },
      { path: "notes/a.md", status: "download" },
      { path: "notes/b.md", status: "upload" },
      { path: "notes/a.md", status: "error", reason: "timeout" },
    ] as never;
    const fullRenderOrder = (rows: readonly Record<string, unknown>[]) => {
      const seen = new Set<string>();
      const order: string[] = [];
      for (let index = rows.length - 1; index >= 0; index--) {
        const path = String(rows[index].path);
        if (seen.has(path)) continue;
        seen.add(path);
        order.push(path);
      }
      return order;
    };
    const rows = partitionCompletedProgressRows(files);
    const action = diffCompletedFileRows(new Map(), rows.action);
    const skipped = diffCompletedFileRows(new Map(), rows.skipped);

    // Full `renderFileResults` walks the source array backwards (newest
    // first), dedups by path and renders directly. The light path must agree
    // in partition, dedup and final order for both lists.
    expect(action.prepend.map((file) => file.path)).toEqual(
      fullRenderOrder(rows.action as never),
    );
    expect(skipped.prepend.map((file) => file.path)).toEqual(
      fullRenderOrder(rows.skipped as never),
    );
    expect(action.prepend.find((file) => file.path === "notes/a.md")?.status)
      .toBe("error");
    expect(action.prepend.map((file) => file.path)).toEqual([
      "notes/a.md",
      "notes/b.md",
    ]);
    expect(skipped.prepend.map((file) => file.path)).toEqual(["skip.bin"]);
  });

  it("maps completed rows to one short result chip without losing exact action facts", () => {
    const zh = new I18n("zh-cn");
    const renamed = resolveFileProgressPresentation({
      status: "folder",
      actionType: SyncActionType.MoveRemoteFolder,
      path: "Projects/New name",
      sourcePath: "Projects/Old name",
    });
    const moved = resolveFileProgressPresentation({
      status: "folder",
      actionType: SyncActionType.MoveLocalFolder,
      path: "Archive/New name",
      sourcePath: "Projects/Old name",
    });

    expect(renamed.labelKey && zh.t(renamed.labelKey)).toBe("重命名");
    expect(moved.labelKey && zh.t(moved.labelKey)).toBe("移动");
    expect(formatFileProgressLabel({
      status: "error",
      actionType: SyncActionType.MoveRemoteFolder,
      path: "Projects/New name",
      sourcePath: "Projects/Old name",
    }, zh.t.bind(zh))).toBe("失败");
  });

  it("covers the full completed-file chip vocabulary and global exclusions", () => {
    const zh = new I18n("zh-cn");
    const label = (
      file: Parameters<typeof formatFileProgressLabel>[0],
    ) => formatFileProgressLabel(file, zh.t.bind(zh));

    expect(label({ path: "a.md", status: "upload", actionType: SyncActionType.Upload })).toBe("上传");
    expect(label({ path: "a.md", status: "download", actionType: SyncActionType.Download })).toBe("下载");
    for (const actionType of [
      SyncActionType.CreateRemoteFolder,
      SyncActionType.CreateLocalFolder,
    ]) {
      expect(label({ path: "Folder", status: "folder", actionType })).toBe("创建");
    }
    for (const actionType of [
      SyncActionType.MoveRemoteFolder,
      SyncActionType.MoveLocalFolder,
      SyncActionType.RenameRemote,
      SyncActionType.MoveLocalFile,
    ]) {
      const status = actionType === SyncActionType.MoveLocalFile
        ? "download"
        : actionType === SyncActionType.RenameRemote
          ? "upload"
          : "folder";
      expect(label({
        path: "Parent/New.md",
        sourcePath: "Parent/Old.md",
        status,
        actionType,
      })).toBe("重命名");
      expect(label({
        path: "New/New.md",
        sourcePath: "Old/Old.md",
        status,
        actionType,
      })).toBe("移动");
    }
    for (const actionType of [
      SyncActionType.DeleteRemoteFolder,
      SyncActionType.DeleteLocalFolder,
      SyncActionType.DeleteRemote,
      SyncActionType.DeleteLocal,
    ]) {
      expect(label({ path: "a.md", status: "delete", actionType })).toBe("删除");
    }
    expect(label({ path: "a.md", status: "error", actionType: SyncActionType.Upload })).toBe("失败");
    expect(label({ path: "a.md", status: "conflict", actionType: SyncActionType.Conflict })).toBe("冲突");
    expect(label({
      path: "a.md",
      status: "conflict",
      actionType: SyncActionType.ConfirmLocalDelete,
    })).toBe("待确认");
    for (const actionType of [
      SyncActionType.RetryLater,
      SyncActionType.FolderDeferred,
    ]) {
      expect(label({ path: "a.md", status: "error", actionType })).toBe("未同步");
    }
    for (const actionType of [
      SyncActionType.SkipLargeFile,
      SyncActionType.SkipIgnoredPath,
    ]) {
      expect(label({ path: "a.md", status: "skip", actionType })).toBe("跳过");
    }

    expect(label({
      path: ".easy-sync",
      status: "folder",
      actionType: SyncActionType.RecreateRemoteScope,
    })).toBeNull();
    expect(label({
      path: "a.md",
      status: "error",
      actionType: SyncActionType.AuthExpired,
    })).toBeNull();
    expect(label({ path: "Legacy", status: "folder" })).toBeNull();
    expect(label({
      path: "New/New.md",
      status: "download",
      actionType: SyncActionType.MoveLocalFile,
    })).toBeNull();
    expect(label({
      path: "a.md",
      status: "delete",
      actionType: SyncActionType.ConfirmLocalDelete,
    })).toBe("删除");
    expect(label({
      path: "a.md",
      status: "skip",
      actionType: SyncActionType.Conflict,
    })).toBeNull();
  });

  it("maps pending issues by outcome instead of repeating the attempted action", () => {
    const zh = new I18n("zh-cn");
    const label = (type: SyncActionType) =>
      formatPendingIssueChipLabel({ actionType: type }, zh.t.bind(zh));

    expect(label(SyncActionType.Upload)).toBe("失败");
    expect(label(SyncActionType.FolderDeferred)).toBe("未同步");
    expect(formatPendingIssueChipLabel({
      actionType: SyncActionType.FolderDeferred,
      issueCode: "one-way-folder-retained",
    }, zh.t.bind(zh))).toBe("未同步");
    expect(label(SyncActionType.RetryLater)).toBe("未同步");
    expect(label(SyncActionType.SkipLargeFile)).toBe("跳过");
    expect(label(SyncActionType.SkipIgnoredPath)).toBe("跳过");
    expect(label(SyncActionType.AuthExpired)).toBeNull();
  });

  it("renders no per-row generic retry affordance for issue rows", () => {
    // 2026-09-16 按钮清理：行内「重新检查/再次同步」与顶部主动作完全等同
    // （同一 startManualSync，轮中仅得 busy 提示）——重试统一走顶部；
    // 延后类行由自动轮次收敛。标签分叉函数随 chip 一并退役。
    const source = readSourceFile("src/ui/sync-view.ts");
    expect(source).not.toContain("formatPendingIssueActionLabel");
    expect(source).not.toContain('"syncView.issues.retry"');
    expect(source).not.toContain('"syncView.issues.recheck"');
  });

  it("explains a folder scope crossing as a safe user action", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");

    expect(zh.t("reason.folder.scope-crossing")).toBe(
      "这个文件夹被移动、删除，或已不在当前同步设置中。为避免误删，EasySync 已暂停处理；请确认文件夹位置和同步设置后重新检查。",
    );
    expect(en.t("reason.folder.scope-crossing")).toBe(
      "This folder was moved, deleted, or is no longer included by the current sync settings. EasySync paused it to prevent unintended deletion; confirm the folder location and sync settings, then check again.",
    );
  });

  it("extracts gray directories only for measured overflow with real benefit", () => {
    const measured = (
      paths: string[],
      availableWidth: number,
      width = (text: string) => text.length * 10,
    ) => buildAdaptivePathLayout(paths.map((path) => ({
      path,
      availableWidth,
      measureTextWidth: width,
    })));

    expect(measured([
      "Projects/Alpha/one.md",
      "Projects/Alpha/two.md",
    ], 120)).toEqual([
      { displayPath: "one.md", directory: "Projects/Alpha/", directoryKind: "shared" },
      { displayPath: "two.md", directory: null, directoryKind: null },
    ]);

    expect(measured([
      "Projects/Alpha/one.md",
      "Projects/Alpha/two.md",
    ], 400)).toEqual([
      { displayPath: "Projects/Alpha/one.md", directory: null, directoryKind: null },
      { displayPath: "Projects/Alpha/two.md", directory: null, directoryKind: null },
    ]);

    expect(measured([
      "Archive/2026/July/long-name.md",
    ], 140)).toEqual([
      { displayPath: "long-name.md", directory: "Archive/2026/July/", directoryKind: "isolated" },
    ]);

    expect(measured(["Folder/long-name.md"], 80)).toEqual([
      { displayPath: "Folder/long-name.md", directory: null, directoryKind: null },
    ]);

    expect(measured([
      "A/one.md",
      "B/two.md",
      "A/three.md",
    ], 50)).toEqual([
      { displayPath: "A/one.md", directory: null, directoryKind: null },
      { displayPath: "B/two.md", directory: null, directoryKind: null },
      { displayPath: "A/three.md", directory: null, directoryKind: null },
    ]);

    expect(measured([
      "Projects/Alpha/one.md",
      "Projects/Alpha/two.md",
    ], 120, () => 200)).toEqual([
      { displayPath: "Projects/Alpha/one.md", directory: null, directoryKind: null },
      { displayPath: "Projects/Alpha/two.md", directory: null, directoryKind: null },
    ]);
  });

  it("keeps the deepest directory segments when the gray prefix does not fit", () => {
    // 用户 2026-09-24 报告：头部省略号留住的只是各库相同的浅层根前缀，
    // 路径越深灰字行越无信息，退化成「稍宽的空格」却仍占一行。截断必须
    // 从浅层头切起，保住最区分位置的深层尾。
    const width = (text: string) => text.length * 10;

    // 放得下 → 原样。
    expect(fitDirectoryTail("Projects/Alpha/", 200, width)).toBe(
      "Projects/Alpha/",
    );
    // 放不下 → 保深层尾，头部以 …/ 标记被截的浅层段。
    expect(fitDirectoryTail("Projects/2026/July/", 150, width)).toBe(
      "…/2026/July/",
    );
    // 更窄 → 尾部层段递减到放得下为止。
    expect(fitDirectoryTail("Projects/2026/July/", 80, width)).toBe("…/July/");
    // 连最深一段都放不下 → 原样返回，交给 CSS 头部省略号兜底。
    expect(fitDirectoryTail("Projects/2026/July/", 30, width)).toBe(
      "Projects/2026/July/",
    );
    // 单层目录没有可让出的头 → 原样返回。
    expect(fitDirectoryTail("Notes/", 50, width)).toBe("Notes/");
    // 零宽/负宽 → 原样返回。
    expect(fitDirectoryTail("Projects/", 0, width)).toBe("Projects/");

    // 接线：目录元素渲染必须套用保尾显示串（同一缓存量测域）。
    const source = readSourceFile("src/ui/sync-view.ts");
    const scopeStart = source.indexOf("private applyAdaptivePathLayoutScope(");
    const scopeEnd = source.indexOf("private appendNewFileRows(", scopeStart);
    const scope = source.slice(scopeStart, scopeEnd);
    expect(scope).toContain("this.fitAdaptiveDirectoryText(");
    expect(scope).toContain("directory.clientWidth");
    expect(scope).toContain("measureAdaptiveDirectoryText(");
  });

  it("only re-measures newly appended rows for adaptive path layout", () => {
    const scope = new FakeAdaptivePathElement(
      "easy-sync-file-list easy-sync-path-layout",
    );
    const existing = createFakePathRow("Projects/Alpha/old.md");
    scope.appendChild(existing.row);

    const view = createBareSyncView();
    const layout = (view as unknown as {
      applyAdaptivePathLayoutScope(scope: HTMLElement): void;
    }).applyAdaptivePathLayoutScope.bind(view);
    layout(scope as unknown as HTMLElement);
    const existingText = existing.pathEl.textContent;
    const existingMeasurements = existing.pathEl.rectCalls;

    const first = createFakePathRow("Projects/Alpha/one.md");
    const second = createFakePathRow("Projects/Alpha/two.md");
    // Same insertion order as appendCompletedActionRows: bottom-up prepend.
    scope.prepend(second.row);
    scope.prepend(first.row);
    layout(scope as unknown as HTMLElement);

    // Existing rows are not touched at all: no forced layout, no text rewrite.
    expect(existing.pathEl.rectCalls).toBe(existingMeasurements);
    expect(existing.pathEl.textContent).toBe(existingText);
    // Only the new rows were measured (and their extraction proves it).
    expect(first.pathEl.rectCalls).toBeGreaterThan(0);
    expect(second.pathEl.rectCalls).toBeGreaterThan(0);
    // All three now share the same prefix, so one directory sits above the
    // first row and every row is trimmed against it.
    expect(
      scope.children[0].classList.contains("easy-sync-path-directory"),
    ).toBe(true);
    expect(scope.children[0].textContent).toBe("Projects/Alpha/");
    expect(first.pathEl.textContent).toBe("one.md");
    expect(second.pathEl.textContent).toBe("two.md");
    expect(existing.pathEl.textContent).toBe("old.md");
    // The gray directory is a sibling, so the row order stays untouched.
    expect(
      scope.children.filter((child) =>
        child.classList.contains("easy-sync-file-row")),
    ).toEqual([first.row, second.row, existing.row]);
  });

  it("lays out a closed details scope only after it opens", () => {
    const scope = new FakeAdaptivePathElement(
      "easy-sync-file-list easy-sync-path-layout",
    );
    const row = createFakePathRow("Projects/Alpha/long-name.md");
    scope.appendChild(row.row);
    let closed = true;
    (scope as unknown as { closest(selector: string): unknown }).closest =
      (selector) => selector === "details:not([open])" && closed ? {} : null;

    const view = createBareSyncView();
    const layout = (view as unknown as {
      applyAdaptivePathLayoutScope(scope: HTMLElement): void;
    }).applyAdaptivePathLayoutScope.bind(view);
    layout(scope as unknown as HTMLElement);
    // A collapsed group is not measured: no directory, full path untouched.
    expect(scope.children).toHaveLength(1);
    expect(row.pathEl.textContent).toBe("Projects/Alpha/long-name.md");

    closed = false;
    layout(scope as unknown as HTMLElement);
    expect(
      scope.children[0].classList.contains("easy-sync-path-directory"),
    ).toBe(true);
    expect(row.pathEl.textContent).toBe("long-name.md");
  });

  it("plans the limited completed list in chunks and extends it on scroll", () => {
    const scope = new FakeAdaptivePathElement(
      "easy-sync-file-list is-limited easy-sync-path-layout",
    );
    (scope as unknown as { clientHeight: number }).clientHeight = 200;
    (scope as unknown as { scrollTop: number }).scrollTop = 0;
    const rows: Array<ReturnType<typeof createFakePathRow>> = [];
    for (let i = 0; i < 350; i++) {
      const row = createFakePathRow(`Projects/Alpha/file-${i}.md`);
      scope.appendChild(row.row);
      rows.push(row);
    }

    const view = createBareSyncView();
    const layout = (view as unknown as {
      applyAdaptivePathLayoutScope(scope: HTMLElement): void;
    }).applyAdaptivePathLayoutScope.bind(view);
    layout(scope as unknown as HTMLElement);
    // The newest chunk (300) is planned; the tail keeps its full path until
    // the list is scrolled, so one per-file pass stays bounded.
    expect(rows[0].pathEl.textContent).toBe("file-0.md");
    expect(rows[299].pathEl.textContent).toBe("file-299.md");
    expect(rows[349].pathEl.textContent).toBe("Projects/Alpha/file-349.md");

    (scope as unknown as { scrollTop: number }).scrollTop = 8_900;
    layout(scope as unknown as HTMLElement);
    expect(rows[349].pathEl.textContent).toBe("file-349.md");
  });

  it("drops a rewritten row's stale gray directory before laying it out", () => {
    const scope = new FakeAdaptivePathElement(
      "easy-sync-file-list easy-sync-path-layout",
    );
    const stale = new FakeAdaptivePathElement("easy-sync-path-directory");
    stale.setText("Projects/Alpha/");
    scope.appendChild(stale);
    const replacement = createFakePathRow("Archive/2026/July/long-name.md");
    scope.appendChild(replacement.row);

    const view = createBareSyncView();
    (view as unknown as {
      applyAdaptivePathLayoutScope(scope: HTMLElement): void;
    }).applyAdaptivePathLayoutScope(scope as unknown as HTMLElement);

    expect(scope.children).not.toContain(stale);
    expect(
      scope.children[0].classList.contains("easy-sync-path-directory"),
    ).toBe(true);
    expect(scope.children[0].textContent).toBe("Archive/2026/July/");
    expect(replacement.pathEl.textContent).toBe("long-name.md");
  });

  it("keeps a shared directory only while a row still uses it", () => {
    const sharedScope = new FakeAdaptivePathElement(
      "easy-sync-file-list easy-sync-path-layout",
    );
    const head = createFakePathRow("Projects/Alpha/one.md");
    const member = createFakePathRow("Projects/Alpha/two.md");
    sharedScope.appendChild(head.row);
    sharedScope.appendChild(member.row);

    const view = createBareSyncView();
    const layout = (view as unknown as {
      applyAdaptivePathLayoutScope(scope: HTMLElement): void;
    }).applyAdaptivePathLayoutScope.bind(view);
    layout(sharedScope as unknown as HTMLElement);
    expect(
      sharedScope.children[0].classList.contains("easy-sync-path-directory"),
    ).toBe(true);

    head.row.remove();
    layout(sharedScope as unknown as HTMLElement);
    // The remaining member is still trimmed against the same prefix, so exactly
    // one directory must remain above it instead of an orphan + a duplicate.
    expect(
      sharedScope.children.filter((child) =>
        child.classList.contains("easy-sync-path-directory")),
    ).toHaveLength(1);
    expect(sharedScope.children[0].textContent).toBe("Projects/Alpha/");
    expect(member.pathEl.textContent).toBe("two.md");

    const separateScope = new FakeAdaptivePathElement(
      "easy-sync-file-list easy-sync-path-layout",
    );
    const standalone = createFakePathRow("Archive/2026/July/one.md");
    separateScope.appendChild(standalone.row);
    layout(separateScope as unknown as HTMLElement);
    expect(
      separateScope.children.some((child) =>
        child.classList.contains("easy-sync-path-directory")),
    ).toBe(true);

    standalone.row.remove();
    layout(separateScope as unknown as HTMLElement);
    expect(
      separateScope.children.some((child) =>
        child.classList.contains("easy-sync-path-directory")),
    ).toBe(false);
  });

  it("re-plans an unchanged scope without forcing another layout", () => {
    const scope = new FakeAdaptivePathElement(
      "easy-sync-file-list easy-sync-path-layout",
    );
    const rows = [
      createFakePathRow("Projects/Alpha/one.md"),
      createFakePathRow("Projects/Beta/two.md"),
      createFakePathRow("Projects/Gamma/three.md"),
    ];
    for (const row of rows) scope.appendChild(row.row);

    const view = createBareSyncView();
    const layout = (view as unknown as {
      applyAdaptivePathLayoutScope(scope: HTMLElement): void;
    }).applyAdaptivePathLayoutScope.bind(view);
    layout(scope as unknown as HTMLElement);
    const measurements = rows.map((row) => row.pathEl.rectCalls);
    const texts = rows.map((row) => row.pathEl.textContent);
    const directories = scope.children.filter((child) =>
      child.classList.contains("easy-sync-path-directory")).length;

    layout(scope as unknown as HTMLElement);
    expect(rows.map((row) => row.pathEl.rectCalls)).toEqual(measurements);
    expect(rows.map((row) => row.pathEl.textContent)).toEqual(texts);
    expect(
      scope.children.filter((child) =>
        child.classList.contains("easy-sync-path-directory")),
    ).toHaveLength(directories);
  });

  it("shows and hides the completed summary row", () => {
    const list = new FakeAdaptivePathElement("easy-sync-file-list is-limited");
    const view = createBareSyncView();
    Object.assign(view as object, {
      fileListEl: list,
      completedOmittedRowEl: null,
    });
    const t = (key: string, params?: Record<string, string | number>) =>
      `${key}:${params?.count}`;
    const update = (view as unknown as {
      updateCompletedOmittedRow(
        omitted: number,
        translate: typeof t,
      ): void;
    }).updateCompletedOmittedRow.bind(view);

    update(5, t);
    expect(list.children).toHaveLength(1);
    expect(
      list.children[0].classList.contains("easy-sync-file-list-omitted"),
    ).toBe(true);
    expect(list.children[0].textContent).toBe("syncView.progress.omitted:5");

    update(0, t);
    expect(list.children).toHaveLength(0);
  });

  it("does not start path layout from window remounts or unbounded toggles", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const pending = source.slice(
      source.indexOf("private renderPendingSection("),
      source.indexOf("private renderPendingRow("),
    );
    expect(pending).not.toContain("scheduleAdaptivePathLayout");
    const plan = source.slice(
      source.indexOf("private renderPlanGroups("),
      source.indexOf("private measurePlanRowHeights("),
    );
    expect(plan).not.toContain("scheduleAdaptivePathLayout");
    const toggle = source.slice(
      source.indexOf("private readonly handlePathLayoutToggle"),
      source.indexOf("private readonly handlePlanRowToggleIntent"),
    );
    expect(toggle).toContain("applyAdaptivePathLayoutWithin(details)");
    const resize = source.slice(
      source.indexOf("private readonly handlePathLayoutResize"),
      source.indexOf("private readonly handlePlanViewportScroll"),
    );
    expect(resize).toContain("scheduleAdaptivePathLayoutAfterResize");
    expect(source).toContain("private scheduleAdaptivePathLayoutAfterResize(");
  });

  it("patches running progress numbers without rebuilding the view", () => {
    // 用户可见的症状：8 个并发在飞时计数整批跳（1→8→16），批内不动。修法不
    // 只是改计数，还要求每文件/每字节的更新走轻量路径——每 tick 整屏 empty()
    // 重建的话，提高事件频率只会更卡。这条用例直接断言：轻量路径改了顶部
    // 计数、进度条、当前文件名，并且没有调用整屏重建；状态行也不再多出
    // 「处理中 N」徽标（2026-10-27 用户拍板回退）。
    const prototype = EasySyncSyncView.prototype as unknown as {
      doRender: () => void;
      renderSyncViewFullRebuild: () => void;
      patchProgressOnly: () => void;
      appendNewFileRows: (files: unknown) => void;
      scheduleAdaptivePathLayout: () => void;
    };
    const doRender = vi.spyOn(prototype, "doRender").mockImplementation(() => undefined);
    const fullRebuild = vi
      .spyOn(prototype, "renderSyncViewFullRebuild")
      .mockImplementation(() => undefined);
    const appendRows = vi
      .spyOn(prototype, "appendNewFileRows")
      .mockImplementation(() => undefined);
    const layout = vi
      .spyOn(prototype, "scheduleAdaptivePathLayout")
      .mockImplementation(() => undefined);

    const makeEl = (text = "") => {
      const el = {
        textContent: text,
        dataset: {} as Record<string, string>,
        style: {} as Record<string, string>,
        children: [] as unknown[],
        removed: false,
        setText(next: string) {
          this.textContent = next;
          return this;
        },
        addClass() {
          return this;
        },
        removeClass() {
          return this;
        },
        empty() {
          this.children = [];
          return this;
        },
        createSpan(className = "") {
          const child = makeEl();
          (child as unknown as { className: string }).className = className;
          this.children.push(child);
          return child;
        },
        after(node: unknown) {
          this.children.push(node);
          return this;
        },
        remove() {
          this.removed = true;
          return this;
        },
      };
      return el;
    };

    const statusLine = makeEl();
    const statusText = makeEl("检查云端变更…");
    const counter = makeEl();
    const statusDetail = makeEl();
    const progressFill = makeEl();
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    const completed = [
      { path: "a.md", status: "upload", actionType: SyncActionType.Upload },
    ];
    Object.assign(view as object, {
      closed: false,
      lastContentKey: "progress:key",
      renderedBodyMode: "progress",
      contentEl: { querySelector: () => null } as unknown as HTMLElement,
      statusLineEl: statusLine,
      statusTextEl: statusText,
      statusCounterEl: counter,
      statusDetailEl: statusDetail,
      statusDetailMode: "current-file",
      currentFileTextEl: makeEl(),
      progressPanelEl: makeEl(),
      progressFillEl: progressFill,
      fileListEl: makeEl(),
      completedFileRowsLedger: new Map(),
      progressSubtitleEl: makeEl(),
      plugin: {
        i18n: new I18n("zh-cn"),
        // 8 concurrent items, 3 of 24 settled, one file mid-transfer.
        progressStore: {
          state: {
            phase: "executing",
            current: 3,
            total: 24,
            currentFile: "Notes/b.md",
            currentItemBytes: 0,
            currentItemTotalBytes: 0,
            currentItemComplete: false,
            cancelRequested: false,
            completedFiles: completed,
            completedCount: 1,
            startedAt: 1,
          },
        },
        syncExecutor: {
          isRunning: true,
          hasSideActionsInFlight: false,
        },
        syncDirection: "two-way",
        getMutationRecoveryDisplayState: () => null,
      },
    });

    try {
      (view as unknown as { patchProgressOnly: () => void }).patchProgressOnly();

      expect(doRender).not.toHaveBeenCalled();
      expect(fullRebuild).not.toHaveBeenCalled();
      // 顶部计数＝已结算/总量，就在原元素上改写（没有重建节点）。
      expect(counter.textContent).toBe("3/24项");
      expect(progressFill.style.width).toBe("13%");
      expect(
        (statusDetail as unknown as { children: Array<{ textContent: string }> })
          .children,
      ).toHaveLength(0);
      // 当前文件名落在既有槽位里；状态行没有追加任何第二个数字节点。
      const currentFile = (view as unknown as {
        currentFileTextEl: { textContent: string };
      }).currentFileTextEl;
      expect(currentFile.textContent).toBe("Notes/b.md");
      // 状态短语在轻量路径里同步刷新：执行期按 S4 边界落通用「正在同步」，
      // 不再带着上一阶段的「检查云端变更…」跑完整轮（2026-10-27 真机）。
      expect(statusText.textContent).toBe(
        new I18n("zh-cn").t("syncView.progress"),
      );
      expect((statusLine as unknown as { children: unknown[] }).children)
        .toHaveLength(0);
      expect(appendRows).toHaveBeenCalledWith(completed);
      // 完成行补进来时要量一次路径；但整屏布局重排不在这个路径里。
      expect(layout).toHaveBeenCalledTimes(0);
    } finally {
      doRender.mockRestore();
      fullRebuild.mockRestore();
      appendRows.mockRestore();
      layout.mockRestore();
    }
  });

  it("falls back to the full render when the round is no longer running", () => {
    const prototype = EasySyncSyncView.prototype as unknown as {
      doRender: () => void;
      patchProgressOnly: () => void;
    };
    const doRender = vi.spyOn(prototype, "doRender").mockImplementation(() => undefined);
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      closed: false,
      lastContentKey: "progress:key",
      renderedBodyMode: "progress",
      progressPanelEl: { } as unknown as HTMLElement,
      contentEl: { querySelector: () => null } as unknown as HTMLElement,
      plugin: {
        i18n: new I18n("zh-cn"),
        progressStore: {
          state: {
            phase: "done",
            current: 24,
            total: 24,
            currentFile: "",
            currentItemBytes: 0,
            currentItemTotalBytes: 0,
            currentItemComplete: false,
            cancelRequested: false,
            completedFiles: [],
            completedCount: 24,
            startedAt: 0,
          },
        },
        syncExecutor: { isRunning: false, hasSideActionsInFlight: false },
        syncDirection: "two-way",
        getMutationRecoveryDisplayState: () => null,
      },
    });
    try {
      (view as unknown as { patchProgressOnly: () => void }).patchProgressOnly();
      // 轮次结束＝结构态（体态、结果行、状态行都要换）：必须回整屏渲染，
      // 轻量路径不能把「跑完了」吞成几个数字。
      expect(doRender).toHaveBeenCalledTimes(1);
    } finally {
      doRender.mockRestore();
    }
  });

  it("rebuilds the running body when its progress panel was never mounted", () => {
    // 2026-10-28 真机：同步中按钮下方偶发整块空白，切一次「历史记录」才出现
    // 当轮文件列表，关掉历史后仍保留。整屏重建曾落在轮次尚无条目的一瞬
    // （executing 相位清零到首个 setProgress 之间），进度面板有意不建空面板；
    // 随后条目落地只走轻量 tick，只信 renderedBodyMode 会把这个结构缺口当成
    // 已挂载，文件列表永远补不回来。轻量路径必须核对真实 DOM。
    const prototype = EasySyncSyncView.prototype as unknown as {
      doRender: () => void;
      patchProgressOnly: () => void;
    };
    const doRender = vi.spyOn(prototype, "doRender").mockImplementation(() => undefined);
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      closed: false,
      lastContentKey: "progress:key",
      renderedBodyMode: "progress",
      // 上一帧整屏重建时 total=0：面板没有挂上，引用保持 null。
      progressPanelEl: null,
      contentEl: { querySelector: () => null } as unknown as HTMLElement,
      plugin: {
        i18n: new I18n("zh-cn"),
        progressStore: {
          state: {
            phase: "executing",
            current: 0,
            total: 12,
            currentFile: "",
            currentItemBytes: 0,
            currentItemTotalBytes: 0,
            currentItemComplete: false,
            cancelRequested: false,
            completedFiles: [],
            completedCount: 0,
            startedAt: 1,
          },
        },
        syncExecutor: { isRunning: true, hasSideActionsInFlight: false },
        syncDirection: "two-way",
        getMutationRecoveryDisplayState: () => null,
      },
    });
    try {
      (view as unknown as { patchProgressOnly: () => void }).patchProgressOnly();
      expect(doRender).toHaveBeenCalledTimes(1);
    } finally {
      doRender.mockRestore();
    }
  });

  it("logs a failed render frame instead of dying silently with a frozen panel", async () => {
    // 2026-10-28 真机（焦应行的笔记本）：渲染抛错此前静默死于 rAF 回调——
    // DOM 定格在上一次成功的画面、fullRenderPending 已清、后续每次渲染按
    // 同一输入原样重抛，「需要处理」行在账本自愈后仍冻结约 40 分钟直到
    // 重启，触发源因无堆栈而无法指认。抛错必须落诊断日志（error 级别不受
    // 类别开关约束），帧句柄必须已清（下一轮状态变化自带重试语义）。
    const prototype = EasySyncSyncView.prototype as unknown as {
      doRender: () => void;
    };
    const doRender = vi.spyOn(prototype, "doRender").mockImplementation(() => {
      throw new Error("render exploded");
    });
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    const diagError = vi.fn();
    Object.assign(view as object, {
      closed: false,
      fullRenderPending: false,
      renderFrameId: null,
      plugin: {
        diag: { error: diagError },
        i18n: new I18n("zh-cn"),
        progressStore: {
          state: {
            phase: "done",
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
          },
        },
        syncExecutor: { isRunning: false, hasSideActionsInFlight: false },
        getMutationRecoveryDisplayState: () => null,
      },
    });
    try {
      (view as unknown as { render: () => void }).render();
      // 帧回调在 rAF／超时垫片上异步执行，等它落地。
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(diagError).toHaveBeenCalledTimes(1);
      expect(String(diagError.mock.calls[0]?.[1])).toContain("render failed");
      expect(diagError.mock.calls[0]?.[2]).toContain("render exploded");
      // 帧句柄已清：后续渲染请求可以继续调度。
      expect((view as unknown as { renderFrameId: unknown }).renderFrameId)
        .toBeNull();
    } finally {
      doRender.mockRestore();
    }
  });

  it("scrolls the limited file list instead of squeezing gray directory lines flat", () => {
    // 用户 2026-09-24 澄清：纵向挤压——is-limited 列表是纵向 flex 容器，
    // 内容超高时默认先压子项；灰字目录带 overflow: hidden，自动最小高度
    // 为零，是唯一被压成空白窄行的受害者。子项必须 flex-shrink: 0，让
    // 列表装满后走滚动。
    const styles = readSourceFile("styles.css");
    const rule = styles.match(/\.easy-sync-file-list > \* \{[^}]*\}/s);
    expect(rule).not.toBeNull();
    expect(rule?.[0]).toContain("flex-shrink: 0");
  });

  it("applies the adaptive path layout in the same task that updated the rows (no two-frame flicker)", () => {    const prototype = EasySyncSyncView.prototype as unknown as {
      applyAdaptivePathLayout: () => void;
    };
    const applySpy = vi.spyOn(prototype, "applyAdaptivePathLayout");
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      closed: false,
      pathLayoutFrameId: null,
      contentEl: {
        querySelectorAll: () => [],
      } as unknown as HTMLElement,
    });
    try {
      (
        view as unknown as { scheduleAdaptivePathLayout(): void }
      ).scheduleAdaptivePathLayout();
      // The extraction must already be applied in this task. Deferring to a
      // later animation frame makes the browser paint the full-path rows
      // first and re-paint the extracted rows one frame later — a visible
      // two-frame jump while many rows are refreshed quickly (deletion sync
      // or receiving files), matching the reported flicker.
      expect(applySpy).toHaveBeenCalledTimes(1);
    } finally {
      applySpy.mockRestore();
    }
  });

  it("shows the true completed count instead of the retained list length", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const progressPanel = source.slice(
      source.indexOf("private renderProgressPanel"),
      source.indexOf("private renderRemoteScopeRecoveryFailure"),
    );
    // 2026-10-25：标题数＝真实动作数（`completedCount` 减掉零动作的按设置跳过行）。
    expect(progressPanel).toContain(
      "count: resolveCompletedActionCount(state)",
    );
    const append = source.slice(
      source.indexOf("private appendNewFileRows"),
      source.indexOf("private renderToolbar"),
    );
    expect(append).toContain("resolveCompletedActionCount(");
    expect(append).not.toContain("count: files.length");
  });

  it("keeps the round bar at the body top in every borrowed body mode while running", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    // While a round runs, a borrowed body (plan review / pending / recovery)
    // mounts the same round bar at its original body-top spot — the status
    // panel itself stays untouched (no bar above the divider).
    const statusPanel = source.slice(
      source.indexOf("private renderStatusPanel"),
      source.indexOf("private recoverPlanReviewDetails"),
    );
    expect(statusPanel).not.toContain("easy-sync-progress-bar");
    const dispatch = source.slice(
      source.indexOf("const content = container.createDiv"),
      source.indexOf("this.lastContentKey = contentKey;"),
    );
    // The cross-mode mount sits before the body dispatch and mirrors the
    // progress body's bar element-for-element. One predicate now decides both
    // the panel mount and the bare-bar suppression (no double bar when a
    // pending body mounts the progress panel during a running round).
    expect(dispatch).toContain(
      "const progressPanelShown = resolveSyncViewProgressPanelVisibility({",
    );
    expect(dispatch).toContain("if (!progressPanelShown && isRunning)");
    expect(dispatch.indexOf("progressPanelShown")).toBeLessThan(
      dispatch.indexOf('if (bodyMode === "plan"'),
    );
    expect(dispatch).toContain("easy-sync-progress-bar");
    expect(dispatch).toContain("remoteScopeRecoveryPercent(progress)");
    // The progress body keeps painting its own bar; the patch branch keeps
    // updating whichever bar the current body mounted (2026-10-26: the width
    // write is one shared helper so the light progress path and the full patch
    // branch cannot drift).
    const body = source.slice(
      source.indexOf("private renderProgressPanel"),
      source.indexOf("private renderRemoteScopeRecoveryFailure"),
    );
    expect(body).toContain("easy-sync-progress-bar");
    expect(body).toContain("count: resolveCompletedActionCount(state)");
    const patch = source.slice(
      source.indexOf("this.updateStatusPanel(statusState);"),
      source.indexOf("this.lastContentKey = contentKey;"),
    );
    expect(patch).toContain("this.updateProgressBarWidth(progress);");
    expect(source).toContain("private updateProgressBarWidth(");
  });

  it("invalidates the windowed height model when the toolbar expands or collapses everything", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    // The toolbar bulk-writes `open` on every tree item without going through
    // rememberPlanRowExpansion, so the windowed lists' offset model would
    // keep the old open-state heights: the mounted absolute window grows in
    // place, overflows its fixed-height container, and paints over the
    // update-prompt row and the history section below. The bulk writer has
    // to end with the same invalidation the rebuild path applies.
    const toggleAll = source.slice(
      source.indexOf("private toggleAllDetails(): void"),
      source.indexOf("private createIconButton("),
    );
    expect(toggleAll).toContain("this.planRowHeights.clear()");
    expect(toggleAll).toContain("this.planRowLayoutRevision += 1");
    expect(toggleAll).toContain("this.schedulePlanViewportRender()");
    // A cleared height model can re-derive the container height from probe
    // estimates while the window key stays identical (full-rebuild tail,
    // bulk expand) — the old early return then froze the estimate and the
    // mounted window overflowed onto the update-prompt row and history.
    // Both windowed renderers must re-measure until every mounted row slot
    // holds a real measured height.
    const pendingWindow = source.slice(
      source.indexOf("private renderPendingSection("),
      source.indexOf("private renderPendingRow("),
    );
    expect(pendingWindow).toContain(
      ".every((row) => this.planRowHeights.has(row.key));",
    );
    expect(pendingWindow).toContain(
      "if (nextKey === renderedKey && mountedMeasured) return;",
    );
    const planWindow = source.slice(
      source.indexOf("private renderPlanGroups("),
      source.indexOf("private measurePlanRowHeights("),
    );
    // Read-only groups keep the estimate-only two-height probe model; only
    // decision-row groups (which populate the height cache) re-measure.
    expect(planWindow).toContain("!hasInlineDecisions");
    expect(planWindow).toContain(
      "if (nextKey === renderedKey && mountedMeasured) return;",
    );
  });

  it("mounts completed rows incrementally and reserves full rebuilds for the fallback", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const append = source.slice(
      source.indexOf("private appendNewFileRows"),
      source.indexOf("private renderToolbar"),
    );
    // Hot path diffs against the rendered-row ledger; the keyed full rebuild
    // only remains as the fallback for missing list/ledger state.
    expect(append).toContain("diffCompletedFileRows(");
    expect(append.split("renderFileResults(").length - 1).toBe(1);
    expect(append).toContain("easySyncCompletedPath");
    // The ledger is dropped with every full rebuild so a stale round's rows
    // can never be diffed against a fresh list.
    expect(source).toContain("this.completedFileRowsLedger = null");
    // Row removal and prepend rely on the row's path dataset and a returned
    // row element from renderFileRow.
    const rowRenderer = source.slice(
      source.indexOf("function renderFileRow"),
      source.indexOf("export function shouldExpandAllVisibleDetails"),
    );
    expect(rowRenderer).toContain("dataset.easySyncCompletedPath");
    expect(rowRenderer).toContain("return row;");
    // Per-file append must never re-run a row-by-row full measure: it re-plans
    // the scope against the cached row states, so unchanged rows do no DOM
    // reads and only rows whose decision changed receive a write.
    expect(append).toContain("this.applyAdaptivePathLayoutScope(");
    expect(source).not.toContain("applyAdaptivePathLayoutToRows");
    const scopePass = source.slice(
      source.indexOf("private applyAdaptivePathLayoutScope("),
      source.indexOf("private applyAdaptivePathDecisions("),
    );
    expect(scopePass).toContain("this.adaptivePathRowStates.get(");
    expect(scopePass).toContain("this.measureAdaptivePathText(");
    expect(scopePass).not.toContain("pathLeft = pathEl.getBoundingClientRect");
    const patch = source.slice(
      source.indexOf("private patchProgressOnly("),
      source.indexOf("private renderSyncViewFullRebuild("),
    );
    expect(patch).toContain("this.appendNewFileRows(progress.completedFiles);");
    expect(patch).not.toContain("scheduleAdaptivePathLayout");
  });

  it("keeps ordinary plan rows chip-free; history action rows and the skip fold both opt into adaptive directories", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const planStart = source.indexOf("private renderPlanGroups");
    const conflictStart = source.indexOf("private renderConflictItem", planStart);
    const ordinaryPlanRows = source.slice(planStart, conflictStart);

    expect(ordinaryPlanRows).not.toContain(
      'row.createSpan("easy-sync-tree-chip")',
    );
    expect(ordinaryPlanRows).toContain(
      'body.addClass("easy-sync-path-layout")',
    );
    expect(source).toContain("new ResizeObserver");
    expect(source).toContain('window.addEventListener("resize"');
    expect(source).toContain("this.scheduleAdaptivePathLayout()");
    // 2026-09-16 增量呈现：历史条目先分区再渲染，普通行走 renderFileResults，
    // 按设置跳过行归入共享折叠件（2026-10-25 与运行中合并成同一件，并由
    // skipPaths 补回稳定集合）。
    // 2026-10-25 用户确认：历史普通文件行也接灰字目录（此前"历史不挂"只是
    // 实现现状被追认成约定，不是用户拍板）。
    expect(source).toContain(
      "this.renderFileResults(body, rows.action, false, true)",
    );
    expect(source).toContain("collectHistorySkipRows({");
    expect(source).toContain("this.createSkipFold(body, skip.rows, skip.total)");
    expect(source).toContain('if (adaptive) list.addClass("easy-sync-path-layout")');
    expect(source).toContain("renderFileRow(files[i], list, t, adaptive)");
    // 懒建正文在首帧渲染之后，必须补一次同一任务内的路径摘取。
    expect(source).toContain("this.renderHistoryEntryBody(body, entry);\n            // 懒建的正文不在首帧渲染里");
    // 2026-10-25 用户真机反馈：跳过折叠组本身要复用现役灰字目录机制——
    // 组内列表是独立测量范围，行按真实宽度自适应摘取。
    expect(source).toContain(
      '"easy-sync-file-list easy-sync-path-layout"',
    );
    expect(source).toContain("configureFilePath(row, pathEl, file.path, true)");
  });

  it("keeps moves, deferred work, true skips, and remote preparation in distinct plan groups", () => {
    const groups = buildSyncPlanDisplayGroups([
      { type: SyncActionType.Upload, path: "upload.md" },
      { type: SyncActionType.Download, path: "download.md" },
      { type: SyncActionType.CreateRemoteFolder, path: "Remote Folder" },
      { type: SyncActionType.CreateLocalFolder, path: "Local Folder" },
      { type: SyncActionType.MoveRemoteFolder, path: "Moved Remote Folder" },
      { type: SyncActionType.MoveLocalFolder, path: "Moved Local Folder" },
      { type: SyncActionType.RenameRemote, path: "moved-remote.md" },
      { type: SyncActionType.MoveLocalFile, path: "moved-local.md" },
      { type: SyncActionType.FolderDeferred, path: "deferred-folder" },
      { type: SyncActionType.RetryLater, path: "retry.md" },
      { type: SyncActionType.SkipLargeFile, path: "large.bin" },
      { type: SyncActionType.SkipIgnoredPath, path: "ignored.md" },
      { type: SyncActionType.RecreateRemoteScope, path: ".easy-sync" },
      { type: SyncActionType.DeleteRemote, path: "delete.md" },
    ]);
    const byGroup = new Map(groups.map((group) => [group.group, group]));

    expect(byGroup.get("upload")?.items.map((item) => item.type))
      .toEqual([SyncActionType.Upload]);
    expect(byGroup.get("download")?.items.map((item) => item.type))
      .toEqual([SyncActionType.Download]);
    expect(byGroup.get("folderCreate")?.items.map((item) => item.type))
      .toEqual([
        SyncActionType.CreateRemoteFolder,
        SyncActionType.CreateLocalFolder,
      ]);
    expect(byGroup.get("moveRename")?.items.map((item) => item.type))
      .toEqual([
        SyncActionType.MoveRemoteFolder,
        SyncActionType.MoveLocalFolder,
        SyncActionType.RenameRemote,
        SyncActionType.MoveLocalFile,
      ]);
    expect(byGroup.get("deferred")?.items.map((item) => item.type))
      .toEqual([SyncActionType.FolderDeferred, SyncActionType.RetryLater]);
    expect(byGroup.get("skip")?.items.map((item) => item.type))
      .toEqual([SyncActionType.SkipLargeFile, SyncActionType.SkipIgnoredPath]);
    expect(byGroup.get("remotePreparation")?.items.map((item) => item.type))
      .toEqual([SyncActionType.RecreateRemoteScope]);
    expect(groups.every((group) => !("open" in group))).toBe(true);
  });

  it("keeps a 50k plan DOM window bounded to the visible rows plus overscan", () => {
    const offsets = buildSyncPlanVirtualOffsets(
      Array.from({ length: 50_000 }, () => ({ reason: undefined })),
      20,
      42,
    );
    const window = buildSyncPlanVirtualWindow({
      offsets,
      listTop: 100,
      viewportTop: 10_100,
      viewportBottom: 10_820,
    });
    const visibleRows = Math.ceil(720 / 20);

    expect(window.end - window.start)
      .toBeLessThanOrEqual(visibleRows + SYNC_PLAN_VIRTUAL_OVERSCAN * 2 + 1);
    expect(window.start).toBeGreaterThan(0);
    expect(window.end).toBeLessThan(50_000);
    expect(window.offset).toBe(offsets[window.start]);
    expect(window.totalHeight).toBe(offsets[offsets.length - 1]);
  });

  it("automatically rebuilds only a legacy plan that has counts but no details", () => {
    const counts = {
      uploads: 1,
      downloads: 0,
      folders: 0,
      deletes: 0,
      conflicts: 0,
      skipped: 0,
    };
    expect(shouldAutoRebuildPlanReview(counts, [])).toBe(true);
    expect(shouldAutoRebuildPlanReview(counts, [{
      type: SyncActionType.Upload,
      path: "ready.md",
    }])).toBe(false);
    expect(shouldAutoRebuildPlanReview({ ...counts, uploads: 0 }, [])).toBe(false);
    expect(shouldAutoRebuildPlanReview(null, [])).toBe(false);
    expect(resolvePlanReviewDetailsState(false, false)).toBe("ready");
    expect(resolvePlanReviewDetailsState(true, true)).toBe("recovering");
    expect(resolvePlanReviewDetailsState(true, false)).toBe("retry");
  });

  it("single-flights automatic detail recovery and permits an explicit retry", async () => {
    const rebuildPlanReview = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);
    const render = vi.fn();
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      closed: false,
      planReviewDetailsRecoveryInFlight: false,
      autoRebuiltPlanReviewRevision: -1,
      plugin: {
        rebuildPlanReview,
        state: {
          planReviewRevision: 7,
          planReviewCounts: {
            uploads: 1,
            downloads: 0,
            folders: 0,
            deletes: 0,
            conflicts: 0,
            skipped: 0,
          },
          planReviewItems: [],
        },
        diag: { warn: vi.fn() },
      },
      render,
    });
    const recover = (force = false) => (
      view as unknown as {
        recoverPlanReviewDetails(revision: number, force?: boolean): void;
      }
    ).recoverPlanReviewDetails(7, force);

    recover();
    recover();
    expect(rebuildPlanReview).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    recover();
    expect(rebuildPlanReview).toHaveBeenCalledTimes(1);
    recover(true);
    expect(rebuildPlanReview).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render).toHaveBeenCalled();
  });

  it("ignores a stale detail-recovery control after the reviewed revision changes", () => {
    const rebuildPlanReview = vi.fn();
    const render = vi.fn();
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      closed: false,
      planReviewDetailsRecoveryInFlight: false,
      autoRebuiltPlanReviewRevision: 7,
      plugin: {
        rebuildPlanReview,
        state: {
          planReviewRevision: 8,
          planReviewCounts: {
            uploads: 1,
            downloads: 0,
            folders: 0,
            deletes: 0,
            conflicts: 0,
            skipped: 0,
          },
          planReviewItems: [{ type: SyncActionType.Upload, path: "ready.md" }],
        },
        diag: { warn: vi.fn() },
      },
      render,
    });

    (view as unknown as {
      recoverPlanReviewDetails(revision: number, force?: boolean): void;
    }).recoverPlanReviewDetails(7, true);

    expect(rebuildPlanReview).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("renders no plan rows when a virtual group is outside the viewport", () => {
    const offsets = buildSyncPlanVirtualOffsets(
      Array.from({ length: 50_000 }, () => ({ reason: undefined })),
      20,
      42,
    );
    expect(buildSyncPlanVirtualWindow({
      offsets,
      listTop: 2_000,
      viewportTop: 0,
      viewportBottom: 800,
    })).toEqual({
      start: 0,
      end: 0,
      offset: 0,
      totalHeight: 50_000 * 20,
    });
  });

  it("keeps one decision row per community plugin bundle wherever the window starts", () => {
    const pluginMember = (path: string): SyncPlanItem => ({
      path,
      type: SyncActionType.Conflict,
    });
    const bundled = [
      pluginMember("plugins/demo/main.js"),
      pluginMember("plugins/demo/manifest.json"),
    ];
    const pluginConflict = { pluginId: "demo", items: bundled };
    const rows = buildSyncPlanDisplayRows(
      [
        { type: SyncActionType.Conflict, path: "plugins/demo/main.js" },
        { type: SyncActionType.Conflict, path: "plugins/demo/manifest.json" },
        { type: SyncActionType.Conflict, path: "notes/a.md" },
        { type: SyncActionType.ConfirmLocalDelete, path: "gone.md" },
        { type: SyncActionType.Conflict, path: "detached.md" },
      ],
      new Map([
        ["plugins/demo/main.js", bundled[0]],
        ["plugins/demo/manifest.json", bundled[1]],
        ["notes/a.md", pluginMember("notes/a.md")],
      ]),
      new Map([["gone.md", { path: "gone.md", type: SyncActionType.ConfirmLocalDelete }]]),
      new Map([
        ["plugins/demo/main.js", pluginConflict],
        ["plugins/demo/manifest.json", pluginConflict],
      ]),
    );

    expect(rows.map((row) => row.key)).toEqual([
      "plugin:demo",
      "conflict:notes/a.md",
      "delete:gone.md",
      "row:conflict:detached.md",
    ]);
    expect(rows[0].pluginConflict).toBe(pluginConflict);
    expect(rows[1].pluginConflict).toBe(null);
  });

  it("gives every measured decision row its own slot height", () => {
    expect(buildSyncPlanMeasuredVirtualOffsets([26, 120, 26]))
      .toEqual([0, 26, 146, 172]);
    expect(buildSyncPlanMeasuredVirtualOffsets([])).toEqual([0]);
    // A row that measures as nothing still needs a reachable slot.
    expect(buildSyncPlanMeasuredVirtualOffsets([0])).toEqual([0, 1]);
  });

  it("uses the existing compact row heights when reasons make individual rows taller", () => {
    expect(buildSyncPlanVirtualOffsets([
      { reason: undefined },
      { reason: "syncReason.test" },
      { reason: undefined },
    ], 20, 42)).toEqual([0, 20, 62, 82]);
  });

  it("reports folder creation and folder movement as different history actions", () => {
    const i18n = new I18n("zh-cn");
    const counts = formatSyncHistoryCounts({
      id: "move-only",
      mode: "manual",
      status: "success",
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      filesMoved: 1,
      foldersCreated: 0,
      foldersMoved: 2,
      foldersDeleted: 1,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      skipped: 0,
      errors: 0,
      message: "done",
      files: [],
    }, i18n.t.bind(i18n));

    expect(counts).toBe(
      "文件移动/重命名 1 · 文件夹移动/重命名 2 · 删除文件夹 1",
    );
    expect(counts).not.toContain("创建文件夹");
  });

  it("renders a persisted run reason and an explicit zero-change success without fake file rows", () => {
    const root = createFakeHistoryElement();
    const section = createFakeHistoryElement("section");
    root.children.push(section);
    const renderFileResults = vi.fn();
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      plugin: { i18n: new I18n("zh-cn") },
      createSection: vi.fn(() => section),
      addCollapseIcon: vi.fn(),
      renderFileResults,
      // 懒建正文后的路径摘取在真实视图里读 contentEl；这里只验证调用，
      // 不需要真实 DOM。
      applyAdaptivePathLayout: vi.fn(),
    });

    (view as unknown as {
      renderHistorySection(
        container: HTMLElement,
        history: Array<Record<string, unknown>>,
      ): void;
    }).renderHistorySection(root as unknown as HTMLElement, [
      {
        id: "failed-observation",
        mode: "auto",
        status: "failed",
        startedAt: 1,
        endedAt: 2,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
        skipped: 0,
        errors: 1,
        message: "暂时无法读取云端同步状态。",
        files: [],
        runFacts: {
          termination: "normal",
          ordinaryPlanning: "not-entered",
          userFileChanges: "unknown",
        },
      },
      {
        id: "explicit-zero-change",
        mode: "auto",
        status: "success",
        startedAt: 3,
        endedAt: 4,
        uploaded: 0,
        downloaded: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        filesMoved: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
        skipped: 0,
        errors: 0,
        message: "同步完成",
        files: [],
        runFacts: {
          termination: "normal",
          ordinaryPlanning: "entered",
          userFileChanges: "none",
        },
      },
    ]);

    const list = section.children[0];
    const zeroChangeDetails = list.children[1];
    zeroChangeDetails.open = true;
    for (const handler of zeroChangeDetails.listeners.toggle ?? []) handler();
    const text = collectFakeHistoryText(root);
    expect(text).toContain("暂时无法读取云端同步状态。");
    expect(text).toContain("本轮没有文件变更。");
    expect(renderFileResults).not.toHaveBeenCalled();
  });

  it("does not infer zero file changes for a legacy history entry without run facts", () => {
    const root = createFakeHistoryElement();
    const section = createFakeHistoryElement("section");
    root.children.push(section);
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      plugin: { i18n: new I18n("zh-cn") },
      createSection: vi.fn(() => section),
      addCollapseIcon: vi.fn(),
      renderFileResults: vi.fn(),
      applyAdaptivePathLayout: vi.fn(),
    });

    (view as unknown as {
      renderHistorySection(
        container: HTMLElement,
        history: Array<Record<string, unknown>>,
      ): void;
    }).renderHistorySection(root as unknown as HTMLElement, [{
      id: "legacy-empty-success",
      mode: "auto",
      status: "success",
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      skipped: 0,
      errors: 0,
      message: "同步完成",
      files: [],
    }]);
    const legacyDetails = section.children[0].children[0];
    legacyDetails.open = true;
    for (const handler of legacyDetails.listeners.toggle ?? []) handler();

    expect(collectFakeHistoryText(root)).not.toContain("本轮没有文件变更。");
  });

  it("does not report a failed run as omitted successful file details", () => {
    expect(countOmittedSyncHistorySuccessfulFiles({
      id: "failed-before-transfer",
      mode: "first",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 1,
      message: "missing runtime directory",
      files: [],
    })).toBe(0);
  });

  it("counts only successful records when reporting retained history details", () => {
    expect(countOmittedSyncHistorySuccessfulFiles({
      id: "retained-successes",
      mode: "manual",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      uploaded: 120,
      downloaded: 0,
      deleted: 0,
      conflicts: 1,
      skipped: 1,
      errors: 1,
      message: "partial",
      files: [
        ...Array.from({ length: 100 }, (_, index) => ({
          path: `note-${index}.md`,
          status: "upload" as const,
        })),
        { path: "conflict.md", status: "conflict" as const },
        { path: "skipped.bin", status: "skip" as const },
        { path: "failed.md", status: "error" as const },
      ],
    })).toBe(20);
  });

  it("reports remote deletion confirmation separately from real conflicts in history", () => {
    const i18n = new I18n("zh-cn");
    const counts = formatSyncHistoryCounts({
      id: "pending-mixed",
      mode: "manual",
      status: "partial",
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 2,
      deferred: 0,
      skipped: 0,
      errors: 0,
      message: "pending",
      files: [
        {
          path: "deleted-remotely.md",
          status: "conflict",
          actionType: SyncActionType.ConfirmLocalDelete,
        },
        {
          path: "edited-both-sides.md",
          status: "conflict",
          actionType: SyncActionType.Conflict,
        },
      ],
    }, i18n.t.bind(i18n));

    expect(counts).toBe("冲突 1 · 云端删除待确认 1");
  });

  it("prefers the history entry's direct remote-delete split over retained rows", () => {
    const i18n = new I18n("zh-cn");
    const entry = {
      id: "pending-direct",
      mode: "manual" as const,
      status: "partial" as const,
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 2,
      deferred: 0,
      skipped: 0,
      errors: 0,
      message: "pending",
      files: [
        {
          path: "deleted-remotely.md",
          status: "conflict" as const,
          actionType: SyncActionType.ConfirmLocalDelete,
        },
        {
          path: "edited-both-sides.md",
          status: "conflict" as const,
          actionType: SyncActionType.Conflict,
        },
      ],
    };

    // Direct 0 wins even though a ConfirmLocalDelete row would infer 1.
    expect(formatSyncHistoryCounts(
      { ...entry, remoteDeletePending: 0 },
      i18n.t.bind(i18n),
    )).toBe("冲突 2");
    // Direct split works when the retained rows are gone (100-row cap).
    expect(formatSyncHistoryCounts(
      { ...entry, remoteDeletePending: 2, files: [] },
      i18n.t.bind(i18n),
    )).toBe("云端删除待确认 2");
  });

  it("keeps plan confirmation in the fixed primary action and plan details lazy", () => {
    const styles = readSourceFile("styles.css");
    const source = readSourceFile("src/ui/sync-view.ts");
    const statusStart = source.indexOf("private renderStatusPanel");
    const statusEnd = source.indexOf("private updateStatusPanel", statusStart);
    const status = source.slice(statusStart, statusEnd);
    const sectionStart = source.indexOf("private renderPlanReviewSection");
    const sectionEnd = source.indexOf("private renderPlanGroups", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    const groupsEnd = source.indexOf("private renderPlanReviewRow", sectionEnd);
    const groups = source.slice(sectionEnd, groupsEnd);

    expect(status).toContain('"syncPlan.confirmMigration"');
    expect(status).toContain('"syncPlan.confirmExecute"');
    expect(status).toContain('"syncPlan.restoringDetails"');
    expect(status).toContain('"syncPlan.restoreDetails"');
    expect(status.indexOf("state.planReviewDetailsState")).toBeLessThan(
      status.indexOf("this.plugin.executePlanReview(state.planReviewRevision)"),
    );
    expect(status).not.toContain('"syncPlan.remoteScopeRecreateConfirm"');
    expect(status).toContain("this.plugin.executePlanReview(state.planReviewRevision)");
    expect(status).toContain("this.recoverPlanReviewDetails(");
    expect(status).toContain(".setCta()");
    expect(section).not.toContain('t("syncPlan.recalculate")');
    expect(section).not.toContain("this.plugin.rebuildPlanReview()");
    expect(section).not.toContain("this.plugin.executePlanReview()");
    expect(section).toContain('t("syncPlan.remoteScopeRecreateSummary")');
    expect(groups).toContain('details.addEventListener("toggle"');
    expect(groups).toContain("this.measurePlanRowHeights(body)");
    expect(groups).toContain(
      '"easy-sync-file-row easy-sync-plan-measure-probe"',
    );
    expect(groups).not.toContain("probe.style.");
    expect(groups).toContain("buildSyncPlanVirtualWindow({");
    expect(groups).toContain("this.planVirtualRenderers.add(renderInlineDecisions)");
    expect(groups).toContain("hasInlineDecisions");
    expect(styles).not.toMatch(/\.easy-sync-plan-virtual-window\s*\{[^}]*position:\s*absolute/s);
    expect(styles).toMatch(
      /\.easy-sync-plan-measure-probe\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).not.toMatch(/\.easy-sync-plan-virtual-window > \.easy-sync-file-row\s*\{/s);
  });

  it("mounts windowed rows in flow between spacers so overflow cannot paint over siblings", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    // 方案单 20260924-0001（用户拍板）: the visible-row window is an
    // ordinary in-flow block between top/bottom spacers — real row content
    // can only push the bottom spacer (and everything below) down, so
    // painting over the update-prompt row or history is impossible by
    // construction. Estimate error degrades to scroll-length drift until
    // the measure pass corrects it.
    const helperStart = source.indexOf("private mountPlanFlowWindow(");
    const helperEnd = source.indexOf("private renderPendingSection(", helperStart);
    const helper = source.slice(helperStart, helperEnd);
    expect(helper).toContain('createDiv("easy-sync-plan-virtual-spacer")');
    expect(helper).toContain("windowState.end <= windowState.start");
    expect(helper).toContain("totalHeight - endOffset");
    const pendingWindow = source.slice(
      source.indexOf("private renderPendingSection("),
      source.indexOf("private renderPendingRow("),
    );
    const planWindow = source.slice(
      source.indexOf("private renderPlanGroups("),
      source.indexOf("private measurePlanRowHeights("),
    );
    for (const renderer of [pendingWindow, planWindow]) {
      expect(renderer).toContain("this.mountPlanFlowWindow(");
      expect(renderer).toContain("virtualList,");
      // No positioned window and no predicted container height anywhere:
      // both were the mechanism behind the overlap defects.
      expect(renderer).not.toContain("translateY(");
      expect(renderer).not.toContain("virtualList.style.height");
    }
    expect(source).not.toContain("virtualList.style.height");
    expect(source).not.toContain("translateY(${windowState.offset}px)");
  });

  it("renders the summary slot as flow lines plus a timing-matched decision note", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const sectionStart = source.indexOf("private renderPlanReviewSection");
    const sectionEnd = source.indexOf("private renderPlanGroups", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);

    // Activation reviews render a flow line (with the deferred decision note
    // appended only when decision rows exist); the inline-decision boundary
    // note only reaches ordinary plans through the trailing else-if branch
    // (2026-09-29 DECISIONS, amending the 2026-09-17 single-sentence rule).
    // The decision note lives inside the renderSummaryLine helper, which sits
    // above the branch chain — so it must appear before every branch, while
    // the ordinary boundary branch stays last.
    const decisionNoteIndex = section.indexOf(
      '"syncPlan.activationDecisionSummary"',
    );
    const migrationIndex = section.indexOf('"syncPlan.migrationSummary"');
    const joinIndex = section.indexOf('"syncPlan.cloudJoinSummary"');
    const firstSyncIndex = section.indexOf('"syncPlan.firstSyncSummary"');
    const recreateIndex = section.indexOf(
      '"syncPlan.remoteScopeRecreateSummary"',
    );
    const boundaryIndex = section.indexOf('"syncPlan.confirmBoundarySummary"');
    expect(decisionNoteIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(decisionNoteIndex);
    expect(joinIndex).toBeGreaterThan(migrationIndex);
    expect(firstSyncIndex).toBeGreaterThan(joinIndex);
    expect(recreateIndex).toBeGreaterThan(firstSyncIndex);
    expect(boundaryIndex).toBeGreaterThan(recreateIndex);
    // The deferred note must flow through the same slot, not a second block.
    expect(section).toContain("renderSummaryLine");
    expect(section).toContain("hasDecisionRows");
    expect(section).toContain("SyncActionType.Conflict");
    expect(section).toContain("SyncActionType.ConfirmLocalDelete");
  });

  it("marks a re-staged activation review only after the sidebar showed its baseline", () => {
    // 2026-10-09 用户拍板（F22 候选②）：触发只认「激活类审阅的修订号越过本视图
    // 首次展示时的基线」——激活家族修订号由 hold 幂等暂存守卫维护，涨号 ⟺
    // 用户正看着的这份计划被换过。
    expect(isPlanReviewRefreshedSinceShown({
      reviewKind: "v2-cloud-join",
      currentRevision: 8,
      baselineRevision: 8,
    })).toBe(false);
    expect(isPlanReviewRefreshedSinceShown({
      reviewKind: "v2-cloud-join",
      currentRevision: 9,
      baselineRevision: 8,
    })).toBe(true);
    // 本视图还没展示过这份审阅（无基线）：不触发。
    expect(isPlanReviewRefreshedSinceShown({
      reviewKind: "v2-cloud-join",
      currentRevision: 9,
      baselineRevision: null,
    })).toBe(false);
    // 普通审阅：修订号每次重写计划都 +1（计划没变也涨），口径不同，恒不触发。
    expect(isPlanReviewRefreshedSinceShown({
      reviewKind: undefined,
      currentRevision: 9,
      baselineRevision: 8,
    })).toBe(false);
    expect(isPlanReviewRefreshedSinceShown({
      reviewKind: null,
      currentRevision: 9,
      baselineRevision: 8,
    })).toBe(false);
    // 防御：修订号回落（重置后的新周期）不当作「已更新」。
    expect(isPlanReviewRefreshedSinceShown({
      reviewKind: "v2-migration",
      currentRevision: 7,
      baselineRevision: 8,
    })).toBe(false);
  });

  it("announces the re-staged review through the two existing slots only", () => {
    // 不新增槽位与文案：顶部状态行与计划区说明行按条件改说既有的「已更新」
    // 两句（弹框标题／正文逐字复用）。基线在计划正文首次渲染时记下、审阅
    // 结束时清零。
    const source = readSourceFile("src/ui/sync-view.ts");
    expect(source).toContain(
      "private planReviewBaselineRevision: number | null = null;",
    );
    const planBlockStart = source.indexOf('if (bodyMode === "plan" && syncState) {');
    const planBlockEnd = source.indexOf("this.renderedBodyMode = bodyMode;", planBlockStart);
    const planBlock = source.slice(planBlockStart, planBlockEnd);
    expect(planBlock).toContain(
      "this.planReviewBaselineRevision = syncState.planReviewRevision;",
    );
    expect(planBlock).toContain("} else if (!planReviewActive) {");
    expect(planBlock).toContain("this.planReviewBaselineRevision = null;");
    expect(planBlock).toContain(
      "const planReviewRefreshed = isPlanReviewRefreshedSinceShown({",
    );

    const statusStart = source.indexOf("private getStatusPresentation(");
    const statusEnd = source.indexOf("private renderProgressPanel(", statusStart);
    const status = source.slice(statusStart, statusEnd);
    expect(status).toContain("state.planReviewRefreshed");
    expect(status).toContain('"syncPlan.reviewUpdatedTitle"');
    expect(status).toContain('"syncPlan.sectionTitle"');

    const sectionStart = source.indexOf("private renderPlanReviewSection");
    const sectionEnd = source.indexOf("private renderPlanGroups", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    const branchStart = section.indexOf("if (planReviewRefreshed) {");
    const branchEnd = section.indexOf(
      '} else if (activationReviewKind === "v2-migration") {',
    );
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const refreshedBranch = section.slice(branchStart, branchEnd);
    // 同一说明槽位、单块：刷新分支只创建一个 description div。
    expect(refreshedBranch.match(/setting-item-description/g)?.length ?? 0).toBe(1);
    expect(refreshedBranch).toContain('t("syncPlan.reviewUpdatedMessage")');
    // 未触发时流程句分支链原样保留（互斥，不新增第二块）。
    expect(section).toContain('t("syncPlan.migrationSummary")');
    expect(section).toContain("renderSummaryLine");
  });

  it("preserves an opened plan group and scroll position across side-action rerenders", () => {
    const source = readSourceFile("src/ui/sync-view.ts");

    expect(source).toContain("private planGroupExpandedState = new Map<SyncActionGroup, boolean>()");
    const revisionStart = source.indexOf(
      "this.renderedPlanReviewRevision !== syncState.planReviewRevision",
    );
    const revisionEnd = source.indexOf(
      "this.renderedPlanReviewRevision = syncState.planReviewRevision;",
      revisionStart,
    );
    const revision = source.slice(revisionStart, revisionEnd);
    expect(revision).toContain("this.planGroupExpandedState.clear();");
    expect(revision).toContain("preservedContentScrollTop = null;");
    expect(source).toContain("details.dataset.easySyncPlanGroup = group.group");
    expect(source).toContain("this.planGroupExpandedState.set(group.group, details.open)");
    expect(source).toContain("expandedPlanGroups.has(group)");
    expect(source).toContain("this.planGroupExpandedState.get(group)");
    expect(source).toContain("renderInlineDecisions();");
    expect(source).toContain(
      '(bodyMode === "plan" || bodyMode === "recovery" || bodyMode === "idle")',
    );
    expect(source).toContain("content.scrollTop = preservedContentScrollTop");
    expect(source).toContain("container.scrollTop = preservedHostScrollTop");
    expect(source).toContain("this.updateCollapseTogglePresentation();");
  });

  it("submits UI decisions only through the plugin gateway", () => {
    const viewSource = readSourceFile("src/ui/sync-view.ts");
    const modalSource = readSourceFile("src/ui/conflict-detail-modal.ts");
    const directExecutorMutation = /syncExecutor[^\n]*(resolveConflictKeepLocal|resolveConflictKeepRemote|confirmRemoteDelete|rejectRemoteDelete)/;

    expect(viewSource).not.toMatch(directExecutorMutation);
    expect(modalSource).not.toMatch(directExecutorMutation);
    expect(modalSource).not.toContain("plugin.state?.removePendingConflict");
    expect(viewSource).toContain("plugin.resolveConflictKeepLocal");
    expect(viewSource).toContain("plugin.confirmRemoteDelete");
    expect(viewSource).toContain("plugin.confirmRemoteDeletes");
    expect(viewSource).toContain(
      "plugin.confirmReviewedSharedFolderIdentity(snapshot)",
    );
    expect(viewSource).toContain(
      "plugin.retireReviewedStaleIdentity(snapshot)",
    );
    expect(viewSource).toContain(
      "plugin.resolveReviewedFolderLocation(",
    );
    expect(viewSource).not.toContain(
      "syncExecutor.confirmReviewedSharedFolderIdentity",
    );
    expect(modalSource).toContain("plugin.dismissConflict");
    expect(modalSource).toContain("plugin.reconcileIdenticalConflict");
  });

  it("keeps shared-folder identity confirmation local to its pending row", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const rowStart = source.indexOf("  private renderPendingIssue(");
    const openStart = source.indexOf(
      "  private async openSharedFolderIdentityResolution(",
      rowStart,
    );
    const openEnd = source.indexOf(
      "\n  private async openEmptyFolderResolution(",
      openStart,
    );
    const row = source.slice(rowStart, openStart);
    const openMethod = source.slice(openStart, openEnd);

    // 出口种类现由 `pendingIssueExitKind`（src/sync/sync-item-termination）
    // 单点判定：S4 终止判据的「有没有真实人工出口」与本行的 chip 分支必须来
    // 自同一判断，否则会出现「判定说没有出口、界面却在画出口」。逐字改写下
    // 该码点（用例全名与项数不变，2026-10-17 S4）。
    expect(row).toContain('case "shared-folder-identity":');
    expect(row).toContain('t("syncView.sharedFolderIdentity.resolve")');
    expect(openMethod).toContain(
      "if (this.sharedFolderIdentityResolutionOpening) return",
    );
    expect(openMethod.match(/new ConfirmModal\(/g)).toHaveLength(1);
    expect(openMethod).toContain(
      "lines: sharedFolderIdentityConfirmLines(snapshot, t)",
    );
    expect(openMethod).toContain("if (!confirmed) return");
    expect(openMethod).toContain(
      "this.plugin.confirmReviewedSharedFolderIdentity(snapshot)",
    );
    expect(source).not.toContain(
      "syncExecutor.confirmReviewedSharedFolderIdentity",
    );
  });

  it("drops the no-action last-attempt line from pending rows (2026-09-15 减负 R-5)", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    expect(source).not.toContain("syncView.issues.lastAttempt");
  });

  it("routes a two-sided folder move to one existing folder modal", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const modalSource = readSourceFile("src/ui/empty-folder-resolution-modal.ts");
    const rowStart = source.indexOf("  private renderPendingIssue(");
    const openStart = source.indexOf(
      "  private async openFolderLocationResolution(",
      rowStart,
    );
    const row = source.slice(rowStart, source.indexOf(
      "  private async openStaleIdentityResolution(",
      rowStart,
    ));
    const openMethod = source.slice(openStart, source.indexOf("\n  private ", openStart + 5));

    // 同族改写（2026-10-17 S4 终止判据）：出口种类单点判定在
    // `pendingIssueExitKind`，本行的 chip 分支按它分发（用例名与项数不变）。
    expect(row).toContain('case "folder-location":');
    expect(row).toContain('t("syncView.folderLocation.resolve")');
    expect(openMethod).toContain("new EmptyFolderResolutionModal(");
    expect(openMethod).toContain('choice?.action === "keep-local-location"');
    expect(openMethod).toContain('choice?.action === "keep-remote-location"');
    expect(openMethod).toContain("this.plugin.resolveReviewedFolderLocation(");
    expect(modalSource).not.toContain("class FolderLocationResolutionModal");
  });

  it("keeps stale identity retirement explicit, state-only, and local to its pending row", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const rowStart = source.indexOf("  private renderPendingIssue(");
    const openStart = source.indexOf(
      "  private async openStaleIdentityResolution(",
      rowStart,
    );
    const openEnd = source.indexOf(
      "\n  private async openSharedFolderIdentityResolution(",
      openStart,
    );
    const row = source.slice(rowStart, openStart);
    const openMethod = source.slice(openStart, openEnd);

    // 同族改写（2026-10-17 S4 终止判据）：这批码点归入
    // `pendingIssueExitKind` 的 stale-identity 类，本行只按类分发 chip；
    // 判定侧的「有真实出口」读同一函数（用例名与项数不变）。
    expect(row).toContain('case "stale-identity":');
    expect(row).toContain('t("syncView.staleIdentity.resolve")');
    expect(openMethod).toContain(
      "if (this.staleIdentityResolutionOpening) return",
    );
    expect(openMethod.match(/new ConfirmModal\(/g)).toHaveLength(1);
    expect(openMethod).toContain('"syncView.staleIdentity.folderMessage"');
    expect(openMethod).toContain('"syncView.staleIdentity.fileMessage"');
    expect(openMethod).toContain("if (!confirmed) return");
    expect(openMethod).toContain(
      "this.plugin.retireReviewedStaleIdentity(snapshot)",
    );
    expect(source).not.toContain("syncExecutor.retireReviewedStaleIdentity");
  });

  it("keeps facts-changed handling in the fixed top action and reuses the shared comparison surface", () => {
    const viewSource = readSourceFile("src/ui/sync-view.ts");
    const modalSource = readSourceFile("src/ui/mutation-recovery-resolution-modal.ts");
    const conflictSource = readSourceFile("src/ui/conflict-detail-modal.ts");
    const sharedSource = readSourceFile("src/ui/file-comparison-modal.ts");
    const styles = readSourceFile("styles.css");
    const openStart = viewSource.indexOf(
      "  private async openMutationRecoveryResolution()",
    );
    const openEnd = viewSource.indexOf(
      "\n  private async openCommunityPluginBundleReview",
      openStart,
    );
    const openMethod = viewSource.slice(openStart, openEnd);
    const confirmStart = viewSource.indexOf(
      "  private async confirmMutationResolutionDeletion",
    );
    const confirmEnd = viewSource.indexOf(
      "\n  private renderHistorySection",
      confirmStart,
    );
    const confirmMethod = viewSource.slice(confirmStart, confirmEnd);

    expect(viewSource).toContain('"syncView.recovery.reviewDetails"');
    expect(viewSource).toContain("mutationRecoveryPrimaryActionKey(");
    expect(viewSource).toContain(
      'actionKey === "syncView.recovery.reviewDetails"',
    );
    expect(viewSource).toContain("this.renderMutationRecoverySection(");
    expect(viewSource).not.toContain("abandonAllAction");
    expect(viewSource).not.toContain("abandonAllAvailable");
    // The facts-changed decision stays in the fixed top action through the
    // shared pure decision (resolveSyncViewPrimaryAction) and only renders a
    // button when a real action key exists.
    expect(viewSource).toContain(
      "input.isLoggedIn && input.recoveryActionKey",
    );
    expect(viewSource).toContain('case "recovery"');
    expect(viewSource).not.toContain('"syncView.recovery.reviewAndResolve"');
    expect(openMethod).toContain("if (this.mutationRecoveryResolutionOpening) return");
    expect(openMethod).toContain("shouldAutoSettleIdenticalRecovery(snapshot)");
    expect(openMethod).toContain(
      'await this.plugin.resolveMutationRecovery(snapshot, "keep-local")',
    );
    expect(openMethod).toContain("this.plugin.updateStatusBar()");
    expect(openMethod.match(/new MutationRecoveryResolutionModal\(/g)).toHaveLength(1);
    expect(openMethod).toContain(".awaitChoice()");
    expect(openMethod).toContain("confirmMutationResolutionDeletion(snapshot, choice)");
    expect(confirmMethod).toContain("option.deletesOtherSide");
    expect(confirmMethod).toContain("new ConfirmModal(");
    expect(confirmMethod.indexOf("option.deletesOtherSide")).toBeLessThan(
      confirmMethod.indexOf("new ConfirmModal("),
    );
    expect(openMethod).toContain("this.plugin.resolveMutationRecovery(snapshot, choice)");
    expect(modalSource).toContain("extends FileComparisonModal");
    expect(modalSource).toContain('this.setTitle(this.t(bundle');
    expect(modalSource).toContain('this.setTitle(this.t("syncView.pluginBundleReview.title"));');
    expect(modalSource).not.toContain('createEl("h3", {\n        text: this.t("syncView.pluginBundleReview.title")');
    expect(modalSource).not.toContain('createEl("h3", {\n      text: this.t("syncView.pluginBundleReview.diffTitle"');
    expect(modalSource).toContain("this.renderComparisonTable(");
    expect(modalSource).toContain('"easy-sync-comparison-path-table"');
    expect(modalSource).toContain("easy-sync-bundle-overview");
    expect(modalSource).toContain("this.renderFileComparisonActions([");
    expect(modalSource).not.toContain("easy-sync-detail-actions-mobile-stacked");
    expect(conflictSource).not.toContain("easy-sync-detail-actions-mobile-stacked");
    expect(conflictSource).not.toContain("easy-sync-comparison-path-table");
    expect(modalSource).toContain('!executableChoices.includes("keep-local")');
    expect(modalSource).toContain('!executableChoices.includes("keep-remote")');
    expect(modalSource).not.toContain("extends Modal");
    expect(modalSource).not.toContain("easy-sync-mutation-resolution-");
    expect(sharedSource).toContain('this.contentEl.addClass("easy-sync-conflict-detail")');
    expect(sharedSource).toContain('createDiv("easy-sync-conflict-body")');
    expect(sharedSource).toContain('createEl("table", "easy-sync-metadata-table")');
    expect(sharedSource).toContain('createDiv("easy-sync-detail-actions")');
    expect(modalSource).not.toContain(".setCta()");
    // Slice B: ordinary entries keep only executable actions and one short path.
    expect(modalSource).not.toContain("syncView.mutationResolution.unavailable");
    expect(modalSource).not.toContain(": !snapshot.keepLocal.available");
    expect(modalSource).not.toContain(": !snapshot.keepRemote.available");
    // Bundle reviews do not re-show an identical notice: the dialog only opens
    // when at least one member differs (identical bundles auto-settle).
    expect(modalSource).not.toContain("bundle && snapshot.identical");
    expect(modalSource).toContain("syncView.mutationResolution.singleActionHint");
    expect(modalSource).toContain("syncView.mutationResolution.noAvailableActions");
    expect(modalSource.indexOf("syncView.mutationResolution.previousAction")).toBeGreaterThan(
      modalSource.indexOf("syncView.mutationResolution.technicalDetails"),
    );
    // 2026-10-25: the reason line moved out of the collapsed evidence into the
    // body (before the table). With the actions relabelled as operations it is
    // the only line on the first screen saying why the review exists, and it
    // carries no {path} (the path shows in the table once, 2026-08-16).
    expect(modalSource.indexOf("syncView.mutationResolution.description")).toBeLessThan(
      modalSource.indexOf("syncView.mutationResolution.technicalDetails"),
    );
    expect(modalSource).not.toContain('"syncView.mutationResolution.description", {');
    expect(styles).not.toContain("easy-sync-comparison-previous-action");
    expect(styles).toMatch(
      /\.easy-sync-comparison-path-table\s*\{[^}]*table-layout:\s*fixed;/s,
    );
    expect(styles).toMatch(
      /\.easy-sync-comparison-path-table th,\s*\.easy-sync-comparison-path-table td\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(styles).not.toContain("easy-sync-detail-actions-mobile-stacked");
    expect(styles).not.toMatch(
      /body\.is-mobile \.easy-sync-detail-actions(?:\s|\{)/,
    );
    expect(styles).not.toMatch(
      /\.easy-sync-metadata-table\s*\{[^}]*table-layout:\s*fixed;/s,
    );
  });

  it("reuses the comparison modal and shared confirmation for one plugin bundle", () => {
    const viewSource = readSourceFile("src/ui/sync-view.ts");
    const modalSource = readSourceFile("src/ui/mutation-recovery-resolution-modal.ts");
    const start = viewSource.indexOf(
      "  private async openCommunityPluginBundleReview",
    );
    const end = viewSource.indexOf("\n  private renderHistorySection", start);
    const method = viewSource.slice(start, end);

    expect(method).toContain("if (this.mutationRecoveryResolutionOpening) return");
    expect(method.match(/new MutationRecoveryResolutionModal\(/g)).toHaveLength(1);
    expect(method).toContain(".getCommunityPluginBundleReviewSnapshot(pluginId)");
    expect(method).toContain("const snapshotPromise = this.plugin");
    expect(method).toContain("snapshotPromise,");
    expect(method.indexOf("new MutationRecoveryResolutionModal(")).toBeLessThan(
      method.indexOf("const snapshot = await snapshotPromise"),
    );
    expect(method).not.toContain("resolveConflictKeepLocal");
    expect(method).not.toContain("resolveConflictKeepRemote");
    expect(method).toContain("resolveMutationRecovery(snapshot, choice)");
    expect(method).toContain("confirmMutationResolutionDeletion(snapshot, choice)");
    expect(modalSource).toContain("bundle.executableChoices ?? []");
    expect(modalSource).toContain("Promise<MutationResolutionSnapshot | null>");
    expect(modalSource).toContain("await this.refreshComparison()");
    expect(modalSource).toContain('"syncView.pluginBundleReview.loading"');
    expect(modalSource).toContain('"syncView.conflict.keepLocal"');
    expect(modalSource).toContain('"syncView.conflict.keepRemote"');
    expect(modalSource).toContain('"syncView.pluginBundleReview.identityMismatchNotice"');
    expect(modalSource).toContain('reason === "identity-mismatch"');
    expect(viewSource).not.toContain("CommunityPluginBundleReviewModal");

    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    expect(zh.t("syncView.pluginBundleReview.open")).toBe("核对插件");
    expect(zh.t("syncView.conflict.keepLocal")).toBe("保留本机");
    expect(zh.t("syncView.conflict.keepRemote")).toBe("保留云端");
    expect(zh.t("syncView.mutationResolution.present", { size: "2.6 MB" }))
      .toBe("2.6 MB");
    expect(zh.t("syncView.pluginBundleReview.description", { name: "Resojot" }))
      .toContain("选择最终保留的版本");
    expect(en.t("syncView.pluginBundleReview.description", { name: "Resojot" }))
      .toContain("choose which version to keep");
    expect(zh.t("syncView.pluginBundleReview.viewDiff")).toBe("查看差异");
    expect(zh.t("syncView.pluginBundleReview.diffTitle", { name: "manifest.json" }))
      .toBe("manifest.json 差异");
  });

  it("requires a native confirmation and reuses the full-width primary action style for batch deletes", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const sectionStart = source.indexOf("private renderPendingSection");
    const sectionEnd = source.indexOf("private renderPendingIssue", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    // 批量门槛在显示行 builder（负责点随窗口化迁移）。
    const builderStart = source.indexOf("export function buildSyncPendingDisplayRows");
    const builder = source.slice(builderStart);
    expect(builder).toContain(
      "isBatchedDeleteSet(input.pendingDeletes.map((item) => `delete:${item.path}`))",
    );
    expect(section).toContain('createDiv("easy-sync-plan-execute")');
    expect(section).toContain('addClass("easy-sync-primary-actions")');
    expect(section).toContain('t("syncView.delete.confirmAll"');
    expect(section).toContain("new ConfirmModal(");
    expect(section).toContain('t("syncView.delete.confirmAllTitle"');
    expect(section).toContain('t("syncView.delete.confirmAllMessage"');
    expect(section).toContain('t("syncView.delete.confirmAllWarning"');
    expect(section).toContain("danger: true");
    expect(section).toContain(".awaitConfirm()");
    expect(section).toContain("if (!confirmed) return");
    expect(section).toContain("plugin.confirmRemoteDeletes");
    expect(section.indexOf("if (!confirmed) return")).toBeLessThan(
      section.indexOf("plugin.confirmRemoteDeletes"),
    );
    // 确认通过后立即进入官方 mod-loading 加载态（按钮旋转提示，而非卡死）。
    expect(section.indexOf('confirmAllButton.buttonEl.addClass("mod-loading")'))
      .toBeGreaterThan(section.indexOf("if (!confirmed) return"));
    expect(section.indexOf("confirmAllButton.setDisabled(true)")).toBeGreaterThan(
      section.indexOf('addClass("mod-loading")'),
    );
    // 整块重建后按 hasSideActionsInFlight 重新挂加载态，持续到整批结束。
    expect(section).toContain(
      "this.plugin.syncExecutor?.hasSideActionsInFlight",
    );
    expect(section).toContain("SyncActionType.ConfirmLocalDelete");
    // 加载态只数批量删除自己的那一块（本机独有批量行也有加载态，同族但另一件）。
    const batchSlice = source.slice(
      source.indexOf("private renderBatchDeleteRow("),
      source.indexOf("private renderUpdateAvailableItem("),
    );
    expect(batchSlice.match(/addClass\("mod-loading"\)/g)).toHaveLength(2);
    expect(batchSlice.match(/setDisabled\(true\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("releases the borrowed loading state on every row-action exit", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const start = source.indexOf("private enableActionButtons(");
    const end = source.indexOf("private async runItemAction(", start);
    const enable = source.slice(start, end);

    // 批量删除借官方 mod-loading 表示「处理中」，而只有整屏重建才会把它清掉；
    // 运行中的轮次只走轻量数字补丁，所以网关拒绝一次就会让按钮永久转圈
    // （iOS 2026-10-27）。行动作唯一的必达出口（runItemAction 的 finally）
    // 必须把加载态一起交还，终止条件不依赖重挂。
    expect(start).toBeGreaterThan(-1);
    expect(enable).toContain('removeClass("mod-loading")');
    expect(enable).toContain("disabled = false");
    const runStart = source.indexOf("private async runItemAction(");
    const runBody = source.slice(runStart, source.indexOf("\n  }\n", runStart));
    expect(runBody).toContain("this.enableActionButtons(actionsEl)");
  });
});

describe("buildSyncViewContentKey · local-only rows (片⑦ 修复)", () => {
  const pendingBase = {
    isLoggedIn: true,
    isInitializing: false,
    isPending: false,
    isRunning: false,
    canCancel: false,
    syncEntryInProgress: false,
    bodyMode: "pending" as const,
    progress: {
      phase: "idle" as const,
      current: 0,
      total: 0,
      currentFile: "",
      completedFiles: [],
      completedCount: 0,
      currentItemBytes: 0,
      currentItemTotalBytes: 0,
      cancelRequested: false,
    },
    planReviewActive: false,
    planReviewDetailsState: "ready" as const,
    pendingIssues: [],
    conflicts: [],
    pendingDeletes: [],
    planReviewCounts: null,
    planReviewRevision: 0,
    history: [],
    lastSyncTime: 0,
    mutationRecovery: null,
  };

  it("rebuilds when a local-only row is dismissed so it disappears immediately", () => {
    const row = {
      kind: "created" as const,
      path: "new-note.md",
      targetPath: "new-note.md",
    };
    const before = buildSyncViewContentKey(false, {
      ...pendingBase,
      localOnlyRows: [row],
    });
    // 忽略写入（「留在本机，不再提醒」）后行集合少一条，其它分量一字不变：
    // 指纹必须变化，否则重建被跳过、行要等下一轮同步才消失（移动端实测缺陷）。
    const after = buildSyncViewContentKey(false, {
      ...pendingBase,
      localOnlyRows: [],
    });
    expect(before).not.toBe(after);
    expect(before).toContain("localOnly:new-note.md:new-note.md:created");
    // 行集合不变 ⇒ 指纹不变（不为无关重渲染埋单）。
    expect(buildSyncViewContentKey(false, {
      ...pendingBase,
      localOnlyRows: [row],
    })).toBe(before);
  });

  it("rebuilds when an uploaded local-only entry retires, with the kind in the key", () => {
    const edited = {
      kind: "edited" as const,
      path: "note.md",
      targetPath: "note（副本）.md",
    };
    const withEntry = buildSyncViewContentKey(false, {
      ...pendingBase,
      localOnlyRows: [edited],
    });
    // 上传成功退场：条目退场 ⇒ 行集合变化 ⇒ 立即重建（不靠 side-action 进度分量）。
    expect(withEntry).not.toBe(buildSyncViewContentKey(false, {
      ...pendingBase,
      localOnlyRows: [],
    }));
    // 类别进指纹：同一路径换类别（改动副本 ↔ 新建）同样触发重建。
    expect(withEntry).not.toBe(buildSyncViewContentKey(false, {
      ...pendingBase,
      localOnlyRows: [{
        kind: "created",
        path: edited.targetPath,
        targetPath: edited.targetPath,
      }],
    }));
    // 无本机独有条目（双向／无记录）：带空数组与省略该字段同形，行为不变。
    expect(buildSyncViewContentKey(false, {
      ...pendingBase,
      localOnlyRows: [],
    })).toBe(buildSyncViewContentKey(false, pendingBase));
  });

  it("feeds the key and the pending section from the same single source", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const doRenderSlice = source.slice(
      source.indexOf("const contentKey = buildSyncViewContentKey("),
      source.indexOf("this.lastContentKey = contentKey"),
    );
    // 指纹与待处理区行读同一处（忽略记忆的过滤在 getLocalOnlyRows 内）。
    expect(doRenderSlice).toContain("localOnlyRows: this.plugin.getLocalOnlyRows()");
    expect(source).toContain("localOnlyRows: this.plugin.getLocalOnlyRows().filter(");
    // 指纹分量＝行 key（targetPath）＋类别，与行构建同键。
    const keyFn = source.slice(
      source.indexOf("export function buildSyncViewContentKey("),
      source.indexOf("if (input.bodyMode === \"recovery\")"),
    );
    expect(keyFn).toContain("localOnly:${localOnly}");
    expect(keyFn).toContain("${row.path}:${row.targetPath}:${row.kind}");
  });
});

describe("buildSyncViewContentKey · update reminder row (2026-10-13 修复)", () => {
  const base = {
    isLoggedIn: true,
    isInitializing: false,
    isPending: false,
    isRunning: false,
    canCancel: false,
    syncEntryInProgress: false,
    bodyMode: "pending" as const,
    progress: {
      phase: "idle" as const,
      current: 0,
      total: 0,
      currentFile: "",
      completedFiles: [],
      completedCount: 0,
      currentItemBytes: 0,
      currentItemTotalBytes: 0,
      cancelRequested: false,
    },
    planReviewActive: false,
    planReviewDetailsState: "ready" as const,
    pendingIssues: [],
    conflicts: [],
    pendingDeletes: [],
    planReviewCounts: null,
    planReviewRevision: 0,
    history: [],
    lastSyncTime: 0,
    mutationRecovery: null,
  };
  const prompt = { latest: "1.5.8", current: "1.5.7" };

  it("rebuilds when the update row appears, disappears or changes version", () => {
    const withPrompt = buildSyncViewContentKey(false, {
      ...base,
      updatePrompt: prompt,
    });
    // 出现 ⇒ 指纹必须变化；否则整屏重建被跳过、行不挂载（2026-10-13 实机：
    // 状态层已有新版、侧栏整行不可见）。
    expect(withPrompt).not.toBe(buildSyncViewContentKey(false, base));
    expect(withPrompt).toContain("update:1.5.8:1.5.7");
    // 确认跳过（提示消失）⇒ 指纹变化、行立即消失。
    expect(buildSyncViewContentKey(false, { ...base, updatePrompt: null }))
      .not.toBe(withPrompt);
    // 会话内出现更新版本 ⇒ 行文案变化同样触发重建。
    expect(buildSyncViewContentKey(false, {
      ...base,
      updatePrompt: { latest: "1.5.9", current: "1.5.7" },
    })).not.toBe(withPrompt);
    // 省略字段与显式 null 同形：无提示设备行为不变。
    expect(buildSyncViewContentKey(false, { ...base, updatePrompt: null }))
      .toBe(buildSyncViewContentKey(false, base));
  });

  it("carries the prompt in the plan and recovery fingerprints as well", () => {
    // 计划审阅与核对（recovery）体态不因提示出现而翻转模式：指纹不带提示时
    // 这两类体态下出现/消失都会被重建跳过（方案单 §四 要求行位于待审计划/
    // 核对行之后；2026-10-13 修复）。
    for (const bodyMode of ["pending", "plan", "recovery"] as const) {
      const scoped = { ...base, bodyMode };
      expect(buildSyncViewContentKey(false, { ...scoped, updatePrompt: prompt }))
        .not.toBe(buildSyncViewContentKey(false, scoped));
    }
  });

  it("renders the row at the tail of the plan and recovery bodies from the same source", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const dispatchSlice = source.slice(
      source.indexOf('if (bodyMode === "plan" && syncState)'),
      source.indexOf("if (this.historyExpanded)"),
    );
    expect(dispatchSlice).toContain('bodyMode === "plan" || bodyMode === "recovery"');
    expect(dispatchSlice).toContain(
      "this.renderUpdateAvailableItem(updateSection, updatePrompt)",
    );
    // 待处理区尾部保持原挂点（提示行在两处体态各自只挂一次）。
    expect(source).toContain(
      "if (updatePrompt) this.renderUpdateAvailableItem(section, updatePrompt)",
    );
    // 指纹与行渲染读同一取值源。
    const keyCall = source.slice(
      source.indexOf("const contentKey = buildSyncViewContentKey("),
      source.indexOf("this.lastContentKey = contentKey"),
    );
    expect(keyCall).toContain("updatePrompt,");
  });
});

describe("resolveSyncViewStatusDetailMode", () => {
  it("keeps the current full-sync file visible while its mutation receipt is in flight", () => {
    expect(resolveSyncViewStatusDetailMode({
      isRunning: true,
      activityKind: "fullSync",
      mutationRecoveryVisible: true,
    })).toBe("current-file");
  });

  it("keeps dedicated mutation recovery out of the fixed current-file slot", () => {
    expect(resolveSyncViewStatusDetailMode({
      isRunning: true,
      activityKind: "mutationRecovery",
      mutationRecoveryVisible: true,
    })).toBe("recovery");
  });
});

describe("resolveSyncViewStatusDetailText (片⑦ E1)", () => {
  const indicator = "（单向同步）";
  const oneWay = true;
  const twoWay = false;

  it("appends the one-way indicator after the timestamp in the idle state", () => {
    expect(resolveSyncViewStatusDetailText({
      timestampText: "10月12日 03:30",
      oneWay,
      oneWayIndicator: indicator,
    })).toBe("10月12日 03:30（单向同步）");
  });

  it("shows the indicator alone when there is no timestamp", () => {
    expect(resolveSyncViewStatusDetailText({
      timestampText: "",
      oneWay,
      oneWayIndicator: indicator,
    })).toBe("（单向同步）");
  });

  it("adds nothing in two-way mode", () => {
    expect(resolveSyncViewStatusDetailText({
      timestampText: "10月12日 03:30",
      oneWay: twoWay,
      oneWayIndicator: indicator,
    })).toBe("10月12日 03:30");
    expect(resolveSyncViewStatusDetailText({
      timestampText: "",
      oneWay: twoWay,
      oneWayIndicator: indicator,
    })).toBe("");
  });

  it("keeps the timestamp branch plain text: no control, no tooltip, no click", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const timestampBranch = source.slice(
      source.indexOf('if (this.statusDetailMode !== "timestamp")'),
      source.indexOf("private updateByteProgress("),
    );
    expect(timestampBranch).toContain("resolveSyncViewStatusDetailText(");
    expect(timestampBranch).toContain("this.statusDetailEl.setText(detailText)");
    // 纯文本、非按钮、不承担切换入口：不新增控件／事件／tooltip。
    expect(timestampBranch).not.toContain("createEl(");
    expect(timestampBranch).not.toContain("createSpan(");
    expect(timestampBranch).not.toContain("addEventListener");
    expect(timestampBranch).not.toContain("setTooltip");
    expect(timestampBranch).not.toContain("onClick");
  });

  it("leaves the three-state mechanism untouched and only wires the indicator into the idle state", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const modeStart = source.indexOf(
      "export function resolveSyncViewStatusDetailMode(",
    );
    // 只取三态判定函数本体（到它自己的收尾大括号），不含随后新增的拼接函数。
    const modeFn = source.slice(
      modeStart,
      source.indexOf("\n}\n", modeStart) + 2,
    );
    // 三态判定本体不含方向/标识事实（不得改动）。
    expect(modeFn).toContain('return "timestamp";');
    expect(modeFn).not.toContain("syncDirection");
    expect(modeFn).not.toContain("oneWay");
    expect(modeFn).not.toContain("status.mode.oneway");
    // 拼接只有一处调用（定义 1＋调用 1），且在 current-file／recovery 两个
    // 提前返回之后——同步中与恢复态看不到标识。
    expect(source.split("resolveSyncViewStatusDetailText(").length - 1).toBe(2);
    const call = source.indexOf("const detailText = resolveSyncViewStatusDetailText(");
    expect(call).toBeGreaterThan(source.indexOf('if (detailMode === "current-file")'));
    expect(call).toBeGreaterThan(source.indexOf('if (detailMode === "recovery")'));
  });
});

describe("resolveSyncViewBodyMode", () => {
  it("keeps pending items visible during side actions and shows the batch result after the last item", () => {
    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: false,
      pendingCount: 2,
      sideActionResultsVisible: true,
    })).toBe("pending");

    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: false,
      pendingCount: 0,
      sideActionResultsVisible: true,
    })).toBe("progress");

    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: false,
      pendingCount: 0,
      sideActionResultsVisible: false,
      mutationRecoveryVisible: false,
    })).toBe("idle");
  });

  it("gives a stable recovery its own body without displacing higher-priority content", () => {
    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: false,
      pendingCount: 0,
      sideActionResultsVisible: false,
      mutationRecoveryVisible: true,
    })).toBe("recovery");

    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: false,
      pendingCount: 1,
      sideActionResultsVisible: false,
      mutationRecoveryVisible: true,
    })).toBe("pending");
  });

  it("keeps a finished cloud verification failure in the progress body", () => {
    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: false,
      pendingCount: 0,
      sideActionResultsVisible: false,
      mutationRecoveryVisible: false,
      remoteScopeRecoveryFailureVisible: true,
    })).toBe("progress");

    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: false,
      pendingCount: 0,
      sideActionResultsVisible: false,
      mutationRecoveryVisible: true,
      remoteScopeRecoveryFailureVisible: true,
    })).toBe("recovery");
  });

  it("keeps pending rows visible while a full sync round runs, so other rows stay clickable (continuous click-in)", () => {
    // Adoption「下载并同步」starts a full sync round; the remaining pending
    // rows (other plugin proposals / conflicts / deletes) must stay visible
    // and clickable instead of being replaced by the progress body — the same
    // contract ordinary file-conflict rows already have via side actions.
    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: true,
      pendingCount: 3,
      sideActionResultsVisible: false,
    })).toBe("pending");

    expect(resolveSyncViewBodyMode({
      planReviewActive: false,
      hasSyncState: true,
      fullSyncRunning: true,
      pendingCount: 0,
      sideActionResultsVisible: false,
    })).toBe("progress");

    expect(resolveSyncViewBodyMode({
      planReviewActive: true,
      hasSyncState: true,
      fullSyncRunning: true,
      pendingCount: 2,
      sideActionResultsVisible: false,
    })).toBe("plan");
  });
});

describe("resolveSyncViewProgressPanelVisibility", () => {
  const cases: Array<{
    label: string;
    bodyMode: "plan" | "progress" | "pending" | "recovery" | "idle";
    sideActionResultsVisible: boolean;
    isRunning: boolean;
    progressTotal: number;
    expected: boolean;
  }> = [
    {
      label: "progress body owns the panel",
      bodyMode: "progress",
      sideActionResultsVisible: false,
      isRunning: true,
      progressTotal: 7,
      expected: true,
    },
    {
      label: "pending body with a running round that already has items",
      bodyMode: "pending",
      sideActionResultsVisible: false,
      isRunning: true,
      progressTotal: 7,
      expected: true,
    },
    {
      label: "pending body before the running round has any item total",
      bodyMode: "pending",
      sideActionResultsVisible: false,
      isRunning: true,
      progressTotal: 0,
      expected: false,
    },
    {
      label: "pending body with a finished round (idle)",
      bodyMode: "pending",
      sideActionResultsVisible: false,
      isRunning: false,
      progressTotal: 7,
      expected: false,
    },
    {
      label: "pending body showing a side-action result batch",
      bodyMode: "pending",
      sideActionResultsVisible: true,
      isRunning: false,
      progressTotal: 0,
      expected: true,
    },
    {
      label: "plan body while a round runs (bare bar only)",
      bodyMode: "plan",
      sideActionResultsVisible: false,
      isRunning: true,
      progressTotal: 7,
      expected: false,
    },
    {
      label: "recovery body while a round runs (bare bar only)",
      bodyMode: "recovery",
      sideActionResultsVisible: false,
      isRunning: true,
      progressTotal: 7,
      expected: false,
    },
    {
      label: "idle body",
      bodyMode: "idle",
      sideActionResultsVisible: false,
      isRunning: false,
      progressTotal: 0,
      expected: false,
    },
  ];

  it.each(cases)("$label ⇒ $expected", ({
    bodyMode,
    sideActionResultsVisible,
    isRunning,
    progressTotal,
    expected,
  }) => {
    expect(resolveSyncViewProgressPanelVisibility({
      bodyMode,
      sideActionResultsVisible,
      isRunning,
      progressTotal,
    })).toBe(expected);
  });

  it("mounts the shared progress panel above pending rows and never a second bar", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const dispatch = source.slice(
      source.indexOf("const content = container.createDiv"),
      source.indexOf("// 更新提示行：待处理区自带"),
    );
    // One predicate owns both decisions: mounting the panel and suppressing
    // the bare bar. Two independent checks could drift into a double bar.
    expect(dispatch).toContain("resolveSyncViewProgressPanelVisibility({");
    expect(dispatch).toContain("if (!progressPanelShown && isRunning)");
    const pendingStart = dispatch.indexOf('} else if (bodyMode === "pending") {');
    const pendingEnd = dispatch.indexOf('} else if (bodyMode === "recovery"');
    expect(pendingStart).toBeGreaterThan(-1);
    expect(pendingEnd).toBeGreaterThan(pendingStart);
    const pendingBranch = dispatch.slice(pendingStart, pendingEnd);
    expect(pendingBranch).toContain("if (progressPanelShown) {");
    expect(pendingBranch).toContain("this.renderProgressPanel(content, progress);");
    // Completed list first, pending rows after: the action rows keep their
    // order and stay the last thing in the body.
    expect(
      pendingBranch.indexOf("this.renderProgressPanel(content, progress);"),
    ).toBeLessThan(pendingBranch.indexOf("this.renderPendingSection("));
  });

  it("keeps the incremental completed-row path in a running pending body", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const patchStart = source.indexOf("this.updateStatusPanel(statusState);");
    const patchEnd = source.indexOf("this.lastContentKey = contentKey;");
    expect(patchStart).toBeGreaterThan(-1);
    expect(patchEnd).toBeGreaterThan(patchStart);
    const patch = source.slice(patchStart, patchEnd);
    expect(patch).toContain("if (isRunning) {");
    expect(patch).toContain("this.appendNewFileRows(progress.completedFiles);");
    // The append path stays body-mode agnostic: it fills whatever panel the
    // rebuild mounted and no-ops when there is none, so the pending body uses
    // the exact same incremental path as the progress body.
    const appendStart = source.indexOf("private appendNewFileRows");
    const appendEnd = source.indexOf("private appendCompletedActionRows");
    expect(appendStart).toBeGreaterThan(-1);
    expect(appendEnd).toBeGreaterThan(appendStart);
    const append = source.slice(appendStart, appendEnd);
    expect(append).not.toContain("bodyMode");
    expect(append).toContain("!this.progressPanelEl");
  });

  it("rebuilds the pending body when the round becomes mountable, not per completed file", () => {
    const base = {
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: true,
      canCancel: true,
      syncEntryInProgress: false,
      bodyMode: "pending" as const,
      progress: {
        phase: "executing" as const,
        current: 0,
        total: 0,
        currentFile: "",
        completedFiles: [],
        completedCount: 0,
        currentItemBytes: 0,
        currentItemTotalBytes: 0,
        cancelRequested: false,
        startedAt: 1,
      },
      planReviewActive: false,
      planReviewDetailsState: "ready" as const,
      pendingIssues: [],
      conflicts: [],
      pendingDeletes: [],
      planReviewCounts: null,
      planReviewRevision: 0,
      history: [],
      lastSyncTime: 0,
      mutationRecovery: null,
    };
    const before = buildSyncViewContentKey(false, base);
    const mountable = {
      ...base,
      progress: { ...base.progress, total: 7 },
    };
    // The list is mount-only content: without this bit the panel could never
    // appear when the round's first item total lands mid-render.
    expect(buildSyncViewContentKey(false, mountable)).not.toBe(before);
    // Per-file changes stay out of the pending fingerprint: the panel is up,
    // so the incremental append owns them (no full rebuild per completed file).
    expect(buildSyncViewContentKey(false, {
      ...mountable,
      progress: {
        ...mountable.progress,
        current: 1,
        completedFiles: [{
          path: "a.md",
          status: "upload" as const,
          actionType: SyncActionType.Upload,
        }],
        completedCount: 1,
      },
    })).toBe(buildSyncViewContentKey(false, mountable));
  });
});

describe("remote scope recovery failure presentation", () => {
  it("keeps the failure path in persistent body content", () => {
    const i18n = new I18n("zh-cn");

    expect(resolveRemoteScopeRecoveryFailurePresentation({
      operationFingerprint: "operation-1",
      protocolPreflight: "ready",
      total: 3,
      verifiedThisRun: 1,
      reused: 0,
      invalidated: 0,
      remaining: 2,
      failureStage: "body-verification",
      firstFailurePath: "Resources/long/path/file.md",
    }, i18n.t.bind(i18n))).toEqual({
      title: "云端核验",
      summary: "云端文件核验未完成，本轮同步已停止。",
      path: "Resources/long/path/file.md",
    });
  });

  it("carries no per-section next-step line (retry lives in the top primary action)", () => {
    const viewSource = readSourceFile("src/ui/sync-view.ts");
    const start = viewSource.indexOf(
      "  private renderRemoteScopeRecoveryFailure(",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const end = viewSource.indexOf("\n  private ", start + 1);
    const method = viewSource.slice(start, end < 0 ? undefined : end);
    expect(method).not.toContain("next-step");
    expect(method).not.toContain("nextStep");
  });

  it("mounts the failure section under the view content, not inside the progress panel", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const panel = source.slice(
      source.indexOf("private renderProgressPanel"),
      source.indexOf("private renderRemoteScopeRecoveryFailure"),
    );
    // Both containers draw their own `border-top`; nesting the section inside
    // the panel therefore produced two rules just above the section title.
    expect(panel).not.toContain("renderRemoteScopeRecoveryFailure");
    expect(panel).not.toContain("!state.recoveryVerification");
    const dispatch = source.slice(
      source.indexOf("const content = container.createDiv"),
      source.indexOf("// 更新提示行：待处理区自带"),
    );
    expect(dispatch).toMatch(
      /this\.renderRemoteScopeRecoveryFailure\(\s*content,\s*progress\.recoveryVerification,?\s*\)/,
    );
    expect(dispatch.indexOf("renderRemoteScopeRecoveryFailure")).toBeLessThan(
      dispatch.indexOf("this.renderPendingSection"),
    );
  });

  it("does not mount an empty progress panel when only the failure section is present", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      renderProgressPanel: (
        container: HTMLElement,
        state: Record<string, unknown>,
      ) => void;
    };
    const container = createFakeHistoryElement("div", "easy-sync-view-content");
    view.renderProgressPanel(
      container as unknown as HTMLElement,
      {
        phase: "idle",
        current: 0,
        total: 0,
        currentFile: "",
        currentItemBytes: 0,
        currentItemTotalBytes: 0,
        cancelRequested: false,
        completedFiles: [],
        completedCount: 0,
        startedAt: 0,
        recoveryVerification: {
          operationFingerprint: "operation-1",
          protocolPreflight: "blocked",
          total: 0,
          verifiedThisRun: 0,
          reused: 0,
          invalidated: 0,
          remaining: 0,
          failureStage: "protocol-preflight",
        },
      },
    );
    expect(container.children).toHaveLength(0);
  });
});

describe("sync view attention presentation", () => {
  it("keeps pending sign-in and recovery checking concise in the fixed top status", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };
    const baseState = {
      isInitializing: false,
      isRunning: false,
      lastSyncTime: 0,
      pendingCount: 0,
      planReviewActive: false,
      autoSyncPaused: false,
      progress: { cancelRequested: false },
    };

    expect(view.getStatusPresentation({
      ...baseState,
      isLoggedIn: false,
      isPending: true,
      mutationRecovery: null,
    })).toEqual({ status: "loggedOut", label: "等待登录" });

    expect(view.getStatusPresentation({
      ...baseState,
      isLoggedIn: true,
      isPending: false,
      mutationRecovery: {
        kind: "checking",
        total: 2,
        settled: 0,
        remaining: 2,
        retryAt: null,
        firstPath: "notes/a.md",
        blockReason: null,
      },
    })).toEqual({ status: "attention", label: "正在核对" });
  });

  it("uses the verification phase without exposing exact execution actions in the fixed top status", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };

    expect(view.getStatusPresentation({
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: true,
      lastSyncTime: 0,
      pendingCount: 0,
      planReviewActive: false,
      autoSyncPaused: false,
      mutationRecovery: null,
      progress: {
        phase: "executing",
        currentActionType: SyncActionType.MoveRemoteFolder,
        cancelRequested: false,
      },
    })).toEqual({ status: "syncing", label: "同步进行中…" });

    expect(view.getStatusPresentation({
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: true,
      lastSyncTime: 0,
      pendingCount: 0,
      planReviewActive: true,
      autoSyncPaused: false,
      mutationRecovery: null,
      progress: {
        phase: "verifying",
        current: 46,
        total: 58,
        cancelRequested: false,
      },
    })).toEqual({ status: "syncing", label: "验证文件一致性…" });
  });

  it("shows stage-level short statuses in the fixed top for every non-executing phase", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };

    const cases: Array<{ phase: string; current?: number; total?: number; label: string }> = [
      { phase: "scanning", label: "扫描本机文件…" },
      { phase: "preparing", label: "准备云端存储…" },
      { phase: "baseline", label: "加载云端基线…" },
      { phase: "checking", label: "检查云端变更…" },
      { phase: "planning", label: "生成同步计划…" },
      { phase: "verifying", current: 3, total: 7, label: "验证文件一致性…" },
    ];

    for (const entry of cases) {
      expect(view.getStatusPresentation({
        isLoggedIn: true,
        isInitializing: false,
        isPending: false,
        isRunning: true,
        lastSyncTime: 0,
        pendingCount: 0,
        planReviewActive: false,
        autoSyncPaused: false,
        mutationRecovery: null,
        progress: {
          phase: entry.phase,
          current: entry.current ?? 0,
          total: entry.total ?? 0,
          cancelRequested: false,
        },
      })).toEqual({ status: "syncing", label: entry.label });
    }
  });

  it("keeps executing with an exact action generic in the fixed top status", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };

    // Even with an exact action in flight, the fixed top stays generic:
    // exact action labels belong to Notice / Ribbon / progress body (S4).
    expect(view.getStatusPresentation({
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: true,
      lastSyncTime: 0,
      pendingCount: 0,
      planReviewActive: false,
      autoSyncPaused: false,
      mutationRecovery: null,
      progress: {
        phase: "executing",
        currentActionType: SyncActionType.Upload,
        cancelRequested: false,
      },
    })).toEqual({ status: "syncing", label: "同步进行中…" });

    // Executing without an exact action stays generic as well.
    expect(view.getStatusPresentation({
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: true,
      lastSyncTime: 0,
      pendingCount: 0,
      planReviewActive: false,
      autoSyncPaused: false,
      mutationRecovery: null,
      progress: {
        phase: "executing",
        cancelRequested: false,
      },
    })).toEqual({ status: "syncing", label: "同步进行中…" });
  });

  it("shows the current state as synced after resolved decisions release their pause", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };

    expect(view.getStatusPresentation({
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: false,
      lastSyncTime: 1,
      pendingCount: 0,
      planReviewActive: false,
      autoSyncPaused: false,
      mutationRecovery: null,
      latestHistory: {
        status: "partial",
        conflicts: 2,
        errors: 0,
      },
      progress: { cancelRequested: false },
    })).toEqual({ status: "success", label: "已同步" });
  });

  it("shows the connecting form when the latest round is a retry-pending observation and the device reports a network", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };
    const baseState = {
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: false,
      lastSyncTime: 1,
      pendingCount: 0,
      planReviewActive: false,
      autoSyncPaused: false,
      mutationRecovery: null,
      progress: { cancelRequested: false },
    };
    const latestHistory = {
      status: "retry-pending",
      conflicts: 0,
      errors: 0,
    };

    // The latest round was a remote-read miss: the stale "synced" green from
    // the last healthy round must not imply the vault is in sync. The system
    // flag does not say offline, so there is no network claim either — the
    // neutral connecting form (same as cold start / session-pending).
    expect(view.getStatusPresentation({
      ...baseState,
      latestHistory,
    })).toEqual({ status: "ready", label: "连接中…" });

    // A pending item still outranks the retry notice: unresolved conflicts or
    // deletes must not be hidden behind it.
    expect(view.getStatusPresentation({
      ...baseState,
      pendingCount: 2,
      latestHistory,
    })).toEqual({ status: "attention", label: "需要处理 2" });
  });

  it("keeps the offline top status for a retry-pending round when the system reports the device offline", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };
    const baseState = {
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: false,
      lastSyncTime: 1,
      pendingCount: 0,
      planReviewActive: false,
      autoSyncPaused: false,
      mutationRecovery: null,
      progress: { cancelRequested: false },
    };
    const latestHistory = {
      status: "retry-pending",
      conflicts: 0,
      errors: 0,
    };

    vi.stubGlobal("navigator", { onLine: false });
    try {
      expect(view.getStatusPresentation({
        ...baseState,
        latestHistory,
      })).toEqual({ status: "offline", label: "无网络连接" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the top status generic when only community plugin decisions remain", () => {
    const view = Object.create(EasySyncSyncView.prototype) as {
      plugin: { i18n: I18n };
      getStatusPresentation: (state: Record<string, unknown>) => {
        status: string;
        label: string;
      };
    };
    view.plugin = { i18n: new I18n("zh-cn") };

    expect(view.getStatusPresentation({
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: false,
      lastSyncTime: 0,
      pendingCount: 1,
      communityPluginEnablementPending: 1,
      planReviewActive: false,
      autoSyncPaused: true,
      mutationRecovery: null,
      progress: { cancelRequested: false },
    })).toEqual({ status: "attention", label: "需要处理 1" });
  });
});

describe("resolveSyncViewPrimaryAction (finding ⑧, C9 P1)", () => {
  const baseInput = {
    isLoggedIn: true,
    isRunning: false,
    canCancel: false,
    planReviewActive: false,
    planReviewDetailsState: "ready" as const,
    reviewKind: null,
    recoveryActionKey: null,
    isInitializing: false,
    isPending: false,
    devicePending: false,
  };

  it("keeps the sync-now button for a logged-in recovery state without a real action (P1 regression)", () => {
    // waiting-network/checking/blocked with recoveryActionKey=null: the old
    // chain tail fell through to the login button, which was dead for an
    // already-logged-in user. The fixed top primary button must stay a
    // working sync-now button.
    expect(resolveSyncViewPrimaryAction({
      ...baseInput,
      recoveryActionKey: null,
    })).toEqual({ kind: "sync-now" });
  });

  it("shows the login button only when not logged in", () => {
    expect(resolveSyncViewPrimaryAction({
      ...baseInput,
      isLoggedIn: false,
    })).toEqual({
      kind: "auth",
      labelKey: "settings.account.login",
      cta: true,
      disabled: false,
    });
  });

  it("shows a real recovery action when the recovery state has one", () => {
    expect(resolveSyncViewPrimaryAction({
      ...baseInput,
      recoveryActionKey: "syncView.recovery.retryScopeRecovery",
    })).toEqual({
      kind: "recovery",
      actionKey: "syncView.recovery.retryScopeRecovery",
    });
  });

  it("shows the plan-review confirm button while a reviewed plan is ready", () => {
    expect(resolveSyncViewPrimaryAction({
      ...baseInput,
      planReviewActive: true,
    })).toEqual({
      kind: "plan-review-confirm",
      migration: false,
    });
    expect(resolveSyncViewPrimaryAction({
      ...baseInput,
      planReviewActive: true,
      reviewKind: "v2-migration",
    })).toEqual({
      kind: "plan-review-confirm",
      migration: true,
    });
  });

  it("shows cancel while a cancellable sync is running", () => {
    expect(resolveSyncViewPrimaryAction({
      ...baseInput,
      isRunning: true,
      canCancel: true,
    })).toEqual({ kind: "cancel" });
  });

  it("shows the pending browser-confirm action for a logged-out pending login", () => {
    expect(resolveSyncViewPrimaryAction({
      ...baseInput,
      isLoggedIn: false,
      isPending: true,
    })).toEqual({
      kind: "auth",
      labelKey: "settings.account.confirmAfterBrowser",
      cta: true,
      disabled: false,
    });
  });
});

describe("continuous click-in for resolution rows", () => {
  it("filters pendingIssues by queued side-action paths like conflicts and deletes", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const renderStart = source.indexOf("const pendingIssues = ");
    const slice = source.slice(
      renderStart,
      renderStart + 400,
    );
    expect(slice).toContain(
      "syncState?.pendingIssues ?? []",
    );
    expect(slice).toContain(
      "isSideActionQueued(item.path)",
    );
    // The filter must apply before grouping, so a queued resolution row
    // disappears from the pending list the moment its side action is queued.
    expect(source.indexOf("const pendingIssues = ")).toBeLessThan(
      source.indexOf("const pendingIssueGroups = groupPendingIssuesForReview("),
    );
  });

  it("releases each resolution guard before the settlement call, not after the full round", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const cases = [
      {
        open: "  private async openStaleIdentityResolution(",
        guard: "this.staleIdentityResolutionOpening = false;",
        settle: "this.plugin.retireReviewedStaleIdentity(snapshot)",
      },
      {
        open: "  private async openSharedFolderIdentityResolution(",
        guard: "this.sharedFolderIdentityResolutionOpening = false;",
        settle: "this.plugin.confirmReviewedSharedFolderIdentity(snapshot)",
      },
      {
        open: "  private async openScopeCrossingRestore(",
        guard: "this.scopeCrossingResolutionOpening = false;",
        settle: "this.plugin.restoreScopeCrossingMove(snapshot)",
      },
      {
        open: "  private async openScopeCrossingConfirm(",
        guard: "this.scopeCrossingResolutionOpening = false;",
        settle: "this.plugin.confirmScopeCrossingExit(snapshot)",
      },
      {
        open: "  private async openFolderLocationResolution(",
        guard: "this.emptyFolderResolutionOpening = false;",
        settle: "this.plugin.resolveReviewedFolderLocation(",
      },
      {
        open: "  private async openEmptyFolderResolution(",
        guard: "this.emptyFolderResolutionOpening = false;",
        settle: "this.plugin.restoreReviewedFolderSubtree(subtree)",
      },
    ];
    for (const { open, guard, settle } of cases) {
      const start = source.indexOf(open);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("\n  private async ", start + 1);
      const method = source.slice(start, end < 0 ? undefined : end);
      expect(method.indexOf(guard)).toBeGreaterThanOrEqual(0);
      expect(method.indexOf(settle)).toBeGreaterThanOrEqual(0);
      expect(method.indexOf(guard)).toBeLessThan(
        method.indexOf(settle),
      );
    }
  });

  it("holds a per-row guard so the same row cannot decide twice while settling", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const cases = [
      { open: "  private async openStaleIdentityResolution(", key: "stale:" },
      {
        open: "  private async openSharedFolderIdentityResolution(",
        key: "shared-folder:",
      },
      { open: "  private async openEmptyFolderResolution(", key: "empty-folder:" },
      {
        open: "  private async openFolderLocationResolution(",
        key: "folder-location:",
      },
      {
        open: "  private async openScopeCrossingRestore(",
        key: "scope-crossing:",
      },
      {
        open: "  private async openScopeCrossingConfirm(",
        key: "scope-crossing:",
      },
      {
        open: "  private async openMutationRecoveryResolution(",
        key: "mutation-recovery",
      },
      {
        open: "  private async openCommunityPluginBundleReview(",
        key: "bundle-review:",
      },
    ];
    for (const { open, key } of cases) {
      const start = source.indexOf(open);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf("\n  private async ", start + 1);
      const method = source.slice(start, end < 0 ? undefined : end);
      expect(method).toContain("const rowKey = ");
      expect(method).toContain(key);
      expect(method).toContain("if (!this.lockResolutionRow(rowKey)) return;");
      expect(method).toContain("this.unlockResolutionRow(rowKey);");
      // The row guard must be claimed before the settlement and released in
      // the method's finally, so a cancelled modal never leaves a stuck row.
      expect(method.indexOf("lockResolutionRow(rowKey)")).toBeLessThan(
        method.indexOf("await this.plugin."),
      );
      expect(method.indexOf("unlockResolutionRow(rowKey)")).toBeGreaterThan(
        method.indexOf("await this.plugin."),
      );
    }
  });

  it("routes every resolution entry's unavailable cause through the shared mapping", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const cases = [
      {
        open: "  private async openStaleIdentityResolution(",
        factsChanged: '"notice.staleIdentity.changed",',
      },
      {
        open: "  private async openSharedFolderIdentityResolution(",
        factsChanged: '"notice.sharedFolderIdentity.changed",',
        nameMismatch: '"notice.sharedFolderIdentity.nameMismatch",',
      },
      {
        open: "  private async openScopeCrossingRestore(",
        factsChanged: '"notice.scopeCrossing.changed",',
      },
      {
        open: "  private async openScopeCrossingConfirm(",
        factsChanged: '"notice.scopeCrossing.changed",',
      },
    ];
    for (const entry of cases) {
      const start = source.indexOf(entry.open);
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(
        start,
        source.indexOf("\n  private async", start + 1),
      );
      // 入口只读快照为空时必须说出真正原因，不再一律报"事实已变化"。
      expect(body).toContain("this.notifyResolutionEntryUnavailable(");
      expect(body).toContain(entry.factsChanged);
      if (entry.nameMismatch) expect(body).toContain(entry.nameMismatch);
      expect(body).not.toMatch(/if \(!snapshot\) \{\s*new Notice\(/);
    }
  });
});

describe("scope-crossing row exit gating", () => {
  it("renders exit chips and the folder exit text only when a covering move hint exists", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const renderStart = source.indexOf("  private renderPendingIssue(");
    const renderEnd = source.indexOf(
      "\n  private async openStaleIdentityResolution(",
      renderStart,
    );
    const render = source.slice(renderStart, renderEnd);
    // 出口判定读当前去向记录（与行动侧快照同一规则负责点），在渲染体内计算。
    expect(render).toContain(
      "this.plugin.state?.getScopeCrossingExitKind(issue.path)",
    );
    // 双 chip 分支以出口存在为前提（出口种类由 `pendingIssueExitKind` 单点
    // 判定，2026-10-17 S4 逐字改写：原来这里直接比对 issueCode 条件，现在
    // 渲染按种类分发，判定侧读同一函数）；无出口（漂移/设置形态）行不再有
    // 通用兜底重试按钮——重试统一走顶部主动作（2026-09-16 按钮清理）。
    expect(render).toContain('case "scope-crossing":');
    const branchStart = render.indexOf('case "scope-crossing":');
    const fallback = render.slice(branchStart);
    expect(fallback).not.toContain("formatPendingIssueActionLabel");
    expect(fallback).not.toContain("startManualSync");
    // 文件夹出口行的行文替换为出口句；文件行与漂移行保留计划层 reason 文本。
    expect(render).toContain('"syncView.scopeCrossing.rowReasonFolder"');
  });

  it("keeps the covering-hint rule owned by the resolution module", () => {
    const resolution = readSourceFile("src/sync/scope-crossing-resolution.ts");
    expect(resolution).toContain("export function findScopeCrossingCoveringHintV1(");
    expect(resolution).toContain("buildScopeCrossingResolutionSnapshotV1");
    const stateManager = readSourceFile("src/sync/state-manager.ts");
    expect(stateManager).toContain("findScopeCrossingCoveringHintV1(path, {");
    expect(stateManager).toContain("getScopeCrossingExitKind(path: string)");
  });

  it("names the moved object in the confirm exit dialog", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    // 行内确认弹框必须点名被移出的对象，否则用户无法判断这条提示指向哪个
    // 文件或文件夹（「撤销移动」弹框此前就是这个写法）。
    const confirmStart = source.indexOf(
      "  private async openScopeCrossingConfirm(",
    );
    expect(confirmStart).toBeGreaterThanOrEqual(0);
    const openEnd = source.indexOf("\n  private async ", confirmStart + 1);
    const confirm = source.slice(
      confirmStart,
      openEnd < 0 ? undefined : openEnd,
    );
    expect(confirm).toContain('"syncView.scopeCrossing.confirmMessageFolder"');
    expect(confirm).toContain('"syncView.scopeCrossing.confirmMessageFile"');
    expect(confirm).toContain("path: snapshot.fromPath");
  });
});

describe("history section lazy entry bodies", () => {
  const source = readSourceFile("src/ui/sync-view.ts");

  it("mounts collapsed history run bodies lazily on first toggle", () => {
    // 懒建形态:默认展开轮同步建,收起轮首次 toggle 才建详情——
    // 打开历史区的主要 DOM 成本(10 轮×≤100 文件行)不再一次性挂载。
    expect(source).toContain("renderHistoryEntryBody(body, entry)");
    expect(source).toContain('addEventListener("toggle"');
    expect(source).toContain("firstElementChild === null");
    expect(source).toMatch(/const initiallyOpen = index === 0 && entry\.status !== "success";/);
    expect(source).toMatch(/details\.open = initiallyOpen;/);
  });

  it("keeps the entry body content contract in the lazy builder", () => {
    // 搬移保真:详情段全部呈现(meta/result/counts/noFileChanges/recovery/
    // 文件行+跳过折叠组)由 renderHistoryEntryBody 承接,内容零删减。
    const fn = source.match(
      /private renderHistoryEntryBody\([\s\S]*?\): void \{[\s\S]*?\n  \}/,
    );
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain("easy-sync-history-meta");
    expect(body).toContain("easy-sync-history-result");
    expect(body).toContain("easy-sync-history-counts");
    expect(body).toContain("formatMutationRecoveryHistory");
    expect(body).toContain("renderFileResults");
    // 跳过折叠组随共享化移到 createSkipFold（运行中与历史同一个折叠件），
    // 行由当轮发行行＋保留路径合并而来（2026-10-25）。
    expect(body).toContain("collectHistorySkipRows({");
    expect(body).toContain("this.createSkipFold(body, skip.rows, skip.total)");
    expect(body).toContain("syncView.history.skipOmitted");
    expect(body).toContain("syncView.history.noFileChanges");
    expect(body).toContain("formatSyncHistoryCounts");
  });
});

describe("sync entry window presentation (2026-10-10 拍板)", () => {
  const viewSource = readSourceFile("src/ui/sync-view.ts");
  const mainSource = readSourceFile("src/main.ts");

  const baseState = () => ({
    isLoggedIn: true,
    isInitializing: false,
    isPending: false,
    sessionPending: false,
    isRunning: false,
    syncEntryInProgress: false,
    lastSyncTime: 0,
    pendingCount: 0,
    planReviewActive: false,
    planReviewRefreshed: false,
    autoSyncPaused: false,
    mutationRecovery: null,
    latestHistory: undefined,
    progress: {
      phase: "idle" as const,
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
    },
  });

  const presentationFor = (state: Record<string, unknown>) => {
    // 与三载体一致性门同一手法：原型对象上调用真方法，只喂状态。
    const view = Object.create(EasySyncSyncView.prototype) as never as {
      plugin: { i18n: I18n };
      getStatusPresentation: (s: unknown) => { status: string; label: string };
    };
    const i18n = new I18n("zh-cn");
    view.plugin = { i18n };
    return { presentation: view.getStatusPresentation(state), i18n };
  };

  it("reads 同步进行中… for the entry window instead of 尚未同步", () => {
    // 从未同步的库在检测/准备期（点同步后、执行器开跑前）：主状态行落运行档并
    // 复用现役 syncView.progress——这就是报障里的「尚未同步」空窗期。
    const { presentation, i18n } = presentationFor({
      ...baseState(),
      syncEntryInProgress: true,
    });
    expect(presentation).toEqual({
      status: "syncing",
      label: i18n.t("syncView.progress"),
    });
  });

  it("falls back to 尚未同步 / 已同步 once the window closes", () => {
    const never = presentationFor(baseState());
    expect(never.presentation).toEqual({
      status: "ready",
      label: never.i18n.t("syncView.never"),
    });

    const synced = presentationFor({ ...baseState(), lastSyncTime: 1 });
    expect(synced.presentation).toEqual({
      status: "success",
      label: synced.i18n.t("syncView.status.synced"),
    });
  });

  it("splits the content key so the panel rebuilds when the window opens or closes", () => {
    const key = (syncEntryInProgress: boolean) => buildSyncViewContentKey(false, {
      ...baseState(),
      bodyMode: "idle",
      pendingIssues: [],
      conflicts: [],
      pendingDeletes: [],
      adoptionRows: [],
      planReviewDetailsState: "ready",
      planReviewCounts: null,
      planReviewRevision: 0,
      history: [],
      syncEntryInProgress,
    } as never);

    expect(key(true)).toContain("run:0:0:1");
    expect(key(false)).toContain("run:0:0:0");
    expect(key(true)).not.toBe(key(false));
  });

  it("keeps the composing order literal (entry window is not cancellable)", () => {
    // 入口占用并进运行档时 canCancel 仍为假 ⇒ 落现役的禁用「处理中…」，
    // 而不是一颗点了只弹 busy 的「立即同步」。
    expect(resolveSyncViewPrimaryAction({
      isLoggedIn: true,
      isRunning: true,
      canCancel: false,
      planReviewActive: false,
      planReviewDetailsState: "ready",
      reviewKind: null,
      recoveryActionKey: null,
      isInitializing: false,
      isPending: false,
      devicePending: false,
    })).toEqual({ kind: "processing" });
  });

  it("wires the same fact into the status line, the action and the other carriers", () => {
    // 源码守卫（按钮渲染是 DOM 重路径，正向行为由三载体一致性门覆盖）。
    expect(viewSource).toContain("syncing: state.isRunning || state.syncEntryInProgress,");
    expect(viewSource).toContain("isRunning: state.isRunning || state.syncEntryInProgress,");
    // 入口只读准备期 armed 时主动作必须变可取消（R1）——落点在 canCancel 组合。
    expect(viewSource).toContain(
      "const canCancel = fullSyncRunning || this.plugin.isSyncEntryCancellable;",
    );
    expect(mainSource).toContain('case "sync": return "status.syncing";');
    expect(mainSource).toContain("|| this.isSyncEntryInProgress,");

    // 锁取得/释放时侧栏必须跟着重绘：只刷状态栏会让面板停在点同步前的样子。
    const acquireStart = mainSource.indexOf("private acquireOpLock");
    const releaseStart = mainSource.indexOf("\n  private releaseOpLock", acquireStart);
    const opHolderStart = mainSource.indexOf(
      "\n  /** Status-bar phrase for one held-lock moment",
      releaseStart,
    );
    expect(acquireStart).toBeGreaterThan(-1);
    expect(releaseStart).toBeGreaterThan(acquireStart);
    expect(mainSource.slice(acquireStart, releaseStart)).toContain("this.syncView?.render();");
    expect(mainSource.slice(releaseStart, opHolderStart)).toContain("this.syncView?.render();");
  });
});

describe("one-way local-only rows (片④)", () => {
  it("builds one actionable row per record, after deletes and before read-only skips", () => {
    const rows = buildSyncPendingDisplayRows({
      adoptionRows: [],
      failures: [{
        issue: {
          path: "retry.md",
          actionType: SyncActionType.RetryLater,
          updatedAt: 1,
        },
        nestedIssues: [],
      }],
      conflictEntries: [],
      pendingDeletes: [{ type: SyncActionType.ConfirmLocalDelete, path: "d.md" }],
      skipped: [{
        issue: {
          path: "big.bin",
          actionType: SyncActionType.SkipLargeFile,
          updatedAt: 1,
        },
        nestedIssues: [],
      }],
      localOnlyRows: [
        {
          kind: "edited",
          path: "note.md",
          targetPath: "note（副本 2026-10-11 2345）.md",
        },
        { kind: "created", path: "new-note.md", targetPath: "new-note.md" },
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "issue",
      "delete",
      // 件②：缺省 ≥2 条本机独有条目 ⇒ 这一族顶部多一条批量处置行。
      "batchLocalOnly",
      "localOnly",
      "localOnly",
      "issue",
    ]);
    expect(rows[3].key).toBe("localOnly:note（副本 2026-10-11 2345）.md");
    expect(rows[3].localOnly).toEqual({
      kind: "edited",
      path: "note.md",
      targetPath: "note（副本 2026-10-11 2345）.md",
    });
    expect(rows[4].key).toBe("localOnly:new-note.md");
    // 「需要处理 N」是全量真值：计数来自行集，不看窗口；批量行不改逐条行数。
    expect(rows.filter((row) => row.kind === "localOnly")).toHaveLength(2);
    // 批量行动作作用在整份清单上（顺序＝逐条行顺序）。
    expect(rows[2].key).toBe("batch-localOnly");
    expect(rows[2].localOnlyBatch?.map((entry) => entry.targetPath)).toEqual([
      "note（副本 2026-10-11 2345）.md",
      "new-note.md",
    ]);

    // 只有一条本机独有条目时没有批量入口：单行仍默认展开、出口第一眼可见。
    const single = buildSyncPendingDisplayRows({
      adoptionRows: [],
      failures: [],
      conflictEntries: [],
      pendingDeletes: [],
      skipped: [],
      localOnlyRows: [
        { kind: "created", path: "only.md", targetPath: "only.md" },
      ],
    });
    expect(single.map((row) => row.kind)).toEqual(["localOnly"]);
    expect(resolveDecisionRowDefaultOpen("localOnly:only.md", {})).toBe(true);
  });

  it("puts a retained-folder note above its local-only rows and drops it when every file is ignored", () => {
    const retained = {
      issue: {
        path: "notes",
        actionType: SyncActionType.FolderDeferred,
        issueCode: "one-way-folder-retained" as const,
        reason: "云端文件夹已删，本机残留未处理内容。",
        updatedAt: 1,
      },
      nestedIssues: [],
    };
    const rows = buildSyncPendingDisplayRows({
      adoptionRows: [],
      failures: [],
      conflictEntries: [],
      pendingDeletes: [],
      skipped: [],
      localOnlyRows: [
        { kind: "created", path: "notes/a.md", targetPath: "notes/a.md" },
        { kind: "created", path: "other.md", targetPath: "other.md" },
        { kind: "created", path: "notes/sub/b.md", targetPath: "notes/sub/b.md" },
      ],
      retainedFolders: [retained],
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "batchLocalOnly",
      "retainedFolder",
      "localOnly",
      "localOnly",
      "localOnly",
    ]);
    expect(rows[1].key).toBe("retainedFolder:notes");
    expect(rows[1].issue).toBe(retained.issue);
    expect(rows[2].localOnly?.targetPath).toBe("notes/a.md");
    expect(rows[3].localOnly?.targetPath).toBe("notes/sub/b.md");
    expect(rows[4].localOnly?.targetPath).toBe("other.md");

    // All files below the retained folder are ignored: the folder stays, but
    // the reminder row has no actionable file to explain and must disappear.
    const ignored = buildSyncPendingDisplayRows({
      adoptionRows: [],
      failures: [],
      conflictEntries: [],
      pendingDeletes: [],
      skipped: [],
      localOnlyRows: [],
      retainedFolders: [retained],
    });
    expect(ignored).toEqual([]);
  });

  it("pins the note into every review flow line and into the otherwise-empty slot (件①)", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const sectionStart = source.indexOf("private renderPlanReviewSection");
    const section = source.slice(
      sectionStart,
      source.indexOf("private renderPlanGroups", sectionStart),
    );
    // 流程句各分支都在同一块里追加告知句（含决策行时机句的场景）。
    expect(section).toContain("`${base}${oneWaySuffix}${decisionNote}`");
    expect(section).toContain(
      "`${t(\"syncPlan.confirmBoundarySummary\")}${oneWaySuffix}`",
    );
    expect(section).toContain(
      "`${t(\"syncPlan.reviewUpdatedMessage\")}${oneWaySuffix}`",
    );
    // 没有流程句占位的普通审阅（有动作行、无决策行）也要说这句话——槽位判据
    // 与 items 是否为空无关。
    expect(section).toContain("} else if (oneWayNote) {");
    expect(section).not.toContain("} else if (oneWayNote && items.length === 0) {");
  });

  it("counts the class as a decision-row family with its only exit expanded", () => {
    expect(isDecisionRowKey("localOnly:new-note.md")).toBe(true);
    expect(resolveDecisionRowDefaultOpen("localOnly:new-note.md", {})).toBe(true);
    expect(isDecisionRowKey("issue:retryLater::x.md")).toBe(false);
  });

  it("builds the one-way review note from the frozen copy count and the row family (件①)", () => {
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    const note = (
      counts: { localOnlyCopies?: number } | null,
      options: {
        direction?: string;
        rows?: ReadonlyArray<{ kind: "edited" | "created" }>;
      } = {},
    ): string | null => {
      Object.assign(view as object, {
        plugin: {
          syncDirection: options.direction ?? "one-way",
          getLocalOnlyRows: () => options.rows ?? [],
          i18n: new I18n("zh-cn"),
        },
      });
      return (
        view as unknown as {
          buildOneWayReviewNote(
            counts: { localOnlyCopies?: number } | null,
          ): string | null;
        }
      ).buildOneWayReviewNote(counts);
    };
    const created = (): { kind: "created" } => ({ kind: "created" });

    // 两类都是 0（或双向模式）时不出现这句话：老流程句不因单向改造而变长。
    expect(note(null)).toBeNull();
    expect(note({ localOnlyCopies: 0 })).toBeNull();
    expect(note({ localOnlyCopies: 3 }, { direction: "two-way" })).toBeNull();
    expect(note(null, { direction: "two-way", rows: [created()] })).toBeNull();

    // 只有"尚未上传到云端"类：计数取自面板同源的行集（忽略记忆已过滤）。
    expect(note(null, { rows: [created(), created(), created()] })).toBe(
      "有 3 个文件尚未上传到云端。",
    );
    // 只有"与云端内容不同"类：计数取自随计划封存的审阅计数。
    expect(note({ localOnlyCopies: 2 })).toBe(
      "有 2 个文件与云端内容不同。",
    );
    // 两类都命中：并集句（每类各报一个数；只报数量，不复述后果）。
    expect(note({ localOnlyCopies: 8 }, { rows: [created(), created()] })).toBe(
      "有 2 个文件尚未上传到云端，另有 8 个文件与云端内容不同。",
    );
    // 改动类行（副本）不进前一个数：它们只在"与云端内容不同"那一半里报。
    expect(note({ localOnlyCopies: 1 }, {
      rows: [{ kind: "edited" }, created()],
    })).toBe(
      "有 1 个文件尚未上传到云端，另有 1 个文件与云端内容不同。",
    );
  });

  it("dispatches the new kind and registers its fold site", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const dispatch = source.slice(
      source.indexOf("private renderPendingRow("),
      source.indexOf("private renderLocalOnlyItem("),
    );
    expect(dispatch).toContain('case "localOnly":');
    // 件②：批量处置行是同族的新 kind，也必须显式派发。
    expect(dispatch).toContain('case "batchLocalOnly":');
    // switch 无 default：没有 case 的 kind 会被静默跳过，因此新 kind 必须显式派发。
    expect(dispatch).not.toContain("default:");
    const renderer = source.slice(
      source.indexOf("private renderLocalOnlyItem("),
      source.indexOf("private renderBatchLocalOnlyRow("),
    );
    // 行主体只承担识别与展开（不是按钮），来源 chip 只做识别（span）。
    expect(renderer).toContain('createEl("summary", "easy-sync-tree-row")');
    // 行主体显示要操作的那份文件：改动类＝副本路径、新建类＝文件自身
    // （targetPath 对新建类就是 path）；与上传动作同一路径。
    expect(renderer).toContain(
      "configureFilePath(details, pathEl, entry.targetPath, true)",
    );
    expect(renderer).toContain(
      "this.plugin.uploadLocalOnlyEntry(entry.targetPath)",
    );
    expect(renderer).toContain('summary.createSpan("easy-sync-tree-chip")');
    expect(renderer).not.toContain('createEl("button"');
    // 唯一出口在展开区：动作 chip + 现役执行反馈形状 + 上传目标是副本路径。
    expect(renderer).toContain("this.createActionChip(");
    expect(renderer).toContain("this.runItemAction(");
    expect(renderer).toContain(
      "this.plugin.uploadLocalOnlyEntry(entry.targetPath)",
    );
    expect(renderer).toContain('t("syncView.localOnly.upload")');
    expect(renderer).toContain('t("syncView.localOnly.chip.edited")');
    expect(renderer).toContain('t("syncView.localOnly.chip.created")');
    // 说明句只有改动类有；新建类按类条件跳过（2026-10-12 文案定稿）。
    expect(renderer).toContain('t("syncView.localOnly.reason.edited")');
    expect(renderer).toContain('if (entry.kind === "edited") {');
    expect(renderer).not.toContain("reason.created");
    // 片⑤ 起第二个动作「留在本机，不再提醒」也在展开区（见下一条用例）。
  });

  it("feeds the section count and the queued-path filter from the same records", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    // 收窄：这两句在文件里各有两处（渲染主流程与待处理区），且都承重——
    // 只留文件级断言时，删掉其中一处仍然全绿。
    const renderBody = functionBody(source, "private doRender(): void");
    const pendingBody = functionBody(source, "private renderPendingSection(");
    expect(renderBody).toContain("localOnlyRows: this.plugin.getLocalOnlyRows()");
    expect(pendingBody).toContain("localOnlyRows: this.plugin.getLocalOnlyRows()");
    expect(renderBody).toContain("isSideActionQueued(entry.targetPath)");
    expect(pendingBody).toContain("isSideActionQueued(entry.targetPath)");
    const countStart = source.indexOf("const pendingCount = ");
    expect(countStart).toBeGreaterThanOrEqual(0);
    expect(source.slice(countStart, countStart + 500))
      .toContain("this.plugin.getLocalOnlyRows()");
  });

  it("renders the keep chip beside upload and never reads the ignore store", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const renderer = source.slice(
      source.indexOf("private renderLocalOnlyItem("),
      source.indexOf("private renderBatchLocalOnlyRow("),
    );
    // 两个动作 chip 都在展开区、都用现役动作形状与现役执行反馈。
    expect(renderer).toContain('t("syncView.localOnly.upload")');
    expect(renderer).toContain('t("syncView.localOnly.keep")');
    expect(renderer).toContain(
      "this.plugin.ignoreLocalOnlyEntry(entry.targetPath)",
    );
    expect(renderer.match(/this\.createActionChip\(/g) ?? []).toHaveLength(2);
    expect(renderer.match(/this\.runItemAction\(/g) ?? []).toHaveLength(2);
    // 忽略只走单一真源（getLocalOnlyRows）：侧栏不直接读写忽略记忆，
    // 也不建反转界面（本片只留 store 的移除 API）。
    expect(source).not.toContain("localOnlyIgnoreMemory");
    expect(source).not.toContain("clearLocalOnlyIgnore");
    expect(source).not.toContain("localOnly.unignore");
  });

  it("colors the upload chip as the primary action and keeps the keep chip neutral", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const renderer = source.slice(
      source.indexOf("private renderLocalOnlyItem("),
      source.indexOf("private renderBatchLocalOnlyRow("),
    );
    const chips = renderer.split("this.createActionChip(").slice(1);
    expect(chips).toHaveLength(2);
    const variantBeforeCallback = (chip: string): string | null =>
      chip.match(/("accent"|"warning"|""),\s*\n\s*\(\) => \{/)?.[1] ?? null;

    // 主次判据（与「新插件待决策」行同形）：主动作 accent、次动作中性。
    // 顺序不变：第一个＝上传到云端（强调色），第二个＝留在本机（中性）。
    expect(chips[0]).toContain('t("syncView.localOnly.upload")');
    expect(chips[0]).toContain(
      "this.plugin.uploadLocalOnlyEntry(entry.targetPath)",
    );
    expect(variantBeforeCallback(chips[0])).toBe('"accent"');
    expect(chips[1]).toContain('t("syncView.localOnly.keep")');
    expect(chips[1]).toContain(
      "this.plugin.ignoreLocalOnlyEntry(entry.targetPath)",
    );
    expect(variantBeforeCallback(chips[1])).toBe('""');

    // 同族先例对拍：采纳行主动作 accent／跳过中性；删除行 warning／拒绝中性。
    const adoption = source.slice(
      source.indexOf("private renderAdoptionItem("),
      source.indexOf("private renderDeleteItem("),
    );
    expect(adoption).toContain('t("syncView.adoption.download"),\n      "accent",');
    expect(adoption).toContain('t("syncView.adoption.skip"), "", () => {');
    const deletion = source.slice(
      source.indexOf("private renderDeleteItem("),
      source.indexOf("private createSection("),
    );
    expect(deletion).toContain('t("syncView.delete.confirm"), "warning",');
    expect(deletion).toContain('t("syncView.delete.reject"), "", () => {');
  });

  it("skips the plan-review count row when every count is zero", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const start = source.indexOf(
      "const present = rows.filter(([, count]) => count > 0);",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const slice = source.slice(start, start + 400);
    expect(slice).toContain("if (present.length > 0)");
    expect(slice).toContain("easy-sync-plan-counts");
  });
});

describe("conflict batch row (2026-10-23)", () => {
  const conflict = (path: string): SyncPlanItem => ({
    type: SyncActionType.Conflict,
    path,
  });
  const fileEntry = (path: string) => ({
    kind: "file" as const,
    item: conflict(path),
  });
  const baseInput = {
    adoptionRows: [],
    failures: [],
    pendingDeletes: [],
    skipped: [],
    configDir: ".obsidian",
  };

  it("adds one batch row before the conflict rows when at least two ordinary files are eligible", () => {
    const rows = buildSyncPendingDisplayRows({
      ...baseInput,
      conflictEntries: [
        fileEntry("a.md"),
        fileEntry("b.md"),
        fileEntry("c.md"),
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "batchConflict",
      "conflict",
      "conflict",
      "conflict",
    ]);
    expect(rows[0].key).toBe("batch-conflict");
    expect(rows[0].conflicts?.map((item) => item.path)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
    expect(rows[0].conflictBatchExcluded).toBe(0);
  });

  it("keeps plugin subtrees and managed config out of the batch but visible per row", () => {
    const rows = buildSyncPendingDisplayRows({
      ...baseInput,
      conflictEntries: [
        fileEntry("a.md"),
        fileEntry(".obsidian/plugins/demo/data.json"),
        fileEntry(".obsidian/appearance.json"),
        fileEntry("b.md"),
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "batchConflict",
      "conflict",
      "conflict",
      "conflict",
      "conflict",
    ]);
    expect(rows[0].conflicts?.map((item) => item.path)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(rows[0].conflictBatchExcluded).toBe(2);
    expect(rows.slice(1).map((row) => row.item?.path)).toEqual([
      "a.md",
      ".obsidian/plugins/demo/data.json",
      ".obsidian/appearance.json",
      "b.md",
    ]);
  });

  it("does not add the batch row for a single eligible conflict", () => {
    const rows = buildSyncPendingDisplayRows({
      ...baseInput,
      conflictEntries: [
        fileEntry("a.md"),
        fileEntry(".obsidian/appearance.json"),
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual(["conflict", "conflict"]);
    expect(rows.some((row) => row.kind === "batchConflict")).toBe(false);
  });

  it("keeps bundle rows separate and counts only ordinary file conflicts", () => {
    const rows = buildSyncPendingDisplayRows({
      ...baseInput,
      conflictEntries: [
        fileEntry("a.md"),
        {
          kind: "bundle" as const,
          pluginId: "demo",
          items: [conflict(".obsidian/plugins/demo/main.js")],
        },
        fileEntry("b.md"),
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "batchConflict",
      "conflict",
      "pluginConflict",
      "conflict",
    ]);
    expect(rows[0].conflicts?.map((item) => item.path)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(rows[0].conflictBatchExcluded).toBe(0);
  });

  it("excludes the whole plugin subtree and only the managed config files at the vault root", () => {
    expect(isConflictBatchExcludedPath(
      ".obsidian/plugins/demo/main.js",
      ".obsidian",
    )).toBe(true);
    expect(isConflictBatchExcludedPath(
      ".obsidian/plugins/demo/data.json",
      ".obsidian",
    )).toBe(true);
    expect(isConflictBatchExcludedPath(
      ".obsidian/appearance.json",
      ".obsidian",
    )).toBe(true);
    expect(isConflictBatchExcludedPath(
      ".obsidian/themes/demo.css",
      ".obsidian",
    )).toBe(false);
    expect(isConflictBatchExcludedPath(
      "notes/.obsidian/appearance.json",
      ".obsidian",
    )).toBe(false);
    expect(isConflictBatchExcludedPath("notes/a.md", ".obsidian")).toBe(false);
  });

  it("uses the existing two-button batch shell and confirms both directions", () => {
    const source = readSourceFile("src/ui/sync-view.ts");
    const start = source.indexOf("private renderBatchConflictRow(");
    const end = source.indexOf("private renderBundleConflictItem(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const renderer = source.slice(start, end);
    expect(renderer).toContain('rowEl.dataset.easySyncPlanRow = "batch-conflict"');
    expect(renderer).toContain("easy-sync-local-only-batch-actions");
    expect(renderer).toContain("syncView.conflict.batchKeepLocalTitle");
    expect(renderer).toContain("syncView.conflict.batchKeepRemoteTitle");
    expect(renderer).toContain("syncView.conflict.batchKeepLocalMessage");
    expect(renderer).toContain("syncView.conflict.batchKeepRemoteMessage");
    // 入口两颗按钮同色（中性），危险色只留给两个确认弹框的确认键。
    expect(renderer).not.toContain("applyDestructiveButton");
    expect(renderer.match(/danger: true/g) ?? []).toHaveLength(2);
    expect(renderer).not.toContain("版本历史");
    expect(renderer).not.toContain("version history");
    expect(source).toContain('case "batchConflict":');
  });

  it("pins the threshold helper to two eligible conflicts", () => {
    expect(isBatchedConflictSet(["conflict:a.md"])).toBe(false);
    expect(isBatchedConflictSet([
      "conflict:a.md",
      "conflict:b.md",
    ])).toBe(true);
    expect(isBatchedConflictSet([
      "conflict:a.md",
      "delete:b.md",
    ])).toBe(false);
    expect(collectBatchConflictItems([
      fileEntry("a.md"),
    ], ".obsidian")).toHaveLength(1);
  });

  it("keeps modal body copy at the host's normal UI size", () => {
    const styles = readSourceFile("styles.css");
    // 2026-10-24 审计收窄为白名单制：正文放大只适用于"正文即全部内容"的
    // 纯提示/确认框（挂 easy-sync-prompt-modal）；其余一切弹框（设置表单、
    // 数据视图、选项卡、列表、多组说明、设备码注脚）一律宿主原本字号。
    expect(styles).toContain(
      ".easy-sync-modal-container .easy-sync-prompt-modal .modal-content > .setting-item-description",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .modal-content > .setting-item-description",
    );
    // 补口规则已整体撤销（2026-10-24 审计：内容密集处放大＝主次不分），
    // 不得以任何形式回涨。
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-detail-reason",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-diff-truncated",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-device-code-hint",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-device-status",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-device-security",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-auth-method-desc",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-plugin-list-message",
    );
    expect(styles).not.toContain(
      ".easy-sync-modal-container .easy-sync-plugin-list-guidance",
    );
    // ConfirmModal 两段正文写法一致（2026-10-24 用户真机实测指认）：message
    // 与 warning 都是无类纯段落——message 不再挂宿主 setting-item-description
    // （设置页说明类：灰字＋小号语义，CSS 顶字号治不了灰色，iOS 上与纯继承
    // 行的字号也不重合）。守卫只看 ConfirmModal 类自身（文件里 SyncPlanAlert
    // 仍统一挂该类，不在本守卫范围）。
    const confirmModalSource = readSourceFile("src/ui/confirm-modal.ts");
    const confirmModalBody = confirmModalSource.slice(
      confirmModalSource.indexOf("export class ConfirmModal"),
    );
    expect(confirmModalBody).not.toContain("setting-item-description");
    expect(confirmModalBody).toContain(
      'contentEl.createEl("p", { text: this.options.warning });',
    );
    // 白名单成员在各自 onOpen 挂标记（新增纯提示弹框时按判据加入并同步此钉）。
    for (const file of [
      "src/ui/confirm-modal.ts",
      "src/ui/scope-crossing-prompt-modal.ts",
      "src/ui/auth-pending-modal.ts",
      "src/ui/update-reminder-modal.ts",
      "src/ui/rs-migration-failure-modal.ts",
    ]) {
      expect(readSourceFile(file)).toContain("easy-sync-prompt-modal");
    }
    expect(styles).toContain("font-size: var(--font-ui-medium)");
  });
});
