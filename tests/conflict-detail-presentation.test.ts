import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getDiffLineNumberWidth,
} from "../src/ui/conflict-detail-modal";
import {
  getDiffSummaryReasonKey,
  summarizeConflictDetail,
} from "../src/ui/conflict-detail-presentation";
import type { DisplayDiffResult } from "../src/ui/diff-engine";

const t = (key: string, params?: Record<string, string | number>): string => {
  const templates: Record<string, string> = {
    "conflictDetail.summaryComparing": "本地与远端版本不同，正在确认具体内容差异。",
    "conflictDetail.summaryComparisonUnavailable": "暂时无法确认本地与远端的具体内容差异。",
    "conflictDetail.summaryLocalExtra": "本地比远端多 {count} 行。",
    "conflictDetail.summaryRemoteExtra": "远端比本地多 {count} 行。",
    "conflictDetail.summaryBothModified": "本地和远端都有修改。",
    "conflictDetail.summaryBothExistDifferent": "本地和远端都存在这个文件，但内容不同。",
    "conflictDetail.summaryDifferent": "本地与远端内容不同。",
    "conflictDetail.summaryBytesDifferentNoLineDiff": "本地与远端文件字节不同，但没有可显示的逐行差异。",
    "reason.localDeletedRemoteModified": "已在本地删除，但远端有新的修改",
    "reason.newFileBothSides": "本地和远端都存在这个文件。",
    "syncView.conflict.defaultReason": "冲突",
  };
  let text = templates[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
};

function displayResult(
  addedCount: number,
  removedCount: number,
  complete = true,
  partCount = 1,
): DisplayDiffResult {
  return {
    complete,
    addedCount,
    removedCount,
    parts: Array.from({ length: partCount }, () => ({
      kind: "hunk" as const,
      lines: [],
    })),
  };
}

describe("conflict detail presentation", () => {
  it("describes a +0/-20 diff as local content having 20 extra lines", () => {
    expect(summarizeConflictDetail(
      { kind: "text-diff", diff: displayResult(0, 20) },
      "reason.bothSidesModified",
      t,
    )).toBe(
      "本地比远端多 20 行。",
    );
  });

  it("keeps exact one-sided line counts but does not infer unique lines from a two-sided edit script", () => {
    expect(summarizeConflictDetail(
      { kind: "text-diff", diff: displayResult(12, 0) },
      "reason.newFileBothSides",
      t,
    )).toBe(
      "远端比本地多 12 行。",
    );
    expect(summarizeConflictDetail(
      { kind: "text-diff", diff: displayResult(7, 5) },
      "reason.bothSidesModified",
      t,
    )).toBe(
      "本地和远端都有修改。",
    );
    expect(summarizeConflictDetail(
      { kind: "text-diff", diff: displayResult(0, 0, false, 3) },
      "reason.newFileBothSides",
      t,
    )).toBe(
      "本地和远端都存在这个文件，但内容不同。",
    );
  });

  it("keeps comparison phase, byte-only difference, and conflict cause as separate summary states", () => {
    expect(summarizeConflictDetail(
      { kind: "comparing" },
      "reason.bothSidesModified",
      t,
    )).toBe("本地与远端版本不同，正在确认具体内容差异。");
    expect(summarizeConflictDetail(
      { kind: "comparison-unavailable" },
      "reason.newFileBothSides",
      t,
    )).toBe("暂时无法确认本地与远端的具体内容差异。");
    expect(summarizeConflictDetail(
      { kind: "bytes-different-no-line-diff" },
      "reason.bothSidesModified",
      t,
    )).toBe("本地与远端文件字节不同，但没有可显示的逐行差异。");
    expect(summarizeConflictDetail(
      { kind: "reason" },
      "reason.localDeletedRemoteModified",
      t,
    )).toBe("已在本地删除，但远端有新的修改");
    expect(summarizeConflictDetail(
      { kind: "reason" },
      "reason.newFileBothSides",
      t,
    )).toBe("本地和远端都存在这个文件。");
    expect(summarizeConflictDetail(
      { kind: "content-different" },
      undefined,
      t,
    )).toBe("本地与远端内容不同。");
  });

  it("removes unique-line and region-count claims from the top summary path", () => {
    const source = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
    const policy = readFileSync("src/ui/conflict-detail-presentation.ts", "utf8");

    expect(policy).not.toContain("summaryBothDifferent");
    expect(policy).not.toContain("summaryRegions");
    expect(source).toContain('setSummary({ kind: "bytes-different-no-line-diff" })');
    expect(source).toContain('setSummary({ kind: "reason" })');
  });

  it("keeps bounded-diff limitation reasons in one exhaustive copy mapping", () => {
    expect(getDiffSummaryReasonKey("change-budget")).toBe("conflictDetail.diffChangeBudget");
    expect(getDiffSummaryReasonKey("alignment-limit")).toBe("conflictDetail.diffAlignmentLimit");
    expect(getDiffSummaryReasonKey("display-budget")).toBe("conflictDetail.diffDisplayBudget");
  });

  it("does not expose raw failures or guess a network cause in conflict detail copy", () => {
    const source = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
    const zhCN = readFileSync("src/i18n/zh-cn.ts", "utf8");

    expect(source).not.toContain('t("conflictDetail.loadFailed"');
    expect(zhCN).not.toContain("远端内容暂不可用（可能是网络限制）");
    expect(zhCN).not.toContain('"conflictDetail.loadFailed"');
    expect(zhCN).not.toContain("请尝试保留本地版本");
    expect(zhCN).toContain("未能下载远端版本，本次未作更改");
  });

  it("restores the f3e0bbe metadata hierarchy with neutral headers and colored data columns", () => {
    const source = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");

    expect(source).toContain('headerRow.createEl("th");');
    expect(source).not.toContain('t("conflictDetail.legendLabel")');
    expect(source.match(/createEl\("td", "easy-sync-meta-col-local"\)/g)).toHaveLength(2);
    expect(source.match(/createEl\("td", "easy-sync-meta-col-remote"\)/g)).toHaveLength(2);
    expect(styles).toMatch(
      /\.easy-sync-metadata-table th\s*\{[^}]*background:\s*var\(--background-secondary\);[^}]*font-weight:\s*600;/s,
    );
    expect(styles).toMatch(
      /\.easy-sync-metadata-table td:first-child\s*\{[^}]*font-weight:\s*500;[^}]*background:\s*var\(--background-secondary\);/s,
    );
    expect(styles).toMatch(/\.easy-sync-metadata-table td\.easy-sync-meta-col-local\s*\{/);
    expect(styles).toMatch(/\.easy-sync-metadata-table td\.easy-sync-meta-col-remote\s*\{/);
  });

  it("restores accent color and weight for newer/larger metadata", () => {
    const source = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");

    expect(source.match(/addClass\("easy-sync-meta-highlight"\)/g)).toHaveLength(4);
    expect(styles).toMatch(
      /\.easy-sync-meta-highlight\s*\{[^}]*color:\s*var\(--text-accent\);[^}]*font-weight:\s*600;/s,
    );
  });

  it("keeps local and remote line numbers in compact independent columns", () => {
    const source = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");

    expect(source).not.toContain("padStart(6)");
    expect(source.match(/createSpan\("easy-sync-diff-line-number"\)/g)).toHaveLength(2);
    expect(source).toMatch(
      /style\.setProperty\(\s*"--easy-sync-diff-line-number-width"/,
    );
    expect(styles).toMatch(
      /grid-template-columns:\s*repeat\(2,\s*var\(--easy-sync-diff-line-number-width,\s*2ch\)\);/,
    );
    expect(styles).not.toContain("width: 96px");
    expect(getDiffLineNumberWidth(14, 15)).toBe("2ch");
    expect(getDiffLineNumberWidth(99_999, 100_000)).toBe("6ch");
  });

  it("does not replace the numbered line diff with a persisted whole-file merge preview", () => {
    const source = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
    const executor = readFileSync("src/sync/sync-executor.ts", "utf8");
    const types = readFileSync("src/sync/types.ts", "utf8");

    expect(source).not.toContain("renderMergeResult");
    expect(source).not.toContain("this.item.hasMergeConflicts");
    expect(executor).not.toContain("item.mergedContent");
    expect(types).not.toContain("mergedContent?: string");
    expect(types).not.toContain("hasMergeConflicts?: boolean");
  });

  it("colors only the conflict detail keep-local and keep-remote buttons", () => {
    const source = readFileSync("src/ui/conflict-detail-modal.ts", "utf8");
    const styles = readFileSync("styles.css", "utf8");

    expect(source).toContain('keepLocalBtn.addClass("easy-sync-detail-action-local")');
    expect(source).toContain('keepRemoteBtn.addClass("easy-sync-detail-action-remote")');
    expect(styles).toMatch(
      /\.easy-sync-detail-actions \.easy-sync-detail-action-local\s*\{[^}]*background-color:\s*rgba\(var\(--color-red-rgb\),\s*0\.18\);[^}]*color:\s*var\(--color-red\);/s,
    );
    expect(styles).toMatch(
      /\.easy-sync-detail-actions \.easy-sync-detail-action-remote\s*\{[^}]*background-color:\s*rgba\(var\(--color-green-rgb\),\s*0\.18\);[^}]*color:\s*var\(--color-green\);/s,
    );
    expect(styles).not.toMatch(/background-color:\s*var\(--color-(?:red|green)\);/);
    expect(styles).not.toContain(".easy-sync-conflict-actions .easy-sync-detail-action-local");
  });
});
