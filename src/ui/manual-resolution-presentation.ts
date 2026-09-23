import type { ManualResolutionEntryReason } from "../sync/manual-resolution-entry";

/**
 * Which sentence one manual resolution chip shows when it cannot open.
 * `entry` keeps the honest entry-gate wording shared by every chip;
 * `facts-changed` and `name-mismatch` stay with the calling family, which owns
 * the row path and the folder name that differs.
 */
export type ManualResolutionNotice =
  | { kind: "entry"; key: string }
  | { kind: "facts-changed" }
  | { kind: "name-mismatch" };

export function resolveManualResolutionNotice(
  reason: ManualResolutionEntryReason,
): ManualResolutionNotice {
  switch (reason) {
    case "round-running":
      return { kind: "entry", key: "result.alreadyRunning" };
    case "action-in-flight":
      return { kind: "entry", key: "result.lockBusy" };
    case "state-unprepared":
      return { kind: "entry", key: "notice.v2MigrationRequired" };
    case "state-load-blocked":
      return { kind: "entry", key: "result.v2StateLoadBlocked" };
    case "scope-recovery":
      return { kind: "entry", key: "result.v2ScopeRecoveryPending" };
    case "evidence-corrupt":
      return { kind: "entry", key: "notice.sideActionPendingWork" };
    case "name-mismatch":
      return { kind: "name-mismatch" };
    default:
      return { kind: "facts-changed" };
  }
}
