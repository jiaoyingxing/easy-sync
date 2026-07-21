import { ProgressBarComponent } from "obsidian";
import type { SyncResult } from "../sync/sync-executor";
import {
  syncProgressPercent,
  type SyncProgressState,
} from "../sync/sync-progress";
import type { EasySyncNoticeMessage } from "./notice-center";
import {
  resolveSyncActivityPresentation,
  translateSyncActivity,
  type SyncActivityPresentation,
  type SyncStatusTranslator,
} from "./sync-status-presentation";

export type SyncNoticeOutcomeKind =
  | "completed"
  | "conflicts"
  | "review"
  | "cancelled"
  | "failed"
  | "authExpired";

export interface SyncNoticeOutcome {
  kind: SyncNoticeOutcomeKind;
  count: number;
}

export function shouldSuppressSyncNoticeForMobileSidebar(input: {
  isMobile: boolean;
  leftSidebarCollapsed: boolean;
  easySyncViewInLeftSidebar: boolean;
}): boolean {
  return input.isMobile
    && !input.leftSidebarCollapsed
    && input.easySyncViewInLeftSidebar;
}

export type SyncProgressNoticeKind =
  | "starting"
  | "stage"
  | "progress"
  | "cancelling";

export interface SyncProgressNoticePresentation {
  kind: SyncProgressNoticeKind;
  activity: SyncActivityPresentation;
  showProgressBar: boolean;
  determinate: boolean;
  percent: number;
  current: number;
  total: number;
}

export function resolveSyncProgressNoticePresentation(
  progress: Readonly<SyncProgressState>,
): SyncProgressNoticePresentation {
  const activity = resolveSyncActivityPresentation(progress);
  const determinate = progress.total > 0;
  const percent = !determinate
    ? 0
    : progress.phase === "verifying"
      ? Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
      : syncProgressPercent(progress);
  let kind: SyncProgressNoticeKind = "stage";
  if (activity.kind === "cancelling") {
    kind = "cancelling";
  } else if (activity.kind === "starting") {
    kind = "starting";
  } else if (
    determinate
    && ["syncing", "uploading", "downloading", "deleting", "renaming"].includes(activity.kind)
  ) {
    kind = "progress";
  }
  return {
    kind,
    activity,
    // Pre-execution stages currently expose status only. Show the bar only
    // after verification or file execution provides a concrete item total.
    showProgressBar: determinate
      && (progress.phase === "verifying" || progress.phase === "executing"),
    determinate,
    percent,
    current: progress.current,
    total: progress.total,
  };
}

export function formatSyncProgressNoticeLabel(
  presentation: SyncProgressNoticePresentation,
  t: SyncStatusTranslator,
): string {
  switch (presentation.kind) {
    case "cancelling":
      return t("notice.sync.cancelling");
    case "progress":
      return t("notice.sync.progress", {
        current: presentation.current,
        total: presentation.total,
      });
    case "stage":
      return t("notice.sync.stage", {
        stage: translateSyncActivity(presentation.activity, t),
      });
    case "starting":
    default:
      return t("notice.sync.start");
  }
}

export function resolveSyncNoticeOutcome(
  result: SyncResult,
  context: { pausedForReview?: boolean; cancelled?: boolean } = {},
): SyncNoticeOutcome | null {
  if (result.authExpired) return { kind: "authExpired", count: 0 };
  if (context.pausedForReview) return { kind: "review", count: 0 };
  if (context.cancelled) return { kind: "cancelled", count: 0 };
  if (result.errors > 0 || !result.success) return { kind: "failed", count: 0 };
  if (result.conflicts > 0) return { kind: "conflicts", count: result.conflicts };
  if (result.deferred > 0) return null;
  const changedFiles = result.uploaded + result.downloaded + result.deleted > 0;
  const healthyNoChange = result.skippedLarge === 0 && result.skippedIgnored === 0;
  if (changedFiles || healthyNoChange) {
    return { kind: "completed", count: 0 };
  }
  return null;
}

export function createSyncProgressNoticeMessage(
  label: string,
  percent: number,
  determinate: boolean,
  showProgressBar = true,
): EasySyncNoticeMessage {
  if (typeof document === "undefined") return label;
  const fragment = document.createDocumentFragment();
  const content = document.createElement("div");
  content.className = "easy-sync-notice-progress-content";
  if (!showProgressBar) {
    content.classList.add("is-text-only");
  }

  const labelEl = document.createElement("div");
  labelEl.className = "easy-sync-notice-progress-label";
  labelEl.textContent = label;
  content.appendChild(labelEl);

  if (showProgressBar) {
    const progressHost = document.createElement("div");
    progressHost.className = "easy-sync-notice-progress-native";
    progressHost.setAttribute("aria-hidden", "true");
    new ProgressBarComponent(progressHost)
      .setValue(determinate ? Math.min(100, Math.max(0, percent)) : 0);
    content.appendChild(progressHost);
  }
  fragment.appendChild(content);
  return fragment;
}
