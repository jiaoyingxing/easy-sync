import {
  classifyRetryableObservationResult,
  type SyncResult,
} from "../sync/sync-executor";
import type { FileProgress } from "../sync/sync-progress";
import type { SyncHistoryStatus } from "../sync/state-manager";
import { SyncActionType } from "../sync/types";
import type { LocaleStrings } from "../i18n/types";

export interface SyncPendingAttentionCounts {
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
 */
export function resolveSyncPendingAttentionCounts(
  totalConflicts: number,
  files: readonly Pick<FileProgress, "actionType">[],
): SyncPendingAttentionCounts {
  const remoteDeletes = Math.min(
    Math.max(0, totalConflicts),
    files.filter(
      (file) => file.actionType === SyncActionType.ConfirmLocalDelete,
    ).length,
  );
  return {
    conflicts: Math.max(0, totalConflicts - remoteDeletes),
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
 * A run is visibly complete only when no action remains failed, conflicted,
 * deferred, or skipped. This presentation contract deliberately does not
 * change executor control flow or automatic-sync policy.
 */
export function isSyncResultFullyComplete(result: SyncResult): boolean {
  return result.success
    && !result.authExpired
    && result.errors === 0
    && result.conflicts === 0
    && result.deferred === 0
    && result.skippedLarge === 0
    && result.skippedIgnored === 0;
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
  if (observation.kind === "valid") return "failed";
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
