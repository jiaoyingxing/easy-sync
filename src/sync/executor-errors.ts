/**
 * Executor error classes — moved verbatim out of `sync-executor.ts`
 * (分解刀 4, pure move + export). `sync-executor.ts` imports every member;
 * no logic, message text or field changed.
 */

import type { SyncScope, MutationRecoveryRunSummary } from "./types";
import type { RemoteVaultScopeIdentityFailureReason } from "../onedrive/types";

export class IncrementalRemoteHierarchyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncrementalRemoteHierarchyError";
  }
}

export class MutationRecoveryBlockedError extends Error {
  constructor(
    readonly summary: MutationRecoveryRunSummary,
    cause: Error,
  ) {
    super(cause.message);
    this.name = "MutationRecoveryBlockedError";
  }
}

export type V2CommittedScopeLossReason =
  | "graph-not-found"
  | RemoteVaultScopeIdentityFailureReason;

export class V2CommittedScopeUnreachableError extends Error {
  constructor(
    readonly observedScope: SyncScope | null,
    readonly causeReason: V2CommittedScopeLossReason,
  ) {
    super("Committed V2 remote scope is unreachable");
    this.name = "V2CommittedScopeUnreachableError";
  }
}

/** Marks a failure that happened before the reviewed target was mutated. */
export class MutationNotAppliedError extends Error {
  constructor(
    readonly original: unknown,
    readonly noticeAlreadyShown = false,
  ) {
    super(original instanceof Error ? original.message : "Reviewed mutation was not applied");
    this.name = "MutationNotAppliedError";
  }
}

/** A selected plugin bundle upload would move the remote bundle to an older
 *  version. Typed so recovery routing can recognise the downgrade without
 *  matching the user-visible message; the message stays byte-identical
 *  because `error-presentation.ts` presents it by prefix. */
export class CommunityPluginBundleDowngradeError extends Error {
  constructor(readonly pluginId: string) {
    super(`Selected plugin upload would downgrade remote bundle: ${pluginId}`);
    this.name = "CommunityPluginBundleDowngradeError";
  }
}

/** Local CAS failed before commitDownloadedTempFile touched the target. */
export class LocalCommitPreconditionError extends Error {}

/**
 * The local write itself did not land: our own truncation, a write that left
 * the reviewed version in place, or content we cannot attribute. Still a
 * precondition error for every caller that defers.
 *
 * `localStateUncertain` marks the sub-cases where the attempt may have left the
 * local file modified (rollback failed, or the read-back was unattributable or
 * missing). Only when it is false may a user-facing message say the file was
 * not changed (`DECISIONS` 2026-09-23 point 9③④⑤).
 */
export class LocalWriteNotLandedError extends LocalCommitPreconditionError {
  constructor(message: string, readonly localStateUncertain = false) {
    super(message);
    this.name = "LocalWriteNotLandedError";
  }
}

/** Local file changed after DeleteLocal was planned but before deletion began. */
export class LocalVersionChangedBeforeDeleteError extends Error {
  constructor(path: string) {
    super(`Local version changed before deletion: ${path}`);
    this.name = "LocalVersionChangedBeforeDeleteError";
  }
}

/** The downloaded bytes belong to a remote version that is no longer current. */
export class DownloadRemoteVersionChangedError extends Error {
  constructor(path: string) {
    super(`Remote version changed during download: ${path}`);
    this.name = "DownloadRemoteVersionChangedError";
  }
}

/** The body we received no longer matches the remote item's declared size —
 *  the same content race as DownloadRemoteVersionChangedError caught at the
 *  other guard (the declared size was read before the rewrite). Deferred like
 *  the version-changed case; the next round replans from the newer remote. */
export class DownloadedPayloadSizeMismatchError extends Error {
  constructor(path: string, downloadedSize: number, declaredSize: number) {
    super(
      `Downloaded size mismatch: ${path} (${downloadedSize} != ${declaredSize})`,
    );
    this.name = "DownloadedPayloadSizeMismatchError";
  }
}

/** A local folder create was invoked but its result could not be confirmed
 *  after bounded settle re-reads. The failure-classification chain still
 *  re-reads both sides before deciding not-applied vs checkpoint. */
export class LocalFolderCreateUnconfirmedError extends Error {
  constructor(path: string) {
    super(`Local folder create read-back failed: ${path}`);
    this.name = "LocalFolderCreateUnconfirmedError";
  }
}
