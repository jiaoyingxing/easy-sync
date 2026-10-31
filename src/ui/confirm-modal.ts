/**
 * SyncPlanAlertModal — lightweight, non-blocking notification.
 *
 * Used after generating a sync plan that needs review (first sync or
 * threshold exceeded). Shows one or more messages and a single button that opens
 * the sidebar. The plan is already persisted to state — dismissing the
 * alert does not discard it.
 */
export class SyncPlanAlertModal extends EasySyncModal {
  constructor(
    app: App,
    private title: string,
    private messages: readonly string[],
    private buttonLabel: string,
    private onViewPlan: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // 纯提示框：正文即全部内容，正文放大走 styles.css 白名单。
    this.modalEl.addClass("easy-sync-prompt-modal");
    this.setTitle(this.title);

    for (const message of this.messages) {
      contentEl.createEl("p", {
        text: message,
        cls: "setting-item-description",
      });
    }

    const btnRow = createEasySyncModalFooter(contentEl);
    addEasySyncFooterButton(btnRow, {
      label: this.buttonLabel,
      variant: "cta",
      onClick: () => {
        this.onViewPlan();
        this.close();
      },
    });
  }

  onClose(): void {
    // No-op: the plan preview persists in sidebar regardless.
  }
}

/**
 * ConfirmModal — minimum viable confirmation dialog for sync safety boundaries.
 *
 * Used for:
 *  - Settings reset confirmation
 *  - Batch remote-delete confirmation
 *  - (First sync / threshold alerts now use SyncPlanAlertModal)
 *
 * Design: deliberately minimal. A real plugin would improve the UI later,
 * but the safety boundary (user can cancel before destructive actions) must
 * exist from day one.
 */

import { type App } from "obsidian";
import {
  addEasySyncFooterButton,
  createEasySyncModalFooter,
  EasySyncModal,
} from "./easy-sync-modal";

export type I18nFn = (key: string, params?: Record<string, string | number>) => string;

export class ConfirmModal extends EasySyncModal<boolean> {
  constructor(
    app: App,
    private title: string,
    private confirmLabel: string,
    private cancelLabel: string,
    private t: I18nFn,
    private options?: {
      message?: string;
      /** Additional plain paragraphs after `message` (one per line). Used when
       *  the body is a short list of facts rather than one sentence; each line
       *  uses the same unstyled paragraph as `message`. */
      lines?: readonly string[];
      /** Ordered action/rule lines rendered as a native `<ol>`. Use only when
       *  the body describes two or more actions or rules; single actions stay
       *  one sentence and zero-file actions stay paragraphs (2026-10-31). */
      steps?: readonly string[];
      warning?: string;
      danger?: boolean;
      /** Extra class for the message paragraph; omit for a plain paragraph
       *  written identically to the warning line. */
      messageClass?: string;
    },
  ) {
    super(app);
  }

  /** Open the modal and return a promise that resolves to true (confirmed) or false (cancelled). */
  awaitConfirm(): Promise<boolean> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(this.title);

    // 两段正文写法必须一致（2026-10-24 用户真机实测指认）：message 与
    // warning 都用无类纯段落，颜色与字号同链继承。message 之前挂宿主的
    // 设置页说明专用类（灰字＋小号语义）——CSS 顶字号治不了灰色，iOS 上
    // 与纯继承行的字号也不重合，两行永远差一截。显式 messageClass 仅留给
    // 特殊强调（插件版本确认的 modal-title）。
    if (this.options?.message) {
      contentEl.createEl("p", {
        text: this.options.message,
        cls: this.options?.messageClass,
      });
    }

    for (const line of this.options?.lines ?? []) {
      contentEl.createEl("p", { text: line });
    }

    if (this.options?.steps && this.options.steps.length > 0) {
      const steps = contentEl.createEl("ol", { cls: "easy-sync-confirm-steps" });
      for (const step of this.options.steps) {
        steps.createEl("li", { text: step });
      }
    }

    if (this.options?.warning) {
      contentEl.createEl("p", { text: this.options.warning });
    }

    const btnRow = createEasySyncModalFooter(contentEl);
    // DOM order: the cancel exit first (secondary), the confirm action last —
    // phones show the confirm on top via the host's column-reverse.
    addEasySyncFooterButton(btnRow, {
      label: this.cancelLabel,
      onClick: () => {
        this.settle(false);
      },
    });
    addEasySyncFooterButton(btnRow, {
      label: this.confirmLabel,
      variant: this.options?.danger ? "destructive" : "cta",
      onClick: () => {
        this.settle(true);
      },
    });
  }

  onClose(): void {
    // If modal was closed without clicking a button, treat as cancel
    this.takePendingResolve()?.(false);
  }
}
