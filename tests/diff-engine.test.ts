import { describe, expect, it } from "vitest";
import { computeDiff } from "../src/ui/diff-engine";

describe("computeDiff", () => {
  it("marks identical files as all equal", () => {
    const text = "line1\nline2\nline3";
    const result = computeDiff(text, text);

    expect(result.truncated).toBe(false);
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    for (const line of result.lines) {
      expect(line.type).toBe("equal");
    }
  });

  it("detects appended lines", () => {
    const local = "line1\nline2";
    const remote = "line1\nline2\nline3\nline4";
    const result = computeDiff(local, remote);

    expect(result.truncated).toBe(false);
    expect(result.addedCount).toBe(2);
    expect(result.removedCount).toBe(0);

    const types = result.lines.map((l) => l.type);
    expect(types).toEqual(["equal", "equal", "added", "added"]);
  });

  it("detects removed lines", () => {
    const local = "a\nb\nc\nd";
    const remote = "a\nd";
    const result = computeDiff(local, remote);

    expect(result.truncated).toBe(false);
    expect(result.removedCount).toBe(2);
    expect(result.addedCount).toBe(0);
  });

  it("detects changed middle lines", () => {
    const local = "keep1\nold\nkeep2";
    const remote = "keep1\nnew\nkeep2";
    const result = computeDiff(local, remote);

    expect(result.truncated).toBe(false);
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(1);

    const types = result.lines.map((l) => l.type);
    expect(types).toEqual(["equal", "removed", "added", "equal"]);
  });

  it("handles completely different files", () => {
    // Generate sufficiently different content to exceed MAX_D
    const local = Array.from({ length: 100 }, (_, i) => `local-line-${i}`).join("\n");
    const remote = Array.from({ length: 100 }, (_, i) => `remote-line-${i}`).join("\n");
    const result = computeDiff(local, remote);

    // With 200 total lines and completely different content (D=100),
    // MAX_D won't be hit with only 100 lines each side.
    // Verify it completes normally.
    expect(result.truncated).toBe(false);
    expect(result.removedCount).toBe(100);
    expect(result.addedCount).toBe(100);
  });

  it("handles empty vs non-empty", () => {
    const result = computeDiff("", "only-remote");

    expect(result.truncated).toBe(false);
    // "" splits to [""], "only-remote" to ["only-remote"] — one replace
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(1);
    expect(result.lines[0].type).toBe("removed");
    expect(result.lines[0].text).toBe("");
    expect(result.lines[1].type).toBe("added");
    expect(result.lines[1].text).toBe("only-remote");
  });

  it("handles non-empty vs empty", () => {
    const result = computeDiff("only-local", "");

    expect(result.truncated).toBe(false);
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(1);
  });

  it("truncates when total lines exceed MAX_TOTAL_LINES", () => {
    const localLines = Array.from(
      { length: 2500 },
      (_, i) => `line-${i}`,
    ).join("\n");
    const remoteLines = Array.from(
      { length: 2500 },
      (_, i) => `line-${i}`,
    ).join("\n");
    const result = computeDiff(localLines, remoteLines);

    expect(result.truncated).toBe(true);
    expect(result.lines).toEqual([]);
    expect(result.localSample).toHaveLength(100);
    expect(result.remoteSample).toHaveLength(100);
    expect(result.localTotalLines).toBe(2500);
    expect(result.remoteTotalLines).toBe(2500);
  });

  it("returns correct line numbers", () => {
    const local = "a\nb\nc";
    const remote = "a\nx\nc";
    const result = computeDiff(local, remote);

    const eq1 = result.lines[0];
    expect(eq1.type).toBe("equal");
    expect(eq1.lineNumber).toEqual({ local: 1, remote: 1 });

    const removed = result.lines[1];
    expect(removed.type).toBe("removed");
    expect(removed.lineNumber.local).toBe(2);

    const added = result.lines[2];
    expect(added.type).toBe("added");
    expect(added.lineNumber.remote).toBe(2);

    const eq2 = result.lines[3];
    expect(eq2.type).toBe("equal");
    expect(eq2.lineNumber).toEqual({ local: 3, remote: 3 });
  });
});
