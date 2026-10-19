// 计划派生的**决策行**（冲突行／删除确认行）与共享状态提交解耦（2026-10-18）。
//
// 家族背景（设计单 §J-1／第二刀日志 §未覆盖；唯一详细承接位＝
// docs/dev-logs/2026-10/20261016-205048 …／20261016-213000 …）：
// 用户可见待办（冲突行／删除确认／问题行）原先只在 `executePlan` 末尾落库一次，
// 而那一块的最后一步才是**共享状态提交闸门**——账本里还剩未结清记录、且它与轮首
// 的隔离保护集不同即 throw，拒绝发布共同状态。本轮收集到的行一律留在内存里，
// 于是：只要本轮还有一条落不进共同状态的记录（含本轮新落下的那条），本轮计划
// 刚刚交付给用户的行就整批消失。第三刀（`20261016-213000`）只把**规划派生的
// 问题行**提前到规划步落库；冲突行与删除确认行仍在轮末落库。
//
// 本文件钉住的性质：**决策行随计划走、不随提交走**——它们在全部审阅闸门放行之后、
// 执行之前落库（`runStep7_6PrunePendingDecisions`：先退场陈旧行，随即落本计划
// 派生的行），因此执行内 fail-closed 重抛或轮末闸门都不再把它们整批抹掉；轮末的
// `upsertPendingConflicts`／`upsertPendingDeletes` 仍是唯一 owner（同一计划项、
// 同一「计划项→行」映射、按路径 upsert 幂等，两处产出逐字段同形）。
import { describe, expect, it, vi } from "vitest";
import { SyncActionType } from "../src/sync/types";
import type { SyncPlan, SyncPlanItem, SyncScope } from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import { sha256Hex } from "../src/crypto";
import type { LocalScanner } from "../src/sync/local-scanner";
import type {
  BaseFileEntry,
  LocalFileEntry,
  MutationLedgerEntryV1,
  PendingIssue,
  RemoteFileEntry,
} from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  emptyScanner,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

const ACTIVE_SCOPE: SyncScope = {
  ...TEST_SYNC_SCOPE,
  accountId: "account-id",
};

const emptyCheckpoint = () => ({
  baseUpserts: [],
  baseRemovals: [],
  remoteUpserts: [],
  remoteDeletes: [],
  pendingConflictRemovals: [],
  pendingDeleteRemovals: [],
});

/** F29 野外形状的账本记录（S2 第三阻塞点）：意图是新建文件夹 `NewDir`，回执与
 *  两侧事实核验一致，而共同状态结构性拒绝吸收 ⇒ 记录留在账本、被记录级隔离，
 *  其余路径照常同步（这正是「账本里还剩一条未结清记录」的来源）。 */
const makeStuckFolderCreateRecord = (): MutationLedgerEntryV1 => ({
  intent: {
    version: 2,
    operationId: "op-stuck",
    planRevision: 1,
    scope: ACTIVE_SCOPE,
    action: "createRemoteFolder",
    path: "NewDir",
    expectedLocal: { exists: true },
    expectedRemote: { exists: false },
    expectedParent: {
      driveId: TEST_SYNC_SCOPE.filesRootId,
      path: "",
    },
    createdAt: 1,
  } as MutationLedgerEntryV1["intent"],
  receipt: {
    version: 1,
    operationId: "op-stuck",
    completedAt: 2,
    checkpoint: {
      ...emptyCheckpoint(),
      folderUpserts: [{
        path: "NewDir",
        driveId: "folder-new",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        name: "NewDir",
        eTag: "etag-new",
      }],
    },
  },
});

const localFile = async (
  path: string,
  bytes: ArrayBuffer,
): Promise<LocalFileEntry> => ({
  path,
  hash: await sha256Hex(bytes),
  size: bytes.byteLength,
  mtime: 1,
  binary: false,
});

/** 轮内可见待办的内存替身：与真实 StateManager 同语义（决策行按路径 upsert、
 *  对账按路径替换并退休已解决路径），使「用户可见行」可被端到端断言。 */
