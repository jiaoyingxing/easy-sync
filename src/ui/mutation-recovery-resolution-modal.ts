import type { App } from "obsidian";
import type {
  CommunityPluginBundleReviewBlockReasonV1,
  ManualMutationResolutionChoiceV1,
  ManualMutationResolutionLocalFactV1,
  ManualMutationResolutionRemoteFactV1,
  ManualMutationResolutionSnapshotV1,
} from "../sync/types";
import type { I18nFn } from "./confirm-modal";
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

/** Per-file agreement state shown next to the file name. */
function bundleFileStatusText(
  local:
    | Readonly<
      Pick<ManualMutationResolutionLocalFactV1, "exists" | "hash">
    >
    | undefined,
  remote:
    | Readonly<
      Pick<ManualMutationResolutionRemoteFactV1, "exists" | "hash">
    >
    | undefined,
  t: I18nFn,
): string | undefined {
  const localExists = local?.exists === true;
  const remoteExists = remote?.exists === true;
  if (localExists && remoteExists) {
    return local?.hash === remote?.hash
      ? t("syncView.pluginBundleReview.fileIdentical")
      : t("syncView.pluginBundleReview.fileDifferent");
  }
  if (localExists) return t("syncView.pluginBundleReview.fileLocalOnly");
  if (remoteExists) return t("syncView.pluginBundleReview.fileRemoteOnly");
  return undefined;
}

