/**
 * 选择同步方式（F4/S5，用户 2026-11-23 拍板 A5）。
 *
 * 只在**侧栏**的登录入口出现：先问用哪个云端，选 OneDrive 再进现役的
 * 「跳转登录／输入代码登录」，选 WebDAV 直接开配置弹窗。设置页的登录入口
 * 不插这一层（A10：两行直接摆着）。
 *
 * 形状照 `AuthMethodModal`（`EasySyncModal` + 选项行），但**不复用它的实例**
 * 也不共享语义：那个问的是「用哪种登录方式」，这个问的是「同步到哪个云」。
 * 两个问题混用一个弹框，文案一改就会互相牵连。
 *
 * 选择与动作解耦：本弹框只返回结果，不在选项里直接开别的弹框或登录，
 * 派发留给调用方——这样单测只钉「选了哪个」，不依赖后续流程。
 */
import type { App } from "obsidian";
import { EasySyncModal } from "./easy-sync-modal";

type CloudChoiceResult =
  | { readonly action: "onedrive" }
  | { readonly action: "webdav" }
  | { readonly action: "dismiss" };

interface CloudChoiceOptions {
  readonly title: string;
  readonly onedrive: { readonly name: string; readonly desc: string };
  readonly webdav: { readonly name: string; readonly desc: string };
}

export class CloudChoiceModal extends EasySyncModal<CloudChoiceResult> {
  private readonly options: CloudChoiceOptions;

  constructor(app: App, options: CloudChoiceOptions) {
    super(app);
    this.options = options;
  }

  /** 打开并等待：用户选了哪个云端，或直接关掉。 */
  openAndWait(): Promise<CloudChoiceResult> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("easy-sync-auth-method-modal");
    this.titleEl.setText(this.options.title);

    // 选项行复用共享件（与登录方式选择同一套视觉），不新增样式类。
    for (const [action, option] of [
      ["onedrive", this.options.onedrive],
      ["webdav", this.options.webdav],
    ] as const) {
      const button = this.buildOptionButton({
        title: option.name,
        description: option.desc,
      });
      button.addEventListener("click", () => {
        this.settle({ action });
      });
      contentEl.appendChild(button);
    }
  }

  override onClose(): void {
    this.takePendingResolve()?.({ action: "dismiss" });
  }
}
