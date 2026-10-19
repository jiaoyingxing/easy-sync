// S1 观测刀——每轮事实指纹、阻断项分类计数、连续两轮同指纹的「空转」判定。
// 合同：docs/archive/2026-08/20260814-1155（事实指纹口径：scope／对象身份／
//       本机内容摘要／远端 ID 与版本／共同基线版本／ledger 与审阅修订）＋
//       docs/temp/20261016-151934 §六 S1 行／§七 观测判据／§八 不做范围。
// 边界：输出只进诊断日志；零控制流改动（反向控制项钉住）、零用户可见面、
//       零新增写入；比较状态只在内存、随插件实例生命周期持有、不持久化。

import { describe, it, expect, vi } from "vitest";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import { SyncActionType } from "../src/sync/types";
import type {
  MutationLedgerEntryV1,
  PendingIssue,
  RemoteFileEntry,
} from "../src/sync/types";
import { OneDriveError, OneDriveErrorType } from "../src/onedrive/types";
import {
  TEST_SYNC_SCOPE,
  makeMockAdapter,
  makeMockOneDrive,
  makeActiveV2State,
} from "./helpers/sync-safety-harness";
import {
  buildSyncRoundFingerprint,
  buildRoundBlockedClassifications,
  observeSyncRoundEnd,
  type SyncIdleObservationInput,
} from "../src/sync/sync-idle-observation";

// ---- Shared fixtures & helpers ----

const STUCK_REMOTE: RemoteFileEntry = {
  path: "stuck.m4a",
  driveId: "item-stuck",
  parentId: TEST_SYNC_SCOPE.filesRootId,
  size: 3,
  mtime: 1,
  eTag: "etag-stuck",
  cTag: "ctag-stuck",
};

const OFFLINE_REMOTE: RemoteFileEntry = {
  path: "offline.md",
  driveId: "item-offline",
  parentId: TEST_SYNC_SCOPE.filesRootId,
  size: 3,
  mtime: 1,
  eTag: "etag-offline",
  cTag: "ctag-offline",
};

const SERVER_REMOTE: RemoteFileEntry = {
  path: "server.md",
  driveId: "item-server",
  parentId: TEST_SYNC_SCOPE.filesRootId,
  size: 4,
  mtime: 1,
  eTag: "etag-server",
  cTag: "ctag-server",
};

type RecordedLogCall = [string, string, unknown, unknown];

/** Recording diag double: mirrors the production "all categories enabled"
 *  gate — `warn`/`error` and the gated `log` calls flow through verbatim so
 *  the round summaries keep appending; observation assertions filter by the
 *  two dedicated message names. */
function makeRecordingDiag(enabled = true) {
  const calls: RecordedLogCall[] = [];
  const diag = {
    log: vi.fn((...args: unknown[]) => {
      calls.push(args as unknown as RecordedLogCall);
    }),
    warn: vi.fn(),
    error: vi.fn(),
    isEnabled: vi.fn(() => enabled),
  } as unknown as DiagnosticLogger;
  return { diag, calls };
}

const makeActiveClientDefaults = () => ({
  beginRunMetrics: vi.fn(),
  finishRunMetrics: vi.fn().mockReturnValue(null),
});

function records(calls: RecordedLogCall[], name: string): RecordedLogCall[] {
  return calls.filter((call) => call[1] === name);
}

function fingerprintOf(call: RecordedLogCall): string {
  return (call[2] as { fingerprint: string }).fingerprint;
}

function makeMockScanner() {
  return {
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
  } as never;
}

/**
 * Blocked-item fixture (the breaker-window executor shape): the plan
 * re-derives the same deferral row every round while no world fact changes —
 * the smallest stable idle shape the verdict exists for.
 */
function makeBlockedState(pendingIssues: PendingIssue[]) {
  return makeActiveV2State([STUCK_REMOTE], [], {
    pendingIssues: pendingIssues.map((issue) => ({ ...issue })),
  });
}