/** One bundle file cell: size line + modified-time line (when readable). */
function factPresentationText(
  fact:
    | Readonly<
      Pick<ManualMutationResolutionLocalFactV1, "exists" | "size">
    >
    | Readonly<
      Pick<ManualMutationResolutionRemoteFactV1, "exists" | "size">
    >
    | undefined,
  mtime: number | undefined,
  isNewer: boolean,
  isLarger: boolean,
  t: I18nFn,
): string {
  if (!fact?.exists) return t("syncView.mutationResolution.missing");
  const lines = [
    formatFileSize(fact.size ?? 0) + (isLarger ? ` ${t("conflictDetail.larger")}` : ""),
  ];
  if (mtime !== undefined) {
    lines.push(
      new Date(mtime).toLocaleString() + (isNewer ? ` ${t("conflictDetail.newer")}` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * Best-effort numeric comparison of plugin version strings ("1.3.0-beta.1").
 * Strictly unequal numeric segments decide; unparseable segments sort before
 * any number so pre-release labels never win against a release.
 */
function comparePluginVersions(local: string, remote: string): number {
  const localParts = local.split(/[.-]/).map(versionSegmentToNumber);
  const remoteParts = remote.split(/[.-]/).map(versionSegmentToNumber);
  const length = Math.max(localParts.length, remoteParts.length);
  for (let index = 0; index < length; index++) {
    const left = localParts[index] ?? 0;
    const right = remoteParts[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function versionSegmentToNumber(segment: string): number {
  const value = Number.parseInt(segment, 10);
  return Number.isNaN(value) ? -1 : value;
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
      body.createEl("h3", {
        text: this.t("syncView.pluginBundleReview.title"),
      });
      body.createEl("p", {
        text: this.t(this.snapshotUnavailable
          ? "syncView.pluginBundleReview.loadUnavailable"
          : "syncView.pluginBundleReview.loading"),
        cls: "easy-sync-detail-reason",
      });
      this.renderFileComparisonActions([{
        label: this.t("confirm.cancel"),
        onClick: () => this.finish(null),
      }]);
      return;
    }

    const bundle = snapshot.bundleReview;
    body.createEl("h3", {
      text: this.t(bundle
        ? "syncView.pluginBundleReview.title"
        : "syncView.mutationResolution.title"),
    });
    if (bundle) {
      body.createEl("p", {
        text: this.t("syncView.pluginBundleReview.description", {
          name: bundle.displayName ?? bundle.pluginId,
        }),
        cls: "easy-sync-detail-reason",
      });
    }

    this.renderComparisonTable(
      this.t("syncView.mutationResolution.localTitle"),
      this.t("syncView.mutationResolution.remoteTitle"),
      bundle
        ? this.buildBundleComparisonRows(snapshot)
        : this.buildComparisonRows(),
    ).addClass(
      "easy-sync-comparison-path-table",
      ...(bundle ? ["easy-sync-comparison-bundle-table"] : []),
    );

    if (!bundle) {
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

    if (bundle && snapshot.identical) {
      body.createEl("p", {
        text: this.t("syncView.pluginBundleReview.identical"),
        cls: "easy-sync-detail-identical",
      });
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
          label: this.t("syncView.pluginBundleReview.keepLocal"),
          className: "easy-sync-detail-action-local",
          disabled: !executableChoices.includes("keep-local")
            || !snapshot.keepLocal.available,
          onClick: () => this.finish("keep-local"),
        },
        {
          label: this.t("syncView.pluginBundleReview.keepRemote"),
          className: "easy-sync-detail-action-remote",
          disabled: !executableChoices.includes("keep-remote")
            || !snapshot.keepRemote.available,
          onClick: () => this.finish("keep-remote"),
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
   * Bundle rows put the decisive evidence first: one manifest-version row,
   * then per-file rows carrying size, last-modified time and a per-file
   * agreement state. Times and versions come from the display-only
   * `bundlePresentation`; hashes stay untouched in the reviewed facts.
   */
  private buildBundleComparisonRows(
    snapshot: MutationResolutionSnapshot,
  ): FileComparisonRow[] {
    const t = this.t;
    const presentation = snapshot.bundlePresentation;
    const rows: FileComparisonRow[] = [];

    // ---- Manifest version row (decisive "which release" signal) ----
    const localVersion = presentation?.localVersion ?? null;
    const remoteVersion = presentation?.remoteVersion ?? null;
    if (localVersion !== null || remoteVersion !== null) {
      const comparison = localVersion !== null && remoteVersion !== null
        ? comparePluginVersions(localVersion, remoteVersion)
        : 0;
      rows.push({
        label: t("syncView.pluginBundleReview.versionLabel"),
        local: localVersion !== null
          ? t("syncView.pluginBundleReview.version", { version: localVersion })
            + (comparison > 0 ? ` ${t("conflictDetail.newer")}` : "")
          : t("syncView.mutationResolution.missing"),
        remote: remoteVersion !== null
          ? t("syncView.pluginBundleReview.version", { version: remoteVersion })
            + (comparison < 0 ? ` ${t("conflictDetail.newer")}` : "")
          : t("syncView.mutationResolution.missing"),
        localHighlighted: comparison > 0,
        remoteHighlighted: comparison < 0,
      });
    }

    // ---- Per-file rows: size + modified time + agreement state ----
    const paths = new Set([
      ...snapshot.local.map((fact) => fact.path),
      ...snapshot.remote.map((fact) => fact.path),
    ]);
    for (const path of [...paths].sort((left, right) =>
      left.localeCompare(right))) {
      const local = snapshot.local.find((fact) => fact.path === path);
      const remote = snapshot.remote.find((fact) => fact.path === path);
      const file = presentation?.files.find((entry) => entry.path === path);
      const localTime = file?.localMtime;
      const remoteTime = file?.remoteMtime;
      const localSize = local?.exists ? local.size : undefined;
      const remoteSize = remote?.exists ? remote.size : undefined;
      const localIsNewer = localTime !== undefined
        && remoteTime !== undefined
        && localTime > remoteTime;
      const remoteIsNewer = localTime !== undefined
        && remoteTime !== undefined
        && remoteTime > localTime;
      const localLarger = localSize !== undefined
        && remoteSize !== undefined
        && localSize > remoteSize;
      const remoteLarger = localSize !== undefined
        && remoteSize !== undefined
        && remoteSize > localSize;
      rows.push({
        label: path.slice(path.lastIndexOf("/") + 1),
        status: bundleFileStatusText(local, remote, t),
        local: factPresentationText(local, localTime, localIsNewer, localLarger, t),
        remote: factPresentationText(remote, remoteTime, remoteIsNewer, remoteLarger, t),
        localHighlighted: localIsNewer || localLarger,
        remoteHighlighted: remoteIsNewer || remoteLarger,
      });
    }
    return rows;
  }

  private finish(choice: ManualMutationResolutionChoiceV1 | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(choice);
  }
}
