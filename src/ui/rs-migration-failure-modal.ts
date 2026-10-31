/**
 * RsMigrationFailureModal — fail-closed exit of the Remotely Save adoption
 * (carrier plan §11.1 幕6): OneDrive refused the move/copy, nothing changed,
 * and the user gets three real exits — retry later (aborts this round, the
 * adoption choice survives), a plain fresh sync (closes the adoption
 * window), or the manual guide (opened on top; this modal stays).
 */
import { type App } from "obsidian";
import {
  addEasySyncFooterButton,
  createEasySyncModalFooter,
  EasySyncModal,
} from "./easy-sync-modal";

type RsMigrationFailureResult =
  | { action: "retry" }
  | { action: "fresh-sync" }
  | { action: "dismiss" };

interface RsMigrationFailureViews {
  title: string;
  body: string;
  retryLabel: string;
  freshLabel: string;
  guideLabel: string;
  guideTitle: string;
  guideBody: string;
  guideOk: string;
}

export class RsMigrationGuideModal extends EasySyncModal {
  constructor(
    app: App,
    private views: { title: string; body: string; okLabel: string },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // 纯提示框：正文即全部内容，正文放大走 styles.css 白名单。
    this.modalEl.addClass("easy-sync-prompt-modal");
    this.setTitle(this.views.title);
    for (const line of this.views.body.split("\n")) {
      contentEl.createEl("p", {
        text: line,
        cls: "setting-item-description",
      });
    }
    const btnRow = createEasySyncModalFooter(contentEl);
    addEasySyncFooterButton(btnRow, {
      label: this.views.okLabel,
      variant: "cta",
      onClick: () => {
        this.close();
      },
    });
  }

  override onClose(): void {
    // Resolves when the guide has been read (or dismissed).
    this.takePendingResolve()?.();
  }

  /** Resolves when the guide has been read (or dismissed). */
  awaitRead(): Promise<void> {
    return this.awaitResult();
  }
}

export class RsMigrationFailureModal extends EasySyncModal<RsMigrationFailureResult> {
  constructor(
    app: App,
    private views: RsMigrationFailureViews,
  ) {
    super(app);
  }

  awaitAction(): Promise<RsMigrationFailureResult> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // 纯提示框：正文即全部内容，正文放大走 styles.css 白名单。
    this.modalEl.addClass("easy-sync-prompt-modal");
    this.setTitle(this.views.title);

    contentEl.createEl("p", {
      text: this.views.body,
      cls: "setting-item-description",
    });

    // DOM order: the guide link and the plain alternative first, the CTA
    // retry last — phones show the retry on top via the host's column-reverse.
    const btnRow = createEasySyncModalFooter(contentEl);
    addEasySyncFooterButton(btnRow, {
      label: this.views.guideLabel,
      variant: "link",
      onClick: () => {
        void new RsMigrationGuideModal(this.app, {
          title: this.views.guideTitle,
          body: this.views.guideBody,
          okLabel: this.views.guideOk,
        }).awaitRead();
      },
    });
    addEasySyncFooterButton(btnRow, {
      label: this.views.freshLabel,
      onClick: () => {
        this.settle({ action: "fresh-sync" });
      },
    });
    addEasySyncFooterButton(btnRow, {
      label: this.views.retryLabel,
      variant: "cta",
      onClick: () => {
        this.settle({ action: "retry" });
      },
    });
  }

  override onClose(): void {
    this.takePendingResolve()?.({ action: "dismiss" });
  }
}
