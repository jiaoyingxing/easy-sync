import { type App } from "obsidian";
import {
  addEasySyncFooterButton,
  createEasySyncModalFooter,
  EasySyncModal,
} from "./easy-sync-modal";
import type { I18nFn } from "./confirm-modal";

/**
 * 片⑥ 关闭告知弹框：切回双向同步前的多段说明（形状照现役多段说明弹框）。
 *
 * 行数与内容按事实出现（2026-10-12 文案重设计）：说明句恒定；尚未上传数与
 * "其中不再提醒数"只在各自大于 0 时出现——没有可上传内容时不再出现"本机有
 * 0 个文件…"这类空话，界面只剩说明句与两个按钮。
 */
interface SyncModeDisableViewV1 {
  title: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel: string;
}

/** 关闭告知弹框的纯视图模型（逐字使用文案稿）：说明句＋按需出现的数量行。 */
export function buildSyncModeDisableView(input: {
  t: I18nFn;
  counts: Readonly<{ pendingUploads: number; dismissed: number }>;
}): SyncModeDisableViewV1 {
  const t = input.t;
  return {
    title: t("settings.syncMode.disable.title"),
    lines: [
      t("settings.syncMode.disable.message"),
      ...(input.counts.pendingUploads > 0
        ? [t("settings.syncMode.disable.count", {
            count: input.counts.pendingUploads,
          })]
        : []),
      ...(input.counts.dismissed > 0
        ? [t("settings.syncMode.disable.dismissedCount", {
            count: input.counts.dismissed,
          })]
        : []),
    ],
    confirmLabel: t("settings.syncMode.disable.confirm"),
    cancelLabel: t("confirm.cancel"),
  };
}

export class SyncModeDisableModal extends EasySyncModal<boolean> {
  constructor(
    app: App,
    private t: I18nFn,
    private counts: Readonly<{ pendingUploads: number; dismissed: number }>,
  ) {
    super(app);
  }

  awaitDecision(): Promise<boolean> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const view = buildSyncModeDisableView({ t: this.t, counts: this.counts });
    this.setTitle(view.title);
    // 正文与开启门槛弹框一致＝正常字号（2026-10-12 用户反馈：弹框不用小字）。
    for (const line of view.lines) {
      contentEl.createEl("p", { text: line });
    }
    const btnRow = createEasySyncModalFooter(contentEl);
    addEasySyncFooterButton(btnRow, {
      label: view.cancelLabel,
      onClick: () => this.settle(false),
    });
    addEasySyncFooterButton(btnRow, {
      label: view.confirmLabel,
      variant: "cta",
      onClick: () => this.settle(true),
    });
  }

  onClose(): void {
    this.takePendingResolve()?.(false);
  }
}