function makeVisibleRowStore() {
  const conflicts: SyncPlanItem[] = [];
  const deletes: SyncPlanItem[] = [];
  const issues: PendingIssue[] = [];
  const upsertByPath = (
    store: SyncPlanItem[],
    incoming: SyncPlanItem[],
  ): SyncPlanItem[] => {
    const byPath = new Map(store.map((item) => [item.path, item]));
    for (const item of incoming) byPath.set(item.path, item);
    return [...byPath.values()];
  };
  const replace = (store: SyncPlanItem[], next: SyncPlanItem[]) => {
    store.splice(0, store.length, ...next);
  };
  const hooks = {
    upsertPendingConflicts: vi.fn(async (items: SyncPlanItem[]) => {
      replace(conflicts, upsertByPath(conflicts, items));
    }),
    prunePendingConflicts: vi.fn(async (activePaths: Iterable<string>) => {
      const active = new Set(activePaths);
      replace(conflicts, conflicts.filter((item) => active.has(item.path)));
    }),
    upsertPendingDeletes: vi.fn(async (items: SyncPlanItem[]) => {
      replace(deletes, upsertByPath(deletes, items));
    }),
    prunePendingDeletes: vi.fn(async (activePaths: Iterable<string>) => {
      const active = new Set(activePaths);
      replace(deletes, deletes.filter((item) => active.has(item.path)));
    }),
    reconcilePendingIssues: vi.fn(async (
      incoming: PendingIssue[],
      resolvedPaths: Iterable<string>,
    ) => {
      const resolved = new Set(resolvedPaths);
      const byPath = new Map(issues.map((issue) => [issue.path, { ...issue }]));
      for (const path of resolved) byPath.delete(path);
      for (const issue of incoming) byPath.set(issue.path, { ...issue });
      issues.splice(0, issues.length, ...[...byPath.values()]);
    }),
    prunePendingIssues: vi.fn(async (
      activePaths: Iterable<string>,
      options: { onlyIssueCodes?: ReadonlySet<string> } = {},
    ) => {
      const active = new Set(activePaths);
      const restrict = options.onlyIssueCodes;
      issues.splice(
        0,
        issues.length,
        ...issues.filter((issue) =>
          active.has(issue.path)
          || (restrict ? !restrict.has(issue.issueCode ?? "") : false)),
      );
    }),
  };
  return { conflicts, deletes, issues, hooks };
}

/** 一轮：轮首账本里有一条结构性落不进的文件夹创建记录（被隔离 ⇒ 其余路径照常
 *  规划与同步），计划另外产出 1 条冲突行、1 条删除确认行和 1 个上传。
 *  `refuseInRoundCommits`（默认）⇒ 本轮新落下的变更同样提交不进共同状态
 *  （F29 野外「账本又添一条未结清记录」的第二重）；关掉它则两处写点都会运行，
 *  用来核对两处产出的行逐字段同形。 */
