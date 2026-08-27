import { normalizeRemotePathKey } from "./canonical-plan-v2";
import { assertFileMutationReceiptShapeV1 } from "./file-state-reducer-v2";
import { isFolderMutationIntent } from "./folder-state-reducer-v2";
import type { SyncAnchorV2 } from "./state-envelope-v2";
import type {
  MutationLedgerEntryV1,
  SyncScope,
} from "./types";
import { sameSyncScope } from "./types";

/** Every file path whose identity or checkpoint belongs to one ledger entry. */
export function conservativeResetRecordPaths(
  record: Readonly<MutationLedgerEntryV1>,
): string[] {
  const checkpoint = record.receipt?.checkpoint;
  return [...new Map([
    record.intent.sourcePath,
    record.intent.path,
    ...(checkpoint?.baseUpserts.map((entry) => entry.path) ?? []),
    ...(checkpoint?.baseRemovals ?? []),
    ...(checkpoint?.remoteUpserts.map((entry) => entry.path) ?? []),
    ...(checkpoint?.remoteDeletes ?? []),
    ...(checkpoint?.pendingConflictRemovals ?? []),
    ...(checkpoint?.pendingDeleteRemovals ?? []),
  ].filter((path): path is string => Boolean(path)).map((path) => [
    normalizeRemotePathKey(path),
    path,
  ])).values()];
}

/** Stable remote identities already owned by an intent or its receipt. */
export function conservativeResetRecordRemoteIds(
  record: Readonly<MutationLedgerEntryV1>,
): Set<string> {
  return new Set([
    ...(record.intent.expectedRemote.exists
      ? [record.intent.expectedRemote.driveId]
      : []),
    ...(record.receipt?.checkpoint.remoteUpserts.map((entry) => entry.driveId)
      ?? []),
  ]);
}

/**
 * A file receipt may affect only the intent source/target. Folder checkpoint
 * effects or unrelated paths need their original full authority and cannot be
 * reduced to an ordinary-file reset capsule.
 */
export function conservativeResetReceiptIsBounded(
  record: Readonly<MutationLedgerEntryV1>,
): boolean {
  const checkpoint = record.receipt?.checkpoint;
  if (!checkpoint) return true;
  const allowed = new Set([
    record.intent.path,
    record.intent.sourcePath,
  ].filter((path): path is string => Boolean(path)).map(normalizeRemotePathKey));
  const pendingPathsAreBounded = (
    paths: readonly string[],
  ): boolean => paths.length <= 1
    && paths.every((path) => path === record.intent.path);
  return conservativeResetRecordPaths(record).every((path) =>
    allowed.has(normalizeRemotePathKey(path)))
    && (checkpoint.folderUpserts?.length ?? 0) === 0
    && (checkpoint.folderDeletes?.length ?? 0) === 0
    && (checkpoint.folderMoveHintRemovals?.length ?? 0) === 0
    && pendingPathsAreBounded(checkpoint.pendingConflictRemovals)
    && pendingPathsAreBounded(checkpoint.pendingDeleteRemovals);
}

function isVaultRelativeFilePath(path: string): boolean {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.endsWith("/")
    && !path.includes("\\")
    && path.split("/").every((segment) =>
      Boolean(segment) && segment !== "." && segment !== "..");
}

function conservativeResetReceiptMatchesIntent(
  record: Readonly<MutationLedgerEntryV1>,
): boolean {
  const { intent, receipt } = record;
  if (!receipt || isFolderMutationIntent(intent) || intent.version !== 1) {
    return receipt === null;
  }
  const checkpoint = receipt.checkpoint;
  const base = checkpoint.baseUpserts[0];
  const remote = checkpoint.remoteUpserts[0];
  const baseMatches = (
    expected: Readonly<{ hash: string; size: number }>,
  ): boolean => Boolean(base
    && base.hash === expected.hash
    && base.size === expected.size);
  const remoteMatches = (
    expected: Readonly<{ hash: string; size: number }>,
  ): boolean => Boolean(remote
    && remote.size === expected.size
    && (
      remote.sha256Hash === undefined
      || remote.sha256Hash.toLowerCase() === expected.hash.toLowerCase()
    ));

  switch (intent.action) {
    case "upload":
      return intent.expectedLocal.exists
        && baseMatches(intent.expectedLocal)
        && remoteMatches(intent.expectedLocal)
        && base?.eTag === remote?.eTag
        && (!intent.expectedRemote.exists
          || remote?.driveId === intent.expectedRemote.driveId);
    case "download":
      return intent.expectedRemote.exists
        && Boolean(base)
        && base.size === intent.expectedRemote.size
        && base.eTag === intent.expectedRemote.eTag
        && (
          intent.expectedRemote.sha256Hash === undefined
          || base.hash.toLowerCase()
            === intent.expectedRemote.sha256Hash.toLowerCase()
        );
    case "deleteRemote":
    case "deleteLocal":
      return true;
    case "renameRemote":
    case "moveLocal": {
      if (!intent.expectedLocal.exists || !intent.expectedRemote.exists) return false;
      if (
        !base
        || !remote
        || base.eTag !== remote.eTag
        || remote.driveId !== intent.expectedRemote.driveId
      ) return false;
      // Two admissible receipt shapes, both proving "after the move, the local
      // target and the remote identity hold the same version":
      //  1. content-aligned (A1 one-shot converge): the receipt base already
      //     equals the intended remote bytes when the remote was moved and
      //     edited while the local side stayed unchanged;
      //  2. pure rename: both sides still hold the intended local bytes and
      //     the intent itself declares matching content on both sides.
      const aligned = (
        expected: Readonly<{ size: number; sha256Hash?: string }>,
      ): boolean => Boolean(base
        && expected.sha256Hash !== undefined
        && base.hash.toLowerCase() === expected.sha256Hash.toLowerCase()
        && base.size === expected.size
        && remote.size === expected.size
        && remote.sha256Hash !== undefined
        && remote.sha256Hash.toLowerCase() === expected.sha256Hash.toLowerCase());
      return aligned(intent.expectedRemote) || (
        baseMatches(intent.expectedLocal)
        && remoteMatches(intent.expectedLocal)
        && intent.expectedLocal.size === intent.expectedRemote.size
        && (
          intent.expectedRemote.sha256Hash === undefined
          || intent.expectedLocal.hash.toLowerCase()
            === intent.expectedRemote.sha256Hash.toLowerCase()
        )
      );
    }
    case "merge":
      return Boolean(intent.target)
        && intent.expectedRemote.exists
        && remote?.driveId === intent.expectedRemote.driveId
        && remoteMatches(intent.target!)
        && (!base || (
          baseMatches(intent.target!)
          && base.eTag === remote?.eTag
        ));
  }
}

