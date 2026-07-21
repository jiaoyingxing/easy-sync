import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCompletedFilesRenderState,
  buildSyncViewContentKey,
  resolveSyncViewBodyMode,
  syncViewProgressPercent,
  trimFilePathPrefix,
} from "../src/ui/sync-view";

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

describe("buildSyncViewContentKey", () => {
  const baseInput = {
    isLoggedIn: false,
    isInitializing: false,
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
    planReviewCounts: null,
    planReviewItems: [],
    history: [],
    lastSyncTime: 0,
  };

  it("changes when history is toggled even during a running sync", () => {
    const collapsed = buildSyncViewContentKey(false, baseInput);
    const expanded = buildSyncViewContentKey(true, baseInput);

    expect(collapsed).not.toBe(expanded);
    expect(collapsed).toContain("history:closed");
    expect(expanded).toContain("history:open:");
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
      planReviewItems: [{
        type: "upload",
        path: "foo.md",
      }],
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
      planReviewItems: [{
        type: "upload",
        path: "foo.md",
      }],
    });

    expect(runningPlan).not.toBe(pausedPlan);
    expect(runningPlan).toContain("run:1");
    expect(pausedPlan).toContain("run:0");
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

  it("changes completed-file render state when a shared prefix appears later", () => {
    const firstOnly = buildCompletedFilesRenderState([
      { path: "test/333333(4)-副本.md", status: "download" },
    ]);
    const withSibling = buildCompletedFilesRenderState([
      { path: "test/333333(4)-副本.md", status: "download" },
      { path: "test/444444.md", status: "download" },
    ]);

    expect(firstOnly.prefix).toBe("");
    expect(withSibling.prefix).toBe("test/");
    expect(firstOnly.key).not.toBe(withSibling.key);
  });

  it("keeps plan review actions spaced, right aligned, and mobile safe", () => {
    const styles = readFileSync("styles.css", "utf8");
    const actionBlock = styles.match(/\.easy-sync-plan-execute\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(actionBlock).toContain("display: flex");
    expect(actionBlock).toContain("flex-wrap: wrap");
    expect(actionBlock).toContain("justify-content: flex-end");
    expect(actionBlock).toContain("gap: var(--size-4-2)");

    const mobileBlock = styles.match(/body\.is-mobile \.easy-sync-plan-execute\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(mobileBlock).toContain("flex-direction: column");
    expect(mobileBlock).toContain("align-items: stretch");
    expect(styles).toMatch(/body\.is-mobile \.easy-sync-plan-execute button\s*\{[^}]*width:\s*100%/);

    const source = readFileSync("src/ui/sync-view.ts", "utf8");
    const sectionStart = source.indexOf("private renderPlanReviewSection");
    const sectionEnd = source.indexOf("private renderPlanGroups", sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    expect(section.indexOf('t("syncPlan.recalculate")')).toBeLessThan(
      section.indexOf('t("syncPlan.confirmExecute")'),
    );
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
    expect(modalSource).toContain("plugin.dismissConflict");
    expect(modalSource).toContain("plugin.reconcileIdenticalConflict");
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
