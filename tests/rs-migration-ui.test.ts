import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { I18n } from "../src/i18n";
import { RsMigrationOfferModal } from "../src/ui/rs-migration-offer-modal";
import { RsMigrationFailureModal } from "../src/ui/rs-migration-failure-modal";
import { RsMigrationGuideModal } from "../src/ui/rs-migration-failure-modal";
import type EasySyncPlugin from "../src/main";

// The mock element's createEl/createDiv record nothing and append nowhere;
// these local stubs mirror real DOM semantics (apply cls/text, append to the
// caller) so the house-structure assertions below can read the tree, the same
// approach as auto-sync-modal.test.ts's local createEl wrapper.
type RecordedEl = HTMLElement & {
  classList: { contains(token: string): boolean };
  textContent: string;
  children: unknown[];
};

// Mock elements ship no addEventListener; production onOpen wires click
// handlers right after creating each control, so give every created child a
// noop recorder to let onOpen complete.
function ensureListeners(child: HTMLElement): void {
  const el = child as unknown as Record<string, unknown>;
  if (typeof el.addEventListener !== "function") {
    el.addEventListener = () => undefined;
  }
}

function captureDom(el: HTMLElement): void {
  // Read el.children dynamically at push time: onOpen calls empty(), which
  // (in the mock) swaps in a fresh array — a captured reference goes stale.
  const listOf = (): unknown[] => el.children as unknown[];
  const origCreateEl = el.createEl.bind(el);
  (el as unknown as Record<string, unknown>).createEl = (
    tag: string,
    options?: { text?: string; cls?: string },
  ) => {
    const child = origCreateEl(tag, options as never) as RecordedEl;
    ensureListeners(child);
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
    if (cls) {
      for (const token of cls.split(" ")) child.classList.add(token);
    }
    listOf().push(child);
    const row = child;
    const origRowCreateEl = row.createEl.bind(row);
    (row as unknown as Record<string, unknown>).createEl = (
      tag: string,
      options?: { text?: string; cls?: string },
    ) => {
      const created = origRowCreateEl(tag, options as never) as RecordedEl;
      ensureListeners(created);
      if (options?.cls) {
        for (const token of options.cls.split(" ")) created.classList.add(token);
      }
      if (options?.text) created.setText(options.text);
      (row.children as unknown[]).push(created);
      return created;
    };
    return child;
  };
  const origAppendChild = el.appendChild.bind(el);
  (el as unknown as Record<string, unknown>).appendChild = (
    child: unknown,
  ) => {
    // Real DOM moves the node; a createEl-appended child must not be counted
    // twice when the caller appends it to the same parent (offer modal does).
    if (!listOf().includes(child)) listOf().push(child);
    ensureListeners(child as HTMLElement);
    return origAppendChild(child as never);
  };
}

function createMockPlugin(): EasySyncPlugin {
  const i18n = new I18n("zh-cn");
  return { app: {} as never, i18n } as unknown as EasySyncPlugin;
}

describe("RsMigrationOfferModal", () => {
  it("keeps the auth-method house container class and option rows", () => {
    const plugin = createMockPlugin();
    const t = plugin.i18n.t.bind(plugin.i18n);
    const modal = new RsMigrationOfferModal(plugin, {
      title: t("rsMigration.offerTitle"),
      body: t("rsMigration.offerBody", { vault: "test-vault" }),
      migrate: {
        title: t("rsMigration.offerMigrateTitle"),
        description: t("rsMigration.offerMigrateDesc"),
      },
      fresh: {
        title: t("rsMigration.offerFreshTitle"),
        description: t("rsMigration.offerFreshDesc"),
      },
      crossDeviceNote: t("rsMigration.offerCrossDeviceNote"),
    });
    captureDom(modal.contentEl);
    modal.onOpen();

    // Without this class the container gap rules never apply (2026-10-01
    // screenshot-review finding); AuthMethodModal sets the same class.
    expect(
      modal.contentEl.classList.contains("easy-sync-auth-method-modal"),
    ).toBe(true);
    const children = modal.contentEl.children as unknown as RecordedEl[];
    expect(children).toHaveLength(4);
    expect(children[0].classList.contains("setting-item-description")).toBe(true);
    expect(children[1].classList.contains("easy-sync-auth-method-option")).toBe(true);
    expect(children[2].classList.contains("easy-sync-auth-method-option")).toBe(true);
    expect(children[3].classList.contains("setting-item-description")).toBe(true);
  });
});

