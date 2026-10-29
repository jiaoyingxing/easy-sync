import { describe, expect, it, vi } from "vitest";
import { canonicalPlanDigestV2 } from "../src/sync/canonical-plan-v2";
import {
  localDeleteDecisionPathHash,
  localDeleteDecisionRecordToken,
  serializeLocalDeleteDecisionHashes,
} from "../src/sync/local-delete-decision";
import { SyncExecutor } from "../src/sync/sync-executor";
import {
  SyncActionType,
  type CanonicalPlanIdentityV2,
  type SyncDecisionToken,
  type SyncPlan,
  type SyncPlanItem,
  type SyncScope,
} from "../src/sync/types";
import { okResult } from "./helpers/main-sync-entry-harness";
import {
  emptyScanner,
  makeMockOneDrive,
  TEST_SYNC_SCOPE,
} from "./helpers/sync-safety-harness";

const hashA = "a".repeat(64);
const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
const local = {
  path: "gone.md",
  hash: hashA,
  size: 10,
  mtime: 1,
  binary: false,
};

function token(): SyncDecisionToken {
  return {
    version: 1,
    vaultName: "testVault",
    accountId: scope.accountId,
    scope,
    local: { exists: true, hash: hashA, size: 10 },
    remote: { exists: false },
    ancestorHash: hashA,
  };
}

function identity(items: SyncPlanItem[], digestItems = items): CanonicalPlanIdentityV2 {
  return {
    version: 2,
    scope,
    sourceCommitSeq: 7,
    digest: canonicalPlanDigestV2({
      items: digestItems,
      lastTotalFiles: 10,
      scope,
      sourceCommitSeq: 7,
    }),
  };
}

function plan(input: {
  withDecision: boolean;
  threshold: boolean;
}): {
  plan: SyncPlan;
  d0: CanonicalPlanIdentityV2;
  record: {
    token: string;
    paths: string[];
    planDigest: string;
    createdAt: number;
  };
  reviewed: { revision: number; scope: SyncScope; canonicalIdentity: CanonicalPlanIdentityV2 };
} {
  const decisionToken = token();
  const confirmItem: SyncPlanItem = {
    type: SyncActionType.ConfirmLocalDelete,
    path: "gone.md",
    local,
    decisionToken,
  };
  const deleteItem: SyncPlanItem = {
    ...confirmItem,
    type: SyncActionType.DeleteLocal,
  };
  const record = {
    token: localDeleteDecisionRecordToken(decisionToken),
    paths: ["gone.md"],
    planDigest: serializeLocalDeleteDecisionHashes([
      localDeleteDecisionPathHash(decisionToken, "gone.md"),
    ]),
    createdAt: 1,
  };
  const preIdentity = identity([confirmItem]);
  const d1 = identity([deleteItem]);
  const planValue: SyncPlan = {
    items: input.withDecision ? [deleteItem] : [confirmItem],
    lastTotalFiles: 10,
    confirmed: false,
    scope,
    canonicalIdentity: input.withDecision ? d1 : preIdentity,
    preDecisionIdentity: preIdentity,
    preDecisionRequiresThresholdConfirmation: false,
    requiresThresholdConfirmation: input.threshold,
    appliedLocalDeleteDecisions: input.withDecision
      ? [{ token: record.token, path: "gone.md" }]
      : [],
    canonicalReview: {
      counts: {
        uploads: 0,
        downloads: 0,
        deletes: 1,
        conflicts: 0,
        skipped: 0,
      },
      impactCount: 1,
    },
  };
  return {
    plan: planValue,
    d0: preIdentity,
    record,
    reviewed: {
      revision: 1,
      scope,
      canonicalIdentity: preIdentity,
    },
  };
}

