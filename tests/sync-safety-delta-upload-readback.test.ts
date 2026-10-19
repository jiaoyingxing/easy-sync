// 未回执上传的远端回读结算（C1／F26③／B1 隔离）
// 由 tests/sync-safety.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。 本文件保留同名容器 describe，用例全名与拆分前一致。

import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import * as obsidian from "obsidian";
import {
  sha256Hex,
} from "../src/crypto";
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

describe("Persistent remote delta state", () => {
  describe("unreceipted upload settled from remote readback (C1, 2026-10-13)", () => {
    async function runC1Recovery(options: {
      intendedBytes: ArrayBuffer;
      localBytes: ArrayBuffer;
      expectedRemoteDriveId?: string;
      liveDriveId?: string;
      downloadedBytes?: ArrayBuffer | null;
      oldIdAlive?: boolean;
      sourcePath?: string;
      observationOnly?: boolean;
      localEntryOmitted?: boolean;
      readbackETagDrift?: boolean;
    }) {
      const activeScope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
      const intendedHash = await sha256Hex(options.intendedBytes);
      const localHash = await sha256Hex(options.localBytes);
      const liveDriveId = options.liveDriveId
        ?? options.expectedRemoteDriveId
        ?? "uploaded-note";
      const remoteBytes = options.downloadedBytes ?? options.intendedBytes;
      const remote: RemoteFileEntry = {
        path: "note.md",
        driveId: liveDriveId,
        parentId: activeScope.filesRootId,
        size: remoteBytes?.byteLength ?? 0,
        mtime: 3,
        eTag: "etag-uploaded",
        cTag: "ctag-uploaded",
        sha256Hash: intendedHash,
      };
      const local: LocalFileEntry = {
        path: remote.path,
        hash: localHash,
        size: options.localBytes.byteLength,
        mtime: 9,
        binary: false,
      };
      const state = makeActiveV2State([remote], [], {
        mutationLedger: [{
          intent: {
            version: 1 as const,
            operationId: "op-c1-upload",
            planRevision: 1,
            scope: activeScope,
            action: "upload" as const,
            path: remote.path,
            expectedLocal: {
              exists: true as const,
              hash: intendedHash,
              size: options.intendedBytes.byteLength,
            },
            expectedRemote: options.expectedRemoteDriveId
              ? {
                exists: true as const,
                driveId: options.expectedRemoteDriveId,
                eTag: "etag-old",
                size: options.intendedBytes.byteLength,
                sha256Hash: intendedHash,
              }
              : { exists: false as const },
            ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
            createdAt: 1,
          },
          receipt: null,
        }],
      });
      vi.mocked(state.retireMutationCheckpointIfReflected).mockResolvedValue(false);
      let readbackDone = false;
      const downloadFile = vi.fn().mockImplementation(async () => {
        readbackDone = true;
        return options.downloadedBytes === null
          ? new ArrayBuffer(0)
          : options.downloadedBytes ?? options.intendedBytes;
      });
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile,
          // 回读复检的漂移装置：下载真的发生之后，再读到的 eTag 已不同源。
          getFileMetadata: vi.fn().mockImplementation(async () =>
            options.readbackETagDrift && readbackDone
              ? { ...remote, eTag: "etag-uploaded-again" }
              : remote),
          getDriveItemMetadataById: vi.fn().mockResolvedValue(
            options.oldIdAlive
              ? { id: options.expectedRemoteDriveId }
              : null,
          ),
        }),
        Object.assign(emptyScanner(), {
          // localEntryOmitted＝「文件在、但读不出内容」的检查面。
          inspectFile: vi.fn().mockResolvedValue(
            options.localEntryOmitted
              ? { status: "present" }
              : { status: "present", entry: local },
          ),
        }),
        state,
        "testVault",
      );
      let summary: MutationRecoveryRunSummary;
      try {
        summary = await (executor as unknown as {
          recoverMutationLedger(
            scope: SyncScope,
            metrics?: unknown,
            epoch?: unknown,
            observationOnly?: boolean,
          ): Promise<MutationRecoveryRunSummary>;
        }).recoverMutationLedger(
          activeScope,
          undefined,
          undefined,
          options.observationOnly === true,
        );
      } catch (error) {
        // A record that stays blocked makes the recovery pass throw; the
        // summary it carries is what the caller adjudicates on.
        if (!(error instanceof Error) || error.name !== "MutationRecoveryBlockedError") {
          throw error;
        }
        summary = (error as unknown as { summary: MutationRecoveryRunSummary }).summary;
      }
      return { summary, state, downloadFile };
    }

    async function runC1MixedRecovery() {
      // 两记录同账本：note.md＝C1 可结算形态，other.md＝远端已变（C1b 形态）。
      const activeScope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
      const intendedBytes = new Uint8Array([1, 2, 3]).buffer;
      const intendedHash = await sha256Hex(intendedBytes);
      const localBytes = new Uint8Array([4, 5, 6, 7]).buffer;
      const localHash = await sha256Hex(localBytes);
      const driftedBytes = new Uint8Array([7, 7, 7, 7]).buffer;
      const remoteFor = (
        path: string,
        driveId: string,
        size: number,
      ): RemoteFileEntry => ({
        path,
        driveId,
        parentId: activeScope.filesRootId,
        size,
        mtime: 3,
        eTag: `${driveId}-etag`,
        cTag: `${driveId}-ctag`,
        sha256Hash: intendedHash,
      });
      const settleRemote = remoteFor("note.md", "uploaded-note", intendedBytes.byteLength);
      const movedOnRemote = remoteFor("other.md", "uploaded-other", driftedBytes.byteLength);
      const recordFor = (operationId: string, path: string, driveId: string | null) => ({
        intent: {
          version: 1 as const,
          operationId,
          planRevision: 1,
          scope: activeScope,
          action: "upload" as const,
          path,
          expectedLocal: {
            exists: true as const,
            hash: intendedHash,
            size: intendedBytes.byteLength,
          },
          expectedRemote: driveId
            ? {
              exists: true as const,
              driveId,
              eTag: "etag-old",
              size: intendedBytes.byteLength,
              sha256Hash: intendedHash,
            }
            : { exists: false as const },
          createdAt: 1,
        },
        receipt: null,
      });
      const state = makeActiveV2State([settleRemote, movedOnRemote], [], {
        mutationLedger: [
          recordFor("op-c1-settles", "note.md", null),
          recordFor("op-c1b-stays", "other.md", "uploaded-other"),
        ],
      });
      vi.mocked(state.retireMutationCheckpointIfReflected).mockResolvedValue(false);
      const executor = new SyncExecutor(
        makeMockOneDrive({
          downloadFile: vi.fn().mockImplementation(async (_v: string, path: string) =>
            path === "note.md" ? intendedBytes : driftedBytes),
          getFileMetadata: vi.fn().mockImplementation(async (_v: string, path: string) =>
            path === "note.md" ? settleRemote : movedOnRemote),
          getDriveItemMetadataById: vi.fn().mockResolvedValue(null),
        }),
        Object.assign(emptyScanner(), {
          inspectFile: vi.fn().mockImplementation(async (path: string) => ({
            status: "present",
            entry: {
              path,
              hash: localHash,
              size: localBytes.byteLength,
              mtime: 9,
              binary: false,
            } as LocalFileEntry,
          })),
        }),
        state,
        "testVault",
      );
      let summary: MutationRecoveryRunSummary;
      try {
        summary = await (executor as unknown as {
          recoverMutationLedger(scope: SyncScope): Promise<MutationRecoveryRunSummary>;
        }).recoverMutationLedger(activeScope);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "MutationRecoveryBlockedError") {
          throw error;
        }
        summary = (error as unknown as { summary: MutationRecoveryRunSummary }).summary;
      }
      return { summary, state, intendedHash };
    }

    it("settles the record when the remote still holds exactly the intended version", async () => {
      // 同形标本（C1）：上传已落地但回执丢失，本机随后又被改写；远端仍原样
      // 驻留所传版本 ⇒ 零写入结算，基线取所传版本（不是更新后的本机字节）。
      const intendedBytes = new Uint8Array([1, 2, 3]).buffer;
      const intendedHash = await sha256Hex(intendedBytes);
      const { summary, state, downloadFile } = await runC1Recovery({
        intendedBytes,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
      });

      expect(summary).toMatchObject({ state: "settled", settled: 1, remaining: 0 });
      expect(state.mutationLedger).toEqual([]);
      expect(state.baseSnapshot).toEqual([
        expect.objectContaining({
          path: "note.md",
          hash: intendedHash,
          size: intendedBytes.byteLength,
          eTag: "etag-uploaded",
        }),
      ]);
      // 强制回读确实发生（比对的是下载到的字节，不是索引里的陈旧哈希）。
      expect(downloadFile).toHaveBeenCalledTimes(1);
    });

    it("settles the overwrite shape too when the identity is still the same item", async () => {
      const intendedBytes = new Uint8Array([1, 2, 3]).buffer;
      const { summary, state } = await runC1Recovery({
        intendedBytes,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
        expectedRemoteDriveId: "uploaded-note",
      });

      expect(summary).toMatchObject({ state: "settled", settled: 1 });
      expect(state.mutationLedger).toEqual([]);
    });

    it("keeps the record fail-closed when the remote moved on as well", async () => {
      // C1b 形态（两侧都已变）：明确不做——记录保留、不结算。
      const { summary, state } = await runC1Recovery({
        intendedBytes: new Uint8Array([1, 2, 3]).buffer,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
        downloadedBytes: new Uint8Array([7, 7, 7]).buffer,
      });

      expect(summary.state).not.toBe("settled");
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-c1-upload"]);
    });

    it("keeps the record fail-closed when the remote identity was replaced", async () => {
      // 路径下的对象被删后重建（driveId 变了）：内容相等也不构成"我们那次
      // 写成功"的证据——不结算，且连强制回读都不发生（先校验身份）。
      const { summary, state, downloadFile } = await runC1Recovery({
        intendedBytes: new Uint8Array([1, 2, 3]).buffer,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
        expectedRemoteDriveId: "old-uploaded-note",
        liveDriveId: "recreated-note",
        oldIdAlive: false,
      });

      expect(summary.state).not.toBe("settled");
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-c1-upload"]);
      expect(downloadFile).not.toHaveBeenCalled();
    });

    it("keeps a sourcePath upload fail-closed when the local file moved on", async () => {
      // sourcePath 变体（复制式上传）有额外源侧交付面，本次证据门不覆盖它：
      // 本机已改写 ⇒ 不采纳、不结算、记录保留（形状门前提）。
      const { summary, state } = await runC1Recovery({
        intendedBytes: new Uint8Array([1, 2, 3]).buffer,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
        sourcePath: "copy-source.md",
      });

      expect(summary.state).not.toBe("settled");
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-c1-upload"]);
    });

    it("settles during a reset-preflight observation round (zero-write)", async () => {
      // 观察轮（重置预检／B4 复探）照常可结算：C1 是零写入收敛、不依赖任何
      // 本机恢复写入；若在这里被拦下，重置会被无谓推入强制档。
      const intendedBytes = new Uint8Array([1, 2, 3]).buffer;
      const { summary, state } = await runC1Recovery({
        intendedBytes,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
        observationOnly: true,
      });

      expect(summary).toMatchObject({ state: "settled", settled: 1, remaining: 0 });
      expect(state.mutationLedger).toEqual([]);
    });

    it("keeps the record fail-closed when the recorded object moved elsewhere and is still alive (drift)", async () => {
      // 记录指向的对象被挪走（路径下换了别的对象），而原对象仍在别处存活：
      // 这是一次漂移，不是"我们那次写成功"——内容相同也不采纳、不结算。
      const intendedBytes = new Uint8Array([1, 2, 3]).buffer;
      const { summary, state } = await runC1Recovery({
        intendedBytes,
        localBytes: intendedBytes,
        expectedRemoteDriveId: "old-uploaded-note",
        liveDriveId: "recreated-note",
        oldIdAlive: true,
      });

      expect(summary.state).not.toBe("settled");
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-c1-upload"]);
    });

    it("keeps a present inspection without content facts fail-closed", async () => {
      // 「文件在、但读不出内容」没有可比较的事实面，不能按"本机已改写"来
      // 采纳——保持 fail-closed，记录保留。
      const intendedBytes = new Uint8Array([1, 2, 3]).buffer;
      const { summary, state, downloadFile } = await runC1Recovery({
        intendedBytes,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
        localEntryOmitted: true,
      });

      expect(summary.state).not.toBe("settled");
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-c1-upload"]);
      expect(downloadFile).not.toHaveBeenCalled();
    });

    it("keeps the record fail-closed when the remote changes again after the readback (eTag drift)", async () => {
      // 回读到的字节虽然相符，但回读之后那个对象又变了一次（eTag 已不同源）：
      // "刚读到的字节"不能当结算依据。
      const intendedBytes = new Uint8Array([1, 2, 3]).buffer;
      const { summary, state } = await runC1Recovery({
        intendedBytes,
        localBytes: new Uint8Array([4, 5, 6, 7]).buffer,
        readbackETagDrift: true,
      });

      expect(summary.state).not.toBe("settled");
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-c1-upload"]);
    });

    it("settles one C1 record independently in a multi-record ledger", async () => {
      // 多记录账本：能证落地的那条先行零写入结算，另一条（远端也变过）原样
      // 保留——结算不因同账本还有其他阻塞记录而整体回退，也不连带它。
      const { summary, state, intendedHash } = await runC1MixedRecovery();

      expect(summary).toMatchObject({ state: "blocked", settled: 1, remaining: 1 });
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-c1b-stays"]);
      expect(state.baseSnapshot).toEqual([
        expect.objectContaining({
          path: "note.md",
          hash: intendedHash,
          size: 3,
          eTag: "uploaded-note-etag",
        }),
      ]);
    });
  });

  describe("receipted upload verification keeps content-less local inspections fail-closed (F26 item ③, 2026-10-13)", () => {
    async function runReceiptCheck(options: { localEntry: LocalFileEntry | null }) {
      const activeScope: SyncScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
      const uploadedBytes = new Uint8Array([1, 2, 3]).buffer;
      const uploadedHash = await sha256Hex(uploadedBytes);
      const remote: RemoteFileEntry = {
        path: "note.md",
        driveId: "uploaded-note",
        parentId: activeScope.filesRootId,
        size: uploadedBytes.byteLength,
        mtime: 3,
        eTag: "etag-uploaded",
        cTag: "ctag-uploaded",
        sha256Hash: uploadedHash,
      };
      const base: BaseFileEntry = {
        path: "note.md",
        hash: uploadedHash,
        size: uploadedBytes.byteLength,
        eTag: "etag-uploaded",
      };
      const record = {
        intent: {
          version: 1 as const,
          operationId: "op-receipted-upload",
          planRevision: 1,
          scope: activeScope,
          action: "upload" as const,
          path: "note.md",
          expectedLocal: {
            exists: true as const,
            hash: uploadedHash,
            size: uploadedBytes.byteLength,
          },
          expectedRemote: {
            exists: true as const,
            driveId: "uploaded-note",
            eTag: "etag-uploaded",
            size: uploadedBytes.byteLength,
            sha256Hash: uploadedHash,
          },
          createdAt: 1,
        },
        receipt: {
          version: 1 as const,
          operationId: "op-receipted-upload",
          completedAt: 1,
          checkpoint: {
            baseUpserts: [base],
            remoteUpserts: [remote],
            baseRemovals: [],
            remoteDeletes: [],
            pendingDeleteRemovals: [],
          },
        },
      };
      const state = makeActiveV2State([remote], [base], {
        mutationLedger: [record],
      });
      const executor = new SyncExecutor(
        makeMockOneDrive({
          getFileMetadata: vi.fn().mockResolvedValue(remote),
        }),
        Object.assign(emptyScanner(), {
          inspectFile: vi.fn().mockResolvedValue(
            options.localEntry
              ? { status: "present", entry: options.localEntry }
              : { status: "present" },
          ),
        }),
        state,
        "testVault",
      );
      const matches = await (executor as unknown as {
        verifyMutationReceipt(record: MutationLedgerEntryV1): Promise<boolean>;
      }).verifyMutationReceipt(record as unknown as MutationLedgerEntryV1);
      return { matches };
    }

    it("settles a receipted upload after the local file was rewritten (contrast)", async () => {
      // 回执自带的那一版已在云端落地、本机随后被改写：按回执版本结算，本机
      // 新内容交下一轮。与下一条同装置，证明本装置确实走到该结算出口。
      const rewritten: LocalFileEntry = {
        path: "note.md",
        hash: await sha256Hex(new Uint8Array([4, 5, 6, 7]).buffer),
        size: 4,
        mtime: 9,
        binary: false,
      };
      const { matches } = await runReceiptCheck({ localEntry: rewritten });

      expect(matches).toBe(true);
    });

    it("keeps a present local inspection without content facts fail-closed", async () => {
      // 「文件在、但读不出内容」没有可比较的事实面，不能按"本机已改写"
      // 结算——保持 fail-closed（2026-10-13 复核⑥）。
      const { matches } = await runReceiptCheck({ localEntry: null });

      expect(matches).toBe(false);
    });
  });

  describe("managed-config and self-sync recoveries isolate instead of freezing the vault (2026-10-13 B1)", () => {
    async function runBlockedUploadRound(options: {
      path: string;
      runOptions?: Record<string, unknown>;
      extraRecordPath?: string;
      action?: "upload" | "deleteLocal";
    }) {
      const activeScope = { ...TEST_SYNC_SCOPE, accountId: "account-id" };
      const expectedHash = "aa".repeat(32);
      const remoteEntry: RemoteFileEntry = {
        path: options.path,
        driveId: "remote-old-id",
        parentId: activeScope.filesRootId,
        size: 3,
        mtime: 1,
        eTag: "etag-old",
        cTag: "ctag-old",
        sha256Hash: expectedHash,
      };
      const recordFor = (path: string, operationId: string) => ({
        intent: {
          version: 1 as const,
          operationId,
          planRevision: 1,
          scope: activeScope,
          action: (options.action ?? "upload") as "upload" | "deleteLocal",
          path,
          expectedLocal: { exists: true as const, hash: expectedHash, size: 3 },
          expectedRemote: {
            exists: true as const,
            driveId: "remote-old-id",
            eTag: "etag-old",
            size: 3,
            sha256Hash: expectedHash,
          },
          createdAt: 1,
        },
        receipt: null,
      });
      const state = makeActiveV2State([], [], {
        mutationLedger: [
          recordFor(options.path, "op-config-stuck"),
          ...(options.extraRecordPath
            ? [recordFor(options.extraRecordPath, "op-config-stuck-2")]
            : []),
        ],
      });
      const local: LocalFileEntry = {
        path: options.path,
        hash: "bb".repeat(32),
        size: 3,
        mtime: 2,
        binary: false,
      };
      const executor = new SyncExecutor(
        makeMockOneDrive({
          // The live remote moved on after the intent, so neither the local
          // gate nor the remote gate can settle the record (F26 shape).
          getFileMetadata: vi.fn().mockResolvedValue({
            driveId: "remote-old-id",
            parentId: activeScope.filesRootId,
            size: 3,
            mtime: 5,
            eTag: "etag-new",
          }),
        }),
        {
          vault: {
            adapter: makeMockAdapter({
              readBinary: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
            }),
            getFiles: vi.fn().mockReturnValue([]),
            getName: vi.fn().mockReturnValue("testVault"),
          },
          scanAll: vi.fn().mockResolvedValue({
            entries: [local],
            folders: [],
            folderScanComplete: true,
            skippedLarge: [],
            failedPaths: [],
            skippedCount: 0,
            complete: true,
          }),
          inspectFile: vi.fn().mockImplementation(async (path: string) => ({
            status: "present",
            entry: { ...local, path },
          })),
          shouldSyncFolderPath: vi.fn().mockReturnValue(true),
          shouldSyncPath: vi.fn().mockReturnValue(true),
        } as unknown as LocalScanner,
        state,
        "testVault",
        { t: (key: string) => key } as I18n,
      );
      const result = await executor.run(
        "manual",
        {},
        false,
        undefined,
        options.runOptions ?? {},
      );
      return { result, state };
    }

    it("isolates a blocked record on the plugin's own artifact instead of freezing the vault", async () => {
      const { result, state } = await runBlockedUploadRound({
        path: ".obsidian/plugins/easy-sync/main.js",
      });

      expect(result.mutationRecovery).toMatchObject({
        state: "blocked",
        blockReason: "facts-changed",
        isolated: true,
      });
      // 记录原样保留（隔离不删不猜），整库其余决策不再被它挡下。
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-config-stuck"]);
      expect(result.errors).toBe(0);
    });

    it("isolates a blocked record on a managed config path", async () => {
      const { result } = await runBlockedUploadRound({ path: ".obsidian/app.json" });

      expect(result.mutationRecovery).toMatchObject({
        state: "blocked",
        isolated: true,
      });
    });

    it("keeps the strict set for the reset-preflight observation", async () => {
      // 重置预检用同一分类器判「能否按隔离胶囊保全证据」；本刀明确不放宽
      // 该链（重置闸门保持不变），否则重置会从 forced 档静默变普通档。
      const { result } = await runBlockedUploadRound({
        path: ".obsidian/plugins/easy-sync/main.js",
        runOptions: { recoveryOnly: true, mutationRecoveryObservationOnly: true },
      });

      expect(result.mutationRecovery?.isolated).not.toBe(true);
      // 端到端判定的输入面：main.ts 只有拿到「blocked＋isolated === true＋
      // facts-changed＋blockedOperationId 命中在册记录」才走隔离胶囊档；这里
      // 没有 isolated，该记录必然落强制重置确认档——重置闸门不因 B1 静默放宽。
      expect(result.mutationRecovery).toMatchObject({
        state: "blocked",
        blockReason: "facts-changed",
        blockedOperationId: "op-config-stuck",
        remaining: 1,
      });
    });

    it("still refuses to isolate a record on another plugin's managed path", async () => {
      const { result } = await runBlockedUploadRound({
        path: ".obsidian/plugins/other-plugin/main.js",
      });

      expect(result.mutationRecovery?.isolated).not.toBe(true);
    });

    it("keeps a mixed ledger non-isolated when any record stays outside the widened set", async () => {
      // 放宽是逐记录合取：账本里只要有一条范围外路径的记录，整体仍按原
      // 行为（整库暂停），不出现"半数隔离"的中间态。
      const { result } = await runBlockedUploadRound({
        path: ".obsidian/plugins/easy-sync/main.js",
        extraRecordPath: ".obsidian/plugins/other-plugin/main.js",
      });

      expect(result.mutationRecovery?.isolated).not.toBe(true);
    });

    it("keeps a delete-type record non-isolated when its block reason is outside the isolation gate", async () => {
      // 放宽只作用于事实门（facts-changed）这一种阻塞——既有隔离门的要求；
      // 删除类记录走别的阻塞原因时维持原行为（整库暂停、零删除、记录保留）。
      const { result, state } = await runBlockedUploadRound({
        path: ".obsidian/plugins/easy-sync/main.js",
        action: "deleteLocal",
      });

      expect(result.mutationRecovery?.state).toBe("blocked");
      expect(result.mutationRecovery?.isolated).not.toBe(true);
      expect(state.mutationLedger.map((record) => record.intent.operationId))
        .toEqual(["op-config-stuck"]);
      expect(result.deleted).toBe(0);
    });
  });
});
