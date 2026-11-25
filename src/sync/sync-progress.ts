/**
 * SyncProgressStore — Lightweight mutable progress state for the sync view.
 *
 * The SyncExecutor writes progress directly through setPhase/setProgress;
 * main.ts's onProgress/onFileComplete callbacks discard their parameters and
 * only refresh the view. This store is the shared mutable state: the executor
 * writes it, and sync-view.ts reads it during render() to show real-time sync
 * status.
 *
 * No event bus, no subscriptions — just a plain mutable object that the
 * render loop reads each time it fires.
 */

import { SyncActionType, type SyncFileErrorFactV1 } from "./types";
import {
  resolveSyncActionPresentation,
  type SyncActionProgressStatus,
} from "./sync-action-presentation";

/** High-level phase the sync is currently in.
 *
 *  `recovering` / `planningRecords` / `savingPlan` / `committing` are UI
 *  progress phases, not additional round metrics: the round-level
 *  `SyncRunPhase` in executor-metrics.ts stays coarse. */
type SyncPhase =
  | "idle"
  | "scanning"
  | "recovering"
  | "baseline"
  | "preparing"
  | "checking"
  | "planningRecords"
  | "planning"
  | "savingPlan"
  | "establishingSync"
  | "verifying"
  | "executing"
  | "preparingAction"
  | "committing"
  | "done";

/** Every stage count must name what it counts. A unit-less metric can only
 *  render a bare number, which is never useful next to a stage phrase
 *  (2026-11-20 user reports for the remote check and local scan). */
export type SyncPhaseMetricUnit = "items" | "batches";

/**
 * One phase's numeric reading for the existing status counter slot.
 *
 * It is deliberately not `current`/`total` on the round: those two mean
 * "settled plan items" and drive the body progress bar. Phase metrics are
 * counts of the current stage (batches written, recovery records settled) and
 * never mount a progress bar.
 */
interface SyncPhaseMetric {
  /** Settled or observed count so far. */
  current: number;
  /** Known total for this phase, when the source can provide one. */
  total?: number;
  /** Unit suffix for the counter. Required: the counter never renders a bare
   *  number without a stage phrase owning its meaning. */
  unit: SyncPhaseMetricUnit;
}

/** Phases whose numeric slot may fall back to elapsed time when no count is
 *  available. Executing/verifying keep the round's `current/total`; committing
 *  keeps the last settled count. */
export function isPreExecutionSyncPhase(phase: SyncPhase): boolean {
  return phase === "scanning"
    || phase === "recovering"
    || phase === "baseline"
    || phase === "preparing"
    || phase === "checking"
    || phase === "planningRecords"
    || phase === "planning"
    || phase === "savingPlan"
    || phase === "establishingSync"
    || phase === "preparingAction";
}

/** Per-file completion status (for the completed-files list in the view) */
export interface FileProgress {
  path: string;
  /** Previous path for an identity-preserving rename or move. */
  sourcePath?: string;
  status: SyncActionProgressStatus;
  actionType?: SyncActionType;
  reason?: string;
  fileSize?: number;
  /** Wall-clock moment the action failed, for error entries only; absent on
   *  success rows and on history entries persisted before this field. */
  failedAt?: number;
  /** Evidence-only failure facts (A3, 2026-10-26). Absent on success rows and
   *  on history entries written before the field existed; never read by any
   *  decision (see `SyncFileErrorFactV1`). */
  error?: SyncFileErrorFactV1;
}

type RemoteScopeRecoveryFailureStage =
  | "protocol-preflight"
  | "evidence-preflight"
  | "scan"
  | "remote-snapshot"
  | "body-verification"
  | "stability-check"
  | "planning"
  | "authority-commit";

export interface RemoteScopeRecoveryVerificationProgress {
  operationFingerprint: string;
  protocolPreflight: "ready" | "blocked";
  total: number;
  verifiedThisRun: number;
  reused: number;
  invalidated: number;
  remaining: number;
  failureStage?: RemoteScopeRecoveryFailureStage;
  firstFailurePath?: string;
}

export interface RemoteScopeRecoveryVerificationSummary
extends RemoteScopeRecoveryVerificationProgress {
  schemaVersion: 1;
}

