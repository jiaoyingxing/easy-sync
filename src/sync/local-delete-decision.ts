import { stableHash64 } from "./sync-idle-observation";
import {
  sameCanonicalPlanIdentityV2,
  SyncActionType,
  type CanonicalPlanIdentityV2,
  type SyncDecisionToken,
  type SyncPlanItem,
} from "./types";

/**
 * One device-local authorization for the cloud-deletion follow direction.
 *
 * `kind` separates file confirmations from folder confirmations: the two rows
 * carry different facts (a file has a content token, a folder has a committed
 * anchor), so they are hashed differently and must never authorize each other.
 *
 * `paths` is the exact set the user confirmed. `planDigest` is a JSON array of
 * per-path fact hashes aligned with `paths`; it deliberately covers only the
 * authorized rows (not the whole plan): a partial batch must keep the failed
 * paths usable after the successful paths disappear from the plan.
 *
 * The record never authorizes a mutation by itself. The plan converts a row to
 * an executable delete only when the current row still has the same fact hash,
 * and the execution path re-runs every pre-delete guard.
 */
export type LocalDeleteDecisionKind = "file" | "folder";

export interface LocalDeleteDecisionV1 {
  kind: LocalDeleteDecisionKind;
  token: string;
  paths: string[];
  planDigest: string;
  createdAt: number;
}

/** Scope half of the record token and of the folder fact hash. */
export interface LocalDeleteDecisionScopeV1 {
  vaultName: string;
  accountId: string;
  scope: SyncDecisionToken["scope"];
}

export interface LocalDeleteDecisionAppliedPath {
  kind: LocalDeleteDecisionKind;
  token: string;
  path: string;
}

export interface LocalDeleteDecisionDiagnostic {
  kind: LocalDeleteDecisionKind;
  token: string;
  path: string;
  reason: string;
}

interface ApplyLocalDeleteDecisionsInput {
  items: readonly SyncPlanItem[];
  decisions: readonly LocalDeleteDecisionV1[];
  /** Paths present in the planning local scan. Absent means "unknown": no
   *  absent-both pruning is allowed without it. */
  localPathsPresent?: ReadonlySet<string>;
  /** Paths present in the committed remote file index. */
  remotePathsPresent: ReadonlySet<string>;
  /** Folder counterpart of `localPathsPresent`; unknown also disables pruning. */
  localFolderPathsPresent?: ReadonlySet<string>;
  /** Folder paths present in the committed remote folder index. */
  remoteFolderPathsPresent?: ReadonlySet<string>;
  /** Bound scope for folder records. File records carry their own token. */
  decisionScope?: LocalDeleteDecisionScopeV1;
}

interface ApplyLocalDeleteDecisionsResult {
  items: SyncPlanItem[];
  applied: LocalDeleteDecisionAppliedPath[];
  /** Records with already-consumed paths removed; still unconsumed applied
   *  paths stay until the checkpoint settles. */
  nextDecisions: LocalDeleteDecisionV1[];
  pruned: LocalDeleteDecisionDiagnostic[];
  /** Rows that did not match their recorded facts. The row is never consumed
   *  and the record is never pruned for this reason alone. */
  rejected: LocalDeleteDecisionDiagnostic[];
  changed: boolean;
}

const FILE_DECISION_PATH_FACT_VERSION = "local-delete-decision-path-v1";
const FOLDER_DECISION_PATH_FACT_VERSION = "local-folder-delete-decision-path-v1";
const FILE_RECORD_TOKEN_PREFIX = "local-delete:";
const FOLDER_RECORD_TOKEN_PREFIX = "local-folder-delete:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecisionScope(value: unknown): value is SyncDecisionToken["scope"] {
  return isRecord(value)
    && typeof value.accountId === "string"
    && typeof value.driveId === "string"
    && typeof value.vaultFolderId === "string"
    && typeof value.filesRootId === "string";
}

export function isSyncDecisionTokenLike(
  value: unknown,
): value is SyncDecisionToken {
  if (!isRecord(value) || value.version !== 1) return false;
  if (
    typeof value.vaultName !== "string"
    || typeof value.accountId !== "string"
    || !isDecisionScope(value.scope)
  ) return false;
  const local = value.local;
  if (
    !isRecord(local)
    || typeof local.exists !== "boolean"
    || (
      local.exists
      && (
        typeof local.hash !== "string"
        || typeof local.size !== "number"
        || !Number.isFinite(local.size)
        || local.size < 0
      )
    )
  ) return false;
  const remote = value.remote;
  if (
    !isRecord(remote)
    || typeof remote.exists !== "boolean"
    || (
      remote.exists
      && (
        typeof remote.driveId !== "string"
        || typeof remote.eTag !== "string"
      )
    )
  ) return false;
  return typeof value.ancestorHash === "string"
    || value.ancestorHash === null;
}

