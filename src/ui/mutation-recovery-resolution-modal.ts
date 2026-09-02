import type { App } from "obsidian";
import { compareCommunityPluginVersions } from "../sync/community-plugin-bundle";
import type {
  CommunityPluginBundleFilePresentationV1,
  CommunityPluginBundleReviewBlockReasonV1,
  ManualMutationResolutionChoiceV1,
  ManualMutationResolutionLocalFactV1,
  ManualMutationResolutionRemoteFactV1,
  ManualMutationResolutionSnapshotV1,
} from "../sync/types";
import { ConfirmModal, type I18nFn } from "./confirm-modal";
import { EasySyncModal } from "./easy-sync-modal";
import { computeDisplayDiff } from "./diff-engine";
import {
  MAX_FALLBACK_PREVIEW_LINES,
  MAX_TEXT_DIFF_BYTES_PER_SIDE,
  renderDisplayDiff,
  sameVisibleText,
} from "./diff-view-renderer";
import {
  FileComparisonModal,
  formatFileSize,
  type FileComparisonAction,
  type FileComparisonRow,
} from "./file-comparison-modal";

type MutationResolutionSnapshot = Readonly<ManualMutationResolutionSnapshotV1>;
type MutationResolutionSnapshotInput =
  | MutationResolutionSnapshot
  | Promise<MutationResolutionSnapshot | null>;

function isSnapshotPromise(
  input: MutationResolutionSnapshotInput,
): input is Promise<MutationResolutionSnapshot | null> {
  return typeof (input as Promise<MutationResolutionSnapshot | null>).then
    === "function";
}

function fileFactText(
  fact: Readonly<
    ManualMutationResolutionLocalFactV1 | ManualMutationResolutionRemoteFactV1
  > | undefined,
  t: I18nFn,
): string {
  return fact?.exists
    ? t("syncView.mutationResolution.present", {
        size: formatFileSize(fact.size ?? 0),
      })
    : t("syncView.mutationResolution.missing");
}

function bundleReasonText(
  reason: CommunityPluginBundleReviewBlockReasonV1,
  t: I18nFn,
): string {
  return t(`syncView.pluginBundleReview.reason.${reason}`);
}

/** Whether a bundle keep-side choice needs the version-mismatch confirmation.
 *  Uses the same SemVer comparison as the plan-level guard (finding ②) and
 *  proceeds without confirmation for unparseable versions (comparison null),
 *  keeping the gate best-effort like the guard. Pure so the downgrade /
 *  overwrite gate has a behaviour-level test. */
export function requiresBundleVersionConfirmation(
  choice: ManualMutationResolutionChoiceV1,
  comparison: number | null,
): boolean {
  if (comparison === null) return false;
  return (choice === "keep-remote" && comparison > 0)
    || (choice === "keep-local" && comparison < 0);
}

/** Local side value shown in the bundle overview (version for manifest, mtime for others). */
function bundleLocalText(
  fact: Readonly<ManualMutationResolutionLocalFactV1> | undefined,
  file: Readonly<CommunityPluginBundleFilePresentationV1> | undefined,
  t: I18nFn,
): string {
  if (!fact?.exists) return t("syncView.mutationResolution.missing");
  if (file?.localMtime !== undefined) {
    return new Date(file.localMtime).toLocaleString();
  }
  return formatFileSize(fact.size ?? 0);
}

/** Remote side value shown in the bundle overview. */
function bundleRemoteText(
  fact: Readonly<ManualMutationResolutionRemoteFactV1> | undefined,
  file: Readonly<CommunityPluginBundleFilePresentationV1> | undefined,
  t: I18nFn,
): string {
  if (!fact?.exists) return t("syncView.mutationResolution.missing");
  if (file?.remoteMtime !== undefined) {
    return new Date(file.remoteMtime).toLocaleString();
  }
  return formatFileSize(fact.size ?? 0);
}

/**
 * Recovery-specific adapter for the shared local/cloud comparison surface.
 * It only returns a reviewed choice; the ledger recheck and mutations remain
 * in SyncExecutor.
 */