export interface SyncProgressState {
  /** Which user-visible workflow owns the current progress/result snapshot. */
  activityKind?: "fullSync" | "sideAction" | "mutationRecovery";
  phase: SyncPhase;
  /** Epoch ms when the current contiguous phase started; a repeated setPhase
   *  with the same phase keeps it. Drives the counter's elapsed reading and the
   *  UI stage reveal window. Optional for state snapshots created before this
   *  field. */
  phaseStartedAt?: number;
  /** Current phase's numeric reading for the existing status counter slot.
   *  Never participates in the round's `current`/`total` or the progress bar. */
  phaseMetric?: SyncPhaseMetric;
  /** Settled item count while executing (an item counts once it finishes,
   *  whatever its outcome — the pool keeps several in flight at once, so
   *  counting starts made the number jump in whole batches); 0 for phase-only
   *  steps. The visible round counter uses `max(current, processedCurrent)`:
   *  `current` remains the durable settlement count and is not changed by the
   *  presentation lookahead. */
  current: number;
  /** Presentation-only lookahead for items whose content work is already done
   *  while their batch checkpoint is still pending (the download pipeline).
   *  It only raises the visible counter/bar and is cleared when the round ends,
   *  so it can never overstate the final result. Optional for callers that do
   *  not prefetch content. */
  processedCurrent?: number;
  /** Total items in the current phase */
  total: number;
  /** File path being processed, or an i18n phase key for phase transitions */
  currentFile: string;
  /** Byte-level progress for the current item (0 when not tracking a single item) */
  currentItemBytes: number;
  currentItemTotalBytes: number;
  /** True after the current item settles and before execution advances. */
  currentItemComplete?: boolean;
  /** Current file action while executing a plan item */
  currentActionType?: SyncActionType;
  /** True after the user requests cancellation and before the run settles */
  cancelRequested: boolean;
  /** Recently completed files (newest last, capped at 100 to avoid unbounded growth) */
  completedFiles: FileProgress[];
  /** True number of completed file actions this run; the retained list above is capped for display. */
  completedCount: number;
  /** Read-only proof progress; these are not completed sync mutations. */
  recoveryVerification?: RemoteScopeRecoveryVerificationProgress;
  /** Epoch ms when the sync started, 0 when idle */
  startedAt: number;
}

const MAX_SUCCESS_FILE_RECORDS = 100;

function isProgressActivityRunning(state: Readonly<SyncProgressState>): boolean {
  return state.startedAt > 0 && state.phase !== "done";
}

export function isAnySyncActivityRunning(
  state: Readonly<SyncProgressState>,
  fullSyncRunning: boolean,
  sideActionRunning: boolean,
): boolean {
  return fullSyncRunning || sideActionRunning || isProgressActivityRunning(state);
}

/** Visible round position: the durable settled count, raised by the download
 *  pipeline's presentation-only processed lookahead. It never decreases within
 *  a round and is cleared with the run, so the final result still comes from
 *  `current`. */
export function resolveRoundProgressCurrent(
  state: Readonly<SyncProgressState>,
): number {
  return Math.max(0, state.current, state.processedCurrent ?? 0);
}

/**
 * Whole-run progress with the current file's byte fraction folded in.
 * The completed share is the visible round position (settled, or the
 * download lookahead when it is ahead); the item still in flight contributes
 * only its byte fraction.
 */
export function syncProgressPercent(state: Readonly<SyncProgressState>): number {
  if (state.total <= 0) return 0;
  const completedItems = resolveRoundProgressCurrent(state);
  const currentFraction = state.currentItemComplete
    ? 0
    : state.currentItemTotalBytes > 0
      ? Math.min(1, Math.max(0, state.currentItemBytes / state.currentItemTotalBytes))
      : 0;
  return Math.min(
    100,
    Math.max(0, Math.round(((completedItems + currentFraction) / state.total) * 100)),
  );
}

export function retainFileProgress(files: FileProgress[]): FileProgress[] {
  let successesToSkip = Math.max(
    0,
    files.filter((file) => isSuccessfulFileProgress(file)).length
      - MAX_SUCCESS_FILE_RECORDS,
  );

  return files.filter((file) => {
    if (!isSuccessfulFileProgress(file)) return true;
    if (successesToSkip > 0) {
      successesToSkip--;
      return false;
    }
    return true;
  });
}

