import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import type { SyncProgressState } from "../src/sync/sync-progress";
import { SyncActionType } from "../src/sync/types";
import { resolveSyncActionPresentation } from "../src/sync/sync-action-presentation";
import {
  formatElapsedClock,
  resolveSyncActivityMetric,
  resolveSyncActivityMetricAria,
  resolveSyncActivityPresentation,
  resolveSyncActivityRevealDelay,
  resolveVisibleSyncActivityPresentation,
  SyncActivityRevealer,
  translateSyncActivity,
  translateSyncActivityMetric,
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
    completedCount: 0,
    startedAt: 1,
    ...overrides,
  };
}

describe("sync activity presentation", () => {
  it("maps every pre-execution phase to one shared semantic stage", () => {
    const cases = [
      ["scanning", "scanning", "progress.scanningLocal"],
      ["recovering", "recovering", "progress.recoveringOperations"],
      ["preparing", "preparing", "progress.preparingRemote"],
      ["baseline", "baseline", "progress.loadingBaseline"],
      ["checking", "checking", "progress.checkingRemote"],
      ["planningRecords", "planningRecords", "progress.preparingRecords"],
      ["planning", "planning", "progress.generatingPlan"],
      ["savingPlan", "savingPlan", "progress.savingPlan"],
      ["establishingSync", "establishingSync", "progress.establishingSync"],
      ["preparingAction", "preparingAction", "progress.preparingAction"],
      ["committing", "committing", "progress.savingSyncResult"],
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
      labelKey: "progress.recoveringOperations",
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

  it("formats phase counts and elapsed in the existing counter wording", () => {
    const i18n = new I18n("zh-cn");
    const t = i18n.t.bind(i18n);

    expect(translateSyncActivityMetric({
      kind: "count",
      current: 3,
      total: 10,
      unit: "batches",
    }, t)).toBe("3/10批");
    expect(translateSyncActivityMetric({
      kind: "count",
      current: 1234,
      total: 5000,
      unit: "items",
    }, t)).toBe("1234/5000项");
    expect(translateSyncActivityMetric({
      kind: "count",
      current: 2000,
      unit: "items",
    }, t)).toBe("2000项");
    expect(translateSyncActivityMetric({
      kind: "elapsed",
      startedAt: 1_000,
    }, t, 73_000)).toBe("已用 1:12");
    expect(formatElapsedClock(1_000, 3_661_000)).toBe("1:01:00");
    expect(resolveSyncActivityMetricAria({
      kind: "count",
      current: 3,
      total: 10,
      unit: "batches",
    }, t)).toBe("已整理 3，共 10 批");
  });

  it("uses elapsed only while a pre-execution phase has no count", () => {
    expect(resolveSyncActivityMetric(progress({
      phase: "planning",
      startedAt: 1_000,
    }))).toEqual({ kind: "elapsed", startedAt: 1_000 });

    expect(resolveSyncActivityMetric(progress({
      phase: "planning",
      startedAt: 1_000,
      phaseStartedAt: 5_000,
    }))).toEqual({ kind: "elapsed", startedAt: 5_000 });

    expect(resolveSyncActivityMetric(progress({
      phase: "scanning",
      startedAt: 1_000,
      phaseMetric: { current: 12, total: 40, unit: "items" },
    }))).toEqual({
      kind: "count",
      current: 12,
      total: 40,
      unit: "items",
    });

    expect(resolveSyncActivityMetric(progress({
      phase: "executing",
      startedAt: 1_000,
      current: 1,
      total: 4,
    }))).toBeNull();
    expect(resolveSyncActivityMetric(progress({
      phase: "committing",
      startedAt: 1_000,
      current: 4,
      total: 4,
    }))).toBeNull();
  });

  it("reveals detail states after a readable window and silent states after a longer one", () => {
    const now = 1_000_000;
    const scanning = progress({
      phase: "scanning",
      startedAt: now - 100,
      phaseStartedAt: now - 100,
      phaseMetric: { current: 12, total: 40, unit: "items" },
    });

    // The Ribbon keeps the raw projection; dense surfaces wait.
    expect(resolveSyncActivityPresentation(scanning)).toEqual({
      kind: "scanning",
      labelKey: "progress.scanningLocal",
    });
    expect(resolveSyncActivityRevealDelay(scanning, now)).toBe(200);
    expect(resolveVisibleSyncActivityPresentation(scanning, now))
      .toEqual({ kind: "syncing", labelKey: "syncView.progress" });
    expect(resolveSyncActivityMetric(scanning, now)).toBeNull();

    const scanningRevealed = now + 200;
    expect(resolveSyncActivityRevealDelay(scanning, scanningRevealed)).toBe(0);
    expect(resolveVisibleSyncActivityPresentation(scanning, scanningRevealed))
      .toEqual({ kind: "scanning", labelKey: "progress.scanningLocal" });
    expect(resolveSyncActivityMetric(scanning, scanningRevealed)).toEqual({
      kind: "count",
      current: 12,
      total: 40,
      unit: "items",
    });

    const planning = progress({
      phase: "planning",
      startedAt: now - 100,
      phaseStartedAt: now - 100,
    });
    expect(resolveSyncActivityRevealDelay(planning, now)).toBe(1_900);
    expect(resolveVisibleSyncActivityPresentation(planning, now))
      .toEqual({ kind: "syncing", labelKey: "syncView.progress" });
    expect(resolveVisibleSyncActivityPresentation(planning, now + 1_900))
      .toEqual({ kind: "planning", labelKey: "progress.generatingPlan" });
    expect(resolveSyncActivityMetric(planning, now + 1_900)).toBeNull();
    expect(resolveSyncActivityMetric(planning, now + 4_900)).toEqual({
      kind: "elapsed",
      startedAt: now - 100,
    });

    const savingPlan = progress({
      phase: "savingPlan",
      startedAt: now - 100,
      phaseStartedAt: now - 100,
    });
    expect(resolveSyncActivityRevealDelay(savingPlan, now)).toBe(200);
    expect(resolveVisibleSyncActivityPresentation(savingPlan, now + 200))
      .toEqual({ kind: "savingPlan", labelKey: "progress.savingPlan" });

    const committingEmpty = progress({
      phase: "committing",
      startedAt: now - 100,
      phaseStartedAt: now - 100,
    });
    expect(resolveSyncActivityRevealDelay(committingEmpty, now)).toBe(1_900);

    const committingSettled = progress({
      phase: "committing",
      total: 4,
      startedAt: now - 100,
      phaseStartedAt: now - 100,
    });
    expect(resolveSyncActivityRevealDelay(committingSettled, now)).toBe(200);

    expect(resolveSyncActivityRevealDelay(progress({
      phase: "executing",
      currentActionType: SyncActionType.Upload,
      startedAt: now,
      phaseStartedAt: now,
    }), now)).toBe(0);
    expect(resolveSyncActivityRevealDelay(progress({
      phase: "executing",
      startedAt: now,
      phaseStartedAt: now,
      cancelRequested: true,
    }), now)).toBe(0);
    expect(resolveSyncActivityRevealDelay(progress({
      phase: "recovering",
      activityKind: "mutationRecovery",
      startedAt: now,
      phaseStartedAt: now,
    }), now)).toBe(0);
  });

  it("keeps the last stable stage through a short next stage and clears it at real execution", () => {
    const revealer = new SyncActivityRevealer();
    const now = 1_000_000;
    const scanning = progress({
      phase: "scanning",
      startedAt: now,
      phaseStartedAt: now,
      phaseMetric: { current: 12, total: 40, unit: "items" },
    });
    expect(revealer.resolve(scanning, now + 400)).toEqual({
      presentation: { kind: "scanning", labelKey: "progress.scanningLocal" },
      current: true,
    });

    const checkingYoung = progress({
      phase: "checking",
      startedAt: now,
      phaseStartedAt: now + 400,
      phaseMetric: { current: 2, unit: "items" },
    });
    expect(revealer.resolve(checkingYoung, now + 500)).toEqual({
      presentation: { kind: "scanning", labelKey: "progress.scanningLocal" },
      current: false,
    });
    expect(revealer.resolve(checkingYoung, now + 900)).toEqual({
      presentation: { kind: "checking", labelKey: "progress.checkingRemote" },
      current: true,
    });

    // A real executing phase clears the pre-execution stage so the later
    // commit cannot revive it.
    const executing = progress({
      phase: "executing",
      startedAt: now,
      phaseStartedAt: now + 1_000,
      total: 5,
    });
    expect(revealer.resolve(executing, now + 1_100)).toEqual({
      presentation: { kind: "syncing", labelKey: "syncView.progress" },
      current: true,
    });
    const committingYoung = progress({
      phase: "committing",
      startedAt: now,
      phaseStartedAt: now + 1_200,
      total: 5,
    });
    expect(revealer.resolve(committingYoung, now + 1_300)).toEqual({
      presentation: { kind: "syncing", labelKey: "syncView.progress" },
      current: false,
    });
  });

  it("keeps the last stable stage through an empty executing phase", () => {
    const revealer = new SyncActivityRevealer();
    const now = 1_000_000;
    revealer.resolve(progress({
      phase: "checking",
      startedAt: now,
      phaseStartedAt: now,
      phaseMetric: { current: 3, unit: "items" },
    }), now + 1_100);
    const emptyExecuting = progress({
      phase: "executing",
      startedAt: now,
      phaseStartedAt: now + 1_200,
    });
    expect(revealer.resolve(emptyExecuting, now + 1_250)).toEqual({
      presentation: { kind: "checking", labelKey: "progress.checkingRemote" },
      current: false,
    });
    const committingYoung = progress({
      phase: "committing",
      startedAt: now,
      phaseStartedAt: now + 1_300,
    });
    expect(revealer.resolve(committingYoung, now + 1_350)).toEqual({
      presentation: { kind: "checking", labelKey: "progress.checkingRemote" },
      current: false,
    });
  });

  it("never shows a bare zero and keeps zero out of a known total", () => {
    const now = 1_000_000;
    const bareZero = progress({
      phase: "checking",
      startedAt: now - 2_000,
      phaseStartedAt: now - 2_000,
      phaseMetric: { current: 0, unit: "items" },
    });
    expect(resolveSyncActivityRevealDelay(bareZero, now)).toBe(0);
    expect(resolveVisibleSyncActivityPresentation(bareZero, now))
      .toEqual({ kind: "checking", labelKey: "progress.checkingRemote" });
    expect(resolveSyncActivityMetric(bareZero, now)).toBeNull();
    expect(resolveSyncActivityMetric(bareZero, now + 3_000)).toEqual({
      kind: "elapsed",
      startedAt: now - 2_000,
    });

    const scopedZero = progress({
      phase: "planningRecords",
      startedAt: now - 400,
      phaseStartedAt: now - 400,
      phaseMetric: { current: 0, total: 10, unit: "batches" },
    });
    expect(resolveSyncActivityMetric(scopedZero, now)).toEqual({
      kind: "count",
      current: 0,
      total: 10,
      unit: "batches",
    });

    const zeroTotal = progress({
      phase: "planningRecords",
      startedAt: now - 2_000,
      phaseStartedAt: now - 2_000,
      phaseMetric: { current: 0, total: 0, unit: "batches" },
    });
    expect(resolveSyncActivityMetric(zeroTotal, now)).toBeNull();
    expect(resolveSyncActivityMetric(zeroTotal, now + 3_000)).toEqual({
      kind: "elapsed",
      startedAt: now - 2_000,
    });
  });

  it("keeps a meaningful count out of the elapsed fallback while it is still being revealed", () => {
    const now = 1_000_000;
    const scanning = progress({
      phase: "scanning",
      startedAt: now,
      phaseStartedAt: now,
      phaseMetric: { current: 0, total: 100, unit: "items" },
    });
    expect(resolveSyncActivityMetric(scanning, now)).toBeNull();
    expect(resolveSyncActivityMetric(scanning, now + 5_000)).toEqual({
      kind: "count",
      current: 0,
      total: 100,
      unit: "items",
    });
  });

  it("keeps early scope recovery on the phase's own short name until a count exists", () => {
    const early = progress({
      phase: "scanning",
      recoveryVerification: {
        operationFingerprint: "abcdef123456",
        protocolPreflight: "ready",
        total: 0,
        verifiedThisRun: 0,
        reused: 0,
        invalidated: 0,
        remaining: 0,
      },
    });
    expect(resolveSyncActivityPresentation(early)).toEqual({
      kind: "scanning",
      labelKey: "progress.scanningLocal",
    });

    const verifying = progress({
      phase: "scanning",
      recoveryVerification: {
        ...early.recoveryVerification!,
        total: 2,
      },
    });
    expect(resolveSyncActivityPresentation(verifying)).toEqual({
      kind: "verifying",
      labelKey: "progress.remoteScopeRecovery",
    });
  });
});
