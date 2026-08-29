import type { LocaleStrings } from "../i18n/types";
import type {
  ManualMutationResolutionSnapshotV1,
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
  /** True when the recovery block paused auto-sync (non-isolated block). */
  paused?: boolean;
}

type Translator = (
  key: string,
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

export function shouldAutoSettleIdenticalRecovery(
  snapshot: Readonly<ManualMutationResolutionSnapshotV1>,
): boolean {
  // Ordinary identical facts leave no keep-side decision for the user.
  // Whole-bundle reviews carry their own member-level identity semantics
  // and must keep their explicit confirmation flow.
  return snapshot.identical && snapshot.bundleReview === undefined;
}

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

export function mutationRecoveryTopStatusLabel(
  state: Readonly<MutationRecoveryDisplayState>,
  t: Translator,
): string {
  if (state.kind === "checking") {
    return t("syncView.recovery.checkingTop");
  }
  return mutationRecoveryStatusLabel(state, t);
}

export interface MutationRecoveryBodyPresentation {
  summary: string;
  path: string | null;
  reason: string | null;
  retryAt: string | null;
  nextStep: string;
  actionKey: keyof LocaleStrings | null;
}

export function mutationRecoveryPrimaryActionKey(
  state: Readonly<MutationRecoveryDisplayState>,
): keyof LocaleStrings | null {
  // Only real user actions survive the existence test: a keep-side review
  // for facts-changed records, and a scope-recovery retry for scope-changed
  // (a manual round re-runs scope recovery and can reach plan review).
  // Every other recovery state is honest status without a choice button.
  if (
    state.kind === "blocked"
    && state.blockReason === "facts-changed"
    && state.manualResolutionAvailable === true
  ) {
    return "syncView.recovery.reviewDetails";
  }
  if (state.kind === "blocked" && state.blockReason === "scope-changed") {
    return "syncView.recovery.retryScopeRecovery";
  }
  return null;
}

export function mutationRecoveryBodyPresentation(
  state: Readonly<MutationRecoveryDisplayState>,
  t: Translator,
  formatTime: (timestamp: number) => string,
): MutationRecoveryBodyPresentation {
  if (state.kind === "checking") {
    return {
      summary: t("syncView.recovery.summary.checking"),
      path: state.firstPath,
      reason: null,
      retryAt: null,
      nextStep: t("syncView.recovery.nextStep.checking"),
      actionKey: mutationRecoveryPrimaryActionKey(state),
    };
  }
  if (state.kind === "waiting-network") {
    return {
      summary: t("syncView.recovery.summary.waitingNetwork"),
      path: state.firstPath,
      reason: null,
      retryAt: state.retryAt === null ? null : formatTime(state.retryAt),
      nextStep: t("syncView.recovery.nextStep.waitingNetwork"),
      actionKey: null,
    };
  }
  const actionKey = mutationRecoveryPrimaryActionKey(state);
  const canReview = actionKey === "syncView.recovery.reviewDetails";
  const nextStepKey = canReview
    ? "syncView.recovery.nextStep.review"
    : state.blockReason === "account-changed"
      ? "syncView.recovery.nextStep.accountChanged"
      : "syncView.recovery.nextStep.blocked";
  return {
    summary: t(
      state.paused
        ? "syncView.recovery.summary.blockedPaused"
        : "syncView.recovery.summary.blocked",
      {
        count: state.remaining,
      },
    ),
    path: state.firstPath,
    reason: mutationRecoveryBlockReasonText(state.blockReason, t),
    retryAt: null,
    nextStep: t(nextStepKey),
    actionKey,
  };
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
