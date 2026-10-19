// V2 自愈与 slice-2 记录层
// 由 tests/state-v2-activation.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。
import "fake-indexeddb/auto";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

describe("planner-derived pending issue self-healing", () => {
  it("retires a stale planner-derived issue row even when a review gate pauses the round", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    await harness.state.reconcilePendingIssues([
      {
        path: "Notes",
        actionType: SyncActionType.FolderDeferred,
        issueCode: "anchored-folder-missing-local",
        reason: "folder missing locally",
        updatedAt: 1,
      },
      {
        path: "retry.md",
        actionType: SyncActionType.RetryLater,
        reason: "network",
        updatedAt: 1,
      },
    ], []);
    expect(harness.state.pendingIssues).toHaveLength(2);

    const paused = await harness.executor.run(
      "first",
      { onFirstSyncPreview: vi.fn(async () => false) },
    );
    expect(paused.message).toBe("result.pausedForReview");

    // The stale planner-derived row retired under the gate; the execution-
    // phase transient keeps its retry semantics.
    expect(harness.state.pendingIssues).toEqual([
      {
        path: "retry.md",
        actionType: SyncActionType.RetryLater,
        reason: "network",
        updatedAt: 1,
      },
    ]);
  });
});

describe("shared protocol V2 slot self-healing", () => {
  it("repairs a deviant V2 predecessor slot from a validated V3 binding", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    const originalV2 = harness.getSharedProtocolV2();
    expect(originalV2).not.toBeNull();

    // Deviate the V2 slot in place: same scope/createdAt, different
    // migration generation (the luyi generation-mismatch shape).
    harness.seedSharedProtocolContent(JSON.stringify({
      schemaVersion: 1,
      kind: "easy-sync-v2-protocol",
      protocolVersion: 2,
      migrationGeneration: hashB,
      scope,
      confirmedAllDevicesUpdatedAt:
        protocolBinding.confirmedAllDevicesUpdatedAt,
      createdAt: protocolBinding.confirmedAllDevicesUpdatedAt,
    }));

    const result = await harness.executor.run("manual");
    expect(result.success).toBe(true);
    expect(result.errors).toBe(0);

    const repairedV2 = harness.getSharedProtocolV2();
    expect(repairedV2).not.toBeNull();
    expect(repairedV2!.content).toBe(originalV2!.content);
    expect(repairedV2!.eTag).toBe("protocol-recovered-etag-overwritten");
  });

  it("keeps the fail-closed result when the V3 slot cannot validate the binding", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    const originalV3 = harness.getSharedProtocolV3();
    expect(originalV3).not.toBeNull();

    // Deviate BOTH slots so no binding evidence can prove a canonical side.
    harness.seedSharedProtocolContent(JSON.stringify({
      schemaVersion: 1,
      kind: "easy-sync-v2-protocol",
      protocolVersion: 2,
      migrationGeneration: hashB,
      scope,
      confirmedAllDevicesUpdatedAt:
        protocolBinding.confirmedAllDevicesUpdatedAt,
      createdAt: protocolBinding.confirmedAllDevicesUpdatedAt,
    }));
    harness.seedSharedProtocolV3(JSON.stringify({
      ...JSON.parse(originalV3!.content),
      migrationGeneration: hashB,
    }));

    const result = await harness.executor.run("manual");
    expect(result.success).toBe(false);
    expect(result.message).toBe("result.v2ProtocolBlocked");

    // No repair happened: both slots keep their deviant contents.
    const v2After = harness.getSharedProtocolV2();
    expect(JSON.parse(v2After!.content).migrationGeneration).toBe(hashB);
  });
});

// ---- 切片 2：文件移出同步范围的去向 hint（记录层，红测先行）----

