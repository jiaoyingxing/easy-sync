/**
 * S4 termination-criterion blade — per-item fact fingerprints and a
 * "this blocked item is spinning" verdict (docs 2026-10-16 §五 D3／§六 S4
 * row; original wording in docs/archive/2026-08/20260814-1155 分类合同＋
 * 重检资格; user decision 2026-10-17).
 *
 * Contract: every blocked item (unfinished recovery record, pending issue,
 * re-check entry) must reach one of three endings in a bounded number of
 * rounds — automatic completion / one user decision / an explicit
 * non-retryable diagnosis. When one item's facts are identical across two
 * consecutive observed rounds and it carries no explicit external
 * dependency, it must leave the "temporary" state: a real manual exit stays
 * as the single decision, and an item without any safe disposition is
 * reported as a non-retryable diagnosis instead of another re-check.
 *
 * Boundary (hard): this module only *classifies and remembers*. It performs
 * no data action, relaxes no safety gate, and no sync decision may consume
 * its verdicts. Verdicts are presentation state, held in memory for the
 * plugin-instance lifetime and deliberately not persisted: after a reload a
 * verdict again takes two freshly observed rounds (conservative, accepted —
 * the same rule S1 already documents for its streak).
 *
 * Per-item fingerprint (the D3 binding, per the 2026-08-14 wording): the
 * shared scope, the committed baseline revision (`stateCommitSeq`), the plan
 * review revision, and the item's own canonical row/record — which carries
 * its identity, local content summary and remote id/version facts. Rows are
 * canonicalized with the S1 serializer, so per-round wall-clock stamps
 * (`updatedAt`), breaker bookkeeping (`consecutiveFailures`) and expiring
 * Graph tokens (`downloadUrl`) are excluded exactly as they are for the
 * round fingerprint: a re-derived identical row is not a fact change.
 *
 * Reverse controls (must stay green): an item whose own bound facts change
 * between rounds never concludes; a network-class deferral or any item with
 * a live external dependency never concludes and keeps its retry entry.
 */

import {
  buildSyncRoundFingerprint,
  canonicalize,
  stableHash64,
  type SyncIdleObservationInput,
} from "./sync-idle-observation";
import type { PendingIssue } from "./state-manager";
import { SyncActionType } from "./types";
import type { MutationRecoveryBlockReason } from "./types";

/**
 * Which ending an item can reach right now, resolved by the caller from the
 * live exits (never guessed here):
 * - `retryable-external` — an explicit external dependency or a bounded
 *   automatic re-observation (network class, auth wait, breaker back-off,
 *   scope/account object under someone else's control): re-checking may
 *   obtain new evidence, so the retry entry legitimately stays.
 * - `by-design-skip` — a row the product skips on purpose (size / ignored
 *   path / unsupported name); its copy is already terminal.
 * - `user-decision` — facts stable and a real current manual exit exists:
 *   the single decision the item is waiting for.
 * - `non-retryable` — facts stable and no safe disposition exists.
 *
 * 两个字面量联合体刻意不导出（导出面门：无人点名就不对外提供；2026-10-16
 * 批次① 导出面收敛纪律）：读者用 {@link SyncBlockedItemRoundFact} 的
 * `disposition` 或判决的 `outcome` 字段即可，无需引用别名。
 */
type SyncBlockedItemDisposition =
  | "retryable-external"
  | "by-design-skip"
  | "user-decision"
  | "non-retryable";

/** The two terminal endings an item can be concluded with. */
type SyncItemTerminationOutcome = "user-decision" | "non-retryable";

/** One blocked item as it exists at the end of a round. */
export interface SyncBlockedItemRoundFact {
  /** Stable identity of the item across rounds (see the key helpers). */
  key: string;
  /** Path shown in the diagnosis line. */
  path: string;
  disposition: SyncBlockedItemDisposition;
}

/** Round input: the exact facts S1 observes, plus one entry per blocked
 *  item. Reusing {@link SyncIdleObservationInput} is what keeps the two
 *  blades on one definition of "a fact". */
