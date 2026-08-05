import type { LocaleStrings } from "../i18n/types";
import type {
  MutationRecoveryBlockReason,
  MutationRecoveryHistory,
} from "../sync/types";

export type MutationRecoveryDisplayKind =
  | "checking"
  | "waiting-network"
  | "blocked";

export interface MutationRecoveryDisplayState {
  kind: MutationRecoveryDisplayKind;
  total: number;
  settled: number;
  remaining: number;
  retryAt: number | null;
  firstPath: string | null;
  blockReason: MutationRecoveryBlockReason | null;
  blockedOperationId: string | null;
  /** Synchronous path/intent eligibility only; no remote fact is inferred here. */
  manualResolutionAvailable?: boolean;
}

type Translator = (
  key: keyof LocaleStrings | string,
  params?: Record<string, string | number>,
) => string;

const BLOCK_REASON_KEYS: Record<
  MutationRecoveryBlockReason,
  keyof LocaleStrings
> = {
  "facts-changed": "mutationRecovery.reason.factsChanged",
  "scope-changed": "mutationRecovery.reason.scopeChanged",
  "account-changed": "mutationRecovery.reason.accountChanged",
  "evidence-corrupt": "mutationRecovery.reason.evidenceCorrupt",
  "state-unavailable": "mutationRecovery.reason.stateUnavailable",
  "automatic-budget-exhausted":
    "mutationRecovery.reason.automaticBudgetExhausted",
  unknown: "mutationRecovery.reason.unknown",
};

export function mutationRecoveryBlockReasonText(
  reason: MutationRecoveryBlockReason | null | undefined,
  t: Translator,
): string {
  const key = BLOCK_REASON_KEYS[reason ?? "unknown"]
    ?? BLOCK_REASON_KEYS.unknown;
  return t(key);
}

export function mutationRecoveryStatusLabel(
  state: Readonly<MutationRecoveryDisplayState>,
  t: Translator,
): string {
  switch (state.kind) {
    case "checking":
      return t("syncView.recovery.checking");
    case "waiting-network":
      return t("syncView.recovery.waitingNetwork");
    case "blocked":
      return t("syncView.recovery.blocked");
  }
}

export function mutationRecoveryStatusDetail(
  state: Readonly<MutationRecoveryDisplayState>,
  t: Translator,
  formatTime: (timestamp: number) => string,
): string {
  if (state.kind === "waiting-network" && state.retryAt !== null) {
    return t("syncView.recovery.detail.retryAt", {
      remaining: state.remaining,
      time: formatTime(state.retryAt),
    });
  }
  if (state.kind === "blocked") {
    const reason = mutationRecoveryBlockReasonText(state.blockReason, t);
    return state.firstPath
      ? t("syncView.recovery.detail.blockedPath", {
          reason,
          remaining: state.remaining,
          path: state.firstPath,
        })
      : t("syncView.recovery.detail.blocked", {
          reason,
          remaining: state.remaining,
        });
  }
  return t("syncView.recovery.detail.pending", {
    remaining: state.remaining,
  });
}

export function formatMutationRecoveryHistory(
  recovery: Readonly<MutationRecoveryHistory>,
  t: Translator,
): string {
  switch (recovery.state) {
    case "waiting-network":
      return t("syncView.history.recovery.waitingNetwork", {
        remaining: recovery.remaining,
        total: recovery.total,
      });
    case "recovered":
      return t("syncView.history.recovery.recovered", {
        settled: recovery.settled,
      });
    case "blocked":
      return t("syncView.history.recovery.blocked", {
        reason: mutationRecoveryBlockReasonText(recovery.blockReason, t),
        remaining: recovery.remaining,
      });
    default:
      return t("syncView.history.recovery.blocked", {
        reason: mutationRecoveryBlockReasonText("unknown", t),
        remaining: Number.isFinite(recovery.remaining)
          ? recovery.remaining
          : 1,
      });
  }
}