/**
 * Pure ordinary-file recovery gate. This is intentionally broad enough to
 * retain the existing path-only planner isolation for an unreceipted create
 * upload; conservative reset adds its stronger authority/capsule proof later.
 */
export function isOrdinaryFileRecoveryRecord(
  record: Readonly<MutationLedgerEntryV1>,
  scope: Readonly<SyncScope>,
): boolean {
  const intent = record.intent;
  if (
    isFolderMutationIntent(intent)
    || intent.version !== 1
    || intent.stateEffect !== undefined
    || record.manualResolution !== undefined
    || !sameSyncScope(intent.scope, scope)
    || !conservativeResetReceiptIsBounded(record)
    || !conservativeResetReceiptMatchesIntent(record)
    || conservativeResetRecordPaths(record).some((path) =>
      !isVaultRelativeFilePath(path))
  ) return false;
  try {
    assertFileMutationReceiptShapeV1(record);
  } catch {
    return false;
  }
  const sourceBound = intent.action === "renameRemote"
    || intent.action === "moveLocal";
  if (
    sourceBound !== Boolean(intent.sourcePath)
    || (
      intent.sourcePath !== undefined
      && normalizeRemotePathKey(intent.sourcePath)
        === normalizeRemotePathKey(intent.path)
    )
  ) return false;

  switch (intent.action) {
    case "upload":
      return intent.expectedLocal.exists && intent.target === undefined;
    case "download":
      return intent.expectedRemote.exists && intent.target === undefined;
    case "deleteRemote":
      return !intent.expectedLocal.exists
        && intent.expectedRemote.exists
        && intent.target === undefined;
    case "deleteLocal":
      return intent.expectedLocal.exists
        && !intent.expectedRemote.exists
        && intent.target === undefined;
    case "renameRemote":
    case "moveLocal":
      // 内容相等性由收据层判定（纯移动或同轮对齐两种形态）；无收据时放行到
      // 恢复分类器（路径已跟随但内容待对齐的已卡记录也必须能进入结算）。
      return intent.expectedLocal.exists
        && intent.expectedRemote.exists
        && intent.target === undefined;
    case "merge":
      return intent.sourcePath === undefined
        && intent.expectedLocal.exists
        && intent.expectedRemote.exists
        && Boolean(intent.target);
  }
}

/**
 * Durable reset admission before envelope-specific anchor closure. A create
 * upload with no receipt owns neither a Graph identity nor an old anchor, so
 * clearing the surrounding authority would make a moved unknown result
 * impossible to bound. It remains eligible for ordinary path-only planning,
 * but not for conservative reset.
 */
export function isConservativeResetOrdinaryRecord(
  record: Readonly<MutationLedgerEntryV1>,
  scope: Readonly<SyncScope>,
): boolean {
  return isOrdinaryFileRecoveryRecord(record, scope)
    && !(
      record.receipt === null
      && (
        (record.intent.action === "upload"
          && !record.intent.expectedRemote.exists)
        // Unreceipted moves may have followed the path already while the
        // content alignment is still pending; reset must not absorb them
        // before the recovery chain settles them (same fail-closed reason
        // as the response-unknown create upload).
        || record.intent.action === "moveLocal"
        || record.intent.action === "renameRemote"
      )
    );
}