export class SyncProgressStore {
  private _state: SyncProgressState;

  constructor() {
    this._state = {
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
      startedAt: 0,
    };
  }

  get state(): Readonly<SyncProgressState> {
    return this._state;
  }

  /** Reset to idle */
  reset(): void {
    this._state = {
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
      startedAt: 0,
    };
  }

  /** Set the current phase (also resets progress counters for the new phase).
   *
   *  A repeated call with the same phase keeps `phaseStartedAt`: the reveal
   *  window and elapsed reading belong to the contiguous phase, not to the
   *  call. `markStarted`/`finish` clear it, so a new round still forces a
   *  fresh start even when its first phase has the same name.
   *
   *  `keepCounts` is only for the post-transfer commit phase: the round's
   *  settled `current/total` must stay visible while the last file is no
   *  longer "current", so the file/byte slots are cleared but the counter is
   *  preserved.
   *
   *  `keepCompleted` is for switching a side-action batch from its preparation
   *  phase to its action phase: earlier rows in the same batch must stay. */
  setPhase(
    phase: SyncPhase,
    options?: { keepCounts?: boolean; keepCompleted?: boolean },
  ): void {
    const phaseChanged = this._state.phase !== phase;
    this._state.phase = phase;
    if (phaseChanged || !this._state.phaseStartedAt) {
      this._state.phaseStartedAt = Date.now();
    }
    if (options?.keepCounts !== true) {
      this._state.current = 0;
      this._state.total = 0;
    }
    this._state.currentFile = "";
    this._state.currentItemBytes = 0;
    this._state.currentItemTotalBytes = 0;
    this._state.currentItemComplete = false;
    this._state.currentActionType = undefined;
    this._state.phaseMetric = undefined;
    this._state.processedCurrent = undefined;
    if (phase === "executing" && options?.keepCompleted !== true) {
      this._state.completedFiles = [];
      this._state.completedCount = 0;
    }
  }

  /** Publish the current phase's numeric reading into the existing counter
   *  slot. Values are clamped to non-negative integers; a total below the
   *  current count is lifted so the visible `x/y` never reads backwards. */
  setPhaseMetric(metric: SyncPhaseMetric): void {
    const current = Number.isFinite(metric.current)
      ? Math.max(0, Math.floor(metric.current))
      : 0;
    const total = metric.total !== undefined && Number.isFinite(metric.total)
      ? Math.max(current, Math.floor(metric.total))
      : undefined;
    this._state.phaseMetric = {
      current,
      ...(total !== undefined ? { total } : {}),
      unit: metric.unit,
    };
  }

  /** Update progress within the current phase.
   *
   *  `knownTotalBytes` is the size the plan already knows for this item. It is
   *  not transfer progress: an item that cannot report intermediate bytes
   *  (mobile whole-body fallbacks, non-streaming transports) still gets an
   *  honest `0 / size` row from its first visible moment instead of an empty
   *  right-hand slot. Real byte callbacks then advance it through
   *  `setByteProgress`. */
  setProgress(
    current: number,
    total: number,
    currentFile: string,
    currentActionType?: SyncActionType,
    knownTotalBytes?: number,
  ): void {
    // A phase that reports real plan-item progress owns the counter now;
    // drop any stage count left over from the preceding pre-execution phase.
    this._state.phaseMetric = undefined;
    const itemChanged = this._state.current !== current
      || this._state.currentFile !== currentFile
      || this._state.currentActionType !== currentActionType;
    if (itemChanged) {
      this._state.currentItemBytes = 0;
      this._state.currentItemTotalBytes =
        knownTotalBytes !== undefined
        && Number.isFinite(knownTotalBytes)
        && knownTotalBytes > 0
          ? Math.max(0, Math.floor(knownTotalBytes))
          : 0;
      this._state.currentItemComplete = false;
    }
    this._state.current = current;
    this._state.total = total;
    this._state.currentFile = currentFile;
    this._state.currentActionType = currentActionType;
  }

  /** Raise the visible round counter ahead of settlement for content that is
   *  already downloaded (download pipeline). Presentation only: `current`
   *  stays the durable settled count, the lookahead never decreases and is
   *  cleared with the phase/run, so the final result cannot overstate. */
  setProcessedCurrent(count: number): void {
    const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const bounded = this._state.total > 0
      ? Math.min(next, this._state.total)
      : next;
    this._state.processedCurrent = Math.max(
      this._state.processedCurrent ?? 0,
      bounded,
    );
  }

