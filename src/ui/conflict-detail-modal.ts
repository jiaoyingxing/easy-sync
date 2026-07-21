/**
 * ConflictDetailModal — Conflict resolution detail view
 *
 * Opens when the user clicks "查看详情" on a conflict item.
 * Shows:
 *  1. Metadata comparison table (local vs remote: mtime, size)
 *  2. Local file content preview
 *  3. Line-by-line diff (when remote content is downloadable)
 *  4. Action buttons: [Keep Local] [Keep Remote] [Skip]
 *
 * Remote comparison is best-effort. Failure records a diagnostic category and
 * degrades to metadata + a bounded local preview without guessing the cause.
 */

import { Modal } from "obsidian";
import type EasySyncPlugin from "../main";
import type { SyncPlanItem } from "../sync/types";
import { compareContentBuffers } from "../sync/content-equality";
import { computeDisplayDiff } from "./diff-engine";
import type {
  DiffLine,
  DisplayDiffResult,
  DisplayDiffSummary,
} from "./diff-engine";
import {
  getDiffSummaryReasonKey,
  summarizeConflictDetail,
} from "./conflict-detail-presentation";
import type { ConflictDetailSummaryEvidence } from "./conflict-detail-presentation";

const MAX_TEXT_DIFF_BYTES_PER_SIDE = 8 * 1024 * 1024;
const MAX_FALLBACK_PREVIEW_LINES = 200;