const makeBreakerIssue = (overrides: Partial<PendingIssue> = {}): PendingIssue => ({
  path: STUCK_REMOTE.path,
  actionType: SyncActionType.Download,
  reason: "syncView.failure.contentUnavailable",
  updatedAt: 1,
  fileSize: STUCK_REMOTE.size,
  remoteETag: STUCK_REMOTE.eTag,
  consecutiveFailures: 3,
  ...overrides,
});

/** One executor over the given state. Passing a diag records an observed
 *  run; omitting it builds the unobserved twin (observation fully off). */
function makeExecutor(
  state: ReturnType<typeof makeActiveV2State>,
  diag?: DiagnosticLogger,
  remoteEntries: RemoteFileEntry[] = [STUCK_REMOTE],
): SyncExecutor {
  void remoteEntries;
  return new SyncExecutor(
    makeMockOneDrive(makeActiveClientDefaults()),
    makeMockScanner(),
    state as never,
    "testVault",
    undefined,
    undefined,
    diag,
  );
}

/** Result dimensions that an observation must never touch (reverse control). */
function comparableResultDimensions(result: SyncResult) {
  return {
    success: result.success,
    uploaded: result.uploaded,
    downloaded: result.downloaded,
    deleted: result.deleted,
    conflicts: result.conflicts,
    deferred: result.deferred,
    skippedLarge: result.skippedLarge,
    skippedIgnored: result.skippedIgnored,
    skippedInvalidName: result.skippedInvalidName,
    errors: result.errors,
    identityBlockedErrors: result.identityBlockedErrors,
    breakerDeferredErrors: result.breakerDeferredErrors,
    networkFailureErrors: result.networkFailureErrors,
    authExpired: result.authExpired,
    disposition: result.disposition ?? null,
    runFacts: result.runFacts ?? null,
  };
}
type ComparableResult = ReturnType<typeof comparableResultDimensions>;

// ---- Unit: fingerprint composition (canonical serialization contract) ----

