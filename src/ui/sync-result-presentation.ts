import {
  classifyRetryableObservationResult,
  type SyncResult,
} from "../sync/sync-executor";
import type { FileProgress } from "../sync/sync-progress";
import type { SyncHistoryStatus } from "../sync/state-manager";
import { SyncActionType } from "../sync/types";
import type { LocaleStrings } from "../i18n/types";

interface SyncPendingAttentionCounts {
  conflicts: number;
  remoteDeletes: number;
}

type SyncResultTranslator = (
  key: keyof LocaleStrings,
  params?: Record<string, string | number>,
) => string;

/**
 * The executor intentionally keeps ConfirmLocalDelete in the historical
 * `conflicts` control count. User-facing surfaces recover the exact meaning
 * from the concrete action type without changing that compatibility contract.
 *
 * `remoteDeletePending` is the executor's direct split (A2, 2026-10-26). New
 * history entries pass it so the numbers stay right even when the retained
 * `files` rows no longer carry every ConfirmLocalDelete row (success rows have
 * a 100-entry retention cap). Legacy entries omit it and fall back to counting
 * the action rows — the pre-existing inference, kept verbatim.
 */
export function resolveSyncPendingAttentionCounts(
  totalConflicts: number,
  files: readonly Pick<FileProgress, "actionType">[],
  remoteDeletePending?: number,
): SyncPendingAttentionCounts {
  const total = Math.max(0, totalConflicts);
  if (typeof remoteDeletePending === "number" && Number.isFinite(remoteDeletePending)) {
    const direct = Math.min(total, Math.max(0, remoteDeletePending));
    return {
      conflicts: total - direct,
      remoteDeletes: direct,
    };
  }
  const remoteDeletes = Math.min(
    total,
    files.filter(
      (file) => file.actionType === SyncActionType.ConfirmLocalDelete,
    ).length,
  );
  return {
    conflicts: total - remoteDeletes,
    remoteDeletes,
  };
}

/**
 * Refine only the executor's ordinary conflict summary. Explicit recovery,
 * review, cancellation and failure messages remain authoritative.
 */
export function formatSyncResultMessage(
  result: SyncResult,
  files: readonly Pick<FileProgress, "actionType">[],
  t: SyncResultTranslator,
): string {
  if (result.conflicts <= 0) return result.message;
  const genericConflictMessage = t("result.conflictsPending", {
    conflicts: result.conflicts,
  });
  if (result.message !== genericConflictMessage) return result.message;

  const pending = resolveSyncPendingAttentionCounts(
    result.conflicts,
    files,
    // Executor's direct split wins when present; legacy results without it
    // keep the action-row inference above.
    result.remoteDeletePending,
  );
  if (pending.remoteDeletes === 0) return result.message;
  if (pending.conflicts === 0) {
    return t("result.remoteDeletesPending", {
      deletes: pending.remoteDeletes,
    });
  }
  return t("result.conflictsAndRemoteDeletesPending", {
    conflicts: pending.conflicts,
    deletes: pending.remoteDeletes,
  });
}

/**
 * A run is visibly complete when no action remains failed, conflicted, or
 * deferred. Skips produced by the user's own configuration (size exclusion,
 * ignored paths) are expected zero-action outcomes — 2026-09-16 拍板与跳过项
 * 退出待处理账本同层同据 — so they do not read as incompleteness here; their
 * per-file rows and the round message still carry the detail. This
 * presentation contract deliberately does not change executor control flow
 * or automatic-sync policy.
 */
export function isSyncResultFullyComplete(result: SyncResult): boolean {
  return result.success
    && !result.authExpired
    && result.errors === 0
    && result.conflicts === 0
    && result.deferred === 0;
}

export function resolveSyncHistoryStatus(
  result: SyncResult,
  context: { cancelled?: boolean; completedFileCount?: number } = {},
): SyncHistoryStatus {
  if (context.cancelled || result.runFacts?.termination === "cancelled") {
    return "cancelled";
  }
  if (result.authExpired) return "authExpired";
  const observation = classifyRetryableObservationResult(result, context);
  // A run that stopped before ordinary planning on a transient remote read is
  // a neutral retry-pending round, not a failure: auto-sync keeps retrying and
  // no file action was produced (P0-UX / 08-21 observation contract).
  if (observation.kind === "valid") return "retry-pending";
  if (result.errors > 0) {
    const completedActions =
      result.uploaded
      + result.downloaded
      + result.deleted
      + (result.foldersCreated ?? 0)
      + (result.foldersMoved ?? 0)
      + (result.foldersDeleted ?? 0)
      + (result.filesMoved ?? 0)
      + (context.completedFileCount ?? 0);
    return completedActions > 0 ? "partial" : "failed";
  }
  if (!result.success) return "failed";
  return isSyncResultFullyComplete(result) ? "success" : "partial";
}
