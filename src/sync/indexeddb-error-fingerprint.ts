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

export type IndexedDbErrorKind =
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

export function classifyIndexedDbError(error: unknown): IndexedDbErrorKind {
  if (error == null) return "none";
  const name = error instanceof Error
    ? error.name
    : typeof error === "object" && error !== null && "name" in error
      && typeof error.name === "string"
      ? error.name
      : "";
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      && typeof error.message === "string"
      ? error.message
      : Object.prototype.toString.call(error);
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

export interface IndexedDbErrorFingerprint {
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
  const fingerprint: IndexedDbErrorFingerprint = {
    message: error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        && typeof error.message === "string"
        ? error.message
        : Object.prototype.toString.call(error),
    dbErrorKind,
  };
  if (error instanceof Error) {
    if (error.name) fingerprint.name = error.name;
    const stack = error.stack;
    if (stack) {
      const firstFrame = stack
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("Error"));
      if (firstFrame) fingerprint.stackFirstFrame = firstFrame;
    }
  }
  return fingerprint;
}