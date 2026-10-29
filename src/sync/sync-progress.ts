/**
 * SyncProgressStore — Lightweight mutable progress state for the sync view.
 *
 * The SyncExecutor already computes per-file progress (current, total, path),
 * but main.ts currently discards the parameters. This store bridges the gap:
 * main.ts writes progress data in onProgress/onFileComplete callbacks, and
 * sync-view.ts reads it during render() to show real-time sync status.
 *
 * No event bus, no subscriptions — just a plain mutable object that the
 * render loop reads each time it fires.
 */

import { SyncActionType, type SyncFileErrorFactV1 } from "./types";
import {
  resolveSyncActionPresentation,
  type SyncActionProgressStatus,
} from "./sync-action-presentation";

/** High-level phase the sync is currently in */
type SyncPhase =
  | "idle"
  | "scanning"
  | "baseline"
  | "preparing"
  | "checking"
  | "planning"
  | "verifying"
  | "executing"
  | "done";

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
  /** Settled item count while executing (an item counts once it finishes,
   *  whatever its outcome — the pool keeps several in flight at once, so
   *  counting starts made the number jump in whole batches); 0 for phase-only
   *  steps. */
  current: number;
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
  /** Recently completed files (newest last, capped at 50 to avoid unbounded growth) */
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

/**
 * Whole-run progress with the current file's byte fraction folded in.
 * `current` counts settled items (a settled item is done regardless of its
 * outcome), so the completed share is `current` itself; the item still in
 * flight contributes only its byte fraction.
 */
export function syncProgressPercent(state: Readonly<SyncProgressState>): number {
  if (state.total <= 0) return 0;
  const completedItems = Math.max(0, state.current);
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

  /** Set the current phase (also resets progress counters for the new phase) */
  setPhase(phase: SyncPhase): void {
    this._state.phase = phase;
    this._state.current = 0;
    this._state.total = 0;
    this._state.currentFile = "";
    this._state.currentItemBytes = 0;
    this._state.currentItemTotalBytes = 0;
    this._state.currentItemComplete = false;
    this._state.currentActionType = undefined;
    if (phase === "executing") {
      this._state.completedFiles = [];
      this._state.completedCount = 0;
    }
  }

  /** Update progress within the current phase */
  setProgress(
    current: number,
    total: number,
    currentFile: string,
    currentActionType?: SyncActionType,
  ): void {
    const itemChanged = this._state.current !== current
      || this._state.currentFile !== currentFile
      || this._state.currentActionType !== currentActionType;
    if (itemChanged) {
      this._state.currentItemBytes = 0;
      this._state.currentItemTotalBytes = 0;
      this._state.currentItemComplete = false;
    }
    this._state.current = current;
    this._state.total = total;
    this._state.currentFile = currentFile;
    this._state.currentActionType = currentActionType;
  }

  requestCancel(): void {
    this._state.cancelRequested = true;
  }

  finish(): void {
    this._state.phase = "done";
    this._state.currentFile = "";
    this._state.currentItemBytes = 0;
    this._state.currentItemTotalBytes = 0;
    this._state.currentItemComplete = false;
    this._state.currentActionType = undefined;
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
    this._state.cancelRequested = false;
    this._state.completedFiles = [];
    this._state.completedCount = 0;
    this._state.recoveryVerification = undefined;
  }

  /** Resume the visible side-action result batch without erasing earlier decisions. */
  resumeSideActionBatch(): void {
    this._state.activityKind = "sideAction";
    this._state.phase = "executing";
    this._state.currentFile = "";
    this._state.currentItemBytes = 0;
    this._state.currentItemTotalBytes = 0;
    this._state.currentItemComplete = false;
    this._state.currentActionType = undefined;
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
