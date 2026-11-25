/**
 * 切换同步方式前的确认（F3-c / A8）。
 *
 * 形状照「开启单向同步」的门槛弹框：一段说明＋一个手输项，手输与提示里的
 * 短语逐字一致之前「切换」不可用（门槛不降）。
 *
 * 只在**真正要切过去**时弹：`provider` 已经是目标云端时（改参数、重复保存）
 * 不弹；没有另一个云端在跑时也不弹。是否弹由调用方判，本弹框只负责确认。
 *
 * 文案是用户 2026-11-23 拍板后重做的一句话（展示稿 ⑦）：把「切换后第一次
 * 同步是全量比对、可能大量上传或下载」这个后果说清，不写机制说明。
 */
import { Setting, type App } from "obsidian";
import {
  addEasySyncFooterButton,
  bindModalKeyboardDismissal,
  createEasySyncModalFooter,
  EasySyncModal,
  keepModalFocusOnBody,
} from "./easy-sync-modal";
import type { I18nFn } from "./confirm-modal";

export class CloudSwitchGateModal extends EasySyncModal<boolean> {
  private readonly t: I18nFn;
  private confirmed = false;

  constructor(app: App, t: I18nFn) {
    super(app);
    this.t = t;
  }

  /** 打开并等待：true＝确认切换，false＝取消／关闭。 */
  awaitDecision(): Promise<boolean> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    const t = this.t;
    contentEl.empty();
    this.titleEl.setText(t("cloudSwitch.gate.title"));
    contentEl.createEl("p", { text: t("cloudSwitch.gate.message") });

    // 手输短语就是标题本身：用户要打出来的词与他在做什么同名，不需要再记
    // 一个额外口令（与「开启单向同步」同一套门槛形态）。
    const phrase = t("cloudSwitch.gate.title");
    let confirmBtn: ReturnType<typeof addEasySyncFooterButton> | null = null;
    new Setting(contentEl)
      .setName(t("cloudSwitch.gate.inputLabel", { phrase }))
      .addText((text) => {
        text.onChange((value) => {
          confirmBtn?.setDisabled(value !== phrase);
        });
      });

    const footer = createEasySyncModalFooter(contentEl, { divided: true });
    addEasySyncFooterButton(footer, {
      label: t("confirm.cancel"),
      onClick: () => this.settle(false),
    });
    confirmBtn = addEasySyncFooterButton(footer, {
      label: t("cloudSwitch.gate.confirm"),
      variant: "cta",
      onClick: () => {
        this.confirmed = true;
        this.settle(true);
      },
    });
    // 门槛不降：打对之前「切换」不可用。
    confirmBtn.setDisabled(true);

    keepModalFocusOnBody(this);
    this.keyboardDispose = bindModalKeyboardDismissal(this);
  }

  onClose(): void {
    this.keyboardDispose?.();
    this.keyboardDispose = null;
    this.contentEl.empty();
    // 直接关掉（Esc／点外部／右上角）＝取消。
    if (!this.confirmed) this.takePendingResolve()?.(false);
  }

  private keyboardDispose: (() => void) | null = null;
}
