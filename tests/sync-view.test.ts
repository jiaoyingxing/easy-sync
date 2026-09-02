import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildAdaptivePathLayout,
  buildCompletedFilesRenderState,
  buildSyncPlanDisplayGroups,
  buildSyncPlanVirtualOffsets,
  buildSyncPlanVirtualWindow,
  buildSyncViewContentKey,
  EasySyncSyncView,
  countOmittedSyncHistorySuccessfulFiles,
  formatFileProgressLabel,
  formatPendingIssueActionLabel,
  formatPendingIssueChipLabel,
  groupCommunityPluginConflictReviews,
  groupPendingIssuesForReview,
  formatSyncHistoryCounts,
  resolveFileProgressPresentation,
  resolvePlanReviewDetailsState,
  resolveRemoteScopeRecoveryFailurePresentation,
  resolveSyncViewBodyMode,
  resolveSyncViewPrimaryAction,
  resolveSyncViewStatusDetailMode,
  shouldExpandAllVisibleDetails,
  shouldAutoRebuildPlanReview,
  SYNC_PLAN_VIRTUAL_OVERSCAN,
  syncViewProgressPercent,
  trimFilePathPrefix,
} from "../src/ui/sync-view";
import { I18n } from "../src/i18n";
import { SyncActionType } from "../src/sync/types";
import { ConfirmModal } from "../src/ui/confirm-modal";
import { formatFileSize } from "../src/ui/file-comparison-modal";

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
  };
  return element;
}

