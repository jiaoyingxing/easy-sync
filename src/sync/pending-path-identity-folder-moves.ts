import type { SyncScope } from "./types";

/**
 * Device-local continuation for a path-identity folder rename that is executed
 * file by file.
 *
 * The plan decomposes the rename into target folder creates plus one remote
 * file move per descendant. The target collections exist after the first
 * round, but the folder anchors still point at the source until every file has
 * moved. This record keeps the source→target meaning across rounds so the next
 * plan hides the folder-layer interpretations of that half-moved state, and
 * the executor can finish the anchor rebind once the source subtree is empty.
 *
 * It never authorizes a mutation alone: the executor re-reads the committed
 * envelope and only rebinds while the source folder anchor still exists, no
 * file identity remains below it, and the target collection exists.
 */
const PENDING_PATH_IDENTITY_FOLDER_MOVES_SCHEMA_VERSION = 1;
const PENDING_PATH_IDENTITY_FOLDER_MOVES_KIND = "pending-path-identity-folder-moves";
/** Bound so a long-lived vault cannot grow plugin data without limit. */
const PENDING_PATH_IDENTITY_FOLDER_MOVES_MAX = 50;

export interface PendingPathIdentityFolderMoveV1 {
  version: 1;
  scope: SyncScope;
  /** Folder path this device renamed away from. */
  sourcePath: string;
  /** Local folder path the rename established. */
  targetPath: string;
  observedAt: number;
}

export interface PendingPathIdentityFolderMovesV1 {
  schemaVersion: 1;
  kind: "pending-path-identity-folder-moves";
  entries: PendingPathIdentityFolderMoveV1[];
}

export function createEmptyPendingPathIdentityFolderMoves(): PendingPathIdentityFolderMovesV1 {
  return {
    schemaVersion: PENDING_PATH_IDENTITY_FOLDER_MOVES_SCHEMA_VERSION,
    kind: PENDING_PATH_IDENTITY_FOLDER_MOVES_KIND,
    entries: [],
  };
}

/** Parse persisted plugin data; null means "unreadable, use the empty memory". */
export function readPendingPathIdentityFolderMoves(
  value: unknown,
): PendingPathIdentityFolderMovesV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== PENDING_PATH_IDENTITY_FOLDER_MOVES_SCHEMA_VERSION
    || value.kind !== PENDING_PATH_IDENTITY_FOLDER_MOVES_KIND
    || !Array.isArray(value.entries)) {
    return null;
  }
  return normalizePendingPathIdentityFolderMoves(
    value.entries
      .map(readEntry)
      .filter((entry): entry is PendingPathIdentityFolderMoveV1 => entry !== null),
  );
}

/** Deduplicate by scope + source path, keep the newest record, sort, and cap. */
export function normalizePendingPathIdentityFolderMoves(
  entries: readonly PendingPathIdentityFolderMoveV1[],
): PendingPathIdentityFolderMovesV1 {
  const byKey = new Map<string, PendingPathIdentityFolderMoveV1>();
  for (const entry of entries) {
    if (
      !isVaultFolderPath(entry.sourcePath)
      || !isVaultFolderPath(entry.targetPath)
      || entry.sourcePath === entry.targetPath
      || !isSyncScope(entry.scope)
    ) continue;
    const observedAt = Number.isFinite(entry.observedAt) && entry.observedAt >= 0
      ? entry.observedAt
      : 0;
    const key = pendingKey(entry.scope, entry.sourcePath);
    const previous = byKey.get(key);
    if (!previous || previous.observedAt <= observedAt) {
      byKey.set(key, {
        version: 1,
        scope: { ...entry.scope },
        sourcePath: entry.sourcePath,
        targetPath: entry.targetPath,
        observedAt,
      });
    }
  }
  const newest = [...byKey.values()]
    .sort((left, right) => right.observedAt - left.observedAt)
    .slice(0, PENDING_PATH_IDENTITY_FOLDER_MOVES_MAX)
    .sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath)
      || left.targetPath.localeCompare(right.targetPath));
  return {
    schemaVersion: PENDING_PATH_IDENTITY_FOLDER_MOVES_SCHEMA_VERSION,
    kind: PENDING_PATH_IDENTITY_FOLDER_MOVES_KIND,
    entries: newest,
  };
}

export function pendingPathIdentityFolderMoveKey(
  scope: SyncScope,
  sourcePath: string,
): string {
  return pendingKey(scope, sourcePath);
}

function pendingKey(scope: SyncScope, sourcePath: string): string {
  // 五字段与 `sameSyncScope` 的缺省口径一致：同一 endpoint 上的不同
  // rootPath／container 是两个库，不能用四元把它们合成同一条记录。
  return [
    scope.accountId,
    scope.driveId,
    scope.vaultFolderId,
    scope.filesRootId,
    scope.providerKind ?? "onedrive",
    scope.endpointId ?? "",
    scope.containerId ?? "",
    scope.rootPath ?? "",
    scope.credentialBindingId ?? "",
    sourcePath,
  ].join("\u0000");
}

function readEntry(value: unknown): PendingPathIdentityFolderMoveV1 | null {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.sourcePath !== "string"
    || !isVaultFolderPath(value.sourcePath)
    || typeof value.targetPath !== "string"
    || !isVaultFolderPath(value.targetPath)
    || value.sourcePath === value.targetPath
    || !isSyncScope(value.scope)) {
    return null;
  }
  return {
    version: 1,
    scope: { ...value.scope },
    sourcePath: value.sourcePath,
    targetPath: value.targetPath,
    observedAt: typeof value.observedAt === "number"
      ? value.observedAt
      : 0,
  };
}

function isSyncScope(value: unknown): value is SyncScope {
  return isRecord(value)
    && typeof value.accountId === "string"
    && typeof value.driveId === "string"
    && typeof value.vaultFolderId === "string"
    && typeof value.filesRootId === "string";
}

/** A sync-scope folder path. Root is not a user folder. */
function isVaultFolderPath(path: string): boolean {
  return path.length > 0
    && path.length <= 1024
    && !path.startsWith("/")
    && !path.endsWith("/")
    && !path.includes("\\")
    && path.split("/").every((segment) =>
      segment.length > 0
      && segment !== "."
      && segment !== ".."
      && ![...segment].some((char) => char.charCodeAt(0) < 0x20));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
