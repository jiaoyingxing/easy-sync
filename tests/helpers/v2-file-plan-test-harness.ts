import {
  generateFileDecisionPlanV2,
} from "../../src/sync/file-decision-planner-v2";
import {
  shouldPauseCanonicalPlanForReviewV2,
  summarizeCanonicalPlanReviewV2,
} from "../../src/sync/canonical-plan-v2";
import type {
  BaseFileEntry,
  LocalFileEntry,
  RemoteFileEntry,
  SyncPlan,
} from "../../src/sync/types";

/**
 * Thin test harness for the active V2 file planner.
 * This is intentionally not evidence of public 1.1.3 behavior.
 */
export class V2FilePlanTestHarness {
  buildFilePlan(
    localEntries: LocalFileEntry[],
    remoteEntries: RemoteFileEntry[],
    baseEntries: BaseFileEntry[],
    skippedLarge: string[],
  ): SyncPlan {
    return generateFileDecisionPlanV2({
      localEntries,
      remoteEntries,
      baseEntries,
      skippedLarge,
    });
  }

  requiresReview(plan: SyncPlan): boolean {
    return shouldPauseCanonicalPlanForReviewV2(
      summarizeCanonicalPlanReviewV2(plan.items).impactCount,
      plan.lastTotalFiles,
    );
  }
}
