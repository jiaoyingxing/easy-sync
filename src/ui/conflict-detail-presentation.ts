/**
 * Conflict detail presentation policy.
 *
 * This module is the single mapping owner between comparison evidence and
 * user-facing copy keys. It does not perform I/O, render DOM, or decide which
 * conflict action is safe to execute.
 */

import type {
  DisplayDiffResult,
  DisplayDiffSummary,
} from "./diff-engine";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export type ConflictDetailSummaryEvidence =
  | { kind: "comparing" }
  | { kind: "comparison-unavailable" }
  | { kind: "reason" }
  | { kind: "content-different" }
  | { kind: "bytes-different-no-line-diff" }
  | { kind: "text-diff"; diff: DisplayDiffResult };

function summarizeConflictReason(
  reason: string | undefined,
  t: Translate,
  fallbackKey: string,
): string {
  if (reason === "reason.bothSidesModified") {
    return t("conflictDetail.summaryBothModified");
  }
  return reason ? t(reason) : t(fallbackKey);
}

function summarizeDifferentContent(
  reason: string | undefined,
  t: Translate,
): string {
  if (reason === "reason.newFileBothSides") {
    return t("conflictDetail.summaryBothExistDifferent");
  }
  return summarizeConflictReason(reason, t, "conflictDetail.summaryDifferent");
}

/** Select one honest headline from the current phase, evidence, and plan reason. */
export function summarizeConflictDetail(
  evidence: ConflictDetailSummaryEvidence,
  reason: string | undefined,
  t: Translate,
): string {
  if (evidence.kind === "comparing") {
    return t("conflictDetail.summaryComparing");
  }
  if (evidence.kind === "comparison-unavailable") {
    return t("conflictDetail.summaryComparisonUnavailable");
  }
  if (evidence.kind === "bytes-different-no-line-diff") {
    return t("conflictDetail.summaryBytesDifferentNoLineDiff");
  }
  if (evidence.kind === "reason") {
    return summarizeConflictReason(reason, t, "syncView.conflict.defaultReason");
  }
  if (evidence.kind === "content-different") {
    return summarizeDifferentContent(reason, t);
  }

  const { diff } = evidence;
  if (diff.complete && diff.removedCount > 0 && diff.addedCount === 0) {
    return t("conflictDetail.summaryLocalExtra", {
      count: diff.removedCount,
    });
  }
  if (diff.complete && diff.addedCount > 0 && diff.removedCount === 0) {
    return t("conflictDetail.summaryRemoteExtra", {
      count: diff.addedCount,
    });
  }
  return summarizeDifferentContent(reason, t);
}

/** Map bounded-diff degradation reasons to their sole explanatory copy owner. */
export function getDiffSummaryReasonKey(
  reason: DisplayDiffSummary["reason"],
): string {
  switch (reason) {
    case "change-budget":
      return "conflictDetail.diffChangeBudget";
    case "display-budget":
      return "conflictDetail.diffDisplayBudget";
    case "alignment-limit":
      return "conflictDetail.diffAlignmentLimit";
  }
}
