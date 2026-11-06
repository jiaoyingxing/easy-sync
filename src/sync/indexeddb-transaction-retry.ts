import { compatSetTimeout } from "../obsidian-compat";
import { classifyIndexedDbError } from "./indexeddb-error-fingerprint";

/** One retry is enough: the error means the previous transaction is gone, not
 *  that the operation is invalid. A second failure is a real failure. */
const INDEXEDDB_TRANSACTION_MAX_ATTEMPTS = 2;

/** Yield one macrotask so the next attempt starts with a fresh transaction. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    compatSetTimeout(resolve, 0);
  });
}

/**
 * Bounded retry for the iOS WebKit "transaction auto-committed" family.
 *
 * Only `webkit-transaction` class errors are retried. The caller must pass an
 * operation that is safe to re-run: it re-reads its precondition, or its write
 * is idempotent by construction (publish-check-read-rename, remove-if-exists).
 * Anything else, and any second failure, propagates unchanged.
 *
 * Two shapes are allowed, and they are a division of ownership — not two
 * competing disciplines:
 *
 * 1. **Callers that own the transaction** (a store that calls
 *    `db.transaction(...)` itself) issue every request inside the task that
 *    created the transaction; a read-decide-write body that must span awaits
 *    gets this wrapper at the public-method boundary, so each attempt starts a
 *    fresh transaction. Do not wrap the helpers that take a `tx`/`store`
 *    argument: the wrapper rebuilds the whole closure, and a captured
 *    transaction handle would still be dead.
 * 2. **Callers behind `DataAdapter`** cannot see or own the host transaction,
 *    so an idempotent unit gets the wrapper. The unit must re-observe its
 *    precondition after a failure (exact read-back, exists-before-remove).
 *
 * Retry height is capped at one idempotent record publication. Never wrap a
 * whole state-publication transaction (`publishCandidate`,
 * `renameIntoCommittedSlot`, migration holds, download temp-file commit, local
 * archive/restore copies): replaying those turns an already-successful step
 * into a reported failure or a duplicate copy.
 */
export async function retryIndexedDbTransaction<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    onRetry?: (error: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? INDEXEDDB_TRANSACTION_MAX_ATTEMPTS,
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        attempt >= maxAttempts
        || classifyIndexedDbError(error) !== "webkit-transaction"
      ) {
        throw error;
      }
      options.onRetry?.(error, attempt);
      await yieldToEventLoop();
    }
  }
  throw lastError;
}
