/**
 * AuthMethodModal — first-login method chooser renders one fixed order on
 * every platform: browser (跳转登录) first, device code (输入代码登录) second.
 * The 2026-08-21 mobile-first order was removed on 2026-11-21 (user decision);
 * this test drives the real `onOpen` with the live `Platform` flags flipped so
 * a mobile-only reorder would fail here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Platform } from "obsidian";
import { AuthMethodModal } from "../src/ui/auth-method-modal";

// Local DOM stubs mirror real semantics (apply cls/text, append to caller,
// record click handlers) — same approach as rs-migration-ui.test.ts.
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

/**
 * Record every element created through `createEl` / `createDiv` /
 * `appendChild` into its parent's `children`. The mock element creates
 * detached children and appends nothing, so nested rows (`button > body >
 * title`) only become readable once each created node is instrumented too.
 */
function installRecorder(el: HTMLElement): void {
  const self = el as unknown as Record<string, unknown>;
  const origCreateEl = el.createEl.bind(el);
  const origCreateDiv = el.createDiv.bind(el);
  const origAppendChild = el.appendChild.bind(el);
  const push = (child: unknown): void => {
    const list = el.children as unknown[];
    if (!list.includes(child)) list.push(child);
  };
  const applyFields = (
    child: RecordedEl,
    fields?: string | { text?: string; cls?: string },
  ): void => {
    const cls = typeof fields === "string" ? fields : fields?.cls;
    if (cls) {
      for (const token of cls.split(" ")) child.classList.add(token);
    }
    if (typeof fields === "object" && fields?.text) {
      child.setText(fields.text);
    }
  };

  self.createEl = (
    tag: string,
    options?: { text?: string; cls?: string },
  ) => {
    const child = origCreateEl(tag, options as never) as RecordedEl;
    ensureListeners(child);
    applyFields(child, options);
    push(child);
    installRecorder(child);
    return child;
  };
  self.createDiv = (fields?: string | { text?: string; cls?: string }) => {
    const child = origCreateDiv() as RecordedEl;
    ensureListeners(child);
    applyFields(child, fields);
    push(child);
    installRecorder(child);
    return child;
  };
  self.appendChild = (child: unknown) => {
    push(child);
    ensureListeners(child as HTMLElement);
    return origAppendChild(child as never);
  };
}

function captureDom(el: HTMLElement): void {
  installRecorder(el);
}

/** Concatenate textContent across a recorded element subtree. */
function textOf(el: RecordedEl): string {
  const children = (el.children ?? []) as unknown as RecordedEl[];
  return `${el.textContent ?? ""}${children.map(textOf).join("")}`;
}

const BROWSER = {
  title: "跳转登录",
  description: "在这台设备的浏览器完成授权。",
};
const DEVICE = {
  title: "输入代码登录",
  description: "在浏览器输入 9 位码登录。",
};

function buildModal(): AuthMethodModal {
  const modal = new AuthMethodModal(
    {} as never,
    BROWSER,
    DEVICE,
    () => undefined,
    () => Promise.resolve(),
  );
  captureDom(modal.contentEl);
  modal.onOpen();
  return modal;
}

function optionRows(modal: AuthMethodModal): string[] {
  const children = modal.contentEl.children as unknown as RecordedEl[];
  return children
    .filter((child) => child.classList.contains("easy-sync-auth-method-option"))
    .map(textOf);
}

const desktopDefault = {
  isMobileApp: Platform.isMobileApp,
  isMobile: Platform.isMobile,
};

afterEach(() => {
  Platform.isMobileApp = desktopDefault.isMobileApp;
  Platform.isMobile = desktopDefault.isMobile;
});

describe("AuthMethodModal option order", () => {
  it("puts the browser option first on desktop", () => {
    Platform.isMobileApp = false;
    Platform.isMobile = false;

    const rows = optionRows(buildModal());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(BROWSER.title);
    expect(rows[1]).toContain(DEVICE.title);
  });

  it("keeps the browser option first on mobile too (no platform reorder)", () => {
    Platform.isMobileApp = true;
    Platform.isMobile = true;

    const rows = optionRows(buildModal());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(BROWSER.title);
    expect(rows[1]).toContain(DEVICE.title);
  });

  it("resolves the clicked row's action in the chooser's click chain", async () => {
    const rowsOf = (modal: AuthMethodModal): RecordedEl[] =>
      (modal.contentEl.children as unknown as RecordedEl[]).filter((child) =>
        child.classList.contains("easy-sync-auth-method-option"),
      );

    const browserModal = buildModal();
    const browserPending = browserModal.awaitAction();
    rowsOf(browserModal)[0].__click?.();
    await expect(browserPending).resolves.toEqual({ action: "browser" });

    const deviceModal = buildModal();
    const devicePending = deviceModal.awaitAction();
    rowsOf(deviceModal)[1].__click?.();
    await expect(devicePending).resolves.toEqual({ action: "device" });
  });
});
