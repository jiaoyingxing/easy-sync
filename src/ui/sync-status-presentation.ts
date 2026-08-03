import type { LocaleStrings } from "../i18n/types";
import type { SyncProgressState } from "../sync/sync-progress";
import {
  resolveSyncActionPresentation,
  type SyncActionActivityKind,
} from "../sync/sync-action-presentation";

export type SyncActivityKind =
  | "starting"
  | "scanning"
  | "preparing"
  | "baseline"
  | "checking"
  | "planning"
  | "verifying"
  | "recovery"
  | "syncing"
  | SyncActionActivityKind
  | "cancelling";

export interface SyncActivityPresentation {
  kind: SyncActivityKind;
  labelKey: keyof LocaleStrings;
  params?: Record<string, string | number>;
}

export type SyncStatusTranslator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * Single semantic projection for every running-state surface.
 * The progress store owns facts; Notice, sidebar and Ribbon only choose how
 * much of this presentation to expose.
 */
export function resolveSyncActivityPresentation(
  progress: Readonly<SyncProgressState>,
): SyncActivityPresentation {
  if (progress.cancelRequested) {
    return { kind: "cancelling", labelKey: "syncView.cancelling" };
  }
  if (progress.activityKind === "mutationRecovery") {
    return {
      kind: "recovery",
      labelKey: "progress.recoveringMutation",
    };
  }

  switch (progress.phase) {
    case "scanning":
      return { kind: "scanning", labelKey: "progress.scanningLocal" };
    case "preparing":
      return { kind: "preparing", labelKey: "progress.preparingRemote" };
    case "baseline":
      return { kind: "baseline", labelKey: "progress.loadingBaseline" };
    case "checking":
      return { kind: "checking", labelKey: "progress.checkingRemote" };
    case "planning":
      return { kind: "planning", labelKey: "progress.generatingPlan" };
    case "verifying":
      return {
        kind: "verifying",
        labelKey: "progress.verifyingFiles",
        params: { current: progress.current, total: progress.total },
      };
    case "executing":
      if (progress.currentActionType) {
        const action = resolveSyncActionPresentation(progress.currentActionType);
        return {
          kind: action.activityKind,
          labelKey: action.activeLabelKey,
        };
      }
      return { kind: "syncing", labelKey: "syncView.progress" };
    case "idle":
    case "done":
    default:
      return { kind: "starting", labelKey: "syncView.progress" };
  }
}

export function translateSyncActivity(
  presentation: SyncActivityPresentation,
  t: SyncStatusTranslator,
): string {
  return t(presentation.labelKey, presentation.params);
}

export function trimSyncActivityLabel(label: string): string {
  return label.replace(/(?:…|\.\.\.)$/, "").trimEnd();
}
