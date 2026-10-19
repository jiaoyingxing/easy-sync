// 受阻文件夹记录的记录级隔离（F29 家族主刀「甲」＝隔离门槛）
//
// 本合同下的三条判据同刀落地：
//   ① 受阻文件夹对象被隔离后，它的**整个子树**不再出现在可执行计划里；
//   ② 「等依赖」的记录只记帐为等待，不再当成受阻计入批次小结或决定
//      `blockedOperationId`；
//   ③ 只有收据的影响面可证明落在该记录 `sourcePath ∪ path` 子树之内、且每个
//      被点名身份都能在已提交状态里点名的文件夹记录才可隔离；其余维持原行为
//      （整库响亮失败）。
// 先红后绿：主钉子在本刀的生产改动退回时变红；反向变异见各用例注释。

import {
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { SyncExecutor } from "../src/sync/sync-executor";
import type { SyncResult } from "../src/sync/sync-executor";
import { sha256Hex } from "../src/crypto";
import type { LocalScanner } from "../src/sync/local-scanner";
import type {
  LocalFileEntry,
  MutationLedgerEntryV1,
  MutationRecoveryRunSummary,
  SyncScope,
} from "../src/sync/types";
import {
  TEST_SYNC_SCOPE,
  makeActiveV2State,
  makeMockAdapter,
  makeMockOneDrive,
  emptyScanner,
} from "./helpers/sync-safety-harness";

const ACTIVE_SCOPE: SyncScope = {
  ...TEST_SYNC_SCOPE,
  accountId: "account-id",
};

/** The F29 field shape: the folder move reached the world (its receipt names
 *  the target path and the record's own folder identity), the committed state
 *  cannot project it, and the folders it carried are what the receipt's
 *  consumed local move hints point at. */
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

/** A scan entry whose hash is the real one — the executor re-reads the bytes
 *  and defers anything whose content moved since the scan. */
const scannedFile = async (
  path: string,
  bytes: ArrayBuffer,
): Promise<LocalFileEntry> => localFile(path, bytes, await sha256Hex(bytes));

/** One ordinary round with a folder record whose receipted commit is refused
 *  by the committed state, exactly as the field case reports it. */
const makeFolderRecordRound = (args: {
  record: MutationLedgerEntryV1;
  localEntries: LocalFileEntry[];
  contents: Map<string, ArrayBuffer>;
  folderAnchors?: Array<{
    remoteId: string;
    lastPath: string;
    parentId?: string;
    eTag?: string;
  }>;
}) => {
  const state = makeActiveV2State([], [], {
    mutationLedger: [args.record],
    ...(args.folderAnchors ? { folderAnchors: args.folderAnchors } : {}),
  });
  // Only the folder record's checkpoint is refused (the F29 shape); every
  // ordinary commit in the same round keeps the stub's behavior. The message is
  // one of the closed absorption-refusal kinds, chosen per folder action.
  const baseCommit = state.commitMutationCheckpoint;
  state.commitMutationCheckpoint = vi.fn(async (operationId: string) => {
    if (operationId === args.record.intent.operationId) {
      throw new Error(
        args.record.intent.action === "deleteLocalFolder"
          || args.record.intent.action === "deleteRemoteFolder"
          ? `V2 folder delete still has committed descendants: ${args.record.intent.path}`
          : `V2 folder move file projection changed: ${args.record.intent.path}`,
      );
    }
    return baseCommit(operationId);
  }) as never;
  const uploadFile = vi.fn().mockImplementation(async (
    _vaultName: string,
    path: string,
  ) => ({
    // One identity per path: the shared fixture's commit stub runs the real
    // file-state reducer, and a reused drive id would look like a remote move.
    id: `uploaded-${path}`,
    eTag: "uploaded-etag",
    parentReference: { id: TEST_SYNC_SCOPE.filesRootId },
  }));
  const executor = new SyncExecutor(
    makeMockOneDrive({
      uploadFile,
      // The folder-by-path inspection (used by the unreceipted classification)
      // asks for a metadata resource the shared mock does not carry by default.
      getDriveItemMetadata: vi.fn().mockResolvedValue(null),
      getDelta: vi.fn().mockResolvedValue({
        value: [],
        "@odata.deltaLink": "https://graph.example/delta-folder-isolation",
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
  // The receipt is what matched both sides (the F29 branch); the refusal comes
  // from the committed state, and the zero-write settlement is unavailable, so
  // isolation is the only remaining record-level disposal.
  const seams = executor as unknown as {
    verifyMutationReceipt: unknown;
    tryAutoSettleFolderMutationRecovery: unknown;
    activeSyncScope: SyncScope;
  };
  seams.verifyMutationReceipt = vi.fn().mockResolvedValue(true);
  const settleAsObserved = vi.fn().mockResolvedValue(false);
  seams.tryAutoSettleFolderMutationRecovery = settleAsObserved;
  seams.activeSyncScope = ACTIVE_SCOPE;
  const warnings: Array<{ message: string; payload: Record<string, unknown> }> = [];
  (executor as unknown as { diag: unknown }).diag = {
    log: () => undefined,
    warn: (_scope: string, message: string, payload?: Record<string, unknown>) => {
      warnings.push({ message, payload: payload ?? {} });
    },
    error: () => undefined,
    // Network-metrics collection is off in this fixture: it would need the
    // OneDrive mock to grow `beginRunMetrics` for no assertion here.
    isEnabled: () => false,
  };
  return { executor, state, uploadFile, settleAsObserved, warnings };
};

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

const makeRootAndDependentLedger = (): MutationLedgerEntryV1[] => {
  const expectedLocal = {
    exists: true as const,
    hash: "aa".repeat(32),
    size: 3,
  };
  return [
    {
      intent: {
        version: 1,
        operationId: "op-root-stuck",
        planRevision: 1,
        scope: ACTIVE_SCOPE,
        action: "upload",
        path: "stuck.md",
        expectedLocal,
        expectedRemote: { exists: false },
        createdAt: 1,
      },
      receipt: null,
    },
    {
      intent: {
        version: 1,
        operationId: "op-dependent",
        planRevision: 1,
        scope: ACTIVE_SCOPE,
        action: "upload",
        path: "stuck.md",
        expectedLocal,
        expectedRemote: { exists: false },
        createdAt: 2,
      },
      receipt: null,
    },
  ];
};

const recoverWithRecords = (args: {
  ledger: MutationLedgerEntryV1[];
}) => {
  const state = makeActiveV2State([], [], { mutationLedger: args.ledger });
  // A remote object that contradicts the records' expectations: both classify
  // as "outcome-unresolved", so the first one becomes the blocking root.
  const getFileMetadata = vi.fn().mockResolvedValue({
    path: "stuck.md",
    driveId: "unrelated-remote-id",
    parentId: TEST_SYNC_SCOPE.filesRootId,
    size: 3,
    mtime: 1,
    eTag: "unrelated-etag",
    sha256Hash: "ff".repeat(32),
  });
  const warnings: Array<{ message: string; payload: Record<string, unknown> }> = [];
  const executor = new SyncExecutor(
    makeMockOneDrive({ getFileMetadata }),
    Object.assign(emptyScanner(), {
      inspectFile: vi.fn().mockResolvedValue({
        status: "present",
        entry: {
          path: "stuck.md",
          hash: "aa".repeat(32),
          size: 3,
          mtime: 1,
          binary: false,
        },
      }),
    }),
    state,
    "testVault",
    undefined,
    undefined,
    {
      isEnabled: vi.fn().mockReturnValue(true),
      log: vi.fn(),
      warn: (_scope: string, message: string, payload?: Record<string, unknown>) => {
        warnings.push({ message, payload: payload ?? {} });
      },
      error: vi.fn(),
    },
  );
  (executor as unknown as { activeSyncScope: SyncScope })
    .activeSyncScope = ACTIVE_SCOPE;
  const run = async (): Promise<MutationRecoveryRunSummary> => {
    try {
      const summary = await (executor as unknown as {
        recoverMutationLedger(scope: SyncScope): Promise<MutationRecoveryRunSummary>;
      }).recoverMutationLedger(ACTIVE_SCOPE, undefined, 1, false, undefined, {} as never);
      return summary;
    } catch (error) {
      const summary = (error as { summary?: MutationRecoveryRunSummary }).summary;
      if (summary) return summary;
      throw error;
    }
  };
  return {
    state,
    run,
    batchSummary: () => warnings.find((entry) =>
      entry.message === "mutation recovery batch summary"),
  };
};

describe("Folder mutation recovery isolation", () => {

  // ---- 判据①：整个子树向下冻住 ------------------------------------------
  //
  // 先红凭据：把本刀的生产改动退回（文件夹记录没有任何隔离出口）时，这一轮
  // 直接以 `state: "blocked"` 收尾且不隔离；反向变异＝把
  // `isNamespaceProtectedByIsolatedRecovery` 的向下覆盖去掉（只留祖先/相等）
  // 后，`Videos/F/x.md` 会重新进入计划并被上传（`uploadFile` 多一次调用）。
  it("keeps an isolated folder record's whole subtree out of the plan while unrelated files still sync", async () => {
    const insideBytes = new TextEncoder().encode("inside subtree").buffer;
    const descendantBytes = new TextEncoder().encode("deeper descendant").buffer;
    const unrelatedBytes = new TextEncoder().encode("unrelated note").buffer;
    const share = new TextEncoder().encode("share").buffer;
    const { executor, state, uploadFile, warnings } = makeFolderRecordRound({
      record: makeFolderMoveRecord(),
      localEntries: [
        await scannedFile("Videos/F/x.md", insideBytes),
        await scannedFile("Videos/F/Child/deep.md", descendantBytes),
        await scannedFile("other.md", unrelatedBytes),
        await scannedFile("share.md", share),
      ],
      contents: new Map([
        ["Videos/F/x.md", insideBytes],
        ["Videos/F/Child/deep.md", descendantBytes],
        ["other.md", unrelatedBytes],
        ["share.md", share],
      ]),
      folderAnchors: FOLDER_EXPECTED_ANCHORS,
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
    });
    expect(result.success).toBe(true);
    expect(state.mutationLedger).toHaveLength(1);
    expect(state.mutationLedger[0].receipt).toBeDefined();
    // Nothing inside the frozen subtree reaches the network …
    expect(uploadFile.mock.calls.map((call) => call[1]))
      .toEqual(expect.arrayContaining(["other.md", "share.md"]));
    for (const call of uploadFile.mock.calls) {
      expect(String(call[1])).not.toBe("Videos/F/x.md");
      expect(String(call[1])).not.toBe("Videos/F/Child/deep.md");
    }
    // … and the unrelated work is untouched by the freeze.
    expect(new Set(uploadFile.mock.calls.map((call) => String(call[1]))))
      .toEqual(new Set(["other.md", "share.md"]));
    expect(warnings.some((entry) =>
      entry.message === "unresolved ordinary files were isolated from unrelated planning",
    )).toBe(true);
  });

  // 判据①的定向下界：被隔离对象的**同级**与**无关**路径不许被冻住（防止把
  // 「向下覆盖」写成「一刀切全库」）。
  it("keeps sibling and unrelated paths executable outside the isolated subtree", async () => {
    const insideBytes = new TextEncoder().encode("inside").buffer;
    const siblingBytes = new TextEncoder().encode("sibling").buffer;
    const { executor, uploadFile } = makeFolderRecordRound({
      record: makeFolderMoveRecord(),
      localEntries: [
        await scannedFile("Videos/F/x.md", insideBytes),
        await scannedFile("Videos/G/y.md", siblingBytes),
      ],
      contents: new Map([
        ["Videos/F/x.md", insideBytes],
        ["Videos/G/y.md", siblingBytes],
      ]),
      folderAnchors: FOLDER_EXPECTED_ANCHORS,
    });

    await executor.run("manual", {});

    expect(new Set(uploadFile.mock.calls.map((call) => String(call[1]))))
      .toEqual(new Set(["Videos/G/y.md"]));
  });

  // ---- 判据③：只有可证明有界的文件夹收据才放行 ---------------------------
  //
  // 负例（失败关闭）：收据的影响面越出该记录自己的子树 ⇒ 维持原行为（整库
  // 响亮失败、不隔离、不规划）。反向变异＝把判据③里的路径/身份校验删掉后，
  // 本用例转红（这一轮会被隔离并继续同步）。
  it("refuses to isolate a folder receipt whose target left the record's own subtree", async () => {
    const record = makeFolderMoveRecord();
    record.receipt = {
      ...record.receipt!,
      checkpoint: {
        ...record.receipt!.checkpoint,
        folderUpserts: [{
          path: "Other/F",
          driveId: "folder-f",
          parentId: "other",
          name: "F",
          eTag: "etag-f",
        }],
      },
    };
    const bytes = new TextEncoder().encode("unrelated").buffer;
    const { executor, uploadFile } = makeFolderRecordRound({
      record,
      localEntries: [localFile("other.md", bytes, "cc".repeat(32))],
      contents: new Map([["other.md", bytes]]),
      folderAnchors: FOLDER_EXPECTED_ANCHORS,
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
    expect(result.mutationRecovery?.isolated).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.errors).toBe(1);
    // The whole vault is still frozen: this is the pre-cut behaviour, kept on
    // purpose because the receipt cannot be bounded.
    expect(uploadFile).not.toHaveBeenCalled();
  });

  // 负例（失败关闭）：收据点名了一个已提交状态里点不出来的身份 ⇒ 同样不放行。
  it("refuses to isolate a folder record whose consumed hint identity is not nameable", async () => {
    const bytes = new TextEncoder().encode("unrelated").buffer;
    const { executor, uploadFile } = makeFolderRecordRound({
      record: makeFolderMoveRecord(),
      localEntries: [localFile("other.md", bytes, "cc".repeat(32))],
      contents: new Map([["other.md", bytes]]),
      // `folder-child` is missing from the committed folder anchors, so the
      // receipt's consumed hint cannot be placed inside the subtree.
      folderAnchors: [FOLDER_EXPECTED_ANCHORS[0]],
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery).toMatchObject({ state: "blocked" });
    expect(result.mutationRecovery?.isolated).toBeUndefined();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  // 正例（同一条判据的另一种形态）：**删除**收据只要可证明有界，同样可以走
  // 记录级隔离——`folderDeleteCheckpoint` 的产出形状（一条删除项＋被消费的
  // 自身身份 hint），子树照旧整棵冻住、无关文件照常同步。
  it("isolates a bounded folder delete receipt while the rest of the vault keeps syncing", async () => {
    const record: MutationLedgerEntryV1 = {
      intent: {
        version: 2,
        operationId: "op-folder-delete",
        planRevision: 1,
        scope: ACTIVE_SCOPE,
        action: "deleteRemoteFolder",
        path: "Videos/F",
        folderId: "folder-f",
        expectedLocal: { exists: false },
        expectedRemote: {
          exists: true,
          driveId: "folder-f",
          parentId: "videos",
          eTag: "etag-f",
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
        operationId: "op-folder-delete",
        completedAt: 2,
        checkpoint: {
          baseUpserts: [],
          baseRemovals: [],
          remoteUpserts: [],
          remoteDeletes: [],
          pendingConflictRemovals: [],
          pendingDeleteRemovals: [],
          folderDeletes: [{ path: "Videos/F", driveId: "folder-f" }],
          folderMoveHintRemovals: ["folder-f"],
        },
      },
    };
    const insideBytes = new TextEncoder().encode("still here").buffer;
    const unrelatedBytes = new TextEncoder().encode("unrelated note").buffer;
    const { executor, uploadFile } = makeFolderRecordRound({
      record,
      localEntries: [
        await scannedFile("Videos/F/x.md", insideBytes),
        await scannedFile("other.md", unrelatedBytes),
      ],
      contents: new Map([
        ["Videos/F/x.md", insideBytes],
        ["other.md", unrelatedBytes],
      ]),
      folderAnchors: FOLDER_EXPECTED_ANCHORS,
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      isolated: true,
      blockedOperationId: "op-folder-delete",
    });
    expect(new Set(uploadFile.mock.calls.map((call) => String(call[1]))))
      .toEqual(new Set(["other.md"]));
  });

  // 负例（失败关闭）：收据里混了文件层/待办层影响面（这里是 `pendingDeleteRemovals`，
  // 真实产出点是「拒绝远端删除后重建文件夹」那条评审动作）⇒ 写面越出自己的
  // 文件夹对象，不放行。
  it("refuses to isolate a folder receipt that also carries file-state effects", async () => {
    const record = makeFolderMoveRecord();
    record.receipt = {
      ...record.receipt!,
      checkpoint: {
        ...record.receipt!.checkpoint,
        pendingDeleteRemovals: ["Archive/F"],
      },
    };
    const bytes = new TextEncoder().encode("unrelated").buffer;
    const { executor, uploadFile } = makeFolderRecordRound({
      record,
      localEntries: [localFile("other.md", bytes, "cc".repeat(32))],
      contents: new Map([["other.md", bytes]]),
      folderAnchors: FOLDER_EXPECTED_ANCHORS,
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery?.isolated).toBeUndefined();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  // 负例（失败关闭）：**没有回执**的文件夹记录没有可判读的证据 ⇒ 不隔离。
  // 这里必须钉住 `blockReason: "facts-changed"`：只有这一档才会被隔离门读到，
  // 否则本用例会因为「根本没走到判据③」而假绿（反假绿控制项）。
  it("refuses to isolate an unreceipted folder record", async () => {
    const record = makeFolderMoveRecord();
    record.receipt = null;
    const bytes = new TextEncoder().encode("unrelated").buffer;
    const { executor, uploadFile } = makeFolderRecordRound({
      record,
      localEntries: [localFile("other.md", bytes, "cc".repeat(32))],
      contents: new Map([["other.md", bytes]]),
      folderAnchors: FOLDER_EXPECTED_ANCHORS,
    });

    const result: SyncResult = await executor.run("manual", {});

    expect(result.mutationRecovery).toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
    });
    expect(result.mutationRecovery?.isolated).toBeUndefined();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  // ---- 判据②：等待不等同受阻 --------------------------------------------
  //
  // 先红凭据：把「等依赖」的记录塞回 `blocked[]`（本刀之前的行为）时，下面两
  // 条读数会分别变成 `blocked: 2` / `blockedByReason` 多一条
  // `dependent-on-unresolved`，本用例转红。
  it("counts only the root as blocked while a dependent record waits", async () => {
    const { run, batchSummary } = recoverWithRecords({
      ledger: makeRootAndDependentLedger(),
    });

    const summary = await run();

    // The batch threshold reads the root only; the root is what the user can
    // review, and it is the first non-retryable root record.
    expect(summary).toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
      blockedOperationId: "op-root-stuck",
      total: 2,
      settled: 0,
      remaining: 2,
    });
    expect(batchSummary()?.payload).toMatchObject({
      blocked: 1,
      deferred: 1,
      blockedByReason: { "outcome-unresolved": 1 },
      firstBlockedOperationId: "op-root-stuck",
    });
  });

  // 控制项（反假绿）：只有根、没有依赖时，逐字段与本刀之前相同（新增的
  // `deferred` 读数为 0，其余字段一个不动）。
  it("leaves a single-root batch reading exactly as before the wait accounting", async () => {
    const ledger = makeRootAndDependentLedger();
    const { run, batchSummary } = recoverWithRecords({
      ledger: [ledger[0]],
    });

    const summary = await run();

    expect(summary).toMatchObject({
      state: "blocked",
      blockReason: "facts-changed",
      blockedOperationId: "op-root-stuck",
      total: 1,
      settled: 0,
      remaining: 1,
      retryAfterSeconds: null,
    });
    expect(batchSummary()?.payload).toMatchObject({
      state: "blocked",
      total: 1,
      settled: 0,
      remaining: 1,
      applied: 0,
      notApplied: 0,
      receiptCommitted: 0,
      quarantined: 0,
      blocked: 1,
      deferred: 0,
      blockedByReason: { "outcome-unresolved": 1 },
      firstBlockedOperationId: "op-root-stuck",
      externalMutations: 0,
    });
  });
});
