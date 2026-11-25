/**
 * Shared drawer/backdrop for every EasySync Modal.
 *
 * Obsidian's host dims the `.modal-bg` via `--background-modifier-cover`,
 * which it deliberately relaxes on touch devices (0.15 light / 0.35 dark
 * vs. 0.4 on desktop) and applies no blur. On phones the vault stays fully
 * legible behind the dialog, so dialog content and background compete. This
 * base class tags each modal container so the stylesheet can give EasySync
 * dialogs a gentle blur (6px) on top of the host's own plain cover color —
 * no extra darkening, no saturate / brightness (see styles.css
 * "EasySync Modal backdrop"). Android WebViews without `backdrop-filter`
 * keep the host's plain cover, same as the pre-change look.
 *
 * Marker only on the container itself; the shared option-row builder for
 * chooser modals (login methods, migration offer) also lives here.
 *
 * This base also owns the promise settle protocol for "open and wait"
 * modals: `awaitResult()` registers the resolver and opens the modal,
 * `settle()` is the single settle point (take resolver, null it, close,
 * resolve once), and `onClose` uses `takePendingResolve()` to resolve the
 * cancel value only when no real choice was made.
 */
import {
  ButtonComponent,
  Modal,
  setIcon,
  type App,
} from "obsidian";
import { hostPlatformFacts } from "../obsidian-compat";
import { applyDestructiveButton } from "./destructive-button";

/** One selectable row for chooser modals (login methods, migration offer). */
interface EasySyncModalOptionView {
  title: string;
  description: string;
}

export abstract class EasySyncModal<TResult = void> extends Modal {
  private pendingResolve: ((value: TResult) => void) | null = null;

  constructor(app: App) {
    super(app);
    this.containerEl.addClass("easy-sync-modal-container");
  }

  /** Register the awaiting promise's resolver and open the modal. */
  protected awaitResult(): Promise<TResult> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.open();
    });
  }

  /**
   * Single settle point for "open and wait" modals: take the pending
   * resolver, null it, close, then resolve once. Nulling before `close()`
   * matters because the host may run `onClose()` synchronously from
   * `close()`; the cancel path then finds no resolver and cannot steal a
   * real choice ("close == cancel" only when nothing was chosen).
   */
  protected settle(result: TResult): void {
    const resolve = this.takePendingResolve();
    this.close();
    resolve?.(result);
  }

  /** Take and clear the pending resolver (cancel path, called from onClose). */
  protected takePendingResolve(): ((value: TResult) => void) | null {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    return resolve;
  }

  /**
   * Single-instance gate (shared 2026-10-30, extracted from the recovery
   * modal's static pattern): call from `open()` before `super.open()` with a
   * stable target key. An identical target already open → the new open is
   * rejected. What happens on a *different* target is the caller's call:
   * detail-family modals pass `replace: true` (close the old, open the new),
   * flows that legitimately stack two instances of the class (scope →
   * manager) keep the default coexist mode. Release from `onClose()` via
   * `releaseSingleInstance()`.
   */
  protected takeOverSingleInstance(
    key: unknown,
    options: { replace?: boolean } = {},
  ): boolean {
    const ctor = this.constructor as unknown as object;
    const slot = options.replace === true ? "" : `:${String(key)}`;
    let slots = activeSingleInstances.get(ctor);
    if (slots === undefined) {
      slots = new Map();
      activeSingleInstances.set(ctor, slots);
    }
    const active = slots.get(slot);
    if (active !== undefined && active.modal !== this) {
      if (active.key === key) return false;
      if (options.replace === true) active.modal.close();
    }
    slots.set(slot, { modal: this as EasySyncModal<unknown>, key });
    return true;
  }

  /** Clear this instance from the single-instance registry (onClose backstop). */
  protected releaseSingleInstance(): void {
    const ctor = this.constructor as unknown as object;
    const slots = activeSingleInstances.get(ctor);
    if (slots === undefined) return;
    for (const [slot, active] of slots) {
      if (active.modal === this) slots.delete(slot);
    }
  }

  /** Shared option-row button for chooser modals. Visual classes are the
   *  auth-method modal's house pattern (extracted 2026-10-01 so the Remotely
   *  Save migration offer reuses them without a second copy). */
  protected buildOptionButton(
    option: EasySyncModalOptionView,
  ): HTMLButtonElement {
    const button = this.contentEl.createEl("button", {
      cls: "easy-sync-auth-method-option",
      type: "button",
    });
    const body = button.createDiv({ cls: "easy-sync-auth-method-body" });
    body.createDiv({
      text: option.title,
      cls: "easy-sync-auth-method-title",
    });
    body.createDiv({
      text: option.description,
      cls: "easy-sync-auth-method-desc",
    });
    const chevron = button.createSpan({
      cls: "easy-sync-auth-method-chevron",
    });
    setIcon(chevron, "chevron-right");
    return button;
  }
}