describe("slice-2 file out-of-scope move hints (record layer)", () => {
  async function activatedHarness() {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    return harness;
  }

  it("binds a move of a synced file to its committed identity and retains the destination", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);

    expect(harness.state.localFileMoveHints).toEqual([
      expect.objectContaining({
        version: 1,
        scope,
        remoteId: "file-a",
        fromPath: "Notes/a.md",
        toPath: "Archive/a.md",
      }),
    ]);
  });

  it("rejects a move whose source path is not bound to a committed file anchor", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/never-synced.md",
      "Archive/never-synced.md",
    )).toBe(false);
    expect(harness.state.localFileMoveHints).toEqual([]);
  });

  it("rejects non-vault-relative or identity-equal moves", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFileMoveHint(
      "C:/outside/a.md",
      "Archive/a.md",
    )).toBe(false);
    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Notes/a.md",
    )).toBe(false);
    expect(harness.state.localFileMoveHints).toEqual([]);
  });

  it("chains a second out-of-scope move back to the original synced path", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);
    expect(await harness.state.recordLocalFileMoveHint(
      "Archive/a.md",
      "Archive/sub/a.md",
    )).toBe(true);

    expect(harness.state.localFileMoveHints).toHaveLength(1);
    expect(harness.state.localFileMoveHints[0]).toMatchObject({
      remoteId: "file-a",
      fromPath: "Notes/a.md",
      toPath: "Archive/sub/a.md",
    });
  });

  it("keeps one hint per remote id and replaces it on a newer move", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);
    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive-2/a.md",
    )).toBe(true);

    expect(harness.state.localFileMoveHints).toHaveLength(1);
    expect(harness.state.localFileMoveHints[0]).toMatchObject({
      remoteId: "file-a",
      fromPath: "Notes/a.md",
      toPath: "Archive-2/a.md",
    });
  });

  it("retains nothing when the file moves back to its original synced path", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);
    expect(await harness.state.recordLocalFileMoveHint(
      "Archive/a.md",
      "Notes/a.md",
    )).toBe(true);

    expect(harness.state.localFileMoveHints).toEqual([]);
  });

  it("keeps folder move hints untouched while file hints are recorded", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive"))
      .toBe(true);
    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);

    expect(harness.state.localFolderMoveHints).toHaveLength(1);
    expect(harness.state.localFileMoveHints).toHaveLength(1);
  });
});

// ---- 切片 2：文件移出同步范围 → 规划层 hold（红测先行）----

describe("slice-2 file scope-crossing planner hold", () => {
  async function activatedHarness() {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    return harness;
  }

  function excludeArchive(harness: ReturnType<typeof makeHarness>): void {
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path: string) => !path.startsWith("Archive"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path: string) => !path.startsWith("Archive"),
    );
  }

  it("holds the remote deletion of a file moved out of sync scope and raises a scope-crossing row", async () => {
    const harness = await activatedHarness();
    excludeArchive(harness);

    // 文件被移进已排除目录：旧路径仍被扫描覆盖（本地缺失、远端未变），
    // 现役会静默 DeleteRemote。去向 hint 应把该删除 hold 成一行待表态。
    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);
    harness.localEntryState.splice(0);

    const held = await harness.executor.run("manual");

    expect(held).toMatchObject({
      success: true,
      deleted: 0,
      errors: 0,
      deferred: 1,
    });
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({
        path: "Notes/a.md",
        issueCode: "scope-crossing",
      }),
    ]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).not.toBeNull();
    expect(harness.state.mutationLedger).toHaveLength(0);

    // 表态前每轮稳定挂起，不静默删、不收敛成删除。
    const again = await harness.executor.run("manual");
    expect(again).toMatchObject({ success: true, deleted: 0, errors: 0 });
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({
        path: "Notes/a.md",
        issueCode: "scope-crossing",
      }),
    ]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).not.toBeNull();
  });

  it("keeps the silent trash deletion semantics even when a file hint points into .trash", async () => {
    const harness = await activatedHarness();

    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      ".trash/a.md",
    )).toBe(true);
    harness.localEntryState.splice(0);

    const deleted = await harness.executor.run("manual");

    expect(deleted).toMatchObject({
      success: true,
      deleted: 1,
      errors: 0,
      deferred: 0,
    });
    expect(harness.state.pendingIssues).toEqual([]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).toBeNull();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("raises only the folder row when a folder move carries the file out of scope", async () => {
    const harness = await activatedHarness();
    excludeArchive(harness);

    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive"))
      .toBe(true);
    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);
    harness.localEntryState.splice(0);
    harness.localFolderPaths.delete("Notes");

    const held = await harness.executor.run("manual");

    expect(held).toMatchObject({
      success: true,
      deleted: 0,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({
        path: "Notes",
        issueCode: "scope-crossing",
      }),
    ]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).not.toBeNull();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });
});

// ---- 切片 2：scope-crossing 行出口（撤销移动 / 确认移出同步）----

