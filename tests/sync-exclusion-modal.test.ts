import { describe, expect, it, vi } from "vitest";
import { beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DropdownComponent, TextComponent } from "./__mocks__/obsidian";
import { I18n } from "../src/i18n";
import { DEFAULT_MAX_FILE_SIZE_MB, normalizeMaxFileSizeMb } from "../src/sync/types";
import type EasySyncPlugin from "../src/main";
import {
  buildSyncExclusionFolderCandidates,
  parseMaxFileSizeInput,
  resolveMaxFileSizeSelection,
  SyncExclusionEditSession,
  SyncExclusionModal,
} from "../src/ui/sync-exclusion-modal";

describe("sync exclusion folder candidates", () => {
  it("merges local and cloud folders without exposing duplicates or invalid paths", () => {
    expect(buildSyncExclusionFolderCandidates(
      [
        "Local",
        "Shared",
        "Parent/Child",
        ".obsidian",
        "Notes/../Invalid",
      ],
      [
        "Cloud",
        "shared",
        "Cloud/Nested",
        "Remote\\Nested",
        "/",
      ],
      ["Cloud"],
      ".obsidian",
    )).toEqual([
      { path: "Local" },
      { path: "Parent/Child" },
      { path: "Remote/Nested" },
      { path: "Shared" },
    ]);
  });

  it("keeps nested folders selectable until an excluded parent subsumes them", () => {
    expect(buildSyncExclusionFolderCandidates(
      ["Parent", "Parent/Child"],
      ["parent", "Parent/Remote"],
      [],
      ".obsidian",
    ).map((item) => item.path)).toEqual([
      "Parent",
      "Parent/Child",
      "Parent/Remote",
    ]);

    expect(buildSyncExclusionFolderCandidates(
      ["Parent", "Parent/Child"],
      ["Parent/Remote"],
      ["parent"],
      ".obsidian",
    )).toEqual([]);
  });
});

describe("SyncExclusionEditSession", () => {
  it("recalculates exactly once after any number of saved changes to an open review", async () => {
    const recalculate = vi.fn().mockResolvedValue(undefined);
    const session = new SyncExclusionEditSession(true);

    session.markSavedChange();
    session.markSavedChange();
    await Promise.all([
      session.close(recalculate),
      session.close(recalculate),
    ]);

    expect(recalculate).toHaveBeenCalledTimes(1);
  });

  it("does not recalculate without a saved change or a review present at open", async () => {
    const recalculate = vi.fn().mockResolvedValue(undefined);
    const unchanged = new SyncExclusionEditSession(true);
    const withoutReview = new SyncExclusionEditSession(false);

    withoutReview.markSavedChange();
    await unchanged.close(recalculate);
    await withoutReview.close(recalculate);

    expect(recalculate).not.toHaveBeenCalled();
  });
});

describe("large-file exclusion select control in the modal", () => {
  it("lives inside SyncExclusionModal as a select with presets, unlimited and custom", () => {
    const source = readFileSync("src/ui/sync-exclusion-modal.ts", "utf8");
    const settingsSource = readFileSync("src/ui/settings-tab.ts", "utf8");

    expect(source).toContain('t("settings.maxFileSize.name")');
    expect(source).toContain(".addDropdown(");
    expect(source).toContain(".addText(");
    expect(source).toContain("inputEl.hidden = selection.kind !== \"custom\"");
    expect(source).not.toContain(".addSlider(");
    expect(source).toContain('t("settings.maxFileSize.optionUnlimited")');
    expect(source).toContain('t("settings.maxFileSize.optionCustom")');
    expect(source).toContain('inputEl.inputMode = "numeric"');
    expect(source).toContain("plugin.applyMaxFileSize");
    expect(settingsSource).not.toContain(
      '.setName(t("settings.maxFileSize.name"))',
    );
  });
});

describe("large-file size value helpers", () => {
  it("normalizes stored values into the -1 / positive-MiB domain", () => {
    expect(normalizeMaxFileSizeMb(-1)).toBe(-1);
    expect(normalizeMaxFileSizeMb(300)).toBe(300);
    expect(normalizeMaxFileSizeMb(0)).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb(-5)).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb(Number.NaN)).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb(undefined)).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb("300")).toBe(DEFAULT_MAX_FILE_SIZE_MB);
  });

  it("resolves the select selection from the stored value", () => {
    expect(resolveMaxFileSizeSelection(512)).toEqual({ kind: "preset", value: 512 });
    expect(resolveMaxFileSizeSelection(-1)).toEqual({ kind: "unlimited" });
    expect(resolveMaxFileSizeSelection(500)).toEqual({ kind: "custom" });
  });

  it("accepts only positive whole MiB values in the custom input", () => {
    expect(parseMaxFileSizeInput("300")).toBe(300);
    expect(parseMaxFileSizeInput(" 300 ")).toBe(300);
    expect(parseMaxFileSizeInput("0")).toBeNull();
    expect(parseMaxFileSizeInput("-5")).toBeNull();
    expect(parseMaxFileSizeInput("abc")).toBeNull();
    expect(parseMaxFileSizeInput("12.5")).toBeNull();
  });
});

