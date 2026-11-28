import { describe, expect, it, vi } from "vitest";
import {
  isAnySyncActivityRunning,
  resolveRoundProgressCurrent,
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
    expect(progress.state.completedFiles).toEqual([]);

    progress.addCompletedFile({ path: "c.md", status: "upload" });
    expect(progress.state.completedCount).toBe(1);

    progress.markStarted();
    expect(progress.state.completedCount).toBe(0);
    expect(progress.state.completedFiles).toEqual([]);
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

  it("keeps phase metrics separate from round counts and resets them per phase", () => {
    const progress = new SyncProgressStore();
    progress.markStarted();

    progress.setPhase("planningRecords");
    progress.setPhaseMetric({ current: 3, total: 10, unit: "batches" });
    expect(progress.state.phaseStartedAt).toBeGreaterThan(0);
    expect(progress.state.phaseMetric).toEqual({
      current: 3,
      total: 10,
      unit: "batches",
    });
    // The round's own counter stays untouched; the body bar cannot mount.
    expect(progress.state.current).toBe(0);
    expect(progress.state.total).toBe(0);

    progress.setPhase("planning");
    expect(progress.state.phaseMetric).toBeUndefined();

    progress.setPhase("executing");
    progress.setProgress(3, 10, "note.md", SyncActionType.Upload);
    progress.setPhase("committing", { keepCounts: true });
    expect(progress.state.current).toBe(3);
    expect(progress.state.total).toBe(10);
    expect(progress.state.currentFile).toBe("");
    expect(progress.state.phaseMetric).toBeUndefined();
  });

  it("keeps already settled rows when a side-action batch moves from preparation to execution", () => {
    const progress = new SyncProgressStore();
    progress.markStarted("sideAction");
    progress.setPhase("preparingAction");
    progress.addCompletedFile({ path: "first.md", status: "delete" });

    progress.setPhase("executing", { keepCompleted: true });
    expect(progress.state.completedFiles.map((file) => file.path))
      .toEqual(["first.md"]);
    expect(progress.state.completedCount).toBe(1);

    progress.setPhase("executing");
    expect(progress.state.completedFiles).toEqual([]);
    expect(progress.state.completedCount).toBe(0);
  });

  it("keeps one phase start for a repeated same-phase switch and restarts on a new phase or round", () => {
    const progress = new SyncProgressStore();
    const now = vi.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_000);
      progress.markStarted();
      progress.setPhase("planning");
      expect(progress.state.phaseStartedAt).toBe(1_000);

      now.mockReturnValue(2_000);
      progress.setPhase("planning");
      expect(progress.state.phaseStartedAt).toBe(1_000);

      progress.setPhase("savingPlan");
      expect(progress.state.phaseStartedAt).toBe(2_000);

      // `markStarted` clears the timestamp; the next round's first phase must
      // start a fresh window even when its name repeats the previous one.
      progress.setPhase("planning");
      progress.markStarted();
      now.mockReturnValue(3_000);
      progress.setPhase("planning");
      expect(progress.state.phaseStartedAt).toBe(3_000);
    } finally {
      now.mockRestore();
    }
  });

  it("clamps a phase metric's total to its current count", () => {
    const progress = new SyncProgressStore();
    progress.setPhase("scanning");
    progress.setPhaseMetric({ current: 12, total: 5, unit: "items" });
    expect(progress.state.phaseMetric).toEqual({
      current: 12,
      total: 12,
      unit: "items",
    });
  });

  it("shows the known item size from the first visible moment", () => {
    const progress = new SyncProgressStore();

    progress.setPhase("executing");
    progress.setProgress(
      0,
      3,
      "phone-download.bin",
      SyncActionType.Download,
      2048,
    );

    // 移动端整包回退或非流式通道没有中间字节回调时，名称行右侧仍要显示
    // 文件大小；这不是伪造进度，已传字节如实为 0。
    expect(progress.state.currentItemBytes).toBe(0);
    expect(progress.state.currentItemTotalBytes).toBe(2048);

    progress.setByteProgress(512, 2048);
    expect(progress.state.currentItemBytes).toBe(512);
    expect(progress.state.currentItemTotalBytes).toBe(2048);

    // 切到没有已知大小的动作（删除等）时，右侧字节位照旧退场。
    progress.setProgress(1, 3, "old.md", SyncActionType.DeleteRemote);
    expect(progress.state.currentItemBytes).toBe(0);
    expect(progress.state.currentItemTotalBytes).toBe(0);
  });

  it("ignores a non-finite or non-positive known size", () => {
    const progress = new SyncProgressStore();

    progress.setPhase("executing");
    progress.setProgress(0, 1, "empty.md", SyncActionType.Upload, 0);
    expect(progress.state.currentItemTotalBytes).toBe(0);

    progress.setProgress(1, 2, "bad.md", SyncActionType.Upload, Number.NaN);
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

  it("raises the visible round position with the download lookahead", () => {
    const progress = new SyncProgressStore();
    progress.setPhase("executing");
    progress.setProgress(0, 4, "a.md", SyncActionType.Download);

    // The lookahead moves the visible counter/bar while `current` stays the
    // durable settled count.
    progress.setProcessedCurrent(3);
    expect(progress.state.current).toBe(0);
    expect(resolveRoundProgressCurrent(progress.state)).toBe(3);
    expect(syncProgressPercent(progress.state)).toBe(75);

    // It never decreases, and it cannot pass the round total.
    progress.setProcessedCurrent(2);
    expect(resolveRoundProgressCurrent(progress.state)).toBe(3);
    progress.setProcessedCurrent(9);
    expect(resolveRoundProgressCurrent(progress.state)).toBe(4);

    // A later settled count below the lookahead does not pull the display
    // back; finish clears the lookahead so the result uses settled items.
    progress.setProgress(1, 4, "b.md", SyncActionType.Download);
    expect(resolveRoundProgressCurrent(progress.state)).toBe(4);
    progress.finish();
    expect(progress.state.processedCurrent).toBeUndefined();
    expect(resolveRoundProgressCurrent(progress.state)).toBe(1);
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

  it("shows a download preview immediately and replaces it in place at settlement", () => {
    const progress = new SyncProgressStore();
    progress.setPhase("executing");
    progress.addCompletedFile({ path: "first.md", status: "upload", actionType: SyncActionType.Upload });
    progress.addProvisionalCompletedFile({
      path: "second.md",
      status: "download",
      actionType: SyncActionType.Download,
      fileSize: 42,
    });

    // The preview is a full row as soon as the bytes land: same list, same
    // settled-action count the round will report once the group commits.
    expect(progress.state.completedFiles.map((file) => file.path)).toEqual([
      "first.md",
      "second.md",
    ]);
    expect(progress.state.completedFiles[1]).toMatchObject({
      status: "download",
      actionType: SyncActionType.Download,
      fileSize: 42,
      provisional: true,
    });
    expect(progress.state.completedCount).toBe(2);
    expect(progress.provisionalFilePaths()).toEqual(["second.md"]);

    // The durable completion replaces the row where it stands, not as a
    // second row at the top, and the item is not counted twice.
    progress.addCompletedFile({
      path: "second.md",
      status: "download",
      actionType: SyncActionType.Download,
      fileSize: 42,
    });
    expect(progress.state.completedFiles.map((file) => file.path)).toEqual([
      "first.md",
      "second.md",
    ]);
    expect(progress.state.completedFiles[1].provisional).toBeUndefined();
    expect(progress.state.completedCount).toBe(2);
    expect(progress.provisionalFilePaths()).toEqual([]);
  });

  it("flips a preview whose group never committed and drops it from the preview set", () => {
    const progress = new SyncProgressStore();
    progress.setPhase("executing");
    progress.addProvisionalCompletedFile({
      path: "a.md",
      status: "download",
      actionType: SyncActionType.Download,
    });

    expect(progress.revertCompletedFile("a.md", "同步已取消")).toBe(true);
    expect(progress.state.completedFiles[0]).toMatchObject({
      status: "error",
      reason: "同步已取消",
      actionType: SyncActionType.Download,
    });
    expect(progress.state.completedFiles[0].provisional).toBeUndefined();
    expect(progress.provisionalFilePaths()).toEqual([]);
    // A row already flipped once is never rewritten by a second report.
    expect(progress.revertCompletedFile("a.md", "同步已取消")).toBe(false);
  });

  it("settles leftover previews at round end so a non-durable row never reads as success", () => {
    const progress = new SyncProgressStore();
    progress.setPhase("executing");
    progress.addProvisionalCompletedFile({
      path: "leftover.md",
      status: "download",
      actionType: SyncActionType.Download,
    });

    progress.finish("同步已取消");
    expect(progress.state.completedFiles[0]).toMatchObject({
      path: "leftover.md",
      status: "error",
      reason: "同步已取消",
    });
    expect(progress.state.completedFiles[0].provisional).toBeUndefined();
    expect(progress.provisionalFilePaths()).toEqual([]);
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
