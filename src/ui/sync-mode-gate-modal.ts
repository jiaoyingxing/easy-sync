import { Setting, type App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";
import type { I18nFn } from "./confirm-modal";

/**
 * 片⑥ 开启门槛弹框：切到单向同步前的手输确认。
 *
 * 形状＝多段说明＋一个手输项（借 `sync-exclusion-modal` 的输入写法）。
 * 两个状态：正常可切换／有待确认的云端删除时拦下（提示先去同步面板处理，
 * 确认按钮保持不可用）。门槛不降：手输与提示句逐字一致前确认不可用。
 */
interface SyncModeGateViewV1 {
  title: string;
  /** 首句（正常字号）。 */
  message: string;
  /** 编号要点（正常字号、无空行；编号由渲染层的有序列表给出）。 */
  points: string[];
  /** 要点之后的收尾句：这批文件之后会出现在哪里、能怎么选。 */
  tail: string;
  /** 数量行：改过数只在 > 0 时出现（0 件时不出现"本机有 0 个文件…"这类空话），
   *  拦下态追加待确认删除数。 */
  counts: string[];
  inputLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 有待确认的云端删除＝拦下状态（确认不可用、多一句引导）。 */
  blocked: boolean;
  confirmDisabled: boolean;
}

/**
 * 门槛弹框的纯视图模型（逐字使用文案稿）：首句＋编号要点＋收尾句＋数量行，
 * 拦下时多一句引导；确认按钮在"被拦下"或"手输与提示句不一致"时不可用
 * （门槛不降）。
 */
export function buildSyncModeGateView(input: {
  t: I18nFn;
  counts: Readonly<{ edited: number; blockedDeletes: number }>;
  expectedInput: string;
  typed?: string;
}): SyncModeGateViewV1 {
  const t = input.t;
  const blocked = input.counts.blockedDeletes > 0;
  return {
    title: t("settings.syncMode.gate.title"),
    message: t("settings.syncMode.gate.message"),
    // 显示顺序（2026-10-28 用户拍板）：「作用范围」最反直觉、也最容易让用户
    // 误以为单向会停掉全部上传，放第一条；键名保持语义稳定，只改渲染顺序。
    points: [
      t("settings.syncMode.gate.point3"),
      t("settings.syncMode.gate.point1"),
      t("settings.syncMode.gate.point2"),
    ],
    tail: t("settings.syncMode.gate.tail"),
    counts: [
      ...(input.counts.edited > 0
        ? [t("settings.syncMode.gate.editedCount", { count: input.counts.edited })]
        : []),
      ...(blocked
        ? [t("settings.syncMode.gate.blockedDeletes", {
            count: input.counts.blockedDeletes,
          })]
        : []),
    ],
    inputLabel: t("settings.syncMode.gate.inputLabel"),
    confirmLabel: t("settings.syncMode.gate.confirm"),
    cancelLabel: t("confirm.cancel"),
    blocked,
    confirmDisabled: blocked || (input.typed ?? "") !== input.expectedInput,
  };
}

export class SyncModeGateModal extends EasySyncModal<boolean> {
  constructor(
    app: App,
    private t: I18nFn,
    private counts: Readonly<{ edited: number; blockedDeletes: number }>,
    private expectedInput: string,
  ) {
    super(app);
  }

  awaitDecision(): Promise<boolean> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    let view = buildSyncModeGateView({
      t: this.t,
      counts: this.counts,
      expectedInput: this.expectedInput,
    });
    this.setTitle(view.title);
    // 首句、编号要点、收尾句与数量行同为正常字号（2026-10-12 用户反馈：
    // 弹框条目不要用系统次要小字）。编号要点用有序列表（编号由结构给出，
    // 文案稿不含编号）；列表项之间不留空行。
    contentEl.createEl("p", { text: view.message });
    const points = contentEl.createEl("ol");
    for (const point of view.points) {
      points.createEl("li", { text: point });
    }
    contentEl.createEl("p", { text: view.tail });
    for (const line of view.counts) {
      contentEl.createEl("p", { text: line });
    }

    let confirmBtn: HTMLButtonElement | null = null;
    const refresh = (typed: string): void => {
      view = buildSyncModeGateView({
        t: this.t,
        counts: this.counts,
        expectedInput: this.expectedInput,
        typed,
      });
      if (confirmBtn) confirmBtn.disabled = view.confirmDisabled;
    };
    new Setting(contentEl)
      .setName(view.inputLabel)
      .addText((text) => {
        text.onChange((value) => refresh(value));
      });
    const btnRow = contentEl.createDiv("modal-button-container");
    confirmBtn = btnRow.createEl("button", {
      text: view.confirmLabel,
      cls: "mod-cta",
    });
    // 门槛不降：手输一致之前、以及被拦下时，确认都不可用。
    confirmBtn.disabled = view.confirmDisabled;
    confirmBtn.addEventListener("click", () => {
      if (confirmBtn?.disabled !== false) return;
      this.settle(true);
    });
    const cancelBtn = btnRow.createEl("button", { text: view.cancelLabel });
    cancelBtn.addEventListener("click", () => this.settle(false));
  }

  onClose(): void {
    this.takePendingResolve()?.(false);
  }
}
