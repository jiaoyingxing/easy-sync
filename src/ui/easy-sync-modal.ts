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
 * 弹框级错误槽（2026-10-30 第二轮两组令牌之一，参数对齐 Resojot）：底栏 /
 * 内容尾上方一条；预创建隐藏，经 `setErrorSlot` 显隐。同一条失败只留这一处，
 * 不再叠加 Notice；清除规则＝动作开始即清、输入即清。
 */
export function createModalErrorSlot(parentEl: HTMLElement): HTMLElement {
  return parentEl.createDiv({
    cls: "easy-sync-modal-error is-hidden",
    attr: { role: "alert", "aria-live": "polite" },
  });
}

/**
 * 字段级错误槽：只挂在出错字段下方；无障碍属性与显隐同弹框级。
 */
export function createFieldErrorSlot(parentEl: HTMLElement): HTMLElement {
  return parentEl.createDiv({
    cls: "easy-sync-field-error is-hidden",
    attr: { role: "alert", "aria-live": "polite" },
  });
}

/** 错误槽唯一写入口：message＝null 清空并隐藏，否则写文本并显形。 */
export function setErrorSlot(
  slot: HTMLElement | null,
  message: string | null,
): void {
  if (!slot) return;
  if (message === null) {
    slot.addClass("is-hidden");
    slot.setText("");
    return;
  }
  slot.removeClass("is-hidden");
  slot.setText(message);
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