function decodeUtf8(content: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function sameVisibleText(local: string, remote: string): boolean {
  return local === remote || local.replace(/\r\n?/g, "\n") === remote.replace(/\r\n?/g, "\n");
}

/**
 * Format a byte count into a human-readable string.
 * e.g. 1234 → "1.2 KB", 1048576 → "1.0 MB"
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Keep both line-number columns only as wide as the largest number in this diff. */
export function getDiffLineNumberWidth(
  localTotalLines: number,
  remoteTotalLines: number,
): string {
  const maxLineNumber = Math.max(1, localTotalLines, remoteTotalLines);
  return `${Math.max(2, String(maxLineNumber).length)}ch`;
}

export class ConflictDetailModal extends Modal {
  private onResolved: (() => void) | undefined;

  constructor(
    private plugin: EasySyncPlugin,
    private item: SyncPlanItem,
  ) {
    super(plugin.app);
  }

  /** Set callback invoked after a conflict is resolved (keep local / keep remote) */
  setOnResolved(callback: () => void): this {
    this.onResolved = callback;
    return this;
  }

  async onOpen(): Promise<void> {
    const t = (key: string, params?: Record<string, string | number>) =>
      this.plugin.i18n.t(key, params);
    const container = this.contentEl;
    container.addClass("easy-sync-conflict-detail");

    // ── Scrollable body ──
    const body = container.createDiv("easy-sync-conflict-body");

    // ---- Title ----
    body.createEl("h3", {
      text: t("conflictDetail.title", { path: this.item.path }),
    });

    // ---- Current comparison summary ----
    const reasonEl = body.createDiv("easy-sync-detail-reason");
    const setSummary = (evidence: ConflictDetailSummaryEvidence) => {
      reasonEl.setText(summarizeConflictDetail(evidence, this.item.reason, t));
    };
    const setComparisonUnavailableOrReason = () => {
      setSummary(this.item.local && this.item.remote
        ? { kind: "comparison-unavailable" }
        : { kind: "reason" });
    };
    setSummary(this.item.local && this.item.remote
      ? { kind: "comparing" }
      : { kind: "reason" });

    // ---- Metadata table ----
    this.renderMetadata(body, t);

    body.createEl("hr");

    // ---- Loading indicator ----
    const loadingEl = body.createDiv("easy-sync-detail-loading");
    loadingEl.setText(t("conflictDetail.loading"));

    // ---- Content section ----
    const isBinary = this.item.local?.binary;

    try {
      // Read local file content
      let localRaw: ArrayBuffer;
      try {
        localRaw = await this.plugin.app.vault.adapter.readBinary(
          this.item.path,
        );
      } catch (e) {
        setComparisonUnavailableOrReason();
        this.plugin.diag.warn("execute", "Conflict detail local read unavailable", {
          path: this.item.path,
          errorKind: getErrorKind(e),
        });
        loadingEl.setText(t("conflictDetail.localReadUnavailable"));
        this.renderActionButtons(container, t);
        return;
      }
      const localWithinTextBudget = localRaw.byteLength <= MAX_TEXT_DIFF_BYTES_PER_SIDE;
      const localContent = localWithinTextBudget ? decodeUtf8(localRaw) : null;

      // ---- Diff (primary content; local preview is hidden — diff shows both sides) ----
      if (this.item.remote) {
        const diffHeaderEl = body.createEl("h4", {
          text: t("conflictDetail.diffTitle"),
        });

        try {
          loadingEl.setText(t("conflictDetail.fetchingRemote"));
          const vaultName = this.plugin.app.vault.getName();
          const remoteRaw = await this.plugin.onedrive!.downloadFile(
            vaultName,
            this.item.path,
            this.item.remote.downloadUrl,
            this.item.remote.driveId,
            this.item.remote.size,
          );
          loadingEl.setText(t("conflictDetail.computingDiff"));
          const contentComparison = await compareContentBuffers(localRaw, remoteRaw);
          if (contentComparison.status === "equal") {
            diffHeaderEl.setText(t("conflictDetail.diffTitle"));
            body.createDiv("easy-sync-detail-identical").setText(
              t("conflictDetail.identical"),
            );
            loadingEl.remove();
            await this.plugin.reconcileIdenticalConflict(this.item.path, {
              localHash: contentComparison.localHash,
              localSize: localRaw.byteLength,
              remoteHash: contentComparison.remoteHash,
              remoteSize: remoteRaw.byteLength,
              remoteETag: this.item.remote.eTag,
            });
            this.onResolved?.();
            this.close();
            return;
          }

          if (isBinary) {
            setSummary({ kind: "content-different" });
            diffHeaderEl.remove();
            body.createDiv("easy-sync-binary-notice").setText(
              t("conflictDetail.binaryFile"),
            );
          } else if (
            localRaw.byteLength > MAX_TEXT_DIFF_BYTES_PER_SIDE ||
            remoteRaw.byteLength > MAX_TEXT_DIFF_BYTES_PER_SIDE
          ) {
            setSummary({ kind: "content-different" });
            body.createDiv("easy-sync-diff-truncated").setText(
              t("conflictDetail.textDiffByteLimit", {
                limit: formatSize(MAX_TEXT_DIFF_BYTES_PER_SIDE),
              }),
            );
            if (localContent != null) {
              body.createEl("h4", { text: t("conflictDetail.localPreview") });
              this.renderTextPreview(body, localContent, t);
            }
          } else {
            const remoteContent = decodeUtf8(remoteRaw);
            if (localContent == null || remoteContent == null) {
              setSummary({ kind: "content-different" });
              diffHeaderEl.remove();
              body.createDiv("easy-sync-binary-notice").setText(
                t("conflictDetail.binaryFile"),
              );
            } else if (
              contentComparison.decodedTextEqual ||
              sameVisibleText(localContent, remoteContent)
            ) {
              setSummary({ kind: "bytes-different-no-line-diff" });
              body.createDiv("easy-sync-detail-format-difference").setText(
                t("conflictDetail.textSameBytesDifferent"),
              );
            } else {
              const diff = computeDisplayDiff(localContent, remoteContent);
              setSummary({ kind: "text-diff", diff });
              diffHeaderEl.setText(
                diff.complete
                  ? t("conflictDetail.diffTitle") +
                    ` (${t("conflictDetail.diffAdded", { count: diff.addedCount })}, ${t("conflictDetail.diffRemoved", { count: diff.removedCount })})`
                  : t("conflictDetail.diffTitle") +
                    ` (${t("conflictDetail.diffRegionsLocated", { count: diff.parts.length })})`,
              );
              this.renderDisplayDiff(body, diff, t);
            }
          }
          loadingEl.remove();
        } catch (e) {
          setComparisonUnavailableOrReason();
          this.plugin.diag.warn("execute", "Conflict detail remote comparison unavailable", {
            path: this.item.path,
            errorKind: getErrorKind(e),
          });
          loadingEl.remove();
          // Remote content unavailable — show notice + fall back to local preview
          body.createDiv("easy-sync-remote-unavailable").setText(
            t("conflictDetail.remoteComparisonUnavailable"),
          );
          // Show local content as fallback
          if (!localWithinTextBudget) {
            body.createDiv("easy-sync-diff-truncated").setText(
              t("conflictDetail.textDiffByteLimit", {
                limit: formatSize(MAX_TEXT_DIFF_BYTES_PER_SIDE),
              }),
            );
          } else if (localContent == null) {
            body.createDiv("easy-sync-binary-notice").setText(
              t("conflictDetail.binaryFile"),
            );
          } else {
            body.createEl("h4", { text: t("conflictDetail.localPreview") });
            this.renderTextPreview(body, localContent, t);
          }
        }
      } else if (isBinary) {
        setSummary({ kind: "reason" });
        loadingEl.remove();
        body.createDiv("easy-sync-binary-notice").setText(
          t("conflictDetail.binaryFile"),
        );
      } else {
        // No remote info — show local content only
        setSummary({ kind: "reason" });
        loadingEl.remove();
        if (!localWithinTextBudget) {
          body.createDiv("easy-sync-diff-truncated").setText(
            t("conflictDetail.textDiffByteLimit", {
              limit: formatSize(MAX_TEXT_DIFF_BYTES_PER_SIDE),
            }),
          );
        } else if (localContent == null) {
          body.createDiv("easy-sync-binary-notice").setText(
            t("conflictDetail.binaryFile"),
          );
        } else {
          body.createEl("h4", { text: t("conflictDetail.localPreview") });
          this.renderTextPreview(body, localContent, t);
        }
      }
    } catch (e) {
      setComparisonUnavailableOrReason();
      this.plugin.diag.warn("execute", "Conflict detail rendering unavailable", {
        path: this.item.path,
        errorKind: getErrorKind(e),
      });
      loadingEl.setText(t("conflictDetail.loadUnavailable"));
    }

    // ---- Action buttons (fixed footer, outside scroll body) ----
    this.renderActionButtons(container, t);
  }

  /** Render the metadata comparison table */
  private renderMetadata(
    container: HTMLElement,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    const table = container.createEl("table", "easy-sync-metadata-table");
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th");
    headerRow.createEl("th", {
      text: t("conflictDetail.localLabel"),
      cls: "easy-sync-meta-col-local",
    });
    headerRow.createEl("th", {
      text: t("conflictDetail.remoteLabel"),
      cls: "easy-sync-meta-col-remote",
    });

    const tbody = table.createEl("tbody");

    // --- Modified time row ---
    const mtimeRow = tbody.createEl("tr");
    mtimeRow.createEl("td", { text: t("conflictDetail.modifiedTime") });

    const localTime = this.item.local?.mtime
      ? new Date(this.item.local.mtime)
      : null;
    const remoteTime = this.item.remote?.mtime
      ? new Date(this.item.remote.mtime)
      : null;
    const localIsNewer =
      localTime && remoteTime && localTime > remoteTime;
    const remoteIsNewer =
      localTime && remoteTime && remoteTime > localTime;

    const localTimeCell = mtimeRow.createEl("td", "easy-sync-meta-col-local");
    localTimeCell.setText(
      localTime
        ? localTime.toLocaleString() +
            (localIsNewer ? ` ${t("conflictDetail.newer")}` : "")
        : "—",
    );
    if (localIsNewer) localTimeCell.addClass("easy-sync-meta-highlight");

    const remoteTimeCell = mtimeRow.createEl("td", "easy-sync-meta-col-remote");
    remoteTimeCell.setText(
      remoteTime
        ? remoteTime.toLocaleString() +
            (remoteIsNewer ? ` ${t("conflictDetail.newer")}` : "")
        : "—",
    );
    if (remoteIsNewer) remoteTimeCell.addClass("easy-sync-meta-highlight");

    // --- Size row ---
    const sizeRow = tbody.createEl("tr");
    sizeRow.createEl("td", { text: t("conflictDetail.fileSize") });

    const localSize = this.item.local?.size;
    const remoteSize = this.item.remote?.size;
    const localLarger =
      localSize != null && remoteSize != null && localSize > remoteSize;
    const remoteLarger =
      localSize != null && remoteSize != null && remoteSize > localSize;

    const localSizeCell = sizeRow.createEl("td", "easy-sync-meta-col-local");
    localSizeCell.setText(
      localSize != null
        ? formatSize(localSize) +
            (localLarger ? ` ${t("conflictDetail.larger")}` : "")
        : "—",
    );
    if (localLarger) localSizeCell.addClass("easy-sync-meta-highlight");

    const remoteSizeCell = sizeRow.createEl("td", "easy-sync-meta-col-remote");
    remoteSizeCell.setText(
      remoteSize != null
        ? formatSize(remoteSize) +
            (remoteLarger ? ` ${t("conflictDetail.larger")}` : "")
        : "—",
    );
    if (remoteLarger) remoteSizeCell.addClass("easy-sync-meta-highlight");
  }

  /** Render bounded exact hunks and clearly marked summary regions. */
  private renderDisplayDiff(
    container: HTMLElement,
    diff: DisplayDiffResult,
    t: (key: string, params?: Record<string, string | number>) => string,
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
        for (const line of part.lines) this.renderDiffLine(diffContainer, line);
      } else {
        this.renderDiffSummary(diffContainer, part, t);
      }
    }
  }

  private renderDiffLine(container: HTMLElement, line: DiffLine): void {
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

  private renderDiffSummary(
    container: HTMLElement,
    summary: DisplayDiffSummary,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    const summaryEl = container.createDiv("easy-sync-diff-summary");
    summaryEl.createDiv("easy-sync-diff-summary-reason").setText(
      t(getDiffSummaryReasonKey(summary.reason)),
    );
    summaryEl.createDiv("easy-sync-diff-summary-range").setText(
      t("conflictDetail.diffRegionRange", {
        localRange: this.formatLineRange(summary.localStartLine, summary.localEndLine),
        remoteRange: this.formatLineRange(summary.remoteStartLine, summary.remoteEndLine),
      }),
    );

    for (const line of summary.localSample) {
      this.renderDiffLine(summaryEl, {
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
      this.renderDiffLine(summaryEl, {
        type: "added",
        text: line.text,
        lineNumber: { remote: line.lineNumber },
      });
    }
  }

  private formatLineRange(start: number, end: number): string {
    if (end < start) return "—";
    return start === end ? String(start) : `${start}–${end}`;
  }

  private renderTextPreview(
    container: HTMLElement,
    content: string,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    const lines = content.split("\n");
    const shown = Math.min(lines.length, MAX_FALLBACK_PREVIEW_LINES);
    if (shown < lines.length) {
      container.createDiv("easy-sync-diff-truncated").setText(
        t("conflictDetail.previewTruncated", { shown, total: lines.length }),
      );
    }
    const preview = container.createDiv("easy-sync-content-preview");
    const pre = preview.createEl("pre");
    pre.createEl("code", { text: lines.slice(0, shown).join("\n") });
  }

  /** Render the bottom action buttons */
  private renderActionButtons(
    container: HTMLElement,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    const btnRow = container.createDiv("easy-sync-detail-actions");

    // Keep local — close immediately, resolve in background
    const keepLocalBtn = btnRow.createEl("button", {
      text: t("syncView.conflict.keepLocal"),
    });
    keepLocalBtn.addClass("easy-sync-detail-action-local");
    keepLocalBtn.addEventListener("click", () => {
      this.close();
      void (async () => {
        await this.plugin.resolveConflictKeepLocal(this.item.path);
        this.onResolved?.();
      })();
    });

    // Keep remote — close immediately, resolve in background
    const keepRemoteBtn = btnRow.createEl("button", {
      text: t("syncView.conflict.keepRemote"),
    });
    keepRemoteBtn.addClass("easy-sync-detail-action-remote");
    keepRemoteBtn.addEventListener("click", () => {
      this.close();
      void (async () => {
        await this.plugin.resolveConflictKeepRemote(this.item.path);
        this.onResolved?.();
      })();
    });

    // Skip — close immediately, remove from queue in background
    btnRow.createEl("button", {
      text: t("syncView.conflict.skip"),
    }).addEventListener("click", () => {
      this.close();
      void (async () => {
        await this.plugin.dismissConflict(this.item.path);
        this.onResolved?.();
      })();
    });
  }
}

function getErrorKind(error: unknown): string {
  if (error instanceof Error) {
    const typed = error as Error & { type?: unknown; status?: unknown };
    if (typeof typed.type === "string") return `${error.name}:${typed.type}`;
    if (typeof typed.status === "number") return `${error.name}:${typed.status}`;
    return error.name;
  }
  return typeof error;
}
