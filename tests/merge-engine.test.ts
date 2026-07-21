import { describe, expect, it } from "vitest";
import { threeWayMerge } from "../src/sync/merge-engine";
import { MERGE_CONTRACT_CASES } from "./fixtures/merge-contract-cases";

describe("merge contract fixture", () => {
  it("covers every required preflight category", () => {
    expect(new Set(MERGE_CONTRACT_CASES.map((item) => item.category))).toEqual(new Set([
      "non-overlap",
      "overlap",
      "same-edit",
      "empty",
      "line-ending",
      "unicode",
      "long-line",
      "large-text",
    ]));
    expect(MERGE_CONTRACT_CASES.every((item) => item.base !== undefined)).toBe(true);
  });
});

describe("threeWayMerge", () => {
  it("clean merge: non-overlapping changes on different lines", () => {
    const base = "line1\nline2\nline3\nline4";
    const local = "line1\nmodified2\nline3\nline4";
    const remote = "line1\nline2\nmodified3\nline4";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toBe("line1\nmodified2\nmodified3\nline4");
  });

  it("conflict: both sides changed the same line", () => {
    const base = "line1\nline2\nline3";
    const local = "line1\nlocal-change\nline3";
    const remote = "line1\nremote-change\nline3";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain("<<<<<<< Local");
    expect(result.merged).toContain("local-change");
    expect(result.merged).toContain("=======");
    expect(result.merged).toContain("remote-change");
    expect(result.merged).toContain(">>>>>>> Remote");
  });

  it("clean merge: only local changed, remote unchanged", () => {
    const base = "a\nb\nc";
    const local = "a\nX\nc";
    const remote = "a\nb\nc";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toBe("a\nX\nc");
  });

  it("clean merge: local delete + remote keep different line", () => {
    const base = "a\nb\nc\nd";
    const local = "a\nc\nd";       // deleted b
    const remote = "a\nb\nX\nd";   // changed c to X

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    const lines = result.merged.split("\n");
    expect(lines).toEqual(["a", "X", "d"]);
    // b deleted (local), c→X (remote) — non-overlapping
  });

  it("conflict: local delete + remote modify same line", () => {
    const base = "a\nb\nc";
    const local = "a\nc";          // deleted b
    const remote = "a\nX\nc";      // changed b to X

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(true);
  });

  it("Preflight Merge — partially overlapping multi-line hunks conflict", () => {
    const base = "a\nb\nc\nd";
    const local = "a\nlocal-b\nlocal-c\nd";
    const remote = "a\nb\nremote-c\nd";

    const result = threeWayMerge(base, local, remote);

    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain("<<<<<<< Local");
    expect(result.merged).toContain("remote-c");
  });

  it.each(MERGE_CONTRACT_CASES)("contract: $id", (fixture) => {
    const result = threeWayMerge(fixture.base, fixture.local, fixture.remote);
    expect(result.hasConflicts).toBe(fixture.expected === "conflict");
    if (fixture.expectedMerged !== undefined) expect(result.merged).toBe(fixture.expectedMerged);
  });

  it("clean merge: both sides append different lines", () => {
    const base = "line1\nline2";
    const local = "line1\nline2\nlocal-addition";
    const remote = "line1\nline2\nremote-addition";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain("local-addition");
    expect(result.merged).toContain("remote-addition");
  });

  it("clean merge with empty base when both sides created identical content", () => {
    const base = "";
    const local = "hello world";
    const remote = "hello world";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toBe("hello world");
  });

  it("clean merge: local inserts, remote unchanged", () => {
    const base = "a\nb";
    const local = "a\ninserted\nb";
    const remote = "a\nb";

    const result = threeWayMerge(base, local, remote);
    expect(result.hasConflicts).toBe(false);
    expect(result.merged).toBe("a\ninserted\nb");
  });
});
