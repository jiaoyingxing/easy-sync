import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectSyncRunPhaseSummaryCounts } from "../src/sync/sync-executor";

const base = {
  uploaded: 2,
  downloaded: 1,
  deleted: 3,
  deferred: 1,
  errors: 2,
  skippedLarge: 3,
  skippedIgnored: 4,
};

describe("sync run phase summary counts", () => {
  it("splits 3 real conflicts and 5 cloud-delete confirmations into the old sum plus the new parts", () => {
    const counts = projectSyncRunPhaseSummaryCounts({
      ...base,
      conflicts: 8,
      remoteDeletePending: 5,
    });

    expect(counts).toMatchObject({
      conflicts: 8,
      conflictsOnly: 3,
      remoteDeletePending: 5,
    });
    // The historical sum keeps its exact old meaning.
    expect(counts.conflicts).toBe(counts.conflictsOnly + counts.remoteDeletePending);
    // Every pre-existing count is carried through untouched.
    expect(counts).toMatchObject(base);
  });

  it("keeps the identity for zero, absent and over-count inputs", () => {
    for (const input of [
      { conflicts: 0, remoteDeletePending: 0 },
      { conflicts: 4 },
      { conflicts: 2, remoteDeletePending: 9 },
      { conflicts: -3, remoteDeletePending: 5 },
    ]) {
      const counts = projectSyncRunPhaseSummaryCounts({ ...base, ...input });
      expect(counts.conflicts).toBe(
        counts.conflictsOnly + counts.remoteDeletePending,
      );
      expect(counts.conflictsOnly).toBeGreaterThanOrEqual(0);
      expect(counts.remoteDeletePending).toBeGreaterThanOrEqual(0);
      expect(counts.conflicts).toBeGreaterThanOrEqual(0);
    }
  });

  it("increments the split counter in the same branch as the historical sum", () => {
    const source = readFileSync("src/sync/sync-executor.ts", "utf8");
    const start = source.indexOf("private executeConfirmLocalDeleteItem");
    const end = source.indexOf("private async executeConflictItem");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain("result.conflicts++;");
    expect(body).toContain("result.remoteDeletePending++;");
    // The phase summary must print the projection (identity included), not a
    // hand-built subset that can drift from the result.
    expect(source).toContain("counts: projectSyncRunPhaseSummaryCounts(result),");
  });
});
