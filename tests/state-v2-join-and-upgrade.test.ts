// 加入分类与公开 1.1.3 升级
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
  it("classifies a fresh device with an existing shared protocol as a cloud V2 join", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol();
    await harness.state.load();
    const previewCallback = vi.fn().mockResolvedValue(false);

    const preview = await harness.executor.run(
      "manual",
      { onConfirmThreshold: previewCallback },
    );

    expect(preview.message).toBe("result.pausedForReview");
    expect(previewCallback.mock.calls[0]?.[0]).toMatchObject({
      reviewKind: "v2-cloud-join",
      items: [],
    });
    const authorization = harness.state.planReviewAuthorization;
    expect(authorization?.reviewKind).toBe("v2-cloud-join");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
    );

    expect(executed.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expect(JSON.parse(harness.getSharedProtocolV3()!.content))
      .toMatchObject({
        migrationGeneration: JSON.parse(
          (await harness.client.readSharedSyncProtocolV2("testVault"))!.content,
        ).migrationGeneration,
      });
    expectNoFileMutations(harness.mutations);
  });

  it("joins an exact existing V3 lineage when a fresh device observes another V2 scope", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "previous-files-root",
    });
    const seededBinding = await seedExactScopeFreeProtocol(harness);
    await harness.state.load();
    const previewCallback = vi.fn().mockResolvedValue(false);

    const preview = await harness.executor.run(
      "manual",
      { onConfirmThreshold: previewCallback },
    );

    expect(preview.message).toBe("result.pausedForReview");
    expect(previewCallback.mock.calls[0]?.[0]).toMatchObject({
      reviewKind: "v2-cloud-join",
      items: [],
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

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
    const authorization = restartedState.planReviewAuthorization;
    expect(authorization?.reviewKind).toBe("v2-cloud-join");

    const executed = await restartedExecutor.run(
      "manual",
      {},
      true,
      authorization!,
    );

    expect(executed).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.remoteScope).toEqual(scope);
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      protocolBinding: {
        protocolVersion: 3,
        migrationGeneration: seededBinding.migrationGeneration,
        predecessorContentSha256:
          seededBinding.predecessorContentSha256,
        contentSha256: seededBinding.contentSha256,
      },
    });
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("requests the binding-proven V3 slot on the per-round protocol observation and stays healthy", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "previous-files-root",
    });
    const seededBinding = await seedExactScopeFreeProtocol(harness);
    await harness.state.load();
    const preview = await harness.executor.run("manual", {
      onConfirmThreshold: vi.fn().mockResolvedValue(false),
    });
    expect(preview.message).toBe("result.pausedForReview");
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
    const authorization = restartedState.planReviewAuthorization;
    const executed = await restartedExecutor.run(
      "manual",
      {},
      true,
      authorization!,
    );
    expect(executed.success).toBe(true);

    // Per-round observation: capture the expected V3 slot identity the
    // executor asks for and simulate the client's binding-proven skip (slot
    // with content: null).
    const observedSlotArgs: Array<{ id: string; eTag: string } | undefined> =
      [];
    vi.mocked(harness.client.readSharedSyncProtocolObjects).mockImplementation(
      async (
        vaultName: string,
        expectedV3Slot?: { id: string; eTag: string },
      ) => {
        observedSlotArgs.push(expectedV3Slot);
        return {
          v2: await harness.client.readSharedSyncProtocolV2(vaultName),
          v3: expectedV3Slot
            ? {
                id: expectedV3Slot.id,
                eTag: expectedV3Slot.eTag,
                content: null,
              }
            : await harness.client.readSharedSyncProtocolV3(vaultName),
        };
      },
    );

    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    // The per-round ensure requested the exact committed binding identity…
    expect(observedSlotArgs.at(-1)).toEqual({
      id: seededBinding.recordId,
      eTag: seededBinding.recordETag,
    });
    // …and the binding-proven slot (content: null) was materialized into a
    // healthy profile without any protocol creation or repair.
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.overwriteSharedSyncProtocolV2).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("overlaps the per-round protocol observation with the remote scan instead of running them in sequence", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "previous-files-root",
    });
    await seedExactScopeFreeProtocol(harness);
    await harness.state.load();
    const preview = await harness.executor.run("manual", {
      onConfirmThreshold: vi.fn().mockResolvedValue(false),
    });
    expect(preview.message).toBe("result.pausedForReview");
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
    const authorization = restartedState.planReviewAuthorization;
    const executed = await restartedExecutor.run(
      "manual",
      {},
      true,
      authorization!,
    );
    expect(executed.success).toBe(true);

    // Order the two read paths: the protocol observation marks both its start
    // and its end; the delta marks only its start. The remote scan must run
    // while the (slow) observation is still in flight.
    const order: string[] = [];
    vi.mocked(harness.client.readSharedSyncProtocolObjects).mockImplementation(
      async (vaultName: string) => {
        order.push("observe-start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push("observe-end");
        return {
          v2: await harness.client.readSharedSyncProtocolV2(vaultName),
          v3: await harness.client.readSharedSyncProtocolV3(vaultName),
        };
      },
    );
    const getDelta = vi.fn().mockImplementation(async () => {
      order.push("delta-start");
      order.push("delta-end");
      return { value: [], "@odata.deltaLink": "overlap-tok" };
    });
    vi.mocked(harness.client.getDelta).mockImplementation(getDelta);
    if (harness.client.getDeltaByFolderId) {
      vi.mocked(harness.client.getDeltaByFolderId).mockImplementation(
        getDelta,
      );
    }

    const stable = await restartedExecutor.run("manual");
    expect(stable.success).toBe(true);
    expect(order.indexOf("delta-start")).toBeLessThan(
      order.indexOf("observe-end"),
    );
  });

  it("commits the remote projection before reporting a failed protocol convergence and keeps the next round healthy", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "previous-files-root",
    });
    await seedExactScopeFreeProtocol(harness);
    await harness.state.load();
    const preview = await harness.executor.run("manual", {
      onConfirmThreshold: vi.fn().mockResolvedValue(false),
    });
    expect(preview.message).toBe("result.pausedForReview");
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
    const authorization = restartedState.planReviewAuthorization;
    const executed = await restartedExecutor.run(
      "manual",
      {},
      true,
      authorization!,
    );
    expect(executed.success).toBe(true);

    const getDelta = vi.fn().mockResolvedValue({
      value: [],
      "@odata.deltaLink": "commit-before-block-tok",
    });
    vi.mocked(harness.client.getDelta).mockImplementation(getDelta);
    if (harness.client.getDeltaByFolderId) {
      vi.mocked(harness.client.getDeltaByFolderId).mockImplementation(
        getDelta,
      );
    }
    vi.mocked(harness.client.readSharedSyncProtocolObjects)
      .mockRejectedValueOnce(new Error("protocol read failed"))
      .mockImplementation(async (vaultName: string) => ({
        v2: await harness.client.readSharedSyncProtocolV2(vaultName),
        v3: await harness.client.readSharedSyncProtocolV3(vaultName),
      }));

    const failed = await restartedExecutor.run("manual");
    expect(failed.message).toBe("result.v2ProtocolBlocked");
    expect(failed.errors).toBe(1);
    // The remote scan ran while the protocol observation was in flight and
    // is already committed when the protocol failure is reported.
    expect(getDelta).toHaveBeenCalled();
    expect(restartedState.remoteDeltaLink).toBe("commit-before-block-tok");

    // The committed observation-only projection must not disturb the next
    // round: it continues from the fresh cursor and converges normally.
    const recovered = await restartedExecutor.run("manual");
    expect(recovered.success).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("retains a reviewed cross-scope join when revalidation is temporarily unavailable", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "previous-files-root",
    });
    await seedExactScopeFreeProtocol(harness);
    const profile = {
      v2: await harness.client.readSharedSyncProtocolV2("testVault"),
      v3: harness.getSharedProtocolV3(),
    };
    await harness.state.load();
    await harness.executor.run("manual");
    const authorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    readProfile.mockReset()
      .mockResolvedValueOnce(profile)
      .mockRejectedValueOnce(new SyntheticRequestTimeoutError(15_000))
      .mockResolvedValue(profile);
    vi.mocked(harness.client.createSharedSyncProtocolV2).mockClear();
    vi.mocked(harness.client.createSharedSyncProtocolV3).mockClear();

    const unavailable = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );

    expect(unavailable).toMatchObject({
      success: false,
      errors: 1,
      message: "result.remoteReadUnavailable",
      runFacts: {
        ordinaryPlanning: "entered",
      },
    });
    expect(unavailable.disposition).toBeUndefined();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.planReviewAuthorization).toEqual(authorization);
    expect(readProfile).toHaveBeenCalledTimes(2);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const joined = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );
    expect(joined).toMatchObject({ success: true, errors: 0 });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(readProfile).toHaveBeenCalledTimes(4);
    expectNoFileMutations(harness.mutations);
  });

  it("does not reclassify a fresh V3 join from a current failed sync history", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "previous-files-root",
    });
    await seedExactScopeFreeProtocol(harness);
    await harness.state.load();
    const firstPreviewCallback = vi.fn().mockResolvedValue(false);
    await harness.executor.run(
      "manual",
      { onConfirmThreshold: firstPreviewCallback },
    );
    expect(firstPreviewCallback.mock.calls[0]?.[0]).toMatchObject({
      reviewKind: "v2-cloud-join",
    });
    await harness.state.addSyncHistory({
      id: "current-join-profile-timeout",
      mode: "manual",
      status: "failed",
      startedAt: 1,
      endedAt: 2,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: 1,
      message: "result.v2ProtocolBlocked",
      files: [],
    });
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
    const previewCallback = vi.fn().mockResolvedValue(false);
    expect(restartedState.syncHistory[0]?.id)
      .toBe("current-join-profile-timeout");

    const preview = await restartedExecutor.run(
      "manual",
      { onConfirmThreshold: previewCallback },
    );

    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      errors: 0,
    });
    expect(previewCallback.mock.calls[0]?.[0]).toMatchObject({
      reviewKind: "v2-cloud-join",
      items: [],
    });
    expect(restartedState.planReviewAuthorization?.reviewKind)
      .toBe("v2-cloud-join");
    expect(restartedState.isV2StateActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const executed = await restartedExecutor.run(
      "manual",
      {},
      true,
      restartedState.planReviewAuthorization!,
    );
    expect(executed).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    const stable = await restartedExecutor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("classifies an empty device and empty cloud as first V2 sync", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    await harness.state.load();
    const previewCallback = vi.fn().mockResolvedValue(false);

    const preview = await harness.executor.run(
      "manual",
      { onConfirmThreshold: previewCallback },
    );

    expect(preview.message).toBe("result.pausedForReview");
    expect(previewCallback.mock.calls[0]?.[0]).toMatchObject({
      reviewKind: "v2-first-sync",
      items: [],
    });
    const authorization = harness.state.planReviewAuthorization;
    expect(authorization?.reviewKind).toBe("v2-first-sync");
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
    );

    expect(executed.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expect(JSON.parse(harness.getSharedProtocolV3()!.content))
      .toMatchObject({
        migrationGeneration: JSON.parse(
          (await harness.client.readSharedSyncProtocolV2("testVault"))!.content,
        ).migrationGeneration,
      });
    expectNoFileMutations(harness.mutations);
  });

  it("resumes a checkpointed reviewed first-sync authorization after a cold restart and post-write protocol observation timeout", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    await harness.state.load();
    expect((await harness.executor.run("manual")).message)
      .toBe("result.pausedForReview");
    const authorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    expect(authorization.reviewKind).toBe("v2-first-sync");

    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    const defaultReadProfile = readProfile.getMockImplementation()!;
    let failPostV3Observation = true;
    readProfile.mockImplementation(async (...args) => {
      const observed = await defaultReadProfile(...args);
      if (
        failPostV3Observation
        && vi.mocked(harness.client.createSharedSyncProtocolV3).mock.calls.length
          > 0
      ) {
        failPostV3Observation = false;
        throw new SyntheticRequestTimeoutError(15_000);
      }
      return observed;
    });

    const unavailable = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );

    expect(unavailable).toMatchObject({
      success: false,
      errors: 1,
      message: "result.remoteReadUnavailable",
    });
    expect(unavailable.disposition).toBeUndefined();
    expect(harness.state.isV2StateActive).toBe(false);
    const checkpointedAuthorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    expect(checkpointedAuthorization).toEqual({
      ...authorization,
      revision: authorization.revision + 1,
    });
    const checkpointedHold = structuredClone(
      harness.state.activeV2MigrationHold!,
    );
    expect(checkpointedHold).toMatchObject({
      phase: "pending",
      reviewKind: "v2-first-sync",
      revision: authorization.revision + 1,
    });
    const createdProtocol = await harness.client.readSharedSyncProtocolV2(
      "testVault",
    );
    expect(createdProtocol).not.toBeNull();
    const createdProtocolContent = JSON.parse(createdProtocol!.content);
    expect(checkpointedHold.protocolBinding).toEqual({
      schemaVersion: 1,
      protocolVersion: 2,
      migrationGeneration: createdProtocolContent.migrationGeneration,
      confirmedAllDevicesUpdatedAt:
        createdProtocolContent.confirmedAllDevicesUpdatedAt,
      recordId: createdProtocol!.id,
      recordETag: createdProtocol!.eTag,
    });
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);

    readProfile.mockImplementation(defaultReadProfile);
    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    const refreshedAuthorization = structuredClone(
      restartedState.planReviewAuthorization!,
    );
    expect(refreshedAuthorization).toEqual(checkpointedAuthorization);

    const resumed = await restartedExecutor.run(
      "manual",
      {},
      true,
      refreshedAuthorization,
    );

    expect(resumed).toMatchObject({ success: true, errors: 0 });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
    await restartedState.close();
  });

  it("rejects a checkpointed first-sync authorization when same-scope V2 identity is replaced", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    await harness.state.load();
    expect((await harness.executor.run("manual")).message)
      .toBe("result.pausedForReview");
    const initialAuthorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    expect(initialAuthorization.reviewKind).toBe("v2-first-sync");

    const readProfile = vi.mocked(
      harness.client.readSharedSyncProtocolObjects,
    );
    const defaultReadProfile = readProfile.getMockImplementation()!;
    let failPostV3Observation = true;
    readProfile.mockImplementation(async (...args) => {
      const observed = await defaultReadProfile(...args);
      if (
        failPostV3Observation
        && vi.mocked(harness.client.createSharedSyncProtocolV3).mock.calls.length
          > 0
      ) {
        failPostV3Observation = false;
        throw new SyntheticRequestTimeoutError(15_000);
      }
      return observed;
    });

    expect(await harness.executor.run(
      "manual",
      {},
      true,
      initialAuthorization,
    )).toMatchObject({
      success: false,
      errors: 1,
      message: "result.remoteReadUnavailable",
    });
    const staleAuthorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    expect(staleAuthorization).toEqual({
      ...initialAuthorization,
      revision: initialAuthorization.revision + 1,
    });
    const createdProtocol = await harness.client.readSharedSyncProtocolV2(
      "testVault",
    );
    expect(createdProtocol).not.toBeNull();
    harness.seedSharedProtocolContent(createdProtocol!.content);
    const replacementProtocol =
      await harness.client.readSharedSyncProtocolV2("testVault");
    expect(replacementProtocol).toMatchObject({
      id: "protocol-recovered-id",
      eTag: "protocol-recovered-etag",
      content: createdProtocol!.content,
    });
    expect(replacementProtocol!.id).not.toBe(createdProtocol!.id);
    expect(replacementProtocol!.eTag).not.toBe(createdProtocol!.eTag);

    readProfile.mockImplementation(defaultReadProfile);
    await harness.state.close();
    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = createRestartedExecutor(
      harness,
      restartedState,
    );
    expect(restartedState.planReviewAuthorization).toEqual(staleAuthorization);

    const rejected = await restartedExecutor.run(
      "manual",
      {},
      true,
      staleAuthorization,
    );

    expect(rejected).toMatchObject({
      success: false,
      errors: 0,
      message: "result.pausedForReview",
    });
    expect(restartedState.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(restartedState.planReviewAuthorization).toMatchObject({
      reviewKind: "v2-cloud-join",
      revision: staleAuthorization.revision + 1,
    });
    expect(restartedState.planReviewAuthorization).not.toEqual(
      staleAuthorization,
    );
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
    await restartedState.close();
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
    "does not checkpoint a reviewed first-sync create after cancellation and a late %s readback",
    async (_label, lateError) => {
      const harness = makeHarness({
        base: [],
        local: [],
        localFolders: [],
        remoteItems: [],
        pluginData: {
          "easy-sync-generation": 0,
          "easy-sync-last-sync-time": 0,
        },
      });
      await harness.state.load();
      expect((await harness.executor.run("manual")).message)
        .toBe("result.pausedForReview");
      const authorization = structuredClone(
        harness.state.planReviewAuthorization!,
      );
      const holdBefore = structuredClone(harness.state.activeV2MigrationHold!);
      expect(holdBefore).toMatchObject({
        phase: "pending",
        reviewKind: "v2-first-sync",
      });
      expect(holdBefore.protocolBinding).toBeUndefined();

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
        true,
        authorization,
      );
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
        },
      });
      expect(cancelled.disposition).toBeUndefined();
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.planReviewAuthorization).toEqual(authorization);
      expect(harness.state.activeV2MigrationHold).toEqual(holdBefore);
      expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
      expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
      expectNoFileMutations(harness.mutations);
      await harness.state.close();
    },
  );

  it("does not commit reviewed first-sync authority when cancellation lands during final post-V3 profile completion", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    await harness.state.load();
    expect((await harness.executor.run("manual")).message)
      .toBe("result.pausedForReview");
    const authorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    let markFinalV3Ready!: () => void;
    const finalV3Ready = new Promise<void>((resolve) => {
      markFinalV3Ready = resolve;
    });
    let releaseFinalV3!: () => void;
    const finalV3Gate = new Promise<void>((resolve) => {
      releaseFinalV3 = resolve;
    });
    const executorInternals = harness.executor as unknown as {
      ensureSharedSyncProtocolV3FromObservation: (
        ...args: unknown[]
      ) => Promise<{ status: string }>;
    };
    const finishV3 =
      executorInternals.ensureSharedSyncProtocolV3FromObservation.bind(
        harness.executor,
      );
    vi.spyOn(
      executorInternals,
      "ensureSharedSyncProtocolV3FromObservation",
    ).mockImplementation(async (...args) => {
      const outcome = await finishV3(...args);
      if (
        outcome.status === "ready"
        && vi.mocked(harness.client.createSharedSyncProtocolV3).mock.calls.length
          > 0
      ) {
        markFinalV3Ready();
        await finalV3Gate;
      }
      return outcome;
    });
    const commitAuthority = vi.spyOn(
      harness.state,
      "commitConfirmedV2MigrationHold",
    );

    const pendingRun = harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );
    await finalV3Ready;
    harness.executor.cancel();
    releaseFinalV3();
    const cancelled = await pendingRun;

    expect(cancelled).toMatchObject({
      success: false,
      errors: 0,
      message: "result.cancelled",
      runFacts: {
        termination: "cancelled",
      },
    });
    expect(commitAuthority).not.toHaveBeenCalled();
    expect(harness.state.activeV2MigrationHold?.phase).toBe("pending");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
    await harness.state.close();
  });

  it("does not start authority commit when cancellation lands during reviewed first-sync state revalidation", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    await harness.state.load();
    expect((await harness.executor.run("manual")).message)
      .toBe("result.pausedForReview");
    const authorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    let markRevalidationStarted!: () => void;
    const revalidationStarted = new Promise<void>((resolve) => {
      markRevalidationStarted = resolve;
    });
    let releaseRevalidation!: () => void;
    const revalidationGate = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    const currentAuthorization = harness.state.isCurrentV2MigrationAuthorization
      .bind(harness.state);
    let heldFinalRevalidation = false;
    vi.spyOn(harness.state, "isCurrentV2MigrationAuthorization")
      .mockImplementation(async (input) => {
        if (
          !heldFinalRevalidation
          && vi.mocked(harness.client.createSharedSyncProtocolV3).mock.calls
            .length > 0
        ) {
          heldFinalRevalidation = true;
          markRevalidationStarted();
          await revalidationGate;
        }
        return currentAuthorization(input);
      });
    const commitAuthority = vi.spyOn(
      harness.state,
      "commitConfirmedV2MigrationHold",
    );

    const pendingRun = harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );
    await revalidationStarted;
    harness.executor.cancel();
    releaseRevalidation();
    const cancelled = await pendingRun;

    expect(cancelled).toMatchObject({
      success: false,
      errors: 0,
      message: "result.cancelled",
      runFacts: {
        termination: "cancelled",
      },
    });
    expect(commitAuthority).not.toHaveBeenCalled();
    expect(["pending", "confirmed"]).toContain(
      harness.state.activeV2MigrationHold?.phase,
    );
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.createSharedSyncProtocolV3).toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
    await harness.state.close();
  });

  it.each([
    ["generation", (protocol: Record<string, unknown>) => ({
      ...protocol,
      migrationGeneration: "f".repeat(64),
    })],
    ["predecessor", (protocol: Record<string, unknown>) => ({
      ...protocol,
      predecessor: {
        protocolVersion: 2,
        contentSha256: "f".repeat(64),
      },
    })],
  ] as const)("fails before review for an initial %s mismatch", async (
    _label,
    changeProtocol,
  ) => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol();
    await seedExactScopeFreeProtocol(harness);
    const changedProtocol = changeProtocol(
      JSON.parse(harness.getSharedProtocolV3()!.content),
    );
    harness.seedSharedProtocolV3(JSON.stringify(changedProtocol));
    await harness.state.load();
    const previewCallback = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: previewCallback },
    );

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2ProtocolBlocked",
    });
    expect(previewCallback).not.toHaveBeenCalled();
    expect(harness.state.planReviewAuthorization).toBeNull();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expect(harness.diag.error).toHaveBeenCalledWith(
      "state",
      "shared-sync-protocol-profile-inconsistent",
      expect.objectContaining({
        status: "inconsistent",
        reason: `${_label}-mismatch`,
        v2Generation: expect.stringMatching(/^[0-9a-f]{12}$/),
        v3Generation: expect.stringMatching(/^[0-9a-f]{12}$/),
        predecessor: _label === "generation" ? "match" : "mismatch",
      }),
    );
    expectNoFileMutations(harness.mutations);
  });

  it("does not create a protocol when an empty reviewed profile changes", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    await harness.state.load();
    expect((await harness.executor.run("manual")).message)
      .toBe("result.pausedForReview");
    const authorization = harness.state.planReviewAuthorization;
    expect(authorization?.reviewKind).toBe("v2-first-sync");
    harness.seedSharedProtocolV3(JSON.stringify({
      schemaVersion: 1,
      kind: "easy-sync-generation-protocol",
      protocolVersion: 3,
      migrationGeneration: "a".repeat(64),
      predecessor: {
        protocolVersion: 2,
        contentSha256: "b".repeat(64),
      },
      createdAt: 1,
    }));

    const result = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
    );

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2ProtocolBlocked",
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("fails closed when a fresh device finds a shared protocol for another scope", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "other-files-root",
    });
    await harness.state.load();
    const previewCallback = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: previewCallback },
    );

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2ProtocolBlocked",
    });
    expect(previewCallback).not.toHaveBeenCalled();
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("fails closed when the exact V3 lineage changes after fresh cross-scope review", async () => {
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [],
      remoteItems: [],
      pluginData: {
        "easy-sync-generation": 0,
        "easy-sync-last-sync-time": 0,
      },
    });
    harness.seedSharedProtocol({
      ...scope,
      filesRootId: "previous-files-root",
    });
    await seedExactScopeFreeProtocol(harness);
    await harness.state.load();
    await harness.executor.run("manual");
    const authorization = harness.state.planReviewAuthorization;
    expect(authorization?.reviewKind).toBe("v2-cloud-join");

    const changedProtocol = JSON.parse(
      harness.getSharedProtocolV3()!.content,
    );
    changedProtocol.predecessor.contentSha256 = "f".repeat(64);
    harness.seedSharedProtocolV3(JSON.stringify(changedProtocol));
    vi.mocked(harness.client.createSharedSyncProtocolV3).mockClear();

    const blocked = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
    );

    expect(blocked).toMatchObject({
      success: false,
      errors: 1,
      message: "result.v2ProtocolBlocked",
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    expect(harness.client.createSharedSyncProtocolV3).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("upgrades a clean fixture derived from the exact public 1.1.3 state and cold-starts into a zero plan", async () => {
    const harness = makeHarness(public113CleanFixtureInput());
    await harness.state.load();

    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.planReviewAuthorization).toMatchObject({
      reviewKind: "v2-migration",
    });
    expect(harness.state.isV2StateActive).toBe(false);
    // The production LocalScanner excludes EasySync's own ancestor store.
    // This broad test double exposes Adapter-created internal directories, so
    // remove them before the confirmation scan to match the real scanner.
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }

    const migrated = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(migrated).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.activeV2StorageAuthorityEvidence).toMatchObject({
      kind: "json",
      databaseId: null,
    });
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.planReviewActive).toBe(false);
    expectNoFileMutations(harness.mutations);
    expect(harness.pluginData).toEqual(expect.objectContaining({
      "sync-interval": 3,
      "sync-max-file-size-mb": 128,
      "sync-excluded-folders": ["Private"],
      "sync-auto-conflict-policy": {
        autoDeleteLocalFiles: false,
        mergeNonOverlappingText: true,
      },
      "easy-sync-profile-cache": {
        displayName: "Release Fixture",
        accountId: scope.accountId,
      },
      "easy-sync-history": [
        expect.objectContaining({
          id: "release-1.1.3-history",
          status: "partial",
        }),
      ],
      "release-1.1.3-unknown-key": { mustSurvive: true },
      "easy-sync-base-snapshot": {},
      [KEY_PUBLIC_113_CUTOVER]: expect.objectContaining({
        kind: "public-1.1.3-cutover",
        importedLegacyMutationRecords: 0,
      }),
    }));
    expect(harness.pluginData["easy-sync-last-sync-time"]).toEqual(
      expect.any(Number),
    );
    expect(
      harness.pluginData["easy-sync-last-sync-time"] as number,
    ).toBeGreaterThanOrEqual(1721234567890);
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      protocolBinding: {
        schemaVersion: 1,
        protocolVersion: 3,
        migrationGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
        recordId: "protocol-v3-id",
      },
    });

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
    const stable = await restartedExecutor.run("manual");

    expect(stable).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.planReviewActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a public-1.1.3 remote-only plugin out of preview and persists its device opt-out only after V2 activation", async () => {
    const fixture = public113CleanFixtureInput();
    const pluginBundle = await sharedCalendarPluginBundleFixture();
    const harness = makeHarness({
      ...fixture,
      remoteItems: [
        ...fixture.remoteItems!,
        {
          id: "folder-obsidian",
          name: ".obsidian",
          folder: { childCount: 1 },
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-obsidian",
        },
        ...pluginBundle.remoteItems,
      ],
      remoteFileContents: {
        ...pluginBundle.remoteFileContents,
      },
    });
    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "all", pluginIds: [] },
      data: { mode: "none", pluginIds: [] },
    });
    await harness.state.load();

    const preview = await harness.executor.run("manual");

    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(preview.communityPluginLocalIgnores).toBeUndefined();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.getCommunityPluginManifestObservations()).toEqual([]);
    expect(harness.state.getRemoteCommunityPluginCatalog()).toBeNull();
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    expect(harness.rawAdapter.writeBinary.mock.calls.some(
      ([path]) => String(path).startsWith(".obsidian/plugins/calendar/"),
    )).toBe(false);

    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    harness.mutations.downloadFile.mockClear();
    const migrated = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(migrated).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      errors: 0,
      communityPluginLocalIgnores: {
        files: ["calendar"],
        data: [],
      },
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.getCommunityPluginManifestObservations()).toEqual([]);
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("stages the exact public-1.1.3 candidate in inactive IndexedDB before JSON authority cutover", async () => {
    const databaseName =
      `easy-sync-activation:exact:${crypto.randomUUID()}`;
    const plannerView = vi.spyOn(
      IndexedDbPublic113StateStore.prototype,
      "loadPreparedPlannerView",
    );
    const envelopeHydration = vi.spyOn(
      IndexedDbPublic113StateStore.prototype,
      "loadPreparedCandidate",
    );
    const fixture = public113CleanFixtureInput();
    const harness = makeHarness({
      ...fixture,
      createPublic113IndexedDbCandidateStore: () =>
        new IndexedDbPublic113StateStore(databaseName),
    });
    try {
      await harness.state.load();
      expect(await harness.executor.run("manual")).toMatchObject({
        success: false,
        message: "result.pausedForReview",
      });
      for (const folder of [...harness.localFolderPaths]) {
        if (folder.startsWith(".obsidian")) {
          harness.localFolderPaths.delete(folder);
        }
      }

      const migrated = await harness.executor.run(
        "manual",
        {},
        true,
        harness.state.planReviewAuthorization!,
        { acknowledgeMigrationRisk: true },
      );
      expect(migrated).toMatchObject({
        success: true,
        errors: 0,
      });
      expect(plannerView).toHaveBeenCalled();
      expect(envelopeHydration).not.toHaveBeenCalled();

      const marker = harness.pluginData[
        KEY_PUBLIC_113_CUTOVER
      ] as { sourceStateDigest: string };
      const store = new IndexedDbPublic113StateStore(databaseName);
      expect(await store.inspect()).toMatchObject({
        phase: "prepared",
        authority: "inactive",
        sourceStateDigest: marker.sourceStateDigest,
      });
      const staged = await store.loadPreparedCandidate(
        marker.sourceStateDigest,
      );
      expect(staged).toEqual(JSON.parse(
        harness.files.get(paths.stateV2File)!,
      ));
      expect(harness.state.isV2StateActive).toBe(true);
      expect(harness.state.legacyAutoSyncAllowed).toBe(false);
      await store.close();
      expectNoFileMutations(harness.mutations);
    } finally {
      plannerView.mockRestore();
      envelopeHydration.mockRestore();
      await new IndexedDbPublic113StateStore(databaseName).delete();
    }
  });

  it("reconstructs a mixed-version public-1.1.3 reinstall before IndexedDB authority", async () => {
    const candidateDatabaseName =
      `easy-sync-activation:public-reinstall:${crypto.randomUUID()}`;
    const indexedDbVaultInstanceId = crypto.randomUUID().replaceAll("-", "");
    const activeStores = new Map<string, StateV2IndexedDbActiveStore[]>();
    const plannerView = vi.spyOn(
      IndexedDbPublic113StateStore.prototype,
      "loadPreparedPlannerView",
    );
    const {
      fixtureInput,
      basePaths,
      equalPaths,
      differentPath,
      remoteOnlyPaths,
      folderPaths,
      remoteDifferentHash,
      remoteDifferentSize,
      remoteDifferentETag,
      remoteDifferentCTag,
      remoteDifferentDriveId,
    } = await public113ReinstalledMixedVersionFixtureInput();
    const harness = makeHarness({
      ...fixtureInput,
      createPublic113IndexedDbCandidateStore: () =>
        new IndexedDbPublic113StateStore(candidateDatabaseName),
      indexedDbVaultInstanceId,
      createStateV2IndexedDbActiveStore: (databaseId, recovery) => {
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        activeStores.set(databaseId, [
          ...(activeStores.get(databaseId) ?? []),
          store,
        ]);
        return store;
      },
    });
    let restartedState: StateManager | null = null;
    const retireFirstSyncEvidence = vi.spyOn(
      harness.state,
      "retireFirstSyncVerificationEvidence",
    );
    try {
      const equalBootstrapAnchors = equalPaths.map((path) => {
        const local = fixtureInput.local!.find((entry) =>
          entry.path === path)!;
        const remote = fixtureInput.remoteItems!.find((item) =>
          item.name === path)!;
        return {
          remoteId: remote.id,
          lastPath: path,
          contentHash: local.hash,
          size: local.size,
          remoteETag: remote.eTag,
          remoteCTag: remote.cTag,
        };
      });
      const existingBootstrap = JSON.stringify({
        schemaVersion: 2,
        scope,
        revision: 8,
        sourceCommitSeq: 42,
        generatedAt: Date.parse("2026-08-01T00:00:00.000Z"),
        // Device A already committed the 494 equal versions. The one real
        // divergence is also present in the hint, but its current local bytes
        // do not match and must therefore remain a conflict.
        anchors: [
          ...equalBootstrapAnchors,
          {
            remoteId: remoteDifferentDriveId,
            lastPath: differentPath,
            contentHash: remoteDifferentHash,
            size: remoteDifferentSize,
            remoteETag: remoteDifferentETag,
            remoteCTag: remoteDifferentCTag,
          },
        ],
      });
      await harness.cloudBootstrap.create("testVault", existingBootstrap);
      harness.cloudBootstrap.create.mockClear();
      harness.cloudBootstrap.read.mockClear();
      harness.cloudBootstrap.update.mockClear();
      harness.cloudBootstrap.readById.mockClear();
      harness.seedSharedProtocol();

      const equalPathSet = new Set(equalPaths);
      const remoteOnlyPathSet = new Set(remoteOnlyPaths);
      harness.mutations.downloadFile.mockImplementation(async (
        _vaultName: string,
        path: string,
      ) => {
        if (equalPathSet.has(path)) {
          expect(harness.state.isV2StateActive).toBe(false);
        }
        if (remoteOnlyPathSet.has(path)) {
          expect(harness.state.isV2StateActive).toBe(true);
        }
        const content = fixtureInput.remoteFileContents?.[path];
        return content === undefined
          ? new ArrayBuffer(0)
          : new TextEncoder().encode(content).buffer;
      });

      await harness.state.load();
      expect(harness.state.remoteGeneration).toBe(0);
      expect(harness.state.lastSyncTime).toBe(0);
      expect(harness.state.baseSnapshot).toHaveLength(351);
      expect(harness.state.pendingConflicts).toHaveLength(495);
      expect(harness.state.pendingConflicts.every(
        (item) => item.reason === "reason.newFileBothSides"
          && item.contentComparison === undefined,
      )).toBe(true);
      expect(harness.state.planReviewAuthorization).toEqual({
        revision: 4,
        scope,
      });
      const publicRemoteState = JSON.parse(
        harness.files.get(paths.remoteStateFile)!,
      ) as {
        entries: Record<string, unknown>;
        folders: Record<string, unknown>;
      };
      expect(Object.keys(publicRemoteState.entries)).toHaveLength(863);
      expect(Object.keys(publicRemoteState.folders)).toHaveLength(137);

      const preview = await harness.executor.run("manual");

      expect(preview).toMatchObject({
        success: false,
        message: "result.pausedForReview",
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.legacyAutoSyncAllowed).toBe(true);
      expect(harness.state.baseSnapshot).toHaveLength(351);
      expect(harness.state.planReviewAuthorization).toMatchObject({
        revision: expect.any(Number),
        reviewKind: "v2-migration",
        canonicalIdentity: expect.any(Object),
      });
      expect(harness.state.planReviewAuthorization!.revision).toBe(1);
      expect(harness.state.planReviewDigest)
        .not.toBe("public-1.1.3-reinstall-review-digest");
      const heldItems = harness.state.activeV2MigrationHold!.items;
      expect(heldItems.filter((item) => item.type === SyncActionType.Conflict))
        .toEqual([expect.objectContaining({
          path: differentPath,
          reason: "reason.newFileBothSides",
        })]);
      expect(heldItems
        .filter((item) => item.type === SyncActionType.Download)
        .map((item) => item.path)
        .sort()).toEqual([...remoteOnlyPaths].sort());
      expect(heldItems).toHaveLength(remoteOnlyPaths.length + 1);
      expect(heldItems.some((item) => equalPathSet.has(item.path))).toBe(false);
      expect(heldItems.some((item) => folderPaths.includes(item.path))).toBe(false);
      const previewGetPaths = harness.mutations.downloadFile.mock.calls
        .map((call) => call[1]);
      expect(previewGetPaths).toEqual([]);
      expect(plannerView).toHaveBeenCalled();
      const preparedBeforeAuthority =
        new IndexedDbPublic113StateStore(candidateDatabaseName);
      expect(await preparedBeforeAuthority.inspect()).toMatchObject({
        phase: "prepared",
        authority: "inactive",
      });
      await preparedBeforeAuthority.close();

      expect(harness.cloudBootstrap.read).toHaveBeenCalledOnce();
      expect(harness.getCloudBootstrap()!.content).toBe(existingBootstrap);
      expect(harness.cloudBootstrap.create).not.toHaveBeenCalled();
      expect(harness.cloudBootstrap.update).not.toHaveBeenCalled();
      expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
      expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(harness.mutations.renameItem).not.toHaveBeenCalled();
      expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
      expect(harness.client.moveItemById).not.toHaveBeenCalled();
      expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(harness.hostWrites).toEqual([]);
      expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
      expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toBeUndefined();

      const authorization = structuredClone(
        harness.state.planReviewAuthorization!,
      );
      const executed = await harness.executor.run(
        "manual",
        {},
        true,
        authorization,
        { acknowledgeMigrationRisk: true },
      );

      expect(executed).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 17,
        deleted: 0,
        conflicts: 1,
      });
      expect(harness.state.isV2StateActive).toBe(true);
      expect(retireFirstSyncEvidence).toHaveBeenCalledOnce();
      expect(harness.state.legacyAutoSyncAllowed).toBe(false);
      expect(harness.state.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "indexeddb",
        databaseId: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(harness.state.pendingConflicts).toEqual([
        expect.objectContaining({
          type: SyncActionType.Conflict,
          path: differentPath,
          reason: "reason.newFileBothSides",
        }),
      ]);
      expect(harness.state.baseSnapshot).toHaveLength(
        basePaths.length + equalPaths.length + remoteOnlyPaths.length,
      );
      expect(harness.state.baseSnapshot.some(
        (entry) => entry.path === differentPath,
      )).toBe(false);
      expect(remoteOnlyPaths.every((path) =>
        harness.localEntryState.some((entry) => entry.path === path)))
        .toBe(true);
      const allGetPaths = harness.mutations.downloadFile.mock.calls
        .map((call) => call[1]);
      expect(allGetPaths.filter((path) => path === differentPath)).toHaveLength(0);
      expect(allGetPaths.filter((path) => remoteOnlyPathSet.has(path)).sort())
        .toEqual([...remoteOnlyPaths].sort());
      for (const path of equalPaths) {
        expect(allGetPaths.filter((candidate) => candidate === path).length)
          .toBe(0);
      }
      expect(harness.client.readSharedSyncProtocolV2).toHaveBeenCalled();
      expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
      expect(harness.cloudBootstrap.create).not.toHaveBeenCalled();
      expect(JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      )).toMatchObject({
        protocolBinding: {
          protocolVersion: 3,
          migrationGeneration: protocolBinding.migrationGeneration,
          predecessorConfirmedAllDevicesUpdatedAt:
            protocolBinding.confirmedAllDevicesUpdatedAt,
          recordId: "protocol-v3-id",
          recordETag: "protocol-v3-etag",
        },
        storageAuthority: {
          kind: "indexeddb",
          databaseId: expect.stringMatching(/^[a-f0-9]{32}$/),
        },
      });

      const selectedDatabaseId = harness.state
        .activeV2StorageAuthorityEvidence!.databaseId!;
      const selectedStore = activeStores.get(selectedDatabaseId)?.[0];
      expect(selectedStore).toBeDefined();
      expect(await selectedStore!.inspect()).toMatchObject({
        phase: "ready",
        databaseId: selectedDatabaseId,
      });
      const activeEnvelope = await selectedStore!.load();
      await harness.state.close();
      harness.files.set(paths.stateV2File, "{frozen-json-is-not-authority");

      restartedState = new StateManager(harness.plugin);
      await restartedState.load();
      expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
      expect(restartedState.getCommittedV2Envelope()).toEqual(activeEnvelope);
      expect(restartedState.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "indexeddb",
        databaseId: selectedDatabaseId,
      });
      harness.mutations.downloadFile.mockClear();
      harness.mutations.downloadFileToPath.mockClear();
      harness.mutations.uploadFile.mockClear();
      harness.mutations.deleteItem.mockClear();
      harness.mutations.renameItem.mockClear();
      harness.cloudBootstrap.create.mockClear();
      harness.cloudBootstrap.update.mockClear();
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

      const stable = await restartedExecutor.run("manual");

      expect(stable).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 1,
      });
      expect(restartedState.pendingConflicts).toEqual([
        expect.objectContaining({
          path: differentPath,
          reason: "reason.newFileBothSides",
        }),
      ]);
      expect(restartedState.baseSnapshot).toHaveLength(
        basePaths.length + equalPaths.length + remoteOnlyPaths.length,
      );
      expect(harness.files.get(paths.stateV2File))
        .toBe("{frozen-json-is-not-authority");
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(harness.mutations.renameItem).not.toHaveBeenCalled();
      expect(harness.cloudBootstrap.create).not.toHaveBeenCalled();
      expect(harness.client.createSharedSyncProtocolV2).not.toHaveBeenCalled();
    } finally {
      plannerView.mockRestore();
      await restartedState?.close();
      await harness.state.close();
      for (const stores of activeStores.values()) {
        for (const store of stores) await store.close();
        await stores[0]?.delete();
      }
      await new IndexedDbRemoteScopeRecoveryEvidenceStore(
        indexedDbVaultInstanceId,
      ).delete();
      await new IndexedDbPublic113StateStore(candidateDatabaseName).delete();
    }
  }, 30_000);

  it("uses the missing-bootstrap fallback through IndexedDB cutover and cold restart", async () => {
    const candidateDatabaseName =
      `easy-sync-activation:missing-bootstrap:${crypto.randomUUID()}`;
    const indexedDbVaultInstanceId = crypto.randomUUID().replaceAll("-", "");
    const activeStores = new Map<string, StateV2IndexedDbActiveStore[]>();
    const {
      fixtureInput,
      basePaths,
      equalPaths,
      differentPath,
      remoteOnlyPaths,
    } = await public113ReinstalledMixedVersionFixtureInput();
    const harness = makeHarness({
      ...fixtureInput,
      createPublic113IndexedDbCandidateStore: () =>
        new IndexedDbPublic113StateStore(candidateDatabaseName),
      indexedDbVaultInstanceId,
      createStateV2IndexedDbActiveStore: (databaseId, recovery) => {
        const store = new StateV2IndexedDbActiveStore(databaseId, recovery);
        activeStores.set(databaseId, [
          ...(activeStores.get(databaseId) ?? []),
          store,
        ]);
        return store;
      },
    });
    let restartedState: StateManager | null = null;
    try {
      await harness.state.load();
      const preview = await harness.executor.run("manual");

      expect(preview).toMatchObject({
        success: false,
        message: "result.pausedForReview",
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      const previewGetPaths = harness.mutations.downloadFile.mock.calls
        .map((call) => call[1]);
      expect(previewGetPaths).toHaveLength(494);
      expect([...previewGetPaths].sort()).toEqual([...equalPaths].sort());
      expect(harness.cloudBootstrap.read).toHaveBeenCalledOnce();
      expect(harness.client.downloadBaseline).not.toHaveBeenCalled();
      expect(harness.state.activeV2MigrationHold!.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: SyncActionType.Conflict,
            path: differentPath,
          }),
          ...remoteOnlyPaths.map((path) => expect.objectContaining({
            type: SyncActionType.Download,
            path,
          })),
        ]),
      );
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(harness.hostWrites).toEqual([]);
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);

      const authorization = structuredClone(
        harness.state.planReviewAuthorization!,
      );
      const migrated = await harness.executor.run(
        "manual",
        {},
        true,
        authorization,
        { acknowledgeMigrationRisk: true },
      );

      expect(migrated).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: remoteOnlyPaths.length,
        deleted: 0,
        conflicts: 1,
      });
      expect(harness.state.isV2StateActive).toBe(true);
      expect(harness.state.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "indexeddb",
        databaseId: expect.stringMatching(/^[a-f0-9]{32}$/),
      });
      expect(harness.state.baseSnapshot).toHaveLength(
        basePaths.length + equalPaths.length + remoteOnlyPaths.length,
      );
      expect(harness.state.pendingConflicts).toEqual([
        expect.objectContaining({ path: differentPath }),
      ]);
      const allGetPaths = harness.mutations.downloadFile.mock.calls
        .map((call) => call[1]);
      for (const path of equalPaths) {
        expect(allGetPaths.filter((candidate) => candidate === path))
          .toHaveLength(1);
      }
      expect(allGetPaths.filter((path) => remoteOnlyPaths.includes(path)).sort())
        .toEqual([...remoteOnlyPaths].sort());
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();

      const selectedDatabaseId = harness.state
        .activeV2StorageAuthorityEvidence!.databaseId!;
      const selectedStore = activeStores.get(selectedDatabaseId)?.[0];
      expect(selectedStore).toBeDefined();
      const activeEnvelope = await selectedStore!.load();
      await harness.state.close();
      harness.mutations.downloadFile.mockClear();
      harness.mutations.downloadFileToPath.mockClear();
      harness.mutations.uploadFile.mockClear();
      harness.mutations.deleteItem.mockClear();
      harness.mutations.renameItem.mockClear();

      restartedState = new StateManager(harness.plugin);
      await restartedState.load();
      expect(restartedState.getCommittedV2Envelope()).toEqual(activeEnvelope);
      expect(restartedState.activeV2StorageAuthorityEvidence).toMatchObject({
        kind: "indexeddb",
        databaseId: selectedDatabaseId,
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

      const stable = await restartedExecutor.run("manual");

      expect(stable).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 1,
      });
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    } finally {
      await restartedState?.close();
      await harness.state.close();
      for (const stores of activeStores.values()) {
        for (const store of stores) await store.close();
        await stores[0]?.delete();
      }
      await new IndexedDbPublic113StateStore(candidateDatabaseName).delete();
    }
  }, 30_000);

  it("reuses completed missing-bootstrap body verification after an interrupted first-sync preview", async () => {
    const interruptedDatabaseName =
      `easy-sync-activation:interrupted-body-verification:${crypto.randomUUID()}`;
    const controlDatabaseName =
      `easy-sync-activation:control-body-verification:${crypto.randomUUID()}`;
    const fixture = await public113ReinstalledMixedVersionFixtureInput();
    const interruptedHarness = makeHarness({
      ...fixture.fixtureInput,
      createPublic113IndexedDbCandidateStore: () =>
        new IndexedDbPublic113StateStore(interruptedDatabaseName),
    });
    const controlHarness = makeHarness({
      ...fixture.fixtureInput,
      createPublic113IndexedDbCandidateStore: () =>
        new IndexedDbPublic113StateStore(controlDatabaseName),
    });
    const equalPathSet = new Set(fixture.equalPaths);
    const completedBeforeInterruption: string[] = [];
    const stopAfter = 17;
    let restartedState: StateManager | null = null;
    try {
      interruptedHarness.mutations.downloadFile.mockImplementation(async (
        _vaultName: string,
        path: string,
      ) => {
        if (equalPathSet.has(path)) {
          if (completedBeforeInterruption.length >= stopAfter) {
            throw new Error("injected first-sync verification interruption");
          }
          completedBeforeInterruption.push(path);
        }
        const content = fixture.fixtureInput.remoteFileContents?.[path];
        return content === undefined
          ? new ArrayBuffer(0)
          : new TextEncoder().encode(content).buffer;
      });
      await interruptedHarness.state.load();

      const interrupted = await interruptedHarness.executor.run("manual");

      expect(interrupted).toMatchObject({
        success: false,
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(completedBeforeInterruption).toHaveLength(stopAfter);
      expect(interruptedHarness.state.isV2StateActive).toBe(false);
      expect(interruptedHarness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(interruptedHarness.mutations.downloadFileToPath)
        .not.toHaveBeenCalled();
      expect(interruptedHarness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(interruptedHarness.mutations.renameItem).not.toHaveBeenCalled();
      expect(interruptedHarness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(interruptedHarness.hostWrites).toEqual([]);
      expect(interruptedHarness.fileManager.trashFile).not.toHaveBeenCalled();
      expect(interruptedHarness.files.has(paths.stateV2ManifestFile)).toBe(false);

      await interruptedHarness.state.close();
      interruptedHarness.mutations.downloadFile.mockClear();
      interruptedHarness.mutations.downloadFile.mockImplementation(async (
        _vaultName: string,
        path: string,
      ) => {
        const content = fixture.fixtureInput.remoteFileContents?.[path];
        return content === undefined
          ? new ArrayBuffer(0)
          : new TextEncoder().encode(content).buffer;
      });
      restartedState = new StateManager(interruptedHarness.plugin);
      await restartedState.load();
      const restartedExecutor = new SyncExecutor(
        interruptedHarness.client,
        interruptedHarness.scanner,
        restartedState,
        "testVault",
        undefined,
        undefined,
        interruptedHarness.diag as never,
        interruptedHarness.fileManager as never,
      );

      const resumedPreview = await restartedExecutor.run("manual");

      expect(resumedPreview).toMatchObject({
        success: false,
        message: "result.pausedForReview",
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      const resumedGetPaths = interruptedHarness.mutations.downloadFile.mock.calls
        .map((call) => call[1]);
      expect(resumedGetPaths).toHaveLength(
        fixture.equalPaths.length - completedBeforeInterruption.length,
      );
      for (const path of completedBeforeInterruption) {
        expect(resumedGetPaths).not.toContain(path);
      }
      expect([...completedBeforeInterruption, ...resumedGetPaths].sort())
        .toEqual([...fixture.equalPaths].sort());
      expect(interruptedHarness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(interruptedHarness.mutations.downloadFileToPath)
        .not.toHaveBeenCalled();
      expect(interruptedHarness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(interruptedHarness.mutations.renameItem).not.toHaveBeenCalled();
      expect(interruptedHarness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(interruptedHarness.hostWrites).toEqual([]);
      expect(interruptedHarness.fileManager.trashFile).not.toHaveBeenCalled();
      expect(interruptedHarness.files.has(paths.stateV2ManifestFile)).toBe(false);

      controlHarness.mutations.downloadFile.mockImplementation(async (
        _vaultName: string,
        path: string,
      ) => {
        const content = fixture.fixtureInput.remoteFileContents?.[path];
        return content === undefined
          ? new ArrayBuffer(0)
          : new TextEncoder().encode(content).buffer;
      });
      await controlHarness.state.load();
      const controlPreview = await controlHarness.executor.run("manual");
      expect(controlPreview).toMatchObject({
        success: false,
        message: "result.pausedForReview",
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
      });
      expect(restartedState.planReviewAuthorization?.canonicalIdentity?.digest)
        .toBe(controlHarness.state.planReviewAuthorization
          ?.canonicalIdentity?.digest);
      expect(restartedState.activeV2MigrationHold?.items)
        .toEqual(controlHarness.state.activeV2MigrationHold?.items);
      expect(controlHarness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(controlHarness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(controlHarness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(controlHarness.mutations.renameItem).not.toHaveBeenCalled();
      expect(controlHarness.rawAdapter.writeBinary).not.toHaveBeenCalled();
      expect(controlHarness.hostWrites).toEqual([]);
      expect(controlHarness.fileManager.trashFile).not.toHaveBeenCalled();
      expect(controlHarness.files.has(paths.stateV2ManifestFile)).toBe(false);
    } finally {
      await restartedState?.close();
      await interruptedHarness.state.close();
      await controlHarness.state.close();
      await new IndexedDbRemoteScopeRecoveryEvidenceStore(
        interruptedHarness.plugin.indexedDbVaultInstanceId!,
      ).delete();
      await new IndexedDbRemoteScopeRecoveryEvidenceStore(
        controlHarness.plugin.indexedDbVaultInstanceId!,
      ).delete();
      await new IndexedDbPublic113StateStore(interruptedDatabaseName).delete();
      await new IndexedDbPublic113StateStore(controlDatabaseName).delete();
    }
  }, 30_000);

  it("invalidates only a changed remote receipt and rechecks current local hashes", async () => {
    const { fixtureInput, equalPaths, differentPath } =
      await public113ReinstalledMixedVersionFixtureInput({
        baseCount: 1,
        equalCount: 4,
        remoteOnlyCount: 0,
        folderCount: 0,
      });
    const harness = makeHarness(fixtureInput);
    try {
      await harness.state.load();
      expect((await harness.executor.run("manual")).message)
        .toBe("result.pausedForReview");
      expect(harness.mutations.downloadFile.mock.calls.map((call) => call[1]))
        .toEqual(equalPaths);

      const changedRemotePath = equalPaths[0]!;
      const changedRemote = harness.remoteItemState.find((item) =>
        item.name === changedRemotePath)!;
      changedRemote.cTag = `${changedRemote.cTag}-changed`;
      changedRemote.eTag = `${changedRemote.eTag}-changed`;
      harness.mutations.downloadFile.mockClear();

      expect((await harness.executor.run("manual")).message)
        .toBe("result.pausedForReview");
      expect(harness.mutations.downloadFile.mock.calls.map((call) => call[1]))
        .toEqual([changedRemotePath]);

      const eTagOnlyPath = equalPaths[1]!;
      const eTagOnlyRemote = harness.remoteItemState.find((item) =>
        item.name === eTagOnlyPath)!;
      eTagOnlyRemote.eTag = `${eTagOnlyRemote.eTag}-metadata-only`;
      harness.mutations.downloadFile.mockClear();

      expect((await harness.executor.run("manual")).message)
        .toBe("result.pausedForReview");
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();

      const locallyChangedPath = equalPaths[2]!;
      const locallyChanged = harness.localEntryState.find((entry) =>
        entry.path === locallyChangedPath)!;
      const changedBytes = new TextEncoder().encode(
        "x".repeat(locallyChanged.size),
      );
      locallyChanged.hash = await sha256Hex(changedBytes);
      locallyChanged.mtime++;
      harness.mutations.downloadFile.mockClear();

      expect((await harness.executor.run("manual")).message)
        .toBe("result.pausedForReview");
      expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
      expect(harness.state.activeV2MigrationHold!.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: SyncActionType.Conflict,
            path: differentPath,
          }),
          expect.objectContaining({
            type: SyncActionType.Conflict,
            path: locallyChangedPath,
          }),
        ]),
      );
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    } finally {
      await harness.state.close();
      await new IndexedDbRemoteScopeRecoveryEvidenceStore(
        harness.plugin.indexedDbVaultInstanceId!,
      ).delete();
    }
  }, 30_000);

  it("falls back to complete first-sync verification when evidence storage is unavailable", async () => {
    const { fixtureInput, equalPaths } =
      await public113ReinstalledMixedVersionFixtureInput({
        baseCount: 1,
        equalCount: 4,
        remoteOnlyCount: 0,
        folderCount: 0,
      });
    const harness = makeHarness(fixtureInput);
    vi.spyOn(harness.state, "beginFirstSyncVerificationEvidence")
      .mockRejectedValue(new Error("evidence storage unavailable"));
    try {
      await harness.state.load();
      const preview = await harness.executor.run("manual");

      expect(preview.message).toBe("result.pausedForReview");
      expect(harness.mutations.downloadFile.mock.calls.map((call) => call[1]))
        .toEqual(equalPaths);
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
      expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
      expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
      expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    } finally {
      await harness.state.close();
    }
  }, 30_000);

  it("removes disposable first-sync verification evidence during an explicit reset", async () => {
    const { fixtureInput } = await public113ReinstalledMixedVersionFixtureInput({
      baseCount: 1,
      equalCount: 4,
      remoteOnlyCount: 0,
      folderCount: 0,
    });
    const harness = makeHarness(fixtureInput);
    const originalBegin = harness.state.beginFirstSyncVerificationEvidence
      .bind(harness.state);
    let operationId = "";
    vi.spyOn(harness.state, "beginFirstSyncVerificationEvidence")
      .mockImplementation(async (scope, source, protocolBinding, now) => {
        const operation = await originalBegin(
          scope,
          source,
          protocolBinding,
          now,
        );
        operationId = operation.operationId;
        return operation;
      });
    const evidenceStore = new IndexedDbRemoteScopeRecoveryEvidenceStore(
      harness.plugin.indexedDbVaultInstanceId!,
    );
    try {
      await harness.state.load();
      expect((await harness.executor.run("manual")).message)
        .toBe("result.pausedForReview");
      expect(operationId).not.toBe("");
      await expect(evidenceStore.summarize(operationId)).resolves.toMatchObject({
        receipts: 4,
      });
      await evidenceStore.close();

      await harness.state.reset();

      expect((await indexedDB.databases()).map((entry) => entry.name))
        .not.toContain(evidenceStore.databaseName);
      await expect(evidenceStore.summarize(operationId)).resolves.toMatchObject({
        receipts: 0,
      });
    } finally {
      await harness.state.close();
      await evidenceStore.delete();
    }
  }, 30_000);

  it("retries a flaky cloud bootstrap read and keeps the recovered document", async () => {
    const { fixtureInput, equalPaths } =
      await public113ReinstalledMixedVersionFixtureInput({
        baseCount: 1,
        equalCount: 1,
        remoteOnlyCount: 0,
        folderCount: 0,
      });
    const seededPath = equalPaths[0]!;
    const remote = fixtureInput.remoteItems!.find((item) =>
      item.name === seededPath)!;
    const content = fixtureInput.remoteFileContents![seededPath]!;
    const bytes = new TextEncoder().encode(content);
    const bootstrap = JSON.stringify({
      schemaVersion: 2,
      scope,
      revision: 1,
      sourceCommitSeq: 7,
      generatedAt: 1,
      anchors: [{
        remoteId: remote.id,
        lastPath: seededPath,
        contentHash: await sha256Hex(bytes),
        size: bytes.byteLength,
        remoteETag: remote.eTag,
        remoteCTag: remote.cTag,
      }],
    });
    const harness = makeHarness(fixtureInput);
    await harness.cloudBootstrap.create("testVault", bootstrap);
    harness.cloudBootstrap.create.mockClear();
    harness.cloudBootstrap.read
      .mockRejectedValueOnce(
        new OneDriveError(OneDriveErrorType.NetworkError, "slow link"),
      )
      .mockRejectedValueOnce(
        new OneDriveError(OneDriveErrorType.NetworkError, "slow link again"),
      );

    await harness.state.load();
    const preview = await harness.executor.run("manual");

    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.cloudBootstrap.read).toHaveBeenCalledTimes(3);
    expect(harness.diag.log.mock.calls.filter(([category, message]) =>
      category === "state"
      && String(message).startsWith(
        "cloud bootstrap v2 read failed (attempt",
      ),
    )).toHaveLength(2);
    expect(harness.diag.warn.mock.calls.filter(([category, message]) =>
      category === "state"
      && String(message)
        === "V2 cloud bootstrap read failed; falling back to public-1.1.3 legacy baseline",
    )).toHaveLength(0);
  }, 30_000);

});
