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
    progress.setProgress(3, 4, "large.bin", SyncActionType.Download);
    expect(syncProgressPercent(progress.state)).toBe(50);

    progress.setByteProgress(50, 100);
    expect(syncProgressPercent(progress.state)).toBe(63);

    progress.completeCurrentItem();
    expect(syncProgressPercent(progress.state)).toBe(75);

    progress.setProgress(4, 4, "last.md", SyncActionType.Upload);
    expect(syncProgressPercent(progress.state)).toBe(75);
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

});
