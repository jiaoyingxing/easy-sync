// S4 终止判据接线——逐项事实指纹＋「这一项是不是空转」＋一次明确结局。
//
// 合同：docs/2026-10-16 §五 D3／§六 S4 行（三类终点：自动完成／用户一次裁决／
//   明确不可重试诊断；同一事实指纹连续两轮相同且无明确外部依赖 ⇒ 离开「暂时」
//   态，禁止继续展示不会改变结论的重试入口；只展示一次）＋归档口径
//   docs/archive/2026-08/20260814-1155（分类合同五类、重检资格、事实指纹绑定面）。
// 边界（硬）：只改「判定与呈现」；零自动数据动作、零放宽安全门、零新增持久
//   schema（判定态在内存）；逐项指纹复用 S1 的规范化与哈希（同一「事实变化」定义）。
// 先红后绿：主钉子在终止判据或逐项粒度被拿掉时变红（反向变异见文件末）。

import { describe, expect, it, vi } from "vitest";
import { functionBody, readSourceFile } from "./helpers/source-scope";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import { sha256Hex } from "../src/crypto";
import type { LocalScanner } from "../src/sync/local-scanner";
import type {
  LocalFileEntry,
  MutationLedgerEntryV1,
  PendingIssue,
  RemoteFileEntry,
  SyncScope,
} from "../src/sync/types";
import { SyncActionType } from "../src/sync/types";
import { I18n } from "../src/i18n";
import {
  SyncItemTerminationTracker,
  mutationRecoveryItemKey,
  pendingIssueExitKind,
  pendingIssueTerminationKey,
  resolveMutationRecoveryDisposition,
  resolvePendingIssueDisposition,
  syncItemTerminationSignature,
  type SyncBlockedItemRoundFact,
  type SyncItemTerminationRoundInput,
} from "../src/sync/sync-item-termination";
import type { SyncIdleObservationInput } from "../src/sync/sync-idle-observation";
import { mutationRecoveryBodyPresentation } from "../src/ui/mutation-recovery-presentation";
import { buildSyncPendingDisplayRows, buildSyncViewContentKey } from "../src/ui/sync-view";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
} from "./helpers/sync-safety-harness";

// ---- Shared fixtures -------------------------------------------------------

const ACTIVE_SCOPE: SyncScope = {
  ...TEST_SYNC_SCOPE,
  accountId: "account-id",
};

/** Minimal round input: the S1 observation surface with no blocked surface of
 *  its own; each test adds the items and rows it is about. */
function makeRoundInput(
  overrides: Partial<SyncIdleObservationInput> = {},
): SyncIdleObservationInput {
  return {
    scope: { ...TEST_SYNC_SCOPE },
    contentFactCommitSeq: 7,
    stateCommitSeq: 7,
    pendingConflicts: [],
    pendingRemoteDeletes: [],
    pendingIssues: [],
    planReview: { active: false, revision: 0, digest: null },
    mutationLedger: [],
    runFacts: {
      termination: "normal",
      ordinaryPlanning: "entered",
      userFileChanges: "none",
    },
    authExpired: false,
    success: true,
    disposition: null,
    mutationRecovery: null,
    counts: {
      uploaded: 0,
      downloaded: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      filesMoved: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
      identityBlockedErrors: null,
      breakerDeferredErrors: null,
      networkFailureErrors: null,
      skippedLarge: 0,
      skippedIgnored: 0,
      skippedInvalidName: 0,
    },
    ...overrides,
  };
}

const contentIssue = (
  overrides: Partial<PendingIssue> = {},
): PendingIssue => ({
  path: "stuck.m4a",
  actionType: SyncActionType.Download,
  reason: "syncView.failure.contentUnavailable",
  updatedAt: 1,
  fileSize: 3,
  localHash: "aa".repeat(32),
  remoteETag: "etag-stuck",
  consecutiveFailures: 3,
  ...overrides,
});

const networkIssue = (
  overrides: Partial<PendingIssue> = {},
): PendingIssue => contentIssue({
  reason: "reason.circuitBreaker.network",
  issueCode: "transfer-network",
  consecutiveFailures: 1,
  ...overrides,
});

