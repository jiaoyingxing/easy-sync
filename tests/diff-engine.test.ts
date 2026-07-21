import { describe, expect, it } from "vitest";
import { computeDiff, computeDisplayDiff } from "../src/ui/diff-engine";

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

describe("computeDisplayDiff", () => {
  it("shows a same-line conflict as one numbered replacement instead of coloring the whole file", () => {
    const local = "head\nshared local addition\ntail";
    const remote = "head\nshared remote addition\ntail";

    const result = computeDisplayDiff(local, remote);

    expect(result.complete).toBe(true);
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.parts).toHaveLength(1);
    if (result.parts[0]?.kind !== "hunk") throw new Error("expected exact hunk");
    expect(result.parts[0].lines.filter((line) => line.type !== "equal")).toEqual([
      {
        type: "removed",
        text: "shared local addition",
        lineNumber: { local: 2 },
      },
      {
        type: "added",
        text: "shared remote addition",
        lineNumber: { remote: 2 },
      },
    ]);
    expect(result.parts[0].lines).toHaveLength(4);
  });

  it("finds the exact changed lines in a large text without rendering the whole file", () => {
    const localLines = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);
    const remoteLines = [...localLines];
    remoteLines[7_654] = "remote-change";

    const result = computeDisplayDiff(
      localLines.join("\n"),
      remoteLines.join("\n"),
    );

    expect(result.complete).toBe(true);
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ kind: "hunk" });
    if (result.parts[0]?.kind !== "hunk") throw new Error("expected exact hunk");
    expect(result.parts[0].lines.filter((line) => line.type !== "equal")).toEqual([
      {
        type: "removed",
        text: "line-7654",
        lineNumber: { local: 7_655 },
      },
      {
        type: "added",
        text: "remote-change",
        lineNumber: { remote: 7_655 },
      },
    ]);
    expect(result.parts[0].lines.length).toBeLessThanOrEqual(8);
  });

  it("keeps distant changes in separate exact windows", () => {
    const localLines = Array.from({ length: 12_000 }, (_, index) => `line-${index}`);
    const remoteLines = [...localLines];
    remoteLines[100] = "remote-100";
    remoteLines[11_500] = "remote-11500";

    const result = computeDisplayDiff(localLines.join("\n"), remoteLines.join("\n"));

    expect(result.complete).toBe(true);
    expect(result.addedCount).toBe(2);
    expect(result.removedCount).toBe(2);
    expect(result.parts).toHaveLength(2);
    expect(result.parts.every((part) => part.kind === "hunk")).toBe(true);
    expect(result.parts.flatMap((part) => part.kind === "hunk" ? part.lines : []))
      .toHaveLength(16);
  });

  it("aligns a large insertion between stable anchors", () => {
    const localLines = Array.from({ length: 8_000 }, (_, index) => `line-${index}`);
    const remoteLines = [...localLines];
    remoteLines.splice(4_000, 0, "inserted-a", "inserted-b");

    const result = computeDisplayDiff(localLines.join("\n"), remoteLines.join("\n"));

    expect(result.complete).toBe(true);
    expect(result.addedCount).toBe(2);
    expect(result.removedCount).toBe(0);
    expect(result.parts).toHaveLength(1);
    if (result.parts[0]?.kind !== "hunk") throw new Error("expected exact hunk");
    expect(result.parts[0].lines.filter((line) => line.type === "added").map((line) => line.text))
      .toEqual(["inserted-a", "inserted-b"]);
  });

  it("preserves the exact Myers counts and changed lines for a bounded region", () => {
    const localLines = Array.from({ length: 300 }, (_, index) => `line-${index}`);
    const remoteLines = [...localLines];
    remoteLines.splice(30, 2, "replacement");
    remoteLines.splice(250, 0, "inserted");
    const local = localLines.join("\n");
    const remote = remoteLines.join("\n");

    const exact = computeDiff(local, remote);
    const display = computeDisplayDiff(local, remote);
    const displayChanges = display.parts.flatMap((part) =>
      part.kind === "hunk" ? part.lines.filter((line) => line.type !== "equal") : [],
    );

    expect(display.complete).toBe(true);
    expect(display.addedCount).toBe(exact.addedCount);
    expect(display.removedCount).toBe(exact.removedCount);
    expect(displayChanges.map(({ type, text }) => ({ type, text }))).toEqual(
      exact.lines
        .filter((line) => line.type !== "equal")
        .map(({ type, text }) => ({ type, text })),
    );
  });

  it("matches the exact Myers result across many changes in a large anchored file", () => {
    const localLines = Array.from({ length: 6_000 }, (_, index) => `line-${index}`);
    const remoteLines = [...localLines];
    for (let index = 5_500; index >= 500; index -= 500) {
      remoteLines.splice(index, 1, `replacement-${index}`);
      remoteLines.splice(index + 20, 0, `insertion-${index}`);
      remoteLines.splice(index + 40, 1);
    }
    const local = localLines.join("\n");
    const remote = remoteLines.join("\n");

    const exact = computeDiff(local, remote, 20_000);
    const display = computeDisplayDiff(local, remote);
    const displayChanges = display.parts.flatMap((part) =>
      part.kind === "hunk" ? part.lines.filter((line) => line.type !== "equal") : [],
    );

    expect(exact.truncated).toBe(false);
    expect(display.complete).toBe(true);
    expect(display.addedCount).toBe(exact.addedCount);
    expect(display.removedCount).toBe(exact.removedCount);
    expect(displayChanges.map(({ type, text }) => ({ type, text }))).toEqual(
      exact.lines
        .filter((line) => line.type !== "equal")
        .map(({ type, text }) => ({ type, text })),
    );
  });

  it("summarizes an unalignable large replacement instead of inventing counts", () => {
    const local = Array.from({ length: 3_000 }, (_, index) => `local-${index}`).join("\n");
    const remote = Array.from({ length: 3_000 }, (_, index) => `remote-${index}`).join("\n");

    const result = computeDisplayDiff(local, remote);

    expect(result.complete).toBe(false);
    expect(result.addedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      kind: "summary",
      reason: "alignment-limit",
      localStartLine: 1,
      localEndLine: 3_000,
      remoteStartLine: 1,
      remoteEndLine: 3_000,
      localOmittedLines: 2_984,
      remoteOmittedLines: 2_984,
    });
  });

  it("keeps exact counts for a huge pure insertion while bounding rendered samples", () => {
    const inserted = Array.from({ length: 1_000 }, (_, index) => `inserted-${index}`);
    const local = "head\nend";
    const remote = ["head", ...inserted, "end"].join("\n");

    const result = computeDisplayDiff(local, remote);

    expect(result.complete).toBe(true);
    expect(result.addedCount).toBe(1_000);
    expect(result.removedCount).toBe(0);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      kind: "summary",
      reason: "change-budget",
      remoteOmittedLines: 984,
    });
  });

  it("keeps a 50k-line unchanged body out of the display result", () => {
    const text = Array.from({ length: 50_000 }, (_, index) => `line-${index}`).join("\n");

    const result = computeDisplayDiff(text, text);

    expect(result).toMatchObject({
      complete: true,
      addedCount: 0,
      removedCount: 0,
      parts: [],
      localTotalLines: 50_000,
      remoteTotalLines: 50_000,
    });
  });

  it("stops at a bounded number of windows when differences are extremely fragmented", () => {
    const localLines = Array.from({ length: 2_000 }, (_, index) => `anchor-${index}`);
    const remoteLines = localLines.map((line, index) =>
      index % 2 === 0 ? `remote-${index}` : line,
    );

    const result = computeDisplayDiff(localLines.join("\n"), remoteLines.join("\n"));

    expect(result.complete).toBe(false);
    expect(result.parts.length).toBeLessThanOrEqual(201);
    expect(result.parts.at(-1)).toMatchObject({
      kind: "summary",
      reason: "display-budget",
    });
  });
});
