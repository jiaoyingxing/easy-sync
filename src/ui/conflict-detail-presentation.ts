/**
 * Conflict detail presentation policy.
 *
 * This module is the single mapping owner between comparison evidence and
 * user-facing copy keys. It does not perform I/O, render DOM, or decide which
 * conflict action is safe to execute.
 */

import type {
  DisplayDiffResult,
} from "./diff-engine";
import { PLAN_REASON } from "../sync/plan-reason";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * Decide whether the conflict detail may fetch the remote side on open.
 *
 * A known finite size above the text-diff budget cannot produce a line diff,
 * so the download is deferred to the explicit "check content" action. A
 * missing or non-finite size keeps the existing best-effort auto-download.
 */
export function shouldAutoLoadRemoteComparison(
  remoteSize: number | null | undefined,
  limit: number,
): boolean {
  if (remoteSize == null || !Number.isFinite(remoteSize)) return true;
  return remoteSize <= limit;
}

/**
 * Decide whether the conflict's local side is known absent.
 *
 * A conflict whose local side is already deleted has no local bytes to read:
 * the comparison must start from an empty local side instead of treating the
 * read failure as "local unreadable", which used to hide the remote content
 * the user opened the detail modal to see. A conflict that still carries a
 * local fact keeps the honest read-failure path.
 */
export function conflictHasMissingLocalSide(
  item: { local?: unknown; remote?: unknown },
): boolean {
  return item.local === undefined && item.remote !== undefined;
}

export type ConflictDetailSummaryEvidence =
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
  if (reason === PLAN_REASON.bothSidesModified) {
    return t("conflictDetail.summaryBothModified");
  }
  return reason ? t(reason) : t(fallbackKey);
}

function summarizeDifferentContent(
  reason: string | undefined,
  t: Translate,
): string {
  if (reason === PLAN_REASON.newFileBothSides) {
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