function collectFakeHistoryText(element: FakeHistoryElement): string[] {
  return [
    ...(element.text ? [element.text] : []),
    ...element.children.flatMap(collectFakeHistoryText),
  ];
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

  it("groups one plugin bundle into one review row without absorbing other conflicts", () => {
    const conflict = (path: string) => ({
      type: SyncActionType.Conflict,
      path,
    });
    const grouped = groupCommunityPluginConflictReviews([
      conflict(".obsidian/plugins/resojot/main.js"),
      conflict("note.md"),
      conflict(".obsidian/plugins/resojot/manifest.json"),
      conflict(".obsidian/plugins/resojot/styles.css"),
      conflict(".obsidian/plugins/easy-sync/main.js"),
      conflict(".obsidian/plugins/resojot/data.json"),
    ], ".obsidian");

    expect(grouped.map((entry) => entry.kind)).toEqual([
      "community-plugin-bundle",
      "file",
      "file",
      "file",
    ]);
    expect(grouped[0]).toMatchObject({
      kind: "community-plugin-bundle",
      pluginId: "resojot",
      items: [
        { path: ".obsidian/plugins/resojot/main.js" },
        { path: ".obsidian/plugins/resojot/manifest.json" },
        { path: ".obsidian/plugins/resojot/styles.css" },
      ],
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

  it("applies an explicit plan-wide expand action to lazily rendered decisions", () => {
    const detail = { setAttribute: vi.fn() };
    const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
    Object.assign(view as object, {
      planGroupsCollapsed: false,
      collapseToggleButtonEl: null,
    });
    const container = {
      querySelectorAll: vi.fn().mockReturnValue([detail]),
    } as unknown as HTMLElement;

    (view as unknown as {
      applyPlanDetailsExpandOverride(container: HTMLElement): void;
    }).applyPlanDetailsExpandOverride(container);

    expect(detail.setAttribute).toHaveBeenCalledWith("open", "");
  });
});

describe("sync view status copy and scrolling layout", () => {
  it("keeps expanded history details subordinate to the summary with host UI tokens", () => {
    const styles = readFileSync("styles.css", "utf8");

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
      .toBe("原云端同步目录无法继续使用，需要重新创建后核对内容。");
    expect(en.t("syncPlan.remoteScopeRecreateSummary"))
      .toContain("previous remote sync folder");
    expect(zh.t("result.sharedControlReadUnavailable"))
      .toBe("暂时无法读取云端同步状态，本轮未进入新的文件同步计划；EasySync 会在下次同步时重新检查。");
    expect(en.t("result.sharedControlReadUnavailable"))
      .toBe("The cloud sync state is temporarily unavailable, so this run did not enter a new file sync plan. EasySync will check again on the next sync.");
    expect(zh.t("syncView.history.noFileChanges"))
      .toBe("本轮没有文件变更。");
    expect(en.t("syncView.history.noFileChanges"))
      .toBe("No files changed in this sync.");

    const source = readFileSync("src/ui/sync-view.ts", "utf8");
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

    const modalSource = readFileSync(
      "src/ui/mutation-recovery-resolution-modal.ts",
      "utf8",
    );
    expect(modalSource).toContain("formatFileSize(fact.size ?? 0)");
    expect(modalSource).not.toContain(")：${");
  });

  it("separates empty-folder situations from actions without exposing folder internals", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const modalSource = readFileSync(
      "src/ui/empty-folder-resolution-modal.ts",
      "utf8",
    );

    expect([
      zh.t("syncView.emptyFolder.deleteUnavailableDescription"),
      zh.t("syncView.emptyFolder.deleteConfirmWarning"),
    ].join("\n")).not.toMatch(/版本凭据|身份和版本/);
    expect([
      en.t("syncView.emptyFolder.deleteUnavailableDescription"),
      en.t("syncView.emptyFolder.deleteConfirmWarning"),
    ].join("\n")).not.toMatch(/folder version|identity and version/i);
    expect(modalSource).toContain(
      '.setName(this.t("syncView.emptyFolder.restoreTitle"))',
    );
    expect(modalSource).toContain(
      '.setButtonText(this.t("syncView.emptyFolder.restore"))',
    );
    expect(modalSource).toContain(
      '.setName(this.snapshot.remoteCTag\n        ? this.t("syncView.emptyFolder.delete")',
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
      '.setName(root?.remoteCTag\n        ? this.t("syncView.folderSubtree.deleteTitle")',
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
    expect(zh.t("syncView.progress.items", { current: 2, total: 5 }))
      .toBe("2/5项");
    expect(en.t("progress.verifyingFiles", { current: 2, total: 5 }))
      .toBe("Verifying file consistency…");
    expect(en.t("syncView.progress.items", { current: 2, total: 5 }))
      .toBe("2/5 items");
  });

  it("separates shared-folder identity recording from the following sync", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const zhMessage = zh.t("syncView.sharedFolderIdentity.confirmMessage", {
      path: ".obsidian/plugins",
    });
    const enMessage = en.t("syncView.sharedFolderIdentity.confirmMessage", {
      path: ".obsidian/plugins",
    });

    expect(zh.t("syncView.sharedFolderIdentity.resolve"))
      .toBe("确认是同一文件夹");
    expect(zhMessage).toContain("请只在你确认两边原本就是同一个文件夹时继续");
    expect(zhMessage).toContain("尚未确认的上级文件夹");
    expect(zhMessage).toContain("记录身份这一步不会上传、下载或删除文件");
    expect(zhMessage).toContain("随后会立即按当前设置重新同步");
    expect(en.t("syncView.sharedFolderIdentity.resolve"))
      .toBe("Confirm same folder");
    expect(enMessage).toContain("Continue only if you know they were originally the same folder");
    expect(enMessage).toContain("any unconfirmed parent folders");
    expect(enMessage).toContain("It will then sync immediately using the current settings");
    expect(zh.t("notice.sharedFolderIdentity.failed", {
      path: ".obsidian/plugins",
      reason: "raw-provider-error",
    })).not.toContain("raw-provider-error");
    expect(en.t("notice.sharedFolderIdentity.failed", {
      path: ".obsidian/plugins",
      reason: "raw-provider-error",
    })).not.toContain("raw-provider-error");
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
    const styles = readFileSync("styles.css", "utf8");
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
});

describe("buildSyncViewContentKey", () => {
  const baseInput = {
    isLoggedIn: false,
    isInitializing: false,
    isPending: false,
    isRunning: true,
    canCancel: false,
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

  it("changes completed-file render state when a sibling appears later", () => {
    const firstOnly = buildCompletedFilesRenderState([
      { path: "test/333333(4)-副本.md", status: "download" },
    ]);
    const withSibling = buildCompletedFilesRenderState([
      { path: "test/333333(4)-副本.md", status: "download" },
      { path: "test/444444.md", status: "download" },
    ]);

    expect(firstOnly.key).not.toBe(withSibling.key);
  });

  it("changes completed-file render state when the same path changes action type", () => {
    const created = buildCompletedFilesRenderState([{
      path: "Folder",
      status: "folder",
      actionType: SyncActionType.CreateRemoteFolder,
    }]);
    const moved = buildCompletedFilesRenderState([{
      path: "Folder",
      status: "folder",
      actionType: SyncActionType.MoveRemoteFolder,
    }]);

    expect(created.key).not.toBe(moved.key);
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
      formatPendingIssueChipLabel(type, zh.t.bind(zh));

    expect(label(SyncActionType.Upload)).toBe("失败");
    expect(label(SyncActionType.FolderDeferred)).toBe("未同步");
    expect(label(SyncActionType.RetryLater)).toBe("未同步");
    expect(label(SyncActionType.SkipLargeFile)).toBe("跳过");
    expect(label(SyncActionType.SkipIgnoredPath)).toBe("跳过");
    expect(label(SyncActionType.AuthExpired)).toBeNull();
  });

  it("keeps real retries distinct from safe rechecks", () => {
    const zh = new I18n("zh-cn");
    const label = (type: SyncActionType) =>
      formatPendingIssueActionLabel(type, zh.t.bind(zh));

    expect(label(SyncActionType.FolderDeferred)).toBe("重新检查");
    expect(label(SyncActionType.RetryLater)).toBe("重新检查");
    expect(label(SyncActionType.Upload)).toBe("再次同步");
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

  it("applies the adaptive path layout in the same task that updated the rows (no two-frame flicker)", () => {
    const prototype = EasySyncSyncView.prototype as unknown as {
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
    const source = readFileSync("src/ui/sync-view.ts", "utf8");
    const progressPanel = source.slice(
      source.indexOf("private renderProgressPanel"),
      source.indexOf("private renderRemoteScopeRecoveryFailure"),
    );
    expect(progressPanel).toContain("{ count: state.completedCount }");
    const append = source.slice(
      source.indexOf("private appendNewFileRows"),
      source.indexOf("private renderToolbar"),
    );
    expect(append).toContain("state.completedCount");
    expect(append).not.toContain("count: files.length");
  });

  it("keeps ordinary plan rows chip-free and excludes history from adaptive directories", () => {
    const source = readFileSync("src/ui/sync-view.ts", "utf8");
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
    expect(source).toContain("this.renderFileResults(body, entry.files, false)");
    expect(source).toContain(
      'if (limitHeight) {\n      list.addClass("is-limited");\n      list.addClass("easy-sync-path-layout");',
    );
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
    expect(groups.every((group) => group.open === false)).toBe(true);
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

  it("keeps plan confirmation in the fixed primary action and plan details lazy", () => {
    const styles = readFileSync("styles.css", "utf8");
    const source = readFileSync("src/ui/sync-view.ts", "utf8");
    const statusStart = source.indexOf("private renderStatusPanel");
    const statusEnd = source.indexOf("private updateStatusPanel", statusStart);
    const status = source.slice(statusStart, statusEnd);
    const sectionStart = source.indexOf("private renderPlanReviewSection");
    const sectionEnd = source.indexOf("private renderPlanGroups", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    const groupsEnd = source.indexOf("private renderPlanReviewItem", sectionEnd);
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
    expect(groups).toContain("this.planVirtualRenderers.add(renderWindow)");
    expect(groups).toContain("hasInlineDecisions");
    expect(styles).toMatch(/\.easy-sync-plan-virtual-window\s*\{[^}]*position:\s*absolute/s);
    expect(styles).toMatch(
      /\.easy-sync-plan-measure-probe\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s,
    );
    expect(styles).not.toMatch(/\.easy-sync-plan-virtual-window > \.easy-sync-file-row\s*\{/s);
  });

  it("preserves an opened plan group and scroll position across side-action rerenders", () => {
    const source = readFileSync("src/ui/sync-view.ts", "utf8");

    expect(source).toContain("private planExpandedGroups = new Set<SyncActionGroup>()");
    expect(source).toContain("this.planExpandedGroups.clear();\n        preservedContentScrollTop = null;");
    expect(source).toContain("details.dataset.easySyncPlanGroup = group.group");
    expect(source).toContain("this.planExpandedGroups.add(group.group)");
    expect(source).toContain("expandedPlanGroups.has(group)");
    expect(source).toContain("this.planExpandedGroups.has(group.group)");
    expect(source).toContain("renderInlineDecisions();");
    expect(source).toContain(
      '(bodyMode === "plan" || bodyMode === "recovery" || bodyMode === "idle")',
    );
    expect(source).toContain("content.scrollTop = preservedContentScrollTop");
    expect(source).toContain("container.scrollTop = preservedHostScrollTop");
    expect(source).toContain("this.updateCollapseTogglePresentation();");
  });

  it("submits UI decisions only through the plugin gateway", () => {
    const viewSource = readFileSync("src/ui/sync-view.ts", "utf8");
    const modalSource = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
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
    const source = readFileSync("src/ui/sync-view.ts", "utf8");
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

    expect(row).toContain('issue.issueCode === "unanchored-shared-folder"');
    expect(row).toContain('t("syncView.sharedFolderIdentity.resolve")');
    expect(openMethod).toContain(
      "if (this.sharedFolderIdentityResolutionOpening) return",
    );
    expect(openMethod.match(/new ConfirmModal\(/g)).toHaveLength(1);
    expect(openMethod).toContain(
      't("syncView.sharedFolderIdentity.confirmMessage", { path })',
    );
    expect(openMethod).toContain("if (!confirmed) return");
    expect(openMethod).toContain(
      "this.plugin.confirmReviewedSharedFolderIdentity(snapshot)",
    );
    expect(source).not.toContain(
      "syncExecutor.confirmReviewedSharedFolderIdentity",
    );
  });

  it("routes a two-sided folder move to one existing folder modal", () => {
    const source = readFileSync("src/ui/sync-view.ts", "utf8");
    const modalSource = readFileSync(
      "src/ui/empty-folder-resolution-modal.ts",
      "utf8",
    );
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

    expect(row).toContain('issue.issueCode === "folder-location-choice"');
    expect(row).toContain('t("syncView.folderLocation.resolve")');
    expect(openMethod).toContain("new EmptyFolderResolutionModal(");
    expect(openMethod).toContain('choice?.action === "keep-local-location"');
    expect(openMethod).toContain('choice?.action === "keep-remote-location"');
    expect(openMethod).toContain("this.plugin.resolveReviewedFolderLocation(");
    expect(modalSource).not.toContain("class FolderLocationResolutionModal");
  });

  it("keeps stale identity retirement explicit, state-only, and local to its pending row", () => {
    const source = readFileSync("src/ui/sync-view.ts", "utf8");
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

    expect(row).toContain('issue.issueCode === "identity-replacement-ambiguous"');
    expect(row).toContain('issue.issueCode === "anchored-folder-missing-remote"');
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
    const viewSource = readFileSync("src/ui/sync-view.ts", "utf8");
    const modalSource = readFileSync(
      "src/ui/mutation-recovery-resolution-modal.ts",
      "utf8",
    );
    const conflictSource = readFileSync(
      "src/ui/conflict-detail-modal.ts",
      "utf8",
    );
    const sharedSource = readFileSync("src/ui/file-comparison-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");
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
    expect(modalSource.indexOf("syncView.mutationResolution.description")).toBeGreaterThan(
      modalSource.indexOf("syncView.mutationResolution.technicalDetails"),
    );
    expect(styles).not.toContain("easy-sync-comparison-previous-action");
    expect(styles).toMatch(
      /\.easy-sync-comparison-path-table\s*\{[^}]*table-layout:\s*fixed;/s,
    );
    expect(styles).toContain("easy-sync-comparison-bundle-table");
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
    const viewSource = readFileSync("src/ui/sync-view.ts", "utf8");
    const modalSource = readFileSync(
      "src/ui/mutation-recovery-resolution-modal.ts",
      "utf8",
    );
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
    const source = readFileSync("src/ui/sync-view.ts", "utf8");
    const sectionStart = source.indexOf("private renderPendingSection");
    const sectionEnd = source.indexOf("private renderPendingIssue", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);

    expect(section).toContain("pendingDeletes.length > 1");
    expect(section).toContain('createDiv("easy-sync-plan-execute")');
    expect(section).toContain('actions.addClass("easy-sync-primary-actions")');
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
    expect(section.match(/addClass\("mod-loading"\)/g)).toHaveLength(2);
    expect(section.match(/setDisabled\(true\)/g)?.length).toBeGreaterThanOrEqual(2);
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
});

describe("remote scope recovery failure presentation", () => {
  it("moves the failure path and next step into persistent body content", () => {
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
      nextStep: "请重新同步。已安全记录的核验进度会继续保留。",
    });
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

  it("shows an offline top status when the latest round is a retry-pending observation", () => {
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

    // The latest round was a network observation miss: the stale "synced"
    // green from the last healthy round must not imply the vault is in sync.
    expect(view.getStatusPresentation({
      ...baseState,
      latestHistory,
    })).toEqual({ status: "offline", label: "无网络连接" });

    // A pending item still outranks the offline hint: unresolved conflicts or
    // deletes must not be hidden behind the network notice.
    expect(view.getStatusPresentation({
      ...baseState,
      pendingCount: 2,
      latestHistory,
    })).toEqual({ status: "attention", label: "需要处理 2" });
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
