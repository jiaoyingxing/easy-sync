import { describe, expect, it } from "vitest";
import {
  buildSyncPendingDisplayRows,
  EasySyncSyncView,
} from "../src/ui/sync-view";
import { I18n } from "../src/i18n";
import { SyncActionType } from "../src/sync/types";
import type { SyncDecisionToken, SyncPlanItem } from "../src/sync/types";
import {
  collectLocalDeleteDecisionCoveredPaths,
  localDeleteDecisionPathHash,
  serializeLocalDeleteDecisionHashes,
  type LocalDeleteDecisionV1,
} from "../src/sync/local-delete-decision";

const scope = {
  accountId: "account-id",
  driveId: "drive-id",
  vaultFolderId: "vault-folder-id",
  filesRootId: "files-root-id",
};

function decisionToken(path: string, hash: string): SyncDecisionToken {
  return {
    version: 1,
    vaultName: "testVault",
    accountId: scope.accountId,
    scope,
    local: { exists: true, hash, size: 1 },
    remote: { exists: false },
    ancestorHash: null,
  };
}

function pendingDelete(path: string, hash = `hash-${path}`): SyncPlanItem {
  return {
    type: SyncActionType.ConfirmLocalDelete,
    path,
    local: { path, hash, size: 1, mtime: 1, binary: false },
    decisionToken: decisionToken(path, hash),
  };
}

function decisionRecord(
  paths: readonly string[],
  decisionHashes: Readonly<Record<string, string>> = {},
): LocalDeleteDecisionV1 {
  const hashes = paths.map((path) =>
    localDeleteDecisionPathHash(
      decisionToken(path, decisionHashes[path] ?? `hash-${path}`),
      path,
    ));
  return {
    token: "local-delete:test",
    paths: [...paths],
    planDigest: serializeLocalDeleteDecisionHashes(hashes),
    createdAt: 1,
  };
}

function makeView(input: {
  pendingPaths: string[];
  decisionPaths: string[];
  rowHashes?: Readonly<Record<string, string>>;
  decisionHashes?: Readonly<Record<string, string>>;
}) {
  const syncState = {
    pendingConflicts: [],
    pendingRemoteDeletes: input.pendingPaths.map((path) =>
      pendingDelete(path, input.rowHashes?.[path])),
    pendingIssues: [],
    planReviewActive: false,
    planReviewRevision: 0,
    planReviewCounts: null,
    planReviewItems: [],
    planReviewAuthorization: undefined,
    syncHistory: [],
    lastSyncTime: 0,
    localDeleteDecisions: input.decisionPaths.length === 0
      ? []
      : [decisionRecord(input.decisionPaths, input.decisionHashes)],
  };
  const captured: Array<{
    bodyMode: string;
    pendingDeletes: SyncPlanItem[];
  }> = [];
  const plugin = {
    progressStore: {
      state: {
        phase: "idle" as const,
        current: 0,
        total: 0,
        currentFile: "",
        currentItemBytes: 0,
        currentItemTotalBytes: 0,
        currentItemComplete: false,
        cancelRequested: false,
        completedFiles: [],
        completedCount: 0,
        startedAt: 0,
      },
    },
    syncExecutor: {
      isRunning: false,
      hasSideActionsInFlight: false,
      isSideActionQueued: () => false,
      getSyncItemTerminationSnapshot: () => [],
    },
    isSyncEntryCancellable: false,
    isSyncEntryInProgress: false,
    autoSyncPaused: false,
    auth: undefined,
    state: syncState,
    i18n: new I18n("zh-cn"),
    getCommunityPluginAdoptionRows: () => [],
    getLocalOnlyRows: () => [],
    getMutationRecoveryDisplayState: () => null,
    getUpdatePromptState: () => null,
  };
  const view = Object.create(EasySyncSyncView.prototype) as EasySyncSyncView;
  Object.assign(view as object, {
    contentEl: {
      scrollTop: 0,
      querySelector: () => null,
    },
    lastContentKey: null,
    renderedBodyMode: "idle",
    historyExpanded: false,
    plugin,
    refreshTransferRateValue: () => undefined,
    scheduleAdaptivePathLayout: () => undefined,
    renderSyncViewFullRebuild: (args: {
      bodyMode: string;
      pendingDeletes: SyncPlanItem[];
    }) => {
      captured.push({
        bodyMode: args.bodyMode,
        pendingDeletes: args.pendingDeletes,
      });
    },
  });
  const render = (): { bodyMode: string; pendingDeletes: SyncPlanItem[] } => {
    (view as unknown as { doRender: () => void }).doRender();
    const last = captured[captured.length - 1];
    if (!last) throw new Error("doRender did not rebuild the body");
    return last;
  };
  return { view, syncState, render };
}

