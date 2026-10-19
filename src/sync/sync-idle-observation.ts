/**
 * S1 observation blade — per-round fact fingerprint, blocked-item
 * classification counts and a consecutive-identical-round ("idle spin")
 * verdict (docs 2026-08-14 first-principles calibration, 重检资格 section;
 * docs 2026-10-16 §六 S1 row; user decision 2026-10-17).
 *
 * Observation only: every output goes to the diagnostic logger and nothing
 * here may be consumed by any sync decision (the "diagnostic boundary —
 * deliberately self-healing-resistant" row family). The comparison state is
 * held in memory for the plugin-instance lifetime and is deliberately not
 * persisted: after a reload the streak restarts, so a verdict always takes
 * two freshly observed consecutive rounds.
 *
 * The fingerprint binds the round-end fact groups named by the same
 * calibration doc — scope, shared baseline revision, the blocked/pending
 * object surface (identity + content/version summaries), the recovery
 * ledger record surface, the plan review revision, and the execution-layer
 * run outcome — as stable-ordered canonical strings hashed once per round
 * end (never inside a per-file loop). Per-round wall-clock stamps
 * (`updatedAt`), breaker bookkeeping (`consecutiveFailures`) and expiring
 * Graph tokens (`downloadUrl`) are excluded on purpose: they are rewritten
 * every round without a fact change and would hide every idle shape.
 *
 * Granularity extension (S4 终止判据接线, docs 2026-10-16 §五 D3／§六 S4 row):
 * the per-item termination blade (./sync-item-termination) decomposes this
 * same round input into one fact fingerprint per blocked item. It reuses
 * {@link buildSyncRoundFingerprint}'s shared parts (scope / baseline /
 * review) plus {@link canonicalizeSyncFactValue} and
 * {@link stableSyncFactHash}, so a per-item streak and the round streak can
 * never disagree about what a fact change is. Nothing in this module reads
 * the termination verdict back.
 */

import type {
  MutationLedgerEntryV1,
  MutationRecoveryRunSummary,
  SyncPlanItem,
  SyncRunFacts,
} from "./types";
import type { PendingIssue } from "./state-manager";

/** Per-component round facts hashed in a fixed order. Each entry maps to
 *  one fingerprint binding named by the calibration doc. */
interface SyncRoundFactParts {
  schema: string;
  scope: string;
  baseline: string;
  pending: string;
  ledger: string;
  review: string;
  run: string;
}

/** Fingerprint data of one round. */
interface SyncRoundFingerprint {
  fingerprint: string;
  parts: SyncRoundFactParts;
  /** Short hash per fact group, same order as `parts` — lets a reader see
   *  which group changed between two adjacent fingerprints. */
  partHashes: string[];
}

/** Reused classification vocabulary (`issueCode` / `reason.*` existing
 *  values; no new codes are invented here). Nonzero entries only. */
interface SyncRoundBlockedClassifications {
  errors: Record<string, number>;
  issueCodes: Record<string, number>;
  reasons: Record<string, number>;
  pending: Record<string, number>;
  ledger: Record<string, number>;
}

export interface SyncIdleObservationInput {
  scope: {
    accountId: string;
    driveId: string;
    vaultFolderId: string;
    filesRootId: string;
  } | null;
  /** Shared baseline revision — the V2 state commit sequence when the V2
   *  authority is active, null on legacy/absent authority. */
  stateCommitSeq: number | null;
  pendingConflicts: readonly SyncPlanItem[];
  pendingRemoteDeletes: readonly SyncPlanItem[];
  pendingIssues: readonly PendingIssue[];
  planReview: {
    active: boolean;
    revision: number;
    digest: string | null;
  };
  mutationLedger: readonly MutationLedgerEntryV1[];
  runFacts: SyncRunFacts | null;
  authExpired: boolean;
  success: boolean;
  /** Structural shape of {@link SyncResult["disposition"]}; defined locally
   *  so this module never imports the executor. */
  disposition: {
    kind: "retryable-observation";
    phase: string;
    code: string;
    retry: string;
    component: string;
  } | null;
  mutationRecovery: MutationRecoveryRunSummary | null;
  counts: {
    uploaded: number;
    downloaded: number;
    foldersCreated: number;
    foldersMoved: number;
    foldersDeleted: number;
    filesMoved: number;
    deleted: number;
    conflicts: number;
    deferred: number;
    errors: number;
    identityBlockedErrors: number | null;
    breakerDeferredErrors: number | null;
    networkFailureErrors: number | null;
    skippedLarge: number;
    skippedIgnored: number;
    skippedInvalidName: number;
  };
}