const withItems = (
  base: SyncIdleObservationInput,
  items: SyncBlockedItemRoundFact[],
): SyncItemTerminationRoundInput => ({ ...base, items });

const item = (
  key: string,
  path: string,
  disposition: SyncBlockedItemRoundFact["disposition"],
): SyncBlockedItemRoundFact => ({ key, path, disposition });

const recordItem = (
  key: string,
  path: string,
  disposition: SyncBlockedItemRoundFact["disposition"],
): SyncBlockedItemRoundFact => item(key, path, disposition);

/** Recording diag double for the S4 announcement. */
function makeTerminationDiag() {
  const calls: Array<{ key: string; outcome: string; streak: number }> = [];
  const diag = (
    _message: "sync item termination concluded",
    data: { key: string; outcome: string; streak: number },
  ): void => {
    calls.push({ key: data.key, outcome: data.outcome, streak: data.streak });
  };
  return { diag, calls };
}

// ---- Disposition resolution (single judgement shared with the renderer) ----

describe("S4 blocked-item disposition resolution", () => {
  it("gives an exit-less pending row with stable facts the non-retryable ending", () => {
    expect(resolvePendingIssueDisposition({
      issueCode: undefined,
      actionType: SyncActionType.Download,
      reason: "syncView.failure.contentUnavailable",
      hasRenderableExit: false,
    })).toBe("non-retryable");
  });

  it("keeps network-class rows and breaker back-off rows retryable (reverse control)", () => {
    for (const issueCode of ["transfer-network", "transfer-remote-moving"] as const) {
      expect(resolvePendingIssueDisposition({
        issueCode,
        actionType: SyncActionType.Download,
        reason: "reason.x",
        hasRenderableExit: false,
      })).toBe("retryable-external");
    }
    expect(resolvePendingIssueDisposition({
      issueCode: undefined,
      actionType: SyncActionType.Download,
      reason: "reason.circuitBreaker",
      hasRenderableExit: false,
    })).toBe("retryable-external");
    expect(resolvePendingIssueDisposition({
      issueCode: undefined,
      actionType: SyncActionType.Download,
      reason: "reason.circuitBreaker.remoteMoving",
      hasRenderableExit: false,
    })).toBe("retryable-external");
  });

  it("treats by-design skip rows and exit-bearing rows as non-judged endings", () => {
    for (const actionType of [
      SyncActionType.SkipLargeFile,
      SyncActionType.SkipIgnoredPath,
      SyncActionType.SkipOneDriveInvalidName,
    ]) {
      expect(resolvePendingIssueDisposition({
        issueCode: undefined,
        actionType,
        reason: "reason.skip",
        hasRenderableExit: false,
      })).toBe("by-design-skip");
    }
    expect(resolvePendingIssueDisposition({
      issueCode: "target-occupied",
      actionType: SyncActionType.Upload,
      reason: "reason.targetOccupied",
      hasRenderableExit: true,
    })).toBe("user-decision");
  });

  it("keeps a scope-crossing row with a covering hint as a decision and without one as an external wait", () => {
    expect(resolvePendingIssueDisposition({
      issueCode: "scope-crossing",
      actionType: SyncActionType.MoveLocalFile,
      reason: "reason.scopeCrossing",
      hasRenderableExit: true,
    })).toBe("user-decision");
    expect(resolvePendingIssueDisposition({
      issueCode: "scope-crossing",
      actionType: SyncActionType.MoveLocalFile,
      reason: "reason.scopeCrossing",
      hasRenderableExit: false,
    })).toBe("retryable-external");
  });

  it("maps the renderer's own exit list (one judgement for verdict and chip)", () => {
    expect(pendingIssueExitKind("target-occupied", null)).toBe("stale-identity");
    for (const code of [
      "identity-replacement-ambiguous",
      "anchored-folder-missing-remote",
      "local-rename-evidence-conflict",
      "local-subtree-changed",
      "remote-subtree-changed",
      "parent-chain-incomplete",
    ] as const) {
      expect(pendingIssueExitKind(code, null)).toBe("stale-identity");
    }
    expect(pendingIssueExitKind("unanchored-shared-folder", null))
      .toBe("shared-folder-identity");
    expect(pendingIssueExitKind("anchored-folder-missing-local", null))
      .toBe("empty-folder-review");
    expect(pendingIssueExitKind("folder-location-choice", null))
      .toBe("folder-location");
    expect(pendingIssueExitKind("scope-crossing", "file")).toBe("scope-crossing");
    expect(pendingIssueExitKind("scope-crossing", null)).toBeNull();
    // Exit-less / network / skip codes render no chip today.
    expect(pendingIssueExitKind(undefined, null)).toBeNull();
    expect(pendingIssueExitKind("transfer-network", null)).toBeNull();
    expect(pendingIssueExitKind("transfer-remote-moving", null)).toBeNull();
  });

  it("resolves recovery records: round-level waits and scope/account keep their entries", () => {
    expect(resolveMutationRecoveryDisposition({
      roundExternalDependency: true,
      blockReason: "facts-changed",
      manualResolutionAvailable: false,
    })).toBe("retryable-external");
    for (const blockReason of ["scope-changed", "account-changed"] as const) {
      expect(resolveMutationRecoveryDisposition({
        roundExternalDependency: false,
        blockReason,
        manualResolutionAvailable: false,
      })).toBe("retryable-external");
    }
    expect(resolveMutationRecoveryDisposition({
      roundExternalDependency: false,
      blockReason: "facts-changed",
      manualResolutionAvailable: true,
    })).toBe("user-decision");
    expect(resolveMutationRecoveryDisposition({
      roundExternalDependency: false,
      blockReason: "facts-changed",
      manualResolutionAvailable: false,
    })).toBe("non-retryable");
    expect(resolveMutationRecoveryDisposition({
      roundExternalDependency: false,
      blockReason: "evidence-corrupt",
      manualResolutionAvailable: false,
    })).toBe("non-retryable");
  });

  it("keys an item to the very row the sidebar renders", () => {
    const issue = contentIssue();
    expect(pendingIssueTerminationKey(issue))
      .toBe("issue:download::stuck.m4a");
    expect(mutationRecoveryItemKey("op-1")).toBe("ledger:op-1");
    // The pending row key and the item key are the same string.
    expect(buildSyncPendingDisplayRows({
      adoptionRows: [],
      failures: [{ issue, nestedIssues: [] }],
      conflictEntries: [],
      pendingDeletes: [],
      skipped: [],
    })[0].key).toBe(pendingIssueTerminationKey(issue));
  });

  it("keeps the render signature stable and order-independent", () => {
    const a = { key: "issue:download::a", path: "a", outcome: "non-retryable" as const, streak: 2, fingerprint: "f1" };
    const b = { key: "ledger:op", path: "b", outcome: "user-decision" as const, streak: 2, fingerprint: "f2" };
    expect(syncItemTerminationSignature([a, b]))
      .toBe("issue:download::a=non-retryable,ledger:op=user-decision");
    expect(syncItemTerminationSignature([b, a]))
      .toBe(syncItemTerminationSignature([a, b]));
    expect(syncItemTerminationSignature([])).toBe("");
  });
});

