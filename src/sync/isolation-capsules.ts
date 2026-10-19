import { isAtOrBelowPath, normalizeRemotePathKey } from "./canonical-plan-v2";
import { isOrdinaryFileRecoveryRecord } from "./conservative-reset-recovery";
import { isFolderMutationIntent } from "./folder-state-reducer-v2";
import type { SyncStateEnvelopeV2 } from "./state-envelope-v2";
import type { MutationLedgerEntryV1, SyncScope } from "./types";
import { sameSyncScope } from "./types";

/**
 * S2 — the shape-agnostic isolation channel (docs 2026-10-16 §五 D4／§六 S2,
 * original wording in the 2026-08-14 first-principles calibration's fifth
 * class; user decision 2026-10-17).
 *
 * Contract: any blocked item whose facts are stable but for which no safe
 * disposition exists may be **isolated** — the ledger record is kept, its
 * whole path family is frozen, every other path syncs as usual, automatic
 * sync continues, and the item reaches one explicit ending (S4). This module
 * owns the *admission* half of that channel: the channel itself is
 * shape-blind, and every shape is admitted only by a *capsule* that proves
 * its own narrowest bounded evidence.
 *
 * A capsule answers exactly one question: **can this record's effects be
 * proved to stay inside an enumerable path family that the freeze covers?**
 * It never claims the receipt is true (absorption stays the reducer's job,
 * fail-closed and unchanged), never relaxes a receipt-shape gate, and never
 * authorises a content action. Being admitted means "freezing this is safe
 * and bounded", nothing more.
 *
 * Refusal is always fail-closed: a record no capsule admits keeps its
 * existing whole-vault behaviour. The registry is deliberately a list of
 * named capsules rather than a widened predicate, so a future shape adds its
 * own bounded-evidence proof here — with its own tests and its own refusals —
 * instead of another `||` in a caller.
 *
 * The freeze's boundary construction (`isolatedMutationRecoveryBoundary` /
 * `isNamespaceProtectedByIsolatedRecovery` in `sync-executor.ts`) is already
 * shape-agnostic: it freezes every path and identity a record enumerates, in
 * every direction. This module is the admission half the folder-record cut
 * first had to special-case; S2 made it the general home for every shape.
 */
export type IsolationCapsuleId =
  | "ordinary-file-bounded-receipt"
  | "folder-bounded-receipt"
  | "folder-verified-refused-absorption";

export interface IsolationAdmissionContext {
  record: Readonly<MutationLedgerEntryV1>;
  syncScope: Readonly<SyncScope>;
  envelope: SyncStateEnvelopeV2 | null;
  /**
   * Round fact for the third blocking point: this recovery pass verified the
   * record's durable receipt against the live two-sided facts
   * (`verifyMutationReceipt` returned true) and only the committed common
   * state then refused to absorb its checkpoint. Written by the executor at
   * that exact site and cleared per recovery pass; never persisted.
   */
  verifiedReceiptRefusedAbsorption: boolean;
}

/**
 * First admitting capsule wins; the order only decides which shape the
 * diagnostics report (the standard capsules first, so the third capsule
 * appears exactly when its extra evidence is what admitted the record).
 */
const ISOLATION_CAPSULES: readonly {
  id: IsolationCapsuleId;
  admits: (context: IsolationAdmissionContext) => boolean;
}[] = [
  {
    id: "ordinary-file-bounded-receipt",
    admits: (context) =>
      isOrdinaryFileRecoveryRecord(context.record, context.syncScope),
  },
  {
    id: "folder-bounded-receipt",
    admits: folderBoundedReceiptAdmits,
  },
  {
    id: "folder-verified-refused-absorption",
    admits: folderVerifiedRefusedAbsorptionAdmits,
  },
];