export class MutationRecoveryResolutionModal extends FileComparisonModal {
  private resolve:
    ((choice: ManualMutationResolutionChoiceV1 | null) => void) | null = null;
  private snapshot: MutationResolutionSnapshot | null;
  private pendingSnapshot: Promise<MutationResolutionSnapshot | null> | null;
  private snapshotUnavailable = false;

  constructor(
    app: App,
    snapshot: MutationResolutionSnapshotInput,
    private readonly t: I18nFn,
    private readonly getFileDiff?: (
      pluginId: string,
      path: string,
    ) => Promise<BundleFileDiffData | null>,
  ) {
    super(app);
    this.snapshot = isSnapshotPromise(snapshot) ? null : snapshot;
    this.pendingSnapshot = isSnapshotPromise(snapshot) ? snapshot : null;
  }

  awaitChoice(): Promise<ManualMutationResolutionChoiceV1 | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    const pendingSnapshot = this.pendingSnapshot;
    if (!pendingSnapshot) return;

    let snapshot: MutationResolutionSnapshot | null = null;
    try {
      snapshot = await pendingSnapshot;
    } catch {
      this.snapshotUnavailable = true;
    }
    if (!this.resolve) return;

    this.pendingSnapshot = null;
    this.snapshot = snapshot;
    if (!snapshot) this.snapshotUnavailable = true;
    await this.refreshComparison();
  }

  protected renderComparison(): void {
    const body = this.comparisonBodyEl;
    const snapshot = this.snapshot;
    if (!snapshot) {
      // Loading / unavailable: keep the official modal-title slot stable, only
      // the body copy switches. No bottom actions — the host close X is the
      // only exit (a lone "cancel" button here is meaningless).
      this.setTitle(this.t("syncView.pluginBundleReview.title"));
      body.createEl("p", {
        text: this.t(this.snapshotUnavailable
          ? "syncView.pluginBundleReview.loadUnavailable"
          : "syncView.pluginBundleReview.loading"),
        cls: "easy-sync-detail-reason",
      });
      return;
    }

    const bundle = snapshot.bundleReview;
    this.setTitle(this.t(bundle
      ? "syncView.pluginBundleReview.title"
      : "syncView.mutationResolution.title"));
    if (bundle) {
      body.createEl("p", {
        text: this.t("syncView.pluginBundleReview.description", {
          name: bundle.displayName ?? bundle.pluginId,
        }),
        cls: "easy-sync-detail-reason",
      });
    }

    if (bundle) {
      this.renderBundleOverview(snapshot);
    } else {
      this.renderComparisonTable(
        this.t("syncView.mutationResolution.localTitle"),
        this.t("syncView.mutationResolution.remoteTitle"),
        this.buildComparisonRows(),
      ).addClass("easy-sync-comparison-path-table");
      const details = body.createEl("details", {
        cls: "easy-sync-comparison-evidence",
      });
      details.createEl("summary", {
        text: this.t("syncView.mutationResolution.technicalDetails"),
      });
      const detailList = details.createEl("ul");
      detailList.createEl("li", {
        text: this.t("syncView.mutationResolution.description", {
          path: snapshot.path,
        }),
      });
      detailList.createEl("li", {
        text: this.t("syncView.mutationResolution.previousAction", {
          action: this.t(
            `syncView.mutationResolution.action.${snapshot.previousAction}`,
          ),
        }),
      });
      detailList.createEl("li", {
        text: this.t("syncView.mutationResolution.operationId", {
          value: snapshot.sourceOperationId,
        }),
      });
      for (const fact of snapshot.local.filter((item) => item.exists)) {
        detailList.createEl("li", {
          text: `${fact.path} · SHA-256 ${fact.hash}`,
        });
      }
      for (const fact of snapshot.remote.filter((item) => item.exists)) {
        detailList.createEl("li", {
          text: `${fact.path} · ID ${fact.driveId} · eTag ${fact.eTag} · SHA-256 ${fact.hash}`,
        });
      }
    }

    if (bundle) {
      if (!bundle.local.available && bundle.local.reason) {
        body.createEl("p", {
          text: this.t("syncView.pluginBundleReview.directionUnavailable", {
            side: this.t("syncView.mutationResolution.localTitle"),
            reason: bundleReasonText(bundle.local.reason, this.t),
          }),
          cls: "easy-sync-comparison-unavailable",
        });
      }
      if (!bundle.remote.available && bundle.remote.reason) {
        body.createEl("p", {
          text: this.t("syncView.pluginBundleReview.directionUnavailable", {
            side: this.t("syncView.mutationResolution.remoteTitle"),
            reason: bundleReasonText(bundle.remote.reason, this.t),
          }),
          cls: "easy-sync-comparison-unavailable",
        });
      }
      if (!bundle.executionReady) {
        body.createEl("p", {
          text: this.t("syncView.pluginBundleReview.readOnly"),
          cls: "easy-sync-comparison-unavailable",
        });
      }
      const executableChoices = bundle.executableChoices ?? [];
      this.renderFileComparisonActions([
        {
          label: this.t("syncView.conflict.keepLocal"),
          className: "easy-sync-detail-action-local",
          disabled: !executableChoices.includes("keep-local")
            || !snapshot.keepLocal.available,
          onClick: () => {
            void this.confirmDowngradeIfNeeded(snapshot, "keep-local");
          },
        },
        {
          label: this.t("syncView.conflict.keepRemote"),
          className: "easy-sync-detail-action-remote",
          disabled: !executableChoices.includes("keep-remote")
            || !snapshot.keepRemote.available,
          onClick: () => {
            void this.confirmDowngradeIfNeeded(snapshot, "keep-remote");
          },
        },
        {
          label: this.t("confirm.cancel"),
          onClick: () => this.finish(null),
        },
      ]);
      return;
    }

    // Ordinary entries only keep the executable actions; the unavailable
    // side is not rendered as a disabled button.
    const ordinaryActions: FileComparisonAction[] = [];
    if (snapshot.keepLocal.available) {
      ordinaryActions.push({
        label: this.t("syncView.mutationResolution.keepLocal"),
        className: "easy-sync-detail-action-local",
        onClick: () => this.finish("keep-local"),
      });
    }
    if (snapshot.keepRemote.available) {
      ordinaryActions.push({
        label: this.t("syncView.mutationResolution.keepRemote"),
        className: "easy-sync-detail-action-remote",
        onClick: () => this.finish("keep-remote"),
      });
    }
    if (ordinaryActions.length === 0) {
      body.createEl("p", {
        text: this.t("syncView.mutationResolution.noAvailableActions"),
        cls: "easy-sync-detail-reason",
      });
      // This shape is a move-style intent with no executable keep-side
      // action. Rather than only "export a diagnostic report", tell the user
      // what they can actually do to change the outcome, and be honest that
      // one direction cannot yet converge automatically (the two sides
      // differ, and the current classifier has no automatic branch for it).
      if (snapshot.sourcePath) {
        body.createEl("p", {
          text: this.t("syncView.mutationResolution.noAvailableActionsKeepLocal", {
            sourcePath: snapshot.sourcePath,
          }),
          cls: "easy-sync-detail-reason",
        });
        body.createEl("p", {
          text: this.t("syncView.mutationResolution.noAvailableActionsKeepRemote", {
            sourcePath: snapshot.sourcePath,
            path: snapshot.path,
          }),
          cls: "easy-sync-detail-reason",
        });
      }
      body.createEl("p", {
        text: this.t("syncView.mutationResolution.noAvailableActionsFallback"),
        cls: "easy-sync-detail-reason",
      });
    } else if (ordinaryActions.length === 1) {
      body.createEl("p", {
        text: this.t("syncView.mutationResolution.singleActionHint"),
        cls: "easy-sync-detail-reason",
      });
    }
    this.renderFileComparisonActions([
      ...ordinaryActions,
      {
        label: this.t("confirm.cancel"),
        onClick: () => this.finish(null),
      },
    ]);
  }

  onClose(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(null);
  }

  /**
   * Bundle overview: a flat four-column table (file / local / remote /
   * action). The manifest row is always first because it carries the version
   * numbers. Files proven identical from metadata show a muted "identical"
   * marker instead of a "view diff" action; the newer/larger side of a
   * differing row is highlighted with the shared accent color.
   */
  private renderBundleOverview(snapshot: MutationResolutionSnapshot): void {
    const bundle = snapshot.bundleReview!;
    const presentation = snapshot.bundlePresentation;
    const localVersion = presentation?.localVersion ?? null;
    const remoteVersion = presentation?.remoteVersion ?? null;
    // The manifest row goes first (it shows the version numbers); the other
    // members keep their canonical order.
    const orderedPaths = [...bundle.memberPaths].sort((left, right) => {
      const leftIsManifest = left.endsWith("/manifest.json");
      const rightIsManifest = right.endsWith("/manifest.json");
      if (leftIsManifest !== rightIsManifest) return leftIsManifest ? -1 : 1;
      return left.localeCompare(right);
    });
    const table = this.comparisonBodyEl.createEl(
      "table",
      "easy-sync-metadata-table easy-sync-bundle-overview",
    );
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: this.t("conflictDetail.file") });
    headerRow.createEl("th", { text: this.t("conflictDetail.localLabel") });
    headerRow.createEl("th", { text: this.t("conflictDetail.remoteLabel") });
    headerRow.createEl("th", { text: this.t("syncView.pluginBundleReview.review") });

    const tbody = table.createEl("tbody");
    for (const path of orderedPaths) {
      const row = tbody.createEl("tr");
      const fileName = path.slice(path.lastIndexOf("/") + 1);
      const nameCell = row.createEl("td");
      nameCell.setText(fileName);

      const local = snapshot.local.find((fact) => fact.path === path);
      const remote = snapshot.remote.find((fact) => fact.path === path);
      const file = presentation?.files.find((entry) => entry.path === path);

      // Version is only shown for the manifest row; other files show the
      // modified time (matching the "outer = version + mtime" layering).
      const isManifest = fileName === "manifest.json";
      const identical = Boolean(
        local?.exists
        && remote?.exists
        && local.hash === remote.hash,
      );
      const localValue = identical
        ? "—"
        : isManifest && localVersion !== null
          ? this.t("syncView.pluginBundleReview.version", { version: localVersion })
          : bundleLocalText(local, file, this.t);
      const remoteValue = identical
        ? "—"
        : isManifest && remoteVersion !== null
          ? this.t("syncView.pluginBundleReview.version", { version: remoteVersion })
          : bundleRemoteText(remote, file, this.t);
      const localCell = row.createEl("td", "easy-sync-meta-col-local");
      localCell.setText(localValue);
      const remoteCell = row.createEl("td", "easy-sync-meta-col-remote");
      remoteCell.setText(remoteValue);

      // Identical rows carry no comparison signal — the "两端一致" marker in
      // the action column already says everything.
      if (!identical) {
        // Manifest: the newer version side gets the accent signal (same as
        // the ordinary conflict-detail metadata table).
        if (isManifest && localVersion !== null && remoteVersion !== null) {
          const comparison = compareCommunityPluginVersions(localVersion, remoteVersion);
          if (comparison !== null && comparison > 0) localCell.addClass("easy-sync-meta-highlight");
          else if (comparison !== null && comparison < 0) remoteCell.addClass("easy-sync-meta-highlight");
        } else {
          const localMtime = file?.localMtime;
          const remoteMtime = file?.remoteMtime;
          if (
            localMtime !== undefined
            && remoteMtime !== undefined
            && localMtime !== remoteMtime
          ) {
            if (localMtime > remoteMtime) localCell.addClass("easy-sync-meta-highlight");
            else remoteCell.addClass("easy-sync-meta-highlight");
          } else {
            const localSize = local?.exists ? local.size : undefined;
            const remoteSize = remote?.exists ? remote.size : undefined;
            if (
              localSize !== undefined
              && remoteSize !== undefined
              && localSize !== remoteSize
            ) {
              if (localSize > remoteSize) localCell.addClass("easy-sync-meta-highlight");
              else remoteCell.addClass("easy-sync-meta-highlight");
            }
          }
        }
      }

      const actionCell = row.createEl("td");
      const canDiff = Boolean(
        local?.exists
        && remote?.exists
        && local.hash !== remote.hash,
      );
      if (canDiff) {
        const button = actionCell.createEl("button", {
          cls: "easy-sync-bundle-diff-link",
          text: this.t("syncView.pluginBundleReview.viewDiff"),
        });
        button.addEventListener("click", () => {
          void this.openBundleFileDiff(snapshot, path);
        });
      } else if (local?.exists && remote?.exists) {
        // Byte-identical on both sides: nothing to review for this member.
        actionCell.createSpan("easy-sync-bundle-identical").setText(
          this.t("syncView.pluginBundleReview.fileIdentical"),
        );
      }
    }
  }

  /**
   * Open a standalone single-file diff dialog (the "sub-dialog") immediately;
   * the diff data loads asynchronously inside the dialog so the user is not
   * left waiting on the overview. It reuses the ordinary conflict-detail
   * loading copy and the shared bounded diff renderer; there are no decision
   * buttons — only the host close X.
   */
  private openBundleFileDiff(
    snapshot: MutationResolutionSnapshot,
    path: string,
  ): void {
    const pluginId = snapshot.bundleReview?.pluginId ?? "";
    const getFileDiff = this.getFileDiff;
    const modal = new BundleFileDiffModal(
      this.app,
      this.t,
      path,
      getFileDiff
        ? () => getFileDiff(pluginId, path)
        : () => Promise.resolve(null),
    );
    modal.open();
  }

  private buildComparisonRows(): FileComparisonRow[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    const paths = new Set([
      ...snapshot.local.map((fact) => fact.path),
      ...snapshot.remote.map((fact) => fact.path),
    ]);
    return [...paths].map((path) => ({
      label: path,
      local: fileFactText(
        snapshot.local.find((fact) => fact.path === path),
        this.t,
      ),
      remote: fileFactText(
        snapshot.remote.find((fact) => fact.path === path),
        this.t,
      ),
    }));
  }

  /**
   * Version-mismatch confirmation for bundle choices.
   *
   * - keep-remote with remote version < local version: the cloud bundle is
   *   older, so choosing it rolls the local plugin back — require confirmation.
   * - keep-local with local version < remote version: the local bundle is
   *   older, so choosing it overwrites the newer cloud bundle — require
   *   confirmation.
   * Any other choice proceeds directly.
   */
  private async confirmDowngradeIfNeeded(
    snapshot: MutationResolutionSnapshot,
    choice: ManualMutationResolutionChoiceV1,
  ): Promise<void> {
    const presentation = snapshot.bundlePresentation;
    const localVersion = presentation?.localVersion ?? null;
    const remoteVersion = presentation?.remoteVersion ?? null;
    if (localVersion === null || remoteVersion === null) {
      this.finish(choice);
      return;
    }
    // Single SemVer comparison for both the downgrade and the overwrite gate
    // (review 2026-09-02 finding ②): the modal previously used a lenient
    // segment parser that disagreed with the strictly-SemVer plan-level guard
    // on build metadata / pre-release combinations. Unparseable versions
    // compare as null → no confirmation (guard stays best-effort).
    const comparison = compareCommunityPluginVersions(localVersion, remoteVersion);
    if (!requiresBundleVersionConfirmation(choice, comparison)) {
      this.finish(choice);
      return;
    }
    const isDowngradeChoice = choice === "keep-remote";
    const titleKey = isDowngradeChoice
      ? "confirm.pluginDowngradeTitle"
      : "confirm.pluginUpgradeTitle";
    const messageKey = isDowngradeChoice
      ? "confirm.pluginDowngradeMessage"
      : "confirm.pluginUpgradeMessage";
    const confirmed = await new ConfirmModal(
      this.app,
      this.t(titleKey),
      null,
      this.t("confirm.confirm"),
      this.t("confirm.cancel"),
      this.t,
      {
        message: this.t(messageKey, {
          local: this.t("syncView.pluginBundleReview.version", { version: localVersion }),
          remote: this.t("syncView.pluginBundleReview.version", { version: remoteVersion }),
        }),
        messageClass: "modal-title",
        danger: true,
      },
    ).awaitConfirm();
    if (!confirmed) return;
    this.finish(choice);
  }

  private finish(choice: ManualMutationResolutionChoiceV1 | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(choice);
  }
}

