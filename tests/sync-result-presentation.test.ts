import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import type { SyncResult } from "../src/sync/sync-executor";
import type { FileProgress } from "../src/sync/sync-progress";
import { SyncActionType } from "../src/sync/types";
import {
  formatSyncResultMessage,
  isSyncResultFullyComplete,
  resolveSyncPendingAttentionCounts,
  resolveSyncHistoryStatus,
} from "../src/ui/sync-result-presentation";

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    success: true,
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    deferred: 0,
    skippedLarge: 0,
    skippedIgnored: 0,
    errors: 0,
    authExpired: false,
    message: "result.synced",
    ...overrides,
  };
}

describe("sync result presentation", () => {
  it("reserves completed status for a fully settled run", () => {
    expect(isSyncResultFullyComplete(result())).toBe(true);
    expect(resolveSyncHistoryStatus(result())).toBe("success");

    for (const incomplete of [
      result({ conflicts: 1 }),
      result({ deferred: 1 }),
      result({ skippedLarge: 1 }),
      result({ skippedIgnored: 1 }),
    ]) {
      expect(isSyncResultFullyComplete(incomplete)).toBe(false);
      expect(resolveSyncHistoryStatus(incomplete)).toBe("partial");
    }
  });

  it("keeps cancellation, login expiry, zero-action failure and partial failure distinct", () => {
    expect(resolveSyncHistoryStatus(
      result({ success: false }),
      { cancelled: true },
    )).toBe("cancelled");
    expect(resolveSyncHistoryStatus(
      result({ success: false, authExpired: true }),
    )).toBe("authExpired");
    expect(resolveSyncHistoryStatus(
      result({ success: false, errors: 1 }),
    )).toBe("failed");
    expect(resolveSyncHistoryStatus(
      result({ success: false, uploaded: 1, errors: 1 }),
    )).toBe("partial");
    expect(resolveSyncHistoryStatus(
      result({ success: false }),
    )).toBe("failed");
  });

  it("shows a pre-plan retryable observation failure as failed without flattening ordinary partial runs", () => {
    const disposition: NonNullable<SyncResult["disposition"]> = {
      kind: "retryable-observation",
      phase: "remotePrepare",
      code: "shared-control-read-unavailable",
      retry: "next-sync",
      component: "v2",
    };
    expect(resolveSyncHistoryStatus(result({
      success: false,
      errors: 1,
      skippedLarge: 1,
      message: "result.sharedControlReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "unknown",
      },
      disposition,
    }))).toBe("failed");
    expect(resolveSyncHistoryStatus(result({
      success: false,
      errors: 1,
      message: "result.sharedControlReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "entered",
        userFileChanges: "unknown",
      },
      disposition,
    }))).toBe("failed");
    expect(resolveSyncHistoryStatus(result({
      success: false,
      uploaded: 1,
      errors: 1,
    }))).toBe("partial");
  });

  it("separates remote deletion confirmations from real conflicts without changing the control count", () => {
    const files: FileProgress[] = [
      {
        path: "deleted-remotely.md",
        status: "conflict",
        actionType: SyncActionType.ConfirmLocalDelete,
      },
      {
        path: "edited-both-sides.md",
        status: "conflict",
        actionType: SyncActionType.Conflict,
      },
    ];

    expect(resolveSyncPendingAttentionCounts(2, files)).toEqual({
      conflicts: 1,
      remoteDeletes: 1,
    });
    expect(resolveSyncPendingAttentionCounts(1, files)).toEqual({
      conflicts: 0,
      remoteDeletes: 1,
    });
  });

  it("uses action-accurate bilingual summaries for remote deletions and mixed pending items", () => {
    const zh = new I18n("zh-cn");
    const en = new I18n("en");
    const remoteDelete: FileProgress = {
      path: "deleted-remotely.md",
      status: "conflict",
      actionType: SyncActionType.ConfirmLocalDelete,
    };
    const conflict: FileProgress = {
      path: "edited-both-sides.md",
      status: "conflict",
      actionType: SyncActionType.Conflict,
    };

    expect(formatSyncResultMessage(
      result({
        conflicts: 1,
        message: zh.t("result.conflictsPending", { conflicts: 1 }),
      }),
      [remoteDelete],
      zh.t.bind(zh),
    )).toBe("本轮有 1 项远端删除待确认");
    expect(formatSyncResultMessage(
      result({
        conflicts: 1,
        message: en.t("result.conflictsPending", { conflicts: 1 }),
      }),
      [remoteDelete],
      en.t.bind(en),
    )).toBe("1 remote deletion(s) need confirmation");

    expect(formatSyncResultMessage(
      result({
        conflicts: 2,
        message: zh.t("result.conflictsPending", { conflicts: 2 }),
      }),
      [remoteDelete, conflict],
      zh.t.bind(zh),
    )).toBe("本轮有 1 项冲突待处理，1 项远端删除待确认");
    expect(formatSyncResultMessage(
      result({
        conflicts: 2,
        message: en.t("result.conflictsPending", { conflicts: 2 }),
      }),
      [remoteDelete, conflict],
      en.t.bind(en),
    )).toBe("1 conflict(s) need attention; 1 remote deletion(s) need confirmation");
  });

  it("preserves real-conflict and non-default executor messages", () => {
    const zh = new I18n("zh-cn");
    const conflict: FileProgress = {
      path: "edited-both-sides.md",
      status: "conflict",
      actionType: SyncActionType.Conflict,
    };
    const nonDefault = result({
      conflicts: 1,
      message: zh.t("result.pausedForReview"),
    });

    expect(formatSyncResultMessage(
      result({
        conflicts: 1,
        message: zh.t("result.conflictsPending", { conflicts: 1 }),
      }),
      [conflict],
      zh.t.bind(zh),
    )).toBe("本轮有 1 项冲突待处理");
    expect(formatSyncResultMessage(
      nonDefault,
      [{
        path: "deleted-remotely.md",
        status: "conflict",
        actionType: SyncActionType.ConfirmLocalDelete,
      }],
      zh.t.bind(zh),
    )).toBe(zh.t("result.pausedForReview"));
  });
});
