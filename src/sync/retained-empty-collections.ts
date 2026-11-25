/**
 * Device-local memory for remote empty collections deliberately retained after a
 * local folder delete on servers without conditional collection DELETE.
 *
 * The remote shell contains no user data. The planner must not treat it as a
 * new remote folder (which would recreate the local directory), and the delete
 * action must not repeat every round. The memory is local plugin data: it is
 * cleared when the remote folder disappears, gains children, changes its eTag,
 * or the user recreates the folder locally.
 */
const RETAINED_EMPTY_COLLECTIONS_SCHEMA_VERSION = 1;
const RETAINED_EMPTY_COLLECTIONS_KIND = "retained-empty-collections";
/** Bound so a long-lived vault cannot grow plugin data without limit. */
const RETAINED_EMPTY_COLLECTIONS_MAX = 500;

export interface RetainedEmptyCollectionV1 {
  /** Vault-relative folder path (no leading/trailing slash). */
  path: string;
  /** Strong eTag observed after the child deletes; null when the server has none. */
  eTag: string | null;
  recordedAt: number;
}

export interface RetainedEmptyCollectionsV1 {
  schemaVersion: 1;
  kind: "retained-empty-collections";
  entries: RetainedEmptyCollectionV1[];
}

export function createEmptyRetainedEmptyCollections(): RetainedEmptyCollectionsV1 {
  return {
    schemaVersion: RETAINED_EMPTY_COLLECTIONS_SCHEMA_VERSION,
    kind: RETAINED_EMPTY_COLLECTIONS_KIND,
    entries: [],
  };
}

/** Parse persisted plugin data; null means "unreadable, use the empty memory". */
export function readRetainedEmptyCollections(
  value: unknown,
): RetainedEmptyCollectionsV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== RETAINED_EMPTY_COLLECTIONS_SCHEMA_VERSION
    || value.kind !== RETAINED_EMPTY_COLLECTIONS_KIND
    || !Array.isArray(value.entries)) {
    return null;
  }
  return normalizeRetainedEmptyCollections(
    value.entries
      .map(readEntry)
      .filter((entry): entry is RetainedEmptyCollectionV1 => entry !== null),
  );
}

/** Deduplicate by path, keep the newest record, sort, and cap. */
export function normalizeRetainedEmptyCollections(
  entries: readonly RetainedEmptyCollectionV1[],
): RetainedEmptyCollectionsV1 {
  const byPath = new Map<string, RetainedEmptyCollectionV1>();
  for (const entry of entries) {
    if (!isVaultFolderPath(entry.path)) continue;
    const eTag = normalizeETag(entry.eTag);
    const recordedAt = Number.isFinite(entry.recordedAt) && entry.recordedAt >= 0
      ? entry.recordedAt
      : 0;
    const previous = byPath.get(entry.path);
    if (!previous || previous.recordedAt <= recordedAt) {
      byPath.set(entry.path, { path: entry.path, eTag, recordedAt });
    }
  }
  const newest = [...byPath.values()]
    .sort((left, right) => right.recordedAt - left.recordedAt)
    .slice(0, RETAINED_EMPTY_COLLECTIONS_MAX)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: RETAINED_EMPTY_COLLECTIONS_SCHEMA_VERSION,
    kind: RETAINED_EMPTY_COLLECTIONS_KIND,
    entries: newest,
  };
}

function readEntry(value: unknown): RetainedEmptyCollectionV1 | null {
  if (!isRecord(value)
    || typeof value.path !== "string"
    || !isVaultFolderPath(value.path)) {
    return null;
  }
  return {
    path: value.path,
    eTag: normalizeETag(value.eTag),
    recordedAt: typeof value.recordedAt === "number"
      ? value.recordedAt
      : 0,
  };
}

function normalizeETag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A sync-scope folder path. Root is not a user folder and never becomes a
 * retained shell; `.`/`..`, backslashes and control characters are rejected.
 */
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
