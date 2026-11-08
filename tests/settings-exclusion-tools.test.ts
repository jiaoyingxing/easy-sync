/**
 * 排除与大型文件工具的行为测试（原 sync-exclusion-modal.test.ts；<1.13 弹框
 * 轨道随 minAppVersion 1.13.4 退场后，幸存工具迁入 settings-page-rows.ts，
 * 编辑会话迁入 settings-tab.ts，本文件随之改名指向新落点）。
 */
import { describe, expect, it, vi } from "vitest";
import { FuzzySuggestModal, TFile, TFolder } from "./__mocks__/obsidian";
import { I18n } from "../src/i18n";
import { DEFAULT_MAX_FILE_SIZE_MB, normalizeMaxFileSizeMb } from "../src/sync/types";
import type EasySyncPlugin from "../src/main";
import {
  buildSyncExclusionFolderCandidates,
  openSyncExclusionFolderPicker,
  parseMaxFileSizeInput,
  resolveMaxFileSizeSelection,
  type SyncExclusionFolderCandidate,
} from "../src/ui/settings-page-rows";
import { SyncExclusionEditSession } from "../src/ui/settings-tab";

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
