import { describe, expect, it, vi } from "vitest";
import { SyncExecutor } from "../src/sync/sync-executor";
import { SyncActionType, type SyncPlan, type SyncPlanItem, type SyncScope } from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  emptyScanner,
  makeActiveV2State,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

/**
 * 计划派生的可见待办在**规划落地那一刀**就写进状态，而不是等到执行结束。
 *
 * 背景（2026-10-16 现场发现）：待办行原先只在 `executePlan` 末尾落库一次，而
 * `executePlan` 内有多处提前 `return`，加上共享状态提交闸门「账本非空即丢弃整轮
 * 待办」⇒ 只要账本里还剩任何未结清记录，用户就看不到计划刚刚交付的任何行——
 * 包括 F29 家族修复之后本该出现的那几条带出口的冲突行。
 *
 * 本文件钉住的性质：**规划产出的行不随共享状态提交同生共死**。这与项目已有的
 * `runStep5_12`「审阅闸门扣住本轮时也要让陈旧行退场」是同一原则的另一半。
 */

const scope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };

function makeExecutor() {
  const state = makeActiveV2State([], []);
  const reconcilePendingIssues = vi.fn(async () => undefined);
  const prunePendingIssues = vi.fn(async () => undefined);
  Object.assign(state as unknown as Record<string, unknown>, {
    reconcilePendingIssues,
    prunePendingIssues,
    pendingIssues: [],
  });
  const executor = new SyncExecutor(
    makeMockOneDrive({}),
    emptyScanner(),
    state,
    "testVault",
  );
  const prune = (plan: SyncPlan) => (executor as unknown as {
    prunePlannerDerivedStaleIssues(
      plan: SyncPlan,
      protectedRecords: readonly unknown[],
    ): Promise<void>;
  }).prunePlannerDerivedStaleIssues(plan, []);
  return { executor, state, reconcilePendingIssues, prunePendingIssues, prune };
}

const deferredFolderItem: SyncPlanItem = {
  type: SyncActionType.FolderDeferred,
  path: "F",
  reason: "reason.folder.remote-subtree-changed",
} as unknown as SyncPlanItem;

const transientItem: SyncPlanItem = {
  type: SyncActionType.RetryLater,
  path: "note.md",
  reason: "reason.circuitBreaker.network",
} as unknown as SyncPlanItem;

const plan = (items: SyncPlanItem[]): SyncPlan => ({
  items,
  lastTotalFiles: items.length,
  confirmed: true,
  scope,
});

describe("planner-derived pending rows land with the plan", () => {
  it("writes the planner-derived row in the same step that retires the stale ones", async () => {
    const { reconcilePendingIssues, prune } = makeExecutor();

    await prune(plan([deferredFolderItem]));

    expect(reconcilePendingIssues).toHaveBeenCalledTimes(1);
    const [issues, resolved] = reconcilePendingIssues.mock.calls[0] as unknown as [
      Array<{ path: string; actionType: string; issueCode?: string }>,
      string[],
    ];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: "F",
      actionType: SyncActionType.FolderDeferred,
      // The stable route the sidebar uses to offer the resolution entry.
      issueCode: "remote-subtree-changed",
    });
    expect(resolved).toEqual([]);
  });

  it("does not republish an execution-phase transient from the planning step", async () => {
    // `transfer-network` / `transfer-remote-moving` are execution-phase
    // transients with their own retry arm; the planning step must not claim
    // them. (The end-of-round reconcile keeps owning them, unchanged.)
    const { reconcilePendingIssues, prune } = makeExecutor();

    await prune(plan([transientItem]));

    expect(reconcilePendingIssues).not.toHaveBeenCalled();
  });

  it("writes nothing when the plan produces no resolvable row", async () => {
    const { reconcilePendingIssues, prune } = makeExecutor();

    await prune(plan([{
      type: SyncActionType.Upload,
      path: "note.md",
    } as unknown as SyncPlanItem]));

    expect(reconcilePendingIssues).not.toHaveBeenCalled();
  });
});
