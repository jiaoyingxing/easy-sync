import { AuthError } from "../auth/types";
import { RemoteError, RemoteErrorType } from "../remote/errors";

/** Authentication and lifecycle termination must keep their run-level
 * semantics even when they arrive during protocol create/readback. Other
 * transport failures remain subject to the protocol caller's fail-closed
 * reconciliation rules. */
export function rethrowTerminalSharedSyncProtocolTransportError(
  error: unknown,
): void {
  if (error instanceof AuthError) throw error;
  if (
    error instanceof RemoteError
    && error.type === RemoteErrorType.AuthExpired
  ) {
    throw error;
  }
  if (error instanceof Error && error.name === "AbortError") throw error;
}