export interface SyncItemTerminationRoundInput
  extends SyncIdleObservationInput {
  items: readonly SyncBlockedItemRoundFact[];
}

export interface SyncItemTerminationVerdict {
  key: string;
  path: string;
  outcome: SyncItemTerminationOutcome;
  /** Consecutive identical rounds observed when the item concluded. */
  streak: number;
  /** The item's per-item fact fingerprint at conclusion — the "same facts"
   *  the terminal statement is bound to. */
  fingerprint: string;
}

/** Diagnostic sink; one line per item the first round it concludes. */
type SyncItemTerminationDiag = (
  message: "sync item termination concluded",
  data: {
    schemaVersion: 1;
    key: string;
    path: string;
    outcome: SyncItemTerminationOutcome;
    streak: number;
    fingerprint: string;
  },
) => void;

/** Reason-key prefix of the engine's own bounded breaker back-off rows
 *  (`reason.circuitBreaker*`). These rows are the environment's wait, not a
 *  stuck object, so they keep their retry entry. */
const BREAKER_DEFERRAL_REASON_PREFIX = "reason.circuitBreaker";

/** Skip actions are by-design terminal rows, not blocked items. */
const BY_DESIGN_SKIP_ACTION_TYPES: ReadonlySet<string> = new Set([
  SyncActionType.SkipLargeFile,
  SyncActionType.SkipIgnoredPath,
  SyncActionType.SkipOneDriveInvalidName,
]);

/** How many consecutive identical rounds make one item's facts "stable". */
const REQUIRED_STABLE_ROUNDS = 2;

const ITEM_FINGERPRINT_SCHEMA = "sync-item-fact-fingerprint-v1";

/**
 * Stable per-item key for one pending-issue row. The sidebar row key is
 * built from the same string, so a verdict can never attach to a different
 * row than the one it was concluded for.
 */
export function pendingIssueTerminationKey(
  issue: Pick<PendingIssue, "actionType" | "issueCode" | "path">,
): string {
  return `issue:${issue.actionType}:${issue.issueCode ?? ""}:${issue.path}`;
}

/** Stable per-item key for one unfinished recovery record. */
export function mutationRecoveryItemKey(operationId: string): string {
  return `ledger:${operationId}`;
}

/** Exit kinds a pending-issue row can actually offer right now (the
 *  renderer's chip branches). `null` = no renderable exit. */
export type PendingIssueExitKind =
  | "stale-identity"
  | "shared-folder-identity"
  | "empty-folder-review"
  | "folder-location"
  | "scope-crossing";

const STALE_IDENTITY_ISSUE_CODES: ReadonlySet<string> = new Set([
  "identity-replacement-ambiguous",
  "anchored-folder-missing-remote",
  "local-rename-evidence-conflict",
  "local-subtree-changed",
  "remote-subtree-changed",
  "target-occupied",
  "parent-chain-incomplete",
]);

/**
 * Which exit one pending-issue row can render right now, or `null` when the
 * row carries no real exit. Single source of truth: the sidebar derives its
 * chips from this function and the termination verdict derives "has a live
 * manual exit" from the same call (UI 资格与判定资格必须来自同一判断,
 * docs/archive/2026-08/20260814-1155 UI 合同).
 */
export function pendingIssueExitKind(
  issueCode: PendingIssue["issueCode"],
  scopeCrossingExitKind: "folder" | "file" | null,
): PendingIssueExitKind | null {
  if (issueCode === "scope-crossing") {
    return scopeCrossingExitKind === null ? null : "scope-crossing";
  }
  if (issueCode === "unanchored-shared-folder") {
    return "shared-folder-identity";
  }
  if (issueCode === "anchored-folder-missing-local") {
    return "empty-folder-review";
  }
  if (issueCode === "folder-location-choice") {
    return "folder-location";
  }
  if (issueCode !== undefined && STALE_IDENTITY_ISSUE_CODES.has(issueCode)) {
    return "stale-identity";
  }
  return null;
}

