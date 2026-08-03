import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import type { SyncProgressState } from "../src/sync/sync-progress";
import { SyncActionType } from "../src/sync/types";
import { resolveSyncActionPresentation } from "../src/sync/sync-action-presentation";
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
      labelKey: "syncAction.download.active",
    });

    expect(resolveSyncActivityPresentation(progress({
      phase: "executing",
      currentActionType: SyncActionType.RenameRemote,
    }))).toEqual({
      kind: "renaming",
      labelKey: "syncAction.renameRemote.active",
    });

    expect(resolveSyncActivityPresentation(progress({
      phase: "executing",
      currentActionType: SyncActionType.DeleteLocal,
    }))).toEqual({
      kind: "deleting",
      labelKey: "syncAction.deleteLocal.active",
    });
  });

  it("uses the exact action mapping for every executing action", () => {
    for (const type of Object.values(SyncActionType)) {
      const action = resolveSyncActionPresentation(type);
      expect(resolveSyncActivityPresentation(progress({
        phase: "executing",
        currentActionType: type,
      }))).toEqual({
        kind: action.activityKind,
        labelKey: action.activeLabelKey,
      });
    }
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

  it("shows recovery as its own running activity while keeping cancellation authoritative", () => {
    expect(resolveSyncActivityPresentation(progress({
      phase: "checking",
      activityKind: "mutationRecovery",
    }))).toEqual({
      kind: "recovery",
      labelKey: "progress.recoveringMutation",
    });

    expect(resolveSyncActivityPresentation(progress({
      phase: "checking",
      activityKind: "mutationRecovery",
      cancelRequested: true,
    }))).toEqual({
      kind: "cancelling",
      labelKey: "syncView.cancelling",
    });
  });
});