function localDeleteDecisionScopeHash(input: LocalDeleteDecisionScopeV1): string {
  return stableHash64(JSON.stringify([
    input.vaultName,
    input.accountId,
    input.scope.accountId,
    input.scope.driveId,
    input.scope.vaultFolderId,
    input.scope.filesRootId,
  ]));
}

function localDeleteDecisionScopeRecordToken(
  input: LocalDeleteDecisionScopeV1,
  kind: LocalDeleteDecisionKind,
): string {
  const prefix = kind === "folder"
    ? FOLDER_RECORD_TOKEN_PREFIX
    : FILE_RECORD_TOKEN_PREFIX;
  return `${prefix}${localDeleteDecisionScopeHash(input)}`;
}

export function localDeleteDecisionRecordToken(
  token: SyncDecisionToken,
): string {
  return localDeleteDecisionScopeRecordToken(token, "file");
}

export function localFolderDeleteDecisionRecordToken(
  input: LocalDeleteDecisionScopeV1,
): string {
  return localDeleteDecisionScopeRecordToken(input, "folder");
}

/**
 * Exact authorization fact for one file path. Every field that can change the
 * meaning of the user's confirmation is included: the local content, the
 * ancestor content, the (absent) remote side, and the sync identity. A change
 * in any of them makes the recorded hash unmatched, so the decision is not
 * consumed.
 */
export function localDeleteDecisionPathHash(
  token: SyncDecisionToken,
  path: string,
): string {
  return stableHash64(JSON.stringify([
    FILE_DECISION_PATH_FACT_VERSION,
    path,
    token.version,
    token.vaultName,
    token.accountId,
    token.scope.accountId,
    token.scope.driveId,
    token.scope.vaultFolderId,
    token.scope.filesRootId,
    token.local.exists
      ? [token.local.hash, token.local.size]
      : null,
    token.remote.exists
      ? [token.remote.driveId, token.remote.eTag]
      : null,
    token.ancestorHash,
  ]));
}

/**
 * Exact authorization fact for one folder confirmation row.
 *
 * The execution path keeps its own guards (local empty, committed anchor,
 * remote absence). This hash only binds the authorization to the folder row
 * the user saw: path, the committed anchor identity and the review impact.
 * `requiresConfirmation` is deliberately not part of the hash so the same
 * fact can be checked before and after the plan converts the row.
 */
export function localFolderDeleteDecisionPathHash(
  item: SyncPlanItem,
  decisionScope: LocalDeleteDecisionScopeV1,
): string | null {
  if (item.type !== SyncActionType.DeleteLocalFolder) return null;
  const folder = item.folder;
  if (!folder?.remoteId) return null;
  return stableHash64(JSON.stringify([
    FOLDER_DECISION_PATH_FACT_VERSION,
    item.type,
    item.path,
    folder.remoteId,
    folder.remoteETag ?? null,
    folder.parentRemoteId ?? null,
    folder.parentPath,
    folder.parentRemoteETag ?? null,
    folder.sourceParentRemoteId ?? null,
    item.reviewImpactCount ?? null,
    decisionScope.vaultName,
    decisionScope.accountId,
    decisionScope.scope.accountId,
    decisionScope.scope.driveId,
    decisionScope.scope.vaultFolderId,
    decisionScope.scope.filesRootId,
  ]));
}

function localDeleteDecisionPathHashFromItem(
  item: SyncPlanItem,
): string | null {
  if (
    item.type !== SyncActionType.ConfirmLocalDelete
    || !isSyncDecisionTokenLike(item.decisionToken)
  ) return null;
  return localDeleteDecisionPathHash(item.decisionToken, item.path);
}

function localFolderDeleteDecisionPathHashFromItem(
  item: SyncPlanItem,
  decisionScope: LocalDeleteDecisionScopeV1 | undefined,
): string | null {
  if (!decisionScope) return null;
  if (item.type !== SyncActionType.DeleteLocalFolder) return null;
  if (item.requiresConfirmation !== true) return null;
  return localFolderDeleteDecisionPathHash(item, decisionScope);
}

export function serializeLocalDeleteDecisionHashes(
  hashes: readonly string[],
): string {
  return JSON.stringify(hashes);
}