/** Read-only single-file diff data returned by the plugin (executor). */
export interface BundleFileDiffData {
  localText: string;
  remoteText: string;
  localMtime?: number;
  remoteMtime?: number;
  localSize: number;
  remoteSize: number;
  /** True when either side is not valid UTF-8 text (binary content). */
  binary?: boolean;
}

/**
 * Standalone single-file diff dialog opened from the community-plugin bundle
 * overview. It reuses the ordinary conflict-detail surface (metadata table +
 * bounded line diff + the same loading copy); the only exit is the host
 * modal close button. No decision actions live here — the whole-bundle choice
 * stays on the parent modal.
 */
class BundleFileDiffModal extends EasySyncModal {
  constructor(
    app: App,
    private readonly t: I18nFn,
    private readonly path: string,
    private readonly loadData: () => Promise<BundleFileDiffData | null>,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("easy-sync-conflict-detail");
    const body = this.contentEl.createDiv("easy-sync-conflict-body");

    this.setTitle(this.t("syncView.pluginBundleReview.diffTitle", {
      name: this.path.slice(this.path.lastIndexOf("/") + 1),
    }));
    const loadingEl = body.createDiv("easy-sync-detail-loading");
    loadingEl.setText(this.t("conflictDetail.summaryComparing"));

    let data: BundleFileDiffData | null;
    try {
      data = await this.loadData();
    } catch {
      data = null;
    }
    if (!data) {
      // Same degraded copy as the ordinary conflict detail dialog: the
      // remote content could not be fetched/comparsed, not that the reviewed
      // facts changed.
      loadingEl.remove();
      body.createDiv("easy-sync-remote-unavailable").setText(
        this.t("conflictDetail.remoteComparisonUnavailable"),
      );
      return;
    }
    if (data.binary) {
      // Either side is binary / non-text — same notice as the ordinary
      // conflict detail dialog.
      loadingEl.remove();
      body.createDiv("easy-sync-binary-notice").setText(
        this.t("conflictDetail.binaryFile"),
      );
      return;
    }
    if (data.localText === data.remoteText) {
      loadingEl.remove();
      body.createDiv("easy-sync-detail-identical").setText(
        this.t("conflictDetail.identical"),
      );
      return;
    }
    if (sameVisibleText(data.localText, data.remoteText)) {
      // Bytes differ but the visible text is identical (line endings /
      // encoding) — same copy as the ordinary conflict detail dialog.
      loadingEl.remove();
      body.createDiv("easy-sync-detail-format-difference").setText(
        this.t("conflictDetail.textSameBytesDifferent"),
      );
      return;
    }

    // Metadata table (reuses the ordinary conflict-detail two-column table).
    this.renderMetadataTable(body, data);

    const overBudget =
      data.localSize > MAX_TEXT_DIFF_BYTES_PER_SIDE
      || data.remoteSize > MAX_TEXT_DIFF_BYTES_PER_SIDE;
    if (overBudget) {
      loadingEl.remove();
      body.createDiv("easy-sync-diff-truncated").setText(
        this.t("conflictDetail.textDiffByteLimit", {
          limit: formatFileSize(MAX_TEXT_DIFF_BYTES_PER_SIDE),
        }),
      );
      body.createEl("h4", { text: this.t("conflictDetail.localPreview") });
      this.renderTextPreview(body, data.localText);
      return;
    }

    const diff = computeDisplayDiff(data.localText, data.remoteText);
    body.createEl("h4", {
      text: diff.complete
        ? this.t("conflictDetail.diffTitle") +
          ` (${this.t("conflictDetail.diffAdded", { count: diff.addedCount })}, ${this.t("conflictDetail.diffRemoved", { count: diff.removedCount })})`
        : this.t("conflictDetail.diffTitle") +
          ` (${this.t("conflictDetail.diffRegionsLocated", { count: diff.parts.length })})`,
    });
    renderDisplayDiff(body, diff, this.t);
    loadingEl.remove();
  }

