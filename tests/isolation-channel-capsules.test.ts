// S2 隔离通道（形状无关通用通道）——第三阻塞点 capsule 的准入与失败关闭
//
// 本刀把「隔离运行」从甲刀的单条通道推广为一般机制：通道本身与形状无关，
// 每条记录由 `isolation-capsules.ts` 里某一条 capsule 以**自己的最窄可证明
// 证据**担保（普通文件＝现役谓词；文件夹有界收据＝甲刀；第三阻塞点＝本刀
// 新增）。本文件承重两类事实：
//   ① 第三阻塞点（回执经两侧事实核验为真、提交被共同状态结构性拒绝）的
//      **创建类**记录——甲刀残余②「文件夹创建维持整库停摆」——现在走记录级
//      隔离：记录保留＋子树冻结＋其余路径照常同步＋自动同步继续；先红后绿
//      与反向变异见各用例注释。
//   ② 新通道不放宽任何失败关闭：无核验事实、效果面越界、带内容的文件记录，
//      一律维持整库响亮失败（SC-20 推论③与「逐形状最窄证据」的反向控制项）。
//
// 文件按《测试与检查规范》独立成件；夹具与甲刀 `folder-record-isolation-gate`
// 同形但自成一份（零触碰既有钉子文件）。

import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import { isolationCapsuleAdmits } from "../src/sync/isolation-capsules";
import type { IsolationAdmissionContext } from "../src/sync/isolation-capsules";
import { sha256Hex } from "../src/crypto";
import type { LocalScanner } from "../src/sync/local-scanner";
import type {
  LocalFileEntry,
  MutationLedgerEntryV1,
  SyncScope,
} from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
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

/** 第三阻塞点的创建形状（`createRemoteFolder`）：世界与回执都说「新文件夹
 *  已在 NewDir 落成、身份是 folder-new」，而共同状态在该路径上躺着另一个
 *  身份 ⇒ `reduceFolderStateEnvelopeV2` 结构性拒绝
 *  （`V2 folder upsert would replace another identity`）。 */
