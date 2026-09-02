/**
 * Shared bounded-diff DOM renderer.
 *
 * Extracted from ConflictDetailModal so both the ordinary conflict detail
 * dialog and the community-plugin bundle sub-dialog (single-file diff) render
 * the exact same line-number gutter / +/- colored diff surface.
 */

import type {
  DiffLine,
  DisplayDiffResult,
  DisplayDiffSummary,
} from "./diff-engine";
import { getDiffSummaryReasonKey } from "./conflict-detail-presentation";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Text diff budget per side; beyond this a preview is shown instead. */
export const MAX_TEXT_DIFF_BYTES_PER_SIDE = 8 * 1024 * 1024;
/** Local-preview fallback line cap. */
export const MAX_FALLBACK_PREVIEW_LINES = 200;

/** Strict UTF-8 decode; null when the bytes are not valid text. */
export function decodeUtf8(content: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

/** Compare after normalising line endings (CRLF/LF/CR treated as equal). */
export function sameVisibleText(local: string, remote: string): boolean {
  return local === remote || local.replace(/\r\n?/g, "\n") === remote.replace(/\r\n?/g, "\n");
}

/** Keep both line-number columns only as wide as the largest number in this diff. */
export function getDiffLineNumberWidth(
  localTotalLines: number,
  remoteTotalLines: number,
): string {
  const maxLineNumber = Math.max(1, localTotalLines, remoteTotalLines);
  return `${Math.max(2, String(maxLineNumber).length)}ch`;
}

/** Render bounded exact hunks and clearly marked summary regions. */
export function renderDisplayDiff(
  container: HTMLElement,
  diff: DisplayDiffResult,
  t: Translate,
): void {
  const diffContainer = container.createDiv("easy-sync-diff-view");
  diffContainer.style.setProperty(
    "--easy-sync-diff-line-number-width",
    getDiffLineNumberWidth(diff.localTotalLines, diff.remoteTotalLines),
  );
  for (let partIndex = 0; partIndex < diff.parts.length; partIndex++) {
    if (partIndex > 0) {
      const gap = diffContainer.createDiv(
        "easy-sync-diff-line easy-sync-diff-gap",
      );
      gap.setText("…");
    }

    const part = diff.parts[partIndex];
    if (part.kind === "hunk") {
      for (const line of part.lines) renderDiffLine(diffContainer, line);
    } else {
      renderDiffSummary(diffContainer, part, t);
    }
  }
}

function renderDiffLine(container: HTMLElement, line: DiffLine): void {
  const lineEl = container.createDiv(
    `easy-sync-diff-line easy-sync-diff-${line.type}`,
  );
  const gutter = lineEl.createSpan("easy-sync-diff-gutter");
  const localNum = line.lineNumber.local ? String(line.lineNumber.local) : "";
  const remoteNum = line.lineNumber.remote ? String(line.lineNumber.remote) : "";
  gutter.createSpan("easy-sync-diff-line-number").setText(localNum);
  gutter.createSpan("easy-sync-diff-line-number").setText(remoteNum);

  const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  lineEl.createSpan("easy-sync-diff-content").setText(`${prefix} ${line.text}`);
}

function renderDiffSummary(
  container: HTMLElement,
  summary: DisplayDiffSummary,
  t: Translate,
): void {
  const summaryEl = container.createDiv("easy-sync-diff-summary");
  summaryEl.createDiv("easy-sync-diff-summary-reason").setText(
    t(getDiffSummaryReasonKey(summary.reason)),
  );
  summaryEl.createDiv("easy-sync-diff-summary-range").setText(
    t("conflictDetail.diffRegionRange", {
      localRange: formatLineRange(summary.localStartLine, summary.localEndLine),
      remoteRange: formatLineRange(summary.remoteStartLine, summary.remoteEndLine),
    }),
  );

  for (const line of summary.localSample) {
    renderDiffLine(summaryEl, {
      type: "removed",
      text: line.text,
      lineNumber: { local: line.lineNumber },
    });
  }
  if (summary.localOmittedLines > 0 || summary.remoteOmittedLines > 0) {
    summaryEl.createDiv("easy-sync-diff-line easy-sync-diff-gap").setText(
      t("conflictDetail.diffOmitted", {
        localCount: summary.localOmittedLines,
        remoteCount: summary.remoteOmittedLines,
      }),
    );
  }
  for (const line of summary.remoteSample) {
    renderDiffLine(summaryEl, {
      type: "added",
      text: line.text,
      lineNumber: { remote: line.lineNumber },
    });
  }
}

function formatLineRange(start: number, end: number): string {
  if (end < start) return "—";
  return start === end ? String(start) : `${start}–${end}`;
}
