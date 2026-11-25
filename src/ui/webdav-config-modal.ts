/**
 * WebDAV 配置弹窗（C2）。
 *
 * 形状照 Resojot 服务商弹窗：标题＋四个字段＋底部「取消／保存」。没有说明段、
 * 没有字段解释、没有「测试连接」按钮——保存即测试（用户 2026-11-20 批注）。
 *
 * 交互合同：
 * - 保存：先校验坐标，再写凭据（SecretStorage），然后做一次连接测试；
 *   测试通过才落 `lastTest.ok`，失败写 `lastTest.ok=false` 并把原因用
 *   host `Notice` 说出来（弹窗保持原状、不关闭）。进行中按钮走宿主
 *   `mod-loading`（文字隐去＋转圈），不写「正在测试…」这类专门文字。
 * - 取消／Esc／点外部：直接关闭，不保存任何输入（没有「即改即生效」）。
 * - 已保存密码时密码框留空＝保留旧密码；填了新密码＝轮换（先递增凭据版本，
 *   让旧测试结果立即失效，再写 SecretStorage）。
 *
 * 弹窗不直接碰 `main.ts` 的设置状态：所有落盘与测试都通过注入的
 * `submit` 回调，便于单测与后续接线复用同一份界面。
 */
import {
  Notice,
  Setting,
  type App,
  type TextComponent,
} from "obsidian";
import {
  addEasySyncFooterButton,
  bindModalKeyboardInset,
  bindModalKeyboardDismissal,
  createEasySyncModalFooter,
  EasySyncModal,
  keepModalFocusOnBody,
} from "./easy-sync-modal";
import {
  validateWebDavCoordinates,
  type WebDavCloudCoordinatesV1,
} from "../cloud/cloud-settings";

type I18nTranslate = (key: string, params?: Record<string, string | number>) => string;

/**
 * 首次配置时预填的根路径（用户 2026-11-23 拍板）。
 *
 * 不是界面文案而是**远端目录名**：它同时是 EasySync 认领这块远端的地址，
 * 所以刻意用产品名而非中文词——换语言不该让同步根改名。用户可清空或改写。
 */
const WEBDAV_DEFAULT_ROOT_PREFIX = "EasySync";

/** 提交结果：界面只关心「成功关闭／失败留窗并说原因」。 */
type WebDavConfigSubmitResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    /** 已本地化的一句话；界面用 Notice 呈现，不在弹窗里加错误行。 */
    readonly message: string;
    /**
     * 可选：这句话属于「根路径」字段本身（例如这个文件夹已经被占用）。
     *
     * 给了它就挂到该行的宿主原生错误态（`Setting.setErrorMessage`，1.13.0
     * 起提供、本插件底线 1.13.4）——标红那一行＋下方红字，而不是弹一个会
     * 消失的 Notice。没给就是普通失败，仍走 Notice。
     */
    readonly rootPrefixError?: string;
    /**
     * 可选：这次失败不用弹 Notice（调用方已经用别的载体说清了原因）。
     *
     * 两个用途：切换确认被取消（用户主动放弃，不需要报错）；守卫拦下
     * （调用方已经弹了「正在同步／有待处理」那一条）。弹窗保持原状。
     */
    readonly silent?: boolean;
  };

/** 提交入参：用户在弹窗里填的原始值（未规范化）。 */
interface WebDavConfigDraft {
  readonly url: string;
  readonly username: string;
  readonly rootPrefix: string;
  /** 空串＝保留已保存的密码。 */
  readonly password: string;
}

interface WebDavConfigModalOptions {
  readonly app: App;
  readonly t: I18nTranslate;
  /** 已保存的坐标；没有则为空表单。 */
  readonly coordinates: WebDavCloudCoordinatesV1 | null;
  /** 本机是否已保存密码（只用于决定占位提示，不显示任何尾号）。 */
  readonly hasSavedPassword: boolean;
  /**
   * 保存并测试。实现方负责：校验通过后的凭据写入、连接测试与持久化；
   * 返回值只决定界面是关闭还是留窗。
   */
  readonly submit: (draft: WebDavConfigDraft) => Promise<WebDavConfigSubmitResult>;
}

export class WebDavConfigModal extends EasySyncModal<boolean> {
  private readonly options: WebDavConfigModalOptions;
  private urlField: TextComponent | null = null;
  private usernameField: TextComponent | null = null;
  private passwordField: TextComponent | null = null;
  private rootPrefixField: TextComponent | null = null;
  /** 根路径那一行的 Setting：宿主原生错误态挂在行上（标红＋下方红字）。 */
  private rootPrefixRow: Setting | null = null;
  private saveButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private submitting = false;

