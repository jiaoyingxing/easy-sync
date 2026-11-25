/**
 * WebDavConfigModal 合同测试（C2）。
 *
 * 钉四件事：
 * 1) 四个字段＋底栏「取消／保存」，没有说明段、没有「测试连接」按钮；
 * 2) 保存中只挂宿主 `mod-loading`，按钮文字不变（用户批注：不要专门文案）；
 * 3) 本地校验不过不发请求；保存失败弹窗不关闭；
 * 4) 空密码＋已保存密码＝保留旧密码（提交原样把空串交给上层）。
 *
 * 本仓测试跑在 Node 上（无 jsdom），宿主 `Setting` 的控件不挂进真实 DOM；
 * 这里按 mock 暴露的实例钩子（`TextComponent.instances`／`ButtonComponent`）
 * 读取控件与按钮，而不是靠选择器。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ButtonComponent, TextComponent } from "obsidian";
import { WebDavConfigModal } from "../src/ui/webdav-config-modal";
import { functionBody } from "./helpers/source-scope";

const T = (key: string): string => key;

interface BuildOptions {
  submit?: (draft: {
    url: string;
    username: string;
    rootPrefix: string;
    password: string;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  hasSavedPassword?: boolean;
  coordinates?: {
    url: string;
    username: string;
    rootPrefix: string;
  } | null;
}

function buildModal(options: BuildOptions = {}): {
  modal: WebDavConfigModal;
  submit: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.spyOn>;
} {
  TextComponent.instances.length = 0;
  const submit = vi.fn(options.submit ?? (async () => ({ ok: true })));
  const modal = new WebDavConfigModal({
    app: {} as never,
    t: T,
    coordinates: options.coordinates ?? null,
    hasSavedPassword: options.hasSavedPassword ?? false,
    submit: submit as never,
  });
  const closeSpy = vi.spyOn(modal, "close").mockImplementation(() => undefined);
  modal.onOpen();
  return { modal, submit, closeSpy };
}

/** `ButtonComponent` mock 不暴露实例表：在 `onClick` 里登记实例并挂测试点击钩子。 */
const buttonInstances: ButtonComponent[] = [];

function trackButtons(): void {
  const proto = ButtonComponent.prototype as unknown as {
    __tracked?: boolean;
  };
  if (proto.__tracked) return;
  proto.__tracked = true;
  const Original = ButtonComponent;
  const originalOnClick = Original.prototype.onClick;
  Original.prototype.onClick = function patched(
    this: ButtonComponent,
    handler: () => void,
  ): ButtonComponent {
    if (!buttonInstances.includes(this)) {
      buttonInstances.push(this);
      const el = this.buttonEl as unknown as { __click?: () => void };
      el.__click = () => handler();
    }
    return originalOnClick.call(this, handler);
  } as never;
}

function fields(): TextComponent[] {
  return TextComponent.instances;
}

