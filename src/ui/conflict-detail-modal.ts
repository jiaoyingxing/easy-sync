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
 * Remote download attempt is best-effort — if it fails (401, DNS block),
 * the modal silently degrades to metadata + local preview only.
 */

import { Modal } from "obsidian";
import type EasySyncPlugin from "../main";
import type { SyncPlanItem } from "../sync/types";
import { computeDiff } from "./diff-engine";
import type { DiffLine, DiffResult } from "./diff-engine";

/**
 * Format a byte count into a human-readable string.
 * e.g. 1234 → "1.2 KB", 1048576 → "1.0 MB"
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

    // ---- Reason ----
    if (this.item.reason) {
      const reasonEl = body.createDiv("easy-sync-detail-reason");
      reasonEl.setText(t(this.item.reason));
    }

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
      let localContent: string;
      try {
        const localRaw = await this.plugin.app.vault.adapter.readBinary(
          this.item.path,
        );
        localContent = new TextDecoder().decode(localRaw);
      } catch (e) {
        loadingEl.setText(
          t("conflictDetail.loadFailed", {
            reason: e instanceof Error ? e.message : t("general.unknown"),
          }),
        );
        this.renderActionButtons(container, t);
        return;
      }

      // ---- Merge result (three-way merge had conflicts) ----
      if (this.item.hasMergeConflicts && this.item.mergedContent) {
        loadingEl.remove();
        body.createEl("h4", { text: t("conflictDetail.mergeResult") });
        this.renderMergeResult(body, this.item.mergedContent);
      }
      // ---- Diff (primary content; local preview is hidden — diff shows both sides) ----
      else if (this.item.remote && !isBinary) {
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
          const remoteContent = new TextDecoder().decode(remoteRaw);

          loadingEl.setText(t("conflictDetail.computingDiff"));
          const diff = computeDiff(localContent, remoteContent);
          diffHeaderEl.setText(
            t("conflictDetail.diffTitle") +
              ` (${t("conflictDetail.diffAdded", { count: diff.addedCount })}, ${t("conflictDetail.diffRemoved", { count: diff.removedCount })})`,
          );

          if (diff.truncated) {
            this.renderTruncatedPreview(body, diff, t);
          } else {
            this.renderDiff(body, diff.lines);
          }
          loadingEl.remove();
        } catch {
          loadingEl.remove();
          // Remote content unavailable — show notice + fall back to local preview
          body.createDiv("easy-sync-remote-unavailable").setText(
            t("conflictDetail.remoteUnavailable"),
          );
          // Show local content as fallback
          body.createEl("h4", { text: t("conflictDetail.localPreview") });
          const preview = body.createDiv("easy-sync-content-preview");
          const pre = preview.createEl("pre");
          pre.createEl("code", { text: localContent });
        }
      } else if (isBinary) {
        loadingEl.remove();
        body.createDiv("easy-sync-binary-notice").setText(
          t("conflictDetail.binaryFile"),
        );
      } else {
        // No remote info — show local content only
        loadingEl.remove();
        body.createEl("h4", { text: t("conflictDetail.localPreview") });
        const preview = body.createDiv("easy-sync-content-preview");
        const pre = preview.createEl("pre");
        pre.createEl("code", { text: localContent });
      }
    } catch {
      loadingEl.setText(
        t("conflictDetail.loadFailed", {
          reason: t("general.unknown"),
        }),
      );
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
    headerRow.createEl("th"); // empty corner cell
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

  /** Render a line-by-line diff view, showing only change hunks with context. */
  private renderDiff(container: HTMLElement, lines: DiffLine[]): void {
    const CONTEXT = 3; // lines of equal context around each hunk
    const diffContainer = container.createDiv("easy-sync-diff-view");

    // Find ranges of changed (non-equal) lines
    const changed = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type !== "equal") changed.add(i);
    }
    if (changed.size === 0) return;

    // Expand each changed index to include CONTEXT lines of equal context
    const keep = new Set<number>();
    for (const idx of changed) {
      for (
        let j = Math.max(0, idx - CONTEXT);
        j <= Math.min(lines.length - 1, idx + CONTEXT);
        j++
      ) {
        keep.add(j);
      }
    }

    let prevKept = -2;
    for (let i = 0; i < lines.length; i++) {
      if (!keep.has(i)) continue;

      // Insert ellipsis when skipping a gap of >1 between kept ranges
      if (prevKept >= 0 && i - prevKept > 1) {
        const gap = diffContainer.createDiv(
          "easy-sync-diff-line easy-sync-diff-gap",
        );
        gap.setText("…");
      }
      prevKept = i;

      const line = lines[i];
      const lineEl = diffContainer.createDiv(
        `easy-sync-diff-line easy-sync-diff-${line.type}`,
      );

      const gutter = lineEl.createSpan("easy-sync-diff-gutter");
      const localNum = line.lineNumber.local
        ? String(line.lineNumber.local)
        : "";
      const remoteNum = line.lineNumber.remote
        ? String(line.lineNumber.remote)
        : "";
      gutter.setText(`${localNum.padStart(4)} ${remoteNum.padStart(4)}`);

      const prefix =
        line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      const content = lineEl.createSpan("easy-sync-diff-content");
      content.setText(`${prefix} ${line.text}`);
    }
  }

  /** Render a truncated preview when files are too large for LCS diff. */
  private renderTruncatedPreview(
    container: HTMLElement,
    diff: DiffResult,
    t: (key: string, params?: Record<string, string | number>) => string,
  ): void {
    const localSample = diff.localSample ?? [];
    const remoteSample = diff.remoteSample ?? [];
    const localTotal = diff.localTotalLines ?? localSample.length;
    const remoteTotal = diff.remoteTotalLines ?? remoteSample.length;
    const localRemaining = localTotal - localSample.length;
    const remoteRemaining = remoteTotal - remoteSample.length;

    container.createDiv("easy-sync-diff-truncated").setText(
      t("conflictDetail.diffTooLarge", {
        localLines: localTotal,
        remoteLines: remoteTotal,
      }),
    );

    // Local sample
    container.createEl("h4", { text: t("conflictDetail.localLabel") });
    const localPreview = container.createDiv("easy-sync-content-preview");
    const localPre = localPreview.createEl("pre");
    localPre.createEl("code", { text: localSample.join("\n") });

    // Remote sample
    container.createEl("h4", { text: t("conflictDetail.remoteLabel") });
    const remotePreview = container.createDiv("easy-sync-content-preview");
    const remotePre = remotePreview.createEl("pre");
    remotePre.createEl("code", { text: remoteSample.join("\n") });

    if (localRemaining > 0 || remoteRemaining > 0) {
      container.createDiv("easy-sync-remote-unavailable").setText(
        t("conflictDetail.remainingLines", {
          localRemaining,
          remoteRemaining,
        }),
      );
    }
  }

  /** Render a merge result with conflict markers highlighted. */
  private renderMergeResult(container: HTMLElement, mergedContent: string): void {
    const lines = mergedContent.split("\n");
    const view = container.createDiv("easy-sync-diff-view");
    let inLocal = false;
    let inRemote = false;

    for (const line of lines) {
      if (line === "<<<<<<< Local") {
        inLocal = true;
        const el = view.createDiv("easy-sync-diff-line easy-sync-diff-removed");
        el.createSpan("easy-sync-diff-content").setText(line);
        continue;
      }
      if (line === "=======") {
        inLocal = false;
        inRemote = true;
        const el = view.createDiv("easy-sync-diff-line");
        el.createSpan("easy-sync-diff-content").setText(line);
        continue;
      }
      if (line === ">>>>>>> Remote") {
        inRemote = false;
        const el = view.createDiv("easy-sync-diff-line easy-sync-diff-added");
        el.createSpan("easy-sync-diff-content").setText(line);
        continue;
      }

      const el = view.createDiv("easy-sync-diff-line");
      if (inLocal) el.addClass("easy-sync-diff-removed");
      else if (inRemote) el.addClass("easy-sync-diff-added");
      el.createSpan("easy-sync-diff-content").setText(line);
    }
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
    keepLocalBtn.addEventListener("click", () => {
      this.close();
      void (async () => {
        await this.plugin.syncExecutor?.resolveConflictKeepLocal(
          this.item.path,
        );
        this.onResolved?.();
      })();
    });

    // Keep remote — close immediately, resolve in background
    const keepRemoteBtn = btnRow.createEl("button", {
      text: t("syncView.conflict.keepRemote"),
    });
    keepRemoteBtn.addEventListener("click", () => {
      this.close();
      void (async () => {
        await this.plugin.syncExecutor?.resolveConflictKeepRemote(
          this.item.path,
        );
        this.onResolved?.();
      })();
    });

    // Skip — close immediately, remove from queue in background
    btnRow.createEl("button", {
      text: t("syncView.conflict.skip"),
    }).addEventListener("click", () => {
      this.close();
      void (async () => {
        await this.plugin.state?.removePendingConflict(this.item.path);
        this.onResolved?.();
      })();
    });
  }
}
