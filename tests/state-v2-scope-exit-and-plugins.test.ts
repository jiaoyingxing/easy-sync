// 作用域退出、插件参与与子树重建
// 由 tests/state-v2-activation.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。 保留同名容器 describe，用例全名与拆分前一致。
import "fake-indexeddb/auto";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Platform,
  type DataAdapter,
} from "obsidian";
import EasySyncPlugin, {
  type DeferredSettingsMutationHandle,
} from "../src/main";
import type { OneDriveClient } from "../src/onedrive/client";
import {
  OneDriveError,
  OneDriveErrorType,
  RemoteVaultScopeIdentityError,
  SharedSyncProtocolObservationError,
  SyntheticRequestTimeoutError,
  type DriveItem,
} from "../src/onedrive/types";
import { sha256Hex } from "../src/crypto";
import {
  getEasySyncLegacyPaths,
  getEasySyncPaths,
} from "../src/obsidian-compat";
import {
  createFolderSyncScopeSnapshotV1,
  isFolderPathInSyncScopeSnapshot,
  LocalScanner,
} from "../src/sync/local-scanner";
import { projectStatePathViewV2 } from "../src/sync/file-state-controller-v2";
import type { ManualResolutionEntrySnapshot } from "../src/sync/manual-resolution-entry";
import { StateManager, type PluginDataStore } from "../src/sync/state-manager";
import {
  SyncExecutor,
  type SyncCallbacks,
  type SyncMode,
  type SyncResult,
  type SyncRunOptions,
} from "../src/sync/sync-executor";
import { buildCommunityPluginInventory } from "../src/sync/community-plugin-inventory";
import { buildRemoteCommunityPluginCatalog } from "../src/sync/community-plugin-remote-catalog";
import { isPluginSelected } from "../src/sync/community-plugin-sync-policy";
import type { SyncStateEnvelopeV2 } from "../src/sync/state-envelope-v2";
import { ConfigSyncModal } from "../src/ui/config-sync-modal";
import { SequentialSettingsUpdateQueue } from "../src/ui/sequential-settings-update-queue";
import { canonicalPlanDigestV2 } from "../src/sync/canonical-plan-v2";
import { KEY_PUBLIC_113_CUTOVER } from "../src/sync/public-1-1-3-cutover";
import {
  IndexedDbPublic113StateStore,
  type Public113IndexedDbCandidateStoreFactory,
} from "../src/sync/indexeddb-public-1-1-3-state";
import { StateV2IndexedDbActiveStore, stateV2ActiveIndexedDbDatabaseName } from "../src/sync/state-v2-indexeddb-active";
import { openDB } from "idb";
import {
  IndexedDbRemoteScopeRecoveryEvidenceStore,
} from "../src/sync/remote-scope-recovery-evidence-store";
import {
  StateV2IndexedDbRecoveryStore,
  stateV2IndexedDbRecoveryEnvelopeDigest,
} from "../src/sync/state-v2-indexeddb-recovery";
import { ensureSharedSyncProtocolV3 } from "../src/sync/sync-protocol-v3";
import {
  SyncActionType,
  type BaseFileEntry,
  type LocalFileEntry,
  type MutationIntentV1,
  type MutationLedgerEntryV1,
  type MutationReceiptV1,
  type PlanReviewAuthorization,
  type RemoteFileEntry,
  type RemoteFolderEntry,
  type SyncPlan,
  type SyncScope,
} from "../src/sync/types";
import { injectActiveCommitCompletionFault } from "./helpers/indexeddb-completion-fault";

import {
  paths,
  legacyPaths,
  scope,
  hashA,
  protocolBinding,
  hashB,
  localA,
  baseA,
  communityPluginPath,
  harnessVaultInstanceSequence,
  ActivationTestRunOptions,
  V2ActivationTestExecutor,
  remoteItems,
  remoteItemsWithCommunityPluginState,
  sharedCalendarPluginBundleFixture,
  remoteFolderTree,
  findRemoteItemByPath,
  applyRemoteUpload,
  parentPath,
  makeHarness,
  expectNoFileMutations,
  prepareMovedFolderContinuationHarness,
  seedExactScopeFreeProtocol,
  activateV2WithFolderScopeDisabled,
  prepareReviewedFolderSubtreeHarness,
  prepareAmbiguousEmptyFolderHarness,
  readySnapshot,
  prepareUnanchoredSharedFolderHarness,
  stageConfirmedDescendantWithoutFolderAnchors,
  addHashlessReconstructionFiles,
  createRestartedExecutor,
  stageOrdinaryV2Review,
  public113NormalizedFixture,
  public113CleanFixtureInput,
  public113ReinstalledMixedVersionFixtureInput,
  public113InterruptedAnchoredDownloadFixtureInput,
  public113StalePendingFixtureInput,
  public113ReceiptedEmptyAccountFixtureInput,
  snapshotIndexedDbActiveStore,
  restoreIndexedDbActiveStore,
  makeJournalHarness,
  commitOneFileRevision,
} from "./helpers/state-v2-activation-harness";