/**
 * Disposition of one pending-issue row. Only rows that (a) are real blocked
 * items, (b) carry no external dependency and (c) have no live exit can ever
 * end as a non-retryable diagnosis. A missing exit plus an external
 * dependency (network class, breaker back-off, an object outside the sync
 * scope) keeps the existing re-check qualification untouched.
 */
export function resolvePendingIssueDisposition(input: {
  issueCode: PendingIssue["issueCode"];
  actionType: PendingIssue["actionType"];
  reason?: string;
  hasRenderableExit: boolean;
}): SyncBlockedItemDisposition {
  if (BY_DESIGN_SKIP_ACTION_TYPES.has(input.actionType)) {
    return "by-design-skip";
  }
  // One-way retained-folder note: the folder is intentionally kept while
  // local content survives. It is an explanation, not a blocked item, so it
  // must never turn into the "two identical rounds, cannot finish" diagnosis.
  if (input.issueCode === "one-way-folder-retained") {
    return "by-design-skip";
  }
  if (
    input.issueCode === "transfer-network"
    || input.issueCode === "transfer-remote-moving"
  ) {
    return "retryable-external";
  }
  if (input.reason?.startsWith(BREAKER_DEFERRAL_REASON_PREFIX) === true) {
    return "retryable-external";
  }
  if (input.issueCode === "scope-crossing") {
    // A scope-crossing row without a covering move hint has no destination
    // evidence: the object itself left the sync scope (or the settings
    // changed), so the row waits on an external fact and renders no retry
    // entry at all — there is nothing doomed to remove.
    return input.hasRenderableExit ? "user-decision" : "retryable-external";
  }
  return input.hasRenderableExit ? "user-decision" : "non-retryable";
}

/**
 * Disposition of one unfinished recovery record. `roundExternalDependency`
 * covers the round-level waits (a dead token, an unavailable network: the
 * round itself declares the block retryable). Scope/account block reasons
 * name an object the user controls outside EasySync, and their exits
 * ("恢复同步位置" / "换回原账号") stay live.
 *
 * `blockReason === null` (the round carried no block classification at all)
 * is judged by the same rule: with no visible review exit the record ends as
 * a non-retryable diagnosis, and the sidebar only shows that diagnosis when
 * its own exit lookup says there is no exit (the presentation option is
 * consulted inside the no-exit branch alone) — so a live exit can never be
 * contradicted by the terminal line.
 */
export function resolveMutationRecoveryDisposition(input: {
  roundExternalDependency: boolean;
  blockReason: MutationRecoveryBlockReason | null | undefined;
  /** The live review exit (`manualResolutionExitAllowedFor` ＋ the
   *  executor's own `canResolveMutationRecovery`), resolved by the caller so
   *  no second eligibility rule exists here. */
  manualResolutionAvailable: boolean;
}): SyncBlockedItemDisposition {
  if (input.roundExternalDependency) return "retryable-external";
  if (
    input.blockReason === "scope-changed"
    || input.blockReason === "account-changed"
  ) {
    return "retryable-external";
  }
  return input.manualResolutionAvailable ? "user-decision" : "non-retryable";
}

/** One item as tracked across rounds. */
interface TrackedBlockedItem {
  fingerprint: string;
  disposition: SyncBlockedItemDisposition;
  /** Consecutive rounds this item was observed with unchanged facts. */
  streak: number;
  verdict: SyncItemTerminationVerdict | null;
}

/** Per-item fact fingerprint: the shared round parts (scope / baseline /
 *  review) plus the item's own canonical row. */
function itemFingerprint(
  sharedParts: { scope: string; baseline: string; review: string },
  row: unknown,
): string {
  return stableHash64(
    [
      ITEM_FINGERPRINT_SCHEMA,
      sharedParts.scope,
      sharedParts.baseline,
      sharedParts.review,
      `item=${JSON.stringify(canonicalize(row, 24))}`,
    ].join("\n"),
  );
}

/**
 * In-memory per-item termination tracker. `observe` is called once at round
 * end; `snapshot`/`get` are read by the presentation layer only.
 */
export class SyncItemTerminationTracker {
  private items = new Map<string, TrackedBlockedItem>();