function makeUnitInput(
  overrides: Partial<SyncIdleObservationInput> = {},
): SyncIdleObservationInput {
  return {
    scope: { ...TEST_SYNC_SCOPE },
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

describe("S1 fact fingerprint composition", () => {
  it("is stable for identical inputs", () => {
    const first = buildSyncRoundFingerprint(makeUnitInput());
    const second = buildSyncRoundFingerprint(makeUnitInput());
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("reflects a fact change in every fingerprinted group (no constant hash)", () => {
    const base = buildSyncRoundFingerprint(makeUnitInput());
    const variants = [
      buildSyncRoundFingerprint(makeUnitInput({
        scope: { ...TEST_SYNC_SCOPE, driveId: "other-drive" },
      })),
      buildSyncRoundFingerprint(makeUnitInput({ stateCommitSeq: 8 })),
      buildSyncRoundFingerprint(makeUnitInput({
        pendingIssues: [{
          path: "stuck.m4a",
          actionType: SyncActionType.RetryLater,
          reason: "reason.circuitBreaker.network",
          updatedAt: 1,
          remoteETag: "etag-next",
        }],
      })),
      buildSyncRoundFingerprint(makeUnitInput({
        mutationLedger: [{
          intent: {
            version: 1,
            operationId: "op-1",
            planRevision: 1,
            scope: { ...TEST_SYNC_SCOPE },
            action: "upload",
            path: "a.md",
            expectedLocal: { exists: true, hash: "aa".repeat(32), size: 1 },
            expectedRemote: { exists: false },
            createdAt: 1,
          },
          receipt: null,
        } as unknown as MutationLedgerEntryV1],
      })),
      buildSyncRoundFingerprint(makeUnitInput({
        planReview: { active: true, revision: 5, digest: "digest-5" },
      })),
      buildSyncRoundFingerprint(makeUnitInput({
        counts: {
          ...makeUnitInput().counts,
          downloaded: 1,
        },
      })),
    ];
    for (const variant of variants) {
      expect(variant.fingerprint).not.toBe(base.fingerprint);
    }
  });

  it("stays stable when only per-round bookkeeping changes (churn immunity)", () => {
    // updatedAt / consecutiveFailures are rewritten every round without a
    // fact change; including them would hide every idle shape.
    const base = buildSyncRoundFingerprint(makeUnitInput({
      pendingIssues: [{
        path: "stuck.m4a",
        actionType: SyncActionType.RetryLater,
        reason: "reason.circuitBreaker.network",
        updatedAt: 1000,
        remoteETag: "etag-stuck",
        consecutiveFailures: 3,
      }],
    }));
    const churned = buildSyncRoundFingerprint(makeUnitInput({
      pendingIssues: [{
        path: "stuck.m4a",
        actionType: SyncActionType.RetryLater,
        reason: "reason.circuitBreaker.network",
        updatedAt: 456789,
        remoteETag: "etag-stuck",
        consecutiveFailures: 9,
      }],
    }));
    expect(churned.fingerprint).toBe(base.fingerprint);
  });

  it("stays stable when only an expiring pre-signed download URL changes", () => {
    // Graph pre-signed tokens refresh between unchanged rounds; they are not
    // facts (远端事实绑定 driveId／eTag／size). One conflict row whose remote
    // entry only differs in downloadUrl must keep the fingerprint stable.
    const conflictRow = (downloadUrl?: string) => ({
      path: "conflict.md",
      type: SyncActionType.Conflict,
      local: {
        path: "conflict.md",
        size: 1,
        mtime: 1,
        hash: "ab".repeat(32),
        binary: false,
      },
      remote: {
        path: "conflict.md",
        driveId: "item-c",
        size: 1,
        mtime: 1,
        eTag: "etag-c",
        cTag: "ctag-c",
        ...(downloadUrl ? { downloadUrl } : {}),
      },
      baseEtag: "etag-base",
    });
    const base = buildSyncRoundFingerprint(makeUnitInput({
      pendingConflicts: [conflictRow()],
    }));
    expect(
      buildSyncRoundFingerprint(makeUnitInput({
        pendingConflicts: [conflictRow("https://download.example/expiring-token")],
      })).fingerprint,
    ).toBe(base.fingerprint);
  });

  it("classifies blocked items strictly with existing vocabulary only", () => {    const issues: PendingIssue[] = [
      {
        path: "a.md",
        actionType: SyncActionType.RetryLater,
        reason: "reason.circuitBreaker.network",
        updatedAt: 1,
        issueCode: "transfer-network",
      },
      {
        path: "folder",
        actionType: SyncActionType.FolderDeferred,
        reason: "reason.anchoredFolder",
        updatedAt: 1,
        issueCode: "anchored-folder-missing-local",
      },
    ];
    const blocked = buildRoundBlockedClassifications(makeUnitInput({
      pendingIssues: issues,
      counts: {
        ...makeUnitInput().counts,
        errors: 3,
        breakerDeferredErrors: 1,
        networkFailureErrors: 2,
      },
    }));
    expect(blocked).toEqual({
      errors: {
        total: 3,
        breakerDeferredErrors: 1,
        networkFailureErrors: 2,
      },
      issueCodes: {
        "transfer-network": 1,
        "anchored-folder-missing-local": 1,
      },
      reasons: {
        "reason.circuitBreaker.network": 1,
        "reason.anchoredFolder": 1,
      },
      pending: { issues: 2 },
      ledger: {},
    });
  });

  it("grows the streak across consecutive identical rounds and resets on change", () => {
    const emitted: Array<{ msg: string; data: unknown }> = [];
    const diag = (message: "sync round fact fingerprint" | "sync idle spin detected", data: unknown): void => {
      emitted.push({ msg: message, data });
    };
    const idleInput = makeUnitInput({
      pendingIssues: [{
        path: "stuck.m4a",
        actionType: SyncActionType.RetryLater,
        reason: "reason.circuitBreaker.network",
        updatedAt: 1,
        remoteETag: "etag-stuck",
      }],
    });
    const state = { previousFingerprint: null, streak: 0 };
    observeSyncRoundEnd(state, idleInput, diag);
    expect(state.streak).toBe(1);
    observeSyncRoundEnd(state, idleInput, diag);
    expect(state.streak).toBe(2);
    observeSyncRoundEnd(state, idleInput, diag);
    expect(state.streak).toBe(3);
    expect(
      emitted.filter((entry) => entry.msg === "sync idle spin detected"),
    ).toHaveLength(2);
    // A fact change breaks the chain.
    observeSyncRoundEnd(state, makeUnitInput({
      pendingIssues: [{
        path: "stuck.m4a",
        actionType: SyncActionType.RetryLater,
        reason: "reason.circuitBreaker.network",
        updatedAt: 1,
        remoteETag: "etag-changed",
      }],
    }), diag);
    expect(state.streak).toBe(1);
  });

  it("suppresses the verdict for a fully converged round (steady state)", () => {
    // A round with zero unresolved surface is the expected "回到零计划" form;
    // flagging it would cry wolf on every healthy vault.
    const emitted: string[] = [];
    const diag = (message: "sync round fact fingerprint" | "sync idle spin detected"): void => {
      emitted.push(message);
    };
    const state = { previousFingerprint: null, streak: 0 };
    observeSyncRoundEnd(state, makeUnitInput(), diag);
    observeSyncRoundEnd(state, makeUnitInput(), diag);
    observeSyncRoundEnd(state, makeUnitInput(), diag);
    expect(emitted.filter((msg) => msg === "sync idle spin detected")).toEqual([]);
    expect(emitted.filter((msg) => msg === "sync round fact fingerprint")).toHaveLength(3);
  });
});

// ---- Executor behavior: observation wiring at round end ----

describe("S1 sync idle observation (executor wiring)", () => {
  it("emits one verdict on the second identical blocked round with an urgent flag", async () => {
    const { diag, calls } = makeRecordingDiag();
    const state = makeBlockedState([makeBreakerIssue()]);
    const executor = makeExecutor(state as never, diag);

    const firstRound = await executor.run("auto", {});
    const secondRound = await executor.run("auto", {});

    // The block itself behaves as pinned by 熔断 semantics: deferred, one error.
    expect(firstRound.uploaded).toBe(0);
    expect(firstRound.errors).toBe(1);
    expect(secondRound.errors).toBe(1);

    const fingerprints = records(calls, "sync round fact fingerprint");
    expect(fingerprints.length).toBe(2);
    // Stable comparison basis across the two rounds.
    expect(fingerprintOf(fingerprints[1])).toBe(fingerprintOf(fingerprints[0]));
    // urgent-level immediate flush, as the C3 precedent made round summaries.
    expect(fingerprints[0][3]).toEqual({ urgent: true });

    const verdicts = records(calls, "sync idle spin detected");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0][2]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      fingerprint: fingerprintOf(fingerprints[1]),
      streak: 2,
    }));
    expect(verdicts[0][3]).toEqual({ urgent: true });
    // Reused vocabulary visible in the verdict: one breaker-deferred error.
    expect((verdicts[0][2] as { blocked: { errors: Record<string, number>; pending: Record<string, number> } }).blocked).toEqual(expect.objectContaining({
      errors: expect.objectContaining({
        total: 1,
        breakerDeferredErrors: 1,
      }),
      pending: expect.objectContaining({ issues: 1 }),
    }));
  });

  it("emits per-round fingerprint lines but no verdict for a fully converged vault", async () => {
    const { diag, calls } = makeRecordingDiag();
    const state = makeActiveV2State([], [], {
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
      setLastSyncTime: vi.fn().mockResolvedValue(undefined),
      incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
    });
    const executor = makeExecutor(state as never, diag, []);

    const first = await executor.run("manual", {});
    const second = await executor.run("manual", {});

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const fingerprints = records(calls, "sync round fact fingerprint");
    expect(fingerprints).toHaveLength(2);
    expect(records(calls, "sync idle spin detected")).toEqual([]);
  });

  it("stays silent while the world's facts change between rounds", async () => {
    const { diag, calls } = makeRecordingDiag();
    const state = makeBlockedState([makeBreakerIssue()]);
    const executor = makeExecutor(state as never, diag);

    await executor.run("auto", {});
    // A fact changed between the rounds (remote version of the blocked row).
    (state as unknown as { pendingIssues: PendingIssue[] }).pendingIssues[0]
      .remoteETag = "etag-advanced";
    await executor.run("auto", {});

    const fingerprints = records(calls, "sync round fact fingerprint");
    expect(fingerprints).toHaveLength(2);
    expect(fingerprintOf(fingerprints[1])).not.toBe(fingerprintOf(fingerprints[0]));
    expect(records(calls, "sync idle spin detected")).toEqual([]);
  });

  it("does not resume a stale streak across diagnostics-disabled rounds", async () => {
    const enabled = { value: false };
    const { diag, calls } = makeRecordingDiag();
    (diag.isEnabled as ReturnType<typeof vi.fn>).mockImplementation(
      () => enabled.value,
    );
    const issues = [makeBreakerIssue()];
    const state = makeBlockedState(issues);
    const executor = makeExecutor(state as never, diag);

    // Two unobserved rounds — no observation lines, and no retained
    // comparison state.
    await executor.run("auto", {});
    await executor.run("auto", {});
    expect(records(calls, "sync round fact fingerprint")).toEqual([]);
    // Diagnostics turn on mid-life: the first observed round has no previous
    // fingerprint, so even an identical blocked round stays verdict-free.
    enabled.value = true;
    await executor.run("auto", {});
    expect(records(calls, "sync idle spin detected")).toEqual([]);
    expect(records(calls, "sync round fact fingerprint")).toHaveLength(1);
    // Only the second freshly observed consecutive round may conclude.
    await executor.run("auto", {});
    const verdicts = records(calls, "sync idle spin detected");
    expect(verdicts).toHaveLength(1);
    expect((verdicts[0][2] as { streak: number }).streak).toBe(2);
  });

  it("emits nothing while diagnostics are disabled for the category", async () => {
    const { diag, calls } = makeRecordingDiag(false);
    const state = makeBlockedState([makeBreakerIssue()]);
    const executor = makeExecutor(state as never, diag);

    await executor.run("auto", {});
    await executor.run("auto", {});

    expect(records(calls, "sync round fact fingerprint")).toEqual([]);
    expect(records(calls, "sync idle spin detected")).toEqual([]);
  });
});

