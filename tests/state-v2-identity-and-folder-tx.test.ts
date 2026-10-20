// 身份重绑、文件夹事务与重启恢复
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
  TFolder,
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
  it("rebinds an unchanged same-path replacement once and the next V2 round stays zero", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );
    const oldIndex = harness.remoteItemState.findIndex(
      (item) => item.id === "file-a",
    );
    harness.remoteItemState.splice(oldIndex, 1, {
      id: "file-a-rebuilt",
      name: "a.md",
      size: localA.size,
      file: { hashes: { sha256Hash: hashA } },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-07-26T00:00:00.000Z",
      eTag: "etag-a-rebuilt",
      cTag: "ctag-a-rebuilt",
    });

    const rebound = await harness.executor.run("manual");

    expect(rebound).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toEqual([
      expect.objectContaining({
        anchorId: "migrated:file-a",
        remoteId: "file-a-rebuilt",
        remoteIdentityLineage: [
          expect.objectContaining({
            fromRemoteId: "file-a",
            toRemoteId: "file-a-rebuilt",
            path: localA.path,
            confirmedBy: "equal-read",
          }),
        ],
      }),
    ]);
    expectNoFileMutations(harness.mutations);

    const settled = await harness.executor.run("manual");
    expect(settled).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("downloads a changed same-path replacement once and advances the remote identity lineage", async () => {
    const originalContent = "common-v2";
    const remoteContent = "external-remote-v2";
    const originalHash = await sha256Hex(new TextEncoder().encode(originalContent));
    const remoteHash = await sha256Hex(new TextEncoder().encode(remoteContent));
    const local = {
      ...localA,
      size: originalContent.length,
      hash: originalHash,
    };
    const base = {
      ...baseA,
      size: originalContent.length,
      hash: originalHash,
    };
    const harness = makeHarness({
      base: [base],
      local: [local],
      remoteItems: remoteItems(originalHash).map((item) =>
        item.id === "file-a"
          ? {
              ...item,
              size: originalContent.length,
              file: { hashes: { sha256Hash: originalHash } },
            }
          : item),
      initialFiles: { [local.path]: originalContent },
      remoteFileContents: { [local.path]: remoteContent },
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    const oldIndex = harness.remoteItemState.findIndex(
      (item) => item.id === "file-a",
    );
    harness.remoteItemState.splice(oldIndex, 1, {
      id: "file-a-external-rebuild",
      name: "a.md",
      size: remoteContent.length,
      file: { hashes: { sha256Hash: remoteHash } },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-07-29T00:00:00.000Z",
      eTag: "etag-a-external-rebuild",
      cTag: "ctag-a-external-rebuild",
    });

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(1);
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.localEntryState).toContainEqual(expect.objectContaining({
      path: local.path,
      hash: remoteHash,
      size: remoteContent.length,
    }));
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toEqual([
      expect.objectContaining({
        remoteId: "file-a-external-rebuild",
        contentHash: remoteHash,
        remoteIdentityLineage: [
          expect.objectContaining({
            fromRemoteId: "file-a",
            toRemoteId: "file-a-external-rebuild",
            path: local.path,
            confirmedBy: "download-cas",
          }),
        ],
      }),
    ]);
    expect(harness.state.mutationLedger).toEqual([]);

    const settled = await harness.executor.run("manual");
    expect(settled).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
  });

  it("keeps both sides when a same-path replacement and the local file both changed", async () => {
    const originalContent = "common-v2";
    const localContent = "local-external-race";
    const remoteContent = "remote-external-race";
    const originalHash = await sha256Hex(new TextEncoder().encode(originalContent));
    const localHash = await sha256Hex(new TextEncoder().encode(localContent));
    const remoteHash = await sha256Hex(new TextEncoder().encode(remoteContent));
    const local = {
      ...localA,
      size: originalContent.length,
      hash: originalHash,
    };
    const base = {
      ...baseA,
      size: originalContent.length,
      hash: originalHash,
    };
    const harness = makeHarness({
      base: [base],
      local: [local],
      remoteItems: remoteItems(originalHash).map((item) =>
        item.id === "file-a"
          ? {
              ...item,
              size: originalContent.length,
              file: { hashes: { sha256Hash: originalHash } },
            }
          : item),
      initialFiles: { [local.path]: originalContent },
      remoteFileContents: { [local.path]: remoteContent },
    });
    await harness.state.load();
    await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    harness.files.set(local.path, localContent);
    Object.assign(harness.localEntryState[0]!, {
      hash: localHash,
      size: localContent.length,
      mtime: 2,
    });
    const oldIndex = harness.remoteItemState.findIndex(
      (item) => item.id === "file-a",
    );
    harness.remoteItemState.splice(oldIndex, 1, {
      id: "file-a-external-conflict",
      name: "a.md",
      size: remoteContent.length,
      file: { hashes: { sha256Hash: remoteHash } },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-07-29T00:00:00.000Z",
      eTag: "etag-a-external-conflict",
      cTag: "ctag-a-external-conflict",
    });

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 1,
      deferred: 0,
      errors: 0,
    });
    expectNoFileMutations(harness.mutations);
    expect(harness.localEntryState[0]).toMatchObject({
      path: local.path,
      hash: localHash,
      size: localContent.length,
    });
    expect(harness.state.pendingConflicts).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: local.path,
        local: expect.objectContaining({ hash: localHash }),
        remote: expect.objectContaining({
          driveId: "file-a-external-conflict",
          eTag: "etag-a-external-conflict",
          sha256Hash: remoteHash,
        }),
      }),
    ]);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      ),
    ).toEqual([
      expect.objectContaining({
        remoteId: "file-a",
        contentHash: originalHash,
      }),
    ]);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("creates local-only empty folders remotely parent-first and converges", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localFolderPaths.add("Empty");
    harness.localFolderPaths.add("Empty/Nested");
    const created = await harness.executor.run("manual");

    expect(created).toMatchObject({
      success: true,
      foldersCreated: 2,
      errors: 0,
      deferred: 0,
    });
    const empty = findRemoteItemByPath(harness.remoteItemState, "Empty");
    const nested = findRemoteItemByPath(harness.remoteItemState, "Empty/Nested");
    expect(empty?.folder).toBeTruthy();
    expect(nested?.parentReference?.id).toBe(empty?.id);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(
      Object.values(harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId)
        .map((anchor) => anchor.lastPath)
        .sort(),
    ).toEqual(["Empty", "Empty/Nested", "Notes"]);

    const settled = await harness.executor.run("manual");
    expect(settled).toMatchObject({
      success: true,
      foldersCreated: 0,
      errors: 0,
      deferred: 0,
    });
  });

  it("recovers a lost remote create response without creating a second folder", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localFolderPaths.add("ResponseLost");
    harness.loseFolderCreateResponseOnce();
    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.remoteItemState.filter(
      (item) => item.name === "ResponseLost" && item.folder,
    )).toHaveLength(1);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("recovers a lost local folder-create response without creating it twice", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.remoteItemState.push({
      id: "folder-cloud-only",
      name: "CloudOnly",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-cloud-only",
    });
    harness.loseLocalFolderCreateResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.scanner.vault.createFolder).toHaveBeenCalledOnce();
    expect(harness.localFolderPaths.has("CloudOnly")).toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).foldersCreated).toBe(0);
    expect(harness.scanner.vault.createFolder).toHaveBeenCalledOnce();
  });

  it("confirms a mobile folder create once adapter/index visibility settles", async () => {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    Platform.isMobile = true;
    Platform.isDesktop = false;
    try {
      const harness = makeHarness();
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);

      harness.remoteItemState.push({
        id: "folder-cloud-settled",
        name: "SettledCloud",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-settled-cloud",
      });

      // Simulate mobile index/adapter lag: the created folder only becomes
      // visible shortly after createFolder resolves.
      let indexVisible = false;
      const originalCreateFolder =
        harness.scanner.vault.createFolder.getMockImplementation()!;
      harness.scanner.vault.createFolder.mockImplementation(async (
        path: string,
      ) => {
        await originalCreateFolder(path);
        setTimeout(() => {
          if (path === "SettledCloud") indexVisible = true;
        }, 120);
      });
      const originalAbstract =
        harness.scanner.vault.getAbstractFileByPath.getMockImplementation()!;
      harness.scanner.vault.getAbstractFileByPath.mockImplementation(
        (path: string) => {
          if (path === "SettledCloud" && !indexVisible) return null;
          return originalAbstract(path);
        },
      );
      const originalStat =
        harness.scanner.vault.adapter.stat.getMockImplementation()!;
      harness.scanner.vault.adapter.stat.mockImplementation(async (
        path: string,
      ) => {
        if (path === "SettledCloud" && !indexVisible) return null;
        return originalStat(path);
      });

      const created = await harness.executor.run("manual");

      expect(created).toMatchObject({
        success: true,
        foldersCreated: 1,
        errors: 0,
      });
      expect(harness.scanner.vault.createFolder).toHaveBeenCalledOnce();
      expect(harness.localFolderPaths.has("SettledCloud")).toBe(true);
      expect(harness.state.mutationLedger).toEqual([]);
      expect((await harness.executor.run("manual")).foldersCreated).toBe(0);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
    }
  });

  it("keeps the fail-closed path when a mobile folder create never becomes visible", async () => {
    const previousMobile = Platform.isMobile;
    const previousDesktop = Platform.isDesktop;
    Platform.isMobile = true;
    Platform.isDesktop = false;
    try {
      const harness = makeHarness();
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);

      harness.remoteItemState.push({
        id: "folder-cloud-settled",
        name: "SettledCloud",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-settled-cloud",
      });

      // The index/adapter never exposes the created folder.
      const originalAbstract =
        harness.scanner.vault.getAbstractFileByPath.getMockImplementation()!;
      harness.scanner.vault.getAbstractFileByPath.mockImplementation(
        (path: string) => {
          if (path === "SettledCloud") return null;
          return originalAbstract(path);
        },
      );
      const originalStat =
        harness.scanner.vault.adapter.stat.getMockImplementation()!;
      harness.scanner.vault.adapter.stat.mockImplementation(async (
        path: string,
      ) => {
        if (path === "SettledCloud") return null;
        return originalStat(path);
      });

      const failed = await harness.executor.run("manual");

      expect(failed).toMatchObject({
        success: false,
        errors: 1,
        foldersCreated: 0,
      });
      expect(harness.scanner.vault.createFolder).toHaveBeenCalledOnce();
      expect(harness.state.mutationLedger).toEqual([]);
      expect(harness.state.pendingIssues).toEqual([
        expect.objectContaining({
          path: "SettledCloud",
          actionType: SyncActionType.CreateLocalFolder,
          reason: "reason.folder.local-create-unconfirmed",
        }),
      ]);
    } finally {
      Platform.isMobile = previousMobile;
      Platform.isDesktop = previousDesktop;
    }
  });

  it("keeps the not-applied classification when the local folder create itself throws", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.remoteItemState.push({
      id: "folder-cloud-refused",
      name: "RefusedCloud",
      folder: {},
      parentReference: { id: scope.filesRootId },
      eTag: "etag-refused-cloud",
    });
    harness.scanner.vault.createFolder.mockImplementation(async () => {
      throw new Error("local folder create refused");
    });

    const failed = await harness.executor.run("manual");

    expect(failed).toMatchObject({
      success: false,
      errors: 1,
      foldersCreated: 0,
    });
    expect(harness.scanner.vault.createFolder).toHaveBeenCalledOnce();
    expect(harness.localFolderPaths.has("RefusedCloud")).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("retries the remote folder create read-back once after a network failure", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    // Local-only empty folder → create-remote. Inject one lost read-back GET
    // (the parent check is call #1, the receipt read-back starts at #2).
    harness.localFolderPaths.add("Empty");
    let metadataCalls = 0;
    const originalMetadata =
      harness.client.getDriveItemMetadataById.getMockImplementation()!;
    harness.client.getDriveItemMetadataById.mockImplementation(async (
      ...args: Parameters<typeof originalMetadata>
    ) => {
      metadataCalls++;
      if (metadataCalls === 2) {
        throw new OneDriveError(
          OneDriveErrorType.NetworkError,
          "read-back lost",
          0,
        );
      }
      return originalMetadata(...args);
    });

    const created = await harness.executor.run("manual");

    expect(created).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(metadataCalls).toBeGreaterThanOrEqual(3);
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("retries a failed folder checkpoint without repeating the remote create", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localFolderPaths.add("CheckpointRetry");
    harness.failStateRenameOnce();
    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.remoteItemState.filter(
      (item) => item.name === "CheckpointRetry" && item.folder,
    )).toHaveLength(1);
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("allows a child create when only the parent folder eTag changes", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localFolderPaths.add("Notes/New");
    harness.changeParentVersionBeforeNextRead();
    const created = await harness.executor.run("manual");

    expect(created).toMatchObject({
      success: true,
      foldersCreated: 1,
      deferred: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/New")?.folder).toBeTruthy();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("defers a child create when the committed parent moves", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localFolderPaths.add("Notes/New");
    harness.moveParentBeforeNextRead();
    const deferred = await harness.executor.run("manual");

    expect(deferred).toMatchObject({
      success: true,
      foldersCreated: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/New")).toBeNull();
    expect(harness.state.mutationLedger).toHaveLength(0);
  });

  it("creates remote-only empty folders locally parent-first and converges", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.remoteItemState.push(
      {
        id: "cloud-empty",
        name: "CloudEmpty",
        folder: {},
        parentReference: { id: scope.filesRootId },
        eTag: "etag-cloud-empty",
      },
      {
        id: "cloud-nested",
        name: "Nested",
        folder: {},
        parentReference: { id: "cloud-empty" },
        eTag: "etag-cloud-nested",
      },
    );
    const created = await harness.executor.run("manual");

    expect(created).toMatchObject({
      success: true,
      foldersCreated: 2,
      errors: 0,
      deferred: 0,
    });
    expect(harness.localFolderPaths.has("CloudEmpty")).toBe(true);
    expect(harness.localFolderPaths.has("CloudEmpty/Nested")).toBe(true);
    expect(harness.state.mutationLedger).toHaveLength(0);

    const settled = await harness.executor.run("manual");
    expect(settled).toMatchObject({
      success: true,
      foldersCreated: 0,
      errors: 0,
      deferred: 0,
    });
  });

  it("restores an explicitly reviewed remote empty folder locally and settles", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness();

    await harness.executor.restoreReviewedEmptyFolder(reviewed);

    expect(harness.localFolderPaths.has("Notes")).toBe(true);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.moveItemById).not.toHaveBeenCalled();
    expect((await harness.executor.run("manual"))).toMatchObject({
      foldersCreated: 1,
      deferred: 0,
      errors: 0,
    });
    expect((await harness.executor.run("manual"))).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
  });

  it("accepts an explicitly reviewed shared-folder identity chain and settles", async () => {
    const { harness, reviewed } = await prepareUnanchoredSharedFolderHarness();

    expect(
      await harness.executor.confirmReviewedSharedFolderIdentity(reviewed),
    ).toBe(true);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath).sort()).toEqual([
      ".obsidian",
      ".obsidian/plugins",
      "Notes",
    ]);
    expectNoFileMutations(harness.mutations);

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      deferred: 0,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps reviewed shared-folder identity state-only and rejects changed facts", async () => {
    const { harness, reviewed } = await prepareUnanchoredSharedFolderHarness();
    const remote = findRemoteItemByPath(
      harness.remoteItemState,
      ".obsidian/plugins",
    )!;
    remote.eTag = "changed-after-review";

    expect(
      await harness.executor.confirmReviewedSharedFolderIdentity(reviewed),
    ).toBe(false);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath)).toEqual(["Notes"]);
    expectNoFileMutations(harness.mutations);
  });

  it("names a case-only folder-name difference instead of offering the review", async () => {
    // 规划器按身份（忽略大小写）认定同名对，所以只差大小写的本机/云端文件夹
    // 会稳定产出 unanchored-shared-folder 待处理行；人工确认却要求两侧路径
    // 逐字节相等 → 该出口在这种形态下永远打不开。行为契约：入口必须说出真正
    // 的原因（改名即可解），不再笼统报"状态已变化"。
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    harness.localFolderPaths.add("archive");
    harness.remoteItemState.push(...remoteFolderTree(["Archive"]));

    const deferred = await harness.executor.run("manual");
    expect(deferred).toMatchObject({
      success: true,
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({
        path: "archive",
        issueCode: "unanchored-shared-folder",
      }),
    ]);

    expect(
      await harness.executor.getSharedFolderIdentityResolutionSnapshot("archive"),
    ).toEqual({
      snapshot: null,
      reason: "name-mismatch",
      nameMismatchPath: "archive",
    });
    expectNoFileMutations(harness.mutations);
  });

  it("reports the running sync instead of changed facts while a round is in flight", async () => {
    const { harness } = await prepareUnanchoredSharedFolderHarness();

    const round = harness.executor.run("manual");
    const entry =
      await harness.executor.getSharedFolderIdentityResolutionSnapshot(
        ".obsidian/plugins",
      );
    expect(entry).toEqual({ snapshot: null, reason: "round-running" });
    await round;
  });

  it("retires an explicitly reviewed file replacement lineage without changing either side", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localEntryState[0]!.path = "Notes/moved.md";
    const oldRemoteIndex = harness.remoteItemState.findIndex(
      (item) => item.id === "file-a",
    );
    harness.remoteItemState.splice(oldRemoteIndex, 1, {
      id: "file-replacement",
      name: "a.md",
      size: 8,
      file: { hashes: { sha256Hash: hashB } },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-08-07T00:00:00.000Z",
      eTag: "etag-replacement",
      cTag: "ctag-replacement",
    });

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      deferred: 1,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({
        path: "Notes/a.md",
        issueCode: "identity-replacement-ambiguous",
      }),
    ]);
    const reviewed = readySnapshot(
      await harness.executor.getStaleIdentityResolutionSnapshot(
        "Notes/a.md",
      ),
    );
    expect(reviewed).toMatchObject({
      kind: "file-replacement",
      relatedPaths: ["Notes/moved.md"],
      primaryRemote: { remoteId: "file-a", status: "missing" },
    });

    expect(await harness.executor.retireReviewedStaleIdentity(reviewed!)).toBe(true);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.getCommittedV2Envelope()!.anchors.byAnchorId).toEqual({});
    expect(harness.localEntryState.map((entry) => entry.path)).toEqual([
      "Notes/moved.md",
    ]);
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")?.id)
      .toBe("file-replacement");
    expectNoFileMutations(harness.mutations);
  });

  it("rejects stale identity retirement when Graph facts change after review", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localEntryState[0]!.path = "Notes/moved.md";
    const oldRemoteIndex = harness.remoteItemState.findIndex(
      (item) => item.id === "file-a",
    );
    harness.remoteItemState.splice(oldRemoteIndex, 1, {
      id: "file-replacement",
      name: "a.md",
      size: 8,
      file: { hashes: { sha256Hash: hashB } },
      parentReference: { id: "folder-notes" },
      eTag: "etag-replacement",
      cTag: "ctag-replacement",
    });
    expect((await harness.executor.run("manual")).deferred).toBe(1);
    const reviewed = readySnapshot(
      await harness.executor.getStaleIdentityResolutionSnapshot(
        "Notes/a.md",
      ),
    );
    expect(reviewed).not.toBeNull();
    harness.remoteItemState.find((item) => item.id === "file-replacement")!.eTag =
      "etag-changed-after-review";

    expect(await harness.executor.retireReviewedStaleIdentity(reviewed!)).toBe(false);
    expect(harness.state.pendingIssues).toHaveLength(1);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
    )).toEqual([
      expect.objectContaining({ remoteId: "file-a", lastPath: "Notes/a.md" }),
    ]);
    expectNoFileMutations(harness.mutations);
  });

  it("retires an explicitly reviewed missing remote folder lineage without changing either side", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    expect(await harness.state.recordLocalFolderMoveHint(
      "Notes",
      "Archive",
    )).toBe(true);
    harness.localFolderPaths.delete("Notes");
    harness.localFolderPaths.add("Archive");
    harness.localEntryState[0]!.path = "Archive/a.md";
    harness.remoteItemState.splice(0, harness.remoteItemState.length);

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      deferred: 2,
      errors: 0,
    });
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({
        path: "Notes",
        issueCode: "anchored-folder-missing-remote",
      }),
      expect.objectContaining({
        path: "Notes/a.md",
        issueCode: "identity-replacement-ambiguous",
      }),
    ]);
    const reviewed = readySnapshot(
      await harness.executor.getStaleIdentityResolutionSnapshot(
        "Notes",
      ),
    );
    expect(reviewed).toMatchObject({
      kind: "folder-missing-remote",
      relatedPaths: ["Archive"],
      primaryRemote: { remoteId: "folder-notes", status: "missing" },
      fileAnchors: [{ remoteId: "file-a" }],
      folderAnchors: [{ remoteId: "folder-notes" }],
    });

    expect(await harness.executor.retireReviewedStaleIdentity(reviewed!)).toBe(true);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.getCommittedV2Envelope()!.anchors.byAnchorId).toEqual({});
    expect(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).toEqual({});
    expect(harness.state.localFolderMoveHints).toEqual([]);
    expect(harness.localFolderPaths.has("Archive")).toBe(true);
    expect(harness.localEntryState.map((entry) => entry.path)).toEqual([
      "Archive/a.md",
    ]);
    expect(harness.remoteItemState).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("binds one explicitly selected empty rename through the existing move hint", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness();

    expect(await harness.executor.bindReviewedEmptyFolderRename(
      reviewed,
      "Archive",
    )).toBe(true);
    expect(harness.state.localFolderMoveHints).toEqual([
      expect.objectContaining({
        remoteId: "folder-notes",
        fromPath: "Notes",
        toPath: "Archive",
      }),
    ]);

    const moved = await harness.executor.run("manual");
    expect(moved).toMatchObject({
      foldersMoved: 1,
      deferred: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive")?.id)
      .toBe("folder-notes");
    expect(harness.state.localFolderMoveHints).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect((await harness.executor.run("manual"))).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
  });

  it("deletes only the explicitly reviewed remote empty identity and settles", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness();

    await harness.executor.deleteReviewedEmptyRemoteFolder(reviewed);

    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.mutations.deleteItem).toHaveBeenCalledWith(
      "testVault",
      "Notes",
      "ctag-folder-notes",
      "folder-notes",
    );
    expect((await harness.executor.run("manual"))).toMatchObject({
      foldersCreated: 1,
      deferred: 0,
      errors: 0,
    });
    expect((await harness.executor.run("manual"))).toMatchObject({
      foldersCreated: 0,
      foldersMoved: 0,
      foldersDeleted: 0,
      deferred: 0,
      errors: 0,
    });
  });

  it("records the reviewed empty-folder delete in the device-local deletion ledger", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness();

    await harness.executor.deleteReviewedEmptyRemoteFolder(reviewed);

    // 删除记录簿（文件版本找回刀一之二）：文件夹级删除按远端 id 记一条，
    // 并随设备本地记录族落进 data.json。
    expect(harness.state.deletionLedgerEntries).toEqual([
      {
        remoteId: "folder-notes",
        path: "Notes",
        deletedAt: expect.any(Number),
        kind: "folder",
      },
    ]);
    expect(harness.pluginData["easy-sync-deletion-ledger"]).toEqual({
      schemaVersion: 1,
      kind: "easy-sync-deletion-ledger",
      entries: harness.state.deletionLedgerEntries,
    });
  });

  it("expires an empty-folder choice when local candidates or remote versions change", async () => {
    const localChanged = await prepareAmbiguousEmptyFolderHarness();
    localChanged.harness.localFolderPaths.add("Archive/Child");

    await localChanged.harness.executor.restoreReviewedEmptyFolder(
      localChanged.reviewed,
    );
    expect(localChanged.harness.localFolderPaths.has("Notes")).toBe(false);
    expect(localChanged.harness.state.localFolderMoveHints).toEqual([]);
    expect(localChanged.harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(localChanged.harness.state.mutationLedger).toEqual([]);

    const remoteChanged = await prepareAmbiguousEmptyFolderHarness();
    const remote = remoteChanged.harness.remoteItemState.find(
      (item) => item.id === "folder-notes",
    )!;
    remote.eTag = "etag-folder-notes-new";
    await remoteChanged.harness.executor.deleteReviewedEmptyRemoteFolder(
      remoteChanged.reviewed,
    );
    expect(findRemoteItemByPath(remoteChanged.harness.remoteItemState, "Notes"))
      .not.toBeNull();
    expect(remoteChanged.harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(remoteChanged.harness.state.mutationLedger).toEqual([]);
  });

  it("keeps a reviewed delete mutation-free when a child arrives after the empty listing", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness();
    let inserted = false;
    vi.mocked(harness.client.listFolderChildrenById).mockImplementation(
      async (driveItemId: string) => {
        const children = harness.remoteItemState.filter(
          (item) => item.parentReference?.id === driveItemId,
        );
        if (!inserted && driveItemId === "folder-notes") {
          inserted = true;
          const folder = harness.remoteItemState.find(
            (item) => item.id === "folder-notes",
          )!;
          folder.cTag = "ctag-folder-notes-with-child";
          harness.remoteItemState.push({
            id: "late-child",
            name: "late.md",
            file: { hashes: { sha256Hash: "a".repeat(64) } },
            size: 1,
            parentReference: { id: "folder-notes" },
            eTag: "etag-late-child",
            cTag: "ctag-late-child",
          });
        }
        return children;
      },
    );

    await harness.executor.deleteReviewedEmptyRemoteFolder(reviewed);

    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")?.folder)
      .toBeTruthy();
    expect(harness.remoteItemState.some((item) => item.id === "late-child"))
      .toBe(true);
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("deletes one reviewed empty folder by verified identity when no content tag exists", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness({
      contentTag: null,
    });
    expect(reviewed.remoteCTag).toBeUndefined();

    await harness.executor.deleteReviewedEmptyRemoteFolder(reviewed);

    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")).toBeNull();
    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.mutations.deleteItem).toHaveBeenCalledWith(
      "testVault",
      "Notes",
      "etag-folder-notes",
      "folder-notes",
    );
  });

  it("reads one exact subtree snapshot for nested missing-local folder issues", async () => {
    const paths = ["Issues", "Issues/CAD"];
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: paths.map((path) => ({ path })),
      remoteItems: remoteFolderTree(paths),
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    harness.localFolderPaths.clear();
    harness.localFolderPaths.add("Archive");
    const deferred = await harness.executor.run("manual");
    expect(deferred.deferred).toBe(2);
    expect(harness.state.pendingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "Issues",
        issueCode: "anchored-folder-missing-local",
      }),
      expect.objectContaining({
        path: "Issues/CAD",
        issueCode: "anchored-folder-missing-local",
      }),
    ]));

    const fromRoot = await harness.executor
      .getFolderSubtreeReviewSnapshot("Issues");
    const fromChild = await harness.executor
      .getFolderSubtreeReviewSnapshot("Issues/CAD");
    expect(fromRoot).toMatchObject({
      path: "Issues",
      issuePaths: ["Issues", "Issues/CAD"],
      members: [
        { path: "Issues", kind: "folder" },
        { path: "Issues/CAD", kind: "folder" },
      ],
    });
    expect(fromChild).toEqual(fromRoot);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("restores one reviewed cloud subtree through the ordinary V2 mutation chain", async () => {
    const { harness, reviewed, filePath, content, hash } =
      await prepareReviewedFolderSubtreeHarness();
    expect(reviewed).toMatchObject({
      path: "Issues",
      members: [
        { path: "Issues", kind: "folder" },
        { path: "Issues/CAD", kind: "folder" },
        { path: filePath, kind: "file", contentHash: hash },
      ],
    });

    expect(await harness.executor.restoreReviewedFolderSubtree(reviewed!))
      .toBe(true);
    expectNoFileMutations(harness.mutations);
    expect(harness.localFolderPaths.has("Issues")).toBe(false);
    expect(harness.state.pendingIssues).toEqual([]);

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      foldersCreated: 3,
      downloaded: 1,
      deferred: 0,
      errors: 0,
    });
    expect(harness.localFolderPaths.has("Issues")).toBe(true);
    expect(harness.localFolderPaths.has("Issues/CAD")).toBe(true);
    expect(harness.scanner.vault.createFolder).toHaveBeenCalledTimes(2);
    expect(harness.client.createFolderByParentId).toHaveBeenCalledTimes(1);
    expect(harness.files.get(filePath)).toBe(content);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
    ).map((anchor) => anchor.lastPath).sort()).toEqual([
      ".obsidian",
      ".obsidian/plugins",
      ".obsidian/plugins/easy-sync",
      "Archive",
      "Issues",
      "Issues/CAD",
    ]);
    harness.mutations.downloadFile.mockClear();
    harness.scanner.vault.createFolder.mockClear();
    harness.client.createFolderByParentId.mockClear();
    expect(await harness.executor.run("manual")).toMatchObject({
      downloaded: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.scanner.vault.createFolder).not.toHaveBeenCalled();
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
  });

  it("keeps a reviewed cloud subtree unchanged when any remote member drifts", async () => {
    const { harness, reviewed } = await prepareReviewedFolderSubtreeHarness();
    const cad = findRemoteItemByPath(harness.remoteItemState, "Issues/CAD")!;
    harness.remoteItemState.push({
      id: "late-file",
      name: "late.md",
      file: { hashes: { sha256Hash: "c".repeat(64) } },
      size: 1,
      parentReference: { id: cad.id },
      eTag: "etag-late-file",
      cTag: "ctag-late-file",
    });
    const before = harness.state.getCommittedV2Envelope()!.meta.commitSeq;

    expect(await harness.executor.restoreReviewedFolderSubtree(reviewed))
      .toBe(false);
    expect(harness.state.getCommittedV2Envelope()!.meta.commitSeq).toBe(before);
    expect(harness.state.pendingIssues).not.toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("deletes one reviewed cloud subtree with the exact root cTag and converges", async () => {
    const { harness, reviewed } = await prepareReviewedFolderSubtreeHarness();
    const root = reviewed.members[0];
    expect(root).toMatchObject({
      path: "Issues",
      kind: "folder",
      remoteCTag: expect.any(String),
    });
    const deleted = await harness.executor.deleteReviewedFolderSubtree(reviewed);
    expect({
      deleted,
      deleteCalls: harness.mutations.deleteItem.mock.calls.length,
      ledger: harness.state.mutationLedger,
      pendingIssues: harness.state.pendingIssues,
      remoteRoot: findRemoteItemByPath(harness.remoteItemState, "Issues"),
    }).toMatchObject({
      deleted: true,
      deleteCalls: 1,
      ledger: [],
      pendingIssues: [],
      remoteRoot: null,
    });
    expect(harness.mutations.deleteItem).toHaveBeenCalledTimes(1);
    expect(harness.mutations.deleteItem).toHaveBeenCalledWith(
      "testVault",
      "Issues",
      root.remoteCTag,
      root.remoteId,
    );
    expect(findRemoteItemByPath(harness.remoteItemState, "Issues")).toBeNull();
    expect(findRemoteItemByPath(
      harness.remoteItemState,
      "Issues/CAD/drawing.md",
    )).toBeNull();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    const envelope = harness.state.getCommittedV2Envelope()!;
    expect(envelope.remoteIndex.itemsById[root.remoteId]).toBeUndefined();
    // 删除记录簿：整棵树只记根一条（回收站里它们本来就是同一个 item），成员不各记。
    expect(harness.state.deletionLedgerEntries).toEqual([
      {
        remoteId: root.remoteId,
        path: "Issues",
        deletedAt: expect.any(Number),
        kind: "folder",
      },
    ]);

    harness.mutations.deleteItem.mockClear();
    expect(await harness.executor.run("manual")).toMatchObject({
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
  });

  it("keeps a reviewed cloud subtree when its root content tag drifts", async () => {
    const { harness, reviewed } = await prepareReviewedFolderSubtreeHarness();
    const root = findRemoteItemByPath(harness.remoteItemState, "Issues")!;
    root.cTag = `${root.cTag}-changed`;
    const before = harness.state.getCommittedV2Envelope()!.meta.commitSeq;

    expect(await harness.executor.deleteReviewedFolderSubtree(reviewed))
      .toBe(false);
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.getCommittedV2Envelope()!.meta.commitSeq).toBe(before);
    expect(harness.state.pendingIssues).not.toEqual([]);
  });

  it("settles a reviewed cloud subtree delete after the response is lost", async () => {
    const { harness, reviewed } = await prepareReviewedFolderSubtreeHarness();
    harness.loseFolderDeleteResponseOnce();

    expect(await harness.executor.deleteReviewedFolderSubtree(reviewed))
      .toBe(true);
    expect(harness.mutations.deleteItem).toHaveBeenCalledTimes(1);
    expect(findRemoteItemByPath(harness.remoteItemState, "Issues")).toBeNull();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);

    const reopened = harness.state.getCommittedV2Envelope()!;
    expect(Object.values(reopened.remoteIndex.itemsById).some(
      (item) => item.parentId === reviewed.members[0].remoteId,
    )).toBe(false);
  });

  it("deletes one reviewed cloud subtree by member identity when folders carry no content tag", async () => {
    const { harness, reviewed } = await prepareReviewedFolderSubtreeHarness({
      folderContentTags: false,
    });
    const root = reviewed.members[0];
    expect(root).toMatchObject({
      path: "Issues",
      kind: "folder",
      remoteETag: expect.any(String),
    });
    expect(root.remoteCTag).toBeUndefined();

    expect(await harness.executor.deleteReviewedFolderSubtree(reviewed))
      .toBe(true);
    expect(harness.mutations.deleteItem).toHaveBeenCalledTimes(1);
    expect(harness.mutations.deleteItem).toHaveBeenCalledWith(
      "testVault",
      "Issues",
      root.remoteETag,
      root.remoteId,
    );
    expect(findRemoteItemByPath(harness.remoteItemState, "Issues")).toBeNull();
    expect(findRemoteItemByPath(
      harness.remoteItemState,
      "Issues/CAD/drawing.md",
    )).toBeNull();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
  });

  it("keeps a content-tag-free reviewed subtree when a member drifts", async () => {
    const { harness, reviewed } = await prepareReviewedFolderSubtreeHarness({
      folderContentTags: false,
    });
    const drawing = findRemoteItemByPath(
      harness.remoteItemState,
      "Issues/CAD/drawing.md",
    )!;
    drawing.size = (drawing.size ?? 0) + 7;

    expect(await harness.executor.deleteReviewedFolderSubtree(reviewed))
      .toBe(false);
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("settles a content-tag-free reviewed subtree delete after the response is lost", async () => {
    const { harness, reviewed } = await prepareReviewedFolderSubtreeHarness({
      folderContentTags: false,
    });
    harness.loseFolderDeleteResponseOnce();

    expect(await harness.executor.deleteReviewedFolderSubtree(reviewed))
      .toBe(true);
    expect(harness.mutations.deleteItem).toHaveBeenCalledTimes(1);
    expect(findRemoteItemByPath(harness.remoteItemState, "Issues")).toBeNull();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
  });

  it("continues a reviewed cloud subtree restore after a cold reopen", async () => {
    const { harness, reviewed, filePath, content } =
      await prepareReviewedFolderSubtreeHarness();
    expect(await harness.executor.restoreReviewedFolderSubtree(reviewed))
      .toBe(true);
    await harness.state.close();

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
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
    expect(await restartedExecutor.run("manual")).toMatchObject({
      success: true,
      downloaded: 1,
      deferred: 0,
      errors: 0,
    });
    expect(harness.files.get(filePath)).toBe(content);
    harness.mutations.downloadFile.mockClear();
    expect(await restartedExecutor.run("manual")).toMatchObject({
      downloaded: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    await restartedState.close();
  });

  it("recovers reviewed empty-folder create and delete response loss without repetition", async () => {
    const restoring = await prepareAmbiguousEmptyFolderHarness();
    restoring.harness.loseLocalFolderCreateResponseOnce();
    await restoring.harness.executor.restoreReviewedEmptyFolder(restoring.reviewed);
    expect(restoring.harness.localFolderPaths.has("Notes")).toBe(true);
    expect(restoring.harness.scanner.vault.createFolder).toHaveBeenCalledOnce();
    expect(restoring.harness.state.mutationLedger).toEqual([]);

    const deleting = await prepareAmbiguousEmptyFolderHarness();
    deleting.harness.loseFolderDeleteResponseOnce();
    await deleting.harness.executor.deleteReviewedEmptyRemoteFolder(deleting.reviewed);
    expect(findRemoteItemByPath(deleting.harness.remoteItemState, "Notes"))
      .toBeNull();
    expect(deleting.harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(deleting.harness.state.mutationLedger).toEqual([]);
  });

  it("abandons a reviewed empty-folder delete when Graph rejects the exact version", async () => {
    const { harness, reviewed } = await prepareAmbiguousEmptyFolderHarness();
    harness.conflictFolderDeleteOnce();

    await harness.executor.deleteReviewedEmptyRemoteFolder(reviewed);

    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")).not.toBeNull();
    expect(harness.mutations.deleteItem).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([
      expect.objectContaining({
        path: "Notes",
        issueCode: "anchored-folder-missing-local",
      }),
    ]);
  });

  it("uses the adapter only for a hidden config-directory create", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: ".obsidian" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "config-folder",
          name: ".obsidian",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-config",
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

    harness.remoteItemState.push({
      id: "snippets-folder",
      name: "snippets",
      folder: {},
      parentReference: { id: "config-folder" },
      eTag: "etag-snippets",
    });
    const created = await harness.executor.run("manual");

    expect(created).toMatchObject({ success: true, foldersCreated: 1 });
    expect(harness.rawAdapter.mkdir).toHaveBeenCalledWith(".obsidian/snippets");
    expect(
      (harness.scanner.vault as unknown as { createFolder: ReturnType<typeof vi.fn> })
        .createFolder,
    ).not.toHaveBeenCalledWith(".obsidian/snippets");
  });

  it("moves a non-empty local folder remotely by identity and converges without file churn", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive")).toBe(true);

    const moved = await harness.executor.run("manual");

    expect(harness.state.pendingIssues).toEqual([]);
    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
      deferred: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive")?.id)
      .toBe("folder-notes");
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/a.md")?.id)
      .toBe("file-a");
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);

    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
  });

  it("lets one reviewed root-location choice settle a two-sided folder move", async () => {
    for (const choice of ["keep-local", "keep-remote"] as const) {
      const harness = makeHarness();
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);

      await (harness.scanner.vault as unknown as {
        rename: (file: TFolder, target: string) => Promise<void>;
      }).rename(new TFolder("Notes"), "Archive");
      expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive"))
        .toBe(true);
      const remoteFolder = findRemoteItemByPath(harness.remoteItemState, "Notes")!;
      remoteFolder.name = "Cloud";
      remoteFolder.eTag = `etag-folder-cloud-${choice}`;

      const blocked = await harness.executor.run("manual");
      expect(blocked).toMatchObject({
        success: true,
        foldersMoved: 0,
        deferred: 1,
      });
      expect(harness.state.pendingIssues).toEqual([
        expect.objectContaining({
          path: "Notes",
          issueCode: "folder-location-choice",
        }),
      ]);

      const reviewed = await (harness.executor as unknown as {
        getFolderLocationResolutionSnapshot: (path: string) => Promise<{
          revision: string;
          localPath: string;
          remotePath: string;
        } | null>;
        resolveReviewedFolderLocation: (
          reviewed: { revision: string; localPath: string; remotePath: string },
          choice: "keep-local" | "keep-remote",
        ) => Promise<boolean>;
      }).getFolderLocationResolutionSnapshot("Notes");
      expect(reviewed).toMatchObject({
        localPath: "Archive",
        remotePath: "Cloud",
      });
      const resolved = await (harness.executor as unknown as {
        resolveReviewedFolderLocation: (
          reviewed: NonNullable<typeof reviewed>,
          choice: "keep-local" | "keep-remote",
        ) => Promise<boolean>;
      }).resolveReviewedFolderLocation(reviewed!, choice);
      expect(resolved).toBe(true);

      const finalPath = choice === "keep-local" ? "Archive" : "Cloud";
      expect(findRemoteItemByPath(harness.remoteItemState, finalPath)?.id)
        .toBe("folder-notes");
      expect(harness.localFolderPaths.has(finalPath)).toBe(true);
      expect(harness.state.localFolderMoveHints).toEqual([]);
      expect(harness.state.mutationLedger).toEqual([]);
      expect(harness.state.pendingIssues).toEqual([]);
      expect(await harness.executor.run("manual")).toMatchObject({
        foldersMoved: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferred: 0,
        errors: 0,
      });
    }
  });

  it("re-applies a reviewed folder location choice on latest facts when the revision advanced during review", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive"))
      .toBe(true);
    const remoteFolder = findRemoteItemByPath(harness.remoteItemState, "Notes")!;
    remoteFolder.name = "Cloud";
    remoteFolder.eTag = "etag-folder-cloud-review-race";
    await harness.executor.run("manual");
    const internal = harness.executor as unknown as {
      getFolderLocationResolutionSnapshot: (path: string) => Promise<{
        revision: string;
        localPath: string;
        remotePath: string;
      } | null>;
      resolveReviewedFolderLocation: (
        reviewed: { revision: string; localPath: string; remotePath: string },
        choice: "keep-local",
      ) => Promise<boolean>;
    };
    const reviewed = await internal.getFolderLocationResolutionSnapshot("Notes");
    expect(reviewed).not.toBeNull();
    // Simulate the dialog-lived state advancing: the reviewed revision now
    // differs from the freshly built snapshot while the two-sided shape still
    // holds. The resolver rebuilds on the latest facts instead of answering
    // with the old "sync again" dead end (one-shot automatic rebuild).
    reviewed!.revision += "-stale-during-review";

    expect(await internal.resolveReviewedFolderLocation(reviewed!, "keep-local"))
      .toBe(true);
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive")?.id)
      .toBe("folder-notes");
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
  });

  it("does not apply an expired two-sided folder location choice", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive"))
      .toBe(true);
    const remoteFolder = findRemoteItemByPath(harness.remoteItemState, "Notes")!;
    remoteFolder.name = "Cloud";
    remoteFolder.eTag = "etag-folder-cloud-reviewed";
    await harness.executor.run("manual");
    const internal = harness.executor as unknown as {
      getFolderLocationResolutionSnapshot: (path: string) => Promise<{
        revision: string;
        localPath: string;
        remotePath: string;
      } | null>;
      resolveReviewedFolderLocation: (
        reviewed: { revision: string; localPath: string; remotePath: string },
        choice: "keep-local",
      ) => Promise<boolean>;
    };
    const reviewed = await internal.getFolderLocationResolutionSnapshot("Notes");
    expect(reviewed).not.toBeNull();
    remoteFolder.eTag = "etag-folder-cloud-changed-after-review";

    expect(await internal.resolveReviewedFolderLocation(reviewed!, "keep-local"))
      .toBe(false);
    expect(harness.mutations.moveItemById).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toHaveLength(1);
  });

  it("commits an exact local folder move before acting on a changed carried file", async () => {
    const harness = makeHarness();
    const changedContent = "changed while moving the containing folder";
    const changedBytes = new TextEncoder().encode(changedContent);
    const changedHash = await sha256Hex(changedBytes);
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    harness.files.set("Archive/a.md", changedContent);
    harness.localEntryState[0]!.hash = changedHash;
    harness.localEntryState[0]!.size = changedBytes.byteLength;
    harness.localEntryState[0]!.mtime++;
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive")).toBe(true);
    harness.mutations.uploadFile.mockImplementationOnce(async () =>
      applyRemoteUpload(
        harness.remoteItemState,
        "Archive/a.md",
        changedBytes.byteLength,
        changedHash,
        "etag-carried-file-uploaded",
      ));

    const moved = await harness.executor.run("manual");
    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      filesMoved: 0,
      uploaded: 1,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledTimes(1);
    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    expect(
      harness.mutations.moveItemById.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.mutations.uploadFile.mock.invocationCallOrder[0]!);
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive")?.id)
      .toBe("folder-notes");
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/a.md")?.file?.hashes)
      .toMatchObject({ sha256Hash: changedHash });
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(harness.state.pendingConflicts).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(Object.values(
      harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
    )).toContainEqual(expect.objectContaining({
      remoteId: "file-a",
      lastPath: "Archive/a.md",
      contentHash: changedHash,
    }));
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
  });

  it("commits an exact local folder move before uploading a new carried file", async () => {
    const harness = makeHarness();
    const newContent = "created while moving the containing folder";
    const newBytes = new TextEncoder().encode(newContent);
    const newHash = await sha256Hex(newBytes);
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    harness.files.set("Archive/new.md", newContent);
    harness.localEntryState.push({
      path: "Archive/new.md",
      size: newBytes.byteLength,
      mtime: 2,
      hash: newHash,
      binary: false,
    });
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive")).toBe(true);
    harness.mutations.uploadFile.mockImplementationOnce(async () => {
      const uploaded: DriveItem = {
        id: "file-new-carried",
        name: "new.md",
        size: newBytes.byteLength,
        file: { hashes: { sha256Hash: newHash } },
        parentReference: { id: "folder-notes" },
        eTag: "etag-new-carried-file-uploaded",
        cTag: "ctag-new-carried-file-uploaded",
      };
      harness.remoteItemState.push(uploaded);
      return uploaded;
    });

    const moved = await harness.executor.run("manual");
    expect(harness.diag.error).not.toHaveBeenCalled();
    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: 1,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledTimes(1);
    expect(harness.mutations.uploadFile).toHaveBeenCalledTimes(1);
    expect(
      harness.mutations.moveItemById.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.mutations.uploadFile.mock.invocationCallOrder[0]!);
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive")?.id)
      .toBe("folder-notes");
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/new.md")?.file?.hashes)
      .toMatchObject({ sha256Hash: newHash });
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
  });

  it("commits an exact remote folder move before downloading a changed carried file", async () => {
    const localContent = "0123456789";
    const localBytes = new TextEncoder().encode(localContent);
    const localHash = await sha256Hex(localBytes);
    const localEntry: LocalFileEntry = {
      ...localA,
      size: localBytes.byteLength,
      hash: localHash,
    };
    const harness = makeHarness({
      base: [{
        path: localEntry.path,
        size: localEntry.size,
        hash: localEntry.hash,
        eTag: "etag-a",
      }],
      local: [localEntry],
      remoteHash: localHash,
      initialFiles: { [localEntry.path]: localContent },
    });
    const remoteContent = "changed while moving the containing cloud folder";
    const remoteBytes = new TextEncoder().encode(remoteContent);
    const remoteHash = await sha256Hex(remoteBytes);
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    const remoteFolder = findRemoteItemByPath(harness.remoteItemState, "Notes")!;
    remoteFolder.name = "Archive";
    remoteFolder.eTag = "etag-folder-notes-moved-remotely";
    applyRemoteUpload(
      harness.remoteItemState,
      "Archive/a.md",
      remoteBytes.byteLength,
      remoteHash,
      "etag-carried-file-changed-remotely",
    );
    harness.mutations.downloadFile.mockResolvedValue(remoteBytes.buffer);

    const moved = await harness.executor.run("manual");

    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.scanner.vault.rename).toHaveBeenCalledOnce();
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(harness.localFolderPaths.has("Notes")).toBe(false);
    expect(harness.localFolderPaths.has("Archive")).toBe(true);
    expect(harness.files.get("Archive/a.md")).toBe(remoteContent);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    });
  });

  it("cold-starts from a committed folder move when bounded continuation was incomplete", async () => {
    const harness = makeHarness();
    const changedContent = "changed before the bounded scan became incomplete";
    const changedBytes = new TextEncoder().encode(changedContent);
    const changedHash = await sha256Hex(changedBytes);
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    harness.files.set("Archive/a.md", changedContent);
    harness.localEntryState[0]!.hash = changedHash;
    harness.localEntryState[0]!.size = changedBytes.byteLength;
    harness.localEntryState[0]!.mtime++;
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive")).toBe(true);
    harness.mutations.uploadFile.mockImplementationOnce(async () =>
      applyRemoteUpload(
        harness.remoteItemState,
        "Archive/a.md",
        changedBytes.byteLength,
        changedHash,
        "etag-upload-after-cold-restart",
      ));
    const scanAll = vi.mocked(harness.scanner.scanAll);
    const completeScan = scanAll.getMockImplementation()!;
    scanAll.mockImplementation(async () => {
      const scan = await completeScan();
      return harness.mutations.moveItemById.mock.calls.length === 1
        ? { ...scan, complete: false, failedPaths: ["Archive/a.md"] }
        : scan;
    });

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();

    scanAll.mockImplementation(completeScan);
    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
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
    expect(await restartedExecutor.run("manual")).toMatchObject({
      success: true,
      foldersMoved: 0,
      uploaded: 1,
      deferred: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/a.md")?.file?.hashes)
      .toMatchObject({ sha256Hash: changedHash });
    expect(await restartedExecutor.run("manual")).toMatchObject({
      foldersMoved: 0,
      uploaded: 0,
      deferred: 0,
      errors: 0,
    });
    await restartedState.close();
  });

  it("reclassifies a remote edit observed after the folder checkpoint", async () => {
    const { harness, afterMove } =
      await prepareMovedFolderContinuationHarness();
    const remoteContent = "remote edit observed after the folder moved";
    const remoteBytes = new TextEncoder().encode(remoteContent);
    const remoteHash = await sha256Hex(remoteBytes);
    afterMove(() => {
      applyRemoteUpload(
        harness.remoteItemState,
        "Archive/a.md",
        remoteBytes.byteLength,
        remoteHash,
        "etag-remote-edit-after-folder-move",
      );
    });
    harness.mutations.downloadFile.mockResolvedValue(remoteBytes.buffer);

    expect(await harness.executor.run("manual")).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: 0,
      downloaded: 1,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(harness.files.get("Archive/a.md")).toBe(remoteContent);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      errors: 0,
    });
  });

  it.each([
    "local-new",
    "remote-new",
    "local-delete",
    "remote-delete",
    "both-edit",
  ] as const)("routes %s after the folder checkpoint through ordinary file semantics", async (scenario) => {
    const { harness, afterMove } =
      await prepareMovedFolderContinuationHarness();
    const changedContent = `${scenario}-content`;
    const changedBytes = new TextEncoder().encode(changedContent);
    const changedHash = await sha256Hex(changedBytes);
    const remoteConflictBytes = new TextEncoder().encode(
      `remote-${changedContent}`,
    );
    const remoteConflictHash = await sha256Hex(remoteConflictBytes);
    afterMove(() => {
      if (scenario === "local-new") {
        harness.files.set("Archive/new.md", changedContent);
        harness.localEntryState.push({
          path: "Archive/new.md",
          size: changedBytes.byteLength,
          mtime: 2,
          hash: changedHash,
          binary: false,
        });
      } else if (scenario === "remote-new") {
        harness.remoteItemState.push({
          id: "file-new",
          name: "new.md",
          size: changedBytes.byteLength,
          file: { hashes: { sha256Hash: changedHash } },
          parentReference: { id: "folder-notes" },
          eTag: "etag-remote-new-after-folder-move",
          cTag: "ctag-remote-new-after-folder-move",
        });
      } else if (scenario === "local-delete") {
        harness.localEntryState.splice(0, 1);
        harness.files.delete("Archive/a.md");
      } else if (scenario === "remote-delete") {
        const index = harness.remoteItemState.findIndex(
          (item) => item.id === "file-a",
        );
        harness.remoteItemState.splice(index, 1, {
          id: "file-a",
          name: "a.md",
          parentReference: { id: "folder-notes" },
          deleted: { state: "deleted" },
        });
      } else {
        harness.files.set("Archive/a.md", changedContent);
        Object.assign(harness.localEntryState[0]!, {
          size: changedBytes.byteLength,
          mtime: 2,
          hash: changedHash,
        });
        applyRemoteUpload(
          harness.remoteItemState,
          "Archive/a.md",
          remoteConflictBytes.byteLength,
          remoteConflictHash,
          "etag-remote-conflict-after-folder-move",
        );
      }
    });
    harness.mutations.downloadFile.mockResolvedValue(
      scenario === "both-edit"
        ? remoteConflictBytes.buffer
        : changedBytes.buffer,
    );
    if (scenario === "local-new") {
      harness.mutations.uploadFile.mockImplementationOnce(async () => {
        const remote: DriveItem = {
          id: "file-new",
          name: "new.md",
          size: changedBytes.byteLength,
          file: { hashes: { sha256Hash: changedHash } },
          parentReference: { id: "folder-notes" },
          eTag: "etag-local-new-after-folder-move",
          cTag: "ctag-local-new-after-folder-move",
        };
        harness.remoteItemState.push(remote);
        return remote;
      });
    }
    const result = await harness.executor.run("manual");
    expect(result).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: scenario === "local-new" ? 1 : 0,
      downloaded: scenario === "remote-new" ? 1 : 0,
      deleted: scenario === "local-delete"
        ? 1
        : 0,
      conflicts:
        scenario === "both-edit" || scenario === "remote-delete" ? 1 : 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
    if (scenario === "both-edit") {
      expect(harness.state.pendingConflicts).toEqual([
        expect.objectContaining({
          type: SyncActionType.Conflict,
          path: "Archive/a.md",
        }),
      ]);
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      return;
    }
    if (scenario === "remote-delete") {
      expect(harness.state.pendingRemoteDeletes).toEqual([
        expect.objectContaining({
          type: SyncActionType.ConfirmLocalDelete,
          path: "Archive/a.md",
        }),
      ]);
      expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
      return;
    }
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    });
  });

  it("renames a folder and moves unchanged anchored files into it in one recoverable plan", async () => {
    const rootFile: LocalFileEntry = {
      path: "report.md",
      size: 10,
      mtime: 1,
      hash: hashA,
      binary: false,
    };
    const harness = makeHarness({
      base: [{
        path: rootFile.path,
        hash: rootFile.hash,
        size: rootFile.size,
        eTag: "etag-report",
      }],
      local: [rootFile],
      localFolders: [{ path: "text" }, { path: "text/nested" }],
      remoteItems: [
        {
          id: "folder-text",
          name: "text",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-text",
        },
        {
          id: "folder-nested",
          name: "nested",
          folder: {},
          parentReference: { id: "folder-text" },
          eTag: "etag-folder-nested",
        },
        {
          id: "file-report",
          name: "report.md",
          size: rootFile.size,
          file: { hashes: { sha256Hash: rootFile.hash } },
          parentReference: { id: scope.filesRootId },
          lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
          eTag: "etag-report",
          cTag: "ctag-report",
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

    harness.localEntryState[0].path = "text/nested/report.md";
    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("text"), "text-renamed");
    expect(await harness.state.recordLocalFolderMoveHint("text", "text-renamed"))
      .toBe(true);
    await harness.state.reconcilePendingIssues([{
      path: "text",
      actionType: SyncActionType.FolderDeferred,
      reason: "folder move deferred before the combined plan was available",
      updatedAt: 1,
      consecutiveFailures: 3,
    }], []);
    await harness.state.addPendingConflict({
      type: SyncActionType.Conflict,
      path: "report.md",
      reason: "reason.renameIdentityAmbiguous",
    });

    const moved = await harness.executor.run("manual");

    expect(harness.state.pendingIssues).toEqual([]);
    expect(harness.state.pendingConflicts).toEqual([]);
    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      filesMoved: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "text-renamed")?.id)
      .toBe("folder-text");
    expect(findRemoteItemByPath(
      harness.remoteItemState,
      "text-renamed/nested/report.md",
    )?.id)
      .toBe("file-report");
    expect(harness.mutations.moveItemById.mock.calls.map((call) => call[0]))
      .toEqual(["folder-text", "file-report"]);
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      filesMoved: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
  });

  it("moves one parent identity when its locally renamed subtree contains an empty folder", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Notes/Empty" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-empty",
          name: "Empty",
          folder: {},
          parentReference: { id: "folder-notes" },
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

    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive")).toBe(true);

    const moved = await harness.executor.run("manual");

    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive")?.id)
      .toBe("folder-notes");
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/Empty")?.id)
      .toBe("folder-empty");
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect((await harness.executor.run("manual")).foldersMoved).toBe(0);
  });

  it("moves a remotely renamed folder locally once and reprojects its file anchor", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);

    const folder = harness.remoteItemState.find((item) => item.id === "folder-notes")!;
    folder.name = "Archive";
    folder.eTag = "etag-folder-notes-moved";

    const moved = await harness.executor.run("manual");

    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
      deferred: 0,
    });
    expect(harness.localFolderPaths.has("Notes")).toBe(false);
    expect(harness.localFolderPaths.has("Archive")).toBe(true);
    expect(harness.localEntryState[0].path).toBe("Archive/a.md");
    expect(
      Object.values(harness.state.getCommittedV2Envelope()!.anchors.byAnchorId)[0].lastPath,
    ).toBe("Archive/a.md");
    expect((await harness.executor.run("manual")).foldersMoved).toBe(0);
  });

  it("moves a local folder across parents by stable folder and parent identities", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive/Moved");
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive/Moved"))
      .toBe(true);

    const moved = await harness.executor.run("manual");

    expect(moved).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/Moved")?.id)
      .toBe("folder-notes");
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/Moved/a.md")?.id)
      .toBe("file-a");
    expect(harness.mutations.moveItemById).toHaveBeenCalledWith(
      "folder-notes",
      "etag-folder-notes",
      "Moved",
      "folder-archive",
    );
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
  });

  it("defers a cross-parent folder move when the target parent path changes after planning", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive/Moved");
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive/Moved"))
      .toBe(true);
    (harness.client.getDriveItemMetadataById as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (driveItemId: string) => {
        const parent = harness.remoteItemState.find(
          (item) => item.id === driveItemId,
        ) ?? null;
        if (parent?.id === "folder-archive") parent.name = "ArchiveChanged";
        return parent;
      });

    const deferred = await harness.executor.run("manual");

    expect(deferred).toMatchObject({
      success: true,
      foldersMoved: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).not.toHaveBeenCalled();
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")?.id)
      .toBe("folder-notes");
  });

  it("recovers a lost folder move response without repeating the move", async () => {
    const harness = makeHarness();
    const changedContent = "changed before a lost folder move response";
    const changedBytes = new TextEncoder().encode(changedContent);
    const changedHash = await sha256Hex(changedBytes);
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    harness.files.set("Archive/a.md", changedContent);
    harness.localEntryState[0]!.hash = changedHash;
    harness.localEntryState[0]!.size = changedBytes.byteLength;
    harness.localEntryState[0]!.mtime++;
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive")).toBe(true);
    harness.loseFolderMoveResponseOnce();
    harness.mutations.uploadFile.mockImplementationOnce(async () =>
      applyRemoteUpload(
        harness.remoteItemState,
        "Archive/a.md",
        changedBytes.byteLength,
        changedHash,
        "etag-upload-after-move-recovery",
      ));

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: 1,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
    expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect(await harness.executor.run("manual")).toMatchObject({
      foldersMoved: 0,
      uploaded: 0,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
    expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
  });

  it("recovers a lost local folder-move response without moving it twice", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const remote = harness.remoteItemState.find((item) => item.id === "folder-notes")!;
    remote.name = "Archive";
    remote.eTag = "etag-folder-notes-moved";
    harness.loseLocalFolderMoveResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      foldersMoved: 1,
      errors: 0,
    });
    expect(harness.scanner.vault.rename).toHaveBeenCalledOnce();
    expect(harness.localFolderPaths.has("Notes")).toBe(false);
    expect(harness.localFolderPaths.has("Archive")).toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).foldersMoved).toBe(0);
    expect(harness.scanner.vault.rename).toHaveBeenCalledOnce();
  });

  it("defers a 412 folder move and retains its local identity hint for retry", async () => {
    const harness = makeHarness();
    const changedContent = "changed before the folder move was rejected";
    const changedBytes = new TextEncoder().encode(changedContent);
    const changedHash = await sha256Hex(changedBytes);
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    await (harness.scanner.vault as unknown as {
      rename: (file: TFolder, target: string) => Promise<void>;
    }).rename(new TFolder("Notes"), "Archive");
    harness.files.set("Archive/a.md", changedContent);
    harness.localEntryState[0]!.hash = changedHash;
    harness.localEntryState[0]!.size = changedBytes.byteLength;
    harness.localEntryState[0]!.mtime++;
    expect(await harness.state.recordLocalFolderMoveHint("Notes", "Archive")).toBe(true);
    harness.conflictFolderMoveOnce();

    const blocked = await harness.executor.run("manual");

    expect(blocked).toMatchObject({
      success: true,
      foldersMoved: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")?.id)
      .toBe("folder-notes");
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes")?.eTag)
      .toBe("etag-folder-notes-advanced");
    expect(harness.state.localFolderMoveHints).toHaveLength(1);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.moveItemById).toHaveBeenNthCalledWith(
      1,
      "folder-notes",
      "etag-folder-notes",
      "Archive",
      scope.filesRootId,
    );
    harness.mutations.uploadFile.mockImplementationOnce(async () =>
      applyRemoteUpload(
        harness.remoteItemState,
        "Archive/a.md",
        changedBytes.byteLength,
        changedHash,
        "etag-upload-after-folder-retry",
      ));

    const retried = await harness.executor.run("manual");
    expect(retried).toMatchObject({
      success: true,
      foldersMoved: 1,
      uploaded: 1,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenNthCalledWith(
      2,
      "folder-notes",
      "etag-folder-notes-advanced",
      "Archive",
      scope.filesRootId,
    );
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
  });

  it("moves a local file across folders remotely by the same drive item id", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    harness.localEntryState[0].path = "Archive/a.md";

    const moved = await harness.executor.run("manual");

    expect(moved).toMatchObject({
      success: true,
      filesMoved: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/a.md")?.id).toBe("file-a");
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
    expect((await harness.executor.run("manual")).filesMoved).toBe(0);
  });

  it("recovers a lost V2 upload response from exact remote content without uploading twice", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const changed = "changed locally";
    const changedBytes = new TextEncoder().encode(changed);
    const changedHash = await sha256Hex(changedBytes);
    harness.files.set(localA.path, changed);
    harness.localEntryState[0] = {
      ...harness.localEntryState[0],
      hash: changedHash,
      size: changedBytes.byteLength,
      mtime: 2,
    };
    harness.mutations.uploadFile.mockImplementationOnce(async () => {
      const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
      remote.size = changedBytes.byteLength;
      remote.file = { hashes: { sha256Hash: changedHash } };
      remote.eTag = "etag-upload-response-lost";
      remote.cTag = "ctag-upload-response-lost";
      throw new OneDriveError(
        OneDriveErrorType.NetworkError,
        "upload response lost",
      );
    });

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      uploaded: 1,
      errors: 0,
    });
    expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toContainEqual({
      path: localA.path,
      hash: changedHash,
      size: changedBytes.byteLength,
      eTag: "etag-upload-response-lost",
    });
    expect((await harness.executor.run("manual")).uploaded).toBe(0);
    expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
  });

  it("retires a rolled-back IndexedDB tail before recovery-only checkpoints one receipted upload", async () => {
    const indexedDbVaultInstanceId = crypto.randomUUID().replaceAll("-", "");
    const activeStores = new Map<string, StateV2IndexedDbActiveStore[]>();
    const recoveries = new Map<string, StateV2IndexedDbRecoveryStore>();
    const harness = makeHarness({
      indexedDbVaultInstanceId,
      createStateV2IndexedDbActiveStore: (databaseId, recovery) => {
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        activeStores.set(databaseId, [
          ...(activeStores.get(databaseId) ?? []),
          store,
        ]);
        recoveries.set(databaseId, recovery);
        return store;
      },
    });
    let completionFault: ReturnType<
      typeof injectActiveCommitCompletionFault
    > | null = null;
    let restartedState: StateManager | null = null;
    let coldState: StateManager | null = null;
    try {
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      const selectedDatabaseId = harness.state
        .activeV2StorageAuthorityEvidence!.databaseId!;
      const recovery = recoveries.get(selectedDatabaseId)!;
      const activeBeforeUpload = harness.state.getCommittedV2Envelope()!;

      const changed = "receipted upload awaiting IndexedDB checkpoint";
      const changedBytes = new TextEncoder().encode(changed);
      const changedHash = await sha256Hex(changedBytes);
      harness.files.set(localA.path, changed);
      harness.localEntryState[0] = {
        ...harness.localEntryState[0],
        hash: changedHash,
        size: changedBytes.byteLength,
        mtime: 2,
      };
      harness.mutations.uploadFile.mockImplementationOnce(async () => {
        const remote = findRemoteItemByPath(
          harness.remoteItemState,
          localA.path,
        )!;
        remote.size = changedBytes.byteLength;
        remote.file = { hashes: { sha256Hash: changedHash } };
        remote.eTag = "etag-receipted-indexeddb-tail";
        remote.cTag = "ctag-receipted-indexeddb-tail";
        completionFault = injectActiveCommitCompletionFault(
          "AbortError",
          { persistent: true },
        );
        return {
          ...remote,
          parentReference: { ...remote.parentReference },
        };
      });

      const interrupted = await harness.executor.run("manual");
      expect(interrupted.success).toBe(false);
      expect(completionFault?.injectionCount()).toBeGreaterThan(0);
      expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
      expect(harness.state.mutationLedger).toHaveLength(1);
      expect(harness.state.mutationLedger[0]).toMatchObject({
        intent: {
          action: "upload",
          path: localA.path,
        },
        receipt: {
          checkpoint: {
            remoteUpserts: [expect.objectContaining({
              path: localA.path,
              eTag: "etag-receipted-indexeddb-tail",
            })],
          },
        },
      });
      const retainedAfterInterruption = await activeStores
        .get(selectedDatabaseId)![0]!.load();
      const orphanSeq = retainedAfterInterruption.meta.commitSeq + 1;
      expect(retainedAfterInterruption.meta.commitSeq)
        .toBeGreaterThanOrEqual(activeBeforeUpload.meta.commitSeq);
      expect(
        harness.files.has(
          recovery.deltaPath(orphanSeq),
        ),
      ).toBe(true);
      expect(
        harness.files.has(
          recovery.commitWitnessPath(orphanSeq),
        ),
      ).toBe(false);

      completionFault?.restore();
      completionFault = null;
      const folder = findRemoteItemByPath(
        harness.remoteItemState,
        "Notes",
      )!;
      folder.eTag = "etag-folder-notes-after-interruption";
      await harness.state.close();

      restartedState = new StateManager(harness.plugin);
      await restartedState.load();
      expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
      expect(restartedState.mutationLedger).toHaveLength(1);
      expect(
        harness.files.has(
          recovery.deltaPath(orphanSeq),
        ),
      ).toBe(false);
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

      const recovered = await restartedExecutor.run(
        "manual",
        {},
        false,
        undefined,
        { recoveryOnly: true },
      );
      expect(recovered).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        errors: 0,
        mutationRecovery: {
          state: "settled",
          total: 1,
          settled: 1,
          remaining: 0,
        },
      });
      expect(restartedState.mutationLedger).toEqual([]);
      expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(harness.mutations.renameItem).not.toHaveBeenCalled();
      expect(harness.mutations.moveItemById).not.toHaveBeenCalled();
      const recoveredEnvelope = restartedState.getCommittedV2Envelope()!;
      expect(recoveredEnvelope.meta.commitSeq)
        .toBeGreaterThan(retainedAfterInterruption.meta.commitSeq);
      expect(
        recoveredEnvelope.remoteIndex.itemsById["folder-notes"],
      ).toMatchObject({
        eTag: "etag-folder-notes-after-interruption",
      });
      expect(await recovery.rebuild()).toEqual(recoveredEnvelope);

      await restartedState.close();
      restartedState = null;
      coldState = new StateManager(harness.plugin);
      await coldState.load();
      expect(coldState.v2StateLoadRecoveryBlock).toBeNull();
      expect(coldState.mutationLedger).toEqual([]);
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
      const stable = await coldExecutor.run(
        "manual",
        {},
        false,
        undefined,
        { recoveryOnly: true },
      );
      expect(stable).toMatchObject({
        success: true,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        errors: 0,
        mutationRecovery: {
          state: "settled",
          total: 0,
          settled: 0,
          remaining: 0,
        },
      });
      expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
    } finally {
      completionFault?.restore();
      await coldState?.close();
      await restartedState?.close();
      await harness.state.close();
      for (const stores of activeStores.values()) {
        for (const store of stores) await store.close();
        await stores[0]?.delete();
      }
    }
  }, 30_000);

  it("rebuilds a rolled-back IndexedDB store from the witnessed journal on load", async () => {
    const { harness, recoveries, activeStores } = makeJournalHarness();
    let restarted: StateManager | null = null;
    try {
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      const selectedDatabaseId = harness.state
        .activeV2StorageAuthorityEvidence!.databaseId!;
      const recovery = recoveries.get(selectedDatabaseId)!;

      await commitOneFileRevision(harness, "rollback-form revision A", 2);
      const snapshot = await snapshotIndexedDbActiveStore(selectedDatabaseId);
      const rollbackSeq = (snapshot.meta as {
        header: { meta: { commitSeq: number } };
      }).header.meta.commitSeq;
      await commitOneFileRevision(harness, "rollback-form revision B", 3);
      const headSeq = (await recovery.rebuild()).meta.commitSeq;
      expect(headSeq).toBeGreaterThan(rollbackSeq);

      await restoreIndexedDbActiveStore(selectedDatabaseId, snapshot);
      restarted = new StateManager(harness.plugin);
      await restarted.load();
      expect(restarted.v2StateLoadRecoveryBlock).toBeNull();
      const healed = restarted.getCommittedV2Envelope()!;
      expect(healed.meta.commitSeq).toBe(headSeq);
      const rebuiltDatabaseId = restarted
        .activeV2StorageAuthorityEvidence!.databaseId!;
      expect(rebuiltDatabaseId).not.toBe(selectedDatabaseId);
    } finally {
      await restarted?.close();
      await harness.state.close();
      for (const stores of activeStores.values()) {
        for (const store of stores) await store.close();
      }
    }
  }, 30_000);

  it("keeps the load blocked when the journal record itself fails digest verification", async () => {
    const { harness, recoveries, activeStores } = makeJournalHarness();
    let restarted: StateManager | null = null;
    try {
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      const selectedDatabaseId = harness.state
        .activeV2StorageAuthorityEvidence!.databaseId!;
      const recovery = recoveries.get(selectedDatabaseId)!;

      await commitOneFileRevision(harness, "tampered-journal revision A", 2);
      const snapshot = await snapshotIndexedDbActiveStore(selectedDatabaseId);
      await commitOneFileRevision(harness, "tampered-journal revision B", 3);
      const headSeq = (await recovery.rebuild()).meta.commitSeq;
      await restoreIndexedDbActiveStore(selectedDatabaseId, snapshot);
      await harness.files.set(
        recovery.deltaPath(headSeq),
        "{\"tampered\":true}",
      );

      restarted = new StateManager(harness.plugin);
      await restarted.load();
      expect(restarted.v2StateLoadRecoveryBlock).toMatchObject({
        reason: "indexeddb-authority-recovery-failed",
      });
    } finally {
      await restarted?.close();
      await harness.state.close();
      for (const stores of activeStores.values()) {
        for (const store of stores) await store.close();
      }
    }
  }, 30_000);

  it("keeps the load blocked when the journal rebuild budget is exhausted", async () => {
    const { harness, recoveries, activeStores } = makeJournalHarness();
    const deviceStorage = new Map<string, string>();
    harness.plugin.app.loadLocalStorage = (key: string) =>
      deviceStorage.get(key) ?? null;
    harness.plugin.app.saveLocalStorage = (key: string, value: string) => {
      deviceStorage.set(key, value);
    };
    let restarted: StateManager | null = null;
    let coldState: StateManager | null = null;
    try {
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      const selectedDatabaseId = harness.state
        .activeV2StorageAuthorityEvidence!.databaseId!;

      await commitOneFileRevision(harness, "budget revision A", 2);
      const snapshot = await snapshotIndexedDbActiveStore(selectedDatabaseId);
      await commitOneFileRevision(harness, "budget revision B", 3);
      await restoreIndexedDbActiveStore(selectedDatabaseId, snapshot);
      restarted = new StateManager(harness.plugin);
      await restarted.load();
      expect(restarted.v2StateLoadRecoveryBlock).toBeNull();
      const rebuiltDatabaseId = restarted
        .activeV2StorageAuthorityEvidence!.databaseId!;
      expect(deviceStorage.has("easy-sync-indexeddb-journal-rebuild-budget-v1"))
        .toBe(true);

      const rebuiltRecovery = recoveries.get(rebuiltDatabaseId)!;
      const restartedExecutor = new SyncExecutor(
        harness.client,
        harness.scanner,
        restarted,
        "testVault",
        undefined,
        undefined,
        harness.diag as never,
        harness.fileManager as never,
      );
      await commitOneFileRevision(
        harness,
        "budget revision C",
        4,
        restartedExecutor,
      );
      const secondSnapshot = await snapshotIndexedDbActiveStore(
        rebuiltDatabaseId,
      );
      const secondRollbackSeq = (secondSnapshot.meta as {
        header: { meta: { commitSeq: number } };
      }).header.meta.commitSeq;
      await commitOneFileRevision(
        harness,
        "budget revision D",
        5,
        restartedExecutor,
      );
      await restoreIndexedDbActiveStore(rebuiltDatabaseId, secondSnapshot);
      expect(
        (await rebuiltRecovery.rebuild()).meta.commitSeq,
      ).toBeGreaterThan(secondRollbackSeq);

      await restarted.close();
      restarted = null;
      coldState = new StateManager(harness.plugin);
      await coldState.load();
      expect(coldState.v2StateLoadRecoveryBlock).toMatchObject({
        reason: "indexeddb-authority-recovery-failed",
      });
    } finally {
      await restarted?.close();
      await coldState?.close();
      await harness.state.close();
      for (const stores of activeStores.values()) {
        for (const store of stores) await store.close();
      }
    }
  }, 30_000);

  it("retries an already recorded V2 file checkpoint without reclassifying the mutation", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const changed = "checkpoint retry";
    const changedBytes = new TextEncoder().encode(changed);
    const changedHash = await sha256Hex(changedBytes);
    harness.files.set(localA.path, changed);
    harness.localEntryState[0] = {
      ...harness.localEntryState[0],
      hash: changedHash,
      size: changedBytes.byteLength,
      mtime: 2,
    };
    harness.mutations.uploadFile.mockImplementationOnce(async () => {
      const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
      remote.size = changedBytes.byteLength;
      remote.file = { hashes: { sha256Hash: changedHash } };
      remote.eTag = "etag-checkpoint-retry";
      remote.cTag = "ctag-checkpoint-retry";
      return {
        ...remote,
        parentReference: { ...remote.parentReference },
      };
    });
    const receiptWrite = vi.spyOn(harness.state, "recordMutationReceipt");
    harness.failStateRenameOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      uploaded: 1,
      errors: 0,
    });
    expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
    expect(receiptWrite).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toContainEqual({
      path: localA.path,
      hash: changedHash,
      size: changedBytes.byteLength,
      eTag: "etag-checkpoint-retry",
    });
    expect((await harness.executor.run("manual")).uploaded).toBe(0);
    expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
  });

  it("recovers a V2 download whose local write completed before receipt persistence failed", async () => {
    const original = "0123456789";
    const originalHash = await sha256Hex(new TextEncoder().encode(original));
    const changed = "changed remotely";
    const changedBytes = new TextEncoder().encode(changed);
    const changedHash = await sha256Hex(changedBytes);
    const harness = makeHarness({
      base: [{
        ...baseA,
        hash: originalHash,
      }],
      local: [{
        ...localA,
        hash: originalHash,
      }],
      remoteHash: originalHash,
      initialFiles: {
        [localA.path]: original,
      },
      remoteFileContents: {
        [localA.path]: changed,
      },
    });
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    remote.size = changedBytes.byteLength;
    remote.file = { hashes: { sha256Hash: changedHash } };
    remote.eTag = "etag-download-receipt-lost";
    remote.cTag = "ctag-download-receipt-lost";
    const receiptWrite = vi.spyOn(harness.state, "recordMutationReceipt")
      .mockRejectedValueOnce(new Error("receipt persistence failed"));

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      downloaded: 1,
      errors: 0,
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(receiptWrite).toHaveBeenCalledTimes(2);
    expect(harness.localEntryState[0]).toMatchObject({
      path: localA.path,
      hash: changedHash,
      size: changedBytes.byteLength,
    });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toContainEqual({
      path: localA.path,
      hash: changedHash,
      size: changedBytes.byteLength,
      eTag: "etag-download-receipt-lost",
    });
    expect((await harness.executor.run("manual")).downloaded).toBe(0);
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
  });

  it("recovers a lost remote file-move response without issuing a second move", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    harness.localEntryState[0].path = "Archive/a.md";
    harness.loseFolderMoveResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      filesMoved: 1,
      errors: 0,
    });
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/a.md")?.id)
      .toBe("file-a");
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).filesMoved).toBe(0);
    expect(harness.mutations.moveItemById).toHaveBeenCalledOnce();
  });

  it("moves a remotely relocated file locally by identity", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    remote.parentReference = {
      id: "folder-archive",
    };
    remote.eTag = "etag-a-moved";
    remote.file = { hashes: {} };

    const moved = await harness.executor.run("manual");

    expect(moved).toMatchObject({
      success: true,
      filesMoved: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(harness.localEntryState[0].path).toBe("Archive/a.md");
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.state.baseSnapshot).toContainEqual({
      path: "Archive/a.md",
      hash: hashA,
      size: localA.size,
      eTag: "etag-a-moved",
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      )[0],
    ).toMatchObject({
      remoteId: "file-a",
      lastPath: "Archive/a.md",
      remoteETag: "etag-a-moved",
      remoteCTag: "ctag-a",
    });
    expect(await harness.executor.run("manual")).toMatchObject({
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
  });

  it("strictly verifies one legacy hashless move, commits its cTag, and converges", async () => {
    const content = "0123456789";
    const contentHash = await sha256Hex(new TextEncoder().encode(content));
    const legacyLocal: LocalFileEntry = {
      path: "Notes/a.md",
      size: content.length,
      mtime: 1,
      hash: contentHash,
      binary: false,
    };
    const harness = makeHarness({
      base: [{
        path: legacyLocal.path,
        hash: legacyLocal.hash,
        size: legacyLocal.size,
        eTag: "etag-a",
      }],
      local: [legacyLocal],
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      initialFiles: { [legacyLocal.path]: content },
      remoteFileContents: { "Archive/a.md": content },
      remoteItems: [
        {
          id: "folder-notes",
          name: "Notes",
          folder: { childCount: 1 },
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-notes",
        },
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
        },
        {
          id: "file-a",
          name: "a.md",
          size: legacyLocal.size,
          file: { hashes: { sha256Hash: contentHash } },
          parentReference: { id: "folder-notes" },
          lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
          eTag: "etag-a",
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
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      )[0]!.remoteCTag,
    ).toBeUndefined();

    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    remote.parentReference = { id: "folder-archive" };
    remote.eTag = "etag-a-moved";
    remote.cTag = "ctag-a-content";
    remote.file = { hashes: {} };

    const moved = await harness.executor.run("manual");

    expect(moved).toMatchObject({
      success: true,
      filesMoved: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(harness.mutations.downloadFile).toHaveBeenCalledWith(
      "testVault",
      "Archive/a.md",
      undefined,
      "file-a",
      content.length,
    );
    expect(harness.localEntryState[0].path).toBe("Archive/a.md");
    expect(harness.state.mutationLedger).toEqual([]);
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.anchors.byAnchorId,
      )[0],
    ).toMatchObject({
      remoteId: "file-a",
      lastPath: "Archive/a.md",
      contentHash,
      remoteETag: "etag-a-moved",
      remoteCTag: "ctag-a-content",
    });
    expect(await harness.executor.run("manual")).toMatchObject({
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
  });

  it("cancels a local identity move when the remote version drifts after planning", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    remote.parentReference = { id: "folder-archive" };
    remote.eTag = "etag-a-moved";
    remote.file = { hashes: {} };
    const getFileMetadata = harness.client.getFileMetadata as ReturnType<typeof vi.fn>;
    const originalGetFileMetadata = getFileMetadata.getMockImplementation()!;
    let drifted = false;
    getFileMetadata.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "Archive/a.md" && !drifted) {
        drifted = true;
        remote.eTag = "etag-a-after-plan";
      }
      return originalGetFileMetadata(...args);
    });

    const deferred = await harness.executor.run("manual");

    expect(deferred).toMatchObject({
      success: true,
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.localEntryState[0].path).toBe("Notes/a.md");
    expect(harness.scanner.vault.rename).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("cancels a local identity move when the source changes after planning", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
    remote.parentReference = { id: "folder-archive" };
    remote.eTag = "etag-a-moved";
    remote.file = { hashes: {} };
    const inspectFile = harness.scanner.inspectFile as ReturnType<typeof vi.fn>;
    inspectFile.mockImplementationOnce(async (path: string) => {
      harness.localEntryState[0].hash = hashB;
      return {
        status: "present" as const,
        entry: { ...harness.localEntryState[0], path },
      };
    });

    const deferred = await harness.executor.run("manual");

    expect(deferred).toMatchObject({
      success: true,
      filesMoved: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      deferred: 1,
      errors: 0,
    });
    expect(harness.localEntryState[0].path).toBe("Notes/a.md");
    expect(harness.scanner.vault.rename).not.toHaveBeenCalled();
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("recovers a cancelled local identity move after a process restart", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
        },
      ],
    });
    let restartedState: StateManager | null = null;
    try {
      await harness.state.load();
      expect((await harness.executor.run(
        "manual",
        {},
        false,
        undefined,
        { activateV2State: true },
      )).success).toBe(true);
      const remote = harness.remoteItemState.find((item) => item.id === "file-a")!;
      remote.parentReference = { id: "folder-archive" };
      remote.eTag = "etag-a-moved";
      remote.file = { hashes: {} };
      const inspectFile = harness.scanner.inspectFile as ReturnType<typeof vi.fn>;
      inspectFile.mockImplementationOnce(async (path: string) => {
        harness.executor.cancel();
        return {
          status: "present" as const,
          entry: { ...harness.localEntryState[0], path },
        };
      });

      const cancelled = await harness.executor.run("manual");
      expect(cancelled.message).toBe("result.cancelled");
      expect(harness.localEntryState[0].path).toBe("Notes/a.md");
      expect(harness.scanner.vault.rename).not.toHaveBeenCalled();

      await harness.state.close();
      restartedState = new StateManager(harness.plugin);
      await restartedState.load();
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
      const recovered = await restartedExecutor.run("manual");

      expect(recovered).toMatchObject({
        success: true,
        filesMoved: 1,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        errors: 0,
      });
      expect(harness.localEntryState[0].path).toBe("Archive/a.md");
      expect(restartedState.mutationLedger).toEqual([]);
      expect(harness.scanner.vault.rename).toHaveBeenCalledOnce();
    } finally {
      await restartedState?.close();
      await harness.state.close();
    }
  });

  it("defers a 412 remote file move and retries with the refreshed version", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    harness.localEntryState[0].path = "Archive/a.md";
    harness.conflictFolderMoveOnce();

    const deferred = await harness.executor.run("manual");
    expect(deferred).toMatchObject({
      success: true,
      filesMoved: 0,
      deferred: 1,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Notes/a.md")?.eTag)
      .toBe("etag-a-advanced");
    expect(harness.state.mutationLedger).toEqual([]);

    const retried = await harness.executor.run("manual");
    expect(retried).toMatchObject({
      success: true,
      filesMoved: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Archive/a.md")?.id)
      .toBe("file-a");
  });

  it("recovers a lost local file-move response without moving the file twice", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Archive" }],
      remoteItems: [
        ...remoteItems(),
        {
          id: "folder-archive",
          name: "Archive",
          folder: {},
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-archive",
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
    harness.remoteItemState.find((item) => item.id === "file-a")!.parentReference = {
      id: "folder-archive",
    };
    harness.loseLocalFileMoveResponseOnce();

    const recovered = await harness.executor.run("manual");

    expect(recovered).toMatchObject({
      success: true,
      filesMoved: 1,
      errors: 0,
    });
    expect(harness.localEntryState[0].path).toBe("Archive/a.md");
    expect(harness.state.mutationLedger).toEqual([]);
    expect((await harness.executor.run("manual")).filesMoved).toBe(0);
    expect(harness.scanner.vault.rename).toHaveBeenCalledOnce();
  });

  it("deletes remote children before the now-empty local-deleted folder shell", async () => {
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
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

  it("mirrors a folder moved into the vault trash as a remote deletion", async () => {
    const harness = makeHarness();
    await harness.state.load();
    expect((await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    )).success).toBe(true);
    // Obsidian 删除到回收站=一次 rename：移动证据绑定到 committed 身份，
    // 而 .trash 是扫描硬排除区，本地不再返回该文件夹；云端目录仍在原路径。
    expect(await harness.state.recordLocalFolderMoveHint("Notes", ".trash/Notes"))
      .toBe(true);
    harness.localEntryState.splice(0);
    harness.localFolderPaths.delete("Notes");
    vi.mocked(harness.scanner.shouldSyncFolderPath).mockImplementation(
      (path) => !path.startsWith(".trash"),
    );

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
    expect(harness.state.localFolderMoveHints).toHaveLength(0);
    expect(harness.state.mutationLedger).toHaveLength(0);
    expect((await harness.executor.run("manual")).foldersDeleted).toBe(0);
  });

});
