/**
 * Why a manual resolution entry (the "确认" chip on one pending row) cannot
 * open right now. The entry getters used to answer this question with `null`
 * alone, so every caller reported the one cause it could name — "facts
 * changed" — even when a sync round was merely running or the state layer was
 * still busy recovering.
 *
 * This file owns that single classification; the callers own wording.
 */
export type ManualResolutionEntryReason =
  /** The entry may open. */
  | "ready"
  /** An ordinary sync round is running. */
  | "round-running"
  /** Another resolution action from the same queue is in flight. */
  | "action-in-flight"
  /** This device has not prepared V2 sync state yet. */
  | "state-unprepared"
  /** Sync state cannot be loaded safely; the ordinary recovery flow owns it. */
  | "state-load-blocked"
  /** Remote scope recovery is still pending. */
  | "scope-recovery"
  /** Recovery evidence is unreadable, so the review facts cannot be trusted. */
  | "evidence-corrupt"
  /** The reviewed facts are no longer current, or cannot be re-derived. */
  | "facts-changed"
  /**
   * The local and remote names are identity-equal but not byte-equal (letter
   * case or Unicode normalisation only), so the pair can never be confirmed as
   * one folder while it stays like this.
   */
  | "name-mismatch";

export interface ManualResolutionEntrySnapshot<T> {
  snapshot: T | null;
  reason: ManualResolutionEntryReason;
  /**
   * Set with `name-mismatch`: the folder in the reviewed chain whose local and
   * cloud names differ, so the user can rename the right one.
   */
  nameMismatchPath?: string;
}

/**
 * Entry-gate classification. The flag set mirrors the guards the entry getters
 * already applied — the returned reason is the only new information, so who
 * may open an entry does not change here.
 */
export function classifyManualResolutionEntry(flags: {
  running: boolean;
  sideActionsInFlight: boolean;
  v2StateActive: boolean;
  mutationLedgerCorruption: boolean;
  stateLoadRecoveryBlock: boolean;
  remoteScopeRecovery: boolean;
}): ManualResolutionEntryReason {
  if (flags.running) return "round-running";
  if (flags.sideActionsInFlight) return "action-in-flight";
  if (!flags.v2StateActive) return "state-unprepared";
  if (flags.mutationLedgerCorruption) return "evidence-corrupt";
  if (flags.stateLoadRecoveryBlock) return "state-load-blocked";
  if (flags.remoteScopeRecovery) return "scope-recovery";
  return "ready";
}