/** The capsule (if any) that admits this record for isolation. */
export function isolationCapsuleAdmits(
  context: IsolationAdmissionContext,
): IsolationCapsuleId | null {
  for (const capsule of ISOLATION_CAPSULES) {
    if (capsule.admits(context)) return capsule.id;
  }
  return null;
}

/**
 * Isolation-only bound for a **folder** recovery record (criterion ③ of the
 * 2026-10-17 folder-isolation cut, moved here verbatim by S2). Deliberately
 * *not* a change to `isOrdinaryFileRecoveryRecord` /
 * `conservativeResetReceiptIsBounded`: those two are consumed by seven other
 * admission surfaces (receipt shape gate, abandon gate,
 * `fileMutationCheckpointIsReflected`, reset admission) that have nothing to
 * do with isolation, and the folder shapes below are only safe to *freeze*,
 * never to reduce to a reset capsule.
 *
 * The question answered here is narrow and evidence-only: can this record's
 * receipt affect anything outside the record's own source/target subtree?
 * It does **not** claim the receipt is true — it claims the receipt cannot
 * reach unrelated work, which is exactly what isolating it needs. The
 * receipt's real absorption stays the reducer's job (fail-closed, unchanged);
 * this only decides whether the freeze may stay local.
 *
 * Admitted shapes (all clauses must hold):
 *
 *  - a **move** (`moveLocalFolder` / `moveRemoteFolder`) receipt with exactly
 *    one `folderUpserts` entry at the intent path naming the record's own
 *    folder identity (the shape `reduceFolderMove` itself demands), or a
 *    **delete** (`deleteLocalFolder` / `deleteRemoteFolder`) receipt with
 *    exactly one `folderDeletes` entry at the intent path naming that same
 *    identity. Both producers agree: `persistPlanItemMutationReceipt` writes
 *    the plan item's single folder effect, and every recovery-side
 *    reconstruction (`classifyUnreceiptedFolderMutation`,
 *    `folderDeleteCheckpoint`, `folderMutationCheckpoint`) writes the entry it
 *    inspected *at the intent path* with the intent's own id.
 *  - no file-state effects at all (`baseUpserts` / `baseRemovals` /
 *    `remoteUpserts` / `remoteDeletes` / `pendingConflictRemovals` /
 *    `pendingDeleteRemovals` empty). A folder record mixing file state has a
 *    write surface beyond its own folder object, so it is refused.
 *  - every identity named by `folderMoveHintRemovals` must still be nameable
 *    in the committed folder anchors, at or below the record's own
 *    `sourcePath ∪ path` subtree. These ids are how a folder move consumes
 *    the local rename hints of the folders it carried; proving them inside
 *    the frozen region is what keeps an isolation from owing anything
 *    outside it.
 *
 * Refused on purpose (fail-closed: today's whole-vault behaviour, no
 * half-open freeze):
 *
 *  - **creates** (`createLocalFolder` / `createRemoteFolder`): the created
 *    identity is new, so nothing in the committed state can name it, and the
 *    create branch of the folder reducer is not a field-reported stick point.
 *    The third capsule below admits creates only when the round itself
 *    proved the receipt live.
 *  - **unreceipted** folder records: no receipt, so no evidence to bound.
 *  - records with `manualResolution`, a foreign scope, or a receipt whose
 *    operationId does not match the intent.
 *  - any hint identity that a committed state rebuild no longer names (an
 *    unprovable surface is never assumed to be inside the subtree).
 */