export interface ConservativeResetRecordFootprint {
  pathKeys: ReadonlySet<string>;
  remoteIds: ReadonlySet<string>;
}

export function buildConservativeResetRecordFootprints(
  records: readonly Readonly<MutationLedgerEntryV1>[],
  currentPathByRemoteId: ReadonlyMap<string, string> = new Map(),
  anchors: readonly Readonly<SyncAnchorV2>[] = [],
): ConservativeResetRecordFootprint[] {
  const anchorsByPath = new Map<string, Readonly<SyncAnchorV2>[]>();
  const anchorsByRemoteId = new Map<string, Readonly<SyncAnchorV2>[]>();
  const append = <K>(
    map: Map<K, Readonly<SyncAnchorV2>[]>,
    key: K,
    anchor: Readonly<SyncAnchorV2>,
  ): void => {
    map.set(key, [...(map.get(key) ?? []), anchor]);
  };
  for (const anchor of anchors) {
    append(anchorsByPath, normalizeRemotePathKey(anchor.lastPath), anchor);
    if (anchor.remoteId) append(anchorsByRemoteId, anchor.remoteId, anchor);
  }
  return records.map((record) => {
    const pathKeys = new Set(conservativeResetRecordPaths(record).map(
      normalizeRemotePathKey,
    ));
    const remoteIds = conservativeResetRecordRemoteIds(record);
    const pendingPaths = [...pathKeys];
    const pendingRemoteIds = [...remoteIds];
    const processedPaths = new Set<string>();
    const processedRemoteIds = new Set<string>();
    const addPath = (path: string): void => {
      const key = normalizeRemotePathKey(path);
      if (pathKeys.has(key)) return;
      pathKeys.add(key);
      pendingPaths.push(key);
    };
    const addRemoteId = (remoteId: string): void => {
      if (remoteIds.has(remoteId)) return;
      remoteIds.add(remoteId);
      pendingRemoteIds.push(remoteId);
    };
    const addAnchor = (anchor: Readonly<SyncAnchorV2>): void => {
      addPath(anchor.lastPath);
      if (anchor.remoteId) addRemoteId(anchor.remoteId);
    };
    while (pendingPaths.length > 0 || pendingRemoteIds.length > 0) {
      const pathKey = pendingPaths.shift();
      if (pathKey !== undefined && !processedPaths.has(pathKey)) {
        processedPaths.add(pathKey);
        for (const anchor of anchorsByPath.get(pathKey) ?? []) addAnchor(anchor);
      }
      const remoteId = pendingRemoteIds.shift();
      if (remoteId !== undefined && !processedRemoteIds.has(remoteId)) {
        processedRemoteIds.add(remoteId);
        const currentPath = currentPathByRemoteId.get(remoteId);
        if (currentPath) addPath(currentPath);
        for (const anchor of anchorsByRemoteId.get(remoteId) ?? []) addAnchor(anchor);
      }
    }
    return { pathKeys, remoteIds };
  });
}

export function conservativeResetFootprintsOverlap(
  leftFootprint: Readonly<ConservativeResetRecordFootprint>,
  rightFootprint: Readonly<ConservativeResetRecordFootprint>,
): boolean {
  if ([...rightFootprint.pathKeys].some((path) =>
    leftFootprint.pathKeys.has(path))) return true;
  return [...rightFootprint.remoteIds].some((remoteId) =>
    leftFootprint.remoteIds.has(remoteId));
}

export function areIndependentConservativeResetRecords(
  records: readonly Readonly<MutationLedgerEntryV1>[],
  currentPathByRemoteId: ReadonlyMap<string, string> = new Map(),
  anchors: readonly Readonly<SyncAnchorV2>[] = [],
): boolean {
  const operationIds = new Set<string>();
  for (const record of records) {
    if (operationIds.has(record.intent.operationId)) return false;
    operationIds.add(record.intent.operationId);
  }
  const footprints = buildConservativeResetRecordFootprints(
    records,
    currentPathByRemoteId,
    anchors,
  );
  const ownedPaths = footprints.flatMap((footprint, owner) =>
    [...footprint.pathKeys].map((pathKey) => ({ pathKey, owner })),
  ).sort((left, right) =>
    left.pathKey.length - right.pathKey.length
      || left.pathKey.localeCompare(right.pathKey));
  const pathOwners = new Map<string, number>();
  for (const { pathKey, owner } of ownedPaths) {
    if (pathOwners.has(pathKey)) return false;
    let separator = pathKey.lastIndexOf("/");
    while (separator >= 0) {
      const ancestor = pathKey.slice(0, separator);
      const ancestorOwner = pathOwners.get(ancestor);
      if (ancestorOwner !== undefined && ancestorOwner !== owner) return false;
      separator = ancestor.lastIndexOf("/");
    }
    pathOwners.set(pathKey, owner);
  }
  const remoteIdOwners = new Set<string>();
  for (const footprint of footprints) {
    for (const remoteId of footprint.remoteIds) {
      if (remoteIdOwners.has(remoteId)) return false;
      remoteIdOwners.add(remoteId);
    }
  }
  return true;
}