/** Registry behind `takeOverSingleInstance`, keyed by modal constructor.
 *  Each constructor holds a slot map: replace-mode uses the single "" slot,
 *  coexist-mode uses one ":<key>" slot per target. */
const activeSingleInstances = new WeakMap<
  object,
  Map<string, { modal: EasySyncModal<unknown>; key: unknown }>
>();

/**
 * Shared modal footer (2026-10-30 弹框共享件合同): the container is the host
 * `.modal-button-container` so alignment, mobile stacking (`column-reverse`
 * putting the primary action on top) and safe-area handling stay host-owned.
 * The plugin adds only the top margin, an optional divider (`divided` — keep
 * it only when interactive content sits above the buttons) and the fixed
 * action-bar variant (`fixed` — the content-detail family's footer under a
 * scrolling body).
 */
export function createEasySyncModalFooter(
  parentEl: HTMLElement,
  options: { divided?: boolean; fixed?: boolean } = {},
): HTMLDivElement {
  const classes = ["modal-button-container", "easy-sync-modal-footer"];
  if (options.divided) classes.push("is-divided");
  if (options.fixed) classes.push("is-fixed");
  return parentEl.createDiv(classes.join(" "));
}

type EasySyncFooterButtonVariant = "cta" | "destructive" | "plain" | "link";

interface EasySyncFooterButtonOptions {
  label: string;
  /** Defaults to "plain". Every non-CTA variant carries the host
   *  `mod-cancel` class (phone-only spacing, zero effect on desktop). */
  variant?: EasySyncFooterButtonVariant;
  /** Extra visual class on the button element (local/remote tinted actions). */
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * One footer button. DOM order contract: secondary actions first, primary
 * (CTA) last — the host's mobile `column-reverse` then shows the primary on
 * top and the cancel at the bottom. Destructive styling always goes through
 * `applyDestructiveButton` (never the deprecated API or a bare class).
 */
export function addEasySyncFooterButton(
  parentEl: HTMLElement,
  options: EasySyncFooterButtonOptions,
): ButtonComponent {
  const variant = options.variant ?? "plain";
  const button = new ButtonComponent(parentEl).setButtonText(options.label);
  if (variant === "cta") button.setCta();
  else if (variant === "destructive") applyDestructiveButton(button);
  else if (variant === "link") button.setClass("mod-link");
  else button.setClass("mod-cancel");
  if (options.className) button.buttonEl.addClass(options.className);
  if (options.disabled === true) button.setDisabled(true);
  button.onClick(options.onClick);
  return button;
}

/**
 * Pull focus back onto the modal body right after open (microtask, before
 * first paint): 1.13+ puts a 3px `:focus-visible` ring on the first
 * focusable control — with a select/input that reads as "already editing".
 * `tabindex="-1"` keeps the body out of the host's first-focusable query and
 * Tab still starts at the first control.
 */
export function keepModalFocusOnBody(modal: Modal): void {
  modal.contentEl.setAttribute("tabindex", "-1");
  queueMicrotask(() => {
    modal.contentEl.focus({ preventScroll: true });
  });
}

const INTERACTIVE_TAG_NAMES = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "LABEL",
  "OPTION",
  "SELECT",
  "SUMMARY",
  "TEXTAREA",
]);

function isEditableField(element: Element): element is HTMLElement {
  const tagName = element.tagName.toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA") return true;
  const contentEditable = element.getAttribute("contenteditable");
  return contentEditable !== null && contentEditable !== "false";
}

function isInteractiveTarget(target: EventTarget | null, boundary: HTMLElement): boolean {
  let element = target as HTMLElement | null;
  while (element) {
    if (INTERACTIVE_TAG_NAMES.has(element.tagName?.toUpperCase() ?? "")) return true;
    const role = (element.getAttribute?.("role") ?? "").toLowerCase();
    if (role === "button" || role === "switch" || role === "link") return true;
    if (element === boundary) return false;
    element = element.parentElement;
  }
  return false;
}

/**
 * Phone-only: tapping a non-interactive part of the modal releases the
 * focused field so the OS keyboard can close. Returns a disposer.
 */
