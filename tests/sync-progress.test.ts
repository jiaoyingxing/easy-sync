import { describe, expect, it } from "vitest";
import {
  isAnySyncActivityRunning,
  syncProgressPercent,
  SyncProgressStore,
} from "../src/sync/sync-progress";
import { SyncActionType } from "../src/sync/types";

describe("SyncProgressStore retention", () => {
  it("keeps every issue while limiting successful file records", () => {
    const progress = new SyncProgressStore();

    progress.addCompletedFile({ path: "early-error.md", status: "error" });
    for (let index = 0; index < 120; index++) {
      progress.addCompletedFile({ path: `note-${index}.md`, status: "upload" });
    }
    progress.addCompletedFile({ path: "late-skip.bin", status: "skip" });

    expect(progress.state.completedFiles).toHaveLength(102);
    expect(progress.state.completedFiles[0].path).toBe("early-error.md");
    expect(progress.state.completedFiles.at(-1)?.path).toBe("late-skip.bin");
    expect(progress.state.completedFiles.find((file) => file.path === "note-0.md")).toBeUndefined();
    expect(progress.state.completedFiles.find((file) => file.path === "note-20.md")).toBeDefined();
  });

  it("counts every completed file beyond the retained display cap", () => {
    const progress = new SyncProgressStore();
    for (let index = 0; index < 150; index++) {
      progress.addCompletedFile({ path: `note-${index}.md`, status: "upload" });
    }

    expect(progress.state.completedFiles.length).toBe(100);
    expect(progress.state.completedCount).toBe(150);
  });

  it("keeps a 37-success round's failure row and never trims issue rows at the cap", () => {
    const progress = new SyncProgressStore();
    for (let index = 0; index < 37; index++) {
      progress.addCompletedFile({ path: `ok-${index}.md`, status: "upload" });
    }
    progress.addCompletedFile({
      path: "failed.md",
      status: "error",
      reason: "network",
    });

    // 真机情景（iPhone 截图）：一轮 37 个成功 + 1 条上一轮遗留的失败，行数
    // 必须是 38——失败行不是「可省略的成功记录」，不会被保留上限吃掉。
    expect(progress.state.completedFiles).toHaveLength(38);
    expect(progress.state.completedFiles.at(-1)).toMatchObject({
      path: "failed.md",
      status: "error",
    });
    expect(progress.state.completedCount).toBe(38);

    // 成功记录超过上限后只裁成功行：失败行仍留在列表里。
    for (let index = 0; index < 100; index++) {
      progress.addCompletedFile({ path: `later-${index}.md`, status: "upload" });
    }
    expect(
      progress.state.completedFiles.filter((file) => file.status !== "error"),
    ).toHaveLength(100);
    expect(
      progress.state.completedFiles.find((file) => file.path === "failed.md"),
    ).toBeDefined();
  });

  it("resets the completed count together with the retained list", () => {
    const progress = new SyncProgressStore();
    progress.addCompletedFile({ path: "a.md", status: "upload" });
    progress.addCompletedFile({ path: "b.md", status: "error" });
    expect(progress.state.completedCount).toBe(2);

    progress.setPhase("executing");
    expect(progress.state.completedCount).toBe(0);

    progress.addCompletedFile({ path: "c.md", status: "upload" });
    expect(progress.state.completedCount).toBe(1);

    progress.markStarted();
    expect(progress.state.completedCount).toBe(0);
  });

  it("tracks the active action and cancellation until the run settles", () => {
    const progress = new SyncProgressStore();

    progress.setPhase("executing");
    progress.setProgress(3, 10, "note.md", SyncActionType.Upload);
    progress.requestCancel();

    expect(progress.state.currentActionType).toBe(SyncActionType.Upload);
    expect(progress.state.cancelRequested).toBe(true);

    progress.finish();
    expect(progress.state.currentActionType).toBeUndefined();
    expect(progress.state.cancelRequested).toBe(false);
  });

  it("clears stale byte progress when execution advances to the next file", () => {
    const progress = new SyncProgressStore();

    progress.setPhase("executing");
    progress.setProgress(1, 3, "first.bin", SyncActionType.Download);
    progress.setByteProgress(512, 1024);

    progress.setProgress(2, 3, "second.bin", SyncActionType.Download);

    expect(progress.state.currentFile).toBe("second.bin");
    expect(progress.state.currentItemBytes).toBe(0);
    expect(progress.state.currentItemTotalBytes).toBe(0);
  });

  it("keeps byte progress monotonic and never exposes current above total", () => {
    const progress = new SyncProgressStore();

    progress.setPhase("executing");
    progress.setProgress(1, 1, "download.bin", SyncActionType.Download);
    progress.setByteProgress(0, 100);
    progress.setByteProgress(60, 100);
    progress.setByteProgress(0, 100);

    expect(progress.state.currentItemBytes).toBe(60);
    expect(progress.state.currentItemTotalBytes).toBe(100);

    progress.setByteProgress(130, 100);
    expect(progress.state.currentItemBytes).toBe(130);
    expect(progress.state.currentItemTotalBytes).toBe(130);

    progress.setByteProgress(Number.NaN, -1);
    expect(progress.state.currentItemBytes).toBe(130);
    expect(progress.state.currentItemTotalBytes).toBe(130);
  });

  it("folds current-file byte progress into monotonic whole-run progress", () => {
    const progress = new SyncProgressStore();

    progress.setPhase("executing");
    // `current` counts settled items (2026-10-26): three of four done = 75%.
    progress.setProgress(3, 4, "large.bin", SyncActionType.Download);
    expect(syncProgressPercent(progress.state)).toBe(75);

    progress.setByteProgress(50, 100);
    expect(syncProgressPercent(progress.state)).toBe(88);

    progress.setProgress(4, 4, "last.md", SyncActionType.Upload);
    expect(syncProgressPercent(progress.state)).toBe(100);
  });

  it("treats executor and progress store as one running signal", () => {
    const progress = new SyncProgressStore();

    expect(isAnySyncActivityRunning(progress.state, false, false)).toBe(false);

    progress.markStarted();
    progress.setPhase("scanning");
    expect(isAnySyncActivityRunning(progress.state, false, false)).toBe(true);

    progress.finish();
    expect(isAnySyncActivityRunning(progress.state, false, false)).toBe(false);
    expect(isAnySyncActivityRunning(progress.state, false, true)).toBe(true);
    expect(isAnySyncActivityRunning(progress.state, true, false)).toBe(true);
  });

  it("keeps recovery proof separate from mutations until the next run", () => {
    const progress = new SyncProgressStore();
    progress.markStarted();
    progress.setRecoveryVerification({
      operationFingerprint: "abcdef123456",
      protocolPreflight: "ready",
      total: 3,
      verifiedThisRun: 1,
      reused: 1,
      invalidated: 0,
      remaining: 1,
      failureStage: "body-verification",
      firstFailurePath: "Notes/c.md",
    });

    progress.finish();
    expect(progress.state.recoveryVerification).toMatchObject({
      verifiedThisRun: 1,
      reused: 1,
      remaining: 1,
    });
    expect(progress.state.completedFiles).toEqual([]);

    progress.markStarted();
    expect(progress.state.recoveryVerification).toBeUndefined();
  });

  it("flips a shown success to failed in place when its batch checkpoint did not commit", () => {
    const progress = new SyncProgressStore();
    progress.setPhase("executing");
    progress.addCompletedFile({ path: "a.md", status: "upload", actionType: SyncActionType.Upload });
    progress.addCompletedFile({ path: "b.md", status: "upload", actionType: SyncActionType.Upload });

    expect(progress.revertCompletedFile("a.md", "同步已取消")).toBe(true);

    // The row stays where it was (no jump to the top) and keeps its action
    // type; it gains the failure status and the reason. The settled-action
    // count does not change: the file's own work did happen.
    expect(progress.state.completedFiles.map((file) => file.path)).toEqual([
      "a.md",
      "b.md",
    ]);
    expect(progress.state.completedFiles[0]).toMatchObject({
      path: "a.md",
      status: "error",
      reason: "同步已取消",
      actionType: SyncActionType.Upload,
    });
    expect(progress.state.completedFiles[0].failedAt).toBeTypeOf("number");
    expect(progress.state.completedFiles[1].status).toBe("upload");
    expect(progress.state.completedCount).toBe(2);
  });

  it("keeps an already-failed row as the failure it is when a flip is asked twice", () => {
    const progress = new SyncProgressStore();
    progress.setPhase("executing");
    progress.addCompletedFile({ path: "a.md", status: "error", reason: "network" });

    // Nothing successful to flip: the row already tells the truth, so the
    // second report is a no-op instead of rewriting the reason.
    expect(progress.revertCompletedFile("a.md", "同步已取消")).toBe(false);
    expect(progress.state.completedFiles[0]).toMatchObject({
      status: "error",
      reason: "network",
    });
  });

});
