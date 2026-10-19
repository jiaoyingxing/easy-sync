// 残留恢复、作用域与游标重建
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
  it("drops a scope-mismatched or corrupt subtree reconstruction checkpoint without using it as authority", async () => {
    const {
      harness,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: true,
    });
    const accepted =
      await harness.state.acceptConfirmedDescendantFolderAnchors({
        scope,
        localFiles: harness.localEntryState,
        localFolders: [...harness.localFolderPaths].map((path) => ({ path })),
        localFolderScanComplete: true,
        remoteIdentityComplete: true,
      });
    expect(accepted.status).toBe("accepted");
    const checkpointKey =
      "easy-sync-confirmed-descendant-file-reconstruction";
    const checkpoint = structuredClone(
      harness.pluginData[checkpointKey],
    ) as {
      scope: SyncScope;
    };
    checkpoint.scope = {
      ...checkpoint.scope,
      accountId: "other-account",
    };
    harness.pluginData[checkpointKey] = checkpoint;
    const mismatchedState = new StateManager(harness.plugin);
    await mismatchedState.load();
    const sourceCommitSeq =
      mismatchedState.getCommittedV2Envelope()!.meta.commitSeq;

    const mismatch = await mismatchedState
      .prepareConfirmedDescendantFileReconstruction({
        scope,
        localFolders: [...harness.localFolderPaths].map((path) => ({ path })),
        candidateItems: [],
      });

    expect(mismatch).toEqual({ status: "none", roots: [] });
    expect(mismatchedState.confirmedDescendantFileReconstruction).toBeNull();
    expect(mismatchedState.getCommittedV2Envelope()!.meta.commitSeq)
      .toBe(sourceCommitSeq);

    harness.pluginData[checkpointKey] = {
      version: 1,
      kind: "confirmed-descendant-file-reconstruction",
      roots: "corrupt",
    };
    const corruptState = new StateManager(harness.plugin);
    await corruptState.load();
    expect(corruptState.confirmedDescendantFileReconstruction).toBeNull();
  });

  it("keeps an unanchored folder chain deferred when the unanchored descendant content differs", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: false,
    });
    const remoteItem = harness.remoteItemState.find(
      (item) => item.id === remotePluginFile.id,
    )!;
    remoteItem.file!.hashes = { sha256Hash: hashA };

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      success: true,
      deferred: 3,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).not.toContainEqual(expect.objectContaining({
      remoteId: remotePluginFile.id,
    }));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("does not publish unanchored descendant evidence when the state recovery gate is blocked", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: false,
    });
    const recoveryGate = vi.spyOn(
      harness.state,
      "acceptConfirmedDescendantFolderAnchors",
    ).mockResolvedValue({
      status: "blocked",
      accepted: 0,
      evidenceFiles: 0,
    });

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      success: true,
      deferred: 3,
      errors: 0,
    });
    expect(recoveryGate).toHaveBeenCalledOnce();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).not.toContainEqual(expect.objectContaining({
      remoteId: remotePluginFile.id,
    }));
    expectNoFileMutations(harness.mutations);
  });

  it("discards exact descendant evidence when the remote version changes before publication", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors({
      seedFileAnchor: false,
    });
    harness.client.getFileMetadata.mockResolvedValueOnce({
      eTag: `${remotePluginFile.eTag}-changed`,
      cTag: remotePluginFile.cTag ?? "",
      size: remotePluginFile.size ?? 0,
      sha256Hash: remotePluginFile.file?.hashes?.sha256Hash,
      driveId: remotePluginFile.id,
      parentId: remotePluginFile.parentReference?.id,
      mtime: Date.parse(remotePluginFile.lastModifiedDateTime!),
    });

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      success: true,
      deferred: 3,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).not.toContainEqual(expect.objectContaining({
      remoteId: remotePluginFile.id,
    }));
    expectNoFileMutations(harness.mutations);
  });

  it("keeps missing folder anchors fail-closed when the descendant remote identity and content were replaced", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors();
    const originalId = remotePluginFile.id;
    const replacementId = `${originalId}-replacement`;
    const replacement = {
      ...harness.state.remoteSnapshot.find(
        (entry) => entry.driveId === originalId,
      )!,
      driveId: replacementId,
      eTag: `${remotePluginFile.eTag}-replacement`,
      sha256Hash: hashA,
    };
    const remoteItem = harness.remoteItemState.find(
      (item) => item.id === originalId,
    )!;
    remoteItem.id = replacementId;
    remoteItem.eTag = replacement.eTag;
    remoteItem.file!.hashes = { sha256Hash: hashA };
    await harness.state.setRemoteState(
      [
        ...harness.state.remoteSnapshot.filter(
          (entry) => entry.driveId !== originalId,
        ),
        replacement,
      ],
      "https://graph.example/delta-current",
      scope,
      harness.state.remoteFolders,
    );

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 3,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("does not let an unchanged remote eTag override a contradictory content hash", async () => {
    const {
      harness,
      remotePluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors();
    const remoteItem = harness.remoteItemState.find(
      (item) => item.id === remotePluginFile.id,
    )!;
    remoteItem.file!.hashes = { sha256Hash: hashA };
    await harness.state.setRemoteState(
      harness.state.remoteSnapshot.map((entry) => (
        entry.driveId === remotePluginFile.id
          ? { ...entry, sha256Hash: hashA }
          : entry
      )),
      "https://graph.example/delta-current",
      scope,
      harness.state.remoteFolders,
    );

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 3,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps missing folder anchors fail-closed when the descendant local bytes changed", async () => {
    const {
      harness,
      pluginFile,
    } = await stageConfirmedDescendantWithoutFolderAnchors();
    const local = harness.localEntryState.find(
      (entry) => entry.path === pluginFile.path,
    )!;
    local.hash = "c".repeat(64);
    local.mtime++;

    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 3,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("does not reconstruct descendant-proven folders while mutation recovery is unresolved", async () => {
    const {
      harness,
    } = await stageConfirmedDescendantWithoutFolderAnchors();
    await harness.state.beginMutationIntent({
      version: 1,
      operationId: "descendant-folder-recovery-block",
      planRevision: 1,
      scope,
      action: "upload",
      path: localA.path,
      expectedLocal: {
        exists: true,
        hash: localA.hash,
        size: localA.size,
      },
      expectedRemote: {
        exists: true,
        driveId: "file-a",
        eTag: "etag-a",
        size: localA.size,
        sha256Hash: localA.hash,
      },
      createdAt: 1,
    });

    expect(await harness.state.acceptConfirmedDescendantFolderAnchors({
      scope,
      localFiles: harness.localEntryState,
      localFolders: [...harness.localFolderPaths].map((path) => ({ path })),
      localFolderScanComplete: true,
      remoteIdentityComplete: true,
    })).toEqual({
      status: "blocked",
      accepted: 0,
      evidenceFiles: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps scope-expansion authorization pending while folder evidence or review state is incomplete", async () => {
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

    expect(await harness.state.acceptSyncScopeExpansionFolders({
      expectedRevision: 1,
      scope,
      localFiles: harness.localEntryState,
      localFolders: expandedPaths.map((path) => ({ path })),
      localFolderScanComplete: true,
      remoteIdentityComplete: false,
    })).toEqual({ status: "blocked", accepted: 0 });
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();

    await harness.state.setPlanReviewBundle(
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
    expect(await harness.state.prepareSyncScopeExpansion(scope)).toEqual({
      status: "blocked",
      revision: 1,
    });
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();
    await harness.state.clearPlanReview();

    vi.mocked(harness.scanner.scanAll).mockResolvedValue({
      entries: harness.localEntryState.map((entry) => ({ ...entry })),
      folders: [...harness.localFolderPaths].map((path) => ({ path })),
      folderScanComplete: false,
      folderScanFailures: [".obsidian"],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const stopped = await harness.executor.run("manual");

    expect(stopped).toMatchObject({
      deferred: 0,
      success: false,
      message: "result.folderNameClash",
    });
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps the required complete rebuild ready when a previously synced folder re-enters the scope", async () => {
    const harness = makeHarness();
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

    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "excluded:notes",
        targetSettingsFingerprint: "excluded:none",
        expandedFolderPaths: ["Notes"],
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({
            excludedFolders: ["Notes"],
          }),
          target: createFolderSyncScopeSnapshotV1({}),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    expect(harness.state.activeSyncScopeExpansion).toMatchObject({
      revision: 1,
      requiresCompleteRemoteIdentitySnapshot: true,
    });
    expect(await harness.state.prepareSyncScopeExpansion(scope)).toEqual({
      status: "ready",
      revision: 1,
    });
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();
  });

  it("keeps a transition-free re-expansion of a synced folder ready on the plain fingerprint basis", async () => {
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
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "excluded:notes",
        targetSettingsFingerprint: "excluded:none",
        expandedFolderPaths: ["Notes"],
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    expect(await harness.state.prepareSyncScopeExpansion(scope)).toEqual({
      status: "ready",
      revision: 1,
    });
  });

  it("retires a partially anchored re-expansion as stale", async () => {
    const harness = makeHarness();
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

    // A remote-only folder observed into the index but never locally
    // confirmed: present in remoteFolders, carrying no folder anchor.
    const envelope = harness.state.getCommittedV2Envelope()!;
    const view = projectStatePathViewV2(envelope);
    await harness.state.setRemoteState(
      view.remoteEntries,
      view.deltaLink,
      { ...envelope.scope },
      [
        ...view.remoteFolders,
        {
          path: "Archive",
          driveId: "folder-archive",
          parentId: scope.filesRootId,
          name: "Archive",
        },
      ],
    );
    expect(harness.state.remoteFolders.map((folder) => folder.path)).toEqual(
      expect.arrayContaining(["Notes", "Archive"]),
    );

    await harness.state.commitSyncPathSettingsChange(
      (path) => harness.scanner.shouldSyncPath(path),
      () => undefined,
      undefined,
      {
        previousSettingsFingerprint: "excluded:notes+archive",
        targetSettingsFingerprint: "excluded:none",
        expandedFolderPaths: ["Notes", "Archive"],
        folderScopeTransition: {
          previous: createFolderSyncScopeSnapshotV1({
            excludedFolders: ["Notes", "Archive"],
          }),
          target: createFolderSyncScopeSnapshotV1({}),
        },
        requiresCompleteRemoteIdentitySnapshot: true,
      },
    );
    expect(await harness.state.prepareSyncScopeExpansion(scope)).toEqual({
      status: "none",
    });
    expect(harness.state.activeSyncScopeExpansion).toBeNull();
  });

  it("blocks scope-expansion identity acceptance while mutation recovery is unresolved", async () => {
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
    await harness.state.beginMutationIntent({
      version: 1,
      operationId: "scope-expansion-recovery",
      planRevision: 1,
      scope,
      action: "upload",
      path: localA.path,
      expectedLocal: {
        exists: true,
        hash: localA.hash,
        size: localA.size,
      },
      expectedRemote: {
        exists: true,
        driveId: "file-a",
        eTag: "etag-a",
        size: localA.size,
        sha256Hash: localA.hash,
      },
      createdAt: 1,
    });

    expect(await harness.state.prepareSyncScopeExpansion(scope)).toEqual({
      status: "blocked",
      revision: 1,
    });
    expect(harness.state.activeSyncScopeExpansion).not.toBeNull();
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ).map((anchor) => anchor.lastPath),
    ).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a healthy zero-plan vault on V2 with no downgrade artifacts", async () => {
    const harness = makeHarness();
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
    vi.mocked(harness.client.createSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.createSharedSyncProtocolV3).mockClear();

    const stable = await harness.executor.run("manual");

    expect(stable).toEqual(expect.objectContaining({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    }));
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2RetiredManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RollbackFile)).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.baseSnapshot).toEqual(harness.state.baseSnapshot);
    expect(restartedState.remoteSnapshot).toEqual(harness.state.remoteSnapshot);
  });

  it("conservatively resets independent unresolved downloads, cold-rebuilds unrelated work, then retires every record and stays zero", async () => {
    const initialContent = "0123456789";
    const remoteContent = "abcdefghij";
    const changedAfterIntent = "klmnopqrst";
    const unrelatedContent = "unrelated";
    const initialHash = await sha256Hex(
      new TextEncoder().encode(initialContent).buffer,
    );
    const remoteHash = await sha256Hex(
      new TextEncoder().encode(remoteContent).buffer,
    );
    const unrelatedHash = await sha256Hex(
      new TextEncoder().encode(unrelatedContent).buffer,
    );
    const changedAfterIntentHash = await sha256Hex(
      new TextEncoder().encode(changedAfterIntent).buffer,
    );
    const initialLocal: LocalFileEntry = {
      ...localA,
      hash: initialHash,
      size: initialContent.length,
    };
    const initialBase: BaseFileEntry = {
      ...baseA,
      hash: initialHash,
      size: initialContent.length,
    };
    const secondLocal: LocalFileEntry = {
      ...initialLocal,
      path: "Notes/b.md",
    };
    const secondBase: BaseFileEntry = {
      ...initialBase,
      path: secondLocal.path,
    };
    const initialRemoteItems = remoteItems(initialHash);
    const notesItem = initialRemoteItems.find((item) => item.id === "folder-notes")!;
    notesItem.folder = { childCount: 2 };
    initialRemoteItems.push({
      id: "file-b",
      name: "b.md",
      size: secondLocal.size,
      file: { hashes: { sha256Hash: initialHash } },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
      eTag: "etag-a-b",
      cTag: "ctag-a-b",
    });
    const harness = makeHarness({
      base: [initialBase, secondBase],
      local: [initialLocal, secondLocal],
      remoteItems: initialRemoteItems,
      initialFiles: {
        [initialLocal.path]: initialContent,
        [secondLocal.path]: initialContent,
      },
      remoteFileContents: {
        [initialLocal.path]: remoteContent,
        [secondLocal.path]: remoteContent,
      },
      createStateV2IndexedDbActiveStore: (databaseId, recovery) =>
        new StateV2IndexedDbActiveStore(databaseId, recovery),
    });
    let coldState: StateManager | null = null;
    let stableState: StateManager | null = null;
    let finalState: StateManager | null = null;
    let zeroState: StateManager | null = null;
    try {
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      expect(harness.state.activeV2StorageAuthorityEvidence)
        .toMatchObject({ kind: "indexeddb" });

      const notesFolder: RemoteFolderEntry = {
        path: "Notes",
        driveId: "folder-notes",
        parentId: scope.filesRootId,
        name: "Notes",
        eTag: "etag-folder-notes",
        cTag: "ctag-folder-notes",
      };
      const observedRemote: RemoteFileEntry = {
        path: initialLocal.path,
        driveId: "file-a",
        parentId: notesFolder.driveId,
        size: remoteContent.length,
        mtime: Date.parse("2026-08-16T00:00:00.000Z"),
        eTag: "etag-b",
        cTag: "ctag-b",
        sha256Hash: remoteHash,
      };
      const observedSecondRemote: RemoteFileEntry = {
        ...observedRemote,
        path: secondLocal.path,
        driveId: "file-b",
        eTag: "etag-b-second",
        cTag: "ctag-b-second",
      };
      const target = harness.remoteItemState.find(
        (item) => item.id === observedRemote.driveId,
      )!;
      const secondTarget = harness.remoteItemState.find(
        (item) => item.id === observedSecondRemote.driveId,
      )!;
      target.size = observedRemote.size;
      target.eTag = observedRemote.eTag;
      target.cTag = observedRemote.cTag;
      target.file = { hashes: { sha256Hash: remoteHash } };
      secondTarget.size = observedSecondRemote.size;
      secondTarget.eTag = observedSecondRemote.eTag;
      secondTarget.cTag = observedSecondRemote.cTag;
      secondTarget.file = { hashes: { sha256Hash: remoteHash } };
      await harness.state.setRemoteState(
        [observedRemote, observedSecondRemote],
        "https://graph.example/download-intent",
        scope,
        [notesFolder],
      );
      const retained: MutationLedgerEntryV1 = {
        intent: {
          version: 1,
          operationId: "op-conservative-download",
          planRevision: harness.state.planReviewRevision,
          scope,
          action: "download",
          path: initialLocal.path,
          expectedLocal: {
            exists: true,
            hash: initialHash,
            size: initialLocal.size,
          },
          expectedRemote: {
            exists: true,
            driveId: observedRemote.driveId,
            eTag: observedRemote.eTag,
            size: observedRemote.size,
            sha256Hash: remoteHash,
          },
          createdAt: 1,
        },
        receipt: null,
      };
      const secondRetained: MutationLedgerEntryV1 = {
        intent: {
          ...retained.intent,
          operationId: "op-conservative-download-second",
          path: secondLocal.path,
          expectedRemote: {
            exists: true,
            driveId: observedSecondRemote.driveId,
            eTag: observedSecondRemote.eTag,
            size: observedSecondRemote.size,
            sha256Hash: remoteHash,
          },
        },
        receipt: null,
      };
      await harness.state.beginMutationIntent(retained.intent);
      await harness.state.beginMutationIntent(secondRetained.intent);
      harness.files.set(initialLocal.path, changedAfterIntent);
      harness.files.set(secondLocal.path, changedAfterIntent);
      for (const localPath of [initialLocal.path, secondLocal.path]) {
        Object.assign(harness.localEntryState.find(
          (entry) => entry.path === localPath,
        )!, {
          hash: changedAfterIntentHash,
          size: changedAfterIntent.length,
          mtime: initialLocal.mtime + 1,
        });
      }

      const archive: DriveItem = {
        id: "folder-archive",
        name: "Archive",
        folder: { childCount: 1 },
        parentReference: { id: scope.filesRootId },
        eTag: "etag-folder-archive",
        cTag: "ctag-folder-archive",
      };
      harness.remoteItemState.push(archive);
      target.parentReference = { id: archive.id };
      target.eTag = "etag-b-moved";
      target.cTag = "ctag-b-moved";
      harness.remoteItemState.push({
        id: "replacement-at-old-path",
        name: "a.md",
        size: initialLocal.size,
        file: { hashes: { sha256Hash: initialHash } },
        parentReference: { id: notesFolder.driveId },
        lastModifiedDateTime: "2026-08-16T00:00:00.000Z",
        eTag: "etag-replacement",
        cTag: "ctag-replacement",
      });
      harness.localEntryState.push({
        path: "other.md",
        size: unrelatedContent.length,
        mtime: 2,
        hash: unrelatedHash,
        binary: false,
      });
      harness.files.set("other.md", unrelatedContent);

      const observed = await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { recoveryOnly: true },
      );
      expect(observed.mutationRecovery).toMatchObject({
        state: "blocked",
        blockReason: "facts-changed",
        blockedOperationId: retained.intent.operationId,
        isolated: true,
      });
      expect(harness.state.mutationLedger).toEqual([retained, secondRetained]);

      await harness.state.resetPreservingIsolatedMutationRecovery([
        retained,
        secondRetained,
      ]);
      const capsule = harness.state.getCommittedV2Envelope()!;
      expect(capsule.remoteIndex.itemsById).toEqual({});
      expect(Object.values(capsule.anchors.byAnchorId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            remoteId: observedRemote.driveId,
            lastPath: initialLocal.path,
            contentHash: initialHash,
          }),
          expect.objectContaining({
            remoteId: observedSecondRemote.driveId,
            lastPath: secondLocal.path,
            contentHash: initialHash,
          }),
        ]),
      );
      expect(Object.keys(capsule.anchors.byAnchorId)).toHaveLength(2);
      expect(capsule.folderAnchors?.byAnchorId).toEqual({});
      expect(harness.state.mutationLedger).toEqual([retained, secondRetained]);
      await harness.state.close();
      for (const folderPath of [...harness.localFolderPaths]) {
        if (folderPath.startsWith(".obsidian")) {
          harness.localFolderPaths.delete(folderPath);
        }
      }

      const uploadedOther: DriveItem = {
        id: "uploaded-other",
        name: "other.md",
        size: unrelatedContent.length,
        file: { hashes: { sha256Hash: unrelatedHash } },
        parentReference: { id: scope.filesRootId },
        lastModifiedDateTime: "2026-08-16T00:00:00.000Z",
        eTag: "etag-uploaded-other",
        cTag: "ctag-uploaded-other",
      };
      harness.mutations.uploadFile.mockImplementationOnce(async () => {
        harness.remoteItemState.push(uploadedOther);
        return uploadedOther;
      });
      vi.mocked(harness.mutations.downloadFile).mockClear();
      coldState = new StateManager(harness.plugin);
      await coldState.load();
      const coldExecutor = new SyncExecutor(
        harness.client,
        harness.scanner,
        coldState,
        "testVault",
        undefined,
        undefined,
        harness.diag as never,
        harness.fileManager as never,
      );
      const completedPaths: Array<{ path: string; action: SyncActionType }> = [];
      const unrelatedRun = await coldExecutor.run("manual", {
        onFileComplete: (path, action) => {
          completedPaths.push({ path, action });
        },
      });
      expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
      expect(completedPaths).toEqual([
        { path: "other.md", action: SyncActionType.Upload },
      ]);
      expect(unrelatedRun).toMatchObject({
        success: true,
        uploaded: 1,
        downloaded: 0,
        deleted: 0,
        foldersCreated: 0,
        foldersMoved: 0,
        foldersDeleted: 0,
      });
      expect(unrelatedRun.mutationRecovery).toMatchObject({
        state: "blocked",
        isolated: true,
      });
      expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
      expect(coldState.mutationLedger).toEqual([retained, secondRetained]);
      expect(coldState.baseSnapshot).toContainEqual(
        expect.objectContaining({ path: "other.md", hash: unrelatedHash }),
      );
      expect(coldState.baseSnapshot).not.toContainEqual(
        expect.objectContaining({
          path: "Archive/a.md",
          eTag: target.eTag,
        }),
      );
      await coldState.close();
      coldState = null;

      stableState = new StateManager(harness.plugin);
      await stableState.load();
      const stableExecutor = new SyncExecutor(
        harness.client,
        harness.scanner,
        stableState,
        "testVault",
        undefined,
        undefined,
        harness.diag as never,
        harness.fileManager as never,
      );
      vi.mocked(harness.mutations.uploadFile).mockClear();
      const isolatedZero = await stableExecutor.run("manual");
      expect(isolatedZero).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      });
      expect(stableState.mutationLedger).toEqual([retained, secondRetained]);

      const replacementIndex = harness.remoteItemState.findIndex(
        (item) => item.id === "replacement-at-old-path",
      );
      harness.remoteItemState.splice(replacementIndex, 1);
      const archiveIndex = harness.remoteItemState.findIndex(
        (item) => item.id === archive.id,
      );
      harness.remoteItemState.splice(archiveIndex, 1);
      target.name = "a.md";
      target.parentReference = { id: notesFolder.driveId };
      target.eTag = observedRemote.eTag;
      target.cTag = observedRemote.cTag;
      harness.files.set(initialLocal.path, initialContent);
      harness.files.set(secondLocal.path, initialContent);
      for (const localPath of [initialLocal.path, secondLocal.path]) {
        Object.assign(harness.localEntryState.find(
          (entry) => entry.path === localPath,
        )!, {
          hash: initialHash,
          size: initialLocal.size,
          mtime: initialLocal.mtime + 2,
        });
      }
      vi.mocked(harness.mutations.downloadFile).mockClear();

      const retired = await stableExecutor.run("manual");
      expect(retired).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 1,
        errors: 0,
      });
      expect(stableState.mutationLedger).toEqual([]);
      expect(stableState.baseSnapshot).toContainEqual(
        expect.objectContaining({
          path: initialLocal.path,
          hash: remoteHash,
          eTag: observedRemote.eTag,
        }),
      );
      expect(stableState.baseSnapshot).toContainEqual(
        expect.objectContaining({
          path: secondLocal.path,
          hash: initialHash,
          eTag: "etag-a-b",
        }),
      );
      await stableState.close();
      stableState = null;

      finalState = new StateManager(harness.plugin);
      await finalState.load();
      const finalExecutor = new SyncExecutor(
        harness.client,
        harness.scanner,
        finalState,
        "testVault",
        undefined,
        undefined,
        harness.diag as never,
        harness.fileManager as never,
      );
      vi.mocked(harness.mutations.downloadFile).mockClear();
      const secondRetirementRun = await finalExecutor.run("manual");
      expect(secondRetirementRun).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 1,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      });
      expect(finalState.mutationLedger).toEqual([]);
      expect(finalState.baseSnapshot).toContainEqual(
        expect.objectContaining({
          path: secondLocal.path,
          hash: remoteHash,
          eTag: observedSecondRemote.eTag,
        }),
      );
      await finalState.close();
      finalState = null;

      zeroState = new StateManager(harness.plugin);
      await zeroState.load();
      const zeroExecutor = new SyncExecutor(
        harness.client,
        harness.scanner,
        zeroState,
        "testVault",
        undefined,
        undefined,
        harness.diag as never,
        harness.fileManager as never,
      );
      vi.mocked(harness.mutations.downloadFile).mockClear();
      const finalZero = await zeroExecutor.run("manual");
      expect(finalZero).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      });
      expect(zeroState.mutationLedger).toEqual([]);
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    } finally {
      await zeroState?.close();
      await finalState?.close();
      await stableState?.close();
      await coldState?.close();
      await harness.state.close();
    }
  });

  it("upgrades an active public V2-only authority to V3 on an ordinary round", async () => {
    const harness = makeHarness();
    await harness.state.load();
    const activated = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );
    expect(activated.success).toBe(true);
    const predecessor = await harness.client.readSharedSyncProtocolV2(
      "testVault",
    );
    expect(predecessor).not.toBeNull();
    const publicV2 = JSON.parse(predecessor!.content);
    const witness = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    );
    witness.protocolBinding = {
      schemaVersion: 1,
      protocolVersion: 2,
      migrationGeneration: publicV2.migrationGeneration,
      confirmedAllDevicesUpdatedAt:
        publicV2.confirmedAllDevicesUpdatedAt,
      recordId: predecessor!.id,
      recordETag: predecessor!.eTag,
    };
    harness.files.set(
      paths.stateV2AuthorityWitnessFile,
      JSON.stringify(witness),
    );
    harness.clearSharedProtocolV3();
    vi.mocked(harness.client.createSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.createSharedSyncProtocolV3).mockClear();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );

    const upgraded = await restartedExecutor.run("manual");

    expect(upgraded).toMatchObject({ success: true, errors: 0 });
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expect(await harness.client.readSharedSyncProtocolV2("testVault"))
      .toEqual(predecessor);
    expect(await restartedState.getActiveV2ProtocolBinding()).toMatchObject({
      protocolVersion: 3,
      migrationGeneration: publicV2.migrationGeneration,
    });
    expectNoFileMutations(harness.mutations);

    const committedWitness = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    );
    committedWitness.revision += 1;
    committedWitness.updatedAt += 1;
    committedWitness.protocolBinding = witness.protocolBinding;
    harness.files.set(
      paths.stateV2AuthorityWitnessFile,
      JSON.stringify(committedWitness),
    );
    vi.mocked(harness.client.createSharedSyncProtocolV3).mockClear();
    const resumedState = new StateManager(harness.plugin);
    await resumedState.load();
    const resumed = await new SyncExecutor(
      harness.client,
      harness.scanner,
      resumedState,
      "testVault",
    ).run("manual");
    expect(resumed).toMatchObject({ success: true, errors: 0 });
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expect(await resumedState.getActiveV2ProtocolBinding()).toMatchObject({
      protocolVersion: 3,
      migrationGeneration: publicV2.migrationGeneration,
    });
  });

  it("keeps an active authority unchanged when the V3 object identity no longer matches", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const witnessBefore = harness.files.get(paths.stateV2AuthorityWitnessFile);
    const v3Content = harness.getSharedProtocolV3()!.content;
    harness.seedSharedProtocolV3(v3Content);
    vi.mocked(harness.client.createSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.createSharedSyncProtocolV3).mockClear();

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2ProtocolBlocked",
    });
    expect(harness.files.get(paths.stateV2AuthorityWitnessFile))
      .toBe(witnessBefore);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expect(blocked.disposition).toBeUndefined();
    expect(harness.diag.error).toHaveBeenCalledWith(
      "state",
      "shared-sync-protocol-profile-inconsistent",
      expect.objectContaining({
        reason: "binding-mismatch",
        predecessor: "match",
      }),
    );
    expectNoFileMutations(harness.mutations);
  });

  it("stops before a new plan on a transient profile timeout and succeeds from a fresh next-round observation", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const profile = {
      v2: await harness.client.readSharedSyncProtocolV2("testVault"),
      v3: harness.getSharedProtocolV3(),
    };
    expect(profile.v2).not.toBeNull();
    expect(profile.v3).not.toBeNull();

    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    readProfile.mockReset()
      .mockRejectedValueOnce(new SyntheticRequestTimeoutError(15_000))
      .mockResolvedValue(profile);
    vi.mocked(harness.client.readSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.readSharedSyncProtocolV3).mockClear();
    harness.getDelta.mockClear();
    expectNoFileMutations(harness.mutations);

    const unavailable = await harness.executor.run("auto");

    expect(unavailable).toMatchObject({
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 1,
      message: "result.remoteReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "shared-control-read-unavailable",
        retry: "next-sync",
        component: "directory",
      },
    });
    expect(readProfile).toHaveBeenCalledOnce();
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV3).not.toHaveBeenCalled();
    // E (protocol observation overlaps the remote scan): the delta already
    // ran while the observation was in flight — the round outcome above
    // (retryable disposition, planning not-entered, no mutations) is the
    // contract, not the request ordering.
    expect(harness.getDelta).toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const recovered = await harness.executor.run("auto");

    expect(recovered).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    });
    expect(recovered.disposition).toBeUndefined();
    expect(readProfile).toHaveBeenCalledTimes(2);
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("does not reinterpret a transient profile timeout as a cached-scope failure or observe twice in one round", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await harness.state.setRemoteState(
      harness.state.remoteSnapshot,
      "https://graph.example/cached-delta",
      scope,
      harness.state.remoteFolders,
    );
    expect(harness.state.remoteDeltaLink).toBeTruthy();
    const profile = {
      v2: await harness.client.readSharedSyncProtocolV2("testVault"),
      v3: harness.getSharedProtocolV3(),
    };
    expect(profile.v2).not.toBeNull();
    expect(profile.v3).not.toBeNull();

    vi.mocked(harness.client.restoreVaultScope).mockReturnValue(true);
    const restoreByIdentity = vi.fn().mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    (harness.client as typeof harness.client & {
      restoreVaultScopeByIdentity: typeof restoreByIdentity;
    }).restoreVaultScopeByIdentity = restoreByIdentity;
    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    readProfile.mockReset()
      .mockRejectedValueOnce(new SyntheticRequestTimeoutError(15_000))
      .mockResolvedValue(profile);
    harness.getDelta.mockClear();

    const unavailable = await harness.executor.run("auto");

    expect(unavailable).toMatchObject({
      success: false,
      errors: 1,
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
      },
      disposition: {
        kind: "retryable-observation",
        code: "shared-control-read-unavailable",
      },
    });
    expect(readProfile).toHaveBeenCalledOnce();
    expect(restoreByIdentity).not.toHaveBeenCalled();
    // E: the delta overlapped the observation (see sibling tests); the
    // round outcome above is the contract.
    expect(harness.getDelta).toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    expect((await harness.executor.run("auto"))).toMatchObject({
      success: true,
      errors: 0,
    });
    expect(readProfile).toHaveBeenCalledTimes(2);
    expectNoFileMutations(harness.mutations);
  });

  it("does not reinterpret an invalid control-directory observation as a cached-scope failure", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await harness.state.setRemoteState(
      harness.state.remoteSnapshot,
      "https://graph.example/cached-delta",
      scope,
      harness.state.remoteFolders,
    );
    vi.mocked(harness.client.restoreVaultScope).mockReturnValue(true);
    const restoreByIdentity = vi.fn().mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    (harness.client as typeof harness.client & {
      restoreVaultScopeByIdentity: typeof restoreByIdentity;
    }).restoreVaultScopeByIdentity = restoreByIdentity;
    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    readProfile.mockReset().mockRejectedValueOnce(
      new SharedSyncProtocolObservationError(
        "directory",
        new Error("protocol slot metadata is incomplete"),
      ),
    );
    harness.getDelta.mockClear();

    const blocked = await harness.executor.run("auto");

    expect(blocked).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2ProtocolBlocked",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
      },
    });
    expect(blocked.disposition).toBeUndefined();
    expect(readProfile).toHaveBeenCalledOnce();
    expect(restoreByIdentity).not.toHaveBeenCalled();
    // E: the delta overlapped the observation; the v2ProtocolBlocked outcome
    // above is the contract.
    expect(harness.getDelta).toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps the next normal round observing after a transient ordinary delta read failure before planning", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await harness.state.setRemoteState(
      harness.state.remoteSnapshot,
      "https://graph.example/cached-delta",
      scope,
      harness.state.remoteFolders,
    );
    harness.getDelta.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.NetworkError,
      "request timed out after 15000ms",
    ));

    const unavailable = await harness.executor.run("auto");

    expect(unavailable).toMatchObject({
      success: false,
      errors: 1,
      message: "result.remoteReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "ordinary-remote-read-unavailable",
        retry: "next-sync",
        component: "ordinary-remote",
      },
    });
    expect(unavailable.uploaded).toBe(0);
    expect(unavailable.downloaded).toBe(0);
    expectNoFileMutations(harness.mutations);

    // The next normal round re-observes with the default healthy delta.
    const recovered = await harness.executor.run("auto");
    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
    });
    expect(recovered.disposition).toBeUndefined();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a hard failure when the pre-planning delta read fails with a non-transient error", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await harness.state.setRemoteState(
      harness.state.remoteSnapshot,
      "https://graph.example/cached-delta",
      scope,
      harness.state.remoteFolders,
    );
    harness.getDelta.mockRejectedValueOnce(new OneDriveError(
      OneDriveErrorType.Unknown,
      "remote cache is ambiguous",
      400,
    ));

    const failed = await harness.executor.run("auto");

    expect(failed.success).toBe(false);
    expect(failed.errors).toBeGreaterThan(0);
    expect(failed.disposition).toBeUndefined();
    expect(failed.message).toBe("result.syncFailed");
    expectNoFileMutations(harness.mutations);
  });

  it("preserves OneDrive authentication expiry from the composite profile observation", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    vi.mocked(harness.client.readSharedSyncProtocolObjects)
      .mockRejectedValueOnce(new OneDriveError(
        OneDriveErrorType.AuthExpired,
        "access token expired",
        401,
      ));
    harness.getDelta.mockClear();

    const expired = await harness.executor.run("auto");

    expect(expired).toMatchObject({
      success: false,
      authExpired: true,
      errors: 0,
      message: "result.authExpired",
      runFacts: {
        ordinaryPlanning: "not-entered",
      },
    });
    expect(expired.disposition).toBeUndefined();
    // E: the remote scan overlapped the observation and already ran before
    // the auth expiry surfaced; the authExpired outcome above is the
    // contract.
    expect(harness.getDelta).toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("settles an existing ledger record before a transient profile failure without replaying it next round", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const profile = {
      v2: await harness.client.readSharedSyncProtocolV2("testVault"),
      v3: harness.getSharedProtocolV3(),
    };
    expect(profile.v2).not.toBeNull();
    expect(profile.v3).not.toBeNull();

    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "settle-before-profile-timeout",
      planRevision: 1,
      scope,
      action: "upload",
      path: "Notes/not-applied-before-profile.md",
      expectedLocal: { exists: true, hash: hashB, size: 10 },
      expectedRemote: { exists: false },
      createdAt: 10,
    };
    await harness.state.beginMutationIntent(intent);
    const abandonMutationIntent = vi.spyOn(
      harness.state,
      "abandonMutationIntent",
    );
    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    readProfile.mockReset()
      .mockImplementationOnce(async () => {
        expect(harness.state.mutationLedger).toEqual([]);
        throw new SyntheticRequestTimeoutError(15_000);
      })
      .mockResolvedValue(profile);
    vi.mocked(harness.client.readSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.readSharedSyncProtocolV3).mockClear();
    harness.getDelta.mockClear();
    expectNoFileMutations(harness.mutations);

    const unavailable = await harness.executor.run("auto");

    expect(unavailable).toMatchObject({
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 1,
      message: "result.remoteReadUnavailable",
      runFacts: {
        termination: "normal",
        ordinaryPlanning: "not-entered",
      },
      disposition: {
        kind: "retryable-observation",
        phase: "remotePrepare",
        code: "shared-control-read-unavailable",
        retry: "next-sync",
        component: "directory",
      },
    });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(abandonMutationIntent).toHaveBeenCalledOnce();
    expect(abandonMutationIntent).toHaveBeenCalledWith(intent.operationId);
    expect(readProfile).toHaveBeenCalledOnce();
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const recovered = await harness.executor.run("auto");

    expect(recovered).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    });
    expect(recovered.disposition).toBeUndefined();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(abandonMutationIntent).toHaveBeenCalledOnce();
    expect(readProfile).toHaveBeenCalledTimes(2);
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it.each([
    [
      "synthetic timeout",
      () => new SyntheticRequestTimeoutError(15_000),
    ],
    [
      "native status-0 transport failure",
      () => new OneDriveError(
        OneDriveErrorType.NetworkError,
        "requestUrl failed without an HTTP response",
      ),
    ],
  ] as const)(
    "keeps cancellation authoritative when an uncancellable profile request reports a late %s",
    async (_label, lateError) => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const profile = {
      v2: await harness.client.readSharedSyncProtocolV2("testVault"),
      v3: harness.getSharedProtocolV3(),
    };
    expect(profile.v2).not.toBeNull();
    expect(profile.v3).not.toBeNull();

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let rejectLate!: (reason?: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    readProfile.mockReset()
      .mockImplementationOnce(() => {
        markStarted();
        return pending;
      })
      .mockResolvedValue(profile);
    const finishRetryableObservation = vi.spyOn(
      harness.executor as unknown as {
        finishRetryableSharedControlObservation: (...args: unknown[]) => SyncResult;
      },
      "finishRetryableSharedControlObservation",
    );
    vi.mocked(harness.client.readSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.readSharedSyncProtocolV3).mockClear();
    harness.getDelta.mockClear();
    expectNoFileMutations(harness.mutations);

    const pendingRun = harness.executor.run("auto");
    await started;
    harness.executor.cancel();
    rejectLate(lateError());
    const cancelled = await pendingRun;

    expect(cancelled).toMatchObject({
      success: false,
      errors: 0,
      message: "result.cancelled",
      runFacts: {
        termination: "cancelled",
        ordinaryPlanning: "not-entered",
      },
    });
    expect(cancelled.disposition).toBeUndefined();
    expect(finishRetryableObservation).not.toHaveBeenCalled();
    expect(readProfile).toHaveBeenCalledOnce();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const recovered = await harness.executor.run("auto");

    expect(recovered).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
      runFacts: {
        termination: "normal",
      },
    });
    expect(recovered.disposition).toBeUndefined();
    expect(readProfile).toHaveBeenCalledTimes(2);
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.readSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
    },
  );

  it.each(["v2", "v3"] as const)(
    "keeps a partial %s body observation typed and out of planning",
    async (component) => {
      const harness = makeHarness();
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      vi.mocked(harness.client.readSharedSyncProtocolObjects)
        .mockRejectedValueOnce(new SharedSyncProtocolObservationError(
          component,
          new OneDriveError(
            OneDriveErrorType.NetworkError,
            `${component} body unavailable`,
          ),
        ));
      harness.getDelta.mockClear();

      const unavailable = await harness.executor.run("auto");

      expect(unavailable).toMatchObject({
        success: false,
        errors: 1,
        disposition: {
          kind: "retryable-observation",
          code: "shared-control-read-unavailable",
          component,
        },
      });
      // E: the remote scan overlapped the partial-body observation; the
      // retryable disposition above is the contract.
      expect(harness.getDelta).toHaveBeenCalled();
      expectNoFileMutations(harness.mutations);
      await harness.state.close();
    },
  );

  it("counts consecutive retryable observation failures in the diagnostic warning and resets after a healthy round", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const profile = {
      v2: await harness.client.readSharedSyncProtocolV2("testVault"),
      v3: harness.getSharedProtocolV3(),
    };
    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    const observationUnavailable = () => new SharedSyncProtocolObservationError(
      "v2",
      new OneDriveError(
        OneDriveErrorType.NetworkError,
        "v2 body unavailable",
      ),
    );
    readProfile.mockReset()
      .mockRejectedValueOnce(observationUnavailable())
      .mockRejectedValueOnce(observationUnavailable())
      .mockResolvedValue(profile);

    const warnCalls = (harness.diag.warn as unknown as {
      mock: { calls: Array<[unknown, unknown, unknown]> };
    }).mock.calls;
    const observationWarnings = () => warnCalls.filter((call) =>
      call[0] === "state"
      && call[1] === "shared protocol observation is temporarily unavailable before ordinary planning");

    expect((await harness.executor.run("auto")).success).toBe(false);
    expect((await harness.executor.run("auto")).success).toBe(false);
    // The streak grows across consecutive failing rounds and is reported on
    // the diagnostic warning (session-scoped only — no behavior is gated).
    expect(observationWarnings().map((call) => (call[2] as { consecutiveFailures: number }).consecutiveFailures))
      .toEqual([1, 2]);
    expectNoFileMutations(harness.mutations);

    // A healthy round resets the counter; the next failure restarts at 1.
    expect((await harness.executor.run("auto")).success).toBe(true);
    readProfile.mockReset().mockRejectedValueOnce(observationUnavailable());
    expect((await harness.executor.run("auto")).success).toBe(false);
    expect(observationWarnings().map((call) => (call[2] as { consecutiveFailures: number }).consecutiveFailures))
      .toEqual([1, 2, 1]);
    expectNoFileMutations(harness.mutations);
    await harness.state.close();
  });

  it.each(["v2", "v3"] as const)(
    "retries a stale %s body snapshot on the next full observation",
    async (component) => {
      const harness = makeHarness();
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      const profile = {
        v2: await harness.client.readSharedSyncProtocolV2("testVault"),
        v3: harness.getSharedProtocolV3(),
      };
      const readProfile = vi.mocked(
        harness.client.readSharedSyncProtocolObjects,
      );
      readProfile.mockReset()
        .mockRejectedValueOnce(new SharedSyncProtocolObservationError(
          component,
          new OneDriveError(
            OneDriveErrorType.NotFound,
            `${component} snapshot body no longer exists`,
            404,
          ),
        ))
        .mockResolvedValue(profile);
      harness.getDelta.mockClear();

      const stale = await harness.executor.run("auto");

      expect(stale).toMatchObject({
        success: false,
        errors: 1,
        runFacts: {
          ordinaryPlanning: "not-entered",
        },
        disposition: {
          kind: "retryable-observation",
          code: "shared-control-read-unavailable",
          component,
        },
      });
      expect(readProfile).toHaveBeenCalledOnce();
      // E: the delta overlapped the stale-body observation; the retryable
      // disposition above is the contract.
      expect(harness.getDelta).toHaveBeenCalled();
      expectNoFileMutations(harness.mutations);

      expect((await harness.executor.run("auto"))).toMatchObject({
        success: true,
        errors: 0,
      });
      expect(readProfile).toHaveBeenCalledTimes(2);
      expectNoFileMutations(harness.mutations);
    },
  );

  it.each([
    [
      "synthetic timeout",
      () => new SyntheticRequestTimeoutError(15_000),
    ],
    [
      "native status-0 transport failure",
      () => new OneDriveError(
        OneDriveErrorType.NetworkError,
        "requestUrl failed without an HTTP response",
      ),
    ],
  ] as const)(
    "keeps cancellation authoritative when a protocol create readback reports a late %s",
    async (_label, lateError) => {
      const harness = makeHarness();
      await harness.state.load();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let rejectLate!: (reason?: unknown) => void;
      const pending = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });
      vi.mocked(harness.client.readSharedSyncProtocolV2ById)
        .mockImplementationOnce(() => {
          markStarted();
          return pending;
        });

      const pendingRun = harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      );
      await started;
      harness.getDelta.mockClear();
      harness.executor.cancel();
      rejectLate(lateError());
      const cancelled = await pendingRun;

      expect(cancelled).toMatchObject({
        success: false,
        errors: 0,
        message: "result.cancelled",
        runFacts: {
          termination: "cancelled",
          ordinaryPlanning: "entered",
        },
      });
      expect(cancelled.disposition).toBeUndefined();
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.getDelta).not.toHaveBeenCalled();
      expectNoFileMutations(harness.mutations);
    },
  );

  it("never re-enters the legacy cloud baseline after V2 becomes authoritative", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
    });
    await harness.state.load();

    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    const activated = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(activated.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    const downloadBaseline = vi.mocked(harness.client.downloadBaseline);
    downloadBaseline.mockClear();

    const stable = await harness.executor.run("manual");

    expect(stable.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(downloadBaseline).not.toHaveBeenCalled();
  });

  it("stages V2-only scope recovery when committed identities are gone", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run("manual");
    const activated = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(activated.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect((await harness.executor.run("manual")).success).toBe(true);
    expect(harness.state.remoteDeltaLink).toBeTruthy();
    vi.mocked(harness.client.restoreVaultScope).mockReturnValue(true);
    const originalProtocolBinding = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    ).protocolBinding;

    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockRejectedValue(
      new RemoteVaultScopeIdentityError("files-root-invalid"),
    );
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);
    vi.mocked(harness.client.readSharedSyncProtocolObjects).mockRejectedValueOnce(
      new OneDriveError(
        OneDriveErrorType.NotFound,
        "protocol path no longer exists",
        404,
      ),
    );
    harness.getDelta.mockClear();

    const paused = await harness.executor.run("auto");

    expect(paused).toEqual(expect.objectContaining({
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 1,
      errors: 0,
      message: "result.v2ScopeRecoveryPending",
    }));
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.remoteScope).toEqual(scope);
    expect(harness.state.baseSnapshot).toEqual([baseA]);
    expect(harness.state.activeV2RemoteScopeRecovery).toMatchObject({
      reason: "committed-scope-unreachable",
      observedScope: {
        accountId: scope.accountId,
        ...replacementScope,
      },
    });
    expect(harness.client.restoreVaultScopeByIdentity).toHaveBeenCalledWith(
      "testVault",
      {
        driveId: scope.driveId,
        vaultFolderId: scope.vaultFolderId,
        filesRootId: scope.filesRootId,
      },
    );
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2RetiredManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2RollbackFile)).toBe(false);
    expect(harness.client.initVaultScope).toHaveBeenCalledWith(
      "testVault",
      { createMissing: false },
    );
    // E: the remote scan overlapped the observation; the scope-recovery
    // staging outcome above is the contract.
    expect(harness.getDelta).toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.activeV2RemoteScopeRecovery).toEqual(
      harness.state.activeV2RemoteScopeRecovery,
    );

    const restartedExecutor = new SyncExecutor(
      harness.client as never,
      harness.scanner,
      restartedState,
      "testVault",
    );
    vi.mocked(harness.scanner.scanAll).mockClear();
    const stillPaused = await restartedExecutor.run("manual");
    expect(stillPaused.message).toBe("result.v2ScopeRecoveryPending");
    expect(harness.scanner.scanAll).not.toHaveBeenCalled();

    vi.mocked(harness.scanner.scanAll).mockResolvedValueOnce({
      entries: [],
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    const restoreReplacement = vi.fn().mockResolvedValue(replacementScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreReplacement;
    }).restoreVaultScopeByIdentity = restoreReplacement;
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-stable",
      });
    harness.clearSharedProtocolForRecoveredScope();

    const recovered = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(recovered).toEqual(expect.objectContaining({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
      message: "result.synced",
    }));
    expect(restartedState.hasV2RemoteScopeRecovery).toBe(false);
    expect(restartedState.remoteScope).toEqual({
      accountId: scope.accountId,
      ...replacementScope,
    });
    expect(restoreReplacement).toHaveBeenCalledWith(
      "testVault",
      replacementScope,
    );
    expect(harness.getDelta.mock.calls).toEqual([
      [replacementScope.filesRootId],
      [
        replacementScope.filesRootId,
        "https://graph.example/recovery-snapshot",
      ],
    ]);
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      protocolBinding: {
        protocolVersion: 3,
        migrationGeneration: originalProtocolBinding.migrationGeneration,
        predecessorConfirmedAllDevicesUpdatedAt:
          originalProtocolBinding.predecessorConfirmedAllDevicesUpdatedAt,
        recordId: "protocol-v3-id-2",
      },
    });
    expectNoFileMutations(harness.mutations);
  });

  it("publishes a complete recovered lineage that a zero-state device joins", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const generationA = JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    ).protocolBinding.migrationGeneration;
    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    const restoreReplacement = vi.fn()
      .mockRejectedValueOnce(
        new RemoteVaultScopeIdentityError("files-root-invalid"),
      )
      .mockResolvedValue(replacementScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreReplacement;
    }).restoreVaultScopeByIdentity = restoreReplacement;
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);
    expect((await harness.executor.run("auto")).message)
      .toBe("result.v2ScopeRecoveryPending");
    harness.clearSharedProtocolForRecoveredScope();
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-stable",
      });
    vi.mocked(harness.scanner.scanAll).mockResolvedValueOnce({
      entries: [],
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    )).success).toBe(true);
    const recoveredV2 = await harness.client.readSharedSyncProtocolV2(
      "testVault",
    );
    expect(recoveredV2).not.toBeNull();
    expect(JSON.parse(recoveredV2!.content))
      .toMatchObject({ migrationGeneration: generationA });
    expect(JSON.parse(harness.getSharedProtocolV3()!.content))
      .toMatchObject({ migrationGeneration: generationA });

    const recoveredV3Content = harness.getSharedProtocolV3()!.content;
    const coldHarness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    coldHarness.seedSharedProtocolContent(recoveredV2!.content);
    coldHarness.seedSharedProtocolV3(recoveredV3Content);
    vi.mocked(coldHarness.client.initVaultScope)
      .mockResolvedValue(replacementScope);
    await coldHarness.state.load();

    const previewCallback = vi.fn().mockResolvedValue(false);
    const preview = await coldHarness.executor.run(
      "manual",
      { onConfirmThreshold: previewCallback },
    );
    expect(preview.message).toBe("result.pausedForReview");
    expect(previewCallback.mock.calls[0]?.[0]).toMatchObject({
      reviewKind: "v2-cloud-join",
      items: [],
    });
    const joined = await coldHarness.executor.run(
      "manual",
      {},
      true,
      coldHarness.state.planReviewAuthorization!,
    );
    expect(joined.success).toBe(true);
    expect(coldHarness.state.remoteScope).toEqual({
      accountId: scope.accountId,
      ...replacementScope,
    });
    expect(JSON.parse(
      coldHarness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      protocolBinding: { migrationGeneration: generationA },
    });
    expect(coldHarness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(coldHarness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expect(JSON.parse(coldHarness.getSharedProtocolV3()!.content))
      .toMatchObject({ migrationGeneration: generationA });
    expectNoFileMutations(coldHarness.mutations);

    vi.mocked(coldHarness.client.createSharedSyncProtocolV2).mockClear();
    vi.mocked(coldHarness.client.createSharedSyncProtocolV3).mockClear();
    await coldHarness.state.close();
    const reopenedState = new StateManager(coldHarness.plugin);
    await reopenedState.load();
    const reopenedExecutor = new SyncExecutor(
      coldHarness.client,
      coldHarness.scanner,
      reopenedState,
      "testVault",
    );
    for (let round = 0; round < 2; round += 1) {
      expect(await reopenedExecutor.run("manual")).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        errors: 0,
      });
    }
    expect(await reopenedState.getActiveV2ProtocolBinding()).toMatchObject({
      migrationGeneration: generationA,
    });
    expect(coldHarness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(coldHarness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(coldHarness.mutations);
    await reopenedState.close();
  });

  it("recovers a changed scope while preserving the existing old-scope V2 protocol", async () => {
    const content = "0123456789";
    const contentHash = await sha256Hex(new TextEncoder().encode(content));
    const local = {
      ...localA,
      hash: contentHash,
    };
    const base = {
      ...baseA,
      hash: contentHash,
    };
    const harness = makeHarness({
      base: [base],
      local: [local],
      remoteHash: contentHash,
      remoteFileContents: { [local.path]: content },
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const existingProtocol = await harness.client.readSharedSyncProtocolV2(
      "testVault",
    );
    expect(existingProtocol).not.toBeNull();

    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    const restoreReplacement = vi.fn()
      .mockRejectedValueOnce(
        new RemoteVaultScopeIdentityError("files-root-invalid"),
      )
      .mockResolvedValue(replacementScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreReplacement;
    }).restoreVaultScopeByIdentity = restoreReplacement;
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);

    expect((await harness.executor.run("auto")).message)
      .toBe("result.v2ScopeRecoveryPending");

    const rootFolder = harness.remoteItemState.find(
      (item) => item.id === "folder-notes",
    )!;
    rootFolder.parentReference = { id: replacementScope.filesRootId };
    const remoteFile = harness.remoteItemState.find(
      (item) => item.id === "file-a",
    )!;
    remoteFile.file = { hashes: {} };
    vi.mocked(harness.client.getFileMetadata).mockResolvedValue({
      driveId: remoteFile.id,
      parentId: remoteFile.parentReference!.id!,
      size: remoteFile.size!,
      mtime: new Date(remoteFile.lastModifiedDateTime!).getTime(),
      eTag: remoteFile.eTag!,
      cTag: remoteFile.cTag!,
      downloadUrl: remoteFile["@microsoft.graph.downloadUrl"],
    });
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [...harness.remoteItemState],
        "@odata.deltaLink": "https://graph.example/recovery-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-stable",
      });
    vi.mocked(harness.mutations.downloadFile).mockClear();

    const recovered = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      message: "result.synced",
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(1);
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.state.remoteScope).toEqual({
      accountId: scope.accountId,
      ...replacementScope,
    });
    await expect(harness.client.readSharedSyncProtocolV2("testVault"))
      .resolves.toEqual(existingProtocol);
    expect(harness.getSharedProtocolV3()).not.toBeNull();
    expect(JSON.parse(harness.getSharedProtocolV3()!.content))
      .not.toHaveProperty("scope");
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      protocolBinding: {
        protocolVersion: 3,
        migrationGeneration: JSON.parse(existingProtocol!.content)
          .migrationGeneration,
      },
    });
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("blocks a conflicting V3 protocol before recovery scan or file download", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    const restoreReplacement = vi.fn()
      .mockRejectedValueOnce(
        new RemoteVaultScopeIdentityError("files-root-invalid"),
      )
      .mockResolvedValue(replacementScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreReplacement;
    }).restoreVaultScopeByIdentity = restoreReplacement;
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);
    expect((await harness.executor.run("auto")).message)
      .toBe("result.v2ScopeRecoveryPending");

    const conflicting = JSON.parse(harness.getSharedProtocolV3()!.content);
    conflicting.migrationGeneration = "f".repeat(64);
    harness.seedSharedProtocolV3(JSON.stringify(conflicting));
    vi.mocked(harness.scanner.scanAll).mockClear();
    vi.mocked(harness.mutations.downloadFile).mockClear();
    harness.getDelta.mockClear();

    const blocked = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(blocked).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2ScopeRecoveryProtocolBlocked",
    });
    expect(harness.scanner.scanAll).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(true);
  });

  it("retains remote-scope recovery when protocol preflight is temporarily unavailable", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    const restoreReplacement = vi.fn()
      .mockRejectedValueOnce(
        new RemoteVaultScopeIdentityError("files-root-invalid"),
      )
      .mockResolvedValue(replacementScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreReplacement;
    }).restoreVaultScopeByIdentity = restoreReplacement;
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);
    expect((await harness.executor.run("auto")).message)
      .toBe("result.v2ScopeRecoveryPending");

    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    const defaultReadProfile = readProfile.getMockImplementation()!;
    readProfile.mockReset()
      .mockRejectedValueOnce(new SyntheticRequestTimeoutError(15_000));
    vi.mocked(harness.scanner.scanAll).mockClear();
    harness.getDelta.mockClear();

    const unavailable = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(unavailable).toMatchObject({
      success: false,
      errors: 1,
      message: "result.remoteReadUnavailable",
      remoteScopeRecovery: {
        protocolPreflight: "blocked",
        failureStage: "protocol-preflight",
      },
    });
    expect(unavailable.disposition).toBeUndefined();
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(true);
    expect(harness.scanner.scanAll).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect(readProfile).toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);

    harness.clearSharedProtocolForRecoveredScope();
    readProfile.mockImplementation(defaultReadProfile);
    vi.mocked(harness.scanner.scanAll).mockResolvedValueOnce({
      entries: [],
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-stable",
      });
    const recovered = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );
    expect(recovered).toMatchObject({ success: true, errors: 0 });
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(readProfile.mock.calls.length).toBeGreaterThan(1);
  });

  it("resumes after receipt persistence and body failures without redownloading valid receipts", async () => {
    const contents = {
      "Notes/a.md": "aaaaaaaaaa",
      "Notes/b.md": "bbbbbbbbbb",
      "Notes/c.md": "cccccccccc",
    };
    const hashes = Object.fromEntries(await Promise.all(
      Object.entries(contents).map(async ([path, content]) => [
        path,
        await sha256Hex(new TextEncoder().encode(content)),
      ]),
    ));
    const local = Object.entries(contents).map(([path, content], index) => ({
      path,
      size: content.length,
      mtime: index + 1,
      hash: hashes[path]!,
      binary: false,
    }));
    const base = local.map((entry, index) => ({
      path: entry.path,
      hash: entry.hash,
      size: entry.size,
      eTag: `etag-${index + 1}`,
    }));
    const remote: DriveItem[] = [
      {
        id: "folder-notes",
        name: "Notes",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-notes",
        cTag: "ctag-notes",
      },
      ...local.map((entry, index) => ({
        id: `file-${index + 1}`,
        name: entry.path.split("/").at(-1)!,
        size: entry.size,
        file: { hashes: { sha256Hash: entry.hash } },
        parentReference: { id: "folder-notes" },
        lastModifiedDateTime: "2026-08-05T00:00:00.000Z",
        eTag: `etag-${index + 1}`,
        cTag: `ctag-${index + 1}`,
      })),
    ];
    const harness = makeHarness({
      base,
      local,
      remoteItems: remote,
      remoteFileContents: contents,
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    const restoreReplacement = vi.fn()
      .mockRejectedValueOnce(
        new RemoteVaultScopeIdentityError("files-root-invalid"),
      )
      .mockResolvedValue(replacementScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreReplacement;
    }).restoreVaultScopeByIdentity = restoreReplacement;
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);
    expect((await harness.executor.run("auto")).message)
      .toBe("result.v2ScopeRecoveryPending");

    harness.remoteItemState.find((item) => item.id === "folder-notes")!
      .parentReference = { id: replacementScope.filesRootId };
    for (const item of harness.remoteItemState) {
      if (item.file) item.file = { hashes: {} };
    }
    vi.mocked(harness.client.getFileMetadata).mockImplementation(
      async (_vaultName: string, path: string) => {
        const item = harness.remoteItemState.find((candidate) =>
          candidate.file && candidate.name === path.split("/").at(-1));
        return item ? {
          driveId: item.id,
          parentId: item.parentReference!.id!,
          size: item.size!,
          mtime: new Date(item.lastModifiedDateTime!).getTime(),
          eTag: item.eTag!,
          cTag: item.cTag!,
          downloadUrl: item["@microsoft.graph.downloadUrl"],
        } : null;
      },
    );
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [...harness.remoteItemState],
        "@odata.deltaLink": "https://graph.example/recovery-first",
      })
      .mockResolvedValueOnce({
        value: [...harness.remoteItemState],
        "@odata.deltaLink": "https://graph.example/recovery-second",
      })
      .mockResolvedValueOnce({
        value: [...harness.remoteItemState],
        "@odata.deltaLink": "https://graph.example/recovery-third",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-stable",
      });
    vi.mocked(harness.mutations.downloadFile).mockClear();
    const putVerified = harness.state.putVerifiedRemoteScopeRecoveryEvidence
      .bind(harness.state);
    let receiptWrites = 0;
    vi.spyOn(harness.state, "putVerifiedRemoteScopeRecoveryEvidence")
      .mockImplementation(async (receipt) => {
        receiptWrites++;
        if (receiptWrites === 2) {
          throw new Error("injected receipt quota failure");
        }
        await putVerified(receipt);
      });
    let failLastOnce = true;
    vi.mocked(harness.mutations.downloadFile).mockImplementation(
      async (_vaultName: string, path: string) => {
        if (path === "Notes/c.md" && failLastOnce) {
          failLastOnce = false;
          throw new Error("injected final verification failure");
        }
        return new TextEncoder().encode(contents[path as keyof typeof contents])
          .buffer;
      },
    );

    const interrupted = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );
    expect(interrupted).toMatchObject({
      success: false,
      errors: 1,
      remoteScopeRecovery: {
        total: 3,
        verifiedThisRun: 1,
        reused: 0,
        remaining: 2,
        failureStage: "body-verification",
        firstFailurePath: "Notes/b.md",
      },
    });
    expect(harness.mutations.downloadFile.mock.calls.map((call) => call[1]))
      .toEqual(["Notes/a.md", "Notes/b.md"]);

    // N2 — scope-recovery verification must batch the downloadUrl refresh up
    // front (finding C14 root cause: delta projections never carry a
    // pre-signed URL, so without this every verification download pays a
    // per-file refresh round trip). The batch wiring is exercised with the
    // real candidate list instead of being silently skipped.
    expect((harness.client as unknown as {
      getDriveItemMetadataByIds: ReturnType<typeof vi.fn>;
    }).getDriveItemMetadataByIds).toHaveBeenCalledWith(
      expect.arrayContaining(["file-1", "file-2", "file-3"]),
      "downloadUrlRefresh",
    );

    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new SyncExecutor(
      harness.client as never,
      harness.scanner,
      restartedState,
      "testVault",
    );
    const interruptedAgain = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(interruptedAgain).toMatchObject({
      success: false,
      errors: 1,
      remoteScopeRecovery: {
        total: 3,
        verifiedThisRun: 1,
        reused: 1,
        remaining: 1,
        failureStage: "body-verification",
        firstFailurePath: "Notes/c.md",
      },
    });
    expect(harness.mutations.downloadFile.mock.calls.map((call) => call[1]))
      .toEqual([
        "Notes/a.md",
        "Notes/b.md",
        "Notes/b.md",
        "Notes/c.md",
      ]);

    await restartedState.close();
    const finalState = new StateManager(harness.plugin);
    await finalState.load();
    const finalExecutor = new SyncExecutor(
      harness.client as never,
      harness.scanner,
      finalState,
      "testVault",
    );
    const recovered = await finalExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      message: "result.synced",
      remoteScopeRecovery: {
        total: 3,
        verifiedThisRun: 1,
        reused: 2,
        remaining: 0,
      },
    });
    expect(harness.mutations.downloadFile.mock.calls.map((call) => call[1]))
      .toEqual([
        "Notes/a.md",
        "Notes/b.md",
        "Notes/b.md",
        "Notes/c.md",
        "Notes/c.md",
      ]);
    expect(finalState.hasV2RemoteScopeRecovery).toBe(false);
    expectNoFileMutations({
      ...harness.mutations,
      downloadFile: vi.fn(),
    });
  });

  it("keeps V2 active without staging scope recovery on a transient identity lookup failure", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.NetworkError,
        "temporary network failure",
      ),
    );
    vi.mocked(harness.client.initVaultScope).mockClear();

    const failed = await harness.executor.run("manual");

    expect(failed.success).toBe(false);
    expect(failed.message).toBe("result.syncFailed");
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.client.initVaultScope).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("commits recovered V2 authority before exposing a non-zero canonical review", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.clearSharedProtocolForRecoveredScope();

    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    const restoreReplacement = vi.fn()
      .mockRejectedValueOnce(
        new RemoteVaultScopeIdentityError("files-root-invalid"),
      )
      .mockResolvedValue(replacementScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreReplacement;
    }).restoreVaultScopeByIdentity = restoreReplacement;
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/recovery-stable",
      });
    const onConfirmThreshold = vi.fn(async () => false);

    const paused = await harness.executor.run(
      "manual",
      { onConfirmThreshold },
    );
    expect(paused.message).toBe("result.pausedForReview");
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.state.remoteScope).toEqual({
      accountId: scope.accountId,
      ...replacementScope,
    });
    expect(onConfirmThreshold).toHaveBeenCalledTimes(1);
    const reviewed = onConfirmThreshold.mock.calls[0]![0];
    expect(reviewed.items).toContainEqual(expect.objectContaining({
      type: SyncActionType.CreateRemoteFolder,
      path: "Notes",
    }));
    expect(reviewed.items).toContainEqual(expect.objectContaining({
      type: SyncActionType.Upload,
      path: localA.path,
    }));
    expect(reviewed.canonicalIdentity).toMatchObject({
      version: 2,
      scope: {
        accountId: scope.accountId,
        ...replacementScope,
      },
    });
    expectNoFileMutations(harness.mutations);
  });

  it("auto sync stages a V2 scope hold without rebuilding an absent remote path", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.NotFound,
        "committed scope missing",
        404,
      ),
    );
    vi.mocked(harness.client.initVaultScope).mockRejectedValueOnce(
      new OneDriveError(
        OneDriveErrorType.NotFound,
        "vault path missing",
        404,
      ),
    );

    const paused = await harness.executor.run("auto");

    expect(paused.message).toBe("result.v2ScopeRecoveryPending");
    expect(paused.deferred).toBe(1);
    expect(paused.errors).toBe(0);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.activeV2RemoteScopeRecovery).toMatchObject({
      reason: "committed-scope-unreachable",
      observedScope: null,
    });
    expect(harness.client.initVaultScope).toHaveBeenCalledWith(
      "testVault",
      { createMissing: false },
    );
    expectNoFileMutations(harness.mutations);
  });

  it("recreates a missing remote scope only after a durable visible review", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.clearSharedProtocolForRecoveredScope();
    const createdScope = {
      driveId: "drive-created",
      vaultFolderId: "vault-created",
      filesRootId: "root-created",
    };
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.NotFound,
        "committed scope missing",
        404,
      ),
    );
    vi.mocked(harness.client.initVaultScope).mockRejectedValue(
      new OneDriveError(
        OneDriveErrorType.NotFound,
        "vault path missing",
        404,
      ),
    );
    const onConfirmThreshold = vi.fn(async () => false);
    const reviewed = await harness.executor.run(
      "manual",
      { onConfirmThreshold },
    );

    expect(reviewed.message).toBe("result.pausedForReview");
    expect(onConfirmThreshold).toHaveBeenCalledTimes(1);
    const plan = onConfirmThreshold.mock.calls[0]![0];
    expect(plan.items).toEqual([expect.objectContaining({
      type: SyncActionType.RecreateRemoteScope,
      path: "testVault",
      reason: "reason.remoteScopeRecreate",
    })]);
    expect(plan.canonicalReview?.counts.folders).toBe(1);
    expect(
      harness.state.activeV2RemoteScopeRecovery?.scopeBootstrap?.phase,
    ).toBe("pending");
    expect(harness.client.initVaultScope).not.toHaveBeenCalledWith(
      "testVault",
      { createMissing: true },
    );

    await harness.state.setPlanReviewBundle(
      plan.items,
      plan.canonicalReview!.counts,
      plan.scope!,
      plan.canonicalIdentity,
    );
    const authorization = harness.state.planReviewAuthorization;
    expect(authorization).not.toBeNull();
    let createAttempts = 0;
    vi.mocked(harness.client.initVaultScope).mockImplementation(
      async (_vaultName, options) => {
        if (options?.createMissing === true) {
          createAttempts++;
          if (createAttempts === 1) {
            throw new OneDriveError(
              OneDriveErrorType.NetworkError,
              "create response was lost",
            );
          }
          return createdScope;
        }
        if (createAttempts >= 2) return createdScope;
        throw new OneDriveError(
          OneDriveErrorType.NotFound,
          "vault path missing",
          404,
        );
      },
    );
    const restoreCreated = vi.fn().mockResolvedValue(createdScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreCreated;
    }).restoreVaultScopeByIdentity = restoreCreated;
    vi.mocked(harness.scanner.scanAll).mockResolvedValueOnce({
      entries: [],
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/bootstrap-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/bootstrap-stable",
      });

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
      { recoverV2RemoteScope: true },
    );

    expect(interrupted.success).toBe(false);
    expect(interrupted.message).toBe("result.syncFailed");
    expect(
      harness.state.activeV2RemoteScopeRecovery?.scopeBootstrap?.phase,
    ).toBe("confirmed");
    expect(harness.state.planReviewActive).toBe(false);
    expectNoFileMutations(harness.mutations);

    const recovered = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(recovered.success).toBe(true);
    expect(
      vi.mocked(harness.client.initVaultScope).mock.calls.filter(
        ([, options]) => options?.createMissing === true,
      ),
    ).toHaveLength(2);
    expect(createAttempts).toBe(2);
    expect(restoreCreated).toHaveBeenCalledWith(
      "testVault",
      createdScope,
    );
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.state.planReviewActive).toBe(false);
    expect(harness.state.remoteScope).toEqual({
      accountId: scope.accountId,
      ...createdScope,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("resumes a confirmed remote-scope bootstrap after restart without a second review", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.clearSharedProtocolForRecoveredScope();
    await harness.state.stageV2RemoteScopeRecovery({
      observedScope: null,
      now: 60,
    });
    const staged = await harness.state.stageV2RemoteScopeBootstrapReview(70);
    const item = {
      type: SyncActionType.RecreateRemoteScope,
      path: "testVault",
      reason: "reason.remoteScopeRecreate",
      reviewImpactCount: 1,
    };
    const identity = {
      version: 2 as const,
      scope,
      sourceCommitSeq: staged.meta.commitSeq,
      digest: canonicalPlanDigestV2({
        items: [item],
        lastTotalFiles: 1,
        scope,
        sourceCommitSeq: staged.meta.commitSeq,
      }),
    };
    await harness.state.setPlanReviewBundle(
      [item],
      {
        uploads: 0,
        downloads: 0,
        folders: 1,
        deletes: 0,
        conflicts: 0,
        skipped: 0,
      },
      scope,
      identity,
    );
    await harness.state.confirmV2RemoteScopeBootstrapReview(
      harness.state.planReviewAuthorization!,
      80,
    );

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const createdScope = {
      driveId: "drive-created",
      vaultFolderId: "vault-created",
      filesRootId: "root-created",
    };
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(createdScope);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockResolvedValue(createdScope);
    vi.mocked(harness.scanner.scanAll).mockResolvedValueOnce({
      entries: [],
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/restart-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/restart-stable",
      });
    const restartedExecutor = new SyncExecutor(
      harness.client as never,
      harness.scanner,
      restartedState,
      "testVault",
    );

    const recovered = await restartedExecutor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(recovered.success).toBe(true);
    expect(harness.client.initVaultScope).toHaveBeenCalledWith(
      "testVault",
      { createMissing: true },
    );
    expect(restartedState.hasV2RemoteScopeRecovery).toBe(false);
    expect(restartedState.remoteScope).toEqual({
      accountId: scope.accountId,
      ...createdScope,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("refreshes a stale held scope observation and recovers only the current path identity", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.clearSharedProtocolForRecoveredScope();
    const firstReplacement = {
      driveId: "drive-live",
      vaultFolderId: "vault-live-1",
      filesRootId: "root-live-1",
    };
    const currentReplacement = {
      driveId: "drive-live",
      vaultFolderId: "vault-live-2",
      filesRootId: "root-live-2",
    };
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockRejectedValue(
      new RemoteVaultScopeIdentityError("files-root-invalid"),
    );
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(firstReplacement);
    expect((await harness.executor.run("auto")).message)
      .toBe("result.v2ScopeRecoveryPending");
    expect(harness.state.activeV2RemoteScopeRecovery?.observedScope)
      .toEqual({ accountId: scope.accountId, ...firstReplacement });

    vi.mocked(harness.client.initVaultScope)
      .mockResolvedValue(currentReplacement);
    const restoreCurrent = vi.fn().mockResolvedValue(currentReplacement);
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreCurrent;
    }).restoreVaultScopeByIdentity = restoreCurrent;
    vi.mocked(harness.scanner.scanAll).mockResolvedValueOnce({
      entries: [],
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/refreshed-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/refreshed-stable",
      });

    const recovered = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(recovered.success).toBe(true);
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.state.remoteScope).toEqual({
      accountId: scope.accountId,
      ...currentReplacement,
    });
    expect(restoreCurrent).toHaveBeenCalledWith(
      "testVault",
      currentReplacement,
    );
    expect(harness.getDelta.mock.calls).toEqual([
      [currentReplacement.filesRootId],
      [
        currentReplacement.filesRootId,
        "https://graph.example/refreshed-snapshot",
      ],
    ]);
    expectNoFileMutations(harness.mutations);
  });

  it("discards recovery evidence when path ownership changes before the exact delta scan", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const observedScope = {
      accountId: scope.accountId,
      driveId: "drive-live",
      vaultFolderId: "vault-live-1",
      filesRootId: "root-live-1",
    };
    const changedScope = {
      accountId: scope.accountId,
      driveId: "drive-live",
      vaultFolderId: "vault-live-2",
      filesRootId: "root-live-2",
    };
    await harness.state.stageV2RemoteScopeRecovery({
      observedScope,
      now: 60,
    });
    vi.mocked(harness.client.initVaultScope)
      .mockResolvedValueOnce({
        driveId: observedScope.driveId,
        vaultFolderId: observedScope.vaultFolderId,
        filesRootId: observedScope.filesRootId,
      })
      .mockResolvedValueOnce({
        driveId: changedScope.driveId,
        vaultFolderId: changedScope.vaultFolderId,
        filesRootId: changedScope.filesRootId,
      });
    const restoreObserved = vi.fn().mockResolvedValue({
      driveId: observedScope.driveId,
      vaultFolderId: observedScope.vaultFolderId,
      filesRootId: observedScope.filesRootId,
    });
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreObserved;
    }).restoreVaultScopeByIdentity = restoreObserved;
    harness.getDelta.mockClear();

    const paused = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(paused.message).toBe("result.v2ScopeRecoveryPending");
    expect(paused.deferred).toBe(1);
    expect(harness.state.remoteScope).toEqual(scope);
    expect(harness.state.activeV2RemoteScopeRecovery?.observedScope)
      .toEqual(changedScope);
    expect(harness.getDelta).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("discards a complete recovery snapshot when final path ownership no longer matches", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const observedScope = {
      accountId: scope.accountId,
      driveId: "drive-live",
      vaultFolderId: "vault-live-1",
      filesRootId: "root-live-1",
    };
    const changedScope = {
      accountId: scope.accountId,
      driveId: "drive-live",
      vaultFolderId: "vault-live-2",
      filesRootId: "root-live-2",
    };
    await harness.state.stageV2RemoteScopeRecovery({
      observedScope,
      now: 60,
    });
    vi.mocked(harness.client.initVaultScope)
      .mockResolvedValueOnce({
        driveId: observedScope.driveId,
        vaultFolderId: observedScope.vaultFolderId,
        filesRootId: observedScope.filesRootId,
      })
      .mockResolvedValueOnce({
        driveId: observedScope.driveId,
        vaultFolderId: observedScope.vaultFolderId,
        filesRootId: observedScope.filesRootId,
      })
      .mockResolvedValueOnce({
        driveId: changedScope.driveId,
        vaultFolderId: changedScope.vaultFolderId,
        filesRootId: changedScope.filesRootId,
      });
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockResolvedValue({
      driveId: observedScope.driveId,
      vaultFolderId: observedScope.vaultFolderId,
      filesRootId: observedScope.filesRootId,
    });
    vi.mocked(harness.scanner.scanAll).mockResolvedValueOnce({
      entries: [],
      folders: [],
      folderScanComplete: true,
      folderScanFailures: [],
      skippedLarge: [],
      failedPaths: [],
      skippedCount: 0,
      complete: true,
    });
    harness.getDelta.mockReset();
    harness.getDelta
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/race-snapshot",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/race-stable",
      });

    const paused = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(paused.message).toBe("result.v2ScopeRecoveryPending");
    expect(paused.deferred).toBe(1);
    expect(harness.state.remoteScope).toEqual(scope);
    expect(harness.state.activeV2RemoteScopeRecovery?.observedScope)
      .toEqual(changedScope);
    expect(harness.getDelta.mock.calls).toEqual([
      [observedScope.filesRootId],
      [
        observedScope.filesRootId,
        "https://graph.example/race-snapshot",
      ],
    ]);
    expectNoFileMutations(harness.mutations);
  });

  it("clears a held scope and resumes the same ordinary round when committed identities return", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const replacementScope = {
      driveId: "drive-live",
      vaultFolderId: "vault-live",
      filesRootId: "root-live",
    };
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: ReturnType<typeof vi.fn>;
    }).restoreVaultScopeByIdentity = vi.fn().mockRejectedValue(
      new RemoteVaultScopeIdentityError("files-root-invalid"),
    );
    vi.mocked(harness.client.initVaultScope).mockResolvedValue(replacementScope);
    expect((await harness.executor.run("auto")).message)
      .toBe("result.v2ScopeRecoveryPending");

    vi.mocked(harness.client.initVaultScope).mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    const restoreCommitted = vi.fn().mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreCommitted;
    }).restoreVaultScopeByIdentity = restoreCommitted;
    harness.getDelta.mockClear();
    vi.mocked(harness.scanner.scanAll).mockClear();

    const recovered = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { recoverV2RemoteScope: true },
    );

    expect(recovered.success).toBe(true);
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.state.remoteScope).toEqual(scope);
    expect(harness.scanner.scanAll).toHaveBeenCalledTimes(1);
    expect(restoreCommitted).toHaveBeenCalledWith("testVault", {
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    expect(harness.getDelta).toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("rebuilds a mismatched V2 cursor route from the verified committed scope", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await harness.state.setRemoteState(
      harness.state.remoteSnapshot,
      "https://graph.example/wrong-vault/delta",
      scope,
      harness.state.remoteFolders,
    );
    vi.mocked(harness.client.isDeltaLinkForVault).mockImplementation(
      (_vaultName: string, deltaLink: string) =>
        !deltaLink.includes("wrong-vault"),
    );
    const restoreByIdentity = vi.fn().mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreByIdentity;
    }).restoreVaultScopeByIdentity = restoreByIdentity;
    harness.getDelta.mockClear();

    const recovered = await harness.executor.run("manual");

    expect(recovered.success).toBe(true);
    expect(harness.getDelta).toHaveBeenCalledWith("testVault", undefined, expect.anything());
    expect(harness.getDelta).not.toHaveBeenCalledWith(
      "testVault",
      "https://graph.example/wrong-vault/delta",
    );
    expect(restoreByIdentity).toHaveBeenCalledWith("testVault", {
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    expect(harness.state.remoteDeltaLink)
      .toBe("https://graph.example/delta-current");
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.files.has(paths.stateV2RetiredManifestFile)).toBe(false);
  });

  it("rebuilds an expired V2 cursor only after committed scope identities revalidate", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const restoreByIdentity = vi.fn().mockResolvedValue({
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    (harness.client as unknown as {
      restoreVaultScopeByIdentity: typeof restoreByIdentity;
    }).restoreVaultScopeByIdentity = restoreByIdentity;
    const expiredCursor = "https://graph.example/delta-expired";
    await harness.state.setRemoteState(
      harness.state.remoteSnapshot,
      expiredCursor,
      scope,
      harness.state.remoteFolders,
    );
    harness.getDelta.mockReset();
    harness.getDelta
      .mockRejectedValueOnce(new OneDriveError(
        OneDriveErrorType.Unknown,
        "delta token expired",
        410,
      ))
      .mockResolvedValueOnce({
        value: [...harness.remoteItemState],
        "@odata.deltaLink": "https://graph.example/delta-recovered",
      });

    const recovered = await harness.executor.run("manual");

    expect(recovered.success).toBe(true);
    expect(harness.getDelta.mock.calls.map((call) => call[1])).toEqual([
      expiredCursor,
      undefined,
    ]);
    expect(restoreByIdentity).toHaveBeenCalledWith("testVault", {
      driveId: scope.driveId,
      vaultFolderId: scope.vaultFolderId,
      filesRootId: scope.filesRootId,
    });
    expect(harness.state.remoteDeltaLink)
      .toBe("https://graph.example/delta-recovered");
    expect(harness.state.hasV2RemoteScopeRecovery).toBe(false);
    expect(harness.state.isV2StateActive).toBe(true);
  });

  it("quarantines a provably unreachable upload receipt without leaving V2", async () => {
    const harness = makeHarness();
    await harness.state.load();
    const activated = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );
    expect(activated.success).toBe(true);
    const lostRemote = {
      path: "Notes/lost.md",
      driveId: "file-lost",
      parentId: "folder-notes",
      size: 12,
      mtime: 30,
      eTag: "etag-lost",
      cTag: "ctag-lost",
      sha256Hash: hashB,
    };
    const intent: MutationIntentV1 = {
      version: 1,
      operationId: "upload-lost",
      planRevision: 1,
      scope,
      action: "upload",
      path: lostRemote.path,
      expectedLocal: { exists: true, hash: hashB, size: lostRemote.size },
      expectedRemote: { exists: false },
      createdAt: 10,
    };
    const receipt: MutationReceiptV1 = {
      version: 1,
      operationId: intent.operationId,
      completedAt: 20,
      checkpoint: {
        baseUpserts: [{
          path: lostRemote.path,
          hash: hashB,
          size: lostRemote.size,
          eTag: lostRemote.eTag,
        }],
        baseRemovals: [],
        remoteUpserts: [lostRemote],
        remoteDeletes: [],
        pendingConflictRemovals: [lostRemote.path],
        pendingDeleteRemovals: [lostRemote.path],
      },
    };
    await harness.state.beginMutationIntent(intent);
    await harness.state.recordMutationReceipt(receipt);
    (harness.scanner as unknown as {
      inspectFile: ReturnType<typeof vi.fn>;
    }).inspectFile = vi.fn().mockResolvedValue({ status: "missing" });
    vi.mocked(harness.client.getDriveItemMetadataById).mockResolvedValue(null);

    const recovered = await harness.executor.run("manual");

    expect(recovered).toEqual(expect.objectContaining({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    }));
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.mutationRecoveryQuarantine).toEqual([
      expect.objectContaining({
        operationId: intent.operationId,
        reason: "receipted-upload-version-unreachable",
        sourceCommitSeq: expect.any(Number),
        remoteId: lostRemote.driveId,
        record: expect.objectContaining({
          intent: expect.objectContaining({
            operationId: intent.operationId,
          }),
          receipt: expect.objectContaining({
            operationId: intent.operationId,
          }),
        }),
      }),
    ]);
    expect(harness.state.baseSnapshot).toEqual([baseA]);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2RollbackFile)).toBe(false);
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.mutationLedger).toEqual([]);
    expect(restartedState.mutationRecoveryQuarantine).toEqual(
      harness.state.mutationRecoveryQuarantine,
    );
  });

  it("stops before scan when the V2 recovery quarantine is malformed", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.pluginData["easy-sync-v2-recovery-quarantine"] = [{
      version: 2,
      kind: "mutation-recovery-quarantine",
      operationId: "truncated-record",
    }];
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const scan = vi.spyOn(harness.scanner, "scanAll");
    scan.mockClear();
    const restartedExecutor = new SyncExecutor(
      harness.client as never,
      harness.scanner,
      restartedState,
      "testVault",
      undefined,
      undefined,
      harness.diag as never,
      harness.fileManager as never,
    );

    const result = await restartedExecutor.run("manual");

    expect(result).toMatchObject({
      success: false,
      errors: 1,
    });
    expect(result.message).toBe("result.v2RecoveryBlocked");
    expect(scan).not.toHaveBeenCalled();
    expect(restartedState.isV2StateActive).toBe(true);
  });

  it("keeps manifest-selected V2 authority and stops before scan when its envelope cannot load", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.files.set(paths.stateV2File, "{");

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const scan = vi.spyOn(harness.scanner, "scanAll");
    scan.mockClear();
    vi.mocked(harness.client.initVaultScope).mockClear();
    harness.getDelta.mockClear();
    const restartedExecutor = new SyncExecutor(
      harness.client as never,
      harness.scanner,
      restartedState,
      "testVault",
      undefined,
      undefined,
      harness.diag as never,
      harness.fileManager as never,
    );

    const result = await restartedExecutor.run("manual");

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2StateLoadBlocked",
    });
    expect(restartedState.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "envelope-unreadable",
    });
    expect(restartedState.isV2AuthoritySelected).toBe(true);
    expect(restartedState.isV2StateActive).toBe(false);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    expect(harness.client.initVaultScope).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("classifies a stable anchor corruption but still stops before scan and Graph", async () => {
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
    const anchor = Object.values(corrupt.anchors.byAnchorId)[0]!;
    anchor.anchorId = "wrong-anchor";
    harness.files.set(paths.stateV2File, JSON.stringify(corrupt));

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const scan = vi.spyOn(harness.scanner, "scanAll");
    scan.mockClear();
    vi.mocked(harness.client.initVaultScope).mockClear();
    harness.getDelta.mockClear();
    const restartedExecutor = new SyncExecutor(
      harness.client as never,
      harness.scanner,
      restartedState,
      "testVault",
      undefined,
      undefined,
      harness.diag as never,
      harness.fileManager as never,
    );

    const result = await restartedExecutor.run("manual");

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2StateLoadBlocked",
    });
    expect(restartedState.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "envelope-anchors-corrupt",
    });
    expect(restartedState.v2CorruptStateRecoveryEvidence).toMatchObject({
      sourceCommitSeq: corrupt.meta.commitSeq,
      corruption: "anchors",
    });
    expect(restartedState.isV2AuthoritySelected).toBe(true);
    expect(restartedState.isV2StateActive).toBe(false);
    expect(scan).not.toHaveBeenCalled();
    expect(harness.client.initVaultScope).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("collects a manual GET-only recovery candidate from corrupt V2 state without publishing or mutating", async () => {
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
        "@odata.deltaLink": "https://graph.example/corrupt-proof-1",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/corrupt-proof-2",
      });
    vi.mocked(harness.scanner.scanAll).mockClear();
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

    let reviewedPlan: SyncPlan | null = null;
    const result = await restartedExecutor.run(
      "manual",
      {
        onConfirmThreshold: async (plan) => {
          reviewedPlan = plan;
          await restartedState.setPlanReviewBundle(
            plan.items,
            plan.canonicalReview!.counts,
            plan.scope!,
            plan.canonicalIdentity,
          );
          return false;
        },
      },
      false,
      undefined,
      { recoverV2CorruptState: true },
    );

    expect(result).toMatchObject({
      success: false,
      errors: 0,
      message: "result.pausedForReview",
    });
    expect(reviewedPlan).toMatchObject({
      items: [],
      canonicalIdentity: expect.any(Object),
    });
    expect(harness.scanner.scanAll).toHaveBeenCalledTimes(1);
    expect(restoreByIdentity).toHaveBeenCalledTimes(2);
    expect(harness.getDelta).toHaveBeenCalledTimes(2);
    expect(harness.files.get(paths.stateV2File)).toBe(rawCorrupt);
    expect(harness.files.get(
      `${paths.stateV2CorruptSourcePrefix}${evidence.sourceDigest}.json`,
    )).toBe(rawCorrupt);
    expect(restartedState.isV2StateActive).toBe(false);
    expect(restartedState.hasV2StateLoadRecoveryBlock).toBe(true);
    expect(restartedState.activeV2CorruptStateRecoveryHold)
      .toMatchObject({ phase: "pending", items: [] });
    expect(harness.diag.warn).toHaveBeenCalledWith(
      "state",
      expect.stringContaining("GET-only candidate"),
      expect.objectContaining({
        sourceDigest: evidence.sourceDigest,
        planItems: 0,
        mutations: 0,
      }),
    );
    expectNoFileMutations(harness.mutations);

    const resumedState = new StateManager(harness.plugin);
    await resumedState.load();
    expect(resumedState.activeV2CorruptStateRecoveryHold)
      .toMatchObject({ phase: "pending", items: [] });
    const resumedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      resumedState,
      "testVault",
      undefined,
      undefined,
      harness.diag as never,
      harness.fileManager as never,
    );
    vi.mocked(harness.scanner.scanAll).mockClear();
    restoreByIdentity.mockClear();
    harness.getDelta.mockClear();
    const authorization = resumedState.planReviewAuthorization!;
    const heldCandidate =
      resumedState.activeV2CorruptStateRecoveryHold!.candidate;
    const confirmed = await resumedExecutor.run(
      "manual",
      {},
      true,
      authorization,
      { recoverV2CorruptState: true },
    );

    expect(confirmed).toMatchObject({
      success: true,
      deferred: 0,
      message: "result.synced",
      continueAfterV2CorruptStateRecovery: true,
    });
    expect(resumedState.activeV2CorruptStateRecoveryHold).toBeNull();
    expect(resumedState.hasV2StateLoadRecoveryBlock).toBe(false);
    expect(resumedState.isV2StateActive).toBe(true);
    expect(resumedState.planReviewActive).toBe(true);
    expect(JSON.parse(harness.files.get(paths.stateV2File)!))
      .toEqual(heldCandidate);
    expect(JSON.parse(harness.files.get(paths.stateV2ManifestFile)!))
      .toMatchObject({
        stateCommitSeq: heldCandidate.meta.commitSeq,
        lifecycleEpoch: heldCandidate.meta.lifecycleEpoch,
        scope,
      });
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      revision: 2,
      manifest: {
        stateCommitSeq: heldCandidate.meta.commitSeq,
        lifecycleEpoch: heldCandidate.meta.lifecycleEpoch,
        scope,
      },
    });
    expect(harness.files.has(paths.stateV2CorruptPublicationFile)).toBe(false);
    expect(harness.files.has(paths.stateV2CorruptPublicationNextFile))
      .toBe(false);
    expect(harness.files.get(
      `${paths.stateV2CorruptSourcePrefix}${evidence.sourceDigest}.json`,
    )).toBe(rawCorrupt);
    expect(harness.scanner.scanAll).not.toHaveBeenCalled();
    expect(restoreByIdentity).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    await resumedState.clearPlanReview(authorization);
    expect(resumedState.activeV2CorruptStateRecoveryHold).toBeNull();
    expect(resumedState.planReviewActive).toBe(false);
    const afterCancellation = new StateManager(harness.plugin);
    await afterCancellation.load();
    expect(afterCancellation.activeV2CorruptStateRecoveryHold).toBeNull();
    expect(afterCancellation.planReviewActive).toBe(false);
  });

  it("publishes a reviewed nonzero corrupt-state candidate before the ordinary V2 chain executes it once", async () => {
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
    harness.files.set(paths.stateV2File, JSON.stringify(corrupt));
    const remoteFileIndex = harness.remoteItemState.findIndex(
      (item) => item.id === "file-a",
    );
    expect(remoteFileIndex).toBeGreaterThanOrEqual(0);
    harness.remoteItemState.splice(remoteFileIndex, 1);
    const changedContent = "local content awaiting recovery";
    const changedBytes = new TextEncoder().encode(changedContent);
    harness.files.set(localA.path, changedContent);
    Object.assign(harness.localEntryState[0]!, {
      hash: await sha256Hex(changedBytes),
      size: changedBytes.byteLength,
      mtime: harness.localEntryState[0]!.mtime + 1,
    });

    const recoveryState = new StateManager(harness.plugin);
    await recoveryState.load();
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
        "@odata.deltaLink": "https://graph.example/nonzero-proof-1",
      })
      .mockResolvedValueOnce({
        value: [],
        "@odata.deltaLink": "https://graph.example/nonzero-proof-2",
      })
      .mockResolvedValue({
        value: [],
        "@odata.deltaLink": "https://graph.example/nonzero-proof-3",
      });
    const recoveryExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      recoveryState,
      "testVault",
      undefined,
      undefined,
      harness.diag as never,
      harness.fileManager as never,
    );
    let reviewedPlan: SyncPlan | null = null;
    const preview = await recoveryExecutor.run(
      "manual",
      {
        onConfirmThreshold: async (plan) => {
          reviewedPlan = plan;
          await recoveryState.setPlanReviewBundle(
            plan.items,
            plan.canonicalReview!.counts,
            plan.scope!,
            plan.canonicalIdentity,
          );
          return false;
        },
      },
      false,
      undefined,
      { recoverV2CorruptState: true },
    );
    expect(preview.message).toBe("result.pausedForReview");
    expect(reviewedPlan!.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: localA.path,
      }),
    ]);

    const resumedState = new StateManager(harness.plugin);
    await resumedState.load();
    const authorization = resumedState.planReviewAuthorization!;
    const resumedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      resumedState,
      "testVault",
      undefined,
      undefined,
      harness.diag as never,
      harness.fileManager as never,
    );
    harness.mutations.uploadFile.mockClear();
    const publication = await resumedExecutor.run(
      "manual",
      {},
      true,
      authorization,
      { recoverV2CorruptState: true },
    );

    expect(publication).toMatchObject({
      success: true,
      uploaded: 0,
      continueAfterV2CorruptStateRecovery: true,
    });
    expect(resumedState.isV2StateActive).toBe(true);
    expect(resumedState.planReviewActive).toBe(true);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    harness.mutations.uploadFile.mockResolvedValueOnce({
      id: "uploaded-file",
      name: "a.md",
      size: changedBytes.byteLength,
      file: { hashes: {} },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-07-28T00:00:00.000Z",
      eTag: "etag-uploaded",
      cTag: "ctag-uploaded",
    });

    const ordinary = await resumedExecutor.run(
      "manual",
      {},
      true,
      authorization,
    );

    expect(ordinary).toMatchObject({
      success: true,
      uploaded: 1,
      errors: 0,
      message: "result.synced",
    });
    expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
    expect(resumedState.planReviewActive).toBe(false);
  });

  it("never lets an automatic round collect corrupt-state Graph evidence", async () => {
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
    corrupt.remoteIndex.itemsById["file-a"]!.parentId = "missing-parent";
    harness.files.set(paths.stateV2File, JSON.stringify(corrupt));
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    vi.mocked(harness.scanner.scanAll).mockClear();
    harness.getDelta.mockClear();
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
      "auto",
      {},
      false,
      undefined,
      { recoverV2CorruptState: true },
    );

    expect(result).toMatchObject({
      errors: 1,
      message: "result.v2StateLoadBlocked",
    });
    expect(harness.scanner.scanAll).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

});
