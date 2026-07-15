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

import { SyncActionType } from "./types";

/** High-level phase the sync is currently in */
export type SyncPhase =
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
  status: "upload" | "download" | "delete" | "conflict" | "skip" | "error";
  actionType?: SyncActionType;
  reason?: string;
  fileSize?: number;
}

export interface SyncProgressState {
  phase: SyncPhase;
  /** Current item index (1-based during execution, 0 for phase-only steps) */
  current: number;
  /** Total items in the current phase */
  total: number;
  /** File path being processed, or an i18n phase key for phase transitions */
  currentFile: string;
  /** Byte-level progress for the current item (0 when not tracking a single item) */
  currentItemBytes: number;
  currentItemTotalBytes: number;
  /** Current file action while executing a plan item */
  currentActionType?: SyncActionType;
  /** True after the user requests cancellation and before the run settles */
  cancelRequested: boolean;
  /** Recently completed files (newest last, capped at 50 to avoid unbounded growth) */
  completedFiles: FileProgress[];
  /** Epoch ms when the sync started, 0 when idle */
  startedAt: number;
}

export const MAX_SUCCESS_FILE_RECORDS = 100;

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
      cancelRequested: false,
      completedFiles: [],
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
      cancelRequested: false,
      completedFiles: [],
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
    this._state.currentActionType = undefined;
    if (phase === "executing") {
      this._state.completedFiles = [];
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
    this._state.currentActionType = undefined;
    this._state.cancelRequested = false;
  }

  /** Record a completed file */
  addCompletedFile(file: FileProgress): void {
    this._state.completedFiles = retainFileProgress([
      ...this._state.completedFiles,
      file,
    ]);
  }

  /** Update byte-level progress for the current file */
  setByteProgress(bytes: number, total: number): void {
    this._state.currentItemBytes = bytes;
    this._state.currentItemTotalBytes = total;
  }

  /** Mark the sync as started */
  markStarted(): void {
    this._state.startedAt = Date.now();
    this._state.cancelRequested = false;
    this._state.completedFiles = [];
  }

  /** Map a SyncActionType to a FileProgress status string */
  static actionToStatus(type: SyncActionType): FileProgress["status"] {
    switch (type) {
      case SyncActionType.Upload:
        return "upload";
      case SyncActionType.Download:
        return "download";
      case SyncActionType.DeleteRemote:
        return "delete";
      case SyncActionType.RenameRemote:
        return "upload";
      case SyncActionType.Conflict:
      case SyncActionType.ConfirmLocalDelete:
        return "conflict";
      case SyncActionType.SkipLargeFile:
      case SyncActionType.SkipIgnoredPath:
        return "skip";
      default:
        return "error";
    }
  }
}

function isSuccessfulFileProgress(file: FileProgress): boolean {
  return file.status === "upload"
    || file.status === "download"
    || file.status === "delete";
}