export interface SyncIdleObservationState {
  previousFingerprint: string | null;
  streak: number;
}

/** Diagnostic sink; both calls are `urgent` level (C3 2026-10-13 rounding). */
interface SyncIdleObservationDiag {
  (message: "sync round fact fingerprint", data: {
    schemaVersion: 1;
    fingerprint: string;
    factParts: string[];
    blocked: SyncRoundBlockedClassifications;
  }): void;
  (message: "sync idle spin detected", data: {
    schemaVersion: 1;
    fingerprint: string;
    streak: number;
    blocked: SyncRoundBlockedClassifications;
  }): void;
}

/**
 * Field families excluded from the canonical fingerprint serialization.
 * Each is rewritten on every round without a fact change:
 * - `updatedAt`: a per-round wall stamp (even the "RetryLater keeps the last
 *   real failure time" rule only preserves it on some rows),
 * - `consecutiveFailures`: breaker bookkeeping (a count of rounds, not a
 *   fact),
 * - `downloadUrl`: a Graph pre-signed token that legitimately expires and
 *   refreshes between unchanged rounds.
 */
const VOLATILE_FACT_KEYS = new Set([
  "updatedAt",
  "consecutiveFailures",
  "downloadUrl",
]);

/** Compact an error checkpoint (full base/remote arrays on every recorded
 *  receipt) into counts: retelling each entry would be O(remote size). */
function compactCheckpoint(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.baseUpserts)
    || !Array.isArray(record.remoteUpserts)
    || !Array.isArray(record.remoteDeletes)
    || !Array.isArray(record.baseRemovals)
    || !Array.isArray(record.pendingConflictRemovals)
    || !Array.isArray(record.pendingDeleteRemovals)
  ) {
    return undefined;
  }
  return {
    baseUpserts: record.baseUpserts.length,
    baseRemovals: record.baseRemovals.length,
    remoteUpserts: record.remoteUpserts.length,
    remoteDeletes: record.remoteDeletes.length,
    pendingConflictRemovals: record.pendingConflictRemovals.length,
    pendingDeleteRemovals: record.pendingDeleteRemovals.length,
  };
}

/** Canonical stable serialization: arrays in order, object keys sorted,
 *  {@link VOLATILE_FACT_KEYS} dropped, checkpoints compacted, `undefined`
 *  properties omitted. Read-only over the caller's live arrays.
 *
 *  Exported for the per-item termination blade (S4), which canonicalizes one
 *  item's facts under the identical rules — see the module header. */
export function canonicalize(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && Number.isNaN(value)) return "NaN";
    return value;
  }
  if (depth <= 0) return "<depth-limit>";
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, depth - 1));
  }
  const record = value as Record<string, unknown>;
  const compacted = compactCheckpoint(record);
  if (compacted !== undefined) return compacted;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (VOLATILE_FACT_KEYS.has(key)) continue;
    const entry = canonicalize(record[key], depth - 1);
    if (entry !== undefined) next[key] = entry;
  }
  if (Object.keys(next).length === 0) return null;
  return next;
}

/** FNV-1a in two 32-bit lanes → 64-bit hex. Synchronous on purpose: the
 *  observation runs inline at round end and must never interleave the round
 *  teardown; pair-wise consecutive comparison only needs collision odds far
 *  below one-in-trillions, which two lanes give even for large states.
 *
 *  Exported for the per-item termination blade (S4): both blades hash with
 *  the same function so a per-item fingerprint and a round fingerprint are
 *  comparable evidence. */
export function stableHash64(text: string): string {
  let laneLow = 0x811c9dc5;
  let laneHigh = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index) & 0xff;
    laneLow = Math.imul(laneLow ^ code, 0x01000193) >>> 0;
    laneHigh = Math.imul(
      laneHigh ^ ((code << 1) | (text.charCodeAt(index) >>> 8)),
      0x85ebca6b,
    ) >>> 0;
  }
  laneLow ^= text.length;
  laneHigh ^= 0x27d4eb2f ^ text.length;
  return `${laneLow.toString(16).padStart(8, "0")}${laneHigh
    .toString(16)
    .padStart(8, "0")}`;
}

function scopePart(
  scope: SyncIdleObservationInput["scope"],
): string {
  if (!scope) return "scope=none";
  return `scope=${scope.accountId}|${scope.driveId}|${scope.vaultFolderId}|${scope.filesRootId}`;
}

function baselinePart(stateCommitSeq: number | null): string {
  return `baseline=${stateCommitSeq === null ? "none" : stateCommitSeq}`;
}

