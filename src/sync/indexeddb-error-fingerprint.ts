/**
 * Fingerprint helpers for database-layer errors during sync runs.
 *
 * On iOS, WebKit auto-commits IndexedDB transactions once control leaves the
 * task that created them; a later operation on the same transaction throws
 * "Attempt to delete range from database without an in-progress transaction"
 * (name "UnknownError"). Obsidian mobile backs the vault and plugin storage
 * with IndexedDB, so plugin-issued adapter/store operations can surface this
 * error. These helpers classify and tag such errors at the diagnostic boundary
 * so a real-device reproduction can tell the failing layer and operation
 * apart; they never change control flow.
 */

type IndexedDbErrorKind =
  /** iOS WebKit: an IndexedDB transaction auto-committed before a queued operation ran. */
  | "webkit-transaction"
  /** IndexedDB-family error without the WebKit transaction quirk. */
  | "indexeddb"
  /** Some other error. */
  | "other"
  /** No error object. */
  | "none";

const WEBKIT_TRANSACTION_MESSAGE_PATTERN =
  /without an in-progress transaction/i;

const INDEXED_DB_ERROR_NAMES = new Set([
  "AbortError",
  "ConstraintError",
  "DataError",
  "InvalidStateError",
  "NotFoundError",
  "QuotaExceededError",
  "ReadOnlyError",
  "TransactionInactiveError",
  "VersionError",
]);

/** How far a wrapped cause chain is followed. Hosts wrap adapter failures in
 *  their own Error ("Unable to delete file", "Unable to rename"), so the
 *  database shape can sit one or two levels below the surface error. */
const MAX_CAUSE_DEPTH = 3;

function readStringField(value: unknown, field: string): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  if (!(field in value)) return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function classificationOf(value: unknown): IndexedDbErrorKind {
  const name = readStringField(value, "name") ?? "";
  const message = readStringField(value, "message")
    ?? Object.prototype.toString.call(value);
  if (
    name === "UnknownError"
    || name === "TransactionInactiveError"
    || WEBKIT_TRANSACTION_MESSAGE_PATTERN.test(message)
  ) {
    return "webkit-transaction";
  }
  if (INDEXED_DB_ERROR_NAMES.has(name)) return "indexeddb";
  return "other";
}

export function classifyIndexedDbError(error: unknown): IndexedDbErrorKind {
  if (error == null) return "none";
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    const kind = classificationOf(current);
    if (kind !== "other") return kind;
    if (current == null || typeof current !== "object") return "other";
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === current || cause === null) return "other";
    current = cause;
  }
  return "other";
}

/** The level of the cause chain that actually carries the database shape, so
 *  the reported name and stack point at the layer that failed instead of the
 *  wrapper. Falls back to the surface error. */
function indexedDbErrorCarrier(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (classificationOf(current) !== "other") return current;
    if (current == null || typeof current !== "object") return error;
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === current || cause === null) return error;
    current = cause;
  }
  return error;
}

interface IndexedDbErrorFingerprint {
  message: string;
  dbErrorKind: IndexedDbErrorKind;
  name?: string;
  /** First meaningful stack frame, when the error carries a stack. */
  stackFirstFrame?: string;
}

/** Structured fingerprint for database-family errors only; null otherwise. */
export function fingerprintIndexedDbError(
  error: unknown,
): IndexedDbErrorFingerprint | null {
  const dbErrorKind = classifyIndexedDbError(error);
  if (dbErrorKind === "none" || dbErrorKind === "other") return null;
  const carrier = indexedDbErrorCarrier(error);
  const fingerprint: IndexedDbErrorFingerprint = {
    message: readStringField(error, "message")
      ?? Object.prototype.toString.call(error),
    dbErrorKind,
  };
  const name = readStringField(carrier, "name");
  if (name) fingerprint.name = name;
  // WebKit raises IndexedDB failures as DOMException, which is not guaranteed
  // to be `instanceof Error`, so read `stack` off the carrier object directly.
  const stack = readStringField(carrier, "stack")
    ?? readStringField(error, "stack");
  if (stack) {
    const firstFrame = stack
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("Error"));
    if (firstFrame) fingerprint.stackFirstFrame = firstFrame;
  }
  return fingerprint;
}