function folderBoundedReceiptAdmits(
  context: IsolationAdmissionContext,
): boolean {
  const { record, syncScope, envelope } = context;
  const { intent, receipt } = record;
  if (
    !receipt
    || !isFolderMutationIntent(intent)
    || intent.action === "createLocalFolder"
    || intent.action === "createRemoteFolder"
    || receipt.operationId !== intent.operationId
    || record.manualResolution !== undefined
    || !sameSyncScope(intent.scope, syncScope)
  ) return false;
  const checkpoint = receipt.checkpoint;
  if (
    checkpoint.baseUpserts.length > 0
    || checkpoint.baseRemovals.length > 0
    || checkpoint.remoteUpserts.length > 0
    || checkpoint.remoteDeletes.length > 0
    || checkpoint.pendingConflictRemovals.length > 0
    || checkpoint.pendingDeleteRemovals.length > 0
  ) return false;
  const ownIds = new Set<string>([
    ...(intent.folderId ? [intent.folderId] : []),
    ...(intent.expectedRemote.exists
      ? [intent.expectedRemote.driveId]
      : []),
  ]);
  if (ownIds.size === 0) return false;
  const ownPathKey = normalizeRemotePathKey(intent.path);
  const upserts = checkpoint.folderUpserts ?? [];
  const deletes = checkpoint.folderDeletes ?? [];
  const isMove = intent.action === "moveLocalFolder"
    || intent.action === "moveRemoteFolder";
  if (
    isMove
      ? upserts.length !== 1 || deletes.length !== 0
      : deletes.length !== 1 || upserts.length !== 0
  ) return false;
  if (
    upserts.some((entry) =>
      normalizeRemotePathKey(entry.path) !== ownPathKey
      || !ownIds.has(entry.driveId))
    || deletes.some((entry) =>
      normalizeRemotePathKey(entry.path) !== ownPathKey
      || !ownIds.has(entry.driveId))
  ) return false;
  const consumedHintIds = checkpoint.folderMoveHintRemovals ?? [];
  if (consumedHintIds.length === 0) return true;
  if (!envelope?.folderAnchors) return false;
  const sourceRoot = intent.sourcePath ?? intent.path;
  const anchors = Object.values(envelope.folderAnchors.byAnchorId);
  return consumedHintIds.every((remoteId) => {
    const anchor = anchors.find((candidate) =>
      candidate.remoteId === remoteId);
    return anchor !== undefined
      && (
        isAtOrBelowPath(anchor.lastPath, sourceRoot)
        || isAtOrBelowPath(anchor.lastPath, intent.path)
      );
  });
}

/**
 * Third capsule (S2, 2026-10-17) — the **third blocking point** shape named
 * by the 2026-10-16 F29 treatment plan §四.3: the record's durable receipt
 * was verified against the live two-sided facts in this very recovery pass
 * (`receiptMatches === true`), and only the committed common state refused to
 * absorb its checkpoint. That is strictly more evidence than any other
 * blocked shape holds: the world itself was just read and it agrees with the
 * receipt, while the committed tree cannot express it.
 *
 * The extra evidence is what lets this capsule admit the **create**
 * directions that `folder-bounded-receipt` refuses (甲刀 residual ②:
 * "文件夹创建与「拒绝远端删除后重建」两种收据形状维持整库停摆"). Verification
 * for a folder create proves the folder named by the receipt exists *right
 * now* at both sides at `intent.path` with the receipt's own identity and
 * parent, so the record's effect surface is one folder inside its own path
 * family — even though a newly created identity can never be named by the
 * committed state. The freeze is path-based, so it covers that family
 * without needing the identity.
 *
 * Everything else stays exactly as narrow as the folder capsule: the receipt
 * must be shaped the way the reducer itself demands for its action, no
 * file-state effects, exactly one folder effect at the intent path with the
 * action's own identity binding, and every consumed move-hint identity
 * nameable in the committed folder anchors inside the record's own subtree.
 * Nothing here is a general "verified receipt may be isolated" rule: a
 * verified receipt whose effects cannot be bounded stays blocked.
 *
 * Refused on purpose (fail-closed, whole-vault as before):
 *
 *  - anything without the round fact — a structurally refused receipt that
 *    was never verified against live facts (for example a malformed one) is
 *    not evidence of anything and keeps the existing whole-vault failure;
 *  - records whose receipt effect left the intent path, mixes file state,
 *    has no single folder effect, or names an identity other than the
 *    action's own;
 *  - `manualResolution` records (they have a real exit, not an isolation);
 *  - foreign scope, mismatch operation ids, or hint identities the committed
 *    folder anchors no longer name inside the subtree.
 */