export function parseLocalDeleteDecisionHashes(
  digest: string,
): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(digest);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed)
    || !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
  ) return null;
  return parsed as string[];
}

/**
 * Strict device-local loader. A malformed record is dropped whole: a partial
 * path list or a hash list with the wrong length can never authorize anything.
 * Records written before folder decisions existed carry no `kind`; they are
 * file records by definition.
 */
export function readLocalDeleteDecisions(
  value: unknown,
): LocalDeleteDecisionV1[] {
  if (!Array.isArray(value)) return [];
  const records: LocalDeleteDecisionV1[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const kind = entry.kind === undefined ? "file" : entry.kind;
    if (kind !== "file" && kind !== "folder") continue;
    if (
      typeof entry.token !== "string"
      || entry.token.length === 0
      || typeof entry.planDigest !== "string"
      || typeof entry.createdAt !== "number"
      || !Number.isFinite(entry.createdAt)
      || entry.createdAt < 0
      || !Array.isArray(entry.paths)
    ) continue;
    const paths = entry.paths.filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
    if (paths.length !== entry.paths.length) continue;
    if (new Set(paths).size !== paths.length) continue;
    const hashes = parseLocalDeleteDecisionHashes(entry.planDigest);
    if (!hashes || hashes.length !== paths.length) continue;
    records.push({
      kind,
      token: entry.token,
      paths: [...paths],
      planDigest: entry.planDigest,
      createdAt: entry.createdAt,
    });
  }
  return records;
}

/**
 * Rows among `items` still covered by an unconsumed decision with exactly
 * matching facts.
 *
 * Path membership alone is not coverage: a row whose facts changed after
 * confirmation would be rejected by {@link applyLocalDeleteDecisions} and keep
 * its confirmation row. The UI must not hide that row, so the recorded hash is
 * compared against the row's own facts here. File records cover only
 * `ConfirmLocalDelete`; folder records cover only `DeleteLocalFolder` rows
 * still waiting for confirmation.
 */
export function collectLocalDeleteDecisionCoveredPaths(input: {
  decisions: readonly LocalDeleteDecisionV1[];
  items: readonly SyncPlanItem[];
  decisionScope?: LocalDeleteDecisionScopeV1 | null;
}): Set<string> {
  const covered = new Set<string>();
  if (input.decisions.length === 0 || input.items.length === 0) return covered;
  const fileRecordedByPath = new Map<string, string>();
  const folderRecordedByPath = new Map<string, string>();
  for (const record of input.decisions) {
    const hashes = parseLocalDeleteDecisionHashes(record.planDigest);
    if (!hashes || hashes.length !== record.paths.length) continue;
    const target = record.kind === "folder"
      ? folderRecordedByPath
      : fileRecordedByPath;
    for (let index = 0; index < record.paths.length; index++) {
      target.set(record.paths[index], hashes[index]);
    }
  }
  if (
    fileRecordedByPath.size === 0
    && folderRecordedByPath.size === 0
  ) return covered;
  for (const item of input.items) {
    if (item.type === SyncActionType.ConfirmLocalDelete) {
      const recorded = fileRecordedByPath.get(item.path);
      if (recorded === undefined) continue;
      if (!isSyncDecisionTokenLike(item.decisionToken)) continue;
      if (
        localDeleteDecisionPathHash(item.decisionToken, item.path)
          !== recorded
      ) continue;
      covered.add(item.path);
      continue;
    }
    if (item.type === SyncActionType.DeleteLocalFolder) {
      const recorded = folderRecordedByPath.get(item.path);
      if (recorded === undefined) continue;
      const current = localFolderDeleteDecisionPathHashFromItem(
        item,
        input.decisionScope ?? undefined,
      );
      if (current === null || current !== recorded) continue;
      covered.add(item.path);
    }
  }
  return covered;
}

function isPathAbsentBothSides(
  path: string,
  input: ApplyLocalDeleteDecisionsInput,
): boolean {
  if (!input.localPathsPresent) return false;
  return !input.localPathsPresent.has(path)
    && !input.remotePathsPresent.has(path);
}

function isFolderPathAbsentBothSides(
  path: string,
  input: ApplyLocalDeleteDecisionsInput,
): boolean {
  if (!input.localFolderPathsPresent || !input.remoteFolderPathsPresent) {
    return false;
  }
  return !input.localFolderPathsPresent.has(path)
    && !input.remoteFolderPathsPresent.has(path);
}

