import { describe, expect, it, vi } from "vitest";
import { beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DropdownComponent, FuzzySuggestModal, TextComponent, TFile, TFolder } from "./__mocks__/obsidian";
import { I18n } from "../src/i18n";
import { DEFAULT_MAX_FILE_SIZE_MB, normalizeMaxFileSizeMb } from "../src/sync/types";
import type EasySyncPlugin from "../src/main";
import { functionBody } from "./helpers/source-scope";
import {
  buildSyncExclusionFolderCandidates,
  openSyncExclusionFolderPicker,
  parseMaxFileSizeInput,
  resolveMaxFileSizeSelection,
  SyncExclusionEditSession,
  SyncExclusionModal,
} from "../src/ui/sync-exclusion-modal";
import type { SyncExclusionFolderCandidate } from "../src/ui/sync-exclusion-modal";

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

describe("sync exclusion folder picker entry", () => {
  interface CapturedPicker {
    getItems(): SyncExclusionFolderCandidate[];
    onChooseItem(item: SyncExclusionFolderCandidate): void;
  }

  it("opens the picker with merged candidates and forwards the chosen object", () => {
    let captured: CapturedPicker | undefined;
    const openSpy = vi
      .spyOn(FuzzySuggestModal.prototype, "open")
      .mockImplementation(function (this: unknown) {
        captured = this as CapturedPicker;
      });
    try {
      const plugin = {
        app: {
          vault: {
            configDir: ".obsidian",
            getAllLoadedFiles: () => [
              new TFolder("Local"),
              new TFolder("Shared"),
              new TFolder(".obsidian"),
              new TFile("Note.md"),
              new TFolder("Cloud"),
            ],
          },
        },
        excludedFolders: ["Cloud"],
        i18n: new I18n("zh-cn"),
      } as unknown as EasySyncPlugin;

      const onChoose = vi.fn();
      openSyncExclusionFolderPicker(
        plugin,
        ["Cloud/Nested", "shared", "Remote\\Nested", "/"],
        onChoose,
      );

      expect(openSpy).toHaveBeenCalledTimes(1);
      if (!captured) throw new Error("folder picker was not opened");
      const picker: CapturedPicker = captured;

      // Local TFolder paths + cloud paths, minus the config dir, the excluded
      // Cloud subtree, duplicates (shared/Shared) and invalid roots; sorted.
      const items = picker.getItems();
      expect(items).toEqual([
        { path: "Local" },
        { path: "Remote/Nested" },
        { path: "Shared" },
      ]);

      picker.onChooseItem(items[1]!);
      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose).toHaveBeenCalledWith(items[1]);
    } finally {
      openSpy.mockRestore();
    }
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
    // 收窄：这三处在同一文件里都出现两次（另一处是同名的另一条路径），
    // 绑到各自真正负责的函数体上。
    const renderBody = functionBody(source, "private render(): void");
    const visibilityBody = functionBody(
      source,
      "private syncMaxFileSizeCustomTextVisibility(): void",
    );
    const persistBody = functionBody(
      source,
      "private async persistMaxFileSizeMb(value: number): Promise<void>",
    );

    expect(source).toContain('t("settings.maxFileSize.name")');
    expect(source).toContain(".addDropdown(");
    expect(source).toContain(".addText(");
    expect(renderBody).toContain("inputEl.hidden = selection.kind !== \"custom\"");
    expect(visibilityBody).toContain("inputEl.hidden = selection.kind !== \"custom\"");
    expect(source).not.toContain(".addSlider(");
    expect(source).toContain('t("settings.maxFileSize.optionUnlimited")');
    expect(source).toContain('t("settings.maxFileSize.optionCustom")');
    expect(source).toContain('inputEl.inputMode = "numeric"');
    expect(persistBody).toContain("plugin.applyMaxFileSize");
    expect(settingsSource).not.toContain(
      '.setName(t("settings.maxFileSize.name"))',
    );
  });
});

describe("large-file size value helpers", () => {
  it("keeps the folder row refresh local and routes failures to the error slots", () => {
    const source = readFileSync("src/ui/sync-exclusion-modal.ts", "utf8");
    // 2026-10-30 第二轮：加/删 chip 只重绘文件夹行，不再整窗重建（文件大小行
    // 的输入与焦点保持原样）；失败改走两组错误令牌（字段级/弹框级）。
    const updateBody = functionBody(
      source,
      "private async updateFolders(paths: string[]): Promise<boolean>",
    );
    expect(updateBody).toContain("setErrorSlot(this.modalErrorSlotEl, null)");
    expect(updateBody).toContain("this.refreshFolderChips()");
    expect(updateBody).not.toContain("this.render()");
    const initBody = functionBody(
      source,
      "private async initialize(): Promise<void>",
    );
    expect(initBody).toContain("this.refreshFolderChips()");
    expect(initBody).not.toContain("this.render()");
    const revertBody = functionBody(
      source,
      "private revertMaxFileSizeTextIfInvalid(): void",
    );
    expect(revertBody).toContain("setErrorSlot(");
    expect(revertBody).not.toContain("new Notice(");
    const persistBody = functionBody(
      source,
      "private async persistMaxFileSizeMb(value: number): Promise<void>",
    );
    expect(persistBody).toContain("setErrorSlot(this.modalErrorSlotEl, null)");
    expect(persistBody).toContain("setErrorSlot(");
    expect(source).toContain("createModalErrorSlot(");
    expect(source).toContain("createFieldErrorSlot(");
  });

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

    // Invalid input never persists; blur reverts the display and re-syncs,
    // and the field-level error slot surfaces instead of a Notice.
    await text.triggerChange("abc");
    expect(plugin.syncMaxFileSizeMb).toBe(300);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    (text.inputEl as unknown as { __fire: (type: string) => void }).__fire("blur");
    expect(text.getValue()).toBe("300");
    expect(text.inputEl.hidden).toBe(false);
    const fieldError = (modal as unknown as {
      maxFileSizeFieldErrorEl: HTMLElement | null;
    }).maxFileSizeFieldErrorEl;
    expect(fieldError).not.toBeNull();
    expect(fieldError!.classList.contains("is-hidden")).toBe(false);
    expect(fieldError!.textContent).toBe(
      plugin.i18n.t("settings.maxFileSize.invalidValue"),
    );

    // 输入即清：合法值一进来字段级错误就退场（2026-10-30 清除规则）。
    await text.triggerChange("300");
    expect(fieldError!.classList.contains("is-hidden")).toBe(true);
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