  /**
   * Observe one round. Returns the verdicts concluded in this round (i.e.
   * items that just reached their ending); verdicts concluded in earlier
   * rounds stay readable through {@link snapshot} without being re-reported,
   * which is what makes the outcome appear exactly once.
   */
  observe(
    input: SyncItemTerminationRoundInput,
    diag?: SyncItemTerminationDiag,
  ): SyncItemTerminationVerdict[] {
    // Healthy round (no blocked item at all): nothing to fingerprint, and
    // every earlier verdict belongs to an item the world already resolved.
    // Returning early keeps the common path free of the canonicalization.
    if (input.items.length === 0) {
      this.items.clear();
      return [];
    }
    const parts = buildSyncRoundFingerprint(input).parts;
    const shared = {
      scope: parts.scope,
      baseline: parts.baseline,
      review: parts.review,
    };
    const rowsByIdentity = this.collectItemRows(input);
    const concluded: SyncItemTerminationVerdict[] = [];
    const next = new Map<string, TrackedBlockedItem>();
    for (const item of input.items) {
      const fingerprint = itemFingerprint(
        shared,
        rowsByIdentity.get(item.key),
      );
      const previous = this.items.get(item.key);
      const sameFacts = previous !== undefined
        && previous.fingerprint === fingerprint
        && previous.disposition === item.disposition;
      const streak = sameFacts ? previous.streak + 1 : 1;
      const alreadyConcluded = sameFacts
        && previous.verdict !== null
        && previous.verdict.fingerprint === fingerprint;
      let verdict = alreadyConcluded ? previous.verdict : null;
      if (
        verdict === null
        && streak >= REQUIRED_STABLE_ROUNDS
        && (item.disposition === "user-decision"
          || item.disposition === "non-retryable")
      ) {
        verdict = {
          key: item.key,
          path: item.path,
          outcome: item.disposition,
          streak,
          fingerprint,
        };
        concluded.push(verdict);
      }
      next.set(item.key, { fingerprint, disposition: item.disposition, streak, verdict });
    }
    this.items = next;
    if (diag) {
      for (const verdict of concluded) {
        diag("sync item termination concluded", {
          schemaVersion: 1,
          key: verdict.key,
          path: verdict.path,
          outcome: verdict.outcome,
          streak: verdict.streak,
          fingerprint: verdict.fingerprint,
        });
      }
    }
    return concluded;
  }

  /** Every item concluded so far and still present in the last observed
   *  round (verdicts of vanished or changed items are gone). */
  snapshot(): SyncItemTerminationVerdict[] {
    const verdicts: SyncItemTerminationVerdict[] = [];
    for (const item of this.items.values()) {
      if (item.verdict) verdicts.push(item.verdict);
    }
    return verdicts;
  }

  get(key: string): SyncItemTerminationVerdict | null {
    return this.items.get(key)?.verdict ?? null;
  }

  reset(): void {
    this.items.clear();
  }

  /**
   * The item rows of one round keyed by item identity, so each fingerprint
   * binds the item's own canonical row (a missing row means the caller
   * reported an item it cannot describe — the fingerprint then binds the
   * shared parts only, which is still stable evidence, never a fact change).
   */
  private collectItemRows(
    input: SyncItemTerminationRoundInput,
  ): Map<string, unknown> {
    const rows = new Map<string, unknown>();
    for (const issue of input.pendingIssues) {
      rows.set(pendingIssueTerminationKey(issue), issue);
    }
    for (const entry of input.mutationLedger) {
      rows.set(mutationRecoveryItemKey(entry.intent.operationId), entry);
    }
    return rows;
  }
}

/**
 * Compact render-key signature of the current verdicts: the sidebar rebuild
 * key must include it, otherwise a verdict arriving in a round that changes
 * no other rendered fact would never reach the DOM (same family as the
 * localOnlyRows / updatePrompt key entries, 2026-10-13).
 */
export function syncItemTerminationSignature(
  verdicts: readonly SyncItemTerminationVerdict[],
): string {
  return verdicts
    .map((verdict) => `${verdict.key}=${verdict.outcome}`)
    .sort()
    .join(",");
}
