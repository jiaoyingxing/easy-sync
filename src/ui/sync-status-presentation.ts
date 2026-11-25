import type { LocaleStrings } from "../i18n/types";
import {
  isPreExecutionSyncPhase,
  type SyncPhaseMetricUnit,
  type SyncProgressState,
} from "../sync/sync-progress";
import {
  resolveSyncActionPresentation,
  type SyncActionActivityKind,
} from "../sync/sync-action-presentation";

type SyncActivityKind =
  | "starting"
  | "scanning"
  | "recovering"
  | "preparing"
  | "baseline"
  | "checking"
  | "planningRecords"
  | "planning"
  | "savingPlan"
  | "establishingSync"
  | "verifying"
  | "recovery"
  | "syncing"
  | "preparingAction"
  | "committing"
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
 *
 * This is the raw projection. Dense visual surfaces (sidebar status line and
 * Notice) wrap it with `resolveVisibleSyncActivityPresentation` so a stage name
 * only replaces the shown phrase after it has been readable. The Ribbon keeps
 * the raw projection: its Tooltip/aria-label may expose the exact stage even
 * while the visual line is still coalescing.
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
      labelKey: "progress.recoveringOperations",
    };
  }
  if (progress.recoveryVerification) {
    const recovery = progress.recoveryVerification;
    // Early scope recovery is still scope observation / local scan / remote
    // enumeration. Only the body-verification stage (or a known candidate
    // total) is really "verifying cloud files"; before that the phase's own
    // short name is the honest label.
    if (
      recovery.total > 0
      || recovery.verifiedThisRun > 0
      || recovery.reused > 0
      || recovery.failureStage === "body-verification"
    ) {
      return {
        kind: "verifying",
        labelKey: "progress.remoteScopeRecovery",
      };
    }
  }

  switch (progress.phase) {
    case "scanning":
      return { kind: "scanning", labelKey: "progress.scanningLocal" };
    case "recovering":
      return {
        kind: "recovering",
        labelKey: "progress.recoveringOperations",
      };
    case "preparing":
      return { kind: "preparing", labelKey: "progress.preparingRemote" };
    case "baseline":
      return { kind: "baseline", labelKey: "progress.loadingBaseline" };
    case "checking":
      return { kind: "checking", labelKey: "progress.checkingRemote" };
    case "planningRecords":
      return {
        kind: "planningRecords",
        labelKey: "progress.preparingRecords",
      };
    case "planning":
      return { kind: "planning", labelKey: "progress.generatingPlan" };
    case "savingPlan":
      return { kind: "savingPlan", labelKey: "progress.savingPlan" };
    case "establishingSync":
      return {
        kind: "establishingSync",
        labelKey: "progress.establishingSync",
      };
    case "preparingAction":
      return {
        kind: "preparingAction",
        labelKey: "progress.preparingAction",
      };
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
    case "committing":
      return {
        kind: "committing",
        labelKey: "progress.savingSyncResult",
      };
    case "idle":
    case "done":
    default:
      return { kind: "starting", labelKey: "syncView.progress" };
  }
}

/** How long a stage with readable information must run before its name may
 *  replace the shown phrase. 300ms is the shortest window a changed label can
 *  be read reliably; below it the paint is only a flash. */
const SYNC_ACTIVITY_DETAIL_REVEAL_MS = 300;

/** How long a silent internal transition must run before its name may replace
 *  the shown phrase. These stages have no count and no durable commitment to
 *  read. Two seconds avoids painting a stage that is already near the end of a
 *  short no-change round (the Android 0-change round measured ~1.6s); a stage
 *  that really is waiting still shows well before the five-second clock. */
const SYNC_ACTIVITY_SILENT_REVEAL_MS = 2_000;

/** How long a count-less pre-execution stage must run before the existing
 *  numeric slot falls back to elapsed time. A short stage does not need a
 *  clock, and "已用 0:00" is never useful. */
const SYNC_ACTIVITY_ELAPSED_REVEAL_MS = 5_000;

function hasMeaningfulPhaseCount(
  progress: Readonly<SyncProgressState>,
): boolean {
  const metric = progress.phaseMetric;
  if (!metric) return false;
  return metric.current > 0 || (metric.total ?? 0) > 0;
}

/** A stage carries something the user can read (a count, a durable
 *  commitment, verification or recovery work) rather than being a silent
 *  internal transition. */