function folderVerifiedRefusedAbsorptionAdmits(
  context: IsolationAdmissionContext,
): boolean {
  const { record, syncScope, envelope } = context;
  if (!context.verifiedReceiptRefusedAbsorption) return false;
  const { intent, receipt } = record;
  if (
    !receipt
    || !isFolderMutationIntent(intent)
    || receipt.operationId !== intent.operationId
    || record.manualResolution !== undefined
    || !sameSyncScope(intent.scope, syncScope)
  ) return false;
  const checkpoint = receipt.checkpoint;
  if (
    checkpoint.baseUpserts.length > 0
    || checkpoint.baseRemovals.length > 0
    || checkpoint.remoteUpserts.length > 0
    || checkpoint.remoteDeletes.length > 0
    || checkpoint.pendingConflictRemovals.length > 0
    || checkpoint.pendingDeleteRemovals.length > 0
  ) return false;
  const upserts = checkpoint.folderUpserts ?? [];
  const deletes = checkpoint.folderDeletes ?? [];
  const effectShapeIsReplayable = (): boolean => {
    if (
      intent.action === "createLocalFolder"
      || intent.action === "createRemoteFolder"
      || intent.action === "moveLocalFolder"
      || intent.action === "moveRemoteFolder"
    ) {
      if (upserts.length !== 1 || deletes.length !== 0) return false;
      // The reducer demands the receipt carry its single target folder at
      // the intent path, bound to the plan's parent and, per action, to the
      // record's own identity; every clause below mirrors those demands, so
      // a refusal of this shape is about the committed world, never about a
      // malformed receipt.
      if (
        upserts[0].path !== intent.path
        || upserts[0].parentId !== intent.expectedParent.driveId
      ) return false;
      if (
        intent.action === "createLocalFolder"
        && (
          !intent.expectedRemote.exists
          || upserts[0].driveId !== intent.expectedRemote.driveId
        )
      ) return false;
      if (
        intent.action === "createRemoteFolder"
        && intent.expectedRemote.exists
      ) return false;
      if (
        intent.action === "moveLocalFolder"
        || intent.action === "moveRemoteFolder"
      ) {
        if (
          !intent.sourcePath
          || !intent.folderId
          || !intent.expectedRemote.exists
          || upserts[0].driveId !== intent.folderId
          || upserts[0].driveId !== intent.expectedRemote.driveId
        ) return false;
      }
      return true;
    }
    if (
      intent.action === "deleteLocalFolder"
      || intent.action === "deleteRemoteFolder"
    ) {
      return deletes.length === 1
        && upserts.length === 0
        && Boolean(intent.folderId)
        && deletes[0].path === intent.path
        && deletes[0].driveId === intent.folderId;
    }
    return false;
  };
  // The effect path is pinned to the intent path by the shape clauses above
  // (exactly as the reducer demands), and every other enumerated surface is
  // an identity, not a path — so the record's whole effect family is the
  // `sourcePath ∪ path` subtrees the freeze covers.
  if (!effectShapeIsReplayable()) return false;
  const sourceRoot = intent.sourcePath ?? intent.path;
  const consumedHintIds = checkpoint.folderMoveHintRemovals ?? [];
  if (consumedHintIds.length === 0) return true;
  if (!envelope?.folderAnchors) return false;
  const anchors = Object.values(envelope.folderAnchors.byAnchorId);
  return consumedHintIds.every((remoteId) => {
    const anchor = anchors.find((candidate) =>
      candidate.remoteId === remoteId);
    return anchor !== undefined
      && (
        isAtOrBelowPath(anchor.lastPath, sourceRoot)
        || isAtOrBelowPath(anchor.lastPath, intent.path)
      );
  });
}