/** Sort pending rows by path for a stable order across rounds. */
function pendingRowsPart(input: SyncIdleObservationInput): string {
  const rows: Array<{ path: string; canonical: unknown }> = [];
  for (const item of input.pendingConflicts) {
    rows.push({ path: item.path, canonical: canonicalize(item, 24) });
  }
  for (const item of input.pendingRemoteDeletes) {
    rows.push({ path: item.path, canonical: canonicalize(item, 24) });
  }
  for (const issue of input.pendingIssues) {
    rows.push({ path: issue.path, canonical: canonicalize(issue, 24) });
  }
  const rendered = rows
    .sort((left, right) => {
      if (left.path !== right.path) {
        return left.path < right.path ? -1 : 1;
      }
      return stableHash64(JSON.stringify(left.canonical))
        .localeCompare(stableHash64(JSON.stringify(right.canonical)));
    })
    .map((row) => `${row.path}=${JSON.stringify(row.canonical)}`);
  return `pending=${rendered.length === 0 ? "none" : rendered.join("||")}`;
}

function ledgerRecordsPart(
  mutationLedger: readonly MutationLedgerEntryV1[],
): string {
  const rendered = mutationLedger
    .map((entry) => canonicalize(entry, 24))
    .map((canonical) => JSON.stringify(canonical))
    .sort();
  return `ledger=${rendered.length === 0 ? "none" : rendered.join("||")}`;
}

function reviewPart(input: SyncIdleObservationInput): string {
  return `review=${input.planReview.active ? "active" : "none"}|${input.planReview.revision}|${input.planReview.digest ?? "-"}`;
}

function runPart(input: SyncIdleObservationInput): string {
  const facts = input.runFacts;
  const recovery = input.mutationRecovery;
  const counts = input.counts;
  const joint = [
    facts ? facts.termination : "legacy",
    facts ? facts.ordinaryPlanning : "legacy",
    facts ? facts.userFileChanges : "legacy",
    facts?.planReviewPaused === true ? "review-paused" : "review-not-paused",
    facts?.thresholdSkippedInAuto === true ? "threshold-skip" : "no-threshold-skip",
    facts?.convergences ? `conv${facts.convergences}` : "no-conv",
    input.authExpired ? "auth-expired" : "auth-ok",
    input.success ? "success" : "failed",
    input.disposition
      ? `disp:${input.disposition.kind}:${input.disposition.phase}:${input.disposition.code}:${input.disposition.component}`
      : "disp:none",
    recovery
      ? `recovery:${recovery.state}:${recovery.blockReason ?? "none"}:${recovery.isolated === true ? "isolated" : "not-isolated"}`
      : "recovery:none",
    `up${counts.uploaded}`,
    `down${counts.downloaded}`,
    `foldC${counts.foldersCreated}`,
    `foldM${counts.foldersMoved}`,
    `foldD${counts.foldersDeleted}`,
    `fileM${counts.filesMoved}`,
    `del${counts.deleted}`,
    `conf${counts.conflicts}`,
    `defer${counts.deferred}`,
    `err${counts.errors}`,
    counts.identityBlockedErrors ? `identBlock${counts.identityBlockedErrors}` : "",
    counts.breakerDeferredErrors ? `break${counts.breakerDeferredErrors}` : "",
    counts.networkFailureErrors ? `net${counts.networkFailureErrors}` : "",
    `skipL${counts.skippedLarge}`,
    `skipI${counts.skippedIgnored}`,
    `skipN${counts.skippedInvalidName}`,
  ].join("|");
  return `run=${joint}`;
}

/** Build the stable-ordered canonical parts of one round's fact fingerprint. */
function buildSyncRoundFactParts(
  input: SyncIdleObservationInput,
): SyncRoundFactParts {
  return {
    schema: "sync-fact-fingerprint-v1",
    scope: scopePart(input.scope),
    baseline: baselinePart(input.stateCommitSeq),
    pending: pendingRowsPart(input),
    ledger: ledgerRecordsPart(input.mutationLedger),
    review: reviewPart(input),
    run: runPart(input),
  };
}

/**
 * Fact fingerprint of one round: every {@link SyncRoundFactParts} entry is a
 * stable-ordered canonical string; the fingerprint hashes the ordered
 * concatenation. Rebuilt once per round end over round-existing facts; it
 * must not be computed inside any per-file loop.
 */