export function bindModalKeyboardDismissal(modal: Modal): () => void {
  if (!hostPlatformFacts.isMobile) return () => undefined;
  const root = modal.contentEl;
  const releaseFocusedField = (event: MouseEvent): void => {
    const activeElement = root.ownerDocument?.activeElement
      ?? document.activeElement;
    if (
      !activeElement
      || !isEditableField(activeElement)
      || isInteractiveTarget(event.target, root)
    ) {
      return;
    }
    activeElement.blur();
  };
  root.addEventListener("click", releaseFocusedField);
  return () => root.removeEventListener("click", releaseFocusedField);
}

/**
 * 手机软键盘：只把**被盖住的聚焦输入框**滚到可视区下沿，其余一概不动。
 *
 * 用户 2026-11-22 真机反馈并逐条落实：
 * - **点没被盖住的框，弹窗纹丝不动、不留空白**：让位量按「聚焦框底边超出
 *   可视区下沿多少」实测，超出为零就什么都不写、什么都不滚。
 * - **点被盖住的框（通常是最后一行），框底落在键盘上沿上方一个呼吸位**
 *   （8px，不贴边——2026-11-22 真机第三轮用户复核后加）：滚动空间由
 *   `--easy-sync-keyboard-inset` 锚（styles.css 的 `::after`）补出后，**由
 *   这里自己把框滚上去**——浏览器自己的聚焦滚动在空间补出之前就已跑完，
 *   补完再等等于永远等不到（真机最后一行整行被盖）。
 * - **卡片位置与高度始终不变**：锚是绝对定位、不参与文档流，只扩大「能滚
 *   多远」；收起归零也不引起可见位移。
 *
 * **可见区下沿＝三种宿主键盘行为里最保守的一条**（2026-11-22 真机两轮定论）：
 * - **悬浮型**（iOS Obsidian 实测：视口高度与 visualViewport 都**不动**，
 *   宿主只写 `--keyboard-height`；第二版只靠可视区变化判断，在真机上完全
 *   读不到键盘、聚焦后纹丝不动）：上沿＝无键盘视口底 − 宿主键盘高度；
 * - **压矮型**（Android resize）：视口底就是键盘上沿，不再减键盘高度
 *   （「视口高 − 键盘高」在这型上是双算，是空白与位移的来源）；
 * - **可视区收缩型**（Safari 系）：visualViewport 自己报的下沿。
 *
 * 悬浮型的键盘动画**没有任何事件可听**（视口不动、变量不是事件源），所以
 * 聚焦期间逐帧盯 `--keyboard-height`，收起后停表；压矮/收缩型有事件，事件
 * 只负责立即重算与启动盯表。键盘收起把滚动退回自然区、锚归零。
 * 只在手机端生效；桌面端不挂类、不监听。
 */
