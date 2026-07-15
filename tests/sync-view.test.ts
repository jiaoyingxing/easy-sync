import { describe, expect, it } from "vitest";
import { buildSyncViewContentKey } from "../src/ui/sync-view";

describe("buildSyncViewContentKey", () => {
  const baseInput = {
    isLoggedIn: false,
    isInitializing: false,
    isRunning: true,
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
});
