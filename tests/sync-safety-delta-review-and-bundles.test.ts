// 审阅决定与插件包结算
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
import {
  BundleReviewBytesCache,
} from "../src/sync/bundle-review-bytes-cache";
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

describe("Persistent remote delta state", () => {

  it("binds pending decision tokens through the indexed base lookup", async () => {
    const state = await makeMemoryState({
      "easy-sync-base-snapshot": {
        "conflict.md": {
          path: "conflict.md",
          hash: "bb".repeat(32),
          size: 10,
          eTag: "base-etag",
        },
      },
    }, {
      version: 1,
      generation: 0,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      deltaLink: null,
      entries: {},
      folders: {},
      folderIndexComplete: true,
    });
    await state.bindAccount("account-id");
    const executor = new SyncExecutor(
      makeMockOneDrive(),
      {
        vault: {
          adapter: makeMockAdapter(),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
      } as unknown as LocalScanner,
      state,
      "testVault",
    );
    const plan: SyncPlan = {
      items: [{
        type: SyncActionType.Conflict,
        path: "conflict.md",
        local: {
          path: "conflict.md",
          size: 10,
          mtime: 1,
          hash: "cc".repeat(32),
          binary: false,
        },
        remote: {
          path: "conflict.md",
          driveId: "remote-id",
          size: 10,
          mtime: 1,
          eTag: "remote-etag",
          cTag: "remote-ctag",
        },
      }],
      lastTotalFiles: 1,
      confirmed: false,
    };
    const baseSnapshotMaterialization = vi.spyOn(state, "baseSnapshot", "get")
      .mockImplementation(() => {
        throw new Error("decision-token binding must not materialize the whole base snapshot");
      });

    try {
      (executor as unknown as {
        bindPendingDecisionTokens(plan: SyncPlan): void;
      }).bindPendingDecisionTokens(plan);
    } finally {
      baseSnapshotMaterialization.mockRestore();
    }

    expect(plan.items[0].decisionToken?.ancestorHash).toBe("bb".repeat(32));
  });

  it("reopens review for a stale manual resolution and replaces it with a fresh choice", async () => {
    const harness = await makeManualResolutionHarness({
      path: "stale-review.md",
      local: { "stale-review.md": "local" },
      remote: { "stale-review.md": "cloud" },
    });
    const blocked = harness.state.mutationLedger[0] as MutationLedgerEntryV1;
    blocked.manualResolution = {
      version: 1,
      choice: "keep-local",
      factsDigest: "stale-digest",
      selectedAt: 1,
      externalMutation: false,
      intent: {
        ...(blocked.intent as MutationIntentV1),
        operationId: "stale-manual",
      },
      receipt: null,
    };

    expect(harness.executor.canResolveMutationRecovery("blocked-operation"))
      .toBe(true);
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot(
      "blocked-operation",
    );
    expect(reviewed).not.toBeNull();
    expect(reviewed!.identical).toBe(false);

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.state.replaceManualMutationResolution)
      .toHaveBeenCalledTimes(1);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("keeps whole-bundle and collision-evidence resolutions out of the re-review gate", async () => {
    const harness = await makeManualResolutionHarness({
      path: "gated.md",
      local: { "gated.md": "local" },
      remote: { "gated.md": "cloud" },
    });
    const blocked = harness.state.mutationLedger[0] as MutationLedgerEntryV1;
    const baseIntent = blocked.intent as MutationIntentV1;
    blocked.manualResolution = {
      version: 2,
      kind: "community-plugin-bundle-settlement",
      choice: "keep-local",
      factsDigest: "bundle-digest",
      selectedAt: 1,
      externalMutation: true,
      intent: { ...baseIntent, operationId: "bundle-manual" },
      receipt: null,
      pluginId: "some-plugin",
      pluginRoot: ".obsidian/plugins/some-plugin",
      predecessorOperationIds: [],
      conflictDecisions: [],
      members: [],
    };
    expect(harness.executor.canResolveMutationRecovery("blocked-operation"))
      .toBe(false);
    expect(await harness.executor.getMutationRecoveryResolutionSnapshot(
      "blocked-operation",
    )).toBeNull();

    blocked.manualResolution = {
      version: 1,
      choice: "keep-local",
      factsDigest: "collision-digest",
      selectedAt: 2,
      externalMutation: false,
      recoveryEvidence: {
        kind: "receipted-rename-target-anchor-collision",
        lifecycleEpoch: 1,
        sourceCommitSeq: 1,
        sourceAnchorId: "a",
        targetAnchorId: "b",
        staleRemoteIds: ["stale"],
      },
      intent: { ...baseIntent, operationId: "collision-manual" },
      receipt: null,
    };
    expect(harness.executor.canResolveMutationRecovery("blocked-operation"))
      .toBe(false);
    expect(await harness.executor.getMutationRecoveryResolutionSnapshot(
      "blocked-operation",
    )).toBeNull();
  });

  it("keeps the stale resolution when the record changed before replacement", async () => {
    const harness = await makeManualResolutionHarness({
      path: "raced-replace.md",
      local: { "raced-replace.md": "local" },
      remote: { "raced-replace.md": "cloud" },
    });
    const blocked = harness.state.mutationLedger[0] as MutationLedgerEntryV1;
    blocked.manualResolution = {
      version: 1,
      choice: "keep-local",
      factsDigest: "stale-digest",
      selectedAt: 1,
      externalMutation: false,
      intent: {
        ...(blocked.intent as MutationIntentV1),
        operationId: "stale-manual",
      },
      receipt: null,
    };
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot(
      "blocked-operation",
    );
    vi.mocked(harness.state.replaceManualMutationResolution)
      .mockResolvedValueOnce(false);

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1)
      .manualResolution).toMatchObject({ factsDigest: "stale-digest" });
    expect(harness.uploadFile).not.toHaveBeenCalled();
  });

  it("resolves a facts-changed record by keeping the exact current local file", async () => {
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      local: { "note.md": "local" },
      remote: { "note.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot(
      "blocked-operation",
    );

    expect(reviewed).toMatchObject({
      path: "note.md",
      identical: false,
      keepLocal: { available: true, deletesOtherSide: false },
      keepRemote: { available: true, deletesOtherSide: false },
    });
    expect(harness.uploadFile).not.toHaveBeenCalled();

    const resolved = await harness.executor.resolveMutationRecovery(reviewed!, "keep-local");
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(harness.remoteFiles.get("note.md")!.bytes))
      .toBe("local");
    expect(harness.state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: "note.md",
        hash: await sha256Hex(new TextEncoder().encode("local").buffer),
      }),
    ]);
  });

  it("resolves a facts-changed record by keeping the exact current cloud file", async () => {
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      local: { "note.md": "local" },
      remote: { "note.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(harness.localBytes.get("note.md")!)).toBe("cloud");
  });

  it("localizes the cloud version through the host write surface and settles the record", async () => {
    // F12 余项②：手动恢复下载链把云端内容「本地化」进库时必须走「复制留底 + 宿主写入面
    // 原地写」，而不是原子改名交换——从真实入口 `resolveMutationRecovery` 打到结局。
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const remoteBytes = encoder.encode("cloud\n");
    const hostWriteLog: string[] = [];
    const notice = makeNoticeRecorder();
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      local: { "note.md": "local\n" },
      remote: { "note.md": "cloud\n" },
      hostWriteLog,
      noticeCenter: notice.center,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(true);

    // 落地走宿主写入面（一次、内容正确）。假体的宿主写入面经 adapter.writeBinary 落盘，
    // 与生产通道不可在此接缝区分；可分辨的合同＝hostWriteLog 一次正确＋无改名交换。
    expect(hostWriteLog).toEqual(["cloud\n"]);
    expect(decoder.decode(harness.localBytes.get("note.md")!)).toBe("cloud\n");
    // 原地写：除留底日志自身的簿记动作外没有任何改名，也没有 `.easy-sync-recovery` 副本。
    const vaultRenames = vi.mocked(harness.adapter.rename).mock.calls
      .map(([from, to]) => `${from} -> ${to}`)
      .filter((entry) => !entry.split(" -> ")[1].startsWith(EASY_SYNC_TMP_DIR));
    expect(vaultRenames).toEqual([]);
    expect([...harness.localBytes.keys()].filter((path) =>
      path.endsWith(".easy-sync-recovery"))).toEqual([]);
    // 暂存文件与留底全部退休：插件 tmp 不留远端内容副本，也不留未完成事务。
    expect([...harness.localBytes.keys()].filter((path) =>
      path.startsWith(EASY_SYNC_TMP_DIR))).toEqual([]);
    // 记账＝写入落地即成功：记录销账，基线记云端版本本身（hash/size/eTag 自洽）。
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toEqual([expect.objectContaining({
      path: "note.md",
      hash: await sha256Hex(remoteBytes.buffer),
      size: remoteBytes.byteLength,
      eTag: "etag-1",
    })]);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(notice.center.activeKey)
      .toBe(`side-action:notice.mutationResolution.completed:note.md`);
    notice.center.dispose();
  });

  it("counts a host merge of unsaved text as landed and keeps the remote version as the base", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const remoteBytes = encoder.encode("cloud\n");
    const hostWriteLog: string[] = [];
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      local: { "note.md": "local\n" },
      remote: { "note.md": "cloud\n" },
      hostEditorMerge: "unsaved\n",
      hostWriteLog,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(true);

    // 宿主把未保存的行合并到我们写入的内容之后：写入已落地，这一轮记成功、记录销账，
    // 用户的字留在磁盘上。
    expect(hostWriteLog).toEqual(["cloud\n"]);
    expect(decoder.decode(harness.localBytes.get("note.md")!)).toBe("cloud\nunsaved\n");
    expect(harness.state.mutationLedger).toEqual([]);
    // 基线记云端版本本身，不是磁盘上的合并结果；合并结果属于「本机改动」，
    // 留给下一轮按普通本机改动上传（`DECISIONS` 2026-09-23 第 9 点②）。
    expect(harness.state.baseSnapshot).toEqual([expect.objectContaining({
      path: "note.md",
      hash: await sha256Hex(remoteBytes.buffer),
      size: remoteBytes.byteLength,
    })]);
    expect(harness.uploadFile).not.toHaveBeenCalled();
  });

  it("keeps the record and reports an honest reason when the host write never lands", async () => {
    const decoder = new TextDecoder();
    const hostWriteLog: string[] = [];
    const notice = makeNoticeRecorder();
    const zh = new I18n("zh-cn");
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      local: { "note.md": "local\n" },
      remote: { "note.md": "cloud\n" },
      hostWriteSilent: true,
      hostWriteLog,
      i18n: zh,
      noticeCenter: notice.center,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(false);

    // 同轮有界重试（桌面预算 2 次）后如实放弃：本机一字未动，留底与暂存全部退休。
    expect(hostWriteLog).toEqual(["cloud\n", "cloud\n"]);
    expect(decoder.decode(harness.localBytes.get("note.md")!)).toBe("local\n");
    expect([...harness.localBytes.keys()].filter((path) =>
      path.startsWith(EASY_SYNC_TMP_DIR))).toEqual([]);
    // 记录保留待重审：未落收据、未销账。
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ choice: "keep-remote", receipt: null });
    // 用户看到的原因是本地化的「未能写入本机文件，本次未作更改」（逐字钉住定稿文案），
    // 不是英文内部串，也不是「状态已变化」——那两句都会把没落地误说成用户的锅。
    expect(notice.center.activeKey).toBe(`side-action:notice.conflict.failed:note.md`);
    expect(notice.messages.some((line) =>
      line.includes("未能写入本机文件，本次未作更改。请查看最新版本后重新选择。"))).toBe(true);
    expect(notice.messages.some((line) => line.includes("Local replacement did not land")))
      .toBe(false);
    expect(notice.messages.some((line) =>
      line.includes(zh.t("notice.mutationResolution.changed")))).toBe(false);
    expect(notice.messages).toHaveLength(1);
    notice.center.dispose();
  });

  it("supports both explicit deletion directions without guessing from absence", async () => {
    const deleteRemote = await makeManualResolutionHarness({
      path: "remote-only.md",
      remote: { "remote-only.md": "cloud" },
    });
    const remoteReview = await deleteRemote.executor
      .getMutationRecoveryResolutionSnapshot();
    expect(remoteReview?.keepLocal).toEqual({
      available: true,
      deletesOtherSide: true,
    });
    expect(await deleteRemote.executor.resolveMutationRecovery(
      remoteReview!,
      "keep-local",
    )).toBe(true);
    expect(deleteRemote.remoteFiles.has("remote-only.md")).toBe(false);
    expect(deleteRemote.deleteItem).toHaveBeenCalledOnce();

    const deleteLocal = await makeManualResolutionHarness({
      path: "local-only.md",
      local: { "local-only.md": "local" },
    });
    const localReview = await deleteLocal.executor
      .getMutationRecoveryResolutionSnapshot();
    expect(localReview?.keepRemote).toEqual({
      available: true,
      deletesOtherSide: true,
    });
    expect(await deleteLocal.executor.resolveMutationRecovery(
      localReview!,
      "keep-remote",
    )).toBe(true);
    expect(deleteLocal.localBytes.has("local-only.md")).toBe(false);
    expect(deleteLocal.adapter.remove).toHaveBeenCalledWith("local-only.md");
  });

  it("records the redundant cloud copy removed by keep-local in the device-local deletion ledger", async () => {
    const harness = await makeManualResolutionHarness({
      path: "remote-only.md",
      remote: { "remote-only.md": "cloud" },
      remoteOnlyConflictPaths: ["remote-only.md"],
      withLedger: false,
    });

    await harness.executor.resolveConflictKeepLocal("remote-only.md");

    // 「保留本机」在只有云端一份多余的现场＝删掉那份云端副本；删除落地后立刻
    // 记一条可恢复线索（文件版本找回刀一之二）。
    expect(harness.deleteItem).toHaveBeenCalledOnce();
    expect(harness.remoteFiles.has("remote-only.md")).toBe(false);
    expect(harness.state.deletionLedgerEntries).toEqual([
      {
        remoteId: "remote-remote-only.md",
        path: "remote-only.md",
        deletedAt: expect.any(Number),
        kind: "file",
      },
    ]);
  });

  it("turns strict identical facts into a state-only checkpoint", async () => {
    const harness = await makeManualResolutionHarness({
      path: "same.md",
      local: { "same.md": "same" },
      remote: { "same.md": "same" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed?.identical).toBe(true);
    const resolved = await harness.executor.resolveMutationRecovery(
      reviewed!,
      "keep-local",
    );
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.adapter.rename).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("turns a converged sourcePath rename into a state-only checkpoint", async () => {
    const harness = await makeManualResolutionHarness({
      path: "new.md",
      sourcePath: "old.md",
      local: { "new.md": "same" },
      remote: { "new.md": "same" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed?.identical).toBe(true);
    expect(reviewed?.keepLocal.available).toBe(false);
    expect(reviewed?.keepRemote.available).toBe(false);
    await harness.executor.resolveMutationRecovery(reviewed!, "keep-local");
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.adapter.rename).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);

    // The built state-only resolution must carry the source path so the real
    // attach validator (isManualMutationResolution path-set equality) accepts
    // it, and its checkpoint must retire the source from both snapshots.
    const attach = vi.mocked(harness.state.attachManualMutationResolution);
    expect(attach).toHaveBeenCalledTimes(1);
    const resolution = attach.mock.calls[0][1] as ManualMutationResolutionV1;
    expect(resolution.externalMutation).toBe(false);
    expect(resolution.intent).toMatchObject({
      action: "upload",
      path: "new.md",
      sourcePath: "old.md",
    });
    expect(resolution.receipt?.checkpoint.baseRemovals).toEqual(["old.md"]);
    expect(resolution.receipt?.checkpoint.remoteDeletes).toEqual(["old.md"]);
  });

  it("performs zero writes when facts change after the user review", async () => {
    const harness = await makeManualResolutionHarness({
      path: "changed.md",
      local: { "changed.md": "local" },
      remote: { "changed.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.localBytes.set(
      "changed.md",
      new TextEncoder().encode("newer local").buffer,
    );

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.attachManualMutationResolution).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);

    const remoteChanged = await makeManualResolutionHarness({
      path: "remote-changed.md",
      local: { "remote-changed.md": "local" },
      remote: { "remote-changed.md": "cloud" },
    });
    const remoteReview = await remoteChanged.executor
      .getMutationRecoveryResolutionSnapshot();
    const current = remoteChanged.remoteFiles.get("remote-changed.md")!;
    remoteChanged.remoteFiles.set("remote-changed.md", {
      entry: { ...current.entry, eTag: "etag-newer" },
      bytes: new TextEncoder().encode("newer cloud").buffer,
    });
    expect(await remoteChanged.executor.resolveMutationRecovery(
      remoteReview!,
      "keep-local",
    )).toBe(false);
    expect(remoteChanged.uploadFile).not.toHaveBeenCalled();
    expect(remoteChanged.state.attachManualMutationResolution)
      .not.toHaveBeenCalled();
  });

  it("does not bypass managed-config or community-plugin ownership boundaries", async () => {
    const managedConfig = await makeManualResolutionHarness({
      path: ".obsidian/app.json",
      local: { ".obsidian/app.json": "{}" },
      remote: { ".obsidian/app.json": "{\"x\":1}" },
    });
    expect(await managedConfig.executor.getMutationRecoveryResolutionSnapshot())
      .toBeNull();

    const pluginFile = await makeManualResolutionHarness({
      path: ".obsidian/plugins/example/main.js",
      expectedLocalAtIntent: true,
      local: { ".obsidian/plugins/example/main.js": "local" },
      remote: { ".obsidian/plugins/example/main.js": "cloud" },
    });
    expect(await pluginFile.executor.getMutationRecoveryResolutionSnapshot())
      .toMatchObject({
        bundleReview: {
          pluginId: "example",
          local: { available: false, reason: "bundle-incomplete" },
          remote: { available: false, reason: "bundle-incomplete" },
          executionReady: false,
        },
        keepLocal: { available: false },
        keepRemote: { available: false },
      });
    expect(pluginFile.uploadFile).not.toHaveBeenCalled();

    const pluginDataUpload = await makeManualResolutionHarness({
      path: ".obsidian/plugins/example/data.json",
      local: { ".obsidian/plugins/example/data.json": "local" },
      remote: { ".obsidian/plugins/example/data.json": "cloud" },
    });
    expect(await pluginDataUpload.executor.getMutationRecoveryResolutionSnapshot())
      .toBeNull();
    expect(pluginDataUpload.uploadFile).not.toHaveBeenCalled();

    for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
      const path = `.obsidian/plugins/easy-sync/${fileName}`;
      const selfSyncFile = await makeManualResolutionHarness({
        path,
        local: { [path]: "local" },
        remote: { [path]: "cloud" },
      });
      expect(await selfSyncFile.executor.getMutationRecoveryResolutionSnapshot())
        .toBeNull();
      expect(selfSyncFile.uploadFile).not.toHaveBeenCalled();
    }

    const customConfig = await makeManualResolutionHarness({
      configDir: ".config",
      path: ".config/app.json",
      local: { ".config/app.json": "{}" },
      remote: { ".config/app.json": "{\"x\":1}" },
    });
    expect(await customConfig.executor.getMutationRecoveryResolutionSnapshot())
      .toBeNull();
    expect(customConfig.uploadFile).not.toHaveBeenCalled();
  });

  it("replaces one reviewed plugin bundle from the cloud and retires its older evidence together", async () => {
    const root = ".obsidian/plugins/resojot";
    const path = `${root}/main.js`;
    const localManifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "0.9.13",
      minAppVersion: "1.0.0",
    });
    const remoteManifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "0.9.12",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path,
      expectedLocalAtIntent: true,
      pendingConflictPaths: [
        `${root}/manifest.json`,
      ],
      local: {
        [path]: "current local plugin code",
        [`${root}/manifest.json`]: localManifest,
        [`${root}/styles.css`]: "current local styles",
      },
      remote: {
        [path]: "older remote plugin code",
        [`${root}/manifest.json`]: remoteManifest,
      },
    });

    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed).toMatchObject({
      path,
      previousAction: "upload",
      bundleReview: {
        kind: "community-plugin-bundle",
        pluginId: "resojot",
        displayName: "Resojot",
        memberPaths: [
          `${root}/main.js`,
          `${root}/manifest.json`,
          `${root}/styles.css`,
        ],
        conflictPaths: [
          `${root}/manifest.json`,
        ],
        predecessorOperationIds: ["blocked-operation"],
        executionReady: true,
        executableChoices: ["keep-local", "keep-remote"],
      },
      local: [
        expect.objectContaining({ path: `${root}/main.js`, exists: true }),
        expect.objectContaining({ path: `${root}/manifest.json`, exists: true }),
        expect.objectContaining({ path: `${root}/styles.css`, exists: true }),
      ],
      remote: [
        expect.objectContaining({ path: `${root}/main.js`, exists: true }),
        expect.objectContaining({ path: `${root}/manifest.json`, exists: true }),
        expect.objectContaining({ path: `${root}/styles.css`, exists: false }),
      ],
      keepLocal: { available: true, deletesOtherSide: false },
      keepRemote: { available: true, deletesOtherSide: true },
    });
    expect(reviewed?.bundlePresentation).toEqual({
      version: 1,
      localVersion: "0.9.13",
      remoteVersion: "0.9.12",
      files: [
        {
          path: `${root}/main.js`,
          localMtime: 1,
          remoteMtime: 1,
        },
        {
          path: `${root}/manifest.json`,
          localMtime: 1,
          remoteMtime: 1,
        },
        {
          path: `${root}/styles.css`,
          localMtime: 1,
        },
      ],
    });
    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(true);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.moveItemById).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingConflicts).toEqual([]);
    expect(new TextDecoder().decode(harness.localBytes.get(path)!))
      .toBe("older remote plugin code");
    expect(new TextDecoder().decode(
      harness.localBytes.get(`${root}/manifest.json`)! as ArrayBuffer,
    )).toBe(remoteManifest);
    expect(harness.localBytes.has(`${root}/styles.css`)).toBe(false);
    expect(new TextDecoder().decode(harness.remoteFiles.get(path)!.bytes))
      .toBe("older remote plugin code");
    expect(new TextDecoder().decode(
      harness.remoteFiles.get(`${root}/manifest.json`)!.bytes,
    )).toBe(remoteManifest);
  });

  it("skips downloads for identical bundle members and downloads only a differing hashless member", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    // main.js and manifest.json are byte-identical on both sides; only
    // styles.css differs (and its remote side has no SHA-256).
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: [paths[0]],
      local: {
        [paths[0]]: "same code",
        [paths[1]]: manifest,
        [paths[2]]: "local styles",
      },
      remote: {
        [paths[0]]: "same code",
        [paths[1]]: manifest,
        [paths[2]]: "remote styles",
      },
    });
    // Remove the remote hash for styles.css so equality must be decided by
    // downloading it (the only member that genuinely differs).
    const styles = harness.remoteFiles.get(paths[2])!;
    harness.remoteFiles.set(paths[2], {
      ...styles,
      entry: { ...styles.entry, sha256Hash: undefined },
    });

    const reviewed = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");

    expect(reviewed?.bundleReview?.pluginId).toBe("resojot");
    // Identical members (main.js, manifest.json) are proven equal from
    // metadata alone and never downloaded; the differing hashless styles.css
    // is downloaded exactly once to establish its hash.
    expect(harness.downloadFile).toHaveBeenCalledTimes(1);
    const downloadedPath = harness.downloadFile.mock.calls[0]?.[1];
    expect(downloadedPath).toBe(paths[2]);
    // The manifest version is still available without downloading the remote
    // manifest (reused from the local parse when the bytes match).
    expect(reviewed?.bundlePresentation?.localVersion).toBe("1.0.1");
    expect(reviewed?.bundlePresentation?.remoteVersion).toBe("1.0.1");
  });

  it("reuses snapshot-downloaded bytes for the sub-diff without a second download (P3)", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: [paths[0]],
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest,
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest,
        [paths[2]]: "old remote styles",
      },
    });
    // main.js remote has no SHA-256 hash: the snapshot build downloads it once
    // to establish equality evidence; those bytes must then be reused by the
    // sub-diff (查看差异) instead of a second download.
    const main = harness.remoteFiles.get(paths[0])!;
    harness.remoteFiles.set(paths[0], {
      ...main,
      entry: { ...main.entry, sha256Hash: undefined },
    });

    const reviewed = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(reviewed?.bundleReview?.pluginId).toBe("resojot");
    const downloadsAfterReview = harness.downloadFile.mock.calls.length;
    expect(downloadsAfterReview).toBeGreaterThanOrEqual(1);

    const diff = await harness.executor
      .getCommunityPluginBundleFileDiff("resojot", paths[0]);
    expect(diff).not.toBeNull();
    expect(diff?.remoteText).toBe("old remote code");
    // Zero additional remote transfers: the snapshot bytes cache served the
    // sub-diff.
    expect(harness.downloadFile.mock.calls.length).toBe(downloadsAfterReview);
  });

  it("reopening the review returns the cached snapshot without new downloads (P5)", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: [paths[0]],
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest,
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest,
        [paths[2]]: "old remote styles",
      },
    });

    const first = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(first).not.toBeNull();
    const downloadsAfterFirst = harness.downloadFile.mock.calls.length;

    // Reopen: cached snapshot returned (same digest), no new downloads even
    // after the single-flight background refresh settles (every member here
    // carries a remote SHA-256, so the background rebuild needs no content
    // transfer either).
    const second = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(second).not.toBeNull();
    expect(second?.factsDigest).toBe(first?.factsDigest);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.downloadFile.mock.calls.length).toBe(downloadsAfterFirst);
  });

  it("regression: reopening takes the P5 cache-hit path (one build, one background refresh) — 2026-09-08", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: [paths[0]],
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest,
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest,
        [paths[2]]: "old remote styles",
      },
    });
    // The factsIdentity wrapper is freshly allocated per call, so the old
    // whole-tuple equality never hit: every reopen rebuilt the snapshot (and
    // re-downloaded hashless members) instead of returning the cache. With the
    // fix (compare the underlying ledger/pending array references) the reopen
    // must take the hit path: exactly one snapshot build and exactly one
    // scheduled background refresh, with zero extra synchronous work.
    const executorProxy = harness.executor as unknown as {
      refreshBundleReviewSnapshotInBackground: (pluginId: string) => void;
      buildAndCacheBundleReviewSnapshot: (pluginId: string) => Promise<unknown>;
    };
    const refreshSpy = vi.spyOn(
      executorProxy,
      "refreshBundleReviewSnapshotInBackground",
    );
    const buildSpy = vi.spyOn(executorProxy, "buildAndCacheBundleReviewSnapshot");
    try {
      const first = await harness.executor
        .getCommunityPluginBundleReviewSnapshot("resojot");
      expect(first).not.toBeNull();
      expect(buildSpy).toHaveBeenCalledTimes(1);

      const second = await harness.executor
        .getCommunityPluginBundleReviewSnapshot("resojot");
      expect(second).not.toBeNull();
      expect(second?.factsDigest).toBe(first?.factsDigest);
      // Hit path schedules exactly one background refresh. Under the old
      // whole-tuple equality the reopen missed and rebuilt inline instead:
      // refresh would never be scheduled (0 calls) and the rebuild would not
      // be attributable to a refresh.
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(buildSpy).toHaveBeenCalledTimes(2); // 1 inline + 1 background refresh
      // The refresh is fire-and-forget: the reopened snapshot came from the
      // cache, not from the second build.
      expect(second).toBe(first);
    } finally {
      refreshSpy.mockRestore();
      buildSpy.mockRestore();
    }
  });

  // ---- Adversarial cache tests (review of the P2/P3/P5 秒级 work, 2026-09-07) ----
  // Each test attacks one correctness property of the session caches: stale
  // remote identity, shared single-flight across plugins, LRU bounds, and the
  // display-only (never facts-authorizing) boundary of the bytes cache.

  it("adversarial: rejects a cached sub-diff whose remote was rewritten (driveId/eTag) and re-downloads", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: [paths[0]],
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest,
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest,
        [paths[2]]: "old remote styles",
      },
    });
    // Hashless remote main.js: the snapshot build downloads it once and stages
    // the bytes under the current driveId/eTag identity.
    const main = harness.remoteFiles.get(paths[0])!;
    harness.remoteFiles.set(paths[0], {
      ...main,
      entry: { ...main.entry, sha256Hash: undefined },
    });
    const reviewed = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(reviewed?.bundleReview?.pluginId).toBe("resojot");
    expect(harness.downloadFile).toHaveBeenCalledTimes(1);

    // The remote is rewritten in place (same path, new identity + content).
    harness.remoteFiles.set(paths[0], {
      entry: {
        ...main.entry,
        driveId: "remote-rewritten",
        eTag: "etag-rewritten",
        sha256Hash: undefined,
        size: "newer remote code".length,
      },
      bytes: new TextEncoder().encode("newer remote code").buffer,
    });

    const diff = await harness.executor
      .getCommunityPluginBundleFileDiff("resojot", paths[0]);
    expect(diff).not.toBeNull();
    // The stale cached bytes must NOT be served: the diff re-downloads the
    // rewritten remote and shows its new content.
    expect(diff?.remoteText).toBe("newer remote code");
    expect(harness.downloadFile.mock.calls.length).toBe(2);
  });

  it("adversarial: a remote deleted after review makes the sub-diff report unavailability instead of stale content", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: [paths[0]],
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest,
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest,
        [paths[2]]: "old remote styles",
      },
    });
    const main = harness.remoteFiles.get(paths[0])!;
    harness.remoteFiles.set(paths[0], {
      ...main,
      entry: { ...main.entry, sha256Hash: undefined },
    });
    const reviewed = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(reviewed?.bundleReview?.pluginId).toBe("resojot");

    // Remote member disappears entirely after the review.
    harness.remoteFiles.delete(paths[0]);

    const diff = await harness.executor
      .getCommunityPluginBundleFileDiff("resojot", paths[0]);
    // Null → unavailable, never a stale display of reviewed content.
    expect(diff).toBeNull();
  });

  it("adversarial: build in flight for one plugin does not serve another plugin's snapshot (single-flight is per-plugin)", async () => {
    const rootA = ".obsidian/plugins/resojot";
    const rootB = ".obsidian/plugins/otherplugin";
    const manifestA = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const manifestB = JSON.stringify({
      id: "otherplugin",
      name: "Other",
      version: "2.0.0",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: `${rootA}/main.js`,
      expectedLocalAtIntent: true,
      withLedger: false,
      pendingConflictPaths: [`${rootA}/main.js`, `${rootB}/main.js`],
      local: {
        [`${rootA}/main.js`]: "local A",
        [`${rootA}/manifest.json`]: manifestA,
        [`${rootA}/styles.css`]: "local styles A",
        [`${rootB}/main.js`]: "local B",
        [`${rootB}/manifest.json`]: manifestB,
        [`${rootB}/styles.css`]: "local styles B",
      },
      remote: {
        [`${rootA}/main.js`]: "remote A",
        [`${rootA}/manifest.json`]: manifestA,
        [`${rootA}/styles.css`]: "remote styles A",
        [`${rootB}/main.js`]: "remote B",
        [`${rootB}/manifest.json`]: manifestB,
        [`${rootB}/styles.css`]: "remote styles B",
      },
    });

    // Start plugin A's build (a real remote round trip) and, while it is in
    // flight, open plugin B. B must build its own snapshot — it must never be
    // served A's in-flight result through the shared single-flight slot.
    const firstA = harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    const firstB = harness.executor
      .getCommunityPluginBundleReviewSnapshot("otherplugin");

    const [aSnapshot, bSnapshot] = await Promise.all([firstA, firstB]);
    expect(aSnapshot?.bundleReview?.pluginId).toBe("resojot");
    expect(bSnapshot?.bundleReview?.pluginId).toBe("otherplugin");

    // Both plugins were actually opened: their own conflict records are
    // present in the returned snapshot (a cross-plugin cache mix would leak
    // A's bundle into B's cache entry).
    const bLocal = bSnapshot?.local.find(
      (fact) => fact.path === `${rootB}/main.js`,
    );
    expect(bLocal?.exists).toBe(true);

    // Reopen both from the per-plugin caches: identities stay correct.
    const aAgain = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    const bAgain = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("otherplugin");
    expect(aAgain?.bundleReview?.pluginId).toBe("resojot");
    expect(bAgain?.bundleReview?.pluginId).toBe("otherplugin");
    expect(aAgain?.factsDigest).toBe(aSnapshot?.factsDigest);
    expect(bAgain?.factsDigest).toBe(bSnapshot?.factsDigest);
  });

  it("adversarial: bytes cache LRU evicts the least-recently-used plugin and still serves the most-recent", () => {
    // The P3 bytes cache eviction contract is the whole point of the 16 MiB
    // LRU — oversized single members must be refused and, once the global cap
    // is crossed, whole plugin sets are evicted in LRU order (least recently
    // used first). The LRU bump on read must keep the most-recently-used
    // plugin alive.
    const cache = new BundleReviewBytesCache();
    const KiB = 1024;
    const MiB = KiB * 1024;
    const member = (pluginId: string, index: number, sizeMiB: number) => ({
      pluginId,
      path: `.obsidian/plugins/${pluginId}/member${index}.js`,
      hash: `${pluginId}-${index}-${"a".repeat(60)}`,
      bytes: new ArrayBuffer(sizeMiB * MiB),
    });
    // Plugin A: 3 members × 2 MiB = 6 MiB; Plugin B: 3 × 2 MiB = 6 MiB.
    const aMembers = [0, 1, 2].map((i) => member("alpha", i, 2));
    const bMembers = [0, 1, 2].map((i) => member("bravo", i, 2));
    for (const m of [...aMembers, ...bMembers]) {
      cache.set(m.pluginId, m.path, m.hash, m.bytes, 1);
    }
    expect(cache.totalBytes).toBe(12 * MiB);
    expect(cache.get("alpha", aMembers[2].path, aMembers[2].hash)).not.toBeNull();
    expect(cache.get("bravo", bMembers[2].path, bMembers[2].hash)).not.toBeNull();

    // LRU bump alpha by reading one of its members.
    expect(cache.get(
      "alpha",
      aMembers[0].path,
      aMembers[0].hash,
    )).not.toBeNull();

    // Plugin C pushes the global total past 16 MiB → the LRU plugin set
    // (bravo, untouched since insertion) must be evicted wholesale; alpha
    // (bumped) survives.
    const cMembers = [0, 1, 2].map((i) => member("charlie", i, 2));
    for (const m of cMembers) {
      cache.set(m.pluginId, m.path, m.hash, m.bytes, 1);
    }
    expect(cache.totalBytes).toBe(12 * MiB);
    expect(cache.get(
      "bravo",
      bMembers[1].path,
      bMembers[1].hash,
    )).toBeNull();
    expect(cache.get(
      "alpha",
      aMembers[1].path,
      aMembers[1].hash,
    )).not.toBeNull();
    expect(cache.get(
      "charlie",
      cMembers[0].path,
      cMembers[0].hash,
    )).not.toBeNull();
    expect(cache.get(
      "alpha",
      aMembers[0].path,
      aMembers[0].hash,
    )).not.toBeNull();

    // A single oversized member (over the 3 MiB per-member bound) is never
    // cached at all.
    const huge = member("delta", 0, 4);
    cache.set(huge.pluginId, huge.path, huge.hash, huge.bytes, 1);
    expect(cache.get("delta", huge.path, huge.hash)).toBeNull();
    expect(cache.totalBytes).toBe(12 * MiB);

    // Re-adding an existing path replaces its bytes (and re-counts the total)
    // instead of double counting.
    const replacement = member("alpha", 0, 1);
    cache.set(
      replacement.pluginId,
      replacement.path,
      replacement.hash,
      replacement.bytes,
      1,
    );
    expect(cache.totalBytes).toBe(11 * MiB);
  });

  it("adversarial: a P5 cached snapshot can never authorize a write once the remote changed (SC-07/15)", async () => {
    // The user opens a review (built + cached), the remote is then rewritten
    // by another device, and the user re-opens the review: the P5 cache
    // serves the last-open snapshot for display. Choosing keep-local from
    // that stale snapshot must NOT authorize an upload — the resolve chain
    // re-builds current facts and rejects on digest mismatch with zero writes.
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: paths,
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest,
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: JSON.stringify({
          id: "resojot",
          name: "Resojot",
          version: "1.0.0",
          minAppVersion: "1.0.0",
        }),
        [paths[2]]: "old remote styles",
      },
    });

    // First open: snapshot built and cached; keep-remote is available.
    const first = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(first?.bundleReview?.executableChoices)
      .toContain("keep-remote");

    // Reopen BEFORE the remote changes: the P5 cache serves the cached
    // snapshot instantly (same digest, no rebuild). The user holds this
    // (displayed) snapshot open while the remote changes underneath.
    const reopen = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(reopen?.factsDigest).toBe(first?.factsDigest);

    // Another device rewrites the whole remote bundle (new eTag + bytes).
    for (const path of paths) {
      const current = harness.remoteFiles.get(path)!;
      harness.remoteFiles.set(path, {
        entry: { ...current.entry, eTag: `etag-rewritten-${path}` },
        bytes: current.bytes,
      });
    }
    const mainJs = harness.remoteFiles.get(paths[0])!;
    harness.remoteFiles.set(paths[0], {
      entry: { ...mainJs.entry },
      bytes: new TextEncoder().encode("cloud rewrote everything").buffer,
    });

    // The user picks keep-remote from the stale (now outdated) cached
    // snapshot. The resolve chain re-checks current facts → digest mismatch
    // → zero writes, and the stale review is not attached.
    const resolved = await harness.executor.resolveMutationRecovery(
      reopen!,
      "keep-remote",
    );
    expect(resolved).toBe(false);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).not.toEqual([]);
    // The pending conflicts were not cleared by the stale choice.
    expect(harness.state.pendingConflicts.length).toBeGreaterThan(0);
  });

  it("publishes one reviewed local plugin bundle member by member and closes its older evidence", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const localManifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.1",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: paths,
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: localManifest,
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: JSON.stringify({
          id: "resojot",
          name: "Resojot",
          version: "1.0.0",
          minAppVersion: "1.0.0",
        }),
        [paths[2]]: "old remote styles",
      },
    });

    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed?.bundleReview?.executableChoices)
      .toEqual(["keep-local", "keep-remote"]);
    const resolved = await harness.executor.resolveMutationRecovery(
      reviewed!,
      "keep-local",
    );
    expect(harness.uploadFile).toHaveBeenCalledTimes(3);
    expect(harness.uploadFile.mock.calls.map(([, path]) => path))
      .toEqual([paths[0], paths[2], paths[1]]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingConflicts).toEqual([]);
    for (const path of paths) {
      expect(new Uint8Array(harness.remoteFiles.get(path)!.bytes))
        .toEqual(new Uint8Array(harness.localBytes.get(path)!));
    }
    expect(resolved).toBe(true);
  });

  it("advances the visible file counter per bundle member while a reviewed plugin settlement runs", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = (version: string) => JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version,
      minAppVersion: "1.0.0",
    });
    const progressStore = new SyncProgressStore();
    progressStore.markStarted("sideAction");
    progressStore.setPhase("executing");
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: paths,
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest("1.0.1"),
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest("1.0.0"),
        [paths[2]]: "old remote styles",
      },
      progressStore,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    // keep-remote replaces each member one at a time; the top counter must
    // advance to 3/3 instead of staying at 1/1 for the whole bundle.
    const resolved = await harness.executor.resolveMutationRecovery(
      reviewed!,
      "keep-remote",
    );
    expect(resolved).toBe(true);
    expect(progressStore.state.current).toBe(3);
    expect(progressStore.state.total).toBe(3);
    expect(progressStore.state.phase).toBe("done");
    for (const path of paths) {
      expect(new Uint8Array(harness.localBytes.get(path)!))
        .toEqual(new Uint8Array(harness.remoteFiles.get(path)!.bytes));
    }
  });

  it("advances the visible file counter per member for a reviewed local plugin bundle publication", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = (version: string) => JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version,
      minAppVersion: "1.0.0",
    });
    const progressStore = new SyncProgressStore();
    progressStore.markStarted("sideAction");
    progressStore.setPhase("executing");
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: paths,
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest("1.0.1"),
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest("1.0.0"),
        [paths[2]]: "old remote styles",
      },
      progressStore,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    const resolved = await harness.executor.resolveMutationRecovery(
      reviewed!,
      "keep-local",
    );
    expect(resolved).toBe(true);
    expect(progressStore.state.current).toBe(3);
    expect(progressStore.state.total).toBe(3);
    expect(progressStore.state.phase).toBe("done");
  });

  it("removes a cloud-only optional plugin member when the reviewed local bundle is kept", async () => {
    const root = ".obsidian/plugins/resojot";
    const stylesPath = `${root}/styles.css`;
    const harness = await makeManualResolutionHarness({
      path: `${root}/main.js`,
      expectedLocalAtIntent: true,
      pendingConflictPaths: [`${root}/manifest.json`],
      local: {
        [`${root}/main.js`]: "new local code",
        [`${root}/manifest.json`]: JSON.stringify({
          id: "resojot",
          name: "Resojot",
          version: "1.0.1",
        }),
      },
      remote: {
        [`${root}/main.js`]: "old remote code",
        [`${root}/manifest.json`]: JSON.stringify({
          id: "resojot",
          name: "Resojot",
          version: "1.0.0",
        }),
        [stylesPath]: "obsolete remote styles",
      },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed?.keepLocal).toEqual({
      available: true,
      deletesOtherSide: true,
    });
    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.deleteItem).toHaveBeenCalledWith(
      "testVault",
      stylesPath,
      expect.any(String),
      expect.any(String),
    );
    expect(harness.remoteFiles.has(stylesPath)).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("keeps a reviewed plugin bundle at zero writes when cloud facts change", async () => {
    const root = ".obsidian/plugins/resojot";
    const path = `${root}/main.js`;
    const manifestPath = `${root}/manifest.json`;
    const manifest = (version: string) => JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version,
    });
    const harness = await makeManualResolutionHarness({
      path,
      expectedLocalAtIntent: true,
      local: {
        [path]: "local code",
        [manifestPath]: manifest("1.0.1"),
      },
      remote: {
        [path]: "remote code",
        [manifestPath]: manifest("1.0.0"),
      },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const remote = harness.remoteFiles.get(path)!;
    harness.remoteFiles.set(path, {
      entry: { ...remote.entry, eTag: "etag-after-review" },
      bytes: new TextEncoder().encode("newer remote code").buffer,
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(false);
    expect(harness.state.beginCommunityPluginBundleSettlement)
      .not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("resumes a persisted whole-plugin choice after local replacement but before receipts", async () => {
    const root = ".obsidian/plugins/resojot";
    const path = `${root}/main.js`;
    const manifestPath = `${root}/manifest.json`;
    const manifest = (version: string) => JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version,
    });
    const harness = await makeManualResolutionHarness({
      path,
      expectedLocalAtIntent: true,
      local: {
        [path]: "local code",
        [manifestPath]: manifest("1.0.1"),
      },
      remote: {
        [path]: "remote code",
        [manifestPath]: manifest("1.0.0"),
      },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    vi.mocked(harness.state.recordCommunityPluginBundleSettlementReceipts)
      .mockRejectedValueOnce(new Error("simulated close after local replacement"));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(false);
    expect(new TextDecoder().decode(harness.localBytes.get(path)!))
      .toBe("remote code");
    expect(harness.state.mutationLedger).toHaveLength(2);
    const writesAfterReplacement = vi.mocked(harness.adapter.writeBinary).mock.calls
      .filter(([target]) => target === path || target === manifestPath).length;

    await (harness.executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<unknown>;
    }).recoverMutationLedger({ ...TEST_SYNC_SCOPE, accountId: "account-id" });

    expect(harness.state.mutationLedger).toEqual([]);
    expect(vi.mocked(harness.adapter.writeBinary).mock.calls
      .filter(([target]) => target === path || target === manifestPath))
      .toHaveLength(writesAfterReplacement);
    await expect((harness.executor as unknown as {
      recoverMutationLedger(scope: SyncScope): Promise<unknown>;
    }).recoverMutationLedger({ ...TEST_SYNC_SCOPE, accountId: "account-id" }))
      .resolves.toBeNull();
  });

  it("resumes the same whole-plugin local choice after one member receipt is interrupted", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = (version: string) => JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version,
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      expectedLocalAtIntent: true,
      pendingConflictPaths: paths,
      local: {
        [paths[0]]: "new local code",
        [paths[1]]: manifest("1.0.1"),
        [paths[2]]: "new local styles",
      },
      remote: {
        [paths[0]]: "old remote code",
        [paths[1]]: manifest("1.0.0"),
        [paths[2]]: "old remote styles",
      },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const recordReceipts = vi.mocked(
      harness.state.recordCommunityPluginBundleSettlementReceipts,
    );
    const persistReceipt = recordReceipts.getMockImplementation();
    if (!persistReceipt) throw new Error("bundle receipt fixture is missing");
    recordReceipts
      .mockImplementationOnce(persistReceipt)
      .mockRejectedValueOnce(new Error("simulated close after second upload"));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile.mock.calls.map(([, path]) => path))
      .toEqual([paths[0], paths[2]]);
    const interrupted = harness.state.mutationLedger.find(
      (record) => record.manualResolution?.version === 2,
    );
    expect(interrupted?.manualResolution?.version === 2
      ? interrupted.manualResolution.members.filter((member) => member.receipt)
      : []).toHaveLength(1);

    const recovery = harness.executor as unknown as {
      lifecycle: { capture(): number };
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    };
    await recovery.recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      recovery.lifecycle.capture(),
    );

    expect(harness.uploadFile.mock.calls.map(([, path]) => path))
      .toEqual([paths[0], paths[2], paths[1]]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingConflicts).toEqual([]);
    for (const path of paths) {
      expect(new Uint8Array(harness.remoteFiles.get(path)!.bytes))
        .toEqual(new Uint8Array(harness.localBytes.get(path)!));
    }
  });

  it("settles ordinary conflicts for one selected plugin as one whole bundle", async () => {
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = (version: string) => JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version,
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      withLedger: false,
      pendingConflictPaths: paths,
      local: {
        [paths[0]]: "local code",
        [paths[1]]: manifest("1.0.1"),
        [paths[2]]: "local styles",
      },
      remote: {
        [paths[0]]: "remote code",
        [paths[1]]: manifest("1.0.0"),
        [paths[2]]: "remote styles",
      },
    });

    const reviewed = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");

    expect(reviewed).toMatchObject({
      previousAction: "merge",
      bundleReview: {
        kind: "community-plugin-bundle",
        pluginId: "resojot",
        displayName: "Resojot",
        conflictPaths: paths,
        predecessorOperationIds: [],
        local: { available: true },
        remote: { available: true },
        executionReady: true,
        executableChoices: ["keep-local", "keep-remote"],
      },
      keepLocal: { available: true },
      keepRemote: { available: true },
    });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();

    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "none", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    });
    expect(await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot"))
      .toBeNull();
    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingConflicts).toEqual([]);
    for (const path of paths) {
      expect(new Uint8Array(harness.localBytes.get(path)!))
        .toEqual(new Uint8Array(harness.remoteFiles.get(path)!.bytes));
    }
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
  });

  it("registers every bundle member as queued while a plugin settlement runs, then clears them (immediate row removal)", async () => {
    const waitUntil = async (assertion: () => void, attempts = 50): Promise<void> => {
      let lastError: unknown;
      for (let index = 0; index < attempts; index++) {
        try {
          assertion();
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      throw lastError;
    };
    const root = ".obsidian/plugins/resojot";
    const paths = [
      `${root}/main.js`,
      `${root}/manifest.json`,
      `${root}/styles.css`,
    ];
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.0",
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: paths[0],
      withLedger: false,
      pendingConflictPaths: paths,
      local: {
        [paths[0]]: "local code",
        [paths[1]]: manifest,
        [paths[2]]: "local styles",
      },
      remote: {
        [paths[0]]: "remote code",
        [paths[1]]: manifest,
        [paths[2]]: "remote styles",
      },
    });

    const reviewed = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");
    expect(reviewed?.bundleReview?.pluginId).toBe("resojot");

    // Hold the first settlement download open so we can observe the queue
    // while the side action is still in flight (the sidebar filters rows by
    // isSideActionQueued(member path), so members must be registered for the
    // plugin row to disappear immediately — the same contract as ordinary
    // file conflicts).
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    harness.downloadFile.mockImplementation(async (_vault: string, path: string) => {
      await downloadGate;
      const current = harness.remoteFiles.get(path);
      if (!current) throw new Error(`missing remote: ${path}`);
      return current.bytes.slice(0);
    });

    const settlement = harness.executor.resolveMutationRecovery(reviewed!, "keep-remote");
    await waitUntil(() => {
      expect(harness.downloadFile).toHaveBeenCalled();
    });
    for (const path of paths) {
      expect(harness.executor.isSideActionQueued(path)).toBe(true);
    }
    expect(harness.executor.isSideActionQueued(root)).toBe(true);

    releaseDownload();
    expect(await settlement).toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingConflicts).toEqual([]);
    for (const path of paths) {
      expect(harness.executor.isSideActionQueued(path)).toBe(false);
    }
  });

  it("offers the complete cloud bundle when an ordinary conflict starts from partial local files", async () => {
    const root = ".obsidian/plugins/resojot";
    const mainPath = `${root}/main.js`;
    const manifestPath = `${root}/manifest.json`;
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: mainPath,
      withLedger: false,
      pendingConflictPaths: [mainPath],
      local: { [mainPath]: "partial local code" },
      remote: {
        [mainPath]: "complete remote code",
        [manifestPath]: manifest,
      },
    });

    const reviewed = await harness.executor
      .getCommunityPluginBundleReviewSnapshot("resojot");

    expect(reviewed).toMatchObject({
      bundleReview: {
        pluginId: "resojot",
        conflictPaths: [mainPath],
        local: { available: false, reason: "bundle-incomplete" },
        remote: { available: true },
        executableChoices: ["keep-remote"],
      },
      keepLocal: { available: false },
      keepRemote: { available: true },
    });
    expect(await harness.executor.resolveMutationRecovery(
      reviewed!,
      "keep-remote",
    )).toBe(true);
    expect(new Uint8Array(harness.localBytes.get(manifestPath)!))
      .toEqual(new Uint8Array(harness.remoteFiles.get(manifestPath)!.bytes));
    expect(harness.uploadFile).not.toHaveBeenCalled();
  });

  it("keeps separate plugin-code recovery choices isolated by plugin", async () => {
    const firstRoot = ".obsidian/plugins/resojot";
    const secondRoot = ".obsidian/plugins/dataview";
    const firstPath = `${firstRoot}/main.js`;
    const secondPath = `${secondRoot}/main.js`;
    const manifest = (id: string, name: string, version: string) => JSON.stringify({
      id,
      name,
      version,
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path: firstPath,
      expectedLocalAtIntent: true,
      local: {
        [firstPath]: "current resojot code",
        [`${firstRoot}/manifest.json`]: manifest("resojot", "Resojot", "1.0.1"),
        [secondPath]: "current dataview code",
        [`${secondRoot}/manifest.json`]: manifest("dataview", "Dataview", "1.0.1"),
      },
      remote: {
        [firstPath]: "older resojot code",
        [`${firstRoot}/manifest.json`]: manifest("resojot", "Resojot", "1.0.0"),
        [secondPath]: "older dataview code",
        [`${secondRoot}/manifest.json`]: manifest("dataview", "Dataview", "1.0.0"),
      },
    });
    const secondBytes = harness.localBytes.get(secondPath)!;
    const firstEntry = harness.state.mutationLedger[0] as MutationLedgerEntryV1;
    (harness.state.mutationLedger as MutationLedgerEntryV1[]).push({
      intent: {
        ...firstEntry.intent,
        operationId: "blocked-operation-2",
        path: secondPath,
        expectedLocal: {
          exists: true,
          hash: await sha256Hex(secondBytes),
          size: secondBytes.byteLength,
        },
        createdAt: 2,
      },
      receipt: null,
    });

    const firstReview = await harness.executor.getMutationRecoveryResolutionSnapshot();
    expect(firstReview).toMatchObject({
      sourceOperationId: "blocked-operation",
      path: firstPath,
      bundleReview: {
        kind: "community-plugin-bundle",
        pluginId: "resojot",
        predecessorOperationIds: ["blocked-operation"],
        executionReady: true,
        executableChoices: ["keep-local", "keep-remote"],
      },
      keepLocal: { available: true },
      keepRemote: { available: true },
    });
    expect(await harness.executor.resolveMutationRecovery(firstReview!, "keep-remote"))
      .toBe(true);
    expect(harness.state.mutationLedger.map((entry) => entry.intent.operationId))
      .toEqual(["blocked-operation-2"]);
    expect(new Uint8Array(harness.localBytes.get(firstPath)!))
      .toEqual(new Uint8Array(harness.remoteFiles.get(firstPath)!.bytes));
    expect(new TextDecoder().decode(harness.localBytes.get(secondPath)!))
      .toBe("current dataview code");
    const secondReview = await harness.executor.getMutationRecoveryResolutionSnapshot(
      "blocked-operation-2",
    );
    expect(secondReview).toMatchObject({
      sourceOperationId: "blocked-operation-2",
      path: secondPath,
      bundleReview: {
        kind: "community-plugin-bundle",
        pluginId: "dataview",
        predecessorOperationIds: ["blocked-operation-2"],
        executionReady: true,
        executableChoices: ["keep-local", "keep-remote"],
      },
      keepLocal: { available: true },
      keepRemote: { available: true },
    });
    expect(await harness.executor.resolveMutationRecovery(secondReview!, "keep-remote"))
      .toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(new Uint8Array(harness.localBytes.get(secondPath)!))
      .toEqual(new Uint8Array(harness.remoteFiles.get(secondPath)!.bytes));
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
  });

  it("reviews an explicit older local plugin choice without applying the automatic downgrade rule", async () => {
    const root = ".obsidian/plugins/resojot";
    const path = `${root}/main.js`;
    const manifest = (version: string) => JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version,
      minAppVersion: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path,
      expectedLocalAtIntent: true,
      local: {
        [path]: "older local plugin code",
        [`${root}/manifest.json`]: manifest("0.9.12"),
      },
      remote: {
        [path]: "newer remote plugin code",
        [`${root}/manifest.json`]: manifest("0.9.13"),
      },
    });

    expect(await harness.executor.getMutationRecoveryResolutionSnapshot())
      .toMatchObject({
        bundleReview: {
          pluginId: "resojot",
          local: { available: true },
          remote: { available: true },
          executionReady: true,
          executableChoices: ["keep-local", "keep-remote"],
        },
        keepLocal: { available: true },
        keepRemote: { available: true },
      });
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("returns a stable bundle review when only the cloud bundle is complete", async () => {
    const root = ".obsidian/plugins/resojot";
    const path = `${root}/main.js`;
    const manifest = JSON.stringify({
      id: "resojot",
      name: "Resojot",
      version: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path,
      expectedLocalAtIntent: true,
      local: { [path]: "partial local code" },
      remote: {
        [path]: "complete remote code",
        [`${root}/manifest.json`]: manifest,
      },
    });

    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed).toMatchObject({
      bundleReview: {
        pluginId: "resojot",
        local: { available: false, reason: "bundle-incomplete" },
        remote: { available: true },
        executionReady: true,
        executableChoices: ["keep-remote"],
      },
      keepLocal: { available: false },
      keepRemote: { available: true },
    });
    expect(await harness.executor.getMutationRecoveryResolutionSnapshot())
      .toMatchObject({ factsDigest: reviewed?.factsDigest });
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("fails both bundle directions closed when manifest identities disagree", async () => {
    const root = ".obsidian/plugins/resojot";
    const path = `${root}/main.js`;
    const manifest = (id: string) => JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
    });
    const harness = await makeManualResolutionHarness({
      path,
      expectedLocalAtIntent: true,
      local: {
        [path]: "local code",
        [`${root}/manifest.json`]: manifest("resojot"),
      },
      remote: {
        [path]: "remote code",
        [`${root}/manifest.json`]: manifest("another-plugin"),
      },
    });

    expect(await harness.executor.getMutationRecoveryResolutionSnapshot())
      .toMatchObject({
        bundleReview: {
          pluginId: "resojot",
          local: { available: false, reason: "identity-mismatch" },
          remote: { available: false, reason: "identity-mismatch" },
          executionReady: false,
        },
        keepLocal: { available: false },
        keepRemote: { available: false },
      });
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("retires an intent-only plugin-code upload when its owner explicitly exits this device scope", async () => {
    const root = ".obsidian/plugins/resojot";
    const path = `${root}/main.js`;
    const harness = await makeManualResolutionHarness({
      path,
      expectedLocalAtIntent: true,
      local: {
        [path]: "older local plugin code",
        [`${root}/manifest.json`]: JSON.stringify({
          id: "resojot",
          name: "Resojot",
          version: "0.9.12",
        }),
      },
      remote: {
        [path]: "newer remote plugin code",
        [`${root}/manifest.json`]: JSON.stringify({
          id: "resojot",
          name: "Resojot",
          version: "0.9.13",
        }),
      },
    });
    const localBefore = new TextDecoder().decode(harness.localBytes.get(path)!);
    const remoteBefore = new TextDecoder().decode(harness.remoteFiles.get(path)!.bytes);

    await expect(
      harness.executor.retireSelectedPluginCodeUploadRecoveriesForScopeExit(
        (pluginId) => pluginId === "resojot",
      ),
    ).resolves.toBe(true);

    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.downloadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(harness.localBytes.get(path)!))
      .toBe(localBefore);
    expect(new TextDecoder().decode(harness.remoteFiles.get(path)!.bytes))
      .toBe(remoteBefore);
  });

  it("does not retire unrelated recovery during plugin scope exit", async () => {
    const harness = await makeManualResolutionHarness({
      path: "note.md",
      expectedLocalAtIntent: true,
      local: { "note.md": "local" },
      remote: { "note.md": "cloud" },
    });

    await expect(
      harness.executor.retireSelectedPluginCodeUploadRecoveriesForScopeExit(
        () => true,
      ),
    ).resolves.toBe(false);

    expect(harness.state.mutationLedger).toHaveLength(1);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.downloadFile).not.toHaveBeenCalled();
  });

  it("offers strict manual settlement for a persisted plugin-data download while data remains selected", async () => {
    const path = ".obsidian/plugins/sheet-plus/data.json";
    const harness = await makeManualResolutionHarness({
      action: "download",
      path,
      local: { [path]: "local-after-unknown-download" },
      remote: { [path]: "cloud" },
    });

    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed).toMatchObject({
      path,
      previousAction: "download",
      keepLocal: { available: true },
      keepRemote: { available: true },
    });
  });

  it("still settles only the persisted plugin-data download after data scope is disabled", async () => {
    const path = ".obsidian/plugins/sheet-plus/data.json";
    const harness = await makeManualResolutionHarness({
      action: "download",
      path,
      local: { [path]: "local-after-unknown-download" },
      remote: { [path]: "cloud" },
      localExcludedByCurrentScope: true,
      remoteExcludedByCurrentScope: true,
    });
    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "selected", pluginIds: ["sheet-plus"] },
      data: { mode: "none", pluginIds: [] },
    });

    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();

    expect(reviewed).toMatchObject({
      path,
      previousAction: "download",
      keepLocal: { available: true },
      keepRemote: { available: true },
    });
    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(true);
    expect(new TextDecoder().decode(harness.localBytes.get(path)!)).toBe("cloud");
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toEqual([]);
    expect(harness.state.remoteSnapshot).toEqual([]);
    expect(harness.inspectLocal).toHaveBeenCalledWith(
      path,
      { allowExcludedForRecovery: true },
    );
  });

  it("keeps an excluded plugin-data settlement outside ordinary V2 state", async () => {
    const path = ".obsidian/plugins/sheet-plus/data.json";
    const harness = await makeManualResolutionHarness({
      action: "download",
      path,
      local: { [path]: "local-after-unknown-download" },
      remote: { [path]: "cloud" },
      localExcludedByCurrentScope: true,
      remoteExcludedByCurrentScope: true,
    });
    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "selected", pluginIds: ["sheet-plus"] },
      data: { mode: "none", pluginIds: [] },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const originalRemote = structuredClone(harness.state.remoteSnapshot);

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(new TextDecoder().decode(harness.remoteFiles.get(path)!.bytes))
      .toBe("local-after-unknown-download");
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toEqual([]);
    expect(harness.state.remoteSnapshot).toEqual(originalRemote);
  });

  it("resumes an excluded plugin-data settlement after the write without repeating it", async () => {
    const path = ".obsidian/plugins/sheet-plus/data.json";
    const harness = await makeManualResolutionHarness({
      action: "download",
      path,
      local: { [path]: "local-after-unknown-download" },
      remote: { [path]: "cloud" },
      localExcludedByCurrentScope: true,
      remoteExcludedByCurrentScope: true,
    });
    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "selected", pluginIds: ["sheet-plus"] },
      data: { mode: "none", pluginIds: [] },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    vi.mocked(harness.state.recordManualMutationResolutionReceipt)
      .mockRejectedValueOnce(new Error("receipt persistence interrupted"));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-remote"))
      .toBe(false);
    expect(harness.downloadFile).toHaveBeenCalledOnce();

    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );

    expect(harness.downloadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toEqual([]);
  });

  it("cancels after the final reviewed inspection without starting a write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "cancel-before-write.md",
      local: { "cancel-before-write.md": "local" },
      remote: { "cancel-before-write.md": "cloud" },
    });
    const currentRemote = harness.remoteFiles.get("cancel-before-write.md")!.entry;
    const localBytes = harness.localBytes.get("cancel-before-write.md")!;
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "manual-cancel-before-write",
      planRevision: 1,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      action: "upload",
      path: "cancel-before-write.md",
      expectedLocal: {
        exists: true,
        hash: await sha256Hex(localBytes),
        size: localBytes.byteLength,
      },
      expectedRemote: {
        exists: true,
        driveId: currentRemote.driveId,
        eTag: currentRemote.eTag,
        size: currentRemote.size,
        sha256Hash: currentRemote.sha256Hash,
      },
      createdAt: 1,
    };
    const inspect = harness.inspectLocal.getMockImplementation()!;
    harness.inspectLocal.mockImplementationOnce(async (path: string) => {
      const current = await inspect(path);
      harness.executor.cancel();
      return current;
    });
    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();

    await expect((harness.executor as unknown as {
      executeManualMutationIntentWithCanonicalExecutor(
        intent: MutationIntentV1,
        operationEpoch: number,
      ): Promise<MutationCheckpointV1>;
    }).executeManualMutationIntentWithCanonicalExecutor(intent, epoch))
      .rejects.toThrow("cancelled");
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.deleteItem).not.toHaveBeenCalled();
    expect(harness.adapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.adapter.rename).not.toHaveBeenCalled();
  });

  it("resolves a pure move in either direction and a diverged move in two steps", async () => {
    const keepLocal = await makeManualResolutionHarness({
      sourcePath: "old.md",
      path: "new.md",
      local: { "new.md": "same" },
      remote: { "old.md": "same" },
    });
    const localReview = await keepLocal.executor.getMutationRecoveryResolutionSnapshot();
    expect(localReview?.keepLocal.available).toBe(true);
    expect(await keepLocal.executor.resolveMutationRecovery(localReview!, "keep-local"))
      .toBe(true);
    expect(keepLocal.remoteFiles.has("old.md")).toBe(false);
    expect(keepLocal.remoteFiles.has("new.md")).toBe(true);
    expect(keepLocal.moveItemById).toHaveBeenCalledOnce();

    const keepRemote = await makeManualResolutionHarness({
      sourcePath: "old.md",
      path: "new.md",
      local: { "old.md": "same" },
      remote: { "new.md": "same" },
    });
    const remoteReview = await keepRemote.executor.getMutationRecoveryResolutionSnapshot();
    expect(remoteReview?.keepRemote.available).toBe(true);
    expect(await keepRemote.executor.resolveMutationRecovery(remoteReview!, "keep-remote"))
      .toBe(true);
    expect(keepRemote.localBytes.has("old.md")).toBe(false);
    expect(keepRemote.localBytes.has("new.md")).toBe(true);

    const composite = await makeManualResolutionHarness({
      sourcePath: "old.md",
      path: "new.md",
      local: { "new.md": "local" },
      remote: { "old.md": "cloud" },
    });
    const compositeReview = await composite.executor
      .getMutationRecoveryResolutionSnapshot();
    // Content diverged: both directions are executable through the ordered
    // two-step settlement (create the winner on the losing side, then retire
    // the losing copy).
    expect(compositeReview?.keepLocal.available).toBe(true);
    expect(compositeReview?.keepRemote.available).toBe(true);
    expect(await composite.executor.resolveMutationRecovery(
      compositeReview!,
      "keep-remote",
    )).toBe(true);
    expect(new TextDecoder().decode(composite.localBytes.get("old.md"))).toBe("cloud");
    expect(composite.localBytes.has("new.md")).toBe(false);
    expect(composite.remoteFiles.has("old.md")).toBe(true);
    expect(composite.remoteFiles.has("new.md")).toBe(false);
    expect(composite.state.mutationLedger).toEqual([]);
  });

  it("recovers a receipted rename target-anchor collision by creating the reviewed local target", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });

    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    expect(reviewed).toMatchObject({
      previousAction: "renameRemote",
      sourcePath: "old.xmind",
      path: "new.xmind",
      keepLocal: { available: true, deletesOtherSide: false },
      keepRemote: { available: false, deletesOtherSide: false },
      recoveryEvidence: {
        kind: "receipted-rename-target-anchor-collision",
      },
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.moveItemById).not.toHaveBeenCalled();
    expect(harness.remoteFiles.has("old.xmind")).toBe(false);
    expect(harness.remoteFiles.get("new.xmind")?.entry.driveId).toBe("uploaded-new.xmind");
    expect(harness.state.baseSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("blocks a future remote rename before Graph when the target already owns another anchor", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const committedSource = harness.state.remoteSnapshot[0];
    const bytes = harness.localBytes.get("new.xmind")!;
    harness.remoteFiles.set("old.xmind", {
      entry: committedSource,
      bytes: bytes.slice(0),
    });
    const localHash = await sha256Hex(bytes);
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "preflight-collision",
      planRevision: 1,
      scope: { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      action: "renameRemote",
      path: "new.xmind",
      sourcePath: "old.xmind",
      expectedLocal: { exists: true, hash: localHash, size: bytes.byteLength },
      expectedRemote: {
        exists: true,
        driveId: committedSource.driveId,
        eTag: committedSource.eTag,
        size: committedSource.size,
        sha256Hash: committedSource.sha256Hash,
      },
      createdAt: 3,
    };
    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();

    await expect((harness.executor as unknown as {
      executeManualMutationIntentWithCanonicalExecutor(
        intent: MutationIntentV1,
        operationEpoch: number,
      ): Promise<MutationCheckpointV1>;
    }).executeManualMutationIntentWithCanonicalExecutor(intent, epoch))
      .rejects.toThrow("target is owned by another V2 anchor");
    expect(harness.moveItemById).not.toHaveBeenCalled();
    expect(harness.remoteFiles.has("old.xmind")).toBe(true);
    expect(harness.remoteFiles.has("new.xmind")).toBe(false);
  });

  it("does zero writes when a stale remote identity reappears after reviewing the collision", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const staleId = reviewed?.recoveryEvidence?.staleRemoteIds[0];
    expect(staleId).toBeTruthy();
    const bytes = new TextEncoder().encode("reappeared").buffer;
    harness.remoteFiles.set("elsewhere.xmind", {
      entry: {
        path: "elsewhere.xmind",
        driveId: staleId!,
        parentId: TEST_SYNC_SCOPE.filesRootId,
        size: bytes.byteLength,
        mtime: 3,
        eTag: "etag-reappeared",
        cTag: "ctag-reappeared",
        sha256Hash: await sha256Hex(bytes),
      },
      bytes,
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(1);
  });

  it("keeps the receipted collision blocked when a stale identity reappears after upload", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const staleId = reviewed!.recoveryEvidence!.staleRemoteIds[0];
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      const result = await upload(...args);
      const bytes = new TextEncoder().encode("reappeared-after-upload").buffer;
      harness.remoteFiles.set("elsewhere.xmind", {
        entry: {
          path: "elsewhere.xmind",
          driveId: staleId,
          parentId: TEST_SYNC_SCOPE.filesRootId,
          size: bytes.byteLength,
          mtime: 4,
          eTag: "etag-reappeared-after-upload",
          cTag: "ctag-reappeared-after-upload",
          sha256Hash: await sha256Hex(bytes),
        },
        bytes,
      });
      return result;
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: expect.objectContaining({ version: 1 }) });
    expect(harness.state.commitManualMutationResolutionCheckpoint)
      .not.toHaveBeenCalled();
  });

  it("recovers a lost upload response for the collision without repeating the write", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      await upload(...args);
      throw new Error("upload response lost");
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.baseSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("replays only the collision checkpoint after V2 publication survives ledger cleanup failure", async () => {
    const harness = await makeManualResolutionHarness({
      sourcePath: "old.xmind",
      path: "new.xmind",
      local: { "new.xmind": "binary-xmind" },
      receiptedRenameAnchorCollision: true,
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const commit = vi.mocked(harness.state.commitManualMutationResolutionCheckpoint)
      .getMockImplementation()!;
    vi.mocked(harness.state.commitManualMutationResolutionCheckpoint)
      .mockImplementationOnce(async (sourceOperationId: string) => {
        const retained = structuredClone(harness.state.mutationLedger[0]);
        await commit(sourceOperationId);
        (harness.state.mutationLedger as MutationLedgerEntryV1[]).push(retained);
        throw new Error("ledger cleanup interrupted");
      });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path)).toEqual(["new.xmind"]);

    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );

    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("recovers an upload response loss without repeating the remote write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "response-lost.md",
      local: { "response-lost.md": "local" },
      remote: { "response-lost.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      await upload(...args);
      throw new Error("upload response lost");
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(true);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(new TextDecoder().decode(harness.remoteFiles.get("response-lost.md")!.bytes))
      .toBe("local");
  });

  it("replays only the receipt after a crash window following the remote write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "receipt-crash.md",
      local: { "receipt-crash.md": "local" },
      remote: { "receipt-crash.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    vi.mocked(harness.state.recordManualMutationResolutionReceipt)
      .mockRejectedValueOnce(new Error("receipt persistence interrupted"));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: null });

    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );

    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("keeps a receipt and defers the checkpoint when cancellation lands after the write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "cancelled.md",
      local: { "cancelled.md": "local" },
      remote: { "cancelled.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    const upload = harness.uploadFile.getMockImplementation()!;
    harness.uploadFile.mockImplementationOnce(async (...args: unknown[]) => {
      const result = await upload(...args);
      harness.executor.cancel();
      return result;
    });

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: expect.objectContaining({ version: 1 }) });
    expect(harness.state.commitManualMutationResolutionCheckpoint)
      .not.toHaveBeenCalled();

    (harness.executor as unknown as { cancelled: boolean }).cancelled = false;
    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );
    expect(harness.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("retains the reviewed continuation when a network failure proves no write", async () => {
    const harness = await makeManualResolutionHarness({
      path: "offline.md",
      local: { "offline.md": "local" },
      remote: { "offline.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.uploadFile.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "offline",
    ));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({
        choice: "keep-local",
        externalMutation: true,
        receipt: null,
      });
    expect(new TextDecoder().decode(harness.remoteFiles.get("offline.md")!.bytes))
      .toBe("cloud");
  });

  it("keeps a reviewed overwrite blocked after a 412 instead of applying stale facts", async () => {
    const harness = await makeManualResolutionHarness({
      path: "raced.md",
      local: { "raced.md": "local" },
      remote: { "raced.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.uploadFile.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.PreconditionFailed,
      "etag changed",
      412,
    ));

    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.state.mutationLedger).toHaveLength(1);
    expect((harness.state.mutationLedger[0] as MutationLedgerEntryV1).manualResolution)
      .toMatchObject({ receipt: null });
    expect(new TextDecoder().decode(harness.remoteFiles.get("raced.md")!.bytes))
      .toBe("cloud");
  });

  it("resumes a durable reviewed continuation after the interrupted side action", async () => {
    const harness = await makeManualResolutionHarness({
      path: "resume.md",
      local: { "resume.md": "local" },
      remote: { "resume.md": "cloud" },
    });
    const reviewed = await harness.executor.getMutationRecoveryResolutionSnapshot();
    harness.uploadFile.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "offline",
    ));
    expect(await harness.executor.resolveMutationRecovery(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.state.mutationLedger).toHaveLength(1);

    const epoch = (harness.executor as unknown as {
      lifecycle: { capture(): number };
    }).lifecycle.capture();
    const summary = await (harness.executor as unknown as {
      recoverMutationLedger(
        scope: SyncScope,
        metrics: undefined,
        operationEpoch: number,
      ): Promise<unknown>;
    }).recoverMutationLedger(
      { ...TEST_SYNC_SCOPE, accountId: "account-id" },
      undefined,
      epoch,
    );

    expect(summary).toMatchObject({
      state: "settled",
      total: 1,
      settled: 1,
      remaining: 0,
    });
    expect(harness.uploadFile).toHaveBeenCalledTimes(2);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("isolates independent unresolved ordinary files while syncing an unrelated file", async () => {
    const expectedHash = "aa".repeat(32);
    const currentHash = "bb".repeat(32);
    const unrelatedBytes = new TextEncoder().encode("new note").buffer;
    const unrelatedHash = await sha256Hex(unrelatedBytes);
    const activeScope = {
      ...TEST_SYNC_SCOPE,
      accountId: "account-id",
    };
    const state = makeActiveV2State([], [], {
      mutationLedger: ["note-a.md", "note-b.md"].map((path, index) => ({
        intent: {
          version: 1 as const,
          operationId: `op-unresolved-${index}`,
          planRevision: 1,
          scope: activeScope,
          action: "upload" as const,
          path,
          expectedLocal: {
            exists: true as const,
            hash: expectedHash,
            size: 3,
          },
          expectedRemote: { exists: false as const },
          createdAt: 1,
        },
        receipt: null,
      })),
    });
    const local: LocalFileEntry = {
      path: "note-a.md",
      hash: currentHash,
      size: 3,
      mtime: 2,
      binary: false,
    };
    const secondLocal: LocalFileEntry = {
      ...local,
      path: "note-b.md",
    };
    const unrelated: LocalFileEntry = {
      path: "other.md",
      hash: unrelatedHash,
      size: unrelatedBytes.byteLength,
      mtime: 2,
      binary: false,
    };
    const uploadFile = vi.fn().mockResolvedValue({
      id: "other-id",
      eTag: "other-etag",
      parentReference: { id: activeScope.filesRootId },
    });
    const scanAll = vi.fn().mockResolvedValue({
      entries: [local, secondLocal, unrelated],
      folders: [],
      folderScanComplete: true,
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const executor = new SyncExecutor(
      makeMockOneDrive({
        uploadFile,
        getFileMetadata: vi.fn().mockImplementation(async (
          _vaultName: string,
          path: string,
        ) => ({
          path,
          driveId: "unexpected-id",
          size: 3,
          mtime: 1,
          eTag: "unexpected-etag",
        })),
      }),
      {
        vault: {
          adapter: makeMockAdapter({
            readBinary: vi.fn().mockImplementation(async (path: string) =>
              path === unrelated.path
                ? unrelatedBytes
                : new Uint8Array([1, 2, 3]).buffer),
          }),
          getFiles: vi.fn().mockReturnValue([]),
          getName: vi.fn().mockReturnValue("testVault"),
        },
        scanAll,
        inspectFile: vi.fn().mockImplementation(async (path: string) => ({
          status: "present",
          entry: path === secondLocal.path ? secondLocal : local,
        })),
        shouldSyncFolderPath: vi.fn().mockReturnValue(true),
      } as unknown as LocalScanner,
      state,
      "testVault",
      {
        t: (key: string, params?: Record<string, string | number>) =>
          key === "result.syncFailed"
            ? `failed:${params?.message}`
            : key,
      } as I18n,
    );

    const result = await executor.run("manual", {});

    expect(result.success).toBe(true);
    expect(scanAll).toHaveBeenCalledOnce();
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(uploadFile.mock.calls[0]?.[1]).toBe(unrelated.path);
    expect(state.mutationLedger.map((entry) => entry.intent.operationId)).toEqual([
      "op-unresolved-0",
      "op-unresolved-1",
    ]);
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      total: 2,
      settled: 0,
      remaining: 2,
      retryAfterSeconds: null,
      blockReason: "facts-changed",
      blockedOperationId: "op-unresolved-0",
      isolated: true,
    });
  });

});
