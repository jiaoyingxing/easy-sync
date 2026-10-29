// 熔断重试语义与网络类失败
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。

import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import * as obsidian from "obsidian";
import {
  Platform,
} from "obsidian";
import {
  sha256Hex,
} from "../src/crypto";
import {
  getEasySyncPaths,
} from "../src/obsidian-compat";
import {
  SyncActionType,
} from "../src/sync/types";
import type {
  BaseFileEntry,
  LocalFileEntry,
  ManualMutationResolutionV1,
  MutationIntentV1,
  MutationLedgerEntryV1,
  MutationReceiptV1,
  RemoteFileEntry,
  RemoteFolderEntry,
  SyncPlan,
  SyncPlanItem,
  SyncScope,
} from "../src/sync/types";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import { OneDriveClient, ResponseByteBudgetError } from "../src/onedrive/client";
import { OneDriveError, OneDriveErrorType, type DriveItem } from "../src/onedrive/types";
import type { LocalScanner } from "../src/sync/local-scanner";
import type { PendingIssue } from "../src/sync/types";
import { generateFileDecisionPlanV2 } from "../src/sync/file-decision-planner-v2";
import { StateManager } from "../src/sync/state-manager";
import { I18n } from "../src/i18n";
import { SyncProgressStore } from "../src/sync/sync-progress";
import type { DiagnosticLogger } from "../src/sync/diagnostic-logger";
import { EasySyncNoticeCenter } from "../src/ui/notice-center";
import {
  reduceFileStateEnvelopeV2,
} from "../src/sync/file-state-reducer-v2";
import {
  isFolderMutationIntent,
  reduceFolderStateEnvelopeV2,
} from "../src/sync/folder-state-reducer-v2";
import {
  attachBaseAncestorHashesV2,
  projectStatePathViewV2,
  removeBaseStateEnvelopeV2,
  replaceBaseStateEnvelopeV2,
  upsertBaseStateEnvelopeV2,
} from "../src/sync/file-state-controller-v2";
import type { SyncAnchorV2 } from "../src/sync/state-envelope-v2";
import { createFileStateShadowEnvelopeV2 } from "./helpers/file-state-shadow-v2";
import { projectRemoteIndexV2 } from "../src/sync/remote-index-v2";
import {
  makePublic113InterruptedUploadBatch,
  PUBLIC_113_NETWORK_RECOVERY_INCIDENT,
} from "./fixtures/network-recovery-incidents";
import { V2FilePlanTestHarness } from "./helpers/v2-file-plan-test-harness";
import type {
  CommunityPluginManifestObservationV1,
} from "../src/sync/community-plugin-bundle";

// ---- Shared test helpers ----

import {
  TEST_SYNC_SCOPE,
  EASY_SYNC_TMP_DIR,
  makeMockAdapter,
  makeDownloadLocalStore,
  makeMockOneDrive,
  remoteStateStub,
  makeActiveV2State,
  graphFolder,
  makeMemoryState,
  driveItem,
  emptyScanner,
  makeManualResolutionHarness,
  makeNoticeRecorder,
  BASE_UPSERT_GATES,
  makeStaleTreeCommitProbe,
} from "./helpers/sync-safety-harness";

