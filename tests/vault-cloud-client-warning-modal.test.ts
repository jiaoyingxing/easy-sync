/**
 * VaultCloudClientWarningModal — one-action contract: the manual/first-sync
 * warning renders the pre-decided body plus a single "snooze today" button.
 * The caller owns detection, the session guard and persistence; the modal
 * must not add a second action, a link or a setting row.
 */
import { describe, expect, it, vi } from "vitest";
import { VaultCloudClientWarningModal } from "../src/ui/vault-cloud-client-warning-modal";

type RecordedEl = HTMLElement & {
  classList: { contains(token: string): boolean };
  textContent: string;
  children: unknown[];
  __click?: () => void;
};

function ensureListeners(child: HTMLElement): void {
  const el = child as unknown as Record<string, unknown>;
  if (typeof el.addEventListener !== "function") {
    el.addEventListener = (type: string, handler: () => void) => {
      if (type === "click") el.__click = handler;
    };
  }
}

function captureDom(el: HTMLElement): void {
  const listOf = (): unknown[] => el.children as unknown[];
  const origCreateEl = el.createEl.bind(el);
  (el as unknown as Record<string, unknown>).createEl = (
    tag: string,
    options?: { text?: string; cls?: string },
  ) => {
    const child = origCreateEl(tag, options as never) as RecordedEl;
    ensureListeners(child);
    captureDom(child);
    if (options?.cls) {
      for (const token of options.cls.split(" ")) child.classList.add(token);
    }
    if (options?.text) child.setText(options.text);
    listOf().push(child);
    return child;
  };
  const origCreateDiv = el.createDiv.bind(el);
  (el as unknown as Record<string, unknown>).createDiv = (cls?: string) => {
    const child = origCreateDiv(cls) as RecordedEl;
    ensureListeners(child);
    captureDom(child);
    if (cls) {
      for (const token of cls.split(" ")) child.classList.add(token);
    }
    listOf().push(child);
    return child;
  };
  const origAppendChild = el.appendChild.bind(el);
  (el as unknown as Record<string, unknown>).appendChild = (
    child: unknown,
  ) => {
    if (!listOf().includes(child)) listOf().push(child);
    ensureListeners(child as HTMLElement);
    return origAppendChild(child as never);
  };
}

function buildModal(): {
  modal: VaultCloudClientWarningModal;
  onSnooze: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.spyOn>;
} {
  const onSnooze = vi.fn();
  const modal = new VaultCloudClientWarningModal(
    {} as never,
    "同步冲突风险",
    "检测到 OneDrive 客户端正在同步本仓库，必然冲突。",
    "今日不再提醒",
    onSnooze,
  );
  captureDom(modal.contentEl);
  const titleSpy = vi.spyOn(modal, "setTitle");
  const closeSpy = vi.spyOn(modal, "close").mockImplementation(() => undefined);
  modal.onOpen();
  expect(titleSpy).toHaveBeenCalledWith("同步冲突风险");
  return { modal, onSnooze, closeSpy };
}

describe("VaultCloudClientWarningModal", () => {
  it("renders the warning body and exactly one footer action", () => {
    const { modal } = buildModal();
    const children = modal.contentEl.children as unknown as RecordedEl[];

    expect(children).toHaveLength(2);
    expect(children[0].textContent).toBe(
      "检测到 OneDrive 客户端正在同步本仓库，必然冲突。",
    );

    const footer = children[1];
    expect(footer.classList.contains("modal-button-container")).toBe(true);
    expect(footer.classList.contains("easy-sync-modal-footer")).toBe(true);
    const buttons = footer.children as unknown as RecordedEl[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe("今日不再提醒");
    expect(buttons[0].classList.contains("mod-cta")).toBe(true);
  });

  it("snoozes once and closes when the single action is pressed", () => {
    const { modal, onSnooze, closeSpy } = buildModal();
    const footer = (modal.contentEl.children as unknown as RecordedEl[])[1];
    const button = (footer.children as unknown as RecordedEl[])[0];

    button.__click?.();

    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