const makeCreateRemoteFolderRecord = (): MutationLedgerEntryV1 => ({
  intent: {
    version: 2,
    operationId: "op-folder-create-remote",
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
    operationId: "op-folder-create-remote",
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

/** 第三阻塞点的另一创建方向（`createLocalFolder`）：本机文件夹在云端已有
 *  身份（expectedRemote.exists），但共同状态的父路径对不上
 *  （`V2 folder parent path changed`）。 */
const makeCreateLocalFolderRecord = (): MutationLedgerEntryV1 => ({
  intent: {
    version: 2,
    operationId: "op-folder-create-local",
    planRevision: 1,
    scope: ACTIVE_SCOPE,
    action: "createLocalFolder",
    path: "Videos/New",
    folderId: "folder-new",
    expectedLocal: { exists: true },
    expectedRemote: {
      exists: true,
      driveId: "folder-new",
      parentId: "videos",
      eTag: "etag-new",
    },
    expectedParent: {
      driveId: "videos",
      path: "Videos",
      eTag: "etag-videos",
    },
    createdAt: 1,
  } as MutationLedgerEntryV1["intent"],
  receipt: {
    version: 1,
    operationId: "op-folder-create-local",
    completedAt: 2,
    checkpoint: {
      ...emptyCheckpoint(),
      folderUpserts: [{
        path: "Videos/New",
        driveId: "folder-new",
        parentId: "videos",
        name: "New",
        eTag: "etag-new",
      }],
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

/** One ordinary round in which the only refused commit is the given record's
 *  (the third blocking point), with verification stubbed to "the receipt
 *  matches the live two-sided facts" and the zero-write settlement
 *  unavailable — the exact evidence state the third capsule consumes. */
const makeThirdBlockingPointRound = (args: {
  record: MutationLedgerEntryV1;
  localEntries: LocalFileEntry[];
  contents: Map<string, ArrayBuffer>;
  refusalMessage?: string;
  verificationMatches?: boolean;
}) => {
  const state = makeActiveV2State([], [], {
    mutationLedger: [args.record],
  });
  const baseCommit = state.commitMutationCheckpoint;
  state.commitMutationCheckpoint = vi.fn(async (operationId: string) => {
    if (operationId === args.record.intent.operationId) {
      throw new Error(
        args.refusalMessage
          ?? `V2 folder upsert would replace another identity: ${args.record.intent.path}`,
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
  const executor = new SyncExecutor(
    makeMockOneDrive({
      uploadFile,
      getDriveItemMetadata: vi.fn().mockResolvedValue(null),
      getDelta: vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-isolation-channel",
      }),
    }),
    {
      vault: {
        adapter: makeMockAdapter({
          readBinary: vi.fn().mockImplementation(async (path: string) =>
            args.contents.get(path)),
        }),
        getFiles: vi.fn().mockReturnValue([]),
        getName: vi.fn().mockReturnValue("testVault"),
      },
      scanAll: vi.fn().mockResolvedValue({
        entries: args.localEntries,
        folders: [],
        folderScanComplete: true,
        skippedLarge: [],
        failedPaths: [],
        skippedCount: 0,
        complete: true,
      }),
      inspectFile: vi.fn().mockImplementation(async (path: string) => {
        const entry = args.localEntries.find((candidate) =>
          candidate.path === path);
        return entry ? { status: "present", entry } : { status: "missing" };
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
  seams.verifyMutationReceipt = vi.fn().mockResolvedValue(
    args.verificationMatches !== false,
  );
  const settleAsObserved = vi.fn().mockResolvedValue(false);
  seams.tryAutoSettleFolderMutationRecovery = settleAsObserved;
  seams.activeSyncScope = ACTIVE_SCOPE;
  const logs: Array<{ message: string; payload: Record<string, unknown> }> = [];
  const warnings: Array<{ message: string; payload: Record<string, unknown> }> = [];
  (executor as unknown as { diag: unknown }).diag = {
    log: (_scope: string, message: string, payload?: Record<string, unknown>) => {
      logs.push({ message, payload: payload ?? {} });
    },
    warn: (_scope: string, message: string, payload?: Record<string, unknown>) => {
      warnings.push({ message, payload: payload ?? {} });
    },
    error: () => undefined,
    isEnabled: () => false,
  };
  return { executor, state, uploadFile, settleAsObserved, logs, warnings };
};

const capsuleLog = (
  logs: Array<{ message: string; payload: Record<string, unknown> }>,
) => logs.find((entry) =>
  entry.message === "mutation recovery isolation capsules");

describe("S2 isolation channel: the third blocking point admits bounded folder creates", () => {

  // ---- 主钉子（先红后绿）------------------------------------------------
  //
  // createRemoteFolder＋回执核验为真＋共同状态结构性拒绝 ⇒ 记录保留＋整个
  // NewDir 子树冻结＋其余路径照常同步＋自动同步继续（`isolated: true` 正是
  // 暂停门的输入）。先红凭据＝把第三 capsule 从注册表移除（或去掉轮内事实）
  // 时，本轮恢复整库响亮失败：`success: false`、`errors: 1`、零上传。
  // 反向变异 M1＝删 capsule 条目 ⇒ 本条红；M2＝去掉轮内事实门 ⇒ 负例
  // 「未核验为真的创建」转红（那一轮会被隔离）。
  it("isolates a refused receipted folder create and keeps the rest of the vault syncing", async () => {
    const insideBytes = new TextEncoder().encode("inside new dir").buffer;
    const unrelatedBytes = new TextEncoder().encode("unrelated note").buffer;
    const { executor, state, uploadFile, logs, warnings } =
      makeThirdBlockingPointRound({
        record: makeCreateRemoteFolderRecord(),
        localEntries: [
          await scannedFile("NewDir/x.md", insideBytes),
          await scannedFile("other.md", unrelatedBytes),
        ],
        contents: new Map([
          ["NewDir/x.md", insideBytes],
          ["other.md", unrelatedBytes],
        ]),
      });

    const result: SyncResult = await executor.run("manual", {});

    // The record is isolated, not settled: it keeps its ledger entry and its
    // receipt, and the round states the isolation honestly.
    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      isolated: true,
      total: 1,
      settled: 0,
      remaining: 1,
      blockedOperationId: "op-folder-create-remote",
    });
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeDefined();
    // Nothing inside the frozen subtree reaches the network …
    for (const call of uploadFile.mock.calls) {
      expect(String(call[1])).not.toBe("NewDir/x.md");
    }
    // … while unrelated work is untouched by the freeze.
    expect(new Set(uploadFile.mock.calls.map((call) => String(call[1]))))
      .toEqual(new Set(["other.md"]));
    expect(warnings.some((entry) =>
      entry.message === "unresolved ordinary files were isolated from unrelated planning",
    )).toBe(true);
    // The capsule breakdown says which bounded evidence admitted it.
    expect(capsuleLog(logs)?.payload).toMatchObject({
      records: 1,
      capsules: { "folder-verified-refused-absorption": 1 },
    });

    // 一次结局：同一事实的第二轮由 S4 结出「不可重试诊断」——被隔离的记录
    // 不出现会在同一事实上反复失败的重试入口（复用 S4 判定，不新建第二套）。
    expect(executor.getSyncItemTerminationSnapshot()).toHaveLength(0);
    // The first round's unrelated upload is itself a content-fact change, so
    // the baseline settles here; the next round is the first identical one.
    await executor.run("manual", {});
    expect(executor.getSyncItemTerminationSnapshot()).toHaveLength(0);
    const second = await executor.run("manual", {});
    expect(second.mutationRecovery).toMatchObject({
      state: "blocked",
      isolated: true,
      blockedOperationId: "op-folder-create-remote",
    });
    expect(executor.getSyncItemTerminationSnapshot()).toEqual([
      expect.objectContaining({
        key: "ledger:op-folder-create-remote",
        outcome: "non-retryable",
      }),
    ]);
  });

  it("isolates a refused receipted local-folder create (parent path changed) the same way", async () => {
    const unrelatedBytes = new TextEncoder().encode("unrelated note").buffer;
    const { executor, uploadFile, logs } = makeThirdBlockingPointRound({
      record: makeCreateLocalFolderRecord(),
      localEntries: [await scannedFile("other.md", unrelatedBytes)],
      contents: new Map([["other.md", unrelatedBytes]]),
      refusalMessage: "V2 folder parent path changed: Videos/New",
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      isolated: true,
      blockedOperationId: "op-folder-create-local",
    });
    expect(new Set(uploadFile.mock.calls.map((call) => String(call[1]))))
      .toEqual(new Set(["other.md"]));
    expect(capsuleLog(logs)?.payload).toMatchObject({
      capsules: { "folder-verified-refused-absorption": 1 },
    });
  });

  // ---- 反向控制项（失败关闭，本刀刻意不放宽）----------------------------
  //
  // ① 没有轮内事实（回执从未与两侧事实核验为真）的创建记录：维持整库响亮
  //    失败、零隔离、零上传。反向变异 M2＝去掉轮内事实门 ⇒ 本条转红。
  it("refuses to isolate a folder create whose receipt was never verified against live facts", async () => {
    const unrelatedBytes = new TextEncoder().encode("unrelated note").buffer;
    const { executor, uploadFile, logs } = makeThirdBlockingPointRound({
      record: makeCreateRemoteFolderRecord(),
      localEntries: [await scannedFile("other.md", unrelatedBytes)],
      contents: new Map([["other.md", unrelatedBytes]]),
      verificationMatches: false,
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery?.isolated).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(capsuleLog(logs)).toBeUndefined();
  });

  // ② 效果面越出意图路径的创建收据（这里点名 Other/New）：同样维持整库
  //    响亮失败。反向变异 M3＝去掉效果路径/身份绑定校验 ⇒ 本条转红。
  it("refuses to isolate a folder create whose receipt effect left the intent path", async () => {
    const record = makeCreateRemoteFolderRecord();
    record.receipt = {
      ...record.receipt!,
      checkpoint: {
        ...record.receipt!.checkpoint,
        folderUpserts: [{
          path: "Other/NewDir",
          driveId: "folder-new",
          parentId: TEST_SYNC_SCOPE.filesRootId,
          name: "NewDir",
          eTag: "etag-new",
        }],
      },
    };
    const unrelatedBytes = new TextEncoder().encode("unrelated note").buffer;
    const { executor, uploadFile } = makeThirdBlockingPointRound({
      record,
      localEntries: [await scannedFile("other.md", unrelatedBytes)],
      contents: new Map([["other.md", unrelatedBytes]]),
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery?.isolated).toBeUndefined();
    expect(result.success).toBe(false);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  // ③ 带内容的文件记录：即使带着同一个轮内事实也进不了第三 capsule（通道
  //    逐形状最窄证据、不放宽 SC-20 推论③）。模块级判定直接钉住，避免把
  //    「文件记录另有通道」误读成「内容级意图可被隔离/退休」。
  it("never admits a content-carrying file record through the third capsule", () => {
    const upload: MutationLedgerEntryV1 = {
      intent: {
        version: 1,
        operationId: "op-upload",
        planRevision: 1,
        scope: ACTIVE_SCOPE,
        action: "upload",
        path: "note.md",
        expectedLocal: { exists: true, hash: "aa".repeat(32), size: 3 },
        expectedRemote: { exists: false },
        createdAt: 1,
      } as MutationLedgerEntryV1["intent"],
      receipt: {
        version: 1,
        operationId: "op-upload",
        completedAt: 2,
        checkpoint: {
          ...emptyCheckpoint(),
          baseUpserts: [{
            path: "note.md",
            hash: "aa".repeat(32),
            size: 3,
            eTag: "etag-note",
          }],
          remoteUpserts: [{
            path: "note.md",
            driveId: "remote-note",
            parentId: TEST_SYNC_SCOPE.filesRootId,
            size: 3,
            mtime: 1,
            eTag: "etag-note",
            sha256Hash: "aa".repeat(32),
          }],
        },
      },
    };
    const context: IsolationAdmissionContext = {
      record: upload,
      syncScope: ACTIVE_SCOPE,
      envelope: null,
      verifiedReceiptRefusedAbsorption: true,
    };

    expect(isolationCapsuleAdmits(context)).toBe(
      "ordinary-file-bounded-receipt",
    );
    // Without its own bounded file evidence the very same round fact admits
    // nothing: the third capsule only ever serves folder intents.
    const unbounded = structuredClone(upload);
    unbounded.receipt!.checkpoint.baseUpserts.push({
      path: "elsewhere.md",
      hash: "bb".repeat(32),
      size: 3,
      eTag: "etag-elsewhere",
    });
    expect(isolationCapsuleAdmits({
      ...context,
      record: unbounded,
    })).toBeNull();
  });

  // ---- 反向控制项③：既有形状的判定不受推广影响 ---------------------------
  //
  // 标准 capsule 各自报自己的名字：文件夹移动（甲刀）不借用第三 capsule 的
  // 证据，普通文件记录照旧走现役谓词。
  it("keeps the standard capsules own evidence: folder move and ordinary file keep their names", () => {
    const move: MutationLedgerEntryV1 = {
      intent: {
        version: 2,
        operationId: "op-move",
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
        operationId: "op-move",
        completedAt: 2,
        checkpoint: {
          ...emptyCheckpoint(),
          folderUpserts: [{
            path: "Archive/F",
            driveId: "folder-f",
            parentId: "archive",
            name: "F",
            eTag: "etag-f",
          }],
        },
      },
    };
    const base = {
      syncScope: ACTIVE_SCOPE,
      envelope: null,
    };
    expect(isolationCapsuleAdmits({
      ...base,
      record: move,
      verifiedReceiptRefusedAbsorption: false,
    })).toBe("folder-bounded-receipt");
    // Same record with the round fact still reports the standard capsule:
    // the third capsule shows up only when its evidence is what admits.
    expect(isolationCapsuleAdmits({
      ...base,
      record: move,
      verifiedReceiptRefusedAbsorption: true,
    })).toBe("folder-bounded-receipt");
    // An unbounded folder receipt stays refused either way.
    const unboundedMove = structuredClone(move);
    unboundedMove.receipt!.checkpoint.folderUpserts = [{
      path: "Other/F",
      driveId: "folder-f",
      parentId: "other",
      name: "F",
      eTag: "etag-f",
    }];
    expect(isolationCapsuleAdmits({
      ...base,
      record: unboundedMove,
      verifiedReceiptRefusedAbsorption: true,
    })).toBeNull();
  });
});