function fillFields(values: {
  url?: string;
  username?: string;
  password?: string;
  rootPrefix?: string;
}): void {
  const [url, username, password, rootPrefix] = fields();
  if (values.url !== undefined) url.setValue(values.url);
  if (values.username !== undefined) username.setValue(values.username);
  if (values.password !== undefined) password.setValue(values.password);
  if (values.rootPrefix !== undefined) rootPrefix.setValue(values.rootPrefix);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("WebDavConfigModal", () => {
  it("renders four text fields and a cancel/save footer with no test copy", () => {
    trackButtons();
    buttonInstances.length = 0;
    const { modal } = buildModal();

    expect(fields()).toHaveLength(4);
    expect(buttonInstances.map((button) => button.buttonEl.textContent)).toEqual([
      "settings.cloudConfig.cancel",
      "settings.cloudConfig.save",
    ]);
    expect(buttonInstances[1].buttonEl.classList.contains("mod-cta")).toBe(true);

    const allText = `${modal.contentEl.textContent ?? ""} ${modal.titleEl.textContent ?? ""}`;
    expect(allText).not.toContain("正在测试");
    expect(allText).not.toContain("cloudTest");
  });

  it("does not submit when the URL is invalid", async () => {
    trackButtons();
    buttonInstances.length = 0;
    const { submit } = buildModal();
    fillFields({ url: "http://nas.example.com/webdav", password: "x" });
    buttonInstances[1].buttonEl.__click?.();
    await flush();
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses the host loading state on save and keeps the button label", async () => {
    trackButtons();
    buttonInstances.length = 0;
    let release: (() => void) | null = null;
    buildModal({
      submit: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { ok: false, message: "failed" };
      },
    });
    fillFields({
      url: "https://nas.example.com/webdav",
      username: "alice",
      password: "app-password",
    });
    const saveButton = buttonInstances[1].buttonEl;
    saveButton.__click?.();
    await flush();

    expect(saveButton.classList.contains("mod-loading")).toBe(true);
    expect(saveButton.textContent).toBe("settings.cloudConfig.save");
    expect(saveButton.disabled).toBe(true);

    release?.();
    await flush();
    expect(saveButton.classList.contains("mod-loading")).toBe(false);
    expect(saveButton.disabled).toBe(false);
  });

  it("keeps the modal open when the submit fails", async () => {
    trackButtons();
    buttonInstances.length = 0;
    const { closeSpy } = buildModal({
      submit: async () => ({ ok: false, message: "boom" }),
    });
    fillFields({
      url: "https://nas.example.com/webdav",
      username: "alice",
      password: "app-password",
    });
    buttonInstances[1].buttonEl.__click?.();
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("closes on success", async () => {
    trackButtons();
    buttonInstances.length = 0;
    const { closeSpy } = buildModal();
    fillFields({
      url: "https://nas.example.com/webdav",
      username: "alice",
      password: "app-password",
    });
    buttonInstances[1].buttonEl.__click?.();
    await flush();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("passes an empty password through when one is already saved", async () => {
    trackButtons();
    buttonInstances.length = 0;
    const submit = vi.fn(async () => ({ ok: true as const }));
    const { modal } = buildModal({
      submit,
      hasSavedPassword: true,
      coordinates: {
        url: "https://nas.example.com/webdav",
        username: "alice",
        rootPrefix: "EasySync",
      },
    });
    void modal;
    buttonInstances[1].buttonEl.__click?.();
    await flush();
    expect(submit).toHaveBeenCalledWith({
      url: "https://nas.example.com/webdav",
      username: "alice",
      rootPrefix: "EasySync",
      password: "",
    });
  });
});

/**
 * F4/S2＋A9：根路径默认值与字段提示（用户 2026-11-23 拍板）。
 *
 * 两条都是「别多此一举、也别自作主张」：
 * - 根路径只在**首次配置**时预填 `EasySync`，已保存的坐标一律原样带回；
 *   用户当初特意清空成集合根（空串）也是「已保存的值」，不能被默认值盖掉。
 * - 密码框的「留空表示保留已保存的密码。」长句删除，只留一个短占位
 *   「已保存」——它是「有密码在」的唯一线索，删干净会让用户以为要重填。
 */
describe("根路径默认值与字段提示（F4/S2＋A9）", () => {
  const FIELD_ORDER = [
    "urlField",
    "usernameField",
    "passwordField",
    "rootPrefixField",
  ] as const;

  /** 读四个字段的当前值（顺序与 `onOpen` 的构造顺序一致）。 */
  function fieldValues(modal: WebDavConfigModal): Record<string, string> {
    const out: Record<string, string> = {};
    FIELD_ORDER.forEach((key, index) => {
      out[key] = (modal as unknown as Record<string, { value: string }>)[key]
        .value;
    });
    return out;
  }

  it("首次配置（没有坐标）：根路径预填 EasySync", () => {
    const { modal } = buildModal({ coordinates: null });
    expect(fieldValues(modal).rootPrefixField).toBe("EasySync");
  });

  it("改配置（已有坐标）：原样带回保存过的根路径，不被默认值盖掉", () => {
    const { modal } = buildModal({
      coordinates: {
        url: "https://nas.example.com",
        username: "alice",
        rootPrefix: "Notes/Mirror",
      },
    });
    expect(fieldValues(modal).rootPrefixField).toBe("Notes/Mirror");
  });

  it("保存过空根路径（集合根）：仍然带回空串，不预填 EasySync", () => {
    // 这一条是「默认值」最容易伤人的地方：用户当初特意把根路径清空成集合
    // 根，若这里退回默认值，一次保存就会把同步根悄悄换到 EasySync 子目录。
    const { modal } = buildModal({
      coordinates: {
        url: "https://nas.example.com",
        username: "alice",
        rootPrefix: "",
      },
    });
    expect(fieldValues(modal).rootPrefixField).toBe("");
  });

  it("根路径被占用时：红框挂在该字段上，而不是只弹一个会消失的提示", async () => {
    // 用户 2026-11-23：「⑨这个输入框标红+红字的提醒报错机制非常好」。宿主
    // 1.13.0 起提供 `Setting.setErrorMessage`（本插件底线 1.13.4），所以它
    // 是原生能力而不是新样式。
    trackButtons();
    buttonInstances.length = 0;
    const submit = vi.fn(async () => ({
      ok: false as const,
      message: "这个文件夹已被另一个笔记库使用。请换一个文件夹。",
      rootPrefixError: "这个文件夹已被另一个笔记库使用。请换一个文件夹。",
    }));
    const { modal, closeSpy } = buildModal({
      submit,
      // 已保存密码：密码框留空＝保留，本地校验才会放行。
      hasSavedPassword: true,
      coordinates: { url: "https://nas.example.com", username: "alice", rootPrefix: "EasySync" },
    });
    buttonInstances[1].buttonEl.__click?.();
    await flush();
    // 弹窗不关：用户要能当场改根路径。
    expect(submit).toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    const row = (modal as unknown as { rootPrefixRow: { errorEl: unknown } })
      .rootPrefixRow;
    expect(row.errorEl).not.toBeNull();
  });

  it("普通失败不挂字段级错误态（只有说得出「字段本身有问题」时才挂）", async () => {
    trackButtons();
    buttonInstances.length = 0;
    const submit = vi.fn(async () => ({
      ok: false as const,
      message: "连接失败：认证被拒绝",
    }));
    const { modal } = buildModal({
      submit,
      // 已保存密码：密码框留空＝保留，本地校验才会放行。
      hasSavedPassword: true,
      coordinates: { url: "https://nas.example.com", username: "alice", rootPrefix: "EasySync" },
    });
    buttonInstances[1].buttonEl.__click?.();
    await flush();
    const row = (modal as unknown as { rootPrefixRow: { errorEl: unknown } })
      .rootPrefixRow;
    expect(row.errorEl).toBeNull();
  });
  it("密码框提示只剩短占位「已保存」，没有「留空表示…」长句", () => {
    const { modal } = buildModal({ hasSavedPassword: true });
    const placeholder = (
      modal as unknown as { passwordPlaceholder?: string }
    ).passwordPlaceholder;
    // 占位符由 `addTextRow` 内部消费；这里直接钉 i18n 的值，避免把「长句」
    // 的判定押在 mock 是否实现 setPlaceholder 上。
    const zh = readFileSync("src/i18n/zh-cn.ts", "utf8");
    expect(zh).not.toContain("留空表示");
    expect(zh).toContain('"settings.webdav.password.keep": "已保存"');
    void placeholder;
  });
});

/**
 * 手机软键盘与弹窗形状（2026-11-22 用户第三次纠正后整体重做）。
 *
 * 三条硬要求，都钉在这里：
 * 1) 弹窗只是普通弹窗——不撑满屏宽；
 * 2) 弹窗**无论如何都不动**——不许有容器让位、卡片限高、sticky；
 * 3) 底部余量按「聚焦字段实际被盖住多少」算，不用固定值、不补满整个键盘。
 *
 * Node 环境没有布局引擎，真实几何靠真宿主测量；这里钉接法与禁止项。
 */
describe("WebDavConfigModal keyboard and shape", () => {
  const readSource = (rel: string): string =>
    readFileSync(path.join(__dirname, "..", rel), "utf8");

  it("measures the focused field's actual overlap instead of a fixed height", () => {
    const source = readSource("src/ui/easy-sync-modal.ts");
    const body = functionBody(source, "export function bindModalKeyboardInset");
    // 只写滚动段自己的自定义属性（具体盒模型样式留在 styles.css 里——lint 也不许
    // TS 直写 style.padding*），不碰卡片任何几何。
    expect(body).toContain('--easy-sync-keyboard-inset');
    expect(body).not.toContain("modalEl.style");
    expect(body).not.toContain("containerEl.style");
    // 几何口径：可见区下沿按宿主键盘行为分型取信号——悬浮型（iOS Obsidian 实测
    // 视口与 visualViewport 都不动）必须读宿主 `--keyboard-height`，压矮型
    // 用视口底沿且不许再减键盘高度（「视口高−键盘高」在压矮型上是双算，
    // 2026-11-22 真机：没被盖住的框也出空白）。
    expect(body).toContain("--keyboard-height");
    expect(body).toContain("noKeyboardInnerHeight");
    expect(body).toContain("visualViewport");
    expect(body).toContain("doc.activeElement");
    expect(body).toContain("visibleBottom");
    // 被盖住时自己把框滚上去，不等浏览器聚焦滚动——它在补空间前就跑完了
    // （2026-11-22 真机：最后一行整行被盖）；落点留呼吸位不贴边
    // （2026-11-22 真机第三轮用户复核）。
    expect(body).toContain("scrollTop");
    expect(body).toContain("KEYBOARD_INSET_BREATH_PX");
    // 悬浮型键盘动画没有任何事件可听（视口不动、变量不是事件源），聚焦
    // 期间必须逐帧盯表；不盯表则真机聚焦后完全不避让（2026-11-22 第二轮）。
    expect(body).toContain("requestAnimationFrame(tick)");
    // 键盘收起（可视区回升）要退回自然区，不留残留。
    expect(body).toContain("previousVisibleBottom");
    // 只在手机端生效。
    expect(body).toContain("hostPlatformFacts.isMobile");
  });

  it("backs the inset with a non-flow anchor so the card can never move", () => {
    // 余量若写成 padding-bottom 会参与文档流：内容驱动高度的卡片被顶高，
    // 聚焦时整卡轻微位移（2026-11-22 真机实测）。锚必须是绝对定位 ::after，
    // 只扩大「能滚多远」。`.easy-sync-keyboard-tail`（整键盘高度补白的旧
    // 共享类）已随重做退场，不许回魂。
    const styles = readSource("styles.css");
    expect(styles).not.toContain("easy-sync-keyboard-tail");
    const inset = styles.match(/\.easy-sync-keyboard-inset\s*\{([^}]*)\}/su)?.[1] ?? "";
    expect(inset).toContain("position: relative");
    expect(inset).not.toMatch(/padding/u);
    const anchor = styles.match(/\.easy-sync-keyboard-inset::after\s*\{([^}]*)\}/su)?.[1] ?? "";
    expect(anchor).toMatch(/position:\s*absolute/u);
    expect(anchor).toMatch(/height:\s*var\(--easy-sync-keyboard-inset/u);
  });

  it("is wired into the WebDAV config modal and disposed with it", () => {
    const modalSource = readSource("src/ui/webdav-config-modal.ts");
    // 签名只收滚动段：弹窗实例不参与判定（平台门看宿主平台事实，滚动范围看
    // 传入元素的盒模型），2026-11-22 review 去掉了空转的 `modal` 参数。
    expect(modalSource).toMatch(/bindModalKeyboardInset\(formEl\)/u);
    expect(modalSource).toContain("bindModalKeyboardInset,");
    expect(modalSource).toContain("keyboardInsetDispose?.()");
  });

  it("the modal card never moves for the keyboard", () => {
    // 前两版错误做法的禁用项：容器让位、卡片限高、sticky 底栏。
    const styles = readSource("styles.css");
    expect(styles).not.toMatch(/is-keyboard-avoid/u);
    expect(styles).not.toMatch(
      /body\.is-mobile \.easy-sync-modal-container[^{]*\{[^}]*var\(--keyboard-height/su,
    );
    expect(styles).not.toMatch(
      /body\.is-mobile \.easy-sync-webdav-config-modal[^{]*\{[^}]*var\(--keyboard-height/su,
    );
    const stylesForFooter = styles.match(
      /\.easy-sync-webdav-config-actions[^{]*\{([^}]*)\}/su,
    )?.[1] ?? "";
    expect(stylesForFooter).not.toMatch(/position:\s*(sticky|absolute|fixed)/u);
  });

  it("shrinks the phone card to a normal dialog instead of full width", () => {
    // 宿主手机端把 .modal 设成 --dialog-width: 100vw（通栏）。我们显式收回。
    const styles = readSource("styles.css");
    const cardWidth = styles.match(
      /body\.is-mobile \.modal\.easy-sync-webdav-config-modal\s*\{([^}]*)\}/su,
    )?.[1] ?? "";
    expect(cardWidth).toMatch(/width:\s*min\(/u);
    expect(cardWidth).not.toContain("100vw;");
  });

  it("keeps the host content padding instead of swallowing it", () => {
    // 曾写 `padding-inline: 2px`，把宿主的 16px 内衬整条盖掉，内容贴屏幕边。
    const styles = readSource("styles.css");
    const content = styles.match(
      /\.easy-sync-webdav-config-modal \.modal-content\s*\{([^}]*)\}/su,
    )?.[1] ?? "";
    expect(content).toMatch(/padding-inline:\s*var\(--size-4-4\)/u);
    expect(content).not.toContain("--input-border-width-focus");
    // 真裁切发生在表单滚动段（overflow 按 padding box 裁）：环宽内衬必须挂在
    // 那一层——2026-11-21 的修复挂在 .modal-content 上，重做把滚动面下移到
    // 表单段后没跟着搬，真机上环的左右两缘被裁（2026-11-22 用户报）。
    const form = styles.match(/\.easy-sync-webdav-config-form\s*\{([^}]*)\}/su)?.[1] ?? "";
    expect(form).toMatch(/padding-inline:\s*var\(--input-border-width-focus/u);
    // 上下两缘：首行／末行的输入框贴着滚动段顶／底边，环的竖向两缘同样
    // 会被裁（2026-11-23 用户截图），四边都按环宽留。
    expect(form).toMatch(/padding-block:\s*var\(--input-border-width-focus/u);
    // 键盘余量由共享锚承担；本规则不得再写 padding-bottom（会顶高卡片），
    // padding-block 的 2px 常量内衬不在此列。
    expect(form).not.toMatch(/padding-bottom/u);
    expect(form).not.toContain("--easy-sync-tail-pad");
  });

  it("lays the phone footer buttons out in one row (2026-11-22 用户拍板)", () => {
    // 竖排把保存／取消叠成两行，长表单里费高度又看着眼花（用户手机目测）。
    // 写法照 Resojot 服务商壳三件套（2026-11-06 同款）：容器改回 row 并占满
    // 动作段整行（动作段自身是 row flex，不补 `flex: 1 1 auto` 底栏会被收成
    // 内容宽，实测 148px／段宽 414px）、按钮同行等宽、取消的竖排 margin-top
    // 归零。范围钉在本弹窗动作段——其它弹框维持宿主竖排，不受本条影响。
    const styles = readSource("styles.css");
    const scope = ".easy-sync-webdav-config-actions .easy-sync-modal-footer";
    const row = styles.match(
      new RegExp(`body\\.is-phone ${scope.replace(/\./g, "\\.")}[^{]*\\{([^}]*)\\}`, "su"),
    )?.[1] ?? "";
    expect(row).toMatch(/flex:\s*1 1 auto/u);
    expect(row).toMatch(/flex-direction:\s*row/u);
    expect(row).toMatch(/align-items:\s*center/u);
    const button = styles.match(
      new RegExp(`body\\.is-phone ${scope.replace(/\./g, "\\.")} button[^{]*\\{([^}]*)\\}`, "su"),
    )?.[1] ?? "";
    expect(button).toMatch(/flex:\s*1 1 0/u);
    expect(button).toMatch(/width:\s*auto/u);
    expect(button).toMatch(/min-width:\s*0/u);
    const cancel = styles.match(
      new RegExp(
        `body\\.is-phone ${scope.replace(/\./g, "\\.")} button\\.mod-cancel[^{]*\\{([^}]*)\\}`,
        "su",
      ),
    )?.[1] ?? "";
    expect(cancel).toMatch(/margin-top:\s*0/u);
    // 抵消竖排的规则必须成组存在：is-mobile 同效，不能只写 phone 一半。
    expect(styles).toMatch(
      new RegExp(`body\\.is-mobile ${scope.replace(/\./g, "\\.")}[^{]*\\{[^}]*flex-direction:\\s*row`, "su"),
    );
  });

  it("keeps the two-section skeleton so the footer can never cover a field", () => {
    // 2026-11-21 用户手机截图：底栏浮在字段上方盖住「根路径」。
    // 根因是底栏被放进滚动区再用 sticky 浮起来。正确形状是 Resojot 的两段式：
    // 表单段自己滚，动作段是它的兄弟、在滚动区外面。
    const modalSource = readSource("src/ui/webdav-config-modal.ts");
    expect(modalSource).toContain('createDiv("easy-sync-webdav-config-form")');
    expect(modalSource).toContain('createDiv("easy-sync-webdav-config-actions")');
    // 四个字段一律进表单段，不能有任何一行漏在滚动区外或落回 contentEl。
    for (const field of ["urlField", "usernameField", "passwordField", "rootPrefixField"]) {
      expect(modalSource).toMatch(
        new RegExp(`this\\.${field} = this\\.addTextRow\\(\\s*formEl,`, "u"),
      );
    }
    // 底栏挂在动作段上，不是 contentEl、也不是表单段。
    expect(modalSource).toMatch(/createEasySyncModalFooter\(actionsEl\)/u);

    // CSS 侧：底栏绝不能是 sticky / absolute —— 那就是「盖住字段」的成因。
    const styles = readSource("styles.css");
    const footerRule = styles.match(
      /\.easy-sync-webdav-config-actions[^{]*\{([^}]*)\}/su,
    )?.[1] ?? "";
    expect(footerRule).not.toMatch(/position:\s*(sticky|absolute|fixed)/u);
    expect(styles).not.toMatch(
      /\.easy-sync-webdav-config-modal[^{]*\.easy-sync-modal-footer\s*\{[^}]*position:\s*(sticky|absolute|fixed)/su,
    );
  });

});
