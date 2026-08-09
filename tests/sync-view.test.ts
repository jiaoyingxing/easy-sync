import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
  formatSyncHistoryCounts,
  resolveFileProgressPresentation,
  resolveSyncViewBodyMode,
  shouldAutoRebuildPlanReview,
  SYNC_PLAN_VIRTUAL_OVERSCAN,
  syncViewProgressPercent,
  trimFilePathPrefix,
} from "../src/ui/sync-view";
import { I18n } from "../src/i18n";
import { SyncActionType } from "../src/sync/types";

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
      startedAt: 1,
    })).toBe(25);
  });
});

describe("sync view status copy and scrolling layout", () => {
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

  it("keeps the sidebar toolbar fixed above one independent content scroller", () => {
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

    expect(desktopViewBlock).toContain("display: flex");
    expect(desktopViewBlock).toContain("flex-direction: column");
    expect(desktopViewBlock).toContain("overflow: hidden");
    expect(toolbarBlock).toContain("position: sticky");
    expect(toolbarBlock).toContain("top: 0");
    expect(toolbarBlock).toContain("background: transparent");
    expect(mobileViewBlock).toContain("padding-bottom: max(var(--safe-area-inset-bottom), var(--size-4-8))");
    expect(mobileToolbarBlock).toContain("background: var(--background-primary)");
    expect(desktopContentBlock).toContain("flex: 1 1 auto");
    expect(desktopContentBlock).toContain("min-height: 0");
    expect(desktopContentBlock).toContain("overflow-y: auto");
    expect(styles).not.toMatch(
      /body\.is-mobile \.view-content\.easy-sync-view > \.nav-header\s*\{[^}]*position:\s*sticky/s,
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
      currentItemBytes: 0,
      currentItemTotalBytes: 0,
      cancelRequested: false,
    },
    planReviewActive: false,
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

  it("changes when a persistent community plugin decision appears", () => {
    const empty = buildSyncViewContentKey(false, baseInput);
    const pending = buildSyncViewContentKey(false, {
      ...baseInput,
      isLoggedIn: true,
      isRunning: false,
      bodyMode: "pending",
      communityPluginEnablementPending: 2,
      progress: {
        ...baseInput.progress,
        phase: "idle",
      },
    });

    expect(empty).not.toBe(pending);
    expect(pending).toContain("community-plugins:2");
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
      bodyMode: "idle",
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
      bodyMode: "idle",
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

    expect(counts).toBe("冲突 1 · 远端删除待确认 1");
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
    expect(status).toContain("this.plugin.executePlanReview()");
    expect(status).toContain(".setCta()");
    expect(section).not.toContain('t("syncPlan.recalculate")');
    expect(section).not.toContain("this.plugin.rebuildPlanReview()");
    expect(section).not.toContain("this.plugin.executePlanReview()");
    expect(groups).toContain('details.addEventListener("toggle"');
    expect(groups).toContain("this.measurePlanRowHeights(body)");
    expect(groups).toContain("buildSyncPlanVirtualWindow({");
    expect(groups).toContain("this.planVirtualRenderers.add(renderWindow)");
    expect(groups).toContain("hasInlineDecisions");
    expect(styles).toMatch(/\.easy-sync-plan-virtual-window\s*\{[^}]*position:\s*absolute/s);
    expect(styles).not.toMatch(/\.easy-sync-plan-virtual-window > \.easy-sync-file-row\s*\{/s);
  });

  it("preserves an opened plan group and scroll position across side-action rerenders", () => {
    const source = readFileSync("src/ui/sync-view.ts", "utf8");

    expect(source).toContain("private planExpandedGroups = new Set<SyncActionGroup>()");
    expect(source).toContain("this.planExpandedGroups.clear();\n        preservedPlanScrollTop = null;");
    expect(source).toContain("details.dataset.easySyncPlanGroup = group.group");
    expect(source).toContain("this.planExpandedGroups.add(group.group)");
    expect(source).toContain("expandedPlanGroups.has(group)");
    expect(source).toContain("this.planExpandedGroups.has(group.group)");
    expect(source).toContain("renderInlineDecisions();");
    expect(source).toContain("content.scrollTop = preservedPlanScrollTop");
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
    const sharedSource = readFileSync("src/ui/file-comparison-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");
    const openStart = viewSource.indexOf(
      "  private async openMutationRecoveryResolution()",
    );
    const openEnd = viewSource.indexOf(
      "\n  private renderHistorySection",
      openStart,
    );
    const openMethod = viewSource.slice(openStart, openEnd);

    expect(viewSource).toContain('"syncView.recovery.reviewAndResolve"');
    expect(viewSource).toContain('state.mutationRecovery.blockReason === "facts-changed"');
    expect(viewSource).toContain("state.mutationRecovery.manualResolutionAvailable === true");
    expect(viewSource).toContain('? "syncView.recovery.reviewAndResolve"');
    expect(viewSource).toContain('? "syncView.recovery.checkAgain"');
    expect(openMethod).toContain("if (this.mutationRecoveryResolutionOpening) return");
    expect(openMethod.match(/new MutationRecoveryResolutionModal\(/g)).toHaveLength(1);
    expect(openMethod).toContain(".awaitChoice()");
    expect(openMethod).toContain("option.deletesOtherSide");
    expect(openMethod).toContain("new ConfirmModal(");
    expect(openMethod.indexOf("option.deletesOtherSide")).toBeLessThan(
      openMethod.indexOf("new ConfirmModal("),
    );
    expect(openMethod).toContain("this.plugin.resolveMutationRecovery(snapshot, choice)");
    expect(modalSource).toContain("extends FileComparisonModal");
    expect(modalSource).toContain("this.renderComparisonTable(");
    expect(modalSource).toContain("this.renderFileComparisonActions([");
    expect(modalSource).toContain("disabled: !this.snapshot.keepLocal.available");
    expect(modalSource).toContain("disabled: !this.snapshot.keepRemote.available");
    expect(modalSource).not.toContain("extends Modal");
    expect(modalSource).not.toContain("easy-sync-mutation-resolution-");
    expect(sharedSource).toContain('this.contentEl.addClass("easy-sync-conflict-detail")');
    expect(sharedSource).toContain('createDiv("easy-sync-conflict-body")');
    expect(sharedSource).toContain('createEl("table", "easy-sync-metadata-table")');
    expect(sharedSource).toContain('createDiv("easy-sync-detail-actions")');
    expect(modalSource).not.toContain(".setCta()");
    expect(styles).toMatch(
      /\.easy-sync-metadata-table\s*\{[^}]*table-layout:\s*fixed;/s,
    );
    expect(styles).toMatch(
      /\.easy-sync-metadata-table th,\s*\.easy-sync-metadata-table td\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(styles).toMatch(
      /body\.is-mobile \.easy-sync-detail-actions button\s*\{[^}]*width:\s*100%/s,
    );
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
  });

  it("routes community plugin attention from one sidebar summary to the existing manager", () => {
    const viewSource = readFileSync("src/ui/sync-view.ts", "utf8");
    const settingsSource = readFileSync("src/ui/settings-tab.ts", "utf8");
    const modalSource = readFileSync("src/ui/config-sync-modal.ts", "utf8");

    expect(viewSource).toContain(
      "plugin.getCommunityPluginEnablementPendingCount()",
    );
    expect(viewSource).toContain(
      '"syncView.communityPlugins.pendingTitle"',
    );
    expect(viewSource).toContain(
      '"syncView.communityPlugins.pendingDescription"',
    );
    expect(viewSource).toContain(
      "plugin.openCommunityPluginEnablementReview()",
    );
    expect(viewSource).toContain(
      "communityPluginEnablementPending === 0",
    );
    expect(settingsSource).toContain(
      'new ConfigSyncModal(\n      this.plugin,\n      "community-plugin-files",\n      true,',
    );
    expect(modalSource).toContain("focusPendingDecisionIfRequested()");
    expect(modalSource).toContain("void this.openDecisionModal()");
    expect(modalSource).toContain(
      '"easy-sync-plugin-decision-trigger"',
    );
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
    })).toBe("idle");
  });
});

describe("sync view attention presentation", () => {
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