describe("M17 circuit breaker retry semantics", () => {
  function makeBreakerExecutor(
    mode: "manual" | "auto",
    pendingActionType = SyncActionType.Download,
    issueOverrides: Partial<{
      issueCode: "transfer-network" | "transfer-remote-moving";
      updatedAt: number;
      localHash: string;
      remoteETag: string;
      consecutiveFailures: number;
    }> = {},
    scanSkippedLarge: string[] = [],
  ) {
    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const getFileMetadata = vi.fn().mockResolvedValue({
      driveId: "item-stuck",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-stuck",
    });
    const remote: RemoteFileEntry = {
      path: "stuck.m4a",
      driveId: "item-stuck",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-stuck",
      cTag: "ctag-stuck",
    };
    const mockState = makeActiveV2State([remote], [], {
      pendingIssues: [{
        path: remote.path,
        actionType: pendingActionType,
        reason: "syncView.failure.contentUnavailable",
        updatedAt: 1,
        fileSize: remote.size,
        remoteETag: remote.eTag,
        consecutiveFailures: 3,
        ...issueOverrides,
      }],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata,
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
          skippedLarge: scanSkippedLarge,
          failedPaths: [],
          skippedCount: 0,
        }),
        scanFile: vi.fn().mockResolvedValue(null),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    return { executor, downloadFile, mode, mockState, getFileMetadata };
  }

  it("manual sync bypasses the stale breaker and retries the file", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor("manual");

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("auto sync still keeps the breaker guardrail", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor("auto");

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(0);
    expect(result.errors).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("does not treat an earlier user-decision deferral as a transfer failure", async () => {
    const { executor, downloadFile, mode } = makeBreakerExecutor(
      "auto",
      SyncActionType.FolderDeferred,
    );

    const result = await executor.run(mode, {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("auto sync backs off a network-failure file even after its version changed", async () => {
    // 2026-09-12: a plugin re-bundled during a slow-network window changed
    // hash every round, which reset the version-pinned counter and kept every
    // auto round re-attempting a 4–5 minute doomed upload. A fresh network
    // failure stamps the issue as transfer-network, so the breaker applies
    // across versions while the backoff window is live.
    const { executor, downloadFile, mode } = makeBreakerExecutor("auto", SyncActionType.Upload, {
      issueCode: "transfer-network",
      updatedAt: Date.now(),
      localHash: "aa".repeat(32),
    });

    const result = await executor.run(mode, {});

    expect(result.errors).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(mode).toBe("auto");
  });

  it("auto sync retries a network-failure file once the backoff window expires", async () => {
    const { executor, downloadFile } = makeBreakerExecutor("auto", SyncActionType.Upload, {
      issueCode: "transfer-network",
      updatedAt: Date.now() - 16 * 60 * 1000,
      localHash: "aa".repeat(32),
    });

    const result = await executor.run("auto", {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("retries a network-failure file once the window expires even when its version never changed", async () => {
    // 2026-10-16 review：断网卡住一次上传之后，本机没有再编辑、云端也没收到内容，
    // 这一行的版本永远不会变——版本匹配臂原本让它被无限跳过，`reason.circuitBreaker
    // .network` 承诺的"约每 15 分钟重试一次"永远不会发生，用户看到的是又一个
    // "只有手动同步才行"。要求：网络类行的跳过只由窗口决定，与版本是否变化无关。
    const { executor, downloadFile } = makeBreakerExecutor("auto", SyncActionType.Upload, {
      issueCode: "transfer-network",
      updatedAt: Date.now() - 16 * 60 * 1000,
    });

    const result = await executor.run("auto", {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("keeps skipping a network-failure file inside its window even when its version never changed", async () => {
    // 反假绿控制项：上一条不得靠"网络类行一律不再跳过"通过——窗口内仍必须跳过，
    // 否则等于把退避臂整个拆掉、每轮都真实重试。
    const { executor, downloadFile } = makeBreakerExecutor("auto", SyncActionType.Upload, {
      issueCode: "transfer-network",
      updatedAt: Date.now(),
    });

    const result = await executor.run("auto", {});

    expect(result.downloaded).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.breakerDeferredErrors).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("keeps a real breaker-deferred round out of the plan-layer deferral family", async () => {
    // 2026-10-18 新族（planningDeferredErrors）落地后的反重复计数控制项：真实一轮
    // 里的熔断延后只算熔断族，不得同时落进计划层族（否则暂停门求和大于 errors，
    // "整轮只有延后"会被当成计数过度而暂停）。
    const { executor } = makeBreakerExecutor("auto", SyncActionType.Upload, {
      issueCode: "transfer-network",
      updatedAt: Date.now(),
    });

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(1);
    expect(result.breakerDeferredErrors).toBe(1);
    expect(result.planningDeferredErrors).toBeUndefined();
  });

  it("manual sync never defers a network-failure file through the breaker", async () => {
    const { executor, downloadFile } = makeBreakerExecutor("manual", SyncActionType.Upload, {
      issueCode: "transfer-network",
      updatedAt: Date.now(),
      localHash: "aa".repeat(32),
    });

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("oversized-file skips never accumulate into breaker failures", async () => {
    // 2026-09-13 大文件演示.bin: an oversized file is a by-design terminal
    // skip that never touches the network and carries no version identity,
    // so its recurring issue row must not arm the breaker — otherwise the
    // breaker converts the skip into a round-failing RetryLater and pauses
    // the auto sync it exists to protect.
    const { executor, downloadFile } = makeBreakerExecutor(
      "auto",
      SyncActionType.SkipLargeFile,
      { remoteETag: undefined },
      ["stuck.m4a"],
    );

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("expected skips never enter the pending-issues ledger and retire stale rows", async () => {
    // 2026-09-16 拍板：按设置跳过（大型文件）是预期行为、零行动，不属于
    // 「需要处理」——结算不入待处理账本；轮末对账按已解决路径退役既有跳过行。
    // 轮内可见性由完成列表/历史承接，细节面在诊断报告。
    const oversized: RemoteFileEntry = {
      path: "video.mp4",
      driveId: "item-video",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 300 * 1024 * 1024,
      mtime: 1,
      eTag: "etag-video",
      cTag: "ctag-video",
    };
    const seedPendingIssues: PendingIssue[] = [{
      path: oversized.path,
      actionType: SyncActionType.SkipLargeFile,
      reason: "文件超过大小限制",
      updatedAt: 1,
      fileSize: oversized.size,
      remoteETag: oversized.eTag,
    }];
    const mockState = makeActiveV2State([oversized], [], {
      pendingIssues: seedPendingIssues,
    });
    // Mirror the real reconcile semantics (delete resolved paths, upsert the
    // round's issues) — the shared fixture stub is a no-op.
    const ledger = [...seedPendingIssues];
    mockState.reconcilePendingIssues = vi.fn(async (
      issues: PendingIssue[],
      resolvedPaths: Iterable<string>,
    ) => {
      const resolved = new Set(resolvedPaths);
      const byPath = new Map(ledger.map((issue) => [issue.path, { ...issue }]));
      for (const path of resolved) byPath.delete(path);
      for (const issue of issues) byPath.set(issue.path, { ...issue });
      ledger.length = 0;
      ledger.push(...byPath.values());
      mockState.pendingIssues = [...ledger];
    });

    const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1]).buffer);
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
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
        getMaxFileSize: vi.fn().mockReturnValue(200 * 1024 * 1024),
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(
      mockState.pendingIssues.filter((issue) => issue.path === "video.mp4"),
    ).toEqual([]);
  });

  it("SkipOneDriveInvalidName keeps its pending row (it carries a user action)", async () => {
    const invalidNamed: RemoteFileEntry = {
      path: "bad?.md",
      driveId: "item-aux",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 6,
      mtime: 1,
      eTag: "etag-aux",
      cTag: "ctag-aux",
    };
    const seedPendingIssues: PendingIssue[] = [];
    const mockState = makeActiveV2State([invalidNamed], [], {
      pendingIssues: seedPendingIssues,
    });
    // Mirror the real reconcile semantics (delete resolved paths, upsert the
    // round's issues) — the shared fixture stub is a no-op.
    const ledger = [...seedPendingIssues];
    mockState.reconcilePendingIssues = vi.fn(async (
      issues: PendingIssue[],
      resolvedPaths: Iterable<string>,
    ) => {
      const resolved = new Set(resolvedPaths);
      const byPath = new Map(ledger.map((issue) => [issue.path, { ...issue }]));
      for (const path of resolved) byPath.delete(path);
      for (const issue of issues) byPath.set(issue.path, { ...issue });
      ledger.length = 0;
      ledger.push(...byPath.values());
      mockState.pendingIssues = [...ledger];
    });

    const executor = new SyncExecutor(
      makeMockOneDrive({}),
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
      } as unknown as LocalScanner,
      mockState,
      "testVault",
    );

    await executor.run("manual", {});

    expect(
      mockState.pendingIssues.filter(
        (issue) => issue.actionType === SyncActionType.SkipOneDriveInvalidName,
      ).map((issue) => issue.path),
    ).toEqual(["bad?.md"]);
  });

  it("counts breaker-only deferrals so the pause gate can exempt them", async () => {
    const { executor } = makeBreakerExecutor("auto");

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(1);
    expect(result.breakerDeferredErrors).toBe(1);
  });

  it("a successful retry hands the transfer-remote-moving path to the round-end reconcile", async () => {
    // 2026-10-28 真机（焦应行的笔记本）：延后行在下一轮成功下载后仍挂在
    // 「需要处理」，直到重启才消失。轮末对账只删除 resolved 集合里的路径、
    // 未重签的旧行原样存活——成功结算必须把该路径交给 resolvedIssuePaths，
    // 否则行在账本里永生，显示层随账本走就永远不会刷新。
    const { executor, downloadFile, mode, mockState, getFileMetadata } =
      makeBreakerExecutor("auto", SyncActionType.Download, {
        issueCode: "transfer-remote-moving",
        consecutiveFailures: 1,
      });
    const deferredByRound: string[][] = [];
    const resolvedByRound: string[][] = [];
    mockState.reconcilePendingIssues = vi.fn(async (
      issues: PendingIssue[],
      resolvedPaths?: Iterable<string>,
    ) => {
      deferredByRound.push(
        issues.filter((issue) => issue.path === "stuck.m4a").map((issue) => issue.path),
      );
      resolvedByRound.push([...(resolvedPaths ?? [])]);
    });
    // 首轮：下载期间远端版本前移（计划 etag-stuck、实读 etag-newer）→ 延后。
    getFileMetadata.mockResolvedValueOnce({
      driveId: "item-stuck",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-newer",
    });
    const first = await executor.run(mode, {});
    expect(first.deferred).toBe(1);
    expect(deferredByRound.at(-1)).toEqual(["stuck.m4a"]);
    // 次轮：远端版本已稳定（回到计划版本）→ 下载成功 → 路径必须进 resolved。
    const second = await executor.run(mode, {});
    expect(second.downloaded).toBe(1);
    expect(deferredByRound.at(-1)).toEqual([]);
    expect(resolvedByRound.at(-1)).toContain("stuck.m4a");
  });

  it("auto sync defers a remote-version-changed download instead of failing the round", async () => {
    // 2026-09-28 热文件现场（resojot 录音分片、传输中的照片）：下载期间云端
    // 版本前移是瞬态内容竞态，下一轮重排计划即可拿到新版本——不得当作整轮
    // 失败暂停自动同步，只延后该单项（防覆盖弃写本身不变）。
    const { executor, downloadFile, mode, mockState, getFileMetadata } =
      makeBreakerExecutor("auto", SyncActionType.Download, {
        issueCode: "transfer-remote-moving",
        consecutiveFailures: 1,
      });
    const reconcileCalls: PendingIssue[][] = [];
    mockState.reconcilePendingIssues = vi.fn(async (issues: PendingIssue[]) => {
      reconcileCalls.push(issues);
    });
    getFileMetadata.mockResolvedValue({
      driveId: "item-stuck",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-newer",
    });

    const result = await executor.run(mode, {});

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    const deferredRows = reconcileCalls.at(-1)?.filter(
      (issue) => issue.path === "stuck.m4a",
    ) ?? [];
    expect(deferredRows).toHaveLength(1);
    expect(deferredRows[0].issueCode).toBe("transfer-remote-moving");
    expect(deferredRows[0].reason).toBe("syncView.failure.remoteChangedDuringDownload");
    // 执行器推出的原始行固定 consecutiveFailures: 1；跨轮合并由真
    // reconcile 负责（state-manager.test.ts 覆盖）。
    expect(deferredRows[0].consecutiveFailures).toBe(1);
    expect(deferredRows[0].remoteETag).toBe("etag-stuck");
  });

  it("auto sync defers a download whose response body outgrew the declared size", async () => {
    // 2026-10-13（双轨候选，用户拍板立项）：同一物理竞态「远端在读取期间
    // 被改写」被尺寸守卫先捕获时，与版本校验一路同规——延后该单项、不暂停
    // 自动同步；守卫本身（拒绝写入不完整正文）不放宽。
    const { executor, downloadFile, mockState } = makeBreakerExecutor(
      "auto",
      SyncActionType.Download,
      { issueCode: "transfer-remote-moving", consecutiveFailures: 1 },
    );
    downloadFile.mockRejectedValue(
      new ResponseByteBudgetError('Remote file "stuck.m4a"', 22, 27, "observed"),
    );
    const reconcileCalls: PendingIssue[][] = [];
    mockState.reconcilePendingIssues = vi.fn(async (issues: PendingIssue[]) => {
      reconcileCalls.push(issues);
    });

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    const deferredRows = reconcileCalls.at(-1)?.filter(
      (issue) => issue.path === "stuck.m4a",
    ) ?? [];
    expect(deferredRows).toHaveLength(1);
    expect(deferredRows[0].issueCode).toBe("transfer-remote-moving");
    expect(deferredRows[0].reason).toBe("syncView.failure.remoteChangedDuringDownload");
  });

  it("auto sync defers a download whose response declared more than the file's own size", async () => {
    // 2026-10-16（Q2）：同一物理竞态「远端在读取期间被改写」的第三个检测点——
    // 响应头声明长度大于该文件自己的尺寸。此前它与「自身超硬上限」共用
    // kind="declared" ⇒ 落硬失败、errors>0、自动同步暂停；改判后与另两个检测点
    // 同规：延后该单项、不暂停、不产生硬失败。
    const { executor, downloadFile, mockState } = makeBreakerExecutor(
      "auto",
      SyncActionType.Download,
      { issueCode: "transfer-remote-moving", consecutiveFailures: 1 },
    );
    downloadFile.mockRejectedValue(
      new ResponseByteBudgetError(
        'Remote file "stuck.m4a"',
        22,
        27,
        "declared-over-expected",
      ),
    );
    const reconcileCalls: PendingIssue[][] = [];
    mockState.reconcilePendingIssues = vi.fn(async (issues: PendingIssue[]) => {
      reconcileCalls.push(issues);
    });

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    const deferredRows = reconcileCalls.at(-1)?.filter(
      (issue) => issue.path === "stuck.m4a",
    ) ?? [];
    expect(deferredRows).toHaveLength(1);
    expect(deferredRows[0].issueCode).toBe("transfer-remote-moving");
    expect(deferredRows[0].reason).toBe("syncView.failure.remoteChangedDuringDownload");
  });

  it("auto sync defers a completed download whose size no longer matches the declaration", async () => {
    const { executor, downloadFile, mockState } = makeBreakerExecutor(
      "auto",
      SyncActionType.Download,
      { issueCode: "transfer-remote-moving", consecutiveFailures: 1 },
    );
    // The remote declared 3 bytes; the body that arrived has 5 (rewritten
    // between the metadata read and the body read).
    downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    const reconcileCalls: PendingIssue[][] = [];
    mockState.reconcilePendingIssues = vi.fn(async (issues: PendingIssue[]) => {
      reconcileCalls.push(issues);
    });

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(0);
    expect(result.deferred).toBe(1);
    expect(result.success).toBe(true);
    const deferredRows = reconcileCalls.at(-1)?.filter(
      (issue) => issue.path === "stuck.m4a",
    ) ?? [];
    expect(deferredRows[0]?.issueCode).toBe("transfer-remote-moving");
  });

  it("keeps a declared size over the hard cap a hard failure", async () => {
    // 反例护栏：声明尺寸本身超硬上限是恒久条件（这个文件永远传不了），
    // 不得被并进「瞬时延后」通道藏成永久延后。
    const { executor, downloadFile } = makeBreakerExecutor(
      "auto",
      SyncActionType.Download,
      { issueCode: "transfer-remote-moving", consecutiveFailures: 1 },
    );
    downloadFile.mockRejectedValue(
      new ResponseByteBudgetError(
        'Remote file "stuck.m4a"',
        2 * 1024 * 1024 * 1024,
        2 * 1024 * 1024 * 1024 + 1,
        "declared",
      ),
    );

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.success).toBe(false);
  });

  it("auto sync backs off a remote-moving file even after its version changed", async () => {
    // 版本已前移（versionMatched 不成立）但退避窗口仍活着 → 熔断按
    // transfer-remote-moving 计时臂接管，每窗口一次真实尝试。
    const { executor, downloadFile } = makeBreakerExecutor("auto", SyncActionType.Download, {
      issueCode: "transfer-remote-moving",
      updatedAt: Date.now(),
      remoteETag: "etag-older",
    });

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(1);
    expect(result.breakerDeferredErrors).toBe(1);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("auto sync retries a remote-moving file once the backoff window expires", async () => {
    const { executor, downloadFile } = makeBreakerExecutor("auto", SyncActionType.Download, {
      issueCode: "transfer-remote-moving",
      updatedAt: Date.now() - 16 * 60 * 1000,
      remoteETag: "etag-older",
    });

    const result = await executor.run("auto", {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("manual sync never defers a remote-moving file through the breaker", async () => {
    const { executor, downloadFile } = makeBreakerExecutor("manual", SyncActionType.Download, {
      issueCode: "transfer-remote-moving",
      updatedAt: Date.now(),
      remoteETag: "etag-older",
    });

    const result = await executor.run("manual", {});

    expect(result.downloaded).toBe(1);
    expect(result.errors).toBe(0);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });
});

// ---- Pre-implementation safety evidence: download compare-and-swap ----

describe("network-class transfer failure marking (2026-10-16)", () => {
  // 2026-10-16 用户拍板：网络类失败不再让自动同步整库停摆。执行器负责把
  // 「失败原因就是链路本身」的失败单独计数（`networkFailureErrors`），
  // main 侧暂停门据此只在"整轮错误全是网络类"时放行。计数不改 errors，
  // 历史、待处理行与失败提示继续如实。
  function makeFailingDownloadExecutor(error: unknown, i18n?: I18n) {
    const downloadFile = vi.fn().mockRejectedValue(error);
    const remote: RemoteFileEntry = {
      path: "offline.md",
      driveId: "item-offline",
      parentId: TEST_SYNC_SCOPE.filesRootId,
      size: 3,
      mtime: 1,
      eTag: "etag-offline",
      cTag: "ctag-offline",
    };
    const mockState = makeActiveV2State([remote], [], {
      pendingIssues: [],
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        downloadFile,
        getFileMetadata: vi.fn().mockResolvedValue({
          driveId: "item-offline",
          parentId: TEST_SYNC_SCOPE.filesRootId,
          size: 3,
          mtime: 1,
          eTag: "etag-offline",
        }),
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
      } as unknown as LocalScanner,
      mockState,
      "testVault",
      i18n,
    );
    return { executor, downloadFile, mockState };
  }

  it("marks a dropped-link download failure as network-class", async () => {
    const { executor, downloadFile } = makeFailingDownloadExecutor(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    );

    const result = await executor.run("auto", {});

    expect(downloadFile).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    expect(result.networkFailureErrors).toBe(1);
  });

  it("counts a 408 timeout as network-class (same class as network-unavailable)", async () => {
    const { executor, mockState } = makeFailingDownloadExecutor(
      new OneDriveError(OneDriveErrorType.Unknown, "request timeout", 408),
    );
    const reconcileCalls: PendingIssue[][] = [];
    mockState.reconcilePendingIssues = vi.fn(async (issues: PendingIssue[]) => {
      reconcileCalls.push(issues);
    });

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(1);
    expect(result.networkFailureErrors).toBe(1);
    // 同一分类的两个消费面必须一致：暂停门按网络类放行，待处理行的退避臂也必须
    // 按网络类走（`transfer-network`）——否则这一行会落到版本匹配臂上被无限跳过，
    // 文案承诺的 15 分钟重试同样落空。
    const rows = reconcileCalls.at(-1)?.filter((issue) => issue.path === "offline.md") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].issueCode).toBe("transfer-network");
  });

  it("drops the exempt-family marks when the run itself fails unexpectedly", async () => {
    // 反掩蔽（2026-10-16 review）：run 级意外异常不属于任何豁免族，而它把 errors
    // 抬到 1 的那一步在"本轮已经有一条网络失败"时是无操作——不作废标记，暂停门会
    // 把这一轮读成「整轮只有网络类」，让本该停机诊断的未知失败每周期重试一次。
    // 要求：豁免标记作废，errors 保持如实。
    const { executor, mockState } = makeFailingDownloadExecutor(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
    );
    mockState.reconcilePendingIssues = vi.fn().mockRejectedValue(
      new Error("pending issue reconciliation exploded"),
    );

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(1);
    expect(result.networkFailureErrors).toBeUndefined();
    expect(result.success).toBe(false);
  });

  it("does not mark a service-side 503 as network-class", async () => {
    // 反假绿控制项：服务端 5xx／限流是另一族（既有 service-unavailable 分类），
    // 仍按真实失败处理，不得被"网络类"豁免顺带放过。
    const { executor, mockState } = makeFailingDownloadExecutor(
      new OneDriveError(OneDriveErrorType.ServerError, "graph unavailable", 503),
    );
    const reconcileCalls: PendingIssue[][] = [];
    mockState.reconcilePendingIssues = vi.fn(async (issues: PendingIssue[]) => {
      reconcileCalls.push(issues);
    });

    const result = await executor.run("auto", {});

    expect(result.errors).toBe(1);
    expect(result.networkFailureErrors).toBeUndefined();
    const rows = reconcileCalls.at(-1)?.filter((issue) => issue.path === "offline.md") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].issueCode).toBeUndefined();
  });

  it("presents a run-level 507 with the storage-full reason instead of the raw status", async () => {
    const { executor, mockState } = makeFailingDownloadExecutor(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
      new I18n("zh-cn"),
    );
    mockState.reconcilePendingIssues = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.InsufficientStorage, "HTTP 507", 507),
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(false);
    expect(result.message).toBe("同步失败：OneDrive 存储空间不足");
  });

  it("presents a run-level 408 with the network request reason", async () => {
    const { executor, mockState } = makeFailingDownloadExecutor(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
      new I18n("zh-cn"),
    );
    mockState.reconcilePendingIssues = vi.fn().mockRejectedValue(
      new OneDriveError(OneDriveErrorType.Unknown, "request timeout", 408),
    );

    const result = await executor.run("auto", {});

    expect(result.success).toBe(false);
    expect(result.message).toBe("同步失败：网络请求失败");
  });
});

describe("plan-layer identity deferral exempt family (2026-10-18)", () => {
  // 2026-10-18 用户拍板：计划层延后（`RetryLater` +
  // `reason.identityReplacement.verificationPending`，文案自陈「本轮未作更改」、
  // 设计语义＝下一轮再验证）与既有三族同款——失败仍如实计数，但不触发整库暂停。
  // 执行器把该 reason 的延后单独计入 `planningDeferredErrors`：计数点与被豁免的
  // `errors++` 同处一行，main 侧暂停门的求和等式据此不会与实际执行数漂移。
  function makeExecutor() {
    return new SyncExecutor(
      makeMockOneDrive({}),
      emptyScanner(),
      makeActiveV2State([], []),
      "testVault",
    );
  }

  const emptyResult = (): SyncResult => ({
    success: false,
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    deferred: 0,
    skippedLarge: 0,
    skippedIgnored: 0,
    errors: 0,
    authExpired: false,
    message: "failed",
  });

  const executeRetryLater = (
    executor: SyncExecutor,
    item: SyncPlanItem,
    result: SyncResult,
  ) => (executor as unknown as {
    executeRetryLaterItem(args: {
      item: SyncPlanItem;
      result: SyncResult;
    }): { executed: boolean };
  }).executeRetryLaterItem({ item, result });

  it("counts a plan-layer identity deferral in its own exempt family", () => {
    const result = emptyResult();

    const executed = executeRetryLater(makeExecutor(), {
      type: SyncActionType.RetryLater,
      path: "Note.md",
      reason: "reason.identityReplacement.verificationPending",
    }, result);

    expect(executed.executed).toBe(true);
    // 失败如实：errors 照记，历史与待处理行照走；族计数只影响暂停门。
    expect(result.errors).toBe(1);
    expect(result.planningDeferredErrors).toBe(1);
  });

  it("does not count a breaker deferral as a plan-layer deferral", () => {
    // 反重复计数控制项：熔断延后由它自己的族（`breakerDeferredErrors`，在熔断
    // 改写处计数）承担；若这里再计一次，族和大于 errors，暂停门会把"整轮只有
    // 延后"误判成计数过度而暂停。
    const result = emptyResult();

    executeRetryLater(makeExecutor(), {
      type: SyncActionType.RetryLater,
      path: "stuck.m4a",
      reason: "reason.circuitBreaker.network",
    }, result);

    expect(result.errors).toBe(1);
    expect(result.planningDeferredErrors).toBeUndefined();
  });

  it("leaves a RetryLater without the plan reason in no exempt family", () => {
    // 反假绿控制项：豁免按 reason 精确入族，未知/无理由的延后形状不被顺带放过
    // ——族和小于 errors，暂停门照旧暂停（fail-closed）。
    const result = emptyResult();

    executeRetryLater(makeExecutor(), {
      type: SyncActionType.RetryLater,
      path: "mystery.md",
    }, result);

    expect(result.errors).toBe(1);
    expect(result.planningDeferredErrors).toBeUndefined();
  });
});

describe("P1 — downloadUrl refresh is batched up front for every download (any platform, any size)", () => {
  it("A2 — refreshes missing URLs through one $batch on mobile and version-verifies hashless entries through the batch endpoint", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const buffer = new Uint8Array(128 * 1024).fill(7).buffer;
      const hash = await sha256Hex(buffer);
      // 6 remote-only files, none carrying a downloadUrl, 2 of them carrying
      // a trusted SHA-256 (so those skip version verification entirely).
      const remoteEntries = Array.from({ length: 6 }, (_, index): RemoteFileEntry => ({
        path: `mobile-batch-${index}.bin`,
        driveId: `mobile-id-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `mobile-etag-${index}`,
        cTag: `mobile-ctag-${index}`,
        ...(index < 2 ? { sha256Hash: hash } : {}),
      }));
      const remoteById = new Map(remoteEntries.map((entry) => [entry.driveId, entry]));
      const getDriveItemMetadataByIds = vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => {
          const remote = remoteById.get(id)!;
          return [id, {
            id,
            name: remote.path,
            size: remote.size,
            eTag: remote.eTag,
            cTag: remote.cTag,
            file: {},
            parentReference: { id: remote.parentId },
            "@microsoft.graph.downloadUrl": `https://download.example/${id}`,
          }];
        })),
      );
      const downloadFile = vi.fn().mockResolvedValue(buffer.slice(0));
      const localStore = makeDownloadLocalStore();
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          getDriveItemMetadataByIds,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({
            entries: [],
            folders: [],
            folderScanComplete: true,
            folderScanFailures: [],
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          }),
          scanFile: vi.fn().mockResolvedValue(null),
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      // Every missing downloadUrl is refreshed through the batch endpoint
      // exactly once (6 ids → one $batch), never per file.
      const refreshCalls = getDriveItemMetadataByIds.mock.calls
        .filter((call) => call[1] === "downloadUrlRefresh");
      expect(refreshCalls).toHaveLength(1);
      expect([...refreshCalls[0][0]].sort()).toEqual(
        remoteEntries.map((entry) => entry.driveId).sort(),
      );
      // A2: hashless mobile downloads are version-verified through the batch
      // endpoint (one call per adaptive batch) instead of one per-path GET.
      // Assert coverage, not batch shape.
      const verifiedIds = getDriveItemMetadataByIds.mock.calls
        .filter((call) => call[1] === "downloadVersionVerify")
        .flatMap((call) => call[0]);
      expect([...verifiedIds].sort()).toEqual(
        remoteEntries.filter((entry) => !entry.sha256Hash)
          .map((entry) => entry.driveId).sort(),
      );
      expect(getDriveItemMetadataByIds.mock.calls.every((call) =>
        call[1] === "downloadUrlRefresh" || call[1] === "downloadVersionVerify",
      )).toBe(true);
      // Every download used the URL the batch refresh filled back into the
      // plan item.
      expect(downloadFile.mock.calls.every((call) =>
        typeof call[2] === "string" && call[2].startsWith("https://download.example/"),
      )).toBe(true);
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
      expect(localStore.files.size).toBe(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("A2 — mobile prefetch-eligible downloads fail closed when refresh batching is unavailable", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = true;
    try {
      const buffer = new Uint8Array(128 * 1024).fill(8).buffer;
      const hash = await sha256Hex(buffer);
      const remoteEntries = Array.from({ length: 3 }, (_, index): RemoteFileEntry => ({
        path: `mobile-batch-fallback-${index}.bin`,
        driveId: `mobile-fallback-id-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `mobile-fallback-etag-${index}`,
        cTag: `mobile-fallback-ctag-${index}`,
        ...(index === 0 ? { sha256Hash: hash } : {}),
      }));
      // Batch endpoint rejects: the universal refresh and every per-batch
      // prep fail. A2 mirrors the desktop prefetch contract — batch members
      // without a URL fail closed instead of falling back to the per-file
      // waterfall, so no file may be written and no mutation recorded.
      const getDriveItemMetadataByIds = vi.fn().mockRejectedValue(new Error("batch down"));
      const downloadFile = vi.fn().mockResolvedValue(buffer.slice(0));
      const localStore = makeDownloadLocalStore();
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          getDriveItemMetadataByIds,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({
            entries: [],
            folders: [],
            folderScanComplete: true,
            folderScanFailures: [],
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          }),
          scanFile: vi.fn().mockResolvedValue(null),
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      // Fail-closed: universal + per-batch refreshes all fail, every
      // prefetch-eligible member errors before any content request, and
      // nothing is written or committed.
      expect(result.downloaded).toBe(0);
      expect(result.errors).toBe(remoteEntries.length);
      expect(getDriveItemMetadataByIds).toHaveBeenCalled();
      expect(getDriveItemMetadataByIds.mock.calls.every((call) =>
        call[1] === "downloadUrlRefresh",
      )).toBe(true);
      expect(downloadFile).not.toHaveBeenCalled();
      expect(localStore.files.size).toBe(0);
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(0);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });

  it("batches the downloadUrl refresh for desktop large files that never enter the prefetch path", async () => {
    const previousMobile = Platform.isMobile;
    Platform.isMobile = false;
    try {
      // 3 remote-only files above the 8 MiB prefetch cap: they never qualify
      // for the desktop prefetch batch (canPrefetchDownload rejects oversized
      // files), so before P1 each paid a per-file waterfall refresh. The P1
      // universal up-front batch must cover them with one $batch.
      const buffer = new Uint8Array(9 * 1024 * 1024).fill(5).buffer;
      const hash = await sha256Hex(buffer);
      const remoteEntries = Array.from({ length: 3 }, (_, index): RemoteFileEntry => ({
        path: `desktop-large-${index}.bin`,
        driveId: `desktop-large-id-${index}`,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: buffer.byteLength,
        mtime: index,
        eTag: `desktop-large-etag-${index}`,
        cTag: `desktop-large-ctag-${index}`,
        sha256Hash: hash,
      }));
      const remoteById = new Map(remoteEntries.map((entry) => [entry.driveId, entry]));
      const getDriveItemMetadataByIds = vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => {
          const remote = remoteById.get(id)!;
          return [id, {
            id,
            name: remote.path,
            size: remote.size,
            eTag: remote.eTag,
            cTag: remote.cTag,
            file: {},
            parentReference: { id: remote.parentId },
            "@microsoft.graph.downloadUrl": `https://download.example/${id}`,
          }];
        })),
      );
      const downloadFile = vi.fn().mockResolvedValue(buffer.slice(0));
      const localStore = makeDownloadLocalStore();
      const state = makeActiveV2State(remoteEntries, []);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          getDriveItemMetadataByIds,
          hasDegradedDownloadPathThisRound: vi.fn().mockReturnValue(false),
        }),
        {
          vault: {
            adapter: localStore.adapter,
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({
            entries: [],
            folders: [],
            folderScanComplete: true,
            folderScanFailures: [],
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          }),
          scanFile: vi.fn().mockResolvedValue(null),
          inspectFile: localStore.inspectFile,
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
      );

      const result = await executor.run("manual", {});

      expect(result.downloaded).toBe(remoteEntries.length);
      expect(result.errors).toBe(0);
      // The universal batch refreshed all 3 large-file ids exactly once.
      const refreshCalls = getDriveItemMetadataByIds.mock.calls
        .filter((call) => call[1] === "downloadUrlRefresh");
      expect(refreshCalls).toHaveLength(1);
      expect([...refreshCalls[0][0]].sort()).toEqual(
        remoteEntries.map((entry) => entry.driveId).sort(),
      );
      // Large files keep streaming/downloading through the ordinary path with
      // the batch-filled URL.
      expect(downloadFile.mock.calls.every((call) =>
        typeof call[2] === "string" && call[2].startsWith("https://download.example/"),
      )).toBe(true);
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toHaveLength(remoteEntries.length);
      expect(localStore.files.size).toBe(remoteEntries.length);
    } finally {
      Platform.isMobile = previousMobile;
    }
  });
});

describe("T2 server-authoritative convergence — per-id lastModifiedBy evidence", () => {
  const hashA = "aa".repeat(32); // remote version at intent creation
  const hashB = "bb".repeat(32); // local content (upload payload / downloaded content)
  const hashC = "cc".repeat(32); // current remote version rewritten by EasySync

  async function makeT2Harness(intent: MutationIntentV1, localHash = hashB) {
    const ledger: MutationLedgerEntryV1[] = [{ intent, receipt: null }];
    const state = makeActiveV2State(
      [{
        path: "note.md",
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: 3,
        mtime: 2,
        eTag: "etag-C",
        cTag: "ctag-C",
        sha256Hash: hashC,
      }],
      [],
      { mutationLedger: ledger },
    );
    const onedrive = makeMockOneDrive({
      // Current remote = C (same driveId, eTag/hash moved on)
      getFileMetadata: vi.fn().mockResolvedValue({
        driveId: "remote-id",
        parentId: TEST_SYNC_SCOPE.filesRootId,
        downloadUrl: "https://download/1",
        size: 3,
        mtime: 2,
        eTag: "etag-C",
        cTag: "ctag-C",
        sha256Hash: hashC,
      }),
      // T2 per-id evidence: the remote object was written by EasySync
      getDriveItemMetadataById: vi.fn().mockResolvedValue({
        id: "remote-id",
        name: "note.md",
        size: 3,
        eTag: "etag-C",
        lastModifiedBy: { application: { displayName: "EasySync" } },
      }),
    });
    const executor = new SyncExecutor(
      onedrive,
      {
        vault: {
          configDir: ".obsidian",
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        inspectFile: vi.fn().mockResolvedValue({
          status: "present" as const,
          entry: {
            path: intent.path,
            hash: localHash,
            size: 3,
            mtime: 1,
            binary: false,
          },
        }),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const recover = () => {
      const epoch = (executor as unknown as {
        lifecycle: { capture(): number };
      }).lifecycle.capture();
      return (executor as unknown as {
        recoverMutationLedger(
          scope: SyncScope,
          metrics: undefined,
          operationEpoch: number,
          observationOnly: boolean,
        ): Promise<unknown>;
      }).recoverMutationLedger(
        { ...TEST_SYNC_SCOPE, accountId: "account-id" },
        undefined,
        epoch,
        false,
      );
    };
    return { executor, onedrive, recover, state, intent };
  }

  it("keeps an unreceipted download fail-closed when the current remote was rewritten by EasySync", async () => {
    const harness = await makeT2Harness({
      version: 1,
      operationId: "op-download-t2",
      planRevision: 1,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      action: "download",
      path: "note.md",
      expectedLocal: { exists: true, hash: hashB, size: 3 },
      expectedRemote: {
        exists: true,
        driveId: "remote-id",
        eTag: "etag-A",
        size: 3,
        sha256Hash: hashA,
      },
      createdAt: 1,
    }, hashA);

    // Recovery-layer T2 convergence was removed: its checkpoint cannot
    // satisfy both the receipt contract (base.eTag === expectedRemote.eTag)
    // and the reducer contract (base.eTag === current remoteIndex eTag),
    // and the planned T2 direction evidence belongs to the plan layer.
    await expect(harness.recover()).rejects.toThrow(
      "Mutation outcome requires manual review",
    );
    expect(harness.onedrive.getDriveItemMetadataById).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("keeps an unreceipted upload fail-closed even when the current remote was rewritten by EasySync", async () => {
    const harness = await makeT2Harness({
      version: 1,
      operationId: "op-upload-t2",
      planRevision: 1,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      action: "upload",
      path: "note.md",
      expectedLocal: { exists: true, hash: hashB, size: 3 },
      expectedRemote: {
        exists: true,
        driveId: "remote-id",
        eTag: "etag-A",
        size: 3,
        sha256Hash: hashA,
      },
      createdAt: 1,
    });

    await expect(harness.recover()).rejects.toThrow(
      "Mutation outcome requires manual review",
    );
    // Upload convergence was removed (planned boundary: both sides changed →
    // T3). No per-id evidence request may be issued for uploads.
    expect(harness.onedrive.getDriveItemMetadataById).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
  });
});

describe("M19 anti-downgrade guard version comparison (finding ③)", () => {
  function makeM19Executor(localVersion: string, remoteVersion: string) {
    const manifestFile = getEasySyncPaths(
      { configDir: ".obsidian" } as never,
    ).manifestFile;
    const adapter = makeMockAdapter({
      read: vi.fn().mockResolvedValue(
        JSON.stringify({ id: "easy-sync", version: localVersion }),
      ),
    });
    const downloadFile = vi.fn().mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({ id: "easy-sync", version: remoteVersion }),
      ).buffer,
    );
    const state = makeActiveV2State([], []);
    const executor = new SyncExecutor(
      makeMockOneDrive({ downloadFile }),
      {
        vault: {
          configDir: ".obsidian",
          adapter,
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
          complete: true,
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const guard = (
      items: SyncPlanItem[],
    ) => (executor as unknown as {
      guardEasySyncDowngrade(items: SyncPlanItem[]): Promise<number>;
    }).guardEasySyncDowngrade.call(executor, items);
    const items = [{
      path: manifestFile,
      type: SyncActionType.Download,
      remote: {
        driveId: "remote-easy-sync",
        eTag: "etag",
        size: 1,
      },
    }] as unknown as SyncPlanItem[];
    return { guard, downloadFile, items };
  }

  it("does not skip EasySync files when the remote is an upgrade (1.4.10 vs 1.4.9)", async () => {
    // Local 1.4.9 sees a remote 1.4.10 manifest: a plain upgrade. The old
    // string comparison read "1.4.10" < "1.4.9" and wrongly skipped every
    // EasySync file, blocking the upgrade (finding ③, M19).
    const { guard, downloadFile, items } = makeM19Executor("1.4.9", "1.4.10");

    const skipped = await guard(items);

    expect(skipped).toBe(0);
    expect(downloadFile).toHaveBeenCalled();
  });

  it("still skips EasySync files on a genuine downgrade (remote 1.4.9 below local 1.4.10)", async () => {
    const { guard, items } = makeM19Executor("1.4.10", "1.4.9");

    const skipped = await guard(items);

    expect(skipped).toBe(items.length);
  });

  it("still skips EasySync files on a downgrade across a numeric boundary (remote 1.3.9)", async () => {
    const { guard, items } = makeM19Executor("1.4.10", "1.3.9");

    const skipped = await guard(items);

    expect(skipped).toBe(items.length);
  });
});

// ---- Recovery observation reviewed-cursor preservation (plan re-pause loop) ----

describe("connection-speed in-flight overlay", () => {
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function makeLocalEntry(
    path: string,
    content: ArrayBuffer,
  ): Promise<LocalFileEntry> {
    return {
      path,
      hash: await sha256Hex(content),
      size: content.byteLength,
      mtime: 2,
      binary: false,
    };
  }

  function makeUploadExecutor(
    entries: LocalFileEntry[],
    contents: Map<string, ArrayBuffer>,
    uploadFile: ReturnType<typeof vi.fn>,
  ): SyncExecutor {
    return new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockResolvedValue(undefined),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn(async (path: string) => {
              const content = contents.get(path);
              if (content === undefined) throw new Error(`no content for ${path}`);
              return content;
            }),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll: vi.fn().mockResolvedValue({
          entries,
          folders: [],
          folderScanComplete: true,
          skippedLarge: [],
          failedPaths: [],
          skippedCount: 0,
          complete: true,
        }),
        inspectFile: vi.fn(async (target: string) => {
          const entry = entries.find((candidate) => candidate.path === target);
          return entry
            ? { status: "present", entry }
            : { status: "missing" };
        }),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      makeActiveV2State([], []),
      "testVault",
    );
  }

  it("reports byte-level movement while a single upload is still transferring and reconciles without double counting", async () => {
    const content = new Uint8Array(1024).fill(7).buffer;
    const local = await makeLocalEntry("big-note.md", content);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploadFile = vi.fn(
      async (
        _vault: string,
        _path: string,
        bytes: ArrayBuffer,
        onProgress?: (downloaded: number, total: number) => void,
      ) => {
        for (let part = 1; part <= 4; part++) {
          await sleep(20);
          onProgress?.(Math.floor(bytes.byteLength * part / 5), bytes.byteLength);
        }
        await released;
        onProgress?.(bytes.byteLength, bytes.byteLength);
        return { id: "new-upload-id", eTag: "new-upload-etag", cTag: "new-upload-ctag" };
      },
    );
    const executor = makeUploadExecutor([local], new Map([["big-note.md", content]]), uploadFile);

    const runPromise = executor.run("manual", {});
    let mid: { bytes: number; ms: number } | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const snapshot = executor.getActiveTransferMetrics();
      if (
        snapshot
        && snapshot.upload.bytes > 0
        && snapshot.upload.bytes < content.byteLength
        && snapshot.upload.ms > 0
      ) {
        mid = snapshot.upload;
        break;
      }
      await sleep(5);
    }
    expect(mid).not.toBeNull();
    expect(mid!.bytes).toBeLessThan(content.byteLength);
    release();
    const result = await runPromise;
    expect(result.uploaded).toBe(1);
    const settled = executor.getActiveTransferMetrics();
    expect(settled?.upload.bytes).toBe(content.byteLength);
  });

  it("sums bytes across two uploads transferring in parallel", async () => {
    const contentA = new Uint8Array(1024).fill(1).buffer;
    const contentB = new Uint8Array(2048).fill(2).buffer;
    const localA = await makeLocalEntry("a-note.md", contentA);
    const localB = await makeLocalEntry("b-note.md", contentB);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploadFile = vi.fn(
      async (
        _vault: string,
        path: string,
        bytes: ArrayBuffer,
        onProgress?: (downloaded: number, total: number) => void,
      ) => {
        onProgress?.(Math.floor(bytes.byteLength / 2), bytes.byteLength);
        await released;
        onProgress?.(bytes.byteLength, bytes.byteLength);
        return { id: `upload-${path}`, eTag: "new-upload-etag", cTag: "new-upload-ctag" };
      },
    );
    const executor = makeUploadExecutor(
      [localA, localB],
      new Map([["a-note.md", contentA], ["b-note.md", contentB]]),
      uploadFile,
    );

    const runPromise = executor.run("manual", {});
    let parallelBytes: number | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const snapshot = executor.getActiveTransferMetrics();
      const combinedHalf = Math.floor(contentA.byteLength / 2)
        + Math.floor(contentB.byteLength / 2);
      if (snapshot && snapshot.upload.bytes >= combinedHalf && snapshot.upload.ms > 0) {
        parallelBytes = snapshot.upload.bytes;
        break;
      }
      await sleep(5);
    }
    release();
    await runPromise;
    expect(parallelBytes).not.toBeNull();
    expect(parallelBytes!).toBeGreaterThanOrEqual(
      Math.floor(contentA.byteLength / 2) + Math.floor(contentB.byteLength / 2),
    );
  });

  it("leaves no phantom in-flight bytes after a failed transfer", async () => {
    const content = new Uint8Array(512).fill(3).buffer;
    const local = await makeLocalEntry("fail-note.md", content);
    const uploadFile = vi.fn(
      async (
        _vault: string,
        _path: string,
        bytes: ArrayBuffer,
        onProgress?: (downloaded: number, total: number) => void,
      ) => {
        onProgress?.(Math.floor(bytes.byteLength / 2), bytes.byteLength);
        throw new Error("network down");
      },
    );
    const executor = makeUploadExecutor([local], new Map([["fail-note.md", content]]), uploadFile);

    await executor.run("manual", {});
    const settled = executor.getActiveTransferMetrics();
    expect(settled?.upload.bytes ?? 0).toBe(0);
  });
});

