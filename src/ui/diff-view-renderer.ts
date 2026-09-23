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
      renderDiffSummary(diffContainer, part);
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

/** Sample region: head and tail lines of each side, separated by one ellipsis row. */
function renderDiffSummary(
  container: HTMLElement,
  summary: DisplayDiffSummary,
): void {
  const summaryEl = container.createDiv("easy-sync-diff-summary");

  for (const line of summary.localSample) {
    renderDiffLine(summaryEl, {
      type: "removed",
      text: line.text,
      lineNumber: { local: line.lineNumber },
    });
  }
  summaryEl.createDiv("easy-sync-diff-line easy-sync-diff-gap").setText("…");
  for (const line of summary.remoteSample) {
    renderDiffLine(summaryEl, {
      type: "added",
      text: line.text,
      lineNumber: { remote: line.lineNumber },
    });
  }
}