export function bindModalKeyboardInset(
  scrollEl: HTMLElement,
  options: { fieldsSelector?: string } = {},
): () => void {
  if (!hostPlatformFacts.isMobile) return () => undefined;
  scrollEl.addClass("easy-sync-keyboard-inset");
  const doc = scrollEl.ownerDocument ?? document;
  const win = doc.defaultView;
  if (!win) return () => undefined;
  const fieldSelector = options.fieldsSelector ?? "input, textarea";

  /**
   * 宿主写入的键盘高度（px）；取不到按 0。悬浮型宿主（iOS Obsidian 实测）
   * 只有它知道键盘上沿——视口高度与 visualViewport 都不变。
   */
  const readKeyboardHeight = (): number => {
    const raw = win.getComputedStyle(doc.documentElement)
      .getPropertyValue("--keyboard-height")
      .trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  /** 键盘未开时的视口高：悬浮型拿它减键盘高度得键盘上沿；键盘收起的那帧
   *  重新锚定，转屏等引起的全高变化随之生效。 */
  let noKeyboardInnerHeight = win.innerHeight;

  /**
   * 可见区下沿（视口坐标）＝三种宿主行为里最保守的一条。
   * - 压矮型：当前视口底就是键盘上沿（**不再减键盘高度**——「视口高 − 键盘
   *   高」在这型上是双算，是空白与位移的来源）；
   * - 悬浮型：无键盘视口底 − 宿主键盘高度，与 visualViewport 报的下沿取低；
   * - 可视区收缩型：visualViewport 报的下沿。
   */
  const readVisibleBottom = (): number => {
    const innerHeight = win.innerHeight;
    const keyboardHeight = readKeyboardHeight();
    if (keyboardHeight <= 0) noKeyboardInnerHeight = innerHeight;
    if (innerHeight < noKeyboardInnerHeight - 0.5) return innerHeight;
    const viewport = win.visualViewport;
    const viewportBottom = viewport
      ? viewport.offsetTop + viewport.height
      : innerHeight;
    if (keyboardHeight > 0) {
      return Math.min(noKeyboardInnerHeight - keyboardHeight, viewportBottom);
    }
    return Math.min(viewportBottom, noKeyboardInnerHeight);
  };

  let applied = 0;
  let poll = 0;
  let previousVisibleBottom = Number.POSITIVE_INFINITY;
  let seenKeyboardHeight = -1;
  let pendingWrite = false;
  /** 被盖住的框滚到位后，框底与键盘上沿之间保留的呼吸位（px）。 */
  const KEYBOARD_INSET_BREATH_PX = 8;

  const writeInset = (): void => {
    const visibleBottom = readVisibleBottom();
    // 可见区下沿回升＝键盘正在收：把滚动退回自然区，锚随之归零。
    const closing = visibleBottom > previousVisibleBottom + 0.5;
    previousVisibleBottom = visibleBottom;

    const active = doc.activeElement;
    const field = active instanceof HTMLElement
      && scrollEl.contains(active)
      && active.matches(fieldSelector)
      ? active
      : null;

    // 不挂锚时的可滚上限；锚按「目标位置超出的那段」补，不超前补。
    const nativeMaxScroll = scrollEl.scrollHeight - applied - scrollEl.clientHeight;
    // 目标滚动位置：只为当前聚焦框前滚（框底落在可见区下沿上方一个呼吸位，
    // 不贴边——2026-11-22 真机第三轮用户复核「有点贴边，适当再上浮一点点」），
    // 从不回滚——除非键盘在收，那时退回自然区。没有聚焦框时保持原位。
    let target = scrollEl.scrollTop;
    if (closing) {
      target = Math.min(scrollEl.scrollTop, nativeMaxScroll);
    } else if (field) {
      const overlap = field.getBoundingClientRect().bottom - visibleBottom;
      if (overlap > 0) target = scrollEl.scrollTop + overlap + KEYBOARD_INSET_BREATH_PX;
    }

    const inset = Math.max(0, Math.ceil(target - nativeMaxScroll));
    if (inset !== applied) {
      applied = inset;
      // 只写自定义属性，锚的盒模型在 styles.css 的 `.easy-sync-keyboard-inset`
      // 规则里——TS 不直接写盒模型样式（主题与可维护性都归样式层）。
      scrollEl.style.setProperty("--easy-sync-keyboard-inset", `${inset}px`);
    }
    // 锚已就位，目标位置必在可滚范围内；与锚写入同帧执行，无中间态。
    if (target !== scrollEl.scrollTop) scrollEl.scrollTop = target;
  };

  /** 键盘是否开着：三条信号线（宿主变量／视口压矮／可视区收缩）任一生效。 */
  const keyboardOpen = (): boolean => {
    const viewport = win.visualViewport;
    const viewportBottom = viewport
      ? viewport.offsetTop + viewport.height
      : win.innerHeight;
    return seenKeyboardHeight > 0
      || win.innerHeight < noKeyboardInnerHeight - 0.5
      || viewportBottom < win.innerHeight - 0.5;
  };

  /**
   * 悬浮型宿主的键盘动画只改 `--keyboard-height`：视口与 visualViewport 都
   * 不动、变量也不是事件源——**没有任何事件可听**，聚焦期间逐帧盯表。
   * 高度没变的帧只读一个变量不做布局测量（打字期间零布局成本）；聚焦未
   * 释放或键盘仍开着都继续盯，两者皆否（键盘已收且无聚焦）才停表。
   */
  const tick = (): void => {
    poll = 0;
    const keyboardHeight = readKeyboardHeight();
    if (pendingWrite || keyboardHeight !== seenKeyboardHeight) {
      pendingWrite = false;
      seenKeyboardHeight = keyboardHeight;
      writeInset();
    }
    const active = doc.activeElement;
    const fieldFocused = active instanceof HTMLElement
      && scrollEl.contains(active)
      && active.matches(fieldSelector);
    if (fieldFocused || keyboardOpen()) poll = win.requestAnimationFrame(tick);
  };

  const schedule = (): void => {
    pendingWrite = true;
    if (poll === 0) poll = win.requestAnimationFrame(tick);
  };

  schedule();
  const viewport = win.visualViewport;
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  // 输入法候选条出现/收起会改变键盘高度；切换字段也要重算。
  doc.addEventListener("focusin", schedule, true);
  doc.addEventListener("focusout", schedule, true);

  return () => {
    if (poll !== 0) win.cancelAnimationFrame(poll);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    doc.removeEventListener("focusin", schedule, true);
    doc.removeEventListener("focusout", schedule, true);
    scrollEl.removeClass("easy-sync-keyboard-inset");
    scrollEl.style.removeProperty("--easy-sync-keyboard-inset");
  };
}