async function makeRound(options: { refuseInRoundCommits?: boolean } = {}) {
  const refuseInRound = options.refuseInRoundCommits !== false;
  const localBytes = new TextEncoder().encode("local edit").buffer;
  const goneBytes = new TextEncoder().encode("kept local").buffer;
  const otherBytes = new TextEncoder().encode("other").buffer;
  const contents = new Map<string, ArrayBuffer>([
    ["conflict.md", localBytes],
    ["gone.md", goneBytes],
    ["other.md", otherBytes],
  ]);
  const scanned = [
    await localFile("conflict.md", localBytes),
    await localFile("gone.md", goneBytes),
    await localFile("other.md", otherBytes),
  ];
  const record = makeStuckFolderCreateRecord();
  const rows = makeVisibleRowStore();
  const goneHash = await sha256Hex(goneBytes);
  const state = makeActiveV2State(
    [
      {
        path: "conflict.md",
        driveId: "drive-conflict",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: 20,
        mtime: 2,
        eTag: "etag-remote-2",
        cTag: "ctag-remote-2",
        sha256Hash: "c".repeat(64),
      } satisfies RemoteFileEntry,
    ],
    [
      // 本机未改、云端已删 ⇒ 删除确认行（`ConfirmLocalDelete`）。
      {
        path: "gone.md",
        hash: goneHash,
        size: goneBytes.byteLength,
        eTag: "etag-gone-1",
      } satisfies BaseFileEntry,
      // 两端都改过 ⇒ 冲突行（`Conflict`）。
      {
        path: "conflict.md",
        hash: "a".repeat(64),
        size: 10,
        eTag: "etag-base-1",
      } satisfies BaseFileEntry,
    ],
    {
      mutationLedger: [record],
      ...rows.hooks,
    },
  );
  const baseCommit = state.commitMutationCheckpoint;
  state.commitMutationCheckpoint = vi.fn(async (operationId: string) => {
    if (operationId === record.intent.operationId) {
      throw new Error(
        "V2 folder upsert would replace another identity: NewDir",
      );
    }
    if (refuseInRound && operationId.includes("-upload")) {
      throw new Error(
        "V2 upload checkpoint cannot be absorbed by the committed state",
      );
    }
    return baseCommit(operationId);
  }) as never;
  const baseCommitMany = state.commitMutationCheckpoints;
  state.commitMutationCheckpoints = vi.fn(async (operationIds: string[]) => {
    if (
      refuseInRound
      && operationIds.some((id) => id !== record.intent.operationId)
    ) {
      throw new Error(
        "V2 upload checkpoint cannot be absorbed by the committed state",
      );
    }
    return typeof baseCommitMany === "function"
      ? baseCommitMany(operationIds)
      : undefined;
  }) as never;
  const uploadFile = vi.fn().mockImplementation(async (
    _vaultName: string,
    path: string,
  ) => ({
    id: `uploaded-${path}`,
    eTag: "uploaded-etag",
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
  }));
  const executor = new SyncExecutor(
    makeMockOneDrive({
      uploadFile,
      getDriveItemMetadata: vi.fn().mockResolvedValue(null),
      getDelta: vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-visible-rows",
      }),
    }),
    {
      vault: {
        adapter: makeMockAdapter({
          readBinary: vi.fn().mockImplementation(async (path: string) =>
            contents.get(path)),
        }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: scanned,
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn().mockImplementation(async (path: string) => {
        const bytes = contents.get(path);
        return bytes
          ? { status: "present", entry: await localFile(path, bytes) }
          : { status: "missing" };
      }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    state,
    "testVault",
  );
  const seams = executor as unknown as {
    verifyMutationReceipt: unknown;
    tryAutoSettleFolderMutationRecovery: unknown;
    activeSyncScope: SyncScope;
  };
  seams.verifyMutationReceipt = vi.fn().mockResolvedValue(true);
  // 零写入结案不可用 ⇒ 记录只能被隔离（第二刀的结案通道不在本形状里）。
  seams.tryAutoSettleFolderMutationRecovery = vi.fn().mockResolvedValue(false);
  seams.activeSyncScope = ACTIVE_SCOPE;
  const logs: Array<{ level: string; message: string; payload: unknown }> = [];
  (executor as unknown as { diag: unknown }).diag = {
    log: (_s: string, message: string, payload?: unknown) => {
      logs.push({ level: "log", message, payload });
    },
    warn: (_s: string, message: string, payload?: unknown) => {
      logs.push({ level: "warn", message, payload });
    },
    error: (_s: string, message: string, payload?: unknown) => {
      logs.push({ level: "error", message, payload });
    },
    isEnabled: () => false,
  };
  return { executor, state, rows, uploadFile, logs };
}

const runRound = async (options: { refuseInRoundCommits?: boolean } = {}) => {
  const built = await makeRound(options);
  const result: SyncResult = await built.executor.run("manual", {});
  return { ...built, result };
};

// ---- 调用面控制项（与真实轮分开一份轻夹具，钉住本通道的边界）-------------

const makeCallLevelExecutor = (
  existing: {
    conflicts?: SyncPlanItem[];
    deletes?: SyncPlanItem[];
  } = {},
) => {
  const conflicts: SyncPlanItem[] = [];
  const deletes: SyncPlanItem[] = [];
  const hooks = {
    upsertPendingConflicts: vi.fn(async (items: SyncPlanItem[]) => {
      conflicts.push(...items);
    }),
    prunePendingConflicts: vi.fn(async () => undefined),
    upsertPendingDeletes: vi.fn(async (items: SyncPlanItem[]) => {
      deletes.push(...items);
    }),
    prunePendingDeletes: vi.fn(async () => undefined),
    reconcilePendingIssues: vi.fn(async () => undefined),
    prunePendingIssues: vi.fn(async () => undefined),
  };
  const executor = new SyncExecutor(
    makeMockOneDrive({}),
    emptyScanner(),
    {
      pendingConflicts: existing.conflicts ?? [],
      pendingRemoteDeletes: existing.deletes ?? [],
      pendingIssues: [],
      remoteScope: ACTIVE_SCOPE,
      boundAccountId: ACTIVE_SCOPE.accountId,
      getBaseEntry: () => undefined,
      ...hooks,
    } as never,
    "testVault",
  );
  return { executor, conflicts, deletes, hooks };
};

const pruneStep = (
  executor: SyncExecutor,
  items: SyncPlanItem[],
): Promise<{ terminated: SyncResult } | { terminated: null }> =>
  (executor as unknown as {
    runStep7_6PrunePendingDecisions(args: {
      result: SyncResult;
      operationEpoch: number;
      plan: SyncPlan;
      protectedMutationRecoveryRecords: readonly unknown[];
    }): Promise<{ terminated: SyncResult } | { terminated: null }>;
  }).runStep7_6PrunePendingDecisions({
    result: {
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      skippedLarge: 0,
      skippedIgnored: 0,
      skippedInvalidName: 0,
      errors: 0,
      authExpired: false,
      message: "",
    } as SyncResult,
    operationEpoch: (executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture(),
    plan: {
      items,
      lastTotalFiles: items.length,
      confirmed: true,
      scope: ACTIVE_SCOPE,
    },
    protectedMutationRecoveryRecords: [],
  });

const conflictItem: SyncPlanItem = {
  type: SyncActionType.Conflict,
  path: "conflict.md",
  local: {
    path: "conflict.md",
    hash: "a".repeat(64),
    size: 10,
    mtime: 1,
    binary: false,
  },
  remote: {
    path: "conflict.md",
    driveId: "drive-conflict",
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: 20,
    mtime: 2,
    eTag: "etag-remote-2",
  },
  reason: "reason.bothSidesModified",
} as unknown as SyncPlanItem;

const confirmDeleteItem: SyncPlanItem = {
  type: SyncActionType.ConfirmLocalDelete,
  path: "gone.md",
  local: {
    path: "gone.md",
    hash: "b".repeat(64),
    size: 10,
    mtime: 1,
    binary: false,
  },
  reason: "reason.fileDeletedFromRemote",
} as unknown as SyncPlanItem;

const transientItem: SyncPlanItem = {
  type: SyncActionType.RetryLater,
  path: "note.md",
  reason: "reason.circuitBreaker.network",
} as unknown as SyncPlanItem;

const uploadItem: SyncPlanItem = {
  type: SyncActionType.Upload,
  path: "other.md",
} as unknown as SyncPlanItem;

describe("planner-derived decision rows land with the plan", () => {
  // ---- 主钉子（先红后绿）------------------------------------------------
  //
  // 账本里还剩一条未结清记录（轮首那条被隔离的记录），本轮新落下的变更也提交
  // 不进共同状态 ⇒ 本轮 fail-closed 结束、共同状态不发布。先红凭据＝旧行为下
  // 冲突行与删除确认行两族都是零行（行只在 executePlan 末尾落库一次，本轮根本
  // 走不到那里）；修好后两族行都在。
  it("shows the plan's conflict and delete rows even though the round cannot publish the shared checkpoint", async () => {
    const { result, state, rows } = await runRound();

    // 闸门语义与轮级失败语义未放宽：共同状态没有发布，本轮响亮失败，账本里仍留
    // 着未结清记录（轮首那条 ＋ 本轮新落下的那条）。
    expect(result.success).toBe(false);
    expect(result.errors).toBeGreaterThan(0);
    const ledgerIds = state.mutationLedger
      .map((entry) => entry.intent.operationId);
    expect(ledgerIds).toContain("op-stuck");
    expect(ledgerIds.length).toBeGreaterThan(1);
    // …而计划交付给用户的行必须可达（本刀的目的）。
    expect(rows.conflicts.map((item) => item.path)).toEqual(["conflict.md"]);
    expect(rows.deletes.map((item) => item.path)).toEqual(["gone.md"]);
  });

  it("delivers the same rows the end-of-round upsert owns (no drift between the two writers)", async () => {
    // 共同状态可以吸收本轮变更时两处写点都会运行：先落地的行与轮末写出的行必须
    // 逐字段同形（同一「计划项 → 行」映射，token 由同一计划项确定性派生）。
    const { result, rows } = await runRound({ refuseInRoundCommits: false });

    // 本轮没有结构性落不进：共同状态照常发布（未结清的仍是轮首那条隔离记录）。
    expect(result.errors).toBe(0);
    const conflictWrites = rows.hooks.upsertPendingConflicts.mock.calls
      .map((call) => call[0] as SyncPlanItem[]);
    const deleteWrites = rows.hooks.upsertPendingDeletes.mock.calls
      .map((call) => call[0] as SyncPlanItem[]);
    expect(conflictWrites.length).toBeGreaterThanOrEqual(2);
    expect(deleteWrites.length).toBeGreaterThanOrEqual(2);
    for (const write of conflictWrites) {
      expect(write).toEqual(conflictWrites[0]);
    }
    for (const write of deleteWrites) {
      expect(write).toEqual(deleteWrites[0]);
    }
    expect(rows.conflicts.map((item) => item.path)).toEqual(["conflict.md"]);
    expect(rows.deletes.map((item) => item.path)).toEqual(["gone.md"]);
  });

  it("retires stale decision rows first and then lands this plan's rows", async () => {
    const { executor, hooks, conflicts, deletes } = makeCallLevelExecutor();

    const step = await pruneStep(
      executor,
      [conflictItem, confirmDeleteItem, transientItem, uploadItem],
    );

    expect(step.terminated).toBeNull();
    // 退场先发生，随后落地（同一对路径的两个方向，陈旧行不会比计划活得久）。
    expect(hooks.prunePendingConflicts.mock.invocationCallOrder[0])
      .toBeLessThan(
        hooks.upsertPendingConflicts.mock.invocationCallOrder[0],
      );
    expect(hooks.prunePendingDeletes.mock.invocationCallOrder[0])
      .toBeLessThan(
        hooks.upsertPendingDeletes.mock.invocationCallOrder[0],
      );
    // 决策行两族各自落地，且只落本计划派生的行。
    expect(conflicts.map((item) => item.path)).toEqual(["conflict.md"]);
    expect(deletes.map((item) => item.path)).toEqual(["gone.md"]);
    expect(conflicts[0].decisionToken).toBeTruthy();
    expect(deletes[0].decisionToken).toBeTruthy();
    // 执行期瞬态不被这一步认领（仍归轮末对账／落库），对账通道本步不写。
    expect(hooks.upsertPendingConflicts.mock.calls
      .flatMap((call) => call[0] as SyncPlanItem[])
      .map((item) => item.path)).not.toContain("note.md");
    expect(hooks.reconcilePendingIssues).not.toHaveBeenCalled();
  });

  it("writes nothing when the plan produces no decision row", async () => {
    const { executor, hooks } = makeCallLevelExecutor();

    const step = await pruneStep(executor, [uploadItem]);

    expect(step.terminated).toBeNull();
    expect(hooks.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(hooks.upsertPendingDeletes).not.toHaveBeenCalled();
    expect(hooks.reconcilePendingIssues).not.toHaveBeenCalled();
  });

  it("never rewrites an existing decision row (the row carries other owners' state)", async () => {
    // 已存在的行不是纯计划派生状态：自动合并走 `state.pendingConflicts` 读回行上
    // 缓存的 `textMergeEvidence`（sync-executor 20794 起）——规划步若按路径覆写
    // 它，这条缓存就会被抹掉、下一轮重算（并多一次内容下载）。因此本通道只补缺
    // 口：计划里有、状态里还没有的行才落地；已存在的行交给轮末 owner 刷新。
    const existingConflict = {
      ...conflictItem,
      textMergeEvidence: { version: 1, marker: "kept" },
    } as unknown as SyncPlanItem;
    const existingDelete = { ...confirmDeleteItem } as SyncPlanItem;
    const { executor, hooks, conflicts, deletes } = makeCallLevelExecutor({
      conflicts: [existingConflict],
      deletes: [existingDelete],
    });

    const step = await pruneStep(
      executor,
      [conflictItem, confirmDeleteItem, uploadItem],
    );

    expect(step.terminated).toBeNull();
    expect(hooks.upsertPendingConflicts).not.toHaveBeenCalled();
    expect(hooks.upsertPendingDeletes).not.toHaveBeenCalled();
    expect(conflicts).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it("lands only the rows the state is still missing", async () => {
    const existingConflict = { ...conflictItem } as SyncPlanItem;
    const { executor, conflicts, deletes } = makeCallLevelExecutor({
      conflicts: [existingConflict],
    });

    const step = await pruneStep(
      executor,
      [conflictItem, confirmDeleteItem, uploadItem],
    );

    expect(step.terminated).toBeNull();
    expect(conflicts).toEqual([]);
    expect(deletes.map((item) => item.path)).toEqual(["gone.md"]);
  });
});
