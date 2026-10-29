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
    remoteDeletePending: 0,
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

    // 2026-09-16 拍板延伸：按设置跳过（大型文件/已忽略路径）是预期行为、
    // 零行动，不把整轮拖成 partial——与跳过项退出待处理账本同层同据。
    for (const zeroActionSkip of [
      result({ skippedLarge: 1 }),
      result({ skippedLarge: 5 }),
      result({ skippedIgnored: 1 }),
    ]) {
      expect(isSyncResultFullyComplete(zeroActionSkip)).toBe(true);
      expect(resolveSyncHistoryStatus(zeroActionSkip)).toBe("success");
    }

    for (const incomplete of [
      result({ conflicts: 1 }),
      result({ deferred: 1 }),
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

  it("shows a pre-plan retryable observation as a neutral retry-pending run without flattening ordinary partial runs", () => {
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
      message: "result.remoteReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "unknown",
      },
      disposition,
    }))).toBe("retry-pending");
    expect(resolveSyncHistoryStatus(result({
      success: false,
      errors: 1,
      message: "result.remoteReadUnavailable",
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

  it("keeps the report-table split equal to the executor counts after the success-row cap", () => {
    // A2 regression nail: the history entry retains only 100 successful rows.
    // With 8 pending attention items (3 real conflicts + 5 cloud-delete
    // confirmations) the ConfirmLocalDelete rows can be dropped from `files`
    // while `conflicts` still says 8. Row inference then shows 8 / 0 — the old
    // table/JSON disagreement. The executor's direct split must win.
    const retainedSuccessRows: FileProgress[] = Array.from(
      { length: 100 },
      (_, index) => ({
        path: `uploaded-${index}.md`,
        status: "upload",
        actionType: SyncActionType.Upload,
      }),
    );

    expect(resolveSyncPendingAttentionCounts(8, retainedSuccessRows)).toEqual({
      conflicts: 8,
      remoteDeletes: 0,
    });
    expect(resolveSyncPendingAttentionCounts(
      8,
      retainedSuccessRows,
      5,
    )).toEqual({
      conflicts: 3,
      remoteDeletes: 5,
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
        remoteDeletePending: 1,
        message: zh.t("result.conflictsPending", { conflicts: 1 }),
      }),
      [remoteDelete],
      zh.t.bind(zh),
    )).toBe("本轮有 1 项云端删除待确认");
    expect(formatSyncResultMessage(
      result({
        conflicts: 1,
        remoteDeletePending: 1,
        message: en.t("result.conflictsPending", { conflicts: 1 }),
      }),
      [remoteDelete],
      en.t.bind(en),
    )).toBe("1 cloud deletion(s) need confirmation");

    expect(formatSyncResultMessage(
      result({
        conflicts: 2,
        remoteDeletePending: 1,
        message: zh.t("result.conflictsPending", { conflicts: 2 }),
      }),
      [remoteDelete, conflict],
      zh.t.bind(zh),
    )).toBe("本轮有 1 项冲突待处理，1 项云端删除待确认");
    expect(formatSyncResultMessage(
      result({
        conflicts: 2,
        remoteDeletePending: 1,
        message: en.t("result.conflictsPending", { conflicts: 2 }),
      }),
      [remoteDelete, conflict],
      en.t.bind(en),
    )).toBe("1 conflict(s) need attention; 1 cloud deletion(s) need confirmation");
  });

  it("prefers the executor's direct split and falls back only when it is absent", () => {
    const zh = new I18n("zh-cn");
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

    // Direct 0 wins even when a retained ConfirmLocalDelete row would infer 1.
    expect(formatSyncResultMessage(
      result({
        conflicts: 1,
        remoteDeletePending: 0,
        message: zh.t("result.conflictsPending", { conflicts: 1 }),
      }),
      [remoteDelete],
      zh.t.bind(zh),
    )).toBe("本轮有 1 项冲突待处理");
    // Direct split also works when no action row was retained at all.
    expect(formatSyncResultMessage(
      result({
        conflicts: 2,
        remoteDeletePending: 2,
        message: zh.t("result.conflictsPending", { conflicts: 2 }),
      }),
      [],
      zh.t.bind(zh),
    )).toBe("本轮有 2 项云端删除待确认");

    // Legacy entry without the field keeps the row inference verbatim.
    const legacy = result({
      conflicts: 2,
      message: zh.t("result.conflictsPending", { conflicts: 2 }),
    });
    delete (legacy as Partial<SyncResult>).remoteDeletePending;
    expect(formatSyncResultMessage(
      legacy,
      [remoteDelete, conflict],
      zh.t.bind(zh),
    )).toBe("本轮有 1 项冲突待处理，1 项云端删除待确认");
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

  it("shows a pre-plan ordinary remote read failure as a retry-pending run, not a partial flatten", () => {
    const disposition: NonNullable<SyncResult["disposition"]> = {
      kind: "retryable-observation",
      phase: "remotePrepare",
      code: "ordinary-remote-read-unavailable",
      retry: "next-sync",
      component: "ordinary-remote",
    };
    expect(resolveSyncHistoryStatus(result({
      success: false,
      errors: 1,
      message: "result.remoteReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "unknown",
      },
      disposition,
    }))).toBe("retry-pending");
    // A transient read failure that already produced file work is not a
    // retryable observation; it must remain a partial run.
    expect(resolveSyncHistoryStatus(result({
      success: false,
      downloaded: 1,
      errors: 1,
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
        userFileChanges: "performed",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "ordinary-remote-read-unavailable",
        retry: "next-sync",
        component: "ordinary-remote",
      },
    }))).toBe("partial");
  });
});