function deleteRowKeys(pendingDeletes: readonly SyncPlanItem[]): string[] {
  return buildSyncPendingDisplayRows({
    adoptionRows: [],
    failures: [],
    conflictEntries: [],
    pendingDeletes,
    skipped: [],
  })
    .filter((row) => row.kind === "delete")
    .map((row) => row.key);
}

describe("pending delete rows covered by an unconsumed local delete decision", () => {
  it("hides only the covered row and brings it back when the decision is gone", () => {
    const { syncState, render } = makeView({
      pendingPaths: ["a.md", "b.md", "c.md"],
      decisionPaths: ["a.md"],
    });

    const covered = render();
    expect(covered.pendingDeletes.map((item) => item.path)).toEqual([
      "b.md",
      "c.md",
    ]);
    expect(deleteRowKeys(covered.pendingDeletes)).toEqual([
      "delete:b.md",
      "delete:c.md",
    ]);

    // 消费/撤销后记录不再覆盖这条路径：行必须重新出现，否则失败项会被藏起来。
    syncState.localDeleteDecisions = [];
    const restored = render();
    expect(restored.pendingDeletes.map((item) => item.path)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });

  it("keeps the batch button count equal to the rows it will delete", () => {
    const { render } = makeView({
      pendingPaths: ["a.md", "b.md", "c.md"],
      decisionPaths: ["a.md"],
    });

    const { pendingDeletes } = render();
    const rows = buildSyncPendingDisplayRows({
      adoptionRows: [],
      failures: [],
      conflictEntries: [],
      pendingDeletes,
      skipped: [],
    });
    const batch = rows.find((row) => row.kind === "batchDelete");
    expect(batch?.deletes?.map((item) => item.path)).toEqual(["b.md", "c.md"]);
    expect(deleteRowKeys(pendingDeletes)).toHaveLength(batch?.deletes?.length ?? 0);
  });

  it("drops the whole batch row when every pending delete is covered", () => {
    const { render } = makeView({
      pendingPaths: ["a.md", "b.md"],
      decisionPaths: ["a.md", "b.md"],
    });

    const result = render();
    expect(result.pendingDeletes).toEqual([]);
    // 没有待确认删除行时不再停在 pending 体态：底部按钮与列表一起退出。
    expect(result.bodyMode).toBe("idle");
    expect(deleteRowKeys(result.pendingDeletes)).toEqual([]);
  });

  it("does not hide a row whose facts no longer match the recorded decision", () => {
    const { render } = makeView({
      pendingPaths: ["a.md"],
      decisionPaths: ["a.md"],
      rowHashes: { "a.md": "changed-hash" },
      decisionHashes: { "a.md": "hash-a.md" },
    });

    // 摘要不符时计划不会消费这条决定；界面不能把它当作已授权而藏起来。
    const result = render();
    expect(result.pendingDeletes.map((item) => item.path)).toEqual(["a.md"]);
    expect(deleteRowKeys(result.pendingDeletes)).toEqual(["delete:a.md"]);
  });
});

describe("local delete decision coverage facts", () => {
  it("never treats an unreadable record as coverage", () => {
    const record = decisionRecord(["a.md"]);
    record.planDigest = "not-json";
    expect(collectLocalDeleteDecisionCoveredPaths({
      decisions: [record],
      items: [pendingDelete("a.md")],
    })).toEqual(new Set());
  });

  it("never hides a legacy row without a decision token", () => {
    const item = pendingDelete("a.md");
    delete item.decisionToken;
    expect(collectLocalDeleteDecisionCoveredPaths({
      decisions: [decisionRecord(["a.md"])],
      items: [item],
    })).toEqual(new Set());
  });

  it("never hides an action the planner would not convert", () => {
    const item: SyncPlanItem = {
      ...pendingDelete("a.md"),
      type: SyncActionType.DeleteLocal,
    };
    expect(collectLocalDeleteDecisionCoveredPaths({
      decisions: [decisionRecord(["a.md"])],
      items: [item],
    })).toEqual(new Set());
  });
});
