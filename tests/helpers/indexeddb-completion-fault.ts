import FDBTransaction from "fake-indexeddb/lib/FDBTransaction";

export type ActiveCommitCompletionFaultName =
  | "QuotaExceededError"
  | "UnknownError"
  | "AbortError";

interface FakeActiveCommitTransaction extends IDBTransaction {
  _abort(errorName: string | null): void;
  _requests: unknown[];
  _rollbackLog: Array<() => void>;
  _scope: Set<string>;
  _start(): void;
  _started: boolean;
  _state: "active" | "inactive" | "committing" | "finished";
}

export interface ActiveCommitCompletionObservation {
  mode: IDBTransactionMode;
  pendingRequests: number;
  rollbackOperations: number;
  state: FakeActiveCommitTransaction["_state"];
  storeNames: string[];
}

export function injectActiveCommitCompletionFault(
  faultName: ActiveCommitCompletionFaultName,
  options: { persistent?: boolean } = {},
): {
  injectionCount(): number;
  observation(): ActiveCommitCompletionObservation | null;
  restore(): void;
} {
  const prototype = FDBTransaction.prototype as unknown as {
    _start(this: FakeActiveCommitTransaction): void;
  };
  const originalStart = prototype._start;
  let armed = true;
  let injections = 0;
  let observed: ActiveCommitCompletionObservation | null = null;
  const patchedStart = function (this: FakeActiveCommitTransaction): void {
    const storeNames = [...this._scope].sort();
    if (
      armed
      && this.mode === "readwrite"
      && this._started
      && this._state === "active"
      && this._requests.length === 0
      && this._rollbackLog.length >= 3
      && storeNames.join("|")
        === "anchors|folderAnchors|meta|remoteNodes"
    ) {
      if (options.persistent !== true) armed = false;
      injections += 1;
      observed = {
        mode: this.mode,
        pendingRequests: this._requests.length,
        rollbackOperations: this._rollbackLog.length,
        state: this._state,
        storeNames,
      };
      this._abort(faultName);
      return;
    }
    originalStart.call(this);
  };
  prototype._start = patchedStart;
  return {
    injectionCount: () => injections,
    observation: () => observed,
    restore: () => {
      armed = false;
      if (prototype._start === patchedStart) prototype._start = originalStart;
    },
  };
}