  constructor(options: WebDavConfigModalOptions) {
    super(options.app);
    this.options = options;
  }

  /** 打开并等待：true＝保存成功，false＝取消／关闭。 */
  openAndWait(): Promise<boolean> {
    return this.awaitResult();
  }

  onOpen(): void {
    const { contentEl } = this;
    const { t } = this.options;
    contentEl.empty();
    this.modalEl.addClass("easy-sync-webdav-config-modal");
    this.titleEl.setText(t("settings.webdav.config.title"));

    // 两段式骨架（照 Resojot 服务商弹窗）：表单段自己滚动，动作段是它的
    // **兄弟**、在滚动区外面。底栏绝不能放进滚动区再用 sticky 浮起来——
    // 键盘一弹底栏就盖住最后一行，字段还会从它底下滑过去（2026-11-21
    // 用户手机截图）。
    const formEl = contentEl.createDiv("easy-sync-webdav-config-form");

    // 裸 Setting 行直接铺在表单段：与宿主自家弹窗（删除确认／授权）同形，
    // 透明底＋行间细分线；不再包 SettingGroup（那会给整块铺底色）。
    const coordinates = this.options.coordinates;
    this.urlField = this.addTextRow(
      formEl,
      t("settings.webdav.url.name"),
      coordinates?.url ?? "",
      (input) => {
        input.type = "text";
        input.inputMode = "url";
        input.autocapitalize = "off";
        input.spellcheck = false;
      },
    );
    this.usernameField = this.addTextRow(
      formEl,
      t("settings.webdav.username.name"),
      coordinates?.username ?? "",
      (input) => {
        input.type = "text";
        input.autocapitalize = "off";
        input.spellcheck = false;
      },
    );
    this.passwordField = this.addTextRow(
      formEl,
      t("settings.webdav.password.name"),
      "",
      (input) => {
        input.type = "password";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.autocapitalize = "off";
      },
      this.options.hasSavedPassword
        ? t("settings.webdav.password.keep")
        : undefined,
    );
    this.rootPrefixField = this.addTextRow(
      formEl,
      t("settings.webdav.rootPrefix.name"),
      // A6（用户 2026-11-23「可以默认一个目录吗？然后用户可以自己改。比如
      // 默认创建一个名为 EasySync 的目录？」）：**只在首次配置时**预填。
      // 已保存过的坐标一律原样带回——连「用户当初特意清空成集合根」也算数，
      // 用 `??` 而不是 `||` 就是为了区分「没有坐标」和「根路径是空串」。
      coordinates === null
        ? WEBDAV_DEFAULT_ROOT_PREFIX
        : coordinates.rootPrefix,
      (input) => {
        input.type = "text";
        input.autocapitalize = "off";
        input.spellcheck = false;
        // 用户一动手就撤掉上一次的错误态：红框是对这一份输入的判断，
        // 不是对上一次点击的记账。
        input.addEventListener("input", () => {
          this.rootPrefixRow?.setErrorMessage(null);
        });
      },
      undefined,
      (row) => {
        this.rootPrefixRow = row;
      },
    );

    // 动作段在滚动区外面：它占自己的高度，卡片再矮也不会盖住字段。
    const actionsEl = contentEl.createDiv("easy-sync-webdav-config-actions");
    const footer = createEasySyncModalFooter(actionsEl);
    const cancel = addEasySyncFooterButton(footer, {
      label: t("settings.cloudConfig.cancel"),
      onClick: () => {
        if (this.submitting) return;
        this.settle(false);
      },
    });
    this.cancelButton = cancel.buttonEl;
    const save = addEasySyncFooterButton(footer, {
      label: t("settings.cloudConfig.save"),
      variant: "cta",
      onClick: () => {
        void this.handleSave();
      },
    });
    this.saveButton = save.buttonEl;

    // 焦点收回弹窗本体：宿主会把 3px focus-visible ring 落在第一个控件上，
    // 视觉上像「已经在编辑地址」。
    keepModalFocusOnBody(this);
    // 手机软键盘：按「聚焦字段实际被盖住多少」给表单滚动段补滚动余量。
    // 弹窗本身位置与尺寸始终不动（2026-11-22 用户要求）。
    this.keyboardInsetDispose = bindModalKeyboardInset(formEl);
    this.keyboardDispose = bindModalKeyboardDismissal(this);
  }