export function buildSyncRoundFingerprint(
  input: SyncIdleObservationInput,
): SyncRoundFingerprint {
  const parts = buildSyncRoundFactParts(input);
  const partKeys: Array<keyof SyncRoundFactParts> = [
    "schema",
    "scope",
    "baseline",
    "pending",
    "ledger",
    "review",
    "run",
  ];
  return {
    fingerprint: stableHash64(partKeys.map((key) => parts[key]).join("\n")),
    parts,
    partHashes: partKeys.map((key) => stableHash64(parts[key])),
  };
}

/** Merge nonzero counters into the given bucket (reused vocabulary, no new
 *  codes). */
function bumpCounts(
  bucket: Record<string, number>,
  key: string | undefined,
): void {
  if (key === undefined || key === null || key === "") return;
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/**
 * Blocked-item classification counts for one round, reusing only existing
 * vocabulary (`PendingIssue.issueCode`, per-row `reason` strings, the three
 * exempt error families and the recovery summary's own block reason).
 */
export function buildRoundBlockedClassifications(
  input: SyncIdleObservationInput,
): SyncRoundBlockedClassifications {
  const errors: Record<string, number> = {};
  if (input.counts.errors > 0) {
    errors.total = input.counts.errors;
    for (const key of [
      "identityBlockedErrors",
      "breakerDeferredErrors",
      "networkFailureErrors",
    ] as const) {
      const value = input.counts[key];
      if (value && value > 0) errors[key] = value;
    }
  }
  if (input.authExpired) errors.authExpired = 1;
  const issueCodes: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const pending: Record<string, number> = {};
  let issueRows = 0;
  for (const issue of input.pendingIssues) {
    issueRows++;
    bumpCounts(issueCodes, issue.issueCode);
    bumpCounts(reasons, issue.reason);
  }
  if (issueRows > 0) pending.issues = issueRows;
  let conflictRows = 0;
  for (const item of input.pendingConflicts) {
    conflictRows++;
    bumpCounts(reasons, item.reason);
  }
  if (conflictRows > 0) pending.conflicts = conflictRows;
  let remoteDeleteRows = 0;
  for (const item of input.pendingRemoteDeletes) {
    remoteDeleteRows++;
    bumpCounts(reasons, item.reason);
  }
  if (remoteDeleteRows > 0) {
    pending.remoteDeletes = remoteDeleteRows;
  }
  const ledger: Record<string, number> = {};
  if (input.mutationLedger.length > 0) {
    ledger.records = input.mutationLedger.length;
  }
  const recovery = input.mutationRecovery;
  if (recovery) {
    ledger[`state.${recovery.state}`] = (ledger[`state.${recovery.state}`] ?? 0) + 1;
    if (recovery.blockReason !== undefined) {
      ledger[`blocked.${recovery.blockReason}`] = 1;
    }
    if (recovery.isolated === true) ledger.isolated = 1;
    if (recovery.remaining > 0) ledger.remaining = recovery.remaining;
  }
  return { errors, issueCodes, reasons, pending, ledger };
}

/** Whether the round still carries any blocking-classification surface.
 *  A fully converged round (the expected steady state, "完成后下一轮应回到
 *  零计划") has none; consecutive identical fingerprints there are the
 *  healthy settled form and are documented by the per-round fingerprint
 *  line without raising a 空转 verdict. */
function hasBlockingSurface(
  blocked: SyncRoundBlockedClassifications,
): boolean {
  return Object.keys(blocked.errors).length > 0
    || Object.keys(blocked.issueCodes).length > 0
    || Object.keys(blocked.reasons).length > 0
    || Object.keys(blocked.pending).length > 0
    || Object.keys(blocked.ledger).length > 0;
}

/** Round-end observation: compute facts, classify, compare against the
 *  previous round and emit diagnostic lines. Purely observational — see the
 *  module doc header. */
export function observeSyncRoundEnd(
  state: SyncIdleObservationState,
  input: SyncIdleObservationInput,
  diag: SyncIdleObservationDiag,
): void {
  const fingerprint = buildSyncRoundFingerprint(input);
  const blocked = buildRoundBlockedClassifications(input);
  diag("sync round fact fingerprint", {
    schemaVersion: 1,
    fingerprint: fingerprint.fingerprint,
    factParts: fingerprint.partHashes,
    blocked,
  });
  let verdict = false;
  if (
    state.previousFingerprint !== null
    && state.previousFingerprint === fingerprint.fingerprint
    && hasBlockingSurface(blocked)
  ) {
    state.streak += 1;
    verdict = true;
  } else {
    state.streak = 1;
  }
  state.previousFingerprint = fingerprint.fingerprint;
  if (verdict) {
    diag("sync idle spin detected", {
      schemaVersion: 1,
      fingerprint: fingerprint.fingerprint,
      streak: state.streak,
      blocked,
    });
  }
}