describe("RsMigrationFailureModal", () => {
  it("renders three exits in the host button container with hierarchy classes", () => {
    const plugin = createMockPlugin();
    const t = plugin.i18n.t.bind(plugin.i18n);
    const modal = new RsMigrationFailureModal(plugin, {
      title: t("rsMigration.failureTitle"),
      body: t("rsMigration.failureBody"),
      retryLabel: t("rsMigration.failureRetry"),
      freshLabel: t("rsMigration.failureFreshSync"),
      guideLabel: t("rsMigration.failureGuide"),
      guideTitle: t("rsMigration.guideTitle"),
      guideBody: t("rsMigration.guideBody"),
      guideOk: t("rsMigration.guideOk"),
    });
    captureDom(modal.contentEl);
    modal.onOpen();

    const children = modal.contentEl.children as unknown as RecordedEl[];
    expect(children).toHaveLength(2);
    const btnRow = children[1];
    expect(btnRow.classList.contains("modal-button-container")).toBe(true);
    const buttons = btnRow.children as unknown as RecordedEl[];
    expect(buttons).toHaveLength(3);
    expect(buttons[0].textContent).toBe(t("rsMigration.failureRetry"));
    expect(buttons[0].classList.contains("mod-cta")).toBe(true);
    expect(buttons[1].textContent).toBe(t("rsMigration.failureFreshSync"));
    expect(buttons[1].classList.contains("mod-cta")).toBe(false);
    expect(buttons[2].textContent).toBe(t("rsMigration.failureGuide"));
    expect(buttons[2].classList.contains("mod-link")).toBe(true);
  });
});

describe("RsMigrationGuideModal", () => {
  it("renders the localized OK label in the host button container", () => {
    const plugin = createMockPlugin();
    const t = plugin.i18n.t.bind(plugin.i18n);
    const modal = new RsMigrationGuideModal(plugin, {
      title: t("rsMigration.guideTitle"),
      body: t("rsMigration.guideBody"),
      okLabel: t("rsMigration.guideOk"),
    });
    captureDom(modal.contentEl);
    modal.onOpen();

    const children = modal.contentEl.children as unknown as RecordedEl[];
    const btnRow = children[children.length - 1];
    expect(btnRow.classList.contains("modal-button-container")).toBe(true);
    const buttons = btnRow.children as unknown as RecordedEl[];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe(t("rsMigration.guideOk"));
    expect(buttons[0].classList.contains("mod-cta")).toBe(true);
  });
});

describe("rs migration completion notice wiring", () => {
  it("keeps the completion notice on the dispatch funnel's marker cleanup block", () => {
    const source = readFileSync("src/main.ts", "utf8");
    // The old same-stack trigger (real path never reached it; in-stack hits
    // fired before the user confirmed) must stay gone.
    expect(source).not.toContain(
      'rsMigration === "migrated" && firstSyncResult?.success',
    );
    // The notice now lives at the marker cleanup block, delayed past the
    // round-result notice that always preempts an immediate show.
    const cleanupAnchor = source.indexOf(
      "Remotely Save adoption marker cleared after authority commit",
    );
    const noticeAnchor = source.indexOf('key: "rs-migration-completed"');
    expect(cleanupAnchor).toBeGreaterThan(-1);
    expect(noticeAnchor).toBeGreaterThan(cleanupAnchor);
  });
});
