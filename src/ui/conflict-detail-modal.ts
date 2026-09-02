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

import type EasySyncPlugin from "../main";
import type { SyncPlanItem } from "../sync/types";
import { compareContentBuffers } from "../sync/content-equality";
import { computeDisplayDiff } from "./diff-engine";
import {
  MAX_FALLBACK_PREVIEW_LINES,
  MAX_TEXT_DIFF_BYTES_PER_SIDE,
  decodeUtf8,
  renderDisplayDiff,
  sameVisibleText,
} from "./diff-view-renderer";
import { summarizeConflictDetail } from "./conflict-detail-presentation";
import type { ConflictDetailSummaryEvidence } from "./conflict-detail-presentation";
import {
  FileComparisonModal,
  formatFileSize,
} from "./file-comparison-modal";

/**
 * Keep both line-number columns only as wide as the largest number in this diff.
 * Re-exported from the shared renderer for callers/tests that import it here.
 */
export { getDiffLineNumberWidth } from "./diff-view-renderer";

export class ConflictDetailModal extends FileComparisonModal {
  private onResolved: (() => void) | undefined;

  constructor(
    private readonly plugin: EasySyncPlugin,
    private readonly item: SyncPlanItem,
  ) {
    super(plugin.app);
  }

  /** Set callback invoked after a conflict is resolved (keep local / keep remote) */
  setOnResolved(callback: () => void): this {
    this.onResolved = callback;
    return this;
  }

  protected async renderComparison(): Promise<void> {
    const t = (key: string, params?: Record<string, string | number>) =>
      this.plugin.i18n.t(key, params);
    const body = this.comparisonBodyEl;

    // ---- Title (official modal-title slot, not the scrollable body) ----
    this.setTitle(t("conflictDetail.title"));
    const pathFact = body.createDiv("easy-sync-detail-path");
    pathFact.createSpan("easy-sync-detail-path-label").setText(
      t("conflictDetail.path"),
    );
    pathFact.createSpan("easy-sync-detail-path-value").setText(this.item.path);

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
    // The comparing phase is not a top-level conclusion: the overview keeps
    // the plan reason until content evidence arrives, and the comparing
    // sentence is the middle progress line below.
    setSummary({ kind: "reason" });

    // ---- Metadata table ----
    this.renderMetadata(t);

    body.createEl("hr");

    // ---- Loading indicator ----
    const loadingEl = body.createDiv("easy-sync-detail-loading");
    loadingEl.setText(t("conflictDetail.summaryComparing"));

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
        this.renderActionButtons(t);
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
            // The "comparing" summary above is stale once equality is proven:
            // leave only the identical conclusion, without a diff section.
            reasonEl.remove();
            diffHeaderEl.remove();
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
                limit: formatFileSize(MAX_TEXT_DIFF_BYTES_PER_SIDE),
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
                limit: formatFileSize(MAX_TEXT_DIFF_BYTES_PER_SIDE),
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
              limit: formatFileSize(MAX_TEXT_DIFF_BYTES_PER_SIDE),
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
    this.renderActionButtons(t);
  }

  /** Render the metadata comparison table */
  private renderMetadata(
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
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
    const localSize = this.item.local?.size;
    const remoteSize = this.item.remote?.size;
    const localLarger =
      localSize != null && remoteSize != null && localSize > remoteSize;
    const remoteLarger =
      localSize != null && remoteSize != null && remoteSize > localSize;
    this.renderComparisonTable(
      t("conflictDetail.localLabel"),
      t("conflictDetail.remoteLabel"),
      [
        {
          label: t("conflictDetail.modifiedTime"),
          local: localTime
            ? localTime.toLocaleString()
              + (localIsNewer ? ` ${t("conflictDetail.newer")}` : "")
            : "—",
          remote: remoteTime
            ? remoteTime.toLocaleString()
              + (remoteIsNewer ? ` ${t("conflictDetail.newer")}` : "")
            : "—",
          localHighlighted: Boolean(localIsNewer),
          remoteHighlighted: Boolean(remoteIsNewer),
        },
        {
          label: t("conflictDetail.fileSize"),
          local: localSize != null
            ? formatFileSize(localSize)
              + (localLarger ? ` ${t("conflictDetail.larger")}` : "")
            : "—",
          remote: remoteSize != null
            ? formatFileSize(remoteSize)
              + (remoteLarger ? ` ${t("conflictDetail.larger")}` : "")
            : "—",
          localHighlighted: localLarger,
          remoteHighlighted: remoteLarger,
        },
      ],
    );
  }

  /** Render bounded exact hunks and clearly marked summary regions. */
  private renderDisplayDiff(
    container: HTMLElement,
    diff: Parameters<typeof renderDisplayDiff>[1],
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    renderDisplayDiff(container, diff, t);
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
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    this.renderFileComparisonActions([
      {
        label: t("syncView.conflict.keepLocal"),
        className: "easy-sync-detail-action-local",
        onClick: () => {
          this.close();
          void (async () => {
            await this.plugin.resolveConflictKeepLocal(this.item.path);
            this.onResolved?.();
          })();
        },
      },
      {
        label: t("syncView.conflict.keepRemote"),
        className: "easy-sync-detail-action-remote",
        onClick: () => {
          this.close();
          void (async () => {
            await this.plugin.resolveConflictKeepRemote(this.item.path);
            this.onResolved?.();
          })();
        },
      },
      {
        label: t("syncView.conflict.skip"),
        onClick: () => {
          this.close();
          void (async () => {
            await this.plugin.dismissConflict(this.item.path);
            this.onResolved?.();
          })();
        },
      },
    ]);
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
