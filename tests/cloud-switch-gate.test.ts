/**
 * F3-c / A8：切换同步方式的手输门槛。
 *
 * 钉住三条用户可感知的合同：
 * 1. 打不出与提示一致的短语之前，「切换」不可用（门槛不降）；
 * 2. 打对之后「切换」可用，点它＝确认（true）；
 * 3. 直接关掉（Esc／点外部／右上角）＝取消（false），不能静默当成确认。
 */
import { describe, expect, it } from "vitest";
import { ButtonComponent, TextComponent } from "obsidian";
import { I18n } from "../src/i18n";
import { CloudSwitchGateModal } from "../src/ui/cloud-switch-gate-modal";

const t = new I18n("zh-cn");
const PHRASE = t.t("cloudSwitch.gate.title");

/** `ButtonComponent` mock 不暴露实例表：在 `onClick` 里登记并挂点击钩子。 */
const buttons: ButtonComponent[] = [];

function trackButtons(): void {
  const proto = ButtonComponent.prototype as unknown as { __tracked?: boolean };
  if (proto.__tracked) return;
  proto.__tracked = true;
  const originalOnClick = ButtonComponent.prototype.onClick;
  ButtonComponent.prototype.onClick = function patched(
    this: ButtonComponent,
    handler: () => void,
  ): ButtonComponent {
    if (!buttons.includes(this)) {
      buttons.push(this);
      (this.buttonEl as unknown as { __click?: () => void }).__click = () => handler();
    }
    return originalOnClick.call(this, handler);
  } as never;
}

function build(): {
  modal: CloudSwitchGateModal;
  decision: Promise<boolean>;
  confirm: ButtonComponent;
  cancel: ButtonComponent;
  input: TextComponent;
} {
  trackButtons();
  buttons.length = 0;
  TextComponent.instances.length = 0;
  const modal = new CloudSwitchGateModal({} as never, t.t.bind(t));
  const decision = modal.awaitDecision();
  modal.onOpen();
  const [cancel, confirm] = buttons;
  const input = TextComponent.instances[0];
  return { modal, decision, confirm, cancel, input };
}

describe("切换同步方式的手输门槛", () => {
  it("标题与一句话后果逐字是拍板稿，输入前「切换」不可用", () => {
    const { modal, confirm } = build();
    expect(modal.titleEl.textContent).toBe("切换同步方式");
    // 正文与手输提示逐字取自已确认的展示稿 ⑦（用户 2026-11-23）。
    expect(t.t("cloudSwitch.gate.message"))
      .toBe("第一次同步会全量比对，可能大量上传或下载。");
    expect(t.t("cloudSwitch.gate.inputLabel", { phrase: PHRASE }))
      .toBe("请输入“切换同步方式”以继续。");
    expect(confirm.buttonEl.disabled).toBe(true);
    expect(confirm.buttonEl.textContent).toBe("切换");
  });

  it("打错／少字仍是不可用；逐字一致后才放行", async () => {
    const { confirm, input } = build();
    await input.triggerChange("切换同步方");
    expect(confirm.buttonEl.disabled).toBe(true);
    await input.triggerChange("切换同步方式！");
    expect(confirm.buttonEl.disabled).toBe(true);
    await input.triggerChange(PHRASE);
    expect(confirm.buttonEl.disabled).toBe(false);
  });

  it("点「切换」＝确认", async () => {
    const { decision, confirm, input } = build();
    await input.triggerChange(PHRASE);
    (confirm.buttonEl as unknown as { __click?: () => void }).__click?.();
    await expect(decision).resolves.toBe(true);
  });

  it("点「取消」＝取消", async () => {
    const { decision, cancel } = build();
    (cancel.buttonEl as unknown as { __click?: () => void }).__click?.();
    await expect(decision).resolves.toBe(false);
  });

  it("直接关掉弹框＝取消（不能静默当成确认）", async () => {
    const { modal, decision } = build();
    modal.onClose();
    await expect(decision).resolves.toBe(false);
  });
});