describe("SyncExclusionModal large-file select behavior", () => {
  beforeEach(() => {
    DropdownComponent.instances.length = 0;
    TextComponent.instances.length = 0;
  });

  function createMockPlugin(syncMaxFileSizeMb = 512): EasySyncPlugin {
    const i18n = new I18n("zh-cn");
    return {
      app: {} as never,
      i18n,
      syncMaxFileSizeMb,
      excludedFolders: [],
      diag: { warn: vi.fn() },
      createSyncExclusionFolderSnapshot: vi.fn().mockResolvedValue({
        remoteFolderPaths: [],
        hadPendingReview: false,
      }),
      saveSyncSettings: vi.fn().mockResolvedValue(undefined),
      applyMaxFileSize: vi.fn(),
      rebuildPlanReview: vi.fn().mockResolvedValue(undefined),
      updateExcludedFolders: vi.fn().mockResolvedValue(undefined),
      state: undefined,
    } as unknown as EasySyncPlugin;
  }

  it("renders the persistent custom text beside the dropdown and persists a preset on change", async () => {
    const plugin = createMockPlugin(512);
    const modal = new SyncExclusionModal(plugin);
    modal.onOpen();
    await modal.initialization;

    // 512 sits on the preset ladder → preset selected, custom text hidden.
    const dropdown = DropdownComponent.instances.at(-1)!;
    const text = TextComponent.instances.at(-1)!;
    expect(dropdown).toBeDefined();
    expect(text).toBeDefined();
    expect(dropdown.value).toBe("512");
    expect(text.inputEl.hidden).toBe(true);
    expect(modal.maxFileSizeDescText()).toContain("512 MB");

    await dropdown.triggerChange("256");

    expect(plugin.syncMaxFileSizeMb).toBe(256);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(plugin.applyMaxFileSize).toHaveBeenCalledTimes(1);
    expect(dropdown.value).toBe("256");
    expect(text.inputEl.hidden).toBe(true);
    expect(modal.maxFileSizeDescText()).toContain("256 MB");
  });

  it("maps a legacy off-ladder value to a persistent editable custom text", async () => {
    const plugin = createMockPlugin(500);
    const modal = new SyncExclusionModal(plugin);
    modal.onOpen();
    await modal.initialization;

    const dropdown = DropdownComponent.instances.at(-1)!;
    const text = TextComponent.instances.at(-1)!;
    expect(dropdown.value).toBe("custom");
    expect(text.inputEl.hidden).toBe(false);
    expect(text.getValue()).toBe("500");
    expect(modal.maxFileSizeDescText()).toContain("500 MB");

    // Re-entering the custom entry keeps the persistent text editable, no save.
    await dropdown.triggerChange("custom");
    expect(plugin.saveSyncSettings).not.toHaveBeenCalled();
    expect(plugin.syncMaxFileSizeMb).toBe(500);
    expect(text.inputEl.hidden).toBe(false);

    // Editing the text persists valid values live.
    await text.triggerChange("300");
    expect(plugin.syncMaxFileSizeMb).toBe(300);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(modal.maxFileSizeDescText()).toContain("300 MB");

    // Invalid input never persists; blur reverts the display and re-syncs.
    await text.triggerChange("abc");
    expect(plugin.syncMaxFileSizeMb).toBe(300);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    (text.inputEl as unknown as { __fire: (type: string) => void }).__fire("blur");
    expect(text.getValue()).toBe("300");
    expect(text.inputEl.hidden).toBe(false);
    expect(dropdown.value).toBe("custom");
  });

  it("persists unlimited as the -1 sentinel and hides the custom text", async () => {
    const plugin = createMockPlugin(512);
    const modal = new SyncExclusionModal(plugin);
    modal.onOpen();
    await modal.initialization;

    const dropdown = DropdownComponent.instances.at(-1)!;
    const text = TextComponent.instances.at(-1)!;
    await dropdown.triggerChange("unlimited");

    expect(plugin.syncMaxFileSizeMb).toBe(-1);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(plugin.applyMaxFileSize).toHaveBeenCalledTimes(1);
    expect(dropdown.value).toBe("unlimited");
    expect(text.inputEl.hidden).toBe(true);
    expect(modal.maxFileSizeDescText()).toBe(
      plugin.i18n.t("settings.maxFileSize.descUnlimited"),
    );
    expect(modal.maxFileSizeDescText()).not.toContain("MB");
  });

  it("typing a preset value into the custom text re-syncs the dropdown on blur", async () => {
    const plugin = createMockPlugin(500);
    const modal = new SyncExclusionModal(plugin);
    modal.onOpen();
    await modal.initialization;

    const dropdown = DropdownComponent.instances.at(-1)!;
    const text = TextComponent.instances.at(-1)!;
    expect(dropdown.value).toBe("custom");
    expect(text.inputEl.hidden).toBe(false);

    await text.triggerChange("512");
    expect(plugin.syncMaxFileSizeMb).toBe(512);

    (text.inputEl as unknown as { __fire: (type: string) => void }).__fire("blur");
    expect(dropdown.value).toBe("512");
    expect(text.inputEl.hidden).toBe(true);
    expect(text.getValue()).toBe("");
  });
});