  requestCancel(): void {
    this._state.cancelRequested = true;
  }

  finish(): void {
    this._state.phase = "done";
    this._state.phaseStartedAt = 0;
    this._state.currentFile = "";
    this._state.currentItemBytes = 0;
    this._state.currentItemTotalBytes = 0;
    this._state.currentItemComplete = false;
    this._state.currentActionType = undefined;
    this._state.phaseMetric = undefined;
    this._state.processedCurrent = undefined;
    this._state.cancelRequested = false;
  }

  /** Record a completed file */
  addCompletedFile(file: FileProgress): void {
    this._state.completedFiles = retainFileProgress([
      ...this._state.completedFiles,
      file,
    ]);
    this._state.completedCount++;
  }

  /**
   * Flip a row that was already reported as done: the file's own work happened,
   * but the shared batch checkpoint it belongs to did not commit (failed, or
   * the round was cancelled before it ran), so the shown success does not hold.
   * The row keeps its place, action type and its one settled-action count; it
   * gains the failure status and the reason, because a shown success must never
   * vanish silently. Presentation only — the mutation ledger and the next
   * round's receipt recovery own the actual settlement.
   */
  revertCompletedFile(path: string, reason: string): boolean {
    const files = this._state.completedFiles;
    for (let index = files.length - 1; index >= 0; index--) {
      const file = files[index];
      if (file.path !== path || !isSuccessfulFileProgress(file)) continue;
      this._state.completedFiles = [
        ...files.slice(0, index),
        { ...file, status: "error", reason, failedAt: Date.now() },
        ...files.slice(index + 1),
      ];
      return true;
    }
    return false;
  }

  /** Update byte-level progress for the current file */
  setByteProgress(bytes: number, total: number): void {
    const reportedBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
    const reportedTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
    const nextBytes = Math.max(this._state.currentItemBytes, reportedBytes);
    const nextTotal = Math.max(
      this._state.currentItemTotalBytes,
      reportedTotal,
      nextBytes,
    );
    this._state.currentItemBytes = nextBytes;
    this._state.currentItemTotalBytes = nextTotal;
    this._state.currentItemComplete = false;
  }

  /** Mark the current plan item as settled without fabricating byte progress. */
  completeCurrentItem(): void {
    this._state.currentItemComplete = true;
  }

  setRecoveryVerification(
    progress: RemoteScopeRecoveryVerificationProgress,
  ): void {
    this._state.recoveryVerification = structuredClone(progress);
  }

  /** Mark the sync as started */
  markStarted(
    activityKind: "fullSync" | "sideAction" | "mutationRecovery" = "fullSync",
  ): void {
    this._state.activityKind = activityKind;
    this._state.startedAt = Date.now();
    this._state.phaseStartedAt = 0;
    this._state.cancelRequested = false;
    this._state.completedFiles = [];
    this._state.completedCount = 0;
    this._state.recoveryVerification = undefined;
    this._state.phaseMetric = undefined;
    this._state.processedCurrent = undefined;
  }

  /** Resume the visible side-action result batch without erasing earlier decisions. */
  resumeSideActionBatch(): void {
    this._state.activityKind = "sideAction";
    this._state.phase = "executing";
    this._state.phaseStartedAt = Date.now();
    this._state.currentFile = "";
    this._state.currentItemBytes = 0;
    this._state.currentItemTotalBytes = 0;
    this._state.currentItemComplete = false;
    this._state.currentActionType = undefined;
    this._state.phaseMetric = undefined;
    this._state.processedCurrent = undefined;
    this._state.cancelRequested = false;
    if (this._state.startedAt === 0) this._state.startedAt = Date.now();
  }

  /** Map a SyncActionType to a FileProgress status string */
  static actionToStatus(type: SyncActionType): FileProgress["status"] {
    return resolveSyncActionPresentation(type).progressStatus;
  }
}

export function isSuccessfulFileProgress(file: FileProgress): boolean {
  return file.status === "upload"
    || file.status === "download"
    || file.status === "folder"
    || file.status === "delete";
}