/**
 * Convert exactly the confirmed rows whose recorded fact hashes still match.
 *
 * Files become `DeleteLocal`; folders become the same `DeleteLocalFolder` item
 * with `requiresConfirmation` cleared. The plan keeps files before folders
 * (the executor's cleanup waves run before folder shells), so one confirmed
 * mixed batch stays one ordered plan.
 *
 * No state, no clock, no I/O. The caller persists `nextDecisions` and logs the
 * diagnostics; the applied paths stay in their records until the delete
 * checkpoint settles, so a cancelled or failed run never consumes them.
 */
export function applyLocalDeleteDecisions(
  input: ApplyLocalDeleteDecisionsInput,
): ApplyLocalDeleteDecisionsResult {
  const fileHashByPath = new Map<string, string>();
  const folderHashByPath = new Map<string, string>();
  for (const item of input.items) {
    const fileHash = localDeleteDecisionPathHashFromItem(item);
    if (fileHash !== null) fileHashByPath.set(item.path, fileHash);
    const folderHash = localFolderDeleteDecisionPathHashFromItem(
      item,
      input.decisionScope,
    );
    if (folderHash !== null) folderHashByPath.set(item.path, folderHash);
  }

  const convertedFilePaths = new Set<string>();
  const authorizedFolderPaths = new Set<string>();
  const applied: LocalDeleteDecisionAppliedPath[] = [];
  const nextDecisions: LocalDeleteDecisionV1[] = [];
  const pruned: LocalDeleteDecisionDiagnostic[] = [];
  const rejected: LocalDeleteDecisionDiagnostic[] = [];

  for (const decision of input.decisions) {
    // Older records and hand-built fixtures predate the `kind` field; they are
    // file records by definition (the loader fills the same default).
    const decisionKind: LocalDeleteDecisionKind = decision.kind ?? "file";
    const hashes = parseLocalDeleteDecisionHashes(decision.planDigest);
    if (!hashes || hashes.length !== decision.paths.length) {
      for (const path of decision.paths) {
        rejected.push({
          kind: decisionKind,
          token: decision.token,
          path,
          reason: "record digest is unreadable",
        });
      }
      nextDecisions.push(decision);
      continue;
    }
    if (decisionKind === "folder" && !input.decisionScope) {
      for (const path of decision.paths) {
        rejected.push({
          kind: decisionKind,
          token: decision.token,
          path,
          reason: "folder decision scope is unavailable",
        });
      }
      nextDecisions.push(decision);
      continue;
    }
    const hashByPath = decisionKind === "folder"
      ? folderHashByPath
      : fileHashByPath;

    const matchedPaths: string[] = [];
    const matchedHashes: string[] = [];
    const retainedPaths: string[] = [];
    const retainedHashes: string[] = [];
    let recordRejected = false;

    for (let index = 0; index < decision.paths.length; index++) {
      const path = decision.paths[index];
      const recordedHash = hashes[index];
      const currentHash = hashByPath.get(path);
      if (currentHash !== undefined && currentHash === recordedHash) {
        matchedPaths.push(path);
        matchedHashes.push(recordedHash);
        retainedPaths.push(path);
        retainedHashes.push(recordedHash);
        continue;
      }
      const absentBoth = decisionKind === "folder"
        ? isFolderPathAbsentBothSides(path, input)
        : isPathAbsentBothSides(path, input);
      if (currentHash === undefined && absentBoth) {
        pruned.push({
          kind: decisionKind,
          token: decision.token,
          path,
          reason: "path is already absent locally and remotely",
        });
        continue;
      }
      const reason = currentHash === undefined
        ? decisionKind === "folder"
          ? "path is no longer a confirm-local-folder-delete row"
          : "path is no longer a confirm-local-delete row"
        : "path facts changed since confirmation";
      rejected.push({
        kind: decisionKind,
        token: decision.token,
        path,
        reason,
      });
      recordRejected = true;
      retainedPaths.push(path);
      retainedHashes.push(recordedHash);
    }

    if (!recordRejected && matchedPaths.length > 0) {
      for (const path of matchedPaths) {
        if (decisionKind === "folder") {
          authorizedFolderPaths.add(path);
        } else {
          convertedFilePaths.add(path);
        }
        applied.push({
          kind: decisionKind,
          token: decision.token,
          path,
        });
      }
    }

    if (retainedPaths.length > 0) {
      nextDecisions.push({
        kind: decisionKind,
        token: decision.token,
        paths: retainedPaths,
        planDigest: serializeLocalDeleteDecisionHashes(retainedHashes),
        createdAt: decision.createdAt,
      });
    }
  }

  const items = input.items.map((item) => {
    if (
      convertedFilePaths.has(item.path)
      && item.type === SyncActionType.ConfirmLocalDelete
    ) {
      return { ...item, type: SyncActionType.DeleteLocal };
    }
    if (
      authorizedFolderPaths.has(item.path)
      && item.type === SyncActionType.DeleteLocalFolder
      && item.requiresConfirmation === true
    ) {
      return { ...item, requiresConfirmation: false };
    }
    return item;
  });

  return {
    items,
    applied,
    nextDecisions,
    pruned,
    rejected,
    changed: JSON.stringify(nextDecisions) !== JSON.stringify(input.decisions),
  };
}