function isSyncActivityDetailState(
  progress: Readonly<SyncProgressState>,
): boolean {
  if (
    progress.phase === "verifying"
    || progress.phase === "savingPlan"
    || progress.phase === "establishingSync"
    || progress.phase === "recovering"
    || progress.phase === "preparingAction"
    || (progress.phase === "committing" && progress.total > 0)
    || hasMeaningfulPhaseCount(progress)
  ) {
    return true;
  }
  const recovery = progress.recoveryVerification;
  return Boolean(
    recovery
    && (
      recovery.total > 0
      || recovery.verifiedThisRun > 0
      || recovery.reused > 0
      || recovery.failureStage === "body-verification"
    ),
  );
}

const SYNC_ACTIVITY_STAGE_KINDS: ReadonlySet<SyncActivityKind> = new Set([
  "scanning",
  "recovering",
  "preparing",
  "baseline",
  "checking",
  "planningRecords",
  "planning",
  "savingPlan",
  "establishingSync",
  "preparingAction",
  "verifying",
  "recovery",
  "committing",
]);

function isSyncActivityStageKind(kind: SyncActivityKind): boolean {
  return SYNC_ACTIVITY_STAGE_KINDS.has(kind);
}

/**
 * Remaining time before the current stage may replace the shown status phrase.
 * 0 means "show it now": cancellation, a dedicated recovery run and a file
 * action already in flight are direct feedback; idle/done keep the generic
 * starting phrase.
 */
export function resolveSyncActivityRevealDelay(
  progress: Readonly<SyncProgressState>,
  now = Date.now(),
): number {
  if (progress.cancelRequested) return 0;
  if (progress.activityKind === "mutationRecovery") return 0;
  if (progress.phase === "idle" || progress.phase === "done") return 0;
  // Executing exposes either a concrete action (direct feedback) or the
  // generic running phrase; there is no stage name to gate.
  if (progress.phase === "executing") return 0;
  const windowMs = isSyncActivityDetailState(progress)
    ? SYNC_ACTIVITY_DETAIL_REVEAL_MS
    : SYNC_ACTIVITY_SILENT_REVEAL_MS;
  const startedAt = progress.phaseStartedAt && progress.phaseStartedAt > 0
    ? progress.phaseStartedAt
    : progress.startedAt;
  // Snapshots without a usable start time cannot be measured; show the stage
  // instead of treating NaN as a young window.
  if (!(startedAt > 0)) return 0;
  return Math.max(0, windowMs - Math.max(0, now - startedAt));
}

const GENERIC_SYNC_ACTIVITY: SyncActivityPresentation = {
  kind: "syncing",
  labelKey: "syncView.progress",
};

/**
 * The stateless projection for callers that do not keep a previous stage.
 * While the current stage is still inside its reveal window the generic running
 * phrase is returned; `SyncActivityRevealer` is the stateful surface policy
 * that keeps the last stable stage instead of blanking to this phrase.
 */
export function resolveVisibleSyncActivityPresentation(
  progress: Readonly<SyncProgressState>,
  now = Date.now(),
): SyncActivityPresentation {
  if (resolveSyncActivityRevealDelay(progress, now) > 0) {
    return GENERIC_SYNC_ACTIVITY;
  }
  return resolveSyncActivityPresentation(progress);
}

interface SyncActivityReveal {
  presentation: SyncActivityPresentation;
  /** False when the presentation is the last stable stage kept through a young
   *  stage's reveal window. */
  current: boolean;
}

/**
 * Keeps a status phrase readable across short transitions: a stable stage stays
 * on screen while the next stage is still inside its reveal window, instead of
 * blanking to the generic phrase and back. A concrete action, cancellation,
 * idle/done or the generic executing phrase starts a new line. An empty
 * executing phase keeps the last stable stage because it has no file action of
 * its own; a real executing phase clears it so a later commit cannot revive a
 * stale pre-execution stage.
 */
export class SyncActivityRevealer {
  private stable: {
    presentation: SyncActivityPresentation;
    startedAt: number;
  } | null = null;

  resolve(
    progress: Readonly<SyncProgressState>,
    now = Date.now(),
  ): SyncActivityReveal {
    const raw = resolveSyncActivityPresentation(progress);
    if (this.stable && this.stable.startedAt !== progress.startedAt) {
      this.stable = null;
    }
    if (!isSyncActivityStageKind(raw.kind)) {
      if (
        raw.kind === "syncing"
        && progress.phase === "executing"
        && progress.total <= 0
        && progress.currentActionType === undefined
      ) {
        return {
          presentation: this.stable?.presentation ?? GENERIC_SYNC_ACTIVITY,
          current: false,
        };
      }
      this.stable = null;
      return { presentation: raw, current: true };
    }
    if (resolveSyncActivityRevealDelay(progress, now) <= 0) {
      this.stable = { presentation: raw, startedAt: progress.startedAt };
      return { presentation: raw, current: true };
    }
    if (this.stable) {
      return { presentation: this.stable.presentation, current: false };
    }
    return { presentation: GENERIC_SYNC_ACTIVITY, current: false };
  }

