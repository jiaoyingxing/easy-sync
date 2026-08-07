import type { App } from "obsidian";
import type {
  ManualMutationResolutionChoiceV1,
  ManualMutationResolutionLocalFactV1,
  ManualMutationResolutionRemoteFactV1,
  ManualMutationResolutionSnapshotV1,
} from "../sync/types";
import type { I18nFn } from "./confirm-modal";
import {
  FileComparisonModal,
  type FileComparisonRow,
} from "./file-comparison-modal";

function fileFactText(
  fact: Readonly<
    ManualMutationResolutionLocalFactV1 | ManualMutationResolutionRemoteFactV1
  > | undefined,
  t: I18nFn,
): string {
  return fact?.exists
    ? t("syncView.mutationResolution.present", { size: fact.size ?? 0 })
    : t("syncView.mutationResolution.missing");
}

/**
 * Recovery-specific adapter for the shared local/cloud comparison surface.
 * It only returns a reviewed choice; the ledger recheck and mutations remain
 * in SyncExecutor.
 */
export class MutationRecoveryResolutionModal extends FileComparisonModal {
  private resolve:
    ((choice: ManualMutationResolutionChoiceV1 | null) => void) | null = null;

  constructor(
    app: App,
    private readonly snapshot: Readonly<ManualMutationResolutionSnapshotV1>,
    private readonly t: I18nFn,
  ) {
    super(app);
  }

  awaitChoice(): Promise<ManualMutationResolutionChoiceV1 | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  protected renderComparison(): void {
    const body = this.comparisonBodyEl;
    body.createEl("h3", {
      text: this.t("syncView.mutationResolution.title"),
    });
    body.createEl("p", {
      text: this.t("syncView.mutationResolution.description", {
        path: this.snapshot.path,
      }),
      cls: "easy-sync-detail-reason",
    });
    body.createEl("p", {
      text: `${this.t("syncView.mutationResolution.previousAction")}：${this.t(
        `syncView.mutationResolution.action.${this.snapshot.previousAction}`,
      )}`,
      cls: "easy-sync-comparison-previous-action",
    });

    this.renderComparisonTable(
      this.t("syncView.mutationResolution.localTitle"),
      this.t("syncView.mutationResolution.remoteTitle"),
      this.buildComparisonRows(),
    );

    const details = body.createEl("details", {
      cls: "easy-sync-comparison-evidence",
    });
    details.createEl("summary", {
      text: this.t("syncView.mutationResolution.technicalDetails"),
    });
    const detailList = details.createEl("ul");
    detailList.createEl("li", {
      text: this.t("syncView.mutationResolution.operationId", {
        value: this.snapshot.sourceOperationId,
      }),
    });
    for (const fact of this.snapshot.local.filter((item) => item.exists)) {
      detailList.createEl("li", {
        text: `${fact.path} · SHA-256 ${fact.hash}`,
      });
    }
    for (const fact of this.snapshot.remote.filter((item) => item.exists)) {
      detailList.createEl("li", {
        text: `${fact.path} · ID ${fact.driveId} · eTag ${fact.eTag} · SHA-256 ${fact.hash}`,
      });
    }

    if (this.snapshot.identical) {
      body.createEl("p", {
        text: this.t("syncView.mutationResolution.identical"),
        cls: "easy-sync-detail-identical",
      });
    }
    if (!this.snapshot.keepLocal.available || !this.snapshot.keepRemote.available) {
      body.createEl("p", {
        text: this.t("syncView.mutationResolution.unavailable"),
        cls: "easy-sync-comparison-unavailable",
      });
    }

    this.renderFileComparisonActions([
      {
        label: this.t("syncView.mutationResolution.keepLocal"),
        className: "easy-sync-detail-action-local",
        disabled: !this.snapshot.keepLocal.available,
        onClick: () => this.finish("keep-local"),
      },
      {
        label: this.t("syncView.mutationResolution.keepRemote"),
        className: "easy-sync-detail-action-remote",
        disabled: !this.snapshot.keepRemote.available,
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
    const paths = new Set([
      ...this.snapshot.local.map((fact) => fact.path),
      ...this.snapshot.remote.map((fact) => fact.path),
    ]);
    return [...paths].map((path) => ({
      label: path,
      local: fileFactText(
        this.snapshot.local.find((fact) => fact.path === path),
        this.t,
      ),
      remote: fileFactText(
        this.snapshot.remote.find((fact) => fact.path === path),
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
