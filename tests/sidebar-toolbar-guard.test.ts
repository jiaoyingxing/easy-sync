import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structure guard for the sidebar toolbar — the bar Obsidian takes over on
 * mobile (bottom action area) and renders at the top on desktop. Its four
 * buttons must survive every indicator/refactor pass: this file pins the
 * takeover container, all four buttons, and keeps the display-only
 * transfer-rate indicator out of the operation container.
 */
const source = readFileSync(
  new URL("../src/ui/sync-view.ts", import.meta.url),
  "utf8",
);

describe("sidebar toolbar guard (host-taken-over bar)", () => {
  it("keeps the host-takeover buttons container", () => {
    expect(source).toContain('createDiv("nav-buttons-container")');
  });

  it("keeps all four bar buttons", () => {
    expect(source).toContain('"history"');
    expect(source).toContain('"settings"');
    expect(source).toContain('"sliders-horizontal"');
    expect(source).toContain("this.renderCollapseToggle(buttons)");
    expect(source).toContain('"chevrons-up-down"');
    expect(source).toContain('"chevrons-down-up"');
  });

  it("keeps the operation container free of the display-only indicator", () => {
    expect(source).not.toContain("renderTransferRateIndicator(buttons)");
    expect(source).not.toContain(
      'buttons.createDiv("easy-sync-transfer-rate")',
    );
  });

  it("keeps both indicator carriers (desktop band, mobile chip)", () => {
    expect(source).toContain('"is-panel-footer"');
    expect(source).toContain('"is-mobile-footer"');
  });
});