function executorWithState(input: {
  record: ReturnType<typeof plan>["record"] | null;
  reviewIdentity: CanonicalPlanIdentityV2;
}) {
  const state = {
    planReviewActive: true,
    planReviewRevision: 1,
    planReviewScope: scope,
    planReviewCanonicalIdentity: input.reviewIdentity,
    planReviewDigest: input.reviewIdentity.digest,
    localDeleteDecisions: input.record ? [input.record] : [],
    clearPlanReview: vi.fn().mockResolvedValue(true),
  };
  const executor = new SyncExecutor(
    makeMockOneDrive(),
    emptyScanner(),
    state as never,
    "testVault",
  );
  const gate = (executor as unknown as {
    runStep5_13VerifyReviewedPlanDigest: (args: unknown) => Promise<
      { terminated: unknown } | { terminated: null }
    >;
  }).runStep5_13VerifyReviewedPlanDigest.bind(executor);
  const capture = (executor as unknown as {
    lifecycle: { capture: () => number };
  }).lifecycle.capture();
  return { state, gate, operationEpoch: capture, executor };
}

async function runGate(input: {
  withDecision: boolean;
  threshold: boolean;
  record?: ReturnType<typeof plan>["record"] | null;
  reviewedOverride?: { revision: number; scope: SyncScope; canonicalIdentity: CanonicalPlanIdentityV2 };
}) {
  const built = plan({
    withDecision: input.withDecision,
    threshold: input.threshold,
  });
  const { state, gate, operationEpoch } = executorWithState({
    record: input.record === undefined ? built.record : input.record,
    reviewIdentity: built.d0,
  });
  const onConfirmThreshold = vi.fn().mockResolvedValue(true);
  const waitForReview = vi.fn(async (review: () => Promise<boolean>) =>
    review());
  const result = okResult();
  const outcome = await gate({
    result,
    operationEpoch,
    plan: built.plan,
    callbacks: { onConfirmThreshold },
    reviewedAuthorization: input.reviewedOverride ?? built.reviewed,
    skipConfirmation: true,
    syncScope: scope,
    attemptV2Activation: false,
    migrationAuthorityCommittedThisRun: false,
    waitForReview,
  });
  return { outcome, onConfirmThreshold, waitForReview, state, result };
}

describe("reviewed plan + local delete decision composition (S4 gate)", () => {
  it("accepts D0 plus the verified decision delta and clears the review", async () => {
    const { outcome, onConfirmThreshold, state } = await runGate({
      withDecision: true,
      threshold: false,
    });
    expect(outcome).toEqual({ terminated: null });
    expect(onConfirmThreshold).not.toHaveBeenCalled();
    expect(state.clearPlanReview).toHaveBeenCalledOnce();
  });

  it("re-pauses when the decision is missing, even if the rest of the plan matches", async () => {
    const { outcome, onConfirmThreshold, state } = await runGate({
      withDecision: true,
      threshold: false,
      record: null,
    });
    expect(outcome).not.toEqual({ terminated: null });
    expect(onConfirmThreshold).toHaveBeenCalledOnce();
    expect(state.clearPlanReview).not.toHaveBeenCalled();
  });

  it("does not skip the 50% gate when the converted deletes push D1 over it", async () => {
    const { outcome, onConfirmThreshold, state } = await runGate({
      withDecision: true,
      threshold: true,
    });
    expect(outcome).not.toEqual({ terminated: null });
    expect(onConfirmThreshold).toHaveBeenCalledOnce();
    expect(state.clearPlanReview).not.toHaveBeenCalled();
  });

  it("accepts the already-converted plan when the review itself seals D1", async () => {
    const built = plan({ withDecision: true, threshold: false });
    const { state, gate, operationEpoch } = executorWithState({
      record: built.record,
      reviewIdentity: built.plan.canonicalIdentity!,
    });
    const onConfirmThreshold = vi.fn().mockResolvedValue(true);
    const result = okResult();
    const outcome = await gate({
      result,
      operationEpoch,
      plan: built.plan,
      callbacks: { onConfirmThreshold },
      reviewedAuthorization: {
        revision: 1,
        scope,
        canonicalIdentity: built.plan.canonicalIdentity!,
      },
      skipConfirmation: true,
      syncScope: scope,
      attemptV2Activation: false,
      migrationAuthorityCommittedThisRun: false,
      waitForReview: async (review: () => Promise<boolean>) => review(),
    });
    expect(outcome).toEqual({ terminated: null });
    expect(onConfirmThreshold).not.toHaveBeenCalled();
    expect(state.clearPlanReview).toHaveBeenCalledOnce();
  });
});