// ---- Reverse control: with observation == without observation ----

describe("S1 reverse control (observation cannot change round outcomes)", () => {
  /** Drive a fixture for N rounds on an observed and on an unobserved twin;
   *  assert per-round result-dimension equality. */
  async function assertRoundsPlateau(
    mode: "manual" | "auto",
    rounds: number,
    makeState: () => ReturnType<typeof makeBlockedState>,
  ): Promise<ComparableResult[]> {
    const { diag: recordedDiag, calls } = makeRecordingDiag();
    const observedState = makeState();
    const unobservedState = makeState();
    const observedExecutor = makeExecutor(observedState as never, recordedDiag);
    const unobservedExecutor = makeExecutor(unobservedState as never, undefined);

    const observedRounds: ComparableResult[] = [];
    const unobservedRounds: ComparableResult[] = [];
    for (let index = 0; index < rounds; index++) {
      observedRounds.push(
        comparableResultDimensions(await observedExecutor.run(mode, {})),
      );
      unobservedRounds.push(
        comparableResultDimensions(await unobservedExecutor.run(mode, {})),
      );
      expect(observedRounds[index]).toEqual(unobservedRounds[index]);
    }
    // Sanity: the observation actually ran (fingerprints recorded).
    expect(records(calls, "sync round fact fingerprint")).toHaveLength(rounds);
    return observedRounds;
  }

  it("keeps two healthy success rounds identical", async () => {
    const rounds = await assertRoundsPlateau(
      "manual",
      2,
      () => makeActiveV2State([], [], {
        reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
        setLastSyncTime: vi.fn().mockResolvedValue(undefined),
        incrementRemoteGeneration: vi.fn().mockResolvedValue(undefined),
      }),
    );
    for (const round of rounds) {
      expect(round.success).toBe(true);
    }
  });

  it("keeps two deferred (breaker-window) rounds identical", async () => {
    const rounds = await assertRoundsPlateau(
      "auto",
      2,
      () => makeBlockedState([makeBreakerIssue()]),
    );
    for (const round of rounds) {
      expect(round.errors).toBe(1);
      expect(round.breakerDeferredErrors).toBe(1);
    }
  });

  it("keeps two mixed-failure (network + service) rounds identical so the pause gate inputs are unchanged", async () => {
    const remoteEntries = [OFFLINE_REMOTE, SERVER_REMOTE];
    const downloadFile = vi.fn(async (_vault: string, path: string) => {
      if (path === OFFLINE_REMOTE.path) {
        throw new OneDriveError(OneDriveErrorType.NetworkError, "offline");
      }
      throw new OneDriveError(OneDriveErrorType.ServerError, "graph unavailable", 503);
    });
    const getFileMetadata = vi.fn(async (_vault: string, path: string) => ({
      driveId: path === OFFLINE_REMOTE.path
        ? OFFLINE_REMOTE.driveId
        : SERVER_REMOTE.driveId,
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: path === OFFLINE_REMOTE.path ? OFFLINE_REMOTE.size : SERVER_REMOTE.size,
      mtime: 1,
      eTag: path === OFFLINE_REMOTE.path ? OFFLINE_REMOTE.eTag : SERVER_REMOTE.eTag,
    }));

    const { diag: recordedDiag, calls } = makeRecordingDiag();
    const buildState = () => makeActiveV2State(remoteEntries, [], {
      reconcilePendingIssues: vi.fn().mockResolvedValue(undefined),
    });
    const observedState = buildState();
    const unobservedState = buildState();
    const commonClient = {
      downloadFile,
      getFileMetadata,
      ...makeActiveClientDefaults(),
    };
    const observedExecutor = new SyncExecutor(
      makeMockOneDrive(commonClient),
      makeMockScanner(),
      observedState as never,
      "testVault",
      undefined,
      undefined,
      recordedDiag,
    );
    const unobservedExecutor = new SyncExecutor(
      makeMockOneDrive(commonClient),
      makeMockScanner(),
      unobservedState as never,
      "testVault",
    );

    const observed: ComparableResult[] = [];
    const unobservedResults: ComparableResult[] = [];
    for (let index = 0; index < 2; index++) {
      observed.push(comparableResultDimensions(await observedExecutor.run("auto", {})));
      unobservedResults.push(comparableResultDimensions(await unobservedExecutor.run("auto", {})));
      expect(observed[index]).toEqual(unobservedResults[index]);
    }
    expect(records(calls, "sync round fact fingerprint")).toHaveLength(2);
    // The pause gate inputs themselves: a network-class failure plus a
    // non-network failure — the mixed form must keep pausing (main-side
    // sum equation: exempt sum < errors). The classification counters the
    // gate reads must survive the observation unchanged.
    for (const round of observed) {
      expect(round.success).toBe(false);
      expect(round.networkFailureErrors).toBe(1);
      expect(round.errors).toBeGreaterThan(1);
    }
  });
});
