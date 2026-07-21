import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import type { SyncProgressState } from "../src/sync/sync-progress";
import { SyncActionType } from "../src/sync/types";
import {
  resolveSyncActivityPresentation,
  translateSyncActivity,
} from "../src/ui/sync-status-presentation";

function progress(
  overrides: Partial<SyncProgressState> = {},
): SyncProgressState {
  return {
    phase: "idle",
    current: 0,
    total: 0,
    currentFile: "",
    currentItemBytes: 0,
    currentItemTotalBytes: 0,
    currentItemComplete: false,
    cancelRequested: false,
    completedFiles: [],
    startedAt: 1,
    ...overrides,
  };
}

describe("sync activity presentation", () => {
  it("maps every pre-execution phase to one shared semantic stage", () => {
    const cases = [
      ["scanning", "scanning", "progress.scanningLocal"],
      ["preparing", "preparing", "progress.preparingRemote"],
      ["baseline", "baseline", "progress.loadingBaseline"],
      ["checking", "checking", "progress.checkingRemote"],
      ["planning", "planning", "progress.generatingPlan"],
    ] as const;

    for (const [phase, kind, labelKey] of cases) {
      expect(resolveSyncActivityPresentation(progress({ phase }))).toEqual({
        kind,
        labelKey,
      });
    }
  });

  it("keeps verifying counts and execution actions in the same presentation layer", () => {
    expect(resolveSyncActivityPresentation(progress({
      phase: "verifying",
      current: 2,
      total: 5,
    }))).toEqual({
      kind: "verifying",
      labelKey: "progress.verifyingFiles",
      params: { current: 2, total: 5 },
    });

    expect(resolveSyncActivityPresentation(progress({
      phase: "executing",
      currentActionType: SyncActionType.Download,
    }))).toEqual({
      kind: "downloading",
      labelKey: "syncView.active.download",
    });

    expect(resolveSyncActivityPresentation(progress({
      phase: "executing",
      currentActionType: SyncActionType.RenameRemote,
    }))).toEqual({
      kind: "renaming",
      labelKey: "syncView.active.rename",
    });

    expect(resolveSyncActivityPresentation(progress({
      phase: "executing",
      currentActionType: SyncActionType.DeleteLocal,
    }))).toEqual({
      kind: "deleting",
      labelKey: "syncView.active.delete",
    });
  });

  it("gives cancellation priority and translates through the existing locale", () => {
    const presentation = resolveSyncActivityPresentation(progress({
      phase: "executing",
      currentActionType: SyncActionType.Upload,
      cancelRequested: true,
    }));

    expect(presentation).toEqual({
      kind: "cancelling",
      labelKey: "syncView.cancelling",
    });
    const i18n = new I18n("zh-cn");
    expect(translateSyncActivity(presentation, i18n.t.bind(i18n)))
      .toBe("正在取消…");
  });
});