/**
 * Verify the composition half of the reviewed-plan gate: every row the sealer
 * converted must still be backed by its record's exact fact hash. One missing
 * record, revoked path or changed hash refuses the whole composition.
 */
export function localDeleteDecisionCompositionAuthorized(input: {
  decisions: readonly LocalDeleteDecisionV1[];
  applied: readonly LocalDeleteDecisionAppliedPath[];
  items: readonly SyncPlanItem[];
  decisionScope?: LocalDeleteDecisionScopeV1;
}): boolean {
  if (input.applied.length === 0) return false;
  const itemByPath = new Map(input.items.map((item) => [item.path, item]));
  for (const entry of input.applied) {
    const entryKind: LocalDeleteDecisionKind = entry.kind ?? "file";
    const record = input.decisions.find((candidate) =>
      candidate.token === entry.token);
    if (!record) return false;
    const recordKind: LocalDeleteDecisionKind = record.kind ?? "file";
    if (recordKind !== entryKind) return false;
    const index = record.paths.indexOf(entry.path);
    if (index < 0) return false;
    const hashes = parseLocalDeleteDecisionHashes(record.planDigest);
    if (!hashes || hashes.length !== record.paths.length) return false;
    const item = itemByPath.get(entry.path);
    if (entryKind === "file") {
      if (!item || !isSyncDecisionTokenLike(item.decisionToken)) return false;
      if (
        localDeleteDecisionPathHash(item.decisionToken, entry.path)
          !== hashes[index]
      ) return false;
      continue;
    }
    if (
      !item
      || item.type !== SyncActionType.DeleteLocalFolder
      || item.requiresConfirmation !== false
      || !input.decisionScope
    ) return false;
    const current = localFolderDeleteDecisionPathHash(
      item,
      input.decisionScope,
    );
    if (current === null || current !== hashes[index]) return false;
  }
  return true;
}

type LocalDeleteReviewDisposition =
  | "current"
  | "compose"
  | "threshold-re-review"
  | "changed";

/**
 * Classify the reviewed plan against the sealed D1 plan:
 *
 * - `current`: the review already seals the executed plan (no delta, or a
 *   review built after the decisions were applied);
 * - `compose`: reviewed D0 plus the verified decision delta;
 * - `threshold-re-review`: D0 was below the bulk gate but the converted
 *   deletes push D1 over it — the existing threshold gate must run once more;
 * - `changed`: anything else re-pauses and consumes nothing.
 */
export function resolveLocalDeleteReviewDisposition(input: {
  reviewedIdentity?: CanonicalPlanIdentityV2;
  planIdentity?: CanonicalPlanIdentityV2;
  preDecisionIdentity?: CanonicalPlanIdentityV2;
  compositionAuthorized: boolean;
  requiresThresholdConfirmation: boolean;
  preDecisionRequiresThresholdConfirmation: boolean;
}): LocalDeleteReviewDisposition {
  // Legacy V1 review bundles carry no canonical identity; the existing
  // saved-digest check below still owns that path.
  if (!input.reviewedIdentity && !input.planIdentity) return "current";
  if (
    input.reviewedIdentity
    && input.planIdentity
    && sameCanonicalPlanIdentityV2(input.reviewedIdentity, input.planIdentity)
  ) return "current";
  if (
    input.reviewedIdentity
    && input.preDecisionIdentity
    && sameCanonicalPlanIdentityV2(
      input.reviewedIdentity,
      input.preDecisionIdentity,
    )
  ) {
    if (!input.compositionAuthorized) return "changed";
    if (
      input.requiresThresholdConfirmation
      && !input.preDecisionRequiresThresholdConfirmation
    ) return "threshold-re-review";
    return "compose";
  }
  return "changed";
}
