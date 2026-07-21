import type { LocaleStrings } from "../i18n/types";
import type { SyncProgressState } from "../sync/sync-progress";
import { SyncActionType } from "../sync/types";

export type SyncActivityKind =
  | "starting"
  | "scanning"
  | "preparing"
  | "baseline"
  | "checking"
  | "planning"
  | "verifying"
  | "syncing"
  | "uploading"
  | "downloading"
  | "deleting"
  | "renaming"
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
      switch (progress.currentActionType) {
        case SyncActionType.Upload:
          return { kind: "uploading", labelKey: "syncView.active.upload" };
        case SyncActionType.Download:
          return { kind: "downloading", labelKey: "syncView.active.download" };
        case SyncActionType.DeleteRemote:
        case SyncActionType.DeleteLocal:
          return { kind: "deleting", labelKey: "syncView.active.delete" };
        case SyncActionType.RenameRemote:
          return { kind: "renaming", labelKey: "syncView.active.rename" };
        default:
          return { kind: "syncing", labelKey: "syncView.progress" };
      }
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