describe("V1 to V2 controlled production activation", () => {
  it("retires a legacy scope-crossing pending row once the trash move plan moves on", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    // 修复前现场：folderDeferred 行无 issueCode（reason 路由当时不存在）。
    await harness.state.reconcilePendingIssues([{
      path: "Notes",
      actionType: SyncActionType.FolderDeferred,
      reason: "这个文件夹被移动、删除，或已不在当前同步设置中。",
      updatedAt: 1,
    }], []);
    expect(await harness.state.recordLocalFolderMoveHint("Notes", ".trash/Notes"))
      .toBe(true);
    harness.localEntryState.splice(0);
    harness.localFolderPaths.delete("Notes");
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".trash"),
    );

    const deleted = await harness.executor.run("manual");

    expect(deleted).toMatchObject({
      success: true,
      foldersDeleted: 1,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")).toBeNull();
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

  it("deletes an empty remote folder shell when Graph omits the folder cTag", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    // 主库真实现场：OneDrive Personal 对文件夹不返回 cTag，空壳删除的
    // If-Match 只能使用 exact 核验已通过的 eTag；cTag 缺失不应让空壳删除
    // 永远延后（每轮重复、用户无出口）。
    delete (findRemoteItemByPath(harness.remoteItemState, "Notes") as {
      cTag?: string;
    }).cTag;
    harness.localEntryState.splice(0);
    harness.localFolderPaths.delete("Notes");

    const deleted = await harness.executor.run("manual");

    expect(harness.diag.error).not.toHaveBeenCalled();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(deleted).toMatchObject({
      success: true,
      deleted: 1,
      foldersDeleted: 1,
      errors: 0,
      deferred: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")).toBeNull();
    expect(harness.state.mutationLedger).toHaveLength(0);
    // 删除记录簿（文件恢复线索）：空壳目录删除与先行的子文件删除各记一条。
    expect(harness.state.deletionLedgerEntries).toEqual([
      {
        remoteId: "file-a",
        path: "Notes/a.md",
        deletedAt: expect.any(Number),
        kind: "file",
      },
      {
        remoteId: "folder-notes",
        path: "Notes",
        deletedAt: expect.any(Number),
        kind: "folder",
      },
    ]);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

  it("recovers a lost remote file-delete response only after exact item 404", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localEntryState.splice(0);
    harness.loseFolderDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      deleted: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).toBeNull();
    expect((await harness.executor.run("manual")).deleted).toBe(0);
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
  });

  it("keeps V2 blocked when a deleted file path is 404 but its exact item moved", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    remote.name = "moved.md";
    harness.localEntryState.splice(0);
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "delete-path-404-item-moved",
      planRevision: 1,
      scope,
      action: "deleteRemote",
      path: localA.path,
      expectedLocal: { exists: false },
      expectedRemote: {
        exists: true,
        driveId: remote.id,
        eTag: remote.eTag!,
        size: remote.size!,
        sha256Hash: remote.file?.hashes?.sha256Hash,
      },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);

    await expect((harness.executor as unknown as {
      recoverMutationLedger(currentScope: typeof scope): Promise<void>;
    }).recoverMutationLedger(scope)).rejects.toThrow(
      "Mutation outcome requires manual review",
    );

    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([{
      intent,
      receipt: null,
    }]);
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("recovers a lost local file-delete response without trashing the file twice", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "file-a"),
      1,
    );
    harness.loseLocalFileDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      deleted: 1,
      errors: 0,
    });
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
    expect(harness.localEntryState).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).deleted).toBe(0);
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "unreceipted", receipted: false },
    { label: "receipted", receipted: true },
  ])("keeps a $label deleteLocal unresolved when its old remote ID moved", async ({ receipted }) => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    harness.remoteItemState.push({
      id: "folder-archive-delete-local",
      name: "Archive",
      folder: { childCount: 1 },
      parentReference: { id: scope.filesRootId },
      eTag: "etag-archive-delete-local",
    });
    remote.parentReference = { id: "folder-archive-delete-local" };
    remote.name = "moved.md";
    harness.localEntryState.splice(0);
    harness.files.delete(localA.path);
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: `delete-local-id-moved-${receipted}`,
      planRevision: 1,
      scope,
      action: "deleteLocal",
      path: localA.path,
      expectedLocal: {
        exists: true,
        hash: localA.hash,
        size: localA.size,
      },
      expectedRemote: { exists: false },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);
    const receipt: MutationReceiptV1 | null = receipted
      ? {
          version: 1,
          operationId: intent.operationId,
          completedAt: 11,
          checkpoint: {
            baseUpserts: [],
            baseRemovals: [intent.path],
            remoteUpserts: [],
            remoteDeletes: [],
            pendingConflictRemovals: [],
            pendingDeleteRemovals: [intent.path],
          },
        }
      : null;
    if (receipt) await harness.state.recordMutationReceipt(receipt);

    await expect((harness.executor as unknown as {
      recoverMutationLedger(currentScope: typeof scope): Promise<void>;
    }).recoverMutationLedger(scope)).rejects.toThrow(/manual review|no longer matches/i);

    expect(harness.state.mutationLedger).toEqual([{ intent, receipt }]);
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("settles a conflict-derived deleteLocal intent when the local file still matches the reviewed version and the remote path is absent", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    // Remote deleted + locally modified (hashB) is the keep-remote conflict
    // shape: the intent's expectedLocal can never match the committed anchor,
    // which still carries hashA.
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "file-a"),
      1,
    );
    harness.localEntryState[0] = { ...localA, hash: hashB, size: 11 };
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "delete-local-conflict-keep-remote",
      planRevision: 1,
      scope,
      action: "deleteLocal",
      path: localA.path,
      expectedLocal: { exists: true, hash: hashB, size: 11 },
      expectedRemote: { exists: false },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);

    await expect((harness.executor as unknown as {
      recoverMutationLedger(currentScope: typeof scope): Promise<unknown>;
    }).recoverMutationLedger(scope)).resolves.toMatchObject({ state: "settled" });

    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.diag.warn).toHaveBeenCalledWith(
      "execute",
      expect.stringContaining("deleteLocal settled as not applied"),
    );
  });

  it("settles the conflict-derived deleteLocal record through an ordinary sync round", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "file-a"),
      1,
    );
    harness.localEntryState[0] = { ...localA, hash: hashB, size: 11 };
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "delete-local-conflict-keep-remote-ordinary-round",
      planRevision: 1,
      scope,
      action: "deleteLocal",
      path: localA.path,
      expectedLocal: { exists: true, hash: hashB, size: 11 },
      expectedRemote: { exists: false },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({ errors: 0, conflicts: 1 });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingConflicts.map((conflict) => conflict.path))
      .toContain(localA.path);
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("keeps a conflict-derived deleteLocal intent unresolved when the local file changed again", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "file-a"),
      1,
    );
    harness.localEntryState[0] = { ...localA, hash: hashB, size: 11 };
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "delete-local-conflict-keep-remote-changed-again",
      planRevision: 1,
      scope,
      action: "deleteLocal",
      path: localA.path,
      expectedLocal: { exists: true, hash: hashB, size: 11 },
      expectedRemote: { exists: false },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);
    harness.localEntryState[0] = { ...localA, hash: hashA, size: 10 };

    await expect((harness.executor as unknown as {
      recoverMutationLedger(currentScope: typeof scope): Promise<unknown>;
    }).recoverMutationLedger(scope)).rejects.toThrow(/manual review|no longer matches/i);

    expect(harness.state.mutationLedger).toEqual([{ intent, receipt: null }]);
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("deletes a local folder only after its remote-deleted children and a second local empty check", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(0);

    const deleted = await harness.executor.run("manual");

    expect(harness.diag.error).not.toHaveBeenCalled();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(deleted).toMatchObject({
      success: true,
      deleted: 1,
      foldersDeleted: 1,
      errors: 0,
      deferred: 0,
    });
    expect(harness.localEntryState).toHaveLength(0);
    expect(harness.localFolderPaths.has("Notes")).toBe(false);
    expect(harness.rawAdapter.list).toHaveBeenCalledWith("Notes");
    expect(harness.fileManager.trashFile).toHaveBeenCalled();
    // 跟随删除侧（文件版本找回刀一之三）：本机跟随云端删除删掉自己这一份，也记
    // 一条——云端那份是别的设备（或更早的自己）删的，记录只落在动手那台设备上；
    // 文件身份按 committed 锚点取，目录身份来自计划项携带的远端 id。
    expect(harness.state.deletionLedgerEntries).toEqual([
      {
        remoteId: "file-a",
        path: "Notes/a.md",
        deletedAt: expect.any(Number),
        kind: "file",
      },
      {
        remoteId: "folder-notes",
        path: "Notes",
        deletedAt: expect.any(Number),
        kind: "folder",
      },
    ]);
    // 取 id 的时机：本轮归约已按 baseRemovals 删掉按路径的锚点，记录簿仍持有身份。
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
    ).some((anchor) => anchor.lastPath === "Notes/a.md")).toBe(false);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

  it("overlaps remote folder deletes at the same depth while keeping child-first layers", async () => {
    const paths = ["DelA", "DelB", "DelC", "DelA/Sub"];
    const folderItems = remoteFolderTree(paths).map((item, index) => ({
      ...item,
      cTag: `scope-folder-ctag-${index + 1}`,
    }));
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: paths.map((path) => ({ path })),
      remoteItems: folderItems,
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    const originalDeleteImpl = harness.mutations.deleteItem.getMockImplementation();
    let activeDeletes = 0;
    let peakDeletes = 0;
    const deleteOrder: string[] = [];
    (
      harness.mutations.deleteItem as unknown as {
        mockImplementation: (
          impl: (...args: Parameters<NonNullable<typeof originalDeleteImpl>>) => Promise<void>,
        ) => void;
      }
    ).mockImplementation(async (...args: Parameters<NonNullable<typeof originalDeleteImpl>>) => {
      activeDeletes++;
      peakDeletes = Math.max(peakDeletes, activeDeletes);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        deleteOrder.push(args[1]);
        await originalDeleteImpl!(...args);
      } finally {
        activeDeletes--;
      }
    });

    harness.localFolderPaths.clear();
    const result = await harness.executor.run("manual");

    expect(result.success).toBe(true);
    expect(result.foldersDeleted).toBe(paths.length);
    expect(result.deferred).toBe(0);
    expect(result.errors).toBe(0);
    // Child-first: the nested folder settles before its parent.
    expect(deleteOrder.indexOf("DelA/Sub")).toBeLessThan(deleteOrder.indexOf("DelA"));
    // Same-depth sibling folders overlap instead of serial round trips.
    expect(peakDeletes).toBeGreaterThanOrEqual(2);
    // Idempotent: a second round has nothing left.
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

  it("retires an anchored folder without confirmation when both the local and remote tree are already absent", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localEntryState.splice(0);
    harness.localFolderPaths.clear();
    harness.remoteItemState.splice(0);

    const retired = await harness.executor.run("manual");

    expect(retired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersDeleted: 1,
      conflicts: 0,
      errors: 0,
    });
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toHaveLength(0);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ),
    ).toHaveLength(0);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersDeleted: 0,
      errors: 0,
    });
  });

  it("records a user-confirmed local file delete that followed a cloud deletion", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.remoteItemState.splice(0);

    const pending = await harness.executor.run("manual");

    expect(pending).toMatchObject({
      success: true,
      deleted: 0,
      errors: 0,
    });
    expect(harness.state.pendingRemoteDeletes).toHaveLength(2);
    expect(harness.state.pendingRemoteDeletes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "confirmLocalDelete",
          path: "Notes/a.md",
        }),
        expect.objectContaining({
          type: "deleteLocalFolder",
          path: "Notes",
        }),
      ]),
    );

    await harness.executor.confirmRemoteDelete("Notes/a.md", false);

    expect(harness.localEntryState).toHaveLength(0);
    // 用户确认的跟随删除（文件）同样补记一条：身份只能在本轮归约删锚点之前取。
    expect(harness.state.deletionLedgerEntries).toEqual([
      {
        remoteId: "file-a",
        path: "Notes/a.md",
        deletedAt: expect.any(Number),
        kind: "file",
      },
    ]);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
    ).some((anchor) => anchor.lastPath === "Notes/a.md")).toBe(false);
  });

  it("keeps an empty remote-deleted folder pending until the existing delete approval is used", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.remoteItemState.splice(0);

    const pending = await harness.executor.run("manual");

    expect(pending).toMatchObject({
      success: true,
      foldersDeleted: 0,
      errors: 0,
    });
    expect(harness.localFolderPaths.has("Empty")).toBe(true);
    expect(harness.state.pendingRemoteDeletes).toEqual([
      expect.objectContaining({
        type: "deleteLocalFolder",
        path: "Empty",
        requiresConfirmation: true,
      }),
    ]);

    await harness.executor.confirmRemoteDelete("Empty", false);

    expect(harness.localFolderPaths.has("Empty")).toBe(false);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    // 用户确认的跟随删除（目录）也补记一条，身份来自 committed 目录锚点。
    expect(harness.state.deletionLedgerEntries).toEqual([
      {
        remoteId: "folder-empty",
        path: "Empty",
        deletedAt: expect.any(Number),
        kind: "folder",
      },
    ]);
  });

  it("confirms nested folder deletes child-first even when the UI passes the parent first", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Parent" }, { path: "Parent/Child" }],
      remoteItems: [
        {
          id: "folder-parent",
          name: "Parent",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-parent",
        },
        {
          id: "folder-child",
          name: "Child",
          folder: {},
          parentReference: { id: "folder-parent" },
          eTag: "etag-folder-child",
        },
      ],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.remoteItemState.splice(0);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
    expect(harness.state.pendingRemoteDeletes.map((item) => item.path).sort())
      .toEqual(["Parent", "Parent/Child"]);

    await harness.executor.confirmRemoteDeletes(["Parent", "Parent/Child"]);

    expect(harness.fileManager.trashFile.mock.calls.map(([file]) => file.path))
      .toEqual(["Parent/Child", "Parent"]);
    expect(harness.localFolderPaths.has("Parent/Child")).toBe(false);
    expect(harness.localFolderPaths.has("Parent")).toBe(false);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("recreates a pending remote-deleted empty folder when the user keeps local", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.remoteItemState.splice(0);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);

    await harness.executor.rejectRemoteDelete("Empty");

    expect(harness.localFolderPaths.has("Empty")).toBe(true);
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.folder).toBeTruthy();
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .not.toBe("folder-empty");
    expect(harness.state.pendingRemoteDeletes).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersCreated: 0,
      foldersDeleted: 0,
      errors: 0,
    });
  });

  it("recovers a lost empty-folder delete response without issuing a second delete", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
        cTag: "ctag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.delete("Empty");
    harness.loseFolderDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
  });

  it("deletes an automatic empty remote folder with the verified eTag when Graph omits the folder cTag", async () => {
    // OneDrive Personal does not return folder cTags; before this fallback the
    // empty-shell delete deferred forever ("无法安全确认这个空文件夹") with no
    // user-side remedy on every round. The exact inspection already verified
    // identity and eTag twice with empty children, so the eTag If-Match plus
    // the read-back keeps the deletion chain fail-safe.
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.delete("Empty");

    const deleted = await harness.executor.run("manual");

    expect(deleted).toMatchObject({
      success: true,
      foldersDeleted: 1,
      deferred: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")).toBeNull();
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.mutations.deleteItem).toHaveBeenCalledWith(
      expect.anything(),
      "Empty",
      "etag-folder-empty",
      "folder-empty",
    );
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

  it("retries a failed folder-delete checkpoint without deleting twice", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
        cTag: "ctag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.delete("Empty");
    harness.failStateRenameOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("recovers a lost local empty-folder delete response without trashing twice", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(0);
    harness.loseLocalFolderDeleteResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
    expect(harness.localFolderPaths.has("Empty")).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
    expect(harness.fileManager.trashFile).toHaveBeenCalledOnce();
  });

  it("blocks a remote folder delete when the final all-pages child check is non-empty", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.delete("Empty");
    (harness.client.listFolderChildrenById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{
        id: "late-child",
        name: "late.md",
        file: {},
        parentReference: { id: "folder-empty" },
      }]);

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .toBe("folder-empty");
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("defers a remote folder delete when an ancestor changes its projected path", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Parent" }, { path: "Parent/Empty" }],
      remoteItems: [
        {
          id: "folder-parent",
          name: "Parent",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-parent",
        },
        {
          id: "folder-empty",
          name: "Empty",
          folder: {},
          parentReference: { id: "folder-parent" },
          eTag: "etag-folder-empty",
        },
      ],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.delete("Parent/Empty");
    (harness.client.getDriveItemMetadataById as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (driveItemId: string) => {
        const item = harness.remoteItemState.find(
          (candidate) => candidate.id === driveItemId,
        ) ?? null;
        const parent = harness.remoteItemState.find(
          (candidate) => candidate.id === "folder-parent",
        );
        if (parent) parent.name = "ParentChanged";
        return item;
      });

    const deferred = await harness.executor.run("manual");

    expect(deferred).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.remoteItemState.some((item) => item.id === "folder-empty"))
      .toBe(true);
  });

  it("turns a 412 folder delete into a deferred item without retiring the anchor", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.delete("Empty");
    harness.conflictFolderDeleteOnce();

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .toBe("folder-empty");
    expect(
      Object.values(harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId),
    ).toContainEqual(expect.objectContaining({ remoteId: "folder-empty" }));
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("stops before the destructive folder delete when cancellation arrives during recheck", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.delete("Empty");
    (harness.client.listFolderChildrenById as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => {
        harness.executor.cancel();
        return [];
      });

    const cancelled = await harness.executor.run("manual");

    expect(cancelled).toMatchObject({
      success: false,
      foldersDeleted: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.id)
      .toBe("folder-empty");
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("keeps a local folder and a recoverable intent outcome when trash fails", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Empty" }],
      remoteItems: [{
        id: "folder-empty",
        name: "Empty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-empty",
      }],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(0);
    harness.failTrashOnce();

    const failed = await harness.executor.run("manual");

    expect(failed).toMatchObject({
      success: false,
      foldersDeleted: 0,
      errors: 1,
    });
    expect(harness.localFolderPaths.has("Empty")).toBe(true);
    expect(harness.state.mutationLedger).toHaveLength(0);

    const retried = await harness.executor.run("manual");
    expect(retried).toMatchObject({
      success: true,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(harness.localFolderPaths.has("Empty")).toBe(false);
  });

  it("deletes a synced theme/snippet directory shell with the ordinary delete-local chain", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: ".obsidian" }, { path: ".obsidian/snippets" }],
      remoteItems: [
        {
          id: "folder-config",
          name: ".obsidian",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-config",
        },
        {
          id: "folder-snippets",
          name: "snippets",
          folder: {},
          parentReference: { id: "folder-config" },
          eTag: "etag-folder-snippets",
        },
      ],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "folder-snippets"),
      1,
    );

    const settled = await harness.executor.run("manual");

    expect(settled).toMatchObject({
      success: true,
      foldersDeleted: 1,
      deferred: 0,
      errors: 0,
    });
    expect(harness.localFolderPaths.has(".obsidian/snippets")).toBe(false);
    expect(harness.fileManager.trashFile).toHaveBeenCalled();
  });

  it("keeps a synced community-plugin directory shell deferred", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [
        { path: ".obsidian" },
        { path: ".obsidian/plugins" },
        { path: ".obsidian/plugins/dataview" },
      ],
      remoteItems: [
        {
          id: "folder-config",
          name: ".obsidian",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-config",
        },
        {
          id: "folder-plugins",
          name: "plugins",
          folder: {},
          parentReference: { id: "folder-config" },
          eTag: "etag-folder-plugins",
        },
        {
          id: "folder-dataview",
          name: "dataview",
          folder: {},
          parentReference: { id: "folder-plugins" },
          eTag: "etag-folder-dataview",
        },
      ],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.executor.setAutomaticHandlingPolicy({
      autoDeleteLocalFiles: true,
      mergeNonOverlappingText: true,
    });
    harness.remoteItemState.splice(
      harness.remoteItemState.findIndex((item) => item.id === "folder-dataview"),
      1,
    );

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: true,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.localFolderPaths.has(".obsidian/plugins/dataview")).toBe(true);
    expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("accepts only the newly expanded EasySync folder identities without mutations", async () => {
    const easySyncFolders: DriveItem[] = [
      {
        id: "folder-obsidian",
        name: ".obsidian",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-obsidian",
      },
      {
        id: "folder-plugins",
        name: "plugins",
        folder: {},
        parentReference: { id: "folder-obsidian" },
        eTag: "etag-folder-plugins",
      },
      {
        id: "folder-easy-sync",
        name: "easy-sync",
        folder: {},
        parentReference: { id: "folder-plugins" },
        eTag: "etag-folder-easy-sync",
      },
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...easySyncFolders],
    });
    let configFoldersIncluded = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian"),
    );
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);

    configFoldersIncluded = true;
    for (const path of [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ]) {
      harness.localFolderPaths.add(path);
    }
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      (data) => {
        data["sync-plugin-files"] = true;
      },
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: [
          ".obsidian",
          ".obsidian/plugins",
          ".obsidian/plugins/easy-sync",
        ],
      },
    );
    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      revision: 1,
      folders: [
        { path: ".obsidian", driveId: "folder-obsidian" },
        { path: ".obsidian/plugins", driveId: "folder-plugins" },
        {
          path: ".obsidian/plugins/easy-sync",
          driveId: "folder-easy-sync",
        },
      ],
    });
    expect(harness.state.planReviewActive).toBe(false);
    expect(await harness.state.hasV2RecoveryJournal()).toBe(false);
    expect(await harness.state.prepareSyncScopeExpansion(scope)).toEqual({
      status: "ready",
      revision: 1,
    });
    harness.getDelta.mockClear();
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const accepted = await harness.executor.run("manual");

    expect(accepted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
      "Notes",
    ]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.getDelta).toHaveBeenCalledTimes(1);
    expectNoFileMutations(harness.mutations);

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("keeps stable folder identities quiet after an explicit scope contraction", async () => {
    const contractedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
      ".obsidian/themes",
      ".obsidian/themes/Notation",
      ".obsidian/themes/Primary",
      ".obsidian/themes/Things 3",
    ];
    const harness = makeHarness({
      localFolders: [
        { path: "Notes" },
        ...contractedPaths.map((path) => ({ path })),
      ],
      remoteItems: [
        ...remoteItems(),
        ...remoteFolderTree(contractedPaths),
      ],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const committedBefore = harness.state.getCommittedV2Envelope()!;
    const anchorsBefore = structuredClone(
      committedBefore.folderAnchors!.byAnchorId,
    );
    const remoteFoldersBefore = Object.fromEntries(
      Object.entries(committedBefore.remoteIndex.itemsById)
        .filter(([, node]) => node.kind === "folder"),
    );

    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => !path.startsWith(".obsidian"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".obsidian"),
    );
    vi.mocked(harness.scanner.scanAll).mockResolvedValue({
      entries: harness.localEntryState.map((entry) => ({ ...entry })),
      folders: [{ path: "Notes" }],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "config-scope:on",
        targetSettingsFingerprint: "config-scope:off",
        expandedFolderPaths: [],
        requiresCompleteRemoteIdentitySnapshot: false,
      },
    );
    for (const path of contractedPaths) {
      await harness.state.reconcilePendingIssues([{
        path,
        actionType: SyncActionType.FolderDeferred,
        reason: "scope-crossing",
        updatedAt: 1,
        consecutiveFailures: 3,
      }], []);
    }
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const first = await harness.executor.run("manual");
    const second = await harness.executor.run("manual");

    for (const result of [first, second]) {
      expect(result).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        deferred: 0,
        errors: 0,
      });
    }
    expect(harness.state.pendingIssues).toEqual([]);
    expect(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).toEqual(anchorsBefore);
    expect(Object.fromEntries(
      Object.entries(
        harness.state.getCommittedV2Envelope()!.remoteIndex.itemsById,
      ).filter(([, node]) => node.kind === "folder"),
    )).toEqual(remoteFoldersBefore);
    expect(contractedPaths.every((path) =>
      harness.localFolderPaths.has(path)
    )).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("accepts a newly expanded all-community-plugin folder tree in one state-only commit", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/calendar",
      ".obsidian/plugins/dataview",
      ".obsidian/plugins/quickadd",
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolderTree(expandedPaths)],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    for (const path of expandedPaths) harness.localFolderPaths.add(path);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "community-plugins:off",
        targetSettingsFingerprint: "community-plugins:all",
        expandedFolderPaths: expandedPaths,
      },
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const accepted = await harness.executor.run("manual");

    expect(accepted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...expandedPaths, "Notes"].sort());
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("joins a remote-only community plugin through the original settings journey without a second manual sync", async () => {
    const pluginId = "obsidian-pkmer";
    const manifestId = "pkmer";
    const pluginRoot = `.obsidian/plugins/${pluginId}`;
    const mainPath = `${pluginRoot}/main.js`;
    const manifestPath = `${pluginRoot}/manifest.json`;
    const stylesPath = `${pluginRoot}/styles.css`;
    const manifestContent = JSON.stringify({
      id: manifestId,
      name: "PKMer",
      version: "2.0.0",
      minAppVersion: "1.5.0",
    });
    const remoteContents = {
      [mainPath]: "pkmer-main",
      [manifestPath]: manifestContent,
      [stylesPath]: "pkmer-styles",
    };
    const pluginFolders = remoteFolderTree([
      ".obsidian",
      ".obsidian/plugins",
      pluginRoot,
    ]);
    const pluginFolderId = pluginFolders.at(-1)!.id;
    const remotePluginFiles: DriveItem[] = await Promise.all(
      Object.entries(remoteContents).map(async ([path, content], index) => {
        const contentBytes = new TextEncoder().encode(content);
        return {
          id: `calendar-file-${index + 1}`,
          name: path.slice(path.lastIndexOf("/") + 1),
          size: contentBytes.byteLength,
          file: { hashes: { sha256Hash: await sha256Hex(contentBytes) } },
          parentReference: { id: pluginFolderId },
          lastModifiedDateTime: "2026-08-02T00:00:00.000Z",
          eTag: `etag-calendar-${index + 1}`,
          cTag: `ctag-calendar-${index + 1}`,
        };
      }),
    );
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }],
      remoteItems: [
        ...remoteItems(),
        ...pluginFolders,
        ...remotePluginFiles,
      ],
      remoteFileContents: remoteContents,
    });
    let pluginScopeEnabled = false;
    let selectedPluginEnabled = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => !path.startsWith(".obsidian")
        || (selectedPluginEnabled
          && (path === pluginRoot || path.startsWith(`${pluginRoot}/`))),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".obsidian")
        || (pluginScopeEnabled
          && (path === ".obsidian" || path === ".obsidian/plugins"))
        || (selectedPluginEnabled && path === pluginRoot),
    );
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.add(".obsidian");
    harness.localFolderPaths.add(".obsidian/plugins");
    await harness.state.setRemoteCommunityPluginCatalog(
      await buildRemoteCommunityPluginCatalog({
        scope: harness.state.remoteScope!,
        configDir: ".obsidian",
        items: [...pluginFolders, ...remotePluginFiles],
        manifestObservations: [],
        observedAt: 1,
        ownPluginId: "easy-sync",
      }),
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
    harness.getDelta.mockClear();

    const initialInventory = await buildCommunityPluginInventory(
      harness.rawAdapter as unknown as DataAdapter,
      ".obsidian",
      "easy-sync",
      [pluginId],
      harness.state.remoteSnapshot,
      [pluginId],
      [],
      [],
      null,
      [pluginId],
    );
    const remoteOnlyVisibleBeforeJoin =
      initialInventory.find((item) => item.id === pluginId)?.remote === true;

    Object.assign(harness.scanner as object, {
      setConfig: vi.fn((config: {
        includePluginCode?: boolean;
        pluginCodeSelection?: Parameters<typeof isPluginSelected>[0];
      }) => {
        pluginScopeEnabled = config.includePluginCode === true;
        selectedPluginEnabled = Boolean(
          config.pluginCodeSelection
          && isPluginSelected(config.pluginCodeSelection, pluginId),
        );
      }),
    });
    const settingsPlugin = new EasySyncPlugin();
    Object.assign(settingsPlugin as object, {
      app: {
        ...harness.plugin.app,
        workspace: {
          getLeavesOfType: vi.fn().mockReturnValue([]),
        },
      },
      manifest: harness.plugin.manifest,
      scanner: harness.scanner,
      state: harness.state,
      syncExecutor: harness.executor,
      onedrive: harness.plugin.onedrive,
      syncPluginFiles: false,
      syncEditorSettings: false,
      syncAppearance: false,
      syncThemes: false,
      syncHotkeys: false,
      syncCorePlugins: false,
      syncBookmarks: false,
      syncCommunityPlugins: false,
      syncPluginData: false,
      communityPluginSyncPolicy: {
        version: 1,
        files: {
          mode: "none",
          pluginIds: [],
        },
        data: { mode: "none", pluginIds: [] },
      },
      excludedFolders: [],
    });
    vi.spyOn(settingsPlugin as never, "ensureStateLoaded")
      .mockResolvedValue(undefined);
    vi.spyOn(settingsPlugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    const startCommunityPluginJoinNow = vi.spyOn(
      settingsPlugin as never,
      "startCommunityPluginJoinNow",
    ).mockImplementation(() => undefined);
    const scheduleJoinSync = vi.spyOn(
      settingsPlugin as never,
      "scheduleCommunityPluginJoinSync",
    ).mockImplementation(() => undefined);
    const settingsUpdateQueue = new SequentialSettingsUpdateQueue();
    let settingsUpdateError: unknown;
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    Object.assign(modal as object, {
      plugin: settingsPlugin,
      inventory: initialInventory,
      busyPluginRows: new Set<string>(),
      pendingPluginValues: new Map<string, boolean>(),
      pendingMutationCancels: new Map<string, () => boolean>(),
      settingsUpdateQueue,
      destroyed: true,
      renderPluginListArea: vi.fn(),
      showSyncPathSettingsError: (error: unknown) => {
        settingsUpdateError = error;
      },
    });

    await settingsPlugin.updateCommunityPluginFilesScope(true);
    expect(harness.state.activeSyncScopeExpansion?.folders.map(
      (folder) => folder.path,
    )).toEqual([".obsidian", ".obsidian/plugins"]);

    (modal as unknown as {
      queuePluginSelectionUpdate(
        column: "files" | "data",
        targetPluginId: string,
        enabled: boolean,
      ): void;
    }).queuePluginSelectionUpdate("files", pluginId, true);
    await settingsUpdateQueue.whenIdle();
    expect(harness.state.activeSyncScopeExpansion?.folders.map(
      (folder) => folder.path,
    )).toEqual([".obsidian", ".obsidian/plugins"]);

    expect(settingsUpdateError).toBeUndefined();
    expect(settingsPlugin.communityPluginSyncPolicy.files).toEqual({
      mode: "selected",
      pluginIds: [],
    });
    expect(
      settingsPlugin.getCommunityPluginParticipation()
        ?.pluginsById[pluginId]?.phase,
    ).toBe("join-requested");
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect([mainPath, manifestPath, stylesPath].some(
      (path) => harness.files.has(path),
    )).toBe(false);
    expectNoFileMutations(harness.mutations);
    // Manager toggles stay decoupled from the sync engine (2026-09-09 批量
    // 反馈): the join request persists at toggle time and the round is left
    // to the shared dirty trigger until the manager modal closes.
    const joinRoundDeferredToDirtyHint =
      startCommunityPluginJoinNow.mock.calls.length === 0
      && scheduleJoinSync.mock.calls.length > 0;
    const automaticResult = await (settingsPlugin as unknown as {
      dispatchSyncRun(request: { mode: "auto" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "auto" });
    expect(automaticResult).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 3,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining([
      ".obsidian",
      ".obsidian/plugins",
    ]));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toContain(pluginRoot);
    expect(harness.state.confirmedDescendantFileReconstruction).toBeNull();
    const restoredBeforeManualRun = [mainPath, manifestPath, stylesPath]
      .every((path) => harness.files.has(path));

    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const reopenedSettings = new EasySyncPlugin();
    vi.spyOn(reopenedSettings, "loadData").mockResolvedValue(
      structuredClone(harness.pluginData),
    );
    await reopenedSettings.loadSyncSettings();
    const restartedExecutor = createRestartedExecutor(harness, restartedState);
    Object.assign(reopenedSettings as object, {
      app: settingsPlugin.app,
      manifest: settingsPlugin.manifest,
      scanner: harness.scanner,
      state: restartedState,
      syncExecutor: restartedExecutor,
      onedrive: harness.plugin.onedrive,
    });
    await reopenedSettings.ensureCommunityPluginParticipationInitialized();
    expect(
      restartedState.getCommunityPluginParticipation()
        ?.pluginsById[pluginId]?.phase,
    ).toBe("participating");
    const enabledMissingHasActionablePhase =
      restartedState.getCommunityPluginParticipation()
        ?.pluginsById[pluginId]?.phase === "participating";
    expect(enabledMissingHasActionablePhase).toBe(true);

    expect([mainPath, manifestPath, stylesPath].every(
      (path) => harness.files.has(path),
    )).toBe(true);
    expect(harness.getDelta).toHaveBeenCalled();
    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toContain(pluginRoot);

    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    settingsPlugin.stopAutoSync();
    await restartedState.close();

    expect({
      remoteOnlyVisibleBeforeJoin,
      joinRoundDeferredToDirtyHint,
      restoredBeforeManualRun,
      enabledMissingHasActionablePhase,
    }).toEqual({
      remoteOnlyVisibleBeforeJoin: true,
      joinRoundDeferredToDirtyHint: true,
      restoredBeforeManualRun: true,
      enabledMissingHasActionablePhase: true,
    });
  });

  it("flushes deferred community plugin joins when the manager modal closes", async () => {
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    const flush = vi.fn();
    const onCloseCallback = vi.fn();
    Object.assign(modal as object, {
      plugin: { flushPendingCommunityPluginJoinSync: flush },
      destroyed: false,
      loadGeneration: 0,
      inventoryRevisionRefreshPending: false,
      unsubscribeCommunityPluginInventoryRevision: null,
      contentEl: { empty: vi.fn() },
      settingsUpdateQueue: new SequentialSettingsUpdateQueue(),
      onCloseCallback,
    });
    modal.onClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(onCloseCallback).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued manager toggle from its row handle and reverts the row", async () => {
    const modal = Object.create(ConfigSyncModal.prototype) as ConfigSyncModal;
    let releaseMutation!: () => void;
    let cancelFn = (): boolean => false;
    const updateSelection = vi.fn(() => Promise.resolve());
    const plugin = {
      runSettingsMutationWhenSyncIdle: () => {
        const promise = new Promise<void>((resolve) => {
          releaseMutation = resolve;
          cancelFn = () => {
            resolve();
            return true;
          };
        }) as DeferredSettingsMutationHandle;
        promise.cancel = () => cancelFn();
        promise.isQueued = () => true;
        return promise;
      },
      updateCommunityPluginFilesSelection: updateSelection,
    };
    Object.assign(modal as object, {
      plugin,
      busyPluginRows: new Set<string>(),
      pendingPluginValues: new Map<string, boolean>(),
      pendingMutationCancels: new Map<string, DeferredSettingsMutationHandle>(),
      settingsUpdateQueue: new SequentialSettingsUpdateQueue(),
      destroyed: true,
      renderPluginListArea: vi.fn(),
    });

    // The mutation is created eagerly at click time (queued behind a round),
    // so its cancel handle exists before sync goes idle.
    (modal as unknown as {
      queuePluginSelectionUpdate(
        column: "files" | "data",
        pluginId: string,
        enabled: boolean,
      ): void;
    }).queuePluginSelectionUpdate("files", "calendar", true);
    expect(updateSelection).not.toHaveBeenCalled();
    const handles = (modal as unknown as {
      pendingMutationCancels: Map<string, DeferredSettingsMutationHandle>;
    }).pendingMutationCancels;
    expect(typeof handles.get("files:calendar")?.cancel).toBe("function");
    expect(handles.get("files:calendar")?.isQueued()).toBe(true);

    // Undo: the queued mutation is dropped, the row reverts and unlocks, and
    // the commit never runs even after the round releases.
    expect(handles.get("files:calendar")!.cancel()).toBe(true);
    await (modal as unknown as {
      settingsUpdateQueue: SequentialSettingsUpdateQueue;
    }).settingsUpdateQueue.whenIdle();
    expect(updateSelection).not.toHaveBeenCalled();
    expect(
      (modal as unknown as { busyPluginRows: Set<string> }).busyPluginRows.has(
        "files:calendar",
      ),
    ).toBe(false);
    expect(handles.has("files:calendar")).toBe(false);
    releaseMutation();
  });

  it.each([
    {
      label: "a required local parent is missing",
      localFolderPaths: [".obsidian"],
      remoteId: "current",
    },
    {
      label: "the bound remote root changed",
      localFolderPaths: [".obsidian", ".obsidian/plugins"],
      remoteId: "replacement-root",
      expandedFolderPaths: [".obsidian/plugins/remote-plugin"],
    },
    {
      label: "the plugin root was not authorized by this scope change",
      localFolderPaths: [".obsidian", ".obsidian/plugins"],
      remoteId: "current",
      expandedFolderPaths: [".obsidian"],
    },
  ])("keeps join ancestor identity fail-closed when $label", async ({
    localFolderPaths,
    remoteId,
    expandedFolderPaths = [".obsidian/plugins/remote-plugin"],
  }) => {
    const pluginRoot = ".obsidian/plugins/remote-plugin";
    const folders = remoteFolderTree([
      ".obsidian",
      ".obsidian/plugins",
      pluginRoot,
    ]);
    const remoteRoot = folders.at(-1)!;
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...folders],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    for (const path of localFolderPaths) harness.localFolderPaths.add(path);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      ["remote-plugin"],
      {
        previousSettingsFingerprint: "community-plugins:off",
        targetSettingsFingerprint: "community-plugins:remote-plugin",
        expandedFolderPaths,
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );

    const accepted = await harness.state.acceptSyncScopeExpansionFolders({
      expectedRevision: 1,
      scope,
      localFiles: [],
      localFolders: localFolderPaths.map((path) => ({ path })),
      localFolderScanComplete: true,
      remoteIdentityComplete: true,
      sourceBoundCommunityPluginJoinRoots: [{
        path: pluginRoot,
        remoteId: remoteId === "current" ? remoteRoot.id : remoteId,
      }],
    });

    expect(accepted).toEqual({ status: "stale", accepted: 0 });
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath)).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a desktop-only empty plugin root non-participating when mobile scope is enabled from off", async () => {
    const previousMobile = Platform.isMobile;
    const previousMobileApp = Platform.isMobileApp;
    Platform.isMobile = true;
    Platform.isMobileApp = true;
    try {
      const pluginId = "realtime-transcription";
      const rootPath = `.obsidian/plugins/${pluginId}`;
      const manifestPath = `${rootPath}/manifest.json`;
      const mainPath = `${rootPath}/main.js`;
      const manifestContent = JSON.stringify({
        id: pluginId,
        version: "1.5.4",
        minAppVersion: "1.4.0",
        isDesktopOnly: true,
      });
      const mainContent = "desktop-only-main";
      const manifestBytes = new TextEncoder().encode(manifestContent);
      const mainBytes = new TextEncoder().encode(mainContent);
      const pluginFolders = remoteFolderTree([
        ".obsidian",
        ".obsidian/plugins",
        rootPath,
      ]);
      const pluginFolderId = pluginFolders.at(-1)!.id;
      const remotePluginFiles: DriveItem[] = [
        {
          id: "realtime-transcription-manifest",
          name: "manifest.json",
          size: manifestBytes.byteLength,
          file: { hashes: { sha256Hash: await sha256Hex(manifestBytes) } },
          parentReference: { id: pluginFolderId },
          lastModifiedDateTime: "2026-08-01T00:00:00.000Z",
          eTag: "etag-realtime-transcription-manifest",
          cTag: "ctag-realtime-transcription-manifest",
        },
        {
          id: "realtime-transcription-main",
          name: "main.js",
          size: mainBytes.byteLength,
          file: { hashes: { sha256Hash: await sha256Hex(mainBytes) } },
          parentReference: { id: pluginFolderId },
          lastModifiedDateTime: "2026-08-01T00:00:00.000Z",
          eTag: "etag-realtime-transcription-main",
          cTag: "ctag-realtime-transcription-main",
        },
      ];
      const harness = makeHarness({
        localFolders: [
          { path: "Notes" },
          { path: ".obsidian" },
          { path: ".obsidian/plugins" },
          { path: rootPath },
        ],
        remoteItems: [
          ...remoteItems(),
          ...pluginFolders,
          ...remotePluginFiles,
        ],
        remoteFileContents: {
          [manifestPath]: manifestContent,
          [mainPath]: mainContent,
        },
      });
      harness.executor.setCommunityPluginSyncPolicy({
        version: 1,
        files: { mode: "none", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      });
      const enableScope = await activateV2WithFolderScopeDisabled(
        harness,
        (path) => path.startsWith(".obsidian"),
      );

      enableScope();
      harness.executor.setCommunityPluginSyncPolicy({
        version: 1,
        files: {
          mode: "selected",
          pluginIds: [pluginId],
        },
        data: { mode: "none", pluginIds: [] },
      });
      await harness.state.commitSyncPathSettingsChange(
        (path) => harness.scanner.shouldSyncPath(path),
        () => undefined,
        [pluginId],
        {
          previousSettingsFingerprint: "community-plugins:off",
          targetSettingsFingerprint: `community-plugins:selected:${pluginId}`,
          expandedFolderPaths: [
            ".obsidian",
            ".obsidian/plugins",
            rootPath,
          ],
          requiresCompleteRemoteIdentitySnapshot: true,
        },
      );
      harness.getDelta.mockClear();
      for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
      harness.rawAdapter.mkdir.mockClear();
      harness.rawAdapter.writeBinary.mockClear();

      const first = await harness.executor.run("manual");

      expect(first).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        deferred: 0,
        errors: 0,
      });
      expect(harness.mutations.downloadFile.mock.calls.map(
        (call) => call[1],
      )).toEqual([manifestPath]);
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.rawAdapter.mkdir).not.toHaveBeenCalled();
      expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(harness.hostWrites).toEqual([]);
      expect(harness.state.pendingIssues).toEqual([]);
      expect(harness.state.getCommunityPluginManifestObservations())
        .toEqual([expect.objectContaining({ pluginId })]);
      expect(harness.state.remoteSnapshot.map((entry) => entry.path))
        .toEqual(expect.arrayContaining([manifestPath, mainPath]));

      const restartedState = new StateManager(harness.plugin);
      await restartedState.load();
      const restartedExecutor = createRestartedExecutor(
        harness,
        restartedState,
      );
      restartedExecutor.setCommunityPluginSyncPolicy({
        version: 1,
        files: {
          mode: "selected",
          pluginIds: [pluginId],
        },
        data: { mode: "none", pluginIds: [] },
      });
      harness.getDelta.mockClear();
      harness.mutations.downloadFile.mockClear();
      harness.mutations.downloadFileToPath.mockClear();
      harness.rawAdapter.mkdir.mockClear();
      harness.rawAdapter.writeBinary.mockClear();

      const stable = await restartedExecutor.run("manual");

      expect(stable).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
        deferred: 0,
        errors: 0,
      });
      expect(harness.getDelta).toHaveBeenCalledTimes(1);
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.rawAdapter.mkdir).not.toHaveBeenCalled();
      expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(harness.hostWrites).toEqual([]);
      expect(restartedState.pendingIssues).toEqual([]);
      await restartedState.close();
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isMobileApp = previousMobileApp;
    }
  });

  it("rebuilds a trimmed remote file index when file scope re-expands under existing folder anchors", async () => {
    const pluginFolders = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/calendar",
    ];
    const manifestText = JSON.stringify({
      id: "calendar",
      version: "2.0.0",
    });
    const mainText = "calendar-main";
    const manifestBytes = new TextEncoder().encode(manifestText);
    const mainBytes = new TextEncoder().encode(mainText);
    const manifestPath = ".obsidian/plugins/calendar/manifest.json";
    const mainPath = ".obsidian/plugins/calendar/main.js";
    const localPluginFiles: LocalFileEntry[] = [
      {
        path: manifestPath,
        size: manifestBytes.byteLength,
        mtime: 2,
        hash: await sha256Hex(manifestBytes.buffer),
        binary: false,
      },
      {
        path: mainPath,
        size: mainBytes.byteLength,
        mtime: 2,
        hash: await sha256Hex(mainBytes.buffer),
        binary: false,
      },
    ];
    const remotePluginFolders = remoteFolderTree(pluginFolders);
    const remotePluginFiles: DriveItem[] = localPluginFiles.map(
      (entry, index) => ({
        id: `calendar-file-${index + 1}`,
        name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
        size: entry.size,
        file: { hashes: { sha256Hash: entry.hash } },
        parentReference: { id: remotePluginFolders.at(-1)!.id },
        lastModifiedDateTime: "2026-07-30T00:00:00.000Z",
        eTag: `calendar-etag-${index + 1}`,
        cTag: `calendar-ctag-${index + 1}`,
      }),
    );
    const harness = makeHarness({
      local: [localA, ...localPluginFiles],
      localFolders: [
        { path: "Notes" },
        ...pluginFolders.map((path) => ({ path })),
      ],
      remoteItems: [
        ...remoteItems(),
        ...remotePluginFolders,
        ...remotePluginFiles,
      ],
      initialFiles: {
        [manifestPath]: manifestText,
        [mainPath]: mainText,
      },
    });
    let pluginFilesIncluded = true;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) =>
        pluginFilesIncluded
        || !path.startsWith(".obsidian/plugins/calendar/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockReturnValue(true);
    harness.getDelta.mockImplementation(async (
      _vaultName: string,
      deltaLink?: string,
    ) => ({
      value: deltaLink ? [] : [...harness.remoteItemState],
      "@odata.deltaLink": "https://graph.example/delta-current",
    }));
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path))
      .toEqual(expect.arrayContaining([manifestPath, mainPath]));

    pluginFilesIncluded = false;
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "community-plugins:on",
        targetSettingsFingerprint: "community-plugins:off",
        expandedFolderPaths: [],
        requiresCompleteRemoteIdentitySnapshot: false,
      },
    );
    expect((await harness.executor.run("manual")).success).toBe(true);
    expect(harness.state.remoteSnapshot.map((entry) => entry.path))
      .not.toEqual(expect.arrayContaining([manifestPath, mainPath]));

    pluginFilesIncluded = true;
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "community-plugins:off",
        targetSettingsFingerprint: "community-plugins:on",
        expandedFolderPaths: pluginFolders,
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      folders: [],
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeSyncScopeExpansion).toMatchObject({
      folders: [],
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    harness.getDelta.mockClear();
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    await restartedState.setPlanReviewBundle(
      [],
      {
        uploads: 0,
        downloads: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      scope,
    );
    const blocked = await restartedExecutor.run("manual");
    expect(blocked).toMatchObject({
      success: false,
      deferred: 0,
      message: "result.cloudRecordIncomplete",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect(restartedState.activeSyncScopeExpansion).not.toBeNull();
    expectNoFileMutations(harness.mutations);
    await restartedState.clearPlanReview();

    const expanded = await restartedExecutor.run("manual");

    expect(expanded).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(harness.getDelta).toHaveBeenCalledWith("testVault", undefined, expect.anything());
    expect(harness.getDelta).not.toHaveBeenCalledWith(
      "testVault",
      expect.any(String),
    );
    expect(restartedState.remoteSnapshot.map((entry) => entry.path))
      .toEqual(expect.arrayContaining([manifestPath, mainPath]));
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expectNoFileMutations(harness.mutations);

    harness.getDelta.mockClear();
    expect((await restartedExecutor.run("manual")).success).toBe(true);
    expect(harness.getDelta).toHaveBeenCalledWith(
      "testVault",
      "https://graph.example/delta-current",
    );
    expectNoFileMutations(harness.mutations);
  });

  it("accepts folder identities first discovered by the required scope-expansion refresh", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const harness = makeHarness({
      remoteItems: remoteItems(),
    });
    let configFoldersIncluded = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian"),
    );
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    expect(harness.state.remoteFolders.map((folder) => folder.path))
      .not.toEqual(expect.arrayContaining(expandedPaths));

    configFoldersIncluded = true;
    for (const path of expandedPaths) harness.localFolderPaths.add(path);
    harness.remoteItemState.push(...remoteFolderTree(expandedPaths));
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: expandedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1(
            { includePaths: [], includeOwnPluginCode: false },
          ),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      folders: [],
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeSyncScopeExpansion?.folderScopeTransition)
      .toBeDefined();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const accepted = await restartedExecutor.run("manual");

    expect(accepted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining(expandedPaths));
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(restartedState.pendingIssues).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("derives an in-scope unknown folder from complete facts without using the folder-range expansion", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const unrelatedPath = "Shared";
    const harness = makeHarness({ remoteItems: remoteItems() });
    let configFoldersIncluded = false;
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian/"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => configFoldersIncluded || !path.startsWith(".obsidian"),
    );
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    configFoldersIncluded = true;
    for (const path of [...expandedPaths, unrelatedPath]) {
      harness.localFolderPaths.add(path);
    }
    harness.remoteItemState.push(...remoteFolderTree([
      ...expandedPaths,
      unrelatedPath,
    ]));
    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: expandedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({ includePaths: [] }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      deferred: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    const anchors = Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath);
    expect(anchors).toEqual(expect.arrayContaining([
      ...expandedPaths,
      unrelatedPath,
    ]));
    expect(harness.state.pendingIssues).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("recovers a scope-expansion marker after restart before any envelope commit", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolderTree(expandedPaths)],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    for (const path of expandedPaths) harness.localFolderPaths.add(path);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: expandedPaths,
      },
    );

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...expandedPaths, "Notes"].sort());
    expectNoFileMutations(harness.mutations);
  });

  it("UJ-003 merges consecutive settings changes into one sync and stays stable after a cold reopen", async () => {
    const allExpandedPaths = [
      ".obsidian",
      ".obsidian/themes",
      ".obsidian/snippets",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const ownPluginPath = ".obsidian/plugins/easy-sync/main.js";
    const remoteFolders = remoteFolderTree(allExpandedPaths);
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolders],
    });
    let activeConfig: Parameters<LocalScanner["setConfig"]>[0] = {
      includePaths: [],
      includeOwnPluginCode: false,
      includePluginCode: false,
      includePluginData: false,
    };
    let activeFolderScope = createFolderSyncScopeSnapshotV1(
      activeConfig,
      ".obsidian",
      "easy-sync",
    );
    const setConfig = vi.fn(
      (config: Parameters<LocalScanner["setConfig"]>[0]) => {
        activeConfig = {
          ...activeConfig,
          ...config,
          includePaths: [...(config.includePaths ?? activeConfig.includePaths ?? [])],
        };
        activeFolderScope = createFolderSyncScopeSnapshotV1(
          activeConfig,
          ".obsidian",
          "easy-sync",
        );
      },
    );
    Object.assign(harness.scanner as object, { setConfig });
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".obsidian")
        || isFolderPathInSyncScopeSnapshot(activeFolderScope, path),
    );
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation((path) => {
      if (!path.startsWith(".obsidian/")) return true;
      if (
        path === ".obsidian/plugins/easy-sync"
        || path.startsWith(".obsidian/plugins/easy-sync/")
      ) return activeConfig.includeOwnPluginCode === true;
      return (activeConfig.includePaths ?? []).some((includedPath) => {
        const normalized = includedPath.replace(/\/+$/, "");
        return includedPath.endsWith("/")
          ? path === normalized || path.startsWith(`${normalized}/`)
          : path === normalized;
      });
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    for (const path of allExpandedPaths) harness.localFolderPaths.add(path);
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
    harness.getDelta.mockClear();

    const settingsPlugin = new EasySyncPlugin();
    Object.assign(settingsPlugin as object, {
      app: {
        ...harness.plugin.app,
        workspace: { getLeavesOfType: vi.fn().mockReturnValue([]) },
      },
      manifest: harness.plugin.manifest,
      scanner: harness.scanner,
      state: harness.state,
      syncExecutor: harness.executor,
      onedrive: harness.plugin.onedrive,
      syncPluginFiles: false,
      syncEditorSettings: false,
      syncAppearance: false,
      syncThemes: false,
      syncHotkeys: false,
      syncCorePlugins: false,
      syncBookmarks: false,
      syncCommunityPlugins: false,
      syncPluginData: false,
      communityPluginSyncPolicy: {
        version: 1,
        files: { mode: "selected", pluginIds: [] },
        data: { mode: "none", pluginIds: [] },
      },
      excludedFolders: [],
    });
    vi.spyOn(settingsPlugin as never, "ensureStateLoaded")
      .mockResolvedValue(undefined);
    vi.spyOn(settingsPlugin as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    settingsPlugin.applySyncPathSettings();

    await settingsPlugin.updateSyncPathSettings({ syncEditorSettings: true });
    await settingsPlugin.updateSyncPathSettings({ syncAppearance: true });
    await settingsPlugin.updateSyncPathSettings({ syncThemes: true });
    await settingsPlugin.updateSyncPathSettings({ syncHotkeys: true });
    await settingsPlugin.updateSyncPathSettings({ syncCorePlugins: true });
    await settingsPlugin.updateCommunityPluginFilesScope(true);
    expect(harness.scanner.shouldSyncPath(ownPluginPath)).toBe(false);
    await settingsPlugin.updateSyncPathSettings({ syncPluginFiles: true });

    const pendingScope = harness.state.activeSyncScopeExpansion!;
    expect(pendingScope.revision).toBeGreaterThanOrEqual(7);
    expect(pendingScope.requiresCompleteRemoteIdentitySnapshot).toBe(true);
    expect(pendingScope.folderScopeTransition!.previous).toMatchObject({
      includePaths: [],
      includeOwnPluginCode: false,
      includePluginCode: false,
    });
    for (const path of allExpandedPaths) {
      expect(isFolderPathInSyncScopeSnapshot(
        pendingScope.folderScopeTransition!.target,
        path,
      )).toBe(true);
    }
    expect(pendingScope.folders.map((folder) => folder.path)).toEqual(
      expect.arrayContaining(allExpandedPaths),
    );
    expect(harness.scanner.shouldSyncPath(ownPluginPath)).toBe(true);
    expect(activeConfig.includePluginCode).toBe(true);
    expect(activeConfig.includeOwnPluginCode).toBe(true);
    expect(harness.getDelta).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const first = await (settingsPlugin as unknown as {
      dispatchSyncRun(request: { mode: "manual" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });
    expect(first).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining(allExpandedPaths));
    expectNoFileMutations(harness.mutations);

    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(harness, restartedState);
    const reopenedSettings = new EasySyncPlugin();
    Object.assign(reopenedSettings as object, {
      app: settingsPlugin.app,
      manifest: settingsPlugin.manifest,
      scanner: harness.scanner,
      state: restartedState,
      syncExecutor: restartedExecutor,
      onedrive: harness.plugin.onedrive,
    });
    vi.spyOn(reopenedSettings, "loadData").mockResolvedValue(
      structuredClone(harness.pluginData),
    );
    vi.spyOn(reopenedSettings as never, "ensureStateLoaded")
      .mockResolvedValue(undefined);
    vi.spyOn(reopenedSettings as never, "updateStatusBar")
      .mockImplementation(() => undefined);
    await reopenedSettings.loadSyncSettings();
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();

    const stable = await (reopenedSettings as unknown as {
      dispatchSyncRun(request: { mode: "manual" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });
    expect(stable).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(reopenedSettings).toMatchObject({
      syncPluginFiles: true,
      syncEditorSettings: true,
      syncAppearance: true,
      syncThemes: true,
      syncHotkeys: true,
      syncCorePlugins: true,
      syncCommunityPlugins: true,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(restartedState.mutationLedger).toEqual([]);
    expectNoFileMutations(harness.mutations);

    await reopenedSettings.updateSyncPathSettings({ syncThemes: false });
    expect(reopenedSettings).toMatchObject({
      syncThemes: false,
      syncPluginFiles: true,
      syncCommunityPlugins: true,
    });
    expect(harness.scanner.shouldSyncFolderPath(".obsidian/themes")).toBe(false);
    expect(harness.scanner.shouldSyncFolderPath(
      ".obsidian/plugins/easy-sync",
    )).toBe(true);
    for (const mutation of Object.values(harness.mutations)) mutation.mockClear();
    const contracted = await (reopenedSettings as unknown as {
      dispatchSyncRun(request: { mode: "manual" }): Promise<SyncResult | null>;
    }).dispatchSyncRun({ mode: "manual" });
    expect(contracted).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expectNoFileMutations(harness.mutations);
    settingsPlugin.stopAutoSync();
    reopenedSettings.stopAutoSync();
    await restartedState.close();
  });

  it("filters an unconsumed scope expansion through the final contracted scope", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const finalIncludedPaths = [
      ".obsidian",
      ".obsidian/plugins",
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolderTree(expandedPaths)],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-scopes:off",
        targetSettingsFingerprint: "easy-sync:on",
        expandedFolderPaths: expandedPaths,
        includedFolderPaths: expandedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({ includePaths: [] }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "easy-sync:on",
        targetSettingsFingerprint: "community-plugins:on",
        expandedFolderPaths: [],
        includedFolderPaths: finalIncludedPaths,
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/plugins/easy-sync/"],
            includeOwnPluginCode: true,
          }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [
              ".obsidian/community-plugins.json",
              ".obsidian/plugins/",
            ],
            includePluginCode: true,
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: false,
      },
    );

    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      revision: 2,
      previousSettingsFingerprint: "plugin-scopes:off",
      targetSettingsFingerprint: "community-plugins:on",
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    expect(
      harness.state.activeSyncScopeExpansion?.folders.map((folder) => folder.path),
    ).toEqual(finalIncludedPaths);
    expectNoFileMutations(harness.mutations);
  });

  it("does not merge a continuous settings chain when the anchored identity digest changed", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "config:off",
        targetSettingsFingerprint: "editor:on",
        expandedFolderPaths: [],
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({ includePaths: [] }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/app.json"],
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    const marker = harness.state.activeSyncScopeExpansion!;
    const saved = harness.pluginData["easy-sync-sync-scope-expansion"] as {
      source: { commitSeq: number; anchorFingerprint: string };
    };
    saved.source.commitSeq -= 1;
    saved.source.anchorFingerprint = "changed-identity-digest";
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "editor:on",
        targetSettingsFingerprint: "editor+themes:on",
        expandedFolderPaths: [],
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({
            includePaths: [".obsidian/app.json"],
          }),
          target: createFolderSyncScopeSnapshotV1({
            includePaths: [
              ".obsidian/app.json",
              ".obsidian/themes/",
            ],
          }),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );

    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      revision: 2,
      previousSettingsFingerprint: "editor:on",
      targetSettingsFingerprint: "editor+themes:on",
    });
    expect(harness.state.activeSyncScopeExpansion?.createdAt)
      .toBeGreaterThanOrEqual(marker.createdAt);
    expectNoFileMutations(harness.mutations);
  });

  it("replays marker cleanup without a second state commit after the envelope already committed", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolderTree(expandedPaths)],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    for (const path of expandedPaths) harness.localFolderPaths.add(path);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: expandedPaths,
      },
    );
    vi.mocked(harness.plugin.updatePluginData).mockImplementationOnce(
      async (mutator) => {
        const candidate = { ...harness.pluginData };
        mutator(candidate);
        expect(candidate["easy-sync-sync-scope-expansion"]).toBeNull();
        throw new Error("marker clear interrupted");
      },
    );

    const interrupted = await harness.executor.run("manual");

    expect(interrupted).toMatchObject({
      success: false,
      errors: 1,
    });
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();
    const committedSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...expandedPaths, "Notes"].sort());
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    expect(restartedState.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(committedSeq);
    expectNoFileMutations(harness.mutations);
  });

  it("invalidates a persisted scope-expansion marker when its settings revision drifts", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolderTree(expandedPaths)],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    for (const path of expandedPaths) harness.localFolderPaths.add(path);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "plugin-files:off",
        targetSettingsFingerprint: "plugin-files:on",
        expandedFolderPaths: expandedPaths,
      },
    );
    harness.pluginData["easy-sync-sync-path-settings-revision"] = 2;
    harness.pluginData["easy-sync-sync-path-settings-fingerprint"] =
      "settings:changed-again";

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const stopped = await restartedExecutor.run("manual");

    expect(stopped).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.activeSyncScopeExpansion).toBeNull();
    // The stale marker still authorizes nothing; the anchors below come from
    // the complete-facts derivation, not from the expansion.
    expect(
      Object.values(
        restartedState.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining([...expandedPaths, "Notes"]));
    expectNoFileMutations(harness.mutations);
  });

  it("does not rebind an existing folder anchor when the remote id was replaced out of scope", async () => {
    const originalFolder: DriveItem = {
      id: "folder-shared-old",
      name: "Shared",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-shared-old",
    };
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: "Shared" }],
      remoteItems: [originalFolder],
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const replacement: DriveItem = {
      ...originalFolder,
      id: "folder-shared-new",
      eTag: "etag-shared-new",
    };
    harness.remoteItemState.splice(0, 1, replacement);
    await harness.state.setRemoteState(
      [],
      "https://graph.example/delta-current",
      scope,
      [{
        path: "Shared",
        driveId: replacement.id,
        parentId: scope.filesRootId,
        name: "Shared",
        eTag: replacement.eTag,
      }],
    );
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "shared:off",
        targetSettingsFingerprint: "shared:on",
        expandedFolderPaths: ["Shared"],
      },
    );

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      errors: 0,
    });
    expect(harness.state.pendingRemoteDeletes).toContainEqual(
      expect.objectContaining({
        path: "Shared",
        requiresConfirmation: true,
      }),
    );
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ),
    ).toContainEqual(expect.objectContaining({
      remoteId: "folder-shared-old",
      lastPath: "Shared",
    }));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ),
    ).not.toContainEqual(expect.objectContaining({
      remoteId: "folder-shared-new",
    }));
    expectNoFileMutations(harness.mutations);
  });

  it("derives same-path unknown folders from complete facts without a scope-expansion authorization", async () => {
    const expandedPaths = [
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
    ];
    const harness = makeHarness({
      remoteItems: [...remoteItems(), ...remoteFolderTree(expandedPaths)],
    });
    const enableScope = await activateV2WithFolderScopeDisabled(
      harness,
      (path) => path.startsWith(".obsidian"),
    );
    enableScope();
    for (const path of expandedPaths) harness.localFolderPaths.add(path);
    await harness.state.commitSyncPathSettingsChange(
      () => true,
      () => undefined,
    );

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(expect.arrayContaining([...expandedPaths, "Notes"]));
    expectNoFileMutations(harness.mutations);
  });

  it("reconstructs missing ancestor folder anchors from an exact confirmed descendant file", async () => {
    const {
      harness,
      pluginFolders,
    } = await stageConfirmedDescendantWithoutFolderAnchors();
    const sourceCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const deltaCalls = harness.getDelta.mock.calls.length;

    const repaired = await harness.executor.run("manual");

    expect(repaired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...pluginFolders, "Notes"].sort());
    expect(harness.state.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(sourceCommitSeq + 1);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 1);
    expectNoFileMutations(harness.mutations);

    const stableCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const stableReconstruction = vi.spyOn(
      restartedState,
      "acceptConfirmedDescendantFolderAnchors",
    );
    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(stableCommitSeq);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 2);
    expect(stableReconstruction).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("bootstraps the exact descendant file before reconstructing an unanchored folder chain", async () => {
    const {
      harness,
      pluginFolders,
      pluginFile,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: false,
    });
    const sourceCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const deltaCalls = harness.getDelta.mock.calls.length;

    const repaired = await harness.executor.run("manual");

    expect(repaired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toContainEqual(expect.objectContaining({
      remoteId: remotePluginFile.id,
      lastPath: pluginFile.path,
      contentHash: pluginFile.hash,
    }));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...pluginFolders, "Notes"].sort());
    expect(harness.state.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(sourceCommitSeq + 2);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 1);
    expectNoFileMutations(harness.mutations);

    const stableCommitSeq =
      harness.state.getCommittedV2Envelope()!.meta.commitSeq;
    const stableMetadataCalls =
      harness.client.getFileMetadata.mock.calls.length;
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(restartedState.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(stableCommitSeq);
    expect(harness.getDelta).toHaveBeenCalledTimes(deltaCalls + 2);
    expect(harness.client.getFileMetadata)
      .toHaveBeenCalledTimes(stableMetadataCalls);
    expectNoFileMutations(harness.mutations);
  });

  it("downloads hashless descendant evidence once before reconstructing the folder chain", async () => {
    const {
      harness,
      pluginFolders,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: false,
      remoteContent: "{\"id\":\"easy-sync\"}",
      omitRemoteHash: true,
    });

    const repaired = await harness.executor.run("manual");

    expect(repaired).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath).sort(),
    ).toEqual([...pluginFolders, "Notes"].sort());
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("reconstructs a repaired subtree file baseline in one visible sync without exposing equal files as conflicts", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const {
      equalPaths,
      differentPaths,
    } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      26,
      2,
    );

    const progress: Array<{ current: number; total: number }> = [];
    const repaired = await harness.executor.run("manual", {
      onProgress: (current, total) => progress.push({ current, total }),
    });

    expect(repaired).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      conflicts: 2,
      deferred: 0,
      errors: 0,
    });
    expect(repaired.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(progress).toContainEqual({ current: 26, total: 26 });
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(26);
    expect(
      harness.state.pendingConflicts.map((item) => item.path).sort(),
    ).toEqual([...differentPaths].sort());
    for (const path of equalPaths) {
      expect(harness.state.getBaseEntry(path)).toMatchObject({
        path,
        hash: harness.localEntryState.find((entry) => entry.path === path)!.hash,
      });
    }
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("uses strict SHA-256 evidence before fallback downloads and leaves a proven difference for review", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const { allPaths } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
    );
    for (let index = 0; index < 4; index++) {
      const path = allPaths[index]!;
      const remote = harness.remoteItemState.find(
        (item) => item.id === `reconstruction-file-${index}`,
      )!;
      remote.file = {
        hashes: {
          sha256Hash: harness.localEntryState.find(
            (entry) => entry.path === path,
          )!.hash,
        },
      };
    }
    harness.remoteItemState.find(
      (item) => item.id === "reconstruction-file-4",
    )!.file = { hashes: { sha256Hash: "f".repeat(64) } };
    harness.remoteItemState.find(
      (item) => item.id === "reconstruction-file-5",
    )!.file = { hashes: { quickXorHash: "same-quickxor-is-not-proof" } };

    const first = await harness.executor.run("manual");

    expect(first).toMatchObject({
      success: true,
      conflicts: 1,
      deferred: 0,
      errors: 0,
    });
    expect(first.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(7);
    expect(harness.mutations.downloadFile).toHaveBeenCalledWith(
      "testVault",
      allPaths[5],
      undefined,
      "reconstruction-file-5",
      expect.any(Number),
    );

    expect(harness.state.pendingConflicts.map((item) => item.path))
      .toEqual([allPaths[4]]);
  });

  it("keeps large reconstruction batches in one visible sync", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
      0,
      1024 * 1024,
    );
    const publishEvidence = vi.spyOn(
      harness.state,
      "acceptConfirmedDescendantFileEvidence",
    );

    const first = await harness.executor.run("manual");

    expect(first).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(first.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(12);
    expect(publishEvidence).toHaveBeenCalledTimes(3);
    expect(publishEvidence.mock.calls.map(([input]) => input.entries.length))
      .toEqual([4, 4, 4]);
  });

  it("keeps slow reconstruction comparisons in one visible sync", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const { remoteContents } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
    );
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) => {
        now += 6_000;
        return new TextEncoder().encode(
          remoteContents.get(path) ?? "",
        ).buffer;
      },
    );

    const first = await harness.executor.run("manual");
    nowSpy.mockRestore();

    expect(first).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(first.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(12);
  });

  it("keeps settled reconstruction checkpoints when the single visible sync is cancelled", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const {
      allPaths,
      remoteContents,
    } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      12,
    );
    let downloadCalls = 0;
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) => {
        downloadCalls++;
        if (downloadCalls === 3) harness.executor.cancel();
        return new TextEncoder().encode(
          remoteContents.get(path) ?? "",
        ).buffer;
      },
    );

    const cancelled = await harness.executor.run("manual");

    expect(cancelled.message).toBe("result.cancelled");
    expect(harness.state.confirmedDescendantFileReconstruction)
      .not.toBeNull();
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(4);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) =>
        new TextEncoder().encode(remoteContents.get(path) ?? "").buffer,
    );
    vi.mocked(harness.mutations.downloadFile).mockClear();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );

    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    // Cancellation lets the already-started read-only verification wave finish
    // and checkpoint; restart resumes only the eight untouched candidates.
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(8);
    expect(restartedState.confirmedDescendantFileReconstruction).toBeNull();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("recovers an interrupted repaired-subtree baseline from durable state without redownloading settled batches", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const {
      allPaths,
      remoteContents,
    } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      15,
    );
    let downloadCalls = 0;
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) => {
        downloadCalls++;
        if (downloadCalls === 11) {
          throw new Error("network interrupted");
        }
        return new TextEncoder().encode(
          remoteContents.get(path) ?? "",
        ).buffer;
      },
    );

    const interrupted = await harness.executor.run("manual");
    expect(interrupted).toMatchObject({
      success: false,
      deferred: 1,
      errors: 1,
      continueAfterConfirmedDescendantFileReconstruction: true,
      descendantFileReconstructionRetryableFailure: true,
    });
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(8);

    expect(harness.state.confirmedDescendantFileReconstruction)
      .not.toBeNull();
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(8);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) =>
        new TextEncoder().encode(remoteContents.get(path) ?? "").buffer,
    );
    vi.mocked(harness.mutations.downloadFile).mockClear();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );

    const recovered = await restartedExecutor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    // The failed four-file wave is not partially published. Restart verifies
    // that whole wave again plus the final three untouched files.
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(7);
    expect(
      allPaths.filter((path) => restartedState.getBaseEntry(path)).length,
    ).toBe(15);
    expect(restartedState.confirmedDescendantFileReconstruction).toBeNull();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("recognizes a pre-checkpoint repaired folder cohort and closes its remaining file baseline in one visible sync", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const folderOnlyRepair = await harness.executor.run("manual");
    expect(folderOnlyRepair).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.confirmedDescendantFileReconstruction).toBeNull();
    const { allPaths } = await addHashlessReconstructionFiles(
      harness,
      remotePluginFile.parentReference!.id!,
      15,
    );
    vi.mocked(harness.mutations.downloadFile).mockClear();

    const reconstructed = await harness.executor.run("manual");

    expect(reconstructed).toMatchObject({
      success: true,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(reconstructed.continueAfterConfirmedDescendantFileReconstruction)
      .toBeUndefined();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(15);
    expect(
      allPaths.filter((path) => harness.state.getBaseEntry(path)).length,
    ).toBe(15);
    expect(harness.state.confirmedDescendantFileReconstruction).toBeNull();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

});