  reset(): void {
    this.stable = null;
  }
}

export function translateSyncActivity(
  presentation: SyncActivityPresentation,
  t: SyncStatusTranslator,
): string {
  return t(presentation.labelKey, presentation.params);
}

/** Numeric reading for the existing status counter slot. */
export type SyncActivityMetric =
  | {
      kind: "count";
      current: number;
      total?: number;
      unit: SyncPhaseMetricUnit;
    }
  | { kind: "elapsed"; startedAt: number };

/**
 * Resolve the one number the status counter should show while a phase has no
 * plan-item progress of its own.
 *
 * Priority stays in the caller: recovery verification and the round's
 * `current/total` win over this metric. A meaningful phase count wins over
 * elapsed and appears only with its stage name; a bare zero (no denominator)
 * never occupies the slot. When a pre-execution stage has no readable count,
 * elapsed appears only after five silent seconds so slow work and a stalled
 * request do not look identical without showing a meaningless `0:00`.
 */
export function resolveSyncActivityMetric(
  progress: Readonly<SyncProgressState>,
  now = Date.now(),
): SyncActivityMetric | null {
  const phaseMetric = progress.phaseMetric;
  const meaningfulCount = hasMeaningfulPhaseCount(progress);
  if (
    phaseMetric
    && meaningfulCount
    && resolveSyncActivityRevealDelay(progress, now) <= 0
  ) {
    return {
      kind: "count",
      current: phaseMetric.current,
      ...(phaseMetric.total !== undefined ? { total: phaseMetric.total } : {}),
      unit: phaseMetric.unit,
    };
  }
  // A zero without a denominator is not information and must not promote a
  // silent stage or flash before its name; the stage may still reveal its name
  // after the silent window and fall back to elapsed five seconds in.
  if (meaningfulCount) return null;
  if (
    progress.startedAt > 0
    && progress.phase !== "done"
    && isPreExecutionSyncPhase(progress.phase)
    && progress.total <= 0
    && (
      progress.recoveryVerification === undefined
      || progress.recoveryVerification.total <= 0
    )
  ) {
    const startedAt = progress.phaseStartedAt && progress.phaseStartedAt > 0
      ? progress.phaseStartedAt
      : progress.startedAt;
    if (now - startedAt >= SYNC_ACTIVITY_ELAPSED_REVEAL_MS) {
      return { kind: "elapsed", startedAt };
    }
  }
  return null;
}

/** `m:ss` below an hour, `h:mm:ss` above it. */
export function formatElapsedClock(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(
    0,
    Math.floor((now - startedAt) / 1000),
  );
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * Visible counter text for one metric. Count units reuse the existing
 * `syncView.progress.items` wording for plan items; batches/files/plain read
 * as the stage text already names the object.
 */
export function translateSyncActivityMetric(
  metric: SyncActivityMetric,
  t: SyncStatusTranslator,
  now = Date.now(),
): string {
  if (metric.kind === "elapsed") {
    return t("syncView.progress.elapsed", {
      time: formatElapsedClock(metric.startedAt, now),
    });
  }
  const { current, total, unit } = metric;
  if (unit === "batches") {
    return total !== undefined
      ? t("syncView.progress.batches", { current, total })
      : t("syncView.progress.countBatches", { count: current });
  }
  return total !== undefined
    ? t("syncView.progress.items", { current, total })
    : t("syncView.progress.countItems", { count: current });
}

/** Accessible description for the same counter text. */
export function resolveSyncActivityMetricAria(
  metric: SyncActivityMetric,
  t: SyncStatusTranslator,
  now = Date.now(),
): string {
  if (metric.kind === "elapsed") {
    return t("syncView.progress.elapsedAria", {
      time: formatElapsedClock(metric.startedAt, now),
    });
  }
  const { current, total, unit } = metric;
  if (unit === "batches") {
    return total !== undefined
      ? t("syncView.progress.batchesAria", { current, total })
      : t("syncView.progress.countBatchesAria", { count: current });
  }
  return total !== undefined
    ? t("syncView.progress.itemsAria", { current, total })
    : t("syncView.progress.countItemsAria", { count: current });
}

export function trimSyncActivityLabel(label: string): string {
  return label.replace(/(?:…|\.\.\.)$/, "").trimEnd();
}
