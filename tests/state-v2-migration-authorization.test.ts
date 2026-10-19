// 迁移授权、取消与首次同步预览
// 由 tests/state-v2-activation.test.ts 按主题拆分而来（纯搬运，用例名与断言未改）。 保留同名容器 describe，用例全名与拆分前一致。
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

describe("V1 to V2 controlled production activation", () => {
  it("discards corrupt-state evidence when the selected source changes during GET-only collection", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const corrupt = JSON.parse(
      harness.files.get(paths.stateV2File)!,
    ) as SyncStateEnvelopeV2;
    Object.values(corrupt.anchors.byAnchorId)[0]!.anchorId =
      "wrong-anchor";
    const rawCorrupt = JSON.stringify(corrupt);
    harness.files.set(paths.stateV2File, rawCorrupt);
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const evidence = restartedState.v2CorruptStateRecoveryEvidence!;
    const restoreByIdentity = vi.fn().mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    (harness.client as OneDriveClient & {
      restoreVaultScopeByIdentity: typeof restoreByIdentity;
    }).restoreVaultScopeByIdentity = restoreByIdentity;
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [...harness.remoteItemState],
        "@odata.deltaLink": "https://graph.example/corrupt-change-1",
      })
      .mockImplementationOnce(async () => {
        harness.files.set(
          paths.stateV2File,
          `${rawCorrupt} `,
        );
        return {
          value: [],
          "@odata.deltaLink": "https://graph.example/corrupt-change-2",
        };
      });
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
      undefined,
      undefined,
      harness.diag as never,
      harness.fileManager as never,
    );

    const result = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2CorruptState: true },
    );

    expect(result).toMatchObject({
      success: false,
      deferred: 1,
      message: "result.v2StateLoadBlocked",
    });
    expect(harness.files.get(
      `${paths.stateV2CorruptSourcePrefix}${evidence.sourceDigest}.json`,
    )).toBe(rawCorrupt);
    expect(harness.files.get(paths.stateV2File)).toBe(`${rawCorrupt} `);
    expect(harness.diag.warn).not.toHaveBeenCalledWith(
      "state",
      expect.stringContaining("GET-only candidate and canonical preview"),
      expect.anything(),
    );
    expectNoFileMutations(harness.mutations);
  });

  it("retires a V1 base tombstone only when complete local and remote snapshots have no candidate", async () => {
    const retiredBase: BaseFileEntry = {
      path: ".obsidian/plugins/easy-sync/~syncthing~remote-state.json.tmp",
      hash: hashB,
      size: 321,
      eTag: "etag-retired",
    };
    const harness = makeHarness({
      base: [baseA, retiredBase],
    });
    await harness.state.load();

    const result = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result).toEqual(expect.objectContaining({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    }));
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.baseSnapshot.map((entry) => entry.path)).toEqual([
      localA.path,
    ]);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    const backup = JSON.parse(harness.files.get(paths.stateV1BackupFile)!);
    expect(
      backup.snapshot.pluginData["easy-sync-base-snapshot"][retiredBase.path],
    ).toEqual(retiredBase);
    expectNoFileMutations(harness.mutations);
  });

  it("publishes the committed V2 envelope as a cTag-bound cloud recovery hint", async () => {
    const harness = makeHarness({ enableCloudBootstrap: true });
    await harness.state.load();

    const first = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(first.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.cloudBootstrap.create).toHaveBeenCalledOnce();
    expect(JSON.parse(harness.getCloudBootstrap()!.content)).toMatchObject({
      schemaVersion: 2,
      scope,
      revision: 1,
      anchors: [{
        remoteId: "file-a",
        lastPath: localA.path,
        contentHash: hashA,
        size: localA.size,
        remoteETag: "etag-a",
        remoteCTag: "ctag-a",
      }],
    });
    // The test executor performs the preview and confirmation runs, each of
    // which reads the migration hint; publication then performs its own
    // race-safe read before create-only. The stored checkpoint must make the
    // following stable V2 round request-free for this control object.
    expect(harness.cloudBootstrap.read).toHaveBeenCalledTimes(3);
    harness.cloudBootstrap.read.mockClear();

    const second = await harness.executor.run("manual");

    expect(second.success).toBe(true);
    expect(harness.cloudBootstrap.create).toHaveBeenCalledOnce();
    expect(harness.cloudBootstrap.read).not.toHaveBeenCalled();
    expect(harness.cloudBootstrap.update).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a cold-started active V2 community-plugin round to one delta request", async () => {
    const communityPluginContent = "[\"calendar\"]";
    const contentBytes = new TextEncoder().encode(communityPluginContent);
    const contentHash = await sha256Hex(contentBytes);
    const localCommunityPluginState: LocalFileEntry = {
      path: communityPluginPath,
      size: contentBytes.byteLength,
      mtime: 1,
      hash: contentHash,
      binary: false,
    };
    const harness = makeHarness({
      local: [localA, localCommunityPluginState],
      localFolders: [{ path: "Notes" }, { path: ".obsidian" }],
      remoteItems: remoteItemsWithCommunityPluginState(
        contentHash,
        contentBytes.byteLength,
      ),
      initialFiles: { [communityPluginPath]: communityPluginContent },
      remoteFileContents: { [communityPluginPath]: communityPluginContent },
      enableCloudBootstrap: true,
    });
    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "selected", pluginIds: ["calendar"] },
      data: { mode: "none", pluginIds: [] },
    });
    await harness.state.load();
    const activated = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );
    expect(activated.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new V2ActivationTestExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
      harness.diag as never,
      harness.fileManager as never,
      harness.localFolderPaths,
    );
    restartedExecutor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "selected", pluginIds: ["calendar"] },
      data: { mode: "none", pluginIds: [] },
    });
    harness.getDelta.mockClear();
    harness.mutations.downloadFile.mockClear();
    harness.cloudBootstrap.read.mockClear();
    harness.cloudBootstrap.create.mockClear();
    harness.cloudBootstrap.update.mockClear();
    harness.cloudBootstrap.readById.mockClear();
    harness.mutations.uploadFile.mockClear();
    harness.mutations.downloadFileToPath.mockClear();
    harness.mutations.deleteItem.mockClear();
    harness.mutations.renameItem.mockClear();

    const result = await restartedExecutor.run("manual");

    expect(result).toEqual(expect.objectContaining({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    }));
    expect(harness.getDelta).toHaveBeenCalledOnce();
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.cloudBootstrap.read).not.toHaveBeenCalled();
    expect(harness.cloudBootstrap.create).not.toHaveBeenCalled();
    expect(harness.cloudBootstrap.update).not.toHaveBeenCalled();
    expect(harness.cloudBootstrap.readById).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps V1 authoritative when the first-sync preview is declined", async () => {
    const harness = makeHarness();
    await harness.state.load();
    const onFirstSyncPreview = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "first",
      { onFirstSyncPreview },
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.pausedForReview");
    expect(onFirstSyncPreview).toHaveBeenCalledOnce();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("activates V2 after the first-sync preview accepts the exact zero plan", async () => {
    const harness = makeHarness();
    await harness.state.load();
    const onFirstSyncPreview = vi.fn().mockResolvedValue(true);

    const result = await harness.executor.run(
      "first",
      { onFirstSyncPreview },
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result.success).toBe(true);
    expect(onFirstSyncPreview).toHaveBeenCalledOnce();
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expect(harness.files.has(paths.remoteStateFile)).toBe(false);
    expect(JSON.parse(
      harness.files.get(paths.stateV1BackupFile)!,
    ).snapshot).toMatchObject({
      pluginData: {
        "easy-sync-base-snapshot": {
          [baseA.path]: baseA,
        },
      },
      remoteState: null,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("treats an accepted non-zero migration preview as inspection, not V1 execution", async () => {
    const harness = makeHarness({
      base: [],
      remoteHash: hashB,
    });
    await harness.state.load();

    const onConfirmThreshold = vi.fn().mockResolvedValue(true);
    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold },
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.pausedForReview");
    expect(result.conflicts).toBe(0);
    expect(onConfirmThreshold).toHaveBeenCalledOnce();
    expect(onConfirmThreshold.mock.calls[0]![0]).toMatchObject({
      canonicalIdentity: expect.any(Object),
      items: [expect.objectContaining({
        type: SyncActionType.Conflict,
        path: localA.path,
      })],
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("commits V2 authority before routing a reviewed non-zero migration plan to V2", async () => {
    const harness = makeHarness({
      base: [],
      remoteHash: hashB,
    });
    await harness.state.load();

    const preview = await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    expect(preview.message).toBe("result.pausedForReview");
    const authorization = harness.state.planReviewAuthorization;
    expect(authorization).toMatchObject({
      reviewKind: "v2-migration",
      canonicalIdentity: expect.any(Object),
    });

    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
    );

    expect(executed.conflicts).toBe(1);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.planReviewActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expect(JSON.parse(
      harness.files.get(paths.stateV2MigrationHoldFile)!,
    )).toMatchObject({ phase: "completed" });
    expectNoFileMutations(harness.mutations);
  });

  it("holds a local-only folder before V2 activation without creating it remotely", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    const onConfirmThreshold = vi.fn().mockResolvedValue(true);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold },
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("result.pausedForReview");
    expect(onConfirmThreshold).toHaveBeenCalledOnce();
    expect(onConfirmThreshold.mock.calls[0]![0]).toMatchObject({
      canonicalIdentity: expect.any(Object),
      items: [expect.objectContaining({
        type: SyncActionType.CreateRemoteFolder,
        path: "Empty",
      })],
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")).toBeNull();
    expectNoFileMutations(harness.mutations);
  });

  it("exposes cloud-only folders from the exact migration hold and retires its old authorization", async () => {
    const harness = makeHarness({
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-cloud-only",
          name: "Cloud-only",
          folder: { childCount: 0 },
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-cloud-only",
        },
      ],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const authorization = harness.state.planReviewAuthorization!;
    const hold = harness.state.activeV2MigrationHold!;

    await expect(
      harness.state.createSyncExclusionFolderSnapshot(scope.accountId),
    ).resolves.toEqual({
      hadPendingReview: true,
      remoteFolderPaths: ["Cloud-only", "Notes"],
    });
    expectNoFileMutations(harness.mutations);

    await expect(
      harness.state.clearPlanReview(authorization),
    ).resolves.toBe(true);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.planReviewActive).toBe(false);
    await expect(harness.state.isCurrentV2MigrationAuthorization({
      authorization,
      candidate: hold.candidate,
      canonicalIdentity: hold.canonicalIdentity,
    })).resolves.toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("masks an ordinary stored review without rewriting V1, then retires it on migration cancellation", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.state.setPlanReviewBundle(
      [],
      {
        uploads: 0,
        downloads: 0,
        folders: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      scope,
    );
    expect(harness.state.planReviewActive).toBe(true);

    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );

    expect(harness.state.activeV2MigrationHold?.phase).toBe("pending");
    expect(
      harness.pluginData["easy-sync-plan-review-active"],
    ).toBe(true);
    expect(harness.state.planReviewAuthorization?.reviewKind).toBe(
      "v2-migration",
    );
    await expect(harness.state.clearPlanReview()).resolves.toBe(true);
    expect(
      harness.pluginData["easy-sync-plan-review-active"],
    ).toBe(false);
    expect(harness.state.planReviewActive).toBe(false);
  });

  it("executes an accepted folder migration only after V2 becomes authoritative", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();

    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const authorization = harness.state.planReviewAuthorization;
    expect(authorization?.reviewKind).toBe("v2-migration");

    const result = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
    );

    expect(result).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
      deferred: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.folder)
      .toBeTruthy();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toContain("Empty");
  });

  it("retires the masked public-1.1.3 review before a completed migration hold becomes inactive", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.state.setPlanReviewBundle(
      [],
      {
        uploads: 0,
        downloads: 0,
        folders: 0,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      scope,
    );

    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const authorization = harness.state.planReviewAuthorization!;
    const result = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );

    expect(result.success).toBe(true);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.planReviewActive).toBe(false);
    expect(
      harness.pluginData["easy-sync-plan-review-active"],
    ).toBe(false);
  });

  it("retries an exact confirmed hold after a pre-manifest failure without a second confirmation", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.failManifestRenameOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    // F31 第十处：真拒绝也被写通道把 manifest 落面（恢复接管用）。
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);

    // 与响应丢失形态一致：写通道落面后，接管走重启恢复（hold 保持
    // confirmed，无需第二次审阅确认）。
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new V2ActivationTestExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
      harness.diag as never,
      harness.fileManager as never,
      harness.localFolderPaths,
    );
    const resumed = await restartedExecutor.run(
      "manual",
      {},
      true,
      restartedState.planReviewAuthorization!,
    );

    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.activeV2MigrationHold).toBeNull();
    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
  });

  it("discards stale pre-manifest state before staging a changed replacement hold", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.failManifestRenameOnce();
    await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);

    harness.localFolderPaths.add("Later");
    const replacementPreview = vi.fn().mockResolvedValue(false);
    const recalculated = await harness.executor.run(
      "manual",
      { onConfirmThreshold: replacementPreview },
      true,
      harness.state.planReviewAuthorization!,
    );

    // F31 第十处：manifest 落面后同一运行时处于保守块——替换挂审被锁，
    // 恢复激活是唯一出口；旧史料（V1 备份/envelope/manifest）全部留面。
    expect(recalculated.message).toBe("result.v2StateLoadBlocked");
    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);

    // 落门断点后的接管走重启恢复（与响应丢失形态一致）。
    const committedState = new StateManager(harness.plugin);
    await committedState.load();
    const committedExecutor = new V2ActivationTestExecutor(
      harness.client,
      harness.scanner,
      committedState,
      "testVault",
      harness.diag as never,
      harness.fileManager as never,
      harness.localFolderPaths,
    );
    if (committedState.activeV2MigrationHold) {
      // 落门激活已接管 hold：收编不再需要用户二次确认。
      await committedState.clearPlanReview();
    }
    const committed = await committedExecutor.run(
      "manual",
      {},
      true,
      committedState.planReviewAuthorization!,
    );
    expect(committed).toMatchObject({
      success: true,
      foldersCreated: 2,
      errors: 0,
    });
    expect(committedState.isV2StateActive).toBe(true);
  });

  it("cancels a confirmed pre-manifest migration and removes only prepared artifacts", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.failManifestRenameOnce();
    await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    // F31 第十处：manifest 落面＝V2 落门，取消保守拒绝，prepared 收纳供恢复。
    await expect(harness.state.clearPlanReview(
      harness.state.planReviewAuthorization!,
    )).resolves.toBe(false);

    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("recovers an interrupted hold authority transition after manifest and witness commit", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.failHoldAuthorityRenameOnce();
    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(interrupted.message).toBe("result.syncFailed");
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeV2MigrationHold?.phase).toBe(
      "authority-committed",
    );
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const resumed = await restartedExecutor.run(
      "manual",
      {},
      true,
      restartedState.planReviewAuthorization!,
    );

    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(restartedState.activeV2MigrationHold).toBeNull();
  });

  it("resumes the committed hold authority after its rename response was lost", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.loseHoldAuthorityRenameResponseOnce();
    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(interrupted.message).toBe("result.syncFailed");
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
    expect(JSON.parse(
      harness.files.get(paths.stateV2MigrationHoldFile)!,
    )).toMatchObject({ phase: "authority-committed" });
    expect(harness.files.has(paths.stateV2MigrationHoldNextFile)).toBe(false);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeV2MigrationHold?.phase).toBe(
      "authority-committed",
    );
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const resumed = await restartedExecutor.run(
      "manual",
      {},
      true,
      restartedState.planReviewAuthorization!,
    );

    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(restartedState.activeV2MigrationHold).toBeNull();
  });

  it("does not repeat a completed user mutation when hold completion is interrupted", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.failHoldCompletionRenameOnce();
    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(interrupted.message).toBe("result.syncFailed");
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.folder)
      .toBeTruthy();
    expect(harness.state.mutationLedger).toEqual([]);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeV2MigrationHold).toBeNull();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const resumed = await restartedExecutor.run("manual");

    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 0,
      errors: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
  });

  it("completes an authority hold as already converged when the completion write never started", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.failHoldCompletionWriteOnce();
    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(interrupted.message).toBe("result.syncFailed");
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(harness.state.activeV2MigrationHold?.phase).toBe(
      "authority-committed",
    );
    expect(harness.state.mutationLedger).toEqual([]);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const replacementPreview = vi.fn().mockResolvedValue(false);
    const resumed = await restartedExecutor.run(
      "manual",
      { onConfirmThreshold: replacementPreview },
      true,
      restartedState.planReviewAuthorization!,
    );

    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 0,
      errors: 0,
    });
    expect(replacementPreview).not.toHaveBeenCalled();
    expect(restartedState.activeV2MigrationHold).toBeNull();
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
  });

  it("does not repeat a user mutation after completed-hold write response loss", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.loseHoldCompletionWriteResponseOnce();
    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(interrupted.message).toBe("result.syncFailed");
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(JSON.parse(
      harness.files.get(paths.stateV2MigrationHoldNextFile)!,
    )).toMatchObject({ phase: "completed" });

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeV2MigrationHold).toBeNull();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const resumed = await restartedExecutor.run("manual");

    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 0,
      errors: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
  });

  it("does not repeat a user mutation after completed-hold rename response loss", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    harness.loseHoldCompletionRenameResponseOnce();
    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(interrupted.message).toBe("result.syncFailed");
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(JSON.parse(
      harness.files.get(paths.stateV2MigrationHoldFile)!,
    )).toMatchObject({ phase: "completed" });
    expect(harness.files.has(paths.stateV2MigrationHoldNextFile)).toBe(false);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.activeV2MigrationHold).toBeNull();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const resumed = await restartedExecutor.run("manual");

    expect(resumed).toMatchObject({
      success: true,
      foldersCreated: 0,
      errors: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
  });

  it("resumes an authority-committed migration hold after restart without returning to V1", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();

    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const authorization = harness.state.planReviewAuthorization!;
    const pending = harness.state.activeV2MigrationHold!;
    const confirmed = await harness.state.confirmV2MigrationHold({
      authorization,
      candidate: pending.candidate,
      canonicalIdentity: pending.canonicalIdentity,
      communityPluginEnablement: pending.communityPluginEnablement,
      protocolBinding,
    });
    const committed = await harness.state.commitConfirmedV2MigrationHold(
      confirmed!,
    );
    expect(committed.hold.phase).toBe("authority-committed");

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const resumedAuthorization = restartedState.planReviewAuthorization;
    expect(resumedAuthorization).toMatchObject({
      reviewKind: "v2-migration",
    });

    const result = await restartedExecutor.run(
      "manual",
      {},
      true,
      resumedAuthorization!,
    );

    expect(result).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
      deferred: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.activeV2MigrationHold).toBeNull();
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.folder)
      .toBeTruthy();
  });

  it("rejects a restarted migration authorization when remote item facts changed after authority commit", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();

    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const authorization = harness.state.planReviewAuthorization!;
    const pending = harness.state.activeV2MigrationHold!;
    const confirmed = await harness.state.confirmV2MigrationHold({
      authorization,
      candidate: pending.candidate,
      canonicalIdentity: pending.canonicalIdentity,
      communityPluginEnablement: pending.communityPluginEnablement,
      protocolBinding,
    });
    await harness.state.commitConfirmedV2MigrationHold(confirmed!);

    const notes = findRemoteItemByPath(harness.remoteItemState, "Notes")!;
    notes.eTag = `${notes.eTag}-changed-after-review`;

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const publishReplacementReview = vi.fn().mockResolvedValue(false);
    const result = await restartedExecutor.run(
      "manual",
      { onConfirmThreshold: publishReplacementReview },
      true,
      restartedState.planReviewAuthorization!,
    );

    expect(result).toMatchObject({
      success: false,
      foldersCreated: 0,
      errors: 0,
      deferred: 0,
      message: "result.pausedForReview",
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.activeV2MigrationHold).toBeNull();
    expect(publishReplacementReview).toHaveBeenCalledOnce();
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")).toBeNull();
  });

  it("replaces a stale migration hold before shared protocol I/O when facts changed before confirmation", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();

    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const staleAuthorization = harness.state.planReviewAuthorization!;
    harness.localFolderPaths.add("Later");
    const replacementPreview = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: replacementPreview },
      true,
      staleAuthorization,
      { acknowledgeMigrationRisk: true },
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(replacementPreview).toHaveBeenCalledOnce();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      revision: staleAuthorization.revision + 1,
      items: expect.arrayContaining([
        expect.objectContaining({ path: "Empty" }),
        expect.objectContaining({ path: "Later" }),
      ]),
    });
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("expires a migration authorization when non-plan public state changed", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const staleAuthorization = harness.state.planReviewAuthorization!;
    const staleSourceDigest =
      harness.state.activeV2MigrationHold!.sourceStateDigest;
    await harness.state.setLastSyncTime(1234);
    const replacementPreview = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: replacementPreview },
      true,
      staleAuthorization,
      { acknowledgeMigrationRisk: true },
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(replacementPreview).toHaveBeenCalledOnce();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      revision: staleAuthorization.revision + 1,
    });
    expect(harness.state.activeV2MigrationHold!.sourceStateDigest)
      .not.toBe(staleSourceDigest);
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("rechecks public source after protocol creation and never commits a hold changed during the request", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const staleAuthorization = harness.state.planReviewAuthorization!;
    const originalCreateProtocol = vi.mocked(
      harness.client.createSharedSyncProtocolV2,
    ).getMockImplementation()!;
    vi.mocked(harness.client.createSharedSyncProtocolV2)
      .mockImplementationOnce(async (vaultName, content) => {
        await harness.state.setLastSyncTime(1234);
        return originalCreateProtocol(vaultName, content);
      });

    const interruptedBySourceChange = await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      true,
      staleAuthorization,
      { acknowledgeMigrationRisk: true },
    );

    expect(interruptedBySourceChange).toMatchObject({
      success: false,
      errors: 1,
      message: "result.syncFailed",
    });
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.readSharedSyncProtocolV2ById)
      .toHaveBeenCalledOnce();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold?.phase).toBe("pending");
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);

    vi.mocked(harness.client.readSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.createSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.readSharedSyncProtocolV2ById).mockClear();
    const replacementPreview = vi.fn().mockResolvedValue(false);
    const recalculated = await harness.executor.run(
      "manual",
      { onConfirmThreshold: replacementPreview },
      true,
      staleAuthorization,
      { acknowledgeMigrationRisk: true },
    );

    expect(recalculated.message).toBe("result.pausedForReview");
    expect(replacementPreview).toHaveBeenCalledOnce();
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      revision: staleAuthorization.revision + 1,
    });
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV2ById)
      .not.toHaveBeenCalled();
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("expires a migration authorization when the public base-content sidecar changed", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
      initialFiles: {
        [paths.baseContentFile]: JSON.stringify({
          "Notes/a.md": "before review",
        }),
      },
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const staleAuthorization = harness.state.planReviewAuthorization!;
    const staleSourceDigest =
      harness.state.activeV2MigrationHold!.sourceStateDigest;
    harness.files.set(paths.baseContentFile, JSON.stringify({
      "Notes/a.md": "changed after review",
    }));
    const replacementPreview = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: replacementPreview },
      true,
      staleAuthorization,
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(replacementPreview).toHaveBeenCalledOnce();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      revision: staleAuthorization.revision + 1,
    });
    expect(harness.state.activeV2MigrationHold!.sourceStateDigest)
      .not.toBe(staleSourceDigest);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("binds migration authorization to settings and unknown public PluginData keys", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
      pluginData: {
        "sync-interval": 3,
        "release-1.1.3-unknown-key": { mustSurvive: true },
      },
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
      false,
      undefined,
      { activateV2State: true },
    );
    const staleAuthorization = harness.state.planReviewAuthorization!;
    const staleSourceDigest =
      harness.state.activeV2MigrationHold!.sourceStateDigest;
    harness.pluginData["sync-interval"] = 9;
    (
      harness.pluginData["release-1.1.3-unknown-key"] as {
        mustSurvive: boolean;
      }
    ).mustSurvive = false;
    const replacementPreview = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: replacementPreview },
      true,
      staleAuthorization,
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(replacementPreview).toHaveBeenCalledOnce();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      revision: staleAuthorization.revision + 1,
    });
    expect(harness.state.activeV2MigrationHold!.sourceStateDigest)
      .not.toBe(staleSourceDigest);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("does not activate from an incomplete local folder topology", async () => {
    // Real-device shape: two vault folders whose names differ only by case
    // (e.g. TOOLS and tools on iOS). The scan reports them as normalized
    // path conflicts, activation stays fail-closed, and the history message
    // names the clash instead of pretending files were deferred.
    const harness = makeHarness({
      folderScanComplete: false,
      folderScanFailures: ["TOOLS", "tools"],
    });
    await harness.state.load();

    const result = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(0);
    expect(result.message).toBe("result.folderNameClash");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("reuses the exact public backup after its durable write response was lost", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.loseV1BackupWriteResponseOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    const durableBackup = harness.files.get(paths.stateV1BackupFile);
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new V2ActivationTestExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
      harness.diag as never,
      harness.fileManager as never,
      harness.localFolderPaths,
    );
    const resumed = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(resumed.success).toBe(true);
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(harness.files.get(paths.stateV1BackupFile)).toBe(durableBackup);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("reuses the exact envelope after the staged manifest write response was lost", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.loseManifestStagedWriteResponseOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestNextFile)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    const durableEnvelope = harness.files.get(paths.stateV2File);
    const durableBackup = harness.files.get(paths.stateV1BackupFile);
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(false);
    const restartedExecutor = new V2ActivationTestExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
      harness.diag as never,
      harness.fileManager as never,
      harness.localFolderPaths,
    );
    const resumed = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(resumed.success).toBe(true);
    expect(restartedState.isV2StateActive).toBe(true);
    expect(harness.files.get(paths.stateV2File)).toBe(durableEnvelope);
    expect(harness.files.get(paths.stateV1BackupFile)).toBe(durableBackup);
    expect(harness.files.has(paths.stateV2ManifestNextFile)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("selects V2 immediately when committed manifest read-back was interrupted", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.failManifestCommittedReadOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "migration-authority-commit-interrupted",
    });
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();

    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("promotes a staged authority witness after its write response was lost", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.loseAuthorityWitnessWriteResponseOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "authority-witness-save-failed",
    });
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();

    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("accepts a committed authority witness after its initial write response was lost", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.loseAuthorityWitnessCommittedWriteResponseOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "authority-witness-save-failed",
    });
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();

    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessNextFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("does not half-switch on manifest failure and resumes from the same facts", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.failManifestRenameOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted.success).toBe(false);
    // F31 第十处：写通道落面 manifest＝中断保守块（legacy false）。
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new V2ActivationTestExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
      harness.diag as never,
      harness.fileManager as never,
      harness.localFolderPaths,
    );
    expect(restartedState.isV2StateActive).toBe(true);

    const resumed = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(resumed.success).toBe(true);
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("closes the V1 writer immediately when a manifest commits but its rename response is lost", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.commitManifestThenThrowOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "migration-authority-commit-interrupted",
    });
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
  });

  it("keeps V2 authority blocked and recovers after witness publication fails", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.failAuthorityWitnessWriteOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "authority-witness-save-failed",
    });

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("recovers a failed first envelope publication before retrying activation", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.failStateRenameOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(interrupted.success).toBe(false);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new V2ActivationTestExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
      harness.diag as never,
      harness.fileManager as never,
      harness.localFolderPaths,
    );
    const resumed = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(resumed.success).toBe(true);
    expect(restartedState.isV2StateActive).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2RecoveryFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("cancels during the complete identity read without publishing V2 state", async () => {
    const harness = makeHarness();
    await harness.state.load();
    harness.runOnNextDelta(() => harness.executor.cancel());

    const cancelled = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(cancelled.success).toBe(false);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });
});
