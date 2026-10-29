import type { LocaleStrings } from "../i18n/types";
import type {
  ManualMutationResolutionChoiceV1,
  ManualMutationResolutionSnapshotV1,
  MutationRecoveryBlockReason,
  MutationRecoveryHistory,
} from "../sync/types";

type MutationRecoveryDisplayKind =
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
  /** Display-only snapshot of unresolved paths, blocked record first.
   *  Optional so older callers/tests remain valid; the sidebar treats
   *  missing/empty as "path unavailable". */
  paths?: readonly string[];
  /** Display-only: scheduler exhausted. In-memory; never persisted. */
  exhausted?: boolean;
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

interface OrdinaryResolutionAction {
  choice: ManualMutationResolutionChoiceV1;
  labelKey: keyof LocaleStrings;
  /** Native intent of the button: `mod-cta` restores the file, `mod-warning`
   *  removes the only surviving copy, null keeps both directions neutral. */
  className: "mod-cta" | "mod-warning" | null;
}

/**
 * Action labels for the ordinary single-path review (2026-10-25 user report).
 *
 * The old labels named the SIDE ("keep local" / "keep cloud"). That wording is
 * false as soon as the chosen side holds no file: "keeping" an empty side
 * deletes the copy on the other side, which is what a recovery review of a
 * vanished local download actually did. Labels therefore name the resulting
 * operation, and button colour names the consequence instead of the side.
 *
 * Both sides present keeps the side wording with an explicit "version" noun
 * (there "keep" is true and the decision is which version wins). Move-style
 * records and whole-bundle reviews keep their own contracts, so this returns
 * null for both and the caller keeps its existing rendering.
 */
export function resolveOrdinaryResolutionActions(
  snapshot: Readonly<ManualMutationResolutionSnapshotV1>,
): OrdinaryResolutionAction[] | null {
  if (snapshot.bundleReview !== undefined || snapshot.sourcePath !== undefined) {
    return null;
  }
  const local = snapshot.local[0];
  const remote = snapshot.remote[0];
  if (!local || !remote) return null;
  if (local.exists && remote.exists) {
    return [
      {
        choice: "keep-local",
        labelKey: "syncView.mutationResolution.keepLocalVersion",
        className: null,
      },
      {
        choice: "keep-remote",
        labelKey: "syncView.mutationResolution.keepRemoteVersion",
        className: null,
      },
    ];
  }
  if (!local.exists && remote.exists) {
    return [
      {
        choice: "keep-remote",
        labelKey: "syncView.mutationResolution.action.download",
        className: "mod-cta",
      },
      {
        choice: "keep-local",
        labelKey: "syncView.mutationResolution.action.deleteRemote",
        className: "mod-warning",
      },
    ];
  }
  if (local.exists && !remote.exists) {
    return [
      {
        choice: "keep-local",
        labelKey: "syncView.mutationResolution.action.upload",
        className: "mod-cta",
      },
      {
        choice: "keep-remote",
        labelKey: "syncView.mutationResolution.action.deleteLocal",
        className: "mod-warning",
      },
    ];
  }
  // Neither side holds the file: identical facts, settled before this surface.
  return null;
}

/**
 * Block reasons under which the fixed recovery review exit may be offered.
 * facts-changed is the classified shape. state-unavailable also qualifies:
 * that stamp describes how the LAST round ended, not what the record is, and
 * the resolution flow re-inspects both sides and refuses on any uncertainty
 * at decision time — offering the exit there only stops a transient crash
 * stamp from freezing a resolvable record behind "export or reset" (field
 * reports 2026-09-28). Corrupt evidence, account change, and scope recovery
 * keep their own dedicated exits, and eligibility itself stays gated by
 * canResolveMutationRecovery.
 */
export function manualResolutionExitAllowedFor(
  blockReason: MutationRecoveryBlockReason | null | undefined,
): boolean {
  return blockReason === "facts-changed"
    || blockReason === "state-unavailable";
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
  // Budget exhaustion is no longer an implicit network wait: the scheduler
  // has stopped automatic retries, so the row belongs to the blocked family.
  if (state.exhausted === true) {
    return t("syncView.recovery.blocked");
  }
  return mutationRecoveryStatusLabel(state, t);
}

interface MutationRecoveryBodyPresentation {
  summary: string;
  /** Paths this state chooses to show. V3–V6 deliberately return none. */
  paths: readonly string[];
  showFileList: boolean;
  nextStep: string | null;
  actionKey: keyof LocaleStrings | null;
  secondaryAction: "open-settings" | null;
}

