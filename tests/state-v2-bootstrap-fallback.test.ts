// 引导回退与公开 1.1.3 权威
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
  it("keeps the legacy fallback path after every cloud bootstrap read retry fails", async () => {
    const { fixtureInput } =
      await public113ReinstalledMixedVersionFixtureInput({
        baseCount: 1,
        equalCount: 1,
        remoteOnlyCount: 0,
        folderCount: 0,
      });
    const harness = makeHarness(fixtureInput);
    harness.cloudBootstrap.read.mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NetworkError, "offline"),
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
        === "V2 cloud bootstrap read failed; continuing with exact public-1.1.3 content verification",
    )).toHaveLength(1);
  }, 30_000);

  it("treats a missing cloud bootstrap document as clean absence without retries", async () => {
    const { fixtureInput } =
      await public113ReinstalledMixedVersionFixtureInput({
        baseCount: 1,
        equalCount: 1,
        remoteOnlyCount: 0,
        folderCount: 0,
      });
    const harness = makeHarness(fixtureInput);
    harness.cloudBootstrap.read.mockRejectedValue(
      new OneDriveError(OneDriveErrorType.NotFound, "gone"),
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
    expect(harness.cloudBootstrap.read).toHaveBeenCalledTimes(1);
    expect(harness.diag.log.mock.calls.filter(([category, message]) =>
      category === "state"
      && String(message) === "no cloud bootstrap v2 document",
    )).toHaveLength(1);
    expect(harness.diag.warn.mock.calls.filter(([category, message]) =>
      category === "state"
      && String(message)
        === "V2 cloud bootstrap read failed; falling back to public-1.1.3 legacy baseline",
    )).toHaveLength(0);
  }, 30_000);

  it("reports candidate drift facts when the migration review source drifts between rounds", async () => {
    const { fixtureInput, equalPaths, differentPath } =
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
    const anchor = {
      remoteId: remote.id,
      lastPath: seededPath,
      contentHash: await sha256Hex(bytes),
      size: bytes.byteLength,
      remoteETag: remote.eTag,
      remoteCTag: remote.cTag,
    };
    const bootstrapA = JSON.stringify({
      schemaVersion: 2,
      scope,
      revision: 1,
      sourceCommitSeq: 7,
      generatedAt: 1,
      anchors: [anchor],
    });
    const bootstrapB = JSON.stringify({
      schemaVersion: 2,
      scope,
      revision: 2,
      sourceCommitSeq: 8,
      generatedAt: 2,
      anchors: [],
    });
    const harness = makeHarness(fixtureInput);
    await harness.cloudBootstrap.create("testVault", bootstrapA);
    harness.cloudBootstrap.create.mockClear();

    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview.message).toBe("result.pausedForReview");
    expect(harness.state.activeV2MigrationHold).not.toBeNull();

    await harness.cloudBootstrap.create("testVault", bootstrapB);
    // The user keeps editing between the review and this confirmation: one
    // reviewed file changes locally without changing its length.
    const editedEntry = harness.localEntryState.find((entry) =>
      entry.path === differentPath)!;
    editedEntry.hash = await sha256Hex(
      new TextEncoder().encode("y".repeat(editedEntry.size)),
    );
    editedEntry.mtime++;
    const drifted = await harness.executor.run(
      "manual",
      {},
      true,
      structuredClone(harness.state.planReviewAuthorization!),
      { acknowledgeMigrationRisk: true },
    );

    expect(drifted).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(false);
    const changedWarn = harness.diag.warn.mock.calls.find(([, message]) =>
      message === "V2 migration review changed before authority commit"
    );
    expect(changedWarn).toBeDefined();
    expect(changedWarn![2]).toMatchObject({
      phase: "activation",
      mutations: 0,
      previousHold: { phase: "pending" },
      drift: {
        sameRemoteIndex: true,
        sameAnchors: false,
      },
      planIdentityUnchanged: false,
    });
    // Item-level layer: the warn detail names the changed file and the exact
    // fact that moved, without ever printing a fact value.
    const itemFacts = changedWarn![2].itemFacts;
    expect(itemFacts).toMatchObject({
      available: true,
      reason: null,
      changed: 1,
      added: 0,
      removed: 0,
      samplesOmitted: 0,
      outsideReviewFields: false,
      samples: [{
        kind: "changed",
        type: SyncActionType.Conflict,
        path: differentPath,
        fields: expect.arrayContaining(["local.hash"]),
      }],
    });
    expect(JSON.stringify(itemFacts)).not.toContain(editedEntry.hash);
    // The re-staged hold reports its own revision next to the round-1 warning.
    expect(changedWarn![2].holdRevision)
      .toBe(harness.state.activeV2MigrationHold!.revision);
  }, 30_000);

  it("uses a partial bootstrap per path and reads only stale or locally changed content", async () => {
    const {
      fixtureInput,
      equalPaths,
      differentPath,
    } = await public113ReinstalledMixedVersionFixtureInput({
      baseCount: 1,
      equalCount: 4,
      remoteOnlyCount: 0,
      folderCount: 0,
    });
    const [seededPath, missingPath, stalePath, offlineEditedPath] =
      equalPaths;
    const offlineLocal = fixtureInput.local!.find((entry) =>
      entry.path === offlineEditedPath)!;
    const offlineContent = "x".repeat(offlineLocal.size);
    offlineLocal.hash = await sha256Hex(
      new TextEncoder().encode(offlineContent),
    );
    offlineLocal.mtime++;
    fixtureInput.initialFiles![offlineEditedPath] = offlineContent;

    const anchorFor = async (
      path: string,
      remoteCTag?: string,
    ) => {
      const remote = fixtureInput.remoteItems!.find((item) =>
        item.name === path)!;
      const remoteContent = fixtureInput.remoteFileContents![path]!;
      const remoteBytes = new TextEncoder().encode(remoteContent);
      return {
        remoteId: remote.id,
        lastPath: path,
        contentHash: await sha256Hex(remoteBytes),
        size: remoteBytes.byteLength,
        remoteETag: remote.eTag,
        remoteCTag: remoteCTag ?? remote.cTag,
      };
    };
    const staleRemote = fixtureInput.remoteItems!.find((item) =>
      item.name === stalePath)!;
    const bootstrap = JSON.stringify({
      schemaVersion: 2,
      scope,
      revision: 3,
      sourceCommitSeq: 42,
      generatedAt: 1,
      anchors: [
        await anchorFor(seededPath),
        await anchorFor(stalePath, `${staleRemote.cTag}-stale`),
        await anchorFor(offlineEditedPath),
      ],
    });
    const harness = makeHarness(fixtureInput);
    await harness.cloudBootstrap.create("testVault", bootstrap);
    harness.cloudBootstrap.create.mockClear();

    await harness.state.load();
    const preview = await harness.executor.run("manual");

    expect(preview.message).toBe("result.pausedForReview");
    expect(harness.mutations.downloadFile.mock.calls
      .map((call) => call[1]).sort()).toEqual(
        [missingPath, stalePath, offlineEditedPath].sort(),
      );
    const conflicts = harness.state.activeV2MigrationHold!.items
      .filter((item) => item.type === SyncActionType.Conflict)
      .map((item) => item.path)
      .sort();
    expect(conflicts).toEqual(
      [differentPath, offlineEditedPath].sort(),
    );
    expect(harness.state.activeV2MigrationHold!.items.some((item) =>
      item.path === seededPath
      || item.path === missingPath
      || item.path === stalePath))
      .toBe(false);
    expect(harness.state.baseSnapshot).toHaveLength(1);
    expect(harness.cloudBootstrap.read).toHaveBeenCalledOnce();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.hostWrites).toEqual([]);
  });

  it("keeps an existing public-1.1.3 base authoritative over a newer bootstrap anchor", async () => {
    const {
      fixtureInput,
      basePaths,
    } = await public113ReinstalledMixedVersionFixtureInput({
      baseCount: 1,
      equalCount: 0,
      remoteOnlyCount: 0,
      folderCount: 0,
    });
    const basePath = basePaths[0]!;
    const originalBase = structuredClone(fixtureInput.base![0]!);
    const currentContent = "shared bytes newer than the public V1 base\n";
    const currentBytes = new TextEncoder().encode(currentContent);
    const currentHash = await sha256Hex(currentBytes);
    const local = fixtureInput.local!.find((entry) => entry.path === basePath)!;
    const remote = fixtureInput.remoteItems!.find((item) => item.name === basePath)!;
    Object.assign(local, {
      size: currentBytes.byteLength,
      mtime: local.mtime + 1,
      hash: currentHash,
    });
    Object.assign(remote, {
      size: currentBytes.byteLength,
      eTag: "etag-base-current",
      cTag: "ctag-base-current",
    });
    fixtureInput.initialFiles![basePath] = currentContent;
    fixtureInput.remoteFileContents![basePath] = currentContent;
    const harness = makeHarness(fixtureInput);
    await harness.cloudBootstrap.create("testVault", JSON.stringify({
      schemaVersion: 2,
      scope,
      revision: 4,
      sourceCommitSeq: 42,
      generatedAt: 1,
      anchors: [{
        remoteId: remote.id,
        lastPath: basePath,
        contentHash: currentHash,
        size: currentBytes.byteLength,
        remoteETag: remote.eTag,
        remoteCTag: remote.cTag,
      }],
    }));
    harness.cloudBootstrap.create.mockClear();

    await harness.state.load();
    const preview = await harness.executor.run("manual");

    expect(preview.message).toBe("result.pausedForReview");
    expect(harness.state.baseSnapshot).toEqual([originalBase]);
    expect(harness.mutations.downloadFile.mock.calls
      .map((call) => call[1])).toEqual([basePath]);
    expect(harness.state.activeV2MigrationHold!.items.some(
      (item) => item.path === basePath,
    )).toBe(false);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.hostWrites).toEqual([]);
  });

  it("falls back to content when bootstrap identity and the current remote projection disagree", async () => {
    const {
      fixtureInput,
      equalPaths,
    } = await public113ReinstalledMixedVersionFixtureInput({
      baseCount: 1,
      equalCount: 1,
      remoteOnlyCount: 0,
      folderCount: 0,
    });
    const path = equalPaths[0]!;
    const local = fixtureInput.local!.find((entry) => entry.path === path)!;
    const remote = fixtureInput.remoteItems!.find((item) => item.name === path)!;
    const bootstrapCTag = "ctag-shared-bootstrap";
    const currentProjectionCTag = "ctag-shared-current";
    let cTagReads = 0;
    Object.defineProperty(remote, "cTag", {
      configurable: true,
      get: () => {
        cTagReads++;
        // A complete identity projection is built first, then the current
        // RemoteFileEntry snapshot is materialized, and the bootstrap verifier
        // independently projects completeRemoteItems. Model the remote version
        // advancing only in the middle snapshot so the final seed recheck must
        // reject the otherwise valid hint.
        return cTagReads === 2 ? currentProjectionCTag : bootstrapCTag;
      },
    });
    const harness = makeHarness(fixtureInput);
    await harness.cloudBootstrap.create("testVault", JSON.stringify({
      schemaVersion: 2,
      scope,
      revision: 5,
      sourceCommitSeq: 42,
      generatedAt: 1,
      anchors: [{
        remoteId: remote.id,
        lastPath: path,
        contentHash: local.hash,
        size: local.size,
        remoteETag: remote.eTag,
        remoteCTag: bootstrapCTag,
      }],
    }));
    harness.cloudBootstrap.create.mockClear();

    await harness.state.load();
    const preview = await harness.executor.run("manual");

    expect(preview.message).toBe("result.pausedForReview");
    expect(cTagReads).toBeGreaterThanOrEqual(3);
    expect(harness.mutations.downloadFile.mock.calls
      .map((call) => call[1])).toEqual([path]);
    expect(harness.state.activeV2MigrationHold!.items.some(
      (item) => item.path === path,
    )).toBe(false);
    expect(harness.state.baseSnapshot).toHaveLength(1);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.hostWrites).toEqual([]);
  });

  it("falls back to every unanchored path when the bootstrap scope is wrong", async () => {
    const {
      fixtureInput,
      equalPaths,
    } = await public113ReinstalledMixedVersionFixtureInput({
      baseCount: 1,
      equalCount: 11,
      remoteOnlyCount: 0,
      folderCount: 0,
    });
    const anchors = equalPaths.map((path) => {
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
    const harness = makeHarness(fixtureInput);
    await harness.cloudBootstrap.create("testVault", JSON.stringify({
      schemaVersion: 2,
      scope: { ...scope, accountId: "other-account" },
      revision: 2,
      sourceCommitSeq: 42,
      generatedAt: 1,
      anchors,
    }));
    harness.cloudBootstrap.create.mockClear();

    await harness.state.load();
    const preview = await harness.executor.run("manual");

    expect(preview.message).toBe("result.pausedForReview");
    const getPaths = harness.mutations.downloadFile.mock.calls
      .map((call) => call[1]);
    expect(getPaths).toHaveLength(equalPaths.length);
    expect([...getPaths].sort()).toEqual([...equalPaths].sort());
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.hostWrites).toEqual([]);
  });

  it("keeps public 1.1.3 authoritative when its source changes during IndexedDB planner preparation", async () => {
    const databaseName =
      `easy-sync-activation:planner-source-drift:${crypto.randomUUID()}`;
    const fixture = public113CleanFixtureInput();
    let harness: ReturnType<typeof makeHarness>;
    let mutateSource = true;
    harness = makeHarness({
      ...fixture,
      createPublic113IndexedDbCandidateStore: () => {
        const store = new IndexedDbPublic113StateStore(databaseName);
        return {
          stageCandidate: store.stageCandidate.bind(store),
          loadPreparedPlannerView: async (sourceStateDigest) => {
            const view = await store.loadPreparedPlannerView(
              sourceStateDigest,
            );
            if (mutateSource) {
              mutateSource = false;
              harness.pluginData["release-1.1.3-planner-drift"] = {
                changedDuringPlannerPreparation: true,
              };
            }
            return view;
          },
          close: store.close.bind(store),
          delete: store.delete.bind(store),
        };
      },
    });
    try {
      await harness.state.load();
      expect(await harness.executor.run("manual")).toMatchObject({
        success: false,
        message: "result.syncFailed",
      });
      expect(harness.state.activeV2MigrationHold).toBeNull();
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.activeV2StorageAuthorityEvidence).toBeNull();
      expect(harness.state.legacyAutoSyncAllowed).toBe(true);
      expect(harness.files.has(paths.stateV2File)).toBe(false);
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
      expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER])
        .toBeUndefined();
      const inspectionStore =
        new IndexedDbPublic113StateStore(databaseName);
      expect(await inspectionStore.inspect())
        .toMatchObject({ phase: "missing" });
      await inspectionStore.close();
      expectNoFileMutations(harness.mutations);
    } finally {
      await new IndexedDbPublic113StateStore(databaseName).delete();
    }
  });

  it("keeps public 1.1.3 authoritative when IndexedDB staging fails and succeeds on retry", async () => {
    const databaseName =
      `easy-sync-activation:retry:${crypto.randomUUID()}`;
    const stageFailure = new Error("IndexedDB staging interrupted");
    const failingStore = {
      stageCandidate: vi.fn(async () => {
        throw stageFailure;
      }),
      close: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const fixture = public113CleanFixtureInput();
    const harness = makeHarness({
      ...fixture,
      createPublic113IndexedDbCandidateStore: () => failingStore,
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
      const authorization = structuredClone(
        harness.state.planReviewAuthorization!,
      );

      const interrupted = await harness.executor.run(
        "manual",
        {},
        true,
        authorization,
        { acknowledgeMigrationRisk: true },
      );
      expect(interrupted).toMatchObject({
        success: false,
        message: "result.syncFailed",
      });
      expect(failingStore.stageCandidate).toHaveBeenCalledOnce();
      expect(failingStore.close).toHaveBeenCalled();
      expect(harness.state.activeV2MigrationHold?.phase)
        .toBe("confirmed");
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.legacyAutoSyncAllowed).toBe(true);
      expect(harness.files.has(paths.stateV2File)).toBe(false);
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
      expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER])
        .toBeUndefined();
      expectNoFileMutations(harness.mutations);

      harness.plugin.createPublic113IndexedDbCandidateStore = () =>
        new IndexedDbPublic113StateStore(databaseName);
      const resumed = await harness.executor.run(
        "manual",
        {},
        true,
        harness.state.planReviewAuthorization!,
      );
      expect(resumed).toMatchObject({
        success: true,
        errors: 0,
      });
      expect(harness.state.isV2StateActive).toBe(true);
      expect(harness.state.legacyAutoSyncAllowed).toBe(false);
      const marker = harness.pluginData[
        KEY_PUBLIC_113_CUTOVER
      ] as { sourceStateDigest: string };
      const prepared = new IndexedDbPublic113StateStore(databaseName);
      await expect(
        prepared.loadPreparedCandidate(marker.sourceStateDigest),
      ).resolves.toEqual(JSON.parse(
        harness.files.get(paths.stateV2File)!,
      ));
      await prepared.close();
      expectNoFileMutations(harness.mutations);
    } finally {
      await new IndexedDbPublic113StateStore(databaseName).delete();
    }
  });

  it("rechecks the public-1.1.3 source after IndexedDB staging before JSON authority cutover", async () => {
    const fixture = public113CleanFixtureInput();
    let harness: ReturnType<typeof makeHarness>;
    const stagingStore = {
      stageCandidate: vi.fn(async () => {
        harness.pluginData["release-1.1.3-unknown-key"] = {
          changedDuringStaging: true,
        };
        return {
          reused: false,
          candidateDigest: "b".repeat(64),
          counts: {
            remoteNodes: 0,
            anchors: 0,
            folderAnchors: 0,
          },
          batches: 0,
        };
      }),
      close: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    harness = makeHarness({
      ...fixture,
      createPublic113IndexedDbCandidateStore: () => stagingStore,
    });
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

    expect(await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    )).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(stagingStore.stageCandidate).toHaveBeenCalledOnce();
    expect(stagingStore.close).toHaveBeenCalled();
    expect(harness.state.activeV2MigrationHold?.phase)
      .toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER])
      .toBeUndefined();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps an exact IndexedDB candidate when a confirmed public-1.1.3 migration is locked by a landed manifest", async () => {
    const databaseName =
      `easy-sync-activation:cancel:${crypto.randomUUID()}`;
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
      const authorization = structuredClone(
        harness.state.planReviewAuthorization!,
      );
      harness.failManifestRenameOnce();

      expect(await harness.executor.run(
        "manual",
        {},
        true,
        authorization,
        { acknowledgeMigrationRisk: true },
      )).toMatchObject({
        success: false,
        message: "result.syncFailed",
      });
      // F31 第十处：真拒绝也被写通道把 manifest 落面——中断轮已把 V2
      // 落门（manifest 在场、内存在保守块、hold 保持 confirmed 恢复）。
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.legacyAutoSyncAllowed).toBe(false);
      expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
      expect((await indexedDB.databases()).some(
        (entry) => entry.name === databaseName,
      )).toBe(true);

      // 已落门的 V2 不可取消：clearPlanReview 返回 false，候选保留给恢复。
      await expect(
        harness.state.clearPlanReview(
          harness.state.planReviewAuthorization!,
        ),
      ).resolves.toBe(false);
      expect((await indexedDB.databases()).some(
        (entry) => entry.name === databaseName,
      )).toBe(true);
      expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.legacyAutoSyncAllowed).toBe(false);
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
      expectNoFileMutations(harness.mutations);
    } finally {
      await new IndexedDbPublic113StateStore(databaseName).delete();
    }
  });

  it("reuses a public-1.1.3 version anchor during V2 cutover without downloading QuickXor-only content", async () => {
    const path = "note.md";
    const content = "same reset content";
    const bytes = new TextEncoder().encode(content);
    const hash = await sha256Hex(bytes);
    const quickXorHash = "Y0BDGthABgAAAAAABQAAAAAAAAA=";
    const remoteETag = "etag-bound-version";
    const harness = makeHarness({
      base: [],
      local: [{
        path,
        size: bytes.byteLength,
        mtime: 1,
        hash,
        quickXorHash,
        binary: false,
      }],
      localFolders: [],
      remoteItems: [{
        id: "note-id",
        name: path,
        size: bytes.byteLength,
        eTag: remoteETag,
        cTag: "ctag-content-version",
        parentReference: { id: scope.filesRootId },
        file: { hashes: { quickXorHash } },
      }],
      initialFiles: { [path]: content },
    });
    vi.mocked(harness.client.downloadBaseline).mockResolvedValue(JSON.stringify({
      vaultName: "testVault",
      lastSyncAt: 1,
      files: {
        [path]: {
          hash,
          size: bytes.byteLength,
          eTag: remoteETag,
          mtime: 0,
        },
      },
    }));
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
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

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
      conflicts: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.baseSnapshot).toContainEqual({
      path,
      hash,
      size: bytes.byteLength,
      eTag: remoteETag,
    });
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

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
    expect(restartedState.baseSnapshot).toEqual(harness.state.baseSnapshot);
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("clears an ordinary V2 review only after the exact canonical plan revalidates", async () => {
    const harness = makeHarness();
    const { authorization } =
      await stageOrdinaryV2Review(harness);
    const clearPlanReview = vi.spyOn(
      harness.state,
      "clearPlanReview",
    );

    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );

    expect(executed).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(clearPlanReview).toHaveBeenCalledWith(authorization);
    expect(harness.state.planReviewActive).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("executes an ordinary V2 review when a non-empty delta replay only advances the cursor", async () => {
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

    let cursorRevision = 0;
    harness.getDelta.mockImplementation(async () => ({
      // Graph may replay the just-observed item and parent notifications even
      // though the committed identity tree already contains those facts.
      value: [...harness.remoteItemState],
      "@odata.deltaLink":
        `https://graph.example/replayed-cursor-${++cursorRevision}`,
    }));
    harness.getDelta.mockClear();

    let reviewedPlan: SyncPlan | null = null;
    const publishReview = vi.fn(async (candidate: SyncPlan) => {
      reviewedPlan = candidate;
      await harness.state.setPlanReviewBundle(
        candidate.items,
        candidate.canonicalReview!.counts,
        candidate.scope!,
        candidate.canonicalIdentity,
      );
      return false;
    });
    const preview = await harness.executor.run(
      "first",
      { onFirstSyncPreview: publishReview },
    );

    expect(preview.message).toBe("result.pausedForReview");
    expect(reviewedPlan).toMatchObject({
      canonicalIdentity: expect.any(Object),
      items: [],
    });
    const authorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    const reviewedCommitSeq =
      authorization.canonicalIdentity!.sourceCommitSeq;
    expect(harness.state.getCommittedV2Envelope()?.meta.commitSeq)
      .toBe(reviewedCommitSeq);
    expect(harness.state.remoteDeltaLink)
      .toBe("https://graph.example/replayed-cursor-1");

    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
    );

    expect(executed).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    });
    expect(harness.state.planReviewActive).toBe(false);
    expect(harness.state.getCommittedV2Envelope()?.meta.commitSeq)
      .toBe(reviewedCommitSeq);
    expect(harness.state.remoteDeltaLink)
      .toBe("https://graph.example/replayed-cursor-1");
    expect(harness.getDelta).toHaveBeenCalledTimes(2);
    expectNoFileMutations(harness.mutations);
  });

  it("executes a reviewed plugin restore when a complete identity scan is projection-identical", async () => {
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

    let cursorRevision = 0;
    harness.getDelta.mockImplementation(async () => ({
      value: [...harness.remoteItemState],
      "@odata.deltaLink":
        `https://graph.example/complete-review-${++cursorRevision}`,
    }));
    harness.getDelta.mockClear();
    const forceCompleteIdentityAuthorization = {
      pluginId: "reviewed-restore",
      operationId: "join-reviewed-restore",
      targetCatalogRevision: 1,
      targetBundleDigest: "b".repeat(64),
      scope,
      members: [],
    };

    let reviewedPlan: SyncPlan | null = null;
    const publishReview = vi.fn(async (candidate: SyncPlan) => {
      reviewedPlan = candidate;
      await harness.state.setPlanReviewBundle(
        candidate.items,
        candidate.canonicalReview!.counts,
        candidate.scope!,
        candidate.canonicalIdentity,
      );
      return false;
    });
    const preview = await harness.executor.run(
      "first",
      { onFirstSyncPreview: publishReview },
      false,
      undefined,
      {
        communityPluginJoinAuthorizations: [
          forceCompleteIdentityAuthorization,
        ],
      },
    );

    expect(preview.message).toBe("result.pausedForReview");
    expect(reviewedPlan).toMatchObject({
      canonicalIdentity: expect.any(Object),
      items: [],
    });
    const authorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    const reviewedCommitSeq =
      authorization.canonicalIdentity!.sourceCommitSeq;
    expect(harness.state.getCommittedV2Envelope()?.meta.commitSeq)
      .toBe(reviewedCommitSeq);

    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
      {
        communityPluginJoinAuthorizations: [
          forceCompleteIdentityAuthorization,
        ],
      },
    );

    expect(executed).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    });
    expect(harness.state.planReviewActive).toBe(false);
    expect(harness.state.getCommittedV2Envelope()?.meta.commitSeq)
      .toBe(reviewedCommitSeq);
    expect(harness.getDelta).toHaveBeenCalledTimes(2);
    expectNoFileMutations(harness.mutations);
  });

  it("re-pauses an ordinary V2 review when its revision is stale", async () => {
    const harness = makeHarness();
    const { authorization, plan } =
      await stageOrdinaryV2Review(harness);
    await harness.state.setPlanReviewBundle(
      plan.items,
      plan.canonicalReview!.counts,
      plan.scope!,
      plan.canonicalIdentity,
    );
    expect(harness.state.planReviewRevision)
      .toBeGreaterThan(authorization.revision);
    const clearPlanReview = vi.spyOn(
      harness.state,
      "clearPlanReview",
    );
    const publishReplacement = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: publishReplacement },
      true,
      authorization,
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(publishReplacement).toHaveBeenCalledOnce();
    expect(clearPlanReview).not.toHaveBeenCalled();
    expect(harness.state.planReviewActive).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("re-pauses an ordinary V2 review when its scope is stale", async () => {
    const harness = makeHarness();
    const { authorization } =
      await stageOrdinaryV2Review(harness);
    const staleAuthorization: PlanReviewAuthorization = {
      ...authorization,
      scope: {
        ...authorization.scope,
        driveId: "stale-drive",
      },
    };
    const clearPlanReview = vi.spyOn(
      harness.state,
      "clearPlanReview",
    );
    const publishReplacement = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: publishReplacement },
      true,
      staleAuthorization,
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(publishReplacement).toHaveBeenCalledOnce();
    expect(clearPlanReview).not.toHaveBeenCalled();
    expect(harness.state.planReviewActive).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("re-pauses an ordinary V2 review when the canonical digest changed", async () => {
    const harness = makeHarness();
    const { authorization } =
      await stageOrdinaryV2Review(harness);
    harness.localEntryState.push({
      path: "Notes/new-after-review.md",
      size: 4,
      mtime: 1,
      hash: "d".repeat(64),
      binary: false,
    });
    const clearPlanReview = vi.spyOn(
      harness.state,
      "clearPlanReview",
    );
    const publishReplacement = vi.fn().mockResolvedValue(false);

    const result = await harness.executor.run(
      "manual",
      { onConfirmThreshold: publishReplacement },
      true,
      authorization,
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(publishReplacement).toHaveBeenCalledOnce();
    const replacement = publishReplacement.mock.calls[0]![0] as SyncPlan;
    expect(replacement.canonicalIdentity?.digest).not.toBe(
      authorization.canonicalIdentity?.digest,
    );
    expect(clearPlanReview).not.toHaveBeenCalled();
    expect(harness.state.planReviewActive).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("cancels an exact public-1.1.3 pending migration without protocol creation or cutover", async () => {
    const fixtureInput = public113CleanFixtureInput();
    const originalRemoteState =
      fixtureInput.initialFiles![paths.remoteStateFile];
    const originalBaseContent =
      fixtureInput.initialFiles![paths.baseContentFile];
    const originalScanCache =
      fixtureInput.initialFiles![paths.scanCacheFile];
    const harness = makeHarness(fixtureInput);
    await harness.state.load();

    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    const cancelledAuthorization =
      structuredClone(harness.state.planReviewAuthorization!);
    expect(cancelledAuthorization).toMatchObject({
      reviewKind: "v2-migration",
      canonicalIdentity: expect.any(Object),
    });
    expect(harness.state.activeV2MigrationHold?.phase).toBe("pending");

    await expect(harness.state.clearPlanReview(cancelledAuthorization))
      .resolves.toBe(true);

    expect(harness.state.planReviewActive).toBe(false);
    expect(harness.state.planReviewAuthorization).toBeNull();
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(true);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(false);
    expect(harness.files.get(paths.remoteStateFile))
      .toBe(originalRemoteState);
    expect(harness.files.get(paths.baseContentFile))
      .toBe(originalBaseContent);
    expect(harness.files.get(paths.scanCacheFile))
      .toBe(originalScanCache);
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    // The production LocalScanner excludes EasySync's internal directories.
    // This broad test double exposes Adapter-created ancestor-store folders.
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
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
    const represented = await restartedExecutor.run("manual");
    expect(represented).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(restartedState.planReviewAuthorization).toMatchObject({
      reviewKind: "v2-migration",
      canonicalIdentity: cancelledAuthorization.canonicalIdentity,
    });
    expect(restartedState.planReviewAuthorization?.revision)
      .toBeGreaterThan(cancelledAuthorization.revision);
    expect(restartedState.isV2StateActive).toBe(false);
    expect(restartedState.legacyAutoSyncAllowed).toBe(true);
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("discards the public-1.1.3 cursor read-only and cold-starts on a fresh V2 cursor", async () => {
    const fixtureInput = public113CleanFixtureInput();
    const originalRemoteState =
      fixtureInput.initialFiles![paths.remoteStateFile];
    const expiredCursor = (
      JSON.parse(originalRemoteState) as { deltaLink: string }
    ).deltaLink;
    const harness = makeHarness(fixtureInput);
    harness.getDelta.mockImplementation(async (
      _vaultName: string,
      deltaLink?: string,
    ) => {
      if (deltaLink === expiredCursor) {
        throw new OneDriveError(
          OneDriveErrorType.Unknown,
          "public 1.1.3 delta token expired",
          410,
        );
      }
      return {
        value: [...harness.remoteItemState],
        "@odata.deltaLink": "https://graph.example/v2-migration-rebuilt",
      };
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
    expect(harness.getDelta.mock.calls.map((call) => call[1]))
      .toEqual([undefined]);
    expect(harness.files.get(paths.remoteStateFile))
      .toBe(originalRemoteState);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

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
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.remoteDeltaLink).toBeNull();
    expect(harness.getDelta.mock.calls.map((call) => call[1]))
      .toEqual([undefined, undefined]);

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
    expect(harness.getDelta.mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(restartedState.remoteDeltaLink)
      .toBe("https://graph.example/v2-migration-rebuilt");
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
  });

  it("uploads one public-1.1.3 local edit only after V2 authority and cold-starts stable", async () => {
    const candidateDatabaseName =
      `easy-sync-activation:public-active:${crypto.randomUUID()}`;
    const activeStores = new Map<string, StateV2IndexedDbActiveStore[]>();
    const fixtureInput = public113CleanFixtureInput();
    const originalLocal = fixtureInput.local![0];
    const changedContent = "public fixture local edit\n";
    const changedBytes = new TextEncoder().encode(changedContent);
    const changedHash = await sha256Hex(changedBytes);
    fixtureInput.local = [{
      ...originalLocal,
      size: changedBytes.byteLength,
      mtime: originalLocal.mtime + 1,
      hash: changedHash,
    }];
    fixtureInput.initialFiles = {
      ...fixtureInput.initialFiles,
      [originalLocal.path]: changedContent,
    };
    const harness = makeHarness({
      ...fixtureInput,
      createPublic113IndexedDbCandidateStore: () =>
        new IndexedDbPublic113StateStore(candidateDatabaseName),
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
      harness.mutations.uploadFile.mockImplementationOnce(async () => {
        expect(harness.state.isV2StateActive).toBe(true);
        expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
        const remote = findRemoteItemByPath(
          harness.remoteItemState,
          originalLocal.path,
        )!;
        remote.size = changedBytes.byteLength;
        remote.file = { hashes: { sha256Hash: changedHash } };
        remote.eTag = "etag-public-local-edit-v2";
        remote.cTag = "ctag-public-local-edit-v2";
        return {
          ...remote,
          parentReference: { ...remote.parentReference },
        };
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
      expect(harness.state.planReviewAuthorization).toMatchObject({
        reviewKind: "v2-migration",
        canonicalIdentity: expect.any(Object),
      });
      expect(harness.state.isV2StateActive).toBe(false);
      expect(harness.state.legacyAutoSyncAllowed).toBe(true);
      expect(harness.mutations.uploadFile).not.toHaveBeenCalled();

      for (const folder of [...harness.localFolderPaths]) {
        if (folder.startsWith(".obsidian")) {
          harness.localFolderPaths.delete(folder);
        }
      }
      const executed = await harness.executor.run(
        "manual",
        {},
        true,
        harness.state.planReviewAuthorization!,
        { acknowledgeMigrationRisk: true },
      );
      expect(executed).toMatchObject({
        success: true,
        errors: 0,
        uploaded: 1,
        downloaded: 0,
        deleted: 0,
      });
      expect(harness.state.isV2StateActive).toBe(true);
      expect(harness.state.legacyAutoSyncAllowed).toBe(false);
      expect(harness.state.mutationLedger).toEqual([]);
      expect(harness.state.baseSnapshot).toContainEqual({
        path: originalLocal.path,
        hash: changedHash,
        size: changedBytes.byteLength,
        eTag: "etag-public-local-edit-v2",
      });
      expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();

      const marker = harness.pluginData[KEY_PUBLIC_113_CUTOVER] as {
        sourceStateDigest: string;
      };
      const frozenJsonBytes = harness.files.get(paths.stateV2File)!;
      const frozenJson = JSON.parse(frozenJsonBytes) as SyncStateEnvelopeV2;
      const staged = new IndexedDbPublic113StateStore(candidateDatabaseName);
      expect(await staged.inspect()).toMatchObject({
        phase: "prepared",
        authority: "inactive",
        sourceStateDigest: marker.sourceStateDigest,
      });
      expect(await staged.loadPreparedCandidate(marker.sourceStateDigest))
        .toEqual(frozenJson);
      await staged.close();

      const witness = JSON.parse(
        harness.files.get(paths.stateV2AuthorityWitnessFile)!,
      ) as {
        storageAuthority?: {
          kind: string;
          databaseId: string;
          stateCommitSeq: number;
          stateDigest: string;
        };
      };
      expect(witness.storageAuthority).toMatchObject({
        kind: "indexeddb",
        databaseId: expect.stringMatching(/^[a-f0-9]{32}$/),
        stateCommitSeq: expect.any(Number),
        stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const selectedDatabaseId = witness.storageAuthority!.databaseId;
      const selectedStore = activeStores.get(selectedDatabaseId)?.[0];
      expect(selectedStore).toBeDefined();
      const activeEnvelope = await selectedStore!.load();
      expect(activeEnvelope).toEqual(harness.state.getCommittedV2Envelope());
      expect(harness.state.activeV2StorageAuthorityEvidence).toEqual({
        kind: "indexeddb",
        databaseId: selectedDatabaseId,
        stateCommitSeq: activeEnvelope.meta.commitSeq,
        contentFactCommitSeq: activeEnvelope.meta.commitSeq,
        lifecycleEpoch: activeEnvelope.meta.lifecycleEpoch,
      });
      expect(activeEnvelope.meta.commitSeq)
        .toBeGreaterThan(frozenJson.meta.commitSeq);
      expect(await selectedStore!.inspect()).toEqual({
        phase: "ready",
        databaseId: selectedDatabaseId,
        commitSeq: activeEnvelope.meta.commitSeq,
        lifecycleEpoch: activeEnvelope.meta.lifecycleEpoch,
        stateDigest: await stateV2IndexedDbRecoveryEnvelopeDigest(
          activeEnvelope,
        ),
        counts: {
          remoteNodes: Object.keys(activeEnvelope.remoteIndex.itemsById).length,
          anchors: Object.keys(activeEnvelope.anchors.byAnchorId).length,
          folderAnchors: Object.keys(
            activeEnvelope.folderAnchors?.byAnchorId ?? {},
          ).length,
        },
      });
      expect(harness.files.get(paths.stateV2File)).toBe(frozenJsonBytes);

      await harness.state.close();
      harness.files.set(paths.stateV2File, "{frozen-json-is-not-authority");
      restartedState = new StateManager(harness.plugin);
      await restartedState.load();
      expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
      expect(restartedState.getCommittedV2Envelope()).toEqual(activeEnvelope);
      expect(restartedState.activeV2StorageAuthorityEvidence).toEqual({
        kind: "indexeddb",
        databaseId: selectedDatabaseId,
        stateCommitSeq: activeEnvelope.meta.commitSeq,
        contentFactCommitSeq: activeEnvelope.meta.commitSeq,
        lifecycleEpoch: activeEnvelope.meta.lifecycleEpoch,
      });
      // Match the production LocalScanner, which excludes EasySync's own
      // adapter-created recovery directories from the user sync plan.
      for (const folder of [...harness.localFolderPaths]) {
        if (folder.startsWith(".obsidian")) {
          harness.localFolderPaths.delete(folder);
        }
      }
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
      expect(restartedState.mutationLedger).toEqual([]);
      expect(restartedState.baseSnapshot).toContainEqual({
        path: originalLocal.path,
        hash: changedHash,
        size: changedBytes.byteLength,
        eTag: "etag-public-local-edit-v2",
      });
      expect(restartedState.getCommittedV2Envelope()!.meta.commitSeq)
        .toBeGreaterThanOrEqual(activeEnvelope.meta.commitSeq);
      expect(harness.files.get(paths.stateV2File))
        .toBe("{frozen-json-is-not-authority");
      expect(harness.mutations.uploadFile).toHaveBeenCalledOnce();
    } finally {
      await restartedState?.close();
      await harness.state.close();
      for (const stores of activeStores.values()) {
        for (const store of stores) await store.close();
        await stores[0]?.delete();
      }
      await new IndexedDbPublic113StateStore(candidateDatabaseName).delete();
    }
  });

  it("downloads one public-1.1.3 remote edit only after V2 authority and cold-starts stable", async () => {
    const fixtureInput = public113CleanFixtureInput();
    const stablePath = fixtureInput.local![0].path;
    const originalContent = "release-1.1.3 stable baseline\n";
    const changedContent = "release-1.1.3 remote edit\n";
    const changedBytes = new TextEncoder().encode(changedContent);
    const changedHash = await sha256Hex(changedBytes);
    fixtureInput.initialFiles = {
      ...fixtureInput.initialFiles,
      [stablePath]: originalContent,
    };
    const remoteFile = fixtureInput.remoteItems!.find(
      (item) => item.id === "fixture-file-stable",
    )!;
    remoteFile.size = changedBytes.byteLength;
    remoteFile.file = { hashes: { sha256Hash: changedHash } };
    remoteFile.lastModifiedDateTime =
      new Date("2026-07-27T03:30:00.000Z").toISOString();
    remoteFile.eTag = "etag-public-remote-edit-v2";
    remoteFile.cTag = "ctag-public-remote-edit-v2";
    fixtureInput.remoteFileContents = {
      [stablePath]: changedContent,
    };

    const harness = makeHarness(fixtureInput);
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
      canonicalIdentity: expect.any(Object),
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.get(stablePath)).toBe(originalContent);
    expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.hostWrites).toEqual([]);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();

    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(executed).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
      conflicts: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toContainEqual({
      path: stablePath,
      hash: changedHash,
      size: changedBytes.byteLength,
      eTag: "etag-public-remote-edit-v2",
    });
    expect(harness.files.get(stablePath)).toBe(changedContent);
    expect(harness.localEntryState).toContainEqual(
      expect.objectContaining({
        path: stablePath,
        hash: changedHash,
        size: changedBytes.byteLength,
        binary: false,
      }),
    );
    // 宿主看得见的文件由宿主写入面原地替换（F12）；适配器只写暂存文件与留底副本，
    // 目标路径上不该出现适配器直写——旧的名字交换就是从这里消失的。
    expect(harness.hostWrites).toEqual([changedContent]);
    expect(
      harness.rawAdapter.writeBinary.mock.calls.filter(([path]) => path === stablePath),
    ).toEqual([]);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();

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
    expect(restartedState.mutationLedger).toEqual([]);
    expect(harness.files.get(stablePath)).toBe(changedContent);
    // 冷启动后的这一轮没有重写任何内容：宿主写入面仍只有切换轮那一次记录。
    expect(harness.hostWrites).toEqual([changedContent]);
  });

  it("preserves an exact public-1.1.3 overlapping edit conflict across V2 cutover and cold restart", async () => {
    const fixtureInput = public113CleanFixtureInput();
    const stablePath = fixtureInput.local![0].path;
    const localContent = "release-1.1.3 local version\n";
    const remoteContent = "release-1.1.3 remote version\n";
    const localBytes = new TextEncoder().encode(localContent);
    const remoteBytes = new TextEncoder().encode(remoteContent);
    const localHash = await sha256Hex(localBytes);
    const remoteHash = await sha256Hex(remoteBytes);
    fixtureInput.local = [{
      ...fixtureInput.local![0],
      size: localBytes.byteLength,
      mtime: fixtureInput.local![0].mtime + 1,
      hash: localHash,
    }];
    fixtureInput.initialFiles = {
      ...fixtureInput.initialFiles,
      [stablePath]: localContent,
    };
    const remoteFile = fixtureInput.remoteItems!.find(
      (item) => item.id === "fixture-file-stable",
    )!;
    remoteFile.size = remoteBytes.byteLength;
    remoteFile.file = { hashes: { sha256Hash: remoteHash } };
    remoteFile.lastModifiedDateTime =
      new Date("2026-07-27T04:00:00.000Z").toISOString();
    remoteFile.eTag = "etag-public-overlap-remote-v2";
    remoteFile.cTag = "ctag-public-overlap-remote-v2";
    fixtureInput.remoteFileContents = {
      [stablePath]: remoteContent,
    };

    const harness = makeHarness(fixtureInput);
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
      canonicalIdentity: expect.any(Object),
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.get(stablePath)).toBe(localContent);
    expect(findRemoteItemByPath(
      harness.remoteItemState,
      stablePath,
    )?.eTag).toBe("etag-public-overlap-remote-v2");
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();

    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(executed).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 1,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.pendingConflicts).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: stablePath,
        reason: "reason.bothSidesModified",
        textMergeEvidence: expect.objectContaining({
          version: 1,
          algorithm: "conservative-line-merge-v1",
          result: "manual",
          reason: "overlap",
          localHash,
          remoteDriveId: "fixture-file-stable",
          remoteETag: "etag-public-overlap-remote-v2",
          remoteHash,
        }),
        decisionToken: expect.objectContaining({
          local: expect.objectContaining({
            exists: true,
            hash: localHash,
          }),
          remote: expect.objectContaining({
            exists: true,
            eTag: "etag-public-overlap-remote-v2",
          }),
        }),
      }),
    ]);
    expect(harness.files.get(stablePath)).toBe(localContent);
    expect(findRemoteItemByPath(
      harness.remoteItemState,
      stablePath,
    )?.eTag).toBe("etag-public-overlap-remote-v2");
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(1);

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
      conflicts: 1,
    });
    expect(restartedState.pendingConflicts).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: stablePath,
        reason: "reason.bothSidesModified",
        textMergeEvidence: expect.objectContaining({
          version: 1,
          algorithm: "conservative-line-merge-v1",
          result: "manual",
          reason: "overlap",
          localHash,
          remoteDriveId: "fixture-file-stable",
          remoteETag: "etag-public-overlap-remote-v2",
          remoteHash,
        }),
      }),
    ]);
    expect(harness.files.get(stablePath)).toBe(localContent);
    expect(findRemoteItemByPath(
      harness.remoteItemState,
      stablePath,
    )?.eTag).toBe("etag-public-overlap-remote-v2");
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("uses an exact public pending conflict when its remote-state advanced past the base", async () => {
    const fixtureInput = public113CleanFixtureInput();
    const base = fixtureInput.base![0]!;
    const stablePath = base.path;
    const localContent = "public pending conflict local version\n";
    const remoteContent = "public pending conflict remote version\n";
    const localBytes = new TextEncoder().encode(localContent);
    const remoteBytes = new TextEncoder().encode(remoteContent);
    const localHash = await sha256Hex(localBytes);
    const remoteHash = await sha256Hex(remoteBytes);
    const remoteFile = fixtureInput.remoteItems!.find(
      (item) => item.file,
    )!;
    remoteFile.size = remoteBytes.byteLength;
    remoteFile.file = { hashes: { sha256Hash: remoteHash } };
    remoteFile.lastModifiedDateTime =
      new Date("2026-07-28T06:00:00.000Z").toISOString();
    remoteFile.eTag = "etag-public-pending-current";
    remoteFile.cTag = "ctag-public-pending-current";
    fixtureInput.local = [{
      path: stablePath,
      size: localBytes.byteLength,
      mtime: 2,
      hash: localHash,
      binary: false,
    }];
    fixtureInput.initialFiles![stablePath] = localContent;
    fixtureInput.remoteFileContents = {
      [stablePath]: remoteContent,
    };

    const remoteState = JSON.parse(
      fixtureInput.initialFiles![paths.remoteStateFile]!,
    ) as {
      entries: Record<string, {
        path: string;
        driveId: string;
        parentId: string;
        size: number;
        mtime: number;
        eTag: string;
        cTag: string;
        sha256Hash?: string;
      }>;
    };
    remoteState.entries[stablePath] = {
      ...remoteState.entries[stablePath]!,
      size: remoteBytes.byteLength,
      mtime: Date.parse(remoteFile.lastModifiedDateTime!),
      eTag: remoteFile.eTag!,
      cTag: remoteFile.cTag!,
      sha256Hash: remoteHash,
    };
    fixtureInput.initialFiles![paths.remoteStateFile] =
      JSON.stringify(remoteState);
    const pendingConflict = {
      type: SyncActionType.Conflict,
      path: stablePath,
      local: fixtureInput.local[0],
      remote: {
        path: stablePath,
        driveId: remoteFile.id,
        parentId: remoteFile.parentReference!.id!,
        size: remoteBytes.byteLength,
        mtime: Date.parse(remoteFile.lastModifiedDateTime!),
        eTag: remoteFile.eTag!,
        cTag: remoteFile.cTag!,
        sha256Hash: remoteHash,
      },
      reason: "reason.bothSidesModified",
      decisionToken: {
        version: 1,
        vaultName: "testVault",
        accountId: scope.accountId,
        scope: { ...scope },
        local: {
          exists: true,
          hash: localHash,
          size: localBytes.byteLength,
        },
        remote: {
          exists: true,
          driveId: remoteFile.id,
          eTag: remoteFile.eTag!,
        },
        ancestorHash: base.hash,
      },
    };
    fixtureInput.pluginData!["easy-sync-pending-conflicts"] = [
      pendingConflict,
    ];

    const harness = makeHarness(fixtureInput);
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.planReviewAuthorization).toMatchObject({
      reviewKind: "v2-migration",
      canonicalIdentity: expect.any(Object),
    });
    expect(harness.state.activeV2MigrationHold?.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Conflict,
        path: stablePath,
        remoteETag: remoteFile.eTag,
      }),
    ]);
    expect(
      harness.state.activeV2MigrationHold?.candidate
        .anchors.byAnchorId[`migrated:${remoteFile.id}`],
    ).toMatchObject({
      remoteId: remoteFile.id,
      lastPath: stablePath,
      contentHash: base.hash,
    });
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    expect(harness.files.get(stablePath)).toBe(localContent);
  });

  it("creates one public-1.1.3 local-only folder only after V2 authority and cold-starts stable", async () => {
    const fixtureInput = public113CleanFixtureInput();
    fixtureInput.localFolders = [
      ...(fixtureInput.localFolders ?? []),
      { path: "notes/empty" },
    ];
    const harness = makeHarness(fixtureInput);
    harness.client.createFolderByParentId.mockImplementationOnce(async (
      parentDriveItemId: string,
      name: string,
    ) => {
      expect(harness.state.isV2StateActive).toBe(true);
      expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
      const created: DriveItem = {
        id: "fixture-created-empty-v2",
        name,
        folder: {},
        parentReference: { id: parentDriveItemId },
        eTag: "etag-fixture-created-empty-v2",
      };
      harness.remoteItemState.push(created);
      return created;
    });
    await harness.state.load();

    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      foldersCreated: 0,
    });
    expect(harness.state.planReviewAuthorization).toMatchObject({
      reviewKind: "v2-migration",
      canonicalIdentity: expect.any(Object),
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();

    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(executed).toMatchObject({
      success: true,
      errors: 0,
      foldersCreated: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(findRemoteItemByPath(
      harness.remoteItemState,
      "notes/empty",
    )?.id).toBe("fixture-created-empty-v2");
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();

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
      foldersCreated: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.mutationLedger).toEqual([]);
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
  });

  it("commits the exact folder version read back after OneDrive advances the create response eTag", async () => {
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
    harness.client.createFolderByParentId.mockImplementationOnce(async (
      parentDriveItemId: string,
      name: string,
    ) => {
      const live: DriveItem = {
        id: "created-empty-version-advanced",
        name,
        folder: {},
        parentReference: { id: parentDriveItemId },
        eTag: "etag-created-live-readback",
      };
      harness.remoteItemState.push(live);
      return {
        ...live,
        eTag: "etag-created-response",
      };
    });

    const created = await harness.executor.run("manual");

    expect(created).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
      deferred: 0,
    });
    expect(harness.client.createFolderByParentId).toHaveBeenCalledOnce();
    expect(harness.client.getDriveItemMetadataById)
      .toHaveBeenCalledWith("created-empty-version-advanced");
    expect(
      harness.state.getCommittedV2Envelope()!.remoteIndex
        .itemsById["created-empty-version-advanced"],
    ).toMatchObject({
      kind: "folder",
      eTag: "etag-created-live-readback",
    });
    expect(
      Object.values(
        harness.state.getCommittedV2Envelope()!.folderAnchors!.byAnchorId,
      ),
    ).toContainEqual(expect.objectContaining({
      remoteId: "created-empty-version-advanced",
      lastPath: "Empty",
      remoteETag: "etag-created-live-readback",
    }));
    expect(harness.state.mutationLedger).toEqual([]);
  });

  it("resumes an exact public-1.1.3 confirmed hold after a pre-manifest crash", async () => {
    const harness = makeHarness(public113CleanFixtureInput());
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    harness.failManifestRenameOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    // F31 第十处：写通道替代把 manifest 落面；中断轮在保守块里等待恢复激
    // 活（V2 envelope 也在场），恢复轮直接从在位 manifest 激活。
    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    // 写通道已把 manifest 落面：重启即从在位 manifest 直接激活（与响应
    // 丢失形态一致），不再等待 hold 复升。
    // 与响应丢失形态一致：重启从在位 manifest 直接激活；hold 的收编由
    // 恢复轮执行后落空。
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
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
    const resumed = await restartedExecutor.run(
      "manual",
      {},
      true,
      restartedState.planReviewAuthorization!,
    );
    expect(resumed).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.activeV2MigrationHold).toBeNull();
    expect(restartedState.planReviewActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
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
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps V2 irreversible when the exact public-1.1.3 manifest response is lost", async () => {
    const harness = makeHarness(public113CleanFixtureInput());
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    harness.commitManifestThenThrowOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "migration-authority-commit-interrupted",
    });
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
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
      true,
      restartedState.planReviewAuthorization!,
    );
    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.activeV2MigrationHold).toBeNull();
    expect(restartedState.planReviewActive).toBe(false);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(true);
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
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
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
  });

  it("migrates a verified public-1.1.3 ancestor across a rebuildable manifest interruption", async () => {
    const content = "public ancestor\n";
    const bytes = new TextEncoder().encode(content);
    const hash = await sha256Hex(bytes);
    const local: LocalFileEntry = {
      path: "Notes/ancestor.md",
      size: bytes.byteLength,
      mtime: 1,
      hash,
      binary: false,
    };
    const base: BaseFileEntry = {
      path: local.path,
      hash,
      size: local.size,
      eTag: "etag-ancestor",
    };
    const harness = makeHarness({
      base: [base],
      local: [local],
      initialFiles: {
        [paths.baseContentFile]: JSON.stringify({
          [local.path]: content,
        }),
      },
      remoteItems: [
        {
          id: "folder-notes",
          name: "Notes",
          folder: { childCount: 1 },
          parentReference: { id: scope.filesRootId },
          eTag: "etag-folder-notes",
        },
        {
          id: "file-ancestor",
          name: "ancestor.md",
          size: local.size,
          file: { hashes: { sha256Hash: hash } },
          parentReference: { id: "folder-notes" },
          lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
          eTag: base.eTag,
          cTag: "ctag-ancestor",
        },
      ],
    });
    await harness.state.load();
    const mismatchedSource =
      await harness.state.readPublic113MigrationInput();
    (mismatchedSource.baseContentEntries as Record<string, string>)[
      local.path
    ] = "not the committed base";
    mismatchedSource.baseContentRaw = JSON.stringify(
      mismatchedSource.baseContentEntries,
    );
    await expect(
      harness.state.preparePublic113MigrationAncestors(mismatchedSource),
    ).resolves.toMatchObject({
      hashesByPath: {},
      sourceEntries: 1,
      published: 0,
      rejected: 1,
      unavailable: 0,
    });

    harness.failAncestorManifestRenameOnce();
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    const result = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(result).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    const committed = JSON.parse(
      harness.files.get(paths.stateV2File)!,
    ) as SyncStateEnvelopeV2;
    expect(Object.values(committed.anchors.byAnchorId)).toEqual([
      expect.objectContaining({
        lastPath: local.path,
        contentHash: hash,
        ancestorHash: hash,
      }),
    ]);
    expect(
      harness.files.get(`${paths.ancestorsV2Dir}/${hash}.txt`),
    ).toBe(content);
    await expect(harness.state.getBaseContent(local.path))
      .resolves.toBe(content);
    const backup = JSON.parse(
      harness.files.get(paths.stateV1BackupFile)!,
    ) as { snapshot: { baseContentEntries: Record<string, string> } };
    expect(backup.snapshot.baseContentEntries).toEqual({
      [local.path]: content,
    });
    expectNoFileMutations(harness.mutations);
  });

  it("routes an ordinary V1 run into the durable V2 migration transaction by default", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    const public113PluginData = structuredClone(harness.pluginData);
    harness.rawAdapter.write.mockClear();
    vi.mocked(harness.plugin.updatePluginData).mockClear();

    const preview = await harness.executor.run(
      "manual",
      { onConfirmThreshold: vi.fn().mockResolvedValue(false) },
    );

    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      items: [expect.objectContaining({
        type: SyncActionType.CreateRemoteFolder,
        path: "Empty",
      })],
    });
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
    expect(harness.files.has(paths.remoteStateFile)).toBe(false);
    expect(harness.pluginData).toEqual(public113PluginData);
    expect(harness.plugin.updatePluginData).not.toHaveBeenCalled();
    expect(
      harness.rawAdapter.write.mock.calls.map(([path]) => path),
    ).toEqual([
      paths.stateV2MigrationHoldNextFile,
    ]);

    const authorization = harness.state.planReviewAuthorization;
    expect(authorization?.reviewKind).toBe("v2-migration");
    const unconfirmed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
    );
    expect(unconfirmed).toMatchObject({
      success: false,
      errors: 0,
      message: "result.pausedForReview",
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold?.phase).toBe("pending");
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    const executed = await harness.executor.run(
      "manual",
      {},
      true,
      authorization!,
      { acknowledgeMigrationRisk: true },
    );
    expect(executed).toMatchObject({
      success: true,
      foldersCreated: 1,
      errors: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.client.createSharedSyncProtocolV2).toHaveBeenCalledOnce();
    expect(harness.client.readSharedSyncProtocolV2ById)
      .toHaveBeenCalledWith("protocol-id");
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      protocolBinding: {
        schemaVersion: 1,
        protocolVersion: 3,
        migrationGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
        recordId: "protocol-v3-id",
        recordETag: "protocol-v3-etag",
      },
    });
    expect(findRemoteItemByPath(harness.remoteItemState, "Empty")?.folder)
      .toBeTruthy();
  });

  it("routes an automatic V1 run into the same migration hold without mutating files", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Auto-only" }],
    });
    await harness.state.load();

    const result = await harness.executor.run("auto");

    expect(result).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      items: [expect.objectContaining({
        type: SyncActionType.CreateRemoteFolder,
        path: "Auto-only",
      })],
    });
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("requires this device's confirmation even when another device already created the shared generation", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Second-device" }],
    });
    harness.seedSharedProtocol();
    await harness.state.load();
    await harness.executor.run("manual");

    const result = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
    );

    expect(result).toMatchObject({
      success: false,
      errors: 0,
      message: "result.pausedForReview",
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.activeV2MigrationHold?.phase).toBe("pending");
    expect(harness.client.readSharedSyncProtocolV2).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("recovers the shared protocol binding when the manifest commits before the witness", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Empty" }],
    });
    await harness.state.load();
    await harness.executor.run("manual");
    const authorization = harness.state.planReviewAuthorization!;
    harness.failAuthorityWitnessWriteOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
      { acknowledgeMigrationRisk: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      message: "result.syncFailed",
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expect(harness.files.has(paths.stateV2AuthorityWitnessFile)).toBe(false);
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "confirmed",
      protocolBinding: {
        protocolVersion: 3,
        migrationGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
        recordId: "protocol-v3-id",
      },
    });

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();

    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      protocolBinding: {
        protocolVersion: 3,
        migrationGeneration:
          harness.state.activeV2MigrationHold!.protocolBinding!
            .migrationGeneration,
        recordId: "protocol-v3-id",
        recordETag: "protocol-v3-etag",
      },
    });
  });

  it("builds a canonical V2 preview for V1 without staging or committing migration state", async () => {
    const harness = makeHarness({
      localFolders: [{ path: "Notes" }, { path: "Preview-only" }],
    });
    await harness.state.load();
    const onFirstSyncPreview = vi.fn().mockResolvedValue(false);
    const public113PluginData = structuredClone(harness.pluginData);
    harness.rawAdapter.write.mockClear();
    vi.mocked(harness.plugin.updatePluginData).mockClear();

    const result = await harness.executor.run(
      "first",
      { onFirstSyncPreview },
      false,
      undefined,
      { readOnlyPreview: true },
    );

    expect(result.message).toBe("result.pausedForReview");
    expect(onFirstSyncPreview).toHaveBeenCalledWith(expect.objectContaining({
      canonicalIdentity: expect.any(Object),
      items: [expect.objectContaining({
        type: SyncActionType.CreateRemoteFolder,
        path: "Preview-only",
      })],
    }));
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.files.has(paths.stateV2File)).toBe(false);
    expect(harness.files.has(paths.remoteStateFile)).toBe(false);
    expect(harness.pluginData).toEqual(public113PluginData);
    expect(harness.plugin.updatePluginData).not.toHaveBeenCalled();
    expect(harness.rawAdapter.write).not.toHaveBeenCalled();
    expect(harness.client.createFolderByParentId).not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a corrupt public-1.1.3 mutation ledger before Graph preparation", async () => {
    const harness = makeHarness({
      pluginData: {
        "easy-sync-mutation-ledger": [{ unsupported: true }],
      },
    });
    await harness.state.load();

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      message: "result.legacyRecoveryNeedsMigration",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.client.initVaultScope).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect(harness.state.hasMutationLedgerCorruption).toBe(true);
    expect(harness.state.isV2StateActive).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("keeps a mixed valid-and-corrupt public ledger intact and rejects the whole array before Graph", async () => {
    const { fixtureInput, releaseCompatibleLedger } =
      public113ReceiptedEmptyAccountFixtureInput();
    const mixedLedger = [
      ...structuredClone(releaseCompatibleLedger),
      {
        unsupportedReleaseEntry: true,
        releaseFutureEntryField: { mustSurvive: true },
      },
    ];
    fixtureInput.pluginData!["easy-sync-mutation-ledger"] = mixedLedger;
    const harness = makeHarness(fixtureInput);
    await harness.state.load();

    expect(harness.state.hasMutationLedgerCorruption).toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    const source = await harness.state.readPublic113MigrationInput();
    expect(source.pluginData["easy-sync-mutation-ledger"])
      .toEqual(mixedLedger);
    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      message: "result.legacyRecoveryNeedsMigration",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.pluginData["easy-sync-mutation-ledger"])
      .toEqual(mixedLedger);
    expect(harness.client.initVaultScope).not.toHaveBeenCalled();
    expect(harness.getDelta).not.toHaveBeenCalled();
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

  it("cuts the exact public-1.1.3 ledger into V2, downloads once, and cold-starts stable", async () => {
    const normalized = public113NormalizedFixture();
    const legacyRecord = structuredClone(
      (normalized.pluginData["easy-sync-mutation-ledger"] as Array<{
        intent: MutationIntentV1;
        receipt: null;
      }>)[0],
    );
    const legacyIntent = legacyRecord.intent;
    const remoteState = normalized.sidecars[legacyPaths.remoteStateFile] as {
      entries: Record<string, {
        path: string;
        driveId: string;
        parentId: string;
        size: number;
        mtime: number;
        eTag: string;
        cTag: string;
        sha256Hash?: string;
      }>;
      folders: Record<string, {
        path: string;
        driveId: string;
        parentId: string;
        name: string;
      }>;
    };
    const recoverEntry = remoteState.entries[legacyIntent.path];
    const notesFolder = Object.values(remoteState.folders)[0];
    const recoverRemote: DriveItem = {
      id: recoverEntry.driveId,
      name: "recover.md",
      size: recoverEntry.size,
      file: {
        hashes: {
          ...(recoverEntry.sha256Hash
            ? { sha256Hash: recoverEntry.sha256Hash }
            : {}),
        },
      },
      parentReference: { id: recoverEntry.parentId },
      lastModifiedDateTime:
        new Date(recoverEntry.mtime).toISOString(),
      eTag: recoverEntry.eTag,
      cTag: recoverEntry.cTag,
    };
    const recoverContent = "fixture recover file\n";
    expect(new TextEncoder().encode(recoverContent).byteLength)
      .toBe(recoverEntry.size);
    const harness = makeHarness({
      base: [],
      local: [],
      localFolders: [{ path: notesFolder.path }],
      remoteItems: [
        {
          id: notesFolder.driveId,
          name: notesFolder.name,
          folder: { childCount: 1 },
          parentReference: { id: notesFolder.parentId },
          eTag: "etag-folder-notes-113",
        },
        recoverRemote,
      ],
      remoteFileContents: {
        [legacyIntent.path]: recoverContent,
      },
      pluginData: {
        "easy-sync-generation":
          normalized.pluginData["easy-sync-generation"],
        "easy-sync-mutation-ledger": [legacyRecord],
        "release-1.1.3-unknown-key":
          normalized.pluginData["release-1.1.3-unknown-key"],
      },
    });
    await harness.state.load();

    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    const result = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(result).toMatchObject({
      success: true,
      errors: 0,
      continueAfterStateOnlyMigrationRecovery: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toMatchObject({
      importedLegacyMutationRecords: 1,
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);

    const recovered = await harness.executor.run("manual");
    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: legacyIntent.path,
        eTag: recoverEntry.eTag,
      }),
    ]);

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
    expect(restartedState.mutationLedger).toEqual([]);
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
  });

  it("cuts over an anchored public download after remote-state advanced and the receipt write stopped", async () => {
    const {
      fixtureInput,
      ledger,
      base,
      currentHash,
      currentETag,
    } = await public113InterruptedAnchoredDownloadFixtureInput();
    const harness = makeHarness(fixtureInput);
    await harness.state.load();

    const preview = await harness.executor.run("manual");

    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.mutationLedger).toEqual(ledger);
    expect(harness.state.activeV2MigrationHold).toMatchObject({
      phase: "pending",
      items: [],
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledOnce();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }

    const confirmation = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(confirmation).toMatchObject({
      success: true,
      errors: 0,
      continueAfterStateOnlyMigrationRecovery: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.localEntryState).toContainEqual(expect.objectContaining({
      path: base.path,
      hash: currentHash,
    }));
    expect(harness.state.baseSnapshot).toEqual([
      expect.objectContaining({
        path: base.path,
        hash: currentHash,
        eTag: currentETag,
      }),
    ]);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
    const verificationDownloads =
      harness.mutations.downloadFile.mock.calls.length;

    const stable = await harness.executor.run("manual");
    expect(stable).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(
      verificationDownloads,
    );

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
    const coldStable = await restartedExecutor.run("manual");
    expect(coldStable).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.mutationLedger).toEqual([]);
    expect(harness.mutations.downloadFile).toHaveBeenCalledTimes(
      verificationDownloads,
    );
  });

  it("abandons a proven not-applied public-1.1.3 intent with an empty account without rewriting its durable evidence", async () => {
    const { fixtureInput, releaseCompatibleLedger } =
      public113ReceiptedEmptyAccountFixtureInput();
    const rawRecord = structuredClone(
      releaseCompatibleLedger[0],
    ) as unknown as MutationLedgerEntryV1;
    rawRecord.receipt = null;
    fixtureInput.pluginData!["easy-sync-mutation-ledger"] = [rawRecord];
    const harness = makeHarness(fixtureInput);
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview.message).toBe("result.pausedForReview");
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) harness.localFolderPaths.delete(folder);
    }

    const confirmation = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(confirmation).toMatchObject({
      success: true,
      errors: 0,
      continueAfterStateOnlyMigrationRecovery: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toMatchObject({
      importedLegacyMutationRecords: 1,
    });
    const backup = JSON.parse(
      harness.files.get(paths.stateV1BackupFile)!,
    ) as { snapshot: { pluginData: Record<string, unknown> } };
    expect(backup.snapshot.pluginData["easy-sync-mutation-ledger"])
      .toEqual([rawRecord]);
    expectNoFileMutations(harness.mutations);
  });

  it("records and checkpoints an applied public-1.1.3 intent with an empty account while preserving the cutover source", async () => {
    const {
      fixtureInput,
      ledger,
      base,
      currentHash,
      currentETag,
    } = await public113InterruptedAnchoredDownloadFixtureInput();
    ledger[0].intent.scope.accountId = "";
    fixtureInput.pluginData!["easy-sync-mutation-ledger"] = ledger;
    const rawLedger = structuredClone(ledger);
    const harness = makeHarness(fixtureInput);
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview.message).toBe("result.pausedForReview");
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) harness.localFolderPaths.delete(folder);
    }

    const confirmation = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(confirmation).toMatchObject({
      success: true,
      errors: 0,
      continueAfterStateOnlyMigrationRecovery: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.state.baseSnapshot).toContainEqual(expect.objectContaining({
      path: base.path,
      hash: currentHash,
      eTag: currentETag,
    }));
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toMatchObject({
      importedLegacyMutationRecords: 1,
    });
    const backup = JSON.parse(
      harness.files.get(paths.stateV1BackupFile)!,
    ) as { snapshot: { pluginData: Record<string, unknown> } };
    expect(backup.snapshot.pluginData["easy-sync-mutation-ledger"])
      .toEqual(rawLedger);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
    expect(harness.mutations.downloadFileToPath).not.toHaveBeenCalled();
  });

  it("keeps an anchored public download in V1 when the remote version changed after its intent", async () => {
    const { fixtureInput, ledger, base } =
      await public113InterruptedAnchoredDownloadFixtureInput();
    const remoteFile = fixtureInput.remoteItems!.find((item) => item.file)!;
    remoteFile.eTag = "etag-after-public-download-intent";
    const harness = makeHarness(fixtureInput);
    await harness.state.load();

    const result = await harness.executor.run("manual");

    expect(result).toMatchObject({
      success: false,
      deferred: 0,
      message: "result.syncStateNotReady",
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    // F23: the field report must be able to name the base entries whose remote
    // identity cannot be proven, not just count them.
    const rejection = harness.diag.warn.mock.calls.find(
      ([category, message]) =>
        category === "state"
        && message === "V2 migration candidate rejected before authority change",
    );
    expect(rejection?.[2]).toMatchObject({
      reason: "anchor-incomplete",
      pending: 1,
      pendingPaths: [{
        path: base.path,
        reason: "identity-not-unique-or-unverified",
      }],
      pendingTruncated: 0,
    });
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.mutationLedger).toEqual(ledger);
    expect(harness.state.activeV2MigrationHold).toBeNull();
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(false);
    expect(harness.mutations.downloadFile).not.toHaveBeenCalled();
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.mutations.deleteItem).not.toHaveBeenCalled();
    expect(harness.mutations.renameItem).not.toHaveBeenCalled();
  });

  it("replays a receipted public-1.1.3 checkpoint with an empty account id without losing its raw evidence", async () => {
    const { fixtureInput, releaseCompatibleLedger } =
      public113ReceiptedEmptyAccountFixtureInput();
    const harness = makeHarness(fixtureInput);
    await harness.state.load();

    expect(harness.state.hasMutationLedgerCorruption).toBe(false);
    expect(harness.state.mutationLedger).toEqual(releaseCompatibleLedger);
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }

    const result = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(result).toMatchObject({
      success: true,
      errors: 0,
      continueAfterStateOnlyMigrationRecovery: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([]);
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toMatchObject({
      importedLegacyMutationRecords: 1,
    });
    const backup = JSON.parse(
      harness.files.get(paths.stateV1BackupFile)!,
    ) as {
      snapshot: {
        pluginData: Record<string, unknown>;
      };
    };
    expect(backup.snapshot.pluginData["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
    const mismatchedAccountRecord = structuredClone(
      releaseCompatibleLedger[0],
    ) as unknown as MutationLedgerEntryV1;
    mismatchedAccountRecord.intent.scope.accountId = "another-account";
    expect(harness.state.prepareMutationRecoveryRecord(
      mismatchedAccountRecord,
      scope,
    )).toBeNull();
    expectNoFileMutations(harness.mutations);

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
    expect(restartedState.mutationLedger).toEqual([]);
    expectNoFileMutations(harness.mutations);
  });

  it("preserves a public receipt byte-for-byte when a pre-manifest failure is cancelled", async () => {
    const { fixtureInput, releaseCompatibleLedger } =
      public113ReceiptedEmptyAccountFixtureInput();
    const originalRemoteState =
      fixtureInput.initialFiles![paths.remoteStateFile];
    const originalBaseContent =
      fixtureInput.initialFiles![paths.baseContentFile];
    const originalScanCache =
      fixtureInput.initialFiles![paths.scanCacheFile];
    const harness = makeHarness(fixtureInput);
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    const authorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    harness.failManifestRenameOnce();

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      authorization,
      { acknowledgeMigrationRisk: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      errors: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    // F31 第十处：真拒绝也被写通道把 manifest 落面——中断后 V2 落门、
    // 内存在保守块，取消被拒（唯一出口＝恢复激活；收据 schema 不动）。
    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.pluginData["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
    expect(harness.pluginData["easy-sync-v2-mutation-ledger"])
      .toBeUndefined();
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toBeUndefined();
    expect(harness.files.get(paths.remoteStateFile))
      .toBe(originalRemoteState);
    expect(harness.files.get(paths.baseContentFile))
      .toBe(originalBaseContent);
    expect(harness.files.get(paths.scanCacheFile))
      .toBe(originalScanCache);
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);

    await expect(harness.state.clearPlanReview(authorization))
      .resolves.toBe(false);
    const confirmedAuthorization = structuredClone(
      harness.state.planReviewAuthorization!,
    );
    expect(confirmedAuthorization).toMatchObject({
      reviewKind: "v2-migration",
      revision: authorization.revision + 1,
      canonicalIdentity: authorization.canonicalIdentity,
    });
    await expect(harness.state.clearPlanReview(confirmedAuthorization))
      .resolves.toBe(false);
    expect(harness.state.activeV2MigrationHold?.phase).toBe("confirmed");
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.pluginData["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
    expect(harness.files.get(paths.remoteStateFile))
      .toBe(originalRemoteState);
    expect(harness.files.get(paths.baseContentFile))
      .toBe(originalBaseContent);
    expect(harness.files.get(paths.scanCacheFile))
      .toBe(originalScanCache);
    // continues from the landed manifest: the committed envelope and the
    // retained V1 backup are part of the interruption state.
    expect(harness.files.has(paths.stateV2File)).toBe(true);
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);

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
    // 恢复轮在在位 manifest 下直接激活 V2；随后的常规同步一轮零迁移。
    const represented = await restartedExecutor.run("manual");
    expect(represented).toMatchObject({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    // 恢复激活已收编并清空旧账本；收据是以指尖拷贝保留在 V1 备份里的。
    expect(harness.pluginData["easy-sync-mutation-ledger"])
      .toEqual([]);
    expect(harness.client.createSharedSyncProtocolV2)
      .toHaveBeenCalledOnce();
    expectNoFileMutations(harness.mutations);
  });

  it("recovers a public receipt after the PluginData cutover write never starts", async () => {
    const { fixtureInput, releaseCompatibleLedger } =
      public113ReceiptedEmptyAccountFixtureInput();
    const harness = makeHarness(fixtureInput);
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    vi.mocked(harness.plugin.updatePluginData)
      .mockRejectedValueOnce(new Error("cutover write did not start"));

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      errors: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "public-1.1.3-cutover-finalization-failed",
    });
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toBeUndefined();
    expect(harness.pluginData["easy-sync-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
    expect(Object.keys(
      harness.pluginData["easy-sync-base-snapshot"] as Record<string, unknown>,
    )).not.toHaveLength(0);
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toMatchObject({
      importedLegacyMutationRecords: 1,
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
    const recovered = await restartedExecutor.run(
      "manual",
      {},
      true,
      restartedState.planReviewAuthorization!,
    );
    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(restartedState.mutationLedger).toEqual([]);
    expect(restartedState.activeV2MigrationHold).toBeNull();
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

  it("recovers a public receipt when the PluginData cutover response is lost after the write", async () => {
    const { fixtureInput, releaseCompatibleLedger } =
      public113ReceiptedEmptyAccountFixtureInput();
    const harness = makeHarness(fixtureInput);
    await harness.state.load();
    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    vi.mocked(harness.plugin.updatePluginData).mockImplementationOnce(
      async (mutator) => {
        mutator(harness.pluginData);
        throw new Error("cutover response lost after durable write");
      },
    );

    const interrupted = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(interrupted).toMatchObject({
      success: false,
      errors: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.v2StateLoadRecoveryBlock).toMatchObject({
      authority: "v2",
      reason: "public-1.1.3-cutover-finalization-failed",
    });
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toMatchObject({
      importedLegacyMutationRecords: 1,
    });
    expect(harness.pluginData["easy-sync-mutation-ledger"]).toEqual([]);
    expect(harness.pluginData["easy-sync-v2-mutation-ledger"])
      .toEqual(releaseCompatibleLedger);
    expect(harness.pluginData["easy-sync-base-snapshot"]).toEqual({});
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    expect(restartedState.isV2StateActive).toBe(true);
    expect(restartedState.legacyAutoSyncAllowed).toBe(false);
    expect(restartedState.v2StateLoadRecoveryBlock).toBeNull();
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
      true,
      restartedState.planReviewAuthorization!,
    );
    expect(recovered).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(restartedState.mutationLedger).toEqual([]);
    expect(restartedState.activeV2MigrationHold).toBeNull();
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

  it("keeps an ambiguous imported public-1.1.3 ledger under V2 authority", async () => {
    const unexpectedRemote: DriveItem = {
      id: "file-unexpected",
      name: "pending.md",
      size: 10,
      file: { hashes: { sha256Hash: hashB } },
      parentReference: { id: "folder-notes" },
      lastModifiedDateTime: "2026-07-25T00:00:00.000Z",
      eTag: "etag-unexpected",
      cTag: "ctag-unexpected",
    };
    const legacyIntent: MutationIntentV1 = {
      version: 1,
      operationId: "public-1.1.3-ambiguous-upload",
      planRevision: 1,
      scope,
      action: "upload",
      path: "Notes/pending.md",
      expectedLocal: { exists: true, hash: hashA, size: 10 },
      expectedRemote: { exists: false },
      createdAt: 1,
    };
    const harness = makeHarness({
      remoteItems: [...remoteItems(), unexpectedRemote],
      pluginData: {
        "easy-sync-mutation-ledger": [{
          intent: legacyIntent,
          receipt: null,
        }],
      },
    });
    await harness.state.load();

    const preview = await harness.executor.run("manual");
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    const result = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(result).toMatchObject({
      success: false,
      errors: 1,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(result.message).not.toBe("result.legacyRecoveryNeedsMigration");
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.legacyAutoSyncAllowed).toBe(false);
    expect(harness.state.mutationLedger).toEqual([
      expect.objectContaining({
        intent: expect.objectContaining({
          operationId: legacyIntent.operationId,
        }),
        receipt: null,
      }),
    ]);
    expect(harness.pluginData[KEY_PUBLIC_113_CUTOVER]).toMatchObject({
      importedLegacyMutationRecords: 1,
    });
    expect(harness.files.has(paths.stateV2ManifestFile)).toBe(true);
    expectNoFileMutations(harness.mutations);
  });

  it("retires the exact public-1.1.3 pending and review state without reusing its authorization", async () => {
    const source = public113NormalizedFixture().pluginData;
    const harness = makeHarness(public113StalePendingFixtureInput());
    await harness.state.load();
    expect(harness.state.pendingConflicts).toHaveLength(1);
    expect(harness.state.pendingRemoteDeletes).toHaveLength(1);
    expect(harness.state.pendingIssues).toHaveLength(1);
    const staleAuthorization = harness.state.planReviewAuthorization;
    expect(staleAuthorization).toEqual({
      revision: 12,
      scope,
    });

    const preview = await harness.executor.run(
      "manual",
      {},
      true,
      staleAuthorization!,
    );
    expect(preview).toMatchObject({
      success: false,
      message: "result.pausedForReview",
    });
    expect(harness.state.planReviewAuthorization).toMatchObject({
      revision: expect.any(Number),
      scope,
      reviewKind: "v2-migration",
      canonicalIdentity: expect.any(Object),
    });
    expect(harness.state.planReviewAuthorization)
      .not.toEqual(staleAuthorization);
    expect(harness.state.isV2StateActive).toBe(false);
    expect(harness.client.createSharedSyncProtocolV2)
      .not.toHaveBeenCalled();
    expectNoFileMutations(harness.mutations);

    for (const folder of [...harness.localFolderPaths]) {
      if (folder.startsWith(".obsidian")) {
        harness.localFolderPaths.delete(folder);
      }
    }
    const result = await harness.executor.run(
      "manual",
      {},
      true,
      harness.state.planReviewAuthorization!,
      { acknowledgeMigrationRisk: true },
    );

    expect(result).toMatchObject({
      success: true,
      errors: 0,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
    });
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.planReviewActive).toBe(false);
    expect(harness.state.pendingConflicts).toEqual([]);
    expect(harness.state.pendingRemoteDeletes).toEqual([]);
    expect(harness.state.pendingIssues).toEqual([]);
    const backup = JSON.parse(harness.files.get(paths.stateV1BackupFile)!);
    expect(backup.snapshot.pluginData).toEqual(expect.objectContaining({
      "easy-sync-pending-conflicts":
        source["easy-sync-pending-conflicts"],
      "easy-sync-pending-remote-deletes":
        source["easy-sync-pending-remote-deletes"],
      "easy-sync-pending-issues":
        source["easy-sync-pending-issues"],
      "easy-sync-plan-review-active": true,
      "easy-sync-plan-review-items":
        source["easy-sync-plan-review-items"],
    }));
    expect(backup.snapshot).toMatchObject({
      kind: "public-1.1.3-backup",
      sourceVersion: "1.1.3",
      sourceStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(harness.pluginData).toEqual(expect.objectContaining({
      "sync-interval": 3,
      "easy-sync-profile-cache": {
        displayName: "Release Fixture",
        accountId: scope.accountId,
      },
      "release-1.1.3-unknown-key": { mustSurvive: true },
      [KEY_PUBLIC_113_CUTOVER]: expect.objectContaining({
        kind: "public-1.1.3-cutover",
        importedLegacyMutationRecords: 0,
        retired: {
          reviewActive: true,
          conflicts: 1,
          remoteDeletes: 1,
          issues: 1,
          localFolderMoveHints: 0,
        },
      }),
    }));
    expectNoFileMutations(harness.mutations);
  });

  it("excludes structured community plugin state from V2 file anchors", async () => {
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
    const staleCommunityPluginBase: BaseFileEntry = {
      path: communityPluginPath,
      size: contentBytes.byteLength,
      hash: hashB,
      eTag: "etag-community-plugins-old",
    };
    const harness = makeHarness({
      base: [baseA, staleCommunityPluginBase],
      local: [localA, localCommunityPluginState],
      localFolders: [{ path: "Notes" }, { path: ".obsidian" }],
      remoteItems: remoteItemsWithCommunityPluginState(
        contentHash,
        contentBytes.byteLength,
      ),
      initialFiles: { [communityPluginPath]: communityPluginContent },
      remoteFileContents: { [communityPluginPath]: communityPluginContent },
    });
    harness.executor.setCommunityPluginSyncPolicy({
      version: 1,
      files: { mode: "selected", pluginIds: ["calendar"] },
      data: { mode: "none", pluginIds: [] },
    });
    await harness.state.load();

    const result = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(result.success).toBe(true);
    expect(harness.state.isV2StateActive).toBe(true);
    expect(harness.state.baseSnapshot.map((entry) => entry.path)).toEqual([
      localA.path,
    ]);
    expect(harness.mutations.uploadFile).not.toHaveBeenCalled();
    expect(harness.rawAdapter.writeBinary).not.toHaveBeenCalled();
    expect(harness.hostWrites).toEqual([]);
  });

  it("cuts authority only on a zero plan and the next V2 round stays zero", async () => {
    const harness = makeHarness();
    await harness.state.load();

    const first = await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );

    expect(first).toEqual(expect.objectContaining({
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
    expect(JSON.parse(
      harness.files.get(paths.stateV2AuthorityWitnessFile)!,
    )).toMatchObject({
      schemaVersion: 1,
      status: "active",
      manifest: expect.objectContaining({
        scope,
        legacyAutoSyncAllowed: false,
      }),
    });
    expect(harness.files.has(paths.stateV1BackupFile)).toBe(true);
    expectNoFileMutations(harness.mutations);

    const restartedState = new StateManager(harness.plugin);
    await restartedState.load();
    const restartedExecutor = new SyncExecutor(
      harness.client,
      harness.scanner,
      restartedState,
      "testVault",
    );
    expect(restartedState.isV2StateActive).toBe(true);

    const second = await restartedExecutor.run("manual");

    expect(second).toEqual(expect.objectContaining({
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
    }));
    expect(restartedState.isV2StateActive).toBe(true);
    // Production activation is a reviewed two-round transaction, followed by
    // the explicit cold-start verification round.
    expect(harness.getDelta).toHaveBeenCalledTimes(3);
    expectNoFileMutations(harness.mutations);
  });

  it("plans an ordinary local edit against a rebuilt same-path remote ID instead of reporting a move", async () => {
    const harness = makeHarness();
    await harness.state.load();
    await harness.executor.run(
      "manual",
      {},
      false,
      undefined,
      { activateV2State: true },
    );
    expect(harness.state.isV2StateActive).toBe(true);

    harness.localEntryState[0]!.hash = hashB;
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

    let reviewedPlan: SyncPlan | undefined;
    const planned = await harness.executor.run("manual", {
      onConfirmThreshold: async (plan) => {
        reviewedPlan = plan;
        return false;
      },
    });

    expect(planned).toMatchObject({
      success: false,
      message: "result.pausedForReview",
      errors: 0,
    });
    expect(reviewedPlan?.items).toEqual([
      expect.objectContaining({
        type: SyncActionType.Upload,
        path: localA.path,
        remote: expect.objectContaining({
          eTag: "etag-a-rebuilt",
        }),
      }),
    ]);
    expect(
      reviewedPlan?.items.some(
        (item) => item.type === SyncActionType.FolderDeferred,
      ),
    ).toBe(false);
    expectNoFileMutations(harness.mutations);
  });

});
