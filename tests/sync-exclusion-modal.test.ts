import { describe, expect, it, vi } from "vitest";
import { beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { SliderComponent } from "./__mocks__/obsidian";
import { I18n } from "../src/i18n";
import type EasySyncPlugin from "../src/main";
import {
  buildSyncExclusionFolderCandidates,
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

describe("large-file exclusion slider in the modal", () => {
  it("lives inside SyncExclusionModal, not the settings page", () => {
    const source = readFileSync("src/ui/sync-exclusion-modal.ts", "utf8");
    const settingsSource = readFileSync("src/ui/settings-tab.ts", "utf8");

    expect(source).toContain('t("settings.maxFileSize.name")');
    expect(source).toContain(".addSlider(");
    expect(source).toContain("setLimits(200, 2000, 100)");
    expect(source).toContain("plugin.applyMaxFileSize");
    expect(settingsSource).not.toContain(
      '.setName(t("settings.maxFileSize.name"))',
    );
  });
});

describe("SyncExclusionModal large-file slider behavior", () => {
  beforeEach(() => {
    SliderComponent.instances.length = 0;
  });

  function createMockPlugin(): EasySyncPlugin {
    const i18n = new I18n("zh-cn");
    return {
      app: {} as never,
      i18n,
      syncMaxFileSizeMb: 500,
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

  it("renders the large-file slider and persists a new size on change", async () => {
    const plugin = createMockPlugin();
    const modal = new SyncExclusionModal(plugin);
    modal.onOpen();
    await modal.initialization;

    // The modal renders one slider (large-file size).
    const slider = SliderComponent.instances[0];
    expect(slider).toBeDefined();
    expect(slider.value).toBe(500);

    await slider.triggerChange(1200);

    expect(plugin.syncMaxFileSizeMb).toBe(1200);
    expect(plugin.saveSyncSettings).toHaveBeenCalledTimes(1);
    expect(plugin.applyMaxFileSize).toHaveBeenCalledTimes(1);
  });
});