describe("slice-2 scope-crossing exit actions", () => {
  async function activatedHarness() {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    return harness;
  }

  function excludeArchive(harness: ReturnType<typeof makeHarness>): void {
    vi.mocked(harness.scanner.shouldSyncPath).mockImplementation(
      (path: string) => !path.startsWith("Archive"),
    );
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path: string) => !path.startsWith("Archive"),
    );
  }

  /** 单个文件移出范围（本地仍在 Archive，扫描不可见），跑出一行后返回快照。 */
  async function fileExitHarness() {
    const harness = await activatedHarness();
    excludeArchive(harness);
    expect(await harness.state.recordLocalFileMoveHint(
      "Notes/a.md",
      "Archive/a.md",
    )).toBe(true);
    harness.localEntryState[0]!.path = "Archive/a.md";
    const held = await harness.executor.run("manual");
    expect(held).toMatchObject({ success: true, deleted: 0, errors: 0 });
    return harness;
  }

  /** 文件夹整树移出范围（本地整树在 Archive，扫描不可见）。 */
  async function folderExitHarness() {
    const harness = await activatedHarness();
    excludeArchive(harness);
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive"))
      .toBe(true);
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("Archive");
    harness.localEntryState[0]!.path = "Archive/a.md";
    const held = await harness.executor.run("manual");
    expect(held).toMatchObject({ success: true, deleted: 0, errors: 0 });
    return harness;
  }

  it("restores a held file move to its original synced path", async () => {
    const harness = await fileExitHarness();

    const snapshot = readySnapshot(
      await harness.executor.getScopeCrossingResolutionSnapshot(
        "Notes/a.md",
      ),
    );
    expect(snapshot).toMatchObject({
      version: 1,
      kind: "file",
      rowPath: "Notes/a.md",
      fromPath: "Notes/a.md",
      toPath: "Archive/a.md",
      remoteId: "file-a",
    });

    expect(await harness.executor.restoreScopeCrossingMove(snapshot!)).toBe(true);
    expect(harness.localEntryState[0]!.path).toBe("Notes/a.md");
    expect(harness.state.localFileMoveHints).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.scanner.vault.rename).toHaveBeenCalledOnce();

    const after = await harness.executor.run("manual");
    expect(after).toMatchObject({ success: true, deleted: 0, errors: 0 });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).not.toBeNull();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("deletes the cloud copy on the next round after a confirmed file exit", async () => {
    const harness = await fileExitHarness();

    const snapshot = readySnapshot(
      await harness.executor.getScopeCrossingResolutionSnapshot(
        "Notes/a.md",
      ),
    );
    expect(snapshot).not.toBeNull();
    expect(await harness.executor.confirmScopeCrossingExit(snapshot!)).toBe(true);
    expect(harness.state.localFileMoveHints).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);

    const deleted = await harness.executor.run("manual");
    expect(deleted).toMatchObject({
      success: true,
      deleted: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(
      (
        await harness.executor.getScopeCrossingResolutionSnapshot("Notes/a.md")
      ).snapshot,
    ).toBeNull();
  });

  it("restores a held folder move subtree to its original location", async () => {
    const harness = await folderExitHarness();

    const snapshot = readySnapshot(
      await harness.executor.getScopeCrossingResolutionSnapshot(
        "Notes",
      ),
    );
    expect(snapshot).toMatchObject({
      version: 1,
      kind: "folder",
      rowPath: "Notes",
      fromPath: "Notes",
      toPath: "Archive",
    });

    expect(await harness.executor.restoreScopeCrossingMove(snapshot!)).toBe(true);
    expect(harness.localFolderPaths.has("Notes")).toBe(true);
    expect(harness.localFolderPaths.has("Archive")).toBe(false);
    expect(harness.localEntryState[0]!.path).toBe("Notes/a.md");
    expect(harness.state.localFolderMoveHints).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);

    const after = await harness.executor.run("manual");
    expect(after).toMatchObject({ success: true, deleted: 0, errors: 0 });
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("deletes the remote subtree on the next round after a confirmed folder exit", async () => {
    const harness = await folderExitHarness();

    const snapshot = readySnapshot(
      await harness.executor.getScopeCrossingResolutionSnapshot(
        "Notes",
      ),
    );
    expect(snapshot).not.toBeNull();
    expect(await harness.executor.confirmScopeCrossingExit(snapshot!)).toBe(true);
    expect(harness.state.localFolderMoveHints).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);

    const deleted = await harness.executor.run("manual");
    expect(deleted).toMatchObject({
      success: true,
      deleted: 1,
      foldersDeleted: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")).toBeNull();
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("rejects a reviewed exit once the move facts drifted", async () => {
    const harness = await fileExitHarness();
    const snapshot = readySnapshot(
      await harness.executor.getScopeCrossingResolutionSnapshot(
        "Notes/a.md",
      ),
    );
    expect(snapshot).not.toBeNull();

    // 快照期间用户把文件又移走了（hint 链更新），旧快照必须失效。
    expect(await harness.state.recordLocalFileMoveHint(
      "Archive/a.md",
      "Archive/sub/a.md",
    )).toBe(true);

    expect(await harness.executor.restoreScopeCrossingMove(snapshot!)).toBe(false);
    expect(harness.state.localFileMoveHints).toHaveLength(1);
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({ path: "Notes/a.md", issueCode: "scope-crossing" }),
    ]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")).not.toBeNull();
  });
});

