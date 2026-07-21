export type MergeExpectation = "clean" | "conflict";

export interface MergeContractCase {
  id: string;
  category:
    | "non-overlap"
    | "overlap"
    | "same-edit"
    | "empty"
    | "line-ending"
    | "unicode"
    | "long-line"
    | "large-text";
  base: string;
  local: string;
  remote: string;
  expected: MergeExpectation;
  expectedMerged?: string;
}

const largeBaseLines = Array.from({ length: 5_000 }, (_, index) => `line-${index}`);
const largeLocalLines = [...largeBaseLines];
const largeRemoteLines = [...largeBaseLines];
largeLocalLines[100] = "local-100";
largeRemoteLines[4_900] = "remote-4900";

export const MERGE_CONTRACT_CASES: readonly MergeContractCase[] = [
  {
    id: "different-lines",
    category: "non-overlap",
    base: "a\nb\nc\nd",
    local: "a\nlocal-b\nc\nd",
    remote: "a\nb\nremote-c\nd",
    expected: "clean",
    expectedMerged: "a\nlocal-b\nremote-c\nd",
  },
  {
    id: "partially-overlapping-hunks",
    category: "overlap",
    base: "a\nb\nc\nd",
    local: "a\nlocal-b\nlocal-c\nd",
    remote: "a\nb\nremote-c\nd",
    expected: "conflict",
  },
  {
    id: "identical-change",
    category: "same-edit",
    base: "a\nb\nc",
    local: "a\nsame\nc",
    remote: "a\nsame\nc",
    expected: "clean",
    expectedMerged: "a\nsame\nc",
  },
  {
    id: "empty-ancestor-divergence",
    category: "empty",
    base: "",
    local: "local-created",
    remote: "remote-created",
    expected: "conflict",
  },
  {
    id: "crlf-versus-lf",
    category: "line-ending",
    base: "a\r\nb\r\nc\r\n",
    local: "a\nlocal-b\nc\n",
    remote: "a\r\nb\r\nremote-c\r\n",
    expected: "clean",
  },
  {
    id: "unicode-non-overlap",
    category: "unicode",
    base: "标题\n苹果🍎\n结尾",
    local: "新标题\n苹果🍎\n结尾",
    remote: "标题\n苹果🍎\n新结尾",
    expected: "clean",
    expectedMerged: "新标题\n苹果🍎\n新结尾",
  },
  {
    id: "long-line-overlap",
    category: "long-line",
    base: `prefix-${"x".repeat(20_000)}`,
    local: `prefix-${"y".repeat(20_000)}`,
    remote: `prefix-${"z".repeat(20_000)}`,
    expected: "conflict",
  },
  {
    id: "large-text-non-overlap",
    category: "large-text",
    base: largeBaseLines.join("\n"),
    local: largeLocalLines.join("\n"),
    remote: largeRemoteLines.join("\n"),
    expected: "clean",
  },
];