// ---- Per-item fingerprints and the verdict ---------------------------------

describe("S4 per-item termination tracker", () => {
  it("concludes on the second identical round and reports it exactly once", () => {
    const tracker = new SyncItemTerminationTracker();
    const { diag, calls } = makeTerminationDiag();
    const issue = contentIssue();
    const round = () => withItems(
      makeRoundInput({ pendingIssues: [issue] }),
      [item(pendingIssueTerminationKey(issue), issue.path, "non-retryable")],
    );

    expect(tracker.observe(round(), diag)).toEqual([]);
    expect(tracker.snapshot()).toEqual([]);

    const concluded = tracker.observe(round(), diag);
    expect(concluded).toHaveLength(1);
    expect(concluded[0]).toMatchObject({
      key: "issue:download::stuck.m4a",
      path: "stuck.m4a",
      outcome: "non-retryable",
      streak: 2,
    });

    // Third and fourth identical rounds: the same single ending, no new
    // statement (D3: 结局只展示一次，不每轮一个新说法).
    const third = tracker.observe(round(), diag);
    tracker.observe(round(), diag);
    expect(third).toEqual([]);
    expect(tracker.snapshot()).toHaveLength(1);
    expect(tracker.snapshot()[0].streak).toBe(2);
    expect(tracker.get("issue:download::stuck.m4a")?.outcome)
      .toBe("non-retryable");
    expect(calls).toEqual([{
      key: "issue:download::stuck.m4a",
      outcome: "non-retryable",
      streak: 2,
    }]);
  });

  it("never concludes an item whose own bound facts changed (reverse control)", () => {
    const tracker = new SyncItemTerminationTracker();
    const first = contentIssue();
    const second = contentIssue({ remoteETag: "etag-changed" });
    const round = (issue: PendingIssue) => withItems(
      makeRoundInput({ pendingIssues: [issue] }),
      [item(pendingIssueTerminationKey(issue), issue.path, "non-retryable")],
    );
    tracker.observe(round(first));
    tracker.observe(round(second));
    tracker.observe(round(contentIssue({ remoteETag: "etag-changed-2" })));
    expect(tracker.snapshot()).toEqual([]);
  });

  it("does not read a rewritten wall-clock stamp or breaker counter as a fact change", () => {
    const tracker = new SyncItemTerminationTracker();
    const round = (updatedAt: number, consecutiveFailures: number) => {
      const issue = contentIssue({ updatedAt, consecutiveFailures });
      return withItems(
        makeRoundInput({ pendingIssues: [issue] }),
        [item(pendingIssueTerminationKey(issue), issue.path, "non-retryable")],
      );
    };
    tracker.observe(round(1, 3));
    const concluded = tracker.observe(round(99, 4));
    expect(concluded).toHaveLength(1);
  });

  it("concludes per item: the network row in the same round keeps its retry entry", () => {
    const tracker = new SyncItemTerminationTracker();
    const stable = contentIssue();
    const network = networkIssue({ path: "net.m4a" });
    const churning = networkIssue({ path: "hot.m4a", remoteETag: "etag-1" });
    const items = [
      item(pendingIssueTerminationKey(stable), stable.path, "non-retryable"),
      item(pendingIssueTerminationKey(network), network.path, "retryable-external"),
      item(pendingIssueTerminationKey(churning), churning.path, "retryable-external"),
    ];
    const round = (hotEtag: string) => withItems(
      makeRoundInput({
        pendingIssues: [
          stable,
          network,
          { ...churning, remoteETag: hotEtag },
        ],
      }),
      items,
    );
    tracker.observe(round("etag-1"));
    // One sibling is a network wait (no ending), one churns (hot file); the
    // stuck item's own facts hold, so it and only it concludes: per-item
    // granularity is what makes both halves true in the same round.
    const concluded = tracker.observe(round("etag-2"));
    expect(concluded.map((verdict) => verdict.key))
      .toEqual([pendingIssueTerminationKey(stable)]);
    expect(tracker.get(pendingIssueTerminationKey(network))).toBeNull();
    expect(tracker.get(pendingIssueTerminationKey(churning))).toBeNull();
    expect(tracker.observe(round("etag-3"))).toEqual([]);
    expect(tracker.snapshot().map((verdict) => verdict.key))
      .toEqual([pendingIssueTerminationKey(stable)]);
  });

  it("concludes an item with a live exit as one user decision, not as a diagnosis", () => {
    const tracker = new SyncItemTerminationTracker();
    const issue = contentIssue({
      issueCode: "target-occupied",
      reason: "reason.targetOccupied",
    });
    const round = () => withItems(
      makeRoundInput({ pendingIssues: [issue] }),
      [item(pendingIssueTerminationKey(issue), issue.path, "user-decision")],
    );
    tracker.observe(round());
    const concluded = tracker.observe(round());
    expect(concluded).toHaveLength(1);
    expect(concluded[0].outcome).toBe("user-decision");
  });

  it("clears a verdict when the item's facts move and never re-reports without two fresh rounds", () => {
    const tracker = new SyncItemTerminationTracker();
    const round = (issue: PendingIssue) => withItems(
      makeRoundInput({ pendingIssues: [issue] }),
      [item(pendingIssueTerminationKey(issue), issue.path, "non-retryable")],
    );
    tracker.observe(round(contentIssue()));
    tracker.observe(round(contentIssue()));
    expect(tracker.snapshot()).toHaveLength(1);

    const moved = contentIssue({ remoteETag: "etag-new" });
    tracker.observe(round(moved));
    expect(tracker.snapshot()).toEqual([]);
    tracker.observe(round(moved));
    expect(tracker.snapshot()).toHaveLength(1);
  });

  it("drops a verdict once the item is gone from the round", () => {
    const tracker = new SyncItemTerminationTracker();
    const issue = contentIssue();
    const round = () => withItems(
      makeRoundInput({ pendingIssues: [issue] }),
      [item(pendingIssueTerminationKey(issue), issue.path, "non-retryable")],
    );
    tracker.observe(round());
    tracker.observe(round());
    tracker.observe(withItems(makeRoundInput(), []));
    expect(tracker.snapshot()).toEqual([]);
  });

  it("binds the scope and the committed baseline into the per-item fingerprint", () => {
    const tracker = new SyncItemTerminationTracker();
    const issue = contentIssue();
    const round = (overrides: Partial<SyncIdleObservationInput>) => withItems(
      makeRoundInput({ pendingIssues: [issue], ...overrides }),
      [item(pendingIssueTerminationKey(issue), issue.path, "non-retryable")],
    );
    tracker.observe(round({}));
    // A different scope or a moved content-fact baseline is new evidence.
    tracker.observe(round({ contentFactCommitSeq: 8 }));
    expect(tracker.snapshot()).toEqual([]);
    tracker.observe(round({ scope: { ...TEST_SYNC_SCOPE, driveId: "other" } }));
    expect(tracker.snapshot()).toEqual([]);
  });

  it("does not reset the streak when only the raw commit sequence advances", () => {
    const tracker = new SyncItemTerminationTracker();
    const issue = contentIssue({
      issueCode: "target-occupied",
      reason: "reason.targetOccupied",
    });
    const round = (overrides: Partial<SyncIdleObservationInput> = {}) =>
      withItems(
        makeRoundInput({ pendingIssues: [issue], ...overrides }),
        [item(pendingIssueTerminationKey(issue), issue.path, "user-decision")],
      );
    tracker.observe(round());
    const concluded = tracker.observe(round({ stateCommitSeq: 8 }));
    expect(concluded).toHaveLength(1);
    expect(concluded[0].outcome).toBe("user-decision");
  });

  it("concludes a recovery record only when the round itself did not declare an external wait", () => {
    const tracker = new SyncItemTerminationTracker();
    const record = {
      intent: {
        version: 1,
        operationId: "op-stuck",
        planRevision: 1,
        scope: ACTIVE_SCOPE,
        action: "upload",
        path: "stuck.md",
        expectedLocal: { exists: true, hash: "aa".repeat(32), size: 3 },
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: null,
    } as unknown as MutationLedgerEntryV1;
    const round = (
      disposition: SyncBlockedItemRoundFact["disposition"],
      recovery: SyncIdleObservationInput["mutationRecovery"],
    ) => withItems(
      makeRoundInput({ mutationLedger: [record], mutationRecovery: recovery }),
      [recordItem(mutationRecoveryItemKey("op-stuck"), "stuck.md", disposition)],
    );
    const blocked = {
      state: "blocked",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: null,
      blockReason: "facts-changed",
      blockedOperationId: "op-stuck",
    } as const;
    tracker.observe(round("non-retryable", blocked));
    expect(tracker.observe(round("non-retryable", blocked))).toHaveLength(1);

    // A network-unavailable round: same record, but the round declared an
    // external wait, so nothing is concluded.
    const waiting = { ...blocked, state: "network-unavailable" } as const;
    tracker.observe(round("retryable-external", waiting));
    expect(tracker.snapshot()).toEqual([]);
  });
});

// ---- Executor wiring: the D3 counterexample --------------------------------

const makeFolderMoveRecord = (): MutationLedgerEntryV1 => ({
  intent: {
    version: 2,
    operationId: "op-folder-move",
    planRevision: 1,
    scope: ACTIVE_SCOPE,
    action: "moveRemoteFolder",
    path: "Archive/F",
    sourcePath: "Videos/F",
    folderId: "folder-f",
    expectedLocal: { exists: true },
    expectedRemote: {
      exists: true,
      driveId: "folder-f",
      parentId: "videos",
      eTag: "etag-f",
    },
    expectedParent: {
      driveId: "archive",
      path: "Archive",
      eTag: "etag-archive",
    },
    createdAt: 1,
  } as MutationLedgerEntryV1["intent"],
  receipt: {
    version: 1,
    operationId: "op-folder-move",
    completedAt: 2,
    checkpoint: {
      baseUpserts: [],
      baseRemovals: [],
      remoteUpserts: [],
      remoteDeletes: [],
      pendingConflictRemovals: [],
      pendingDeleteRemovals: [],
      folderUpserts: [{
        path: "Archive/F",
        driveId: "folder-f",
        parentId: "archive",
        name: "F",
        eTag: "etag-f",
      }],
      folderMoveHintRemovals: ["folder-f", "folder-child"],
    },
  },
});

const localFile = (
  path: string,
  bytes: ArrayBuffer,
  hash: string,
): LocalFileEntry => ({
  path,
  hash,
  size: bytes.byteLength,
  mtime: 1,
  binary: false,
});

const scannedFile = async (
  path: string,
  bytes: ArrayBuffer,
): Promise<LocalFileEntry> => localFile(path, bytes, await sha256Hex(bytes));

const FOLDER_EXPECTED_ANCHORS = [
  {
    remoteId: "folder-f",
    lastPath: "Videos/F",
    parentId: "videos",
    eTag: "etag-f",
  },
  {
    remoteId: "folder-child",
    lastPath: "Videos/F/Child",
    parentId: "folder-f",
    eTag: "etag-child",
  },
];

type RecordedDiagCall = [string, string, unknown];

/** The F29 shape: a folder move that reached the world but whose receipted
 *  commit the committed state refuses. Facts are stable and no safe
 *  disposition exists (folder records have no review exit; the zero-write
 *  settlement is unavailable), so the round repeats identically. */
async function makeStuckFolderRecordFixture() {
  const insideBytes = new TextEncoder().encode("inside subtree").buffer;
  const unrelatedBytes = new TextEncoder().encode("unrelated note").buffer;
  const record = makeFolderMoveRecord();
  const state = makeActiveV2State([], [], {
    mutationLedger: [record],
    folderAnchors: FOLDER_EXPECTED_ANCHORS,
  });
  const baseCommit = state.commitMutationCheckpoint;
  state.commitMutationCheckpoint = vi.fn(async (operationId: string) => {
    if (operationId === record.intent.operationId) {
      throw new Error(
        `V2 folder move file projection changed: ${record.intent.path}`,
      );
    }
    return baseCommit(operationId);
  }) as never;
  const uploadFile = vi.fn().mockImplementation(async (
    _vaultName: string,
    path: string,
  ) => ({
    id: `uploaded-${path}`,
    eTag: "uploaded-etag",
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
  }));
  const calls: RecordedDiagCall[] = [];
  const executor = new SyncExecutor(
    makeMockOneDrive({
      uploadFile,
      beginRunMetrics: vi.fn(),
      finishRunMetrics: vi.fn().mockReturnValue(null),
      getDriveItemMetadata: vi.fn().mockResolvedValue(null),
      getDelta: vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-s4",
      }),
    }),
    {
      vault: {
        adapter: makeMockAdapter({
          readBinary: vi.fn().mockImplementation(async (path: string) =>
            path === "Videos/F/x.md" ? insideBytes : unrelatedBytes),
        }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: [
          await scannedFile("Videos/F/x.md", insideBytes),
          await scannedFile("other.md", unrelatedBytes),
        ],
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn().mockImplementation(async (path: string) =>
        path === "Videos/F/x.md"
          ? { status: "present", entry: await scannedFile(path, insideBytes) }
          : { status: "present", entry: await scannedFile(path, unrelatedBytes) }),
      shouldSyncFolderPath: vi.fn().mockReturnValue(true),
    } as unknown as LocalScanner,
    state,
    "testVault",
    new I18n("zh-cn"),
    undefined,
    {
      log: (_category: string, message: string, data?: unknown) => {
        calls.push([_category, message, data]);
      },
      warn: (_category: string, message: string, data?: unknown) => {
        calls.push([_category, message, data]);
      },
      error: () => undefined,
      isEnabled: () => true,
    } as never,
  );
  const seams = executor as unknown as {
    verifyMutationReceipt: unknown;
    tryAutoSettleFolderMutationRecovery: unknown;
    activeSyncScope: SyncScope;
  };
  seams.verifyMutationReceipt = vi.fn().mockResolvedValue(true);
  seams.tryAutoSettleFolderMutationRecovery = vi.fn().mockResolvedValue(false);
  seams.activeSyncScope = ACTIVE_SCOPE;
  return { executor, state, calls, uploadFile, record };
}

describe("S4 termination criterion (executor wiring)", () => {
  it("replaces the temporary state with one non-retryable diagnosis after two identical rounds", async () => {
    const { executor, state, calls } = await makeStuckFolderRecordFixture();
    const t = (key: string): string => key;
    const displayState = {
      kind: "blocked" as const,
      total: 1,
      settled: 0,
      remaining: 1,
      retryAt: null,
      firstPath: "Archive/F",
      blockReason: "facts-changed" as const,
      blockedOperationId: "op-folder-move",
      paused: false,
    };
    const verdictKeys = () =>
      executor.getSyncItemTerminationSnapshot()
        .filter((verdict) => verdict.outcome === "non-retryable")
        .map((verdict) => verdict.key);
    const presentationFor = () => mutationRecoveryBodyPresentation(
      displayState,
      t,
      () => "",
      {
        nonRetryable: verdictKeys()
          .includes(mutationRecoveryItemKey("op-folder-move")),
      },
    );

    // Round 1: the record is blocked exactly as the field case reports it, and
    // the panel still shows the temporary line (no verdict yet).
    const first: SyncResult = await executor.run("manual", {});
    expect(first.mutationRecovery).toMatchObject({
      state: "blocked",
      isolated: true,
      blockedOperationId: "op-folder-move",
      blockReason: "facts-changed",
    });
    expect(verdictKeys()).toEqual([]);
    expect(presentationFor().nextStep)
      .toBe("syncView.recovery.nextStep.blocked");

    // Round 2: the first round's remote-state commit is itself a content-fact
    // change (the fixture starts with an empty remote index), so the baseline
    // settles here before two identical observations can accumulate.
    await executor.run("manual", {});
    expect(verdictKeys()).toEqual([]);

    // Round 3: identical facts ⇒ the single ending, not a third re-check.
    const second: SyncResult = await executor.run("manual", {});
    expect(second.mutationRecovery).toMatchObject({
      state: "blocked",
      isolated: true,
    });
    expect(verdictKeys()).toEqual(["ledger:op-folder-move"]);
    const verdict = executor.getSyncItemTerminationSnapshot()[0];
    expect(verdict).toMatchObject({
      key: "ledger:op-folder-move",
      path: "Archive/F",
      outcome: "non-retryable",
      streak: 2,
    });
    // The recovery section's temporary line is replaced by the one terminal
    // diagnosis line (and the reset pointer survives nowhere in that line).
    expect(presentationFor().nextStep)
      .toBe("syncView.itemTermination.nonRetryable");
    expect(presentationFor().nextStep)
      .not.toContain("syncView.recovery.nextStep.blocked");

    // Round 4: the ending is stable and stated once — no new announcement.
    await executor.run("manual", {});
    const announcements = calls.filter((call) =>
      call[1] === "sync item termination concluded");
    expect(announcements).toHaveLength(1);
    expect(announcements[0][2]).toEqual({
      schemaVersion: 1,
      key: "ledger:op-folder-move",
      path: "Archive/F",
      outcome: "non-retryable",
      streak: 2,
      fingerprint: verdict.fingerprint,
    });
    expect(executor.getSyncItemTerminationSnapshot()).toHaveLength(1);
    // The verdict changed no state: the record, its receipt and the ledger
    // length are exactly what the fixture built.
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt?.completedAt).toBe(2);
  });

  it("zero coupling: a round with a concluded verdict keeps every round dimension of an unobserved twin", async () => {
    const observed = await makeStuckFolderRecordFixture();
    const twin = await makeStuckFolderRecordFixture();
    for (let round = 0; round < 3; round++) {
      await observed.executor.run("manual", {});
      await twin.executor.run("manual", {});
    }
    const conclusions = observed.executor.getSyncItemTerminationSnapshot();
    expect(conclusions).toHaveLength(1);
    // The twin ran the same three rounds with no observation consumer at all:
    // its ledger surface and uploads are identical (the verdict only read).
    expect(twin.state.mutationLedger).toHaveLength(observed.state.mutationLedger.length);
    expect(twin.uploadFile.mock.calls.length)
      .toBe(observed.uploadFile.mock.calls.length);
  });

  it("keeps a network-class deferral row retryable across identical rounds (reverse control)", async () => {
    const remote: RemoteFileEntry = {
      path: "stuck.m4a",
      driveId: "item-stuck",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-stuck",
      cTag: "ctag-stuck",
    };
    const issue = networkIssue();
    const state = makeActiveV2State([remote], [], {
      pendingIssues: [{ ...issue }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        beginRunMetrics: vi.fn(),
        finishRunMetrics: vi.fn().mockReturnValue(null),
      }),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries: [],
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        getMaxFileSize: vi.fn().mockReturnValue(500 * 1024 * 1024),
      } as never,
      state as never,
      "testVault",
      new I18n("zh-cn"),
      undefined,
      {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        isEnabled: () => true,
      } as never,
    );
    for (let round = 0; round < 3; round++) {
      await executor.run("auto", {});
    }
    expect(executor.getSyncItemTerminationSnapshot()).toEqual([]);
    // The retry entry is untouched: the row is still a network wait.
    expect(state.pendingIssues[0].issueCode).toBe("transfer-network");
  });

  it("puts the verdict into the sidebar rebuild key so the line is never skipped", () => {
    const base = {
      isLoggedIn: true,
      isInitializing: false,
      isPending: false,
      isRunning: false,
      canCancel: false,
      syncEntryInProgress: false,
      bodyMode: "recovery" as const,
      progress: {
        phase: "idle",
        total: 0,
        completed: 0,
        currentFile: null,
        completedFiles: [],
        activityKind: "idle",
        startedAt: 0,
      },
      planReviewActive: false,
      planReviewDetailsState: "ready" as const,
      pendingIssues: [],
      conflicts: [],
      pendingDeletes: [],
      adoptionRows: [],
      planReviewCounts: null,
      planReviewRevision: 0,
      history: [],
      lastSyncTime: 0,
      mutationRecovery: null,
    };
    const without = buildSyncViewContentKey(false, { ...base } as never);
    const withVerdict = buildSyncViewContentKey(false, {
      ...base,
      itemTerminationKey: "ledger:op-folder-move=non-retryable",
    } as never);
    expect(withVerdict).not.toBe(without);
  });

  it("pins the two surfaces that render the terminal line", () => {
    const view = readSourceFile("src/ui/sync-view.ts");
    const row = functionBody(view, "  private renderPendingIssue(");
    expect(row).toContain("pendingIssueTerminationKey(issue)");
    expect(row).toContain('t("syncView.itemTermination.nonRetryable")');
    const section = functionBody(view, "  private renderMutationRecoverySection(");
    expect(section).toContain("mutationRecoveryItemKey(state.blockedOperationId)");
    expect(section).toContain("nonRetryable:");
    // Both surfaces read the same key and the same one judgement source.
    const presentation = readSourceFile("src/ui/mutation-recovery-presentation.ts");
    expect(functionBody(presentation, "export function mutationRecoveryBodyPresentation("))
      .toContain('"syncView.itemTermination.nonRetryable"');
  });

  it("uses the same exit list the renderer draws chips from (no contradiction possible)", () => {
    const view = readSourceFile("src/ui/sync-view.ts");
    const actions = functionBody(view, "  private renderPendingIssueRetryableActions(");
    expect(actions).toContain("pendingIssueExitKind(");
    expect(actions).not.toContain('issue.issueCode === "');
    expect(actions).toContain('case "stale-identity":');
    expect(actions).toContain('case "scope-crossing":');
    expect(actions).toContain("case null:");
  });
});