  onClose(): void {
    this.keyboardDispose?.();
    this.keyboardDispose = null;
    this.keyboardInsetDispose?.();
    this.keyboardInsetDispose = null;
    this.contentEl.empty();
  }

  private keyboardDispose: (() => void) | null = null;
  private keyboardInsetDispose: (() => void) | null = null;

  private addTextRow(
    container: HTMLElement,
    name: string,
    value: string,
    configure: (input: HTMLInputElement) => void,
    placeholder?: string,
    /** 拿到这一行的 （宿主错误态只能用行对象设置）。 */
    captureRow?: (row: Setting) => void,
  ): TextComponent {
    let created: TextComponent | null = null;
    const row = new Setting(container);
    captureRow?.(row);
    row
      .setName(name)
      .addText((text) => {
        created = text;
        configure(text.inputEl);
        if (placeholder) text.setPlaceholder(placeholder);
        text.setValue(value);
        // 提交时才读取；输入过程不落盘、不校验。
        text.onChange(() => undefined);
      });
    return created as unknown as TextComponent;
  }

  /** 保存：校验 → 提交 → 成功关闭／失败留窗并说原因。 */
  private async handleSave(): Promise<void> {
    if (this.submitting) return;
    const { t, submit } = this.options;
    const draft: WebDavConfigDraft = {
      url: this.urlField?.getValue?.() ?? "",
      username: this.usernameField?.getValue?.() ?? "",
      rootPrefix: this.rootPrefixField?.getValue?.() ?? "",
      password: this.passwordField?.getValue?.() ?? "",
    };
    // 上一次的错误态属于上一次的输入，这次点击重新判断。
    this.rootPrefixRow?.setErrorMessage(null);
    const requiredProblem = this.validateDraft(draft);
    if (requiredProblem) {
      new Notice(requiredProblem, 6000);
      return;
    }

    this.setSubmitting(true);
    try {
      const result = await submit(draft);
      if (result.ok) {
        new Notice(t("settings.cloudConfig.saved"), 4000);
        this.settle(true);
        return;
      }
      if (result.rootPrefixError) {
        // 这个文件夹的问题挂在该字段上：标红那一行＋下方红字（用户 2026-11-23
        // 说这个机制「非常好，可以作为 UI 储备」）。宿主原生能力，不新增样式。
        this.rootPrefixRow?.setErrorMessage(result.rootPrefixError);
      }
      // 失败：配置不落盘、弹窗保持原状。字段级的话已经挂在行上，不再弹
      // 一个会自己消失的 Notice 重复一遍；标记了 silent 的失败由调用方
      // 自己解释（取消切换／守卫拦下），这里一个字都不说。
      if (!result.silent) new Notice(result.message, 8000);
    } catch {
      new Notice(t("settings.cloudConfig.saveFailed"), 8000);
    } finally {
      this.setSubmitting(false);
    }
  }

  /** 本地前置校验：不完整或不合法就不提交、不发请求。 */
  private validateDraft(draft: WebDavConfigDraft): string | null {
    const { t } = this.options;
    const validated = validateWebDavCoordinates({
      url: draft.url,
      username: draft.username,
      rootPrefix: draft.rootPrefix,
    });
    if (validated.error === "urlInvalid") return t("settings.cloudConfig.urlInvalid");
    if (validated.error === "usernameInvalid") {
      return t("settings.cloudConfig.usernameInvalid");
    }
    if (validated.error === "rootPrefixInvalid") {
      return t("settings.cloudConfig.rootPrefixInvalid");
    }
    const needsPassword = draft.password.trim().length > 0
      || !this.options.hasSavedPassword;
    if (needsPassword && draft.password.length === 0) {
      return t("settings.cloudConfig.passwordRequired");
    }
    return null;
  }

  /**
   * 提交期间：整个表单与两个按钮都不可用，保存按钮挂宿主 `mod-loading`
   * （文字隐去＋居中转圈）。不改按钮文字——用户批注明确不要专门文案。
   */
  private setSubmitting(submitting: boolean): void {
    this.submitting = submitting;
    for (const field of [
      this.urlField,
      this.usernameField,
      this.passwordField,
      this.rootPrefixField,
    ]) {
      if (field) field.inputEl.disabled = submitting;
    }
    if (this.cancelButton) this.cancelButton.disabled = submitting;
    if (this.saveButton) {
      this.saveButton.disabled = submitting;
      this.saveButton.toggleClass("mod-loading", submitting);
    }
  }
}