export function mutationRecoveryPrimaryActionKey(
  state: Readonly<MutationRecoveryDisplayState>,
): keyof LocaleStrings | null {
  // Only real user actions survive the existence test: a keep-side review
  // for facts-changed ordinary-file records, and a scope-recovery retry for
  // scope-changed (a manual round re-runs scope recovery and can reach plan
  // review). Every other recovery state is honest status without a choice
  // button. The blocked-folder settlement deliberately has NO top-slot
  // button: its exit lives on the pending-list row / recovery-section body
  // next to the record itself (2026-09-13 UI 裁决), and folderSettleAvailable
  // only switches the next-step pointer below.
  if (
    state.kind === "blocked"
    && manualResolutionExitAllowedFor(state.blockReason)
    && state.manualResolutionAvailable === true
  ) {
    return "syncView.recovery.reviewDetails";
  }
  if (state.kind === "blocked" && state.blockReason === "scope-changed") {
    return "syncView.recovery.retryScopeRecovery";
  }
  return null;
}

/**
 * Body copy for one recovery state.
 *
 * `options.nonRetryable` (S4 终止判据接线, docs 2026-10-16 §六 S4): the blocked
 * record's facts were identical across two consecutive observed rounds and it
 * has no live exit, so the "temporarily cannot be confirmed automatically"
 * line is false — it is replaced by the one terminal diagnosis line. The
 * caller resolves that flag from the executor's verdict; no eligibility rule
 * is re-derived here, and every other state keeps its copy untouched.
 */
export function mutationRecoveryBodyPresentation(
  state: Readonly<MutationRecoveryDisplayState>,
  t: Translator,
  formatTime: (timestamp: number) => string,
): MutationRecoveryBodyPresentation {
  const paths = state.paths ?? [];
  const exhausted = state.exhausted === true;
  if (state.kind === "checking") {
    return {
      summary: t("syncView.recovery.summary.checking"),
      paths,
      showFileList: true,
      nextStep: null,
      actionKey: mutationRecoveryPrimaryActionKey(state),
      secondaryAction: null,
    };
  }
  if (state.kind === "waiting-network") {
    if (exhausted) {
      return {
        summary: t("syncView.recovery.body.exhausted"),
        paths: [],
        showFileList: false,
        nextStep: t("syncView.recovery.nextStep.blocked"),
        actionKey: null,
        secondaryAction: null,
      };
    }
    return {
      summary: state.retryAt === null
        ? t("syncView.recovery.summary.waitingNetwork")
        : t("syncView.recovery.summary.waitingNetworkAt", {
          time: formatTime(state.retryAt),
        }),
      paths,
      showFileList: true,
      nextStep: null,
      actionKey: null,
      secondaryAction: null,
    };
  }

  const actionKey = mutationRecoveryPrimaryActionKey(state);
  if (actionKey === "syncView.recovery.reviewDetails") {
    return {
      summary: t("syncView.recovery.body.review"),
      paths: [],
      showFileList: false,
      nextStep: null,
      actionKey,
      secondaryAction: null,
    };
  }
  if (state.blockReason === "scope-changed") {
    return {
      summary: t("syncView.recovery.body.scopeChanged"),
      paths: [],
      showFileList: false,
      nextStep: t("syncView.recovery.nextStep.scope"),
      actionKey,
      secondaryAction: null,
    };
  }
  if (state.blockReason === "account-changed") {
    return {
      summary: t("syncView.recovery.body.accountChanged"),
      paths: [],
      showFileList: false,
      nextStep: t("syncView.recovery.nextStep.accountChanged"),
      actionKey,
      secondaryAction: "open-settings",
    };
  }
  return {
    summary: t("syncView.recovery.summary.interrupted"),
    paths,
    showFileList: true,
    nextStep: t("syncView.recovery.nextStep.blocked"),
    actionKey,
    secondaryAction: null,
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

/**
 * Which of the two "no available action" hints a move-style record can still
 * state honestly. The keep-cloud sentence promises the file at the *old* cloud
 * path and its return to the old local path; once the cloud already holds the
 * moved name that path is gone (2026-10-13 field report), so the sentence is
 * dropped rather than promising a file that is not there. The keep-local
 * sentence carries its own "（若存在）" qualifier and stays.
 */
export function resolveMoveNoActionHints(input: {
  sourcePath: string | null;
  remoteSourceExists: boolean;
}): Array<"keep-local" | "keep-remote"> {
  if (!input.sourcePath) return [];
  return input.remoteSourceExists
    ? ["keep-local", "keep-remote"]
    : ["keep-local"];
}