  private renderTextPreview(container: HTMLElement, content: string): void {
    const lines = content.split("\n");
    const shown = Math.min(lines.length, MAX_FALLBACK_PREVIEW_LINES);
    if (shown < lines.length) {
      container.createDiv("easy-sync-diff-truncated").setText(
        this.t("conflictDetail.previewTruncated", { shown, total: lines.length }),
      );
    }
    const preview = container.createDiv("easy-sync-content-preview");
    const pre = preview.createEl("pre");
    pre.createEl("code", { text: lines.slice(0, shown).join("\n") });
  }

  private renderMetadataTable(
    body: HTMLElement,
    data: BundleFileDiffData,
  ): void {
    const table = body.createEl("table", "easy-sync-metadata-table");
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th");
    headerRow.createEl("th", { text: this.t("syncView.mutationResolution.localTitle") });
    headerRow.createEl("th", { text: this.t("syncView.mutationResolution.remoteTitle") });

    // Same "newer / larger side" accent signal as the ordinary conflict
    // detail metadata table (ConflictDetailModal.renderMetadata).
    const localMtime = data.localMtime;
    const remoteMtime = data.remoteMtime;
    const localIsNewer = localMtime !== undefined
      && remoteMtime !== undefined
      && localMtime > remoteMtime;
    const remoteIsNewer = localMtime !== undefined
      && remoteMtime !== undefined
      && remoteMtime > localMtime;
    const localLarger = data.localSize > data.remoteSize;
    const remoteLarger = data.remoteSize > data.localSize;

    const tbody = table.createEl("tbody");
    const mtimeRow = tbody.createEl("tr");
    mtimeRow.createEl("td", {
      text: this.t("conflictDetail.modifiedTime"),
    });
    const localMtimeCell = mtimeRow.createEl("td", "easy-sync-meta-col-local");
    localMtimeCell.setText(this.formatMtime(localMtime));
    const remoteMtimeCell = mtimeRow.createEl("td", "easy-sync-meta-col-remote");
    remoteMtimeCell.setText(this.formatMtime(remoteMtime));
    if (localIsNewer) localMtimeCell.addClass("easy-sync-meta-highlight");
    if (remoteIsNewer) remoteMtimeCell.addClass("easy-sync-meta-highlight");

    const sizeRow = tbody.createEl("tr");
    sizeRow.createEl("td", { text: this.t("conflictDetail.fileSize") });
    const localSizeCell = sizeRow.createEl("td", "easy-sync-meta-col-local");
    localSizeCell.setText(formatFileSize(data.localSize));
    const remoteSizeCell = sizeRow.createEl("td", "easy-sync-meta-col-remote");
    remoteSizeCell.setText(formatFileSize(data.remoteSize));
    if (localLarger) localSizeCell.addClass("easy-sync-meta-highlight");
    if (remoteLarger) remoteSizeCell.addClass("easy-sync-meta-highlight");
  }

  private formatMtime(mtime: number | undefined): string {
    return mtime !== undefined
      ? new Date(mtime).toLocaleString()
      : "—";
  }
}
