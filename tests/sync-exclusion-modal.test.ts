import { describe, expect, it, vi } from "vitest";
import {
  buildSyncExclusionFolderCandidates,
  SyncExclusionEditSession,
} from "../src/ui/sync-exclusion-modal";

describe("sync exclusion folder candidates", () => {
  it("merges local and cloud folders without exposing duplicates or invalid paths", () => {
    expect(buildSyncExclusionFolderCandidates(
      [
        "Local",
        "Shared",
        "Parent/Child",
        ".obsidian",
        "Notes/../Invalid",
      ],
      [
        "Cloud",
        "shared",
        "Cloud/Nested",
        "Remote\\Nested",
        "/",
      ],
      ["Cloud"],
      ".obsidian",
    )).toEqual([
      { path: "Local" },
      { path: "Parent/Child" },
      { path: "Remote/Nested" },
      { path: "Shared" },
    ]);
  });

  it("keeps nested folders selectable until an excluded parent subsumes them", () => {
    expect(buildSyncExclusionFolderCandidates(
      ["Parent", "Parent/Child"],
      ["parent", "Parent/Remote"],
      [],
      ".obsidian",
    ).map((item) => item.path)).toEqual([
      "Parent",
      "Parent/Child",
      "Parent/Remote",
    ]);

    expect(buildSyncExclusionFolderCandidates(
      ["Parent", "Parent/Child"],
      ["Parent/Remote"],
      ["parent"],
      ".obsidian",
    )).toEqual([]);
  });
});

describe("SyncExclusionEditSession", () => {
  it("recalculates exactly once after any number of saved changes to an open review", async () => {
    const recalculate = vi.fn().mockResolvedValue(undefined);
    const session = new SyncExclusionEditSession(true);

    session.markSavedChange();
    session.markSavedChange();
    await Promise.all([
      session.close(recalculate),
      session.close(recalculate),
    ]);

    expect(recalculate).toHaveBeenCalledTimes(1);
  });

  it("does not recalculate without a saved change or a review present at open", async () => {
    const recalculate = vi.fn().mockResolvedValue(undefined);
    const unchanged = new SyncExclusionEditSession(true);
    const withoutReview = new SyncExclusionEditSession(false);

    withoutReview.markSavedChange();
    await unchanged.close(recalculate);
    await withoutReview.close(recalculate);

    expect(recalculate).not.toHaveBeenCalled();
  });
});
