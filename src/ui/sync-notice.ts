import { ProgressBarComponent } from "obsidian";
import type { SyncResult } from "../sync/sync-executor";
import {
  isSyncResultFullyComplete,
  resolveSyncPendingAttentionCounts,
} from "./sync-result-presentation";
import {
  syncProgressPercent,
  type FileProgress,
  type RemoteScopeRecoveryVerificationProgress,
  type SyncProgressState,
} from "../sync/sync-progress";
import type { EasySyncNoticeMessage } from "./notice-center";
import {
  resolveSyncActivityPresentation,
  trimSyncActivityLabel,
  translateSyncActivity,
  type SyncActivityPresentation,
  type SyncStatusTranslator,
} from "./sync-status-presentation";

export type SyncNoticeOutcomeKind =
  | "completed"
  | "conflicts"
  | "remoteDeletes"
  | "mixedPending"
  | "review"
  | "cancelled"
  | "failed"
  | "authExpired";

export interface SyncNoticeOutcome {
  kind: SyncNoticeOutcomeKind;
  count: number;
  remoteDeletes?: number;
  message?: string;
}

export function shouldSuppressSyncNoticeForVisibleSidebar(input: {
  leftSidebarCollapsed: boolean;
  easySyncViewVisibleInLeftSidebar: boolean;
}): boolean {
  return !input.leftSidebarCollapsed
    && input.easySyncViewVisibleInLeftSidebar;
}

export type SyncProgressNoticeKind =
  | "starting"
  | "stage"
  | "recovery"
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
  recoveryVerification?: RemoteScopeRecoveryVerificationProgress;
}

export function resolveSyncProgressNoticePresentation(
  progress: Readonly<SyncProgressState>,
): SyncProgressNoticePresentation {
  const activity = resolveSyncActivityPresentation(progress);
  const recoveryVerification = progress.recoveryVerification;
  const recoveryCurrent = recoveryVerification
    ? recoveryVerification.reused + recoveryVerification.verifiedThisRun
    : 0;
  const recoveryDeterminate = Boolean(
    recoveryVerification && recoveryVerification.total > 0,
  );
  const current = recoveryDeterminate ? recoveryCurrent : progress.current;
  const total = recoveryDeterminate
    ? recoveryVerification!.total
    : progress.total;
  const determinate = total > 0;
  const percent = !determinate
    ? 0
    : recoveryDeterminate || progress.phase === "verifying"
      ? Math.min(100, Math.max(0, Math.round((current / total) * 100)))
      : syncProgressPercent(progress);
  let kind: SyncProgressNoticeKind = "stage";
  if (activity.kind === "cancelling") {
    kind = "cancelling";
  } else if (activity.kind === "starting") {
    kind = "starting";
  } else if (recoveryDeterminate) {
    kind = "recovery";
  } else if (determinate && progress.phase === "executing") {
    kind = "progress";
  }
  return {
    kind,
    activity,
    // Pre-execution stages currently expose status only. Show the bar only
    // after verification or file execution provides a concrete item total.
    showProgressBar: determinate
      && (recoveryDeterminate
        || progress.phase === "verifying"
        || progress.phase === "executing"),
    determinate,
    percent,
    current,
    total,
    ...(recoveryVerification ? { recoveryVerification } : {}),
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
      if (presentation.activity.kind !== "syncing") {
        return t("notice.sync.actionProgress", {
          action: trimSyncActivityLabel(
            translateSyncActivity(presentation.activity, t),
          ),
          current: presentation.current,
          total: presentation.total,
        });
      }
      return t("notice.sync.progress", {
        current: presentation.current,
        total: presentation.total,
      });
    case "recovery": {
      const recovery = presentation.recoveryVerification!;
      return t("notice.sync.remoteScopeRecovery", {
        current: recovery.reused + recovery.verifiedThisRun,
        total: recovery.total,
      });
    }
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
  completedFiles: readonly Pick<FileProgress, "actionType">[] = [],
): SyncNoticeOutcome | null {
  if (result.authExpired) return { kind: "authExpired", count: 0 };
  if (context.pausedForReview) return { kind: "review", count: 0 };
  if (context.cancelled) return { kind: "cancelled", count: 0 };
  if (result.errors > 0 || !result.success) {
    return {
      kind: "failed",
      count: 0,
      ...(result.remoteScopeRecovery?.failureStage && result.message
        ? { message: result.message }
        : {}),
    };
  }
  if (result.conflicts > 0) {
    const pending = resolveSyncPendingAttentionCounts(
      result.conflicts,
      completedFiles,
    );
    if (pending.remoteDeletes > 0 && pending.conflicts === 0) {
      return { kind: "remoteDeletes", count: pending.remoteDeletes };
    }
    if (pending.remoteDeletes > 0) {
      return {
        kind: "mixedPending",
        count: pending.conflicts,
        remoteDeletes: pending.remoteDeletes,
      };
    }
    return { kind: "conflicts", count: result.conflicts };
  }
  if (isSyncResultFullyComplete(result)) {
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
  const fragment = createFragment();
  const content = createDiv();
  content.className = "easy-sync-notice-progress-content";
  if (!showProgressBar) {
    content.classList.add("is-text-only");
  }

  const labelEl = createDiv();
  labelEl.className = "easy-sync-notice-progress-label";
  labelEl.textContent = label;
  content.appendChild(labelEl);

  if (showProgressBar) {
    const progressHost = createDiv();
    progressHost.className = "easy-sync-notice-progress-native";
    progressHost.setAttribute("aria-hidden", "true");
    new ProgressBarComponent(progressHost)
      .setValue(determinate ? Math.min(100, Math.max(0, percent)) : 0);
    content.appendChild(progressHost);
  }
  fragment.appendChild(content);
  return fragment;
}
