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
    body.createEl("p", {
      text: bundle
        ? this.t("syncView.pluginBundleReview.description", {
            name: bundle.displayName ?? bundle.pluginId,
          })
        : this.t("syncView.mutationResolution.description", {
            path: snapshot.path,
          }),
      cls: "easy-sync-detail-reason",
    });
    if (!bundle) {
      body.createEl("p", {
        text: this.t("syncView.mutationResolution.previousAction", {
          action: this.t(
            `syncView.mutationResolution.action.${snapshot.previousAction}`,
          ),
        }),
        cls: "easy-sync-comparison-previous-action",
      });
    }

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
    if (!bundle) {
      detailList.createEl("li", {
        text: this.t("syncView.mutationResolution.operationId", {
          value: snapshot.sourceOperationId,
        }),
      });
    }
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

    if (snapshot.identical) {
      body.createEl("p", {
        text: this.t(bundle
          ? "syncView.pluginBundleReview.identical"
          : "syncView.mutationResolution.identical"),
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
    } else if (
      !snapshot.keepLocal.available
      || !snapshot.keepRemote.available
    ) {
      body.createEl("p", {
        text: this.t("syncView.mutationResolution.unavailable"),
        cls: "easy-sync-comparison-unavailable",
      });
    }

    const executableChoices = bundle
      ? bundle.executableChoices ?? []
      : ["keep-local", "keep-remote"];
    this.renderFileComparisonActions([
      {
        label: this.t(bundle
          ? "syncView.pluginBundleReview.keepLocal"
          : "syncView.mutationResolution.keepLocal"),
        className: "easy-sync-detail-action-local",
        disabled: bundle
          ? !executableChoices.includes("keep-local")
            || !snapshot.keepLocal.available
          : !snapshot.keepLocal.available,
        onClick: () => this.finish("keep-local"),
      },
      {
        label: this.t(bundle
          ? "syncView.pluginBundleReview.keepRemote"
          : "syncView.mutationResolution.keepRemote"),
        className: "easy-sync-detail-action-remote",
        disabled: bundle
          ? !executableChoices.includes("keep-remote")
            || !snapshot.keepRemote.available
          : !snapshot.keepRemote.available,
        onClick: () => this.finish("keep-remote"),
      },
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
    const bundle = snapshot.bundleReview;
    const paths = new Set([
      ...snapshot.local.map((fact) => fact.path),
      ...snapshot.remote.map((fact) => fact.path),
    ]);
    return [...paths].map((path) => ({
      label: bundle ? path.slice(path.lastIndexOf("/") + 1) : path,
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

  private finish(choice: ManualMutationResolutionChoiceV1 | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.close();
    resolve?.(choice);
  }
}
